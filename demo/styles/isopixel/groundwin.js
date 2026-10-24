// The close ground of the planet anywhere: a window of 256 by 256 cells (the play area's size, 19.2 km) laid on the planet's finest tier
// at the camera, made of its ground tiles (bake.ts GROUNDTILE_FIELDS: every field the painter and the scatter read, in a halo of 8 round
// each tile of 256 cells). The tiles are streamed (the window's cells come from up to four of them, and across a cube's edge from the
// face across, laid flat by the grid's own rule, src/gpu/globe/patch.ts cellAcross), the window's fine ground is the scatter's fine kernel
// run on its cells (so a vertex is the same whichever window holds it), and what grew is each tile's own scatter (scatter.ts: the same
// objects every visit) cut to the window. The window is the island's ground in everything the painter and the renderer read, and in
// its frame: x along the face's X axis, z against its Y (north-up as the planet is seen from above, not mirrored), metres of 75 m a cell.
import { CELL, N } from "../island.js";
import { packGround } from "./ground.wgsl.js";
import { fetchTileBytes } from "./tilecache.js";

const S = N + 16, H = 8, UNITS = 5000;
const TYPES = { i8: Int8Array, u8: Uint8Array, i16: Int16Array, u16: Uint16Array, i32: Int32Array, u32: Uint32Array, f32: Float32Array };
const DIRS = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];
const D2R = Math.PI / 180;
// the sizes the window's object buffer comes in, so its pipelines are made once for each [design: a body is 28 bytes a slot, 235 MB at the top]
const CAPS = [1 << 20, 1 << 21, 1 << 22, 1 << 23];
// The blocks a window's objects can come in (cells a side, and the sizes of body a block comes in)
export const BLOCK = 64, BLOCK_CAPS = [1 << 17, 1 << 18, 1 << 19, 1 << 20, 1 << 21], BLOCK_TOTAL = 11e6, RING_OUT = 3;
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
export function createWindows({ G, T, gpu, base, tier, seed, radiusM, quick, keep = 6, top = CAPS[CAPS.length - 1], paged = true }) {
  const g = G.tierGrid(tier), fn = g.fn, nT = 2 ** tier, tiles = new Map();
  // the window's kernels compile on the GPU process's own threads from the start, so no window stops the frames to compile one
  const warming = T.warmWindow(gpu);
  const tileKey = (f, tx, ty) => (f * nT + ty) * nT + tx;
  // a ground tile, fetched and kept (the least lately used going when `keep` are held)
  async function groundTile(f, tx, ty) {
    const k = tileKey(f, tx, ty);
    let t = tiles.get(k);
    if (!t) {
      t = fetchTileBytes(`${base}/groundtiles/f${f}/${ty}-${tx}.gt.gz`).then(({ raw, bytes }) => ({ ...decode(raw), bytes }));
      tiles.set(k, t);
      stats.tiles++;
    } else { tiles.delete(k); tiles.set(k, t); }
    while (tiles.size > keep + 2) { const old = tiles.keys().next().value; tiles.delete(old); }
    const r = await t;
    stats.bytes += r.bytes; r.bytes = 0;
    return r;
  }
  const stats = { tiles: 0, bytes: 0, builds: 0, ms: {} };

  // ---------- the ground as pages (demo/tile.ts groundPages) ----------
  // The planet's ground is made in pages of 64 cells, the same ground whichever window holds a page, kept in the slots of one atlas (the painter's page textures hold SLOTS of them); a window is its
  // 16 pages at a corner that is a multiple of a page, so a window that overlaps another makes only the pages it does not share. A page held is not made again; when a window needs a slot and
  // none is free the page least lately used goes, never one of the windows being made or drawn (`pins`), and a window whose page was let go makes it again when it is drawn (it keeps its cells' planes,
  // `src`). `texHeld` is the page each slot of the painter's own textures holds, so a page is copied into them only when it is not there.
  const PAGE = 64, SLOTS = 32, MV = 1021, pages = new Map(), texHeld = new Array(SLOTS).fill(null), pins = new Set();
  let atlas = null, usedAt = 0, drawn = null;
  const pageKey = (face, px, py) => `${face}:${px}:${py}`;
  const pagesOf = (w) => { const out = []; for (let iy = 0; iy < 4; iy++) for (let ix = 0; ix < 4; ix++) out.push({ ix, iy, px: w.x0 + PAGE * ix, py: w.y0 + PAGE * iy, key: pageKey(w.face, w.x0 + PAGE * ix, w.y0 + PAGE * iy) }); return out; };
  // The window's 16 pages are in slots and made. Returns how many were made.
  async function ensurePages(w) {
    atlas ??= T.pageAtlas(gpu, SLOTS);
    const list = pagesOf(w), mine = new Set(list.map((p) => p.key)), pin = { mine };
    pins.add(pin);
    try {
      const stamp = ++usedAt, todo = [], taken = new Set([...pages.values()].map((r) => r.slot)), held = new Set(drawn?.pageList?.map((p) => p.key));
      for (const p of list) {
        let rec = pages.get(p.key);
        if (!rec) {
          let slot = -1;
          for (let s = 0; s < SLOTS && slot < 0; s++) if (!taken.has(s)) slot = s;
          if (slot < 0) {
            // the page least lately used that no window being made or drawn holds
            let old = null;
            for (const r of pages.values()) if (!held.has(r.key) && ![...pins].some((q) => q.mine.has(r.key)) && (!old || r.used < old.used)) old = r;
            if (!old) throw new Error("pages: every slot is held by a window being made or drawn");
            pages.delete(old.key); slot = old.slot;
          }
          taken.add(slot);
          rec = { key: p.key, face: w.face, px: p.px, py: p.py, slot, h: null, used: stamp };
          pages.set(p.key, rec); todo.push(rec);
        }
        rec.used = stamp;
        p.rec = rec;
      }
      if (todo.length) {
        const batch = (async () => {
          const ps = T.pageSource(gpu, w.src, w.face, w.x0, w.y0);
          // two pages a submit, each waited for, so the frames the renderer draws meanwhile are not held back by the whole window's work (a page is about 5 ms of the GPU)
          for (let i = 0; i < todo.length; i += 2) {
            T.groundPages(gpu, atlas, ps, todo.slice(i, i + 2).map((r) => ({ px: r.px, py: r.py, slot: r.slot })));
            await gpu.device.queue.onSubmittedWorkDone();
          }
          const hs = await T.pageHeights(gpu, atlas, todo.map((r) => r.slot));
          todo.forEach((r, i) => { r.h = hs[i]; });
          ps.destroy();
        })();
        batch.catch(() => { for (const r of todo) if (pages.get(r.key) === r) pages.delete(r.key); });
        for (const r of todo) r.ready = batch;
      }
      await Promise.all(list.map((p) => p.rec.ready));
      w.pageList = list;
      return todo.length;
    } finally { pins.delete(pin); }
  }
  // The window's pages as setGroundPages takes them (corner from the window's, slot, whether the painter's textures must be given the page), made first when any has gone.
  async function pageSet(w) {
    await ensurePages(w);
    return w.pageList.map((p) => {
      const copy = texHeld[p.rec.slot] !== p.key;
      texHeld[p.rec.slot] = p.key;
      return { ox: p.px - w.x0, oy: p.py - w.y0, slot: p.rec.slot, copy };
    });
  }
  // the window's heights as the camera takes them (1,021 vertices a side, rows south) from its pages' own: vertex v of an axis is the page min((v + 2) / 256, 3)'s at v + 2 - 256 page
  function heightsOf(list) {
    const h = new Float32Array(MV * MV), at = (ix, iy) => list[iy * 4 + ix].rec.h;
    for (let vy = 0; vy < MV; vy++) {
      const wy = vy + 2, jr = Math.min(wy >> 8, 3), cy = wy - 256 * jr;
      for (let vx = 0; vx < MV; vx++) { const wx = vx + 2, ix = Math.min(wx >> 8, 3); h[vy * MV + vx] = at(ix, 3 - jr)[cy * 257 + wx - 256 * ix]; }
    }
    return h;
  }

  // The window of 4 by 4 pages whose centre is nearest the cell holding (lat, lon) degrees (its corner a multiple of a page). Returns what the renderer, the page and the object buffer take.
  async function build(lat, lon) {
    await warming;
    const t0 = performance.now(), loc = G.locateVec(g, G.fromLatLon(lat * D2R, lon * D2R)), face = loc.face, x0 = Math.round((loc.X - N / 2) / PAGE) * PAGE, y0 = Math.round((loc.Y - N / 2) / PAGE) * PAGE;
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
    const wp = { face, x0, y0, src };
    wp.made = paged ? await ensurePages(wp) : 0;
    const t2 = performance.now();

    // ---------- what grew: each tile's own scatter, put in the window's frame, thinned and binned into the renderer's body on the GPU, nothing read back ----------
    // started by the caller (startObjects) once the ground is out, so the page has the ground without waiting on the objects' CPU work; its promise is `w.objects`
    // Where the window's objects come from when they are made by block (makeBlocks): the tiles its cells lie on. A tile of another cube face than the window's carries `at`, its shift and
    // quarter turn into the window's frame (placer), which lays its blocks in the window's frame; null when such a tile's turn is not known, which the whole window's objects serve.
    const inner = tl.filter((t) => t.interior);
    const planTiles = inner.map((t) => ({ tile: t.f * nT * nT + t.ty * nT + t.tx, tx: t.tx, ty: t.ty, gt: t.gt, at: t.f === face ? null : placer(t, face, x0, y0, srcF, srcX, srcY, turn) }));
    const blockPlan = inner.every((t, i) => t.f === face || planTiles[i].at) ? { face, x0, y0, tiles: planTiles } : null;
    const startObjects = () => {
      const placed = [], tStart = performance.now();
      for (const t of tl) {
        if (!t.interior) continue;
        const at = placer(t, face, x0, y0, srcF, srcX, srcY, turn);
        if (!at || at.rect.w <= 0 || at.rect.h <= 0) continue;
        // only the cells of the tile the window touches are made (the objects' ids in the tile's whole run are the same either way)
        placed.push({ tile: t.f * nT * nT + t.ty * nT + t.tx, source: T.tileSource(t.gt), rect: at.rect, a0: t.tx * 256 * UNITS, a1: t.ty * 256 * UNITS, ...at.units });
      }
      return (w.objects = T.windowObjects(gpu, tier, placed, seed, { caps: CAPS.filter((c) => c <= top), side: N }).then((o) => ({ ...o, ms: performance.now() - tStart })));
    };

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
    // the window's ground is its pages (ensurePages), given to the painter by setGroundPages, the camera's heights the pages' own and the highest ground theirs; with `pages` off the ground is made whole as windowGround makes it
    // and given by setGround (a check against the pages). Only the streams are binned here, z turned.
    let h, ground;
    if (paged) {
      h = heightsOf(wp.pageList);
    } else {
      ground = await T.windowGround(gpu, src, face, x0, y0);
      h = ground.h;
    }
    let highest = -Infinity;
    for (const v of h) if (v > highest) highest = v;
    const rivers = T.windowRivers(src).map((line) => line.map((p) => [p[0], -p[1], ...p.slice(2)]));
    const pack = packGround(isle, { rivers }, paged ? { fine: null, grid: null, mask: null, top: highest + 2, finePitch: 0, fineLayerWords: 0, gridPitch: 0, gridLayerWords: 0 } : { fine: ground.fine, grid: ground.grid, mask: ground.mask, top: ground.top, finePitch: ground.finePitch, fineLayerWords: ground.fineLayerWords, gridPitch: ground.gridPitch, gridLayerWords: ground.gridLayerWords });
    const t3 = performance.now();
    let peak = 0;
    for (const v of height) peak = Math.max(peak, v);

    // ---------- where the window stands on the sphere ----------
    const pc = (fx, fy) => G.pointOf(face, Math.tan(((x0 + fx) / fn - 0.5) * (Math.PI / 2)), Math.tan(((y0 + fy) / fn - 0.5) * (Math.PI / 2)));
    const c = pc(N / 2, N / 2), pe = pc(N / 2 + 1, N / 2), pn = pc(N / 2, N / 2 + 1);
    const along = (a) => { const d = dot(a, c); return unit([a[0] - c[0] * d, a[1] - c[1] * d, a[2] - c[2] * d]); };
    const e = along(pe), n0 = along(pn), dn = dot(n0, e), n = unit([n0[0] - e[0] * dn, n0[1] - e[1] * dn, n0[2] - e[2] * dn]);
    const arc = (a, b) => 2 * Math.atan2(Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]), Math.hypot(a[0] + b[0], a[1] + b[1], a[2] + b[2])) * radiusM;
    const scale = Math.sqrt(arc(c, pe) * arc(c, pn)) / CELL;
    const [E, Nn] = G.eastNorth(c);
    stats.builds++;
    stats.ms = { tiles: t1 - t0, fine: t2 - t1, pack: t3 - t2, total: t3 - t0 };
    const w = {
      id: `${face}:${x0}:${y0}`, face, x0, y0, c, e, n, scale, rot: [dot(e, E), dot(e, Nn), dot(n, E), dot(n, Nn)],
      src, paged, pageList: wp.pageList, lat: G.latLon(c).lat / D2R, lon: G.latLon(c).lon / D2R, pack, blockPlan, startObjects, objects: null, fields: { peak, h, height, water }, stats: { ...stats, ms: stats.ms, made: wp.made },
    };
    return w;
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
  // The window's objects as blocks of 64 cells of its tiles, each its own source in its own frame (wgsl/objects.js srcOc): `cache` (key to record) holds those made already, so a window
  // over tiles another covered makes only what is new. One run of each tile's scatter serves all its blocks. One level of detail across the screen (plan R6): `view` is the camera's place in
  // the window's cells (x east, z south from its north-west corner) and ext the viewport's farthest ground from it, in cells; every block the viewport grown by a prefetch margin can touch (vis)
  // is made and drawn at one share 2^-k0, the largest that keeps the window's blocks in BLOCK_TOTAL objects whatever the camera's place (the most vis blocks the view can hold, at the
  // densest they stand, plus the others RING_OUT steps thinner) and each in the largest body; only blocks past the margin are thinner (RING_OUT). A record made at a share as dense as wanted or
  // denser serves (it draws the thinner share, the sources' third word, kd); a thinner one is made again. The vis blocks are made first and `stage(recs, kds)` called with only them, so no
  // block of the screen is drawn at another share than the rest. Returns { recs, kds, fresh, k, k0, vis, n, estimate }, or null.
  const estOf = new Map();
  function layoutBlocks(w, view) {
    const { face, x0, y0, tiles: ts } = w.blockPlan, r = 1.5 * view.ext + 16, need = [];
    for (const t of ts)
      for (let by = 0; by < 256 / BLOCK; by++)
        for (let bx = 0; bx < 256 / BLOCK; bx++) {
          // the block's square in the window's cells (x east, y north from its south-west corner): the tile's own cells for a tile of the window's face, else their quarter turn, from the
          // corners by the place kernel's transform (wgsl/terrain-place.ts). X, Y are that corner in the window's face's cells, extended past the cube's edge: the same whichever window holds it.
          let cx = t.tx * 256 + bx * BLOCK - x0, cy = t.ty * 256 + by * BLOCK - y0, turn;
          if (t.at) {
            const u = t.at.units, ax = t.tx * 256 * UNITS, ay = t.ty * 256 * UNITS;
            let mx = Infinity, my = Infinity;
            for (const fx of [ax + bx * BLOCK * UNITS, ax + (bx + 1) * BLOCK * UNITS])
              for (const fy of [ay + by * BLOCK * UNITS, ay + (by + 1) * BLOCK * UNITS]) {
                mx = Math.min(mx, u.d0 * (fx - u.s0x) + u.d1 * (fy - u.s0y) + u.w0x);
                my = Math.min(my, -u.d1 * (fx - u.s0x) + u.d0 * (fy - u.s0y) + u.w0y);
              }
            cx = Math.round(mx / UNITS); cy = Math.round(my / UNITS);
            turn = { ...u, cx, cy };
          }
          if (!(cx + BLOCK > 0 && cx < N && cy + BLOCK > 0 && cy < N)) continue;
          const X = x0 + cx, Y = y0 + cy, c0 = cx, z0 = N - cy - BLOCK;
          need.push({ t, bx, by, X, Y, turn, key: `${t.tile}:${bx}:${by}${t.at ? `@${face}` : ""}`, vis: c0 + BLOCK > view.x - r && c0 < view.x + r && z0 + BLOCK > view.z - r && z0 < view.z + r, d: Math.hypot(c0 + BLOCK / 2 - view.x, z0 + BLOCK / 2 - view.z) });
        }
    need.sort((a, b) => b.vis - a.vis || a.d - b.d);
    // null until every block's estimate is known (the first time a block is met, its tile's run gives it)
    const k0Of = () => {
      if (!need.every((b) => estOf.has(b.key))) return null;
      const m = Math.min(need.length, (Math.ceil((2 * r) / BLOCK) + 1) ** 2), e = need.map((b) => estOf.get(b.key)).sort((a, b) => b - a), most = BLOCK_CAPS[BLOCK_CAPS.length - 1] * 0.92;
      const top = e.slice(0, m).reduce((a, b) => a + b, 0), rest = e.slice(m).reduce((a, b) => a + b, 0);
      let k = 0;
      while (top / 2 ** k + rest / 2 ** (k + RING_OUT) > BLOCK_TOTAL || e[0] / 2 ** k > most) k++;
      return k;
    };
    return { need, k0Of };
  }
  async function makeBlocks(w, cache, view = { x: N / 2, z: N / 2, ext: N }, stage = null) {
    const plan = w.blockPlan;
    if (!plan) return null;
    const { need, k0Of } = layoutBlocks(w, view);
    let k0 = k0Of();
    const kOf = (r) => k0 + (r.vis ? 0 : RING_OUT);
    // the runs of the tiles with blocks to make (all of them, the first time, for the estimates)
    const todoOf = () => need.filter((r) => { const b = cache.get(r.key); return !b || b.k > kOf(r); });
    const open = k0 === null ? need : todoOf();
    // the runs of the tiles the blocks `recs` stand on, each over the cells its blocks cover
    const openFor = (recs) => {
      const byTile = new Map();
      for (const r of recs) { if (!byTile.has(r.t.tile)) byTile.set(r.t.tile, { t: r.t, rec: [] }); byTile.get(r.t.tile).rec.push(r); }
      return Promise.all([...byTile.values()].map(async ({ t, rec }) => {
        const lo = (v) => Math.max(0, Math.min(...rec.map(v)) * BLOCK - 1), hi = (v) => Math.min(256, (Math.max(...rec.map(v)) + 1) * BLOCK + 1);
        const rx = lo((r) => r.bx), ry = lo((r) => r.by), rect = { x0: rx, y0: ry, w: hi((r) => r.bx) - rx, h: hi((r) => r.by) - ry };
        const run = await T.openTile(gpu, tier, { tile: t.tile, source: T.tileSource(t.gt), rect, a0: t.tx * 256 * UNITS, a1: t.ty * 256 * UNITS, s0x: 0, s0y: 0, w0x: 0, w0y: 0, d0: 1, d1: 0 }, seed, { caps: BLOCK_CAPS });
        return { t, rec, run };
      }));
    };
    const opened = await openFor(open);
    try {
      for (const { rec, run } of opened) for (const r of rec) { r.run = run; if (!estOf.has(r.key)) estOf.set(r.key, run.est({ bx0: r.bx * BLOCK, by0: r.by * BLOCK, n: BLOCK })); }
      if (k0 === null) k0 = k0Of();
      const total = need.reduce((a, r) => a + estOf.get(r.key), 0);
      need.forEach((r) => { r.k = kOf(r); });
      const recs = [], fresh = [], kds = new Map();
      // `held`: the record of every block this call draws, as found in the cache or made here (another window's call may sweep or replace a cache entry while this one awaits)
      const held = new Map();
      const make = async (list) => {
        const todo = [];
        for (const r of list) { const b = cache.get(r.key); if (b && b.k <= r.k) held.set(r.key, b); else todo.push(r); }
        // a block that was not todo when the runs were opened (its cache entry has gone since) gets a run of its own tile here
        const late = await openFor(todo.filter((r) => !r.run));
        try {
          for (const { rec, run } of late) for (const r of rec) r.run = run;
          const got = await Promise.all([...new Set(todo.map((r) => r.run))].map(async (run) => {
            const mine = todo.filter((r) => r.run === run);
            const o = await run.makeMany(mine.map((r) => ({ bx0: r.bx * BLOCK, by0: r.by * BLOCK, n: BLOCK, k: r.k, turn: r.turn })));
            return mine.map((r, i) => ({ r, o: o[i] }));
          }));
          for (const { r, o } of got.flat()) {
            const b = { key: r.key, k: r.k, cap: o.cap, n: o.n, body: o.body, start: o.start, face: plan.face, X: r.X, Y: r.Y };
            cache.set(r.key, b);
            held.set(r.key, b);
            fresh.push(b);
          }
        } finally { for (const { run } of late) run.close(); }
      };
      const collect = (list) => { const out = []; for (const r of list) { const b = held.get(r.key); out.push(b); kds.set(r.key, Math.max(0, r.k - b.k)); } return out; };
      const vis = need.filter((r) => r.vis), out = need.filter((r) => !r.vis);
      await make(vis);
      if (stage && out.length) stage(collect(vis), kds, k0);
      await make(out);
      const all = collect(need);
      let kept = 0;
      for (const b of all) kept += b.n;
      return { recs: all, kds, fresh, k: total > 0 ? -Math.log2(Math.max(1e-9, kept / total)) : 0, k0, vis: new Set(vis.map((r) => r.key)), n: kept, estimate: total };
    } finally { for (const { run } of opened) run.close(); }
  }
  // the blocks the view can touch and the share they are drawn at, for the worker to see whether the blocks it holds still serve (null k0: a block's estimate is not known yet)
  const blocksNeed = (w, view) => { const { need, k0Of } = layoutBlocks(w, view); return { vis: need.filter((r) => r.vis).map((r) => r.key), k0: k0Of() }; };
  // pageSet: the window's pages for setGroundPages (made again where one was let go); atlas: the buffers they are in; setDrawn: the window drawn, whose pages are kept
  return { build, stats, groundTile, makeBlocks, blocksNeed, pageSet, get atlas() { return atlas; }, setDrawn: (w) => { drawn = w; } };
}
