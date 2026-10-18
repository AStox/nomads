// The ground kernels (wgsl/terrain-ground.ts) on the Site islands 1 to 3 give them (the generator's own climate and water,
// made on the GPU), the same words on a second run, and one island's time. One case a seed (the island takes some 10 s to
// make), plus one on seed 1 with its rock rearranged so the beaches, limestone and mudstone pH classes and the sand coast
// all occur, which the Bornholm islands' crystalline coasts do not give.
//
// The kernels are the one implementation of the stage, so each case checks what any correct run must show and pins what
// this one does:
// - the fields are in bounds, open water is the sea or a lake's floor (bare, all the soil's water, nothing else), and the
//   cover's shares fill the ground;
// - beach sand lies only on sediment coasts below the storm waves' reach, alluvium only on floodplain, and peat exactly
//   where the dry-season water table stays in the acrotelm and there is no beach, at the bog's depth, all organic matter;
// - the fertility is the soil's own, a function of its clay alone, and the plants' carbon follows RothC's steady state,
//   whose active part is linear in the input: carbon less its inert part, over the nitrogen the same input makes, is
//   the decay-rate sum that the cover, the clay and the climate fix;
// - each season's leaf display is the float law's (terrain-phenology.ts leafFactors) within the fixed point's error, is
//   nothing in winter (no day reaches 10 h), and is never over 1;
// - a golden hash of every output (see GOLDEN).
import { afterAll, expect, test } from "bun:test";
import { rng } from "../../sim/world";
import { LEN } from "../../terrain/grid";
import { ACROTELM, CARBON, CARBONATE, CN_BIO, CN_HUM, DPM_RPM, EXCHANGER, K_BIO, K_DPM, K_HUM, K_RPM, MOR, N_PLANT, PEAT_A, PEAT_P, PEAT_RHO, RUNUP, SILICATE, TOPSOIL, AGE, type Ground, type Site } from "../../terrain/ground";
import { LIMESTONE, MUDSTONE, SANDSTONE, crystalline } from "../../terrain/geology";
import { releaseGpu, theGpu } from "../device";
import { leafFactors } from "../wgsl/terrain-phenology";
import { generateIsland } from "./island";
import { groundAndLeaf } from "./ground";

afterAll(releaseGpu);

// The hash (Bun.hash, hex) of every output's bytes (the Ground's fields in their order, then the four leaf displays) per
// case. It pins the kernels' integer arithmetic bit for bit, so any change to the ground model or its constants moves it.
// When the model changes on purpose, re-record these from the failure message, and say in the commit message why they
// moved.
const GOLDEN: Record<string, string> = { "island 1": "8f1c7a4b7b625a7b", "island 2": "4d2b1ed687c1121a", "island 3": "de04b717fff3d82b", "rearranged rock": "ddf7b7690883fea" };

// The leaf display's own error: Q16 inputs and Q24 sums over 364 days, against the float law.
const LEAF_TOL = 5e-4;

const names = (x: Ground) => Object.entries(x).flatMap(([k, v]) => (Array.isArray(v) ? v.map((f, s) => [`${k}${s}`, f] as const) : [[k, v] as const]));
const quantile = (xs: number[], q: number) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };

async function island(seed: number): Promise<Site> {
  const isle = await generateIsland(rng(seed), await theGpu());
  return { ...isle, open: Uint8Array.from(isle.water, (w) => (w > 0 ? 1 : 0)) };
}

function digest(ground: Ground, leaf: Float32Array[]): string {
  const bytes = [...names(ground).map(([, f]) => f), ...leaf].map((f) => Buffer.from(f.buffer, f.byteOffset, f.byteLength));
  return Bun.hash(Buffer.concat(bytes)).toString(16);
}

async function check(label: string, site: Site) {
  const g = await theGpu();
  await groundAndLeaf(g, site); // the pipelines compile on first use
  const t0 = performance.now();
  const { ground: a, leaf } = await groundAndLeaf(g, site);
  const ms = performance.now() - t0;
  const { ground: b, leaf: leafB } = await groundAndLeaf(g, site);
  const bs = new Map(names(b));
  for (const [name, f] of names(a)) expect(Buffer.from(f.buffer).equals(Buffer.from(bs.get(name)!.buffer)), `${label} ${name} run to run`).toBe(true);
  leaf.forEach((f, k) => expect(Buffer.from(f.buffer).equals(Buffer.from(leafB[k].buffer)), `${label} leaf${k} run to run`).toBe(true));

  const lines: string[] = [];
  const unit = ["silt", "sand", "sandy", "clayey", "fertility", "moist", "tree", "shrub", "grass", "marsh", "bare", "field", "fieldLight", "soilWater0", "soilWater1", "soilWater2", "soilWater3"];
  for (const [name, f] of names(a)) {
    expect(f.every(Number.isFinite), `${label} ${name} finite`).toBe(true);
    if (unit.includes(name)) expect(f.every((v) => v >= 0 && v <= 1), `${label} ${name} in 0 to 1`).toBe(true);
  }
  expect(a.organic.every((v) => v >= 0 && v <= 100) && a.soil.every((v) => v >= 0) && a.peat.every((v) => v >= 0) && a.carbon.every((v) => v >= 0) && a.nitrogen.every((v) => v >= 0), `${label} soil in bounds`).toBe(true);
  expect(a.ph.every((v, i) => site.open[i] ? v === 0 : v >= MOR - 1e-3 && v <= CARBONATE + 1e-3), `${label} pH between the mor's and the limestone's`).toBe(true);
  expect(a.silt.every((v) => v === 0 || v === 1) && a.sand.every((v) => v === 0 || v === 1), `${label} silt and sand are 0 or 1`).toBe(true);

  // open water is bare and holds all its soil's water, with nothing else
  const quiet = ["soil", "silt", "sand", "peat", "sandy", "clayey", "carbon", "organic", "nitrogen", "ph", "fertility", "moist", "tree", "shrub", "grass", "marsh", "field", "fieldLight"] as const;
  const land: number[] = [], peat: number[] = [], rich: number[] = [];
  let shares = 0, closure = 0, beaches = 0, alluvium = 0;
  const peatDepth = ((PEAT_P / PEAT_A) * (1 - Math.exp(-PEAT_A * AGE))) / 1000 / PEAT_RHO;
  for (let i = 0; i < LEN; i++) {
    if (site.open[i]) {
      expect(a.bare[i], `${label} open cell ${i} bare`).toBe(1);
      for (let k = 0; k < 4; k++) expect(a.soilWater[k][i], `${label} open cell ${i} soil water`).toBe(1);
      for (const n of quiet) expect(a[n][i], `${label} open cell ${i} ${n}`).toBe(0);
      continue;
    }
    land.push(i);
    const cover = a.tree[i] + a.shrub[i] + a.marsh[i] + a.grass[i] + a.bare[i] + a.sand[i];
    closure = Math.max(closure, Math.abs(cover - 1));
    shares = Math.max(shares, cover);

    // sand only on sediment coasts below the storm waves' reach, alluvium only on floodplain
    if (a.sand[i]) { beaches++; expect(site.height[i] <= RUNUP && !crystalline(site.rock[i]), `${label} beach sand at cell ${i}`).toBe(true); }
    if (a.silt[i]) { alluvium++; expect(site.valley[i], `${label} alluvium at cell ${i} is on floodplain`).toBeGreaterThan(0); }

    // peat where the dry-season table stays in the acrotelm and there is no beach; cells within the input's rounding of the
    // threshold are not decided here
    const edge = Math.abs(site.dryTable[i] - ACROTELM) < 3e-5;
    if (!edge) expect(a.peat[i] > 0, `${label} cell ${i} peat where the water table stays in the acrotelm`).toBe(site.dryTable[i] <= ACROTELM && !a.sand[i]);
    if (a.peat[i] > 0) {
      peat.push(i);
      expect(a.peat[i], `${label} cell ${i} peat's depth`).toBeCloseTo(peatDepth, 3);
      expect(a.organic[i], `${label} cell ${i} peat is all organic`).toBeCloseTo(100, 3);
      expect(a.carbon[i], `${label} cell ${i} peat carbon`).toBeCloseTo(PEAT_RHO * Math.min(TOPSOIL, a.peat[i]) * 10 * CARBON, 2);
    } else if (a.nitrogen[i] > 0.5) rich.push(i);

    // fertility is the soil's own: the biomass and humus turning over, from its clay alone
    const clay = a.clayey[i] * 100, x = 1.67 * (1.85 + 1.6 * Math.exp(-0.0786 * clay)), e = 1 / (1 + x);
    const turnover = (e / (1 - e)) * (0.46 / CN_BIO + 0.54 / CN_HUM);
    expect(a.fertility[i], `${label} cell ${i} fertility`).toBeCloseTo(Math.min(1, Math.max(0, (turnover * CARBON) / N_PLANT)), 3);
  }
  lines.push(`${land.length} land cells: cover shares sum to within ${closure.toExponential(2)} of 1 (most ${shares.toFixed(6)}); ${peat.length} peat, ${beaches} beach, ${alluvium} alluvium`);
  expect(closure, `${label} cover closure`).toBeLessThan(1e-4);

  // RothC's steady state is linear in the input: the plants' carbon less its inert part (0.049 TOC^1.139), over the nitrogen
  // that input makes (1000 times it times the turnover), is the sum of the decay times, which the cover, the clay and the
  // climate fix. The cover's ratio of decomposable to resistant matter is from its trees' share of the plants.
  const active = (toc: number) => toc - 0.049 * toc ** 1.139;
  const ratios: number[] = [];
  for (const i of rich) {
    const clay = a.clayey[i] * 100, x = 1.67 * (1.85 + 1.6 * Math.exp(-0.0786 * clay)), e = 1 / (1 + x);
    const turnover = (e / (1 - e)) * (0.46 / CN_BIO + 0.54 / CN_HUM);
    const veg = a.tree[i] + a.shrub[i] + a.marsh[i] + a.grass[i];
    if (veg <= 0) continue;
    const most = -(20 + 1.3 * clay - 0.01 * clay * clay);
    let deficit = 0, m = 0;
    for (let year = 0; year < 2; year++)
      for (let k = 0; k < 4; k++) {
        const { precip, pet, temp } = site.seasons[k];
        deficit = Math.min(0, Math.max(most, deficit + precip[i] - pet[i]));
        if (!year) continue;
        const warmth = 47.91 / (1 + Math.exp(106.06 / (temp[i] + 18.27)));
        const dry = deficit > 0.444 * most ? 1 : 0.2 + (0.8 * (most - deficit)) / (most - 0.444 * most);
        m += (warmth * dry * (0.6 * veg + (1 - veg))) / 4;
      }
    const ratio = (a.tree[i] * DPM_RPM.tree + (veg - a.tree[i]) * DPM_RPM.open) / veg, f = ratio / (1 + ratio);
    const per = (f / K_DPM + (1 - f) / K_RPM + (e / (1 - e)) * (0.46 / K_BIO + 0.54 / K_HUM)) / m / (1000 * turnover);
    ratios.push(Math.abs(active(a.carbon[i]) / a.nitrogen[i] / per - 1));
  }
  lines.push(`carbon over nitrogen against RothC's steady state: ${ratios.length} cells, median ${quantile(ratios, 0.5).toExponential(2)}, p99 ${quantile(ratios, 0.99).toExponential(2)}`);
  expect(ratios.length, `${label} cells with a steady state`).toBeGreaterThan(1000);
  // only the fixed point's rounding is left
  expect(quantile(ratios, 0.5), `${label} carbon over nitrogen, median`).toBeLessThan(1e-4);
  expect(quantile(ratios, 0.99), `${label} carbon over nitrogen, p99`).toBeLessThan(1e-3);

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

  const hash = digest(a, leaf);
  lines.push(`golden ${hash}`);
  console.log(`${label}: ${ms.toFixed(1)} ms\n  ${lines.join("\n  ")}`);
  expect(hash, `${label} golden, re-record deliberately`).toBe(GOLDEN[label]);
  return a;
}

for (const seed of [1, 2, 3]) test(`ground on island ${seed}`, async () => { await check(`island ${seed}`, await island(seed)); }, 300_000);

test("ground with sand coasts and limestone", async () => {
  const site = await island(1);
  const rock = site.rock.slice();
  for (let i = 0; i < LEN; i++) rock[i] = [SANDSTONE, LIMESTONE, MUDSTONE][(Math.floor((i % 256) / 40) + Math.floor(i / 256 / 40)) % 3];
  const a = await check("rearranged rock", { ...site, rock });
  // the beaches, and the limestone's and the base-rich silicates' pH classes, occur
  expect(a.sand.some((v) => v === 1), "beach sand occurs").toBe(true);
  expect(a.ph.some((v) => v >= CARBONATE - 1e-3), "limestone's pH class occurs").toBe(true);
  expect(a.ph.some((v) => Math.abs(v - SILICATE) < 1e-3), "mudstone's pH class occurs").toBe(true);
  expect(a.ph.some((v) => Math.abs(v - EXCHANGER) < 1e-3), "the exchanger's pH class occurs").toBe(true);
}, 300_000);
