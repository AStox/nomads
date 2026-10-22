// The planet's finer tiers (src/gpu/globe/tiers.ts) made from a planet kept by scripts/globe-planet.ts, in calls of at most --budget seconds into /tmp/planet-75m/<seed>-<planet key>/:
// run it again until it says done.
//   bun scripts/globe-tiers.ts --seed 1 --last 4
//   bun scripts/globe-tiers.ts --seed 1 --last 2 --key 4c2a2cb36ba6      # a planet the globe's sources made before they changed
import { releaseGpu, theGpu } from "../src/gpu/device";
import { PLANET_RADIUS_M, PLANET_TIER } from "../src/gpu/globe/grid";
import { BAKE, bakeDir } from "../src/gpu/globe/bakedir";
import { TIER_LAWS, tiersOf } from "../src/gpu/globe/tiers";
import { readPlanet } from "../src/gpu/globe/window";
import { STORE } from "./globe-planet";
import { diskStore, sourceKey } from "./globe-window";

export { BAKE, bakeDir };
const arg = (name: string, d: string) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : d; };

if (import.meta.main) {
  const seed = Number(arg("seed", "1")), key = arg("key", "") || sourceKey(undefined, PLANET_RADIUS_M), last = Number(arg("last", String(PLANET_TIER))), budget = Number(arg("budget", "270"));
  const t0 = performance.now();
  try {
    const planet = await readPlanet(seed, diskStore(STORE, key));
    // --coarse-dt 26x4,13x6,...  tiers 1 to 3 under one rain and the given step lengths (a test of the island's law at the coarse tiers)
    const sched = arg("coarse-dt", ""), dts = sched ? sched.split(",").flatMap((e) => { const [dt, k] = e.split("x").map(Number); return Array.from({ length: k }, () => dt); }) : null;
    const laws = dts ? TIER_LAWS.map((l, t) => (t >= 1 && t <= 3 ? { ...l, dtMy: dts, uniformRain: true } : l)) : undefined, steps = dts ? [0, dts.length, dts.length, dts.length, TIER_LAWS[4].dtMy.length, TIER_LAWS[5].dtMy.length] : undefined;
    const p = await tiersOf(await theGpu(), planet, bakeDir(seed, key), budget, last, steps, (s) => console.log(s), Infinity, laws);
    console.log(p.done ? `tiers 1 to ${last} of seed ${seed} done` : `tier ${p.tier} at step ${p.steps}: not yet wholly built, run this again`, `(${((performance.now() - t0) / 1000).toFixed(0)} s this call)`);
  } finally { await releaseGpu(); }
  process.exit(0);
}
