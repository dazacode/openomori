// Pure, game-free half of the checkpoint system: a readable "digest" of story state and the diff between two
// digests. Kept free of browser/game globals so it can be unit-tested with `bun test`.

export interface Digest {
    switches: number[];                         // ids that are ON
    variables: Record<number, unknown>;         // non-zero / non-empty only
    selfSwitches: Record<string, boolean>;      // "mapId,eventId,A" -> true
    selfVariables: Record<string, unknown>;
    gold: number;
    items: Record<number, number>;
    weapons: Record<number, number>;
    armors: Record<number, number>;
    party: number[];                            // actor ids, in order
    levels: Record<number, number>;
    map: { id: number; x: number; y: number };
}

export interface Change { section: string; key: string; from: unknown; to: unknown }

const empty = (v: unknown) => v === undefined || v === null || v === 0 || v === '' || v === false;

const sparse = (data: unknown): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    if (Array.isArray(data)) data.forEach((v, i) => { if (!empty(v)) out[i] = v; });
    else if (data && typeof data === 'object') for (const [k, v] of Object.entries(data)) if (!empty(v)) out[k] = v;
    return out;
};
const counts = (o: unknown): Record<number, number> => {
    const out: Record<number, number> = {};
    for (const [k, v] of Object.entries((o ?? {}) as Record<string, number>)) if (v) out[Number(k)] = v;
    return out;
};

/** Minimal structural view of the game objects a digest reads (all optional: a half-started game must not throw). */
export interface GameLike {
    $gameSwitches?: { _data?: unknown };
    $gameVariables?: { _data?: unknown };
    $gameSelfSwitches?: { _data?: unknown };
    $gameSelfVariables?: { _data?: unknown };
    $gameParty?: { _gold?: number; _items?: unknown; _weapons?: unknown; _armors?: unknown; _actors?: number[] };
    $gameActors?: { _data?: ({ _level?: number } | null | undefined)[] };
    $gameMap?: { _mapId?: number };
    $gamePlayer?: { _x?: number; _y?: number };
}

export function makeDigest(g: GameLike): Digest {
    const levels: Record<number, number> = {};
    (g.$gameActors?._data ?? []).forEach((a, i) => { if (a && typeof a._level === 'number') levels[i] = a._level; });
    return {
        switches: Object.keys(sparse(g.$gameSwitches?._data)).map(Number),
        variables: Object.fromEntries(Object.entries(sparse(g.$gameVariables?._data)).map(([k, v]) => [Number(k), v])),
        selfSwitches: sparse(g.$gameSelfSwitches?._data) as Record<string, boolean>,
        selfVariables: sparse(g.$gameSelfVariables?._data),
        gold: g.$gameParty?._gold ?? 0,
        items: counts(g.$gameParty?._items),
        weapons: counts(g.$gameParty?._weapons),
        armors: counts(g.$gameParty?._armors),
        party: [...(g.$gameParty?._actors ?? [])],
        levels,
        map: { id: g.$gameMap?._mapId ?? 0, x: g.$gamePlayer?._x ?? 0, y: g.$gamePlayer?._y ?? 0 },
    };
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function diffRecord(section: string, a: Record<string, unknown>, b: Record<string, unknown>, out: Change[]) {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
        if (!same(a[k], b[k])) out.push({ section, key: k, from: a[k] ?? null, to: b[k] ?? null });
    }
}

/** Everything that differs going from `a` to `b`. */
export function diffDigests(a: Digest, b: Digest): Change[] {
    const out: Change[] = [];
    const A = new Set(a.switches), B = new Set(b.switches);
    for (const id of new Set([...A, ...B])) if (A.has(id) !== B.has(id)) out.push({ section: 'switch', key: String(id), from: A.has(id), to: B.has(id) });
    diffRecord('variable', a.variables, b.variables, out);
    diffRecord('selfSwitch', a.selfSwitches, b.selfSwitches, out);
    diffRecord('selfVariable', a.selfVariables, b.selfVariables, out);
    diffRecord('item', a.items, b.items, out);
    diffRecord('weapon', a.weapons, b.weapons, out);
    diffRecord('armor', a.armors, b.armors, out);
    diffRecord('level', a.levels, b.levels, out);
    if (a.gold !== b.gold) out.push({ section: 'gold', key: '', from: a.gold, to: b.gold });
    if (!same(a.party, b.party)) out.push({ section: 'party', key: '', from: a.party, to: b.party });
    if (!same(a.map, b.map)) out.push({ section: 'location', key: '', from: a.map, to: b.map });
    return out;
}

export interface Names {
    switches?: (string | null)[]; variables?: (string | null)[];
    items?: ({ name?: string } | null)[]; weapons?: ({ name?: string } | null)[]; armors?: ({ name?: string } | null)[];
}

/** One human line per change, using database names when available. */
export function describeChange(c: Change, n: Names = {}): string {
    const nm = (list: readonly unknown[] | undefined, id: string) => {
        const e = list?.[Number(id)];
        const s = typeof e === 'string' ? e : (e as { name?: string } | null | undefined)?.name;
        return s ? ` ${s}` : '';
    };
    const v = (x: unknown) => (x === null || x === undefined ? 'none' : typeof x === 'object' ? JSON.stringify(x) : String(x));
    switch (c.section) {
        case 'switch': return `switch ${c.key}${nm(n.switches, c.key)}: ${c.to ? 'ON' : 'off'}`;
        case 'variable': return `variable ${c.key}${nm(n.variables, c.key)}: ${v(c.from)} -> ${v(c.to)}`;
        case 'item': return `item ${c.key}${nm(n.items, c.key)}: ${v(c.from)} -> ${v(c.to)}`;
        case 'weapon': return `weapon ${c.key}${nm(n.weapons, c.key)}: ${v(c.from)} -> ${v(c.to)}`;
        case 'armor': return `armor ${c.key}${nm(n.armors, c.key)}: ${v(c.from)} -> ${v(c.to)}`;
        default: return `${c.section}${c.key ? ' ' + c.key : ''}: ${v(c.from)} -> ${v(c.to)}`;
    }
}
