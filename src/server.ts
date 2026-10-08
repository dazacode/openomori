// Static server for the OMORI browser port: `bun run src/server.ts [port]`
// Serves the game's www folder read-only, plus the built client bundle and a directory-listing endpoint.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';

const ROOT = resolve(import.meta.dir, '..');
// Your OMORI install (the folder containing OMORI.exe and www/). Override with OMORI_DIR.
const GAME_DIR = resolve(process.env.OMORI_DIR ?? resolve(ROOT, '..', 'OMORI.Build.8879120'));
const WWW = join(GAME_DIR, 'www');

/** The game decrypts itself with a key passed on its command line; the Steam build's launcher bat holds it. */
function readGameKey(): string | null {
    const bat = join(GAME_DIR, 'Launch_OMORI.bat');
    try {
        const key = /--([0-9a-f]{32})/i.exec(readFileSync(bat, 'utf8'))?.[1];
        if (!key) console.error(`no 32-char key found in ${bat}`);
        return key ?? null;
    } catch (e) {
        console.error(`cannot read ${bat}: ${(e as Error).message} (set OMORI_DIR to your OMORI folder)`);
        return null;
    }
}
const PORT = Number(process.argv[2] ?? process.env.PORT ?? 8080);

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

function fileResponse(path: string, req: Request): Response {
    const file = Bun.file(path);
    const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
    const type = TYPES[ext] ?? file.type;
    const lastModified = new Date(file.lastModified).toUTCString();
    const base: Record<string, string> = { 'content-type': type, 'accept-ranges': 'bytes', 'last-modified': lastModified, 'cache-control': 'no-cache' };

    if (req.headers.get('if-modified-since') === lastModified) return new Response(null, { status: 304, headers: base });

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
            try { return Response.json(readdirSync(dir)); } catch { return new Response(null, { status: 404 }); }
        }
        if (rel === '/' || rel === '/index.html') return fileResponse(join(ROOT, 'public', 'index.html'), req);
        if (rel === '/app.js') return fileResponse(join(ROOT, 'dist', 'app.js'), req);

        const path = resolveInWww(rel);
        if (!path || !statSync(path, { throwIfNoEntry: false })?.isFile()) return new Response('not found', { status: 404 });
        return fileResponse(path, req);
    },
});
console.log(`OMORI web: http://${server.hostname}:${server.port}/`);
