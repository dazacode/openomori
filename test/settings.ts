// End-to-end test of the modern settings screen in real Chrome: opening it from the title's Options command,
// live game config changes, persistence across reloads, fast-forward, key rebinding, search, mod settings,
// startup-splash skipping, and the game not seeing input while the panel is open.
import puppeteer, { type Page } from 'puppeteer-core';
import { mkdirSync } from 'node:fs';
import { ANGLE, CHROME } from './chrome.ts';

const PORT = 8097;
mkdirSync('test/out', { recursive: true });
const server = Bun.spawn(['bun', 'run', 'src/server.ts', String(PORT)], { stdout: 'ignore', stderr: 'inherit' });
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const failures: string[] = [];
const check = (ok: boolean, msg: string) => { console.log(ok ? 'ok  ' : 'FAIL', msg); if (!ok) failures.push(msg); };

const browser = await puppeteer.launch({
    executablePath: CHROME, headless: true, defaultViewport: { width: 1280, height: 720 },
    args: ['--autoplay-policy=no-user-gesture-required', '--ignore-gpu-blocklist', '--enable-gpu', ANGLE],
});

async function toTitle(page: Page, query = '') {
    const t0 = Date.now();
    await page.goto(`http://127.0.0.1:${PORT}/${query}`, { waitUntil: 'load' });
    await page.waitForFunction(() => (globalThis as any).SceneManager?._scene?.constructor?.name === 'Scene_OmoriTitleScreen' && (globalThis as any).SceneManager._scene._commandActive, { timeout: 120000 });
    return Date.now() - t0;
}
/** The game polls input once per frame, so a key must be held across at least one frame. */
const tap = async (page: Page, key: any) => { await page.keyboard.down(key); await sleep(90); await page.keyboard.up(key); await sleep(60); };
const isOpen = (page: Page) => page.evaluate(() => document.getElementById('oset')?.classList.contains('open') ?? false);
const cfg = (page: Page, k: string) => page.evaluate(k2 => (globalThis as any).ConfigManager[k2], k);

try {
    await sleep(500);
    const page = await browser.newPage();
    // record every scene class that ever becomes current, from the first frame
    await page.evaluateOnNewDocument(() => {
        // scene name -> how long (ms) it was the current scene
        const spent: Record<string, number> = {}; (window as any).__spent = spent;
        let last = performance.now();
        setInterval(() => { const now = performance.now(), n = (window as any).SceneManager?._scene?.constructor?.name; if (n) spent[n] = (spent[n] ?? 0) + (now - last); last = now; }, 16);
    });
    const errors: string[] = [];
    page.on('pageerror', e => errors.push((e as Error).message));
    page.on('dialog', d => d.accept());

    // ---- 1. title → Options opens the new panel, not the old windows
    const bootMs = await toTitle(page);
    await tap(page, 'ArrowRight'); await tap(page, 'ArrowRight');
    await tap(page, 'KeyZ');
    await page.waitForSelector('#oset.open', { timeout: 5000 });
    const splashMs = await page.evaluate(() => (window as any).__spent.Scene_SplashScreens ?? 0);
    check(splashMs > 3000, `baseline: the splash screens play for a while on a fresh boot (${Math.round(splashMs)} ms)`);
    check(true, `title "Options" opened the new settings panel (boot ${bootMs} ms)`);
    check(await page.evaluate(() => !(globalThis as any).SceneManager._scene._optionsActive), 'the old option windows were not activated');
    check(await page.evaluate(() => [...document.querySelectorAll('#oset nav [data-tab]')].map(b => b.textContent).join()) === 'Gameplay,Display,Audio,Controls,Accessibility,Mods,System', 'all seven tabs are present');
    await page.screenshot({ path: 'test/out/settings-general.png' });

    // ---- 2. game input is blocked while open
    await page.keyboard.press('KeyZ'); await page.keyboard.press('ArrowRight');
    check(await page.evaluate(() => !(globalThis as any).Input.isPressed('ok')), 'the game does not see keys while the panel is open');

    // ---- 3. toggles write the game's own ConfigManager
    const before = await cfg(page, 'textSkip');
    await page.click('.row[data-id=textSkip] .sw');
    check(await cfg(page, 'textSkip') === !before, `Fast-forward text toggled ConfigManager.textSkip (${before} → ${!before})`);
    // keyboard: focus a row and use Right on a choice
    await page.focus('.row[data-id=battleLogSpeed]');
    await page.keyboard.press('ArrowRight');
    check(await cfg(page, 'battleLogSpeed') === 2, 'ArrowRight on a choice row moves ConfigManager.battleLogSpeed 1 → 2');
    await page.keyboard.press('ArrowLeft'); await page.keyboard.press('ArrowLeft');
    check(await cfg(page, 'battleLogSpeed') === 0, 'ArrowLeft moves it down to 0');

    // ---- 4. audio slider and the per-setting reset button
    await page.evaluate(() => { document.querySelector<HTMLElement>('#oset nav [data-tab=audio]')!.click(); });
    await page.evaluate(() => {
        const input = document.querySelector<HTMLInputElement>('.row[data-id=bgmVolume] input[type=range]')!;
        input.value = '33'; input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    check(await cfg(page, 'bgmVolume') === 33, 'music slider sets ConfigManager.bgmVolume');
    await page.click('.row[data-id=bgmVolume] .reset');
    check(await cfg(page, 'bgmVolume') === 70, 'the per-setting reset button restores the default (70)');

    // ---- 5. search finds settings across tabs
    await page.type('#oset nav input', 'volume');
    await sleep(200);
    const found = await page.evaluate(() => [...document.querySelectorAll('#oset .row')].map(r => r.getAttribute('data-id')));
    check(found.includes('bgmVolume') && found.includes('seVolume') && !found.includes('textSkip'), `search "volume" filters rows (${found.join(',')})`);
    await page.evaluate(() => { const i = document.querySelector<HTMLInputElement>('#oset nav input')!; i.value = ''; i.dispatchEvent(new Event('input')); });

    // ---- 6. a port setting, then close with Esc: title command window is active again
    await page.evaluate(() => { document.querySelector<HTMLElement>('#oset nav [data-tab=display]')!.click(); });
    await page.click('.row[data-id=showFps] .sw');
    await sleep(700);
    check(await page.evaluate(() => [...document.body.children].some(e => /fps/.test((e as HTMLElement).textContent ?? '') && (e as HTMLElement).style.position === 'fixed')), 'FPS counter appears');
    await page.focus('.row[data-id=showFps]');
    await page.keyboard.press('Escape');
    await sleep(200);
    check(!(await isOpen(page)), 'Esc closes the panel');
    check(await page.evaluate(() => (globalThis as any).SceneManager._scene._commandActive === true && !(globalThis as any).SceneManager._scene._optionsActive), 'the title command window is active again');

    // ---- 7. fast-forward: hold F
    const rate = async () => page.evaluate(async () => {
        const S = (globalThis as any).SceneManager; let n = 0; const orig = S._scene.update;
        S._scene.update = function (...a: unknown[]) { n++; return orig.apply(this, a); };
        await new Promise(r => setTimeout(r, 1000));
        S._scene.update = orig; return n;
    });
    const normal = await rate();
    await page.keyboard.down('KeyF'); await sleep(100);
    const fast = await rate();
    check(await page.evaluate(() => (globalThis as any).document.body.innerText.includes('▶▶ 3x')), 'a 3x badge is shown while fast-forwarding');
    await page.keyboard.up('KeyF'); await sleep(100);
    check(fast > normal * 2.4 && fast < normal * 3.6, `scene updates per second: ${normal} normal → ${fast} fast-forwarded`);
    check(await page.evaluate(() => !(globalThis as any).document.body.innerText.includes('▶▶')), 'releasing F removes the badge');

    // ---- 8. key rebinding through the Controls tab
    await page.keyboard.press('F10'); await page.waitForSelector('#oset.open');
    await page.evaluate(() => { document.querySelector<HTMLElement>('#oset nav [data-tab=controls]')!.click(); });
    await sleep(200);
    const idx = await page.evaluate(() => [...document.querySelectorAll('#oset .krow')].findIndex(r => r.textContent!.startsWith('Confirm')));
    await page.evaluate(i => (document.querySelectorAll('#oset .krow')[i]!.querySelector('.add') as HTMLElement).click(), idx);
    await page.keyboard.press('KeyJ');
    await sleep(200);
    check(await page.evaluate(() => (globalThis as any).Input.keyMapper[74]) === 'ok', 'adding J as a Confirm key updates Input.keyMapper');
    check(await page.evaluate(() => (globalThis as any).Input.keyMapper[90]) === 'ok', 'the original Confirm key (Z) is kept');
    // X is the only Cancel key: it can't be stolen, and the user is told why
    await page.evaluate(i => (document.querySelectorAll('#oset .krow')[i]!.querySelector('.add') as HTMLElement).click(), idx);
    await page.keyboard.press('KeyX'); await sleep(200);
    check(await page.evaluate(() => (globalThis as any).Input.keyMapper[88]) === 'escape', 'the last key of a required action (X = Cancel) cannot be stolen');
    check(/only key/.test(await page.evaluate(() => document.querySelector('#oset .status')!.textContent ?? '')), 'and the status line explains why');
    // a non-required binding can move: F is not mapped by default, give it to Confirm then take it for Run
    await page.evaluate(i => (document.querySelectorAll('#oset .krow')[i]!.querySelector('.add') as HTMLElement).click(), idx);
    await page.keyboard.press('KeyK'); await sleep(150);
    const runIdx = await page.evaluate(() => [...document.querySelectorAll('#oset .krow')].findIndex(r => r.textContent!.startsWith('Run')));
    await page.evaluate(i => (document.querySelectorAll('#oset .krow')[i]!.querySelector('.add') as HTMLElement).click(), runIdx);
    await page.keyboard.press('KeyK'); await sleep(150);
    check(await page.evaluate(() => (globalThis as any).Input.keyMapper[75]) === 'shift', 'a key already used elsewhere moves to the new action (K: Confirm → Run)');
    await page.screenshot({ path: 'test/out/settings-controls.png' });

    // ---- 9. mod settings appear under Mods and persist
    await page.evaluate(() => {
        const api = (globalThis as any).OmoriMod.scope('test-mod');
        (globalThis as any).__modGot = [];
        api.settings.add({ id: 'power', type: 'slider', label: 'Mod power', min: 0, max: 10, default: 5, onChange: (v: number) => (globalThis as any).__modGot.push(v) });
    });
    await page.evaluate(() => { document.querySelector<HTMLElement>('#oset nav [data-tab=mods]')!.click(); });
    await sleep(200);
    check(await page.evaluate(() => !!document.querySelector('.row[data-id="test-mod.power"]')), 'a mod-added setting shows on the Mods tab');
    await page.evaluate(() => {
        const input = document.querySelector<HTMLInputElement>('.row[data-id="test-mod.power"] input')!;
        input.value = '8'; input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    check(await page.evaluate(() => (globalThis as any).__modGot.at(-1)) === 8, 'the mod\'s onChange callback received the new value');

    // ---- 10. persistence across a reload (into the game's own config file)
    await page.keyboard.press('Escape');
    await sleep(1200); // debounced save
    const saved = await page.evaluate(() => JSON.parse((globalThis as any).StorageManager.load(-1)));
    check(saved.omoriWeb?.showFps === true && saved.omoriWeb?.['mod.test-mod.power'] === 8, `port + mod values are saved in the game's config file (${JSON.stringify(saved.omoriWeb)})`);
    check(saved.textSkip === !before && saved.keyboardInputMap?.[74] === 'ok', 'game values and key bindings are saved in the same file');

    // ---- 11. reload: values come back; enable skipSplash and see the boot get faster
    await toTitle(page);
    check(await cfg(page, 'textSkip') === !before, 'textSkip survives a reload');
    check(await page.evaluate(() => (globalThis as any).Input.keyMapper[74]) === 'ok', 'custom key binding survives a reload');
    check(await page.evaluate(() => [...document.body.children].some(e => /fps/.test((e as HTMLElement).textContent ?? ''))), 'FPS counter setting survives a reload');

    await page.keyboard.press('F10'); await page.waitForSelector('#oset.open');
    await page.click('.row[data-id=skipSplash] .sw');
    await sleep(900);
    await page.keyboard.press('Escape');
    // splash only plays while there's no global save; the test browser has none
    const fastBoot = await toTitle(page);
    const skippedMs = await page.evaluate(() => (window as any).__spent.Scene_SplashScreens ?? 0);
    check(skippedMs < 1000, `with "Skip intro screens" on, the splash is over in ${Math.round(skippedMs)} ms instead of ${Math.round(splashMs)} ms (boot ${fastBoot} ms)`);

    // ---- 12. in-game menu entry point opens it too
    const viaMenu = await page.evaluate(() => {
        let activated = false;
        (globalThis as any).Scene_Menu.prototype.commandOptions.call({ _commandWindow: { activate: () => { activated = true; } } });
        const opened = document.getElementById('oset')!.classList.contains('open');
        (globalThis as any).__menuProbe = () => activated;
        return opened;
    });
    check(viaMenu, 'Scene_Menu "Options" opens the panel');
    await page.keyboard.press('Escape'); await sleep(200);
    check(await page.evaluate(() => (globalThis as any).__menuProbe()), 'closing returns focus to the in-game menu command window');

    // ---- 13. reset all
    await page.keyboard.press('F10'); await page.waitForSelector('#oset.open');
    await page.evaluate(() => { document.querySelector<HTMLElement>('#oset nav [data-tab=system]')!.click(); });
    await sleep(200);
    await page.evaluate(() => (document.querySelector('.row[data-id=resetAll] button') as HTMLElement).click());
    await sleep(300);
    check(await cfg(page, 'textSkip') === false && await page.evaluate(() => (globalThis as any).Input.keyMapper[74]) === undefined, 'Reset all restores defaults and key bindings');
    await page.screenshot({ path: 'test/out/settings-system.png' });

    check(errors.length === 0, `no page errors ${JSON.stringify(errors.slice(0, 3))}`);
} finally {
    await browser.close();
    server.kill();
}
if (failures.length) { console.error(`\n${failures.length} failure(s)`); process.exit(1); }
console.log('\nall settings tests passed');
