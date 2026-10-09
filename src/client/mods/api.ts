import { isLoaded, portValue, register, type Choice } from '../settings/registry.ts';

// window.OmoriMod: the API mod scripts program against, plus error capture that blames the right mod.
// Everything a mod does through this API is wrapped so one broken mod logs an error instead of killing the game.

export interface ErrorEntry { mod: string; message: string; stack?: string; time: number; count: number; level: 'error' | 'warn' }
type Listener = (...args: any[]) => void;

const MOD_URL = /omori-mod:\/\/([^/\s)]+)\/([^\s:)]*)/;
const MAX_HOOK_ERRORS = 10;

export const errors: ErrorEntry[] = [];
const errorSubs = new Set<() => void>();
export const onErrors = (fn: () => void) => { errorSubs.add(fn); return () => errorSubs.delete(fn); };

let current: { id: string; file: string } | null = null; // script being executed right now
export const setCurrent = (c: typeof current) => { current = c; };

const events = new Map<string, Set<{ fn: Listener; mod: string }>>();
const commands = new Map<string, { fn: (args: string[], interp: any) => void; mod: string }>();
let commandsInstalled = false;
const hookErrors = new WeakMap<object, number>();

/** Which mod does this stack trace / file name belong to? */
export const blame = (text?: string): string | null => MOD_URL.exec(text ?? '')?.[1] ?? null;

function send(level: string, mod: string, message: string) {
    try { void fetch('/__mods/log', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ level, mod, message }), keepalive: true }); } catch { /* offline */ }
}

export function report(mod: string, err: unknown, context = '', level: 'error' | 'warn' = 'error') {
    const e = err instanceof Error ? err : new Error(String(err));
    const message = (context ? `${context}: ` : '') + e.message;
    const last = errors[errors.length - 1];
    if (last && last.mod === mod && last.message === message && Date.now() - last.time < 2000) { last.count++; last.time = Date.now(); }
    else {
        errors.push({ mod, message, stack: e.stack, time: Date.now(), count: 1, level });
        if (errors.length > 200) errors.shift();
        send(level, mod, e.stack ? `${message}\n${e.stack}` : message);
    }
    (level === 'error' ? origConsole.error : origConsole.warn)(`[mod:${mod}]`, message, e.stack ?? '');
    errorSubs.forEach(f => f());
}

const origConsole = { error: console.error.bind(console), warn: console.warn.bind(console) };

function emit(event: string, ...args: unknown[]) {
    for (const l of [...(events.get(event) ?? [])]) {
        try { l.fn(...args); } catch (e) { report(l.mod, e, `handler for "${event}"`); }
    }
}

function installCommands() {
    if (commandsInstalled) return;
    const GI = (globalThis as any).Game_Interpreter;
    if (!GI) return;
    commandsInstalled = true;
    const orig = GI.prototype.pluginCommand;
    GI.prototype.pluginCommand = function (this: any, command: string, args: string[]) {
        const c = commands.get(String(command).toLowerCase());
        if (c) {
            try { c.fn(args, this); } catch (e) { report(c.mod, e, `plugin command "${command}"`); }
            return;
        }
        return orig?.call(this, command, args);
    };
}

function hook(target: any, method: string, fn: (orig: (...a: any[]) => any, ...args: any[]) => any, mod: string) {
    const orig = target?.[method];
    if (typeof orig !== 'function') {
        report(mod, new Error(`cannot hook ${target?.name ?? target?.constructor?.name ?? 'target'}.${method}: it is not a function (typo, or the game changed?)`));
        return () => {};
    }
    const key = {};
    const wrapper = function (this: any, ...args: any[]) {
        if ((hookErrors.get(key) ?? 0) >= MAX_HOOK_ERRORS) return orig.apply(this, args);
        let called = false, result: unknown;
        const callOrig = (...a: any[]) => { called = true; result = orig.apply(this, a.length ? a : args); return result; };
        try { return fn.call(this, callOrig, ...args); }
        catch (e) {
            const n = (hookErrors.get(key) ?? 0) + 1;
            hookErrors.set(key, n);
            report(mod, e, `hook ${method}${n >= MAX_HOOK_ERRORS ? ` (disabled after ${n} errors)` : ''}`);
            return called ? result : orig.apply(this, args);
        }
    };
    target[method] = wrapper;
    return () => { if (target[method] === wrapper) target[method] = orig; };
}

type SettingDef =
    | { id: string; label: string; help?: string; type: 'toggle'; default: boolean; onChange?(v: boolean): void }
    | { id: string; label: string; help?: string; type: 'slider'; default: number; min: number; max: number; step?: number; unit?: string; onChange?(v: number): void }
    | { id: string; label: string; help?: string; type: 'choice'; default: string | number; options: Choice[]; onChange?(v: string | number): void }
    | { id: string; label: string; help?: string; type: 'action'; button: string; run(): void };

export interface ScopedApi {
    /** Add a setting to the Settings screen (Mods tab). Stored with the player's other settings, per profile. */
    settings: { add<T extends boolean | number | string>(def: SettingDef): { get(): T; set(v: T): void } };
    id: string;
    log(...a: unknown[]): void;
    warn(...a: unknown[]): void;
    error(err: unknown, context?: string): void;
    on(event: string, fn: Listener): () => void;
    hook(target: any, method: string, fn: (orig: (...a: any[]) => any, ...args: any[]) => any): () => void;
    command(name: string, fn: (args: string[], interp: any) => void): void;
    /** Run `fn`; if it throws, report it against this mod and carry on. */
    safe<T>(fn: () => T, context?: string): T | undefined;
}

function scoped(mod: string): ScopedApi {
    return {
        id: mod,
        log: (...a) => console.log(`[mod:${mod}]`, ...a),
        warn: (...a) => report(mod, new Error(a.map(String).join(' ')), '', 'warn'),
        error: (err, ctx) => report(mod, err, ctx),
        on(event, fn) {
            const l = { fn, mod };
            (events.get(event) ?? events.set(event, new Set()).get(event)!).add(l);
            return () => events.get(event)?.delete(l);
        },
        hook: (t, m, fn) => hook(t, m, fn, mod),
        command(name, fn) { installCommands(); commands.set(name.toLowerCase(), { fn, mod }); },
        safe(fn, ctx) { try { return fn(); } catch (e) { report(mod, e, ctx); return undefined; } },
        settings: {
            add(def: SettingDef) {
                if (def.type === 'action') {
                    const run = () => { try { def.run(); } catch (e) { report(mod, e, `action "${def.id}"`); } };
                    register({ id: `${mod}.${def.id}`, tab: 'mods' as const, group: mod, label: def.label, help: def.help, control: { type: 'action', button: def.button, run }, owner: mod });
                    return { get: () => undefined, set: () => {} } as any;
                }
                const guard = (fn?: (v: any) => void) => (v: any) => { try { fn?.(v); } catch (e) { report(mod, e, `onChange for setting "${def.id}"`); } };
                const v = portValue<any>(`mod.${mod}.${def.id}`, def.default, guard(def.onChange));
                const base = { id: `${mod}.${def.id}`, tab: 'mods' as const, group: mod, label: def.label, help: def.help, default: def.default as boolean | number | string, owner: mod };
                if (def.type === 'toggle') register({ ...base, control: { type: 'toggle', get: v.get, set: v.set } });
                else if (def.type === 'slider') register({ ...base, control: { type: 'slider', min: def.min, max: def.max, step: def.step ?? 1, unit: def.unit, get: v.get, set: v.set } });
                else register({ ...base, control: { type: 'choice', options: def.options, get: v.get, set: v.set } });
                if (isLoaded()) guard(def.onChange)(v.get()); // saved value already known: apply it now
                return v as any;
            },
        },
    };
}

export interface ModInfo { id: string; name: string; version: string; enabled: boolean }
export const modInfo: ModInfo[] = [];

export const OmoriMod = {
    apiVersion: 1,
    mods: modInfo,
    /** API bound to the calling mod (call it at the top of your script so errors are attributed to you). */
    scope(id?: string): ScopedApi {
        const mod = id ?? current?.id ?? blame(new Error().stack) ?? '(unknown)';
        return scoped(mod);
    },
    emit,
    has: (id: string) => modInfo.some(m => m.id === id && m.enabled),
};

/** Game-level events mods can subscribe to with scope().on(...). Installed once the game's plugins have loaded. */
export function installGameEvents() {
    const g = globalThis as any;
    const wrap = (target: any, method: string, event: string, pick: (...a: any[]) => unknown[]) => {
        if (typeof target?.[method] !== 'function') return;
        const orig = target[method];
        target[method] = function (this: any, ...a: any[]) {
            const r = orig.apply(this, a);
            emit(event, ...pick.apply(this, a as any));
            return r;
        };
    };
    wrap(g.SceneManager, 'goto', 'scene:goto', (cls: any) => [cls?.name]);
    wrap(g.Game_Map?.prototype, 'setup', 'map:setup', (id: number) => [id]);
    wrap(g.DataManager, 'setupNewGame', 'game:new', () => []);
    wrap(g.DataManager, 'extractSaveContents', 'game:load', () => []);
    wrap(g.DataManager, 'makeSaveContents', 'game:save', () => []);
}

/** Global error capture: blame the mod named in the stack, otherwise log it as a game error. */
export function installErrorCapture() {
    window.addEventListener('error', ev => {
        const mod = blame(ev.filename) ?? blame(ev.error?.stack) ?? current?.id ?? '(game)';
        report(mod, ev.error ?? new Error(ev.message), ev.filename && !blame(ev.filename) ? `at ${ev.filename}:${ev.lineno}` : '');
    });
    window.addEventListener('unhandledrejection', ev => {
        const stack = (ev.reason as Error | undefined)?.stack;
        report(blame(stack) ?? '(game)', ev.reason, 'unhandled promise rejection');
    });
    let busy = false;
    for (const lvl of ['error', 'warn'] as const) {
        const o = origConsole[lvl];
        console[lvl] = (...args: unknown[]) => {
            o(...args);
            if (busy) return;
            busy = true;
            try {
                const text = args.map(a => (a instanceof Error ? a.stack ?? a.message : typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
                if (!text.startsWith('[mod:')) send(lvl, blame(text) ?? '(game)', text.slice(0, 2000));
            } catch { /* never let logging break the game */ } finally { busy = false; }
        };
    }
}

(globalThis as any).OmoriMod = OmoriMod;
