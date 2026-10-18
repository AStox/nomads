// The orographic rain on the GPU (rain.ts, wgsl/terrain-rain.ts), tested three ways. Run one case at a time:
//   bun test ./src/gpu/terrain/rain.test.ts -t "seed 1" --timeout 300000
// 1. Against Smith and Barstad's theory written again in float64 from the paper (R1320 eqs. 12 and 49) below, which first
//    reproduces numbers the paper publishes (case "the float theory"), then the island's rain with the seasons' delays on
//    seeds 1 to 3: each season within a recorded tolerance, the same words on a second run, and a golden hash of the
//    words. The hash is the pin against a change that is still inside the tolerance.
// 2. Against what the theory says of any hill: no rain is taken below none, a flat island gets the background, a hill
//    symmetric across the wind rains symmetrically, the hill's windward side is wetter than the background and its lee
//    drier, and longer cloud delays carry the rain farther downwind and so leave the hill with less of it.
// 3. The delays follow the phase of the water.
import { afterAll, expect, test } from "bun:test";
import { releaseGpu, theGpu } from "../device";
import { upstream } from "../../terrain/island";
import { COARSE, DIRS, GAMMA_RATIO, H_W, M, NC, N_M, P_BG, R_V, ROSE, SEASONS, SEASON_DAYS, WET_ROSE, esat, meanWay, turned } from "../../terrain/climate";
import { CELL, N } from "../../terrain/grid";
import { rng } from "../../sim/world";
import { ICE_SHARE, ISLAND_DELAYS, TAU_C_ICE, TAU_C_WARM, TAU_F_RAIN, V_SNOW, cloudDelays, rainGpu, tableMargin, type Delays } from "./rain";

afterAll(releaseGpu);

// Smith and Barstad's own cloud delays, s (R487).
const TAU = 1000;

// The heights climate is given (the island's ground, never under the sea's level) and the wet rose built from the
// generator's first draw after the upstream stages, the prevailing wind (src/gpu/terrain/island.ts climateGpu).
function inputs(seed: number) {
  const rand = rng(seed), { height } = upstream(rand);
  const z = Float32Array.from(height, (h) => Math.max(0, h));
  const wetRose = turned(WET_ROSE, rand() * Math.PI * 2 - meanWay(ROSE));
  return { z, wetRose };
}

// ---- Smith and Barstad's linear theory of orographic precipitation in float64, from the paper (R1320) ----
function fft(re: Float64Array, im: Float64Array, inverse: boolean) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = ((inverse ? 2 : -2) * Math.PI) / len;
    for (let i = 0; i < n; i += len)
      for (let k = 0; k < len / 2; k++) {
        const wr = Math.cos(ang * k), wi = Math.sin(ang * k), a = i + k, b = a + len / 2;
        const tr = re[b] * wr - im[b] * wi, ti = re[b] * wi + im[b] * wr;
        re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
      }
  }
  if (inverse) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
}
function fft2(re: Float64Array, im: Float64Array, nx: number, ny: number, inverse: boolean) {
  const r = new Float64Array(nx), q = new Float64Array(nx), c = new Float64Array(ny), d = new Float64Array(ny);
  for (let y = 0; y < ny; y++) {
    for (let x = 0; x < nx; x++) { r[x] = re[y * nx + x]; q[x] = im[y * nx + x]; }
    fft(r, q, inverse);
    for (let x = 0; x < nx; x++) { re[y * nx + x] = r[x]; im[y * nx + x] = q[x]; }
  }
  for (let x = 0; x < nx; x++) {
    for (let y = 0; y < ny; y++) { c[y] = re[y * nx + x]; d[y] = im[y * nx + x]; }
    fft(c, d, inverse);
    for (let y = 0; y < ny; y++) { re[y * nx + x] = c[y]; im[y * nx + x] = d[y]; }
  }
}
interface Env { U: number; V: number; Cw: number; Nm: number; Hw: number; tauC: number; tauF: number }
// The rain (mm an hour) the terrain h (m, periodic, nx by ny cells of dx by dy m) adds to the background, before the
// cut at none: eq. 49, P^ = C_w i sigma h^ / ((1 - i m H_w)(1 + i sigma tau_c)(1 + i sigma tau_f)), m from eq. 12.
function transfer(h: Float64Array, nx: number, ny: number, dx: number, dy: number, e: Env) {
  const re = Float64Array.from(h), im = new Float64Array(nx * ny);
  fft2(re, im, nx, ny, false);
  const pr = new Float64Array(nx * ny), pi = new Float64Array(nx * ny);
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++) {
      const k = (2 * Math.PI * (i < nx / 2 ? i : i - nx)) / (nx * dx), l = (2 * Math.PI * (j < ny / 2 ? j : j - ny)) / (ny * dy);
      const sg = e.U * k + e.V * l, n = j * nx + i;
      if (sg === 0) continue;
      const m2 = ((e.Nm * e.Nm - sg * sg) / (sg * sg)) * (k * k + l * l);
      let dr = 1, di = 0;
      if (m2 >= 0) di = -Math.sign(sg) * Math.sqrt(m2) * e.Hw; else dr = 1 + Math.sqrt(-m2) * e.Hw;
      const a = 1 - sg * sg * e.tauC * e.tauF, b = sg * (e.tauC + e.tauF);
      const dnr = dr * a - di * b, dni = dr * b + di * a, den = dnr * dnr + dni * dni;
      const nr = -e.Cw * sg * im[n], ni = e.Cw * sg * re[n];
      pr[n] = (nr * dnr + ni * dni) / den; pi[n] = (ni * dnr - nr * dni) / den;
    }
  fft2(pr, pi, nx, ny, true);
  return pr.map((v) => v * 3600);
}
// A season's rain in mm over the season, by the float theory above.
function theory(z: Float32Array, wetRose: number[], delays: Delays[]) {
  const h = new Float64Array(M * M);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) h[Math.floor(y / COARSE) * M + Math.floor(x / COARSE)] += z[y * N + x] / (COARSE * COARSE);
  return SEASONS.map(({ t, wet, rains, rainWind, rainHumid }, si) => {
    const out = new Float64Array(N * N), hours = SEASON_DAYS * 24 * rains, bg = (P_BG * wet) / hours;
    const Cw = ((rainHumid * esat(t) * 1000) / (R_V * (t + 273.15))) * GAMMA_RATIO;
    for (let d = 0; d < DIRS; d++) {
      if (wetRose[d] <= 0) continue;
      const a = (2 * Math.PI * d) / DIRS;
      const p = transfer(h, M, M, COARSE * CELL, COARSE * CELL, { U: rainWind * Math.cos(a), V: rainWind * Math.sin(a), Cw, Nm: N_M, Hw: H_W, ...delays[si] });
      for (let y = 0; y < N; y++)
        for (let x = 0; x < N; x++) {
          const cx = Math.min(Math.max((x + 0.5) / COARSE - 0.5, 0), NC - 1.001), cy = Math.min(Math.max((y + 0.5) / COARSE - 0.5, 0), NC - 1.001);
          const x0 = Math.floor(cx), y0 = Math.floor(cy), fx = cx - x0, fy = cy - y0, c = y0 * M + x0;
          const v = (p[c] * (1 - fx) + p[c + 1] * fx) * (1 - fy) + (p[c + M] * (1 - fx) + p[c + M + 1] * fx) * fy;
          out[y * N + x] += wetRose[d] * hours * Math.max(0, bg + v);
        }
    }
    return out;
  });
}
// A one-direction wet rose: all the wet hours' wind from direction d.
const only = (d: number) => Array.from({ length: DIRS }, (_, k) => (k === d ? 1 : 0));
// A dome of height a (m) and radius r (m) at the grid's centre, which falls between cells so that it is exactly symmetric.
const dome = (a: number, r: number) => Float32Array.from({ length: N * N }, (_, i) => {
  const d = Math.hypot((i % N) - (N - 1) / 2, Math.floor(i / N) - (N - 1) / 2) * CELL;
  return d < r ? a * 0.5 * (1 + Math.cos((Math.PI * d) / r)) : 0;
});
const PAPER_DELAYS: Delays[] = SEASONS.map(() => ({ tauC: TAU, tauF: TAU }));

// The pinned output of each seed's island: Bun.hash over the four seasons' rain, in season order, as the bytes of the
// float32 arrays rainGpu returns. It pins the integer arithmetic bit for bit, so it is re-recorded deliberately, with the
// commit message saying why, whenever the model changes (the rain's constants, the island's delays, the upstream stages
// that make the heights). The float theory above says the rain is right; this says it has not moved.
const golden = (seasons: Float32Array[]) => Bun.hash(Buffer.concat(seasons.map((s) => Buffer.from(s.buffer, s.byteOffset, s.byteLength)))).toString(16);
const GOLDEN: Record<number, string> = { 1: "5b1fc99190a7c43c", 2: "e5b63757cd81377d", 3: "b18bf219d79dc870" };

// Tolerance in mm over a season, which rains 80 to 370 mm. Seeds 1 to 3 give a largest error of 0.0043 mm (1.2e-5 of the
// wettest cell's season) and a mean of 0.0004 mm in every season: the roundings of the constants (Q26 against the
// float's 1e-16), of the wind's cosine and sine (Q22) and of the stages' words, all far under the three or four digits
// the model's own constants (SEASONS, the wet rose) are given to.
const MAX_ERR = 0.01, MEAN_ERR = 0.001;

function worst(got: Float32Array[], want: ArrayLike<number>[]) {
  return got.map((g, si) => {
    let max = 0, sum = 0, peak = 0;
    for (let i = 0; i < g.length; i++) { const e = Math.abs(g[i] - want[si][i]); sum += e; max = Math.max(max, e); peak = Math.max(peak, want[si][i]); }
    return { max, mean: sum / g.length, peak };
  });
}

async function check(seed: number) {
  const { z, wetRose } = inputs(seed);
  const g = await theGpu();
  const t0 = performance.now();
  const island = await rainGpu(g, z, wetRose);
  const cold = performance.now() - t0;
  const t1 = performance.now();
  const again = await rainGpu(g, z, wetRose);
  const warm = performance.now() - t1;
  worst(island, theory(z, wetRose, ISLAND_DELAYS)).forEach((w, si) => {
    console.log(`seed ${seed} season ${si} against the float theory: max abs ${w.max.toFixed(4)} mm, mean abs ${w.mean.toFixed(5)} mm`);
    expect(w.max).toBeLessThan(MAX_ERR);
    expect(w.mean).toBeLessThan(MEAN_ERR);
  });
  again.forEach((s, si) => expect(Buffer.from(s.buffer).equals(Buffer.from(island[si].buffer))).toBe(true));
  console.log(`seed ${seed}: rainGpu ${warm.toFixed(0)} ms warm, ${cold.toFixed(0)} ms first call (pipelines compiled), on ${g.adapter}, golden ${golden(island)}`);
  expect(golden(island)).toBe(GOLDEN[seed]);
}

test("the tables' roundings are well clear of ties, so an engine's last-place cosine cannot change a word", () => {
  expect(tableMargin()).toBeGreaterThan(1e-6);
});

test("the float theory reproduces the numbers its paper publishes", () => {
  // Fig. 3: a triangle ridge of 500 m, 15 m/s along x, T0 280 K (C_w = 7.4 g/m3 times 6.5 / 5.8), N_m 0.005, H_w 2500 m,
  // tau 1000 s both: the rain peaks at 2.96 mm an hour for a half width of 15 km and 2.33 for 40 km (R1320 sec. 5b).
  const Cw = 0.0074 * (6.5 / 5.8), n = 8192, dx = 250;
  const env: Env = { U: 15, V: 0, Cw, Nm: 0.005, Hw: 2500, tauC: 1000, tauF: 1000 };
  for (const [a, peak] of [[15000, 2.96], [40000, 2.33]]) {
    const h = Float64Array.from({ length: n }, (_, i) => Math.max(0, 500 * (1 - Math.abs((i - n / 2) * dx) / a)));
    const p = transfer(h, n, 1, dx, dx, env).reduce((m, v) => Math.max(m, v), -1e9);
    expect(Math.abs(p / peak - 1)).toBeLessThan(0.03);
  }
  // Table 5: a Gaussian ridge of half width 15 km, H_w 3 km: the rain over the ridge, with the negative part cut, as a
  // share of the raw upslope condensation is 42% for tau 1000 s both (and 55% for 0 and 1000 s).
  const h = Float64Array.from({ length: n }, (_, i) => 500 * Math.exp(-((((i - n / 2) * dx) / 15000) ** 2)));
  let ref = 0;
  for (let i = 0; i < n - 1; i++) ref += Math.max(0, Cw * 15 * ((h[i + 1] - h[i]) / dx)) * dx;
  const share = (tauC: number, tauF: number) =>
    (transfer(h, n, 1, dx, dx, { ...env, Hw: 3000, tauC, tauF }).reduce((s, v) => s + Math.max(0, v), 0) * dx) / 3600 / ref;
  expect(Math.abs(share(1000, 1000) - 0.42)).toBeLessThan(0.02);
  expect(Math.abs(share(0, 1000) - 0.55)).toBeLessThan(0.02);
});

test("a flat island gets the background and nothing else, every season", async () => {
  const g = await theGpu(), rain = await rainGpu(g, new Float32Array(N * N), WET_ROSE);
  const shares = WET_ROSE.reduce((a, b) => a + b, 0);
  SEASONS.forEach(({ wet }, si) => {
    for (const v of rain[si]) expect(Math.abs(v - P_BG * wet * shares)).toBeLessThan(0.01);
  });
});

test("no direction takes the rain below none, and a hill symmetric across the wind rains symmetrically", async () => {
  const g = await theGpu(), z = dome(150, 5000);
  for (const d of [0, 3, 5, 11, 14]) {
    const rain = await rainGpu(g, z, only(d));
    rain.forEach((s) => expect(s.reduce((m, v) => Math.min(m, v), 1e9)).toBeGreaterThanOrEqual(0));
  }
  // wind along +x (direction 0): the rain mirrors in y, and (the dome is symmetric both ways) a wind along +y gives the
  // same field turned a quarter
  const east = await rainGpu(g, z, only(0)), south = await rainGpu(g, z, only(DIRS / 4));
  east.forEach((s, si) => {
    let across = 0, turn = 0;
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      across = Math.max(across, Math.abs(s[y * N + x] - s[(N - 1 - y) * N + x]));
      turn = Math.max(turn, Math.abs(s[y * N + x] - south[si][x * N + y]));
    }
    console.log(`season ${si}: mirror across the wind ${across.toFixed(4)} mm, quarter turn ${turn.toFixed(4)} mm`);
    expect(across).toBeLessThan(0.01);
    expect(turn).toBeLessThan(0.02);
  });
});

test("the hill's windward side is wetter than the background and its lee drier, and longer delays leave it less", async () => {
  const g = await theGpu(), z = dome(150, 5000), c = (N - 1) / 2;
  const at = (s: Float32Array, dx: number) => s[Math.round(c) * N + Math.round(c + dx / CELL)];
  const near = await rainGpu(g, z, only(0), PAPER_DELAYS), far = await rainGpu(g, z, only(0), SEASONS.map(() => ({ tauC: 3 * TAU, tauF: 3 * TAU })));
  SEASONS.forEach(({ wet }, si) => {
    const bg = P_BG * wet;
    const windward = at(near[si], -3000), crest = at(near[si], 0), lee = at(near[si], 7000);
    console.log(`season ${si}: background ${bg.toFixed(0)} mm, 3 km upwind ${windward.toFixed(0)}, crest ${crest.toFixed(0)}, 7 km downwind ${lee.toFixed(0)}; delays tripled: crest ${at(far[si], 0).toFixed(0)}`);
    expect(windward).toBeGreaterThan(bg);
    expect(crest).toBeGreaterThan(bg);
    expect(lee).toBeLessThan(bg);
    expect(at(far[si], 0) - bg).toBeLessThan(crest - bg);
  });
});

test("the delays follow the phase of the water: warm cloud slow to convert and fast to fall out, cold the opposite", () => {
  expect(cloudDelays(0)).toEqual({ tauC: TAU_C_WARM, tauF: TAU_F_RAIN });
  expect(cloudDelays(1)).toEqual({ tauC: TAU_C_ICE, tauF: H_W / V_SNOW });
  for (const [s, f] of ICE_SHARE.entries()) {
    expect(f).toBeGreaterThan(0);
    expect(f).toBeLessThan(1);
    expect(ISLAND_DELAYS[s].tauC).toBeCloseTo(f * TAU_C_ICE + (1 - f) * TAU_C_WARM, 9);
  }
  // the cold seasons (spring, winter) convert faster and drop out more slowly than the warm ones (summer, autumn)
  for (const cold of [0, 3]) for (const warm of [1, 2]) {
    expect(ISLAND_DELAYS[cold].tauC).toBeLessThan(ISLAND_DELAYS[warm].tauC);
    expect(ISLAND_DELAYS[cold].tauF).toBeGreaterThan(ISLAND_DELAYS[warm].tauF);
  }
});

test("rain seed 1", () => check(1), 300_000);
test("rain seed 2", () => check(2), 300_000);
test("rain seed 3", () => check(3), 300_000);
