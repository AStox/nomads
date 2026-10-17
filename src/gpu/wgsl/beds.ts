// The beds burning, a look at a time on the GPU (src/gpu/fire.ts drives it; plan docs/plans/2026-10-14-001-refactor-
// gpu-object-world-plan.md, Unit 12; docs/research/fire-constants.md secs. 28, 29 and 37). Every bed the world has
// burning (a campfire's, a burning tree's or shelter's own) holds a slot of the beds' state: its groups of pieces, its
// coals and its age, every number a real (wgsl/real.ts). A lane a bed goes through the looks owed since the last landing,
// ten seconds each (src/sim/lanes.ts FIRE_S), in the air the CPU found it in at each (src/sim/physics.ts bedAir):
// - alight and not heaped over, it blazes: what it gives off, its flame and how its flame leans in the wind, its heat's
//   reach and its brands (src/sim/spread.ts blazing, blazeWords), written as the receivers' law reads a blaze
//   (wgsl/fire.ts B) for that look;
// - it burns the look through, step by step, as src/sim/combustion.ts burnFor does: the flame taking in pieces yet to
//   light and lighting them a share at a time, lit pieces burning down and leaving their char among the coals, the coals
//   glowing away;
// - the first look it is no longer alight is the last it takes.
// What comes back with the landing is each bed's state, the look it went out at, and the farthest its heat and its
// brands reached; the receivers' law (wgsl/fire.ts) runs next on the blazes written here.
//
// Every operation is the twin's operation on the same reals in the same order (combustion.ts, spread.ts), so every GPU
// gives the words the twin gives (src/gpu/fire.test.ts).
import { FIXED } from "./fixed";
import { REAL, rw } from "./real";
import { B, BW, FLAME, LIM, NOWHERE, REACH } from "./fire";
import { COALS, GROUPS, LAW, STEPS } from "../../sim/combustion";
import { BLAZE } from "../../sim/spread";

// A bed's state, BEDW words: its header (how many groups, how many lots of coals, its age, s), then GROUPS groups of GW
// words and COALS lots of coals of CW words, the unused ones zero.
export const H = { ng: 0, nc: 1, age: 2 } as const;
export const HW = 4;
// A group: what its pieces are (as fuel.ts records them: thickness, dry mass, density, heat capacity, and as burn rows
// do: the heat to drive off a g of gas, the char yield, the lighting temperature, kρc, the critical flux, the heat of a
// kg of gas, the share that burns), which of the bed's records that is, and its state (combustion.ts Group: how many, the
// mass each has left, water, skin's water, alight, laid at, shell, heat inside and outside the flame, cover, inside).
export const GF = {
  d: 0, pm: 1, rho: 2, c: 3, L: 4, cy: 5, tig: 6, krc: 7, qcr: 8, fl: 9, share: 10, pid: 11,
  n: 12, mass: 13, m: 14, skin: 15, lit: 16, since: 17, ring: 18, heat: 19, warm: 20, cover: 21, inside: 22,
} as const;
export const GW = 23;
// Coals: shell, kg, thickness, density.
export const CF = { ring: 0, kg: 1, d: 2, rho: 3 } as const;
export const CW = 4;
export const BEDW = HW + GROUPS * GW + COALS * CW;
// The air at a bed at a look, AW words: whether it takes the look at all, the air's warmth, the wind, the rain, the
// plants' height, air blown in, a ring's height and width and whether there is one, whether it's heaped over, the
// height it's held at (reals), and its place (cm) and the wind's way (Q13), as the blaze's words hold them.
export const AF = { on: 0, temp: 1, wind: 2, rain: 3, veg: 4, blown: 5, tall: 6, width: 7, ringed: 8, covered: 9, held: 10, x: 11, y: 12, dx: 13, dy: 14 } as const;
export const AW = 15;
// What comes back of each bed ahead of its state, SW words: 0 if it is still alight after its last look, else one more
// than the look it went out at; and the farthest its heat reached and its brands landed over its looks (cm).
export const SF = { gone: 0, reach: 1, far: 2 } as const;
export const SW = 4;

const consts = (prefix: string, o: Record<string, number>) => Object.entries(o).map(([k, v]) => `const ${prefix}${k} = ${rw(v)};`).join("\n");
const fields = (prefix: string, o: Record<string, number>) => Object.entries(o).map(([k, v]) => `const ${prefix}${k} = ${v}u;`).join("\n");

// The law. Bindings: st (the beds' state, BEDW words a slot), job (each bed's slot, then the air at each look of each
// bed, look by look), fin (the receivers' input, whose blazes this writes), out (the landing's copy: SW words a bed,
// then each bed's state, then the blazes as fin has them), P (at, beds, looks, where the blazes start in fin; where the
// airs start in job).
export function fireBeds() {
  const { BARE_D, BARE_INV, ...blaze } = BLAZE;
  return /* wgsl */ `
@group(0) @binding(0) var<storage, read_write> st: array<u32>;
@group(0) @binding(1) var<storage, read> job: array<u32>;
@group(0) @binding(2) var<storage, read_write> fin: array<u32>;
@group(0) @binding(3) var<storage, read_write> out: array<u32>;
@group(0) @binding(4) var<uniform> P: array<vec4u, 2>;
${FIXED}
${REAL}
${consts("K_", LAW)}
${consts("Z_", blaze)}
${fields("G_", GF)}
${fields("C_", CF)}
${fields("A_", AF)}
${fields("B_", B)}
const GROUPS = ${GROUPS}u;
const COALS = ${COALS}u;
const HW = ${HW}u;
const GW = ${GW}u;
const CW = ${CW}u;
const BEDW = ${BEDW}u;
const AW = ${AW}u;
const BW = ${BW}u;
const SW = ${SW}u;

var<private> b0: u32;
// the air at the look, and the wind profile's own log over the plants (wind_at), worked out once a look
var<private> a_temp: u32; var<private> a_wind: u32; var<private> a_rain: u32; var<private> a_veg: u32; var<private> a_blown: u32;
var<private> a_tall: u32; var<private> a_width: u32; var<private> a_ringed: bool; var<private> a_covered: bool; var<private> a_held: u32;
var<private> a_v64: u32; var<private> a_v13: u32; var<private> a_den: u32;
// How the bed stands this moment (look), each number worked out once where the twin works it out wherever it is asked
// for, since nothing changes it in between: each group's thickness, side and solid, its gas and whether its flame is
// out, and yet to light the share of it in the flame, what its pieces there and outside take in and net, and the heat
// each would need to light; how the lay lies; each lot of coals' glow rate in the open; and the bed's flame, wind, air
// and heap. In a step: what each lit group's root mass falls by, and what has caught.
var<private> l_thick: array<u32, ${GROUPS}>; var<private> l_side: array<u32, ${GROUPS}>; var<private> l_solid: array<u32, ${GROUPS}>;
var<private> l_gas: array<u32, ${GROUPS}>; var<private> l_out: array<u32, ${GROUPS}>; var<private> l_next: array<u32, ${GROUPS}>;
var<private> l_f: array<u32, ${GROUPS}>; var<private> l_ii: array<u32, ${GROUPS}>; var<private> l_in: array<u32, ${GROUPS}>;
var<private> l_oi: array<u32, ${GROUPS}>; var<private> l_on: array<u32, ${GROUPS}>; var<private> l_nin: array<u32, ${GROUPS}>; var<private> l_non: array<u32, ${GROUPS}>;
var<private> l_rim: array<u32, ${GROUPS}>; var<private> l_touch: array<u32, ${GROUPS}>; var<private> l_beside: array<u32, ${GROUPS}>;
var<private> l_cr: array<u32, ${COALS}>; var<private> l_fall: array<u32, ${GROUPS}>;
var<private> c_src: array<u32, ${GROUPS}>; var<private> c_n: array<u32, ${GROUPS}>;
var<private> lk_flaming: u32; var<private> lk_lf: u32; var<private> lk_u: u32; var<private> lk_ta: u32; var<private> lk_R: u32; var<private> lk_rb: u32;

fn flat(g: vec3u, n: vec3u) -> u32 { return g.x + g.y * n.x * 64u; }
fn ng() -> u32 { return st[b0]; }
fn nc() -> u32 { return st[b0 + 1u]; }
fn gw(i: u32, f: u32) -> u32 { return st[b0 + HW + i * GW + f]; }
fn gset(i: u32, f: u32, v: u32) { st[b0 + HW + i * GW + f] = v; }
fn cw(i: u32, f: u32) -> u32 { return st[b0 + HW + GROUPS * GW + i * CW + f]; }
fn cset(i: u32, f: u32, v: u32) { st[b0 + HW + GROUPS * GW + i * CW + f] = v; }
fn lit(i: u32) -> bool { return gw(i, G_lit) != 0u; }

// ---------- the air, the wind and the flame (combustion.ts) ----------
fn set_air(a: u32) {
  a_temp = job[a + A_temp]; a_wind = job[a + A_wind]; a_rain = job[a + A_rain]; a_veg = job[a + A_veg]; a_blown = job[a + A_blown];
  a_tall = job[a + A_tall]; a_width = job[a + A_width]; a_ringed = job[a + A_ringed] != 0u; a_covered = job[a + A_covered] != 0u; a_held = job[a + A_held];
  a_v64 = r_mul(K_V64, a_veg); a_v13 = r_mul(K_V13, a_veg); a_den = 0u;
  if (r_gt(a_veg, 0u) && r_lt(a_veg, K_TWO)) { a_den = r_ln(r_div(r_sub(K_TWO, a_v64), a_v13)); }
}
// the wind at height z over the look's plants (combustion.ts windAt)
fn wind_at(head: u32, z: u32) -> u32 {
  if (r_ge(a_veg, K_TWO)) { return head; }
  if (r_le(a_veg, 0u)) { return r_mul(head, r_max(0u, r_div(r_ln(r_div(z, K_Z0)), K_LN_Z))); }
  return r_div(r_mul(head, r_ln(r_div(r_sub(r_max(z, a_veg), a_v64), a_v13))), a_den);
}
fn half(v: u32) -> u32 { return r_cbrt(r_div(r_mul(K_THREE, v), K_TWO_PI_PACK)); }
fn heap(pieces: u32, coals: u32) -> u32 { return r_cbrt(r_div(r_mul(K_THREE, r_add(r_div(pieces, K_PACK), r_div(coals, K_COAL_PACK))), K_TWO_PI)); }
fn burns_ring(r: u32) -> bool { for (var x = 0u; x < ng(); x++) { if (lit(x) && gw(x, G_ring) == r) { return true; } } return false; }
fn lies(coal: u32) {
  let n = ng();
  for (var i = 0u; i < n; i++) {
    let ring = gw(i, G_ring);
    var has_in = false; var inner = 0u; var has_out = false; var outer = 0u; var within = 0u; var kin = 0u;
    for (var x = 0u; x < n; x++) {
      let rx = gw(x, G_ring);
      if (r_lt(rx, ring) && (!has_in || r_gt(rx, inner))) { inner = rx; has_in = true; }
      if (r_gt(rx, ring) && (!has_out || r_lt(rx, outer))) { outer = rx; has_out = true; }
      if (r_le(rx, ring)) { within = r_add(within, l_solid[x]); }
      if (rx == ring && gw(x, G_pid) == gw(i, G_pid)) { kin = r_add(kin, gw(x, G_n)); }
    }
    let first = !has_in;
    let near = (has_in && burns_ring(inner)) || (has_out && burns_ring(outer));
    l_rim[i] = heap(within, coal);
    l_touch[i] = select(0u, 1u, near || burns_ring(ring) || (first && nc() > 0u));
    var beside = near || r_ge(kin, K_TWO);
    for (var x = 0u; x < n; x++) { if (x != i && lit(x) && gw(x, G_ring) == ring) { beside = true; } }
    if (first) { for (var k = 0u; k < nc(); k++) { if (cw(k, C_ring) != ring) { beside = true; } } }
    l_beside[i] = select(0u, 1u, beside);
  }
}
fn crib(i: u32, u: u32, rain: u32, beside: bool) -> u32 {
  let b = r_mul(gw(i, G_d), K_HUNDRED);
  let h = r_max(b, r_mul(K_HUNDRED, half(r_div(r_mul(gw(i, G_n), gw(i, G_pm)), gw(i, G_rho)))));
  let open = r_sub(K_ONE, r_exp(r_div(r_mul(r_mul(r_mul(K_CRIB_C, b), b), K_CRIB_K), r_mul(K_FOUR, h))));
  let wet = r_add(gw(i, G_L), r_div(r_mul(K_WATER, gw(i, G_m)), r_max(K_E9, r_sub(K_ONE, gw(i, G_cy)))));
  var rate = 0u;
  if (r_lt(gw(i, G_d), K_LARGE)) { rate = r_div(r_mul(K_CRIB, open), r_sqrt(b)); } else if (beside) { rate = K_STEADY; }
  return r_sub(r_div(r_mul(r_mul(r_min(K_SIX, r_add(K_ONE, r_mul(r_add(K_C02, r_mul(K_C085, r_sub(K_ONE, open))), u))), rate), gw(i, G_L)), wet), r_div(rain, wet));
}
fn drowned(i: u32) -> bool { return r_lt(gw(i, G_d), K_ONE_HOUR) && r_gt(gw(i, G_m), K_MX); }
fn can(i: u32, into: u32, net: u32) -> bool { return r_gt(net, 0u) && r_ge(into, K_LEAST) && !drowned(i); }
fn alight() -> bool { if (nc() > 0u) { return true; } for (var i = 0u; i < ng(); i++) { if (lit(i)) { return true; } } return false; }
fn live() -> bool {
  if (alight()) { return true; }
  for (var i = 0u; i < ng(); i++) { if (r_gt(gw(i, G_heat), 0u) || r_gt(gw(i, G_warm), 0u)) { return true; } }
  return false;
}

// ---------- a look at the bed (combustion.ts look) ----------
fn look() {
  let n = ng(); let m = nc();
  var pieces = 0u; var lit_solid = 0u; var coal_s = 0u; var coal = 0u;
  for (var i = 0u; i < n; i++) {
    let mass = gw(i, G_mass);
    let t = r_mul(gw(i, G_d), r_sqrt(r_div(r_max(0u, mass), gw(i, G_pm))));
    l_thick[i] = t;
    l_side[i] = r_div(r_div(r_mul(K_FOUR, mass), gw(i, G_rho)), r_max(K_E9, t));
    l_solid[i] = r_div(r_mul(gw(i, G_n), mass), gw(i, G_rho));
    pieces = r_add(pieces, l_solid[i]);
    if (lit(i)) { lit_solid = r_add(lit_solid, l_solid[i]); }
  }
  for (var k = 0u; k < m; k++) {
    coal_s = r_add(coal_s, r_div(cw(k, C_kg), cw(k, C_rho)));
    coal = r_add(coal, r_div(r_mul(K_FOUR, cw(k, C_kg)), r_mul(cw(k, C_rho), cw(k, C_d))));
  }
  let R = heap(pieces, coal_s); let rb = half(lit_solid);
  let gp = r_max(0u, r_sub(K_ONE, r_div(a_width, r_mul(K_TWO_PI, R))));
  // the heap's own wind, as far as a ring lets it in
  var u = 0u;
  if (!a_covered) { u = wind_at(a_wind, r_max(r_max(K_Z_MIN, r_mul(R, K_HALF)), a_held)); }
  if (a_ringed && r_gt(R, 0u) && r_gt(u, 0u)) {
    let h = r_min(K_ONE, r_div(a_tall, R));
    let below = r_sub(r_mul(K_C15, h), r_mul(K_HALF, r_mul(r_sq(h), h)));
    u = r_mul(u, r_add(r_sub(K_ONE, below), r_mul(below, r_add(K_LEE, r_mul(K_LEE_OPEN, gp)))));
  }
  var ub = 0u; if (!a_covered) { ub = r_add(u, a_blown); }
  let ta = r_add(a_temp, K_KELVIN);
  lies(coal_s);
  var lt = K_T_BURN; var hot = K_T_SMOULDER;
  if (a_covered) { lt = K_T_SMOULDER; } else { hot = r_min(K_GLOW_MAX, r_mul(K_GLOW_A, r_pow(r_add(ub, K_C029), K_C0125))); }
  var area = 0u; var burns = 0u;
  for (var i = 0u; i < n; i++) { area = r_add(area, r_mul(gw(i, G_n), l_side[i])); }
  area = r_add(area, coal);
  for (var i = 0u; i < n; i++) { if (lit(i)) { burns = r_add(burns, r_mul(gw(i, G_n), l_side[i])); } }
  burns = r_add(burns, coal);
  let shine = r_add(r_mul(r_mul(r_sub(burns, coal), K_EPS_SIGMA), r_p4(lt)), r_mul(r_mul(coal, K_EPS_SIGMA), r_p4(hot)));
  var rain = 0u;
  if (r_gt(area, 0u) && !a_covered) { rain = r_div(r_mul(r_mul(r_mul(r_mul(K_RAIN, a_rain), K_PI), R), R), area); }
  var back = 0u;
  if (a_ringed && r_gt(burns, 0u)) {
    back = r_mul(r_mul(r_mul(K_C025, r_sub(K_ONE, gp)), r_min(K_ONE, r_div(a_tall, R))), r_max(0u, r_sub(r_div(shine, r_mul(burns, K_EPS)), r_mul(K_SIGMA, r_p4(ta)))));
  }
  for (var i = 0u; i < n; i++) {
    var gas = 0u;
    if (lit(i) && !a_covered) { gas = crib(i, ub, rain, l_beside[i] != 0u); }
    l_gas[i] = gas;
    l_out[i] = select(0u, 1u, lit(i) && (a_covered || r_lt(gas, K_EXTINCT) || drowned(i)));
  }
  var flaming = 0u; var lf = 0u;
  // what the wind blows off lowers the flame, which may let it blow off more
  for (var k = 0u; k <= n; k++) {
    flaming = 0u;
    for (var i = 0u; i < n; i++) {
      if (lit(i) && l_out[i] == 0u) { flaming = r_add(flaming, r_mul(r_mul(r_mul(gw(i, G_n), l_gas[i]), l_side[i]), gw(i, G_fl))); }
    }
    lf = 0u;
    if (r_gt(flaming, 0u)) { lf = r_max(0u, r_sub(r_mul(K_C0235, r_pow(flaming, K_C04)), r_mul(K_C102, r_mul(K_TWO, rb)))); }
    var same = true;
    for (var i = 0u; i < n; i++) {
      let nx = l_out[i] != 0u || (lit(i) && r_gt(u, r_sqrt(r_div(r_mul(r_mul(K_G, lf), l_gas[i]), K_EXTINCT))));
      l_next[i] = select(0u, 1u, nx);
      if (l_next[i] != l_out[i]) { same = false; }
    }
    if (same) { break; }
    for (var i = 0u; i < n; i++) { l_out[i] = l_next[i]; }
  }
  // a flame's own radiation, the same on every piece in it
  let fr = r_mul(r_sub(K_ONE, r_exp(r_mul(K_NEG_KAPPA, lf))), K_SIGMA_TF4);
  for (var i = 0u; i < n; i++) {
    if (lit(i)) {
      if (l_out[i] != 0u) { l_gas[i] = 0u; }
      l_f[i] = K_ONE; l_ii[i] = 0u; l_in[i] = 0u; l_oi[i] = 0u; l_on[i] = 0u;
      continue;
    }
    l_gas[i] = 0u;
    let d = l_thick[i]; let rim = l_rim[i]; let touches = l_touch[i] != 0u;
    var s1 = 0u;
    if (touches && r_gt(burns, 0u)) { s1 = r_mul(r_mul(K_HALF, r_sub(K_ONE, r_exp(r_div(r_mul(K_NEG_PACK, r_mul(R, K_HALF)), d)))), r_div(shine, burns)); }
    var s2 = 0u;
    if (r_ge(rim, r_mul(R, K_RIM))) { s2 = back; }
    let seen = r_add(s1, s2);
    let cover = gw(i, G_cover);
    var f = 0u;
    if (touches && r_lt(cover, K_ONE)) { f = r_min(K_ONE, r_max(0u, r_div(r_sub(r_min(K_ONE, r_div(lf, rim)), cover), r_sub(K_ONE, cover)))); }
    let ii = r_add(r_add(r_mul(K_CONTACT, r_sqrt(r_div(K_BLADE, d))), fr), seen);
    // what it loses to its critical flux, the wind's cooling (Churchill and Bernstein) and the rain, of what comes in
    let dT = r_sub(r_add(gw(i, G_tig), K_KELVIN), ta);
    let re = r_div(r_mul(u, d), K_NU);
    let nu = r_add(K_C03, r_mul(r_mul(K_CB, r_sqrt(re)), r_pow(r_add(K_ONE, r_pow(r_div(re, K_RE_C), K_C0625)), K_C08)));
    let cool = r_mul(r_div(r_div(r_mul(nu, K_K_AIR), d), K_THOUSAND), dT);
    l_f[i] = f; l_ii[i] = ii; l_oi[i] = seen;
    l_in[i] = r_sub(r_sub(r_sub(ii, gw(i, G_qcr)), cool), rain);
    l_on[i] = r_sub(r_sub(r_sub(seen, gw(i, G_qcr)), cool), rain);
    // the heat each part would need to light (combustion.ts depths, needs), one site for both
    let thin = r_mul(r_mul(r_mul(r_mul(gw(i, G_rho), gw(i, G_c)), r_div(d, K_FOUR)), dT), r_add(K_ONE, r_mul(K_FIVE, gw(i, G_m))));
    let deep = r_mul(r_mul(r_mul(r_mul(K_PI_4, gw(i, G_krc)), r_add(K_ONE, r_mul(K_C81, gw(i, G_skin)))), dT), dT);
    for (var s = 0u; s < (r_n >> 4u); s++) {
      let qn = select(l_in[i], l_on[i], s == 1u);
      var need = R_MAX;
      if (r_gt(qn, 0u)) { need = r_pow(r_add(r_div(K_ONE, r_p4(thin)), r_p4(r_div(qn, deep))), K_QUARTER); }
      if (s == 0u) { l_nin[i] = need; } else { l_non[i] = need; }
    }
  }
  for (var k = 0u; k < m; k++) { l_cr[k] = r_div(r_mul(K_K_CHAR_AIR, r_max(K_DRAWN, u)), cw(k, C_rho)); }
  lk_flaming = flaming; lk_lf = lf; lk_u = u; lk_ta = ta; lk_R = R; lk_rb = rb;
}

// ---------- a step (combustion.ts tick) ----------
fn lights(i: u32, into: u32, net: u32, heat: u32, need: u32) -> bool { return can(i, into, net) && r_ge(heat, r_mul(need, K_NEARLY)); }
fn char_in(ring: u32, kg: u32, d: u32, rho: u32) {
  if (r_le(kg, 0u)) { return; }
  var at = COALS;
  for (var k = 0u; k < nc(); k++) { if (cw(k, C_ring) == ring) { at = k; break; } }
  if (at == COALS) {
    if (nc() >= COALS) { at = COALS - 1u; }
    else { let k = nc(); cset(k, C_ring, ring); cset(k, C_kg, kg); cset(k, C_d, d); cset(k, C_rho, rho); st[b0 + 1u] = k + 1u; return; }
  }
  let ckg = cw(at, C_kg); let sum = r_add(ckg, kg);
  let nd = r_div(r_add(r_mul(cw(at, C_d), ckg), r_mul(d, kg)), sum);
  let nrho = r_div(sum, r_add(r_div(ckg, cw(at, C_rho)), r_div(kg, rho)));
  cset(at, C_d, nd); cset(at, C_rho, nrho); cset(at, C_kg, sum);
}
fn light(i: u32) { gset(i, G_lit, 1u); gset(i, G_heat, 0u); gset(i, G_warm, 0u); gset(i, G_cover, 0u); gset(i, G_inside, K_ONE); }
// One step after a look; the seconds it took.
fn tick(left: u32) -> u32 {
  let n0 = ng(); let m0 = nc();
  // the flame takes in or lets go of pieces yet to light, each carrying its heat
  for (var i = 0u; i < n0; i++) {
    let f = l_f[i]; let inside = gw(i, G_inside);
    if (lit(i) || f == inside) { continue; }
    if (r_gt(f, inside)) { gset(i, G_heat, r_div(r_add(r_mul(gw(i, G_heat), inside), r_mul(gw(i, G_warm), r_sub(f, inside))), f)); }
    else { gset(i, G_warm, r_div(r_add(r_mul(gw(i, G_warm), r_sub(K_ONE, inside)), r_mul(gw(i, G_heat), r_sub(inside, f))), r_sub(K_ONE, f))); }
    gset(i, G_inside, f);
  }
  var j = 0u; if (!a_covered) { j = r_mul(a_blown, K_JET); }
  var kg = 0u; for (var k = 0u; k < m0; k++) { kg = r_add(kg, cw(k, C_kg)); }
  var dt = r_min(left, K_STEP);
  for (var i = 0u; i < n0; i++) {
    let pm = gw(i, G_pm); let ash = r_mul(pm, r_sub(K_ONE, gw(i, G_share)));
    if (lit(i)) {
      // how fast its root mass falls as it burns, or under a cover as it smoulders
      if (a_covered) { l_fall[i] = r_div(r_mul(K_TWO_FRONT, r_sqrt(pm)), gw(i, G_d)); }
      else { l_fall[i] = r_div(r_mul(r_mul(K_TWO, l_gas[i]), r_sqrt(pm)), r_mul(r_mul(r_mul(K_THOUSAND, r_sub(K_ONE, r_min(K_C0999, gw(i, G_cy)))), gw(i, G_rho)), gw(i, G_d))); }
    }
    if (lit(i) && ((!a_covered && r_le(l_gas[i], 0u)) || r_ge(gw(i, G_cy), K_ONE))) { dt = 0u; }
    else if (lit(i)) {
      let mass = gw(i, G_mass);
      dt = r_min(dt, r_div(r_sub(r_sqrt(mass), r_sqrt(r_max(ash, r_sub(mass, r_mul(K_TENTH, pm))))), l_fall[i]));
    } else {
      if (r_gt(l_f[i], 0u) && can(i, l_ii[i], l_in[i])) { dt = r_min(dt, r_max(0u, r_div(r_sub(l_nin[i], gw(i, G_heat)), l_in[i]))); }
      if (r_lt(l_f[i], K_ONE) && can(i, l_oi[i], l_on[i])) { dt = r_min(dt, r_max(0u, r_div(r_sub(l_non[i], gw(i, G_warm)), l_on[i]))); }
    }
  }
  for (var k = 0u; k < m0; k++) {
    var thin = K_TWO_FRONT; if (!a_covered) { thin = l_cr[k]; }
    dt = r_min(dt, r_div(cw(k, C_d), r_add(thin, r_div(r_mul(j, cw(k, C_d)), r_mul(K_TWO, kg)))));
  }
  if (r_gt(j, 0u) && r_gt(kg, 0u)) { dt = r_min(dt, r_div(r_mul(K_TENTH, kg), j)); }
  // the coals glow or smoulder down, and those glowed away leave
  for (var k = 0u; k < m0; k++) {
    var thin = K_TWO_FRONT; if (!a_covered) { thin = l_cr[k]; }
    let cd = cw(k, C_d); let ckg = cw(k, C_kg);
    let d = r_sub(cd, r_mul(thin, dt));
    var glowed = 0u; if (!r_le(d, K_E9)) { glowed = r_mul(ckg, r_sq(r_div(d, cd))); }
    let rest = r_sub(glowed, r_div(r_mul(r_mul(j, dt), ckg), kg));
    if (r_le(rest, K_E12)) { cset(k, C_kg, 0u); cset(k, C_d, 0u); }
    else { cset(k, C_d, r_mul(d, r_sqrt(r_div(rest, glowed)))); cset(k, C_kg, rest); }
  }
  var kept = 0u;
  for (var k = 0u; k < m0; k++) {
    if (r_gt(cw(k, C_kg), 0u)) {
      if (kept != k) { for (var f = 0u; f < CW; f++) { cset(kept, f, cw(k, f)); } }
      kept++;
    }
  }
  for (var k = kept; k < m0; k++) { for (var f = 0u; f < CW; f++) { cset(k, f, 0u); } }
  st[b0 + 1u] = kept;
  // each group burns, goes out, turns to coals, warms or lights
  var caught = 0u;
  for (var i = 0u; i < n0; i++) {
    let ash = r_mul(gw(i, G_pm), r_sub(K_ONE, gw(i, G_share)));
    var ckg = 0u; var cd = 0u; var crho = 0u;
    if (lit(i) && r_ge(gw(i, G_cy), K_ONE)) {
      ckg = r_mul(gw(i, G_n), gw(i, G_mass)); cd = l_thick[i]; crho = gw(i, G_rho);
      gset(i, G_mass, 0u);
    } else if (lit(i) && !a_covered && r_le(l_gas[i], 0u)) {
      gset(i, G_lit, 0u); gset(i, G_heat, 0u); gset(i, G_warm, 0u); gset(i, G_cover, 0u); gset(i, G_inside, 0u);
    } else if (lit(i)) {
      let was = gw(i, G_mass);
      let root = r_max(r_sqrt(ash), r_sub(r_sqrt(was), r_mul(l_fall[i], dt)));
      let now = r_mul(root, root);
      gset(i, G_mass, now);
      ckg = r_mul(r_mul(gw(i, G_n), r_sub(was, now)), gw(i, G_cy)); cd = gw(i, G_d); crho = r_mul(gw(i, G_rho), gw(i, G_cy));
    } else {
      let f = l_f[i];
      let warm = r_max(0u, r_add(gw(i, G_warm), r_mul(l_on[i], dt)));
      gset(i, G_warm, warm);
      var heat = warm;
      if (r_gt(f, 0u)) { heat = r_max(0u, r_add(gw(i, G_heat), r_mul(l_in[i], dt))); }
      gset(i, G_heat, heat);
      let share = r_gt(f, 0u) && lights(i, l_ii[i], l_in[i], heat, l_nin[i]);
      if ((r_lt(f, K_ONE) && lights(i, l_oi[i], l_on[i], warm, l_non[i])) || (r_ge(f, K_ONE) && lights(i, l_ii[i], l_in[i], heat, l_nin[i])) || (share && n0 + caught >= GROUPS)) {
        light(i);
      } else if (share) {
        let n = gw(i, G_n); let cover = gw(i, G_cover);
        c_src[caught] = i; c_n[caught] = r_mul(n, f); caught++;
        gset(i, G_n, r_mul(n, r_sub(K_ONE, f)));
        gset(i, G_cover, r_add(cover, r_mul(f, r_sub(K_ONE, cover))));
        gset(i, G_heat, warm);
        gset(i, G_inside, 0u);
      }
    }
    // what burns adds its char to the coals
    char_in(gw(i, G_ring), ckg, cd, crho);
  }
  // what has just caught joins a lit group of its own kind still as fresh, or burns as a group of its own
  for (var k = 0u; k < caught; k++) {
    let s = c_src[k]; let cn = c_n[k]; let cmass = gw(s, G_mass);
    var kin = GROUPS;
    for (var x = 0u; x < ng(); x++) {
      if (lit(x) && gw(x, G_pid) == gw(s, G_pid) && gw(x, G_m) == gw(s, G_m) && gw(x, G_ring) == gw(s, G_ring) && r_ge(gw(x, G_mass), r_mul(cmass, K_FRESH))) { kin = x; break; }
    }
    if (kin != GROUPS) {
      let kn = gw(kin, G_n);
      gset(kin, G_mass, r_div(r_add(r_mul(gw(kin, G_mass), kn), r_mul(cmass, cn)), r_add(kn, cn)));
      gset(kin, G_n, r_add(kn, cn));
    } else {
      let x = ng();
      for (var f = 0u; f < GW; f++) { gset(x, f, gw(s, f)); }
      gset(x, G_n, cn); light(x);
      st[b0] = x + 1u;
    }
  }
  // what has burnt down to its ash leaves
  var keep = 0u;
  let n1 = ng();
  for (var i = 0u; i < n1; i++) {
    if (r_gt(gw(i, G_n), K_E9) && r_gt(gw(i, G_mass), r_add(r_mul(gw(i, G_pm), r_sub(K_ONE, gw(i, G_share))), K_E12))) {
      if (keep != i) { for (var f = 0u; f < GW; f++) { gset(keep, f, gw(i, f)); } }
      keep++;
    }
  }
  for (var i = keep; i < n1; i++) { for (var f = 0u; f < GW; f++) { gset(i, f, 0u); } }
  st[b0] = keep;
  return dt;
}

// ---------- the blaze (combustion.ts output; spread.ts blazing, reach, blazeWords) ----------
fn cm(m: u32, most: u32) -> u32 { return r_whole(r_mul(m, Z_HUNDRED), most, 0i); }
// Writes the bed's blaze as the look just taken finds it to the receivers' words at w, as bed j; its heat's reach and
// its brands', cm. Only in the open: the coals glow in the air, never smoulder.
fn blaze(w: u32, j: u32, a: u32) -> vec2u {
  var gas = 0u;
  for (var i = 0u; i < ng(); i++) { if (lit(i)) { gas = r_add(gas, r_div(r_mul(r_mul(gw(i, G_n), l_gas[i]), l_side[i]), K_THOUSAND)); } }
  var glowing = 0u;
  for (var k = 0u; k < nc(); k++) { glowing = r_add(glowing, r_mul(r_div(r_mul(K_TWO, cw(k, C_kg)), cw(k, C_d)), l_cr[k])); }
  var jt = 0u; if (nc() > 0u) { jt = r_mul(a_blown, K_JET); }
  glowing = r_mul(r_add(glowing, jt), K_CHAR_HEAT);
  let flaming = lk_flaming; let lf = lk_lf; let rb = lk_rb; let hp = lk_R;
  // how the flame leans
  let u = wind_at(a_wind, r_max(Z_Z_MIN, r_mul(lf, Z_HALF)));
  var m = 0u; if (r_gt(rb, 0u)) { m = r_div(gas, r_mul(Z_PI, r_sq(rb))); }
  var us = 0u; if (r_gt(m, 0u)) { us = r_div(u, r_cbrt(r_div(r_mul(r_mul(r_mul(Z_G, m), Z_TWO), rb), Z_RHO_AIR))); }
  var cs = Z_ONE; if (r_gt(us, 0u)) { cs = r_min(Z_ONE, r_mul(Z_C07, r_pow(us, Z_C049))); }
  let q = r_add(flaming, glowing); let sn = r_sqrt(r_sub(Z_ONE, r_sq(cs))); let veg = a_veg;
  // how far its heat reaches, and its brands, carried by the wind at the height they're lofted to while they fall
  let rad = r_add(r_mul(lf, Z_HALF), r_sqrt(r_div(r_mul(Z_CHI_R, q), Z_HEATS)));
  let heat = r_max(r_add(rb, lf), rad);
  let top = r_mul(Z_LOFT, lf);
  let z = r_min(top, Z_ALIVE);
  let brands = r_add(rb, r_div(r_mul(wind_at(a_wind, r_max(Z_Z_MIN, z)), z), Z_FALL));
  fin[w + B_x] = job[a + A_x]; fin[w + B_y] = job[a + A_y]; fin[w + B_dx] = job[a + A_dx]; fin[w + B_dy] = job[a + A_dy];
  fin[w + B_tx] = cm(r_mul(lf, sn), ${FLAME}u); fin[w + B_tz] = cm(r_mul(lf, cs), ${FLAME}u);
  fin[w + B_rb] = cm(rb, ${FLAME}u); fin[w + B_heap] = cm(hp, ${FLAME}u); fin[w + B_lf] = cm(lf, ${FLAME}u);
  fin[w + B_qr] = r_whole(r_div(r_mul(r_mul(Z_CHI_R, q), Z_THOUSAND), Z_FOUR_PI), 0xffffffffu, 0i);
  fin[w + B_fr] = r_whole(r_mul(r_sub(K_ONE, r_exp(r_mul(K_NEG_KAPPA, lf))), K_SIGMA_TF4), 0x7fffffffu, 16i);
  let reach = cm(heat, ${REACH}u); let far = cm(brands, ${LIM}u);
  fin[w + B_reach] = reach; fin[w + B_far] = far;
  fin[w + B_bed] = j;
  var gb = 0u;
  if (r_gt(lf, 0u) && r_gt(gas, 0u) && r_gt(rb, 0u)) {
    gb = r_whole(r_div(r_mul(r_mul(Z_BRANDS, gas), Z_LOOK), r_mul(r_mul(r_mul(r_mul(Z_TWO, rb), Z_HUNDRED), top), Z_HUNDRED)), 0xffffffffu, 32i);
  }
  fin[w + B_gb] = gb;
  fin[w + B_alive] = cm(z, ${FLAME * 2}u);
  fin[w + B_k] = r_whole(r_div(a_wind, Z_FALL), 0x7fffffffu, 16i);
  if (r_lt(veg, Z_TWO)) {
    fin[w + B_wind] = 1u;
    if (r_le(veg, 0u)) { fin[w + B_d] = ${BARE_D}u; fin[w + B_inv] = ${BARE_INV}u; }
    else {
      fin[w + B_v] = cm(veg, ${FLAME}u);
      fin[w + B_s] = r_whole(r_mul(Z_C64, veg), 0x7fffffffu, 16i);
      fin[w + B_d] = r_whole(r_mul(Z_C13, veg), 0x7fffffffu, 16i);
      fin[w + B_inv] = r_whole(r_div(Z_ONE, a_den), 0x7fffffffu, 16i);
    }
  }
  return vec2u(reach, far);
}

// A look at a bed, span seconds of it (combustion.ts burnFor), blazing at its first step if it blazes at all: its
// heat's reach and its brands', cm.
fn burn_for(span: u32, blazing: bool, w: u32, j: u32, a: u32) -> vec2u {
  var left = span; var r = vec2u(0u);
  for (var k = 0u; k < ${STEPS}u; k++) {
    if (!(r_gt(left, K_E9) && live())) { break; }
    look();
    if (k == 0u && blazing) { r = blaze(w, j, a); }
    left = r_sub(left, tick(left));
  }
  st[b0 + 2u] = r_add(st[b0 + 2u], span);
  return r;
}

@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) gid: vec3u, @builtin(num_workgroups) nw: vec3u) {
  let j = flat(gid, nw);
  let at = P[0].x; let nb = P[0].y; let looks = P[0].z; let offB = P[0].w; let airs = P[1].x; let ob = at + nb * (SW + BEDW);
  if (j >= nb) { return; }
  b0 = job[j] * BEDW;
  r_init(P[1].y);
  var gone = 0u; var reach = 0u; var far = 0u;
  for (var k = 0u; k < looks; k++) {
    let a = airs + (k * nb + j) * AW; let w = offB + (k * nb + j) * BW;
    for (var f = 0u; f < BW; f++) { fin[w + f] = 0u; }
    fin[w + B_x] = ${NOWHERE}u;
    if (job[a + A_on] != 0u && gone == 0u) {
      set_air(a);
      let r = burn_for(K_STEP, alight() && !a_covered, w, j, a);
      reach = max(reach, r.x); far = max(far, r.y);
      if (!alight()) { gone = k + 1u; }
    }
    for (var f = 0u; f < BW; f++) { out[ob + (k * nb + j) * BW + f] = fin[w + f]; }
  }
  let s = at + j * SW;
  out[s] = gone; out[s + 1u] = reach; out[s + 2u] = far; out[s + 3u] = 0u;
  let o = at + nb * SW + j * BEDW;
  for (var w = 0u; w < BEDW; w++) { out[o + w] = st[b0 + w]; }
}`;
}
