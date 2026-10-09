// The settings screen: a DOM overlay with tabs, search, live controls, key rebinding and gamepad/keyboard navigation.
// It blocks the game's own input while open and writes through the registry, so changes apply instantly.
import { onFrame } from './features.ts';
import { TABS, all, onSettingsChanged, scheduleSave, type Control, type Setting, type TabId } from './registry.ts';

const g = globalThis as any;

const CSS = `
#oset{position:fixed;inset:0;z-index:2147483100;display:none;align-items:center;justify-content:center;background:#000c;font:14px/1.45 system-ui,"Segoe UI",sans-serif;color:#eee}
#oset.open{display:flex;animation:oset-in .12s ease-out}
@keyframes oset-in{from{opacity:0}to{opacity:1}}
@media (prefers-reduced-motion:reduce){#oset.open{animation:none}}
#oset *{box-sizing:border-box}
#oset .dlg{width:min(900px,96vw);height:min(640px,94vh);display:flex;flex-direction:column;background:#0c0c10;border:1px solid #e8e8ee;box-shadow:0 0 0 4px #0c0c10,0 0 0 5px #55556a}
#oset header{display:flex;align-items:center;gap:12px;padding:12px 18px;border-bottom:1px solid #2c2c38}
#oset h1{margin:0;font:400 22px GameFont,system-ui,sans-serif;letter-spacing:.08em;flex:1;text-transform:uppercase}
#oset .body{flex:1;display:flex;min-height:0}
#oset nav{width:200px;flex:none;padding:12px;border-right:1px solid #2c2c38;display:flex;flex-direction:column;gap:2px;overflow:auto}
#oset nav input{width:100%;margin-bottom:10px;font:inherit;color:#fff;background:#16161d;border:1px solid #3a3a4a;padding:7px 9px}
#oset nav button{font:inherit;text-align:left;color:#c9c9d6;background:none;border:0;border-left:3px solid transparent;padding:8px 10px;cursor:pointer}
#oset nav button:hover{background:#181820;color:#fff}
#oset nav button[aria-selected=true]{color:#fff;border-left-color:#ff4757;background:#181820}
#oset main{flex:1;overflow:auto;padding:6px 20px 20px;scroll-behavior:smooth}
@media (prefers-reduced-motion:reduce){#oset main{scroll-behavior:auto}}
#oset h2{margin:22px 0 4px;font:600 11px system-ui;letter-spacing:.12em;text-transform:uppercase;color:#8d8da3}
#oset .row{display:flex;gap:16px;align-items:center;padding:11px 12px;margin:0 -12px;border-bottom:1px solid #1d1d26;outline:0}
#oset .row:focus,#oset .row:focus-within{background:#15151d;box-shadow:inset 3px 0 #ff4757}
#oset .txt{flex:1;min-width:0}
#oset .lbl{font-weight:600}
#oset .help{color:#9a9ab0;font-size:12.5px;margin-top:2px}
#oset .note{color:#f2c46d;font-size:12px;margin-top:2px}
#oset .ctl{display:flex;align-items:center;gap:10px;flex:none}
#oset button{font:inherit;color:#fff;cursor:pointer}
#oset .btn{background:#23232e;border:1px solid #44445a;padding:6px 14px}
#oset .btn:hover{background:#2f2f3e}#oset .btn.danger{border-color:#a33;color:#ffb4b4}
#oset .sw{width:46px;height:24px;border-radius:12px;border:1px solid #55556a;background:#1b1b24;position:relative;padding:0}
#oset .sw::after{content:"";position:absolute;top:2px;left:2px;width:18px;height:18px;border-radius:50%;background:#aaa;transition:transform .12s,background .12s}
#oset .sw[aria-checked=true]{background:#c2303c;border-color:#ff6b78}
#oset .sw[aria-checked=true]::after{transform:translateX(22px);background:#fff}
#oset .seg{display:flex;border:1px solid #44445a}
#oset .seg button{background:#16161d;border:0;border-right:1px solid #44445a;padding:6px 12px;color:#c9c9d6}
#oset .seg button:last-child{border-right:0}
#oset .seg button[aria-checked=true]{background:#c2303c;color:#fff}
#oset input[type=range]{width:200px;accent-color:#ff4757}
#oset .val{min-width:3.4em;text-align:right;font-variant-numeric:tabular-nums;color:#ddd}
#oset .reset{background:none;border:0;color:#8d8da3;padding:2px 6px;font-size:16px;visibility:hidden}
#oset .reset.on{visibility:visible}#oset .reset:hover{color:#fff}
#oset footer{display:flex;gap:14px;align-items:center;padding:10px 18px;border-top:1px solid #2c2c38;color:#8d8da3;font-size:12px}
#oset footer .grow{flex:1}#oset .status{color:#9be29b}
#oset .empty{padding:40px 0;text-align:center;color:#8d8da3}
#oset .keys{padding:8px 0}
#oset .krow{display:flex;align-items:center;gap:10px;padding:7px 0;border-bottom:1px solid #1d1d26}
#oset .krow .a{width:150px;font-weight:600}
#oset .chip{display:inline-flex;align-items:center;gap:4px;background:#23232e;border:1px solid #44445a;padding:3px 4px 3px 9px;margin-right:6px;font-size:12.5px}
#oset .chip button{background:none;border:0;color:#8d8da3;padding:0 4px}#oset .chip button:hover{color:#fff}
#oset .chip.fixed{padding:3px 9px;color:#9a9ab0}
#oset .add{background:none;border:1px dashed #55556a;color:#9a9ab0;padding:3px 9px;font-size:12.5px}
#oset .add.listening{border-color:#ff4757;color:#fff;animation:oset-pulse 1s infinite}
@keyframes oset-pulse{50%{opacity:.5}}
#oset .khead{display:flex;align-items:center;gap:10px;margin:14px 0 2px}
@media (max-width:640px){#oset nav{width:100%;flex-direction:row;overflow-x:auto;border-right:0;border-bottom:1px solid #2c2c38}#oset .body{flex-direction:column}#oset nav input{display:none}#oset input[type=range]{width:120px}#oset .row{flex-wrap:wrap}}
`;

// ---------------------------------------------------------------- state
let root: HTMLElement, navEl: HTMLElement, mainEl: HTMLElement, statusEl: HTMLElement, searchEl: HTMLInputElement;
let installed = false, open = false, tab: TabId = 'general', query = '';
let onClose: (() => void) | undefined;
let dragging = false;
let listening: { cancel(): void } | null = null;
const updaters = new Map<string, () => void>();
let lastVisible = '';

export const isOpen = () => open;

function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, any> = {}, ...kids: (Node | string)[]): HTMLElementTagNameMap[K] {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
        if (v === undefined || v === false) continue;
        if (k === 'class') e.className = v;
        else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
        else if (k in e && k !== 'list') (e as any)[k] = v;
        else e.setAttribute(k, v === true ? '' : String(v));
    }
    e.append(...kids);
    return e;
}

function say(msg: string) {
    statusEl.textContent = msg;
    clearTimeout((say as any).t);
    (say as any).t = setTimeout(() => { statusEl.textContent = ''; }, 3500);
}
export { say as settingsStatus };

// ---------------------------------------------------------------- build
function install() {
    installed = true;
    document.head.append(h('style', {}, CSS));
    searchEl = h('input', { type: 'search', placeholder: 'Search settings…  ( / )', 'aria-label': 'Search settings', oninput: () => { query = searchEl.value.trim().toLowerCase(); renderList(); } });
    navEl = h('nav', { role: 'tablist', 'aria-label': 'Settings sections' }, searchEl);
    mainEl = h('main', { id: 'oset-main' });
    statusEl = h('span', { class: 'status', role: 'status', 'aria-live': 'polite' });
    const hint = h('span', {}, '↑↓ choose · ←→ change · Enter select · Esc close');
    root = h('div', { id: 'oset', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Settings' },
        h('div', { class: 'dlg' },
            h('header', {}, h('h1', {}, 'Settings'), h('button', { class: 'btn', onclick: () => closeSettings(), title: 'Close (Esc)' }, 'Close')),
            h('div', { class: 'body' }, navEl, mainEl),
            h('footer', {}, hint, statusEl, h('span', { class: 'grow' }), h('button', { class: 'btn', onclick: resetTab }, 'Reset this section'))));
    document.body.append(root);

    for (const t of TABS) {
        navEl.append(h('button', { role: 'tab', 'data-tab': t.id, onclick: () => { searchEl.value = ''; query = ''; tab = t.id; renderList(); mainEl.scrollTop = 0; } }, t.label));
    }

    // Swallow the game's input whenever focus is outside the panel (the panel's own keys are handled in onKey, bubbling out of it).
    window.addEventListener('keydown', e => {
        if (!open || root.contains(e.target as Node)) return;
        if (listening) return;
        e.stopImmediatePropagation(); e.preventDefault();
        onKey(e);
    }, true);
    window.addEventListener('keyup', e => { if (open) e.stopImmediatePropagation(); }, true);
    root.addEventListener('keydown', e => { if (listening) return; onKey(e); e.stopPropagation(); });
    root.addEventListener('keyup', e => e.stopPropagation());
    root.addEventListener('pointerdown', () => { /* keep the game from seeing clicks */ });
    root.addEventListener('focusout', e => { if (open && !root.contains(e.relatedTarget as Node) && e.relatedTarget) (root.querySelector('[tabindex="0"]') as HTMLElement | null)?.focus(); });
    onSettingsChanged(() => { if (open && !dragging) refresh(); });
    onFrame(pollGamepad);
}

const visibleSettings = () => all().filter(s => !s.visible || s.visible());

function matches(s: Setting): boolean {
    return `${s.label} ${s.help ?? ''} ${s.keywords ?? ''} ${s.group ?? ''} ${s.owner ?? ''}`.toLowerCase().includes(query);
}

// ---------------------------------------------------------------- list
function renderList() {
    updaters.clear();
    for (const b of navEl.querySelectorAll<HTMLElement>('[data-tab]')) b.setAttribute('aria-selected', String(!query && b.dataset.tab === tab));
    const list = visibleSettings().filter(s => (query ? matches(s) : s.tab === tab));
    lastVisible = visibleKey();
    const kids: Node[] = [];
    if (!list.length) kids.push(h('div', { class: 'empty' }, query ? `Nothing matches "${query}".` : tab === 'mods' ? 'No installed mod has added settings.' : 'Nothing here.'));
    let group: string | undefined = '\0';
    const mods = tab === 'mods' && !query;
    if (mods) kids.push(h('div', { class: 'help', style: 'margin:14px 0 0' }, 'Settings added by your installed mods appear here.'));
    for (const s of list) {
        const gname = query ? TABS.find(t => t.id === s.tab)!.label + (s.group ? ` › ${s.group}` : '') : mods ? (s.owner ?? s.group) : s.group;
        if (gname !== group) { group = gname; if (gname) kids.push(h('h2', {}, gname)); }
        kids.push(s.control.type === 'keys' ? keysBlock() : row(s));
    }
    mainEl.replaceChildren(...kids);
    refresh(false);
}

const visibleKey = () => all().map(s => (!s.visible || s.visible() ? s.id : '')).join('|');

/** Update displayed values in place; rebuild only if which rows are visible changed. */
function refresh(rebuild = true) {
    if (rebuild && visibleKey() !== lastVisible) { const y = mainEl.scrollTop; renderList(); mainEl.scrollTop = y; return; }
    updaters.forEach(u => u());
}

function row(s: Setting): HTMLElement {
    const c = s.control;
    const noteEl = h('div', { class: 'note' });
    const reset = h('button', { class: 'reset', title: 'Reset to default', 'aria-label': `Reset ${s.label}`, tabindex: -1, onclick: () => { if (s.default !== undefined) (c as any).set(s.default); } }, '↺');
    const ctl = h('div', { class: 'ctl' });
    const update: (() => void)[] = [];

    if (c.type === 'toggle') {
        const b = h('button', { class: 'sw', role: 'switch', tabindex: -1, 'aria-label': s.label, onclick: () => c.set(!c.get()) });
        ctl.append(b); update.push(() => b.setAttribute('aria-checked', String(c.get())));
    } else if (c.type === 'slider') {
        const val = h('span', { class: 'val' });
        const input = h('input', { type: 'range', min: c.min, max: c.max, step: c.step, tabindex: -1, 'aria-label': s.label });
        input.addEventListener('pointerdown', () => { dragging = true; });
        const up = () => { dragging = false; };
        input.addEventListener('pointerup', up); input.addEventListener('pointercancel', up);
        input.addEventListener('input', () => { c.set(Number(input.value)); val.textContent = `${input.value}${c.unit ?? ''}`; reset.classList.toggle('on', s.default !== undefined && Number(input.value) !== s.default); });
        input.addEventListener('change', () => { dragging = false; c.preview?.(); });
        ctl.append(input, val);
        update.push(() => { input.value = String(c.get()); val.textContent = `${c.get()}${c.unit ?? ''}`; });
    } else if (c.type === 'choice') {
        const seg = h('div', { class: 'seg', role: 'radiogroup', 'aria-label': s.label },
            ...c.options.map(o => h('button', { role: 'radio', tabindex: -1, 'data-v': String(o.value), onclick: () => c.set(o.value) }, o.label)));
        ctl.append(seg);
        update.push(() => { for (const b of seg.children) b.setAttribute('aria-checked', String((b as HTMLElement).dataset.v === String(c.get()))); });
    } else if (c.type === 'action') {
        ctl.append(h('button', { class: 'btn' + (c.danger ? ' danger' : ''), tabindex: -1, onclick: () => c.run() }, c.button));
    }
    if (c.type !== 'action') ctl.append(reset);

    const el = h('div', { class: 'row', tabindex: 0, 'data-id': s.id },
        h('div', { class: 'txt' }, h('div', { class: 'lbl' }, s.label), s.help ? h('div', { class: 'help' }, s.help) : '', noteEl), ctl);
    updaters.set(s.id, () => {
        update.forEach(u => u());
        const n = s.note?.(); noteEl.textContent = n ?? ''; noteEl.style.display = n ? '' : 'none';
        if (c.type !== 'action') reset.classList.toggle('on', s.default !== undefined && (c as any).get() !== s.default);
    });
    return el;
}

// ---------------------------------------------------------------- key bindings
const ACTIONS: { id: string; label: string; gamepad: boolean }[] = [
    { id: 'up', label: 'Move up', gamepad: false }, { id: 'down', label: 'Move down', gamepad: false },
    { id: 'left', label: 'Move left', gamepad: false }, { id: 'right', label: 'Move right', gamepad: false },
    { id: 'ok', label: 'Confirm / interact', gamepad: true }, { id: 'escape', label: 'Cancel / menu', gamepad: true },
    { id: 'shift', label: 'Run', gamepad: true }, { id: 'tag', label: 'Tag partner', gamepad: true },
    { id: 'pageup', label: 'Previous (LB)', gamepad: true }, { id: 'pagedown', label: 'Next (RB)', gamepad: true },
];
const REQUIRED = new Set(['up', 'down', 'left', 'right', 'ok', 'escape']);

const KEY_NAMES: Record<number, string> = {
    8: 'Backspace', 9: 'Tab', 13: 'Enter', 16: 'Shift', 17: 'Ctrl', 18: 'Alt', 20: 'Caps Lock', 27: 'Esc', 32: 'Space', 33: 'Page Up', 34: 'Page Down', 35: 'End', 36: 'Home',
    37: '←', 38: '↑', 39: '→', 40: '↓', 45: 'Insert', 46: 'Delete', 186: ';', 187: '=', 188: ',', 189: '-', 190: '.', 191: '/', 192: '`', 219: '[', 220: '\\', 221: ']', 222: "'",
};
const keyName = (code: number) =>
    KEY_NAMES[code] ?? (code >= 48 && code <= 57 ? String(code - 48) : code >= 65 && code <= 90 ? String.fromCharCode(code) : code >= 96 && code <= 105 ? `Num ${code - 96}` : code >= 112 && code <= 123 ? `F${code - 111}` : `Key ${code}`);
const PAD_NAMES = ['A', 'B', 'X', 'Y', 'LB', 'RB', 'LT', 'RT', 'Back', 'Start', 'L3', 'R3', '↑', '↓', '←', '→', 'Home'];
const padName = (b: number) => PAD_NAMES[b] ?? `Button ${b}`;
const RESERVED_KEYS = new Set([116, 118, 119, 120, 121]); // F5 reload, F7 screenshot, F8 mods, F9 debug, F10 settings

function keysBlock(): HTMLElement {
    const box = h('div', { class: 'keys' });
    const draw = () => {
        const km: Record<string, string> = g.Input?.keyMapper ?? {}, gm: Record<string, string> = g.Input?.gamepadMapper ?? {};
        const kids: Node[] = [h('div', { class: 'khead' }, h('h2', { style: 'margin:0;flex:1' }, 'Keyboard'), h('button', { class: 'btn', onclick: () => { g.ConfigManager.setDefaultKeyboardKeyMap(); done('Keyboard keys reset'); } }, 'Reset keyboard'))];
        for (const a of ACTIONS) {
            const keys = Object.entries(km).filter(([, act]) => act === a.id).map(([k]) => Number(k));
            const add = h('button', { class: 'add', onclick: () => listenKey(a.id, add) }, '+ add key');
            const chips = keys.map(k => h('span', { class: 'chip' }, keyName(k),
                h('button', { title: 'Remove', 'aria-label': `Remove ${keyName(k)} from ${a.label}`, onclick: () => {
                    if (REQUIRED.has(a.id) && keys.length < 2) return say(`${a.label} needs at least one key`);
                    delete km[k]; done(); } }, '×')));
            kids.push(h('div', { class: 'krow' }, h('span', { class: 'a' }, a.label), h('span', { style: 'flex:1' }, ...chips, add)));
        }
        kids.push(h('div', { class: 'khead' }, h('h2', { style: 'margin:0;flex:1' }, 'Gamepad'), h('button', { class: 'btn', onclick: () => { g.ConfigManager.setDefaultGamepadKeyMap(); done('Gamepad buttons reset'); } }, 'Reset gamepad')));
        for (const a of ACTIONS) {
            const btn = Object.entries(gm).find(([, act]) => act === a.id)?.[0];
            const kid = a.gamepad
                ? (() => { const b = h('button', { class: 'add', onclick: () => listenPad(a.id, b) }, btn !== undefined ? padName(Number(btn)) : 'unbound'); b.style.borderStyle = 'solid'; return b; })()
                : h('span', { class: 'chip fixed' }, btn !== undefined ? padName(Number(btn)) : '—');
            kids.push(h('div', { class: 'krow' }, h('span', { class: 'a' }, a.label), h('span', { style: 'flex:1' }, kid)));
        }
        kids.push(h('div', { class: 'help', style: 'margin-top:8px' }, 'Click "+ add key" then press the key you want. A key that is already used moves to the new action. Direction buttons on a gamepad are fixed to the D-pad.'));
        box.replaceChildren(...kids);
    };
    const done = (msg?: string) => { g.Input?.clear?.(); scheduleSave(); draw(); if (msg) say(msg); };

    function listenKey(action: string, btn: HTMLElement) {
        stopListening();
        btn.classList.add('listening'); btn.textContent = 'press a key… (Esc cancels)';
        const onDown = (e: KeyboardEvent) => {
            e.preventDefault(); e.stopImmediatePropagation();
            stopListening();
            if (e.key === 'Escape') return draw();
            const code = e.keyCode;
            if (RESERVED_KEYS.has(code)) { say(`${keyName(code)} is reserved by the port`); return draw(); }
            const km: Record<string, string> = g.Input.keyMapper;
            const prev = km[code];
            // A key that is the only binding of a required action can't be taken away from it.
            if (prev && prev !== action && REQUIRED.has(prev) && Object.values(km).filter(v => v === prev).length < 2) {
                say(`${keyName(code)} is the only key for "${ACTIONS.find(x => x.id === prev)?.label}". Add another key there first.`);
                return draw();
            }
            km[code] = action;
            done(prev && prev !== action ? `${keyName(code)} moved from "${ACTIONS.find(x => x.id === prev)?.label ?? prev}"` : `${keyName(code)} bound`);
        };
        window.addEventListener('keydown', onDown, true);
        listening = { cancel: () => window.removeEventListener('keydown', onDown, true) };
    }
    function listenPad(action: string, btn: HTMLElement) {
        stopListening();
        btn.classList.add('listening'); btn.textContent = 'press a button…';
        const pads = () => [...(navigator.getGamepads?.() ?? [])].filter(Boolean) as Gamepad[];
        if (!pads().length) { say('No gamepad detected. Connect one and press a button.'); }
        const off = onFrame(() => {
            for (const p of pads()) for (let b = 0; b < Math.min(p.buttons.length, 12); b++) if (p.buttons[b]!.pressed) {
                stopListening();
                const gm: Record<string, string> = g.Input.gamepadMapper;
                const old = Object.entries(gm).find(([, act]) => act === action)?.[0];
                const other = gm[b];
                gm[b] = action; if (old !== undefined && old !== String(b)) gm[old] = other ?? `UNUSED${old}`;
                done(`${padName(b)} bound`); return;
            }
        });
        const cancel = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); stopListening(); draw(); } };
        window.addEventListener('keydown', cancel, true);
        listening = { cancel: () => { off(); window.removeEventListener('keydown', cancel, true); } };
    }
    draw();
    return box;
}

function stopListening() { listening?.cancel(); listening = null; }

// ---------------------------------------------------------------- navigation
function focusRow(delta: number) {
    const list = [...mainEl.querySelectorAll<HTMLElement>('.row[tabindex="0"]')];
    if (!list.length) return;
    const i = list.indexOf(document.activeElement as HTMLElement);
    const next = list[Math.max(0, Math.min(list.length - 1, i < 0 ? 0 : i + delta))]!;
    next.focus({ preventScroll: true });
    next.scrollIntoView({ block: 'nearest' });
}

function settingOf(el: Element | null): Setting | undefined {
    const id = (el as HTMLElement | null)?.closest?.('.row')?.getAttribute('data-id');
    return all().find(s => s.id === id);
}

/** Adjust the focused setting with ←/→ (or Enter / Space). */
function adjust(s: Setting, dir: -1 | 0 | 1, big = false) {
    const c: Control = s.control;
    if (c.type === 'toggle') c.set(dir === 0 ? !c.get() : dir > 0);
    else if (c.type === 'slider' && dir) { const v = Math.max(c.min, Math.min(c.max, c.get() + dir * c.step * (big ? 5 : 1))); c.set(v); c.preview?.(); }
    else if (c.type === 'choice') {
        const i = c.options.findIndex(o => String(o.value) === String(c.get()));
        const n = dir === 0 ? (i + 1) % c.options.length : Math.max(0, Math.min(c.options.length - 1, i + dir));
        c.set(c.options[n]!.value);
    } else if (c.type === 'action' && dir === 0) c.run();
}

function onKey(e: KeyboardEvent) {
    const typing = e.target === searchEl;
    const row = (e.target as HTMLElement).closest?.('.row');
    switch (e.key) {
        case 'Escape':
            if (typing && searchEl.value) { searchEl.value = ''; query = ''; renderList(); }
            else closeSettings();
            e.preventDefault(); break;
        case 'ArrowDown': if (typing) mainEl.querySelector<HTMLElement>('.row[tabindex="0"]')?.focus(); else focusRow(1); e.preventDefault(); break;
        case 'ArrowUp': if (!typing) focusRow(-1); e.preventDefault(); break;
        case 'PageDown': focusRow(5); e.preventDefault(); break;
        case 'PageUp': focusRow(-5); e.preventDefault(); break;
        case 'ArrowLeft': case 'ArrowRight': {
            if (typing) break;
            const s = row ? settingOf(row) : undefined;
            if (s && e.target === row) { adjust(s, e.key === 'ArrowLeft' ? -1 : 1, e.shiftKey); e.preventDefault(); }
            break;
        }
        case 'Enter': case ' ': {
            if (typing || (e.target as HTMLElement).tagName === 'BUTTON' || (e.target as HTMLElement).tagName === 'INPUT') break;
            const s = row ? settingOf(row) : undefined;
            if (s) { adjust(s, 0); e.preventDefault(); }
            break;
        }
        case '/': if (!typing) { searchEl.focus(); e.preventDefault(); } break;
        case 'Tab': break;
        case '[': case ']': if (!typing) { cycleTab(e.key === ']' ? 1 : -1); e.preventDefault(); } break;
    }
}

function cycleTab(d: number) {
    const i = TABS.findIndex(t => t.id === tab);
    tab = TABS[(i + d + TABS.length) % TABS.length]!.id;
    searchEl.value = ''; query = '';
    renderList(); mainEl.scrollTop = 0;
}

// ---------------------------------------------------------------- gamepad
const was: Record<string, boolean> = {};
function pollGamepad() {
    if (!open) return;
    const pad = [...(navigator.getGamepads?.() ?? [])].find(p => p && p.connected);
    if (!pad || listening) return;
    const b = (i: number) => !!pad.buttons[i]?.pressed;
    const ax = pad.axes[1] ?? 0, ay = pad.axes[0] ?? 0;
    const now: Record<string, boolean> = { up: b(12) || ax < -0.6, down: b(13) || ax > 0.6, left: b(14) || ay < -0.6, right: b(15) || ay > 0.6, a: b(0), b: b(1), lb: b(4), rb: b(5) };
    const edge = (k: string) => now[k] && !was[k];
    const focus = document.activeElement as HTMLElement;
    const s = focus?.classList?.contains('row') ? settingOf(focus) : undefined;
    if (edge('up')) focusRow(-1);
    if (edge('down')) focusRow(1);
    if (edge('left') && s) adjust(s, -1);
    if (edge('right') && s) adjust(s, 1);
    if (edge('a') && s) adjust(s, 0);
    if (edge('b')) closeSettings();
    if (edge('lb')) cycleTab(-1);
    if (edge('rb')) cycleTab(1);
    Object.assign(was, now);
}

function resetTab() {
    if (query) return say('Clear the search to reset a section');
    const list = visibleSettings().filter(s => s.tab === tab && s.default !== undefined && s.control.type !== 'action');
    if (!list.length) return say('Nothing to reset here');
    if (!confirm(`Reset ${list.length} setting(s) in this section to their defaults?`)) return;
    for (const s of list) (s.control as any).set(s.default);
    say('Section reset');
}

// ---------------------------------------------------------------- open / close
export function openSettings(opts: { tab?: TabId; onClose?: () => void } = {}) {
    if (!installed) install();
    if (open) return;
    open = true; onClose = opts.onClose;
    if (opts.tab) tab = opts.tab;
    g.Input?.clear?.(); g.TouchInput?.clear?.();
    root.classList.add('open');
    searchEl.value = ''; query = '';
    renderList();
    (mainEl.querySelector('.row[tabindex="0"]') as HTMLElement | null)?.focus();
}

export function closeSettings() {
    if (!open) return;
    stopListening();
    open = false;
    root.classList.remove('open');
    g.Input?.clear?.(); g.TouchInput?.clear?.();
    scheduleSave();
    const cb = onClose; onClose = undefined;
    cb?.();
}

/** Re-render when a mod adds settings while the panel is open. */
export const refreshPanel = () => { if (open) renderList(); };
