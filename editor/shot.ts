// `bun run mod map shot <mod> <id>`  or  `bun run mod map shot --game <id>`: render one map to a PNG so you (or an agent) can look at it.
// It starts its own copy of the editor server, opens the page in screenshot mode in headless Chrome, and saves the picture.
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { ROOT } from '../src/gamedir.ts';

const CHROME_DEFAULTS: Record<string, string> = {
    darwin: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    linux: '/usr/bin/google-chrome',
    win32: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
};
const USAGE = `usage:
  bun run mod map shot <mod> <id> [--out file.png] [--zoom 0.5] [--grid] [--no-walls] [--no-events] [--no-ruler] [--edits]
  bun run mod map shot --game <id> [same options]       a map of the game itself (to pick stamp rectangles from)
Numbers along the top and left edges are tile coordinates, so a rectangle for a stamp can be read straight off the picture.`;

export async function shotCommand(args: string[]): Promise<void> {
    const flag = (n: string) => args.includes(`--${n}`);
    const val = (n: string) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };
    const valued = new Set(['--out', '--zoom', '--game']);
    const pos = args.filter((a, i) => !a.startsWith('--') && !valued.has(args[i - 1] ?? ''));
    const game = val('game');
    if (!game && pos.length < 2) { console.error(USAGE); process.exit(1); }
    const zoom = Number(val('zoom') ?? 1);
    if (!(zoom > 0 && zoom <= 4)) { console.error('--zoom must be between 0 and 4'); process.exit(1); }
    const chrome = process.env.CHROME ?? CHROME_DEFAULTS[process.platform];
    if (!chrome || !existsSync(chrome)) { console.error('Chrome not found. Install Google Chrome, or set CHROME to its path.'); process.exit(1); }

    const port = 20000 + Math.floor(Math.random() * 20000);
    const server = Bun.spawn([process.execPath, 'run', 'src/server.ts', String(port)], { cwd: ROOT, stdout: 'ignore', stderr: 'inherit' });
    try {
        const base = `http://127.0.0.1:${port}`;
        for (let i = 0; ; i++) { try { if ((await fetch(`${base}/__editor/mods`)).ok) break; } catch { /* still starting */ } if (i > 100) throw new Error('the editor server did not start'); await Bun.sleep(100); }
        const puppeteer = (await import('puppeteer-core')).default;
        const browser = await puppeteer.launch({ executablePath: chrome, headless: true, defaultViewport: { width: 1200, height: 900 } });
        try {
            const page = await browser.newPage();
            const q = new URLSearchParams({ clean: '1', zoom: String(zoom), ...(game ? { game } : { mod: pos[0]!, map: pos[1]! }), ...(flag('grid') ? { grid: '1' } : {}), ...(flag('no-walls') ? { walls: '0' } : {}), ...(flag('no-events') ? { events: '0' } : {}), ...(flag('no-ruler') ? { ruler: '0' } : {}), ...(flag('edits') ? { edits: '1' } : {}) });
            await page.goto(`${base}/editor/?${q}`, { waitUntil: 'load' });
            await page.waitForFunction(() => document.body.dataset.ready === '1' || document.body.dataset.error, { timeout: 60000 });
            const err = await page.evaluate(() => document.body.dataset.error);
            if (err) throw new Error(err);
            const out = resolve(val('out') ?? (game ? `game-map-${game}.png` : `${pos[0]}-map-${pos[1]}.png`));
            mkdirSync(dirname(out), { recursive: true });
            const el = await page.$('#map');
            await el!.screenshot({ path: out as `${string}.png` });
            const dims = await page.evaluate(() => { const c = document.getElementById('map') as HTMLCanvasElement; return [c.clientWidth, c.clientHeight]; });
            console.log(`${out}  (${dims[0]}×${dims[1]} px)`);
        } finally { await browser.close(); }
    } finally { server.kill(); }
}
