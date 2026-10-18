// How the target summit (island.ts SUMMIT_M, set here through NOMADS_SUMMIT) moves the island: summits, slopes and the
// six Bornholm gaps. Each value runs as its own process because the uplift is read when the module loads.
//   bun scripts/island-relief.ts 163.5 400 800 1500
const values = process.argv.slice(2).length ? process.argv.slice(2) : ["163.5", "400", "800", "1500"];
for (const v of values) {
  console.log(`\n=== target summit ${v} m`);
  const p = Bun.spawnSync(["bun", "scripts/island-gaps.ts", "--seeds", "6"], { env: { ...process.env, NOMADS_SUMMIT: v }, stdout: "pipe", stderr: "pipe" });
  console.log(p.stdout.toString().split("\n").filter((l) => /summit|rain|km of the|ha or more|lake area|table depth|winter table|^tree|^open|marsh|peat over|carbon|coast minus|rror/.test(l)).join("\n"));
  const q = Bun.spawnSync(["bun", "-e", `
import { generateIsland } from "./src/gpu/terrain/island"; import { theGpu } from "./src/gpu/device"; import { rng } from "./src/sim/world"; import { exit } from "./scripts/seeded"; import { CELL, N } from "./src/terrain/grid";
const g = await theGpu(), out = [];
for (const s of [1, 2, 3]) {
  const i = await generateIsland(rng(s), g), h = i.height; let top = 0, land = 0; const sl = [];
  for (let y = 1; y < N - 1; y++) for (let x = 1; x < N - 1; x++) { const k = y * N + x; if (h[k] <= 0) continue; land++; if (h[k] > top) top = h[k]; sl.push(Math.atan(Math.hypot(h[k + 1] - h[k - 1], h[k + N] - h[k - N]) / (2 * CELL)) * 180 / Math.PI); }
  sl.sort((a, b) => a - b); out.push("seed " + s + ": summit " + Math.round(top) + " m, median slope " + sl[sl.length >> 1].toFixed(1) + " deg, p95 " + sl[Math.floor(sl.length * 0.95)].toFixed(1) + " deg");
}
console.log(out.join("\\n")); await exit();`], { env: { ...process.env, NOMADS_SUMMIT: v }, stdout: "pipe", stderr: "pipe" });
  console.log(q.stdout.toString().trim() || q.stderr.toString().split("\n").filter((l) => /rror/.test(l)).join("\n"));
}
