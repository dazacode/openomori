// Where does the boot time go? Runs a bundle (local or published) and reports the boot marks, every synchronous XHR
// (they block the page, so a few hundred of them cost a minute over a real network), and screenshots of the start.
//   bun run test/diag-boot.ts https://<key>.host/
// Expected: sync XHR ~2 (the game's own "does this save exist" probes) and `plugins` within a second or two of
// `cache-warm`. If sync XHR counts in the hundreds, a read is missing the prefetched byte cache (see shim/fs.ts).
import { join } from 'node:path';
import puppeteer from 'puppeteer-core';
import { ANGLE, CHROME } from './chrome.ts';

const url = process.argv[2];
if (!url) {
    console.error('usage: bun run test/diag-boot.ts <url>');
    process.exit(1);
}

const browser = await puppeteer.launch({
    executablePath: CHROME, headless: true, defaultViewport: { width: 1280, height: 720 },
    args: ['--autoplay-policy=no-user-gesture-required', '--ignore-gpu-blocklist', '--enable-gpu', ANGLE],
});
const page = await browser.newPage();
await page.evaluateOnNewDocument(() => {
    const g = globalThis as any;
    g.__sync = { total: 0, urls: [] as string[], ms: 0 };
    g.__fetched = new Set<string>();
    const open = XMLHttpRequest.prototype.open, send = XMLHttpRequest.prototype.send, fetch = g.fetch;
    XMLHttpRequest.prototype.open = function (...args: any[]) { (this as any).__sync = args[2] === false; (this as any).__url = String(args[1]); return open.apply(this, args as any); };
    XMLHttpRequest.prototype.send = function (...args: any[]) {
        if (!(this as any).__sync) return send.apply(this, args as any);
        g.__sync.total++;
        if (g.__sync.urls.length < 10) g.__sync.urls.push(String((this as any).__url));
        const t = performance.now();
        try { return send.apply(this, args as any); } finally { g.__sync.ms += performance.now() - t; }
    };
    g.fetch = function (...args: any[]) { g.__fetched.add(String(args[0]?.url ?? args[0])); return fetch.apply(this, args); };
});

await page.goto(url, { waitUntil: 'load', timeout: 120000 });
for (const t of [1200, 4000]) { await new Promise(r => setTimeout(r, t === 1200 ? 1200 : 2800)); await page.screenshot({ path: join(import.meta.dir, 'out', `diag-${t}.png`) }); }
await page.waitForFunction(() => (globalThis as any).SceneManager?._scene?.constructor?.name === 'Scene_OmoriTitleScreen', { timeout: 180000 });

const out = await page.evaluate(() => ({
    marks: performance.getEntriesByType('mark').map(m => `${m.name.replace('omori:', '')}=${Math.round(m.startTime)}`).join(' '),
    sync: (globalThis as any).__sync,
    missedTheCache: ((globalThis as any).__sync.urls as string[]).filter(u => (globalThis as any).__fetched.has(u)),
    dataParsed: { title: (globalThis as any).$dataSystem?.gameTitle, items: (globalThis as any).$dataItems?.length, maps: (globalThis as any).$dataMapInfos?.length },
}));
console.log('marks:', out.marks);
console.log(`sync XHR: ${out.sync.total} (${Math.round(out.sync.ms)}ms blocked), first:`, out.sync.urls);
console.log('sync XHR URLs that were prefetched but still missed the cache:', out.missedTheCache);
console.log('game data:', JSON.stringify(out.dataParsed));
await browser.close();
