// Bun side of the map kit: a GameSource that reads the player's install directly, and the `mod map ...` commands.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { GAME_DIR, ROOT, WWW, readGameKey } from '../gamedir.ts';
import { ModEngine } from './engine.ts';
import { buildMaps, previewMap, type GameSource, type MapSpec } from './mapkit.ts';
import { scanStory, storyReport, type ScanSource, type StoryIndex } from './storyscan.ts';

const dec = new TextDecoder();

export function gameSource(modDir?: string): GameSource {
    const engine = new ModEngine(readGameKey, () => {});
    const cache = new Map<string, any>();
    const read = (rel: string): any => {
        if (cache.has(rel)) return cache.get(rel);
        const p = join(WWW, rel);
        if (!existsSync(p)) throw new Error(`${rel} not found in the game (${GAME_DIR})`);
        const v = JSON.parse(dec.decode(engine.decrypt(new Uint8Array(readFileSync(p)))));
        cache.set(rel, v);
        return v;
    };
    const lower = (dir: string, name: string) => { // game files are matched case-insensitively
        const hit = readdirSync(join(WWW, dir)).find(f => f.toLowerCase() === name.toLowerCase());
        return hit ? `${dir}/${hit}` : `${dir}/${name}`;
    };
    return {
        tiledMap: id => read(lower('maps', `map${id}.AUBREY`)),
        mapData: id => read(lower('data', `Map${String(id).padStart(3, '0')}.KEL`)),
        mapInfos: () => read('data/MapInfos.KEL'),
        tileset: source => { try { return read(lower('maps', source.replace(/\.json$/i, '.AUBREY'))); } catch { return null; } },
        commonEventCount: () => (read('data/CommonEvents.KEL') as unknown[]).length - 1,
        systemCounts: () => { try { const s = read('data/System.KEL'); return { switches: s.switches.length - 1, variables: s.variables.length - 1 }; } catch { return null; } },
        pngSize: rel => {
            const f = modDir && join(modDir, 'files', rel);
            if (!f || !existsSync(f)) return null;
            const b = readFileSync(f);
            if (b.length < 24 || b.readUInt32BE(0) !== 0x89504e47) return null;
            return [b.readUInt32BE(16), b.readUInt32BE(20)];
        },
        assetExists: rel => {
            const base = rel.replace(/\.png$/i, '');
            if (modDir && [`files/${rel}`, `files/${base}.png`].some(f => existsSync(join(modDir, f)))) return true;
            return [`${base}.rpgmvp`, `${base}.png`].some(f => { try { return existsSync(join(WWW, dirname(f), readdirSync(join(WWW, dirname(f))).find(n => n.toLowerCase() === f.split('/').pop()!.toLowerCase()) ?? '\0')); } catch { return false; } });
        },
    };
}

const modDirOf = (p: string) => [resolve(p), join(ROOT, 'mods', p), join(ROOT, 'examples', p)].find(d => existsSync(join(d, 'mod.json'))) ?? join(ROOT, 'mods', p);

export function loadSpecs(modDir: string): { file: string; spec: MapSpec }[] {
    const dir = join(modDir, 'maps');
    if (!existsSync(dir)) return [];
    return readdirSync(dir).filter(f => /\.spec\.json$/.test(f)).sort().map(f => ({ file: f, spec: JSON.parse(readFileSync(join(dir, f), 'utf8')) as MapSpec }));
}

/** Compile every maps/*.spec.json in a mod. Returns false if anything was wrong (nothing is written then). */
export function buildMod(modArg: string, quiet = false): boolean {
    const modDir = modDirOf(modArg);
    if (!existsSync(join(modDir, 'mod.json'))) { console.error(`${modDir} has no mod.json`); return false; }
    const id = JSON.parse(readFileSync(join(modDir, 'mod.json'), 'utf8')).id as string;
    const specs = loadSpecs(modDir);
    if (!specs.length) { if (!quiet) console.log(`no maps/*.spec.json in ${modDir}`); return true; }
    const built = buildMaps(id, specs.map(s => s.spec), gameSource(modDir));
    for (const w of built.warnings) console.log(`! ${w}`);
    for (const e of built.errors) console.log(`✗ ${e}`);
    if (built.errors.length) { console.log(`nothing written: ${built.errors.length} error(s)`); return false; }
    for (const [rel, text] of Object.entries(built.files)) {
        mkdirSync(dirname(join(modDir, rel)), { recursive: true });
        writeFileSync(join(modDir, rel), text);
    }
    console.log(`✓ built ${specs.map(x => x.spec.id).join(', ')} (${Object.keys(built.files).length} files)`);
    return true;
}

function show(args: string[]) {
    const src = gameSource();
    const gi = args.indexOf('--game');
    if (gi >= 0) { // preview a map of the real game, with its events
        const id = Number(args[gi + 1]);
        const t = src.tiledMap(id);
        const ev = (src.mapData(id).events as any[]).filter(Boolean).map(e => ({ x: e.x, y: e.y, name: e.name }));
        console.log(`map ${id}: ${src.mapInfos()[id]?.name ?? '?'}\n${previewMap(t, ev)}`);
        return;
    }
    const [modArg, idArg] = args;
    if (!modArg || !idArg) { console.error('usage: bun run mod map show <mod> <id>   |   bun run mod map show --game <id>'); process.exit(1); }
    const dir = modDirOf(modArg), id = Number(idArg);
    const t = JSON.parse(readFileSync(join(dir, `files/maps/map${id}.json`), 'utf8'));
    const d = JSON.parse(readFileSync(join(dir, `files/data/Map${id}.json`), 'utf8'));
    console.log(previewMap(t, (d.events as any[]).filter(Boolean).map(e => ({ x: e.x, y: e.y, name: e.name }))));
}

function create(args: string[]) {
    const [modArg, idArg, name, size] = args;
    const m = /^(\d+)x(\d+)$/.exec(size ?? '');
    if (!modArg || !idArg || !name || !m) { console.error('usage: bun run mod map new <mod> <id> "<Name>" <W>x<H> [--tiles-from <mapId>]'); process.exit(1); }
    const dir = modDirOf(modArg), id = Number(idArg);
    if (!existsSync(join(dir, 'mod.json'))) { console.error(`${dir} is not a mod (run \`bun run mod new ${modArg}\` first)`); process.exit(1); }
    const tf = args.indexOf('--tiles-from');
    const spec: MapSpec = {
        id, name, size: [Number(m[1]), Number(m[2])], ...(tf >= 0 ? { tilesFrom: Number(args[tf + 1]) } : {}),
        stamps: [], blocked: [],
        events: [{ name: 'Hello', x: 2, y: 2, sprite: 'FA_KEL', do: [{ say: 'Hello from my new map!' }] }],
    };
    const p = join(dir, 'maps', `${id}.spec.json`);
    if (existsSync(p)) { console.error(`${p} already exists`); process.exit(1); }
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(spec, null, 2) + '\n');
    console.log(`created ${p}\nEdit it, then: bun run mod map build ${modArg}   and   bun run mod map show ${modArg} ${id}`);
}

export function mapCommand(args: string[]) {
    const [sub, ...rest] = args;
    switch (sub) {
        case 'new': create(rest); break;
        case 'build': process.exit(buildMod(rest[0] ?? '') ? 0 : 1);
        case 'show': show(rest); break;
        default: console.log('bun run mod map new <mod> <id> "<Name>" <W>x<H> [--tiles-from <mapId>]   starter spec\nbun run mod map build <mod>                                          compile maps/*.spec.json into the mod\nbun run mod map show <mod> <id> | --game <id>                        ASCII picture (# blocked, . drawn, letters = events)');
    }
}

/** Reads straight from the install, one map at a time (nothing is cached: the scan touches ~470 maps). */
export function storySource(): ScanSource {
    const engine = new ModEngine(readGameKey, () => {});
    const read = (rel: string): any => JSON.parse(dec.decode(engine.decrypt(new Uint8Array(readFileSync(join(WWW, rel))))));
    const files = new Map(readdirSync(join(WWW, 'data')).map(f => [f.toLowerCase(), f]));
    return {
        mapInfos: () => read('data/MapInfos.KEL'),
        commonEvents: () => read('data/CommonEvents.KEL'),
        system: () => { const sys = read('data/System.KEL'); return { switches: sys.switches, variables: sys.variables }; },
        mapData: id => { const f = files.get(`map${String(id).padStart(3, '0')}.kel`); return f ? read(`data/${f}`) : null; },
    };
}

let storyCache: StoryIndex | null = null;
export const storyIndex = (): StoryIndex => (storyCache ??= scanStory(storySource()));

export function routesCommand(args: string[]) {
    const ix = storyIndex();
    const out = args.find(a => a !== '--json');
    const text = args.includes('--json') ? JSON.stringify(ix, null, 2) : storyReport(ix);
    if (out) { mkdirSync(dirname(resolve(out)), { recursive: true }); writeFileSync(resolve(out), text); console.log(`wrote ${resolve(out)} (${ix.spine.length} spine switches, ${ix.hubs.length} hubs, ${ix.mapsScanned} maps)`); }
    else console.log(text);
}
