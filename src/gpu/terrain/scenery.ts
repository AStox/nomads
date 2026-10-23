// The island's 3 m ground and its objects on the GPU (wgsl/terrain-scenery.ts holds the formats and the laws): the stream
// mask and the fine field (fineGroundGpu), every tree, bush and low plant the ground carries (sceneryGpu), and the
// clasts' counts (clasts). The functions take and return what src/terrain/flora.ts's CPU functions did: a Fine and a
// Scatter in the CPU's units, read back from the GPU's integers at these edges only.
import { CELL } from "../../terrain/grid";
import { COVERS, M, RM, SIZE, TILES, fineRivers, fineView, type Fine, type FineParts, type FineRiver, type Scatter } from "../../terrain/flora";
import type { Island } from "../../terrain/island";
import type { Gpu } from "../device";
import { dispatch, pipeline, readback, storage } from "../kernel";
import { BIN, CHUNK, COUNT, FINE, FINE_AT, FINE_WORDS, FINE_KERNEL, GEO_AT, GRAD_AT, GRADIENTS, ISLAND_SCENERY, IDX, ISLE, ISLE_WORDS, LEN, MV, NQ, NS, ORE_CAP, RASTER, RMW, T, TAB_AT, TABLE, WRITE, clastKernel, layoutOf, type SceneryLayout } from "../wgsl/terrain-scenery";

// The fields of the island the scenery reads.
export type SceneryIsland = Pick<Island, "height" | "water" | "moist" | "tree" | "shrub" | "grass" | "marsh" | "bare" | "sand" | "soil" | "silt" | "clayey" | "ph" | "winterTable" | "soilWater" | "rivers"> & {
  seasons: { sun: Float32Array; temp: Float32Array }[];
};

const Q16 = 65536, Q24 = 16777216;
const FIELD: Record<(typeof ISLE)[number], (isle: SceneryIsland) => ArrayLike<number>> = {
  height: (i) => i.height, water: (i) => i.water, moist: (i) => i.moist, tree: (i) => i.tree, shrub: (i) => i.shrub, grass: (i) => i.grass,
  marsh: (i) => i.marsh, bare: (i) => i.bare, sand: (i) => i.sand, soil: (i) => i.soil, silt: (i) => i.silt, clayey: (i) => i.clayey, ph: (i) => i.ph, winter: (i) => i.winterTable,
  sun0: (i) => i.seasons[0].sun, sun1: (i) => i.seasons[1].sun, sun2: (i) => i.seasons[2].sun, sun3: (i) => i.seasons[3].sun,
  temp0: (i) => i.seasons[0].temp, temp1: (i) => i.seasons[1].temp, temp2: (i) => i.seasons[2].temp, temp3: (i) => i.seasons[3].temp,
  sw0: (i) => i.soilWater[0], sw1: (i) => i.soilWater[1], sw2: (i) => i.soilWater[2], sw3: (i) => i.soilWater[3],
};
const SCALE: Record<(typeof ISLE)[number], number> = {
  height: Q16, water: Q16, moist: Q24, tree: Q24, shrub: Q24, grass: Q24, marsh: Q24, bare: Q24, sand: Q24, soil: Q16, silt: Q24, clayey: Q24, ph: Q16, winter: Q16,
  sun0: Q16, sun1: Q16, sun2: Q16, sun3: Q16, temp0: Q16, temp1: Q16, temp2: Q16, temp3: Q16, sw0: Q24, sw1: Q24, sw2: Q24, sw3: Q24,
};
// The island's fields as the kernels hold them, and the gradient table of flora.ts noise after the tables the table
// kernel fills.
export function packIsle(isle: SceneryIsland): Int32Array {
  const out = new Int32Array(ISLE_WORDS);
  ISLE.forEach((name, f) => {
    const src = FIELD[name](isle), s = SCALE[name], at = f * LEN;
    for (let i = 0; i < LEN; i++) out[at + i] = Math.round(src[i] * s);
  });
  out.set(GRADIENTS, GRAD_AT);
  out.set([-38400, -38400, 0], GEO_AT); // the island's corner is 9,600 m before its centre (quarter metres)
  return out;
}

// The streams as segments (the two ends and half the stroke's width in Q16 texels, and the bed's depth in cm), binned
// BIN texels square in segment order (flora.ts's stack of strokes), as the raster kernel reads them.
export function segments(rivers: FineRiver[][]) {
  const px = (x: number) => ((x + SIZE / 2) / SIZE) * RM, bins = RM / BIN, lists: number[][] = Array.from({ length: bins * bins }, () => []);
  const seg: number[] = [];
  let n = 0;
  for (const line of rivers)
    for (let k = 1; k < line.length; k++) {
      const half = ((((line[k - 1][7] + line[k][7]) / 2) * RM) / SIZE + 1) / 2, deep = Math.min(255, Math.round(((line[k - 1][8] + line[k][8]) / 2) * 100));
      const ax = px(line[k - 1][0]), ay = px(line[k - 1][1]), bx = px(line[k][0]), by = px(line[k][1]);
      seg.push(Math.round(ax * Q16), Math.round(ay * Q16), Math.round(bx * Q16), Math.round(by * Q16), Math.round(half * Q16), deep, 0, 0);
      const i0 = Math.max(0, Math.floor(Math.min(ax, bx) - half - 1)), i1 = Math.min(RM - 1, Math.ceil(Math.max(ax, bx) + half + 1));
      const j0 = Math.max(0, Math.floor(Math.min(ay, by) - half - 1)), j1 = Math.min(RM - 1, Math.ceil(Math.max(ay, by) + half + 1));
      for (let b = Math.floor(j0 / BIN); b <= Math.floor(j1 / BIN); b++) for (let a = Math.floor(i0 / BIN); a <= Math.floor(i1 / BIN); a++) lists[b * bins + a].push(n);
      n++;
    }
  const table = new Uint32Array(bins * bins + 1 + lists.reduce((t, l) => t + l.length, 0));
  let at = bins * bins + 1;
  lists.forEach((l, b) => { table[b] = at - (bins * bins + 1); table.set(l, at); at += l.length; });
  table[bins * bins] = at - (bins * bins + 1);
  return { seg: Int32Array.from(seg.length ? seg : [0, 0, 0, 0, 0, 0, 0, 0]), table };
}

type FineOnGpu = { fine: Fine; isle: GPUBuffer; field: GPUBuffer };
// The fine field and the stream mask (flora.ts's fineGround). Its packed island and fine buffers are let go.
export async function fineGroundGpu(g: Gpu, isle: SceneryIsland): Promise<Fine> {
  const { fine, isle: packed, field } = await fineOnGpu(g, isle);
  packed.destroy(); field.destroy();
  return fine;
}
// The same, with the island's packed fields and the fine buffer returned too, on the GPU, for the scatter after (the
// caller destroys them).
async function fineOnGpu(g: Gpu, isle: SceneryIsland): Promise<FineOnGpu> {
  const rivers = fineRivers(isle), { seg, table } = segments(rivers);
  const segs = storage(g, seg), bins = storage(g, table), field = storage(g, FINE_WORDS * 4), packed = storage(g, packIsle(isle));
  dispatch(g, pipeline(g, RASTER, "raster"), [segs, bins, field], [Math.ceil(RMW / 256)]);
  dispatch(g, pipeline(g, FINE_KERNEL, "fine"), [packed, field], [Math.ceil(MV / 256)]);
  const [words, raw] = await Promise.all([readback(g, field, RMW * 4), readback(g, field, FINE.length * MV * 4, FINE_AT * 4)]);
  segs.destroy(); bins.destroy();
  const mask = new Uint8Array(words), v = new Int32Array(raw);
  const out = (k: number, scale: number) => {
    const f = new Float32Array(MV), at = k * MV;
    for (let i = 0; i < MV; i++) f[i] = v[at + i] / scale;
    return f;
  };
  const river = new Float32Array(MV);
  // a vertex's stream texel is the one 8 + 4 u across (the vertex's meters over the texel's 4.6875, exact)
  for (let v = 0, i = 0; v < M; v++) for (let u = 0; u < M; u++, i++) river[i] = mask[(8 + 4 * v) * RM + 8 + 4 * u] / 255;
  const parts: FineParts = {
    h: out(0, Q16), wet: out(1, Q24), river, moist: out(2, Q24),
    cover: Object.fromEntries(COVERS.map((c, k) => [c, out(3 + k, Q24)])) as FineParts["cover"], rivers, mask,
  };
  return { fine: fineView(isle, parts), isle: packed, field };
}

// A dispatch with its buffers bound where the entry point uses them (an entry that reads only some of a module's
// bindings has a layout of just those).
export function run(g: Gpu, p: GPUComputePipeline, binds: [number, GPUBuffer][], groups: [number, number?, number?]) {
  const bind = g.device.createBindGroup({ layout: p.getBindGroupLayout(0), entries: binds.map(([binding, buffer]) => ({ binding, resource: { buffer } })) });
  const enc = g.device.createCommandEncoder(), pass = enc.beginComputePass();
  pass.setPipeline(p);
  pass.setBindGroup(0, bind);
  pass.dispatchWorkgroups(groups[0], groups[1] ?? 1, groups[2] ?? 1);
  pass.end();
  g.device.queue.submit([enc.finish()]);
}

// The kernels' texts for a layout (the island's, or a tile's: wgsl/terrain-scenery.ts SceneryFormat).
export interface SceneryKernels { fine: string; table: string; count: string; write: string }
export const ISLAND_KERNELS: SceneryKernels = { fine: FINE_KERNEL, table: TABLE, count: COUNT, write: WRITE };

// When on, each stage of objectsOn waits for the GPU and adds its milliseconds here (a measurement, off by default).
export const laps: { on: boolean; ms: Record<string, number> } = { on: false, ms: {} };
const lap = async (g: Gpu, name: string, t0: number) => {
  if (!laps.on) return t0;
  await g.device.queue.onSubmittedWorkDone();
  const t = performance.now();
  laps.ms[name] = (laps.ms[name] ?? 0) + (t - t0);
  return t;
};
// Every object on the fields in `packed` (the packed fields and the fine buffer, which are let go): the tables, the draws counted by quad and written where the counts put them, read back as
// a Scatter in the CPU's units. `key` is the first quad's key (0 on the island; a tile's quads' keys run on from its own: scatter.ts).
// A rectangle of the area's cells, x0, y0 and the width and height, in cells from the area's corner.
export interface CellWindow { x0: number; y0: number; w: number; h: number }
// What a windowed run returns: the whole-area run's entries whose place lies in the window, in its order, each with its index in the whole run (`ids`; `oreIds` for the ore), so that an id is the
// same whether the window or the whole was asked for. An entry's cell is the one its place (px, py in game tiles of 2 cells) lies in.
export type WindowedScatter = Scatter & { ids: Uint32Array; oreIds: Uint32Array };
export async function objectsOn(g: Gpu, L: SceneryLayout, K: SceneryKernels, packed: GPUBuffer, field: GPUBuffer, seed: number, key: number): Promise<Scatter>;
export async function objectsOn(g: Gpu, L: SceneryLayout, K: SceneryKernels, packed: GPUBuffer, field: GPUBuffer, seed: number, key: number, window: CellWindow): Promise<WindowedScatter>;
// The draws are counted over every quad, so that each entry's place in the run (its id) is the whole run's; the write pass makes only the quads that can hold the window's entries and writes only
// those, and only the rows of game tiles the window touches are read back.
export async function objectsOn(g: Gpu, L: SceneryLayout, K: SceneryKernels, packed: GPUBuffer, field: GPUBuffer, seed: number, key: number, window?: CellWindow): Promise<Scatter | WindowedScatter> {
  const { IDX } = L;
  let t = performance.now();
  const { idx, out, start, n, oreN, from, to } = await objectsGpu(g, L, K, packed, field, seed, key, window, true);
  t = performance.now();
  const word = async (b: GPUBuffer) => { const raw = to > from ? await readback(g, b, (to - from) * 4, from * 4) : new ArrayBuffer(0); b.destroy(); return raw; };
  const [pxRaw, pyRaw, szRaw, sdRaw, ksRaw] = [await word(out[0]), await word(out[1]), await word(out[2]), await word(out[3]), await word(out[4])];
  const tail = new Uint32Array(await readback(g, idx, (IDX.flag - IDX.seed + 1) * 4, IDX.seed * 4)), oreRaw = new Uint32Array(await readback(g, idx, 4 * Math.max(1, oreN) * 4, IDX.ore * 4));
  t = await lap(g, "readback", t);
  if (tail[IDX.flag - IDX.seed] !== 0) throw new Error("the second pass drew other entries than the first counted");
  idx.destroy(); packed.destroy(); field.destroy();
  // the game's tile coordinate and the size, from their integers, in place (the same float32 a CPU division stores)
  if (window) return windowed(window, from, to, [pxRaw, pyRaw, szRaw, sdRaw, ksRaw], oreRaw, oreN);
  const pxU = new Uint32Array(pxRaw), pyU = new Uint32Array(pyRaw), szU = new Uint32Array(szRaw), ks = new Uint32Array(ksRaw);
  const px = new Float32Array(pxRaw), py = new Float32Array(pyRaw), size = new Float32Array(szRaw), kind = new Uint8Array(n), species = new Uint8Array(n);
  for (let i = 0; i < n; i++) { px[i] = pxU[i] / 1e4; py[i] = pyU[i] / 1e4; size[i] = szU[i] / 1e6; kind[i] = ks[i] & 255; species[i] = ks[i] >>> 8; }
  const ore: Scatter["ore"] = [];
  for (let k = 0; k < oreN; k++) ore.push({ px: Math.fround(oreRaw[4 * k] / 1e4), py: Math.fround(oreRaw[4 * k + 1] / 1e4), size: oreRaw[4 * k + 2] / 1e6, seed: oreRaw[4 * k + 3] });
  return { n, start, kind, species, px, py, size, seed: new Uint32Array(sdRaw), ore };
}

// What the draws leave on the GPU: the entries' arrays (px, py, size, seed, ks as the write kernel puts them, indexed by the entry's place in the whole run), the run's starts by game tile,
// and the span [from, to) of entries the window's rows hold (the whole run without a window). The caller owns the buffers (idx too, which the loose ore is read from).
export interface GpuRun { idx: GPUBuffer; out: GPUBuffer[]; start: Int32Array; n: number; oreN: number; from: number; to: number }
// written false counts the draws only (the starts by game tile) and makes no arrays.
export async function objectsGpu(g: Gpu, L: SceneryLayout, K: SceneryKernels, packed: GPUBuffer, field: GPUBuffer, seed: number, key: number, window?: CellWindow, written = true): Promise<GpuRun> {
  const { IDX, NQ } = L;
  let t = performance.now();
  run(g, pipeline(g, K.table, "table"), [[0, packed]], [Math.ceil(L.LEN / 64)]);
  t = await lap(g, "table", t);
  const idx = storage(g, IDX.words * 4);
  g.device.queue.writeBuffer(idx, IDX.seed * 4, new Uint32Array([seed >>> 0]));
  g.device.queue.writeBuffer(idx, IDX.key * 4, new Uint32Array([key >>> 0]));
  const x1 = window ? Math.max(0, window.x0 + window.w) : 0xffff, y1 = window ? Math.max(0, window.y0 + window.h) : 0xffff;
  g.device.queue.writeBuffer(idx, IDX.win * 4, new Uint32Array(window ? [Math.max(0, window.x0), Math.max(0, window.y0), window.w > 0 && window.h > 0 ? x1 : 0, window.w > 0 && window.h > 0 ? y1 : 0] : [0, 0, 0xffff, 0xffff]));
  const base: [number, GPUBuffer][] = [[0, packed], [1, field], [2, idx]], count = pipeline(g, K.count, "count");
  run(g, count, base, [Math.ceil(NQ / 64)]);
  run(g, pipeline(g, K.count, "rank"), [[2, idx]], [Math.ceil(T / 64)]);
  run(g, pipeline(g, K.count, "rows"), [[2, idx]], [Math.ceil(Math.sqrt(NQ) / 64)]);
  run(g, pipeline(g, K.count, "scan"), [[2, idx]], [1]);
  t = await lap(g, "count", t);
  const meta = new Uint32Array(await readback(g, idx, (IDX.start + T + 1 - IDX.seed) * 4, IDX.seed * 4));
  t = performance.now();
  if (meta[IDX.flag - IDX.seed] !== 0) throw new Error("a quad's entries have no place in any tile's run");
  const start = Int32Array.from(meta.subarray(IDX.start - IDX.seed, IDX.start - IDX.seed + T + 1)), n = start[T], oreN = meta[IDX.oreTotal - IDX.seed];
  if (oreN > ORE_CAP) throw new Error(`${oreN} loose stones of ore, room for ${ORE_CAP}`);
  const counted: GpuRun = { idx, out: [], start, n, oreN, from: 0, to: 0 };
  if (written) {
    objectsWrite(g, L, K, packed, field, counted);
    t = await lap(g, "write", t);
  }
  const out = counted.out;
  // the game tiles' rows the window touches (an entry lies in the game tile its place is in, and a game tile is 2 cells): their runs are contiguous in the arrays
  const rows = window ? { lo: Math.max(0, Math.floor(Math.max(0, window.y0) / 2) - 1), hi: Math.min(TILES - 1, Math.floor((y1 - 1) / 2) + 1) } : { lo: 0, hi: TILES - 1 };
  const from = window ? (window.w > 0 && window.h > 0 ? start[rows.lo * TILES] : 0) : 0, to = window ? (window.w > 0 && window.h > 0 ? start[(rows.hi + 1) * TILES] : 0) : n;
  return { idx, out, start, n, oreN, from, to };
}

// The write pass of a run counted with written false: makes the arrays (run.out) and fills them, the quads the window touches only.
export function objectsWrite(g: Gpu, L: SceneryLayout, K: SceneryKernels, packed: GPUBuffer, field: GPUBuffer, r: GpuRun) {
  r.out = ["px", "py", "size", "seed", "ks"].map(() => storage(g, Math.max(1, r.n) * 4));
  run(g, pipeline(g, K.write, "write"), [[0, packed], [1, field], [2, r.idx], ...r.out.map((b, k): [number, GPUBuffer] => [3 + k, b])], [Math.ceil(L.NQ / 64)]);
}

// The island's fine field and every object on it (flora.ts's fineGround and scatter): the Fine and the Scatter the sim
// and the page read, in the CPU's units. The objects of seed `seed` depend on nothing but it and the island.
export async function sceneryGpu(g: Gpu, isle: SceneryIsland, seed: number): Promise<{ fine: Fine; flora: Scatter }> {
  const { fine, isle: packed, field } = await fineOnGpu(g, isle);
  return { fine, flora: await objectsOn(g, layoutOf(ISLAND_SCENERY), ISLAND_KERNELS, packed, field, seed, 0) };
}

// The per-cell tables alone: each plant's fit (Q24) and compensation point (Q23) at every cell, cell-major, as floats. For
// the test.
export async function tablesGpu(g: Gpu, isle: SceneryIsland): Promise<{ fit: Float32Array; comp: Float32Array }> {
  const packed = storage(g, packIsle(isle));
  run(g, pipeline(g, TABLE, "table"), [[0, packed]], [Math.ceil(LEN / 64)]);
  const raw = new Int32Array(await readback(g, packed, 2 * NS * LEN * 4, TAB_AT * 4));
  packed.destroy();
  const fit = new Float32Array(NS * LEN), comp = new Float32Array(NS * LEN);
  for (let i = 0; i < NS * LEN; i++) { fit[i] = raw[i] / 2 ** 24; comp[i] = raw[NS * LEN + i] / 2 ** 23; }
  return { fit, comp };
}

// The laws on inputs, eight words each (the operation, three arguments, the answer), as wgsl/terrain-scenery.ts probe
// reads them: 0 treeMm(plant, fit Q24, word), 1 crownOf(plant, mm), 2 bushMm(plant, fit Q24, word), 3 noise(seed, x, y in Q20),
// 4 fbm of three octaves at a 240 m scale (seed, x, y in quarter meters). The answers are Q24, Q16 or mm as the law has them.
export async function lawsGpu(g: Gpu, rows: readonly (readonly number[])[]): Promise<Uint32Array> {
  const idx = storage(g, IDX.words * 4), isle = storage(g, (() => { const w = new Int32Array(ISLE_WORDS); w.set(GRADIENTS, GRAD_AT); return w; })());
  const inp = new Uint32Array(rows.length * 8);
  rows.forEach((r, k) => inp.set(r.map((x) => x >>> 0), k * 8));
  g.device.queue.writeBuffer(idx, IDX.base * 4, inp);
  run(g, pipeline(g, COUNT, "probe"), [[0, isle], [2, idx]], [Math.ceil(rows.length / 64)]);
  const out = new Uint32Array(await readback(g, idx, inp.byteLength, IDX.base * 4));
  idx.destroy(); isle.destroy();
  return Uint32Array.from({ length: rows.length }, (_, k) => out[k * 8 + 4]);
}

// How many boulders (2 dm and up), stones (1 to 2 dm) and pebbles (2 cm to 1 dm) lie in each of the generator's cells,
// the GPU's clasts (src/gpu/deadwood.ts CLASTS): boulders at its drift's count a ha, the smaller classes as many times
// that as till's N(> d) ~ d^-2.9 has them, on the cell's ground out of standing water. Nothing lies on the sea or a
// lake's bed. perHa is by drift kind, dim the power law's exponent, bounds each class's diameters in m (the last class
// is the boulders').
export async function clasts(g: Gpu, isle: Pick<Island, "water" | "height" | "drift">, seed: number, perHa: readonly number[], dim: number, bounds: readonly (readonly [number, number])[]): Promise<Uint32Array[]> {
  const ha = (CELL * CELL) / 1e4, lo = bounds[bounds.length - 1][0], nc = bounds.length, nd = perHa.length;
  const inp = new Int32Array(3 * LEN + 2 * nc * nd + 1);
  for (let i = 0; i < LEN; i++) { inp[i] = Math.round(isle.water[i] * 65536); inp[LEN + i] = Math.round(isle.height[i] * 65536); inp[2 * LEN + i] = isle.drift[i]; }
  bounds.forEach(([a, b], c) => perHa.forEach((per, d) => {
    const lam = per * ha * ((a / lo) ** -dim - (b / lo) ** -dim), whole = Math.floor(lam / CHUNK);
    inp[3 * LEN + 2 * (c * nd + d)] = whole;
    inp[3 * LEN + 2 * (c * nd + d) + 1] = Math.round((lam - whole * CHUNK) * 65536);
  }));
  inp[3 * LEN + 2 * nc * nd] = seed >>> 0;
  const input = storage(g, inp), output = storage(g, nc * LEN * 4);
  dispatch(g, pipeline(g, clastKernel(nc, nd), "clasts"), [input, output], [Math.ceil(LEN / 64)]);
  const raw = new Uint32Array(await readback(g, output));
  input.destroy(); output.destroy();
  return bounds.map((_, c) => raw.slice(c * LEN, (c + 1) * LEN));
}

// The window's entries of the whole run, from the span of the arrays read back (entries from `from`): a written entry has a size, an unwritten word is 0.
function windowed(w: CellWindow, from: number, to: number, raw: ArrayBuffer[], oreRaw: Uint32Array, oreN: number): WindowedScatter {
  const [pxRaw, pyRaw, szRaw, sdRaw, ksRaw] = raw.map((r) => new Uint32Array(r)), inside = (tx4: number, ty4: number) => {
    const cx = Math.floor((tx4 * 2) / 10000), cy = Math.floor((ty4 * 2) / 10000);
    return cx >= w.x0 && cx < w.x0 + w.w && cy >= w.y0 && cy < w.y0 + w.h;
  };
  const keep: number[] = [];
  for (let i = 0; i < to - from; i++) if (szRaw[i] !== 0 && inside(pxRaw[i], pyRaw[i])) keep.push(i);
  const m = keep.length, px = new Float32Array(m), py = new Float32Array(m), size = new Float32Array(m), kind = new Uint8Array(m), species = new Uint8Array(m), seed = new Uint32Array(m), ids = new Uint32Array(m);
  keep.forEach((i, j) => { px[j] = pxRaw[i] / 1e4; py[j] = pyRaw[i] / 1e4; size[j] = szRaw[i] / 1e6; kind[j] = ksRaw[i] & 255; species[j] = ksRaw[i] >>> 8; seed[j] = sdRaw[i]; ids[j] = from + i; });
  const start = new Int32Array(TILES * TILES + 1);
  for (let j = 0; j < m; j++) start[Math.min(TILES - 1, Math.floor(py[j])) * TILES + Math.min(TILES - 1, Math.floor(px[j])) + 1]++;
  for (let t = 0; t < TILES * TILES; t++) start[t + 1] += start[t];
  const ore: Scatter["ore"] = [], oreIds: number[] = [];
  for (let k = 0; k < oreN; k++) if (oreRaw[4 * k + 2] !== 0 && inside(oreRaw[4 * k], oreRaw[4 * k + 1])) { ore.push({ px: Math.fround(oreRaw[4 * k] / 1e4), py: Math.fround(oreRaw[4 * k + 1] / 1e4), size: oreRaw[4 * k + 2] / 1e6, seed: oreRaw[4 * k + 3] }); oreIds.push(k); }
  return { n: m, start, kind, species, px, py, size, seed, ore, ids, oreIds: Uint32Array.from(oreIds) };
}
