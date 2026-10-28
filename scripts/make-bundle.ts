// Makes a self-contained, server-less copy of OpenOMORI plus your own OMORI install: `bun run bundle`.
//
// The result is a plain folder (and a .zip) with the client, the game's files and a baked `omori-bundle.json`, so it
// runs on any static host - an app store, a school web server, a USB stick. It is the same game, just without the Bun
// dev server: the manifest carries the game key and every directory listing (see src/client/staticBundle.ts).
//
// Your install is never changed; the game's files are copied as they are (they stay encrypted, exactly as the Steam
// build ships them). Mods from ./mods are packed in as zips (the dev-folder mods), minus anything excluded.
//
//   bun run bundle                       -> ./bundle and ./bundle.zip
//   bun run bundle --out=/tmp/omori-web  -> somewhere else
//   bun run bundle --exclude-mods=sunburn,other
//   bun run bundle --no-zip --no-build   -> folder only, reuse the last client build
import { readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { cp, mkdir } from 'node:fs/promises';
import { join, posix, resolve } from 'node:path';
import { GAME_DIR, ROOT, WWW, ensureGameDir, readGameKey } from '../src/gamedir.ts';
import { storyIndex } from '../src/mods/mapkit-node.ts';
import { treeToZip } from '../src/mods/vfs.ts';
import { discoverMods } from '../src/mods/vfs-node.ts';

const arg = (name: string): string | undefined => process.argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const flag = (name: string) => process.argv.includes(`--${name}`);
const exists = (p: string) => !!statSync(p, { throwIfNoEntry: false });

if (!ensureGameDir()) process.exit(1);

const out = resolve(arg('out') ?? join(ROOT, 'bundle'));
const zipPath = `${out}.zip`;
const excluded = new Set((arg('exclude-mods') ?? 'sunburn').split(',').map(s => s.trim()).filter(Boolean));
const MODS_DIR = resolve(process.env.OMORI_MODS ?? join(ROOT, 'mods'));

/** `rm -rf` through the system command: Bun's own async rm resolves before the tree is gone and races the copy. */
const rmrf = (p: string) => { if (statSync(p, { throwIfNoEntry: false })) rmSync(p, { recursive: true, force: true }); };

const key = readGameKey();
if (!key) process.exit(1);

const mb = (n: number) => `${(n / 1048576).toFixed(1)} MB`;

type Entry = [full: string, rel: string, isDir: boolean];
function walk(dir: string, prefix: string, visit: (e: Entry) => void) {
    for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        const rel = prefix ? `${prefix}/${name}` : name;
        const isDir = statSync(full).isDirectory();
        visit([full, rel, isDir]);
        if (isDir) walk(full, rel, visit);
    }
}
const collect = (): Entry[] => { const a: Entry[] = []; walk(out, '', e => a.push(e)); return a; };

// 1. the client (src -> dist/app.js): build first, so the bundle matches the source it was made from
if (!flag('no-build')) {
    console.log('building the client...');
    const p = Bun.spawnSync(['bun', 'run', 'build.ts'], { cwd: ROOT, stdio: ['inherit', 'inherit', 'inherit'] });
    if (p.exitCode !== 0) process.exit(p.exitCode ?? 1);
}
for (const need of ['dist/app.js', 'dist/sw.js', 'public/index.html']) if (!exists(join(ROOT, need))) {
    console.error(`missing ${need} - run "bun run build" first (or drop --no-build).`);
    process.exit(1);
}

// 2. the game, the client, then the mods
console.log(`copying ${GAME_DIR} (~1.7 GB, this takes a minute)...`);
rmrf(out);
mkdir(out, { recursive: true });
// rsync: dereference (-L), keep everything, skip dotfiles (the dev server's own zip skips them too)
const r = Bun.spawnSync(['rsync', '-aL', '--exclude', '.*', `${WWW}/`, `${out}/`], { stdio: ['inherit', 'inherit', 'inherit'] });
if (r.exitCode !== 0) { console.error('could not copy the game files (is `rsync` installed?)'); process.exit(1); }
await cp(join(ROOT, 'dist', 'app.js'), join(out, 'app.js'));
if (exists(join(ROOT, 'dist', 'app.js.map'))) await cp(join(ROOT, 'dist', 'app.js.map'), join(out, 'app.js.map'));
await cp(join(ROOT, 'dist', 'sw.js'), join(out, 'sw.js'));
await cp(join(ROOT, 'dist', 'vendor'), join(out, 'vendor'), { recursive: true });
await cp(join(ROOT, 'public', 'index.html'), join(out, 'index.html'));   // last: the game ships one too

const mods: { label: string; stamp: string }[] = [];
const found = discoverMods(MODS_DIR, (n, e) => console.warn(`skipping mod "${n}": ${e.message}`));
if (found.length) mkdir(join(out, 'mods'), { recursive: true });
for (const m of found) {
    if (excluded.has(m.label)) { console.log(`  mod ${m.label}: excluded`); continue; }
    writeFileSync(join(out, 'mods', `${m.label}.zip`), treeToZip(m.tree));
    mods.push({ label: m.label, stamp: m.tree.stamp });
    console.log(`  mod ${m.label}: packed`);
}
for (const label of excluded) if (!found.some(m => m.label === label)) console.log(`  mod ${label}: not found (nothing to exclude)`);

// 3. drop dotfiles and Finder/Windows litter: the dev server's own zip skips them, and a static host would serve them
const junk = (rel: string) => rel.split('/').some(s => s.startsWith('.')) || /(^|\/)__MACOSX(\/|$)/.test(rel);
for (const [full, rel] of collect()) if (junk(rel)) rmrf(full);

// 4. the manifest: the key, and every directory's listing (what /__config and /__ls answered in dev)
const dirs: Record<string, string[]> = { '': [] };
for (const [, rel, isDir] of collect()) {
    const parent = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
    if (isDir) dirs[rel] ??= [];
    (dirs[parent] ??= []).push(posix.basename(rel));
}
dirs['']!.push(posix.basename(join(out, 'omori-bundle.json')));   // written below, so list it by hand
writeFileSync(join(out, 'omori-bundle.json'), JSON.stringify({ key, dirs, mods, story: storyIndex(), built: new Date().toISOString() }));
console.log('wrote omori-bundle.json');

// 5. a .zip next to it, ready to upload (the whole point of the exercise)
const files = collect().filter(([, , isDir]) => !isDir);
const bytes = files.reduce((n, [full]) => n + statSync(full).size, 0);
if (!flag('no-zip')) {
    console.log(`zipping ${files.length} files...`);
    rmrf(zipPath);
    const z = Bun.spawnSync(['zip', '-r', '-q', '-X', '-1', zipPath, '.'], { cwd: out });
    if (z.exitCode !== 0) { console.error('zip failed (is the `zip` command installed?)'); process.exit(1); }
    console.log(`wrote ${zipPath} (${mb(statSync(zipPath).size)})`);
}

console.log(`\nbundle: ${out}`);
console.log(`  ${files.length} files, ${mb(bytes)} unpacked${mods.length ? `, mods: ${mods.map(m => m.label).join(', ')}` : ''}`);
console.log(`  run it with any static server, e.g.  cd ${out} && bunx serve`);
console.log(`  publish it with  bun run shasta publish ${flag('no-zip') ? out : zipPath} --name "OMORI" ...`);
