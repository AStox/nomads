// Randomness for the world's kernels, the TypeScript twin of wgsl/rand.ts: every draw here equals its WGSL namesake's
// bit for bit. Every draw is a pure function of (world seed, stream, object id, tick): the counter-based generator
// Philox4x32-10 (Salmon, Moraes, Dror and Shaw 2011, "Parallel random numbers: as easy as 1, 2, 3"), keyed by
// (seed, stream) and counting from (id, tick, 0, 0). A kernel opens its draws with rinit and then reads the stream
// word by word; nothing depends on the order threads run in.
//
// The generator's counter is (id, tick, block, slot): slot 0 is the plain stream, block counting its 128-bit blocks;
// slot j >= 1 is the j-th lazily read uniform of the exact samplers, block its 128-bit words in order of significance,
// so such a uniform is a real number in [0, 1) with as many binary digits as a comparison ever asks for; slot
// 0xffffffff holds the Feistel round keys.
//
// The distributions (qunif, qexpo, qnormal, qpoisson, qgammav, qlognormal, qweibull) are their textbook methods carried
// out in fixed point: deterministic everywhere, and as close to their laws as Q16.16 and 32-bit uniforms allow (moments
// checked in rand.test.ts). They return Q16.16 (fixed.ts) unless they count. The exact samplers (binhalf, binom,
// multinom, bernpow, geowait) are exact in distribution: their only arithmetic is integer comparison with uniforms read
// to as many digits as needed, so the law they draw from is the mathematical one, not a rounding of it (binhalf's one
// undecided corner, about a 2^-203 a proposal for an offset a, is described at slowAccept).
import { type U64, LN2, ONE, add64, divw, lg2m, ln32, lgamma32, lt64, mul64, neg64, qadd, qdiv, qexp, qln, qmul, qpow, qsqrt, round16, smulhi64, sub64, wide } from "./fixed";

// ---------- Philox4x32-10 ----------
const M0 = 0xd2511f53, M1 = 0xcd9e8d57, W0 = 0x9e3779b9, W1 = 0xbb67ae85;
export function philox(c: readonly number[], k: readonly number[]): number[] {
  let c0 = c[0], c1 = c[1], c2 = c[2], c3 = c[3], k0 = k[0], k1 = k[1];
  for (let r = 0; r < 10; r++) {
    const x = mul64(M0, c0), y = mul64(M1, c2);
    c0 = (y[1] ^ c1 ^ k0) >>> 0; c1 = y[0]; c2 = (x[1] ^ c3 ^ k1) >>> 0; c3 = x[0];
    k0 = (k0 + W0) >>> 0; k1 = (k1 + W1) >>> 0;
  }
  return [c0, c1, c2, c3];
}

// ---------- the stream ----------
// The draw state of one invocation, as the WGSL keeps it in private variables.
const S = { key: [0, 0], id: 0, tick: 0, block: 0, buf: [0, 0, 0, 0], idx: 4, uj: 1, flags: 0, force: 0 };
// Opens the stream of (seed, stream, id, tick); flags counts the exact sampler's undecided cases (see slowAccept), and
// force sends every binhalf acceptance through the slow path (for tests).
export function rinit(seed: number, stream: number, id: number, tick: number, force = 0) {
  S.key = [seed >>> 0, stream >>> 0]; S.id = id >>> 0; S.tick = tick >>> 0; S.block = 0; S.idx = 4; S.uj = 1; S.flags = 0; S.force = force;
}
export const rflags = () => S.flags;
export function next32(): number {
  if (S.idx === 4) { S.buf = philox([S.id, S.tick, S.block, 0], S.key); S.block = (S.block + 1) >>> 0; S.idx = 0; }
  return S.buf[S.idx++];
}
// Words 4b..4b+3 of the lazily read uniform j, most significant first.
const uword = (j: number, b: number) => philox([S.id, S.tick, b, j], S.key);
// An exactly uniform integer in [0, m), m >= 1 (Lemire 2019, "Fast random integer generation in an interval").
export function unif(m: number): number {
  for (;;) {
    const p = mul64(next32(), m);
    if (p[0] >= m) return p[1];
    if (p[0] >= (0x100000000 % m)) return p[1];
  }
}

// ---------- distributions ----------
// A uniform in [0, 1) at Q16.16.
export const qunif = () => next32() >>> 16;
// -ln((u + 1) / 2^32) in Q32.32: the exponential quantile of a uniform word, from 0 up to 22.18.
export function nlnu(u: number): U64 {
  if (u === 0xffffffff) return [0, 0];
  const v = u + 1, c = Math.clz32(v);
  return neg64(smulhi64([lg2m((v << c) >>> 0), (-1 - c) >>> 0], LN2));
}
// Exp(1).
export const qexpo = () => round16(nlnu(next32()));
// The integer square root of a 64-bit number, floored.
export function isqrt64(s: U64): number {
  let r = 0;
  for (let bit = 1 << 30; bit !== 0; bit >>>= 1) { const c = (r | bit) >>> 0; if (!lt64(s, mul64(c, c))) r = c; }
  return r;
}
// N(0, 1), by Marsaglia's polar method on two words read as Q0.31 numbers u, v in [-1, 1): z = u sqrt(-2 ln s / s),
// s = u^2 + v^2, with s < 1 and s > 0.
export function qnormal(): number {
  for (;;) {
    const u = next32() | 0, v = next32() | 0;
    const au = Math.abs(u) >>> 0, av = Math.abs(v) >>> 0;
    const s = add64(mul64(au, au), mul64(av, av));
    if (s[1] >= 0x40000000 || (s[0] === 0 && s[1] === 0)) continue;
    const c = s[1] !== 0 ? Math.clz32(s[1]) : 32 + Math.clz32(s[0]);
    const top = c < 32 ? ((s[1] << c) | (s[0] >>> (32 - c))) >>> 0 : (s[0] << (c - 32)) >>> 0;
    const R = neg64(smulhi64([lg2m(top), (1 - c) >>> 0], LN2));
    const rad = qsqrt(round16(add64(R, R)));
    const cos = divw(au >>> 16, (au << 16) >>> 0, isqrt64(s))[0];
    const z = qmul(rad, cos);
    return u < 0 ? -z : z;
  }
}
// Lognormal: e^(mu + sigma z).
export const qlognormal = (mu: number, sigma: number) => qexp(qadd(mu, qmul(sigma, qnormal())));
// The Weibull quantile of a uniform word u: lam (-ln(1 - u))^(1/k).
export const qweibull = (u: number, k: number, lam: number) => qmul(lam, qpow(round16(nlnu(~u >>> 0)), qdiv(ONE, k)));
const slt64 = (a: U64, b: U64) => lt64([a[0], (a[1] ^ 0x80000000) >>> 0], [b[0], (b[1] ^ 0x80000000) >>> 0]);
// Gamma(a, 1) for a > 0 (Marsaglia and Tsang 2000; below a = 1 by the boost u^(1/a)); 0 for a <= 0.
export function qgammav(a: number): number {
  if (a <= 0) return 0;
  const boost = a < ONE, aa = boost ? a + ONE : a, d = aa - 21845, c = qdiv(ONE, 3 * qsqrt(d));
  let g = 0;
  for (;;) {
    const x = qnormal(), t = ONE + qmul(c, x);
    if (t <= 0) continue;
    const v = qmul(qmul(t, t), t), lu = round16(neg64(nlnu(next32())));
    const rhs = qadd(qadd(qmul(x, x) >> 1, d - qmul(d, v)), qmul(d, qln(v)));
    if (lu < rhs) { g = qmul(d, v); break; }
  }
  return boost ? qmul(g, qpow(Math.max(next32() >>> 16, 1), qdiv(ONE, a))) : g;
}
// Poisson(lam) for lam in Q16.16: below 16 by counting unit exponential gaps in [0, lam); from 16 by Hormann's
// transformed rejection PTRS (Hormann 1993, "The transformed rejection method for generating Poisson random variables").
export const PTRS = [0.931, 2.53, -0.059, 0.02483, 1.1239, 1.1328, 3.4, 0.9277, 3.6224, 0.43, 0.07, 0.013].map((x) => Math.round(x * ONE));
export function qpoisson(lam: number): number {
  if (lam <= 0) return 0;
  if (lam < 16 * ONE) {
    let t: U64 = [0, 0], k = 0;
    const L = wide(lam);
    for (;;) { t = add64(t, nlnu(next32())); if (lt64(L, t)) return k; k++; }
  }
  const [B0, B1, A0, A1, I0, I1, I2, V0, V1, K0, US, UT] = PTRS;
  const b = B0 + qmul(B1, qsqrt(lam)), a = A0 + qmul(A1, b), ia = I0 + qdiv(I1, b - I2), vr = V0 - qdiv(V1, b - 2 * ONE);
  const ll = ln32(lam);
  for (;;) {
    const U = (next32() >>> 16) - 0x8000, V = next32() >>> 16, us = 0x8000 - Math.abs(U);
    if (us === 0) continue;
    const k = qadd(qadd(qmul(qadd(qdiv(2 * a, us), b), U), lam), K0) >> 16;
    if (us >= US && V <= vr) { if (k >= 0) return k; continue; }
    if (k < 0 || (us < UT && V > us)) continue;
    if (V === 0) return k;
    const den = qadd(qdiv(qdiv(a, us), us), b);
    const lhs = sub64(add64(ln32(V), ln32(ia)), ln32(den));
    const kl = mul64(ll[0], k), kh = mul64(ll[1], k);
    const rhs = sub64(sub64([kl[0], (kl[1] + kh[0]) >>> 0], wide(lam)), lgamma32(((k + 1) << 16) >>> 0));
    if (!slt64(rhs, lhs)) return k;
  }
}

// ---------- exact Bin(T, 1/2) ----------
// Q8.56 numbers (a u64 x * 2^56, as (lo, hi)) for the acceptance bounds of the sublinear sampler, after the prototype
// whose bounds were checked against mpmath on 3,060 (N, a) pairs (docs/research/gpu-math.md).
const QMAX: U64 = [0xffffffff, 0xffffffff];
const isMax = (a: U64) => a[0] === 0xffffffff && a[1] === 0xffffffff;
const two56 = 1n << 56n;
const q56 = (v: bigint): U64 => [Number(v & 0xffffffffn), Number(v >> 32n)];
export const LN2F = q56(BigInt("0x00B17217F7D1CF79")), SIXTH = q56(two56 / 6n);
export const CK = Array.from({ length: 16 }, (_, i) => q56(two56 / BigInt((i + 1) * (2 * i + 1))));
export const DK = Array.from({ length: 16 }, (_, i) => q56(two56 / BigInt(2 * (i + 1))));
const subsat = (a: U64, b: U64): U64 => (lt64(a, b) ? [0, 0] : sub64(a, b));
const addsat = (a: U64, b: U64): U64 => { const s = add64(a, b); return lt64(s, a) ? QMAX : s; };
const div64 = (a: U64, d: number): U64 => [divw(a[1] % d, a[0], d)[0], Math.floor(a[1] / d)];
// floor(num * 2^56 / den) in Q8.56 for an integer num, QMAX from 256 up.
function ratioQ(num: U64, den: number): U64 {
  const h = Math.floor(num[1] / den), l = divw(num[1] % den, num[0], den);
  if (h !== 0 || l[0] >= 256) return QMAX;
  const r = l[1], a = divw(r >>> 8, (r << 24) >>> 0, den), b = divw(a[1], 0, den);
  return [b[0], (a[0] | (l[0] << 24)) >>> 0];
}
function mulQ(a: U64, b: U64): U64 {
  const p00 = mul64(a[0], b[0]), p01 = mul64(a[0], b[1]), p10 = mul64(a[1], b[0]), p11 = mul64(a[1], b[1]);
  const mid = add64(add64([p00[1], 0], [p01[0], 0]), [p10[0], 0]);
  const hi = add64(add64(add64(p11, [p01[1], 0]), [p10[1], 0]), [mid[1], 0]);
  if (hi[1] >= 0x01000000) return QMAX;
  return [((mid[0] >>> 24) | (hi[0] << 8)) >>> 0, ((hi[0] >>> 24) | (hi[1] << 8)) >>> 0];
}
const mulk = (a: U64, k: number): U64 => { const l = mul64(a[0], k), h = mul64(a[1], k); return [l[0], (l[1] + h[0]) >>> 0]; };
// Bounds (lo, hi) on -ln q, q = C(2N, N + a) / C(2N, N), for N >= 2048 and a <= N / 8: a Stirling-type series with
// Robbins remainder bounds.
function nlnq(N: number, a: number): [U64, U64] {
  const t = ratioQ(mul64(a, a), N);
  if (isMax(t)) return [QMAX, QMAX];
  const invN = ratioQ([1, 0], N), y = div64(t, N);
  let wk = t, P: U64 = [0, 0], M: U64 = [0, 0];
  for (let k = 0; k < 16; k++) {
    if (wk[1] === 0 && wk[0] < 16) break;
    P = add64(P, k === 0 ? wk : mulQ(wk, CK[k]));
    M = add64(M, mulQ(mulQ(wk, invN), DK[k]));
    wk = mulQ(wk, y);
  }
  const yi = mulQ(y, invN);
  let th1 = yi, tk = yi;
  for (let j = 0; j < 16; j++) { tk = mulQ(tk, y); if (tk[0] === 0 && tk[1] === 0) break; th1 = add64(th1, tk); }
  th1 = mulQ(th1, SIXTH);
  const e3 = add64(div64(mulQ(yi, mulQ(invN, invN)), 16), [2, 0]);
  const mid = add64(subsat(P, M), th1), err = add64([2056, 0], wk);
  return [subsat(subsat(mid, err), e3), add64(mid, err)];
}

// Bin(T, 1/2) by counting ones, for small T.
function popbin(T: number): number {
  let ones = 0;
  for (let left = T; left > 0; ) {
    const take = Math.min(left, 32), r = next32();
    ones += popcount(take === 32 ? r : r & ((1 << take) - 1));
    left -= take;
  }
  return ones;
}
export function popcount(v: number): number {
  v = v - ((v >>> 1) & 0x55555555);
  v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
  return (Math.imul((v + (v >>> 4)) & 0x0f0f0f0f, 0x01010101) >>> 24);
}
// u_j < u_i for lazily read uniforms whose first words are a and b: compared word by word, reading further words only
// while they agree, so the comparison is exact.
function uless(j: number, a: readonly number[], i: number, b: readonly number[]): boolean {
  for (let blk = 0; ; blk++) {
    const A = blk === 0 ? a : uword(j, blk), B = blk === 0 ? b : uword(i, blk);
    for (let w = 0; w < 4; w++) if (A[w] !== B[w]) return A[w] < B[w];
  }
}
// An exact Exp(1) deviate E = k + x (von Neumann 1951; Karney 2016, "Sampling exactly from the normal distribution",
// Algorithm V): x is the lazily read uniform j, whose first four words are given.
export type Expo = { k: number; j: number; x: number[] };
export function expo(): Expo {
  for (let k = 0; ; k++) {
    const j0 = S.uj, x = uword(j0, 0);
    S.uj = (S.uj + 1) >>> 0;
    let pj = j0, p = x, n = 1;
    for (;;) {
      const j = S.uj, u = uword(j, 0);
      S.uj = (S.uj + 1) >>> 0;
      if (uless(j, u, pj, p)) { pj = j; p = u; n++; } else break;
    }
    if (n & 1) return { k, j: j0, x };
  }
}

// ---------- 224-bit numbers for the slow path ----------
// Seven u32 limbs, most significant first: limb 0 the integer part, limbs 1 to 6 the fraction (an ulp is 2^-192).
const L = 7;
const zeroL = () => [0, 0, 0, 0, 0, 0, 0];
const smallL = (v: number) => [0, 0, 0, 0, 0, 0, v >>> 0];
function mulsL(A: readonly number[], c: number): number[] {
  const R = zeroL();
  let carry = 0;
  for (let i = L - 1; i >= 0; i--) { const p = mul64(A[i], c), lo = (p[0] + carry) >>> 0; R[i] = lo; carry = (p[1] + (lo < p[0] ? 1 : 0)) >>> 0; }
  return R;
}
function divsL(A: readonly number[], d: number): number[] {
  const R = zeroL();
  let r = 0;
  for (let i = 0; i < L; i++) { const q = divw(r, A[i], d); R[i] = q[0]; r = q[1]; }
  return R;
}
function addL(A: readonly number[], B: readonly number[]): number[] {
  const R = zeroL();
  let c = 0;
  for (let i = L - 1; i >= 0; i--) { const s = A[i] + B[i] + c; R[i] = s >>> 0; c = s > 0xffffffff ? 1 : 0; }
  return R;
}
function subL(A: readonly number[], B: readonly number[]): number[] {
  const R = zeroL();
  let br = 0;
  for (let i = L - 1; i >= 0; i--) { const s = A[i] - B[i] - br; R[i] = s >>> 0; br = s < 0 ? 1 : 0; }
  return R;
}
function cmpL(A: readonly number[], B: readonly number[]): number {
  for (let i = 0; i < L; i++) if (A[i] !== B[i]) return A[i] < B[i] ? -1 : 1;
  return 0;
}
// The product, floored to 2^-192.
function mulL(A: readonly number[], B: readonly number[]): number[] {
  const R = zeroL();
  let w0 = 0, w1 = 0, w2 = 0;
  for (let t = 2 * L - 2; t >= 0; t--) {
    for (let i = Math.max(0, t - L + 1); i <= Math.min(t, L - 1); i++) {
      const p = mul64(A[i], B[t - i]);
      const s0 = (w0 + p[0]) >>> 0, c0 = s0 < w0 ? 1 : 0;
      const s1 = (w1 + p[1] + c0) >>> 0, c1 = s1 < w1 || (c0 === 1 && s1 === w1) ? 1 : 0;
      w0 = s0; w1 = s1; w2 = (w2 + c1) >>> 0;
    }
    if (t < L) R[t] = w0;
    w0 = w1; w1 = w2; w2 = 0;
  }
  return R;
}
function shlL(A: readonly number[], s: number): number[] {
  const R = zeroL(), q = s >>> 5, r = s & 31;
  for (let i = 0; i < L; i++) {
    const hi = i + q < L ? A[i + q] : 0, lo = i + q + 1 < L ? A[i + q + 1] : 0;
    R[i] = r === 0 ? hi : ((hi << r) | (lo >>> (32 - r))) >>> 0;
  }
  return R;
}
// Leading zero bits of the fraction.
function lzL(A: readonly number[]): number {
  for (let i = 1; i < L; i++) if (A[i] !== 0) return 32 * (i - 1) + Math.clz32(A[i]);
  return 192;
}
// e^-1, floored to 2^-192 (from its series in BigInt).
export const EM1: readonly number[] = (() => {
  let s = 0n, f = 1n;
  for (let n = 0n; n < 70n; n++) { if (n > 0n) f *= n; s += ((n & 1n) === 1n ? -1n : 1n) * ((1n << 212n) / f); }
  const v = s >> 20n;
  return [0, ...Array.from({ length: 6 }, (_, i) => Number((v >> BigInt(32 * (5 - i))) & 0xffffffffn))];
})();

// The exact slow path of binhalf's acceptance: accept iff E >= -ln(q(a) 2^kb), that is iff e^-E <= Q = 2^kb q(a), with
// E = kE + x and x's first 192 bits x6. Q is the product 2^kb prod_{i=1..a} (N - a + i) / (N + i) in 224-bit integer
// arithmetic, kept in [1/2, 1) while any of 2^kb is left to apply, so it is short by at most a 2^-160 + a 2^-192; e^-x
// comes from 48 terms of its series (each term within 2n ulps, the remainder under 2^-208) and e^-kE from kE products
// by e^-1, together within 4096 + 4 kE ulps, and x's unread digits widen that by one ulp. When the two intervals are
// still apart (all but a fraction about a 2^-160 of slow-path calls, themselves about 2^-43 of proposals) the decision
// is the exact one; otherwise it rejects and counts a flag.
export function slowAccept(N: number, a: number, kb: number, kE: number, x6: readonly number[]): boolean {
  let V = [1, 0, 0, 0, 0, 0, 0], s = kb;
  for (let i = 1; i <= a; i++) {
    V = divsL(mulsL(V, (N - a + i) >>> 0), (N + i) >>> 0);
    if (s > 0 && V[0] === 0) { const sh = Math.min(s, lzL(V)); V = shlL(V, sh); s -= sh; }
  }
  if (s > 0) return true;
  const X = [0, ...x6];
  let t = [1, 0, 0, 0, 0, 0, 0], pos = [1, 0, 0, 0, 0, 0, 0], neg = zeroL();
  for (let n = 1; n <= 48; n++) { t = divsL(mulL(t, X), n); if (n & 1) neg = addL(neg, t); else pos = addL(pos, t); }
  let E = subL(pos, neg);
  const ke = Math.min(kE, 200);
  for (let i = 0; i < ke; i++) E = mulL(E, EM1);
  if (kE >= 200) E = zeroL();
  const eps = smallL(4096 + 4 * ke), eps1 = smallL(4097 + 4 * ke);
  const hiE = addL(E, eps), loE = cmpL(E, eps1) > 0 ? subL(E, eps1) : zeroL();
  const hiQ = addL(addL(V, [0, 0, 0, 0, 0, a >>> 0, 0]), smallL(a));
  if (cmpL(hiE, V) <= 0) return true;
  if (cmpL(loE, hiQ) > 0) return false;
  S.flags++;
  return false;
}

// The smallest block width m with 65536 m^2 >= 45427 (N + m): the envelope 2^-k on block k then dominates q, since
// q(a) <= exp(-a^2 / (N + a)) and 45427 / 65536 > ln 2.
function blockWidth(N: number): number {
  const v = mul64(N, 45427);
  let m = isqrt64([((v[0] >>> 16) | (v[1] << 16)) >>> 0, v[1] >>> 16]) + 2;
  const holds = (m: number) => !lt64(mul64(Math.imul(m, m) >>> 0, 65536), mul64((N + m) >>> 0, 45427));
  while (m > 1 && holds(m - 1)) m--;
  while (!holds(m)) m++;
  return m;
}
// Bin(T, 1/2), exactly: by counting ones below T = 4096, else by the rejection sampler of Bringmann, Kuhn, Panagiotou,
// Peter and Thomas 2014 ("Internal DLA: efficient simulation of a physical growth model", ICALP, Appendix A.2) for
// Bin(2N, 1/2), plus a fair bit when T is odd: a random sign, a geometric block k, an exact uniform offset in a block of
// width m, accepted with probability q(a) 2^k by comparing an exact Exp(1) deviate with bounds on -ln q(a) - k ln 2,
// and with slowAccept where the bounds can't tell.
export const T0 = 4096;
export function binhalf(T: number): number {
  if (T < T0) return popbin(T);
  const extra = T & 1 ? next32() & 1 : 0, N = T >>> 1, m = blockWidth(N);
  for (;;) {
    const w0 = next32(), neg = w0 & 1, wv = w0 >>> 1;
    let k = ctz(~wv >>> 0);
    if (k >= 31) { k = 31; for (;;) { const c = ctz(~next32() >>> 0); k += c; if (c < 32) break; } }
    const u = unif(m), km = mul64(k, m);
    if (km[1] !== 0) continue;
    const a64 = add64(add64(km, [u, 0]), [neg, 0]);
    if (a64[1] !== 0 || a64[0] > N) continue;
    const a = a64[0];
    if (a === 0) return N + extra;
    const e = expo();
    let decided = 0;
    if (!S.force) {
      const aa = mul64(a, a), sqlo = ratioQ(aa, N + a), sh = ratioQ(aa, (N - a + 1) >>> 0);
      const sqhi = isMax(sh) ? QMAX : add64(sh, [1, 0]);
      const klo = mulk(LN2F, k), khi = mulk(add64(LN2F, [1, 0]), k);
      const Elo: U64 = e.k < 255 ? [((e.x[1] >>> 8) | (e.x[0] << 24)) >>> 0, ((e.x[0] >>> 8) | (e.k << 24)) >>> 0] : QMAX;
      const Ehi = addsat(Elo, [1, 0]);
      let glo = subsat(sqlo, khi), ghi = isMax(sqhi) ? QMAX : subsat(sqhi, klo);
      if (!lt64(Elo, ghi) && !isMax(ghi)) decided = 1;
      else if (!lt64(glo, Ehi)) decided = 2;
      else if (a <= N >>> 3) {
        const s = nlnq(N, a);
        if (!isMax(s[1])) {
          glo = subsat(s[0], khi); ghi = subsat(s[1], klo);
          if (!lt64(Elo, ghi)) decided = 1;
          else if (!lt64(glo, Ehi)) decided = 2;
        }
      }
    }
    if (decided === 0) {
      const w = uword(e.j, 1);
      decided = slowAccept(N, a, k, e.k, [e.x[0], e.x[1], e.x[2], e.x[3], w[0], w[1]]) ? 1 : 2;
    }
    if (decided === 1) return (neg ? N - a : N + a) + extra;
  }
}
const ctz = (v: number) => (v === 0 ? 32 : 31 - Math.clz32(v & -v));

// ---------- exact samplers built on it ----------
// Bin(n, K / 2^32): how many of n members draw a uniform word below K, by following the members tied with K bit by bit
// (each level one Bin(m, 1/2)); exact for any dyadic probability.
export function binom(n: number, K: number): number {
  let m = n >>> 0, hit = 0;
  for (let j = 0; j < 32; j++) {
    if (m === 0 || (K << j) === 0) break;
    const ones = binhalf(m);
    if ((K >>> (31 - j)) & 1) { hit += m - ones; m = ones; } else m -= ones;
  }
  return hit >>> 0;
}
// A multinomial split of n members over outcomes whose uniform words fall in [t[j-1], t[j]) (t ascending, t[-1] = 0,
// the last outcome up to 2^32; t.length + 1 outcomes, at most 16): only the dyadic intervals that straddle a boundary
// are split, each by one Bin(c, 1/2).
export function multinom(n: number, t: readonly number[]): number[] {
  const out = new Array(t.length + 1).fill(0);
  const which = (v: number) => { let o = 0; for (const b of t) if (b <= v) o++; return o; };
  const stack: [number, number, number][] = [[0, 0, n >>> 0]];
  while (stack.length) {
    const [lo, d, c] = stack.pop()!;
    if (c === 0) continue;
    const last = d === 32 ? lo : (lo + (0xffffffff >>> d)) >>> 0, o = which(lo);
    if (o === which(last)) { out[o] += c; continue; }
    const ones = binhalf(c);
    stack.push([(lo + (1 << (31 - d) >>> 0)) >>> 0, d + 1, ones], [lo, d + 1, c - ones]);
  }
  return out;
}
// All of m members' uniform words m at or above K: Ber((1 - K/2^32)^M), exactly, for M members.
function allones(m: number): boolean {
  for (let left = m; left > 0; ) {
    const take = Math.min(left, 32), mask = take === 32 ? 0xffffffff : (1 << take) - 1;
    if (((next32() & mask) >>> 0) !== mask >>> 0) return false;
    left -= take;
  }
  return true;
}
export function bernpow(M: number, K: number): boolean {
  let m = M >>> 0;
  for (let j = 0; j < 32; j++) {
    if (m === 0 || (K << j) === 0) return true;
    if ((K >>> (31 - j)) & 1) { if (!allones(m)) return false; } else m -= binhalf(m);
  }
  return true;
}
// The number of failures before the first success of trials with probability K / 2^32 (K >= 1; 0xffffffff past the
// u32 range or for K = 0), exactly: whole blocks of 2^B >= 2^32 / K trials are skipped while they hold no success
// (bernpow), and within the block that does, the first success's position has independent binary digits, digit b set
// with probability c / (1 + c), c = (1 - p)^(2^b), drawn as: a fair bit picks Ber(c), or else Ber(1 - c) and the same
// again (f = c/2 + (1 - c) f / 2). One bernpow call site keeps the WGSL small.
export function geowait(K: number): number {
  if (K === 0) return 0xffffffff;
  const B = Math.min(31, Math.clz32(K) + 1), M = 2 ** B;
  let base = 0, pos = 0, j = B, skipping = true;
  for (;;) {
    if (!skipping && j === 0) break;
    const coin = skipping ? 1 : next32() & 1, Mq = skipping ? M : 2 ** (j - 1), b = bernpow(Mq, K);
    if (skipping) {
      if (b) { base += M; if (base > 0xffffffff - M) return 0xffffffff; } else skipping = false;
    } else if (coin === 1) { if (b) pos += Mq; j--; }
    else if (b) j--;
  }
  return base + pos;
}

// ---------- Feistel permutations ----------
// Round keys for the permutation of (seed, stream, id, tick).
export const fkeys = (seed: number, stream: number, id: number, tick: number) => philox([id >>> 0, tick >>> 0, 0, 0xffffffff], [seed >>> 0, stream >>> 0]);
function fround(r: number, k: number, mask: number): number {
  let h = Math.imul((r ^ k) >>> 0, 0x9e3779b1) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca77) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae3d) >>> 0;
  return (h ^ (h >>> 16)) & mask;
}
// A bijection of [0, n) (Black and Rogaway 2002, "Ciphers with arbitrary finite domains"): a four-round balanced
// Feistel network on the smallest 2h-bit square holding n, cycle-walked until the value falls back inside [0, n).
export function feistel(x: number, n: number, keys: readonly number[]): number {
  if (n <= 1) return x >>> 0;
  const h = (33 - Math.clz32(n - 1)) >>> 1, mask = (1 << h) - 1;
  let y = x >>> 0;
  do {
    let l = y >>> h, r = y & mask;
    for (let i = 0; i < 4; i++) { const t = r; r = (l ^ fround(r, keys[i], mask)) >>> 0; l = t; }
    y = ((l << h) | r) >>> 0;
  } while (y >= n);
  return y;
}
// Its inverse.
export function feistelInv(y: number, n: number, keys: readonly number[]): number {
  if (n <= 1) return y >>> 0;
  const h = (33 - Math.clz32(n - 1)) >>> 1, mask = (1 << h) - 1;
  let x = y >>> 0;
  do {
    let l = x >>> h, r = x & mask;
    for (let i = 3; i >= 0; i--) { const t = l; l = (r ^ fround(l, keys[i], mask)) >>> 0; r = t; }
    x = ((l << h) | r) >>> 0;
  } while (x >= n);
  return x;
}
