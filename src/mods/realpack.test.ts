// Integration test against a real OneLoader modpack (OMO CEP), if one is on this machine. It proves the importer
// finds the right mods and that every edit applies to the real game files. Skipped when the pack or game is absent.
// Point it elsewhere with OMO_PACK_DIR=<folder containing www/mods>.
import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { WWW, readGameKey } from '../gamedir.ts';
import { ModEngine, assetKeyFromSystem } from './engine.ts';
import { planInstall, type Entries } from './pack.ts';
import { treeFromEntries } from './vfs.ts';

// Optional: point OMO_PACK_DIR at an extracted third-party mod pack (one with www/mods) to run this against real-world mods.
const PACK = process.env.OMO_PACK_DIR ?? '';
const have = !!PACK && existsSync(join(PACK, 'www', 'mods')) && existsSync(join(WWW, 'data', 'System.KEL'));
const td = new TextDecoder();

function readTree(dir: string, rel = '', out: Entries = {}): Entries {
    for (const e of readdirSync(join(dir, rel), { withFileTypes: true })) {
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) readTree(dir, r, out); else out[r] = new Uint8Array(readFileSync(join(dir, r)));
    }
    return out;
}

describe.skipIf(!have)('real OneLoader pack', () => {
    const entries = have ? readTree(PACK) : {};
    const noNested = async () => { throw new Error('no 7z reader in this test'); };

    test('is recognised as a modpack; every mod is found; OneLoader\'s own helper is skipped', async () => {
        const plan = await planInstall('OMO-CEP', entries, noNested);
        expect(plan.kind).toBe('pack');
        const zips = readdirSync(join(PACK, 'www', 'mods')).filter(n => n.endsWith('.zip')).length;
        expect(plan.items.length).toBe(zips);
        expect(plan.skipped.some(s => s.name === 'oneloader')).toBe(true);
        expect(plan.support && Object.keys(plan.support).sort()).toEqual(['imagediff2.js', 'imagediff2_bg.wasm']);
    });

    test('every edit of every mod applies to the real game files', async () => {
        const plan = await planInstall('OMO-CEP', entries, noNested);
        const key = readGameKey()!;
        const log: string[] = [];
        const engine = new ModEngine(() => key, d => { if (d.level === 'error') log.push(`${d.mod}: ${d.message}`); });
        const sys = JSON.parse(td.decode(engine.decrypt(new Uint8Array(readFileSync(join(WWW, 'data', 'System.KEL'))))));
        engine.assetKey = assetKeyFromSystem(sys);
        engine.load(plan.items.map(i => ({ label: i.label, tree: treeFromEntries(i.entries) })));

        const active = engine.activeMods();
        let targets = 0, failed = 0;
        const bad: string[] = [];
        const targetSet = new Set(active.flatMap(m => m.edits.map(e => e.target)));
        for (const t of targetSet) {
            targets++;
            const before = log.length;
            const real = (() => { try { const p = join(WWW, t); return statSync(p).isFile() ? new Uint8Array(readFileSync(p)) : null; } catch { return null; } })();
            const out = engine.resolve(t, () => real);
            if (log.length > before || !out) { failed++; bad.push(`${t}: ${log.slice(before).join(' | ') || 'no output'}`); }
        }
        console.log(`pack: ${plan.items.length} mods, ${active.length} active, ${engine.mods.length - active.length} disabled; ${targets} files edited, ${failed} failed`);
        for (const m of engine.mods.filter(x => !x.enabled)) console.log(`  disabled ${m.id}: ${m.errors.join('; ') || 'dependency/requirement'}`);
        for (const b of bad.slice(0, 20)) console.log('  FAILED', b.slice(0, 300));
        expect(plan.items.length).toBeGreaterThan(30);
        expect(failed).toBe(0);
    }, 60_000);
});
