// Checkpoints: named snapshots of the whole running game, stored per profile in IndexedDB.
// A checkpoint holds the same data a normal save would (DataManager.makeSaveContents, gzipped), plus a readable digest
// used for diffing. Restoring goes through the game's own load path and always takes an "undo" checkpoint first.
// Also here: the "story beat" recorder (auto-checkpoints the first time each story switch turns on) and
// checkpoints shipped by mods (OmoriMod.checkpoints.register).
import { diffDigests, makeDigest, type Change, type Digest } from './checkpoint-core.ts';
import { getActiveProfile } from './mods/store.ts';
import { portValue, register } from './settings/registry.ts';
import type { StoryIndex } from '../mods/storyscan.ts';
import { ENDING_FLAGS, PHASE_FLAGS, SPINE_SWITCH, coverage, describe, routeKey, routeLabel, signature } from './story-model.ts';

export interface Checkpoint {
    id: string;
    name: string;
    time: number;
    digest: Digest;
    z?: Uint8Array;         // gzipped JsonEx save contents (current format)
    save?: string;          // plain JsonEx string (old checkpoints and imports)
    auto?: boolean;         // made by the system (e.g. "before restore")
    beat?: boolean;         // recorded automatically at a story beat
    forged?: string;        // made by patching another checkpoint: a description of the patch
    provided?: string;      // id of the mod that shipped it (read-only, lives in memory)
}

const STORE = 'checkpoints';
const MAX_AUTO = 10;
const MAX_BEATS = 200;

let dbPromise: Promise<IDBDatabase> | null = null;
async function db(): Promise<IDBDatabase> {
    if (!dbPromise) {
        dbPromise = (async () => {
            const p = await getActiveProfile().catch(() => null);
            const name = 'omori-checkpoints' + (p && p.id !== 'default' ? ':' + p.id : '');
            return new Promise<IDBDatabase>((res, rej) => {
                const r = indexedDB.open(name, 1);
                r.onupgradeneeded = () => r.result.createObjectStore(STORE, { keyPath: 'id' });
                r.onsuccess = () => res(r.result);
                r.onerror = () => rej(r.error);
            });
        })();
        dbPromise.catch(() => { dbPromise = null; });
    }
    return dbPromise;
}
async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    const d = await db();
    return new Promise((res, rej) => {
        const r = fn(d.transaction(STORE, mode).objectStore(STORE));
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
    });
}

const g = globalThis as any;
export const gameRunning = () => !!(g.$gameParty && g.$gamePlayer && g.$gameSwitches && g.$gameMap && g.DataManager);

// ------------------------------------------------------------------ compression
const gzip = async (text: string): Promise<Uint8Array> => new Uint8Array(await new Response(new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer());
const gunzip = async (b: Uint8Array): Promise<string> => new Response(new Blob([b as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip'))).text();
const toB64 = (b: Uint8Array) => { let s = ''; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000)); return btoa(s); };
const fromB64 = (s: string) => Uint8Array.from(atob(s), c => c.charCodeAt(0));

/** The JsonEx save text of a checkpoint, whichever way it is stored. */
export async function saveText(cp: Checkpoint): Promise<string> {
    if (cp.z) return gunzip(cp.z);
    if (typeof cp.save === 'string') return cp.save;
    throw new Error(`checkpoint "${cp.name}" has no save data`);
}

// ------------------------------------------------------------------ storage
const provided = new Map<string, Checkpoint>();   // shipped by mods, in memory only

export async function listCheckpoints(): Promise<Checkpoint[]> {
    const all = (await tx('readonly', s => s.getAll())) as Checkpoint[];
    return [...all, ...provided.values()].sort((a, b) => b.time - a.time);
}
export const getCheckpoint = (id: string) => provided.has(id) ? Promise.resolve(provided.get(id)) : tx('readonly', s => s.get(id)) as Promise<Checkpoint | undefined>;
export async function deleteCheckpoint(id: string): Promise<void> {
    if (provided.has(id)) throw new Error('this checkpoint is provided by a mod; disable the mod to remove it');
    await tx('readwrite', s => s.delete(id));
}

const newId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

export async function captureCheckpoint(name: string, opts: { auto?: boolean; beat?: boolean } = {}): Promise<Checkpoint> {
    if (!gameRunning()) throw new Error('no game is running');
    g.$gameSystem?.onBeforeSave?.(); // what a real save does: records BGM/BGS and frame count for onAfterLoad
    const text = g.JsonEx.stringify(g.DataManager.makeSaveContents());
    const cp: Checkpoint = {
        id: newId(), name: name.trim() || new Date().toLocaleString(), time: Date.now(),
        digest: makeDigest(g), z: await gzip(text), auto: opts.auto, beat: opts.beat,
    };
    await tx('readwrite', s => s.put(cp));
    const prune = async (pick: (c: Checkpoint) => boolean, keep: number) => {
        const old = (await listCheckpoints()).filter(c => !c.provided && pick(c));
        for (const o of old.slice(keep)) await deleteCheckpoint(o.id);
    };
    if (opts.auto) await prune(c => !!c.auto, MAX_AUTO);   // keep only the newest few automatic ones
    if (opts.beat) await prune(c => !!c.beat, MAX_BEATS);
    return cp;
}

/** Changes from `from` to `to`; `to` defaults to the live game. */
export function diffCheckpoint(from: Checkpoint, to?: Checkpoint): Change[] {
    return diffDigests(from.digest, to ? to.digest : makeDigest(g));
}

/**
 * Put the game into the state of `cp`. Order matters for safety: validate first, take an undo checkpoint,
 * then swap state, and if anything goes wrong after the swap, put the previous state back.
 */
export async function restoreCheckpoint(cp: Checkpoint): Promise<void> {
    if (!g.DataManager || !g.SceneManager) throw new Error('game is not ready');
    const text = await saveText(cp);
    let contents: any;
    try { contents = g.JsonEx.parse(text); } catch (e) { throw new Error(`checkpoint "${cp.name}" is corrupt: ${(e as Error).message}`); }
    for (const k of ['system', 'switches', 'variables', 'party', 'map', 'player', 'actors']) {
        if (!contents?.[k]) throw new Error(`checkpoint "${cp.name}" is missing "${k}"; not restoring`);
    }
    const undo = gameRunning() ? await captureCheckpoint(`before restoring "${cp.name}"`, { auto: true }) : null;
    try {
        g.DataManager.createGameObjects();
        g.DataManager.extractSaveContents(g.JsonEx.parse(text));
        g.$gameSystem?.onAfterLoad?.();
        // Same step the game takes after loading a save: reload the map and enter it.
        g.$gamePlayer.reserveTransfer(g.$gameMap.mapId(), g.$gamePlayer.x, g.$gamePlayer.y, g.$gamePlayer.direction(), 2);
        g.$gamePlayer.requestMapReload?.();
        g.SceneManager.goto(g.Scene_Map);
    } catch (e) {
        if (undo) { try { g.DataManager.createGameObjects(); g.DataManager.extractSaveContents(g.JsonEx.parse(await saveText(undo))); g.SceneManager.goto(g.Scene_Map); } catch { /* nothing more we can do */ } }
        throw new Error(`restore failed (${(e as Error).message}); previous state put back`);
    }
}

// ------------------------------------------------------------------ forging: derive a route state from a recorded one
export interface Patch {
    /** switch id or exact name -> value */
    switches?: Record<string, boolean>;
    /** variable id or exact name -> value */
    variables?: Record<string, number>;
}

const resolveId = (list: (string | null)[] | undefined, key: string, what: string): number => {
    if (/^\d+$/.test(key)) return Number(key);
    const hits = (list ?? []).flatMap((n, i) => (n === key ? [i] : []));
    if (hits.length !== 1) throw new Error(`${what} "${key}" ${hits.length ? 'matches several ids (' + hits.join(', ') + '); use the id' : 'does not exist'}`);
    return hits[0]!;
};

/** Scratch variables the game rewrites constantly ('Always Temporary #0'); they are never part of a route. */
const SCRATCH_VAR = /^(Always )?Temp(orary)?/i;
const sysName = (list: (string | null)[] | undefined, key: string) => list?.[Number(key)] ?? '';

/** Everything that differs between two checkpoints, as a patch that turns `from` into `to` (switches and variables only). */
export function patchBetween(from: Checkpoint, to: Checkpoint): Patch {
    const patch: Patch = { switches: {}, variables: {} };
    for (const c of diffDigests(from.digest, to.digest)) {
        if (c.section === 'switch') patch.switches![c.key] = !!c.to;
        else if (c.section === 'variable' && (typeof c.to === 'number' || c.to === null) && !SCRATCH_VAR.test(sysName(g.$dataSystem?.variables, c.key))) patch.variables![c.key] = (c.to as number | null) ?? 0;
    }
    return patch;
}

/**
 * Make a new checkpoint by applying `patch` to a copy of `base`. The base is never modified. The result is tagged as
 * forged: it is exactly as consistent as the flags you changed, so verify it by playing a little from it.
 */
export async function forgeCheckpoint(base: Checkpoint, patch: Patch, name: string): Promise<Checkpoint> {
    const contents = g.JsonEx.parse(await saveText(base));
    const names = dbNames();
    const done: string[] = [];
    for (const [k, v] of Object.entries(patch.switches ?? {})) { const id = resolveId(names.switches, k, 'switch'); contents.switches.setValue(id, !!v); done.push(`s${id}=${v ? 'ON' : 'off'}`); }
    for (const [k, v] of Object.entries(patch.variables ?? {})) { const id = resolveId(names.variables, k, 'variable'); contents.variables.setValue(id, Number(v)); done.push(`v${id}=${v}`); }
    if (!done.length) throw new Error('the patch changes nothing');
    const digest = makeDigest({ $gameSwitches: contents.switches, $gameVariables: contents.variables, $gameSelfSwitches: contents.selfSwitches, $gameSelfVariables: contents.selfVariables, $gameParty: contents.party, $gameActors: contents.actors, $gameMap: contents.map, $gamePlayer: contents.player });
    const cp: Checkpoint = { id: newId(), name: name.trim() || `${base.name} (forged)`, time: Date.now(), digest, z: await gzip(g.JsonEx.stringify(contents)), forged: `from "${base.name}": ${done.slice(0, 12).join(', ')}${done.length > 12 ? ` (+${done.length - 12})` : ''}` };
    await tx('readwrite', s => s.put(cp));
    return cp;
}

// ------------------------------------------------------------------ files and mod-shipped checkpoints
interface FileForm { format: 'omori-checkpoint'; version: 2; name: string; time?: number; digest: Digest; saveGz: string }

export async function exportCheckpoint(cp: Checkpoint): Promise<string> {
    const z = cp.z ?? await gzip(await saveText(cp));
    const f: FileForm = { format: 'omori-checkpoint', version: 2, name: cp.name, time: cp.time, digest: cp.digest, saveGz: toB64(z) };
    return JSON.stringify(f);
}

/** A mod-loadable script: `OmoriMod.checkpoints.register(...)` with the checkpoint inlined. */
export async function exportCheckpointScript(cp: Checkpoint): Promise<string> {
    return `// Generated by the checkpoint panel. Ship this in a mod's scripts/ folder.\n(() => { OmoriMod.checkpoints.register(${JSON.stringify(cp.name)}, ${await exportCheckpoint(cp)}); })();\n`;
}

async function fromFileForm(o: any, id: string, extra: Partial<Checkpoint> = {}): Promise<Checkpoint> {
    if (o?.format !== 'omori-checkpoint' || !o.digest) throw new Error('not an OMORI checkpoint file');
    const cp: Checkpoint = { id, name: String(o.name ?? 'imported'), time: Date.now(), digest: o.digest, ...extra };
    if (typeof o.saveGz === 'string') cp.z = fromB64(o.saveGz);
    else if (typeof o.save === 'string') cp.save = o.save;           // version 1 files
    else throw new Error('checkpoint file has no save data');
    g.JsonEx.parse(await saveText(cp)); // must at least parse
    return cp;
}

export async function importCheckpoint(text: string): Promise<Checkpoint> {
    const cp = await fromFileForm(JSON.parse(text), newId());
    await tx('readwrite', s => s.put(cp));
    return cp;
}

// ------------------------------------------------------------------ story beats
/** A switch that marks story progress: the authored spine, the late-game phase flags, and the endings (see story-model.ts). */
export const isBeatSwitch = (name: string) => SPINE_SWITCH.test(name) || PHASE_FLAGS.includes(name) || ENDING_FLAGS.includes(name);
/** Route counters that only go up as a route advances; each new high is a beat too ("BS_TRUE_PATH 7"). */
const BEAT_COUNTERS = ['[BS_NEUTRAL_PATH]', '[BS_TRUE_PATH]'];

let beatSetting: { get(): boolean; set(v: boolean): void } | null = null;

export function installBeatRecorder(): void {
    const on = beatSetting = portValue<boolean>('checkpoints.recordBeats', false, () => {});
    register({
        id: 'checkpoints.recordBeats', tab: 'general', group: 'Checkpoints', label: 'Record story beats as checkpoints', default: false,
        help: 'The first time each story event happens (Day1FA - Hobbeez, Day2DW - Swim, ...), save a checkpoint named [beat] <event>. One normal playthrough builds a library you can jump between from the debug panel (F9).',
        keywords: 'checkpoint story chapter skip', control: { type: 'toggle', get: on.get, set: on.set },
    });
    const GS = g.Game_Switches?.prototype, SM = g.Scene_Map?.prototype;
    if (!GS?.setValue || !SM?.update) return;
    const queued = new Map<number, string>();
    let known: Set<string> | null = null, busy = false;

    const setValue = GS.setValue;
    GS.setValue = function (this: any, id: number, v: unknown) {
        const was = this.value(id);
        const r = setValue.apply(this, arguments as any);
        if (v && !was && on.get()) {
            const name = g.$dataSystem?.switches?.[id];
            if (typeof name === 'string' && isBeatSwitch(name)) queued.set(id, name.trim());
        }
        return r;
    };
    const GV = g.Game_Variables?.prototype;
    if (GV?.setValue) {
        const setVar = GV.setValue, maxSeen = new Map<number, number>();
        GV.setValue = function (this: any, id: number, v: unknown) {
            const r = setVar.apply(this, arguments as any);
            if (on.get() && typeof v === 'number' && v > 0) {
                const name = g.$dataSystem?.variables?.[id];
                if (BEAT_COUNTERS.includes(name) && v > (maxSeen.get(id) ?? 0)) { maxSeen.set(id, v); queued.set(-id, `${name.slice(1, -1)} ${v}`); }
            }
            return r;
        };
    }
    // Capture only when nothing is mid-flight (an event running or a message showing), so the saved state is a stable one.
    const update = SM.update;
    SM.update = function (this: any) {
        const r = update.apply(this, arguments as any);
        if (queued.size && !busy && on.get() && !g.$gameMap.isEventRunning() && !g.$gameMessage?.isBusy?.() && !g.$gamePlayer.isTransferring()) {
            busy = true;
            const names = [...queued.values()]; queued.clear();
            (async () => {
                known ??= new Set((await listCheckpoints()).map(c => c.name));
                const fresh = names.filter(n => !known!.has(`[beat] ${n}`));
                if (fresh.length) { for (const n of fresh) known!.add(`[beat] ${n}`); await captureCheckpoint(`[beat] ${fresh[0]}`, { beat: true }); }
            })().catch(e => console.warn('[checkpoints] beat capture failed', e)).finally(() => { busy = false; });
        }
        return r;
    };
}

// ------------------------------------------------------------------ routes: where a state is in the story, and what a library covers
const dbNames = () => ({ switches: g.$dataSystem?.switches, variables: g.$dataSystem?.variables });
export const checkpointSignature = (cp: Checkpoint) => signature(cp.digest, dbNames());
export const describeCheckpoint = (cp: Checkpoint) => describe(checkpointSignature(cp));
export const checkpointRoute = (cp: Checkpoint) => routeLabel(checkpointSignature(cp));

let storyP: Promise<StoryIndex | null> | null = null;
/** The story's flags as scanned from this install by the dev server (null if unavailable). Fetched once. */
export const loadStory = () => (storyP ??= fetch('/__story.json').then(r => (r.ok ? (r.json() as Promise<StoryIndex>) : null)).catch(() => null));
/** Names of the story-progress switches that some event actually turns on (the rest are reserved names that can never happen). */
export const settableBeats = (ix: StoryIndex) => [...ix.spine, ...ix.phase, ...ix.endings].filter(f => f.setCount > 0).map(f => f.name.trim());

export async function beatCoverage() {
    const ix = await loadStory();
    if (!ix) return null;
    return coverage((await listCheckpoints()).filter(c => c.beat || !c.auto).map(c => c.name), settableBeats(ix));
}

/** Group checkpoints into route lines (same story decisions so far), each ordered by how far along the story they are. */
export function routeLines(cps: Checkpoint[]): { key: string; label: string; items: Checkpoint[] }[] {
    const groups = new Map<string, { key: string; label: string; items: Checkpoint[] }>();
    for (const c of cps) {
        const sig = checkpointSignature(c), key = routeKey(sig);
        (groups.get(key) ?? groups.set(key, { key, label: routeLabel(sig), items: [] }).get(key)!).items.push(c);
    }
    for (const gr of groups.values()) gr.items.sort((a, b) => (checkpointSignature(a).last?.id ?? 0) - (checkpointSignature(b).last?.id ?? 0));
    return [...groups.values()];
}

// ------------------------------------------------------------------ mod API
/** `OmoriMod.checkpoints`: the same operations as the debug panel, for mod scripts and automated tests. */
export function installCheckpointApi(): void {
    const byName = async (nameOrId: string) => {
        const all = await listCheckpoints();
        const hit = all.find(c => c.id === nameOrId) ?? all.find(c => c.name === nameOrId);
        if (!hit) throw new Error(`no checkpoint named "${nameOrId}"`);
        return hit;
    };
    (g.OmoriMod ?? (g.OmoriMod = {})).checkpoints = {
        capture: async (name: string) => { const c = await captureCheckpoint(name); return { id: c.id, name: c.name }; },
        list: async () => (await listCheckpoints()).map(c => ({ id: c.id, name: c.name, time: c.time, auto: !!c.auto, beat: !!c.beat, forged: c.forged ?? null, provided: c.provided ?? null, map: c.digest.map.id })),
        restore: async (nameOrId: string) => restoreCheckpoint(await byName(nameOrId)),
        diff: async (nameOrId: string) => diffCheckpoint(await byName(nameOrId)),
        remove: async (nameOrId: string) => deleteCheckpoint((await byName(nameOrId)).id),
        /** Is automatic story-beat recording on? Pass true/false to change it (same as the Gameplay setting). */
        recordBeats: (v?: boolean) => { if (v !== undefined) beatSetting?.set(v); return !!beatSetting?.get(); },
        /** What differs between two checkpoints (or one checkpoint and the running game when `b` is omitted), as a patch of switches/variables. */
        compare: async (a: string, b?: string) => { const A = await byName(a); return b ? patchBetween(A, await byName(b)) : patchBetween(A, { ...A, digest: makeDigest(g) }); },
        /** New checkpoint = a copy of `base` with switches/variables changed. Keys are ids or exact names. Tagged "forged". */
        forge: async (base: string, patch: Patch, name: string) => { const c = await forgeCheckpoint(await byName(base), patch, name); return { id: c.id, name: c.name, forged: c.forged }; },
        routes: {
            /** story position of the running game: furthest spine beat, route label, counters, endings */
            current: () => { const d = makeDigest(g), sig = signature(d, dbNames()); return { ...sig, route: routeLabel(sig), text: describe(sig) }; },
            /** how many of the story's beats this profile's checkpoints cover, and which are missing (null without the dev server) */
            coverage: () => beatCoverage(),
            /** checkpoints grouped into route lines, each ordered along the story */
            lines: async () => routeLines(await listCheckpoints()).map(l => ({ route: l.label, checkpoints: l.items.map(c => ({ id: c.id, name: c.name, at: describeCheckpoint(c) })) })),
        },
        /** Make a checkpoint (in the file format the panel exports) available to the player; lives for this session, from the calling mod. */
        register: (name: string, data: unknown) => {
            const mod = g.OmoriMod.scope?.().id ?? '(mod)';
            void fromFileForm(data, `mod:${mod}:${name}`, { name, provided: mod, time: 0 })
                .then(cp => { provided.set(cp.id, cp); })
                .catch(e => g.OmoriMod.scope?.(mod).error?.(e, `checkpoint "${name}"`));
        },
    };
}
