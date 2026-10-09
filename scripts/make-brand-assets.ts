// OpenOMORI: generates docs/assets/{banner,social-preview}.png from the game's own app icon plus plain typography.
// The icon is read from YOUR install (www/icon/icon.png) and copied to docs/assets/omori-icon.png; it is the game's artwork
// (c) OMOCAT, used here only to identify the game this project works with. See the README's legal note.
//   bun run scripts/make-brand-assets.ts
import puppeteer from 'puppeteer-core';
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, WWW, ensureGameDir } from '../src/gamedir.ts';

if (!ensureGameDir()) process.exit(1);
const assets = join(ROOT, 'docs', 'assets');
mkdirSync(assets, { recursive: true });
const iconPath = join(assets, 'omori-icon.png');
if (existsSync(join(WWW, 'icon', 'icon.png'))) copyFileSync(join(WWW, 'icon', 'icon.png'), iconPath);
if (!existsSync(iconPath)) { console.error('no icon found'); process.exit(1); }
const icon = readFileSync(iconPath).toString('base64');

const css = `
*{box-sizing:border-box;margin:0}
body{background:#0b0b0f;color:#f2f2f5;font-family:Consolas,"Cascadia Mono","Courier New",monospace;overflow:hidden}
.wrap{position:relative;width:100%;height:100%;display:flex;align-items:center;gap:56px;padding:0 72px;
  background:radial-gradient(900px 500px at 12% 40%,#23232e 0%,#0b0b0f 70%)}
.icon{image-rendering:pixelated;flex:none;filter:drop-shadow(0 0 40px #ffffff22)}
h1{font-size:var(--h1);letter-spacing:.02em;line-height:1}
h1 span{color:#8a8a9a}
p.tag{font-size:var(--tag);line-height:1.35;margin-top:18px;color:#d6d6de}
.chips{display:flex;flex-wrap:wrap;gap:10px;margin-top:26px}
.chips b{font-weight:400;font-size:var(--chip);padding:6px 14px;border:1px solid #3a3a48;border-radius:999px;color:#b8b8c6;background:#14141b}
.foot{position:absolute;left:72px;bottom:26px;font-size:15px;color:#6f6f80}
`;
const page = (w: number, h: number, v: { icon: number; h1: number; tag: number; chip: number }, foot: boolean) => `<!doctype html><meta charset="utf-8"><style>${css}
:root{--h1:${v.h1}px;--tag:${v.tag}px;--chip:${v.chip}px}</style>
<div class="wrap" style="width:${w}px;height:${h}px">
  <img class="icon" width="${v.icon}" height="${v.icon}" src="data:image/png;base64,${icon}">
  <div>
    <h1><span>Open</span>OMORI</h1>
    <p class="tag">A modern runtime and modding toolkit for OMORI.<br>Runs in the browser. No RPG Maker needed.</p>
    <div class="chips"><b>browser port</b><b>mod loader</b><b>map &amp; event compiler</b><b>checkpoints &amp; routes</b></div>
  </div>
  ${foot ? '<div class="foot">Fan project. Bring your own copy of OMORI &mdash; no game files included.</div>' : ''}
</div>`;

const browser = await puppeteer.launch({ executablePath: process.env.CHROME ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
for (const [name, w, h, v, foot] of [
    ['social-preview', 1280, 640, { icon: 384, h1: 104, tag: 27, chip: 18 }, true],
    ['banner', 1280, 360, { icon: 224, h1: 84, tag: 22, chip: 16 }, false],
] as const) {
    const p = await browser.newPage();
    await p.setViewport({ width: w, height: h });
    await p.setContent(page(w, h, v, foot));
    await p.screenshot({ path: join(assets, `${name}.png`) });
    console.log('wrote', `docs/assets/${name}.png`);
}
await browser.close();
