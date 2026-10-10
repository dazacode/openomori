// Where the player's OMORI install is, and the key its launcher passes to decrypt game data.
//
// This project ships no game files. The folder is found, in order, from:
//   1. the OMORI_DIR environment variable
//   2. .omori-dir, written the first time you point the tools at your install (git-ignored)
//   3. a folder named OMORI* next to this project (handy for development)
// If none of those is a valid install, `ensureGameDir()` asks for the path (server and CLI call it on start-up).
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export const ROOT = resolve(import.meta.dir, '..');
const SAVED = join(ROOT, '.omori-dir');

/** A usable install has www/ with the encrypted game data (www/data and www/js). */
export const isGameDir = (dir: string) => existsSync(join(dir, 'www', 'data')) && existsSync(join(dir, 'www', 'js'));

/** Accepts the install folder, its www/ folder, a quoted path, or a path with a trailing slash. On macOS and Linux it
 *  also takes what a terminal gives you when you drag a folder in (`/Users/me/My\\ Games/OMORI`) and `~/...`. */
export function normalizeGameDir(input: string, platform: string = process.platform): string {
    let p = input.trim().replace(/^["']|["']$/g, '');
    if (platform !== 'win32') {
        p = p.replace(/\\(.)/g, '$1');                                   // shell escapes: "\ " -> " "
        if (p === '~' || p.startsWith('~/')) p = join(homedir(), p.slice(1));
    }
    p = resolve(p);
    return /[\\/]www$/i.test(p) ? resolve(p, '..') : p;
}

function findSilently(): string | null {
    const tries: string[] = [];
    if (process.env.OMORI_DIR) tries.push(normalizeGameDir(process.env.OMORI_DIR));
    try { tries.push(normalizeGameDir(readFileSync(SAVED, 'utf8'))); } catch { /* not saved yet */ }
    try { for (const f of readdirSync(resolve(ROOT, '..')).sort()) if (/^OMORI/i.test(f)) tries.push(resolve(ROOT, '..', f)); } catch { /* no parent access */ }
    return tries.find(isGameDir) ?? null;
}

// Live bindings: importers see the updated values after ensureGameDir().
export let GAME_DIR: string = findSilently() ?? resolve(process.env.OMORI_DIR ?? resolve(ROOT, '..', 'OMORI'));
export let WWW: string = join(GAME_DIR, 'www');

/**
 * Make sure GAME_DIR is a real install, asking the player once if not. Returns false (after saying why) when it cannot,
 * for example when there is no terminal to ask on.
 */
export function ensureGameDir(): boolean {
    if (isGameDir(GAME_DIR)) return true;
    console.error('\nOMORI folder not found. This project does not include the game: you need your own copy.');
    if (!process.stdin.isTTY) {
        console.error('Set the OMORI_DIR environment variable to the folder that contains OMORI.exe and www/, or run this from a terminal to be asked.');
        return false;
    }
    for (let attempt = 0; attempt < 5; attempt++) {
        const answer = prompt('Path to your OMORI folder (the one with OMORI.exe and www; you can drag it into this window):');
        if (!answer) break;
        const dir = normalizeGameDir(answer);
        if (isGameDir(dir)) {
            GAME_DIR = dir; WWW = join(dir, 'www');
            try { writeFileSync(SAVED, dir + '\n'); console.log(`Remembered in ${SAVED}`); } catch { /* read-only checkout: ask again next time */ }
            return true;
        }
        console.error(`That is not an OMORI install: ${dir} has no www/data and www/js.`);
    }
    return false;
}

/** The game decrypts itself with a key passed on its command line; the launcher bat holds it. */
export function readGameKey(): string | null {
    const bat = join(GAME_DIR, 'Launch_OMORI.bat');
    try {
        const key = /--([0-9a-f]{32})/i.exec(readFileSync(bat, 'utf8'))?.[1];
        if (!key) console.error(`no 32-char key found in ${bat}`);
        return key ?? null;
    } catch (e) {
        console.error(`cannot read ${bat}: ${(e as Error).message} (point the tools at your OMORI folder: set OMORI_DIR, or delete ${SAVED} and start again)`);
        return null;
    }
}
