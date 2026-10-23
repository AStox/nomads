// The planet's baked tile files (a ground tile, a pyramid tile: gzip as the bake wrote them) kept in the browser's origin-private file system,
// so a place seen before is read from disk instead of the network. `fetchTileBytes(url)` is `fetch` + gunzip with that cache in front;
// a failure of the cache (no OPFS, a full disk, a corrupt file) only costs the network trip, it never fails a load.
//
// A file is kept under the planet's key (the `<seed>-<key>` directory of its URL), so a rebaked planet never reads old bytes and the other
// keys' files are deleted when a planet is first used. The bytes kept are the gzip, 5 times smaller than the planes, so a gigabyte holds
// about 1,100 ground tiles. A manifest per planet (file name to size, in least-lately-used-first order) is rewritten a couple of seconds
// after it changes; a file it does not list (written after the last save) is adopted when the planet is opened.
const BUDGET = 1e9, SAVE_MS = 2000, ROOT = "tilecache", MANIFEST = "manifest.json";
const PLANET = /\/planets\/(?:link-)?([^/]+)\/(.+)$/;

const gunzip = async (stream) => new Uint8Array(await new Response(stream.pipeThrough(new DecompressionStream("gzip"))).arrayBuffer());
const nameOf = (rel) => rel.replaceAll("/", "~");

let open = null;

async function openStore(key) {
  const root = await (await navigator.storage.getDirectory()).getDirectoryHandle(ROOT, { create: true });
  const dir = await root.getDirectoryHandle(key, { create: true });
  const s = { dir, index: new Map(), total: 0, budget: BUDGET, timer: 0, saving: Promise.resolve(), writes: new Set() };
  try {
    const m = JSON.parse(await (await (await dir.getFileHandle(MANIFEST)).getFile()).text());
    for (const [name, size] of m.files) { s.index.set(name, size); s.total += size; }
  } catch { /* a new planet, or a manifest lost to a crash */ }
  // files the manifest does not list were finished after its last save (a file appears whole or not at all), so they are kept
  const unlisted = [];
  for await (const name of dir.keys()) if (name !== MANIFEST && !s.index.has(name)) unlisted.push(name);
  await Promise.all(unlisted.map(async (name) => {
    try { const size = (await (await dir.getFileHandle(name)).getFile()).size; s.index.set(name, size); s.total += size; } catch { await dir.removeEntry(name).catch(() => {}); }
  }));
  const quota = (await navigator.storage.estimate?.())?.quota;
  if (quota) s.budget = Math.min(BUDGET, quota * 0.5);
  // the other planets' files are not read again
  (async () => { for await (const name of root.keys()) if (name !== key) await root.removeEntry(name, { recursive: true }).catch(() => {}); })().catch(() => {});
  return s;
}

async function storeFor(key) {
  if (open?.key !== key) {
    const usable = typeof navigator !== "undefined" && navigator.storage?.getDirectory && typeof FileSystemFileHandle !== "undefined" && "createWritable" in FileSystemFileHandle.prototype;
    open = { key, store: usable ? openStore(key).catch(() => null) : Promise.resolve(null) };
  }
  return open.store;
}

function changed(s) {
  if (s.timer) return;
  s.timer = setTimeout(() => { s.timer = 0; save(s); }, SAVE_MS);
}

function save(s) {
  const files = [...s.index];
  s.saving = s.saving.then(async () => {
    const w = await (await s.dir.getFileHandle(MANIFEST, { create: true })).createWritable();
    await w.write(JSON.stringify({ files })); await w.close();
  }).catch(() => {});
  return s.saving;
}

function forget(s, name) {
  const size = s.index.get(name);
  if (size === undefined) return;
  s.index.delete(name); s.total -= size; changed(s);
  return s.dir.removeEntry(name).catch(() => {});
}

// the least lately used files go until the files kept are `limit` bytes or fewer
async function evict(s, limit) {
  while (s.total > limit && s.index.size) await forget(s, s.index.keys().next().value);
}

async function read(s, name) {
  if (!s.index.has(name)) return null;
  try {
    const file = await (await s.dir.getFileHandle(name)).getFile();
    const size = s.index.get(name);
    s.index.delete(name); s.index.set(name, size); changed(s);
    return file;
  } catch { await forget(s, name); return null; }
}

async function write(s, name, bytes) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const w = await (await s.dir.getFileHandle(name, { create: true })).createWritable();
      try { await w.write(bytes); await w.close(); } catch (e) { await w.abort().catch(() => {}); throw e; }
      s.total += bytes.byteLength - (s.index.get(name) ?? 0);
      s.index.delete(name); s.index.set(name, bytes.byteLength);
      changed(s);
      return evict(s, s.budget);
    } catch (e) {
      await s.dir.removeEntry(name).catch(() => {});
      // a full disk: let go of half of what is kept and try once more, then go on without keeping this file
      if (e?.name !== "QuotaExceededError" || attempt) return;
      await evict(s, s.total / 2);
    }
  }
}

// The gunzipped bytes of the file at `url` and the bytes it took over the network (0 when it came from disk).
// A response that is not ok throws an Error with its `status`.
export async function fetchTileBytes(url) {
  const m = PLANET.exec(url), s = m ? await storeFor(m[1]) : null, name = m && nameOf(m[2]);
  if (s) {
    const file = await read(s, name);
    if (file) {
      try { return { raw: await gunzip(file.stream()), bytes: 0 }; } catch { await forget(s, name); }
    }
  }
  const res = await fetch(url);
  if (!res.ok) throw Object.assign(new Error(`${url} did not load (${res.status})`), { status: res.status });
  if (!s) return { raw: await gunzip(res.body), bytes: Number(res.headers.get("content-length") ?? 0) };
  const [a, b] = res.body.tee();
  const [raw, zipped] = await Promise.all([gunzip(a), new Response(b).arrayBuffer()]);
  const kept = write(s, name, zipped).finally(() => s.writes.delete(kept));
  s.writes.add(kept);
  return { raw, bytes: zipped.byteLength };
}

// Resolves when every file being kept and the manifest are on disk.
export async function settleCache() {
  const s = await open?.store;
  if (!s) return;
  await Promise.all(s.writes);
  if (s.timer) { clearTimeout(s.timer); s.timer = 0; }
  await save(s);
}

// What is kept for the planet in use, and the budget over which the least lately used files go (a smaller one evicts at once).
export async function cacheState(budget) {
  const s = await open?.store;
  if (!s) return null;
  if (budget !== undefined) { s.budget = budget; await evict(s, budget); }
  return { files: s.index.size, bytes: s.total, budget: s.budget, names: [...s.index.keys()] };
}

// Deletes every file kept, for every planet.
export async function clearCache() {
  await settleCache();
  open = null;
  if (typeof navigator !== "undefined" && navigator.storage?.getDirectory) await (await navigator.storage.getDirectory()).removeEntry(ROOT, { recursive: true }).catch(() => {});
}
