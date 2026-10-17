// The reals (real.ts, wgsl/real.ts): every operation's WGSL equals its twin bit for bit on both of the dev machine's
// adapters, over random reals of every size and the edges; and the twin is the exact result truncated (add, mul, div,
// sqrt against exact rational arithmetic) or within its stated bound (log2, exp2, pow against float64).
import { afterAll, expect, test } from "bun:test";
import { type Gpu, openGpu, releaseGpu, theGpu } from "./device";
import { cover, dispatch, pipeline, readback, storage } from "./kernel";
import { FIXED } from "./wgsl/fixed";
import { REAL } from "./wgsl/real";
import * as R from "./real";
import * as F from "./fixed";

let low: Gpu | null = null;
afterAll(async () => { low?.device.destroy(); await releaseGpu(); });

function stream(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return (t ^ (t >>> 14)) >>> 0;
  };
}
// A random real with its biased exponent in [lo, hi].
const anyReal = (next: () => number, lo = 1, hi = 254) => R.real(((next() & 0x807fffff) | ((lo + (next() % (hi - lo + 1))) << 23)) >>> 0);
const EDGES = [0, 1, -1, 2, 0.5, R.MINR, -R.MINR, R.MAXR, -R.MAXR, R.T(1 / 3), R.T(Math.PI), 1 - 2 ** -24, 1 + 2 ** -23, 2 ** 24, 2 ** 24 - 1, 3, -3, 1e-30, 1e30, 127.5, -126.5, 128, -126, 0.25];
// Pairs: random reals of any size, pairs a few exponents apart (where adding cancels or carries), and every pair of edges.
function pairs(n: number, seed: number): number[] {
  const next = stream(seed), out: number[] = [];
  for (let k = 0; k < n; k++) {
    const a = anyReal(next), e = (R.bits(a) >>> 23) & 0xff, near = Math.max(1, Math.min(254, e + (next() % 61) - 30));
    out.push(a, next() % 3 === 0 ? anyReal(next) : anyReal(next, near, near));
  }
  for (const a of EDGES) for (const b of EDGES) out.push(R.T(a), R.T(b));
  return out;
}

type Op = { name: string; wgsl: string; ts: (a: number, b: number) => number[]; words: number; inputs: () => number[] };
const pos = (x: number) => Math.abs(x);
const OPS: Op[] = [
  { name: "add", wgsl: "out[i] = r_add(a, b);", ts: (a, b) => [R.bits(R.add(a, b))], words: 1, inputs: () => pairs(1 << 17, 1) },
  { name: "sub", wgsl: "out[i] = r_sub(a, b);", ts: (a, b) => [R.bits(R.sub(a, b))], words: 1, inputs: () => pairs(1 << 16, 2) },
  { name: "mul", wgsl: "out[i] = r_mul(a, b);", ts: (a, b) => [R.bits(R.mul(a, b))], words: 1, inputs: () => pairs(1 << 17, 3) },
  { name: "div", wgsl: "out[i] = r_div(a, b);", ts: (a, b) => [R.bits(R.div(a, b))], words: 1, inputs: () => pairs(1 << 17, 4) },
  { name: "sqrt", wgsl: "out[i] = r_sqrt(a);", ts: (a) => [R.bits(R.sqrt(a))], words: 1, inputs: () => pairs(1 << 16, 5) },
  { name: "log2", wgsl: "out[i] = r_log2(a);", ts: (a) => [R.bits(R.log2(a))], words: 1, inputs: () => pairs(1 << 15, 6).map(pos) },
  { name: "exp2", wgsl: "out[i] = r_exp2(a);", ts: (a) => [R.bits(R.exp2(a))], words: 1, inputs: () => { const next = stream(7); return [...pairs(1 << 14, 7), ...Array.from({ length: 1 << 15 }, () => R.T(((next() / 2 ** 32) * 2 - 1) * 140))]; } },
  { name: "pow", wgsl: "out[i] = r_pow(a, b);", ts: (a, b) => [R.bits(R.pow(a, b))], words: 1, inputs: () => { const next = stream(8); return Array.from({ length: 1 << 16 }, (_, k) => (k % 2 ? R.T(((next() / 2 ** 32) * 2 - 1) * 6) : Math.abs(anyReal(next, 60, 190)))); } },
  { name: "fix", wgsl: "let v = r_fix(a, 32i); out[2u * i] = v.x; out[2u * i + 1u] = v.y;", ts: (a) => { const v = R.fix(a, 32); return [v % 2 ** 32 >>> 0, Math.floor(v / 2 ** 32) >>> 0]; }, words: 2, inputs: () => { const next = stream(9); return Array.from({ length: 1 << 15 }, () => R.T(((next() / 2 ** 32) * 2 - 1) * 2 ** ((next() % 60) - 30))); } },
  { name: "whole", wgsl: "out[i] = r_whole(a, 0xffffffffu, 1i);", ts: (a) => [R.whole(a, 0xffffffff, 1)], words: 1, inputs: () => [...pairs(1 << 14, 10), ...Array.from({ length: 4096 }, (_, k) => R.T((k - 2048) / 4))] },
  { name: "from", wgsl: "out[i] = r_from_i(bitcast<i32>(a));", ts: (a) => [R.bits(R.T(R.bits(a) | 0))], words: 1, inputs: () => pairs(1 << 15, 11) },
];

async function onGpu(g: Gpu, op: Op, inp: Uint32Array, n: number): Promise<Uint32Array> {
  const src = FIXED + REAL + /* wgsl */ `
@group(0) @binding(0) var<storage, read> inp: array<u32>;
@group(0) @binding(1) var<storage, read_write> out: array<u32>;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) gid: vec3u, @builtin(num_workgroups) nw: vec3u) {
  let i = gid.x + gid.y * nw.x * 64u;
  if (i >= ${n}u) { return; }
  r_init(32u);
  let a = inp[2u * i]; let b = inp[2u * i + 1u];
  ${op.wgsl}
}`;
  const ib = storage(g, inp), ob = storage(g, n * op.words * 4);
  dispatch(g, pipeline(g, src), [ib, ob], cover(g, n, 64));
  const out = new Uint32Array(await readback(g, ob));
  ib.destroy();
  ob.destroy();
  return out;
}

test("every operation's WGSL equals its twin bit for bit on both adapters", async () => {
  low = await openGpu("low-power");
  for (const op of OPS) {
    const v = op.inputs(), n = v.length >> 1, inp = new Uint32Array(2 * n), want = new Uint32Array(n * op.words);
    for (let k = 0; k < n; k++) {
      inp[2 * k] = R.bits(v[2 * k]); inp[2 * k + 1] = R.bits(v[2 * k + 1]);
      want.set(op.ts(v[2 * k], v[2 * k + 1]), k * op.words);
    }
    for (const g of [await theGpu(), low]) {
      const got = await onGpu(g, op, inp, n);
      let bad = -1;
      for (let k = 0; k < want.length && bad < 0; k++) if (got[k] !== want[k]) bad = k;
      expect(bad < 0 ? "" : `${op.name} on ${g.adapter}: ${v[2 * Math.floor(bad / op.words)]}, ${v[2 * Math.floor(bad / op.words) + 1]}: ${got[bad]} not ${want[bad]}`).toBe("");
    }
  }
}, 300_000);

// The exact rational value of a real (or a double) as a numerator over a power of two.
function exact(x: number): [bigint, number] {
  if (x === 0) return [0n, 0];
  let e = 0;
  while (!Number.isInteger(x)) { x *= 2; e++; }
  return [BigInt(x), e];
}
// The exact result p / 2^e, truncated toward zero to a real.
function truncated(p: bigint, e: number): number {
  if (p === 0n) return 0;
  const neg = p < 0n, m = neg ? -p : p, len = m.toString(2).length, keep = len > 24 ? m >> BigInt(len - 24) : m;
  return R.T((neg ? -1 : 1) * Number(keep) * 2 ** (Math.max(0, len - 24) - e));
}
test("add, mul, div and sqrt are the exact result truncated; log2, exp2 and pow within their bounds", () => {
  const v = pairs(1 << 14, 12);
  for (let k = 0; k < v.length; k += 2) {
    const [a, b] = [v[k], v[k + 1]], [pa, ea] = exact(a), [pb, eb] = exact(b), e = Math.max(ea, eb);
    const sum = truncated(pa * 2n ** BigInt(e - ea) + pb * 2n ** BigInt(e - eb), e);
    if (Math.abs(sum) < R.MAXR) expect(R.add(a, b)).toBe(sum);
    const prod = truncated(pa * pb, ea + eb);
    if (Math.abs(a * b) < R.MAXR) expect(R.mul(a, b)).toBe(prod);
    if (b !== 0 && Math.abs(a / b) < R.MAXR && Math.abs(a / b) > R.MINR) {
      const sh = 60 + pb.toString(2).length, q = (pa * 2n ** BigInt(sh + eb)) / pb;
      expect(R.div(a, b)).toBe(truncated(q, sh + ea));
    }
  }
  for (let k = 0; k < v.length; k++) {
    const a = Math.abs(v[k]);
    if (a === 0) continue;
    const r = R.sqrt(a), [pr, er] = exact(r), [pa, ea] = exact(a), up = R.T(r * (1 + 2 ** -23)) === r ? r * (1 + 2 ** -22) : r * (1 + 2 ** -23);
    // r^2 <= a < (r + ulp)^2
    expect(pr * pr * 2n ** BigInt(ea) <= pa * 2n ** BigInt(2 * er)).toBe(true);
    expect(up * up > a || up * up === Infinity).toBe(true);
    const l = R.log2(a);
    expect(Math.abs(l - Math.log2(a))).toBeLessThanOrEqual(Math.abs(Math.log2(a)) * 2 ** -23 + 2 ** -30);
  }
  for (let z = -125; z < 127; z += 0.01) {
    const x = R.T(z);
    expect(Math.abs(R.exp2(x) / 2 ** x - 1)).toBeLessThan(2 ** -22);
  }
  for (const x of [1e-6, 0.003, 0.5, 1.7, 290, 7.3e4, 1.2e12]) for (const y of [-4, -0.49, -0.25, 0.125, 1 / 3, 0.4, 2.5, 4]) {
    const r = R.pow(R.T(x), R.T(y)), want = R.T(x) ** R.T(y);
    if (want < R.MAXR && want > R.MINR) expect(Math.abs(r / want - 1)).toBeLessThan(2 ** -22 + Math.abs(R.T(y) * Math.log2(R.T(x))) * 2 ** -23);
  }
});
test("the twin's log and exp cores equal fixed.ts's", () => {
  const next = stream(13);
  for (let k = 0; k < 1 << 16; k++) {
    const m = (next() | 0x80000000) >>> 0, f = next();
    expect(R.lg2m(m)).toBe(F.lg2m(m));
    expect(R.e2f(f)).toBe(F.e2f(f));
  }
});
