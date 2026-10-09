// Turns a mod folder/zip into a ModDef: a list of edits to game files plus client scripts.
// Two manifest dialects are understood and normalised here:
//   native    convention over configuration (files/, patches/, scripts/); no "files" key in mod.json
//   oneloader GOMORI / OneLoader mods: mod.json with a "files" object (with or without "manifestVersion"; a missing
//             version means 1). The rules below mirror OneLoader's own loader so existing mods behave the same.
import type { Tree } from './vfs.ts';

export type Phase = 'early' | 'pre-plugins' | 'post-plugins' | 'ready';
export type Format = 'json' | 'yaml' | 'text' | 'binary';
/** replace: new content (plain; encrypted for you) · raw: bytes already in the game's final form · append: add text to the end */
export type EditKind = 'replace' | 'raw' | 'jsonpatch' | 'merge' | 'text' | 'append';
/** none: served as-is · aes: game data (needs the game key, so only the page can serve it) · rpg: RPG Maker image/audio encryption (needs the asset key) */
export type Crypt = 'none' | 'aes' | 'rpg';

export interface Edit { target: string; kind: EditKind; source: string }
export interface ClientScript {
    file: string;
    phase: Phase;
    /** classic: a plain script · eval: an async function body receiving `params` · require: a module exporting an async function */
    style?: 'classic' | 'eval' | 'require';
    /** order among scripts of the same phase (OneLoader's run-at stages) */
    rank?: number;
    runat?: string;
}

export interface PluginRule { at?: number; after?: string; weight?: number }

export interface ModDef {
    id: string;
    name: string;
    version: string;
    description: string;
    author?: string;
    format: 'native' | 'oneloader';
    dependencies: string[];
    loadAfter: string[];
    /** lower runs first; later mods win conflicts */
    priority: number;
    requires: string[];
    excludes: string[];
    satisfies: string[];
    skipChecks: Record<string, string[]>;
    flags: string[];
    edits: Edit[];
    scripts: ClientScript[];
    /** game plugin list edits: plugin name -> JSON Patch applied to its parameters */
    pluginParameters: Record<string, unknown[]>;
    /** where to insert plugins this mod adds to the game's plugin list */
    pluginOrder: Record<string, PluginRule>;
    /** new plugin file names (lowercase, no extension) this mod ships */
    pluginFiles: string[];
    /** image deltas (.olid): game image path (…png) and the delta's path inside the mod */
    imageDeltas: { target: string; source: string }[];
    /** the parsed mod.json, for scripts written against OneLoader's API */
    json: unknown;
    warnings: string[];
    errors: string[];
}

// ---------------------------------------------------------------- path <-> game file mapping
/** How a plain, human-editable file maps onto the game's (usually encrypted) file, and back. */
const ENC = [
    { dir: /^data\//i, plain: /\.json$/i, game: '.KEL', fmt: 'json' as Format },
    { dir: /^data\//i, plain: /\.ya?ml$/i, game: '.PLUTO', fmt: 'yaml' as Format },
    { dir: /^maps\//i, plain: /\.json$/i, game: '.AUBREY', fmt: 'json' as Format },
    { dir: /^languages\/[^/]+\//i, plain: /\.ya?ml$/i, game: '.HERO', fmt: 'yaml' as Format },
    { dir: /^js\/plugins\//i, plain: /\.js$/i, game: '.OMORI', fmt: 'text' as Format },
];

export interface Target { game: string; fmt: Format; crypt: Crypt; /** crypt === 'aes' */ encrypted: boolean }
const target = (game: string, fmt: Format, crypt: Crypt): Target => ({ game, fmt, crypt, encrypted: crypt === 'aes' });

/** PNGs the game really keeps unencrypted (OneLoader's `raw` exceptions). */
const PLAIN_PNGS = new Set(['img/system/window.png', 'img/system/loading.png']);

/** images and sound live as RPG-Maker-encrypted .rpgmvp / .rpgmvo; authors supply .png / .ogg */
function assetTarget(p: string): Target | null {
    if (/\.png$/i.test(p) && !PLAIN_PNGS.has(p.toLowerCase())) return target(p.replace(/\.png$/i, '.rpgmvp'), 'binary', 'rpg');
    if (/\.ogg$/i.test(p)) return target(p.replace(/\.ogg$/i, '.rpgmvo'), 'binary', 'rpg');
    return null;
}

/** For files an author puts under files/: data, maps, text and plugins by folder; images/audio by extension in img/ and audio/. */
export function targetOf(plainPath: string): Target {
    const p = plainPath.replace(/\\/g, '/');
    for (const e of ENC) if (e.dir.test(p) && e.plain.test(p)) return target(p.replace(e.plain, e.game), e.fmt, 'aes');
    if (/^(img|audio)\//i.test(p)) { const a = assetTarget(p); if (a) return a; }
    if (/\.json$/i.test(p)) return target(p, 'json', 'none');
    if (/\.(js|css|html|txt|md|ya?ml)$/i.test(p)) return target(p, 'text', 'none');
    return target(p, 'binary', 'none');
}

/** The inverse, for dumping and for reading a game file: which format is this path? */
export function formatOfGamePath(gamePath: string): Target {
    for (const e of ENC) if (e.dir.test(gamePath) && gamePath.toLowerCase().endsWith(e.game.toLowerCase())) return target(gamePath, e.fmt, 'aes');
    if (/\.(rpgmvp|rpgmvo)$/i.test(gamePath)) return target(gamePath, 'binary', 'rpg');
    return targetOf(gamePath);
}

export const plainName = (gamePath: string): string => {
    for (const e of ENC) if (e.dir.test(gamePath) && gamePath.endsWith(e.game)) return gamePath.slice(0, -e.game.length) + (e.fmt === 'json' ? '.json' : e.fmt === 'yaml' ? '.yml' : '.js');
    return gamePath;
};

const ID_RE = /^[a-z0-9][a-z0-9._-]{1,63}$/;
const NATIVE_KEYS = new Set(['id', 'name', 'version', 'description', 'author', 'dependencies', 'loadAfter', 'scripts', 'gameVersion', 'homepage', 'license', '$schema', 'priority']);
const PHASES: Phase[] = ['early', 'pre-plugins', 'post-plugins', 'ready'];

const dec = new TextDecoder();
const text = (t: Tree, p: string) => dec.decode(t.read(p));

function blank(label: string): ModDef {
    return {
        id: label, name: label, version: '0', description: '', format: 'native', dependencies: [], loadAfter: [], priority: 0, requires: [], excludes: [], satisfies: [], skipChecks: {},
        flags: [], edits: [], scripts: [], pluginParameters: {}, pluginOrder: {}, pluginFiles: [], imageDeltas: [], json: null, warnings: [], errors: [],
    };
}

/** Find a path in the tree, tolerating differences in case and slashes (mods are written on Windows, zips are case-sensitive). */
function resolve(tree: Tree, p: string): string | null {
    const clean = p.replace(/\\/g, '/').replace(/^\.?\/+/, '');
    if (tree.files.includes(clean)) return clean;
    const low = clean.toLowerCase();
    return tree.files.find(f => f.toLowerCase() === low) ?? null;
}

export function loadMod(tree: Tree, label: string): ModDef {
    const m = blank(label);
    if (!tree.files.includes('mod.json')) { m.errors.push('missing mod.json at the mod root'); return m; }
    let raw: any;
    try { raw = JSON.parse(text(tree, 'mod.json').replace(/^﻿/, '')); }
    catch (e) { m.errors.push(`mod.json is not valid JSON: ${(e as Error).message}`); return m; }
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) { m.errors.push('mod.json must be a JSON object'); return m; }

    m.json = raw;
    if (typeof raw.id === 'string') m.id = raw.id;
    m.name = typeof raw.name === 'string' ? raw.name : m.id;
    m.version = String(raw.version ?? '0');
    m.description = typeof raw.description === 'string' ? raw.description : '';
    if (typeof raw.author === 'string') m.author = raw.author;
    m.priority = parseInt(raw.priority) || 0;

    const olKeys = ['manifestVersion', 'image_deltas', 'asyncExec', 'plugin_parameters', 'plugins_ordered', '_flags', 'exec'];
    const oneloaderStyle = olKeys.some(k => k in raw) || (typeof raw.files === 'object' && raw.files !== null && !Array.isArray(raw.files));
    if (oneloaderStyle) oneloader(tree, raw, m); else native(tree, raw, m);
    return m;
}

// ---------------------------------------------------------------- native
function native(tree: Tree, raw: any, m: ModDef) {
    m.format = 'native';
    if (typeof raw.id !== 'string' || !ID_RE.test(raw.id)) m.errors.push(`"id" must match ${ID_RE} (lowercase letters, digits, . _ -); got ${JSON.stringify(raw.id)}`);
    if (typeof raw.name !== 'string') m.errors.push('"name" is required (display name)');
    for (const k of Object.keys(raw)) if (!NATIVE_KEYS.has(k)) m.warnings.push(`unknown mod.json key "${k}" (typo? known: ${[...NATIVE_KEYS].join(', ')})`);
    for (const k of ['dependencies', 'loadAfter'] as const) {
        if (raw[k] === undefined) continue;
        if (!Array.isArray(raw[k]) || raw[k].some((x: unknown) => typeof x !== 'string')) m.errors.push(`"${k}" must be an array of mod ids`);
        else m[k] = raw[k];
    }

    for (const f of tree.files) {
        if (f.startsWith('files/')) {
            const rel = f.slice(6);
            m.edits.push({ target: targetOf(rel).game, kind: 'replace', source: f });
        } else if (f.startsWith('patches/')) {
            const rel = f.slice(8);
            const mg = /^(.*)\.merge\.json$/.exec(rel), pj = /^(.*)\.patch\.json$/.exec(rel);
            if (!mg && !pj) { m.warnings.push(`${f}: patch files must end in .patch.json or .merge.json (ignored)`); continue; }
            const base = (mg ?? pj)![1]!, t = targetOf(base);
            if (mg && t.fmt === 'text') { m.warnings.push(`${f}: merge patches only apply to json/yaml targets (ignored)`); continue; }
            m.edits.push({ target: t.game, kind: mg ? 'merge' : t.fmt === 'text' ? 'text' : 'jsonpatch', source: f });
        }
    }

    if (raw.scripts !== undefined) {
        if (!Array.isArray(raw.scripts)) m.errors.push('"scripts" must be an array of file names or {file, phase}');
        else for (const s of raw.scripts) addScript(tree, m, typeof s === 'string' ? { file: s } : s);
    } else {
        for (const f of tree.files) if (/^scripts\/[^/]+\.js$/i.test(f)) addScript(tree, m, { file: f });
    }
}

function addScript(tree: Tree, m: ModDef, s: { file?: string; phase?: string }) {
    const file = s?.file?.replace(/^\.?\//, '');
    if (typeof file !== 'string' || !tree.files.includes(file)) { m.errors.push(`script not found: ${JSON.stringify(s?.file)}`); return; }
    const phase = (s.phase ?? 'post-plugins') as Phase;
    if (!PHASES.includes(phase)) { m.errors.push(`script ${file}: unknown phase "${s.phase}" (use ${PHASES.join(' | ')})`); return; }
    m.scripts.push({ file, phase, style: 'classic' });
}

// ---------------------------------------------------------------- OneLoader / GOMORI
interface FormatRule { target: string; delta: boolean; method?: 'json' | 'yaml' | 'append'; encrypt: boolean; esm?: boolean }
interface DataRule { keys: string[]; mount: string; formats: Record<string, FormatRule>; plugins?: boolean }

/** OneLoader's DATA_RULES, verbatim in meaning. Language is the game's default, "en". */
const DATA_RULES: DataRule[] = [
    { keys: ['data', 'data_delta', 'data_pluto', 'data_pluto_delta'], mount: 'data', formats: {
        json: { target: 'KEL', delta: false, encrypt: true }, jsond: { target: 'KEL', delta: true, method: 'json', encrypt: true }, kel: { target: 'KEL', delta: false, encrypt: false },
        yml: { target: 'PLUTO', delta: false, encrypt: true }, ymld: { target: 'PLUTO', delta: true, method: 'yaml', encrypt: true },
        yaml: { target: 'PLUTO', delta: false, encrypt: true }, yamld: { target: 'PLUTO', delta: true, method: 'yaml', encrypt: true }, pluto: { target: 'PLUTO', delta: false, encrypt: false } } },
    { keys: ['text', 'text_delta'], mount: 'languages/en', formats: {
        yml: { target: 'HERO', delta: false, encrypt: true }, ymld: { target: 'HERO', delta: true, method: 'yaml', encrypt: true },
        yaml: { target: 'HERO', delta: false, encrypt: true }, yamld: { target: 'HERO', delta: true, method: 'yaml', encrypt: true }, hero: { target: 'HERO', delta: false, encrypt: false } } },
    { keys: ['maps', 'maps_delta'], mount: 'maps', formats: {
        json: { target: 'AUBREY', delta: false, encrypt: true }, jsond: { target: 'AUBREY', delta: true, method: 'json', encrypt: true }, aubrey: { target: 'AUBREY', delta: false, encrypt: false } } },
    { keys: ['plugins', 'plugins_delta'], mount: 'js/plugins', plugins: true, formats: {
        js: { target: 'OMORI', delta: false, encrypt: true }, jsd: { target: 'OMORI', delta: true, method: 'append', encrypt: true },
        mjs: { target: 'OMORI', delta: false, encrypt: true, esm: true }, omori: { target: 'OMORI', delta: false, encrypt: false } } },
];

const KNOWN_SECTIONS = new Set(['assets', 'raw', 'exec', 'asyncExec', 'files', ...DATA_RULES.flatMap(r => r.keys)]);

/** runat stage -> boot phase and order. The game's scripts have not loaded at any stage before plugin injection. */
const RUNAT: Record<string, { phase: Phase; rank: number }> = {
    when_discovered: { phase: 'early', rank: 0 }, pre_stage_2: { phase: 'early', rank: 1 }, post_stage_2: { phase: 'early', rank: 2 },
    pre_window_onload: { phase: 'early', rank: 3 }, pre_game_start: { phase: 'early', rank: 4 }, pre_plugin_injection: { phase: 'pre-plugins', rank: 0 },
};

const baseName = (p: string) => p.slice(p.lastIndexOf('/') + 1);
const dirName = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
const stripExt = (n: string) => n.replace(/\.[^./]*$/, '');
const extOf = (n: string) => (/\.([^./]*)$/.exec(n)?.[1] ?? '').toLowerCase();

/** An entry is a file path, or a directory (trailing "/") meaning the files directly inside it. Paths are relative to the mod root. */
function expandEntry(tree: Tree, entry: string, m: ModDef): string[] {
    const e = entry.replace(/\\/g, '/').replace(/^\.?\/+/, '');
    if (e === '' || e.endsWith('/')) {
        const dir = e.replace(/\/$/, '').toLowerCase();
        const files = tree.files.filter(f => dirName(f).toLowerCase() === dir);
        if (!files.length) m.warnings.push(`"${entry}" matched no files in the mod`);
        return files;
    }
    const hit = resolve(tree, e);
    if (!hit) { m.warnings.push(`"${entry}" is listed but missing from the mod; skipped`); return []; }
    return [hit];
}

function oneloader(tree: Tree, raw: any, m: ModDef) {
    m.format = 'oneloader';
    const version = raw.manifestVersion ?? 1;
    if (version > 1) { m.errors.push(`needs a newer mod loader (manifestVersion ${version}; this one supports 1)`); return; }
    if (typeof raw.id !== 'string' || !raw.id) { m.errors.push('mod.json has no "id"'); return; }
    // `files` should be an object of sections; OneLoader quietly treats anything else (an empty array, null) as "no sections"
    const plainFiles = typeof raw.files === 'object' && raw.files !== null && !Array.isArray(raw.files);
    if (raw.files !== undefined && !plainFiles && !(Array.isArray(raw.files) && raw.files.length === 0)) m.warnings.push('"files" should be an object of sections; it was ignored');
    const files = (plainFiles ? raw.files : {}) as Record<string, unknown>;

    m.flags = Array.isArray(raw._flags) ? raw._flags.map(String) : [];
    for (const k of ['requires', 'excludes', 'satisfies'] as const) if (Array.isArray(raw[k])) m[k] = raw[k].map((x: unknown) => String(x));
    if (raw.skip_checks && typeof raw.skip_checks === 'object') for (const [k, v] of Object.entries(raw.skip_checks)) if (Array.isArray(v)) m.skipChecks[k] = v.map(String);

    // GOMORI's `exec` ran arbitrary Node code; OneLoader refuses those mods outright, and so do we.
    if (Array.isArray(raw.exec) && raw.exec.length) { m.errors.push('uses "exec" (Node scripts), which OneLoader itself refuses to load'); return; }
    const sections = Object.keys(files).filter(k => Array.isArray(files[k]) && (files[k] as unknown[]).length);
    for (const k of Object.keys(files)) if (!KNOWN_SECTIONS.has(k)) m.warnings.push(`unknown files section "${k}" (ignored)`);

    const list = (k: string): string[] => (Array.isArray(files[k]) ? (files[k] as unknown[]).filter((x): x is string => typeof x === 'string') : []);

    // ---- scripts: top-level asyncExec (and the older files.asyncExec)
    const asyncExec = [...(Array.isArray(raw.asyncExec) ? raw.asyncExec : []), ...(Array.isArray(files.asyncExec) ? (files.asyncExec as unknown[]) : [])];
    for (const x of asyncExec as { file?: string; runat?: string }[]) {
        const file = x?.file ? resolve(tree, x.file) : null;
        if (!file) { m.warnings.push(`asyncExec file not found: ${x?.file}`); continue; }
        if (/\.mjs$/i.test(file)) { m.warnings.push(`asyncExec ${file}: ES-module scripts are not supported (skipped)`); continue; }
        const req = /_require$/.test(String(x.runat));
        const stage = String(x.runat).replace(/_require$/, '');
        const r = RUNAT[stage];
        if (!r) { m.warnings.push(`asyncExec ${file}: unknown runat "${x.runat}" (skipped)`); continue; }
        m.scripts.push({ file, phase: r.phase, style: req ? 'require' : 'eval', rank: r.rank, runat: String(x.runat) });
    }

    // ---- assets: PNG/OGG become the game's encrypted .rpgmvp/.rpgmvo, everything else is injected unchanged
    for (const entry of list('assets')) {
        for (const f of expandEntry(tree, entry, m)) {
            const t = assetTarget(f);
            m.edits.push({ target: t ? t.game : f, kind: 'replace', source: f });
        }
    }
    for (const entry of list('raw')) for (const f of expandEntry(tree, entry, m)) m.edits.push({ target: f, kind: 'raw', source: f });

    // ---- data, text, maps, plugins
    for (const rule of DATA_RULES) {
        const done = new Set<string>();
        const ignored: string[] = [];
        const entries = new Set(rule.keys.flatMap(list));
        for (const entry of entries) {
            for (const f of expandEntry(tree, entry, m)) {
                const fmt = rule.formats[extOf(f)];
                if (!fmt) { ignored.push(baseName(f)); continue; }
                if (fmt.esm) { m.warnings.push(`${f}: ES-module plugins (.mjs) are not supported (skipped)`); continue; }
                const dest = `${rule.mount}/${stripExt(baseName(f))}.${fmt.target}`;
                const key = dest.toLowerCase();
                if (done.has(key)) { m.warnings.push(`${dest} is listed twice in this mod; the second one is ignored`); continue; }
                done.add(key);
                const kind: EditKind = fmt.delta ? (fmt.method === 'append' ? 'append' : 'jsonpatch') : fmt.encrypt ? 'replace' : 'raw';
                m.edits.push({ target: dest, kind, source: f });
                if (rule.plugins) {
                    const plugin = stripExt(baseName(f)).toLowerCase();
                    if (fmt.delta) m.warnings.push(`plugin delta ${baseName(f)}: plugin deltas are a deprecated OneLoader feature; applied as an append`);
                    else m.pluginFiles.push(plugin);
                }
            }
        }
        if (ignored.length) m.warnings.push(`${rule.mount}: ${ignored.length} file(s) with an unknown extension were ignored (${ignored.slice(0, 4).join(', ')}${ignored.length > 4 ? ', …' : ''})`);
    }

    // ---- plugin list: parameter patches and ordering of the plugins this mod adds
    if (raw.plugin_parameters && typeof raw.plugin_parameters === 'object') {
        for (const [name, patch] of Object.entries(raw.plugin_parameters)) if (Array.isArray(patch)) m.pluginParameters[name] = patch;
    }
    if (raw.plugins_ordered && typeof raw.plugins_ordered === 'object') {
        if (m.flags.includes('randomize_plugin_name')) m.errors.push('uses both randomize_plugin_name and plugins_ordered; choose one');
        for (const [name, rule] of Object.entries(raw.plugins_ordered)) if (rule && typeof rule === 'object') m.pluginOrder[name.toLowerCase()] = rule as PluginRule;
    }

    // ---- image deltas (.olid): applied at startup by the image patcher
    if (Array.isArray(raw.image_deltas)) {
        for (const d of raw.image_deltas as { patch?: string; with?: string; dir?: boolean }[]) {
            if (typeof d?.patch !== 'string' || typeof d?.with !== 'string') continue;
            if (!d.dir) { m.imageDeltas.push({ target: d.patch, source: d.with }); continue; }
            for (const f of expandEntry(tree, d.with, m)) m.imageDeltas.push({ target: `${d.patch}${baseName(f).replace(/\.olid$/i, '.png')}`, source: f });
        }
    }
    if (m.flags.includes('package_json_editing')) m.warnings.push('edits the launcher\'s package.json, which does not apply in the browser (ignored)');
    void sections;
}
