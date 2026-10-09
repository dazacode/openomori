// End-to-end test of browser mod loading in real Chrome: install zips through the Mods panel's file input,
// reload, and verify data patches, asset replacement (service worker), error reporting, safe mode, OneLoader zips.
import puppeteer, { type Page } from 'puppeteer-core';
import { zipSync, strToU8 } from 'fflate';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = 8098;
const CHROME = process.env.CHROME ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
mkdirSync('test/out', { recursive: true });
const work = mkdtempSync(join(tmpdir(), 'omori-mods-'));
const emptyMods = mkdtempSync(join(tmpdir(), 'omori-devmods-'));

const server = Bun.spawn(['bun', 'run', 'src/server.ts', String(PORT)], { stdout: 'ignore', stderr: 'inherit', env: { ...process.env, OMORI_MODS: emptyMods } });
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const failures: string[] = [];
const check = (ok: boolean, msg: string) => { console.log(ok ? 'ok  ' : 'FAIL', msg); if (!ok) failures.push(msg); };

// ---- fixtures
const ICON = new Uint8Array(readFileSync('../OMORI.Build.8879120/www/icon/icon.png'));
const PNG = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='), c => c.charCodeAt(0));
const zip = (name: string, files: Record<string, Uint8Array | string>) => {
    const p = join(work, name + '.zip');
    writeFileSync(p, zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, typeof v === 'string' ? strToU8(v) : v]))));
    return p;
};
const helloDir = 'examples/hello-mod';
const rd = (p: string) => readFileSync(join(helloDir, p), 'utf8');
const hello = zip('hello-mod', {
    'hello-mod/mod.json': rd('mod.json'),
    'hello-mod/patches/data/Items.json.patch.json': rd('patches/data/Items.json.patch.json'),
    'hello-mod/patches/languages/en/01_cutscenes_neighbors.yml.merge.json': rd('patches/languages/en/01_cutscenes_neighbors.yml.merge.json'),
    'hello-mod/scripts/main.js': rd('scripts/main.js'),
});
const assets = zip('asset-mod', {
    'mod.json': JSON.stringify({ id: 'asset-mod', name: 'Asset Mod', version: '1' }),
    'files/icon/icon.png': PNG,
});
const broken = zip('broken-mod', {
    'mod.json': JSON.stringify({ id: 'broken-mod', name: 'Broken Mod', version: '1' }),
    'scripts/main.js': `OmoriMod.scope().log('about to fail'); null.boom;`,
    'patches/data/Items.json.patch.json': JSON.stringify([{ op: 'replace', path: '/99999/name', value: 'x' }]),
});
const oneloader = zip('ol-mod', {
    'mod.json': JSON.stringify({ manifestVersion: 1, id: 'ol-mod', name: 'OneLoader Mod', description: 'v1 manifest', version: '1', files: { data: ['data/Armors.json'] } }), // entries are paths from the mod root, as OneLoader reads them
    'data/Armors.json': JSON.stringify(Array.from({ length: 3 }, (_, i) => (i ? { id: i, name: 'ONELOADER ARMOR', description: '', note: '', params: [], traits: [], etypeId: 1, iconIndex: 0, price: 0, atypeId: 0 } : null))),
});
const invalid = zip('invalid-mod', { 'mod.json': '{ not json' });

// ---- other archive formats, built with real tools (7-Zip, tar). The mods sit inside a wrapper folder, as downloads often do.
const SEVENZ = 'C:/Program Files/7-Zip/7z.exe';
const makeDir = (root: string, files: Record<string, string>) => {
    for (const [k, v] of Object.entries(files)) { mkdirSync(join(root, k, '..'), { recursive: true }); writeFileSync(join(root, k), v); }
};
const srcA = join(work, 'src-a'), srcB = join(work, 'src-b');
makeDir(srcA, { 'seven-mod/mod.json': JSON.stringify({ id: 'seven-mod', name: 'Seven Zip Mod', version: '1' }), 'seven-mod/patches/data/Items.json.patch.json': JSON.stringify([{ op: 'replace', path: '/3/name', value: 'SEVEN ZIP STEAK' }]) });
makeDir(srcB, { 'tgz-mod/mod.json': JSON.stringify({ id: 'tgz-mod', name: 'Tarball Mod', version: '1' }), 'tgz-mod/patches/data/Items.json.patch.json': JSON.stringify([{ op: 'replace', path: '/4/name', value: 'TARBALL SNACK' }]) });
const have7z = existsSync(SEVENZ);
const sevenZ = join(work, 'seven-mod.7z');
if (have7z) Bun.spawnSync([SEVENZ, 'a', '-bd', sevenZ, join(srcA, 'seven-mod')]);
const tgz = join(work, 'tgz-mod.tar.gz');
// Windows' own bsdtar: the "tar" on PATH may be Git's GNU tar, which reads "C:\..." as a remote host
const tarExe = existsSync('C:/Windows/System32/tar.exe') ? 'C:/Windows/System32/tar.exe' : 'tar';
const tarMade = Bun.spawnSync([tarExe, '-czf', tgz, '-C', srcB, 'tgz-mod']);
if (tarMade.exitCode !== 0) throw new Error('could not build the tar.gz fixture: ' + tarMade.stderr.toString());
const fakeSevenZ = join(work, 'not-really.7z');
writeFileSync(fakeSevenZ, 'this is plain text pretending to be a 7z file');

const browser = await puppeteer.launch({
    executablePath: CHROME, headless: true, defaultViewport: { width: 1280, height: 720 },
    args: ['--autoplay-policy=no-user-gesture-required', '--ignore-gpu-blocklist', '--enable-gpu', '--use-angle=d3d11'],
});

async function load(page: Page, query = '') {
    await page.goto(`http://127.0.0.1:${PORT}/${query}`, { waitUntil: 'load' });
    await page.waitForFunction(() => (globalThis as any).SceneManager?._scene?.constructor?.name === 'Scene_OmoriTitleScreen', { timeout: 120000 });
}
async function install(page: Page, ...zips: string[]) {
    await page.keyboard.press('F8');
    const input = await page.waitForSelector('#omm-panel.open input[type=file][multiple]:not([webkitdirectory])');
    await input!.uploadFile(...zips);
    // wait for the final toast (with the profile choice), not the "Unpacking…" progress one
    await page.waitForFunction(() => [...document.querySelectorAll('#omm-toast button')].some(b => b.textContent === 'Try in a new profile'), { timeout: 60000 });
}

try {
    await sleep(500);
    const page = await browser.newPage();
    const pageErrors: string[] = [];
    page.on('pageerror', e => pageErrors.push((e as Error).message));

    // ---- 1. vanilla
    await load(page);
    check(await page.evaluate(() => $dataItems[2].name) === 'COLD STEAK', 'vanilla game: item 2 is COLD STEAK');
    // a stand-in for the player's real save
    await page.evaluate(() => require('fs').writeFileSync('/appdata/OMORI/TEST_SAVE.txt', 'original'));
    page.on('dialog', d => d.accept(d.type() === 'prompt' ? 'Try Mods' : undefined));

    // ---- 2. install via the panel, apply on reload
    await install(page, hello, assets, oneloader, broken, invalid, tgz, fakeSevenZ, ...(have7z ? [sevenZ] : []));
    const toast = await page.evaluate(() => document.getElementById('omm-toast')!.innerText);
    check(/installed|Installed/.test(toast), `toast confirms install ("${toast.replace(/\n/g, ' ').slice(0, 80)}")`);
    const panelText = await page.evaluate(() => document.getElementById('omm-panel')!.innerText);
    check(/invalid-mod/.test(panelText) && /not valid JSON/.test(panelText), 'a mod with invalid mod.json is rejected with the reason shown');
    check(/not-really\.7z: not a recognised archive/.test(panelText), 'a file that only pretends to be a 7z is rejected with a clear message');

    // installing only adds to the library: nothing is enabled and the original profile is untouched
    check(await page.evaluate(() => $dataItems[2].name) === 'COLD STEAK', 'installing a mod does not change the running original profile');
    // "Try in a new profile": switches to a fresh profile with the saves copied
    await Promise.all([
        page.waitForNavigation({ waitUntil: 'load', timeout: 20000 }),
        page.evaluate(() => ([...document.querySelectorAll('#omm-toast button')].find(b => b.textContent === 'Try in a new profile') as HTMLElement).click()),
    ]);
    await page.waitForFunction(() => (globalThis as any).SceneManager?._scene?.constructor?.name === 'Scene_OmoriTitleScreen', { timeout: 120000 });
    check(await page.evaluate(() => require('fs').readFileSync('/appdata/OMORI/TEST_SAVE.txt', 'utf8')) === 'original', 'new profile started with a copy of the original saves');
    check((await page.evaluate(() => document.getElementById('omm-tab')!.textContent))!.includes('Try Mods'), 'tab shows the active profile name');
    await page.evaluate(() => require('fs').writeFileSync('/appdata/OMORI/TEST_SAVE.txt', 'modded session'));
    const r = await page.evaluate(async () => {
        const icon = new Uint8Array(await (await fetch('/icon/icon.png', { cache: 'no-store' })).arrayBuffer());
        return {
            item: $dataItems[2].name, desc: $dataItems[2].description, armor: (globalThis as any).$dataArmors[1]?.name,
            iconLen: icon.length, mods: (globalThis as any).OmoriMod.mods.map((m: any) => `${m.id}:${m.enabled}`),
            sw: !!navigator.serviceWorker.controller,
        };
    });
    check(r.item === 'MODDED STEAK' && r.desc === 'Proof that mods work.', `JSON patch applied to encrypted Items data (${r.item})`);
    check(r.armor === 'ONELOADER ARMOR', `OneLoader v1 zip: files.data replacement applied (${r.armor})`);
    check(r.sw && r.iconLen === PNG.length && r.iconLen !== ICON.length, `service worker serves the replaced icon (${r.iconLen} bytes, vanilla ${ICON.length})`);
    check(r.mods.includes('hello-mod:true') && r.mods.includes('broken-mod:true'), `mods registered: ${r.mods.join(', ')}`);
    const names = await page.evaluate(() => [3, 4].map(i => $dataItems[i].name));
    check(names[1] === 'TARBALL SNACK' && r.mods.includes('tgz-mod:true'), `.tar.gz mod installed and applied, wrapper folder stripped (${names[1]})`);
    if (have7z) check(names[0] === 'SEVEN ZIP STEAK' && r.mods.includes('seven-mod:true'), `.7z mod installed and applied, wrapper folder stripped (${names[0]})`);
    else console.log('skip .7z check: 7-Zip not installed at', SEVENZ);

    // ---- 3. a broken mod is contained and reported
    const e = await page.evaluate(() => (globalThis as any).OmoriMod && document.getElementById('omm-tab')!.textContent);
    check(/⚠/.test(e ?? ''), `error badge shown on the Mods tab ("${e}")`);
    check(await page.evaluate(() => SceneManager._scene.constructor.name) === 'Scene_OmoriTitleScreen', 'game still reached the title screen despite the broken mod');
    await page.keyboard.press('F8');
    await sleep(400);
    const txt = await page.evaluate(() => document.getElementById('omm-panel')!.innerText);
    check(/broken-mod/.test(txt) && /boom/.test(txt), 'panel attributes the script error to broken-mod');
    check(/99999/.test(txt), 'panel reports the failing patch path');
    const logPath = 'latest.log';
    await sleep(500);
    const log = existsSync(logPath) ? readFileSync(logPath, 'utf8') : '';
    check(/broken-mod/.test(log) && /boom/.test(log), 'errors were written to latest.log');

    // ---- 4. safe mode
    await load(page, '?mods=0');
    check(await page.evaluate(() => $dataItems[2].name) === 'COLD STEAK', '?mods=0 starts the vanilla game');
    const iconSafe = await page.evaluate(async () => (await (await fetch('/icon/icon.png', { cache: 'no-store' })).arrayBuffer()).byteLength);
    check(iconSafe === ICON.length, `?mods=0 also bypasses the service worker (icon ${iconSafe} bytes)`);

    // ---- 5. switching back to the original profile: saves untouched, no mods, automatic backup of the profile we left
    await load(page);
    await page.keyboard.press('F8');
    await page.waitForSelector('#omm-panel select');
    await Promise.all([
        page.waitForNavigation({ waitUntil: 'load', timeout: 20000 }),
        page.select('#omm-panel select', 'default'),
    ]);
    await page.waitForFunction(() => (globalThis as any).SceneManager?._scene?.constructor?.name === 'Scene_OmoriTitleScreen', { timeout: 120000 });
    const back = await page.evaluate(async () => ({
        save: require('fs').readFileSync('/appdata/OMORI/TEST_SAVE.txt', 'utf8'), item: $dataItems[2].name,
        icon: (await (await fetch('/icon/icon.png', { cache: 'no-store' })).arrayBuffer()).byteLength,
    }));
    check(back.save === 'original', `original profile's save is untouched by the modded session (${back.save})`);
    check(back.item === 'COLD STEAK' && back.icon === ICON.length, 'original profile runs the vanilla game (data and assets)');
    await page.keyboard.press('F8');
    await sleep(300);
    const panel2 = await page.evaluate(() => document.getElementById('omm-panel')!.innerText);
    check(/before switching profile/.test(panel2), 'leaving the modded profile created a save backup');

    // ---- 6. back to the modded profile, disable one mod
    await Promise.all([
        page.waitForNavigation({ waitUntil: 'load', timeout: 20000 }),
        page.evaluate(() => { const s = document.querySelector('#omm-panel select') as HTMLSelectElement; s.value = [...s.options].find(o => o.text.includes('Try Mods'))!.value; s.dispatchEvent(new Event('change')); }),
    ]);
    await page.waitForFunction(() => (globalThis as any).SceneManager?._scene?.constructor?.name === 'Scene_OmoriTitleScreen', { timeout: 120000 });
    check(await page.evaluate(() => require('fs').readFileSync('/appdata/OMORI/TEST_SAVE.txt', 'utf8')) === 'modded session', 'modded profile kept its own save');
    check(await page.evaluate(() => $dataItems[2].name) === 'MODDED STEAK', 'modded profile still has its mods');
    await page.keyboard.press('F8');
    await sleep(300);
    await page.evaluate(() => { for (const b of document.querySelectorAll('#omm-panel .omm-mod')) if (b.textContent!.includes('hello-mod')) ([...b.querySelectorAll('button')].find(x => x.textContent === 'Disable') as HTMLElement).click(); });
    await sleep(500);
    await load(page);
    check(await page.evaluate(() => $dataItems[2].name) === 'COLD STEAK', 'a mod disabled in the profile no longer applies');

    check(pageErrors.filter(m => !/boom|null/.test(m)).length === 0, `no unexpected page errors ${JSON.stringify(pageErrors.slice(0, 3))}`);
    await page.screenshot({ path: 'test/out/mods-panel.png' });
} finally {
    await browser.close();
    server.kill();
}
if (failures.length) { console.error(`\n${failures.length} failure(s)`); process.exit(1); }
console.log('\nall mod tests passed');
