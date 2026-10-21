// A finer tier of the cube-sphere over the whole planet, solved globally: a quadtree tier (2^tier children to a side of each tier-0 cell) made from tier 0 by a
// remap that depends only on the ground point, then eroded with the flood and the receivers routed across tile and face edges, the stream power law and the
// threshold hillslopes, under the planet's rain and rock, the total height of every tier-0 cell held. It is the coarse-to-fine global solve the 75 m tier needs
// (tier 4 on the small planet): the per-tile kernels of grid.ts and erosion.ts cannot hold a tier of 25 to 100 million cells (their tables alone are 41 words a
// cell), so these kernels find a cell's eight neighbours from its place and read what varies slowly from a table of the tier-0 cell it lies in.
// What was built and measured: docs/research/globe/2026-10-20-small-planet-impl.md (R1760 and up).
import type { Gpu } from "../device";
import { cover, pipeline, readback, storage } from "../kernel";
import { CNT, FLAG, HIST, RF, SPLIT, XSTRIDE, regionalWgsl } from "../wgsl/globe-regional";
import { EDGES, FACES, areaSr, haloSource, tierGrid, type Grid } from "./grid";
import { SKIN_M, defaultParams, kWord, neighbourTables, rainWord, REF_RAIN_MMYR, type ErosionParams } from "./erosion";
import { THRESHOLD_DEG } from "../../terrain/geology";
import { packRecord, unpackRecord, ROCK_OF, type Planet, type PlanetStore } from "./window";

// ---------- 1. the settings ----------
// The default tier is 3 (the stage runner takes any): 2,048 cells a face side, 25,165,824 cells in all, which the 4 GB buffer holds; tier 4 (100 million cells,
// 5.6 GB of fields in two buffers) is what the 75 m planet needs and fits in two [design, R1760: the cost table of the small planet's note].
export const REGIONAL = {
  tier: 3,
  dtYr: 1e6, // a step: the stream power step is implicit, so the step sets only how far the flow pattern may change inside one [design, as the erosion unit's SUBSTEP_YR]
  steps: 40, // the number of steps a tier is eroded for [design, R1763: the receivers' change between steps is measured in the note]
};
const CELLS0 = FACES * 256 * 256;
// The parent of a tier cell in tier 0: the cell id there.
export const parentOf = (tier: number, id: number): number => {
  const fn = 256 << tier, cells = fn * fn, f = Math.floor(id / cells), r = id - f * cells, Y = Math.floor(r / fn), X = r - Y * fn;
  return (f * 256 + (Y >> tier)) * 256 + (X >> tier);
};

// ---------- 2. the remap: tier 0 to the tier, a function of the ground point only ----------
// Each child's value is the bilinear interpolation, in the face's index space, of the four tier-0 cell centres round the child's centre
// (the neighbours across a face's edge as grid.ts haloSource gives them; at a cube's corner, where one is missing, the mean of the two
// beside it) [design, R1761]. The children of a tier-0 cell are then moved by one constant so that their total is the parent's exactly:
// by whole units of 1/256 m for a height (the sum of the 4^tier children is the parent's 4^tier times 256 rounded, to the unit) and in
// proportion for a quantity that cannot fall under zero. A child's value depends on its parent and the parents' round it, never on a window.
type Field = ArrayLike<number>;
// The 3 by 3 tier-0 cells round (f, X, Y) as ids: row dy = -1, 0, 1 (south to north), column dx = -1, 0, 1 (west to east); the corner's missing one is -1.
function around3(g0: Grid, f: number, X: number, Y: number, out: Int32Array) {
  const n = g0.fn;
  for (let dy = -1; dy <= 1; dy++)
    for (let dx = -1; dx <= 1; dx++) {
      const x = X + dx, y = Y + dy;
      if (x >= 0 && x < n && y >= 0 && y < n) { out[(dy + 1) * 3 + dx + 1] = (f * n + y) * n + x; continue; }
      const s = haloSource(g0, f, x, y);
      out[(dy + 1) * 3 + dx + 1] = s ? (s.face * n + s.Y) * n + s.X : -1;
    }
}
const CORNER_BESIDE = [[0, 1, 3], [2, 1, 5], [6, 3, 7], [8, 5, 7]] as const;
// Calls emit(parent, children) with the 4^(tier - from) interpolated values of each cell of tier `from` (tier 0 unless given), child (i, j) at index j * B + i (i east, j north).
function eachParent(field: Field, tier: number, emit: (parent: number, v: Float64Array) => void, from = 0) {
  const gp = tierGrid(from), fnp = gp.fn, up = tier - from, B = 1 << up, ids = new Int32Array(9), val = new Float64Array(9), out = new Float64Array(B * B);
  const wlo = new Float64Array(B), whi = new Float64Array(B), ilo = new Int32Array(B);
  for (let i = 0; i < B; i++) { const u = (i + 0.5) / B, lo = u < 0.5; ilo[i] = lo ? 0 : 1; whi[i] = lo ? u + 0.5 : u - 0.5; wlo[i] = 1 - whi[i]; }
  for (let f = 0; f < FACES; f++)
    for (let Y = 0; Y < fnp; Y++)
      for (let X = 0; X < fnp; X++) {
        around3(gp, f, X, Y, ids);
        for (let c = 0; c < 9; c++) if (ids[c] >= 0) val[c] = field[ids[c]];
        // a cube corner's missing cell: the mean of the two beside it
        for (const [c, a, b] of CORNER_BESIDE) if (ids[c] < 0) val[c] = (val[a] + val[b]) / 2;
        for (let j = 0; j < B; j++) {
          const r0 = ilo[j] * 3, wj0 = wlo[j], wj1 = whi[j];
          for (let i = 0; i < B; i++) {
            const c0 = r0 + ilo[i];
            out[j * B + i] = wj0 * (wlo[i] * val[c0] + whi[i] * val[c0 + 1]) + wj1 * (wlo[i] * val[c0 + 3] + whi[i] * val[c0 + 4]);
          }
        }
        emit((f * fnp + Y) * fnp + X, out);
      }
}
const cellIndex = (tier: number, parent: number, c: number, from = 0) => {
  const up = tier - from, B = 1 << up, fn = 256 << tier, fnp = 256 << from, f = Math.floor(parent / (fnp * fnp)), r = parent - f * fnp * fnp, Y0 = Math.floor(r / fnp), X0 = r - Y0 * fnp, j = Math.floor(c / B), i = c - j * B;
  return (f * fn + Y0 * B + j) * fn + X0 * B + i;
};
// A height in 1/256 m above the sea for every cell of the tier, the children of each tier-0 cell summing to 256 times its height times 4^tier to the unit.
export function remapHeights(tier: number, height: Field): Int32Array {
  const n = 1 << (2 * tier), out = new Int32Array(CELLS0 * n);
  eachParent(height, tier, (p, v) => {
    let sum = 0;
    for (let c = 0; c < n; c++) { v[c] = Math.round(v[c] * 256); sum += v[c]; }
    const d = Math.round(height[p] * 256 * n) - sum, base = Math.floor(d / n), rem = d - base * n;
    for (let c = 0; c < n; c++) out[cellIndex(tier, p, c)] = v[c] + base + (c < rem ? 1 : 0);
  });
  return out;
}
// The heights of tier `from` (1/256 m) carried to a finer tier: each child the bilinear value between the parent's and its neighbours' centres, moved by one
// whole-unit constant so that the children of a cell sum to 4^(tier - from) times its height exactly (the tier above's totals are kept) [design, R1761].
export function remapInts(from: number, tier: number, height: Int32Array): Int32Array {
  const n = 1 << (2 * (tier - from)), cells = CELLS0 << (2 * from), out = new Int32Array(cells * n);
  if (height.length !== cells) throw new Error(`remapInts: tier ${from} holds ${cells} cells, got ${height.length}`);
  eachParent(height, tier, (p, v) => {
    let sum = 0;
    for (let c = 0; c < n; c++) { v[c] = Math.round(v[c]); sum += v[c]; }
    const d = height[p] * n - sum, base = Math.floor(d / n), rem = d - base * n;
    for (let c = 0; c < n; c++) out[cellIndex(tier, p, c, from)] = v[c] + base + (c < rem ? 1 : 0);
  }, from);
  return out;
}
// remapInts for one tier up (children 2 by 2), the whole planet's 25 million cells in seconds: the same arithmetic as eachParent's (weights 3/4 and 1/4 of the two
// nearest centres on each axis, so a child is (9a + 3b + 3c + d) / 16 rounded half up) with the cells round a face's edge or corner taken from eachParent's own path.
export function refineInts(from: number, height: Int32Array): Int32Array {
  const fnp = 256 << from, fn = fnp * 2, cells = fnp * fnp, out = new Int32Array(height.length * 4), gp = tierGrid(from), ids = new Int32Array(9), val = new Float64Array(9);
  if (height.length !== CELLS0 << (2 * from)) throw new Error(`refineInts: tier ${from} holds ${CELLS0 << (2 * from)} cells, got ${height.length}`);
  const o = (f: number, Y: number, X: number, j: number, i: number) => (f * fn + 2 * Y + j) * fn + 2 * X + i;
  for (let f = 0; f < FACES; f++) {
    const base = f * cells;
    for (let Y = 0; Y < fnp; Y++) {
      for (let X = 0; X < fnp; X++) {
        const p = base + Y * fnp + X;
        let sw: number, se: number, nw: number, ne: number, w: number, e: number, s: number, n: number, ce = height[p];
        if (X > 0 && X < fnp - 1 && Y > 0 && Y < fnp - 1) {
          w = height[p - 1]; e = height[p + 1]; s = height[p - fnp]; n = height[p + fnp];
          sw = height[p - fnp - 1]; se = height[p - fnp + 1]; nw = height[p + fnp - 1]; ne = height[p + fnp + 1];
        } else {
          around3(gp, f, X, Y, ids);
          for (let c = 0; c < 9; c++) if (ids[c] >= 0) val[c] = height[ids[c]];
          for (const [c, a, b] of CORNER_BESIDE) if (ids[c] < 0) val[c] = (val[a] + val[b]) / 2;
          sw = val[0]; s = val[1]; se = val[2]; w = val[3]; ce = val[4]; e = val[5]; nw = val[6]; n = val[7]; ne = val[8];
        }
        // child (i, j) lies at 1/4 or 3/4 of the way between the parent's centre and the neighbour's on each axis: weights 3/4 on the parent's side
        const v00 = Math.round((9 * ce + 3 * w + 3 * s + sw) / 16), v10 = Math.round((9 * ce + 3 * e + 3 * s + se) / 16);
        const v01 = Math.round((9 * ce + 3 * w + 3 * n + nw) / 16), v11 = Math.round((9 * ce + 3 * e + 3 * n + ne) / 16);
        const d = height[p] * 4 - (v00 + v10 + v01 + v11), base4 = Math.floor(d / 4), rem = d - base4 * 4;
        out[o(f, Y, X, 0, 0)] = v00 + base4 + (0 < rem ? 1 : 0);
        out[o(f, Y, X, 0, 1)] = v10 + base4 + (1 < rem ? 1 : 0);
        out[o(f, Y, X, 1, 0)] = v01 + base4 + (2 < rem ? 1 : 0);
        out[o(f, Y, X, 1, 1)] = v11 + base4 + (3 < rem ? 1 : 0);
      }
    }
  }
  return out;
}
// A quantity that is never negative (rain, runoff) on every cell of the tier, the children's mean the parent's value (to float32).
export function remapAmounts(tier: number, field: Field, scale = 1): Float32Array {
  const n = 1 << (2 * tier), out = new Float32Array(CELLS0 * n);
  eachParent(field, tier, (p, v) => {
    let sum = 0;
    for (let c = 0; c < n; c++) { v[c] = Math.max(0, v[c]); sum += v[c]; }
    const want = field[p] * n, k = sum > 0 ? want / sum : 0;
    for (let c = 0; c < n; c++) out[cellIndex(tier, p, c)] = (sum > 0 ? v[c] * k : field[p]) * scale;
  });
  return out;
}
// The year's rain of every cell of the tier, mm, from the planet's four seasons: the seasons' total remapped.
export const annualRain = (planet: Planet): Float32Array => {
  const total = new Float32Array(planet.n);
  for (const s of planet.seasons) for (let i = 0; i < planet.n; i++) total[i] += s.rain[i];
  return total;
};

// ---------- 3. the tier-0 table the kernels read ----------
// For every tier-0 cell: the erodibility of its rock (the thickness-weighted mean over the top SKIN_M of the column, stack order as the erosion
// unit removes it: sediment, volcanic, metasediment, granitoid, basalt; K a pool as erosion.ts defaultParams holds it, per step as kWord), the
// cell's area weight (Q15 of the mean cell) and the inverse of its centre's distance to each of the eight neighbours at the tier's spacing
// (tier 0's over 2^tier: the metric's change over one tier-0 cell is under 0.2% [derived: the cells' sides change by 41% over 128 cells]).
const STACK = [1, 4, 2, 3, 0];
// The threshold slope of each pool as the window's landslides take it (geology.ts THRESHOLD_DEG of the island's rock the pool stands for, window.ts ROCK_OF) [R1714].
const tanOfPools = () => ROCK_OF.map((r) => Math.tan((THRESHOLD_DEG[r] * Math.PI) / 180));
export function tierTable(planet: Planet, tier: number, p: ErosionParams): Uint32Array {
  const g0 = tierGrid(0, planet.radius), gt = tierGrid(tier, planet.radius), X = new Uint32Array(CELLS0 * XSTRIDE), kw = p.K.map((k) => kWord(gt, p, k)), tanOf = tanOfPools();
  const { invd } = neighbourTables(g0), meanSr = (4 * Math.PI) / CELLS0;
  for (let c = 0; c < CELLS0; c++) {
    let rem = SKIN_M, wsum = 0, acc = 0, tanSum = 0;
    for (const pl of STACK) { const w = Math.min(Math.max(0, planet.pools[pl][c]), rem); rem -= w; wsum += w; acc += w * kw[pl]; tanSum += w * tanOf[pl]; }
    const tan = wsum > 0 ? tanSum / wsum : tanOf[3];
    const f = Math.floor(c / 65536), r = c - f * 65536, Y = Math.floor(r / 256), x = r - Y * 256;
    X[c * XSTRIDE] = wsum > 0 ? Math.floor(acc / wsum) : 0;
    X[c * XSTRIDE + 1] = Math.round((2 ** 15 * areaSr(g0, x, Y)) / meanSr);
    for (let d = 0; d < 8; d++) {
      // a tier-0 corner cell has no diagonal neighbour toward the cube's corner, but its children do: the distance there is the diagonal of the two edges beside it [derived]
      const iv = invd[c * 8 + d] > 0 || d < 4 ? invd[c * 8 + d] : Math.round((invd[c * 8 + d - 4] + invd[c * 8 + ((d - 3) & 3)]) / 2 / Math.SQRT2);
      X[c * XSTRIDE + 2 + d] = iv * 2 ** tier;
      X[c * XSTRIDE + 10 + d] = iv > 0 ? Math.round((tan * 256 * 2 ** 28) / (iv * 2 ** tier)) : 0;
    }
  }
  return X;
}

// ---------- 4. the kernels on a device ----------
export interface TierState { height: Int32Array; carry: Uint32Array; steps: number }
export interface TierFlow { to: Uint32Array; acc: Uint32Array; rounds: number }
const readU32 = async (gpu: Gpu, b: GPUBuffer, words: number, at: number) => new Uint32Array(await readback(gpu, b, words * 4, at * 4));

export class Regional {
  readonly fn: number;
  readonly N: number;
  readonly g: Grid;
  readonly E: GPUBuffer;
  readonly E2: GPUBuffer;
  readonly AT: GPUBuffer;
  private readonly P: GPUBuffer;
  private X: GPUBuffer;
  private readonly wgsl: string;
  private readonly binds = new Map<string, GPUBindGroup>();
  private readonly atCnt: number;
  private readonly atCarry: number;
  lastRounds = 256;
  lastSlide = 32;
  // with `profile` set each phase is waited for and its seconds added to `seconds` (the flood's rounds, the tree and discharge, the incision, the landslides, the uplift)
  profile = false;
  readonly seconds: Record<string, number> = { flood: 0, tree: 0, incise: 0, slide: 0, lift: 0 };
  private async lap<T>(name: string, f: () => Promise<T> | T): Promise<T> {
    if (!this.profile) return f();
    await this.gpu.device.queue.onSubmittedWorkDone();
    const t = performance.now(), v = await f();
    await this.gpu.device.queue.onSubmittedWorkDone();
    this.seconds[name] += (performance.now() - t) / 1000;
    return v;
  }
  constructor(readonly gpu: Gpu, readonly tier: number, table: Uint32Array, height: Int32Array, rho: Int32Array) {
    this.g = tierGrid(tier);
    this.fn = this.g.fn;
    this.N = FACES * this.fn * this.fn;
    if (height.length !== this.N || rho.length !== this.N) throw new Error(`regional: tier ${tier} holds ${this.N} cells, got ${height.length} heights and ${rho.length} rains`);
    this.atCnt = this.N + 3 * HIST;
    this.atCarry = this.atCnt + 16 + 2 * CELLS0;
    this.E = storage(gpu, SPLIT * this.N * 4);
    this.E2 = storage(gpu, (RF.COUNT - SPLIT) * this.N * 4);
    this.AT = storage(gpu, (this.atCarry + CELLS0) * 4);
    this.P = storage(gpu, new Uint32Array([1, 0, 0, 0]));
    this.X = storage(gpu, table);
    this.wgsl = regionalWgsl(EDGES, this.fn);
    this.write("H", height);
    this.write("RHO", rho);
  }
  private write(f: keyof typeof RF, data: ArrayBufferView) {
    const [b, o] = this.at(f);
    this.gpu.device.queue.writeBuffer(b, o, data.buffer, data.byteOffset, data.byteLength);
  }
  private at(f: keyof typeof RF): [GPUBuffer, number] { return RF[f] < SPLIT ? [this.E, RF[f] * this.N * 4] : [this.E2, (RF[f] - SPLIT) * this.N * 4]; }
  private read(f: keyof typeof RF) { const [b, o] = this.at(f); return readback(this.gpu, b, this.N * 4, o); }
  // Heights and carries as a run left them (a stage resumed).
  load(s: TierState) {
    this.write("H", s.height);
    this.gpu.device.queue.writeBuffer(this.AT, this.atCarry * 4, s.carry);
  }
  setTable(table: Uint32Array) { this.gpu.device.queue.writeBuffer(this.X, 0, table); }
  setRain(rho: Int32Array) { this.write("RHO", rho); }
  private bind(entry: string) {
    let b = this.binds.get(entry);
    const p = pipeline(this.gpu, this.wgsl, entry);
    if (!b) {
      b = this.gpu.device.createBindGroup({ layout: p.getBindGroupLayout(0), entries: [this.P, this.E, this.AT, this.X, this.E2].map((buffer, binding) => ({ binding, resource: { buffer } })) });
      this.binds.set(entry, b);
    }
    return { p, b };
  }
  // `times` dispatches of an entry point in one pass; `cells` threads each (0: one workgroup).
  private run(pass: GPUComputePassEncoder, entry: string, cells: number, times = 1) {
    const { p, b } = this.bind(entry), g = cells === 0 ? ([1, 1] as [number, number]) : cover(this.gpu, cells);
    pass.setPipeline(p); pass.setBindGroup(0, b);
    for (let i = 0; i < times; i++) pass.dispatchWorkgroups(g[0], g[1]);
  }
  private submit(f: (pass: GPUComputePassEncoder) => void) {
    const enc = this.gpu.device.createCommandEncoder(), pass = enc.beginComputePass();
    f(pass);
    pass.end();
    this.gpu.device.queue.submit([enc.finish()]);
  }
  private clear(word: number, count: number) { this.gpu.device.queue.writeBuffer(this.AT, word * 4, new Uint32Array(count)); }
  async flags(): Promise<number> { return (await readU32(this.gpu, this.AT, 1, this.atCnt + CNT.flags))[0]; }
  // The flooded surface, the receivers, the depth sort and the discharge area of the heights in E (weights from the rain and the table).
  async flow(): Promise<number> {
    const N = this.N;
    this.clear(this.atCnt + CNT.changed, 1);
    this.submit((p) => { this.run(p, "weights", N); this.run(p, "flinit", N); });
    let rounds = 0, chunk = Math.max(64, this.lastRounds);
    await this.lap("flood", async () => {
      for (;;) {
        this.clear(this.atCnt + CNT.changed, 1);
        this.submit((p) => this.run(p, "flood", N, chunk));
        rounds += chunk;
        if ((await readU32(this.gpu, this.AT, 1, this.atCnt + CNT.changed))[0] === 0) break;
        chunk = 128;
        if (rounds > 40000) throw new Error("regional: the flood did not settle in 40,000 rounds");
      }
    });
    this.lastRounds = rounds - chunk;
    await this.lap("tree", () => this.submit((p) => {
      this.run(p, "recv", N); this.run(p, "lvinit", N);
      for (let r = 0; r < 7; r++) { this.run(p, "jumpa", N); this.run(p, "jumpb", N); }
      this.run(p, "lvhist", N); this.run(p, "lvscan", 0); this.run(p, "lvscatter", N); this.run(p, "area", 0);
    }));
    const flags = await this.flags();
    if (flags & FLAG.area) throw new Error("regional: a basin's discharge area passed 32 bits");
    if (flags & (FLAG.chain | FLAG.depth)) throw new Error(`regional: the receivers' chains do not end at the sea (flags ${flags})`);
    return rounds;
  }
  // One erosion step on the heights in E: flow, the implicit stream power step, then every land cell of a tier-0 cell rises by the mean height its land cells lost.
  async step(): Promise<number> {
    const rounds = await this.flow(), N = this.N;
    await this.lap("incise", () => this.submit((p) => this.run(p, "incise", 0)));
    // the landslides, rounds until a round moves nothing
    let slide = 0, chunk = Math.max(32, this.lastSlide);
    await this.lap("slide", async () => {
      for (;;) {
        this.clear(this.atCnt + CNT.changed, 1);
        this.submit((p) => this.run(p, "slide", N, chunk));
        slide += chunk;
        if ((await readU32(this.gpu, this.AT, 1, this.atCnt + CNT.changed))[0] === 0) break;
        chunk = 32;
        if (slide > 40000) throw new Error("regional: the landslides did not settle in 40,000 rounds");
      }
    });
    this.lastSlide = slide - chunk;
    await this.lap("lift", () => this.submit((p) => { this.run(p, "pzero", CELLS0); this.run(p, "tally", N); this.run(p, "lift", N); this.run(p, "carry", CELLS0); }));
    return rounds;
  }
  async readH(): Promise<Int32Array> { return this.readField("H"); }
  async readField(f: keyof typeof RF): Promise<Int32Array> { return new Int32Array(await this.read(f)); }
  async readCarry(): Promise<Uint32Array> { return readU32(this.gpu, this.AT, CELLS0, this.atCarry); }
  // The depth of the deepest flow path of the last flow, in cells (the counting sort holds MAXD).
  async deepest(): Promise<number> { return (await readU32(this.gpu, this.AT, 1, this.atCnt + CNT.top))[0]; }
  async readFlooded(): Promise<Int32Array> { return new Int32Array(await readback(this.gpu, this.AT, this.N * 4, 0)); }
  async state(steps: number): Promise<TierState> { return { height: await this.readH(), carry: await this.readCarry(), steps }; }
  async readFlow(): Promise<TierFlow> {
    const [to, acc] = await Promise.all([this.readField("TO"), this.readField("ACC")]);
    return { to: new Uint32Array(to.buffer), acc: new Uint32Array(acc.buffer), rounds: this.lastRounds };
  }
  release() { for (const b of [this.E, this.E2, this.AT, this.P, this.X]) b.destroy(); this.binds.clear(); }

  // Add the weights given (units in the caller's) down the forest of the last flow: what each cell and everything draining to it carries.
  async gather(weights: Uint32Array): Promise<Uint32Array> {
    this.write("W", weights);
    this.submit((p) => this.run(p, "area", 0));
    if ((await this.flags()) & FLAG.area) throw new Error("regional: a basin's sum passed 32 bits");
    return new Uint32Array(await this.read("ACC"));
  }
}

// The rain word of every cell of the tier: the year's rain over the reference rain, Q8, from the remapped rain in mm.
export const rainWords = (mm: Float32Array, ref = REF_RAIN_MMYR): Int32Array => Int32Array.from(mm, (v) => rainWord(v, ref));

// ---------- 5. the tier kept ----------
// What is kept of a made tier: the heights (1/256 m above the present sea) and the receivers and discharge area of the flow on them.
export interface Tier {
  seed: number; tier: number; steps: number; dtYr: number; key: string;
  height: Int32Array; to: Uint32Array; acc: Uint32Array; // acc: 1/512 of the mean cell at the reference rain (as erosion.ts)
}
export function packTier(t: Tier): Uint8Array {
  return packRecord({ seed: t.seed, tier: t.tier, steps: t.steps, dtYr: t.dtYr, key: t.key }, { height: t.height, to: t.to, acc: t.acc });
}
export function unpackTier(bytes: Uint8Array): Tier {
  const { meta, arrays: a } = unpackRecord(bytes);
  return { seed: meta.seed, tier: meta.tier, steps: meta.steps, dtYr: meta.dtYr, key: meta.key, height: a.height as Int32Array, to: a.to as Uint32Array, acc: a.acc as Uint32Array };
}
const packState = (key: string, s: TierState) => packRecord({ key, steps: s.steps }, { height: s.height, carry: s.carry });
const unpackState = (bytes: Uint8Array, key: string): TierState | null => {
  const { meta, arrays: a } = unpackRecord(bytes);
  return meta.key === key ? { height: a.height as Int32Array, carry: a.carry as Uint32Array, steps: meta.steps } : null;
};

// The inputs of a tier from a planet: the tier-0 table, the remapped heights and the rain words.
export function regionalInputs(planet: Planet, o = REGIONAL) {
  const p = defaultParams({ dtYr: o.dtYr });
  return { p, table: tierTable(planet, o.tier, p), height: remapHeights(o.tier, planet.height), rho: rainWords(remapAmounts(o.tier, annualRain(planet))) };
}

// Make a tier: the steps of erosion from the remap, kept in the store as they go (a state is the heights and the carries, so a part resumes where the
// last stopped and the bytes do not depend on where the parts split), within a budget of seconds; null when the budget ends before the last step.
// `key` names the sources that make a tier (a tier made by other code is not read as this code's).
export async function regionalOf(gpu: Gpu, planet: Planet, store: PlanetStore, key: string, budgetS = Infinity, o = REGIONAL, log: (s: string) => void = () => {}): Promise<Tier | null> {
  const done = await store.get(planet.seed, `regional-${key}`);
  if (done) return unpackTier(done);
  const t0 = performance.now(), spent = () => (performance.now() - t0) / 1000;
  const { table, height, rho } = regionalInputs(planet, o);
  const r = new Regional(gpu, o.tier, table, height, rho);
  try {
    const kept = await store.get(planet.seed, `regional-state-${key}`), prior = kept ? unpackState(kept, key) : null;
    let steps = 0;
    if (prior) { r.load(prior); steps = prior.steps; }
    log(`inputs ${spent().toFixed(1)} s, steps kept ${steps}`);
    let last = 0;
    while (steps < o.steps) {
      if (spent() + last * 1.3 + FINISH_S + SAVE_S > budgetS) break;
      const t = performance.now();
      await r.step();
      steps++;
      last = (performance.now() - t) / 1000;
      log(`step ${steps} ${last.toFixed(1)} s, flood ${r.lastRounds} rounds, slides ${r.lastSlide}`);
    }
    if (steps < o.steps) {
      await store.put(planet.seed, `regional-state-${key}`, packState(key, await r.state(steps)));
      return null;
    }
    await r.flow();
    const flow = await r.readFlow(), tier: Tier = { seed: planet.seed, tier: o.tier, steps, dtYr: o.dtYr, key, height: await r.readH(), to: flow.to, acc: flow.acc };
    await store.put(planet.seed, `regional-${key}`, packTier(tier));
    log(`finished ${spent().toFixed(1)} s`);
    return tier;
  } finally { r.release(); }
}
// What the end of a tier costs, s (the settled flow and the readbacks), and a state's save [design: the margins the stage leaves under its budget].
const FINISH_S = 60, SAVE_S = 10;
