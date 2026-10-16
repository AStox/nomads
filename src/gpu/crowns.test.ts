// The crown raster (wgsl/crowns.ts, driven by crowns.ts): the pass against a TypeScript oracle bit for bit on both of
// the dev machine's adapters, the CPU's copy landing a slice a tick, crowns over crowns adding layers without a cap, and
// a felled stem's crown gone from the raster after the next pass and not before (plan Unit 12).
import { afterAll, expect, test } from "bun:test";
import { openGpu, releaseGpu, theGpu, type Gpu } from "./device";
import { Store } from "./store";
import { readback } from "./kernel";
import { Flora, PLANT, type StemDay, type StemDriver } from "./flora";
import { Crowns, SLICES } from "./crowns";
import { CELLS as CELL_N } from "./wgsl/index";
import { CELLS, CELL_AT, QMAX, QSHIFT, SIDE, T1, TEXELS, WORDS, layered } from "./wgsl/crowns";
import { HC, HQ, MAP, ROWS, ROW_WORDS, RW, SSTEP, TEXEL_MM, TREE_ROWS } from "./wgsl/stems";
import { FLORA, SPECIES, TILES, TILE_M, type Scatter } from "../terrain/flora";
import { CELL } from "../terrain/grid";
import { stemTables } from "../sim/plants";

afterAll(releaseGpu);

const K = (k: (typeof FLORA)[number]) => FLORA.indexOf(k), S = (s: (typeof SPECIES)[number]) => SPECIES.indexOf(s);
const TABLES = stemTables();
const TEXEL_M = TEXEL_MM / 1000;
type Stem = [kind: number, species: number, x: number, y: number, height: number];

function scatterOf(stems: Stem[]): Scatter {
  const tileOf = (s: Stem) => Math.min(TILES - 1, Math.floor(s[3] / TILE_M)) * TILES + Math.min(TILES - 1, Math.floor(s[2] / TILE_M));
  const rows = [...stems].sort((a, b) => tileOf(a) - tileOf(b)), n = rows.length, start = new Int32Array(TILES * TILES + 1);
  for (const r of rows) start[tileOf(r) + 1]++;
  for (let t = 0; t < TILES * TILES; t++) start[t + 1] += start[t];
  const at = (m: number) => Math.fround(Math.round((m / TILE_M) * 1e4) / 1e4);
  return {
    n, start, kind: Uint8Array.from(rows, (r) => r[0]), species: Uint8Array.from(rows, (r) => r[1]),
    px: Float32Array.from(rows, (r) => at(r[2])), py: Float32Array.from(rows, (r) => at(r[3])),
    size: Float32Array.from(rows, (r) => Math.fround(Math.round(r[4] * 1000) / 1000)), seed: Uint32Array.from(rows, (_, i) => (0x9e3779b9 * (i + 1)) >>> 0), ore: [],
  };
}
// Days of no growth and no loss, so the stems stand as laid, unless a test says otherwise.
const still = (): StemDay => ({ coef: new Int32Array(CELL_N * ROWS * 2), mast: new Array(ROWS).fill(0) });
async function staged(g: Gpu, stems: Stem[], day: () => StemDay = still, due: (t: number) => boolean = () => true) {
  const s = new Store(g), flora = new Flora(scatterOf(stems)), crowns = new Crowns();
  const driver: StemDriver = { due, tables: () => TABLES, day: () => day() };
  flora.attach(s, driver);
  await crowns.attach(s, { raster: () => flora.raster() }, due);
  return { s, flora, crowns };
}

// ---------- the oracle ----------
function crownAt(r: number, s: number) {
  const t = TABLES.tables, base = TREE_ROWS * HQ + r * HC, j = Math.min(s >>> SSTEP, HC - 2), lo = t[base + j], hi = t[base + j + 1], f = Math.min(s - j * 2 ** SSTEP, 2 ** SSTEP);
  return lo + Math.floor(((hi - lo) * f) / 2 ** SSTEP);
}
// The words from a plant body as it stood when the raster was filed.
function oracle(b: Uint32Array, cap: number, field: Record<string, number>): Uint32Array {
  const at = (name: string) => (1 + field[name]) * cap, X = at("x"), Y = at("y"), W = at("what"), Z = at("size");
  const pine = new Float64Array(TEXELS), broad = new Float64Array(TEXELS), wh = new Float64Array(CELLS), hw = new Float64Array(CELLS);
  for (let i = 0; i < cap; i++) {
    if (!(b[i] & 1)) continue;
    const r = TABLES.rows[Math.min(b[W + i] >>> 8, MAP - 1)];
    if (TABLES.rows[MAP + r * ROW_WORDS + RW.tree] !== 1) continue;
    const tx = Math.min(Math.floor(b[X + i] / TEXEL_MM), SIDE - 1), ty = Math.min(Math.floor(b[Y + i] / TEXEL_MM), SIDE - 1), t = ty * SIDE + tx;
    const c = (ty >> 2) * (SIDE / 4) + (tx >> 2), a = crownAt(r, b[Z + i]), k = (a >>> 8) + 1;
    if (r === 0) pine[t] += a; else broad[t] += a;
    wh[c] += k; hw[c] += k * Math.floor(b[Z + i] / 100);
  }
  const out = new Uint32Array(WORDS);
  for (let t = 0; t < TEXELS; t++) out[t] = (Math.min(Math.floor(pine[t] / 2 ** QSHIFT), QMAX) | (Math.min(Math.floor(broad[t] / 2 ** QSHIFT), QMAX) << 16)) >>> 0;
  for (let c = 0; c < CELLS; c++) out[CELL_AT + c] = wh[c] > 0 ? Math.min(Math.floor(hw[c] / wh[c]), 0xffff) : 0;
  return out;
}

// A few thousand stems over 3 x 3 texels round a cell corner, trees and bushes of every kind, piled deep enough that
// texels hold several layers of crowns; growing days, the pass after each.
async function oracleRun(g: Gpu) {
  let seed = 11;
  const rand = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
  const kinds: [number, number][] = [[K("tree"), S("pine")], [K("tree"), S("oak")], [K("tree"), S("ash")], [K("tree"), S("aspen")], [K("bush"), S("hazel")]];
  const x0 = 100 * CELL - 1.5 * TEXEL_M, stems: Stem[] = [];
  for (let k = 0; k < 3000; k++) {
    const [kind, sp] = kinds[Math.floor(rand() * kinds.length)];
    stems.push([kind, sp, x0 + rand() * 3 * TEXEL_M, x0 + rand() * 3 * TEXEL_M, kind === K("tree") ? 2 + Math.floor(rand() * 12) * 2.5 : 1.5]);
  }
  const days: StemDay[] = [0, 1, 2].map(() => {
    const coef = new Int32Array(CELL_N * ROWS * 2);
    for (let i = 0; i < coef.length; i += 2) { coef[i] = 30000; coef[i + 1] = 2000; }
    return { coef, mast: new Array(ROWS).fill(0) };
  });
  let d = 0, due = true;
  const { s, flora, crowns } = await staged(g, stems, () => days[d], () => due);
  const k = s.kind(PLANT), passes: Uint32Array[] = [];
  let body = await s.read(PLANT, "body");
  expect(crowns.held()).toEqual(oracle(body, k.capacity, k.field));
  for (d = 0; d < 3; d++) {
    const want = oracle(body, k.capacity, k.field);
    await s.step(d + 1);
    s.flush();
    const got: Uint32Array = new Uint32Array(await readback(s.g, crowns.buf!));
    expect(got).toEqual(want);
    passes.push(want);
    body = await s.read(PLANT, "body");
  }
  // the CPU's copy comes back a slice a tick, the pass's own tick carrying the first: the last pass is whole after
  // SLICES ticks, and the CPU holds the pass before until then
  due = false;
  const cpu = crowns.passes;
  for (let t = 0; t < SLICES - 2; t++) await s.step(10 + t);
  expect(crowns.passes).toBe(cpu);
  await s.step(10 + SLICES);
  expect(crowns.passes).toBe(cpu + 1);
  expect(crowns.held()).toEqual(passes[2]);
  // the first pass, filed before any crowding thinned them
  const deep = passes[0].subarray(0, TEXELS).reduce((m, w) => Math.max(m, (w & 0xffff) + (w >>> 16)), 0);
  flora.destroy(); crowns.destroy(); s.destroy();
  return { passes, deep };
}

test("the crown pass equals the oracle bit for bit, on the high-performance and the low-power adapter alike, and the CPU's copy lands a slice a tick", async () => {
  const a = await oracleRun(await theGpu());
  // crowns piled more than two layers deep somewhere, so the sum is tested past the old cap
  expect(a.deep).toBeGreaterThan(2 * 4096);
  const low = await openGpu("low-power"), b = await oracleRun(low);
  expect(b.passes).toEqual(a.passes);
  low.device.destroy();
}, 180_000);

test("crowns over crowns add optical depth without a cap: each layer lets T through again, past two and on", () => {
  const L = (layers: number) => layered(Math.round(layers * 65536));
  expect(L(0)).toBe(65536);
  expect(L(1)).toBe(T1);
  expect(L(2)).toBeLessThan(L(1));
  expect(L(3)).toBeLessThan(L(2));
  expect(L(2.5)).toBeLessThan(L(2));
  expect(L(2.5)).toBeGreaterThan(L(3));
  // half a texel under one more layer: the mean of the two depths' light
  expect(Math.abs(L(1.5) - (L(1) + L(2)) / 2)).toBeLessThanOrEqual(1);
});

test("a felled stem's crown leaves the raster at the next crown pass, and not before", async () => {
  // a closed stand of twenty oaks in one texel and nothing else near
  const x0 = 300 * CELL + 2, stems: Stem[] = [];
  for (let i = 0; i < 20; i++) stems.push([K("tree"), S("oak"), x0 + (i % 5) * 3.5, x0 + Math.floor(i / 5) * 3.5, 18]);
  let pass = false;
  const { s, flora, crowns } = await staged(await theGpu(), stems, still, () => pass);
  const at = { x: (x0 + 7) * 1000, y: (x0 + 5) * 1000 }, before = crowns.coverAt(at.x, at.y).broad;
  expect(before).toBeGreaterThan(65536 / 2);
  const e = flora.writtenOf(K("tree"))[7];
  flora.change(e, null);
  await s.step(1);
  // felled on the GPU, but no pass yet: the light at its foot is as it was
  expect(crowns.coverAt(at.x, at.y).broad).toBe(before);
  pass = true;
  await s.step(2);
  pass = false;
  for (let t = 3; t < 3 + SLICES; t++) await s.step(t);
  const after = crowns.coverAt(at.x, at.y).broad;
  expect(after).toBeLessThan(before);
  // by its own crown's share: the twenty were alike
  expect(Math.abs(before - after - Math.round(before / 20))).toBeLessThanOrEqual(2 ** QSHIFT * 2);
  flora.destroy(); crowns.destroy(); s.destroy();
}, 120_000);
