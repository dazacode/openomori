// Just enough of node:crypto for the game: createDecipheriv('aes-256-ctr', key, iv).
// Must be synchronous (the game decrypts inline), hence pure-JS AES via aes-js.
import aesjs from 'aes-js';
import { Buffer } from 'buffer';

export const crypto = {
    createDecipheriv(algorithm: string, key: string | Uint8Array, iv: Uint8Array) {
        if (algorithm !== 'aes-256-ctr') throw new Error(`unsupported cipher ${algorithm}`);
        const keyBytes = typeof key === 'string' ? new TextEncoder().encode(key) : new Uint8Array(key);
        const ctr = new aesjs.ModeOfOperation.ctr(keyBytes, new aesjs.Counter(new Uint8Array(iv)));
        return {
            update: (data: Uint8Array) => Buffer.from(ctr.decrypt(new Uint8Array(data))),
            final: () => Buffer.alloc(0),
        };
    },
};
