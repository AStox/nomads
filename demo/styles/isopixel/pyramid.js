// The planet's tile pyramid on the page (src/gpu/globe/bake.ts PYRAMID_FIELDS, pyramid.ts): the tiles under the camera at the tier
// each pixel needs, fetched, inflated and kept in two GPU atlases, so the planet layer reads the same 75 m ground at every zoom and
// the finer tier replaces the coarser one as it arrives. Tier t has 2^t by 2^t tiles of 256 by 256 cells a face; tier 0 is held whole
// from the start (six tiles), so a pixel always has a ground to read.
//   fields: one texel of 16 bytes a cell, nearest or bilinear inside a tile (rgba32uint, 256 by 256)
//   heights: the cell's height in metres with a halo of 2 cells from the neighbouring tiles of its tier (r32float, 260 by 260), so
//            the B-spline of the cells and the relief march never leave their layer; across a cube's edge the halo repeats the
//            edge's cell [gap: a seam of a cell or two at a cube's edge]
//   table:  per tile of every tier, its atlas layer or NONE (storage buffer, the shader's page table)
const TILE = 256, HALO = 2, HS = TILE + 2 * HALO, NONE = 0xffffffff;
const inflate = async (res) => new Uint8Array(await new Response(res.body.pipeThrough(new DecompressionStream("gzip"))).arrayBuffer());
const TYPES = { i8: Int8Array, u8: Uint8Array, i16: Int16Array, u16: Uint16Array, i32: Int32Array, u32: Uint32Array, f32: Float32Array };

// a tile's bytes (header length, header JSON, the planes in the header's field order) as its header and typed planes by name
export function decodeTile(raw) {
  const hl = new DataView(raw.buffer, raw.byteOffset).getUint32(0, true), meta = JSON.parse(new TextDecoder().decode(raw.subarray(4, 4 + hl))), planes = {};
  let at = 4 + hl;
  for (const f of meta.fields) {
    const K = TYPES[f.type], bytes = TILE * TILE * K.BYTES_PER_ELEMENT;
    planes[f.name] = new K(raw.slice(at, at + bytes).buffer);
    at += bytes;
  }
  return { meta, planes };
}

// where the tiles of tier t start in the page table, and the index of one
export const tierOffset = (t) => (6 * (4 ** t - 1)) / 3;
export const tileIndex = (t, f, tx, ty) => tierOffset(t) + f * 4 ** t + ty * 2 ** t + tx;

// the face under a unit point and its equiangular fractions across the face (src/gpu/globe/grid.ts locateVec)
export function faceFrac(FRAMES, p) {
  let f = 0, best = -Infinity;
  for (let k = 0; k < 6; k++) { const d = p[0] * FRAMES[k].n[0] + p[1] * FRAMES[k].n[1] + p[2] * FRAMES[k].n[2]; if (d > best) { best = d; f = k; } }
  const X = FRAMES[f].ex, Y = FRAMES[f].ey, ua = (p[0] * X[0] + p[1] * X[1] + p[2] * X[2]) / best, vb = (p[0] * Y[0] + p[1] * Y[1] + p[2] * Y[2]) / best;
  return { f, fx: Math.atan(ua) / (Math.PI / 2) + 0.5, fy: Math.atan(vb) / (Math.PI / 2) + 0.5 };
}

// info: the manifest (tiers, the faces that have tiles, where they are); slots: the atlas layers (each 1 MB of fields and 0.27 MB of
// heights) [design: 192, a screen's tiles at three tiers and the cache for a pan]
export async function openPyramid({ device, base, tiers, faces, slots = 192, inflight = 6 }) {
  const total = tierOffset(tiers), table = new Uint32Array(total).fill(NONE);
  const fieldsT = device.createTexture({ size: [TILE, TILE, slots], format: "rgba32uint", usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST, label: "pyramid fields" });
  const heightsT = device.createTexture({ size: [HS, HS, slots], format: "r32float", usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST, label: "pyramid heights" });
  const tableB = device.createBuffer({ size: Math.max(16, table.byteLength), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST, label: "pyramid table" });
  const free = Array.from({ length: slots }, (_, i) => slots - 1 - i), slotOf = new Map(), held = new Array(slots).fill(null);
  const lastWant = new Map(), flying = new Set(), absent = new Set(), host = new Map(), whole = new Map(), stats = { fetched: 0, bytes: 0, evicted: 0 };
  let frameNo = 0, tableDirty = true;
  const tileOf = (i) => { let t = 0; while (i >= tierOffset(t + 1)) t++; const r = i - tierOffset(t), n = 4 ** t, f = Math.floor(r / n), q = r % n; return { t, f, ty: Math.floor(q / 2 ** t), tx: q % 2 ** t }; };
  const url = (t, f, tx, ty) => `${base}/t${t}/f${f}/${ty}-${tx}.tile.gz`;

  // the cell field's words: height (as its 16 bits), rock, drift | drift depth, temperature, rain | water, river, tree, shrub | grass, marsh, bare, soil
  function packFields(P) {
    const out = new Uint32Array(TILE * TILE * 4), h = new Uint16Array(P.height.buffer, P.height.byteOffset, TILE * TILE), t8 = new Uint8Array(P.temp.buffer, P.temp.byteOffset, TILE * TILE);
    for (let c = 0; c < TILE * TILE; c++) {
      const o = 4 * c;
      out[o] = h[c] | (P.rock[c] << 16) | (P.drift[c] << 24);
      out[o + 1] = P.driftDepth[c] | (t8[c] << 8) | (P.rain[c] << 16);
      out[o + 2] = P.water[c] | (P.river[c] << 8) | (P.tree[c] << 16) | (P.shrub[c] << 24);
      out[o + 3] = P.grass[c] | (P.marsh[c] << 8) | (P.bare[c] << 16) | (P.soil[c] << 24);
    }
    return out;
  }
  const hStep = 0.25;
  // a tile's heights with their halo from the neighbours of its tier that are held (else the edge's own cell)
  function layerOf(t, f, tx, ty) {
    const own = host.get(tileIndex(t, f, tx, ty)), out = new Float32Array(HS * HS), n = 2 ** t;
    for (let y = 0; y < HS; y++)
      for (let x = 0; x < HS; x++) {
        let gx = x - HALO, gy = y - HALO, nx = tx, ny = ty, src = own;
        if (gx < 0 || gx >= TILE || gy < 0 || gy >= TILE) {
          nx += gx < 0 ? -1 : gx >= TILE ? 1 : 0; ny += gy < 0 ? -1 : gy >= TILE ? 1 : 0;
          const nb = nx >= 0 && ny >= 0 && nx < n && ny < n ? host.get(tileIndex(t, f, nx, ny)) : null;
          if (nb) { src = nb; gx = (gx + TILE) % TILE; gy = (gy + TILE) % TILE; } else { gx = Math.min(TILE - 1, Math.max(0, gx)); gy = Math.min(TILE - 1, Math.max(0, gy)); }
        }
        out[y * HS + x] = src[gy * TILE + gx] * hStep;
      }
    return out;
  }
  const upHeights = (slot, data) => device.queue.writeTexture({ texture: heightsT, origin: [0, 0, slot] }, data, { bytesPerRow: HS * 4, rowsPerImage: HS }, [HS, HS, 1]);
  function put(i, planes) {
    const { t, f, tx, ty } = tileOf(i);
    let slot = free.pop();
    if (slot === undefined) {
      // the least lately wanted tile that this frame does not want
      let worst = -1, at = -1;
      for (let s = 0; s < slots; s++) if (held[s] != null && held[s] >= tierOffset(1) && (lastWant.get(held[s]) ?? -1) < frameNo - 2 && (worst < 0 || (lastWant.get(held[s]) ?? -1) < worst)) { worst = lastWant.get(held[s]) ?? -1; at = s; }
      if (at < 0) return false;
      table[held[at]] = NONE; host.delete(held[at]); slotOf.delete(held[at]); slot = at; stats.evicted++;
    }
    host.set(i, planes.height);
    if (t === 0) whole.set(f, planes);
    held[slot] = i; slotOf.set(i, slot); table[i] = slot; tableDirty = true;
    device.queue.writeTexture({ texture: fieldsT, origin: [0, 0, slot] }, packFields(planes), { bytesPerRow: TILE * 16, rowsPerImage: TILE }, [TILE, TILE, 1]);
    upHeights(slot, layerOf(t, f, tx, ty));
    // the neighbours' halos now have this tile's cells
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue;
      const nx = tx + dx, ny = ty + dy;
      if (nx < 0 || ny < 0 || nx >= 2 ** t || ny >= 2 ** t) continue;
      const j = tileIndex(t, f, nx, ny), s = slotOf.get(j);
      if (s !== undefined) upHeights(s, layerOf(t, f, nx, ny));
    }
    return true;
  }
  async function load(i) {
    flying.add(i);
    try {
      const { t, f, tx, ty } = tileOf(i), res = await fetch(url(t, f, tx, ty));
      if (!res.ok) { absent.add(i); return; }
      const raw = await inflate(res), { planes } = decodeTile(raw);
      stats.fetched++; stats.bytes += Number(res.headers.get("content-length") ?? 0);
      put(i, planes);
    } catch (e) { absent.add(i); console.warn(`tile ${i}: ${e.message}`); } finally { flying.delete(i); }
  }

  // tier 0 whole, before the first frame
  const t0 = [];
  for (const f of faces) t0.push(load(tileIndex(0, f, 0, 0)));
  await Promise.all(t0);
  const flush = () => { if (tableDirty) { device.queue.writeBuffer(tableB, 0, table); tableDirty = false; } };
  flush();

  return {
    fieldsT, heightsT, tableB, tiers, stats, held: () => slotOf.size, flying: () => flying.size,
    // the tile of tier 0 as planes, for choosing a place (held while the planet is)
    planes0: (f) => whole.get(f),
    // the ground's height in metres at a unit point, from the finest tile held there (bilinear between its cells' centres), 0 where none is
    heightAt(FRAMES, p) {
      const { f, fx, fy } = faceFrac(FRAMES, p);
      for (let t = tiers - 1; t >= 0; t--) {
        const n = 2 ** t, sx = fx * TILE * n, sy = fy * TILE * n, tx = Math.min(n - 1, Math.floor(sx / TILE)), ty = Math.min(n - 1, Math.floor(sy / TILE)), H = host.get(tileIndex(t, f, tx, ty));
        if (!H) continue;
        const x = Math.max(0, Math.min(TILE - 1.001, sx - tx * TILE - 0.5)), y = Math.max(0, Math.min(TILE - 1.001, sy - ty * TILE - 0.5)), ix = Math.floor(x), iy = Math.floor(y), a = x - ix, b = y - iy, i = iy * TILE + ix;
        return hStep * ((H[i] * (1 - a) + H[i + 1] * a) * (1 - b) + (H[i + TILE] * (1 - a) + H[i + TILE + 1] * a) * b);
      }
      return 0;
    },
    // the tiles a frame wants, [{ t, f, tx, ty }] most wanted first: marks them wanted, and starts the fetches that are free
    want(list) {
      frameNo++;
      for (const w of list) {
        const i = tileIndex(w.t, w.f, w.tx, w.ty);
        lastWant.set(i, frameNo);
        if (slotOf.has(i) || absent.has(i) || flying.has(i) || !faces.includes(w.f)) continue;
        if (flying.size >= inflight) break;
        load(i);
      }
      flush();
    },
    flush,
  };
}
