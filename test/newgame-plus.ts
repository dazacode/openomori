// New Game+ example mod: carry-over of levels/items/gold into a fresh game, options respected, checkpoint made first.
import puppeteer from 'puppeteer-core';
import { mkdirSync } from 'node:fs';
import { ANGLE, CHROME } from './chrome.ts';
mkdirSync('test/out', { recursive: true });
const server = Bun.spawn(['bun', 'run', 'src/server.ts', '8099'], { stdout: 'ignore', stderr: 'inherit', env: { ...process.env, OMORI_MODS: 'examples' } });
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
  await p.goto('http://127.0.0.1:8099/');
  const title = () => p.waitForFunction(() => (globalThis as any).SceneManager?._scene?.constructor?.name === 'Scene_OmoriTitleScreen', { timeout: 90000 });
  await title();
  await p.evaluate(() => new Promise<void>((res, rej) => {
    const r = indexedDB.open('omori-mods');
    r.onsuccess = () => { const t = r.result.transaction('profiles', 'readwrite'); t.objectStore('profiles').put({ id: 'default', name: 'Original game', created: 0, enabled: [], devAuto: true, fsDb: 'omori-fs' }); t.oncomplete = () => res(); t.onerror = () => rej(t.error); };
  }));
  await p.reload(); await title();
  check(await p.evaluate(() => !!(globalThis as any).NewGamePlus), 'newgame-plus mod loaded');

  // a game in progress: start one via the debug panel's map teleport, then give it some progress
  await p.keyboard.press('F9');
  await p.type('#dbg input[type=text]', 'player street');
  await p.click('#dbg .row.hit');
  await p.waitForFunction(() => SceneManager._scene instanceof Scene_Map && $gameMap.mapId() === 13 && !$gamePlayer.isTransferring(), { timeout: 60000 });
  await sleep(1000);
  await p.keyboard.press('F9');
  await p.evaluate(() => {
    const a = $gameActors.actor(1); a.changeLevel(9, false);
    $gameParty.gainItem($dataItems[2], 3); $gameParty.gainGold(777);
    $gameSwitches.setValue(5, true); $gameVariables.setValue(3, 42);
  });
  const before = await p.evaluate(() => ({ lv: $gameActors.actor(1).level, item: $gameParty.numItems($dataItems[2]), gold: $gameParty.gold() }));

  const started = await p.evaluate(() => (globalThis as any).NewGamePlus.start());
  await p.waitForFunction(() => SceneManager._scene instanceof Scene_Map && !$gamePlayer.isTransferring() && $gameMap.mapId() > 0, { timeout: 60000 });
  await sleep(2500);   // let the opening events run, in case they reset anything
  const after = await p.evaluate(() => ({ lv: $gameActors.actor(1).level, item: $gameParty.numItems($dataItems[2]), gold: $gameParty.gold(), sw: $gameSwitches.value(5), v3: $gameVariables.value(3), cycle: (globalThis as any).NewGamePlus.cycle(), map: $gameMap.mapId() }));
  check(started === true, 'New Game+ started');
  check(after.lv === before.lv && after.item === before.item && after.gold === before.gold, `levels, items and gold carried over (${JSON.stringify(before)} -> ${JSON.stringify(after)})`);
  check(after.sw === false && after.v3 === 0, 'story state was reset (switch and variable back to defaults)');
  check(after.cycle === 1, 'cycle counter is 1');
  const cps = await p.evaluate(async () => (await (globalThis as any).OmoriMod.checkpoints.list()).map((c: any) => c.name));
  check(cps.includes('before New Game+'), 'a checkpoint of the old game was saved first');

  // options: turn levels off, run again from the new game -> level resets to default but the cycle goes up
  await p.evaluate(() => { (globalThis as any).NewGamePlus.options.levels.set(false); });
  await p.evaluate(() => (globalThis as any).NewGamePlus.start());
  await p.waitForFunction(() => SceneManager._scene instanceof Scene_Map && !$gamePlayer.isTransferring() && $gameMap.mapId() > 0, { timeout: 60000 });
  await sleep(1500);
  const second = await p.evaluate(() => ({ lv: $gameActors.actor(1).level, gold: $gameParty.gold(), cycle: (globalThis as any).NewGamePlus.cycle() }));
  check(second.lv !== before.lv && second.gold === before.gold && second.cycle === 2, `"Keep levels" off is respected (${JSON.stringify(second)})`);

  // the Settings screen shows the button and it works (after turning "Keep levels" back on)
  await p.evaluate(() => { (globalThis as any).NewGamePlus.options.levels.set(true); });
  await p.keyboard.press('F10');
  await sleep(600);
  const shown = await p.evaluate(() => { const tab = document.querySelector<HTMLElement>('[data-tab="mods"]'); tab?.click(); return !!tab; });
  await sleep(500);
  const clicked = await p.evaluate(() => { const b = [...document.querySelectorAll<HTMLElement>('button.btn')].find(e => e.textContent?.trim() === 'Start New Game+'); b?.click(); return !!b; });
  check(shown && clicked, 'Settings > Mods shows a "Start New Game+" button and it can be clicked');
  await p.waitForFunction(() => (globalThis as any).NewGamePlus.cycle() === 3, { timeout: 30000 }).then(() => check(true, 'the button started a New Game+ (cycle 3)'), () => check(false, 'the button started a New Game+ (cycle 3)'));
  await sleep(1500);
  await p.keyboard.press('Escape'); await sleep(300);

  // and the old game is recoverable
  await p.evaluate(async () => { const l = (await (globalThis as any).OmoriMod.checkpoints.list()).filter((c: any) => c.name === 'before New Game+'); await (globalThis as any).OmoriMod.checkpoints.restore(l[l.length - 1].id); });   // the oldest = the original game
  await p.waitForFunction(() => SceneManager._scene instanceof Scene_Map && !$gamePlayer.isTransferring() && $gameVariables.value(3) === 42, { timeout: 30000 });
  check(true, 'restoring "before New Game+" brings the old game back');
  check(errs.length === 0, `no page errors${errs.length ? ': ' + errs[0] : ''}`);
  await b.close();
} finally { server.kill(); }
if (failures.length) { console.error(`\n${failures.length} check(s) failed`); process.exit(1); }
console.log('\nall newgame-plus checks passed');
