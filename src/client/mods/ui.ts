// Mod manager: drop a .zip (or folder) anywhere on the page to install it; F8 or the corner tab opens the panel.
// Installing only adds to the library; where a mod runs is a per-profile choice, and each profile has its own saves.
import { loadMod } from '../../mods/manifest.ts';
import { memTree, treeFromEntries, treeToZip, zipTreeFromBytes, type Tree } from '../../mods/vfs.ts';
import { planInstall } from '../../mods/pack.ts';
import { ARCHIVE_ACCEPT, ArchiveError, readArchive } from './archive.ts';
import { errors, onErrors } from './api.ts';
import { SAFE_MODE, engine, profile, records } from './runtime.ts';
import {
    DEFAULT_PROFILE, createProfile, deleteBackup, deleteProfile, exportSaves, listBackups, listMods, listProfiles, makeBackup, putMod,
    putSupport, removeMod, restoreInto, saveProfile, setActiveProfile, type Backup, type Profile,
} from './store.ts';

const CSS = `
#omm-tab{position:fixed;top:0;left:0;z-index:2147483000;font:12px/1 system-ui,sans-serif;color:#fff;background:#000a;border:0;border-bottom-right-radius:6px;padding:6px 9px;cursor:pointer;opacity:.25;transition:opacity .15s}
#omm-tab:hover,#omm-tab.has-err{opacity:1}#omm-tab.has-err{background:#a11c}
#omm-panel{position:fixed;top:0;left:0;bottom:0;width:min(460px,100vw);z-index:2147483001;background:#101014f2;color:#e8e8ee;font:13px/1.45 system-ui,sans-serif;display:none;flex-direction:column;box-shadow:4px 0 24px #000a}
#omm-panel.open{display:flex}
#omm-panel header{display:flex;align-items:center;gap:8px;padding:12px 14px;border-bottom:1px solid #2a2a34}
#omm-panel h2{margin:0;font-size:15px;flex:1}
#omm-panel button,#omm-panel .btn{font:inherit;color:#fff;background:#2b2b38;border:1px solid #3a3a4a;border-radius:5px;padding:5px 10px;cursor:pointer}
#omm-panel button:hover{background:#383849}#omm-panel button:disabled{opacity:.4;cursor:default}
#omm-panel .primary{background:#3a56c8;border-color:#4c68dc}
#omm-panel select{font:inherit;color:#fff;background:#2b2b38;border:1px solid #3a3a4a;border-radius:5px;padding:5px 8px;max-width:100%;width:100%;margin-top:4px}
#omm-body{overflow:auto;padding:10px 14px;flex:1}
.omm-drop{border:2px dashed #3a3a4a;border-radius:8px;padding:16px;text-align:center;color:#9a9ab0;margin-bottom:12px}
.omm-box{border:1px solid #2a2a34;border-radius:8px;padding:10px 11px;margin-bottom:12px;background:#14141a}
.omm-btns{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}
.omm-note{color:#9a9ab0;font-size:12px;margin-top:6px}
.omm-mod{border:1px solid #2a2a34;border-radius:8px;padding:9px 11px;margin-bottom:8px;background:#16161c}
.omm-mod.off{opacity:.6}.omm-mod.bad{border-color:#a33}
.omm-row{display:flex;gap:8px;align-items:center}.omm-row .grow{flex:1;min-width:0}
.omm-name{font-weight:600}.omm-meta{color:#8a8aa0;font-size:12px}
.omm-msg{margin:6px 0 0;padding:6px 8px;border-radius:5px;font:12px/1.4 ui-monospace,Consolas,monospace;white-space:pre-wrap;word-break:break-word}
.omm-msg.error{background:#3a1519;color:#ffb4b4}.omm-msg.warn{background:#352c12;color:#f2d98a}
.omm-h{margin:14px 0 6px;font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:#8a8aa0}
#omm-overlay{position:fixed;inset:0;z-index:2147483002;background:#0008;color:#fff;display:none;align-items:center;justify-content:center;font:600 22px system-ui,sans-serif;pointer-events:none;border:4px dashed #6c88ff}
#omm-overlay.show{display:flex}
#omm-toast{position:fixed;bottom:14px;left:50%;transform:translateX(-50%);z-index:2147483003;background:#101014;color:#fff;border:1px solid #3a3a4a;border-radius:8px;padding:10px 14px;font:13px system-ui,sans-serif;display:none;gap:10px;align-items:center;flex-wrap:wrap;max-width:90vw}
#omm-toast.show{display:flex}
`;

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<Omit<HTMLElementTagNameMap[K], 'style'>> & { class?: string; style?: string } = {}, ...kids: (Node | string)[]) => {
    const e = document.createElement(tag);
    const { class: cls, style, ...rest } = props as any;
    if (cls) e.className = cls;
    if (style) e.setAttribute('style', style);
    Object.assign(e, rest);
    e.append(...kids);
    return e;
};

let tab: HTMLButtonElement, panel: HTMLElement, body: HTMLElement, toast: HTMLElement, overlay: HTMLElement;
const failures: string[] = [];

export function installModUi() {
    document.head.append(el('style', { textContent: CSS }));
    tab = el('button', { id: 'omm-tab', title: 'Mods & profiles (F8)', onclick: () => toggle() }, 'Mods');
    body = el('div', { id: 'omm-body' });
    panel = el('div', { id: 'omm-panel' },
        el('header', {}, el('h2', {}, 'Mods & profiles'),
            el('button', { id: 'omm-reload', class: 'primary', textContent: 'Apply & reload', style: 'display:none', onclick: () => location.reload() }),
            el('button', { textContent: '✕', title: 'Close (F8)', onclick: () => toggle(false) })),
        body);
    toast = el('div', { id: 'omm-toast' });
    overlay = el('div', { id: 'omm-overlay' }, 'Drop a mod (.zip, .7z, .rar or folder) to install');
    document.body.append(tab, panel, toast, overlay);

    window.addEventListener('keydown', e => { if (e.key === 'F8') { e.preventDefault(); toggle(); } });
    onErrors(() => { refreshTab(); if (panel.classList.contains('open')) void render(); });
    installDragDrop();
    refreshTab();
}

/** Open the mod & profile manager (also on F8). */
export const openModManager = () => toggle(true);

function toggle(force?: boolean) {
    const open = force ?? !panel.classList.contains('open');
    panel.classList.toggle('open', open);
    if (open) void render();
}

function refreshTab() {
    const n = errors.filter(e => e.level === 'error').length;
    const where = profile && profile.id !== DEFAULT_PROFILE ? ` · ${profile.name}` : '';
    tab.classList.toggle('has-err', n > 0);
    tab.textContent = n ? `Mods ⚠ ${n}${where}` : SAFE_MODE ? 'Mods (safe mode)' : `Mods${where}`;
}

function say(text: string, ...actions: [string, () => void][]) {
    toast.replaceChildren(el('span', {}, text));
    actions.forEach(([label, fn], i) => toast.append(el('button', {
        textContent: label, onclick: fn,
        style: `font:inherit;color:#fff;background:${i ? '#2b2b38' : '#3a56c8'};border:0;border-radius:5px;padding:5px 10px;cursor:pointer`,
    })));
    toast.classList.add('show');
    clearTimeout((say as any).t);
    (say as any).t = setTimeout(() => toast.classList.remove('show'), actions.length ? 30000 : 5000);
}

function markDirty() {
    document.getElementById('omm-reload')!.style.display = '';
    say('Changes apply after a reload.', ['Reload now', () => location.reload()]);
    void render();
}

// ---------------------------------------------------------------- install
export interface InstallResult { ok: boolean; label: string; message: string }

/** Validate and store one mod in the library. Returns what to tell the user; never throws. */
export async function installMod(label: string, zip: Uint8Array): Promise<InstallResult> {
    let tree: Tree;
    try { tree = zipTreeFromBytes(zip); } catch (e) { return { ok: false, label, message: `${label}: not a valid zip file (${(e as Error).message})` }; }
    const def = loadMod(tree, label);
    if (def.errors.length) return { ok: false, label, message: `${label} can't be installed:\n• ${def.errors.join('\n• ')}` };
    const key = 'browser:' + def.id;
    const existing = (await listMods()).find(r => r.key === key);
    await putMod({ key, label: def.id, origin: 'browser', zip, stamp: `${zip.length}:${Date.now()}` });
    const warn = def.warnings.length ? ` (${def.warnings.length} warning${def.warnings.length > 1 ? 's' : ''})` : '';
    return { ok: true, label: key, message: `${existing ? 'Updated' : 'Installed'} "${def.name}" ${def.version}${warn}` };
}

/** Reads a nested archive that isn't a zip (7z, rar, tar.*) found inside a pack. */
const nestedReader = (name: string, bytes: Uint8Array) => readArchive(new File([bytes as BlobPart], name));

interface Outcome { results: InstallResult[]; notes: string[]; pack?: string }
const notes: string[] = [];

/**
 * Install whatever `entries` contains: a single mod, or a modpack (a collection such as OMO CEP that ships its mods as
 * nested zips). Everything is normalised to one zip per mod, so the rest of the system only ever deals with zips.
 */
async function installEntries(label: string, entries: Record<string, Uint8Array>): Promise<Outcome> {
    say(`Reading ${label}…`);
    const plan = await planInstall(label, entries, nestedReader);
    const skipped = plan.skipped.map(s => `${s.name}: ${s.reason}`);
    if (plan.kind === 'none') {
        return { results: [{ ok: false, label, message: `${label}: no mod found. A mod needs a mod.json (at its root, in one folder, or inside a "mods" folder of a pack).` }], notes: skipped };
    }
    if (plan.support) await putSupport('imagediff2', treeToZip(memTree(plan.support))).catch(() => {});
    const results: InstallResult[] = [];
    for (const [i, item] of plan.items.entries()) {
        if (plan.items.length > 1) say(`Installing ${i + 1}/${plan.items.length}: ${item.label}`);
        results.push(await installMod(item.label, treeToZip(treeFromEntries(item.entries))));
    }
    return { results, notes: skipped, pack: plan.kind === 'pack' ? label : undefined };
}

const labelOf = (name: string) => name.replace(/\.(zip|7z|rar|tar|tgz|tar\.gz|tar\.bz2|tbz2|tar\.xz|txz|gz|bz2|xz|mod|omm)$/i, '');

/** Any supported archive (zip, 7z, rar, tar.*), alone or several at once. */
async function installFiles(files: File[]) {
    const out: Outcome[] = [];
    for (const f of files) {
        try {
            const entries = await readArchive(f, { onProgress: m => say(m), askPassword: () => prompt(`${f.name} is password protected. Password:`) });
            out.push(await installEntries(labelOf(f.name), entries));
        } catch (e) {
            out.push({ results: [{ ok: false, label: f.name, message: e instanceof ArchiveError ? e.message : `${f.name}: ${(e as Error).message}` }], notes: [] });
        }
    }
    finish(out);
}

async function installFolder(name: string, entries: Record<string, Uint8Array>) {
    try { finish([await installEntries(name, entries)]); }
    catch (e) { finish([{ results: [{ ok: false, label: name, message: `${name}: ${(e as Error).message}` }], notes: [] }]); }
}

function finish(outcomes: Outcome[]) {
    if (!outcomes.length) return;
    const results = outcomes.flatMap(o => o.results);
    for (const r of results) (r.ok ? console.log : console.warn)(`[mods] ${r.message}`);
    const bad = results.filter(r => !r.ok), good = results.filter(r => r.ok);
    failures.splice(0, failures.length, ...bad.map(b => b.message));
    notes.splice(0, notes.length, ...outcomes.flatMap(o => o.notes));
    const pack = outcomes.find(o => o.pack)?.pack;
    if (good.length) {
        // Installing only adds to the library. Where it runs is the player's call; the safe default is a separate profile.
        const summary = good.length > 3
            ? `Installed ${good.length} mod${good.length === 1 ? '' : 's'}${pack ? ` from ${pack}` : ''}${bad.length ? `, ${bad.length} failed` : ''}${notes.length ? `, ${notes.length} skipped` : ''}.`
            : `${bad.length ? `${good.length} installed, ${bad.length} failed. ` : ''}${good.map(r => r.message).join('; ')}`;
        say(summary,
            ['Try in a new profile', () => void tryInNewProfile(good.map(r => r.label), pack)],
            ['Add to this profile', () => void enableHere(good.map(r => r.label))],
            ['Not now', () => toast.classList.remove('show')]);
    } else say(bad.map(r => r.message).join('\n'));
    if (panel.classList.contains('open') || bad.length || notes.length) toggle(true);
    void render();
}

// ---------------------------------------------------------------- drag & drop
async function readEntry(entry: FileSystemEntry, prefix: string, out: Record<string, Uint8Array>): Promise<void> {
    if (entry.isFile) {
        const file = await new Promise<File>((res, rej) => (entry as FileSystemFileEntry).file(res, rej));
        out[prefix + entry.name] = new Uint8Array(await file.arrayBuffer());
    } else if (entry.isDirectory) {
        const reader = (entry as FileSystemDirectoryEntry).createReader();
        for (;;) { // readEntries returns batches
            const batch = await new Promise<FileSystemEntry[]>((res, rej) => reader.readEntries(res, rej));
            if (!batch.length) break;
            for (const c of batch) await readEntry(c, prefix + entry.name + '/', out);
        }
    }
}

function installDragDrop() {
    let depth = 0;
    const hasFiles = (e: DragEvent) => [...(e.dataTransfer?.types ?? [])].includes('Files');
    window.addEventListener('dragenter', e => { if (hasFiles(e)) { depth++; overlay.classList.add('show'); } });
    window.addEventListener('dragleave', e => { if (hasFiles(e) && --depth <= 0) { depth = 0; overlay.classList.remove('show'); } });
    window.addEventListener('dragover', e => { if (hasFiles(e)) e.preventDefault(); });
    window.addEventListener('drop', async e => {
        if (!hasFiles(e)) return;
        e.preventDefault(); depth = 0; overlay.classList.remove('show');
        const items = [...(e.dataTransfer?.items ?? [])];
        const entries = items.map(i => i.webkitGetAsEntry?.()).filter((x): x is FileSystemEntry => !!x);
        const files: File[] = [];
        for (const entry of entries) {
            if (entry.isDirectory) {
                const all: Record<string, Uint8Array> = {};
                await readEntry(entry, '', all);
                // Strip the dropped folder's own name so mod.json sits at the root.
                const root = entry.name + '/';
                const flat = Object.fromEntries(Object.entries(all).map(([k, v]) => [k.startsWith(root) ? k.slice(root.length) : k, v]));
                await installFolder(entry.name, flat);
            } else {
                const f = items.find(i => i.webkitGetAsEntry?.() === entry)?.getAsFile();
                if (f) files.push(f);
            }
        }
        if (files.length) await installFiles(files);
    });
}

async function fromFolderInput(input: HTMLInputElement) {
    const files = [...(input.files ?? [])];
    if (!files.length) return;
    const root = (files[0] as any).webkitRelativePath.split('/')[0] as string;
    const all: Record<string, Uint8Array> = {};
    for (const f of files) all[(f as any).webkitRelativePath.slice(root.length + 1)] = new Uint8Array(await f.arrayBuffer());
    await installFolder(root, all);
}

// ---------------------------------------------------------------- profiles
const reloadWithoutProfileParam = () => { const u = new URL(location.href); u.searchParams.delete('profile'); location.replace(u); };

/** Leave the current profile (its saves are snapshotted first) and reload as `id`. */
async function switchTo(id: string) {
    if (profile && id !== profile.id) await makeBackup(profile, 'before switching profile');
    await setActiveProfile(id);
    reloadWithoutProfileParam();
}

async function tryInNewProfile(keys: string[], packName?: string) {
    const names = packName ?? keys.map(k => records.find(r => r.key === k)?.label ?? k).join(', ');
    const name = prompt('Name for the new profile (your current saves are not touched):', names.slice(0, 40));
    if (name === null) return;
    const copy = confirm('Copy your current saves into the new profile, so you can continue where you left off?\n\nOK = copy current saves\nCancel = start with a fresh save');
    const p = await createProfile(name, { enabled: keys, copySavesFrom: copy ? profile?.id : undefined });
    await switchTo(p.id);
}

async function enableHere(keys: string[]) {
    if (!profile) return;
    if (profile.id === DEFAULT_PROFILE && !confirm('This is your Original game profile. Mods here change how your existing saves behave, and a modded save may not load without them.\n\nA backup is taken first. Continue?')) return;
    await makeBackup(profile, 'before adding mods');
    profile.enabled = [...new Set([...profile.enabled, ...keys])];
    await saveProfile(profile);
    markDirty();
}

const fmtTime = (t: number) => new Date(t).toLocaleString();
const slug = (s: string) => s.replace(/\W+/g, '_');
function download(name: string, bytes: Uint8Array) {
    const a = el('a', { href: URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'application/zip' })), download: name });
    document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

// ---------------------------------------------------------------- panel
async function render() {
    const [profiles, backups] = await Promise.all([listProfiles().catch(() => [] as Profile[]), listBackups().catch(() => [] as Backup[])]);
    const kids: (Node | string)[] = [];

    // ---- profile
    if (profile) {
        const select = el('select', { onchange: () => void switchTo(select.value) },
            ...profiles.map(p => el('option', { value: p.id, selected: p.id === profile!.id, textContent: `${p.name}${p.id === DEFAULT_PROFILE ? ' (your existing saves)' : ''} · ${p.enabled.length} mod${p.enabled.length === 1 ? '' : 's'}${p.devAuto ? ' + dev folder' : ''}` })));
        const box = el('div', { class: 'omm-box' }, el('div', { class: 'omm-meta' }, 'Profile'), select,
            el('div', { class: 'omm-btns' },
                el('button', { textContent: 'New…', onclick: async () => {
                    const name = prompt('New profile name:'); if (name === null) return;
                    const copy = confirm("Copy this profile's saves and mods into it?\n\nOK = copy\nCancel = start fresh");
                    const p = await createProfile(name, { copySavesFrom: copy ? profile!.id : undefined, enabled: copy ? [...profile!.enabled] : [] });
                    await switchTo(p.id);
                } }),
                el('button', { textContent: 'Rename', onclick: async () => { const n = prompt('Rename profile:', profile!.name); if (n?.trim()) { profile!.name = n.trim(); await saveProfile(profile!); refreshTab(); void render(); } } }),
                ...(profile.id !== DEFAULT_PROFILE ? [el('button', { textContent: 'Delete', onclick: async () => {
                    if (!confirm(`Delete profile "${profile!.name}" and its saves?\n\nA backup of its saves is kept under Save backups.`)) return;
                    const id = profile!.id;
                    await setActiveProfile(DEFAULT_PROFILE); await deleteProfile(id); reloadWithoutProfileParam();
                } })] : [])),
            el('div', { class: 'omm-note' }, profile.id === DEFAULT_PROFILE
                ? 'These are your original saves. To try a mod without any risk to them, install it and choose "Try in a new profile".'
                : 'This profile has its own saves, separate from every other profile. Switching never overwrites anything; the profile you leave is backed up first.'));
        if (records.some(r => r.origin === 'server')) {
            const cb = el('input', { type: 'checkbox', checked: profile.devAuto, onchange: async () => { profile!.devAuto = cb.checked; await saveProfile(profile!); markDirty(); } });
            box.append(el('label', { class: 'omm-note', style: 'display:block' }, cb, ' Load every mod from the dev ./mods folder automatically'));
        }
        kids.push(box);
    }

    // ---- install
    const input = el('input', { type: 'file', accept: ARCHIVE_ACCEPT, multiple: true, style: 'display:none', onchange: () => { void installFiles([...(input.files ?? [])]); } });
    const folder = el('input', { type: 'file', multiple: true, style: 'display:none', onchange: () => { void fromFolderInput(folder); } });
    folder.setAttribute('webkitdirectory', '');
    kids.push(el('div', { class: 'omm-drop' }, 'Drag a mod (.zip, .7z, .rar, .tar.gz or a folder) onto the game, or ',
        el('button', { textContent: 'choose a file…', onclick: () => input.click() }), ' ',
        el('button', { textContent: 'choose a folder…', onclick: () => folder.click() }), input, folder));

    if (SAFE_MODE) kids.push(el('div', { class: 'omm-msg warn' }, 'Safe mode: mods are not loaded for this session. ', el('a', { href: location.pathname, style: 'color:#fff', textContent: 'Start normally' })));
    for (const f of failures) kids.push(el('div', { class: 'omm-msg error' }, f));
    for (const n of notes) kids.push(el('div', { class: 'omm-meta', style: 'margin:4px 0' }, `Skipped ${n}`));

    // ---- mod library, with this profile's on/off state
    kids.push(el('div', { class: 'omm-h' }, 'Mod library'));
    if (records.length > 1 && profile) {
        const setAll = async (on: boolean) => {
            if (on && profile!.id === DEFAULT_PROFILE && !confirm('This is your Original game profile. Enabling mods here changes how your existing saves behave. A new profile is safer.\n\nEnable all anyway? (A backup is taken first.)')) return;
            if (on) await makeBackup(profile!, 'before enabling mods');
            profile!.enabled = on ? records.filter(r => r.origin === 'browser').map(r => r.key) : [];
            await saveProfile(profile!); markDirty();
        };
        const enabledCount = records.filter(r => profile!.enabled.includes(r.key) || (profile!.devAuto && r.origin === 'server')).length;
        kids.push(el('div', { class: 'omm-btns', style: 'margin:0 0 8px;align-items:center' }, el('span', { class: 'omm-meta' }, `${enabledCount} of ${records.length} enabled in this profile`),
            el('button', { textContent: 'Enable all', onclick: () => void setAll(true) }), el('button', { textContent: 'Disable all', onclick: () => void setAll(false) })));
    }
    if (!records.length) kids.push(el('div', { class: 'omm-meta' }, 'No mods installed.'));
    const loaded = new Map(engine.mods.map(m => [m.origin, m]));
    for (const rec of records) {
        const m = loaded.get(rec.key);
        const auto = !!profile?.devAuto && rec.origin === 'server';
        const on = !!profile && (profile.enabled.includes(rec.key) || auto);
        const bad = !!m && m.errors.length > 0;
        const toggleBtn = el('button', { textContent: on ? 'Disable' : 'Enable', disabled: auto, onclick: async () => {
            if (!profile) return;
            if (!on && profile.id === DEFAULT_PROFILE && !confirm('This is your Original game profile. Enabling a mod here changes how your existing saves behave. A new profile is safer.\n\nEnable anyway? (A backup is taken first.)')) return;
            if (!on) await makeBackup(profile, 'before enabling a mod');
            profile.enabled = on ? profile.enabled.filter(k => k !== rec.key) : [...profile.enabled, rec.key];
            await saveProfile(profile); markDirty();
        } });
        const row = el('div', { class: 'omm-row' },
            el('div', { class: 'grow' }, el('div', { class: 'omm-name' }, m?.name ?? rec.label), el('div', { class: 'omm-meta' },
                m ? `${m.id} · v${m.version}${m.author ? ' · ' + m.author : ''} · ${m.format === 'oneloader' ? 'OneLoader mod' : 'native'}${rec.origin === 'server' ? ' · dev folder' : ''}` : `${rec.label} (not enabled in this profile)`)),
            ...(bad ? [] : [toggleBtn]),
            ...(rec.origin === 'browser' ? [el('button', { textContent: 'Delete', title: 'Remove from the library (all profiles)', onclick: async () => {
                if (!confirm(`Delete "${rec.label}" from the library? Every profile using it loses it. Saves are not touched.`)) return;
                await removeMod(rec.key); records.splice(records.indexOf(rec), 1); if (profile) profile.enabled = profile.enabled.filter(k => k !== rec.key); markDirty();
            } })] : []));
        const card = el('div', { class: 'omm-mod' + (on ? '' : ' off') + (bad ? ' bad' : '') }, row);
        if (m?.description) card.append(el('div', { class: 'omm-meta', style: 'margin-top:4px' }, m.description));
        for (const x of m?.errors ?? []) card.append(el('div', { class: 'omm-msg error' }, x));
        for (const x of m?.warnings ?? []) card.append(el('div', { class: 'omm-msg warn' }, x));
        kids.push(card);
    }

    // ---- runtime errors
    const runtime = errors.filter(e => !engine.mods.some(m => m.errors.includes(e.message) || m.warnings.includes(e.message)));
    if (runtime.length) {
        kids.push(el('div', { class: 'omm-h' }, 'Errors & warnings (newest first)'));
        for (const e of [...runtime].reverse().slice(0, 40)) {
            kids.push(el('div', { class: `omm-msg ${e.level}` }, `[${e.mod}]${e.count > 1 ? ` ×${e.count}` : ''} ${e.message}${e.stack ? '\n' + e.stack.split('\n').slice(1, 4).join('\n') : ''}`));
        }
        kids.push(el('button', { textContent: 'Clear', onclick: () => { errors.length = 0; refreshTab(); void render(); } }));
    }

    // ---- save backups
    kids.push(el('div', { class: 'omm-h' }, 'Save backups'));
    const imp = el('input', { type: 'file', accept: '.zip', style: 'display:none', onchange: async () => {
        const f = imp.files?.[0]; if (!f || !profile) return;
        if (!confirm(`Replace the saves of "${profile.name}" with the contents of ${f.name}? The current saves are backed up first.`)) return;
        const n = await restoreInto(profile, new Uint8Array(await f.arrayBuffer()));
        say(`Restored ${n} file(s).`, ['Reload', () => location.reload()]);
    } });
    kids.push(el('div', { class: 'omm-btns', style: 'margin:0 0 8px' },
        el('button', { textContent: 'Back up now', onclick: async () => {
            if (!profile) return;
            const b = await makeBackup(profile, 'manual');
            say(b ? `Backed up ${b.files} file(s).` : 'Nothing to back up yet: this profile has no save data.');
            void render();
        } }),
        el('button', { textContent: 'Download saves (.zip)', onclick: async () => { if (profile) download(`omori-saves-${slug(profile.name)}.zip`, await exportSaves(profile)); } }),
        el('button', { textContent: 'Import saves…', onclick: () => imp.click() }), imp));
    if (!backups.length) kids.push(el('div', { class: 'omm-meta' }, 'No backups yet. They are made automatically before you switch or delete a profile, or change mods in the original one.'));
    for (const b of backups.slice(0, 12)) {
        const target = profiles.find(p => p.id === b.profile);
        kids.push(el('div', { class: 'omm-mod' }, el('div', { class: 'omm-row' },
            el('div', { class: 'grow' }, el('div', { class: 'omm-name' }, b.profileName), el('div', { class: 'omm-meta' }, `${fmtTime(b.time)} · ${b.reason} · ${b.files} file(s)`)),
            el('button', { textContent: 'Restore', title: target ? `Into "${target.name}"` : 'Into the current profile', onclick: async () => {
                const dest = target ?? profile!;
                if (!confirm(`Restore this backup into "${dest.name}"? Its current saves are backed up first.`)) return;
                await restoreInto(dest, b.zip);
                if (dest.id === profile?.id) location.reload(); else { say(`Restored into "${dest.name}".`); void render(); }
            } }),
            el('button', { textContent: '↓', title: 'Download', onclick: () => download(`omori-backup-${slug(b.profileName)}-${b.time}.zip`, b.zip) }),
            el('button', { textContent: '✕', title: 'Delete backup', onclick: async () => { await deleteBackup(b.id); void render(); } }))));
    }

    kids.push(el('div', { class: 'omm-h' }, 'Tips'), el('div', { class: 'omm-meta' }, 'Add ?mods=0 to the address to start with no mods at all. ?profile=<id> opens a specific profile. ?hot=1 reloads automatically when the dev mods folder changes.'));
    body.replaceChildren(...kids);
}
