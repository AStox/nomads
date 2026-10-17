// Real numbers for laws whose quantities span too many decades for one fixed point (the fire's beds: pieces from a grass
// blade's 10^-5 kg to a log's, fluxes to the fourth power of a flame's warmth), the TypeScript twin of wgsl/real.ts:
// every function here returns exactly what its WGSL namesake returns on any GPU, bit for bit (docs/research/
// fire-constants.md sec. 37).
//
// A real is a word laid out as IEEE 754's single precision (R1200: a sign, 8 exponent bits, 23 stored bits of a 24-bit
// mantissa), and the WGSL works it with integer operations only, so no GPU's float unit decides a bit. Unlike a float:
// every result is the exact result truncated toward zero to 24 bits; nothing is subnormal (a result under 2^-126 is
// 0) or infinite (a result of 2^128 or more is the largest real, MAXR, with its sign); there is no -0 and no NaN (0 / 0
// is 0, x / 0 is MAXR with x's sign, the square root or the log of a number not above 0 is 0 or -MAXR).
//
// Here a real is a JavaScript number holding that value exactly. mul, div and sqrt are the double's own operation
// truncated: a double holds two 24-bit mantissas' product exactly, and a quotient or a square root of 24-bit reals lies
// further from every 24-bit value it isn't than a double's rounding moves it (2^-48 of it against 2^-53). add finds the
// double's rounding error exactly (Knuth's TwoSum, R1201) and steps down where the truncation of the exact sum is below the
// rounded one. log2 and exp2 run fixed.ts's cores (lg2m, e2f) on integers held exactly in doubles.
//
// Error bounds against the exact value: add, sub, mul, div, sqrt under one unit in the 24th bit (2^-23 of the result);
// log2 under 2^-23 of the result plus 2^-30; exp2 under 2^-22 of the result; pow(x, y) under 2^-22 + |y log2 x| 2^-23 of
// the result (real.test.ts checks them).
import { EXP2_TABLE, LN2 } from "./fixed";

const F = new Float64Array(1), W = new Uint32Array(F.buffer);
const F32 = new Float32Array(1), U32 = new Uint32Array(F32.buffer);
const TWO32 = 4294967296;
export const MINR = 2 ** -126, MAXR = (2 - 2 ** -23) * 2 ** 127;

// x truncated toward zero to a real: what every operation's exact result comes to.
export function T(x: number): number {
  const a = x < 0 ? -x : x;
  if (!(a >= MINR)) return 0;
  if (a >= 2 ** 128) return x < 0 ? -MAXR : MAXR;
  F[0] = x;
  W[0] &= 0xe0000000;
  return F[0];
}
// A real's word, and the real a word holds.
export function bits(x: number): number {
  if (x === 0) return 0;
  F32[0] = x;
  return U32[0];
}
export function real(w: number): number {
  U32[0] = w;
  return F32[0];
}
// The real next toward zero from a real s that isn't 0.
function down(s: number) {
  F[0] = s;
  const e = ((W[1] >>> 20) & 0x7ff) - 1023, pow2 = (W[1] & 0xfffff) === 0 && W[0] === 0, step = 2 ** (pow2 ? e - 24 : e - 23);
  return T(s < 0 ? s + step : s - step);
}

// ---------- arithmetic ----------
export function add(a: number, b: number): number {
  const s = a + b;
  if (s === 0) return 0;
  const bb = s - a, err = a - (s - bb) + (b - bb), t = T(s);
  return err !== 0 && t === s && err < 0 !== s < 0 ? down(s) : t;
}
export const sub = (a: number, b: number) => add(a, 0 - b);
export const mul = (a: number, b: number) => T(a * b);
export const div = (a: number, b: number) => (b === 0 ? (a === 0 ? 0 : a < 0 ? -MAXR : MAXR) : T(a / b));
export const sqrt = (a: number) => (a > 0 ? T(Math.sqrt(a)) : 0);
export const sq = (a: number) => mul(a, a);
export const p4 = (a: number) => sq(sq(a));

// ---------- log and exp ----------
// floor(a * b / 2^32) for u32 a and b, from 16-bit halves of a.
function mulhi(a: number, b: number) {
  const ah = a >>> 16, al = a & 0xffff;
  return Math.floor((ah * b + Math.floor((al * b) / 65536)) / 65536);
}
// fixed.ts lg2m: log2(m / 2^31) in Q0.32 for m in [2^31, 2^32), by 32 squarings.
export function lg2m(m: number): number {
  let y = m, f = 0;
  for (let i = 0; i < 32; i++) {
    const yh = y >>> 16, yl = y & 0xffff, y31 = 2 * yh * yh + Math.floor((2 * yh * yl * 65536 + yl * yl) / 2147483648);
    f *= 2;
    if (y31 >= TWO32) { y = Math.floor(y31 / 2); f += 1; } else y = y31;
  }
  return f;
}
// fixed.ts e2f: 2^f in Q1.31 for a Q0.32 fraction f.
export function e2f(f: number): number {
  const top = EXP2_TABLE[f >>> 24], t = mulhi((f << 8) >>> 0, LN2) >>> 8;
  const t2 = mulhi(t, t), t3 = mulhi(t2, t), t4 = mulhi(t3, t);
  const s = (t + (t2 >>> 1) + Math.floor(t3 / 6) + Math.floor(t4 / 24)) >>> 0;
  return (top + mulhi(top, s)) >>> 0;
}
// log2(a) for a > 0 (-MAXR for any other a): the exponent plus lg2m of the mantissa, truncated.
export function log2(a: number): number {
  if (!(a > 0)) return -MAXR;
  F[0] = a;
  const e = ((W[1] >>> 20) & 0x7ff) - 1023, m = (((W[1] & 0xfffff) << 3) | (W[0] >>> 29)) + 0x800000;
  return T(e + lg2m(m * 256) / TWO32);
}
// 2^z: MAXR from z = 128, 0 under z = -126; else 2^floor(z) times e2f of the rest in Q0.32 (floored), truncated.
export function exp2(z: number): number {
  if (z >= 128) return MAXR;
  if (z < -126) return 0;
  const V = Math.floor(z * TWO32), k = Math.floor(V / TWO32);
  return T((e2f(V - k * TWO32) >>> 8) * 2 ** (k - 23));
}
const LOG2E = T(Math.LOG2E), LN2R = T(Math.LN2), THIRD = T(1 / 3);
export const pow = (x: number, y: number) => (x > 0 ? exp2(mul(y, log2(x))) : 0);
export const exp = (x: number) => exp2(mul(x, LOG2E));
export const ln = (x: number) => (x > 0 ? mul(log2(x), LN2R) : -MAXR);
export const cbrt = (x: number) => pow(x, THIRD);

// ---------- to integers ----------
// floor(a 2^s), and a 2^s rounded half up (as Math.round rounds), for results under 2^53 in size.
export const fix = (a: number, s: number) => Math.floor(a * 2 ** s);
export const round = (a: number, s = 0) => Math.floor(a * 2 ** s + 0.5);
// A real rounded to a whole number from 0 to most.
export const whole = (a: number, most: number, s = 0) => Math.min(most, Math.max(0, round(a, s)));
