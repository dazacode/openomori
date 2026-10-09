// Reads any common archive a player might download a mod as: zip, 7z, rar (v4 and v5), tar, tar.gz/.tgz, tar.bz2, tar.xz.
// Zip is handled in-process (fast, no download). Everything else goes through libarchive compiled to WebAssembly,
// loaded on demand from /vendor/libarchive/ (see build.ts), so players who only use zips never pay for it.
import { unzipSync } from 'fflate';
import { Archive } from 'libarchive.js';

export { sniff } from '../../mods/sniff.ts';
import { sniff } from '../../mods/sniff.ts';

export const ARCHIVE_ACCEPT = '.zip,.7z,.rar,.tar,.gz,.tgz,.bz2,.tbz2,.xz,.txz,.mod,.omm,application/zip,application/x-7z-compressed,application/vnd.rar,application/x-rar-compressed,application/x-tar,application/gzip';

let ready = false;
function init() {
    if (ready) return;
    ready = true;
    Archive.init({ workerUrl: '/vendor/libarchive/worker-bundle.js' }); // the wasm file sits next to the worker
}

export class ArchiveError extends Error {}

type Nested = { [name: string]: File | Nested };

function flatten(tree: Nested, prefix = '', out: [string, File][] = []): [string, File][] {
    for (const [name, v] of Object.entries(tree)) {
        if (v instanceof Blob) out.push([prefix + name, v as File]);
        else flatten(v, `${prefix}${name}/`, out);
    }
    return out;
}

export interface ReadOptions {
    /** called with "what we're doing" for long extractions */
    onProgress?(message: string): void;
    /** asked when the archive is password protected; return null to give up */
    askPassword?(): string | null;
}

/** All files in the archive as path -> bytes. Throws ArchiveError with a message fit to show the user. */
export async function readArchive(file: File, opts: ReadOptions = {}): Promise<Record<string, Uint8Array>> {
    const head = new Uint8Array(await file.slice(0, 600).arrayBuffer());
    const fmt = sniff(head);
    if (fmt === 'unknown') throw new ArchiveError(`${file.name}: not a recognised archive (supported: zip, 7z, rar, tar, tar.gz, tar.bz2, tar.xz)`);

    if (fmt === 'zip') {
        try { return unzipSync(new Uint8Array(await file.arrayBuffer())); }
        catch (e) { throw new ArchiveError(`${file.name}: damaged or unsupported zip (${(e as Error).message})`); }
    }

    opts.onProgress?.(`Unpacking ${file.name} (${fmt})…`);
    init();
    let archive;
    try { archive = await Archive.open(file); }
    catch (e) { throw new ArchiveError(`${file.name}: could not open this ${fmt} archive (${(e as Error).message ?? e})`); }
    try {
        if ((await archive.hasEncryptedData()) === true) {
            const pw = opts.askPassword?.() ?? null;
            if (pw === null) throw new ArchiveError(`${file.name} is password protected`);
            await archive.usePassword(pw);
        }
        let tree: Nested;
        try { tree = (await archive.extractFiles()) as Nested; }
        catch (e) { throw new ArchiveError(`${file.name}: extraction failed (${(e as Error).message ?? e}). A wrong password or a damaged archive are the usual causes.`); }
        const out: Record<string, Uint8Array> = {};
        for (const [path, f] of flatten(tree)) out[path] = new Uint8Array(await f.arrayBuffer());
        if (!Object.keys(out).length) throw new ArchiveError(`${file.name} is empty`);
        return out;
    } finally {
        await (archive as unknown as { close?(): Promise<void> }).close?.().catch(() => {});
    }
}
