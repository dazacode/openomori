// Works out what a dropped archive or folder contains. Mods come in three shapes:
//   one mod        mod.json at the root (or inside a single wrapper folder)
//   a modpack      a collection, usually shipped as a game-folder overlay: www/mods/<name>.zip (and mod folders),
//                  alongside OneLoader's own files. Each nested mod is installed separately.
//   nothing usable no mod.json anywhere, which we say plainly
import { unzipSync } from 'fflate';
import { sniff } from './sniff.ts';
import { isOsJunk, normPath } from './vfs.ts';

export type Entries = Record<string, Uint8Array>;

export interface PackItem { label: string; entries: Entries }
export interface PackPlan {
    kind: 'single' | 'pack' | 'none';
    items: PackItem[];
    /** things deliberately not installed, with the reason */
    skipped: { name: string; reason: string }[];
    /** OneLoader's image-patch decoder, if the pack ships it (needed for .olid image deltas) */
    support: Entries | null;
}

const norm = normPath;
const dirOf = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/') + 1) : '');
const baseOf = (p: string) => p.slice(p.lastIndexOf('/') + 1);
const stripArchiveExt = (n: string) => n.replace(/\.(zip|7z|rar|tar|tgz|tar\.gz|tar\.bz2|tbz2|tar\.xz|txz|gz|bz2|xz|mod|omm)$/i, '');
const depth = (p: string) => p.split('/').length - 1;

/** Reads a nested archive that is not a zip (7z, rar, tar.*). Supplied by the host, since it needs WebAssembly. */
export type NestedReader = (name: string, bytes: Uint8Array) => Promise<Entries>;

function peekId(entries: Entries): string | null {
    const path = Object.keys(entries).map(norm).filter(n => /(^|\/)mod\.json$/.test(n)).sort((a, b) => depth(a) - depth(b))[0];
    if (!path) return null;
    const key = Object.keys(entries).find(k => norm(k) === path)!;
    try { return String(JSON.parse(new TextDecoder().decode(entries[key]).replace(/^﻿/, '')).id ?? ''); } catch { return null; }
}

/** The part of the OneLoader pack that is OneLoader itself, not a mod. This app replaces the loader, so it is not needed. */
const HELPER_IDS = new Set(['oneloader']);

export async function planInstall(label: string, raw: Entries, readNested: NestedReader): Promise<PackPlan> {
    const all = new Map<string, Uint8Array>();
    for (const [k, v] of Object.entries(raw)) { const n = norm(k); if (n && !n.endsWith('/') && !isOsJunk(n)) all.set(n, v); }
    const names = [...all.keys()];
    const plan: PackPlan = { kind: 'none', items: [], skipped: [], support: null };

    // OneLoader ships its image decoder inside the loader folder; keep it for .olid image deltas.
    const js = names.find(n => /(^|\/)modloader\/lib\/imagediff2\.js$/i.test(n)), wasm = names.find(n => /(^|\/)modloader\/lib\/imagediff2_bg\.wasm$/i.test(n));
    if (js && wasm) plan.support = { 'imagediff2.js': all.get(js)!, 'imagediff2_bg.wasm': all.get(wasm)! };

    // mod folders: directories holding a mod.json, outermost only
    const roots = names.filter(n => /(^|\/)mod\.json$/.test(n)).map(dirOf).sort((a, b) => depth(a) - depth(b));
    const modRoots: string[] = [];
    for (const r of roots) if (!modRoots.some(m => r.startsWith(m))) modRoots.push(r);

    // nested archives sitting in a "mods" directory, outside any mod folder
    const nested = names.filter(n => /(^|\/)mods\/[^/]+$/i.test(n) && !modRoots.some(r => n.startsWith(r)) && sniff(all.get(n)!.subarray(0, 600)) !== 'unknown');

    const single = !nested.length && modRoots.length === 1;
    if (single) {
        const root = modRoots[0]!;
        plan.kind = 'single';
        plan.items.push({ label, entries: Object.fromEntries(names.filter(n => n.startsWith(root)).map(n => [n.slice(root.length), all.get(n)!])) });
        return plan;
    }
    if (!nested.length && !modRoots.length) return plan;
    plan.kind = 'pack';

    const add = (itemLabel: string, entries: Entries) => {
        if (itemLabel.startsWith('_')) { plan.skipped.push({ name: itemLabel, reason: 'names starting with "_" are disabled by convention' }); return; }
        const id = peekId(entries);
        if (id === null) { plan.skipped.push({ name: itemLabel, reason: 'no readable mod.json' }); return; }
        if (HELPER_IDS.has(id.toLowerCase())) { plan.skipped.push({ name: itemLabel, reason: "OneLoader's own helper mod; this app is the loader, so it isn't needed" }); return; }
        plan.items.push({ label: itemLabel, entries });
    };

    for (const root of modRoots) {
        const dir = root.replace(/\/$/, '');
        add(baseOf(dir) || label, Object.fromEntries(names.filter(n => n.startsWith(root)).map(n => [n.slice(root.length), all.get(n)!])));
    }
    for (const n of nested) {
        const bytes = all.get(n)!;
        const name = stripArchiveExt(baseOf(n));
        try {
            const entries = sniff(bytes.subarray(0, 600)) === 'zip' ? unzipSync(bytes) : await readNested(baseOf(n), bytes);
            add(name, entries);
        } catch (e) { plan.skipped.push({ name: baseOf(n), reason: `could not be unpacked (${(e as Error).message})` }); }
    }
    if (!plan.items.length) plan.kind = 'none';
    return plan;
}
