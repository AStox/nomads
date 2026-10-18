// The ground on the GPU against src/terrain/ground.ts, on the Site islands 1 to 3 give it, the same words on a second run,
// and one island's time. One case a seed (the island takes some 10 s to make), plus one on seed 1 with its rock rearranged
// so the beaches, limestone and mudstone pH classes and the sand coast all occur, which the Bornholm islands' crystalline
// coasts do not give.
//
// The GPU's plant carbon is not the float stage's: it has a leafless season and a daylight term for the plants that lose
// their leaves (terrain-phenology.ts) and passes on to the soil only the foliage and roots of a tree or shrub, not its wood
// (SOIL_SHARE in the kernel), where src/terrain/ground.ts, the unfixed reference until the generator is cut over, takes a
// crop's whole year of dry matter. So the test compares with the float stage only where the change cannot reach, and
// checks the rest against what the change should do:
// - the soil, alluvium, beach sand, peat, texture and fertility are upstream of the carbon, and on peat (all organic, its
//   carbon a constant, its organic matter 100%) every field but the nitrogen is too: all within the float stage's tolerance;
// - the carbon changes the organic matter, which changes what the soil holds, so cover and the soil's water move a little
//   on the rest: their mean difference is bounded, not their cells;
// - each season's leaf display is the float law's (terrain-phenology.ts leafFactors) within the fixed point's error, is
//   nothing in winter (no day reaches 10 h), and is never over 1;
// - in a canopy of broadleaf trees the soil's input is the float stage's times the foliage and roots' share times the leaf
//   display's year of sun over the warmth ramp's (the nitrogen, which is proportional to it), and the carbon follows it
//   by RothC's steady state, whose active part is linear in the input: carbon less its inert part over the nitrogen is the
//   float stage's wherever the cover is the same.
import { afterAll, expect, test } from "bun:test";
import { rng } from "../../sim/world";
import { LEN } from "../../terrain/grid";
import { generateIsland } from "../../terrain/island";
import { ground, type Ground, type Site } from "../../terrain/ground";
import { LIMESTONE, MUDSTONE, SANDSTONE } from "../../terrain/geology";
import { warmEnough, watered } from "../../terrain/growth";
import { releaseGpu, theGpu } from "../device";
import { leafFactors } from "../wgsl/terrain-phenology";
import { SOIL_SHARE } from "../wgsl/terrain-ground";
import { groundAndLeaf } from "./ground";

afterAll(releaseGpu);

// Each field's tolerance (max abs error) and the reason it is enough. Every input is rounded to 2^-16, which moves a
// fit that rises steeply from nothing (a tree on a water table of 0.24 m) by some 3e-4 of itself, and so the shares of
// the few cells on such a rise by up to 5e-4; carbon and nitrogen follow their cover by 1e-4 of themselves.
const TOL: Record<string, number> = {
  soil: 1e-4, silt: 0, sand: 0, peat: 1e-4, sandy: 1e-4, clayey: 1e-4, carbon: 0.05, organic: 0.02, nitrogen: 0.05, ph: 1e-4, fertility: 1e-4, moist: 1e-4,
  soilWater: 5e-4, tree: 1e-3, shrub: 1e-3, grass: 1e-3, marsh: 1e-3, bare: 1e-3, field: 1e-3, fieldLight: 1e-6,
};
// What the carbon cannot reach, everywhere; and what peat's constant carbon leaves alone, on peat.
const UPSTREAM = ["soil", "silt", "sand", "peat", "sandy", "clayey", "fertility"];
// The organic matter moves the water the soil holds and so the cover by a little: the mean over the land of a cover share's
// or the moisture's difference from the float stage stays under MEAN_MOVE, a few hundredths of a share; the soil water
// is a share of the bucket, and the bucket is smaller by the relative change in what the soil holds (a tenth or so), so
// its mean move is under a twentieth.
const MEAN_MOVE = 0.02, WATER_MOVE = 0.05;
// The leaf display's own error: Q16 inputs and Q24 sums over 364 days, against the float law.
const LEAF_TOL = 5e-4;

const names = (x: Ground) => Object.entries(x).flatMap(([k, v]) => (Array.isArray(v) ? v.map((f, s) => [`${k}${s}`, f] as const) : [[k, v] as const]));
const quantile = (xs: number[], q: number) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };

function island(seed: number): Site {
  const isle = generateIsland(rng(seed));
  return { ...isle, open: Uint8Array.from(isle.water, (w) => (w > 0 ? 1 : 0)) };
}

const stats = (a: Float32Array, b: Float32Array, cells: ArrayLike<number>, weight?: Float32Array) => {
  let max = 0, sum = 0;
  for (const i of cells as number[]) { const d = Math.abs(a[i] - b[i]) * (weight ? weight[i] : 1); sum += d; if (d > max) max = d; }
  return { max, mean: sum / cells.length };
};

async function check(label: string, site: Site) {
  const g = await theGpu();
  const cpu = ground(site);
  await groundAndLeaf(g, site); // the pipelines compile on first use
  const t0 = performance.now();
  const { ground: a, leaf } = await groundAndLeaf(g, site);
  const ms = performance.now() - t0;
  const { ground: b, leaf: leafB } = await groundAndLeaf(g, site);
  const bs = new Map(names(b));
  for (const [name, f] of names(a)) expect(Buffer.from(f.buffer).equals(Buffer.from(bs.get(name)!.buffer)), `${label} ${name} run to run`).toBe(true);
  leaf.forEach((f, k) => expect(Buffer.from(f.buffer).equals(Buffer.from(leafB[k].buffer)), `${label} leaf${k} run to run`).toBe(true));

  const land: number[] = [], peat: number[] = [], canopy: number[] = [];
  for (let i = 0; i < LEN; i++) {
    if (site.open[i]) continue;
    land.push(i);
    if (cpu.peat[i] > 0) peat.push(i);
    else if (a.tree[i] >= 0.85 && cpu.tree[i] >= 0.85 && cpu.nitrogen[i] > 0 && a.nitrogen[i] > 0) canopy.push(i);
  }
  const ref = (name: string) => { const r = (cpu as unknown as Record<string, Float32Array | Float32Array[]>)[name.replace(/\d$/, "")]; return Array.isArray(r) ? r[Number(name.at(-1))] : (r as Float32Array); };
  const lines: string[] = [];

  // The open ground is the same everywhere; the fields the carbon cannot reach match on all land, and on peat so do all
  // but the nitrogen.
  for (const [name, f] of names(a)) {
    const base = name.replace(/\d$/, "");
    const upstream = UPSTREAM.includes(base);
    if (upstream) { const { max, mean } = stats(f, ref(name), land); lines.push(`${name} (all land) max ${max.toExponential(2)} mean ${mean.toExponential(2)}`); expect(max, `${label} ${name}`).toBeLessThanOrEqual(TOL[base]); }
    if (base !== "nitrogen") { const { max } = stats(f, ref(name), peat, name === "fieldLight" ? cpu.field : undefined); expect(max, `${label} ${name} on peat`).toBeLessThanOrEqual(TOL[base]); }
  }
  // The cover and the soil's water move only by what the organic matter's change does to the water the soil holds.
  for (const name of ["tree", "shrub", "grass", "marsh", "bare", "field", "moist", "soilWater0", "soilWater1", "soilWater2", "soilWater3"]) {
    const { mean } = stats(names(a).find(([n]) => n === name)![1], ref(name), land);
    lines.push(`${name} mean move ${mean.toExponential(2)}`);
    expect(mean, `${label} ${name} mean move`).toBeLessThan(name.startsWith("soilWater") ? WATER_MOVE : MEAN_MOVE);
  }

  // The leaf display: the float law's, nothing in winter, never over 1.
  let leafMax = 0;
  for (const i of land) {
    const T = [0, 1, 2, 3].map((k) => site.seasons[k].temp[i]), H = [0, 1, 2, 3].map((k) => site.seasons[k].humid[i]), want = leafFactors(T, H);
    for (let k = 0; k < 4; k++) {
      leafMax = Math.max(leafMax, Math.abs(leaf[k][i] - want[k]));
      expect(leaf[k][i], `${label} leaf${k} in range`).toBeLessThanOrEqual(1 + LEAF_TOL);
    }
    expect(leaf[3][i], `${label} leaf3, no day of winter reaches 10 h`).toBe(0);
  }
  lines.push(`leaf vs float law max ${leafMax.toExponential(2)}`);
  expect(leafMax, `${label} leaf display`).toBeLessThanOrEqual(LEAF_TOL);

  // A broadleaf canopy's soil input against the float stage's: the nitrogen is 1000 times it times the turnover, so the
  // ratio of the two stages' nitrogen is the input's. Each plant of the canopy takes the same p, 0.5 (growth.ts pOf).
  const wet = (f: Float32Array[], i: number, k: number) => watered(f[k][i], 0.5);
  const errs: number[] = [], less: boolean[] = [];
  for (const i of canopy) {
    let made = 0, was = 0;
    for (let k = 0; k < 4; k++) { const sun = site.seasons[k].sun[i]; made += sun * leaf[k][i] * wet(a.soilWater, i, k); was += sun * warmEnough(site.seasons[k].temp[i]) * wet(cpu.soilWater, i, k); }
    const expected = (SOIL_SHARE * made) / was, got = a.nitrogen[i] / cpu.nitrogen[i];
    errs.push(Math.abs(got - expected) / expected);
    less.push(a.carbon[i] < cpu.carbon[i] && a.organic[i] <= cpu.organic[i]);
  }
  const med = quantile(errs, 0.5), p90 = quantile(errs, 0.9);
  lines.push(`canopy cells ${canopy.length}: nitrogen ratio vs expected, median ${med.toExponential(2)}, p90 ${p90.toExponential(2)}; less carbon on ${less.filter(Boolean).length}`);
  expect(canopy.length, `${label} canopy cells`).toBeGreaterThan(100);
  // the rest of a canopy's ground (shrubs and herbs in the gaps) is not scaled by the share and is not the same plants
  expect(med, `${label} canopy input, median`).toBeLessThan(0.02);
  expect(p90, `${label} canopy input, p90`).toBeLessThan(0.08);
  // a canopy's soil carbon and organic matter are less than the crop's, as its input is
  expect(less.every(Boolean), `${label} canopy carbon below the float stage's`).toBe(true);

  // RothC's steady state is linear in the input: carbon less its inert part over the nitrogen is the float stage's where
  // the cover, which the ratio's decay rates are made from, is the same.
  const active = (toc: number) => toc - 0.049 * toc ** 1.139;
  const ratios: number[] = [];
  for (const i of land) {
    if (cpu.peat[i] > 0 || !(cpu.nitrogen[i] > 0.5) || !(a.nitrogen[i] > 0.5)) continue;
    if (!["tree", "shrub", "grass", "marsh"].every((n) => Math.abs((a as unknown as Record<string, Float32Array>)[n][i] - (cpu as unknown as Record<string, Float32Array>)[n][i]) < 1e-3)) continue;
    const r = active(a.carbon[i]) / a.nitrogen[i], r0 = active(cpu.carbon[i]) / cpu.nitrogen[i];
    ratios.push(Math.abs(r / r0 - 1));
  }
  lines.push(`carbon over nitrogen against the float stage's: ${ratios.length} cells, median ${quantile(ratios, 0.5).toExponential(2)}, p99 ${quantile(ratios, 0.99).toExponential(2)}`);
  expect(ratios.length, `${label} cells of the same cover`).toBeGreaterThan(1000);
  // the ratio is a property of the cover, clay and climate alone: only the fixed point's rounding is left
  expect(quantile(ratios, 0.5), `${label} carbon over nitrogen, median`).toBeLessThan(1e-4);
  expect(quantile(ratios, 0.99), `${label} carbon over nitrogen, p99`).toBeLessThan(1e-3);

  console.log(`${label}: ${ms.toFixed(1)} ms\n  ${lines.join("\n  ")}`);
}

for (const seed of [1, 2, 3]) test(`ground on island ${seed}`, async () => { await check(`island ${seed}`, island(seed)); }, 300_000);

test("ground with sand coasts and limestone", async () => {
  const site = island(1);
  const rock = site.rock.slice();
  for (let i = 0; i < LEN; i++) rock[i] = [SANDSTONE, LIMESTONE, MUDSTONE][(Math.floor((i % 256) / 40) + Math.floor(i / 256 / 40)) % 3];
  await check("rearranged rock", { ...site, rock });
}, 300_000);
