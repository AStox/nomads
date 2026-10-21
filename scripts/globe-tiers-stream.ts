// The planet's finer tiers solved out of core (src/gpu/globe/tiers-stream.ts) into the same files as scripts/globe-tiers.ts writes, in calls of at most --budget seconds into
// $NOMADS_BAKE/<seed>-<planet key>/ (default /tmp/planet-75m): run it again until it says done. Memory stays at a patch's buffers and a tile cache whatever the tier.
//   bun scripts/globe-tiers-stream.ts --seed 1 --key 883a8d9387df --tier 4 --last 4 --budget 200      # one tier, resumable
//   bun scripts/globe-tiers-stream.ts --seed 1 --last 5                                              # every unfinished tier up to 5
//   --block 2 --order reverse|<seed>     another tiling and another order of the visits (the bytes do not change)
//   --steps 1,1,1,1,1 --max-steps 3      fewer steps than the chain's (a test) / at most this many in this call
//   --mem                                the same tiers by the in-memory solve (tiers.ts), the oracle, for the same --steps
//   --check <dir>                        compare the tier's files here with the ones in another directory by hash
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { releaseGpu, theGpu } from "../src/gpu/device";
import { PLANET_RADIUS_M, PLANET_TIER } from "../src/gpu/globe/grid";
import { BAKE, bakeDir } from "../src/gpu/globe/bakedir";
import { TIER_STEPS, tiersOf } from "../src/gpu/globe/tiers";
import { streamTier } from "../src/gpu/globe/tiers-stream";
import { readPlanet } from "../src/gpu/globe/window";
import { STORE } from "./globe-planet";
import { diskStore, sourceKey } from "./globe-window";

const arg = (name: string, d: string) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : d; };
const flag = (name: string) => process.argv.includes(`--${name}`);
const hashOf = (path: string) => {
  const h = createHash("sha256"), b = readFileSync(path);
  h.update(b);
  return h.digest("hex").slice(0, 16);
};

if (import.meta.main) {
  const seed = Number(arg("seed", "1")), key = arg("key", "") || sourceKey(undefined, PLANET_RADIUS_M), last = Number(arg("last", String(PLANET_TIER))), budget = Number(arg("budget", "200"));
  const only = arg("tier", ""), first = only ? Number(only) : 1, end = only ? Number(only) : last, steps = arg("steps", "") ? [0, ...arg("steps", "").split(",").map(Number)] : TIER_STEPS;
  const block = Number(arg("block", "4")), orderArg = arg("order", "forward"), order = orderArg === "forward" || orderArg === "reverse" ? orderArg : Number(orderArg), maxSteps = arg("max-steps", "") ? Number(arg("max-steps", "")) : Infinity;
  const dir = bakeDir(seed, key), t0 = performance.now(), spent = () => (performance.now() - t0) / 1000;
  const peak = () => `rss ${(process.memoryUsage().rss / 2 ** 30).toFixed(2)} GB, peak ${(process.resourceUsage().maxRSS / 2 ** (process.platform === "darwin" ? 30 : 20)).toFixed(2)} GB`;
  if (flag("check")) {
    const other = arg("check", ""), files: string[] = [];
    for (let t = first; t <= end; t++) for (const f of [`t${t}-height.i32`, ...(t === last ? [`t${t}-to.u32`, `t${t}-acc.u32`, `t${t}-flooded.i32`] : [])]) files.push(f);
    for (const f of files) {
      const a = join(dir.dir, f), b = join(other, f);
      if (!existsSync(a) || !existsSync(b)) { console.log(`${f}: ${existsSync(a) ? "" : `missing here `}${existsSync(b) ? "" : "missing there"}`); continue; }
      const ha = hashOf(a), hb = hashOf(b);
      console.log(`${f}: ${ha === hb ? "equal" : "DIFFERENT"} ${ha} ${hb}`);
    }
    process.exit(0);
  }
  try {
    const planet = await readPlanet(seed, diskStore(STORE, key)), gpu = await theGpu();
    if (flag("mem")) {
      const p = await tiersOf(gpu, planet, dir, budget, end, steps, (s) => console.log(s), maxSteps);
      console.log(p.done ? `tiers ${first} to ${end} of seed ${seed} done (in memory)` : `tier ${p.tier} at step ${p.steps}: not yet wholly built, run this again`, `(${spent().toFixed(0)} s this call, ${peak()})`);
    } else {
      let done = true;
      for (let t = first; t <= end && done; t++) {
        const r = await streamTier(gpu, planet, dir, t, last, budget - spent(), { block, order, steps, maxSteps }, (s) => console.log(s));
        done = r.done;
        if (!r.done) console.log(`tier ${t} at step ${r.steps} of ${r.of}: not yet wholly built, run this again`);
        if (r.done && spent() + 30 > budget) { done = t === end; break; }
      }
      console.log(done ? `tiers ${first} to ${end} of seed ${seed} done (streamed, blocks of ${block})` : "not done", `(${spent().toFixed(0)} s this call, ${peak()})`);
    }
  } finally { await releaseGpu(); }
  process.exit(0);
}
