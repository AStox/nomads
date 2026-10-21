// The island's ground in WGSL, a port of src/terrain/ground.ts ground() (soil depth by creep and weathering, beach sand
// and alluvium, peat, texture, the root zone's seasonal bucket, the plants' compensation points and the cover they
// settle, fertility, NPP, RothC's steady state, pH) with niche.ts fit and growth.ts yearComp, closes and warmEnough.
// The physics, constants and curves are the TypeScript's; every number here is an integer between the buffer read and
// the buffer write, so every GPU gives the same words.
//
// Formats (each field's scale is in FIELDS below, and the host reads them back by it):
// - Q16: i32 x * 2^16, for metres, mm, % and t a ha (range 32768).
// - Q24: i32 x * 2^24 for fractions and for sums that stay under 127 (shares, textures, sun times warmth); products by
//   qm(a, b, 24) rounded, 64-bit inside, saturating.
// - Q28: u32 x * 2^28 for a compensation point (under 16, saturating): the cover's closing share
//   (1 - comp) / (1 - UNDER_CROWN) needs its precision where comp is under 0.02.
// Soil: u = e^(h0/h* - tau) + (a0 AGE / h*) f(tau) with tau = E AGE / h* and f = (1 - e^-tau) / tau, which is the
// solution ground.ts integrates (its u0 e^-tau + a0/E (1 - e^-tau)) written so that no e^(depth / h*) (up to e^12) is
// ever formed: ln u is the log of a sum of two exponentials, and the soil h* ln u. tau comes from the creep flux's
// divergence summed in Q20.
//
// Two entry points: `near` carries the power of the nearest stream channel out over the grid by the sweeps ground.ts
// makes (forward then backward in raster order, ties to whichever neighbour comes first), here run one anti-diagonal
// at a time inside one workgroup, which reads exactly the neighbours the raster order has finished; `main` is the cell.
import { CELL, N } from "../../terrain/grid";
import { CREEP, DRIFTS, DOLERITE, GRANITE, LIMESTONE, MELTWATER, MUDSTONE, PEAT, ROCKS, TILL_CLAY } from "../../terrain/geology";
import {
  ACROTELM, AGE, CARBON, CARBONATE, CN_BIO, CN_HUM, COHESIVE, DAYS, DPM_RPM, EXCHANGER, FIELD, GAP, GAP_LIGHT, H_STAR, K_BIO, K_DPM, K_HUM, K_RPM,
  MOR, N_PLANT, OM_C, PEAT_A, PEAT_P, PEAT_RHO, RUNUP, SC, SILICATE, SILT_CLAY, SILT_SAND, TOPSOIL, W0, DENSITY,
} from "../../terrain/ground";
import { GROWTH_RESP, LMF, MAINT, Q10, ROOTS, RUE, SLA, UNDER_CROWN, pOf } from "../../terrain/growth";
import { NICHE, SHRUBS, TREES, fit } from "../../terrain/niche";
import { DAYS_OF_YEAR, EVERGREEN, HALF_RANGE, STEPS, TMIN_HI, TMIN_LO, VPD_HI, VPD_LO } from "./terrain-phenology";
import { FIXED } from "./fixed";

const LEN = N * N;

// ---------- the buffers ----------
// Input fields, i32, LEN each, in this order; the unit of each is the CPU Site field's, scaled as noted.
export const INPUTS = [
  "height", // Q16 m
  "open", // 0 or 1
  "drift", // geology.ts DRIFTS index
  "rock", // geology.ts ROCKS index
  "driftDepth", // Q16 m
  "valley", // Q16, only its sign is read
  "channel", // 0 or 1
  "power", // Q16 W/m2, saturating
  "winterTable", // Q16 m
  "dryTable", // Q16 m
  "seasonTable0", "seasonTable1", "seasonTable2", "seasonTable3", // Q16 m
  "precip0", "precip1", "precip2", "precip3", // Q16 mm
  "pet0", "pet1", "pet2", "pet3", // Q16 mm
  "sun0", "sun1", "sun2", "sun3", // Q16 MJ/m2 a day
  "temp0", "temp1", "temp2", "temp3", // Q16 C
  "humid0", "humid1", "humid2", "humid3", // Q16, 0 to 1
] as const;
// Output fields, i32, LEN each: the Ground's, each with the divisor that turns it back into the CPU's unit.
export const OUTPUTS = [
  ["soil", 65536], ["silt", 1], ["sand", 1], ["peat", 65536], ["sandy", 2 ** 24], ["clayey", 2 ** 24], ["carbon", 65536], ["organic", 65536],
  ["nitrogen", 65536], ["ph", 65536], ["fertility", 2 ** 24], ["moist", 2 ** 24],
  ["soilWater0", 2 ** 24], ["soilWater1", 2 ** 24], ["soilWater2", 2 ** 24], ["soilWater3", 2 ** 24],
  ["tree", 2 ** 24], ["shrub", 2 ** 24], ["grass", 2 ** 24], ["marsh", 2 ** 24], ["bare", 2 ** 24], ["field", 2 ** 24], ["fieldLight", 2 ** 24],
  ["leaf0", 2 ** 24], ["leaf1", 2 ** 24], ["leaf2", 2 ** 24], ["leaf3", 2 ** 24], // each season's leaf display (terrain-phenology.ts), for the test
] as const;

const at = (name: (typeof INPUTS)[number]) => INPUTS.indexOf(name);
const out = (name: (typeof OUTPUTS)[number][0]) => OUTPUTS.findIndex((o) => o[0] === name);

// ---------- constants as integers, rounded once here ----------
const Q = (x: number, bits: number) => {
  const v = Math.round(x * 2 ** bits);
  if (!Number.isFinite(v) || Math.abs(v) > 0x7fffffff) throw new Error(`${x} does not fit Q${bits}`);
  return v;
};
const q16 = (x: number) => `${Q(x, 16)}i`, q24 = (x: number) => `${Q(x, 24)}i`;
const u32 = (x: number, bits: number) => {
  const v = Math.round(x * 2 ** bits);
  if (!(v >= 0 && v <= 0xffffffff)) throw new Error(`${x} does not fit u32 Q${bits}`);
  return `${v}u`;
};

// The plants the ground competes: trees, shrubs, reeds, then the field layer (grass first), as ground.ts reads them.
const SPECIES = [...TREES, ...SHRUBS, "reeds", ...FIELD];
const NS = SPECIES.length;
if (FIELD[0] !== "grass") throw new Error("the field layer's first plant is the sward");
const T0 = 0, S0 = TREES.length, RE = S0 + SHRUBS.length, G = RE + 1, F0 = G, F1 = SPECIES.length;
const PINE = SPECIES.indexOf("pine"), HEATHER = SPECIES.indexOf("heather");
// The water-stress shares p the plants use (growth.ts pOf) and 1 / (1 - p).
const PS = [...new Set(SPECIES.map(pOf))];
const PCLASS = SPECIES.map((n) => PS.indexOf(pOf(n)));
// A plant's made-per-gram constant, (1 - growth respiration) RUE leaf-mass-fraction SLA, in Q32 (under 0.02).
const MADE = SPECIES.map((n) => Q((1 - GROWTH_RESP) * RUE * LMF * SLA[n], 32));
// Which plants keep their leaves all year: their carbon takes growth.ts's warmth ramp; the rest take the growing season
// index's leaf display (terrain-phenology.ts).
const EVER = SPECIES.map((n) => (EVERGREEN.includes(n) ? 1 : 0));
// The year's days (terrain-phenology.ts DAYS_OF_YEAR): the season each day's mean air is drawn from and the next, how far
// between them (Q24), the daylight ramp (Q24), the day's share of its season's sun (Q24), and each season's half range of
// the day's air (Q16).
const DAY_FROM = DAYS_OF_YEAR.map((d) => d.from);
const DAY_TOWARD = DAYS_OF_YEAR.map((d) => Q(d.toward, 24));
const DAY_PHOTO = DAYS_OF_YEAR.map((d) => Q(d.photo, 24));
const DAY_WEIGHT = DAYS_OF_YEAR.map((d) => Q(d.weight, 24));
const HALF_Q16 = HALF_RANGE.map((h) => Q(h, 16));
// A plant's year of dry matter, by p class: the leaf display's for those that lose their leaves, the warmth ramp's for the
// evergreens.
const DM = (s: string) => `select(mpD[SPEC_P[${s}]], mp[SPEC_P[${s}]], SPEC_EVER[${s}] != 0u)`;
// What a woody plant's carbon becomes: of a temperate humid deciduous forest's net primary production the foliage makes
// 235 g C/m2 a year, the wood 329 and the roots 207 (Luyssaert et al., R1281, Table 3), so foliage and roots, which fall
// on and into the soil, are 442 of the 771, and the wood, which stays standing and then lies on the floor outside the
// mineral topsoil RothC counts, the rest [derived; the one forest class for every tree and shrub, analogue; the
// roots' coarse share is not split out there, gap]. The herbaceous plants hold no wood and all of theirs turns over.
export const SOIL_SHARE = (235 + 207) / (235 + 329 + 207);
// Its table (water table depth) curve, Q16 m, and its pH fit at each of the three mineral pHs, Q24 (the pH curve is
// evaluated by niche.ts fit itself, once, as the three pHs are all a cell can have).
const DEEP_Q = 2 * 65536;
const qcl = (v: number) => (Number.isFinite(v) ? Q(v, 16) : DEEP_Q);
const TABLE = SPECIES.flatMap((n) => (NICHE[n].table as number[]).map(qcl));
const NAN_ENV = { table: NaN, light: NaN, wind: NaN, salt: NaN, soil: NaN };
const PHFIT = [CARBONATE, SILICATE, EXCHANGER].flatMap((ph) => SPECIES.map((n) => Q(fit(n, { ...NAN_ENV, ph }), 24)));
const TALL = SPECIES.map((n) => Q(NICHE[n].tall ?? 0, 16));

// Peat's one depth: Clymo's bog from the ice's going, m (ground.ts line 192).
const PEAT_DEPTH = ((PEAT_P / PEAT_A) * (1 - Math.exp(-PEAT_A * AGE))) / 1000 / PEAT_RHO;
const PEAT_CARBON = PEAT_RHO * Math.min(TOPSOIL, PEAT_DEPTH) * 10 * CARBON;
// Soil: the rock's make rate a0 = DENSITY W0 (m a year), B = a0 AGE / h*, and the creep's tau per unit of the sum of the
// four faces' S / (1 - (S / Sc)^2): CREEP AGE / (h* CELL).
const B_SOIL = (DENSITY * W0 * AGE) / H_STAR;
const K_TAU = (CREEP * AGE) / (H_STAR * CELL);
// The 1 / light each closes() is asked at, as an integer (the whole sky, the gaps' light, a canopy's floor).
const per = (light: number) => { const k = Math.round(1 / light); if (Math.abs(k * light - 1) > 1e-9) throw new Error(`1 / ${light} is not an integer`); return k; };
// Organic matter % is 100 OM_C toc / (density depth 1e4) = toc / (density depth OM_DIV).
const OM_DIV = 1e4 / (100 * OM_C);
if (!Number.isInteger(OM_DIV)) throw new Error("OM_C does not make the organic matter divisor an integer");
// The temperatures' 2^((T - 20) / 10) is a base 2 (growth.ts Q10).
if (Q10 !== 2) throw new Error("the maintenance curve is written for Q10 = 2");

const ph = (x: number) => q16(x);
const NU = 1.139 - 1;
const ARR = (v: number[], t: string) => `array<${t}, ${v.length}>(${v.map((x) => `${x}${t === "u32" ? "u" : "i"}`).join(", ")})`;
const DR = (f: (d: (typeof DRIFTS)[number]) => number) => ARR(DRIFTS.map((d) => Q(f(d), 24)), "i32");
const RK = (f: (r: (typeof ROCKS)[number]) => number) => ARR(ROCKS.map((r) => Q(f(r), 24)), "i32");

// The kernels for a grid of side `n`. The island's (`patch` false) is 256 by 256, the sweep one anti-diagonal at a time with a thread to a column; a patch of the planet's 75 m
// tier (globe/ground.ts) is any side, its sweep with each thread taking every 256th column, and carries a channel's power no further than `reach` cells (a cell with no channel
// within it has none), so that a cell's answer depends on the cells within `reach` of it alone [design: R1860]. The island's text, and so its words, are unchanged.
export interface GroundFormat { n: number; patch: boolean; reach: number }
export const ISLAND_GROUND: GroundFormat = { n: N, patch: false, reach: 0 };
const nearIsland = /* wgsl */ `@compute @workgroup_size(256)
fn near(@builtin(local_invocation_id) lid: vec3u) {
  let t = lid.x;
  for (var k = 0u; k < NSIDE; k++) {
    let i = t + NSIDE * k;
    let ch = inp(I_channel, i) != 0i;
    NR[i] = select(INFN, inp(I_power, i), ch);
    NR[LEN + i] = select(INFR, 0i, ch);
  }
  storageBarrier(); workgroupBarrier();
  for (var d = 0u; d < 2u * NSIDE - 1u; d++) {
    if (d >= t && d - t < NSIDE) { nearStep((d - t) * NSIDE + t, t, d - t); }
    storageBarrier(); workgroupBarrier();
  }
  for (var e = 0u; e < 2u * NSIDE - 1u; e++) {
    let d = 2u * NSIDE - 2u - e;
    if (d >= t && d - t < NSIDE) { nearStep((d - t) * NSIDE + t, t, d - t); }
    storageBarrier(); workgroupBarrier();
  }
}`;
const nearPatch = /* wgsl */ `@compute @workgroup_size(256)
fn near(@builtin(local_invocation_id) lid: vec3u) {
  let t = lid.x;
  for (var i = t; i < LEN; i += 256u) {
    let ch = inp(I_channel, i) != 0i;
    NR[i] = select(INFN, inp(I_power, i), ch);
    NR[LEN + i] = select(INFR, 0i, ch);
  }
  storageBarrier(); workgroupBarrier();
  for (var d = 0u; d < 2u * NSIDE - 1u; d++) {
    for (var x = t; x < NSIDE; x += 256u) {
      if (x <= d && d - x < NSIDE) { nearStep((d - x) * NSIDE + x, x, d - x); }
    }
    storageBarrier(); workgroupBarrier();
  }
  for (var e = 0u; e < 2u * NSIDE - 1u; e++) {
    let d = 2u * NSIDE - 2u - e;
    for (var x = t; x < NSIDE; x += 256u) {
      if (x <= d && d - x < NSIDE) { nearStep((d - x) * NSIDE + x, x, d - x); }
    }
    storageBarrier(); workgroupBarrier();
  }
}`;
const nearEntry = (fmt: GroundFormat) => {
  if (!fmt.patch && fmt.n !== 256) throw new Error("the island's sweep is one workgroup of 256 columns");
  return fmt.patch ? nearPatch : nearIsland;
};

export const groundWgsl = (fmt: GroundFormat): string => {
const SIDE = fmt.n, CELLS = SIDE * SIDE, lim = fmt.patch ? ` && r <= ${fmt.reach}i` : "";
return /* wgsl */ `
${FIXED}
const LEN = ${CELLS}u;
const NSIDE = ${SIDE}u;
const O16 = 65536i;
const O24 = 16777216i;
const ONE28 = 268435456u;
const NS = ${NS}u;
const INFN = 0x7fffffffi;
const INFR = 0x3fffffffi;
${INPUTS.map((n, k) => `const I_${n} = ${k}u;`).join("\n")}
${OUTPUTS.map(([n], k) => `const O_${n} = ${k}u;`).join("\n")}
@group(0) @binding(0) var<storage, read_write> INP: array<i32>;
@group(0) @binding(1) var<storage, read_write> NR: array<i32>;
@group(0) @binding(2) var<storage, read_write> OUT: array<i32>;

const SPEC_MADE = ${ARR(MADE, "u32")};
const SPEC_P = ${ARR(PCLASS, "u32")};
const SPEC_TABLE = ${ARR(TABLE, "i32")};
const SPEC_PH = ${ARR(PHFIT, "i32")};
const SPEC_TALL = ${ARR(TALL, "i32")};
const SPEC_EVER = ${ARR(EVER, "u32")};
const DAY_FROM = ${ARR(DAY_FROM, "u32")};
const DAY_TOWARD = ${ARR(DAY_TOWARD, "i32")};
const DAY_PHOTO = ${ARR(DAY_PHOTO, "i32")};
const DAY_WEIGHT = ${ARR(DAY_WEIGHT, "i32")};
const HALF = ${ARR(HALF_Q16, "i32")};
const INV_P = ${ARR(PS.map((p) => Q(1 / (1 - p), 24)), "i32")};
const DR_SAND = ${DR((d) => d.sand)};
const DR_CLAY = ${DR((d) => d.clay)};
const RK_SAND = ${RK((r) => r.sand)};
const RK_CLAY = ${RK((r) => r.clay)};

fn inp(f: u32, i: u32) -> i32 { return INP[f * LEN + i]; }
fn put(f: u32, i: u32, v: i32) { OUT[f * LEN + i] = v; }

// round(a b / 2^sh) and round(a 2^sh / b), signed, saturating, sh from 1 to 31.
fn qm(a: i32, b: i32, sh: u32) -> i32 {
  let neg = (a < 0i) != (b < 0i);
  let p = add64(mul64(mag(a), mag(b)), vec2u(1u << (sh - 1u), 0u));
  if ((p.y >> sh) != 0u) { return select(FX_MAX, -FX_MAX, neg); }
  let r = (p.x >> sh) | (p.y << (32u - sh));
  if (r > 0x7fffffffu) { return select(FX_MAX, -FX_MAX, neg); }
  let v = bitcast<i32>(r);
  return select(v, -v, neg);
}
fn qd(a: i32, b: i32, sh: u32) -> i32 {
  let neg = (a < 0i) != (b < 0i);
  if (b == 0i) { return select(select(0i, -FX_MAX, a < 0i), FX_MAX, a > 0i); }
  let A = mag(a); let B = mag(b);
  let num = add64(vec2u(A << sh, A >> (32u - sh)), vec2u(B >> 1u, 0u));
  if (num.y >= B) { return select(FX_MAX, -FX_MAX, neg); }
  let q = divw(num.y, num.x, B).x;
  if (q > 0x7fffffffu) { return select(FX_MAX, -FX_MAX, neg); }
  let v = bitcast<i32>(q);
  return select(v, -v, neg);
}
fn mq(a: i32, b: i32) -> i32 { return qm(a, b, 24u); }
fn qq(a: i32, b: i32) -> i32 { return qm(a, b, 16u); }
// Saturation vapour pressure of the air at a temperature, kPa: Tetens' 0.6108 e^(17.27 t / (t + 237.3)) (FAO-56 eq. 11,
// R221; climate.ts esat), t in Q16 C.
fn esatQ(t: i32) -> i32 {
  return qq(${q16(0.6108)}, qexp(qd(qq(${q16(17.27)}, t), t + ${q16(237.3)}, 16u)));
}

// ---------- the nearest channel's power ----------
fn nearStep(i: u32, x: u32, y: u32) {
  var best = NR[i];
  var reach = NR[LEN + i];
  if (x > 0u) { let r = NR[LEN + i - 1u] + 1i; if (r < reach${lim}) { reach = r; best = NR[i - 1u]; } }
  if (x < NSIDE - 1u) { let r = NR[LEN + i + 1u] + 1i; if (r < reach${lim}) { reach = r; best = NR[i + 1u]; } }
  if (y > 0u) { let r = NR[LEN + i - NSIDE] + 1i; if (r < reach${lim}) { reach = r; best = NR[i - NSIDE]; } }
  if (y < NSIDE - 1u) { let r = NR[LEN + i + NSIDE] + 1i; if (r < reach${lim}) { reach = r; best = NR[i + NSIDE]; } }
  NR[i] = best;
  NR[LEN + i] = reach;
}
${nearEntry(fmt)}

// ---------- soil depth ----------
// S / (1 - r^2) across the face from cell a to its neighbour b (r = min(0.99, |S| / Sc), S = the fall of the ground's
// rise per cell, the sea level the floor), Q20, signed by S.
fn face(a: u32, b: u32) -> i32 {
  let dz = max(0i, inp(I_height, b)) - max(0i, inp(I_height, a));
  let n = add64(mul64(mag(dz), 256u), vec2u(${CELL >> 1}u, 0u));
  let S = i32(divw(n.y, n.x, ${CELL}u).x);
  let r = min(${q24(0.99)}, mq(S, ${q24(1 / SC)}));
  let T = (qd(S, O24 - mq(r, r), 24u) + 8i) >> 4u;
  return select(T, -T, dz < 0i);
}
// f(tau) = (1 - e^-tau) / tau in Q16, by its series where the exponential's rounding would swamp the quotient.
fn fOf(tau: i32) -> i32 {
  if (abs(tau) < ${q16(0.25)}) {
    let y = -tau;
    var t = O16;
    for (var k = 7i; k >= 2i; k--) { t = O16 + qq(t, y) / k; }
    return t;
  }
  return qd(O16 - qexp(-tau), tau, 16u);
}
fn soilOf(d0: i32, tau: i32) -> i32 {
  let l0 = qm(d0, ${q16(1 / H_STAR)}, 16u) - tau;
  let lam = qln(qq(${q16(B_SOIL)}, fOf(tau)));
  let delta = qadd(l0, -lam);
  let lnu = qadd(max(l0, lam), qln(O16 + qexp(-abs(delta))));
  return select(0i, qq(lnu, ${q16(H_STAR)}), lnu > 0i);
}

// ---------- what the root zone holds, and the soil's bulk density (Saxton and Rawls, ground.ts holds, density) ----------
// sa, cl in Q24, om the organic % in Q16 (read at most 8).
fn omIn(om: i32) -> i32 { return min(om, 8i * O16) << 8u; }
fn fcOf(sa: i32, cl: i32, om: i32) -> i32 {
  return -mq(${q24(0.251)}, sa) + mq(${q24(0.195)}, cl) + mq(${q24(0.011)}, om) + mq(${q24(0.006)}, mq(sa, om)) - mq(${q24(0.027)}, mq(cl, om)) + mq(${q24(0.452)}, mq(sa, cl)) + ${q24(0.299)};
}
fn theta33(fc: i32) -> i32 { return fc + mq(${q24(1.283)}, mq(fc, fc)) - mq(${q24(0.374)}, fc) - ${q24(0.015)}; }
fn holdsMm(soil: i32, sa: i32, cl: i32, org: i32) -> i32 {
  let om = omIn(org);
  let wp = -mq(${q24(0.024)}, sa) + mq(${q24(0.487)}, cl) + mq(${q24(0.006)}, om) + mq(${q24(0.005)}, mq(sa, om)) - mq(${q24(0.013)}, mq(cl, om)) + mq(${q24(0.068)}, mq(sa, cl)) + ${q24(0.031)};
  let t1500 = wp + mq(${q24(0.14)}, wp) - ${q24(0.02)};
  let dth = max(0i, theta33(fcOf(sa, cl, om)) - t1500);
  return qm(dth, min(soil, ${q16(ROOTS)}) * 1000i, 24u);
}
// g/cm3 in Q24.
fn densityOf(sa: i32, cl: i32, org: i32) -> i32 {
  let om = omIn(org);
  let fc = fcOf(sa, cl, om);
  let s33 = mq(${q24(0.278)}, sa) + mq(${q24(0.034)}, cl) + mq(${q24(0.022)}, om) - mq(${q24(0.018)}, mq(sa, om)) - mq(${q24(0.027)}, mq(cl, om)) - mq(${q24(0.584)}, mq(sa, cl)) + ${q24(0.078)};
  let sat = theta33(fc) + s33 + mq(${q24(0.636)}, s33) - ${q24(0.107)} - mq(${q24(0.097)}, sa) + ${q24(0.043)};
  return mq(O24 - sat, ${q24(2.65)});
}

// ---------- niche curves and the compensation point ----------
fn up24(x: i32, lo: i32, hi: i32) -> i32 {
  if (hi <= lo) { return select(0i, O24, x > lo); }
  let t = clamp(qd(x - lo, hi - lo, 24u), 0i, O24);
  return mq(mq(t, t), 3i * O24 - 2i * t);
}
// niche.ts curve over the water table, Q16 m in, Q24 out.
fn tableFit(s: u32, v: i32) -> i32 {
  let a = SPEC_TABLE[4u * s]; let b = SPEC_TABLE[4u * s + 1u]; let c = SPEC_TABLE[4u * s + 2u]; let d = SPEC_TABLE[4u * s + 3u];
  if (v <= b) { return up24(v, a, b); }
  if (v <= c) { return O24; }
  return O24 - up24(v, c, d);
}
// growth.ts closes: the share of the ground a stand covers at compensation point c (Q28 in, Q24 out).
fn closes(c: u32) -> i32 {
  if (c >= ONE28) { return 0i; }
  let p = add64(mul64(ONE28 - c, ${u32(1 / (1 - UNDER_CROWN), 28)}), vec2u(0x80000000u, 0u));
  return min(O24, i32(p.y));
}
// closes(c / light) for a light whose reciprocal is k.
fn closesK(c: u32, k: u32) -> i32 {
  let p = mul64(c, k);
  if (p.y != 0u || p.x >= ONE28) { return 0i; }
  return closes(p.x);
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= LEN) { return; }
  if (inp(I_open, i) != 0i) {
    put(O_bare, i, O24);
    for (var k = 0u; k < 4u; k++) { put(O_soilWater0 + k, i, O24); }
    return;
  }
  let x = i % NSIDE; let y = i / NSIDE;
  let h = inp(I_height, i);
  let rock = u32(inp(I_rock, i)); let kind = u32(inp(I_drift, i));
  let d0 = inp(I_driftDepth, i);

  // Soil since the ice: the creep's divergence over the four faces, then the log of the two exponentials.
  var sumT = 0i;
  if (x < NSIDE - 1u) { sumT += face(i, i + 1u); }
  if (x > 0u) { sumT += face(i, i - 1u); }
  if (y < NSIDE - 1u) { sumT += face(i, i + NSIDE); }
  if (y > 0u) { sumT += face(i, i - NSIDE); }
  let tau = -qm(sumT, ${q16(K_TAU)}, 20u);
  let soil = soilOf(d0, tau);

  // Beach sand on sediment coasts below the storm waves' reach (a sea cell has no neighbour but a sea's, so distance to
  // the sea within one cell is a sea cell beside it); alluvium and the stream's power; peat.
  var coast = false;
  if (x > 0u) { coast = coast || (inp(I_open, i - 1u) != 0i && inp(I_height, i - 1u) < 0i); }
  if (x < NSIDE - 1u) { coast = coast || (inp(I_open, i + 1u) != 0i && inp(I_height, i + 1u) < 0i); }
  if (y > 0u) { coast = coast || (inp(I_open, i - NSIDE) != 0i && inp(I_height, i - NSIDE) < 0i); }
  if (y < NSIDE - 1u) { coast = coast || (inp(I_open, i + NSIDE) != 0i && inp(I_height, i + NSIDE) < 0i); }
  let crystalline = rock == ${GRANITE}u || rock == ${DOLERITE}u;
  let sand = coast && h <= ${Math.floor(RUNUP * 65536)}i && !crystalline;
  let nearP = NR[i];
  let flood = inp(I_valley, i) > 0i && nearP != INFN;
  let silt = flood && nearP < ${q16(COHESIVE)};
  let wet = inp(I_dryTable, i) <= ${q16(ACROTELM)};
  let peaty = wet && !sand;

  // Texture: the drift over as much of the root zone as it fills, the rock below; alluvium; beach sand.
  let inDrift = min(O24, qd(d0, ${q16(ROOTS)}, 24u));
  var sa = mq(DR_SAND[kind], inDrift) + mq(RK_SAND[rock], O24 - inDrift);
  var cl = mq(DR_CLAY[kind], inDrift) + mq(RK_CLAY[rock], O24 - inDrift);
  if (flood) {
    sa = select(DR_SAND[${MELTWATER}u], ${q24(SILT_SAND)}, silt);
    cl = select(DR_CLAY[${MELTWATER}u], ${q24(SILT_CLAY)}, silt);
  }
  if (sand) { sa = DR_SAND[${MELTWATER}u]; cl = DR_CLAY[${MELTWATER}u]; }

  // pH of the mineral soil by what it formed in: 0 carbonate, 1 base-rich silicate, 2 the exchanger's range.
  let parentKind = inDrift >= O24 / 2i && kind != ${PEAT}u;
  let carbonate = !parentKind && rock == ${LIMESTONE}u;
  let rich = flood || (parentKind && kind == ${TILL_CLAY}u) || (!parentKind && (rock == ${MUDSTONE}u || rock == ${DOLERITE}u));
  var mc = 2u;
  if (carbonate) { mc = 0u; } else if (rich) { mc = 1u; }
  let mineral = select(select(${ph(EXCHANGER)}, ${ph(SILICATE)}, mc == 1u), ${ph(CARBONATE)}, mc == 0u);

  // The niches' fit here: the lowest of the pH curve and the water table's.
  let winter = min(inp(I_winterTable, i), ${DEEP_Q}i);
  var fit24: array<i32, ${NS}>;
  for (var s = 0u; s < NS; s++) { fit24[s] = min(SPEC_PH[mc * NS + s], tableFit(s, winter)); }

  // The seasons: sun times warmth (MJ/m2 a day, Q24; growth.ts warmEnough), and the year's maintenance (keptOf).
  var sw: array<i32, 4>;
  var kept = 0i;
  var warmthB = 0i;
  // The leaf display of the plants that lose their leaves (terrain-phenology.ts): each day's index, the product of the
  // coldest air's ramp, the daylight's and the driest air's, summed over the season with each day's share of its sun.
  var Tk: array<i32, 4>;
  var Ek: array<i32, 4>;
  for (var k = 0u; k < 4u; k++) {
    Tk[k] = inp(I_temp0 + k, i);
    Ek[k] = qq(min(O16, inp(I_humid0 + k, i)), esatQ(Tk[k]));
  }
  var leaf: array<i32, 4>;
  for (var j = 0u; j < ${4 * STEPS}u; j++) {
    let a = DAY_FROM[j]; let b = (a + 1u) & 3u; let f = DAY_TOWARD[j];
    let T = Tk[a] + qm(Tk[b] - Tk[a], f, 24u);
    let swing = HALF[a] + qm(HALF[b] - HALF[a], f, 24u);
    var g = mq(clamp(qd(T - swing + ${q16(-TMIN_LO)}, ${q16(TMIN_HI - TMIN_LO)}, 24u), 0i, O24), DAY_PHOTO[j]);
    if (g > 0i) {
      let vpd = esatQ(T + swing) - (Ek[a] + qm(Ek[b] - Ek[a], f, 24u));
      g = mq(g, O24 - clamp(qd(vpd * 1000i - ${q16(VPD_LO)}, ${q16(VPD_HI - VPD_LO)}, 24u), 0i, O24));
    }
    leaf[j / ${STEPS}u] += mq(DAY_WEIGHT[j], g);
  }
  var swD: array<i32, 4>;
  for (var k = 0u; k < 4u; k++) { swD[k] = mq(inp(I_sun0 + k, i) << 8u, leaf[k]); }
  let clay = qm(cl, 100i * O16, 24u);
  let mostMag = 20i * O16 + (clay * 13i + 5i) / 10i - (qq(clay, clay) + 50i) / 100i;
  var deficit = 0i;
  for (var year = 0u; year < 2u; year++) {
    for (var k = 0u; k < 4u; k++) {
      let temp = inp(I_temp0 + k, i);
      deficit = clamp(deficit + inp(I_precip0 + k, i) - inp(I_pet0 + k, i), -mostMag, 0i);
      if (year == 0u) { continue; }
      // warmEnough, clamp((T + 2) / 7, 0, 1)
      let w = clamp(temp + 2i * O16, 0i, 7i * O16);
      let warm = qd(w, 7i * O16, 24u);
      sw[k] = mq(inp(I_sun0 + k, i) << 8u, warm);
      // keptOf: 0.015 * 2^((T - 20) / 10), from the fraction of 2^f at Q1.31
      let ex = smulhi64(wide(temp - 20i * O16), ${u32(0.1, 32)});
      let sh = 7i - bitcast<i32>(ex.y);
      var m2 = e2f(ex.x);
      if (sh >= 32i) { m2 = 0u; } else if (sh > 0i) { m2 = m2 >> u32(sh); } else { m2 = m2 << u32(-sh); }
      kept += mq(i32(m2), ${q24(MAINT)});
      // RothC: the temperature rate a, and the moisture rate b of the topsoil's deficit
      let ea = qexp(qd(${q16(106.06)}, temp + ${q16(18.27)}, 16u));
      let warmth = qd(${q16(47.91)}, O16 + ea, 24u);
      let most = -mostMag;
      let cut = qq(${q16(0.444)}, most);
      var b = O24;
      if (deficit <= cut) { b = ${q24(0.2)} + mq(${q24(0.8)}, min(O24, qd(deficit - most, cut - most, 24u))); }
      warmthB += mq(warmth, b);
    }
  }

  // Fertility: the biomass and humus turning over against what the year's growth takes up, by clay alone; the
  // nitrogen's own factor (x 1000, Q24) for the NPP.
  let xx = qq(${q16(1.67)}, ${q16(1.85)} + qq(${q16(1.6)}, qexp(-qq(clay, ${q16(0.0786)}))));
  let turnover = qd(${q24((0.46 / CN_BIO + 0.54 / CN_HUM))}, xx, 16u);
  let fert = min(O24, mq(turnover, ${q24(CARBON / N_PLANT)}));
  let invx = qd(O16, xx, 24u);

  // Two passes [design]: the cover's organic matter changes what the soil holds, and so the cover.
  var om = 0i;
  var shw: array<i32, 4>;
  var moist = O24;
  var tree = 0i; var shrub = 0i; var grass = 0i; var marsh = 0i; var bare = 0i; var field = 0i; var fieldLight = 0i;
  var carbon = 0i; var nitrogen = 0i; var veg = 0i; var morShare = 0i;
  for (var round = 0u; round < 2u; round++) {
    // The soil bucket through the seasons, two years for it to settle.
    let cap = holdsMm(soil, sa, cl, om);
    var store = cap; var short = 0i; var want = 0i;
    for (var year = 0u; year < 2u; year++) {
      for (var k = 0u; k < 4u; k++) {
        let pet = inp(I_pet0 + k, i);
        let fed = inp(I_seasonTable0 + k, i) <= ${q16(ROOTS)};
        let have = store + inp(I_precip0 + k, i);
        let used = select(min(pet, have), pet, fed);
        store = select(min(cap, have - used), cap, fed);
        if (year == 1u) {
          short += pet - used; want += pet;
          if (cap > 0i) { shw[k] = min(O24, qd(store, cap, 24u)); } else { shw[k] = select(0i, O24, fed); }
        }
      }
    }
    if (want > 0i) { moist = O24 - qd(short, want, 24u); } else { moist = O24; }

    // Each p class's year of light made into dry matter: the sum over the seasons of sun x warmth x watered, for the
    // plants that keep their leaves (and for every plant's compensation point), and x leaf display for the carbon the
    // rest of the plants make (mpD).
    var mp: array<i32, ${PS.length}>;
    var mpD: array<i32, ${PS.length}>;
    for (var c = 0u; c < ${PS.length}u; c++) {
      var sum = 0i;
      var sumD = 0i;
      for (var k = 0u; k < 4u; k++) {
        let wet = min(O24, mq(shw[k], INV_P[c]));
        sum += mq(sw[k], wet);
        sumD += mq(swD[k], wet);
      }
      mp[c] = sum;
      mpD[c] = sumD;
    }
    // Every plant's compensation point at this place, Q28: kept / (made x fit), over the year.
    var comp: array<u32, ${NS}>;
    for (var s = 0u; s < NS; s++) {
      let D = mq(i32(mulhi(SPEC_MADE[s], u32(mp[SPEC_P[s]]))), fit24[s]);
      comp[s] = 0xffffffffu;
      if (D > 0i) {
        let hi = u32(kept) >> 4u;
        if (hi < u32(D)) { comp[s] = divw(hi, u32(kept) << 28u, u32(D)).x; }
      }
    }
    // Each form's best kind: the least compensation point (the first of equals).
    var tI = ${T0}u; var shI = ${S0}u; var fI = ${F0}u;
    for (var s = ${T0}u + 1u; s < ${S0}u; s++) { if (comp[s] < comp[tI]) { tI = s; } }
    for (var s = ${S0}u + 1u; s < ${RE}u; s++) { if (comp[s] < comp[shI]) { shI = s; } }
    for (var s = ${F0}u + 1u; s < ${F1}u; s++) { if (comp[s] < comp[fI]) { fI = s; } }
    let Tc = comp[tI]; let Shc = comp[shI]; let Rec = comp[${RE}]; let Gc = comp[${G}]; let Fc = comp[fI];

    let groundShare = select(O24, 0i, sand);
    let forest = mq(groundShare, closes(Tc));
    let canopy = mq(forest, O24 - ${q24(GAP)});
    let gap = forest - canopy;
    let young = mq(gap, closesK(Tc, ${per(GAP_LIGHT)}u));
    tree = canopy + young;
    // shrubs and reeds take the open ground and the gaps' floor by height, then the sward the open ground
    let shHigher = SPEC_TALL[shI] >= SPEC_TALL[${RE}];
    let hiC = select(Rec, Shc, shHigher); let loC = select(Shc, Rec, shHigher);
    let openRoom = groundShare - forest;
    let oa = mq(openRoom, closesK(hiC, 1u)); let ob = mq(max(0i, openRoom - oa), closesK(loC, 1u));
    let gapRoom = max(0i, gap - young);
    let ga = mq(gapRoom, closesK(hiC, ${per(GAP_LIGHT)}u)); let gb = mq(max(0i, gapRoom - ga), closesK(loC, ${per(GAP_LIGHT)}u));
    let oSh = select(ob, oa, shHigher); let oRe = select(oa, ob, shHigher);
    let gSh = select(gb, ga, shHigher); let gRe = select(ga, gb, shHigher);
    shrub = oSh + gSh; marsh = oRe + gRe;
    grass = mq(max(0i, openRoom - oSh - oRe), closesK(Gc, 1u));
    let fieldGap = mq(max(0i, gapRoom - gSh - gRe), closesK(Fc, ${per(GAP_LIGHT)}u));
    let fieldUnder = mq(canopy, closesK(Fc, ${per(UNDER_CROWN)}u));
    field = fieldGap + fieldUnder;
    if (field > 0i) { fieldLight = qd(mq(fieldGap, ${q24(GAP_LIGHT)}) + mq(fieldUnder, ${q24(UNDER_CROWN)}), field, 24u); } else { fieldLight = 0i; }
    bare = max(0i, O24 - tree - shrub - marsh - grass - select(0i, O24, sand));
    veg = tree + shrub + marsh + grass;
    morShare = select(0i, tree, tI == ${PINE}u) + select(0i, shrub, shI == ${HEATHER}u);

    // The year's carbon from the plants that reaches the soil, each form at its own drought tolerance in the light it
    // stands in; of a tree's or shrub's, only its foliage and roots (SOIL_SHARE), the wood staying in the stand.
    var acc = 0i;
    if (tree > 0i) { acc += mq(tree, mq(${q24(SOIL_SHARE)}, ${DM("tI")})); }
    if (oSh > 0i) { acc += mq(oSh, mq(${q24(SOIL_SHARE)}, ${DM("shI")})); }
    if (oRe > 0i) { acc += mq(oRe, ${DM(String(RE))}); }
    if (grass > 0i) { acc += mq(grass, ${DM(String(G))}); }
    if (gSh > 0i) { acc += mq(mq(gSh, ${q24(GAP_LIGHT)}), mq(${q24(SOIL_SHARE)}, ${DM("shI")})); }
    if (gRe > 0i) { acc += mq(mq(gRe, ${q24(GAP_LIGHT)}), ${DM(String(RE))}); }
    if (field > 0i) { acc += mq(mq(field, fieldLight), ${DM("fI")}); }
    let input = mq(mq(mq(acc, ${q24(1 - UNDER_CROWN)}), ${q24(DAYS * RUE * (CARBON / 100))}), fert);
    nitrogen = i32(mulhi(u32(input), u32(turnover) * 1000u));

    // RothC's steady state; peat is all organic at the bog's density.
    if (peaty) {
      carbon = ${q16(PEAT_CARBON)};
      om = 100i * O16;
    } else {
      let coverK = mq(${q24(0.6)}, veg) + (O24 - veg);
      let m = mq(coverK, warmthB) >> 2u;
      let wOpen = max(0i, veg - tree);
      let N24 = mq(tree, ${q24(DPM_RPM.tree)}) + mq(wOpen, ${q24(DPM_RPM.open)});
      var f = ${q24(DPM_RPM.open / (1 + DPM_RPM.open))};
      if (veg > 0i) { f = qd(N24, veg + N24, 24u); }
      let W = mq(f, ${q24(1 / K_DPM)}) + mq(O24 - f, ${q24(1 / K_RPM)}) + mq(invx, ${q24(0.46 / K_BIO + 0.54 / K_HUM)});
      var act = 0i;
      if (m > 0i) {
        let prod = mul64(u32(input), u32(W));
        let hi = prod.y >> 8u; let lo = (prod.x >> 8u) | (prod.y << 24u);
        if (hi < u32(m)) { act = i32(min(divw(hi, lo, u32(m)).x, 0x7fffffffu)); } else { act = FX_MAX; }
      }
      var toc = act;
      for (var n = 0u; n < 20u; n++) {
        var pw = 0i;
        if (toc > 0i) {
          let L = lg32(u32(toc));
          pw = exp2q(add64(L, smulhi64(L, ${u32(NU, 32)})));
        }
        toc = qadd(act, i32(mulhi(u32(pw), ${u32(0.049, 32)})));
      }
      carbon = toc;
      // Organic matter as a share of the topsoil's mass, its density settled in a few steps.
      let depth = min(${q16(TOPSOIL)}, soil);
      for (var n = 0u; n < 4u; n++) {
        if (depth > 0i) {
          let r = qd(toc, depth, 16u);
          let o = (qd(r, densityOf(sa, cl, om), 24u) + ${OM_DIV / 2}i) / ${OM_DIV}i;
          om = min(100i * O16, o);
        } else { om = 0i; }
      }
    }
  }

  // The mor pine and heather lay down sours base-poor ground.
  var phv = mineral;
  if (mc == 2u && veg > 0i) { phv = mineral + qm(${ph(MOR - EXCHANGER)}, qd(morShare, veg, 24u), 24u); }

  put(O_soil, i, soil);
  put(O_silt, i, select(0i, 1i, silt));
  put(O_sand, i, select(0i, 1i, sand));
  put(O_peat, i, select(0i, ${q16(PEAT_DEPTH)}, peaty));
  put(O_sandy, i, sa); put(O_clayey, i, cl);
  put(O_carbon, i, carbon); put(O_organic, i, om); put(O_nitrogen, i, nitrogen);
  put(O_ph, i, phv); put(O_fertility, i, fert); put(O_moist, i, moist);
  for (var k = 0u; k < 4u; k++) { put(O_soilWater0 + k, i, shw[k]); }
  put(O_tree, i, tree); put(O_shrub, i, shrub); put(O_grass, i, grass); put(O_marsh, i, marsh); put(O_bare, i, bare);
  put(O_field, i, field); put(O_fieldLight, i, fieldLight);
  for (var k = 0u; k < 4u; k++) { put(O_leaf0 + k, i, leaf[k]); }
}
`;
};
export const GROUND = groundWgsl(ISLAND_GROUND);
