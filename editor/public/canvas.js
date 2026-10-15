// The map canvas: draws the compiler's map, the overlays, and turns mouse/touch input into tool actions.
import {
  S, on, getImage, resolver, tileAt, wallAt, beginStroke, paintCell, wallCell, endStroke, floodCells, palTile,
  setPalette, setTool, selectEvent, addEvent, moveEvent, placeStamp, spriteOf, tileLayers, inMap, setLayer, tsDef, basePos, moveBaseEvent, layersAt,
} from './store.js';
import { TILE, isCollisionLayer, layerLabel } from './spec.js';
import { toast } from './util.js';

const stage = document.getElementById('stage');
const cv = document.getElementById('map');
const g = cv.getContext('2d');
const $pos = document.getElementById('pos');
const $hint = document.getElementById('hint');
const $zVal = document.getElementById('zVal');
const $hudLayer = document.getElementById('hudLayer');

export const view = { ox: 40, oy: 40, z: 1 };
const LEVELS = [0.25, 0.33, 0.5, 0.75, 1, 1.5, 2, 3, 4];
let cw = 800, ch = 600, dpr = 1;
let hover = null;          // { x, y } tile under the mouse, or null
let drag = null;
let spaceDown = false;
let wantDraw = false;

export const requestDraw = () => { if (!wantDraw) { wantDraw = true; requestAnimationFrame(draw); } };

// ------------------------------------------------------------ sizing, view
function resize() {
  dpr = Math.max(1, window.devicePixelRatio || 1);
  cw = stage.clientWidth; ch = stage.clientHeight;
  cv.width = Math.round(cw * dpr); cv.height = Math.round(ch * dpr);
  requestDraw();
}
new ResizeObserver(resize).observe(stage);

/** Screenshot mode: the map at a fixed zoom, filling a stage sized to exactly fit it. */
export function cleanView(zoom) {
  const d = S.doc; if (!d) return;
  view.z = zoom; view.ox = 0; view.oy = 0;
  stage.style.width = `${Math.ceil(d.tiled.width * TILE * zoom)}px`; stage.style.height = `${Math.ceil(d.tiled.height * TILE * zoom)}px`;
  resize(); zoomChanged();
}
export function fitView() {
  const d = S.doc; if (!d) return;
  const z = Math.min((cw - 60) / (d.w * TILE), (ch - 60) / (d.h * TILE), 2);
  view.z = Math.max(0.1, z);
  view.ox = (cw - d.w * TILE * view.z) / 2; view.oy = (ch - d.h * TILE * view.z) / 2;
  zoomChanged();
}
function zoomChanged() { $zVal.textContent = `${Math.round(view.z * 100)}%`; requestDraw(); }
export function zoomBy(dir, cx = cw / 2, cy = ch / 2) {
  const cur = view.z;
  const next = dir > 0 ? LEVELS.find(l => l > cur + 0.001) ?? LEVELS.at(-1) : [...LEVELS].reverse().find(l => l < cur - 0.001) ?? LEVELS[0];
  view.ox = cx - (cx - view.ox) * next / cur; view.oy = cy - (cy - view.oy) * next / cur; view.z = next;
  zoomChanged();
}
export function centerOn(tx, ty) {
  view.ox = cw / 2 - (tx + 0.5) * TILE * view.z; view.oy = ch / 2 - (ty + 0.5) * TILE * view.z; requestDraw();
}
const tileOf = (px, py) => ({ x: Math.floor((px - view.ox) / (TILE * view.z)), y: Math.floor((py - view.oy) / (TILE * view.z)) });
const local = e => { const r = cv.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };

// ------------------------------------------------------------ drawing
/** Draw tile layers of any Tiled map (the open map, a stamp source, the reference picture). */
export function drawTileLayers(g2, tiled, defs, { rect, at, z, alphaFor }) {
  const [x0, y0, x1, y1] = rect, res = resolver(tiled, defs), sz = TILE * z;
  g2.imageSmoothingEnabled = false;
  for (const layer of tiled.layers) {
    if (layer.type !== 'tilelayer' || isCollisionLayer(layer.name)) continue;
    const a = alphaFor ? alphaFor(layer) : 1;
    if (!a) continue;
    g2.globalAlpha = a;
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      const gid = layer.data[y * tiled.width + x];
      if (!gid) continue;
      const r = res(gid);
      if (!r) continue;
      const img = getImage('tilesets', r.def.image);
      if (!img) continue;
      const dx = Math.round(at[0] + (x - x0) * sz), dy = Math.round(at[1] + (y - y0) * sz);
      g2.drawImage(img, (r.local % r.def.columns) * TILE, Math.floor(r.local / r.def.columns) * TILE, TILE, TILE, dx, dy, Math.round(at[0] + (x + 1 - x0) * sz) - dx, Math.round(at[1] + (y + 1 - y0) * sz) - dy);
    }
  }
  g2.globalAlpha = 1;
}

function frameOf(img, name, index, dir, pattern) {
  const frames = /%\((\d+)\)/.exec(name);
  const single = /^!?\$/.test(name) || !!frames;
  const cols = frames ? Number(frames[1]) : single ? 3 : 12, rows = single ? 4 : 8;
  const fw = img.width / cols, fh = img.height / rows;
  const bx = single ? 0 : (index % 4) * 3, by = single ? 0 : Math.floor(index / 4) * 4;
  const row = ({ 2: 0, 4: 1, 6: 2, 8: 3 })[dir] ?? 0;
  return [(bx + (frames ? 0 : pattern)) * fw, (by + row) * fh, fw, fh];
}

function drawEvent(ev, i, { dim = false, selected = false, label = null }) {
  const sz = TILE * view.z, px = view.ox + ev.x * sz, py = view.oy + ev.y * sz;
  const sp = ev.image?.characterName ? { name: ev.image.characterName, index: ev.image.characterIndex ?? 0, dir: ev.image.direction ?? 2, pattern: ev.image.pattern ?? 1 } : spriteOf(ev);
  g.globalAlpha = dim ? 0.55 : 1;
  const img = sp?.name ? getImage('characters', sp.name) : null;
  if (img) {
    const [sx, sy, fw, fh] = frameOf(img, sp.name, sp.index, sp.dir, sp.pattern);
    const dw = fw * view.z, dh = fh * view.z;
    g.drawImage(img, sx, sy, fw, fh, px + (sz - dw) / 2, py + sz - dh, dw, dh);
  } else {
    g.fillStyle = 'rgba(255,255,255,.14)'; g.fillRect(px + 2, py + 2, sz - 4, sz - 4);
    g.strokeStyle = '#fff'; g.setLineDash([4, 3]); g.lineWidth = 1; g.strokeRect(px + 2.5, py + 2.5, sz - 5, sz - 5); g.setLineDash([]);
  }
  g.globalAlpha = 1;
  if (selected) { g.lineWidth = 3; g.strokeStyle = '#000'; g.strokeRect(px + 1, py + 1, sz - 2, sz - 2); g.lineWidth = 2; g.strokeStyle = '#fff'; g.strokeRect(px + 1, py + 1, sz - 2, sz - 2); }
  if (view.z >= 0.5) {
    const t = label ?? String(i + 1);
    g.font = `${Math.max(12, Math.round(12 * Math.min(view.z, 1.5)))}px OmoriGame, monospace`;
    const tw = g.measureText(t).width + 6;
    g.fillStyle = dim ? '#333' : '#000'; g.fillRect(px, py, tw, 15); g.fillStyle = dim ? '#aaa' : '#fff'; g.textBaseline = 'top'; g.fillText(t, px + 3, py + 1);
  }
}

function draw() {
  wantDraw = false;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.imageSmoothingEnabled = false;
  g.fillStyle = '#0d0d0d'; g.fillRect(0, 0, cw, ch);
  const d = S.doc;
  if (!d) return;
  const tw = d.tiled.width, th = d.tiled.height;
  const sz = TILE * view.z, mw = tw * sz, mh = th * sz;
  g.fillStyle = '#181818'; g.fillRect(view.ox, view.oy, mw, mh);

  const x0 = Math.max(0, Math.floor(-view.ox / sz)), y0 = Math.max(0, Math.floor(-view.oy / sz));
  const x1 = Math.min(tw, Math.ceil((cw - view.ox) / sz)), y1 = Math.min(th, Math.ceil((ch - view.oy) / sz));
  if (x1 > x0 && y1 > y0) {
    drawTileLayers(g, d.tiled, d.defs, {
      rect: [x0, y0, x1, y1], at: [view.ox + x0 * sz, view.oy + y0 * sz], z: view.z,
      alphaFor: l => (S.vis[l.name] === false ? 0 : S.show.dim && l.name !== S.layer ? 0.35 : 1),
    });
    if (S.show.walls) {
      const col = d.tiled.layers.find(l => isCollisionLayer(l.name));
      if (col) for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) if (col.data[y * tw + x]) {
        const strong = S.tool === 'walls';
        g.fillStyle = strong ? 'rgba(255,50,50,.36)' : 'rgba(255,50,50,.2)'; g.fillRect(view.ox + x * sz, view.oy + y * sz, sz, sz);
        if (strong && view.z >= 0.5) { g.strokeStyle = 'rgba(255,110,110,.95)'; g.lineWidth = 1; g.strokeRect(view.ox + x * sz + 1.5, view.oy + y * sz + 1.5, sz - 3, sz - 3); }
      }
    }
    if (S.show.events) {
      const removed = new Set(d.spec.removeEvents ?? []);
      const own = d.readonly || d.spec.snapshot;      // the map's own events are the point of a taken-over map: draw them at full strength
      for (const e of d.gameEvents ?? []) {
        if (!e || removed.has(e.id)) continue;
        const [ex, ey] = basePos(e);
        if (ex >= x0 - 3 && ex < x1 + 3 && ey >= y0 - 3 && ey < y1 + 3) drawEvent({ x: ex, y: ey, image: e.pages?.[0]?.image }, 0, { dim: !own, label: own ? String(e.id) : `g${e.id}` });
      }
      (d.spec.events ?? []).forEach((e, i) => { if (e.x >= x0 - 3 && e.x < x1 + 3 && e.y >= y0 - 3 && e.y < y1 + 3) drawEvent(e, i, { selected: i === S.selEvent }); });
    }
    if (S.show.edits) drawEdits(sz, x0, y0, x1, y1);
    if (S.show.grid && view.z >= 0.45) {
      g.lineWidth = 1;
      for (let x = x0; x <= x1; x++) { g.strokeStyle = x % 10 === 0 ? 'rgba(255,255,255,.28)' : 'rgba(255,255,255,.11)'; const px = Math.round(view.ox + x * sz) + 0.5; g.beginPath(); g.moveTo(px, view.oy + y0 * sz); g.lineTo(px, view.oy + y1 * sz); g.stroke(); }
      for (let y = y0; y <= y1; y++) { g.strokeStyle = y % 10 === 0 ? 'rgba(255,255,255,.28)' : 'rgba(255,255,255,.11)'; const py = Math.round(view.oy + y * sz) + 0.5; g.beginPath(); g.moveTo(view.ox + x0 * sz, py); g.lineTo(view.ox + x1 * sz, py); g.stroke(); }
    }
  }
  if (S.show.ruler) drawRuler(sz, tw, th);
  g.lineWidth = 2; g.strokeStyle = '#fff'; g.strokeRect(view.ox - 1, view.oy - 1, mw + 2, mh + 2);
  drawOverlay(sz);
}

/** Everything you changed on this map, outlined: painted tiles yellow, erased cells red, walls you set or opened blue. */
function drawEdits(sz, x0, y0, x1, y1) {
  const d = S.doc, w = d.w;
  g.lineWidth = Math.max(1, Math.min(2, view.z * 2));
  const box = (x, y, color, dash = false) => {
    if (x < x0 || x >= x1 || y < y0 || y >= y1) return;
    g.strokeStyle = color; g.setLineDash(dash ? [3, 2] : []); g.strokeRect(view.ox + x * sz + 1, view.oy + y * sz + 1, sz - 2, sz - 2);
  };
  for (const cells of Object.values(d.ov)) for (const [idx, v] of cells) box(idx % w, Math.floor(idx / w), v === 'erase' ? '#ff5050' : '#ffe14a', v === 'erase');
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const ch = d.blocked[y]?.[x]; if (ch === '#' || ch === '.') box(x, y, ch === '#' ? '#4aa8ff' : '#9fd4ff', ch === '.'); }
  g.setLineDash([]);
}

/** Tile numbers along the top and left edges every 5 tiles, so a rectangle can be read off by eye. */
function drawRuler(sz, tw, th) {
  g.font = '12px OmoriGame, monospace'; g.textBaseline = 'top';
  const step = view.z >= 0.9 ? 5 : view.z >= 0.45 ? 10 : 20;
  const tag = (t, x, y) => { const w = g.measureText(t).width + 4; g.fillStyle = 'rgba(0,0,0,.78)'; g.fillRect(x, y, w, 14); g.fillStyle = '#fff'; g.fillText(t, x + 2, y + 1); };
  for (let x = 0; x < tw; x += step) { g.fillStyle = 'rgba(255,255,0,.35)'; g.fillRect(view.ox + x * sz, view.oy, 1, th * sz); tag(String(x), view.ox + x * sz + 1, Math.max(view.oy, 0) + 1); }
  for (let y = step; y < th; y += step) { g.fillStyle = 'rgba(255,255,0,.35)'; g.fillRect(view.ox, view.oy + y * sz, tw * sz, 1); tag(String(y), Math.max(view.ox, 0) + 1, view.oy + y * sz + 1); }
}
function outline(x, y, w, h, color = '#fff') {
  const sz = TILE * view.z;
  g.lineWidth = 3; g.strokeStyle = '#000'; g.strokeRect(view.ox + x * sz, view.oy + y * sz, w * sz, h * sz);
  g.lineWidth = 1.5; g.strokeStyle = color; g.strokeRect(view.ox + x * sz, view.oy + y * sz, w * sz, h * sz);
}
function ghostPalette(x, y, alpha = 0.65) {
  const def = tsDef(S.pal.ts), img = def && getImage('tilesets', def.image);
  if (!img) return;
  const sz = TILE * view.z;
  g.globalAlpha = alpha;
  for (let dy = 0; dy < S.pal.h; dy++) for (let dx = 0; dx < S.pal.w; dx++) {
    const t = palTile(dx, dy); if (!t) continue;
    g.drawImage(img, (t.local % def.columns) * TILE, Math.floor(t.local / def.columns) * TILE, TILE, TILE, Math.round(view.ox + (x + dx) * sz), Math.round(view.oy + (y + dy) * sz), Math.ceil(sz), Math.ceil(sz));
  }
  g.globalAlpha = 1;
}
function drawOverlay(sz) {
  if (drag?.kind === 'rect' || drag?.kind === 'wallrect') {
    const r = rectOf(drag.a, drag.b);
    g.fillStyle = drag.erase ? 'rgba(255,60,60,.25)' : 'rgba(255,255,255,.18)';
    g.fillRect(view.ox + r[0] * sz, view.oy + r[1] * sz, r[2] * sz, r[3] * sz);
    outline(...r, drag.erase ? '#ff6060' : '#fff');
    return;
  }
  if (!hover || drag?.kind === 'pan') return;
  const { x, y } = hover, t = S.tool;
  if (t === 'brush' || t === 'rect' || t === 'fill') {
    if (t === 'brush' && S.pal.ts) { ghostPalette(x, y); outline(x, y, S.pal.w, S.pal.h); } else outline(x, y, 1, 1);
  } else if (t === 'eraser' || t === 'walls' || t === 'pick') outline(x, y, 1, 1, t === 'eraser' ? '#ff6060' : '#fff');
  else if (t === 'stamp' && S.stamp) {
    const [rx, ry, rw, rh] = S.stamp.rect, fits = x >= 0 && y >= 0 && x + rw <= S.doc.w && y + rh <= S.doc.h;
    drawTileLayers(g, S.stamp.tiled, S.stamp.defs, { rect: [rx, ry, rx + rw, ry + rh], at: [view.ox + x * sz, view.oy + y * sz], z: view.z, alphaFor: () => 0.7 });
    outline(x, y, rw, rh, fits ? '#fff' : '#ff6060');
  } else if (t === 'event') outline(x, y, 1, 1);
}

// ------------------------------------------------------------ tools
const rectOf = (a, b) => { const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y); return [x, y, Math.abs(a.x - b.x) + 1, Math.abs(a.y - b.y) + 1]; };
function* line(a, b) { // every cell between two cells, so fast drags leave no gaps
  let { x, y } = a; const dx = Math.abs(b.x - a.x), dy = -Math.abs(b.y - a.y), sx = a.x < b.x ? 1 : -1, sy = a.y < b.y ? 1 : -1;
  let err = dx + dy;
  for (;;) { yield { x, y }; if (x === b.x && y === b.y) return; const e2 = 2 * err; if (e2 >= dy) { err += dy; x += sx; } if (e2 <= dx) { err += dx; y += sy; } }
}
const needTile = () => { if (palTile()) return true; toast('Pick a tile first: open the TILES tab and click one.', ''); document.dispatchEvent(new CustomEvent('editor:tab', { detail: 'tiles' })); return false; };

function paintBlock(stroke, x, y, erase, all = false) {
  if (erase && all) { for (const l of tileLayers()) paintCell(stroke, l.name, x, y, 'erase'); }
  else if (erase) paintCell(stroke, S.layer, x, y, 'erase');
  else for (let dy = 0; dy < S.pal.h; dy++) for (let dx = 0; dx < S.pal.w; dx++) { const t = palTile(dx, dy); if (t) paintCell(stroke, S.layer, x + dx, y + dy, t); }
}
function pickAt(x, y) {
  const order = [S.layer, ...tileLayers().map(l => l.name).reverse().filter(n => n !== S.layer)];
  for (const name of order) {
    const r = tileAt(name, x, y);
    if (r) {
      setLayer(name);
      setPalette({ ts: r.source, x: r.local % r.def.columns, y: Math.floor(r.local / r.def.columns), w: 1, h: 1 });
      setTool('brush');
      document.dispatchEvent(new CustomEvent('editor:tab', { detail: 'tiles' }));
      return;
    }
  }
  toast('Nothing to pick there.');
}
function baseEventAt(x, y) {
  const removed = new Set(S.doc.spec.removeEvents ?? []);
  for (const e of [...(S.doc.gameEvents ?? [])].reverse()) { if (!e || removed.has(e.id)) continue; const [ex, ey] = basePos(e); if (ex === x && ey === y) return e; }
  return null;
}
function eventAt(x, y) {
  const list = S.doc.spec.events ?? [];
  for (let i = list.length - 1; i >= 0; i--) if (list[i].x === x && list[i].y === y) return i;
  return -1;
}

cv.addEventListener('contextmenu', e => e.preventDefault());
cv.addEventListener('pointerdown', e => {
  cv.focus();
  const [px, py] = local(e), t = tileOf(px, py);
  if (e.button === 1 || spaceDown || S.tool === 'pan') {
    drag = { kind: 'pan', sx: e.clientX, sy: e.clientY, ox: view.ox, oy: view.oy }; cv.setPointerCapture(e.pointerId); cv.style.cursor = 'grabbing'; e.preventDefault(); return;
  }
  const d = S.doc; if (!d) return;
  if (d.readonly && !['pick'].includes(S.tool)) { toast('View only: this map is made by the mod\'s own build scripts, so edits would be lost the next time they run.'); return; }
  const right = e.button === 2;
  if (e.altKey && ['brush', 'rect', 'fill', 'eraser'].includes(S.tool)) { pickAt(t.x, t.y); return; }
  switch (S.tool) {
    case 'brush': case 'eraser': {
      const erase = right || S.tool === 'eraser';
      if (!erase && !needTile()) return;
      drag = { kind: 'paint', stroke: beginStroke(), erase, all: erase && e.shiftKey, last: t };
      paintBlock(drag.stroke, t.x, t.y, erase, drag.all); cv.setPointerCapture(e.pointerId); requestDraw(); break;
    }
    case 'rect': if (right || needTile()) { drag = { kind: 'rect', a: t, b: t, erase: right }; cv.setPointerCapture(e.pointerId); } break;
    case 'fill': {
      if (!right && !needTile()) return;
      if (!inMap(t.x, t.y)) return;
      const cells = floodCells(S.layer, t.x, t.y), stroke = beginStroke();
      for (const [x, y] of cells) { if (right) paintCell(stroke, S.layer, x, y, 'erase'); else { const v = palTile(x, y); if (v) paintCell(stroke, S.layer, x, y, v); } }
      endStroke(stroke); requestDraw(); break;
    }
    case 'walls':
      if (e.shiftKey) drag = { kind: 'wallrect', a: t, b: t, erase: right };
      else { drag = { kind: 'wall', stroke: beginStroke(), blocked: !right, last: t }; wallCell(drag.stroke, t.x, t.y, !right); }
      cv.setPointerCapture(e.pointerId); requestDraw(); break;
    case 'stamp': if (!S.stamp) { toast('Pick a piece of another map first: open the STAMP tab.'); document.dispatchEvent(new CustomEvent('editor:tab', { detail: 'stamp' })); } else placeStamp(t.x, t.y); break;
    case 'event': {
      const i = eventAt(t.x, t.y);
      const b = i < 0 ? baseEventAt(t.x, t.y) : null;
      if (i >= 0) { selectEvent(i); if (!right) { drag = { kind: 'evmove', i, from: t }; cv.setPointerCapture(e.pointerId); } }
      else if (b) { if (!right) { drag = { kind: 'basemove', id: b.id }; cv.setPointerCapture(e.pointerId); } }
      else if (!right && inMap(t.x, t.y)) addEvent(t.x, t.y);
      break;
    }
    case 'pick': pickAt(t.x, t.y); break;
  }
});

cv.addEventListener('pointermove', e => {
  const [px, py] = local(e), t = tileOf(px, py);
  hover = inMap(t.x, t.y) || S.tool === 'stamp' ? t : null;
  if (S.doc) $pos.textContent = inMap(t.x, t.y) ? `x ${t.x}  y ${t.y}${tileInfo(t.x, t.y)}` : '';
  if (drag?.kind === 'pan') { view.ox = drag.ox + e.clientX - drag.sx; view.oy = drag.oy + e.clientY - drag.sy; }
  else if (drag?.kind === 'paint') { for (const c of line(drag.last, t)) paintBlock(drag.stroke, c.x, c.y, drag.erase, drag.all); drag.last = t; }
  else if (drag?.kind === 'wall') { for (const c of line(drag.last, t)) wallCell(drag.stroke, c.x, c.y, drag.blocked); drag.last = t; }
  else if (drag && 'b' in drag) drag.b = { x: Math.min(Math.max(t.x, 0), S.doc.w - 1), y: Math.min(Math.max(t.y, 0), S.doc.h - 1) };
  else if (drag?.kind === 'basemove' && inMap(t.x, t.y)) moveBaseEvent(drag.id, t.x, t.y);
  else if (drag?.kind === 'evmove' && inMap(t.x, t.y) && (t.x !== S.doc.spec.events[drag.i].x || t.y !== S.doc.spec.events[drag.i].y)) moveEvent(drag.i, t.x, t.y);
  requestDraw();
});
const short = n => n.replace(/^GROUND\s*-\s*/i, 'G').replace(/^ABOVE ALL\s*-\s*/i, 'A').replace(/^SAME AS CHARACTER\s*-?\s*/i, 'C').replace(/^same as character$/i, 'C');
const tileInfo = (x, y) => {
  const be = S.doc.gameEvents && S.show.events ? S.doc.gameEvents.find(e => e && basePos(e)[0] === x && basePos(e)[1] === y) : null;
  if (be) return `   ${be.name}`;
  const r = tileAt(S.layer, x, y);
  const here = layersAt(y * S.doc.w + x);
  const stack = here.length ? `   [${here.map(n => `${short(n)}${n === S.layer ? '*' : ''}`).join(' ')}]` : '';
  return `${stack}${r ? `   ${r.source.replace(/\.json$/i, '')} #${r.local}` : ''}${wallAt(x, y) ? '   WALL' : ''}`;
};

function finish(e) {
  if (!drag) return;
  const dd = drag; drag = null; cv.style.cursor = cursorFor();
  try { cv.releasePointerCapture(e.pointerId); } catch { /* not captured */ }
  if (dd.kind === 'paint' || dd.kind === 'wall') endStroke(dd.stroke);
  else if (dd.kind === 'rect') {
    const [rx, ry, rw, rh] = rectOf(dd.a, dd.b), stroke = beginStroke();
    for (let y = ry; y < ry + rh; y++) for (let x = rx; x < rx + rw; x++) { if (dd.erase) paintCell(stroke, S.layer, x, y, 'erase'); else { const v = palTile(x - rx, y - ry); if (v) paintCell(stroke, S.layer, x, y, v); } }
    endStroke(stroke);
  } else if (dd.kind === 'wallrect') {
    const [rx, ry, rw, rh] = rectOf(dd.a, dd.b), stroke = beginStroke();
    for (let y = ry; y < ry + rh; y++) for (let x = rx; x < rx + rw; x++) wallCell(stroke, x, y, !dd.erase);
    endStroke(stroke);
  }
  requestDraw();
}
cv.addEventListener('pointerup', finish);
cv.addEventListener('pointercancel', finish);
cv.addEventListener('pointerleave', () => { if (!drag) { hover = null; $pos.textContent = ''; requestDraw(); } });

cv.addEventListener('wheel', e => {
  e.preventDefault();
  const [px, py] = local(e);
  const mouseWheel = e.deltaMode !== 0 || (Math.abs(e.deltaY) >= 50 && Number.isInteger(e.deltaY) && e.deltaX === 0);
  if (e.ctrlKey || e.metaKey || mouseWheel) zoomBy(e.deltaY < 0 ? 1 : -1, px, py);   // pinch, or a wheel with notches
  else { view.ox -= e.deltaX; view.oy -= e.deltaY; requestDraw(); }                  // two-finger scroll pans
}, { passive: false });

// space = temporary hand
const typing = () => /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName);
window.addEventListener('keydown', e => { if (e.code === 'Space' && !typing() && !document.querySelector('dialog[open]')) { spaceDown = true; cv.style.cursor = 'grab'; if (e.target === document.body || e.target === cv) e.preventDefault(); } });
window.addEventListener('keyup', e => { if (e.code === 'Space') { spaceDown = false; cv.style.cursor = cursorFor(); } });

// ------------------------------------------------------------ hints, cursor, hud
const HINTS = {
  brush: 'BRUSH: click or drag to paint the picked tile. Right-click erases. Alt+click picks a tile from the map.',
  rect: 'RECTANGLE: drag to fill an area with the picked tile. Right-drag clears an area.',
  fill: 'FILL: click to fill a connected area of the same tile. Right-click clears it.',
  eraser: 'ERASER: clears tiles on the layer you are on. Hold Shift to clear every layer under the mouse.',
  walls: 'WALLS: click or drag to block tiles. Right-click opens them. Hold Shift and drag for a rectangle.',
  stamp: 'STAMP: click to copy the piece you picked in the STAMP tab onto this map. It lands with its top-left under the mouse.',
  event: 'EVENTS: click an empty tile to add an NPC or trigger. Click one to select it, drag to move it, Delete removes it. Events the map already had can be dragged too.',
  pick: 'PICK: click a tile to use it. Alt+click does this in any painting tool.',
  pan: 'HAND: drag to move around. Hold Space for this in any tool. Scroll or +/- to zoom.',
};
const cursorFor = () => (S.tool === 'pan' ? 'grab' : S.tool === 'event' ? 'pointer' : 'crosshair');
function refreshHud() {
  $hint.textContent = S.doc?.readonly ? 'VIEW ONLY. Move around with H or Space, scroll to zoom, I picks a tile. Make a new map to edit.' : S.doc ? HINTS[S.tool] : 'Pick a mod, then open or create a map.';
  cv.style.cursor = cursorFor();
  const paints = ['brush', 'rect', 'fill', 'eraser', 'pick'].includes(S.tool);
  $hudLayer.hidden = !S.doc || !(paints || S.doc.readonly);
  document.getElementById('zoomBox').hidden = !S.doc;
  $hudLayer.textContent = S.doc?.readonly ? 'VIEW ONLY: made by this mod\'s build scripts' : `On layer: ${layerLabel(S.layer)}`;
}
for (const ev of ['doc', 'tool', 'layer', 'palette', 'select', 'image', 'open']) on(ev, () => { refreshHud(); requestDraw(); });
on('open', arg => { if (!arg?.keepView) fitView(); });
document.getElementById('vGrid').onchange = e => { S.show.grid = e.target.checked; requestDraw(); };
document.getElementById('vWalls').onchange = e => { S.show.walls = e.target.checked; requestDraw(); };
document.getElementById('vEvents').onchange = e => { S.show.events = e.target.checked; requestDraw(); };
document.getElementById('vDim').onchange = e => { S.show.dim = e.target.checked; requestDraw(); };
document.getElementById('vEdits').onchange = e => { S.show.edits = e.target.checked; requestDraw(); };
document.getElementById('vRuler').onchange = e => { S.show.ruler = e.target.checked; requestDraw(); };
document.getElementById('zIn').onclick = () => zoomBy(1);
document.getElementById('zOut').onclick = () => zoomBy(-1);
document.getElementById('zFit').onclick = fitView;
resize(); refreshHud();
