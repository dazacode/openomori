// Drives the debug panel like a user would: F9, filter maps, teleport from the title screen, edit state.
import puppeteer from 'puppeteer-core';
import { mkdirSync } from 'node:fs';
import { ANGLE, CHROME } from './chrome.ts';
mkdirSync('test/out', { recursive: true });
const server = Bun.spawn(['bun', 'run', 'src/server.ts', '8094'], { stdout: 'ignore', stderr: 'inherit' });
await new Promise(r => setTimeout(r, 500));
const failures: string[] = [];
const check = (ok: boolean, msg: string) => { console.log(ok ? 'ok  ' : 'FAIL', msg); if (!ok) failures.push(msg); };
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
try {
  const b = await puppeteer.launch({ executablePath: CHROME, headless: true, defaultViewport: { width: 1920, height: 940 },
    args: ['--ignore-gpu-blocklist', '--enable-gpu', ANGLE] });
  const p = await b.newPage();
  const errs: string[] = [];
  p.on('pageerror', e => errs.push((e as Error).message));
  await p.goto('http://127.0.0.1:8094/');
  await p.waitForFunction(() => (globalThis as any).SceneManager?._scene?.constructor?.name === 'Scene_OmoriTitleScreen', { timeout: 90000 });

  const isOpen = () => p.evaluate(() => document.getElementById('dbg')!.classList.contains('open'));
  await p.keyboard.press('F9');
  check(await isOpen(), 'F9 opens the panel');
  await p.screenshot({ path: 'test/out/debug-open.png' });

  // typing into the filter must not leak keystrokes into the game
  await p.type('#dbg input[type=text]', 'player street');
  const rows = await p.$$eval('#dbg .row.hit', r => r.map(x => x.textContent));
  check(rows.length >= 1 && /PLAYER STREET/i.test(rows[0] ?? ''), `map filter works (${rows.join(' | ')})`);
  check(await p.evaluate(() => SceneManager._scene.constructor.name) === 'Scene_OmoriTitleScreen', 'typing did not trigger the game');

  await p.click('#dbg .row.hit');
  await p.waitForFunction(() => SceneManager._scene instanceof Scene_Map && $gameMap.mapId() === 13 && !$gamePlayer.isTransferring(), { timeout: 60000 });
  await sleep(1500);
  const where = await p.evaluate(() => ({ map: $gameMap.mapId(), x: $gamePlayer.x, y: $gamePlayer.y, pass: $gameMap.isPassable($gamePlayer.x, $gamePlayer.y, 2) }));
  check(where.map === 13 && where.pass, `teleported to Player Street on a walkable tile (${where.x},${where.y})`);
  const cam = await p.evaluate(() => ({ sx: $gamePlayer.screenX(), gw: Graphics.width, visible: !$gamePlayer.isTransparent() }));
  check(cam.visible, 'player is visible after teleport');
  check(Math.abs(cam.sx - cam.gw / 2) < 48, `camera centres the player in the wide view (screenX ${cam.sx} vs half-width ${cam.gw / 2})`);
  await p.screenshot({ path: 'test/out/debug-teleported.png' });

  // state editing
  await p.keyboard.press('F9');
  await p.evaluate(() => { for (const b of document.querySelectorAll<HTMLButtonElement>('#dbg nav button')) if (b.textContent === 'switches') b.click(); });
  const sw = await p.$$eval('#dbg .row input[type=checkbox]', c => c.length);
  check(sw > 0, `switches tab lists switches (${sw} shown)`);
  await p.evaluate(() => { document.querySelector<HTMLInputElement>('#dbg .row input[type=checkbox]')!.click(); });
  check(await p.evaluate(() => $gameSwitches.value(1)) === true, 'toggling a switch changes game state');

  await p.evaluate(() => { for (const b of document.querySelectorAll<HTMLButtonElement>('#dbg nav button')) if (b.textContent === 'party') b.click(); });
  await p.evaluate(() => { $gameParty.members()[0].setHp(1); });
  await p.evaluate(() => { for (const b of document.querySelectorAll<HTMLButtonElement>('#dbg button')) if (b.textContent === 'Heal all') b.click(); });
  const hp = await p.evaluate(() => { const a = $gameParty.members()[0]; return [a.hp, a.mhp]; });
  check(hp[0] === hp[1], `Heal all restores HP (${hp[0]}/${hp[1]})`);
  await p.screenshot({ path: 'test/out/debug-party.png' });

  await p.keyboard.press('F9');
  check(!(await isOpen()), 'F9 closes the panel');
  check(errs.length === 0, `no page errors${errs.length ? ': ' + errs[0] : ''}`);
  await b.close();
} finally { server.kill(); }
if (failures.length) { console.error(`\n${failures.length} check(s) failed`); process.exit(1); }
console.log('\nall debug-panel checks passed');
