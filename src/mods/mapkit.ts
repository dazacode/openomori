// Map & event authoring kit: compiles a small declarative spec (maps/<id>.spec.json in a mod) into the files the
// game actually reads, so nobody needs RPG Maker or Tiled:
//   files/maps/map<ID>.json        Tiled tile layers (what you see + the COLLISION layer)
//   files/data/Map<ID>.json        RPG Maker map properties + events
//   files/languages/en/<mod>_map<ID>.yml   dialogue for every {say} command
//   patches/data/MapInfos.json.patch.json  registers the new map ids
// Pure functions over a GameSource, so they are unit-testable and run in Bun or the browser.

export interface GameSource {
    tiledMap(id: number): any;                     // maps/map<id>.json
    mapData(id: number): any;                      // data/Map<ID>.json
    mapInfos(): any[];                             // data/MapInfos.json
    tileset(source: string): any | null;           // maps/<source>
    commonEventCount(): number;
    systemCounts(): { switches: number; variables: number } | null;
    assetExists(rel: string): boolean;             // e.g. "img/characters/FA_KEL.png"
    pngSize?(rel: string): [number, number] | null; // size of a PNG shipped by the mod being built
}

export type Cond = { switch?: number | number[]; notSwitch?: number | number[]; variable?: [number, '==' | '>=' | '<=' | '>' | '<' | '!=', number]; self?: string; notSelf?: string; item?: number };
export type Cmd =
    | { say: string | string[] }
    | { switch: number; to?: boolean }
    | { variable: number; op?: 'set' | 'add' | 'sub'; value: number }
    | { self: string; to?: boolean }
    | { gold: number }
    | { item: number; count?: number }
    | { transfer: { map: number; x: number; y: number; dir?: 2 | 4 | 6 | 8 } }
    | { wait: number }
    | { se: string | { name: string; volume?: number; pitch?: number } }
    | { bgm: string | { name: string; volume?: number; pitch?: number } }
    | { common: number }
    | { plugin: string }
    | { script: string | string[] }
    | { comment: string }
    | { fade: 'out' | 'in' }
    | { erase: true }
    | { if: Cond | string; then: Cmd[]; else?: Cmd[] };

export interface PageSpec {
    if?: Cond;
    sprite?: string | { name: string; index?: number; dir?: 2 | 4 | 6 | 8; pattern?: 0 | 1 | 2 };
    trigger?: 'action' | 'touch' | 'event-touch' | 'auto' | 'parallel';
    priority?: 'below' | 'same' | 'above';
    through?: boolean; walkAnime?: boolean; stepAnime?: boolean; directionFix?: boolean;
    do?: Cmd[];
}
export interface EventSpec extends PageSpec { name: string; x: number; y: number; note?: string; pages?: PageSpec[] }
export interface Stamp { from: number; rect: [number, number, number, number]; at: [number, number] }
export interface PaintSpec { layer: string; tileset: string; tile?: number; rect?: [number, number, number, number]; at?: [number, number]; tiles?: (number | null)[][] }
export interface MapSpec {
    id: number; name?: string; size?: [number, number];
    base?: number;                 // start from this existing map (same id = edit that map in place, keeping its events)
    removeEvents?: number[];       // with base: event ids to delete
    tilesets?: { name: string }[]; // PNGs at files/img/tilesets/<name>.png become usable tilesets
    paint?: PaintSpec[];           // place tiles from a tileset (the game's or yours) on a named layer
    tilesFrom?: number;            // map whose tilesets/layers to use (default 13)
    stamps?: Stamp[];
    blocked?: string[];            // rows: '#' blocked, '.' open, anything else untouched
    bgm?: string | { name: string; volume?: number; pitch?: number };
    note?: string;
    events?: EventSpec[];
}

export interface Built { files: Record<string, string>; infos: { id: number; name: string }[]; errors: string[]; warnings: string[] }

const DIRS = [2, 4, 6, 8];
const TRIGGERS = { action: 0, touch: 1, 'event-touch': 2, auto: 3, parallel: 4 } as const;
const PRIORITY = { below: 0, same: 1, above: 2 } as const;
const OPS = { '==': 0, '>=': 1, '<=': 2, '>': 3, '<': 4, '!=': 5 } as const;
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));
const audio = (a: string | { name: string; volume?: number; pitch?: number }) => typeof a === 'string' ? { name: a, volume: 90, pitch: 100, pan: 0 } : { name: a.name, volume: a.volume ?? 90, pitch: a.pitch ?? 100, pan: 0 };

// ------------------------------------------------------------------ tiled map
export const collisionGid = (map: any): number => {
    const ts = (map.tilesets as any[]).find(t => /Tile_Collisions/i.test(t.source ?? ''));
    return ts ? ts.firstgid : 0;
};
const isCollisionLayer = (l: any) => /^collision$/i.test(l.name);

function localRef(map: any, gid: number): { source: string; local: number } | null {
    const sets = [...map.tilesets].sort((a: any, b: any) => b.firstgid - a.firstgid);
    const ts = sets.find((t: any) => gid >= t.firstgid);
    return ts ? { source: ts.source, local: gid - ts.firstgid } : null;
}

export function newTiledMap(base: any, w: number, h: number): any {
    const m = clone(base);
    m.width = w; m.height = h;
    m.layers = (m.layers as any[]).map(l => l.type === 'tilelayer'
        ? { ...l, width: w, height: h, data: new Array(w * h).fill(0) }
        : { ...l, objects: [] });
    return m;
}

function ensureTileset(dst: any, source: string, src: GameSource): number {
    const have = (dst.tilesets as any[]).find(t => t.source === source);
    if (have) return have.firstgid;
    const def = src.tileset(source);
    const next = Math.max(1, ...(dst.tilesets as any[]).map(t => t.firstgid + (src.tileset(t.source)?.tilecount ?? 1024)));
    dst.tilesets.push({ firstgid: next, source });
    if (!def) throw new Error(`tileset ${source} not found in the game`);
    return next;
}

function stamp(dst: any, s: Stamp, src: GameSource, fail: (m: string) => void) {
    let from: any;
    try { from = src.tiledMap(s.from); } catch (e) { fail(`stamp: cannot read map ${s.from}: ${(e as Error).message}`); return; }
    const [rx, ry, rw, rh] = s.rect, [ax, ay] = s.at;
    if (rx < 0 || ry < 0 || rx + rw > from.width || ry + rh > from.height) { fail(`stamp: rect ${s.rect} is outside map ${s.from} (${from.width}x${from.height})`); return; }
    if (ax < 0 || ay < 0 || ax + rw > dst.width || ay + rh > dst.height) { fail(`stamp: ${rw}x${rh} at ${s.at} does not fit the ${dst.width}x${dst.height} map`); return; }
    const dstCol = collisionGid(dst), srcCol = collisionGid(from);
    for (const sl of from.layers as any[]) {
        if (sl.type !== 'tilelayer') continue;
        const dl = (dst.layers as any[]).find(l => l.type === 'tilelayer' && l.name === sl.name);
        if (!dl) continue;
        for (let y = 0; y < rh; y++) for (let x = 0; x < rw; x++) {
            const gid = sl.data[(ry + y) * from.width + rx + x] as number;
            const di = (ay + y) * dst.width + ax + x;
            if (isCollisionLayer(sl)) { dl.data[di] = gid ? dstCol + (gid - srcCol) : 0; continue; }
            if (!gid) continue;
            const ref = localRef(from, gid);
            if (!ref) continue;
            dl.data[di] = ensureTileset(dst, ref.source, src) + ref.local;
        }
    }
}

function applyBlocked(dst: any, rows: string[], fail: (m: string) => void) {
    const col = (dst.layers as any[]).find(isCollisionLayer);
    const gid = collisionGid(dst);
    if (!col || !gid) { fail('blocked: the base map has no COLLISION layer / collision tileset'); return; }
    if (rows.length > dst.height) fail(`blocked: ${rows.length} rows but the map is ${dst.height} tall`);
    rows.forEach((row, y) => {
        if ([...row].length > dst.width) fail(`blocked: row ${y} is ${[...row].length} wide but the map is ${dst.width}`);
        [...row].forEach((ch, x) => { if (x < dst.width && y < dst.height) { if (ch === '#') col.data[y * dst.width + x] = gid; else if (ch === '.') col.data[y * dst.width + x] = 0; } });
    });
}

// ------------------------------------------------------------------ events
class Ctx {
    messages: string[] = [];
    constructor(public file: string, public warn: (m: string) => void, public err: (m: string) => void, public src: GameSource, public mapIds: Set<number>) {}
    say(text: string) { this.messages.push(text); return `${this.file}.message_${this.messages.length - 1}`; }
}
type Command = { code: number; indent: number; parameters: unknown[] };

function cond(c: Cond | string, ctx: Ctx): unknown[] {
    if (typeof c === 'string') return [12, c];
    const one = (v: number | number[] | undefined) => (Array.isArray(v) ? v[0] : v);
    if (c.switch !== undefined) return [0, one(c.switch), 0];
    if (c.notSwitch !== undefined) return [0, one(c.notSwitch), 1];
    if (c.variable) return [1, c.variable[0], 0, c.variable[2], OPS[c.variable[1]] ?? 0];
    if (c.self) return [2, c.self, 0];
    if (c.notSelf) return [2, c.notSelf, 1];
    if (c.item !== undefined) return [8, c.item];
    ctx.err('empty condition in {if}'); return [12, 'true'];
}

function compile(cmds: Cmd[] | undefined, indent: number, ctx: Ctx, out: Command[]) {
    const push = (code: number, ...parameters: unknown[]) => out.push({ code, indent, parameters });
    for (const c of cmds ?? []) {
        const k = c as any;
        if ('say' in k) for (const t of ([] as string[]).concat(k.say)) push(356, `ShowMessage ${ctx.say(t)}`);
        else if ('if' in k) {
            push(111, ...cond(k.if, ctx));
            compile(k.then, indent + 1, ctx, out);
            if (k.else?.length) { push(411); compile(k.else, indent + 1, ctx, out); }
            push(412);
        }
        else if ('transfer' in k) {
            const t = k.transfer;
            if (!ctx.mapIds.has(t.map)) ctx.warn(`transfer to map ${t.map}, which is neither a game map nor built by this mod`);
            push(201, 0, t.map, t.x, t.y, t.dir ?? 2, 0);
        }
        else if ('switch' in k) push(121, k.switch, k.switch, k.to === false ? 1 : 0);
        else if ('variable' in k) push(122, k.variable, k.variable, k.op === 'add' ? 1 : k.op === 'sub' ? 2 : 0, 0, k.value);
        else if ('self' in k) push(123, k.self, k.to === false ? 1 : 0);
        else if ('gold' in k) push(125, k.gold < 0 ? 1 : 0, 0, Math.abs(k.gold));
        else if ('item' in k) { const n = k.count ?? 1; push(126, k.item, n < 0 ? 1 : 0, 0, Math.abs(n)); }
        else if ('wait' in k) push(230, k.wait);
        else if ('se' in k) push(250, audio(k.se), 0);
        else if ('bgm' in k) push(241, audio(k.bgm));
        else if ('common' in k) { if (k.common < 1 || k.common > ctx.src.commonEventCount()) ctx.warn(`common event ${k.common} does not exist`); push(117, k.common); }
        else if ('plugin' in k) push(356, k.plugin);
        else if ('script' in k) ([] as string[]).concat(k.script).forEach((line, i) => push(i ? 655 : 355, line));
        else if ('comment' in k) push(108, k.comment);
        else if ('fade' in k) push(k.fade === 'out' ? 221 : 222);
        else if ('erase' in k) push(214);
        else ctx.err(`unknown command ${JSON.stringify(c)}`);
    }
}

function pageCond(c: Cond | undefined, ctx: Ctx, sys: ReturnType<GameSource['systemCounts']>) {
    const o = { actorId: 1, actorValid: false, itemId: 1, itemValid: false, selfSwitchCh: 'A', selfSwitchValid: false, switch1Id: 1, switch1Valid: false, switch2Id: 1, switch2Valid: false, variableId: 1, variableValid: false, variableValue: 0 };
    if (!c) return o;
    const sw = (v: number | number[] | undefined) => ([] as number[]).concat(v ?? []);
    const on = sw(c.switch);
    if (on[0] !== undefined) { o.switch1Id = on[0]; o.switch1Valid = true; }
    if (on[1] !== undefined) { o.switch2Id = on[1]; o.switch2Valid = true; }
    if (c.notSwitch !== undefined) ctx.err('page "if" cannot use notSwitch (RPG Maker pages only test "ON"); use an {if} command inside the page instead');
    if (c.variable) { if (c.variable[1] !== '>=') ctx.err('page "if" variable conditions only support ">=" (RPG Maker limitation)'); o.variableId = c.variable[0]; o.variableValid = true; o.variableValue = c.variable[2]; }
    if (c.self) { o.selfSwitchCh = c.self; o.selfSwitchValid = true; }
    if (c.item !== undefined) { o.itemId = c.item; o.itemValid = true; }
    if (sys) for (const s of on) if (s < 1 || s > sys.switches) ctx.warn(`switch ${s} is outside the game's ${sys.switches} switches`);
    return o;
}

function pageOf(p: PageSpec, ev: EventSpec, ctx: Ctx, sys: ReturnType<GameSource['systemCounts']>) {
    const sprite = p.sprite ?? ev.sprite;
    const sp = typeof sprite === 'string' ? { name: sprite } : sprite;
    if (sp?.name && !ctx.src.assetExists(`img/characters/${sp.name}.png`)) ctx.warn(`sprite "${sp.name}" not found in the game or this mod (img/characters/${sp.name}.png)`);
    const list: Command[] = [];
    compile(p.do, 0, ctx, list);
    list.push({ code: 0, indent: 0, parameters: [] });
    const trig = p.trigger ?? ev.trigger ?? 'action';
    return {
        conditions: pageCond(p.if, ctx, sys),
        directionFix: p.directionFix ?? false,
        image: { tileId: 0, characterName: sp?.name ?? '', direction: sp?.dir ?? 2, pattern: sp?.pattern ?? 1, characterIndex: sp?.index ?? 0 },
        list, moveFrequency: 3,
        moveRoute: { list: [{ code: 0, parameters: [] }], repeat: true, skippable: false, wait: false },
        moveSpeed: 3, moveType: 0,
        priorityType: PRIORITY[p.priority ?? ev.priority ?? (sp?.name ? 'same' : 'below')],
        stepAnime: p.stepAnime ?? false, through: p.through ?? ev.through ?? false,
        trigger: TRIGGERS[trig], walkAnime: p.walkAnime ?? true,
    };
}

const yamlStr = (s: string) => JSON.stringify(s);

// ------------------------------------------------------------------ build
export function validateSpec(spec: MapSpec, fail: (m: string) => void) {
    if (!Number.isInteger(spec.id) || spec.id < 1) fail('id must be a positive integer');
    if (spec.base === undefined && !spec.name) fail('name is required');
    if (spec.base === undefined && !spec.size) fail('size is required (or set "base" to start from an existing map)');
    if (spec.size && (!Array.isArray(spec.size) || spec.size.length !== 2 || spec.size.some(n => !Number.isInteger(n) || n < 5 || n > 300))) fail('size must be [width, height], each 5..300');
}

/** Tiled tileset description for a PNG in the mod: 32px tiles laid out in columns. */
export function tilesetJson(name: string, imageW: number, imageH: number) {
    const columns = Math.floor(imageW / 32), rows = Math.floor(imageH / 32);
    return { columns, image: `../img/tilesets/${name}.png`, imageheight: imageH, imagewidth: imageW, margin: 0, name, spacing: 0, tilecount: columns * rows, tileheight: 32, tiles: {}, tilewidth: 32, type: 'tileset' };
}

function paint(dst: any, p: PaintSpec, src: GameSource, fail: (m: string) => void) {
    const layer = (dst.layers as any[]).find(l => l.type === 'tilelayer' && l.name === p.layer);
    if (!layer) { fail(`paint: no layer "${p.layer}" (layers: ${(dst.layers as any[]).filter(l => l.type === 'tilelayer').map(l => l.name).join(', ')})`); return; }
    if (isCollisionLayer(layer)) { fail('paint: use "blocked" for collision, not paint'); return; }
    const source = p.tileset.endsWith('.json') ? p.tileset : `${p.tileset}.json`;
    const def = src.tileset(source);
    if (!def) { fail(`paint: tileset "${p.tileset}" is not a game tileset or one of this map's "tilesets"`); return; }
    const first = ensureTileset(dst, source, src);
    const put = (x: number, y: number, local: number | null | undefined) => {
        if (local === null || local === undefined || local < 0) return;
        if (local >= def.tilecount) { fail(`paint: tile ${local} is outside ${p.tileset} (it has ${def.tilecount})`); return; }
        if (x < 0 || y < 0 || x >= dst.width || y >= dst.height) { fail(`paint: (${x},${y}) is outside the ${dst.width}x${dst.height} map`); return; }
        layer.data[y * dst.width + x] = first + local;
    };
    if (p.tiles) { const [ax, ay] = p.at ?? [0, 0]; p.tiles.forEach((row, dy) => row.forEach((t, dx) => put(ax + dx, ay + dy, t))); }
    else if (p.tile !== undefined) {
        const [rx, ry, rw, rh] = p.rect ?? [...(p.at ?? [0, 0]), 1, 1];
        for (let y = ry; y < ry + rh; y++) for (let x = rx; x < rx + rw; x++) put(x, y, p.tile);
    } else fail('paint: give either "tile" (+ rect/at) or "tiles" (a grid of local tile ids, null = leave empty)');
}

export function buildMaps(modId: string, specs: MapSpec[], src0: GameSource): Built {
    const errors: string[] = [], warnings: string[] = [];
    const files: Record<string, string> = {};
    const infos: { id: number; name: string }[] = [];
    const game = src0.mapInfos();
    const mapIds = new Set<number>(game.filter(Boolean).map((i: any) => i.id));
    for (const s of specs) mapIds.add(s.id);
    const sys = src0.systemCounts();
    const seen = new Set<number>();

    // Tilesets the mod defines itself are visible to stamp/paint like the game's own.
    const custom = new Map<string, any>();
    const src: GameSource = { ...src0, tileset: s => custom.get(s) ?? src0.tileset(s) };

    for (const spec of specs) {
        const tag = `map ${spec.id}`;
        const err = (m: string) => errors.push(`${tag}: ${m}`), warn = (m: string) => warnings.push(`${tag}: ${m}`);
        const before = errors.length;
        validateSpec(spec, err);
        if (errors.length > before) continue;
        if (seen.has(spec.id)) { err('duplicate id in this mod'); continue; }
        seen.add(spec.id);
        const existing = game[spec.id];
        const editing = spec.base !== undefined && spec.base === spec.id;
        if (existing && !editing) { err(`id ${spec.id} is already used by the game ("${existing.name}"); pick a free id (${Math.max(1000, game.length)}+ is safe), or set "base": ${spec.id} to edit that map`); continue; }
        if (editing && !existing) { err(`"base": ${spec.id} but the game has no map ${spec.id}`); continue; }
        if (editing) warn(`replaces the game's map ${spec.id} ("${existing.name}") as a whole file; another mod that also replaces it will conflict`);

        // custom tilesets declared by this spec
        let bad = false;
        for (const t of spec.tilesets ?? []) {
            const dims = src0.pngSize?.(`img/tilesets/${t.name}.png`);
            if (!dims) { err(`tileset "${t.name}": put the image at files/img/tilesets/${t.name}.png in this mod`); bad = true; continue; }
            if (dims[0] < 32 || dims[1] < 32) { err(`tileset "${t.name}": image is ${dims[0]}x${dims[1]}; tiles are 32x32`); bad = true; continue; }
            const def = tilesetJson(t.name, dims[0], dims[1]);
            custom.set(`${t.name}.json`, def);
            files[`files/maps/${t.name}.json`] = JSON.stringify(def);
        }
        if (bad) continue;

        const from = spec.base ?? spec.tilesFrom ?? 13;
        let base: any, baseData: any;
        try { base = src.tiledMap(from); baseData = src.mapData(from); } catch (e) { err(`${spec.base !== undefined ? 'base' : 'tilesFrom'} ${from}: ${(e as Error).message}`); continue; }
        const tiled = spec.base !== undefined ? clone(base) : newTiledMap(base, spec.size![0], spec.size![1]);
        if (spec.base !== undefined && spec.size && (spec.size[0] !== tiled.width || spec.size[1] !== tiled.height)) warn(`size ${spec.size} ignored: a "base" map keeps its own size (${tiled.width}x${tiled.height})`);
        const w = tiled.width as number, h = tiled.height as number;
        for (const s of spec.stamps ?? []) stamp(tiled, s, src, err);
        for (const p of spec.paint ?? []) paint(tiled, p, src, err);
        if (spec.blocked) applyBlocked(tiled, spec.blocked, err);

        const file = `${modId}_map${spec.id}`;
        const ctx = new Ctx(file, warn, err, src, mapIds);
        const events: any[] = spec.base !== undefined ? clone(baseData.events) : [null];
        for (const rid of spec.removeEvents ?? []) { if (events[rid]) events[rid] = null; else warn(`removeEvents: the map has no event ${rid}`); }
        (spec.events ?? []).forEach(ev => {
            if (ev.x < 0 || ev.y < 0 || ev.x >= w || ev.y >= h) err(`event "${ev.name}" at (${ev.x},${ev.y}) is outside the ${w}x${h} map`);
            const pages = (ev.pages?.length ? ev.pages : [ev]).map(p => pageOf(p, ev, ctx, sys));
            const blockedHere = (tiled.layers as any[]).find(isCollisionLayer)?.data[ev.y * w + ev.x];
            const reach = pages.some(p => p.trigger === 1 || p.trigger === 2) && !pages.every(p => p.through);
            if (blockedHere && reach) warn(`event "${ev.name}" at (${ev.x},${ev.y}) is on a blocked tile, so the player can never step on it (use "map show" to find an open tile)`);
            events.push({ id: events.length, name: ev.name, note: ev.note ?? '', pages, x: ev.x, y: ev.y });
        });

        const data = clone(baseData);
        data.width = w; data.height = h; data.events = events;
        if (spec.base === undefined) { data.displayName = spec.name; data.note = spec.note ?? ''; data.data = new Array(w * h * 6).fill(0); }
        else { if (spec.name) data.displayName = spec.name; if (spec.note !== undefined) data.note = spec.note; }
        if (spec.bgm) { data.bgm = audio(spec.bgm); data.autoplayBgm = true; }

        files[`files/maps/map${spec.id}.json`] = JSON.stringify(tiled);
        files[`files/data/Map${String(spec.id).padStart(3, '0')}.json`] = JSON.stringify(data);
        if (ctx.messages.length) files[`files/languages/en/${file}.yml`] = ctx.messages.map((t, i) => `message_${i}:\n  text: ${yamlStr(t)}\n`).join('\n');
        if (!editing) infos.push({ id: spec.id, name: spec.name! });
    }

    if (infos.length) {
        // MapInfos is an array indexed by id: ids inside the array are tested for "empty", ids past the end are appended in order.
        const ops: unknown[] = [];
        let len = game.length;
        for (const i of [...infos].sort((a, b) => a.id - b.id)) {
            const value = { id: i.id, expanded: false, name: i.name, order: i.id, parentId: 0, scrollX: 0, scrollY: 0, type: 'Name', line: '-' };
            if (i.id < len) ops.push({ op: 'test', path: `/${i.id}`, value: null }, { op: 'replace', path: `/${i.id}`, value });
            else {
                while (len < i.id) { ops.push({ op: 'add', path: `/${len}`, value: null }); len++; }
                ops.push({ op: 'add', path: `/${i.id}`, value }); len++;
            }
        }
        files['patches/data/MapInfos.json.patch.json'] = JSON.stringify(ops, null, 2);
    }
    return { files, infos, errors, warnings };
}

// ------------------------------------------------------------------ preview
/** ASCII picture of a Tiled map: '#' blocked, '.' open and drawn, ' ' open and empty, letters for events. */
export function previewMap(tiled: any, events: { x: number; y: number; name: string }[] = []): string {
    const w = tiled.width as number, h = tiled.height as number;
    const col = (tiled.layers as any[]).find(isCollisionLayer);
    const drawn = (tiled.layers as any[]).filter(l => l.type === 'tilelayer' && !isCollisionLayer(l));
    const grid: string[][] = [];
    for (let y = 0; y < h; y++) {
        const row: string[] = [];
        for (let x = 0; x < w; x++) {
            const i = y * w + x;
            row.push(col?.data[i] ? '#' : drawn.some(l => l.data[i]) ? '.' : ' ');
        }
        grid.push(row);
    }
    const legend: string[] = [];
    events.forEach((e, n) => {
        const ch = n < 26 ? String.fromCharCode(65 + n) : '*';
        if (grid[e.y]?.[e.x] !== undefined) grid[e.y]![e.x] = ch;
        legend.push(`${ch} ${e.name} (${e.x},${e.y})${col?.data[e.y * w + e.x] ? '  [on a blocked tile]' : ''}`);
    });
    const ruler = '    ' + Array.from({ length: w }, (_, x) => (x % 10 === 0 ? String((x / 10) % 10) : ' ')).join('');
    const ones = '    ' + Array.from({ length: w }, (_, x) => String(x % 10)).join('');
    const lines = grid.map((r, y) => `${String(y).padStart(3)} ${r.join('')}`);
    return [`${w}x${h}   # blocked  . open+drawn  (space) open+empty`, ruler, ones, ...lines, ...(legend.length ? ['', ...legend] : [])].join('\n');
}
