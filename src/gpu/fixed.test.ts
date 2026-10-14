import { afterAll, expect, test } from "bun:test";
import { type Gpu, openGpu, releaseGpu, theGpu } from "./device";
import { cover, dispatch, pipeline, readback, storage } from "./kernel";
import { FIXED } from "./wgsl/fixed";
import * as F from "./fixed";

afterAll(releaseGpu);
let low: Gpu | null = null;
afterAll(() => low?.device.destroy());

// Runs a WGSL body over n invocations (index i) with the u32 input words a and outPer output words each, on a GPU.
async function onGpu(g: Gpu, body: string, a: Uint32Array, n: number, outPer: number): Promise<Uint32Array> {
  const src = FIXED + /* wgsl */ `
@group(0) @binding(0) var<storage, read> inp: array<u32>;
@group(0) @binding(1) var<storage, read_write> out: array<u32>;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) gid: vec3u, @builtin(num_workgroups) nw: vec3u) {
  _ = &inp;
  let i = gid.x + gid.y * nw.x * 64u;
  if (i >= ${n}u) { return; }
  ${body}
}`;
  const ib = storage(g, a), ob = storage(g, n * outPer * 4);
  dispatch(g, pipeline(g, src), [ib, ob], cover(g, n, 64));
  const out = new Uint32Array(await readback(g, ob));
  ib.destroy();
  ob.destroy();
  return out;
}

const U = 2 ** -16, MAX = 0x7fffffff;
// n Q16.16 values spread evenly over [lo, hi] (in raw units), plus every raw value within 512 of each end.
function grid(lo: number, hi: number, n: number): Int32Array {
  const v: number[] = [];
  for (let k = 0; k < n; k++) v.push(Math.round(lo + ((hi - lo) * k) / (n - 1)));
  for (let k = 0; k < 512; k++) v.push(Math.min(hi, lo + k), Math.max(lo, hi - k));
  return Int32Array.from(v);
}
// Deterministic pseudo-random words for test inputs.
function words(n: number, seed: number): Uint32Array {
  const out = new Uint32Array(n);
  let s = seed >>> 0;
  for (let k = 0; k < n; k++) { s = (Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) + 0x9e3779b9) >>> 0; out[k] = (s ^ (s >>> 13)) >>> 0; }
  return out;
}

// One routine checked: its WGSL over inputs (one or two i32 per case) equals its twin bit for bit.
type Case = { name: string; arity: 1 | 2; wgsl: string; ts: (...x: number[]) => number; inputs: () => Int32Array };
const pairs = (n: number, seed: number, shiftA: number, shiftB: number) => {
  const w = words(2 * n, seed), v = new Int32Array(2 * n);
  for (let k = 0; k < n; k++) { v[2 * k] = (w[2 * k] | 0) >> ((w[2 * k + 1] & 31) % (shiftA + 1)); v[2 * k + 1] = (w[2 * k + 1] | 0) >> (((w[2 * k] >>> 8) & 31) % (shiftB + 1)); }
  return v;
};
const EDGES = [0, 1, -1, 2, -2, 0x8000, -0x8000, F.ONE, -F.ONE, MAX, -MAX, -0x80000000, 0x40000000, -0x40000000, 12345678, -12345678];
const edgePairs = () => Int32Array.from(EDGES.flatMap((a) => EDGES.flatMap((b) => [a, b])));
const join = (...xs: Int32Array[]) => { const v = new Int32Array(xs.reduce((s, x) => s + x.length, 0)); let o = 0; for (const x of xs) { v.set(x, o); o += x.length; } return v; };
const CASES: Case[] = [
  { name: "qadd", arity: 2, wgsl: "qadd", ts: F.qadd, inputs: () => join(pairs(1 << 18, 1, 31, 31), edgePairs()) },
  { name: "qmul", arity: 2, wgsl: "qmul", ts: F.qmul, inputs: () => join(pairs(1 << 19, 2, 31, 31), edgePairs()) },
  { name: "qdiv", arity: 2, wgsl: "qdiv", ts: F.qdiv, inputs: () => join(pairs(1 << 18, 3, 31, 31), edgePairs()) },
  { name: "qsqrt", arity: 1, wgsl: "qsqrt", ts: F.qsqrt, inputs: () => join(grid(0, MAX, 1 << 19), grid(-1000, 1 << 18, 1 << 16)) },
  { name: "qlog2", arity: 1, wgsl: "qlog2", ts: F.qlog2, inputs: () => join(grid(1, MAX, 1 << 19), grid(-5, 1 << 18, 1 << 16)) },
  { name: "qln", arity: 1, wgsl: "qln", ts: F.qln, inputs: () => join(grid(1, MAX, 1 << 19), grid(-5, 1 << 18, 1 << 16)) },
  { name: "qexp", arity: 1, wgsl: "qexp", ts: F.qexp, inputs: () => join(grid(-13 << 16, 11 << 16, 1 << 20), Int32Array.from(EDGES)) },
  { name: "qpow", arity: 2, wgsl: "qpow", ts: F.qpow, inputs: () => join(pairs(1 << 18, 4, 31, 31).map((v, k) => (k & 1 ? v >> 12 : v)), edgePairs()) },
  { name: "qlgamma", arity: 1, wgsl: "qlgamma", ts: F.qlgamma, inputs: () => join(grid(1, 4200 << 16, 1 << 18), grid(-3, 12 << 16, 1 << 17), Int32Array.from(EDGES)) },
  { name: "qgamma", arity: 1, wgsl: "qgamma", ts: F.qgamma, inputs: () => join(grid(1, 9 << 16, 1 << 18), Int32Array.from(EDGES)) },
];
const INPUTS: Record<string, Int32Array> = Object.fromEntries(CASES.map((c) => [c.name, c.inputs()]));
const twin = (c: Case, x: Int32Array) => {
  const n = x.length / c.arity, out = new Int32Array(n);
  for (let k = 0; k < n; k++) out[k] = c.arity === 1 ? c.ts(x[k]) : c.ts(x[2 * k], x[2 * k + 1]);
  return out;
};
const TWINS: Record<string, Int32Array> = Object.fromEntries(CASES.map((c) => [c.name, twin(c, INPUTS[c.name])]));
async function gpuOf(g: Gpu, c: Case, x: Int32Array) {
  const n = x.length / c.arity;
  const call = c.arity === 1 ? `${c.wgsl}(bitcast<i32>(inp[i]))` : `${c.wgsl}(bitcast<i32>(inp[2u * i]), bitcast<i32>(inp[2u * i + 1u]))`;
  return new Int32Array((await onGpu(g, `out[i] = bitcast<u32>(${call});`, new Uint32Array(x.buffer), n, 1)).buffer);
}
function sameAs(name: string, x: Int32Array, arity: number, got: Int32Array, want: Int32Array) {
  for (let k = 0; k < want.length; k++)
    if (got[k] !== want[k]) throw new Error(`${name}(${Array.from(x.subarray(arity * k, arity * k + arity)).join(", ")}): GPU ${got[k]}, twin ${want[k]}`);
}

test("the exp2 table rounds far from any rounding boundary, so every engine builds the same one", () => {
  for (let j = 0; j < 256; j++) {
    const v = 2 ** (j / 256) * 2 ** 31;
    expect(Math.abs(v - Math.floor(v) - 0.5)).toBeGreaterThan(2 ** -8);
    expect(F.EXP2_TABLE[j]).toBe(Math.round(v));
  }
});

test("every fixed-point routine gives its TypeScript twin's result bit for bit on the GPU", async () => {
  const g = await theGpu();
  for (const c of CASES) sameAs(c.name, INPUTS[c.name], c.arity, await gpuOf(g, c, INPUTS[c.name]), TWINS[c.name]);
  const x = Uint32Array.from(grid(1, MAX, 1 << 16));
  const want = new Uint32Array(2 * x.length);
  for (let k = 0; k < x.length; k++) want.set(F.lgamma32(x[k]), 2 * k);
  const got = await onGpu(g, "let v = lgamma32(inp[i]); out[2u * i] = v.x; out[2u * i + 1u] = v.y;", x, x.length, 2);
  expect(got).toEqual(want);
}, 60_000);

test("the same kernels on the low-power adapter give identical output", async () => {
  low = await openGpu("low-power");
  for (const c of CASES) {
    const x = INPUTS[c.name].subarray(0, c.arity * (1 << 16));
    sameAs(c.name, x, c.arity, await gpuOf(low, c, x), TWINS[c.name].subarray(0, 1 << 16));
  }
}, 60_000);

// The float64 lnGamma (Lanczos, g = 7, n = 9; relative error near 1e-15) the bounds are measured against.
function lnGamma(z: number): number {
  const c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  if (z < 0.5) return Math.log(Math.PI / Math.abs(Math.sin(Math.PI * z))) - lnGamma(1 - z);
  z -= 1;
  let x = c[0];
  for (let i = 1; i < 9; i++) x += c[i] / (z + i);
  const t = z + 7.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
}
// The worst ratio of error to bound over a routine's grid, against float64; results out of Q16.16's range must saturate.
function worst(name: string, ref: (...x: number[]) => number, bound: (r: number, ...x: number[]) => number): number {
  const c = CASES.find((c) => c.name === name)!, x = INPUTS[name], got = TWINS[name];
  let w = 0;
  for (let k = 0; k < got.length; k++) {
    const args = c.arity === 1 ? [x[k] * U] : [x[2 * k] * U, x[2 * k + 1] * U], r = ref(...args);
    if (!Number.isFinite(r) || Number.isNaN(r)) continue;
    if (Math.abs(r) / U >= MAX + 0.5) { expect(Math.abs(got[k])).toBe(MAX); continue; }
    w = Math.max(w, Math.abs(got[k] * U - r) / bound(Math.abs(r), ...args));
  }
  return w;
}
const ulp = (n: number) => n * U;
test("each routine keeps within its stated error bound against float64", () => {
  expect(worst("qadd", (a, b) => a + b, () => ulp(1e-9))).toBeLessThanOrEqual(1);
  expect(worst("qmul", (a, b) => a * b, () => ulp(0.5 + 1e-9))).toBeLessThanOrEqual(1);
  expect(worst("qdiv", (a, b) => (b === 0 ? NaN : a / b), () => ulp(0.5 + 1e-9))).toBeLessThanOrEqual(1);
  expect(worst("qsqrt", (a) => (a < 0 ? 0 : Math.sqrt(a)), () => ulp(1))).toBeLessThan(1);
  expect(worst("qlog2", (a) => (a <= 0 ? NaN : Math.log2(a)), () => ulp(0.5) + 2 ** -26)).toBeLessThanOrEqual(1);
  expect(worst("qln", (a) => (a <= 0 ? NaN : Math.log(a)), () => ulp(0.5) + 2 ** -26)).toBeLessThanOrEqual(1);
  expect(worst("qexp", Math.exp, (r) => ulp(0.5) + r * 2 ** -29)).toBeLessThanOrEqual(1);
  expect(worst("qpow", (x, y) => (x <= 0 ? NaN : x ** y), (r, x, y) => ulp(0.5) + r * 2 ** -28 * (1 + Math.abs(y * Math.log2(x))))).toBeLessThanOrEqual(1);
  expect(worst("qlgamma", (x) => (x <= 0 ? NaN : lnGamma(x)), (_, x) => ulp(0.5) + x * 2 ** -29)).toBeLessThanOrEqual(1);
  expect(worst("qgamma", (x) => (x <= 0 ? NaN : Math.exp(lnGamma(x))), (r) => ulp(0.5) + r * 2 ** -27)).toBeLessThanOrEqual(1);
  // lnGamma in Q32.32 over the whole positive Q16.16 range, within 2^-28 + x 2^-30.
  for (const x of grid(1 << 16, MAX, 1 << 14)) {
    const v = F.lgamma32(x), got = (v[1] | 0) + v[0] / 2 ** 32, r = lnGamma(x * U);
    expect(Math.abs(got - r)).toBeLessThanOrEqual(2 ** -28 + x * U * 2 ** -30);
  }
});

test("at their range limits the routines saturate or underflow exactly and keep exact points exact", () => {
  for (const x of [-12.2 * F.ONE, -13 * F.ONE, -1000 * F.ONE, -MAX, -0x80000000]) expect(F.qexp(Math.round(x))).toBe(0);
  for (const x of [10.4 * F.ONE, 11 * F.ONE, MAX]) expect(F.qexp(Math.round(x))).toBe(MAX);
  expect(F.qexp(0)).toBe(F.ONE);
  expect(F.qexp(Math.round(10.39 * F.ONE))).toBe(Math.round(Math.exp(Math.round(10.39 * F.ONE) * U) * F.ONE));
  expect(F.qlog2(F.ONE)).toBe(0);
  expect(F.qlog2(1024 * F.ONE)).toBe(10 * F.ONE);
  expect(F.qlog2(1)).toBe(-16 * F.ONE);
  expect(F.qlog2(0)).toBe(-MAX);
  expect(F.qln(-5)).toBe(-MAX);
  expect(F.qmul(MAX, MAX)).toBe(MAX);
  expect(F.qmul(-MAX, MAX)).toBe(-MAX);
  expect(F.qmul(-0x80000000, F.ONE)).toBe(-MAX);
  expect(F.qmul(3 * F.ONE, -7 * F.ONE)).toBe(-21 * F.ONE);
  expect(F.qdiv(F.ONE, 0)).toBe(MAX);
  expect(F.qdiv(-F.ONE, 0)).toBe(-MAX);
  expect(F.qdiv(0, 0)).toBe(0);
  expect(F.qdiv(MAX, 1)).toBe(MAX);
  expect(F.qdiv(-21 * F.ONE, 7 * F.ONE)).toBe(-3 * F.ONE);
  expect(F.qadd(MAX, 1)).toBe(MAX);
  expect(F.qadd(-MAX, -5)).toBe(-MAX);
  expect(F.qsqrt(MAX)).toBe(Math.floor(Math.sqrt(MAX * F.ONE)));
  expect(F.qsqrt(4 * F.ONE)).toBe(2 * F.ONE);
  expect(F.qsqrt(-1)).toBe(0);
  expect(F.qpow(0, F.ONE)).toBe(0);
  expect(F.qpow(5 * F.ONE, 0)).toBe(F.ONE);
  expect(F.qpow(2 * F.ONE, 10 * F.ONE)).toBe(1024 * F.ONE);
  expect(F.qpow(2 * F.ONE, 15 * F.ONE)).toBe(MAX);
  expect(F.qpow(2 * F.ONE, -17 * F.ONE)).toBe(1);
  expect(F.qpow(2 * F.ONE, -18 * F.ONE)).toBe(0);
  expect(F.qlgamma(F.ONE)).toBe(0);
  expect(F.qlgamma(2 * F.ONE)).toBe(0);
  expect(F.qlgamma(0)).toBe(MAX);
  expect(F.qlgamma(5000 * F.ONE)).toBe(MAX);
  expect(F.qgamma(F.ONE)).toBe(F.ONE);
  expect(F.qgamma(5 * F.ONE)).toBe(24 * F.ONE);
  expect(F.qgamma(9 * F.ONE)).toBe(MAX);
  expect(F.qgamma(1)).toBe(MAX);
});
