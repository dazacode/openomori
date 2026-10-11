// Bun side of omorikit.ts: the `mod say`, `mod macros`, `mod commands` and `mod lint` commands. Reads the decrypted dump
// (`mod dump`) and the player's install for face and sprite files; mod folders are read where they sit.
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { ROOT, WWW, readGameKey } from '../gamedir.ts';
import { ModEngine, assetKeyFromSystem } from './engine.ts';
import { EVENT_NAMES, lintDialogue, lintSpriteName, parseDialogue, parseMacros, pluginCodes, showMessageRefs, usageOf, type Finding, type Macros } from './omorikit.ts';

const DUMP = join(ROOT, 'dump');
const dec = new TextDecoder();

const needDump = (): boolean => {
    if (existsSync(join(DUMP, 'languages', 'en'))) return true;
    console.error('run `bun run mod dump` first (it writes ./dump, git-ignored)');
    return false;
};

/** Dumped dialogue: file name (without .yml) -> message key -> entry. Parsed once per run. */
function dumpDialogue(): Map<string, Record<string, any>> {
    const out = new Map<string, Record<string, any>>();
    const dir = join(DUMP, 'languages', 'en');
    if (!existsSync(dir)) return out;
    for (const f of readdirSync(dir).filter(x => x.endsWith('.yml'))) {
        const { doc } = parseDialogue(dec.decode(readFileSync(join(dir, f))), f);
        if (doc) out.set(f.replace(/\.yml$/, ''), doc);
    }
    return out;
}

const dumpMacros = (): Macros => {
    const p = join(DUMP, 'js', 'plugins.js');
    return existsSync(p) ? parseMacros(dec.decode(readFileSync(p))) : new Map();
};

/** Face names: the game's faces are encrypted (.rpgmvp) under www/img/faces; mods may add plain .png under files/img/faces. */
function faceChecker(modDir?: string): (name: string) => boolean {
    const names = new Set<string>();
    const add = (dir: string) => { if (existsSync(dir)) for (const f of readdirSync(dir)) names.add(f.replace(/\.(png|rpgmvp)$/i, '').toLowerCase()); };
    add(join(WWW, 'img', 'faces'));
    if (modDir) add(join(modDir, 'files', 'img', 'faces'));
    return name => names.has(name.toLowerCase());
}

/** Width and height from a PNG header, or null. */
export function pngSize(path: string): { width: number; height: number } | null {
    const b = readFileSync(path);
    if (b.length < 24 || b.readUInt32BE(0) !== 0x89504e47) return null;
    return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}

export function sayCommand(args: string[]): void {
    if (!needDump()) process.exit(1);
    const q = args.join(' ').trim();
    if (!q) { console.error('usage: bun run mod say <file.message_N>   or   bun run mod say <text to search for>'); process.exit(1); }
    const dialogue = dumpDialogue();
    const dot = q.match(/^([A-Za-z0-9_]+)\.([A-Za-z0-9_]+)$/);
    if (dot) {
        const entry = dialogue.get(dot[1]!)?.[dot[2]!];
        if (!entry) {
            const file = dialogue.get(dot[1]!);
            console.log(file ? `no key ${dot[2]} in ${dot[1]}.yml` : `no dialogue file ${dot[1]}.yml in the dump`);
            process.exit(1);
        }
        const face = entry.faceset ? `  [face ${entry.faceset} #${entry.faceindex}]` : '';
        console.log(`${q}${face}\n${entry.text ?? '(no text)'}`);
        return;
    }
    const needle = q.toLowerCase();
    let hits = 0;
    for (const [file, doc] of dialogue) for (const [key, e] of Object.entries(doc)) {
        const t = typeof e?.text === 'string' ? e.text : '';
        if (t.toLowerCase().includes(needle)) { console.log(`${file}.${key}: ${t.replace(/\n/g, ' ').slice(0, 140)}`); if (++hits >= 25) break; }
    }
    if (hits === 0) console.log('no matches');
    else if (hits >= 25) console.log('(first 25 matches)');
}

export function macrosCommand(): void {
    if (!needDump()) process.exit(1);
    const m = dumpMacros();
    if (!m.size) { console.log('no message macros found in dump/js/plugins.js'); return; }
    for (const [name, text] of m) console.log(`\\${name.padEnd(8)} ${text}`);
}

/** Count what the game uses: plugin commands, script-call heads, and event codes (dump maps, common events and troops). */
export function commandsCommand(args: string[]): void {
    if (!needDump()) process.exit(1);
    const top = Number(args.find(a => /^\d+$/.test(a)) ?? 25);
    const lists: { code: number; parameters: any[] }[][] = [];
    for (const f of readdirSync(join(DUMP, 'data'))) {
        if (!/^(Map\d+|CommonEvents|Troops)\.json$/.test(f)) continue;
        const j = JSON.parse(dec.decode(readFileSync(join(DUMP, 'data', f))));
        const list = Array.isArray(j) ? j : [j];
        for (const item of list) {
            if (!item) continue;
            if (Array.isArray(item.pages)) for (const p of item.pages) lists.push(p.list ?? []);
            if (Array.isArray(item.list)) lists.push(item.list);
            if (Array.isArray(item.events)) for (const e of item.events) if (e) for (const p of e.pages ?? []) lists.push(p.list ?? []);
        }
    }
    const u = usageOf(lists);
    const show = (m: Map<string, number>) => [...m].sort((a, b) => b[1] - a[1]).slice(0, top);
    console.log(`plugin commands (code 356), top ${top}:`);
    for (const [k, v] of [...u.plugin].sort((a, b) => b[1].count - a[1].count).slice(0, top)) console.log(`  ${String(v.count).padStart(6)}  ${k.padEnd(28)} e.g. ${v.sample}`);
    console.log(`\nscript calls (code 355), top ${top}:`);
    for (const [k, n] of show(u.script)) console.log(`  ${String(n).padStart(6)}  ${k}`);
    console.log(`\nevent codes:`);
    for (const [k, n] of [...u.codes].sort((a, b) => b[1] - a[1]).slice(0, top)) console.log(`  ${String(n).padStart(7)}  ${k}  ${EVENT_NAMES[k] ?? ''}`);
}

/** Lint mod folders: dialogue, sprite names, and ShowMessage references (resolved against the dump and the mod). */
export function lintCommand(args: string[]): void {
    const dirs = args.length ? args.map(a => (existsSync(join(a, 'mod.json')) ? a : [join(ROOT, 'mods', a), join(ROOT, 'examples', a)].find(d => existsSync(join(d, 'mod.json'))) ?? a))
        : [join(ROOT, 'mods'), join(ROOT, 'examples')].flatMap(d => existsSync(d) ? readdirSync(d).map(x => join(d, x)) : []).filter(d => existsSync(join(d, 'mod.json')));
    if (!dirs.length) { console.log('no mods to lint'); return; }
    const dump = dumpDialogue();
    const macros = dumpMacros();
    const omoriBase = join(DUMP, 'js', 'plugins', 'Omori BASE.js');
    const extraCodes = existsSync(omoriBase) ? pluginCodes(dec.decode(readFileSync(omoriBase))) : new Set(['fn']);
    let errors = 0;
    if (dirs.length > 1) {
        const cross = crossModFindings(dirs.map(modMapClaims));
        if (cross.length) console.log('across mods:');
        for (const f of cross) { if (f.level === 'error') errors++; console.log(`  ${f.level === 'error' ? '✗' : '!'} ${f.file}: ${f.message}`); }
    }
    for (const dir of dirs) {
        const findings: Finding[] = [];
        const modDialogue = new Map<string, Record<string, any>>();
        const face = faceChecker(dir);
        const langDir = join(dir, 'files', 'languages', 'en');
        if (existsSync(langDir)) for (const f of readdirSync(langDir).filter(x => /\.ya?ml$/.test(x))) {
            const rel = `files/languages/en/${f}`;
            const { doc, findings: parse } = parseDialogue(dec.decode(readFileSync(join(langDir, f))), rel);
            findings.push(...parse);
            if (doc) { modDialogue.set(f.replace(/\.ya?ml$/, ''), doc); findings.push(...lintDialogue(doc, rel, { macros, extraCodes, faceExists: face })); }
        }
        const imgDir = join(dir, 'files', 'img', 'characters');
        if (existsSync(imgDir)) for (const f of readdirSync(imgDir).filter(x => /\.png$/i.test(x))) {
            const size = pngSize(join(imgDir, f));
            findings.push(...lintSpriteName(f, size ?? undefined).map(x => ({ ...x, file: `files/img/characters/${x.file}` })));
        }
        const known = (file: string, key: string) => !!(dump.get(file)?.[key] ?? modDialogue.get(file)?.[key]);
        for (const sub of ['files', 'patches', 'scripts', 'maps']) {   // maps/ holds the map specs, whose plugin commands name dialogue
            const root = join(dir, sub);
            if (!existsSync(root)) continue;
            const walk = (d: string): string[] => readdirSync(d).flatMap(x => {
                const p = join(d, x);
                return statSync(p).isDirectory() ? walk(p) : /\.(json|ya?ml|js|ts)$/.test(x) ? [p] : [];
            });
            for (const p of walk(root)) {
                for (const ref of showMessageRefs(readFileSync(p, 'utf8'))) {
                    if (!known(ref.file, ref.key)) findings.push({ level: 'warn', file: relative(dir, p), message: `ShowMessage ${ref.file}.${ref.key} matches no dialogue key (game dump or mod)` });
                }
            }
        }
        const label = dir.split('/').pop();
        if (!findings.length) { console.log(`✓ ${label}: nothing to report`); continue; }
        console.log(`${label}:`);
        for (const f of findings) {
            if (f.level === 'error') errors++;
            const mark = f.level === 'error' ? '✗' : f.level === 'warn' ? '!' : '·';
            console.log(`  ${mark} ${f.file}: ${f.message}`);
        }
    }
    if (!existsSync(DUMP)) console.log('(no dump: game dialogue and macros were not checked; run `bun run mod dump`)');
    process.exit(errors ? 1 : 0);
}

// ---------------------------------------------------------------- art: measure and decode the game's images (never writes into the install)
/** The engine that decodes RPG Maker's encrypted images with the key from the player's own System data. */
function artEngine(): ModEngine | null {
    const key = readGameKey();
    if (!key) return null;
    const e = new ModEngine(() => key, () => {});
    const sys = JSON.parse(dec.decode(e.decrypt(new Uint8Array(readFileSync(join(WWW, 'data', 'System.KEL'))))));
    e.assetKey = assetKeyFromSystem(sys);
    return e;
}

/** Width and height from a decoded PNG header, or null when the bytes are not a PNG. */
export function pngHeaderSize(b: Uint8Array): { width: number; height: number } | null {
    const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
    if (b.length < 24 || v.getUint32(0) !== 0x89504e47) return null;
    return { width: v.getUint32(16), height: v.getUint32(20) };
}

/** `mod art sizes <folder>`: how big the game's images are, per folder (e.g. characters, faces, pictures, tilesets). */
export function artSizesCommand(args: string[]): void {
    const sub = args[0] ?? 'characters';
    const e = artEngine();
    if (!e) { console.error('no game key: point OMORI_DIR at your install (see `bun run mod`)'); process.exit(1); }
    const dir = join(WWW, 'img', sub);
    if (!existsSync(dir)) { console.error(`no folder img/${sub} in the game`); process.exit(1); }
    const tally = new Map<string, { n: number; example: string }>();
    for (const f of readdirSync(dir).filter(x => x.endsWith('.rpgmvp'))) {
        const size = pngHeaderSize(e.decryptAsset(new Uint8Array(readFileSync(join(dir, f)))));
        const k = size ? `${size.width}x${size.height}` : 'not a PNG';
        const cur = tally.get(k);
        tally.set(k, { n: (cur?.n ?? 0) + 1, example: cur?.example ?? f });
    }
    console.log(`img/${sub}: ${[...tally.values()].reduce((a, b) => a + b.n, 0)} images`);
    for (const [k, v] of [...tally].sort((a, b) => b[1].n - a[1].n).slice(0, 15)) console.log(`  ${String(v.n).padStart(5)}  ${k.padEnd(12)} e.g. ${v.example}`);
}

/** `mod art decode <folder/name> [outDir]`: write one game image as a PNG for reading (it is game art: never commit it). */
export function artDecodeCommand(args: string[]): void {
    const [rel, outArg] = args;
    if (!rel) { console.error('usage: bun run mod art decode <folder/name without .rpgmvp> [outDir]'); process.exit(1); }
    const e = artEngine();
    if (!e) { console.error('no game key: point OMORI_DIR at your install'); process.exit(1); }
    const name = rel.replace(/\.(rpgmvp|png)$/i, '');
    const src = join(WWW, 'img', `${name}.rpgmvp`);
    if (!existsSync(src)) { console.error(`not found: img/${name}.rpgmvp`); process.exit(1); }
    const out = join(outArg ?? join(ROOT, 'art-out'), `${name}.png`);
    mkdirSync(dirname(out), { recursive: true });
    const plain = e.decryptAsset(new Uint8Array(readFileSync(src)));
    if (!pngHeaderSize(plain)) { console.error('decoded bytes are not a PNG: the key or the file is wrong'); process.exit(1); }
    writeFileSync(out, plain);
    console.log(`wrote ${out}  (game art: keep it out of commits)`);
}

/** `mod art key`: print the image key read from the player's own install (for the project's art scripts). Nothing is stored. */
export function artKeyCommand(): void {
    const e = artEngine();
    if (!e || !e.assetKey) { console.error('no game key: point OMORI_DIR at your OMORI install (the folder with www/ and Launch_OMORI.bat)'); process.exit(1); }
    console.log(Buffer.from(e.assetKey).toString('hex'));
}

/** Map ids and registry extensions per mod folder, for checks across mods (lint runs them when given two or more mods). */
export function modMapClaims(dir: string): { label: string; ids: Set<number>; registryAdds: number[] } {
    const ids = new Set<number>();
    const specDir = join(dir, 'maps');
    if (existsSync(specDir)) for (const f of readdirSync(specDir).filter(x => x.endsWith('.spec.json'))) {
        const id = Number(JSON.parse(readFileSync(join(specDir, f), 'utf8')).id);
        if (Number.isInteger(id)) ids.add(id);
    }
    const dataDir = join(dir, 'files', 'data');
    if (existsSync(dataDir)) for (const f of readdirSync(dataDir)) {
        const m = f.match(/^Map(\d+)\.json$/);
        if (m) ids.add(Number(m[1]));
    }
    const registryAdds: number[] = [];
    const patch = join(dir, 'patches', 'data', 'MapInfos.json.patch.json');
    if (existsSync(patch)) for (const op of JSON.parse(readFileSync(patch, 'utf8'))) {
        const m = /^\/(\d+)$/.exec(op.path ?? '');
        if (op.op === 'add' && m) registryAdds.push(Number(m[1]));
    }
    return { label: dir.split('/').pop()!, ids, registryAdds };
}

/** Findings that need more than one mod: the same map id in two mods, or two mods extending the MapInfos registry above 999. */
export function crossModFindings(claims: ReturnType<typeof modMapClaims>[]): Finding[] {
    const out: Finding[] = [];
    const owner = new Map<number, string>();
    for (const c of claims) for (const id of c.ids) {
        const other = owner.get(id);
        if (other && other !== c.label) out.push({ level: 'error', file: c.label, message: `map ${id} is also used by ${other}: two mods cannot share a map id` });
        else owner.set(id, c.label);
    }
    const extenders = claims.filter(c => c.registryAdds.some(n => n >= 1000));
    if (extenders.length > 1) out.push({ level: 'error', file: extenders.map(c => c.label).join(', '), message: 'more than one mod extends data/MapInfos.json above id 999 with JSON Patch "add": each add inserts and shifts the others, so the registry ends up misplaced. Keep one mod responsible for the registry, or change the engine to set entries by id (see openomori.md, MapInfos).' });
    return out;
}
