// Start a NEW GAME and report where it goes: every 404 (full URL), the scene, and the map state.
//   bun run test/diag-newgame.ts https://<key>.host/
import puppeteer from 'puppeteer-core';
import { ANGLE, CHROME } from './chrome.ts';

const url = process.argv[2]!;
const browser = await puppeteer.launch({
    executablePath: CHROME, headless: true, defaultViewport: { width: 1280, height: 720 },
    args: ['--autoplay-policy=no-user-gesture-required', '--ignore-gpu-blocklist', '--enable-gpu', ANGLE],
});
const page = await browser.newPage();
const origin = new URL(url).origin;
const notFound: string[] = [];
page.on('response', r => { if (r.status() === 404 && r.url().startsWith(origin)) notFound.push(r.url().replace(origin, '')); });
const errors: string[] = [];
page.on('pageerror', e => errors.push((e as Error).message));
page.on('console', m => { if (m.type() === 'error' && !/\b404\b/.test(m.text())) errors.push(m.text().slice(0, 160)); });

await page.goto(url, { waitUntil: 'load', timeout: 120000 });
await page.waitForFunction(() => (globalThis as any).SceneManager?._scene?.constructor?.name === 'Scene_OmoriTitleScreen', { timeout: 180000 });
await new Promise(r => setTimeout(r, 2500));
await page.mouse.click(640, 400);                     // the game only listens to keys once it has focus
console.log(`title reached; ${notFound.length} 404s so far`);
console.log('404s:', notFound.slice(0, 20));

const sceneNow = () => page.evaluate(() => (globalThis as any).SceneManager?._scene?.constructor?.name);
for (let i = 0; i < 20; i++) {
    const k = i % 2 ? 'Enter' : 'z';
    await page.keyboard.down(k);
    await new Promise(r => setTimeout(r, 150));
    await page.keyboard.up(k);
    await new Promise(r => setTimeout(r, 550));
    if ((await sceneNow()) !== 'Scene_OmoriTitleScreen') break;
}
const state = async () => page.evaluate(() => ({
    scene: (globalThis as any).SceneManager?._scene?.constructor?.name,
    frames: (globalThis as any).SceneManager?._frameCount,
    started: !!(globalThis as any).SceneManager?._scene?._started,
    focused: document.hasFocus(),
    latestKey: (globalThis as any).Input?._latestButton,
    state: JSON.stringify((globalThis as any).Input?._currentState),
    mapId: (globalThis as any).$gameMap?.mapId?.(),
    player: (globalThis as any).$gamePlayer ? `${(globalThis as any).$gamePlayer.x},${(globalThis as any).$gamePlayer.y}` : null,
    transferring: (globalThis as any).$gamePlayer?.isTransferring?.(),
    ready: (globalThis as any).SceneManager?._scene?.isReady?.(),
    commandActive: (globalThis as any).SceneManager?._scene?._commandActive,
    sceneStarted: (globalThis as any).SceneManager?._sceneStarted,
}));
for (const t of [3000, 8000, 20000]) {
    await new Promise(r => setTimeout(r, t === 3000 ? 3000 : t === 8000 ? 5000 : 12000));
    console.log(`+${t}ms`, JSON.stringify(await state()));
}
console.log(`\n404s during the new game: ${notFound.length}`);
const byDir = new Map<string, number>();
for (const u of notFound) { const d = u.split('/').slice(1, 3).join('/'); byDir.set(d, (byDir.get(d) ?? 0) + 1); }
console.log([...byDir].sort((a, b) => b[1] - a[1]).map(([d, n]) => `  ${n}  ${d}`).join('\n'));
console.log('sample:', notFound.slice(0, 15));
console.log('errors:', errors.slice(0, 6));
await page.screenshot({ path: 'test/out/diag-newgame.png' });
await browser.close();
