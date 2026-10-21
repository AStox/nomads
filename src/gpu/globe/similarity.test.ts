// Dynamic similarity on the small planet (similarity.ts): the dimensionless numbers that carry Earth's behaviour come out Earth's at 195.6 km, and the 2,000 km reference planet is
// unchanged. CPU only. Run with: bun test ./src/gpu/globe/similarity.test.ts
import { expect, test } from "bun:test";
import { EBM, HELD_HOU, capTable, C_EVAP, H_WATER, circulationOf, diffusionFor, kernelConstants, planetOf, solveEbm, windTable, ADJUST_S, DRAG } from "./atmosphere";
import { erosionFor } from "./erosion";
import { RADIUS_M, SMALL_RADIUS_M, tierGrid } from "./grid";
import { EARTH_OMEGA, EARTH_R, similarityOf } from "./similarity";
import { ARC_KM, EARTH_HOTSPOTS, hotspotsOf, makeHotspots, makeSetup, sweepsFor, DEFAULTS } from "./tectonics";

const earth = circulationOf(planetOf({ radius: EARTH_R })), small = circulationOf(planetOf({ radius: SMALL_RADIUS_M }));

test("the reference planet is scaled by nothing", () => {
  expect(similarityOf(RADIUS_M)).toEqual({ similar: false, s: 1, cells: 1 });
  expect(planetOf().dayS).toBe(86_400);
  expect(sweepsFor(RADIUS_M)).toEqual({ gap: 16, smooth: 2, dist: 16, flow: 320, regional: 32, wedge: 54, load: 32 });
  expect(erosionFor(RADIUS_M)).toEqual({});
  const ref = makeSetup({});
  expect([ref.layout.arcLo, ref.layout.arcHi, ref.hotspots.length, ref.params.flowEta]).toEqual([50, 70, 5, 1e19]);
});

test("the spin holds Earth's thermal Rossby number: 44 minutes at 195.6 km, the circulation's edges Earth's", () => {
  const p = planetOf({ radius: SMALL_RADIUS_M });
  expect(p.dayS / 60).toBeGreaterThan(44.0);
  expect(p.dayS / 60).toBeLessThan(44.3);
  // Omega a is Earth's, so the Held-Hou group and the eddy-limited edge are Earth's
  expect((small.omega * SMALL_RADIUS_M) / (EARTH_OMEGA * EARTH_R)).toBeCloseTo(1, 2); // the model's day is the solar 86,400 s, Earth's sidereal rate 0.27% faster
  expect(small.groupR / earth.groupR).toBeCloseTo(1, 3);
  expect((small.hadley * 180) / Math.PI).toBeCloseTo((earth.hadley * 180) / Math.PI, 1);
  expect((small.hadley * 180) / Math.PI).toBeGreaterThan(28);
  expect((small.hadley * 180) / Math.PI).toBeLessThan(30);
  expect(HELD_HOU.zStar).toBe(15_000);
  // the game's own day is not this one
  expect(planetOf({ radius: SMALL_RADIUS_M, dayS: 86_400 }).dayS).toBe(86_400);
});

test("the Ekman number, the air's adjustment length and the convective delay are Earth's numbers of the planet's radius", () => {
  const s = similarityOf(SMALL_RADIUS_M).s, e = planetOf({ radius: EARTH_R }), p = planetOf({ radius: SMALL_RADIUS_M });
  // the turning of the surface wind: r / f = C_D |u| / (H f), at 45 degrees and the westerlies' peak
  const turn = (par: typeof e) => { const c = circulationOf(par), w = windTable(par, c, 0), j = Math.round((45 + 90) / 0.05); return Math.abs(w.v[j] / w.u[j]); };
  expect(turn(p) / turn(e)).toBeCloseTo(1, 2);
  const kE = kernelConstants(1), kS = kernelConstants(s);
  // U tau / a: the adjustment rate, the convective rate and the cloud and fall delays go as 1 / s and s
  expect(kS.ft / kE.ft / (1 / s)).toBeCloseTo(1, 3);
  expect(kS.ksbm / kE.ksbm / (1 / s)).toBeCloseTo(1, 3);
  expect(kS.tauCWarm / kE.tauCWarm / s).toBeCloseTo(1, 1);
  expect(kS.tauFRain / kE.tauFRain / s).toBeCloseTo(1, 1);
  expect((ADJUST_S * s * 7) / SMALL_RADIUS_M).toBeCloseTo((ADJUST_S * 7) / EARTH_R, 9);
  expect(DRAG.depth * s).toBeLessThan(40);
});

test("the vapour column goes as s, so the evaporation's flux (C_E U rho_vs (1 - RH)) and the residence over the advective time are Earth's", () => {
  const s = similarityOf(SMALL_RADIUS_M).s, e = capTable(1), c = capTable(s), at = 40 * 16 + 120 * 16; // 40 C on the table's 1/16 K grid from -120
  expect(c[at] / e[at]).toBeCloseTo(s, 3);
  const kE = kernelConstants(1), kS = kernelConstants(s);
  expect(kS.ke / kE.ke).toBeCloseTo(1 / s, 3);
  // the flux a wind of 7 m/s makes over saturated air, ke * column: the same
  expect((kS.ke * c[at]) / (kE.ke * e[at])).toBeCloseTo(1, 3);
  expect(C_EVAP / H_WATER).toBeGreaterThan(0);
});

test("the energy balance keeps Earth's D, so Earth's second mode of temperature, where the radius law would give another", () => {
  const sea = Float64Array.from({ length: 180 }, () => 0.7);
  expect(solveEbm(planetOf({ radius: SMALL_RADIUS_M }), sea, 60).diffusion).toBe(EBM.D_EARTH);
  expect(diffusionFor(SMALL_RADIUS_M)).toBeGreaterThan(2 * EBM.D_EARTH);
});

test("tectonics: Earth's lengths in cells of this planet (rock sets them, not the radius), Earth's heights, rates by the sphere", () => {
  const set = makeSetup({ radius: SMALL_RADIUS_M }), sim = similarityOf(SMALL_RADIUS_M), ref = makeHotspots({ ...DEFAULTS, hotspots: 5 }), hs = set.hotspots;
  // the hot spots are Earth's 40 over the sphere's area: 0.04, so the one the planet is given; each keeps Earth's footprint (100 km) and flux, so Earth's cone
  expect(hs.length).toBe(1);
  expect(hotspotsOf(RADIUS_M)).toBe(5);
  expect(hotspotsOf(EARTH_R)).toBe(EARTH_HOTSPOTS);
  expect(hs[0].radiusKm).toBe(ref[0].radiusKm);
  expect(Math.abs(hs[0].peakM - ref[0].peakM)).toBeLessThanOrEqual(1);
  // the arc's band over the slab: Earth's 124 and 174 km in chamfer units of 5 a cell
  const cellKm = (SMALL_RADIUS_M * tierGrid(0, SMALL_RADIUS_M).width) / 1000;
  expect(set.layout.arcLo).toBe(Math.round((5 * ARC_KM.lo) / cellKm));
  expect(set.layout.arcHi).toBe(Math.round((5 * ARC_KM.hi) / cellKm));
  // the wedge's spreading: sigma = dx (0.4 n)^(1/2) is Earth's 57 km, the trench distance reaches the arc band's far edge
  const dx = cellKm, sigma = (n: number) => dx * Math.sqrt(0.4 * n), sw = sweepsFor(SMALL_RADIUS_M);
  expect(Math.abs(sigma(sw.wedge) / 57 - 1)).toBeLessThan(0.05);
  expect(Math.abs(sigma(sw.load) / (57 * Math.sqrt(32 / 54)) - 1)).toBeLessThan(0.05);
  expect(sw.dist).toBeGreaterThan(set.layout.arcHi / 5);
  expect(sw.wedge % 2).toBe(0);
  expect(sw.load % 2).toBe(0);
  // the weak channel's viscosity is rock's; plates cross Earth's angle in Earth's time (the sphere's own rate)
  expect(set.params.flowEta).toBe(DEFAULTS.flowEta);
  expect(set.params.speedScale).toBeCloseTo(SMALL_RADIUS_M / EARTH_R, 9);
  expect(sim.cells).toBeCloseTo(RADIUS_M / SMALL_RADIUS_M, 9);
});

test("erosion: creep, the shelf's slope and the sediment's reach are Earth's (the reach in the cells it takes here)", () => {
  const p = erosionFor(SMALL_RADIUS_M);
  expect(p.creepLand).toBeUndefined();
  expect(p.creepSea).toBeUndefined();
  expect(p.shelfSlope).toBeUndefined();
  // 96 rings of 12.27 km is 1,178 km: the same length over a cell of this planet
  expect(p.ringMax).toBe(Math.round((96 * 12.272) / ((SMALL_RADIUS_M * tierGrid(0, SMALL_RADIUS_M).width) / 1000)));
});
