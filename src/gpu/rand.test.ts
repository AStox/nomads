import { afterAll, expect, test } from "bun:test";
import { type Gpu, openGpu, releaseGpu, theGpu } from "./device";
import { cover, dispatch, pipeline, readback, storage } from "./kernel";
import { FIXED } from "./wgsl/fixed";
import { RAND } from "./wgsl/rand";
import { ONE } from "./fixed";
import * as R from "./rand";

afterAll(releaseGpu);
let low: Gpu | null = null;
afterAll(() => low?.device.destroy());

const SEED = 0x5eed, STREAM = 7, TICK = 1234;
const WG = 64;
// Runs a WGSL body over n invocations (index i) with the u32 input words a and outPer output words each, on a GPU.
async function onGpu(g: Gpu, body: string, a: Uint32Array, n: number, outPer: number): Promise<Uint32Array> {
  const src = FIXED + RAND + /* wgsl */ `
@group(0) @binding(0) var<storage, read> inp: array<u32>;
@group(0) @binding(1) var<storage, read_write> out: array<u32>;
@compute @workgroup_size(${WG}) fn main(@builtin(global_invocation_id) gid: vec3u, @builtin(num_workgroups) nw: vec3u) {
  _ = &inp;
  let i = gid.x + gid.y * nw.x * ${WG}u;
  if (i >= ${n}u) { return; }
  ${body}
}`;
  const ib = storage(g, a.length ? a : new Uint32Array(1)), ob = storage(g, n * outPer * 4);
  dispatch(g, pipeline(g, src), [ib, ob], cover(g, n, WG));
  const out = new Uint32Array(await readback(g, ob));
  ib.destroy();
  ob.destroy();
  return out;
}
const OPEN = `rinit(${SEED}u, ${STREAM}u, i, ${TICK}u);`;
const open = (i: number, force = 0) => R.rinit(SEED, STREAM, i, TICK, force);
const hex = (v: readonly number[]) => v.map((x) => (x >>> 0).toString(16).padStart(8, "0")).join(" ");

// ---------- Philox ----------
// Known-answer vectors of Random123's kat_vectors for philox4x32_10: counter, key, result.
const KAT = [
  [[0, 0, 0, 0], [0, 0], "6627e8d5 e169c58d bc57ac4c 9b00dbd8"],
  [[0xffffffff, 0xffffffff, 0xffffffff, 0xffffffff], [0xffffffff, 0xffffffff], "408f276d 41c83b0e a20bc7c6 6d5451fd"],
  [[0x243f6a88, 0x85a308d3, 0x13198a2e, 0x03707344], [0xa4093822, 0x299f31d0], "d16cfe09 94fdcceb 5001e420 24126ea1"],
] as const;
test("Philox4x32-10 matches Random123's known-answer vectors in TypeScript and on the GPU", async () => {
  for (const [c, k, want] of KAT) expect(hex(R.philox(c, k))).toBe(want);
  const got = await onGpu(await theGpu(), "let c = vec4u(inp[6u*i], inp[6u*i+1u], inp[6u*i+2u], inp[6u*i+3u]); let r = philox(c, vec2u(inp[6u*i+4u], inp[6u*i+5u])); out[4u*i] = r.x; out[4u*i+1u] = r.y; out[4u*i+2u] = r.z; out[4u*i+3u] = r.w;", Uint32Array.from(KAT.flatMap(([c, k]) => [...c, ...k])), 3, 4);
  KAT.forEach(([, , want], j) => expect(hex(Array.from(got.subarray(4 * j, 4 * j + 4)))).toBe(want));
});

test("draws from keys one bit apart are uncorrelated, and each stream is flat and serially uncorrelated", () => {
  const S = 4096, base = [SEED, STREAM, 99, TICK];
  const draw = (k: number[]) => { R.rinit(k[0], k[1], k[2], k[3]); return Float64Array.from({ length: S }, () => R.next32() / 2 ** 32 - 0.5); };
  const a = draw(base), corr = (x: Float64Array, y: Float64Array, lag = 0) => { let s = 0; for (let j = 0; j + lag < S; j++) s += x[j] * y[j + lag]; return (s / (S - lag)) * 12; };
  let worstCross = 0, worstMean = 0, worstLag = 0;
  for (let w = 0; w < 4; w++)
    for (let b = 0; b < 32; b++) {
      const k = base.slice();
      k[w] = (k[w] ^ (1 << b)) >>> 0;
      const x = draw(k);
      worstCross = Math.max(worstCross, Math.abs(corr(a, x)) * Math.sqrt(S));
      worstMean = Math.max(worstMean, Math.abs(x.reduce((s, v) => s + v, 0) / S) * Math.sqrt(12 * S));
      worstLag = Math.max(worstLag, Math.abs(corr(x, x, 1)) * Math.sqrt(S));
    }
  // Each is a z-score; 128 keys each, so the largest of them stays well under 5.
  expect(worstCross).toBeLessThan(5);
  expect(worstMean).toBeLessThan(5);
  expect(worstLag).toBeLessThan(5);
});

// ---------- twins ----------
// A draw checked against its twin: per id, its input words, the WGSL writing outPer words, and the TS giving them.
type Spec = { name: string; n: number; width: number; outPer: number; input: (i: number) => number[]; wgsl: string; ts: (inp: number[], i: number) => number[] };
const arg = (k: number, w: number) => `inp[${w}u * i + ${k}u]`;
const LAMS = [0, 1, 1000, 0x8000, ONE, 5 * ONE, 15 * ONE + 0xffff, 16 * ONE, 30 * ONE, 100 * ONE, 1000 * ONE, 30000 * ONE];
const SHAPES = [1, 0x1000, 0x6666, 0xffff, ONE, 0x28000, 10 * ONE, 300 * ONE, 20000 * ONE];
const TS_ = [0, 1, 31, 32, 33, 1000, 4095, 4096, 4097, 100001, 1000000, 999999999, 2 ** 31 + 5, 0xffffffff];
const BINS: [number, number][] = [[0, 0x80000000], [100, 0], [1000, 0xffffffff], [4097, 0x9e3779b9], [1000003, 0x4ccccccd], [1e9, 12884902], [0xffffffff, 1], [123456789, 0x80000001]];
const GEOS = [1, 7, 1000, 1 << 20, 42949673, 0x80000000, 0xc0000000, 0xffffffff];
const SIZES = [0, 1, 2, 3, 7, 100, 4097, 65536, 65537, 1e6, 1e9, 0xffffffff];
const MULTI = [0x10000000, 0x10000001, 0x55555555, 0x80000000, 0xfffffffe];
const SPECS: Spec[] = [
  { name: "next32", n: 4096, width: 0, outPer: 8, input: () => [], wgsl: `${OPEN} for (var w = 0u; w < 8u; w++) { out[8u * i + w] = next32(); }`, ts: () => Array.from({ length: 8 }, () => R.next32()) },
  { name: "unif", n: 4096, width: 1, outPer: 4, input: (i) => [[1, 2, 3, 7, 1000, 0x80000001, 0xfffffffe, 0xffffffff][i % 8]], wgsl: `${OPEN} for (var w = 0u; w < 4u; w++) { out[4u * i + w] = unif(${arg(0, 1)}); }`, ts: ([m]) => Array.from({ length: 4 }, () => R.unif(m)) },
  { name: "qunif, qexpo, qnormal", n: 8192, width: 0, outPer: 4, input: () => [], wgsl: `${OPEN} out[4u * i] = bitcast<u32>(qunif()); out[4u * i + 1u] = bitcast<u32>(qexpo()); out[4u * i + 2u] = bitcast<u32>(qnormal()); out[4u * i + 3u] = bitcast<u32>(qnormal());`, ts: () => [R.qunif(), R.qexpo(), R.qnormal() >>> 0, R.qnormal() >>> 0] },
  { name: "qpoisson", n: 4096, width: 1, outPer: 1, input: (i) => [LAMS[i % LAMS.length]], wgsl: `${OPEN} out[i] = qpoisson(bitcast<i32>(${arg(0, 1)}));`, ts: ([l]) => [R.qpoisson(l)] },
  { name: "qgammav", n: 4096, width: 1, outPer: 1, input: (i) => [SHAPES[i % SHAPES.length]], wgsl: `${OPEN} out[i] = bitcast<u32>(qgammav(bitcast<i32>(${arg(0, 1)})));`, ts: ([a]) => [R.qgammav(a) >>> 0] },
  { name: "qlognormal", n: 4096, width: 2, outPer: 1, input: (i) => [((i % 9) - 4) * 0x8000, (i % 5) * 0x6000], wgsl: `${OPEN} out[i] = bitcast<u32>(qlognormal(bitcast<i32>(${arg(0, 2)}), bitcast<i32>(${arg(1, 2)})));`, ts: ([m, s]) => [R.qlognormal(m | 0, s) >>> 0] },
  { name: "qweibull", n: 1 << 16, width: 3, outPer: 1, input: (i) => [Math.imul(i, 0x9e3779b9) >>> 0 ^ (i & 7), [0x4000, ONE, 0x18000, 3 * ONE, 40 * ONE][i % 5], [ONE, 25 * ONE, 0x100][i % 3]], wgsl: `out[i] = bitcast<u32>(qweibull(${arg(0, 3)}, bitcast<i32>(${arg(1, 3)}), bitcast<i32>(${arg(2, 3)})));`, ts: ([u, k, l]) => [R.qweibull(u, k, l) >>> 0] },
  { name: "binhalf", n: 2048, width: 1, outPer: 2, input: (i) => [TS_[i % TS_.length]], wgsl: `${OPEN} out[2u * i] = binhalf(${arg(0, 1)}); out[2u * i + 1u] = rflags;`, ts: ([T]) => [R.binhalf(T), R.rflags()] },
  { name: "binom", n: 1024, width: 2, outPer: 1, input: (i) => BINS[i % BINS.length], wgsl: `${OPEN} out[i] = binom(${arg(0, 2)}, ${arg(1, 2)});`, ts: ([n, K]) => [R.binom(n, K)] },
  { name: "multinom", n: 1024, width: 1, outPer: 6, input: (i) => [[0, 1, 63, 1000, 100000, 1e9, 0xffffffff][i % 7]], wgsl: `${OPEN} let c = multinom(${arg(0, 1)}, array<u32, 15>(${MULTI.map((t) => `${t}u`).join(", ")}, 0u, 0u, 0u, 0u, 0u, 0u, 0u, 0u, 0u, 0u), ${MULTI.length}u); for (var o = 0u; o < 6u; o++) { out[6u * i + o] = c[o]; }`, ts: ([n]) => R.multinom(n, MULTI) },
  { name: "geowait", n: 1024, width: 1, outPer: 1, input: (i) => [GEOS[i % GEOS.length]], wgsl: `${OPEN} out[i] = geowait(${arg(0, 1)});`, ts: ([K]) => [R.geowait(K)] },
  { name: "feistel", n: 1 << 15, width: 2, outPer: 2, input: (i) => { const n = SIZES[i % SIZES.length]; return [n, n <= 1 ? 0 : (Math.imul(i, 0x2545f491) >>> 0) % n]; }, wgsl: `let k = fkeys(${SEED}u, ${STREAM}u, i & 7u, ${TICK}u); out[2u * i] = feistel(${arg(1, 2)}, ${arg(0, 2)}, k); out[2u * i + 1u] = feistelInv(${arg(1, 2)}, ${arg(0, 2)}, k);`, ts: ([n, x], i) => { const k = R.fkeys(SEED, STREAM, i & 7, TICK); return [R.feistel(x, n, k), R.feistelInv(x, n, k)]; } },
];

function inputsOf(s: Spec): Uint32Array {
  const a = new Uint32Array(s.n * s.width);
  for (let i = 0; i < s.n; i++) a.set(s.input(i).map((v) => v >>> 0), i * s.width);
  return a;
}
function twinOf(s: Spec, a: Uint32Array, count = s.n): Uint32Array {
  const out = new Uint32Array(count * s.outPer);
  for (let i = 0; i < count; i++) {
    const inp = Array.from(a.subarray(i * s.width, (i + 1) * s.width));
    open(i);
    out.set(s.ts(inp, i).map((v) => v >>> 0), i * s.outPer);
  }
  return out;
}
function sameAs(s: Spec, a: Uint32Array, got: Uint32Array, want: Uint32Array) {
  for (let k = 0; k < want.length; k++) {
    if (got[k] === want[k]) continue;
    const i = Math.floor(k / s.outPer);
    throw new Error(`${s.name} id ${i} (inputs ${Array.from(a.subarray(i * s.width, (i + 1) * s.width)).join(", ")}) word ${k % s.outPer}: GPU ${got[k]}, twin ${want[k]}`);
  }
}
const TWIN_IN = new Map<string, Uint32Array>(), TWIN_OUT = new Map<string, Uint32Array>();
const twinFor = (s: Spec) => {
  if (!TWIN_OUT.has(s.name)) { const a = inputsOf(s); TWIN_IN.set(s.name, a); TWIN_OUT.set(s.name, twinOf(s, a)); }
  return [TWIN_IN.get(s.name)!, TWIN_OUT.get(s.name)!] as const;
};

test("every draw and sampler gives its TypeScript twin's result bit for bit on the GPU", async () => {
  const g = await theGpu();
  for (const s of SPECS) {
    const [a, want] = twinFor(s);
    sameAs(s, a, await onGpu(g, s.wgsl, a, s.n, s.outPer), want);
  }
}, 60_000);

test("the same kernels on the low-power adapter give identical output", async () => {
  low = await openGpu("low-power");
  for (const s of SPECS) {
    const [a, want] = twinFor(s);
    const n = Math.min(s.n, 1024);
    sameAs(s, a, await onGpu(low, s.wgsl, a.subarray(0, n * s.width), n, s.outPer), want.subarray(0, n * s.outPer));
  }
}, 60_000);

// ---------- distributions ----------
// z-scores of a sample's mean and variance against the given moments (the variance's spread taken as for a normal).
function moments(x: ArrayLike<number>, mean: number, variance: number) {
  let s = 0, q = 0;
  for (let k = 0; k < x.length; k++) s += x[k];
  const m = s / x.length;
  for (let k = 0; k < x.length; k++) q += (x[k] - m) ** 2;
  const v = q / (x.length - 1);
  return { m, v, zm: (m - mean) / Math.sqrt(variance / x.length), zv: (v - variance) / (variance * Math.sqrt(2 / (x.length - 1))) };
}
async function draws(g: Gpu, call: string, n: number, toNumber: (w: number) => number = (w) => (w | 0) / ONE) {
  return Array.from(await onGpu(g, `${OPEN} out[i] = bitcast<u32>(${call});`, new Uint32Array(0), n, 1), toNumber);
}
test("the fixed-point distributions have the moments of their laws", async () => {
  const g = await theGpu(), n = 1 << 20, ok = (r: { zm: number; zv: number }) => { expect(Math.abs(r.zm)).toBeLessThan(5); expect(Math.abs(r.zv)).toBeLessThan(5); };
  ok(moments(await draws(g, "qunif()", n), 0.5 - 0.5 / ONE, 1 / 12));
  ok(moments(await draws(g, "qexpo()", n), 1, 1));
  ok(moments(await draws(g, "qnormal()", n), 0, 1));
  for (const lam of [0.37, 5, 15.5, 16, 100, 20000]) ok(moments(await draws(g, `qpoisson(${Math.round(lam * ONE)}i)`, n, (w) => w), Math.round(lam * ONE) / ONE, Math.round(lam * ONE) / ONE));
  for (const a of [0.4, 1, 2.5, 100]) ok(moments(await draws(g, `qgammav(${Math.round(a * ONE)}i)`, n), Math.round(a * ONE) / ONE, Math.round(a * ONE) / ONE));
  const s = 0.5, ln = moments(await draws(g, `qlognormal(0i, ${s * ONE}i)`, n), Math.exp(s * s / 2), (Math.exp(s * s) - 1) * Math.exp(s * s));
  expect(Math.abs(ln.zm)).toBeLessThan(5);
}, 60_000);

// ---------- exact binomials ----------
// Bin(n, p)'s probabilities over its mean +- 9 sd, from ratios of neighbours (no lnGamma), normalised.
function binPmf(n: number, p: number) {
  const sd = Math.sqrt(n * p * (1 - p)), lo = Math.max(0, Math.floor(n * p - 9 * sd - 2)), hi = Math.min(n, Math.ceil(n * p + 9 * sd + 2));
  const mode = Math.min(hi, Math.max(lo, Math.floor((n + 1) * p))), f = new Float64Array(hi - lo + 1), r = p / (1 - p);
  f[mode - lo] = 1;
  for (let k = mode; k < hi; k++) f[k + 1 - lo] = (f[k - lo] * (n - k) * r) / (k + 1);
  for (let k = mode; k > lo; k--) f[k - 1 - lo] = (f[k - lo] * k) / ((n - k + 1) * r);
  const total = f.reduce((s, v) => s + v, 0);
  return { lo, f: f.map((v) => v / total) };
}
// The chi-squared statistic of a sample against a pmf, as a z-score, over cells of about equal expected count.
function chi2z(x: Uint32Array, pmf: { lo: number; f: Float64Array }, cells = 200): number {
  const S = x.length, cellOf = new Int32Array(pmf.f.length), expected: number[] = [];
  let acc = 0;
  for (let k = 0; k < pmf.f.length; k++) {
    if (acc >= 1 / cells && expected.length < cells - 1) { expected.push(acc); acc = 0; }
    acc += pmf.f[k];
    cellOf[k] = expected.length;
  }
  expected.push(acc);
  const seen = new Float64Array(expected.length);
  for (let k = 0; k < S; k++) seen[cellOf[Math.min(pmf.f.length - 1, Math.max(0, x[k] - pmf.lo))]]++;
  let X = 0;
  for (let c = 0; c < expected.length; c++) X += (seen[c] - S * expected[c]) ** 2 / (S * expected[c]);
  const df = expected.length - 1;
  return (X - df) / Math.sqrt(2 * df);
}
async function sampleBin(g: Gpu, call: string, n: number, force = false) {
  const w = await onGpu(g, `${OPEN} ${force ? "rforce = 1u;" : ""} out[2u * i] = ${call}; out[2u * i + 1u] = rflags;`, new Uint32Array(0), n, 2);
  const x = new Uint32Array(n);
  let flags = 0;
  for (let k = 0; k < n; k++) { x[k] = w[2 * k]; flags += w[2 * k + 1]; }
  return { x, flags };
}
function passes(x: Uint32Array, n: number, p: number) {
  const r = moments(x, n * p, n * p * (1 - p)), z = chi2z(x, binPmf(n, p));
  expect(Math.abs(r.zm)).toBeLessThan(5);
  expect(Math.abs(r.zv)).toBeLessThan(5);
  expect(Math.abs(z)).toBeLessThan(5);
  return { zm: +r.zm.toFixed(2), zv: +r.zv.toFixed(2), chi2: +z.toFixed(2) };
}
test("the exact binomial passes chi-squared, mean and variance at n = 4,097, 10^6 and 10^9 over millions of samples", async () => {
  const g = await theGpu(), S = 1 << 22, report: Record<string, object> = {};
  for (const T of [4097, 1e6, 1e9]) {
    const { x, flags } = await sampleBin(g, `binhalf(${T}u)`, S);
    expect(flags).toBe(0);
    report[`Bin(${T}, 1/2)`] = passes(x, T, 0.5);
  }
  for (const [n, K] of [[4097, 0x9e3779b9], [1e6, 0x4ccccccd], [1e9, 12884902]]) {
    const { x, flags } = await sampleBin(g, `binom(${n}u, ${K}u)`, S);
    expect(flags).toBe(0);
    report[`Bin(${n}, ${K}/2^32)`] = passes(x, n, K / 2 ** 32);
  }
  console.log("exact binomial, 2^22 samples each:", report);
}, 60_000);

// ---------- the slow path ----------
// A BigInt reference: gamma = -ln(2^kb C(2N, N+a) / C(2N, N)) to 640 bits, by Newton's method on e^y from a float start.
const P = 640n, ONEB = 1n << P;
function expB(y: bigint): bigint {
  let s = 0n, r = y;
  while (r > ONEB >> 8n) { r >>= 1n; s++; }
  let sum = ONEB, term = ONEB;
  for (let k = 1n; term !== 0n; k++) { term = (term * r) / (k * ONEB); sum += term; }
  for (; s > 0n; s--) sum = (sum * sum) >> P;
  return sum;
}
function gammaRef(N: number, a: number, kb: number): bigint {
  let num = 1n << BigInt(kb), den = 1n, y0 = -kb * Math.LN2;
  for (let i = 1; i <= a; i++) { num *= BigInt(N - a + i); den *= BigInt(N + i); y0 += Math.log((N + i) / (N - a + i)); }
  const Q = (num * ONEB) / den;
  let y = BigInt(Math.round(y0 * 2 ** 40)) << (P - 40n);
  for (let it = 0; it < 7; it++) y = y - ONEB + (ONEB * ONEB) / ((Q * expB(y)) >> P);
  return y;
}
// Inputs whose exponential agrees with gamma in its first `same` words after the binary point: the fast bounds cannot
// tell them apart, so only the slow path decides. Each case: N, a, kb, kE, x6, and the reference's verdict.
function ambiguousCases() {
  const cases: { N: number; a: number; kb: number; kE: number; x6: number[]; same: number; accept: boolean }[] = [];
  let s = 12345;
  const rnd = () => { s = (Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) + 0x6d2b79f5) >>> 0; return s; };
  for (const N of [2048, 5000, 100000, 1000000, 2 ** 30]) {
    for (const a of [1, 3, 40, 300, 2000]) {
      if (a > N) continue;
      let lq = 0;
      for (let i = 1; i <= a; i++) lq += Math.log((N + i) / (N - a + i));
      for (const kb of [0, Math.max(0, Math.floor(lq / Math.LN2) - 1)]) {
        if (lq - kb * Math.LN2 > 40) continue;
        const gam = gammaRef(N, a, kb), kE = Number(gam >> P), frac = (gam - (BigInt(kE) << P)) >> (P - 192n);
        const gw = Array.from({ length: 6 }, (_, w) => Number((frac >> BigInt(32 * (5 - w))) & 0xffffffffn));
        for (const same of [2, 3, 4, 5]) {
          for (let v = 0; v < 4; v++) {
            const x6 = gw.map((w, k) => (k < same ? w : rnd()));
            let xv = 0n;
            for (const w of x6) xv = (xv << 32n) | BigInt(w);
            if (xv === frac) continue;
            cases.push({ N, a, kb, kE, x6, same, accept: xv > frac });
          }
        }
      }
    }
  }
  return cases;
}
test("the slow path decides forced ambiguous cases as a BigInt reference does, on the GPU as in TypeScript", async () => {
  const cases = ambiguousCases();
  const want = cases.map((c) => { open(0); const acc = R.slowAccept(c.N, c.a, c.kb, c.kE, c.x6); return [acc ? 1 : 0, R.rflags()]; });
  let decided = 0;
  cases.forEach((c, k) => {
    const [acc, flagged] = want[k];
    if (c.same <= 3) expect(flagged).toBe(0);
    if (!flagged) { expect(acc === 1).toBe(c.accept); decided++; }
  });
  const a = Uint32Array.from(cases.flatMap((c) => [c.N, c.a, c.kb, c.kE, ...c.x6]));
  const body = `rinit(0u, 0u, 0u, 0u); let b = 10u * i; let acc = slowAccept(inp[b], inp[b + 1u], inp[b + 2u], inp[b + 3u], array<u32, 6>(inp[b + 4u], inp[b + 5u], inp[b + 6u], inp[b + 7u], inp[b + 8u], inp[b + 9u])); out[2u * i] = select(0u, 1u, acc); out[2u * i + 1u] = rflags;`;
  expect(Array.from(await onGpu(await theGpu(), body, a, cases.length, 2))).toEqual(want.flat());
  console.log(`slow path: ${cases.length} forced ambiguous cases, ${decided} decided (all as the reference), ${cases.length - decided} left undecided at 2^-160`);
}, 60_000);
test("with every acceptance forced through the slow path the sampler is still exact, and the GPU equals the twin", async () => {
  const g = await theGpu();
  for (const [T, S] of [[4097, 1 << 20], [100001, 1 << 18], [1e6, 1 << 16]]) {
    const { x, flags } = await sampleBin(g, `binhalf(${T}u)`, S, true);
    expect(flags).toBe(0);
    passes(x, T, 0.5);
    for (let i = 0; i < 128; i++) { open(i, 1); expect(R.binhalf(T)).toBe(x[i]); }
  }
}, 60_000);

// ---------- geometric waits, multinomials, permutations ----------
test("exact geometric waits have the mean and variance of Geo(p)", async () => {
  const g = await theGpu();
  for (const K of [0x4ccccccd, 42949673, 4295]) {
    const p = K / 2 ** 32, x = await draws(g, `geowait(${K}u)`, 1 << 18, (w) => w), r = moments(x, (1 - p) / p, (1 - p) / p ** 2);
    expect(Math.abs(r.zm)).toBeLessThan(5);
  }
}, 60_000);
test("multinomial splits over dyadic intervals have their outcomes' binomial margins", async () => {
  const n = 1000003, S = 1 << 18, t = [0x10000000, 0x55555555, 0x80000001, 0xf0000000], edges = [0, ...t, 2 ** 32];
  const w = await onGpu(await theGpu(), `${OPEN} let c = multinom(${n}u, array<u32, 15>(${t.map((v) => `${v}u`).join(", ")}, 0u, 0u, 0u, 0u, 0u, 0u, 0u, 0u, 0u, 0u, 0u), 4u); for (var o = 0u; o < 5u; o++) { out[5u * i + o] = c[o]; }`, new Uint32Array(0), S, 5);
  for (let o = 0; o < 5; o++) {
    const x = Uint32Array.from({ length: S }, (_, k) => w[5 * k + o]);
    passes(x, n, (edges[o + 1] - edges[o]) / 2 ** 32);
  }
  for (let k = 0; k < S; k++) expect(w[5 * k] + w[5 * k + 1] + w[5 * k + 2] + w[5 * k + 3] + w[5 * k + 4]).toBe(n);
}, 60_000);
test("a Feistel permutation is a bijection on any size: exhaustively when small, by sampling when large", async () => {
  for (let n = 1; n <= 600; n++) {
    const k = R.fkeys(SEED, STREAM, n, TICK), seen = new Uint8Array(n);
    for (let x = 0; x < n; x++) { const y = R.feistel(x, n, k); expect(y).toBeLessThan(n); expect(seen[y]).toBe(0); seen[y] = 1; expect(R.feistelInv(y, n, k)).toBe(x); }
  }
  for (const n of [65536, 65537, 1 << 20]) {
    const k = R.fkeys(SEED, STREAM, n, TICK), seen = new Uint8Array(n);
    for (let x = 0; x < n; x++) { const y = R.feistel(x, n, k); if (y >= n || seen[y]) throw new Error(`not a bijection on ${n}`); seen[y] = 1; }
  }
  const g = await theGpu();
  for (const n of [1e9, 0xffffffff]) {
    const S = 1 << 20, xs = Uint32Array.from({ length: S }, (_, j) => Math.floor((j * n) / S));
    const w = await onGpu(g, `let k = fkeys(1u, 2u, 3u, 4u); let y = feistel(inp[i], ${n}u, k); out[2u * i] = y; out[2u * i + 1u] = feistelInv(y, ${n}u, k);`, xs, S, 2);
    const ys = new Set<number>();
    for (let j = 0; j < S; j++) { expect(w[2 * j]).toBeLessThan(n); expect(w[2 * j + 1]).toBe(xs[j]); ys.add(w[2 * j]); }
    expect(ys.size).toBe(S);
  }
}, 60_000);

// ---------- throughput ----------
// Draws a second on the GPU for a body run over n invocations (each adding `per` draws to acc), the median of three
// dispatches after a warm-up.
async function throughput(g: Gpu, body: string, n: number, per: number): Promise<number> {
  const ob = storage(g, n * 4), ib = storage(g, new Uint32Array(1));
  g.device.pushErrorScope("validation");
  const p = pipeline(g, FIXED + RAND + /* wgsl */ `
@group(0) @binding(0) var<storage, read> inp: array<u32>;
@group(0) @binding(1) var<storage, read_write> out: array<u32>;
@compute @workgroup_size(${WG}) fn main(@builtin(global_invocation_id) gid: vec3u, @builtin(num_workgroups) nw: vec3u) {
  _ = &inp;
  let i = gid.x + gid.y * nw.x * ${WG}u;
  ${OPEN}
  var acc = 0u;
  ${body}
  out[i] = acc;
}`);
  const err = await g.device.popErrorScope();
  if (err) throw new Error(`${body}: ${err.message}`);
  const ts: number[] = [];
  for (let r = 0; r < 4; r++) {
    const t = performance.now();
    dispatch(g, p, [ib, ob], cover(g, n, WG));
    await g.device.queue.onSubmittedWorkDone();
    if (r > 0) ts.push((performance.now() - t) / 1000);
  }
  ib.destroy();
  ob.destroy();
  return (n * per) / ts.sort((a, b) => a - b)[1];
}
const loop16 = (call: string) => `for (var r = 0u; r < 16u; r++) { acc ^= bitcast<u32>(${call}); }`;
const e3 = (v: number) => v.toExponential(2);
test("throughput of the fixed-point routines and draws on the GPU (reported, not gated)", async () => {
  const g = await theGpu(), n = 1 << 20, rows: Record<string, string> = {};
  rows["Philox4x32-10 words"] = e3(await throughput(g, "for (var r = 0u; r < 16u; r++) { let v = philox(vec4u(i, r, 0u, 0u), vec2u(1u, 2u)); acc ^= v.x ^ v.y ^ v.z ^ v.w; }", n, 64));
  const calls: [string, string][] = [
    ["qmul", "qmul(bitcast<i32>(i * 2654435761u), bitcast<i32>(r * 40503u))"],
    ["qdiv", "qdiv(bitcast<i32>(i * 2654435761u), bitcast<i32>(r * 40503u + 1u))"],
    ["qsqrt", "qsqrt(bitcast<i32>(((i ^ r) * 2654435761u) >> 1u))"],
    ["qexp", "qexp(bitcast<i32>(i * 16u + r) - 0x70000i)"],
    ["qln", "qln(bitcast<i32>(i * 977u + r + 1u))"],
    ["qpow", "qpow(bitcast<i32>(i * 977u + 1u), bitcast<i32>(r * 9000u) - 0x10000i)"],
    ["qlgamma", "qlgamma(bitcast<i32>(i * 97u + r * 3u + 1u))"],
    ["qgamma", "qgamma(bitcast<i32>((i & 0x7ffffu) + r + 1u))"],
    ["qnormal", "qnormal()"],
    ["qexpo", "qexpo()"],
    ["qpoisson(5)", "qpoisson(0x50000i)"],
    ["qpoisson(100)", "qpoisson(0x640000i)"],
    ["qgammav(2.5)", "qgammav(0x28000i)"],
    ["feistel, n = 1e9", "feistel(i * 16u + r, 1000000000u, vec4u(1u, 2u, 3u, 4u))"],
  ];
  for (const [name, call] of calls) rows[name] = e3(await throughput(g, loop16(call), n, 16));
  console.log(`draws a second on ${g.adapter}:`, rows);
}, 60_000);
test("throughput of the exact samplers on the GPU (reported, not gated)", async () => {
  const g = await theGpu(), rows: Record<string, string> = {};
  const runs: [string, string, number, number][] = [
    ["binhalf(4097)", "binhalf(4097u)", 4097, 1 << 20],
    ["binhalf(1e6)", "binhalf(1000000u)", 1e6, 1 << 20],
    ["binhalf(1e9)", "binhalf(1000000000u)", 1e9, 1 << 20],
    ["binom(1e3, 0.3)", "binom(1000u, 1288490189u)", 1e3, 1 << 18],
    ["binom(1e4, 0.3)", "binom(10000u, 1288490189u)", 1e4, 1 << 18],
    ["binom(1e6, 0.003)", "binom(1000000u, 12884902u)", 1e6, 1 << 18],
    ["binom(1e9, 0.003)", "binom(1000000000u, 12884902u)", 1e9, 1 << 18],
    ["multinom(1e6, 5 outcomes)", "multinom(1000000u, array<u32, 15>(0x10000000u, 0x55555555u, 0x80000001u, 0xf0000000u, 0u, 0u, 0u, 0u, 0u, 0u, 0u, 0u, 0u, 0u, 0u), 4u)[2]", 1e6, 1 << 16],
    ["geowait(p = 0.3)", "geowait(1288490189u)", 0, 1 << 18],
    ["geowait(p = 2^-8)", "geowait(16777216u)", 0, 1 << 16],
    ["geowait(p = 1e-3)", "geowait(4294967u)", 0, 1 << 16],
    ["geowait(p = 1e-6)", "geowait(4295u)", 0, 1 << 14],
  ];
  for (const [name, call, fates, n] of runs) {
    const r = await throughput(g, `acc = ${call};`, n, 1);
    rows[name] = `${e3(r)} draws/s` + (fates ? `, ${e3(r * fates)} fates/s` : "");
  }
  console.log(`exact samplers on ${g.adapter}:`, rows);
}, 60_000);
