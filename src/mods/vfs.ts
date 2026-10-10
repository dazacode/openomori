// Read-only file trees for mods. Browser- and Bun-safe (no node imports); see vfs-node.ts for disk access.
import { unzipSync, zipSync } from 'fflate';

export interface Tree {
    /** every file, as forward-slash paths relative to the mod root */
    files: string[];
    read(path: string): Uint8Array;
    /** changes when contents change (cache invalidation) */
    stamp: string;
}

// ---------------------------------------------------------------- one set of path rules on every OS
// Mods are mostly written on Windows, and Windows hides three things a Mac (or a zip made on one) does not:
// directory listings there come back sorted, file names are always NFC, and Finder litter never appears.
// Every tree goes through these rules so a mod loads the same from any folder, zip or drop.

/** One spelling for a mod path: forward slashes, no leading "./", Unicode NFC (macOS file names may be NFD). */
export const normPath = (p: string) => p.replace(/\\/g, '/').replace(/^\.?\/+/, '').normalize('NFC');
const norm = normPath;

const JUNK_NAMES = new Set(['.DS_Store', '__MACOSX', 'Icon\r', '.Spotlight-V100', '.Trashes', '.fseventsd', '.TemporaryItems', 'Thumbs.db', 'desktop.ini']);
/** Operating-system litter that is never mod content: Finder's .DS_Store, AppleDouble "._x" resource forks,
 *  __MACOSX/ in zips, folder icons, Windows thumbnail caches. Any path with such a segment is ignored. */
export function isOsJunk(path: string): boolean {
    for (const seg of path.split('/')) if (JUNK_NAMES.has(seg) || seg.startsWith('._')) return true;
    return false;
}

/** Ordinal, case-insensitive name order, as NTFS lists a folder (ties broken by exact code units). */
export function compareNames(a: string, b: string): number {
    const A = a.toUpperCase(), B = b.toUpperCase();
    if (A !== B) return A < B ? -1 : 1;
    return a < b ? -1 : a > b ? 1 : 0;
}
/** The order a recursive walk of a Windows folder produces: folder by folder, each folder's entries by name. */
export function comparePaths(a: string, b: string): number {
    const x = a.split('/'), y = b.split('/');
    for (let i = 0; i < Math.min(x.length, y.length); i++) {
        const c = compareNames(x[i]!, y[i]!);
        if (c) return c;
    }
    return x.length - y.length;
}

/** A tree over in-memory files (a dropped folder, or a test fixture). Paths are normalised, litter dropped and the
 *  file list sorted, so script, patch and override order never depends on where the files came from. */
export function memTree(entries: Record<string, Uint8Array>, stamp = ''): Tree {
    const map = new Map(Object.entries(entries).map(([k, v]) => [norm(k), v] as const).filter(([k]) => k && !isOsJunk(k)));
    let total = 0;
    for (const v of map.values()) total += v.length;
    return {
        files: [...map.keys()].sort(comparePaths),
        read: p => { const v = map.get(p); if (!v) throw new Error(`no such file in mod: ${p}`); return v; },
        stamp: stamp || `${map.size}:${total}`,
    };
}

/**
 * A tree from extracted archive entries (any format). Many archives wrap everything in one top-level folder;
 * strip it when mod.json lives there, and drop macOS resource-fork junk.
 */
export function treeFromEntries(raw: Record<string, Uint8Array>, stamp = ''): Tree {
    const names = Object.keys(raw).map(norm).filter(n => n && !n.endsWith('/') && !isOsJunk(n));
    // the shallowest mod.json marks the mod root, however many wrapper folders there are
    const mj = names.filter(n => /(^|\/)mod\.json$/.test(n)).sort((a, b) => a.split('/').length - b.split('/').length)[0];
    const prefix = mj && mj.includes('/') ? mj.slice(0, mj.lastIndexOf('/') + 1) : '';
    const out: Record<string, Uint8Array> = {};
    const byNorm = new Map(Object.keys(raw).map(k => [norm(k), k]));
    for (const n of names) if (n.startsWith(prefix)) out[n.slice(prefix.length)] = raw[byNorm.get(n)!]!;
    return memTree(out, stamp);
}

export function zipTreeFromBytes(zip: Uint8Array, stamp = ''): Tree {
    return treeFromEntries(unzipSync(zip), stamp || `zip:${zip.length}`);
}

/** Pack a tree back into a zip (used to store dropped folders and to ship folder mods to the browser). */
export function treeToZip(tree: Tree): Uint8Array {
    const o: Record<string, Uint8Array> = {};
    for (const f of tree.files) o[f] = tree.read(f);
    return zipSync(o, { level: 6 });
}
