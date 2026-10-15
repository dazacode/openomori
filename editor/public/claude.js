// The CLAUDE tab: describe what you want in plain words, copy a ready-made request (with the file, the map and what you have selected) for Claude Code.
import { S } from './store.js';
import { h, toast } from './util.js';

const EXAMPLES = [
  'Add two trees and a bench near the front door.',
  'Put walls around the edge of the house so nobody walks through it.',
  'Add an NPC by the gate who says hello, and says something different the second time.',
  'Make a door on the left that takes the player to map 13.',
];
let request = '';

function specPath() {
  const m = S.mods.find(x => x.name === S.mod);
  return m ? `${m.root}/${m.name}/maps/${S.doc.id}.spec.json` : `maps/${S.doc.id}.spec.json`;
}

export function buildPrompt(text) {
  const d = S.doc, mod = S.mod;
  const stamps = d.spec.stamps?.length ?? 0, events = d.spec.events?.length ?? 0;
  const picked = S.stamp ? `a ${S.stamp.rect[2]}×${S.stamp.rect[3]} piece of map ${S.stamp.map} at [${S.stamp.rect.join(', ')}]` : null;
  const sel = S.selEvent >= 0 ? `event #${S.selEvent + 1} "${d.spec.events[S.selEvent]?.name}" at (${d.spec.events[S.selEvent]?.x}, ${d.spec.events[S.selEvent]?.y})` : null;
  return [
    `I'm working on a map in the OpenOMORI map editor (mod "${mod}", map ${d.id} "${d.spec.name ?? ''}", ${d.w}×${d.h} tiles).`,
    '',
    `What I want: ${text.trim() || '(describe it here)'}`,
    '',
    'How to work on it (details in browser/editor/AGENTS.md):',
    `- Edit only ${specPath()}. Its format is the "Making new maps and events" section of browser/docs/MODDING.md. Do not edit files/ (BUILD makes those) and do not touch other mods.`,
    `- Look at the result: cd browser && bun run mod map shot ${mod} ${d.id} --zoom 0.5 --out /tmp/map-${d.id}.png   (then read the PNG).`,
    '- To find things to copy: bun run mod map list <words>, and bun run mod map shot --game <id> (numbers on the edges are tile coordinates for stamp rectangles). Ready-made pieces are in browser/editor/library.json.',
    '- Prefer stamps from real game maps over painting single tiles. Keep ids/names the editor already wrote.',
    S.dirty ? '- NOTE: I have unsaved edits in the editor. Tell me to save before you change the file, or my edits will be overwritten when I save.' : '- The editor reloads this file by itself within a couple of seconds after you save it.',
    '',
    `Right now the map has ${stamps} stamp${stamps === 1 ? '' : 's'} and ${events} event${events === 1 ? '' : 's'}.${picked ? ` I have picked ${picked}.` : ''}${sel ? ` I have ${sel} selected.` : ''}`,
  ].join('\n');
}

async function copy(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* not allowed on plain http in some browsers: fall back */ }
  const ta = h('textarea', { style: 'position:fixed;left:-999px' }, text);
  document.body.append(ta); ta.select();
  let ok = false; try { ok = document.execCommand('copy'); } catch { /* ignore */ }
  ta.remove(); return ok;
}

export function claudePanel() {
  if (S.doc.readonly) return h('div', { class: 'help' }, 'Open one of your editable maps to ask Claude about it.');
  const area = h('textarea', { rows: 5, placeholder: 'Describe what you want in your own words…', oninput: e => { request = e.target.value; preview.value = buildPrompt(request); } }, request);
  const preview = h('textarea', { rows: 12, readonly: true, 'aria-label': 'The request that will be copied' }, buildPrompt(request));
  return h('div', {},
    h('div', { class: 'sect' }, h('h3', {}, 'ASK CLAUDE'),
      h('div', { class: 'help' }, 'Say what you want, copy the request, and paste it into Claude Code. Claude edits this map\'s file and this page updates by itself. You can keep editing by hand too.'),
      area,
      h('div', { class: 'row tight', style: 'margin:8px 0' }, EXAMPLES.map(t => h('button', { class: 'chip', onclick: () => { request = t; area.value = t; preview.value = buildPrompt(t); } }, t.length > 34 ? `${t.slice(0, 32)}…` : t))),
      h('div', { class: 'row' }, h('button', { class: 'btn primary', onclick: async () => { toast((await copy(buildPrompt(request))) ? 'Copied. Paste it into Claude Code.' : 'Could not copy: select the text below and copy it.', 'ok'); } }, 'COPY REQUEST'))),
    h('div', { class: 'sect' }, h('h3', {}, 'WHAT WILL BE COPIED'), preview),
    h('div', { class: 'sect' }, h('h3', {}, 'HOW THIS WORKS'),
      h('div', { class: 'help' }, 'Claude can read and edit the spec file, and can take a picture of your map with the map shot command to check its own work. Save your edits first (Ctrl+S) so nothing is overwritten.')));
}
