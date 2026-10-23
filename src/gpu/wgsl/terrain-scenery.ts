// The island's 3 m ground and everything on it in WGSL: the stream mask, the fine field's heights, wetness, moisture and
// covers, every tree, bush, reed, clay bed, mushroom, herb, fern, flower, tussock and loose stone of ore, and the clasts'
// counts. It is a port of src/terrain/flora.ts fineGround, scatter and clasts as they were (the CPU functions are
// deleted; the constants are the file's own tables and the densities below, each with the note it had). Every number is
// an integer between the buffer read and the buffer write, so every GPU gives the same words; randomness is Philox
// (src/gpu/rand.ts), keyed by (world seed, layer, quad, object).
//
// Formats (the host reads each field back by them):
// - heights, depths, pH, water table, temperature, sun: Q16 metres and so on (i32 x 2^16).
// - shares and fractions (covers, moisture, wetness, fits): Q24; a compensation point, which is at most 2: Q23.
// - the fine field's wetness is always a multiple of 1/16 (the generator's wet cells read between four), held as Q24.
// - positions: a fine-grid coordinate in Q16 (the vertex lattice, 18.75 m a unit), and an object's place in a quad as a
//   16-bit fraction of it; the game's tile coordinate is held as an integer of ten-thousandths of a tile (flora.ts tileAt).
// - sizes in micrometres (u32): a stem's height is a whole number of millimetres first (toMm).
//
// The stream mask: the lines are cut into segments, binned 16 texels square (a list in segment order, so the stack of
// strokes is the same every run); a texel's coverage stacks the strokes as a canvas stacks one stroke over another, cov
// += a (1 - cov), and its bed depth is the deepest stroke over it. Distances are Q16 texels.
//
// The objects are drawn one thread a quad (the 1,020 x 1,020 quads of the fine grid) in two passes over the same draws:
// the first counts each quad's entries by the tile they land in (a position rounded to the game's ten-thousandth of a
// tile can fall in the next tile east and south, so a quad has four destinations), the second writes them where the
// counts' prefix over tiles and, within a tile, over quads in raster order put them: the arrays come out tile by tile,
// each tile's things in the order they were laid down, whatever order the threads run in.
import { N } from "../../terrain/grid";
import { NICHE, SHRUBS, TREES, TREE_MAX } from "../../terrain/niche";
import { GROWTH_RESP, LMF, MAINT, RUE, SLA, UNDER_CROWN, pOf } from "../../terrain/growth";
import { DBH, FERNS, FLOWERS, FUNGI, GX, GY, HEMERY, HERBS, M, PLANTS, QUAD, REINEKE, RM, SHAPE, SHRUB_MOST, SPECIES, STAND, STEP, TILES } from "../../terrain/flora";
import { FIXED } from "./fixed";
import { RAND } from "./rand";

export const BIN = 16; // texels square
export const NS = PLANTS.length;
export const T = TILES * TILES;
export const ORE_CAP = 1 << 16;

// ---------- the field's format ----------
// The kernels run on the island (`ISLAND_SCENERY`: a field of N by N cells whose fine lattice runs from the first cell's centre to the last's, 1,021 vertices a side) or on a tile of the planet's
// 75 m tier (`tileScenery`: the tile's N by N cells in a field with a halo of cells all round it, the lattice running from the tile's own edge to its edge, 1,025 vertices a side, so that
// the quads of the tiles' lattices meet and none is made by two tiles). `shift` is how many quarter cells the lattice's first vertex lies before a cell's centre (0 on the island, 2 on a
// tile: a vertex u lies at cell coordinate (u - shift) / 4). A tile's own place (the world position of its corner in quarter metres, its face, the first of its quads' keys) is read from the
// buffers, so that one text serves every tile.
export interface SceneryFormat { side: number; halo: number; shift: number }
export const TILE_HALO = 2;
export const ISLAND_SCENERY: SceneryFormat = { side: N, halo: 0, shift: 0 };
export const tileScenery = (halo = TILE_HALO): SceneryFormat => ({ side: N + 2 * halo, halo, shift: 2 });

// ---------- the fields as the kernels read them ----------
// i32, LEN each, then the tables the table kernel makes (NS fits, NS compensation points, cell-major), then the
// gradient table of flora.ts noise (GX then GY, 4,096 each, Q24), then the place words (GEO: the corner's x and z in quarter metres, the face).
export const ISLE = [
  "height", "water", // Q16
  "moist", "tree", "shrub", "grass", "marsh", "bare", "sand", // Q24; the covers in flora.ts COVERS order
  "soil", // Q16
  "silt", "clayey", // Q24
  "ph", "winter", // Q16: the pH and the winter water table
  "sun0", "sun1", "sun2", "sun3", "temp0", "temp1", "temp2", "temp3", // Q16
  "sw0", "sw1", "sw2", "sw3", // Q24: how full the root zone is at the end of each season
] as const;
// ---------- the fine field's buffer ----------
// Two byte planes of the stream mask (coverage 0 to 255, and the bed's depth in cm, four texels a word), then the
// vertices' fields, i32, MV each.
export const FINE = ["h", "wet", "moist", "tree", "shrub", "grass", "marsh", "bare", "sand"] as const;

export function layoutOf(fmt: SceneryFormat) {
  const side = fmt.side, LEN = side * side, off = 2 - fmt.shift, m = 4 * N + 1 - 2 * off, Q = m - 1, NQ = Q * Q, MV = m * m, RMW = (RM * RM) / 4;
  const TAB_AT = ISLE.length * LEN, COMP_AT = TAB_AT + NS * LEN, GRAD_AT = COMP_AT + NS * LEN, GEO_AT = GRAD_AT + 2 * 4096, ISLE_WORDS = GEO_AT + 4;
  const IF = Object.fromEntries(ISLE.map((n, k) => [n, k * LEN])) as Record<(typeof ISLE)[number], number>;
  const CUT_AT = RMW, FINE_AT = 2 * RMW, FINE_WORDS = FINE_AT + FINE.length * MV;
  const FF = Object.fromEntries(FINE.map((n, k) => [n, FINE_AT + k * MV])) as Record<(typeof FINE)[number], number>;
  // ---------- the index buffer ----------
  // Per quad: the entries it puts in each of four tiles (itself, east, south, south-east) and where each run begins in its
  // tile; the loose stones of ore a quad lays and their first rank in its row. Then the meta words (the seed, the flag, the ore's total, the first quad's key).
  let at = 0;
  const take = (n: number) => { const a = at; at += n; return a; };
  const IDX = { cnt: take(4 * NQ), base: take(4 * NQ), oreCnt: take(NQ), oreBase: take(NQ), seed: take(1), flag: take(1), oreTotal: take(1), key: take(1), win: take(4), pad: take(8), tileN: take(T), start: take(T + 1), rowT: take(Q), rowC: take(Q), rowStart: take(Q + 1), ore: take(4 * ORE_CAP), words: 0 };
  IDX.words = at;
  return { side, halo: fmt.halo, shift: fmt.shift, off, LEN, m, Q, NQ, MV, RMW, TAB_AT, COMP_AT, GRAD_AT, GEO_AT, ISLE_WORDS, IF, CUT_AT, FINE_AT, FINE_WORDS, FF, IDX };
}
export type SceneryLayout = ReturnType<typeof layoutOf>;
const ISL = layoutOf(ISLAND_SCENERY);
export const { LEN, Q, NQ, MV, RMW, TAB_AT, GRAD_AT, GEO_AT, ISLE_WORDS, CUT_AT, FINE_AT, FINE_WORDS, IDX } = ISL;

// ---------- constants as integers, rounded once here ----------
const Qn = (x: number, bits: number) => {
  const v = Math.round(x * 2 ** bits);
  if (!Number.isFinite(v) || Math.abs(v) > 0x7fffffff) throw new Error(`${x} does not fit Q${bits}`);
  return v;
};
const q16 = (x: number) => `${Qn(x, 16)}i`, q24 = (x: number) => `${Qn(x, 24)}i`;
const ARR = (v: readonly number[], t: "i32" | "u32") => `array<${t}, ${v.length}>(${v.map((x) => `${x}${t === "u32" ? "u" : "i"}`).join(", ")})`;
const DEEP = 0x3fffffff;
const qcurve = (c: readonly number[], bits: number) => c.map((v) => (Number.isFinite(v) ? Qn(v, bits) : DEEP));

// Every plant in the scatter's order (flora.ts PLANTS): its niche's pH and water table curves (Q16; fungi have none
// and fit 1 everywhere, as niche.ts fit leaves an absent axis out) and light curve (Q24, fungi's), the dry matter a gram
// of its leaves makes in a unit of sun (R343's constants through growth.ts madeOf, Q32), 1 / (1 - p) of its water stress
// (Q24), and whether it is a green plant (its light is its carbon) or a fungus (its niche's light).
const NONE = [0, 0, 0, 0];
const PL_PH = PLANTS.flatMap((n) => (NICHE[n].ph ? qcurve(NICHE[n].ph!, 16) : NONE));
const PL_TB = PLANTS.flatMap((n) => (NICHE[n].table ? qcurve(NICHE[n].table!, 16) : NONE));
const PL_CURVED = PLANTS.map((n) => (NICHE[n].ph ? 1 : 0));
const PL_LIGHT = PLANTS.flatMap((n) => (NICHE[n].light ? qcurve(NICHE[n].light!, 24) : NONE));
const PL_GREEN = PLANTS.map((n) => (SLA[n] ? 1 : 0));
const PL_MADE = PLANTS.map((n) => (SLA[n] ? Math.round((1 - GROWTH_RESP) * RUE * LMF * SLA[n] * 2 ** 32) : 0));
const PL_INVP = PLANTS.map((n) => Qn(1 / (1 - pOf(n)), 24));
const PL_SPECIES = PLANTS.map((n) => SPECIES.indexOf(n));
// The woody plants (the trees, then the shrubs, as niche.ts has them), one row each:
// stand height at the best and worst fit (flora.ts STAND, Q16), the exponent and constant that turn an exponential
// draw into a height, the tallest it grows (Q16), the diameter law's constant (Q24) and exponent (Q16), the crown law
// (0 Reineke, 1 Hemery, 2 a ball as wide as tall) with its exponent, its constant and Hemery's two (Q16), and a shrub's
// niche height (Q16).
const WOODY = [...TREES, ...SHRUBS];
const W_LO = WOODY.map((n) => (STAND[n] ? Qn(STAND[n][0], 16) : 0));
const W_DIFF = WOODY.map((n) => (STAND[n] ? Qn(STAND[n][1] - STAND[n][0], 16) : 0));
// treeHeight is heightOfDbh(dbhOf(stand) / QUAD (-ln(1 - r))^(1/SHAPE)), and dbhOf's constant cancels: stand (E^(1/SHAPE) /
// QUAD)^(1/b) with E = -ln(1 - r), so E^(1/(SHAPE b)) QUAD^(-1/b) times the stand's height; the kernel works it in
// base-2 logarithms so only the answer is rounded.
const q32 = (x: number) => {
  const m = BigInt.asUintN(64, BigInt(Math.round(x * 2 ** 32)));
  return `vec2u(${m & 0xffffffffn}u, ${m >> 32n}u)`;
};
const W_EXP = WOODY.map((n) => (DBH[n] ? Qn(1 / (SHAPE * DBH[n][1]), 16) : 0));
const W_LQ = WOODY.map((n) => q32(DBH[n] ? -Math.log2(QUAD) / DBH[n][1] : 0));
const W_MAX = WOODY.map((n) => (TREE_MAX[n] ? Qn(TREE_MAX[n], 16) : 0));
// A crown's law in logarithms of the height in m: Reineke's stand (dbh / 25 cm)^Rb 10^4 / SDImax, dbh = a h^b, is
// 2^(Rb b log2 h + Rb (log2 a - log2 25) + log2 (10^4 / SDImax)); Hemery's width wants dbh in m, which is
// 2^(b log2 h + log2 (a / 100)); a ball's area is pi / 4 h^2. W_CM is the multiplier of log2 h (Q16), W_CC the constant.
const W_CROWN = WOODY.map((n) => (REINEKE[n] ? 0 : HEMERY[n] ? 1 : 2));
const W_CM = WOODY.map((n) => (REINEKE[n] ? Qn(REINEKE[n][1] * DBH[n][1], 16) : HEMERY[n] ? Qn(DBH[n][1], 16) : 0));
const W_CC = WOODY.map((n) => q32(REINEKE[n] ? REINEKE[n][1] * (Math.log2(DBH[n][0]) - Math.log2(25)) + Math.log2(1e4 / REINEKE[n][0]) : HEMERY[n] ? Math.log2(DBH[n][0] / 100) + 8 : 0));
const W_HA = WOODY.map((n) => (HEMERY[n] ? Qn(HEMERY[n][0], 16) : 0));
const W_HB = WOODY.map((n) => (HEMERY[n] ? Qn(HEMERY[n][1], 16) : 0));
const W_TALL = WOODY.map((n) => Qn(NICHE[n].tall ?? 1, 16));
const GX_Q = Array.from(GX, (v) => Qn(v, 24)), GY_Q = Array.from(GY, (v) => Qn(v, 24));
export const GRADIENTS = Int32Array.from([...GX_Q, ...GY_Q]);

const TREE_AT = 0, SHRUB_AT = TREES.length, FUNGI_AT = SHRUB_AT + SHRUBS.length, HERB_AT = FUNGI_AT + FUNGI.length, FERN_AT = HERB_AT + HERBS.length, FLOWER_AT = FERN_AT + FERNS.length;
if (FLOWER_AT + FLOWERS.length !== NS) throw new Error("the plants' layers do not fill the table");
const FLORA_KIND = { tree: 0, bush: 1, mushroom: 7, herb: 8, reeds: 9, fern: 10, flowers: 11, clay: 12, grass: 13 };

// The streams (one draw's key each): the layers' order is the CPU scatter's.
export const STREAMS = { reeds: 0x5c01, clay: 0x5c02, tree: 0x5c03, bush: 0x5c04, fungi: 0x5c05, herb: 0x5c06, fern: 0x5c07, flowers: 0x5c08, grass: 0x5c09, ore: 0x5c0a };

// ---------- the pieces every kernel shares ----------
const help = (L: SceneryLayout) => /* wgsl */ `
${FIXED}
const O16 = 65536i;
const O24 = 16777216i;
const NSIDE = ${L.side}u;
const HALO = ${L.halo}i;
const SHIFT = ${L.shift}i;
const OFF = ${L.off}i;
const NCELLS = ${N}i;
const LEN = ${L.LEN}u;
const MW = ${L.m}u;
const MV = ${L.MV}u;
const RM = ${RM}u;
const RMW = ${L.RMW}u;
const QS = ${L.Q}u;
const NQ = ${L.NQ}u;
// the index of the cell (i, j) of the area's own cells (and the halo's, beyond them) in a field; a cell past the field is the nearest one in it
fn cellIx(i: i32, j: i32) -> u32 { return u32(clamp(j, -HALO, NCELLS - 1i + HALO) + HALO) * NSIDE + u32(clamp(i, -HALO, NCELLS - 1i + HALO) + HALO); }

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
// round(a / d) for a >= 0 and a 64-bit numerator (hi, lo): the quotient of divw, rounded.
fn rdiv64(n: vec2u, d: u32) -> u32 { let s = add64(n, vec2u(d >> 1u, 0u)); return divw(s.y, s.x, d).x; }

`;

const noise = (L: SceneryLayout) => /* wgsl */ `
const GRAD_AT = ${L.GRAD_AT}u;
const GEO_AT = ${L.GEO_AT}u;
// ---------- flora.ts noise ----------
// hash is flora.ts hash: x, y and s mixed by three primes (wrapping), then Murmur's finalizer; its top 12 bits pick one
// of 4,096 gradients. Coordinates are Q20, the gradients and the result Q24.
fn hash3(x: i32, y: i32, s: i32) -> u32 {
  var h = bitcast<u32>(x) * 374761393u + bitcast<u32>(y) * 668265263u + bitcast<u32>(s) * 982451653u;
  h = (h ^ (h >> 13u)) * 1274126177u;
  return h ^ (h >> 16u);
}
fn quintic(f: i32) -> i32 {
  let p = mq(f, 6i * f - 15i * O24) + 10i * O24;
  return mq(mq(mq(f, f), f), p);
}
fn noiseQ(x: i32, y: i32, s: i32) -> i32 {
  let x0 = x >> 20u; let y0 = y >> 20u;
  let fx = (x & 0xfffff) << 4u; let fy = (y & 0xfffff) << 4u;
  let g0 = hash3(x0, y0, s) >> 20u; let g1 = hash3(x0 + 1i, y0, s) >> 20u;
  let g2 = hash3(x0, y0 + 1i, s) >> 20u; let g3 = hash3(x0 + 1i, y0 + 1i, s) >> 20u;
  let a = mq(ISLE[GRAD_AT + g0], fx) + mq(ISLE[GRAD_AT + 4096u + g0], fy);
  let b = mq(ISLE[GRAD_AT + g1], fx - O24) + mq(ISLE[GRAD_AT + 4096u + g1], fy);
  let c = mq(ISLE[GRAD_AT + g2], fx) + mq(ISLE[GRAD_AT + 4096u + g2], fy - O24);
  let d = mq(ISLE[GRAD_AT + g3], fx - O24) + mq(ISLE[GRAD_AT + 4096u + g3], fy - O24);
  let u = quintic(fx); let v = quintic(fy);
  return mq(a + mq(b - a, u) + mq(c - a, v) + mq(mq(a - b - c + d, u), v), ${q24(1.4)});
}
// A coordinate in quarter metres over a divisor (in the same quarters), Q20: round(X 2^20 / d).
fn crd(X: i32, d: u32) -> i32 {
  let m = mag(X);
  let q = rdiv64(vec2u(m << 20u, m >> 12u), d);
  return select(bitcast<i32>(q), -bitcast<i32>(q), X < 0i);
}
// round(a b / 2^24) as qm gives it where it holds, and its low 32 bits where it does not (a tile's coordinates over a face run to 2^21 of Q20 lattice cells: the lattice then wraps, the
// same for every tile that reads the place, which saturating would not do)
fn qmw(a: i32, b: i32) -> i32 {
  let p = add64(mul64(mag(a), mag(b)), vec2u(0x800000u, 0u));
  let r = bitcast<i32>((p.x >> 24u) | (p.y << 8u));
  return select(r, -r, (a < 0i) != (b < 0i));
}
// the field's place: the world position of the area's corner in quarter metres (x, z) and its face, and the lattice vertex's coordinate in quarter metres
fn gx(u: u32) -> i32 { return 75i * (i32(u) + OFF) + ISLE[GEO_AT]; }
fn gz(v: u32) -> i32 { return 75i * (i32(v) + OFF) + ISLE[GEO_AT + 1u]; }
fn faceKey() -> i32 { return ISLE[GEO_AT + 2u] * 1013i; }
// flora.ts fbm over a coordinate pair (quarter metres, divisor d), octaves 2 or 3, Q24.
fn fbmQ(X: i32, Z: i32, d: u32, s: i32, octaves: u32) -> i32 {
  let cx = crd(X, d); let cz = crd(Z, d);
  var total = 0i; var f = O24; var amp = O24 / 2i;
  for (var o = 0u; o < octaves; o++) {
    total += mq(noiseQ(qmw(cx, f), qmw(cz, f), s + faceKey() + i32(o) * 31i), amp);
    f = mq(f, ${q24(2.03)}); amp = amp / 2i;
  }
  return total;
}
`;

// niche.ts curve in Q24 over any one scale: rising from nothing at a to its best at b, 1 to c, falling to nothing at d.
const CURVE = /* wgsl */ `
fn up24(x: i32, lo: i32, hi: i32) -> i32 {
  if (hi <= lo) { return select(0i, O24, x > lo); }
  let t = clamp(qd(x - lo, hi - lo, 24u), 0i, O24);
  return mq(mq(t, t), 3i * O24 - 2i * t);
}
fn curve24(v: i32, a: i32, b: i32, c: i32, d: i32) -> i32 {
  if (v <= b) { return up24(v, a, b); }
  if (v <= c) { return O24; }
  return O24 - up24(v, c, d);
}
`;

const PLANT_TABLES = /* wgsl */ `
const NS = ${NS}u;
const PL_PH = ${ARR(PL_PH, "i32")};
const PL_TB = ${ARR(PL_TB, "i32")};
const PL_CURVED = ${ARR(PL_CURVED, "u32")};
const PL_LIGHT = ${ARR(PL_LIGHT, "i32")};
const PL_GREEN = ${ARR(PL_GREEN, "u32")};
const PL_MADE = ${ARR(PL_MADE, "u32")};
const PL_INVP = ${ARR(PL_INVP, "i32")};
const PL_SPECIES = ${ARR(PL_SPECIES, "u32")};
`;

// ---------- the stream mask ----------
// rect: the words of four texels of a rectangle only (RECT: first word of a row, first row, words across, rows).
export const rasterKernel = (rect = false) => /* wgsl */ `
${help(ISL)}
@group(0) @binding(0) var<storage, read_write> SEG: array<i32>;
@group(0) @binding(1) var<storage, read_write> BIN: array<u32>;
@group(0) @binding(2) var<storage, read_write> OUT: array<u32>;
${rect ? "@group(0) @binding(3) var<storage, read> RECT: array<u32>;" : ""}
const BINS = ${RM / BIN}u;
const SEG_WORDS = 8u;

// A thread is four texels of a row. A segment's words: its two ends and the half width (Q16 pixels), and the bed's depth
// in cm. A stroke's coverage at a texel center is how far inside half + 1/2 the center lies from the segment, and
// strokes stack as cov += a (1 - cov) (flora.ts's canvas stacking), in Q24; the mask is round(255 cov).
@compute @workgroup_size(256)
fn raster(@builtin(global_invocation_id) gid: vec3u) {
${rect ? `  if (gid.x >= RECT[2] * RECT[3]) { return; }
  let y = RECT[1] + gid.x / RECT[2]; let x0 = (RECT[0] + gid.x % RECT[2]) * 4u; let w = y * (RM / 4u) + x0 / 4u;` : `  let w = gid.x;
  if (w >= RMW) { return; }
  let y = w / (RM / 4u); let x0 = (w % (RM / 4u)) * 4u;`}
  let b = (y / ${BIN}u) * BINS + x0 / ${BIN}u;
  var cov = array<i32, 4>(0i, 0i, 0i, 0i);
  var cut = array<u32, 4>(0u, 0u, 0u, 0u);
  let cy = i32(y) * O16 + 32768i;
  for (var e = BIN[b]; e < BIN[b + 1u]; e++) {
    let s = BIN[BINS * BINS + 1u + e] * SEG_WORDS;
    let ax = SEG[s]; let ay = SEG[s + 1u]; let bx = SEG[s + 2u]; let by = SEG[s + 3u]; let half = SEG[s + 4u]; let deep = u32(SEG[s + 5u]);
    let dx = bx - ax; let dy = by - ay;
    let l2 = qadd(qq(dx, dx), qq(dy, dy));
    for (var k = 0u; k < 4u; k++) {
      let cx = i32(x0 + k) * O16 + 32768i;
      let rx = cx - ax; let ry = cy - ay;
      var t = 0i;
      if (l2 > 0i) { t = clamp(qdiv(qadd(qq(rx, dx), qq(ry, dy)), l2), 0i, O16); }
      let px = rx - qq(t, dx); let py = ry - qq(t, dy);
      let dist = qsqrt(qadd(qq(px, px), qq(py, py)));
      let a = clamp(half + 32768i - dist, 0i, O16);
      if (a > 0i) {
        cov[k] = cov[k] + mq(a << 8u, O24 - cov[k]);
        cut[k] = max(cut[k], deep);
      }
    }
  }
  var mask = 0u; var depth = 0u;
  for (var k = 0u; k < 4u; k++) {
    let m = (u32(cov[k]) * 255u + 0x800000u) >> 24u;
    mask = mask | (m << (8u * k));
    depth = depth | (cut[k] << (8u * k));
  }
  OUT[w] = mask;
  OUT[RMW + w] = depth;
}
`;
export const RASTER = rasterKernel();

// ---------- the fine field ----------
// One thread a vertex of the 1,021 x 1,021 lattice (a quarter of a cell apart): the cubic through the generator's cells
// (Catmull-Rom at quarter steps, in two passes with the sums scaled so no step overflows), the ground swell, the stream's
// bed, and the covers wandering at their edges.
// rect: the lattice vertices of a rectangle only (RECT: u0, v0, w, h), each written where the whole lattice's run would have put it (a window slid, its uncovered strips made).
export const fineKernel = (L: SceneryLayout, rect = false) => {
const { IF, FF, CUT_AT } = L;
return /* wgsl */ `
${help(L)}
${noise(L)}
@group(0) @binding(0) var<storage, read_write> ISLE: array<i32>;
@group(0) @binding(1) var<storage, read_write> FINE: array<i32>;
${rect ? "@group(0) @binding(2) var<storage, read> RECT: array<u32>;" : ""}
fn cell(f: u32, i: i32, j: i32) -> i32 { return ISLE[f + cellIx(i, j)]; }
// Catmull-Rom between p1 and p2 at t = j / 4: p1 + t (A / 2 + t (B / 2 + t C / 2)), each step rounded.
fn crm(p0: i32, p1: i32, p2: i32, p3: i32, j: i32) -> i32 {
  let A = p2 - p0; let B = 2i * p0 - 5i * p1 + 4i * p2 - p3; let C = 3i * (p1 - p2) + p3 - p0;
  let s1 = (4i * B + j * C + 4i) >> 3u;
  let s2 = (A >> 1u) + ((j * s1 + 2i) >> 2u);
  return p1 + ((j * s2 + 2i) >> 2u);
}
// A bilinear read of a field at a quarter-step between cells (jx, jy quarters), Q of the field.
fn blin(f: u32, cx: i32, cy: i32, jx: i32, jy: i32) -> i32 {
  let top = (4i - jx) * cell(f, cx, cy) + jx * cell(f, cx + 1i, cy);
  let bot = (4i - jx) * cell(f, cx, cy + 1i) + jx * cell(f, cx + 1i, cy + 1i);
  return ((4i - jy) * top + jy * bot + 8i) >> 4u;
}
fn maskByte(tx: u32, ty: u32, plane: u32) -> u32 { let t = ty * RM + tx; return (bitcast<u32>(FINE[plane + (t >> 2u)]) >> ((t & 3u) * 8u)) & 255u; }

@compute @workgroup_size(256)
fn fine(@builtin(global_invocation_id) gid: vec3u) {
${rect ? `  if (gid.x >= RECT[2] * RECT[3]) { return; }
  let u = RECT[0] + gid.x % RECT[2]; let v = RECT[1] + gid.x / RECT[2];
  let n = v * MW + u;` : `  let n = gid.x;
  if (n >= MV) { return; }
  let u = n % MW; let v = n / MW;`}
  let pu = i32(u) - SHIFT; let pv = i32(v) - SHIFT;
  let cx = pu >> 2u; let cy = pv >> 2u; let jx = pu & 3i; let jy = pv & 3i;
  var rows: array<i32, 4>;
  for (var r = 0i; r < 4i; r++) {
    let j = cy + r - 1i;
    rows[r] = crm(cell(${IF.height}u, cx - 1i, j), cell(${IF.height}u, cx, j), cell(${IF.height}u, cx + 1i, j), cell(${IF.height}u, cx + 2i, j), jx);
  }
  let base = crm(rows[0], rows[1], rows[2], rows[3], jy);
  // the wet cells (water over the ground) read between four: sixteenths
  var wf = 0i;
  {
    let w00 = select(0i, 1i, cell(${IF.water}u, cx, cy) > 0i); let w10 = select(0i, 1i, cell(${IF.water}u, cx + 1i, cy) > 0i);
    let w01 = select(0i, 1i, cell(${IF.water}u, cx, cy + 1i) > 0i); let w11 = select(0i, 1i, cell(${IF.water}u, cx + 1i, cy + 1i) > 0i);
    wf = (4i - jy) * ((4i - jx) * w00 + jx * w10) + jy * ((4i - jx) * w01 + jx * w11);
  }
  // the mask's texel at a vertex is the one 4 (u + OFF) across (the vertex's meters over the texel's 4.6875, exact)
  let tx = min(4u * (u + u32(OFF)), RM - 1u); let ty = min(4u * (v + u32(OFF)), RM - 1u);
  let rv = maskByte(tx, ty, 0u); let bed = maskByte(tx, ty, ${CUT_AT}u);
  // x = START + u STEP in quarter metres is 75 u - 38250
  let X = gx(u); let Z = gz(v);
  let swell = mq(${q24(2.6)}, fbmQ(X, Z, 960u, 7i, 3u)) + mq(${q24(0.8)}, fbmQ(X, Z, 240u, 8i, 2u));
  // smooth(-2, 6, base)
  let st = clamp(base + 2i * O16, 0i, 8i * O16) << 5u;
  let sm = mq(mq(st, st), 3i * O24 - 2i * st);
  let bump = (mq(mq(sm, O24 - (wf << 20u)), swell) + 128i) >> 8u;
  let carve = i32((rv * bed * 65536u + 12750u) / 25500u);
  FINE[${FF.h}u + n] = base + bump - carve;
  FINE[${FF.wet}u + n] = wf << 20u;
  FINE[${FF.moist}u + n] = (blin(${IF.moist}u, cx, cy, jx, jy));
  var share: array<i32, 6>;
  var sum = 0i;
  for (var c = 0u; c < 6u; c++) {
    let b = blin(${IF.tree}u + c * LEN, cx, cy, jx, jy);
    share[c] = max(0i, mq(b, O24 + mq(${q24(0.85)}, fbmQ(X, Z, 600u, 40i + i32(c), 2u))));
    sum += share[c];
  }
  for (var c = 0u; c < 6u; c++) {
    FINE[${FF.tree}u + c * MV + n] = select(share[c], qd(share[c], sum, 24u), sum > 0i);
  }
}
`;
};
export const FINE_KERNEL = fineKernel(ISL);

// ---------- the per-cell tables ----------
// For every cell and plant: its fit (niche.ts fit: the lowest of the pH and water table curves; a fungus has neither
// axis and fits 1, as an absent axis is left out) and, for a green plant, its compensation point over the year at the
// cell (growth.ts yearComp, at most 2: the year's dry matter it burns against what it makes of the seasons' sun, warmth
// and soil water, scaled by its fit). Cells at or below -2 m hold zeros, as the CPU scatter skipped them.
export const tableKernel = (L: SceneryLayout) => {
const { IF, TAB_AT, COMP_AT } = L;
return /* wgsl */ `
${help(L)}
${CURVE}
${PLANT_TABLES}
@group(0) @binding(0) var<storage, read_write> ISLE: array<i32>;
@compute @workgroup_size(64)
fn table(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= LEN) { return; }
  if (ISLE[${IF.height}u + i] < -2i * O16) {
    for (var k = 0u; k < NS; k++) { ISLE[${TAB_AT}u + i * NS + k] = 0i; ISLE[${COMP_AT}u + i * NS + k] = 0i; }
    return;
  }
  let ph = ISLE[${IF.ph}u + i]; let tb = ISLE[${IF.winter}u + i];
  // the seasons' sun times warmth (MJ/m2 a day, Q24; warmEnough = clamp((T + 2) / 7, 0, 1)) and the year's maintenance
  // (keptOf: 0.015 2^((T - 20) / 10), the power of two from the fraction's table)
  var sw: array<i32, 4>;
  var kept = 0i;
  for (var s = 0u; s < 4u; s++) {
    let temp = ISLE[${IF.temp0}u + s * LEN + i];
    sw[s] = mq(ISLE[${IF.sun0}u + s * LEN + i] << 8u, qd(clamp(temp + 2i * O16, 0i, 7i * O16), 7i * O16, 24u));
    let ex = smulhi64(wide(temp - 20i * O16), ${Math.round(0.1 * 2 ** 32)}u);
    let sh = 7i - bitcast<i32>(ex.y);
    var m2 = e2f(ex.x);
    if (sh >= 32i) { m2 = 0u; } else if (sh > 0i) { m2 = m2 >> u32(sh); } else { m2 = m2 << u32(-sh); }
    kept += mq(i32(m2), ${q24(MAINT)});
  }
  for (var k = 0u; k < NS; k++) {
    var fit = O24;
    if (PL_CURVED[k] != 0u) {
      fit = min(curve24(ph, PL_PH[4u * k], PL_PH[4u * k + 1u], PL_PH[4u * k + 2u], PL_PH[4u * k + 3u]), curve24(tb, PL_TB[4u * k], PL_TB[4u * k + 1u], PL_TB[4u * k + 2u], PL_TB[4u * k + 3u]));
    }
    var comp = 0i;
    if (PL_GREEN[k] != 0u) {
      var sum = 0i;
      for (var s = 0u; s < 4u; s++) {
        // watered = clamp(water / (1 - p), 0, 1)
        let wet = clamp(mq(ISLE[${IF.sw0}u + s * LEN + i], PL_INVP[k]), 0i, O24);
        sum += mq(sw[s], wet);
      }
      let made = i32(mul64(u32(sum), PL_MADE[k]).y);
      comp = 2i * O24;
      if (made > 0i && fit > 0i) { comp = min(qd(qd(kept, made, 24u), fit, 24u), 2i * O24); }
    }
    ISLE[${TAB_AT}u + i * NS + k] = fit;
    ISLE[${COMP_AT}u + i * NS + k] = comp >> 1u;
  }
}
`;
};
export const TABLE = tableKernel(ISL);

// ---------- the objects ----------
// Per quad (u, v) of the 1,020 x 1,020: flora.ts's scatter, layer by layer, with every draw a pure function of
// (seed, layer, quad, k). Densities, each as it stood in the CPU scatter [design] unless a note says otherwise:
// - reeds: marsh 1.1 + edge (0.5 - 0.4 sand) a quad, edge being any standing water or stream in the quad's corner texel;
//   clay: the larger of the silt and of 1.5 times the clay share's ramp from 0.2 to 0.5, times 0.08 + 0.5 edge.
// - mushrooms: tree m 0.25 + grass 0.03, m the moisture; herbs: (grass m 0.25 + shrub 0.06) 3.5 patch; ferns: (0.5 tree
//   + 0.15 shrub + 0.3 woods' edge) m (0.5 + patch); flowers: (grass (0.3 + 0.2 m) (1 - tree) + 0.15 marsh + 0.1 woods'
//   edge) 3.5 patch; tussocks: (20 grass (1 - tree) + 3.75 woods' edge) patch. Each low layer lays floor(base (0.2 + the
//   best fit among its plants) + u) of them. patch is 0.35 + 1.3 noise at a 45 m scale, from 0 to 1.7.
// - bog iron: floor(0.04 marsh + u) a quad, where the ground is nearly dry (R533; how much there is to find is a gap).
// - stems: as many as their crowns fill the share of the quad their form covers, each one's kind drawn by its fit there,
//   its height drawn, and the ground its crown holds (crownShare) added up until it reaches the room, the last stem laid
//   with the chance of the room it has left. Trees close their share of the quad as a stand at its maximum density, and
//   never more than the quad holds closed but for a lone tree, as the GPU's stems crowd (src/gpu/wgsl/stems.ts); bushes
//   stand as a Boolean cover of their crowns, whose covered share is 1 - e^(-the crowns' area over the ground's), so
//   their crowns fill -ln(1 - shrub) of it [derived]. A stem whose spot turns out wet, or for a tree bare of soil to
//   root in (ground.ts soil), stands nowhere.
// - what each plant is offered: conifers take the poor, sour ground; oak and aspen the middling; ash the rich, base-rich
//   ground; each where the water table lets it (niche.ts fit, growth.ts yearComp and thrive, in the light that reaches
//   its layer: trees stand in the open sky, what grows under them gets the open share of the quad and, in the rest, what
//   one crown lets through (growth.ts through)). Shrubs thicken at the woods' edge, heather on the sourest ground;
//   fallen wood, ferns and mushrooms fill the shade; flowers and herbs the open grass; reeds and clay the wet margins.
//   Boulders, stones, pebbles, sticks and fallen logs are pieces on the GPU, not laid here (src/gpu/deadwood.ts).
// The two passes run this function and differ only in what put does with an entry that stands.
const PI4 = Math.PI / 4;
// A guard against a loop that cannot end (a stem's crown is never under a Q16 unit, so a quad's room of at most 1,700 m2
// is filled well inside it); no quad comes near it.
const MOST_STEMS = 1 << 22;
const scatterCode = (write: boolean, L: SceneryLayout) => {
const { IF, FF, IDX, TAB_AT, COMP_AT } = L;
return /* wgsl */ `
const TT = ${T}u;
const TSIDE = ${TILES}u;
const FMAX = ${Math.floor((L.m - 1.001) * 65536)}i;
const I_CNT = ${IDX.cnt}u; const I_BASE = ${IDX.base}u; const I_ORECNT = ${IDX.oreCnt}u; const I_OREBASE = ${IDX.oreBase}u;
const I_SEED = ${IDX.seed}u; const I_FLAG = ${IDX.flag}u; const I_ORETOTAL = ${IDX.oreTotal}u; const I_KEY = ${IDX.key}u; const I_WIN = ${IDX.win}u;
const I_TILEN = ${IDX.tileN}u; const I_START = ${IDX.start}u; const I_ROWT = ${IDX.rowT}u; const I_ROWC = ${IDX.rowC}u; const I_ROWS = ${IDX.rowStart}u; const I_ORE = ${IDX.ore}u;
const W_LO = ${ARR(W_LO, "i32")};
const W_DIFF = ${ARR(W_DIFF, "i32")};
const W_EXP = ${ARR(W_EXP, "i32")};
const W_LQ = array<vec2u, ${WOODY.length}>(${W_LQ.join(", ")});
const W_MAX = ${ARR(W_MAX, "i32")};
const W_CROWN = ${ARR(W_CROWN, "u32")};
const W_CM = ${ARR(W_CM, "i32")};
const W_CC = array<vec2u, ${WOODY.length}>(${W_CC.join(", ")});
const W_HA = ${ARR(W_HA, "i32")};
const W_HB = ${ARR(W_HB, "i32")};
const W_TALL = ${ARR(W_TALL, "i32")};
const LOW_STREAM = ${ARR([STREAMS.fungi, STREAMS.herb, STREAMS.fern, STREAMS.flowers], "u32")};
const LOW_FIRST = ${ARR([FUNGI_AT, HERB_AT, FERN_AT, FLOWER_AT], "u32")};
const LOW_COUNT = ${ARR([FUNGI.length, HERBS.length, FERNS.length, FLOWERS.length], "u32")};

var<private> Qu: u32;
var<private> Qv: u32;
var<private> Qq: u32;
var<private> Qseed: u32;
var<private> Qclear: bool;
var<private> Qloc: array<u32, 4>;
var<private> Qdst: array<u32, 4>;
var<private> Qore: u32;
var<private> QoreAt: u32;
var<private> FT: array<i32, ${NS}>;
var<private> CP: array<i32, ${NS}>;
var<private> WT: array<i32, 5>;

fn isleAt(f: u32, i: i32, j: i32) -> i32 { return ISLE[f + cellIx(i, j)]; }
fn blinQ(f: u32, cx: i32, cy: i32, jx: i32, jy: i32) -> i32 {
  let top = (4i - jx) * isleAt(f, cx, cy) + jx * isleAt(f, cx + 1i, cy);
  let bot = (4i - jx) * isleAt(f, cx, cy + 1i) + jx * isleAt(f, cx + 1i, cy + 1i);
  return ((4i - jy) * top + jy * bot + 8i) >> 4u;
}
fn maskAt(tx: i32, ty: i32) -> u32 {
  let t = u32(clamp(ty, 0i, ${RM - 1}i)) * RM + u32(clamp(tx, 0i, ${RM - 1}i));
  return (bitcast<u32>(FINE[t >> 2u]) >> ((t & 3u) * 8u)) & 255u;
}
// a field of the fine lattice read between its vertices (flora.ts fine), at a fine-grid coordinate in Q16
fn lerpFine(off: u32, FU: i32, FV: i32) -> i32 {
  let fu = clamp(FU, 0i, FMAX); let fv = clamp(FV, 0i, FMAX);
  let i = off + u32(fv >> 16u) * MW + u32(fu >> 16u);
  let tu = fu & 0xffff; let tv = fv & 0xffff;
  let a = FINE[i]; let b = FINE[i + 1u]; let c = FINE[i + MW]; let d = FINE[i + MW + 1u];
  let top = a + qq(b - a, tu); let bot = c + qq(d - c, tu);
  return top + qq(bot - top, tv);
}
const H_AT = ${FF.h}u; const WET_AT = ${FF.wet}u;
fn heightFine(FU: i32, FV: i32) -> i32 { return lerpFine(H_AT, FU, FV); }
// the highest water over the ground in the 3 x 3 cells round the one nearest a fine-grid coordinate: flora.ts waterAt's
// lvl, and whether any cell there holds water
fn levelAt(ci: i32, cj: i32) -> vec2i {
  var lvl = -FX_MAX; var any = 0i;
  for (var b = max(-HALO, cj - 1i); b <= min(NCELLS - 1i + HALO, cj + 1i); b++) {
    for (var a = max(-HALO, ci - 1i); a <= min(NCELLS - 1i + HALO, ci + 1i); a++) {
      let k = cellIx(a, b);
      let w = ISLE[${IF.water}u + k];
      if (w > 0i) { any = 1i; lvl = max(lvl, ISLE[${IF.height}u + k] + w); }
    }
  }
  return vec2i(lvl, any);
}
fn bl4(a: i32, b: i32, c: i32, d: i32, tx: i32, ty: i32) -> i32 {
  return qq((a * (O16 - tx) + b * tx), O16 - ty) + qq((c * (O16 - tx) + d * tx), ty);
}
// whether standing water covers the point more than half (flora.ts waterAt > 0.5): the highest level over the ground
// above the fine ground there and the cells' water share over a fifth, or the sea's share of the cells over three
// fifths; outside the island, always
fn waterOver(FU: i32, FV: i32) -> bool {
  let ci = (FU + OFF * 65536i) >> 18u; let cj = (FV + OFF * 65536i) >> 18u;
  if (ci < -HALO || cj < -HALO || ci >= NCELLS + HALO || cj >= NCELLS + HALO) { return true; }
  let lv = levelAt(ci, cj);
  if (lv.y == 0i) { return false; }
  let x0 = clamp((FU - SHIFT * 65536i) >> 18u, -HALO, NCELLS - 2i + HALO); let y0 = clamp((FV - SHIFT * 65536i) >> 18u, -HALO, NCELLS - 2i + HALO);
  let tx = clamp(((FU - SHIFT * 65536i) >> 2u) - (x0 << 16u), 0i, O16); let ty = clamp(((FV - SHIFT * 65536i) >> 2u) - (y0 << 16u), 0i, O16);
  let k = cellIx(x0, y0);
  var w = array<i32, 4>(ISLE[${IF.water}u + k], ISLE[${IF.water}u + k + 1u], ISLE[${IF.water}u + k + NSIDE], ISLE[${IF.water}u + k + NSIDE + 1u]);
  var s = array<i32, 4>(ISLE[${IF.height}u + k], ISLE[${IF.height}u + k + 1u], ISLE[${IF.height}u + k + NSIDE], ISLE[${IF.height}u + k + NSIDE + 1u]);
  var wi = array<i32, 4>(0i, 0i, 0i, 0i); var si = array<i32, 4>(0i, 0i, 0i, 0i);
  for (var m = 0u; m < 4u; m++) { wi[m] = select(0i, 1i, w[m] > 0i); si[m] = select(0i, 1i, w[m] > 0i && s[m] < 0i); }
  let wet = bl4(wi[0], wi[1], wi[2], wi[3], tx, ty); let sea = bl4(si[0], si[1], si[2], si[3], tx, ty);
  return (lv.x > heightFine(FU, FV) && wet > 13107i) || sea > 39321i;
}
// whether the stream mask read between its texels is over half there (flora.ts riverSmooth > 0.5)
fn streamOver(FU: i32, FV: i32) -> bool {
  let ux = 4i * FU + ${4 * L.off * 65536 - 32768}i; let uz = 4i * FV + ${4 * L.off * 65536 - 32768}i;
  let i = ux >> 16u; let j = uz >> 16u; let a = ux & 0xffff; let b = uz & 0xffff;
  let m00 = i32(maskAt(i, j)); let m10 = i32(maskAt(i + 1i, j)); let m01 = i32(maskAt(i, j + 1i)); let m11 = i32(maskAt(i + 1i, j + 1i));
  let v = qq(m00 * (O16 - a) + m10 * a, O16 - b) + qq(m01 * (O16 - a) + m11 * a, b);
  return v > 8355840i;
}
fn blocked(FU: i32, FV: i32) -> bool { return waterOver(FU, FV) || streamOver(FU, FV); }
// flora.ts dry: outside the bank line (the mask's nearest texel at half or more) and above the year's high water on the
// nearest lake or the sea, 0.8 m over its level [gap: the Baltic's yearly high at Rønne was not read]
fn dryAt(FU: i32, FV: i32) -> bool {
  if (Qclear) { return true; }
  if (maskAt((${4 * L.off * 65536}i + 4i * FU) >> 16u, (${4 * L.off * 65536}i + 4i * FV) >> 16u) >= 128u) { return false; }
  let lv = levelAt((FU + OFF * 65536i) >> 18u, (FV + OFF * 65536i) >> 18u);
  if (lv.y == 0i) { return true; }
  return heightFine(FU, FV) > lv.x + ${Qn(0.8, 16)}i;
}
// bilinear(isle.soil, cell of the point) > 0: some neighbour with soil under a positive weight
fn soilAt(FU: i32, FV: i32) -> bool {
  let cx = (FU - SHIFT * 65536i) >> 18u; let cy = (FV - SHIFT * 65536i) >> 18u; let tx = ((FU - SHIFT * 65536i) >> 2u) & 0xffff; let ty = ((FV - SHIFT * 65536i) >> 2u) & 0xffff;
  let s00 = isleAt(${IF.soil}u, cx, cy) > 0i; let s10 = isleAt(${IF.soil}u, cx + 1i, cy) > 0i;
  let s01 = isleAt(${IF.soil}u, cx, cy + 1i) > 0i; let s11 = isleAt(${IF.soil}u, cx + 1i, cy + 1i) > 0i;
  return (s00 && tx < O16 && ty < O16) || (s10 && tx > 0i && ty < O16) || (s01 && tx < O16 && ty > 0i) || (s11 && tx > 0i && ty > 0i);
}
// flora.ts clearAt: no standing water in the cells round the quad (a ring beyond its edges) and no stream in the mask's
// texels a metre past its edges, so every point of the quad passes waterAt and riverSmooth
fn clearQuad() -> bool {
  let u = i32(Qu); let v = i32(Qv);
  let a0 = (75i * (u - SHIFT) + 1346i) / 300i - 4i; let a1 = (75i * (u - SHIFT) + 1429i) / 300i - 4i;
  let b0 = (75i * (v - SHIFT) + 1346i) / 300i - 4i; let b1 = (75i * (v - SHIFT) + 1429i) / 300i - 4i;
  if (a1 + 1i > NCELLS - 1i + HALO || b1 + 1i > NCELLS - 1i + HALO) { return false; }
  for (var b = max(-HALO, b0 - 1i); b <= min(NCELLS - 1i + HALO, b1 + 1i); b++) {
    for (var a = max(-HALO, a0 - 1i); a <= min(NCELLS - 1i + HALO, a1 + 1i); a++) { if (ISLE[${IF.water}u + cellIx(a, b)] > 0i) { return false; } }
  }
  for (var b = 4i * (v + OFF) - 1i; b <= min(${RM - 1}i, 4i * (v + OFF) + 4i); b++) {
    for (var a = 4i * (u + OFF) - 1i; a <= min(${RM - 1}i, 4i * (u + OFF) + 4i); a++) { if (maskAt(a, b) != 0u) { return false; } }
  }
  return true;
}

// ---------- where an entry goes ----------
fn emit(kind: u32, sp: u32, tx4: u32, ty4: u32, size: u32, sd: u32) {
  let tx = min(tx4 / 10000u, TSIDE - 1u); let ty = min(ty4 / 10000u, TSIDE - 1u);
  let d = select(0u, 1u, tx > ((Qu + u32(OFF)) >> 3u)) + select(0u, 2u, ty > ((Qv + u32(OFF)) >> 3u));
  ${write ? `let at = Qdst[d] + Qloc[d];
  if (inWindow(tx4, ty4)) { PX[at] = tx4; PY[at] = ty4; SZ[at] = size; SD[at] = sd; KS[at] = kind | (sp << 8u); }` : `_ = size; _ = sd; _ = kind; _ = sp;`}
  Qloc[d] = Qloc[d] + 1u;
}
// whether an entry's place (ten-thousandths of a game tile of 2 cells) lies in the window of cells the write pass makes (IDX I_WIN: x0, y0, x1, y1, the end exclusive; the whole area when none is asked for)
fn inWindow(tx4: u32, ty4: u32) -> bool {
  let cx = (tx4 * 2u) / 10000u; let cy = (ty4 * 2u) / 10000u;
  return cx >= IDX[I_WIN] && cx < IDX[I_WIN + 2u] && cy >= IDX[I_WIN + 1u] && cy < IDX[I_WIN + 3u];
}
// the game's tile coordinate of a point in ten-thousandths of a tile: round(X / 150 m 10^4), X from the island's corner
fn tileOf(X: u32) -> u32 { return rdiv64(mul64(X, 625u), 614400u); }
// a place in the quad by 16-bit fractions of it, as the island's meters in Q16 from its corner
fn cornerX(u: u32, fr: u32) -> u32 { return ${1228800 * L.off}u + 1228800u * u + ((fr * 75u) >> 2u); }
// A thing stands where the game puts it, to a ten-thousandth of a tile, and it is checked there too: the fine-grid
// coordinate of that place is (T * 150 / 10^4 m - 37.5) / 18.75 = T / 1250 - 2.
fn backAt(t4: u32) -> i32 { return i32(rdiv64(mul64(t4, 32768u), 625u)) - ${65536 * L.off}i; }
// kind ORE is a loose stone of ore, listed apart from the rest
const ORE = 255u;
fn put(kind: u32, sp: u32, fx: u32, fz: u32, size: u32, sd: u32) {
  let tx4 = tileOf(cornerX(Qu, fx)); let ty4 = tileOf(cornerX(Qv, fz));
  if (!Qclear) {
    for (var check = 0u; check < 2u; check++) {
      var FU = i32(Qu << 16u) + i32(fx); var FV = i32(Qv << 16u) + i32(fz);
      if (check == 1u) { FU = backAt(tx4); FV = backAt(ty4); }
      if (blocked(FU, FV)) { return; }
    }
  }
  if (kind == ORE) {
    ${write ? `let at = I_ORE + 4u * (QoreAt + Qore);
    if (inWindow(tx4, ty4)) { IDX[at] = tx4; IDX[at + 1u] = ty4; IDX[at + 2u] = size; IDX[at + 3u] = sd; }` : `_ = size; _ = sd;`}
    Qore = Qore + 1u;
    return;
  }
  emit(kind, sp, tx4, ty4, size, sd);
}

// ---------- the laws ----------
fn mmOf(h: i32) -> u32 { return max(1u, (u32(h) * 1000u + 32768u) >> 16u); }
// log2 of a Q32.32 number above zero, as a signed Q32.32 (the mantissa's from lg2m)
fn lg64(E: vec2u) -> vec2u {
  let c = select(32u + countLeadingZeros(E.x), countLeadingZeros(E.y), E.y != 0u);
  var top = E.x << (c - 32u);
  if (c < 32u) { top = (E.y << c) | (E.x >> (32u - c)); }
  return vec2u(lg2m(top), bitcast<u32>(31i - i32(c)));
}
// y L as a signed Q32.32 for L a signed Q32.32 and y a Q16.16
fn mulE(L: vec2u, y: i32) -> vec2u {
  let p = mulshr16(abs64(L), mag(y));
  return select(p, neg64(p), isneg64(L) != (y < 0i));
}
// log2 of a height in mm, in m: log2(mm / 1000)
const LOG2_1000 = ${q32(Math.log2(1000))};
fn lgMm(mm: u32) -> vec2u { return sub64(lg32(mm << 16u), LOG2_1000); }
// A tree's height in mm: the stand's at the site by its fit, the stem's diameter the Weibull's quantile of the word w
// (flora.ts treeHeight), no taller than its kind grows.
fn treeMm(p: u32, f: i32, w: u32) -> u32 {
  let stand = W_LO[p] + qm(W_DIFF[p], clamp(f, 0i, O24), 24u);
  let E = nlnu(~w);
  if (E.x == 0u && E.y == 0u) { return 1u; }
  let t = add64(add64(mulE(lg64(E), W_EXP[p]), lg32(u32(stand))), W_LQ[p]);
  return mmOf(min(exp2q(t), W_MAX[p]));
}
// A bush's height in mm (flora.ts bushHeight [design: the old spread]).
fn bushMm(p: u32, f: i32, w: u32) -> u32 {
  let g = clamp(${q24(0.4)} + mq(${q24(0.8)}, f), ${q24(0.4)}, ${q24(1.2)});
  let wv = ${q24(0.6)} + i32(mulhi(w, ${Qn(0.8, 24)}u));
  return mmOf(qm(qm(qm(W_TALL[p], g, 24u), wv, 24u), ${q24(1 / (1.2 * 1.4))}, 24u));
}
// The ground a stem's crown holds, m2 in Q16 (flora.ts crownShare), of a height in mm.
fn crownOf(p: u32, mm: u32) -> i32 {
  var a = 0i;
  if (W_CROWN[p] == 2u) {
    let sq = mul64(mm, mm);
    a = i32(rdiv64(mul64(sq.x, ${Math.round(PI4 * 65536)}u), 1000000u));
  } else {
    let t = add64(mulE(lgMm(mm), W_CM[p]), W_CC[p]);
    if (W_CROWN[p] == 0u) { a = exp2q(t); }
    else { let k = W_HA[p] + qm(W_HB[p], exp2q(t), 24u); a = qm(qq(k, k), ${q24(PI4)}, 24u); }
  }
  return max(a, 1i);
}

// ---------- what the quad's ground offers each plant ----------
// the cells' tables read at the quad's center, a bilinear in sixty-fourths
fn fitsAt() {
  let sx = 2i * i32(Qu) + 1i - 2i * SHIFT; let sy = 2i * i32(Qv) + 1i - 2i * SHIFT;
  let x1 = sx >> 3u; let y1 = sy >> 3u; let tx = sx & 7i; let ty = sy & 7i;
  let i = (u32(y1 + HALO) * NSIDE + u32(x1 + HALO)) * NS;
  for (var p = 0u; p < NS; p++) {
    let a = ISLE[${TAB_AT}u + i + p]; let b = ISLE[${TAB_AT}u + i + NS + p]; let c = ISLE[${TAB_AT}u + i + NSIDE * NS + p]; let d = ISLE[${TAB_AT}u + i + NSIDE * NS + NS + p];
    FT[p] = ((a * (8i - tx) + b * tx) * (8i - ty) + (c * (8i - tx) + d * tx) * ty + 32i) >> 6u;
    let e = ISLE[${COMP_AT}u + i + p]; let f = ISLE[${COMP_AT}u + i + NS + p]; let g = ISLE[${COMP_AT}u + i + NSIDE * NS + p]; let h = ISLE[${COMP_AT}u + i + NSIDE * NS + NS + p];
    CP[p] = (((e * (8i - tx) + f * tx) * (8i - ty) + (g * (8i - tx) + h * tx) * ty + 32i) >> 6u) << 1u;
  }
}
// growth.ts thrive: how well a plant does in a share of the open sky's sun against all of it
fn thrive(light: i32, comp: i32) -> i32 { if (comp >= O24) { return 0i; } return clamp(qd(light - comp, O24 - comp, 24u), 0i, O24); }
// the weights of one layer's plants (PLANTS[first] on, n of them) in the light they get: a green plant's fit by how far
// that light clears its compensation point, a fungus's by its niche's light curve
fn layerW(first: u32, n: u32, light: i32) {
  for (var k = 0u; k < n; k++) {
    let p = first + k;
    if (PL_GREEN[p] != 0u) { WT[k] = mq(FT[p], thrive(light, CP[p])); }
    else { WT[k] = mq(FT[p], curve24(light, PL_LIGHT[4u * p], PL_LIGHT[4u * p + 1u], PL_LIGHT[4u * p + 2u], PL_LIGHT[4u * p + 3u])); }
  }
}
// niche.ts draw: one of n names by weight, from a word
fn drawW(n: u32, r: u32) -> u32 {
  var sum = 0i;
  for (var k = 0u; k < n; k++) { sum += WT[k]; }
  if (sum <= 0i) { return 0u; }
  let x = i32(mulhi(r, u32(sum)));
  var cum = 0i;
  for (var k = 0u; k < n; k++) { cum += WT[k]; if (cum >= x) { return k; } }
  return n - 1u;
}
fn anyW(n: u32) -> bool { for (var k = 0u; k < n; k++) { if (WT[k] > 0i) { return true; } } return false; }
fn bestW(n: u32) -> i32 { var b = 0i; for (var k = 0u; k < n; k++) { b = max(b, WT[k]); } return b; }
// floor(x + u) for x in Q24 and a word u
fn stoch(x: i32, r: u32) -> u32 { return u32((max(x, 0i) + i32(r >> 8u)) >> 24u); }

// Stems, as many as their crowns fill the room (flora.ts lay): each one's kind drawn by its weight, its height drawn,
// and the ground its crown holds added up until it reaches the room, the last laid with the chance of the room left.
fn lay(stream: u32, tree: bool, first: u32, n: u32, room: i32, most: i32) {
  if (room <= 0i || !anyW(n)) { return; }
  var used = 0i;
  for (var k = 1u; k < ${MOST_STEMS}u; k++) {
    rinit(Qseed, stream, Qq, k);
    let ws = next32(); let sp = drawW(n, ws); let wh = next32();
    let p = first + sp;
    var mm = 0u;
    if (tree) { mm = treeMm(p, WT[sp], wh); } else { mm = bushMm(p, WT[sp], wh); }
    let a = crownOf(p, mm);
    let last = used + a > room;
    if (last) {
      let w3 = next32();
      if (i32(mulhi(w3, u32(a))) >= room - used || (used > 0i && used + a > most)) { return; }
    }
    used += a;
    let pos = next32(); let sd = next32();
    let fx = pos & 0xffffu; let fz = pos >> 16u;
    let FU = i32(Qu << 16u) + i32(fx); let FV = i32(Qv << 16u) + i32(fz);
    if (dryAt(FU, FV) && (!tree || soilAt(FU, FV))) { put(select(${FLORA_KIND.bush}u, ${FLORA_KIND.tree}u, tree), PL_SPECIES[p], fx, fz, mm * 1000u, sd); }
    if (last) { return; }
  }
}

// The low plants: as many as the best fitted of their kind would hold (flora.ts low), each of a kind drawn by its fit.
fn low(stream: u32, first: u32, n: u32, base: i32, light: i32) {
  layerW(first, n, light);
  let best = bestW(n);
  if (best <= 0i) { return; }
  rinit(Qseed, stream, Qq, 0u);
  let c = stoch(mq(base, ${q24(0.2)} + best), next32());
  for (var k = 1u; k <= c; k++) {
    rinit(Qseed, stream, Qq, k);
    let pos = next32(); let ws = next32(); let wz = next32(); let sd = next32();
    let fx = pos & 0xffffu; let fz = pos >> 16u;
    if (!dryAt(i32(Qu << 16u) + i32(fx), i32(Qv << 16u) + i32(fz))) { continue; }
    let sp = drawW(n, ws); let p = first + sp;
    var kind = 0u; var size = 0u;
    if (stream == ${STREAMS.fungi}u) { kind = ${FLORA_KIND.mushroom}u; size = 50000u + mulhi(wz, 150000u); }
    else if (stream == ${STREAMS.herb}u) { kind = ${FLORA_KIND.herb}u; size = 150000u + mulhi(wz, 400000u); }
    else if (stream == ${STREAMS.fern}u) {
      kind = ${FLORA_KIND.fern}u;
      let um = 400000u + mulhi(wz, 900000u);
      let g = u32(clamp(${q24(0.5)} + WT[sp], ${q24(0.5)}, ${q24(1.2)}));
      let pr = mul64(um, g);
      size = (pr.x >> 24u) | (pr.y << 8u);
    } else { kind = ${FLORA_KIND.flowers}u; size = 200000u + mulhi(wz, 600000u); }
    put(kind, PL_SPECIES[p], fx, fz, size, sd);
  }
}

// ---------- one quad ----------
fn scatterQuad(q: u32) {
  Qq = IDX[I_KEY] + q; Qu = q % QS; Qv = q / QS;
  Qseed = IDX[I_SEED];
  Qloc = array<u32, 4>(0u, 0u, 0u, 0u); Qore = 0u;
  let u = Qu; let v = Qv; let i = v * MW + u;
  let tx0 = (u + u32(OFF)) >> 3u; let ty0 = (v + u32(OFF)) >> 3u;
  ${write ? `for (var d = 0u; d < 4u; d++) {
    let t = min(ty0 + (d >> 1u), TSIDE - 1u) * TSIDE + min(tx0 + (d & 1u), TSIDE - 1u);
    Qdst[d] = IDX[I_START + t] + IDX[I_BASE + q * 4u + d];
  }
  QoreAt = IDX[I_ROWS + v] + IDX[I_OREBASE + q];` : ``}
  let h = FINE[H_AT + i]; let wk = FINE[WET_AT + i] >> 20u;
  // a quad of the sea, or of deep water, holds nothing
  if (h <= -32768i || wk > 12i) { return; }
  Qclear = clearQuad();
  let m = FINE[${FF.moist}u + i]; let tree = FINE[${FF.tree}u + i]; let shrub = FINE[${FF.shrub}u + i]; let grass = FINE[${FF.grass}u + i];
  let marsh = FINE[${FF.marsh}u + i]; let sand = FINE[${FF.sand}u + i];
  let edge = select(0i, 1i, wk >= 1i || maskAt(4i * (i32(u) + OFF), 4i * (i32(v) + OFF)) > 51u);
  // the wet margins first: reeds stand in the shallows and on marsh, clay lies in the silt beside still or running water
  {
    var x = mq(marsh, ${q24(1.1)});
    if (edge == 1i) { x += ${q24(0.5)} - mq(sand, ${q24(0.4)}); }
    rinit(Qseed, ${STREAMS.reeds}u, Qq, 0u);
    let c = stoch(x, next32());
    for (var k = 1u; k <= c; k++) {
      rinit(Qseed, ${STREAMS.reeds}u, Qq, k);
      let pos = next32(); let wz = next32(); let sd = next32();
      let fx = pos & 0xffffu; let fz = pos >> 16u;
      let FU = i32(u << 16u) + i32(fx); let FV = i32(v << 16u) + i32(fz);
      if (lerpFine(WET_AT, FU, FV) < ${q24(0.6)} && heightFine(FU, FV) > ${Qn(0.2, 16)}i) { put(${FLORA_KIND.reeds}u, 0u, fx, fz, 1000000u + mulhi(wz, 1500000u), sd); }
    }
    // clay where the ground is clayey: river and lake silt, and the soil of mudstone and basalt
    let pu = i32(u) - SHIFT; let pv = i32(v) - SHIFT;
    let cx = pu >> 2u; let cy = pv >> 2u; let jx = pu & 3i; let jy = pv & 3i;
    let silt = blinQ(${IF.silt}u, cx, cy, jx, jy); let clayey = blinQ(${IF.clayey}u, cx, cy, jx, jy);
    let ramp = clamp(qd(clayey - ${q24(0.2)}, ${q24(0.3)}, 24u), 0i, O24);
    let y = mq(max(silt, mq(${q24(1.5)}, ramp)), ${q24(0.08)} + edge * ${q24(0.5)});
    rinit(Qseed, ${STREAMS.clay}u, Qq, 0u);
    let cc = stoch(y, next32());
    for (var k = 1u; k <= cc; k++) {
      rinit(Qseed, ${STREAMS.clay}u, Qq, k);
      let pos = next32(); let wz = next32(); let sd = next32();
      let fx = pos & 0xffffu; let fz = pos >> 16u;
      let FU = i32(u << 16u) + i32(fx); let FV = i32(v << 16u) + i32(fz);
      if (lerpFine(WET_AT, FU, FV) < ${q24(0.4)} && heightFine(FU, FV) > ${Qn(0.4, 16)}i) { put(${FLORA_KIND.clay}u, 0u, fx, fz, 600000u + mulhi(wz, 1400000u), sd); }
    }
  }
  if (wk > 4i || h < ${Qn(0.8, 16)}i) { return; }
  fitsAt();
  let under = O24 - tree + mq(tree, ${q24(UNDER_CROWN)});
  let open = O24 - min(shrub, ${q24(SHRUB_MOST)});
  // trees in the open sky, then bushes under the trees
  for (var form = 0u; form < 2u; form++) {
    let isTree = form == 0u;
    layerW(select(${SHRUB_AT}u, ${TREE_AT}u, isTree), select(${SHRUBS.length}u, ${TREES.length}u, isTree), select(under, O24, isTree));
    let room = select(qm(-qln((open + 128i) >> 8u), ${Qn(STEP * STEP, 16)}i, 16u), qm(tree, ${Qn(STEP * STEP, 16)}i, 24u), isTree);
    lay(select(${STREAMS.bush}u, ${STREAMS.tree}u, isTree), isTree, select(${SHRUB_AT}u, ${TREE_AT}u, isTree), select(${SHRUBS.length}u, ${TREES.length}u, isTree), room, select(0x7fffffffi, ${Qn(STEP * STEP, 16)}i, isTree));
  }
  let edge2 = 4i * mq(tree, O24 - tree);
  // Small plants come in patches some tens of meters across rather than evenly: 0 in the gaps, up to about 1.7.
  let clump = clamp(${q24(0.35)} + mq(${q24(1.3)}, noiseQ(crd(gx(u), 180u), crd(gz(v), 180u), 91i + faceKey())), 0i, ${q24(1.7)});
  for (var layer = 0u; layer < 4u; layer++) {
    var base = 0i;
    if (layer == 0u) { base = mq(tree, mq(m, ${q24(0.25)})) + mq(grass, ${q24(0.03)}); }
    else if (layer == 1u) { base = mq(mq(mq(mq(grass, m), ${q24(0.25)}) + mq(shrub, ${q24(0.06)}), ${q24(3.5)}), clump); }
    else if (layer == 2u) { base = mq(mq(mq(tree, ${q24(0.5)}) + mq(shrub, ${q24(0.15)}) + mq(edge2, ${q24(0.3)}), m), ${q24(0.5)} + clump); }
    else { base = mq(mq(mq(mq(grass, ${q24(0.3)} + mq(m, ${q24(0.2)})), O24 - tree) + mq(marsh, ${q24(0.15)}) + mq(edge2, ${q24(0.1)}), ${q24(3.5)}), clump); }
    low(LOW_STREAM[layer], LOW_FIRST[layer], LOW_COUNT[layer], base, under);
  }
  // Tussocks of tall grass, sized by width, stand across open meadow and along the woods' edge, thick in some patches and thin in others.
  {
    rinit(Qseed, ${STREAMS.grass}u, Qq, 0u);
    let c = stoch(mq(mq(mq(grass, O24 - tree), ${q24(20)}) + mq(edge2, ${q24(3.75)}), clump), next32());
    for (var k = 1u; k <= c; k++) {
      rinit(Qseed, ${STREAMS.grass}u, Qq, k);
      let pos = next32(); let wz = next32(); let sd = next32();
      let fx = pos & 0xffffu; let fz = pos >> 16u;
      if (dryAt(i32(u << 16u) + i32(fx), i32(v << 16u) + i32(fz))) { put(${FLORA_KIND.grass}u, 0u, fx, fz, 800000u + mulhi(wz, 1700000u), sd); }
    }
  }
  // Bog iron forms in bogs and wet meadows from the iron the groundwater brings up out of the till, a spade's depth down
  // (R533); how much of it there is to find is a gap (the old 0.04 a cell stands in).
  {
    rinit(Qseed, ${STREAMS.ore}u, Qq, 0u);
    let c = stoch(mq(marsh, ${q24(0.04)}), next32());
    for (var k = 1u; k <= c; k++) {
      rinit(Qseed, ${STREAMS.ore}u, Qq, k);
      let pos = next32(); let wz = next32(); let sd = next32();
      let fx = pos & 0xffffu; let fz = pos >> 16u;
      if (lerpFine(WET_AT, i32(u << 16u) + i32(fx), i32(v << 16u) + i32(fz)) < ${q24(0.3)}) { put(ORE, 0u, fx, fz, 150000u + mulhi(wz, 200000u), sd); }
    }
  }
}
`;
};

const common = (write: boolean, L: SceneryLayout) => /* wgsl */ `
${help(L)}
${noise(L)}
${CURVE}
${PLANT_TABLES}
${RAND}
@group(0) @binding(0) var<storage, read_write> ISLE: array<i32>;
@group(0) @binding(1) var<storage, read_write> FINE: array<i32>;
@group(0) @binding(2) var<storage, read_write> IDX: array<u32>;
${write ? `@group(0) @binding(3) var<storage, read_write> PX: array<u32>;
@group(0) @binding(4) var<storage, read_write> PY: array<u32>;
@group(0) @binding(5) var<storage, read_write> SZ: array<u32>;
@group(0) @binding(6) var<storage, read_write> SD: array<u32>;
@group(0) @binding(7) var<storage, read_write> KS: array<u32>;` : ``}
${scatterCode(write, L)}
`;

// The first pass, and the passes between: count each quad's entries by destination tile; rank every tile's runs (the
// quads in raster order, a quad east or south of a tile's own that spills into it first); the ore's ranks by row; the
// prefix sums. Entry points: count, rank, rows, scan (all on IDX but count, which reads the island and the fine field),
// and probe, which evaluates the laws on inputs the host gives (the test's).
export const countKernel = (L: SceneryLayout) => {
return /* wgsl */ `
${common(false, L)}
@compute @workgroup_size(64)
fn count(@builtin(global_invocation_id) gid: vec3u) {
  let q = gid.x;
  if (q >= NQ) { return; }
  scatterQuad(q);
  for (var d = 0u; d < 4u; d++) { IDX[I_CNT + q * 4u + d] = Qloc[d]; }
  IDX[I_ORECNT + q] = Qore;
}
@compute @workgroup_size(64)
fn rank(@builtin(global_invocation_id) gid: vec3u) {
  let t = gid.x;
  if (t >= TT) { return; }
  let tx = i32(t % TSIDE); let ty = i32(t / TSIDE);
  var run = 0u;
  for (var vq = 8i * ty - OFF - 1i; vq <= 8i * ty - OFF + 7i; vq++) {
    for (var uq = 8i * tx - OFF - 1i; uq <= 8i * tx - OFF + 7i; uq++) {
      if (uq < 0i || uq >= ${L.Q}i || vq < 0i || vq >= ${L.Q}i) { continue; }
      let d = select(0u, 1u, uq == 8i * tx - OFF - 1i) + select(0u, 2u, vq == 8i * ty - OFF - 1i);
      let q = u32(vq) * QS + u32(uq);
      IDX[I_BASE + q * 4u + d] = run;
      run += IDX[I_CNT + q * 4u + d];
    }
  }
  IDX[I_TILEN + t] = run;
}
@compute @workgroup_size(64)
fn rows(@builtin(global_invocation_id) gid: vec3u) {
  let v = gid.x;
  if (v >= QS) { return; }
  var run = 0u; var all = 0u;
  for (var u = 0u; u < QS; u++) {
    let q = v * QS + u;
    IDX[I_OREBASE + q] = run;
    run += IDX[I_ORECNT + q];
    all += IDX[I_CNT + q * 4u] + IDX[I_CNT + q * 4u + 1u] + IDX[I_CNT + q * 4u + 2u] + IDX[I_CNT + q * 4u + 3u];
  }
  IDX[I_ROWT + v] = run;
  IDX[I_ROWC + v] = all;
}
@compute @workgroup_size(1)
fn scan() {
  IDX[I_START] = 0u;
  for (var t = 0u; t < TT; t++) { IDX[I_START + t + 1u] = IDX[I_START + t] + IDX[I_TILEN + t]; }
  IDX[I_ROWS] = 0u;
  for (var v = 0u; v < QS; v++) { IDX[I_ROWS + v + 1u] = IDX[I_ROWS + v] + IDX[I_ROWT + v]; }
  IDX[I_ORETOTAL] = IDX[I_ROWS + QS];
  // every entry the quads counted has a place in a tile's run (a destination the ranks did not enumerate would not)
  var all = 0u;
  for (var v = 0u; v < QS; v++) { all += IDX[I_ROWC + v]; }
  if (all != IDX[I_START + TT]) { IDX[I_FLAG] = 1u; }
}
// The laws on inputs: eight words each from I_BASE on: the operation, three arguments, and the answer.
@compute @workgroup_size(64)
fn probe(@builtin(global_invocation_id) gid: vec3u) {
  let at = I_BASE + gid.x * 8u;
  let op = IDX[at];
  var out = 0u;
  if (op == 0u) { out = treeMm(IDX[at + 1u], bitcast<i32>(IDX[at + 2u]), IDX[at + 3u]); }
  else if (op == 1u) { out = u32(crownOf(IDX[at + 1u], IDX[at + 2u])); }
  else if (op == 2u) { out = bushMm(IDX[at + 1u], bitcast<i32>(IDX[at + 2u]), IDX[at + 3u]); }
  else if (op == 3u) { out = bitcast<u32>(noiseQ(bitcast<i32>(IDX[at + 2u]), bitcast<i32>(IDX[at + 3u]), bitcast<i32>(IDX[at + 1u]))); }
  else if (op == 4u) { out = bitcast<u32>(fbmQ(bitcast<i32>(IDX[at + 2u]), bitcast<i32>(IDX[at + 3u]), 960u, bitcast<i32>(IDX[at + 1u]), 3u)); }
  IDX[at + 4u] = out;
}
`;
};
export const COUNT = countKernel(ISL);

// The second pass: the same draws, each entry written where the ranks put it. A quad whose draws came out other than
// its count (they cannot) raises the flag.
export const writeKernel = (L: SceneryLayout) => {
return /* wgsl */ `
${common(true, L)}
@compute @workgroup_size(64)
fn write(@builtin(global_invocation_id) gid: vec3u) {
  let q = gid.x;
  if (q >= NQ) { return; }
  // a quad more than a cell outside the window makes nothing that lies in it (its objects lie within its own cell, 4 quads across)
  let cu = i32((q % QS + u32(OFF)) >> 2u); let cv = i32((q / QS + u32(OFF)) >> 2u);
  if (cu + 1i < i32(IDX[I_WIN]) || cu - 1i >= i32(IDX[I_WIN + 2u]) || cv + 1i < i32(IDX[I_WIN + 1u]) || cv - 1i >= i32(IDX[I_WIN + 3u])) { return; }
  scatterQuad(q);
  for (var d = 0u; d < 4u; d++) { if (Qloc[d] != IDX[I_CNT + q * 4u + d]) { IDX[I_FLAG] = 1u; } }
  if (Qore != IDX[I_ORECNT + q]) { IDX[I_FLAG] = 1u; }
}
`;
};
export const WRITE = writeKernel(ISL);

// ---------- the clasts' counts ----------
// How many boulders, stones and pebbles lie in each cell (flora.ts clasts as it was): per class a Poisson count whose
// mean the host works out per drift kind (the cell's count of boulders at its drift's count a ha, times the share of
// till's N(> d) ~ d^-2.9 the class holds). A mean is a number of whole CHUNKs and a rest in Q16.16; the sum of
// independent Poissons is Poisson, so the count is the sum of a draw for each chunk and one for the rest, each by
// rand.ts qpoisson (counting exponential gaps below 16, Hormann's PTRS above), keyed (seed, class, cell). Nothing lies
// on the sea or a lake's bed.
export const CHUNK = 8192;
export const CLAST_STREAM = 0xc1a5;
export const clastKernel = (classes: number, drifts: number) => /* wgsl */ `
${help(ISL)}
${RAND}
@group(0) @binding(0) var<storage, read_write> INP: array<i32>;
@group(0) @binding(1) var<storage, read_write> OUT: array<u32>;
const NC = ${classes}u;
const ND = ${drifts}u;
const CHUNK_Q = ${CHUNK * 65536}i;
@compute @workgroup_size(64)
fn clasts(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= LEN) { return; }
  for (var c = 0u; c < NC; c++) { OUT[c * LEN + i] = 0u; }
  if (INP[i] > 0i || INP[LEN + i] < 0i) { return; }
  let drift = u32(INP[2u * LEN + i]);
  let seed = bitcast<u32>(INP[3u * LEN + 2u * NC * ND]);
  for (var c = 0u; c < NC; c++) {
    let at = 3u * LEN + 2u * (c * ND + drift);
    var total = 0u;
    rinit(seed, ${CLAST_STREAM}u + c, i, 0u);
    for (var k = 0i; k < INP[at]; k++) { total += qpoisson(CHUNK_Q); }
    total += qpoisson(INP[at + 1u]);
    OUT[c * LEN + i] = total;
  }
}
`;
