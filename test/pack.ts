// End-to-end test with a REAL OneLoader modpack (OMO CEP), packaged as a .7z like the download. Installs it through the
// Mods panel, runs the game with all of it enabled, and checks that data, plugins, images and maps all took effect.
// Skipped unless the pack is on this machine: OMO_PACK_DIR=<folder containing www/mods>, and 7-Zip must be installed.
import puppeteer from 'puppeteer-core';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WWW } from '../src/gamedir.ts';
import { planInstall, type Entries } from '../src/mods/pack.ts';
import { treeFromEntries } from '../src/mods/vfs.ts';
import { loadMod } from '../src/mods/manifest.ts';

// Optional: point OMO_PACK_DIR at an extracted third-party mod pack (one with www/mods) to run this against real-world mods.
const PACK = process.env.OMO_PACK_DIR ?? '';
const SEVENZ = 'C:/Program Files/7-Zip/7z.exe';
if (!PACK || !existsSync(join(PACK, 'www', 'mods')) || !existsSync(SEVENZ)) { console.log('skipped: set OMO_PACK_DIR to an extracted third-party mod pack, and install 7-Zip'); process.exit(0); }
void WWW;

const PORT = 8095;
const CHROME = process.env.CHROME ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
mkdirSync('test/out', { recursive: true });
const failures: string[] = [];
const check = (ok: boolean, msg: string) => { console.log(ok ? 'ok  ' : 'FAIL', msg); if (!ok) failures.push(msg); };
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// ---- what the pack should do, worked out independently from the files
function readTree(dir: string, rel = '', out: Entries = {}): Entries {
    for (const e of readdirSync(join(dir, rel), { withFileTypes: true })) { const r = rel ? `${rel}/${e.name}` : e.name; e.isDirectory() ? readTree(dir, r, out) : (out[r] = new Uint8Array(readFileSync(join(dir, r)))); }
    return out;
}
const plan = await planInstall('pack', readTree(PACK), async () => { throw new Error('unused'); });
const defs = plan.items.map(i => loadMod(treeFromEntries(i.entries), i.label));
const rpgTargets = defs.flatMap(d => d.edits.filter(e => e.kind === 'replace' && /\.rpgmv[po]$/i.test(e.target)).map(e => e.target));
const imageDeltaTargets = defs.flatMap(d => d.imageDeltas.map(x => x.target.replace(/\.png$/i, '.rpgmvp')));
const newPlugins = new Set(defs.flatMap(d => d.pluginFiles));
console.log(`expect: ${plan.items.length} mods, ${rpgTargets.length} replaced assets, ${imageDeltaTargets.length} image deltas, ${newPlugins.size} plugin files`);

const work = mkdtempSync(join(tmpdir(), 'omori-pack-'));
const archive = join(work, 'OMO-CEP.7z');
const made = Bun.spawnSync([SEVENZ, 'a', '-bd', '-mx=1', archive, PACK]);
if (made.exitCode !== 0) { console.error('7z failed', made.stderr.toString()); process.exit(1); }
console.log(`packed ${(readFileSync(archive).length / 1048576).toFixed(1)} MB .7z`);

const server = Bun.spawn(['bun', 'run', 'src/server.ts', String(PORT)], { stdout: 'ignore', stderr: 'inherit', env: { ...process.env, OMORI_MODS: mkdtempSync(join(tmpdir(), 'omori-dev-')) } });
const browser = await puppeteer.launch({
    executablePath: CHROME, headless: true, defaultViewport: { width: 1280, height: 720 },
    args: ['--autoplay-policy=no-user-gesture-required', '--ignore-gpu-blocklist', '--enable-gpu', '--use-angle=d3d11'],
});
try {
    await sleep(500);
    const page = await browser.newPage();
    const pageErrors: string[] = [];
    page.on('pageerror', e => pageErrors.push((e as Error).message));
    page.on('dialog', d => d.accept(d.type() === 'prompt' ? 'OMO CEP' : undefined));
    const title = (t = 120000) => page.waitForFunction(() => (globalThis as any).SceneManager?._scene?.constructor?.name === 'Scene_OmoriTitleScreen', { timeout: t });

    await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load' });
    await title();
    const vanilla = await page.evaluate(() => ({ plugins: $plugins.length, hash: JSON.stringify([$dataItems, $dataSkills, $dataActors, $dataEnemies, $dataCommonEvents, $dataStates]).length }));

    // ---- install the .7z through the panel
    await page.keyboard.press('F8');
    const input = await page.waitForSelector('#omm-panel.open input[type=file][multiple]:not([webkitdirectory])');
    const t0 = Date.now();
    await input!.uploadFile(archive);
    await page.waitForFunction(() => [...document.querySelectorAll('#omm-toast button')].some(b => b.textContent === 'Try in a new profile'), { timeout: 240000 });
    const toast = await page.evaluate(() => document.getElementById('omm-toast')!.innerText.replace(/\n/g, ' '));
    console.log(`installed in ${((Date.now() - t0) / 1000).toFixed(1)} s: ${toast}`);
    check(new RegExp(`Installed ${plan.items.length} mods`).test(toast), 'a .7z modpack installs every mod inside it as its own mod');
    const panel = await page.evaluate(() => document.getElementById('omm-panel')!.innerText);
    check(/Skipped oneloader/i.test(panel), "OneLoader's own helper mod is skipped, with the reason shown");
    check(!/missing mod\.json|no mod found/i.test(panel), 'no "missing mod.json" complaint');

    // ---- run as a new profile with all of it enabled
    await Promise.all([page.waitForNavigation({ waitUntil: 'load', timeout: 30000 }), page.evaluate(() => ([...document.querySelectorAll('#omm-toast button')].find(b => b.textContent === 'Try in a new profile') as HTMLElement).click())]);
    const b0 = Date.now();
    await title(420000);
    console.log(`booted modded game in ${((Date.now() - b0) / 1000).toFixed(1)} s`);
    const modded = await page.evaluate(() => ({
        plugins: $plugins.length, modded: $plugins.filter((p: any) => p.description === 'Modded plugin').map((p: any) => p.name),
        hash: JSON.stringify([$dataItems, $dataSkills, $dataActors, $dataEnemies, $dataCommonEvents, $dataStates]).length,
        errors: document.getElementById('omm-tab')!.textContent, mods: (globalThis as any).OmoriMod.mods.filter((m: any) => m.enabled).length,
    }));
    check(modded.mods === plan.items.length, `all ${plan.items.length} mods are enabled in the new profile (${modded.mods})`);
    check(modded.hash !== vanilla.hash, `game data differs from vanilla (${vanilla.hash} → ${modded.hash} bytes of items/skills/actors/enemies/events/states)`);
    check(modded.plugins >= vanilla.plugins + (newPlugins.size ? 1 : 0), `the game's plugin list gained the mods' own plugins (${vanilla.plugins} → ${modded.plugins}: ${modded.modded.join(', ')})`);
    console.log('tab:', modded.errors);

    // ---- assets served by the service worker, and image patches
    const assetProbe = async (target: string) => page.evaluate(async t => {
        const enc = (u: string) => '/' + u.split('/').map(encodeURIComponent).join('/');
        const a = await fetch(enc(t), { cache: 'no-store' });
        const v = await fetch(enc(t) + '?__vanilla=1', { cache: 'no-store' });
        return { mod: a.headers.get('x-omori-mod'), ok: a.ok, len: (await a.arrayBuffer()).byteLength, vlen: v.ok ? (await v.arrayBuffer()).byteLength : -1 };
    }, target);
    const asset = rpgTargets.find(t => /\.rpgmvp$/i.test(t));
    if (asset) { const r = await assetProbe(asset); check(r.ok && r.mod === '1', `a replaced image is served from the mod (${asset}: ${r.len} bytes, game's own ${r.vlen})`); }
    const olid = imageDeltaTargets[0];
    if (olid) { const r = await assetProbe(olid); check(r.ok && r.mod === '1' && r.len !== r.vlen, `an image patched by an image delta is served patched (${olid}: ${r.len} vs ${r.vlen})`); }
    const sampleCount = Math.min(25, imageDeltaTargets.length);
    let patched = 0;
    for (const t of imageDeltaTargets.slice(0, sampleCount)) { const r = await assetProbe(t); if (r.mod === '1') patched++; }
    check(patched === sampleCount, `${patched}/${sampleCount} sampled image-delta images are patched`);

    // ---- a patched map loads and plays
    await page.evaluate(() => { DataManager.setupNewGame(); $gamePlayer.reserveTransfer(13, 35, 45, 2, 0); SceneManager.goto(Scene_Map); });
    await page.waitForFunction(() => SceneManager._scene instanceof Scene_Map && $gameMap.mapId() === 13 && !$gamePlayer.isTransferring(), { timeout: 120000 });
    await sleep(1500);
    await page.screenshot({ path: 'test/out/pack-map.png' });
    check(true, 'a map loads and renders with every mod active');

    const log = existsSync('latest.log') ? readFileSync('latest.log', 'utf8') : '';
    const errs = log.split('\n').filter(l => /\[error\]/.test(l));
    console.log(`latest.log: ${errs.length} error line(s)`);
    for (const l of errs.slice(0, 12)) console.log('  ', l.slice(0, 220));
    const fatal = pageErrors.filter(m => !/omori-mod/.test(m));
    check(fatal.length === 0, `no page errors outside mods ${JSON.stringify(fatal.slice(0, 3))}`);
} finally {
    await browser.close();
    server.kill();
}
if (failures.length) { console.error(`\n${failures.length} failure(s)`); process.exit(1); }
console.log('\nall pack tests passed');
