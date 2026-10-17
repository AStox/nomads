// The stems' daily law (wgsl/stems.ts, driven by flora.ts): a TypeScript single-step oracle of every kernel, bit for bit
// on both of the dev machine's adapters, and the plan's checks (Unit 7): a closed oak stand holds Reineke's count, an
// open-grown stem reaches the calibrated heights, a stem in full shade starves by the peak/2 rule, no tree passes its
// stand's maximum crowding, and seed 1's stems by kind against the measured densities.
import { DAY, YEAR_DAYS, groundOf, newWorld } from "../sim/world";
import { GROWTH_C, TREE_KINDS, YEARS_PACE, calibratedHeight, stemDriver, stemTables, treeKg } from "../sim/plants";
import { afterAll, expect, test } from "bun:test";
import { openGpu, releaseGpu, theGpu, type Gpu } from "./device";
import { Store, type Kind } from "./store";
import { Flora, PLANT, type StemDay, type StemDriver } from "./flora";
import { CELLS } from "./wgsl/index";
import { FLORA, SPECIES, TILES, TILE_M, crownShare, dbhOf, type Scatter } from "../terrain/flora";
import { CELL, N } from "../terrain/grid";
import { DIED, HALF_Q, HC, HQ, MAP, QSTEP, ROWS, ROW_WORDS, RW, SSTEP, TEXELS_SIDE, TEXEL_MM, TREE_ROWS } from "./wgsl/stems";
import { layered } from "./wgsl/crowns";

afterAll(releaseGpu);

const K = (k: (typeof FLORA)[number]) => FLORA.indexOf(k), S = (s: (typeof SPECIES)[number]) => SPECIES.indexOf(s);
const TABLES = stemTables();
const TEXEL_M = TEXEL_MM / 1000;

// ---------- the oracle ----------
type Layout = { cap: number; x: number; y: number; what: number; size: number; q: number; peak: number; crop: number };
const layoutOf = (k: Kind): Layout => {
  const at = (name: string) => (1 + k.field[name]) * k.capacity;
  return { cap: k.capacity, x: at("x"), y: at("y"), what: at("what"), size: at("size"), q: at("q"), peak: at("peak"), crop: at("crop") };
};
const rw = (rows: Uint32Array, r: number, w: number) => rows[MAP + r * ROW_WORDS + w];
const rowOf = (b: Uint32Array, L: Layout, rows: Uint32Array, i: number) => rows[Math.min(b[L.what + i] >>> 8, MAP - 1)];
const texelOf = (b: Uint32Array, L: Layout, i: number) => Math.min(Math.floor(b[L.y + i] / TEXEL_MM), TEXELS_SIDE - 1) * TEXELS_SIDE + Math.min(Math.floor(b[L.x + i] / TEXEL_MM), TEXELS_SIDE - 1);
function heightAt(t: Uint32Array, r: number, q: number) {
  const j = Math.min(q >>> QSTEP, HQ - 2), lo = t[r * HQ + j], hi = t[r * HQ + j + 1], f = Math.min(q - j * 2 ** QSTEP, 2 ** QSTEP);
  return lo + Math.floor(((hi - lo) * f) / 2 ** QSTEP);
}
function crownAt(t: Uint32Array, r: number, s: number) {
  const base = TREE_ROWS * HQ + r * HC, j = Math.min(s >>> SSTEP, HC - 2), lo = t[base + j], hi = t[base + j + 1], f = Math.min(s - j * 2 ** SSTEP, 2 ** SSTEP);
  return lo + Math.floor(((hi - lo) * f) / 2 ** SSTEP);
}
// stemsInit
function oracleInit(b: Uint32Array, L: Layout, tables: Uint32Array, rows: Uint32Array) {
  for (let i = 0; i < L.cap; i++) {
    if (!(b[i] & 1)) continue;
    const r = rowOf(b, L, rows, i);
    let q = 1 << 20;
    if (rw(rows, r, RW.tree) === 1) {
      let lo = 0, hi = rw(rows, r, RW.qmax);
      while (lo < hi) { const mid = (lo + hi) >>> 1; if (heightAt(tables, r, mid) >= b[L.size + i]) hi = mid; else lo = mid + 1; }
      q = lo;
    }
    b[L.q + i] = q;
    b[L.peak + i] = q;
  }
}
// stemsCount, stemsFile and stemsGrow: a day, from the body as it stood, into a new body
function oracleDay(before: Uint32Array, L: Layout, tables: Uint32Array, rows: Uint32Array, coef: Int32Array): Uint32Array {
  const b = before.slice(), byTexel = new Map<number, number[]>();
  for (let i = 0; i < L.cap; i++) if (before[i] & 1) { const t = texelOf(before, L, i); let l = byTexel.get(t); if (!l) byTexel.set(t, (l = [])); l.push(i); }
  for (let i = 0; i < L.cap; i++) {
    if (!(before[i] & 1)) continue;
    const r = rowOf(before, L, rows, i), tree = rw(rows, r, RW.tree) === 1, s = before[L.size + i], a = crownAt(tables, r, s);
    let above = 0, crowd = 0, taller = 0;
    for (const j of byTexel.get(texelOf(before, L, i))!) {
      if (j === i) continue;
      const rj = rowOf(before, L, rows, j), hj = before[L.size + j], aj = crownAt(tables, rj, hj), tj = rw(rows, rj, RW.tree) === 1;
      if (hj > s) above += aj; else if (hj === s) above += aj >>> 1;
      if (tree && tj && (hj > s || (hj === s && j < i))) { crowd += aj; taller++; }
    }
    const light = layered(above);
    const cell = Math.min(Math.floor(before[L.y + i] / (CELL * 1000)), N - 1) * N + Math.min(Math.floor(before[L.x + i] / (CELL * 1000)), N - 1);
    const alpha = coef[(cell * ROWS + r) * 2], beta = coef[(cell * ROWS + r) * 2 + 1];
    const gain = Math.floor((alpha * light) / 65536) - beta, q = before[L.q + i], qmax = rw(rows, r, RW.qmax);
    let nq = tree ? q + gain : q + (((q >>> 5) * gain) >> 11);
    nq = Math.max(0, Math.min(qmax, nq));
    const peak = Math.max(before[L.peak + i], nq);
    const starved = nq === 0 || nq < Math.floor(((peak >>> 8) * HALF_Q) / 256);
    if (starved || (tree && taller > 0 && crowd + a > 65536)) { b[i] = before[i] & ~1; b[L.crop + i] = DIED; continue; }
    b[L.q + i] = nq;
    b[L.peak + i] = peak;
    if (tree) b[L.size + i] = heightAt(tables, r, nq);
    b[L.crop + i] = rw(rows, r, RW.mast) * (rw(rows, r, RW.each) + Math.floor((rw(rows, r, RW.area) * a) / 65536));
  }
  return b;
}

// ---------- staging ----------
// A scatter of stems at places in metres from the island's north-west corner, each [kind, species, x, y, height].
function scatterOf(stems: [number, number, number, number, number][]): Scatter {
  const tileOf = (s: (typeof stems)[number]) => Math.min(TILES - 1, Math.floor(s[3] / TILE_M)) * TILES + Math.min(TILES - 1, Math.floor(s[2] / TILE_M));
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
// A driver whose every day is the one given (coefficients for every cell and row, the mast).
const driverOf = (day: () => StemDay): StemDriver => ({ due: () => true, tables: () => TABLES, day: () => day() });
// The q a tree gains a day in the open on the reference ground at a perfect fit, by the calibrated law, in q's units.
const dayGain = (sp: string) => Math.round((GROWTH_C[sp] / 4) * (YEARS_PACE / 365.25) * 2 ** 20);
// Coefficients for every cell: alpha 2g and beta g for each tree row, so a stem in full light gains g a day.
function openDay(gainOf: (r: number) => number, bushRate = 0): StemDay {
  const coef = new Int32Array(CELLS * ROWS * 2);
  for (let c = 0; c < CELLS; c++)
    for (let r = 0; r < ROWS; r++) {
      const g = r < TREE_ROWS ? gainOf(r) : bushRate;
      coef[(c * ROWS + r) * 2] = 2 * g; coef[(c * ROWS + r) * 2 + 1] = g;
    }
  return { coef, mast: new Array(ROWS).fill(0) };
}
async function staged(g: Gpu, stems: [number, number, number, number, number][], day: () => StemDay) {
  const s = new Store(g), flora = new Flora(scatterOf(stems));
  flora.attach(s, driverOf(day));
  return { s, flora, kind: s.kind(PLANT), L: layoutOf(s.kind(PLANT)) };
}
const live = (b: Uint32Array, n: number) => { let c = 0; for (let i = 0; i < n; i++) c += b[i] & 1; return c; };

// ---------- the oracle against the GPU ----------
// A few thousand stems over 3 x 3 texels round a cell corner (so they span four cells), trees and bushes of every kind,
// heights from a small set so many tie, under coefficients drawn per cell and row, five days.
async function oracleRun(g: Gpu) {
  let seed = 7;
  const rand = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
  const kinds: [number, number][] = [[K("tree"), S("pine")], [K("tree"), S("oak")], [K("tree"), S("ash")], [K("tree"), S("aspen")], [K("bush"), S("berry")], [K("bush"), S("hazel")], [K("bush"), S("heather")]];
  const x0 = 100 * CELL - 1.5 * TEXEL_M, stems: [number, number, number, number, number][] = [];
  for (let k = 0; k < 2500; k++) {
    const [kind, sp] = kinds[Math.floor(rand() * kinds.length)], tree = kind === K("tree");
    stems.push([kind, sp, x0 + rand() * 3 * TEXEL_M, x0 + rand() * 3 * TEXEL_M, tree ? 2 + Math.floor(rand() * 12) * 2.5 : 0.3 + Math.floor(rand() * 6) * 0.4]);
  }
  const days: StemDay[] = [];
  for (let d = 0; d < 5; d++) {
    const coef = new Int32Array(CELLS * ROWS * 2);
    for (let i = 0; i < coef.length; i += 2) { coef[i] = Math.floor(rand() * 40000); coef[i + 1] = Math.floor(rand() * 30000); }
    days.push({ coef, mast: Array.from({ length: ROWS }, () => (rand() < 0.5 ? 1 : 0)) });
  }
  let d = 0;
  const { s, flora, kind, L } = await staged(g, stems, () => days[d]);
  const rowsOf = (m: readonly number[]) => { const r = TABLES.rows.slice(); for (let i = 0; i < ROWS; i++) r[MAP + i * ROW_WORDS + RW.mast] = m[i]; return r; };
  // the generator's stems written, each given its mass: the oracle's init over the body as written
  let body = await s.read(PLANT, "body");
  const written = body.slice();
  for (let i = 0; i < L.cap; i++) if (written[i] & 1) { written[L.q + i] = 0; written[L.peak + i] = 0; }
  oracleInit(written, L, TABLES.tables, TABLES.rows);
  expect(body).toEqual(written);
  const bodies: Uint32Array[] = [];
  for (d = 0; d < 5; d++) {
    const want = oracleDay(body, L, TABLES.tables, rowsOf(days[d].mast), days[d].coef);
    await s.step(d + 1);
    body = await s.read(PLANT, "body");
    expect(body).toEqual(want);
    bodies.push(body);
  }
  // the CPU's heights after the last day are the GPU's
  for (let e = 1; e <= flora.n; e++) {
    const j = flora.slot(e), st = flora.stand(e);
    expect(st ? Math.round(st.size * 1000) : 0).toBe(body[j] & 1 ? body[L.size + j] : 0);
  }
  expect(live(body, L.cap)).toBeLessThan(stems.length);
  flora.destroy();
  s.destroy();
  return { bodies, kind };
}

test("a day of stems on the GPU equals the oracle's bit for bit, on the high-performance and the low-power adapter alike", async () => {
  const a = await oracleRun(await theGpu());
  const low = await openGpu("low-power"), b = await oracleRun(low);
  expect(b.bodies).toEqual(a.bodies);
  low.device.destroy();
}, 120_000);

// ---------- the plan's checks ----------
test("a closed oak stand holds Reineke's count within rounding as it grows, and no tree passes its maximum crowding", async () => {
  // a texel of oaks all 20 m tall, one more than Reineke's maximum for the texel at that height
  const H = 20, D = dbhOf("oak", H), reineke = (d: number) => ((733 * (25 / d) ** 1.424) * TEXEL_M * TEXEL_M) / 1e4;
  const n = Math.ceil(reineke(D)) + 1, x0 = 200 * CELL, stems: [number, number, number, number, number][] = [];
  for (let k = 0; k < n; k++) stems.push([K("tree"), S("oak"), x0 + 0.5 + (k % 7) * 2.6, x0 + 0.5 + Math.floor(k / 7) * 2.6, H]);
  const { s, flora, L } = await staged(await theGpu(), stems, () => openDay((r) => dayGain(TREE_KINDS[r])));
  // every stem grows alike, so each day the stand keeps as many as fit at the height they stood at that morning: the
  // count Reineke's rule puts on the texel at their diameter, within its rounding, the crowns of those kept within it
  let h = H * 1000;
  for (let day = 1; day <= 80; day++) {
    await s.step(day);
    const b = await s.read(PLANT, "body"), alive = live(b, L.cap), a = crownAt(TABLES.tables, 1, h);
    expect(alive).toBe(Math.floor(65536 / a));
    expect(Math.abs(alive - reineke(dbhOf("oak", h / 1000)))).toBeLessThan(1);
    expect(alive * a).toBeLessThanOrEqual(65536);
    const sizes = new Set<number>();
    for (let i = 0; i < L.cap; i++) if (b[i] & 1) sizes.add(b[L.size + i]);
    expect(sizes.size).toBe(1);
    h = [...sizes][0];
  }
  expect(h).toBeGreaterThan(H * 1000);
  flora.destroy();
  s.destroy();
}, 120_000);

test("an open-grown stem reaches the calibrated law's heights at 10 and 30 years, and its calibration point", async () => {
  // one stem of each tree kind alone in its own texel, laid at its height at 5 years old
  const stems: [number, number, number, number, number][] = TREE_KINDS.map((sp, r) => [K("tree"), S(sp), 150 * CELL + r * 3 * TEXEL_M + 1, 150 * CELL + 1, calibratedHeight(sp, 5)]);
  const { s, flora, L } = await staged(await theGpu(), stems, () => openDay((r) => dayGain(TREE_KINDS[r])));
  const heights = async () => { const b = await s.read(PLANT, "body"); return TREE_KINDS.map((_, j) => b[L.size + j] / 1000); };
  let t = 0;
  const grow = async (years: number) => { for (let k = 0; k < years * YEAR_DAYS; k++) await s.step(++t); };
  await grow(5);
  const at10 = await heights();
  await grow(10);
  const at20 = await heights();
  await grow(3);
  const at23 = await heights();
  await grow(7);
  const at30 = await heights();
  TREE_KINDS.forEach((sp, j) => {
    // within 2 cm: the law's daily gain rounded to q's units, the table read between its entries
    expect(Math.abs(at10[j] - calibratedHeight(sp, 10))).toBeLessThan(0.02);
    expect(Math.abs(at30[j] - calibratedHeight(sp, 30))).toBeLessThan(0.02);
    const [cal, yr] = sp === "aspen" ? [11.41, 20] : [{ pine: 7.5, oak: 7.8, ash: 11.4 }[sp]!, 23];
    expect(Math.abs((yr === 20 ? at20 : at23)[j] - cal)).toBeLessThan(0.02);
  });
  flora.destroy();
  s.destroy();
}, 300_000);

test("a stem in deep shade loses mass every day and dies once it weighs half its peak, as the oracle has it", async () => {
  // a 6 m pine and a bramble under a 30 m ash whose crown holds most of their texel, short of crowding the pine out
  const x0 = 50 * CELL, stems: [number, number, number, number, number][] = [
    [K("tree"), S("ash"), x0 + 9, x0 + 9, 30], [K("tree"), S("pine"), x0 + 6, x0 + 6, 6], [K("bush"), S("berry"), x0 + 12, x0 + 12, 1],
  ];
  const coefDay = openDay((r) => dayGain(TREE_KINDS[r]), 3000);
  const { s, flora, L } = await staged(await theGpu(), stems, () => coefDay);
  let b = await s.read(PLANT, "body");
  const ash = crownAt(TABLES.tables, 2, b[L.size]) / 65536;
  expect(ash).toBeGreaterThan(0.8);
  expect(ash + crownAt(TABLES.tables, 0, b[L.size + 1]) / 65536).toBeLessThan(1);
  const peak = [0, b[L.peak + 1], b[L.peak + 2]], q = [0, b[L.q + 1], b[L.q + 2]], died = [0, 0, 0];
  for (let day = 1; b[1] & 1 || b[2] & 1; day++) {
    const want = oracleDay(b, L, TABLES.tables, TABLES.rows, coefDay.coef);
    await s.step(day);
    b = await s.read(PLANT, "body");
    expect(b).toEqual(want);
    for (const i of [1, 2]) {
      if (died[i]) continue;
      if (b[i] & 1) { expect(b[L.q + i]).toBeLessThan(q[i]); q[i] = b[L.q + i]; } else died[i] = day;
    }
    expect(day).toBeLessThan(4000);
  }
  // each died the first day its mass fell to half its peak (q to 2^(-1/4) of the peak's), and not before; the ash lives
  for (const i of [1, 2]) {
    expect((q[i] / peak[i]) ** 4).toBeGreaterThan(0.5);
    expect(died[i]).toBeGreaterThan(1);
  }
  expect(died[2]).toBeLessThan(died[1]);
  expect(b[0] & 1).toBe(1);
  flora.destroy();
  s.destroy();
}, 300_000);

test("seed 1's stems on the GPU: a day of the law, no tree past its stand's maximum crowding, counts by kind", async () => {
  const w = newWorld(1, 0), g = await theGpu(), s = new Store(g), f = groundOf(1).flora, flora = new Flora(f), driver = stemDriver(w);
  flora.attach(s, driver);
  const L = layoutOf(s.kind(PLANT)), b00 = await s.read(PLANT, "body");
  // the first day (its kernels compiled), then the second timed: the CPU's coefficients, the kernels on the GPU, and
  // the landing that brings every stem's height back
  await s.step(DAY);
  const first = live(await s.read(PLANT, "body"), L.cap), b0 = await s.read(PLANT, "body");
  const c0 = performance.now();
  driver.day(2 * DAY);
  const cpuMs = performance.now() - c0;
  await g.device.queue.onSubmittedWorkDone();
  const g0 = performance.now();
  s.begin(2 * DAY);
  await g.device.queue.onSubmittedWorkDone();
  const g1 = performance.now();
  await s.land();
  const g2 = performance.now(), b = await s.read(PLANT, "body"), tables = TABLES.tables, rows = TABLES.rows;
  console.log(JSON.stringify({ laidStems: live(b00, L.cap), afterDay1: first, afterDay2: live(b, L.cap), mast: driver.day(2 * DAY).mast }));
  // the trees that stand after the day, in each texel at the heights they had that morning: two or more of them never
  // hold more than the texel
  const byTexel = new Map<number, { sum: number; n: number }>(), count: Record<string, number> = {}, laid: Record<string, number> = {}, crop: Record<string, number> = {};
  for (let k = 0; k < f.n; k++) if (f.kind[k] === K("tree") || f.kind[k] === K("bush")) laid[SPECIES[f.species[k]]] = (laid[SPECIES[f.species[k]]] ?? 0) + 1;
  for (let i = 0; i < L.cap; i++) {
    if (!(b[i] & 1)) continue;
    const r = rowOf(b, L, rows, i), sp = SPECIES[b[L.what + i] >>> 8];
    count[sp] = (count[sp] ?? 0) + 1;
    crop[sp] = (crop[sp] ?? 0) + b[L.crop + i];
    if (rw(rows, r, RW.tree) !== 1) continue;
    const t = texelOf(b, L, i), e = byTexel.get(t) ?? { sum: 0, n: 0 };
    e.sum += crownAt(tables, r, b0[L.size + i]); e.n++;
    byTexel.set(t, e);
  }
  let over = 0;
  for (const e of byTexel.values()) if (e.n > 1 && e.sum > 65536) over++;
  expect(over).toBe(0);
  // the GPU memory the stems hold: every kind's buffers, the flora's own, the law's scratch (raster lists, counts and
  // cursors) and the index's (keys, flags, ids, cells and the radix histogram), the landing's copy and its staging
  const cap = s.kind(PLANT).capacity, mb = (x: number) => Math.round(x / 2 ** 20);
  let kinds = 0;
  for (const k of s.kinds) kinds += (1 + k.fields.length) * k.capacity * 4 + (16 + k.capacity) * 4 + (k.placed ? (k.capacity + CELLS + 1) * 4 : 0);
  const own = TABLES.tables.byteLength + TABLES.rows.byteLength + CELLS * ROWS * 8 + Math.ceil(cap / 2) * 4;
  const scratch = (3 * cap + 2 * TEXELS_SIDE ** 2 + 1) * 4 + (4 * cap + 256 * Math.ceil(cap / 1024)) * 4 + 2 * Math.ceil(cap / 2) * 4;
  console.log(JSON.stringify({ adapter: g.adapter, laid, standing: count, crop, cpuMs: Math.round(cpuMs), gpuMs: Math.round(g1 - g0), landMs: Math.round(g2 - g1), kindsMB: mb(kinds), floraMB: mb(own), scratchMB: mb(scratch), totalMB: mb(kinds + own + scratch) }));
  for (const sp of ["pine", "oak", "ash", "aspen", "berry", "hazel"]) expect(count[sp]).toBeGreaterThan(0);
  flora.destroy();
  s.destroy();
}, 600_000);

// treeKg and crownShare are the tables' sources: the tables read them back within their steps.
test("the tables follow the trees' masses and crowns", () => {
  for (const [r, sp] of TREE_KINDS.entries()) {
    for (const h of [2, 8, 15, 25]) {
      const q = Math.round(treeKg(sp, h) ** 0.25 * 2 ** 20);
      expect(Math.abs(heightAt(TABLES.tables, r, q) / 1000 - h)).toBeLessThan(0.01);
      expect(Math.abs(crownAt(TABLES.tables, r, h * 1000) / 65536 - crownShare(sp, h) / (TEXEL_M * TEXEL_M))).toBeLessThan(0.002);
    }
  }
});
