// OneLoader / GOMORI compatibility, written against what OneLoader's own loader does (not against assumptions).
import { describe, expect, test } from 'bun:test';
import { ModEngine, assetKeyFromSystem } from './engine.ts';
import { loadMod } from './manifest.ts';
import { memTree } from './vfs.ts';

const te = new TextEncoder(), td = new TextDecoder();
const tree = (files: Record<string, string | Uint8Array>) => memTree(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, typeof v === 'string' ? te.encode(v) : v])));
const ol = (manifest: object, files: Record<string, string> = {}) =>
    loadMod(tree({ 'mod.json': JSON.stringify({ id: 'ol', name: 'OL', description: '', version: '1', ...manifest }), ...files }), 'x');

describe('oneloader manifest', () => {
    test('a missing manifestVersion means 1, and entries are paths from the mod root', () => {
        const m = ol({ files: { data: ['data/A.json', 'B.json'], maps: ['maps/'] } }, { 'data/A.json': '[]', 'B.json': '[]', 'maps/map1.json': '{}', 'maps/sub/map2.json': '{}' });
        expect(m.errors).toEqual([]);
        expect(m.format).toBe('oneloader');
        // B.json is a bare entry: it sits at the mod root and is injected under the section's mount point
        expect(m.edits.map(e => `${e.kind}:${e.target}<-${e.source}`).sort()).toEqual(['replace:data/A.KEL<-data/A.json', 'replace:data/B.KEL<-B.json', 'replace:maps/map1.AUBREY<-maps/map1.json']);
    });

    test('the file extension decides delta vs full, whatever section lists the file', () => {
        const m = ol({ files: { data: ['d/Items.jsond', 'd/Full.json'], data_delta: ['d/Other.jsond'], text_delta: ['t/line.ymld'], data_pluto: ['d/q.yml'], plugins: ['p/Append.jsd'] } },
            { 'd/Items.jsond': '[]', 'd/Full.json': '{}', 'd/Other.jsond': '[]', 't/line.ymld': '[]', 'd/q.yml': 'a: 1', 'p/Append.jsd': 'x' });
        expect(m.edits.map(e => `${e.kind}:${e.target}`).sort()).toEqual([
            'append:js/plugins/Append.OMORI', 'jsonpatch:data/Items.KEL', 'jsonpatch:data/Other.KEL', 'jsonpatch:languages/en/line.HERO', 'replace:data/Full.KEL', 'replace:data/q.PLUTO']);
    });

    test('pre-encrypted file types pass through unchanged', () => {
        expect(ol({ files: { data: ['x.kel'] } }, { 'x.kel': 'bytes' }).edits).toEqual([{ target: 'data/x.KEL', kind: 'raw', source: 'x.kel' }]);
    });

    test('assets turn PNG/OGG into the encrypted names the game uses; raw does not', () => {
        const m = ol({ files: { assets: ['img/pictures/', 'audio/bgm/song.ogg', 'movies/a.webm', 'img/system/window.png'], raw: ['misc/x.txt'] } },
            { 'img/pictures/a.png': '', 'img/pictures/b.png': '', 'audio/bgm/song.ogg': '', 'movies/a.webm': '', 'img/system/window.png': '', 'misc/x.txt': '' });
        expect(m.edits.map(e => `${e.kind}:${e.target}`).sort()).toEqual([
            'raw:misc/x.txt', 'replace:audio/bgm/song.rpgmvo', 'replace:img/pictures/a.rpgmvp', 'replace:img/pictures/b.rpgmvp', 'replace:img/system/window.png', 'replace:movies/a.webm']);
    });

    test('a listed file that is missing is a warning, not a failure', () => {
        const m = ol({ files: { data: ['Nope.json'] } });
        expect(m.errors).toEqual([]);
        expect(m.warnings.join()).toContain('Nope.json');
    });

    test('asyncExec is top-level, runat maps to boot stages, _require means a module', () => {
        const m = ol({ files: {}, asyncExec: [{ file: 'a.js', runat: 'pre_plugin_injection' }, { file: 'b.js', runat: 'post_stage_2' }, { file: 'c.js', runat: 'pre_game_start_require' }] }, { 'a.js': '', 'b.js': '', 'c.js': '' });
        expect(m.scripts.map(s => `${s.file}:${s.phase}:${s.style}`)).toEqual(['a.js:pre-plugins:eval', 'b.js:early:eval', 'c.js:early:require']);
    });

    test('exec mods are refused; unknown sections warn; flags, priority and plugin lists are read', () => {
        expect(ol({ files: {}, exec: ['x.js'] }).errors.join()).toContain('exec');
        const m = ol({ priority: '5', _flags: ['do_olid', 'prevent_disable'], requires: ['other'], files: { weird: ['x'], plugins: ['new.js'] },
            plugin_parameters: { YEP_CoreEngine: [{ op: 'replace', path: '/a', value: 1 }] }, plugins_ordered: { New: { after: 'YEP_CoreEngine', weight: 2 } } }, { 'new.js': '' });
        expect(m.priority).toBe(5);
        expect(m.flags).toEqual(['do_olid', 'prevent_disable']);
        expect(m.warnings.join()).toContain('weird');
        expect(m.pluginFiles).toEqual(['new']);
        expect(m.pluginOrder.new).toEqual({ after: 'YEP_CoreEngine', weight: 2 });
        expect(Object.keys(m.pluginParameters)).toEqual(['YEP_CoreEngine']);
    });

    test('image deltas: single file and directory form', () => {
        const m = ol({ _flags: ['do_olid'], image_deltas: [{ patch: 'img/a.png', with: 'olid/a.olid' }, { patch: 'img/folder/', with: 'olid/folder/', dir: true }] }, { 'olid/a.olid': '', 'olid/folder/x.olid': '', 'olid/folder/y.olid': '' });
        expect(m.imageDeltas).toEqual([{ target: 'img/a.png', source: 'olid/a.olid' }, { target: 'img/folder/x.png', source: 'olid/folder/x.olid' }, { target: 'img/folder/y.png', source: 'olid/folder/y.olid' }]);
    });
});

describe('oneloader behaviour in the engine', () => {
    const key = '0123456789abcdef0123456789abcdef';
    const mod = (id: string, manifest: object, files: Record<string, string | Uint8Array>) => ({ label: id, tree: tree({ 'mod.json': JSON.stringify({ id, name: id, description: '', version: '1', ...manifest }), ...files }) });

    test('RPG Maker asset encryption: header plus an XOR of the first 16 bytes, reversible', () => {
        const e = new ModEngine(() => key);
        e.assetKey = assetKeyFromSystem({ encryptionKey: '00112233445566778899aabbccddeeff' });
        expect(e.assetKey.length).toBe(16);
        const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...Array.from({ length: 40 }, (_, i) => i)]);
        const enc = e.encryptAsset(png);
        expect(td.decode(enc.slice(0, 5))).toBe('RPGMV');
        expect(enc.length).toBe(png.length + 16);
        expect(Array.from(enc.slice(16, 20))).toEqual([0x89 ^ 0x00, 0x50 ^ 0x11, 0x4e ^ 0x22, 0x47 ^ 0x33]);
        expect(Array.from(enc.slice(32))).toEqual(Array.from(png.slice(16))); // beyond byte 16 the data is untouched
        expect(Array.from(e.decryptAsset(enc))).toEqual(Array.from(png));
    });

    test('a replaced PNG is served under the .rpgmvp name, encoded', () => {
        const e = new ModEngine(() => key);
        e.assetKey = new Uint8Array(16).fill(0xaa);
        e.load([mod('a', { files: { assets: ['img/pictures/'] } }, { 'img/pictures/x.png': 'PNGDATA-PNGDATA-PNGDATA' })]);
        expect(e.hasEdits('img/pictures/X.rpgmvp')).toBe(true);
        expect(e.isEncrypted('img/pictures/x.rpgmvp')).toBe(false); // served by the service worker, not the page
        const out = e.resolve('img/pictures/x.rpgmvp', () => null)!;
        expect(td.decode(e.decryptAsset(out))).toBe('PNGDATA-PNGDATA-PNGDATA');
    });

    test('deltas apply in priority order; yaml deltas round-trip; append adds text', () => {
        const e = new ModEngine(() => key);
        const base = e.encrypt(te.encode(JSON.stringify({ a: 1, list: ['x'] })));
        e.load([
            mod('late', { priority: 5, files: { data_delta: ['d.jsond'] } }, { 'd.jsond': JSON.stringify([{ op: 'add', path: '/list/-', value: 'late' }]) }),
            mod('early', { priority: -1, files: { data_delta: ['d.jsond'] } }, { 'd.jsond': JSON.stringify([{ op: 'add', path: '/list/-', value: 'early' }]) }),
        ]);
        expect(e.activeMods().map(m => m.id)).toEqual(['early', 'late']);
        expect(JSON.parse(td.decode(e.decrypt(e.resolve('data/d.KEL', () => base)!)))).toEqual({ a: 1, list: ['x', 'early', 'late'] });

        const y = new ModEngine(() => key);
        const ybase = y.encrypt(te.encode('hello: world\nn: 1\n'));
        y.load([mod('y', { files: { text_delta: ['t.ymld'] } }, { 't.ymld': JSON.stringify([{ op: 'replace', path: '/hello', value: 'there' }]) })]);
        expect(td.decode(y.decrypt(y.resolve('languages/en/t.HERO', () => ybase)!))).toContain('hello: there');

        const p = new ModEngine(() => key);
        const pbase = p.encrypt(te.encode('var a = 1;'));
        p.load([mod('p', { files: { plugins: ['p.jsd'] } }, { 'p.jsd': 'var b = 2;' })]);
        expect(td.decode(p.decrypt(p.resolve('js/plugins/p.OMORI', () => pbase)!))).toBe('var a = 1;\nvar b = 2;\n');
    });

    test('requires disables a mod whose requirement is missing; satisfies and skip_checks count', () => {
        const e = new ModEngine(() => key);
        e.load([
            mod('needs-x', { requires: ['x-mod'], files: {} }, {}),
            mod('needs-y', { requires: ['y-alias'], files: {} }, {}),
            mod('provides-y', { satisfies: ['y-alias'], files: {} }, {}),
            mod('skipper', { skip_checks: { 'needs-x': ['x-mod'] }, files: {} }, {}),
        ]);
        const state = Object.fromEntries(e.mods.map(m => [m.id, m.enabled]));
        expect(state).toEqual({ 'needs-x': true, 'needs-y': true, 'provides-y': true, skipper: true }); // skip_checks waives x-mod
        const f = new ModEngine(() => key);
        f.load([mod('needs-x', { requires: ['x-mod'], files: {} }, {})]);
        expect(f.mods[0]!.enabled).toBe(false);
        expect(f.diagnostics.some(d => /requires "x-mod"/.test(d.message))).toBe(true);
    });

    test('a mod that excludes another only warns, so one clash cannot disable a whole pack', () => {
        const e = new ModEngine(() => key);
        e.load([mod('a', { excludes: ['b'], files: {} }, {}), mod('b', { files: {} }, {})]);
        expect(e.mods.every(m => m.enabled)).toBe(true);
        expect(e.diagnostics.some(d => d.level === 'warn' && /conflicts with "b"/.test(d.message))).toBe(true);
    });
});
