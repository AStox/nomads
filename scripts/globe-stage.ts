// A fine stage of the 75 m tier over the whole planet (src/gpu/globe/stages.ts), in calls of at most --budget seconds into /tmp/planet-75m/<seed>-<planet key>/: run it again until it
// says done. `--only a,b,c` makes just those tiles (a tile's number is face * T * T + ty * T + tx, T = 2^tier tiles along a face: 32 at tier 5, 16 at tier 4); `--faces 4` makes the tiles of one face.
//   --block 2 makes 2 by 2 tiles at a patch (the halo's cost shared; the bytes do not change)
//   bun scripts/globe-stage.ts --stage terrain --seed 1 --key <planet key> [--tier 5]     # --tier 4 for the 195.6 km planet's bake
import { releaseGpu, theGpu } from "../src/gpu/device";
import { PLANET_RADIUS_M, PLANET_TIER } from "../src/gpu/globe/grid";
import { tileCount } from "../src/gpu/globe/patch";
import { runTiles, forget, type TileStage } from "../src/gpu/globe/stages";
import { airStage } from "../src/gpu/globe/air";
import { groundStage } from "../src/gpu/globe/ground";
import { terrainStage } from "../src/gpu/globe/terrain";
import { readPlanet } from "../src/gpu/globe/window";
import { STORE } from "./globe-planet";
import { bakeDir } from "./globe-tiers";
import { diskStore, sourceKey } from "./globe-window";

export const STAGES: Record<string, (tier: number, block: number) => TileStage> = { terrain: terrainStage, air: airStage, ground: groundStage };
const arg = (name: string, d: string) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : d; };

if (import.meta.main) {
  const seed = Number(arg("seed", "1")), key = arg("key", "") || sourceKey(undefined, PLANET_RADIUS_M), name = arg("stage", ""), budget = Number(arg("budget", "270")), tier = Number(arg("tier", String(PLANET_TIER))), block = Number(arg("block", "1"));
  if (!STAGES[name]) throw new Error(`stage "${name}": one of ${Object.keys(STAGES).join(", ")}`);
  const perFace = tileCount(tier) / 6, only = arg("only", "") ? arg("only", "").split(",").map(Number) : arg("faces", "") ? arg("faces", "").split(",").flatMap((f) => Array.from({ length: perFace }, (_, k) => Number(f) * perFace + k)) : undefined;
  const t0 = performance.now();
  try {
    const planet = await readPlanet(seed, diskStore(STORE, key)), stage = STAGES[name](tier, block), dir = bakeDir(seed, key);
    const p = await runTiles({ gpu: await theGpu(), planet, dir, tier }, stage, budget, (s) => console.log(s), only);
    const mean = p.tileS.length ? p.tileS.reduce((a, b) => a + b, 0) / p.tileS.length : 0;
    console.log(`${name}: ${p.tiles} of ${p.of} tiles made${p.done ? ", done" : ": run this again"}; this call ${p.tileS.length} tiles, mean ${mean.toFixed(2)} s, ${((performance.now() - t0) / 1000).toFixed(0)} s`);
    forget();
  } finally { await releaseGpu(); }
  process.exit(0);
}
