// What a ground tile costs on the GPU, stage by stage (the measurements behind docs/plans/2026-10-20-001-feat-seamless-globe-plan.md Unit 8):
//   bun scripts/play/tilecost.ts [lat lon] [--key 7f6ff6c82cdd]
// The tile that holds (lat, lon) of the planet's finest tier, from its ground tile file; the scatter of the whole tile and of 1/16 of it, the fine ground of
// the tile as a window, first call (pipelines compile) and warm. One GPU job, a few seconds.
import { readFileSync } from "node:fs";
import { holdGpu, exit } from "../seeded";
import { theGpu } from "../../src/gpu/device";
import { fromLatLon, locateVec, tierGrid } from "../../src/gpu/globe/grid";
import { readGroundTile, tileSource } from "../../src/gpu/globe/groundtile";
import { scatterTile } from "../../src/gpu/globe/scatter";
import { laps } from "../../src/gpu/terrain/scenery";
import { windowFine } from "../../demo/tile";

const args = process.argv.slice(2), at = (n: string, d: string) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const nums = args.filter((a) => /^-?\d/.test(a)).map(Number), lat = nums[0] ?? 4.35, lon = nums[1] ?? -39.38, key = at("--key", "7f6ff6c82cdd"), TIER = 5;
await holdGpu();
const gpu = await theGpu(), g = tierGrid(TIER), loc = locateVec(g, fromLatLon((lat * Math.PI) / 180, (lon * Math.PI) / 180)), nT = 2 ** TIER;
const tx = Math.floor(loc.X / 256), ty = Math.floor(loc.Y / 256), tile = loc.face * nT * nT + ty * nT + tx;
const t0 = performance.now(), gt = readGroundTile(readFileSync(`/tmp/planet-75m/1-${key}/groundtiles/f${loc.face}/${ty}-${tx}.gt.gz`));
console.log(`tile ${tile} (face ${loc.face} ${tx},${ty}) read and inflated in ${(performance.now() - t0).toFixed(0)} ms, ${gt.meta.fields.length} planes`);
const ctx = { gpu, dir: null as never, tier: TIER }, ms = (t: number) => `${(performance.now() - t).toFixed(0)} ms`;

const fine = async (label: string) => { const t = performance.now(); await windowFine(gpu, tileSource(gt), loc.face, tx * 256, ty * 256); console.log(`fine ground of the tile as a window, ${label}: ${ms(t)}`); };
await fine("first");
await fine("warm");

laps.on = true;
const scat = async (label: string, win?: { x0: number; y0: number; w: number; h: number }) => {
  laps.ms = {};
  const t = performance.now(), sc = win ? await scatterTile(ctx, tile, 1, 2, false, tileSource(gt), win) : await scatterTile(ctx, tile, 1, 2, false, tileSource(gt));
  const total = performance.now() - t, rest = total - Object.values(laps.ms).reduce((a, b) => a + b, 0);
  console.log(`scatter ${label}: ${total.toFixed(0)} ms, ${sc.flora.n} objects; ${Object.entries(laps.ms).map(([k, v]) => `${k} ${v.toFixed(0)}`).join(", ")}, other ${rest.toFixed(0)}`);
};
await scat("whole tile, first");
await scat("whole tile, warm");
await scat("full rect", { x0: 0, y0: 0, w: 256, h: 256 });
await scat("1/16 (64 by 64 cells), warm", { x0: 96, y0: 96, w: 64, h: 64 });
await scat("1/16 again", { x0: 160, y0: 32, w: 64, h: 64 });
laps.on = false;
for (let j = 0; j < 4; j++) { const row: number[] = []; for (let i = 0; i < 4; i++) row.push((await scatterTile(ctx, tile, 1, 2, false, tileSource(gt), { x0: i * 64, y0: j * 64, w: 64, h: 64 })).flora.n); console.log("sub-rects row", j, row.join(" ")); }
await exit();
