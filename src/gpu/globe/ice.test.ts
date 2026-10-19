// Ice ages and sea level on the globe (ice.ts, wgsl/globe-ice.ts), tested one case at a time:
//   bun test ./src/gpu/globe/ice.test.ts -t "mass" --timeout 280000
// The cases that need no GPU are the laws (their cited numbers), the orbit and the trough finder; the rest run the kernels on a
// synthetic planet (an island with a range in the westerlies, a zonal climate) and state the invariants (ice mass conserved to the
// unit, no negative thickness, the links' fluxes opposite, rock removed equal to sediment, debris and dissolved load, the sea's return),
// the laws the kernels apply (the diffusion number from Glen's law, the cut from the sliding), kernel against twin word for word, run
// to run identity and a pinned hash. What the runs measured on the planet: docs/research/globe/2026-10-19-ice-impl.md.
import { afterAll, expect, test } from "bun:test";
import { releaseGpu, theGpu } from "../device";
import { tierGrid } from "./grid";
import { cellVectors, extTables, padMap } from "./tectonics";
import {
  AW, DT_LGM, EROSION, GAMMA_SIA, GLEN, IF, IP, IceGpu, IceTwin, LAPSE_K_M, ORBIT, REFERENCE_LAT_DEG, RHO_ICE, SENSITIVITY_K_PER_WM2, T_ROOT, U_CAP_M_YR, ablationMm, balanceMm, bedsOf, books, components8,
  defaultLaw, diffusivity, elaOf, elementsAt, erosionRate, forcingTable, kernelConstants, lgmForcing, orbitOf, runIce, seaLevelOf, seaState, slidingSpeed, solidShare, stepWords,
  summerAnomaly, summerInsolation, troughs, unitM3, type CellClimate, type IceInputs,
} from "./ice";

afterAll(releaseGpu);

const g0 = tierGrid(0), N = 6 * 256 * 256, DEG = Math.PI / 180;
const sha = (a: Int32Array) => new Bun.CryptoHasher("sha256").update(a).digest("hex");
const vec = cellVectors(g0), lat = Float32Array.from({ length: N }, (_, i) => Math.asin(vec[3 * i + 2])), lon = Float32Array.from({ length: N }, (_, i) => Math.atan2(vec[3 * i + 1], vec[3 * i]));
const arcKm = (i: number, la0: number, lo0: number) => Math.acos(Math.min(1, Math.sin(lat[i]) * Math.sin(la0 * DEG) + Math.cos(lat[i]) * Math.cos(la0 * DEG) * Math.cos(lon[i] - lo0 * DEG))) * (g0.radius / 1000);

// The air's sea-level temperature of the four seasons of a planet with a zonal climate: tEq at the equator falling with sin^2 of latitude
// by `drop`, the summer and winter of each hemisphere `swing` warmer and colder at the pole; precipitation `p` mm a season everywhere.
function zonal(tEq = 28, drop = 38, swing = 6, p = 250): Pick<IceInputs, "ts" | "precip"> {
  const ts = [0, 1, 2, 3].map((s) => Float32Array.from(lat, (la) => { const sl = Math.sin(la); return tEq - drop * sl * sl + (s === 1 ? swing : s === 3 ? -swing : 0) * sl; }));
  return { ts, precip: [0, 1, 2, 3].map(() => new Float32Array(N).fill(p)) };
}
// An island of 100 m land under a range (peak metres, 600 km across) at 55 N, the sea 250 m deep beyond 900 km of it.
function island(peak = 3500, la0 = 55, lo0 = 0): Float32Array {
  return Float32Array.from({ length: N }, (_, i) => { const d = arcKm(i, la0, lo0); return d > 900 ? -250 : 100 + (peak - 100) * Math.max(0, 1 - d / 600) ** 1.5; });
}
const sumBig = (a: Int32Array) => a.reduce((s, v) => s + BigInt(v >>> 0), 0n);
async function make(inputs: IceInputs, law = defaultLaw()) { return new IceGpu(await theGpu(), extTables(g0).tab, inputs, law); }
// the fixture of the dynamic cases: a range of 3.5 km on an island at 55 N, mean sea-level air of 2 C there with a 5 K summer swing and 1,800 mm a year
const standard = () => ({ bed: island(), ...zonal(28, 38, 3, 450) });

// ---- the laws, with their cited numbers (no GPU) ----
test("the laws give the cited numbers: the ablation quadratic, Glen's law at 200 m on a slope of 0.1, the basal stress ceiling, the two erosion laws, the sea level of the last glacial maximum", () => {
  // Ohmura and Boettcher: 966 mm at 0 C, about 1,700 at 3 C and 2,900 at 7 C, nothing under the quadratic's root at -4.79 C
  expect(ablationMm(0)).toBe(966);
  expect(ablationMm(3)).toBeCloseTo(1708.8, 1);
  expect(ablationMm(7)).toBeGreaterThan(2800); expect(ablationMm(7)).toBeLessThan(2950);
  expect(T_ROOT).toBeCloseTo(-4.784, 2);
  expect(ablationMm(T_ROOT - 0.01)).toBe(0); expect(ablationMm(T_ROOT + 0.01)).toBeGreaterThan(0); expect(ablationMm(T_ROOT + 0.01)).toBeLessThan(5);
  expect(solidShare(-1)).toBe(1); expect(solidShare(1)).toBe(0); expect(solidShare(0)).toBe(0.5);
  // Gamma = 2 A (rho g)^3 / 5 = 2.85e-5 per m^3 a (the research note), and 200 m of ice on a slope of 0.1 moves at 46 m a year
  expect(GAMMA_SIA / 2.85e-5).toBeCloseTo(1, 1);
  expect(GAMMA_SIA * 200 ** 4 * 0.1 ** 3).toBeGreaterThan(44); expect(GAMMA_SIA * 200 ** 4 * 0.1 ** 3).toBeLessThan(47);
  expect(GLEN.n).toBe(3);
  // 373 m of ice on a slope of 0.03 has a basal shear stress of 100 kPa
  expect((RHO_ICE * 9.81 * 373 * 0.03) / 1e5).toBeCloseTo(1, 1);
  // the explicit step the diffusion needs without a cap: 52 years at 12 km for 300 m on a slope of 0.1 (the note's figure, from the pure deformation)
  const dx = 12_272, d = GAMMA_SIA * 300 ** 5 * 0.1 ** 2;
  expect((dx * dx) / (4 * d)).toBeGreaterThan(50 * 0.8); expect((dx * dx) / (4 * d)).toBeLessThan(60);
  // erosion: Cook's law gives 4.6 mm a year at 365 m a year and Herman's 40; for 50 and 500 m a year the ratios are 10^0.65 and 10^2.02
  expect(erosionRate(365) * 1000).toBeCloseTo(4.6, 0); expect(erosionRate(365, EROSION.herman) * 1000).toBeCloseTo(40.5, 0);
  expect(erosionRate(500) / erosionRate(50)).toBeCloseTo(10 ** 0.65, 6);
  expect(erosionRate(500, EROSION.herman) / erosionRate(50, EROSION.herman)).toBeCloseTo(10 ** 2.02, 6);
  expect(erosionRate(1e6)).toBe(erosionRate(U_CAP_M_YR));
  // sliding: 100 m a year under 100 kPa (the design anchor)
  expect(slidingSpeed(1e5 / (RHO_ICE * 9.81), 1)).toBeCloseTo(100, 5);
  // sea level: 52e6 km3 of ice over 3.62e14 m2 of ocean gives 131 m against Lambeck et al.'s 134
  expect(-seaLevelOf(52e15, 3.62e14)).toBeGreaterThan(129); expect(-seaLevelOf(52e15, 3.62e14)).toBeLessThan(134);
  // the cap of the sliding speed is the fastest measured, 3 m a day
  expect(U_CAP_M_YR).toBeCloseTo(1095.75, 2);
  // the diffusivity is the sum of the two flows and cold ice is a tenth as stiff
  expect(diffusivity(300, 0.05, false) / (GAMMA_SIA * 300 ** 5 * 0.0025)).toBeCloseTo(0.1, 6);
  expect(diffusivity(300, 0.05, true)).toBeGreaterThan(diffusivity(300, 0.05, false) * 10);
});

test("the orbit: obliquity and precession move the summer insolation of 65 degrees by tens of W/m2, zero at the reference orbit, and the forcing is scaled to the cited glacial cooling", () => {
  const o = orbitOf(1), ref = (la: number) => summerInsolation(la * DEG, 0, 0, o.tiltDeg, o.solar, 90);
  // the reference orbit of the atmosphere (circular, the planet's tilt) has no anomaly by construction
  expect(summerInsolation(65 * DEG, 0, 123, o.tiltDeg, o.solar, 90)).toBeCloseTo(ref(65), 9);
  // a larger tilt warms the high latitudes' summer; perihelion at the northern summer solstice (varpi = 90) warms it, at the opposite point cools it
  expect(summerInsolation(65 * DEG, 0, 0, o.tiltDeg + 1.2, o.solar, 90)).toBeGreaterThan(ref(65));
  expect(summerInsolation(65 * DEG, 0.05, 90, o.tiltDeg, o.solar, 90)).toBeGreaterThan(ref(65) + 20);
  expect(summerInsolation(65 * DEG, 0.05, 270, o.tiltDeg, o.solar, 90)).toBeLessThan(ref(65) - 20);
  // the southern summer is the other quarter of the year: the same perihelion warms 65 N's summer and cools 65 S's... at varpi = 90 the south's summer (longitude 270) is at aphelion
  expect(summerInsolation(-65 * DEG, 0.05, 90, o.tiltDeg, o.solar, 270)).toBeLessThan(summerInsolation(-65 * DEG, 0, 0, o.tiltDeg, o.solar, 270) - 20);
  // over 300 kyr the 65 N anomaly of each seed reaches the size of the cited 35 to 40 W/m2 (R1438's anomaly of one moment, 115 kyr ago) and not twice it
  for (const seed of [1, 2, 3]) {
    const s = orbitOf(seed);
    let lo = 0, hi = 0;
    for (let t = 0; t < 300_000; t += 500) { const a = summerAnomaly(s, t, REFERENCE_LAT_DEG * DEG); lo = Math.min(lo, a); hi = Math.max(hi, a); }
    expect(lo).toBeLessThan(-35); expect(hi).toBeGreaterThan(35); expect(lo).toBeGreaterThan(-80); expect(hi).toBeLessThan(80);
    // the elements stay in their cited ranges
    for (let t = 0; t < 300_000; t += 5000) {
      const e = elementsAt(s, t);
      expect(e.epsDeg).toBeGreaterThanOrEqual(s.tiltDeg - ORBIT.oblAmpDeg - 1e-9); expect(e.epsDeg).toBeLessThanOrEqual(s.tiltDeg + ORBIT.oblAmpDeg + 1e-9);
      expect(e.ecc).toBeGreaterThanOrEqual(ORBIT.eccLo - 1e-9); expect(e.ecc).toBeLessThanOrEqual(ORBIT.eccHi + 1e-9);
    }
    // the gain and base put the offset at 65 N between 0 (the warmest) and the cited glacial cooling (the coldest)
    const f = lgmForcing(s, 120_000), tab = (t: number) => forcingTable(s, t, f)[155];
    let low = 0, high = -Infinity;
    for (let t = 0; t <= 120_000; t += 500) { low = Math.min(low, tab(t)); high = Math.max(high, tab(t)); }
    expect(low).toBeCloseTo(DT_LGM, 6); expect(high).toBeCloseTo(0, 6);
  }
  // 3 K for 38 W/m2: the energy balance's own sensitivity
  expect(SENSITIVITY_K_PER_WM2 * 38).toBeGreaterThan(2.7); expect(SENSITIVITY_K_PER_WM2 * 38).toBeLessThan(3.3);
  // the same seed draws the same phases
  expect(orbitOf(1).phase).toEqual(orbitOf(1).phase);
  expect(orbitOf(1).phase).not.toEqual(orbitOf(2).phase);
});

test("troughs: a channel cut below the sea through land is found with its length, marine only where it reaches the sea, a lake-free plain has none, and islands are components", () => {
  const before = new Float32Array(N).fill(-500), after = new Float32Array(N);
  // land of 100 m on the cell range of face 0, a channel of 12 cells (X 100..111) across row Y 128 cut to -300 m
  const id = (X: number, Y: number) => (0 * 256 + Y) * 256 + X;
  for (let Y = 100; Y < 160; Y++) for (let X = 80; X < 140; X++) before[id(X, Y)] = 100;
  after.set(before);
  expect(troughs(g0, before, after).length).toBe(0);
  for (let X = 100; X < 112; X++) after[id(X, 128)] = -300;
  const t = troughs(g0, before, after);
  expect(t.length).toBe(1);
  expect(t[0].cells).toBe(12); expect(t[0].deepestM).toBe(300);
  expect(t[0].lengthKm).toBeGreaterThan(11 * 11); expect(t[0].lengthKm).toBeLessThan(12 * 13);
  expect(t[0].widthKm).toBeGreaterThan(11); expect(t[0].widthKm).toBeLessThan(14);
  expect(t[0].marine).toBe(false);
  // the same channel run out to the coast at X 80 is open to the sea
  for (let X = 80; X < 100; X++) after[id(X, 128)] = -300;
  const cut = troughs(g0, before, after)[0];
  expect(cut.marine).toBe(true);
  // its inland reach is that of its farthest cell from the sea (X 110: 30 cells to the land's west edge, 29 to its south)
  expect(cut.inlandKm).toBeGreaterThan(27 * 11); expect(cut.inlandKm).toBeLessThan(31 * 13);
  // a strip cut along the coast (the land's first column, Y 105..114) reaches one cell inland
  const strip = Float32Array.from(before);
  for (let Y = 105; Y < 115; Y++) strip[id(80, Y)] = -50;
  const s = troughs(g0, before, strip);
  expect(s.length).toBe(1); expect(s[0].marine).toBe(true);
  expect(s[0].inlandKm).toBeGreaterThan(10); expect(s[0].inlandKm).toBeLessThan(13);
  // a channel from coast to coast makes two islands of the land (components8 counts diagonal steps as joined)
  const mask = Array.from(after, (v) => (v >= 0 ? 1 : 0));
  expect(components8(g0, mask).cells.length).toBe(1);
  for (let X = 100; X < 140; X++) after[id(X, 128)] = -300;
  expect(components8(g0, Array.from(after, (v) => (v >= 0 ? 1 : 0))).cells.length).toBe(2);
});

// ---- the equilibrium line ----
test("the equilibrium line rises equatorward and with dryness, moves about 1/lapse metres for a kelvin of offset, and the kernel equals the law in float", async () => {
  const wet = zonal(28, 38, 6, 250), dry = zonal(28, 38, 6, 125), bed = new Float32Array(N);
  const a = await make({ bed, ...wet }), b = await make({ bed, ...dry });
  try {
    a.setOffset(0); b.setOffset(0);
    const ela = await a.ela(), elaDry = await b.ela();
    a.setOffset(1);
    const elaWarm = await a.ela();
    // the kernel's answer against the float law at a sample of cells (Q6 metres: the lapse and temperature roundings are under 3 m)
    let checked = 0, maxErr = 0;
    for (let i = 0; i < N; i += 97) {
      const c: CellClimate = { ts: wet.ts.map((t) => t[i]), p: wet.precip.map((p) => p[i]), summer: wet.ts.reduce((best, t, s) => (t[i] > wet.ts[best][i] ? s : best), 0) };
      const want = elaOf(c, 0, 0, -1000, 9000);
      if (ela[i] === 2147483647) { expect(want).toBe(Infinity); continue; }
      if (want === -Infinity) { expect(ela[i]).toBe(-64000); continue; }
      maxErr = Math.max(maxErr, Math.abs(ela[i] / 64 - want)); checked++;
    }
    expect(checked).toBeGreaterThan(1000); expect(maxErr).toBeLessThan(3);
    // by latitude band (both hemispheres' cells with an equilibrium line): it falls poleward, 1,000 m or more between 20 and 50 degrees
    const median = (lo: number, hi: number, f: Int32Array) => { const v: number[] = []; for (let i = 0; i < N; i++) if (Math.abs(lat[i]) / DEG >= lo && Math.abs(lat[i]) / DEG < hi && f[i] < 2147483647 && f[i] > -64000) v.push(f[i] / 64); v.sort((x, y) => x - y); return v[Math.floor(v.length / 2)]; };
    const bands = [[0, 10], [10, 20], [20, 30], [30, 40], [40, 50], [50, 60]].map(([lo, hi]) => median(lo, hi, ela));
    for (let k = 1; k < bands.length; k++) expect(bands[k]).toBeLessThan(bands[k - 1]);
    expect(bands[2] - bands[4]).toBeGreaterThan(1000);
    // dryness raises it (halving the precipitation), by tens of metres where the line is set by the temperature that stops melting (-4.8 C) and by hundreds where precipitation balances melt
    for (const [lo, hi] of [[30, 40], [40, 50], [50, 60]]) expect(median(lo, hi, elaDry)).toBeGreaterThan(median(lo, hi, ela) + 50);
    // a kelvin of warming raises a line by 1 / lapse (154 m) where only the temperature moves with height, and by up to a quarter more where the
    // precipitation also falls with height (the snow that the higher line gets is less)
    let n = 0;
    for (let i = 0; i < N; i += 53) if (ela[i] < 2147483647 && ela[i] > -64000 && elaWarm[i] < 2147483647) { const up = (elaWarm[i] - ela[i]) / 64; expect(up).toBeGreaterThan(1 / LAPSE_K_M - 1); expect(up).toBeLessThan(1.3 / LAPSE_K_M); n++; }
    expect(n).toBeGreaterThan(1000);
  } finally { a.release(); b.release(); }
});

// ---- the diffusion number and the cut are the laws ----
test("a patch of ice of known thickness on a known slope gets Glen's diffusion number and the sliding's cut: the kernel against the law, thicker and steeper ice cut faster", async () => {
  // a ramp in latitude on face 0's middle (the equator, longitude 0): bed rises north at slope s; ice h thick over a box of cells
  const rows: { h: number; s: number }[] = [{ h: 100, s: 0.02 }, { h: 200, s: 0.02 }, { h: 400, s: 0.02 }, { h: 200, s: 0.05 }, { h: 200, s: 0.08 }];
  const W = (g0.radius * g0.width);
  const got: { fo: number; ert: number }[] = [];
  for (const { h, s } of rows) {
    const bed = Float32Array.from({ length: N }, (_, i) => (Math.abs(lon[i]) < 0.35 && Math.abs(lat[i]) < 0.35 ? 500 + s * g0.radius * lat[i] : -100));
    const warm = zonal(40, 0, 0, 1);
    const ice = await make({ bed, ...warm });
    try {
      ice.setOffset(0);
      // ice of thickness h over the box, as volumes: V = h a / 16
      const vol = Int32Array.from({ length: N }, (_, i) => (Math.abs(lon[i]) < 0.3 && Math.abs(lat[i]) < 0.3 ? Math.round((h * extTables(g0).tab.words[i]) / 16) : 0));
      ice.write(IF.ICE, vol);
      await ice.batch(1, 1);
      const fo = await ice.read(IF.FOC), ert = await ice.read(IF.ERT);
      // the cell nearest the box's middle
      let mid = 0, best = 9;
      for (let i = 0; i < N; i++) { const d = Math.hypot(lat[i], lon[i]); if (d < best && Math.abs(lon[i]) < 0.3) { best = d; mid = i; } }
      got.push({ fo: fo[mid] / 2 ** 24, ert: ert[mid] / 2 ** 28 });
      const law = defaultLaw(), want = (diffusivity(h, s, true) * (1 * 1)) / (4 * Math.PI * g0.radius ** 2 / N);
      // the slope on the grid is that of the ramp to Q6 rounding and the cell's own geometry: within 3% in the law's units
      expect(Math.abs(fo[mid] / 2 ** 24 / want - 1)).toBeLessThan(0.03);
      expect(Math.abs(ert[mid] / 2 ** 28 / erosionRate(slidingSpeed(h, s), law.erosion) - 1)).toBeLessThan(0.03);
      void W;
    } finally { ice.release(); }
  }
  // thicker ice at one slope cuts faster, steeper ice at one thickness too (sliding by tau^3, cut by u^0.65)
  expect(got[1].ert).toBeGreaterThan(got[0].ert); expect(got[2].ert).toBeGreaterThan(got[1].ert);
  expect(got[3].ert).toBeGreaterThan(got[1].ert); expect(got[4].ert).toBeGreaterThan(got[3].ert);
  expect(got[2].fo).toBeGreaterThan(got[0].fo * 100);
});

// ---- the flux law against its analytic solution ----
test("an ice cap on a flat island reaches the steady profile of the shallow-ice approximation (the radial ODE solved with the same balance), to the grid's accuracy", async () => {
  // A disc of 100 m land of 200 km radius on the equator in a sea 3 km deep; cold air all year (no melt, a cold bed, no sliding) and 100 mm of snow a
  // season, no depression (the relaxation time made endless): the ice calves at the coast, so the margin is where the land ends.
  const R = 200e3, cellM = g0.radius * g0.width, Reff = R + cellM / 2;
  const bed = Float32Array.from({ length: N }, (_, i) => (arcKm(i, 0, 0) * 1000 <= R ? 100 : -3000));
  const cold = zonal(-20, 0, 0, 100);
  const law = defaultLaw({ relaxYr: 1e12 });
  const ice = await make({ bed, ...cold }, law);
  try {
    ice.setOffset(0);
    await ice.advance(8000, { dtMin: 0.25, dtMax: 50 });
    const [v, hq] = await Promise.all([ice.read(IF.ICE), ice.read(IF.HQ)]), tab = extTables(g0).tab.words;
    let top = 0, topCell = 0;
    for (let i = 0; i < N; i++) { const h = (Math.floor(v[i] / tab[i]) * 1024 + Math.floor(((v[i] % tab[i]) * 1024) / tab[i])) / 64; if (h > top) { top = h; topCell = i; } }
    // the steady profile: q(r) = (1/r) integral of b r dr, dh/dr = -(q / (Gamma_cold h^5))^(1/3), b(h) the balance of the law at the ice's surface; shoot on the summit's thickness
    const gamma = GAMMA_SIA * defaultLaw().coldFactor, clim: CellClimate = { ts: cold.ts.map((t) => t[0]), p: cold.precip.map((p) => p[0]), summer: 1 };
    const bOf = (h: number) => balanceMm(clim, 100 + h, 0, 100) / 910;
    const reach = (h0: number) => {
      let h = h0, r = 1, qr = 0;
      const dr = 250;
      for (; r < 3e5; r += dr) {
        qr += bOf(h) * r * dr;
        const q = qr / r;
        if (q <= 0) return Infinity;
        h -= ((q / (gamma * h ** 5)) ** (1 / 3)) * dr;
        if (h <= 0) return r;
      }
      return r;
    };
    let lo = 100, hi = 8000;
    for (let k = 0; k < 50; k++) { const mid = (lo + hi) / 2; if (reach(mid) < Reff) lo = mid; else hi = mid; }
    const want = (lo + hi) / 2;
    expect(topCell).toBeGreaterThanOrEqual(0);
    expect(Math.abs(arcKm(topCell, 0, 0))).toBeLessThan(40);
    // (measured 0.94: the 12 km cells and the margin half a cell out)
    expect(top / want).toBeGreaterThan(0.85); expect(top / want).toBeLessThan(1.05);
    // the flux cap bound nowhere near: this cap is quiet at dt 0.25 (the number of the stiffest cell stayed under the cap)
    const adv = await ice.advance(200, { dtMin: 0.25, dtMax: 50 });
    expect(adv.capped).toBeLessThan(adv.iceCellSteps * 0.02);
  } finally { ice.release(); }
}, 280_000);

// ---- kernels against their twins ----
test("the kernels equal their twins word for word over three steps, with ice, a temperate and a cold bed, a coast that calves, and the equilibrium line", async () => {
  const inputs = standard(), ice = await make(inputs), ext = extTables(g0), k = kernelConstants(g0);
  try {
    ice.setOffset(0);
    await ice.advance(1500, { dtMax: 100 });
    let S = await ice.readState();
    const tw = new IceTwin(ext.tab, k, S.slice());
    for (const dt of [3, 7, 1.5]) {
      const par = stepWords(g0, dt, -20, ice.law), stats = tw.step(par);
      ice.writeState(S); ice.seaM = -20;
      const b = await ice.batch(1, dt);
      S = await ice.readState();
      expect(b.dtQ).toBe(par[IP.dtq]);
      expect(b.maxLog).toBe(stats.maxLog); expect(b.cells).toBe(stats.cells); expect(b.capped).toBe(stats.capped);
      let bad = 0;
      for (let i = 0; i < S.length; i++) if (S[i] !== tw.S[i]) bad++;
      expect(bad).toBe(0);
    }
    // there was something to compare: ice, temperate cells, calved ice, a cut bed
    const bk = await books(ice);
    expect(bk.ice).toBeGreaterThan(0n); expect(bk.calved).toBeGreaterThan(0n); expect(bk.rock).toBeGreaterThan(0n);
    expect(tw.S.slice(IF.TMP * (S.length / IF.COUNT), (IF.TMP + 1) * (S.length / IF.COUNT)).some((v) => v === 1)).toBe(true);
    // the equilibrium line kernel
    ice.setOffset(-2);
    const par = stepWords(g0, 1, 0, ice.law);
    const S2 = await ice.readState(), tw2 = new IceTwin(ext.tab, k, S2.slice());
    tw2.ela(par);
    const ela = await ice.ela(), fw = S2.length / IF.COUNT, pad = padMap(g0);
    // the twin's offset field is the GPU's (read back above): compare the ELA words
    const S3 = await ice.readState(), tw3 = new IceTwin(ext.tab, k, S3.slice());
    tw3.ela(par);
    for (let i = 0; i < N; i += 7) expect(ela[i]).toBe(tw3.S[IF.ELA * fw + pad[i]]);
  } finally { ice.release(); }
});

// ---- the books ----
test("ice mass is conserved to the unit (accumulation = ablation + calving + change of volume), thickness never goes negative, the fluxes are opposite, and rock removed is sediment, debris and dissolved load", async () => {
  const ice = await make(standard());
  try {
    ice.setOffset(-1);
    let prev = await books(ice);
    for (let outer = 0; outer < 6; outer++) {
      ice.seaM = outer * -8;
      await ice.advance(500, { dtMax: 60 });
      const b = await books(ice);
      // the change of the ice's volume equals what accumulated less what ablated and calved, exactly (bigint)
      expect(b.ice - prev.ice).toBe((b.accumulated - prev.accumulated) - (b.ablated - prev.ablated) - (b.calved - prev.calved));
      // the debris, the sediment laid and the dissolved load are the rock cut, to the unit
      expect(b.rock).toBe(b.debris + b.sediment + b.dissolved);
      const v = await ice.read(IF.ICE), d = await ice.read(IF.DEB);
      expect(v.every((x) => x >= 0)).toBe(true); expect(d.every((x) => x >= 0)).toBe(true);
      prev = b;
    }
    expect(prev.ice).toBeGreaterThan(0n); expect(prev.calved).toBeGreaterThan(0n); expect(prev.rock).toBeGreaterThan(0n);
    expect(prev.accumulated).toBeGreaterThan(prev.ablated);
    // the four links' fluxes of every cell are opposite to the neighbour's: their sum over the planet is zero
    const total = (await Promise.all([0, 1, 2, 3].map((d) => ice.read(IF.FL + d)))).reduce((s, f) => s + f.reduce((a, v) => a + BigInt(v), 0n), 0n);
    expect(total).toBe(0n);
    // the dissolved share is a fifth of the rock removed
    expect(prev.rock).toBeGreaterThan(1_000_000n);
    // (a unit less than the fifth of each cell's cut at most, since the share is taken of the cumulative cut and floored)
    expect(Number(prev.dissolved) / Number(prev.rock)).toBeGreaterThan(0.198); expect(Number(prev.dissolved) / Number(prev.rock)).toBeLessThanOrEqual(0.2);
  } finally { ice.release(); }
});

test("rock removed is sediment plus dissolved load once the ice is gone: the debris is laid where it melted or calved, none left in the ice", async () => {
  const ice = await make(standard());
  try {
    ice.setOffset(-2);
    await runIce(ice, { years: 3000, outerYr: 500, offset: () => -2, dtMax: 100 });
    const mid = await books(ice);
    expect(mid.rock).toBeGreaterThan(0n); expect(mid.debris).toBeGreaterThan(0n);
    await runIce(ice, { years: 30_000, outerYr: 2000, offset: () => 30, dtMax: 2000 });
    const end = await books(ice);
    expect(end.ice).toBe(0n); expect(end.debris).toBe(0n);
    expect(end.rock).toBe(end.sediment + end.dissolved);
    expect(end.rock).toBeGreaterThanOrEqual(mid.rock);
    // the sediment lies in cells the ice crossed: where it was laid the bed is now higher than the cut alone left it, and the planet's volume is whole
    const { before, after, cut } = await bedsOf(ice);
    let cutVol = 0, netVol = 0;
    for (let i = 0; i < N; i++) { cutVol += cut[i]; netVol += before[i] - after[i]; }
    expect(cutVol).toBeGreaterThan(netVol);
    expect(Number(end.rock) * unitM3(g0)).toBeGreaterThan(0);
  } finally { ice.release(); }
});

// ---- the sea ----
test("the sea falls with the ice and returns to the highstand when the ice is gone; the load's depression relaxes; grounded ice is never afloat", async () => {
  const ice = await make(standard());
  try {
    const cold = await runIce(ice, { years: 3000, outerYr: 500, offset: () => -1, dtMax: 100 });
    const low = Math.min(...cold.map((r) => r.seaM));
    expect(low).toBeLessThan(-5);
    // the sea level is the ice's volume above flotation over the ocean's area, in metres: self-consistent to the formula
    const s = await seaState(ice, ice.seaM);
    expect(s.seaM).toBeCloseTo(seaLevelOf(s.aboveFlotationM3, s.oceanM2), 9);
    expect(s.aboveFlotationM3).toBeLessThanOrEqual(s.iceM3);
    // grounded ice only: every cell of ice under the sea has rho_i h >= rho_w (sea - bed)
    const [v, bef] = await Promise.all([ice.read(IF.ICE), ice.read(IF.BEF)]), tab = extTables(g0).tab.words;
    let marine = 0;
    for (let i = 0; i < N; i++) {
      if (v[i] <= 0 || bef[i] >= Math.round(ice.seaM * 64)) continue;
      marine++;
      const h = (Math.floor(v[i] / tab[i]) * 1024 + Math.floor(((v[i] % tab[i]) * 1024) / tab[i])) / 64;
      expect(RHO_ICE * h).toBeGreaterThanOrEqual(1028 * (ice.seaM - bef[i] / 64) - 1);
    }
    expect(marine).toBeGreaterThanOrEqual(0);
    // the bed is pressed down under the ice by a quarter or so of its thickness at most
    const dep = await ice.read(IF.DEP);
    expect(Math.max(...dep) / 4096).toBeGreaterThan(50); expect(Math.max(...dep) / 4096).toBeLessThan(0.2759 * 4500);
    // warm: the ice goes, the sea is back to its highstand exactly and the bed has risen again
    const warm = await runIce(ice, { years: 100_000, outerYr: 5000, offset: () => 30, dtMax: 5000 });
    expect(warm[warm.length - 1].iceKm3).toBe(0);
    expect(Math.abs(warm[warm.length - 1].seaM)).toBe(0);
    expect(Math.abs(ice.seaM)).toBe(0);
    const dep1 = await ice.read(IF.DEP);
    expect(Math.max(...dep1) / 4096).toBeLessThan(0.5);
  } finally { ice.release(); }
}, 280_000);

// ---- erosion ----
test("a glacier cuts the bed deepest where its ice slides fastest: cold-based ice cuts nothing, and the cut follows the sliding rate, which follows the thickness and the slope", async () => {
  const ice = await make(standard());
  try {
    await runIce(ice, { years: 3000, outerYr: 500, offset: () => -1, dtMax: 100 });
    const [v, tmp, ert, rock, hq] = await Promise.all([IF.ICE, IF.TMP, IF.ERT, IF.RCK, IF.HQ].map((f) => ice.read(f))), tab = extTables(g0).tab.words;
    const thick6 = (x: number, a: number) => (Math.floor(x / a) * 1024 + Math.floor(((x % a) * 1024) / a)) / 64;
    const warm: { rate: number; cut: number; h: number }[] = [];
    let coldCells = 0;
    for (let i = 0; i < N; i++) {
      if (v[i] <= 0) continue;
      if (tmp[i] === 0) { coldCells++; expect(ert[i]).toBe(0); continue; }
      warm.push({ rate: ert[i], cut: thick6(rock[i], tab[i]), h: hq[i] / 64 });
    }
    expect(coldCells).toBeGreaterThan(100); expect(warm.length).toBeGreaterThan(100);
    warm.sort((x, y) => x.rate - y.rate);
    const q = Math.floor(warm.length / 4), mean = (c: typeof warm, f: (x: (typeof warm)[0]) => number) => c.reduce((s, x) => s + f(x), 0) / c.length;
    const slow = warm.slice(0, q), fast = warm.slice(-q);
    expect(mean(fast, (x) => x.cut)).toBeGreaterThan(2 * mean(slow, (x) => x.cut));
    expect(mean(fast, (x) => x.h)).toBeGreaterThan(mean(slow, (x) => x.h));
    // nothing deeper than the law's fastest rate for the years the ice stood, and something deeper than a metre
    const maxCut = Math.max(...Array.from({ length: N }, (_, i) => thick6(rock[i], tab[i])));
    expect(maxCut).toBeLessThan(erosionRate(U_CAP_M_YR) * 3000);
    expect(maxCut).toBeGreaterThan(1);
  } finally { ice.release(); }
});

// ---- identity and a pinned hash ----
async function scenario() {
  const ice = await make(standard());
  try {
    ice.setOffset(-2);
    await ice.advance(1200, { dtMax: 50 });
    ice.seaM = -30;
    await ice.advance(400, { dtMax: 50 });
    const S = await ice.readState();
    // the fields that carry the state (the work fields are rebuilt every step)
    const fw = S.length / IF.COUNT;
    const keep = [IF.ICE, IF.DEB, IF.RCK, IF.SED, IF.DEP, IF.AC, IF.AB, IF.CV, IF.DS];
    const out = new Int32Array(keep.length * N), pad = padMap(g0);
    keep.forEach((f, k) => { for (let i = 0; i < N; i++) out[k * N + i] = S[f * fw + pad[i]]; });
    return out;
  } finally { ice.release(); }
}
test("a run is the same twice, and its state hashes to the pinned value", async () => {
  const a = await scenario(), b = await scenario();
  expect(sha(a)).toBe(sha(b));
  expect(sha(a)).toBe(PINNED);
});
const PINNED = "5e84d421d8e8c08909a0f936b1c5bb90ce5a0a7a4c747c3d339df044f1d7ae4a";
void [AW];
