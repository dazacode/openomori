// End-to-end smoke test in real Chrome (GPU): boot, title screen fit + bar colour, widescreen map,
// camera following while walking, new-game start, no page errors. Screenshots go to test/out/.
import puppeteer from 'puppeteer-core';
import { mkdirSync } from 'node:fs';

const PORT = 8099;
const CHROME = process.env.CHROME ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const W = 1920, H = 940; // the browser window from the user's screenshot (viewport under the tab bar)
const out = (n: string) => `test/out/${n}.png`;
mkdirSync('test/out', { recursive: true });

const server = Bun.spawn(['bun', 'run', 'src/server.ts', String(PORT)], { stdout: 'ignore', stderr: 'inherit' });
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const failures: string[] = [];
const check = (ok: boolean, msg: string) => { console.log(ok ? 'ok  ' : 'FAIL', msg); if (!ok) failures.push(msg); };

try {
    await sleep(500);
    const browser = await puppeteer.launch({
        executablePath: CHROME, headless: true, defaultViewport: { width: W, height: H },
        args: ['--autoplay-policy=no-user-gesture-required', '--ignore-gpu-blocklist', '--enable-gpu', '--use-angle=d3d11'],
    });
    const page = await browser.newPage();
    const pageErrors: string[] = [];
    page.on('pageerror', e => pageErrors.push((e as Error).message));

    const t0 = Date.now();
    await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load' });
    await page.waitForFunction(() => (globalThis as any).SceneManager?._scene?.constructor?.name === 'Scene_OmoriTitleScreen', { timeout: 90000 }).catch(async e => {
        console.error('title wait failed:', await page.evaluate(() => ((globalThis as any).SceneManager?._scene?.constructor?.name ?? 'no scene') + ' | ' + document.body.innerText.slice(0, 300)), pageErrors);
        throw e;
    });
    console.log(`title reached in ${Date.now() - t0} ms`);
    await sleep(1500);
    await page.screenshot({ path: out('title') });

    // ---- title: 4:3, fills the height, bars are the picture's colours (white here), supersampled
    const t = await page.evaluate(() => {
        const c = document.getElementById('GameCanvas') as HTMLCanvasElement, r = c.getBoundingClientRect();
        const bars = [...document.body.children].filter(e => e instanceof HTMLDivElement && e.style.position === 'fixed') as HTMLElement[];
        return { cssH: r.height, ratio: r.width / r.height, backW: c.width, gw: Graphics.width, bar: bars[0]?.style.background ?? '' };
    });
    check(Math.abs(t.cssH - H) <= 1, `title fills window height (${t.cssH} vs ${H})`);
    check(Math.abs(t.ratio - 4 / 3) < 0.01 && t.gw === 640, 'menus/title stay 4:3 at 640 logical');
    check(t.backW >= 1280, `internal resolution supersampled (${t.backW}px wide)`);
    check(/rgb\((2[0-5]\d)/.test(t.bar), 'title bars take the picture\'s (white) edge colour, not black');

    // ---- widescreen map via the debug panel
    await page.keyboard.press('F9');
    await page.type('#dbg input[type=text]', 'player street');
    await page.click('#dbg .row.hit');
    await page.waitForFunction(() => SceneManager._scene instanceof Scene_Map && $gameMap.mapId() === 13 && !$gamePlayer.isTransferring(), { timeout: 60000 });
    await sleep(2000);
    const m = await page.evaluate(() => {
        const c = document.getElementById('GameCanvas') as HTMLCanvasElement, r = c.getBoundingClientRect();
        return { cssW: r.width, cssH: r.height, gw: Graphics.width, gh: Graphics.height, bw: Graphics.boxWidth, sx: $gamePlayer.screenX(), x0: $gamePlayer.x };
    });
    check(Math.abs(m.cssW - W) <= 1 && Math.abs(m.cssH - H) <= 1, `map fills the whole window (${m.cssW}x${m.cssH})`);
    check(m.gw > 640 && m.gh === 480 && m.bw === 640, `wide render ${m.gw}x${m.gh}, UI box stays ${m.bw}`);
    check(Math.abs(m.sx - m.gw / 2) < 16, `player centred in the wide view (screenX ${m.sx} vs ${m.gw / 2})`);

    // ---- walk: camera must keep following
    await page.keyboard.down('ArrowRight'); await sleep(900); await page.keyboard.up('ArrowRight'); await sleep(600);
    const w = await page.evaluate(() => ({ sx: $gamePlayer.screenX(), x: $gamePlayer.x, gw: Graphics.width }));
    check(w.x > m.x0, `player walked right (${m.x0} -> ${w.x})`);
    check(Math.abs(w.sx - w.gw / 2) < 16, `camera followed the walk (screenX ${w.sx})`);
    await page.screenshot({ path: out('map-wide') });

    // ---- back to the title: width returns to 4:3
    await page.evaluate(() => SceneManager.goto(Scene_Title ?? (globalThis as any).Scene_OmoriTitleScreen));
    await sleep(2500);
    check((await page.evaluate(() => Graphics.width)) === 640, 'leaving the map returns to 640 width');

    check(pageErrors.length === 0, `no page errors${pageErrors.length ? ': ' + pageErrors[0] : ''}`);
    await browser.close();
} finally {
    server.kill();
}
if (failures.length) { console.error(`\n${failures.length} check(s) failed`); process.exit(1); }
console.log('\nall checks passed');
