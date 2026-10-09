import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { isGameDir, normalizeGameDir } from './gamedir.ts';

describe('game folder detection', () => {
    const make = (...parts: string[]) => { const d = mkdtempSync(join(tmpdir(), 'omori-gd-')); for (const p of parts) mkdirSync(join(d, p), { recursive: true }); return d; };

    test('a real install has www/data and www/js', () => {
        expect(isGameDir(make('www/data', 'www/js'))).toBe(true);
        expect(isGameDir(make('www/data'))).toBe(false);
        expect(isGameDir(make())).toBe(false);
        expect(isGameDir(join(tmpdir(), 'definitely-not-here-omori'))).toBe(false);
    });

    test('pasted paths are cleaned up: quotes, trailing slashes, and the www folder itself', () => {
        const d = make('www/data', 'www/js');
        expect(normalizeGameDir(`"${d}"`)).toBe(resolve(d));
        expect(normalizeGameDir(`'${d}'`)).toBe(resolve(d));
        expect(normalizeGameDir(`  ${d}${process.platform === 'win32' ? '\\' : '/'}  `)).toBe(resolve(d));
        expect(normalizeGameDir(join(d, 'www'))).toBe(resolve(d));
    });
});
