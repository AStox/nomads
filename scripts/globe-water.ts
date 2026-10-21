// The planet's water over the 75 m tier (src/gpu/globe/water.ts, discharge.ts), in calls of at most --budget seconds into /tmp/planet-75m/<seed>-<planet key>/: run each stage again until it
// says done, in this order: surplus (each season's surplus over every cell, the weights), discharge (the exact global sums down the whole forest), water (the hydrology on every tile's patch).
// `--only a,b,c` limits surplus and water to those tiles (tile = face * T * T + ty * T + tx, T = 2^tier tiles along a face; `--tier` defaults to the planet's finest, grid.ts PLANET_TIER); the discharge is always the whole planet's.
//   lockf /tmp/nomads-gpu.lock bun scripts/globe-water.ts --stage surplus --seed 1 --key c418e5fe9b5e
import { releaseGpu, theGpu } from "../src/gpu/device";
import { basinStream } from "../src/gpu/globe/basin-stream";
import { dischargeOf } from "../src/gpu/globe/discharge";
import { dischargeStream } from "../src/gpu/globe/discharge-stream";
import { defaultParams } from "../src/gpu/globe/erosion";
import { PLANET_RADIUS_M, PLANET_TIER } from "../src/gpu/globe/grid";
import { Regional, tierTable } from "../src/gpu/globe/regional";
import { forget, runTiles } from "../src/gpu/globe/stages";
import { AIR_UNIT, precipOfWord } from "../src/gpu/globe/air";
import { globalWater } from "../src/gpu/globe/water-global";
import { WATER_SEEDED, basinOf, climateFiles, dischargeFields, lastRun, planetRain, surplusFiles, surplusStage, unmap, waterStage } from "../src/gpu/globe/water";
import { readPlanet } from "../src/gpu/globe/window";
import { STORE } from "./globe-planet";
import { bakeDir } from "./globe-tiers";
import { diskStore, sourceKey } from "./globe-window";

// The tiers from which the discharge and the lakes are made out of core (a tier's whole-tier buffers do not fit): tier 5 [design].
const STREAM_TIER = 5;

const arg = (name: string, d: string) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : d; };

if (import.meta.main) {
  const seed = Number(arg("seed", "1")), key = arg("key", "") || sourceKey(undefined, PLANET_RADIUS_M), name = arg("stage", ""), budget = Number(arg("budget", "270")), tier = Number(arg("tier", String(PLANET_TIER)));
  const only = arg("only", "") ? arg("only", "").split(",").map(Number) : undefined, halo = arg("halo", "") ? Number(arg("halo", "")) : undefined, coarse = Number(arg("coarse", String(WATER_SEEDED.coarse)));
  const t0 = performance.now();
  try {
    const planet = await readPlanet(seed, diskStore(STORE, key)), dir = bakeDir(seed, key), gpu = await theGpu(), ctx = { gpu, planet, dir, tier };
    // the air stage's files (u16, 0.1 mm over the season) when they exist and `--climate standin` is not asked for, else the planet's own rain
    const climate = dir.has(`t${tier}-pr0.u16`) && arg("climate", "air") !== "standin" ? climateFiles([0, 1, 2, 3].map((s) => `t${tier}-pr${s}.u16`), [0, 1, 2, 3].map((s) => `t${tier}-pe${s}.u16`), precipOfWord, (w) => w / AIR_UNIT.pe) : planetRain(planet), log = (s: string) => console.log(s);
    if (name === "discharge") {
      if (tier >= STREAM_TIER) {
        const p = await dischargeStream(dir, tier, dischargeFields(tier), budget, log, { block: 4 });
        console.log(`discharge (streamed): ${p.done ? "done" : `${p.stage}, ${p.blocksDone} of ${p.blocks} blocks: run this again`}`);
      } else {
        const p = await dischargeOf(gpu, dir, tier, dischargeFields(tier), budget, log);
        console.log(`discharge: ${p.done ? "done" : "run this again"}, ${p.made.length} fields this call, ${p.seconds.toFixed(0)} s`);
      }
      if (arg("keep", "1") !== "1") for (const f of surplusFiles(tier)) dir.remove(f);
    } else if (name === "flow") {
      // the receivers and the flooded surface of a coarse tier from its heights (the regional flood), for the coarse global solve
      if (!dir.has(`t${tier}-to.u32`)) {
        const F = 256 * 2 ** tier, r = new Regional(gpu, tier, tierTable(planet, tier, defaultParams({ dtYr: 1e6 })), new Int32Array(dir.raw(`t${tier}-height.i32`)), new Int32Array(6 * F * F).fill(256));
        try { await r.flow(); dir.write(`t${tier}-to.u32`, new Uint32Array((await r.readField("TO")).buffer)); dir.write(`t${tier}-flooded.i32`, await r.readFlooded()); } finally { r.release(); }
      }
      console.log("flow: done");
    } else if (name === "coarse") {
      const p = await globalWater(ctx, { climate, tier, finest: PLANET_TIER }, budget, log, "head2");
      console.log(`coarse water: ${p.done ? "done" : `stopped at ${p.at}: run this again`}, ${p.seconds.toFixed(0)} s`);
    } else if (name === "global") {
      const p = await globalWater(ctx, { climate, tier, finest: PLANET_TIER }, budget, log);
      console.log(`global water: ${p.done ? "done" : `stopped at ${p.at}: run this again`}, ${p.seconds.toFixed(0)} s`);
    } else if (name === "basin") {
      if (tier >= STREAM_TIER) {
        const p = await basinStream(dir, tier, budget, log, { block: 4 });
        console.log(`lakes (streamed): ${p.done ? `done, ${p.lakes} lakes, ${p.dry} dry hollows` : `${p.stage}, ${p.blocksDone} of ${p.blocks} blocks: run this again`}`);
      } else console.log(`lakes decided over the tier (needs surplus and discharge): ${JSON.stringify(basinOf(ctx))}`);
    } else if (name === "surplus" || name === "water") {
      const stage = name === "surplus" ? surplusStage(climate, tier, PLANET_TIER) : waterStage({ climate, tier, halo: halo ?? WATER_SEEDED.halo, finest: PLANET_TIER, seed: { coarse, sweeps: WATER_SEEDED.sweeps } });
      const p = await runTiles(ctx, stage, budget, log, only);
      const mean = p.tileS.length ? p.tileS.reduce((a, b) => a + b, 0) / p.tileS.length : 0;
      console.log(`${name}: ${p.tiles} of ${p.of} tiles made${p.done ? ", done" : ": run this again"}; this call ${p.tileS.length} tiles, mean ${mean.toFixed(2)} s, ${((performance.now() - t0) / 1000).toFixed(0)} s`);
      if (name === "water") console.log(`last tile: sweeps ${lastRun.sweeps.join(" and ")}, inflows ${lastRun.inflows}, inputs ${lastRun.seconds.inputs.toFixed(2)} s, gpu ${lastRun.seconds.gpu.toFixed(2)} s`);
    } else throw new Error(`stage "${name}": surplus, discharge, basin, flow, coarse, global or water`);
    forget(); unmap();
  } finally { await releaseGpu(); }
  process.exit(0);
}
