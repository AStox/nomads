// The planet's water over the 75 m tier (src/gpu/globe/water.ts, discharge.ts), in calls of at most --budget seconds into /tmp/planet-75m/<seed>-<planet key>/: run each stage again until it
// says done, in this order: surplus (each season's surplus over every cell, the weights), discharge (the exact global sums down the whole forest), water (the hydrology on every tile's patch).
// `--only a,b,c` limits surplus and water to those tiles (tile = face * 256 + ty * 16 + tx); the discharge is always the whole planet's.
//   lockf /tmp/nomads-gpu.lock bun scripts/globe-water.ts --stage surplus --seed 1 --key c418e5fe9b5e
import { releaseGpu, theGpu } from "../src/gpu/device";
import { dischargeOf } from "../src/gpu/globe/discharge";
import { SMALL_RADIUS_M } from "../src/gpu/globe/grid";
import { forget, runTiles } from "../src/gpu/globe/stages";
import { climateFiles, dischargeFields, lastRun, planetRain, surplusFiles, surplusStage, unmap, waterStage } from "../src/gpu/globe/water";
import { readPlanet } from "../src/gpu/globe/window";
import { STORE } from "./globe-planet";
import { bakeDir } from "./globe-tiers";
import { diskStore, sourceKey } from "./globe-window";

const arg = (name: string, d: string) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : d; };

if (import.meta.main) {
  const seed = Number(arg("seed", "1")), key = arg("key", "") || sourceKey(undefined, SMALL_RADIUS_M), name = arg("stage", ""), budget = Number(arg("budget", "270")), tier = 4;
  const only = arg("only", "") ? arg("only", "").split(",").map(Number) : undefined, halo = arg("halo", "") ? Number(arg("halo", "")) : undefined;
  const t0 = performance.now();
  try {
    const planet = await readPlanet(seed, diskStore(STORE, key)), dir = bakeDir(seed, key), gpu = await theGpu(), ctx = { gpu, planet, dir, tier };
    // the air stage's files (u16, 0.1 mm over the season) when they exist and `--climate standin` is not asked for, else the planet's own rain
    const climate = dir.has("t4-pr0.u16") && arg("climate", "air") !== "standin" ? climateFiles([0, 1, 2, 3].map((s) => `t4-pr${s}.u16`), [0, 1, 2, 3].map((s) => `t4-pe${s}.u16`), 10) : planetRain(planet), log = (s: string) => console.log(s);
    if (name === "discharge") {
      const p = await dischargeOf(gpu, dir, tier, dischargeFields(tier), budget, log);
      console.log(`discharge: ${p.done ? "done" : "run this again"}, ${p.made.length} fields this call, ${p.seconds.toFixed(0)} s`);
      if (p.done) for (const f of surplusFiles(tier)) if (arg("keep", "") !== "1") dir.remove(f);
    } else if (name === "surplus" || name === "water") {
      const stage = name === "surplus" ? surplusStage(climate, tier) : waterStage({ climate, tier, halo });
      const p = await runTiles(ctx, stage, budget, log, only);
      const mean = p.tileS.length ? p.tileS.reduce((a, b) => a + b, 0) / p.tileS.length : 0;
      console.log(`${name}: ${p.tiles} of ${p.of} tiles made${p.done ? ", done" : ": run this again"}; this call ${p.tileS.length} tiles, mean ${mean.toFixed(2)} s, ${((performance.now() - t0) / 1000).toFixed(0)} s`);
      if (name === "water") console.log(`last tile: sweeps ${lastRun.sweeps.join(" and ")}, inflows ${lastRun.inflows}, inputs ${lastRun.seconds.inputs.toFixed(2)} s, gpu ${lastRun.seconds.gpu.toFixed(2)} s`);
    } else throw new Error(`stage "${name}": surplus, discharge or water`);
    forget(); unmap();
  } finally { await releaseGpu(); }
  process.exit(0);
}
