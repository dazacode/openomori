// Boots a PUBLISHED Store package from its real content origin (the exact frame the Store loads, with its CSP sandbox,
// COEP and nosniff), which a local static server cannot reproduce:
//   bun run test/published.ts https://<key>.host/
// Needs the app to be published and its address to resolve; the first request also asks the TLS proxy for a certificate.
import { join } from 'node:path';
import puppeteer from 'puppeteer-core';
import { ANGLE, CHROME } from './chrome.ts';

const url = process.argv[2] ?? process.env.PUBLISHED_URL;
if (!url) {
    console.error('usage: bun run test/published.ts https://<key>.host/');
    process.exit(1);
}

const failures: string[] = [];
const check = (ok: boolean, msg: string) => { console.log(ok ? 'ok  ' : 'FAIL', msg); if (!ok) failures.push(msg); };

const browser = await puppeteer.launch({
    executablePath: CHROME, headless: true, defaultViewport: { width: 1280, height: 720 },
    args: ['--autoplay-policy=no-user-gesture-required', '--ignore-gpu-blocklist', '--enable-gpu', ANGLE],
});
try {
    const page = await browser.newPage();
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
    await page.goto(url, { waitUntil: 'load', timeout: 120000 });
    const headers = await page.evaluate(async () => {
        const r = await fetch('omori-bundle.json');
        return { type: r.headers.get('content-type'), hasKey: typeof (await r.json()).key === 'string' };
    });
    check(headers.hasKey, `the bundle manifest is served (${headers.type})`);
    await page.waitForFunction(() => (globalThis as any).SceneManager?._scene?.constructor?.name === 'Scene_OmoriTitleScreen', { timeout: 180000 }).catch(async e => {
        const scene = await page.evaluate(() => (globalThis as any).SceneManager?._scene?.constructor?.name ?? 'no scene');
        console.error(`title wait failed (scene: ${scene})`, hard.slice(0, 6));
        throw e;
    });
    console.log(`title reached in ${Date.now() - t0} ms`);
    await new Promise(r => setTimeout(r, 1500));
    await page.screenshot({ path: join(import.meta.dir, 'out', 'published-title.png') });
    check(hard.length === 0, `no page errors${hard.length ? `: ${hard.slice(0, 4).join(' | ')}` : ''}`);
    if (soft.length) console.log(`      (${soft.length} expected 404s, e.g. ${soft[0]})`);
} finally {
    await browser.close();
}

console.log(failures.length ? `\n${failures.length} failed` : '\npublished app boots: ok');
process.exit(failures.length ? 1 : 0);
