// The story model: what the game's own flags say about "where in the story" and "which route" a game state is.
// Everything here is keyed by the flags' NAMES in the game's database (data/System), not by number, and is pure
// (no game or browser globals), so it is unit-tested. The facts behind these lists are in docs/STORY-MODEL.md and
// can be regenerated from any install with `bun run mod routes`.
import type { Digest } from './checkpoint-core.ts';

/**
 * The authored story spine: one contiguous block of switches (ids 961-1059 in the Steam build) named
 * <Day|Sun|Ni><n><FA|DW> - <scene>: Day0DW-..., NiFA-..., SunFA1 - ..., Day2DW - Saved Basil?, Day3FA - ...
 * (FA = Faraway Town / the real world, DW = Dreamworld). Ordered by switch id = the order they were authored in.
 */
export const SPINE_SWITCH = /^(Day|Sun|Ni)\d*(FA|DW)\d*\s*-/;

/** Late-game phase switches (the part of the story after the spine, in and around Black Space). */
export const PHASE_FLAGS = ['[Basil Memories]', '[Something Battle]', '[Blackspace]', '[Stranger Battle]', '[Omori Battle]', "[Omori's Castle]", '[Final Memories]'];

/** Ending switches. Note `[True: Bad End]` is tested in many places but no event in the Steam build ever sets it. */
export const ENDING_FLAGS = ['[Neutral: Epilogue]', 'Mari [Neutral Epilogue]', '[True: Stab End]', '[True: Bad End]', '[Beat Boss Rush]'];

/** Variables that carry route state. */
export const ROUTE_COUNTERS = ['Ending Variable', 'World Value (WS/FA/DW/BS)', '[BS_NEUTRAL_PATH]', '[BS_TRUE_PATH]', 'Stab_Counter', 'BASIL_END', 'Save Menu Chapter'];

export const SAVED_BASIL = 'Day2DW - Saved Basil?';
const WORLDS = ['WS', 'FA', 'DW', 'BS'];   // from the variable's own name "World Value (WS/FA/DW/BS)"

export interface DbNames { switches: (string | null)[] | undefined; variables: (string | null)[] | undefined }

export interface Signature {
    /** the furthest spine beat that is ON (highest switch id), or null before the story starts */
    last: { id: number; name: string } | null;
    /** how many spine switches are ON */
    spineOn: number;
    phase: string[];
    endings: string[];
    /** route counters that are not zero, by name */
    counters: Record<string, number>;
    savedBasil: boolean;
    world: string | null;
}

export function signature(d: Digest, db: DbNames): Signature {
    const sn = db.switches ?? [], vn = db.variables ?? [];
    let last: Signature['last'] = null, spineOn = 0;
    const phase: string[] = [], endings: string[] = [];
    let savedBasil = false;
    for (const id of d.switches) {
        const n = sn[id] ?? '';
        if (SPINE_SWITCH.test(n)) { spineOn++; if (!last || id > last.id) last = { id, name: n.trim() }; }
        if (PHASE_FLAGS.includes(n)) phase.push(n);
        if (ENDING_FLAGS.includes(n)) endings.push(n);
        if (n === SAVED_BASIL) savedBasil = true;
    }
    const counters: Record<string, number> = {};
    let world: string | null = null;
    vn.forEach((n, id) => {
        if (!n || !ROUTE_COUNTERS.includes(n)) return;
        const v = d.variables[id];
        if (typeof v !== 'number' || !v) return;
        if (n.startsWith('World Value')) world = WORLDS[v] ?? String(v);
        else counters[n] = v;
    });
    return { last, spineOn, phase, endings, counters, savedBasil, world };
}

export type RouteLabel = 'true' | 'neutral' | 'undecided';

/**
 * Which route the flags say this state is on. Based only on the devs' own flag names:
 * `[True: ...]` endings or `[BS_TRUE_PATH]` progress mean the true route; `[Neutral: ...]` / `[BS_NEUTRAL_PATH]` the neutral one.
 * Before either has any progress it is 'undecided'.
 */
export function routeLabel(s: Signature): RouteLabel {
    if (s.endings.some(e => e.startsWith('[True')) || (s.counters['[BS_TRUE_PATH]'] ?? 0) > 0) return 'true';
    if (s.endings.some(e => /Neutral/.test(e)) || (s.counters['[BS_NEUTRAL_PATH]'] ?? 0) > 0) return 'neutral';
    return 'undecided';
}

/** Short human description, e.g. "Day2DW - Saved Basil? · true route · BS_TRUE_PATH 7". */
export function describe(s: Signature): string {
    const parts: string[] = [];
    parts.push(s.last ? s.last.name.replace(/\s*-\s*/, ' - ') : 'start');
    const r = routeLabel(s);
    if (r !== 'undecided') parts.push(`${r} route`);
    else if (s.savedBasil) parts.push('saved Basil');
    for (const k of ['[BS_TRUE_PATH]', '[BS_NEUTRAL_PATH]'] as const) if (s.counters[k]) parts.push(`${k.slice(1, -1)} ${s.counters[k]}`);
    if (s.endings.length) parts.push(s.endings.join(', '));
    return parts.join(' · ');
}

/**
 * Identity of a route line: two states with the same key made the same story decisions so far
 * (it ignores how far along the spine they are). Used to group a checkpoint library by route.
 */
export function routeKey(s: Signature): string {
    return JSON.stringify([routeLabel(s), s.savedBasil, s.counters['BASIL_END'] ?? 0, s.counters['Stab_Counter'] ?? 0, [...s.endings].sort()]);
}

/** Spine beats a library has captured vs the beats that actually can happen. */
export function coverage(recordedNames: Iterable<string>, settable: string[]): { recorded: number; total: number; missing: string[] } {
    const have = new Set([...recordedNames].map(n => n.replace(/^\[beat\]\s*/, '').trim()));
    const missing = settable.filter(n => !have.has(n.trim()));
    return { recorded: settable.length - missing.length, total: settable.length, missing };
}
