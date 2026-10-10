// Where Chrome is, for the puppeteer tests and the screenshot scripts. Set CHROME to use another browser binary.
const DEFAULTS: Record<string, string> = {
    win32: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    darwin: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    linux: '/usr/bin/google-chrome',
};
export const CHROME = process.env.CHROME ?? DEFAULTS[process.platform] ?? DEFAULTS.win32!;
/** Chrome's GPU backend: Direct3D exists only on Windows; macOS uses Metal. */
export const ANGLE = `--use-angle=${process.platform === 'win32' ? 'd3d11' : process.platform === 'darwin' ? 'metal' : 'default'}`;
