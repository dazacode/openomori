// Types for mod scripts. Reference from a mod folder with:  /// <reference path="../../types/omori-mod.d.ts" />
// The game's own classes (Game_Party, Scene_Map, $gameVariables, ...) are RPG Maker MV globals, typed as `any` here.

interface OmoriModScope {
    /** your mod id (from mod.json) */
    readonly id: string;
    log(...args: unknown[]): void;
    /** shows in the Mods panel (yellow) and latest.log */
    warn(...args: unknown[]): void;
    /** report a caught error against your mod (red badge, latest.log) */
    error(err: unknown, context?: string): void;
    /**
     * Game events: 'map:setup' (mapId), 'scene:goto' (sceneName), 'game:new', 'game:load', 'game:save'.
     * Handlers that throw are reported and skipped. Returns an unsubscribe function.
     */
    on(event: 'map:setup', fn: (mapId: number) => void): () => void;
    on(event: 'scene:goto', fn: (sceneName: string) => void): () => void;
    on(event: 'game:new' | 'game:load' | 'game:save', fn: () => void): () => void;
    on(event: string, fn: (...args: any[]) => void): () => void;
    /**
     * Wrap a game method. `orig` calls the original (same arguments if you pass none). If your wrapper throws, the error is
     * reported and the original behaviour runs instead; after 10 errors the hook switches itself off.
     * Returns a function that removes the hook.
     */
    hook<T extends object, K extends keyof T>(target: T, method: K & string, fn: (this: any, orig: (...args: any[]) => any, ...args: any[]) => any): () => void;
    /** Register an event "Plugin Command": the command name is matched case-insensitively. */
    command(name: string, fn: (args: string[], interpreter: any) => void): void;
    /** Run fn; a throw is reported against your mod and swallowed. */
    safe<T>(fn: () => T, context?: string): T | undefined;
    /** Add settings to the Settings screen (Mods tab). Values are saved with the player's config, per profile. */
    readonly settings: {
        add(def: OmoriModSettingDef & { type: 'toggle' }): { get(): boolean; set(v: boolean): void };
        add(def: OmoriModSettingDef & { type: 'slider' }): { get(): number; set(v: number): void };
        add(def: OmoriModSettingDef & { type: 'choice' }): { get(): string | number; set(v: string | number): void };
    };
}

type OmoriModSettingDef =
    | { id: string; label: string; help?: string; type: 'toggle'; default: boolean; onChange?(v: boolean): void }
    | { id: string; label: string; help?: string; type: 'slider'; default: number; min: number; max: number; step?: number; unit?: string; onChange?(v: number): void }
    | { id: string; label: string; help?: string; type: 'choice'; default: string | number; options: { value: string | number; label: string }[]; onChange?(v: string | number): void }
    /** a button on the Mods tab */
    | { id: string; label: string; help?: string; type: 'action'; button: string; run(): void };

interface OmoriModApi {
    readonly apiVersion: 1;
    /** every mod known to this session */
    readonly mods: { id: string; name: string; version: string; enabled: boolean }[];
    /** call at the top of a script to get an API bound to your mod id */
    scope(id?: string): OmoriModScope;
    /** is a mod with this id installed and enabled? (for soft dependencies) */
    has(id: string): boolean;
    /** fire a custom event for other mods to subscribe to with scope().on() */
    emit(event: string, ...args: unknown[]): void;
    /** Named snapshots of the whole running game (same as the debug panel's Checkpoints tab). Restoring first saves an automatic undo checkpoint. */
    readonly checkpoints: {
        capture(name: string): Promise<{ id: string; name: string }>;
        list(): Promise<{ id: string; name: string; time: number; auto: boolean; beat: boolean; forged: string | null; provided: string | null; map: number }[]>;
        restore(nameOrId: string): Promise<void>;
        diff(nameOrId: string): Promise<{ section: string; key: string; from: unknown; to: unknown }[]>;
        remove(nameOrId: string): Promise<void>;
        /** What differs between two checkpoints (or a checkpoint and the running game), as a patch { switches, variables } keyed by id. */
        compare(a: string, b?: string): Promise<{ switches?: Record<string, boolean>; variables?: Record<string, number> }>;
        /** A new checkpoint made by copying `base` and changing switches/variables (keys are ids or exact names). Tagged forged; the base is untouched. */
        forge(base: string, patch: { switches?: Record<string, boolean>; variables?: Record<string, number> }, name: string): Promise<{ id: string; name: string; forged: string }>;
        /** Where the game is in the story, which route the flags say it is on, and how well this profile's checkpoints cover the story. */
        readonly routes: {
            current(): { last: { id: number; name: string } | null; spineOn: number; phase: string[]; endings: string[]; counters: Record<string, number>; savedBasil: boolean; world: string | null; route: 'true' | 'neutral' | 'undecided'; text: string };
            coverage(): Promise<{ recorded: number; total: number; missing: string[] } | null>;
            lines(): Promise<{ route: string; checkpoints: { id: string; name: string; at: string }[] }[]>;
        };
        /** Automatic story-beat recording (the Gameplay setting). Pass a boolean to change it; returns the current value. */
        recordBeats(v?: boolean): boolean;
        /** Offer a checkpoint file (as exported by the panel) to the player; call from a mod script. Use the panel's "script" button to generate the call. */
        register(name: string, data: unknown): void;
    };
}

declare const OmoriMod: OmoriModApi;
