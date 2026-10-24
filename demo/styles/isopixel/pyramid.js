// The planet's tile pyramid on the page (src/gpu/globe/bake.ts PYRAMID_FIELDS, pyramid.ts): the tiles under the camera at the tier
// each pixel needs, fetched, inflated and kept in two GPU atlases, so the planet layer reads the same 75 m ground at every zoom and
// the finer tier replaces the coarser one as it arrives. Tier t has 2^t by 2^t tiles of 256 by 256 cells a face; tier 0 is held whole
// from the start (six tiles), so a pixel always has a ground to read.
//   fields:  one texel of 16 bytes a cell (rgba32uint) with a halo of 1 cell, so the bilinear fields run on across a tile's edge
//   heights: the cell's height in metres (r32float) with a halo of 2 cells, so the B-spline of the cells and the relief march never
//            leave their layer
// Both halos are the neighbouring tiles' cells of the tier, across a cube's edge too: the cell past the edge is the neighbouring
// face's (the grid's own halo rule, src/gpu/globe/patch.ts cellAcross, the index along the edge kept or reversed as grid.ts EDGES
// says), so no seam shows at a tile's or a face's edge. Where a neighbour is not held, or at a cube's corner where no cell stands,
// the halo repeats the tile's own edge cell until the neighbour arrives (a held tile's halo is refreshed when one does).
//   table:   per tile of every tier, its atlas layer or NONE (storage buffer, the shader's page table)
import { fetchTileBytes } from "./tilecache.js";
const TILE = 256, HALO = 2, HS = TILE + 2 * HALO, FHS = TILE + 2, NONE = 0xffffffff, hStep = 0.25;
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

// The tile and cell holding the cell at face position (X, Y) of face f at tier t, which may lie past the face's edge: { i: the tile's
// index, lx, ly: the cell in it }, or null at a cube's corner. across(n, f, X, Y) is the cell's id (face * n * n + Y * n + X) or -1.
export function cellOf(across, t, f, X, Y) {
  const n = TILE << t;
  let ff = f, xx = X, yy = Y;
  if (X < 0 || X >= n || Y < 0 || Y >= n) {
    const id = across(n, f, X, Y);
    if (id < 0) return null;
    ff = Math.floor(id / (n * n)); const r = id % (n * n); yy = Math.floor(r / n); xx = r % n;
  }
  return { i: tileIndex(t, ff, xx >> 8, yy >> 8), lx: xx & 255, ly: yy & 255 };
}

// A tile's heights in metres with their halo of HALO cells from the neighbours: planeAt(i) the held tile's height plane (Int16, in
// steps of hStep) or undefined; a cell with none held is the tile's own nearest edge cell.
export function haloHeights(across, planeAt, t, f, tx, ty) {
  const own = planeAt(tileIndex(t, f, tx, ty)), out = new Float32Array(HS * HS), x0 = tx * TILE, y0 = ty * TILE, clamp = (v) => Math.min(TILE - 1, Math.max(0, v));
  for (let y = 0; y < HS; y++)
    for (let x = 0; x < HS; x++) {
      const lx = x - HALO, ly = y - HALO;
      if (lx >= 0 && lx < TILE && ly >= 0 && ly < TILE) { out[y * HS + x] = own[ly * TILE + lx] * hStep; continue; }
      const c = cellOf(across, t, f, x0 + lx, y0 + ly), H = c && planeAt(c.i);
      out[y * HS + x] = (H ? H[c.ly * TILE + c.lx] : own[clamp(ly) * TILE + clamp(lx)]) * hStep;
    }
  return out;
}

// info: the manifest (tiers, the faces that have tiles, where they are); across: the grid's cellAcross for a face of n cells; slots: the
// atlas layers (each 1 MB of fields and 0.27 MB of heights) [design: 192, a screen's tiles at three tiers and the cache for a pan]
export async function openPyramid({ device, base, tiers, faces, across: cellAcross, slots = 192, inflight = 6 }) {
  const total = tierOffset(tiers), table = new Uint32Array(total).fill(NONE);
  const fieldsT = device.createTexture({ size: [FHS, FHS, slots], format: "rgba32uint", usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST, label: "pyramid fields" });
  const heightsT = device.createTexture({ size: [HS, HS, slots], format: "r32float", usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST, label: "pyramid heights" });
  const tableB = device.createBuffer({ size: Math.max(16, table.byteLength), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST, label: "pyramid table" });
  const free = Array.from({ length: slots }, (_, i) => slots - 1 - i), slotOf = new Map(), held = new Array(slots).fill(null);
  const lastWant = new Map(), flying = new Set(), absent = new Set(), host = new Map(), edges = new Map(), whole = new Map(), stats = { fetched: 0, bytes: 0, evicted: 0 };
  let frameNo = 0, tableDirty = true;
  const tileOf = (i) => { let t = 0; while (i >= tierOffset(t + 1)) t++; const r = i - tierOffset(t), n = 4 ** t, f = Math.floor(r / n), q = r % n; return { t, f, ty: Math.floor(q / 2 ** t), tx: q % 2 ** t }; };
  const url = (t, f, tx, ty) => `${base}/t${t}/f${f}/${ty}-${tx}.tile.gz`;
  const across = (n, f, X, Y) => cellAcross({ fn: n }, f, X, Y);
  const planeAt = (i) => host.get(i);

  // the cell field's words: height (as its 16 bits), rock, drift | drift depth, temperature, rain | water, river, tree, shrub | grass, marsh, bare, soil
  function packFields(P) {
    const out = new Uint32Array(TILE * TILE * 4), h = new Uint16Array(P.height.buffer, P.height.byteOffset, TILE * TILE), t8 = new Uint8Array(P.temp.buffer, P.temp.byteOffset, TILE * TILE);
    for (let c = 0; c < TILE * TILE; c++) {
      const o = 4 * c;
      out[o] = (h[c] | (P.rock[c] << 16) | (P.drift[c] << 24)) >>> 0;
      out[o + 1] = (P.driftDepth[c] | (t8[c] << 8) | (P.rain[c] << 16)) >>> 0;
      out[o + 2] = (P.water[c] | (P.river[c] << 8) | (P.tree[c] << 16) | (P.shrub[c] << 24)) >>> 0;
      out[o + 3] = (P.grass[c] | (P.marsh[c] << 8) | (P.bare[c] << 16) | (P.soil[c] << 24)) >>> 0;
    }
    return out;
  }
  // a tile's outermost cells' words, the part of it its neighbours' halos read: top (row 0), bottom (row 255), left (column 0), right
  function edgesOf(w) {
    const row = (y) => w.slice(y * TILE * 4, (y + 1) * TILE * 4), col = (x) => { const o = new Uint32Array(TILE * 4); for (let y = 0; y < TILE; y++) o.set(w.subarray((y * TILE + x) * 4, (y * TILE + x) * 4 + 4), y * 4); return o; };
    return { top: row(0), bottom: row(TILE - 1), left: col(0), right: col(TILE - 1) };
  }
  // the words of cell (lx, ly) of a held tile that lies on its edge, or null
  function edgeWord(i, lx, ly) {
    const e = edges.get(i);
    if (!e) return null;
    if (ly === 0) return e.top.subarray(4 * lx, 4 * lx + 4);
    if (ly === TILE - 1) return e.bottom.subarray(4 * lx, 4 * lx + 4);
    if (lx === 0) return e.left.subarray(4 * ly, 4 * ly + 4);
    if (lx === TILE - 1) return e.right.subarray(4 * ly, 4 * ly + 4);
    return null;
  }
  // the halo ring of a tile's field layer (a FHS by FHS buffer of words) from the held neighbours, else the tile's own nearest edge cell
  function ringInto(buf, i) {
    const { t, f, tx, ty } = tileOf(i), x0 = tx * TILE, y0 = ty * TILE, clamp = (v) => Math.min(TILE - 1, Math.max(0, v));
    for (let y = 0; y < FHS; y++)
      for (let x = 0; x < FHS; x++) {
        if (x > 0 && x < FHS - 1 && y > 0 && y < FHS - 1) continue;
        const lx = x - 1, ly = y - 1, c = cellOf(across, t, f, x0 + lx, y0 + ly);
        const w = (c && edgeWord(c.i, c.lx, c.ly)) || edgeWord(i, clamp(lx), clamp(ly));
        buf.set(w, (y * FHS + x) * 4);
      }
  }
  // the tiles whose halos read this tile's cells (and whose cells its own read): the eight round it, across a face's edge too
  function neighbours(i) {
    const { t, f, tx, ty } = tileOf(i), out = new Set();
    for (const [dx, dy] of [[1, 0], [0, 1], [-1, 0], [0, -1], [1, 1], [-1, 1], [-1, -1], [1, -1]]) {
      const c = cellOf(across, t, f, dx < 0 ? tx * TILE - 1 : dx > 0 ? (tx + 1) * TILE : tx * TILE + TILE / 2, dy < 0 ? ty * TILE - 1 : dy > 0 ? (ty + 1) * TILE : ty * TILE + TILE / 2);
      if (c && c.i !== i) out.add(c.i);
    }
    return [...out];
  }
  const upHeights = (slot, data) => device.queue.writeTexture({ texture: heightsT, origin: [0, 0, slot] }, data, { bytesPerRow: HS * 4, rowsPerImage: HS }, [HS, HS, 1]);
  // a tile's heights with the halo from what is held now
  function heightsOf(i) {
    const { t, f, tx, ty } = tileOf(i);
    return haloHeights(across, planeAt, t, f, tx, ty);
  }
  // the four lines of a held tile's field halo written again (after a neighbour arrived)
  function refreshRing(i) {
    const slot = slotOf.get(i), buf = new Uint32Array(FHS * FHS * 4);
    ringInto(buf, i);
    const wr = (origin, size, data) => device.queue.writeTexture({ texture: fieldsT, origin: [...origin, slot] }, data, { bytesPerRow: size[0] * 16, rowsPerImage: size[1] }, [...size, 1]);
    wr([0, 0], [FHS, 1], buf.subarray(0, FHS * 4));
    wr([0, FHS - 1], [FHS, 1], buf.subarray((FHS - 1) * FHS * 4, FHS * FHS * 4));
    const col = (x) => { const o = new Uint32Array(FHS * 4); for (let y = 0; y < FHS; y++) o.set(buf.subarray((y * FHS + x) * 4, (y * FHS + x) * 4 + 4), y * 4); return o; };
    wr([0, 0], [1, FHS], col(0));
    wr([FHS - 1, 0], [1, FHS], col(FHS - 1));
  }

  function put(i, planes) {
    const { t, f } = tileOf(i);
    let slot = free.pop();
    if (slot === undefined) {
      // the least lately wanted tile that this frame does not want
      let worst = -1, at = -1;
      for (let s = 0; s < slots; s++) if (held[s] != null && held[s] >= tierOffset(1) && (lastWant.get(held[s]) ?? -1) < frameNo - 2 && (worst < 0 || (lastWant.get(held[s]) ?? -1) < worst)) { worst = lastWant.get(held[s]) ?? -1; at = s; }
      if (at < 0) return false;
      table[held[at]] = NONE; host.delete(held[at]); edges.delete(held[at]); slotOf.delete(held[at]); slot = at; stats.evicted++;
    }
    host.set(i, planes.height);
    if (t === 0) whole.set(f, planes);
    held[slot] = i; slotOf.set(i, slot); table[i] = slot; tableDirty = true;
    const words = packFields(planes);
    edges.set(i, edgesOf(words));
    const buf = new Uint32Array(FHS * FHS * 4);
    for (let y = 0; y < TILE; y++) buf.set(words.subarray(y * TILE * 4, (y + 1) * TILE * 4), ((y + 1) * FHS + 1) * 4);
    ringInto(buf, i);
    device.queue.writeTexture({ texture: fieldsT, origin: [0, 0, slot] }, buf, { bytesPerRow: FHS * 16, rowsPerImage: FHS }, [FHS, FHS, 1]);
    upHeights(slot, heightsOf(i));
    // the neighbours' halos now have this tile's cells
    for (const j of neighbours(i)) {
      const s = slotOf.get(j);
      if (s === undefined) continue;
      refreshRing(j);
      upHeights(s, heightsOf(j));
    }
    return true;
  }
  async function load(i) {
    flying.add(i);
    try {
      const { t, f, tx, ty } = tileOf(i), { raw, bytes } = await fetchTileBytes(url(t, f, tx, ty)), { planes } = decodeTile(raw);
      stats.fetched++; stats.bytes += bytes;
      put(i, planes);
    } catch (e) { absent.add(i); if (!e.status) console.warn(`tile ${i}: ${e.message}`); } finally { flying.delete(i); }
  }

  // tier 0 whole, before the first frame
  const t0 = [];
  for (const f of faces) t0.push(load(tileIndex(0, f, 0, 0)));
  await Promise.all(t0);
  const flush = () => { if (tableDirty) { device.queue.writeBuffer(tableB, 0, table); tableDirty = false; } };
  flush();

  return {
    fieldsT, heightsT, tableB, tiers, stats, held: () => slotOf.size, flying: () => flying.size,
    // whether a tile is held, or never will be (its face is not baked, or its file is not there): what the view's finest level waits on (planet.js readyLevel)
    ready(t, f, tx, ty) { const i = tileIndex(t, f, tx, ty); return slotOf.has(i) || absent.has(i) || !faces.includes(f); },
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
