// The editor's state, undo history and every operation on the map document.
// The document is a map spec (the file on disk) plus two things the editor owns: tile overrides and a collision grid.
// What you SEE is the compiler's own output (asked for through /preview), so the canvas never disagrees with the game.
import { api } from './api.js';
import { TILE, clearOverridesIn, cloneOverrides, docFromSpec, isCollisionLayer, remapOverrides, setOverride, toSpec } from './spec.js';
import { clone, debounce, toast } from './util.js';

// ------------------------------------------------------------ events (a tiny bus)
const listeners = {};
export const on = (ev, fn) => { (listeners[ev] ??= []).push(fn); return fn; };
export const emit = (ev, ...a) => (listeners[ev] ?? []).forEach(f => f(...a));

export const S = {
  mods: [], mod: null,                 // mod folder name
  gameMaps: [], tilesets: {}, sprites: [], names: { switches: [], variables: [], common: [], items: [] },
  doc: null,
  tool: 'brush', layer: 'GROUND - I',
  vis: {},                              // layer name -> visible (default true)
  show: { grid: true, walls: true, events: true, dim: false, ruler: false, edits: false },
  pal: { ts: null, x: 0, y: 0, w: 1, h: 1 },    // selected block of tiles in a tileset
  stamp: null,                          // { map, name, rect:[x,y,w,h], tiled, defs }
  library: { pieces: [], templates: [], mine: [] },
  selEvent: -1,
  problems: { errors: [], warnings: [] },
  busy: 0, dirty: false,
};

// ------------------------------------------------------------ images
const imgs = new Map();
export function getImage(kind, name) {
  if (!name) return null;
  const key = `${kind}/${name}`;
  let e = imgs.get(key);
  if (!e) {
    const img = new Image();
    e = { img, ok: false, bad: false };
    img.onload = () => { e.ok = true; emit('image'); };
    img.onerror = () => { e.bad = true; };
    img.src = api.imgUrl(kind, name, S.mod);
    imgs.set(key, e);
  }
  return e.ok ? e.img : null;
}
export const dropImages = () => imgs.clear();
/** How many images are still on their way (a screenshot waits for 0). */
export const imagesPending = () => [...imgs.values()].filter(e => !e.ok && !e.bad).length;

// ------------------------------------------------------------ tileset lookup
export const tsDef = source => S.doc?.defs?.[source] ?? S.tilesets[source] ?? null;
/** The map's own spelling of a tileset name (the game ignores case, so FA_Interior and FA_INTERIOR are one file). */
export const canonTs = source => S.doc?.tiled.tilesets.find(t => t.source.toLowerCase() === source.toLowerCase())?.source ?? source;
export const tsName = source => String(source).replace(/\.json$/i, '');

/** gid -> { source, local, def } for any Tiled map, memoised per map object. */
const lookups = new WeakMap();
export function resolver(tiled, defs) {
  let c = lookups.get(tiled);
  if (!c || c.n !== tiled.tilesets.length) {
    const sets = [...tiled.tilesets].sort((a, b) => a.firstgid - b.firstgid);
    c = { n: tiled.tilesets.length, sets, cache: new Map() };
    lookups.set(tiled, c);
  }
  return gid => {
    if (!gid) return null;
    let hit = c.cache.get(gid);
    if (hit !== undefined) return hit;
    let lo = 0, hi = c.sets.length - 1, found = null;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (c.sets[mid].firstgid <= gid) { found = c.sets[mid]; lo = mid + 1; } else hi = mid - 1; }
    const def = found && (defs?.[found.source] ?? S.tilesets[found.source]);
    hit = found && def ? { source: found.source, local: gid - found.firstgid, def } : null;
    c.cache.set(gid, hit);
    return hit;
  };
}

/** The first gid of a tileset in the open map, adding it (same rule as the compiler) when the map does not use it yet. */
function gidFor(source) {
  const t = S.doc.tiled;
  const have = t.tilesets.find(x => x.source === source);
  if (have) return have.firstgid;
  const next = Math.max(1, ...t.tilesets.map(x => x.firstgid + (tsDef(x.source)?.tilecount ?? 1024)));
  t.tilesets.push({ firstgid: next, source });
  S.doc.defs[source] = S.doc.defs[source] ?? S.tilesets[source];
  return next;
}
export const collisionGid = () => S.doc.tiled.tilesets.find(t => /Tile_Collisions/i.test(t.source ?? ''))?.firstgid ?? 0;
export const tileLayers = () => (S.doc?.tiled.layers ?? []).filter(l => l.type === 'tilelayer' && !isCollisionLayer(l.name));
const layerData = name => S.doc.tiled.layers.find(l => l.name === name && l.type === 'tilelayer')?.data;
export const inMap = (x, y) => !!S.doc && x >= 0 && y >= 0 && x < S.doc.w && y < S.doc.h;

// ------------------------------------------------------------ history
const undoStack = [], redoStack = [];
const MAX_HISTORY = 300;
let lastCoalesce = { key: null, at: 0 };
const pushHistory = entry => {
  undoStack.push(entry); if (undoStack.length > MAX_HISTORY) undoStack.shift();
  redoStack.length = 0; markDirty(); emit('history');
};
export const canUndo = () => undoStack.length > 0;
export const canRedo = () => redoStack.length > 0;
function markDirty(v = true) { S.dirty = v; emit('dirty'); }

const snapshot = () => ({ spec: clone(S.doc.spec), authored: clone(S.doc.authoredPaint), ov: cloneOverrides(S.doc.ov), blocked: S.doc.blocked.map(r => r.slice()), w: S.doc.w, h: S.doc.h });
function restore(s) {
  const d = S.doc;
  d.spec = clone(s.spec); d.authoredPaint = clone(s.authored); d.ov = cloneOverrides(s.ov); d.blocked = s.blocked.map(r => r.slice()); d.w = s.w; d.h = s.h;
}
const refGid = r => (r ? gidFor(r.ts) + r.local : 0);
function applyCells(changes, forward) {
  for (const c of changes) {
    if (c.k === 'tile') {
      const data = layerData(c.layer);
      if (!data) continue;
      data[c.idx] = refGid(forward ? c.next : c.prev);
      setOverride(S.doc.ov, c.layer, c.idx, forward ? c.nextOv : c.prevOv);
    } else {
      const col = S.doc.tiled.layers.find(l => isCollisionLayer(l.name));
      const on = forward ? c.next : c.prev;
      if (col) col.data[c.idx] = on ? collisionGid() : 0;
      S.doc.blocked[Math.floor(c.idx / S.doc.w)][c.idx % S.doc.w] = forward ? c.nextCh : c.prevCh;
    }
  }
}
export function undo() {
  const e = undoStack.pop(); if (!e) return;
  redoStack.push(e);
  if (e.type === 'cells') { applyCells(e.changes, false); settle(false); } else { e.after ??= snapshot(); restore(e.before); settle(true); }
}
export function redo() {
  const e = redoStack.pop(); if (!e) return;
  undoStack.push(e);
  if (e.type === 'cells') { applyCells(e.changes, true); settle(false); } else { restore(e.after); settle(true); }
}
function settle(grid) { lastCoalesce = { key: null, at: 0 }; markDirty(); emit('history'); emit('doc'); if (S.selEvent >= (S.doc.spec.events?.length ?? 0)) S.selEvent = -1; grid ? refresh() : validate(); }

// ------------------------------------------------------------ talking to the compiler
let gridGen = 0, editGen = 0;
const busy = d => { S.busy += d; emit('busy'); };

function adopt(r, withGrid) {
  S.problems = { errors: r.errors ?? [], warnings: r.warnings ?? [] };
  if (withGrid && r.tiled) {
    const d = S.doc;
    if (r.tiled.width !== d.w) remapOverrides(d.ov, d.w, r.tiled.width, r.tiled.height);   // overrides are keyed by cell index
    d.tiled = r.tiled; d.w = r.tiled.width; d.h = r.tiled.height;
    d.defs = { ...r.tilesetDefs };
    d.compiledEvents = r.events ?? [];
    // overrides and collision keep their shape if the map was resized
    d.blocked = resizeGrid(d.blocked, d.w, d.h);
  }
  emit('problems'); emit('doc');
}
const resizeGrid = (g, w, h) => Array.from({ length: h }, (_, y) => Array.from({ length: w }, (_, x) => g[y]?.[x] ?? ' '));

/** Re-ask the compiler and replace the picture with its answer. */
export async function refresh() {
  if (S.doc?.readonly) return;
  const my = ++gridGen; editGen++;
  busy(1);
  try {
    const r = await api.preview(S.mod, toSpec(S.doc));
    if (my === gridGen) adopt(r, true);
  } catch (e) { toast(e.message, 'bad'); } finally { busy(-1); }
}
/** Same question, but only to refresh the problem list (cheap edits that cannot change tiles). */
const validate = debounce(async () => {
  if (S.doc?.readonly) return;
  const my = ++editGen, g = gridGen;
  try {
    const r = await api.preview(S.mod, toSpec(S.doc));
    if (my === editGen && g === gridGen) adopt(r, false);
  } catch { /* the next edit retries */ }
}, 500);

// ------------------------------------------------------------ opening things
export async function loadStatics() {
  const [mods, gameMaps, tilesets, sprites, names] = await Promise.all([api.mods(), api.gameMaps(), api.tilesets(), api.sprites(), api.names()]);
  Object.assign(S, { mods, gameMaps, tilesets, sprites, names });
  emit('statics');
}
export async function loadLibrary() { S.library = await api.library(S.mod).catch(() => S.library); emit('library'); }
export const currentMod = () => S.mods.find(m => m.name === S.mod);
export async function reloadMods() { S.mods = await api.mods(); emit('mods'); }
export async function selectMod(name) {
  S.mod = name; S.doc = null; dropImages(); loadLibrary(); S.dirty = false; undoStack.length = 0; redoStack.length = 0; S.problems = { errors: [], warnings: [] };
  emit('mods'); emit('doc'); emit('history'); emit('problems'); emit('dirty');
}

export async function openMap(id, { keepView = false } = {}) {
  const spec = await api.spec(S.mod, id);
  const r = await api.preview(S.mod, spec);
  if (!r.tiled) throw new Error(r.errors?.[0] ?? 'This map does not compile yet.');
  // the events the map already had (the game's, or the scripts'): kept as they are, listed, movable, removable
  const base = spec.snapshot ? await api.snapshot(S.mod, id).catch(() => null) : spec.base !== undefined ? await api.gameMap(spec.base).catch(() => null) : null;
  const mtime = (await api.mtime(S.mod, id).catch(() => null))?.mtime ?? null;
  S.doc = {
    ...docFromSpec(spec, r.tiled.width, r.tiled.height),
    tiled: r.tiled, defs: { ...r.tilesetDefs }, compiledEvents: r.events ?? [],
    gameEvents: base?.events ?? [], id, mtime,
  };
  undoStack.length = 0; redoStack.length = 0; lastCoalesce = { key: null, at: 0 };
  S.selEvent = -1; S.dirty = false;
  if (!keepView) { S.layer = tileLayers()[0]?.name ?? 'GROUND - I'; S.vis = {}; }
  S.problems = { errors: r.errors ?? [], warnings: r.warnings ?? [] };
  emit('history'); emit('dirty'); emit('problems'); emit('doc'); emit('open', { keepView });
}

/** Open a finished map file that has no spec (made by the mod's scripts). Looking is safe; editing it would be overwritten by the next script run. */
export async function openBuilt(id) {
  const r = await api.built(S.mod, id);
  S.doc = {
    ...docFromSpec({ id, name: r.name }, r.tiled.width, r.tiled.height),
    tiled: r.tiled, defs: { ...r.tilesetDefs }, compiledEvents: [], gameEvents: r.events, id, readonly: true,
  };
  undoStack.length = 0; redoStack.length = 0; S.selEvent = -1; S.dirty = false; S.vis = {};
  S.layer = tileLayers()[0]?.name ?? 'GROUND - I';
  S.problems = { errors: [], warnings: [] };
  emit('history'); emit('dirty'); emit('problems'); emit('doc'); emit('open');
}

/** Look at any map of the game itself (read only): for choosing pieces to stamp, and for screenshots. */
export async function openGameView(id) {
  const r = await api.gameMap(id);
  S.doc = {
    ...docFromSpec({ id, name: r.name }, r.tiled.width, r.tiled.height),
    tiled: r.tiled, defs: { ...r.tilesetDefs }, compiledEvents: [], gameEvents: r.events, id, readonly: true, game: true,
  };
  undoStack.length = 0; redoStack.length = 0; S.selEvent = -1; S.dirty = false; S.vis = {};
  S.layer = tileLayers()[0]?.name ?? 'GROUND - I';
  S.problems = { errors: [], warnings: [] };
  emit('history'); emit('dirty'); emit('problems'); emit('doc'); emit('open');
}

export async function save() {
  if (!S.doc || S.doc.readonly) return false;
  await api.saveSpec(S.mod, S.doc.id, toSpec(S.doc));
  S.doc.mtime = (await api.mtime(S.mod, S.doc.id).catch(() => null))?.mtime ?? null;   // so our own save is not mistaken for someone else's edit
  markDirty(false);
  return true;
}
export async function build() {
  await save();
  const r = await api.build(S.mod);
  await reloadMods();
  return r;
}

// ------------------------------------------------------------ maps another tool builds
/** Hand a finished (script-built) map to the editor and open it for editing. */
export async function takeOver(id) {
  await api.takeover(S.mod, id);
  await reloadMods();
  await openMap(id);
}
/** Give a taken-over map back to the tool that builds it, dropping the editor's edits. */
export async function giveBack(id) {
  await api.release(S.mod, id);
  await reloadMods();
  S.doc = null; S.dirty = false; undoStack.length = 0; redoStack.length = 0; S.problems = { errors: [], warnings: [] };
  emit('doc'); emit('history'); emit('dirty'); emit('problems'); emit('mods');
}
export const basePos = e => S.doc?.spec.moveEvents?.[e.id] ?? [e.x, e.y];
/** Move one of the map's own events (kept with all its pages) to a new tile. */
export function moveBaseEvent(id, x, y) {
  if (!inMap(x, y)) return;
  const orig = S.doc.gameEvents.find(e => e && e.id === id);
  edit(d => {
    const m = (d.spec.moveEvents ??= {});
    if (orig && orig.x === x && orig.y === y) delete m[id]; else m[id] = [x, y];
    if (!Object.keys(m).length) delete d.spec.moveEvents;
  }, { coalesce: `mb${id}`, quiet: true });
}

// ------------------------------------------------------------ watching the files (another tool, or an agent, may edit them)
let lastMods = '';
async function watchOnce() {
  if (document.hidden || !S.mod) return;
  try {
    const mods = await api.mods();
    const sig = JSON.stringify(mods.map(m => [m.name, m.maps.map(x => [x.id, x.name]), m.built.map(x => x.id)]));
    if (lastMods && sig !== lastMods) { S.mods = mods; emit('mods'); }
    lastMods = sig;
    const d = S.doc;
    if (!d || d.readonly) return;
    const now = (await api.mtime(S.mod, d.id))?.mtime ?? null;
    if (d.mtime === null || now === null || now === d.mtime) return;
    d.mtime = now;                                   // ask once per change
    if (!S.dirty) { await openMap(d.id, { keepView: true }); toast('This map changed on disk, so it was reloaded.', 'ok', 3500); }
    else { S.externalChange = true; emit('external'); }
  } catch { /* the server may be restarting; try again next time */ }
}
export const startWatching = () => setInterval(watchOnce, 2000);
/** After "load theirs" or "keep mine" on an external change. */
export async function reloadFromDisk() { S.externalChange = false; await openMap(S.doc.id, { keepView: true }); }

// ------------------------------------------------------------ painting
/** A stroke gathers the cells one mouse drag changes so it undoes as one step. */
export function beginStroke() { return { changes: new Map() }; }

export function paintCell(stroke, layer, x, y, value) {
  if (!inMap(x, y)) return;
  const d = S.doc, idx = y * d.w + x, data = layerData(layer);
  if (!data) return;
  const key = `t:${layer}:${idx}`, rec = stroke.changes.get(key);
  const cur = resolver(d.tiled, d.defs)(data[idx]);
  const next = value === 'erase' ? null : value;
  if (!rec && (next ? cur?.source === next.ts && cur.local === next.local : !cur)) return;
  const prev = rec ? rec.prev : cur && { ts: cur.source, local: cur.local };
  const prevOv = rec ? rec.prevOv : d.ov[layer]?.get(idx);
  data[idx] = refGid(next);
  setOverride(d.ov, layer, idx, value);
  stroke.changes.set(key, { k: 'tile', layer, idx, prev, prevOv, next, nextOv: value });
}
export function wallCell(stroke, x, y, blocked) {
  if (!inMap(x, y)) return;
  const d = S.doc, idx = y * d.w + x, col = d.tiled.layers.find(l => isCollisionLayer(l.name));
  const gid = collisionGid();
  if (!col || !gid) { toast('This map has no walls layer, so it cannot hold walls.', 'bad'); return; }
  const key = `w:${idx}`, rec = stroke.changes.get(key);
  const nextCh = blocked ? '#' : '.';
  if (!rec && !!col.data[idx] === blocked && d.blocked[y][x] === nextCh) return;
  const prev = rec ?? { k: 'wall', idx, prev: !!col.data[idx], prevCh: d.blocked[y][x] };
  col.data[idx] = blocked ? gid : 0; d.blocked[y][x] = nextCh;
  stroke.changes.set(key, { ...prev, next: blocked, nextCh });
}
export function endStroke(stroke) {
  if (!stroke.changes.size) return;
  const changes = [...stroke.changes.values()];
  pushHistory({ type: 'cells', changes });
  validate(); emit('doc');
  hintAboutLayers(changes);
}

const layerNames = () => tileLayers().map(l => l.name);
/** Tile layers other than `skip` that still have a tile at a cell, bottom to top. */
export function layersAt(idx, skip = null) {
  return tileLayers().filter(l => l.name !== skip && l.data[idx]).map(l => l.name);
}
/** Painting under something, or erasing a layer while the thing you see lives on another, looks like "nothing happened". Say so. */
function hintAboutLayers(changes) {
  const order = layerNames(), d = S.doc;
  const hidden = [], stillThere = [];
  for (const c of changes) {
    if (c.k !== 'tile') continue;
    const above = order.slice(order.indexOf(c.layer) + 1).filter(n => tileLayers().find(l => l.name === n).data[c.idx]);
    if (c.next && above.length) hidden.push({ x: c.idx % d.w, y: Math.floor(c.idx / d.w), above });
    if (!c.next) { const others = layersAt(c.idx, c.layer); if (others.length) stillThere.push({ x: c.idx % d.w, y: Math.floor(c.idx / d.w), others }); }
  }
  const nm = n => n.replace(/^GROUND\s*-\s*/i, 'Ground ').replace(/^ABOVE ALL\s*-\s*/i, 'Above ').replace(/^SAME AS CHARACTER\s*-?\s*/i, 'With characters ');
  if (hidden.length) toast(`${hidden.length} painted tile${hidden.length > 1 ? 's are' : ' is'} hidden under another layer (for example at ${hidden[0].x},${hidden[0].y}, under ${nm(hidden[0].above.at(-1))}). Press D to dim the other layers, or pick the higher layer.`, '', 7000);
  else if (stillThere.length) toast(`Erased on ${nm(S.layer)}, but ${nm(stillThere[0].others.at(-1))} still shows something at ${stillThere[0].x},${stillThere[0].y}. Pick that layer, or hold Shift with the Eraser to clear every layer.`, '', 7000);
}

/** Flood fill on one layer from (x, y). Returns the cells to change (caller feeds them through a stroke). */
export function floodCells(layer, x, y, limit = 40000) {
  const d = S.doc, data = layerData(layer);
  if (!data || !inMap(x, y)) return [];
  const target = data[y * d.w + x], seen = new Uint8Array(d.w * d.h), out = [], q = [[x, y]];
  seen[y * d.w + x] = 1;
  while (q.length && out.length < limit) {
    const [cx, cy] = q.pop(); out.push([cx, cy]);
    for (const [nx, ny] of [[cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1]]) {
      if (!inMap(nx, ny)) continue;
      const i = ny * d.w + nx;
      if (!seen[i] && data[i] === target) { seen[i] = 1; q.push([nx, ny]); }
    }
  }
  return out;
}

/** What is under (x, y) on a layer, as a palette-style reference, for the eyedropper and the status line. */
export function tileAt(layer, x, y) {
  if (!inMap(x, y)) return null;
  const gid = layerData(layer)?.[y * S.doc.w + x];
  return gid ? resolver(S.doc.tiled, S.doc.defs)(gid) : null;
}
export const wallAt = (x, y) => inMap(x, y) && !!S.doc.tiled.layers.find(l => isCollisionLayer(l.name))?.data[y * S.doc.w + x];

// ------------------------------------------------------------ whole-document edits (undo restores a snapshot, then re-asks the compiler)
/** Run `fn` on the spec as one undoable step. Keys that repeat quickly (typing) merge into one step. */
export function edit(fn, { grid = false, coalesce = null, quiet = false } = {}) {
  if (S.doc.readonly) { toast('View only: this map is made by the mod\'s own build scripts.'); return; }
  const now = Date.now(), top = undoStack[undoStack.length - 1];
  const merge = coalesce && lastCoalesce.key === coalesce && now - lastCoalesce.at < 1200 && top?.type === 'doc';
  if (merge) {                                  // typing or dragging: keep the first "before", work out "after" only if someone redoes
    fn(S.doc); top.after = null; markDirty(); redoStack.length = 0;
  } else {
    const before = snapshot();
    fn(S.doc);
    pushHistory({ type: 'doc', before, after: coalesce ? null : snapshot() });
  }
  lastCoalesce = { key: coalesce, at: now };
  emit('doc', { quiet });
  grid ? refresh() : validate();
}

export function placeStamp(x, y) {
  const s = S.stamp;
  if (!s) return;
  const [, , rw, rh] = s.rect;
  if (x < 0 || y < 0 || x + rw > S.doc.w || y + rh > S.doc.h) { toast(`That ${rw}×${rh} stamp does not fit there. Move it inside the map.`, 'bad'); return; }
  edit(d => {
    (d.spec.stamps ??= []).push({ from: s.map, rect: [...s.rect], at: [x, y] });
    clearOverridesIn(d.ov, d.w, [x, y, rw, rh]);
    for (let yy = y; yy < y + rh; yy++) for (let xx = x; xx < x + rw; xx++) d.blocked[yy][xx] = ' ';   // the stamp brings its own walls
  }, { grid: true });
}
export function removeStamp(i) { edit(d => { d.spec.stamps.splice(i, 1); }, { grid: true }); }

// ------------------------------------------------------------ events
const events = () => (S.doc.spec.events ??= []);
export function addEvent(x, y) {
  edit(d => { (d.spec.events ??= []).push({ name: `Event ${(d.spec.events?.length ?? 0) + 1}`, x, y, do: [] }); });
  S.selEvent = events().length - 1; emit('select');
}
export function moveEvent(i, x, y) { if (inMap(x, y)) edit(() => { events()[i].x = x; events()[i].y = y; }, { coalesce: `move${i}` }); }
export function deleteEvent(i) { edit(() => { events().splice(i, 1); }); S.selEvent = -1; emit('select'); }
export function selectEvent(i) { S.selEvent = i; emit('select'); }
export function toggleRemoveGameEvent(id) {
  edit(d => {
    const list = (d.spec.removeEvents ??= []);
    const i = list.indexOf(id);
    if (i >= 0) list.splice(i, 1); else list.push(id);
    if (!list.length) delete d.spec.removeEvents;
  }, { grid: true });
}

/** The sprite of an event's first page, as { name, index, dir, pattern }. */
export function spriteOf(ev) {
  const raw = ev.pages?.[0]?.sprite ?? ev.sprite;
  if (!raw) return null;
  return typeof raw === 'string' ? { name: raw, index: 0, dir: 2, pattern: 1 } : { name: raw.name, index: raw.index ?? 0, dir: raw.dir ?? 2, pattern: raw.pattern ?? 1 };
}

// ------------------------------------------------------------ tools and selection
export function setTool(t) { S.tool = t; emit('tool'); }
export function setLayer(name) { S.layer = name; emit('layer'); }
export function setPalette(p) { Object.assign(S.pal, p); emit('palette'); }
export const palValue = () => ({ ts: S.pal.ts, w: S.pal.w, h: S.pal.h, x: S.pal.x, y: S.pal.y });
/** The tile at offset (dx, dy) inside the selected palette block, as an override value. */
export function palTile(dx = 0, dy = 0) {
  const def = tsDef(S.pal.ts);
  if (!def || !S.pal.ts) return null;
  const col = S.pal.x + (dx % S.pal.w), row = S.pal.y + (dy % S.pal.h);
  const local = row * def.columns + col;
  return local < def.tilecount ? { ts: canonTs(S.pal.ts), local } : null;
}

// ------------------------------------------------------------ map settings
export function setMapField(key, value) { edit(d => { if (value === '' || value === undefined) delete d.spec[key]; else d.spec[key] = value; }, { coalesce: `f:${key}` }); }
export function resizeMap(w, h) { edit(d => { d.spec.size = [w, h]; }, { grid: true }); }

export { TILE };
