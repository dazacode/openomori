// Jumps straight into maps (skipping the intro) and screenshots them, optionally with a message box.
// usage: bun run test/visual.ts <mapId[,mapId...]> [q] [--msg]
import puppeteer from 'puppeteer-core';
import { ANGLE, CHROME } from './chrome.ts';
const [maps = '13', q = '2'] = process.argv.slice(2);
const withMsg = process.argv.includes('--msg');
const server = Bun.spawn(['bun', 'run', 'src/server.ts', '8096'], { stdout: 'ignore', stderr: 'inherit' });
await new Promise(r => setTimeout(r, 500));
const b = await puppeteer.launch({ executablePath: CHROME, headless: true, defaultViewport: { width: 1920, height: 940 },
  args: ['--ignore-gpu-blocklist', '--enable-gpu', ANGLE] });
const p = await b.newPage();
const errs: string[] = [];
p.on('pageerror', e => errs.push((e as Error).message));
await p.goto(`http://127.0.0.1:8096/?q=${q}${process.env.WIDE === '0' ? '&wide=0' : ''}`);
await p.waitForFunction(() => (globalThis as any).SceneManager?._scene?.constructor?.name === 'Scene_OmoriTitleScreen', { timeout: 90000 });
await new Promise(r => setTimeout(r, 1500));
await p.screenshot({ path: 'test/out/title.png' });
for (const id of maps.split(',').map(Number)) {
  await p.evaluate((i: number) => {
    DataManager.setupNewGame();
    $gamePlayer.reserveTransfer(i, 6, 5, 2, 0);
    SceneManager.goto(Scene_Map);
  }, id);
  await p.waitForFunction(() => $dataMap?.width && $gameMap.width?.() > 0 && SceneManager._scene.constructor.name === 'Scene_Map', { timeout: 60000 });
  await new Promise(r => setTimeout(r, 1500));
  if (withMsg) await p.evaluate(() => { (globalThis as any).$gameMessage.add('Hello! This is a test message box.'); });
  await new Promise(r => setTimeout(r, 2500));
  await p.screenshot({ path: `test/out/map${id}${withMsg ? '-msg' : ''}.png` });
  console.log(`map ${id}: gfx=${await p.evaluate(() => `${Graphics.width}x${Graphics.height} box=${Graphics.boxWidth}x${Graphics.boxHeight}`)} errors=${errs[0] ?? 'none'}`);
}
await b.close(); server.kill();
