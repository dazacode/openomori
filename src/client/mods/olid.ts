// Image deltas (.olid): small patch files that change parts of a game image, used by sprite and portrait fix mods.
// The format is OneLoader's: a header (magic, size, per-patch salt) and a zlib-compressed stream of 16x16 pixel tiles,
// each decoded by a small WebAssembly routine. That routine ships inside OneLoader packs, so we use the player's own
// copy (kept in the library when a pack is imported) instead of bundling it.
//
// Patched images are cached by what went in, so a pack with ~130 patched images is only processed once.
import { unzipSync, unzlibSync } from 'fflate';
import type { LoadedMod, ModEngine } from '../../mods/engine.ts';
import { report } from './api.ts';
import { cacheGet, cachePut, getSupport } from './store.ts';

interface BitDiff { tile_size(): number; apply_diff(source: Uint32Array, bitstream: Uint8Array): Uint32Array }

let decoder: Promise<BitDiff | null> | null = null;

/** Loads the decoder from the saved pack files; null when no pack with it has been imported. */
function loadDecoder(): Promise<BitDiff | null> {
    return (decoder ??= (async () => {
        const zip = await getSupport('imagediff2');
        if (!zip) return null;
        const files = unzipSync(zip);
        const js = files['imagediff2.js'], wasm = files['imagediff2_bg.wasm'];
        if (!js || !wasm) return null;
        const init = new Function(`${new TextDecoder().decode(js)}\nreturn wasm_bindgen;`)() as ((w: BufferSource) => Promise<unknown>) & BitDiff;
        await init(wasm);
        return init;
    })());
}

const hex = (b: Uint8Array) => Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
async function sha256(b: Uint8Array | string): Promise<string> {
    const data = typeof b === 'string' ? new TextEncoder().encode(b) : b;
    return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', data as BufferSource)));
}

interface Delta { salt: string; stream: Uint8Array; width: number; height: number; mod: string }

function parseOlid(bytes: Uint8Array, mod: string): Delta | null {
    if (bytes.length < 26) return null;
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    // OneLoader only rejects a file when BOTH checks fail; same here so odd-but-working files still load
    if (dv.getUint32(0) !== 0xfeffd808 && dv.getUint32(4) !== 0xdd21) return null;
    return { salt: hex(bytes.slice(14, 22)), stream: bytes.slice(26), width: dv.getUint32(6), height: dv.getUint32(10), mod };
}

async function toCanvas(png: Uint8Array): Promise<{ bitmap: ImageBitmap }> {
    return { bitmap: await createImageBitmap(new Blob([png as BlobPart], { type: 'image/png' })) };
}

async function patchImage(dec: BitDiff, basePng: Uint8Array, deltas: Delta[]): Promise<Uint8Array> {
    const e = dec.tile_size();
    const targetW = Math.max(...deltas.map(d => d.width)), targetH = Math.max(...deltas.map(d => d.height));
    const { bitmap } = await toCanvas(basePng);
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(targetW / 16) * 16; canvas.height = Math.ceil(targetH / 16) * 16;
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(bitmap, 0, 0);

    for (const delta of deltas) {
        const bits = unzlibSync(delta.stream);
        const dv = new DataView(bits.buffer, bits.byteOffset, bits.byteLength);
        for (let p = 0; p < bits.byteLength;) {
            const tx = dv.getUint16(p), ty = dv.getUint16(p + 2), len = dv.getUint32(p + 4);
            p += 8;
            const tile = bits.slice(p, p + len); p += len;
            const src = bitmap.width < tx * e || bitmap.height < ty * e ? new ArrayBuffer(e * e * 4) : ctx.getImageData(tx * e, ty * e, e, e).data.buffer;
            const out = dec.apply_diff(new Uint32Array(src), tile);
            const pixels = new Uint8ClampedArray(new ArrayBuffer(e * e * 4));
            pixels.set(new Uint8Array(out.buffer, out.byteOffset, e * e * 4)); // copy out of wasm memory
            ctx.putImageData(new ImageData(pixels, e, e), tx * e, ty * e);
        }
    }
    let final = canvas;
    if (canvas.width !== targetW || canvas.height !== targetH) {
        final = document.createElement('canvas'); final.width = targetW; final.height = targetH;
        final.getContext('2d')!.drawImage(canvas, 0, 0);
    }
    const blob = await new Promise<Blob>((res, rej) => final.toBlob(b => (b ? res(b) : rej(new Error('PNG encode failed'))), 'image/png'));
    bitmap.close();
    return new Uint8Array(await blob.arrayBuffer());
}

export interface OlidResult { applied: number; failed: number; missingDecoder: boolean; generated: Record<string, Uint8Array> }

/**
 * Apply every active mod's image deltas. Results are registered on the engine (so the page and the service worker can serve
 * them) and returned for persistence. Never throws: a bad delta is reported against its mod and that image stays as it was.
 */
export async function applyImageDeltas(engine: ModEngine, onProgress?: (done: number, total: number, name: string) => void): Promise<OlidResult> {
    const result: OlidResult = { applied: 0, failed: 0, missingDecoder: false, generated: {} };
    const jobs = new Map<string, { target: string; items: { mod: LoadedMod; source: string }[] }>();
    for (const m of engine.activeMods()) {
        for (const d of m.imageDeltas) {
            const k = d.target.toLowerCase();
            (jobs.get(k) ?? jobs.set(k, { target: d.target, items: [] }).get(k)!).items.push({ mod: m, source: d.source });
        }
    }
    if (!jobs.size) return result;

    const dec = await loadDecoder().catch(e => { report('(image patches)', e, 'could not start the image decoder'); return null; });
    if (!dec) {
        result.missingDecoder = true;
        report('(image patches)', new Error(`${jobs.size} image patch(es) from ${[...new Set([...jobs.values()].flatMap(j => j.items.map(i => i.mod.id)))].join(', ')} were skipped: the image decoder is missing. Import the full OneLoader/OMO-CEP pack once and it is kept for later.`), '', 'warn');
        return result;
    }

    let done = 0;
    for (const { target, items } of jobs.values()) {
        onProgress?.(done++, jobs.size, target);
        try {
            const deltas: Delta[] = [];
            for (const it of items) {
                const d = parseOlid(it.mod.tree.read(it.source), it.mod.id);
                if (d) deltas.push(d); else report(it.mod.id, new Error(`${it.source} is not a valid image delta`), '', 'warn');
            }
            if (!deltas.length) continue;
            deltas.sort((a, b) => (a.salt > b.salt ? 1 : -1)); // OneLoader applies in salt order

            const rpg = target.replace(/\.png$/i, '.rpgmvp');
            // the base is whatever the image is by now: a mod's replacement if there is one, otherwise the game's own file
            let encBase = engine.hasEdits(rpg) ? engine.resolve(rpg, () => null) : null;
            if (!encBase) {
                const r = await fetch(`/${rpg.split('/').map(encodeURIComponent).join('/')}?__vanilla=1`, { cache: 'no-store' });
                if (!r.ok) throw new Error(`the game has no ${rpg}`);
                encBase = new Uint8Array(await r.arrayBuffer());
            }
            const basePng = engine.decryptAsset(encBase);
            const key = await sha256(`${target}+${await sha256(basePng)}:${deltas.map(d => d.salt).join(':')}`);
            let png = await cacheGet(key);
            if (!png) { png = await patchImage(dec, basePng, deltas); void cachePut(key, png); }
            const finished = engine.encryptAsset(png);
            engine.setGenerated(rpg, finished);
            result.generated[rpg] = finished;
            result.applied++;
        } catch (e) {
            result.failed++;
            report(items[0]!.mod.id, e, `image patch for ${target}`);
        }
    }
    onProgress?.(jobs.size, jobs.size, '');
    return result;
}
