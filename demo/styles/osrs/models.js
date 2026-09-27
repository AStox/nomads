// Chunky low-poly props in the manner of the 2007 client: a few dozen to two hundred triangles each, flat vertex
// colors, smooth (Gouraud) normals on foliage and rounded things, flat normals on boxes and rock.
import * as THREE from "three";
import { mergeVertices } from "three/addons/utils/BufferGeometryUtils.js";
import { hsl } from "./terrain.js";

const V = new THREE.Vector3(), NV = new THREE.Vector3(), UP = new THREE.Vector3(0, 1, 0);
export function mulberry(a) {
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const shade = (c, k) => c.map((v) => Math.min(1, v * k));
const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);

export class Mesh {
  constructor() { this.p = []; this.n = []; this.c = []; this.stack = [new THREE.Matrix4()]; }
  get m() { return this.stack[this.stack.length - 1]; }
  push(mat) { this.stack.push(this.m.clone().multiply(mat)); return this; }
  pop() { this.stack.pop(); return this; }
  // translate, yaw about y, uniform scale
  at(x, y, z, yaw = 0, s = 1) { return this.push(new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromAxisAngle(UP, yaw), new THREE.Vector3(s, s, s))); }
  vtx(p, n, c) {
    V.set(p[0], p[1], p[2]).applyMatrix4(this.m);
    NV.set(n[0], n[1], n[2]).transformDirection(this.m);
    this.p.push(V.x, V.y, V.z); this.n.push(NV.x, NV.y, NV.z); this.c.push(c[0], c[1], c[2]);
  }
  tri(a, b, c, ca, cb = ca, cc = ca, na, nb, nc) {
    if (!na) {
      const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
      const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]], l = Math.hypot(...n) || 1;
      na = nb = nc = n.map((q) => q / l);
    }
    this.vtx(a, na, ca); this.vtx(b, nb, cb); this.vtx(c, nc, cc);
  }
  quad(a, b, c, d, ca, cb = ca, cc = ca, cd = ca) { this.tri(a, b, c, ca, cb, cc); this.tri(a, c, d, ca, cc, cd); }
  // Eight corners: bottom (-x-z, +x-z, +x+z, -x+z) then top in the same order.
  hexa(k, col, top = col, bottom = col) {
    const [b0, b1, b2, b3, t0, t1, t2, t3] = k;
    this.quad(b3, b2, t2, t3, col); this.quad(b1, b0, t0, t1, shade(col, 0.96));
    this.quad(b2, b1, t1, t2, col); this.quad(b0, b3, t3, t0, col);
    this.quad(t3, t2, t1, t0, top); this.quad(b0, b1, b2, b3, bottom);
  }
  box(w, h, d, col, top = col, cx = 0, cy = 0, cz = 0) { return this.taper(w, d, w, d, h, col, top, cx, cy - h / 2, cz); }
  // A box from y0 up by h whose top rectangle may differ from its bottom one.
  taper(wb, db, wt, dt, h, col, top = col, cx = 0, y0 = 0, cz = 0) {
    const c = (w, d, y) => [[cx - w / 2, y, cz - d / 2], [cx + w / 2, y, cz - d / 2], [cx + w / 2, y, cz + d / 2], [cx - w / 2, y, cz + d / 2]];
    this.hexa([...c(wb, db, y0), ...c(wt, dt, y0 + h)], col, top);
    return this;
  }
  prism(r0, r1, h, n, col, top = col, { smooth = true, caps = true, rot = 0, bottom = col } = {}) {
    const ring = (r, y) => Array.from({ length: n }, (_, k) => { const a = rot + (k / n) * Math.PI * 2; return [Math.cos(a) * r, y, Math.sin(a) * r]; });
    const B = ring(r0, 0), T = ring(r1, h), slope = (r0 - r1) / h;
    for (let k = 0; k < n; k++) {
      const q = (k + 1) % n;
      if (smooth) {
        const nk = [B[k][0] / r0, slope, B[k][2] / r0], nq = [B[q][0] / r0, slope, B[q][2] / r0];
        this.tri(B[q], B[k], T[k], col, col, top, nq, nk, nk);
        this.tri(B[q], T[k], T[q], col, top, top, nq, nk, nq);
      } else this.quad(B[q], B[k], T[k], T[q], col, col, top, top);
      if (caps && r1 > 0) this.tri([0, h, 0], T[q], T[k], top);
      if (caps) this.tri([0, 0, 0], B[k], B[q], bottom);
    }
    return this;
  }
  cone(r, h, n, base, tip, { rot = 0, under = null, y0 = 0 } = {}) {
    const B = Array.from({ length: n }, (_, k) => { const a = rot + (k / n) * Math.PI * 2; return [Math.cos(a) * r, y0, Math.sin(a) * r]; });
    const slope = r / h, T = [0, y0 + h, 0];
    for (let k = 0; k < n; k++) {
      const q = (k + 1) % n, nk = [B[k][0] / r, slope, B[k][2] / r], nq = [B[q][0] / r, slope, B[q][2] / r];
      this.tri(B[q], B[k], T, base, base, tip, nq, nk, [0, 1, 0]);
      if (under) this.tri([0, y0, 0], B[k], B[q], under);
    }
    return this;
  }
  // A limb (tapered prism) from p0 to p1.
  limb(p0, p1, r0, r1, n, col, top = col, opts = {}) {
    const d = new THREE.Vector3(p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]), len = d.length();
    this.push(new THREE.Matrix4().compose(new THREE.Vector3(...p0), new THREE.Quaternion().setFromUnitVectors(UP, d.normalize()), new THREE.Vector3(1, 1, 1)));
    this.prism(r0, r1, len, n, col, top, opts);
    return this.pop();
  }
  // A lumpy low-poly ball: an icosahedron with its corners pushed about, smooth or flat.
  blob(cx, cy, cz, r, { detail = 0, jitter = 0.22, sx = 1, sy = 1, sz = 1, seed = 1, color, vary = 0.1, top = 0.12, flat = false, colorAt = null } = {}) {
    let g = new THREE.IcosahedronGeometry(1, detail);
    g.deleteAttribute("normal"); g.deleteAttribute("uv");
    g = mergeVertices(g);
    const rnd = mulberry(seed * 7919 + 13), pos = g.attributes.position, cols = [];
    for (let i = 0; i < pos.count; i++) {
      const k = 1 + (rnd() - 0.5) * 2 * jitter, x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
      pos.setXYZ(i, cx + x * r * k * sx, cy + y * r * k * sy, cz + z * r * k * sz);
      cols.push(colorAt ? colorAt(x, y, z, rnd) : shade(color, 1 + (rnd() - 0.5) * 2 * vary + y * top));
    }
    g.computeVertexNormals();
    const nr = g.attributes.normal, ix = g.index.array, P = (i) => [pos.getX(i), pos.getY(i), pos.getZ(i)], Nn = (i) => [nr.getX(i), nr.getY(i), nr.getZ(i)];
    for (let t = 0; t < ix.length; t += 3) {
      const [a, b, c] = [ix[t], ix[t + 1], ix[t + 2]];
      if (flat) this.tri(P(a), P(b), P(c), cols[a], cols[b], cols[c]);
      else this.tri(P(a), P(b), P(c), cols[a], cols[b], cols[c], Nn(a), Nn(b), Nn(c));
    }
    return this;
  }
  geometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(this.p, 3));
    g.setAttribute("normal", new THREE.Float32BufferAttribute(this.n, 3));
    g.setAttribute("color", new THREE.Float32BufferAttribute(this.c, 3));
    return g;
  }
}

const BARK = hsl(28, 0.36, 0.25), BARK_DARK = hsl(24, 0.34, 0.17), WOOD = hsl(38, 0.45, 0.5);

// ---------- trees ----------
export function evergreen(seed) {
  const M = new Mesh(), r = mulberry(seed), leaf = hsl(128 + r() * 16, 0.36, 0.19 + r() * 0.03);
  M.prism(0.38, 0.22, 2.6, 5, BARK_DARK, BARK);
  const tiers = 4;
  for (let k = 0; k < tiers; k++) {
    const y = 1.3 + k * 1.45, rad = 2.5 - k * 0.52, h = 2.5 - k * 0.12;
    M.cone(rad, h, 7, shade(leaf, 0.85 + k * 0.05), shade(leaf, 1.3 + k * 0.06), { rot: r() * 3, under: shade(leaf, 0.55), y0: y });
  }
  return M.geometry();
}

function canopyColor(base, rnd, x, y) { return shade(mix(base, hsl(70, 0.5, 0.42), Math.max(0, y) * 0.18 + rnd() * 0.08), 0.9 + rnd() * 0.18 + y * 0.12); }

export function normalTree(seed, leaf = hsl(98, 0.46, 0.26)) {
  const M = new Mesh(), r = mulberry(seed), lean = (r() - 0.5) * 0.4;
  M.limb([0, 0, 0], [lean, 3.3, 0], 0.46, 0.3, 6, BARK_DARK, BARK);
  M.limb([lean * 0.8, 2.5, 0], [lean + 1.1, 3.8, 0.3], 0.16, 0.1, 4, BARK, BARK, { caps: false });
  M.limb([lean * 0.8, 2.3, 0], [lean - 0.9, 3.6, -0.4], 0.15, 0.1, 4, BARK, BARK, { caps: false });
  const colorAt = (x, y, z, rnd) => canopyColor(leaf, rnd, x, y);
  M.blob(lean, 4.6, 0, 1.9, { seed: seed + 1, sy: 0.78, colorAt });
  for (let k = 0; k < 3; k++) {
    const a = r() * 0.8 + (k * Math.PI * 2) / 3;
    M.blob(lean + Math.cos(a) * 1.25, 4.1 + r() * 0.6, Math.sin(a) * 1.25, 1.25 + r() * 0.25, { seed: seed + 2 + k, sy: 0.85, colorAt });
  }
  M.blob(lean + (r() - 0.5) * 0.5, 5.7, (r() - 0.5) * 0.5, 1.1, { seed: seed + 9, colorAt });
  return M.geometry();
}

export function oak(seed) {
  const M = new Mesh(), r = mulberry(seed), leaf = hsl(90, 0.42, 0.22 + r() * 0.03);
  M.prism(0.72, 0.46, 3.4, 7, BARK_DARK, BARK);
  for (let k = 0; k < 4; k++) {
    const a = (k / 4) * Math.PI * 2 + r();
    M.limb([Math.cos(a) * 0.4, 0.55, Math.sin(a) * 0.4], [Math.cos(a) * 1.05, -0.05, Math.sin(a) * 1.05], 0.28, 0.1, 4, BARK_DARK, BARK_DARK, { caps: false });
  }
  M.limb([0, 2.8, 0], [1.5, 4.1, 0.4], 0.24, 0.14, 5, BARK);
  M.limb([0, 2.9, 0], [-1.3, 4.2, -0.6], 0.24, 0.14, 5, BARK);
  const colorAt = (x, y, z, rnd) => canopyColor(leaf, rnd, x, y);
  M.blob(0, 5.2, 0, 2.3, { seed: seed + 1, sy: 0.7, colorAt });
  for (let k = 0; k < 5; k++) {
    const a = r() * 0.6 + (k * Math.PI * 2) / 5, d = 1.8 + r() * 0.4;
    M.blob(Math.cos(a) * d, 4.5 + r() * 0.8, Math.sin(a) * d, 1.4 + r() * 0.35, { seed: seed + 3 + k, sy: 0.75, colorAt });
  }
  return M.geometry();
}

export function willow(seed) {
  const M = new Mesh(), r = mulberry(seed), leaf = hsl(68, 0.52, 0.36), lean = 0.5 + r() * 0.4;
  M.limb([0, 0, 0], [lean, 3.6, 0.2], 0.52, 0.34, 6, BARK_DARK, BARK);
  const cx = lean, cy = 5.0, colorAt = (x, y, z, rnd) => canopyColor(leaf, rnd, x, y);
  M.blob(cx, cy, 0.2, 1.9, { seed: seed + 1, sy: 0.55, colorAt });
  M.blob(cx + 0.3, cy + 0.7, 0, 1.2, { seed: seed + 2, sy: 0.7, colorAt });
  const n = 20;
  for (let k = 0; k < n; k++) {
    const a = (k / n) * Math.PI * 2 + r() * 0.3, rr = 1.4 + r() * 0.6, len = 2.9 + r() * 1.3, w = 0.5;
    const ox = cx + Math.cos(a) * rr, oz = 0.2 + Math.sin(a) * rr, px = -Math.sin(a) * w, pz = Math.cos(a) * w, out = 0.45;
    const y0 = cy + 0.1, y1 = y0 - len * 0.5, y2 = y0 - len;
    const m1 = [ox + Math.cos(a) * out, y1, oz + Math.sin(a) * out], m2 = [ox + Math.cos(a) * out * 1.2, y2, oz + Math.sin(a) * out * 1.2];
    const top = shade(leaf, 1.05 + r() * 0.1), mid = shade(leaf, 0.9), tip = shade(leaf, 0.72);
    M.quad([ox - px, y0, oz - pz], [ox + px, y0, oz + pz], [m1[0] + px, y1, m1[2] + pz], [m1[0] - px, y1, m1[2] - pz], top, top, mid, mid);
    M.tri([m1[0] - px, y1, m1[2] - pz], [m1[0] + px, y1, m1[2] + pz], m2, mid, mid, tip);
  }
  return M.geometry();
}

export function deadTree(seed) {
  const M = new Mesh(), r = mulberry(seed), wood = hsl(30, 0.13, 0.33), dark = hsl(28, 0.14, 0.22);
  M.limb([0, 0, 0], [0.2, 3.8, 0], 0.38, 0.18, 5, dark, wood);
  for (let k = 0; k < 4; k++) {
    const a = (k / 4) * Math.PI * 2 + r(), y = 1.8 + k * 0.5, len = 1.4 + r() * 0.9;
    const tip = [Math.cos(a) * len, y + 1.0 + r() * 0.8, Math.sin(a) * len];
    M.limb([0.1, y, 0], tip, 0.14, 0.06, 4, wood, wood, { caps: false });
    M.limb(tip.map((v, i) => v * 0.7 + [0.1, y, 0][i] * 0.3), [tip[0] + Math.cos(a + 1) * 0.6, tip[1] + 0.7, tip[2] + Math.sin(a + 1) * 0.6], 0.07, 0.03, 3, wood, wood, { caps: false });
  }
  return M.geometry();
}

// ---------- small plants and rocks ----------
export function bush(seed, heath = 0, berries = false) {
  const M = new Mesh(), r = mulberry(seed);
  const leaf = heath > 0.5 ? mix(hsl(96, 0.36, 0.22), hsl(318, 0.22, 0.3), (heath - 0.5) * 2) : hsl(100, 0.42, 0.21 + r() * 0.04);
  const colorAt = (x, y, z, rnd) => canopyColor(leaf, rnd, x, y);
  M.blob(0, 0.6, 0, 0.8, { seed, sy: 0.8, colorAt });
  M.blob(0.55, 0.45, 0.2, 0.55, { seed: seed + 1, colorAt });
  M.blob(-0.45, 0.45, -0.25, 0.58, { seed: seed + 2, colorAt });
  if (berries) for (let k = 0; k < 7; k++) {
    const a = r() * 6.28, y = 0.3 + r() * 0.6, d = 0.75 + (0.8 - y) * 0.3;
    M.push(new THREE.Matrix4().makeTranslation(Math.cos(a) * d, y, Math.sin(a) * d)).blob(0, 0, 0, 0.1, { seed: k, color: hsl(0, 0.75, 0.42), flat: true, top: 0 }).pop();
  }
  return M.geometry();
}

const ORES = { copper: hsl(24, 0.62, 0.45), tin: hsl(40, 0.06, 0.66), iron: hsl(10, 0.45, 0.28), coal: hsl(0, 0, 0.1), clay: hsl(40, 0.4, 0.62) };
export function boulder(seed, ore = null) {
  const M = new Mesh(), r = mulberry(seed), grey = hsl(34, 0.06 + r() * 0.05, 0.4 + r() * 0.08);
  M.blob(0, 0.45, 0, 0.8, { seed, jitter: 0.32, sx: 1.1, sy: 0.72, sz: 0.95, color: grey, vary: 0.14, top: 0.18, flat: true });
  if (ore) for (let k = 0; k < 4; k++) {
    const a = r() * 6.28, y = 0.35 + r() * 0.35;
    M.blob(Math.cos(a) * 0.72, y, Math.sin(a) * 0.62, 0.2, { seed: seed + k, color: ORES[ore], flat: true, sy: 0.7, vary: 0.2, top: 0.3 });
  }
  return M.geometry();
}

export function pebble(seed) {
  const M = new Mesh(), r = mulberry(seed);
  M.blob(0, 0.08, 0, 0.18, { seed, jitter: 0.3, sy: 0.55, color: hsl(35, 0.06, 0.45 + r() * 0.1), flat: true });
  return M.geometry();
}

function blade(M, a, lean, h, w, base, tip) {
  const ca = Math.cos(a), sa = Math.sin(a), px = -sa * w, pz = ca * w;
  M.tri([-px, 0, -pz], [px, 0, pz], [ca * lean, h, sa * lean], base, base, tip);
}
export function reeds(seed) {
  const M = new Mesh(), r = mulberry(seed), g = hsl(70, 0.38, 0.3);
  for (let k = 0; k < 9; k++) {
    const a = r() * 6.28, h = 1.1 + r() * 0.9;
    M.push(new THREE.Matrix4().makeTranslation((r() - 0.5) * 0.6, 0, (r() - 0.5) * 0.6));
    blade(M, a, 0.25 + r() * 0.3, h, 0.06, shade(g, 0.8), shade(g, 1.25));
    if (k % 3 === 0) M.limb([0, h * 0.72, 0], [0, h * 0.95, 0], 0.06, 0.05, 4, hsl(24, 0.5, 0.22));
    M.pop();
  }
  return M.geometry();
}

export function fern(seed) {
  const M = new Mesh(), r = mulberry(seed), g = hsl(104, 0.46, 0.27);
  for (let k = 0; k < 6; k++) {
    const a = (k / 6) * 6.28 + r() * 0.5, ca = Math.cos(a), sa = Math.sin(a), l = 0.5 + r() * 0.2, w = 0.11;
    M.quad([0, 0.05, 0], [ca * l * 0.5 - sa * w, 0.45, sa * l * 0.5 + ca * w], [ca * l, 0.3, sa * l], [ca * l * 0.5 + sa * w, 0.45, sa * l * 0.5 - ca * w], shade(g, 0.8), g, shade(g, 1.2), g);
  }
  return M.geometry();
}

export function tuft(seed) {
  const M = new Mesh(), r = mulberry(seed), g = hsl(84, 0.44, 0.32);
  for (let k = 0; k < 5; k++) blade(M, r() * 6.28, 0.12 + r() * 0.2, 0.35 + r() * 0.3, 0.05, shade(g, 0.75), shade(g, 1.3));
  return M.geometry();
}

export const PETALS = [hsl(0, 0.75, 0.5), hsl(50, 0.9, 0.55), hsl(0, 0, 0.92), hsl(280, 0.5, 0.55), hsl(215, 0.6, 0.6), hsl(25, 0.9, 0.55)];
export function flower(seed, color) {
  const M = new Mesh(), r = mulberry(seed);
  for (let k = 0; k < 3; k++) {
    const x = (r() - 0.5) * 0.5, z = (r() - 0.5) * 0.5, h = 0.25 + r() * 0.2, s = 0.09;
    M.push(new THREE.Matrix4().makeTranslation(x, 0, z));
    blade(M, r() * 6.28, 0.02, h, 0.025, hsl(100, 0.5, 0.25), hsl(100, 0.5, 0.32));
    M.quad([-s, h, -s], [-s, h, s], [s, h, s], [s, h, -s], color, color, shade(color, 1.15), color);
    M.quad([0, h - s, 0], [0, h + s * 0.6, s * 1.2], [0, h + s * 1.2, 0], [0, h + s * 0.6, -s * 1.2], shade(color, 0.9));
    M.pop();
  }
  return M.geometry();
}

export function mushroom(seed) {
  const M = new Mesh(), r = mulberry(seed);
  for (let k = 0; k < 3; k++) {
    const x = (r() - 0.5) * 0.4, z = (r() - 0.5) * 0.4, h = 0.12 + r() * 0.1;
    M.at(x, 0, z);
    M.prism(0.03, 0.03, h, 4, hsl(40, 0.2, 0.8), hsl(40, 0.2, 0.8), { caps: false });
    M.cone(0.1, 0.08, 6, hsl(18, 0.55, 0.36), hsl(24, 0.5, 0.5), { y0: h, under: hsl(40, 0.3, 0.7) });
    M.pop();
  }
  return M.geometry();
}

export function fallenLog(len) {
  const M = new Mesh();
  M.push(new THREE.Matrix4().makeRotationZ(Math.PI / 2)).push(new THREE.Matrix4().makeTranslation(0.24, -len / 2, 0));
  M.prism(0.26, 0.24, len, 6, BARK, BARK, { top: WOOD, bottom: WOOD });
  return M.pop().pop().geometry();
}

// ---------- the camp ----------
export function tent(size, trim) {
  const M = new Mesh(), L = size * 1.25, Wd = size * 0.95, Ht = size * 0.72, hl = L / 2, hw = Wd / 2;
  const canvas = hsl(40, 0.32, 0.62), inner = hsl(28, 0.3, 0.1), pole = hsl(28, 0.42, 0.3);
  const R0 = [0, Ht, -hl], R1 = [0, Ht, hl], L0 = [-hw, 0, -hl], L1 = [-hw, 0, hl], Q0 = [hw, 0, -hl], Q1 = [hw, 0, hl];
  // canvas above a colored trim band along the bottom of each side
  const band = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
  M.quad(band(L0, R0, 0.18), band(L1, R1, 0.18), R1, R0, shade(canvas, 0.95), shade(canvas, 0.95), canvas, canvas);
  M.quad(band(Q1, R1, 0.18), band(Q0, R0, 0.18), R0, R1, shade(canvas, 0.95), shade(canvas, 0.95), canvas, canvas);
  M.quad(L0, L1, band(L1, R1, 0.18), band(L0, R0, 0.18), trim);
  M.quad(Q1, Q0, band(Q0, R0, 0.18), band(Q1, R1, 0.18), trim);
  M.tri(Q0, L0, R0, shade(canvas, 0.9));
  // front: dark doorway with the flaps tied back
  const d = 0.55, D0 = [-hw * d, 0, hl], D1 = [hw * d, 0, hl], DT = [0, Ht * 0.86, hl];
  M.tri(L1, D0, R1, canvas); M.tri(D1, Q1, R1, canvas); M.tri(D0, D1, R1, inner);
  M.tri(D0, [-hw * 0.95, 0.05, hl + 0.35], DT, shade(canvas, 1.1)); M.tri([hw * 0.95, 0.05, hl + 0.35], D1, DT, shade(canvas, 1.1));
  for (const z of [-hl - 0.05, hl + 0.05])
    for (const s of [-1, 1]) M.limb([s * hw * 0.55, 0, z], [-s * 0.35, Ht + 0.55, z], 0.06, 0.05, 4, pole);
  M.limb([0, Ht + 0.02, -hl - 0.3], [0, Ht + 0.02, hl + 0.3], 0.05, 0.05, 4, pole);
  return M.geometry();
}

function logAt(M, x, y, z, len, yaw = 0, r0 = 0.16) {
  M.at(x, y, z, yaw).push(new THREE.Matrix4().makeRotationZ(Math.PI / 2)).push(new THREE.Matrix4().makeTranslation(0, -len / 2, 0));
  M.prism(r0, r0 * 0.92, len, 6, BARK, BARK, { top: WOOD, bottom: WOOD, rot: 0.3 });
  M.pop().pop().pop();
}
export function woodpile() {
  const M = new Mesh();
  for (let row = 0; row < 3; row++) for (let k = 0; k < 4 - row; k++) logAt(M, 0, 0.16 + row * 0.28, (k - (3 - row) / 2) * 0.33, 1.7, 0, 0.16);
  logAt(M, 0.3, 0.14, 1.0, 1.4, 0.5, 0.14);
  // chopping block with an axe in it
  M.at(-1.4, 0, 0.3).prism(0.34, 0.32, 0.55, 7, BARK, WOOD, { top: WOOD }).pop();
  logAt(M, -1.4, 0.72, 0.3, 0.5, 1.2, 0.13);
  return M.geometry();
}

export function campfire() {
  const M = new Mesh(), F = new Mesh(), r = mulberry(5);
  for (let k = 0; k < 9; k++) {
    const a = (k / 9) * 6.28;
    M.push(new THREE.Matrix4().makeTranslation(Math.cos(a) * 0.85, 0, Math.sin(a) * 0.85)).blob(0, 0.1, 0, 0.2, { seed: k + 3, jitter: 0.3, sy: 0.7, color: hsl(30, 0.05, 0.42), flat: true }).pop();
  }
  for (let k = 0; k < 4; k++) {
    const a = (k / 4) * 6.28 + 0.4;
    M.limb([Math.cos(a) * 0.62, 0.05, Math.sin(a) * 0.62], [Math.cos(a) * 0.08, 0.55, Math.sin(a) * 0.08], 0.1, 0.08, 5, BARK, hsl(20, 0.5, 0.15));
  }
  M.blob(0, 0.03, 0, 0.45, { seed: 2, sy: 0.12, color: hsl(20, 0.3, 0.12), flat: true });
  // flame tongues: orange at the root, yellow at the tip; drawn unlit
  const tongue = (x, z, h, w, base, tip, rot) => {
    const B = [0, 1, 2, 3].map((k) => { const a = rot + (k / 4) * 6.28; return [x + Math.cos(a) * w, 0.2, z + Math.sin(a) * w]; }), T = [x * 0.6, 0.2 + h, z * 0.6];
    for (let k = 0; k < 4; k++) F.tri(B[(k + 1) % 4], B[k], T, base, base, tip);
  };
  tongue(0, 0, 1.45, 0.34, hsl(14, 0.95, 0.46), hsl(48, 1, 0.62), 0.2);
  for (let k = 0; k < 5; k++) {
    const a = (k / 5) * 6.28 + r(), d = 0.22;
    tongue(Math.cos(a) * d, Math.sin(a) * d, 0.7 + r() * 0.5, 0.2, hsl(8, 0.95, 0.42), hsl(36, 1, 0.55), r() * 3);
  }
  tongue(0.05, -0.05, 0.9, 0.16, hsl(42, 1, 0.58), hsl(56, 1, 0.8), 1);
  return { solid: M.geometry(), flame: F.geometry() };
}

export function fishingSpot(seed) {
  const M = new Mesh(), r = mulberry(seed), foam = hsl(200, 0.35, 0.86), soft = hsl(205, 0.4, 0.7);
  for (const [rad, n, col] of [[0.45, 8, foam], [0.95, 12, soft], [1.45, 14, soft]]) {
    for (let k = 0; k < n; k++) {
      if (r() < 0.3) continue;
      const a0 = (k / n) * 6.28, a1 = ((k + 0.7) / n) * 6.28, w = 0.09;
      const p = (a, rr) => [Math.cos(a) * rr, 0.06, Math.sin(a) * rr];
      M.quad(p(a0, rad - w), p(a1, rad - w), p(a1, rad + w), p(a0, rad + w), col);
    }
  }
  for (let k = 0; k < 5; k++) {
    const a = r() * 6.28, d = r() * 0.6;
    M.at(Math.cos(a) * d, 0.2 + r() * 0.4, Math.sin(a) * d).box(0.12, 0.12, 0.12, foam).pop();
  }
  return M.geometry();
}

// ---------- people ----------
// Boxy players: legs, torso, arms and a head, posed by a few joint angles. Facing +z.
export function person(look, pose = "stand") {
  const M = new Mesh(), { shirt, legs, skin, hair, boots = hsl(25, 0.35, 0.16), belt = hsl(28, 0.3, 0.14), beard = false } = look;
  const hip = pose === "sit" ? 0.42 : pose === "crouch" ? 0.55 : 0.92;
  const leg = (s) => {
    M.at(s * 0.13, hip, 0);
    if (pose === "sit") {
      M.push(new THREE.Matrix4().makeRotationX(-Math.PI / 2.1));
      M.box(0.2, 0.46, 0.22, legs, legs, 0, -0.23, 0);
      M.pop();
      M.box(0.19, 0.42, 0.21, legs, legs, 0, -0.21, 0.46).box(0.2, 0.12, 0.3, boots, boots, 0, -0.36, 0.52);
    } else if (pose === "crouch") {
      M.push(new THREE.Matrix4().makeRotationX(s > 0 ? -1.2 : -0.3));
      M.box(0.2, 0.46, 0.22, legs, legs, 0, -0.23, 0);
      M.pop();
      const kz = s > 0 ? 0.43 : 0.13, ky = s > 0 ? -0.17 : -0.44;
      M.push(new THREE.Matrix4().makeTranslation(0, ky, kz)).push(new THREE.Matrix4().makeRotationX(s > 0 ? 0.3 : 1.25));
      M.box(0.19, 0.42, 0.21, legs, legs, 0, -0.21, 0).box(0.2, 0.1, 0.3, boots, boots, 0, -0.4, 0.05);
      M.pop().pop();
    } else {
      const swing = pose === "chop" ? s * 0.18 : pose === "talk" ? s * 0.06 : 0;
      M.push(new THREE.Matrix4().makeRotationX(swing));
      M.taper(0.18, 0.2, 0.22, 0.24, hip - 0.1, legs, legs, 0, -(hip - 0.1) + 0, 0);
      M.box(0.21, 0.12, 0.32, boots, boots, 0, -hip + 0.06, 0.04);
      M.pop();
    }
    M.pop();
  };
  leg(-1); leg(1);
  const lean = pose === "chop" ? 0.18 : pose === "crouch" ? 0.35 : 0;
  M.at(0, hip, 0).push(new THREE.Matrix4().makeRotationX(lean));
  M.taper(0.44, 0.26, 0.6, 0.3, 0.68, shirt, shade(shirt, 1.08), 0, 0, 0);
  M.box(0.46, 0.08, 0.28, belt, belt, 0, 0.06, 0);
  M.box(0.14, 0.08, 0.14, skin, skin, 0, 0.72, 0);
  // head: skin block, hair cap and back, optional beard
  M.at(0, 0.95, 0.01);
  M.box(0.34, 0.38, 0.34, skin, skin);
  M.box(0.37, 0.11, 0.37, hair, shade(hair, 1.1), 0, 0.19, -0.01).box(0.37, 0.3, 0.09, hair, hair, 0, 0.04, -0.17);
  M.box(0.06, 0.06, 0.04, shade(skin, 0.85), skin, 0, -0.01, 0.19);
  M.box(0.05, 0.04, 0.02, hsl(0, 0, 0.08), hsl(0, 0, 0.08), -0.08, 0.05, 0.175).box(0.05, 0.04, 0.02, hsl(0, 0, 0.08), hsl(0, 0, 0.08), 0.08, 0.05, 0.175);
  if (beard) M.box(0.32, 0.13, 0.07, hair, hair, 0, -0.15, 0.15);
  M.pop();
  const arm = (s, ax, az) => {
    M.at(s * 0.32, 0.62, 0).push(new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(ax, 0, az)));
    M.box(0.15, 0.36, 0.17, shirt, shirt, 0, -0.16, 0);
    M.box(0.13, 0.3, 0.14, skin, skin, 0, -0.47, 0);
    M.box(0.13, 0.1, 0.13, shade(skin, 0.9), skin, 0, -0.66, 0.01);
    M.pop().pop();
  };
  if (pose === "chop") {
    arm(-1, -2.5, -0.15); arm(1, -2.5, 0.15);
    // axe swung up over the shoulder from both hands
    M.limb([0, 1.1, 0.38], [0, 1.85, -0.05], 0.035, 0.035, 4, hsl(30, 0.45, 0.36));
    M.at(0, 1.78, 0.0).push(new THREE.Matrix4().makeRotationX(-0.52));
    M.box(0.07, 0.24, 0.32, hsl(30, 0.06, 0.55), hsl(30, 0.06, 0.75), 0, 0, 0.12);
    M.pop().pop();
  } else if (pose === "sit") { arm(-1, -0.9, 0.05); arm(1, -0.9, -0.05); }
  else if (pose === "crouch") {
    arm(-1, -0.4, 0.1); arm(1, -1.3, -0.1);
    M.at(0.3, 0.42, 0.6).push(new THREE.Matrix4().makeRotationX(1.1));
    M.box(0.035, 1.0, 0.035, hsl(30, 0.4, 0.3), hsl(30, 0.4, 0.3), 0, 0.5, 0);
    M.box(0.1, 0.18, 0.06, hsl(10, 0.45, 0.62), hsl(10, 0.45, 0.7), 0, 1.02, 0);
    M.pop().pop();
  } else if (pose === "talk") { arm(-1, 0.05, 0.12); arm(1, -1.5, -0.25); }
  else { arm(-1, 0.05, 0.1); arm(1, -0.05, -0.1); }
  M.pop().pop();
  return M.geometry();
}
