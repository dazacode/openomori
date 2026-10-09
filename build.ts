export {};
import { copyFileSync, mkdirSync } from 'node:fs';
// Bundles the browser client (shim + display layer + loader) into dist/app.js.
const result = await Bun.build({
    entrypoints: ['src/client/entry.ts'],
    outdir: 'dist',
    naming: 'app.js',
    target: 'browser',
    format: 'esm',
    minify: !process.argv.includes('--dev'),
    sourcemap: 'linked',
});
if (!result.success) {
    for (const log of result.logs) console.error(log);
    process.exit(1);
}
console.log(`built dist/app.js (${(result.outputs[0]!.size / 1024).toFixed(0)} KB)`);

// The service worker that serves mod-replaced images/audio/fonts. A classic script, so IIFE not ESM.
const sw = await Bun.build({
    entrypoints: ['src/sw.ts'],
    outdir: 'dist',
    naming: 'sw.js',
    target: 'browser',
    format: 'iife',
    minify: !process.argv.includes('--dev'),
});
if (!sw.success) {
    for (const log of sw.logs) console.error(log);
    process.exit(1);
}
console.log(`built dist/sw.js (${(sw.outputs[0]!.size / 1024).toFixed(0)} KB)`);

// The archive reader for .7z / .rar / .tar.* mods: libarchive compiled to WebAssembly, loaded on demand by the page.
mkdirSync('dist/vendor/libarchive', { recursive: true });
for (const f of ['worker-bundle.js', 'libarchive.wasm']) copyFileSync(`node_modules/libarchive.js/dist/${f}`, `dist/vendor/libarchive/${f}`);
console.log('copied libarchive worker + wasm to dist/vendor/libarchive');
