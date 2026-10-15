// Small pictures of pieces and starting points, drawn from the real game maps they are copied from.
import { api } from './api.js';
import { drawTileLayers } from './canvas.js';
import { on } from './store.js';
import { TILE } from './spec.js';
import { h } from './util.js';

const maps = new Map();
/** A game map ready to draw from, loaded once. */
export const refMap = id => {
  if (!maps.has(id)) maps.set(id, api.gameMap(id).then(r => ({ id, name: r.name, tiled: r.tiled, defs: r.tilesetDefs })));
  return maps.get(id);
};

const pending = new Set();
let queued = false;
on('image', () => {
  if (queued) return;
  queued = true;
  requestAnimationFrame(() => { queued = false; for (const t of [...pending]) { if (!t.canvas.isConnected) pending.delete(t); else t.draw(); } });
});

/** parts: [{ map, rect:[x,y,w,h], at:[x,y] }] drawn together; scaled to fit the box. */
export function thumb(parts, boxW = 150, boxH = 96) {
  const W = Math.max(...parts.map(p => p.at[0] + p.rect[2])), H = Math.max(...parts.map(p => p.at[1] + p.rect[3]));
  const z = Math.min(boxW / (W * TILE), boxH / (H * TILE), 1);
  const canvas = h('canvas', { width: Math.max(1, Math.ceil(W * TILE * z)), height: Math.max(1, Math.ceil(H * TILE * z)), style: 'image-rendering:pixelated;max-width:100%' });
  const draw = async () => {
    const g = canvas.getContext('2d'); g.imageSmoothingEnabled = false;
    g.fillStyle = '#181818'; g.fillRect(0, 0, canvas.width, canvas.height);
    for (const p of parts) {
      const m = await refMap(p.map);
      drawTileLayers(g, m.tiled, m.defs, { rect: [p.rect[0], p.rect[1], p.rect[0] + p.rect[2], p.rect[1] + p.rect[3]], at: [p.at[0] * TILE * z, p.at[1] * TILE * z], z });
    }
  };
  draw();
  pending.add({ canvas, draw });
  return canvas;
}
export const pieceThumb = (p, w, hh) => thumb([{ map: p.map, rect: p.rect, at: [0, 0] }], w, hh);
