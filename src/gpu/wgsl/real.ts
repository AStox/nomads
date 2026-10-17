// Real numbers in WGSL, one function for each of its TypeScript twins in ../real.ts (the format, its rounding and its
// bounds are described there), on integer operations only. A real is a u32 laid out as IEEE 754's single precision; a
// 64-bit integer is a vec2u (lo, hi), two's complement when signed. A kernel that needs these puts FIXED and then REAL
// ahead of its own source, and calls r_init(32u) before any of them, the 32 read from its parameters: the divisions',
// logs' and square roots' loops then run to a count no compiler knows ahead, so none unrolls them at every call (a
// kernel calling these from hundreds of places took Intel's Metal compiler minutes) [design].
import { MAXR, T, bits } from "../real";

// A real's word, for a kernel's constants: x truncated as the twin's T truncates it.
export const rw = (x: number) => `${bits(T(x))}u`;

export const REAL = /* wgsl */ `
const R_MAX = 0x7f7fffffu;
const R_NMAX = ${bits(-MAXR)}u;
var<private> r_n: u32;
fn r_init(n: u32) { r_n = n; }
// fixed.ts divw, lg2m: (q, r) of (rhi 2^32 + lo) / d for rhi < d, and log2(m / 2^31) in Q0.32, looping r_n (32) times
fn r_divw(rhi: u32, lo: u32, d: u32) -> vec2u {
  var r = rhi; var q = 0u;
  for (var b = 0u; b < r_n; b++) {
    let top = r >> 31u;
    r = (r << 1u) | ((lo >> (31u - b)) & 1u);
    q = q << 1u;
    if (top == 1u || r >= d) { r = r - d; q = q | 1u; }
  }
  return vec2u(q, r);
}
fn r_lg2m(m: u32) -> u32 {
  var y = m; var f = 0u;
  for (var i = 0u; i < r_n; i++) {
    let p = mul64(y, y);
    f = f << 1u;
    if (p.y >= 0x80000000u) { y = p.y; f = f | 1u; } else { y = (p.y << 1u) | (p.x >> 31u); }
  }
  return f;
}
fn r_e(a: u32) -> i32 { return i32((a >> 23u) & 0xffu) - 127i; }
fn r_m(a: u32) -> u32 { return (a & 0x7fffffu) | 0x800000u; }
fn r_z(a: u32) -> bool { return (a & 0x7fffffffu) == 0u; }
// sign s, 24-bit mantissa m (2^23 to 2^24 - 1) and exponent e: m 2^(e - 23), flushed and saturated
fn r_make(s: u32, m: u32, e: i32) -> u32 {
  if (e < -126i) { return 0u; }
  if (e > 127i) { return s | R_MAX; }
  return s | (u32(e + 127i) << 23u) | (m & 0x7fffffu);
}
fn r_neg(a: u32) -> u32 { if (r_z(a)) { return 0u; } return a ^ 0x80000000u; }
fn r_key(a: u32) -> u32 { if ((a >> 31u) == 1u) { return ~a; } return a | 0x80000000u; }
fn r_lt(a: u32, b: u32) -> bool { return r_key(a) < r_key(b); }
fn r_le(a: u32, b: u32) -> bool { return r_key(a) <= r_key(b); }
fn r_gt(a: u32, b: u32) -> bool { return r_key(a) > r_key(b); }
fn r_ge(a: u32, b: u32) -> bool { return r_key(a) >= r_key(b); }
fn r_min(a: u32, b: u32) -> u32 { if (r_lt(b, a)) { return b; } return a; }
fn r_max(a: u32, b: u32) -> u32 { if (r_lt(a, b)) { return b; } return a; }

fn shl64(v: vec2u, k: u32) -> vec2u {
  if (k == 0u) { return v; }
  if (k >= 32u) { return vec2u(0u, v.x << (k - 32u)); }
  return vec2u(v.x << k, (v.y << k) | (v.x >> (32u - k)));
}
fn shr64(v: vec2u, k: u32) -> vec2u {
  if (k == 0u) { return v; }
  if (k >= 32u) { return vec2u(v.y >> (k - 32u), 0u); }
  return vec2u((v.x >> k) | (v.y << (32u - k)), v.y >> k);
}
fn top64(v: vec2u) -> u32 { if (v.y != 0u) { return 63u - countLeadingZeros(v.y); } return 31u - countLeadingZeros(v.x); }
// sign s and an unsigned 64-bit v: v 2^e0, truncated
fn r_norm(s: u32, v: vec2u, e0: i32) -> u32 {
  if (v.x == 0u && v.y == 0u) { return 0u; }
  let p = top64(v);
  var m = 0u;
  if (p >= 23u) { m = shr64(v, p - 23u).x; } else { m = v.x << (23u - p); }
  return r_make(s, m, e0 + i32(p));
}
fn r_from_u(n: u32) -> u32 { return r_norm(0u, vec2u(n, 0u), 0i); }
fn r_from_i(n: i32) -> u32 { return r_norm(select(0u, 0x80000000u, n < 0i), vec2u(select(bitcast<u32>(n), 0u - bitcast<u32>(n), n < 0i), 0u), 0i); }

// ---------- arithmetic ----------
fn r_add(a: u32, b: u32) -> u32 {
  var x = a; var y = b;
  if ((y & 0x7fffffffu) > (x & 0x7fffffffu)) { x = b; y = a; }
  if (r_z(y)) { if (r_z(x)) { return 0u; } return x; }
  let ex = r_e(x); let ey = r_e(y); let mx = r_m(x); let my = r_m(y);
  let s = x & 0x80000000u; let same = ((x ^ y) & 0x80000000u) == 0u;
  let d = u32(ex - ey);
  if (d > 25u) {
    if (same) { return x; }
    if (mx == 0x800000u) { return r_make(s, 0xffffffu, ex - 1i); }
    return r_make(s, mx - 1u, ex);
  }
  let A = shl64(vec2u(mx, 0u), d);
  var S = vec2u(0u);
  if (same) { S = add64(A, vec2u(my, 0u)); } else { S = sub64(A, vec2u(my, 0u)); }
  return r_norm(s, S, ey - 23i);
}
fn r_sub(a: u32, b: u32) -> u32 { return r_add(a, r_neg(b)); }
// two 24-bit mantissas' product lies in [2^46, 2^48): its top 24 bits from bit 47 or bit 46
fn r_mul(a: u32, b: u32) -> u32 {
  if (r_z(a) || r_z(b)) { return 0u; }
  let p = mul64(r_m(a), r_m(b)); let s = (a ^ b) & 0x80000000u; let e = r_e(a) + r_e(b);
  if (p.y >= 0x8000u) { return r_make(s, (p.y << 8u) | (p.x >> 24u), e + 1i); }
  return r_make(s, (p.y << 9u) | (p.x >> 23u), e);
}
fn r_div(a: u32, b: u32) -> u32 {
  if (r_z(a)) { return 0u; }
  if (r_z(b)) { return (a & 0x80000000u) | R_MAX; }
  let ma = r_m(a); let mb = r_m(b);
  if (ma >= mb) { return r_make((a ^ b) & 0x80000000u, r_divw(ma >> 9u, ma << 23u, mb).x, r_e(a) - r_e(b)); }
  return r_make((a ^ b) & 0x80000000u, r_divw(ma >> 8u, ma << 24u, mb).x, r_e(a) - r_e(b) - 1i);
}
// floor(sqrt(v)) for v under 2^50, a bit at a time from 2^25 (r_n - 6 bits)
fn r_isqrt(v: vec2u) -> u32 {
  var r = 0u;
  for (var i = 0u; i < r_n - 6u; i++) { let c = r | (1u << (25u - i)); if (!lt64(v, mul64(c, c))) { r = c; } }
  return r;
}
fn r_sqrt(a: u32) -> u32 {
  if (r_z(a) || (a >> 31u) == 1u) { return 0u; }
  let k = r_e(a) - 23i; let m = r_m(a);
  if ((k & 1i) == 0i) { return r_make(0u, r_isqrt(shl64(vec2u(m, 0u), 24u)), k / 2i + 11i); }
  return r_make(0u, r_isqrt(shl64(vec2u(m, 0u), 23u)), (k - 23i) / 2i + 23i);
}
fn r_sq(a: u32) -> u32 { return r_mul(a, a); }
fn r_p4(a: u32) -> u32 { return r_sq(r_sq(a)); }

// ---------- to integers ----------
// floor(a 2^s) as a signed 64-bit integer, for results under 2^62 in size (past that, 2^62 with a's sign)
fn r_fix(a: u32, s: i32) -> vec2u {
  if (r_z(a)) { return vec2u(0u); }
  let m = r_m(a); let sh = r_e(a) - 23i + s;
  var mag = vec2u(0u); var frac = false;
  if (sh > 38i) { mag = vec2u(0u, 0x40000000u); }
  else if (sh >= 0i) { mag = shl64(vec2u(m, 0u), u32(sh)); }
  else if (sh > -32i) { let k = u32(-sh); mag = vec2u(m >> k, 0u); frac = (m & ((1u << k) - 1u)) != 0u; }
  else { frac = true; }
  if ((a >> 31u) == 0u) { return mag; }
  var v = neg64(mag);
  if (frac) { v = sub64(v, vec2u(1u, 0u)); }
  return v;
}
// a 2^s rounded half up
fn r_round(a: u32, s: i32) -> vec2u {
  let v = add64(r_fix(a, s + 1i), vec2u(1u, 0u));
  return vec2u((v.x >> 1u) | (v.y << 31u), bitcast<u32>(bitcast<i32>(v.y) >> 1u));
}
// a 2^s rounded to a whole number from 0 to most
fn r_whole(a: u32, most: u32, s: i32) -> u32 {
  let v = r_round(a, s);
  if ((v.y >> 31u) == 1u) { return 0u; }
  if (v.y != 0u || v.x > most) { return most; }
  return v.x;
}

// ---------- log and exp ----------
fn r_log2(a: u32) -> u32 {
  if (r_z(a) || (a >> 31u) == 1u) { return R_NMAX; }
  let v = vec2u(r_lg2m(r_m(a) << 8u), bitcast<u32>(r_e(a)));
  if (isneg64(v)) { return r_norm(0x80000000u, neg64(v), -32i); }
  return r_norm(0u, v, -32i);
}
fn r_exp2(z: u32) -> u32 {
  if (r_ge(z, ${rw(128)})) { return R_MAX; }
  if (r_lt(z, ${rw(-126)})) { return 0u; }
  let v = r_fix(z, 32i);
  return r_make(0u, e2f(v.x) >> 8u, bitcast<i32>(v.y));
}
fn r_pow(x: u32, y: u32) -> u32 { if (r_z(x) || (x >> 31u) == 1u) { return 0u; } return r_exp2(r_mul(y, r_log2(x))); }
fn r_exp(x: u32) -> u32 { return r_exp2(r_mul(x, ${rw(Math.LOG2E)})); }
fn r_ln(x: u32) -> u32 { if (r_z(x) || (x >> 31u) == 1u) { return R_NMAX; } return r_mul(r_log2(x), ${rw(Math.LN2)}); }
fn r_cbrt(x: u32) -> u32 { return r_pow(x, ${rw(1 / 3)}); }
`;
