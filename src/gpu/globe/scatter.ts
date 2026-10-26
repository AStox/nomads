// The scatter: what grew on a tile of the 75 m tier (every tree, bush, herb, fern, flower, mushroom, tussock, reed, clay bed and loose stone of bog iron), made for any tile on demand as a pure
// function of the tile's own fields and counter-based draws keyed by the global quad. Nothing is stored: the same tile gives the same bytes every time, a tile made alone is the tile made
// after another, and no object is made by two tiles.
//
// It is the island's scenery (gpu/terrain/scenery.ts, wgsl/terrain-scenery.ts) on a tile: a planet tile is 256 cells of 75 m, 19.2 km, the island's size, so the kernels are the island's with a
// format (`tileScenery`): the fields are the tile's cells and a halo of 2 round them (the fine field is a Catmull-Rom cubic between cell centres, which reads from one cell before a
// vertex's to two after it, and the quads at a tile's edge need the cells beyond it), the fine lattice runs from the tile's own west and north edges to its east and south (1,025 vertices,
// 1,024 quads a side, so that the quads of neighbouring tiles meet and none lies in two), and every draw is keyed (world seed, layer, quad, object) with the quad's number
// the tile's index (face * 256 + ty * 16 + tx) times 1,024 * 1,024 plus its own: 1,536 tiles of 2^20 quads fill 1.6 billion of the 4.3 billion a word holds [design: R1890].
// The ground noise the fine field and the patches of small plants read (flora.ts noise and fbm) is read at the world position of the place in the face's own metres, so that it runs on
// across a tile's edge; across a cube's edge, where a face's axes turn, it does not (the face number is mixed into its hash, so that each face has a pattern of its own): a seam in the
// swell (2.6 m at 960 m) and in the patches' density at a cube's edge [gap: R1891].
//
// The stream mask. The island draws each river from the hydrology's polylines (`shape`: the chain of cells smoothed twice, resampled, meandered where the stream is powerful enough to move its
// banks, with a line joining the one it flows into where that now lies). That is CPU list work over a whole island's lines, and what it needs is every river's whole line, which a tile
// (which holds only a part of it) does not have. The tile draws instead each channel cell's step to its receiver, as a smooth curve between the cells' nodes (streamcurve.ts: the cell centres eased along the stream, a centripetal Catmull-Rom spline
// through them, a pure function of the stream's own cells so that neighbouring tiles agree), stroked
// at the bankfull width (water.ts bankWidth, the cell's flow times BANKFULL, wider where trees or shrubs hold 5% of the ground) to the depth bankDepth gives (R1892), on the same raster
// kernel (`raster`: the strokes stack, the nearest texel's coverage, the bed's depth in cm) that the island's lines go through. What this leaves out is the meanders (the stream's swing in its
// belt) [gap: R1893]. The rivers of a patch of 8 cells round the tile
// are drawn (a stream of 1,200 m or wider across lies centred further out; no river of the planet's is that wide at its flow [gap]).
import { CELL } from "../../terrain/grid";
import { streamCurves } from "./streamcurve";
import { RM, SIZE, type FineRiver, type Scatter } from "../../terrain/flora";
import { BANKFULL, WOODED, bankDepth, bankWidth } from "../../terrain/water";
import { dispatchSliced, pipeline, pipelineSoon, readback, storage } from "../kernel";
import type { Gpu } from "../device";
import { SLICE_GROUPS, objectsOn, run, segments, type CellWindow, type SceneryKernels, type WindowedScatter } from "../terrain/scenery";
import {
  ECO_HALO, GRADIENTS, ISLE, countKernel, fineKernel, layoutOf, rasterKernel, tableKernel, tileScenery, writeKernel, type SceneryLayout,
} from "../wgsl/terrain-scenery";
import { TABLE_UNIT, mappedField } from "./ground";
import { GROUNDTILE_FIELDS } from "./bake";
import { tierFile } from "./bakedir";
import { localOf, patchOf, tileAt } from "./patch";
import type { Ctx, Field } from "./stages";

const Q16 = 65536, Q24 = 16777216;
export const SCATTER_HALO = 2;
// a window's halo: the forest's edge reads cells far past the tile (terrain-scenery.ts), so the same vertex is the same whichever window or tile holds it
export const WINDOW_HALO = ECO_HALO;
// the stream raster over a band of rows (a rectangle of the mask's words), which tileFields makes a slice at a time
const RASTER_RECT = rasterKernel(true);
export const RIVER_HALO = 8;
// The quads of one tile and the first quad's key of tile k.
export const TILE_QUADS = 1024 * 1024;
export const keyOf = (tile: number) => tile * TILE_QUADS;

// ---------- where the fields come from ----------
// A tile's fields by their ground-tile names (bake.ts GROUNDTILE_FIELDS), each over the tile's patch of `halo` cells round it, side * side words in the stage files' units; and each cell's receiver as
// the patch's own index of the cell it drains to (-1 for none or one outside the patch).
export interface TileSource { plane<A extends Field>(name: string, halo: number): A; recv(halo: number): Int32Array }
const at = <A extends Field>(f: Field, ids: Int32Array): A => {
  const out = new (f.constructor as new (n: number) => A)(ids.length);
  for (let k = 0; k < ids.length; k++) out[k] = f[ids[k]];
  return out;
};
// The stage files' fields, mapped.
export function stageSource(ctx: Pick<Ctx, "dir" | "tier">, tile: number): TileSource {
  const { face, tx, ty } = tileAt(ctx.tier, tile), patchAtHalo = (h: number) => patchOf(ctx.tier, face, tx, ty, h);
  return {
    plane<A extends Field>(name: string, halo: number) {
      const f = GROUNDTILE_FIELDS.find((g) => g.name === name);
      if (!f) throw new Error(`scatter: no field ${name}`);
      return at<A>(mappedField(ctx, tierFile(ctx.tier, f.file)), patchAtHalo(halo).ids);
    },
    recv(halo: number) {
      const p = patchAtHalo(halo), local = localOf(p), to = at<Uint32Array>(mappedField(ctx, tierFile(ctx.tier, "to.u32")), p.ids);
      return Int32Array.from(to, (r) => local(r));
    },
  };
}

const share24 = Int32Array.from({ length: 256 }, (_, v) => Math.round((v * Q24) / 255));
const ph16 = Int32Array.from({ length: 256 }, (_, v) => Math.round((v * Q16) / 30));

// The kernels' texts by layout, made once.
const kernels = new Map<string, { L: SceneryLayout; K: SceneryKernels }>();
function kernelsOf(halo: number, eco = false) {
  const key = `${halo}${eco ? "e" : ""}`;
  let k = kernels.get(key);
  if (!k) {
    const fmt = tileScenery(halo, eco), L = layoutOf(fmt);
    k = { L, K: { fine: fineKernel(L), table: tableKernel(L), count: countKernel(L), write: writeKernel(L) } };
    kernels.set(key, k);
  }
  return k;
}

// Every kernel a tile's scatter and fine ground run, set compiling off the frames' queue (kernel.ts pipelineSoon), so the first window finds them made; resolves when all are.
export function warmScatter(g: Gpu, halo = SCATTER_HALO, eco = false): Promise<unknown> {
  const { K } = kernelsOf(halo, eco);
  return Promise.all([[RASTER_RECT, "raster"], [K.fine, "fine"], [K.table, "table"], [K.count, "count"], [K.count, "rank"], [K.count, "rows"], [K.count, "scan"], [K.write, "write"]].map(([src, entry]) => pipelineSoon(g, src, entry)));
}

// The tile's fields as the kernels hold them (wgsl/terrain-scenery.ts ISLE, in a field of the tile's cells and a halo of `halo`), from the stored words by integer arithmetic alone.
export function packTile(source: TileSource, tile: number, halo = SCATTER_HALO, tier = 4): Int32Array {
  const { face, tx, ty } = tileAt(tier, tile), { L } = kernelsOf(halo), n = (256 + 2 * halo) ** 2, out = new Int32Array(L.ISLE_WORDS);
  // Each plane is converted to int32 by the engine (`set` across array types) so the loops below see one array type: a loop over a closure per cell, or over seven array types, ran at 170 ns a cell
  const tmp = new Int32Array(n);
  const get = <A extends Field>(name: string) => { tmp.set(source.plane<A>(name, halo) as ArrayLike<number>); return tmp; };
  const scaled = (name: (typeof ISLE)[number], from: string, k: number) => { const t = get(from), o = L.IF[name]; for (let i = 0; i < n; i++) out[o + i] = t[i] * k; };
  const lut = (name: (typeof ISLE)[number], from: string, table: Int32Array) => { const t = get(from), o = L.IF[name]; for (let i = 0; i < n; i++) out[o + i] = table[t[i]]; };
  scaled("height", "height", 256);
  { const t = get("water"), o = L.IF.water; for (let i = 0; i < n; i++) out[o + i] = Math.round((t[i] * Q16) / 100); }
  lut("moist", "moist", share24);
  for (const name of ["tree", "shrub", "grass", "marsh", "bare"] as const) lut(name, name, share24);
  { const t = get("flags"), a = L.IF.sand, b = L.IF.silt; for (let i = 0; i < n; i++) { out[a + i] = t[i] & 2 ? Q24 : 0; out[b + i] = t[i] & 1 ? Q24 : 0; } }
  scaled("soil", "soil", 64);
  lut("clayey", "clayey", share24);
  lut("ph", "ph", ph16);
  scaled("winter", "winter", Q16 / TABLE_UNIT);
  for (let k = 0; k < 4; k++) {
    scaled(`sun${k}` as (typeof ISLE)[number], `sun${k}`, 64);
    scaled(`temp${k}` as (typeof ISLE)[number], `tmp${k}`, 256);
    lut(`sw${k}` as (typeof ISLE)[number], `sw${k}`, share24);
  }
  out.set(GRADIENTS, L.GRAD_AT);
  // the tile's corner in quarter metres from its face's, and its face (the noise's place)
  out.set([tx * 256 * 4 * CELL, ty * 256 * 4 * CELL, face], L.GEO_AT);
  return out;
}

// The streams of the tile and of the 8 cells round it: each channel cell's step to its receiver as a smooth curve between the two cells' nodes (streamcurve.ts), in the island's frame (metres from the area's centre, as `segments` takes them).
export function riversOf(source: TileSource, tile: number, tier = 4): FineRiver[][] {
  const { face, tx, ty } = tileAt(tier, tile), p = patchOf(tier, face, tx, ty, RIVER_HALO), S = p.side, n = p.ids.length;
  const height = source.plane<Int32Array>("height", RIVER_HALO), to = source.recv(RIVER_HALO), chn = source.plane<Uint8Array>("chn", RIVER_HALO), flow = source.plane<Uint32Array>("flow", RIVER_HALO);
  const tree = source.plane<Uint8Array>("tree", RIVER_HALO), shrub = source.plane<Uint8Array>("shrub", RIVER_HALO), lines: FineRiver[][] = [];
  const x = (i: number) => (((i % S) - RIVER_HALO) * CELL + CELL / 2) - SIZE / 2, z = (i: number) => ((Math.floor(i / S) - RIVER_HALO) * CELL + CELL / 2) - SIZE / 2;
  const ok = (i: number) => !!chn[i] && !p.missing[i] && !!flow[i], curve = streamCurves(n, to, ok, flow, x, z, CELL);
  for (let i = 0; i < n; i++) {
    if (!ok(i)) continue;
    const j = to[i];
    if (j < 0 || j === i) continue;
    const q = flow[i] / Q16, qbf = q * BANKFULL, wooded = (tree[i] + shrub[i]) / 255 >= WOODED;
    const run = Math.hypot(x(j) - x(i), z(j) - z(i)), s = Math.max((height[i] - height[j]) / 256 / run, 1e-4 / CELL);
    const xz = curve(i), line: FineRiver[] = [];
    for (let k = 0; k < xz.length; k += 2) line.push([xz[k], xz[k + 1], q, 0, qbf, s, 0, bankWidth(qbf, wooded), bankDepth(qbf, s)]);
    lines.push(line);
  }
  return lines;
}

// `fine` (when asked for): the fine field's heights over the 1,025 by 1,025 vertices, m, and the stream mask (RM by RM texels, 0 to 255).
export interface TileScatter<F extends Scatter = Scatter> { flora: F; tile: number; segments: number; fine?: { h: Float32Array; mask: Uint8Array } }
// A tile's streams rasterised and its fine ground made, left on the GPU for the scatter's kernels: the packed fields, the fine buffer, and what to let go of when they are done.
export async function tileFields(ctx: Pick<Ctx, "gpu" | "tier">, tile: number, source: TileSource, halo = SCATTER_HALO, eco = false) {
  const g = ctx.gpu, { L, K } = kernelsOf(halo, eco), rivers = riversOf(source, tile, ctx.tier), { seg, table } = segments(rivers);
  const segs = storage(g, seg), bins = storage(g, table), field = storage(g, L.FINE_WORDS * 4), packed = storage(g, packTile(source, tile, halo, ctx.tier));
  // the mask in bands of SLICE_GROUPS workgroups of 256 words (four texels each) a submit, each band's rows the rectangle's (the kernel writes each word where the whole mask's run would have put it)
  const across = RM / 4, rows = (SLICE_GROUPS * 256) / across, rect = storage(g, new Uint32Array([0, 0, across, rows]));
  await dispatchSliced(g, pipeline(g, RASTER_RECT, "raster"), [[0, segs], [1, bins], [2, field], [3, rect]], Math.ceil(L.RMW / 256), SLICE_GROUPS, (first, n) => g.device.queue.writeBuffer(rect, 0, new Uint32Array([0, (first * 256) / across, across, (n * 256) / across])));
  rect.destroy();
  run(g, pipeline(g, K.fine, "fine"), [[0, packed], [1, field]], [Math.ceil(L.MV / 256)]);
  return { g, L, K, packed, field, segments: seg.length / 8, release: () => { segs.destroy(); bins.destroy(); } };
}

// Every object on tile `tile` of the tier for world seed `seed`: `flora.px` and `py` are in game tiles (150 m) from the tile's north-west corner, `start` runs over its 128 by 128 game tiles.
// `source` is the stage files by default; the ground tile's planes (groundtile.ts) give the same objects.
// With `window` (a rectangle of the tile's cells: x0, y0, w, h) only the objects whose place lies in it are made: the same objects, with the same bytes, as the whole tile's run cut to the window,
// each with its index in the whole run (`flora.ids`, `flora.oreIds`), so that ids are stable whichever is asked for. The draws are counted over the whole tile (that is what fixes the ids), the
// write pass makes the quads the window touches, and only the rows of game tiles it touches are read back. The fine field is the whole tile's.
export async function scatterTile(ctx: Pick<Ctx, "gpu" | "dir" | "tier">, tile: number, seed: number, halo: number | undefined, keepFine: boolean | undefined, source: TileSource | undefined, window: CellWindow): Promise<TileScatter<WindowedScatter>>;
export async function scatterTile(ctx: Pick<Ctx, "gpu" | "dir" | "tier">, tile: number, seed: number, halo?: number, keepFine?: boolean, source?: TileSource): Promise<TileScatter>;
export async function scatterTile(ctx: Pick<Ctx, "gpu" | "dir" | "tier">, tile: number, seed: number, halo = SCATTER_HALO, keepFine = false, source: TileSource = stageSource(ctx, tile), window?: CellWindow): Promise<TileScatter<Scatter | WindowedScatter>> {
  const { g, L, K, packed, field, segments: nSeg, release } = await tileFields(ctx, tile, source, halo);
  let fine: TileScatter["fine"];
  if (keepFine) {
    const [mask, h] = await Promise.all([readback(g, field, L.RMW * 4), readback(g, field, L.MV * 4, L.FINE_AT * 4)]);
    fine = { mask: new Uint8Array(mask), h: Float32Array.from(new Int32Array(h), (v) => v / Q16) };
  }
  const flora = window ? await objectsOn(g, L, K, packed, field, seed, keyOf(tile), window) : await objectsOn(g, L, K, packed, field, seed, keyOf(tile));
  release();
  return { flora, tile, segments: nSeg, fine };
}
