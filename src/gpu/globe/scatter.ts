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
// (which holds only a part of it) does not have. The tile draws instead each channel cell's step to its receiver: a segment from cell centre to cell centre (75 m, or 106 m on a diagonal), stroked
// at the bankfull width (water.ts bankWidth, the cell's flow times BANKFULL, wider where trees or shrubs hold 5% of the ground) to the depth bankDepth gives (R1892), on the same raster
// kernel (`raster`: the strokes stack, the nearest texel's coverage, the bed's depth in cm) that the island's lines go through. What this leaves out is the meanders (the stream's swing in its
// belt) and the smoothing of the cells' chain: the stream mask is a polyline of 75 m steps, not the island's smooth curve [gap: R1893]. The rivers of a patch of 8 cells round the tile
// are drawn (a stream of 1,200 m or wider across lies centred further out; no river of the planet's is that wide at its flow [gap]).
import { CELL } from "../../terrain/grid";
import { SIZE, type FineRiver, type Scatter } from "../../terrain/flora";
import { BANKFULL, WOODED, bankDepth, bankWidth } from "../../terrain/water";
import { dispatch, pipeline, readback, storage } from "../kernel";
import { objectsOn, run, segments, type SceneryKernels } from "../terrain/scenery";
import {
  GRADIENTS, ISLE, RASTER, countKernel, fineKernel, layoutOf, tableKernel, tileScenery, writeKernel, type SceneryLayout,
} from "../wgsl/terrain-scenery";
import { TABLE_UNIT, mappedField } from "./ground";
import { localOf, patchOf, tileAt } from "./patch";
import type { Ctx, Field } from "./stages";

const Q16 = 65536, Q24 = 16777216;
export const SCATTER_HALO = 2;
export const RIVER_HALO = 8;
// The quads of one tile and the first quad's key of tile k.
export const TILE_QUADS = 1024 * 1024;
export const keyOf = (tile: number) => tile * TILE_QUADS;

// ---------- the files the scatter reads ----------
export const SCATTER_IN = {
  height: "t4-height.i32", water: "t4-water.u16", moist: "t4-moist.u8", covers: ["t4-tree.u8", "t4-shr.u8", "t4-grs.u8", "t4-mar.u8", "t4-bare.u8"], flags: "t4-sflag.u8", soil: "t4-soil.u16",
  clayey: "t4-clayey.u8", ph: "t4-ph.u8", winter: "t4-stb3.u16", sun: [0, 1, 2, 3].map((k) => `t4-sun${k}.u16`), temp: [0, 1, 2, 3].map((k) => `t4-tmp${k}.i16`), sw: [0, 1, 2, 3].map((k) => `t4-sw${k}.u8`),
  to: "t4-to.u32", chn: "t4-chn.u8", flow: "t4-flow.u32",
};
export const SCATTER_FILES = Object.values(SCATTER_IN).flat();

const share24 = Int32Array.from({ length: 256 }, (_, v) => Math.round((v * Q24) / 255));
const ph16 = Int32Array.from({ length: 256 }, (_, v) => Math.round((v * Q16) / 30));
const at = <A extends Field>(f: Field, ids: Int32Array): A => {
  const out = new (f.constructor as new (n: number) => A)(ids.length);
  for (let k = 0; k < ids.length; k++) out[k] = f[ids[k]];
  return out;
};

// The kernels' texts by layout, made once.
const kernels = new Map<number, { L: SceneryLayout; K: SceneryKernels }>();
function kernelsOf(halo: number) {
  let k = kernels.get(halo);
  if (!k) {
    const fmt = tileScenery(halo), L = layoutOf(fmt);
    k = { L, K: { fine: fineKernel(L), table: tableKernel(L), count: countKernel(L), write: writeKernel(L) } };
    kernels.set(halo, k);
  }
  return k;
}

// The tile's fields as the kernels hold them (wgsl/terrain-scenery.ts ISLE, in a field of the tile's cells and a halo of `halo`), from the stored words by integer arithmetic alone.
export function packTile(ctx: Ctx, tile: number, halo = SCATTER_HALO): Int32Array {
  const { face, tx, ty } = tileAt(ctx.tier, tile), patch = patchOf(ctx.tier, face, tx, ty, halo), { L } = kernelsOf(halo), n = patch.ids.length, out = new Int32Array(L.ISLE_WORDS);
  const get = <A extends Field>(file: string) => at<A>(mappedField(ctx, file), patch.ids);
  const put = (name: (typeof ISLE)[number], fill: (i: number) => number) => { const o = L.IF[name]; for (let i = 0; i < n; i++) out[o + i] = fill(i); };
  const height = get<Int32Array>(SCATTER_IN.height), water = get<Uint16Array>(SCATTER_IN.water), flags = get<Uint8Array>(SCATTER_IN.flags), soil = get<Uint16Array>(SCATTER_IN.soil);
  put("height", (i) => height[i] * 256);
  put("water", (i) => Math.round((water[i] * Q16) / 100));
  const moist = get<Uint8Array>(SCATTER_IN.moist);
  put("moist", (i) => share24[moist[i]]);
  (["tree", "shrub", "grass", "marsh", "bare"] as const).forEach((name, k) => { const c = get<Uint8Array>(SCATTER_IN.covers[k]); put(name, (i) => share24[c[i]]); });
  put("sand", (i) => (flags[i] & 2 ? Q24 : 0));
  put("silt", (i) => (flags[i] & 1 ? Q24 : 0));
  put("soil", (i) => soil[i] * 64);
  const clay = get<Uint8Array>(SCATTER_IN.clayey), ph = get<Uint8Array>(SCATTER_IN.ph), stb = get<Uint16Array>(SCATTER_IN.winter);
  put("clayey", (i) => share24[clay[i]]);
  put("ph", (i) => ph16[ph[i]]);
  put("winter", (i) => stb[i] * (Q16 / TABLE_UNIT));
  for (let k = 0; k < 4; k++) {
    const sun = get<Uint16Array>(SCATTER_IN.sun[k]), tmp = get<Int16Array>(SCATTER_IN.temp[k]), sw = get<Uint8Array>(SCATTER_IN.sw[k]);
    put(`sun${k}` as (typeof ISLE)[number], (i) => sun[i] * 64);
    put(`temp${k}` as (typeof ISLE)[number], (i) => tmp[i] * 256);
    put(`sw${k}` as (typeof ISLE)[number], (i) => share24[sw[i]]);
  }
  out.set(GRADIENTS, L.GRAD_AT);
  // the tile's corner in quarter metres from its face's, and its face (the noise's place)
  out.set([tx * 256 * 4 * CELL, ty * 256 * 4 * CELL, face], L.GEO_AT);
  return out;
}

// The streams of the tile and of the 8 cells round it: a segment from each channel cell to its receiver, in the island's frame (metres from the area's centre, as `segments` takes them).
export function riversOf(ctx: Ctx, tile: number): FineRiver[][] {
  const { face, tx, ty } = tileAt(ctx.tier, tile), p = patchOf(ctx.tier, face, tx, ty, RIVER_HALO), S = p.side, local = localOf(p), n = p.ids.length;
  const get = <A extends Field>(file: string) => at<A>(mappedField(ctx, file), p.ids);
  const height = get<Int32Array>(SCATTER_IN.height), to = get<Uint32Array>(SCATTER_IN.to), chn = get<Uint8Array>(SCATTER_IN.chn), flow = get<Uint32Array>(SCATTER_IN.flow);
  const tree = get<Uint8Array>(SCATTER_IN.covers[0]), shrub = get<Uint8Array>(SCATTER_IN.covers[1]), lines: FineRiver[][] = [];
  const x = (i: number) => (((i % S) - RIVER_HALO) * CELL + CELL / 2) - SIZE / 2, z = (i: number) => ((Math.floor(i / S) - RIVER_HALO) * CELL + CELL / 2) - SIZE / 2;
  for (let i = 0; i < n; i++) {
    if (!chn[i] || p.missing[i] || !flow[i]) continue;
    const j = local(to[i] >>> 0);
    if (j < 0 || j === i) continue;
    const q = flow[i] / Q16, qbf = q * BANKFULL, wooded = (tree[i] + shrub[i]) / 255 >= WOODED;
    const run = Math.hypot(x(j) - x(i), z(j) - z(i)), s = Math.max((height[i] - height[j]) / 256 / run, 1e-4 / CELL);
    const point = (k: number): FineRiver => [x(k), z(k), q, 0, qbf, s, 0, bankWidth(qbf, wooded), bankDepth(qbf, s)];
    lines.push([point(i), point(j)]);
  }
  return lines;
}

// `fine` (when asked for): the fine field's heights over the 1,025 by 1,025 vertices, m, and the stream mask (RM by RM texels, 0 to 255).
export interface TileScatter { flora: Scatter; tile: number; segments: number; fine?: { h: Float32Array; mask: Uint8Array } }
// Every object on tile `tile` of the tier for world seed `seed`: `flora.px` and `py` are in game tiles (150 m) from the tile's north-west corner, `start` runs over its 128 by 128 game tiles.
export async function scatterTile(ctx: Ctx, tile: number, seed: number, halo = SCATTER_HALO, keepFine = false): Promise<TileScatter> {
  const g = ctx.gpu, { L, K } = kernelsOf(halo), rivers = riversOf(ctx, tile), { seg, table } = segments(rivers);
  const segs = storage(g, seg), bins = storage(g, table), field = storage(g, L.FINE_WORDS * 4), packed = storage(g, packTile(ctx, tile, halo));
  dispatch(g, pipeline(g, RASTER, "raster"), [segs, bins, field], [Math.ceil(L.RMW / 256)]);
  run(g, pipeline(g, K.fine, "fine"), [[0, packed], [1, field]], [Math.ceil(L.MV / 256)]);
  let fine: TileScatter["fine"];
  if (keepFine) {
    const [mask, h] = await Promise.all([readback(g, field, L.RMW * 4), readback(g, field, L.MV * 4, L.FINE_AT * 4)]);
    fine = { mask: new Uint8Array(mask), h: Float32Array.from(new Int32Array(h), (v) => v / Q16) };
  }
  const flora = await objectsOn(g, L, K, packed, field, seed, keyOf(tile));
  segs.destroy(); bins.destroy();
  return { flora, tile, segments: seg.length / 8, fine };
}
