// Adds the plugins that mods ship to the game's plugin list ($plugins), following OneLoader's ordering rules:
//   plugins_ordered {"name": {"at": N | "after": "Other", "weight": W}} places a plugin at a position;
//   anything without a position goes after the game's own plugins (positive weights first, then plain, then negative).
// Replacing a plugin the game already has needs no list change: the file simply changes.
import type { LoadedMod } from '../../mods/engine.ts';
import { applyPluginParameters, type ModLoaderShim } from './compat.ts';

interface Entry { name: string; status: boolean; description: string; parameters: Record<string, unknown>; _w?: number }
const lower = (s: string) => s.toLowerCase();
const modded = (name: string, weight?: number): Entry => ({ name, status: true, description: 'Modded plugin', parameters: {}, ...(weight === undefined ? {} : { _w: weight }) });

/** Mutates the game's `$plugins` array in place. Call after `pre-plugins` scripts and before PluginManager.setup. */
export function patchPluginList(plugins: Entry[], mods: LoadedMod[], shim: ModLoaderShim): { added: string[] } {
    const gameSupplied = plugins.map(p => lower(p.name)); // after scripts: a script may already have inserted a plugin itself
    const added: string[] = [];

    // 1. plugins with an explicit position
    const injections: Entry[][] = Array.from({ length: plugins.length + 1 }, () => []);
    for (const [name, { rule }] of shim.pluginOrderingRules) {
        if (gameSupplied.includes(name)) continue;
        let at = rule.at ?? -1;
        if (rule.after) {
            const i = plugins.findIndex(p => lower(p.name) === lower(rule.after!));
            if (i >= 0) at = i + 1;
        }
        if (at < 0) continue;
        if (at >= injections.length) at = injections.length - 1;
        injections[at]!.push(modded(name, rule.weight ?? 0));
        added.push(name);
    }
    for (let i = injections.length - 1; i >= 0; i--) {
        if (!injections[i]!.length) continue;
        injections[i]!.sort((a, b) => b._w! - a._w!);
        plugins.splice(i, 0, ...injections[i]!);
    }

    // 2. everything else goes after the game's plugins, by weight
    const neg: Entry[] = [], mid: Entry[] = [], pos: Entry[] = [];
    for (const name of shim.pluginLocks) {
        const rule = shim.pluginOrderingRules.get(name)?.rule;
        if (!rule || gameSupplied.includes(name) || (rule.at ?? -1) !== -1) continue;
        if (plugins.some(p => lower(p.name) === name)) continue; // a script placed it
        const w = rule.weight ?? 0;
        (w < 0 ? neg : w > 0 ? pos : mid).push(modded(name, w));
        added.push(name);
    }
    plugins.push(...pos.sort((a, b) => b._w! - a._w!), ...mid, ...neg.sort((a, b) => b._w! - a._w!));

    applyPluginParameters(mods, plugins);
    return { added };
}
