// The close ground of the planet anywhere: a window of 256 by 256 cells (the play area's size, 19.2 km) laid on the planet's finest tier
// at the camera, made of its ground tiles (bake.ts GROUNDTILE_FIELDS: every field the painter and the scatter read, in a halo of 8 round
// each tile of 256 cells). The tiles are streamed (the window's cells come from up to four of them, and across a cube's edge from the
// face across, laid flat by the grid's own rule, src/gpu/globe/patch.ts cellAcross), the window's fine ground is the scatter's fine kernel
// run on its cells (so a vertex is the same whichever window holds it), and what grew is each tile's own scatter (scatter.ts: the same
// objects every visit) cut to the window. The window is the island's ground in everything the painter and the renderer read, and in
// its frame: x along the face's X axis, z against its Y (north-up as the planet is seen from above, not mirrored), metres of 75 m a cell.
import { CELL, N } from "../island.js";
import { packGround } from "./ground.wgsl.js";

const S = N + 16, H = 8, UNITS = 5000;
const TYPES = { i8: Int8Array, u8: Uint8Array, i16: Int16Array, u16: Uint16Array, i32: Int32Array, u32: Uint32Array, f32: Float32Array };
const DIRS = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];
const D2R = Math.PI / 180;
// the sizes the window's object buffer comes in, so its pipelines are made once for each [design: a body is 28 bytes a slot, 235 MB at the top]
const CAPS = [1 << 20, 1 << 21, 1 << 22, 1 << 23];
const inflate = async (res) => new Uint8Array(await new Response(res.body.pipeThrough(new DecompressionStream("gzip"))).arrayBuffer());
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const unit = (a) => { const l = Math.hypot(a[0], a[1], a[2]); return [a[0] / l, a[1] / l, a[2] / l]; };

function decode(raw) {
  const hl = new DataView(raw.buffer, raw.byteOffset).getUint32(0, true), meta = JSON.parse(new TextDecoder().decode(raw.subarray(4, 4 + hl))), planes = {};
  let at = 4 + hl;
  for (const f of meta.fields) {
    const K = TYPES[f.type], bytes = S * S * K.BYTES_PER_ELEMENT;
    planes[f.name] = new K(raw.slice(at, at + bytes).buffer);
    at += bytes;
  }
  return { meta, planes };
}

// G: the globe.js bundle; T: the tile.js bundle (the scatter and the window's fine ground); gpu: the worker's { device, adapter };
// base: where the planet's files are (its `groundtiles` directory is in it); tier: the finest tier; seed: the world's; radiusM: the planet's
// radius; quick: the island's runoff by season, for a window whose tiles hold none.
export function createWindows({ G, T, gpu, base, tier, seed, radiusM, quick, keep = 6, top = CAPS[CAPS.length - 1] }) {
  const g = G.tierGrid(tier), fn = g.fn, nT = 2 ** tier, tiles = new Map();
  // the window's kernels compile on the GPU process's own threads from the start, so no window stops the frames to compile one
  const warming = T.warmWindow(gpu);
  const tileKey = (f, tx, ty) => (f * nT + ty) * nT + tx;
  // a ground tile, fetched and kept (the least lately used going when `keep` are held)
  async function groundTile(f, tx, ty) {
    const k = tileKey(f, tx, ty);
    let t = tiles.get(k);
    if (!t) {
      t = fetch(`${base}/groundtiles/f${f}/${ty}-${tx}.gt.gz`).then(async (res) => {
        if (!res.ok) throw new Error(`ground tile ${f}/${ty}-${tx} did not load (${res.status})`);
        return { ...decode(await inflate(res)), bytes: Number(res.headers.get("content-length") ?? 0) };
      });
      tiles.set(k, t);
      stats.tiles++;
    } else { tiles.delete(k); tiles.set(k, t); }
    while (tiles.size > keep + 2) { const old = tiles.keys().next().value; tiles.delete(old); }
    const r = await t;
    stats.bytes += r.bytes; r.bytes = 0;
    return r;
  }
  const stats = { tiles: 0, bytes: 0, builds: 0, ms: {} };

  // The window whose centre is the cell holding (lat, lon) degrees. Returns what the renderer, the page and the object buffer take.
  async function build(lat, lon) {
    await warming;
    const t0 = performance.now(), loc = G.locateVec(g, G.fromLatLon(lat * D2R, lon * D2R)), face = loc.face, x0 = loc.X - N / 2, y0 = loc.Y - N / 2;
    // Where every cell of the window and its halo comes from. The tiles of the window's own face that its cells lie on hold them, and the 8 cells of
    // halo each holds past its edge (laid flat across a cube's edge in the face's own axes), so a cell is read from them in the window's own frame;
    // a cell farther past a cube's edge is the face across's: the cell of the tier that stands there, from the tile that holds it.
    const tl = [], tlOf = new Map(), cover = [];
    const add = (f, tx, ty, direct) => {
      const k = tileKey(f, tx, ty);
      let q = tlOf.get(k);
      if (q === undefined) { q = tl.length; tlOf.set(k, q); tl.push({ f, tx, ty, direct, interior: false, k }); }
      return q;
    };
    for (let ty = Math.max(0, Math.floor(y0 / 256)); ty <= Math.min(nT - 1, Math.floor((y0 + N - 1) / 256)); ty++)
      for (let tx = Math.max(0, Math.floor(x0 / 256)); tx <= Math.min(nT - 1, Math.floor((x0 + N - 1) / 256)); tx++) cover.push(add(face, tx, ty, true));
    const own = new Int16Array(S * S).fill(-1), at = new Int32Array(S * S), srcF = new Int8Array(S * S).fill(-1), srcX = new Int32Array(S * S), srcY = new Int32Array(S * S);
    for (let j = 0; j < S; j++)
      for (let i = 0; i < S; i++) {
        const k = j * S + i, Xw = x0 - H + i, Yw = y0 - H + j, inner = i >= H && i < H + N && j >= H && j < H + N;
        let best = -1, bestIn = false;
        for (const q of cover) {
          const t = tl[q], lx = Xw - t.tx * 256, ly = Yw - t.ty * 256;
          if (lx < -H || lx >= 256 + H || ly < -H || ly >= 256 + H) continue;
          const isIn = lx >= 0 && lx < 256 && ly >= 0 && ly < 256;
          if (best < 0 || (isIn && !bestIn)) { best = q; bestIn = isIn; at[k] = (ly + H) * S + lx + H; }
        }
        if (best >= 0) { own[k] = best; srcF[k] = face; srcX[k] = Xw; srcY[k] = Yw; if (inner && bestIn) tl[best].interior = true; continue; }
        const id = G.cellAcross({ fn }, face, Xw, Yw);
        if (id < 0) continue;
        const f = Math.floor(id / (fn * fn)), r = id % (fn * fn), yy = Math.floor(r / fn), xx = r % fn, q = add(f, xx >> 8, yy >> 8, false);
        own[k] = q; srcF[k] = f; srcX[k] = xx; srcY[k] = yy; at[k] = (yy - (yy >> 8) * 256 + H) * S + (xx - (xx >> 8) * 256 + H);
        if (inner) tl[q].interior = true;
      }
    const got = await Promise.all(tl.map((t) => groundTile(t.f, t.tx, t.ty)));
    got.forEach((gt, q) => { tl[q].gt = gt; });
    const t1 = performance.now();
    // how each face across the cube's edge is turned against the window's: a step east in the window is a step (dx, dy) in the face's cells
    const turn = new Map([[face, [1, 0]]]), ref = new Map();
    for (let j = 0; j < S; j++)
      for (let i = 0; i < S - 1; i++) {
        const k = j * S + i, f = srcF[k];
        if (f < 0 || f === face || ref.has(f)) continue;
        if (srcF[k + 1] === f) { turn.set(f, [srcX[k + 1] - srcX[k], srcY[k + 1] - srcY[k]]); ref.set(f, k); }
      }
    // the window's planes, in the tile's units: its cells from the tiles that hold them
    const first = got[0], planes = {};
    for (const fld of first.meta.fields) {
      const K = TYPES[fld.type], out = new K(S * S), sea = fld.name === "height" ? -200 * 256 : fld.name === "water" ? 20000 : 0;
      if (sea) out.fill(sea);
      planes[fld.name] = out;
    }
    const names = first.meta.fields.map((f) => f.name);
    for (let k = 0; k < S * S; k++) {
      const q = own[k];
      if (q < 0) continue;
      const pl0 = tl[q].gt.planes;
      for (const n of names) planes[n][k] = pl0[n][at[k]];
    }
    // a receiver is a step in its own face's cells: turned into the window's
    if (planes.dir) {
      for (let k = 0; k < S * S; k++) {
        const c = planes.dir[k], f = srcF[k];
        if (!c || f === face) continue;
        const d = turn.get(f);
        if (!d) { planes.dir[k] = 0; continue; }
        const [sx, sy] = DIRS[c - 1], wx = d[0] * sx + d[1] * sy, wy = -d[1] * sx + d[0] * sy;
        planes.dir[k] = DIRS.findIndex(([a, b]) => a === wx && b === wy) + 1;
      }
    }
    // a cell where no cell of the planet stands (a cube's corner) has no channel
    for (let k = 0; k < S * S; k++) if (own[k] < 0) { if (planes.chn) planes.chn[k] = 0; if (planes.dir) planes.dir[k] = 0; }
    const win = { meta: { side: S, halo: H, fields: first.meta.fields, absent: [] }, planes };
    const src = T.tileSource(win);
    const wg = await T.windowGround(gpu, src, face, x0, y0);
    const t2 = performance.now();

    // ---------- the painter's inputs, rows turned so that z runs south ----------
    const flipCells = (f) => { const o = new Float32Array(N * N); for (let j = 0; j < N; j++) { const at = (H + N - 1 - j) * S + H; for (let i = 0; i < N; i++) o[j * N + i] = f(at + i); } return o; };
    const pl = planes;
    const flags = pl.flags;
    const height = flipCells((a) => pl.height[a] / 256), water = flipCells((a) => pl.water[a] * 0.01);
    const season = (name, f) => Array.from({ length: 4 }, (_, s) => (pl[`${name}${s}`] ? flipCells((a) => f(pl[`${name}${s}`][a])) : null));
    const precip = flipCells((a) => (pl.pr1[a] / 360) ** 2), pet = flipCells((a) => pl.pe1[a] * 0.1), snow = season("snp", (v) => v * 0.25);
    // the runoff by season is the tiles' own (the water stage's, per tile), weighted by the window's cells in each; the island's where no tile holds one
    const wq = [0, 0, 0, 0];
    let wn = 0;
    for (let j = H; j < H + N; j++) for (let i = H; i < H + N; i++) { const q = own[j * S + i] >= 0 && tl[own[j * S + i]].gt.meta.quick; if (q) { for (let s = 0; s < 4; s++) wq[s] += q[s]; wn++; } }
    const runoff = wn ? wq.map((v) => v / wn) : quick;
    const isle = {
      height, water, windShare: flipCells((a) => pl.wsh[a] / 255), rock: flipCells((a) => pl.rock[a]), table: flipCells((a) => pl.tab[a] / 256),
      peat: flipCells((a) => (flags[a] & 4 ? 1 : 0)), soil: flipCells((a) => pl.soil[a] / 1024), silt: flipCells((a) => (flags[a] & 1 ? 1 : 0)), fog: flipCells((a) => pl.fog[a] / 255),
      seasons: [0, 1, 2, 3].map((s) => ({ precip: s === 1 ? precip : null, pet: s === 1 ? pet : null, snowpack: snow[s] })), quick: runoff,
    };
    // the fine layers, the stream mask and the light grid are the GPU's (windowGround), copied into the renderer's textures by setGround; only the streams are binned here, z turned
    const h = wg.h;
    const rivers = wg.rivers.map((line) => line.map((p) => [p[0], -p[1], ...p.slice(2)]));
    const pack = packGround(isle, { rivers }, { fine: wg.fine, grid: wg.grid, mask: wg.mask, top: wg.top, finePitch: wg.finePitch, fineLayerWords: wg.fineLayerWords, gridPitch: wg.gridPitch, gridLayerWords: wg.gridLayerWords });
    const t3 = performance.now();
    let peak = 0;
    for (const v of height) peak = Math.max(peak, v);

    // ---------- what grew: each tile's own scatter, put in the window's frame, thinned and binned into the renderer's body on the GPU, nothing read back ----------
    const placed = [];
    for (const t of tl) {
      if (!t.interior) continue;
      const at = placer(t, face, x0, y0, srcF, srcX, srcY, turn);
      if (!at || at.rect.w <= 0 || at.rect.h <= 0) continue;
      // only the cells of the tile the window touches are made (the objects' ids in the tile's whole run are the same either way)
      placed.push({ tile: t.f * nT * nT + t.ty * nT + t.tx, source: T.tileSource(t.gt), rect: at.rect, a0: t.tx * 256 * UNITS, a1: t.ty * 256 * UNITS, ...at.units });
      stats.scatter = (stats.scatter ?? 0) + 1;
    }
    const objects = await T.windowObjects(gpu, tier, placed, seed, { caps: CAPS.filter((c) => c <= top), side: N });
    const t4 = performance.now();

    // ---------- where the window stands on the sphere ----------
    const pc = (fx, fy) => G.pointOf(face, Math.tan(((x0 + fx) / fn - 0.5) * (Math.PI / 2)), Math.tan(((y0 + fy) / fn - 0.5) * (Math.PI / 2)));
    const c = pc(N / 2, N / 2), pe = pc(N / 2 + 1, N / 2), pn = pc(N / 2, N / 2 + 1);
    const along = (a) => { const d = dot(a, c); return unit([a[0] - c[0] * d, a[1] - c[1] * d, a[2] - c[2] * d]); };
    const e = along(pe), n0 = along(pn), dn = dot(n0, e), n = unit([n0[0] - e[0] * dn, n0[1] - e[1] * dn, n0[2] - e[2] * dn]);
    const arc = (a, b) => 2 * Math.atan2(Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]), Math.hypot(a[0] + b[0], a[1] + b[1], a[2] + b[2])) * radiusM;
    const scale = Math.sqrt(arc(c, pe) * arc(c, pn)) / CELL;
    const [E, Nn] = G.eastNorth(c);
    stats.builds++;
    stats.ms = { tiles: t1 - t0, fine: t2 - t1, pack: t3 - t2, flora: t4 - t3, total: t4 - t0 };
    return {
      id: `${face}:${x0}:${y0}`, face, x0, y0, c, e, n, scale, rot: [dot(e, E), dot(e, Nn), dot(n, E), dot(n, Nn)],
      lat: G.latLon(c).lat / D2R, lon: G.latLon(c).lon / D2R, pack, objects, fields: { peak, h, height, water }, stats: { ...stats, ms: stats.ms, objects: objects.n, share: objects.share },
    };
  }

  // Where a tile's objects stand in the window, in whole units of 15 mm (UNITS to the cell): { rect, units }. units are the shift and turn the GPU's place kernel applies (wgsl/terrain-place.ts):
  // out x = d0 (A0 + px - s0x) + d1 (A1 + py - s0y) + w0x, out y = N - (-d1 (A0 + px - s0x) + d0 (A1 + py - s0y) + w0y), A the tile's corner and (px, py) the entry's place from it. rect is the
  // rectangle of the tile's cells (x0, y0, w, h) that holds the window, which is all the scatter need make. null when the tile's face is turned against the window's by no turn the window knows.
  // This face's cells are the window's by p_window = R^T (p_face - p0) + w0 from a cell that stands in both.
  function placer(t, face, x0, y0, srcF, srcX, srcY, turn) {
    const clip = (lo, hi) => { const a = Math.max(0, Math.floor(lo) - 1), b = Math.min(256, Math.ceil(hi) + 1); return [a, Math.max(0, b - a)]; };
    if (t.f === face) {
      const [rx, rw] = clip(x0 - t.tx * 256, x0 + N - t.tx * 256), [ry, rh] = clip(y0 - t.ty * 256, y0 + N - t.ty * 256);
      return { rect: { x0: rx, y0: ry, w: rw, h: rh }, units: { s0x: x0 * UNITS, s0y: y0 * UNITS, w0x: 0, w0y: 0, d0: 1, d1: 0 } };
    }
    const d = turn.get(t.f);
    let k = -1;
    for (let q = 0; q < S * S; q++) if (srcF[q] === t.f) { k = q; break; }
    if (!d || k < 0) return null;
    const s0x = srcX[k] * UNITS + UNITS / 2, s0y = srcY[k] * UNITS + UNITS / 2, w0x = ((k % S) - H) * UNITS + UNITS / 2, w0y = (Math.floor(k / S) - H) * UNITS + UNITS / 2;
    const s0 = [srcX[k] + 0.5, srcY[k] + 0.5], w0 = [(k % S) - H + 0.5, Math.floor(k / S) - H + 0.5];
    // the window's corners back in the tile's cells: p_face = R (p_window - w0) + p0
    const xs = [], ys = [];
    for (const [cx, cy] of [[0, 0], [N, 0], [0, N], [N, N]]) {
      const ux = cx - w0[0], uy = cy - w0[1];
      xs.push(s0[0] + d[0] * ux - d[1] * uy - t.tx * 256); ys.push(s0[1] + d[1] * ux + d[0] * uy - t.ty * 256);
    }
    const [rx, rw] = clip(Math.min(...xs), Math.max(...xs)), [ry, rh] = clip(Math.min(...ys), Math.max(...ys));
    return { rect: { x0: rx, y0: ry, w: rw, h: rh }, units: { s0x, s0y, w0x, w0y, d0: d[0], d1: d[1] } };
  }
  return { build, stats, groundTile };
}
