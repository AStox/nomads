// The world's fixed-point arithmetic in WGSL, one function for each of its TypeScript twins in ../fixed.ts (formats,
// ranges and error bounds are described there). A 64-bit integer is a vec2u (lo, hi), two's complement when signed.
// A kernel that needs these puts FIXED ahead of its own source.
import { EXP2_TABLE, HALF_LN_2PI, LN2, LOG2E_1 } from "../fixed";

export const FIXED = /* wgsl */ `
const FX_MAX = 0x7fffffffi;
const FX_ONE = 0x10000u;
const LN2_32 = ${LN2}u;
const LOG2E_1 = ${LOG2E_1}u;
const EXP2_TABLE = array<u32, 256>(${EXP2_TABLE.map((v) => `${v}u`).join(", ")});

fn mul64(a: u32, b: u32) -> vec2u {
  let a0 = a & 0xffffu; let a1 = a >> 16u; let b0 = b & 0xffffu; let b1 = b >> 16u;
  let p00 = a0 * b0; let p01 = a0 * b1; let p10 = a1 * b0; let p11 = a1 * b1;
  let mid = (p00 >> 16u) + (p01 & 0xffffu) + (p10 & 0xffffu);
  return vec2u(a * b, p11 + (p01 >> 16u) + (p10 >> 16u) + (mid >> 16u));
}
fn mulhi(a: u32, b: u32) -> u32 { return mul64(a, b).y; }
fn add64(a: vec2u, b: vec2u) -> vec2u { let lo = a.x + b.x; return vec2u(lo, a.y + b.y + select(0u, 1u, lo < a.x)); }
fn sub64(a: vec2u, b: vec2u) -> vec2u { return vec2u(a.x - b.x, a.y - b.y - select(0u, 1u, a.x < b.x)); }
fn neg64(a: vec2u) -> vec2u { return sub64(vec2u(0u), a); }
fn lt64(a: vec2u, b: vec2u) -> bool { return a.y < b.y || (a.y == b.y && a.x < b.x); }
fn isneg64(a: vec2u) -> bool { return (a.y >> 31u) == 1u; }
fn abs64(a: vec2u) -> vec2u { return select(a, neg64(a), isneg64(a)); }
fn mulhi64(a: vec2u, c: u32) -> vec2u { let p0 = mul64(a.x, c); let p1 = mul64(a.y, c); return add64(vec2u(p0.y, 0u), p1); }
fn smulhi64(a: vec2u, c: u32) -> vec2u { let m = mulhi64(abs64(a), c); return select(m, neg64(m), isneg64(a)); }
fn mulshr16(a: vec2u, c: u32) -> vec2u {
  let p0 = mul64(a.x, c); let p1 = mul64(a.y, c);
  let w1 = p0.y + p1.x; let w2 = p1.y + select(0u, 1u, w1 < p0.y);
  if ((w2 >> 15u) != 0u) { return vec2u(0xffffffffu, 0x7fffffffu); }
  return vec2u((p0.x >> 16u) | (w1 << 16u), (w1 >> 16u) | (w2 << 16u));
}
fn divw(rhi: u32, lo: u32, d: u32) -> vec2u {
  var r = rhi; var q = 0u;
  for (var b = 0u; b < 32u; b++) {
    let top = r >> 31u;
    r = (r << 1u) | ((lo >> (31u - b)) & 1u);
    q = q << 1u;
    if (top == 1u || r >= d) { r = r - d; q = q | 1u; }
  }
  return vec2u(q, r);
}
fn round16(v: vec2u) -> i32 {
  let s = add64(v, vec2u(0x8000u, 0u)); let hi = bitcast<i32>(s.y);
  if (hi >= 0x8000i) { return FX_MAX; }
  if (hi < -0x8000i) { return -FX_MAX; }
  return max(-FX_MAX, bitcast<i32>((s.x >> 16u) | (s.y << 16u)));
}
fn wide(x: i32) -> vec2u { return vec2u(bitcast<u32>(x) << 16u, bitcast<u32>(x >> 16u)); }
fn mag(x: i32) -> u32 { return select(bitcast<u32>(x), 0u - bitcast<u32>(x), x < 0i); }

fn qadd(a: i32, b: i32) -> i32 {
  let s = a + b;
  if (a > 0i && b > 0i && s < 0i) { return FX_MAX; }
  if (a < 0i && b < 0i && s >= 0i) { return -FX_MAX; }
  return max(s, -FX_MAX);
}
fn qmul(a: i32, b: i32) -> i32 {
  let neg = (a < 0i) != (b < 0i);
  let p = add64(mul64(mag(a), mag(b)), vec2u(0x8000u, 0u));
  if (p.y >= 0x8000u) { return select(FX_MAX, -FX_MAX, neg); }
  let r = bitcast<i32>((p.x >> 16u) | (p.y << 16u));
  return select(r, -r, neg);
}
fn qdiv(a: i32, b: i32) -> i32 {
  let neg = (a < 0i) != (b < 0i);
  if (b == 0i) { return select(select(0i, -FX_MAX, a < 0i), FX_MAX, a > 0i); }
  let A = mag(a); let B = mag(b);
  let num = add64(vec2u(A << 16u, A >> 16u), vec2u(B >> 1u, 0u));
  if (num.y >= B) { return select(FX_MAX, -FX_MAX, neg); }
  let q = bitcast<i32>(min(divw(num.y, num.x, B).x, 0x7fffffffu));
  return select(q, -q, neg);
}
fn qsqrt(a: i32) -> i32 {
  if (a <= 0i) { return 0i; }
  let n = vec2u(bitcast<u32>(a) << 16u, bitcast<u32>(a) >> 16u);
  var r = 0u;
  for (var bit = 1u << 23u; bit != 0u; bit = bit >> 1u) {
    let c = r | bit;
    if (!lt64(n, mul64(c, c))) { r = c; }
  }
  return bitcast<i32>(r);
}

fn lg2m(m: u32) -> u32 {
  var y = m; var f = 0u;
  for (var i = 0u; i < 32u; i++) {
    let p = mul64(y, y);
    f = f << 1u;
    if (p.y >= 0x80000000u) { y = p.y; f = f | 1u; } else { y = (p.y << 1u) | (p.x >> 31u); }
  }
  return f;
}
fn e2f(f: u32) -> u32 {
  let T = EXP2_TABLE[f >> 24u]; let t = mulhi(f << 8u, LN2_32) >> 8u;
  let t2 = mulhi(t, t); let t3 = mulhi(t2, t); let t4 = mulhi(t3, t);
  let s = t + (t2 >> 1u) + t3 / 6u + t4 / 24u;
  return T + mulhi(T, s);
}
fn lg32(x: u32) -> vec2u { let c = countLeadingZeros(x); return vec2u(lg2m(x << c), 15u - c); }
fn ln32(x: u32) -> vec2u { return smulhi64(lg32(x), LN2_32); }
fn exp2q(t: vec2u) -> i32 {
  let k = bitcast<i32>(t.y);
  if (k >= 15i) { return FX_MAX; }
  if (k < -17i) { return 0i; }
  let y = e2f(t.x); let s = u32(15i - k);
  if (s == 32u) { return 1i; }
  return bitcast<i32>(min((y >> s) + ((y >> (s - 1u)) & 1u), 0x7fffffffu));
}

fn qlog2(x: i32) -> i32 { if (x <= 0i) { return -FX_MAX; } return round16(lg32(bitcast<u32>(x))); }
fn qln(x: i32) -> i32 { if (x <= 0i) { return -FX_MAX; } return round16(ln32(bitcast<u32>(x))); }
fn tolog2(v: vec2u) -> vec2u { return add64(v, smulhi64(v, LOG2E_1)); }
fn qexp(x: i32) -> i32 { return exp2q(tolog2(wide(x))); }
fn qpow(x: i32, y: i32) -> i32 {
  if (x <= 0i) { return 0i; }
  let L = lg32(bitcast<u32>(x)); let p = mulshr16(abs64(L), mag(y));
  return exp2q(select(p, neg64(p), isneg64(L) != (y < 0i)));
}

fn lgamma32(x: u32) -> vec2u {
  var z = x; var mp = 0x80000000u; var ep = -31i; var shifted = false;
  while (z < (8u << 16u)) {
    let c = countLeadingZeros(z); let p = mul64(mp, z << c);
    if (p.y >= 0x80000000u) { mp = p.y; ep += 16i - i32(c); }
    else { mp = (p.y << 1u) | (p.x >> 31u); ep += 15i - i32(c); }
    z = z + FX_ONE;
    shifted = true;
  }
  var s = mulshr16(ln32(z), z - 0x8000u);
  s = sub64(s, vec2u(z << 16u, z >> 16u));
  s = add64(s, vec2u(${HALF_LN_2PI[0]}u, ${HALF_LN_2PI[1]}u));
  let w = divw(FX_ONE, 0u, z).x; let w2 = mulhi(w, w); let w3 = mulhi(w2, w); let w5 = mulhi(w3, w2); let w7 = mulhi(w5, w2);
  s = add64(s, vec2u(w / 12u - w3 / 360u + w5 / 1260u - w7 / 1680u, 0u));
  if (shifted) { s = sub64(s, smulhi64(vec2u(lg2m(mp), bitcast<u32>(ep + 31i)), LN2_32)); }
  return s;
}
fn qlgamma(x: i32) -> i32 { if (x <= 0i) { return FX_MAX; } return round16(lgamma32(bitcast<u32>(x))); }
fn qgamma(x: i32) -> i32 { if (x <= 0i) { return FX_MAX; } return exp2q(tolog2(lgamma32(bitcast<u32>(x)))); }
`;
