// Persistent state in IndexedDB (shared by the page and the service worker, same origin):
//   mods      the library of installed mod zips (a mod can be used by several profiles)
//   profiles  Minecraft-launcher-style profiles: which mods are on, and which save storage to use
//   backups   automatic and manual snapshots of a profile's saves
//   meta      the active profile id
// Each profile's game saves live in their own database ("omori-fs" for the original profile, so existing
// saves are untouched), which is what makes trying a mod safe.
import { unzipSync, zipSync } from 'fflate';

export interface ModRecord {
    key: string;          // "browser:<id>" | "server:<label>"
    label: string;
    origin: 'browser' | 'server';
    zip: Uint8Array;
    stamp: string;
}

export interface Profile {
    id: string;
    name: string;
    created: number;
    /** keys of the mods switched on in this profile */
    enabled: string[];
    /** also enable every mod from the dev ./mods folder (for mod authors) */
    devAuto: boolean;
    /** IndexedDB database holding this profile's saves */
    fsDb: string;
}

export interface Backup { id: string; profile: string; profileName: string; time: number; reason: string; zip: Uint8Array; files: number }

export const DEFAULT_PROFILE = 'default';
const DB = 'omori-mods';
const DB_VERSION = 3;
const MAX_BACKUPS_PER_PROFILE = 5;

function open(): Promise<IDBDatabase> {
    return new Promise((res, rej) => {
        const r = indexedDB.open(DB, DB_VERSION);
        r.onupgradeneeded = () => {
            const db = r.result;
            for (const [name, opts] of [['mods', { keyPath: 'key' }], ['profiles', { keyPath: 'id' }], ['backups', { keyPath: 'id' }], ['meta', undefined], ['gen', undefined], ['olidcache', undefined]] as const) {
                if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, opts);
            }
        };
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error ?? new Error('cannot open the mod database (private browsing?)'));
    });
}

const done = <T>(r: IDBRequest<T>) => new Promise<T>((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

async function tx<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    const db = await open();
    try { return await done(fn(db.transaction(store, mode).objectStore(store))); } finally { db.close(); }
}

// ---------------------------------------------------------------- mod library
const SUPPORT_PREFIX = 'support:';
/** Installed mods (support files, like the image-patch decoder, share the store but are not mods). */
export const listMods = async () => ((await tx('mods', 'readonly', s => s.getAll())) as ModRecord[]).filter(r => !r.key.startsWith(SUPPORT_PREFIX));
export const putMod = (rec: ModRecord) => tx('mods', 'readwrite', s => s.put(rec));

/** Helper files a pack ships (OneLoader's image decoder). Kept so image deltas keep working when mods are installed one by one. */
export const putSupport = (name: string, zip: Uint8Array) => putMod({ key: SUPPORT_PREFIX + name, label: name, origin: 'browser', zip, stamp: String(zip.length) });
export async function getSupport(name: string): Promise<Uint8Array | null> {
    const rec = (await tx('mods', 'readonly', s => s.get(SUPPORT_PREFIX + name))) as ModRecord | undefined;
    return rec?.zip ?? null;
}

// ---------------------------------------------------------------- small shared state
export const getMeta = <T>(key: string) => tx('meta', 'readonly', s => s.get(key)) as Promise<T | undefined>;
export const setMeta = (key: string, value: unknown) => tx('meta', 'readwrite', s => s.put(value, key));

/** Images patched at startup, stored so the service worker (a separate context) can serve them. Replaced wholesale on every boot. */
export async function replaceGenerated(files: Record<string, Uint8Array>): Promise<void> {
    const db = await open();
    try {
        await new Promise<void>((res, rej) => {
            const t = db.transaction('gen', 'readwrite'), st = t.objectStore('gen');
            st.clear();
            for (const [k, v] of Object.entries(files)) st.put(v.slice().buffer, k);
            t.oncomplete = () => res(); t.onerror = t.onabort = () => rej(t.error);
        });
    } finally { db.close(); }
}
export async function readGenerated(): Promise<Record<string, Uint8Array>> {
    const db = await open(), out: Record<string, Uint8Array> = {};
    try {
        await new Promise<void>((res, rej) => {
            const req = db.transaction('gen').objectStore('gen').openCursor();
            req.onsuccess = () => { const c = req.result; if (!c) return res(); out[String(c.key)] = new Uint8Array(c.value as ArrayBuffer); c.continue(); };
            req.onerror = () => rej(req.error);
        });
    } finally { db.close(); }
    return out;
}

/** Cache of finished image patches, keyed by what went in, so a 130-image pack is only patched once. */
export async function cacheGet(key: string): Promise<Uint8Array | null> {
    const v = (await tx('olidcache', 'readonly', s => s.get(key))) as ArrayBuffer | undefined;
    return v ? new Uint8Array(v) : null;
}
export const cachePut = (key: string, bytes: Uint8Array) => tx('olidcache', 'readwrite', s => s.put(bytes.slice().buffer, key));

export async function removeMod(key: string): Promise<void> {
    await tx('mods', 'readwrite', s => s.delete(key));
    for (const p of await listProfiles()) if (p.enabled.includes(key)) await saveProfile({ ...p, enabled: p.enabled.filter(k => k !== key) });
}

/** Mirror the dev ./mods folder into the library (adds new/changed, drops removed). Silent when the server has none. */
export async function syncServerMods(): Promise<void> {
    let list: { label: string; stamp: string }[];
    try {
        const r = await fetch('/__mods/list', { cache: 'no-store' });
        if (!r.ok) return;
        list = (await r.json()).mods;
    } catch { return; }
    const have = new Map((await listMods()).filter(r => r.origin === 'server').map(r => [r.label, r]));
    for (const m of list) {
        const old = have.get(m.label);
        have.delete(m.label);
        if (old?.stamp === m.stamp) continue;
        const r = await fetch('/__mods/pack?name=' + encodeURIComponent(m.label), { cache: 'no-store' });
        if (!r.ok) continue;
        await putMod({ key: 'server:' + m.label, label: m.label, origin: 'server', zip: new Uint8Array(await r.arrayBuffer()), stamp: m.stamp });
    }
    for (const stale of have.values()) await removeMod(stale.key);
}

// ---------------------------------------------------------------- profiles
const defaultProfile = (): Profile => ({ id: DEFAULT_PROFILE, name: 'Original game', created: 0, enabled: [], devAuto: false, fsDb: 'omori-fs' });

export async function listProfiles(): Promise<Profile[]> {
    const all = (await tx('profiles', 'readonly', s => s.getAll())) as Profile[];
    if (!all.some(p => p.id === DEFAULT_PROFILE)) { const d = defaultProfile(); await saveProfile(d); all.unshift(d); }
    return all.sort((a, b) => a.created - b.created);
}
export const saveProfile = (p: Profile) => tx('profiles', 'readwrite', s => s.put(p));

/** The profile this session runs as: `?profile=<id>` wins (and sticks), otherwise whatever was last active. */
export async function getActiveProfile(): Promise<Profile> {
    const all = await listProfiles();
    const asked = new URLSearchParams(location.search).get('profile');
    const stored = (await tx('meta', 'readonly', s => s.get('active'))) as string | undefined;
    const pick = all.find(p => p.id === asked) ?? all.find(p => p.id === stored) ?? all.find(p => p.id === DEFAULT_PROFILE)!;
    if (pick.id !== stored) await setActiveProfile(pick.id);
    return pick;
}
export const setActiveProfile = (id: string) => tx('meta', 'readwrite', s => s.put(id, 'active'));

/** Keys of the mods that are switched on for `p`, including dev-folder mods when the profile wants them. */
export function enabledKeys(p: Profile, mods: ModRecord[]): Set<string> {
    const on = new Set(p.enabled);
    if (p.devAuto) for (const m of mods) if (m.origin === 'server') on.add(m.key);
    return on;
}

export async function createProfile(name: string, opts: { copySavesFrom?: string; enabled?: string[] } = {}): Promise<Profile> {
    const id = Math.random().toString(36).slice(2, 10);
    const p: Profile = { id, name: name.trim() || 'New profile', created: Date.now(), enabled: opts.enabled ?? [], devAuto: false, fsDb: 'omori-fs:' + id };
    if (opts.copySavesFrom) {
        const src = (await listProfiles()).find(x => x.id === opts.copySavesFrom);
        if (src) await writeAllFs(p.fsDb, await readAllFs(src.fsDb));
    }
    await saveProfile(p);
    return p;
}

export async function deleteProfile(id: string): Promise<void> {
    if (id === DEFAULT_PROFILE) throw new Error('the original profile cannot be deleted');
    const p = (await listProfiles()).find(x => x.id === id);
    if (!p) return;
    await makeBackup(p, 'before delete'); // saves of a deleted profile stay recoverable from Backups
    await tx('profiles', 'readwrite', s => s.delete(id));
    await new Promise<void>(res => { const r = indexedDB.deleteDatabase(p.fsDb); r.onsuccess = r.onerror = r.onblocked = () => res(); });
}

// ---------------------------------------------------------------- a profile's save storage
function openFs(name: string): Promise<IDBDatabase> {
    return new Promise((res, rej) => {
        const r = indexedDB.open(name, 1);
        r.onupgradeneeded = () => { if (!r.result.objectStoreNames.contains('f')) r.result.createObjectStore('f'); };
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
    });
}

/** Every saved file of a profile (deleted files are skipped). */
export async function readAllFs(dbName: string): Promise<Record<string, Uint8Array>> {
    const db = await openFs(dbName), out: Record<string, Uint8Array> = {};
    try {
        await new Promise<void>((res, rej) => {
            const req = db.transaction('f').objectStore('f').openCursor();
            req.onsuccess = () => {
                const c = req.result;
                if (!c) return res();
                if (c.value) out[String(c.key)] = new Uint8Array(c.value as ArrayBuffer);
                c.continue();
            };
            req.onerror = () => rej(req.error);
        });
    } finally { db.close(); }
    return out;
}

/** Replace a profile's saves with exactly these files. */
export async function writeAllFs(dbName: string, files: Record<string, Uint8Array>): Promise<void> {
    const db = await openFs(dbName);
    try {
        await new Promise<void>((res, rej) => {
            const t = db.transaction('f', 'readwrite'), s = t.objectStore('f');
            s.clear();
            for (const [k, v] of Object.entries(files)) s.put(v.slice().buffer, k);
            t.oncomplete = () => res();
            t.onerror = t.onabort = () => rej(t.error);
        });
    } finally { db.close(); }
}

// ---------------------------------------------------------------- backups
export async function makeBackup(p: Profile, reason: string): Promise<Backup | null> {
    const files = await readAllFs(p.fsDb);
    const n = Object.keys(files).length;
    if (!n) return null; // nothing worth keeping
    const b: Backup = { id: `${p.id}-${Date.now()}`, profile: p.id, profileName: p.name, time: Date.now(), reason, zip: zipSync(files, { level: 3 }), files: n };
    await tx('backups', 'readwrite', s => s.put(b));
    const mine = (await listBackups()).filter(x => x.profile === p.id);
    for (const old of mine.slice(MAX_BACKUPS_PER_PROFILE)) await tx('backups', 'readwrite', s => s.delete(old.id));
    return b;
}

/** Newest first. */
export async function listBackups(): Promise<Backup[]> {
    return ((await tx('backups', 'readonly', s => s.getAll())) as Backup[]).sort((a, b) => b.time - a.time);
}
export const deleteBackup = (id: string) => tx('backups', 'readwrite', s => s.delete(id));

/** Put a backup (or any saves zip) into `target`'s save storage, after backing up what is there now. */
export async function restoreInto(target: Profile, zip: Uint8Array): Promise<number> {
    const files = unzipSync(zip);
    await makeBackup(target, 'before restore');
    await writeAllFs(target.fsDb, files);
    return Object.keys(files).length;
}

export async function exportSaves(p: Profile): Promise<Uint8Array> {
    return zipSync(await readAllFs(p.fsDb), { level: 3 });
}
