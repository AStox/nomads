// The orographic rain on the GPU (rain.ts, wgsl/terrain-rain.ts) against the float function it ports (climate.ts
// orographic) on seeds 1 to 3: each season's rain within a recorded tolerance, the same words on a second run, and the
// time one island takes. Run one seed at a time: bun test ./src/gpu/terrain/rain.test.ts -t "seed 1" --timeout 300000
import { afterAll, expect, test } from "bun:test";
import { releaseGpu, theGpu } from "../device";
import { generateIsland } from "../../terrain/island";
import { ROSE, WET_ROSE, meanWay, orographic, turned } from "../../terrain/climate";
import { rng } from "../../sim/world";
import { rainGpu, tableMargin } from "./rain";

afterAll(releaseGpu);

// The heights climate() is given (the island's ground, never under the sea's level) and the wet rose it builds from its
// first random draw, the prevailing wind, which the Stage event reports as `wind`.
function inputs(seed: number) {
  let wind: [number, number] = [1, 0], height: Float32Array = new Float32Array(0);
  generateIsland(rng(seed), (s) => { if (s.stage === "climate") { height = s.height; wind = s.wind; } });
  const z = Float32Array.from(height, (h) => Math.max(0, h));
  const wetRose = turned(WET_ROSE, Math.atan2(wind[1], wind[0]) - meanWay(ROSE));
  return { z, wetRose };
}

// Tolerance in mm over a season, which rains 80 to 370 mm. Seeds 1 to 3 give a largest error of 0.0043 mm (1.2e-5 of the
// wettest cell's season) and a mean of 0.0004 mm in every season: the roundings of the constants (Q26 against the
// float's 1e-16), of the wind's cosine and sine (Q22) and of the stages' words, all far under the three or four digits
// the model's own constants (SEASONS, the wet rose) are given to.
const MAX_ERR = 0.01, MEAN_ERR = 0.001;

async function check(seed: number) {
  const { z, wetRose } = inputs(seed);
  const cpu = orographic(z, wetRose);
  const g = await theGpu();
  const t0 = performance.now();
  const first = await rainGpu(g, z, wetRose);
  const cold = performance.now() - t0;
  const t1 = performance.now();
  const second = await rainGpu(g, z, wetRose);
  const warm = performance.now() - t1;
  cpu.forEach((c, si) => {
    let max = 0, sum = 0, at = 0, peak = 0;
    for (let i = 0; i < c.length; i++) {
      const e = Math.abs(first[si][i] - c[i]);
      sum += e;
      peak = Math.max(peak, c[i]);
      if (e > max) { max = e; at = i; }
    }
    console.log(`seed ${seed} season ${si}: max abs ${max.toFixed(4)} mm (cell ${at}), mean abs ${(sum / c.length).toFixed(5)} mm, rain up to ${peak.toFixed(1)} mm`);
    expect(max).toBeLessThan(MAX_ERR);
    expect(sum / c.length).toBeLessThan(MEAN_ERR);
  });
  second.forEach((s, si) => expect(Buffer.from(s.buffer).equals(Buffer.from(first[si].buffer))).toBe(true));
  console.log(`seed ${seed}: rainGpu ${warm.toFixed(0)} ms warm, ${cold.toFixed(0)} ms first call (pipelines compiled), on ${g.adapter}`);
}

test("the tables' roundings are well clear of ties, so an engine's last-place cosine cannot change a word", () => {
  expect(tableMargin()).toBeGreaterThan(1e-6);
});
test("rain seed 1", () => check(1), 300_000);
test("rain seed 2", () => check(2), 300_000);
test("rain seed 3", () => check(3), 300_000);
