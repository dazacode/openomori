// Mod runtime: builds the engine from installed mods, hooks it into the fs shim and service worker,
// and runs mod scripts at the right point of boot.
import { ModEngine, assetKeyFromSystem, type Diagnostic, type LoadedMod } from '../../mods/engine.ts';
import type { ClientScript } from '../../mods/manifest.ts';
import { zipTreeFromBytes } from '../../mods/vfs.ts';
import { setModLayer } from '../shim/fs.ts';
import { modInfo, report, setCurrent } from './api.ts';
import { installModLoaderShim, runExec, type ModLoaderShim } from './compat.ts';
import { applyImageDeltas } from './olid.ts';
import { patchPluginList } from './plugins.ts';
import { enabledKeys, getActiveProfile, listMods, replaceGenerated, setMeta, syncServerMods, type ModRecord, type Profile } from './store.ts';

export const SAFE_MODE = new URLSearchParams(location.search).get('mods') === '0';

let key = '';
export const engine = new ModEngine(() => key, (d: Diagnostic) => {
    if (d.level === 'info') return;
    // Problems found while loading mods surface in the same panel and log as runtime errors.
    report(d.mod ?? '(mods)', new Error(d.message), '', d.level === 'warn' ? 'warn' : 'error');
});
/** The mod library (every installed mod) and the profile this session runs as. */
export let records: ModRecord[] = [];
export let profile: Profile | null = null;
let shim: ModLoaderShim | null = null;

const hex = (b: Uint8Array) => Array.from(b, x => x.toString(16).padStart(2, '0')).join('');

/** A small status line during startup work that can take a while (patching many images). */
function bootStatus() {
    const el = document.createElement('div');
    el.setAttribute('style', 'position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:2147483200;background:#000c;color:#fff;font:13px system-ui,sans-serif;padding:8px 14px;border-radius:6px;pointer-events:none');
    document.body.append(el);
    return { set: (t: string) => { el.textContent = t; }, done: () => el.remove() };
}

/** Images and audio are stored with RPG Maker's encryption; replacing one means encoding it with the game's own asset key. */
async function prepareAssetKey(): Promise<void> {
    const r = await fetch('/data/System.KEL', { cache: 'no-store' });
    if (!r.ok) throw new Error('could not read the game\'s System data');
    const system = JSON.parse(new TextDecoder().decode(engine.decrypt(new Uint8Array(await r.arrayBuffer()))));
    engine.assetKey = assetKeyFromSystem(system);
    await setMeta('assetKey', hex(engine.assetKey)); // the service worker has no game key, so it reads this
}

/** Load installed mods and plug them into the game's file layer. Never throws: a broken mod store means "no mods". */
export async function initMods(gameKey: string): Promise<void> {
    key = gameKey;
    try {
        profile = await getActiveProfile();
        records = (await listMods()).sort((a, b) => a.key.localeCompare(b.key));
    } catch (e) { report('(mods)', e, 'could not read profiles'); }
    if (SAFE_MODE) {
        console.warn('[mods] safe mode (?mods=0): no mods loaded');
        await syncServiceWorker(true);
        return;
    }
    try {
        await syncServerMods();
        records = (await listMods()).sort((a, b) => a.key.localeCompare(b.key));
        const on = enabledKeys(profile!, records);
        engine.load(records.map(r => {
            try { return { label: r.label, tree: zipTreeFromBytes(r.zip, r.stamp), origin: r.key, disabled: !on.has(r.key) }; }
            catch (e) { report(r.label, e, 'not a valid zip'); return null; }
        }).filter((x): x is NonNullable<typeof x> => !!x));
    } catch (e) {
        report('(mods)', e, 'could not load the mod store');
        return;
    }
    modInfo.splice(0, modInfo.length, ...engine.mods.map(m => ({ id: m.id, name: m.name, version: m.version, enabled: m.enabled })));
    setModLayer({
        has: k => engine.hasEdits(k) && engine.isEncrypted(k),
        resolve: (k, base) => engine.resolve(k, base),
        added: dir => engine.addedNames(dir),
    });
    shim = installModLoaderShim(engine.activeMods());

    const active = engine.activeMods();
    const wantsImages = active.some(m => m.imageDeltas.length);
    if (engine.hasAssetEdits() || wantsImages) {
        try { await prepareAssetKey(); } catch (e) { report('(mods)', e, 'replaced images and audio cannot be applied'); }
    }
    let generated: Record<string, Uint8Array> = {};
    if (wantsImages && engine.assetKey) {
        const status = bootStatus();
        try {
            const r = await applyImageDeltas(engine, (done, total, name) => status.set(`Patching images ${done}/${total}${name ? ` · ${name.split('/').pop()}` : ''}`));
            generated = r.generated;
        } finally { status.done(); }
    }
    await replaceGenerated(generated).catch(e => report('(mods)', e, 'could not save patched images'));
    await syncServiceWorker();
}

/** Images, audio and plain scripts bypass the fs shim, so a service worker serves the mod versions. */
async function syncServiceWorker(safe = false): Promise<void> {
    if (!('serviceWorker' in navigator)) {
        if (engine.hasAssetEdits()) report('(mods)', new Error('this browser has no service worker support; mods that replace images/audio will not apply'), '', 'warn');
        return;
    }
    const existing = await navigator.serviceWorker.getRegistration('/');
    if (safe) { if (existing) navigator.serviceWorker.controller?.postMessage({ type: 'reload', safe: true }); return; }
    if (!engine.hasAssetEdits()) { if (existing) navigator.serviceWorker.controller?.postMessage({ type: 'reload', safe: true }); await existing?.unregister(); return; }
    try {
        const reg = existing ?? await navigator.serviceWorker.register('/sw.js', { scope: '/' });
        await navigator.serviceWorker.ready;
        if (!navigator.serviceWorker.controller) {
            await Promise.race([
                new Promise<void>(res => navigator.serviceWorker.addEventListener('controllerchange', () => res(), { once: true })),
                new Promise<void>(res => setTimeout(res, 4000)),
            ]);
        }
        const sw = navigator.serviceWorker.controller ?? reg.active;
        if (!sw) throw new Error('service worker did not take control');
        await new Promise<void>((res, rej) => {
            const t = setTimeout(() => rej(new Error('service worker did not answer')), 15000);
            navigator.serviceWorker.addEventListener('message', function h(e) {
                if (e.data?.type !== 'reloaded') return;
                clearTimeout(t); navigator.serviceWorker.removeEventListener('message', h);
                e.data.error ? rej(new Error('service worker failed to read mods')) : res();
            });
            sw.postMessage({ type: 'reload' });
        });
    } catch (e) {
        report('(mods)', e, 'asset mods may not apply');
    }
}

/** Parameters OneLoader passes to scripts at each stage. */
function paramsFor(phase: ClientScript['phase']): Record<string, unknown> {
    const g = globalThis as any;
    if (phase === 'pre-plugins') return { PluginManager: g.PluginManager, $plugins: g.$plugins };
    return { knownMods: shim?.knownMods ?? new Map(), $modLoader: shim };
}

/**
 * Run every active mod's scripts for a boot phase, in load order (OneLoader scripts also in run-at order).
 * A throwing script is reported against its mod and skipped.
 */
export async function runPhase(phase: ClientScript['phase']): Promise<void> {
    const items: { mod: LoadedMod; script: NonNullable<LoadedMod['scripts']>[number]; at: number }[] = [];
    engine.activeMods().forEach((mod, at) => mod.scripts.filter(s => s.phase === phase).forEach(script => items.push({ mod, script, at })));
    items.sort((a, b) => (a.script.rank ?? 0) - (b.script.rank ?? 0) || a.at - b.at);
    for (const { mod: m, script: s } of items) {
        if (s.style === 'eval' || s.style === 'require') { await runExec(m, s.file, s.style, paramsFor(phase)); continue; }
        try {
            const code = new TextDecoder().decode(m.tree.read(s.file));
            const el = document.createElement('script');
            el.textContent = `${code}\n//# sourceURL=omori-mod://${m.id}/${s.file}`;
            setCurrent({ id: m.id, file: s.file });
            document.head.appendChild(el); // runs synchronously; errors reach the window error handler, attributed via sourceURL
            el.remove();
        } catch (e) {
            report(m.id, e, `script ${s.file} (${phase})`);
        } finally { setCurrent(null); }
    }
}

/** Add mod-provided plugins to the game's plugin list and apply plugin_parameters. Run after `pre-plugins` scripts. */
export function patchPlugins(): void {
    if (!shim) return;
    try {
        const { added } = patchPluginList((globalThis as any).$plugins, engine.activeMods(), shim);
        if (added.length) console.log(`[mods] added ${added.length} plugin(s) to the game: ${added.join(', ')}`);
    } catch (e) { report('(mods)', e, 'could not patch the plugin list'); }
}
