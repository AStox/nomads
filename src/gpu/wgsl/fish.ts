// The fish's law in WGSL (src/gpu/fish.ts drives it; docs/research/animal-constants.md sec. 13). Every fish in the
// island's water is one object of store kind "fish": its place, its kind and sex, when it was born and its length.
// The law runs once an island day; everything it does is integer arithmetic, and where many fish share one thing (a
// cell's food, a body of water's deaths, a tile's catch) they add into it with integer atomics, whose sums are the
// same in any order.
//
// The water is the island's 75 m cells (src/sim/waters.ts lays them out): each wet cell's kind (the inshore sea, a
// lake, a stream) and the body of water it is part of, joined cell to cell and down the streams to their mouths;
// where a stream cell drains to; the nearest stream cell of the same body (where trout go to spawn); and which of its
// 8 x 8 squares of 9.375 m hold water, so a fish always stands in water.
//
// A day, in order (each line one pass over the fish):
// - front: each fish's growth if it had all the food it could eat (its length a step further along its von
//   Bertalanffy curve for the water it is in), asked of its cell's food; its chance of dying today at Lorenzen's
//   mortality for its weight, and its share of the birds' catch on its tile since the last law, both added up by
//   body of water.
// - fate: the birds' catch, whole fish drawn by each tile's share eaten; the day's other deaths, Lorenzen's less what
//   the birds took of the same body (his rates count all of a stock's natural deaths, predators' too); growth by the
//   share of what it asked that its cell's food covers; moving within its own body of water, down the stream when
//   its reach runs dry or when a trout of a smolt's length goes to sea in spring; on the recruits' day each grown
//   female's young of the year that live to be counted, drawn exactly; and the census and each tile's fish by mass.
// Births go through the store's births (store.ts): the young are laid at their kind's length where they were spawned.
import { N } from "../../terrain/grid";
import { FIXED } from "./fixed";
import { RAND } from "./rand";
import { CELL_MM, CELLS } from "./index";

// ---------- layouts shared with the host and the oracle ----------
export const TW = 128, T = TW * TW, TILE_MM = 150000, NONE = 0xffffffff;
// A cell's 8 x 8 squares, each SUB_MM a side.
export const SUB = 8, SUB_MM = CELL_MM / SUB;
if (CELL_MM * 2 !== TILE_MM || SUB_MM % 1 !== 0) throw new Error("a tile is two cells a side and a cell eight squares");
// The kinds of fish, a kind's number in its sp field (16 added for a female).
export const FS = { trout: 0, perch: 1, roach: 2, pike: 3, eel: 4 } as const;
export const NFS = 5;
// The kinds of water a cell holds (none for land and the open sea).
export const KIND = { none: 0, sea: 1, lake: 2, stream: 3 } as const;
// The kind's fields after x and y: sp, the kind of fish plus 16 for a female; born, the tick it was laid (mod 2^32);
// len, its total length in micrometres.
export const FIELDS = ["sp", "born", "len"] as const;
export const F = { x: 0, y: 1, sp: 2, born: 3, len: 4 } as const;
// The cells' tables, runs of CELLS words: kb, the cell's kind plus 4 x its body of water; down, the cell a stream cell
// drains to (NONE for none); nurse, the nearest stream cell of the same body (NONE where the body has none); m0 and m1,
// which of its 64 squares hold water (bit k of the square in row k / 8, column k % 8; m1 the second 32).
export const CT_ = { kb: 0, down: 1, nurse: 2, m0: 3, m1: 4 } as const;
export const CT_RUNS = 5;
// The bodies of water the sums are kept for.
export const BODIES = 4096;
// The constants buffer: KW words a kind of fish (each a u32; Q16.16 unless said; a run of three is by the water's
// kind, sea, lake, stream), then the global words, then the step's parameters.
// lna, b: ln a and b of its weight in g from its length in cm, W = a L^b; linf, its length at infinity by water, um;
// keep, e^(-K dt) by water, the share of the way to linf a step leaves; lmat, the length it matures at, um; eggs, eggs a
// g of female; juv, Lorenzen's mortality summed from egg to recruit by water (Q16, the exponent of the young's
// survival at a full share of food); lrec, the recruits' length, um; smolt, a trout's length to go to sea, um; moves,
// the steps of a cell a fish takes a day by water (a count); home, the kinds of water it lives in (bit k for KIND k);
// nurse, 1 where its young are laid in the body's nearest stream rather than where it stands.
export const KW = 20;
export const K = { lna: 0, b: 1, linf: 2, keep: 5, lmat: 8, eggs: 9, juv: 10, lrec: 13, smolt: 14, moves: 15, home: 18, nurse: 19 } as const;
// Global words: mu and mb, Lorenzen's mortality at 1 g, a year, and its weight exponent, by water (Q16, mb negative,
// as i32); pace, a step's share of a year (Q16); run, the most cells a fish swims down a stream in a step; and for
// laying the island's first fish: days, the steps in a year; year, the ticks in a year; oldest, the oldest age laid.
export const GK = NFS * KW;
export const G = { mu: 0, mb: 3, pace: 6, run: 7, days: 8, year: 9, oldest: 10 } as const;
export const PO = GK + 12, KP_WORDS = PO + 4;
export const P = { tick: 0, seed: 1, flags: 2 } as const;
// The step's events: the recruits' day (the young of the year counted, the eels of a silver eel's length leaving for
// the sea), and the smolts' run in spring.
export const FLAG = { recruit: 1, smolt: 2 } as const;
// The sums, an atomic buffer: each cell's food asked (cg), each body's natural deaths and catch expected (cg), each
// tile's fish by mass after the law (g), and the census: fish of each kind, their mass (g), and the mass in each kind
// of water (g).
export const S_ = { sum: 0, d: CELLS, e: CELLS + BODIES, ftn: CELLS + 2 * BODIES, cen: CELLS + 2 * BODIES + T } as const;
export const CEN = { n: 0, g: NFS, kind: 2 * NFS } as const;
export const CEN_WORDS = 2 * NFS + 3;
export const S_WORDS = S_.cen + CEN_WORDS;
// Random streams.
export const STREAM = { fate: 0x46490001, birth: 0x46490002, start: 0x46490003 } as const;

const ACC = (cap: number) => /* wgsl */ `
const CAP = ${cap}u; const T = ${T}u; const TW = ${TW}u; const TMM = ${TILE_MM}u; const NONE = 0xffffffffu;
const NC = ${N}u; const CELLS = ${CELLS}u; const CMM = ${CELL_MM}u; const SMM = ${SUB_MM}u; const SUBN = ${SUB}u;
const KW = ${KW}u; const GK = ${GK}u; const PO = ${PO}u;
fn sat_sub(a: u32, b: u32) -> u32 { if (a > b) { return a - b; } return 0u; }
fn mulq(a: u32, q: u32) -> u32 { let p = mul64(a, q); if (p.y >= 65536u) { return NONE; } return (p.x >> 16u) | (p.y << 16u); }
fn muldiv(a: u32, b: u32, c: u32) -> u32 { if (c == 0u) { return 0u; } let p = mul64(a, b); if (p.y >= c) { return NONE; } return divw(p.y, p.x, c).x; }
fn bern16(p: u32) -> bool { let r = next32(); return p >= 65536u || r < (p << 16u); }
fn cell_of(x: u32, y: u32) -> u32 { return min(y / CMM, NC - 1u) * NC + min(x / CMM, NC - 1u); }
fn tile_of(x: u32, y: u32) -> u32 { return min(y / TMM, TW - 1u) * TW + min(x / TMM, TW - 1u); }
fn kk(s: u32, w: u32) -> u32 { return KP[s * KW + w]; }
fn kg(w: u32) -> u32 { return KP[GK + w]; }
fn pp(w: u32) -> u32 { return KP[PO + w]; }
fn ct(run: u32, c: u32) -> u32 { return CT[run * CELLS + c]; }
// A fish's weight, g (Q16), at a length in um: e^(ln a + b ln L), L in cm.
fn massq(s: u32, len: u32) -> u32 {
  let l = bitcast<i32>(muldiv(len, 65536u, 10000u));
  if (l <= 0i) { return 0u; }
  return bitcast<u32>(qexp(qadd(bitcast<i32>(kk(s, ${K.lna}u)), qmul(bitcast<i32>(kk(s, ${K.b}u)), qln(l)))));
}
// Its length a step further along its curve in water of kind k (1 to 3).
fn grown(s: u32, k: u32, len: u32) -> u32 {
  let li = kk(s, ${K.linf}u + k - 1u);
  if (len >= li) { return len; }
  return li - mulq(li - len, kk(s, ${K.keep}u + k - 1u));
}
// Its chance of dying in a step (Q16) at Lorenzen's rate for its weight w (g, Q16) in water of kind k.
fn dies(k: u32, w: u32) -> u32 {
  if (w == 0u) { return 65536u; }
  let m = qmul(bitcast<i32>(kg(${G.mu}u + k - 1u)), qexp(qmul(bitcast<i32>(kg(${G.mb}u + k - 1u)), qln(bitcast<i32>(w)))));
  return 65536u - bitcast<u32>(qexp(-qmul(m, bitcast<i32>(kg(${G.pace}u)))));
}
// A point in water in cell c: a square of it that holds water, drawn evenly, and a point in that square.
fn place(c: u32) -> vec2u {
  let m0 = ct(${CT_.m0}u, c); let m1 = ct(${CT_.m1}u, c);
  let n = countOneBits(m0) + countOneBits(m1);
  var sq = (SUBN / 2u) * SUBN + SUBN / 2u;
  if (n > 0u) {
    var k = unif(n);
    for (var q = 0u; q < 64u; q++) {
      let on = select((m1 >> ((q - 32u) & 31u)) & 1u, (m0 >> (q & 31u)) & 1u, q < 32u);
      if (on == 1u) { if (k == 0u) { sq = q; break; } k = k - 1u; }
    }
  }
  let dx = unif(SMM); let dy = unif(SMM);
  return vec2u((c % NC) * CMM + (sq % SUBN) * SMM + dx, (c / NC) * CMM + (sq / SUBN) * SMM + dy);
}
`;
const BODY = /* wgsl */ `
fn fo(f: u32) -> u32 { return (f + 1u) * CAP; }
`;
const HEAD = (cap: number) => FIXED + RAND + ACC(cap);
const decl = (bs: [string, "r" | "rw" | "a"][]) =>
  bs.map(([n, m], i) => `@group(0) @binding(${i}) var<storage, ${m === "r" ? "read" : "read_write"}> ${n}: array<${m === "a" ? "atomic<u32>" : "u32"}>;`).join("\n");
const MAIN = (n: string, body: string) => /* wgsl */ `
@compute @workgroup_size(256) fn main(@builtin(global_invocation_id) gid: vec3u, @builtin(num_workgroups) nwg: vec3u) {
  let i = gid.x + gid.y * nwg.x * 256u;
  if (i >= ${n}) { return; }
${body}
}`;
// What both passes know of a live fish: its cell and that cell's kind and body, its kind of fish, its length and
// weight, its tile, its chance of dying at Lorenzen's rate and its tile's share eaten.
const KNOW = /* wgsl */ `
  let x = b[fo(${F.x}u) + i]; let y = b[fo(${F.y}u) + i];
  let c = cell_of(x, y); let kb = ct(${CT_.kb}u, c);
  let kind = kb & 3u; let body = min(kb >> 2u, ${BODIES - 1}u);
  let spw = b[fo(${F.sp}u) + i]; let s = spw & 15u;
  let len = b[fo(${F.len}u) + i];
  let w = massq(s, len);
  let t = tile_of(x, y);
  var pd = 65536u;
  if (kind != 0u) { pd = dies(kind, w); }
  var eaten = 0u;
  let ft = FT[t]; let ate = EAT[t];
  if (ft > 0u) { eaten = select(muldiv(ate, 65536u, ft), 65536u, ate >= ft); }
`;

// ---------- front: what each fish asks of its cell, and the deaths each body expects ----------
// Bindings: b, CT, KP, S (atomic), FT, EAT. Dispatched over the room.
export function fishFront(cap: number) {
  return `${HEAD(cap)}${decl([["b", "r"], ["CT", "r"], ["KP", "r"], ["S", "a"], ["FT", "r"], ["EAT", "r"]])}
${BODY}
${MAIN("CAP", /* wgsl */ `
  if ((b[i] & 1u) == 0u) { return; }
${KNOW}
  if (kind == 0u) { return; }
  let wcg = muldiv(w, 100u, 65536u);
  let dw = sat_sub(massq(s, grown(s, kind, len)), w);
  if (dw > 0u) { atomicAdd(&S[${S_.sum}u + c], muldiv(dw, 100u, 65536u) + 1u); }
  atomicAdd(&S[${S_.d}u + body], mulq(wcg, pd));
  atomicAdd(&S[${S_.e}u + body], mulq(wcg, eaten));
`)}`;
}

// ---------- fate: the catch, the day's deaths, growth, moving, the young, the census ----------
// Bindings: b, CT, FOOD, KP, S (atomic), FT, EAT, Q (each fish's young, cleared here). Dispatched over the room.
export function fishFate(cap: number) {
  return `${HEAD(cap)}${decl([["b", "rw"], ["CT", "r"], ["FOOD", "r"], ["KP", "r"], ["S", "a"], ["FT", "r"], ["EAT", "r"], ["Q", "rw"]])}
${BODY}
// The share of what a cell's fish ask that its food covers (Q16); none where it is dry.
fn share(c: u32) -> u32 {
  let f = FOOD[c]; let a = atomicLoad(&S[${S_.sum}u + c]);
  if (f == 0u) { return 0u; }
  if (a <= f) { return 65536u; }
  return muldiv(f, 65536u, a);
}
${MAIN("CAP", /* wgsl */ `
  Q[i] = 0u;
  if ((b[i] & 1u) == 0u) { return; }
${KNOW}
  let flags = pp(${P.flags}u);
  rinit(pp(${P.seed}u), ${STREAM.fate}u, i, pp(${P.tick}u));
  // out of every water the law knows (a cell the water left since): gone
  if (kind == 0u) { b[i] = b[i] & ~1u; return; }
  // the birds' catch on its tile
  let caught = bern16(eaten);
  if (caught) { b[i] = b[i] & ~1u; return; }
  // the day's other deaths: Lorenzen's, less the share of them the birds took of its body of water
  let dsum = atomicLoad(&S[${S_.d}u + body]); let esum = atomicLoad(&S[${S_.e}u + body]);
  var keep = 65536u;
  if (dsum > 0u) { keep = 65536u - min(65536u, muldiv(esum, 65536u, dsum)); }
  let died = bern16(mulq(pd, keep));
  if (died) { b[i] = b[i] & ~1u; return; }
  // a silver eel leaves for the sea on the recruits' day
  if (s == ${FS.eel}u && (flags & ${FLAG.recruit}u) != 0u && len >= kk(s, ${K.lmat}u)) { b[i] = b[i] & ~1u; return; }
  // growth by its cell's share
  let pot = grown(s, kind, len);
  let nl = len + mulq(pot - len, share(c));
  // moving: down the stream where its reach is dry or a smolt goes to sea; else its day's steps within its own water
  var at = c;
  let smolt = s == ${FS.trout}u && kind == ${KIND.stream}u && (flags & ${FLAG.smolt}u) != 0u && nl >= kk(s, ${K.smolt}u);
  if (FOOD[c] == 0u || smolt) {
    for (var r = 0u; r < kg(${G.run}u); r++) {
      let d = ct(${CT_.down}u, at);
      if (d == NONE) { break; }
      at = d;
      if ((ct(${CT_.kb}u, at) & 3u) != ${KIND.stream}u) { break; }
      if (!smolt && FOOD[at] > 0u) { break; }
    }
    // stranded where the water left it
    if (FOOD[at] == 0u) { b[i] = b[i] & ~1u; return; }
  } else {
    let home = kk(s, ${K.home}u);
    for (var m = 0u; m < kk(s, ${K.moves}u + kind - 1u); m++) {
      let d = unif(9u);
      if (d == 4u) { continue; }
      let nx = i32(at % NC) + i32(d % 3u) - 1i; let ny = i32(at / NC) + i32(d / 3u) - 1i;
      if (nx < 0i || ny < 0i || nx >= i32(NC) || ny >= i32(NC)) { continue; }
      let c2 = u32(ny) * NC + u32(nx); let kb2 = ct(${CT_.kb}u, c2);
      if ((kb2 & 3u) != 0u && (kb2 >> 2u) == (kb >> 2u) && FOOD[c2] > 0u && ((home >> (kb2 & 3u)) & 1u) == 1u) { at = c2; }
    }
  }
  var nx = x; var ny = y;
  if (at != c) { let p = place(at); nx = p.x; ny = p.y; b[fo(${F.x}u) + i] = nx; b[fo(${F.y}u) + i] = ny; }
  b[fo(${F.len}u) + i] = nl;
  // the young of the year that live to be counted: a grown female's eggs, each living from egg to recruit with the
  // chance Lorenzen's rates give at the share of food where they are laid
  if ((flags & ${FLAG.recruit}u) != 0u && (spw & 16u) != 0u && nl >= kk(s, ${K.lmat}u) && kk(s, ${K.eggs}u) > 0u) {
    var pc = at;
    if (kk(s, ${K.nurse}u) == 1u) { pc = ct(${CT_.nurse}u, at); }
    if (pc != NONE) {
      let sh = share(pc);
      if (sh > 0u) {
        let pk = (ct(${CT_.kb}u, pc) & 3u) - 1u;
        let live = bitcast<u32>(qexp(-qdiv(bitcast<i32>(kk(s, ${K.juv}u + pk)), bitcast<i32>(sh))));
        let eggs = mul64(massq(s, nl), kk(s, ${K.eggs}u)).y;
        Q[i] = binom(eggs, min(live, 65535u) << 16u);
      }
    }
  }
  // the census and the tile's fish by mass
  let ng = massq(s, nl) >> 16u;
  let nk = ct(${CT_.kb}u, at) & 3u;
  atomicAdd(&S[${S_.cen + CEN.n}u + s], 1u);
  atomicAdd(&S[${S_.cen + CEN.g}u + s], ng);
  atomicAdd(&S[${S_.cen + CEN.kind}u + nk - 1u], ng);
  atomicAdd(&S[${S_.ftn}u + tile_of(nx, ny)], ng);
`)}`;
}

// ---------- the young ----------
// The parent's initialization of each young (store.ts births, extra buffers KP and CT): its kind, a sex drawn even,
// laid at its kind's recruits' length, now, at a point in water of the cell it was spawned in (where its mother
// stands, or for a trout the nearest stream of her water). Young past the kind's room are not born.
export const BIRTH_INIT = /* wgsl */ `
  let ps = parent_sp(parent) & 15u;
  let now = KP[PO + ${P.tick}u];
  rinit(KP[PO + ${P.seed}u], ${STREAM.birth}u, slot, now);
  let r = next32();
  child_set_sp(slot, ps | select(0u, 16u, r < 0x80000000u));
  child_set_born(slot, now);
  child_set_len(slot, KP[ps * KW + ${K.lrec}u]);
  var c = cell_of(parent_x(parent), parent_y(parent));
  if (KP[ps * KW + ${K.nurse}u] == 1u) { c = CT[${CT_.nurse}u * CELLS + c]; }
  if (c != NONE) { let p = place(c); child_set_x(slot, p.x); child_set_y(slot, p.y); }
`;
export const birthHead = (cap: number) => FIXED + RAND + ACC(cap);
// The island's first fish (store.ts bear, a row for each cell and kind of fish, row = cell x NFS + kind; extra
// buffers KP and CT, the step's tick the start's): each of an age from 1, one more year with a chance of a half up to
// the oldest, at its kind's length for that age in its water (its recruits' length carried that many years along its
// curve), half of them female, born that many years and part of one before now, at a point in water of its cell.
export const START_INIT = /* wgsl */ `
  let c = parent / ${NFS}u; let s = parent % ${NFS}u;
  let now = KP[PO + ${P.tick}u];
  rinit(KP[PO + ${P.seed}u], ${STREAM.start}u, slot, now);
  var age = 1u;
  loop {
    if (age >= KP[GK + ${G.oldest}u]) { break; }
    let r = next32();
    if (r >= 0x80000000u) { break; }
    age = age + 1u;
  }
  let wk = CT[${CT_.kb}u * CELLS + c] & 3u;
  let li = KP[s * KW + ${K.linf}u + wk - 1u]; let rec = min(KP[s * KW + ${K.lrec}u], li);
  var gap = li - rec;
  for (var d = 0u; d < (age - 1u) * KP[GK + ${G.days}u]; d++) { gap = mulq(gap, KP[s * KW + ${K.keep}u + wk - 1u]); }
  child_set_len(slot, li - gap);
  let r = next32();
  child_set_sp(slot, s | select(0u, 16u, r < 0x80000000u));
  let yr = KP[GK + ${G.year}u];
  let back = unif(yr);
  child_set_born(slot, now - age * yr - back);
  let p = place(c); child_set_x(slot, p.x); child_set_y(slot, p.y);
`;

// ---------- the birds' side: the fish each tile holds for them, and what they took ----------
// Each tile's fish for the birds to take, g: what the last law left there less what they have eaten since. Bindings:
// FT, EAT, W (the animals' tile buffer; the fish's run at word at).
export const fishFeed = (at: number) => /* wgsl */ `
@group(0) @binding(0) var<storage, read> FT: array<u32>;
@group(0) @binding(1) var<storage, read> EAT: array<u32>;
@group(0) @binding(2) var<storage, read_write> W: array<u32>;
${MAIN(`${T}u`, /* wgsl */ `
  let f = FT[i]; let e = EAT[i];
  W[${at}u + i] = select(0u, f - e, f > e);
`)}`;
// What the birds took of each tile's fish in a step, g, added to what they have eaten since the last law. Bindings: A
// (the animals' atomic buffer; the fish eaten by tile at word at), EAT.
export const fishAte = (at: number) => /* wgsl */ `
@group(0) @binding(0) var<storage, read> A: array<u32>;
@group(0) @binding(1) var<storage, read_write> EAT: array<u32>;
${MAIN(`${T}u`, /* wgsl */ `
  let e = EAT[i] + A[${at}u + i];
  EAT[i] = select(e, 0xffffffffu, e < EAT[i]);
`)}`;
