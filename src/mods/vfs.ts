// Read-only file trees for mods. Browser- and Bun-safe (no node imports); see vfs-node.ts for disk access.
import { unzipSync, zipSync } from 'fflate';

export interface Tree {
    /** every file, as forward-slash paths relative to the mod root */
    files: string[];
    read(path: string): Uint8Array;
    /** changes when contents change (cache invalidation) */
    stamp: string;
}

const norm = (p: string) => p.replace(/\\/g, '/').replace(/^\.?\//, '');

/** A tree over in-memory files (a dropped folder, or a test fixture). */
export function memTree(entries: Record<string, Uint8Array>, stamp = ''): Tree {
    const map = new Map(Object.entries(entries).map(([k, v]) => [norm(k), v]));
    let total = 0;
    for (const v of map.values()) total += v.length;
    return {
        files: [...map.keys()],
        read: p => { const v = map.get(p); if (!v) throw new Error(`no such file in mod: ${p}`); return v; },
        stamp: stamp || `${map.size}:${total}`,
    };
}

/**
 * A tree from extracted archive entries (any format). Many archives wrap everything in one top-level folder;
 * strip it when mod.json lives there, and drop macOS resource-fork junk.
 */
export function treeFromEntries(raw: Record<string, Uint8Array>, stamp = ''): Tree {
    const names = Object.keys(raw).map(norm).filter(n => n && !n.endsWith('/') && !n.startsWith('__MACOSX/'));
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
