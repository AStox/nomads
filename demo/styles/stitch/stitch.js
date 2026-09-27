// The stitches themselves, placed on the cloth's holes: cross, half and three-quarter stitches, backstitch, straight
// and satin stitches, French knots, lazy daisies and loose tails. Each is a few threads handed to the height picture.
import { hash } from "../world.js";

const TAU = Math.PI * 2;
const vary = (c, f) => [c[0] * f, c[1] * f, c[2] * f];

export class Stitcher {
  // zf(x, y): height of the cloth's plane there, for stitches that sit on it rather than lie over other work
  constructor(gb, fab, zf = () => 0) { this.gb = gb; this.fab = fab; this.cs = fab.cs; this.n = 0; this.zf = zf; }
  zc(i, j) { const p = this.fab.at(i + 0.5, j + 0.5); return this.zf(p[0], p[1]); }
  // hole (i, j) with the needle's small miss
  h(i, j, s, k) { const p = this.fab.hole(i, j), e = this.cs * 0.05; return [p[0] + (hash(s, k, 1) - 0.5) * e, p[1] + (hash(s, k, 2) - 0.5) * e]; }
  p(u, v) { return this.fab.at(u, v); }

  cross(i, j, c, o = {}) {
    const cs = this.cs, s = (i * 7919 + j * 104729) | 0, v = 0.95 + 0.1 * hash(i, j, 21);
    const r = cs * (o.r ?? 0.235) * (0.94 + 0.12 * hash(i, j, 22)), base = cs * 0.03 + (o.z ?? 0) + this.zc(i, j);
    const A = this.h(i, j, s, 1), B = this.h(i + 1, j, s, 2), C = this.h(i, j + 1, s, 3), D = this.h(i + 1, j + 1, s, 4);
    const flip = hash(i, j, 23) < 0.006;
    const [p0, p1, q0, q1] = flip ? [A, D, C, B] : [C, B, A, D];
    this.gb.strand(p0[0], p0[1], p1[0], p1[1], { r, h: 0.72, c: vary(c, v * (0.98 + 0.03 * hash(i, j, 24))), z: base, lift: cs * 0.04, seed: s, gloss: o.gloss ?? 0.75 });
    this.gb.strand(q0[0], q0[1], q1[0], q1[1], { r, h: 0.72, c: vary(c, v), z: base, lift: cs * 0.09, seed: s + 1, gloss: o.gloss ?? 0.75 });
  }
  half(i, j, c, o = {}) {
    const cs = this.cs, s = (i * 7919 + j * 104729 + 5) | 0, v = 0.95 + 0.1 * hash(i, j, 25);
    const r = cs * (o.r ?? 0.2) * (0.94 + 0.12 * hash(i, j, 26)), C = this.h(i, j + 1, s, 3), B = this.h(i + 1, j, s, 2);
    this.gb.strand(C[0], C[1], B[0], B[1], { r, h: 0.72, c: vary(c, v), z: cs * 0.03 + this.zc(i, j), lift: cs * 0.06, seed: s, gloss: 0.75 });
  }
  // corner 0 NW, 1 NE, 2 SW, 3 SE: the right angle of the stitched triangle
  threeQ(i, j, corner, c) {
    const cs = this.cs, s = (i * 7919 + j * 104729 + 9) | 0, v = 0.95 + 0.1 * hash(i, j, 27), r = cs * 0.2;
    const A = this.h(i, j, s, 1), B = this.h(i + 1, j, s, 2), C = this.h(i, j + 1, s, 3), D = this.h(i + 1, j + 1, s, 4), M = this.p(i + 0.5, j + 0.5);
    const [a, b] = corner === 1 || corner === 2 ? [A, D] : [C, B], q = [A, B, C, D][corner];
    const z = cs * 0.03 + this.zc(i, j);
    this.gb.strand(a[0], a[1], b[0], b[1], { r, h: 0.72, c: vary(c, v), z, lift: cs * 0.05, seed: s, gloss: 0.75 });
    this.gb.strand(q[0], q[1], M[0], M[1], { r, h: 0.72, c: vary(c, v * 0.98), z, lift: cs * 0.09, seed: s + 1, gloss: 0.75, dive1: 0.5 });
  }
  // backstitch from hole to hole, lying over whatever is stitched there
  back(i0, j0, i1, j1, c, o = {}) {
    const s = (i0 * 31 + j0 * 977 + i1 * 7 + j1 * 13) | 0, a = this.h(i0, j0, s, 5), b = this.h(i1, j1, s, 6);
    this.gb.strand(a[0], a[1], b[0], b[1], { r: Math.max(2.1, this.cs * (o.r ?? 0.12)), c: vary(c, 0.96 + 0.08 * hash(s, 1, 9)), drape: true, plies: o.plies ?? 1, seed: s, gloss: 0.8, above: this.cs * 0.02 });
  }
  straight(u0, v0, u1, v1, c, o = {}) {
    const s = o.seed ?? this.n++, a = this.p(u0, v0), b = this.p(u1, v1);
    this.gb.strand(a[0], a[1], b[0], b[1], { r: this.cs * (o.r ?? 0.13), c: vary(c, 0.95 + 0.1 * hash(s, 2, 9)), drape: true, plies: o.plies ?? 2, seed: s, gloss: o.gloss ?? 0.8, above: o.above ?? this.cs * 0.03, dive0: o.dive0 ?? 1, dive1: o.dive1 ?? 1, lift: o.lift ?? 0 });
  }
  knot(u, v, c, o = {}) {
    const s = o.seed ?? this.n++, p = this.p(u, v);
    const r = this.cs * (o.r ?? 0.4) * (0.9 + 0.2 * hash(s, 3, 9));
    this.gb[r < 6 ? "bead" : "knot"](p[0], p[1], r, vary(c, 0.93 + 0.12 * hash(s, 4, 9)), { seed: s, wraps: o.wraps ?? 2 });
  }
  // a flower or shrub of lazy daisies round one centre, all lying at the same height
  flower(u, v, n, len, c, centre, o = {}) {
    const s = o.seed ?? this.n++, p = this.p(u, v), z = this.gb.peak(p[0], p[1], this.cs * len * 0.8) + this.cs * 0.02;
    for (let q = 0; q < n; q++) this.daisy(u, v, (o.rot ?? 0) + (q / n) * TAU + hash(s, q, 3) * 0.3, len * (0.85 + 0.3 * hash(s, q, 4)), c, { ...o, z, seed: s * 7 + q });
    if (centre) this.knot(u, v, centre, { r: Math.min(0.42, len * 0.34), seed: s + 3 });
  }
  // lazy daisy: a loop of thread held down at its tip by a tiny stitch
  daisy(u, v, ang, len, c, o = {}) {
    const s = o.seed ?? this.n++, wid = len * (o.wide ?? 0.42), ca = Math.cos(ang), sa = Math.sin(ang), pts = [];
    for (let k = 0; k <= 14; k++) {
      const t = (k / 14) * TAU, al = (len * (1 - Math.cos(t))) / 2, ac = wid * Math.sin(t) * (0.35 + 0.65 * (1 - Math.cos(t)) / 2);
      pts.push(this.p(u + al * ca - ac * sa, v + al * sa + ac * ca));
    }
    const r = this.cs * (o.r ?? 0.11);
    this.gb.thread(pts, { r, c: vary(c, 0.95 + 0.1 * hash(s, 5, 9)), drape: o.z === undefined, z: o.z, plies: 2, seed: s, gloss: 0.85, above: this.cs * 0.03, h: 0.7 });
    const tu = u + len * ca * 1.02, tv = v + len * sa * 1.02, tk = wid * 0.28;
    this.straight(tu - sa * tk - ca * 0.05, tv + ca * tk - sa * 0.05, tu + sa * tk - ca * 0.05, tv - ca * tk - sa * 0.05, c, { r: o.r ?? 0.1, plies: 1, seed: s + 1 });
  }
  // satin: close parallel stitches across a polygon (fabric coords) at angle ang
  satin(poly, ang, c, o = {}) {
    const ca = Math.cos(ang), sa = Math.sin(ang), gap = o.gap ?? 0.3, r = o.r ?? 0.17, lift = this.cs * (o.lift ?? 0.12);
    // project the polygon on the across-axis, then cut it with lines
    let lo = Infinity, hi = -Infinity;
    for (const [u, v] of poly) { const q = -u * sa + v * ca; lo = Math.min(lo, q); hi = Math.max(hi, q); }
    let k = 0;
    for (let q = lo + gap * 0.5; q < hi; q += gap, k++) {
      const xs = [];
      for (let e = 0; e < poly.length; e++) {
        const [u0, v0] = poly[e], [u1, v1] = poly[(e + 1) % poly.length];
        const q0 = -u0 * sa + v0 * ca, q1 = -u1 * sa + v1 * ca;
        if ((q0 <= q && q1 > q) || (q1 <= q && q0 > q)) { const t = (q - q0) / (q1 - q0); xs.push((u0 + (u1 - u0) * t) * ca + (v0 + (v1 - v0) * t) * sa); }
      }
      xs.sort((a, b) => a - b);
      for (let m = 0; m + 1 < xs.length; m += 2) {
        const a = xs[m] + (hash(k, m, 41) - 0.5) * 0.06, b = xs[m + 1] + (hash(k, m, 42) - 0.5) * 0.06;
        if (b - a < 0.08) continue;
        const A = this.p(a * ca - q * sa, a * sa + q * ca), B = this.p(b * ca - q * sa, b * sa + q * ca);
        this.gb.strand(A[0], A[1], B[0], B[1], { r: this.cs * r, c: vary(c, (o.shade ? o.shade(q, (a + b) / 2) : 1) * (0.97 + 0.06 * hash(k, 3, 43))), z: this.cs * (0.05 + (o.z ?? 0)) + this.zf(A[0], A[1]), lift: Math.min(lift, (b - a) * this.cs * 0.12), seed: (o.seed ?? 0) + k * 3 + m, gloss: o.gloss ?? 0.95, pitch: 1.6, twist: 0.35 });
      }
    }
  }
  // a cut end of floss left lying on the cloth: comes up through a hole, wanders, frays at the tip
  tail(u, v, ang, len, c, o = {}) {
    const s = o.seed ?? this.n++, pts = [], n = Math.max(6, Math.ceil(len * 3));
    let a = ang, pu = u, pv = v;
    for (let k = 0; k <= n; k++) {
      pts.push(this.p(pu, pv));
      a += (hash(s, k, 7) - 0.5) * 0.25 + (o.curl ?? 0.08);
      pu += (Math.cos(a) * len) / n; pv += (Math.sin(a) * len) / n;
    }
    const r = this.cs * (o.r ?? 0.14);
    this.gb.thread(pts, { r, c, drape: true, plies: 2, seed: s, gloss: 0.8, dive0: o.dive0 ?? 1, dive1: 0, above: this.cs * 0.04, pitch: 3, twist: 0.25, soft: 1, h: 0.6 });
    // the plies part at the cut
    const end = pts[pts.length - 1], prev = pts[pts.length - 2], ea = Math.atan2(end[1] - prev[1], end[0] - prev[0]);
    for (let f = -1; f <= 1; f += 2) {
      const b = ea + f * 0.35, l = this.cs * 0.35;
      this.gb.strand(end[0], end[1], end[0] + Math.cos(b) * l, end[1] + Math.sin(b) * l, { r: r * 0.5, c, drape: true, plies: 1, seed: s + f + 9, dive0: 0, dive1: 0, above: this.cs * 0.03 });
    }
  }
}
