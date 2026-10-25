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
export function createWindows({ G, T, gpu, base, tier, seed, radiusM, quick, keep = 6, onBlockLost = null, put = null }) {
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
      t.catch(() => { if (tiles.get(k) === t) tiles.delete(k); });
      stats.tiles++;
    } else { tiles.delete(k); tiles.set(k, t); }
    while (tiles.size > keep + 2) { const old = tiles.keys().next().value; tiles.delete(old); }
    const r = await t;
    stats.bytes += r.bytes; r.bytes = 0;
    return r;
  }
  const stats = { tiles: 0, bytes: 0, builds: 0, ms: {} };

  // ---------- the ground as pages (demo/tile.ts groundPages) ----------
  // The planet's ground is made in pages of 64 cells, the same ground whichever window holds a page, kept in the slots of the painter's page textures (SLOTS of them, `put` writes them); a window is its
  // 16 pages at a corner that is a multiple of a page, so a window that overlaps another makes only the pages it does not share. A page held is not made again; when a window needs a slot and
  // none is free the page least lately used goes, never one of the windows being made or drawn (`pins`), and a window whose page was let go makes it again when it is drawn (it keeps its cells' planes,
  // `src`). A page is made in one of STAGE slots of a small atlas of buffers, its heights read, and copied at once into its own slot of the textures, so the buffers cost STAGE pages, not SLOTS.
  const PAGE = 64, SLOTS = 48, STAGE = 8, SQUARE = 6, MV = 1021, pages = new Map(), pins = new Set();
  let atlas = null, usedAt = 0, drawn = null, blockKeys = new Set();
  // a page the planet pass's block holds is let go: the block is told to go (its slot may be another page's), the caller makes it again
  const lose = (key) => { if (blockKeys.has(key)) { blockKeys = new Set(); onBlockLost?.(); } };
  const pageKey = (face, px, py) => `${face}:${px}:${py}`;
  const pagesOf = (w) => { const out = []; for (let iy = 0; iy < 4; iy++) for (let ix = 0; ix < 4; ix++) out.push({ ix, iy, px: w.x0 + PAGE * ix, py: w.y0 + PAGE * iy, key: pageKey(w.face, w.x0 + PAGE * ix, w.y0 + PAGE * iy) }); return out; };
  // The pages `recs` (each { key, px, py, slot, h }) made from the page source `ps`, STAGE at a time in the staging atlas: two pages a submit with the GPU waited on between, so the frames the renderer draws meanwhile are not held
  // back by the whole window's work (a page is about 5 ms of the GPU), then the stage's heights read (the camera's) and its pages copied into their slots of the painter's textures before the stage is used again. The stage is
  // one set of buffers, so one chunk at a time is made in it (`stage`); a page that has lost its slot to another meanwhile (it is no longer the one `pages` holds) is not copied, and the ring's pages (`ring`) wait while a window is being made.
  let stage = Promise.resolve(), winBusy = 0;
  async function makeInto(recs, ps, ring = false) {
    for (let i = 0; i < recs.length; i += STAGE) {
      while (ring && winBusy > 0) await new Promise((r) => setTimeout(r, 30));
      const run = async () => {
        const chunk = recs.slice(i, i + STAGE).filter((r) => pages.get(r.key) === r);
        if (!chunk.length) return;
        for (let j = 0; j < chunk.length; j += 2) {
          T.groundPages(gpu, atlas, ps, chunk.slice(j, j + 2).map((r, k) => ({ px: r.px, py: r.py, slot: j + k })));
          await gpu.device.queue.onSubmittedWorkDone();
        }
        const hs = await T.pageHeights(gpu, atlas, chunk.map((_, j) => j));
        chunk.forEach((r, j) => { r.h = hs[j]; });
        const own = chunk.map((r, j) => ({ r, from: j })).filter(({ r }) => pages.get(r.key) === r);
        await put(atlas, own.map(({ r, from }) => ({ from, to: r.slot })), SLOTS);
      };
      const next = stage.then(run);
      stage = next.catch(() => {});
      await next;
    }
  }
  // The window's 16 pages are in slots and made. Returns how many were made.
  async function ensurePages(w) {
    atlas ??= T.pageAtlas(gpu, STAGE);
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
            lose(old.key); pages.delete(old.key); slot = old.slot;
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
          winBusy++;
          try { await makeInto(todo, ps); } finally { winBusy--; }
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
  // The window's pages as setGroundPages takes them (corner from the window's, slot), made first when any has gone. They are in the textures already (made into them), so none is to be copied.
  async function pageSet(w) {
    await ensurePages(w);
    return w.pageList.map((p) => ({ ox: p.px - w.x0, oy: p.py - w.y0, slot: p.rec.slot, copy: false }));
  }
  // where a unit vector lies on the top tier's grid: its face and its cells there (x, y, as a window's x0 and y0 are)
  function cellOf(v) {
    let face = 0, best = -Infinity;
    for (let k = 0; k < 6; k++) { const d = v[0] * G.FRAMES[k].n[0] + v[1] * G.FRAMES[k].n[1] + v[2] * G.FRAMES[k].n[2]; if (d > best) { best = d; face = k; } }
    const F = G.FRAMES[face], at = (e) => (Math.atan((v[0] * e[0] + v[1] * e[1] + v[2] * e[2]) / best) / (Math.PI / 2) + 0.5) * fn;
    return { face, x: at(F.ex), y: at(F.ey) };
  }
  // The pages round a window's, for the planet pass alone (planet.js opts.pages.block): a SQUARE by SQUARE square of pages centred on the window's 16 (the window's own are those made for it, so the ladder's ground is as it was). The ring
  // round them is made from sources of the same 256 cells the window is made from, at most four, each page from the one whose middle is nearest it, two pages a submit with the GPU waited on between as ensurePages does,
  // and kept in the textures with the rest (a page is global: a window that needs one finds it, a block that moves makes only the new edge). The block is for the renderer's
  // setBlockPages: table[row * n + column] the slot of the page, row 0 the northmost (the window's rows run south) and -1 for a page off its face. Returns { block }.
  const ensureBlock = (w) => ensureBlockAt(w.face, w.x0 - ((SQUARE - N / PAGE) / 2) * PAGE, w.y0 - ((SQUARE - N / PAGE) / 2) * PAGE, w);
  // The same for a block whose first page is at (bx, by) cells of a face, with no window held (or w, the window drawn, whose own pages are held while the ring is made)
  async function ensureBlockAt(face, bx, by, w = null) {
    atlas ??= T.pageAtlas(gpu, STAGE);
    const n = SQUARE, list = [];
    for (let iy = 0; iy < n; iy++)
      for (let ix = 0; ix < n; ix++) {
        const px = bx + ix * PAGE, py = by + iy * PAGE;
        list.push({ ix, iy, px, py, key: pageKey(face, px, py), inside: px >= 0 && py >= 0 && px + PAGE <= fn && py + PAGE <= fn });
      }
    // only the window's own 16 are held while the ring is made: a ring page is let go to any window that needs the slot (it is then not in the table, and the pages that are get no copy from a made page that has lost its slot)
    const pin = { mine: new Set(w ? pagesOf(w).map((p) => p.key) : []) };
    pins.add(pin);
    try {
      const stamp = ++usedAt, taken = new Set([...pages.values()].map((r) => r.slot)), held = new Set(drawn?.pageList?.map((p) => p.key)), todo = [];
      for (const p of list) {
        if (!p.inside) continue;
        let rec = pages.get(p.key);
        if (!rec) {
          let slot = -1;
          for (let s = 0; s < SLOTS && slot < 0; s++) if (!taken.has(s)) slot = s;
          if (slot < 0) {
            let old = null;
            for (const r of pages.values()) if (!held.has(r.key) && ![...pins].some((q) => q.mine.has(r.key)) && (!old || r.used < old.used)) old = r;
            if (!old) continue;
            lose(old.key); pages.delete(old.key); slot = old.slot;
          }
          taken.add(slot);
          rec = { key: p.key, face, px: p.px, py: p.py, slot, h: null, used: stamp };
          pages.set(p.key, rec); todo.push({ rec, p });
        }
        rec.used = stamp;
        p.rec = rec;
      }
      // the sources: a window of N cells at the block's corner and at half a window across, each page from the one whose middle is nearest its own
      const bySrc = new Map();
      for (const t of todo) {
        const sx = bx + (t.p.ix <= 2 ? 0 : N / 2), sy = by + (t.p.iy <= 2 ? 0 : N / 2);
        if (!bySrc.has(`${sx}:${sy}`)) bySrc.set(`${sx}:${sy}`, { sx, sy, list: [] });
        bySrc.get(`${sx}:${sy}`).list.push(t.rec);
      }
      const batch = (async () => {
        for (const { sx, sy, list: recs } of bySrc.values()) {
          const { src } = await gather(face, sx, sy), ps = T.pageSource(gpu, src, face, sx, sy);
          await makeInto(recs, ps, true);
          ps.destroy();
        }
      })();
      batch.catch(() => { for (const t of todo) if (pages.get(t.rec.key) === t.rec) pages.delete(t.rec.key); });
      for (const t of todo) t.rec.ready = batch;
      await Promise.all(list.filter((p) => p.rec).map((p) => p.rec.ready));
      const table = new Int32Array(n * n).fill(-1), kept = list.filter((p) => p.inside && p.rec && pages.get(p.key) === p.rec);
      for (const p of kept) table[(n - 1 - p.iy) * n + p.ix] = p.rec.slot;
      blockKeys = new Set(kept.map((p) => p.key));
      return { block: { face, x0: bx, y0: by, n, table } };
    } finally { pins.delete(pin); }
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

  // Where every cell of a window of N cells at (x0, y0) of `face`, and the halo round it, comes from, and its cells' planes in the window's frame, and the tile source the page kernels read them from. The tiles of the
  // face that its cells lie on hold them, and the 8 cells of halo each holds past its edge (laid flat across a cube's edge in the face's own axes), so a cell is read from them in the window's own frame;
  // a cell farther past a cube's edge is the face across's: the cell of the tier that stands there, from the tile that holds it. At a cube's corner the flat lattice has a wedge past both edges where no cell of the
  // planet stands: its ground (heights blended, the rest from the nearer side) is what each side would continue with (patch.ts cornerCells), so the window's shadows and folds meet no wall there. A wedge
  // cell is no cell of the window's objects (no tile of it is `interior`) and has no channel.
  async function gather(face, x0, y0) {
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
    const wedge = [];
    for (let j = 0; j < S; j++)
      for (let i = 0; i < S; i++) {
        const k = j * S + i, Xw = x0 - H + i, Yw = y0 - H + j, inner = i >= H && i < H + N && j >= H && j < H + N;
        if ((Xw < 0 || Xw >= fn) && (Yw < 0 || Yw >= fn)) {
          const c = G.cornerCells({ fn }, face, Xw, Yw), src = (id) => { const f = Math.floor(id / (fn * fn)), r = id % (fn * fn), yy = Math.floor(r / fn), xx = r % fn; return [add(f, xx >> 8, yy >> 8, false), (yy - (yy >> 8) * 256 + H) * S + (xx - (xx >> 8) * 256 + H)]; };
          if (c) wedge.push({ k, a: src(c.a), b: src(c.b), t: c.t });
          continue;
        }
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
    // the window's cells come from its tiles in runs of consecutive cells (a row of one tile), copied by the engine a run at a time: a plane of a cell is a megamorphic typed array access over seven array types
    const runs = [];
    for (let k = 0; k < S * S;) {
      const q = own[k];
      if (q < 0) { k++; continue; }
      let e = k + 1;
      while (e < S * S && own[e] === q && at[e] === at[e - 1] + 1 && (e % S) !== 0) e++;
      runs.push(k, e - k, q, at[k]);
      k = e;
    }
    for (const n of names) {
      const out = planes[n], from = tl.map((t) => t.gt.planes[n]);
      for (let r = 0; r < runs.length; r += 4) out.set(from[runs[r + 2]].subarray(runs[r + 3], runs[r + 3] + runs[r + 1]), runs[r]);
    }
    // the wedge's cells: heights between the two sides' ground by the cell's angle across the quarter turn, the other planes from the nearer side
    if (wedge.length) {
      for (const n of names) {
        const out = planes[n], from = tl.map((t) => t.gt.planes[n]), blend = n === "height";
        for (const { k, a, b, t } of wedge) {
          const va = from[a[0]][a[1]], vb = from[b[0]][b[1]];
          out[k] = blend ? Math.round(va + (vb - va) * t) : t < 0.5 ? va : vb;
        }
      }
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
    return { tl, own, at, srcF, srcX, srcY, turn, planes, src, t1 };
  }

  // The window (its id, face and corner) that build lays at (lat, lon): the page-snapped one whose centre is nearest the cell holding it
  function windowAt(lat, lon) {
    const loc = G.locateVec(g, G.fromLatLon(lat * D2R, lon * D2R)), face = loc.face, x0 = Math.round((loc.X - N / 2) / PAGE) * PAGE, y0 = Math.round((loc.Y - N / 2) / PAGE) * PAGE;
    return { id: `${face}:${x0}:${y0}`, face, x0, y0 };
  }
  // the ground tiles of the window a place falls in, asked for ahead of the window (a failure is the window's to meet when it is made)
  function prefetch(lat, lon) {
    const { face, x0, y0 } = windowAt(lat, lon);
    for (let ty = Math.max(0, Math.floor(y0 / 256)); ty <= Math.min(nT - 1, Math.floor((y0 + N - 1) / 256)); ty++)
      for (let tx = Math.max(0, Math.floor(x0 / 256)); tx <= Math.min(nT - 1, Math.floor((x0 + N - 1) / 256)); tx++) groundTile(face, tx, ty).catch(() => {});
  }
  // The window of 4 by 4 pages whose centre is nearest the cell holding (lat, lon) degrees (its corner a multiple of a page). Returns what the renderer, the page and the object buffer take.
  async function build(lat, lon) {
    await warming;
    const t0 = performance.now(), { face, x0, y0 } = windowAt(lat, lon);
    const { tl, own, at, srcF, srcX, srcY, turn, planes, src, t1 } = await gather(face, x0, y0);
    const wp = { face, x0, y0, src };
    wp.made = await ensurePages(wp);
    const t2 = performance.now();

    // ---------- what grew: each tile's own scatter, made by block (makeBlocks) once the ground is out, nothing read back ----------
    // Where the window's objects come from: the tiles its cells lie on. A tile of another cube face than the window's carries `at`, its shift and quarter turn into the window's frame (placer),
    // which lays its blocks in the window's frame; the plan is null (the window has no objects) when such a tile's turn is not known.
    const inner = tl.filter((t) => t.interior);
    const planTiles = inner.map((t) => ({ tile: t.f * nT * nT + t.ty * nT + t.tx, tx: t.tx, ty: t.ty, gt: t.gt, at: t.f === face ? null : placer(t, face, x0, y0, srcF, srcX, srcY, turn) }));
    const blockPlan = inner.every((t, i) => t.f === face || planTiles[i].at) ? { face, x0, y0, tiles: planTiles } : null;

    // ---------- the painter's inputs, rows turned so that z runs south ----------
    // a plane's cells of the window, rows turned, as float32 (the engine converts across the tiles' array types, the laws below then run over one array type)
    const flipBuf = new Float32Array(S * S);
    const flip = (src) => { flipBuf.set(src); const o = new Float32Array(N * N); for (let j = 0; j < N; j++) { const at = (H + N - 1 - j) * S + H; o.set(flipBuf.subarray(at, at + N), j * N); } return o; };
    const mul = (o, k) => { for (let i = 0; i < o.length; i++) o[i] = o[i] * k; return o; };
    const div = (o, d) => { for (let i = 0; i < o.length; i++) o[i] = o[i] / d; return o; };
    const bit = (o, m) => { for (let i = 0; i < o.length; i++) o[i] = o[i] & m ? 1 : 0; return o; };
    const pl = planes;
    const flags = pl.flags;
    const height = div(flip(pl.height), 256), water = mul(flip(pl.water), 0.01);
    const season = (name, k) => Array.from({ length: 4 }, (_, s) => (pl[`${name}${s}`] ? mul(flip(pl[`${name}${s}`]), k) : null));
    const precip = flip(pl.pr1);
    for (let i = 0; i < precip.length; i++) precip[i] = (precip[i] / 360) ** 2;
    const pet = mul(flip(pl.pe1), 0.1), snow = season("snp", 0.25);
    // the runoff by season is the tiles' own (the water stage's, per tile), weighted by the window's cells in each; the island's where no tile holds one
    const wq = [0, 0, 0, 0];
    let wn = 0;
    for (let j = H; j < H + N; j++) for (let i = H; i < H + N; i++) { const q = own[j * S + i] >= 0 && tl[own[j * S + i]].gt.meta.quick; if (q) { for (let s = 0; s < 4; s++) wq[s] += q[s]; wn++; } }
    const runoff = wn ? wq.map((v) => v / wn) : quick;
    const isle = {
      height, water, windShare: div(flip(pl.wsh), 255), rock: flip(pl.rock), table: div(flip(pl.tab), 256),
      peat: bit(flip(flags), 4), soil: div(flip(pl.soil), 1024), silt: bit(flip(flags), 1), fog: div(flip(pl.fog), 255),
      seasons: [0, 1, 2, 3].map((s) => ({ precip: s === 1 ? precip : null, pet: s === 1 ? pet : null, snowpack: snow[s] })), quick: runoff,
    };
    // the window's ground is its pages (ensurePages), given to the painter by setGroundPages, the camera's heights the pages' own and the highest ground theirs. Only the streams are binned here, z turned.
    const h = heightsOf(wp.pageList);
    let highest = -Infinity;
    for (const v of h) if (v > highest) highest = v;
    const rivers = T.windowRivers(src).map((line) => line.map((p) => [p[0], -p[1], ...p.slice(2)]));
    const pack = packGround(isle, { rivers }, { fine: null, grid: null, mask: null, top: highest + 2, finePitch: 0, fineLayerWords: 0, gridPitch: 0, gridLayerWords: 0 });
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
      src, pageList: wp.pageList, lat: G.latLon(c).lat / D2R, lon: G.latLon(c).lon / D2R, pack, blockPlan, fields: { peak, h, height, water }, stats: { ...stats, ms: stats.ms, made: wp.made },
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
  // A buffer the device cannot allocate is an invalid buffer and no exception, so a make that ran short of memory would go on to "succeed" with no objects and cache an empty block: the scope turns it into an error
  // (one make runs at a time, the worker's pumpMakes, so the scopes never interleave)
  async function noOom(fn, drop) {
    const d = gpu.device;
    d.pushErrorScope("out-of-memory");
    let r, err;
    try { r = await fn(); } catch (e) { err = e; }
    const oom = await d.popErrorScope();
    if (oom) { if (r !== undefined) drop?.(r); throw Object.assign(new Error(`out of GPU memory: ${oom.message}`), { oom: true }); }
    if (err) throw err;
    return r;
  }
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
    // The densest share's exponent as a float, continuous in the view (plan R7: a share is never a step on screen): the blocks the viewport reaches (a fractional count of them, so the
    // exponent does not jump as one more row of blocks comes in) at 2^-k0 and the rest RING_OUT steps thinner hold BLOCK_TOTAL objects, and the fullest block fits the largest body with half a step to spare
    // (blocks are made half a step denser than they are drawn, madeK). null until every block's estimate is known (the first time a block is met, its tile's run gives it).
    const k0Of = () => {
      if (!need.every((b) => estOf.has(b.key))) return null;
      const mf = Math.min(need.length, (2 * r) / BLOCK + 1) ** 2 * 1, e = need.map((b) => estOf.get(b.key)).sort((a, b) => b - a), most = BLOCK_CAPS[BLOCK_CAPS.length - 1] * 0.92, m = Math.min(need.length, mf), n = Math.ceil(m);
      const sum = e.reduce((a, b) => a + b, 0), topMean = e.slice(0, n).reduce((a, b) => a + b, 0) / n, top = Math.min(sum, m * topMean), rest = sum - top;
      return Math.max(0, Math.log2((top + rest * 2 ** -RING_OUT) / BLOCK_TOTAL), Math.log2(e[0] / most) + 0.5);
    };
    return { need, k0Of };
  }
  async function makeBlocks(w, cache, view = { x: N / 2, z: N / 2, ext: N }, stage = null) {
    const plan = w.blockPlan;
    if (!plan) return null;
    const { need, k0Of } = layoutBlocks(w, view);
    let k0 = k0Of();
    // eOf: the exponent a block is drawn at (its share is 2^-e, the sources' third word as a float); madeK: the integer share it is made at, half a step denser than drawn so a zoom in
    // never waits on a remake; needK: the thinnest a held block may be (made at a share no thinner than this) to draw e
    const eOf = (r) => k0 + (r.vis ? 0 : RING_OUT), madeK = (r) => Math.max(0, Math.floor(eOf(r) - 0.5)), needK = (r) => Math.max(0, Math.floor(eOf(r) - 0.25));
    // the runs of the tiles with blocks to make (all of them, the first time, for the estimates)
    const todoOf = () => need.filter((r) => { const b = cache.get(r.key); return !b || b.k > needK(r); });
    const open = k0 === null ? need : todoOf();
    // the runs of the tiles the blocks `recs` stand on, each over the cells its blocks cover: opened one at a time (a run holds the tile's entries on the GPU, and the counting and scan of four at once are the peak of a window's make)
    const openFor = async (recs) => {
      const byTile = new Map(), got = [];
      for (const r of recs) { if (!byTile.has(r.t.tile)) byTile.set(r.t.tile, { t: r.t, rec: [] }); byTile.get(r.t.tile).rec.push(r); }
      try {
        for (const { t, rec } of byTile.values()) {
          const lo = (v) => Math.max(0, Math.min(...rec.map(v)) * BLOCK - 1), hi = (v) => Math.min(256, (Math.max(...rec.map(v)) + 1) * BLOCK + 1);
          const rx = lo((r) => r.bx), ry = lo((r) => r.by), rect = { x0: rx, y0: ry, w: hi((r) => r.bx) - rx, h: hi((r) => r.by) - ry };
          const run = await noOom(() => T.openTile(gpu, tier, { tile: t.tile, source: T.tileSource(t.gt), rect, a0: t.tx * 256 * UNITS, a1: t.ty * 256 * UNITS, s0x: 0, s0y: 0, w0x: 0, w0y: 0, d0: 1, d1: 0 }, seed, { caps: BLOCK_CAPS }), (r) => r.close());
          got.push({ t, rec, run });
        }
      } catch (err) { for (const { run } of got) run.close(); throw err; }
      return got;
    };
    const opened = await openFor(open), held = new Map(), fresh = [];
    let done = false;
    try {
      for (const { rec, run } of opened) for (const r of rec) { r.run = run; if (!estOf.has(r.key)) estOf.set(r.key, run.est({ bx0: r.bx * BLOCK, by0: r.by * BLOCK, n: BLOCK })); }
      if (k0 === null) k0 = k0Of();
      const total = need.reduce((a, r) => a + estOf.get(r.key), 0);
      need.forEach((r) => { r.k = madeK(r); });
      const kds = new Map();
      // `held`: the record of every block this call draws, as found in the cache or made here (another window's call may sweep or replace a cache entry while this one awaits), pinned against the worker's sweep
      // while it is held; a block handed out (collect) stays pinned until the worker has it in a window (unpin)
      const hold = (key, b) => { const was = held.get(key); if (was) was.pins--; b.pins = (b.pins ?? 0) + 1; held.set(key, b); };
      const make = async (list) => {
        const todo = [];
        for (const r of list) { const b = cache.get(r.key); if (b && b.k <= needK(r)) hold(r.key, b); else todo.push(r); }
        // a block that was not todo when the runs were opened (its cache entry has gone since) gets a run of its own tile here
        const late = await openFor(todo.filter((r) => !r.run));
        try {
          for (const { rec, run } of late) for (const r of rec) r.run = run;
          // a few blocks a submit: a block's stage buffer is up to 85 MB, and all of a tile's together were the peak of a make
          for (const run of new Set(todo.map((r) => r.run))) {
            const mine = todo.filter((r) => r.run === run);
            for (let i = 0; i < mine.length; i += 4) {
              const part = mine.slice(i, i + 4), o = await noOom(() => run.makeMany(part.map((r) => ({ bx0: r.bx * BLOCK, by0: r.by * BLOCK, n: BLOCK, k: r.k, turn: r.turn }))), (made) => { for (const b of made) { b.body.destroy(); b.start.destroy(); } });
              part.forEach((r, j) => {
                const b = { key: r.key, k: r.k, cap: o[j].cap, n: o[j].n, body: o[j].body, start: o[j].start, face: plan.face, X: r.X, Y: r.Y };
                cache.set(r.key, b);
                hold(r.key, b);
                fresh.push(b);
              });
            }
          }
        } finally { for (const { run } of late) run.close(); }
      };
      // the draw exponent is absolute (an object is drawn iff its hash is under 2^-e; a block made at share k holds only hashes under 2^-k, so e >= k)
      const collect = (list) => { const out = []; for (const r of list) { const b = held.get(r.key); b.pins++; b.staged = true; out.push(b); kds.set(r.key, eOf(r)); } return out; };
      const vis = need.filter((r) => r.vis), out = need.filter((r) => !r.vis);
      await make(vis);
      if (stage && out.length) stage(collect(vis), kds, k0);
      await make(out);
      const all = collect(need);
      let kept = 0;
      for (const b of all) kept += b.n;
      done = true;
      return { recs: all, kds, fresh, k: total > 0 ? -Math.log2(Math.max(1e-9, kept / total)) : 0, k0, vis: new Set(vis.map((r) => r.key)), n: kept, estimate: total };
    } finally {
      for (const { run } of opened) run.close();
      for (const b of held.values()) b.pins--;
      // a failed make lets go of the blocks it made that no window was given
      if (!done) for (const b of fresh) if (!b.staged) { b.dead = true; b.body.destroy(); b.start.destroy(); if (cache.get(b.key) === b) cache.delete(b.key); }
    }
  }
  // the blocks the view can touch and the share they are drawn at, for the worker to see whether the blocks it holds still serve (null k0: a block's estimate is not known yet)
  const blocksNeed = (w, view) => { const { need, k0Of } = layoutBlocks(w, view); return { vis: need.filter((r) => r.vis).map((r) => r.key), k0: k0Of() }; };
  // pageSet: the window's pages for setGroundPages (made again where one was let go); atlas: the buffers they are in; setDrawn: the window drawn, whose pages are kept
  return { build, windowAt, prefetch, stats, groundTile, makeBlocks, unpin: (recs) => { for (const b of recs) b.pins--; }, blocksNeed, pageSet, ensureBlock, ensureBlockAt, cellOf, get atlas() { return atlas; }, setDrawn: (w) => { drawn = w; } };
}
