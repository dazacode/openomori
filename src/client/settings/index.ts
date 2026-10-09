// Installs the modern settings system over the game's built-in options screens.
//
//  * Game options stay on ConfigManager; this just replaces the UI, so saves and every game system are unaffected.
//  * Port options (and mod options) ride along in the same config file under "omoriWeb".
//  * The title screen's and the in-game menu's "Options" entries open the new panel instead of the old windows.
import { openModManager } from '../mods/ui.ts';
import { registerBuiltin } from './builtin.ts';
import * as F from './features.ts';
import { closeSettings, isOpen, openSettings, settingsStatus } from './panel.ts';
import { all, exportBag, importBag, scheduleSave } from './registry.ts';

const g = globalThis as any;
const download = (name: string, text: string, type = 'application/json') => {
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(new Blob([text], { type })), download: name });
    document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
};

export { openSettings, closeSettings, isOpen };

export function installSettings() {
    const CM = g.ConfigManager;

    // ---- persistence: port + mod values live inside the game's own config file
    const makeData = CM.makeData, applyData = CM.applyData;
    CM.makeData = function (this: any) { const c = makeData.call(this); c.omoriWeb = exportBag(); return c; };
    CM.applyData = function (this: any, config: any) { applyData.call(this, config); importBag(config?.omoriWeb); };

    F.setPanelOpenCheck(isOpen);
    F.installSplashSkip();
    F.installPause(isOpen);

    // While the panel is open the game must not see the keyboard OR the gamepad (it polls pads itself).
    const inputUpdate = g.Input.update;
    g.Input.update = function (this: any) { if (isOpen()) { this.clear(); return; } return inputUpdate.call(this); };

    // ---- the actions behind buttons on the System / Accessibility tabs
    registerBuiltin({
        exportSettings() { download('omori-settings.json', JSON.stringify(CM.makeData(), null, 2)); settingsStatus('Settings exported'); },
        importSettings() {
            const input = Object.assign(document.createElement('input'), { type: 'file', accept: 'application/json,.json' });
            input.onchange = async () => {
                const f = input.files?.[0]; if (!f) return;
                try {
                    const json = JSON.parse(await f.text());
                    if (!json || typeof json !== 'object' || Array.isArray(json)) throw new Error('not a settings file');
                    // Merge over the current values: the game reads a missing flag as "off".
                    CM.applyData({ ...CM.makeData(), ...json });
                    CM.save();
                    settingsStatus('Settings imported');
                } catch (e) { settingsStatus(`Could not import: ${(e as Error).message}`); }
            };
            input.click();
        },
        resetAll() {
            if (!confirm('Reset every setting and key binding to its default? Your saves are not touched.')) return;
            for (const s of all()) if (s.default !== undefined && s.control.type !== 'action') (s.control as any).set(s.default);
            CM.setDefaultKeyboardKeyMap(); CM.setDefaultGamepadKeyMap();
            scheduleSave();
            settingsStatus('All settings reset');
        },
        copyDiagnostics() {
            const text = diagnostics();
            (navigator.clipboard?.writeText(text) ?? Promise.reject()).then(() => settingsStatus('Diagnostics copied'), () => { download('omori-diagnostics.txt', text, 'text/plain'); settingsStatus('Clipboard blocked: saved as a file'); });
        },
        openMods() { closeSettings(); openModManager(); },
        loadGame() {
            closeSettings(); CM.save();
            g.SceneManager.push(g.Scene_OmoriFile); g.SceneManager._stack.pop(); g.SceneManager._nextScene.setup(false, true);
        },
        toTitle() { if (confirm('Return to the title screen? Unsaved progress is lost.')) { closeSettings(); g.SceneManager.goto(g.Scene_OmoriTitleScreen); } },
        reduceMotion() {
            for (const k of ['screenEffectsEnabled', 'TKMFilterEnabledAll', 'menuAnimations']) if (CM[k] !== undefined) CM[k] = false;
            scheduleSave();
            settingsStatus('Screen effects, visual filters and menu animations are now off');
        },
    });

    // ---- replace the game's two entry points
    const menuOptions = g.Scene_Menu?.prototype;
    if (menuOptions) {
        menuOptions.commandOptions = function (this: any) {
            openSettings({ onClose: () => { this._commandWindow?.activate(); } });
        };
    }
    const title = g.Scene_OmoriTitleScreen?.prototype;
    if (title) {
        title.commandOptions = function (this: any) {
            openSettings({ onClose: () => { this._optionsActive = false; this._commandActive = true; g.Input.clear(); } });
            // the caller flags the (now unused) built-in options windows as active right after we return
            queueMicrotask(() => { this._optionsActive = false; });
        };
    }

    // ---- F10 anywhere
    window.addEventListener('keydown', e => {
        if (e.key === 'F10') { e.preventDefault(); isOpen() ? closeSettings() : openSettings(); }
    });
}

function diagnostics(): string {
    const CM = g.ConfigManager, G = g.Graphics;
    let gpu = 'unknown';
    try {
        const gl = document.createElement('canvas').getContext('webgl');
        const ext = gl?.getExtension('WEBGL_debug_renderer_info');
        if (gl && ext) gpu = String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL));
    } catch { /* blocked */ }
    const mods = (g.OmoriMod?.mods ?? []).map((m: any) => `${m.id}@${m.version}${m.enabled ? '' : ' (off)'}`).join(', ') || 'none';
    return [
        `OpenOMORI diagnostics (${new Date().toISOString()})`,
        `page: ${location.href}`,
        `browser: ${navigator.userAgent}`,
        `gpu: ${gpu}`,
        `canvas: ${G?._width}x${G?._height} logical, ${G?._res}x resolution, scale ${G?._realScale?.toFixed?.(2)}, window ${innerWidth}x${innerHeight} @${devicePixelRatio}x`,
        `scene: ${g.SceneManager?._scene?.constructor?.name}`,
        `mods: ${mods}`,
        `settings: ${JSON.stringify({ ...CM.makeData(), keyboardInputMap: undefined, gamepadInputMap: undefined })}`,
    ].join('\n');
}
