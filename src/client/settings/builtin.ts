// The built-in settings. Game-owned values read and write ConfigManager directly (so the game and its saves are
// unaffected); port-owned values go through portValue(). Defaults for game values are snapshotted from what the
// game's own plugins initialised, so "reset" means the game's real defaults.
import { displayPrefs } from '../display.ts';
import * as F from './features.ts';
import { notify, portValue, register, scheduleSave, type Choice, type Setting } from './registry.ts';

const g = globalThis as any;
const C = () => g.ConfigManager;

const flag = (key: string) => ({
    get: () => !!C()[key],
    set: (v: boolean) => { C()[key] = v; scheduleSave(); notify(); },
});
const num = (key: string) => ({
    get: () => Number(C()[key]),
    set: (v: number) => { C()[key] = v; scheduleSave(); notify(); },
});

const choices = (...pairs: [string | number, string][]): Choice[] => pairs.map(([value, label]) => ({ value, label }));
const inGame = () => !!g.SceneManager && !(g.SceneManager._scene instanceof g.Scene_OmoriTitleScreen) && !(g.SceneManager._scene instanceof g.Scene_Boot);

export interface Actions {
    exportSettings(): void;
    importSettings(): void;
    resetAll(): void;
    copyDiagnostics(): void;
    openMods(): void;
    loadGame(): void;
    toTitle(): void;
    reduceMotion(): void;
}

export function registerBuiltin(a: Actions) {
    const snap = (key: string, fallback: unknown) => (C()?.[key] ?? fallback);
    const sample = () => { try { g.SoundManager?.playCursor?.(); } catch { /* audio locked until first input */ } };

    // ---- ports: these are this browser build's own features
    const quality = portValue<number>('quality', 0, v => { displayPrefs.quality = v; F.applyDisplay(); });
    const wide = portValue<boolean>('wide', true, v => { displayPrefs.wide = v; });
    const smooth = portValue<boolean>('smooth', true, v => { displayPrefs.smooth = v; F.applyDisplay(); });
    const fps = portValue<boolean>('showFps', false, F.setShowFps);
    const cursor = portValue<boolean>('hideCursor', false, F.setHideCursor);
    const blur = portValue<string>('onBlur', 'pause', F.setBlurMode);
    const speed = portValue<number>('gameSpeed', 1, F.setGameSpeed);
    const ffOn = portValue<boolean>('ffEnabled', true, F.setFastForwardEnabled);
    const ffSpeed = portValue<number>('ffSpeed', 3, F.setFastForwardSpeed);
    const splash = portValue<boolean>('skipSplash', false, F.setSkipSplash);
    const leave = portValue<boolean>('warnOnLeave', true, F.setWarnOnLeave);
    const autoIcons = portValue<boolean>('autoInputIcons', false, F.setAutoInputIcons);

    const S: Setting[] = [
        // ---------------------------------------------------------- gameplay
        { id: 'alwaysDash', tab: 'general', group: 'Movement', label: 'Run by default', help: 'Move at running speed without holding the run key. Holding it then walks instead.', default: false, keywords: 'dash walk sprint',
          control: { type: 'toggle', ...flag('alwaysDash') } },
        { id: 'textSkip', tab: 'general', group: 'Text', label: 'Fast-forward text', help: 'Hold Confirm or Cancel to speed through dialogue.', default: false, keywords: 'dialogue skip',
          control: { type: 'toggle', ...flag('textSkip') } },
        { id: 'battleLogSpeed', tab: 'general', group: 'Text', label: 'Battle text speed', help: 'How quickly battle messages scroll.', default: 1, keywords: 'combat',
          control: { type: 'choice', options: choices([0, 'Fast'], [1, 'Medium'], [2, 'Slow']), ...num('battleLogSpeed') } },
        { id: 'menuAnimations', tab: 'general', group: 'Interface', label: 'Menu animations', help: 'Slide and fade menus in and out. Turn off for snappier menus.', default: snap('menuAnimations', true),
          control: { type: 'toggle', ...flag('menuAnimations') } },
        { id: 'battleCamera', tab: 'general', group: 'Interface', label: 'Battle camera moves', help: 'Let the camera swing and zoom during attacks.', default: snap('battleCamera', true), keywords: 'combat zoom',
          visible: () => C()?.battleCamera !== undefined, control: { type: 'toggle', ...flag('battleCamera') } },
        { id: 'gameSpeed', tab: 'general', group: 'Speed', label: 'Game speed', help: 'Run the whole game faster. Animation, movement and timers all scale; music stays at normal pitch.', default: 1, keywords: 'turbo fast slow',
          control: { type: 'choice', options: choices([1, '1x'], [1.25, '1.25x'], [1.5, '1.5x'], [2, '2x'], [3, '3x']), get: speed.get, set: v => speed.set(Number(v)) } },
        { id: 'ffEnabled', tab: 'general', group: 'Speed', label: 'Hold F to fast-forward', help: 'Hold the F key to temporarily speed the game up. Handy for walking back across a map or repeating battles.', default: true, keywords: 'turbo skip',
          control: { type: 'toggle', get: ffOn.get, set: ffOn.set } },
        { id: 'ffSpeed', tab: 'general', group: 'Speed', label: 'Fast-forward speed', default: 3,
          visible: () => ffOn.get(), control: { type: 'choice', options: choices([2, '2x'], [3, '3x'], [4, '4x'], [8, '8x']), get: ffSpeed.get, set: v => ffSpeed.set(Number(v)) } },
        { id: 'skipSplash', tab: 'general', group: 'Startup', label: 'Skip intro screens', help: 'Skip the startup logos on launch. This also skips the content warning shown at the start of the game.', default: false, keywords: 'splash warning logo startup',
          control: { type: 'toggle', get: splash.get, set: splash.set } },
        { id: 'warnOnLeave', tab: 'general', group: 'Safety', label: 'Warn before leaving mid-game', help: 'Ask for confirmation before closing or reloading the tab while exploring or in a battle.', default: true,
          control: { type: 'toggle', get: leave.get, set: leave.set } },

        // ---------------------------------------------------------- display
        { id: 'fullscreen', tab: 'display', group: 'Window', label: 'Fullscreen', default: false, keywords: 'window screen',
          control: { type: 'toggle', get: () => F.isFullscreen(), set: v => { C().fullScreen = v; F.setFullscreen(v); scheduleSave(); notify(); } } },
        { id: 'wide', tab: 'display', group: 'Window', label: 'Widescreen maps', help: 'Show more of the world at the sides on wide windows. Menus and battles always stay 4:3.', default: true, keywords: 'ultrawide aspect ratio',
          note: () => (g.SceneManager?._scene instanceof g.Scene_Map ? 'Applies on the next map you enter.' : undefined), control: { type: 'toggle', get: wide.get, set: wide.set } },
        { id: 'quality', tab: 'display', group: 'Picture', label: 'Render quality', help: 'Internal resolution. Higher is sharper but needs a stronger GPU. Automatic picks the best for your window.', default: 0, keywords: 'resolution supersampling performance',
          control: { type: 'choice', options: choices([0, 'Automatic'], [1, '1x'], [2, '2x'], [3, '3x'], [4, '4x']), get: quality.get, set: v => quality.set(Number(v)) } },
        { id: 'smooth', tab: 'display', group: 'Picture', label: 'Scaling', help: 'Smooth blends pixels when scaled; Sharp keeps hard pixel edges.', default: true, keywords: 'pixel filter nearest',
          control: { type: 'choice', options: choices(['smooth', 'Smooth'], ['sharp', 'Sharp pixels']), get: () => (smooth.get() ? 'smooth' : 'sharp'), set: v => smooth.set(v === 'smooth') } },
        { id: 'showFps', tab: 'display', group: 'Overlays', label: 'Show FPS counter', default: false, keywords: 'performance frame rate',
          control: { type: 'toggle', get: fps.get, set: fps.set } },
        { id: 'hideCursor', tab: 'display', group: 'Overlays', label: 'Hide idle mouse cursor', help: 'Hide the pointer two seconds after the mouse stops moving.', default: false,
          control: { type: 'toggle', get: cursor.get, set: cursor.set } },
        { id: 'screenshot', tab: 'display', group: 'Capture', label: 'Screenshot', help: `Save the current frame as a PNG. Shortcut: ${F.SCREENSHOT_KEY}.`, keywords: 'capture image png',
          control: { type: 'action', button: 'Take screenshot', run: () => F.screenshot() } },

        // ---------------------------------------------------------- audio
        ...(['bgm', 'bgs', 'me', 'se'] as const).map<Setting>((k, i) => ({
            id: `${k}Volume`, tab: 'audio', group: 'Volume', label: ['Music', 'Ambience', 'Musical effects', 'Sound effects'][i]!,
            help: ['Background music.', 'Background ambience and weather.', 'Jingles and short musical cues.', 'Sound effects and UI sounds.'][i], default: k === 'bgm' ? 70 : 90, keywords: 'sound loudness bgm bgs',
            control: { type: 'slider', min: 0, max: 100, step: 1, unit: '%', get: () => Number(C()[`${k}Volume`]), set: v => { C()[`${k}Volume`] = v; scheduleSave(); notify(); }, preview: k === 'se' ? sample : undefined },
        })),
        { id: 'onBlur', tab: 'audio', group: 'Background', label: 'When the tab loses focus', help: 'Pause is how the original game behaves. Mute keeps the world running silently; Keep playing leaves everything on.', default: 'pause', keywords: 'mute pause minimise alt-tab background focus',
          control: { type: 'choice', options: choices(['pause', 'Pause'], ['mute', 'Run muted'], ['keep', 'Keep playing']), get: blur.get, set: v => blur.set(String(v)) } },

        // ---------------------------------------------------------- controls
        { id: 'inputIcons', tab: 'controls', group: 'Prompts', label: 'Button prompts', help: 'Which icons the game shows for buttons. Automatic switches to match the device you last used.', default: 'keyboard', keywords: 'gamepad keyboard icons controller',
          control: { type: 'choice', options: choices(['keyboard', 'Keyboard'], ['gamepad', 'Gamepad'], ['auto', 'Automatic']),
              get: () => (autoIcons.get() ? 'auto' : C().gamepadTips ? 'gamepad' : 'keyboard'),
              set: v => { autoIcons.set(v === 'auto'); if (v !== 'auto') { C().gamepadTips = v === 'gamepad'; g.SceneManager?._scene?.refreshCommandHints?.(); scheduleSave(); } } } },
        { id: 'keys', tab: 'controls', group: 'Key bindings', label: 'Key bindings', keywords: 'rebind keyboard gamepad buttons remap', control: { type: 'keys' } },

        // ---------------------------------------------------------- accessibility
        { id: 'screenEffectsEnabled', tab: 'accessibility', group: 'Motion & flashing', label: 'Screen effects', help: 'Screen shake, blur, glow, waves and distortion during scenes and attacks.', default: false /* a fresh config reads a missing flag as off (MV readFlag), whatever the plugin parameter says */, keywords: 'shake photosensitive epilepsy motion',
          visible: () => C()?.screenEffectsEnabled !== undefined, control: { type: 'toggle', ...flag('screenEffectsEnabled') } },
        { id: 'screenEffectsIntensity', tab: 'accessibility', group: 'Motion & flashing', label: 'Screen effect strength', help: 'Lower this to soften shaking and distortion without turning it off.', default: snap('screenEffectsIntensity', 100), keywords: 'shake motion',
          visible: () => C()?.screenEffectsIntensity !== undefined, control: { type: 'slider', min: 5, max: 100, step: 5, unit: '%', ...num('screenEffectsIntensity') } },
        { id: 'TKMFilterEnabledAll', tab: 'accessibility', group: 'Motion & flashing', label: 'Visual filters', help: 'Colour and distortion filters used for atmosphere (including some horror scenes).', default: snap('TKMFilterEnabledAll', true), keywords: 'shader effects horror',
          visible: () => C()?.TKMFilterEnabledAll !== undefined, control: { type: 'toggle', ...flag('TKMFilterEnabledAll') } },
        { id: 'reduceMotion', tab: 'accessibility', group: 'Motion & flashing', label: 'Reduce flashing & motion', help: 'One click: turns off screen effects and visual filters and disables menu animations.', keywords: 'photosensitive epilepsy comfort',
          control: { type: 'action', button: 'Apply', run: a.reduceMotion } },

        // ---------------------------------------------------------- system
        { id: 'mods', tab: 'system', group: 'Mods & saves', label: 'Mods, profiles & save backups', help: 'Install mods, switch profiles (each has its own saves) and restore backups.', keywords: 'profile backup',
          control: { type: 'action', button: 'Open (F8)', run: a.openMods } },
        { id: 'loadGame', tab: 'system', group: 'Game', label: 'Load game', visible: inGame, control: { type: 'action', button: 'Load…', run: a.loadGame } },
        { id: 'toTitle', tab: 'system', group: 'Game', label: 'Return to title screen', help: 'Unsaved progress is lost.', visible: inGame, control: { type: 'action', button: 'Return to title', danger: true, run: a.toTitle } },
        { id: 'export', tab: 'system', group: 'Settings', label: 'Export settings', help: 'Save all settings, volumes and key bindings to a file to back them up or move them to another browser.',
          control: { type: 'action', button: 'Export…', run: a.exportSettings } },
        { id: 'import', tab: 'system', group: 'Settings', label: 'Import settings', control: { type: 'action', button: 'Import…', run: a.importSettings } },
        { id: 'resetAll', tab: 'system', group: 'Settings', label: 'Reset all settings', help: 'Restore every setting and key binding to its default. Saves are not touched.',
          control: { type: 'action', button: 'Reset all', danger: true, run: a.resetAll } },
        { id: 'diagnostics', tab: 'system', group: 'Support', label: 'Copy diagnostics', help: 'Copies version, graphics, mods and settings to the clipboard, useful when reporting a problem.', keywords: 'bug report debug info',
          control: { type: 'action', button: 'Copy', run: a.copyDiagnostics } },
    ];
    S.forEach(register);
}
