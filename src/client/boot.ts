// Loads the stock game scripts in order, then starts the game (what js/main.js does on window.onload).
import { installCutsceneLayout } from './cutscene.ts';
import { installBeatRecorder, installCheckpointApi } from './checkpoints.ts';
import { installDebug } from './debug.ts';
import { installDisplay } from './display.ts';
import { installGameEvents, installErrorCapture } from './mods/api.ts';
import { initMods, patchPlugins, runPhase } from './mods/runtime.ts';
import { installModUi } from './mods/ui.ts';
import { installSettings } from './settings/index.ts';
import { listAsync, prefetch, shimReady } from './shim/index.ts';
import { nw } from './shim/nw.ts';
import { bundleMode, bundlePlain } from './staticBundle.ts';

const LIBS = ['pixi', 'pixi-tilemap', 'pixi-picture', 'lz-string', 'iphone-inline-video.browser'].map(n => `js/libs/${n}.js`);
const CORE = ['rpg_core', 'rpg_managers', 'rpg_objects', 'rpg_scenes', 'rpg_sprites', 'rpg_windows', 'plugins'].map(n => `js/${n}.js`);

function loadScript(src: string): Promise<void> {
    return new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = src;
        s.onload = () => resolve();
        s.onerror = () => reject(new Error(`failed to load ${src}`));
        document.body.appendChild(s);
    });
}

/** Fetch the small, always-needed files in parallel; the game then reads them synchronously from cache. */
async function warmCache(): Promise<void> {
    const [data, plugins, langs] = await Promise.all([listAsync('data'), listAsync('js/plugins'), listAsync('languages')]);
    const langFiles = (await Promise.all(langs.map(async l => (await listAsync(`languages/${l}`)).map(f => `languages/${l}/${f}`)))).flat();
    await prefetch([
        ...data.filter(f => !/^Map\d+/i.test(f)).map(f => `data/${f}`),
        ...plugins.filter(f => f.endsWith('.OMORI')).map(f => `js/plugins/${f}`),
        ...langFiles,
    ]);
}

export async function boot(): Promise<void> {
    const mark = (n: string) => performance.mark(`omori:${n}`);
    installErrorCapture();
    await shimReady; mark("shim-ready");
    installModUi();
    await initMods(String(nw.App.argv[0] ?? '').replace(/^--/, '')); mark("mods");
    await runPhase('early');               // mod scripts that must run before any game code
    const warm = warmCache();
    for (const src of [...LIBS, ...CORE]) await loadScript(src);
    mark("core-scripts");
    await warm; mark("cache-warm");
    await runPhase('pre-plugins');
    installPlainData();
    patchPlugins();                  // mods' own plugins + plugin_parameters, after their pre-injection scripts
    PluginManager.setup($plugins);   // plugins (and their Graphics overrides) load synchronously here
    mark("plugins");
    installGameEvents();
    installCheckpointApi();
    installBeatRecorder();
    await runPhase('post-plugins');  // mod scripts: the game's classes exist, nothing has started
    installDisplay();                // must run after plugins so it wins over YEP_CoreEngine
    installCutsceneLayout();
    installDebug();
    installSettings();               // replaces the game's options screens; after plugins so ConfigManager is final
    SceneManager.run(Scene_Boot);
    mark("run");
    hideBootScreen();
    await runPhase('ready');
    startHotReload();
}

/** Take the loading screen (public/index.html) away once the game has a screen of its own. */
function hideBootScreen() {
    const el = document.getElementById('boot');
    if (!el) return;
    const t0 = Date.now();
    const tick = setInterval(() => {
        const scene = (globalThis as any).SceneManager?._scene?.constructor?.name as string | undefined;
        if ((scene && scene !== 'Scene_Boot') || Date.now() - t0 > 30000) {
            clearInterval(tick);
            el.classList.add('hide');
            setTimeout(() => el.remove(), 400);
        }
    }, 100);
}

/**
 * A static bundle ships `data/`, `maps/` and `languages/` decrypted (they compress, and the AES round trip goes away),
 * while the game decrypts whatever it reads with its own `Encryption` class. That class is created by a plugin during
 * `PluginManager.setup`, so intercept the global assignment and make `decrypt` the identity. Plugin scripts stay
 * encrypted, and images/audio keep RPG Maker's own scheme (handled by `Decrypter`, not this class).
 */
function installPlainData() {
    if (!bundlePlain()) return;
    let cls: any;
    Object.defineProperty(globalThis, 'Encryption', {
        configurable: true,
        get: () => cls,
        set(v) { cls = v; if (v && typeof v.decrypt === 'function') v.decrypt = (b: Uint8Array) => b; },
    });
}

/** `?hot=1`: reload when the dev ./mods folder changes (for authors iterating on a mod). */
function startHotReload() {
    if (bundleMode()) return; // a bundle's mods are files; a rebuild replaces them
    if (new URLSearchParams(location.search).get('hot') !== '1') return;
    let last: number | null = null;
    setInterval(async () => {
        try {
            const v = (await (await fetch('/__mods/version', { cache: 'no-store' })).json()).version as number;
            if (last !== null && v !== last) location.reload();
            last = v;
        } catch { /* server restarting */ }
    }, 1000);
}
