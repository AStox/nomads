// The island's 3 m ground and everything on it as GPU kernels (wgsl/terrain-scenery.ts): the stream mask, the fine field,
// every tree, bush and low plant, the loose ore, and the clasts' counts, on the islands 1 to 3, with their laws against the
// float functions they port, the same bytes on a second run, and a golden hash of every output.
//
// The kernels are the one implementation (the CPU fineGround, scatter and clasts are deleted), so each case checks what any
// correct run must show and pins what this one does:
// - the fine field's wetness is a multiple of a sixteenth, its covers fill the ground, and its heights, covers and
//   moisture are the float law's at sampled vertices (the cubic through the cells, the ground swell, the covers' wander,
//   read here by flora.ts's own noise and bilinear);
// - the stream mask holds every stream's line and nothing away from one;
// - the objects lie each in the tile whose run holds it, none under standing water or in a stream bed (flora.ts waterAt
//   and riverSmooth), stems only on dry ground and trees only where soil lies, stems' sizes are whole millimetres within
//   their kind's tallest, and the tussocks, reeds and loose ore are as many as their densities say (the sum over the
//   quads of the expected count, less what the water and stream tests turn away; the CPU scatter that was here made the
//   same totals within noise, docs/research/generator/2026-10-18-scenery.md sec. 4);
// - the clasts are Poisson (their variance is their mean, their total the mean's within noise), and none on the sea or a lake;
// - the integer laws (a stem's height and crown, the noise, each plant's fit and compensation point) against flora.ts,
//   niche.ts and growth.ts, which stay as the float laws.
import { afterAll, expect, test } from "bun:test";
import { rng } from "../../sim/world";
import { CELL, LEN } from "../../terrain/grid";
import { TREE_MAX, fit } from "../../terrain/niche";
import { SLA, pOf, yearComp } from "../../terrain/growth";
import { FLORA, K, M, PLANTS, RM, SIZE, SPECIES, STEP, START, TILES, TILE_M, bushHeight, crownShare, fbm, noise, riverSmooth, smooth, standHeight, toMm, treeHeight, waterAt, type Fine, type Scatter } from "../../terrain/flora";
import { releaseGpu, theGpu } from "../device";
import { BOULDERS_HA, CLASTS, CLAST_DIM } from "../deadwood";
import { generateIsland } from "./island";
import { clasts, lawsGpu, sceneryGpu, tablesGpu, type SceneryIsland } from "./scenery";

afterAll(releaseGpu);

// The hash (Bun.hash, hex) per island of every output's bytes: the fine field's arrays and mask, then the Scatter's arrays
// in their order and its ore (scenery), and the clasts' three counts (clasts). Each pins the kernels' integer arithmetic and
// the draws bit for bit, so any change to the scenery moves it, and so does any change to the island under it (the
// generator's own stages). When the model or the island changes on purpose, re-record these from the failure message, and
// say in the commit message why they moved.
const GOLDEN: Record<string, { scenery: string; clasts: string }> = {
  "island 1": { scenery: "eb2a09ded5988469", clasts: "5c481987b98a0392" },
  "island 2": { scenery: "c3869bb03cf362ba", clasts: "886ecfbf3b2cd03c" },
  "island 3": { scenery: "9959152ec0252928", clasts: "43a0ad2afc750ed4" },
};
const islands = new Map<number, Promise<SceneryIsland & { height: Float32Array; water: Float32Array; drift: Uint8Array; soil: Float32Array }>>();
const island = (seed: number) => {
  if (!islands.has(seed)) islands.set(seed, theGpu().then((g) => generateIsland(rng(seed), g)) as never);
  return islands.get(seed)!;
};

const buffer = (f: ArrayBufferView) => Buffer.from(f.buffer, f.byteOffset, f.byteLength);
function digest(fine: Fine, flora: Scatter): string {
  const fields = [fine.h, fine.wet, fine.river, fine.moist, ...Object.values(fine.cover), fine.mask, flora.start, flora.kind, flora.species, flora.px, flora.py, flora.size, flora.seed];
  return Bun.hash(Buffer.concat([...fields.map(buffer), Buffer.from(JSON.stringify(flora.ore))])).toString(16);
}
const quantile = (xs: ArrayLike<number>, q: number) => { const s = Float64Array.from(xs).sort(); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };

async function sceneryCase(label: string, seed: number) {
  const isle = await island(seed), g = await theGpu();
  await sceneryGpu(g, isle, seed); // the pipelines compile on first use
  const t0 = performance.now();
  const { fine, flora } = await sceneryGpu(g, isle, seed);
  const ms = performance.now() - t0;
  const again = await sceneryGpu(g, isle, seed);
  const hash = digest(fine, flora);
  const lines: string[] = [];
  expect(digest(again.fine, again.flora), `${label} run to run`).toBe(hash);
  // a second seed draws other objects of the same laws on the same island
  const other = await sceneryGpu(g, isle, seed + 1000);
  expect(digest(other.fine, other.flora), `${label} another seed's draws`).not.toBe(hash);
  expect(Math.abs(other.flora.n / flora.n - 1), `${label} another seed's count`).toBeLessThan(0.002);
  expect(Buffer.from(other.fine.h.buffer).equals(Buffer.from(fine.h.buffer)), `${label} the fine field does not depend on the seed`).toBe(true);

  // ---------- the fine field ----------
  const fields = [fine.h, fine.wet, fine.river, fine.moist, ...Object.values(fine.cover)];
  for (const f of fields) expect(f.every(Number.isFinite), `${label} finite`).toBe(true);
  expect(fine.wet.every((v) => v * 16 === Math.round(v * 16) && v >= 0 && v <= 1), `${label} wetness is a multiple of a sixteenth`).toBe(true);
  for (const [name, f] of Object.entries(fine.cover)) expect(f.every((v) => v >= 0 && v <= 1), `${label} ${name} in 0 to 1`).toBe(true);
  let closure = 0;
  for (let i = 0; i < M * M; i++) {
    let s = 0;
    for (const f of Object.values(fine.cover)) s += f[i];
    if (s > 0) closure = Math.max(closure, Math.abs(s - 1));
  }
  expect(closure, `${label} the covers fill the ground`).toBeLessThan(1e-5);
  // heights, covers and moisture at sampled vertices against the float law (away from streams, where the bed is cut by
  // the mask's own rounding)
  const wetC = Float32Array.from(isle.water, (w) => (w > 0 ? 1 : 0)), covers = ["tree", "shrub", "grass", "marsh", "bare", "sand"] as const;
  let dh = 0, dc = 0, dm = 0, sampled = 0;
  for (let i = 0; i < M * M; i += 97) {
    const u = i % M, v = (i - u) / M, x = START + u * STEP, z = START + v * STEP;
    const tx = 8 + 4 * u, ty = 8 + 4 * v;
    if (fine.mask[ty * RM + tx] !== 0) continue;
    sampled++;
    const base = fine.bicubic(isle.height, u / K, v / K), wf = fine.bilinear(wetC, u / K, v / K);
    const want = base + smooth(-2, 6, base) * (1 - wf) * (2.6 * fbm(x / 240, z / 240, 7, 3) + 0.8 * fbm(x / 60, z / 60, 8, 2));
    dh = Math.max(dh, Math.abs(fine.h[i] - want));
    dm = Math.max(dm, Math.abs(fine.moist[i] - fine.bilinear(isle.moist, u / K, v / K)));
    const share = covers.map((c, n) => Math.max(0, fine.bilinear((isle as never as Record<string, Float32Array>)[c], u / K, v / K) * (1 + 0.85 * fbm(x / 150, z / 150, 40 + n, 2))));
    const sum = share.reduce((a, b) => a + b, 0);
    covers.forEach((c, n) => { dc = Math.max(dc, Math.abs(fine.cover[c][i] - (sum > 0 ? share[n] / sum : share[n]))); });
  }
  lines.push(`fine field at ${sampled} sampled vertices off the streams: height ${dh.toExponential(2)} m, covers ${dc.toExponential(2)}, moisture ${dm.toExponential(2)}`);
  expect(dh, `${label} height`).toBeLessThan(5e-5);
  expect(dc, `${label} covers`).toBeLessThan(5e-6);
  expect(dm, `${label} moisture`).toBeLessThan(5e-7);

  // ---------- the stream mask ----------
  const px = (x: number) => ((x + SIZE / 2) / SIZE) * RM, points = new Map<number, number[][]>();
  for (const line of fine.rivers) for (const p of line) { const key = Math.floor(px(p[1]) / 4) * 4096 + Math.floor(px(p[0]) / 4); (points.get(key) ?? points.set(key, []).get(key)!).push([px(p[0]), px(p[1])]); }
  let lowest = 255, strokes = 0, far = 0;
  for (const line of fine.rivers)
    for (let k = 1; k < line.length; k++) {
      const x = px((line[k - 1][0] + line[k][0]) / 2), y = px((line[k - 1][1] + line[k][1]) / 2);
      lowest = Math.min(lowest, fine.mask[Math.min(RM - 1, Math.floor(y)) * RM + Math.min(RM - 1, Math.floor(x))]);
      strokes++;
    }
  for (let t = 0; t < RM * RM; t++) {
    if (!fine.mask[t]) continue;
    const x = (t % RM) + 0.5, y = Math.floor(t / RM) + 0.5;
    let near = false;
    for (let b = -1; b <= 1 && !near; b++) for (let a = -1; a <= 1 && !near; a++) for (const p of points.get((Math.floor(y / 4) + b) * 4096 + Math.floor(x / 4) + a) ?? []) if (Math.hypot(p[0] - x, p[1] - y) <= 3.5) { near = true; break; }
    if (!near) far++;
  }
  lines.push(`mask: ${strokes} segments, the least coverage at a segment's middle texel ${lowest}, ${far} covered texels farther than 3.5 texels from every line point`);
  expect(lowest, `${label} every stream's middle is covered`).toBeGreaterThanOrEqual(74);
  expect(far, `${label} nothing covered away from a stream`).toBe(0);
  expect(fine.rivers.length, `${label} lines`).toBe(isle.rivers.length);

  // ---------- the objects ----------
  expect(flora.start[0]).toBe(0);
  expect(flora.start[TILES * TILES], `${label} the last run ends at n`).toBe(flora.n);
  let monotone = true, wrong = 0;
  for (let t = 0; t < TILES * TILES; t++) {
    if (flora.start[t + 1] < flora.start[t]) monotone = false;
    for (let e = flora.start[t]; e < flora.start[t + 1]; e++) if (Math.min(TILES - 1, Math.floor(flora.py[e])) * TILES + Math.min(TILES - 1, Math.floor(flora.px[e])) !== t) wrong++;
  }
  expect(monotone, `${label} runs`).toBe(true);
  expect(wrong, `${label} entries outside their tile`).toBe(0);
  const counts: Record<string, number> = {};
  const trees = ["pine", "oak", "ash", "aspen"], shrubs = ["berry", "hazel", "heather"];
  let badKind = 0, badSize = 0, wet = 0, notDry = 0, noSoil = 0, looked = 0;
  const heights: Record<string, number[]> = {};
  for (let e = 0; e < flora.n; e++) {
    const kind = FLORA[flora.kind[e]], sp = SPECIES[flora.species[e]], key = sp ? `${kind}:${sp}` : kind;
    counts[key] = (counts[key] ?? 0) + 1;
    if ((kind === "tree" && !trees.includes(sp)) || (kind === "bush" && !shrubs.includes(sp)) || (sp === "" && !["reeds", "clay", "grass"].includes(kind))) badKind++;
    const size = flora.size[e];
    if (!(size > 0)) badSize++;
    const mm = Math.fround(Math.round(size * 1000) / 1000) === size;
    if (kind === "tree") { (heights[sp] ??= []).push(size); if (size > TREE_MAX[sp] + 1e-4 || !mm) badSize++; }
    if (kind === "bush" && !mm) badSize++;
    if (e % 53 === 0) {
      looked++;
      const x = flora.px[e] * TILE_M - SIZE / 2, z = flora.py[e] * TILE_M - SIZE / 2;
      if (waterAt(isle as never, fine, x, z) > 0.5 || riverSmooth(fine, x, z) > 0.5) wet++;
      if ((kind === "tree" || kind === "bush") && !fine.dry(x, z)) notDry++;
      if (kind === "tree" && !(fine.bilinear(isle.soil, (x - START) / CELL, (z - START) / CELL) > 0)) noSoil++;
    }
  }
  expect(badKind, `${label} kinds and species agree`).toBe(0);
  expect(badSize, `${label} sizes: positive, stems in whole millimetres under their tallest`).toBe(0);
  lines.push(`${flora.n} entries; of ${looked} looked at: ${wet} under water or on a stream, ${notDry} stems not dry, ${noSoil} trees on no soil`);
  expect(wet, `${label} under standing water or in a stream bed`).toBeLessThanOrEqual(Math.ceil(looked / 1e5) * 2);
  expect(notDry, `${label} stems on dry ground`).toBeLessThanOrEqual(Math.ceil(looked / 1e5) * 2);
  expect(noSoil, `${label} trees where soil lies`).toBe(0);
  for (const sp of trees) {
    const h = heights[sp], mid = quantile(h, 0.5);
    expect(mid, `${label} ${sp}'s median stem between the stand heights' halves and its tallest`).toBeGreaterThan(0.5 * standHeight(sp, 0));
    expect(mid).toBeLessThan(TREE_MAX[sp]);
  }
  // the densities: floor(x + u) a quad has mean x, so the tussocks, reeds and bog iron are as many as the sum of x over the
  // quads, less what the dry, water and stream tests turn away (little for tussocks, which stand on dry ground; a few
  // percent of the reeds and ore, which stand at the water's edge)
  let tussocks = 0, reeds = 0, ore = 0;
  for (let v = 0; v < M - 1; v++)
    for (let u = 0; u < M - 1; u++) {
      const i = v * M + u, h = fine.h[i], wetShare = fine.wet[i];
      if (!(h > -0.5 && wetShare < 0.8)) continue;
      const edge = wetShare > 0.05 || fine.river[i] > 0.2 ? 1 : 0;
      reeds += fine.cover.marsh[i] * 1.1 + edge * (0.5 - fine.cover.sand[i] * 0.4);
      if (wetShare > 0.3 || h < 0.8) continue;
      const tree = fine.cover.tree[i], clump = Math.max(0, Math.min(1.7, 0.35 + 1.3 * noise((START + u * STEP) / 45, (START + v * STEP) / 45, 91)));
      tussocks += (fine.cover.grass[i] * (1 - tree) * 20 + tree * (1 - tree) * 4 * 3.75) * clump;
      ore += fine.cover.marsh[i] * 0.04;
    }
  lines.push(`tussocks ${counts.grass} of ${tussocks.toFixed(0)} expected, reeds ${counts.reeds} of ${reeds.toFixed(0)}, bog iron ${flora.ore.length} of ${ore.toFixed(0)}`);
  expect(counts.grass / tussocks, `${label} tussocks`).toBeGreaterThan(0.985);
  expect(counts.grass, `${label} tussocks`).toBeLessThan(tussocks + 5 * Math.sqrt(tussocks));
  expect(counts.reeds / reeds, `${label} reeds`).toBeGreaterThan(0.9);
  expect(counts.reeds, `${label} reeds`).toBeLessThan(reeds + 5 * Math.sqrt(reeds));
  expect(flora.ore.length / ore, `${label} bog iron`).toBeGreaterThan(0.9);
  expect(flora.ore.length, `${label} bog iron`).toBeLessThan(ore + 5 * Math.sqrt(ore));
  expect(flora.ore.every((o) => o.size > 0.15 - 1e-6 && o.size < 0.35 && o.px >= 0 && o.px < TILES && o.py >= 0 && o.py < TILES), `${label} ore`).toBe(true);

  // the first view of a stand: stems' heights against the stand's cited heights
  for (const sp of trees) lines.push(`${sp}: ${quantile(heights[sp], 0.1).toFixed(1)} / ${quantile(heights[sp], 0.5).toFixed(1)} / ${quantile(heights[sp], 0.9).toFixed(1)} m (10, 50, 90%)`);
  lines.push(`golden ${hash}`);
  console.log(`${label}: ${ms.toFixed(0)} ms (fine field and objects)\n  ${lines.join("\n  ")}`);
  expect(hash, `${label} golden, re-record deliberately`).toBe(GOLDEN[label].scenery);
  return hash;
}

async function clastCase(label: string, seed: number) {
  const isle = await island(seed), g = await theGpu(), bounds = CLASTS.map((c) => [c.lo / 1000, c.hi / 1000] as const);
  await clasts(g, isle, seed, BOULDERS_HA, CLAST_DIM, bounds);
  const t0 = performance.now();
  const out = await clasts(g, isle, seed, BOULDERS_HA, CLAST_DIM, bounds), ms = performance.now() - t0;
  const again = await clasts(g, isle, seed, BOULDERS_HA, CLAST_DIM, bounds);
  out.forEach((c, k) => expect(Buffer.from(c.buffer).equals(Buffer.from(again[k].buffer)), `${label} clasts ${k} run to run`).toBe(true));
  const hash = Bun.hash(Buffer.concat(out.map(buffer))).toString(16);
  // none on the sea or a lake's bed, none where the drift holds none (sorted meltwater sand, peat), and in each cell a
  // Poisson draw: the squared deviation from its mean over the mean is 1 on average
  const ha = (CELL * CELL) / 1e4, lo = bounds[bounds.length - 1][0], lines: string[] = [];
  out.forEach((c, k) => {
    let total = 0, spread = 0, cells = 0, bad = 0, mean = 0;
    for (let i = 0; i < LEN; i++) {
      total += c[i];
      const lam = BOULDERS_HA[isle.drift[i]] * ha * ((bounds[k][0] / lo) ** -CLAST_DIM - (bounds[k][1] / lo) ** -CLAST_DIM);
      if (isle.water[i] > 0 || isle.height[i] < 0 || lam === 0) { if (c[i] !== 0) bad++; continue; }
      cells++;
      mean += lam;
      spread += (c[i] - lam) ** 2 / lam;
    }
    expect(bad, `${label} ${CLASTS[k].kind} on the sea, a lake or a drift that holds none`).toBe(0);
    lines.push(`${CLASTS[k].kind}: ${total} against a mean of ${mean.toFixed(0)} (${((total / mean - 1) * 1e4).toFixed(2)} per 10^4), dispersion ${(spread / cells).toFixed(3)} over ${cells} cells`);
    expect(Math.abs(total / mean - 1), `${label} ${CLASTS[k].kind} total against its mean`).toBeLessThan(5 / Math.sqrt(mean) + 1e-5);
    expect(Math.abs(spread / cells - 1), `${label} ${CLASTS[k].kind} dispersion`).toBeLessThan(0.03);
  });
  lines.push(`golden ${hash}`);
  console.log(`${label} clasts: ${ms.toFixed(0)} ms\n  ${lines.join("\n  ")}`);
  expect(hash, `${label} clasts golden, re-record deliberately`).toBe(GOLDEN[label].clasts);
}

for (const seed of [1, 2, 3]) {
  test(`the 3 m ground and its objects on island ${seed}`, async () => { await sceneryCase(`island ${seed}`, seed); }, 300_000);
  test(`the clasts' counts on island ${seed}`, async () => { await clastCase(`island ${seed}`, seed); }, 300_000);
}

// A stem's height by its fit and the Weibull quantile of a word, and its crown, against flora.ts, over a grid of fits and
// quantiles with the tails; a bush's height; the noise; and every cell's fit and compensation point.
test("the integer laws against the float functions they port", async () => {
  const g = await theGpu(), rows: number[][] = [], want: number[] = [];
  for (let p = 0; p < 4; p++)
    for (const f of [0.02, 0.1, 0.3, 0.5, 0.75, 1])
      for (let j = 0; j < 400; j++) {
        const u = Math.min(0xffffffff, Math.floor(((j + 0.5) / 400) ** 2 * 2 ** 32)) >>> 0, q = Math.round(f * 2 ** 24);
        rows.push([0, p, q, u]);
        want.push(Math.round(toMm(treeHeight(PLANTS[p], q / 2 ** 24, u / 2 ** 32)) * 1000));
      }
  for (let p = 0; p < 4; p++) for (const u of [0, 1, 2, 100, 0xfffffff0, 0xfffffffe, 0xffffffff]) { rows.push([0, p, 2 ** 24, u]); want.push(Math.round(toMm(treeHeight(PLANTS[p], 1, u / 2 ** 32)) * 1000)); }
  const trees = rows.length;
  for (let p = 4; p < 7; p++)
    for (const f of [0, 0.1, 0.5, 1])
      for (let j = 0; j < 200; j++) { const u = Math.floor(((j + 0.5) / 200) * 2 ** 32) >>> 0; rows.push([2, p, Math.round(f * 2 ** 24), u]); want.push(Math.round(toMm(bushHeight(PLANTS[p], Math.round(f * 2 ** 24) / 2 ** 24, u / 2 ** 32)) * 1000)); }
  const bushes = rows.length;
  const crownWant: number[] = [];
  for (let p = 0; p < 7; p++) for (let mm = 1; mm <= (p < 4 ? 42000 : 8000); mm = Math.ceil(mm * 1.03)) { rows.push([1, p, mm, 0]); crownWant.push(crownShare(PLANTS[p], mm / 1000)); }
  const crowns = rows.length;
  let s = 12345;
  const rnd = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 2 ** 32; };
  const noiseWant: number[] = [], fbmWant: number[] = [];
  for (let j = 0; j < 2000; j++) {
    const X4 = Math.floor(rnd() * 76500 - 38250), Z4 = Math.floor(rnd() * 76500 - 38250), x = Math.round((X4 / 4 / 240) * 2 ** 20), z = Math.round((Z4 / 4 / 240) * 2 ** 20);
    rows.push([3, 7, x, z]); noiseWant.push(noise(x / 2 ** 20, z / 2 ** 20, 7));
    rows.push([4, 7, X4, Z4]); fbmWant.push(fbm(X4 / 4 / 240, Z4 / 4 / 240, 7, 3));
  }
  const got = await lawsGpu(g, rows);
  const miss = (a: number, b: number, from: number, to: number) => { let m = 0; for (let i = from; i < to; i++) m = Math.max(m, Math.abs(got[i] - want[i])); return m; };
  const dTree = miss(0, 0, 0, trees), dBush = miss(0, 0, trees, bushes);
  let exact = 0;
  for (let i = 0; i < trees; i++) if (got[i] === want[i]) exact++;
  let dCrown = 0, rCrown = 0;
  crownWant.forEach((w, i) => { const v = got[bushes + i] / 65536; dCrown = Math.max(dCrown, Math.abs(v - w)); if (w > 0.01) rCrown = Math.max(rCrown, Math.abs(v / w - 1)); });
  let dNoise = 0, dFbm = 0;
  for (let j = 0; j < 2000; j++) { dNoise = Math.max(dNoise, Math.abs((got[crowns + 2 * j] | 0) / 2 ** 24 - noiseWant[j])); dFbm = Math.max(dFbm, Math.abs((got[crowns + 2 * j + 1] | 0) / 2 ** 24 - fbmWant[j])); }
  console.log(`laws: tree height max ${dTree} mm (${((100 * exact) / trees).toFixed(0)}% exact over ${trees} stems, tails to 2e-10 of the quantile), bush ${dBush} mm, crown ${dCrown.toExponential(2)} m2 (${rCrown.toExponential(2)} of a crown over 0.01 m2), noise ${dNoise.toExponential(2)}, fbm ${dFbm.toExponential(2)}`);
  expect(dTree, "a stem's height within a millimetre of the float law").toBeLessThanOrEqual(1);
  expect(dBush, "a bush's height within a millimetre").toBeLessThanOrEqual(1);
  expect(rCrown, "a crown's area").toBeLessThan(2e-3);
  expect(dNoise, "noise").toBeLessThan(5e-6);
  expect(dFbm, "fbm").toBeLessThan(1e-5);

  const isle = await island(1), { fit: F, comp: C } = await tablesGpu(g, isle);
  const sun = new Float32Array(4), temp = new Float32Array(4), water = new Float32Array(4), NS = PLANTS.length;
  let dFit = 0, dComp = 0, rComp = 0, zeros = 0;
  for (let i = 0; i < LEN; i++) {
    if (isle.height[i] < -2) { for (let k = 0; k < NS; k++) if (F[i * NS + k] !== 0 || C[i * NS + k] !== 0) zeros++; continue; }
    for (let q = 0; q < 4; q++) { sun[q] = isle.seasons[q].sun[i]; temp[q] = isle.seasons[q].temp[i]; water[q] = isle.soilWater[q][i]; }
    for (let k = 0; k < NS; k++) {
      const f = fit(PLANTS[k], { ph: (isle as never as { ph: Float32Array }).ph[i], table: (isle as never as { winterTable: Float32Array }).winterTable[i], light: NaN, wind: NaN, salt: NaN, soil: NaN }), sla = SLA[PLANTS[k]];
      const c = sla ? Math.min(2, yearComp(sla, sun, temp, water, f, pOf(PLANTS[k]))) : 0;
      dFit = Math.max(dFit, Math.abs(F[i * NS + k] - f));
      dComp = Math.max(dComp, Math.abs(C[i * NS + k] - c));
      if (c > 0.01) rComp = Math.max(rComp, Math.abs(C[i * NS + k] - c) / c);
    }
  }
  console.log(`tables: fit max ${dFit.toExponential(2)}, compensation point max ${dComp.toExponential(2)} (${rComp.toExponential(2)} of one over 0.01)`);
  expect(zeros, "cells under the sea hold zeros").toBe(0);
  expect(dFit, "fits").toBeLessThan(2e-4);
  expect(rComp, "compensation points").toBeLessThan(3e-3);
}, 300_000);
