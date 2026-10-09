// Runtime behaviour behind the settings: each function takes the new value and makes it true right now.
// Everything here talks to the running game through its globals, all of which exist by the time this is installed.

const g = globalThis as any;

// ---------------------------------------------------------------- shared frame ticker
const tickers = new Set<(now: number) => void>();
let ticking = false;
export function onFrame(fn: (now: number) => void): () => void {
    tickers.add(fn);
    if (!ticking) {
        ticking = true;
        const loop = (now: number) => { tickers.forEach(f => { try { f(now); } catch (e) { console.error('[settings] ticker', e); } }); requestAnimationFrame(loop); };
        requestAnimationFrame(loop);
    }
    return () => tickers.delete(fn);
}

const MONO = "ui-monospace,Consolas,monospace";

// ---------------------------------------------------------------- FPS counter
let fpsEl: HTMLDivElement | null = null, fpsOff: (() => void) | null = null;
export function setShowFps(on: boolean) {
    fpsOff?.(); fpsOff = null;
    fpsEl?.remove(); fpsEl = null;
    if (!on) return;
    const el = fpsEl = document.createElement('div');
    el.setAttribute('style', `position:fixed;right:6px;bottom:6px;z-index:2147482000;font:12px ${MONO};color:#fff;background:#000a;padding:3px 6px;border-radius:4px;pointer-events:none`);
    document.body.append(el);
    let frames = 0, last = performance.now(), worst = 0, prev = last;
    fpsOff = onFrame(now => {
        frames++; worst = Math.max(worst, now - prev); prev = now;
        if (now - last >= 500) {
            el.textContent = `${Math.round((frames * 1000) / (now - last))} fps · ${worst.toFixed(0)} ms worst`;
            frames = 0; worst = 0; last = now;
        }
    });
}

// ---------------------------------------------------------------- idle cursor
let cursorTimer: ReturnType<typeof setTimeout> | undefined, cursorOn = false;
const showCursor = () => { document.body.style.cursor = ''; clearTimeout(cursorTimer); if (cursorOn) cursorTimer = setTimeout(() => { document.body.style.cursor = 'none'; }, 2000); };
export function setHideCursor(on: boolean) {
    if (!cursorOn && on) window.addEventListener('mousemove', showCursor);
    if (cursorOn && !on) window.removeEventListener('mousemove', showCursor);
    cursorOn = on;
    showCursor();
}

// ---------------------------------------------------------------- focus loss: pause (the game's own behaviour) / mute / keep playing
// The original game freezes, ignores input and fades its audio out whenever the window is not focused, all decided by
// SceneManager.isFocus(). "Keep playing" and "Mute" make isFocus() true so the world keeps running; "Mute" also silences
// audio ourselves, since the game would otherwise fade it back in.
type BlurMode = 'pause' | 'mute' | 'keep';
let blurMode: BlurMode = 'pause';
let away = false;
let focusInstalled = false;
const realFocus = (): boolean => { try { return document.hasFocus() && document.visibilityState !== 'hidden'; } catch { return true; } };

function installFocusOverride() {
    if (focusInstalled || !g.SceneManager) return;
    focusInstalled = true;
    const SM = g.SceneManager;
    const isFocus = SM.isFocus;
    SM.isFocus = function (this: any) { return blurMode === 'pause' ? isFocus.call(this) : true; };
    const audio = SM.updateWebAudio;
    SM.updateWebAudio = function (this: any) { if (blurMode === 'mute' && away) return; return audio.call(this); };
}
function applyAway() {
    const ctx = g.WebAudio?._context as AudioContext | undefined;
    try { if (blurMode === 'mute') { away ? ctx?.suspend() : ctx?.resume(); } else if (blurMode === 'keep') ctx?.resume(); } catch { /* audio not started yet */ }
}
export function setBlurMode(mode: string) {
    blurMode = mode === 'mute' || mode === 'keep' ? mode : 'pause';
    installFocusOverride();
    away = !realFocus();
    applyAway();
}
const setAway = (v: boolean) => { if (away !== v) { away = v; applyAway(); } };
window.addEventListener('blur', () => setAway(true));
window.addEventListener('focus', () => setAway(false));
document.addEventListener('visibilitychange', () => setAway(!realFocus()));

// ---------------------------------------------------------------- speed: permanent multiplier and hold-to-fast-forward
// The game runs `SceneManager.update` from a ticker and asks determineRepeatNumber() how many logic steps to take for
// the frame (to catch up after slow frames). Scaling that count runs the whole game faster: every step still reads
// input, so button presses and dialogue advance exactly once per step.
let baseSpeed = 1, ffSpeed = 3, ffEnabled = true, ffHeld = false;
let ffBadge: HTMLDivElement | null = null, speedInstalled = false, stepDebt = 0, speed = 1;
const MAX_STEPS = 12;

function installSpeed() {
    if (speedInstalled || !g.SceneManager) return;
    speedInstalled = true;
    const SM = g.SceneManager;
    const repeat = SM.determineRepeatNumber;
    SM.determineRepeatNumber = function (this: any, dt: number) {
        const n = repeat.call(this, dt);
        if (speed <= 1) { stepDebt = 0; return n; }
        stepDebt += n * speed;
        const whole = Math.min(MAX_STEPS, Math.floor(stepDebt));
        stepDebt -= Math.floor(stepDebt);
        return whole;
    };
}

function applySpeed() {
    installSpeed();
    speed = Math.min(8, baseSpeed * (ffEnabled && ffHeld ? ffSpeed : 1));
    if (speed > 1 && !ffBadge) {
        ffBadge = document.createElement('div');
        ffBadge.setAttribute('style', `position:fixed;left:50%;top:8px;transform:translateX(-50%);z-index:2147482000;font:600 13px ${MONO};color:#fff;background:#000a;padding:3px 10px;border-radius:4px;pointer-events:none`);
        document.body.append(ffBadge);
    }
    if (ffBadge) { ffBadge.textContent = `▶▶ ${+speed.toFixed(2)}x`; ffBadge.style.display = speed > 1 ? '' : 'none'; }
}
export const currentSpeed = () => speed;
export const setGameSpeed = (v: number) => { baseSpeed = v || 1; applySpeed(); };
export const setFastForwardSpeed = (v: number) => { ffSpeed = v || 3; applySpeed(); };
export const setFastForwardEnabled = (v: boolean) => { ffEnabled = v; applySpeed(); };

export const FF_KEY = 'KeyF';
const typing = (t: EventTarget | null) => t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
let panelOpen = () => false;
export const setPanelOpenCheck = (fn: () => boolean) => { panelOpen = fn; };
window.addEventListener('keydown', e => { if (e.code === FF_KEY && !e.repeat && !typing(e.target) && !panelOpen() && !e.ctrlKey && !e.metaKey) { ffHeld = true; applySpeed(); } });
window.addEventListener('keyup', e => { if (e.code === FF_KEY) { ffHeld = false; applySpeed(); } });
window.addEventListener('blur', () => { ffHeld = false; applySpeed(); });

// ---------------------------------------------------------------- screenshot
export function screenshot(): boolean {
    const canvas: HTMLCanvasElement | undefined = g.Graphics?._canvas;
    if (!canvas) return false;
    try {
        g.SceneManager.renderScene(); // draw now: a WebGL canvas can only be read in the task that rendered it
        const url = canvas.toDataURL('image/png');
        const d = new Date(), p = (n: number) => String(n).padStart(2, '0');
        const a = document.createElement('a');
        a.href = url;
        a.download = `omori-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.png`;
        document.body.append(a); a.click(); a.remove();
        return true;
    } catch (e) { console.warn('[settings] screenshot failed', e); return false; }
}
export const SCREENSHOT_KEY = 'F7';
window.addEventListener('keydown', e => { if (e.key === SCREENSHOT_KEY && !panelOpen()) { e.preventDefault(); screenshot(); } });

// ---------------------------------------------------------------- input icons follow the device in use
let autoIcons = false;
export function setAutoInputIcons(on: boolean) { autoIcons = on; }
function setIcons(gamepad: boolean) {
    const C = g.ConfigManager;
    if (!C || C.gamepadTips === gamepad) return;
    C.gamepadTips = gamepad;
    g.SceneManager?._scene?.refreshCommandHints?.();
}
window.addEventListener('keydown', () => { if (autoIcons) setIcons(false); }, true);
onFrame(() => {
    if (!autoIcons) return;
    for (const pad of navigator.getGamepads?.() ?? []) {
        if (pad && (pad.buttons.some(b => b.pressed) || pad.axes.some(a => Math.abs(a) > 0.6))) { setIcons(true); return; }
    }
});

// ---------------------------------------------------------------- leaving the page mid-game
let warnOnLeave = true;
export const setWarnOnLeave = (v: boolean) => { warnOnLeave = v; };
window.addEventListener('beforeunload', e => {
    const s = g.SceneManager?._scene;
    if (warnOnLeave && s && (s instanceof g.Scene_Map || s instanceof g.Scene_Battle)) { e.preventDefault(); e.returnValue = ''; }
});

// ---------------------------------------------------------------- startup splash screens
let skipSplash = false;
export const setSkipSplash = (v: boolean) => { skipSplash = v; };
/** The splash plugin hijacks SceneManager.goto until `Galv.ASPLASH.splashed` is set; setting it first lets the requested scene (the title) through. */
export function installSplashSkip() {
    const SM = g.SceneManager;
    const goto = SM.goto;
    SM.goto = function (this: any, sceneClass: unknown) {
        if (skipSplash && g.Galv?.ASPLASH) g.Galv.ASPLASH.splashed = true;
        return goto.call(this, sceneClass);
    };
}

// ---------------------------------------------------------------- hold the world still while the settings screen is open
export function installPause(panelIsOpen: () => boolean) {
    const SM = g.SceneManager;
    const update = SM.updateScene;
    SM.updateScene = function (this: any) { if (!panelIsOpen()) update.call(this); };
}

// ---------------------------------------------------------------- display toggles
export function applyDisplay() {
    const G = g.Graphics;
    if (!G?._canvas) return;
    G._updateAllElements?.();
}

export function setFullscreen(on: boolean) {
    const G = g.Graphics;
    try { on ? G._requestFullScreen() : G._cancelFullScreen(); } catch (e) { console.warn('[settings] fullscreen', e); }
}
export const isFullscreen = (): boolean => !!document.fullscreenElement;
document.addEventListener('fullscreenchange', () => { if (g.ConfigManager) g.ConfigManager.fullScreen = !!document.fullscreenElement; });
