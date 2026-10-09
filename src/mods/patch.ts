// Patch primitives: RFC 6902 JSON Patch, RFC 7386 merge patch, and exact-match text patches.
// Every failure names the operation and path so a mod author (or an agent) can fix it without guessing.

export class PatchError extends Error {}

type Json = unknown;
const isObj = (v: Json): v is Record<string, Json> => typeof v === 'object' && v !== null && !Array.isArray(v);
const clone = <T>(v: T): T => structuredClone(v);

function parsePointer(ptr: string): string[] {
    if (ptr === '') return [];
    if (!ptr.startsWith('/')) throw new PatchError(`invalid JSON pointer "${ptr}" (must start with "/")`);
    return ptr.slice(1).split('/').map(s => s.replace(/~1/g, '/').replace(/~0/g, '~'));
}

function walk(doc: Json, segs: string[], ptr: string): { parent: any; key: string } {
    let cur: any = doc;
    for (let i = 0; i < segs.length - 1; i++) {
        const s = segs[i]!;
        if (cur === null || typeof cur !== 'object' || !(s in cur)) {
            throw new PatchError(`path "${ptr}" does not exist (stopped at "/${segs.slice(0, i + 1).join('/')}")`);
        }
        cur = cur[s];
    }
    return { parent: cur, key: segs[segs.length - 1]! };
}

function get(doc: Json, ptr: string): Json {
    let cur: any = doc;
    for (const s of parsePointer(ptr)) {
        if (cur === null || typeof cur !== 'object' || !(s in cur)) throw new PatchError(`path "${ptr}" does not exist`);
        cur = cur[s];
    }
    return cur;
}

function arrIndex(parent: any[], key: string, ptr: string, allowEnd: boolean): number {
    if (key === '-' && allowEnd) return parent.length;
    if (!/^(0|[1-9]\d*)$/.test(key)) throw new PatchError(`"${key}" is not an array index in "${ptr}"`);
    const i = Number(key);
    if (i > parent.length || (!allowEnd && i === parent.length)) throw new PatchError(`index ${i} out of range (length ${parent.length}) in "${ptr}"`);
    return i;
}

function add(doc: Json, ptr: string, value: Json): Json {
    const segs = parsePointer(ptr);
    if (!segs.length) return value;
    const { parent, key } = walk(doc, segs, ptr);
    if (Array.isArray(parent)) parent.splice(arrIndex(parent, key, ptr, true), 0, value);
    else if (isObj(parent)) parent[key] = value;
    else throw new PatchError(`cannot add into a non-container at "${ptr}"`);
    return doc;
}

function remove(doc: Json, ptr: string): Json {
    const segs = parsePointer(ptr);
    if (!segs.length) throw new PatchError('cannot remove the document root');
    const { parent, key } = walk(doc, segs, ptr);
    if (Array.isArray(parent)) parent.splice(arrIndex(parent, key, ptr, false), 1);
    else if (isObj(parent) && key in parent) delete parent[key];
    else throw new PatchError(`path "${ptr}" does not exist`);
    return doc;
}

const deepEqual = (a: Json, b: Json) => JSON.stringify(a) === JSON.stringify(b);

export interface JsonPatchOp { op: string; path: string; from?: string; value?: Json }

export function applyJsonPatch(doc: Json, ops: JsonPatchOp[]): Json {
    if (!Array.isArray(ops)) throw new PatchError('a JSON patch must be an array of operations');
    let out = clone(doc);
    ops.forEach((o, i) => {
        const where = `op #${i} (${o?.op} ${o?.path})`;
        try {
            if (!o || typeof o.path !== 'string') throw new PatchError('missing "path"');
            switch (o.op) {
                case 'add': out = add(out, o.path, clone(o.value)); break;
                case 'remove': out = remove(out, o.path); break;
                case 'replace': get(out, o.path); out = o.path === '' ? clone(o.value) : (remove(out, o.path), add(out, o.path, clone(o.value))); break;
                case 'move': { const v = get(out, o.from ?? ''); out = remove(out, o.from!); out = add(out, o.path, v); break; }
                case 'copy': out = add(out, o.path, clone(get(out, o.from ?? ''))); break;
                case 'test': if (!deepEqual(get(out, o.path), o.value)) throw new PatchError(`test failed: value at path differs from expected`); break;
                default: throw new PatchError(`unknown op "${o.op}" (use add/remove/replace/move/copy/test)`);
            }
        } catch (e) {
            throw new PatchError(`${where}: ${(e as Error).message}`);
        }
    });
    return out;
}

export function applyMergePatch(doc: Json, patch: Json): Json {
    if (!isObj(patch)) return clone(patch);
    const out: Record<string, Json> = isObj(doc) ? clone(doc) : {};
    for (const [k, v] of Object.entries(patch)) {
        if (v === null) delete out[k];
        else out[k] = applyMergePatch(out[k], v);
    }
    return out;
}

export interface TextPatchOp { find: string; replace: string; all?: boolean; regex?: boolean; flags?: string; optional?: boolean }

/** Exact (or regex) find/replace on source text. A `find` that does not match is an error unless `optional`. */
export function applyTextPatch(text: string, ops: TextPatchOp[]): string {
    if (!Array.isArray(ops)) throw new PatchError('a text patch must be an array of {find, replace} operations');
    ops.forEach((o, i) => {
        if (typeof o?.find !== 'string' || typeof o?.replace !== 'string') throw new PatchError(`op #${i}: needs string "find" and "replace"`);
        let hit: boolean;
        if (o.regex) {
            const re = new RegExp(o.find, (o.flags ?? '') + (o.all && !(o.flags ?? '').includes('g') ? 'g' : ''));
            hit = re.test(text); re.lastIndex = 0;
            if (hit) text = text.replace(re, o.replace);
        } else {
            hit = text.includes(o.find);
            if (hit) text = o.all ? text.split(o.find).join(o.replace) : text.replace(o.find, () => o.replace);
        }
        if (!hit && !o.optional) {
            const snippet = o.find.length > 80 ? o.find.slice(0, 77) + '...' : o.find;
            throw new PatchError(`op #${i}: text not found: ${JSON.stringify(snippet)} (the game file may have changed; mark "optional" to ignore)`);
        }
    });
    return text;
}
