import { describe, expect, test } from 'bun:test';
// @ts-expect-error plain JS module shared with the browser
import { blockedToGrid, clearOverridesIn, remapOverrides, decodeOverrides, docFromSpec, encodeOverrides, freeId, gridToBlocked, layerLabel, newOverrides, setOverride, toSpec } from './public/spec.js';
import { buildMaps, type GameSource } from '../src/mods/mapkit.ts';

const W = 10;
const T = (local: number, ts = 'A.json') => ({ ts, local });

describe('editor spec helpers', () => {
    test('overrides round-trip through paint entries, merging runs and stacked rows', () => {
        const ov = newOverrides();
        for (let x = 2; x < 5; x++) for (let y = 1; y < 3; y++) setOverride(ov, 'GROUND - I', y * W + x, T(x + y));
        setOverride(ov, 'GROUND - I', 7 * W + 7, T(9, 'B.json'));
        setOverride(ov, 'ABOVE ALL - I', 0, 'erase');
        setOverride(ov, 'ABOVE ALL - I', 1, 'erase');
        const paint = encodeOverrides(ov, W);
        expect(paint.length).toBe(3);                                   // one 3x2 grid, one single tile, one erase run
        expect(paint.every((p: any) => p.editor === true)).toBe(true);
        expect(paint.find((p: any) => p.tiles?.length === 2).tiles).toEqual([[3, 4, 5], [4, 5, 6]]);
        const { authored, ov: back } = decodeOverrides(paint, W);
        expect(authored).toEqual([]);
        expect([...back['GROUND - I']!.entries()].sort((a, b) => a[0] - b[0])).toEqual([...ov['GROUND - I']!.entries()].sort((a, b) => a[0] - b[0]));
        expect([...back['ABOVE ALL - I']!.keys()]).toEqual([0, 1]);
    });
    test('hand-written paint entries are kept as they are and come first', () => {
        const hand = { layer: 'GROUND - I', tileset: 'A', tile: 3, rect: [0, 0, 2, 2] };
        const doc = docFromSpec({ id: 1001, name: 'x', size: [W, 5], paint: [hand] }, W, 5);
        setOverride(doc.ov, 'GROUND - I', 11, T(8));
        const spec = toSpec(doc);
        expect(spec.paint[0]).toEqual(hand);
        expect(spec.paint[1]).toMatchObject({ tileset: 'A', tiles: [[8]], at: [1, 1], editor: true });
        // saving and loading again does not duplicate or change anything
        const again = toSpec(docFromSpec(spec, W, 5));
        expect(again.paint).toEqual(spec.paint);
    });
    test('collision grid: only # and . are written, blanks mean "leave alone", trailing blanks are trimmed', () => {
        const g = blockedToGrid(['#.#', '', '  #'], 5, 4);
        expect(g[0]!.join('')).toBe('#.#  ');
        g[3]![4] = '#';
        expect(gridToBlocked(g)).toEqual(['#.#', '', '  #', '    #']);
        expect(gridToBlocked(blockedToGrid([], 5, 4))).toEqual([]);
    });
    test('placing a stamp forgets overrides under it', () => {
        const ov = newOverrides();
        setOverride(ov, 'GROUND - I', 0, T(1)); setOverride(ov, 'GROUND - I', 5 * W + 5, T(1));
        clearOverridesIn(ov, W, [0, 0, 3, 3]);
        expect([...ov['GROUND - I']!.keys()]).toEqual([5 * W + 5]);
    });
    test('resizing re-keys overrides by position and drops the ones that fall outside', () => {
        const ov = newOverrides();
        setOverride(ov, 'GROUND - I', 2 * 10 + 3, T(1));      // (3, 2) in a map 10 wide
        setOverride(ov, 'GROUND - I', 4 * 10 + 9, T(2));      // (9, 4)
        remapOverrides(ov, 10, 6, 5);                         // now 6 wide: (9, 4) no longer fits
        expect([...ov['GROUND - I']!.entries()]).toEqual([[2 * 6 + 3, T(1)]]);
        remapOverrides(ov, 6, 12, 5);
        expect([...ov['GROUND - I']!.keys()]).toEqual([2 * 12 + 3]);
    });
    test('layer labels and free ids', () => {
        expect(layerLabel('GROUND - III')).toBe('Ground 3');
        expect(layerLabel('ABOVE ALL - IV')).toBe('Above 4');
        expect(layerLabel('same as character')).toBe('With characters');
        expect(layerLabel('GROUND- IV')).toBe('Ground 4');                        // SUNBURN's spacing
        expect(layerLabel('SAME AS CHARACTER - I')).toBe('With characters 1');
        expect(freeId(new Set([1000, 1001]))).toBe(1002);
    });
    test('what the editor emits compiles: painted, erased and walled cells land in the map', () => {
        const layer = (name: string, data?: number[]) => ({ type: 'tilelayer', name, width: 6, height: 5, data: data ?? new Array(30).fill(0), opacity: 1, visible: true, x: 0, y: 0 });
        const base = { width: 6, height: 5, tilewidth: 32, tileheight: 32, tilesets: [{ firstgid: 1, source: 'Tile_Collisions_32x32.json' }, { firstgid: 25, source: 'A.json' }],
            layers: [layer('GROUND - I', new Array(30).fill(26)), layer('COLLISION')] };
        const src: GameSource = { tiledMap: () => base, mapData: () => ({ width: 6, height: 5, events: [null], data: [] }), mapInfos: () => [null], tileset: s => (s === 'A.json' ? { tilecount: 64 } : s === 'Tile_Collisions_32x32.json' ? { tilecount: 24 } : null) as any,
            commonEventCount: () => 1, systemCounts: () => null, assetExists: () => true };
        const doc = docFromSpec({ id: 1001, name: 'n', size: [6, 5], tilesFrom: 1, stamps: [{ from: 1, rect: [0, 0, 6, 5], at: [0, 0] }] }, 6, 5);
        setOverride(doc.ov, 'GROUND - I', 0, T(40)); setOverride(doc.ov, 'GROUND - I', 1, 'erase');
        doc.blocked[2]![3] = '#';
        const b = buildMaps('m', [toSpec(doc)], src);
        expect(b.errors).toEqual([]);
        const t = JSON.parse(b.files['files/maps/map1001.json']!);
        expect([t.layers[0].data[0], t.layers[0].data[1], t.layers[0].data[2]]).toEqual([25 + 40, 0, 26]);
        expect(t.layers[1].data[2 * 6 + 3]).toBe(1);
    });
});
