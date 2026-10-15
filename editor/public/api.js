// Everything the editor says to the server. Writes carry a header a foreign web page cannot send.
async function call(url, opts) {
  let res;
  try { res = await fetch(url, opts); } catch { throw new Error('Cannot reach the editor server. Is `bun run start` still running?'); }
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(body?.error ?? `${res.status} ${res.statusText}`);
  return body;
}
const write = (method, url, body) => call(url, { method, headers: { 'content-type': 'application/json', 'x-omori-editor': '1' }, body: body === undefined ? undefined : JSON.stringify(body) });
const R = '/__editor/';
const mod = m => `${R}mod/${encodeURIComponent(m)}`;

export const api = {
  mods: () => call(`${R}mods`),
  gameMaps: () => call(`${R}game/maps`),
  gameMap: id => call(`${R}game/map/${id}`),
  tilesets: () => call(`${R}tilesets`),
  sprites: () => call(`${R}sprites`),
  names: () => call(`${R}game/names`),
  snapshot: (m, id) => call(`${mod(m)}/snapshot/${id}`),
  mtime: (m, id) => call(`${mod(m)}/mtime/${id}`),
  takeover: (m, id) => write('POST', `${mod(m)}/takeover`, { id }),
  release: (m, id) => write('POST', `${mod(m)}/release`, { id }),
  library: m => call(`${R}library?${new URLSearchParams(m ? { mod: m } : {})}`),
  savePiece: (m, piece) => write('POST', `${mod(m)}/piece`, piece),
  built: (m, id) => call(`${mod(m)}/built/${id}`),
  spec: (m, id) => call(`${mod(m)}/spec/${id}`),
  saveSpec: (m, id, spec) => write('PUT', `${mod(m)}/spec/${id}`, spec),
  preview: (m, spec) => write('POST', `${mod(m)}/preview`, spec),
  build: m => write('POST', `${mod(m)}/build`),
  newMap: (m, body) => write('POST', `${mod(m)}/new`, body),
  imgUrl: (kind, name, m) => `${R}img?${new URLSearchParams({ k: kind, n: name, ...(m ? { mod: m } : {}) })}`,
};
