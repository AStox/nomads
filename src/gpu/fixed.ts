// Fixed-point arithmetic for the world's kernels, the TypeScript twin of wgsl/fixed.ts: every function here returns
// exactly what its WGSL namesake returns on any GPU, bit for bit, using only 32-bit integer operations.
//
// Formats:
// - Q16.16: a number x held as the i32 round(x * 2^16), so from -32768 to 32767.99998 in steps of 2^-16 (1.53e-5).
//   Results past the range saturate to +-0x7fffffff (never 0x80000000, so negating a result is always safe).
// - Q32.32: a number held as a signed 64-bit integer x * 2^32 in two u32 words (lo, hi), two's complement, for
//   intermediates and for values past Q16.16's range (lnGamma of large arguments).
// - Q0.32 and Q1.31: unsigned fractions in one u32 (a uniform word is a Q0.32 number in [0, 1)).
//
// Error bounds against float64 of the exact input value (an ulp is 2^-16), each checked over dense grids in
// fixed.test.ts:
// - qadd: exact. qmul, qdiv: correctly rounded, ties away from zero (at most 0.5 ulp). qsqrt: floored (under 1 ulp).
// - qlog2, qln: at most 0.5 ulp + 2^-26. qexp: at most 0.5 ulp + 2^-29 of the result.
// - qpow(x, y): at most 0.5 ulp + 2^-28 (1 + |y log2 x|) of the result.
// - qlgamma(x): at most 0.5 ulp + x 2^-29 (it saturates past x = 4,100); lgamma32 within 2^-28 + x 2^-30 over every
//   positive Q16.16 x. qgamma: at most 0.5 ulp + 2^-27 of the result (it saturates outside (3.05e-5, 8.6)).
// Underneath, log2 of a Q1.31 mantissa comes from 32 repeated squarings (to about 2^-30), and 2^f from a 256-entry
// table and four terms of a series (to about 2^-30 of the result).

export type U64 = [lo: number, hi: number];

// ---------- 64-bit words ----------
// The full product of two u32 as (lo, hi), formed from 16-bit halves as the WGSL does.
export function mul64(a: number, b: number): U64 {
  const a0 = a & 0xffff, a1 = a >>> 16, b0 = b & 0xffff, b1 = b >>> 16;
  const p00 = a0 * b0, p01 = a0 * b1, p10 = a1 * b0, p11 = a1 * b1;
  const mid = (p00 >>> 16) + (p01 & 0xffff) + (p10 & 0xffff);
  const hi = (p11 + (p01 >>> 16) + (p10 >>> 16) + (mid >>> 16)) >>> 0;
  return [Math.imul(a, b) >>> 0, hi];
}
export const mulhi = (a: number, b: number) => mul64(a, b)[1];
export function add64(a: U64, b: U64): U64 {
  const lo = (a[0] + b[0]) >>> 0;
  return [lo, (a[1] + b[1] + (lo < a[0] ? 1 : 0)) >>> 0];
}
export function sub64(a: U64, b: U64): U64 {
  return [(a[0] - b[0]) >>> 0, (a[1] - b[1] - (a[0] < b[0] ? 1 : 0)) >>> 0];
}
export const neg64 = (a: U64): U64 => sub64([0, 0], a);
export const lt64 = (a: U64, b: U64) => a[1] < b[1] || (a[1] === b[1] && a[0] < b[0]);
export const isNeg64 = (a: U64) => a[1] >>> 31 === 1;
const abs64 = (a: U64): U64 => (isNeg64(a) ? neg64(a) : a);
// floor(a * c / 2^32) for an unsigned 64-bit a.
export function mulhi64(a: U64, c: number): U64 {
  const p0 = mul64(a[0], c), p1 = mul64(a[1], c);
  return add64([p0[1], 0], p1);
}
// a * c / 2^32 for a signed 64-bit a, truncated toward zero.
export function smulhi64(a: U64, c: number): U64 {
  const m = mulhi64(abs64(a), c);
  return isNeg64(a) ? neg64(m) : m;
}
// floor((a * c) / 2^16) for an unsigned 64-bit a and a u32 c, saturating to 2^63 - 1.
function mulshr16(a: U64, c: number): U64 {
  const p0 = mul64(a[0], c), p1 = mul64(a[1], c);
  const w1 = (p0[1] + p1[0]) >>> 0, w2 = (p1[1] + (w1 < p0[1] ? 1 : 0)) >>> 0;
  const lo = ((p0[0] >>> 16) | (w1 << 16)) >>> 0, hi = ((w1 >>> 16) | (w2 << 16)) >>> 0;
  return w2 >>> 15 !== 0 ? [0xffffffff, 0x7fffffff] : [lo, hi];
}
// (q, r) with q = floor((rhi * 2^32 + lo) / d) and r the remainder, for rhi < d, by binary long division.
export function divw(rhi: number, lo: number, d: number): U64 {
  let r = rhi >>> 0, q = 0;
  for (let b = 0; b < 32; b++) {
    const top = r >>> 31;
    r = ((r << 1) | ((lo >>> (31 - b)) & 1)) >>> 0;
    q = (q << 1) >>> 0;
    if (top === 1 || r >= d) { r = (r - d) >>> 0; q = (q | 1) >>> 0; }
  }
  return [q, r];
}
// A Q32.32 number rounded to Q16.16 (half away from zero... ties upward), saturating.
export function round16(v: U64): number {
  const s = add64(v, [0x8000, 0]), hi = s[1] | 0;
  if (hi >= 0x8000) return 0x7fffffff;
  if (hi < -0x8000) return -0x7fffffff;
  return Math.max(-0x7fffffff, ((s[0] >>> 16) | (s[1] << 16)) | 0);
}
// A Q16.16 number widened to Q32.32.
export const wide = (x: number): U64 => [(x << 16) >>> 0, (x >> 16) >>> 0];
const mag = (x: number) => (x < 0 ? -x : x) >>> 0;
const MAX = 0x7fffffff;

// ---------- Q16.16 arithmetic ----------
export const ONE = 0x10000;
export const toQ = (x: number) => Math.round(x * ONE) | 0;
export const fromQ = (q: number) => q / ONE;

// a + b, saturating.
export function qadd(a: number, b: number): number {
  const s = a + b;
  return s > MAX ? MAX : s < -MAX ? -MAX : s;
}
// a * b, correctly rounded, saturating.
export function qmul(a: number, b: number): number {
  const p = add64(mul64(mag(a), mag(b)), [0x8000, 0]);
  if (p[1] >= 0x8000) return (a < 0) !== (b < 0) ? -MAX : MAX;
  const r = ((p[0] >>> 16) | (p[1] << 16)) >>> 0;
  return (a < 0) !== (b < 0) ? -r | 0 : r | 0;
}
// a / b, correctly rounded, saturating; a / 0 saturates by the sign of a (0 / 0 is 0).
export function qdiv(a: number, b: number): number {
  const neg = (a < 0) !== (b < 0);
  if (b === 0) return a > 0 ? MAX : a < 0 ? -MAX : 0;
  const A = mag(a), B = mag(b);
  const num = add64([(A << 16) >>> 0, A >>> 16], [B >>> 1, 0]);
  if (num[1] >= B) return neg ? -MAX : MAX;
  const q = Math.min(divw(num[1], num[0], B)[0], MAX);
  return neg ? -q : q;
}
// sqrt(a) for a >= 0, floored; 0 for a <= 0.
export function qsqrt(a: number): number {
  if (a <= 0) return 0;
  const n: U64 = [(a << 16) >>> 0, a >>> 16];
  let r = 0;
  for (let bit = 1 << 23; bit !== 0; bit >>>= 1) {
    const c = r | bit;
    if (!lt64(n, mul64(c, c))) r = c;
  }
  return r;
}

// ---------- log and exp cores ----------
// log2(m / 2^31) as a Q0.32 fraction, for m in [2^31, 2^32), by repeated squaring: each squaring of y in [1, 2)
// yields the next binary digit of log2 y.
export function lg2m(m: number): number {
  let y = m >>> 0, f = 0;
  for (let i = 0; i < 32; i++) {
    const p = mul64(y, y);
    f = (f << 1) >>> 0;
    if (p[1] >= 0x80000000) { y = p[1]; f = (f | 1) >>> 0; }
    else y = ((p[1] << 1) | (p[0] >>> 31)) >>> 0;
  }
  return f;
}
// 2^(j/256) in Q1.31 for j = 0..255, rounded to nearest; float64's pow is exact to far finer than the rounding step
// (fixed.test.ts checks every entry lies at least 2^-12 of a step away from a rounding boundary).
export const EXP2_TABLE: readonly number[] = Array.from({ length: 256 }, (_, j) => Math.round(2 ** (j / 256) * 2 ** 31));
// ln 2 in Q0.32, and log2(e) - 1 in Q0.32 (both rounded).
export const LN2 = 2977044472, LOG2E_1 = 1901360723;
// 2^f in Q1.31 for a Q0.32 fraction f: the table at f's top 8 bits times exp(t), t = ln2 * the low 24 bits, from
// four terms of its series (the fifth is under 2^-45).
export function e2f(f: number): number {
  const T = EXP2_TABLE[f >>> 24], t = mulhi((f << 8) >>> 0, LN2) >>> 8;
  const t2 = mulhi(t, t), t3 = mulhi(t2, t), t4 = mulhi(t3, t);
  const s = (t + (t2 >>> 1) + Math.floor(t3 / 6) + Math.floor(t4 / 24)) >>> 0;
  return (T + mulhi(T, s)) >>> 0;
}
// log2(x) in Q32.32 for a u32 x read as Q16.16; x must be positive.
export function lg32(x: number): U64 {
  const c = Math.clz32(x), m = (x << c) >>> 0;
  return [lg2m(m), (15 - c) >>> 0];
}
// ln(x) in Q32.32 for a u32 x read as Q16.16 (truncated toward zero).
export const ln32 = (x: number): U64 => smulhi64(lg32(x), LN2);
// 2^t in Q16.16 for t in Q32.32, rounded, saturating; 0 where the result is under half an ulp.
export function exp2q(t: U64): number {
  const k = t[1] | 0;
  if (k >= 15) return MAX;
  if (k < -17) return 0;
  const y = e2f(t[0]), s = 15 - k;
  if (s === 32) return 1;
  return Math.min(((y >>> s) + ((y >>> (s - 1)) & 1)) >>> 0, MAX);
}

// ---------- Q16.16 transcendental functions ----------
// log2(x) and ln(x); a non-positive x gives -0x7fffffff.
export const qlog2 = (x: number) => (x <= 0 ? -MAX : round16(lg32(x)));
export const qln = (x: number) => (x <= 0 ? -MAX : round16(ln32(x)));
// x * log2(e) in Q32.32 for a Q16.16 x.
export function tolog2(v: U64): U64 {
  return add64(v, smulhi64(v, LOG2E_1));
}
// e^x.
export const qexp = (x: number) => exp2q(tolog2(wide(x)));
// x^y for x > 0 (0 for x <= 0).
export function qpow(x: number, y: number): number {
  if (x <= 0) return 0;
  const L = lg32(x), p = mulshr16(abs64(L), mag(y));
  return exp2q(isNeg64(L) !== y < 0 ? neg64(p) : p);
}

// ---------- gamma ----------
export const HALF_LN_2PI: U64 = [3946810947, 0];
// lnGamma(x) in Q32.32 for a Q16.16 x > 0 (any positive Q16.16; the result reaches 3.1e5 at x = 32768): Stirling's
// series with four terms at z >= 8 (the next is under 1/(1188 z^9) = 6e-12), after shifting x up by the recurrence.
export function lgamma32(x: number): U64 {
  let z = x >>> 0, mp = 0x80000000, ep = -31, shifted = false;
  while (z < 8 << 16) {
    const c = Math.clz32(z), f = (z << c) >>> 0, p = mul64(mp, f);
    if (p[1] >= 0x80000000) { mp = p[1]; ep += 16 - c; }
    else { mp = ((p[1] << 1) | (p[0] >>> 31)) >>> 0; ep += 15 - c; }
    z = (z + ONE) >>> 0;
    shifted = true;
  }
  const lnz = ln32(z);
  let s = mulshr16(lnz, (z - 0x8000) >>> 0);
  s = sub64(s, [(z << 16) >>> 0, z >>> 16]);
  s = add64(s, HALF_LN_2PI);
  const w = divw(ONE, 0, z)[0], w2 = mulhi(w, w), w3 = mulhi(w2, w), w5 = mulhi(w3, w2), w7 = mulhi(w5, w2);
  const series = (Math.floor(w / 12) - Math.floor(w3 / 360) + Math.floor(w5 / 1260) - Math.floor(w7 / 1680)) >>> 0;
  s = add64(s, [series, 0]);
  if (shifted) s = sub64(s, smulhi64([lg2m(mp), (ep + 31) >>> 0], LN2));
  return s;
}
// lnGamma(x) and Gamma(x) in Q16.16 for x > 0 (saturating past x = 4,100 and outside (3.05e-5, 8.6) respectively);
// a non-positive x gives 0x7fffffff.
export const qlgamma = (x: number) => (x <= 0 ? MAX : round16(lgamma32(x)));
export const qgamma = (x: number) => (x <= 0 ? MAX : exp2q(tolog2(lgamma32(x))));
