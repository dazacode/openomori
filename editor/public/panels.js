// The right-hand panel: TILES, STAMP, EVENTS and MAP tabs.
import {
  S, on, emit, getImage, tsDef, tsName, setPalette, setTool, removeStamp, edit, setMapField, resizeMap, tileLayers, currentMod, takeOver, giveBack,
} from './store.js';
import { api } from './api.js';
import { drawTileLayers, centerOn, requestDraw } from './canvas.js';
import { TILE } from './spec.js';
import { h, toast } from './util.js';
import { modal } from './dialogs.js';
import { eventsPanel } from './events.js';
import { claudePanel } from './claude.js';
import { pieceThumb, refMap as loadMap } from './thumbs.js';
import { loadLibrary } from './store.js';

const $tabs = document.getElementById('tabs'), $panel = document.getElementById('panel');
const TABS = [['tiles', 'TILES'], ['stamp', 'STAMP'], ['events', 'EVENTS'], ['map', 'MAP'], ['claude', 'CLAUDE']];
let tab = 'tiles';
export const currentTab = () => tab;

export function showTab(name) { tab = name; drawTabs(); drawPanel(); }
function drawTabs() {
  $tabs.replaceChildren(...TABS.map(([id, label]) => h('button', { class: 'tab', role: 'tab', 'aria-selected': String(tab === id), onclick: () => showTab(id) }, label)));
}
document.addEventListener('editor:tab', e => showTab(e.detail));

function drawPanel() {
  if (!S.doc) { $panel.replaceChildren(h('div', { class: 'help' }, 'Open a map to edit it. Tiles, stamps, events and map settings appear here.')); return; }
  if (S.doc.readonly) { $panel.replaceChildren(readonlyPanel()); afterPanel = null; return; }
  const build = { tiles: tilesPanel, stamp: stampPanel, events: eventsPanel, map: mapPanel, claude: claudePanel }[tab];
  $panel.replaceChildren(build());
  afterPanel?.();
}
let afterPanel = null;

// ------------------------------------------------------------ TILES
let palZoom = 1, palFilter = '';
function tilesPanel() {
  const used = [...new Set(S.doc.tiled.tilesets.map(t => t.source))].filter(s => !/Tile_Collisions/i.test(s) && tsDef(s));
  const usedLower = new Set(used.map(u => u.toLowerCase()));
  const all = Object.keys({ ...S.tilesets, ...S.doc.defs }).filter(s => !/Tile_Collisions/i.test(s) && !usedLower.has(s.toLowerCase())).sort((a, b) => a.localeCompare(b));
  if (!S.pal.ts || !tsDef(S.pal.ts)) { const first = used[0] ?? all[0]; if (first) Object.assign(S.pal, { ts: first, x: 0, y: 0, w: 1, h: 1 }); }
  const f = palFilter.toLowerCase();
  const opt = s => h('option', { value: s, selected: s === S.pal.ts }, tsName(s));
  const sel = h('select', { class: 'grow', 'aria-label': 'Tileset', onchange: e => { setPalette({ ts: e.target.value, x: 0, y: 0, w: 1, h: 1 }); drawPanel(); } },
    used.length ? h('optgroup', { label: 'Used in this map' }, used.filter(s => !f || s.toLowerCase().includes(f)).map(opt)) : null,
    h('optgroup', { label: 'All tilesets' }, all.filter(s => !f || s.toLowerCase().includes(f)).map(opt)));
  if (S.pal.ts && ![...sel.options].some(o => o.value === S.pal.ts)) sel.prepend(opt(S.pal.ts));

  const canvas = h('canvas');
  const wrap = h('div', { class: 'pal-wrap' }, canvas);
  const info = h('div', { class: 'help' });
  const def = tsDef(S.pal.ts);

  const draw = () => {
    const img = def && getImage('tilesets', def.image);
    const z = palZoom;
    if (!img) { canvas.width = 200; canvas.height = 40; const c = canvas.getContext('2d'); c.fillStyle = '#888'; c.font = '16px OmoriGame, monospace'; c.fillText(def ? 'loading…' : 'pick a tileset', 8, 24); return; }
    canvas.width = img.width * z; canvas.height = img.height * z;
    const c = canvas.getContext('2d'); c.imageSmoothingEnabled = false;
    c.drawImage(img, 0, 0, canvas.width, canvas.height);
    const ts = TILE * z;
    if (z >= 1) { c.strokeStyle = 'rgba(255,255,255,.12)'; c.lineWidth = 1; for (let x = 0; x <= def.columns; x++) { c.beginPath(); c.moveTo(x * ts + .5, 0); c.lineTo(x * ts + .5, canvas.height); c.stroke(); } for (let y = 0; y <= Math.ceil(def.tilecount / def.columns); y++) { c.beginPath(); c.moveTo(0, y * ts + .5); c.lineTo(canvas.width, y * ts + .5); c.stroke(); } }
    c.lineWidth = 3; c.strokeStyle = '#000'; c.strokeRect(S.pal.x * ts + 1, S.pal.y * ts + 1, S.pal.w * ts - 2, S.pal.h * ts - 2);
    c.lineWidth = 1.5; c.strokeStyle = '#fff'; c.strokeRect(S.pal.x * ts + 1, S.pal.y * ts + 1, S.pal.w * ts - 2, S.pal.h * ts - 2);
    const local = S.pal.y * def.columns + S.pal.x;
    info.textContent = `${tsName(S.pal.ts)}  tile #${local}${S.pal.w * S.pal.h > 1 ? `  (${S.pal.w}×${S.pal.h} block)` : ''}`;
  };
  afterPanel = () => { draw(); };
  let sel0 = null;
  const cell = e => {
    const r = canvas.getBoundingClientRect(), z = palZoom;
    return { x: Math.min(def.columns - 1, Math.max(0, Math.floor((e.clientX - r.left) / (TILE * z)))), y: Math.max(0, Math.floor((e.clientY - r.top) / (TILE * z))) };
  };
  canvas.onpointerdown = e => {
    if (!def) return;
    canvas.setPointerCapture(e.pointerId); sel0 = cell(e);
    setPalette({ x: sel0.x, y: sel0.y, w: 1, h: 1 });
    if (['eraser', 'pick', 'pan', 'event', 'stamp', 'walls'].includes(S.tool)) setTool('brush');
    draw();
  };
  canvas.onpointermove = e => {
    if (!sel0 || !def) return;
    const c = cell(e), x = Math.min(sel0.x, c.x), y = Math.min(sel0.y, c.y);
    setPalette({ x, y, w: Math.min(Math.abs(c.x - sel0.x) + 1, 12), h: Math.min(Math.abs(c.y - sel0.y) + 1, 12) }); draw();
  };
  canvas.onpointerup = () => { sel0 = null; };

  const zoomChips = [[0.5, '½×'], [1, '1×'], [2, '2×']].map(([z, label]) => h('button', { class: 'chip', 'aria-pressed': String(palZoom === z), onclick: () => { palZoom = z; drawPanel(); } }, label));
  const filter = h('input', { type: 'search', placeholder: 'Filter tilesets…', value: palFilter, 'aria-label': 'Filter tilesets', oninput: e => { palFilter = e.target.value; const pos = e.target.selectionStart; drawPanel(); const i = $panel.querySelector('input[type=search]'); i?.focus(); i?.setSelectionRange(pos, pos); } });
  return h('div', {},
    h('div', { class: 'sect' }, h('h3', {}, 'TILESET'), h('div', { class: 'row' }, filter), h('div', { class: 'row', style: 'margin-top:6px' }, sel)),
    h('div', { class: 'sect' }, h('h3', {}, 'PICK TILES', h('span', { class: 'row tight' }, ...zoomChips)), wrap, info,
      h('div', { class: 'help' }, 'Click a tile, or drag to pick a block. Then paint with the Brush (B). Right-click on the map erases.')));
}

// ------------------------------------------------------------ STAMP
let stampFilter = '', refMap = null, refZoom = 0.5, refSel = null;
const RECENT_KEY = 'omori-editor-recent-stamps';
const recentMaps = () => { try { return JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]'); } catch { return []; } };
const rememberMap = id => { try { localStorage.setItem(RECENT_KEY, JSON.stringify([id, ...recentMaps().filter(x => x !== id)].slice(0, 8))); } catch { /* storage may be off */ } };

async function loadRef(id) {
  try {
    const r = await api.gameMap(id);
    refMap = { id, name: r.name, tiled: r.tiled, defs: r.tilesetDefs }; refSel = null; rememberMap(id);
    S.stamp = null; emit('palette');
    drawPanel();
  } catch (e) { toast(`Could not open map ${id}: ${e.message}`, 'bad'); }
}
let pieceGroup = 'Outdoors';
/** Use a ready-made piece: load its source map and arm the stamp tool. */
async function usePiece(p) {
  try {
    const m = await loadMap(p.map);
    S.stamp = { map: p.map, name: m.name, rect: [...p.rect], tiled: m.tiled, defs: m.defs, piece: p.name };
    setTool('stamp'); emit('palette'); drawPanel();
  } catch (e) { toast(`Could not open map ${p.map}: ${e.message}`, 'bad'); }
}
async function saveAsPiece() {
  const s0 = S.stamp; if (!s0) return;
  const name = h('input', { type: 'text', placeholder: 'e.g. Corner shop', class: 'grow', value: '' });
  const ok = await modal('SAVE AS A PIECE', h('div', {}, h('p', {}, `Keep this ${s0.rect[2]}×${s0.rect[3]} piece of map ${s0.map} so you can use it again in any map of this mod.`), h('div', { class: 'row' }, name)), [{ label: 'CANCEL', value: false }, { label: 'SAVE', value: true, primary: true }]);
  if (!ok || !name.value.trim()) return;
  try { await api.savePiece(S.mod, { name: name.value.trim(), map: s0.map, rect: s0.rect }); await loadLibrary(); pieceGroup = 'Mine'; toast('Saved. Find it under Mine.', 'ok'); drawPanel(); } catch (e) { toast(e.message, 'bad'); }
}
function piecesSection() {
  const all = [...S.library.pieces, ...S.library.mine];
  const groups = [...new Set(all.map(p => p.group ?? 'Other'))];
  if (!groups.includes(pieceGroup)) pieceGroup = groups[0] ?? 'Outdoors';
  const shown = all.filter(p => (p.group ?? 'Other') === pieceGroup);
  const same = p => S.stamp && S.stamp.map === p.map && S.stamp.rect.join() === p.rect.join();
  return h('div', { class: 'sect' },
    h('h3', {}, 'READY-MADE PIECES'),
    h('div', { class: 'row tight', style: 'margin-bottom:8px' }, groups.map(g => h('button', { class: 'chip', 'aria-pressed': String(g === pieceGroup), onclick: () => { pieceGroup = g; drawPanel(); } }, g))),
    shown.length ? h('div', { class: 'pieces' }, shown.map(p => h('button', { class: 'piece', 'aria-pressed': String(!!same(p)), title: `${p.name} (${p.rect[2]}×${p.rect[3]} tiles)`, onclick: () => usePiece(p) },
      h('div', { class: 'pt' }, pieceThumb(p)), h('div', { class: 'pn' }, p.name), h('div', { class: 'ps' }, `${p.rect[2]}×${p.rect[3]}`))))
      : h('div', { class: 'help' }, 'Nothing here yet. Pick a rectangle from any game map below, then SAVE AS A PIECE.'),
    S.stamp ? h('div', { class: 'note' }, `Ready: ${S.stamp.piece ?? `a ${S.stamp.rect[2]}×${S.stamp.rect[3]} piece of map ${S.stamp.map}`}. Click on your map to place it. `,
      S.stamp.piece ? null : h('button', { class: 'chip', style: 'margin-left:6px', onclick: saveAsPiece }, 'SAVE AS A PIECE')) : h('div', { class: 'help' }, 'Click a piece, then click on your map to place it. Pieces come with their walls.'));
}

function stampPanel() {
  const needle = stampFilter.trim().toLowerCase();
  const byId = new Map(S.gameMaps.map(m => [m.id, m]));
  let rows = needle ? S.gameMaps.filter(m => String(m.id) === needle || m.name.toLowerCase().includes(needle)).slice(0, 80) : recentMaps().map(id => byId.get(id)).filter(Boolean);
  const base = S.doc.spec.tilesFrom ?? S.doc.spec.base;
  const filter = h('input', { type: 'search', class: 'grow', placeholder: 'Search maps by name or number…', value: stampFilter, 'aria-label': 'Search game maps',
    oninput: e => { stampFilter = e.target.value; const pos = e.target.selectionStart; drawPanel(); const i = $panel.querySelector('input[type=search]'); i?.focus(); i?.setSelectionRange(pos, pos); } });
  const list = h('div', { class: 'list' }, rows.length ? rows.map(m => h('button', { class: 'item', 'aria-selected': String(refMap?.id === m.id), onclick: () => loadRef(m.id) }, h('span', { class: 'id' }, m.id), h('span', {}, m.name)))
    : h('div', { class: 'help', style: 'padding:6px' }, needle ? 'No map matches that.' : 'Type a name or number to find a map to borrow from.'));

  let ref = null;
  if (refMap) {
    const t = refMap.tiled, z = refZoom;
    const canvas = h('canvas'); canvas.width = t.width * TILE * z; canvas.height = t.height * TILE * z;
    const drawRef = () => {
      const c = canvas.getContext('2d'); c.imageSmoothingEnabled = false;
      c.fillStyle = '#181818'; c.fillRect(0, 0, canvas.width, canvas.height);
      drawTileLayers(c, t, refMap.defs, { rect: [0, 0, t.width, t.height], at: [0, 0], z });
      if (refSel) {
        const [x, y, w, hh] = refSel, ts = TILE * z;
        c.fillStyle = 'rgba(255,255,255,.18)'; c.fillRect(x * ts, y * ts, w * ts, hh * ts);
        c.lineWidth = 3; c.strokeStyle = '#000'; c.strokeRect(x * ts, y * ts, w * ts, hh * ts); c.lineWidth = 1.5; c.strokeStyle = '#fff'; c.strokeRect(x * ts, y * ts, w * ts, hh * ts);
      }
      if (S.show.grid && z >= 0.5) { c.strokeStyle = 'rgba(255,255,255,.14)'; c.lineWidth = 1; for (let i = 0; i <= t.width; i += 10) { c.beginPath(); c.moveTo(i * TILE * z + .5, 0); c.lineTo(i * TILE * z + .5, canvas.height); c.stroke(); } for (let i = 0; i <= t.height; i += 10) { c.beginPath(); c.moveTo(0, i * TILE * z + .5); c.lineTo(canvas.width, i * TILE * z + .5); c.stroke(); } }
    };
    const cellOf = e => { const r = canvas.getBoundingClientRect(), ts = TILE * z; return { x: Math.min(t.width - 1, Math.max(0, Math.floor((e.clientX - r.left) / ts))), y: Math.min(t.height - 1, Math.max(0, Math.floor((e.clientY - r.top) / ts))) }; };
    let a = null;
    canvas.onpointerdown = e => { canvas.setPointerCapture(e.pointerId); a = cellOf(e); refSel = [a.x, a.y, 1, 1]; drawRef(); };
    canvas.onpointermove = e => { if (!a) return; const b = cellOf(e); refSel = [Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(a.x - b.x) + 1, Math.abs(a.y - b.y) + 1]; drawRef(); };
    canvas.onpointerup = () => {
      a = null; if (!refSel) return;
      S.stamp = { map: refMap.id, name: refMap.name, rect: [...refSel], tiled: t, defs: refMap.defs };
      setTool('stamp'); emit('palette'); drawPanel();
    };
    afterPanel = () => { drawRef(); };
    const chips = [[0.25, '¼×'], [0.5, '½×'], [1, '1×']].map(([zz, label]) => h('button', { class: 'chip', 'aria-pressed': String(refZoom === zz), onclick: () => { refZoom = zz; drawPanel(); } }, label));
    ref = h('div', { class: 'sect' },
      h('h3', {}, `${refMap.id} · ${refMap.name}`, h('span', { class: 'row tight' }, ...chips)),
      h('div', { class: 'pal-wrap' }, canvas),
      h('div', { class: 'help' }, S.stamp ? `Picked ${S.stamp.rect[2]}×${S.stamp.rect[3]} tiles at (${S.stamp.rect[0]}, ${S.stamp.rect[1]}). Now click on your map to place it.` : 'Drag a rectangle on this map to pick a piece of it.'));
  } else afterPanel = null;

  const placed = S.doc.spec.stamps ?? [];
  return h('div', {},
    piecesSection(),
    h('div', { class: 'sect' }, h('h3', {}, 'OR BORROW FROM ANY GAME MAP'), h('div', { class: 'row' }, filter),
      base !== undefined ? h('div', { class: 'row', style: 'margin:6px 0' }, h('button', { class: 'chip', onclick: () => loadRef(base) }, `This map's base: ${base}`)) : null, list),
    ref,
    h('div', { class: 'sect' }, h('h3', {}, `PLACED STAMPS (${placed.length})`),
      placed.length ? h('div', { class: 'list' }, placed.map((s, i) => h('div', { class: 'item', onclick: () => { centerOn(s.at[0] + s.rect[2] / 2, s.at[1] + s.rect[3] / 2); } },
        h('span', { class: 'id' }, `#${i + 1}`), h('span', { class: 'grow' }, `map ${s.from} ${s.rect[2]}×${s.rect[3]} → (${s.at[0]}, ${s.at[1]})`),
        h('button', { class: 'mini', title: 'Remove this stamp', onclick: ev => { ev.stopPropagation(); removeStamp(i); } }, '✕'))))
        : h('div', { class: 'help' }, 'Nothing yet. Stamps copy tiles and walls from a real map, so you get the game\'s own art without picking tile numbers.')));
}

// ------------------------------------------------------------ view-only maps
async function askTakeOver() {
  const ok = await modal('EDIT THIS MAP?', h('div', {},
    h('p', {}, 'The editor keeps a copy of what the scripts made, and your changes sit on top of it. You can paint, stamp, change walls, add events and move or remove the ones that are there.'),
    h('p', {}, 'To try your changes in the game: SAVE (Ctrl+S), then BUILD (Ctrl+B), then reload the game and playtest. If you do not like them, press GIVE BACK TO THE SCRIPTS in the MAP tab and the map goes back to exactly how the scripts made it. You can edit and build again whenever you like.'),
    h('p', { class: 'dim' }, 'When the scripts run again they keep working: their new version becomes the copy and your changes are laid back on top. Their dialogue and event steps for this map still come from the scripts.')),
    [{ label: 'CANCEL', value: false }, { label: 'EDIT THIS MAP', value: true, primary: true }]);
  if (!ok) return;
  try { await takeOver(S.doc.id); toast('Now editable. Your changes are saved in maps/' + S.doc.id + '.spec.json.', 'ok', 4000); } catch (e) { toast(e.message, 'bad'); }
}
function readonlyPanel() {
  const d = S.doc, evs = (d.gameEvents ?? []).filter(Boolean);
  return h('div', {},
    h('div', { class: 'note' }, 'VIEW ONLY. This map is a finished file written by the mod\'s own build scripts.'),
    h('div', { class: 'row', style: 'margin:10px 0' }, h('button', { class: 'btn primary', onclick: askTakeOver }, 'EDIT THIS MAP')),
    h('div', { class: 'help' }, 'Editing keeps the scripts working: your changes are laid on top of what they make, so a rebuild does not erase them.'),
    h('div', { class: 'sect', style: 'margin-top:14px' }, h('h3', {}, `${d.tiled.width}×${d.tiled.height} TILES, ${evs.length} EVENTS`),
      evs.length ? h('div', { class: 'list' }, evs.map(e => h('button', { class: 'item', onclick: () => centerOn(e.x, e.y) }, h('span', { class: 'id' }, `#${e.id}`), h('span', { class: 'grow' }, e.name), h('span', { class: 'dim' }, `(${e.x}, ${e.y})`)))) : h('div', { class: 'help' }, 'No events.')));
}

// ------------------------------------------------------------ MAP
function mapPanel() {
  const d = S.doc, spec = d.spec, isBase = spec.base !== undefined;
  const text = (key, label, extra = {}) => [h('label', { for: `m-${key}` }, label), h('input', { id: `m-${key}`, type: 'text', value: spec[key] ?? '', oninput: e => setMapField(key, e.target.value), ...extra })];
  const w = h('input', { id: 'm-w', type: 'number', min: 5, max: 300, value: d.w, disabled: isBase }), hh = h('input', { id: 'm-h', type: 'number', min: 5, max: 300, value: d.h, disabled: isBase });
  const apply = () => { const nw = Number(w.value), nh = Number(hh.value); if (nw >= 5 && nw <= 300 && nh >= 5 && nh <= 300 && (nw !== d.w || nh !== d.h)) resizeMap(nw, nh); };
  w.onchange = apply; hh.onchange = apply;
  const bgm = typeof spec.bgm === 'string' ? spec.bgm : spec.bgm?.name ?? '';
  return h('div', {},
    h('div', { class: 'sect' }, h('h3', {}, 'THIS MAP'),
      h('div', { class: 'kv' },
        h('label', {}, 'Map id'), h('span', {}, String(spec.id), isBase ? h('span', { class: 'dim' }, '  (replaces the game\'s map)') : ''),
        ...text('name', 'Name'),
        h('label', {}, 'Size'), h('div', { class: 'row tight' }, w, '×', hh, ' tiles'),
        h('label', { for: 'm-bgm' }, 'Music'), h('input', { id: 'm-bgm', type: 'text', value: bgm, placeholder: 'e.g. bgm_name', oninput: e => setMapField('bgm', e.target.value) }),
        h('label', {}, 'Art from'), h('span', {}, isBase ? `game map ${spec.base} (kept)` : `map ${spec.tilesFrom ?? 13}'s tilesets`)),
      isBase ? h('div', { class: 'note' }, 'This edits the game\'s own map in place. The size is fixed, and another mod that edits the same map will conflict.') : h('div', { class: 'help' }, 'Making the map bigger keeps what you have. Making it smaller can fail if something sits outside the new size.')),
    h('div', { class: 'sect' }, h('h3', {}, 'NOTES'), h('textarea', { rows: 3, placeholder: 'Anything you want to remember about this map (not shown in the game).', oninput: e => setMapField('note', e.target.value) }, spec.note ?? '')),
    spec.snapshot ? h('div', { class: 'sect' }, h('h3', {}, 'TAKEN OVER FROM THE SCRIPTS'),
      h('div', { class: 'help' }, 'This map is built by the mod\'s scripts. SAVE keeps your edits, BUILD puts them in the game so you can playtest. Not happy? Give it back and the scripts\' own version returns, then BUILD again if you want it in the game.'),
      h('button', { class: 'btn danger', onclick: async () => {
        if (!(await modal('GIVE THIS MAP BACK?', h('p', {}, 'Your edits to this map will be dropped and the scripts\' own version put back. This cannot be undone.'), [{ label: 'CANCEL', value: false }, { label: 'GIVE BACK', value: true, danger: true, primary: true }]))) return;
        try { await giveBack(d.id); toast('Handed back to the scripts.', 'ok'); } catch (e) { toast(e.message, 'bad'); }
      } }, 'GIVE BACK TO THE SCRIPTS')) : null,
    h('div', { class: 'sect' }, h('h3', {}, 'FILE'), h('div', { class: 'help' }, `maps/${spec.id}.spec.json in mod "${S.mod}". The editor reads and writes this file; you can still edit it by hand.`)));
}

// ------------------------------------------------------------ wiring
const redraw = () => { if (S.doc) drawPanel(); };
on('open', () => { showTab(S.doc?.spec.events?.length ? 'tiles' : 'tiles'); });
on('doc', arg => { if (arg?.quiet) return; if (tab === 'tiles' && $panel.querySelector('.pal-wrap')) { afterPanel?.(); updateTilesetsUsed(); return; } redraw(); });
on('palette', () => { if (tab === 'tiles') afterPanel?.(); else if (tab === 'stamp') redraw(); });
on('library', () => { if (tab === 'stamp') redraw(); });
on('image', () => { if (tab === 'tiles' || tab === 'stamp') afterPanel?.(); });
on('select', () => { if (tab !== 'events') { if (S.selEvent >= 0) showTab('events'); } else redraw(); });
on('mods', () => { if (!S.doc) drawPanel(); });
function updateTilesetsUsed() { /* the dropdown groups refresh the next time the panel is drawn */ }
drawTabs(); drawPanel();
void tileLayers; void edit; void currentMod; void requestDraw;
