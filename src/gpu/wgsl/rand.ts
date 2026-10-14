// The world's randomness in WGSL, one function for each of its TypeScript twins in ../rand.ts (keys, counters,
// formats and exactness are described there). Needs FIXED ahead of it; a kernel opens its stream with rinit, and the
// stream lives in private variables, one per invocation.
import { CK, DK, EM1, LN2F, PTRS, SIXTH, T0 } from "../rand";

const v2 = (a: readonly number[]) => `vec2u(${a[0]}u, ${a[1]}u)`;
const [B0, B1, A0, A1, I0, I1, I2, V0, V1, K0, US, UT] = PTRS;

export const RAND = /* wgsl */ `
fn philox(c0: vec4u, k0: vec2u) -> vec4u {
  var c = c0; var k = k0;
  for (var r = 0u; r < 10u; r++) {
    let x = mul64(0xD2511F53u, c.x); let y = mul64(0xCD9E8D57u, c.z);
    c = vec4u(y.y ^ c.y ^ k.x, y.x, x.y ^ c.w ^ k.y, x.x);
    k = k + vec2u(0x9E3779B9u, 0xBB67AE85u);
  }
  return c;
}

var<private> rkey: vec2u;
var<private> rid: u32;
var<private> rtick: u32;
var<private> rblock: u32;
var<private> rbuf: vec4u;
var<private> ridx: u32;
var<private> ruj: u32;
var<private> rflags: u32;
var<private> rforce: u32;
fn rinit(seed: u32, stream: u32, id: u32, tick: u32) {
  rkey = vec2u(seed, stream); rid = id; rtick = tick; rblock = 0u; ridx = 4u; ruj = 1u; rflags = 0u; rforce = 0u;
}
fn next32() -> u32 {
  if (ridx == 4u) { rbuf = philox(vec4u(rid, rtick, rblock, 0u), rkey); rblock = rblock + 1u; ridx = 0u; }
  let v = rbuf[ridx]; ridx = ridx + 1u; return v;
}
fn uword(j: u32, b: u32) -> vec4u { return philox(vec4u(rid, rtick, b, j), rkey); }
fn unif(m: u32) -> u32 {
  loop {
    let p = mul64(next32(), m);
    if (p.x >= m) { return p.y; }
    if (p.x >= (0u - m) % m) { return p.y; }
  }
}

fn qunif() -> i32 { return bitcast<i32>(next32() >> 16u); }
fn nlnu(u: u32) -> vec2u {
  if (u == 0xffffffffu) { return vec2u(0u); }
  let v = u + 1u; let c = countLeadingZeros(v);
  return neg64(smulhi64(vec2u(lg2m(v << c), bitcast<u32>(-1i - i32(c))), LN2_32));
}
fn qexpo() -> i32 { return round16(nlnu(next32())); }
fn isqrt64(s: vec2u) -> u32 {
  var r = 0u;
  for (var bit = 1u << 30u; bit != 0u; bit = bit >> 1u) { let c = r | bit; if (!lt64(s, mul64(c, c))) { r = c; } }
  return r;
}
fn qnormal() -> i32 {
  loop {
    let u = bitcast<i32>(next32()); let v = bitcast<i32>(next32());
    let au = mag(u); let av = mag(v);
    let s = add64(mul64(au, au), mul64(av, av));
    if (s.y >= 0x40000000u || (s.x == 0u && s.y == 0u)) { continue; }
    let c = select(32u + countLeadingZeros(s.x), countLeadingZeros(s.y), s.y != 0u);
    var top: u32;
    if (c < 32u) { top = (s.y << c) | (s.x >> (32u - c)); } else { top = s.x << (c - 32u); }
    let R = neg64(smulhi64(vec2u(lg2m(top), bitcast<u32>(1i - i32(c))), LN2_32));
    let rad = qsqrt(round16(add64(R, R)));
    let cs = bitcast<i32>(divw(au >> 16u, au << 16u, isqrt64(s)).x);
    let z = qmul(rad, cs);
    return select(z, -z, u < 0i);
  }
}
fn qlognormal(mu: i32, sigma: i32) -> i32 { return qexp(qadd(mu, qmul(sigma, qnormal()))); }
fn qweibull(u: u32, k: i32, lam: i32) -> i32 { return qmul(lam, qpow(round16(nlnu(~u)), qdiv(FX_ONE_I, k))); }
const FX_ONE_I = 0x10000i;
fn slt64(a: vec2u, b: vec2u) -> bool { return lt64(vec2u(a.x, a.y ^ 0x80000000u), vec2u(b.x, b.y ^ 0x80000000u)); }
fn qgammav(a: i32) -> i32 {
  if (a <= 0i) { return 0i; }
  let boost = a < FX_ONE_I; let aa = select(a, a + FX_ONE_I, boost); let d = aa - 21845i;
  let c = qdiv(FX_ONE_I, 3i * qsqrt(d));
  var g = 0i;
  loop {
    let x = qnormal(); let t = FX_ONE_I + qmul(c, x);
    if (t <= 0i) { continue; }
    let v = qmul(qmul(t, t), t); let lu = round16(neg64(nlnu(next32())));
    let rhs = qadd(qadd(qmul(x, x) >> 1u, d - qmul(d, v)), qmul(d, qln(v)));
    if (lu < rhs) { g = qmul(d, v); break; }
  }
  if (boost) { return qmul(g, qpow(max(bitcast<i32>(next32() >> 16u), 1i), qdiv(FX_ONE_I, a))); }
  return g;
}
fn qpoisson(lam: i32) -> u32 {
  if (lam <= 0i) { return 0u; }
  if (lam < 16i * FX_ONE_I) {
    var t = vec2u(0u); var k = 0u; let L = wide(lam);
    loop { t = add64(t, nlnu(next32())); if (lt64(L, t)) { return k; } k = k + 1u; }
  }
  let b = ${B0}i + qmul(${B1}i, qsqrt(lam)); let a = ${A0}i + qmul(${A1}i, b);
  let ia = ${I0}i + qdiv(${I1}i, b - ${I2}i); let vr = ${V0}i - qdiv(${V1}i, b - 2i * FX_ONE_I);
  let ll = ln32(bitcast<u32>(lam));
  loop {
    let U = bitcast<i32>(next32() >> 16u) - 0x8000i; let V = bitcast<i32>(next32() >> 16u); let us = 0x8000i - abs(U);
    if (us == 0i) { continue; }
    let k = qadd(qadd(qmul(qadd(qdiv(2i * a, us), b), U), lam), ${K0}i) >> 16u;
    if (us >= ${US}i && V <= vr) { if (k >= 0i) { return u32(k); } continue; }
    if (k < 0i || (us < ${UT}i && V > us)) { continue; }
    if (V == 0i) { return u32(k); }
    let den = qadd(qdiv(qdiv(a, us), us), b);
    let lhs = sub64(add64(ln32(bitcast<u32>(V)), ln32(bitcast<u32>(ia))), ln32(bitcast<u32>(den)));
    let kl = mul64(ll.x, u32(k)); let kh = mul64(ll.y, u32(k));
    let rhs = sub64(sub64(vec2u(kl.x, kl.y + kh.x), wide(lam)), lgamma32(u32(k + 1i) << 16u));
    if (!slt64(rhs, lhs)) { return u32(k); }
  }
}

const QMAX = vec2u(0xffffffffu, 0xffffffffu);
const LN2F = ${v2(LN2F)};
const SIXTH = ${v2(SIXTH)};
const CK = array<vec2u, 16>(${CK.map(v2).join(", ")});
const DK = array<vec2u, 16>(${DK.map(v2).join(", ")});
fn ismax(a: vec2u) -> bool { return a.x == 0xffffffffu && a.y == 0xffffffffu; }
fn subsat(a: vec2u, b: vec2u) -> vec2u { return select(sub64(a, b), vec2u(0u), lt64(a, b)); }
fn addsat(a: vec2u, b: vec2u) -> vec2u { let s = add64(a, b); return select(s, QMAX, lt64(s, a)); }
fn div64(a: vec2u, d: u32) -> vec2u { return vec2u(divw(a.y % d, a.x, d).x, a.y / d); }
fn ratioQ(num: vec2u, den: u32) -> vec2u {
  let h = num.y / den; let l = divw(num.y % den, num.x, den);
  if (h != 0u || l.x >= 256u) { return QMAX; }
  let r = l.y; let a = divw(r >> 8u, r << 24u, den); let b = divw(a.y, 0u, den);
  return vec2u(b.x, a.x | (l.x << 24u));
}
fn mulQ(a: vec2u, b: vec2u) -> vec2u {
  let p00 = mul64(a.x, b.x); let p01 = mul64(a.x, b.y); let p10 = mul64(a.y, b.x); let p11 = mul64(a.y, b.y);
  let mid = add64(add64(vec2u(p00.y, 0u), vec2u(p01.x, 0u)), vec2u(p10.x, 0u));
  let hi = add64(add64(add64(p11, vec2u(p01.y, 0u)), vec2u(p10.y, 0u)), vec2u(mid.y, 0u));
  if (hi.y >= 0x01000000u) { return QMAX; }
  return vec2u((mid.x >> 24u) | (hi.x << 8u), (hi.x >> 24u) | (hi.y << 8u));
}
fn mulk(a: vec2u, k: u32) -> vec2u { let l = mul64(a.x, k); let h = mul64(a.y, k); return vec2u(l.x, l.y + h.x); }
fn nlnq(N: u32, a: u32) -> vec4u {
  let t = ratioQ(mul64(a, a), N);
  if (ismax(t)) { return vec4u(QMAX, QMAX); }
  let invN = ratioQ(vec2u(1u, 0u), N); let y = div64(t, N);
  var wk = t; var P = vec2u(0u); var M = vec2u(0u);
  for (var k = 0u; k < 16u; k++) {
    if (wk.y == 0u && wk.x < 16u) { break; }
    P = add64(P, select(mulQ(wk, CK[k]), wk, k == 0u));
    M = add64(M, mulQ(mulQ(wk, invN), DK[k]));
    wk = mulQ(wk, y);
  }
  let yi = mulQ(y, invN);
  var th1 = yi; var tk = yi;
  for (var j = 0u; j < 16u; j++) { tk = mulQ(tk, y); if (tk.x == 0u && tk.y == 0u) { break; } th1 = add64(th1, tk); }
  th1 = mulQ(th1, SIXTH);
  let e3 = add64(div64(mulQ(yi, mulQ(invN, invN)), 16u), vec2u(2u, 0u));
  let mid = add64(subsat(P, M), th1); let err = add64(vec2u(2056u, 0u), wk);
  return vec4u(subsat(subsat(mid, err), e3), add64(mid, err));
}

fn popbin(T: u32) -> u32 {
  var ones = 0u; var left = T;
  loop {
    if (left == 0u) { break; }
    let r = next32(); let take = min(left, 32u);
    ones += countOneBits(select(r & ((1u << take) - 1u), r, take == 32u)); left -= take;
  }
  return ones;
}
fn uless(j: u32, a: vec4u, i: u32, b: vec4u) -> bool {
  var A = a; var B = b;
  for (var blk = 1u; ; blk++) {
    for (var w = 0u; w < 4u; w++) { if (A[w] != B[w]) { return A[w] < B[w]; } }
    A = uword(j, blk); B = uword(i, blk);
  }
}
struct Expo { k: u32, j: u32, x: vec4u }
fn expo() -> Expo {
  for (var k = 0u; ; k++) {
    let j0 = ruj; let x = uword(j0, 0u); ruj = ruj + 1u;
    var pj = j0; var p = x; var n = 1u;
    loop {
      let j = ruj; let u = uword(j, 0u); ruj = ruj + 1u;
      if (uless(j, u, pj, p)) { pj = j; p = u; n = n + 1u; } else { break; }
    }
    if ((n & 1u) == 1u) { return Expo(k, j0, x); }
  }
}

alias Limbs = array<u32, 7>;
fn smallL(v: u32) -> Limbs { return Limbs(0u, 0u, 0u, 0u, 0u, 0u, v); }
fn mulsL(a: Limbs, c: u32) -> Limbs {
  var A = a; var R: Limbs; var carry = 0u;
  for (var i = 6i; i >= 0i; i--) { let p = mul64(A[i], c); let lo = p.x + carry; R[i] = lo; carry = p.y + select(0u, 1u, lo < p.x); }
  return R;
}
fn divsL(a: Limbs, d: u32) -> Limbs {
  var A = a; var R: Limbs; var r = 0u;
  for (var i = 0u; i < 7u; i++) { let q = divw(r, A[i], d); R[i] = q.x; r = q.y; }
  return R;
}
fn addL(a: Limbs, b: Limbs) -> Limbs {
  var A = a; var B = b; var R: Limbs; var c = 0u;
  for (var i = 6i; i >= 0i; i--) { let s = A[i] + B[i]; let t = s + c; R[i] = t; c = select(0u, 1u, s < A[i] || t < s); }
  return R;
}
fn subL(a: Limbs, b: Limbs) -> Limbs {
  var A = a; var B = b; var R: Limbs; var br = 0u;
  for (var i = 6i; i >= 0i; i--) { let s = A[i] - B[i]; let t = s - br; R[i] = t; br = select(0u, 1u, A[i] < B[i] || s < br); }
  return R;
}
fn cmpL(a: Limbs, b: Limbs) -> i32 {
  var A = a; var B = b;
  for (var i = 0u; i < 7u; i++) { if (A[i] != B[i]) { return select(1i, -1i, A[i] < B[i]); } }
  return 0i;
}
fn mulL(a: Limbs, b: Limbs) -> Limbs {
  var A = a; var B = b; var R: Limbs; var w0 = 0u; var w1 = 0u; var w2 = 0u;
  for (var t = 12i; t >= 0i; t--) {
    for (var i = max(0i, t - 6i); i <= min(t, 6i); i++) {
      let p = mul64(A[i], B[t - i]);
      let s0 = w0 + p.x; let c0 = select(0u, 1u, s0 < w0);
      let s1 = w1 + p.y + c0; let c1 = select(0u, 1u, s1 < w1 || (c0 == 1u && s1 == w1));
      w0 = s0; w1 = s1; w2 = w2 + c1;
    }
    if (t < 7i) { R[t] = w0; }
    w0 = w1; w1 = w2; w2 = 0u;
  }
  return R;
}
fn shlL(a: Limbs, s: u32) -> Limbs {
  var A = a; var R: Limbs; let q = s >> 5u; let r = s & 31u;
  for (var i = 0u; i < 7u; i++) {
    var hi = 0u; var lo = 0u;
    if (i + q < 7u) { hi = A[i + q]; }
    if (i + q + 1u < 7u) { lo = A[i + q + 1u]; }
    R[i] = select((hi << r) | (lo >> (32u - r)), hi, r == 0u);
  }
  return R;
}
fn lzL(a: Limbs) -> u32 {
  var A = a;
  for (var i = 1u; i < 7u; i++) { if (A[i] != 0u) { return 32u * (i - 1u) + countLeadingZeros(A[i]); } }
  return 192u;
}
const EM1 = Limbs(${EM1.map((v) => `${v}u`).join(", ")});
fn slowAccept(N: u32, a: u32, kb: u32, kE: u32, x6: array<u32, 6>) -> bool {
  var V = Limbs(1u, 0u, 0u, 0u, 0u, 0u, 0u); var s = kb;
  for (var i = 1u; i <= a; i++) {
    V = divsL(mulsL(V, N - a + i), N + i);
    if (s > 0u && V[0] == 0u) { let sh = min(s, lzL(V)); V = shlL(V, sh); s -= sh; }
  }
  if (s > 0u) { return true; }
  let X = Limbs(0u, x6[0], x6[1], x6[2], x6[3], x6[4], x6[5]);
  var t = Limbs(1u, 0u, 0u, 0u, 0u, 0u, 0u); var pos = t; var neg: Limbs;
  for (var n = 1u; n <= 48u; n++) { t = divsL(mulL(t, X), n); if ((n & 1u) == 1u) { neg = addL(neg, t); } else { pos = addL(pos, t); } }
  var E = subL(pos, neg);
  let ke = min(kE, 200u);
  for (var i = 0u; i < ke; i++) { E = mulL(E, EM1); }
  if (kE >= 200u) { E = Limbs(); }
  let eps = smallL(4096u + 4u * ke); let eps1 = smallL(4097u + 4u * ke);
  let hiE = addL(E, eps);
  var loE: Limbs;
  if (cmpL(E, eps1) > 0i) { loE = subL(E, eps1); }
  let hiQ = addL(addL(V, Limbs(0u, 0u, 0u, 0u, 0u, a, 0u)), smallL(a));
  if (cmpL(hiE, V) <= 0i) { return true; }
  if (cmpL(loE, hiQ) > 0i) { return false; }
  rflags = rflags + 1u;
  return false;
}

fn holds(N: u32, m: u32) -> bool { return !lt64(mul64(m * m, 65536u), mul64(N + m, 45427u)); }
fn blockWidth(N: u32) -> u32 {
  let v = mul64(N, 45427u);
  var m = isqrt64(vec2u((v.x >> 16u) | (v.y << 16u), v.y >> 16u)) + 2u;
  loop { if (m > 1u && holds(N, m - 1u)) { m = m - 1u; } else { break; } }
  loop { if (holds(N, m)) { break; } m = m + 1u; }
  return m;
}
const T0 = ${T0}u;
fn binhalf(T: u32) -> u32 {
  if (T < T0) { return popbin(T); }
  var extra = 0u;
  if ((T & 1u) == 1u) { extra = next32() & 1u; }
  let N = T >> 1u; let m = blockWidth(N);
  loop {
    let w0 = next32(); let neg = w0 & 1u; let wv = w0 >> 1u;
    var k = countTrailingZeros(~wv);
    if (k >= 31u) { k = 31u; loop { let c = countTrailingZeros(~next32()); k = k + c; if (c < 32u) { break; } } }
    let u = unif(m); let km = mul64(k, m);
    if (km.y != 0u) { continue; }
    let a64 = add64(add64(km, vec2u(u, 0u)), vec2u(neg, 0u));
    if (a64.y != 0u || a64.x > N) { continue; }
    let a = a64.x;
    if (a == 0u) { return N + extra; }
    let e = expo();
    var decided = 0u;
    if (rforce == 0u) {
      let aa = mul64(a, a); let sqlo = ratioQ(aa, N + a); let sh = ratioQ(aa, N - a + 1u);
      let sqhi = select(add64(sh, vec2u(1u, 0u)), QMAX, ismax(sh));
      let klo = mulk(LN2F, k); let khi = mulk(add64(LN2F, vec2u(1u, 0u)), k);
      var Elo = QMAX;
      if (e.k < 255u) { Elo = vec2u((e.x.y >> 8u) | (e.x.x << 24u), (e.x.x >> 8u) | (e.k << 24u)); }
      let Ehi = addsat(Elo, vec2u(1u, 0u));
      var glo = subsat(sqlo, khi); var ghi = select(subsat(sqhi, klo), QMAX, ismax(sqhi));
      if (!lt64(Elo, ghi) && !ismax(ghi)) { decided = 1u; }
      else if (!lt64(glo, Ehi)) { decided = 2u; }
      else if (a <= (N >> 3u)) {
        let s = nlnq(N, a);
        if (!ismax(s.zw)) {
          glo = subsat(s.xy, khi); ghi = subsat(s.zw, klo);
          if (!lt64(Elo, ghi)) { decided = 1u; }
          else if (!lt64(glo, Ehi)) { decided = 2u; }
        }
      }
    }
    if (decided == 0u) {
      let w = uword(e.j, 1u);
      decided = select(2u, 1u, slowAccept(N, a, k, e.k, array<u32, 6>(e.x.x, e.x.y, e.x.z, e.x.w, w.x, w.y)));
    }
    if (decided == 1u) { return select(N + a, N - a, neg == 1u) + extra; }
  }
}

fn binom(n: u32, K: u32) -> u32 {
  var m = n; var hit = 0u;
  for (var j = 0u; j < 32u; j++) {
    if (m == 0u || (K << j) == 0u) { break; }
    let ones = binhalf(m);
    if (((K >> (31u - j)) & 1u) == 1u) { hit += m - ones; m = ones; } else { m -= ones; }
  }
  return hit;
}
fn outcome(t: array<u32, 15>, m: u32, v: u32) -> u32 {
  var T = t; var o = 0u;
  for (var j = 0u; j < m; j++) { if (T[j] <= v) { o++; } }
  return o;
}
fn multinom(n: u32, t: array<u32, 15>, m: u32) -> array<u32, 16> {
  var out: array<u32, 16>; var stack: array<vec3u, 34>; var sp = 1u;
  stack[0] = vec3u(0u, 0u, n);
  loop {
    if (sp == 0u) { break; }
    sp -= 1u; let nd = stack[sp]; let lo = nd.x; let d = nd.y; let c = nd.z;
    if (c == 0u) { continue; }
    let last = select(lo + (0xffffffffu >> d), lo, d == 32u); let o = outcome(t, m, lo);
    if (o == outcome(t, m, last)) { out[o] += c; continue; }
    let ones = binhalf(c);
    stack[sp] = vec3u(lo + (1u << (31u - d)), d + 1u, ones); stack[sp + 1u] = vec3u(lo, d + 1u, c - ones); sp += 2u;
  }
  return out;
}
fn allones(m: u32) -> bool {
  var left = m;
  loop {
    if (left == 0u) { return true; }
    let take = min(left, 32u); let mask = select((1u << take) - 1u, 0xffffffffu, take == 32u);
    if ((next32() & mask) != mask) { return false; }
    left -= take;
  }
}
fn bernpow(M: u32, K: u32) -> bool {
  var m = M;
  for (var j = 0u; j < 32u; j++) {
    if (m == 0u || (K << j) == 0u) { return true; }
    if (((K >> (31u - j)) & 1u) == 1u) { if (!allones(m)) { return false; } } else { m -= binhalf(m); }
  }
  return true;
}
fn geowait(K: u32) -> u32 {
  if (K == 0u) { return 0xffffffffu; }
  let B = min(31u, countLeadingZeros(K) + 1u); let M = 1u << B;
  var base = 0u; var pos = 0u; var j = B; var skipping = true;
  loop {
    if (!skipping && j == 0u) { break; }
    var coin = 1u; var Mq = M;
    if (!skipping) { coin = next32() & 1u; Mq = 1u << (j - 1u); }
    let b = bernpow(Mq, K);
    if (skipping) {
      if (b) { base += M; if (base > 0xffffffffu - M) { return 0xffffffffu; } } else { skipping = false; }
    } else if (coin == 1u) { if (b) { pos += Mq; } j -= 1u; }
    else if (b) { j -= 1u; }
  }
  return base + pos;
}

fn fkeys(seed: u32, stream: u32, id: u32, tick: u32) -> vec4u { return philox(vec4u(id, tick, 0u, 0xffffffffu), vec2u(seed, stream)); }
fn fround(r: u32, k: u32, mask: u32) -> u32 {
  var h = (r ^ k) * 0x9e3779b1u;
  h = (h ^ (h >> 15u)) * 0x85ebca77u;
  h = (h ^ (h >> 13u)) * 0xc2b2ae3du;
  return (h ^ (h >> 16u)) & mask;
}
fn feistel(x: u32, n: u32, keys: vec4u) -> u32 {
  if (n <= 1u) { return x; }
  let h = (33u - countLeadingZeros(n - 1u)) >> 1u; let mask = (1u << h) - 1u;
  var y = x;
  loop {
    var l = y >> h; var r = y & mask;
    for (var i = 0u; i < 4u; i++) { let t = r; r = l ^ fround(r, keys[i], mask); l = t; }
    y = (l << h) | r;
    if (y < n) { break; }
  }
  return y;
}
fn feistelInv(y: u32, n: u32, keys: vec4u) -> u32 {
  if (n <= 1u) { return y; }
  let h = (33u - countLeadingZeros(n - 1u)) >> 1u; let mask = (1u << h) - 1u;
  var x = y;
  loop {
    var l = x >> h; var r = x & mask;
    for (var i = 4u; i > 0u; i--) { let t = l; l = r ^ fround(l, keys[i - 1u], mask); r = t; }
    x = (l << h) | r;
    if (x < n) { break; }
  }
  return x;
}
`;
