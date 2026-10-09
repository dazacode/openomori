// Installs the Node/NW.js globals the game's code expects. Import this before any game script.
import { Buffer } from 'buffer';
import path from 'path-browserify';
import yaml from 'js-yaml';
import { crypto } from './crypto.ts';
import { fs, loadOverlay } from './fs.ts';
import { getActiveProfile } from '../mods/store.ts';
import { greenworks, nw, processShim, setGameKey } from './nw.ts';

const g = globalThis as Record<string, any>;
g.Buffer = Buffer;
g.process = processShim;
g.nw = nw;

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
    const res = await fetch('/__config');
    if (!res.ok) throw new Error('Could not read the game key from your OMORI install (see README: OMORI_DIR).');
    setGameKey((await res.json()).key);
    // Saves live in the active mod profile's own database (the original profile keeps the pre-mod one).
    const profile = await getActiveProfile().catch(() => null);
    await loadOverlay(profile?.fsDb);
    // The game throws on first run if this file is missing.
    if (!fs.existsSync('/appdata/OMORI/CUTSCENE.json')) fs.writeFileSync('/appdata/OMORI/CUTSCENE.json', '{}');
})();

export { prefetch, listAsync } from './fs.ts';
