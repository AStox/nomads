// The planet's close ground on the page, bundled for the browser (isopixel/groundwin.js): the scatter of a ground tile (src/gpu/globe/scatter.ts, the same objects every visit) and the fine
// ground of a window of cells (the scatter's fine kernel on the window's fields, so a vertex is the same whichever window holds it: its noise is read at the face's own metres).
import { CELL } from "../src/terrain/grid";
import { SIZE, M, type FineRiver } from "../src/terrain/flora";
import { BANKFULL, WOODED, bankDepth, bankWidth } from "../src/terrain/water";
import { dispatch, pipeline, pipelineSoon, readback, storage } from "../src/gpu/kernel";
import { run, segments } from "../src/gpu/terrain/scenery";
import { FINE, RASTER, fineKernel, layoutOf, tileScenery } from "../src/gpu/wgsl/terrain-scenery";
import { FINE_LAYER_WORDS, GN, GRID_LAYER_WORDS, GRID_PITCH, GRID_SCRATCH_LAYERS, FINE_OUT_LAYERS, FINE_PITCH, fineOutKernel, gridFoldKernels, gridHeightKernel, maskOutKernel } from "../src/gpu/wgsl/terrain-window";
import { SCATTER_HALO, RIVER_HALO, packTile, scatterTile, warmScatter, type TileSource } from "../src/gpu/globe/scatter";
import { placeKernels } from "../src/gpu/globe/windowobjects";
import type { Gpu } from "../src/gpu/device";

export { tileSource } from "../src/gpu/globe/groundtile";
export { windowObjects } from "../src/gpu/globe/windowobjects";
export { SCATTER_HALO, RIVER_HALO, scatterTile, warmScatter };

const Q16 = 65536, Q24 = 16777216;
const halo = SCATTER_HALO, L = layoutOf(tileScenery(halo)), FINE_K = fineKernel(L);

// The streams of a window of cells and the 8 round it: a segment from each channel cell to its receiver, in metres from the window's centre with z along the face's Y (the window's own rows),
// as scatter.ts riversOf makes them for a tile.
export function windowRivers(source: TileSource): FineRiver[][] {
  const S = 256 + 2 * RIVER_HALO, n = S * S;
  const height = source.plane<Int32Array>("height", RIVER_HALO), to = source.recv(RIVER_HALO), chn = source.plane<Uint8Array>("chn", RIVER_HALO), flow = source.plane<Uint32Array>("flow", RIVER_HALO);
  const tree = source.plane<Uint8Array>("tree", RIVER_HALO), shrub = source.plane<Uint8Array>("shrub", RIVER_HALO), lines: FineRiver[][] = [];
  // the groundwater's share of the flow and what the valley's fill carries under the bed, as the island's streams hold them (the painter's dry beds follow them)
  const base = source.plane<Uint16Array>("base", RIVER_HALO), under = source.plane<Uint16Array>("under", RIVER_HALO);
  const x = (i: number) => (((i % S) - RIVER_HALO) * CELL + CELL / 2) - SIZE / 2, z = (i: number) => ((Math.floor(i / S) - RIVER_HALO) * CELL + CELL / 2) - SIZE / 2;
  for (let i = 0; i < n; i++) {
    if (!chn[i] || !flow[i]) continue;
    const j = to[i];
    if (j < 0 || j === i) continue;
    const q = flow[i] / Q16, qbf = q * BANKFULL, wooded = (tree[i] + shrub[i]) / 255 >= WOODED;
    const run2 = Math.hypot(x(j) - x(i), z(j) - z(i)), s = Math.max((height[i] - height[j]) / 256 / run2, 1e-4 / CELL);
    const point = (k: number): FineRiver => [x(k), z(k), q, base[i] / 65535, qbf, s, under[i] / 4096, bankWidth(qbf, wooded), bankDepth(qbf, s)];
    lines.push([point(i), point(j)]);
  }
  return lines;
}

export interface WindowFine { layers: Record<(typeof FINE)[number], Float32Array>; mask: Uint8Array; rivers: FineRiver[][]; m: number }
// The fine ground of the window whose cells and halo are `source`, its west and north edge at face position (x0, y0) cells of `face`: the lattice runs from the window's edge to its edge, 1,025
// vertices a side (the heights in m, the others 0 to 1), and the stream mask (4,096 texels a side, 255 where a stream runs).
export async function windowFine(g: Gpu, source: TileSource, face: number, x0: number, y0: number): Promise<WindowFine> {
  const rivers = windowRivers(source), { seg, table } = segments(rivers);
  const segs = storage(g, seg), bins = storage(g, table), field = storage(g, L.FINE_WORDS * 4), words = packTile(source, 0, halo, 4);
  words.set([x0 * 4 * CELL, y0 * 4 * CELL, face], L.GEO_AT);
  const packed = storage(g, words);
  dispatch(g, pipeline(g, RASTER, "raster"), [segs, bins, field], [Math.ceil(L.RMW / 256)]);
  run(g, pipeline(g, FINE_K, "fine"), [[0, packed], [1, field]], [Math.ceil(L.MV / 256)]);
  const [maskRaw, raw] = await Promise.all([readback(g, field, L.RMW * 4), readback(g, field, FINE.length * L.MV * 4, L.FINE_AT * 4)]);
  segs.destroy(); bins.destroy(); packed.destroy(); field.destroy();
  const v = new Int32Array(raw), layers = {} as WindowFine["layers"];
  FINE.forEach((name, k) => {
    const out = new Float32Array(L.MV), at = k * L.MV, scale = k === 0 ? Q16 : Q24;
    for (let i = 0; i < L.MV; i++) out[i] = v[at + i] / scale;
    layers[name] = out;
  });
  return { layers, mask: new Uint8Array(maskRaw), rivers, m: L.m };
}

// The ground of a window as the painter reads it, left on the GPU: the fine layers as floats (FINE_OUT_LAYERS of M rows at FINE_PITCH words), the stream mask as
// bytes with its rows turned, and the light grid's layers (GN rows at GRID_PITCH words, the layers h, folds, slope, gradient x and z, then a scratch). Only the heights
// come back (the camera works on them), and the highest of the grid's. The caller owns the three buffers.
export interface WindowGround { fine: GPUBuffer; mask: GPUBuffer; grid: GPUBuffer; h: Float32Array; top: number; rivers: FineRiver[][]; finePitch: number; fineLayerWords: number; gridPitch: number; gridLayerWords: number }
const FINE_OUT = fineOutKernel(L), MASK_OUT = maskOutKernel(L);
export async function windowGround(g: Gpu, source: TileSource, face: number, x0: number, y0: number): Promise<WindowGround> {
  const rivers = windowRivers(source), { seg, table } = segments(rivers);
  const segs = storage(g, seg), bins = storage(g, table), field = storage(g, L.FINE_WORDS * 4), words = packTile(source, 0, halo, 4);
  words.set([x0 * 4 * CELL, y0 * 4 * CELL, face], L.GEO_AT);
  const packed = storage(g, words);
  dispatch(g, pipeline(g, RASTER, "raster"), [segs, bins, field], [Math.ceil(L.RMW / 256)]);
  run(g, pipeline(g, FINE_K, "fine"), [[0, packed], [1, field]], [Math.ceil(L.MV / 256)]);
  const fine = storage(g, FINE_OUT_LAYERS * FINE_LAYER_WORDS * 4), mask = storage(g, L.RMW * 4), grid = storage(g, GRID_SCRATCH_LAYERS * GRID_LAYER_WORDS * 4), top = storage(g, 16);
  dispatch(g, pipeline(g, FINE_OUT, "fineOut"), [field, fine], [Math.ceil((M * M) / 256)]);
  dispatch(g, pipeline(g, MASK_OUT, "maskOut"), [field, mask], [Math.ceil(L.RMW / 256)]);
  const gw = Math.ceil(GN / 16);
  dispatch(g, pipeline(g, gridHeightKernel, "gridHeight"), [fine, grid, top], [gw, gw]);
  dispatch(g, pipeline(g, gridFoldKernels, "blurX"), [grid], [gw, gw]);
  dispatch(g, pipeline(g, gridFoldKernels, "blurY"), [grid], [gw, gw]);
  dispatch(g, pipeline(g, gridFoldKernels, "gradient"), [grid], [gw, gw]);
  const [hRaw, topRaw] = await Promise.all([readback(g, fine, FINE_LAYER_WORDS * 4), readback(g, top, 4)]);
  segs.destroy(); bins.destroy(); packed.destroy(); field.destroy(); top.destroy();
  const padded = new Float32Array(hRaw), h = new Float32Array(M * M);
  for (let r = 0; r < M; r++) h.set(padded.subarray(r * FINE_PITCH, r * FINE_PITCH + M), r * M);
  return { fine, mask, grid, h, top: new Float32Array(topRaw)[0], rivers, finePitch: FINE_PITCH, fineLayerWords: FINE_LAYER_WORDS, gridPitch: GRID_PITCH, gridLayerWords: GRID_LAYER_WORDS };
}

// Every kernel a window's ground and scatter run, compiling off the frames' queue; resolves when all are made.
export function warmWindow(g: Gpu): Promise<unknown> {
  const own: [string, string][] = [[FINE_OUT, "fineOut"], [MASK_OUT, "maskOut"], [gridHeightKernel, "gridHeight"], [gridFoldKernels, "blurX"], [gridFoldKernels, "blurY"], [gridFoldKernels, "gradient"]];
  return Promise.all([warmScatter(g, halo), ...own.concat(placeKernels).map(([src, entry]) => pipelineSoon(g, src, entry))]);
}
