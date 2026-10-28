// Bakes the planet's tile pyramid (src/gpu/globe/pyramid.ts, format in bake.ts PYRAMID_FIELDS) from the fields the stages wrote into the bake directory (bakedir.ts BAKE, default ~/.cache/nomads-bakes), in <seed>-<planet key>/; every word is
// converted to the pyramid's integer here. A field whose files are missing is left out of the pyramid and named in pyramid.json `missing`. Tiers 0 to --tier (default PLANET_TIER) are made, the
// top one from the stage files' tier. Calls of at most --budget seconds (default 240): run it again until it says done; finished units are kept.
//   bun scripts/globe-pyramid.ts --seed 1 --key c418e5fe9b5e [--tier 5] [--faces 1,4] [--budget 240] [--out <dir>]
// --out writes `pyramid/` and `pyramid.json` under <dir> and only reads the bake directory (a dir laid out like the bake's can then be a bake directory's drop-in for the site).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { bakeDir, tierFile } from "../src/gpu/globe/bakedir";
import { precipOfWord } from "../src/gpu/globe/air";
import { PLANET_TIER } from "../src/gpu/globe/grid";
import { buildPyramid, lakeShare, type Source } from "../src/gpu/globe/pyramid";

const arg = (name: string, d: string) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : d; };
const seed = Number(arg("seed", "1")), key = arg("key", process.env.NOMADS_PLANET_KEY ?? ""), dir = bakeDir(seed, key), faces = arg("faces", "") ? arg("faces", "").split(",").map(Number) : undefined;
const tier = Number(arg("tier", String(PLANET_TIER))), budgetS = Number(arg("budget", "240"));
const file = (name: string) => tierFile(tier, name), seasons = (stem: string, type: string) => [0, 1, 2, 3].map((s) => file(`${stem}${s}.${type}`));
const sources: Record<string, Source | undefined> = {
  height: { files: [file("height.i32")], convert: ([v]) => v / 64 },
  rock: { files: [file("rock.u8")], convert: ([v]) => v },
  drift: { files: [file("drift.u8")], convert: ([v]) => v },
  driftDepth: { files: [file("dd.u16")], convert: ([v]) => v / 128 },
  temp: { files: seasons("tmp", "i16"), convert: (v) => ((v[0] + v[1] + v[2] + v[3]) / 4 / 256) * 2 },
  rain: { files: seasons("pr", "u16"), convert: (v) => precipOfWord(v[0]) + precipOfWord(v[1]) + precipOfWord(v[2]) + precipOfWord(v[3]) },
  water: { files: [file("water.u16")], convert: ([v]) => v / 50 },
  river: { files: [file("flow.u32")], convert: ([v]) => 16 * Math.log2(1 + v / 65536) },
  tree: { files: [file("tree.u8")], convert: ([v]) => v },
  shrub: { files: [file("shr.u8")], convert: ([v]) => v },
  grass: { files: [file("grs.u8")], convert: ([v]) => v },
  marsh: { files: [file("mar.u8")], convert: ([v]) => v },
  bare: { files: [file("bare.u8")], convert: ([v]) => v },
  soil: { files: [file("soil.u16")], convert: ([v]) => v / 25.6 },
  lake: { files: [file("water.u16"), file("height.i32"), file("flooded.i32")], convert: lakeShare, across: true },
};
for (const [name, s] of Object.entries(sources)) if (s && !s.files.every((f) => dir.has(f))) delete sources[name];
const out = arg("out", "") || undefined;
const p = buildPyramid(dir, { seed, key, topTier: tier, sources, faces, budgetS, out });
console.log(`pyramid: ${p.unitsMade} units made, ${p.unitsKept} kept, of ${p.units}; tiles made by tier ${p.counts.join(", ")}; ${p.seconds.toFixed(0)} s; ${p.done ? `done; missing: ${JSON.parse(readFileSync(join(out ?? dir.dir, "pyramid.json"), "utf8")).missing.join(", ") || "none"}` : "run this again"}`);
