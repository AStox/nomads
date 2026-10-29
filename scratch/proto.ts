// Artificial shelf prototype: a store of the baseline chain whose sea cells near land are raised to a graded shelf (depth' = min(depth, ramp(d)), d km to the nearest land cell centre).
//   bun scratch/proto.ts <s10|s30|s02>   -> ~/.cache/nomads-scratch/t7/store-<variant>/1-<KEY>/{chain,climate0,ice,climate1}.bin
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tierGrid } from "../src/gpu/globe/grid";
import { cellVectors, neighbours } from "../src/gpu/globe/tectonics";
import { packRecord, unpackRecord } from "../src/gpu/globe/window";
const H = process.env.HOME + "/.cache/nomads-scratch/", KEY = "b4c6e7d1b819", SRC = H + `t5/bake/small/store/1-${KEY}/`;
const variant = process.argv[2] ?? "s10", R_CELLS = 60;
// depth (m) the shelf allows at d metres from land
const ramps: Record<string, (dm: number) => number> = {
  s10: (d) => (d < 130000 ? 1e-3 * d : Infinity),
  s30: (d) => Math.min(30, 1e-3 * d),
  s02: (d) => Math.min(130, 2e-4 * d),
};
const ramp = ramps[variant];
if (!ramp) throw new Error("variant: " + Object.keys(ramps).join(", "));
const rec = (n: string) => unpackRecord(new Uint8Array(readFileSync(SRC + n + ".bin")));
const chain = rec("chain"), ice = rec("ice"), now = ice.meta.nowM as number;
const radius = chain.meta.radius as number, g = tierGrid(0, radius), N = chain.arrays.height.length, fn = g.fn;
const after = ice.arrays.after as Float32Array, hC = chain.arrays.height as Float32Array, hM = chain.arrays.heightM as Float32Array;
const h = Float32Array.from(after, (a) => a - now);
const nb = neighbours(g), vec = cellVectors(g), Rkm = radius / 1000, cellKm = (Rkm * Math.PI) / 2 / fn, maxKm = R_CELLS * cellKm;
const arc = (a: number, b: number) => Rkm * Math.acos(Math.min(1, vec[3 * a] * vec[3 * b] + vec[3 * a + 1] * vec[3 * b + 1] + vec[3 * a + 2] * vec[3 * b + 2]));
// 8 neighbours: the 4 table neighbours and the 4 diagonals reached through two table steps (perpendicular directions)
function around(c: number, out: number[]) {
  out.length = 0;
  for (let d = 0; d < 4; d++) {
    const a = nb[4 * c + d]; if (a < 0 || a === c) continue;
    out.push(a);
    for (const e of [(d + 1) & 3, (d + 3) & 3]) { const b = nb[4 * a + e]; if (b >= 0 && b !== c) out.push(b); }
  }
}
const dist = new Float64Array(N).fill(Infinity);
// binary heap of [dist, cell]
const hk: number[] = [], hv: number[] = [];
const push = (k: number, v: number) => { let i = hk.length; hk.push(k); hv.push(v); while (i > 0) { const p = (i - 1) >> 1; if (hk[p] <= k) break; hk[i] = hk[p]; hv[i] = hv[p]; i = p; } hk[i] = k; hv[i] = v; };
const pop = () => { const k0 = hk[0], v0 = hv[0], k = hk.pop()!, v = hv.pop()!; const n = hk.length; if (n) { let i = 0; for (;;) { let c = 2 * i + 1; if (c >= n) break; if (c + 1 < n && hk[c + 1] < hk[c]) c++; if (hk[c] >= k) break; hk[i] = hk[c]; hv[i] = hv[c]; i = c; } hk[i] = k; hv[i] = v; } return [k0, v0]; };
let land = 0;
for (let i = 0; i < N; i++) if (h[i] > 0) { dist[i] = 0; push(0, i); land++; }
const tmp: number[] = [];
while (hk.length) {
  const [d, c] = pop(); if (d > dist[c]) continue;
  around(c, tmp);
  for (const a of tmp) { const nd = d + arc(c, a); if (nd < dist[a] && nd <= maxKm) { dist[a] = nd; push(nd, a); } }
}
const nh = Float32Array.from(h), dH = new Float32Array(N);
let changed = 0, seaNear = 0;
for (let i = 0; i < N; i++) {
  if (h[i] > 0 || !(dist[i] <= maxKm)) continue;
  seaNear++;
  const depth = -h[i], dep = Math.min(depth, ramp(dist[i] * 1000));
  if (dep < depth) { nh[i] = -dep; dH[i] = nh[i] - h[i]; changed++; }
}
// the output records: delta on height, heightM (rounded) and ice.after; the rest as it was
const hC2 = Float32Array.from(hC, (v, i) => v + dH[i]), hM2 = Float32Array.from(hM, (v, i) => (dH[i] ? Math.round(hC2[i]) : v)), af2 = Float32Array.from(after, (v, i) => v + dH[i]);
const out = H + `t7/store-${variant}/1-${KEY}/`; mkdirSync(out, { recursive: true });
writeFileSync(out + "chain.bin", packRecord(chain.meta, { ...chain.arrays, height: hC2, heightM: hM2 }));
writeFileSync(out + "ice.bin", packRecord(ice.meta, { ...ice.arrays, after: af2 }));
for (const n of ["climate0", "climate1"]) copyFileSync(SRC + n + ".bin", out + n + ".bin");
// stats
const ix = (f: number, X: number, Y: number) => (f * fn + Y) * fn + X, landN = nh.reduce((s, v) => s + (v > 0 ? 1 : 0), 0);
const edges = [10, 30, 100], cnt = [0, 0, 0, 0], cnt0 = [0, 0, 0, 0]; let coast = 0;
for (let i = 0; i < N; i++) {
  if (h[i] <= 0) continue;
  let deep = -1, deep0 = -1;
  for (let d = 0; d < 4; d++) { const a = nb[4 * i + d]; if (h[a] <= 0) { deep = Math.max(deep, -nh[a]); deep0 = Math.max(deep0, -h[a]); } }
  if (deep0 < 0) continue; coast++;
  for (let e = 0; e < 3; e++) { if (deep < 0) continue; }
  const dd = Math.max(...[0].map(() => 0)); void dd;
  // deepest sea 4-neighbour is shallower than the edge: depth is the positive depth
  let dmax = 0, dmax0 = 0; for (let d = 0; d < 4; d++) { const a = nb[4 * i + d]; if (h[a] <= 0) { dmax = Math.max(dmax, -nh[a]); dmax0 = Math.max(dmax0, -h[a]); } }
  for (let e = 0; e < 3; e++) { if (dmax < edges[e]) cnt[e]++; if (dmax0 < edges[e]) cnt0[e]++; }
}
void ix; void existsSync;
console.log(variant, "land share", (land / N).toFixed(5), "->", (landN / N).toFixed(5), "unchanged:", land === landN, "| sea cells within R", seaNear, "changed", changed, "| coast land cells", coast);
console.log("coast cells whose deepest sea 4-neighbour < 10/30/100 m: baseline", cnt0.slice(0, 3).map((c) => (100 * c / coast).toFixed(1) + "%").join(" "), "variant", cnt.slice(0, 3).map((c) => (100 * c / coast).toFixed(1) + "%").join(" "));
