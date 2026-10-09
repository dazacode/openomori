// The settings registry: one list of settings that the panel renders, mods can extend, and persistence rides on.
//
// Two kinds of value:
//   game  lives on the game's own ConfigManager (volumes, text skip, ...). Read and written in place, so every
//         existing game system keeps working unchanged and saves stay compatible with the original options screen.
//   port  belongs to this browser port (render quality, fast-forward, ...) or to a mod. Kept in a small bag that is
//         saved inside the game's config file under "omoriWeb", so it follows the player's profile like everything else.

export type TabId = 'general' | 'display' | 'audio' | 'controls' | 'accessibility' | 'mods' | 'system';

export const TABS: { id: TabId; label: string }[] = [
    { id: 'general', label: 'Gameplay' },
    { id: 'display', label: 'Display' },
    { id: 'audio', label: 'Audio' },
    { id: 'controls', label: 'Controls' },
    { id: 'accessibility', label: 'Accessibility' },
    { id: 'mods', label: 'Mods' },
    { id: 'system', label: 'System' },
];

export type Choice = { value: string | number; label: string };

export type Control =
    | { type: 'toggle'; get(): boolean; set(v: boolean): void }
    | { type: 'slider'; min: number; max: number; step: number; unit?: string; get(): number; set(v: number): void; /** runs when the thumb is released, e.g. to play a sample sound */ preview?(): void }
    | { type: 'choice'; options: Choice[]; get(): string | number; set(v: string | number): void }
    | { type: 'action'; button: string; danger?: boolean; run(): void }
    | { type: 'keys' };

export interface Setting {
    id: string;
    tab: TabId;
    /** a heading to group related rows under */
    group?: string;
    label: string;
    help?: string;
    /** extra words the search box matches */
    keywords?: string;
    /** value used by "reset" (toggles, sliders, choices) */
    default?: boolean | number | string;
    control: Control;
    /** hide the row when not applicable (e.g. in-game-only actions) */
    visible?(): boolean;
    /** a short status shown under the help text, e.g. "applies on the next map" */
    note?(): string | undefined;
    /** mod id for settings added by a mod */
    owner?: string;
}

const settings: Setting[] = [];
const listeners = new Set<() => void>();

export const all = (): readonly Setting[] => settings;
export const onSettingsChanged = (fn: () => void) => { listeners.add(fn); return () => listeners.delete(fn); };
export const notify = () => listeners.forEach(f => f());

export function register(s: Setting): void {
    const i = settings.findIndex(x => x.id === s.id);
    if (i >= 0) settings[i] = s; else settings.push(s);
    notify();
}
export const unregisterOwner = (owner: string) => {
    for (let i = settings.length - 1; i >= 0; i--) if (settings[i]!.owner === owner) settings.splice(i, 1);
    notify();
};

// ---------------------------------------------------------------- the port bag
const bag: Record<string, unknown> = {};
const appliers = new Map<string, (v: any) => void>();
let loaded = false;     // ConfigManager has applied its data at least once
let saveTimer: ReturnType<typeof setTimeout> | undefined;

/** Save the game config shortly after the last change (sliders fire many times while dragging). */
export function scheduleSave() {
    if (!loaded) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { try { (globalThis as any).ConfigManager.save(); } catch (e) { console.warn('[settings] could not save config', e); } }, 400);
}

export interface PortSetting<T> { get(): T; set(v: T): void; readonly key: string }

/** A value stored in the port bag. `apply` runs on load and on every change, so the setting takes effect immediately. */
export function portValue<T extends boolean | number | string>(key: string, def: T, apply?: (v: T) => void): PortSetting<T> {
    if (apply) appliers.set(key, v => apply(v === undefined ? def : (v as T)));
    return {
        key,
        get: () => (key in bag ? (bag[key] as T) : def),
        set(v: T) { bag[key] = v; try { apply?.(v); } catch (e) { console.error(`[settings] applying ${key}`, e); } scheduleSave(); notify(); },
    };
}

/** Called by the ConfigManager wrapper. */
export const exportBag = () => ({ ...bag });
export function importBag(data: unknown) {
    for (const k of Object.keys(bag)) delete bag[k];
    if (data && typeof data === 'object') Object.assign(bag, data);
    loaded = true;
    for (const [k, fn] of appliers) { try { fn(k in bag ? bag[k] : undefined); } catch (e) { console.error(`[settings] applying ${k}`, e); } }
    notify();
}
export const peek = (key: string): unknown => bag[key];
export const isLoaded = () => loaded;
