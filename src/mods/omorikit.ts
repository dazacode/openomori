// Checks for OMORI dialogue, text codes, sprite names and plugin usage. Pure: no file access (see omorikit-node.ts).
// What the game does with these is documented in the omori-modding skill (references/formats.md).
import yaml from 'js-yaml';

export type Finding = { level: 'error' | 'warn' | 'info'; file: string; message: string };

/** Single-character codes: \! wait for a press, \. quarter-second pause, \| one second, \{ \} text size, \^ no pause, \< \> instant text. */
export const PUNCT_CODES = new Set(['!', '.', '|', '{', '}', '^', '<', '>', '$', '\\']);
/** Word codes that take a bracket argument or stand alone. Macros (names like \kel) come from the game's plugin table. */

export type Macros = Map<string, string>;

/** Every \code in a message's text. `word` is the letters (or the punctuation char), `arg` the bracket argument if any. */
export function textCodes(text: string): { code: string; word: string; arg?: string }[] {
    const out: { code: string; word: string; arg?: string }[] = [];
    for (const m of text.matchAll(/\\(?:([!.|{}^<>$\\])|([A-Za-z]+)(\[[^\]\n]*\])?)/g)) {
        if (m[1]) out.push({ code: m[0], word: m[1] });
        else out.push({ code: m[0], word: m[2]!, arg: m[3] });
    }
    return out;
}

/** Is this word code one the game understands? A macro may be followed by text with no space (\kelHey, \marIt). */
export function knownWord(word: string, arg: string | undefined, macros: Macros, extra: Set<string> = new Set()): boolean {
    const w = word.toLowerCase();
    if (extra.has(w)) return true;                                     // codes the game's own plugins handle (\DII, \ITEMGET ...)
    if (w === 'n') return true;                                        // \n<NAME> speaker tag, and \n[n] actor name
    if (['c', 'i', 'v', 'p', 'g', 'com', 'sinv', 'sinh', 'quake', 'rainbow'].includes(w)) return arg !== undefined;
    for (const name of macros.keys()) if (w.startsWith(name.toLowerCase())) return true;
    return false;
}

/** A dialogue file: `message_N` entries with text, optional faceset/faceindex. Returns the parsed map and any YAML errors. */
export function parseDialogue(source: string, file: string): { doc: Record<string, any> | null; findings: Finding[] } {
    try {
        const doc = yaml.load(source);
        if (doc !== null && (typeof doc !== 'object' || Array.isArray(doc))) return { doc: null, findings: [{ level: 'error', file, message: 'top level must be a mapping of message keys' }] };
        return { doc: (doc as Record<string, any>) ?? {}, findings: [] };
    } catch (e) {
        const msg = (e as Error).message.split('\n')[0]!;
        const hint = /unknown escape sequence/.test(msg)
            ? ' Inside double quotes a single backslash is an escape: write text codes as \\\\! (two backslashes) or use single quotes.'
            : '';
        return { doc: null, findings: [{ level: 'error', file, message: `YAML: ${msg}.${hint}` }] };
    }
}

/** Lint one parsed dialogue file. `faceExists` says whether a portrait name resolves to a real image. */
export function lintDialogue(doc: Record<string, any>, file: string, opts: { macros: Macros; extraCodes?: Set<string>; faceExists: (name: string) => boolean }): Finding[] {
    const out: Finding[] = [];
    const add = (level: Finding['level'], key: string, message: string) => out.push({ level, file, message: `${key}: ${message}` });
    for (const [key, entry] of Object.entries(doc)) {
        if (!/^[A-Za-z0-9_]+$/.test(key)) { add('warn', key, 'key has characters outside A-Z a-z 0-9 _ (ShowMessage cannot reference it)'); continue; }
        if (!/^message_\d+$/.test(key)) { add('info', key, 'not a message_N key (fine if something references it by name)'); }
        if (entry === null) { add('warn', key, 'empty entry'); continue; }
        if (typeof entry !== 'object' || Array.isArray(entry)) { add('error', key, 'entry must be a mapping with a text field'); continue; }
        const e = entry as Record<string, unknown>;
        if (!('text' in e)) add('error', key, 'missing text field');
        else if (e.text === null || e.text === '') add('warn', key, 'empty text');
        else if (typeof e.text !== 'string') add('error', key, 'text must be a string');
        else {
            for (const tell of styleTells(e.text as string)) add('warn', key, `style: "${tell}" is a phrase machine text over-uses; read the line aloud and rewrite it in this character's voice (anti-slop.md)`);
            for (const c of textCodes(e.text as string)) {
                if (c.word.length === 1 && PUNCT_CODES.has(c.word)) continue;
                if (!knownWord(c.word, c.arg, opts.macros, opts.extraCodes)) add('warn', key, `unknown text code ${c.code} (check the game's macro list with \`mod macros\`)`);
        }
        }
        const hasFace = 'faceset' in e, hasIndex = 'faceindex' in e;
        if (hasFace !== hasIndex) add('warn', key, 'faceset and faceindex must be given together');
        if (hasIndex && !(Number.isInteger(e.faceindex) && (e.faceindex as number) >= 0)) add('error', key, `faceindex must be a whole number from 0 (got ${JSON.stringify(e.faceindex)})`);
        if (hasFace && typeof e.faceset === 'string' && !opts.faceExists(e.faceset)) add('warn', key, `faceset ${e.faceset} is not in img/faces (game or mod)`);
        // background: 0 window, 1 dim, 2 transparent. position and positionType: 0 top, 1 middle, 2 bottom (YEP Message Core, as the game uses them).
        for (const k of ['background', 'position', 'positionType']) if (k in e && !(Number.isInteger(e[k]) && (e[k] as number) >= 0 && (e[k] as number) <= 2)) add('error', key, `${k} must be 0, 1 or 2 (got ${JSON.stringify(e[k])})`);
        for (const k of Object.keys(e)) if (!['text', 'faceset', 'faceindex', 'background', 'position', 'positionType'].includes(k)) add('info', key, `field ${k} is not one the lint knows (the game may still read it)`);
    }
    return out;
}

/** Upper-case case labels in the game's text handler (`case 'DII':`), lower-cased, plus \fn (seen in dialogue, not defined in the plugins). */
export function pluginCodes(pluginSource: string): Set<string> {
    const out = new Set<string>(['fn']);
    for (const m of pluginSource.matchAll(/case '([A-Z][A-Z0-9]+)':/g)) out.add(m[1]!.toLowerCase());
    return out;
}

/** Plugin macros (\kel, \bas ...) from js/plugins.js. The file is `var $plugins = [ {...}, ... ]`. */
export function parseMacros(pluginsJs: string): Macros {
    const macros: Macros = new Map();
    const start = pluginsJs.indexOf('[', pluginsJs.indexOf('$plugins'));
    const end = pluginsJs.lastIndexOf(']');
    if (start < 0 || end < start) return macros;
    let list: { name: string; parameters?: Record<string, string> }[];
    try { list = JSON.parse(pluginsJs.slice(start, end + 1)); } catch { return macros; }
    for (const p of list) {
        if (!/^YEP_X_MessageMacros\d+$/.test(p.name)) continue;
        for (const [k, v] of Object.entries(p.parameters ?? {})) {
            const m = k.match(/^Macro (\d+) Name$/);
            if (!m || !v || v === 'undefined') continue;
            const text = p.parameters![`Macro ${m[1]} Text`];
            if (text && text !== 'undefined') macros.set(v, text);
        }
    }
    return macros;
}

/** `ShowMessage file.key` references in any text (events, patches, scripts). */
export function showMessageRefs(text: string): { file: string; key: string }[] {
    return [...text.matchAll(/ShowMessage\s+([A-Za-z0-9_]+)\.([A-Za-z0-9_]+)/g)].map(m => ({ file: m[1]!, key: m[2]! }));
}

/** Sprite file name checks: $ (one character), ! (no offset), [SF] (single image), %(n) (n frames across). */
export function lintSpriteName(fileName: string, dims?: { width: number; height: number }): Finding[] {
    const out: Finding[] = [];
    const add = (level: Finding['level'], message: string) => out.push({ level, file: fileName, message });
    let base = fileName.replace(/\.(png|rpgmvp)$/i, '');
    const frames = base.match(/%\((.*?)\)$/);
    if (frames) {
        base = base.slice(0, frames.index);
        if (!/^\d+$/.test(frames[1]!) || Number(frames[1]) < 1) add('error', `frame count %(${frames[1]}) must be a positive whole number`);
        else if (dims && dims.width % Number(frames[1]) !== 0) add('warn', `width ${dims.width} does not divide into ${frames[1]} frames`);
    } else if (/%/.test(base)) add('warn', 'a % marker without the %(n) frame form');
    while (/^(\$|!|\[SF\])/i.test(base)) base = base.replace(/^(\$|!|\[SF\])/i, '');
    if (/[\[\]()$!%]/.test(base)) add('warn', `unrecognised marker in name (${base})`);
    return out;
}

/** Plugin commands (code 356) and script calls (code 355) found in a list of event commands. */
export function usageOf(lists: { code: number; parameters: any[] }[][]): { plugin: Map<string, { count: number; sample: string }>; script: Map<string, number>; codes: Map<number, number> } {
    const plugin = new Map<string, { count: number; sample: string }>();
    const script = new Map<string, number>();
    const codes = new Map<number, number>();
    const visit = (cmds: any[]) => {
        for (const c of cmds ?? []) {
            if (!c || typeof c !== 'object') continue;
            codes.set(c.code, (codes.get(c.code) ?? 0) + 1);
            if (c.code === 356) {
                const line = String(c.parameters?.[0] ?? '').trim();
                const k = line.split(/\s+/)[0] ?? '';
                const prev = plugin.get(k);
                plugin.set(k, { count: (prev?.count ?? 0) + 1, sample: prev?.sample ?? line.slice(0, 80) });
            }
            if (c.code === 355) {
                const head = String(c.parameters?.[0] ?? '').trim().replace(/\d+/g, 'N').slice(0, 60);
                script.set(head, (script.get(head) ?? 0) + 1);
            }
            for (const p of c.parameters ?? []) if (Array.isArray(p)) visit(p);
        }
    };
    for (const l of lists) visit(l);
    return { plugin, script, codes };
}

/** RPG Maker MV event command codes (standard MV table), for labelling `mod commands` output. */
export const EVENT_NAMES: Record<number, string> = {
    0: 'list end', 101: 'show text', 401: 'show text line', 102: 'show choices', 402: 'choice when', 403: 'choice cancel', 404: 'choices end',
    105: 'scrolling text', 108: 'comment', 408: 'comment line', 111: 'if (conditional)', 411: 'else', 412: 'branch end', 112: 'loop', 413: 'repeat',
    113: 'break loop', 115: 'exit event', 117: 'common event', 118: 'label', 119: 'jump to label', 121: 'control switches', 122: 'control variables',
    123: 'control self switch', 201: 'transfer player', 203: 'set event location', 205: 'set movement route', 505: 'movement command line',
    211: 'change transparency', 212: 'show animation', 214: 'erase event', 221: 'fadeout screen', 222: 'fadein screen', 223: 'tint screen',
    225: 'shake screen', 230: 'wait', 231: 'show picture', 232: 'move picture', 235: 'erase picture', 241: 'play bgm', 242: 'fadeout bgm',
    250: 'play se', 301: 'battle processing', 302: 'shop processing', 303: 'name input', 313: 'change state', 355: 'script', 655: 'script line',
    356: 'plugin command',
};

/** Words and phrases that machine-written text over-uses (Wikipedia's "Signs of AI writing" list, as reported in search results).
 *  A signal to read the line again, not proof: human writers use these too, and the list goes stale. */
export const SLOP_WORDS = ['delve', 'intricate', 'tapestry', 'pivotal', 'underscore', 'landscape', 'foster', 'testament', 'enhance', 'crucial'];
export const SLOP_PHRASES = ['it is important to note', "it's important to note", "in today's fast-paced", 'in the realm of', 'a symphony of', 'embark on a journey', 'a testament to'];

/** Style warnings for dialogue text. Returns the phrases found, each once. */
export function styleTells(text: string): string[] {
    const t = text.toLowerCase().replace(/\\[a-z]+(\[[^\]]*\])?|\\[!.|{}^<>$\\]/g, ' ');   // ignore text codes
    const hits = new Set<string>();
    for (const w of SLOP_WORDS) if (new RegExp(`\\b${w}\\b`).test(t)) hits.add(w);
    for (const p of SLOP_PHRASES) if (t.includes(p)) hits.add(p);
    return [...hits];
}
