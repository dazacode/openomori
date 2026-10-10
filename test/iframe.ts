// Embeds the game in a CROSS-ORIGIN <iframe> (host page on :8087, game on :8088) like an embed on another site,
// then checks it boots, scales to the frame, takes keyboard input, persists data, and opens the debug panel.
import puppeteer from 'puppeteer-core';
import { ANGLE, CHROME } from './chrome.ts';
const FRAME_W = 1000, FRAME_H = 640;
const game = Bun.spawn(['bun', 'run', 'src/server.ts', '8088'], { stdout: 'ignore', stderr: 'inherit' });
const host = Bun.serve({
  hostname: '127.0.0.1', port: 8087,
  fetch: () => new Response(
    `<!doctype html><body style="margin:0;background:#222"><p style="color:#ccc;font:14px sans-serif;margin:8px">host page (different origin)</p>` +
    `<iframe id="g" src="http://127.0.0.1:8088/" width="${FRAME_W}" height="${FRAME_H}" style="border:0" allow="fullscreen; autoplay; gamepad"></iframe></body>`,
    { headers: { 'content-type': 'text/html' } }),
});
const failures: string[] = [];
const check = (ok: boolean, msg: string) => { console.log(ok ? 'ok  ' : 'FAIL', msg); if (!ok) failures.push(msg); };
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
try {
  await sleep(600);
  const b = await puppeteer.launch({ executablePath: CHROME, headless: true, defaultViewport: { width: 1100, height: 760 },
    args: ['--autoplay-policy=document-user-activation-required', '--ignore-gpu-blocklist', '--enable-gpu', ANGLE] });
  const p = await b.newPage();
  const errs: string[] = [];
  p.on('pageerror', e => errs.push((e as Error).message));
  await p.goto('http://127.0.0.1:8087/');
  const el = await p.waitForSelector('#g');
  const frame = (await el!.contentFrame())!;
  check(new URL(frame.url()).origin !== new URL(p.url()).origin, 'game frame is cross-origin to the host page');

  await frame.waitForFunction(() => (globalThis as any).SceneManager?._scene?.constructor?.name === 'Scene_OmoriTitleScreen', { timeout: 90000 });
  await sleep(1500);
  const m = await frame.evaluate(() => {
    const c = document.getElementById('GameCanvas') as HTMLCanvasElement, r = c.getBoundingClientRect();
    return { w: r.width, h: r.height, fw: innerWidth, fh: innerHeight, left: r.left, top: r.top };
  });
  console.log(m);
  check(m.fw === FRAME_W && m.fh === FRAME_H, `game sees the iframe's size (${m.fw}x${m.fh})`);
  check(Math.abs(m.h - FRAME_H) <= 1 && m.w <= FRAME_W + 1, `title scaled to fit the frame (${m.w.toFixed(0)}x${m.h.toFixed(0)})`);
  await p.screenshot({ path: 'test/out/iframe-title.png' });

  // keyboard goes to the frame once clicked
  await el!.click();
  await p.keyboard.press('F9');
  check(await frame.evaluate(() => document.getElementById('dbg')!.classList.contains('open')), 'F9 opens the debug panel inside the iframe');
  await p.type('#dbg input[type=text]', 'player street').catch(() => {}); // page-level typing goes to focused element in frame
  await frame.type('#dbg input[type=text]', 'player street');
  await frame.click('#dbg .row.hit');
  await frame.waitForFunction(() => SceneManager._scene instanceof Scene_Map && $gameMap.mapId() === 13 && !$gamePlayer.isTransferring(), { timeout: 60000 });
  await sleep(2000);
  const w = await frame.evaluate(() => {
    const c = document.getElementById('GameCanvas') as HTMLCanvasElement, r = c.getBoundingClientRect();
    return { cw: r.width, ch: r.height, gw: Graphics.width };
  });
  check(Math.abs(w.cw - FRAME_W) <= 1 && Math.abs(w.ch - FRAME_H) <= 1, `map fills the iframe edge to edge (${w.cw.toFixed(0)}x${w.ch.toFixed(0)}, render ${w.gw}x480)`);
  await p.screenshot({ path: 'test/out/iframe-map.png' });

  // data persists in the framed origin's storage (third-party/partitioned IndexedDB must work)
  const stored = await frame.evaluate(async () => {
    return await new Promise<boolean>(res => { const r = indexedDB.open('omori-fs'); r.onsuccess = () => res(r.result.objectStoreNames.contains('f')); r.onerror = () => res(false); });
  });
  check(stored, 'IndexedDB (saves) is available inside the cross-origin iframe');
  check(errs.length === 0, `no page errors${errs.length ? ': ' + errs[0] : ''}`);
  await b.close();
} finally { game.kill(); host.stop(true); }
if (failures.length) { console.error(`\n${failures.length} check(s) failed`); process.exit(1); }
console.log('\nall iframe checks passed');
