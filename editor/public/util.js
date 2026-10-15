// Tiny DOM helpers: h('div', {class:'x', onclick}, 'text', child) builds elements without a framework.
export function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === false || v === null || v === undefined) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'class') el.className = v;
    else if (k === 'value') el.value = v;
    else if (k === 'checked' || k === 'selected' || k === 'disabled' || k === 'hidden') el[k] = !!v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) if (kid !== null && kid !== undefined && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return el;
}
export const $ = sel => document.querySelector(sel);
export const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
export function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }
export const clone = v => (v === undefined ? v : JSON.parse(JSON.stringify(v)));

const toastBox = () => document.getElementById('toasts');
export function toast(text, kind = '', ms = 2600) {
  const el = h('div', { class: `toast ${kind}` }, text);
  toastBox().append(el);
  setTimeout(() => el.remove(), kind === 'bad' ? Math.max(ms, 5000) : ms);
}
