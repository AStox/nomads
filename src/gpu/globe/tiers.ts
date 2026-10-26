// The planet's finer tiers made one from the one above, each solved over the whole planet (src/gpu/globe/regional.ts): tier 1 from the planet's tier 0, tier 2 from
// tier 1's result, and so on to the 75 m tier (tier 4 on the small planet). A tier starts from its parent's heights carried by the remap (the children of every cell sum to
// the parent's height to the unit: remapInts) and is eroded for TIER_STEPS of them under the planet's rock (tiers 1 to 3 under its rain too, tiers 4 and 5 under one rain, as the island's law
// has it), the total height of every tier-0 cell held. The
// bytes of a tier do not depend on where the calls that make it were split (a state is the heights and the carries). What is kept goes in a BakeDir (raw typed arrays
// in files: a tier-4 field is 403 MB and is never copied more than the one read).
import type { Gpu } from "../device";
import { BakeDir } from "./bakedir";
import { defaultParams } from "./erosion";
import { Regional, child4, refineSmooth, tierTable, type RouteLaw } from "./regional";
import type { Planet } from "./window";

type I32 = Int32Array | Uint32Array;
export { BakeDir };
// The law of each tier (tier 0 is the planet's own, not solved here): how its flow is routed, the length in My of each of its steps, and whether it rains the planet's rain or one rain.
export interface TierLaw { route: RouteLaw; dtMy: readonly number[]; uniformRain: boolean }
// Tiers 1 to 5 are the island's law: one rain, eight neighbours with the receiver drawn among the lower ones (wgsl/globe-regional.ts recv), the exact smooth uplift, and step lengths that fall from
// 26 to 1.6 My: the early long steps carry the landscape toward its form and the short ones settle it, since the form the coupled laws reach depends on the step (at 130 My the surface is a
// peneplain, at 13 My the valleys are 15% less incised than at 3 and 6.5 My, whose statistics agree within 5%) and the uplift of a step is the whole of what the step took off. Tiers 1 to 3
// used to be 40 steps of 1 My under the planet's rain and the steepest of four neighbours: the planet's rain is under 26 mm a year over half of a range, which starves the incision (the response
// time of a range region is 15,140 My with it and 399 My under one rain), and four-neighbour routing left a lattice of rows and columns of valleys in the surface the fine tiers start from; under
// the island's law the worst tier-0 cell of a 12 by 12 tile range region is 0.95 m off the planet's mean (260 m before) [measured, 2026-10-22: docs/research/globe/2026-10-22-planet-island-law.md].
// Tier 4 (150 m) does the work of a tier of 75 m cells at a quarter of the cost; tier 5 carries it and settles at the step lengths that end tier 4's.
const SCHEDULE = [...Array(4).fill(26), ...Array(6).fill(13), ...Array(10).fill(6.5), ...Array(4).fill(3.25), ...Array(4).fill(1.6)] as number[];
// SCRATCH knob (prototype, not for a bake): NOMADS_RHO8=1 routes tiers 1 to 5 by Rho8 (wgsl/globe-regional.ts recv)
// SCRATCH knob (prototype): NOMADS_SMOOTH=1:1,2:1 smooths the incision's area over a (2r + 1) square at those tiers (tier:r; wgsl/globe-regional.ts acc_s)
const SMOOTH = new Map((process.env.NOMADS_SMOOTH ?? "").split(",").filter(Boolean).map((e) => e.split(":").map(Number) as [number, number]));
const ISLAND: TierLaw = { route: { nflow: 8, stochastic: true, slide: 16, rho8: process.env.NOMADS_RHO8 === "1" }, dtMy: SCHEDULE, uniformRain: true };
// SCRATCH knobs (prototype): NOMADS_HOLD_OFF_TIERS=1 starts those tiers from their parent's carry and does not hold them to the parent's cell means (the uplift of regional.ts step() is skipped: the
// tier below still holds that tier's own means); with NOMADS_BAND_SPAN=1 or 2 the uplift of those tiers is the band-limited hold of that span instead (wgsl/globe-band-hold.ts). Whole-planet chain only.
const HOLD_OFF = (process.env.NOMADS_HOLD_OFF_TIERS ?? "").split(",").filter(Boolean).map(Number);
const BAND_SPAN = process.env.NOMADS_BAND_SPAN === "1" ? 1 : process.env.NOMADS_BAND_SPAN === "2" ? 2 : 0;
const holdOf = (t: number, route: RouteLaw): RouteLaw => (!HOLD_OFF.includes(t) ? route : BAND_SPAN ? { ...route, band: BAND_SPAN } : { ...route, holdOff: true });
const lawOf = (t: number, l: TierLaw): TierLaw => ({ ...l, route: holdOf(t, SMOOTH.has(t) ? { ...l.route, smooth: SMOOTH.get(t) } : l.route) });
export const TIER_LAWS: readonly TierLaw[] = [ISLAND, ISLAND, ISLAND, ISLAND, ISLAND, { ...ISLAND, dtMy: [6.5, 6.5, 3.25, 3.25, 1.6, 1.6] }].map((l, t) => lawOf(t, l));
export const TIER_STEPS = TIER_LAWS.map((l, t) => (t === 0 ? 0 : l.dtMy.length));
// A tier's table (the K dt and the creep coefficients) of step number `step`, made once for each step length.
export function tierTableOf(planet: Planet, tier: number): (step: number) => Uint32Array {
  const law = TIER_LAWS[tier], made = new Map<number, Uint32Array>();
  return (step) => {
    const dt = law.dtMy[Math.min(step, law.dtMy.length - 1)];
    let t = made.get(dt);
    if (!t) { t = tierTable(planet, tier, defaultParams({ dtYr: dt * 1e6 }), law.uniformRain); made.set(dt, t); }
    return t;
  };
}
// What a tier starts from: the field refineSmooth carries down to it (tier 1: the planet's heights in 1/256 m, the finer tiers: the tier above's heights, the files the chain keeps), and the
// table of every step. The in-memory chain here and the streamed one (tiers-stream.ts) both take them from these.
export const tierParent = (planet: Planet, dir: BakeDir, tier: number): ArrayLike<number> => (tier === 1 ? Float32Array.from(planet.height, (v) => v * 256) : dir.i32(`t${tier - 1}-height`));
// What a call keeps back from its budget for the end of a tier (the settled flow and the readbacks) and for saving a state, s.
const FINISH_S = 60, SAVE_S = 15;

// What a tier cost: the steps made, the seconds of each call that worked on it (the inputs, the steps, the end and the saves), and each step's seconds, flood rounds and landslide rounds.
export interface TierRun { tier: number; steps: number; calls: number; callS: number[]; rounds: number[]; slides: number[]; stepS: number[] }
export interface TiersProgress { done: boolean; tier: number; steps: number; log: TierRun[] }

// What the chain keeps: `t<k>-state` (heights and carries of an unfinished tier, with the steps made), `t<k>-height` (a finished tier's heights, 1/256 m), and for the last
// tier `t<k>-to`, `t<k>-acc` and `t<k>-flooded` (the receivers, the discharge area and the flooded surface of its settled flow) and `t<k>-run` (what it cost).
export async function tiersOf(gpu: Gpu, planet: Planet, dir: BakeDir, budgetS = Infinity, last = 4, steps = TIER_STEPS, log: (s: string) => void = () => {}, maxSteps = Infinity, laws: readonly TierLaw[] = TIER_LAWS): Promise<TiersProgress> {
  const t0 = performance.now(), spent = () => (performance.now() - t0) / 1000, runs: TierRun[] = [];
  for (let t = 1; t <= last; t++) {
    if (dir.has(`t${t}-height.i32`) && (t < last || dir.has(`t${t}-run.json`))) continue;
    const n = planet.n << (2 * t), resuming = dir.has(`t${t}-state.json`);
    const start = resuming ? new Int32Array(n) : refineSmooth(tierParent(planet, dir, t), t - 1, 4, NUC_TIERS.includes(t) ? topOctaveSigmaM(tierParent(planet, dir, t), t - 1) / Math.SQRT2 : 0);
    const tableAt = tierTableOf(planet, t), first = tableAt(0), r = new Regional(gpu, t, first, start, laws[t].route);
    let table = first;
    const run: TierRun = dir.json<TierRun>(`t${t}-partial`) ?? { tier: t, steps: 0, calls: 0, callS: [], rounds: [], slides: [], stepS: [] };
    const c0 = spent();
    try {
      let made = 0;
      const kept = resuming ? dir.json<{ steps: number }>(`t${t}-state`) : null;
      if (kept) { r.load({ height: dir.i32(`t${t}-state`), carry: dir.i32(`t${t}-carry`), steps: kept.steps }); made = kept.steps; r.stepNo = made; }
      log(`tier ${t}: ${n} cells, inputs ${(spent() - c0).toFixed(1)} s, ${made} of ${steps[t]} steps kept`);
      let last1 = 0, madeNow = 0;
      while (made < steps[t] && madeNow < maxSteps) {
        if (spent() + last1 * 1.3 + (t === last ? FINISH_S : 5) + SAVE_S > budgetS) break;
        const s0 = performance.now(), next = tableAt(made);
        if (next !== table) { r.setTable(next); table = next; }
        await r.step();
        made++; madeNow++;
        last1 = (performance.now() - s0) / 1000;
        run.stepS.push(last1); run.rounds.push(r.lastRounds); run.slides.push(r.lastSlide);
        log(`tier ${t} step ${made} ${last1.toFixed(1)} s, flood ${r.lastRounds} rounds, slides ${r.lastSlide}`);
      }
      run.steps = made;
      if (made < steps[t]) {
        const s = await r.state(made);
        dir.write(`t${t}-state.i32`, s.height); dir.write(`t${t}-carry.i32`, s.carry);
        dir.putJson(`t${t}-state`, { steps: made });
        run.calls++; run.callS.push(spent() - c0);
        dir.putJson(`t${t}-partial`, run);
        return { done: false, tier: t, steps: made, log: [...runs, run] };
      }
      if (t === last) {
        r.setRoute(false);
        await r.flow();
        const flow = await r.readFlow();
        dir.write(`t${t}-to.u32`, flow.to); dir.write(`t${t}-acc.u32`, flow.acc); dir.write(`t${t}-flooded.i32`, await r.readFlooded());
      }
      dir.write(`t${t}-height.i32`, await r.readH());
      run.calls++; run.callS.push(spent() - c0);
      dir.putJson(`t${t}-run`, run);
      for (const f of [`t${t}-state.i32`, `t${t}-carry.i32`, `t${t}-state.json`, `t${t}-partial.json`]) dir.remove(f);
      runs.push(run);
      log(`tier ${t} finished at ${spent().toFixed(1)} s`);
    } finally { r.release(); }
    if (spent() + 30 > budgetS) return { done: t === last, tier: t, steps: steps[t], log: runs };
  }
  return { done: true, tier: last, steps: steps[last], log: runs };
}

export type { I32 };

// SCRATCH knob (prototype): NOMADS_NUC_TIERS=3,4,5 nucleates the start of those tiers (nucleation.ts) with the detail the carry misses: the last resolved octave's measured detail over sqrt 2.
const NUC_TIERS = (process.env.NOMADS_NUC_TIERS ?? "").split(",").filter(Boolean).map(Number);
// The detail of a whole tier's heights (1/256 m, `fn` cells a side per face) that the smooth carry of the heights' own 2 by 2 means cannot predict, rms metres over land (all four
// children over 1 m), away from the faces' edges (8 parents): the measure of tools/octaves.ts, the last resolved octave of the field.
export function topOctaveSigmaM(field: ArrayLike<number>, from: number): number {
  const fn = 256 << from, n = fn / 2, m = fn, quad = new Float64Array(4), cells = fn * fn;
  const kids = (src: Float64Array, out: Float64Array) => {
    for (let y = 1; y < n - 1; y++) for (let x = 1; x < n - 1; x++) {
      const p = y * n + x;
      child4(src[p], src[p - 1], src[p + 1], src[p - n], src[p + n], src[p - n - 1], src[p - n + 1], src[p + n - 1], src[p + n + 1], quad);
      const o = 2 * y * m + 2 * x;
      out[o] = quad[0]; out[o + 1] = quad[1]; out[o + m] = quad[2]; out[o + m + 1] = quad[3];
    }
  };
  let s2 = 0, cnt = 0;
  const M = new Float64Array(n * n), c = new Float64Array(m * m), corr = new Float64Array(m * m), r = new Float64Array(n * n);
  for (let f = 0; f < 6; f++) {
    const F = (y: number, x: number) => field[f * cells + y * fn + x];
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) M[y * n + x] = (F(2 * y, 2 * x) + F(2 * y, 2 * x + 1) + F(2 * y + 1, 2 * x) + F(2 * y + 1, 2 * x + 1)) / 4;
    c.fill(0); kids(M, c);
    for (let pass = 0; pass < 4; pass++) {
      for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) { const o = 2 * y * m + 2 * x; r[y * n + x] = M[y * n + x] - (c[o] + c[o + 1] + c[o + m] + c[o + m + 1]) / 4; }
      corr.fill(0); kids(r, corr);
      for (let i = 0; i < c.length; i++) c[i] += corr[i];
    }
    for (let y = 8; y < n - 8; y++) for (let x = 8; x < n - 8; x++) {
      const o = 2 * y * m + 2 * x, ids = [o, o + 1, o + m, o + m + 1], v = ids.map((i) => F(Math.floor(i / m), i % m));
      if (v.some((q) => q <= 256)) continue;
      const rr = v.map((q, j) => q - c[ids[j]]), mean = (rr[0] + rr[1] + rr[2] + rr[3]) / 4;
      for (const t of rr) s2 += (t - mean) ** 2;
      cnt += 4;
    }
  }
  return Math.sqrt(s2 / cnt) / 256;
}

// Every river of a tier reaches the sea across tile and face edges: each land cell drains to a neighbour whose flooded surface is strictly lower (so no chain can loop, and a
// chain ends only where a cell drains to itself, which only a sea cell may do) and each sea cell drains to itself. `bad` counts the cells that break either rule.
export function drainage(tier: number, height: Int32Array, to: Uint32Array, flooded: Int32Array) {
  const fn = 256 << tier, cells = fn * fn;
  let land = 0, sea = 0, bad = 0, acrossFaces = 0, acrossTiles = 0;
  for (let k = 0; k < height.length; k++) {
    const j = to[k];
    if (height[k] <= 0) { sea++; if (j !== k) bad++; continue; }
    land++;
    if (j === k || flooded[j] >= flooded[k]) { bad++; continue; }
    const f = Math.floor(k / cells), fj = Math.floor(j / cells);
    if (f !== fj) acrossFaces++;
    else {
      const r = k - f * cells, rj = j - fj * cells;
      if (((r % fn) >> 8) !== ((rj % fn) >> 8) || (Math.floor(r / fn) >> 8) !== (Math.floor(rj / fn) >> 8)) acrossTiles++;
    }
  }
  return { land, sea, bad, acrossFaces, acrossTiles };
}
