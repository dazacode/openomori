// The same mod must load the same way on Windows and macOS: file order, Finder litter, NFD names, symlinks.
import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dirTree } from './vfs-node.ts';
import { comparePaths, isOsJunk, memTree, treeFromEntries, treeToZip, zipTreeFromBytes } from './vfs.ts';
import { loadMod } from './manifest.ts';

const bytes = (s: string) => new TextEncoder().encode(s);
const folder = (files: Record<string, string>) => {
    const d = mkdtempSync(join(tmpdir(), 'omori-vfs-'));
    for (const [p, v] of Object.entries(files)) { mkdirSync(join(d, p, '..'), { recursive: true }); writeFileSync(join(d, p), v); }
    return d;
};

describe('mod file order is the same on every OS', () => {
    test('a folder lists in Windows order, whatever order the disk returns', () => {
        const d = folder({ 'scripts/part10.js': '', 'scripts/00_parts.js': '', 'scripts/part5.js': '', 'scripts/Main.js': '', 'mod.json': '{}', 'patches/data/X.json.patch.json': '[]', 'files/data/X.json': '{}' });
        expect(dirTree(d).files).toEqual(['files/data/X.json', 'mod.json', 'patches/data/X.json.patch.json', 'scripts/00_parts.js', 'scripts/Main.js', 'scripts/part10.js', 'scripts/part5.js']);
    });
    test('a folder entry sorts before a same-named file, as in a recursive walk', () => {
        expect(['a.js', 'a/b.js', 'B.js'].sort(comparePaths)).toEqual(['a/b.js', 'a.js', 'B.js']);
    });
    test('zips and dropped folders get the same order as a folder on disk', () => {
        const t = memTree({ 'scripts/z.js': bytes(''), 'scripts/a.js': bytes(''), 'mod.json': bytes('{}') });
        expect(t.files).toEqual(['mod.json', 'scripts/a.js', 'scripts/z.js']);
        expect(zipTreeFromBytes(treeToZip(t)).files).toEqual(t.files);
    });
    test('native scripts with no "scripts" list run in that order', () => {
        const m = loadMod(memTree({ 'mod.json': bytes('{"id":"tt","name":"T","version":"1"}'), 'scripts/part5.js': bytes(''), 'scripts/main.js': bytes(''), 'scripts/00_parts.js': bytes('') }), 't');
        expect(m.scripts.map(s => s.file)).toEqual(['scripts/00_parts.js', 'scripts/main.js', 'scripts/part5.js']);
    });
});

describe('operating-system litter is never mod content', () => {
    test('Finder, AppleDouble and Windows thumbnail files are recognised', () => {
        for (const p of ['.DS_Store', 'files/.DS_Store', 'scripts/._main.js', '__MACOSX/scripts/main.js', 'Icon\r', 'img/Thumbs.db', 'desktop.ini']) expect(isOsJunk(p)).toBe(true);
        for (const p of ['scripts/main.js', 'files/img/_hidden.png', 'files/.keep', 'mod.json']) expect(isOsJunk(p)).toBe(false);
    });
    test('they are dropped from folders, zips and drops alike', () => {
        const files = { 'mod.json': '{"id":"tt","name":"T","version":"1"}', 'scripts/main.js': '', 'scripts/._main.js': '\0\x05\x16\x07', '.DS_Store': 'x', 'files/languages/en/._a.yml': 'x' };
        expect(dirTree(folder(files)).files).toEqual(['mod.json', 'scripts/main.js']);
        const raw = Object.fromEntries(Object.entries(files).map(([k, v]) => [k, bytes(v)]));
        expect(treeFromEntries(raw).files).toEqual(['mod.json', 'scripts/main.js']);
        expect(loadMod(memTree(raw), 't').scripts.map(s => s.file)).toEqual(['scripts/main.js']);
    });
});

describe('file names and links from macOS', () => {
    test('NFD names (as macOS tools may write them) match the NFC names mod.json uses', () => {
        const nfd = 'scripts/café.js';
        const t = memTree({ 'mod.json': bytes('{"id":"tt","name":"T","version":"1","scripts":["scripts/café.js"]}'), [nfd]: bytes('ok') });
        expect(t.files).toContain('scripts/café.js');
        expect(loadMod(t, 't').errors).toEqual([]);
        const d = folder({ [nfd]: 'ok' });
        const dt = dirTree(d);
        expect(new TextDecoder().decode(dt.read('scripts/café.js'))).toBe('ok');
    });
    test('a symlinked folder inside a mod is followed; broken links and loops are skipped', () => {
        const shared = folder({ 'img/a.png': 'png' });
        const d = folder({ 'mod.json': '{}' });
        symlinkSync(join(shared, 'img'), join(d, 'files'));
        symlinkSync(join(d, 'nowhere'), join(d, 'broken'));
        symlinkSync(d, join(d, 'loop'));
        const t = dirTree(d);
        expect(t.files).toEqual(['files/a.png', 'mod.json']);
        expect(new TextDecoder().decode(t.read('files/a.png'))).toBe('png');
        expect(() => treeToZip(t)).not.toThrow();
    });
});
