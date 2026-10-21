// Bakes the 75 m tier's tile pyramid (src/gpu/globe/pyramid.ts, format in bake.ts PYRAMID_FIELDS) from the fields the stages wrote into /tmp/planet-75m/<seed>-<planet key>/; every word is
// converted to the pyramid's integer here. A field whose files are missing is left out of the pyramid and named in pyramid.json `missing`.
//   bun scripts/globe-pyramid.ts --seed 1 --key c418e5fe9b5e [--faces 1,4]
import { bakeDir } from "../src/gpu/globe/bakedir";
import { precipOfWord } from "../src/gpu/globe/air";
import { buildPyramid, type Source } from "../src/gpu/globe/pyramid";

const arg = (name: string, d: string) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : d; };
const seed = Number(arg("seed", "1")), key = arg("key", process.env.NOMADS_PLANET_KEY ?? ""), dir = bakeDir(seed, key), faces = arg("faces", "") ? arg("faces", "").split(",").map(Number) : undefined;
const seasons = (stem: string, type: string) => [0, 1, 2, 3].map((s) => `t4-${stem}${s}.${type}`);
const sources: Record<string, Source | undefined> = {
  height: { files: ["t4-height.i32"], convert: ([v]) => v / 64 },
  rock: { files: ["t4-rock.u8"], convert: ([v]) => v },
  drift: { files: ["t4-drift.u8"], convert: ([v]) => v },
  driftDepth: { files: ["t4-dd.u16"], convert: ([v]) => v / 128 },
  temp: { files: seasons("tmp", "i16"), convert: (v) => ((v[0] + v[1] + v[2] + v[3]) / 4 / 256) * 2 },
  rain: { files: seasons("pr", "u16"), convert: (v) => precipOfWord(v[0]) + precipOfWord(v[1]) + precipOfWord(v[2]) + precipOfWord(v[3]) },
  water: { files: ["t4-water.u16"], convert: ([v]) => v / 50 },
  river: { files: ["t4-flow.u32"], convert: ([v]) => 16 * Math.log2(1 + v / 65536) },
  tree: { files: ["t4-tree.u8"], convert: ([v]) => v },
  shrub: { files: ["t4-shr.u8"], convert: ([v]) => v },
  grass: { files: ["t4-grs.u8"], convert: ([v]) => v },
  marsh: { files: ["t4-mar.u8"], convert: ([v]) => v },
  bare: { files: ["t4-bare.u8"], convert: ([v]) => v },
  soil: { files: ["t4-soil.u16"], convert: ([v]) => v / 25.6 },
};
for (const [name, s] of Object.entries(sources)) if (s && !s.files.every((f) => dir.has(f))) delete sources[name];
const t0 = performance.now(), counts = buildPyramid(dir, { seed, key, topTier: 4, sources, faces });
console.log(`pyramid tiles by tier ${counts.join(", ")} in ${((performance.now() - t0) / 1000).toFixed(0)} s; missing: ${dir.json<{ missing: string[] }>("pyramid")!.missing.join(", ") || "none"}`);
