// Checkpoints through the debug panel: capture, change state, diff, restore, undo checkpoint exists.
import puppeteer from 'puppeteer-core';
import { mkdirSync } from 'node:fs';
mkdirSync('test/out', { recursive: true });
const server = Bun.spawn(['bun', 'run', 'src/server.ts', '8095'], { stdout: 'ignore', stderr: 'inherit' });
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
  p.on('dialog', d => void d.accept());
  await p.goto('http://127.0.0.1:8095/?profile=default');
  await p.waitForFunction(() => (globalThis as any).SceneManager?._scene?.constructor?.name === 'Scene_OmoriTitleScreen', { timeout: 90000 });

  const tab = (name: string) => p.evaluate(n => { for (const x of document.querySelectorAll<HTMLButtonElement>('#dbg nav button')) if (x.textContent === n) x.click(); }, name);
  const press = (label: string) => p.evaluate(l => { for (const x of document.querySelectorAll<HTMLButtonElement>('#dbg button')) if (x.textContent === l) { x.click(); return true; } return false; }, label);

  await p.keyboard.press('F9');
  await p.type('#dbg input[type=text]', 'player street');
  await p.click('#dbg .row.hit');
  await p.waitForFunction(() => SceneManager._scene instanceof Scene_Map && $gameMap.mapId() === 13 && !$gamePlayer.isTransferring(), { timeout: 60000 });
  await sleep(1500);

  // state A
  await p.evaluate(() => { $gameSwitches.setValue(5, true); $gameVariables.setValue(3, 7); $gameParty.gainGold(123); });
  await p.keyboard.press('F9');
  await tab('checkpoints');
  await p.type('#dbg input[type=text]', 'state A');
  await press('Capture');
  await p.waitForFunction(() => /state A/.test(document.querySelector('#dbg .body')?.textContent ?? ''), { timeout: 10000 });
  check(true, 'checkpoint captured and listed');

  // state B
  await p.evaluate(() => { $gameSwitches.setValue(5, false); $gameSwitches.setValue(6, true); $gameVariables.setValue(3, 99); $gameParty.gainGold(1000); });
  await press('changes');
  await p.waitForSelector('#dbg .diff', { timeout: 10000 });
  const diff = await p.$eval('#dbg .diff', e => e.textContent ?? '');
  check(/switch 6.*ON/.test(diff) && /switch 5.*off/.test(diff) && /variable 3.*7 -> 99/.test(diff) && /gold/.test(diff), `diff lists the changes (${diff.split('\n').length} lines)`);

  // restore A
  await press('restore');
  await p.waitForFunction(() => SceneManager._scene instanceof Scene_Map && !$gamePlayer.isTransferring() && $gameVariables.value(3) === 7, { timeout: 30000 });
  await sleep(1000);
  const s = await p.evaluate(() => ({ s5: $gameSwitches.value(5), s6: $gameSwitches.value(6), v3: $gameVariables.value(3), map: $gameMap.mapId(), cur: SceneManager._scene.constructor.name }));
  check(s.s5 === true && s.s6 === false && s.v3 === 7 && s.map === 13 && s.cur === 'Scene_Map', `restore brought back state A (${JSON.stringify(s)})`);

  await p.keyboard.press('F9');
  await tab('checkpoints');
  await sleep(300);
  const text = await p.$eval('#dbg .body', e => e.textContent ?? '');
  check(/\(auto\) before restoring "state A"/.test(text), 'automatic undo checkpoint was created');

  // undo the restore from the auto checkpoint -> state B
  await p.evaluate(() => { for (const row of document.querySelectorAll('#dbg .cp')) if (/\(auto\)/.test(row.textContent ?? '')) { for (const x of row.querySelectorAll('button')) if (x.textContent === 'restore') x.click(); } });
  await p.waitForFunction(() => SceneManager._scene instanceof Scene_Map && !$gamePlayer.isTransferring() && $gameVariables.value(3) === 99, { timeout: 30000 });
  check(await p.evaluate(() => $gameSwitches.value(6)) === true, 'undo checkpoint restores the pre-restore state');
  const api = await p.evaluate(async () => { const l = await (globalThis as any).OmoriMod.checkpoints.list(); const d = await (globalThis as any).OmoriMod.checkpoints.diff('state A'); return { names: l.map((c: any) => c.name), changes: d.length }; });
  check(api.names.includes('state A') && api.changes > 0, `OmoriMod.checkpoints works from scripts (${api.names.length} checkpoints, ${api.changes} changes vs state A)`);
  // story-beat recorder: first time a "DayNFA - ..." switch turns on, one checkpoint (and not again)
  await p.evaluate(() => (globalThis as any).OmoriMod.checkpoints.recordBeats(true));
  await p.evaluate(() => $gameSwitches.setValue(996, true));
  await p.waitForFunction(async () => (await (globalThis as any).OmoriMod.checkpoints.list()).some((c: any) => c.beat), { timeout: 15000, polling: 300 });
  await p.evaluate(() => { $gameSwitches.setValue(996, false); $gameSwitches.setValue(996, true); });
  await sleep(1500);
  const beats = await p.evaluate(async () => (await (globalThis as any).OmoriMod.checkpoints.list()).filter((c: any) => c.beat).map((c: any) => c.name));
  check(beats.length === 1 && beats[0] === '[beat] Day1FA - Hobbeez', `beat recorder makes one checkpoint per story beat (${beats.join(', ')})`);
  await p.evaluate(() => (globalThis as any).OmoriMod.checkpoints.recordBeats(false));

  // forging: derive a state from a recorded checkpoint by patching flags (by id or by exact name), never touching the base
  const fg = await p.evaluate(async () => {
    const api = (globalThis as any).OmoriMod.checkpoints;
    const recipe = await api.compare('state A');                     // live game (state B at this point) vs state A
    const made = await api.forge('state A', { switches: { '6': true, 'Day1FA - Hobbeez': true }, variables: { '3': 123 } }, 'forged from A');
    const errs: string[] = [];
    for (const bad of [{ switches: { 'No such switch': true } }, { switches: { 'Day0DW-': true } }, {}]) { try { await api.forge('state A', bad, 'x'); errs.push('accepted'); } catch (e) { errs.push((e as Error).message); } }
    const diffBase = await api.diff('state A');
    return { recipe, made, errs, listed: (await api.list()).find((c: any) => c.name === 'forged from A')?.forged, diffBase: diffBase.length };
  });
  check(fg.recipe.switches['6'] === true && fg.recipe.switches['5'] === false && fg.recipe.variables['3'] === 99, `compare() returns the flag differences as a patch (${JSON.stringify(fg.recipe).slice(0, 90)})`);
  check(/^from "state A": s6=ON, s996=ON, v3=123$/.test(fg.made.forged) && !!fg.listed, `forge() records what it changed (${fg.made.forged})`);
  check(/does not exist/.test(fg.errs[0]!) && /matches several/.test(fg.errs[1]!) && /changes nothing/.test(fg.errs[2]!), `forge() rejects unknown names, ambiguous names and empty patches (${fg.errs.map((e: string) => e.slice(0, 30)).join(' | ')})`);
  await p.evaluate(() => (globalThis as any).OmoriMod.checkpoints.restore('forged from A'));
  await p.waitForFunction(() => SceneManager._scene instanceof Scene_Map && !$gamePlayer.isTransferring() && $gameVariables.value(3) === 123, { timeout: 30000 });
  const forged = await p.evaluate(() => ({ s5: $gameSwitches.value(5), s6: $gameSwitches.value(6), s996: $gameSwitches.value(996), v3: $gameVariables.value(3) }));
  check(forged.s5 === true && forged.s6 === true && forged.s996 === true && forged.v3 === 123, `restoring the forged checkpoint gives A's state plus the patch (${JSON.stringify(forged)})`);

  // routes: story position, route label, coverage against the real story, grouping
  const rt = await p.evaluate(async () => {
    const R = (globalThis as any).OmoriMod.checkpoints.routes;
    const cur = R.current(), cov = await R.coverage(), lines = await R.lines();
    return { last: cur.last?.name, route: cur.route, text: cur.text, cov: cov && { recorded: cov.recorded, total: cov.total, missingHas: cov.missing.includes('Day2DW - Saved Basil?'), recordedHasHob: !cov.missing.includes('Day1FA - Hobbeez') }, lines: lines.map((l: any) => l.route) };
  });
  check(rt.last === 'Day1FA - Hobbeez' && rt.route === 'undecided', `routes.current() reads the story position (${rt.text})`);
  check(!!rt.cov && rt.cov.total > 40 && rt.cov.recorded >= 1 && rt.cov.recordedHasHob && rt.cov.missingHas, `coverage compares the library with the story's settable beats (${rt.cov?.recorded} of ${rt.cov?.total})`);
  check(rt.lines.length >= 1, `checkpoints group into route lines (${rt.lines.join(', ')})`);
  await p.evaluate(() => { (globalThis as any).OmoriMod.checkpoints.recordBeats(true); $gameSwitches.setValue(1057, true); });   // Day2DW - Saved Basil?
  await p.waitForFunction(async () => (await (globalThis as any).OmoriMod.checkpoints.list()).some((c: any) => c.name === '[beat] Day2DW - Saved Basil?'), { timeout: 15000, polling: 300 });
  await p.evaluate(() => { $gameVariables.setValue(1076, 3); });   // [BS_TRUE_PATH] counter reaches 3
  await p.waitForFunction(async () => (await (globalThis as any).OmoriMod.checkpoints.list()).some((c: any) => c.name === '[beat] BS_TRUE_PATH 3'), { timeout: 15000, polling: 300 });
  const lines2 = await p.evaluate(async () => (await (globalThis as any).OmoriMod.checkpoints.routes.lines()).map((l: any) => `${l.route}:${l.checkpoints.length}`));
  check(lines2.some((l: string) => l.startsWith('true:')), `a counter beat is recorded and lands on the true route line (${lines2.join(', ')})`);
  await p.evaluate(() => (globalThis as any).OmoriMod.checkpoints.recordBeats(false));
  // the panel shows the coverage line and the story position of each checkpoint
  await p.keyboard.press('F9');
  await p.evaluate(() => { for (const b of document.querySelectorAll<HTMLButtonElement>('#dbg nav button')) if (b.textContent === 'checkpoints') b.click(); });
  await p.waitForFunction(() => /Story beats captured: \d+ of \d+/.test(document.querySelector('#dbg .body')?.textContent ?? ''), { timeout: 20000 });
  const panel = await p.$eval('#dbg .body', e => e.textContent ?? '');
  check(/true route/.test(panel) && /Day1FA - Hobbeez/.test(panel), 'panel shows coverage and the story position of each checkpoint');
  await p.keyboard.press('F9');

  // storage is gzipped and much smaller than the raw save
  const st = await p.evaluate(() => new Promise<any>((res, rej) => {
    const r = indexedDB.open('omori-checkpoints');
    r.onsuccess = () => { const q = r.result.transaction('checkpoints').objectStore('checkpoints').getAll(); q.onsuccess = () => { const c = q.result.find((x: any) => x.beat); res({ gz: c.z.length, plain: JSON.stringify(JSON.stringify(c.digest)).length, hasSave: 'save' in c && !!c.save }); }; q.onerror = () => rej(q.error); };
  }));
  check(st.gz > 0 && !st.hasSave, `checkpoints are stored gzipped (${(st.gz / 1024).toFixed(0)} KB)`);

  // a mod can ship a checkpoint: build the file form from a stored one, register it, restore it, and it cannot be deleted
  const prov = await p.evaluate(async () => {
    const raw: any = await new Promise(res => { const r = indexedDB.open('omori-checkpoints'); r.onsuccess = () => { const q = r.result.transaction('checkpoints').objectStore('checkpoints').getAll(); q.onsuccess = () => res(q.result.find((x: any) => x.beat)); }; });
    let bin = ''; for (const b of raw.z) bin += String.fromCharCode(b);
    const api = (globalThis as any).OmoriMod.checkpoints;
    api.register('Shipped by a mod', { format: 'omori-checkpoint', version: 2, name: 'Shipped by a mod', digest: raw.digest, saveGz: btoa(bin) });
    await new Promise(r => setTimeout(r, 800));
    const l = await api.list();
    const hit = l.find((c: any) => c.name === 'Shipped by a mod');
    let delErr = ''; try { await api.remove('Shipped by a mod'); } catch (e) { delErr = (e as Error).message; }
    await api.restore('Shipped by a mod');
    return { listed: !!hit && !!hit.provided, delErr };
  });
  await p.waitForFunction(() => SceneManager._scene instanceof Scene_Map && !$gamePlayer.isTransferring(), { timeout: 30000 });
  check(prov.listed && /provided by a mod/.test(prov.delErr), `mod-provided checkpoint is listed, restorable, and not deletable (${prov.delErr})`);
  check(await p.evaluate(() => $gameSwitches.value(996)) === true, 'restoring the shipped checkpoint put its state back');
  await p.screenshot({ path: 'test/out/checkpoints.png' });
  check(errs.length === 0, `no page errors${errs.length ? ': ' + errs[0] : ''}`);
  await b.close();
} finally { server.kill(); }
if (failures.length) { console.error(`\n${failures.length} check(s) failed`); process.exit(1); }
console.log('\nall checkpoint checks passed');
