// Screenshots of the editor's dialogs and event form, for a visual check (not part of `bun run test`).
import puppeteer from 'puppeteer-core';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CHROME } from './chrome.ts';
mkdirSync('test/out', { recursive: true });
const mods = mkdtempSync(join(tmpdir(), 'editor-shots-'));
mkdirSync(join(mods, 'demo'));
writeFileSync(join(mods, 'demo', 'mod.json'), JSON.stringify({ id: 'demo', name: 'Demo', version: '0.0.1' }));
const server = Bun.spawn(['bun', 'run', 'src/server.ts', '8126'], { stdout: 'ignore', stderr: 'inherit', env: { ...process.env, OMORI_MODS: mods } });
await new Promise(r => setTimeout(r, 1200));
const b = await puppeteer.launch({ executablePath: CHROME, headless: true, defaultViewport: { width: 1440, height: 900 } });
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
try {
  const p = await b.newPage();
  const errs: string[] = [];
  p.on('pageerror', e => errs.push((e as Error).message));
  await p.goto('http://127.0.0.1:8126/editor/', { waitUntil: 'networkidle0' });
  await p.select('#modSel', 'demo'); await sleep(300);
  await p.screenshot({ path: 'test/out/shot-empty.png' });
  await p.click('#emptyNew'); await p.waitForSelector('dialog[open]'); await sleep(300);
  await p.screenshot({ path: 'test/out/shot-newmap.png' });
  const btns = await p.$$('dialog .df .btn'); await btns[1]!.click();
  await p.waitForFunction(() => (window as any).OmoriEditor.S.doc?.id === 1000);
  await p.click('#helpBtn'); await p.waitForSelector('dialog[open]'); await sleep(200);
  await p.screenshot({ path: 'test/out/shot-help.png' });
  await p.keyboard.press('Escape'); await sleep(200);
  // an event with an if/then and a say, then the sprite picker
  await p.keyboard.press('n');
  const geo = await p.evaluate(() => { const { view } = (window as any).OmoriEditor; const r = document.getElementById('map')!.getBoundingClientRect(); return { z: view.z, ox: view.ox + r.left, oy: view.oy + r.top }; });
  await p.mouse.click(geo.ox + 5.5 * 32 * geo.z, geo.oy + 5.5 * 32 * geo.z);
  await p.waitForSelector('#panel .ev-head');
  await p.select('#panel .addcmd', 'say'); await p.type('#panel textarea', 'You came back. I was starting to worry.');
  await p.select('#panel .addcmd', 'if'); await sleep(200);
  await p.select('#panel .cmd .nest .addcmd', 'switch'); await sleep(100);
  await p.evaluate(() => document.getElementById('panel')!.scrollTo(0, 500)); await sleep(200);
  await p.screenshot({ path: 'test/out/shot-commands.png' });
  await p.evaluate(() => (document.querySelector('.sprite-btn') as HTMLElement).click());
  await p.waitForSelector('dialog[open] .sprite-cell'); await sleep(2500);
  await p.screenshot({ path: 'test/out/shot-sprites.png' });
  console.log(errs.length ? errs.join('\n') : 'no errors');
} finally { await b.close(); server.kill(); }
