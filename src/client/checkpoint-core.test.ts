import { describe, expect, test } from 'bun:test';
import { describeChange, diffDigests, makeDigest, type GameLike } from './checkpoint-core.ts';

const game = (over: Partial<GameLike> = {}): GameLike => ({
    $gameSwitches: { _data: [undefined, true, false, true] },
    $gameVariables: { _data: [undefined, 0, 5, 'x'] },
    $gameSelfSwitches: { _data: { '3,4,A': true, '3,5,A': false } },
    $gameParty: { _gold: 10, _items: { 1: 2, 2: 0 }, _actors: [1, 2] },
    $gameActors: { _data: [null, { _level: 3 }] },
    $gameMap: { _mapId: 7 }, $gamePlayer: { _x: 1, _y: 2 },
    ...over,
});

describe('checkpoint digest', () => {
    test('is sparse and tolerates a half-started game', () => {
        const d = makeDigest(game());
        expect(d.switches).toEqual([1, 3]);
        expect(d.variables).toEqual({ 2: 5, 3: 'x' });
        expect(d.selfSwitches).toEqual({ '3,4,A': true });
        expect(d.items).toEqual({ 1: 2 });
        expect(d.levels).toEqual({ 1: 3 });
        expect(() => makeDigest({})).not.toThrow();
    });
    test('diff finds exactly the changes', () => {
        const a = makeDigest(game());
        const b = makeDigest(game({
            $gameSwitches: { _data: [undefined, true, true] },
            $gameParty: { _gold: 15, _items: { 1: 2, 4: 1 }, _actors: [1] },
        }));
        const lines = diffDigests(a, b).map(c => describeChange(c, { switches: ['', 'A', 'Door open'] }));
        expect(lines).toContain('switch 2 Door open: ON');
        expect(lines).toContain('switch 3: off');
        expect(lines).toContain('gold: 10 -> 15');
        expect(lines).toContain('item 4: none -> 1');
        expect(diffDigests(a, a)).toEqual([]);
    });
});
