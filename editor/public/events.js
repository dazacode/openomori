// The EVENTS tab: list of events on this map, and the form for the selected one (sprite, trigger, pages, steps).
import { S, on, edit, selectEvent, deleteEvent, toggleRemoveGameEvent, spriteOf, getImage, addEvent, basePos } from './store.js';
import { commandList, pageConditions } from './commands.js';
import { centerOn, view } from './canvas.js';
import { modal } from './dialogs.js';
import { h, clone } from './util.js';
import { TILE } from './spec.js';

const TRIGGERS = [['action', 'Player presses the action button'], ['touch', 'Player steps on it'], ['event-touch', 'It touches the player'], ['auto', 'Runs by itself, once'], ['parallel', 'Runs by itself, over and over']];
const PRIORITY = [['below', 'Under the player (floor)'], ['same', 'Same level as the player (solid)'], ['above', 'Above the player']];

/** Turn the flat `do` / `if` form into `pages` so every page can be edited the same way. Meaning is unchanged. */
function ensurePages(ev) {
  if (ev.pages) return;
  ev.pages = [{ ...(ev.if ? { if: ev.if } : {}), do: ev.do ?? [] }];
  delete ev.if; delete ev.do;
}

const pendingFrames = new Set();
on('image', () => { for (const f of [...pendingFrames]) { if (!f.canvas.isConnected) pendingFrames.delete(f); else if (f.draw()) pendingFrames.delete(f); } });

/** First frame of a sprite sheet drawn into a small canvas; fills in once the image arrives. */
function frameInto(canvas, sp) {
  const draw = () => {
    const c = canvas.getContext('2d'); c.clearRect(0, 0, canvas.width, canvas.height); c.imageSmoothingEnabled = false;
    const img = sp?.name && getImage('characters', sp.name);
    if (!img) { c.fillStyle = '#777'; c.font = '14px OmoriGame, monospace'; c.fillText(sp?.name ? '…' : 'none', 6, 34); return !sp?.name; }
    const frames = /%\((\d+)\)/.exec(sp.name), single = /^!?\$/.test(sp.name) || !!frames;
    const cols = frames ? Number(frames[1]) : single ? 3 : 12, rows = single ? 4 : 8, fw = img.width / cols, fh = img.height / rows;
    const bx = single ? 0 : (sp.index % 4) * 3, by = single ? 0 : Math.floor(sp.index / 4) * 4;
    const k = Math.min(canvas.width / fw, canvas.height / fh, 3);
    c.drawImage(img, (bx + (frames ? 0 : sp.pattern ?? 1)) * fw, by * fh, fw, fh, (canvas.width - fw * k) / 2, canvas.height - fh * k, fw * k, fh * k);
    return true;
  };
  if (!draw()) pendingFrames.add({ canvas, draw });
  return canvas;
}

export async function pickSprite(current) {
  let chosen;
  const search = h('input', { type: 'search', placeholder: 'Search sprite sheets…', class: 'grow', 'aria-label': 'Search sprite sheets' });
  const grid = h('div', { class: 'sprite-grid' });
  // sheet names: "!" marks objects (doors, props), "[SF]" effects, everything else is a person or creature
  const CATS = [['people', 'PEOPLE', n => !/^[![]/.test(n)], ['objects', 'OBJECTS', n => n.startsWith('!')], ['effects', 'EFFECTS', n => n.startsWith('[')], ['all', 'ALL', () => true]];
  let cat = 'people';
  const chips = h('div', { class: 'row tight' });
  const drawChips = () => chips.replaceChildren(...CATS.map(([id, label]) => h('button', { type: 'button', class: 'chip', 'aria-pressed': String(cat === id), onclick: () => { cat = id; drawChips(); show(); } }, label)));
  const show = () => {
    const q = search.value.trim().toLowerCase(), inCat = CATS.find(c => c[0] === cat)[2];
    const names = S.sprites.filter(n => (q ? true : inCat(n)) && (!q || n.toLowerCase().includes(q))).slice(0, 400);
    grid.replaceChildren(...names.map(n => {
      const cv = h('canvas', { width: 64, height: 64 });
      const cell = h('button', { type: 'button', class: 'sprite-cell', title: n }, cv, n);
      cell.onclick = () => chooseBlock(n);
      new IntersectionObserver((es, ob) => { if (es[0].isIntersecting) { ob.disconnect(); frameInto(cv, { name: n, index: 0, pattern: 1 }); } }).observe(cell);
      return cell;
    }));
    if (!names.length) grid.append(h('div', { class: 'help' }, 'No sprite sheet matches that.'));
  };
  let finish;
  const chooseBlock = name => {
    const single = /^!?\$/.test(name) || /%\(\d+\)/.test(name);
    if (single) return finish({ name, index: 0 });
    // a normal sheet holds up to 8 characters in a 4x2 block layout
    const wrap = h('div', {}, h('div', { class: 'help' }, `${name}: click the one you want.`), h('div', { class: 'row', style: 'flex-wrap:wrap' },
      ...Array.from({ length: 8 }, (_, i) => { const cv = h('canvas', { width: 80, height: 80, style: 'cursor:pointer;border:2px solid #5a5a5a;background:#111' }); frameInto(cv, { name, index: i, pattern: 1 }); cv.onclick = () => finish({ name, index: i }); return cv; })),
      h('button', { type: 'button', class: 'chip', style: 'margin-top:10px', onclick: () => { body.replaceChildren(top, grid); show(); } }, '← back to the sheets'));
    body.replaceChildren(wrap);
  };
  const top = h('div', {}, h('div', { class: 'row', style: 'margin-bottom:8px' }, search, h('button', { type: 'button', class: 'chip', onclick: () => finish('none') }, 'No sprite (invisible)')), h('div', { class: 'row', style: 'margin-bottom:10px' }, chips, h('span', { class: 'dim' }, 'searching looks in every group')));
  const body = h('div', {}, top, grid);
  search.oninput = show; drawChips();
  const result = modal('CHOOSE A SPRITE', done => { finish = done; return body; }, [{ label: 'CANCEL', value: null }], { wide: true });
  show();
  chosen = await result;
  return chosen;
}

const posText = ev => `(${ev.x}, ${ev.y})`;

export function eventsPanel() {
  const d = S.doc, events = d.spec.events ?? [];
  const sel = S.selEvent >= 0 ? events[S.selEvent] : null;
  if (sel) ensurePages(sel);
  const ctxFor = coalesce => ({ apply: (fn, structural) => edit(fn, { coalesce, quiet: !structural }) });

  const list = h('div', { class: 'list' }, events.length ? events.map((e, i) => h('button', { class: 'item', 'aria-selected': String(i === S.selEvent), onclick: () => { selectEvent(i); centerOn(e.x, e.y); } },
    h('span', { class: 'id' }, `#${i + 1}`), h('span', { class: 'grow' }, e.name), h('span', { class: 'dim' }, posText(e)))) : h('div', { class: 'help', style: 'padding:6px' }, 'No events yet. They are the people, doors and triggers on a map.'));

  const head = h('div', { class: 'sect' }, h('h3', {}, `EVENTS (${events.length})`, h('button', { class: 'mini', title: 'Add an event in the middle of the view', onclick: () => {
    const st = document.getElementById('stage');
    const x = Math.min(d.w - 1, Math.max(0, Math.floor((st.clientWidth / 2 - view.ox) / (TILE * view.z)))), y = Math.min(d.h - 1, Math.max(0, Math.floor((st.clientHeight / 2 - view.oy) / (TILE * view.z))));
    addEvent(x, y);
  } }, '+ NEW')), list,
    h('div', { class: 'help' }, 'Tip: pick the Event tool (N) and click an empty tile to add one right where you want it.'));

  const form = sel ? eventForm(sel, ctxFor) : h('div', { class: 'help' }, events.length ? 'Select an event to edit it.' : '');
  const game = d.gameEvents?.length ? gameEvents(d) : null;
  return h('div', {}, head, form, game);
}

function gameEvents(d) {
  const removed = new Set(d.spec.removeEvents ?? []), own = d.spec.snapshot;
  return h('div', { class: 'sect' }, h('h3', {}, `${own ? 'THE MAP\'S OWN' : 'GAME'} EVENTS (${d.gameEvents.filter(Boolean).length})`),
    h('div', { class: 'help' }, `${own ? 'These come from the mod\'s scripts' : 'These came with the game\'s map'} and are kept. Drag one on the map (Event tool) to move it, or tick it to delete it from your version. Their dialogue and steps are not editable here.`),
    h('div', { class: 'list' }, d.gameEvents.filter(Boolean).map(e => { const [x, y] = basePos(e); return h('label', { class: 'item game' },
      h('input', { type: 'checkbox', checked: removed.has(e.id), onchange: () => toggleRemoveGameEvent(e.id) }),
      h('span', { class: 'id' }, `#${e.id}`), h('span', { class: 'grow' }, e.name), h('span', { class: 'dim', onclick: ev => { ev.preventDefault(); centerOn(x, y); } }, `(${x}, ${y})`)); })));
}

function eventForm(ev, ctxFor) {
  const i = S.selEvent, quiet = (fn, key) => edit(fn, { coalesce: key, quiet: true }), loud = fn => edit(fn);
  const sp = spriteOf(ev);
  const thumb = h('button', { class: 'sprite-btn', title: sp ? 'Change the sprite' : 'Choose a sprite', onclick: async () => {
    const r = await pickSprite(sp); if (!r) return;
    loud(() => { if (r === 'none') delete ev.sprite; else ev.sprite = r.index ? { name: r.name, index: r.index } : r.name; });
  } }, frameInto(h('canvas', { width: 56, height: 56 }), sp));
  const nameIn = h('input', { type: 'text', class: 'grow', value: ev.name, 'aria-label': 'Event name', oninput: e => quiet(() => { ev.name = e.target.value; }, `n${i}`) });
  const xy = (k) => h('input', { type: 'number', min: 0, value: String(ev[k]), 'aria-label': k.toUpperCase(), onchange: e => quiet(() => { ev[k] = Math.max(0, Math.round(Number(e.target.value))); }, `p${i}`) });
  const trig = ev.trigger ?? 'action';
  const sets = ctxFor(`c${i}`);
  const pages = ev.pages;

  const pageEls = pages.map((p, pi) => h('div', { class: 'page' },
    h('header', {}, h('span', {}, `PAGE ${pi + 1}${pi === pages.length - 1 && pages.length > 1 ? '  (wins when its conditions hold)' : ''}`),
      h('span', { class: 'row tight' },
        h('button', { class: 'mini', title: 'Move page up', disabled: pi === 0, onclick: () => loud(() => { [pages[pi - 1], pages[pi]] = [pages[pi], pages[pi - 1]]; }) }, '▲'),
        h('button', { class: 'mini', title: 'Move page down', disabled: pi === pages.length - 1, onclick: () => loud(() => { [pages[pi + 1], pages[pi]] = [pages[pi], pages[pi + 1]]; }) }, '▼'),
        pages.length > 1 ? h('button', { class: 'mini', title: 'Delete this page', onclick: () => loud(() => { pages.splice(pi, 1); }) }, '✕') : null)),
    h('div', { class: 'body' },
      h('div', { class: 'sect' }, h('h3', {}, 'RUNS WHEN'), pageConditions(p, sets.apply)),
      pageSprite(ev, p, loud),
      h('div', { class: 'sect' }, h('h3', {}, 'WHAT HAPPENS'), commandList((p.do ??= []), sets)))));

  return h('div', { class: 'sect' },
    h('h3', {}, `EVENT #${i + 1}`, h('button', { class: 'mini danger', title: 'Delete this event (Delete)', onclick: () => deleteEvent(i) }, 'DELETE')),
    h('div', { class: 'ev-head' }, thumb, h('div', { class: 'grow' }, h('div', { class: 'row' }, nameIn), h('div', { class: 'row', style: 'margin-top:6px' }, 'x', xy('x'), 'y', xy('y')))),
    h('div', { class: 'kv' },
      h('label', {}, 'Starts when'), h('select', { onchange: e => loud(() => { ev.trigger = e.target.value; }) }, TRIGGERS.map(([v, l]) => h('option', { value: v, selected: trig === v }, l))),
      h('label', {}, 'Stands'), h('select', { onchange: e => loud(() => { ev.priority = e.target.value; }) }, PRIORITY.map(([v, l]) => h('option', { value: v, selected: (ev.priority ?? (sp ? 'same' : 'below')) === v }, l))),
      h('label', {}, 'Walk through'), h('label', { class: 'row tight' }, h('input', { type: 'checkbox', checked: !!ev.through, onchange: e => loud(() => { ev.through = e.target.checked; if (!ev.through) delete ev.through; }) }), 'player can walk over it')),
    pageEls,
    h('button', { class: 'btn', onclick: () => loud(() => { pages.push({ if: { self: 'A' }, do: [] }); }) }, '+ ADD PAGE'),
    h('div', { class: 'help' }, 'Pages let an event change: the last page whose conditions are true runs. Add one for "after you talk to them".'));
}

function pageSprite(ev, p, loud) {
  const own = p.sprite !== undefined;
  const sp = own ? (typeof p.sprite === 'string' ? { name: p.sprite, index: 0, dir: 2, pattern: 1 } : { index: 0, dir: 2, pattern: 1, ...p.sprite }) : null;
  return h('div', { class: 'row', style: 'margin-bottom:8px' }, h('span', { class: 'dim' }, 'Sprite'),
    own ? [frameInto(h('canvas', { width: 40, height: 40 }), sp), h('button', { class: 'chip', onclick: () => loud(() => { delete p.sprite; }) }, 'use the event\'s sprite')]
      : h('span', { class: 'dim' }, 'same as the event'),
    h('button', { class: 'chip', onclick: async () => { const r = await pickSprite(sp); if (!r) return; loud(() => { p.sprite = r === 'none' ? { name: '' } : r.index ? { name: r.name, index: r.index } : r.name; }); } }, own ? 'change' : 'different on this page'));
}
void clone;
