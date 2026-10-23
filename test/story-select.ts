// Story select: jump to every part of the story in real Chrome and check where the game lands.
// For each part: the right map, a tile the player can stand on, the story switches, the world, the party and the level.
// Only the story-select mod is loaded (OMORI_MODS), so nothing else hooks the game. Screenshots go to test/out/story/.
import puppeteer from 'puppeteer-core';
import { cpSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ANGLE, CHROME } from './chrome.ts';

const PORT = 8099;
const only = process.argv.slice(2);
mkdirSync('test/out/story', { recursive: true });
const mods = mkdtempSync(join(tmpdir(), 'omori-story-'));
cpSync('mods/story-select', join(mods, 'story-select'), { recursive: true });
const server = Bun.spawn(['bun', 'run', 'src/server.ts', String(PORT)], { stdout: 'ignore', stderr: 'inherit', env: { ...process.env, OMORI_MODS: mods } });
await new Promise(r => setTimeout(r, 600));
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const failures: string[] = [];
const check = (ok: boolean, msg: string) => { console.log(ok ? 'ok  ' : 'FAIL', msg); if (!ok) failures.push(msg); };

try {
  const b = await puppeteer.launch({ executablePath: CHROME, headless: true, defaultViewport: { width: 1280, height: 720 },
    args: ['--ignore-gpu-blocklist', '--enable-gpu', ANGLE] });
  const p = await b.newPage();
  const errs: string[] = [];
  p.on('pageerror', e => errs.push(`${(e as Error).message}\n${String((e as Error).stack).split('\n').slice(1, 6).join('\n')}`));
  p.on('console', m => { if (m.type() === 'error' || (m.type() === 'warning' && /story-select/.test(m.text()))) errs.push(m.text() + (process.env.STACK ? '\n' + m.stackTrace().slice(0, 6).map(f => `  ${f.url.split('/').pop()}:${f.lineNumber}`).join('\n') : '')); });
  p.on('dialog', d => void d.accept());
  const title = () => p.waitForFunction(() => (globalThis as any).SceneManager?._scene?.constructor?.name === 'Scene_OmoriTitleScreen', { timeout: 90000 });
  await p.goto(`http://127.0.0.1:${PORT}/`);
  await title();
  // load every dev-folder mod for the default profile, then reload (as skill-demo / story-demo do)
  await p.evaluate(() => new Promise<void>((res, rej) => {
    const r = indexedDB.open('omori-mods');
    r.onsuccess = () => {
      const t = r.result.transaction('profiles', 'readwrite');
      t.objectStore('profiles').put({ id: 'default', name: 'Original game', created: 0, enabled: [], devAuto: true, fsDb: 'omori-fs' });
      t.oncomplete = () => res(); t.onerror = () => rej(t.error);
    };
  }));
  await p.reload(); await title();
  await p.waitForFunction(() => !!(globalThis as any).OmoriMod?.storySelect, { timeout: 30000 });

  const parts: { id: string; l: string; at: number[]; p: string; lv: number; after: string; also?: string[]; drop?: number[] }[] =
    await p.evaluate(() => (globalThis as any).OmoriMod.storySelect.parts);
  const order: string[] = await p.evaluate(() => (globalThis as any).OmoriMod.storySelect.order);
  console.log(`${parts.length} parts, ${order.length} ordered story switches`);

  // every switch name in the order resolves in this build's database
  const unresolved = await p.evaluate((names: string[]) => names.filter(n => !$dataSystem.switches.some(s => (s ?? '').trim() === n)), [...order, '[Something Battle]', '[Basil Memories]', '[Blackspace]', "[Omori's Castle]", '[Final Memories]', '[Neutral: Epilogue]']);
  check(unresolved.length === 0, `all story switch names exist (${unresolved.join(', ') || 'none missing'})`);

  const WORLD: Record<string, number> = { sunny: 2, sunnyKel: 2, sunnyKelHero: 2, sunnyAll: 2, omori: 1, omoriKel: 1, omoriAll: 1 };
  for (const part of parts) {
    if (only.length && !only.includes(part.id)) continue;
    errs.length = 0;
    await p.evaluate((id: string) => { void (globalThis as any).OmoriMod.storySelect.jump(id); }, part.id);
    try {
      await p.waitForFunction((m: number) => SceneManager._scene instanceof Scene_Map && $gameMap.mapId() === m && !$gamePlayer.isTransferring() && !$gameTemp.isCommonEventReserved() && !$gameMap._interpreter.isRunning(), { timeout: 60000 }, part.at[0]);
    } catch {
      const st = await p.evaluate(() => ({ scene: SceneManager._scene?.constructor?.name, map: $gameMap?.mapId(), tr: $gamePlayer?.isTransferring(), ce: $gameTemp?.isCommonEventReserved(), run: $gameMap?._interpreter?.isRunning(), msg: $gameMessage?.hasText() }));
      check(false, `${part.id}: never settled on map ${part.at[0]} ${JSON.stringify(st)} ${errs.slice(0, 2).join(' | ')}`);
      await p.screenshot({ path: `test/out/story/${part.id}-stuck.png` });
      continue;
    }
    await sleep(Number(process.env.WAIT ?? 1500));
    const s = await p.evaluate(() => {
      const sw = $dataSystem.switches;
      return {
        scene: SceneManager._scene.constructor.name, map: $gameMap.mapId(), x: $gamePlayer.x, y: $gamePlayer.y,
        stand: [2, 4, 6, 8].some(d => $gameMap.isPassable($gamePlayer.x, $gamePlayer.y, d)),
        world: $gameVariables.value(22), fa: $gameSwitches.value(7),
        party: $gameParty.members().map(a => a.actorId()),
        lv: [1, 2, 3, 4].map(i => $gameActors.actor(i).level),
        on: sw.map((n, i) => (n && $gameSwitches.value(i) ? n.trim() : '')).filter(Boolean),
        dbg: { w: $gameMap.width(), h: $gameMap.height(), dx: $gameMap.displayX(), dy: $gameMap.displayY(), tiles: [0, 1, 2, 3, 4, 5].map(z => $gameMap.tileId($gamePlayer.x, $gamePlayer.y, z)), camera: !!(window as any).$gameSystem?._camEnabled },
      };
    });
    const want = new Set([...order.slice(0, part.after ? order.indexOf(part.after) + 1 : 0), ...(part.also ?? [])]);
    const missing = [...want].filter(n => !s.on.includes(n));
    const bad = [];
    if (s.scene !== 'Scene_Map') bad.push(`scene ${s.scene}`);
    // (the night map's own scene puts the player in bed, which is not a walkable tile)
    if (!s.stand && s.map !== 78) bad.push(`blocked tile ${s.x},${s.y}`);
    if (s.world !== WORLD[part.p]) bad.push(`world ${s.world}`);
    if (missing.length) bad.push(`missing switches ${missing.join(', ')}`);
    if (Math.abs(s.x - part.at[1]) + Math.abs(s.y - part.at[2]) > 9) bad.push(`moved far from ${part.at[1]},${part.at[2]} to ${s.x},${s.y}`);
    if (part.p.startsWith('omori') && !s.lv.every(l => l === part.lv)) bad.push(`levels ${s.lv}`);
    // the game's own area-logo event asks for picture sprite 100 of 99 and the interpreter logs it and carries on (original behaviour)
    const real = errs.filter(e => !/updateCustomFrame/.test(e));
    if (real.length) bad.push(`errors: ${real.slice(0, 2).join(' | ')}`);
    if (bad.length) console.log('     ', JSON.stringify(s.dbg));
    check(bad.length === 0, `${part.id}: map ${s.map} @${s.x},${s.y} world ${s.world} party [${s.party}] lv ${s.lv[0]} switches ${s.on.length}${bad.length ? '  ->  ' + bad.join('; ') : ''}`);
    await p.screenshot({ path: `test/out/story/${part.id}.png` });
  }
  await b.close();
} finally {
  server.kill();
}
console.log(failures.length ? `\n${failures.length} FAILED` : '\nall ok');
process.exit(failures.length ? 1 : 0);
