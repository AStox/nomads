// The planet's close ground on the page, bundled for the browser (isopixel/groundwin.js): the scatter of a ground tile (src/gpu/globe/scatter.ts, the same objects every visit) and the fine
// ground of a window of cells (the scatter's fine kernel on the window's fields, so a vertex is the same whichever window holds it: its noise is read at the face's own metres).
import { CELL } from "../src/terrain/grid";
import { SIZE, M, RM, type FineRiver } from "../src/terrain/flora";
import { BANKFULL, WOODED, bankDepth, bankWidth } from "../src/terrain/water";
import { dispatch, pipeline, pipelineSoon, readback, storage } from "../src/gpu/kernel";
import { run, segments } from "../src/gpu/terrain/scenery";
import { FINE, RASTER, fineKernel, layoutOf, rasterKernel, tileScenery } from "../src/gpu/wgsl/terrain-scenery";
import { FINE_LAYER_WORDS, GN, GRID_LAYER_WORDS, GRID_PITCH, GRID_SCRATCH_LAYERS, FINE_OUT_LAYERS, FINE_PITCH, fieldShiftKernel, fineOutKernel, gridFoldKernels, gridHeightKernel, maskOutKernel } from "../src/gpu/wgsl/terrain-window";
import { SCATTER_HALO, RIVER_HALO, packTile, scatterTile, warmScatter, type TileSource } from "../src/gpu/globe/scatter";
import { placeKernels } from "../src/gpu/globe/windowobjects";
import type { Gpu } from "../src/gpu/device";

export { tileSource } from "../src/gpu/globe/groundtile";
export { openTile, windowObjects } from "../src/gpu/globe/windowobjects";
export { SCATTER_HALO, RIVER_HALO, scatterTile, warmScatter };

const Q16 = 65536, Q24 = 16777216;
const halo = SCATTER_HALO, L = layoutOf(tileScenery(halo)), FINE_K = fineKernel(L), FINE_RECT = fineKernel(L, true), RASTER_RECT = rasterKernel(true), FIELD_SHIFT = fieldShiftKernel(L);

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
export interface WindowGround { fine: GPUBuffer; mask: GPUBuffer; grid: GPUBuffer; h: Float32Array; top: number; rivers: FineRiver[][]; finePitch: number; fineLayerWords: number; gridPitch: number; gridLayerWords: number; field: GPUBuffer | null }
// What a window's lattice leaves for the next to be moved from: its field and where it stood (the face's cells), kept when asked (`keep`) and the caller's to destroy.
export interface WindowField { field: GPUBuffer; x0: number; y0: number; face: number }
const FINE_OUT = fineOutKernel(L), MASK_OUT = maskOutKernel(L);
// The lattice's vertices a move of dx cells uncovers, as [first, end) in one axis: the side the move comes from, and for a move toward the far edge one vertex more, since the
// fine kernel's mask texel at the last vertex is held to the mask's last (the window's edge vertex was made with it).
const uncovered = (d: number): [number, number] => (d > 0 ? [L.m - 4 * d - 1, L.m] : d < 0 ? [0, -4 * d] : [0, 0]);
const settled = (d: number): [number, number] => (d > 0 ? [0, L.m - 4 * d - 1] : d < 0 ? [-4 * d, L.m] : [0, L.m]);
export async function windowGround(g: Gpu, source: TileSource, face: number, x0: number, y0: number, opts: { keep?: boolean; from?: WindowField | null } = {}): Promise<WindowGround> {
  const rivers = windowRivers(source), { seg, table } = segments(rivers);
  const segs = storage(g, seg), bins = storage(g, table), field = storage(g, L.FINE_WORDS * 4), words = packTile(source, 0, halo, 4);
  words.set([x0 * 4 * CELL, y0 * 4 * CELL, face], L.GEO_AT);
  const packed = storage(g, words), from = opts.from && opts.from.face === face ? opts.from : null, dx = from ? x0 - from.x0 : 0, dy = from ? y0 - from.y0 : 0;
  if (from && (4 * Math.abs(dx) >= L.m || 4 * Math.abs(dy) >= L.m)) throw new Error(`windowGround: a move of ${dx}, ${dy} cells leaves nothing to keep`);
  const rect = (pipe: GPUComputePipeline, binds: GPUBuffer[], r: [number, number, number, number]) => {
    if (r[2] <= 0 || r[3] <= 0) return;
    const b = storage(g, Uint32Array.from(r));
    dispatch(g, pipe, [...binds, b], [Math.ceil((r[2] * r[3]) / 256)]);
    b.destroy();
  };
  if (!from) {
    dispatch(g, pipeline(g, RASTER, "raster"), [segs, bins, field], [Math.ceil(L.RMW / 256)]);
    run(g, pipeline(g, FINE_K, "fine"), [[0, packed], [1, field]], [Math.ceil(L.MV / 256)]);
  } else {
    const sh = storage(g, Int32Array.of(dx, dy));
    dispatch(g, pipeline(g, FIELD_SHIFT, "shift"), [from.field, field, sh], [4096, Math.ceil(L.FINE_WORDS / 1048576)]);
    sh.destroy();
    // the stream mask's words and the lattice's vertices the move uncovered: the columns, whole height, then the rows over the columns that stay
    const [cu0, cu1] = [Math.max(0, dx > 0 ? RM / 4 - 4 * dx : 0), dx > 0 ? RM / 4 : dx < 0 ? -4 * dx : 0], [su0, su1] = dx > 0 ? [0, RM / 4 - 4 * dx] : dx < 0 ? [-4 * dx, RM / 4] : [0, RM / 4];
    const [ry0, ry1] = dy > 0 ? [RM - 16 * dy, RM] : dy < 0 ? [0, -16 * dy] : [0, 0];
    const rast = pipeline(g, RASTER_RECT, "raster");
    rect(rast, [segs, bins, field], [cu0, 0, cu1 - cu0, RM]);
    rect(rast, [segs, bins, field], [su0, ry0, su1 - su0, ry1 - ry0]);
    const [eu0, eu1] = uncovered(dx), [ev0, ev1] = uncovered(dy), [ku0, ku1] = settled(dx), fin = pipeline(g, FINE_RECT, "fine");
    rect(fin, [packed, field], [eu0, 0, eu1 - eu0, L.m]);
    rect(fin, [packed, field], [ku0, ev0, ku1 - ku0, ev1 - ev0]);
  }
  const fine = storage(g, FINE_OUT_LAYERS * FINE_LAYER_WORDS * 4), mask = storage(g, L.RMW * 4), grid = storage(g, GRID_SCRATCH_LAYERS * GRID_LAYER_WORDS * 4), top = storage(g, 16);
  dispatch(g, pipeline(g, FINE_OUT, "fineOut"), [field, fine], [Math.ceil((M * M) / 256)]);
  dispatch(g, pipeline(g, MASK_OUT, "maskOut"), [field, mask], [Math.ceil(L.RMW / 256)]);
  const gw = Math.ceil(GN / 16);
  dispatch(g, pipeline(g, gridHeightKernel, "gridHeight"), [fine, grid, top], [gw, gw]);
  dispatch(g, pipeline(g, gridFoldKernels, "blurX"), [grid], [gw, gw]);
  dispatch(g, pipeline(g, gridFoldKernels, "blurY"), [grid], [gw, gw]);
  dispatch(g, pipeline(g, gridFoldKernels, "gradient"), [grid], [gw, gw]);
  const [hRaw, topRaw] = await Promise.all([readback(g, fine, FINE_LAYER_WORDS * 4), readback(g, top, 4)]);
  segs.destroy(); bins.destroy(); packed.destroy(); top.destroy();
  if (!opts.keep) field.destroy();
  const padded = new Float32Array(hRaw), h = new Float32Array(M * M);
  for (let r = 0; r < M; r++) h.set(padded.subarray(r * FINE_PITCH, r * FINE_PITCH + M), r * M);
  return { fine, mask, grid, h, top: new Float32Array(topRaw)[0], rivers, finePitch: FINE_PITCH, fineLayerWords: FINE_LAYER_WORDS, gridPitch: GRID_PITCH, gridLayerWords: GRID_LAYER_WORDS, field: opts.keep ? field : null };
}

// Every kernel a window's ground and scatter run, compiling off the frames' queue; resolves when all are made.
export function warmWindow(g: Gpu): Promise<unknown> {
  const own: [string, string][] = [[FIELD_SHIFT, "shift"], [RASTER_RECT, "raster"], [FINE_RECT, "fine"], [FINE_OUT, "fineOut"], [MASK_OUT, "maskOut"], [gridHeightKernel, "gridHeight"], [gridFoldKernels, "blurX"], [gridFoldKernels, "blurY"], [gridFoldKernels, "gradient"]];
  return Promise.all([warmScatter(g, halo), ...own.concat(placeKernels).map(([src, entry]) => pipelineSoon(g, src, entry))]);
}
