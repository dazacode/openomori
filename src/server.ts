// Static server for the OMORI browser port: `bun run src/server.ts [port]`
// Serves the game's www folder read-only, plus the built client bundle and a directory-listing endpoint.
import { appendFileSync, readdirSync, statSync, watch, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { discoverMods } from './mods/vfs-node.ts';
import { isOsJunk, treeToZip } from './mods/vfs.ts';
import { ROOT, WWW, ensureGameDir, readGameKey } from './gamedir.ts';
import { storyIndex } from './mods/mapkit-node.ts';

if (!ensureGameDir()) process.exit(1);   // asks for your OMORI folder the first time

const PORT = Number(process.argv[2] ?? process.env.PORT ?? 8080);

// Mods are applied in the browser (drag a .zip onto the game). This server only offers an optional dev folder:
// everything in OMORI_MODS (default ./mods) is shipped to the page as a "server mod" on each load.
const MODS_DIR = resolve(process.env.OMORI_MODS ?? join(ROOT, 'mods'));
const LOG_FILE = join(ROOT, 'latest.log');
try { writeFileSync(LOG_FILE, ''); } catch { /* read-only checkout: log to console only */ }
const log = (line: string) => { console.log(line); try { appendFileSync(LOG_FILE, `${line}\n`); } catch { /* best effort */ } };
let modsVersion = 1;
let bump: ReturnType<typeof setTimeout> | undefined;
try {
    // Finder writes .DS_Store just from browsing a folder: that is not a change to any mod
    watch(MODS_DIR, { recursive: true }, (_ev, name) => { if (name && isOsJunk(String(name).replace(/\\/g, '/'))) return; clearTimeout(bump); bump = setTimeout(() => modsVersion++, 250); });
} catch (e) { console.warn(`not watching ${MODS_DIR}: ${(e as Error).message}`); }

const TYPES: Record<string, string> = { yaml: 'text/plain', yml: 'text/plain', md: 'text/plain', ogg: 'audio/ogg', webm: 'video/webm' };

/** Resolve a request path inside WWW, tolerating wrong case (the game asks for /Languages/ but the folder is languages/). */
function resolveInWww(rel: string): string | null {
    let cur = WWW;
    for (const seg of rel.split('/').filter(Boolean)) {
        if (seg === '..') return null;
        const direct = join(cur, seg);
        if (exists(direct)) { cur = direct; continue; }
        let names: string[];
        try { names = readdirSync(cur); } catch { return null; }
        const hit = names.find(n => n.toLowerCase() === seg.toLowerCase());
        if (!hit) return null;
        cur = join(cur, hit);
    }
    return cur === WWW || cur.startsWith(WWW + sep) ? cur : null;
}
const exists = (p: string) => { try { statSync(p); return true; } catch { return false; } };

/** Serves a file, or `body` (mod-edited bytes standing in for it), with Range support. */
function fileResponse(path: string, req: Request, body?: Uint8Array, extra: Record<string, string> = {}): Response {
    const file: Blob = body ? new Blob([body as BlobPart]) : Bun.file(path);
    const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
    const type = TYPES[ext] ?? Bun.file(path).type;
    const base: Record<string, string> = { 'content-type': type, 'accept-ranges': 'bytes', 'cache-control': 'no-cache', ...extra };
    if (!body) {
        const lastModified = new Date(Bun.file(path).lastModified).toUTCString();
        base['last-modified'] = lastModified;
        if (req.headers.get('if-modified-since') === lastModified) return new Response(null, { status: 304, headers: base });
    }

    const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.get('range') ?? '');
    if (m && (m[1] || m[2])) {
        const size = file.size;
        const start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
        const end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
        if (start > end || start >= size) return new Response(null, { status: 416, headers: { 'content-range': `bytes */${size}` } });
        return new Response(file.slice(start, end + 1), { status: 206, headers: { ...base, 'content-range': `bytes ${start}-${end}/${size}` } });
    }
    return new Response(req.method === 'HEAD' ? null : file, { headers: { ...base, 'content-length': String(file.size) } });
}

const server = Bun.serve({
    hostname: '127.0.0.1',
    port: PORT,
    fetch(req) {
        const url = new URL(req.url);
        let rel: string;
        try { rel = decodeURIComponent(url.pathname); } catch { rel = url.pathname; } // some game files contain a literal '%'

        if (rel === '/__config') {
            const key = readGameKey();
            return key ? Response.json({ key }) : new Response('no key found in Launch_OMORI.bat', { status: 404 });
        }
        if (rel === '/__ls') {
            const dir = resolveInWww(url.searchParams.get('p') ?? '');
            if (!dir) return new Response(null, { status: 404 });
            // the game reads every file a folder lists (languages/ above all): never hand it .DS_Store or ._ files
            try { return Response.json(readdirSync(dir).filter(n => !isOsJunk(n))); } catch { return new Response(null, { status: 404 }); }
        }
        if (rel === '/' || rel === '/index.html') return fileResponse(join(ROOT, 'public', 'index.html'), req);
        if (rel === '/app.js') return fileResponse(join(ROOT, 'dist', 'app.js'), req);
        if (rel.startsWith('/vendor/') && !rel.includes('..')) {
            const f = join(ROOT, 'dist', rel);
            if (statSync(f, { throwIfNoEntry: false })?.isFile()) return fileResponse(f, req, undefined, f.endsWith('.wasm') ? { 'content-type': 'application/wasm' } : {});
        }
        if (rel === '/sw.js') return fileResponse(join(ROOT, 'dist', 'sw.js'), req, undefined, { 'service-worker-allowed': '/' });

        // Story flags of this install (used by the checkpoint panel for coverage). Scanned once, on first request.
        if (rel === '/__story.json') { try { return Response.json(storyIndex()); } catch (e) { return new Response(String(e), { status: 500 }); } }

        // ---- mod API (see docs/MODDING.md)
        if (rel === '/__mods/version') return Response.json({ version: modsVersion });
        if (rel === '/__mods/list') {
            const mods = discoverMods(MODS_DIR, (n, e) => log(`[error] cannot read mod "${n}": ${e.message}`));
            return Response.json({ version: modsVersion, mods: mods.map(m => ({ label: m.label, stamp: m.tree.stamp })) });
        }
        if (rel === '/__mods/pack') {
            const label = url.searchParams.get('name') ?? '';
            const mod = discoverMods(MODS_DIR, () => {}).find(m => m.label === label);
            return mod ? new Response(treeToZip(mod.tree) as BodyInit, { headers: { 'content-type': 'application/zip', 'cache-control': 'no-store' } }) : new Response('no such mod', { status: 404 });
        }
        if (rel === '/__mods/log' && req.method === 'POST') {
            return req.json().then((b: any) => {
                const level = b?.level === 'warn' ? 'warn' : b?.level === 'info' ? 'info' : 'error';
                log(`${new Date().toISOString()} [${level}] [${String(b?.mod ?? '(client)').slice(0, 64)}] ${String(b?.message ?? '').slice(0, 4000)}`);
                return new Response(null, { status: 204 });
            }, () => new Response('bad json', { status: 400 }));
        }

        const path = resolveInWww(rel);
        if (!path || !statSync(path, { throwIfNoEntry: false })?.isFile()) return new Response('not found', { status: 404 });
        return fileResponse(path, req);
    },
});
console.log(`OpenOMORI: http://${server.hostname}:${server.port}/`);
