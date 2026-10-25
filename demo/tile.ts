// The planet's close ground on the page, bundled for the browser (isopixel/groundwin.js): the scatter of a ground tile (src/gpu/globe/scatter.ts, the same objects every visit) and the fine
// ground of a window of cells (the scatter's fine kernel on the window's fields, so a vertex is the same whichever window holds it: its noise is read at the face's own metres).
import { CELL } from "../src/terrain/grid";
import { SIZE, M, RM, type FineRiver } from "../src/terrain/flora";
import { BANKFULL, WOODED, bankDepth, bankWidth } from "../src/terrain/water";
import { dispatch, pipeline, pipelineSoon, readback, storage } from "../src/gpu/kernel";
import { run, segments } from "../src/gpu/terrain/scenery";
import { FINE, RASTER, fineKernel, layoutOf, rasterKernel, tileScenery } from "../src/gpu/wgsl/terrain-scenery";
import { GRID_PITCH, FINE_PITCH, PAGE_CELLS, PAGE_FINE_LAYER_WORDS, PAGE_FINE_PITCH, PAGE_FINE_WORDS, PAGE_GRID_WORDS, PAGE_HALO_NODES, PAGE_HALO_VERTS, PAGE_HN, PAGE_MASK_WORDS, PAGE_NG, PAGE_NV, PAGE_PARAMS, PAGE_SCRATCH_LAYER_WORDS, pageFineKernel, pageGridKernels, pageHeightPlaneKernel, pageMaskKernel } from "../src/gpu/wgsl/terrain-window";
import { SCATTER_HALO, WINDOW_HALO, RIVER_HALO, packTile, scatterTile, warmScatter, type TileSource } from "../src/gpu/globe/scatter";
import { placeKernels } from "../src/gpu/globe/windowobjects";
import type { Gpu } from "../src/gpu/device";

export { tileSource } from "../src/gpu/globe/groundtile";
export { openTile } from "../src/gpu/globe/windowobjects";
export { SCATTER_HALO, RIVER_HALO, scatterTile, warmScatter };

const Q16 = 65536, Q24 = 16777216;
const halo = WINDOW_HALO, L = layoutOf(tileScenery(halo, true)), FINE_K = fineKernel(L), FINE_RECT = fineKernel(L, true), RASTER_RECT = rasterKernel(true);

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

// ---------- the ground as pages ----------
// A page is PAGE_CELLS (64) cells a side of a face: its fine layers at PAGE_NV (257) vertices, its light grid at PAGE_NG (385) nodes, its stream mask at 1,024 texels. Fine and grid pages
// share their edge vertex or node with the next page, the masks tile exactly. The pages go to slots of an atlas: three buffers, a page's words at slot * PAGE_*_WORDS (terrain-window.ts).
export interface PageAtlas { slots: number; fine: GPUBuffer; grid: GPUBuffer; mask: GPUBuffer }
export interface PageSpec { px: number; py: number; slot: number }
// exact: the page's nodes and the 16 round it lie where the window's lattice holds the planet's own vertices (not the window's edge held flat), so the page is the same whichever window made it.
export interface GroundPage extends PageSpec { face: number; exact: boolean }
const PAGE_FINE = pageFineKernel(L), PAGE_MASK_K = pageMaskKernel(L), PAGE_HEIGHT = pageGridKernels.height(L), PAGE_FOLDS = pageGridKernels.folds(L), PAGE_HEIGHTS = pageHeightPlaneKernel(L);

export function pageAtlas(g: Gpu, slots: number): PageAtlas {
  return { slots, fine: storage(g, slots * PAGE_FINE_WORDS * 4), grid: storage(g, slots * PAGE_GRID_WORDS * 4), mask: storage(g, slots * PAGE_MASK_WORDS * 4) };
}

// A window as a source of pages: its streams binned, its cells packed and its lattice's field (the window's size, 71 MB), kept between calls so pages asked for at different times from the
// same window repeat none of it (the CPU's part is 16 ms of the first call). The caller owns it and destroys it when no more of its pages will be asked for.
export interface PageSource { face: number; x0: number; y0: number; rivers: FineRiver[][]; segs: GPUBuffer; bins: GPUBuffer; packed: GPUBuffer; field: GPUBuffer; destroy(): void }
export function pageSource(g: Gpu, source: TileSource, face: number, x0: number, y0: number): PageSource {
  const rivers = windowRivers(source), { seg, table } = segments(rivers), words = packTile(source, 0, halo, 4);
  words.set([x0 * 4 * CELL, y0 * 4 * CELL, face], L.GEO_AT);
  const segs = storage(g, seg), bins = storage(g, table), packed = storage(g, words), field = storage(g, L.FINE_WORDS * 4);
  return { face, x0, y0, rivers, segs, bins, packed, field, destroy: () => { for (const b of [segs, bins, packed, field]) b.destroy(); } };
}

// The pages whose corner cells are (px, py) of the source's face, made into their slots from the source: each page lies within the window's 256 cells. One raster and one fine run over
// each page's lattice and the halo its heights need (runs overlap where pages touch), then the page kernels read the field; nothing
// comes back, the call returns once the work is queued. The caller owns the atlas.
export function groundPages(g: Gpu, atlas: PageAtlas, src: PageSource, list: PageSpec[]): GroundPage[] {
  const { face, x0, y0, segs, bins, packed, field } = src, win = L.Q / 4, pages: GroundPage[] = [], params = new Uint32Array(list.length * PAGE_PARAMS);
  // the window's nodes the page's blur and gradient read, held to where the heights are the planet's (the crop's first and last 3 nodes, and the slope's step, are held flat)
  const inner = (o: number) => 6 * o - PAGE_HALO_NODES >= 6 && 6 * (o + PAGE_CELLS) + PAGE_HALO_NODES <= 6 * win - 6;
  list.forEach((s, k) => {
    const ox = s.px - x0, oy = s.py - y0;
    if (ox < 0 || oy < 0 || ox + PAGE_CELLS > win || oy + PAGE_CELLS > win) throw new Error(`groundPages: the page at ${s.px}, ${s.py} is not within the window at ${x0}, ${y0}`);
    if (s.slot < 0 || s.slot >= atlas.slots) throw new Error(`groundPages: slot ${s.slot} of ${atlas.slots}`);
    params.set([s.slot, 4 * ox, 4 * oy, k], k * PAGE_PARAMS);
    pages.push({ ...s, face, exact: inner(ox) && inner(win - PAGE_CELLS - oy) });
  });
  const rast = pipeline(g, RASTER_RECT, "raster"), fin = pipeline(g, FINE_RECT, "fine");
  const rect = (pipe: GPUComputePipeline, binds: GPUBuffer[], r: [number, number, number, number]) => {
    const b = storage(g, Uint32Array.from(r));
    dispatch(g, pipe, [...binds, b], [Math.ceil((r[2] * r[3]) / 256)]);
    b.destroy();
  };
  for (const s of list) {
    const u0 = Math.max(0, 4 * (s.px - x0) - PAGE_HALO_VERTS), u1 = Math.min(L.m - 1, 4 * (s.px - x0 + PAGE_CELLS) + PAGE_HALO_VERTS);
    const v0 = Math.max(0, 4 * (s.py - y0) - PAGE_HALO_VERTS), v1 = Math.min(L.m - 1, 4 * (s.py - y0 + PAGE_CELLS) + PAGE_HALO_VERTS);
    // a vertex reads the mask texel 4 across and 4 down from the lattice's corner: the word of that column, the row; the page's own texels are inside (the last word column and row held to the plane)
    const c1 = Math.min(RM / 4 - 1, u1), r0 = 4 * v0, r1 = Math.min(RM - 1, 4 * v1);
    rect(rast, [segs, bins, field], [u0, r0, c1 - u0 + 1, r1 - r0 + 1]);
    rect(fin, [packed, field], [u0, v0, u1 - u0 + 1, v1 - v0 + 1]);
  }
  const pg = storage(g, params), scratch = storage(g, list.length * 2 * PAGE_SCRATCH_LAYER_WORDS * 4), heights = storage(g, M * FINE_PITCH * 4), n = list.length;
  dispatch(g, pipeline(g, PAGE_HEIGHTS, "pageHeights"), [field, heights], [Math.ceil((M * M) / 256)]);
  dispatch(g, pipeline(g, PAGE_FINE, "pageFine"), [field, atlas.fine, pg], [Math.ceil((PAGE_NV * PAGE_NV) / 256), n]);
  dispatch(g, pipeline(g, PAGE_MASK_K, "pageMask"), [field, atlas.mask, pg], [Math.ceil(PAGE_MASK_WORDS / 256), n]);
  dispatch(g, pipeline(g, PAGE_HEIGHT, "pageHeight"), [heights, atlas.grid, scratch, pg], [Math.ceil((PAGE_HN * PAGE_HN) / 256), n]);
  dispatch(g, pipeline(g, PAGE_FOLDS, "pageBlurX"), [heights, atlas.grid, scratch, pg], [Math.ceil((PAGE_NG * PAGE_HN) / 256), n]);
  const cover = Math.ceil((PAGE_NG * PAGE_NG) / 256);
  dispatch(g, pipeline(g, PAGE_FOLDS, "pageBlurY"), [heights, atlas.grid, scratch, pg], [cover, n]);
  dispatch(g, pipeline(g, PAGE_FOLDS, "pageGradient"), [heights, atlas.grid, scratch, pg], [cover, n]);
  for (const b of [pg, scratch, heights]) b.destroy();
  return pages;
}

// The heights (layer 0 of the fine layers, PAGE_NV rows of PAGE_NV vertices, the rows as the page stores them) of the pages in `slots`, read back once the pages' work is done: for the camera's
// own heights, which the page makes from them (live.js cameraHeightsOf) and the highest ground.
export async function pageHeights(g: Gpu, atlas: PageAtlas, slots: number[]): Promise<Float32Array[]> {
  const layer = PAGE_FINE_LAYER_WORDS * 4, rb = g.device.createBuffer({ size: Math.max(4, slots.length * layer), usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST }), enc = g.device.createCommandEncoder();
  slots.forEach((s, k) => enc.copyBufferToBuffer(atlas.fine, s * PAGE_FINE_WORDS * 4, rb, k * layer, layer));
  g.device.queue.submit([enc.finish()]);
  await rb.mapAsync(GPUMapMode.READ);
  const all = new Float32Array(rb.getMappedRange().slice(0)), out = slots.map((_, k) => {
    const h = new Float32Array(PAGE_NV * PAGE_NV);
    for (let r = 0; r < PAGE_NV; r++) h.set(all.subarray((k * layer) / 4 + r * PAGE_FINE_PITCH, (k * layer) / 4 + r * PAGE_FINE_PITCH + PAGE_NV), r * PAGE_NV);
    return h;
  });
  rb.unmap(); rb.destroy();
  return out;
}

// Where a page's lines meet its neighbours', in the face's axes (x east, y along the lattice's rows) and the stored rows (turned: row 0 is the page's last lattice row): for each side the
// neighbour's corner and the index of the shared vertex line in this page and in the neighbour's (fine 0 to 256, grid 0 to 384; the masks have none). A bilinear read at the page's far
// edge (i = 256) takes its pair from the page itself held to 255, so no read needs a neighbour; a painter that picks a page by floor of the position needs only these to swap pages without a seam.
export interface PageEdge { px: number; py: number; axis: "col" | "row"; fine: [number, number]; grid: [number, number] }
export function pageEdges(p: { px: number; py: number }): { xm: PageEdge; xp: PageEdge; ym: PageEdge; yp: PageEdge; haloVertices: number; haloNodes: number } {
  const e = (px: number, py: number, axis: "col" | "row", mine: number, theirs: number): PageEdge => ({ px, py, axis, fine: [mine ? PAGE_NV - 1 : 0, theirs ? PAGE_NV - 1 : 0], grid: [mine ? PAGE_NG - 1 : 0, theirs ? PAGE_NG - 1 : 0] });
  return {
    xm: e(p.px - PAGE_CELLS, p.py, "col", 0, 1), xp: e(p.px + PAGE_CELLS, p.py, "col", 1, 0),
    // y runs along the lattice's rows, which are stored turned: the page below (py - 64) meets this page's last stored row
    ym: e(p.px, p.py - PAGE_CELLS, "row", 1, 0), yp: e(p.px, p.py + PAGE_CELLS, "row", 0, 1),
    haloVertices: PAGE_HALO_VERTS, haloNodes: PAGE_HALO_NODES,
  };
}

// Every kernel a window's ground and scatter run, compiling off the frames' queue; resolves when all are made.
export function warmWindow(g: Gpu): Promise<unknown> {
  const own: [string, string][] = [[RASTER_RECT, "raster"], [FINE_RECT, "fine"], [PAGE_FINE, "pageFine"], [PAGE_MASK_K, "pageMask"], [PAGE_HEIGHTS, "pageHeights"], [PAGE_HEIGHT, "pageHeight"], [PAGE_FOLDS, "pageBlurX"], [PAGE_FOLDS, "pageBlurY"], [PAGE_FOLDS, "pageGradient"]];
  return Promise.all([warmScatter(g, halo, true), ...own.concat(placeKernels).map(([src, entry]) => pipelineSoon(g, src, entry))]);
}
