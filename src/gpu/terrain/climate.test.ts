// The rest of the climate on the GPU (climate.ts, wgsl/terrain-climate.ts): the wind and salt, the horizons and sky, the sun
// through the cloud, warmth and damp air, the pool of cold air, the snow years and Penman's evaporation. On seeds 1 to 3
// and on a taller, steeper island made from seed 1 it is tested three ways:
// 1. What the model says of its own fields, which needs no reference: every field finite and inside its physical range, the
//    annual fields the sums of the seasons', the fog the lookup of its cited table at each cell's height, the sea at its
//    measured warmth with the air's water at its pressure, summer warmer and brighter than winter, and the higher ground
//    colder, cloudier and snowier and the coast saltier.
// 2. The same words on a second run, field by field.
// 3. A golden hash of every field per seed, which pins the integer arithmetic bit for bit.
// Run one case at a time: bun test ./src/gpu/terrain/climate.test.ts -t "climate seed 1" --timeout 280000
import { afterAll, expect, test } from "bun:test";
import { releaseGpu, theGpu } from "../device";
import { rng } from "../../sim/world";
import { LEN } from "../../terrain/grid";
import { upstream } from "../../terrain/island";
import { FOG, FOG_Z, ROSE, SEASONS, WET_ROSE, esat, meanWay, pressure, turned } from "../../terrain/climate";
import { rainGpu } from "./rain";
import { climateRestGpu, tableMargin, type ClimateRest, type ClimateRestInput } from "./climate";

afterAll(releaseGpu);

// What the generator hands the stage after its upstream stages: the heights the ice leaves, the open water (the sea and
// the hollows deep enough to hold a lake), the prevailing wind, which is the generator's first draw after them, and the
// rain of each season (rainGpu's, as src/gpu/terrain/island.ts climateGpu brings it).
async function site(seed: number): Promise<ClimateRestInput> {
  const rand = rng(seed), { height, open } = upstream(rand);
  const angle = rand() * Math.PI * 2;
  const z = Float32Array.from(height, (h) => Math.max(0, h));
  return { height, open, precip: await rainGpu(await theGpu(), z, turned(WET_ROSE, angle - meanWay(ROSE))), angle };
}

// Every field in the order the golden hash reads them.
function fields(c: ClimateRest): [string, ArrayLike<number>][] {
  const out: [string, ArrayLike<number>][] = [];
  for (const k of ["windShare", "breeze", "salt", "sky", "pool", "snow", "snowCover", "fog", "temp", "pet", "sun", "lee"] as const) out.push([k, c[k]]);
  c.seasons.forEach((s, si) => { for (const k of ["pet", "sun", "temp", "humid", "snowpack"] as const) out.push([`seasons.${k}[${si}]`, s[k]]); });
  return out;
}
const bytes = (f: ArrayLike<number>) => { const a = f as Float32Array | Uint8Array; return Buffer.from(a.buffer, a.byteOffset, a.byteLength); };
const golden = (c: ClimateRest) => Bun.hash(Buffer.concat(fields(c).map(([, f]) => bytes(f)))).toString(16);

// The pinned output of each seed's island: Bun.hash over every field in the order above, as the bytes the stage returns.
// It pins the integer arithmetic bit for bit, so it is re-recorded deliberately, with the commit message saying why,
// whenever the model changes (the climate's constants, the rain it is given, the upstream stages that make the heights).
const GOLDEN: Record<number, string> = { 1: "a71edd5d22b6ca67", 2: "aa26617299778dcd", 3: "3a18e2b4211bf5e3" };

const mean = (f: ArrayLike<number>, at: number[]) => at.reduce((s, i) => s + f[i], 0) / at.length;
// The cited cloud table read at a height, as a season's share of hours inside cloud (FOG, linear between the heights, the
// highest held above them).
function inCloud(si: number, z: number) {
  const row = FOG[si];
  for (let n = 1; n < FOG_Z.length; n++) if (z <= FOG_Z[n]) return row[n - 1] + ((row[n] - row[n - 1]) * (z - FOG_Z[n - 1])) / (FOG_Z[n] - FOG_Z[n - 1]);
  return row[row.length - 1];
}

function invariants(label: string, { height, open, angle }: ClimateRestInput, c: ClimateRest) {
  const say = (what: string) => `${label} ${what}`;
  expect(c.wind, say("wind")).toEqual([Math.cos(angle), Math.sin(angle)]);
  for (const [name, f] of fields(c)) for (let i = 0; i < f.length; i++) if (!Number.isFinite(f[i])) throw new Error(say(`${name} is not finite at cell ${i}`));
  const within = (name: string, f: ArrayLike<number>, lo: number, hi: number) => {
    for (let i = 0; i < LEN; i++) if (f[i] < lo || f[i] > hi) throw new Error(say(`${name} is ${f[i]} at cell ${i}, outside ${lo} to ${hi}`));
  };
  for (const k of ["windShare", "salt", "sky", "pool", "snow", "snowCover", "fog"] as const) within(k, c[k], 0, 1);
  within("breeze", c.breeze, 0, 20);
  within("pet", c.pet, 0, 2000);
  within("sun", c.sun, 0, 1.5);
  c.seasons.forEach((s, si) => {
    within(`humid[${si}]`, s.humid, 0, 1);
    within(`pet[${si}]`, s.pet, 0, 1000);
    within(`sun[${si}]`, s.sun, 0, 40);
    within(`temp[${si}]`, s.temp, -30, 30);
    within(`snowpack[${si}]`, s.snowpack, 0, 3000);
  });
  expect(c.lee.length, say("lee")).toBe(LEN * 16);

  // the year's fields are made of the seasons' (a word of the fixed point's rounding between them)
  let dTemp = 0, dPet = 0, dFog = 0;
  for (let i = 0; i < LEN; i++) {
    dTemp = Math.max(dTemp, Math.abs(c.temp[i] - c.seasons.reduce((s, x) => s + x.temp[i], 0) / SEASONS.length));
    dPet = Math.max(dPet, Math.abs(c.pet[i] - c.seasons.reduce((s, x) => s + x.pet[i], 0)));
    dFog = Math.max(dFog, Math.abs(c.fog[i] - SEASONS.reduce((s, _, si) => s + inCloud(si, Math.max(0, height[i])), 0) / SEASONS.length));
  }
  console.log(`${label}: annual temp against the seasons' mean ${dTemp.toExponential(2)} C, pet against their sum ${dPet.toExponential(2)} mm, fog against the table ${dFog.toExponential(2)}`);
  expect(dTemp, say("annual temp")).toBeLessThan(3e-5);
  expect(dPet, say("annual pet")).toBeLessThan(2e-3);
  expect(dFog, say("fog against the cited table")).toBeLessThan(1e-5);

  // the sea is at its measured warmth, and its air holds the season's water thinned by the pressure at sea level
  const sea: number[] = [], land: number[] = [];
  for (let i = 0; i < LEN; i++) { if (height[i] < 0 && open[i]) sea.push(i); else if (height[i] > 0) land.push(i); }
  expect(sea.length, say("sea cells")).toBeGreaterThan(0);
  SEASONS.forEach(({ t, sea: warmth, humid0 }, si) => {
    const humid = Math.min(1, (humid0 * esat(t) * pressure(0)) / esat(warmth));
    for (const i of sea) {
      expect(Math.abs(c.seasons[si].temp[i] - warmth), say(`sea temp ${si}`)).toBeLessThan(1e-4);
      expect(Math.abs(c.seasons[si].humid[i] - humid), say(`sea humid ${si}`)).toBeLessThan(2e-4);
    }
  });

  // summer is warmer and brighter than winter, and winter holds more snow
  const [, summer, , winter] = c.seasons;
  expect(mean(summer.temp, land), say("summer against winter temp")).toBeGreaterThan(mean(winter.temp, land));
  expect(mean(summer.sun, land), say("summer against winter sun")).toBeGreaterThan(mean(winter.sun, land));
  expect(mean(winter.snowpack, land), say("winter against summer snowpack")).toBeGreaterThan(mean(summer.snowpack, land));

  // the lowest tenth of the land against the highest: warmer, clearer, less snowy, and nearer the spray
  land.sort((a, b) => height[a] - height[b]);
  const tenth = Math.floor(land.length / 10), low = land.slice(0, tenth), high = land.slice(-tenth);
  expect(mean(c.temp, low), say("temp by height")).toBeGreaterThan(mean(c.temp, high));
  expect(mean(c.fog, low), say("fog by height")).toBeLessThan(mean(c.fog, high));
  expect(mean(c.snowCover, low), say("snow cover by height")).toBeLessThan(mean(c.snowCover, high));
  expect(mean(c.salt, low), say("salt by height")).toBeGreaterThan(mean(c.salt, high));
}

async function check(label: string, input: ClimateRestInput, pin?: string) {
  const g = await theGpu();
  const cold0 = performance.now();
  const first = await climateRestGpu(g, input);
  const cold = performance.now() - cold0;
  const t0 = performance.now();
  const second = await climateRestGpu(g, input);
  const warm = performance.now() - t0;
  invariants(label, input, first);
  const again = new Map(fields(second));
  for (const [name, f] of fields(first)) expect(bytes(f).equals(bytes(again.get(name)!)), `${label} ${name} run to run`).toBe(true);
  console.log(`${label}: climateRestGpu ${warm.toFixed(0)} ms warm, ${cold.toFixed(0)} ms first call (pipelines compiled), on ${g.adapter}, golden ${golden(first)}`);
  if (pin !== undefined) expect(golden(first)).toBe(pin);
  return first;
}

test("the tables' roundings are well clear of ties, so an engine's last-place exp, cos or tanh cannot change a word", () => {
  expect(tableMargin()).toBeGreaterThan(1e-6);
});
for (const seed of [1, 2, 3]) {
  test(`climate seed ${seed}`, async () => {
    const out = await check(`seed ${seed}`, await site(seed), GOLDEN[seed]);
    // the Bornholm-like hills hold no snow in summer
    expect(out.seasons[1].snowpack.every((v) => v === 0), `seed ${seed} summer snowpack`).toBe(true);
  }, 280_000);
}
// The same island with its hills two and a half times as high: steeper than the wind's break (0.3), clouds past the
// highest fog height (500 m), and snow in summer on the peaks, none of which the Bornholm-like hills reach.
test("climate on a taller island", async () => {
  const s = await site(1), height = Float32Array.from(s.height, (h) => (h > 0 ? h * 2.5 : h));
  expect(height.reduce((m, h) => Math.max(m, h), 0)).toBeGreaterThan(400);
  const out = await check("tall island", { ...s, height });
  expect(out.seasons[1].snowpack.some((v) => v > 0), "tall island summer snowpack").toBe(true);
}, 280_000);
