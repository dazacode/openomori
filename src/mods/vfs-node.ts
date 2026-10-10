// Disk access for mods (Bun/Node only): folders and .zip files in a mods directory.
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { compareNames, isOsJunk, memTree, normPath, zipTreeFromBytes, type Tree } from './vfs.ts';

/**
 * Every file under `root`, as [normalised path, path on disk]. Each folder is read in Windows order (macOS lists
 * folders in no particular order), OS litter is skipped, and symlinked folders are followed (a Dirent of a symlink
 * is never isDirectory(), which used to ship the link itself as a "file" and break the mod) with a guard against loops.
 */
function walkDir(root: string, rel = '', seen = new Set<string>([realpathSync(root)])): [string, string][] {
    const out: [string, string][] = [];
    const entries = readdirSync(join(root, rel), { withFileTypes: true }).sort((a, b) => compareNames(a.name.normalize('NFC'), b.name.normalize('NFC')));
    for (const e of entries) {
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (isOsJunk(normPath(r))) continue;
        let dir = e.isDirectory();
        if (e.isSymbolicLink()) {
            const st = statSync(join(root, r), { throwIfNoEntry: false });
            if (!st) continue;                             // broken link: nothing to ship
            dir = st.isDirectory();
            if (dir) {
                const real = realpathSync(join(root, r));
                if (seen.has(real)) continue;              // a link back into the tree
                seen = new Set(seen).add(real);
            }
        }
        if (dir) out.push(...walkDir(root, r, seen));
        else out.push([normPath(r), r]);
    }
    return out;
}

export function dirTree(root: string): Tree {
    const pairs = walkDir(root);
    const onDisk = new Map(pairs);
    const files = pairs.map(([p]) => p);
    let newest = 0;
    for (const [, d] of pairs) newest = Math.max(newest, statSync(join(root, d)).mtimeMs);
    return { files, read: p => new Uint8Array(readFileSync(join(root, onDisk.get(p) ?? p))), stamp: `dir:${files.length}:${newest}` };
}

export function zipTreeFromFile(path: string): Tree {
    const st = statSync(path);
    return zipTreeFromBytes(new Uint8Array(readFileSync(path)), `zip:${st.size}:${st.mtimeMs}`);
}

export interface DiscoveredMod { label: string; path: string; tree: Tree }

/** Every mod folder / .zip in `dir`. Names starting with "." or "_" are skipped (use _disabled/ to park mods). */
export function discoverMods(dir: string, onError: (name: string, e: Error) => void): DiscoveredMod[] {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const out: DiscoveredMod[] = [];
    for (const name of readdirSync(dir).sort()) {
        if (name.startsWith('.') || name.startsWith('_')) continue;
        const path = join(dir, name);
        try {
            const tree = statSync(path).isDirectory() ? dirTree(path) : /\.zip$/i.test(name) ? zipTreeFromFile(path) : null;
            if (tree) out.push({ label: name.replace(/\.zip$/i, ''), path, tree });
        } catch (e) { onError(name, e as Error); }
    }
    return out;
}

export { memTree };
