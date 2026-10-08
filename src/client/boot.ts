// Loads the stock game scripts in order, then starts the game (what js/main.js does on window.onload).
import { installCutsceneLayout } from './cutscene.ts';
import { installDebug } from './debug.ts';
import { installDisplay } from './display.ts';
import { listAsync, prefetch, shimReady } from './shim/index.ts';

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
    await shimReady; mark("shim-ready");
    const warm = warmCache();
    for (const src of [...LIBS, ...CORE]) await loadScript(src);
    mark("core-scripts");
    await warm; mark("cache-warm");
    PluginManager.setup($plugins);   // plugins (and their Graphics overrides) load synchronously here
    mark("plugins");
    installDisplay();                // must run after plugins so it wins over YEP_CoreEngine
    installCutsceneLayout();
    installDebug();
    SceneManager.run(Scene_Boot);
    mark("run");
}
