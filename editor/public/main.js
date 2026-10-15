// Boot, top bar, dialogs for new/edit/help/problems, and keyboard shortcuts.
import './canvas.js';
import './left.js';
import './panels.js';
import './coach.js';
import {
  S, on, loadStatics, selectMod, openMap, openBuilt, openGameView, imagesPending, save, build, undo, redo, canUndo, canRedo, setTool, setLayer, tileLayers,
  deleteEvent, currentMod, selectEvent, reloadMods, startWatching, reloadFromDisk,
} from './store.js';
import { api } from './api.js';
import { centerOn, fitView, zoomBy, requestDraw, view, cleanView } from './canvas.js';
import { TOOLS } from './left.js';
import { showTab } from './panels.js';
import { modal, confirmBox } from './dialogs.js';
import { freeId } from './spec.js';
import { thumb } from './thumbs.js';
import { h, $, toast } from './util.js';

const $mod = $('#modSel'), $map = $('#mapSel'), $empty = $('#empty'), $problems = $('#problemsBtn');
const LAST = 'omori-editor-last';
const remember = () => { try { localStorage.setItem(LAST, JSON.stringify({ mod: S.mod, map: S.doc?.id ?? null })); } catch { /* private mode */ } };
const recall = () => { try { return JSON.parse(localStorage.getItem(LAST) ?? '{}'); } catch { return {}; } };

// ------------------------------------------------------------ top bar
function drawMods() {
  $mod.replaceChildren(...(S.mods.length ? S.mods.map(m => h('option', { value: m.name, selected: m.name === S.mod }, m.name)) : [h('option', { value: '' }, '(no mods found)')]));
  drawMaps();
  drawEmpty();
}
function drawMaps() {
  const mod = currentMod();
  const label = S.doc ? `${S.doc.id} · ${S.doc.spec.name ?? mod?.maps.find(m => m.id === S.doc.id)?.name ?? 'map'}` : mod?.maps.length || mod?.built?.length ? '— choose a map —' : '— no maps yet —';
  const specs = (mod?.maps ?? []).filter(m => m.id !== S.doc?.id), built = (mod?.built ?? []).filter(m => m.id !== S.doc?.id);
  $map.replaceChildren(
    h('option', { value: '' }, label),
    specs.length ? h('optgroup', { label: 'Editable maps' }, specs.map(m => h('option', { value: String(m.id) }, `${m.id} · ${m.name}${m.base ? ' (game map)' : m.taken ? ' (taken over)' : ''}`))) : null,
    built.length ? h('optgroup', { label: `View only (${built.length}): made by this mod's scripts` }, built.map(m => h('option', { value: `b${m.id}` }, `${m.id} · ${m.name}`))) : null,
    h('option', { value: '__new' }, '＋ New map…'), h('option', { value: '__edit' }, '✎ Edit a game map…'));
  $map.value = S.doc ? $map.options[0].value : '';
}
function drawEmpty() {
  $empty.hidden = !!S.doc;
  if (S.doc) return;
  const card = $empty.querySelector('.card');
  const none = !S.mods.length;
  card.querySelector('p.dim').textContent = none
    ? 'No mods found. Make one first: run  bun run mod new my-story  in the browser folder, then reload this page.'
    : currentMod()?.built?.length && !currentMod()?.maps.length ? `This mod has ${currentMod().built.length} maps, all made by its own build scripts. Open any from the MAP menu to look at it (view only), or start a new map here.`
    : currentMod()?.maps.length ? 'Choose one of this mod\'s maps from the MAP menu, or start a new one.' : 'This mod has no maps yet. Start with a new map, or edit one of the game\'s.';
  $('#emptyNew').disabled = $('#emptyEdit').disabled = none;
}

/** Ask what to do with unsaved changes. Returns false if the user cancels. */
async function guard() {
  if (!S.dirty) return true;
  const r = await modal('UNSAVED CHANGES', h('p', {}, `Save your changes to map ${S.doc.id} first?`), [
    { label: 'CANCEL', value: 'cancel' }, { label: 'DISCARD', value: 'discard', danger: true }, { label: 'SAVE', value: 'save', primary: true }]);
  if (r === 'save') { await save(); return true; }
  return r === 'discard';
}
async function open(id) {
  try { await openMap(id); remember(); drawMaps(); drawEmpty(); } catch (e) { toast(e.message, 'bad'); drawMaps(); }
}
async function openView(id) {
  try { await openBuilt(id); drawMaps(); drawEmpty(); } catch (e) { toast(e.message, 'bad'); drawMaps(); }
}
$mod.onchange = async () => { if (!(await guard())) { $mod.value = S.mod; return; } await selectMod($mod.value); remember(); drawMods(); };
$map.onchange = async () => {
  const v = $map.value;
  if (!(await guard())) { drawMaps(); return; }
  if (v === '__new') return newMapDialog();
  if (v === '__edit') return editGameMapDialog();
  if (v.startsWith('b')) openView(Number(v.slice(1))); else if (v) open(Number(v)); else drawMaps();
};

// ------------------------------------------------------------ pick a game map (shared by two dialogs)
function mapPicker(initial) {
  let value = initial, filter = '';
  const list = h('div', { class: 'list', style: 'max-height:220px' });
  const label = h('div', { class: 'help' });
  const paint = () => {
    const q = filter.trim().toLowerCase();
    const matches = q ? S.gameMaps.filter(m => String(m.id) === q || m.name.toLowerCase().includes(q)) : S.gameMaps;
    const chosen = matches.find(m => m.id === value);   // keep the current choice on top so it is always in view
    const rows = (chosen ? [chosen, ...matches.filter(m => m !== chosen)] : matches).slice(0, 120);
    list.replaceChildren(...(rows.length ? rows.map(m => h('button', { type: 'button', class: 'item', 'aria-selected': String(m.id === value), onclick: () => { value = m.id; paint(); } }, h('span', { class: 'id' }, m.id), h('span', {}, m.name)))
      : [h('div', { class: 'help', style: 'padding:6px' }, 'No map matches that.')]));
    const m = S.gameMaps.find(x => x.id === value);
    label.textContent = m ? `Selected: ${m.id} · ${m.name}` : 'Nothing selected.';
  };
  const search = h('input', { type: 'search', style: 'width:100%', placeholder: 'Search by name or number…', oninput: e => { filter = e.target.value; paint(); }, 'aria-label': 'Search game maps' });
  paint();
  return { el: h('div', {}, search, h('div', { style: 'margin:6px 0' }, list), label), get: () => value };
}

/** What a starting point looks like, drawn from the game maps it is copied from. */
function templateParts(t) {
  const parts = (t.stamps ?? []).map(st => { const p = st.piece ? S.library.pieces.find(x => x.id === st.piece) : null; return { map: p?.map ?? st.from, rect: p?.rect ?? st.rect, at: st.at }; });
  return parts.length ? parts : null;
}

async function newMapDialog() {
  const mod = currentMod(); if (!mod) return;
  const taken = new Set([...S.gameMaps.map(m => m.id), ...mod.maps.map(m => m.id), ...(mod.used ?? [])]);
  const templates = S.library.templates.length ? S.library.templates : [{ id: 'blank', name: 'Blank', blurb: 'An empty outdoor map.', size: [30, 20], tilesFrom: 13, stamps: [] }];
  let vals = { id: freeId(taken), name: '', w: templates[0].size[0], h: templates[0].size[1], art: 13, template: templates[0].id }, err = '';
  for (;;) {
    const picker = mapPicker(vals.art);
    const f = {
      id: h('input', { type: 'number', min: 1000, value: String(vals.id) }), name: h('input', { type: 'text', value: vals.name, placeholder: 'e.g. MY STREET', class: 'grow' }),
      w: h('input', { type: 'number', min: 5, max: 300, value: String(vals.w) }), h: h('input', { type: 'number', min: 5, max: 300, value: String(vals.h) }),
    };
    const artBox = h('div', { class: 'sect', style: 'margin-top:14px' }, h('h3', {}, 'STYLE OF ART'), h('div', { class: 'help' }, 'Which game map\'s tilesets to start from. You can still borrow pieces from any map later. Map 13 is a good outdoor start.'), picker.el);
    const cards = h('div', { class: 'tpls' });
    const drawCards = () => {
      cards.replaceChildren(...templates.map(t => {
        const parts = templateParts(t);
        const pt = h('div', { class: 'pt' }, parts ? thumb(parts, 140, 76) : h('span', { class: 'dim' }, 'empty'));
        return h('button', { type: 'button', class: 'tpl', 'aria-pressed': String(vals.template === t.id), onclick: () => { vals.template = t.id; f.w.value = String(t.size[0]); f.h.value = String(t.size[1]); drawCards(); } },
          pt, h('div', { class: 'pn' }, t.name), h('div', { class: 'ps' }, t.blurb), h('div', { class: 'ps' }, `${t.size[0]}×${t.size[1]} tiles`));
      }));
      artBox.hidden = vals.template !== 'blank';
    };
    drawCards();
    const body = h('div', {}, err ? h('div', { class: 'note bad' }, err) : null,
      h('div', { class: 'sect' }, h('h3', {}, 'START WITH'), cards),
      h('div', { class: 'kv' }, h('label', {}, 'Map id'), h('div', { class: 'row tight' }, f.id, h('span', { class: 'dim' }, '1000 or higher; the game uses up to 999')),
        h('label', {}, 'Name'), h('div', { class: 'row' }, f.name),
        h('label', {}, 'Size'), h('div', { class: 'row tight' }, f.w, '×', f.h, h('span', { class: 'dim' }, ' tiles (30×20 fits one screen)'))),
      artBox);
    const go = await modal('NEW MAP', body, [{ label: 'CANCEL', value: false }, { label: 'CREATE', value: true, primary: true }], { wide: true });
    if (!go) { drawMaps(); return; }
    vals = { ...vals, id: Number(f.id.value), name: f.name.value.trim(), w: Number(f.w.value), h: Number(f.h.value), art: picker.get() };
    try {
      await api.newMap(S.mod, { id: vals.id, name: vals.name || `MAP ${vals.id}`, size: [vals.w, vals.h], template: vals.template, ...(vals.template === 'blank' ? { tilesFrom: vals.art } : {}) });
      await reloadMods(); drawMods(); return open(vals.id);
    } catch (e) { err = e.message; }
  }
}

async function editGameMapDialog() {
  const mod = currentMod(); if (!mod) return;
  let err = '';
  for (;;) {
    const picker = mapPicker(null);
    const body = h('div', {}, err ? h('div', { class: 'note bad' }, err) : null,
      h('div', { class: 'note' }, 'This makes a changed copy of one of the game\'s maps. It replaces the whole map for players of your mod, so two mods that change the same map will clash. Making a NEW map and borrowing from it is usually safer.'),
      picker.el);
    const go = await modal('EDIT A GAME MAP', body, [{ label: 'CANCEL', value: false }, { label: 'EDIT THIS MAP', value: true, primary: true }], { wide: true });
    if (!go) { drawMaps(); return; }
    const id = picker.get();
    if (id === null) { err = 'Pick a map first.'; continue; }
    const have = mod.maps.find(m => m.id === id);
    try {
      if (!have) await api.newMap(S.mod, { id, base: id });
      await reloadMods(); drawMods(); return open(id);
    } catch (e) { err = e.message; }
  }
}
$('#emptyNew').onclick = newMapDialog;
$('#emptyEdit').onclick = editGameMapDialog;

// ------------------------------------------------------------ save / build / problems / help
async function doSave() {
  if (!S.doc) return;
  try { await save(); toast('Saved.', 'ok', 1200); } catch (e) { toast(`Could not save: ${e.message}`, 'bad'); }
}
async function doBuild() {
  if (!S.doc) return;
  const b = $('#buildBtn'); b.disabled = true;
  try {
    const r = await build();
    if (!r.ok) { await showProblems(r.errors, r.warnings, 'BUILD FAILED'); toast('Build failed. Nothing was written. See the list.', 'bad'); }
    else if (r.warnings.length) { toast(`Built ${r.written.length} files${r.mirrored ? ' and copied them to the game' : ''} with ${r.warnings.length} warning${r.warnings.length > 1 ? 's' : ''}. Reload the game tab to see it.`, 'ok', 5000); }
    else toast(`Built ${r.written.length} files${r.mirrored ? ' and copied them to the game' : ''}. Reload the game tab to see it.`, 'ok', 4000);
  } catch (e) { toast(e.message, 'bad'); } finally { b.disabled = false; }
}
async function showProblems(errors = S.problems.errors, warnings = S.problems.warnings, title = 'PROBLEMS') {
  const line = (t, cls) => {
    const m = /\((\d+),\s*(\d+)\)/.exec(t);
    return h('div', { class: `logline ${cls}`, style: m ? 'cursor:pointer' : '', onclick: m ? () => { centerOn(Number(m[1]), Number(m[2])); document.getElementById('dlg').close(); } : null }, (cls === 'err' ? '✗ ' : '! ') + t.replace(/^map \d+: /, ''));
  };
  await modal(title, h('div', {}, errors.length || warnings.length ? [...errors.map(e => line(e, 'err')), ...warnings.map(w => line(w, 'warn'))] : h('p', {}, 'No problems found.'),
    h('div', { class: 'help' }, 'Errors stop the build. Warnings still build, but something is probably not what you meant. Click a line with a position to jump there.')));
}
$problems.onclick = () => showProblems();
function drawProblems() {
  const e = S.problems.errors.length, w = S.problems.warnings.length;
  $problems.hidden = !e && !w;
  $problems.className = `problems${e ? ' bad' : ''}`;
  $problems.textContent = e ? `✗ ${e} error${e > 1 ? 's' : ''}${w ? `, ${w} warning${w > 1 ? 's' : ''}` : ''}` : `! ${w} warning${w > 1 ? 's' : ''}`;
}

const HELP = [
  ['B', 'Brush: paint the picked tile'], ['R', 'Rectangle: fill an area'], ['F', 'Fill: flood a region'], ['E', 'Eraser'], ['C', 'Walls: block or open tiles'], ['S', 'Stamp: copy a piece of a game map'],
  ['N', 'Events: add and move NPCs, doors'], ['I', 'Pick a tile from the map (or Alt+click)'], ['H / Space', 'Move around'], ['Right-click', 'Erase (brush) or open (walls)'],
  ['[  ]', 'Switch layer down / up'], ['G  W  V  D', 'Toggle grid, walls, events, dim other layers'], ['+  −  0', 'Zoom in, out, fit'], ['Ctrl+Z', 'Undo (add Shift to redo)'],
  ['Ctrl+S', 'Save'], ['Ctrl+B', 'Save and build'], ['Delete', 'Delete the selected event'], ['Esc', 'Let go of a stamp or event'],
];
function help() {
  modal('HOW THIS WORKS', h('div', {},
    h('p', {}, 'You edit a small file per map: ', h('b', {}, 'maps/<id>.spec.json'), ' in your mod. SAVE writes it. BUILD turns it into the files the game reads. You never need RPG Maker.'),
    h('p', {}, 'The easiest way to get good-looking maps: use ', h('b', {}, 'STAMP'), ' to copy a piece of a real game map (a house, a fence, a tree), then add events and walls on top. Paint single tiles with the ', h('b', {}, 'TILES'), ' tab when you need to.'),
    h('p', {}, 'Tile layers go bottom to top. "Ground" layers are the floor, "With characters" is drawn level with people, "Above" is drawn over them (roofs, tree tops).'),
    h('div', { class: 'help-grid' }, HELP.flatMap(([k, v]) => [h('b', {}, k), h('span', {}, v)]))), [{ label: 'GOT IT', value: null, primary: true }], { wide: true });
}
$('#helpBtn').onclick = help;

// ------------------------------------------------------------ buttons and keys
$('#saveBtn').onclick = doSave;
$('#buildBtn').onclick = doBuild;
$('#undoBtn').onclick = undo;
$('#redoBtn').onclick = redo;
function drawHistory() {
  $('#undoBtn').disabled = !canUndo(); $('#redoBtn').disabled = !canRedo();
  $('#dirtyDot').hidden = !S.dirty;
  $('#saveBtn').disabled = !S.doc || !!S.doc.readonly; $('#buildBtn').disabled = !S.doc || !!S.doc.readonly;
}
on('history', drawHistory); on('dirty', drawHistory); on('open', drawHistory); on('doc', drawHistory);
on('problems', drawProblems); on('open', drawProblems); on('open', () => { drawEmpty(); drawMaps(); });
on('mods', drawMods);
on('busy', () => { document.body.style.cursor = S.busy ? 'progress' : ''; });
window.addEventListener('beforeunload', e => { if (S.dirty) { e.preventDefault(); e.returnValue = ''; } });

const typing = () => /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName) || document.activeElement?.isContentEditable;
const toggle = (id, key) => { const el = $(id); el.checked = !el.checked; S.show[key] = el.checked; requestDraw(); };
window.addEventListener('keydown', e => {
  if (document.querySelector('dialog[open]')) return;
  const mod = e.ctrlKey || e.metaKey, k = e.key;
  if (mod && k.toLowerCase() === 's') { e.preventDefault(); doSave(); return; }
  if (mod && k.toLowerCase() === 'b') { e.preventDefault(); doBuild(); return; }
  if (mod && k.toLowerCase() === 'z' && !typing()) { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
  if (mod && k.toLowerCase() === 'y' && !typing()) { e.preventDefault(); redo(); return; }
  if (typing() || mod || e.altKey) return;
  const tool = TOOLS.find(t => t.key.toLowerCase() === k.toLowerCase());
  if (tool && S.doc) { setTool(tool.id); return; }
  if (!S.doc) { if (k === '?') help(); return; }
  switch (k) {
    case 'g': case 'G': toggle('#vGrid', 'grid'); break;
    case 'w': case 'W': toggle('#vWalls', 'walls'); break;
    case 'v': case 'V': toggle('#vEvents', 'events'); break;
    case 'd': case 'D': toggle('#vDim', 'dim'); break;
    case '+': case '=': zoomBy(1); break;
    case '-': case '_': zoomBy(-1); break;
    case '0': fitView(); break;
    case '[': case ']': { const names = tileLayers().map(l => l.name), i = names.indexOf(S.layer); setLayer(names[Math.max(0, Math.min(names.length - 1, i + (k === ']' ? 1 : -1)))]); break; }
    case 'Delete': case 'Backspace': if (S.selEvent >= 0) { e.preventDefault(); deleteEvent(S.selEvent); } break;
    case 'Escape': if (S.stamp) { S.stamp = null; requestDraw(); } selectEvent(-1); break;
    case '?': help(); break;
  }
});

// a map's file changed under us (another tool, or an agent): reloaded quietly if we have nothing unsaved, otherwise ask
on('external', async () => {
  if (!S.externalChange) return;
  const r = await modal('THIS MAP CHANGED ON DISK', h('p', {}, 'Another tool (or Claude) changed this map\'s file while you have unsaved edits here. Load their version and lose your unsaved edits, or keep yours (saving will overwrite theirs).'),
    [{ label: 'KEEP MINE', value: 'mine' }, { label: 'LOAD THEIRS', value: 'theirs', primary: true }]);
  if (r === 'theirs') { await reloadFromDisk(); toast('Loaded the version from disk.', 'ok'); } else S.externalChange = false;
});
// ------------------------------------------------------------ go
window.OmoriEditor = { S, view };   // read-only handle for tests and the DevTools console
(async () => {
  try {
    await loadStatics();
  } catch (e) { toast(e.message, 'bad'); return; }
  const q = new URLSearchParams(location.search);
  if (q.has('clean')) { await screenshotMode(q); return; }
  const last = recall();
  const startMod = S.mods.find(m => m.name === (q.get('mod') ?? last.mod)) ?? S.mods.find(m => m.maps.length) ?? S.mods[0];
  if (startMod) await selectMod(startMod.name);
  drawMods(); drawHistory(); drawProblems();
  const mod = currentMod();
  const want = q.has('map') ? Number(q.get('map')) : last.map;
  const startMap = mod?.maps.find(m => m.id === want) ?? (mod?.maps.length === 1 ? mod.maps[0] : null);
  if (q.has('game')) open_game(Number(q.get('game')));
  else if (startMap) open(startMap.id);
  else if (q.has('map') && mod?.built.some(m => m.id === want)) openView(want);
  showTab('tiles');
  startWatching();
})();

async function open_game(id) { try { await openGameView(id); drawMaps(); drawEmpty(); } catch (e) { toast(e.message, 'bad'); } }

/** ?clean=1&mod=NAME&map=ID (or &game=ID): draw one map at a fixed size and say when everything has loaded. Used by `map shot`. */
async function screenshotMode(q) {
  document.body.classList.add('clean');
  const zoom = Number(q.get('zoom') ?? 1) || 1;
  try {
    if (q.has('game')) await openGameView(Number(q.get('game')));
    else {
      await selectMod(q.get('mod'));
      const id = Number(q.get('map')), mod = currentMod();
      if (mod?.maps.some(m => m.id === id)) await openMap(id); else await openBuilt(id);
    }
  } catch (e) { document.body.dataset.error = e.message; return; }
  S.show.grid = q.get('grid') === '1'; S.show.walls = q.get('walls') !== '0'; S.show.events = q.get('events') !== '0'; S.show.ruler = q.get('ruler') !== '0'; S.show.edits = q.get('edits') === '1';
  cleanView(zoom);
  const wait = setInterval(() => { if (imagesPending() === 0) { clearInterval(wait); requestDraw(); setTimeout(() => { document.body.dataset.ready = '1'; }, 400); } }, 100);
}
