// The coarse tier's terrain and climate pooled from the finest tier's stage files (src/gpu/globe/pool.ts), in calls of at most --budget seconds into /tmp/planet-75m/<seed>-<planet key>/: run it again
// until it says done. CPU only (no GPU lock). The terrain and air stages of the finest tier come first.
//   bun scripts/globe-pool.ts --seed 1 --key <planet key> [--from 5] [--to 3] [--budget 240]
import { bakeDir } from "../src/gpu/globe/bakedir";
import { PLANET_TIER } from "../src/gpu/globe/grid";
import { poolTier } from "../src/gpu/globe/pool";

const arg = (name: string, d: string) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : d; };
const seed = Number(arg("seed", "1")), key = arg("key", process.env.NOMADS_PLANET_KEY ?? ""), from = Number(arg("from", String(PLANET_TIER))), to = Number(arg("to", "3")), budget = Number(arg("budget", "240"));
if (!key) throw new Error("name the planet's key: --key <hash>");
const p = poolTier(bakeDir(seed, key), from, to, budget, (s) => console.log(s));
console.log(`pool tier ${from} to ${to}: ${p.tiles} of ${p.of} tiles made${p.done ? ", done" : ": run this again"}; this call ${p.tileS.length} tiles, ${p.seconds.toFixed(0)} s`);
