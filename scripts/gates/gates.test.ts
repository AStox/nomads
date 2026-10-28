// The gate tools against inputs with a known answer (CPU only): a sine washboard for the spectrum and the lock, a straight and a sine-meandering river for the rivers, a hemisphere for the
// planet measures, and the overlap bands.
import { describe, expect, test } from "bun:test";
import { fft1, fft2 } from "./fft";
import { dominantPeak, lockWindows, ridgeSpacing, windowPower } from "./spectrum";
import { discRelief, regionMeasures } from "./region";
import { flow, riverMeasures, sinuosity, straightRuns } from "./rivers";
import { areaTable, coastLoops, coastRuns, components, landStats, relief10, type Field } from "./planet";
import { makeGrid, fromLatLon, locateVec, centre } from "../../src/gpu/globe/grid";
import { overlap } from "../globe-overlap";

const CELL = 75;
let seedState = 12345;
const rnd = () => { seedState = (Math.imul(seedState, 1664525) + 1013904223) >>> 0; return seedState / 4294967296; };

// ridge field: base + amp sin(2 pi (x cos t + y sin t) / lam cells) in 1/256 m, plus a little noise
function washboard(side: number, lamM: number, thetaDeg: number, amp = 100, noise = 1): Int32Array {
  const h = new Int32Array(side * side), t = (thetaDeg * Math.PI) / 180, lam = lamM / CELL;
  for (let y = 0; y < side; y++) for (let x = 0; x < side; x++) h[y * side + x] = Math.round(256 * (500 + amp * Math.sin((2 * Math.PI * (x * Math.cos(t) + y * Math.sin(t))) / lam) + noise * (rnd() - 0.5)));
  return h;
}

describe("fft", () => {
  test("a cosine lands in its bin and the inverse restores the input", () => {
    const n = 64, re = Float64Array.from({ length: n }, (_, i) => Math.cos((2 * Math.PI * 5 * i) / n)), im = new Float64Array(n), orig = re.slice();
    fft1(re, im);
    expect(Math.abs(re[5] - n / 2)).toBeLessThan(1e-9); expect(Math.abs(re[10])).toBeLessThan(1e-9);
    fft1(re, im, true);
    for (let i = 0; i < n; i++) expect(Math.abs(re[i] / n - orig[i])).toBeLessThan(1e-12);
    const a = new Float64Array(16 * 16), b = new Float64Array(16 * 16);
    for (let i = 0; i < 256; i++) a[i] = rnd();
    const keep = a.slice();
    fft2(a, b, 16); fft2(a, b, 16, true);
    for (let i = 0; i < 256; i++) expect(Math.abs(a[i] / 256 - keep[i])).toBeLessThan(1e-12);
  });
});

describe("spectrum and lock", () => {
  test("the peak of a washboard has its wavelength and direction", () => {
    for (const [theta, lam] of [[0, 3000], [90, 2500], [30, 4000], [45, 5000]] as const) {
      const h = washboard(256, lam, theta), p = dominantPeak(windowPower(h, 256, 0, 0, 256, 4), 1024, CELL);
      expect(Math.abs(p.wavelengthM / lam - 1)).toBeLessThan(0.06);
      expect(Math.abs(p.angleDeg - theta)).toBeLessThan(2.5);
      expect(p.ratio).toBeGreaterThan(50);
    }
  });
  test("lock windows count the axis-aligned washboards and no others", () => {
    const side = 512, cases: [number, boolean][] = [[0, true], [4, true], [86, true], [90, true], [12, false], [30, false], [45, false], [60, false]];
    for (const [theta, locked] of cases) {
      const r = lockWindows(washboard(side, 3000, theta), side, CELL);
      expect(r.allLand).toBe(4); expect(r.ridged).toBe(4);
      expect(r.locked).toBe(locked ? 4 : 0);
      expect(r.uniformAll).toBeCloseTo((4 * 32) / 180, 1);
    }
  });
  test("a window with sea in it is not counted", () => {
    const h = washboard(512, 3000, 0); h[10 * 512 + 10] = -5;
    expect(lockWindows(h, 512, CELL).allLand).toBe(3);
  });
  test("ridge spacing finds the excess of a washboard over a power-law background, and none without it", () => {
    const side = 512, M = side, re = new Float64Array(M * M), im = new Float64Array(M * M);
    for (let ky = 0; ky < M; ky++) for (let kx = 0; kx < M; kx++) {
      const sx = kx < M / 2 ? kx : kx - M, sy = ky < M / 2 ? ky : ky - M, k = Math.hypot(sx, sy);
      if (!k) continue;
      const a = k ** -1.5 * 2e5, ph = 2 * Math.PI * rnd();
      re[ky * M + kx] = a * Math.cos(ph); im[ky * M + kx] = a * Math.sin(ph);
    }
    fft2(re, im, M, true);
    let sd = 0;
    for (let i = 0; i < re.length; i++) sd += re[i] * re[i];
    sd = Math.sqrt(sd / re.length);
    const base = Int32Array.from(re, (v) => Math.round(256 * (800 + (60 * v) / sd))), wb = washboard(side, 2400, 25, 30, 0), mix = Int32Array.from(base, (v, i) => v + wb[i] - 256 * 500);
    expect(base.reduce((a, b) => Math.min(a, b), 1e12)).toBeGreaterThan(0);
    const without = ridgeSpacing(lockWindows(base, side, CELL).profile, 256, 4, CELL), withR = ridgeSpacing(lockWindows(mix, side, CELL).profile, 256, 4, CELL);
    expect(Math.abs(withR.wavelengthKm / 2.4 - 1)).toBeLessThan(0.12);
    expect(withR.insidePerron).toBe(true);
    expect(withR.ratio).toBeGreaterThan(3 * without.ratio);
    expect(without.exponent).toBeLessThan(-1);
  });
});

describe("rivers", () => {
  const SIDE = 512, CHANNEL_M2 = 200 * CELL * CELL; // only the valley floor is a river
  // a valley along a curve: height falls toward x = 0 and rises with the distance to the curve
  function valley(c: (x: number) => number, dc: (x: number) => number): Float64Array {
    const h = new Float64Array(SIDE * SIDE);
    for (let y = 0; y < SIDE; y++) for (let x = 0; x < SIDE; x++) {
      const d = Math.abs(y - c(x)) / Math.sqrt(1 + dc(x) ** 2);
      // the floor is clean; the slopes are rough (1.5 m of hash noise) so their drainage lines wander instead of running in parallel
      h[y * SIDE + x] = 20 + 0.06 * x + 3 * Math.min(20, d) + (d > 4 ? ((Math.sin(x * 12.9898 + y * 78.233) * 43758.5453) % 1) * 1.5 : 0);
    }
    return h;
  }
  // the cells within 16 cells of the valley floor (the plateau beyond drains in parallel lines, which would be straight runs of their own)
  const near = (c: (x: number) => number) => Uint8Array.from({ length: SIDE * SIDE }, (_, k) => (Math.abs(((k / SIDE) | 0) - c(k % SIDE)) < 16 && k % SIDE > 20 && k % SIDE < SIDE - 20 ? 1 : 0));
  test("a straight river at 26.6 degrees is one straight run, lattice-locked rivers are not mistaken for natural ones", () => {
    const line = (x: number) => 40 + 0.5 * x, m = riverMeasures(valley(line, () => 0.5), SIDE, near(line), CELL, undefined, CHANNEL_M2);
    expect(m.stem!.sinuosity).toBeLessThan(1.04); expect(m.stem!.class).toBe("straight");
    expect(m.stem!.lengthCells).toBeGreaterThan(450);
    expect(m.longestRunCells).toBeGreaterThan(450); expect(m.straight300).toBeGreaterThan(0.3); expect(m.straight30).toBeGreaterThanOrEqual(m.straight300);
    expect(m.latticeStraight300).toBe(0);
    // a river nearly along the axis is lattice-straight
    const flat = (x: number) => 200 + 0.05 * x, a = riverMeasures(valley(flat, () => 0.05), SIDE, near(flat), CELL, undefined, CHANNEL_M2);
    expect(a.latticeStraight300).toBeGreaterThanOrEqual(1);
  });
  test("straight rivers at other angles read straight (the D8 staircase is smoothed out)", () => {
    for (const slope of [0, 0.1, 0.25, 1 / 3, 0.5, 0.9]) {
      const c = (x: number) => 20 + slope * x, dc = () => slope;
      const m = riverMeasures(valley(c, dc), SIDE, near(c), CELL, undefined, CHANNEL_M2);
      expect(m.stem!.sinuosity).toBeLessThan(1.05);
    }
  });
  test("a sine meander has its analytic sinuosity and is no longer straight", () => {
    const A = 40, L = 160, c = (x: number) => 256 + A * Math.sin((2 * Math.PI * x) / L), dc = (x: number) => A * ((2 * Math.PI) / L) * Math.cos((2 * Math.PI * x) / L);
    const m = riverMeasures(valley(c, dc), SIDE, near(c), CELL, undefined, CHANNEL_M2), xa = Math.min(m.stem!.head[0], m.stem!.outlet[0]), xb = Math.max(m.stem!.head[0], m.stem!.outlet[0]);
    let arc = 0;
    for (let x = xa; x < xb; x += 0.01) arc += Math.hypot(0.01, c(x + 0.01) - c(x));
    const want = arc / (xb - xa);
    expect(want).toBeGreaterThan(1.25);
    expect(Math.abs(m.stem!.sinuosity / want - 1)).toBeLessThan(0.08);
    expect(m.stem!.class).toBe("meandering");
    expect(m.straight300).toBe(0); expect(m.latticeStraight300).toBe(0);
  });
  test("the flow fills a pit and drains every land cell to the edge or the sea", () => {
    const side = 32, h = new Float64Array(side * side);
    for (let y = 0; y < side; y++) for (let x = 0; x < side; x++) h[y * side + x] = 10 + x + (x === 16 && y === 16 ? -8 : 0);
    const f = flow(h, side);
    for (let k = 0; k < side * side; k++) { let c = k, n = 0; while (f.to[c] !== c && n++ < 5000) c = f.to[c]; expect(f.to[c]).toBe(c); }
    let drained = 0;
    for (let k = 0; k < side * side; k++) if (f.to[k] === k) drained += f.acc[k];
    expect(drained).toBe(side * side);
  });
  test("straight runs and sinuosity of plain polylines", () => {
    const line = Array.from({ length: 100 }, (_, i) => ({ x: i, y: Math.round(i / 2) }));
    expect(straightRuns(line, 1.5)).toEqual([[0, 99]]);
    const zig = Array.from({ length: 100 }, (_, i) => ({ x: i, y: (i % 10 < 5 ? 0 : 6) }));
    expect(straightRuns(zig, 1.5).length).toBeGreaterThan(5);
    expect(sinuosity(line)).toBeLessThan(1.01);
  });
});

describe("region", () => {
  test("the disc relief equals a brute force", () => {
    const side = 40, h = Int32Array.from({ length: side * side }, () => Math.floor(rnd() * 1000)), r = 5.3, rel = discRelief(h, side, r);
    for (const [x, y] of [[5, 5], [20, 20], [34, 7], [30, 30]]) {
      let mx = -1, mn = 1e9;
      for (let dy = -5; dy <= 5; dy++) for (let dx = -5; dx <= 5; dx++) if (dx * dx + dy * dy <= r * r) { const v = h[(y + dy) * side + x + dx]; mx = Math.max(mx, v); mn = Math.min(mn, v); }
      expect(rel[y * side + x]).toBe(mx - mn);
    }
  });
  test("a washboard region measures its lock, spacing, slope and relief", () => {
    const side = 512, h = washboard(side, 3000, 0, 100, 0), m = regionMeasures({ h, size: side, tier: 5, face: 0, x0: 0, y0: 0 });
    expect(m.lock.locked).toBe(4);
    expect(Math.abs(m.ridge.wavelengthKm / 3 - 1)).toBeLessThan(0.12);
    // amplitude 100 m, wavelength 3 km: max slope 2 pi 100 / 3000 = 0.209, 12 degrees at 90 m spacing less a little
    const cls = m.slopeByRelief.filter((c) => c.n > 0);
    expect(cls.length).toBe(1); expect(cls[0].meanRzM).toBeGreaterThan(150); expect(cls[0].slopeDeg).toBeGreaterThan(3); expect(cls[0].slopeDeg).toBeLessThan(8);
    expect(m.slope50).toBe(0); expect(m.relief10.above1000).toBe(0);
  });
  test("the hold's error of a region equal to the planet's means is zero, and one metre off is one metre", () => {
    const per = 32, size = 256, n = size / per, p0 = new Float32Array(6 * 256 * 256), h = new Int32Array(size * size);
    for (let py = 0; py < n; py++) for (let px = 0; px < n; px++) {
      const v = 100 + px * 10 + py * 3; p0[(2 * 256 + 5 + py) * 256 + 7 + px] = v;
      for (let y = 0; y < per; y++) for (let x = 0; x < per; x++) h[(py * per + y) * size + px * per + x] = Math.round(256 * (v + (x % 2 ? 1 : -1) * 20 + (px === 3 && py === 3 ? 1 : 0)));
    }
    const m = regionMeasures({ h, size, tier: 5, face: 2, x0: 7 * per, y0: 5 * per, planet0: p0 });
    expect(m.holdError!.box.max).toBeCloseTo(1, 1); expect(m.holdError!.box.p50).toBeLessThan(0.01);
    expect(m.holdError!.box3x3.max).toBeCloseTo(1 / 9, 2);
  });
});

describe("planet", () => {
  const R = 391000;
  function field(fn: number, f: (p: readonly [number, number, number]) => number): Field {
    const g = makeGrid(fn, R), h = new Float32Array(6 * fn * fn);
    for (let face = 0; face < 6; face++) for (let Y = 0; Y < fn; Y++) for (let X = 0; X < fn; X++) h[(face * fn + Y) * fn + X] = f(centre(g, face, X, Y));
    return { fn, h, radius: R };
  }
  test("a northern hemisphere of 100 m: half the planet, one component, mean 100 m, the equator is one straight run", () => {
    const fn = 64, f = field(fn, (p) => (p[2] > 0 ? 100 : -1000)), g = makeGrid(fn, R), a = areaTable(g), s = landStats(f, (i) => a[i % (fn * fn)]);
    expect(Math.abs(s.landShare - 0.5)).toBeLessThan(0.003); expect(s.landHeight.mean).toBeCloseTo(100, 0); expect(s.landHeight.p50).toBeCloseTo(100, 0);
    const c = components(f, g, a); expect(c.count).toBe(1); expect(c.top5LandShare[0]).toBeCloseTo(1, 5);
    const r = coastRuns(coastLoops(f, g), R);
    expect(r.loops).toBe(1); expect(r.coastKm).toBeGreaterThan(2400); expect(r.coastKm).toBeLessThan(2500);
    expect(r.runs["150km"].coastShare).toBeGreaterThan(0.95);
  });
  test("two polar caps are two components of a quarter each, and a wavy coast is not straight", () => {
    const fn = 64, g = makeGrid(fn, R), a = areaTable(g), f = field(fn, (p) => (Math.abs(p[2]) > 0.5 ? 100 : -100)), c = components(f, g, a);
    expect(c.count).toBe(2); expect(Math.abs(c.top5PlanetShare[0] - 0.25)).toBeLessThan(0.004);
    const wavy = field(fn, (p) => (p[2] > 0.15 * Math.sin(12 * Math.atan2(p[1], p[0])) ? 100 : -100)), straight = coastRuns(coastLoops(field(fn, (p) => (p[2] > 0 ? 100 : -100)), g), R), w = coastRuns(coastLoops(wavy, g), R);
    expect(w.runs["100km"].coastShare).toBeLessThan(0.2); expect(straight.runs["100km"].coastShare).toBeGreaterThan(0.9);
  });
  test("a linear ramp has the relief of its gradient inside the 5 km disc", () => {
    const fn = 256, g = makeGrid(fn, R), a = areaTable(g), G = 1e5, f = field(fn, (p) => G * p[2]), r = relief10(f, g, a, 1);
    // relief = G * 2 * (5 km / R) * cos(lat) = 2556 cos(lat) m on land (z > 0), above 2000 for sin(lat) < asin-based: |lat| < 38.4 degrees: share sin(38.4) = 0.621
    const want = (lim: number) => Math.sin(Math.acos(lim / (G * 2 * (5000 / R))));
    // the 21-cell window spans 8.8 km of the 10 km diameter at 2.4 km cells, so the shares sit a little under the ideal ramp's
    expect(r.inland.above2000).toBeLessThan(want(2000) + 0.01); expect(Math.abs(r.inland.above2000 - want(2000))).toBeLessThan(0.12); expect(Math.abs(r.inland.above1500 - want(1500))).toBeLessThan(0.12); expect(r.inland.above1000).toBeGreaterThan(0.85);
    expect(locateVec(g, fromLatLon(0.1, 0.1)).face).toBeGreaterThanOrEqual(0);
  });
});

describe("overlap", () => {
  test("equal cells are counted by distance to the edge", () => {
    const size = 128, a = Int32Array.from({ length: size * size }, (_, i) => i), b = a.slice();
    b[3 * size + 64] += 256 * 7; b[64 * size + 64] += 256;
    const r = overlap(a, b, size);
    expect(r.total.cells).toBe(size * size); expect(r.total.equal).toBe(size * size - 2); expect(r.total.maxDiffM).toBe(7);
    expect(r.bands[0].equal).toBe(r.bands[0].cells - 1); expect(r.bands[0].maxDiffM).toBe(7);
    expect(r.bands[0].cells).toBe(128 * 128 - 112 * 112); expect(r.bands[3].equal).toBe(r.bands[3].cells - 1); expect(r.bands[3].maxDiffM).toBe(1); expect(r.bands[4].cells).toBe(0);
  });
});
