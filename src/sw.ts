// Service worker: serves mod-replaced images, audio, fonts and plain scripts.
// (Encrypted data/plugins are handled inside the page by the fs shim, which holds the game key.)
import { ModEngine } from './mods/engine.ts';
import { zipTreeFromBytes } from './mods/vfs.ts';
import { enabledKeys, getActiveProfile, getMeta, listMods, readGenerated } from './client/mods/store.ts';

// The DOM lib is on for the page code, so worker globals are typed loosely here.
const sw = self as any;

let engine: Promise<ModEngine> | null = null;

function build(safe = false): Promise<ModEngine> {
    return (async () => {
        const e = new ModEngine();
        if (safe) return e; // ?mods=0: serve everything vanilla
        const recs = (await listMods()).sort((a, b) => a.key.localeCompare(b.key));
        const on = enabledKeys(await getActiveProfile(), recs); // only the active profile's mods
        // the page worked out the asset key (it holds the game key) and the patched images; we only serve them
        const hexKey = await getMeta<string>('assetKey');
        if (hexKey) e.assetKey = Uint8Array.from(hexKey.match(/../g) ?? [], h => parseInt(h, 16));
        e.load(recs.map(r => ({ label: r.label, tree: zipTreeFromBytes(r.zip, r.stamp), origin: r.key, disabled: !on.has(r.key) })));
        for (const [path, bytes] of Object.entries(await readGenerated())) e.setGenerated(path, bytes);
        return e;
    })();
}
const get = () => (engine ??= build());

sw.addEventListener('install', () => void sw.skipWaiting());
sw.addEventListener('activate', (e: any) => e.waitUntil(sw.clients.claim()));
sw.addEventListener('message', (e: any) => {
    if (e.data?.type !== 'reload') return;
    engine = build(!!e.data.safe);
    e.waitUntil(engine.then(() => e.source?.postMessage({ type: 'reloaded' }), () => e.source?.postMessage({ type: 'reloaded', error: true })));
});

const MIME: Record<string, string> = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', ogg: 'audio/ogg', m4a: 'audio/mp4', mp3: 'audio/mpeg', wav: 'audio/wav',
    webm: 'video/webm', mp4: 'video/mp4', ttf: 'font/ttf', otf: 'font/otf', woff: 'font/woff', woff2: 'font/woff2', js: 'text/javascript', json: 'application/json', css: 'text/css', html: 'text/html', txt: 'text/plain', yml: 'text/plain',
};

sw.addEventListener('fetch', (event: any) => {
    const req = event.request;
    if (req.method !== 'GET') return;
    const url = new URL(req.url);
    if (url.origin !== location.origin || url.pathname.startsWith('/__')) return;
    event.respondWith(handle(req, url));
});

async function handle(req: Request, url: URL): Promise<Response> {
    let path: string;
    try { path = decodeURIComponent(url.pathname); } catch { path = url.pathname; }
    path = path.replace(/^\/+/, '');
    if (url.searchParams.has('__vanilla')) return fetch(req); // the page asks for the game's own file, e.g. as the base of an image patch
    try {
        const eng = await get();
        if (!eng.hasEdits(path) || eng.isEncrypted(path)) return fetch(req);

        let base: Uint8Array | null = null;
        if (eng.needsBase(path)) {
            const r = await fetch(url.pathname, { cache: 'no-store' });
            if (r.ok) base = new Uint8Array(await r.arrayBuffer());
        }
        const bytes = eng.resolve(path, () => base);
        if (!bytes) return fetch(req);
        const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
        return ranged(req, bytes, MIME[ext] ?? 'application/octet-stream');
    } catch (e) {
        console.error('[omori-mods] service worker failed for', path, e);
        return fetch(req);
    }
}

/** Media elements need Range support to seek. */
function ranged(req: Request, bytes: Uint8Array, type: string): Response {
    const headers = { 'content-type': type, 'accept-ranges': 'bytes', 'cache-control': 'no-store', 'x-omori-mod': '1' };
    const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.get('range') ?? '');
    if (m && (m[1] || m[2])) {
        const size = bytes.length;
        const start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
        const end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
        if (start > end || start >= size) return new Response(null, { status: 416, headers: { 'content-range': `bytes */${size}` } });
        return new Response(bytes.slice(start, end + 1) as BodyInit, { status: 206, headers: { ...headers, 'content-range': `bytes ${start}-${end}/${size}`, 'content-length': String(end - start + 1) } });
    }
    return new Response(bytes as BodyInit, { headers: { ...headers, 'content-length': String(bytes.length) } });
}
