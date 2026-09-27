// Small geometry kit: a growable triangle soup with flat normals and vertex colors, plus low-poly primitives.
import * as THREE from "three";

export const lin = (hex) => { const c = new THREE.Color(hex); return [c.r, c.g, c.b]; };
export const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
export const mul = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
export const tint = (a, b) => [a[0] * b[0], a[1] * b[1], a[2] * b[2]];

export class Buf {
  constructor(cap = 4096) {
    this.cap = cap;
    this.t = 0;
    this.p = new Float32Array(cap * 9);
    this.n = new Float32Array(cap * 9);
    this.c = new Float32Array(cap * 9);
  }
  grow() {
    this.cap *= 2;
    for (const k of ["p", "n", "c"]) { const a = new Float32Array(this.cap * 9); a.set(this[k]); this[k] = a; }
  }
  // `hint` is a direction the face should look toward; the winding is flipped to match it.
  tri(a, b, c, ca, cb, cc, hint) {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const L = Math.hypot(nx, ny, nz);
    if (L < 1e-12) return;
    nx /= L; ny /= L; nz /= L;
    if (hint && nx * hint[0] + ny * hint[1] + nz * hint[2] < 0) { [b, c] = [c, b]; [cb, cc] = [cc, cb]; nx = -nx; ny = -ny; nz = -nz; }
    if (this.t === this.cap) this.grow();
    const o = this.t++ * 9, p = this.p, n = this.n, col = this.c;
    p[o] = a[0]; p[o + 1] = a[1]; p[o + 2] = a[2]; p[o + 3] = b[0]; p[o + 4] = b[1]; p[o + 5] = b[2]; p[o + 6] = c[0]; p[o + 7] = c[1]; p[o + 8] = c[2];
    for (let k = 0; k < 9; k += 3) { n[o + k] = nx; n[o + k + 1] = ny; n[o + k + 2] = nz; }
    col[o] = ca[0]; col[o + 1] = ca[1]; col[o + 2] = ca[2]; col[o + 3] = cb[0]; col[o + 4] = cb[1]; col[o + 5] = cb[2]; col[o + 6] = cc[0]; col[o + 7] = cc[1]; col[o + 8] = cc[2];
  }
  quad(a, b, c, d, ca, cb, cc, cd, hint) { this.tri(a, b, c, ca, cb, cc, hint); this.tri(a, c, d, ca, cc, cd, hint); }
  geometry() {
    const g = new THREE.BufferGeometry(), m = this.t * 9;
    g.setAttribute("position", new THREE.BufferAttribute(this.p.slice(0, m), 3));
    g.setAttribute("normal", new THREE.BufferAttribute(this.n.slice(0, m), 3));
    g.setAttribute("color", new THREE.BufferAttribute(this.c.slice(0, m), 3));
    g.computeBoundingSphere();
    return g;
  }
}

const PHI = (1 + Math.sqrt(5)) / 2;
const IV = [[-1, PHI, 0], [1, PHI, 0], [-1, -PHI, 0], [1, -PHI, 0], [0, -1, PHI], [0, 1, PHI], [0, -1, -PHI], [0, 1, -PHI], [PHI, 0, -1], [PHI, 0, 1], [-PHI, 0, -1], [-PHI, 0, 1]].map((v) => { const l = Math.hypot(...v); return v.map((x) => x / l); });
const IF = [[0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8], [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1]];

// A lumpy icosahedron; `col(v)` colors a vertex by its unit height -1..1 (painted top-light gradient).
export function ico(buf, cx, cy, cz, rx, ry, rz, col, rnd, jit = 0.18, floorY = -Infinity) {
  const P = IV.map(([x, y, z]) => { const j = 1 + (rnd() - 0.5) * 2 * jit; return [cx + x * rx * j, Math.max(floorY, cy + y * ry * j), cz + z * rz * j]; });
  const C = IV.map(([, y]) => col(y));
  for (const [a, b, c] of IF) {
    const m = [(P[a][0] + P[b][0] + P[c][0]) / 3 - cx, (P[a][1] + P[b][1] + P[c][1]) / 3 - cy, (P[a][2] + P[b][2] + P[c][2]) / 3 - cz];
    buf.tri(P[a], P[b], P[c], C[a], C[b], C[c], m);
  }
}

// A stack of jittered rings closed by an apex: cones, pines, mountains. rings: [[y, radius, color], ...], apex [y, color].
export function spire(buf, cx, cz, rings, apex, sides, rnd, jit = 0.12, rot = 0, lean = [0, 0]) {
  const R = rings.map(([y, r, c], k) => {
    const pts = [];
    for (let s = 0; s < sides; s++) {
      const a = rot + (s / sides) * Math.PI * 2 + (rnd() - 0.5) * jit, rr = r * (1 + (rnd() - 0.5) * 2 * jit);
      pts.push([cx + Math.cos(a) * rr + lean[0] * y, y + (k ? (rnd() - 0.5) * jit * r : 0), cz + Math.sin(a) * rr + lean[1] * y]);
    }
    return { pts, c: typeof c === "function" ? c : () => c };
  });
  const top = [cx + lean[0] * apex[0], apex[0], cz + lean[1] * apex[0]];
  for (let k = 0; k < R.length; k++) {
    const A = R[k], B = R[k + 1];
    for (let s = 0; s < sides; s++) {
      const s1 = (s + 1) % sides, a0 = A.pts[s], a1 = A.pts[s1];
      const hint = [(a0[0] + a1[0]) / 2 - cx, 0.35, (a0[2] + a1[2]) / 2 - cz];
      if (B) buf.quad(a0, a1, B.pts[s1], B.pts[s], A.c(s), A.c(s1), B.c(s1), B.c(s), hint);
      else buf.tri(a0, a1, top, A.c(s), A.c(s1), apex[1], hint);
    }
  }
  const b = R[0];
  for (let s = 0; s < sides; s++) buf.tri(b.pts[s], b.pts[(s + 1) % sides], [cx, rings[0][0], cz], b.c(s), b.c(s), b.c(s), [0, -1, 0]);
}

// A capped frustum between two heights along y (trunks, stems, stones).
export function post(buf, cx, cz, y0, y1, r0, r1, sides, c0, c1, rot = 0) {
  const ring = (y, r) => [...Array(sides)].map((_, s) => { const a = rot + (s / sides) * Math.PI * 2; return [cx + Math.cos(a) * r, y, cz + Math.sin(a) * r]; });
  const A = ring(y0, r0), B = ring(y1, r1);
  for (let s = 0; s < sides; s++) {
    const s1 = (s + 1) % sides;
    buf.quad(A[s], A[s1], B[s1], B[s], c0, c0, c1, c1, [(A[s][0] + A[s1][0]) / 2 - cx, 0, (A[s][2] + A[s1][2]) / 2 - cz]);
    buf.tri(B[s], B[s1], [cx, y1, cz], c1, c1, c1, [0, 1, 0]);
  }
}

// A log lying along x from -len/2 to len/2 at height r.
export function log(buf, len, r, sides, cBark, cEnd, rot = 0) {
  const ring = (x) => [...Array(sides)].map((_, s) => { const a = rot + (s / sides) * Math.PI * 2; return [x, r + Math.cos(a) * r, Math.sin(a) * r]; });
  const A = ring(-len / 2), B = ring(len / 2);
  for (let s = 0; s < sides; s++) {
    const s1 = (s + 1) % sides;
    buf.quad(A[s], A[s1], B[s1], B[s], cBark, cBark, mul(cBark, 1.15), mul(cBark, 1.15), [0, (A[s][1] + A[s1][1]) / 2 - r, (A[s][2] + A[s1][2]) / 2]);
    buf.tri(A[s], A[s1], [-len / 2, r, 0], cEnd, cEnd, cEnd, [-1, 0, 0]);
    buf.tri(B[s], B[s1], [len / 2, r, 0], cEnd, cEnd, cEnd, [1, 0, 0]);
  }
}
