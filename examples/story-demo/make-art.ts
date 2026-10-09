// Generates the demo's own art (so the example contains nothing from the game):
//   files/img/tilesets/DEMO_TILES.png    64x64: four solid 32x32 tiles (red, green, blue, yellow)
//   files/img/characters/DEMO_NPC.png    96x128: a 3x4 character sheet (3 walk frames x 4 directions) of a little blob
// Run: bun run examples/story-demo/make-art.ts
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

type RGBA = [number, number, number, number];

function png(w: number, h: number, pixel: (x: number, y: number) => RGBA): Buffer {
    const stride = w * 4 + 1;
    const raw = Buffer.alloc(stride * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const o = y * stride + 1 + x * 4; raw.set(pixel(x, y), o); }
    const table = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
    const crc = (b: Buffer) => { let c = 0xffffffff; for (const x of b) c = table[(c ^ x) & 255]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
    const chunk = (type: string, data: Buffer) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
    const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
    return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const out = (rel: string, data: Buffer) => { const p = join(import.meta.dir, rel); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, data); console.log('wrote', rel, data.length, 'bytes'); };

const tiles: RGBA[] = [[220, 30, 30, 255], [30, 200, 60, 255], [40, 80, 230, 255], [240, 220, 40, 255]];
out('files/img/tilesets/DEMO_TILES.png', png(64, 64, (x, y) => tiles[(y >> 5) * 2 + (x >> 5)]!));

// 3 columns (frames) x 4 rows (down, left, right, up); each cell 32x32. A body, two eyes (not on the "up" row), and a bobbing foot.
const BODY: RGBA = [255, 170, 60, 255], EYE: RGBA = [30, 30, 30, 255], CLEAR: RGBA = [0, 0, 0, 0];
out('files/img/characters/DEMO_NPC.png', png(96, 128, (x, y) => {
    const col = x >> 5, row = y >> 5, cx = (x & 31) - 16, cy = (y & 31) - 14 + (col === 1 ? 0 : 1);
    if (cx * cx + cy * cy * 1.4 > 100) return CLEAR;
    const eyeX = row === 1 ? [-6, -2] : row === 2 ? [2, 6] : [-5, 5];
    if (row !== 3 && cy >= -3 && cy <= 0 && eyeX.some(e => Math.abs(cx - e) <= 1)) return EYE;
    return BODY;
}));
