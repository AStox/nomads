// Writes the planet's ground tiles (src/gpu/globe/groundtile.ts, format in bake.ts GROUNDTILE_FIELDS): one gzipped file a tier-4 tile under <bake dir>/groundtiles/, from the stage files, in calls of at most
// --budget seconds (default 270); run it again until it says done. Tiles written are kept. The stages (terrain, air, water, ground) come first; a field whose stage file is missing is left out and named.
//   bun scripts/globe-groundtiles.ts --seed 1 --key <planet key> [--only 458,1] [--faces 1,4] [--budget 270]
import { bakeDir } from "../src/gpu/globe/bakedir";
import { buildGroundTiles } from "../src/gpu/globe/groundtile";

const arg = (name: string, d: string) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : d; };
const seed = Number(arg("seed", "1")), key = arg("key", process.env.NOMADS_PLANET_KEY ?? ""), dir = bakeDir(seed, key), budgetS = Number(arg("budget", "270"));
const tiles = arg("only", "") ? arg("only", "").split(",").map(Number) : arg("faces", "") ? arg("faces", "").split(",").flatMap((f) => Array.from({ length: 256 }, (_, k) => Number(f) * 256 + k)) : undefined;
const p = buildGroundTiles(dir, { seed, key, tiles, budgetS }, (s) => console.log(s));
console.log(`ground tiles: ${p.made} made, ${p.kept} kept, of ${p.of}${p.done ? ", done" : ": run this again"}; ${p.seconds.toFixed(0)} s; fields absent: ${p.absent.join(", ") || "none"}`);
