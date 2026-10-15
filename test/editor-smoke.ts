import puppeteer from 'puppeteer-core';
import { CHROME } from './chrome.ts';
const server = Bun.spawn(['bun', 'run', 'src/server.ts', '8124'], { stdout: 'ignore', stderr: 'inherit' });
await new Promise(r => setTimeout(r, 1200));
const b = await puppeteer.launch({ executablePath: CHROME, headless: true, defaultViewport: { width: 1440, height: 900 } });
try {
  const p = await b.newPage();
  const errs: string[] = [];
  p.on('pageerror', e => errs.push('PAGEERROR ' + (e as Error).message));
  p.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE ' + m.text()); });
  await p.goto('http://127.0.0.1:8124/editor/', { waitUntil: 'networkidle0' });
  await new Promise(r => setTimeout(r, 800));
  await p.screenshot({ path: 'test/out/editor-1.png' });
  console.log(errs.length ? errs.join('\n') : 'no errors');
  console.log(await p.evaluate(() => document.getElementById('modSel')!.innerText));
} finally { await b.close(); server.kill(); }
