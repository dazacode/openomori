// Mod engine: discovers mods, orders them, and answers "what are the bytes of game file X?" with every
// mod's edits applied. Game data is encrypted at rest, so edited files are decrypted, edited as plain
// JSON/YAML/text, then re-encrypted with the game's own key. Images and audio use RPG Maker's lighter
// scheme (a header and an XOR over the first 16 bytes), re-applied with the game's asset key.
// The game never knows a mod was involved.
import aesjs from 'aes-js';
import yaml from 'js-yaml';
import { formatOfGamePath, loadMod, type ClientScript, type Edit, type ModDef } from './manifest.ts';
import { PatchError, applyJsonPatch, applyMergePatch, applyTextPatch } from './patch.ts';
import type { Tree } from './vfs.ts';

export interface Diagnostic { level: 'error' | 'warn' | 'info'; mod?: string; file?: string; message: string; time: number }

export interface ModSource {
    /** fallback id / display label (file name without extension) */
    label: string;
    tree: Tree;
    /** where it came from, for messages: a path, "browser", "server" */
    origin?: string;
    /** user switched it off */
    disabled?: boolean;
}

export interface LoadedMod extends ModDef {
    origin: string;
    enabled: boolean;
    /** disabled by the user, not because of an error */
    userDisabled: boolean;
    order: number;
    tree: Tree;
}

const dec = new TextDecoder(), enc = new TextEncoder();
const BOM = /^﻿/;

/** RPG Maker MV's encrypted-asset header: "RPGMV" + version + padding. */
const RPG_HEADER = new Uint8Array([0x52, 0x50, 0x47, 0x4d, 0x56, 0, 0, 0, 0x00, 0x03, 0x01, 0, 0, 0, 0, 0]);

/** The asset key is stored in the game's (encrypted) System data as 32 hex digits. */
export function assetKeyFromSystem(systemJson: { encryptionKey?: string }): Uint8Array {
    const hex = systemJson.encryptionKey ?? '';
    const out = new Uint8Array(Math.floor(hex.length / 2));
    for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
    return out;
}

export class ModEngine {
    mods: LoadedMod[] = [];
    diagnostics: Diagnostic[] = [];
    version = 0;
    /** set by the host once it has read the game's System data; needed to encode replaced images and audio */
    assetKey: Uint8Array | null = null;
    private edits = new Map<string, { mod: LoadedMod; edit: Edit }[]>(); // lowercase game path -> ordered edits
    private generated = new Map<string, Uint8Array>(); // finished bytes made by other code (patched images)
    private cache = new Map<string, { sig: string; bytes: Uint8Array }>();

    constructor(
        private getKey: () => string | null = () => null,
        private onLog?: (d: Diagnostic) => void,
    ) {}

    // ------------------------------------------------------------ logging
    log(level: Diagnostic['level'], message: string, extra: Partial<Diagnostic> = {}) {
        const d: Diagnostic = { level, message, time: Date.now(), ...extra };
        this.diagnostics.push(d);
        if (this.diagnostics.length > 500) this.diagnostics.shift();
        this.onLog?.(d);
    }

    // ------------------------------------------------------------ loading
    /** Replace the active mod set. Invalid mods stay in `mods` (disabled, with their errors) so a UI can show why. */
    load(sources: ModSource[]) {
        this.version++;
        this.mods = []; this.edits.clear(); this.cache.clear(); this.generated.clear();
        this.diagnostics = [];

        const found: LoadedMod[] = [];
        for (const src of sources) {
            try {
                const def = loadMod(src.tree, src.label);
                found.push({ ...def, origin: src.origin ?? src.label, enabled: !src.disabled, userDisabled: !!src.disabled, order: 0, tree: src.tree });
            } catch (e) {
                this.log('error', `cannot read mod "${src.label}": ${(e as Error).message}`, { mod: src.label });
            }
        }
        for (const m of found) {
            for (const w of m.warnings) this.log('warn', w, { mod: m.id });
            for (const e of m.errors) this.log('error', e, { mod: m.id });
            if (m.errors.length) m.enabled = false;
        }
        this.order(found);
        this.checkCompatibility(found);
        // compatibility can disable mods after ordering; keep order numbers dense
        found.filter(m => m.enabled).sort((a, b) => a.order - b.order).forEach((m, i) => (m.order = i));
        this.mods = found;
        for (const m of this.activeMods()) {
            for (const edit of m.edits) {
                const k = edit.target.toLowerCase();
                (this.edits.get(k) ?? this.edits.set(k, []).get(k)!).push({ mod: m, edit });
            }
        }
        const on = this.mods.filter(m => m.enabled);
        this.log('info', `${on.length} mod(s) active${on.length ? ': ' + on.map(m => `${m.id}@${m.version}`).join(', ') : ''}; ${this.mods.length - on.length} disabled`);
        this.detectConflicts();
    }

    /** Dependencies first, then `loadAfter`, otherwise by priority (lower first) and id. Missing deps / cycles disable the mod with a clear reason. */
    private order(mods: LoadedMod[]) {
        const byId = new Map<string, LoadedMod>();
        for (const m of mods) {
            if (byId.has(m.id)) { this.log('error', `duplicate mod id "${m.id}" (${m.origin} ignored)`, { mod: m.id }); m.enabled = false; }
            else byId.set(m.id, m);
        }
        for (let changed = true; changed;) { // disabling a mod can orphan its dependents
            changed = false;
            for (const m of mods) {
                if (!m.enabled) continue;
                for (const d of m.dependencies) {
                    if (!byId.get(d)?.enabled) { this.log('error', `requires mod "${d}", which is ${byId.has(d) ? 'disabled' : 'not installed'}`, { mod: m.id }); m.enabled = false; changed = true; break; }
                }
            }
        }
        const active = mods.filter(m => m.enabled).sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
        const done = new Set<string>(), visiting = new Set<string>(), out: LoadedMod[] = [];
        const visit = (m: LoadedMod) => {
            if (done.has(m.id)) return;
            if (visiting.has(m.id)) { this.log('error', `dependency cycle through "${m.id}"`, { mod: m.id }); m.enabled = false; return; }
            visiting.add(m.id);
            for (const d of [...m.dependencies, ...m.loadAfter]) { const dm = byId.get(d); if (dm?.enabled) visit(dm); }
            visiting.delete(m.id); done.add(m.id);
            if (m.enabled) out.push(m);
        };
        active.forEach(visit);
        out.forEach((m, i) => (m.order = i));
    }

    /**
     * OneLoader-style `requires` / `excludes` / `satisfies` / `skip_checks`. A missing requirement disables the mod. OneLoader
     * itself starts with no mods at all when two mods exclude each other; here that is a warning, so one clash can't take down a pack.
     */
    private checkCompatibility(mods: LoadedMod[]) {
        for (let changed = true; changed;) {
            changed = false;
            const live = mods.filter(m => m.enabled);
            const satisfied = new Set<string>();
            const skip = new Map<string, Set<string>>();
            for (const m of live) {
                satisfied.add(m.id.toLowerCase());
                for (const s of m.satisfies) satisfied.add(s.toLowerCase());
                for (const [victim, names] of Object.entries(m.skipChecks)) {
                    const set = skip.get(victim.toLowerCase()) ?? skip.set(victim.toLowerCase(), new Set()).get(victim.toLowerCase())!;
                    for (const n of names) set.add(n.toLowerCase());
                }
            }
            for (const m of live) {
                const skips = new Set(skip.get(m.id.toLowerCase()) ?? []);
                for (const s of m.satisfies) for (const n of skip.get(s.toLowerCase()) ?? []) skips.add(n);
                for (const req of m.requires) {
                    if (skips.has(req.toLowerCase()) || satisfied.has(req.toLowerCase())) continue;
                    this.log('error', `requires "${req}", which is not installed or not enabled`, { mod: m.id });
                    m.enabled = false; changed = true; break;
                }
            }
        }
        const live = mods.filter(m => m.enabled);
        const satisfiedBy = new Map<string, string[]>();
        for (const m of live) for (const k of [m.id, ...m.satisfies]) (satisfiedBy.get(k.toLowerCase()) ?? satisfiedBy.set(k.toLowerCase(), []).get(k.toLowerCase())!).push(m.name);
        for (const m of live) {
            for (const ex of m.excludes) {
                const others = (satisfiedBy.get(ex.toLowerCase()) ?? []).filter(n => n !== m.name);
                if (others.length) this.log('warn', `declares that it conflicts with "${ex}" (${others.join(', ')}), which is also enabled; they may fight over the same files`, { mod: m.id });
            }
        }
    }

    private detectConflicts() {
        for (const [target, list] of this.edits) {
            const replacers = list.filter(e => e.edit.kind === 'replace' || e.edit.kind === 'raw');
            if (replacers.length > 1) {
                this.log('warn', `${target}: replaced by ${replacers.map(r => r.mod.id).join(' then ')}; the last one wins. Use a patch instead of a full replace to combine mods.`);
            }
        }
    }

    // ------------------------------------------------------------ queries
    activeMods() { return this.mods.filter(m => m.enabled).sort((a, b) => a.order - b.order); }

    scriptsFor(phase: ClientScript['phase']) {
        return this.activeMods().flatMap(m => m.scripts.filter(s => s.phase === phase).map(s => ({ mod: m.id, file: s.file })));
    }

    /** Names a mod adds to (or hides from) a game directory listing, so readdir sees new maps etc. */
    addedNames(dirRel: string): string[] {
        const prefix = dirRel ? dirRel.toLowerCase().replace(/\/+$/, '') + '/' : '';
        const names = new Set<string>();
        for (const [k, list] of this.edits) {
            if (!k.startsWith(prefix)) continue;
            const rest = k.slice(prefix.length);
            if (!rest.includes('/')) names.add(list[0]!.edit.target.slice(list[0]!.edit.target.lastIndexOf('/') + 1));
        }
        return [...names];
    }

    modFile(id: string, path: string): Uint8Array | null {
        const m = this.mods.find(x => x.id === id && x.enabled);
        if (!m || !m.tree.files.includes(path)) return null;
        return m.tree.read(path);
    }

    // ------------------------------------------------------------ resolution
    hasEdits(gamePath: string) { const k = gamePath.toLowerCase(); return this.edits.has(k) || this.generated.has(k); }

    /** Register finished bytes for a game file (used for images patched by image deltas). They win over mod edits. */
    setGenerated(gamePath: string, bytes: Uint8Array) { this.generated.set(gamePath.toLowerCase(), bytes); }

    /**
     * Bytes for `gamePath` with all mod edits applied, or null when no mod touches it
     * (the caller then serves the original file). `baseBytes` is the original, if one exists.
     */
    resolve(gamePath: string, baseBytes: () => Uint8Array | null): Uint8Array | null {
        const gen = this.generated.get(gamePath.toLowerCase());
        if (gen) return gen;
        const list = this.edits.get(gamePath.toLowerCase());
        if (!list) return null;
        const sig = list.map(e => `${e.mod.id}:${e.mod.tree.stamp}:${e.edit.source}`).join('|');
        const hit = this.cache.get(gamePath.toLowerCase());
        if (hit?.sig === sig) return hit.bytes;

        const target = formatOfGamePath(gamePath);
        let base: Uint8Array | null | undefined; // undefined = not loaded yet
        const loadBase = () => (base === undefined ? (base = baseBytes()) : base);
        let plain: Uint8Array | null = null; // null = "still the original"
        let final = false;                    // `plain` is already in the game's on-disk form (a raw edit)
        let value: unknown; let haveValue = false;

        /** the file's current content as plain bytes */
        const currentBytes = (): Uint8Array => {
            if (plain) return plain;
            const b = loadBase();
            if (!b) throw new PatchError(`game file ${gamePath} does not exist, so it cannot be patched`);
            return target.crypt === 'aes' ? this.decrypt(b) : b;
        };
        const asValue = (): unknown => {
            if (haveValue) return value;
            if (final) throw new PatchError('cannot patch content that a mod supplied already encrypted');
            if (target.crypt === 'rpg') throw new PatchError('images and audio can only be replaced, not patched like data (image deltas are handled separately)');
            const bytes = currentBytes();
            value = target.fmt === 'yaml' ? yaml.safeLoad(dec.decode(bytes)) : JSON.parse(dec.decode(bytes).replace(BOM, ''));
            haveValue = true;
            return value;
        };
        const flush = () => { // serialise the working value back into `plain`
            if (haveValue) plain = enc.encode(target.fmt === 'yaml' ? yaml.safeDump(value, { lineWidth: -1 }) : JSON.stringify(value));
            haveValue = false;
        };
        const textOp = (fn: (current: string) => string) => {
            if (final) throw new PatchError('cannot patch content that a mod supplied already encrypted');
            flush();
            plain = enc.encode(fn(dec.decode(currentBytes())));
        };

        let applied = 0;
        for (const { mod, edit } of list) {
            try {
                const src = mod.tree.read(edit.source);
                switch (edit.kind) {
                    case 'replace': {
                        if (target.fmt === 'json') JSON.parse(dec.decode(src).replace(BOM, ''));
                        else if (target.fmt === 'yaml') yaml.safeLoad(dec.decode(src));
                        plain = src; haveValue = false; final = false; break;
                    }
                    case 'raw': plain = src; haveValue = false; final = true; break;
                    case 'jsonpatch': value = applyJsonPatch(asValue(), JSON.parse(dec.decode(src).replace(BOM, ''))); haveValue = true; break;
                    case 'merge': value = applyMergePatch(asValue(), JSON.parse(dec.decode(src).replace(BOM, ''))); haveValue = true; break;
                    case 'text': textOp(cur => applyTextPatch(cur, JSON.parse(dec.decode(src)))); break;
                    case 'append': textOp(cur => `${cur}\n${dec.decode(src)}\n`); break; // OneLoader's plugin delta: add the mod's text to the end
                }
                applied++;
            } catch (e) {
                const msg = e instanceof SyntaxError ? `invalid JSON/YAML in ${edit.source}: ${e.message}` : (e as Error).message;
                this.log('error', `${edit.kind} of ${gamePath} failed and was skipped: ${msg}`, { mod: mod.id, file: edit.source });
            }
        }
        flush();
        if (applied === 0 && plain === null) return null; // every edit failed: fall back to the original file
        let out = plain ?? new Uint8Array();
        if (!final) {
            if (target.crypt === 'aes') out = this.encrypt(out);
            else if (target.crypt === 'rpg') out = this.encryptAsset(out);
        }
        this.cache.set(gamePath.toLowerCase(), { sig, bytes: out });
        return out;
    }

    /** True when any active edit needs the original file (patches), as opposed to pure replacements. */
    needsBase(gamePath: string) { return !!this.edits.get(gamePath.toLowerCase())?.some(e => e.edit.kind !== 'replace' && e.edit.kind !== 'raw'); }

    /** Does any active mod touch a file the page can't serve itself (images, audio, plain scripts)? */
    hasAssetEdits() { for (const k of this.edits.keys()) if (!this.isEncrypted(k)) return true; return this.generated.size > 0; }

    /** True when `gamePath` is stored under the game's AES key, i.e. only code with that key (the page) can serve edits to it. */
    isEncrypted(gamePath: string) { return formatOfGamePath(gamePath).encrypted; }

    // ------------------------------------------------------------ crypto: game data (16-byte IV + AES-256-CTR)
    private cipher(iv: Uint8Array) {
        const k = this.getKey();
        if (!k) throw new Error('game key unavailable (check OMORI_DIR / Launch_OMORI.bat)');
        return new aesjs.ModeOfOperation.ctr(enc.encode(k), new aesjs.Counter(iv));
    }

    decrypt(buf: Uint8Array): Uint8Array {
        if (buf.length < 16) return new Uint8Array();
        return new Uint8Array(this.cipher(buf.slice(0, 16)).decrypt(buf.slice(16)));
    }

    encrypt(plain: Uint8Array): Uint8Array {
        const iv = crypto.getRandomValues(new Uint8Array(16)); // results are cached per file, so a fresh IV each time is fine
        const out = new Uint8Array(16 + plain.length);
        out.set(iv); out.set(this.cipher(iv).encrypt(plain), 16);
        return out;
    }

    // ------------------------------------------------------------ crypto: images and audio (RPG Maker header + XOR of the first 16 bytes)
    private rpgKey(): Uint8Array {
        if (!this.assetKey || !this.assetKey.length) throw new Error('asset key unavailable, so replaced images/audio cannot be encoded');
        return this.assetKey;
    }

    encryptAsset(plain: Uint8Array): Uint8Array {
        const key = this.rpgKey();
        const out = new Uint8Array(RPG_HEADER.length + plain.length);
        out.set(RPG_HEADER); out.set(plain, RPG_HEADER.length);
        for (let i = 0; i < 16 && i < plain.length; i++) out[RPG_HEADER.length + i] = plain[i]! ^ key[i % key.length]!;
        return out;
    }

    decryptAsset(enc16: Uint8Array): Uint8Array {
        const key = this.rpgKey();
        const out = enc16.slice(16);
        for (let i = 0; i < 16 && i < out.length; i++) out[i] = out[i]! ^ key[i % key.length]!;
        return out;
    }
}
