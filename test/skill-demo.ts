// End-to-end test of the mod made in the omori-modding skill's workflow (mods/skill-demo): hand-written dialogue, a map from a
// spec, an event that reads the dialogue with ShowMessage, a self-switch page change. Runs in real Chrome.
import puppeteer from 'puppeteer-core';
import { cpSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ANGLE, CHROME } from './chrome.ts';
mkdirSync('test/out', { recursive: true });
// Isolated dev folder with only this mod: other mods that extend MapInfos (see the note in the skill) would shift its registry entry.
const isolated = mkdtempSync(join(tmpdir(), 'skill-demo-'));
cpSync('mods/skill-demo', join(isolated, 'skill-demo'), { recursive: true });
const server = Bun.spawn(['bun', 'run', 'src/server.ts', '8096'], { stdout: 'ignore', stderr: 'inherit', env: { ...process.env, OMORI_MODS: isolated } });
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
  await p.goto('http://127.0.0.1:8096/');
  const title = () => p.waitForFunction(() => (globalThis as any).SceneManager?._scene?.constructor?.name === 'Scene_OmoriTitleScreen', { timeout: 90000 });
  await title();
  // Load every dev-folder mod automatically, for the default profile, then reload (as story-demo does)
  await p.evaluate(() => new Promise<void>((res, rej) => {
    const r = indexedDB.open('omori-mods');
    r.onsuccess = () => {
      const t = r.result.transaction('profiles', 'readwrite');
      t.objectStore('profiles').put({ id: 'default', name: 'Original game', created: 0, enabled: [], devAuto: true, fsDb: 'omori-fs' });
      t.oncomplete = () => res(); t.onerror = () => rej(t.error);
    };
  }));
  await p.reload(); await title();
  check(await p.evaluate(() => (globalThis as any).OmoriMod.mods.some((m: any) => m.id === 'skill-demo' && m.enabled)), 'skill-demo mod is loaded');
  check(await p.evaluate(() => ($dataMapInfos as any)[1300]?.name) === 'SKILL DEMO HALL', 'map 1300 is registered in MapInfos');

  await p.keyboard.press('F9');
  await p.type('#dbg input[type=text]', 'skill demo');
  await p.click('#dbg .row.hit');
  await p.waitForFunction(() => SceneManager._scene instanceof Scene_Map && $gameMap.mapId() === 1300 && !$gamePlayer.isTransferring(), { timeout: 60000 });
  await sleep(1500);
  const m = await p.evaluate(() => ({ w: $gameMap.width(), h: $gameMap.height(), ev: $gameMap.events().length, name: $gameMap.displayName() }));
  check(m.w === 34 && m.h === 12 && m.ev === 1 && m.name === 'SKILL DEMO HALL', `new map loads with its event (${JSON.stringify(m)})`);
  check(await p.evaluate(() => LanguageManager.getMessageData('skilldemo_note.message_0').text) === 'A note is taped to the door.\\!', 'dialogue from the hand-written yml resolves');

  const talk = async () => {
    await p.evaluate(() => { $gameMessage.clear(); $gameMap._interpreter.clear(); $gamePlayer.locate(11, 6); $gamePlayer.setDirection(6); $gamePlayer.checkEventTriggerThere([0]); });
    await p.waitForFunction(() => $gameMessage.hasText(), { timeout: 8000 });
    return p.evaluate(() => ($gameMessage as any)._texts.join('|'));
  };
  const first = await talk();
  check(/A note is taped/.test(first), `talking to the note shows the first message (${first.slice(0, 60)})`);
  await p.evaluate(() => $gameMessage.clear());
  await p.waitForFunction(() => $gameMessage.hasText(), { timeout: 8000 });
  const second = await p.evaluate(() => ($gameMessage as any)._texts.join('|'));
  check(/DON'T/.test(second), `the next message follows in the same event (${second.slice(0, 60)})`);
  await p.evaluate(() => { $gameMessage.clear(); $gameMap._interpreter.clear(); $gameSelfSwitches.setValue([1300, 1, 'A'], true); $gameMap.refresh(); });
  check(/Nothing else is written/.test(await talk()), 'self-switch changes the note to its second page');
  await p.screenshot({ path: 'test/out/skill-demo.png' });
  check(errs.length === 0, `no page errors${errs.length ? ': ' + errs[0] : ''}`);
  await b.close();
} finally { server.kill(); }
if (failures.length) { console.error(`\n${failures.length} check(s) failed`); process.exit(1); }
console.log('\nall skill-demo checks passed');
