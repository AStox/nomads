// The stream centreline (streamcurve.ts) on a made-up D8 drainage: two windows that overlap draw the same curve at every step they both hold with room round it (no seam at a window's edge), a
// confluence stays joined (a step ends at the node its receiver's step starts from), no node or stroke leaves its cell by more than half a cell, and the right-angle staircase of a run across the grid is gone.
import { describe, expect, test } from "bun:test";
import { streamCurves } from "./streamcurve";

const CELL = 75, W = 140, H = 70;
// a ground sloping to the east with a deterministic roughness; each cell drains to its steepest neighbour (8 of them, the fall over the distance), the flow gathered from the highest cell down, a
// channel wherever 5 cells or more drain through
function field() {
  let s = 12345;
  const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
  const h = new Float64Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) h[y * W + x] = 0.35 * (W - x) + 0.3 * Math.sin(y * 0.21) * 3 + rnd() * 1.4;
  const to = new Int32Array(W * H).fill(-1);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let best = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const X = x + dx, Y = y + dy;
      if ((!dx && !dy) || X < 0 || Y < 0 || X >= W || Y >= H) continue;
      const g = (h[y * W + x] - h[Y * W + X]) / Math.hypot(dx, dy);
      if (g > best) { best = g; to[y * W + x] = Y * W + X; }
    }
  }
  const order = Array.from({ length: W * H }, (_, i) => i).sort((a, b) => h[b] - h[a]);
  const acc = new Uint32Array(W * H).fill(1);
  for (const i of order) if (to[i] >= 0) acc[to[i]] += acc[i];
  return { to, acc };
}
const { to: TO, acc: ACC } = field();

// a window of columns c0 to c1 - 1 (all rows) as a patch of its own: cell k at (k % w, k / w) in it, a receiver outside it -1
function window(c0: number, c1: number) {
  const w = c1 - c0, n = w * H, to = new Int32Array(n).fill(-1), flow = new Uint32Array(n);
  for (let y = 0; y < H; y++) for (let x = 0; x < w; x++) {
    const g = y * W + c0 + x, r = TO[g];
    flow[y * w + x] = ACC[g];
    if (r >= 0 && r % W >= c0 && r % W < c1) to[y * w + x] = Math.floor(r / W) * w + (r % W) - c0;
  }
  const ok = (i: number) => flow[i] >= 5;
  const curve = streamCurves(n, to, ok, flow, (i) => ((i % w) + c0) * CELL + CELL / 2, (i) => Math.floor(i / w) * CELL + CELL / 2, CELL);
  // the window's own cells' frame is the face's: x from the window's edge as a window's rivers are, so a seam would show as a difference here
  const steps = new Map<number, number[]>();
  for (let i = 0; i < n; i++) if (ok(i) && to[i] >= 0) steps.set(Math.floor(i / w) * W + c0 + (i % w), curve(i));
  return { steps, w };
}

describe("a stream's centreline", () => {
  const A = window(0, 90), B = window(50, 140);

  test("is the same curve in two windows that hold the stream's cells with room round them", () => {
    let both = 0, worst = 0;
    for (const [g, a] of A.steps) {
      const col = g % W, row = Math.floor(g / W);
      // 6 cells in from each window's edge, 5 from the rows' (the patches share the rows' edges, where the stream's end is the same in both)
      if (col < 56 || col > 83) continue;
      const b = B.steps.get(g);
      expect(b, `step at ${col},${row}`).toBeDefined();
      expect(b!.length).toBe(a.length);
      for (let k = 0; k < a.length; k++) worst = Math.max(worst, Math.abs(a[k] - b![k]));
      both++;
    }
    expect(both).toBeGreaterThan(40);
    expect(worst).toBeLessThan(1e-9);
  });

  test("keeps a confluence joined and every point within the step's own cell", () => {
    let joined = 0, tributaries = 0;
    for (const [g, a] of A.steps) {
      const r = TO[g], next = A.steps.get(r);
      if (next) { joined++; expect(Math.hypot(a[a.length - 2] - next[0], a[a.length - 1] - next[1])).toBeLessThan(1e-9); }
      // the points lie within half a cell of the step from its cell's centre to its receiver's
      const cx = (g % W) * CELL + CELL / 2, cz = Math.floor(g / W) * CELL + CELL / 2, rx = (r % W) * CELL + CELL / 2, rz = Math.floor(r / W) * CELL + CELL / 2;
      for (let k = 0; k < a.length; k += 2) {
        const t = Math.max(0, Math.min(1, ((a[k] - cx) * (rx - cx) + (a[k + 1] - cz) * (rz - cz)) / ((rx - cx) ** 2 + (rz - cz) ** 2)));
        const chord = Math.hypot(a[k] - cx - (rx - cx) * t, a[k + 1] - cz - (rz - cz) * t);
        expect(chord).toBeLessThanOrEqual(0.5 * CELL + 1e-9);
      }
      // a node the step of another cell also ends at: a confluence
      for (const [g2, b] of A.steps) if (g2 !== g && TO[g2] === r && Math.hypot(b[b.length - 2] - a[a.length - 2], b[b.length - 1] - a[a.length - 1]) < 1e-9) { tributaries++; break; }
    }
    expect(joined).toBeGreaterThan(100);
    expect(tributaries).toBeGreaterThan(5);
  });

  test("turns by no more than 40 degrees between pieces where the cell chain turns by 90", () => {
    // a stream across the grid at about 27 degrees: two cells east, one south, over and over
    const n = 60 * 20, to = new Int32Array(n).fill(-1), flow = new Uint32Array(n).fill(10);
    const path: number[] = [];
    let x = 0, y = 0;
    for (let k = 0; k < 44; k++) { path.push(y * 60 + x); if (k % 3 === 2) y++; else x++; }
    for (let k = 0; k + 1 < path.length; k++) to[path[k]] = path[k + 1];
    const curve = streamCurves(n, to, (i) => to[i] >= 0, flow, (i) => (i % 60) * CELL + CELL / 2, (i) => Math.floor(i / 60) * CELL + CELL / 2, CELL);
    const pts: number[][] = [];
    for (let k = 0; k + 1 < path.length; k++) { const c = curve(path[k]); for (let j = k ? 2 : 0; j < c.length; j += 2) pts.push([c[j], c[j + 1]]); }
    let worst = 0, raw = 0;
    for (let k = 1; k + 1 < pts.length; k++) {
      const a = [pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]], b = [pts[k + 1][0] - pts[k][0], pts[k + 1][1] - pts[k][1]];
      const ang = Math.abs(Math.atan2(a[0] * b[1] - a[1] * b[0], a[0] * b[0] + a[1] * b[1])) * 180 / Math.PI;
      // the ends of the stream (a node held in place) are left out
      if (k > 6 && k < pts.length - 7) worst = Math.max(worst, ang);
    }
    for (let k = 1; k + 1 < path.length; k++) {
      const a = [path[k] % 60 - path[k - 1] % 60, Math.floor(path[k] / 60) - Math.floor(path[k - 1] / 60)], b = [path[k + 1] % 60 - path[k] % 60, Math.floor(path[k + 1] / 60) - Math.floor(path[k] / 60)];
      raw = Math.max(raw, Math.abs(Math.atan2(a[0] * b[1] - a[1] * b[0], a[0] * b[0] + a[1] * b[1])) * 180 / Math.PI);
    }
    expect(raw).toBeGreaterThanOrEqual(89);
    expect(worst).toBeLessThan(40);
  });
});
