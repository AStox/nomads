// The planet's discharge and lakes out of core (src/gpu/globe/discharge-stream.ts, basin-stream.ts): the same files as `scripts/globe-water.ts --stage discharge|basin` makes in memory, made a
// block of tiles at a time, in calls of at most --budget seconds, into the bake directory (bakedir.ts BAKE, default ~/.cache/nomads-bakes), in <seed>-<planet key>/ (or --dir): run each stage again until it says done. No GPU is used.
//   bun scripts/globe-water-stream.ts --stage discharge --tier 5 --key 883a8d9387df --block 4 --budget 250     # needs t5-to.u32 and t5-vs0..3.u32
//   bun scripts/globe-water-stream.ts --stage basin --tier 5 --key 883a8d9387df                               # needs t5-height, -flooded, -lakenet, -to and the discharge's t5-q0..3
//   --block 2 --reverse   another tiling and the blocks in reverse order (the bytes do not change)
import { PLANET_RADIUS_M, PLANET_TIER } from "../src/gpu/globe/grid";
import { BakeDir, bakeDir } from "../src/gpu/globe/bakedir";
import { basinStream } from "../src/gpu/globe/basin-stream";
import { dischargeStream } from "../src/gpu/globe/discharge-stream";
import { dischargeFields } from "../src/gpu/globe/water";
import { sourceKey } from "./globe-window";

const arg = (name: string, d: string) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : d; };
const mean = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);

if (import.meta.main) {
  const seed = Number(arg("seed", "1")), key = arg("key", "") || sourceKey(undefined, PLANET_RADIUS_M), name = arg("stage", ""), budget = Number(arg("budget", "250")), tier = Number(arg("tier", String(PLANET_TIER)));
  const block = Number(arg("block", "4")), reverse = process.argv.includes("--reverse"), dir = arg("dir", "") ? new BakeDir(arg("dir", "")) : bakeDir(seed, key), log = (s: string) => console.log(s);
  const peak = () => `peak rss ${(process.resourceUsage().maxRSS / 2 ** 20).toFixed(2)} GB`;
  if (name === "discharge") {
    const p = await dischargeStream(dir, tier, dischargeFields(tier), budget, log, { block, reverse });
    console.log(`discharge: ${p.done ? "done" : `${p.stage}, ${p.blocksDone} of ${p.blocks} blocks: run this again`}, this call area1 ${p.blockS.area1.length} blocks (${mean(p.blockS.area1).toFixed(2)} s each), skeleton of ${p.exits} exits ${p.skelS.toFixed(1)} s, area2 ${p.blockS.area2.length} blocks (${mean(p.blockS.area2).toFixed(2)} s each), ${p.seconds.toFixed(0)} s, ${peak()}`);
  } else if (name === "basin") {
    const p = await basinStream(dir, tier, budget, log, { block, reverse });
    console.log(`basin: ${p.done ? `done, ${p.lakes} lakes, ${p.dry} dry hollows` : `${p.stage}, ${p.blocksDone} of ${p.blocks} blocks: run this again`}, this call label ${p.blockS.label.length} blocks (${mean(p.blockS.label).toFixed(2)} s each), inflow ${p.blockS.inflow.length} (${mean(p.blockS.inflow).toFixed(2)} s), write ${p.blockS.write.length} (${mean(p.blockS.write).toFixed(2)} s), merge of ${p.touching} of ${p.components} block components ${p.mergeS.toFixed(1)} s, ${p.seconds.toFixed(0)} s, ${peak()}`);
  } else throw new Error(`stage "${name}": discharge or basin`);
  process.exit(0);
}
