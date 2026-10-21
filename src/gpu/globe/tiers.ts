// The planet's finer tiers made one from the one above, each solved over the whole planet (src/gpu/globe/regional.ts): tier 1 from the planet's tier 0, tier 2 from
// tier 1's result, and so on to the 75 m tier (tier 4 on the small planet). A tier starts from its parent's heights carried by the remap (the children of every cell sum to
// the parent's height to the unit: remapInts) and is eroded for TIER_STEPS of them under the planet's rain and rock, the total height of every tier-0 cell held. The
// bytes of a tier do not depend on where the calls that make it were split (a state is the heights and the carries). What is kept goes in a BakeDir (raw typed arrays
// in files: a tier-4 field is 403 MB and is never copied more than the one read).
import type { Gpu } from "../device";
import { BakeDir } from "./bakedir";
import { defaultParams } from "./erosion";
import { Regional, refineSmooth, tierTable } from "./regional";
import type { Planet } from "./window";

type I32 = Int32Array | Uint32Array;
export { BakeDir };
// The steps a tier is eroded for, of 1 My each [design: R1763's 40 at the tiers whose steps cost 0.1 to 4 s; the 75 m tier starts from tier 3's settled network and a step costs 17 s].
// Not run to the landscape's response time: at the scale of a tier-0 cell it is 1,600 to 3,600 My at tiers 2 and 3 (the sum of d / (K sqrt(A)) along a valley to where it leaves its
// tier-0 cell, granite K 7e-8), where the shield flattens to a peneplain at its tier-0 mean and the flutes on a range's flanks are smoothed away [measured, 2026-10-21].
export const TIER_STEPS = [0, 40, 40, 40, 12];
// What a call keeps back from its budget for the end of a tier (the settled flow and the readbacks) and for saving a state, s.
const FINISH_S = 60, SAVE_S = 15;

// What a tier cost: the steps made, the seconds of each call that worked on it (the inputs, the steps, the end and the saves), and each step's seconds, flood rounds and landslide rounds.
export interface TierRun { tier: number; steps: number; calls: number; callS: number[]; rounds: number[]; slides: number[]; stepS: number[] }
export interface TiersProgress { done: boolean; tier: number; steps: number; log: TierRun[] }

// What the chain keeps: `t<k>-state` (heights and carries of an unfinished tier, with the steps made), `t<k>-height` (a finished tier's heights, 1/256 m), and for the last
// tier `t<k>-to`, `t<k>-acc` and `t<k>-flooded` (the receivers, the discharge area and the flooded surface of its settled flow) and `t<k>-run` (what it cost).
export async function tiersOf(gpu: Gpu, planet: Planet, dir: BakeDir, budgetS = Infinity, last = 4, steps = TIER_STEPS, log: (s: string) => void = () => {}, maxSteps = Infinity): Promise<TiersProgress> {
  const t0 = performance.now(), spent = () => (performance.now() - t0) / 1000, runs: TierRun[] = [];
  const params = defaultParams({ dtYr: 1e6 });
  for (let t = 1; t <= last; t++) {
    if (dir.has(`t${t}-height.i32`) && (t < last || dir.has(`t${t}-run.json`))) continue;
    const n = planet.n << (2 * t), resuming = dir.has(`t${t}-state.json`);
    const start = resuming ? new Int32Array(n) : t === 1 ? refineSmooth(Float32Array.from(planet.height, (v) => v * 256), 0) : refineSmooth(dir.i32(`t${t - 1}-height`), t - 1);
    const r = new Regional(gpu, t, tierTable(planet, t, params), start);
    const run: TierRun = dir.json<TierRun>(`t${t}-partial`) ?? { tier: t, steps: 0, calls: 0, callS: [], rounds: [], slides: [], stepS: [] };
    const c0 = spent();
    try {
      let made = 0;
      const kept = resuming ? dir.json<{ steps: number }>(`t${t}-state`) : null;
      if (kept) { r.load({ height: dir.i32(`t${t}-state`), carry: dir.i32(`t${t}-carry`), steps: kept.steps }); made = kept.steps; }
      log(`tier ${t}: ${n} cells, inputs ${(spent() - c0).toFixed(1)} s, ${made} of ${steps[t]} steps kept`);
      let last1 = 0, madeNow = 0;
      while (made < steps[t] && madeNow < maxSteps) {
        if (spent() + last1 * 1.3 + (t === last ? FINISH_S : 5) + SAVE_S > budgetS) break;
        const s0 = performance.now();
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
