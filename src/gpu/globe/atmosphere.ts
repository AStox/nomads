// The globe's atmosphere (plan Unit 4, with the minimum of Unit 5): from a height field on the sphere grid, a sea level and the
// planet's radius, tilt, rotation and solar constant, the four seasons' insolation, near-surface temperature, prevailing
// surface wind, sea-surface temperature, sea ice, precipitation (rain and snow), evaporation and runoff. The laws, the sources
// and every place the planet's smallness changes an answer: docs/research/globe/2026-10-19-atmosphere-impl.md (laws chosen in
// docs/research/globe/2026-10-19-atmosphere.md and 2026-10-19-ocean.md). Kernels: wgsl/globe-atmosphere.ts. References R1530
// to R1559 are this file's; R1430 to R1459 are the research notes'.
//
// What is a cited law and what a [design] simplification, in one place:
// - cited law: the daily-mean insolation (R1438), the Budyko-Sellers energy balance with North et al.'s constants, ice line
//   and heat capacities (R1437), Tetens' saturation vapour pressure (R221) which gives Clausius-Clapeyron's 7% a kelvin
//   (R1436), the lapse rate (R494), the Held-Hou equal-area edge of the Hadley cell (R1433), the surface torque balance
//   (R1431), the Ekman turning of the surface wind (R1451's relation, used in the air), the rain stage's cloud delays (R1320 to
//   R1323) and Stefan's ice law (R1411).
// - [design]: the zonal-mean circulation's wind profile (lobes), the eddy diffusivity's scaling with the radius, the
//   column's budget scheme and the upwind advection of vapour, cloud and temperature, the land's bucket (none stored), the
//   terrain's blocking, the sea's coast by the air's adjustment length, and every number tagged so below.
// - Smith and Barstad's transfer is NOT used: its tangent-plane windows would need 64 x 64 cells of 12 km with a halo from
//   neighbouring faces, and its validity (hills over 20 km) is two cells here; the moisture budget the research note
//   recommends in its place runs on the sphere grid directly (see the impl note, sec. 6).
import type { Gpu } from "../device";
import { qdiv, qexp, qmul, qsqrt } from "../fixed";
import { cover, pipeline, readback, storage } from "../kernel";
import { H_W, LAPSE, N_M } from "../../terrain/climate";
import { TAU_C_ICE, TAU_C_WARM, TAU_F_RAIN, V_SNOW } from "../terrain/rain";
import {
  CAP_FROM, CAP_PER_K, FIELD, GEO, NCAP, NODES, NODE_DEG, PARAM, TAB, TABLE_WORDS, atmosphereWgsl, type Kq,
} from "../wgsl/globe-atmosphere";
import {
  FACES, GlobeGpu, RADIUS_M, STATE as GRID_STATE, areaSr, buildTables, cellId, cellWidthM, centre, eastNorth, latLon, padded, step,
  vertex, wordAt, type Grid, type Tables,
} from "./grid";

export { FIELD, NODES };

// ---------- 1. planet and constants ----------
export interface PlanetParams {
  radius: number; // m
  tiltDeg: number; // the axis's tilt to the orbit, degrees
  dayS: number; // the rotation period, s
  solar: number; // the solar constant, W/m2
  seaLevel: number; // m: the height field's zero of the sea
  gravity: number; // m/s2
  diffusion?: number; // the energy balance's D, W/m2/K, where not the radius-scaled default (a sensitivity, see solveEbm)
}
// A 2,000 km planet with a 24 h day and Earth's tilt [design: the operator's decisions of 2026-10-19]; the solar constant is
// 1366 W/m2 (Kostadinov and Gilb, R1438: 1361 in Kopp and Lean 2011) [cited]; gravity stays 9.81 so every law the game holds
// stays true [design: the planet is then unphysical, 17.6 g/cm3, the atmosphere note sec. 4].
export const DEFAULT_PLANET: PlanetParams = { radius: RADIUS_M, tiltDeg: 23.4, dayS: 86_400, solar: 1366, seaLevel: 0, gravity: 9.81 };
export const planetOf = (p: Partial<PlanetParams> = {}): PlanetParams => ({ ...DEFAULT_PLANET, ...p });

const DEG = Math.PI / 180;
// A year of 365.25 days of 86,400 s, as the island generator's seasons (water.ts YEAR_S): only the heat capacities and the
// season's length use it, the orbit being a circle [design: eccentricity 0; Earth's 0.0167 changes the flux 3%].
export const YEAR_S = 31_557_600;
export const SEASON_S = YEAR_S / 4;
export const SEASONS = ["spring", "summer", "autumn", "winter"] as const;
// Earth's radius and sidereal rotation rate, the calibration of the circulation's scaling [cited: standard values].
const EARTH_R = 6.371e6, EARTH_OMEGA = 7.292e-5;

// North, Cahalan and Coakley (R1437): A 203.3 W/m2 and B 2.09 W/m2/K of the outgoing radiation A + B T (T in C), D 0.649
// W/m2/K the diffusion fitted to the observed second mode, the co-albedos 0.70 (ice free) and 0.38 (ice covered), the ice
// line at the -10 C isotherm, heat capacities per area 0.16 B years (land) and 4.7 B years (a 75 m mixed layer) [cited].
export const EBM = { A: 203.3, B: 2.09, D_EARTH: 0.649, CO_FREE: 0.7, CO_ICE: 0.38, ICE_LINE: -10, CL_YR: 0.16, CW_YR: 4.7 };
// The ice line in the local balance is a ramp 4 K wide, so that a column marched in time does not flip between two albedos
// each step [design: numerical smoothing of the cited step].
export const ICE_RAMP = 4;
// Moist-adiabatic lifting and the environment's lapse rate are both the standard atmosphere's (R494; climate.ts LAPSE) [cited;
// the two differ by under 1 K/km, atmosphere note sec. 2, and one value stands for both: design].
export const GAMMA = LAPSE;
// The moist layer's depth, the water vapour scale height (R1320; climate.ts H_W) and the gas constant of vapour [cited].
export const H_WATER = H_W;
const R_VAPOUR = 461.5;
// Tetens' saturation vapour pressure e_s = 0.6108 exp(17.27 T / (T + 237.3)) kPa (FAO-56, R221) [cited].
const TETENS = { E0: 0.6108, A: 17.27, B: 237.3 };
// The column's saturation, mm of water: rho_vs H_w = e_s H_w / (R_v T), 1000 H_w / R_v = 5,417 in kPa to mm K.
const COLUMN = (1000 * H_WATER) / R_VAPOUR;
// Share of a column's saturation the first state of a run holds [design: the sea's air sits at about 0.75 of saturation (the
// global precipitable water 24.6 mm against 32 mm at 15 C, R1434)]; the run goes on until the answer no longer depends on it.
export const FIRST_SHARE = 0.6;
// The bulk exchange coefficient of evaporation, 1.2e-3 [UNVERIFIED: the usual value of 1.1 to 1.5e-3, not read; Fairall et al.
// 2003 named and not read in the atmosphere note]; the evaporation rate of a cell is C_E |U| (q_sat - q) / H_w for a column
// of saturation q_sat and water q, so C_E / H_w per m of wind. The least wind the exchange sees is 2 m/s [design: gustiness].
export const C_EVAP = 1.2e-3, GUST = 2;
// The air above a surface adjusts to it in rho c_p H / h seconds, H 1 km of the lowest layer, h 15 W/m2/K of exchange, rho 1.2
// and c_p 1005 [INFERENCE: the ocean note sec. "A minimal law", h, H and the form are not from a source read]: 0.93 days, so an
// e-fold length of U times that, 560 km at 7 m/s. Not fitted to the validation facts.
export const AIR = { rho: 1.2, cp: 1005, depth: 1000, exchange: 15 };
export const ADJUST_S = (AIR.rho * AIR.cp * AIR.depth) / AIR.exchange;
// Sea water freezes at -1.8 C [UNVERIFIED: the usual value for 35 psu, not read]; sea ice grows by Stefan's law h^2 = 2 k
// (T_f - T) t / (rho L), k 2 W/m/K, rho 1000, L 320 kJ/kg (R1411, exercise 4.37) over the season's length [derived: the ice has
// grown for the whole season at the season's mean, a design simplification of the ice's history].
export const T_FREEZE = -1.8, ICE_K = 2, ICE_RHO = 1000, ICE_L = 320e3;
// Precipitation is snow below -1 C, rain above +1 C and a linear mixture between [design: the rain-snow transition is a few
// kelvin wide; Dai's land fit has its half-point at 1.3 C with a 0.67 C spread, R492 of climate.ts: this is the same order,
// with the ground temperature standing for the wet bulb].
export const SNOW_LO = -1, SNOW_HI = 1;
// The terrain blocks the wind that climbs a slope when the Froude number U / (N_m z) falls under 1, z the rise over four cells
// (about 49 km) at the cell's slope, N_m 0.005 /s the saturated stability of the rain stage (R1320) [design: after Smith's
// regimes; a barrier of this scale in a flow of this Froude number]. The blocked share is 1 - Fr, and the wind's upslope part
// is turned along the contours by that share.
export const BLOCK_CELLS = 4;
// Surface drag C_D 1.3e-3 and boundary-layer depth 1 km [UNVERIFIED: C_D not read (atmosphere note sec. 5); the depth the
// ocean note's]; the surface wind's cross-contour turning by the Ekman balance is v = r f u / (f^2 + f_min^2), r = C_D |u| / H.
export const DRAG = { cd: 1.3e-3, depth: 1000 };
// The surface wind's largest zonal mean stress is the Southern Ocean's 0.25 Pa at C_D 1.3e-3 and rho 1.2, a scalar wind of 12.7
// m/s (R1440) [analogue: Earth's value, taken for this planet with the same drag law]; the polar easterlies are half the
// trades' [design]. The prevailing wind that moves the air is the vector mean of that scalar wind over its scatter: the
// resultant length of a wrapped normal of spread sigma is exp(-sigma^2 / 2) [derived], with sigma 40 degrees in the trades,
// 65 in the westerlies and 90 in the polar easterlies [design: the atmosphere note sec. 5; Bornholm's measured rose has 66 in
// wet hours and 89 in all]: 0.78, 0.53 and 0.29.
const steady = (sigmaDeg: number) => Math.exp(-((sigmaDeg * DEG) ** 2) / 2);
export const WIND = { peak: Math.sqrt(0.25 / (1.2 * 1.3e-3)), polarShare: 0.5, fMinDeg: 5, steadyTrade: steady(40), steadyWest: steady(65), steadyPolar: steady(90), ferrelShare: 0.5 };

// ---------- 2. insolation and the seasons ----------
// Daily mean insolation at latitude phi and declination delta, W/m2: (S0 / pi) (h0 sin phi sin delta + cos phi cos delta sin
// h0), cos h0 = -tan phi tan delta, polar day h0 = pi and polar night 0 (R1438's eqs. 5 to 7 integrated) [derived].
export function insolation(phi: number, delta: number, solar: number): number {
  const tt = -Math.tan(phi) * Math.tan(delta);
  const h0 = tt >= 1 ? 0 : tt <= -1 ? Math.PI : Math.acos(tt);
  return (solar / Math.PI) * (h0 * Math.sin(phi) * Math.sin(delta) + Math.cos(phi) * Math.cos(delta) * Math.sin(h0));
}
// The orbital longitude (degrees from the northern spring equinox) of the middle of step t of n in a year that starts a
// quarter of a quarter before the equinox: the seasons are centred on an equinox or a solstice as the game's are (climate.ts).
const orbit = (t: number, n: number) => -45 + (360 * (t + 0.5)) / n;
export const declination = (lambdaDeg: number, tiltDeg: number) => Math.asin(Math.sin(tiltDeg * DEG) * Math.sin(lambdaDeg * DEG));

// ---------- 3. the energy balance ----------
export const BANDS = 180;
export interface Ebm {
  phi: Float64Array; // band centres, radians
  weight: Float64Array; // band area shares (sum 1)
  landFraction: Float64Array;
  diffusion: number; // D, W/m2/K
  land: Float64Array[]; // the land column's sea-level temperature, C, by season
  sea: Float64Array[]; // the ocean column's
  mean: Float64Array[]; // the zonal mean's
  insolation: Float64Array[]; // W/m2, the season's mean
  phi0: number[]; // the circulation's centre shift, radians, by season
  balance: number; // the year's mean net flux into the surface columns, W/m2 (zero at the periodic state)
  drift: number; // the largest change of any column over the last year, K
}
const coAlbedo = (t: number) => EBM.CO_FREE - (EBM.CO_FREE - EBM.CO_ICE) * Math.min(1, Math.max(0, (EBM.ICE_LINE + ICE_RAMP / 2 - t) / ICE_RAMP));

// Budyko-Sellers' balance on latitude bands, with a land and an ocean column in each (the zonal mean's land fraction), one
// atmosphere between them: C dT/dt = Q (1 - alpha) - (A + B T) + H, H = D d/dx[(1 - x^2) dT/dx] the transport by the zonal-mean air
// temperature, x = sin phi, the same H on both columns (R1437; two columns after North and Coakley 1979, analogue, not read).
// The diffusion is Earth's D scaled by (Earth's radius / the planet's), i.e. an eddy diffusivity proportional to the radius:
// 2.07 W/m2/K at 2,000 km [design, a gap: the research note's range runs from 0.65 to 6.6 and the one cited run suggests
// under two-fold less contrast on a smaller planet]. Backward Euler in time (the sum of a column's response and the diffusion is
// stiff), 96 steps a year, 200 years to the periodic state (the ice line's ramp makes the approach slow in places: the drift over
// the last year is returned); the diffusion is solved implicitly with the columns eliminated.
export function solveEbm(p: PlanetParams, landFraction: ArrayLike<number>, years = 200): Ebm {
  const NB = BANDS, steps = 96, dt = YEAR_S / steps;
  const D = p.diffusion ?? (EBM.D_EARTH * EARTH_R) / p.radius;
  const CL = EBM.CL_YR * EBM.B * YEAR_S, CW = EBM.CW_YR * EBM.B * YEAR_S;
  const phi = new Float64Array(NB), sinC = new Float64Array(NB), sinE = new Float64Array(NB + 1), dx = new Float64Array(NB), w = new Float64Array(NB), fl = new Float64Array(NB);
  for (let k = 0; k <= NB; k++) sinE[k] = Math.sin((-90 + k) * DEG);
  for (let k = 0; k < NB; k++) { phi[k] = (-89.5 + k) * DEG; sinC[k] = Math.sin(phi[k]); dx[k] = sinE[k + 1] - sinE[k]; w[k] = dx[k] / 2; fl[k] = landFraction[k]; }
  // c[k]: the conductance across the edge between band k - 1 and k: (1 - x^2) at the edge over the distance in x between centres
  const c = new Float64Array(NB + 1);
  for (let k = 1; k < NB; k++) c[k] = (1 - sinE[k] * sinE[k]) / (sinC[k] - sinC[k - 1]);
  const qs: Float64Array[] = [];
  for (let t = 0; t < steps; t++) {
    const delta = declination(orbit(t, steps), p.tiltDeg), q = new Float64Array(NB);
    for (let k = 0; k < NB; k++) q[k] = insolation(phi[k], delta, p.solar);
    qs.push(q);
  }
  const TL = new Float64Array(NB), TW = new Float64Array(NB);
  for (let k = 0; k < NB; k++) TL[k] = TW[k] = 15 - 30 * sinC[k] * sinC[k];
  const aL = new Float64Array(NB), aW = new Float64Array(NB), forceL = new Float64Array(NB), forceW = new Float64Array(NB), bL = 1 / (CL / dt + EBM.B), bW = 1 / (CW / dt + EBM.B);
  const lo = new Float64Array(NB), di = new Float64Array(NB), up = new Float64Array(NB), rhs = new Float64Array(NB), cp = new Float64Array(NB), dp = new Float64Array(NB), Tb = new Float64Array(NB);
  const seasonSteps = steps / 4;
  const sums = (): Float64Array[] => [0, 1, 2, 3].map(() => new Float64Array(NB));
  const accL = sums(), accW = sums(), accM = sums(), accQ = sums();
  let balance = 0, drift = 0;
  for (let y = 0; y < years; y++) {
    const last = y === years - 1, before = last ? Float64Array.from([...TL, ...TW]) : null;
    for (let t = 0; t < steps; t++) {
      const q = qs[t];
      for (let k = 0; k < NB; k++) {
        forceL[k] = q[k] * coAlbedo(TL[k]) - EBM.A; forceW[k] = q[k] * coAlbedo(TW[k]) - EBM.A;
        aL[k] = ((CL / dt) * TL[k] + forceL[k]) * bL;
        aW[k] = ((CW / dt) * TW[k] + forceW[k]) * bW;
      }
      // (I - diag(b) D L) Tbar' = a, L the band operator: (c[k + 1] (T[k + 1] - T[k]) - c[k] (T[k] - T[k - 1])) / dx[k], dx the band's width in x
      for (let k = 0; k < NB; k++) {
        const bb = fl[k] * bL + (1 - fl[k]) * bW, aa = fl[k] * aL[k] + (1 - fl[k]) * aW[k];
        const s = (bb * D) / dx[k];
        lo[k] = -s * c[k]; up[k] = -s * c[k + 1]; di[k] = 1 + s * (c[k] + c[k + 1]); rhs[k] = aa;
      }
      cp[0] = up[0] / di[0]; dp[0] = rhs[0] / di[0];
      for (let k = 1; k < NB; k++) { const m = di[k] - lo[k] * cp[k - 1]; cp[k] = up[k] / m; dp[k] = (rhs[k] - lo[k] * dp[k - 1]) / m; }
      Tb[NB - 1] = dp[NB - 1];
      for (let k = NB - 2; k >= 0; k--) Tb[k] = dp[k] - cp[k] * Tb[k + 1];
      for (let k = 0; k < NB; k++) {
        const H = ((D / dx[k]) * ((k + 1 < NB ? c[k + 1] * (Tb[k + 1] - Tb[k]) : 0) - (k > 0 ? c[k] * (Tb[k] - Tb[k - 1]) : 0)));
        TL[k] = aL[k] + bL * H; TW[k] = aW[k] + bW * H;
      }
      if (last) {
        const s = Math.floor(t / seasonSteps);
        for (let k = 0; k < NB; k++) {
          accL[s][k] += TL[k]; accW[s][k] += TW[k]; accM[s][k] += fl[k] * TL[k] + (1 - fl[k]) * TW[k]; accQ[s][k] += qs[t][k];
          const net = fl[k] * (forceL[k] - EBM.B * TL[k]) + (1 - fl[k]) * (forceW[k] - EBM.B * TW[k]);
          balance += (w[k] * net) / steps;
        }
      }
    }
    if (before) for (let k = 0; k < NB; k++) drift = Math.max(drift, Math.abs(TL[k] - before[k]), Math.abs(TW[k] - before[NB + k]));
  }
  const mean = (a: Float64Array[]) => a.map((x) => x.map((v) => v / seasonSteps));
  const meanT = mean(accM);
  // The circulation's centre: the latitude of the zonal mean's maximum, refined by the parabola through it and its neighbours
  // [design: the research note's use of the EBM's seasonal temperature maximum for the heating's centre]
  const phi0 = meanT.map((T) => {
    let top = 0;
    for (let k = 1; k < NB; k++) if (T[k] > T[top]) top = k;
    if (top === 0 || top === NB - 1) return phi[top];
    const den = T[top - 1] - 2 * T[top] + T[top + 1];
    return phi[top] + (den === 0 ? 0 : (0.5 * (T[top - 1] - T[top + 1])) / den) * DEG;
  });
  return { phi, weight: w, landFraction: fl, diffusion: D, land: mean(accL), sea: mean(accW), mean: meanT, insolation: mean(accQ), phi0, balance, drift };
}

// ---------- 4. the circulation and its winds ----------
// Held and Hou's equal-area edge of the thermally direct cell, y = sin(phi) at the edge, for the group R = g z* Delta_h / (Omega^2
// a^2 T0): the continuity c = y^4 / (2R (1 - y^2)) - y^2 and the equal-area integral -y^3/3 - c y + (atanh y - y - y^3/3) / (2R)
// = 0 (R1433, the integral derived; it reduces to the cited small-angle edge (5R/3)^(1/2)). Bisection on y [derived].
export function heldHouEdge(R: number): number {
  const G = (y: number) => {
    const c = y ** 4 / (2 * R * (1 - y * y)) - y * y;
    return -(y ** 3) / 3 - c * y + (Math.atanh(y) - y - y ** 3 / 3) / (2 * R);
  };
  let a = 1e-6, b = 1 - 1e-9;
  for (let i = 0; i < 200; i++) { const m = (a + b) / 2; if (G(m) > 0) a = m; else b = m; }
  return Math.asin((a + b) / 2);
}
// Earth's group: z* 15 km, Delta_h / T0 = 80 / 295 [cited by the research note from R1430, R1433: 0.185, edge 28.8 degrees].
export const HELD_HOU = { zStar: 15_000, deltaOverT0: 80 / 295 };
export interface Circulation {
  omega: number; // rad/s
  groupR: number; // the Held-Hou group
  heldHou: number; // the equal-area edge, radians
  eddy: number; // the eddy-limited edge, radians
  hadley: number; // the cell's edge: the smaller of the two, radians
  polarFront: number; // the Ferrel cell's poleward edge, radians
  // (the polar front's latitude is the Hadley edge's plus half the arc to the pole, see circulationOf)
  uWest: number; uTrade: number; uPolar: number; // the lobes' peak speeds, m/s
}
// The eddy-limited edge scales as (Omega a)^(-1/2), calibrated so that Earth's is 30 degrees (R1430 eq. 3 as the research
// note reads it; the constant is [INFERENCE]). The Ferrel cell's poleward edge, the polar front, takes the same share of the
// arc from the Hadley edge to the pole as Earth's does (30 of 60 degrees: cells at 30 and 60) [design, a gap: no source read
// gives the polar front's latitude]. The Rhines scaling the research note suggests would make the Ferrel cell 65 degrees wide
// here (1.22 Earth's Rhines lengths of 1,850 km on a body where a degree is 35 km), more than the arc there is, so it is not
// used. The torque law (R1431: the surface drag integrated with cos^2 phi must vanish) fixes the trades' lobe from the
// westerlies' with the polar easterlies at half the trades' [design]. Lobes: sin over the band, zero at its edges.
export function circulationOf(p: PlanetParams): Circulation {
  const omega = (2 * Math.PI) / p.dayS;
  const groupR = (p.gravity * HELD_HOU.zStar * HELD_HOU.deltaOverT0) / (omega * omega * p.radius * p.radius);
  const heldHou = heldHouEdge(groupR);
  const eddy = 30 * DEG * Math.sqrt((EARTH_OMEGA * EARTH_R) / (omega * p.radius));
  const hadley = Math.min(heldHou, eddy);
  const polarFront = hadley + WIND.ferrelShare * (Math.PI / 2 - hadley);
  const lobe = (a: number, b: number) => {
    let s = 0;
    const n = 2000, h = (b - a) / n;
    for (let i = 0; i < n; i++) { const x = a + (i + 0.5) * h; s += Math.sin((Math.PI * (x - a)) / (b - a)) ** 2 * Math.cos(x) ** 2 * h; }
    return s;
  };
  const At = lobe(0, hadley), Aw = lobe(hadley, polarFront), Ap = lobe(polarFront, Math.PI / 2);
  const uWest = WIND.peak, uTrade = uWest * Math.sqrt(Aw / (At + WIND.polarShare ** 2 * Ap));
  return { omega, groupR, heldHou, eddy, hadley, polarFront, uWest, uTrade, uPolar: WIND.polarShare * uTrade };
}
// The zonal-mean surface wind (east, north), m/s, at the 721 latitude nodes of a season whose circulation is centred phi0 off
// the equator: the lobes in phi' = phi - phi0 cos phi (which keeps the poles fixed and the map monotone for |phi0| under 1
// radian) [design], and the meridional part turned from the zonal by the surface's Ekman balance v = r f u / (f^2 + f_min^2)
// with f_min the Coriolis parameter at 5 degrees so that the flow crosses the equator smoothly [design].
export function windTable(p: PlanetParams, c: Circulation, phi0: number): { u: Float64Array; v: Float64Array } {
  const u = new Float64Array(NODES), v = new Float64Array(NODES);
  const shift = Math.max(-0.6, Math.min(0.6, phi0)), fMin = 2 * c.omega * Math.sin(WIND.fMinDeg * DEG);
  for (let j = 0; j < NODES; j++) {
    const phi = (-90 + j * NODE_DEG) * DEG, t = Math.abs(phi - shift * Math.cos(phi));
    let uz: number, steadiness: number;
    if (t < c.hadley) { uz = -c.uTrade * Math.sin((Math.PI * t) / c.hadley); steadiness = WIND.steadyTrade; }
    else if (t < c.polarFront) { uz = c.uWest * Math.sin((Math.PI * (t - c.hadley)) / (c.polarFront - c.hadley)); steadiness = WIND.steadyWest; }
    else { uz = -c.uPolar * Math.sin((Math.PI * (t - c.polarFront)) / (Math.PI / 2 - c.polarFront)); steadiness = WIND.steadyPolar; }
    // the friction acts on the scalar wind, the mean flow is its vector mean
    const f = 2 * c.omega * Math.sin(phi), r = (DRAG.cd * Math.abs(uz)) / DRAG.depth, um = steadiness * uz;
    u[j] = um;
    v[j] = (r * f * um) / (f * f + fMin * fMin);
  }
  return { u, v };
}

// ---------- 5. the constants of the kernels ----------
const Q = (x: number, n: number) => Math.round(x * 2 ** n);
export function kernelConstants(): Kq {
  const iceFreeze = (2 * ICE_K * SEASON_S) / (ICE_RHO * ICE_L);
  return {
    gammaQ22: Q(GAMMA, 22),
    blockN: Q(N_M * 1000, 16),
    gust: Q(GUST, 16),
    ke: Q(C_EVAP / H_WATER, 44),
    ghw: Q(GAMMA * H_WATER, 16),
    tf: Q(T_FREEZE, 16),
    kice: Q(iceFreeze, 16),
    rh0: Q(FIRST_SHARE, 16),
    ft: Q(1 / ADJUST_S, 30),
    snowHi: Q(SNOW_HI, 16),
    snowInv: Q(1 / (SNOW_HI - SNOW_LO), 16),
    tauCIce: TAU_C_ICE, tauCWarm: TAU_C_WARM, tauFRain: TAU_F_RAIN, tauFSnow: Math.round(H_WATER / V_SNOW),
  };
}

// The column's saturation in Q20 mm at each 1/16 K from -120 to 90 C, from the world's integer exponential and exact integer
// division (so no word depends on the engine's Math.exp): e_s by Tetens in Q16 kPa, then 5,417 e_s / T. The integer exponential
// gives zero below about -53 C (e_s under half a Q16 step; the true column there is under 0.02 mm). Where e_s sits on one Q16
// step for several entries the 1/T would lower the column with warmth; the table is held at its running maximum [design].
export function saturationTable(): Int32Array {
  const out = new Int32Array(NCAP), e0 = Q(TETENS.E0, 16), a = Q(TETENS.A, 16), b = Q(TETENS.B, 16), k0 = Q(273.15, 16), kw = BigInt(Math.round(COLUMN * 16));
  for (let i = 0; i < NCAP; i++) {
    const t = (CAP_FROM * CAP_PER_K + i) * (65536 / CAP_PER_K);
    const es = qmul(e0, qexp(qdiv(qmul(a, t), t + b)));
    const den = BigInt(t + k0);
    out[i] = Math.max(i > 0 ? out[i - 1] : 0, Number((BigInt(es) * kw * 65536n + den / 2n) / den));
  }
  return out;
}
let capCache: Int32Array | undefined;
export const capTable = () => (capCache ??= saturationTable());

// ---------- 6. the grid's static geometry ----------
export interface Geometry {
  g: Grid;
  n: number;
  gdata: Int32Array; // the kernels' G (layout GEO)
  nbr: Int32Array; // the four neighbours of every cell
  lat: Float64Array; lon: Float64Array; // radians
  area: Float64Array; // m2
  margin: number; // the least distance of a latitude fraction from a rounding tie, in units of its last place
}
const geometries = new Map<string, Geometry>();
// Everything the kernels read about the grid: neighbours (the grid's `step`), each link's length over the cell's area and its
// normal in both cells' east and north, the cell's latitude node. A link is computed from the cell of the lower id and the
// other takes its normal negated, so the two cells' edge winds are exact opposites. Built once for a grid (under a second at tier 0).
export function buildGeometry(g: Grid): Geometry {
  const key = `${g.fn}:${g.radius}`;
  const kept = geometries.get(key);
  if (kept) return kept;
  const fn = g.fn, n = FACES * fn * fn, R = g.radius, V = fn + 1;
  const vx = new Float64Array(3 * FACES * V * V);
  for (let f = 0; f < FACES; f++) for (let j = 0; j < V; j++) for (let i = 0; i < V; i++) { const p = vertex(g, f, i, j), o = 3 * ((f * V + j) * V + i); vx[o] = p[0]; vx[o + 1] = p[1]; vx[o + 2] = p[2]; }
  const cx = new Float64Array(3 * n), en = new Float64Array(6 * n), lat = new Float64Array(n), lon = new Float64Array(n), area = new Float64Array(n), sr = new Float64Array(n);
  const gdata = new Int32Array(GEO.UNITS * n), nbr = gdata.subarray(0, 4 * n);
  let margin = Infinity;
  for (let f = 0; f < FACES; f++) for (let Y = 0; Y < fn; Y++) for (let X = 0; X < fn; X++) {
    const id = cellId(g, f, X, Y), p = centre(g, f, X, Y), [E, N] = eastNorth(p), ll = latLon(p);
    cx[3 * id] = p[0]; cx[3 * id + 1] = p[1]; cx[3 * id + 2] = p[2];
    en.set(E, 6 * id); en.set(N, 6 * id + 3);
    lat[id] = ll.lat; lon[id] = ll.lon; sr[id] = areaSr(g, X, Y); area[id] = sr[id] * R * R;
    const pos = (ll.lat / DEG + 90) / NODE_DEG, i = Math.min(NODES - 2, Math.floor(pos)), x = (pos - i) * 65536;
    gdata[GEO.LAT * n + id] = i; gdata[GEO.FRAC * n + id] = Math.round(x);
    margin = Math.min(margin, Math.abs(x - Math.floor(x) - 0.5));
  }
  const vec = (f: number, i: number, j: number) => { const o = 3 * ((f * V + j) * V + i); return [vx[o], vx[o + 1], vx[o + 2]] as const; };
  // the corners of the edge of cell (X, Y) on side d, as vertex indices
  const ends = [[1, 0, 1, 1], [0, 1, 1, 1], [0, 0, 0, 1], [0, 0, 1, 0]];
  for (let f = 0; f < FACES; f++) for (let Y = 0; Y < fn; Y++) for (let X = 0; X < fn; X++) {
    const id = cellId(g, f, X, Y);
    for (let d = 0; d < 4; d++) {
      const s = step(g, f, X, Y, d), j = cellId(g, s.face, s.X, s.Y);
      nbr[id * 4 + d] = j;
      if (j < id) continue;
      const e = ends[d], a = vec(f, X + e[0], Y + e[1]), b = vec(f, X + e[2], Y + e[3]);
      const m = unit3(a[0] + b[0], a[1] + b[1], a[2] + b[2]), t = unit3(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
      let nv = cross3(m, t);
      const toward = nv[0] * (cx[3 * j] - cx[3 * id]) + nv[1] * (cx[3 * j + 1] - cx[3 * id + 1]) + nv[2] * (cx[3 * j + 2] - cx[3 * id + 2]);
      if (toward < 0) nv = [-nv[0], -nv[1], -nv[2]];
      const arcLen = 2 * Math.atan2(Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]), Math.hypot(a[0] + b[0], a[1] + b[1], a[2] + b[2]));
      const dotEN = (c: number, k: number) => nv[0] * en[6 * c + k] + nv[1] * en[6 * c + k + 1] + nv[2] * en[6 * c + k + 2];
      const ie = Q(dotEN(id, 0), 14), inn = Q(dotEN(id, 3), 14), je = Q(dotEN(j, 0), 14), jn = Q(dotEN(j, 3), 14);
      const o = (GEO.NRM * n) + (id * 4 + d) * 4, ob = (GEO.NRM * n) + (j * 4 + s.back) * 4;
      gdata[o] = ie; gdata[o + 1] = inn; gdata[o + 2] = je; gdata[o + 3] = jn;
      gdata[ob] = -je; gdata[ob + 1] = -jn; gdata[ob + 2] = -ie; gdata[ob + 3] = -inn;
      gdata[GEO.LC * n + id * 4 + d] = Q(arcLen / (sr[id] * R), 28);
      gdata[GEO.LC * n + j * 4 + s.back] = Q(arcLen / (sr[j] * R), 28);
      // the midpoint's own latitude node and the normal on its east and north (the other side takes it negated)
      const [mE, mN] = eastNorth(m), pos = (Math.asin(m[2]) / DEG + 90) / NODE_DEG, li = Math.min(NODES - 2, Math.floor(pos)), fx = (pos - li) * 65536;
      margin = Math.min(margin, Math.abs(fx - Math.floor(fx) - 0.5));
      const ne = Q(nv[0] * mE[0] + nv[1] * mE[1] + nv[2] * mE[2], 14), nn = Q(nv[0] * mN[0] + nv[1] * mN[1] + nv[2] * mN[2], 14);
      const eo = GEO.EDGE * n + (id * 4 + d) * 4, eb = GEO.EDGE * n + (j * 4 + s.back) * 4;
      gdata[eo] = li; gdata[eo + 1] = Math.round(fx); gdata[eo + 2] = ne; gdata[eo + 3] = nn;
      gdata[eb] = li; gdata[eb + 1] = Math.round(fx); gdata[eb + 2] = -ne; gdata[eb + 3] = -nn;
    }
  }
  const geo: Geometry = { g, n, gdata, nbr, lat, lon, area, margin };
  geometries.set(key, geo);
  return geo;
}
const unit3 = (x: number, y: number, z: number): [number, number, number] => { const h = Math.hypot(x, y, z); return [x / h, y / h, z / h]; };
const cross3 = (a: readonly number[], b: readonly number[]): [number, number, number] => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

// The height's slope at each cell, Q16 m/m east and north, from the grid's own least-squares gradient on the GPU (halo
// exchange, then the stencil), of the height above the sea held in Q2 m. Tier 0 only (the tables are a whole tier's).
let tier0: { tab: Tables; key: string } | undefined;
export async function slopesOf(gpu: Gpu, geo: Geometry, elev: Float32Array): Promise<{ slx: Int32Array; sly: Int32Array }> {
  const g = geo.g, n = geo.n;
  if (g.fn !== 256) return { slx: new Int32Array(n), sly: new Int32Array(n) };
  const key = `${g.fn}:${g.radius}`;
  if (tier0?.key !== key) tier0 = { tab: buildTables(g), key };
  const q = padded(g, (f, X, Y) => Math.max(-(2 ** 20) + 1, Math.min(2 ** 20 - 1, Math.round(elev[cellId(g, f, X, Y)] * 4))));
  const gl = new GlobeGpu(gpu, tier0.tab);
  try {
    gl.write(GRID_STATE.q, q);
    gl.halo(GRID_STATE.q);
    gl.gradient(GRID_STATE.q, GRID_STATE.ge, GRID_STATE.gn);
    const ge = await gl.read(GRID_STATE.ge), gn = await gl.read(GRID_STATE.gn);
    const slx = new Int32Array(n), sly = new Int32Array(n), cw = cellWidthM(g);
    for (let f = 0; f < FACES; f++) for (let Y = 0; Y < g.fn; Y++) for (let X = 0; X < g.fn; X++) {
      const id = cellId(g, f, X, Y), at = wordAt(g, f, X, Y);
      // Q6 of Q2 m a cell's width: metres a metre is the word over (64 * 4 * cell width)
      slx[id] = Math.round((ge[at] * 65536) / (64 * 4 * cw));
      sly[id] = Math.round((gn[at] * 65536) / (64 * 4 * cw));
    }
    return { slx, sly };
  } finally { gl.release(); }
}


// ---------- 7. the kernels' twins ----------
// a * b / 2^s rounded half away from zero, the product held exactly and the result wrapped to 32 bits as the kernel's.
export function mulShr(a: number, b: number, s: number): number {
  const q = (BigInt(Math.abs(a)) * BigInt(Math.abs(b)) + (1n << BigInt(s - 1))) >> BigInt(s);
  return Number(BigInt.asIntN(32, (a < 0) !== (b < 0) ? -q : q));
}
export interface Ctx { n: number; S: Int32Array; G: Int32Array; T: Int32Array; k: Kq; blockL: number; dt: number; par: number; acc: boolean }
const at = (c: Ctx, f: number, i: number) => f * c.n + i;
function interp(c: Ctx, col: number, i: number, frac: number): number {
  const a = c.T[TAB.LT + col * NODES + i], b = c.T[TAB.LT + col * NODES + i + 1];
  return (a + mulShr(b - a, frac, 16)) | 0;
}
export function capAt(c: Ctx, t: number): number {
  const x = Math.max(0, Math.min((NCAP - 1) * 4096 - 1, t - CAP_FROM * 65536)), i = x >> 12, f = x & 4095;
  const a = c.T[i], b = c.T[i + 1];
  return (a + mulShr(b - a, f, 12)) | 0;
}
// The surface kernel's twin for cell idx: writes the cell's words of S.
export function prepTwin(c: Ctx, idx: number) {
  const { S, G, k } = c, n = c.n;
  const land = S[at(c, FIELD.LAND, idx)] !== 0, li = G[GEO.LAT * n + idx], lf = G[GEO.FRAC * n + idx];
  const ins = interp(c, TAB.INS, li, lf), tl = interp(c, TAB.TL, li, lf), tw = interp(c, TAB.TW, li, lf);
  const u0 = interp(c, TAB.U, li, lf), v0 = interp(c, TAB.V, li, lf);
  let u = u0, v = v0;
  const gE = S[at(c, FIELD.SLX, idx)], gN = S[at(c, FIELD.SLY, idx)];
  const gm = qsqrt((qmul(gE, gE) + qmul(gN, gN)) | 0), sp = qsqrt((qmul(u, u) + qmul(v, v)) | 0);
  if (gm > 0 && sp > 0) {
    const zk = qmul(gm, c.blockL), den = qmul(k.blockN, zk);
    let b = 0;
    if (den > 0) b = Math.max(0, 65536 - qdiv(sp, den));
    if (b > 0) {
      const nE = qdiv(gE, gm), nN = qdiv(gN, gm), up = (qmul(u, nE) + qmul(v, nN)) | 0;
      if (up > 0) { const w = qmul(b, up); u = (u - qmul(w, nE)) | 0; v = (v - qmul(w, nN)) | 0; }
    }
  }
  const sp2 = qsqrt((qmul(u, u) + qmul(v, v)) | 0), elev = S[at(c, FIELD.ELEV, idx)], lap = mulShr(elev, k.gammaQ22, 12);
  const ts = land ? tl : tw, tsurf = (ts - lap) | 0;
  let sst = 0, ice = 0, msat = 0;
  if (!land) {
    sst = Math.max(tw, k.tf);
    if (tw < k.tf) ice = qsqrt(qmul((k.tf - tw) | 0, k.kice));
    msat = capAt(c, sst);
  }
  let fe = mulShr(Math.max(sp2, k.gust), k.ke, 30);
  if (ice > 0) fe = 0;
  const f = tsurf > 0 ? qexp(-qdiv(tsurf, k.ghw)) : 65536;
  const tauc = (f * k.tauCIce + (65536 - f) * k.tauCWarm + 32768) >> 16, tauf = ((65536 - f) * k.tauFRain + f * k.tauFSnow + 32768) >> 16;
  S[at(c, FIELD.U, idx)] = u; S[at(c, FIELD.V, idx)] = v;
  S[at(c, FIELD.U0, idx)] = u0; S[at(c, FIELD.V0, idx)] = v0;
  S[at(c, FIELD.TS, idx)] = ts; S[at(c, FIELD.SST, idx)] = sst; S[at(c, FIELD.INS, idx)] = ins; S[at(c, FIELD.LAP, idx)] = lap;
  S[at(c, FIELD.FE, idx)] = fe; S[at(c, FIELD.MSAT, idx)] = msat; S[at(c, FIELD.ICE, idx)] = ice;
  S[at(c, FIELD.FC, idx)] = Math.floor((1073741824 + Math.floor(tauc / 2)) / tauc);
  S[at(c, FIELD.FF, idx)] = Math.floor((1073741824 + Math.floor(tauf / 2)) / tauf);
  S[at(c, FIELD.ST, idx)] = ts;
  S[at(c, FIELD.ST + 1, idx)] = mulShr(capAt(c, tsurf), k.rh0, 16);
  for (let q = 2; q < 5; q++) S[at(c, FIELD.ST + q, idx)] = 0;
  S[at(c, FIELD.PACC, idx)] = 0; S[at(c, FIELD.EACC, idx)] = 0; S[at(c, FIELD.RACC, idx)] = 0;
}
export function edgesTwin(c: Ctx, idx: number) {
  const { S, G } = c, n = c.n, dix = (S[at(c, FIELD.U, idx)] - S[at(c, FIELD.U0, idx)]) | 0, diy = (S[at(c, FIELD.V, idx)] - S[at(c, FIELD.V0, idx)]) | 0;
  for (let d = 0; d < 4; d++) {
    const j = G[GEO.NBR * n + idx * 4 + d], b = GEO.NRM * n + (idx * 4 + d) * 4, e = GEO.EDGE * n + (idx * 4 + d) * 4;
    const um = interp(c, TAB.U, G[e], G[e + 1]), vm = interp(c, TAB.V, G[e], G[e + 1]);
    const djx = (S[at(c, FIELD.U, j)] - S[at(c, FIELD.U0, j)]) | 0, djy = (S[at(c, FIELD.V, j)] - S[at(c, FIELD.V0, j)]) | 0;
    const un = (mulShr(G[e + 2], um, 14) + mulShr(G[e + 3], vm, 14) + mulShr(G[b], dix, 15) + mulShr(G[b + 1], diy, 15) + mulShr(G[b + 2], djx, 15) + mulShr(G[b + 3], djy, 15)) | 0;
    S[at(c, FIELD.R + d, idx)] = mulShr(un, G[GEO.LC * n + idx * 4 + d], 14);
  }
}
// The step kernel's twin: reads the state set c.par and writes the other.
export function stepTwin(c: Ctx, idx: number) {
  const { S, G, k, dt } = c, n = c.n, fa = FIELD.ST + 5 * c.par, fb = FIELD.ST + 5 * (1 - c.par);
  const ta = S[at(c, fa, idx)], m = S[at(c, fa + 1, idx)], cl = S[at(c, fa + 2, idx)], h = S[at(c, fa + 3, idx)], pp = S[at(c, fa + 4, idx)];
  let fo = 0, inM = 0, inC = 0, inH = 0, dT = 0;
  for (let d = 0; d < 4; d++) {
    const r = S[at(c, FIELD.R + d, idx)];
    if (r > 0) fo = (fo + Math.imul(r, dt)) | 0;
    else if (r < 0) {
      const w = Math.imul(-r, dt), j = G[GEO.NBR * n + idx * 4 + d];
      inM = (inM + mulShr(S[at(c, fa + 1, j)], w, 30)) | 0;
      inC = (inC + mulShr(S[at(c, fa + 2, j)], w, 30)) | 0;
      inH = (inH + mulShr(S[at(c, fa + 3, j)], w, 30)) | 0;
      dT = (dT + mulShr((S[at(c, fa, j)] - ta) | 0, w, 30)) | 0;
    }
  }
  let mn = (m - mulShr(m, fo, 30) + inM) | 0, cn = (cl - mulShr(cl, fo, 30) + inC) | 0, hn = (h - mulShr(h, fo, 30) + inH) | 0;
  const cap = capAt(c, (ta - S[at(c, FIELD.LAP, idx)]) | 0), fe = Math.imul(S[at(c, FIELD.FE, idx)], dt), land = S[at(c, FIELD.LAND, idx)] !== 0;
  const e = land ? Math.min(mulShr(Math.max(0, cap - mn), fe, 30), pp) : mulShr(Math.max(0, S[at(c, FIELD.MSAT, idx)] - mn), fe, 30);
  mn = (mn + e) | 0;
  if (mn > cap) { cn = (cn + mn - cap) | 0; mn = cap; }
  const q = mulShr(cn, Math.imul(S[at(c, FIELD.FC, idx)], dt), 30);
  cn = (cn - q) | 0; hn = (hn + q) | 0;
  const p = mulShr(hn, Math.imul(S[at(c, FIELD.FF, idx)], dt), 30);
  hn = (hn - p) | 0;
  const tn = (ta + dT + mulShr((S[at(c, FIELD.TS, idx)] - ta) | 0, Math.imul(k.ft, dt), 30)) | 0;
  S[at(c, fb, idx)] = tn; S[at(c, fb + 1, idx)] = mn; S[at(c, fb + 2, idx)] = cn; S[at(c, fb + 3, idx)] = hn; S[at(c, fb + 4, idx)] = p;
  if (c.acc) {
    S[at(c, FIELD.PACC, idx)] += p; S[at(c, FIELD.EACC, idx)] += e;
    if (land) S[at(c, FIELD.RACC, idx)] += pp - e;
  }
}
export function finishTwin(c: Ctx, idx: number) {
  const { S, k } = c, fa = FIELD.ST + 5 * c.par, tn = (S[at(c, fa, idx)] - S[at(c, FIELD.LAP, idx)]) | 0;
  const sf = Math.max(0, Math.min(65536, qmul((k.snowHi - tn) | 0, k.snowInv)));
  S[at(c, FIELD.TN, idx)] = tn;
  S[at(c, FIELD.SNOW, idx)] = mulShr(S[at(c, FIELD.PACC, idx)], sf, 16);
}

// ---------- 8. the climate on the GPU ----------
export interface SeasonClimate {
  insolation: Float32Array; // W/m2, the season's daily mean
  temperature: Float32Array; // C, near the surface (the air's sea-level temperature less the height's lapse)
  seaLevelTemperature: Float32Array; // C, the air's, before the lapse
  windE: Float32Array; windN: Float32Array; // m/s
  sst: Float32Array; // C, the sea's surface (0 on land)
  ice: Float32Array; // m, the sea ice's thickness
  rain: Float32Array; snow: Float32Array; // mm of water over the season
  evaporation: Float32Array; // mm over the season
  runoff: Float32Array; // mm over the season: the land's rain less what it gave back
  column: Float32Array; // mm of vapour in the column at the end
  dt: number; spinSteps: number; windowSteps: number;
  // The water over the window, in m3 over the whole planet: evaporated, rained, held at the window's start and end.
  budget: { evaporated: number; rained: number; held0: number; held1: number };
}
export interface Climate {
  planet: PlanetParams;
  geo: Geometry;
  land: Uint8Array;
  circulation: Circulation;
  ebm: Ebm;
  seasons: SeasonClimate[];
}
export interface ClimateOptions {
  spinDays?: number; // the days a season's moist air is marched before the window (30)
  windowDays?: number; // the days of the window the rain and evaporation are summed over (2)
}
const OUT = 1 << 30;

// The planet's zonal land fraction in 1 degree bands, from the cells' areas.
export function landFractionOf(geo: Geometry, land: Uint8Array): Float64Array {
  const all = new Float64Array(BANDS), sum = new Float64Array(BANDS);
  for (let i = 0; i < geo.n; i++) {
    const k = Math.min(BANDS - 1, Math.max(0, Math.floor(geo.lat[i] / DEG + 90)));
    all[k] += geo.area[i]; if (land[i]) sum[k] += geo.area[i];
  }
  return sum.map((v, k) => (all[k] > 0 ? v / all[k] : 0));
}
// Linear interpolation of band values onto the 721 nodes (the end bands' values held to the poles).
function toNodes(band: ArrayLike<number>): Float64Array {
  const out = new Float64Array(NODES);
  for (let j = 0; j < NODES; j++) {
    const x = Math.min(BANDS - 1, Math.max(0, -90 + j * NODE_DEG + 89.5)), i = Math.min(BANDS - 2, Math.floor(x)), f = x - i;
    out[j] = band[i] * (1 - f) + band[i + 1] * f;
  }
  return out;
}

// The atmosphere on a device for one height field (m, in cell-id order, the sea at p.seaLevel) on the sphere grid: the buffers,
// the tables, the kernels and the season loop. `climateGpu` runs the four seasons; the test drives the entry points one by one
// and compares each with its twin through `snapshot`.
export class AtmosphereGpu {
  readonly n: number;
  readonly p: PlanetParams;
  readonly geo: Geometry;
  readonly land: Uint8Array;
  readonly ebm: Ebm;
  readonly circulation: Circulation;
  readonly k = kernelConstants();
  readonly tables = new Int32Array(TABLE_WORDS);
  readonly blockL: number;
  private readonly S: GPUBuffer;
  private readonly Gb: GPUBuffer;
  private readonly Tb: GPUBuffer;
  private readonly pbuf: GPUBuffer[][];
  private readonly pipes: Record<"prep" | "edges" | "step" | "finish", GPUComputePipeline>;
  private readonly groups: [number, number];
  private dt = 1;

  private constructor(readonly gpu: Gpu, readonly g: Grid, planetIn: Partial<PlanetParams>, slopes: { slx: Int32Array; sly: Int32Array }, geo: Geometry, land: Uint8Array, elev: Float32Array) {
    this.p = planetOf({ ...planetIn, radius: planetIn.radius ?? g.radius });
    this.geo = geo; this.n = geo.n; this.land = land;
    this.ebm = solveEbm(this.p, landFractionOf(geo, land));
    this.circulation = circulationOf(this.p);
    this.blockL = Math.round(((BLOCK_CELLS * cellWidthM(g)) / 1000) * 65536);
    const n = this.n, dev = gpu.device;
    this.S = storage(gpu, n * FIELD.COUNT * 4);
    this.Gb = storage(gpu, geo.gdata);
    this.Tb = storage(gpu, TABLE_WORDS * 4);
    this.pbuf = [0, 1].map((par) => [0, 1].map((acc) => storage(gpu, this.words(par, acc))));
    const put = (f: number, a: Int32Array) => dev.queue.writeBuffer(this.S, f * n * 4, a.buffer, a.byteOffset, a.byteLength);
    put(FIELD.ELEV, Int32Array.from(elev, (v) => Math.round(v * 64)));
    put(FIELD.SLX, slopes.slx); put(FIELD.SLY, slopes.sly); put(FIELD.LAND, Int32Array.from(land));
    this.tables.set(capTable(), 0);
    const wgsl = atmosphereWgsl(this.k);
    this.pipes = { prep: pipeline(gpu, wgsl, "prep"), edges: pipeline(gpu, wgsl, "edges"), step: pipeline(gpu, wgsl, "step"), finish: pipeline(gpu, wgsl, "finish") };
    this.groups = cover(gpu, n);
  }
  static async make(gpu: Gpu, g: Grid, height: Float32Array, planetIn: Partial<PlanetParams> = {}): Promise<AtmosphereGpu> {
    const geo = buildGeometry(g), n = geo.n, sea = planetOf(planetIn).seaLevel;
    if (height.length !== n) throw new Error(`AtmosphereGpu: ${height.length} heights for ${n} cells`);
    const land = new Uint8Array(n), elev = new Float32Array(n);
    for (let i = 0; i < n; i++) { land[i] = height[i] > sea ? 1 : 0; elev[i] = land[i] ? height[i] - sea : 0; }
    return new AtmosphereGpu(gpu, g, planetIn, await slopesOf(gpu, geo, elev), geo, land, elev);
  }
  private words(par: number, acc: number) { return new Uint32Array([this.n, this.dt, acc, par, this.blockL, 0, 0, 0]); }
  private writePars() { for (let par = 0; par < 2; par++) for (let acc = 0; acc < 2; acc++) this.gpu.device.queue.writeBuffer(this.pbuf[par][acc], 0, this.words(par, acc)); }
  // Put a season's zonal tables (insolation, the land's and the sea's temperatures, the wind) where the kernels read them.
  loadSeason(s: number) {
    const { ebm, p, circulation } = this, wt = windTable(p, circulation, ebm.phi0[s]);
    const cols: [number, Float64Array, number][] = [[TAB.INS, toNodes(ebm.insolation[s]), 8], [TAB.TL, toNodes(ebm.land[s]), 16], [TAB.TW, toNodes(ebm.sea[s]), 16], [TAB.U, wt.u, 16], [TAB.V, wt.v, 16]];
    for (const [col, vals, q] of cols) for (let j = 0; j < NODES; j++) this.tables[TAB.LT + col * NODES + j] = Q(vals[j], q);
    this.gpu.device.queue.writeBuffer(this.Tb, 0, this.tables.buffer, this.tables.byteOffset, this.tables.byteLength);
    this.dt = 1; this.writePars();
  }
  setStep(dt: number) { this.dt = dt; this.writePars(); }
  // Dispatch an entry point `times` times, the step kernel alternating its state sets from par.
  run(name: "prep" | "edges" | "step" | "finish", par = 0, acc = 0, times = 1) {
    const dev = this.gpu.device, pipe = this.pipes[name];
    const bind = [0, 1].map((q) => dev.createBindGroup({ layout: pipe.getBindGroupLayout(0), entries: [this.S, this.Gb, this.Tb, this.pbuf[q][acc]].map((buffer, binding) => ({ binding, resource: { buffer } })) }));
    for (let b = 0; b < times; b += 400) {
      const enc = dev.createCommandEncoder();
      for (let i = b; i < Math.min(times, b + 400); i++) {
        const pass = enc.beginComputePass();
        pass.setPipeline(pipe);
        pass.setBindGroup(0, bind[name === "step" ? (par + i) & 1 : par]);
        pass.dispatchWorkgroups(this.groups[0], this.groups[1]);
        pass.end();
      }
      dev.queue.submit([enc.finish()]);
    }
  }
  async read(f: number, count = 1): Promise<Int32Array> { return new Int32Array(await readback(this.gpu, this.S, count * this.n * 4, f * this.n * 4)); }
  // The twin's view of the device: every field's words as they stand, with the constants and tables.
  async snapshot(par: number, acc = false): Promise<Ctx> {
    return { n: this.n, S: await this.read(0, FIELD.COUNT), G: this.geo.gdata, T: this.tables, k: this.k, blockL: this.blockL, dt: this.dt, par, acc };
  }
  // The least step (s) that keeps every cell's four link fractions under 0.8 in all (the upwind scheme is stable for a sum
  // under 1) and under half the shortest cloud delay, 500 s [derived], from the rates the edges kernel made.
  async chooseStep(): Promise<number> {
    const n = this.n, rates = await this.read(FIELD.R, 4);
    let most = 0;
    for (let i = 0; i < n; i++) most = Math.max(most, Math.abs(rates[i]) + Math.abs(rates[n + i]) + Math.abs(rates[2 * n + i]) + Math.abs(rates[3 * n + i]));
    const dt = Math.max(1, Math.min(500, Math.floor((0.8 * OUT) / Math.max(1, most))));
    this.setStep(dt);
    return dt;
  }
  // One season: the surface, the edge rates, a spin-up of the moist air, then a window over which the rain, evaporation and
  // runoff are summed (and the water held at its two ends read, for the budget).
  async season(s: number, opts: ClimateOptions = {}): Promise<SeasonClimate> {
    const n = this.n, area = this.geo.area, read = (f: number) => this.read(f);
    this.loadSeason(s);
    this.run("prep"); this.run("edges");
    const dt = await this.chooseStep();
    const spin = Math.ceil(((opts.spinDays ?? 30) * 86400) / dt), win = Math.ceil(((opts.windowDays ?? 2) * 86400) / dt);
    this.run("step", 0, 0, spin);
    const par0 = spin & 1, par1 = (spin + win) & 1, held = async (par: number) => {
      const [m, c, h] = [await read(FIELD.ST + 5 * par + 1), await read(FIELD.ST + 5 * par + 2), await read(FIELD.ST + 5 * par + 3)];
      let sum = 0;
      for (let i = 0; i < n; i++) sum += area[i] * (m[i] + c[i] + h[i]);
      return { m, sum: sum / 2 ** 20 / 1000 };
    };
    const held0 = (await held(par0)).sum;
    this.run("step", par0, 1, win);
    this.run("finish", par1, 0);
    const end = await held(par1);
    const pacc = await read(FIELD.PACC), eacc = await read(FIELD.EACC), racc = await read(FIELD.RACC), snow = await read(FIELD.SNOW);
    let top = 0, evap = 0, rain = 0;
    for (let i = 0; i < n; i++) { top = Math.max(top, pacc[i], eacc[i], racc[i]); evap += area[i] * eacc[i]; rain += area[i] * pacc[i]; }
    if (top >= OUT) throw new Error(`climateGpu: a window's accumulator reached ${top / 2 ** 20} mm, over what its word holds`);
    const perSeason = SEASON_S / (win * dt) / 2 ** 20, scale = (a: Int32Array) => Float32Array.from(a, (v) => v * perSeason), conv = (a: Int32Array, q: number) => Float32Array.from(a, (v) => v / 2 ** q);
    return {
      insolation: conv(await read(FIELD.INS), 8), temperature: conv(await read(FIELD.TN), 16), seaLevelTemperature: conv(await read(FIELD.ST + 5 * par1), 16),
      windE: conv(await read(FIELD.U), 16), windN: conv(await read(FIELD.V), 16), sst: conv(await read(FIELD.SST), 16), ice: conv(await read(FIELD.ICE), 16),
      rain: scale(pacc), snow: scale(snow), evaporation: scale(eacc), runoff: scale(racc), column: conv(end.m, 20),
      dt, spinSteps: spin, windowSteps: win,
      budget: { evaporated: evap / 2 ** 20 / 1000, rained: rain / 2 ** 20 / 1000, held0, held1: end.sum },
    };
  }
  release() { for (const b of [this.S, this.Gb, this.Tb, ...this.pbuf.flat()]) b.destroy(); }
}

// The four seasons' climate of a height field.
export async function climateGpu(gpu: Gpu, g: Grid, height: Float32Array, planet: Partial<PlanetParams> = {}, opts: ClimateOptions = {}): Promise<Climate> {
  const a = await AtmosphereGpu.make(gpu, g, height, planet);
  try {
    const seasons: SeasonClimate[] = [];
    for (let s = 0; s < 4; s++) seasons.push(await a.season(s, opts));
    return { planet: a.p, geo: a.geo, land: a.land, circulation: a.circulation, ebm: a.ebm, seasons };
  } finally { a.release(); }
}

