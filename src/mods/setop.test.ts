import { describe, expect, test } from 'bun:test';
import { applyJsonPatch } from './patch.ts';

const base = () => Array.from({ length: 3 }, (_, i) => ({ id: i }));
const entry = (id: number) => ({ id, name: `map ${id}` });

describe('set op (registration by id)', () => {
    test('assigns a slot past the end, padding with null, and does not shift anything', () => {
        const out: any = applyJsonPatch(base(), [{ op: 'set', path: '/5', value: entry(5) }]);
        expect(out.length).toBe(6);
        expect(out[5]).toEqual(entry(5));
        expect(out[3]).toBeNull();
        expect(out[0]).toEqual({ id: 0 });
    });
    test('two mods setting different slots give the same array in either order', () => {
        const modA = [{ op: 'set', path: '/1300', value: entry(1300) }];
        const modB = [{ op: 'set', path: '/1000', value: entry(1000) }, { op: 'set', path: '/1206', value: entry(1206) }];
        const ab = applyJsonPatch(applyJsonPatch(base(), modA), modB);
        const ba = applyJsonPatch(applyJsonPatch(base(), modB), modA);
        expect(JSON.stringify(ab)).toBe(JSON.stringify(ba));
        expect((ab as any)[1300]).toEqual(entry(1300));
        expect((ab as any)[1206]).toEqual(entry(1206));
    });
    test('set on an object key assigns it', () => {
        expect(applyJsonPatch({ a: 1 } as any, [{ op: 'set', path: '/b', value: 2 }])).toEqual({ a: 1, b: 2 } as any);
    });
    test('add into an array still inserts (RFC 6902 is unchanged)', () => {
        const out: any = applyJsonPatch(base(), [{ op: 'add', path: '/0', value: { id: 'new' } }]);
        expect(out.length).toBe(4);
        expect(out[0]).toEqual({ id: 'new' });
        expect(out[1]).toEqual({ id: 0 });
    });
    test('the old add-based registration does shift: the reason for set', () => {
        const a = applyJsonPatch(base(), [{ op: 'add', path: '/0', value: null }]);
        const b = applyJsonPatch(a, [{ op: 'add', path: '/1', value: entry(9) }]);
        expect((b as any)[1]).toEqual(entry(9));
        expect((b as any)[2]).toEqual({ id: 0 });
    });
});
