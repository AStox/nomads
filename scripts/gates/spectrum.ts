// Spectral gates on 256-cell windows of a region's heights: the lattice lock and the ridge spacing.
//
// Window power. A window of n by n cells (n = 256) is detrended by its least-squares plane, tapered by a separable Hann window (Harris 1978; no leakage of the plane's and the coast's step
// into the ridge band), zero-padded to pad * n (pad = 4, so the wavevector's angle is sampled four times finer than the window's own harmonics) and transformed; power = |F|^2. A wavevector
// index k (padded units) has wavelength lambda = pad * n * cell / |k|.
//
// Dominant ridge wavevector (lock windows). Over the half plane of wavevectors with wavelength lamLo to lamHi (2 to 9 km), the peak power, the median power of the same annulus, the peak
// wavevector's direction theta in [0, 180) degrees. A window is `ridged` when peak >= 8 * median (a clear single wave, not a flat spectrum) and `locked` when it is ridged and theta lies within
// 8 degrees of a lattice axis (0 or 90). Windows counted are the tile-aligned, non-overlapping, all-land (every cell above sea level) windows of a region. A uniformly random direction falls in
// the two 16-degree arcs with probability 32 / 180 (each axis 16 / 180); `uniformAll` = that times all-land windows, `uniformRidged` = that times ridged windows. The brief's 16 / 180 is the one axis.
//
// Ridge spacing. The power of every all-land window is divided by its own total (DC excluded) so each window weighs the same, averaged radially (bins of one padded index) then in log bins
// (20 per decade of wavelength) from lambda = 4 cells to half the window. A power law log P = a + b log k is fitted by least squares, refitted three times without the bins above twice
// the fit (so the excess itself does not lift the line). The excess is P over the fit; `ridge` = the bin of largest excess with lambda in 1 to 10 km: its wavelength and ratio. The gate
// range is the model's own Perron (Perron, Kirchner and Dietrich 2009, Nature 460, 502-505) valley spacing 6.4 to 12.7 Lc, Lc = (D/K)^(1/2) = 237 m here, so 1.5 to 3.0 km.
import { fft2 } from "./fft";

export const AXIS_TOL_DEG = 8, PEAK_OVER_MEDIAN = 8, UNIFORM_AXIS_SHARE = 32 / 180, PERRON_KM: [number, number] = [1.5, 3.0];

// |F|^2 of the detrended, tapered, zero-padded window at (x0, y0) of the row-major array (row length `side`).
export function windowPower(h: ArrayLike<number>, side: number, x0: number, y0: number, n: number, pad = 4): Float64Array {
  const M = n * pad, re = new Float64Array(M * M), im = new Float64Array(M * M), c = (n - 1) / 2;
  let sv = 0, sx = 0, sy = 0, sxx = n * ((n * n - 1) / 12);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) { const v = h[(y0 + y) * side + x0 + x]; sv += v; sx += (x - c) * v; sy += (y - c) * v; }
  const mean = sv / (n * n), bx = sx / (n * sxx), by = sy / (n * sxx), hann = Float64Array.from({ length: n }, (_, i) => 0.5 * (1 - Math.cos((2 * Math.PI * (i + 0.5)) / n)));
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) re[y * M + x] = (h[(y0 + y) * side + x0 + x] - mean - bx * (x - c) - by * (y - c)) * hann[x] * hann[y];
  fft2(re, im, M);
  const p = new Float64Array(M * M);
  for (let k = 0; k < p.length; k++) p[k] = re[k] * re[k] + im[k] * im[k];
  return p;
}

export interface Peak { ratio: number; wavelengthM: number; angleDeg: number; axisDeg: number }
const signed = (k: number, M: number) => (k < M / 2 ? k : k - M);
// Strongest wavevector of the annulus lamLoM..lamHiM, against the annulus' median power.
export function dominantPeak(power: Float64Array, M: number, cellM: number, lamLoM = 2000, lamHiM = 9000): Peak {
  const kHi = (M * cellM) / lamLoM, kLo = (M * cellM) / lamHiM, vals: number[] = [];
  let best = -1, bx = 0, by = 0;
  const K = Math.ceil(kHi);
  for (let ky = 0; ky <= K; ky++) for (let kx = -K; kx <= K; kx++) {
    if (ky === 0 && kx <= 0) continue;
    const r = Math.hypot(kx, ky);
    if (r < kLo || r > kHi) continue;
    const v = power[(ky % M) * M + ((kx + M) % M)];
    vals.push(v);
    if (v > best) { best = v; bx = kx; by = ky; }
  }
  vals.sort((a, b) => a - b);
  const med = vals[vals.length >> 1] || 1e-300;
  let a = (Math.atan2(by, bx) * 180) / Math.PI; if (a < 0) a += 180; if (a >= 180) a -= 180;
  return { ratio: best / med, wavelengthM: (M * cellM) / Math.hypot(bx, by), angleDeg: a, axisDeg: Math.min(a, Math.abs(a - 90), 180 - a) };
}

// Mean of the power over the annuli of one padded index (bin i = |k| rounded), and the window's total power without DC.
export function radialProfile(power: Float64Array, M: number): { mean: Float64Array; total: number } {
  const nb = M / 2 + 1, s = new Float64Array(nb), c = new Float64Array(nb);
  let total = 0;
  for (let ky = 0; ky < M; ky++) for (let kx = 0; kx < M; kx++) {
    if (!kx && !ky) continue;
    const b = Math.round(Math.hypot(signed(kx, M), signed(ky, M)));
    if (b >= nb) continue;
    const v = power[ky * M + kx]; s[b] += v; c[b]++; total += v;
  }
  return { mean: Float64Array.from(s, (v, i) => (c[i] ? v / c[i] : 0)), total };
}

export interface WindowRow { x: number; y: number; ratio: number; wavelengthKm: number; angleDeg: number; ridged: boolean; locked: boolean }
export interface LockResult { allLand: number; ridged: number; locked: number; uniformAll: number; uniformRidged: number; rows: WindowRow[]; profile: Float64Array; windowsUsed: number }

// The all-land windows of a region's heights `h` (row length `side`, 1/`unit` metres per unit, sea level 0) on the tile-aligned grid of n-cell windows from (ox, oy).
export function lockWindows(h: ArrayLike<number>, side: number, cellM: number, opts: { n?: number; pad?: number; ox?: number; oy?: number; extent?: number } = {}): LockResult {
  const n = opts.n ?? 256, pad = opts.pad ?? 4, M = n * pad, ox = opts.ox ?? 0, oy = opts.oy ?? 0, ext = opts.extent ?? side;
  const rows: WindowRow[] = [], profile = new Float64Array(M / 2 + 1);
  let allLand = 0;
  for (let y0 = oy; y0 + n <= oy + ext; y0 += n) for (let x0 = ox; x0 + n <= ox + ext; x0 += n) {
    let land = true;
    for (let y = 0; y < n && land; y++) for (let x = 0; x < n; x++) if (!(h[(y0 + y) * side + x0 + x] > 0)) { land = false; break; }
    if (!land) continue;
    allLand++;
    const p = windowPower(h, side, x0, y0, n, pad), pk = dominantPeak(p, M, cellM), ridged = pk.ratio >= PEAK_OVER_MEDIAN, rp = radialProfile(p, M);
    for (let i = 0; i < profile.length; i++) profile[i] += rp.mean[i] / rp.total;
    rows.push({ x: x0, y: y0, ratio: +pk.ratio.toFixed(2), wavelengthKm: +(pk.wavelengthM / 1000).toFixed(3), angleDeg: +pk.angleDeg.toFixed(1), ridged, locked: ridged && pk.axisDeg <= AXIS_TOL_DEG });
  }
  if (allLand) for (let i = 0; i < profile.length; i++) profile[i] /= allLand;
  const ridged = rows.filter((r) => r.ridged).length, locked = rows.filter((r) => r.locked).length;
  return { allLand, ridged, locked, uniformAll: +(allLand * UNIFORM_AXIS_SHARE).toFixed(2), uniformRidged: +(ridged * UNIFORM_AXIS_SHARE).toFixed(2), rows, profile, windowsUsed: rows.length };
}

export interface RidgeSpacing { wavelengthKm: number; ratio: number; exponent: number; insidePerron: boolean; bins: { lamKm: number; power: number; fit: number }[] }
// The ridge-spacing measure from the mean normalised radial profile (index = padded wavevector): see the header.
export function ridgeSpacing(profile: Float64Array, n: number, pad: number, cellM: number, lamSearchKm: [number, number] = [1, 10]): RidgeSpacing {
  const M = n * pad, perDecade = 20, lo = 2, hi = n / 4, groups = new Map<number, { s: number; c: number }>();
  for (let i = 1; i < profile.length; i++) {
    const kw = i / pad;
    if (kw < lo || kw > hi) continue;
    const b = Math.floor(Math.log10(kw) * perDecade), g = groups.get(b) ?? { s: 0, c: 0 };
    g.s += profile[i]; g.c++; groups.set(b, g);
  }
  const pts = [...groups.entries()].sort((a, b) => a[0] - b[0]).map(([b, g]) => ({ lk: (b + 0.5) / perDecade, lp: Math.log10(g.s / g.c) }));
  let use = pts.slice(), a = 0, slope = 0;
  for (let pass = 0; pass < 4; pass++) {
    const m = use.length, sx = use.reduce((s, p) => s + p.lk, 0), sy = use.reduce((s, p) => s + p.lp, 0), sxx = use.reduce((s, p) => s + p.lk * p.lk, 0), sxy = use.reduce((s, p) => s + p.lk * p.lp, 0);
    slope = (m * sxy - sx * sy) / (m * sxx - sx * sx); a = (sy - slope * sx) / m;
    use = pts.filter((p) => p.lp <= a + slope * p.lk + Math.log10(2));
  }
  const bins = pts.map((p) => ({ lamKm: (M / pad * cellM) / 1000 / 10 ** p.lk, power: 10 ** p.lp, fit: 10 ** (a + slope * p.lk) }));
  let best = -1, at = 0;
  bins.forEach((b, i) => { if (b.lamKm >= lamSearchKm[0] && b.lamKm <= lamSearchKm[1] && b.power / b.fit > best) { best = b.power / b.fit; at = i; } });
  const lam = bins[at]?.lamKm ?? NaN;
  return { wavelengthKm: +lam.toFixed(3), ratio: +best.toFixed(3), exponent: +slope.toFixed(3), insidePerron: lam >= PERRON_KM[0] && lam <= PERRON_KM[1], bins };
}
