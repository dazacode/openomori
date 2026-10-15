// The step list of an event page: say, set a switch, go to another map, if/then/else, and so on.
// Each step is the same small object the map spec uses, so what you build here is what the compiler reads.
import { S } from './store.js';
import { h } from './util.js';

export const KINDS = [
  ['say', 'Say text'], ['if', 'If … then …'], ['switch', 'Set a switch'], ['variable', 'Set a variable'], ['self', 'Set a self switch'],
  ['transfer', 'Go to another map'], ['item', 'Give or take an item'], ['gold', 'Give or take gold'], ['wait', 'Wait'],
  ['se', 'Play a sound'], ['bgm', 'Play music'], ['common', 'Run a common event'], ['fade', 'Fade the screen'], ['erase', 'Erase this event'],
  ['plugin', 'Plugin command'], ['script', 'Script'], ['comment', 'Comment'],
];
const DEFAULTS = {
  say: () => ({ say: [''] }), if: () => ({ if: { switch: 1 }, then: [] }), switch: () => ({ switch: 1, to: true }), variable: () => ({ variable: 1, op: 'set', value: 0 }),
  self: () => ({ self: 'A', to: true }), transfer: () => ({ transfer: { map: 13, x: 10, y: 10, dir: 2 } }), item: () => ({ item: 1, count: 1 }), gold: () => ({ gold: 100 }),
  wait: () => ({ wait: 30 }), se: () => ({ se: '' }), bgm: () => ({ bgm: '' }), common: () => ({ common: 1 }), fade: () => ({ fade: 'out' }), erase: () => ({ erase: true }),
  plugin: () => ({ plugin: '' }), script: () => ({ script: '' }), comment: () => ({ comment: '' }),
};
export const kindOf = c => (c && 'if' in c ? 'if' : KINDS.map(k => k[0]).find(k => k in c) ?? 'comment');
export const blankCommand = kind => DEFAULTS[kind]();

const nameOf = (list, n) => (list?.[n] ? String(list[n]) : '');
const num = (v, fallback = 0) => { const n = Number(v); return Number.isFinite(n) ? Math.round(n) : fallback; };

/** A numeric input that keeps a human name beside it (switch 12 -> "Met Basil"). */
function numWithName(value, names, onInput) {
  const hint = h('span', { class: 'nm' }, nameOf(names, value));
  const input = h('input', { type: 'number', min: 0, value: String(value ?? 0), oninput: e => { const n = num(e.target.value); hint.textContent = nameOf(names, n); onInput(n); } });
  return [input, hint];
}

/**
 * Renders a list of steps. `ctx.apply(fn, structural)` runs a change on the document: structural changes redraw the panel,
 * plain typing does not (so the cursor stays where it is).
 */
export function commandList(list, ctx, depth = 0) {
  const root = h('div', { class: 'cmds' });
  list.forEach((c, i) => root.append(commandRow(list, i, ctx, depth)));
  const add = h('select', { class: 'addcmd', 'aria-label': 'Add a step', onchange: e => {
    const kind = e.target.value; if (!kind) return;
    ctx.apply(() => list.push(blankCommand(kind)), true);
  } }, h('option', { value: '' }, '+ Add a step…'), KINDS.map(([k, label]) => h('option', { value: k }, label)));
  root.append(add);
  return root;
}

function commandRow(list, i, ctx, depth) {
  const c = list[i], kind = kindOf(c);
  const set = (fn, structural = false) => ctx.apply(fn, structural);
  const kindSel = h('select', { 'aria-label': 'Kind of step', onchange: e => set(() => { list[i] = blankCommand(e.target.value); }, true) }, KINDS.map(([k, label]) => h('option', { value: k, selected: k === kind }, label)));
  const tools = h('span', { class: 'x row tight' },
    h('button', { class: 'mini', title: 'Move up', disabled: i === 0, onclick: () => set(() => { [list[i - 1], list[i]] = [list[i], list[i - 1]]; }, true) }, '▲'),
    h('button', { class: 'mini', title: 'Move down', disabled: i === list.length - 1, onclick: () => set(() => { [list[i + 1], list[i]] = [list[i], list[i + 1]]; }, true) }, '▼'),
    h('button', { class: 'mini', title: 'Delete this step', onclick: () => set(() => { list.splice(i, 1); }, true) }, '✕'));
  const row = h('div', { class: 'cmd' });
  const line = h('div', { class: 'line' }, kindSel);
  const field = (...els) => line.append(...els.flat());
  const text = (key, ph = '', width) => h('input', { type: 'text', value: String(c[key] ?? ''), placeholder: ph, style: width ? `width:${width}` : null, oninput: e => set(() => { c[key] = e.target.value; }) });
  const yesNo = (key, on = 'ON', off = 'OFF') => h('select', { onchange: e => set(() => { c[key] = e.target.value === 'on'; }) }, h('option', { value: 'on', selected: c[key] !== false }, on), h('option', { value: 'off', selected: c[key] === false }, off));

  switch (kind) {
    case 'say': {
      const lines = ([]).concat(c.say);
      const sync = () => { c.say = lines.length === 1 ? [lines[0]] : lines.slice(); };
      const box = h('div', { class: 'wide' }, lines.map((t, k) => h('div', { class: 'row', style: 'margin:3px 0; align-items:flex-start' },
        h('textarea', { rows: 2, class: 'grow', placeholder: 'What they say. One box = one message window.', oninput: e => set(() => { lines[k] = e.target.value; sync(); }) }, t),
        lines.length > 1 ? h('button', { class: 'mini', title: 'Remove this message', onclick: () => set(() => { lines.splice(k, 1); sync(); }, true) }, '✕') : null)),
        h('button', { class: 'chip', onclick: () => set(() => { lines.push(''); sync(); }, true) }, '+ next message'));
      line.append(tools); row.append(line, box); return row;
    }
    case 'if': {
      field(condEditor(c, set));
      line.append(tools);
      c.then ??= [];
      const nest = h('div', { class: 'nest' },
        h('div', { class: 'lbl' }, 'THEN'), commandList(c.then, ctx, depth + 1),
        c.else ? [h('div', { class: 'lbl' }, 'ELSE'), commandList(c.else, ctx, depth + 1), h('button', { class: 'chip', onclick: () => set(() => { delete c.else; }, true) }, 'remove else')]
          : h('button', { class: 'chip', style: 'margin-top:4px', onclick: () => set(() => { c.else = []; }, true) }, '+ else'));
      row.append(line, nest); return row;
    }
    case 'switch': field(...numWithName(c.switch, S.names.switches, n => set(() => { c.switch = n; })), yesNo('to')); break;
    case 'variable':
      field(...numWithName(c.variable, S.names.variables, n => set(() => { c.variable = n; })),
        h('select', { onchange: e => set(() => { c.op = e.target.value; }) }, [['set', '='], ['add', '+='], ['sub', '−=']].map(([v, l]) => h('option', { value: v, selected: (c.op ?? 'set') === v }, l))),
        h('input', { type: 'number', value: String(c.value ?? 0), oninput: e => set(() => { c.value = num(e.target.value); }) })); break;
    case 'self': field(h('select', { onchange: e => set(() => { c.self = e.target.value; }) }, ['A', 'B', 'C', 'D'].map(l => h('option', { value: l, selected: c.self === l }, l))), yesNo('to')); break;
    case 'transfer': {
      const t = c.transfer;
      const mapId = h('input', { type: 'number', value: String(t.map), min: 1, oninput: e => { t.map = num(e.target.value); hint.textContent = mapName(t.map); set(() => {}); } });
      const hint = h('span', { class: 'nm' }, mapName(t.map));
      field(h('span', { class: 'dim' }, 'map'), mapId, hint, h('span', { class: 'dim' }, 'x'), h('input', { type: 'number', value: String(t.x), min: 0, oninput: e => set(() => { t.x = num(e.target.value); }) }),
        h('span', { class: 'dim' }, 'y'), h('input', { type: 'number', value: String(t.y), min: 0, oninput: e => set(() => { t.y = num(e.target.value); }) }),
        h('select', { 'aria-label': 'Facing', onchange: e => set(() => { t.dir = num(e.target.value); }) }, [[2, 'face down'], [8, 'face up'], [4, 'face left'], [6, 'face right']].map(([v, l]) => h('option', { value: v, selected: (t.dir ?? 2) === v }, l)))); break;
    }
    case 'item': field(...numWithName(c.item, S.names.items, n => set(() => { c.item = n; })), h('span', { class: 'dim' }, '×'), h('input', { type: 'number', value: String(c.count ?? 1), oninput: e => set(() => { c.count = num(e.target.value, 1); }) })); break;
    case 'gold': field(h('input', { type: 'number', value: String(c.gold), oninput: e => set(() => { c.gold = num(e.target.value); }) }), h('span', { class: 'dim' }, 'negative takes it away')); break;
    case 'wait': field(h('input', { type: 'number', min: 1, value: String(c.wait), oninput: e => set(() => { c.wait = num(e.target.value, 1); }) }), h('span', { class: 'dim' }, 'frames (60 = 1 second)')); break;
    case 'se': case 'bgm': field(h('input', { type: 'text', value: typeof c[kind] === 'string' ? c[kind] : c[kind]?.name ?? '', placeholder: 'audio file name', oninput: e => set(() => { c[kind] = e.target.value; }) })); break;
    case 'common': field(...numWithName(c.common, S.names.common, n => set(() => { c.common = n; }))); break;
    case 'fade': field(h('select', { onchange: e => set(() => { c.fade = e.target.value; }) }, h('option', { value: 'out', selected: c.fade === 'out' }, 'to black'), h('option', { value: 'in', selected: c.fade === 'in' }, 'back in'))); break;
    case 'erase': field(h('span', { class: 'dim' }, 'removes it until the map reloads')); break;
    case 'plugin': field(h('input', { type: 'text', class: 'grow', value: c.plugin ?? '', placeholder: 'e.g. CallEvent 2, Page 2', style: 'width:230px', oninput: e => set(() => { c.plugin = e.target.value; }) })); break;
    case 'script': field(h('input', { type: 'text', value: ([]).concat(c.script ?? '').join('\n'), style: 'width:230px', placeholder: 'JavaScript', oninput: e => set(() => { c.script = e.target.value; }) })); break;
    case 'comment': field(h('input', { type: 'text', value: c.comment ?? '', style: 'width:230px', placeholder: 'a note to yourself', oninput: e => set(() => { c.comment = e.target.value; }) })); break;
  }
  line.append(tools);
  row.append(line);
  return row;
}

export const mapName = id => S.gameMaps.find(m => m.id === id)?.name ?? (S.mods.find(m => m.name === S.mod)?.maps.find(m => m.id === id)?.name) ?? '';

// ------------------------------------------------------------ conditions
const COND_KINDS = [['switch', 'switch is ON'], ['notSwitch', 'switch is OFF'], ['self', 'self switch is ON'], ['notSelf', 'self switch is OFF'], ['variable', 'variable is …'], ['item', 'has item'], ['js', 'JavaScript is true']];
function condKind(cond) { return typeof cond === 'string' ? 'js' : COND_KINDS.map(k => k[0]).find(k => k in cond) ?? 'switch'; }

/** Edits the condition of an `if` step in place. */
function condEditor(c, set) {
  const kind = condKind(c.if), box = h('span', { class: 'row tight' });
  const put = v => set(() => { c.if = v; }, true);
  const kindSel = h('select', { 'aria-label': 'Condition', onchange: e => {
    const k = e.target.value;
    put(k === 'js' ? 'true' : k === 'variable' ? { variable: [1, '>=', 1] } : k === 'item' ? { item: 1 } : k === 'self' || k === 'notSelf' ? { [k]: 'A' } : { [k]: 1 });
  } }, COND_KINDS.map(([k, l]) => h('option', { value: k, selected: k === kind }, l)));
  const cond = c.if;
  if (kind === 'js') box.append(h('input', { type: 'text', value: cond, style: 'width:200px', oninput: e => set(() => { c.if = e.target.value; }) }));
  else if (kind === 'variable') {
    const v = cond.variable;
    box.append(...numWithName(v[0], S.names.variables, n => set(() => { v[0] = n; })),
      h('select', { onchange: e => set(() => { v[1] = e.target.value; }) }, ['==', '>=', '<=', '>', '<', '!='].map(o => h('option', { value: o, selected: v[1] === o }, o))),
      h('input', { type: 'number', value: String(v[2]), oninput: e => set(() => { v[2] = num(e.target.value); }) }));
  } else if (kind === 'self' || kind === 'notSelf') box.append(h('select', { onchange: e => set(() => { cond[kind] = e.target.value; }) }, ['A', 'B', 'C', 'D'].map(l => h('option', { value: l, selected: cond[kind] === l }, l))));
  else if (kind === 'item') box.append(...numWithName(cond.item, S.names.items, n => set(() => { cond.item = n; })));
  else box.append(...numWithName(([]).concat(cond[kind])[0], S.names.switches, n => set(() => { cond[kind] = n; })));
  return h('span', { class: 'row tight' }, kindSel, box);
}

/** The "this page runs when…" block. Page conditions in RPG Maker are limited: switches that are ON, one self switch, one variable >=, one item. */
export function pageConditions(page, set) {
  const cond = page.if ?? {};
  const has = k => k in cond;
  const toggle = (k, init) => set(() => { const o = { ...(page.if ?? {}) }; if (k in o) delete o[k]; else o[k] = init; if (Object.keys(o).length) page.if = o; else delete page.if; }, true);
  const row = (k, label, ...inputs) => h('div', { class: 'row tight', style: 'margin:3px 0' }, h('label', { class: 'row tight', style: 'cursor:pointer' }, h('input', { type: 'checkbox', checked: has(k), onchange: () => toggle(k, k === 'switch' ? 1 : k === 'self' ? 'A' : k === 'variable' ? [1, '>=', 1] : 1) }), label), has(k) ? inputs : null);
  const sw = ([]).concat(cond.switch ?? []);
  return h('div', {},
    row('switch', 'Switch is ON', ...numWithName(sw[0] ?? 1, S.names.switches, n => set(() => { page.if.switch = sw[1] !== undefined ? [n, sw[1]] : n; }))),
    row('self', 'Self switch is ON', h('select', { onchange: e => set(() => { page.if.self = e.target.value; }) }, ['A', 'B', 'C', 'D'].map(l => h('option', { value: l, selected: cond.self === l }, l)))),
    row('variable', 'Variable is at least', ...(has('variable') ? [...numWithName(cond.variable[0], S.names.variables, n => set(() => { page.if.variable[0] = n; })), h('input', { type: 'number', value: String(cond.variable[2]), oninput: e => set(() => { page.if.variable[2] = num(e.target.value); }) })] : [])),
    row('item', 'Player has item', ...(has('item') ? numWithName(cond.item, S.names.items, n => set(() => { page.if.item = n; })) : [])),
    Object.keys(cond).length ? null : h('div', { class: 'help' }, 'No conditions: this page always applies.'));
}
