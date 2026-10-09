// `bun run mod <command>`: tools for people (and agents) who write OMORI mods.
//   dump [dir]            decrypt the whole game into plain json/yml/js (default ./dump) so it can be read and grepped
//   check [path...]       validate mods (default ./mods and ./examples) and dry-run every edit against the real game files
//   new <id> [dir]        scaffold a mod
//   pack <modDir> [out]   zip a mod folder for distribution
//   find <text>           search the dumped game for text (names, dialogue, switches) and print file + line
//   map new|build|show  author new maps + events from a small spec (see docs/MODDING.md)
//   routes [out.md|--json]  report on the story's flags: spine, phases, endings, route counters, priority-ladder events
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { GAME_DIR, ROOT, WWW, ensureGameDir, readGameKey } from './gamedir.ts';
import { ModEngine, assetKeyFromSystem } from './mods/engine.ts';
import { formatOfGamePath, plainName } from './mods/manifest.ts';
import { discoverMods, dirTree } from './mods/vfs-node.ts';
import { treeToZip } from './mods/vfs.ts';
import { mapCommand, loadSpecs, gameSource, routesCommand } from './mods/mapkit-node.ts';
import { buildMaps } from './mods/mapkit.ts';

const [cmd, ...args] = process.argv.slice(2);
if (['dump', 'check', 'routes'].includes(cmd ?? '') || (cmd === 'map' && ['build', 'show'].includes(args[0] ?? ''))) { if (!ensureGameDir()) process.exit(1); }
const dec = new TextDecoder();

function walk(dir: string, rel = ''): string[] {
    const out: string[] = [];
    for (const e of readdirSync(join(dir, rel), { withFileTypes: true })) {
        const r = rel ? `${rel}/${e.name}` : e.name;
        e.isDirectory() ? out.push(...walk(dir, r)) : out.push(r);
    }
    return out;
}

function newEngine(print = true) {
    return new ModEngine(readGameKey, d => {
        if (print || d.level !== 'info') console.log(`${d.level === 'error' ? '✗' : d.level === 'warn' ? '!' : '·'} ${d.mod ? `[${d.mod}] ` : ''}${d.file ? d.file + ': ' : ''}${d.message}`);
    });
}

function dump(out = join(ROOT, 'dump')) {
    const e = newEngine();
    if (!readGameKey()) process.exit(1);
    let n = 0;
    for (const f of walk(WWW)) {
        const t = formatOfGamePath(f);
        // Only game data and code are useful as text; skip media and the big libraries.
        if (!t.encrypted && !/^js\/(rpg_\w+|main|plugins)\.js$/.test(f)) continue;
        const dst = join(out, plainName(f));
        mkdirSync(dirname(dst), { recursive: true });
        const bytes = new Uint8Array(readFileSync(join(WWW, f)));
        try { writeFileSync(dst, t.encrypted ? e.decrypt(bytes) : bytes); n++; }
        catch (err) { console.error(`✗ ${f}: ${(err as Error).message}`); }
    }
    console.log(`dumped ${n} files to ${out}\nMap data: ${join(out, 'data')}  Dialogue: ${join(out, 'languages/en')}  Plugins: ${join(out, 'js/plugins')}`);
}

function check(paths: string[]) {
    const e = newEngine(false);
    // Image/audio replacements are re-encrypted with the game's asset key; without it the dry run would crash on any mod that ships a picture.
    try { e.assetKey = assetKeyFromSystem(JSON.parse(dec.decode(e.decrypt(new Uint8Array(readFileSync(join(WWW, 'data/System.KEL'))))))); } catch { /* reported when an asset needs it */ }
    const dirs = paths.length ? paths.map(modPath) : [join(ROOT, 'mods'), join(ROOT, 'examples')].filter(existsSync);
    const sources = dirs.flatMap(d => {
        if (existsSync(join(d, 'mod.json'))) return [{ label: d.split(/[\\/]/).pop()!, tree: dirTree(d), origin: d }];
        return discoverMods(d, (n, err) => console.error(`✗ ${n}: ${err.message}`)).map(m => ({ label: m.label, tree: m.tree, origin: m.path }));
    });
    if (!sources.length) { console.log('no mods found'); return; }
    let specBad = 0;
    for (const sc of sources) if (sc.origin && existsSync(join(sc.origin, 'maps')) && loadSpecs(sc.origin).length) {
        const before = specBad;
        // Dry run of the map compiler: errors fail the check, but nothing is written (use `map build` for that).
        const id = JSON.parse(readFileSync(join(sc.origin, 'mod.json'), 'utf8')).id as string;
        const built = buildMaps(id, loadSpecs(sc.origin).map(x => x.spec), gameSource(sc.origin));
        for (const w of built.warnings) console.log(`! [${id}] ${w}`);
        for (const er of built.errors) { console.log(`✗ [${id}] ${er}`); specBad++; }
        if (specBad === before) console.log(`✓ ${id}: ${loadSpecs(sc.origin).length} map spec(s) compile`);
    }
    e.load(sources);

    // Dry run: resolve every edited file against the real game so patch errors show up now, not in the middle of a playthrough.
    let bad = specBad + e.diagnostics.filter(d => d.level === 'error').length;
    for (const m of e.activeMods()) {
        let failed = 0;
        for (const t of new Set(m.edits.map(x => x.target))) {
            const before = e.diagnostics.length;
            const real = existsSync(join(WWW, t)) ? new Uint8Array(readFileSync(join(WWW, t))) : null;
            e.resolve(t, () => real);
            if (e.diagnostics.slice(before).some(d => d.level === 'error')) failed++;
        }
        bad += failed;
        console.log(`${failed ? '✗' : '✓'} ${m.id}@${m.version} (${m.format}): ${m.edits.length} edit(s), ${m.scripts.length} script(s)${failed ? `, ${failed} file(s) failed` : ''}`);
    }
    for (const m of e.mods.filter(x => !x.enabled)) console.log(`✗ ${m.id}: disabled (${m.errors.join('; ') || 'dependency problem'})`);
    process.exit(bad ? 1 : 0);
}

function scaffold(id?: string, dir?: string) {
    if (!id || !/^[a-z0-9][a-z0-9._-]{1,63}$/.test(id)) { console.error('usage: bun run mod new <id>   (lowercase letters, digits, . _ -)'); process.exit(1); }
    const root = resolve(dir ?? join(ROOT, 'mods', id));
    if (existsSync(root)) { console.error(`${root} already exists`); process.exit(1); }
    const put = (p: string, c: string) => { mkdirSync(dirname(join(root, p)), { recursive: true }); writeFileSync(join(root, p), c); };
    put('mod.json', JSON.stringify({ id, name: id, version: '0.1.0', author: '', description: 'What this mod does.' }, null, 2) + '\n');
    put('scripts/main.js', `/// <reference path="../../../types/omori-mod.d.ts" />\n// Runs in the browser after the game's plugins load.\n// Everything is inside a function: all mods' scripts share one global scope, so a top-level const would clash with another mod's.\n(() => {\n  const mod = OmoriMod.scope();\n\n  mod.log('hello from ${id}');\n\n  // Example: react to a map loading.\n  mod.on('map:setup', mapId => mod.log('entered map', mapId));\n})();\n`);
    put('README.md', `# ${id}\n\nSee docs/MODDING.md. Run \`bun run mod check ${id}\` to validate, \`bun run mod pack ${id}\` to build a zip.\n`);
    console.log(`created ${root}\nNext: bun run start, press F8, make a profile and tick "Load every mod from the dev folder automatically"; open the game with ?hot=1 to reload on save.`);
}

/** A path as typed, or a mod name inside ./mods. */
const modPath = (p: string) => [resolve(p), join(ROOT, 'mods', p), join(ROOT, 'examples', p)].find(d => existsSync(join(d, 'mod.json'))) ?? join(ROOT, 'mods', p);

function pack(dir?: string, out?: string) {
    if (dir) dir = modPath(dir);
    if (!dir || !existsSync(join(resolve(dir), 'mod.json'))) { console.error('usage: bun run mod pack <modDir> [out.zip]  (modDir must contain mod.json)'); process.exit(1); }
    const root = resolve(dir), id = JSON.parse(readFileSync(join(root, 'mod.json'), 'utf8')).id ?? 'mod';
    const dst = resolve(out ?? join(root, '..', `${id}.zip`));
    writeFileSync(dst, treeToZip(dirTree(root)));
    console.log(`wrote ${dst} (${(statSync(dst).size / 1024).toFixed(0)} KB). Players can drag it onto the game.`);
}

function find(q?: string) {
    const d = join(ROOT, 'dump');
    if (!q) { console.error('usage: bun run mod find <text>'); process.exit(1); }
    if (!existsSync(d)) { console.error('run `bun run mod dump` first'); process.exit(1); }
    const needle = q.toLowerCase();
    let hits = 0;
    for (const f of walk(d)) {
        if (!/\.(json|yml|yaml|js)$/.test(f)) continue;
        const lines = dec.decode(readFileSync(join(d, f))).split('\n');
        for (let i = 0; i < lines.length && hits < 200; i++) {
            if (lines[i]!.toLowerCase().includes(needle)) { console.log(`${f}:${i + 1}: ${lines[i]!.trim().slice(0, 160)}`); hits++; }
        }
    }
    console.log(hits ? `${hits} match(es)${hits >= 200 ? ' (first 200)' : ''}` : 'no matches');
}

switch (cmd) {
    case 'dump': dump(args[0]); break;
    case 'check': check(args); break;
    case 'new': scaffold(args[0], args[1]); break;
    case 'pack': pack(args[0], args[1]); break;
    case 'find': find(args.join(' ')); break;
    case 'map': mapCommand(args); break;
    case 'routes': routesCommand(args); break;
    default:
        console.log(`OMORI mod tools (game: ${GAME_DIR})\n  dump [dir]           decrypt the game to readable files (default ./dump)\n  find <text>          search the dump\n  new <id>             scaffold a mod in ./mods/<id>\n  check [path...]      validate mods and dry-run their edits\n  pack <dir> [out]     zip a mod for sharing`);
}
