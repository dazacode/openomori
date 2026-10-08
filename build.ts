export {};
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
