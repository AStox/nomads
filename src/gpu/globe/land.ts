// A block of a fine tier (a few hundred to a few thousand cells a side, at the 75 m tier) solved in memory as one patch of the regional kernels, the cells round it held at the heights they are
// given: the test bed of the fine tiers' erosion law before it is run over the planet (tiers-stream.ts runs the same kernels block by block). The same entry points, in the order of a
// regional step (regional.ts Regional.step), over a patch whose halo is read and never written: a river that reaches the halo leaves the region there, as if into the sea.
import { openSync, readSync, closeSync } from "node:fs";
import type { Gpu } from "../device";
import { patchAt, type Patch } from "./patch";
import { REFINE_HALO, REFINE_PASSES, refineBlock } from "./tiers-stream";
import { RegionalPatch, TREE } from "./regional-patch";
import { creepSubsOf } from "./regional";
import { BAND_FLAG_CARRY } from "../wgsl/globe-band-hold";
import { SOLVE_SWEEPS } from "../wgsl/globe-regional";

const INF = 0x7fffffff;
const NP = 6 * 256 * 256;

// The children, at the tier above `from`, of a square of tier-`from` cells (interior `size`, from face position (X0, Y0)) of a field kept whole in `parent` (indexed by cell id).
export function refineRegion(parent: ArrayLike<number>, from: number, face: number, X0: number, Y0: number, size: number): Int32Array {
  return refineBlock(parent, from, patchAt(from, face, X0, Y0, REFINE_HALO, size), REFINE_PASSES);
}

// Tier 4 over a tier-5 region (interior `size` cells from (x0, y0) of a face) and the ring the next carry reads, carried down from tier 3's file by refineBlock as the chain carries it, in a
// tier-4 array (the whole tier's length, zero outside the block).
export function regionBlock4(t3: ArrayLike<number>, face: number, x0: number, y0: number, size: number): Int32Array {
  const fn4 = 256 << 4, t4 = new Int32Array(6 * fn4 * fn4);
  const X4 = x0 / 2 - REFINE_HALO, Y4 = y0 / 2 - REFINE_HALO, S4 = size / 2 + 2 * REFINE_HALO;
  if (X4 < 0 || Y4 < 0 || X4 + S4 > fn4 || Y4 + S4 > fn4 || X4 % 2 || Y4 % 2 || S4 % 2) throw new Error("regionBlock4: the region is too near its face's edge for the carry's rings");
  const c = refineRegion(t3, 3, face, X4 / 2, Y4 / 2, S4 / 2);
  for (let y = 0; y < S4; y++) for (let x = 0; x < S4; x++) t4[(face * fn4 + Y4 + y) * fn4 + X4 + x] = c[y * S4 + x];
  return t4;
}
// The tier-5 interior of the region from tier 4's cells (regionBlock4's, or those a tier-4 solve has made).
export const regionStart = (t4: ArrayLike<number>, face: number, x0: number, y0: number, size: number): Int32Array => refineRegion(t4, 4, face, x0 / 2, y0 / 2, size / 2);

// Cells of a tier's row-major file by id.
export function readCells(file: string, ids: ArrayLike<number>): Int32Array {
  const fd = openSync(file, "r"), out = new Int32Array(ids.length), buf = Buffer.alloc(4);
  try {
    for (let k = 0; k < ids.length; k++) { readSync(fd, buf, 0, 4, ids[k] * 4); out[k] = buf.readInt32LE(0); }
  } finally { closeSync(fd); }
  return out;
}

// The halo of a region's patch: two cells, which the slides of sixteen neighbours read.
export const LAND_HALO = 2;
export interface LandOptions { nflow: 4 | 8; stochastic?: boolean; slide?: 8 | 16; band?: 1 | 2 }
export interface LandState { height: Int32Array; carry: Int32Array; steps: number }

export class LandRegion {
  readonly patch: Patch;
  readonly solver: RegionalPatch;
  readonly side: number;
  subs: number;
  private readonly flood0: Int32Array;
  lastRounds = 256;
  lastSlide = 32;
  steps = 0;
  loss = 0; // the heights the last step took off the land (the sum of 1/256 m over the interior's land cells)
  readonly seconds: Record<string, number> = { flood: 0, tree: 0, incise: 0, slide: 0, creep: 0, lift: 0 };

  // `height` is the patch's cells (side * side, halo included, the halo at the heights held); `flooded` the halo's flooded surface (a halo cell's value; interior values are ignored).
  constructor(readonly gpu: Gpu, readonly tier: number, face: number, x0: number, y0: number, readonly size: number, table: Uint32Array, height: Int32Array, flooded: Int32Array, o: LandOptions = { nflow: 8 }) {
    this.patch = patchAt(tier, face, x0, y0, LAND_HALO, size);
    this.side = this.patch.side;
    this.subs = creepSubsOf(table);
    this.solver = new RegionalPatch(gpu, tier, size, table, this.subs, o.nflow, o.stochastic ? 1 : 0, o.slide ?? 8, LAND_HALO, o.band ?? 0);
    this.solver.setPatch(this.patch);
    this.flood0 = new Int32Array(this.side * this.side);
    const S = this.side;
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const k = y * S + x, inner = x >= LAND_HALO && y >= LAND_HALO && x < S - LAND_HALO && y < S - LAND_HALO;
      this.flood0[k] = inner ? (height[k] <= 0 ? height[k] : INF) : flooded[k];
    }
    this.solver.write("H", height);
    this.solver.go(o.band ? ["cellmeans", "bgnbr"] : ["cellmeans"]);
  }
  // A table for another step length: the creep's substeps and every cell's rock, slope and rain read again.
  setTable(table: Uint32Array) {
    this.subs = creepSubsOf(table);
    this.solver.setTable(table, this.subs);
    this.solver.go(["cellmeans"]);
  }
  load(s: LandState) {
    this.solver.write("H", s.height);
    const w = new Int32Array(5 * NP);
    if (s.carry.length > 2 * NP) throw new Error("land: a carry longer than the band hold's two words");
    w.set(s.carry, 2 * NP);
    this.solver.writeParents(w);
    this.steps = s.steps;
  }
  private async lap<T>(name: string, f: () => Promise<T> | T): Promise<T> {
    await this.gpu.device.queue.onSubmittedWorkDone();
    const t = performance.now(), v = await f();
    await this.gpu.device.queue.onSubmittedWorkDone();
    this.seconds[name] += (performance.now() - t) / 1000;
    return v;
  }
  // The flooded surface, receivers, depth sort and discharge area of the heights as they stand.
  async flow() {
    const s = this.solver;
    s.go(["cellmeans", "weights"]);
    s.writeFlood(this.flood0);
    let rounds = 0, chunk = Math.max(64, this.lastRounds);
    await this.lap("flood", async () => {
      for (;;) {
        s.clearCounter("changed");
        s.go([["flood", chunk]]);
        rounds += chunk;
        if ((await s.counter("changed")) === 0) break;
        chunk = 128;
        if (rounds > 60000) throw new Error("land: the flood did not settle in 60,000 rounds");
      }
    });
    this.lastRounds = rounds - chunk;
    s.clearCounter("flags");
    await this.lap("tree", () => s.go(["recv", ...TREE, "area"]));
    const flags = await s.counter("flags");
    if (flags & s.flags.area) throw new Error("land: a basin's discharge area passed 32 bits");
    if (flags & (s.flags.chain | s.flags.depth)) throw new Error(`land: the receivers' chains do not end at a root (flags ${flags})`);
  }
  // One erosion step: flow, the implicit stream power step, the threshold slides, creep, then each tier-0 cell's land rises by what its land lost.
  async step() {
    const s = this.solver;
    s.setStep(this.steps);
    s.go(["pzero"]);
    await this.flow();
    await this.lap("incise", () => s.go(["incise"]));
    let slide = 0, chunk = Math.max(32, this.lastSlide);
    await this.lap("slide", async () => {
      for (;;) {
        s.clearCounter("changed");
        s.go([["slide", chunk]]);
        slide += chunk;
        if ((await s.counter("changed")) === 0) break;
        chunk = 32;
        if (slide > 60000) throw new Error("land: the landslides did not settle in 60,000 rounds");
      }
    });
    this.lastSlide = slide - chunk;
    await this.lap("creep", () => s.go(Array.from({ length: this.subs }, () => ["creep", "creepapply"]).flat()));
    const er = await s.read("ER"), S = this.side;
    this.loss = 0;
    for (let y = LAND_HALO; y < S - LAND_HALO; y++) for (let x = LAND_HALO; x < S - LAND_HALO; x++) this.loss += er[y * S + x];
    if (this.solver.band) {
      s.clearCounter("flags");
      await this.lap("lift", () => s.go(["bpzero", "bpstzero", "btally", "bpmean", ...Array.from({ length: SOLVE_SWEEPS / 2 }, () => ["bpsolve", "bpsolve2"]).flat(), "blift", "bpcarry"]));
      if ((await s.counter("flags")) & BAND_FLAG_CARRY) throw new Error("land: the band-limited uplift's moments or carry passed 32 bits");
      this.steps++;
      return;
    }
    await this.lap("lift", () => s.go(["tally", "pstzero", "pstencil", "pmean", ...Array.from({ length: SOLVE_SWEEPS / 2 }, () => ["psolve", "psolve2"]).flat(), "lift", "pcarry"]));
    this.steps++;
  }
  async state(): Promise<LandState> { return { height: await this.solver.read("H"), carry: await this.solver.readCarry(), steps: this.steps }; }
  release() { this.solver.release(); }
}
