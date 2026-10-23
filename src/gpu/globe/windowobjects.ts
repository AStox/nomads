// The objects of a window, made and laid out on the GPU without a read back of them: each of the window's tiles' scatter (scatter.ts, the same draws and ids) is put in the window's frame, thinned
// by the share, binned by cell and written into the renderer's source body (wgsl/terrain-place.ts). The share is the largest 2^-k whose entries fit `top` slots, worked out from the draws'
// counts before anything is written (a draw-time density: the entries kept at a half are kept at a whole), and raised again if the staged total came out over.
import { TILES } from "../../terrain/flora";
import { cover, dispatch, pipeline, readback, storage, uniform } from "../kernel";
import { objectsGpu, objectsWrite, type CellWindow } from "../terrain/scenery";
import { CELLS, STAGE_WORDS, placeKernel, scanKernel, scatterKernel } from "../wgsl/terrain-place";
import type { Gpu } from "../device";
import { keyOf, tileFields, type TileSource } from "./scatter";

// A tile of the window: its scatter's rectangle of cells, and where its objects stand in the window's frame, in units of 15 mm: out x = d0 (A0 + px - s0x) + d1 (A1 + py - s0y) + w0x,
// out y = N - (-d1 (A0 + px - s0x) + d0 (A1 + py - s0y) + w0y), (px, py) the entry's place in the tile's game tiles of 10,000 units.
export interface PlaceTile { tile: number; source: TileSource; rect: CellWindow; a0: number; a1: number; s0x: number; s0y: number; w0x: number; w0y: number; d0: number; d1: number }
export interface WindowObjects { body: GPUBuffer; start: GPUBuffer; n: number; cap: number; share: number; estimate: number }

export async function windowObjects(g: Gpu, tier: number, tiles: PlaceTile[], seed: number, o: { caps: number[]; share?: number; side?: number }): Promise<WindowObjects> {
  const ctx = { gpu: g, tier }, top = o.caps[o.caps.length - 1], win = (o.side ?? 256) * 5000;
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
          p.set([run.from, run.to, gx, k, stageCap, 0, 0, 0, t.a0, t.a1, t.s0x, t.s0y, t.w0x, t.w0y, t.d0, t.d1, win]);
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
      const body = storage(g, 7 * cap * 4), start = storage(g, (CELLS + 1) * 4), cur = storage(g, CELLS * 4);
      dispatch(g, pipeline(g, scanKernel, "scan"), [counts, start, cur], [1]);
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
export const placeKernels: [string, string][] = [[placeKernel, "place"], [scanKernel, "scan"], [scatterKernel, "scatter"]];
