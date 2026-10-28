// Region gates: a square block of a tier (tier 5, 75 m cells, or tier 4, 150 m) read from `state.i32` (heights in 1/256 m, row-major, `size` cells a side, at face / x0 / y0 of the tier's
// grid; the land-region harness writes it). Land = height above 0. `margin` = 64 / 2^(5 - tier) cells, the held ring's reach: cell statistics count only the interior from there in.
//
//  slope        the land cells' slope (tan; the central-difference gradient over two cells, dz/(2 cell), at the cell's own resolution, as the old harness's `dissection`): p50 (the "slope50" of the
//               checkpoint notes), p90, p99, and `steepShare`, the share of land cells steeper than 0.5 (50 percent).
//  landP99      99th percentile of the land cells' heights, m.
//  holdError    each tier-0 parent's mean of its (2^tier)^2 children, against the planet's tier-0 height (the hold's error): `box` over every parent with a land child; `3x3` the same for
//               the mean of a parent's 3 by 3 block of parents and of the planet's 9 tier-0 cells, over parents with land at the centre one cell in from the region's edge; p50 / p90 / p99 / max, m.
//  lock, ridge  see spectrum.ts: lock windows against the uniform expectation, and the radial-spectrum ridge spacing against the model's own Perron range 1.5 to 3 km.
//  rivers       see rivers.ts: straight30 and straight300, lattice-straight 300-cell stretches, the largest river's stem sinuosity; `rivers` at the channel-head area 3.3e4 m^2, `rivers30` at 30 cells
//               of 75 m (1.7e5 m^2, the old harness's lattice30).
//  relief10     the 10 km relief (maximum minus minimum height inside a disc of radius 5 km, centred on a land cell) shares above 1000 / 1500 / 2000 m over the land cells whose disc lies
//               inside the region (and inside the margin); Montgomery and Brandon 2002 (Earth Planet. Sci. Lett. 201, 481-489): under 5 % above 1000 m, under 2 % above 1500 m on Earth.
//  slopeByRelief  mean slope per 10 km relief class against Montgomery and Brandon's S = 4 + 0.014 Rz degrees (Rz the class's mean relief in m). Our slope is a Horn (1981) 3 x 3 slope whose
//               neighbours lie 90 m from the cell (bilinear), the 90 m DEM their relation was measured on (never closer than our own cell at tier 4); `ratio` = ours over cited.
import { lockWindows, ridgeSpacing, type RidgeSpacing } from "./spectrum";
import { flow, riverMeasures, type RiverMeasures } from "./rivers";

export interface RegionIn { h: Int32Array; size: number; tier: number; face: number; x0: number; y0: number; planet0?: ArrayLike<number> }

const pct = (a: number[], q: number) => a[Math.min(a.length - 1, Math.floor(a.length * q))];
const sorted = (a: number[]) => a.sort((x, y) => x - y);
const stats = (a: number[]): ErrStats => { sorted(a); return { n: a.length, p50: +pct(a, 0.5).toFixed(2), p90: +pct(a, 0.9).toFixed(2), p99: +pct(a, 0.99).toFixed(2), max: +a[a.length - 1].toFixed(2) }; };

// maximum minus minimum height within the disc of radius r cells, for the cells at least R = floor(r) from the edges (others 0). Row maxima of growing width are built from the one before.
export function discRelief(h: Int32Array, side: number, r: number): Int32Array {
  const R = Math.floor(r), n = side * side, rmax = Int32Array.from(h), rmin = Int32Array.from(h), omax = new Int32Array(n).fill(-2147483648), omin = new Int32Array(n).fill(2147483647);
  const dys: number[][] = Array.from({ length: R + 1 }, () => []);
  for (let dy = -R; dy <= R; dy++) dys[Math.floor(Math.sqrt(r * r - dy * dy))].push(dy);
  for (let w = 0; w <= R; w++) {
    if (w > 0) for (let y = 0; y < side; y++) {
      const row = y * side;
      for (let x = w; x < side - w; x++) {
        const a = h[row + x - w], b = h[row + x + w];
        if (a > rmax[row + x]) rmax[row + x] = a; if (b > rmax[row + x]) rmax[row + x] = b;
        if (a < rmin[row + x]) rmin[row + x] = a; if (b < rmin[row + x]) rmin[row + x] = b;
      }
    }
    for (const dy of dys[w]) for (let y = R; y < side - R; y++) {
      const row = y * side, src = (y + dy) * side;
      for (let x = R; x < side - R; x++) {
        if (rmax[src + x] > omax[row + x]) omax[row + x] = rmax[src + x];
        if (rmin[src + x] < omin[row + x]) omin[row + x] = rmin[src + x];
      }
    }
  }
  const out = new Int32Array(n);
  for (let y = R; y < side - R; y++) for (let x = R; x < side - R; x++) out[y * side + x] = omax[y * side + x] - omin[y * side + x];
  return out;
}

// Horn slope (degrees) at (x, y) with neighbours `b` cells away (bilinear), heights in 1/256 m.
export function hornSlope(h: ArrayLike<number>, side: number, x: number, y: number, b: number, cellM: number): number {
  const at = (px: number, py: number) => {
    const ix = Math.floor(px), iy = Math.floor(py), fx = px - ix, fy = py - iy, k = iy * side + ix;
    const x1 = fx > 0 ? 1 : 0, y1 = fy > 0 ? side : 0;
    return (h[k] * (1 - fx) + h[k + x1] * fx) * (1 - fy) + (h[k + y1] * (1 - fx) + h[k + y1 + x1] * fx) * fy;
  };
  const z1 = at(x - b, y - b), z2 = at(x, y - b), z3 = at(x + b, y - b), z4 = at(x - b, y), z6 = at(x + b, y), z7 = at(x - b, y + b), z8 = at(x, y + b), z9 = at(x + b, y + b);
  const gx = (z3 + 2 * z6 + z9 - z1 - 2 * z4 - z7) / (8 * b * cellM * 256), gy = (z7 + 2 * z8 + z9 - z1 - 2 * z2 - z3) / (8 * b * cellM * 256);
  return (Math.atan(Math.hypot(gx, gy)) * 180) / Math.PI;
}

export const RELIEF_CLASSES = [0, 250, 500, 750, 1000, 1500, 2000, 3000, Infinity];

export interface SlopeClass { class: string; n: number; meanRzM: number; slopeDeg: number; citedDeg: number; ratio: number }
export interface ErrStats { n: number; p50: number; p90: number; p99: number; max: number }
export interface HoldError { box: ErrStats; box3x3: ErrStats }
export interface RegionResult {
  tier: number; size: number; cellM: number; landCells: number; landP99: number;
  slope: { p50: number; p90: number; p99: number; steepShare: number };
  holdError: HoldError | null;
  lock: { allLand: number; ridged: number; locked: number; uniformAll: number; uniformRidged: number };
  ridge: Omit<RidgeSpacing, "bins"> | null;
  rivers: RiverMeasures; rivers30: RiverMeasures;
  relief10: { windows: number; above1000: number; above1500: number; above2000: number };
  slopeByRelief: SlopeClass[];
}

export function regionMeasures(r: RegionIn, log: (s: string) => void = () => {}): RegionResult {
  const { h, size, tier } = r, down = 2 ** (5 - tier), cellM = 75 * down, per = 1 << tier, margin = Math.floor(64 / down);
  // land height and slope over the interior (slope = the central-difference gradient over two cells, rise over run)
  const land: number[] = [], slopes: number[] = [];
  let steep = 0, nl = 0;
  for (let y = margin; y < size - margin; y++) for (let x = margin; x < size - margin; x++) {
    const k = y * size + x;
    if (h[k] <= 0) continue;
    const s = Math.hypot(h[k + 1] - h[k - 1], h[k + size] - h[k - size]) / 256 / (2 * cellM);
    land.push(h[k] / 256); slopes.push(s); nl++;
    if (s > 0.5) steep++;
  }
  const landP99 = +pct(sorted(land), 0.99).toFixed(1), hold = r.planet0 ? holdError(r, per) : null;
  sorted(slopes);
  const slope = { p50: +pct(slopes, 0.5).toFixed(3), p90: +pct(slopes, 0.9).toFixed(3), p99: +pct(slopes, 0.99).toFixed(3), steepShare: +(steep / Math.max(1, nl)).toFixed(4) };
  // spectrum: lock windows and ridge spacing
  const lw = lockWindows(h, size, cellM);
  const lock = { allLand: lw.allLand, ridged: lw.ridged, locked: lw.locked, uniformAll: lw.uniformAll, uniformRidged: lw.uniformRidged };
  const ridge = lw.allLand ? (({ bins, ...s }) => s)(ridgeSpacing(lw.profile, 256, 4, cellM)) : null;
  log("spectrum");
  // rivers over the interior
  const live = new Uint8Array(size * size);
  for (let y = margin; y < size - margin; y++) for (let x = margin; x < size - margin; x++) live[y * size + x] = h[y * size + x] > 0 ? 1 : 0;
  const fl = flow(h, size), rivers = riverMeasures(h, size, live, cellM, fl), rivers30 = riverMeasures(h, size, live, cellM, fl, 30 * 75 * 75);
  log("rivers");
  // relief and slope per relief class
  const rc = 5000 / cellM, R = Math.floor(rc), rel = discRelief(h, size, rc), b = Math.max(1, 90 / cellM), inner = Math.max(margin, R + 2), cls = RELIEF_CLASSES.slice(0, -1).map(() => ({ n: 0, rz: 0, slope: 0 }));
  let tot = 0, a1 = 0, a15 = 0, a2 = 0;
  for (let y = inner; y < size - inner; y++) for (let x = inner; x < size - inner; x++) {
    const k = y * size + x;
    if (h[k] <= 0) continue;
    const rz = rel[k] / 256;
    tot++; if (rz > 1000) a1++; if (rz > 1500) a15++; if (rz > 2000) a2++;
    let c = 0; while (rz >= RELIEF_CLASSES[c + 1]) c++;
    cls[c].n++; cls[c].rz += rz; cls[c].slope += hornSlope(h, size, x, y, b, cellM);
  }
  const relief = { windows: tot, above1000: +(a1 / Math.max(1, tot)).toFixed(4), above1500: +(a15 / Math.max(1, tot)).toFixed(4), above2000: +(a2 / Math.max(1, tot)).toFixed(4) };
  const slopeByRelief = cls.map((c, i): SlopeClass => {
    const rz = c.n ? c.rz / c.n : NaN, s = c.n ? c.slope / c.n : NaN, cited = 4 + 0.014 * rz;
    return { class: `${RELIEF_CLASSES[i]}..${RELIEF_CLASSES[i + 1]}`, n: c.n, meanRzM: +rz.toFixed(0), slopeDeg: +s.toFixed(2), citedDeg: +cited.toFixed(2), ratio: +(s / cited).toFixed(3) };
  });
  return { tier, size, cellM, landCells: nl, landP99, slope, holdError: hold, lock, ridge, rivers, rivers30, relief10: relief, slopeByRelief };
}

export function holdError(r: RegionIn, per: number): HoldError {
  const { h, size, face, x0, y0 } = r, n = size / per, p0 = r.planet0!, px0 = x0 / per, py0 = y0 / per, mean = new Float64Array(n * n), landc = new Uint8Array(n * n);
  for (let py = 0; py < n; py++) for (let px = 0; px < n; px++) {
    let s = 0, l = 0;
    for (let y = 0; y < per; y++) for (let x = 0; x < per; x++) { const v = h[(py * per + y) * size + px * per + x]; s += v; if (v > 0) l++; }
    mean[py * n + px] = s / (per * per) / 256; landc[py * n + px] = l ? 1 : 0;
  }
  const plan = (px: number, py: number) => p0[(face * 256 + py0 + py) * 256 + px0 + px];
  const box: number[] = [], b3: number[] = [];
  for (let py = 0; py < n; py++) for (let px = 0; px < n; px++) {
    if (!landc[py * n + px]) continue;
    box.push(Math.abs(mean[py * n + px] - plan(px, py)));
    if (px < 1 || py < 1 || px >= n - 1 || py >= n - 1) continue;
    let a = 0, c = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { a += mean[(py + dy) * n + px + dx]; c += plan(px + dx, py + dy); }
    b3.push(Math.abs(a / 9 - c / 9));
  }
  return { box: stats(box), box3x3: stats(b3) };
}
