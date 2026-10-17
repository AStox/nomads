// What lies near a burning bed taking its heat and its brands, a tick at a time on the GPU (src/gpu/fire.ts drives it;
// plan docs/plans/2026-10-14-001-refactor-gpu-object-world-plan.md, Unit 12; docs/research/fire-constants.md secs. 4,
// 6, 7, 28, 30, 36 and 37). The beds say, at each of a landing's looks, how each of them blazes: on the GPU the beds'
// law (wgsl/beds.ts) writes it here just before this law runs, and off it the CPU does (src/sim/spread.ts
// blazeWords); every fuel object within a blaze's reach is a receiver (spread.ts receiverWords), its parts each holding
// the heat it has taken toward lighting. A lane a receiver goes through the looks in order:
// - each part takes the flame's own flux where the flame, leaning in the wind, stands over it, and elsewhere the
//   radiant share of what the bed gives off from the middle of its flame, no nearer than the heap's edge (spread.ts
//   fluxOn);
// - it heats by what it nets of that flux over the look and lights once it holds what lighting needs (combustion.ts
//   expose and needs: heat >= (thin^-4 + (net / deep)^4)^(-1/4), taken as (heat / thin)^4 + (heat net / deep)^4 >= 1);
// - a receiver not lit by heat takes the brands landing on its footprint, a mean from each blaze by Albini's lofting
//   (spread.ts landing, its bisection done over whole centimetres); the count landing is drawn from Poisson by
//   Philox keyed by the receiver, the tick and the look, and TOGETHER or more light its driest fine fuel by the
//   NFDRS's odds, drawn next from the same stream.
// The first look a receiver lights ends its tick: which look, which bed lit it and which parts are alight come back
// with the tick's landing, and the CPU makes the thing a bed of its own (src/sim/ecology.ts fire).
//
// Integer throughout, units by word below; no step depends on invocation order, so every GPU gives the same words, and
// the TypeScript twin (src/gpu/fire.ts receive) gives them too.
import { FIXED } from "./fixed";
import { RAND } from "./rand";

// Brands light fine fuel only landing several together: four did in R26's test, where one never did (fire-constants
// sec. 6, 30b).
export const TOGETHER = 4;
// Seconds a look is: as often as a bed steps (fire-constants sec. 28).
export const LOOK_S = 10;
// The stream the brands draw from: one a look, the look added to it [design].
export const STREAM = 0x46495245; // "FIRE"
// Bounds that keep every product inside 32 bits [design]: no blaze reaches a receiver farther than LIM cm along either
// axis (655 m: a brand lofted the most a brand can be, 117 m (spread.ts BURNOUT), carried by the strongest of the
// island's winds lands nearer [gap: past it, none]); a flame, its lean, its base and its heap are under FLAME cm (82 m);
// the reach of a bed's heat under REACH cm (164 m: a bed giving off 10^4 MW reaches 150 m); no flux on a part over
// INTO (1,024 kW/m2, five times a flame's contact on a grass blade) and no part loses more than it; no part holds more
// than HEAT (Q8 kJ/m2, 4.2 x 10^6 kJ/m2, a hundred times what lights the thickest log).
export const LIM = 1 << 16, FLAME = 1 << 13, REACH = 1 << 14, INTO = 1 << 26, HEAT = 1 << 30;
// The wind's way as a unit vector to 13 bits.
export const DIR_BITS = 13;
// kW/m2: nothing lights under this (combustion.ts LEAST, sec. 1), Q16.
export const LEAST_Q = 12 << 16;
// Parts a receiver has at most [design: a tree has five; a shelter or a pile of many kinds of piece more].
export const PARTS = 32;
// A receiver's status word: lit in bit 31, the look in bits 24 to 30, the bed's index in bits 0 to 23.
export const LIT = 0x80000000, BY = 0xffffff;
// A blaze's place where a bed doesn't blaze at a look (the beds' law, wgsl/beds.ts): so far west that no receiver is
// within LIM of it.
export const NOWHERE = 0xc0000000;

// A blaze at a look, BW words: its place (cm east and south), the wind's way (Q13), its flame's lean along the wind and
// height up (cm), the flame's base's radius and the heap's (cm), the flame's height (cm), the radiant share of what it
// gives off over 4 pi (W), a flame's own radiation (Q16 kW/m2), its heat's reach (cm), the bed's index, the brands
// landing for each cm2 of footprint across the base times cm of lofting (Q32), the highest a brand lands from alive
// (cm), and the wind aloft (wind: 0 for the head-height wind at every height, 1 for the log profile; K the head-height
// wind over the brand's fall speed, Q16; the plants' height V, cm; the profile's displacement S and roughness D, Q16 cm;
// one over the profile's log at head height, Q16); and how far downwind its brands land (cm), which this law doesn't read
// (the CPU looks that far for what they might land on).
export const B = { x: 0, y: 1, dx: 2, dy: 3, tx: 4, tz: 5, rb: 6, heap: 7, lf: 8, qr: 9, fr: 10, reach: 11, bed: 12, gb: 13, alive: 14, wind: 15, k: 16, v: 17, s: 18, d: 19, inv: 20, far: 21 } as const;
export const BW = 22;
// A receiver, RW words: its place (cm), half its width (cm), where its parts start and how many, its tinder's part (or
// NONE) and the odds brands light it (Q16), and its identity (src/sim/spread.ts keyOf).
export const R = { x: 0, y: 1, half: 2, p0: 3, np: 4, tinder: 5, odds: 6, key: 7 } as const;
export const RW = 8;
// A part, PW words: how high it stands from and to (cm), a flame's contact flux on it (Q16 kW/m2), what it loses of any
// flux (Q16 kW/m2), the heat to bring it through to lighting (thin, Q8 kJ/m2) and its face's (deep, Q8 kJ/m2 times
// kW/m2), whether it can light at all (not drowned), and the heat it holds as the tick begins (Q8 kJ/m2).
export const PT = { lo: 0, hi: 1, contact: 2, loss: 3, thin: 4, deep: 5, ok: 6, heat: 7 } as const;
export const PW = 8;
export const NONE = 0xffffffff;

// The law. Bindings: input (u32: the looks' starts, then the blazes, the receivers and the parts), acc (i32, a word a
// part: the flux on it this look), out (the landing's copy: a status word a receiver from P.at, then a part's heat with
// its lit bit in bit 31), P (at, receivers, looks, tick, seed, where the blazes, receivers and parts start).
export function fireReceive() {
  return /* wgsl */ `
@group(0) @binding(0) var<storage, read> inp: array<u32>;
@group(0) @binding(1) var<storage, read_write> acc: array<i32>;
@group(0) @binding(2) var<storage, read_write> out: array<u32>;
@group(0) @binding(3) var<uniform> P: array<vec4u, 2>;
${FIXED}
${RAND}
fn flat(g: vec3u, n: vec3u) -> u32 { return g.x + g.y * n.x * 64u; }
fn bw(j: u32, f: u32) -> i32 { return bitcast<i32>(inp[P[1].y + j * ${BW}u + f]); }
fn rw(r: u32, f: u32) -> u32 { return inp[P[1].z + r * ${RW}u + f]; }
fn pw(p: u32, f: u32) -> u32 { return inp[P[1].w + p * ${PW}u + f]; }
fn sq(v: i32) -> u32 { return bitcast<u32>(v * v); }

// The square of the least distance between the flame's axis, from its base to its tip (tx, tz) along the wind and up,
// and an upright span at a along the wind from lo to hi (spread.ts apart).
fn along(px: i32, pz: i32, tx: i32, tz: i32) -> u32 {
  let l2 = tx * tx + tz * tz;
  var s = 0u;
  if (l2 > 0i) {
    let dot = px * tx + pz * tz;
    if (dot >= l2) { s = 65536u; } else if (dot > 0i) { s = divw(bitcast<u32>(dot) >> 16u, bitcast<u32>(dot) << 16u, bitcast<u32>(l2)).x; }
  }
  let qx = px - ((i32(s) * tx) >> 16u);
  let qz = pz - ((i32(s) * tz) >> 16u);
  return sq(qx) + sq(qz);
}
fn up(px: i32, pz: i32, a: i32, lo: i32, hi: i32) -> u32 { return sq(px - a) + sq(pz - clamp(pz, lo, hi)); }
fn apart2(tx: i32, tz: i32, a: i32, lo: i32, hi: i32) -> u32 {
  if (tx > 0i && a >= 0i && a <= tx) { let z = (a * tz) / tx; if (z >= lo && z <= hi) { return 0u; } }
  if (tx == 0i && a == 0i && hi >= 0i && lo <= tz) { return 0u; }
  return min(min(along(a, lo, tx, tz), along(a, hi, tx, tz)), min(up(0i, 0i, a, lo, hi), up(tx, tz, a, lo, hi)));
}
// The flux on a part of a receiver at (a, c) from blaze j (Q16 kW/m2).
fn flux_on(j: u32, p: u32, a: i32, c: i32) -> i32 {
  let lo = bitcast<i32>(pw(p, ${PT.lo}u)); let hi = bitcast<i32>(pw(p, ${PT.hi}u));
  let tx = bw(j, ${B.tx}u); let tz = bw(j, ${B.tz}u); let rb = bw(j, ${B.rb}u);
  if (bw(j, ${B.lf}u) > 0i && abs(c) < rb) {
    if (apart2(tx, tz, a, lo, hi) <= sq(rb) - sq(c)) { return qadd(bitcast<i32>(pw(p, ${PT.contact}u)), bw(j, ${B.fr}u)); }
  }
  let z = clamp(tz >> 1u, lo, hi);
  let heap = bw(j, ${B.heap}u);
  var r2 = max(sq(a - (tx >> 1u)) + sq(c) + sq(z - (tz >> 1u)), sq(heap));
  if (r2 == 0u) { r2 = 1u; }
  let q = mul64(bitcast<u32>(bw(j, ${B.qr}u)), 655360u);
  if (q.y >= r2) { return 0x7fffffffi; }
  return bitcast<i32>(min(divw(q.y, q.x, r2).x, 0x7fffffffu));
}
// How far downwind, cm, a brand lofted z cm lands, carried by the wind at that height while it falls (spread.ts flight).
fn flight(j: u32, z: i32) -> i32 {
  var kf = bw(j, ${B.k}u);
  if (bw(j, ${B.wind}u) != 0i) {
    let zz = max(max(z, 5i), bw(j, ${B.v}u));
    let f = qmul(max(0i, qln(qdiv((zz << 16u) - bw(j, ${B.s}u), bw(j, ${B.d}u)))), bw(j, ${B.inv}u));
    kf = qmul(kf, f);
  }
  let p = mul64(bitcast<u32>(z), bitcast<u32>(kf));
  return bitcast<i32>((p.x >> 16u) | (p.y << 16u));
}
// The height a brand landing x cm downwind was lofted to: the highest whole cm whose flight falls short of x.
fn lofted(j: u32, x: i32) -> i32 {
  if (x <= 0i) { return 0i; }
  let alive = bw(j, ${B.alive}u);
  if (flight(j, alive) <= x) { return alive; }
  var lo = 0i; var hi = alive;
  while (lo < hi) { let mid = (lo + hi + 1i) >> 1u; if (flight(j, mid) < x) { lo = mid; } else { hi = mid - 1i; } }
  return lo;
}
// Whether a part holding heat (Q8) under a net flux (Q16, positive) has what lighting needs.
fn reaches(heat: u32, net: u32, thin: u32, deep: u32) -> bool {
  if (heat >= thin || thin == 0u || deep == 0u) { return true; }
  let x = divw(heat >> 16u, heat << 16u, thin).x;
  let p = mul64(heat, net);
  if (p.y >= deep) { return true; }
  let y = divw(p.y, p.x, deep).x;
  if (y >= 65536u) { return true; }
  let x2 = (x * x) >> 16u; let y2 = (y * y) >> 16u;
  return ((x2 * x2) >> 16u) + ((y2 * y2) >> 16u) >= 65536u;
}
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) g: vec3u, @builtin(num_workgroups) n: vec3u) {
  let r = flat(g, n);
  let at = P[0].x; let nr = P[0].y;
  if (r >= nr) { return; }
  let rx = bitcast<i32>(rw(r, ${R.x}u)); let ry = bitcast<i32>(rw(r, ${R.y}u)); let hw = bitcast<i32>(rw(r, ${R.half}u));
  let p0 = rw(r, ${R.p0}u); let np = rw(r, ${R.np}u); let tinder = rw(r, ${R.tinder}u);
  for (var p = p0; p < p0 + np; p++) { out[at + nr + p] = pw(p, ${PT.heat}u); }
  out[at + r] = 0u;
  for (var k = 0u; k < P[0].z; k++) {
    for (var p = p0; p < p0 + np; p++) { acc[p] = 0i; }
    var most = -1i; var by_heat = ${NONE}u; var mean = 0i; var most_b = 0i; var by_brand = ${NONE}u;
    for (var j = inp[k]; j < inp[k + 1u]; j++) {
      let ex = rx - bw(j, ${B.x}u); let ey = ry - bw(j, ${B.y}u);
      if (abs(ex) >= ${LIM}i || abs(ey) >= ${LIM}i) { continue; }
      let dx = bw(j, ${B.dx}u); let dy = bw(j, ${B.dy}u);
      let lim = bw(j, ${B.reach}u) + hw;
      if (abs(ex) <= lim && abs(ey) <= lim) {
        let d = i32(isqrt64(vec2u(sq(ex) + sq(ey), 0u)));
        if (d <= lim) {
          var a = 0i; var c = 0i;
          if (d > hw) {
            let a0 = (ex * dx + ey * dy) >> ${DIR_BITS}u; let c0 = (ey * dx - ex * dy) >> ${DIR_BITS}u;
            let num = bitcast<u32>(d - hw); let den = bitcast<u32>(d);
            a = i32((mag(a0) * num) / den); if (a0 < 0i) { a = -a; }
            c = i32((mag(c0) * num) / den); if (c0 < 0i) { c = -c; }
          }
          var sum = 0i;
          for (var p = p0; p < p0 + np; p++) { let f = flux_on(j, p, a, c); acc[p] = qadd(acc[p], f); sum = qadd(sum, f); }
          if (sum > most) { most = sum; by_heat = bitcast<u32>(bw(j, ${B.bed}u)); }
        }
      }
      let rb = bw(j, ${B.rb}u);
      if (hw > 0i && bw(j, ${B.gb}u) != 0i && rb > 0i && bw(j, ${B.lf}u) > 0i) {
        let a = (ex * dx + ey * dy) >> ${DIR_BITS}u; let c = (ey * dx - ex * dy) >> ${DIR_BITS}u;
        let over = min(c + hw, rb) - max(c - hw, -rb);
        if (over > 0i) {
          let dz = lofted(j, a + hw) - lofted(j, a - hw);
          if (dz > 0i) {
            let q = mul64(bitcast<u32>(bw(j, ${B.gb}u)), bitcast<u32>(over * dz));
            var m = 0x7fffffffi;
            if (q.y < 0x8000u) { m = bitcast<i32>((q.x >> 16u) | (q.y << 16u)); }
            mean = qadd(mean, m);
            if (m > most_b) { most_b = m; by_brand = bitcast<u32>(bw(j, ${B.bed}u)); }
          }
        }
      }
    }
    // the look's heat: each part nets what comes in, less what it loses, over the look
    var lit = false;
    for (var p = p0; p < p0 + np; p++) {
      let into = min(acc[p], ${INTO}i);
      let net = into - bitcast<i32>(pw(p, ${PT.loss}u));
      let heat = u32(clamp(i32(out[at + nr + p] & 0x7fffffffu) + ((net * ${LOOK_S}i) >> 8u), 0i, ${HEAT}i));
      var h = heat;
      if (into >= ${LEAST_Q}i && pw(p, ${PT.ok}u) != 0u && net > 0i && reaches(heat, bitcast<u32>(net), pw(p, ${PT.thin}u), pw(p, ${PT.deep}u))) { h = h | ${LIT}u; lit = true; }
      out[at + nr + p] = h;
    }
    if (lit) { out[at + r] = ${LIT}u | (k << 24u) | (by_heat & ${BY}u); return; }
    // the look's brands, landing together on its tinder
    if (mean > 0i && tinder != ${NONE}u) {
      rinit(P[1].x, ${STREAM}u + k, rw(r, ${R.key}u), P[0].w);
      if (qpoisson(mean) >= ${TOGETHER}u) {
        if (qunif() < bitcast<i32>(rw(r, ${R.odds}u))) {
          out[at + nr + p0 + tinder] = out[at + nr + p0 + tinder] | ${LIT}u;
          out[at + r] = ${LIT}u | (k << 24u) | (by_brand & ${BY}u);
          return;
        }
      }
    }
  }
}`;
}
