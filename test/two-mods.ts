// Two mods that both register maps, in one dev folder: skill-demo (map 1300) and Sunburn (maps 1100-1206). Each sets its own
// slot in data/MapInfos.json (the `set` op), so neither shifts the other. Runs in real Chrome.
import puppeteer from 'puppeteer-core';
import { cpSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ANGLE, CHROME } from './chrome.ts';
mkdirSync('test/out', { recursive: true });
const dir = mkdtempSync(join(tmpdir(), 'two-mods-'));
cpSync('mods/skill-demo', join(dir, 'skill-demo'), { recursive: true });
cpSync('/Users/seanolivermarzan/Dev/OMORI/omori-fanfic-mod-project/sunburn', join(dir, 'sunburn'), { recursive: true });
const server = Bun.spawn(['bun', 'run', 'src/server.ts', '8092'], { stdout: 'ignore', stderr: 'inherit', env: { ...process.env, OMORI_MODS: dir } });
await new Promise(r => setTimeout(r, 500));
const failures: string[] = [];
const check = (ok: boolean, msg: string) => { console.log(ok ? 'ok  ' : 'FAIL', msg); if (!ok) failures.push(msg); };
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
try {
  const b = await puppeteer.launch({ executablePath: CHROME, headless: true, defaultViewport: { width: 1920, height: 940 }, args: ['--ignore-gpu-blocklist', '--enable-gpu', ANGLE] });
  const p = await b.newPage();
  const errs: string[] = [];
  p.on('pageerror', e => errs.push((e as Error).message));
  await p.goto('http://127.0.0.1:8092/');
  const title = () => p.waitForFunction(() => (globalThis as any).SceneManager?._scene?.constructor?.name === 'Scene_OmoriTitleScreen', { timeout: 120000 });
  await title();
  await p.evaluate(() => new Promise<void>((res, rej) => {
    const r = indexedDB.open('omori-mods');
    r.onsuccess = () => {
      const t = r.result.transaction('profiles', 'readwrite');
      t.objectStore('profiles').put({ id: 'default', name: 'Original game', created: 0, enabled: [], devAuto: true, fsDb: 'omori-fs' });
      t.oncomplete = () => res(); t.onerror = () => rej(t.error);
    };
  }));
  await p.reload(); await title();
  const loaded = await p.evaluate(() => ['skill-demo', 'sunburn'].map(id => (globalThis as any).OmoriMod.mods.some((m: any) => m.id === id && m.enabled)));
  check(loaded.every(Boolean), `both mods loaded (${loaded.join(', ')})`);
  const infos = await p.evaluate(() => { const d = ($dataMapInfos as any); return { demo: d[1300]?.name, chapel: d[1206]?.name, hospital: d[1100]?.name, len: d.length }; });
  check(infos.demo === 'SKILL DEMO HALL', `skill-demo's map 1300 is registered (${infos.demo})`);
  check(infos.hospital === 'SUNBURN 1: HOSPITAL' && infos.chapel === 'SUNBURN 11: CHAPEL', `Sunburn's maps 1100 and 1206 are registered (${infos.hospital}, ${infos.chapel})`);

  await p.keyboard.press('F9');
  await p.type('#dbg input[type=text]', 'skill demo');
  await p.click('#dbg .row.hit');
  await p.waitForFunction(() => SceneManager._scene instanceof Scene_Map && $gameMap.mapId() === 1300 && !$gamePlayer.isTransferring(), { timeout: 60000 });
  await sleep(1500);
  check(await p.evaluate(() => $gameMap.displayName()) === 'SKILL DEMO HALL', 'skill-demo map loads with both mods installed');
  check(await p.evaluate(() => LanguageManager.getMessageData('skilldemo_note.message_0').text) === 'A note is taped to the door.\\!', 'skill-demo dialogue resolves with both mods installed');
  check(errs.length === 0, `no page errors${errs.length ? ': ' + errs[0] : ''}`);
  await b.close();
} finally { server.kill(); }
if (failures.length) { console.error(`\n${failures.length} check(s) failed`); process.exit(1); }
console.log('\nall two-mod checks passed');
