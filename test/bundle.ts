// Boots a static bundle (scripts/make-bundle.ts output) in real Chrome from a plain file server, which is how a store
// or any static host serves it: no dev server, everything from omori-bundle.json, with `nosniff` on like the Store.
//   bun run test/bundle.ts            (expects ./bundle)
//   BUNDLE=/tmp/omori-web bun run test/bundle.ts
import { statSync } from 'node:fs';
import { join, normalize, resolve } from 'node:path';
import puppeteer from 'puppeteer-core';
import { ANGLE, CHROME } from './chrome.ts';

const PORT = 8098;
const root = resolve(process.env.BUNDLE ?? join(import.meta.dir, '..', 'bundle'));
if (!statSync(root, { throwIfNoEntry: false })) {
    console.error(`no bundle at ${root} - run "bun run bundle" first.`);
    process.exit(1);
}

const TYPES: Record<string, string> = {
    html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', mjs: 'text/javascript; charset=utf-8',
    css: 'text/css; charset=utf-8', json: 'application/json', omori: 'text/javascript; charset=utf-8',
    png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', ico: 'image/x-icon',
    ogg: 'audio/ogg', mp3: 'audio/mpeg', wav: 'audio/wav', webm: 'video/webm', mp4: 'video/mp4',
    ttf: 'font/ttf', otf: 'font/otf', woff: 'font/woff', woff2: 'font/woff2', wasm: 'application/wasm',
};

const server = Bun.serve({
    hostname: '127.0.0.1',
    port: PORT,
    async fetch(req) {
        const url = new URL(req.url);
        let rel: string;
        try { rel = decodeURIComponent(url.pathname); } catch { rel = url.pathname; }   // the game ships names with a bare '%'
        if (rel.endsWith('/')) rel += 'index.html';
        const file = Bun.file(join(root, normalize(rel).replace(/^(\.\.[/\\])+/, '')));
        if (!(await file.exists())) {
            if (!rel.includes('.')) return this.fetch(new Request(new URL(rel + '/', url), req));
            return new Response('not found', { status: 404 });
        }
        const ext = rel.slice(rel.lastIndexOf('.') + 1).toLowerCase();
        const headers: Record<string, string> = {
            'content-type': TYPES[ext] ?? 'application/octet-stream',
            'x-content-type-options': 'nosniff',
            'accept-ranges': 'bytes',
            'cache-control': 'no-cache',
        };
        const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.get('range') ?? '');
        if (m && (m[1] || m[2])) {
            const size = file.size;
            const start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
            const end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
            headers['content-range'] = `bytes ${start}-${end}/${size}`;
            return new Response(file.slice(start, end + 1), { status: 206, headers });
        }
        return new Response(file, { headers });
    },
});

const failures: string[] = [];
const check = (ok: boolean, msg: string) => { console.log(ok ? 'ok  ' : 'FAIL', msg); if (!ok) failures.push(msg); };

try {
    const browser = await puppeteer.launch({
        executablePath: CHROME, headless: true, defaultViewport: { width: 1280, height: 720 },
        args: ['--autoplay-policy=no-user-gesture-required', '--ignore-gpu-blocklist', '--enable-gpu', ANGLE],
    });
    const page = await browser.newPage();
    if (process.env.THROTTLE) {   // pretend the origin is far away: 160 ms RTT, ~1.6 MB/s
        const cdp = await page.createCDPSession();
        await cdp.send('Network.enable');
        await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 160, downloadThroughput: 1.6 * 1024 * 1024, uploadThroughput: 1 * 1024 * 1024 });
    }
    // hard: a page crash, a failed request, a 5xx. soft: the game's own "does this file exist yet" 404s (/appdata, /save).
    const hard: string[] = [];
    const soft: string[] = [];
    page.on('pageerror', e => hard.push((e as Error).message));
    page.on('requestfailed', r => { const u = r.url(); if (!u.endsWith('app.js.map')) hard.push(`request failed: ${u.slice(u.indexOf('/', 8))}`); });
    page.on('console', m => {
        const t = m.text();
        const type = m.type();
        if (type === 'warn') soft.push(`console.warn: ${t.slice(0, 120)}`);            // the game and Canvas are chatty
        else if (type === 'error') (/\b404\b/.test(t) ? soft : hard).push(`console.error: ${t}`);
    });
    page.on('response', r => { const u = r.url().slice(r.url().indexOf('/', 8)); if (r.status() >= 500) hard.push(`${r.status()} ${u}`); else if (r.status() === 404) soft.push(`404 ${u}`); });

    const t0 = Date.now();
    await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load' });
    await new Promise(r => setTimeout(r, 1200));
    await page.screenshot({ path: join(import.meta.dir, 'out', 'bundle-boot.png') });
    await page.waitForFunction(() => (globalThis as any).SceneManager?._scene?.constructor?.name === 'Scene_OmoriTitleScreen', { timeout: 120000 }).catch(async e => {
        const scene = await page.evaluate(() => (globalThis as any).SceneManager?._scene?.constructor?.name ?? 'no scene');
        console.error(`title wait failed (scene: ${scene})`, hard.slice(0, 8));
        throw e;
    });
    console.log(`title reached in ${Date.now() - t0} ms`);
    console.log('boot marks (ms):', await page.evaluate(() => performance.getEntriesByType('mark').map(m => `${m.name.replace('omori:', '')}=${Math.round(m.startTime)}`).join(' ')));
    await new Promise(r => setTimeout(r, 1500));
    await page.screenshot({ path: join(import.meta.dir, 'out', 'bundle-title.png') });

    // the mods baked into ./mods are offered to the mod manager (F8), and nothing should have errored during boot
    const tab = await page.evaluate(() => document.getElementById('omm-tab')?.textContent ?? '(none)');
    check(tab === 'Mods', `mod manager tab is clean (got "${tab}")`);
    await page.keyboard.press('F8');
    await new Promise(r => setTimeout(r, 800));
    const modsText = await page.evaluate(() => document.body.innerText);
    check(/Story select/i.test(modsText), 'the Story select mod is listed in the mod manager');
    check(/OMORI 3D/i.test(modsText), 'the OMORI 3D mod is listed');
    check(!/SUNBURN|Sunburn/.test(modsText), 'the SUNBURN mod is not in the bundle');
    await page.screenshot({ path: join(import.meta.dir, 'out', 'bundle-mods.png') });

    // enabling them must work too: skill-demo patches the game's data, which exercises the plain-on-disk path
    page.on('dialog', d => { void d.accept(); });
    await page.evaluate(() => [...document.querySelectorAll('#omm-body button')].find(b => b.textContent === 'Enable all')?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await new Promise(r => setTimeout(r, 1200));
    const reload = await page.evaluate(() => { const b = document.getElementById('omm-reload') as HTMLElement | null; const shown = !!b && b.style.display !== 'none'; b?.dispatchEvent(new MouseEvent('click', { bubbles: true })); return shown; });
    check(reload, 'the mod manager offers "Apply & reload" once mods are enabled');
    const boot2 = Date.now();
    await page.waitForFunction(() => (globalThis as any).SceneManager?._scene?.constructor?.name === 'Scene_OmoriTitleScreen', { timeout: 180000 });
    console.log(`title reached again with mods enabled in ${Date.now() - boot2} ms`);
    const tab2 = await page.evaluate(() => document.getElementById('omm-tab')?.textContent ?? '(none)');
    check(tab2 === 'Mods', `no mod errors with the mods enabled (got "${tab2}")`);
    const st2 = await page.evaluate(() => ({ maps: (globalThis as any).$dataMapInfos?.length, mods: ((globalThis as any).OmoriMod ? 1 : 0) }));
    check((st2.maps ?? 0) > 400 && !!st2.mods, `the game still runs with mods applied (${st2.maps} maps, API ${st2.mods ? 'up' : 'missing'})`);

    const st = await page.evaluate(() => ({ lang: (globalThis as any).$dataSystem?.locale, title: (globalThis as any).$dataSystem?.gameTitle, items: (globalThis as any).$dataItems?.length, maps: (globalThis as any).$dataMapInfos?.length }));
    check(!!st.lang, `game data loaded from the bundle (locale ${String(st.lang)})`);
    check(st.title === 'OMORI' && (st.items ?? 0) > 900 && (st.maps ?? 0) > 400, `the game's databases parsed (${st.title}, ${st.items} items, ${st.maps} maps)`);
    check(hard.length === 0, `no page errors${hard.length ? `: ${hard.slice(0, 4).join(' | ')}` : ''}`);
    if (soft.length) console.log(`      (${soft.length} expected 404s, e.g. ${soft[0]})`);
    await browser.close();
} finally {
    server.stop(true);
}

console.log(failures.length ? `\n${failures.length} failed` : '\nbundle boots standalone: ok');
process.exit(failures.length ? 1 : 0);
