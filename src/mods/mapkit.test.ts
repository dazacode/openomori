import { describe, expect, test } from 'bun:test';
import { buildMaps, previewMap, type GameSource, type MapSpec } from './mapkit.ts';

const layer = (name: string, w: number, h: number, data?: number[]) => ({ type: 'tilelayer', name, width: w, height: h, data: data ?? new Array(w * h).fill(0), opacity: 1, visible: true, x: 0, y: 0 });
// Source map 1: collision tileset first (gid 1), art tileset "A" at gid 25. Source map 2 has a different tileset order.
const map1 = { width: 6, height: 4, tilewidth: 32, tileheight: 32, tilesets: [{ firstgid: 1, source: 'Tile_Collisions_32x32.json' }, { firstgid: 25, source: 'A.json' }],
    layers: [layer('GROUND - I', 6, 4, Array.from({ length: 24 }, (_, i) => 25 + i)), layer('COLLISION', 6, 4, Array.from({ length: 24 }, (_, i) => (i % 6 === 0 ? 1 : 0)))] };
const map2 = { width: 4, height: 4, tilewidth: 32, tileheight: 32, tilesets: [{ firstgid: 1, source: 'B.json' }, { firstgid: 101, source: 'Tile_Collisions_32x32.json' }],
    layers: [layer('GROUND - I', 4, 4, new Array(16).fill(7)), layer('COLLISION', 4, 4, new Array(16).fill(101))] };
const data = { width: 6, height: 4, displayName: 'x', note: 'n', bgm: { name: '', volume: 90, pitch: 100, pan: 0 }, tilesetId: 1, data: new Array(6 * 4 * 6).fill(5), events: [null, { id: 1, name: 'orig', pages: [], x: 0, y: 0 }, { id: 2, name: 'gone', pages: [], x: 1, y: 1 }] };

const src = (over: Partial<GameSource> = {}): GameSource => ({
    tiledMap: id => ({ 1: map1, 2: map2 } as any)[id] ?? (() => { throw new Error('no such map'); })(),
    mapData: () => data,
    mapInfos: () => [null, { id: 1, name: 'one' }, { id: 2, name: 'two' }],
    tileset: s => ({ 'A.json': { tilecount: 64 }, 'B.json': { tilecount: 64 }, 'Tile_Collisions_32x32.json': { tilecount: 24 } } as any)[s] ?? null,
    commonEventCount: () => 10, systemCounts: () => ({ switches: 50, variables: 50 }),
    assetExists: rel => rel === 'img/characters/NPC.png',
    pngSize: rel => (rel === 'img/tilesets/MINE.png' ? [96, 64] : null),
    ...over,
});
const spec = (o: Partial<MapSpec> = {}): MapSpec => ({ id: 1001, name: 'New', size: [8, 6], tilesFrom: 1, ...o });
const parse = (b: ReturnType<typeof buildMaps>, f: string) => JSON.parse(b.files[f]!);

describe('mapkit', () => {
    test('builds the four files and registers the map', () => {
        const b = buildMaps('m', [spec({ events: [{ name: 'a', x: 1, y: 1, sprite: 'NPC', do: [{ say: 'hi' }] }] })], src());
        expect(b.errors).toEqual([]);
        expect(Object.keys(b.files).sort()).toEqual(['files/data/Map1001.json', 'files/languages/en/m_map1001.yml', 'files/maps/map1001.json', 'patches/data/MapInfos.json.patch.json']);
        const t = parse(b, 'files/maps/map1001.json');
        expect([t.width, t.height, t.layers[0].data.length]).toEqual([8, 6, 48]);
        expect(parse(b, 'files/data/Map1001.json').data.length).toBe(8 * 6 * 6);
        expect(b.files['files/languages/en/m_map1001.yml']).toContain('message_0:\n  text: "hi"');
        const ops = parse(b, 'patches/data/MapInfos.json.patch.json');
        expect(ops.at(-1)).toMatchObject({ op: 'add', path: '/1001' });
        expect(ops.filter((o: any) => o.path !== '/1001').every((o: any) => o.value === null)).toBe(true); // padded gap
    });
    test('refuses ids the game already uses, and bad shapes', () => {
        expect(buildMaps('m', [spec({ id: 2 })], src()).errors[0]).toMatch(/already used by the game/);
        expect(buildMaps('m', [spec({ size: [2, 2] })], src()).errors[0]).toMatch(/size/);
        expect(buildMaps('m', [spec(), spec()], src()).errors.join()).toMatch(/duplicate/);
    });
    test('stamp remaps gids across different tileset layouts and keeps collision', () => {
        const b = buildMaps('m', [spec({ stamps: [{ from: 2, rect: [0, 0, 2, 2], at: [3, 3] }] })], src());
        expect(b.errors).toEqual([]);
        const t = parse(b, 'files/maps/map1001.json');
        const b1 = t.tilesets.find((x: any) => x.source === 'B.json');
        expect(b1.firstgid).toBeGreaterThanOrEqual(25 + 64);                       // appended after the existing tilesets
        expect(t.layers[0].data[3 * 8 + 3]).toBe(b1.firstgid + 6);                 // local id 7-1 preserved
        expect(t.layers[1].data[3 * 8 + 3]).toBe(1);                               // collision: src gid 101 -> dst collision gid 1
        expect(t.layers[1].data[0]).toBe(0);
    });
    test('stamp rectangles are bounds-checked', () => {
        expect(buildMaps('m', [spec({ stamps: [{ from: 2, rect: [0, 0, 9, 9], at: [0, 0] }] })], src()).errors[0]).toMatch(/outside map 2/);
        expect(buildMaps('m', [spec({ stamps: [{ from: 2, rect: [0, 0, 4, 4], at: [6, 0] }] })], src()).errors[0]).toMatch(/does not fit/);
    });
    test('blocked ascii sets and clears collision', () => {
        const t = parse(buildMaps('m', [spec({ blocked: ['#.#'] })], src()), 'files/maps/map1001.json');
        expect(t.layers[1].data.slice(0, 3)).toEqual([1, 0, 1]);
    });
    test('commands compile with correct codes and nesting', () => {
        const b = buildMaps('m', [spec({ events: [{ name: 'e', x: 1, y: 1, do: [
            { switch: 3 }, { variable: 4, op: 'add', value: 2 }, { gold: -5 }, { item: 2, count: 3 },
            { if: { variable: [4, '>=', 2] }, then: [{ say: 'a' }], else: [{ self: 'B', to: false }] },
            { transfer: { map: 1, x: 2, y: 3 } }, { script: ['a();', 'b();'] },
        ] }] })], src());
        expect(b.errors).toEqual([]);
        const list = parse(b, 'files/data/Map1001.json').events[1].pages[0].list as { code: number; indent: number; parameters: unknown[] }[];
        expect(list.map(c => c.code)).toEqual([121, 122, 125, 126, 111, 356, 411, 123, 412, 201, 355, 655, 0]);
        expect(list[0]!.parameters).toEqual([3, 3, 0]);
        expect(list[1]!.parameters).toEqual([4, 4, 1, 0, 2]);
        expect(list[2]!.parameters).toEqual([1, 0, 5]);
        expect(list[5]!.indent).toBe(1);
        expect(list[5]!.parameters).toEqual(['ShowMessage m_map1001.message_0']);
        expect(list[9]!.parameters).toEqual([0, 1, 2, 3, 2, 0]);
    });
    test('pages: conditions, triggers, and the limits RPG Maker has', () => {
        const b = buildMaps('m', [spec({ events: [{ name: 'e', x: 1, y: 1, pages: [{ do: [] }, { if: { self: 'A', switch: [5, 6] }, trigger: 'auto', do: [] }] }] })], src());
        const pages = parse(b, 'files/data/Map1001.json').events[1].pages;
        expect(pages[1].conditions).toMatchObject({ selfSwitchValid: true, selfSwitchCh: 'A', switch1Id: 5, switch1Valid: true, switch2Id: 6, switch2Valid: true });
        expect(pages[1].trigger).toBe(3);
        const bad = buildMaps('m', [spec({ events: [{ name: 'e', x: 1, y: 1, pages: [{ if: { notSwitch: 2 }, do: [] }] }] })], src());
        expect(bad.errors.join()).toMatch(/notSwitch/);
    });
    test('warns about unreachable touch events, unknown sprites, bad transfers and common events', () => {
        const b = buildMaps('m', [spec({ blocked: ['#'], events: [
            { name: 'door', x: 0, y: 0, trigger: 'touch', do: [{ transfer: { map: 99999, x: 0, y: 0 } }, { common: 99 }] },
            { name: 'npc', x: 3, y: 3, sprite: 'MISSING', do: [] },
        ] })], src());
        const w = b.warnings.join('\n');
        expect(w).toMatch(/door.*blocked tile/);
        expect(w).toMatch(/map 99999/);
        expect(w).toMatch(/common event 99/);
        expect(w).toMatch(/MISSING/);
        expect(b.errors).toEqual([]);
    });
    test('events outside the map are errors', () => {
        expect(buildMaps('m', [spec({ events: [{ name: 'e', x: 8, y: 0, do: [] }] })], src()).errors[0]).toMatch(/outside/);
    });
    test('preview marks blocked tiles and events', () => {
        const t = parse(buildMaps('m', [spec({ blocked: ['#'] })], src()), 'files/maps/map1001.json');
        const p = previewMap(t, [{ x: 0, y: 0, name: 'door' }, { x: 2, y: 2, name: 'npc' }]);
        expect(p).toContain('A door (0,0)  [on a blocked tile]');
        expect(p).toContain('B npc (2,2)');
    });

    test('custom tilesets: json is generated from the PNG size and paint uses it', () => {
        const b = buildMaps('m', [spec({ tilesets: [{ name: 'MINE' }], paint: [{ layer: 'GROUND - I', tileset: 'MINE', tiles: [[0, null], [3, 5]], at: [1, 1] }] })], src());
        expect(b.errors).toEqual([]);
        const ts = parse(b, 'files/maps/MINE.json');
        expect([ts.columns, ts.tilecount, ts.image]).toEqual([3, 6, '../img/tilesets/MINE.png']);
        const t = parse(b, 'files/maps/map1001.json');
        const first = t.tilesets.find((x: any) => x.source === 'MINE.json').firstgid;
        const L = t.layers[0].data;
        expect([L[1 * 8 + 1], L[1 * 8 + 2], L[2 * 8 + 1], L[2 * 8 + 2]]).toEqual([first, 0, first + 3, first + 5]);
    });
    test('paint and tileset errors are specific', () => {
        const e = (o: Partial<MapSpec>) => buildMaps('m', [spec(o)], src()).errors.join('|');
        expect(e({ tilesets: [{ name: 'NOPE' }] })).toMatch(/files\/img\/tilesets\/NOPE\.png/);
        expect(e({ paint: [{ layer: 'NOPE', tileset: 'A', tile: 0 }] })).toMatch(/no layer "NOPE"/);
        expect(e({ paint: [{ layer: 'COLLISION', tileset: 'A', tile: 0 }] })).toMatch(/use "blocked"/);
        expect(e({ paint: [{ layer: 'GROUND - I', tileset: 'ZZZ', tile: 0 }] })).toMatch(/not a game tileset/);
        expect(e({ tilesets: [{ name: 'MINE' }], paint: [{ layer: 'GROUND - I', tileset: 'MINE', tile: 6 }] })).toMatch(/tile 6 is outside MINE \(it has 6\)/);
        expect(e({ paint: [{ layer: 'GROUND - I', tileset: 'A', tile: 1, rect: [7, 5, 3, 1] }] })).toMatch(/outside the 8x6 map/);
        expect(e({ paint: [{ layer: 'GROUND - I', tileset: 'A' }] })).toMatch(/either "tile"/);
    });
    test('base: editing a game map in place keeps events and data, adds and removes events, writes no MapInfos', () => {
        const b = buildMaps('m', [{ id: 1, base: 1, removeEvents: [2], events: [{ name: 'new', x: 2, y: 2, do: [] }] }], src({ mapInfos: () => [null, { id: 1, name: 'one' }] }));
        expect(b.errors).toEqual([]);
        expect(b.warnings.join()).toMatch(/replaces the game's map 1/);
        const d = parse(b, 'files/data/Map001.json');
        expect(d.events.map((e: any) => e && e.name)).toEqual([null, 'orig', null, 'new']);
        expect(d.events[3].id).toBe(3);
        expect(d.data.every((v: number) => v === 5)).toBe(true);   // tile data untouched
        expect(d.displayName).toBe('x');
        expect(b.files['patches/data/MapInfos.json.patch.json']).toBeUndefined();
        expect(parse(b, 'files/maps/map1.json').width).toBe(6);
    });
    test('base: clone-and-extend under a new id; a base that is a different existing id still needs a free id', () => {
        const b = buildMaps('m', [spec({ id: 1002, base: 1, name: 'Copy', events: [{ name: 'n', x: 0, y: 0, do: [] }] })], src());
        expect(b.errors).toEqual([]);
        expect(parse(b, 'files/data/Map1002.json').events.map((e: any) => e && e.name)).toEqual([null, 'orig', 'gone', 'n']);
        expect(buildMaps('m', [spec({ id: 2, base: 1 })], src()).errors[0]).toMatch(/already used by the game/);
        expect(buildMaps('m', [{ id: 9 } as MapSpec], src()).errors.join()).toMatch(/name is required/);
    });
});
