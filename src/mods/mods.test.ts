import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { WWW, readGameKey } from '../gamedir.ts';
import { ModEngine } from './engine.ts';
import { loadMod, targetOf } from './manifest.ts';
import { PatchError, applyJsonPatch, applyMergePatch, applyTextPatch } from './patch.ts';
import { memTree, treeToZip, zipTreeFromBytes } from './vfs.ts';

const te = new TextEncoder(), td = new TextDecoder();
const tree = (files: Record<string, string>) => memTree(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, te.encode(v)])));

describe('json patch', () => {
    test('add/replace/remove/move/copy/test', () => {
        const out = applyJsonPatch({ a: [1, 2], b: { c: 1 } }, [
            { op: 'add', path: '/a/1', value: 9 }, { op: 'replace', path: '/b/c', value: 2 },
            { op: 'copy', from: '/b', path: '/d' }, { op: 'move', from: '/a/0', path: '/e' }, { op: 'remove', path: '/b' }, { op: 'test', path: '/d/c', value: 2 },
        ]);
        expect(out).toEqual({ a: [9, 2], d: { c: 2 }, e: 1 });
    });
    test('errors name the op and path', () => {
        expect(() => applyJsonPatch({}, [{ op: 'replace', path: '/x/y', value: 1 }])).toThrow(/op #0 \(replace \/x\/y\)/);
        expect(() => applyJsonPatch({}, [{ op: 'test', path: '', value: 1 }])).toThrow(PatchError);
        expect(() => applyJsonPatch([1], [{ op: 'remove', path: '/5' }])).toThrow(/out of range/);
    });
    test('does not mutate its input', () => {
        const src = { a: 1 };
        applyJsonPatch(src, [{ op: 'replace', path: '/a', value: 2 }]);
        expect(src.a).toBe(1);
    });
});

test('merge patch', () => {
    expect(applyMergePatch({ a: { b: 1, c: 2 }, d: 1 }, { a: { b: null, e: 3 }, d: 2 })).toEqual({ a: { c: 2, e: 3 }, d: 2 });
});

describe('text patch', () => {
    test('replaces and reports misses', () => {
        expect(applyTextPatch('a b a', [{ find: 'a', replace: 'x', all: true }])).toBe('x b x');
        expect(applyTextPatch('v = 1', [{ find: '\\d', replace: '2', regex: true }])).toBe('v = 2');
        expect(() => applyTextPatch('abc', [{ find: 'zzz', replace: '' }])).toThrow(/text not found/);
        expect(applyTextPatch('abc', [{ find: 'zzz', replace: '', optional: true }])).toBe('abc');
    });
});

describe('manifests', () => {
    test('target mapping', () => {
        expect(targetOf('data/Items.json').game).toBe('data/Items.KEL');
        expect(targetOf('maps/map5.json').game).toBe('maps/map5.AUBREY');
        expect(targetOf('languages/en/x.yml').game).toBe('languages/en/x.HERO');
        expect(targetOf('js/plugins/A.js')).toMatchObject({ game: 'js/plugins/A.OMORI', fmt: 'text' });
        expect(targetOf('img/pictures/a.png')).toMatchObject({ game: 'img/pictures/a.rpgmvp', crypt: 'rpg' });
    });
    test('native: convention folders and typo warnings', () => {
        const m = loadMod(tree({ 'mod.json': '{"id":"t-mod","name":"T","depends":[]}', 'files/data/Items.json': '[]', 'patches/js/plugins/A.js.patch.json': '[]', 'scripts/main.js': '' }), 'x');
        expect(m.errors).toEqual([]);
        expect(m.warnings.join()).toContain('"depends"');
        expect(m.edits.map(e => `${e.kind}:${e.target}`).sort()).toEqual(['replace:data/Items.KEL', 'text:js/plugins/A.OMORI']);
        expect(m.scripts).toEqual([{ file: 'scripts/main.js', phase: 'post-plugins', style: 'classic' }]);
    });
    test('native: bad id, missing and malformed mod.json are errors', () => {
        expect(loadMod(tree({ 'mod.json': '{"id":"Bad Id","name":"x"}' }), 'x').errors[0]).toContain('"id" must match');
        expect(loadMod(tree({}), 'x').errors[0]).toContain('missing mod.json');
        expect(loadMod(tree({ 'mod.json': '{' }), 'x').errors[0]).toContain('not valid JSON');
    });
});

describe('engine', () => {
    const key = '0123456789abcdef0123456789abcdef';
    const mk = () => new ModEngine(() => key);
    const modTree = (id: string, files: Record<string, string> = {}, extra = '') => tree({ 'mod.json': `{"id":"${id}","name":"${id}"${extra}}`, ...files });

    test('encrypt/decrypt round trip', () => {
        const x = mk(), plain = te.encode('{"hello":"world"}'), enc = x.encrypt(plain);
        expect(enc.length).toBe(plain.length + 16);
        expect(td.decode(x.decrypt(enc))).toBe('{"hello":"world"}');
    });

    test('patches an encrypted file and re-encrypts; a failing mod is skipped and reported', () => {
        const x = mk();
        const base = x.encrypt(te.encode(JSON.stringify([null, { name: 'A' }])));
        x.load([
            { label: 'good', tree: modTree('good-mod', { 'patches/data/T.json.patch.json': '[{"op":"replace","path":"/1/name","value":"B"}]' }) },
            { label: 'bad', tree: modTree('bad-mod', { 'patches/data/T.json.patch.json': '[{"op":"remove","path":"/9"}]' }) },
        ]);
        const out = x.resolve('data/T.KEL', () => base)!;
        expect(JSON.parse(td.decode(x.decrypt(out)))[1].name).toBe('B');
        expect(x.diagnostics.some(d => d.level === 'error' && d.mod === 'bad-mod')).toBe(true);
    });

    test('dependencies order mods and disable orphans', () => {
        const x = mk();
        x.load([
            { label: 'b', tree: modTree('b-mod', {}, ',"dependencies":["a-mod"]') },
            { label: 'a', tree: modTree('a-mod') },
            { label: 'c', tree: modTree('c-mod', {}, ',"dependencies":["missing-mod"]') },
        ]);
        expect(x.activeMods().map(v => v.id)).toEqual(['a-mod', 'b-mod']);
        expect(x.mods.find(v => v.id === 'c-mod')!.enabled).toBe(false);
    });

    test('a later full replace wins and the conflict is logged', () => {
        const x = mk();
        x.load([
            { label: 'a', tree: modTree('a-mod', { 'files/img/a.txt': 'one' }) },
            { label: 'b', tree: modTree('b-mod', { 'files/img/a.txt': 'two' }) },
        ]);
        expect(td.decode(x.resolve('img/a.txt', () => null)!)).toBe('two');
        expect(x.diagnostics.some(d => d.level === 'warn' && /last one wins/.test(d.message))).toBe(true);
    });

    test('user-disabled mods do not apply', () => {
        const x = mk();
        x.load([{ label: 'a', tree: modTree('a-mod', { 'files/img/a.txt': 'one' }), disabled: true }]);
        expect(x.hasEdits('img/a.txt')).toBe(false);
    });

    test('zip round trip strips a wrapping folder', () => {
        const t = zipTreeFromBytes(treeToZip(tree({ 'wrap/mod.json': '{}', 'wrap/files/a.txt': 'x' })));
        expect([...t.files].sort()).toEqual(['files/a.txt', 'mod.json']);
    });

    const realKey = existsSync(join(WWW, 'data', 'Items.KEL')) ? readGameKey() : null;
    test.skipIf(!realKey)('decrypts the real game data', () => {
        const x = new ModEngine(() => realKey);
        const items = JSON.parse(td.decode(x.decrypt(new Uint8Array(readFileSync(join(WWW, 'data', 'Items.KEL'))))));
        expect(items[2].name).toBe('COLD STEAK');
    });
});
