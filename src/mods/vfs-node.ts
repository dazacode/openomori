// Disk access for mods (Bun/Node only): folders and .zip files in a mods directory.
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { memTree, zipTreeFromBytes, type Tree } from './vfs.ts';

function walkDir(root: string, rel = ''): string[] {
    const out: string[] = [];
    for (const e of readdirSync(join(root, rel), { withFileTypes: true })) {
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) out.push(...walkDir(root, r));
        else out.push(r);
    }
    return out;
}

export function dirTree(root: string): Tree {
    const files = walkDir(root);
    let newest = 0;
    for (const f of files) newest = Math.max(newest, statSync(join(root, f)).mtimeMs);
    return { files, read: p => new Uint8Array(readFileSync(join(root, p))), stamp: `dir:${files.length}:${newest}` };
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
