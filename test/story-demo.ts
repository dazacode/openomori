// A mod built only with `mod map build` (no RPG Maker, no Tiled): new map, stamped tiles, NPC pages, loose sprite, door.
import puppeteer from 'puppeteer-core';
import { mkdirSync } from 'node:fs';
mkdirSync('test/out', { recursive: true });
const server = Bun.spawn(['bun', 'run', 'src/server.ts', '8097'], { stdout: 'ignore', stderr: 'inherit', env: { ...process.env, OMORI_MODS: 'examples/story-demo/..' } });
await new Promise(r => setTimeout(r, 500));
const failures: string[] = [];
const check = (ok: boolean, msg: string) => { console.log(ok ? 'ok  ' : 'FAIL', msg); if (!ok) failures.push(msg); };
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
try {
  const b = await puppeteer.launch({ executablePath: process.env.CHROME ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true, defaultViewport: { width: 1920, height: 940 },
    args: ['--ignore-gpu-blocklist', '--enable-gpu', '--use-angle=d3d11'] });
  const p = await b.newPage();
  const errs: string[] = [];
  p.on('pageerror', e => errs.push((e as Error).message));
  await p.goto('http://127.0.0.1:8097/');
  const title = () => p.waitForFunction(() => (globalThis as any).SceneManager?._scene?.constructor?.name === 'Scene_OmoriTitleScreen', { timeout: 90000 });
  await title();
  // "Load every dev-folder mod automatically" on for the default profile, then reload
  await p.evaluate(() => new Promise<void>((res, rej) => {
    const r = indexedDB.open('omori-mods');
    r.onsuccess = () => {
      const t = r.result.transaction('profiles', 'readwrite');
      t.objectStore('profiles').put({ id: 'default', name: 'Original game', created: 0, enabled: [], devAuto: true, fsDb: 'omori-fs' });
      t.oncomplete = () => res(); t.onerror = () => rej(t.error);
    };
  }));
  await p.reload(); await title();
  check(await p.evaluate(() => (globalThis as any).OmoriMod.mods.some((m: any) => m.id === 'story-demo' && m.enabled)), 'story-demo mod is loaded');
  check(await p.evaluate(() => ($dataMapInfos as any)[1001]?.name) === 'DEMO STREET', 'map 1001 is registered in MapInfos');

  await p.keyboard.press('F9');
  await p.type('#dbg input[type=text]', 'demo street');
  await p.click('#dbg .row.hit');
  await p.waitForFunction(() => SceneManager._scene instanceof Scene_Map && $gameMap.mapId() === 1001 && !$gamePlayer.isTransferring(), { timeout: 60000 });
  await sleep(1500);
  const m = await p.evaluate(() => ({ w: $gameMap.width(), h: $gameMap.height(), ev: $gameMap.events().length, name: $gameMap.displayName() }));
  check(m.w === 34 && m.h === 12 && m.ev === 3 && m.name === 'DEMO STREET', `new map loads with its events (${JSON.stringify(m)})`);
  check(await p.evaluate(() => LanguageManager.getMessageData('story-demo_map1001.message_0').text) === 'Welcome to a map made with no RPG Maker.', 'dialogue from the generated yml resolves');
  const spr = await p.evaluate(async () => { const bm = ImageManager.loadCharacter('DEMO_NPC'); for (let i = 0; i < 100 && !bm.isReady(); i++) await new Promise(r => setTimeout(r, 100)); return bm.isReady() && $gameMap.event(2).characterName() === 'DEMO_NPC'; });
  check(spr, 'a loose PNG sprite (not in the game) loads and is used by an event');

  const tiles = await p.evaluate(() => {
    const td = SceneManager._scene._spriteset._tilemap.tiledData;
    const ts = td.tilesets.find((t: any) => /DEMO_TILES/.test(t.source));
    const layer = td.layers.find((l: any) => l.name === 'ABOVE ALL - IV');
    return { have: !!ts, count: ts?.tilecount, got: [layer.data[2 * 34 + 14], layer.data[2 * 34 + 15], layer.data[3 * 34 + 14], layer.data[3 * 34 + 15]], first: ts?.firstgid };
  });
  check(tiles.have && tiles.count === 4 && tiles.got.join() === [0, 1, 2, 3].map(i => tiles.first + i).join(), `custom tileset from a mod PNG is defined and painted (${JSON.stringify(tiles)})`);

  const talk = async () => {
    await p.evaluate(() => { $gameMessage.clear(); $gameMap._interpreter.clear(); $gamePlayer.locate(11, 6); $gamePlayer.setDirection(6); $gamePlayer.checkEventTriggerThere([0]); });
    await p.waitForFunction(() => $gameMessage.hasText(), { timeout: 8000 });
    return p.evaluate(() => ($gameMessage as any)._texts.join('|'));
  };
  check(/Welcome to a map/.test(await talk()), 'talking to the guide shows page 1');
  await p.evaluate(() => { $gameMessage.clear(); $gameMap._interpreter.clear(); $gameSelfSwitches.setValue([1001, 1, 'A'], true); $gameMap.refresh(); });
  check(/Event pages work/.test(await talk()), 'self-switch changes the guide to page 2');
  await p.screenshot({ path: 'test/out/story-demo.png' });

  await p.evaluate(() => { $gameMessage.clear(); $gameMap._interpreter.clear(); $gamePlayer.locate(31, 6); $gamePlayer.setDirection(6); $gamePlayer.moveStraight(6); });
  await p.waitForFunction(() => $gameMap.mapId() === 13 && !$gamePlayer.isTransferring(), { timeout: 20000 }).then(() => check(true, 'the exit door transfers back to a real game map'), () => check(false, 'the exit door transfers back to a real game map'));
  // edit-demo changes the game's own map 217 in place: original events kept, one added
  await p.evaluate(() => { $gamePlayer.reserveTransfer(217, 8, 10, 2, 0); });
  await p.waitForFunction(() => $gameMap.mapId() === 217 && !$gamePlayer.isTransferring(), { timeout: 30000 });
  await sleep(1000);
  const ed = await p.evaluate(() => ({ n: $gameMap.events().length, names: $gameMap.events().map((e: any) => e.event().name) }));
  check(ed.n === 3 && ed.names.includes('Visitor') && ed.names.includes('HUMPHREY SPIT'), `editing a game map keeps its events and adds new ones (${ed.names.join(', ')})`);
  check(errs.length === 0, `no page errors${errs.length ? ': ' + errs[0] : ''}`);
  await b.close();
} finally { server.kill(); }
if (failures.length) { console.error(`\n${failures.length} check(s) failed`); process.exit(1); }
console.log('\nall story-demo checks passed');
