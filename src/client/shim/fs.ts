// Node `fs` stand-in. Reads the game folder over HTTP (sync for compatibility, async where the
// game uses callbacks); everything the game writes lives in an overlay persisted to IndexedDB.
import { Buffer } from 'buffer';
import path from 'path-browserify';

type Encoding = string | { encoding?: string | null } | null | undefined;
type Cb<T> = (err: NodeJS.ErrnoException | null, value?: T) => void;

const MAX_CACHE_BYTES = 96 * 1024 * 1024;
const MAX_ENTRY_BYTES = 8 * 1024 * 1024;

const enoent = (p: string, op: string): NodeJS.ErrnoException =>
    Object.assign(new Error(`ENOENT: no such file or directory, ${op} '${p}'`), { code: 'ENOENT', errno: -2, path: p });

export const keyOf = (p: string): string => path.normalize('/' + String(p)).replace(/^\/+|\/+$/g, '');
const urlOf = (k: string): string => '/' + k.split('/').map(encodeURIComponent).join('/');
const encodingOf = (o: Encoding): string | undefined => (typeof o === 'string' ? o : o?.encoding ?? undefined);

// ------------------------------------------------------------------ network layer
class ByteCache {
    private map = new Map<string, Uint8Array>();
    private bytes = 0;
    get(k: string) { return this.map.get(k); }
    has(k: string) { return this.map.has(k); }
    set(k: string, v: Uint8Array) {
        if (v.length > MAX_ENTRY_BYTES) return;
        this.bytes += v.length - (this.map.get(k)?.length ?? 0);
        this.map.set(k, v);
        for (const old of this.map.keys()) { // Map iterates in insertion order: evict oldest first
            if (this.bytes <= MAX_CACHE_BYTES) break;
            this.bytes -= this.map.get(old)!.length;
            this.map.delete(old);
        }
    }
}
const cache = new ByteCache();

/** Mods hook in here: they can replace or patch any file the game reads, and add new ones. */
export interface ModLayer {
    has(key: string): boolean;
    resolve(key: string, base: () => Uint8Array | null): Uint8Array | null;
    added(dir: string): string[];
}
let modLayer: ModLayer | null = null;
const modded = new Map<string, Uint8Array | null>();
export function setModLayer(layer: ModLayer | null) { modLayer = layer; modded.clear(); }
const withAdded = (names: string[] | null, dir: string): string[] | null => {
    const extra = modLayer?.added(dir) ?? [];
    return names || extra.length ? [...new Set([...(names ?? []), ...extra])] : null;
};
const lsCache = new Map<string, string[] | null>();
const missing = new Set<string>(); // keys known not to exist on the server

function fetchSync(k: string): Uint8Array | null {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', urlOf(k), false);
    xhr.overrideMimeType('text/plain; charset=x-user-defined');
    try { xhr.send(); } catch { return null; }
    if (xhr.status !== 200) return null;
    const s = xhr.responseText, u = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i) & 0xff;
    return u;
}

async function fetchAsync(k: string): Promise<Uint8Array | null> {
    try {
        const r = await fetch(urlOf(k));
        return r.ok ? new Uint8Array(await r.arrayBuffer()) : null;
    } catch { return null; }
}

function listSync(k: string): string[] | null {
    if (lsCache.has(k)) return lsCache.get(k)!;
    const xhr = new XMLHttpRequest();
    xhr.open('GET', '/__ls?p=' + encodeURIComponent(k), false);
    let res: string[] | null = null;
    try { xhr.send(); if (xhr.status === 200) res = JSON.parse(xhr.responseText); } catch { /* offline */ }
    res = withAdded(res, k);
    lsCache.set(k, res);
    return res;
}

/** Warm the cache in parallel so the game's sync reads at boot don't stall. */
export async function prefetch(keys: string[]): Promise<void> {
    await Promise.all(keys.map(async k => {
        if (cache.has(k)) return;
        const u = await fetchAsync(k);
        if (u) cache.set(k, u);
    }));
}
export async function listAsync(dir: string): Promise<string[]> {
    try { const r = await fetch('/__ls?p=' + encodeURIComponent(dir)); return withAdded(r.ok ? await r.json() : null, keyOf(dir)) ?? []; } catch { return withAdded(null, keyOf(dir)) ?? []; }
}

// ------------------------------------------------------------------ writable overlay (IndexedDB)
const overlay = new Map<string, Uint8Array | null>(); // null = deleted
const overlayDirs = new Set<string>();
let idb: IDBDatabase | null = null;

/** Load this session's saves. Each mod profile has its own database, so profiles never see each other's saves. */
export async function loadOverlay(dbName = 'omori-fs'): Promise<void> {
    idb = await new Promise<IDBDatabase | null>(res => {
        try {
            const r = indexedDB.open(dbName, 1);
            r.onupgradeneeded = () => r.result.createObjectStore('f');
            r.onsuccess = () => res(r.result);
            r.onerror = () => res(null);
        } catch { res(null); }
    });
    if (!idb) return;
    await new Promise<void>(res => {
        const req = idb!.transaction('f').objectStore('f').openCursor();
        req.onsuccess = () => {
            const c = req.result;
            if (!c) return res();
            overlay.set(String(c.key), c.value === null ? null : new Uint8Array(c.value as ArrayBuffer));
            c.continue();
        };
        req.onerror = () => res();
    });
}
function persist(k: string, v: Uint8Array | null) {
    if (!idb) return;
    try { idb.transaction('f', 'readwrite').objectStore('f').put(v === null ? null : v.slice().buffer, k); } catch { /* quota/private mode: session-only */ }
}

// ------------------------------------------------------------------ fs API
const asBuffer = (u: Uint8Array, enc: string | undefined) => {
    const b = Buffer.from(u.buffer as ArrayBuffer, u.byteOffset, u.length);
    return enc ? b.toString(enc as BufferEncoding) : b;
};
const bytesOf = (data: string | Uint8Array): Uint8Array =>
    typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data);

function lookup(k: string): Uint8Array | null | undefined {
    if (overlay.has(k)) return overlay.get(k);
    if (modLayer?.has(k)) {
        if (!modded.has(k)) modded.set(k, modLayer.resolve(k, () => cache.get(k) ?? fetchSync(k)));
        const m = modded.get(k);
        if (m) return m;
    }
    return cache.get(k);
}

interface Stats { isDirectory(): boolean; isFile(): boolean; size: number }

export const fs = {
    readFileSync(p: string, o?: Encoding) {
        const k = keyOf(p);
        let u = lookup(k);
        if (u === undefined) { u = fetchSync(k); if (u) cache.set(k, u); }
        if (!u) throw enoent(p, 'open');
        return asBuffer(u, encodingOf(o));
    },
    readFile(p: string, o: Encoding | Cb<Buffer | string>, cb?: Cb<Buffer | string>) {
        if (typeof o === 'function') { cb = o; o = undefined; }
        const k = keyOf(p), enc = encodingOf(o as Encoding);
        const hit = lookup(k);
        if (hit !== undefined) {
            queueMicrotask(() => hit ? cb!(null, asBuffer(hit, enc)) : cb!(enoent(p, 'open')));
            return;
        }
        fetchAsync(k).then(u => {
            if (u) cache.set(k, u);
            u ? cb!(null, asBuffer(u, enc)) : cb!(enoent(p, 'open'));
        });
    },
    existsSync(p: string): boolean {
        const k = keyOf(p);
        if (overlay.has(k)) return overlay.get(k) !== null;
        if (overlayDirs.has(k) || cache.has(k) || modLayer?.has(k)) return true;
        for (const [ok, v] of overlay) if (v && ok.startsWith(k + '/')) return true;
        if (missing.has(k)) return false;
        if (listSync(k)) return true;
        const xhr = new XMLHttpRequest();
        xhr.open('HEAD', urlOf(k), false);
        try { xhr.send(); } catch { return false; }
        if (xhr.status !== 200) missing.add(k);
        return xhr.status === 200;
    },
    statSync(p: string): Stats {
        const k = keyOf(p);
        if (overlayDirs.has(k) || (!overlay.has(k) && listSync(k))) {
            return { isDirectory: () => true, isFile: () => false, size: 0 };
        }
        const u = lookup(k) ?? fetchSync(k);
        if (!u) throw enoent(p, 'stat');
        return { isDirectory: () => false, isFile: () => true, size: u.length };
    },
    stat(p: string, cb: Cb<Stats>) {
        setTimeout(() => { try { cb(null, fs.statSync(p)); } catch (e) { cb(e as NodeJS.ErrnoException); } }, 0);
    },
    writeFileSync(p: string, data: string | Uint8Array) {
        const k = keyOf(p), u = bytesOf(data);
        overlay.set(k, u); missing.delete(k); persist(k, u);
    },
    writeFile(p: string, data: string | Uint8Array, o?: unknown, cb?: Cb<void>) {
        if (typeof o === 'function') cb = o as Cb<void>;
        setTimeout(() => { try { fs.writeFileSync(p, data); cb?.(null); } catch (e) { cb?.(e as NodeJS.ErrnoException); } }, 0);
    },
    mkdirSync(p: string) { overlayDirs.add(keyOf(p)); },
    unlinkSync(p: string) {
        if (!fs.existsSync(p)) throw enoent(p, 'unlink');
        const k = keyOf(p);
        overlay.set(k, null); persist(k, null);
    },
    unlink(p: string, cb: Cb<void>) {
        setTimeout(() => { try { fs.unlinkSync(p); cb(null); } catch (e) { cb(e as NodeJS.ErrnoException); } }, 0);
    },
    readdirSync(p: string): string[] {
        const k = keyOf(p), prefix = k ? k + '/' : '';
        const net = listSync(k);
        const names = new Set(net ?? []);
        for (const [ok, v] of overlay) {
            if (!v || !ok.startsWith(prefix)) continue;
            const rest = ok.slice(prefix.length);
            if (!rest.includes('/')) names.add(rest);
        }
        if (!net && !names.size && !overlayDirs.has(k)) throw enoent(p, 'scandir');
        return [...names];
    },
};
