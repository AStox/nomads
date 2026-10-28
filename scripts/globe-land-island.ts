// The island's erosion (the generator's own run, src/gpu/terrain/island.ts) drawn and measured the way a region of the planet is (scripts/globe-land-region.ts), so the two are compared by the
// same renderer and the same lattice and block measures.
//   lockf /tmp/nomads-gpu.lock bun scripts/globe-land-island.ts --seed 1 --out $HOME/.cache/nomads-bakes/land/view/island1.png
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { BAKE } from "../src/gpu/globe/bakedir";
import { releaseGpu, theGpu } from "../src/gpu/device";
import { planFrom, upstreamRaw } from "../src/gpu/terrain/upstream";
import { CREEP } from "../src/terrain/geology";
import { ERODE, U0 } from "../src/terrain/island";
import { rng } from "../src/sim/world";
import { N } from "../src/terrain/grid";
import { blockStep, dissection, lattice, renderLand, responseYears } from "./globe-land-metrics";

const arg = (name: string, d: string) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : d; };
const seed = Number(arg("seed", "1")), scale = Number(arg("scale", "3"));
const g = await theGpu();
try {
  const raw = await upstreamRaw(g, planFrom(rng(seed))), up = raw.up, n = N * N, area = new Float64Array(n).fill(1);
  for (let q = n - 1; q >= 0; q--) { const k = up.order[q]; if (up.to[k] !== k) area[up.to[k]] += area[k]; }
  const at = (x: number, y: number) => Math.min(N - 1, Math.max(0, y)) * N + Math.min(N - 1, Math.max(0, x));
  writeFileSync(arg("out", join(BAKE, "land", "view", `island${seed}.png`)), renderLand((x, y) => up.height[at(x, y)], (x, y) => area[at(x, y)], [0, 0, N], scale, Number(arg("river", "100"))));
  const live = Uint8Array.from(up.height, (h, k) => (h > 0 && k % N > 8 && k % N < N - 8 && Math.floor(k / N) > 8 && Math.floor(k / N) < N - 8 ? 1 : 0));
  const res: Record<string, unknown> = { seed, land: live.reduce((a, b) => a + b, 0), lattice30: lattice(up.to, area, N, live, 30, 8), lattice300: lattice(up.to, area, N, live, 300, 8) };
  const h256 = Int32Array.from(up.height, (v) => Math.round(v * 256));
  res.dissection30 = dissection(h256, area, N, live, 30, 32);
  for (const b of [32, 16, 8, 4]) res[`blockStep${b}`] = +blockStep(h256, N, live, b, 0).toFixed(3);
  const dt = (ERODE.times * raw.tau) / ERODE.steps;
  res.tauMy = +(raw.tau / 1e6).toFixed(1); res.stepMy = +(dt / 1e6).toFixed(2); res.totalMy = +((dt * ERODE.steps) / 1e6).toFixed(0); res.upliftMPerMy = +(U0 * 1e6).toFixed(3); res.creepSubs = Math.ceil((CREEP * dt) / (ERODE.stable * 75 * 75));
  res.tauCpuMy = +(responseYears(up.to, area, N, live, 7.07e-8) / 1e6).toFixed(0);
  let top = 0;
  for (const v of up.height) top = Math.max(top, v);
  res.summitM = Math.round(top);
  console.log(JSON.stringify(res));
} finally { await releaseGpu(); }
process.exit(0);
