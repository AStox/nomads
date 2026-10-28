// A seed's finer global tier (src/gpu/globe/regional.ts) of the small planet built by stages into the planet's store (the bake directory (bakedir.ts BAKE, default ~/.cache/nomads-bakes), small/store): each call runs at most
// BUDGET_S seconds of steps and keeps where it got to, so run it again until it says baked. The tier is the coarse-to-fine global solve the 75 m tier will use; this
// command makes any tier from 1 to 3 (a state of tier 3 is 100 MB; tier 4's is 400 MB and is measured, not kept: docs/research/globe/2026-10-20-small-planet-impl.md).
//   bun scripts/globe-regional.ts --seed 1 --tier 2 --steps 40
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { releaseGpu, theGpu } from "../src/gpu/device";
import { REGIONAL, regionalOf, type Tier } from "../src/gpu/globe/regional";
import { readPlanet } from "../src/gpu/globe/window";
import { smallStore } from "./globe-planet";

const BUDGET_S = 270;
// The sources that make a tier: the planet's store key (its sources and radius) and the tier's own, the rock and threshold tables.
const TIER_SOURCES = ["src/gpu/globe/regional.ts", "src/gpu/wgsl/globe-regional.ts", "src/terrain/geology.ts"];
export function regionalKey(planetKey: string, o: typeof REGIONAL, root = join(import.meta.dir, "..")): string {
  const h = createHash("sha256");
  h.update(planetKey);
  h.update(JSON.stringify(o));
  for (const f of TIER_SOURCES) h.update(readFileSync(join(root, f)));
  return h.digest("hex").slice(0, 12);
}

// The tier of a seed from the small planet kept in the store, within a budget (null: not yet wholly made, run again).
export async function tierOf(seed: number, o = REGIONAL, budgetS = BUDGET_S, log: (s: string) => void = () => {}): Promise<Tier | null> {
  const store = smallStore(), planet = await readPlanet(seed, store), gpu = await theGpu();
  return regionalOf(gpu, planet, store, regionalKey(store.dir(seed), o), budgetS, o, log);
}

if (import.meta.main) {
  const arg = (name: string, d: string) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : d; };
  const seed = Number(arg("seed", "1")), o = { ...REGIONAL, tier: Number(arg("tier", String(REGIONAL.tier))), steps: Number(arg("steps", String(REGIONAL.steps))) }, t0 = performance.now();
  try {
    const t = await tierOf(seed, o, BUDGET_S, (s) => console.log(s));
    const s = ((performance.now() - t0) / 1000).toFixed(0);
    console.log(t ? `tier ${o.tier} of seed ${seed} baked: ${t.steps} steps, ${s} s this call` : `tier ${o.tier} of seed ${seed} not yet wholly built (${s} s this call): run this again`);
  } finally { await releaseGpu(); }
  process.exit(0);
}
