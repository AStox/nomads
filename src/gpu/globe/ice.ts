// Ice ages and sea level on the globe (plan Unit 6), host side: the laws and their sources, the orbit and the forcing, the
// parameter words, the kernels' driver (wgsl/globe-ice.ts), the TypeScript twin of every kernel (compared word for word in
// ice.test.ts), the sea level, and the measures taken off a run. Laws, constants, sources and what is wrong with the result:
// docs/research/globe/2026-10-19-ice-impl.md (what was built, here) and docs/research/globe/2026-10-19-ice.md (the research).
// References R1630 to R1669 are this file's; R1460 to R1479 are the research note's.
//
// The model in a paragraph. The climate of the planet as it stands (the atmosphere's sea-level air temperature and precipitation
// for the four seasons) is the baseline; a forcing, an orbit's summer insolation turned to a temperature by the energy balance's
// own sensitivity, scaled to the cited cooling of the last glacial maximum, or a plain offset, shifts every temperature. Where
// the solid precipitation at the ice's surface exceeds the ablation its summer temperature gives (Ohmura and Boettcher's
// quadratic), ice accumulates, and it flows by Glen's law in the shallow-ice approximation with a Weertman slide where the bed
// is at the melting point: a diffusion of the surface, solved as an explicit step on the grid's conservative stencil with the
// diffusion number capped, so a step is stable at any thickness (the cap is counted: ice.advance reports how often it bound).
// Sliding cuts the bed by Herman et al.'s law with Cook et al.'s exponent, a fifth of the rock leaves dissolved and the rest rides
// in the ice as debris until the ice melts or calves. Ice that is afloat calves. The ice's volume lowers the sea (Lambeck et al.'s
// conversion), which exposes the shelf and lets the ice walk onto it, and the sea's return after the ice leaves a bed cut below
// the highstand: the fjords, drowned valleys and islands.
import type { Gpu } from "../device";
import { exp2q, qadd, qexp, qlog2, qmul, wide } from "../fixed";
import { cover, pipeline, readback, storage } from "../kernel";
import { next32, rinit } from "../rand";
import { AW, IF, IP, LOG_OFFSET, iceWgsl, type IceK } from "../wgsl/globe-ice";
import { PHYS } from "../wgsl/globe-tectonics";
import { EBM, GAMMA, diffusionFor, insolation } from "./atmosphere";
import { DISSOLVED } from "./erosion";
import { EDGES, FACES, PAD, TAB, TILE_WORDS, fieldWords, gradientTwin, haloTwin, inTile, meanAreaM2, slotOf, tileCount, type Grid, type Tables } from "./grid";
import { cellAreas, cellVectors, neighbours, padMap } from "./tectonics";

export { AW, IF, IP };
const DEG = Math.PI / 180;

// ---------- 1. laws and constants ----------
// Densities, kg/m3. Ice 910 (R1463: Bonan et al.'s table) [cited]; sea water 1028 for the flotation limit (the research note's
// derivation) [cited]; the water that ice melts to is 1000 for the sea level's conversion (R1464's check: 52e6 km3 of ice over 3.62e14
// m2 of ocean gives 130.7 m against the paper's 134 m) [derived]; the mantle's is tectonics' (R1411) so that the load's depression is
// the isostasy the tectonics use.
export const RHO_ICE = 910, RHO_SEA = 1028, RHO_MELT = 1000, RHO_MANTLE = PHYS.RHO_M, GRAVITY = 9.81;

// R1630 The equilibrium line and the mass balance. Ohmura and Boettcher (2018, R1462) fit the precipitation at the equilibrium line
// against the summer (June to August, December to February in the south) air temperature T of 104 glaciers: P = 5.87 T^2 + 230 T + 966
// mm a year (standard error 648 mm). They show it is the energy balance in water equivalent: the ablation at the equilibrium line
// equals the year's accumulation. Used as the ablation A(T) of any height, so the balance at height z is b(z) = P_solid(z) - A(T(z)).
// The quadratic falls under zero at its upper root, -4.79 C: below it nothing melts. P in the fit is the total precipitation of which
// 91% falls as snow at the line; here the solid share comes from the atmosphere's own ramp, so the fit's 91% is a consequence and
// not a factor [design, derived].
export const ABLATION = { c2: 5.87, c1: 230, c0: 966 } as const;
export const T_ROOT = (-ABLATION.c1 + Math.sqrt(ABLATION.c1 ** 2 - 4 * ABLATION.c2 * ABLATION.c0)) / (2 * ABLATION.c2);
// R1631 The solid share of precipitation: 1 under -1 C, 0 over +1 C, linear between, as the atmosphere's snow (R1545) [design]; the
// temperature at the ice's surface is the air's sea-level temperature (R1632 below) less the lapse rate times the surface's height.
export const SNOW_FROM = -1, SNOW_TO = 1;
// R1632 The lapse rate, the atmosphere's (6.5 K/km, R494) [cited]; temperatures are the air's at the height of the surface above the
// sea of the climate (not above the ice age's lowered sea: the air's temperature at a height does not know where the ocean stands).
export const LAPSE_K_M = GAMMA;
// R1649 Precipitation falls with the height of the surface over the height the climate was made for (the bed, or the sea's surface where
// the bed is under it): as the air's saturation vapour pressure does with its temperature, 7% a kelvin at 0 C and 6.3% at 20 C
// (Tetens' law, the atmosphere's R221 and R1436) [cited], so e-folding in 2.2 km of height at the lapse rate. Without it the ice of a
// high summit keeps the precipitation of the sea-level climate and a cap grows without bound; this is the elevation-desert effect every
// ice-sheet model carries [derived]; the 7% is that of a column and not of a storm [gap: no orographic rain on the ice's own slope].
export const PRECIP_PER_K = 0.07;
// R1633 Glen's law in the shallow-ice approximation (R1463: Bonan et al. 2016, with Glen 1955 and Hutter 1983 behind it): the depth-averaged
// velocity U = (2 A / (n + 2)) (rho g)^n h^(n+1) |grad s|^(n-1) grad s with n = 3 and A = 1e-16 Pa^-3 a^-1 at the melting point
// [cited]. Checked this session against the creep factor of temperate ice, 75 MPa^-3 a^-1 (Cuffey and Paterson 2010 as quoted by
// Roldan-Blasco et al. 2025, read: The Cryosphere 19: 267; their Argentiere inversion finds 148 on average, up to 4 times higher
// near the bed): 1e-16 lies between, so the unmodified constant stands [cited, checked].
export const GLEN = { n: 3, A: 1e-16 };
// R1634 Cold ice is stiffer than temperate by a factor of 10 to 100 (the research note, Arrhenius dependence not read): the least,
// 10, is taken, for ice over a bed under the melting point [INFERENCE].
export const COLD_FACTOR = 0.1;
// R1635 The bed is at the melting point (so it slides and erodes) where the mean annual air temperature at the surface is over -2 C: the
// threshold of the climate of fast erosion in R1461 (Cook et al. 2020: erosion above 10 mm a year needs a mean annual temperature
// over about -2 C) [derived from a pattern; ice insulates the bed, so a thick sheet is warmer at its bed than the air [gap]].
export const TEMPERATE_C = -2;
// R1636 Weertman's sliding law u_s = K_s tau_b^m, tau_b = rho g h |grad s|, the exponent in 2 to 4 (a summary of Weertman 1957 in the
// abstract of Journal of Glaciology 2011's review, read) and 3 taken, as the research note's. K_s sets what share of the motion is
// sliding and no source for it was read: 1e-13 m a^-1 Pa^-3 makes a glacier slide at 100 m a year under 100 kPa (a speed in the
// range of alpine valley glaciers, 10 to a few hundred m a year) [design, gap: a free coefficient; the erosion follows it as u^0.65].
export const SLIDING = { m: 3, K: 1e-13 };
// R1637 The erosion law e = K_g u_s^l (Herman et al. 2015, R1460, one glacier fitted: l = 2.02, K_g = 2.7e-7 m^(1-l) a^(l-1)) with the
// exponent and coefficient of the 38-glacier regression of Cook et al. (2020, R1461): l = 0.65 and K_g = 1e-4 (erosion in m a year,
// sliding in m a year); a sliding speed of 365 m a year gives 4.6 mm a year with Cook's, 40 with Herman's (the research note's
// comparison). Which law is a choice that a failing check must not move [design: Cook's is the default, Herman's the sensitivity].
export const EROSION = { cook: { K: 1e-4, l: 0.65 }, herman: { K: 2.7e-7, l: 2.02 } } as const;
// R1638 The fastest sliding the law is fitted to: 3 m a day (Herman et al. 2015: the surface velocities of Franz Josef by stereo
// imagery reached 3 m/day) [cited]; a faster computed speed cuts as this one.
export const U_CAP_M_YR = 3 * 365.25;
// R1639 The dissolved share of the rock removed, the erosion unit's (R1569) [UNVERIFIED]; the rest is sediment.
export const DISSOLVED_SHARE = DISSOLVED;
// R1640 A grounded glacier cuts only where rho_i h >= rho_w d (d the depth of the bed below the sea): the flotation limit, so a fjord is
// cut to at most 0.89 of the ice's thickness [derived, the research note]. Ice that is afloat is calved at once and its debris laid
// on the sea floor there [design: no ice shelf or floating tongue is simulated: gap].
// R1641 The ice's load depresses the bed by rho_i / rho_m of its thickness (Airy: 0.28) and the bed relaxes toward that with the time
// constant 4 pi mu / (rho g lambda) (R1411 eq. 6.105): 12,000 years for a load 1,000 km across (the planet's ice sheets are smaller
// than the Earth's 3,000 km) and mu = 1e21 Pa s [derived from the cited law]. A local relaxation: no flexure [gap].
export const RELAXATION_YR = 12_000;
// R1642 The flux cap and the step. The grid's conservative stencil is stable for a diffusion number D dt / (the mean cell's area)
// under 0.098 at the worst cell (grid.ts maxFo); 0.09 is the number its own tests run at, so the cap is 0.09. A link's number is
// that of the cell the ice comes from (the higher surface; the larger on a tie); a cell whose number would pass the cap is held at it, and a step is chosen so that the stiffest cell
// is at FO_TARGET: the cap binds only where the step is held under by DT_MIN [design, derived]. The cap changes the answer where it
// binds (the diffusivity there is smaller than Glen's): ice.advance counts the cells it cut.
export const FO_CAP = 0.09, FO_TARGET = 0.06, DT_MIN = 2;
// The step while no ice stands: the balance acts on bare ground for the whole step, so it is kept to 50 years until there is ice for the stiffness to set it [design].
const ICE_FREE_DT = 50;
// R1643 The ocean's area for the sea level's conversion: the cells whose bed is under the sea of the day, so the shelf the falling sea
// exposes is taken out of it [derived from R1464's form delta = -V rho_i / (rho_w A_ocean)]. Hydro-isostasy (the water's own load
// presses the sea floor down by 0.30 of its depth) and the gravitational fingerprint are not modelled [gap, R1464].

// ---------- 2. the laws in float: the oracles of the tests and the maps ----------
// Ablation, mm a year, at the summer air temperature t (C).
export const ablationMm = (t: number) => (t < T_ROOT ? 0 : Math.max(0, ABLATION.c2 * t * t + ABLATION.c1 * t + ABLATION.c0));
export const solidShare = (t: number) => Math.min(1, Math.max(0, (SNOW_TO - t) / (SNOW_TO - SNOW_FROM)));
// One cell's climate: the sea-level air temperature and the precipitation (mm a season) of four seasons, the index of its summer.
export interface CellClimate { ts: readonly number[]; p: readonly number[]; summer: number }
// The balance, mm of water a year, at height z (m above the sea of the climate) with the forcing's offset dT (K); zRef is the height the
// climate's precipitation was made for.
export function balanceMm(c: CellClimate, z: number, dT = 0, zRef = 0): number {
  let solid = 0, tSummer = 0;
  const ratio = Math.exp(-PRECIP_PER_K * LAPSE_K_M * (z - Math.max(zRef, 0)));
  for (let s = 0; s < 4; s++) {
    const t = c.ts[s] + dT - LAPSE_K_M * z;
    solid += c.p[s] * ratio * solidShare(t);
    if (s === c.summer) tSummer = t;
  }
  return solid - ablationMm(tSummer);
}
// The equilibrium line, m: the lowest height where the balance is not negative; Infinity where none under `top`, -Infinity at or under `bottom`.
export function elaOf(c: CellClimate, dT = 0, zRef = 0, bottom = -1000, top = 9000): number {
  if (balanceMm(c, top, dT, zRef) < 0) return Infinity;
  if (balanceMm(c, bottom, dT, zRef) >= 0) return -Infinity;
  let lo = bottom, hi = top;
  for (let i = 0; i < 60; i++) { const m = (lo + hi) / 2; if (balanceMm(c, m, dT, zRef) >= 0) hi = m; else lo = m; }
  return hi;
}
// The flux law's constants: Gamma = 2 A (rho_i g)^3 / 5 in m^-3 a^-1 (2.85e-5), and the sliding's K_s (rho_i g)^3 in m^-3 ... a^-1 per the units of u = K_s tau^3.
export const GAMMA_SIA = (2 * GLEN.A * (RHO_ICE * GRAVITY) ** GLEN.n) / (GLEN.n + 2);
export const SLIDE_PER_M3 = SLIDING.K * (RHO_ICE * GRAVITY) ** SLIDING.m;
// The diffusivity of the ice's surface, m2 a year: D = h^4 s^2 (Gamma h f_cold + K_s (rho g)^3 [temperate]) for the thickness h (m) and the slope s.
export const diffusivity = (h: number, s: number, temperate: boolean) => h ** 4 * s * s * (GAMMA_SIA * h * (temperate ? 1 : COLD_FACTOR) + (temperate ? SLIDE_PER_M3 : 0));
// The sliding speed, m a year, of ice h thick on slope s over a bed at the melting point.
export const slidingSpeed = (h: number, s: number) => SLIDING.K * (RHO_ICE * GRAVITY * h * s) ** SLIDING.m;
// The bed's erosion rate, m a year, for a sliding speed u (m a year), capped at the law's range.
export const erosionRate = (u: number, law: { K: number; l: number } = EROSION.cook) => law.K * Math.min(u, U_CAP_M_YR) ** law.l;
// The sea level (m) that an ice volume above flotation (m3) over an ocean of the given area (m2) leaves: -V rho_i / (rho_w A) (R1464).
export const seaLevelOf = (volumeAboveFlotationM3: number, oceanAreaM2: number) => -(volumeAboveFlotationM3 * RHO_ICE) / (RHO_MELT * oceanAreaM2);

// ---------- 3. the orbit and the forcing ----------
// R1644 The insolation of a season of the year is the atmosphere's daily mean (R1530) averaged over a quarter of the year in time
// centred on the solstice, along a Kepler orbit of eccentricity e whose perihelion lies at longitude varpi from the northern spring
// equinox and whose axis is tilted eps: the sun's declination from its longitude, the distance from the eccentric anomaly [cited law,
// derived integral]. The atmosphere's climate is of a circular orbit at the planet's tilt: the reference.
export function summerInsolation(latRad: number, ecc: number, varpiDeg: number, epsDeg: number, solar: number, centreDeg: number): number {
  const varpi = varpiDeg * DEG, nu0 = centreDeg * DEG - varpi;
  const E0 = 2 * Math.atan2(Math.sqrt(1 - ecc) * Math.sin(nu0 / 2), Math.sqrt(1 + ecc) * Math.cos(nu0 / 2)), M0 = E0 - ecc * Math.sin(E0);
  const n = 24;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const M = M0 + ((i + 0.5) / n) * (Math.PI / 2) - Math.PI / 4;
    let E = M;
    for (let k = 0; k < 8; k++) E -= (E - ecc * Math.sin(E) - M) / (1 - ecc * Math.cos(E));
    const nu = 2 * Math.atan2(Math.sqrt(1 + ecc) * Math.sin(E / 2), Math.sqrt(1 - ecc) * Math.cos(E / 2)), lam = nu + varpi, r = 1 - ecc * Math.cos(E);
    sum += insolation(latRad, Math.asin(Math.sin(epsDeg * DEG) * Math.sin(lam)), solar / (r * r));
  }
  return sum / n;
}
// R1645 The orbit's elements over time: obliquity eps0 +- 1.2 degrees with the period of 41 kyr (22.1 to 24.5 degrees, R1466), the
// eccentricity cycling over 0.0019 to 0.06 in 100 kyr (R1466, one term of the 100 and 405 kyr cycles), the precession of the
// perihelion's longitude in 21 kyr (19 and 23 kyr, R1438) [cited for the ranges, UNVERIFIED (R1466 is secondary); the planet's orbit
// is an input and Earth's elements an analogue]. The three phases are drawn from the seed (Philox stream 6): the only randomness.
export const ORBIT = { oblAmpDeg: 1.2, oblPeriodYr: 41_000, precPeriodYr: 21_000, eccLo: 0.0019, eccHi: 0.06, eccPeriodYr: 100_000 };
export interface Orbit { tiltDeg: number; solar: number; phase: [number, number, number] }
export function orbitOf(seed: number, tiltDeg = 23.4, solar = 1366): Orbit {
  rinit(seed, 6, 0, 0);
  return { tiltDeg, solar, phase: [0, 1, 2].map(() => (next32() / 4294967296) * 2 * Math.PI) as [number, number, number] };
}
export function elementsAt(o: Orbit, tYr: number) {
  const w = (period: number, ph: number) => (2 * Math.PI * tYr) / period + ph;
  return {
    epsDeg: o.tiltDeg + ORBIT.oblAmpDeg * Math.sin(w(ORBIT.oblPeriodYr, o.phase[0])),
    ecc: (ORBIT.eccLo + ORBIT.eccHi) / 2 + ((ORBIT.eccHi - ORBIT.eccLo) / 2) * Math.sin(w(ORBIT.eccPeriodYr, o.phase[1])),
    varpiDeg: (w(ORBIT.precPeriodYr, o.phase[2]) / DEG) % 360,
  };
}
// The summer insolation of a latitude (the summer of its own hemisphere) over the reference's, W/m2.
export function summerAnomaly(o: Orbit, tYr: number, latRad: number): number {
  const c = latRad >= 0 ? 90 : 270, e = elementsAt(o, tYr);
  return summerInsolation(latRad, e.ecc, e.varpiDeg, e.epsDeg, o.solar, c) - summerInsolation(latRad, 0, 0, o.tiltDeg, o.solar, c);
}
// R1646 The temperature that an insolation anomaly makes: the energy balance's response to a forcing of the second mode,
// (1 - alpha) / (B + 6 D) with the co-albedo of an ice-free surface (0.7), B = 2.09 W/m2/K and D the radius law's (R1437, R1606):
// 0.079 K per W/m2, so the 35 to 40 W/m2 of the 65 N summer anomaly at the last interglacial's end (R1438) is 3 K [derived]. No
// albedo, vapour or greenhouse feedback: they are what the next constant stands for.
export const SENSITIVITY_K_PER_WM2 = EBM.CO_FREE / (EBM.B + 6 * diffusionFor(2_000_000));
// R1647 The glacial maximum's global mean cooling, -6.1 C (95%: -6.5 to -5.7), from proxies and a model ensemble by data assimilation
// (Tierney et al. 2020, Nature 584: 569, abstract read) [cited]: the cooling from an interglacial (the atmosphere's climate, the planet
// as it stands) to the glacial maximum. What the orbit alone cannot give (the feedbacks) is taken as one gain: the forcing is scaled so
// that the swing of the 65 N summer anomaly over the run, from its strongest warming (offset 0) to its strongest cooling, is this [design].
// The cooling is the same at every latitude [gap: the real one is larger toward the poles].
export const DT_LGM = -6.1;
export const REFERENCE_LAT_DEG = 65;
// The forcing's offset at each degree of latitude from -90 to 90, K, at time t: base + gain * sensitivity * anomaly.
export function forcingTable(o: Orbit, tYr: number, f: { gain: number; base: number }): Float64Array {
  const out = new Float64Array(181);
  for (let k = 0; k <= 180; k++) out[k] = f.base + f.gain * SENSITIVITY_K_PER_WM2 * summerAnomaly(o, tYr, (k - 90) * DEG);
  return out;
}
// The gain and base that make the offset at 65 N run from 0 (the warmest) to the cited glacial cooling (the coldest) over [0, years]
// (sampled each `every` years).
export function lgmForcing(o: Orbit, years: number, every = 500, target = DT_LGM): { gain: number; base: number } {
  let lo = Infinity, hi = -Infinity;
  for (let t = 0; t <= years; t += every) { const a = SENSITIVITY_K_PER_WM2 * summerAnomaly(o, t, REFERENCE_LAT_DEG * DEG); lo = Math.min(lo, a); hi = Math.max(hi, a); }
  const gain = hi > lo ? target / (lo - hi) : 1;
  return { gain, base: -gain * hi };
}

// ---------- 4. the kernels' constants and parameter words ----------
export interface IceLaw { glenA: number; kSlide: number; coldFactor: number; erosion: { K: number; l: number }; uCap: number; relaxYr: number; foCap: number; dissolved: number }
export const defaultLaw = (over: Partial<IceLaw> = {}): IceLaw => ({ glenA: GLEN.A, kSlide: SLIDING.K, coldFactor: COLD_FACTOR, erosion: EROSION.cook, uCap: U_CAP_M_YR, relaxYr: RELAXATION_YR, foCap: FO_CAP, dissolved: DISSOLVED_SHARE, ...over });

// The kernels' fixed-point constants (R1648): the lapse's, the slope's and the ablation's, as integers.
export function kernelConstants(g: Grid): IceK {
  const W = g.radius * g.width, q16 = (x: number) => Math.round(x * 65536);
  return {
    lapq: Math.round((LAPSE_K_M * 65536 * 1024) / 64), pexp: Math.round((PRECIP_PER_K * LAPSE_K_M * 2 ** 30) / 64), slope24: Math.round((2 ** 24 * 16) / W), invRho24: Math.round(2 ** 24 / RHO_ICE),
    tRoot: Math.ceil(T_ROOT * 65536), c2: q16(ABLATION.c2), c1: q16(ABLATION.c1), c0: q16(ABLATION.c0), tTemp: q16(TEMPERATE_C),
    rhoI: RHO_ICE, rhoW: RHO_SEA, isoQ16: q16(RHO_ICE / RHO_MANTLE),
  };
}
// R1648 The formats [design, sized by the ranges, derived]: heights Q6 m (+-16 km in an i32 of the gradient's range); temperatures and
// precipitation Q16 (+-32,768 C or mm); the balance Q16 m of ice a year; volumes the tectonics unit V = H a / 16 (62,400 m3 on the
// mean cell, 0.49 mm of ice on it; 5 km of ice is 1e7 units, under 2^31); the diffusion number Q24; the erosion rate Q28 m a year
// (8 m a year is the top; the capped law's most is 0.4); the time step Q8 years (the least 1/256 a year, the most 2^24).
export const DTQ = 256;
// The parameter words of a step of dtYr years (rounded to 1/256 a year, the number of steps' unit) at sea level seaM (m, 0 the highstand).
export function stepWords(g: Grid, dtYr: number, seaM: number, law: IceLaw = defaultLaw()): Uint32Array {
  const w = new Uint32Array(64), dtq = Math.max(1, Math.round(dtYr * DTQ)), dt = dtq / DTQ, a0 = meanAreaM2(g), l2 = (x: number) => Math.round(Math.log2(x) * 65536);
  const rg3 = (RHO_ICE * GRAVITY) ** 3, gammaA = (2 * law.glenA * rg3) / (GLEN.n + 2), us = law.kSlide * rg3;
  w[0] = g.tiles; w[1] = g.fn; w[2] = tileCount(g);
  w[IP.sea6] = Math.round(seaM * 64) >>> 0; w[IP.dtq] = dtq;
  w[IP.logCd] = l2((dt * gammaA * 1e15) / a0) >>> 0; w[IP.logCdCold] = l2((dt * gammaA * law.coldFactor * 1e15) / a0) >>> 0;
  w[IP.logCs] = l2((dt * us * 1e12) / a0) >>> 0; w[IP.logCu] = l2(us * 1e9) >>> 0;
  w[IP.logKe] = l2(law.erosion.K) >>> 0; w[IP.expL] = Math.round(law.erosion.l * 65536);
  w[IP.iso] = Math.round((1 - Math.exp(-dt / law.relaxYr)) * 65536); w[IP.logUcap] = l2(law.uCap) >>> 0;
  w[IP.foCap] = Math.round(law.foCap * 2 ** 24); w[IP.diss16] = Math.round(law.dissolved * 65536);
  w[IP.elaLo] = (-1000 * 64) >>> 0; w[IP.elaHi] = 9000 * 64;
  return w;
}

// ---------- 5. the twin: every kernel in TypeScript ----------
const OFF = [1, PAD, -1, -PAD, PAD + 1, PAD - 1, -PAD - 1, -PAD + 1];
const shr = (x: number, n: number) => (x < 0 ? -Math.floor((-x + 2 ** (n - 1)) / 2 ** n) : Math.floor((x + 2 ** (n - 1)) / 2 ** n));
const shrB = (x: bigint, n: bigint) => (x < 0n ? -((-x + (1n << (n - 1n))) >> n) : (x + (1n << (n - 1n))) >> n);
const thick6 = (v: number, a: number) => Math.floor(v / a) * 1024 + Math.floor(((v % a) * 1024) / a);
const isqrt = (n: number) => { let x = Math.floor(Math.sqrt(n)); while (x * x > n) x--; while ((x + 1) * (x + 1) <= n) x++; return x; };

export interface StepStats { maxLog: number; cells: number; capped: number }

// The twin of one step's kernels on a copy of the state S (the padded layout, IF.COUNT fields), cell by cell: the same integers. Tier 0
// only: it walks the tables' tile order as if it were the flat cell order, which holds for one tile a face.
export class IceTwin {
  readonly g: Grid; readonly fw: number; readonly n: number; readonly pad: Int32Array;
  constructor(readonly tab: Tables, readonly k: IceK, readonly S: Int32Array) {
    this.g = tab.g; this.fw = fieldWords(this.g); this.n = tab.tw; this.pad = padMap(this.g);
    if (this.g.tiles !== 1) throw new Error("IceTwin: tier 0 only");
  }
  private gf = (f: number, at: number) => this.S[f * this.fw + at];
  private sf = (f: number, at: number, v: number) => { this.S[f * this.fw + at] = v | 0; };
  private tair(at: number, s: number, z6: number) { return this.gf(IF.TS + s, at) + this.gf(IF.DT, at) - shr(z6 * this.k.lapq, 10); }
  private ablation(t: number) {
    if (t < this.k.tRoot) return 0;
    return Math.max(qadd(qadd(qmul(this.k.c2, qmul(t, t)), qmul(this.k.c1, t)), this.k.c0), 0);
  }
  balAt(at: number, z6: number): number {
    let solid = 0, tSum = 0;
    const sidx = this.gf(IF.SUM, at), dz = z6 - Math.max(this.gf(IF.BED, at), 0), ratio = qexp(-shr(dz * this.k.pexp, 14));
    for (let s = 0; s < 4; s++) {
      const t = this.tair(at, s, z6), fs = Math.min(65536, Math.max(0, (65536 - t) >> 1));
      solid = qadd(solid, qmul(qmul(this.gf(IF.P + s, at), ratio), fs));
      if (s === sidx) tSum = t;
    }
    return qadd(solid, -this.ablation(tSum));
  }
  prep(par: Uint32Array) {
    const sea = par[IP.sea6] | 0;
    for (let idx = 0; idx < this.n; idx++) {
      const at = this.pad[idx], a = this.tab.words[idx];
      const bed = this.gf(IF.BED, at) - thick6(this.gf(IF.RCK, at), a) + thick6(this.gf(IF.SED, at), a) - ((this.gf(IF.DEP, at) + 32) >> 6), ice = this.gf(IF.ICE, at);
      const h = thick6(ice, a), srf = bed + h;
      this.sf(IF.BEF, at, bed); this.sf(IF.HQ, at, h); this.sf(IF.SRF, at, srf);
      let b = shr(this.balAt(at, srf) * this.k.invRho24, 24);
      if (bed < sea && ice === 0) b = 0;
      this.sf(IF.BAL, at, b);
      let tm = 0;
      for (let s = 0; s < 4; s++) tm += this.tair(at, s, srf);
      this.sf(IF.TMP, at, (tm >> 2) > this.k.tTemp ? 1 : 0);
    }
  }
  coef(par: Uint32Array): StepStats {
    const out: StepStats = { maxLog: 0, cells: 0, capped: 0 };
    const cap = par[IP.foCap];
    for (let idx = 0; idx < this.n; idx++) {
      const at = this.pad[idx], h6 = this.gf(IF.HQ, at);
      let foc = 0, ert = 0;
      if (h6 > 0) {
        const ge = this.gf(IF.GE, at), gn = this.gf(IF.GN, at), g6 = isqrt(ge * ge + gn * gn);
        const sl = Math.floor((g6 * this.k.slope24 + 2 ** 23) / 2 ** 24);
        if (sl > 0) {
          const temperate = this.gf(IF.TMP, at) === 1, hk = Math.floor((h6 * 1024) / 1000), lgh = qlog2(hk), lgs = qlog2(sl);
          const lcd = (temperate ? par[IP.logCd] : par[IP.logCdCold]) | 0, ld = lcd + 5 * lgh + 2 * lgs;
          let fo = exp2q(wide(ld + 524288)), worst = ld;
          if (temperate) {
            const ls = (par[IP.logCs] | 0) + 4 * lgh + 2 * lgs;
            fo = Math.min(fo + exp2q(wide(ls + 524288)), 0x7fffffff); worst = Math.max(worst, ls);
            const lu = Math.min((par[IP.logCu] | 0) + 3 * lgh + 3 * lgs, par[IP.logUcap] | 0);
            ert = exp2q(wide((par[IP.logKe] | 0) + qmul(par[IP.expL] | 0, lu) + 786432));
          }
          foc = Math.min(fo, cap);
          out.maxLog = Math.max(out.maxLog, worst + 1073741824); out.cells++;
          if (fo > cap) out.capped++;
        }
      }
      this.sf(IF.FOC, at, foc); this.sf(IF.ERT, at, ert);
    }
    return out;
  }
  private corner(at: number, q: number, q0: number, c: number, idx: number): number {
    let sum = 0;
    for (let m = 0; m < 4; m++) sum += this.tab.words[(TAB.V + 4 * c + m) * this.n + idx] * (this.S[q * this.fw + at + (m === 0 ? 0 : m === 1 ? OFF[c] : m === 2 ? OFF[(c + 1) & 3] : OFF[4 + c])] - q0);
    return sum;
  }
  demand(par: Uint32Array) {
    const dtq = BigInt(par[IP.dtq]);
    for (let idx = 0; idx < this.n; idx++) {
      const at = this.pad[idx], a = this.tab.words[idx], v0 = this.gf(IF.ICE, at), deb0 = this.gf(IF.DEB, at);
      const dv = Number(shrB(BigInt(this.gf(IF.BAL, at)) * dtq * BigInt(a), 28n)), acc = dv > 0 ? dv : 0, want = dv > 0 ? 0 : -dv, abl = Math.min(want, v0);
      let rel = 0;
      if (abl > 0) rel = abl >= v0 ? deb0 : Number((BigInt(deb0) * BigInt(abl)) / BigInt(v0));
      const v1 = v0 + acc - abl, deb1 = deb0 - rel;
      this.sf(IF.SED, at, this.gf(IF.SED, at) + rel); this.sf(IF.AC, at, this.gf(IF.AC, at) + acc); this.sf(IF.AB, at, this.gf(IF.AB, at) + abl);
      const q0 = this.S[IF.SRF * this.fw + at], foi = this.gf(IF.FOC, at);
      let out = 0;
      for (let d = 0; d < 4; d++) {
        const nb = at + OFF[d], ends = shr(this.corner(at, IF.SRF, q0, d, idx) - this.corner(at, IF.SRF, q0, (d + 3) & 3, idx), 14);
        const s = this.tab.words[(TAB.K + d) * this.n + idx] * (this.S[IF.SRF * this.fw + nb] - q0) + shr(this.tab.words[(TAB.C + d) * this.n + idx] * ends, 6);
        const qn = this.S[IF.SRF * this.fw + nb], fnb = this.gf(IF.FOC, nb), fo = qn > q0 ? fnb : qn < q0 ? foi : Math.max(foi, fnb);
        const vin = Number(shrB(shrB(BigInt(shr(s, 8)) * BigInt(fo), 25n), 10n));
        this.sf(IF.FL + d, at, vin);
        if (vin < 0) out += -vin;
      }
      let lam = 65536;
      if (out > v1) lam = Number((BigInt(v1) * 65536n) / BigInt(out));
      let con = 0;
      if (v1 > 0 && deb1 > 0) con = Math.min(Number((BigInt(deb1) * 65536n) / BigInt(v1)), 0x7fffffff);
      this.sf(IF.VST, at, v1); this.sf(IF.DST, at, deb1); this.sf(IF.OUT, at, out); this.sf(IF.LAM, at, lam); this.sf(IF.CON, at, con);
    }
  }
  move(par: Uint32Array) {
    const sea = par[IP.sea6] | 0, dtq = BigInt(par[IP.dtq]);
    for (let idx = 0; idx < this.n; idx++) {
      const at = this.pad[idx], a = this.tab.words[idx];
      let v = this.gf(IF.VST, at), deb = this.gf(IF.DST, at), sed = this.gf(IF.SED, at);
      for (let d = 0; d < 4; d++) {
        const vin = this.gf(IF.FL + d, at);
        if (vin > 0) {
          const nb = at + OFF[d], mv = Math.floor((vin * this.gf(IF.LAM, nb)) / 65536);
          v += mv; deb += Number((BigInt(mv) * BigInt(this.gf(IF.CON, nb))) >> 16n);
        } else if (vin < 0) {
          const mv = Math.floor((-vin * this.gf(IF.LAM, at)) / 65536);
          v -= mv; deb -= Number((BigInt(mv) * BigInt(this.gf(IF.CON, at))) >> 16n);
        }
      }
      const h0 = this.gf(IF.HQ, at), ert = this.gf(IF.ERT, at);
      let er = 0, ds = 0;
      if (h0 > 0 && ert > 0) {
        er = Number(((BigInt(ert) * dtq * BigInt(a)) + (1n << 39n)) >> 40n);
        ds = Number(((BigInt(this.gf(IF.RCK, at)) + BigInt(er)) * BigInt(par[IP.diss16])) >> 16n) - this.gf(IF.DS, at);
        deb += er - ds;
      }
      const bed = this.gf(IF.BEF, at);
      let cal = 0;
      if (v > 0 && bed < sea && thick6(v, a) * this.k.rhoI < (sea - bed) * this.k.rhoW) { cal = v; sed += deb; v = 0; deb = 0; }
      const tgt = Number((BigInt(Math.max(h0, 0)) * BigInt(this.k.isoQ16)) >> 10n), dep = this.gf(IF.DEP, at);
      this.sf(IF.DEP, at, dep + shr((tgt - dep) * (par[IP.iso] | 0), 16));
      this.sf(IF.ICE, at, v); this.sf(IF.DEB, at, deb); this.sf(IF.SED, at, sed);
      this.sf(IF.RCK, at, this.gf(IF.RCK, at) + er); this.sf(IF.DS, at, this.gf(IF.DS, at) + ds); this.sf(IF.CV, at, this.gf(IF.CV, at) + cal);
    }
  }
  ela(par: Uint32Array) {
    const lo = par[IP.elaLo] | 0, hi = par[IP.elaHi] | 0;
    for (let idx = 0; idx < this.n; idx++) {
      const at = this.pad[idx];
      let res = 2147483647;
      if (this.balAt(at, hi) >= 0) {
        let l = lo, h = hi;
        if (this.balAt(at, lo) >= 0) h = lo;
        else for (let it = 0; it < 24; it++) { const m = l + ((h - l) >> 1); if (this.balAt(at, m) >= 0) h = m; else l = m; }
        res = h;
      }
      this.sf(IF.ELA, at, res);
    }
  }
  // One whole step, the halo exchanges between the kernels as the host records them.
  step(par: Uint32Array): StepStats {
    this.prep(par);
    haloTwin(this.g, this.S, IF.SRF); gradientTwin(this.tab, this.S, IF.SRF, IF.GE, IF.GN);
    const stats = this.coef(par);
    haloTwin(this.g, this.S, IF.FOC);
    this.demand(par);
    haloTwin(this.g, this.S, IF.LAM); haloTwin(this.g, this.S, IF.CON);
    this.move(par);
    return stats;
  }
}

// ---------- 6. the kernels on a device ----------
export interface IceInputs {
  bed: ArrayLike<number>; // m above the sea of the climate (the highstand), in cell order
  ts: ArrayLike<number>[]; // the air's sea-level temperature, C, four seasons (spring, summer, autumn, winter as the atmosphere's)
  precip: ArrayLike<number>[]; // precipitation of all kinds, mm over the season, four seasons
}
// The season each cell's summer is: the warmest of the four at sea level (June to August where that is the warmest, as the fit's T is).
export function summerIndex(ts: ArrayLike<number>[], n: number): Uint8Array {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) { let best = 0; for (let s = 1; s < 4; s++) if (ts[s][i] > ts[best][i]) best = s; out[i] = best; }
  return out;
}
const clampQ16 = (x: number) => Math.max(-(2 ** 30), Math.min(2 ** 30, Math.round(x * 65536)));

export interface Advance { years: number; steps: number; dtMean: number; foMax: number; capped: number; iceCellSteps: number }

export class IceGpu {
  readonly g: Grid; readonly N: number; readonly fw: number;
  readonly S: GPUBuffer;
  private readonly T: GPUBuffer; private readonly A: GPUBuffer;
  private readonly wgsl: string; private readonly pm: GPUBuffer;
  private readonly aux = new Map<string, GPUBuffer>();
  private readonly pad: Int32Array;
  seaM = 0; dtYr = 8;
  readonly areas: Float64Array; // each cell's area, steradians
  readonly latDeg: Float32Array;
  readonly aw: Int32Array; // each cell's area weight (1/32,768 of the tier's mean cell), flat order: a volume v is v * 16 / aw m thick
  constructor(readonly gpu: Gpu, readonly tab: Tables, readonly inputs: IceInputs, public law: IceLaw = defaultLaw()) {
    this.g = tab.g; this.N = FACES * this.g.fn * this.g.fn; this.fw = fieldWords(this.g);
    this.aw = new Int32Array(this.N);
    for (let f = 0; f < FACES; f++) for (let Y = 0; Y < this.g.fn; Y++) for (let X = 0; X < this.g.fn; X++) this.aw[(f * this.g.fn + Y) * this.g.fn + X] = tab.words[slotOf(this.g, f, X, Y) * TILE_WORDS + inTile(X, Y)];
    this.pad = padMap(this.g); this.areas = cellAreas(this.g);
    const vec = cellVectors(this.g);
    this.latDeg = Float32Array.from({ length: this.N }, (_, i) => Math.asin(vec[3 * i + 2]) / DEG);
    this.S = storage(gpu, this.fw * IF.COUNT * 4);
    this.T = storage(gpu, tab.words);
    this.A = storage(gpu, AW.COUNT * 4);
    this.pm = storage(gpu, 64 * 4);
    this.wgsl = iceWgsl(EDGES, kernelConstants(this.g));
    this.write(IF.BED, Int32Array.from({ length: this.N }, (_, i) => Math.round(inputs.bed[i] * 64)));
    for (let s = 0; s < 4; s++) {
      this.write(IF.TS + s, Int32Array.from({ length: this.N }, (_, i) => clampQ16(inputs.ts[s][i])));
      this.write(IF.P + s, Int32Array.from({ length: this.N }, (_, i) => clampQ16(inputs.precip[s][i])));
    }
    this.write(IF.SUM, Int32Array.from(summerIndex(inputs.ts, this.N)));
  }
  private padded(flat: ArrayLike<number>): Int32Array {
    const out = new Int32Array(this.fw);
    for (let i = 0; i < this.N; i++) out[this.pad[i]] = flat[i];
    return out;
  }
  // A field in flat cell order into the state.
  write(field: number, flat: ArrayLike<number>) { this.gpu.device.queue.writeBuffer(this.S, field * this.fw * 4, this.padded(flat)); }
  async read(field: number): Promise<Int32Array> {
    const words = new Int32Array(await readback(this.gpu, this.S, this.fw * 4, field * this.fw * 4)), out = new Int32Array(this.N);
    for (let i = 0; i < this.N; i++) out[i] = words[this.pad[i]];
    return out;
  }
  // The whole state in the padded layout (for the twin's comparison).
  async readState(): Promise<Int32Array> { return new Int32Array(await readback(this.gpu, this.S, this.fw * IF.COUNT * 4)); }
  writeState(S: Int32Array) { this.gpu.device.queue.writeBuffer(this.S, 0, S.buffer, S.byteOffset, S.byteLength); }
  // The forcing's offset, K: one number, or one for each cell.
  setOffset(dT: number | ArrayLike<number>) { this.write(IF.DT, Int32Array.from({ length: this.N }, (_, i) => clampQ16(typeof dT === "number" ? dT : dT[i]))); }
  private aux1(key: string, words: Uint32Array) {
    let b = this.aux.get(key);
    if (!b) { b = storage(this.gpu, words); this.aux.set(key, b); }
    return b;
  }
  private haloBuf(f: number) { const w = new Uint32Array(16); w[0] = this.g.tiles; w[1] = this.g.fn; w[2] = tileCount(this.g); w[3] = 0; w[4] = f; return this.aux1(`halo${f}`, w); }
  private gradBuf() { const w = new Uint32Array(16); w[0] = this.g.tiles; w[1] = this.g.fn; w[2] = tileCount(this.g); w[6] = IF.SRF; w[10] = IF.GE; w[11] = IF.GN; return this.aux1("grad", w); }
  private readonly groups = new Map<string, GPUBindGroup>();
  private rec(enc: GPUCommandEncoder, entry: string, P: GPUBuffer, threads: number, withA: boolean, key: string) {
    const p = pipeline(this.gpu, this.wgsl, entry);
    let bind = this.groups.get(key);
    if (!bind) {
      bind = this.gpu.device.createBindGroup({ layout: p.getBindGroupLayout(0), entries: (withA ? [this.S, this.T, P, this.A] : [this.S, this.T, P]).map((buffer, binding) => ({ binding, resource: { buffer } })) });
      this.groups.set(key, bind);
    }
    const pass = enc.beginComputePass(), gr = cover(this.gpu, threads);
    pass.setPipeline(p); pass.setBindGroup(0, bind); pass.dispatchWorkgroups(gr[0], gr[1]); pass.end();
  }
  private recordStep(enc: GPUCommandEncoder) {
    const N = this.N, halo = (f: number) => this.rec(enc, "halo", this.haloBuf(f), tileCount(this.g) * (2 * 256 + 2 * PAD), false, `halo${f}`);
    this.rec(enc, "prep", this.pm, N, true, "prep");
    halo(IF.SRF);
    this.rec(enc, "grad", this.gradBuf(), N, false, "grad");
    this.rec(enc, "coef", this.pm, N, true, "coef");
    halo(IF.FOC);
    this.rec(enc, "demand", this.pm, N, true, "demand");
    halo(IF.LAM); halo(IF.CON);
    this.rec(enc, "carry", this.pm, N, true, "carry");
  }
  // `n` steps of dtYr years each at the current sea level, in one submission: returns what the batch's stiffest cell and flux cap did.
  async batch(n: number, dtYr: number): Promise<{ maxLog: number; cells: number; capped: number; dtQ: number }> {
    const w = stepWords(this.g, dtYr, this.seaM, this.law);
    this.gpu.device.queue.writeBuffer(this.pm, 0, w);
    this.gpu.device.queue.writeBuffer(this.A, 0, new Uint32Array(AW.COUNT));
    const enc = this.gpu.device.createCommandEncoder();
    for (let i = 0; i < n; i++) this.recordStep(enc);
    this.gpu.device.queue.submit([enc.finish()]);
    const a = new Uint32Array(await readback(this.gpu, this.A, AW.COUNT * 4));
    return { maxLog: a[AW.maxLog], cells: a[AW.cells], capped: a[AW.capped], dtQ: w[IP.dtq] };
  }
  // The equilibrium line of every cell (Q6 m; 2^31 - 1 where there is none under 9 km) for the climate and the offset now set.
  async ela(): Promise<Int32Array> {
    this.gpu.device.queue.writeBuffer(this.pm, 0, stepWords(this.g, 1, this.seaM, this.law));
    const enc = this.gpu.device.createCommandEncoder();
    this.rec(enc, "ela", this.pm, this.N, true, "ela");
    this.gpu.device.queue.submit([enc.finish()]);
    return this.read(IF.ELA);
  }
  // Advance `years` of the current forcing and sea level in steps chosen so that the stiffest cell sits at the target diffusion
  // number, never under dtMin (the cost's floor) nor over dtMax; the batch is `batchSteps` steps at one dt.
  async advance(years: number, o: { dtMin?: number; dtMax?: number; foTarget?: number; batchSteps?: number } = {}): Promise<Advance> {
    const dtMin = o.dtMin ?? DT_MIN, dtMax = o.dtMax ?? years, target = o.foTarget ?? FO_TARGET, bs = o.batchSteps ?? 8;
    const res: Advance = { years: 0, steps: 0, dtMean: 0, foMax: 0, capped: 0, iceCellSteps: 0 };
    let dt = Math.min(Math.max(this.dtYr, dtMin), dtMax);
    while (res.years < years - 1 / DTQ) {
      const left = years - res.years;
      dt = Math.max(1 / DTQ, Math.min(dt, left));
      const n = Math.max(1, Math.min(bs, Math.floor(left / dt + 1e-9)));
      const b = await this.batch(n, dt);
      const dtEff = b.dtQ / DTQ;
      res.years += n * dtEff; res.steps += n; res.capped += b.capped; res.iceCellSteps += b.cells;
      const foMax = b.maxLog === 0 ? 0 : 2 ** ((b.maxLog - LOG_OFFSET) / 65536);
      res.foMax = Math.max(res.foMax, foMax);
      dt = foMax === 0 ? Math.min(dtMax, ICE_FREE_DT) : Math.min(dtMax, Math.max(dtMin, (dtEff * target) / foMax));
      this.dtYr = dt;
    }
    res.dtMean = res.steps > 0 ? res.years / res.steps : 0;
    return res;
  }
  release() { for (const b of [this.S, this.T, this.A, this.pm, ...this.aux.values()]) b.destroy(); this.aux.clear(); this.groups.clear(); }
}

// ---------- 7. the sea level and the books ----------
export interface IceBooks {
  ice: bigint; // volume units now
  debris: bigint; rock: bigint; sediment: bigint; dissolved: bigint; accumulated: bigint; ablated: bigint; calved: bigint;
}
const sumField = (a: Int32Array) => { let s = 0n; for (let i = 0; i < a.length; i++) s += BigInt(a[i] >>> 0); return s; };
export async function books(ice: IceGpu): Promise<IceBooks> {
  const f = await Promise.all([IF.ICE, IF.DEB, IF.RCK, IF.SED, IF.DS, IF.AC, IF.AB, IF.CV].map((x) => ice.read(x)));
  const [i, d, r, s, ds, ac, ab, cv] = f.map(sumField);
  return { ice: i, debris: d, rock: r, sediment: s, dissolved: ds, accumulated: ac, ablated: ab, calved: cv };
}
// The m3 of one volume unit on the grid: a mean cell's area times 16 m over 2^15.
export const unitM3 = (g: Grid) => (meanAreaM2(g) * 16) / 2 ** 15;

export interface SeaState { iceM3: number; aboveFlotationM3: number; seaM: number; oceanM2: number; iceAreaM2: number }
// The ice's volume, its part above flotation, the ocean's area at the sea level asked and the sea level the ice leaves (one pass of the
// fixed point of the sea level and the ocean's area, which moves slowly with the sea).
export async function seaState(ice: IceGpu, seaGuessM: number): Promise<SeaState> {
  const [v, bed] = await Promise.all([ice.read(IF.ICE), ice.read(IF.BEF)]), g = ice.g, u = unitM3(g);
  const bed0 = await ice.read(IF.BED), N = ice.N, ar = ice.areas, R2 = g.radius * g.radius;
  let total = 0, af = 0, iceArea = 0, ocean = 0;
  for (let i = 0; i < N; i++) {
    const area = ar[i] * R2;
    if (bed0[i] / 64 < seaGuessM) ocean += area;
    if (v[i] <= 0) continue;
    iceArea += area; total += v[i] * u;
    const d = Math.max(0, seaGuessM - bed[i] / 64), displaced = (RHO_SEA / RHO_ICE) * ((d * ice.aw[i]) / 16);
    af += Math.max(0, v[i] - displaced) * u;
  }
  return { iceM3: total, aboveFlotationM3: af, oceanM2: ocean, iceAreaM2: iceArea, seaM: seaLevelOf(af, ocean) };
}

// ---------- 8. a run: the forcing and the sea level, outer step by outer step ----------
export interface IceRecord {
  tYr: number; seaM: number; iceKm3: number; iceAreaKm2: number; aboveFlotationKm3: number; offset65: number; // the offset at 65 degrees of the northern hemisphere, K
  steps: number; dtMean: number; foMax: number; cappedShare: number; // of the cell-steps that held ice, the share the flux cap held
}
export interface IceRunSpec {
  years: number; outerYr: number;
  // The forcing's offset, K, at time t: a number for all cells, or a table of 181 values by degree of latitude from -90.
  offset: (tYr: number) => number | Float64Array;
  dtMin?: number; dtMax?: number;
  onOuter?: (rec: IceRecord, ice: IceGpu) => void | Promise<void>;
}
// Interpolate a latitude table at each cell.
export function offsetField(latDeg: ArrayLike<number>, table: Float64Array): Float32Array {
  const out = new Float32Array(latDeg.length);
  for (let i = 0; i < out.length; i++) {
    const x = Math.min(179.999, Math.max(0, latDeg[i] + 90)), k = Math.floor(x), f = x - k;
    out[i] = table[k] * (1 - f) + table[k + 1] * f;
  }
  return out;
}
export async function runIce(ice: IceGpu, spec: IceRunSpec): Promise<IceRecord[]> {
  const out: IceRecord[] = [];
  for (let t = 0; t < spec.years - 1e-9; t += spec.outerYr) {
    const f = spec.offset(t + spec.outerYr / 2);
    ice.setOffset(typeof f === "number" ? f : offsetField(ice.latDeg, f));
    const adv = await ice.advance(Math.min(spec.outerYr, spec.years - t), { dtMin: spec.dtMin, dtMax: spec.dtMax ?? spec.outerYr });
    const sea = await seaState(ice, ice.seaM);
    ice.seaM = sea.seaM;
    const rec: IceRecord = {
      tYr: t + adv.years, seaM: sea.seaM, iceKm3: sea.iceM3 / 1e9, iceAreaKm2: sea.iceAreaM2 / 1e6, aboveFlotationKm3: sea.aboveFlotationM3 / 1e9,
      offset65: typeof f === "number" ? f : f[155], steps: adv.steps, dtMean: adv.dtMean, foMax: adv.foMax, cappedShare: adv.iceCellSteps > 0 ? adv.capped / adv.iceCellSteps : 0,
    };
    out.push(rec);
    if (spec.onOuter) await spec.onOuter(rec, ice);
  }
  return out;
}

// ---------- 9. what the ice left ----------
// The bed (m above the highstand sea) before and after: the initial bed, and that less the rock the ice cut plus the sediment it laid.
export async function bedsOf(ice: IceGpu): Promise<{ before: Float32Array; after: Float32Array; cut: Float32Array }> {
  const [bed, rck, sed] = await Promise.all([IF.BED, IF.RCK, IF.SED].map((f) => ice.read(f))), N = ice.N;
  const before = new Float32Array(N), after = new Float32Array(N), cut = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const a = ice.aw[i], c = thick6(rck[i], a) / 64, s = thick6(sed[i], a) / 64;
    before[i] = bed[i] / 64; cut[i] = c; after[i] = bed[i] / 64 - c + s;
  }
  return { before, after, cut };
}
// Eight-neighbour components of a mask (a diagonal step goes through the grid's four-neighbour table twice).
export function components8(g: Grid, mask: ArrayLike<number>): { label: Int32Array; cells: number[] } {
  const N = FACES * g.fn * g.fn, nb = neighbours(g), label = new Int32Array(N).fill(-1), cells: number[] = [], stack = new Int32Array(N);
  for (let s = 0; s < N; s++) {
    if (!mask[s] || label[s] >= 0) continue;
    const id = cells.length;
    let sp = 0, n = 0;
    stack[sp++] = s; label[s] = id;
    while (sp > 0) {
      const i = stack[--sp];
      n++;
      for (let k = 0; k < 8; k++) {
        const a = nb[4 * i + (k & 3)], j = k < 4 ? a : nb[4 * a + ((k + 1) & 3)];
        if (mask[j] && label[j] < 0) { label[j] = id; stack[sp++] = j; }
      }
    }
    cells.push(n);
  }
  return { label, cells };
}
export interface Trough { cells: number; lengthKm: number; widthKm: number; deepestM: number; deepestAt: number; marine: boolean; inlandKm: number }
// The drowned troughs: connected sets of cells that were land at the highstand and whose bed is now under it. A trough's length is the
// diameter of its set (the longest shortest path between two of its cells, chamfer 5 and 7 over eight neighbours, from the farthest
// cell of a start to the farthest from that) and its width the cells' area over it; it is marine (a fjord or a drowned valley) where one
// of its cells borders the highstand's sea, and otherwise a basin cut below the sea inside the land (a lake); its inland reach is the
// largest distance of its cells from the highstand's sea through the land, which tells a trough cut into the land (a fjord's reach is
// its length) from a strip cut along the coast (a reach of one cell) [design: a measure, not a definition of a fjord].
export function troughs(g: Grid, before: ArrayLike<number>, after: ArrayLike<number>): Trough[] {
  const N = FACES * g.fn * g.fn, mask = new Uint8Array(N), areas = cellAreas(g), nb = neighbours(g), R2 = g.radius * g.radius, cellKm = (g.radius * g.width) / 1000;
  for (let i = 0; i < N; i++) mask[i] = before[i] >= 0 && after[i] < 0 ? 1 : 0;
  const { label, cells } = components8(g, mask);
  const far = (s: number, id: number) => {
    const dist = new Map<number, number>([[s, 0]]), todo: number[][] = [[s]];
    let best = s, bestD = 0;
    for (let level = 0; level < todo.length; level++)
      for (const i of todo[level] ?? []) {
        if (dist.get(i)! !== level) continue;
        if (level > bestD) { bestD = level; best = i; }
        for (let k = 0; k < 8; k++) {
          const a = nb[4 * i + (k & 3)], j = k < 4 ? a : nb[4 * a + ((k + 1) & 3)], nd = level + (k < 4 ? 5 : 7);
          if (label[j] !== id) continue;
          if ((dist.get(j) ?? Infinity) > nd) { dist.set(j, nd); (todo[nd] ??= []).push(j); }
        }
      }
    return { best, bestD };
  };
  const toSea = new Int32Array(N).fill(2 ** 30), bucket: number[][] = [[]];
  for (let i = 0; i < N; i++) if (before[i] < 0) { toSea[i] = 0; bucket[0].push(i); }
  for (let d = 0; d < bucket.length; d++)
    for (const i of bucket[d] ?? []) {
      if (toSea[i] !== d) continue;
      for (let k = 0; k < 8; k++) {
        const a = nb[4 * i + (k & 3)], j = k < 4 ? a : nb[4 * a + ((k + 1) & 3)], nd = d + (k < 4 ? 5 : 7);
        if (before[j] >= 0 && nd < toSea[j]) { toSea[j] = nd; (bucket[nd] ??= []).push(j); }
      }
    }
  const first = new Map<number, number>(), area = new Float64Array(cells.length), deepest = new Float64Array(cells.length), deepestAt = new Int32Array(cells.length), marine = new Uint8Array(cells.length), reach = new Int32Array(cells.length);
  for (let i = 0; i < N; i++) if (label[i] >= 0) {
    if (!first.has(label[i])) first.set(label[i], i);
    area[label[i]] += areas[i] * R2;
    if (-after[i] > deepest[label[i]]) { deepest[label[i]] = -after[i]; deepestAt[label[i]] = i; }
    for (let k = 0; k < 4; k++) if (before[nb[4 * i + k]] < 0) marine[label[i]] = 1;
    reach[label[i]] = Math.max(reach[label[i]], toSea[i]);
  }
  const out: Trough[] = [];
  for (const [id, s] of first) {
    const a = far(s, id), b = far(a.best, id), len = Math.max(1, b.bestD / 5) * cellKm;
    out.push({ cells: cells[id], lengthKm: len, widthKm: area[id] / 1e6 / len, deepestM: deepest[id], deepestAt: deepestAt[id], marine: marine[id] === 1, inlandKm: (reach[id] / 5) * cellKm });
  }
  return out.sort((x, y) => y.lengthKm - x.lengthKm);
}
// The number of land components (land: the bed over the highstand sea) with at least one cell, for the islands the ice made.
export const landComponents = (g: Grid, bed: ArrayLike<number>) => components8(g, Array.from({ length: bed.length }, (_, i) => (bed[i] >= 0 ? 1 : 0))).cells.length;
