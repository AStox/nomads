// The window lattice's seam: two neighbouring lattice cells' windows made, their shared edge measured (the height difference along it
// and over the strip that overlaps, the rivers that cross it and whether they line up with each other and with the planet's own
// crossings) and drawn to a PNG. Windows are kept in a directory (--windows) by (seed, sources key, cell), so a pair made once is read
// back. Each command makes at most two windows (about 40 s each):
//   bun scripts/globe-lattice.ts --seed 1 --pair "42.37,-72.25,0"   # the cell at that place and its neighbour east (0 east, 1 north, 2 west, 3 south)
//   bun scripts/globe-lattice.ts --seed 1 --cross                   # the land pair across a face edge with the highest low ground, picked from the planet
//   bun scripts/globe-lattice.ts --seed 1 --times "42.37,-72.25"    # the seconds in each part of making the window of one place
// Output under --out (default /tmp/globe-lattice): <name>/seam.png and <name>/summary.json.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { releaseGpu, theGpu } from "../src/gpu/device";
import { N, CELL } from "../src/terrain/grid";
import { SEASON_S } from "../src/gpu/globe/atmosphere";
import { cellVectors } from "../src/gpu/globe/tectonics";
import { RADIUS_M, locateVec, tierGrid, type V3 } from "../src/gpu/globe/grid";
import { CELLS, LATTICE_N, cellAt, cellAtPlace, cellCorners, cellFrame, cellOfId, cellStep, idOf, pixelOf, sample, type Cell } from "../src/gpu/globe/lattice";
import { WINDOW_M, onPlane, onSphere, readPlanet, upstreamOf, type Frame, type Planet, type Window } from "../src/gpu/globe/window";
import { Windows, blended, packWindow, windowAtCell, type WindowStore } from "../src/gpu/globe/windows";
import { diskStore, sourceKey } from "./globe-window";
import { heightColor, png, type RGB } from "./globe-maps";
const arg = (name: string, d: string) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : d; };

// The sources that make a window: the planet's (its key) and the window's own, the island's stages it runs and the lattice's frames.
const WINDOW_SOURCES = ["src/gpu/globe/window.ts", "src/gpu/globe/lattice.ts", "src/gpu/globe/windows.ts", "src/sim/sky.ts"];
export function windowSourceKey(root = join(import.meta.dir, "..")): string {
  const h = createHash("sha256");
  h.update(sourceKey(root));
  const dirs = ["src/gpu/terrain", "src/gpu/wgsl", "src/terrain"];
  const files = dirs.flatMap((d) => readdirSync(join(root, d)).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && (d !== "src/gpu/wgsl" || f.startsWith("terrain-"))).map((f) => `${d}/${f}`));
  for (const f of [...WINDOW_SOURCES, ...files].sort()) h.update(readFileSync(join(root, f)));
  return h.digest("hex").slice(0, 12);
}
export function diskWindowStore(dir: string): WindowStore {
  mkdirSync(dir, { recursive: true });
  return {
    get: async (k) => { const f = join(dir, `${k}.bin`); return existsSync(f) ? new Uint8Array(readFileSync(f)) : null; },
    put: async (k, b) => { writeFileSync(join(dir, `${k}.bin`), b); },
  };
}

// ---------- the pair ----------
const SIDE_CORNERS = [[1, 2], [2, 3], [3, 0], [0, 1]]; // corners (SW, SE, NE, NW = 0..3) of a cell's east, north, west and south edge
const DIR_NAME = ["east", "north", "west", "south"];
interface Seam {
  a: Cell; b: Cell; d: number;
  fa: Frame; fb: Frame;
  ends: [[number, number], [number, number]]; // the shared edge's ends in A's plane, m
  length: number; mid: [number, number]; u: [number, number]; v: [number, number]; // along the edge, and across it from A toward B
}
function seamOf(a: Cell, d: number): Seam {
  const b = cellStep(a, d), fa = cellFrame(a), fb = cellFrame(b), corners = cellCorners(a), [i, j] = SIDE_CORNERS[d];
  const p = onPlane(fa, corners[i]), q = onPlane(fa, corners[j]), length = Math.hypot(q[0] - p[0], q[1] - p[1]);
  const u: [number, number] = [(q[0] - p[0]) / length, (q[1] - p[1]) / length], mid: [number, number] = [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
  let v: [number, number] = [-u[1], u[0]];
  if (v[0] * mid[0] + v[1] * mid[1] < 0) v = [-v[0], -v[1]];
  return { a, b, d, fa, fb, ends: [p, q], length, mid, u, v };
}
// A point at s m along the edge and t m across it, as a unit vector and in each window's plane.
const spot = (s: Seam, along: number, across: number) => {
  const x = s.ends[0][0] + s.u[0] * along + s.v[0] * across, y = s.ends[0][1] + s.u[1] * along + s.v[1] * across;
  return onSphere(s.fa, x, y);
};
const hOf = (w: Window, f: Frame, p: V3, field: ArrayLike<number> = w.isle.height) => { const [x, y] = onPlane(f, p), [px, py] = pixelOf(x, y); return sample(field, px, py); };
const inside = (f: Frame, p: V3) => { const [x, y] = onPlane(f, p); return Math.abs(x) < WINDOW_M / 2 && Math.abs(y) < WINDOW_M / 2; };

// ---------- the residual ----------
const q = (a: number[], p: number) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : NaN; };
const stats = (d: number[]) => ({
  n: d.length, bias: d.reduce((a, b) => a + b, 0) / d.length, meanAbs: d.reduce((a, b) => a + Math.abs(b), 0) / d.length,
  rms: Math.sqrt(d.reduce((a, b) => a + b * b, 0) / d.length), p95Abs: q(d.map(Math.abs), 0.95), maxAbs: d.reduce((a, b) => Math.max(a, Math.abs(b)), 0),
});
const RIVER = 0.5; // m3/s a cell must carry to count as a river [design: the window script's: the channel mask is the bed, which on steep ground is nearly every cell]
// The flow at a point: the greatest in its pixel's 3 by 3 (a river is a line of cells and a point is between them).
function flowNear(w: Window, f: Frame, p: V3): number {
  const [x, y] = onPlane(f, p), [px, py] = pixelOf(x, y), cx = Math.floor(px), cy = Math.floor(py);
  let m = 0;
  for (let j = cy - 1; j <= cy + 1; j++) for (let i = cx - 1; i <= cx + 1; i++) if (i >= 0 && j >= 0 && i < N && j < N) m = Math.max(m, w.isle.flow[j * N + i]);
  return m;
}
// The crossings of a river over the edge: runs of edge samples carrying at least `min` m3/s (gaps of up to 3 samples closed), each as
// its flow-weighted position along the edge and its greatest flow.
function crossings(flows: number[], step: number, min: number) {
  const out: { s: number; q: number }[] = [];
  let run: number[] = [], gap = 0;
  const close = () => { if (run.length) { const t = run.reduce((a, i) => a + flows[i], 0); out.push({ s: run.reduce((a, i) => a + i * step * flows[i], 0) / t, q: Math.max(...run.map((i) => flows[i])) }); } run = []; };
  flows.forEach((f, i) => { if (f >= min) { run.push(i); gap = 0; } else if (run.length && ++gap > 3) close(); });
  close();
  return out;
}
const nearest = (s: number, list: { s: number }[]) => list.reduce((m, o) => Math.min(m, Math.abs(o.s - s)), Infinity);
const flowAt = (w: Window, f: Frame, p: V3) => { const [x, y] = onPlane(f, p), [px, py] = pixelOf(x, y); return w.isle.flow[Math.min(N - 1, Math.max(0, Math.floor(py))) * N + Math.min(N - 1, Math.max(0, Math.floor(px)))]; };

function measure(s: Seam, wa: Window, wb: Window, planet: Planet) {
  const step = CELL, count = Math.floor(s.length / step), pts: V3[] = [];
  for (let k = 0; k < count; k++) pts.push(spot(s, (k + 0.5) * step, 0));
  for (const p of pts) if (!inside(s.fa, p) || !inside(s.fb, p)) throw new Error("a point of the shared edge lies outside a window");
  const hA = pts.map((p) => hOf(wa, s.fa, p)), hB = pts.map((p) => hOf(wb, s.fb, p));
  const sA = pts.map((p) => hOf(wa, s.fa, p, wa.coarse.surface)), sB = pts.map((p) => hOf(wb, s.fb, p, wb.coarse.surface));
  const dh = hA.map((v, i) => v - hB[i]), ds = sA.map((v, i) => v - sB[i]), dd = hA.map((v, i) => v - sA[i] - (hB[i] - sB[i]));
  const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length, sd = (a: number[]) => { const m = mean(a); return Math.sqrt(mean(a.map((v) => (v - m) ** 2))); };
  const onLand = pts.map((_, i) => hA[i] > 0 && hB[i] > 0);
  const land = (a: number[]) => a.filter((_, i) => onLand[i]);
  // the strip that both windows hold, by distance from the shared edge (negative on A's side), land only
  const bands: Record<string, ReturnType<typeof stats>> = {};
  for (let across = -4000; across < 4000; across += 1000) {
    const d: number[] = [];
    for (let k = 0; k < count; k += 2) for (let t = across; t < across + 1000; t += 150) {
      const p = spot(s, (k + 0.5) * step, t + 75);
      if (!inside(s.fa, p) || !inside(s.fb, p)) continue;
      const a = hOf(wa, s.fa, p), b = hOf(wb, s.fb, p);
      if (a > 0 && b > 0) d.push(a - b);
    }
    if (d.length) bands[`${across / 1000} to ${(across + 1000) / 1000} km`] = stats(d);
  }
  // rivers over the edge: both windows' crossings, and the planet's own where its river segments cross the same line
  const fA = pts.map((p) => flowNear(wa, s.fa, p)), fB = pts.map((p) => flowNear(wb, s.fb, p));
  const rivers: Record<string, unknown> = {};
  for (const min of [RIVER, 5]) {
    const ca = crossings(fA, step, min), cb = crossings(fB, step, min);
    const offA = ca.map((c) => nearest(c.s, cb)), offB = cb.map((c) => nearest(c.s, ca));
    rivers[`over ${min} m3/s`] = {
      crossingsA: ca.length, crossingsB: cb.length,
      aWithinTwoCells: offA.filter((o) => o <= 2 * CELL).length, aWithin500m: offA.filter((o) => o <= 500).length,
      bWithinTwoCells: offB.filter((o) => o <= 2 * CELL).length, bWithin500m: offB.filter((o) => o <= 500).length,
      medianOffsetM: q([...offA, ...offB].filter(Number.isFinite), 0.5), crossingsM3s: { a: ca.map((c) => +c.q.toFixed(1)), b: cb.map((c) => +c.q.toFixed(1)) },
    };
  }
  // river cells in the overlap that have no river cell of the other window within two cells of the same ground
  const overlap = { aOnly: 0, aBoth: 0, bOnly: 0, bBoth: 0 };
  for (let k = 0; k < count; k += 1) for (let t = -4000; t < 4000; t += CELL) {
    const p = spot(s, (k + 0.5) * step, t);
    if (!inside(s.fa, p) || !inside(s.fb, p)) continue;
    const ra = flowAt(wa, s.fa, p) >= RIVER, rb = flowAt(wb, s.fb, p) >= RIVER, nearA = flowNear(wa, s.fa, p) >= RIVER, nearB = flowNear(wb, s.fb, p) >= RIVER;
    // a river cell of A (its own pixel) and whether B has one within its 3 by 3 at the same ground, and the other way round
    if (ra) { if (nearB) overlap.aBoth++; else overlap.aOnly++; }
    if (rb) { if (nearA) overlap.bBoth++; else overlap.bOnly++; }
  }
  // where the planet's own river segments cross the edge (tier 0 cells' receivers: the straight line between their centres), against
  // the windows' crossings of the largest rivers
  const basins = upstreamOf(planet), g = tierGrid(0), vec = cellVectors(g), coarse: { s: number; q: number }[] = [];
  const mid = spot(s, s.length / 2, 0);
  for (let i = 0; i < planet.n; i++) {
    const j = planet.to[i];
    if (j === i || planet.height[i] <= 0) continue;
    const ci: V3 = [vec[3 * i], vec[3 * i + 1], vec[3 * i + 2]];
    if (ci[0] * mid[0] + ci[1] * mid[1] + ci[2] * mid[2] < Math.cos(40000 / RADIUS_M)) continue;
    const cj: V3 = [vec[3 * j], vec[3 * j + 1], vec[3 * j + 2]], [x1, y1] = onPlane(s.fa, ci), [x2, y2] = onPlane(s.fa, cj);
    // the segment against the edge line p + u t: solve p + u t = a + (b - a) r
    const dx = x2 - x1, dy = y2 - y1, det = -s.u[0] * dy + s.u[1] * dx;
    if (Math.abs(det) < 1e-9) continue;
    const ex = x1 - s.ends[0][0], ey = y1 - s.ends[0][1], t = (-ex * dy + ey * dx) / det, r = (s.u[0] * ey - s.u[1] * ex) / det;
    if (r < 0 || r > 1 || t < 0 || t > s.length) continue;
    const m3s = [0, 1, 2, 3].reduce((a, k) => a + basins.runoff[k][i], 0) / (4 * SEASON_S);
    coarse.push({ s: t, q: m3s });
  }
  const big = coarse.filter((c) => c.q >= 1), ca = crossings(fA, step, RIVER), cb = crossings(fB, step, RIVER);
  const planetCrossings = {
    count: coarse.length, over1m3s: big.length,
    list: big.map((c) => ({ sM: Math.round(c.s), m3s: +c.q.toFixed(1), nearestAM: Math.round(nearest(c.s, ca)), nearestBM: Math.round(nearest(c.s, cb)) })),
  };
  return {
    seam: { a: s.a, b: s.b, direction: DIR_NAME[s.d], lengthM: Math.round(s.length), samples: count, landSamples: onLand.filter(Boolean).length, turnADeg: +(s.fa.turn * 180 / Math.PI).toFixed(1), turnBDeg: +(s.fb.turn * 180 / Math.PI).toFixed(1), turnBetweenDeg: +(((s.fb.turn - s.fa.turn) * 180 / Math.PI + 540) % 360 - 180).toFixed(1) },
    heightAlongEdge: { all: stats(dh), land: onLand.some(Boolean) ? stats(land(dh)) : null, ownSdA: sd(land(hA)), ownSdB: sd(land(hB)), correlation: onLand.some(Boolean) ? correlation(land(hA), land(hB)) : null },
    surfaceAlongEdge: { all: stats(ds), note: "the remapped planet height of A less B's at the same ground, before erosion" },
    detailAlongEdge: { all: stats(dd), note: "(window height less its remapped surface) of A less B's" },
    byDistanceFromEdge: bands,
    rivers, riverCellsInOverlap: overlap, planetCrossings,
  };
}
function correlation(a: number[], b: number[]) {
  const m = (x: number[]) => x.reduce((s, v) => s + v, 0) / x.length, ma = m(a), mb = m(b);
  let sab = 0, saa = 0, sbb = 0;
  a.forEach((v, i) => { sab += (v - ma) * (b[i] - mb); saa += (v - ma) ** 2; sbb += (b[i] - mb) ** 2; });
  return sab / Math.sqrt(saa * sbb);
}

// ---------- the picture ----------
const PX = 2, L: V3 = [-1 / Math.sqrt(3), -1 / Math.sqrt(3), 1 / Math.sqrt(3)];
// Four panels in A's plane turned so that the shared edge runs left to right and A is above it: A's window, B's, the blend, and the
// difference (A less B: red where A is higher, blue where B is, full at 400 m), with the edge a red line, rivers of at least RIVER m3/s blue and
// the sea and lakes dark blue.
function picture(s: Seam, wa: Window, wb: Window, planet: Planet, got: (c: Cell) => Window | undefined): Buffer {
  const along = s.length + 2000, across = 9000, W = Math.round(along / CELL), H = Math.round(across / CELL);
  const pointOf = (i: number, j: number) => spot(s, (i + 0.5) * CELL - 1000, (H / 2 - j - 0.5) * CELL * -1);
  type Sampler = (p: V3) => { z: number; river: boolean; water: boolean } | null;
  const of = (w: Window, f: Frame): Sampler => (p) => {
    if (!inside(f, p)) return null;
    const [x, y] = onPlane(f, p), [px, py] = pixelOf(x, y), k = Math.min(N - 1, Math.floor(py)) * N + Math.min(N - 1, Math.floor(px));
    return { z: sample(w.isle.height, px, py), river: w.isle.flow[k] >= RIVER, water: w.isle.water[k] > 0 };
  };
  const sa = of(wa, s.fa), sb = of(wb, s.fb);
  const mixed: Sampler = (p) => {
    const z = blended(p, got, (w) => w.isle.height);
    if (!(z.share > 0)) return null;
    const a = sa(p), b = sb(p);
    return { z: z.value, river: (a?.river ?? false) || (b?.river ?? false), water: (a?.water ?? false) || (b?.water ?? false) };
  };
  const grid = (f: Sampler) => {
    const z = new Float32Array(W * H).fill(NaN), tag = new Uint8Array(W * H);
    for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
      const r = f(pointOf(i, j));
      if (!r) continue;
      z[j * W + i] = r.z; tag[j * W + i] = r.water ? 2 : r.river ? 1 : 0;
    }
    return { z, tag };
  };
  const shade = (g: { z: Float32Array; tag: Uint8Array }, i: number, j: number): RGB => {
    const k = j * W + i, z = g.z[k];
    if (Number.isNaN(z)) return [50, 50, 50];
    if (g.tag[k] === 2) return z < 0 ? heightColor(z) : [70, 120, 200];
    if (g.tag[k] === 1) return [40, 90, 200];
    const at = (x: number, y: number) => { const v = g.z[Math.min(H - 1, Math.max(0, y)) * W + Math.min(W - 1, Math.max(0, x))]; return Number.isNaN(v) ? z : v; };
    const dx = (at(i + 1, j) - at(i - 1, j)) / (2 * CELL), dy = (at(i, j + 1) - at(i, j - 1)) / (2 * CELL), nz = 1 / Math.hypot(dx, dy, 1);
    const sh = Math.max(0.15, -dx * nz * L[0] - dy * nz * L[1] + nz * L[2]), c = heightColor(z);
    return [Math.min(255, c[0] * sh * 1.3), Math.min(255, c[1] * sh * 1.3), Math.min(255, c[2] * sh * 1.3)];
  };
  const A = grid(sa), B = grid(sb), M = grid(mixed);
  const gap = 6, cw = W * PX, ch = H * PX, tw = 2 * cw + gap, th = 2 * ch + gap, rgb = new Uint8Array(tw * th * 3).fill(20);
  const put = (ox: number, oy: number, at: (i: number, j: number) => RGB) => {
    for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
      const c = at(i, j);
      for (let y = 0; y < PX; y++) for (let x = 0; x < PX; x++) { const o = ((oy + j * PX + y) * tw + ox + i * PX + x) * 3; rgb[o] = c[0]; rgb[o + 1] = c[1]; rgb[o + 2] = c[2]; }
    }
  };
  const edgeRow = (j: number) => Math.abs(j + 0.5 - H / 2) <= 0.5;
  const withEdge = (c: RGB, j: number): RGB => (edgeRow(j) ? [230, 40, 40] : c);
  put(0, 0, (i, j) => withEdge(shade(A, i, j), j));
  put(cw + gap, 0, (i, j) => withEdge(shade(B, i, j), j));
  put(0, ch + gap, (i, j) => withEdge(shade(M, i, j), j));
  put(cw + gap, ch + gap, (i, j) => {
    const a = A.z[j * W + i], b = B.z[j * W + i];
    if (Number.isNaN(a) || Number.isNaN(b)) return withEdge([50, 50, 50], j);
    const d = Math.max(-1, Math.min(1, (a - b) / 400)), c: RGB = d >= 0 ? [255, 255 - d * 190, 255 - d * 190] : [255 + d * 190, 255 + d * 190, 255];
    return withEdge(c, j);
  });
  return png(tw, th, rgb);
}

// ---------- picking ----------
// The land pair across a face edge a river of the planet crosses: for every cell on a face's east or north edge, its neighbour across;
// the pair's score is the planet's mean discharge, m3/s, at the tier-0 cell that holds the middle of their shared edge, taken where
// both cells' centres are land between 100 and 3,000 m (not the highest plateaus, where there are no rivers) and the discharge is
// at least 3 m3/s; `--plateau` instead takes the pair with the highest low ground.
function crossPair(planet: Planet): { a: Cell; d: number } {
  const g = tierGrid(0), basins = upstreamOf(planet), plateau = process.argv.includes("--plateau");
  const tier0 = (p: V3) => { const q = locateVec(g, p); return (q.face * g.fn + q.Y) * g.fn + q.X; };
  const at = (c: Cell) => planet.height[tier0(cellFrame(c).c)];
  let best: { a: Cell; d: number; score: number } | null = null;
  for (let id = 0; id < CELLS; id++) {
    const a = cellOfId(id);
    for (const d of [0, 1]) {
      const edge = d === 0 ? a.X === LATTICE_N - 1 : a.Y === LATTICE_N - 1;
      if (!edge) continue;
      const b = cellStep(a, d), ha = at(a), hb = at(b), mid = cellCorners(a)[SIDE_CORNERS[d][0]], end = cellCorners(a)[SIDE_CORNERS[d][1]];
      const m: V3 = [mid[0] + end[0], mid[1] + end[1], mid[2] + end[2]], h = Math.hypot(...m), i = tier0([m[0] / h, m[1] / h, m[2] / h]);
      const q = [0, 1, 2, 3].reduce((s, k) => s + basins.runoff[k][i], 0) / (4 * SEASON_S);
      const low = Math.min(ha, hb), score = plateau ? low : q;
      if (plateau ? low > 200 : low > 100 && Math.max(ha, hb) < 3000 && q >= 3) if (!best || score > best.score) best = { a, d, score };
    }
  }
  if (!best) throw new Error("no land pair across a face edge");
  console.log(`cross pair: face ${best.a.face} (${best.a.X}, ${best.a.Y}) ${DIR_NAME[best.d]}, ${plateau ? "the lower centre" : "the river"} ${best.score.toFixed(0)} ${plateau ? "m" : "m3/s"}`);
  return best;
}

// The pair inside one face a river of the planet crosses the shared edge of: a tier-0 cell on land under 3,000 m whose receiver lies
// in the neighbouring lattice cell (so its segment crosses their shared edge), with the greatest mean discharge between 5 and 2,000
// m3/s (a window's flow words hold under 4,369: windows at the planet's 147 biggest river cells fail, gap 8 of the note).
const RIVER_PAIR_MAX_M3S = 2000;
function riverPair(planet: Planet): { a: Cell; d: number } {
  const g = tierGrid(0), vec = cellVectors(g), basins = upstreamOf(planet);
  let best: { a: Cell; d: number; q: number } | null = null;
  for (let i = 0; i < planet.n; i++) {
    const j = planet.to[i];
    if (j === i || planet.height[i] <= 0 || planet.height[i] > 3000 || planet.height[j] <= 0) continue;
    const q = [0, 1, 2, 3].reduce((s, k) => s + basins.runoff[k][i], 0) / (4 * SEASON_S);
    if (q < 5 || q > RIVER_PAIR_MAX_M3S || (best && q <= best.q)) continue;
    const a = cellAt([vec[3 * i], vec[3 * i + 1], vec[3 * i + 2]]), b = cellAt([vec[3 * j], vec[3 * j + 1], vec[3 * j + 2]]);
    const d = [0, 1, 2, 3].find((k) => idOf(cellStep(a, k)) === idOf(b) && b.face === a.face);
    if (d !== undefined) best = { a, d, q };
  }
  if (!best) throw new Error("no river crosses a lattice edge inside a face");
  console.log(`river pair: face ${best.a.face} (${best.a.X}, ${best.a.Y}) ${DIR_NAME[best.d]}, ${best.q.toFixed(1)} m3/s`);
  return best;
}

async function main() {
  const seed = Number(arg("seed", "1")), planet = await readPlanet(seed, diskStore(arg("planets", "/tmp/globe-window/planets"), arg("key", "") || sourceKey()));
  const gpu = await theGpu(), out = arg("out", "/tmp/globe-lattice"), sources = windowSourceKey();
  // --times "lat,lon;lat,lon;id": the seconds in each part of making the window at each place (or lattice cell id) given
  const times = arg("times", "");
  if (times) {
    for (const at of times.split(";")) {
      const cell = at.includes(",") ? cellAtPlace(...(at.split(",").map(Number) as [number, number])) : cellOfId(Number(at)), t0 = performance.now(), w = await windowAtCell(gpu, planet, cell);
      console.log(JSON.stringify({ cell: idOf(cell), face: cell.face, wallSeconds: +((performance.now() - t0) / 1000).toFixed(1), ...w.seconds, bytes: packWindow(w).length }));
    }
    return;
  }
  let a: Cell, d: number, name: string;
  if (process.argv.includes("--river")) { const p = riverPair(planet); a = p.a; d = p.d; name = `river-f${a.face}-${a.X}-${a.Y}-${DIR_NAME[d]}`; }
  else if (process.argv.includes("--cross")) { const p = crossPair(planet); a = p.a; d = p.d; name = `cross-f${a.face}-${a.X}-${a.Y}-${DIR_NAME[d]}`; }
  else {
    const [lat, lon, dir] = arg("pair", "42.37,-72.25,0").split(",").map(Number);
    a = cellAtPlace(lat, lon); d = dir; name = `pair-f${a.face}-${a.X}-${a.Y}-${DIR_NAME[d]}`;
  }
  const s = seamOf(a, d), wins = new Windows(gpu, planet, diskWindowStore(arg("windows", join(out, "windows"))), sources, 4);
  const t0 = performance.now(), [wa, wb] = [await wins.fetch(s.a), await wins.fetch(s.b)];
  console.log(`windows ${idOf(s.a)} and ${idOf(s.b)}: ${wins.log.map((l) => `${l.fromStore ? "kept" : "made in " + l.seconds.toFixed(1) + " s"}`).join(", ")} (${((performance.now() - t0) / 1000).toFixed(1)} s)`);
  const dir = join(out, name);
  mkdirSync(dir, { recursive: true });
  const m = measure(s, wa, wb, planet);
  writeFileSync(join(dir, "summary.json"), JSON.stringify({ ...m, seconds: { a: wa.seconds, b: wb.seconds } }, null, 1));
  writeFileSync(join(dir, "seam.png"), picture(s, wa, wb, planet, (c) => (idOf(c) === idOf(s.a) ? wa : idOf(c) === idOf(s.b) ? wb : undefined)));
  console.log(dir, JSON.stringify(m.heightAlongEdge.land ?? m.heightAlongEdge.all));
}

if (import.meta.main) {
  try { await main(); } finally { await releaseGpu(); }
  process.exit(0);
}
