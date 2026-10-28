// Installs the Node/NW.js globals the game's code expects. Import this before any game script.
import { Buffer } from 'buffer';
import path from 'path-browserify';
import yaml from 'js-yaml';
import { crypto } from './crypto.ts';
import { fs, loadOverlay } from './fs.ts';
import { getActiveProfile } from '../mods/store.ts';
import { greenworks, nw, processShim, setGameKey } from './nw.ts';
import { bundleKey, bundleMode, bundleResolve, loadBundle } from '../staticBundle.ts';

const g = globalThis as Record<string, any>;
g.Buffer = Buffer;
g.process = processShim;
g.nw = nw;

/**
 * The game builds a few URLs by hand, and OMORI ships files whose names contain a literal '%'
 * ("img/characters/$DW_OMORI_RUN%(8).rpgmvp"). A single '%' is not a valid escape, so Chrome sends it raw and a strict
 * proxy (Caddy over HTTP/2, the Store's content origin) answers 400 or drops the stream. Encode it on the way out.
 */
const encodeLonePercent = (url: string): string => url.replace(/%(?![0-9a-fA-F]{2})/g, '%25');

/**
 * The game also asks for asset URLs it builds itself ("img/pictures/Leaf.rpgmvp", "audio/bgm/..."), which never pass
 * through the fs shim - and a plain static host is case-SENSITIVE while the dev server was not (the install has
 * `img/pictures/leaf.rpgmvp`). Resolve those against the bundle's file list, like the dev server did.
 */
function fixUrl(url: string): string {
    const fixed = encodeLonePercent(url);
    if (!bundleMode()) return fixed;
    if (/^(blob|data):/i.test(fixed)) return fixed;    // decrypted images/audio are blob URLs: leave them alone
    let u: URL;
    try { u = new URL(fixed, location.href); } catch { return fixed; }
    if (u.origin !== location.origin) return fixed;    // another host (or an opaque origin)
    let path: string;
    try { path = decodeURIComponent(u.pathname); } catch { path = u.pathname; }
    const real = bundleResolve(path.replace(/^\//, ''));
    return '/' + real.split('/').map(encodeURIComponent).join('/') + u.search + u.hash;
}

const xhrOpen = XMLHttpRequest.prototype.open as (...args: any[]) => void;
XMLHttpRequest.prototype.open = function (this: XMLHttpRequest, ...args: any[]) {
    if (typeof args[1] === 'string') args[1] = fixUrl(args[1]);
    return xhrOpen.apply(this, args);
} as typeof XMLHttpRequest.prototype.open;

// Some screens play a movie or set an <img> straight from a path instead of going through the fs shim.
for (const proto of [HTMLImageElement.prototype, HTMLMediaElement.prototype]) {
    const desc = Object.getOwnPropertyDescriptor(proto, 'src');
    if (!desc?.set) continue;
    Object.defineProperty(proto, 'src', {
        configurable: true, enumerable: desc.enumerable,
        get: desc.get,
        set(this: HTMLElement, value: string) { desc.set!.call(this, typeof value === 'string' ? fixUrl(value) : value); },
    });
}

const modules: Record<string, unknown> = {
    fs, path, crypto, yaml,
    os: { platform: () => 'win32', homedir: () => '/home', tmpdir: () => '/tmp', EOL: '\n' },
    child_process: { exec() {} },
    'nw.gui': nw,
    ncp: { ncp() {} },
    'pixi.js': undefined, // resolved lazily: PIXI is loaded after the shim
    './js/libs/js-yaml-master': yaml,
    './js/libs/greenworks': greenworks,
};

g.require = (name: string) => {
    if (name === 'pixi.js') return g.PIXI;
    if (!(name in modules)) throw new Error(`Cannot find module ${name}`);
    return modules[name];
};

/** Resolves once saved data has been loaded from IndexedDB. */
export const shimReady: Promise<void> = (async () => {
    // A static bundle carries the game key and the file listings; the dev server answers /__config instead.
    let key: string | null = null;
    if (await loadBundle()) key = bundleKey();
    if (!key) {
        const res = await fetch('/__config');
        if (!res.ok) throw new Error('Could not read the game key from your OMORI install (see README: OMORI_DIR).');
        key = (await res.json()).key as string;
    }
    setGameKey(key);
    // Saves live in the active mod profile's own database (the original profile keeps the pre-mod one).
    const profile = await getActiveProfile().catch(() => null);
    await loadOverlay(profile?.fsDb);
    // The game throws on first run if this file is missing.
    if (!fs.existsSync('/appdata/OMORI/CUTSCENE.json')) fs.writeFileSync('/appdata/OMORI/CUTSCENE.json', '{}');
})();

export { prefetch, listAsync } from './fs.ts';
