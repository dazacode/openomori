// The left column: tool buttons and the layer list.
import { S, on, setTool, setLayer, tileLayers } from './store.js';
import { icon } from './icons.js';
import { layerLabel } from './spec.js';
import { h } from './util.js';
import { requestDraw } from './canvas.js';

export const TOOLS = [
  { id: 'brush', key: 'B', label: 'Brush' }, { id: 'rect', key: 'R', label: 'Rectangle' }, { id: 'fill', key: 'F', label: 'Fill' },
  { id: 'eraser', key: 'E', label: 'Eraser' }, { id: 'walls', key: 'C', label: 'Walls (collision)' }, { id: 'stamp', key: 'S', label: 'Stamp a piece of another map' },
  { id: 'event', key: 'N', label: 'Events (NPCs, doors, triggers)' }, { id: 'pick', key: 'I', label: 'Pick a tile from the map' }, { id: 'pan', key: 'H', label: 'Move around (or hold Space)' },
];

const $tools = document.getElementById('tools'), $layers = document.getElementById('layers');

function drawTools() {
  $tools.replaceChildren(...TOOLS.map(t => {
    const b = h('button', { class: 'tool', title: `${t.label} (${t.key})`, 'aria-pressed': String(S.tool === t.id), 'aria-label': t.label, onclick: () => setTool(t.id) });
    b.innerHTML = icon(t.id === 'walls' ? 'walls' : t.id);
    b.append(h('kbd', {}, t.key));
    return b;
  }));
}
function drawLayers() {
  if (!S.doc) { $layers.replaceChildren(h('div', { class: 'help' }, 'Open a map to see its layers.')); return; }
  const rows = [...tileLayers()].reverse().map(l => {
    const visible = S.vis[l.name] !== false;
    return h('div', { class: `layer${S.layer === l.name ? ' sel' : ''}`, role: 'option', 'aria-selected': String(S.layer === l.name), title: l.name },
      h('button', { class: 'eye' + (visible ? ' on' : ''), title: visible ? 'Hide this layer' : 'Show this layer', onclick: () => { S.vis[l.name] = !visible; drawLayers(); requestDraw(); } }, visible ? '◉' : '○'),
      h('button', { class: 'name', onclick: () => setLayer(l.name) }, layerLabel(l.name)));
  });
  $layers.replaceChildren(...rows);
}
document.getElementById('layersAll').onclick = () => {
  const anyHidden = tileLayers().some(l => S.vis[l.name] === false);
  for (const l of tileLayers()) S.vis[l.name] = anyHidden;
  drawLayers(); requestDraw();
};
on('tool', drawTools); on('layer', drawLayers); on('open', drawLayers); on('doc', () => { if (!$layers.children.length || !S.doc) drawLayers(); });
drawTools(); drawLayers();
