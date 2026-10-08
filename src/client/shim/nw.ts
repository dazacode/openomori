// NW.js `nw` global, `process`, and the Steam stub.


export const processShim = {
    platform: 'win32',
    env: { LOCALAPPDATA: '/appdata/', HOME: '/home' } as Record<string, string>,
    mainModule: { filename: '/index.html' },
    versions: { node: '0.0.0', nw: '0.0.0' },
    argv: [] as string[],
    cwd: () => '/',
    on() {},
    nextTick: (fn: (...a: unknown[]) => void, ...args: unknown[]) => setTimeout(fn, 0, ...args),
};

const toggleFullscreen = (on: boolean) => {
    if (on) void document.documentElement.requestFullscreen?.().catch(() => {});
    else if (document.fullscreenElement) void document.exitFullscreen();
};

const windowShim = {
    x: 0, y: 0, width: innerWidth, height: innerHeight, menu: null,
    focus() {}, moveTo() {}, moveBy() {}, resizeBy() {}, resizeTo() {},
    showDevTools() {}, closeDevTools() {}, on() {}, close() {},
    isFullscreen: () => !!document.fullscreenElement,
    enterFullscreen: () => toggleFullscreen(true),
    leaveFullscreen: () => toggleFullscreen(false),
};

export const nw = {
    // argv[0] carries the AES key the game decrypts itself with (set by setGameKey, from the player's own install)
    App: { argv: [] as string[], quit() {}, closeAllWindows() {} },
    Window: { get: () => windowShim },
    Screen: { Init() {}, on() {}, screens: [{ bounds: { x: 0, y: 0, width: screen.width, height: screen.height } }] },
    Shell: { openExternal: (url: string) => window.open(url, '_blank') },
    Menu: function Menu() {},
};

/** The game reads its AES key from its command line (`--<key>`); the server finds it in the player's Launch_OMORI.bat. */
export function setGameKey(key: string) { nw.App.argv.length = 0; nw.App.argv.push('--' + key); }

/** Offline Steamworks. The game refuses to boot unless initAPI() reports success; nothing else is real. */
export const greenworks = {
    initAPI: () => true,
    getAchievement: (_n: string, cb?: (v: boolean) => void) => cb?.(false),
    activateAchievement: (_n: string, ok?: () => void) => ok?.(),
    clearAchievement: (_n: string, ok?: () => void) => ok?.(),
    getNumberOfAchievements: () => 0,
    getAchievementNames: () => [] as string[],
    getCurrentGameLanguage: () => 'english',
    isGameOverlayEnabled: () => false,
    isCloudEnabled: () => false,
    isCloudEnabledForUser: () => false,
    enableCloud() {},
    getSteamId: () => ({ accountId: 0, steamId: '0', screenName: 'local' }),
    getNumberOfPlayers: (cb?: (n: number) => void) => cb?.(1),
    saveTextToFile: (_f: string, _c: string, ok?: () => void) => ok?.(),
    readTextFromFile: (_f: string, _ok: unknown, err?: (e: Error) => void) => err?.(new Error('no cloud')),
    getCloudQuota: (cb?: (a: number, b: number) => void) => cb?.(0, 0),
    activateGameOverlay() {},
    activateGameOverlayToWebPage() {},
};
