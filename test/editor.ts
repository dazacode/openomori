// Drives the map editor in a real browser against a throwaway mod: new map, stamp, paint, walls, event, undo, save, build.
import puppeteer from 'puppeteer-core';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CHROME } from './chrome.ts';
mkdirSync('test/out', { recursive: true });
// Like the real setup: the mod's source lives in one folder, the game loads a synced copy from another.
const mods = mkdtempSync(join(tmpdir(), 'editor-test-'));          // the game's dev folder (a copy)
const srcRoot = mkdtempSync(join(tmpdir(), 'editor-src-'));        // where the editor should work
for (const root of [mods, srcRoot]) { mkdirSync(join(root, 'ed-test')); writeFileSync(join(root, 'ed-test', 'mod.json'), JSON.stringify({ id: 'ed-test', name: 'Editor Test', version: '0.0.1' })); }
const server = Bun.spawn(['bun', 'run', 'src/server.ts', '8125'], { stdout: 'ignore', stderr: 'inherit', env: { ...process.env, OMORI_MODS: mods, OMORI_EDITOR_MODS: srcRoot } });
await new Promise(r => setTimeout(r, 1200));
const failures: string[] = [];
const check = (ok: boolean, msg: string) => { console.log(ok ? 'ok  ' : 'FAIL', msg); if (!ok) failures.push(msg); };
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const b = await puppeteer.launch({ executablePath: CHROME, headless: true, defaultViewport: { width: 1440, height: 900 } });
try {
  const p = await b.newPage();
  const errs: string[] = [];
  p.on('pageerror', e => errs.push((e as Error).message));
  p.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
  await p.goto('http://127.0.0.1:8125/editor/', { waitUntil: 'networkidle0' });
  const E = <T>(fn: () => T) => p.evaluate(fn);
  await p.waitForFunction(() => (window as any).OmoriEditor?.S.mods.length > 0);
  await p.select('#modSel', 'ed-test');
  await p.waitForFunction(() => (window as any).OmoriEditor.S.mod === 'ed-test');
  check(true, 'the temp mod is listed and can be selected');

  // new map through the dialog
  await p.click('#emptyNew');
  await p.waitForSelector('dialog[open]');
  await p.evaluate(() => { const i = document.querySelectorAll('dialog input[type=text]')[0] as HTMLInputElement; i.value = 'TEST YARD'; });
  const btns = await p.$$('dialog .df .btn'); await btns[1]!.click();
  await p.waitForFunction(() => (window as any).OmoriEditor.S.doc?.id === 1000, { timeout: 15000 });
  check(true, 'new map 1000 created and opened');
  check(existsSync(join(srcRoot, 'ed-test', 'maps', '1000.spec.json')), 'spec file written on disk');

  const geo = () => p.evaluate(() => { const { S, view } = (window as any).OmoriEditor; const r = document.getElementById('map')!.getBoundingClientRect(); return { z: view.z, ox: view.ox + r.left, oy: view.oy + r.top, w: S.doc.w, h: S.doc.h }; });
  const at = async (x: number, y: number) => { const g = await geo(); return [g.ox + (x + .5) * 32 * g.z, g.oy + (y + .5) * 32 * g.z] as const; };
  const tilesIn = (layer: string) => p.evaluate((l) => (window as any).OmoriEditor.S.doc.tiled.layers.find((x: any) => x.name === l).data.filter(Boolean).length, layer);

  // stamp: pick a map, drag a rectangle on the reference, click to place
  await p.evaluate(() => (document.querySelectorAll('#tabs .tab')[1] as HTMLElement).click());
  await p.type('#panel input[type=search]', '13');
  await p.waitForSelector('#panel .list .item');
  await (await p.$('#panel .list .item'))!.click();
  await p.waitForSelector('#panel .pal-wrap canvas');
  await p.$eval('#panel .pal-wrap', e => { e.scrollIntoView({ block: 'start' }); e.scrollTop = 0; e.scrollLeft = 0; });
  const rc = (await (await p.$('#panel .pal-wrap canvas'))!.boundingBox())!;
  const ts = 32 * 0.5;
  await p.mouse.move(rc.x + 10 * ts + 2, rc.y + 10 * ts + 2); await p.mouse.down(); await p.mouse.move(rc.x + 19 * ts + 2, rc.y + 15 * ts + 2, { steps: 4 }); await p.mouse.up();
  check(await E(() => (window as any).OmoriEditor.S.stamp?.rect.join()) === '10,10,10,6', 'a 10x6 rectangle was picked on the reference map');
  check(await E(() => (window as any).OmoriEditor.S.tool) === 'stamp', 'picking switches to the stamp tool');
  const [sx, sy] = await at(2, 2);
  await p.mouse.move(sx, sy); await p.mouse.click(sx, sy);
  await p.waitForFunction(() => (window as any).OmoriEditor.S.doc.spec.stamps?.length === 1, { timeout: 8000 });
  await sleep(700);
  const painted = await E(() => (window as any).OmoriEditor.S.doc.tiled.layers.filter((l: any) => l.name !== 'COLLISION').reduce((n: number, l: any) => n + l.data.filter(Boolean).length, 0));
  check(painted > 20, `the stamp put tiles on the map (${painted})`);
  await p.screenshot({ path: 'test/out/editor-2-stamp.png' });

  // paint a tile with the brush, then undo and redo it
  await p.evaluate(() => (document.querySelectorAll('#tabs .tab')[0] as HTMLElement).click());
  await sleep(300);
  const pal = (await (await p.$('#panel .pal-wrap canvas'))!.boundingBox())!;
  await p.mouse.click(pal.x + 5 * 32 + 8, pal.y + 8 * 32 + 8);
  await p.keyboard.press('b');
  const before = await tilesIn('GROUND - II');
  const [bx, by] = await at(20, 14);
  await p.mouse.move(bx, by); await p.mouse.down(); await p.mouse.move(bx + 64 * (await geo()).z, by, { steps: 5 }); await p.mouse.up();
  const after = await tilesIn('GROUND - I'), after2 = await tilesIn('GROUND - II');
  check(after > 0 || after2 > before, 'brush drag painted tiles');
  const ovCount = () => E(() => Object.values((window as any).OmoriEditor.S.doc.ov).reduce((n: number, m: any) => n + m.size, 0));
  const n1 = await ovCount();
  check(n1 >= 3, `the stroke is recorded as ${n1} overrides`);
  await p.keyboard.down('Control'); await p.keyboard.press('z'); await p.keyboard.up('Control');
  check(await ovCount() === 0, 'ctrl+z undoes the whole stroke in one step');
  await p.keyboard.down('Control'); await p.keyboard.down('Shift'); await p.keyboard.press('z'); await p.keyboard.up('Shift'); await p.keyboard.up('Control');
  check(await ovCount() === n1, 'ctrl+shift+z redoes it');

  // walls
  await p.keyboard.press('c');
  const [wx, wy] = await at(5, 5);
  await p.mouse.click(wx, wy);
  check(await E(() => (window as any).OmoriEditor.S.doc.blocked[5][5]) === '#', 'walls tool blocks a tile');
  await p.mouse.click(wx, wy, { button: 'right' });
  check(await E(() => (window as any).OmoriEditor.S.doc.blocked[5][5]) === '.', 'right-click opens it');

  // event
  await p.keyboard.press('n');
  const [ex, ey] = await at(8, 8);
  await p.mouse.click(ex, ey);
  check(await E(() => (window as any).OmoriEditor.S.doc.spec.events.length) === 1, 'event tool adds an event');
  await p.waitForSelector('#panel .ev-head');
  await p.screenshot({ path: 'test/out/editor-3-event.png' });
  // add a say step
  await p.select('#panel .addcmd', 'say');
  await p.waitForSelector('#panel textarea');
  await p.type('#panel textarea', 'Hello from the editor.');
  check(await E(() => JSON.stringify((window as any).OmoriEditor.S.doc.spec.events[0].pages[0].do)) === '[{"say":["Hello from the editor."]}]', 'a Say step stores the text');

  // save + build
  await p.keyboard.down('Control'); await p.keyboard.press('s'); await p.keyboard.up('Control');
  await sleep(500);
  const spec = JSON.parse(readFileSync(join(srcRoot, 'ed-test', 'maps', '1000.spec.json'), 'utf8'));
  check(spec.stamps?.length === 1 && spec.events?.length === 1 && spec.paint?.every((x: any) => x.editor === true), 'saved spec has the stamp, event and tagged paint');
  check(await E(() => (window as any).OmoriEditor.S.dirty) === false, 'dirty flag cleared after save');
  await p.click('#buildBtn');
  await sleep(1500);
  check(existsSync(join(srcRoot, 'ed-test', 'files', 'maps', 'map1000.json')) && existsSync(join(srcRoot, 'ed-test', 'files', 'languages', 'en', 'ed-test_map1000.yml')), 'build wrote the map and dialogue files in the mod\'s source');
  check(existsSync(join(mods, 'ed-test', 'files', 'maps', 'map1000.json')) && existsSync(join(mods, 'ed-test', 'maps', '1000.spec.json')), 'and copied the mod into the game\'s dev folder so a playtest sees it');
  check(!existsSync(join(mods, 'ed-test', 'maps', '1700.spec.json')), 'the game copy holds no stray specs from other work');
  const built = JSON.parse(readFileSync(join(srcRoot, 'ed-test', 'files', 'maps', 'map1000.json'), 'utf8'));
  check(built.width === 30 && built.height === 20, 'built map has the chosen size');
  // reload: the document comes back the same
  await p.reload({ waitUntil: 'networkidle0' });
  await p.waitForFunction(() => (window as any).OmoriEditor.S.doc?.id === 1000, { timeout: 15000 });
  check(await ovCount() === n1, 'after a reload the painted tiles come back as editable overrides');
  await p.screenshot({ path: 'test/out/editor-4-reload.png' });

  // resizing keeps painted tiles where they were (they are stored by cell index, so this needs re-keying)
  const cellsAt = () => E(() => { const { S } = (window as any).OmoriEditor; const out: string[] = []; for (const [l, m] of Object.entries(S.doc.ov) as any) for (const [i] of m) out.push(`${l}@${i % S.doc.w},${Math.floor(i / S.doc.w)}`); return out.sort().join(' '); });
  const was = await cellsAt();
  await p.evaluate(() => (document.querySelectorAll('#tabs .tab')[3] as HTMLElement).click());
  await p.waitForSelector('#m-w');
  await p.evaluate(() => { const i = document.getElementById('m-w') as HTMLInputElement; i.value = '40'; i.dispatchEvent(new Event('change')); });
  await p.waitForFunction(() => (window as any).OmoriEditor.S.doc.w === 40, { timeout: 8000 });
  await sleep(400);
  check(await cellsAt() === was, `painted tiles keep their x,y after widening 30 -> 40 (${was})`);
  check(await E(() => (window as any).OmoriEditor.S.doc.tiled.width) === 40, 'the picture is 40 wide too');
  await p.keyboard.down('Control'); await p.keyboard.press('z'); await p.keyboard.up('Control');
  await p.waitForFunction(() => (window as any).OmoriEditor.S.doc.w === 30, { timeout: 8000 });
  await sleep(400);
  check(await cellsAt() === was && await E(() => (window as any).OmoriEditor.S.doc.tiled.width) === 30, 'undoing the resize restores size and tiles');

  // a stamp placed over a hand-edited wall brings its own walls back
  await p.keyboard.press('c');
  const [w2x, w2y] = await at(3, 3); await p.mouse.click(w2x, w2y);
  check(await E(() => (window as any).OmoriEditor.S.doc.blocked[3][3]) === '#', 'wall painted inside the future stamp area');
  await p.evaluate(() => (document.querySelectorAll('#tabs .tab')[1] as HTMLElement).click());   // a reload forgets the picked piece: pick again (recent maps are listed)
  await p.waitForSelector('#panel .list .item');
  await (await p.$('#panel .list .item'))!.click();
  await p.waitForSelector('#panel .pal-wrap canvas');
  await p.$eval('#panel .pal-wrap', e => { e.scrollIntoView({ block: 'start' }); e.scrollTop = 0; e.scrollLeft = 0; });
  const rc2 = (await (await p.$('#panel .pal-wrap canvas'))!.boundingBox())!;
  await p.mouse.move(rc2.x + 10 * ts + 2, rc2.y + 10 * ts + 2); await p.mouse.down(); await p.mouse.move(rc2.x + 19 * ts + 2, rc2.y + 15 * ts + 2, { steps: 4 }); await p.mouse.up();
  await p.mouse.click(...(await at(2, 2)));
  await p.waitForFunction(() => (window as any).OmoriEditor.S.doc.spec.stamps?.length === 2, { timeout: 8000 });
  check(await E(() => (window as any).OmoriEditor.S.doc.blocked[3][3]) === ' ', 'the stamp clears hand-edited walls under it');
  // a mod's finished map with no spec (what scripts like SUNBURN's produce) is listed and opens view-only
  await p.keyboard.down('Control'); await p.keyboard.press('s'); await p.keyboard.up('Control'); await sleep(400);   // unsaved changes would make the page ask before reloading
  const { copyFileSync } = await import('node:fs');
  copyFileSync(join(srcRoot, 'ed-test', 'files', 'maps', 'map1000.json'), join(srcRoot, 'ed-test', 'files', 'maps', 'map1700.json'));
  copyFileSync(join(srcRoot, 'ed-test', 'files', 'data', 'Map1000.json'), join(srcRoot, 'ed-test', 'files', 'data', 'Map1700.json'));
  await p.reload({ waitUntil: 'networkidle0' });
  await p.waitForFunction(() => (window as any).OmoriEditor.S.mods.some((m: any) => m.name === 'ed-test'));
  check(await E(() => (window as any).OmoriEditor.S.mods.find((m: any) => m.name === 'ed-test').built.map((b: any) => b.id).join()) === '1700', 'a built map with no spec is listed as view-only');
  await p.select('#mapSel', 'b1700');
  await p.waitForFunction(() => (window as any).OmoriEditor.S.doc?.readonly === true, { timeout: 8000 });
  check(await E(() => (document.getElementById('saveBtn') as HTMLButtonElement).disabled && (document.getElementById('buildBtn') as HTMLButtonElement).disabled), 'save and build are disabled for a view-only map');
  await p.keyboard.press('b');
  const [vx, vy] = await at(10, 10); await p.mouse.click(vx, vy);
  check(await ovCount() === 0 && await E(() => (window as any).OmoriEditor.S.dirty) === false, 'painting a view-only map does nothing');
  await p.screenshot({ path: 'test/out/editor-5-viewonly.png' });

  // take the finished map over: editable, builds on top of the original, and can be handed back untouched
  const original = readFileSync(join(srcRoot, 'ed-test', 'files', 'maps', 'map1700.json'), 'utf8');
  await p.click('#panel .btn.primary');
  await p.waitForSelector('dialog[open]');
  await (await p.$$('dialog .df .btn'))[1]!.click();
  await p.waitForFunction(() => (window as any).OmoriEditor.S.doc?.spec.snapshot === true && !(window as any).OmoriEditor.S.doc.readonly, { timeout: 15000 });
  check(existsSync(join(srcRoot, 'ed-test', 'maps', '.base', '1700.tiled.json')) && existsSync(join(srcRoot, 'ed-test', 'maps', '.base', '1700.data.json')), 'taking over keeps a snapshot of the original files (names that cannot collide on macOS)');
  check(await E(() => (window as any).OmoriEditor.S.doc.gameEvents.length) === 1, 'the map\'s own events are listed (1: the one made earlier in this test)');
  await p.keyboard.press('c');
  const [tx, ty] = await at(6, 6); await p.mouse.click(tx, ty);
  check(await E(() => (window as any).OmoriEditor.S.doc.blocked[6][6]) === '#', 'a taken-over map can be edited (wall painted)');
  // drag the map's own event to a new tile
  await p.keyboard.press('n');
  const ev0 = await E(() => { const e = (window as any).OmoriEditor.S.doc.gameEvents[0]; return [e.x, e.y]; });
  const [fx, fy] = await at(ev0[0], ev0[1]), [gx, gy] = await at(ev0[0] + 3, ev0[1] + 2);
  await p.mouse.move(fx, fy); await p.mouse.down(); await p.mouse.move(gx, gy, { steps: 6 }); await p.mouse.up();
  check(await E(() => JSON.stringify((window as any).OmoriEditor.S.doc.spec.moveEvents)) === JSON.stringify({ 1: [ev0[0] + 3, ev0[1] + 2] }), 'the map\'s own event can be dragged (moveEvents recorded)');
  await p.keyboard.down('Control'); await p.keyboard.press('b'); await p.keyboard.up('Control');
  await sleep(1500);
  const merged = JSON.parse(readFileSync(join(srcRoot, 'ed-test', 'files', 'maps', 'map1700.json'), 'utf8'));
  const mcol = merged.layers.find((l: any) => /collision/i.test(l.name));
  check(mcol.data[6 * merged.width + 6] !== 0, 'build wrote the wall into the real map file');
  const mdata = JSON.parse(readFileSync(join(srcRoot, 'ed-test', 'files', 'data', 'Map1700.json'), 'utf8'));
  check(mdata.events.find((e: any) => e?.id === 1).x === ev0[0] + 3, 'build wrote the moved event position');
  // another tool edits the spec file while the page is open: the page picks it up
  const specFile = join(srcRoot, 'ed-test', 'maps', '1700.spec.json');
  const spec2 = JSON.parse(readFileSync(specFile, 'utf8')); spec2.name = 'RENAMED BY ANOTHER TOOL';
  writeFileSync(specFile, JSON.stringify(spec2, null, 2));
  await p.waitForFunction(() => (window as any).OmoriEditor.S.doc?.spec.name === 'RENAMED BY ANOTHER TOOL', { timeout: 8000 });
  check(true, 'a change made to the spec file by another tool shows up in the open editor without a reload');
  // give it back
  await p.evaluate(() => (document.querySelectorAll('#tabs .tab')[3] as HTMLElement).click());
  await p.waitForSelector('#panel .btn.danger');
  await p.click('#panel .btn.danger'); await p.waitForSelector('dialog[open]');
  await (await p.$$('dialog .df .btn'))[1]!.click();
  await p.waitForFunction(() => !(window as any).OmoriEditor.S.doc, { timeout: 8000 });
  check(!existsSync(specFile) && readFileSync(join(srcRoot, 'ed-test', 'files', 'maps', 'map1700.json'), 'utf8') === original, 'giving it back removes the spec and restores the original map file exactly');
  // ready-made pieces and starting points
  const lib = await (await fetch('http://127.0.0.1:8125/__editor/library?mod=ed-test')).json() as any;
  check(lib.pieces.length >= 10 && lib.templates.some((t: any) => t.id === 'street'), `the library has ${lib.pieces.length} pieces and ${lib.templates.length} starting points`);
  const made = await fetch('http://127.0.0.1:8125/__editor/mod/ed-test/new', { method: 'POST', headers: { 'content-type': 'application/json', 'x-omori-editor': '1' }, body: JSON.stringify({ id: 1800, name: 'STREET', template: 'street' }) });
  check(made.ok, 'a map can be started from the "street" template');
  const tspec = JSON.parse(readFileSync(join(srcRoot, 'ed-test', 'maps', '1800.spec.json'), 'utf8'));
  check(tspec.size.join() === '70,20' && tspec.stamps.length === 1 && tspec.stamps[0].from === 13 && tspec.tilesFrom === 13, 'the template wrote size, art and its stamp into the spec');
  const bad = await fetch('http://127.0.0.1:8125/__editor/mod/ed-test/new', { method: 'POST', headers: { 'content-type': 'application/json', 'x-omori-editor': '1' }, body: JSON.stringify({ id: 1801, template: 'nope' }) });
  check(bad.status === 400, 'an unknown starting point is refused');
  // a picture of a map for people and agents who cannot see the page
  const png = join(mods, 'shot.png');
  const cli = Bun.spawn([process.execPath, 'run', 'src/cli.ts', 'map', 'shot', 'ed-test', '1800', '--zoom', '0.25', '--out', png], { stdout: 'pipe', stderr: 'pipe', env: { ...process.env, OMORI_MODS: mods, OMORI_EDITOR_MODS: srcRoot } });
  await cli.exited;
  const head = existsSync(png) ? readFileSync(png).subarray(0, 8) : Buffer.alloc(0);
  check(head.length === 8 && head.toString('hex') === '89504e470d0a1a0a' && readFileSync(png).length > 2000, '`map shot` writes a real PNG of the map');
  check(errs.length === 0, `no page errors${errs.length ? ': ' + errs.join(' | ') : ''}`);
} finally { await b.close(); server.kill(); }
if (failures.length) { console.log(`\n${failures.length} failed`); process.exit(1); }
console.log('\nall editor checks passed');
