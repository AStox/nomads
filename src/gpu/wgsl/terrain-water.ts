// The island's hydrology (src/terrain/water.ts hydrology and aquifer) in WGSL, integer throughout; src/gpu/terrain/water.ts
// drives it. Every field is one i32 word a cell in one storage buffer F, in FIELDS order; each has its unit where it is
// listed. The kernels are per-cell passes, or one workgroup of 256 that loops with barriers where the work is a graph
// walk or a relaxation:
// - the tree: pointer jumping over `to` gives each cell's depth, a counting sort files the cells by depth, and every
//   gather (flow accumulation) and channel pass then walks the depths deepest first, each cell pulling from the
//   neighbours that drain into it, so no atomics touch a sum and every sum is exact;
// - the aquifer: the CPU's over-relaxation at 1.6 with its row-by-row sweep, run along the anti-diagonals, which moves
//   every cell after the same neighbours as the row sweep does, so it takes the same number of sweeps and stops at the
//   same 2 mm change; the 256 columns are the 256 threads of one workgroup. It differs from the CPU's in one law: the
//   plants draw groundwater from the aquifer (the sink below: Shah et al.'s fall of the ground's lift with the water table
//   in MODFLOW's EVT form), which the CPU's steady solve lacks. The sink is solved in the sweep as a lagged diagonal: each
//   cell's balance is taken at the sink the cell's own head gave the last sweep, with a share of the cell's own head (the
//   sink's steepest fall) held in the weights, so the sweeps' count rule stands and the arithmetic stays integer;
// - the lakes: components of the hollows by minimum-label propagation, then each basin cell as a candidate level
//   against every cell of its hollow.
import { CELL, N } from "../../terrain/grid";
import { BARE, DRIFTS, ROCKS } from "../../terrain/geology";
import { ROOTS } from "../../terrain/growth";
import { NICHE } from "../../terrain/niche";
import { AT_D, BANKFULL, BUCKET, CONFINED, FALL, FLOOD, HEAD_C, KC_DEEP, KC_SHALLOW, RHO, G, SEASON_S, SHIELDS, SUBMERGED, SY_DRIFT, SY_ROCK, T_FILL, WIDE_WOOD, WINDOW_HEAD_C, YEAR_S } from "../../terrain/water";
import { FIXED } from "./fixed";

// ---------- units ----------
// Z:   Q12.20 metres (heights, depths, heads; the host checks that none reaches 1024 m, a sweep adds 2^30 to a head).
// MM:  Q16.16 millimetres.
// V:   Q25.6 cubic metres (a cell's volume in a season or a year), summed in 64 bits wherever cells are added.
// FQ:  Q6.26 cubic metres a second (flows; the island's biggest is about 1 and bankfull is 15 times that, under 64).
// S30: Q2.30 slopes (and slope35, the same in units of 2^-35, where the stage of a channel needs a flat's tiny fall).
// T13: Q19.13 transmissivity, m2 a year (the biggest cell holds under 82,000, a cell's four faces then sum under 2^32).
// W31: Q1.31 weights.
// A height is also held in a second word (hlo, flo) of what lies below its Z word, in units of 2^-31 of Z's last place.
export const ZS = 2 ** 20;
export const MAXD = 8190; // the deepest flow path the counting sort holds, cells
export const SWEEP_TOLERANCE_Z = 2097; // the CPU's 0.002 m, in Z, a sweep may still change by and stop

// The fields, in order. The outputs the host reads back are the last block, contiguous.
const INPUTS = ["sea", "h", "hlo", "filled", "flo", "to", "basin", "rock", "drift", "dd", "pr0", "pr1", "pr2", "pr3", "pe0", "pe1", "pe2", "pe3"];
const INTERNAL = [
  "fall", "su0", "su1", "su2", "su3", "sh0", "sh1", "sh2", "sh3", "wet", "rr", "bedT", "drK", "tt", "head", "depth", "hol", "spl", "isf", "fxv",
  "dep", "lvl", "lvs", "blist", "ua", "ub", "da", "db",
  "ce", "cs", "ww", "we", "wn", "ws", "wd", "sso", "out", "evd", "evb", "eve", "evs", "evk", "eaf", "evu", "evw",
  "gw", "bk", "ln", "qk0", "qk1", "qk2", "qk3", "wt0", "wt1", "wt2", "wt3", "wt4",
  "ga0l", "ga0h", "ga1l", "ga1h", "ga2l", "ga2h", "ga3l", "ga3h", "ga4l", "ga4h",
  "inl", "inh", "rk", "lv", "tgt", "dbf", "misc",
];
// water: Z standing water; flow, sf0..3, spring: FQ; tab, stb0..3, dry: Z; base: Q16 share; valley, spf: 0 or 1;
// chn: channel 0 or 1; open: 0 or 1; qbf: FQ; slope: S30; pwr: Q16 W/m2; rtl, rth: the stream's flow under its bed, Q40 m3/s
// in two words.
export const OUTPUTS = ["water", "flow", "sf0", "sf1", "sf2", "sf3", "tab", "stb0", "stb1", "stb2", "stb3", "dry", "spring", "base", "valley", "chn", "open", "qbf", "slope", "pwr", "rtl", "rth", "spf"];
export const FIELDS: readonly string[] = [...INPUTS, ...INTERNAL, ...OUTPUTS];
export const FIELD = Object.fromEntries(FIELDS.map((n, k) => [n, k])) as Record<string, number>;

// The formats a run's kernels are generated in: the island's (heights Q12.20 m under 1,024 m, flows Q6.26 m3/s under 4.3 with
// their bankfull 15 times that), and a window's, whose ground stands kilometres high and whose rivers carry hundreds of cubic metres
// a second: heights Q15.17 m (under 8,192 m with a sweep's offset of 2^30), flows Q16.16 m3/s (bankfull under 65,536, the mean
// under 4,369) [design]. A window's rivers from beyond its edge come in at their cells as drainage area (cells) and as water (m3
// a year and a season, Q6, 64 bits), added to the gathers of each.
// `side` is the grid's side in cells (the island's 256 by default; a patch of the planet's tier is 256 plus its halo twice). `planet` is the format of a patch of the whole planet
// (always a window's): a cell may be `void` (a repeat at a cube's corner: it carries no water and no flux), and a hollow's lake stands at the flooded surface the planet's flood
// gave it (the hollows are the planet's, so none is cut by the grid's edge and no lake's level is a window's) [design].
export interface WaterFormat { zb: number; qb: number; window: boolean; side?: number; planet?: boolean; len?: number; omega?: number }
export const ISLAND_WATER: WaterFormat = { zb: 20, qb: 26, window: false };
export const WINDOW_WATER: WaterFormat = { zb: 17, qb: 16, window: true };
export const planetWater = (side: number): WaterFormat => ({ zb: 17, qb: 16, window: true, side, planet: true });
export const sideOf = (fmt: WaterFormat) => fmt.side ?? N;
// The change in a head (Z) under which a sweep stops the relaxation: the CPU's 2 mm in the island's and a window's formats, half a millimetre in a planet's (a planet's is relaxed in two colours
// at 1.9, and a tighter change than that is under the noise of the integer arithmetic: the sums of the head and the flow agreed to 1e-6 between half and a quarter of a millimetre) [design].
export const sweepTol = (fmt: WaterFormat) => (fmt.planet ? Math.round(0.0005 * 2 ** fmt.zb) : fmt.window ? Math.round(0.002 * 2 ** fmt.zb) : SWEEP_TOLERANCE_Z) + 1;
// the inflow's words, each a low and a high word: the area, the year's water and each season's
export const INFLOW = ["ia0l", "ia0h", "iy0l", "iy0h", "is0l", "is0h", "is1l", "is1h", "is2l", "is2h", "is3l", "is3h"];
export const layoutOf = (fmt: WaterFormat) => {
  const fields: readonly string[] = fmt.window ? [...INPUTS, ...INFLOW, ...(fmt.planet ? ["voidc", "tch", "tpw", "tdb", "tht", "plcf"] : []), ...INTERNAL, ...OUTPUTS] : FIELDS;
  return { FIELDS: fields, FIELD: Object.fromEntries(fields.map((n, k) => [n, k])) as Record<string, number> };
};
// Atomic words (AT): each region is LEN words.
export const AT_REGIONS = ["lab", "hist", "cur", "lbest", "lsp", "plc", "cnt"];
export const AT_OF = Object.fromEntries(AT_REGIONS.map((n, k) => [n, k])) as Record<string, number>;
// misc words
export const MISC = { maxd: 0, sweeps1: 2, sweeps2: 3, rounds: 4, quick: 16 };

const q16 = (x: number) => Math.round(x * 65536);
// transmissivity's scale: the sum of a cell's four faces, 4 x 82,000 m2 a year at most, then holds in a u32
export const TS = 2 ** 13;
const two = (v: bigint) => { const u = BigInt.asUintN(64, v); return [Number(u & 0xffffffffn), Number(u >> 32n)] as const; };

// bankDepth = 2^((log2 0.201 + 0.336 log2 Q - 0.085 log2 S + 0.025 log2(1.65 tau*)) / 1.025) (water.ts 66)
const BD0 = (Math.log2(0.201) + 0.025 * Math.log2(SUBMERGED * SHIELDS)) / 1.025, BD1 = 0.336 / 1.025, BD2 = 0.085 / 1.025;
const BD0W = two(BigInt(Math.round(BD0 * 2 ** 32)));
const D04 = BANKFULL ** -AT_D; // depthOf at the mean flow against the bankfull one
const springK = (qb: number) => (CELL * CELL / 1000) * 2 ** qb / YEAR_S / 65536; // MM in, FQ out: a spring's flow that evaporates (mm over a year)

// ---------- groundwater evapotranspiration ----------
// What the plants draw from the water table, per cell and year: for each season the least of the demand the soil's bucket
// left unmet (the shortfall: the potential evaporation less what the soil gave, which the ground takes the soil's water
// from only where the table is within reach) and what the ground can lift (potential evaporation times f(d)), d the depth
// of the head below the ground. This is MODFLOW's EVT package (a head-dependent flux out of the aquifer at the ground,
// falling to nothing at an extinction depth; Harbaugh 2005, the USGS online guide to EVT) with the fall of Shah, Nachabe
// and Ross (2007; Shah's 2007 dissertation, ch. 3, tables 3.1 and 3.3), who ran variably saturated flow under drying soil
// for twelve USDA textures: groundwater supplies all the demand to the decoupling depth d'' (27 to 78 cm for a grass
// cover of 1.0 m roots, which is this model's ROOTS, growth.ts) and beyond it falls off exponentially, e^(-b (d - d'')), to
// the extinction depth (1.45 to 7.15 m). The curve is rescaled to reach 0 exactly at the table's extinction depth:
// f(d) = (e^(-b (d - d'')) - e0) / (1 - e0), e0 = e^(-b (d_ext - d'')) [design: Shah's fit has a small offset y0 instead,
// which reaches 0 at about the table's depth, within 10% in the rows checked, and never for the clays]. The form of Shah's
// eq. 3.17 was not recoverable from the text (the equation was lost in the PDF's extraction): y0 + e^(-b (d - d'')) is
// [INFERENCE], checked against table 3.1's extinction depths for sand (258 cm against 250), sandy loam (232 against 230)
// and loam (370 against 370). The grass column stands for every cover, as the cover is made after the water (the forest
// column, 2.0 m roots, would reach deeper) [gap].
// [d'' cm, b per cm, extinction depth cm], grassland (Shah's tables 3.3 and 3.1)
export const SHAH_GRASS: Record<string, [number, number, number]> = {
  "sand": [27, 0.036, 145], "loamy sand": [29, 0.031, 170], "sandy loam": [35, 0.022, 230], "sandy clay loam": [31, 0.020, 300],
  "sandy clay": [35, 0.028, 310], "loam": [39, 0.015, 370], "silty clay": [78, 0.020, 430], "clay loam": [35, 0.014, 505],
  "silt loam": [40, 0.011, 515], "silt": [49, 0.021, 530], "silty clay loam": [49, 0.017, 550], "clay": [70, 0.017, 715],
};
// The USDA texture class of a soil of this sand and clay share (0 to 1; the silt is what is left): the standard triangle
// (Soil Survey Manual, ch. 3, fig. 3-7; its edges were not read, and the ten materials here lie off them but for
// mudstone's clay of 20% and dolerite's silt of 40%) [UNVERIFIED].
export function textureClass(sand: number, clay: number): string {
  const s = sand * 100, c = clay * 100, z = 100 - s - c;
  if (c >= 40) return s > 45 ? "sandy clay" : z >= 40 ? "silty clay" : "clay";
  if (c >= 35 && s > 45) return "sandy clay";
  if (c >= 27) return s > 45 ? "sandy clay loam" : s > 20 ? "clay loam" : "silty clay loam";
  if (c >= 20 && z < 28 && s > 45) return "sandy clay loam";
  if (z >= 80 && c < 12) return "silt";
  if (z >= 50) return "silt loam";
  if (c >= 7 && z >= 28 && s < 52) return "loam";
  if (z + 1.5 * c < 15) return "sand";
  if (z + 1.5 * c < 30 && z + 2 * c >= 15) return "loamy sand";
  return "sandy loam";
}
// The fall's four numbers for a material of this texture, in the kernel's units: d'' in Z, b per metre in Q16, and e0 and
// the rescaling 1 / (1 - e0) in Q16.
const gwet = (sand: number, clay: number, zs: number) => {
  const [d, b, ext] = SHAH_GRASS[textureClass(sand, clay)], e0 = Math.exp(-b * (ext - d));
  return [Math.round((d / 100) * zs), Math.round(b * 100 * 65536), Math.round(e0 * 65536), Math.round(65536 / (1 - e0))];
};
const gwRock = (zs: number) => ROCKS.flatMap((r) => gwet(r.sand, r.clay, zs)).map((v) => `${v}i`).join(", ");
const gwDrift = (zs: number) => DRIFTS.flatMap((d) => gwet(d.sand, d.clay, zs)).map((v) => `${v}i`).join(", ");
// 2^-x for x in 0 to 1 in steps of 1/256, Q30
const exp2Tab = Array.from({ length: 257 }, (_, k) => `${Math.round(2 ** 30 * 2 ** (-k / 256))}u`).join(", ");
const KD_K = Math.round(((CELL * CELL) / 1000) * TS); // a cell's area in m2 over 1000 mm a m, in T's scale: mm a year per metre of depth (Q16) to m2 a year (T)
// Wet ground evaporates more than the reference grass the soil's bucket stands for: where the water table is within the
// reeds' niche (very wet, under 0.2 m, falling to nothing at 0.4 m: ESC's regimes, niche.ts reeds, R606) the plants are
// reed swamp, whose crop coefficient is 1.2 in mid season (FAO-56 Table 12, reed swamp, standing water 1.0 / 1.2 / 1.0
// and moist soil 0.9 / 1.2 / 0.7 for the start, middle and end of the growing season; R559, read 2026-10-18). The game's
// summer stands for the mid season and the other seasons for its start and end, whose coefficients do not pass the
// reference's 1.0 [design: the seasons are 92 days against the table's stages of 10, 30, 80 and 20 days for temperate
// wetlands]. The water the ground gives such plants in summer is that 0.2 of the potential evaporation, as far as the
// niche's fit goes, on top of what the bucket left unmet. The cover is made after the water, so the niche's own rule
// that nothing else stands on such ground stands in for it [design].
const reedZ = (zs: number) => [Math.round(NICHE.reeds.table![2] * zs), Math.round(NICHE.reeds.table![3] * zs)];
export const KC_WET = 1.2;
export const SUMMER = 1;

const rockTab = ROCKS.map((r) => `${Math.round(r.ksat * r.thick * YEAR_S * TS)}u`).join(", ");
const rockCap = ROCKS.map((r) => (Number.isFinite(r.cap) ? `${Math.round(r.cap * 65536)}i` : "2147483647i")).join(", ");
const rockSy = ROCKS.map((_, k) => `${q16(SY_ROCK[k] ?? 0)}i`).join(", ");
const driftK = DRIFTS.map((d) => `${Math.round(d.ksat * YEAR_S * TS)}u`).join(", ");
const driftShare = DRIFTS.flatMap((d) => d.recharge.map((r) => `${q16(r)}i`)).join(", ");
const driftSy = DRIFTS.map((_, k) => `${q16(SY_DRIFT[k] ?? 0)}i`).join(", ");

export const constsOf = (fmt: WaterFormat, FIELDS: readonly string[]) => {
  const ZS = 2 ** fmt.zb, [REED_FULL, REED_NONE] = reedZ(ZS), W = fmt.window, LEN = fmt.len ?? sideOf(fmt) ** 2;
  return /* wgsl */ `
const SIDE = ${sideOf(fmt)}u;
const SIDEI = ${sideOf(fmt)}i;
const LEN = ${LEN}u;
${FIELDS.map((n, k) => `const f_${n}: u32 = ${k * LEN}u;`).join("\n")}
${AT_REGIONS.map((n, k) => `const a_${n}: u32 = ${k * LEN}u;`).join("\n")}
const MAXD = ${MAXD}u;
const NR = ${ROCKS.length}u;
const ROCK_T = array<u32, ${ROCKS.length}>(${rockTab});
const ROCK_CAP = array<i32, ${ROCKS.length}>(${rockCap});
const ROCK_SY = array<i32, ${ROCKS.length}>(${rockSy});
const DRIFT_K = array<u32, ${DRIFTS.length}>(${driftK});
const DRIFT_SHARE = array<i32, ${DRIFTS.length * 3}>(${driftShare});
const DRIFT_SY = array<i32, ${DRIFTS.length}>(${driftSy});
const KC_DEEP = array<i32, 4>(${KC_DEEP.map(q16).join(", ")});
const DX = array<i32, 8>(1, 1, 0, -1, -1, -1, 0, 1);
const DY = array<i32, 8>(0, 1, 1, 1, 0, -1, -1, -1);
const BUCKET_Q16 = ${q16(BUCKET)}i;
const FALL_F = vec2u(${two(BigInt(Math.round(FALL * 2 ** (fmt.zb + 31)))).join("u, ")}u);
const REACH_ORTH = ${q16(CELL)}u;
const REACH_DIAG = ${q16(Math.hypot(1, 1) * CELL)}u;
const ONE_Z = ${ZS}i;
const ROOTS_Z = ${Math.round(ROOTS * ZS)}i;
const KCS = ${q16(KC_SHALLOW)}i;
const RA_K = ${Math.round((CELL * CELL * 2 ** (fmt.zb + 13)) / 65536 / 1000)}u;
const MMV = ${(CELL * CELL) / 1000 * 64}u;
const C_YEAR = ${Math.round(2 ** 32 * 2 ** (fmt.qb - 6) / YEAR_S)}u;
const C_SEASON = ${Math.round(2 ** 32 * 2 ** (fmt.qb - 6) / SEASON_S)}u;
const K_YEAR = ${Math.round((YEAR_S / 2 ** (fmt.qb - 6)) * 65536)}u;
const BANKFULL_Q16 = ${q16(BANKFULL)}u;
const ONE_MINUS_D04 = ${q16(1 - D04)}i;
const RISE_Q16 = ${q16(FLOOD ** AT_D - 1)}i;
const BD0V = vec2u(${BD0W[0]}u, ${BD0W[1]}u);
const BD1U = ${Math.round(BD1 * 2 ** 32)}u;
const BD2U = ${Math.round(BD2 * 2 ** 32)}u;
const POWER_K = ${q16((RHO * G) / WIDE_WOOD)}i;
const WOOD_W = ${q16(WIDE_WOOD)}i;
const CONFINED_Q16 = ${q16(CONFINED)}i;
const TFILL = ${Math.round(T_FILL * 2 ** 32)}u;
const SPRING_K = ${Math.round(springK(fmt.qb) * 2 ** 32)}u;
const GW_ROCK = array<i32, ${ROCKS.length * 4}>(${gwRock(ZS)});
const GW_DRIFT = array<i32, ${DRIFTS.length * 4}>(${gwDrift(ZS)});
const EXP2 = array<u32, 257>(${exp2Tab});
const KD_K = ${KD_K}u;
const LOG2E_Q16 = 94548u;
const REED_FULL = ${REED_FULL}i;
const REED_NONE = ${REED_NONE}i;
const REED_SLOPE = ${Math.round(65536 / (NICHE.reeds.table![3] - NICHE.reeds.table![2]))}i;
const KC_X = ${q16(KC_WET - 1)}i;
const SUMMER = ${SUMMER}u;
const RISE_Z = ${Math.round((W ? 2 ** fmt.zb / 65536 / 1000 : 0.016) * 2 ** 32)}u;
const SWEEP_TOL = ${sweepTol(fmt)}u;
${W ? headWords() : `const HEAD_NUM = ${Math.round(CELL / HEAD_C)}u;`}
const OFF = 1073741824i;
`;
};

// A window's channel head: cells * fall^2 against (C / CELL) 2^60 as two words, low and high, C its own (WINDOW_HEAD_C).
const headWords = () => {
  const t = BigInt(Math.round((WINDOW_HEAD_C / CELL) * 2 ** 52)) << 8n;
  return `const HEAD_T0 = ${t & 0xffffffffn}u;\nconst HEAD_T1 = ${t >> 32n}u;`;
};
export const kernelsOf = (fmt: WaterFormat) => {
  // the units the format's words imply: the shift that takes a height in Z to whole units of its scale, the slope35 fall's
  // units (2^-(zb + 15)) to Q30, and the log2 of a flow's scale over Q16's
  const zb = fmt.zb, s30 = zb - 15, W = fmt.window, side = sideOf(fmt), pow2 = (side & (side - 1)) === 0, planet = fmt.planet === true;
  return /* wgsl */ `
@group(0) @binding(0) var<storage, read_write> F: array<i32>;
@group(0) @binding(1) var<storage, read_write> AT: array<atomic<u32>>;
@group(0) @binding(2) var<storage, read> P: array<u32>;
// every entry point touches all three bindings, so that one bind group fits each of the auto layouts
fn touch() { _ = arrayLength(&F); _ = arrayLength(&AT); _ = arrayLength(&P); }
// a cell's column and row on the grid (x east, y north), whatever the side
fn cx(i: u32) -> u32 { return ${pow2 ? `i & ${side - 1}u` : "i % SIDE"}; }
fn cy(i: u32) -> u32 { return ${pow2 ? `i >> ${Math.log2(side)}u` : "i / SIDE"}; }

fn gi(f: u32, i: u32) -> i32 { return F[f + i]; }
fn gu(f: u32, i: u32) -> u32 { return bitcast<u32>(F[f + i]); }
fn wi(f: u32, i: u32, v: i32) { F[f + i] = v; }
fn wu(f: u32, i: u32, v: u32) { F[f + i] = bitcast<i32>(v); }
fn gs(f: u32, s: u32, i: u32) -> i32 { return F[f + s * LEN + i]; }

// ---------- 64-bit helpers on top of fixed.ts ----------
fn s64(v: i32) -> vec2u { return vec2u(bitcast<u32>(v), select(0u, 0xffffffffu, v < 0i)); }
fn smul64(a: i32, b: u32) -> vec2u { let p = mul64(mag(a), b); return select(p, neg64(p), a < 0i); }
fn sar64(v: vec2u, s: u32) -> vec2u { return vec2u((v.x >> s) | (v.y << (32u - s)), bitcast<u32>(bitcast<i32>(v.y) >> s)); }
fn rsar64(v: vec2u, s: u32) -> vec2u { return sar64(add64(v, vec2u(1u << (s - 1u), 0u)), s); }
fn sat32(v: vec2u) -> i32 {
  if (v.y == 0u && v.x < 0x80000000u) { return bitcast<i32>(v.x); }
  if (v.y == 0xffffffffu && v.x >= 0x80000000u) { return bitcast<i32>(v.x); }
  return select(FX_MAX, -FX_MAX, isneg64(v));
}
fn usat32(v: vec2u) -> u32 { return select(v.x, 0xffffffffu, v.y != 0u); }
// (a * b) >> s for the low word, s in 1..31
fn mulshr(a: u32, b: u32, s: u32) -> u32 { let p = mul64(a, b); return (p.x >> s) | (p.y << (32u - s)); }
// x * c / 2^32 for a signed x, truncated
fn sscale(x: i32, c: u32) -> i32 { let r = bitcast<i32>(mul64(mag(x), c).y); return select(r, -r, x < 0i); }
// millimetres Q16 to cubic metres a cell Q6
fn mm_v(mm: i32) -> i32 { return sat32(rsar64(smul64(mm, MMV), 16u)); }
fn ld64(f: u32, i: u32) -> vec2u { return vec2u(gu(f, i), gu(f + LEN, i)); }

// ---------- the ground's fall, the bucket, the rain's share, the first transmissivity ----------
// A height is held twice: the Q12.20 word, and the rest of it below the word's last place in a second, as units of
// 2^-31 of that place, so a fall of 1e-4 m between two cells of a flat (the priority flood's step) keeps its size.
fn fine(hi: i32, lo: i32) -> vec2u {
  let a = s64(hi);
  return add64(vec2u(a.x << 31u, (a.y << 31u) | (a.x >> 1u)), s64(lo));
}
// the fall from cell i to the sea's level or the ground of its receiver, units of 2^-51 m, at least the floor
fn fall_fine(hi_f: u32, lo_f: u32, i: u32, j: u32, floor: vec2u) -> vec2u {
  let a = fine(gi(hi_f, i), gi(lo_f, i));
  let b = fine(gi(hi_f, j), gi(lo_f, j));
  let dz = sub64(a, select(b, vec2u(0u), isneg64(b)));
  return select(dz, floor, isneg64(dz) || lt64(dz, floor));
}
// floor(n / d) for a 64-bit n
fn div64(n: vec2u, d: u32) -> vec2u {
  let qh = n.y / d;
  return vec2u(divw(n.y - qh * d, n.x, d).x, qh);
}
fn reach_of(i: u32) -> u32 {
  let j = gu(f_to, i);
  return select(REACH_ORTH, REACH_DIAG, (cx(j) != cx(i)) && (cy(j) != cy(i)));
}
// a cell's slope to the sea's level or the ground of its receiver, in units of 2^-35: the fall in 2^-51 m over the reach in
// 2^-16 m (a flat's 1e-4 m step over 75 m is 1.3e-6, which a Q30 slope holds to 7e-4 and this to 2e-5)
fn slope35(i: u32) -> vec2u {
  return div64(fall_fine(f_filled, f_flo, i, gu(f_to, i), FALL_F), reach_of(i));
}
// units of 2^-35 to Q30, rounded, saturating
fn s30_of(v: vec2u) -> u32 {
  let r = add64(v, vec2u(${1 << (s30 - 1)}u, 0u));
  return select((r.x >> ${s30}u) | (r.y << ${32 - s30}u), 0xffffffffu, (r.y >> ${s30}u) != 0u);
}
@compute @workgroup_size(256)
fn prep(@builtin(global_invocation_id) g: vec3u) {
  let i = g.x;
  let hq = gi(f_h, i); let fq = gi(f_filled, i);
  let sea = gi(f_sea, i) != 0i;
  var sl = 0u; var fl = 0u;
  let j = gu(f_to, i);
  if (!sea && j != i) {
    sl = s30_of(slope35(i));
    fl = s30_of(div64(fall_fine(f_h, f_hlo, i, j, vec2u(0u)), reach_of(i)));
  }
  wu(f_slope, i, sl); wu(f_fall, i, fl);
  var wet = 0i; var rr = 0i;
  let rock = gu(f_rock, i); let drift = gu(f_drift, i); let dd = gi(f_dd, i);
  if (!sea) {
    var store = BUCKET_Q16;
    for (var year = 0u; year < 2u; year++) {
      for (var s = 0u; s < 4u; s++) {
        let pe = gs(f_pe0, s, i);
        let have = store + gs(f_pr0, s, i);
        let used = min(pe, have);
        let left = have - used;
        let over = max(0i, left - BUCKET_Q16);
        store = left - over;
        if (year == 1u) {
          F[f_su0 + s * LEN + i] = over;
          F[f_sh0 + s * LEN + i] = pe - used;
          wet += over;
        }
      }
    }
    let band = select(select(2u, 1u, dd <= 5i * ONE_Z), 0u, dd <= 3i * ONE_Z);
    rr = min(qmul(DRIFT_SHARE[drift * 3u + band], wet), ROCK_CAP[rock]);
  }
  wi(f_wet, i, wet); wi(f_rr, i, rr);
  // the groundwater evapotranspiration's fall (above): the drift's texture over as much of the roots' metre as the drift
  // fills and the rock's below, as ground.ts takes the soil's texture [design]
  let fill = i32(min(65536u, div64(mul64(u32(max(dd, 0i)), 65536u), u32(ROOTS_Z)).x));
  for (var k = 0u; k < 4u; k++) { F[f_evd + k * LEN + i] = qmul(GW_DRIFT[drift * 4u + k], fill) + qmul(GW_ROCK[rock * 4u + k], 65536i - fill); }
  var bed = ROCK_T[rock]; var dk = DRIFT_K[drift];${planet ? "\n  if (gi(f_voidc, i) != 0i) { bed = 0u; dk = 0u; }" : ""}
  wu(f_bedT, i, bed); wu(f_drK, i, dk);
  let p = add64(mul64(dk, u32(dd)), vec2u(1u << ${zb - 1}u, 0u));
  wu(f_tt, i, bed + ((p.x >> ${zb}u) | (p.y << ${32 - zb}u)));
  wi(f_head, i, hq - 3i * ONE_Z);
  let basin = gi(f_basin, i) != 0i;
  wi(f_open, i, select(0i, 1i, sea || basin));
  wi(f_depth, i, select(0i, fq - hq, basin));
}

// ---------- the hollows: components of basin cells, labelled by their least cell ----------
var<workgroup> wflag: atomic<u32>;
var<workgroup> wuni: u32;
fn lab(i: u32) -> u32 { return atomicLoad(&AT[a_lab + i]); }
@compute @workgroup_size(256)
fn hollows(@builtin(local_invocation_index) t: u32) {
  for (var i = t; i < LEN; i += 256u) {
    let inb = gi(f_basin, i) != 0i && gi(f_sea, i) == 0i;
    atomicStore(&AT[a_lab + i], select(0xffffffffu, i, inb));
  }
  storageBarrier(); workgroupBarrier();
  var rounds = 0u;
  for (var r = 0u; r < 4096u; r++) {
    if (t == 0u) { atomicStore(&wflag, 0u); }
    storageBarrier(); workgroupBarrier();
    for (var i = t; i < LEN; i += 256u) {
      let own = lab(i);
      if (own == 0xffffffffu) { continue; }
      var m = min(own, lab(own));
      let x = i32(cx(i)); let y = i32(cy(i));
      for (var d = 0u; d < 8u; d++) {
        let nx = x + DX[d]; let ny = y + DY[d];
        if (nx < 0i || ny < 0i || nx >= SIDEI || ny >= SIDEI) { continue; }
        m = min(m, lab(u32(ny) * SIDE + u32(nx)));
      }
      if (m < own) { atomicMin(&AT[a_lab + i], m); atomicOr(&wflag, 1u); }
    }
    storageBarrier(); workgroupBarrier();
    if (t == 0u) { wuni = atomicLoad(&wflag); }
    workgroupBarrier();
    rounds = r + 1u;
    if (workgroupUniformLoad(&wuni) == 0u) { break; }
  }
  if (t == 0u) { wi(f_misc, MISC_ROUNDS, i32(rounds)); }
  for (var i = t; i < LEN; i += 256u) {
    let l = lab(i);
    if (l == 0xffffffffu) { wi(f_hol, i, -1i); continue; }
    wi(f_hol, i, i32(l));
    wi(f_spl, i, 1i);
    let n = atomicAdd(&AT[a_cnt], 1u);
    wu(f_blist, n, i);
  }
}
${planet ? `// a planet's hollows are whole (the flood that made them ran over the planet), so each is its own label and every one spills: its lake stands at the flooded surface
@compute @workgroup_size(256)
fn hollowset(@builtin(global_invocation_id) g: vec3u) {
  let i = g.x;
  let inb = gi(f_basin, i) != 0i && gi(f_sea, i) == 0i;
  wi(f_hol, i, select(-1i, i32(i), inb));
  wi(f_spl, i, select(0i, 1i, inb));
}
// where a channel begins (the weights of the planet's channel gather: a cell is a channel where anything that drains to it begins one), needs the cells gathered and the fall
@compute @workgroup_size(256)
fn beginsw(@builtin(global_invocation_id) g: vec3u) {
  let i = g.x;
  let valid = gi(f_sea, i) == 0i && !nonspill(i);
  wi(f_wt0, i, select(0i, 1i, valid && begins(gu(f_ga0l, i), gu(f_fall, i))));
}` : ""}

// ---------- the tree: depth by pointer jumping, then the cells filed by depth ----------
@compute @workgroup_size(256)
fn levels(@builtin(local_invocation_index) t: u32) {
  for (var i = t; i < LEN; i += 256u) {
    let j = gu(f_to, i);
    wu(f_ua, i, j);
    wi(f_da, i, select(1i, 0i, j == i));
  }
  storageBarrier(); workgroupBarrier();
  for (var r = 0u; r < 14u; r++) {
    let src = select(f_ua, f_ub, (r & 1u) == 1u);
    let srcd = select(f_da, f_db, (r & 1u) == 1u);
    let into = select(f_ub, f_ua, (r & 1u) == 1u);
    let intod = select(f_db, f_da, (r & 1u) == 1u);
    for (var i = t; i < LEN; i += 256u) {
      let j = gu(src, i);
      wu(into, i, gu(src, j));
      wi(intod, i, gi(srcd, i) + gi(srcd, j));
    }
    storageBarrier(); workgroupBarrier();
  }
  // after an even number of rounds the result is in ua, da
  for (var i = t; i < LEN; i += 256u) {
    let u = gu(f_ua, i);
    if (gu(f_to, u) != u) { atomicOr(&AT[a_cnt + 1u], 1u); }
    let d = gi(f_da, i);
    wi(f_dep, i, d);
    if (u32(d) > MAXD) { atomicOr(&AT[a_cnt + 1u], 2u); } else { atomicAdd(&AT[a_hist + u32(d)], 1u); }
  }
  storageBarrier(); workgroupBarrier();
  if (t == 0u) {
    var run = 0u; var top = 0u;
    for (var d = 0u; d <= MAXD + 1u; d++) {
      wu(f_lvs, d, run);
      atomicStore(&AT[a_cur + d], run);
      let c = atomicLoad(&AT[a_hist + d]);
      if (c > 0u) { top = d; }
      run += c;
    }
    wi(f_misc, MISC_MAXD, i32(top));
  }
  storageBarrier(); workgroupBarrier();
  for (var i = t; i < LEN; i += 256u) {
    let d = gu(f_dep, i);
    if (d <= MAXD) { let p = atomicAdd(&AT[a_cur + d], 1u); wu(f_lvl, p, i); }
  }
}

// ---------- weights for the gathers that are not the route's ----------
@compute @workgroup_size(256)
fn weights(@builtin(global_invocation_id) g: vec3u) {
  let i = g.x;
  // variant 0: one a cell (the drainage area in cells); 1: the year's surplus over each cell, m3 a year
  wi(f_wt0, i, select(mm_v(gi(f_wet, i)), 1i, P[0] == 0u));
}

// ---------- gathers: each cell's weight and all that drains into it, deepest first ----------
// water.ts gather: a cell's total goes to the cell it drains to; out of a hollow whose lake does not spill nothing
// goes, out of one that spills never less than nothing.
var<workgroup> wmax: u32;
fn gather_cell(i: u32, nc: u32, wbase: u32, obase: u32) {
  let x = i32(cx(i)); let y = i32(cy(i));
  let hi = gi(f_hol, i);
  for (var c = 0u; c < nc; c++) {
    var acc = s64(F[wbase + c * LEN + i]);${W ? "\n    if (c < P[4]) { acc = add64(acc, ld64(P[3] + 2u * c * LEN, i)); }" : ""}
    for (var d = 0u; d < 8u; d++) {
      let nx = x + DX[d]; let ny = y + DY[d];
      if (nx < 0i || ny < 0i || nx >= SIDEI || ny >= SIDEI) { continue; }
      let k = u32(ny) * SIDE + u32(nx);
      if (gu(f_to, k) != i) { continue; }
      let a = ld64(obase + 2u * c * LEN, k);
      let hk = gi(f_hol, k);
      if (hk < 0i || hk == hi) { acc = add64(acc, a); }
      else if (gi(f_spl, u32(hk)) != 0i && !isneg64(a)) { acc = add64(acc, a); }
    }
    wu(obase + 2u * c * LEN, i, acc.x);
    wu(obase + (2u * c + 1u) * LEN, i, acc.y);
  }
}
@compute @workgroup_size(256)
fn gather(@builtin(local_invocation_index) t: u32) {
  let nc = P[0]; let wbase = P[1]; let obase = P[2];
  if (t == 0u) { wmax = u32(gi(f_misc, MISC_MAXD)); }
  workgroupBarrier();
  let top = workgroupUniformLoad(&wmax);
  for (var k = 0u; k <= top; k++) {
    let d = top - k;
    let lo = gu(f_lvs, d); let hi = gu(f_lvs, d + 1u);
    for (var p = lo + t; p < hi; p += 256u) { gather_cell(gu(f_lvl, p), nc, wbase, obase); }
    storageBarrier(); workgroupBarrier();
  }
}

// the year's flow before any groundwater: the surplus gathered, m3 a second
@compute @workgroup_size(256)
fn flow0(@builtin(global_invocation_id) g: vec3u) {
  let i = g.x;
  let f = ld64(f_ga0l, i);
  let pos = select(f, vec2u(0u), isneg64(f));
  wu(f_flow, i, usat32(mulhi64(pos, C_YEAR)));
}

// ---------- where a channel begins and every cell below one (water.ts channelOf) ----------
fn nonspill(i: u32) -> bool { let h = gi(f_hol, i); return h >= 0i && gi(f_spl, u32(h)) == 0i; }
${W ? `// cells * fall^2 >= (C / CELL) 2^60, which is (area / CELL) fall^2 >= C with the area gathered as cells
fn begins(cells: u32, fall: u32) -> bool {
  let f2 = mul64(fall, fall);
  let p0 = mul64(f2.x, cells); let p1 = mul64(f2.y, cells);
  let w1 = p0.y + p1.x; let w2 = p1.y + select(0u, 1u, w1 < p0.y);
  return w2 != 0u || w1 > HEAD_T1 || (w1 == HEAD_T1 && p0.x >= HEAD_T0);
}` : `// 3 * cells * fall^2 >= 2^60, which is (area / CELL) fall^2 >= HEAD_C with the area gathered as cells
fn begins(cells: u32, fall: u32) -> bool {
  let f2 = mul64(fall, fall); let m = HEAD_NUM * cells;
  let p0 = mul64(f2.x, m); let p1 = mul64(f2.y, m);
  let w1 = p0.y + p1.x; let w2 = p1.y + select(0u, 1u, w1 < p0.y);
  return w2 != 0u || w1 >= (1u << 28u);
}`}
fn channel_cell(i: u32) {
  let valid = gi(f_sea, i) == 0i && !nonspill(i);
  var c = 0i;
  if (valid) {
    if (begins(gu(f_ga0l, i), gu(f_fall, i))) { c = 1i; }
    let x = i32(cx(i)); let y = i32(cy(i));
    for (var d = 0u; d < 8u; d++) {
      let nx = x + DX[d]; let ny = y + DY[d];
      if (nx < 0i || ny < 0i || nx >= SIDEI || ny >= SIDEI) { continue; }
      let k = u32(ny) * SIDE + u32(nx);
      if (gu(f_to, k) == i && gi(f_chn, k) != 0i) { c = 1i; }
    }
  }
  wi(f_chn, i, c);
}
@compute @workgroup_size(256)
fn channels(@builtin(local_invocation_index) t: u32) {
  if (t == 0u) { wmax = u32(gi(f_misc, MISC_MAXD)); }
  workgroupBarrier();
  let top = workgroupUniformLoad(&wmax);
  for (var k = 0u; k <= top; k++) {
    let d = top - k;
    let lo = gu(f_lvs, d); let hi = gu(f_lvs, d + 1u);
    for (var p = lo + t; p < hi; p += 256u) { channel_cell(gu(f_lvl, p)); }
    storageBarrier(); workgroupBarrier();
  }
}

// ---------- a channel's stage: its bed a bankfull depth down and its mean flow's depth over that ----------
// log2 of a 64-bit integer above zero, Q32.32
fn lg64(v: vec2u) -> vec2u {
  if (v.y != 0u) {
    let c = countLeadingZeros(v.y);
    return vec2u(lg2m(select((v.y << c) | (v.x >> (32u - c)), v.y, c == 0u)), 63u - c);
  }
  let c = countLeadingZeros(v.x);
  return vec2u(lg2m(v.x << c), 31u - c);
}
// the bankfull depth in Q12.20 m, from the bankfull flow (Q26 m3 a second) and the slope (units of 2^-35)
fn bank_depth_z(qq26: u32, s35: vec2u) -> i32 {
  let l2q = sub64(lg32(qq26), vec2u(0u, ${fmt.qb - 16}u));
  let l2s = sub64(lg64(s35), vec2u(0u, ${zb + 15}u));
  return exp2q(add64(add64(BD0V, vec2u(0u, ${zb - 16}u)), sub64(smulhi64(l2q, BD1U), smulhi64(l2s, BD2U))));
}
// floor(sqrt(n)) of a 64-bit n
fn sqrt64(n: vec2u) -> u32 {
  var r = 0u;
  for (var bit = 0x80000000u; bit != 0u; bit = bit >> 1u) {
    let c = r | bit;
    if (!lt64(n, mul64(c, c))) { r = c; }
  }
  return r;
}
${W ? `// the square root of a flow in Q16, as Q20
fn sqrt_q28(q: u32) -> u32 { return sqrt64(vec2u(q << 24u, q >> 8u)); }` : `// the square root of a flow in Q26, as Q28
fn sqrt_q28(q: u32) -> u32 { return sqrt64(vec2u(q << 30u, q >> 2u)); }`}
fn bank_flow(i: u32) -> u32 { return mulshr(gu(f_flow, i), BANKFULL_Q16, 16u); }
struct Stage { ok: bool, z: i32 }
fn stage_of(i: u32) -> Stage {
  let zh = gi(f_h, i);
  let q = bank_flow(i);
  if (q == 0u) { return Stage(true, zh); }
  if (gu(f_to, i) == i) { return Stage(false, 0i); }
  let d = bank_depth_z(q, slope35(i));
  return Stage(true, zh - sat32(rsar64(smul64(d, u32(ONE_MINUS_D04)), 16u)));
}

${W ? `// A window's channels are drains (MODFLOW's DRN with a free conductance, R1715): a channel holds the head at its stage only
// where the ground water would stand above it and runs out into the channel (isf 2: the head is capped at fxv, as the ground
// caps any other cell's), and leaves it alone where the table lies below the bed, as a dry or losing channel does.
` : ""}// the fixed heads (the sea, lakes, channels), and for the second solve the transmissivity from the first one's head
@compute @workgroup_size(256)
fn fixedset(@builtin(global_invocation_id) g: vec3u) {
  let i = g.x;
  var isf = 0i; var fxv = 0i;
  let sea = gi(f_sea, i) != 0i;
  if (P[0] == 0u) {
    if (sea) { isf = 1i; fxv = 0i; }
    else if (gi(f_basin, i) != 0i) { isf = ${planet ? "2i" : "1i"}; fxv = gi(f_filled, i); }
    else if (gi(f_chn, i) != 0i) { let s = stage_of(i); if (s.ok) { isf = ${W ? "2i" : "1i"}; fxv = s.z; } }
  } else {
    let dd = gi(f_dd, i);
    let sat = clamp(gi(f_head, i) - (gi(f_h, i) - dd), 0i, dd);
    let p = add64(mul64(gu(f_drK, i), u32(sat)), vec2u(1u << ${zb - 1}u, 0u));
    wu(f_tt, i, gu(f_bedT, i) + ((p.x >> ${zb}u) | (p.y << ${32 - zb}u)));
    if (gi(f_open, i) != 0i) { isf = ${planet ? "select(2i, 1i, sea)" : "1i"}; fxv = select(gi(f_h, i) + gi(f_water, i), 0i, sea); }
    else if (gi(f_chn, i) != 0i) { let s = stage_of(i); if (s.ok) { isf = ${W ? "2i" : "1i"}; fxv = s.z; } }
  }
  wi(f_isf, i, isf); wi(f_fxv, i, fxv);
}

// ---------- the aquifer ----------
// harmonic mean 2 a b / (a + b), rounded
fn harm(a: u32, b: u32) -> u32 {
  let s = a + b;
  if (s == 0u) { return 0u; }
  let p = mul64(a, b);
  let p2 = add64(vec2u(p.x << 1u, (p.y << 1u) | (p.x >> 31u)), vec2u(s >> 1u, 0u));
  return divw(p2.y, p2.x, s).x;
}
// ---------- groundwater evapotranspiration (the law is above the module's constants: SHAH_GRASS and the wet ground's Kc) ----------
// 2^-x for x in Q16, in Q30
fn exp2n(x: u32) -> u32 {
  let k = x >> 16u;
  if (k >= 30u) { return 0u; }
  let fr = x & 0xffffu;
  let idx = fr >> 8u; let lo = fr & 255u;
  let a = EXP2[idx]; let b = EXP2[idx + 1u];
  return (a - (((a - b) * lo) >> 8u)) >> k;
}
// f(d): the share of the potential evaporation the ground lifts to the roots from a water table d below the ground (Z), Q16
fn gw_frac(i: u32, d: i32) -> i32 {
  let dpp = gi(f_evd, i);
  if (d <= dpp) { return 65536i; }
  let p = mul64(u32(d - dpp), u32(gi(f_evb, i))); // Q36
  if (p.y >= (1u << ${zb}u)) { return 0i; }
  let x = (p.x >> ${zb}u) | (p.y << ${32 - zb}u); // b (d - d'') in Q16
  let e = i32(exp2n(mulshr(x, LOG2E_Q16, 16u)) >> 14u);
  return min(65536i, max(0i, qmul(e - gi(f_eve, i), gi(f_evs, i))));
}
// the reeds' niche fit at a water table d below the ground (Z): 1 to REED_FULL, then falling to 0 at REED_NONE, Q16
fn reed_fit(d: i32) -> i32 {
  if (d <= REED_FULL) { return 65536i; }
  if (d >= REED_NONE) { return 0i; }
  return i32(mulshr(u32(REED_NONE - d), u32(REED_SLOPE), ${zb}u));
}
// the wet ground's evaporation beyond the reference, in summer, mm Q16 (evw holds its most: Kc - 1 of summer's potential)
fn wet_extra(i: u32, d: i32) -> i32 { return qmul(reed_fit(d), gi(f_evw, i)); }
// what the ground gives the plants over the year, mm Q16: each season the least of the soil's unmet demand and what the
// water table lifts, and in summer the wet ground's evaporation beyond the reference
fn gw_et(i: u32, d: i32) -> i32 {
  var e = wet_extra(i, d);
  if (gi(f_evu, i) > 0i) {
    let f = gw_frac(i, d);
    for (var s = 0u; s < 4u; s++) { e += min(gs(f_sh0, s, i), qmul(f, gs(f_pe0, s, i))); }
  }
  return e;
}
@compute @workgroup_size(256)
fn aqprep(@builtin(global_invocation_id) g: vec3u) {
  let i = g.x;
  ${W ? "if (gi(f_isf, i) == 1i) { wi(f_head, i, gi(f_fxv, i)); } else if (gi(f_isf, i) == 2i) { wi(f_head, i, min(gi(f_head, i), gi(f_fxv, i))); }" : "if (gi(f_isf, i) != 0i) { wi(f_head, i, gi(f_fxv, i)); }"}
  let x = cx(i);${planet ? "\n  let y = cy(i);" : ""}
  let tt = gu(f_tt, i);
${planet ? `  // a planet's patch holds no head at its edge (the island's ring held at the ground less 3 m would feed water into the ground from outside the patch): the faces of the outer ring carry nothing
  let inner = x >= 1u && x <= SIDE - 2u && y >= 1u && y <= SIDE - 2u;
  wu(f_ce, i, select(0u, harm(tt, gu(f_tt, min(i + 1u, LEN - 1u))), inner && x + 1u <= SIDE - 2u));
  wu(f_cs, i, select(0u, harm(tt, gu(f_tt, min(i + SIDE, LEN - 1u))), inner && y + 1u <= SIDE - 2u));` : `  wu(f_ce, i, select(0u, harm(tt, gu(f_tt, min(i + 1u, LEN - 1u))), x < SIDE - 1u));
  wu(f_cs, i, select(0u, harm(tt, gu(f_tt, min(i + SIDE, LEN - 1u))), i + SIDE < LEN));`}
}
fn weight_of(c: u32, sum: u32) -> u32 { return divw(c >> 1u, c << 31u, sum).x; }
@compute @workgroup_size(256)
fn aqw(@builtin(global_invocation_id) g: vec3u) {
  let i = g.x;
  let x = cx(i); let y = cy(i);
  if (x < 1u || x > SIDE - 2u || y < 1u || y > SIDE - 2u) { return; }
  let cw = gu(f_ce, i - 1u); let ce = gu(f_ce, i); let cn = gu(f_cs, i - SIDE); let cs = gu(f_cs, i);
  let sum0 = cw + ce + cn + cs;
  if (sum0 == 0u) { return; }
  // The sink's steepest fall in head, as the transmissivity that would carry it: b (U + PET e0 / (1 - e0)) times the cell's
  // area, the bound on how fast the evapotranspiration rises with the head. The sweep holds it as a share of the cell's
  // own head (a lagged diagonal), so it converges whatever the fall's steepness [design].
  var kd = 0u;
  var unmet = 0i; var pet = 0i;
  for (var s = 0u; s < 4u; s++) { unmet += gs(f_sh0, s, i); pet += gs(f_pe0, s, i); }
  let ps = gs(f_pe0, SUMMER, i);
  if ((unmet > 0i || ps > 0i) && gi(f_isf, i) ${W ? "!= 1i" : "== 0i"}) {
    let lq = qmul(unmet + qmul(pet, qmul(gi(f_eve, i), gi(f_evs, i))), gi(f_evb, i)) + qmul(qmul(KC_X, ps), REED_SLOPE);
    kd = max(1u, mulshr(u32(lq), KD_K, 16u));
  }
  wi(f_evu, i, unmet);
  wi(f_evw, i, qmul(KC_X, ps));
  let sum = sum0 + kd;
  var w = vec4u(weight_of(cw, sum), weight_of(ce, sum), weight_of(cn, sum), weight_of(cs, sum));
  let wdd = weight_of(kd, sum);
  // the rounding left over goes to the heaviest face, so the weights sum to one exactly
  let rem = 0x80000000u - (w.x + w.y + w.z + w.w + wdd);
  if (cw >= ce && cw >= cn && cw >= cs) { w.x += rem; }
  else if (ce >= cn && ce >= cs) { w.y += rem; }
  else if (cn >= cs) { w.z += rem; }
  else { w.w += rem; }
  wu(f_ww, i, w.x); wu(f_we, i, w.y); wu(f_wn, i, w.z); wu(f_ws, i, w.w); wu(f_wd, i, wdd); wu(f_evk, i, kd);
  let ra = add64(mul64(u32(select(gi(f_rr, i), 0i, gi(f_open, i) != 0i)), RA_K), vec2u(sum >> 1u, 0u)); // R A in Q33 m3 a year, to round
  wi(f_sso, i, i32(divw(ra.y, ra.x, sum).x));
  wu(f_eaf, i, select(0u, divw(RA_K, 0u, sum).x, kd != 0u)); // A / 1000 m a mm, over the transmissivity, 2^32 of it: a sink in mm Q16 to head in Z
}
var<workgroup> wch: atomic<u32>;
// One cell's relaxation step (the one law of the sweep, whatever the order the sweep visits the cells in): its head moves to where its neighbours, its recharge and the plants' draw would
// put it, over-relaxed, and never above the ground (or its channel's stage); the change in the head, 0 for a fixed cell.
fn aq_cell(i: u32) -> u32 { return aq_cell_n(i, i - 1u, i + 1u, i - SIDE, i + SIDE); }
// the same step with the cells west, east, below (y - 1) and above (y + 1) it given: a grid whose neighbours are not at fixed offsets (the whole planet's) passes them
fn aq_cell_n(i: u32, iw: u32, ie: u32, is_: u32, in_: u32) -> u32 {
  if (F[f_isf + i] ${W ? "== 1i" : "!= 0i"}) { return 0u; }
  var acc = mul64(bitcast<u32>(F[f_head + iw] + OFF), gu(f_ww, i));
  acc = add64(acc, mul64(bitcast<u32>(F[f_head + ie] + OFF), gu(f_we, i)));
  acc = add64(acc, mul64(bitcast<u32>(F[f_head + is_] + OFF), gu(f_wn, i)));
  acc = add64(acc, mul64(bitcast<u32>(F[f_head + in_] + OFF), gu(f_ws, i)));
  let kd = gu(f_evk, i);
  if (kd != 0u) { acc = add64(acc, mul64(bitcast<u32>(F[f_head + i] + OFF), gu(f_wd, i))); }
  acc = add64(acc, vec2u(0x40000000u, 0u));
  var want = bitcast<i32>((acc.x >> 31u) | (acc.y << 1u)) - OFF + gi(f_sso, i);
  if (kd != 0u) { want -= i32(mul64(u32(gw_et(i, gi(f_h, i) - F[f_head + i])), gu(f_eaf, i)).y); }
  let hc = F[f_head + i];
  let d = want - hc;
  let v = min(${W ? "select(gi(f_h, i), F[f_fxv + i], F[f_isf + i] == 2i)" : "gi(f_h, i)"}, ${planet ? (fmt.omega ? `hc + d + (${Math.round(100 * (fmt.omega - 1))}i * d + select(-50i, 50i, d >= 0i)) / 100i` : "hc + 2i * d - (d + select(-5i, 5i, d >= 0i)) / 10i") : "hc + d + (3i * d + select(-2i, 2i, d >= 0i)) / 5i"});
  F[f_head + i] = v;
  return u32(abs(v - hc));
}
// The CPU sweeps the cells in row order, each seeing its west and north neighbours already moved. A sweep along the
// anti-diagonals x + y = const moves every cell after the same neighbours and before the same ones, so it gives the
// same heads as the row sweep (the cells of one diagonal do not touch each other); thread t takes the columns x = t, t + 256, ...
@compute @workgroup_size(256)
fn aquifer(@builtin(local_invocation_index) t: u32) {
  let most = P[0];
  var sweeps = 0u;
  for (var it = 0u; it < most; it++) {
    if (t == 0u) { atomicStore(&wch, 0u); }
    storageBarrier(); workgroupBarrier();
    var mine = 0u;
    for (var dg = 2u; dg <= 2u * SIDE - 4u; dg++) {
      for (var x = t; x <= SIDE - 2u; x += 256u) {
      let y = dg - x;
      if (x >= 1u && dg > x && y <= SIDE - 2u) { mine = max(mine, aq_cell(y * SIDE + x)); }
      }
      storageBarrier(); workgroupBarrier();
    }
    atomicMax(&wch, mine);
    storageBarrier(); workgroupBarrier();
    sweeps = it + 1u;
    if (t == 0u) { wuni = select(0u, 1u, atomicLoad(&wch) < SWEEP_TOL); }
    workgroupBarrier();
    if (workgroupUniformLoad(&wuni) == 1u) { break; }
  }
  if (t == 0u) { wi(f_misc, P[1], i32(sweeps)); }
}
${planet ? `// A planet's patch is relaxed in two colours (the cells whose x + y is even, then those whose is odd: a cell's four neighbours are the other colour, so every cell of a colour moves at
// once, across all the workgroups of the grid): P[0] is the colour, P[1] 1 where the change is to be kept in the counters' fourth word.
@compute @workgroup_size(256)
fn aqrb(@builtin(global_invocation_id) g: vec3u) {
  let i = g.x;
  let x = cx(i); let y = cy(i);
  if (x < 1u || x > SIDE - 2u || y < 1u || y > SIDE - 2u || ((x + y) & 1u) != P[0]) { return; }
  let c = aq_cell(i);
  if (P[1] != 0u) { atomicMax(&AT[a_cnt + 3u], c); }
}` : ""}
// what comes out of the ground in each cell, m3 a year Q6
@compute @workgroup_size(256)
fn outflux(@builtin(global_invocation_id) g: vec3u) {
  let i = g.x;
  let x = cx(i); let y = cy(i);
  if (x < 1u || x > SIDE - 2u || y < 1u || y > SIDE - 2u) { return; }
  let hc = gi(f_head, i);
  var s = mul64(u32(select(gi(f_rr, i), 0i, gi(f_open, i) != 0i)), RA_K);
  if (gu(f_evk, i) != 0u) { s = sub64(s, mul64(u32(gw_et(i, gi(f_h, i) - hc)), RA_K)); }
  s = add64(s, smul64(gi(f_head, i - 1u) - hc, gu(f_ce, i - 1u)));
  s = add64(s, smul64(gi(f_head, i + 1u) - hc, gu(f_ce, i)));
  s = add64(s, smul64(gi(f_head, i - SIDE) - hc, gu(f_cs, i - SIDE)));
  s = add64(s, smul64(gi(f_head, i + SIDE) - hc, gu(f_cs, i)));
  wi(f_out, i, sat32(rsar64(s, ${zb + 7}u)));
}

// ---------- the open water's evaporation over a year, mm Q16 summed over the seasons, at a depth (water.ts openKc) ----------
fn lake_mm(depth: i32, i: u32) -> i32 {
  let t = clamp(((depth - 2i * ONE_Z) / 3i) >> ${zb - 16}u, 0i, 65536i);
  var sum = 0i;
  for (var s = 0u; s < 4u; s++) {
    let kc = KCS + qmul(KC_DEEP[s] - KCS, t);
    sum += gs(f_pr0, s, i) - qmul(kc, gs(f_pe0, s, i));
  }
  return sum;
}

// ---------- gw, back, the lakes' net, and the season weights (water.ts route) ----------
@compute @workgroup_size(256)
fn routeprep(@builtin(global_invocation_id) g: vec3u) {
  let i = g.x;
  let sea = gi(f_sea, i) != 0i;
  let open = gi(f_open, i) != 0i;
  let rr = gi(f_rr, i);
  let rs = select(rr, 0i, open);
  var gw = 0i; var bk = 0i; var ln = 0i;
  if (!sea) {
    if (open) { ln = mm_v(lake_mm(gi(f_depth, i), i)); }
    let o = gi(f_out, i);
    if (gi(f_isf, i) ${W ? "== 1i" : "!= 0i"}) { gw = o; }
    else if (!(gi(f_head, i) < ${W ? "select(gi(f_h, i), gi(f_fxv, i), gi(f_isf, i) == 2i)" : "gi(f_h, i)"}) && o > 0i) { bk = min(mm_v(rs), o); gw = o - bk; }
  }
  wi(f_gw, i, gw); wi(f_bk, i, bk); wi(f_ln, i, ln);
  let wet = gi(f_wet, i);
  for (var s = 0u; s < 4u; s++) {
    let su = gs(f_su0, s, i);
    let share = select(0i, qdiv(su, wet), wet > 0i);
    let run = select(mm_v(su - qmul(share, rr)), 0i, open);
    let q = sat32(rsar64(smul64(bk, u32(share)), 16u)) + run;
    F[f_qk0 + s * LEN + i] = q;
    F[f_wt0 + s * LEN + i] = q + ((gw + ln + 2i) >> 2u);
  }
  wi(f_wt4, i, gw);
}
@compute @workgroup_size(256)
fn routefin(@builtin(global_invocation_id) g: vec3u) {
  let i = g.x;
  var sum = 0u;
  for (var s = 0u; s < 4u; s++) {
    let f = ld64(f_ga0l + 2u * s * LEN, i);
    let pos = select(f, vec2u(0u), isneg64(f));
    let sf = min(usat32(mulhi64(pos, C_SEASON)), 0x1fffffffu);
    F[f_sf0 + s * LEN + i] = bitcast<i32>(sf);
    sum += sf;
  }
  let flow = (sum + 2u) >> 2u;
  wu(f_flow, i, flow);
  let fg = ld64(f_ga4l, i);
  var base = 0i;
  if (flow > 0u && !isneg64(fg)) {
    let q = usat32(mulhi64(fg, C_YEAR));
    if (q >= flow) { base = 65536i; } else if (q > 0u) { base = i32(divw(q >> 16u, q << 16u, flow).x); }
  }
  wi(f_base, i, base);
}
// the quick runoff each season, summed over every cell, 64 bits
var<workgroup> wql: array<vec2u, 256>;
@compute @workgroup_size(256)
fn quicksum(@builtin(local_invocation_index) t: u32) {
  for (var s = 0u; s < 4u; s++) {
    var acc = vec2u(0u);
    for (var i = t; i < LEN; i += 256u) { acc = add64(acc, s64(gs(f_qk0, s, i))); }
    wql[t] = acc;
    workgroupBarrier();
    for (var h = 128u; h > 0u; h = h >> 1u) {
      if (t < h) { wql[t] = add64(wql[t], wql[t + h]); }
      workgroupBarrier();
    }
    if (t == 0u) { wu(f_misc, MISC_QUICK + 2u * s, wql[0].x); wu(f_misc, MISC_QUICK + 2u * s + 1u, wql[0].y); }
    workgroupBarrier();
  }
}

// ---------- the lakes ----------
// the inflow into each hollow cell from outside its hollow, m3 a year Q6, 64 bits
@compute @workgroup_size(256)
fn lakeprep(@builtin(global_invocation_id) g: vec3u) {
  let i = g.x;
  let hi = gi(f_hol, i);
  if (hi < 0i) { return; }
  let x = i32(cx(i)); let y = i32(cy(i));
  var acc = vec2u(0u);
  for (var d = 0u; d < 8u; d++) {
    let nx = x + DX[d]; let ny = y + DY[d];
    if (nx < 0i || ny < 0i || nx >= SIDEI || ny >= SIDEI) { continue; }
    let k = u32(ny) * SIDE + u32(nx);
    if (gu(f_to, k) != i || gi(f_hol, k) == hi) { continue; }
    acc = add64(acc, sar64(mul64(gu(f_flow, k), K_YEAR), 16u));
  }
  wu(f_inl, i, acc.x); wu(f_inh, i, acc.y);
}

// Each basin cell is a candidate lake level against every cell of its hollow (water.ts lakes): the hollow's cells by
// height, ties by index; a candidate of rank n counts its n lower cells as lake at its own height and the rest as dry
// ground. The highest candidate (rank 1 or more) whose balance is not negative is the level; the whole hollow full to
// its spill height is tried first, by the hollow's least cell.
@compute @workgroup_size(256)
fn lakecand(@builtin(global_invocation_id) g: vec3u) {
  let B = atomicLoad(&AT[a_cnt]);
  if (g.x >= B) { return; }
  let ci = gu(f_blist, g.x);
  let L = gi(f_hol, ci);
  let hc = gi(f_h, ci);
  var base = vec2u(0u);
  var terms = vec2u(0u);
  var spill = -FX_MAX;
  var rank = 0u;
  for (var k = 0u; k < B; k++) {
    let j = gu(f_blist, k);
    if (gi(f_hol, j) != L) { continue; }
    let hj = gi(f_h, j);
    base = add64(base, add64(ld64(f_inl, j), s64(gi(f_gw, j))));
    spill = max(spill, gi(f_filled, j));
    if (hj < hc || (hj == hc && j < ci)) { rank++; terms = add64(terms, s64(mm_v(lake_mm(hc - hj, j)))); }
    else { terms = add64(terms, s64(mm_v(gi(f_wet, j)))); }
  }
  wu(f_rk, ci, rank);
  if (rank >= 1u && !isneg64(add64(base, terms))) { atomicMax(&AT[a_lbest + u32(L)], rank + 1u); }
  if (u32(L) == ci) {
    var tot = base;
    for (var k = 0u; k < B; k++) {
      let j = gu(f_blist, k);
      if (gi(f_hol, j) != L) { continue; }
      tot = add64(tot, s64(mm_v(lake_mm(spill - gi(f_h, j), j))));
    }
    atomicStore(&AT[a_lsp + ci], select(0u, 1u, !isneg64(tot)));
    wi(f_lv, ci, spill);
  }
}
@compute @workgroup_size(256)
fn lakelevel(@builtin(global_invocation_id) g: vec3u) {
  let B = atomicLoad(&AT[a_cnt]);
  if (g.x >= B) { return; }
  let c = gu(f_blist, g.x);
  let L = u32(gi(f_hol, c));
  let best = atomicLoad(&AT[a_lbest + L]);
  if (atomicLoad(&AT[a_lsp + L]) == 0u && best > 0u && gu(f_rk, c) == best - 1u) { wi(f_lv, L, gi(f_h, c)); }
}
@compute @workgroup_size(256)
fn lakewater(@builtin(global_invocation_id) g: vec3u) {
  let B = atomicLoad(&AT[a_cnt]);
  if (g.x >= B) { return; }
  let c = gu(f_blist, g.x);
  let L = u32(gi(f_hol, c));
  let sp = atomicLoad(&AT[a_lsp + L]);
  let has = sp == 1u || atomicLoad(&AT[a_lbest + L]) > 0u;
  wi(f_water, c, select(0i, max(0i, gi(f_lv, L) - gi(f_h, c)), has));
  if (L == c) {
    wi(f_spl, L, i32(sp));
    if (has) { atomicAdd(&AT[a_cnt + 2u], 1u); }
  }
}
${planet ? `// a planet's lake stands at the flooded surface the planet's flood gave the cell (a hollow's cells stand the flood's own step apart, 1/256 m a cell)
@compute @workgroup_size(256)
fn lakefill(@builtin(global_invocation_id) g: vec3u) {
  let i = g.x;
  let inb = gi(f_basin, i) != 0i && gi(f_sea, i) == 0i;
  wi(f_water, i, select(0i, max(0i, gi(f_filled, i) - gi(f_h, i)), inb));
}
// each season's surplus over the cell as the water's own volume, Q6 m3 a season, the weights of the planet's global discharge (after prep)
@compute @workgroup_size(256)
fn surplusw(@builtin(global_invocation_id) g: vec3u) {
  let i = g.x;
  for (var s = 0u; s < 4u; s++) { F[f_wt0 + s * LEN + i] = mm_v(gs(f_su0, s, i)); }
  // and a lake's net water over the year at the cell's flooded depth (rain on it less its evaporation, Q6 m3 a year): the term of the island's lake balance that the global balance sums
  let depth = gi(f_filled, i) - gi(f_h, i);
  F[f_wt0 + 4u * LEN + i] = select(0i, mm_v(lake_mm(depth, i)), gi(f_sea, i) == 0i && depth > 0i);
}` : ""}
@compute @workgroup_size(256)
fn afterlake(@builtin(global_invocation_id) g: vec3u) {
  let i = g.x;
  if (gi(f_sea, i) != 0i) { wi(f_water, i, -gi(f_h, i)); }
  let w = gi(f_water, i);
  wi(f_open, i, select(0i, 1i, w > 0i));
  wi(f_depth, i, w);
}

// ---------- the table, the springs and the seasons ----------
@compute @workgroup_size(256)
fn tables(@builtin(global_invocation_id) g: vec3u) {
  let i = g.x;
  if (gi(f_open, i) != 0i) { wi(f_chn, i, 0i); return; }
  wi(f_tab, i, max(0i, gi(f_h, i) - gi(f_head, i)));
  let gw = gi(f_gw, i);
  wu(f_spring, i, select(0u, usat32(mulhi64(s64(gw), C_YEAR)), gw > 0i));
}
// The table in the middle of each season and the deepest it falls (water.ts 349 to 366): each season's net water the
// ground holds over the year's mean, over its specific yield. The plants draw each season what the aquifer's sink gives
// them at the year's mean table (gw_et's own terms by season, not the CPU's whole shortfall less the springs'). mm Q16
// throughout until the rise, which is Z.
@compute @workgroup_size(256)
fn seasons(@builtin(global_invocation_id) g: vec3u) {
  let i = g.x;
  if (gi(f_open, i) != 0i) { return; }
  let drift = gu(f_drift, i);
  let sy = select(DRIFT_SY[drift], ROCK_SY[gu(f_rock, i)], drift == ${BARE}u);
  let tab = gi(f_tab, i);
  let floor = max(tab, ROOTS_Z);
  let fr = gw_frac(i, tab);
  let extra = wet_extra(i, tab);
  let wet = gi(f_wet, i); let rr = gi(f_rr, i);
  var net = array<i32, 4>(0i, 0i, 0i, 0i);
  var mean = 0i;
  for (var s = 0u; s < 4u; s++) {
    // rr x surplus / wet in 64 bits: their product in mm2 passes what a Q16 word holds
    let p = add64(mul64(u32(rr), u32(gs(f_su0, s, i))), vec2u(u32(wet) >> 1u, 0u));
    let into = select(rr / 4i, i32(divw(p.y, p.x, max(u32(wet), 1u)).x), wet > 0i);
    let drawn = min(gs(f_sh0, s, i), qmul(fr, gs(f_pe0, s, i))) + select(0i, extra, s == SUMMER);
    net[s] = into - drawn;
    mean += net[s];
  }
  mean = (mean + 2i) >> 2u;
  var held = array<i32, 4>(0i, 0i, 0i, 0i);
  var sum = 0i; var heldMean = 0i;
  for (var s = 0u; s < 4u; s++) {
    let d = net[s] - mean;
    held[s] = sum + (d >> 1u);
    sum += d;
    heldMean += held[s];
  }
  heldMean = (heldMean + 2i) >> 2u;
  var dry = 0i;
  for (var s = 0u; s < 4u; s++) {
    let x = held[s] - heldMean;
    var st = tab;
    if (sy > 0i) { st = clamp(tab - sscale(qdiv(x, sy), RISE_Z), 0i, floor); }
    else if (x > 0i) { st = 0i; }
    else if (x < 0i) { st = floor; }
    F[f_stb0 + s * LEN + i] = st;
    dry = max(dry, st);
  }
  wi(f_dry, i, dry);
}

// ---------- the channels' bankfull flood and its power, the floodplains ----------
@compute @workgroup_size(256)
fn banks(@builtin(global_invocation_id) g: vec3u) {
  let i = g.x;
  if (gi(f_sea, i) != 0i) { return; }
  let q = bank_flow(i);
  wu(f_qbf, i, q);
  let s = gu(f_slope, i);
  if (gi(f_chn, i) != 0i && q > 0u) {
    let p = mul64(sqrt_q28(q), s);
${W ? `    let w = add64(mul64((p.x >> 30u) | (p.y << 2u), u32(POWER_K)), vec2u(1u << 19u, 0u));
    wi(f_pwr, i, bitcast<i32>((w.x >> 20u) | (w.y << 12u)));` : `    let w = add64(mul64((p.x >> 30u) | (p.y << 2u), u32(POWER_K)), vec2u(1u << 27u, 0u));
    wi(f_pwr, i, bitcast<i32>((w.x >> 28u) | (w.y << 4u)));`}
    if (gu(f_to, i) != i) { wi(f_dbf, i, bank_depth_z(q, slope35(i))); }
  }
}
// the cell each cell drains to that is a channel or open water, walking up from the sea
@compute @workgroup_size(256)
fn reach(@builtin(local_invocation_index) t: u32) {
  if (t == 0u) { wmax = u32(gi(f_misc, MISC_MAXD)); }
  workgroupBarrier();
  let top = workgroupUniformLoad(&wmax);
  for (var d = 0u; d <= top; d++) {
    let lo = gu(f_lvs, d); let hi = gu(f_lvs, d + 1u);
    for (var p = lo + t; p < hi; p += 256u) {
      let i = gu(f_lvl, p);
      let j = gu(f_to, i);
      var tg = -1i;
      if (gi(f_chn, i) != 0i || gi(f_open, i) != 0i) { tg = i32(i); }
      else if (j != i) { tg = gi(f_tgt, j); }
      wi(f_tgt, i, tg);
    }
    storageBarrier(); workgroupBarrier();
  }
}
@compute @workgroup_size(256)
fn valley(@builtin(global_invocation_id) g: vec3u) {
  let i = g.x;
  let tg = gi(f_tgt, i);
  if (tg < 0i) { return; }
  let t = u32(tg);
  if (gi(f_chn, t) == 0i || gi(f_open, i) != 0i || gi(f_pwr, t) > CONFINED_Q16) { return; }
  let rise = sat32(rsar64(smul64(gi(f_dbf, t), u32(RISE_Q16)), 16u));
  if (gi(f_h, i) - gi(f_h, t) > rise) { return; }
  wi(f_valley, i, 1i);
  atomicAdd(&AT[a_plc + t], 1u);
}
${planet ? `// a planet's valley: the target of each cell (the nearest channel or open water down the forest: f_tgt, 0 where there is one, -1 where not) and its words (tch its channel flag, tpw its power,
// tdb its bankfull depth, tht its height) are the planet's global files at the cell, as the target may lie anywhere on the planet; the count of valley cells at each channel is a global gather
@compute @workgroup_size(256)
fn valleyg(@builtin(global_invocation_id) g: vec3u) {
  let i = g.x;
  if (gi(f_tgt, i) < 0i) { return; }
  if (gi(f_tch, i) == 0i || gi(f_open, i) != 0i || gi(f_tpw, i) > CONFINED_Q16) { return; }
  let rise = sat32(rsar64(smul64(gi(f_tdb, i), u32(RISE_Q16)), 16u));
  if (gi(f_h, i) - gi(f_tht, i) > rise) { return; }
  wi(f_valley, i, 1i);
}` : ""}
// what a stream's valley fill carries under its bed: T_FILL S W, W the wider of the channel and its floodplain over the reach
@compute @workgroup_size(256)
fn under(@builtin(global_invocation_id) g: vec3u) {
  let i = g.x;
  if (gi(f_chn, i) == 0i || gi(f_sea, i) != 0i) { return; }
  let q = gu(f_qbf, i);
${W ? `  let bq = add64(mul64(sqrt_q28(q), u32(WOOD_W)), vec2u(1u << 25u, 0u));
  let bw = (bq.x >> 26u) | (bq.y << 6u);` : `  let bw = add64(mul64(sqrt_q28(q), u32(WOOD_W)), vec2u(0u, 2u)).y >> 2u;`}
  let j = gu(f_to, i);
  let diag = (cx(j) != cx(i)) && (cy(j) != cy(i));
  let plain = ${planet ? "gu(f_plcf, i)" : "atomicLoad(&AT[a_plc + i])"} * select(${CELL * 1024}u, ${Math.round((CELL / Math.SQRT2) * 1024)}u, diag);
  let w = max(bw, plain);
  let r = mulhi64(mul64(gu(f_slope, i), w), TFILL);
  wu(f_rtl, i, r.x); wu(f_rth, i, r.y);
}
// a spring: groundwater out of the ground at more than a pool of it would evaporate, the most of its neighbours
@compute @workgroup_size(256)
fn springs(@builtin(global_invocation_id) g: vec3u) {
  let i = g.x;
  let sp = gu(f_spring, i);
  if (sp == 0u || gi(f_open, i) != 0i) { return; }
  var short = 0i;
  for (var s = 0u; s < 4u; s++) { short += max(0i, qmul(KCS, gs(f_pe0, s, i)) - gs(f_pr0, s, i)); }
  if (sp < mul64(u32(short), SPRING_K).y) { return; }
  let x = i32(cx(i)); let y = i32(cy(i));
  for (var d = 0u; d < 8u; d++) {
    let nx = x + DX[d]; let ny = y + DY[d];
    if (nx < 0i || ny < 0i || nx >= SIDEI || ny >= SIDEI) { continue; }
    if (gu(f_spring, u32(ny) * SIDE + u32(nx)) > sp) { return; }
  }
  wi(f_spf, i, 1i);
}
`;
};

export const waterWgsl = (fmt: WaterFormat) => (FIXED + constsOf(fmt, layoutOf(fmt).FIELDS) + `
const MISC_MAXD = ${MISC.maxd}u;
const MISC_ROUNDS = ${MISC.rounds}u;
const MISC_QUICK = ${MISC.quick}u;
` + kernelsOf(fmt)).replace(/(@compute @workgroup_size\(256\)\nfn \w+\(.*\) \{)/g, "$1\n  touch();");
export const WATER_WGSL = waterWgsl(ISLAND_WATER);
export const ENTRIES = ["prep", "hollows", "hollowset", "beginsw", "levels", "weights", "gather", "flow0", "channels", "fixedset", "aqprep", "aqw", "aquifer", "aqrb", "outflux", "routeprep", "routefin", "quicksum", "lakeprep", "lakecand", "lakelevel", "lakewater", "lakefill", "surplusw", "afterlake", "tables", "seasons", "banks", "reach", "valley", "valleyg", "under", "springs"] as const;
