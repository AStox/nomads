// The planet's finer tiers (src/gpu/globe/tiers.ts) made from a planet kept by scripts/globe-planet.ts, in calls of at most --budget seconds into /tmp/planet-75m/<seed>-<planet key>/:
// run it again until it says done.
//   bun scripts/globe-tiers.ts --seed 1 --last 4
//   bun scripts/globe-tiers.ts --seed 1 --last 2 --key 4c2a2cb36ba6      # a planet the globe's sources made before they changed
import { releaseGpu, theGpu } from "../src/gpu/device";
import { SMALL_RADIUS_M } from "../src/gpu/globe/grid";
import { BAKE, bakeDir } from "../src/gpu/globe/bakedir";
import { tiersOf } from "../src/gpu/globe/tiers";
import { readPlanet } from "../src/gpu/globe/window";
import { STORE } from "./globe-planet";
import { diskStore, sourceKey } from "./globe-window";

export { BAKE, bakeDir };
const arg = (name: string, d: string) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : d; };

if (import.meta.main) {
  const seed = Number(arg("seed", "1")), key = arg("key", "") || sourceKey(undefined, SMALL_RADIUS_M), last = Number(arg("last", "4")), budget = Number(arg("budget", "270"));
  const t0 = performance.now();
  try {
    const planet = await readPlanet(seed, diskStore(STORE, key));
    const p = await tiersOf(await theGpu(), planet, bakeDir(seed, key), budget, last, undefined, (s) => console.log(s));
    console.log(p.done ? `tiers 1 to ${last} of seed ${seed} done` : `tier ${p.tier} at step ${p.steps}: not yet wholly built, run this again`, `(${((performance.now() - t0) / 1000).toFixed(0)} s this call)`);
  } finally { await releaseGpu(); }
  process.exit(0);
}
