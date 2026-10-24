// The objects of a window, made and laid out on the GPU without a read back of them: each of the window's tiles' scatter (scatter.ts, the same draws and ids) is put in the window's frame, thinned
// by the share, binned by cell and written into the renderer's source body (wgsl/terrain-place.ts). The share is the largest 2^-k whose entries fit `top` slots, worked out from the draws'
// counts before anything is written (a draw-time density: the entries kept at a half are kept at a whole), and raised again if the staged total came out over.
import { TILES } from "../../terrain/flora";
import { cover, dispatch, pipeline, readback, storage, uniform } from "../kernel";
import { objectsGpu, objectsWrite, type CellWindow } from "../terrain/scenery";
import { CELLS, STAGE_WORDS, placeKernel, scanKernelFor, scatterKernel } from "../wgsl/terrain-place";
import type { Gpu } from "../device";
import { keyOf, tileFields, type TileSource } from "./scatter";

// A tile of the window: its scatter's rectangle of cells, and where its objects stand in the window's frame, in units of 15 mm: out x = d0 (A0 + px - s0x) + d1 (A1 + py - s0y) + w0x,
// out y = N - (-d1 (A0 + px - s0x) + d0 (A1 + py - s0y) + w0y), (px, py) the entry's place in the tile's game tiles of 10,000 units.
export interface PlaceTile { tile: number; source: TileSource; rect: CellWindow; a0: number; a1: number; s0x: number; s0y: number; w0x: number; w0y: number; d0: number; d1: number }
export interface WindowObjects { body: GPUBuffer; start: GPUBuffer; n: number; cap: number; share: number; estimate: number }

export async function windowObjects(g: Gpu, tier: number, tiles: PlaceTile[], seed: number, o: { caps: number[]; share?: number; side?: number }): Promise<WindowObjects> {
  const ctx = { gpu: g, tier }, top = o.caps[o.caps.length - 1], side = o.side ?? 256, win = side * 5000;
  // what the draws count, tile by tile, kept on the GPU for the writes
  const held = await Promise.all(tiles.map(async (t) => {
    const f = tileFields(ctx, t.tile, t.source);
    const run = await objectsGpu(g, f.L, f.K, f.packed, f.field, seed, keyOf(t.tile), t.rect, false);
    // the entries of the game tiles the rectangle covers: the window's entries and a margin of at most a game tile round them
    let est = 0;
    for (let gy = Math.floor(t.rect.y0 / 2); gy <= Math.floor((t.rect.y0 + t.rect.h - 1) / 2); gy++)
      for (let gx = Math.floor(t.rect.x0 / 2); gx <= Math.floor((t.rect.x0 + t.rect.w - 1) / 2); gx++) est += run.start[gy * TILES + gx + 1] - run.start[gy * TILES + gx];
    return { t, f, run, est: t.rect.w > 0 && t.rect.h > 0 ? est : 0 };
  }));
  const estimate = held.reduce((a, h) => a + h.est, 0);
  let k = o.share !== undefined ? Math.round(-Math.log2(o.share)) : 0;
  if (o.share === undefined) while (estimate / 2 ** k > top * 0.92) k++;
  let stageCap = Math.min(top, Math.ceil((estimate / 2 ** k) * 1.1) + 4096);
  try {
    for (;;) {
      const stage = storage(g, stageCap * STAGE_WORDS * 4), counts = storage(g, (CELLS + 2) * 4);
      for (const { t, f, run } of held) {
        objectsWrite(g, f.L, f.K, f.packed, f.field, run);
        const span = run.to - run.from;
        if (span > 0) {
          const [gx, gy] = cover(g, span);
          const p = new Int32Array(20);
          p.set([0, span, gx, k, stageCap, 0, 0, 0, t.a0, t.a1, t.s0x, t.s0y, t.w0x, t.w0y, t.d0, t.d1, win, side]);
          const u = uniform(g, p);
          dispatch(g, pipeline(g, placeKernel, "place"), [u, ...run.out.slice(0, 5), stage, counts], [gx, gy]);
          u.destroy();
        }
        for (const b of run.out) b.destroy();
        run.out = [];
      }
      const tail = new Uint32Array(await readback(g, counts, 8, CELLS * 4)), kept = tail[0], overflow = tail[1] !== 0;
      if (overflow && stageCap < top) { stage.destroy(); counts.destroy(); stageCap = Math.min(top, stageCap * 2); continue; }
      if (overflow || kept > top) { stage.destroy(); counts.destroy(); k++; stageCap = Math.min(top, Math.ceil(kept / 2) + 4096); continue; }
      const cap = o.caps.find((c) => c >= kept && c <= top) ?? top;
      // two words after the seven columns: the source's origin in the window's frame (the renderer's readObj), 0 for a window's own
      const body = storage(g, (7 * cap + 4) * 4), start = storage(g, (side * side + 1) * 4), cur = storage(g, side * side * 4);
      dispatch(g, pipeline(g, scanKernelFor(side), "scan"), [counts, start, cur], [1]);
      if (kept > 0) {
        const [sx, sy] = cover(g, kept), u = uniform(g, new Uint32Array([kept, sx, cap, 0]));
        dispatch(g, pipeline(g, scatterKernel, "scatter"), [u, stage, cur, body], [sx, sy]);
        u.destroy();
      }
      stage.destroy(); counts.destroy(); cur.destroy();
      return { body, start, n: kept, cap, share: 2 ** -k, estimate };
    }
  } finally {
    for (const { f, run } of held) { f.packed.destroy(); f.field.destroy(); run.idx.destroy(); f.release(); for (const b of run.out) b.destroy(); }
  }
}

// the kernels this makes, for warming them
export const placeKernels: [string, string][] = [[placeKernel, "place"], [scanKernelFor(256), "scan"], [scanKernelFor(64), "scan"], [scatterKernel, "scatter"]];

// A block of a ground tile's cells made as a source of its own: bx0, by0 its corner in the tile's cells and n its cells a side; k its share's shift (2^-k) or the least that fits `top` slots.
// `turn`: for a tile of another cube face than the window's, the tile's shift and quarter turn into the window's frame (a PlaceTile's s0x ... d1, with the tile's a0, a1) and (cx, cy) the
// south-west corner, in the window's cells (x east, y north, from its south-west corner), of the square the block stands on there. The block is then made in the window's frame: its n cells
// square is the quarter turn of the tile block's, its objects are placed (x east, z south, mm from that square's north-west corner) and filed by the square's cells; which objects it holds,
// and their kind, size and seed, are the tile block's own whichever window holds it.
export type Turn = Pick<PlaceTile, "s0x" | "s0y" | "w0x" | "w0y" | "d0" | "d1"> & { cx: number; cy: number };
export interface BlockSpec { bx0: number; by0: number; n: number; k?: number; turn?: Turn }
export interface BlockObjects extends WindowObjects { bx0: number; by0: number; n_: number }

// The place kernel's transform words (s0x, s0y, w0x, w0y, d0, d1) of a block: the tile's own frame from the block's corner, or the window's from the turned block's square.
const frameOf = (tile: PlaceTile, b: BlockSpec) => b.turn
  ? [b.turn.s0x, b.turn.s0y, b.turn.w0x - b.turn.cx * 5000, b.turn.w0y - b.turn.cy * 5000, b.turn.d0, b.turn.d1]
  : [tile.a0 + b.bx0 * 5000, tile.a1 + b.by0 * 5000, 0, 0, 1, 0];

// One run of a tile's scatter over `tile.rect` (the cells the blocks asked of it cover), from which any number of blocks are made, each in its own frame (x east, z south, mm from the block's
// north-west corner; `tile.a0`, `a1` the tile's corner in units, which the blocks' frames hang from), so the tile's tables and counts are made once however many blocks there are. The same
// entries as the window's, thinned by the same hash: a block at share 2^-k holds exactly those of the window's at 2^-k that lie in it. `close` lets the run go.
export async function openTile(g: Gpu, tier: number, tile: PlaceTile, seed: number, o: { caps: number[] }) {
  const ctx = { gpu: g, tier }, top = o.caps[o.caps.length - 1], f = tileFields(ctx, tile.tile, tile.source);
  const run = await objectsGpu(g, f.L, f.K, f.packed, f.field, seed, keyOf(tile.tile), tile.rect, false);
  objectsWrite(g, f.L, f.K, f.packed, f.field, run);
  const span = run.to - run.from;
  // the draws a block holds before thinning: the game tiles its cells and a cell of margin cover
  // (w, h: a rectangle of the block's cells instead of the whole block, the part the window holds)
  const est = (b: BlockSpec & { w?: number; h?: number }) => {
    let e = 0;
    for (let gy = Math.floor(Math.max(0, b.by0 - 1) / 2); gy <= Math.floor((Math.min(256, b.by0 + (b.h ?? b.n) + 1) - 1) / 2); gy++)
      for (let gx = Math.floor(Math.max(0, b.bx0 - 1) / 2); gx <= Math.floor((Math.min(256, b.bx0 + (b.w ?? b.n) + 1) - 1) / 2); gx++) e += run.start[gy * TILES + gx + 1] - run.start[gy * TILES + gx];
    return e;
  };
  const make = async (b: BlockSpec): Promise<BlockObjects> => {
    const e = est(b);
    let k = b.k ?? 0;
    if (b.k === undefined) while (e / 2 ** k > top * 0.92) k++;
    let stageCap = Math.min(top, Math.ceil((e / 2 ** k) * 1.1) + 4096);
    const win = b.n * 5000, fr = frameOf(tile, b);
    for (;;) {
      const stage = storage(g, stageCap * STAGE_WORDS * 4), counts = storage(g, (CELLS + 2) * 4);
      if (span > 0) {
        // the entries of the game tiles the block and a cell of margin touch: a row of game tiles is a contiguous run of entries, so a dispatch a row, not the whole run for every block
        const gxLo = Math.max(0, Math.floor((b.bx0 - 1) / 2)), gxHi = Math.min(TILES - 1, Math.floor((b.bx0 + b.n) / 2)), gyLo = Math.max(0, Math.floor((b.by0 - 1) / 2)), gyHi = Math.min(TILES - 1, Math.floor((b.by0 + b.n) / 2));
        for (let gy = gyLo; gy <= gyHi; gy++) {
          const lo = run.start[gy * TILES + gxLo], hi = run.start[gy * TILES + gxHi + 1];
          if (hi <= lo) continue;
          const [gx, gy2] = cover(g, hi - lo), p = new Int32Array(20);
          // the block's corner: x west, y at its south edge (the frame's z runs south from the north edge)
          p.set([lo - run.from, hi - run.from, gx, k, stageCap, 0, 0, 0, tile.a0, tile.a1, ...fr, win, b.n]);
          const u = uniform(g, p);
          dispatch(g, pipeline(g, placeKernel, "place"), [u, ...run.out.slice(0, 5), stage, counts], [gx, gy2]);
          u.destroy();
        }
      }
      const tail = new Uint32Array(await readback(g, counts, 8, CELLS * 4)), kept = tail[0], overflow = tail[1] !== 0;
      if (overflow && stageCap < top) { stage.destroy(); counts.destroy(); stageCap = Math.min(top, stageCap * 2); continue; }
      if (overflow || kept > top) { stage.destroy(); counts.destroy(); k++; stageCap = Math.min(top, Math.ceil(kept / 2) + 4096); continue; }
      const cap = o.caps.find((c) => c >= kept && c <= top) ?? top;
      const body = storage(g, (7 * cap + 4) * 4), start = storage(g, (b.n * b.n + 1) * 4), cur = storage(g, b.n * b.n * 4);
      dispatch(g, pipeline(g, scanKernelFor(b.n), "scan"), [counts, start, cur], [1]);
      if (kept > 0) {
        const [sx, sy] = cover(g, kept), u = uniform(g, new Uint32Array([kept, sx, cap, 0]));
        dispatch(g, pipeline(g, scatterKernel, "scatter"), [u, stage, cur, body], [sx, sy]);
        u.destroy();
      }
      stage.destroy(); counts.destroy(); cur.destroy();
      return { body, start, n: kept, cap, share: 2 ** -k, estimate: e, bx0: b.bx0, by0: b.by0, n_: b.n };
    }
  };
  // Several blocks together: every block's places in one submit, the staged totals of all of them in one read back, then every scan and scatter in one submit. A block whose stage came out
  // too small or whose entries overflow its largest body is made again alone (make), which raises its share as the window's rule does.
  const makeMany = async (specs: BlockSpec[]): Promise<BlockObjects[]> => {
    const ks = specs.map((b) => { const e = est(b); let k = b.k ?? 0; if (b.k === undefined) while (e / 2 ** k > top * 0.92) k++; return { e, k }; });
    const stages = specs.map((b, i) => storage(g, Math.min(top, Math.ceil((ks[i].e / 2 ** ks[i].k) * 1.1) + 4096) * STAGE_WORDS * 4)), counts = specs.map(() => storage(g, (CELLS + 2) * 4));
    const caps = specs.map((b, i) => Math.min(top, Math.ceil((ks[i].e / 2 ** ks[i].k) * 1.1) + 4096)), frames = specs.map((b) => frameOf(tile, b));
    const place = pipeline(g, placeKernel, "place"), tails = storage(g, specs.length * 8 + 8);
    {
      const enc = g.device.createCommandEncoder(), pass = enc.beginComputePass(), unis: GPUBuffer[] = [];
      specs.forEach((b, i) => {
        const gxLo = Math.max(0, Math.floor((b.bx0 - 1) / 2)), gxHi = Math.min(TILES - 1, Math.floor((b.bx0 + b.n) / 2)), gyLo = Math.max(0, Math.floor((b.by0 - 1) / 2)), gyHi = Math.min(TILES - 1, Math.floor((b.by0 + b.n) / 2));
        for (let gy = gyLo; gy <= gyHi; gy++) {
          const lo = run.start[gy * TILES + gxLo], hi = run.start[gy * TILES + gxHi + 1];
          if (hi <= lo) continue;
          const [gx, gy2] = cover(g, hi - lo), p = new Int32Array(20);
          p.set([lo - run.from, hi - run.from, gx, ks[i].k, caps[i], 0, 0, 0, tile.a0, tile.a1, ...frames[i], b.n * 5000, b.n]);
          const u = uniform(g, p);
          unis.push(u);
          pass.setPipeline(place);
          pass.setBindGroup(0, g.device.createBindGroup({ layout: place.getBindGroupLayout(0), entries: [u, ...run.out.slice(0, 5), stages[i], counts[i]].map((buffer, binding) => ({ binding, resource: { buffer } })) }));
          pass.dispatchWorkgroups(gx, gy2);
        }
      });
      pass.end();
      specs.forEach((_, i) => enc.copyBufferToBuffer(counts[i], CELLS * 4, tails, i * 8, 8));
      g.device.queue.submit([enc.finish()]);
      for (const u of unis) u.destroy();
    }
    const t = new Uint32Array(await readback(g, tails));
    tails.destroy();
    const out: (BlockObjects | null)[] = specs.map(() => null), good: number[] = [];
    specs.forEach((b, i) => { const kept = t[i * 2], overflow = t[i * 2 + 1] !== 0; if (overflow || kept > top) { stages[i].destroy(); counts[i].destroy(); } else good.push(i); });
    const enc = g.device.createCommandEncoder(), pass = enc.beginComputePass(), unis: GPUBuffer[] = [], curs: GPUBuffer[] = [], scan = pipeline(g, scanKernelFor(specs[0]?.n ?? 64), "scan"), scat = pipeline(g, scatterKernel, "scatter");
    for (const i of good) {
      const b = specs[i], kept = t[i * 2], cap = o.caps.find((c) => c >= kept && c <= top) ?? top;
      const body = storage(g, (7 * cap + 4) * 4), start = storage(g, (b.n * b.n + 1) * 4), cur = storage(g, b.n * b.n * 4);
      curs.push(cur);
      pass.setPipeline(scan);
      pass.setBindGroup(0, g.device.createBindGroup({ layout: scan.getBindGroupLayout(0), entries: [counts[i], start, cur].map((buffer, binding) => ({ binding, resource: { buffer } })) }));
      pass.dispatchWorkgroups(1);
      if (kept > 0) {
        const [sx, sy] = cover(g, kept), u = uniform(g, new Uint32Array([kept, sx, cap, 0]));
        unis.push(u);
        pass.setPipeline(scat);
        pass.setBindGroup(0, g.device.createBindGroup({ layout: scat.getBindGroupLayout(0), entries: [u, stages[i], cur, body].map((buffer, binding) => ({ binding, resource: { buffer } })) }));
        pass.dispatchWorkgroups(sx, sy);
      }
      out[i] = { body, start, n: kept, cap, share: 2 ** -ks[i].k, estimate: ks[i].e, bx0: b.bx0, by0: b.by0, n_: b.n };
    }
    pass.end();
    g.device.queue.submit([enc.finish()]);
    for (const u of unis) u.destroy();
    for (const i of good) { stages[i].destroy(); counts[i].destroy(); }
    for (const c of curs) c.destroy();
    for (let i = 0; i < specs.length; i++) if (!out[i]) out[i] = await make({ ...specs[i], k: ks[i].k + 1 });
    return out as BlockObjects[];
  };
  const close = () => { f.packed.destroy(); f.field.destroy(); run.idx.destroy(); f.release(); for (const b of run.out) b.destroy(); };
  return { est, make, makeMany, close };
}

// The blocks of one tile in one call (the check's way in): each in its frame, from one run.
export async function tileBlocks(g: Gpu, tier: number, tile: PlaceTile, blocks: BlockSpec[], seed: number, o: { caps: number[] }): Promise<BlockObjects[]> {
  const t = await openTile(g, tier, tile, seed, o);
  try {
    const out: BlockObjects[] = [];
    out.push(...(await t.makeMany(blocks)));
    return out;
  } finally { t.close(); }
}
