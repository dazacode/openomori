// Generates the UI screenshots in docs/assets (settings, mod manager, checkpoints) from a real run of the port.
// The game's canvas is hidden first, so the pictures contain only this project's own interface, never game artwork.
//   bun run scripts/make-screenshots.ts       (needs Chrome and your OMORI install)
import puppeteer from 'puppeteer-core';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, ensureGameDir } from '../src/gamedir.ts';
import { ANGLE, CHROME } from '../test/chrome.ts';

if (!ensureGameDir()) process.exit(1);
const out = join(ROOT, 'docs', 'assets');
mkdirSync(out, { recursive: true });
const PORT = 8101;
const server = Bun.spawn(['bun', 'run', 'src/server.ts', String(PORT)], { cwd: ROOT, stdout: 'ignore', stderr: 'inherit', env: { ...process.env, OMORI_MODS: join(ROOT, 'examples') } });
await new Promise(r => setTimeout(r, 800));
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
try {
    const b = await puppeteer.launch({ executablePath: CHROME, headless: true, defaultViewport: { width: 1280, height: 800, deviceScaleFactor: 2 },
        args: ['--ignore-gpu-blocklist', '--enable-gpu', ANGLE] });
    const p = await b.newPage();
    const title = () => p.waitForFunction(() => (globalThis as any).SceneManager?._scene?.constructor?.name === 'Scene_OmoriTitleScreen', { timeout: 120000 });
    await p.goto(`http://127.0.0.1:${PORT}/?profile=shots`);
    await title();
    await p.evaluate(() => new Promise<void>((res, rej) => {   // load every example mod from the dev folder in this throwaway profile
        const r = indexedDB.open('omori-mods');
        r.onsuccess = () => { const t = r.result.transaction('profiles', 'readwrite'); t.objectStore('profiles').put({ id: 'shots', name: 'Screenshots', created: 1, enabled: [], devAuto: true, fsDb: 'omori-fs:shots' }); t.oncomplete = () => res(); t.onerror = () => rej(t.error); };
    }));
    await p.reload(); await title();

    const dbgOpen = () => p.evaluate(() => document.getElementById('dbg')!.classList.contains('open'));
    const setDbg = async (want: boolean) => { if ((await dbgOpen()) !== want) { await p.evaluate(() => (document.activeElement as HTMLElement | null)?.blur()); await p.keyboard.press('F9'); await sleep(300); } };

    // a game with some story progress recorded as checkpoints
    await setDbg(true);
    await p.type('#dbg input[type=text]', 'player street');
    await p.click('#dbg .row.hit');
    await p.waitForFunction(() => SceneManager._scene instanceof Scene_Map && $gameMap.mapId() === 13 && !$gamePlayer.isTransferring(), { timeout: 60000 });
    await sleep(1500);
    await setDbg(false);
    const api = `(globalThis).OmoriMod.checkpoints`;
    await p.evaluate(`${api}.recordBeats(true)`);
    for (const [kind, id, v] of [['s', 996, 1], ['s', 1011, 1], ['s', 1023, 1], ['s', 1034, 1], ['s', 1057, 1], ['v', 1076, 3], ['v', 1076, 9]] as const) {
        await p.evaluate(([k, i, val]) => { k === 's' ? $gameSwitches.setValue(i, !!val) : $gameVariables.setValue(i, val); }, [kind, id, v] as [string, number, number]);
        await sleep(1800);
    }
    await p.evaluate(`${api}.recordBeats(false)`);
    await p.evaluate(`${api}.capture('before the final chapter')`);
    await sleep(500);

    const hideGame = () => p.evaluate(() => { document.querySelectorAll('canvas').forEach(c => ((c as HTMLElement).style.visibility = 'hidden')); document.body.style.background = '#0b0b0f'; });
    const shot = async (sel: string, file: string) => { const el = await p.waitForSelector(sel, { visible: true, timeout: 20000 }).catch(e => { throw new Error(`${sel} never became visible (${(e as Error).message})`); }); await el!.screenshot({ path: join(out, file) }); console.log('wrote docs/assets/' + file); };

    // checkpoints
    await setDbg(true);
    await p.evaluate(() => { for (const x of document.querySelectorAll<HTMLButtonElement>('#dbg nav button')) if (x.textContent === 'checkpoints') x.click(); });
    await p.waitForFunction(() => /Story beats captured: \d+ of \d+/.test(document.querySelector('#dbg .body')?.textContent ?? ''), { timeout: 30000 });
    await p.evaluate(() => { for (const x of document.querySelectorAll<HTMLButtonElement>('#dbg button')) if (/^Order:/.test(x.textContent ?? '')) x.click(); });
    await sleep(500);
    await hideGame();
    await shot('#dbg', 'checkpoints.png');
    await setDbg(false);

    // settings, Mods tab (the New Game+ button)
    await p.keyboard.press('F10'); await sleep(600);
    await p.evaluate(() => document.querySelector<HTMLElement>('[data-tab="mods"]')?.click());
    await sleep(500);
    await shot('.dlg', 'settings.png');
    await p.keyboard.press('Escape'); await sleep(400);

    // mod manager
    await p.keyboard.press('F8'); await sleep(800);
    await shot('#omm-panel', 'mod-manager.png');
    await b.close();
} finally { server.kill(); }
