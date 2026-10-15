// A one-line "what next?" under the tabs. It looks at the map and says the next sensible step, so nobody has to know the whole tool first.
import { S, on, setTool } from './store.js';
import { isCollisionLayer } from './spec.js';
import { h, debounce } from './util.js';

const $coach = document.getElementById('coach');
const KEY = 'omori-editor-tips-off';
let off = false;
try { off = localStorage.getItem(KEY) === '1'; } catch { /* storage may be off */ }
let dismissedFor = null;

const hasTransfer = list => (list ?? []).some(c => c && ('transfer' in c || hasTransfer(c.then) || hasTransfer(c.else)));
const eventsHaveExit = events => events.some(e => hasTransfer(e.do) || (e.pages ?? []).some(p => hasTransfer(p.do)));

function advice() {
  const d = S.doc;
  if (!d || d.readonly) return null;
  let tiles = 0, walls = 0;
  for (const l of d.tiled.layers) {
    if (l.type !== 'tilelayer') continue;
    const isWall = isCollisionLayer(l.name);
    for (const v of l.data) if (v) { if (isWall) walls++; else tiles++; }
  }
  const mine = d.spec.events ?? [], theirs = (d.gameEvents ?? []).length;
  const go = (text, button, fn) => ({ text, button, fn });
  if (!d.spec.snapshot && tiles === 0) return go('Your map is empty. Start by placing a ready-made piece (a house, a street, a room).', 'SHOW PIECES', () => document.dispatchEvent(new CustomEvent('editor:tab', { detail: 'stamp' })));
  if (walls === 0) return go('Nothing blocks the player yet, so they can walk through everything. Press C, then click the tiles that should be solid.', 'WALLS TOOL', () => setTool('walls'));
  if (mine.length === 0 && theirs === 0) return go('Add a person, a sign or a door. Press N, then click a tile.', 'EVENT TOOL', () => setTool('event'));
  if (!eventsHaveExit(mine) && !d.spec.snapshot && !d.spec.base) return go('Players need a way out. Put a "Go to another map" step on a door (set it to start when the player steps on it).', 'EVENT TOOL', () => setTool('event'));
  if (S.dirty) return go('You have unsaved changes. Press Ctrl+S to keep them.', 'SAVE', () => document.getElementById('saveBtn').click());
  return go(`Looks ready. Press BUILD, reload the game, then press F9 in the game and teleport to map ${d.id}.`, 'BUILD', () => document.getElementById('buildBtn').click());
}

function draw() {
  const a = !off && S.doc ? advice() : null;
  if (a && dismissedFor === `${S.doc.id}:${a.text}`) { $coach.hidden = true; return; }
  $coach.hidden = !a;
  if (!a) return;
  $coach.replaceChildren(h('b', {}, 'NEXT'), h('span', { class: 'grow' }, a.text),
    h('button', { class: 'chip', onclick: a.fn }, a.button),
    h('button', { class: 'mini', title: 'Hide this tip', 'aria-label': 'Hide this tip', onclick: () => { dismissedFor = `${S.doc.id}:${a.text}`; draw(); } }, '✕'));
}
const soon = debounce(draw, 250);
for (const ev of ['doc', 'open', 'dirty', 'tool']) on(ev, soon);

const box = document.getElementById('vTips');
if (box) { box.checked = !off; box.onchange = () => { off = !box.checked; try { localStorage.setItem(KEY, off ? '1' : '0'); } catch { /* ignore */ } draw(); }; }
draw();
