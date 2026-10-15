// Map editor backend. Mounted by src/server.ts at /editor (page) and /__editor/* (API).
// The editor never touches compiled output directly: it reads and writes maps/<id>.spec.json in a mod, and asks the
// map compiler (src/mods/mapkit.ts) what the result looks like. The game's maps and images are encrypted at rest,
// so this file decrypts them on the way out; nothing from the install is copied into this repository.
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, resolve, sep } from 'node:path';
import { ModEngine, assetKeyFromSystem } from '../src/mods/engine.ts';
import { WWW, readGameKey } from '../src/gamedir.ts';
import { buildMaps, type GameSource, type MapSpec } from '../src/mods/mapkit.ts';
import { buildModDir, gameSource, loadSpecs } from '../src/mods/mapkit-node.ts';

const PUBLIC = join(import.meta.dir, 'public');
const LIBRARY = join(import.meta.dir, 'library.json');
const dec = new TextDecoder();
const json = (v: unknown, status = 200) => Response.json(v, { status, headers: { 'cache-control': 'no-store' } });
const fail = (msg: string, status = 400) => json({ error: msg }, status);

export interface EditorOptions {
    roots: string[];
    /** The folder the game loads dev mods from. A mod edited somewhere else is copied here after BUILD (the way `bun run sync` does). */
    mirrorTo?: string;
}

/** Folder names the editor accepts: no separators, no dots at the start. Blocks "../" tricks in URLs. */
const safeName = (s: string) => /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(s) && !s.includes('..');

export function createEditor({ roots, mirrorTo }: EditorOptions) {
    // ---- game files (decrypted on demand)
    let engine: ModEngine | null = null;
    const eng = () => {
        if (engine) return engine;
        const key = readGameKey();
        if (!key) throw new Error('no game key: point OMORI_DIR at your OMORI install');
        const e = new ModEngine(() => key, () => {});
        e.assetKey = assetKeyFromSystem(JSON.parse(dec.decode(e.decrypt(new Uint8Array(readFileSync(join(WWW, 'data', 'System.KEL')))))));
        return (engine = e);
    };
    const ci = (dir: string, name: string): string | null => {            // case-insensitive file lookup (the game asks for any case)
        const direct = join(dir, name);
        if (existsSync(direct)) return direct;
        try { const hit = readdirSync(dir).find(f => f.toLowerCase() === name.toLowerCase()); return hit ? join(dir, hit) : null; } catch { return null; }
    };
    const gameSources = new Map<string, GameSource>();
    const sourceFor = (modDir: string) => { let s = gameSources.get(modDir); if (!s) gameSources.set(modDir, s = gameSource(modDir)); return s; };
    const baseSource = () => sourceFor('');

    function findMods(): { dir: string; id: string; root: string }[] {
        const seen = new Set<string>(), out: { dir: string; id: string; root: string }[] = [];
        for (const root of roots) {
            let names: string[];
            try { names = readdirSync(root).sort(); } catch { continue; }
            for (const n of names) {
                const dir = join(root, n);
                if (seen.has(n) || !existsSync(join(dir, 'mod.json'))) continue;
                seen.add(n);
                let id = n;
                try { id = JSON.parse(readFileSync(join(dir, 'mod.json'), 'utf8')).id ?? n; } catch { /* keep folder name */ }
                out.push({ dir, id, root });
            }
        }
        return out;
    }
    /** Map ids this mod already has compiled files for (made by this editor or by other tools), so new maps never reuse one. */
    const builtIds = (dir: string): number[] => {
        try { return readdirSync(join(dir, 'files', 'maps')).map(f => /^map(\d+)\.json$/i.exec(f)).filter(Boolean).map(m => Number(m![1])).sort((a, b) => a - b); } catch { return []; }
    };
    /** Maps the mod ships as finished files but has no spec for (made by its own scripts or by hand). We can show them, not safely edit them. */
    const patchNames = (dir: string): Map<number, string> => {
        const names = new Map<number, string>();
        try {
            for (const o of JSON.parse(readFileSync(join(dir, 'patches/data/MapInfos.json.patch.json'), 'utf8')))
                if (o?.value?.name && /^\/(\d+)$/.test(o.path)) names.set(Number(o.path.slice(1)), String(o.value.name));
        } catch { /* no patch, or not one we can read: fall back to the id */ }
        return names;
    };
    const builtMaps = (dir: string): { id: number; name: string }[] => {
        const specIds = new Set(loadSpecs(dir).map(s => s.spec.id));
        const names = patchNames(dir);
        return builtIds(dir).filter(id => !specIds.has(id)).map(id => ({ id, name: names.get(id) ?? `map ${id}` }));
    };
    // ---- ready-made pieces and starting points (library.json), plus the mod's own pieces
    type Piece = { id: string; group?: string; name: string; map: number; rect: [number, number, number, number] };
    const library = () => JSON.parse(readFileSync(LIBRARY, 'utf8')) as { pieces: Piece[]; templates: any[] };
    const myPieces = (dir: string): Piece[] => { try { return JSON.parse(readFileSync(join(dir, 'maps', 'pieces.json'), 'utf8')); } catch { return []; } };
    /** Copy a mod edited outside the game's dev folder into it, so a playtest sees the build. Same as `bun run sync`; only when that folder already has a mod of that name. */
    function mirror(dir: string): string | false {
        if (!mirrorTo) return false;
        const dest = join(mirrorTo, basename(dir));
        if (resolve(dest) === resolve(dir) || !existsSync(join(dest, 'mod.json'))) return false;
        const r = spawnSync('rsync', ['-a', '--delete', `${dir}/`, `${dest}/`], { stdio: 'ignore' });
        return r.status === 0 ? dest : false;
    }
    const dataFile = (id: number) => `Map${String(id).padStart(3, '0')}.json`;
    /** A finished map (files/) or the snapshot of one (maps/.base/), with the tileset descriptions the picture needs. */
    function readBuilt(dir: string, id: number, snapshot: boolean) {
        const read = (rel: string) => { const f = join(dir, rel); return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : null; };
        const tiled = snapshot ? read(`maps/.base/${id}.tiled.json`) : read(`files/maps/map${id}.json`);
        const data = snapshot ? read(`maps/.base/${id}.data.json`) : read(`files/data/${dataFile(id)}`);
        if (!tiled) return null;
        const defs: Record<string, any> = {};
        for (const t of tiled.tilesets as { source: string }[]) {
            const own = read(`files/maps/${t.source}`);
            if (own) defs[t.source] = tilesetEntry(own); else if (findTs(t.source)) defs[t.source] = findTs(t.source)!;
        }
        return { id, name: data?.displayName || patchNames(dir).get(id) || `map ${id}`, tiled, tilesetDefs: defs, events: data ? eventsOf(data) : [] };
    }
    /** Hand a finished map to the editor: keep the tool's version as a snapshot and edit on top of it. */
    function takeover(mod: { dir: string }, id: number): string | null {
        if (existsSync(specPath(mod.dir, id))) return `map ${id} is already editable`;
        const tiled = join(mod.dir, 'files', 'maps', `map${id}.json`), data = join(mod.dir, 'files', 'data', dataFile(id));
        if (!existsSync(tiled) || !existsSync(data)) return `this mod has no finished map ${id}`;
        const base = join(mod.dir, 'maps', '.base');
        mkdirSync(base, { recursive: true });
        copyFileSync(tiled, join(base, `${id}.tiled.json`)); copyFileSync(data, join(base, `${id}.data.json`));   // not map<id>/Map<id>: those are one name on macOS and Windows
        // only a name the map really has: inventing one would change what the game shows when you enter it
        const name = JSON.parse(readFileSync(data, 'utf8')).displayName;
        writeFileSync(specPath(mod.dir, id), JSON.stringify({ id, ...(name ? { name } : {}), snapshot: true, stamps: [], blocked: [], events: [] }, null, 2) + '\n');
        return null;
    }
    /** Give a taken-over map back: put the tool's own version back in place and forget the edits. */
    function release(mod: { dir: string; id: string }, id: number): string | null {
        const file = specPath(mod.dir, id);
        if (!existsSync(file) || !JSON.parse(readFileSync(file, 'utf8')).snapshot) return `map ${id} was not taken over from another tool`;
        const base = join(mod.dir, 'maps', '.base');
        if (existsSync(join(base, `${id}.tiled.json`))) copyFileSync(join(base, `${id}.tiled.json`), join(mod.dir, 'files', 'maps', `map${id}.json`));
        if (existsSync(join(base, `${id}.data.json`))) copyFileSync(join(base, `${id}.data.json`), join(mod.dir, 'files', 'data', dataFile(id)));
        for (const f of [file, join(base, `${id}.tiled.json`), join(base, `${id}.data.json`), join(mod.dir, 'files', 'languages', 'en', `${mod.id}_map${id}.yml`)]) rmSync(f, { force: true });
        return null;
    }
    const modDirOf = (name: string) => (safeName(name) ? findMods().find(m => basename(m.dir) === name) : undefined);

    // ---- tilesets: every maps/*.json that is a tileset, found once
    let tilesetIndex: Record<string, { image: string; columns: number; tilecount: number; tilewidth: number; tileheight: number }> | null = null;
    function tilesets() {
        if (tilesetIndex) return tilesetIndex;
        const out: NonNullable<typeof tilesetIndex> = {};
        const dir = join(WWW, 'maps');
        for (const f of readdirSync(dir)) {
            if (!/\.aubrey$/i.test(f)) continue;
            let text: string;
            try { text = dec.decode(eng().decrypt(new Uint8Array(readFileSync(join(dir, f))))); } catch { continue; }
            if (!text.includes('"tilecount"')) continue;
            try {
                const d = JSON.parse(text);
                if (d.type === 'tileset') out[f.replace(/\.aubrey$/i, '.json')] = tilesetEntry(d);
            } catch { /* not json */ }
        }
        return (tilesetIndex = out);
    }
    /** The game matches file names ignoring case ("FA_INTERIOR" asks for the file FA_Interior), so do the same. */
    let lowerTs: Map<string, ReturnType<typeof tilesetEntry>> | null = null;
    const findTs = (source: string) => {
        const all = tilesets();
        lowerTs ??= new Map(Object.entries(all).map(([k, v]) => [k.toLowerCase(), v]));
        return all[source] ?? lowerTs.get(source.toLowerCase()) ?? null;
    };
    const tilesetEntry = (d: any) => ({ image: basename(String(d.image)).replace(/\.png$/i, ''), columns: d.columns, tilecount: d.tilecount, tilewidth: d.tilewidth, tileheight: d.tileheight });

    // ---- names of switches, variables, common events and items, so a number in the editor can say what it is
    let namesCache: Record<string, string[]> | null = null;
    function names() {
        if (namesCache) return namesCache;
        const read = (f: string): any => { try { return JSON.parse(dec.decode(eng().decrypt(new Uint8Array(readFileSync(ci(join(WWW, 'data'), f)!))))); } catch { return null; } };
        const sys = read('System.KEL'), common = read('CommonEvents.KEL'), items = read('Items.KEL');
        const nm = (a: any[] | null) => (a ?? []).map(x => (typeof x === 'string' ? x : x?.name ?? ''));
        return (namesCache = { switches: nm(sys?.switches), variables: nm(sys?.variables), common: nm(common), items: nm(items) });
    }

    // ---- images
    function imageBytes(kind: string, name: string, modDir?: string): Uint8Array | null {
        if (!['tilesets', 'characters'].includes(kind) || !name || name.includes('/') || name.includes('\\') || name.includes('..')) return null;
        if (modDir) {
            const mine = ci(join(modDir, 'files', 'img', kind), `${name}.png`);
            if (mine) return new Uint8Array(readFileSync(mine));
        }
        const dir = join(WWW, 'img', kind);
        const enc = ci(dir, `${name}.rpgmvp`);
        if (enc) return eng().decryptAsset(new Uint8Array(readFileSync(enc)));
        const plain = ci(dir, `${name}.png`);
        return plain ? new Uint8Array(readFileSync(plain)) : null;
    }
    const spriteNames = () => {
        const names = new Set<string>();
        for (const f of readdirSync(join(WWW, 'img', 'characters'))) if (/\.(rpgmvp|png)$/i.test(f)) names.add(f.replace(/\.(rpgmvp|png)$/i, ''));
        return [...names].sort((a, b) => a.localeCompare(b));
    };

    // ---- specs
    const specPath = (modDir: string, id: number) => join(modDir, 'maps', `${id}.spec.json`);
    const validId = (n: unknown): n is number => Number.isInteger(n) && (n as number) >= 1 && (n as number) < 100000;

    function previewOf(modDir: string, modId: string, spec: MapSpec) {
        const others = loadSpecs(modDir).map(s => s.spec).filter(s => s.id !== spec.id);
        const src = sourceFor(modDir);
        const built = buildMaps(modId, [...others, spec], src);
        const mine = (m: string) => m.startsWith(`map ${spec.id}:`);
        const errors = built.errors.filter(mine), warnings = built.warnings.filter(mine);
        const mapFile = built.files[`files/maps/map${spec.id}.json`];
        if (errors.length || !mapFile) return { errors: errors.length ? errors : built.errors.slice(0, 5), warnings, tiled: null };
        const tiled = JSON.parse(mapFile);
        const data = JSON.parse(built.files[`files/data/Map${String(spec.id).padStart(3, '0')}.json`]!);
        const defs: Record<string, any> = {};
        const all = tilesets();
        for (const t of tiled.tilesets as { source: string }[]) {
            const custom = built.files[`files/maps/${t.source}`];
            if (custom) defs[t.source] = tilesetEntry(JSON.parse(custom));
            else if (findTs(t.source)) defs[t.source] = findTs(t.source);
            else { try { const d = src.tileset(t.source); if (d) defs[t.source] = tilesetEntry(d); } catch { /* unknown */ } }
        }
        return { errors, warnings, tiled, tilesetDefs: defs, events: eventsOf(data), mapName: data.displayName };
    }
    const eventsOf = (data: any) => (data.events as any[]).filter(Boolean).map(e => ({ id: e.id, name: e.name, x: e.x, y: e.y, image: e.pages?.[0]?.image ?? null }));

    // ---- static page
    const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json' };
    function page(rel: string): Response {
        const f = resolve(PUBLIC, rel === '' ? 'index.html' : rel);
        if (f !== PUBLIC && !f.startsWith(PUBLIC + sep)) return new Response('not found', { status: 404 });
        if (!statSync(f, { throwIfNoEntry: false })?.isFile()) return new Response('not found', { status: 404 });
        return new Response(Bun.file(f), { headers: { 'content-type': MIME[extname(f)] ?? 'application/octet-stream', 'cache-control': 'no-store' } });
    }

    /** Returns a Response for editor URLs, or null when the URL is not the editor's. */
    async function handle(req: Request, url: URL): Promise<Response | null> {
        const p = url.pathname;
        if (p === '/editor') return Response.redirect(new URL('/editor/', url), 302);
        if (p.startsWith('/editor/')) { try { return page(decodeURIComponent(p.slice('/editor/'.length))); } catch { return new Response('bad path', { status: 400 }); } }
        if (!p.startsWith('/__editor/')) return null;
        const route = p.slice('/__editor/'.length);
        // Writes need a custom header: a web page on another origin cannot send one without a CORS preflight, which we never answer.
        if (req.method !== 'GET' && req.headers.get('x-omori-editor') !== '1') return fail('missing x-omori-editor header', 403);
        try {
            if (route === 'mods') {
                return json(findMods().map(m => ({
                    name: basename(m.dir), id: m.id, root: m.root,
                    maps: loadSpecs(m.dir).map(s => ({ id: s.spec.id, name: s.spec.name ?? patchNames(m.dir).get(s.spec.id) ?? `map ${s.spec.id}`, base: s.spec.base ?? null, taken: !!s.spec.snapshot })),
                    used: builtIds(m.dir),
                    built: builtMaps(m.dir),
                })));
            }
            if (route === 'game/maps') {
                return json(baseSource().mapInfos().filter(Boolean).map((i: any) => ({ id: i.id, name: String(i.name ?? '').trim(), parentId: i.parentId })));
            }
            const gm = /^game\/map\/(\d+)$/.exec(route);
            if (gm) {
                const id = Number(gm[1]), src = baseSource();
                const tiled = src.tiledMap(id), defs: Record<string, any> = {};
                for (const t of tiled.tilesets as { source: string }[]) { const d = findTs(t.source); if (d) defs[t.source] = d; }
                return json({ id, name: src.mapInfos()[id]?.name ?? '', tiled, tilesetDefs: defs, events: eventsOf(src.mapData(id)) });
            }
            if (route === 'game/names') return json(names());
            if (route === 'library') {
                const lib = library(), mod = modDirOf(url.searchParams.get('mod') ?? '');
                return json({ pieces: lib.pieces, templates: lib.templates, mine: mod ? myPieces(mod.dir).map(p => ({ ...p, group: 'Mine' })) : [] });
            }
            if (route === 'tilesets') return json(tilesets());
            if (route === 'sprites') return json(spriteNames());
            if (route === 'img') {
                const bytes = imageBytes(url.searchParams.get('k') ?? '', url.searchParams.get('n') ?? '', modDirOf(url.searchParams.get('mod') ?? '')?.dir);
                return bytes ? new Response(bytes as BodyInit, { headers: { 'content-type': 'image/png', 'cache-control': 'max-age=300' } }) : new Response('no such image', { status: 404 });
            }

            const sm = /^mod\/([^/]+)\/(piece|spec\/(\d+)|built\/(\d+)|snapshot\/(\d+)|mtime\/(\d+)|new|build|preview|takeover|release)$/.exec(route);
            if (sm) {
                const mod = modDirOf(sm[1]!);
                if (!mod) return fail('no such mod', 404);
                const what = sm[2]!;
                if ((what.startsWith('built/') || what.startsWith('snapshot/')) && req.method === 'GET') {
                    const id = Number(sm[4] ?? sm[5]);
                    const r = readBuilt(mod.dir, id, what.startsWith('snapshot/'));
                    return r ? json(r) : fail(`this mod has no ${what.startsWith('snapshot/') ? 'snapshot of ' : 'built '}map ${id}`, 404);
                }
                if (what.startsWith('mtime/')) {
                    const f = specPath(mod.dir, Number(sm[6]));
                    return json({ mtime: statSync(f, { throwIfNoEntry: false })?.mtimeMs ?? null });
                }
                if (what === 'piece' && req.method === 'POST') {
                    const b = (await req.json()) as Partial<Piece>;
                    const r = b.rect;
                    if (!b.name || !validId(b.map) || !Array.isArray(r) || r.length !== 4 || !r.every(n => Number.isInteger(n) && n >= 0) || r[2] < 1 || r[3] < 1) return fail('a piece needs a name, a map and a rectangle');
                    const list = myPieces(mod.dir).filter(p => p.name !== b.name);
                    list.push({ id: `mine-${Date.now().toString(36)}`, name: String(b.name).slice(0, 60), map: b.map!, rect: r as Piece['rect'] });
                    mkdirSync(join(mod.dir, 'maps'), { recursive: true });
                    writeFileSync(join(mod.dir, 'maps', 'pieces.json'), JSON.stringify(list, null, 2) + '\n');
                    return json({ saved: list.length });
                }
                if (what === 'takeover' && req.method === 'POST') {
                    const { id } = (await req.json()) as { id: number };
                    if (!validId(id)) return fail('id must be a whole number');
                    const t = takeover(mod, id);
                    return typeof t === 'string' ? fail(t) : json({ id });
                }
                if (what === 'release' && req.method === 'POST') {
                    const { id } = (await req.json()) as { id: number };
                    if (!validId(id)) return fail('id must be a whole number');
                    const t = release(mod, id);
                    return typeof t === 'string' ? fail(t) : json({ id });
                }
                if (what.startsWith('spec/')) {
                    const id = Number(sm[3]);
                    const file = specPath(mod.dir, id);
                    if (req.method === 'GET') return existsSync(file) ? json(JSON.parse(readFileSync(file, 'utf8'))) : fail('no such map spec', 404);
                    if (req.method === 'PUT') {
                        const spec = (await req.json()) as MapSpec;
                        if (!validId(id) || spec?.id !== id) return fail('spec.id must match the URL');
                        mkdirSync(dirname(file), { recursive: true });
                        writeFileSync(file, JSON.stringify(spec, null, 2) + '\n');
                        return json({ saved: file });
                    }
                }
                if (what === 'preview' && req.method === 'POST') {
                    const spec = (await req.json()) as MapSpec;
                    if (!validId(spec?.id)) return fail('spec.id is required');
                    return json(previewOf(mod.dir, mod.id, spec));
                }
                if (what === 'build' && req.method === 'POST') {
                    const r = buildModDir(mod.dir);
                    return json({ ...r, mirrored: r.ok ? mirror(mod.dir) : false });
                }
                if (what === 'new' && req.method === 'POST') {
                    const b = (await req.json()) as { id: number; name?: string; size?: [number, number]; tilesFrom?: number; base?: number; template?: string };
                    if (!validId(b.id)) return fail('id must be a whole number');
                    const file = specPath(mod.dir, b.id);
                    if (existsSync(file)) return fail(`map ${b.id} already exists in this mod`);
                    const infos = baseSource().mapInfos();
                    if (b.base === undefined && builtIds(mod.dir).includes(b.id)) return fail(`this mod already has a built map ${b.id} (made by another tool). Pick a different id.`);
                    let spec: MapSpec;
                    if (b.base !== undefined) {
                        if (!infos[b.base]) return fail(`the game has no map ${b.base}`);
                        spec = { id: b.base, base: b.base, name: infos[b.base].name };
                        if (existsSync(specPath(mod.dir, b.base))) return fail(`map ${b.base} already exists in this mod`);
                    } else {
                        if (infos[b.id]) return fail(`the game already uses id ${b.id}; pick ${Math.max(1000, infos.length)} or higher`);
                        const lib = library(), tpl = b.template ? lib.templates.find(t => t.id === b.template) : null;
                        if (b.template && !tpl) return fail(`no starting point called ${b.template}`);
                        const [w, h] = b.size ?? tpl?.size ?? [30, 20];
                        if (![w, h].every(n => Number.isInteger(n) && n >= 5 && n <= 300)) return fail('size must be 5 to 300 tiles each way');
                        const stamps = (tpl?.stamps ?? []).map((st: any) => { const p = st.piece ? lib.pieces.find(x => x.id === st.piece) : null; return { from: p?.map ?? st.from, rect: p?.rect ?? st.rect, at: st.at }; });
                        spec = { id: b.id, name: String(b.name || `MAP ${b.id}`).slice(0, 60), size: [w, h], tilesFrom: b.tilesFrom ?? tpl?.tilesFrom ?? 13, stamps, blocked: [], events: [] };
                    }
                    const out = specPath(mod.dir, spec.id);
                    mkdirSync(dirname(out), { recursive: true });
                    writeFileSync(out, JSON.stringify(spec, null, 2) + '\n');
                    return json({ id: spec.id });
                }
            }
            return fail('unknown editor route', 404);
        } catch (e) {
            return fail((e as Error).message, 500);
        }
    }

    return { handle, roots };
}
