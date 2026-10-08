// Pictures/cutscene stills must be centred in the wide view; opaque full-screen ones black out the sides.
import puppeteer from 'puppeteer-core';
const server = Bun.spawn(['bun', 'run', 'src/server.ts', '8090'], { stdout: 'ignore', stderr: 'inherit' });
await new Promise(r => setTimeout(r, 500));
const failures: string[] = [];
const check = (ok: boolean, msg: string) => { console.log(ok ? 'ok  ' : 'FAIL', msg); if (!ok) failures.push(msg); };
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
try {
  const b = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true, defaultViewport: { width: 1920, height: 940 },
    args: ['--ignore-gpu-blocklist', '--enable-gpu', '--use-angle=d3d11'] });
  const p = await b.newPage();
  const errs: string[] = [];
  p.on('pageerror', e => errs.push((e as Error).message));
  await p.goto('http://127.0.0.1:8090/');
  await p.waitForFunction(() => (globalThis as any).SceneManager?._scene?.constructor?.name === 'Scene_OmoriTitleScreen', { timeout: 90000 });
  await p.keyboard.press('F9'); await p.type('#dbg input[type=text]', 'player street'); await p.click('#dbg .row.hit');
  await p.waitForFunction(() => SceneManager._scene instanceof Scene_Map && $gameMap.mapId() === 13 && !$gamePlayer.isTransferring(), { timeout: 60000 });
  await sleep(1500); // the panel closes itself on teleport

  const info = () => p.evaluate((pid: number) => {
    const sp = SceneManager._scene._spriteset, c = sp._pictureContainer;
    const s = c.children.find((x: any) => x._pictureId === pid);
    return { gw: Graphics.width, ox: c.x, sx: s?.worldTransform.tx, w: s?.width, mask: sp._cutsceneMask.alpha, ready: !!s?.bitmap?.isReady() };
  }, 5);

  // full-screen opaque still at (0,0)
  await p.evaluate(() => $gameScreen.showPicture(5, 'Blackspace_polaroidBG_FA_day', 0, 0, 0, 100, 125, 255, 0)); // 679x408 source, stretched to cover the 640x480 box
  await p.waitForFunction(() => SceneManager._scene._spriteset._pictureContainer.children.find((x: any) => x._pictureId === 5)?.bitmap?.isReady(), { timeout: 20000 });
  await sleep(800);
  const big = await info();
  console.log(big);
  check(big.ox === (big.gw - 640) / 2, `picture layer is centred (offset ${big.ox} in ${big.gw}px view)`);
  check(Math.abs(big.sx - (big.gw - 640) / 2) < 1, `picture's left edge lands at ${(big.gw - 640) / 2} (got ${big.sx})`);
  check(big.mask > 0.9, `side panels cover the extra world behind a full-screen still (alpha ${big.mask})`);
  await p.screenshot({ path: 'test/out/cutscene-full.png' });

  // small picture: still centred layer, no side panels
  await p.evaluate(() => { $gameScreen.erasePicture(5); $gameScreen.showPicture(5, 'Blackspace_polaroidBG_FA_day', 0, 0, 0, 20, 20, 255, 0); });
  await sleep(800);
  const small = await info();
  check(small.mask === 0, `no side panels for a small picture (alpha ${small.mask})`);
  await p.screenshot({ path: 'test/out/cutscene-small.png' });

  check(errs.length === 0, `no page errors${errs.length ? ': ' + errs[0] : ''}`);
  await b.close();
} finally { server.kill(); }
if (failures.length) { console.error(`\n${failures.length} check(s) failed`); process.exit(1); }
console.log('\nall cutscene checks passed');
