// Static bundle mode: OpenOMORI served as plain files (an app-store package, or any static host) instead of the Bun
// dev server (src/server.ts). The dev server answers `/__config`, `/__ls`, `/__mods/*` and `/__story.json`; a static
// host cannot, so `scripts/make-bundle.ts` bakes `omori-bundle.json` beside the game and the shim reads that instead.
//
// The same manifest carries every directory's listing, which is what makes the game's paths case-insensitive here like
// the dev server is: OMORI asks for `/Languages/` while the folder on disk is `languages/`, and a static host does not
// fix that on its own (see `bundleResolve`).

export interface BundleMod {
    label: string;
    /** changes when the mod's files change, so a rebuild is picked up */
    stamp: string;
}

interface Manifest {
    key: string;
    /** normalized directory path ('' is the root) -> the names inside it (files and folders) */
    dirs: Record<string, string[]>;
    mods: BundleMod[];
    story: unknown | null;
}

const MANIFEST = 'omori-bundle.json';

let manifest: Manifest | null = null;

/** True once a bundle manifest has been read: the dev-server endpoints are gone and everything comes from the files. */
export const bundleMode = (): boolean => manifest !== null;

export async function loadBundle(): Promise<boolean> {
    if (manifest) return true;
    try {
        const r = await fetch(MANIFEST, { cache: 'no-store' });
        if (!r.ok) return false;
        const data = (await r.json()) as Manifest;
        if (!data || typeof data.key !== 'string' || !data.dirs) return false;
        manifest = data;
        return true;
    } catch {
        return false;
    }
}

export const bundleKey = (): string | null => manifest?.key ?? null;
export const bundleMods = (): BundleMod[] | null => (manifest ? manifest.mods ?? [] : null);
export const bundleStory = (): unknown | null => manifest?.story ?? null;
export const bundleDir = (key: string): string[] | null => manifest?.dirs[key] ?? null;

/**
 * The real, case-correct path for `key`, matching the dev server's tolerance for wrong case (`/Languages/` -> the
 * `languages/` folder on disk). Returns `key` unchanged when it is already right or cannot be matched.
 */
export function bundleResolve(key: string): string {
    if (!manifest || !key || manifest.dirs[key]) return key;
    const out: string[] = [];
    let dir = '';
    for (const seg of key.split('/')) {
        const names = manifest.dirs[dir];
        if (!names) return key;
        const hit = names.find(n => n.toLowerCase() === seg.toLowerCase());
        if (!hit) return key;
        out.push(hit);
        dir = dir ? `${dir}/${hit}` : hit;
    }
    return out.join('/');
}
