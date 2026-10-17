// The smallest things' laws in WGSL: grass tillers and reed shoots, fine litter, invertebrates and soil fauna, moved
// sand, each a lumped kind on tiers/lumped.ts (src/gpu/smalls.ts drives them; constants and the laws' TypeScript twins
// are src/sim/smalls.ts; research note docs/research/generator/2026-10-16-lumped.md). All integer: Q16 hazards and
// shares, Q32 chances, 64-bit sums by atomics whose carries make the totals the same in any order.
//
// The inputs every law reads (inp): tables up to BASE (litter's transient chances, its fall schedule, the fauna's
// stage table), then CW words a 75 m cell (X): its static words, written once by the CPU; the day's drivers, copied
// from the day buffer the CPU writes; and what the inputs kernel works out each day on the GPU from yesterday's census
// and what the animals ate.
//
// A day, at midnight (src/gpu/smalls.ts): eaten (tiles, when the animals are bound): what the animals ate of each pool
// since the last day, shared over each tile's cells by what each held; inputs (cells): the day's words, the targets
// (eaten plus what is still owed, the credit) and the chances they set, and the births the day brings (reed shoots
// coming up, the year's leaves on the crowns); then each kind's step with its own split census (what the bites, the
// grazing of dead blades and the predators took, the dead lamina and reed the litter gets); litter births (cells);
// the census (bins, every kind); settle (cells): each credit is the target less what the bins lost; then (tiles) the
// animals' pools set from the census less the credits.
import { CELL, N } from "../../terrain/grid";
import { CELL_MM } from "./index";
import { TW, T as TILES, W_ } from "./animals";
import { FIXED } from "./fixed";
import { RAND } from "./rand";
import { CTL } from "./alloc";

// ---------- layouts shared with the host and the twins ----------
export const CELLS = N * N;
export const CELL_M2 = CELL * CELL;
// A cell's input words: static (CPU, once), the day's (CPU through the day buffer), and the GPU's.
export const X = {
  open: 0, field: 1, lc: 2, marsh: 3, rich: 4, flight: 5,
  temp: 6, grow: 7, sen: 8, water: 9, reach: 10,
  lai0: 11, lai1: 12, rt0: 13, rt1: 14, bite0: 15, bite1: 16, dead: 17, eat: 18, ga: 21, reedk: 22, arr: 23,
  ustar: 24, wet: 25, swash: 26, nk: 27, k: 43,
} as const;
// The taxa's cited densities, K (members of the cell), are static words too, X.k to X.k + 15 (CPU, once).
export const CW = 59;
export const STATIC_WORDS = 6;
// The day buffer: DAYW words a cell (temp, grow, sen, water, reach).
export const DAYW = 5;
// The tables: litter's transient chances, LT_N entries of LT_STRIDE words (n, then n - 1 boundaries, then n states),
// by (class, half year, soil, mass class); the fall schedule of the leaves still on their plants, a Q32 chance a day
// by (class, island day); the fauna's table, FT_STRIDE words by (taxon, stage).
export const LT = 0, LT_STRIDE = 32, LT_N = 16 * 2 * 2 * 8;
export const FALL = LT + LT_N * LT_STRIDE, FALL_CLASSES = 5;
export const FT = FALL + FALL_CLASSES * 40, FT_STRIDE = 16, FT_N = 16 * 8;
export const BASE = FT + FT_N * FT_STRIDE;
export const F_ = { death: 0, next: 1, adv: 2, from: 3, to: 4, bear: 5, bfrom: 6, bto: 7, batch: 8, prey: 9, mode: 10, mass: 11, terminal: 12, reg: 13, dry: 14, warm: 15 } as const;
// The census, CENW words a cell, cleared each day: green lamina by layer (1/8 mg, 64-bit) and tillers; reed shoots
// live and standing dead; lying litter by class (ug, 64-bit); members by taxon (the stages the taxon's density counts);
// prey a predator class can take (mg, 64-bit, weighted by how much of it is to be had) and the bin it would single out
// (its share in the top half, its state in the bottom); what the split took and left: lamina bitten off by layer and
// lamina dead (1/8 mg), blades grazed (ug), prey eaten by class (mg), reed shoots gone dead and culms broken.
export const CEN = {
  lam: 0, n: 4, reedLive: 6, reedDead: 7, lit: 8, tax: 28, prey: 44, top: 50,
  bitten: 53, deadLam: 57, grazed: 59, eaten: 61, senesced: 67, broke: 68,
} as const;
export const CENW = 72;
// What each cell owes and aims at (STW words, kept from day to day): the credits (i32: green by layer in 1/8 mg, dead
// blades in mg, prey by predator class in mg), the day's targets (eaten plus credit, the same units) and the carry of
// dead lamina not yet a whole blade (1/8 mg).
export const ST = { credit: 0, target: 6, carry: 12 } as const;
export const STW = 16;
// What the animals ate since the last day, a cell (EW words): green by layer (1/8 mg), dead (mg), prey by class (mg).
export const EW = 8;
// The pools the link last wrote a tile (fg, fd, icrow, igull, ifox).
export const WROTE = 5;
// Births from the GPU: a cell's slots of (key, count). The tillers' one (reed shoots); the litter's: blades, reed
// leaves, reed stems, then the crowns' leaves of pine, oak, ash and aspen.
export const TB = 1, LB = 7;
// Predator classes (EATEN codes): crows, gulls, foxes, grazers (of dead blades).
export const PRED = { crow: 0, gull: 1, fox: 2, grazer: 3 } as const;

// ---------- encodings ----------
// Tillers: lamina class 3 bits, stage 3, species 4, layer 1. Class k holds 0.25 mg x 2^k of lamina above the grazing
// height for k 1 to 7 and none for class 0 (a tiller grazed to its sheaths, or a daughter whose first leaf has only
// its tip out of the sheath).
export const TS = { veg: 1, vern: 2, elong: 3, flower: 4, live: 1, dead0: 5, dead1: 6, dead2: 7 } as const;
export const SPC = { grass: 0, reed: 9 } as const;
export const tillerState = (k: number, st: number, spc: number, lay: number) => k | (st << 3) | (spc << 6) | (lay << 10);
// Litter: mass class 3 bits, class 4, lag 1.
export const LC = { pine: 0, oak: 1, ash: 2, aspen: 3, standing: 4, lying: 5, reedLeaf: 6, reedStem: 7, onPine: 10, onOak: 11, onAsh: 12, onAspen: 13, onReed: 14 } as const;
export const ATTACHED = 10;
export const litterState = (j: number, c: number, lag: number) => j | (c << 3) | (lag << 7);
// Fauna: class 3 bits, stage 3, taxon 4.
export const faunaState = (cls: number, stg: number, tax: number) => cls | (stg << 3) | (tax << 6);
// Sand: size class 4 bits, mode 2 (resting moved, in transit, in swash).
export const sandState = (cls: number, mode: number) => cls | (mode << 4);

// The constants the laws are made with (src/sim/smalls.ts smallsLaw); windows are island days [from, to).
export type Win = readonly [number, number];
export type SmallsConsts = {
  dayTicks: number; pace: number; // Q16 real days an island day
  kn: number; muS: number; muW: number; summer: Win; shadeK: number; shadeFrom: number;
  laMax: number; springBranch: Win; spring: Win; later: Win; fs: readonly [number, number, number]; fsb: readonly [number, number]; bitW: number;
  vern: number; elong: Win; flower: Win; seed: Win;
  slaQ: number; sb: number; rtK: number; // rtK: Q16 mg of lamina a tiller's meristem extends an island day a degree C
  reedEmerge: Win; reedThinTo: number; reedFrost: number; reedSenesce: Win; reedBreak: number; newYear: number; reedK: number;
  lagQ: number; halfSummer: Win;
  dry: number; arrE: number; // E / (k Tref), Q16 (Arrhenius about Tref = 15 C)
  sandThreshold: readonly number[];
};

const cst = (c: SmallsConsts) => /* wgsl */ `
const BASE = ${BASE}u; const CW = ${CW}u; const DAYT = ${c.dayTicks}u; const PACE = ${c.pace}u;
const ATTACHED = ${ATTACHED}u;
fn tday(tick: u32) -> u32 { return (tick / DAYT) % 40u; }
fn inwin(d: u32, lo: u32, hi: u32) -> bool { if (lo <= hi) { return d >= lo && d < hi; } return d >= lo || d < hi; }
fn leftin(d: u32, to: u32) -> u32 { return (to + 39u - d) % 40u + 1u; }
fn xw(cell: u32, k: u32) -> u32 { return inp[BASE + cell * CW + k]; }
fn pq(h: u32) -> u32 {
  if (h == 0u) { return 0u; }
  let e = qexp(-bitcast<i32>(min(h, 0x7fffffffu)));
  if (e <= 0i) { return 0xffffffffu; }
  if (e >= 65536i) { return 0u; }
  return (65536u - u32(e)) << 16u;
}
fn part(p: u32, a: u32, h: u32) -> u32 { if (h == 0u || a == 0u) { return 0u; } let x = mul64(p, a); return divw(x.y, x.x, h).x; }
fn scale(x: u32, q: u32) -> u32 { if (q == 0u) { return x; } return mulhi(x, 0u - q); }
fn q32of(x: u32) -> u32 { if (x >= 65536u) { return 0xffffffffu; } return x << 16u; }
fn satadd(a: u32, b: u32) -> u32 { if (a > 0xffffffffu - b) { return 0xffffffffu; } return a + b; }
fn put(sp: ptr<function, Split>, cum: ptr<function, u32>, p: u32, s: u32) {
  let m = (*sp).m; (*sp).s[m] = s; *cum = *cum + p; (*sp).t[m] = *cum; (*sp).m = m + 1u;
}
fn rest(sp: ptr<function, Split>, s: u32) { (*sp).s[(*sp).m] = s; }
// Poisson(lam) members a bearer bears (lam Q16), as 0, 1, 2 or 3 and more (bm 3), times bk.
fn poisson3(sp: ptr<function, Split>, lam: u32, bk: u32) {
  if (lam == 0u) { (*sp).bm = 0u; return; }
  let l = bitcast<i32>(min(lam, 0x7fffffffu));
  let p0 = qexp(-l);
  let p1 = qmul(l, p0);
  let p2 = qmul(qmul(l, l) / 2i, p0);
  let t0 = q32of(u32(p0)); let t1 = satadd(t0, q32of(u32(p1))); let t2 = satadd(t1, q32of(u32(p2)));
  (*sp).bm = 3u; (*sp).bt[0] = t0; (*sp).bt[1] = t1; (*sp).bt[2] = t2; (*sp).bk = bk;
}
// The bits of the outcomes whose state is no fate and passes ok (the bearers).
fn bearers(sp: ptr<function, Split>) -> u32 {
  var mask = 0u;
  for (var j = 0u; j < 16u; j++) { if (j > (*sp).m) { break; } if ((*sp).s[j] < FATE) { mask = mask | (1u << j); } }
  return mask;
}`;

// ---------- the tillers' law: grass by van Loo and Lantinga (R950), reed shoots by cohort ----------
export function tillerLaw(c: SmallsConsts) {
  const w = (x: Win) => `${x[0]}u, ${x[1]}u`;
  return /* wgsl */ `
${cst(c)}
fn tenc(k: u32, st: u32, spc: u32, lay: u32) -> u32 { return k | (st << 3u) | (spc << 6u) | (lay << 10u); }
fn reedLaw(cell: u32, state: u32, d: u32) -> Split {
  var sp: Split; var cum = 0u;
  let st = (state >> 3u) & 7u;
  if (st == ${TS.live}u) {
    // frost kills the emerging shoots; surplus shoots die toward the stand's final density by the end of June; the
    // live shoots go dead over October to December
    if (inwin(d, ${w(c.reedEmerge)}) && bitcast<i32>(xw(cell, ${X.temp}u)) < ${c.reedFrost}i) { rest(&sp, DEATH); return sp; }
    if (inwin(d, ${c.reedEmerge[0]}u, ${c.reedThinTo}u)) {
      let r = xw(cell, ${X.reedk}u);
      if (r < 65536u) {
        let left = leftin(d, ${c.reedThinTo}u);
        let s = qexp(qln(bitcast<i32>(max(r, 1u))) / bitcast<i32>(left));
        put(&sp, &cum, q32of(65536u - u32(clamp(s, 0i, 65536i))), DEATH);
      }
    }
    if (inwin(d, ${w(c.reedSenesce)})) {
      let left = leftin(d, ${c.reedSenesce[1]}u);
      if (left == 1u) { rest(&sp, tenc(0u, ${TS.dead0}u, ${SPC.reed}u, 0u)); return sp; }
      put(&sp, &cum, scale(0xffffffffu / left, cum), tenc(0u, ${TS.dead0}u, ${SPC.reed}u, 0u));
    }
    rest(&sp, state);
    return sp;
  }
  // standing dead culms break; each first of January they are a year older
  var to = state;
  if (d == ${c.newYear}u && st < ${TS.dead2}u) { to = tenc(0u, st + 1u, ${SPC.reed}u, 0u); }
  put(&sp, &cum, ${c.reedBreak}u, DEATH);
  rest(&sp, to);
  return sp;
}
// Lamina above the grazing height (Q16 mg) of class k: 0.25 mg x 2^k, none in class 0.
const WMAX = ${1 << 21}u;
fn wq(k: u32) -> u32 { return select(0u, 1u << (k + 14u), k > 0u); }
// A tiller's lamina at the day's end from m0 at its start, its meristem extending R over the day while its lamina
// senesces at s of itself (e = exp(-s), phi = (1 - e) / s): m0 e + R phi, at most the top class.
fn lamEnd(m0: u32, R: u32, e: i32, phi: i32) -> u32 {
  return min(WMAX, u32(qmul(bitcast<i32>(m0), e)) + u32(qmul(bitcast<i32>(min(R, 0x7fffffffu)), phi)));
}
fn senPhi(sen: u32) -> vec2i {
  let s = bitcast<i32>(min(sen, 0x7fffffffu)); let e = qexp(-s);
  if (s == 0i) { return vec2i(65536i, 65536i); }
  return vec2i(e, qdiv(65536i - e, s));
}
// The class below a lamina and the Q32 chance of the class above, so the expected lamina is the lamina.
fn place(m: u32) -> vec2u {
  if (m >= WMAX) { return vec2u(7u, 0u); }
  if (m < 32768u) { return vec2u(0u, m << 17u); }
  let j = firstLeadingBit(m) - 14u;
  return vec2u(j, (m - (1u << (j + 14u))) << (18u - j));
}
// The five outcomes of a branch of chance P (bitten or not): dead, then the survivors keeping their stage (the class
// below their lamina, the class above), then those taking the window's stage (the same two), all at fixed places, the
// unbitten branch's last (keeping its stage, the class above) the split's rest.
fn branch(sp: ptr<function, Split>, cum: ptr<function, u32>, P: u32, pm: u32, wc: u32, wall: bool, m: u32, keep: u32, wto: u32, last: bool) {
  let at = place(m); let lo = at.x; let hi = min(lo + 1u, 7u);
  var dead = P;
  if (pm != 0xffffffffu) { dead = mulhi(P, pm); }
  let live = P - dead;
  var moving = 0u;
  if (wall) { moving = live; } else if (wc > 0u) { moving = mulhi(live, wc); }
  let stay = live - moving;
  let sHi = mulhi(stay, at.y); let mHi = mulhi(moving, at.y);
  var wlo = DEATH; var whi = DEATH;
  if (wto != DEATH) { wlo = (wto & ~7u) | lo; whi = (wto & ~7u) | hi; }
  put(sp, cum, dead, DEATH);
  put(sp, cum, stay - sHi, (keep & ~7u) | lo);
  if (last) {
    put(sp, cum, moving - mHi, wlo);
    put(sp, cum, mHi, whi);
    rest(sp, (keep & ~7u) | hi);
    return;
  }
  put(sp, cum, sHi, (keep & ~7u) | hi);
  put(sp, cum, moving - mHi, wlo);
  put(sp, cum, mHi, whi);
}
fn law(cell: u32, state: u32, tick: u32) -> Split {
  _ = &inp;
  let k = state & 7u; let st = (state >> 3u) & 7u; let spc = (state >> 6u) & 15u; let lay = (state >> 10u) & 1u;
  let d = tday(tick);
  if (spc == ${SPC.reed}u) { return reedLaw(cell, state, d); }
  var sp: Split; var cum = 0u;
  let lai = xw(cell, ${X.lai0}u + lay); let R = xw(cell, ${X.rt0}u + lay); let qb = xw(cell, ${X.bite0}u + lay); let sen = xw(cell, ${X.sen}u);
  // the stage the day's outcomes keep: vegetative tillers alive on 1 March are vernalised
  var ts = st;
  if (st == ${TS.veg}u && d == ${c.vern}u) { ts = ${TS.vern}u; }
  // the stage's window: vernalised tillers elongate, elongating ones flower, flowering ones die once seeded
  var wc = 0u; var wall = false; var wto = DEATH; var win = false; var wend = 0u;
  if (st == ${TS.vern}u && inwin(d, ${w(c.elong)})) { win = true; wend = ${c.elong[1]}u; wto = tenc(0u, ${TS.elong}u, spc, lay); }
  if (st == ${TS.elong}u && inwin(d, ${w(c.flower)})) { win = true; wend = ${c.flower[1]}u; wto = tenc(0u, ${TS.flower}u, spc, lay); }
  if (st == ${TS.flower}u && inwin(d, ${w(c.seed)})) { win = true; wend = ${c.seed[1]}u; wto = DEATH; }
  if (win) { let left = leftin(d, wend); if (left == 1u) { wall = true; } else { wc = 0xffffffffu / left; } }
  // deaths (background and shade) over the day
  var mu = ${c.muW}u;
  if (inwin(d, ${w(c.summer)})) { mu = ${c.muS}u; }
  var shade = 0u;
  if (lai > ${c.shadeFrom}u) { shade = u32(qmul(${c.shadeK}i, bitcast<i32>(lai - ${c.shadeFrom}u))); }
  let pm = pq(u32(qmul(bitcast<i32>(mu + shade), bitcast<i32>(PACE))));
  // a bite takes half the lamina above the grazing height and leaves the sheaths and meristems, which regrow it; an
  // elongating tiller's apex goes with the bite and it dies; then each tiller's lamina over the day
  let ep = senPhi(sen); let w0 = wq(k); let keep = tenc(0u, ts, spc, lay);
  var pmb = pm;
  if (st == ${TS.elong}u) { pmb = 0xffffffffu; }
  branch(&sp, &cum, qb, pmb, wc, wall, lamEnd(w0 >> 1u, R, ep.x, ep.y), keep, wto, false);
  branch(&sp, &cum, 0xffffffffu - qb, pm, wc, wall, lamEnd(w0, R, ep.x, ep.y), keep, wto, true);
  // daughters of vegetative and vernalised tillers: Poisson(kN Fs LA) a real day, Fs at the first week's after a bite
  // for the bitten share of the day
  if (st == ${TS.veg}u || st == ${TS.vern}u) {
    let temp = bitcast<i32>(xw(cell, ${X.temp}u));
    var cd = vec2i(${c.later[0]}i, ${c.later[1]}i);
    if (inwin(d, ${w(c.springBranch)})) { cd = vec2i(${c.spring[0]}i, ${c.spring[1]}i); }
    let la = qmul(${c.laMax}i, clamp(qdiv(temp - cd.x, cd.y - cd.x), 0i, 65536i));
    let fs = clamp(${c.fs[0]}i - qmul(${c.fs[1]}i, bitcast<i32>(lai)), 0i, ${c.fs[2]}i);
    let fsb = clamp(${c.fsb[0]}i - qmul(${c.fsb[1]}i, bitcast<i32>(lai)), 0i, ${c.fs[2]}i);
    let fe = fs + qmul(qmul(bitcast<i32>(qb >> 16u), ${c.bitW}i), fsb - fs);
    let lam = qmul(qmul(qmul(${c.kn}i, max(fe, 0i)), la), bitcast<i32>(PACE));
    poisson3(&sp, u32(max(lam, 0i)), 1u);
    var mask = 0u;
    for (var j = 0u; j < 16u; j++) { if (j > sp.m) { break; } let s = sp.s[j]; let ss = (s >> 3u) & 7u; if (s < FATE && (ss == ${TS.veg}u || ss == ${TS.vern}u)) { mask = mask | (1u << j); } }
    sp.bo = mask; sp.bs = tenc(0u, ${TS.veg}u, ${SPC.grass}u, lay);
  }
  return sp;
}`;
}

// ---------- litter: leaves falling from their plants, then a chain of mass classes decaying (R960 to R966) ----------
export function litterLaw(c: SmallsConsts) {
  return /* wgsl */ `
${cst(c)}
fn law(cell: u32, state: u32, tick: u32) -> Split {
  _ = &inp;
  var sp: Split; var cum = 0u;
  let j = state & 7u; let cl = (state >> 3u) & 15u; let lag = (state >> 7u) & 1u;
  let d = tday(tick);
  if (cl >= ATTACHED) {
    var to = cl - ATTACHED;
    if (cl == ${LC.onReed}u) { to = ${LC.reedLeaf}u; }
    put(&sp, &cum, inp[${FALL}u + (cl - ATTACHED) * 40u + d], to << 3u);
    rest(&sp, state);
    return sp;
  }
  if (lag == 1u) { put(&sp, &cum, ${c.lagQ}u, j | (cl << 3u)); rest(&sp, state); return sp; }
  var qd = 0u;
  if (cl == ${LC.standing}u) { qd = xw(cell, ${X.dead}u); if (qd > 0u) { put(&sp, &cum, qd, FATE + ${PRED.grazer}u); } }
  var half = 0u;
  if (inwin(d, ${c.halfSummer[0]}u, ${c.halfSummer[1]}u)) { half = 1u; }
  let e = ${LT}u + (((cl * 2u + half) * 2u + min(xw(cell, ${X.rich}u), 1u)) * 8u + j) * ${LT_STRIDE}u;
  let n = inp[e];
  var prev = 0u;
  for (var o = 0u; o + 1u < n; o++) {
    let b = inp[e + 1u + o];
    put(&sp, &cum, scale(b - prev, qd), inp[e + n + o]);
    prev = b;
  }
  rest(&sp, inp[e + n + n - 1u]);
  return sp;
}`;
}

// ---------- invertebrates and soil fauna: a stage chain a taxon, by the fauna table (R968 to R989) ----------
export function faunaLaw(c: SmallsConsts) {
  const f = (k: keyof typeof F_) => `inp[row + ${F_[k]}u]`;
  return /* wgsl */ `
${cst(c)}
fn law(cell: u32, state: u32, tick: u32) -> Split {
  _ = &inp;
  var sp: Split; var cum = 0u;
  let stg = (state >> 3u) & 7u; let tax = (state >> 6u) & 15u;
  let row = ${FT}u + (tax * 8u + stg) * ${FT_STRIDE}u;
  let d = tday(tick);
  // the predators first: each class's chance for a member to be had (the cell's), times how much of it is to be had
  let mode = ${f("mode")};
  var avail = 65536u;
  if (mode == 1u) { avail = xw(cell, ${X.ga}u); }
  var taken = 0u;
  for (var p = 0u; p < 3u; p++) {
    if (((${f("prey")} >> p) & 1u) == 0u) { continue; }
    let q = scale(mulhi(xw(cell, ${X.eat}u + p), q32of(avail)), taken);
    put(&sp, &cum, q, FATE + p);
    taken = cum;
  }
  // deaths: the stage's hazard, scaled by the taxon's density against its cited one where regulated, and the drought's
  var h = ${f("death")};
  if (${f("reg")} == 1u) { h = u32(qmul(bitcast<i32>(h), bitcast<i32>(xw(cell, ${X.nk}u + tax)))); }
  if (xw(cell, ${X.water}u) < ${c.dry}u) { h = h + ${f("dry")}; }
  // moving on: in the stage's window, evenly over the days left of it (dying at its end, for a stage that ends so); or
  // at the stage's hazard (sped by warmth where it says)
  let next = ${f("next")};
  var ha = 0u; var wc = 0u; var wall = false;
  let wfrom = ${f("from")}; let wto = ${f("to")};
  var nto = DEATH;
  if (next != 0xffffffffu && ${f("terminal")} == 0u) { nto = (state & 0xffc7u) | (next << 3u); }
  if (wfrom != 0xffffffffu) {
    if (inwin(d, wfrom, wto)) { let left = leftin(d, wto); if (left == 1u) { wall = true; } else { wc = 0xffffffffu / left; } }
  } else if (next != 0xffffffffu) {
    ha = ${f("adv")};
    if (${f("warm")} == 1u) { ha = u32(qmul(bitcast<i32>(ha), bitcast<i32>(xw(cell, ${X.arr}u)))); }
  }
  if (wall) { rest(&sp, nto); return sp; }
  if (wc > 0u) { put(&sp, &cum, scale(wc, cum), nto); }
  let hh = h + ha;
  let pe = scale(pq(hh), cum);
  let pa = part(pe, ha, hh);
  put(&sp, &cum, pa, nto);
  put(&sp, &cum, pe - pa, DEATH);
  rest(&sp, state);
  // bearing: Poisson batches a day into the taxon's first stage
  let bf = ${f("bfrom")};
  if (${f("bear")} > 0u && (bf == 0xffffffffu || inwin(d, bf, ${f("bto")}))) {
    poisson3(&sp, ${f("bear")}, ${f("batch")});
    sp.bo = bearers(&sp); sp.bs = tax << 6u;
  }
  return sp;
}`;
}

// ---------- moved sand (R993): entrained above its class's threshold, settling after a hop, swash running off ----------
export function sandLaw(c: SmallsConsts) {
  return /* wgsl */ `
${cst(c)}
const THRESH = array<u32, 16>(${Array.from({ length: 16 }, (_, i) => `${c.sandThreshold[i] ?? 0xffffffff}u`).join(", ")});
fn law(cell: u32, state: u32, tick: u32) -> Split {
  _ = &inp;
  var sp: Split; var cum = 0u;
  let cls = state & 15u; let mode = (state >> 4u) & 3u;
  if (mode == 0u) {
    var th = THRESH[cls];
    if (xw(cell, ${X.wet}u) > 0u) { th = 0xffffffffu; }
    if (xw(cell, ${X.ustar}u) > th) { rest(&sp, cls | (1u << 4u)); return sp; }
    if (xw(cell, ${X.swash}u) > 0u) { rest(&sp, cls | (2u << 4u)); return sp; }
    rest(&sp, state);
    return sp;
  }
  if (mode == 2u && xw(cell, ${X.swash}u) > 0u) { rest(&sp, state); return sp; }
  rest(&sp, cls);
  return sp;
}`;
}

// ---------- the day's kernels ----------
const FLAT = /* wgsl */ `
fn flat(g: vec3u, n: vec3u) -> u32 { return g.x + g.y * n.x * 256u; }`;
const A64 = (buf: string) => /* wgsl */ `
fn add64a(i: u32, v: vec2u) {
  if (v.x == 0u && v.y == 0u) { return; }
  let old = atomicAdd(&${buf}[i], v.x);
  var carry = v.y;
  if (old > 0xffffffffu - v.x) { carry = carry + 1u; }
  if (carry > 0u) { atomicAdd(&${buf}[i + 1u], carry); }
}
fn add32a(i: u32, v: u32) { if (v > 0u) { atomicAdd(&${buf}[i], v); } }`;
const R64 = (buf: string, atomic: boolean) => /* wgsl */ `
fn r64(i: u32) -> vec2u { return vec2u(${atomic ? `atomicLoad(&${buf}[i]), atomicLoad(&${buf}[i + 1u])` : `${buf}[i], ${buf}[i + 1u]`}); }`;
// a 64-bit number over a u32, saturating at 2^32 - 1
const DIV = /* wgsl */ `
fn div64s(a: vec2u, d: u32) -> u32 { if (d == 0u) { return 0u; } if (a.y >= d) { return 0xffffffffu; } return divw(a.y, a.x, d).x; }
fn mul64s(a: u32, b: u32) -> vec2u { return mul64(a, b); }
fn sat32(a: vec2u) -> u32 { if (a.y != 0u) { return 0xffffffffu; } return a.x; }`;

// Eaten, per tile: what the animals ate of each pool since the link last wrote it, shared over the tile's four cells
// (and the two layers) by what each held at the census, in proportion, the remainder to the one holding most. Bindings:
// W (the animals' tiles), wrote, cen (atomic), eat.
export function smallsEaten() {
  return /* wgsl */ `
${FIXED}
@group(0) @binding(0) var<storage, read> W: array<u32>;
@group(0) @binding(1) var<storage, read> wrote: array<u32>;
@group(0) @binding(2) var<storage, read_write> cen: array<atomic<u32>>;
@group(0) @binding(3) var<storage, read_write> eat: array<u32>;
${FLAT}
${R64("cen", true)}
${DIV}
fn cellOf(t: u32, q: u32) -> u32 { return ((t / ${TW}u) * 2u + q / 2u) * ${N}u + (t % ${TW}u) * 2u + q % 2u; }
// Shares amount over n weights (64-bit, at most 8), writing each share into eat at its word.
fn share(amount: u32, w: array<vec2u, 8>, at: array<u32, 8>, n: u32) {
  // the weights brought to 32 bits together
  var top = 0u;
  for (var i = 0u; i < n; i++) { top = max(top, w[i].y); }
  let sh = select(0u, 32u - countLeadingZeros(top), top > 0u);
  var tot = 0u; var ws: array<u32, 8>; var big = 0u;
  for (var i = 0u; i < n; i++) {
    var v = w[i].x;
    if (sh > 0u) { v = (w[i].x >> sh) | (w[i].y << (32u - sh)); }
    ws[i] = v >> 3u; tot = tot + (v >> 3u);
    if (ws[i] > ws[big]) { big = i; }
  }
  if (tot == 0u) { return; }
  var given = 0u;
  for (var i = 0u; i < n; i++) { let s = divw(mul64(amount, ws[i]).y, mul64(amount, ws[i]).x, tot).x; eat[at[i]] = eat[at[i]] + s; given = given + s; }
  eat[at[big]] = eat[at[big]] + (amount - given);
}
@compute @workgroup_size(256) fn main(@builtin(global_invocation_id) g: vec3u, @builtin(num_workgroups) n: vec3u) {
  let t = flat(g, n);
  if (t >= ${TILES}u) { return; }
  for (var q = 0u; q < 4u; q++) { for (var k = 0u; k < ${EW}u; k++) { eat[cellOf(t, q) * ${EW}u + k] = 0u; } }
  if (W[${W_.land}u * ${TILES}u + t] == 0u) { return; }
  let garea = W[${W_.garea}u * ${TILES}u + t];
  let fg = W[${W_.fg}u * ${TILES}u + t]; let fd = W[${W_.fd}u * ${TILES}u + t];
  // green: Q16 g/m2 of the tile's ground layer over its area in milli-m2 is mg; lamina in 1/8 mg
  let green = sat32(mul64(sat32(vec2u(div64s(mul64(sat_sub(wrote[t * ${WROTE}u], fg), garea), 65536u), 0u)), 8u));
  var w: array<vec2u, 8>; var at: array<u32, 8>;
  for (var q = 0u; q < 4u; q++) {
    let c = cellOf(t, q);
    w[2u * q] = r64(c * ${CENW}u + ${CEN.lam}u); w[2u * q + 1u] = r64(c * ${CENW}u + ${CEN.lam + 2}u);
    at[2u * q] = c * ${EW}u; at[2u * q + 1u] = c * ${EW}u + 1u;
  }
  share(green, w, at, 8u);
  let dead = div64s(mul64(sat_sub(wrote[t * ${WROTE}u + 1u], fd), garea), 65536u);
  for (var q = 0u; q < 4u; q++) { let c = cellOf(t, q); w[q] = r64(c * ${CENW}u + ${CEN.lit + 2 * LC.standing}u); at[q] = c * ${EW}u + 2u; }
  share(dead, w, at, 4u);
  for (var p = 0u; p < 3u; p++) {
    let ate = sat_sub(wrote[t * ${WROTE}u + 2u + p], W[(${W_.icrow}u + p) * ${TILES}u + t]);
    for (var q = 0u; q < 4u; q++) { let c = cellOf(t, q); w[q] = r64(c * ${CENW}u + ${CEN.prey}u + 2u * p); at[q] = c * ${EW}u + 3u + p; }
    share(ate, w, at, 4u);
  }
}
fn sat_sub(a: u32, b: u32) -> u32 { if (a > b) { return a - b; } return 0u; }`;
}

// Inputs, per cell: the day's words and the GPU's (layers' leaf area, growth, the targets and the chances they set,
// densities against the cited, the crowns' shares), and the births the day brings. Bindings: inp, dayw, cen (atomic),
// eat, st, crowns, tb (tiller births), lb (litter births), P (t, crowns bound).
export function smallsInputs(c: SmallsConsts, sc: { reedEmerge: number; reedUnder: number; leaf: readonly { cls: number; start: number; input: number }[] }) {
  return /* wgsl */ `
${FIXED}
${RAND}
struct Params { t: u32, crowns: u32, a: u32, b: u32 }
@group(0) @binding(0) var<storage, read_write> inp: array<u32>;
@group(0) @binding(1) var<storage, read> dayw: array<u32>;
@group(0) @binding(2) var<storage, read_write> cen: array<atomic<u32>>;
@group(0) @binding(3) var<storage, read> eat: array<u32>;
@group(0) @binding(4) var<storage, read_write> st: array<u32>;
@group(0) @binding(5) var<storage, read> crowns: array<u32>;
@group(0) @binding(6) var<storage, read_write> tb: array<u32>;
@group(0) @binding(7) var<storage, read_write> lb: array<u32>;
@group(0) @binding(8) var<uniform> P: Params;
${FLAT}
${R64("cen", true)}
${DIV}
const BASE = ${BASE}u; const CW = ${CW}u;
fn tday(tick: u32) -> u32 { return (tick / ${c.dayTicks}u) % 40u; }
fn inwin(d: u32, lo: u32, hi: u32) -> bool { if (lo <= hi) { return d >= lo && d < hi; } return d >= lo || d < hi; }
fn q32ratio(a: u32, b: u32) -> u32 { if (b == 0u || a == 0u) { return 0u; } if (a >= b) { return 0xffffffffu; } return divw(a, 0u, b).x; }
// mg a m2 of so much (1/8 mg, 64-bit) over a share (Q16) of the cell
fn mgm2(v: vec2u, share: u32) -> u32 {
  if (share == 0u) { return 0u; }
  let a = vec2u(v.x << 13u, (v.y << 13u) | (v.x >> 19u));
  let d = ${CELL_M2}u * share;
  return sat32(vec2u(divw(a.y % d, a.x, d).x, a.y / d));
}
@compute @workgroup_size(256) fn main(@builtin(global_invocation_id) g: vec3u, @builtin(num_workgroups) n: vec3u) {
  let cell = flat(g, n);
  if (cell >= ${CELLS}u) { return; }
  let b = BASE + cell * CW; let ce = cell * ${CENW}u; let s = cell * ${STW}u;
  for (var k = 0u; k < ${DAYW}u; k++) { inp[b + ${X.temp}u + k] = dayw[cell * ${DAYW}u + k]; }
  let d = tday(P.t);
  let temp = bitcast<i32>(inp[b + ${X.temp}u]);
  // the layers: leaf area (the field layer's with the canopy over it), a tiller's growth over the day, the bites' chance
  let shares = vec2u(inp[b + ${X.open}u], inp[b + ${X.field}u]);
  for (var l = 0u; l < 2u; l++) {
    let lam = r64(ce + ${CEN.lam}u + 2u * l);
    let mg = mgm2(lam, shares[l]);
    var lai = muldivs(mg, ${c.slaQ}u, 1000u);
    if (l == 1u) { lai = lai + inp[b + ${X.lc}u]; }
    inp[b + ${X.lai0}u + l] = lai;
    var grow = inp[b + ${X.grow}u];
    if (l == 1u) { grow = u32(qmul(bitcast<i32>(grow), bitcast<i32>(inp[b + ${X.flight}u]))); }
    // a tiller's lamina grown over the day (Q16 mg): what its meristem extends, a leaf a phyllochron, or the layer's
    // growth shared over its tillers where that is less
    let nt = atomicLoad(&cen[ce + ${CEN.n}u + l]);
    let rm = u32(qmul(max(temp, 0i), ${c.rtK}i));
    inp[b + ${X.rt0}u + l] = min(rm, muldivs(muldivs(grow, shares[l], 65536u), ${CELL_M2 * 1000}u, nt));
    // the target keeps its sign (what was taken past what was eaten stays owed back), the chance only what is due
    let tgt = bitcast<i32>(eat[cell * ${EW}u + l]) + bitcast<i32>(st[s + ${ST.credit}u + l]);
    st[s + ${ST.target}u + l] = bitcast<u32>(tgt);
    let due = u32(max(0i, tgt));
    // a bite takes half a tiller's lamina: q = due / (sb B), B 64-bit (1/8 mg) and both brought under 2^32 together
    let H = mulhi64(lam, ${c.sb}u << 16u);
    let sh = select(0u, 32u - countLeadingZeros(H.y), H.y > 0u);
    var hs = H.x; var ds = due;
    if (sh > 0u) { hs = (H.x >> sh) | (H.y << (32u - sh)); ds = due >> sh; }
    inp[b + ${X.bite0}u + l] = q32ratio(ds, hs);
  }
  // dead blades standing, grazed whole
  let blades = div64s(r64(ce + ${CEN.lit + 2 * LC.standing}u), 1000u);
  let tgd = bitcast<i32>(eat[cell * ${EW}u + 2u]) + bitcast<i32>(st[s + ${ST.credit}u + 2u]);
  st[s + ${ST.target}u + 2u] = bitcast<u32>(tgd);
  let td = u32(max(0i, tgd));
  inp[b + ${X.dead}u] = q32ratio(td, blades);
  // prey, by predator class
  for (var p = 0u; p < 3u; p++) {
    let avail = sat32(r64(ce + ${CEN.prey}u + 2u * p));
    let tgp = bitcast<i32>(eat[cell * ${EW}u + 3u + p]) + bitcast<i32>(st[s + ${ST.credit}u + 3u + p]);
    st[s + ${ST.target}u + 3u + p] = bitcast<u32>(tgp);
    let tp = u32(max(0i, tgp));
    inp[b + ${X.eat}u + p] = q32ratio(tp, avail);
  }
  // worms within reach: the ground layer's share, under the snow, where the ground is not frozen
  var ga = u32(qmul(bitcast<i32>(min(65536u, shares.x + shares.y)), bitcast<i32>(inp[b + ${X.reach}u])));
  if (temp <= 0i) { ga = 0u; }
  inp[b + ${X.ga}u] = ga;
  // densities against the cited: each taxon's members over its K (Q16, at most 4)
  for (var x = 0u; x < 16u; x++) {
    let N = atomicLoad(&cen[ce + ${CEN.tax}u + x]); let K = inp[b + ${X.k}u + x];
    var r = 65536u;
    if (K > 0u) { r = min(muldivs(N, 65536u, K), 4u * 65536u); } else if (N > 0u) { r = 4u * 65536u; }
    inp[b + ${X.nk}u + x] = r;
  }
  // reed: the final shoots over those standing
  let live = atomicLoad(&cen[ce + ${CEN.reedLive}u]);
  let rk = muldivs(${c.reedK}u, inp[b + ${X.marsh}u], 65536u);
  inp[b + ${X.reedk}u] = select(65536u, muldivs(rk, 65536u, live), live > rk);
  // earthworms' rates by warmth: Arrhenius about 15 C (R982), exp(E/k (1/Tref - 1/T)) = exp(E/(k Tref) (T - Tref) / T)
  let tk = 17901158i + temp;
  inp[b + ${X.arr}u] = u32(qexp(qmul(qdiv(temp - 983040i, tk), ${c.arrE}i)));
  inp[b + ${X.ustar}u] = 0u; inp[b + ${X.wet}u] = 0u; inp[b + ${X.swash}u] = 0u;
  // births: reed shoots coming up over their window, fewer under standing dead culms (Graneli 1989)
  tb[2u * cell] = 0u; tb[2u * cell + 1u] = 0u;
  let marsh = inp[b + ${X.marsh}u];
  if (marsh > 0u && inwin(d, ${c.reedEmerge[0]}u, ${c.reedEmerge[1]}u)) {
    let dead = atomicLoad(&cen[ce + ${CEN.reedDead}u]);
    var per = ${sc.reedEmerge}u;
    if (dead > 0u) { per = ${sc.reedUnder}u; }
    tb[2u * cell] = (cell << 16u) | ${tillerState(0, TS.live, SPC.reed, 0)}u;
    tb[2u * cell + 1u] = muldivs(per, marsh, 65536u);
  }
  // the year's leaves on the crowns, born on their year's first day: the closed canopy's share over the cell times the
  // year's foliar fall over a leaf
  var pine = 0u; var broad = 0u;
  if (P.crowns == 1u) {
    let cx = cell % ${N}u; let cy = cell / ${N}u;
    for (var q = 0u; q < 16u; q++) {
      let w = crowns[(cy * 4u + q / 4u) * ${N * 4}u + cx * 4u + q % 4u];
      pine = pine + min(w & 0xffffu, 4096u); broad = broad + min(w >> 16u, 4096u);
    }
  }
  for (var k = 3u; k < ${LB}u; k++) { lb[2u * (cell * ${LB}u + k)] = 0u; lb[2u * (cell * ${LB}u + k) + 1u] = 0u; }
${sc.leaf.map((l, i) => `  if (d == ${l.start}u) { let sh = ${i === 0 ? "pine" : "broad"}; lb[2u * (cell * ${LB}u + ${3 + i}u)] = (cell << 16u) | ${litterState(0, l.cls, 0)}u; lb[2u * (cell * ${LB}u + ${3 + i}u) + 1u] = muldivs(sh, ${l.input}u, 65536u); }`).join("\n")}
}
fn muldivs(a: u32, b: u32, c: u32) -> u32 { if (c == 0u) { return 0u; } let p = mul64(a, b); if (p.y >= c) { return 0xffffffffu; } return divw(p.y, p.x, c).x; }`;
}

// The split's census, per bin of a kind, from the outcome counts the split left: kind 0 tillers (bitten lamina, dead
// lamina, reed gone dead and broken), 1 litter (blades grazed), 2 fauna (prey eaten). Bindings: bins, ctl, cnt, inp,
// cen (atomic), P (cap, t). The law's WGSL comes before it (to name the outcomes).
export function smallsSplit(law: string, kind: number, sc: { pieceUg: readonly number[]; outs: number }) {
  return /* wgsl */ `
${FIXED}
${RAND}
const DEATH = 0xffffffffu; const FATE = 0xfffffff0u;
struct Split { m: u32, t: array<u32, 15>, s: array<u32, 16>, bm: u32, bt: array<u32, 3>, bo: u32, bs: u32, bk: u32 }
struct Params { cap: u32, t: u32, a: u32, b: u32 }
@group(0) @binding(0) var<storage, read> bins: array<u32>;
@group(0) @binding(1) var<storage, read> ctl: array<u32>;
@group(0) @binding(2) var<storage, read> cnt: array<u32>;
@group(0) @binding(3) var<storage, read> inp: array<u32>;
@group(0) @binding(4) var<storage, read_write> cen: array<atomic<u32>>;
@group(0) @binding(5) var<uniform> P: Params;
${law}
${FLAT}
${A64("cen")}
const PIECE = array<u32, 16>(${Array.from({ length: 16 }, (_, i) => `${sc.pieceUg[i] ?? 0}u`).join(", ")});
@compute @workgroup_size(256) fn main(@builtin(global_invocation_id) g: vec3u, @builtin(num_workgroups) n: vec3u) {
  let i = flat(g, n);
  if (i >= ctl[0] || i >= P.cap) { return; }
  let key = bins[i]; let cell = key >> 16u; let state = key & 0xffffu; let ce = cell * ${CENW}u;
  let T = bins[2u * P.cap + i] & 0x7fffffffu; let out0 = bins[3u * P.cap + i];
  if (T == out0) { return; }
  let sp = law(cell, state, P.t);
  ${kind === 0 ? /* wgsl */ `
  let k = state & 7u; let st = (state >> 3u) & 7u; let spc = (state >> 6u) & 15u; let lay = (state >> 10u) & 1u;
  if (spc == ${SPC.reed}u) {
    for (var j = 0u; j < 16u; j++) { if (j > sp.m) { break; }
      let c = cnt[i * ${sc.outs}u + j]; let s = sp.s[j];
      if (c == 0u) { continue; }
      if (st == ${TS.live}u && s != DEATH && ((s >> 3u) & 7u) == ${TS.dead0}u) { add32a(ce + ${CEN.senesced}u, c); }
      if (st >= ${TS.dead0}u && s == DEATH) { add32a(ce + ${CEN.broke}u, c); }
    }
    return;
  }
  // the law's outcomes at their places: 0 to 4 bitten, 5 to 9 not. A bite takes half the lamina; a tiller dying leaves
  // its lamina dead, a living one what senesced of it and of what grew over the day (Q16 mg to 1/8 mg, a shift of 13)
  let R = inp[${BASE}u + cell * ${CW}u + ${X.rt0}u + lay];
  let ep = senPhi(inp[${BASE}u + cell * ${CW}u + ${X.sen}u]); let w0 = wq(k);
  for (var j = 0u; j < 10u; j++) {
    let c = cnt[i * ${sc.outs}u + j]; let s = sp.s[j];
    if (c == 0u) { continue; }
    var m0 = w0;
    if (j < 5u) { m0 = w0 >> 1u; add64a(ce + ${CEN.bitten}u + 2u * lay, mul64(c, w0 >> 14u)); }
    var lost = m0;
    if (s != DEATH) { lost = m0 - u32(qmul(bitcast<i32>(m0), ep.x)) + min(R, 0x7fffffffu) - u32(qmul(bitcast<i32>(min(R, 0x7fffffffu)), ep.y)); }
    let x = mul64(c, lost);
    add64a(ce + ${CEN.deadLam}u, vec2u((x.x >> 13u) | (x.y << 19u), x.y >> 13u));
  }` : kind === 1 ? /* wgsl */ `
  let j0 = state & 7u; let cl = (state >> 3u) & 15u;
  if (cl != ${LC.standing}u) { return; }
  for (var j = 0u; j < 16u; j++) { if (j > sp.m) { break; }
    if (sp.s[j] == FATE + ${PRED.grazer}u) { add64a(ce + ${CEN.grazed}u, mul64(cnt[i * ${sc.outs}u + j], PIECE[j0])); }
  }` : /* wgsl */ `
  let stg = (state >> 3u) & 7u; let tax = (state >> 6u) & 15u;
  let mass = inp[${FT}u + (tax * 8u + stg) * ${FT_STRIDE}u + ${F_.mass}u];
  for (var j = 0u; j < 16u; j++) { if (j > sp.m) { break; }
    let s = sp.s[j];
    if (s >= FATE && s < FATE + 3u) { add64a(ce + ${CEN.eaten}u + 2u * (s - FATE), mul64(cnt[i * ${sc.outs}u + j], mass)); }
  }`}
}`;
}

// The census, per bin of a kind after its step: kind 0 tillers (green lamina and tillers by layer, reed shoots live and
// dead), 1 litter (lying mass by class), 2 fauna (members by taxon, prey by predator class and the bin each would single
// out). Bindings: bins, ctl, inp, cen (atomic), P (cap, summer from, summer to).
export function smallsCensus(kind: number, sc: { pieceUg: readonly number[]; foxFrom: number; foxTo: number; dayTicks: number }) {
  return /* wgsl */ `
${FIXED}
struct Params { cap: u32, t: u32, a: u32, b: u32 }
@group(0) @binding(0) var<storage, read> bins: array<u32>;
@group(0) @binding(1) var<storage, read> ctl: array<u32>;
@group(0) @binding(2) var<storage, read> inp: array<u32>;
@group(0) @binding(3) var<storage, read_write> cen: array<atomic<u32>>;
@group(0) @binding(4) var<uniform> P: Params;
${FLAT}
${A64("cen")}
const PIECE = array<u32, 128>(${Array.from({ length: 128 }, (_, i) => `${sc.pieceUg[i] ?? 0}u`).join(", ")});
fn inwin(d: u32, lo: u32, hi: u32) -> bool { if (lo <= hi) { return d >= lo && d < hi; } return d >= lo || d < hi; }
@compute @workgroup_size(256) fn main(@builtin(global_invocation_id) g: vec3u, @builtin(num_workgroups) n: vec3u) {
  let i = flat(g, n);
  if (i >= ctl[0] || i >= P.cap) { return; }
  let key = bins[i]; let cell = key >> 16u; let state = key & 0xffffu; let ce = cell * ${CENW}u;
  let c = (bins[2u * P.cap + i] & 0x7fffffffu) - bins[3u * P.cap + i];
  if (c == 0u) { return; }
  _ = &inp;
  ${kind === 0 ? /* wgsl */ `
  let k = state & 7u; let st = (state >> 3u) & 7u; let spc = (state >> 6u) & 15u; let lay = (state >> 10u) & 1u;
  if (spc == ${SPC.reed}u) {
    if (st == ${TS.live}u) { add32a(ce + ${CEN.reedLive}u, c); } else { add32a(ce + ${CEN.reedDead}u, c); }
    return;
  }
  add64a(ce + ${CEN.lam}u + 2u * lay, mul64(c, select(0u, 2u << k, k > 0u)));
  add32a(ce + ${CEN.n}u + lay, c);` : kind === 1 ? /* wgsl */ `
  let j = state & 7u; let cl = (state >> 3u) & 15u;
  if (cl >= 10u || (state >> 7u) == 1u) { return; }
  add64a(ce + ${CEN.lit}u + 2u * cl, mul64(c, PIECE[cl * 8u + j]));` : /* wgsl */ `
  let stg = (state >> 3u) & 7u; let tax = (state >> 6u) & 15u;
  let row = ${FT}u + (tax * 8u + stg) * ${FT_STRIDE}u;
  let counted = inp[row + ${F_.reg}u];
  if (counted != 0u) { add32a(ce + ${CEN.tax}u + tax, c); }
  let prey = inp[row + ${F_.prey}u];
  if (prey == 0u) { return; }
  var avail = 65536u;
  if (inp[row + ${F_.mode}u] == 1u) { avail = inp[${BASE}u + cell * ${CW}u + ${X.ga}u]; }
  let mg = mul64(c, inp[row + ${F_.mass}u]);
  let a = vec2u((mg.x >> 16u) | (mg.y << 16u), mg.y >> 16u);
  let had = vec2u(mul64(a.x, avail).x, mul64(a.x, avail).y + a.y * avail);
  let d = (P.t / ${sc.dayTicks}u) % 40u;
  for (var p = 0u; p < 3u; p++) {
    if (((prey >> p) & 1u) == 0u) { continue; }
    if (p == ${PRED.fox}u && !inwin(d, ${sc.foxFrom}u, ${sc.foxTo}u)) { continue; }
    add64a(ce + ${CEN.prey}u + 2u * p, had);
    atomicMax(&cen[ce + ${CEN.top}u + p], (min(had.x >> 10u, 0xffffu) << 16u) | state);
  }`}
}`;
}

// Litter births, per cell, after the tillers' step: the dead lamina as blades (carrying what makes no whole blade),
// reed leaves as leaves on their plants, broken culms as fallen stems. Bindings: cen (atomic), st, lb, P (blade units).
export function smallsLitterBirths(sc: { bladeUnits: number; reedLeaves: number }) {
  return /* wgsl */ `
${FIXED}
@group(0) @binding(0) var<storage, read_write> cen: array<atomic<u32>>;
@group(0) @binding(1) var<storage, read_write> st: array<u32>;
@group(0) @binding(2) var<storage, read_write> lb: array<u32>;
${FLAT}
${R64("cen", true)}
@compute @workgroup_size(256) fn main(@builtin(global_invocation_id) g: vec3u, @builtin(num_workgroups) n: vec3u) {
  let cell = flat(g, n);
  if (cell >= ${CELLS}u) { return; }
  let ce = cell * ${CENW}u; let s = cell * ${STW}u; let at = cell * ${LB}u;
  let dead = r64(ce + ${CEN.deadLam}u);
  let carry = st[s + ${ST.carry}u];
  // whole blades: (dead + carry) over a blade's units, the rest carried
  var tot = vec2u(dead.x + carry, dead.y + select(0u, 1u, dead.x > 0xffffffffu - carry));
  var blades = 0u; var left = 0u;
  if (tot.y >= ${sc.bladeUnits}u) { blades = 0xffffffffu; } else { let q = divw(tot.y, tot.x, ${sc.bladeUnits}u); blades = q.x; left = q.y; }
  st[s + ${ST.carry}u] = left;
  lb[2u * at] = (cell << 16u) | ${litterState(0, LC.standing, 0)}u; lb[2u * at + 1u] = blades;
  let leaves = atomicLoad(&cen[ce + ${CEN.senesced}u]);
  lb[2u * (at + 1u)] = (cell << 16u) | ${litterState(0, LC.onReed, 0)}u; lb[2u * (at + 1u) + 1u] = min(leaves, 0xffffffffu / ${sc.reedLeaves}u) * ${sc.reedLeaves}u;
  lb[2u * (at + 2u)] = (cell << 16u) | ${litterState(0, LC.reedStem, 1)}u; lb[2u * (at + 2u) + 1u] = atomicLoad(&cen[ce + ${CEN.broke}u]);
}`;
}

// Settle, per cell: each credit is the day's target less what the bins lost to it. Bindings: cen (atomic), st.
export const SMALLS_SETTLE = /* wgsl */ `
${FIXED}
@group(0) @binding(0) var<storage, read_write> cen: array<atomic<u32>>;
@group(0) @binding(1) var<storage, read_write> st: array<u32>;
${FLAT}
${R64("cen", true)}
${DIV}
@compute @workgroup_size(256) fn main(@builtin(global_invocation_id) g: vec3u, @builtin(num_workgroups) n: vec3u) {
  let cell = flat(g, n);
  if (cell >= ${CELLS}u) { return; }
  let ce = cell * ${CENW}u; let s = cell * ${STW}u;
  var lost: array<u32, 6>;
  lost[0] = sat32(r64(ce + ${CEN.bitten}u)); lost[1] = sat32(r64(ce + ${CEN.bitten + 2}u));
  lost[2] = div64s(r64(ce + ${CEN.grazed}u), 1000u);
  for (var p = 0u; p < 3u; p++) { lost[3u + p] = sat32(r64(ce + ${CEN.eaten}u + 2u * p)); }
  for (var k = 0u; k < 6u; k++) {
    let d = bitcast<i32>(st[s + ${ST.target}u + k]) - bitcast<i32>(lost[k]);
    st[s + ${ST.credit}u + k] = bitcast<u32>(d);
  }
}`;

// The animals' pools, per tile, from its cells' census less their credits: the ground layer's green and its dead blades
// (Q16 g/m2 of its area), each predator class's prey (mg) and the bin a held one would single out. Bindings: W, wrote,
// cen (atomic), st.
export const SMALLS_POOLS = /* wgsl */ `
${FIXED}
@group(0) @binding(0) var<storage, read_write> W: array<u32>;
@group(0) @binding(1) var<storage, read_write> wrote: array<u32>;
@group(0) @binding(2) var<storage, read_write> cen: array<atomic<u32>>;
@group(0) @binding(3) var<storage, read> st: array<u32>;
${FLAT}
${R64("cen", true)}
${DIV}
fn cellOf(t: u32, q: u32) -> u32 { return ((t / ${TW}u) * 2u + q / 2u) * ${N}u + (t % ${TW}u) * 2u + q % 2u; }
// an amount less its credit (what is still owed, i32; less than nothing owes some back), saturating
fn less(a: u32, credit: u32) -> u32 { let c = bitcast<i32>(credit); if (c <= 0i) { return select(0xffffffffu, a + u32(-c), a <= 0xffffffffu - u32(-c)); } return select(0u, a - u32(c), a > u32(c)); }
fn less64(a: vec2u, credit: u32) -> vec2u {
  let c = bitcast<i32>(credit);
  if (c <= 0i) { return add64(a, vec2u(u32(-c), 0u)); }
  if (lt64(a, vec2u(u32(c), 0u))) { return vec2u(0u); }
  return sub64(a, vec2u(u32(c), 0u));
}
fn w(run: u32, t: u32) -> u32 { return run * ${TILES}u + t; }
@compute @workgroup_size(256) fn main(@builtin(global_invocation_id) g: vec3u, @builtin(num_workgroups) n: vec3u) {
  let t = flat(g, n);
  if (t >= ${TILES}u || W[w(${W_.land}u, t)] == 0u) { return; }
  var green = vec2u(0u); var dead = 0u; var prey = vec3u(0u); var top = vec3u(0u); var tc = vec3u(0u);
  for (var q = 0u; q < 4u; q++) {
    let c = cellOf(t, q); let ce = c * ${CENW}u; let s = c * ${STW}u;
    // green in 1/8 mg, 64-bit: a cell's layer holds more than 2^32 of them past 95 g/m2
    for (var l = 0u; l < 2u; l++) { green = add64(green, less64(r64(ce + ${CEN.lam}u + 2u * l), st[s + ${ST.credit}u + l])); }
    dead = dead + less(div64s(r64(ce + ${CEN.lit + 2 * LC.standing}u), 1000u), st[s + ${ST.credit}u + 2u]);
    for (var p = 0u; p < 3u; p++) {
      prey[p] = prey[p] + less(sat32(r64(ce + ${CEN.prey}u + 2u * p)), st[s + ${ST.credit}u + 3u + p]);
      let tp = atomicLoad(&cen[ce + ${CEN.top}u + p]);
      if (tp != 0u && tp > top[p]) { top[p] = tp; tc[p] = c; }
    }
  }
  let garea = W[w(${W_.garea}u, t)];
  var fg = 0u; var fd = 0u;
  if (garea > 0u) {
    // Q16 g/m2: green / 8 mg x 65536 over the area in milli-m2
    let g13 = vec2u(green.x << 13u, (green.y << 13u) | (green.x >> 19u));
    fg = select(divw(g13.y, g13.x, garea).x, 0xffffffffu, g13.y >= garea || (green.y >> 19u) > 0u);
    fd = div64s(mul64(dead, 65536u), garea);
  }
  W[w(${W_.fg}u, t)] = fg; W[w(${W_.fd}u, t)] = fd;
  wrote[t * ${WROTE}u] = fg; wrote[t * ${WROTE}u + 1u] = fd;
  for (var p = 0u; p < 3u; p++) {
    W[w(${W_.icrow}u + p, t)] = prey[p]; wrote[t * ${WROTE}u + 2u + p] = prey[p];
    var key = 0xffffffffu;
    if (top[p] != 0u) { key = (tc[p] << 16u) | (top[p] & 0xffffu); }
    W[w(${W_.tcrow}u + p, t)] = key;
  }
}`;

// Every word of a buffer set to NONE. Bindings: buf, P (n).
export const SMALLS_NONE = /* wgsl */ `
struct Params { n: u32, a: u32, b: u32, c: u32 }
@group(0) @binding(0) var<storage, read_write> buf: array<u32>;
@group(0) @binding(1) var<uniform> P: Params;
${FLAT}
@compute @workgroup_size(256) fn main(@builtin(global_invocation_id) g: vec3u, @builtin(num_workgroups) n: vec3u) {
  let i = flat(g, n);
  if (i < P.n) { buf[i] = 0xffffffffu; }
}`;

export { CELL_MM, CTL };
