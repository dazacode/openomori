// In-browser debug panel for OMORI. Toggle with F9 or ` (backquote). Talks to the game's own globals,
// so it can teleport, edit switches/variables, give items, heal the party, etc. Nothing here is saved
// unless you save the game afterwards.
import { listAsync } from './shim/index.ts';

type Tab = 'maps' | 'switches' | 'variables' | 'party' | 'items' | 'game';
const TABS: Tab[] = ['maps', 'switches', 'variables', 'party', 'items', 'game'];
const MAX_ROWS = 150; // rows rendered per list; use the filter box to narrow

type Child = Node | string | null | false;
function h<K extends keyof HTMLElementTagNameMap>(
    tag: K, props: Partial<Record<string, unknown>> = {}, ...kids: Child[]
): HTMLElementTagNameMap[K] {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
        if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v as EventListener);
        else if (k === 'class') el.className = String(v);
        else if (v !== undefined && v !== null) (el as any)[k] = v;
    }
    for (const kid of kids) if (kid) el.append(kid);
    return el;
}

const CSS = `
#dbg{position:fixed;top:0;right:0;bottom:0;width:380px;z-index:100000;background:rgba(14,14,18,.94);color:#e8e8ee;
 font:12px/1.4 ui-monospace,Consolas,monospace;display:none;flex-direction:column;border-left:1px solid #444;backdrop-filter:blur(6px)}
#dbg.open{display:flex}
#dbg *{box-sizing:border-box}
#dbg header{display:flex;align-items:center;gap:6px;padding:8px 10px;border-bottom:1px solid #333}
#dbg header b{flex:1;letter-spacing:.08em}
#dbg nav{display:flex;flex-wrap:wrap;gap:4px;padding:6px 8px;border-bottom:1px solid #333}
#dbg button{background:#2a2a34;color:inherit;border:1px solid #444;border-radius:4px;padding:3px 8px;cursor:pointer;font:inherit}
#dbg button:hover{background:#3a3a48}
#dbg button.on{background:#5b6cff;border-color:#5b6cff;color:#fff}
#dbg input[type=text],#dbg input[type=number]{background:#1a1a22;color:inherit;border:1px solid #444;border-radius:4px;padding:3px 6px;font:inherit;min-width:0}
#dbg .body{flex:1;overflow:auto;padding:8px 10px}
#dbg .row{display:flex;gap:6px;align-items:center;padding:2px 0;border-bottom:1px solid #22222a}
#dbg .row .id{width:44px;color:#8a8a9a;text-align:right}
#dbg .row .nm{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#dbg .row input[type=number]{width:90px}
#dbg .bar{display:flex;gap:6px;margin-bottom:8px;flex-wrap:wrap}
#dbg .bar input[type=text]{flex:1}
#dbg .note{color:#9a9aaa;margin:6px 0}
#dbg .hit{cursor:pointer}#dbg .hit:hover{background:#262633}
`;

export function installDebug(): void {
    if (new URLSearchParams(location.search).get('debug') === '0') return;
    document.head.append(h('style', {}, CSS));

    let tab: Tab = 'maps';
    let filter = '';
    let fpsOn = false;
    let mapIds: Set<number> | null = null; // maps that actually have tile data on disk
    void listAsync('maps').then(names => {
        mapIds = new Set(names.map(n => /^map(\d+)\.AUBREY$/i.exec(n)?.[1]).filter(Boolean).map(Number));
        if (root.classList.contains('open')) render();
    });

    const body = h('div', { class: 'body' });
    const nav = h('nav');
    const status = h('span', { class: 'note' });
    const root = h('div', { id: 'dbg' },
        h('header', {}, h('b', {}, 'OMORI DEBUG'), status, h('button', { onclick: () => toggle(false) }, '×')),
        nav, body);
    // Keep keystrokes/clicks inside the panel away from the game's document-level handlers.
    for (const ev of ['keydown', 'keyup', 'keypress', 'mousedown', 'mouseup', 'touchstart', 'touchend', 'wheel', 'contextmenu', 'pointerdown']) {
        root.addEventListener(ev, e => { if (!(ev === 'contextmenu')) e.stopPropagation(); });
    }
    document.body.append(root);

    const started = () => !!(globalThis as any).$gameParty && !!(globalThis as any).$gamePlayer && !!(globalThis as any).$gameSwitches;
    const say = (msg: string) => { status.textContent = msg; setTimeout(() => { if (status.textContent === msg) status.textContent = ''; }, 2500); };

    function toggle(open = !root.classList.contains('open')) {
        root.classList.toggle('open', open);
        if (open) render();
        try { Input.clear(); } catch { /* not ready */ }
    }
    window.addEventListener('keydown', e => {
        const typing = (e.target as HTMLElement | null)?.closest?.('#dbg input');
        if ((e.key === 'F9' || e.code === 'Backquote') && !typing) { e.preventDefault(); toggle(); }
    });

    // ------------------------------------------------------------------ helpers on the game
    const search = (placeholder = 'filter (id or name)') =>
        h('input', { type: 'text', placeholder, value: filter, oninput: (e: Event) => { filter = (e.target as HTMLInputElement).value; renderList(); } });

    const matches = (id: number, name: string) => {
        const f = filter.trim().toLowerCase();
        return !f || String(id) === f || name.toLowerCase().includes(f);
    };

    /** Nearest walkable tile to the middle of the loaded map (spiral search). */
    function findStandableTile(): [number, number] {
        const m = $gameMap, cx = Math.floor(m.width() / 2), cy = Math.floor(m.height() / 2);
        const maxR = Math.max(m.width(), m.height());
        for (let r = 0; r < maxR; r++) {
            for (let dx = -r; dx <= r; dx++) for (let dy = -r; dy <= r; dy++) {
                if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
                const x = cx + dx, y = cy + dy;
                if (m.isValid(x, y) && m.isPassable(x, y, 2) && m.isPassable(x, y, 4) && m.isPassable(x, y, 6) && m.isPassable(x, y, 8)) return [x, y];
            }
        }
        return [cx, cy];
    }

    async function teleport(id: number) {
        if (!started() || !(SceneManager._scene instanceof Scene_Map)) {
            DataManager.setupNewGame();              // from the title/boot there is no game state yet
        }
        $gamePlayer.reserveTransfer(id, 0, 0, 2, 0);
        SceneManager.goto(Scene_Map);
        toggle(false);
        const t0 = performance.now();
        while (performance.now() - t0 < 30000) {
            await new Promise(r => setTimeout(r, 200));
            if (SceneManager._scene instanceof Scene_Map && $gameMap.mapId() === id && $dataMap?.width && !$gamePlayer.isTransferring()) break;
        }
        if ($gameMap.mapId() !== id) return;
        const [x, y] = findStandableTile();
        $gamePlayer.locate(x, y);
        // A fresh game starts with the player hidden and the camera unattached (the intro events fix that);
        // do it here so the jump lands somewhere playable.
        $gamePlayer.setTransparent(false);
        if ('camTarget' in $gameMap) $gameMap.camTarget = $gamePlayer; // GALV_CamControl
        $gameMap.setDisplayPos(x - $gamePlayer.centerX(), y - $gamePlayer.centerY());
    }

    // ------------------------------------------------------------------ tabs
    const needGame = () => started() ? null : h('div', { class: 'note' }, 'No game running yet — teleporting from the Maps tab starts a fresh one.');

    function rowsFor<T>(items: T[], idOf: (t: T, i: number) => number, nameOf: (t: T) => string, build: (id: number, name: string, t: T) => HTMLElement): HTMLElement {
        const wrap = h('div');
        let shown = 0, total = 0;
        items.forEach((t, i) => {
            const id = idOf(t, i), name = nameOf(t);
            if (!matches(id, name)) return;
            total++;
            if (shown < MAX_ROWS) { wrap.append(build(id, name, t)); shown++; }
        });
        if (total > shown) wrap.append(h('div', { class: 'note' }, `${total - shown} more — narrow the filter`));
        if (!total) wrap.append(h('div', { class: 'note' }, 'no matches'));
        return wrap;
    }

    let list: HTMLElement = h('div');
    function renderList() {
        const fresh = buildList();
        list.replaceWith(fresh); list = fresh;
    }

    function buildList(): HTMLElement {
        switch (tab) {
            case 'maps': {
                const infos = ($dataMapInfos ?? []).filter(Boolean) as any[];
                return rowsFor(infos, m => m.id, m => String(m.name).replace(/^[-\s]*/, ''), (id, name) => {
                    const ok = !mapIds || mapIds.has(id);
                    return h('div', { class: 'row hit', title: ok ? 'teleport here' : 'no tile data for this map (dev placeholder)', style: ok ? '' : 'opacity:.4', onclick: () => ok && void teleport(id) },
                        h('span', { class: 'id' }, String(id)), h('span', { class: 'nm' }, name));
                });
            }
            case 'switches': {
                const names: string[] = $dataSystem?.switches ?? [];
                return rowsFor(names.slice(1).map((n, i) => ({ n, i: i + 1 })), x => x.i, x => x.n || '', (id, name) => {
                    const box = h('input', { type: 'checkbox', checked: !!$gameSwitches?.value(id), onchange: (e: Event) => $gameSwitches.setValue(id, (e.target as HTMLInputElement).checked) });
                    return h('label', { class: 'row' }, h('span', { class: 'id' }, String(id)), h('span', { class: 'nm' }, name || '(unnamed)'), box);
                });
            }
            case 'variables': {
                const names: string[] = $dataSystem?.variables ?? [];
                return rowsFor(names.slice(1).map((n, i) => ({ n, i: i + 1 })), x => x.i, x => x.n || '', (id, name) => {
                    const inp = h('input', { type: 'number', value: String($gameVariables?.value(id) ?? 0), onchange: (e: Event) => $gameVariables.setValue(id, Number((e.target as HTMLInputElement).value)) });
                    return h('div', { class: 'row' }, h('span', { class: 'id' }, String(id)), h('span', { class: 'nm' }, name || '(unnamed)'), inp);
                });
            }
            case 'items': {
                const items = ($dataItems ?? []).filter((i: any) => i && i.name) as any[];
                return rowsFor(items, i => i.id, i => i.name, (id, name, it) => {
                    const have = () => $gameParty?.numItems(it) ?? 0;
                    const count = h('span', { class: 'id' }, String(have()));
                    const add = (n: number) => () => { if (!started()) return say('start a game first'); $gameParty.gainItem(it, n); count.textContent = String(have()); };
                    return h('div', { class: 'row' }, h('span', { class: 'id' }, String(id)), h('span', { class: 'nm', title: name }, name), count,
                        h('button', { onclick: add(1) }, '+1'), h('button', { onclick: add(-1) }, '−1'));
                });
            }
            default: return h('div');
        }
    }

    const btn = (label: string, fn: () => void) => h('button', { onclick: fn }, label);

    function partyTab(): HTMLElement {
        const wrap = h('div');
        const warn = needGame();
        if (warn) { wrap.append(warn); return wrap; }
        const members: any[] = $gameParty.members();
        wrap.append(h('div', { class: 'bar' },
            btn('Heal all', () => { members.forEach(a => a.recoverAll()); say('healed'); }),
            btn('+1000 gold', () => { $gameParty.gainGold(1000); say(`gold: ${$gameParty.gold()}`); }),
            btn($gamePlayer.isThrough?.() ? 'No-clip: ON' : 'No-clip: off', () => { $gamePlayer.setThrough(!$gamePlayer.isThrough()); render(); })));
        wrap.append(h('div', { class: 'bar' }, h('span', {}, 'Move speed'),
            h('input', { type: 'number', min: 1, max: 6, step: 1, value: String($gamePlayer.moveSpeed()), style: 'width:70px', onchange: (e: Event) => $gamePlayer.setMoveSpeed(Number((e.target as HTMLInputElement).value)) })));
        for (const a of members) {
            wrap.append(h('div', { class: 'row' }, h('span', { class: 'nm' }, `${a.name()}  HP ${a.hp}/${a.mhp}`), h('span', {}, 'Lv'),
                h('input', { type: 'number', min: 1, max: 99, value: String(a.level), style: 'width:64px', onchange: (e: Event) => { a.changeLevel(Number((e.target as HTMLInputElement).value), false); render(); } })));
        }
        return wrap;
    }

    function gameTab(): HTMLElement {
        const wrap = h('div');
        const params = new URLSearchParams(location.search);
        const reload = (k: string, v: string | null) => { v === null ? params.delete(k) : params.set(k, v); location.search = params.toString(); };
        const ce = h('input', { type: 'number', min: 1, placeholder: 'common event id', style: 'width:150px' });
        wrap.append(
            h('div', { class: 'note' }, `Renderer: ${Graphics._canvas?.width}×${Graphics._canvas?.height} backing, ${Graphics.width}×${Graphics.height} logical, UI box ${Graphics.boxWidth}×${Graphics.boxHeight}`),
            h('div', { class: 'bar' }, btn('Toggle FPS meter', () => { fpsOn = !fpsOn; fpsOn ? Graphics.showFps() : Graphics.hideFps(); }),
                btn(params.get('wide') === '0' ? 'Widescreen: off' : 'Widescreen: on', () => reload('wide', params.get('wide') === '0' ? null : '0'))),
            h('div', { class: 'bar' }, h('span', {}, 'Render scale'), ...[1, 2, 3, 4].map(q => btn(`${q}×`, () => reload('q', String(q))))),
            h('div', { class: 'bar' }, ce, btn('Run common event', () => {
                if (!started()) return say('start a game first');
                const id = Number(ce.value);
                if (!$dataCommonEvents?.[id]) return say('no such common event');
                $gameTemp.reserveCommonEvent(id); toggle(false);
            })),
            h('div', { class: 'note' }, 'Saved games and the cutscene-skip file live in this browser (IndexedDB).'),
            h('div', { class: 'bar' }, btn('Delete ALL browser saves…', () => {
                if (confirm('Delete every OMORI save stored in this browser? This cannot be undone.')) {
                    indexedDB.deleteDatabase('omori-fs'); location.reload();
                }
            })));
        return wrap;
    }

    function render() {
        nav.replaceChildren(...TABS.map(t => h('button', { class: t === tab ? 'on' : '', onclick: () => { tab = t; filter = ''; render(); } }, t)));
        body.replaceChildren();
        if (tab === 'party') body.append(partyTab());
        else if (tab === 'game') body.append(gameTab());
        else {
            const warn = tab === 'maps' ? null : needGame();
            body.append(h('div', { class: 'bar' }, search()));
            if (warn) body.append(warn);
            list = buildList();
            body.append(list);
        }
    }
}
