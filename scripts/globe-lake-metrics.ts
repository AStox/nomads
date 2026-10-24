// How the page's lakes look at each tier of a pyramid, read at the 75 m cells: for every lake of the planet's own tier (water over land), the area the page draws for it over the area it has, how
// square its outline is (area over bounding box), and how many drawn lakes are the same shape as another (the translation-normalised mask). Series: the old water field (max or mean pooled depth, wet
// from 0.25 m) and the lake share (wet from a half), simulated from the stage files (binary cells) and read from a built pyramid's `lake` planes (TILES=<bake dir>).
//   [TILES=<bake dir>] bun scripts/globe-lake-metrics.ts <bake dir> <faces e.g. 3,4> <tiers e.g. 5,4,3,2>
import { openSync, readSync, readFileSync } from "fs";
import { readTile } from "../src/gpu/globe/pyramid";
const dir = process.argv[2], faces = process.argv[3].split(",").map(Number), tiers = process.argv[4].split(",").map(Number);
const FN = 8192, N = FN * FN, TOP = 5;
const wf = openSync(dir + "/t5-water.u16", "r"), hf = openSync(dir + "/t5-height.i32", "r");
type Agg = { ratios: number[]; lost: number; truthLakes: number;  lakes: number; area: number; truth: number; inter: number; uni: number; fillSum: number; fillN: number; boxy: number; rep: number; repN: number; top: [string, number][]; shapes: Map<string, number> };
const agg = new Map<string, Agg>();
const get = (k: string) => { if (!agg.has(k)) agg.set(k, { ratios: [], lost: 0, truthLakes: 0, lakes: 0, area: 0, truth: 0, inter: 0, uni: 0, fillSum: 0, fillN: 0, boxy: 0, rep: 0, repN: 0, top: [], shapes: new Map() }); return agg.get(k)!; };
let CUR_FACE = 0; const TILES = process.env.TILES ?? "";
function fromTiles(k: number): Float32Array {
  const t = TOP - k, nc = FN >> k, out = new Float32Array(nc * nc), nt = nc >> 8 || 1;
  for (let ty = 0; ty < nt; ty++) for (let tx = 0; tx < nt; tx++) { const p = readTile(new Uint8Array(readFileSync(`${TILES}/pyramid/t${t}/f${CUR_FACE}/${ty}-${tx}.tile.gz`))).planes.lake as Uint8Array; for (let y = 0; y < Math.min(256, nc); y++) for (let x = 0; x < Math.min(256, nc); x++) out[(ty * 256 + y) * nc + tx * 256 + x] = p[y * 256 + x]; }
  return out;
}
function coarse(cm: Uint16Array, k: number, mode: "max" | "mean" | "lake" | "tiles"): Float32Array {
  if (mode === "tiles") return fromTiles(k);
  const s = 1 << k, nc = FN / s, out = new Float32Array(nc * nc);
  for (let cy = 0; cy < nc; cy++) for (let cx = 0; cx < nc; cx++) {
    let mx = 0, sum = 0, lk = 0;
    for (let y = 0; y < s; y++) { const row = (cy * s + y) * FN + cx * s; for (let x = 0; x < s; x++) { const u = Math.min(255, Math.round(cm[row + x] / 50)); if (u > mx) mx = u; sum += cm[row + x]; if (cm[row + x] > 0) lk++; } }
    out[cy * nc + cx] = mode === "max" ? mx : mode === "lake" ? Math.round((255 * lk) / (s * s)) : Math.min(255, Math.round(sum / (s * s) / 50));
  }
  return out;
}
function mask(c: Float32Array, k: number, thr: number): Uint8Array {
  const s = 1 << k, nc = FN / s, m = new Uint8Array(N), at = (x: number, y: number) => c[Math.min(nc - 1, Math.max(0, y)) * nc + Math.min(nc - 1, Math.max(0, x))];
  for (let iy = -1; iy < nc; iy++) for (let ix = -1; ix < nc; ix++) {
    const a = at(ix, iy), b = at(ix + 1, iy), cc = at(ix, iy + 1), d = at(ix + 1, iy + 1);
    if (a === 0 && b === 0 && cc === 0 && d === 0) continue;
    const xs = Math.max(0, Math.ceil((ix + 0.5) * s - 0.5)), xe = Math.min(FN - 1, Math.ceil((ix + 1.5) * s - 0.5) - 1), ys = Math.max(0, Math.ceil((iy + 0.5) * s - 0.5)), ye = Math.min(FN - 1, Math.ceil((iy + 1.5) * s - 0.5) - 1);
    for (let y = ys; y <= ye; y++) { const fy = (y + 0.5) / s - 0.5 - iy; for (let x = xs; x <= xe; x++) { const fx = (x + 0.5) / s - 0.5 - ix; const w = (a * (1 - fx) + b * fx) * (1 - fy) + (cc * (1 - fx) + d * fx) * fy; if (w >= thr) m[y * FN + x] = 1; } }
  }
  return m;
}
function components(m: Uint8Array, A: Agg, tid?: Int32Array, tarea?: number[]) {
  const lab = new Uint8Array(N), st: number[] = [];
  for (let i = 0; i < N; i++) {
    if (!m[i] || lab[i]) continue;
    st.length = 0; st.push(i); lab[i] = 1; const cells: number[] = [];
    let x0 = FN, x1 = -1, y0 = FN, y1 = -1;
    while (st.length) { const c = st.pop()!; cells.push(c); const y = (c / FN) | 0, x = c - y * FN; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      if (x > 0 && m[c - 1] && !lab[c - 1]) { lab[c - 1] = 1; st.push(c - 1); } if (x < FN - 1 && m[c + 1] && !lab[c + 1]) { lab[c + 1] = 1; st.push(c + 1); }
      if (y > 0 && m[c - FN] && !lab[c - FN]) { lab[c - FN] = 1; st.push(c - FN); } if (y < FN - 1 && m[c + FN] && !lab[c + FN]) { lab[c + FN] = 1; st.push(c + FN); } }
    const a = cells.length; A.lakes++;
    if (tid && tarea) { const seen = new Set<number>(); for (const c of cells) if (tid[c] > 0) seen.add(tid[c]); let ta = 0; for (const id of seen) ta += tarea[id]; if (ta > 0) A.ratios.push(a / ta); }
    const fill = a / ((x1 - x0 + 1) * (y1 - y0 + 1));
    if (a >= 16) { A.fillSum += fill; A.fillN++; if (fill > 0.85) A.boxy++; }
    if (a >= 16 && a <= 6000) { let h = 2166136261; for (const c of cells) { const y = ((c / FN) | 0) - y0, x = (c % FN) - x0; h = Math.imul(h ^ (y * 4096 + x), 16777619) >>> 0; } const key = `${x1 - x0}x${y1 - y0}:${a}:${h}`; A.shapes.set(key, (A.shapes.get(key) ?? 0) + 1); A.repN++; }
  }
}
const buf = new Uint16Array(N), hb = new Int32Array(N);
function runSet(label: string, truth: Uint8Array, methods: [string, "max" | "mean" | "lake" | "tiles", number][], tiers: number[]) {
  let tA = 0; for (let i = 0; i < N; i++) tA += truth[i];
  const tid = new Int32Array(N), tarea: number[] = [0]; { let id = 0; const st: number[] = [];
    for (let i = 0; i < N; i++) { if (!truth[i] || tid[i]) continue; id++; let n = 0; st.length = 0; st.push(i); tid[i] = id;
      while (st.length) { const c = st.pop()!; n++; const y = (c / FN) | 0, x = c - y * FN; for (const [dx, dy] of [[1,0],[-1,0],[0,1],[0,-1]]) { const X = x + dx, Y = y + dy; if (X < 0 || Y < 0 || X >= FN || Y >= FN) continue; const k = Y * FN + X; if (truth[k] && !tid[k]) { tid[k] = id; st.push(k); } } }
      tarea.push(n); } }
  { const A = get(`${label} t5`); A.truth += tA; A.area += tA; A.inter += tA; A.uni += tA; components(truth, A, tid, tarea); A.truthLakes += tarea.length - 1; }
  for (const t of tiers) for (const [name, mode, thr] of methods) {
    const k = TOP - t, m = mask(coarse(buf, k, mode), k, thr), A = get(`${label} t${t} ${name}`);
    let a = 0, inter = 0, uni = 0; for (let i = 0; i < N; i++) { const v = m[i], u = truth[i]; a += v; if (v && u) inter++; if (v || u) uni++; }
    A.area += a; A.truth += tA; A.inter += inter; A.uni += uni; A.truthLakes += tarea.length - 1; components(m, A, tid, tarea);
    const hit = new Uint8Array(tarea.length); for (let i = 0; i < N; i++) if (m[i] && tid[i] > 0) hit[tid[i]] = 1; for (let j = 1; j < hit.length; j++) if (!hit[j]) A.lost++;
  }
}
for (const f of faces) {
  readSync(wf, buf, 0, N * 2, f * N * 2); readSync(hf, hb, 0, N * 4, f * N * 4); for (let i = 0; i < N; i++) if (hb[i] <= 0) buf[i] = 0;
  const tw = new Uint8Array(N), tl = new Uint8Array(N); for (let i = 0; i < N; i++) { if (Math.round(buf[i] / 50) >= 1) tw[i] = 1; if (buf[i] > 0) tl[i] = 1; }
  runSet("depth>=0.25m", tw, [["max", "max", 0.5], ["mean", "mean", 0.5]], tiers);
  CUR_FACE = f;
  runSet("lake share (binary, simulated)", tl, [["share>=0.5", "lake", 127.5]], tiers);
  if (TILES) runSet("lake share (flooded surface, tiles)", tl, [["share>=0.5", "tiles", 127.5]], tiers);
  console.error("face", f, "done");
}
console.log("series\tlakes\tmedian ratio\tp90 ratio\ttruth lakes unseen\tarea/truth\tIoU\tmean A/bbox\tboxy>0.85\tlakes in a shape seen >=2x\ttop shapes (count)");
for (const [k, A] of [...agg.entries()].sort()) {
  let rep = 0; for (const [, n] of A.shapes) if (n >= 2) rep += n;
  const top = [...A.shapes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([s, n]) => `${s.split(":")[0]}/${s.split(":")[1]}c x${n}`).join(", ");
  const rs = A.ratios.sort((a, b) => a - b), q = (p: number) => (rs.length ? rs[Math.min(rs.length - 1, Math.floor(p * rs.length))] : 0).toFixed(2);
  console.log(`${k}\t${A.lakes}\t${q(0.5)}\t${q(0.9)}\t${A.lost}/${A.truthLakes}\t${(A.area / A.truth).toFixed(3)}\t${(A.inter / A.uni).toFixed(3)}\t${(A.fillSum / Math.max(1, A.fillN)).toFixed(3)}\t${(A.boxy / Math.max(1, A.fillN)).toFixed(3)}\t${A.repN ? (rep / A.repN).toFixed(3) : "-"}\t${top}`);
}
