// Pure helpers that turn what the editor holds (tile overrides, a collision grid) into the map spec the compiler reads,
// and back. No DOM here, so it runs under `bun test` too (editor/spec.test.ts).
//
// Painted tiles are kept as `overrides`: { [layerName]: Map<cellIndex, { ts: 'FILE.json', local: n } | 'erase'> }.
// On save they become `paint` entries tagged "editor": true, so the next load can turn exactly those back into overrides
// and leave hand-written paint entries alone.

export const TILE = 32;
export const isCollisionLayer = name => /^collision$/i.test(name);
const stripJson = s => String(s).replace(/\.json$/i, '');

/** Friendly names for the game's layer names. */
export function layerLabel(name) {
    let m;
    if ((m = /^GROUND\s*-\s*(IV|V|I{1,3})$/i.exec(name))) return `Ground ${roman(m[1])}`;
    if ((m = /^ABOVE ALL\s*-\s*(IV|V|I{1,3})$/i.exec(name))) return `Above ${roman(m[1])}`;
    if ((m = /^same as character(?:\s*-\s*(IV|V|I{1,3}))?$/i.exec(name))) return m[1] ? `With characters ${roman(m[1])}` : 'With characters';
    if (isCollisionLayer(name)) return 'Walls';
    return name;
}
const roman = r => ({ I: 1, II: 2, III: 3, IV: 4, V: 5 })[r.toUpperCase()] ?? r;

export const newOverrides = () => ({});
export const setOverride = (ov, layer, idx, value) => {
    const m = (ov[layer] ??= new Map());
    if (value === undefined) m.delete(idx); else m.set(idx, value);
};
export const cloneOverrides = ov => Object.fromEntries(Object.entries(ov).map(([k, m]) => [k, new Map(m)]));
export const overrideCount = ov => Object.values(ov).reduce((n, m) => n + m.size, 0);

/** Forget every override inside a rectangle (used when a stamp is placed over painted tiles). */
export function clearOverridesIn(ov, w, rect) {
    const [rx, ry, rw, rh] = rect;
    for (const m of Object.values(ov)) for (const idx of [...m.keys()]) {
        const x = idx % w, y = Math.floor(idx / w);
        if (x >= rx && x < rx + rw && y >= ry && y < ry + rh) m.delete(idx);
    }
}

/** The map changed width: overrides are keyed by cell index, so re-key them for the new width and drop any that fall outside. */
export function remapOverrides(ov, oldW, newW, newH) {
  for (const [layer, m] of Object.entries(ov)) {
    const next = new Map();
    for (const [idx, v] of m) {
      const x = idx % oldW, y = Math.floor(idx / oldW);
      if (x < newW && y < newH) next.set(y * newW + x, v);
    }
    ov[layer] = next;
  }
}

/** Overrides -> `paint` entries. Horizontal runs of the same tileset become one row; equal rows stack into one grid. */
export function encodeOverrides(ov, w) {
    const out = [];
    for (const [layer, cells] of Object.entries(ov)) {
        if (!cells.size) continue;
        const sorted = [...cells.entries()].sort((a, b) => a[0] - b[0]);
        const runs = [];
        for (const [idx, v] of sorted) {
            const x = idx % w, y = Math.floor(idx / w);
            const kind = v === 'erase' ? 'erase' : v.ts;
            const last = runs[runs.length - 1];
            if (last && last.y === y && last.kind === kind && last.x + last.vals.length === x) last.vals.push(v === 'erase' ? 0 : v.local);
            else runs.push({ kind, x, y, vals: [v === 'erase' ? 0 : v.local] });
        }
        const open = new Map(); // `${kind}|${x}|${len}` -> block still growing downwards
        const blocks = [];
        for (const r of runs) {
            const key = `${r.kind}|${r.x}|${r.vals.length}`;
            const b = open.get(key);
            if (b && b.y + b.rows.length === r.y) b.rows.push(r.vals);
            else { const nb = { kind: r.kind, x: r.x, y: r.y, rows: [r.vals] }; blocks.push(nb); open.set(key, nb); }
        }
        for (const b of blocks) {
            if (b.kind === 'erase') out.push({ layer, erase: true, rect: [b.x, b.y, b.rows[0].length, b.rows.length], editor: true });
            else out.push({ layer, tileset: stripJson(b.kind), tiles: b.rows, at: [b.x, b.y], editor: true });
        }
    }
    return out;
}

/** `paint` entries -> { authored: entries the editor leaves alone, ov: overrides rebuilt from its own entries }. */
export function decodeOverrides(paint, w, tilesetSource = n => `${stripJson(n)}.json`) {
    const authored = [], ov = newOverrides();
    for (const p of paint ?? []) {
        if (!p || p.editor !== true) { authored.push(p); continue; }
        if (p.erase && Array.isArray(p.rect)) {
            const [rx, ry, rw, rh] = p.rect;
            for (let y = ry; y < ry + rh; y++) for (let x = rx; x < rx + rw; x++) setOverride(ov, p.layer, y * w + x, 'erase');
        } else if (p.tiles && p.tileset) {
            const [ax, ay] = p.at ?? [0, 0];
            p.tiles.forEach((row, dy) => row.forEach((t, dx) => { if (t !== null && t !== undefined) setOverride(ov, p.layer, (ay + dy) * w + ax + dx, { ts: tilesetSource(p.tileset), local: t }); }));
        } else authored.push(p);
    }
    return { authored, ov };
}

/** Spec `blocked` rows -> a w*h grid of characters ('#', '.', or ' ' = leave the stamped/base collision alone). */
export function blockedToGrid(rows, w, h) {
    const g = Array.from({ length: h }, () => new Array(w).fill(' '));
    (rows ?? []).forEach((row, y) => [...row].forEach((ch, x) => { if (y < h && x < w) g[y][x] = ch === '#' || ch === '.' ? ch : ' '; }));
    return g;
}
/** Grid -> rows with trailing blanks and trailing empty rows removed. */
export function gridToBlocked(grid) {
    const rows = grid.map(r => r.join('').replace(/ +$/, ''));
    while (rows.length && rows[rows.length - 1] === '') rows.pop();
    return rows;
}

/** The spec the compiler should get: the loaded spec with the editor's paint and collision folded in. */
export function toSpec(doc) {
    const spec = { ...doc.spec };
    const paint = [...doc.authoredPaint, ...encodeOverrides(doc.ov, doc.w)];
    if (paint.length) spec.paint = paint; else delete spec.paint;
    spec.blocked = gridToBlocked(doc.blocked);
    return spec;
}

/** Start a document from a spec read off disk. */
export function docFromSpec(spec, w, h) {
    const { authored, ov } = decodeOverrides(spec.paint, w);
    return { spec: { ...spec, paint: undefined }, authoredPaint: authored, ov, blocked: blockedToGrid(spec.blocked, w, h), w, h };
}

/** Next unused map id at or above 1000, given ids already taken. */
export function freeId(taken, from = 1000) {
    let id = from;
    while (taken.has(id)) id++;
    return id;
}
