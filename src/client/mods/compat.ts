// A small stand-in for the parts of OneLoader's `$modLoader` that mods' scripts and the plugin list rely on, so
// mods written for OneLoader find the objects they expect. It is deliberately narrow: no virtual file system, no
// Node access. A script that reaches for more fails with an error attributed to its mod, not a crash.
import { applyJsonPatch } from '../../mods/patch.ts';
import type { LoadedMod } from '../../mods/engine.ts';
import type { PluginRule } from '../../mods/manifest.ts';
import { engine } from './runtime.ts';
import { report } from './api.ts';

const g = globalThis as any;

export interface OrderingRule { culprit: string; rule: PluginRule }

export interface ModLoaderShim {
    $log(...a: unknown[]): void;
    config: Record<string, unknown>;
    syncConfig(): void;
    knownMods: Map<string, unknown>;
    allMods: Map<string, unknown>;
    mods: Map<string, unknown>;
    pluginLocks: Set<string>;
    pluginOrderingRules: Map<string, OrderingRule>;
    success: boolean;
    overlayFS: Record<string, unknown>;
    $nwMajor: number;
    isInTestMode: boolean;
    realArgv: string[];
}

const lower = (s: string) => s.toLowerCase();

/** Names of plugins a mod adds (or, for plugin deltas, edits) as listed by OneLoader: lowercase, no extension. */
const pluginNameOf = (target: string) => lower(target.slice(target.lastIndexOf('/') + 1).replace(/\.[^.]*$/, ''));

export function installModLoaderShim(mods: LoadedMod[]): ModLoaderShim {
    const pluginLocks = new Set<string>();
    const pluginOrderingRules = new Map<string, OrderingRule>();

    // plugin deltas first (they lock the plugin and mean "append at the end"), then the plugins mods ship
    for (const m of mods) {
        for (const e of m.edits) {
            if (e.kind === 'append' && /^js\/plugins\//i.test(e.target)) {
                const n = pluginNameOf(e.target);
                pluginLocks.add(n);
                pluginOrderingRules.set(n, { culprit: m.id, rule: { at: -1 } });
            }
        }
    }
    for (const m of mods) {
        for (const n of m.pluginFiles) {
            if (pluginLocks.has(n) && pluginOrderingRules.get(n)?.culprit !== m.id) {
                report(m.id, new Error(`plugin "${n}" is also provided by "${pluginOrderingRules.get(n)!.culprit}"; the later mod replaces it`), '', 'warn');
            }
            pluginOrderingRules.set(n, { culprit: m.id, rule: m.pluginOrder[n] ?? { at: -1 } });
            pluginLocks.add(n);
        }
    }

    const entry = (m: LoadedMod) => ({ json: m.json, files: [], plugins: m.pluginFiles, pluginsDelta: [], imageDelta: m.imageDeltas, _raw: m });
    const known = new Map(mods.map(m => [m.id, entry(m)]));
    const shim: ModLoaderShim = {
        $log: (...a) => console.log('[OneLoader]', ...a),
        config: {},
        syncConfig() {},
        knownMods: known,
        allMods: new Map(mods.map(m => [m.id, m.json])),
        mods: new Map(mods.map(m => [m.id, { enabled: true, meta: m.json, id: m.id }])),
        pluginLocks,
        pluginOrderingRules,
        success: true,
        overlayFS: {},
        $nwMajor: 0,
        isInTestMode: false,
        realArgv: [],
    };
    g.$modLoader = shim;
    g._logLine = (...a: unknown[]) => console.log('[OneLoader]', ...a);
    return shim;
}

const AsyncFunction = Object.getPrototypeOf(async function () { /* */ }).constructor as new (...args: string[]) => (...a: unknown[]) => Promise<unknown>;

/** Run an `asyncExec` script the way OneLoader does: an async function body with `params`, or a module exporting an async function. */
export async function runExec(mod: LoadedMod, file: string, style: 'eval' | 'require', params: Record<string, unknown>): Promise<void> {
    const code = new TextDecoder().decode(mod.tree.read(file)) + `\n//# sourceURL=omori-mod://${mod.id}/${file}`;
    try {
        if (style === 'eval') {
            await new AsyncFunction('params', code)({ ...params, mod: { json: mod.json, id: mod.id } });
        } else {
            const module: { exports: unknown } = { exports: {} };
            new Function('module', 'exports', 'require', code)(module, module.exports, g.require);
            if (typeof module.exports === 'function') await (module.exports as (...a: unknown[]) => unknown)(g.$modLoader, window, params);
        }
    } catch (e) {
        report(mod.id, e, `script ${file}${style === 'require' ? ' (module)' : ''}`);
    }
}

/** plugin_parameters: JSON patches over a plugin's parameter object, as OneLoader applies them. */
export function applyPluginParameters(mods: LoadedMod[], plugins: { name: string; parameters: Record<string, unknown> }[]) {
    for (const m of mods) {
        for (const [name, patch] of Object.entries(m.pluginParameters)) {
            const p = plugins.find(x => lower(x.name) === lower(name));
            if (!p) { engine.log('warn', `plugin_parameters for "${name}" ignored: the game has no such plugin`, { mod: m.id }); continue; }
            try { p.parameters = applyJsonPatch(p.parameters, patch as never) as Record<string, unknown>; }
            catch (e) { report(m.id, e, `plugin_parameters for ${name}`); }
        }
    }
}
