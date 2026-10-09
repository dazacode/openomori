// Identify an archive by its first bytes: file extensions lie (renamed files, a ".zip" that is really a 7z).
export type ArchiveFormat = 'zip' | '7z' | 'rar' | 'tar' | 'gzip' | 'bzip2' | 'xz' | 'unknown';

export function sniff(b: Uint8Array): ArchiveFormat {
    const at = (o: number, ...sig: number[]) => sig.every((v, i) => b[o + i] === v);
    if (at(0, 0x50, 0x4b, 0x03, 0x04) || at(0, 0x50, 0x4b, 0x05, 0x06)) return 'zip';
    if (at(0, 0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c)) return '7z';
    if (at(0, 0x52, 0x61, 0x72, 0x21, 0x1a, 0x07)) return 'rar'; // v4 "Rar!\x1a\x07\x00" and v5 "...\x01\x00"
    if (at(0, 0x1f, 0x8b)) return 'gzip';
    if (at(0, 0x42, 0x5a, 0x68)) return 'bzip2';
    if (at(0, 0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00)) return 'xz';
    if (at(257, 0x75, 0x73, 0x74, 0x61, 0x72)) return 'tar'; // "ustar"
    return 'unknown';
}
