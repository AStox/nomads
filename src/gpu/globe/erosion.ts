// Erosion and deposition on the globe, host side: the parameters and their sources, the tables the kernels read, the kernels'
// driver (wgsl/globe-erosion.ts), the TypeScript twin of every kernel (checked word for word in erosion.test.ts) and what is
// read off the result: height-area curve, rivers, basins. The laws, constants and their sources:
// docs/research/globe/2026-10-19-erosion-impl.md (what was built, here) and docs/research/globe/2026-10-19-tectonics.md (the
// isostasy this works on).
//
// The model in a paragraph. Erosion runs on tectonics' own state: the five rock volumes of every column. A substep reads the
// isostatic height of each column, floods the depressions (priority flood from the ocean inward), drains every land cell to its
// steepest lower neighbour on the flooded surface, the diagonal links' lengths drawn anew each substep (Rho8: a forest rooted at the ocean), sums the discharge (cell area times rain) down the
// forest, cuts each cell by the implicit stream power law with the erodibility of the rock in the top of its column (and, where the
// relief over the 5 km round it is more than the river's slope shows, by the landscape-scale law of local relief), takes that
// rock off the top of the column, sheds a dissolved share of it, and carries the rest down the forest: lakes fill, a share
// settles along the way, and what reaches the coast spreads outward over the shelf by rings. Hillslopes creep and the sea
// floor's sediment diffuses by the grid's conservative stencil. Rock removed from a column lowers the surface by only a sixth
// of its thickness (isostasy puts the rest back), sediment laid on raises it by a quarter: the heights come out of the volumes.
import type { Gpu } from "../device";
import { cover, pipeline, readback, storage } from "../kernel";
import { ROCKS, SANDSTONE, GRANITE, CREEP } from "../../terrain/geology";
import { CAP_FACTOR, EF, CNT, FLAG, LED, PR, erosionWgsl } from "../wgsl/globe-erosion";
import { FLD, PHYS } from "../wgsl/globe-tectonics";
import { EDGES, FACES, GlobeGpu, centre, cellId, fieldWords, haloSource, haloTwin, meanAreaM2, tileCount, wordAt, type Grid, type Tables } from "./grid";
import { Tectonics, cellAreas, extTables, startingState, type Setup } from "./tectonics";
import { similarityOf } from "./similarity";
import { philox } from "../rand";

export { CAP_FACTOR, EF, FLAG, PR };

// ---------- 1. parameters ----------
export interface ErosionParams {
  dtYr: number; // a substep, years
  n: 1 | 2; // the slope exponent; the area exponent is n / 2, so the concavity m / n is 1/2 either way
  K: readonly [number, number, number, number, number]; // basalt, sediment, metasediment, granitoid, volcanic: per area at the reference rain
  refRainMmYr: number;
  skinM: number;
  dissolved: number;
  G: number;
  creepLand: number; // m2/yr
  creepSea: number; // m2/yr
  shelfSlope: number;
  ringMax: number;
  relief: boolean; // landscape-scale denudation by local relief (MONTGOMERY_BRANDON), on or off
}

// Erodibility for the stream power law at m = 1/2, n = 1, drainage area in m2 (K in 1/yr), as terrain/geology.ts holds it [cited R523: Stock
// and Montgomery 1999 at m = 0.4, taken to m = 0.5 by A^-0.1 at A of 1e6 to 1e7 m2; Harel et al. 2016: K lower on igneous than on
// sedimentary rock]. Granite and metamorphic rock: 7.1e-8 (the middle on a log scale of 2e-8 to 2.5e-7). Sandstone and limestone have no cited
// range, the common modelling range 1e-8 to 1e-5 stands in: 3.2e-7 [gap]. Volcanic rock is the volcaniclastic class of Stock and
// Montgomery, 1e-5 to 1e-4 at m = 0.4, so 2e-6 to 2.5e-5 at m = 0.5 by the same factors, its middle 7.1e-6 [derived R523; arc volcanics are an
// analogue of volcaniclastic rock]. Basalt (oceanic crust, on land only where it is lifted) takes granite's [gap: none cited].
const mid = (lo: number, hi: number) => Math.sqrt(lo * hi);
export const K_GRANITE = ROCKS[GRANITE].erode, K_SANDSTONE = ROCKS[SANDSTONE].erode, K_VOLCANIC = mid(2e-6, 2.5e-5);
// The slope exponent's alternative: n = 2 with m = 1 keeps the concavity at 1/2 (Harel et al. 2016 find the global mean of n well over 1 and
// of m/n about 0.5; Whipple and Tucker 1999 give m = 1/2, n = 1 for erosion by unit stream power) [cited, abstract and text read]. K for n = 2 is
// set so that both laws erode at the same rate at a reference steepness of 0.05 on a catchment of 1e10 m2 [design], so the sensitivity changes
// the shape of the relief and not the pace.
export const N2_REF = { area: 1e10, slope: 0.05 };
export const kForN2 = (k1: number) => k1 / (Math.sqrt(N2_REF.area) * N2_REF.slope);
// The rain that K stands for, mm/yr: K is quoted per drainage area and carries no rain; a basin's discharge is its area times its rain,
// so a cell of rain r counts r / REF of its area [design: Earth's land receives about 0.8 m/yr].
export const REF_RAIN_MMYR = 1000;
// The top of the column whose rock sets the erodibility, m: the rock thickness one substep's incision reaches, averaged by thickness [design].
export const SKIN_M = 500;
// The share of eroded rock that leaves as dissolved load: a fifth by mass [UNVERIFIED: remembered from global river budgets of dissolved
// against particulate load (Meybeck; Milliman and Farnsworth 2011), no source read]; the volume of rock is taken as the mass.
export const DISSOLVED = 0.2;
// Davy and Lague's deposition coefficient G, in dh/dt = U - K A^m S^n + (G / A) Qs: deposition proportional to the sediment flux over the
// drainage area [cited: Yuan et al. 2019 abstract, read; Hergarten 2020 sec. 5.1, read]. G = 1 is the value at which deposition matters
// to relief (Yuan et al. abstract: the control is significant at 1, negligible below) [design].
export const DEPOSITION_G = 1;
// Hillslope creep's diffusivity, m2/yr, one for the planet as the island has it [cited R527, terrain/geology.ts: 4.4e-4 to 3.6e-2, the middle; Roering et al. 1999
// give 3.2e-3 for one site]. At 12 km cells it moves almost nothing: sqrt(D t) over 1 My is 63 m.
export const CREEP_LAND = CREEP;
// Landscape-scale erosion rate against mean local relief R within a 10 km window: E = E0 + K R / (1 - (R / Rc)^2), the limiting relief Rc = 1,500 m, E0 = 0.01 mm/yr (the chemical
// denudation of the 35 largest basins), K = 2.5e-4 mm/yr per m [cited R1689: Montgomery and Brandon 2002, EPSL 201: 481 to 489, fig. 4 and eqs. 1 and 2, read]. Their data: tectonically
// active mountain belts have mean local relief of 1,000 to 2,000 m whatever the climate, under 2% of the land has more than 1,500 m, rates above 10 mm/yr are rare. The relief here is
// the height range over the 21 cells within 5 km of a cell's centre at the mean cell width (the 5 by 5 block less its four corners, which lie 2.83 cells away), and R is held under 15/16 of Rc where the law is singular [design]: E then tops out at 2.9 mm/yr.
export const MONTGOMERY_BRANDON = { e0MmYr: 0.01, rcM: 1500, kMmYrPerM: 2.5e-4, cap: 15 / 16, subIntervals: 8 };
// The law itself, mm/yr for a relief in m, held under the cap (the kernel's `relief` integrates it over a substep).
export const denudationFromRelief = (reliefM: number) => {
  const mb = MONTGOMERY_BRANDON, r = Math.min(reliefM, mb.cap * mb.rcM);
  return mb.e0MmYr + (mb.kMmYrPerM * r) / (1 - (r / mb.rcM) ** 2);
};
// The sea floor's sediment diffusivity, m2/yr: stratigraphic models use 1e2 to 1e4 for shelf and slope sediment [UNVERIFIED: remembered from
// Kenyon and Turcotte 1985 and Granjeon and Joseph 1999, search snippets only]; the low end is taken, as the rings below do the spreading.
export const CREEP_SEA = 100;
// The graded shelf's slope: sediment reaching the sea fills each ring of cells from the coast to a ramp that deepens by this much a metre
// out [analogue: continental shelves slope about 0.1 degree, remembered, UNVERIFIED], over rings of the mean cell's width.
export const SHELF_SLOPE = 1e-3;
export const RING_MAX = 96;
// A substep: 0.5 My is a quarter of tectonics' step [design]: the implicit scheme is stable at any step, the step sets how far the flow
// pattern may change inside one.
export const SUBSTEP_YR = 5e5;

// The erosion's lengths on a similar planet (similarity.ts): creep's and the sea floor's diffusivities, the shelf's slope and the sediment's reach are rock's, water's and gravity's, Earth's on
// every planet (R1776 to R1778, amended by Unit 4c); the reach is 96 rings of the reference planet's 12.27 km cells, 1,178 km, which is that many times more rings of this planet's smaller
// cells. The stream power law's K carries no length, the relief law's window (10 km, R1689) is Earth's.
export function erosionFor(radius: number): Partial<ErosionParams> {
  const sim = similarityOf(radius);
  if (!sim.similar) return {};
  return { ringMax: Math.max(1, Math.round(RING_MAX * sim.cells)) };
}
export const defaultParams = (over: Partial<ErosionParams> = {}): ErosionParams => ({
  dtYr: SUBSTEP_YR, n: 1,
  K: [K_GRANITE, K_SANDSTONE, K_GRANITE, K_GRANITE, K_VOLCANIC],
  refRainMmYr: REF_RAIN_MMYR, skinM: SKIN_M, dissolved: DISSOLVED, G: DEPOSITION_G, creepLand: CREEP_LAND, creepSea: CREEP_SEA, shelfSlope: SHELF_SLOPE, ringMax: RING_MAX, relief: true,
  ...over,
});

// The words the kernels read of a parameter set: the area scale c0 = sqrt(mean cell / 512) that turns the discharge area's units to metres, the
// erodibility per pool as K dt c0 in Q12 (n = 1) or 4 K dt A0 / (512 * 256) in Q20 (n = 2), the shelf's step in 1/256 m a ring.
export function erosionWords(g: Grid, set: Setup, p: ErosionParams): Uint32Array<ArrayBuffer> {
  const w = new Uint32Array(64), a0 = meanAreaM2(g), sea = Math.round(set.params.seaLevel * 16);
  w[0] = g.tiles; w[1] = g.fn; w[2] = tileCount(g);
  w[PR.sea16] = sea >>> 0; w[PR.eps] = 1; w[PR.ringMax] = p.ringMax; w[PR.diss16] = Math.round(p.dissolved * 65536); w[PR.g8] = Math.round(p.G * 256);
  w[PR.rhoSeed] = set.params.seed >>> 0;
  w[PR.nExp] = p.n; w[PR.skin] = p.skinM; w[PR.shelf] = Math.round(p.shelfSlope * Math.sqrt(a0) * 256);
  for (let k = 0; k < 5; k++) w[PR.kc + k] = kWord(g, p, p.K[k]);
  if (p.relief) {
    const mb = MONTGOMERY_BRANDON, sub = (p.dtYr * 1) / mb.subIntervals;
    w[PR.rc] = Math.round(mb.rcM * 256); w[PR.kdt] = Math.round(((mb.kMmYrPerM * 1e-3) * sub) * 65536); w[PR.e0] = Math.round(mb.e0MmYr * 1e-3 * sub * 256);
  }
  return w;
}
// One erodibility as the kernels' word.
export function kWord(g: Grid, p: Pick<ErosionParams, "dtYr" | "n">, k: number): number {
  const a0 = meanAreaM2(g);
  const v = p.n === 1 ? k * p.dtYr * Math.sqrt(a0 / 512) * 4096 : ((4 * p.dtYr * k * a0) / (512 * 256)) * 2 ** 20;
  return Math.min(0xffffffff, Math.round(v));
}
// The grid's diffusion number D dt / (the mean cell's area) in Q24, split into the fewest equal iterations that stay under the stable 0.08 [derived: the grid's
// two-point bound is 0.098]: [iterations, fo Q24 each].
export function creepIterations(g: Grid, d: number, dtYr: number): [number, number] {
  const fo = (d * dtYr) / meanAreaM2(g), its = Math.max(1, Math.ceil(fo / 0.08));
  return [fo > 0 ? its : 0, Math.round((fo / its) * 2 ** 24)];
}

// ---------- 2. tables ----------
const D8 = [[1, 0], [0, 1], [-1, 0], [0, -1], [1, 1], [-1, 1], [-1, -1], [1, -1]] as const;
export const NONE = 0xffffffff;
// The eight neighbours of every cell (NONE at the 24 cube-corner diagonals) and the inverse of the distance between the centres, Q28 of 1/m.
export function neighbourTables(g: Grid): { nb: Uint32Array; invd: Uint32Array } {
  if (g.tiles !== 1) throw new Error("erosion: tier 0 only");
  const N = FACES * g.fn * g.fn, nb = new Uint32Array(8 * N).fill(NONE), invd = new Uint32Array(8 * N);
  for (let f = 0; f < FACES; f++)
    for (let Y = 0; Y < g.fn; Y++)
      for (let X = 0; X < g.fn; X++) {
        const id = cellId(g, f, X, Y), a = centre(g, f, X, Y);
        for (let d = 0; d < 8; d++) {
          const s = haloSource(g, f, X + D8[d][0], Y + D8[d][1]);
          if (!s) continue;
          const j = cellId(g, s.face, s.X, s.Y), b = centre(g, s.face, s.X, s.Y);
          const cx = a[1] * b[2] - a[2] * b[1], cy = a[2] * b[0] - a[0] * b[2], cz = a[0] * b[1] - a[1] * b[0];
          const ang = Math.atan2(Math.hypot(cx, cy, cz), a[0] * b[0] + a[1] * b[1] + a[2] * b[2]);
          nb[id * 8 + d] = j; invd[id * 8 + d] = Math.round(2 ** 28 / (g.radius * ang));
        }
      }
  return { nb, invd };
}
// The read-only table X: neighbours, inverse distances, then the thermal buoyancy by age of tectonics' setup.
export function erosionTable(set: Setup): Uint32Array {
  const { nb, invd } = neighbourTables(set.grid), N = nb.length / 8, out = new Uint32Array(16 * N + PHYS.AGE_MAX + 1);
  out.set(nb); out.set(invd, 8 * N);
  for (let i = 0; i <= PHYS.AGE_MAX; i++) out[16 * N + i] = set.Q[set.layout.phith + i] >>> 0;
  return out;
}
// The relative rain of each cell as the kernels hold it: Q8 of rain over the reference, at most 8 (8,000 mm/yr at the reference of 1,000) so that
// the discharge area of the whole planet stays inside 32 bits [derived: 393,216 cells * 38,603 * 2,048 / 16,384 < 2^32].
export const RHO_MAX = 2048;
export const rainWord = (mmYr: number, ref: number) => Math.max(0, Math.min(RHO_MAX, Math.round((mmYr / ref) * 256)));

// ---------- 3. the kernels on a device ----------
export interface Ledger { removed: bigint; deposited: bigint; dissolved: bigint }
export interface Flow {
  to: Uint32Array; acc: Uint32Array; depth: Int32Array; height: Int32Array; flooded: Int32Array; rounds: number;
}
const limb = (w: Uint32Array, o: number) => [0, 1, 2, 3].reduce((s, l) => s + (BigInt(w[o + l]) << BigInt(8 * l)), 0n);

export class Erosion {
  readonly N: number;
  readonly g: Grid;
  readonly E: GPUBuffer;
  readonly AT: GPUBuffer;
  private readonly X: GPUBuffer;
  private readonly T: GPUBuffer;
  private readonly gg: GlobeGpu;
  private readonly pars = new Map<string, GPUBuffer>();
  private readonly groups = new Map<string, GPUBindGroup>();
  private enc: GPUCommandEncoder | null = null;
  private wgsl: string;
  private base: Uint32Array = new Uint32Array(64);
  p: ErosionParams;
  lastRounds = 64;
  rhoKey = 0; // the number of the substep, which keys Rho8's draw of the receivers
  // S: the tectonics state (FLD fields in the padded layout), which erosion reads and changes.
  constructor(readonly gpu: Gpu, readonly set: Setup, ext: { tab: Tables; T: Int32Array }, readonly S: GPUBuffer, p: Partial<ErosionParams> = {}) {
    this.g = set.grid; this.N = FACES * this.g.fn * this.g.fn;
    if (this.g.tiles !== 1) throw new Error("erosion: tier 0 only");
    this.p = defaultParams(p);
    this.E = storage(gpu, EF.COUNT * this.N * 4);
    this.AT = storage(gpu, (3 * this.N + CNT.COUNT + 12) * 4);
    this.X = storage(gpu, erosionTable(set));
    this.T = storage(gpu, ext.T);
    this.gg = new GlobeGpu(gpu, this.g, 3);
    this.wgsl = erosionWgsl(EDGES);
    this.configure({});
    gpu.device.queue.writeBuffer(this.E, EF.RHO * this.N * 4, new Uint32Array(this.N).fill(rainWord(this.p.refRainMmYr, this.p.refRainMmYr)));
  }
  // Change parameters: the kernels' parameter words are rebuilt.
  configure(over: Partial<ErosionParams>) {
    this.p = { ...this.p, ...over };
    this.base = erosionWords(this.g, this.set, this.p);
    for (const b of this.pars.values()) b.destroy();
    this.pars.clear(); this.groups.clear();
  }
  private rec(entry: string, par: Record<number, number> = {}, groups: number | [number, number] = 0) {
    const key = entry + JSON.stringify(par);
    let P = this.pars.get(key);
    if (!P) {
      const w = new Uint32Array(this.base);
      for (const [k, v] of Object.entries(par)) w[Number(k)] = v >>> 0;
      P = storage(this.gpu, w);
      this.pars.set(key, P);
    }
    const p = pipeline(this.gpu, this.wgsl, entry);
    let bind = this.groups.get(key);
    if (!bind) {
      bind = this.gpu.device.createBindGroup({ layout: p.getBindGroupLayout(0), entries: [this.S, this.T, P, this.E, this.AT, this.X, this.gg.S].map((buffer, binding) => ({ binding, resource: { buffer } })) });
      this.groups.set(key, bind);
    }
    const g = groups === 0 ? cover(this.gpu, this.N) : typeof groups === "number" ? [groups, 1] as [number, number] : groups;
    const pass = this.enc!.beginComputePass();
    pass.setPipeline(p); pass.setBindGroup(0, bind); pass.dispatchWorkgroups(g[0], g[1]); pass.end();
  }
  private begin() { this.enc = this.gpu.device.createCommandEncoder(); }
  private submit() { this.gpu.device.queue.submit([this.enc!.finish()]); this.enc = null; }
  private readonly cntAt = () => 3 * this.N;
  private async readAt(word: number, count: number): Promise<Uint32Array> { return new Uint32Array(await readback(this.gpu, this.AT, count * 4, word * 4)); }
  async flags(): Promise<number> { return (await this.readAt(this.cntAt() + CNT.flags, 1))[0]; }
  clearFlags() { this.gpu.device.queue.writeBuffer(this.AT, (this.cntAt() + CNT.flags) * 4, new Uint32Array(1)); }
  // ---- the pieces of a substep ----
  // The height of every column from the volumes (1/256 m above the sea) and each land cell's discharge weight.
  heights() { this.begin(); this.rec("height"); this.rec("weights"); this.submit(); }
  // The heights given (1/256 m above the sea, in cell order) in place of the columns': for the checks of the stream power solver alone.
  loadHeights(h: Int32Array) { this.gpu.device.queue.writeBuffer(this.E, EF.H * this.N * 4, h); }
  setRain(mmYr: Float32Array | number) {
    const w = new Uint32Array(this.N);
    for (let i = 0; i < this.N; i++) w[i] = rainWord(typeof mmYr === "number" ? mmYr : mmYr[i], this.p.refRainMmYr);
    this.gpu.device.queue.writeBuffer(this.E, EF.RHO * this.N * 4, w);
  }
  // The flooded surface, the receivers, the depth sort and the discharge area (from the heights and weights in E).
  async flow(): Promise<number> {
    this.begin();
    this.enc!.clearBuffer(this.AT, (this.cntAt() + CNT.changed) * 4, 4);
    this.rec("flinit");
    this.submit();
    let rounds = 0, chunk = Math.max(64, this.lastRounds);
    for (;;) {
      this.begin();
      this.enc!.clearBuffer(this.AT, (this.cntAt() + CNT.changed) * 4, 4);
      for (let r = 0; r < chunk; r++) this.rec("flood");
      this.submit();
      rounds += chunk;
      if ((await this.readAt(this.cntAt() + CNT.changed, 1))[0] === 0) break;
      chunk = 64;
      if (rounds > 40000) throw new Error("erosion: the flood did not settle in 40,000 rounds");
    }
    this.lastRounds = rounds - chunk;
    this.begin();
    this.rec("recv", { [PR.rhoKey]: this.rhoKey }); this.rec("lvinit");
    for (let r = 0; r < 7; r++) { this.rec("jumpa"); this.rec("jumpb"); }
    this.rec("lvhist"); this.rec("lvscan", {}, 1); this.rec("lvscatter"); this.rec("area", {}, 1);
    this.submit();
    return rounds;
  }
  // The stream power step and what follows it, to the books: erodibility, incision, removal, the sediment down the tree, the sea's rings, apply.
  erode() {
    this.begin();
    this.rec("kappa"); this.rec("relief"); this.rec("incise", {}, 1); this.rec("waste"); this.rec("removal"); this.rec("route", {}, 1);
    this.rec("cdinit");
    for (let r = 0; r < this.p.ringMax; r++) this.rec(r % 2 === 0 ? "cda" : "cdb");
    for (let c = 1; c <= this.p.ringMax; c++) this.rec("ring", { [PR.ring]: c });
    this.rec("far");
    this.submit();
  }
  apply() { this.begin(); this.rec("apply"); this.submit(); }
  // The relief law alone on the heights in E (loadHeights): the thickness it takes from each cell in a substep, 1/256 m, in EF.WL.
  reliefOnly() { this.begin(); this.rec("relief"); this.submit(); }
  // Add the removal, deposit and dissolved volumes of the last erosion to the ledger's accumulators.
  tally() { this.begin(); this.rec("ledger"); this.submit(); }
  async ledger(clear = true): Promise<Ledger> {
    const w = await this.readAt(this.cntAt() + CNT.COUNT, 12);
    if (clear) this.gpu.device.queue.writeBuffer(this.AT, (this.cntAt() + CNT.COUNT) * 4, new Uint32Array(12));
    return { removed: limb(w, 4 * LED.removed), deposited: limb(w, 4 * LED.deposited), dissolved: limb(w, 4 * LED.dissolved) };
  }
  // Creep and the sea floor's diffusion for one substep: as many iterations as the stable step needs (the more of land and sea).
  async creep(): Promise<void> {
    const [nl, fl] = creepIterations(this.g, this.p.creepLand, this.p.dtYr), [ns, fs] = creepIterations(this.g, this.p.creepSea, this.p.dtYr);
    for (let it = 0; it < Math.max(nl, ns); it++) await this.creepOnce(it < nl ? fl : 0, it < ns ? fs : 0);
  }
  // One iteration at the given diffusion numbers (Q24): the heights, the grid's halo exchange of height, land mask and the givers' limits, the fluxes as
  // volumes, and (unless apply is false) the columns changed by them.
  async creepOnce(foLand: number, foSea: number, apply = true): Promise<void> {
    this.begin(); this.rec("height"); this.rec("creepin"); this.submit();
    for (const f of [0, 1, 2]) this.gg.halo(f);
    this.begin(); this.rec("creepflux", { [PR.foLand]: foLand, [PR.foSea]: foSea }); if (apply) this.rec("apply"); this.submit();
  }
  // One whole substep on the columns: heights, flow, erosion, books (when asked), creep. Returns the books of this substep. `seen` is called after the
  // erosion has been applied and before the creep, when RV, DS and AD hold this substep's removal, dissolved share and deposit.
  async substep(books = false, seen?: () => Promise<void>): Promise<{ rounds: number; ledger?: Ledger }> {
    this.heights();
    const rounds = await this.flow();
    this.erode();
    this.apply();
    let ledger: Ledger | undefined;
    if (books) { this.tally(); ledger = await this.ledger(); }
    if (seen) await seen();
    await this.creep();
    return { rounds, ledger };
  }
  // The stream power solver alone on heights held in E: uplift of the land by `upl` (1/256 m a step) then flood, receivers, discharge, incision.
  async solverStep(upl: number, k: number): Promise<number> {
    this.begin(); this.rec("uplift", { [PR.upl]: upl }); this.rec("weights"); this.submit();
    const rounds = await this.flow();
    this.begin(); this.rec("kconst", { [PR.kconst]: k }); this.rec("incise", {}, 1); this.submit();
    return rounds;
  }
  // ---- reading ----
  async readE(field: number): Promise<Int32Array> { return new Int32Array(await readback(this.gpu, this.E, this.N * 4, field * this.N * 4)); }
  // The sediment in transit: volume units carried over from substeps that found no room for it (a dead end of the sea's rings).
  async carry(): Promise<bigint> {
    const [lo, hi] = await Promise.all([this.readE(EF.CL), this.readE(EF.CH)]);
    let sum = 0n;
    for (let i = 0; i < lo.length; i++) sum += BigInt(lo[i] >>> 0) + (BigInt(hi[i] >>> 0) << 32n);
    return sum;
  }
  async readFlooded(): Promise<Int32Array> { return new Int32Array(await readback(this.gpu, this.AT, this.N * 4, 0)); }
  // The sediment in transit as a stopped run kept it.
  loadCarry(lo: Int32Array, hi: Int32Array) {
    this.gpu.device.queue.writeBuffer(this.E, EF.CL * this.N * 4, lo);
    this.gpu.device.queue.writeBuffer(this.E, EF.CH * this.N * 4, hi);
  }
  async readState(): Promise<Int32Array> { return new Int32Array(await readback(this.gpu, this.S, FLD.COUNT * fieldWords(this.g) * 4)); }
  async readFlow(): Promise<Flow> {
    const [to, acc, depth, height] = await Promise.all([EF.TO, EF.ACC, EF.DP, EF.H].map((f) => this.readE(f)));
    return { to: new Uint32Array(to.buffer), acc: new Uint32Array(acc.buffer), depth, height, flooded: await this.readFlooded(), rounds: this.lastRounds };
  }
  release() {
    for (const b of [this.E, this.AT, this.X, this.T, ...this.pars.values()]) b.destroy();
    this.gg.release();
    this.pars.clear(); this.groups.clear();
  }
}

// ---------- 4. the twin: every kernel in TypeScript ----------
const M32 = 0xffffffffn;
const shrR = (x: bigint, n: bigint) => (x < 0n ? -((-x + (1n << (n - 1n))) >> n) : (x + (1n << (n - 1n))) >> n);
const sqrtBig = (n: bigint): bigint => {
  if (n < 2n) return n;
  let x = BigInt(Math.floor(Math.sqrt(Number(n))));
  while (x * x > n) x--;
  while ((x + 1n) * (x + 1n) <= n) x++;
  return x;
};
const imax = (a: number, b: number) => (a > b ? a : b);

export interface TwinResult {
  H: Int32Array; W: Uint32Array; flooded: Int32Array; to: Uint32Array; rd: Uint32Array; depth: Int32Array; acc: Uint32Array; kc: Uint32Array; er: Int32Array;
  rv: Uint32Array; ds: Uint32Array; ps: Uint32Array; ad: Uint32Array; ql: Uint32Array; qh: Uint32Array; cd: Int32Array;
  wl: Int32Array; extra: Int32Array; // the relief law's thickness for each cell, and what it added to the incision (1/256 m)
}

// The twin of one substep's flow and erosion on a copy of the state S (the tectonics fields in the padded layout, changed in place), for
// the cells in cell order: the same integers as the kernels, one cell at a time. `rain` is the Q8 relative rain of each cell.
export class Twin {
  readonly N: number;
  readonly nb: Uint32Array;
  readonly invd: Uint32Array;
  readonly area: Int32Array;
  readonly pw: Int32Array;
  readonly fw: number;
  readonly words: Uint32Array;
  readonly sea16: number;
  readonly phith: Int32Array;
  rhoKey = 0;
  constructor(readonly set: Setup, readonly ext: { tab: Tables; T: Int32Array }, readonly p: ErosionParams) {
    const g = set.grid;
    this.N = FACES * g.fn * g.fn; this.fw = fieldWords(g);
    const x = erosionTable(set);
    this.nb = x.subarray(0, 8 * this.N); this.invd = x.subarray(8 * this.N, 16 * this.N);
    this.phith = new Int32Array(x.buffer, (16 * this.N) * 4, PHYS.AGE_MAX + 1);
    this.area = ext.T.subarray(0, this.N);
    this.pw = new Int32Array(this.N);
    for (let f = 0; f < FACES; f++) for (let Y = 0; Y < g.fn; Y++) for (let X = 0; X < g.fn; X++) this.pw[cellId(g, f, X, Y)] = wordAt(g, f, X, Y);
    this.words = erosionWords(g, set, p);
    this.sea16 = Math.round(set.params.seaLevel * 16);
  }
  private get(S: Int32Array, f: number, k: number) { return S[f * this.fw + this.pw[k]] >>> 0; }
  private put(S: Int32Array, f: number, k: number, v: number) { S[f * this.fw + this.pw[k]] = v | 0; }
  private thick16(v: number, a: number) { return Math.floor(v / a) * 256 + Math.floor(((v % a) * 256) / a); }
  private thickM(v: number, a: number) { return Math.floor(v / a) * 16 + Math.floor(((v % a) * 16) / a); }
  total(S: Int32Array, k: number) { let t = 0; for (let f = 0; f < 5; f++) t += this.get(S, f, k); return t; }
  // the height of a column in 1/256 m above the sea
  height(S: Int32Array, k: number): number {
    const a = this.area[k], DR = PHYS.RHO.map((r) => PHYS.RHO_M - r), vb = this.get(S, 0, k), tb = this.thick16(vb, a);
    let phi = 0;
    for (let f = 0; f < 5; f++) phi += (f === 0 ? tb : this.thick16(this.get(S, f, k), a)) * DR[f];
    const nb = vb >>> PHYS.AGE_SHIFT;
    const age = nb > 0 ? Math.min(Math.floor(this.get(S, 5, k) / nb), PHYS.AGE_MAX) : 0;
    const q16 = this.phith[age] * 16, hb = Math.min(tb, 96000), rho15 = Math.floor((hb * 32768) / 96000);
    const th16 = Number(shrR(BigInt(q16) * BigInt(rho15), 15n));
    const d16 = phi + th16 - PHYS.H0 * (PHYS.RHO_M - 2800) * 16;
    const z16 = d16 >= 0 ? Math.trunc(d16 / PHYS.RHO_M) : Math.trunc(d16 / (PHYS.RHO_M - PHYS.RHO_W));
    return (z16 - this.sea16) * 16;
  }
  // The priority flood by Dijkstra from the ocean: the same unique fixed point as the kernels' rounds.
  flood(H: Int32Array, eps = 1): Int32Array {
    const N = this.N, INF = 0x7fffffff, f = new Int32Array(N);
    const heap: number[] = [], key = (i: number) => f[i];
    const up = (i: number) => { while (i > 0) { const p = (i - 1) >> 1; if (key(heap[p]) <= key(heap[i])) break; [heap[p], heap[i]] = [heap[i], heap[p]]; i = p; } };
    const down = (i: number) => { for (;;) { let m = i; const l = 2 * i + 1, r = l + 1; if (l < heap.length && key(heap[l]) < key(heap[m])) m = l; if (r < heap.length && key(heap[r]) < key(heap[m])) m = r; if (m === i) break; [heap[m], heap[i]] = [heap[i], heap[m]]; i = m; } };
    for (let i = 0; i < N; i++) { f[i] = H[i] > 0 ? INF : H[i]; if (H[i] <= 0) heap.push(i); }
    for (let i = (heap.length >> 1) - 1; i >= 0; i--) down(i);
    const done = new Uint8Array(N);
    while (heap.length) {
      const i = heap[0], last = heap.pop()!;
      if (heap.length) { heap[0] = last; down(0); }
      if (done[i]) continue;
      done[i] = 1;
      for (let d = 0; d < 8; d++) {
        const j = this.nb[i * 8 + d];
        if (j === NONE || H[j] <= 0 || done[j]) continue;
        const cand = imax(H[j], f[i] + eps);
        if (cand < f[j]) { f[j] = cand; heap.push(j); up(heap.length - 1); }
      }
    }
    return f;
  }
  receivers(H: Int32Array, f: Int32Array): { to: Uint32Array; rd: Uint32Array } {
    const N = this.N, to = new Uint32Array(N), rd = new Uint32Array(N);
    for (let k = 0; k < N; k++) {
      to[k] = k;
      if (H[k] <= 0) continue;
      let best = 0n;
      const rw = philox([k, this.rhoKey, 0, 0x52484f38], [this.set.params.seed >>> 0, 0x524f5554]);
      for (let d = 0; d < 8; d++) {
        const j = this.nb[k * 8 + d];
        if (j === NONE) continue;
        const dz = f[k] - f[j];
        if (dz <= 0) continue;
        const iv = this.invd[k * 8 + d];
        let ev = iv;
        if (d >= 4) ev = Number(((BigInt(iv) * BigInt(Math.floor((92682 * 32768) / ((131072 - (rw[d - 4] & 0xffff)) >> 1)))) >> 16n) & M32);
        const key = BigInt(dz) * BigInt(ev);
        if (key > best) { best = key; to[k] = j; rd[k] = iv; }
      }
    }
    return { to, rd };
  }
  depths(to: Uint32Array): { depth: Int32Array; order: Int32Array } {
    const N = this.N, depth = new Int32Array(N).fill(-1);
    for (let k = 0; k < N; k++) {
      const path: number[] = [];
      let i = k;
      while (depth[i] < 0 && to[i] !== i) { path.push(i); i = to[i]; if (path.length > N) throw new Error("erosion twin: a cycle in the receivers"); }
      let d = to[i] === i ? 0 : depth[i];
      if (depth[i] < 0) depth[i] = 0;
      for (let q = path.length - 1; q >= 0; q--) depth[path[q]] = ++d;
    }
    const order = Int32Array.from({ length: N }, (_, i) => i).sort((a, b) => depth[a] - depth[b] || a - b);
    return { depth, order };
  }
  // The whole of a substep after the heights: returns every field the kernels leave, and changes S as the apply kernel does.
  erode(S: Int32Array, rain: Uint32Array, carry: BigUint64Array, H0?: Int32Array): TwinResult {
    const N = this.N, w = this.words, p = this.p;
    const H = H0 ? Int32Array.from(H0) : Int32Array.from({ length: N }, (_, k) => this.height(S, k));
    const W = new Uint32Array(N);
    for (let k = 0; k < N; k++) if (H[k] > 0) W[k] = Number((BigInt(this.area[k]) * BigInt(rain[k]) + 8192n) >> 14n);
    const flooded = this.flood(H), { to, rd } = this.receivers(H, flooded), { depth, order } = this.depths(to);
    const acc = new Uint32Array(N);
    for (let q = N - 1; q >= 0; q--) { const k = order[q]; acc[k] = (acc[k] + W[k]) >>> 0; if (to[k] !== k) acc[to[k]] = (acc[to[k]] + acc[k]) >>> 0; }
    // erodibility from the top skin
    const kc = new Uint32Array(N), ORDER = [1, 4, 2, 3, 0];
    for (let k = 0; k < N; k++) {
      if (H[k] <= 0) continue;
      let rem = w[PR.skin], num = 0n, den = 0;
      for (const pl of ORDER) { const t = Math.min(this.thickM(this.get(S, pl, k), this.area[k]), rem); rem -= t; den += t; num += BigInt(t) * BigInt(w[PR.kc + pl]); }
      if (den > 0) kc[k] = Number(num / BigInt(den));
    }
    // landscape-scale denudation by relief, from the heights before the incision
    const wl = new Int32Array(N);
    if (w[PR.rc] > 0) {
      const rc = w[PR.rc], rcap = (rc * 15) >> 4;
      for (let k = 0; k < N; k++) {
        if (H[k] <= 0) continue;
        let low = H[k], high = H[k];
        for (let d1 = 0; d1 < 8; d1++) {
          const j = this.nb[k * 8 + d1];
          if (j === NONE) continue;
          low = Math.min(low, Math.max(H[j], 0)); high = Math.max(high, H[j]);
          for (let d2 = 0; d2 < 8; d2++) {
            if (d1 >= 4 && d2 === d1) continue;
            const m = this.nb[j * 8 + d2];
            if (m === NONE) continue;
            low = Math.min(low, Math.max(H[m], 0)); high = Math.max(high, H[m]);
          }
        }
        let r = high - Math.max(low, 0), tot = 0;
        for (let s = 0; s < 8; s++) {
          const rr = Math.min(r, rcap), q = Number((BigInt(rr) << 16n) / BigInt(rc)), den = 65536 - ((q * q) >>> 16);
          const dh = Math.min(Number((BigInt(rr) * BigInt(w[PR.kdt])) / BigInt(den)) + w[PR.e0], r);
          r -= dh; tot += dh;
        }
        wl[k] = tot;
      }
    }
    // the implicit step, shallowest first
    const er = new Int32Array(N), Hn = Int32Array.from(H);
    for (let q = 0; q < N; q++) {
      const k = order[q];
      if (depth[k] < 1) continue;
      const j = to[k], hk = Hn[k];
      if (hk <= 0 || j === k || flooded[k] > hk) continue;
      const hj = Hn[j] > 0 ? Hn[j] : 0;
      if (hj >= hk || kc[k] === 0) continue;
      const delta = hk - hj;
      let x = delta;
      if (p.n === 1) {
        const s8 = sqrtBig(BigInt(acc[k]) << 16n), p1 = BigInt(kc[k]) * BigInt(rd[k]), p1s = p1 >> 16n > M32 ? M32 : p1 >> 16n;
        const f64 = (p1s * s8) >> 16n, f16 = f64 > 0x7fffffffn ? 0x7fffffffn : f64;
        if (f16 > 0n) { const u = (65536n << 32n) / (f16 + 65536n); x = Number((BigInt(delta) * u + (1n << 31n)) >> 32n); }
      } else {
        const t1 = BigInt(acc[k]) * BigInt(delta), a = (BigInt(kc[k]) * BigInt(rd[k]) * BigInt(rd[k])) >> 28n, a32 = a > M32 ? M32 : a;
        let z16 = (t1 * a32) >> 32n;
        if (z16 >= 0x8000n << 32n) z16 = (0x7fffn << 32n) | M32;
        const sq = (() => { const s = sqrtBig((z16 + 65536n) << 16n); return s > 0x7fffffffn ? 0x7fffffffn : s; })();
        x = Number(((BigInt(delta) << 17n) / (65536n + sq)) & M32);
      }
      const nh = Math.max(hj + x, 1);
      if (nh < hk) { er[k] = hk - nh; Hn[k] = nh; }
    }
    // what the relief law takes beyond the incision (not in lakes: the flooded surface above the floor)
    const added = new Int32Array(N);
    if (w[PR.rc] > 0)
      for (let k = 0; k < N; k++) {
        if (Hn[k] <= 0 || flooded[k] > Hn[k] + er[k]) continue;
        const extra = Math.min(Math.max(wl[k] - er[k], 0), Hn[k] - 1);
        if (extra > 0) { added[k] = extra; er[k] += extra; Hn[k] -= extra; }
      }
    // what was taken, and the dissolved share
    const rv = new Uint32Array(N), ds = new Uint32Array(N), ps = new Uint32Array(N), ad = new Uint32Array(N), ql = new Uint32Array(N), qh = new Uint32Array(N);
    for (let k = 0; k < N; k++) {
      if (er[k] <= 0) continue;
      const r = Math.min(Number((BigInt(er[k]) * BigInt(this.area[k]) + 2048n) >> 12n), this.total(S, k));
      rv[k] = r; ds[k] = Number((BigInt(r) * BigInt(w[PR.diss16])) >> 16n); ps[k] = r - ds[k];
    }
    // the sediment down the tree, deepest first
    const out = new BigInt64Array(N), xo = new BigInt64Array(N), g8 = BigInt(w[PR.g8]);
    for (let q = N - 1; q >= 0; q--) {
      const k = order[q];
      if (depth[k] < 1) continue;
      let avail = BigInt(ps[k]), xin = carry[k];
      carry[k] = 0n;
      for (let e = 0; e < 8; e++) { const j = this.nb[k * 8 + e]; if (j !== NONE && j !== k && to[j] === k) { avail += out[j]; xin += xo[j]; } }
      let dep = 0n, xout = xin;
      const hk = H[k], fk = flooded[k];
      if (fk > hk) {
        const cap = this.fillCap(fk - hk, k);
        dep = avail < cap ? avail : cap;
        const room = cap - dep, more = xin < room ? xin : room;
        dep += more; xout = xin - more;
      } else if (g8 > 0n) {
        const gw = g8 * BigInt(W[k]), den = gw + (BigInt(acc[k]) << 8n);
        let sh = 0n;
        if (den >> 32n !== 0n) sh = BigInt((den >> 32n).toString(2).length) + 1n;
        const dd = den >> sh, yy = gw >> sh, lam = dd > 0n ? (yy << 16n) / dd : 65536n;
        dep = (avail * lam) >> 16n;
      }
      out[k] = avail - (avail < dep ? avail : dep);
      xo[k] = xout;
      ad[k] = Number(dep & M32);
    }
    // the rings of the sea
    const cd = this.rings(H);
    for (let c = 1; c <= p.ringMax; c++) {
      const cur: number[] = [];
      for (let k = 0; k < N; k++) if (cd[k] === c) cur.push(k);
      const kids = (q: number, cq: number) => { if (cq >= p.ringMax) return 0; let n = 0; for (let d = 0; d < 8; d++) { const j = this.nb[q * 8 + d]; if (j !== NONE && cd[j] === cq + 1) n++; } return n; };
      for (const k of cur) {
        let avail = 0n;
        for (let e = 0; e < 8; e++) {
          const j = this.nb[k * 8 + e];
          if (j === NONE) continue;
          if (c === 1) { if (H[j] > 0 && to[j] === k) avail += out[j] + xo[j]; }
          else if (cd[j] === c - 1) {
            const n = BigInt(kids(j, c - 1)), q = out[j] / n, r = out[j] % n;
            let rank = 0;
            for (let f = 0; f < 8; f++) { const m = this.nb[j * 8 + f]; if (m === k) break; if (m !== NONE && cd[m] === c) rank++; }
            avail += q + (BigInt(rank) < r ? 1n : 0n);
          }
        }
        avail += carry[k];
        const ramp = kids(k, c) === 0 ? 0 : -(c * w[PR.shelf]);
        const cap = this.fillCap(Math.max(ramp - H[k], 0), k), dep = avail < cap ? avail : cap;
        let rest = avail - dep;
        carry[k] = 0n;
        if (kids(k, c) === 0) { carry[k] = rest; rest = 0n; }
        out[k] = rest; ad[k] = Number(dep & M32);
      }
    }
    for (let k = 0; k < N; k++) {
      if (H[k] > 0 || cd[k] !== 0x7fffffff) continue;
      const cap = this.fillCap(Math.max(-H[k], 0), k), dep = carry[k] < cap ? carry[k] : cap;
      carry[k] -= dep; ad[k] = Number(dep & M32);
    }
    for (let k = 0; k < N; k++) { ql[k] = Number(BigInt.asUintN(64, out[k]) & M32); qh[k] = Number(BigInt.asUintN(64, out[k]) >> 32n); }
    this.apply(S, rv, ad, carry);
    return { H: Hn, W, flooded, to, rd, depth, acc, kc, er, rv, ds, ps, ad, ql, qh, cd, wl, extra: added };
  }
  // The sediment that fills a gap g (1/256 m) of cell k's surface, in volume units, with the subsidence the load makes (the kernels' fill_cap).
  fillCap(g: number, k: number): bigint {
    const v = (BigInt(g) * BigInt(this.area[k]) + 2048n) >> 12n;
    return (v * BigInt(Math.round(CAP_FACTOR * 65536))) >> 16n;
  }
  rings(H: Int32Array): Int32Array {
    const N = this.N, INF = 0x7fffffff;
    let cd = Int32Array.from({ length: N }, (_, k) => (H[k] > 0 ? 0 : INF));
    for (let r = 0; r < this.p.ringMax; r++) {
      const next = Int32Array.from(cd);
      for (let k = 0; k < N; k++) {
        if (cd[k] !== INF) continue;
        let m = INF;
        for (let d = 0; d < 8; d++) { const j = this.nb[k * 8 + d]; if (j !== NONE) m = Math.min(m, cd[j]); }
        if (m !== INF) next[k] = m + 1;
      }
      cd = next;
    }
    return cd;
  }
  // The apply kernel: rock off the top of the stack down, sediment on top, ages scaled with the volumes.
  apply(S: Int32Array, rv: Uint32Array, ad: Uint32Array, carry: BigUint64Array) {
    for (let k = 0; k < this.N; k++) {
      const r = rv[k], a = ad[k];
      if (r === 0 && a === 0) continue;
      const v = [0, 1, 2, 3, 4].map((f) => this.get(S, f, k)), agb = this.get(S, 5, k), org = this.get(S, 6, k), t0 = v.reduce((s, x) => s + x, 0);
      let rem = r;
      const nv = [...v];
      for (const pl of [1, 4, 2, 3, 0]) { const t = Math.min(rem, nv[pl]); nv[pl] -= t; rem -= t; }
      if (rem !== 0) throw new Error("erosion twin: removal beyond the column");
      const room = nv[1] < 2 ** 28 - 1 ? 2 ** 28 - 1 - nv[1] : 0, put = Math.min(a, room);
      if (put !== a) { carry[k] += BigInt(a - put); ad[k] = put; }
      nv[1] += put;
      const t1 = nv.reduce((s, x) => s + x, 0);
      for (let f = 0; f < 5; f++) this.put(S, f, k, nv[f]);
      if (nv[0] !== v[0] && v[0] >>> PHYS.AGE_SHIFT > 0) this.put(S, 5, k, Number((BigInt(agb) * BigInt(nv[0] >>> PHYS.AGE_SHIFT)) / BigInt(v[0] >>> PHYS.AGE_SHIFT)));
      if (t1 !== t0 && t0 >>> PHYS.AGE_SHIFT > 0) this.put(S, 6, k, Number((BigInt(org) * BigInt(t1 >>> PHYS.AGE_SHIFT)) / BigInt(t0 >>> PHYS.AGE_SHIFT)));
    }
  }
  // One creep iteration: the volume each cell gains (negative: loses) from the grid's flux, per link rounded to whole volume units, limited by the
  // giver's spare volume; the foLand and foSea numbers in Q24.
  creep(S: Int32Array, H: Int32Array, foLand: number, foSea: number): Int32Array {
    const g = this.set.grid, tab = this.ext.tab, tw = tab.tw, N = this.N, dv = new Int32Array(N);
    const q = new Int32Array(this.fw), land = new Int32Array(this.fw), lim = new Int32Array(this.fw);
    for (let k = 0; k < N; k++) {
      const at = this.pw[k];
      q[at] = Math.trunc(H[k] / 4); land[at] = H[k] > 0 ? 1 : 0;
      lim[at] = Math.floor((H[k] > 0 ? this.total(S, k) : this.get(S, 1, k)) / 8);
    }
    // halos: each cell's ring from the cell across (copy mode), by the grid's own twin
    const words = new Int32Array(3 * this.fw);
    words.set(q, 0); words.set(land, this.fw); words.set(lim, 2 * this.fw);
    for (const f of [0, 1, 2]) haloTwin(g, words, f);
    const OFF = [1, 258, -1, -258, 259, 257, -259, -257];
    const Q = words.subarray(0, this.fw), L = words.subarray(this.fw, 2 * this.fw), M = words.subarray(2 * this.fw);
    for (let k = 0; k < N; k++) {
      const at = this.pw[k], q0 = Q[at];
      const corner = (c: number) => {
        let sum = 0n;
        for (let j = 0; j < 4; j++) sum += BigInt(tab.words[(9 + 4 * c + j) * tw + k]) * BigInt(Q[at + (j === 0 ? 0 : j === 1 ? OFF[c] : j === 2 ? OFF[(c + 1) & 3] : OFF[4 + c])] - q0);
        return sum;
      };
      let total = 0;
      for (let d = 0; d < 4; d++) {
        const nbw = at + OFF[d];
        if ((L[at] === 1) !== (L[nbw] === 1)) continue;
        const fo = L[at] === 1 ? foLand : foSea;
        if (fo === 0) continue;
        const ends = Number(BigInt.asIntN(32, shrR(corner(d) - corner((d + 3) & 3), BigInt(14))));
        const cr = shrR(BigInt(tab.words[(5 + d) * tw + k]) * BigInt(ends), 6n);
        const s = BigInt(tab.words[(1 + d) * tw + k]) * BigInt(Q[nbw] - q0) + cr;
        const s1 = shrR(s, 8n), flux = shrR(s1 * BigInt(fo), 25n);
        let v = Number(shrR(flux, 10n));
        const lm = v > 0 ? M[nbw] : M[at];
        v = Math.max(-lm, Math.min(lm, v));
        total += v;
      }
      dv[k] = total;
    }
    return dv;
  }
}

// ---------- 5. the whole chain: tectonics with erosion between its steps ----------
export interface ChainOptions {
  // The rain field in mm/yr for the planet as it stands (height above the sea in m, in cell order) and the time in My: the atmosphere's rain, or a number
  // for a uniform one. Asked at the start and every `rainEveryMy`.
  rain: (height: Float32Array, tMy: number) => Promise<Float32Array | number>;
  rainEveryMy: number;
  substeps: number; // erosion substeps after each tectonic step: the substep is the step over this
  params?: Partial<ErosionParams>;
  // Erosion starts after this many My of tectonics (0: from the start).
  erodeFromMy?: number;
  // After the span, erosion alone (no plate motion, no new rock) for this many My: what the landscape does when the uplift has stopped.
  afterMy?: number;
  track?: boolean; // keep each cell's total removed and deposited volume over the run
  onStep?: (step: number, er: Erosion, tec: Tectonics) => void | Promise<void>;
  // Stop before the next step once this many seconds have passed (every part makes at least one step), returning the state to resume from (`stopped`), and resume from such a state: a run kept in parts
  // each under a call's limit gives the bytes of the run made whole, since everything a step reads is in the state.
  budgetS?: number;
  resume?: ChainState;
}
// What a stopped run keeps: the tectonics' state (the rock volumes, ages and plates), the sediment in transit, the rain field and when it is next asked for, and where the
// run had got to (the tectonic steps done, then the erosion-only substeps done), with the books so far.
export interface ChainState {
  S: Int32Array; carryLo: Int32Array; carryHi: Int32Array; rain: Float32Array; nextRain: number;
  step: number; quiet: number; rounds: number; ledger: [string, string, string];
}
export interface ChainResult {
  S: Int32Array; // the final state, elevation current
  ledger: Ledger; // removed, deposited and dissolved over the run, volume units
  carry: bigint; // sediment still in transit at the end
  removedV?: Float64Array; depositedV?: Float64Array; // per cell, volume units
  rain: Float32Array; // the last rain field, mm/yr
  flow: Flow;
  rounds: number; // flood rounds, the most a substep took
  seconds: number;
  stopped?: ChainState; // set when the run stopped at its budget: the fields above are then the partial run's and the state is what to resume from
}
// Tectonics for the whole span with `substeps` of erosion after each step (interleaved: rock removed from a column and deposited changes the
// volumes the next tectonic step moves, and isostasy re-floats a column as it is cut), on one device; the planet from `startingState` unless given.
export async function runChain(gpu: Gpu, set: Setup, o: ChainOptions, from?: ReturnType<typeof startingState>): Promise<ChainResult> {
  const t0 = performance.now(), ext = extTables(set.grid), r0 = o.resume, tec = new Tectonics(gpu, set, ext, r0 ? r0.S : (from ?? startingState(set, ext.tab)).S);
  const dt = (set.params.stepMy * 1e6) / o.substeps, er = new Erosion(gpu, set, ext, tec.S, { ...o.params, dtYr: dt });
  const N = er.N, total: Ledger = r0 ? { removed: BigInt(r0.ledger[0]), deposited: BigInt(r0.ledger[1]), dissolved: BigInt(r0.ledger[2]) } : { removed: 0n, deposited: 0n, dissolved: 0n };
  const removedV = o.track ? new Float64Array(N) : undefined, depositedV = o.track ? new Float64Array(N) : undefined;
  let rain: Float32Array = r0 ? r0.rain : new Float32Array(N), nextRain = r0 ? r0.nextRain : 0, rounds = r0 ? r0.rounds : 0;
  const late = () => o.budgetS !== undefined && (performance.now() - t0) / 1000 > o.budgetS;
  const stop = async (step: number, quiet: number): Promise<ChainResult> => {
    const [carryLo, carryHi] = await Promise.all([er.readE(EF.CL), er.readE(EF.CH)]);
    const stopped: ChainState = { S: await tec.read(), carryLo, carryHi, rain, nextRain, step, quiet, rounds, ledger: [String(total.removed), String(total.deposited), String(total.dissolved)] };
    return { S: stopped.S, ledger: total, carry: 0n, removedV, depositedV, rain, flow: undefined as unknown as Flow, rounds, seconds: (performance.now() - t0) / 1000, stopped };
  };
  try {
    if (r0) { tec.stepNo = r0.step; er.loadCarry(r0.carryLo, r0.carryHi); er.setRain(rain); }
    const first = r0 ? r0.step : 0;
    for (let s = first; s < set.steps; s++) {
      if (s > first && late()) return await stop(s, 0);
      const t = s * set.params.stepMy;
      tec.step();
      if (t >= (o.erodeFromMy ?? 0)) {
        if (t >= nextRain) {
          er.heights();
          const h = await er.readE(EF.H), height = Float32Array.from(h, (v) => v / 256), r = await o.rain(height, t);
          rain = typeof r === "number" ? new Float32Array(N).fill(r) : r;
          er.setRain(rain); nextRain = t + o.rainEveryMy;
        }
        for (let q = 0; q < o.substeps; q++) {
          er.rhoKey = s * o.substeps + q;
          const r = await er.substep(true, removedV ? async () => { const [rv, ad] = await Promise.all([er.readE(EF.RV), er.readE(EF.AD)]); for (let i = 0; i < N; i++) { removedV[i] += rv[i] >>> 0; depositedV![i] += ad[i] >>> 0; } } : undefined);
          rounds = Math.max(rounds, r.rounds);
          total.removed += r.ledger!.removed; total.deposited += r.ledger!.deposited; total.dissolved += r.ledger!.dissolved;
        }
        const fl = await er.flags();
        if (fl !== 0) throw new Error(`erosion flags ${fl} at step ${s}`);
      }
      if (o.onStep) await o.onStep(s, er, tec);
    }
    const quiet = o.substeps > 0 ? Math.round(((o.afterMy ?? 0) * 1e6) / dt) : 0;
    const quietFirst = r0 ? r0.quiet : 0;
    for (let q = quietFirst; q < quiet; q++) {
      if ((q > quietFirst || first >= set.steps) && late()) return await stop(set.steps, q);
      er.rhoKey = set.steps * o.substeps + q;
      const r = await er.substep(true, removedV ? async () => { const [rv, ad] = await Promise.all([er.readE(EF.RV), er.readE(EF.AD)]); for (let i = 0; i < N; i++) { removedV[i] += rv[i] >>> 0; depositedV![i] += ad[i] >>> 0; } } : undefined);
      rounds = Math.max(rounds, r.rounds);
      total.removed += r.ledger!.removed; total.deposited += r.ledger!.deposited; total.dissolved += r.ledger!.dissolved;
    }
    tec.elevate();
    const S = await tec.read();
    er.rhoKey = set.steps * o.substeps + quiet;
    er.heights(); await er.flow();
    return { S, ledger: total, carry: await er.carry(), removedV, depositedV, rain, flow: await er.readFlow(), rounds, seconds: (performance.now() - t0) / 1000 };
  } finally {
    er.release(); tec.release();
  }
}

// ---------- 6. reading the result ----------
// The height-area curve: the share of the planet's area in each band of height, from `lo` to `hi` m in bands of `step`.
export function hypsometry(g: Grid, height: ArrayLike<number>, lo = -8000, hi = 8000, step = 250): { edges: number[]; share: number[]; landShare: number; meanLandM: number; above: (m: number) => number } {
  const areas = cellAreas(g), bands = Math.round((hi - lo) / step), share = new Array(bands).fill(0);
  let land = 0, sum = 0;
  for (let i = 0; i < areas.length; i++) {
    const b = Math.min(bands - 1, Math.max(0, Math.floor((height[i] - lo) / step)));
    share[b] += areas[i] / (4 * Math.PI);
    if (height[i] > 0) { land += areas[i]; sum += areas[i] * height[i]; }
  }
  return { edges: Array.from({ length: bands + 1 }, (_, b) => lo + b * step), share, landShare: land / (4 * Math.PI), meanLandM: land > 0 ? sum / land : 0, above: (m: number) => { let a = 0; for (let i = 0; i < areas.length; i++) if (height[i] > m) a += areas[i]; return a / (4 * Math.PI); } };
}

export interface Rivers {
  longestKm: number; longestBasinKm2: number; mouthCells: number; basins: number[]; // each basin's area, km2, largest first
  over1e6: number; landKm2: number;
}
// Rivers from the receivers: the longest path to the sea (summed distance along the receivers), and the basins (the land draining to each
// ocean cell that receives a river), by true cell area.
export function rivers(g: Grid, to: Uint32Array, height: ArrayLike<number>, inv: Uint32Array, nb: Uint32Array): Rivers {
  const N = to.length, areas = cellAreas(g), R2 = g.radius * g.radius;
  const len = new Float64Array(N).fill(-1), root = new Int32Array(N).fill(-1);
  const stack: number[] = [];
  for (let k = 0; k < N; k++) {
    if (height[k] <= 0) { len[k] = 0; root[k] = k; continue; }
    let i = k;
    stack.length = 0;
    while (len[i] < 0 && to[i] !== i) { stack.push(i); i = to[i]; }
    if (len[i] < 0) { len[i] = 0; root[i] = i; }
    while (stack.length) {
      const c = stack.pop()!, up = to[c];
      let d = 0;
      for (let e = 0; e < 8; e++) if (nb[c * 8 + e] === up) { d = 2 ** 28 / inv[c * 8 + e]; break; }
      len[c] = len[up] + d; root[c] = root[up];
    }
  }
  const basin = new Map<number, number>();
  let longest = 0, longestRoot = -1, land = 0;
  for (let k = 0; k < N; k++) {
    if (height[k] <= 0) continue;
    land += areas[k] * R2;
    basin.set(root[k], (basin.get(root[k]) ?? 0) + areas[k] * R2);
    if (len[k] > longest) { longest = len[k]; longestRoot = root[k]; }
  }
  const sizes = [...basin.values()].map((a) => a / 1e6).sort((a, b) => b - a);
  return { longestKm: longest / 1000, longestBasinKm2: (basin.get(longestRoot) ?? 0) / 1e6, mouthCells: basin.size, basins: sizes, over1e6: sizes.filter((a) => a >= 1e6).length, landKm2: land / 1e6 };
}

// The drainage area of a cell in m2 from the kernels' units (1/512 of a mean cell at the reference rain).
export const accToM2 = (g: Grid, acc: number) => (acc * meanAreaM2(g)) / 512;
