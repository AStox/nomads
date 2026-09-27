// Pen and geometry helpers for the 2D layers: isolines, distance fields, wobbly hand strokes and dab shapes.
import { noise } from "../world.js";

export const TAU = Math.PI * 2;
export const INK = "#3a2415";

export function rng(seed) {
  let a = seed >>> 0 || 1;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const mix = (a, b, t) => {
  const A = [1, 3, 5].map((i) => parseInt(a.slice(i, i + 2), 16)), B = [1, 3, 5].map((i) => parseInt(b.slice(i, i + 2), 16));
  return "#" + A.map((v, i) => Math.round(v + (B[i] - v) * t).toString(16).padStart(2, "0")).join("");
};

export function chaikin(p, closed, it = 2) {
  for (let k = 0; k < it; k++) {
    const q = closed ? [] : [p[0]], n = p.length, m = closed ? n : n - 1;
    for (let i = 0; i < m; i++) {
      const a = p[i], b = p[(i + 1) % n];
      q.push([a[0] * 0.75 + b[0] * 0.25, a[1] * 0.75 + b[1] * 0.25], [a[0] * 0.25 + b[0] * 0.75, a[1] * 0.25 + b[1] * 0.75]);
    }
    if (!closed) q.push(p[n - 1]);
    p = q;
  }
  return p;
}

export function resample(p, step, closed) {
  const pts = closed ? [...p, p[0]] : p, out = [pts[0]];
  let carry = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i], L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    let t = step - carry;
    while (t <= L) { out.push([a[0] + ((b[0] - a[0]) * t) / L, a[1] + ((b[1] - a[1]) * t) / L]); t += step; }
    carry = L - (t - step);
  }
  const last = pts[pts.length - 1], tail = out[out.length - 1];
  if (!closed && Math.hypot(last[0] - tail[0], last[1] - tail[1]) > step * 0.3) out.push(last);
  if (closed && out.length > 2) out.pop();
  return out;
}

export const length = (p) => { let s = 0; for (let i = 1; i < p.length; i++) s += Math.hypot(p[i][0] - p[i - 1][0], p[i][1] - p[i - 1][1]); return s; };

// Marching squares on a grid (row-major, gw x gh), joined into polylines in grid coordinates.
export function isolines(F, gw, gh, lev) {
  const segs = [], pts = new Map();
  const put = (key, x, y) => { if (!pts.has(key)) pts.set(key, [x, y]); return key; };
  for (let j = 0; j < gh - 1; j++)
    for (let i = 0; i < gw - 1; i++) {
      const a = F[j * gw + i] - lev, b = F[j * gw + i + 1] - lev, c = F[(j + 1) * gw + i + 1] - lev, d = F[(j + 1) * gw + i] - lev;
      const A = a > 0, B = b > 0, C = c > 0, D = d > 0;
      if (A === B && B === C && C === D) continue;
      const e = [];
      if (A !== B) e.push(put((j * gw + i) * 2, i + a / (a - b), j));
      if (B !== C) e.push(put((j * gw + i + 1) * 2 + 1, i + 1, j + b / (b - c)));
      if (D !== C) e.push(put(((j + 1) * gw + i) * 2, i + d / (d - c), j + 1));
      if (A !== D) e.push(put((j * gw + i) * 2 + 1, i, j + a / (a - d)));
      if (e.length === 2) segs.push(e);
      else if ((a + b + c + d) / 4 > 0 === A) segs.push([e[0], e[1]], [e[2], e[3]]);
      else segs.push([e[0], e[3]], [e[1], e[2]]);
    }
  const ends = new Map();
  segs.forEach((s, i) => s.forEach((k) => { const l = ends.get(k); l ? l.push(i) : ends.set(k, [i]); }));
  const seen = new Uint8Array(segs.length), lines = [];
  const follow = (s, k) => {
    const line = [pts.get(k)];
    while (s >= 0 && !seen[s]) {
      seen[s] = 1;
      k = segs[s][0] === k ? segs[s][1] : segs[s][0];
      line.push(pts.get(k));
      s = -1;
      for (const t of ends.get(k)) if (!seen[t]) { s = t; break; }
    }
    return line;
  };
  for (const [k, l] of ends) if (l.length === 1 && !seen[l[0]]) lines.push({ pts: follow(l[0], k), closed: false });
  for (let s = 0; s < segs.length; s++) if (!seen[s]) { const p = follow(s, segs[s][0]); p.pop(); lines.push({ pts: p, closed: true }); }
  return lines;
}

// Euclidean distance (in cells) to the nearest set cell, Felzenszwalb's two-pass transform.
export function edt(src, W, H) {
  const n = Math.max(W, H), f = new Float64Array(n), d = new Float64Array(n), v = new Int32Array(n), z = new Float64Array(n + 1);
  const out = new Float64Array(W * H);
  for (let i = 0; i < W * H; i++) out[i] = src[i] ? 0 : 1e20;
  const dt = (len) => {
    let k = 0;
    v[0] = 0; z[0] = -Infinity; z[1] = Infinity;
    for (let q = 1; q < len; q++) {
      let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      while (s <= z[k]) { k--; s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]); }
      k++; v[k] = q; z[k] = s; z[k + 1] = Infinity;
    }
    k = 0;
    for (let q = 0; q < len; q++) { while (z[k + 1] < q) k++; d[q] = (q - v[k]) ** 2 + f[v[k]]; }
  };
  for (let x = 0; x < W; x++) { for (let y = 0; y < H; y++) f[y] = out[y * W + x]; dt(H); for (let y = 0; y < H; y++) out[y * W + x] = d[y]; }
  for (let y = 0; y < H; y++) { for (let x = 0; x < W; x++) f[x] = out[y * W + x]; dt(W); for (let x = 0; x < W; x++) out[y * W + x] = Math.sqrt(d[x]); }
  return out;
}

// A wobbly closed shape through n points around an ellipse, as a Path2D.
export function blobPts(cx, cy, rx, ry, seed, wob = 0.12, n = 12, rot = 0) {
  const pts = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * TAU + rot, r = 1 + wob * noise(Math.cos(a) * 1.4 + seed * 7.13, Math.sin(a) * 1.4 + seed * 3.71, 11);
    pts.push([cx + Math.cos(a) * rx * r, cy + Math.sin(a) * ry * r]);
  }
  return pts;
}
export function smoothPath(pts, path = new Path2D()) {
  const n = pts.length, m = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  const s = m(pts[n - 1], pts[0]);
  path.moveTo(s[0], s[1]);
  for (let i = 0; i < n; i++) { const e = m(pts[i], pts[(i + 1) % n]); path.quadraticCurveTo(pts[i][0], pts[i][1], e[0], e[1]); }
  path.closePath();
  return path;
}
export const blob = (cx, cy, rx, ry, seed, wob, n, rot) => smoothPath(blobPts(cx, cy, rx, ry, seed, wob, n, rot));
export function polyPath(pts, closed = true) {
  const p = new Path2D();
  pts.forEach(([x, y], i) => (i ? p.lineTo(x, y) : p.moveTo(x, y)));
  if (closed) p.closePath();
  return p;
}

// Points kept by a minimum spacing, queried by a coarse bucket grid.
export class Spacing {
  constructor(cell = 8) { this.cell = cell; this.map = new Map(); }
  key(x, y) { return Math.floor(x / this.cell) * 73856093 ^ Math.floor(y / this.cell) * 19349663; }
  near(x, y, d) {
    const c = this.cell, r = Math.ceil(d / c);
    for (let j = -r; j <= r; j++)
      for (let i = -r; i <= r; i++) {
        const l = this.map.get(Math.floor(x / c + i) * 73856093 ^ Math.floor(y / c + j) * 19349663);
        if (l) for (const p of l) if ((p[0] - x) ** 2 + (p[1] - y) ** 2 < d * d) return true;
      }
    return false;
  }
  add(x, y) { const k = this.key(x, y), l = this.map.get(k); l ? l.push([x, y]) : this.map.set(k, [[x, y]]); }
}

// The pen: a stroke with the hand's tremor, pressure that swells and fades, and tapered ends, filled as one polygon
// so a translucent line never beads where it overlaps itself.
export class Pen {
  constructor(g) { this.g = g; this.k = 0; }
  stroke(pts, { w = 1, w1, color = INK, alpha = 0.9, wob = 0.45, press = 0.3, taper = 5, closed = false } = {}) {
    const P = resample(pts, 1.5, closed), n = P.length;
    if (n < 2) return;
    const s0 = (this.k = (this.k + 1) % 9973) * 3.17, L = [], R = [];
    let total = 0;
    for (let i = 1; i < n; i++) total += Math.hypot(P[i][0] - P[i - 1][0], P[i][1] - P[i - 1][1]);
    let s = 0;
    for (let i = 0; i < n; i++) {
      if (i) s += Math.hypot(P[i][0] - P[i - 1][0], P[i][1] - P[i - 1][1]);
      const a = P[closed ? (i - 1 + n) % n : Math.max(0, i - 1)], b = P[closed ? (i + 1) % n : Math.min(n - 1, i + 1)];
      let tx = b[0] - a[0], ty = b[1] - a[1];
      const tl = Math.hypot(tx, ty) || 1;
      tx /= tl; ty /= tl;
      const tp = closed ? 1 : Math.min(1, 0.3 + (0.7 * s) / taper) * Math.min(1, 0.25 + (0.75 * (total - s)) / taper);
      const base = w1 === undefined ? w : w + ((w1 - w) * s) / (total || 1);
      const hw = (base * Math.max(0.25, 1 + press * noise(s / 40, s0, 3)) * tp) / 2, o = wob * noise(s / 26, s0 + 1.7, 5);
      L.push([P[i][0] - ty * (o + hw), P[i][1] + tx * (o + hw)]);
      R.push([P[i][0] - ty * (o - hw), P[i][1] + tx * (o - hw)]);
    }
    const g = this.g;
    g.beginPath();
    if (closed) {
      L.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
      g.closePath();
      for (let i = n - 1; i >= 0; i--) (i === n - 1 ? g.moveTo(R[i][0], R[i][1]) : g.lineTo(R[i][0], R[i][1]));
      g.closePath();
    } else {
      L.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
      for (let i = n - 1; i >= 0; i--) g.lineTo(R[i][0], R[i][1]);
      g.closePath();
    }
    g.globalAlpha = alpha;
    g.fillStyle = color;
    g.fill("nonzero");
    g.globalAlpha = 1;
  }
  // Split a line into dashes where a slow noise along its length stays above `keep`.
  broken(pts, keep, scale, o) {
    const P = resample(pts, 2, false), s0 = this.k * 1.93 + 0.5;
    let run = [], s = 0;
    for (let i = 0; i < P.length; i++) {
      if (i) s += 2;
      if (noise(s / scale, s0, 9) > keep) run.push(P[i]);
      else { if (run.length > 2) this.stroke(run, o); run = []; }
    }
    if (run.length > 2) this.stroke(run, o);
    this.k++;
  }
}

export function hull(pts) {
  const p = [...pts].sort((a, b) => a[0] - b[0] || a[1] - b[1]), lo = [], up = [];
  const cr = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  for (const q of p) { while (lo.length >= 2 && cr(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q); }
  for (const q of p.reverse()) { while (up.length >= 2 && cr(up[up.length - 2], up[up.length - 1], q) <= 0) up.pop(); up.push(q); }
  return lo.slice(0, -1).concat(up.slice(0, -1));
}
