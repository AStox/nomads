// The rest of the climate on the GPU (climate.ts, wgsl/terrain-climate.ts) against the float stage it ports (climate.ts in
// src/terrain: climate() less its rain) on seeds 1 to 3 and on a taller, steeper island made from seed 1: each field
// within a recorded tolerance, the same words on a second run, and the time one island takes.
// Run one seed at a time: bun test ./src/gpu/terrain/climate.test.ts -t "climate seed 1" --timeout 280000
import { afterAll, expect, test } from "bun:test";
import { releaseGpu, theGpu } from "../device";
import { rng } from "../../sim/world";
import { LEN, flood } from "../../terrain/grid";
import { generateIsland } from "../../terrain/island";
import { climate, type Climate } from "../../terrain/climate";
import { climateRestGpu, tableMargin, type ClimateRest } from "./climate";

afterAll(releaseGpu);

type Site = { height: Float32Array; open: Uint8Array; angle: number };

// What island.ts hands climate(): the heights its ice stage leaves, the open water (the sea and the hollows deep enough
// to hold a lake, island.ts 230 to 246) and the prevailing wind, which the Stage event reports as `wind`. The stage
// event comes after climate() has run once, which is all the generator that is needed, so the rest is abandoned.
function site(seed: number): Site {
  let height: Float32Array = new Float32Array(0), wind: [number, number] = [1, 0];
  const stop = new Error("climate stage reached");
  try {
    generateIsland(rng(seed), (s) => { if (s.stage === "climate") { height = s.height; wind = s.wind; throw stop; } });
  } catch (e) { if (e !== stop) throw e; }
  const { filled } = flood(height, 1e-4);
  const hollow = new Int32Array(LEN).fill(-1), basin = new Uint8Array(LEN), open = new Uint8Array(LEN);
  const fine = (j: number) => hollow[j] < 0 && filled[j] >= 0 && filled[j] - height[j] > 0.01;
  for (let s0 = 0; s0 < LEN; s0++) {
    if (!fine(s0)) continue;
    const cells = [s0];
    let deepest = 0;
    hollow[s0] = s0;
    for (let k = 0; k < cells.length; k++) {
      const i = cells[k], x = i % 256, y = (i - x) / 256;
      deepest = Math.max(deepest, filled[i] - height[i]);
      for (const j of [x > 0 ? i - 1 : -1, x < 255 ? i + 1 : -1, y > 0 ? i - 256 : -1, y < 255 ? i + 256 : -1]) if (j >= 0 && fine(j)) { hollow[j] = s0; cells.push(j); }
    }
    if (deepest > 3) for (const i of cells) basin[i] = 1;
  }
  for (let i = 0; i < LEN; i++) open[i] = filled[i] < 0 || basin[i] ? 1 : 0;
  const angle = Math.atan2(wind[1], wind[0]);
  return { height, open, angle: angle < 0 ? angle + 2 * Math.PI : angle };
}

// Each field's tolerance (max abs error and mean abs error, in the field's own unit) and why it is enough. Seeds 1 to 3
// and the tall island give, at worst:
//   windShare 1.7e-5, breeze 5.6e-5 m/s, salt 2.1e-5, sky 8.6e-6, fog 1.4e-6, snow 8.5e-6: Q16 words (1.5e-5) through sums
//     of sixteen bearings' fixed-point exponentials and wake curves;
//   lee 1 (a hundredth of the coast's wind) on one cell in 5,000: a byte's rounding of a product that fell on the other
//     side of a half;
//   temp 3.5e-4 C and humid 9e-5, pool 2.2e-4: the pool's ramp of the slope and the height above the ground around has a
//     slope of up to 25 per unit, so a word of rounding in the normal moves it ten words;
//   sun 6.5e-4 MJ/m2 a day, seasonal 2.7e-2 on one cell: the beam is lit or in shadow by a comparison of the sun's tangent
//     with the horizon's, so a cell on a shadow's edge (one in 60,000 here) takes the other side of a quarter-hour's
//     beam (0.9 MJ) a sample, with the face weight;
//   snow cover 7.4e-4, snow pack 0.57 mm of up to 238 and seasonal pet 0.35 mm of up to 300: the snow years are 4,015
//     days of a pack that melts by an energy balance, and a day's T within a word of the logistic's middle (1.3 C) or
//     of the dew point takes the other albedo or sky, 0.4 mm of snow, once in a thousand tiles.
// The hydrology and ground stages read the season's rain, evaporation, temperature, sun and snow cover as fields that
// vary over hundreds of millimetres, tens of degrees and whole shares, and the model's own constants carry three or four
// digits, so each of these is under a hundredth of a percent of its field's range except the snow's, a quarter of a percent
// of the thickest pack on one cell.
const TOL: Record<string, { max: number; mean: number }> = {
  windShare: { max: 5e-5, mean: 2e-6 }, breeze: { max: 2e-4, mean: 3e-5 }, salt: { max: 1e-4, mean: 1e-5 }, sky: { max: 3e-5, mean: 1e-5 },
  pool: { max: 1e-3, mean: 1e-5 }, snow: { max: 3e-5, mean: 1e-5 }, snowCover: { max: 3e-3, mean: 1e-5 }, fog: { max: 5e-6, mean: 1e-6 },
  temp: { max: 2e-3, mean: 3e-5 }, pet: { max: 1, mean: 0.05 }, sun: { max: 3e-3, mean: 3e-5 }, lee: { max: 1, mean: 5e-4 },
  "seasons.pet": { max: 1, mean: 0.02 }, "seasons.sun": { max: 0.1, mean: 2e-4 }, "seasons.temp": { max: 6e-3, mean: 3e-5 },
  "seasons.humid": { max: 5e-4, mean: 5e-5 }, "seasons.snowpack": { max: 2, mean: 2e-3 },
};

function fields(c: Climate | ClimateRest): [string, ArrayLike<number>][] {
  const out: [string, ArrayLike<number>][] = [];
  for (const k of ["windShare", "breeze", "salt", "sky", "pool", "snow", "snowCover", "fog", "temp", "pet", "sun", "lee"] as const) out.push([k, c[k]]);
  c.seasons.forEach((s, si) => { for (const k of ["pet", "sun", "temp", "humid", "snowpack"] as const) out.push([`seasons.${k}[${si}]`, s[k]]); });
  return out;
}

async function check(label: string, { height, open, angle }: Site) {
  const cpu = climate(height, open, () => angle / (2 * Math.PI));
  const g = await theGpu();
  const input = { height, open, precip: cpu.seasons.map((s) => s.precip), angle };
  const cold0 = performance.now();
  const first = await climateRestGpu(g, input);
  const cold = performance.now() - cold0;
  const t0 = performance.now();
  const second = await climateRestGpu(g, input);
  const warm = performance.now() - t0;
  expect(first.wind[0]).toBe(cpu.wind[0]);
  expect(first.wind[1]).toBe(cpu.wind[1]);
  const mine = new Map(fields(first)), again = new Map(fields(second)), lines: string[] = [];
  for (const [name, ref] of fields(cpu)) {
    const f = mine.get(name)!, tol = TOL[name.replace(/\[\d\]$/, "")];
    let max = 0, sum = 0, at = 0;
    for (let i = 0; i < ref.length; i++) {
      const e = Math.abs(f[i] - ref[i]);
      sum += e;
      if (e > max) { max = e; at = i; }
    }
    lines.push(`${name.padEnd(18)} max ${max.toExponential(2)} (cell ${at}), mean ${(sum / ref.length).toExponential(2)}`);
    expect(max, `${label} ${name} max`).toBeLessThanOrEqual(tol.max);
    expect(sum / ref.length, `${label} ${name} mean`).toBeLessThanOrEqual(tol.mean);
    const b = again.get(name)!;
    expect(Buffer.from(Float32Array.from(f).buffer).equals(Buffer.from(Float32Array.from(b).buffer)), `${label} ${name} run to run`).toBe(true);
  }
  console.log(`${label}: climateRestGpu ${warm.toFixed(0)} ms warm, ${cold.toFixed(0)} ms first call (pipelines compiled), on ${g.adapter}\n  ${lines.join("\n  ")}`);
}

test("the tables' roundings are well clear of ties, so an engine's last-place exp, cos or tanh cannot change a word", () => {
  expect(tableMargin()).toBeGreaterThan(1e-6);
});
for (const seed of [1, 2, 3]) test(`climate seed ${seed}`, () => check(`seed ${seed}`, site(seed)), 280_000);
// The same island with its hills two and a half times as high: steeper than the wind's break (0.3), clouds past the
// highest fog height (500 m), and snow in summer on the peaks, none of which the Bornholm-like hills reach.
test("climate on a taller island", () => {
  const s = site(1);
  return check("tall island", { ...s, height: Float32Array.from(s.height, (h) => (h > 0 ? h * 2.5 : h)) });
}, 280_000);
