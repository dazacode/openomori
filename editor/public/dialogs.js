// One native <dialog> used for every popup: confirm, forms, pickers, help. Returns a promise of the chosen value.
import { h } from './util.js';

const dlg = document.getElementById('dlg');

/** buttons: [{ label, value, primary, danger }]. `body` is an element or a function (close) => element. Resolves to a button's value, or null. */
export function modal(title, body, buttons = [{ label: 'CLOSE', value: null }], { wide = false } = {}) {
  return new Promise(resolve => {
    const done = v => { dlg.close(); dlg.replaceChildren(); resolve(v); };
    const content = typeof body === 'function' ? body(done) : body;
    const form = h('form', { method: 'dialog', onsubmit: e => { e.preventDefault(); const p = buttons.find(b => b.primary); if (p) done(p.value); } },
      h('div', { class: 'dh' }, h('span', {}, title), h('button', { type: 'button', class: 'mini', 'aria-label': 'Close', onclick: () => done(null) }, '✕')),
      h('div', { class: 'db' }, content),
      buttons.length ? h('div', { class: 'df' }, buttons.map(b => h('button', { type: 'button', class: `btn${b.primary ? ' primary' : ''}${b.danger ? ' danger' : ''}`, onclick: () => done(typeof b.value === 'function' ? b.value() : b.value) }, b.label))) : null);
    dlg.style.maxWidth = wide ? 'min(1000px, 96vw)' : '';
    dlg.replaceChildren(form);
    dlg.oncancel = e => { e.preventDefault(); done(null); };
    dlg.showModal();
    form.querySelector('input:not([type=checkbox]), textarea, select, .btn.primary')?.focus();
  });
}
export const closeModal = () => { if (dlg.open) dlg.close(); };
export const confirmBox = (title, text, yes = 'OK', danger = false) => modal(title, h('p', {}, text), [{ label: 'CANCEL', value: false }, { label: yes, value: true, primary: true, danger }]);
