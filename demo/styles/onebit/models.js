// Low-poly, flat-faceted models built from triangles. Every triangle carries a gray albedo, a class (for the dither
// and outline passes), a tint mask (how much the instance tint varies it) and a baked occlusion.
import * as THREE from "three";
import { hash } from "../world.js";

export const VEG = 2, OBJ = 3, FIRE = 5;
const TAU = Math.PI * 2;

export class Kit {
  constructor() { this.p = []; this.alb = []; this.cls = []; this.mask = []; this.ao = []; this.occ = null; }
  tri(a, b, c, alb, cls, mask = 0) {
    this.p.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
    const o = this.occ ? this.occ((a[1] + b[1] + c[1]) / 3) : 1;
    for (let k = 0; k < 3; k++) { this.alb.push(alb); this.cls.push(cls); this.mask.push(mask); this.ao.push(o); }
  }
  quad(a, b, c, d, alb, cls, mask) { this.tri(a, b, c, alb, cls, mask); this.tri(a, c, d, alb, cls, mask); }
  geometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(this.p, 3));
    g.setAttribute("aAlb", new THREE.Float32BufferAttribute(this.alb, 1));
    g.setAttribute("aCls", new THREE.Float32BufferAttribute(this.cls, 1));
    g.setAttribute("aMask", new THREE.Float32BufferAttribute(this.mask, 1));
    g.setAttribute("aAO", new THREE.Float32BufferAttribute(this.ao, 1));
    return g;
  }
}

const ring = (x, y, z, rx, rz, n, a0) => Array.from({ length: n }, (_, k) => { const a = a0 + (k * TAU) / n; return [x + rx * Math.sin(a), y, z + rz * Math.cos(a)]; });

export function cone(K, { x = 0, z = 0, y0, r, rz = r, top, tx = 0, tz = 0, n, a0 = 0, alb, cls, mask = 0, cap = true, capAlb = alb }) {
  const b = ring(x, y0, z, r, rz, n, a0), apex = [x + tx, top, z + tz], c = [x, y0, z];
  for (let k = 0; k < n; k++) {
    K.tri(b[k], b[(k + 1) % n], apex, alb, cls, mask);
    if (cap) K.tri(b[(k + 1) % n], b[k], c, capAlb, cls, mask);
  }
}

export function frustum(K, { x = 0, z = 0, y0, r0, y1, r1, sz = 1, n, a0 = 0, alb, cls, mask = 0, caps = true, capAlb = alb }) {
  const b = ring(x, y0, z, r0, r0 * sz, n, a0), t = ring(x, y1, z, r1, r1 * sz, n, a0);
  for (let k = 0; k < n; k++) {
    const j = (k + 1) % n;
    K.quad(b[k], b[j], t[j], t[k], alb, cls, mask);
    if (caps) { K.tri(t[k], t[j], [x, y1, z], capAlb, cls, mask); K.tri(b[j], b[k], [x, y0, z], capAlb, cls, mask); }
  }
}

// A prism between two arbitrary points.
export function tube(K, p0, p1, r, n, alb, cls, { mask = 0, capAlb = alb, r1 = r, a0 = 0 } = {}) {
  const ax = new THREE.Vector3(p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]).normalize();
  const u = new THREE.Vector3().crossVectors(ax, Math.abs(ax.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0)).normalize();
  const v = new THREE.Vector3().crossVectors(ax, u);
  const at = (p, rr, k) => { const a = a0 + (k * TAU) / n, c = Math.cos(a) * rr, s = Math.sin(a) * rr; return [p[0] + u.x * c + v.x * s, p[1] + u.y * c + v.y * s, p[2] + u.z * c + v.z * s]; };
  for (let k = 0; k < n; k++) {
    const a = at(p0, r, k), b = at(p0, r, k + 1), c = at(p1, r1, k + 1), d = at(p1, r1, k);
    K.quad(a, b, c, d, alb, cls, mask);
    K.tri(d, c, p1, capAlb, cls, mask);
    K.tri(b, a, p0, capAlb, cls, mask);
  }
}

// A jittered polyhedron: the faceted clump every crown, bush, stone and smoke puff is made of.
export function blob(K, [cx, cy, cz], [rx, ry, rz], seed, jitter, alb, cls, { mask = 0, detail = 0, shape = "ico", flatBottom = -Infinity } = {}) {
  const g = shape === "dodeca" ? new THREE.DodecahedronGeometry(1, detail) : shape === "octa" ? new THREE.OctahedronGeometry(1, detail) : new THREE.IcosahedronGeometry(1, detail);
  const pos = g.attributes.position, pts = [];
  for (let i = 0; i < pos.count; i++) {
    let x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const kx = Math.round(x * 1000), ky = Math.round(y * 1000), kz = Math.round(z * 1000);
    const f = 1 + jitter * (hash(kx + seed * 7919, ky, kz + 3) * 2 - 1);
    x *= f; y *= f; z *= f;
    x += jitter * 0.5 * (hash(kx, ky + seed * 131, kz) - 0.5);
    z += jitter * 0.5 * (hash(kz, kx, ky + seed * 17) - 0.5);
    pts.push([cx + x * rx, Math.max(cy + y * ry, flatBottom), cz + z * rz]);
  }
  for (let i = 0; i < pts.length; i += 3) K.tri(pts[i], pts[i + 1], pts[i + 2], alb, cls, mask);
  g.dispose();
}

// ---------- trees, all one unit tall; instances scale them by their height ----------

export function pine(lod, v = 0) {
  const K = new Kit();
  K.occ = (y) => 0.55 + 0.45 * Math.min(1, y);
  if (lod === 2) {
    cone(K, { y0: 0.12, r: 0.22, top: 1, n: 4, a0: v, alb: 0.3, cls: VEG, mask: 1 });
    return K.geometry();
  }
  if (lod === 0) frustum(K, { y0: -0.08, r0: 0.032, y1: 0.34, r1: 0.02, n: 5, alb: 0.2, cls: VEG });
  const tiers = lod === 0
    ? [[0.15, 0.27, 0.47], [0.31, 0.23, 0.62], [0.46, 0.18, 0.76], [0.6, 0.13, 0.88], [0.74, 0.08, 1.0]]
    : [[0.16, 0.26, 0.6], [0.44, 0.18, 0.82], [0.66, 0.1, 1.0]];
  tiers.forEach(([y0, r, top], k) => {
    const w = 1 + 0.12 * (hash(k, v * 13, 5) - 0.5);
    const lean = 0.02 * (hash(k, v, 9) - 0.5);
    cone(K, { y0, r: r * w, top, tx: lean, tz: lean * 0.6, n: lod === 0 ? 7 : 5, a0: k * 0.47 + v, alb: 0.3, cls: VEG, mask: 1, capAlb: 0.18 });
  });
  return K.geometry();
}

const CROWNS = {
  oak: { trunk: 0.4, r: 0.045, lobes: [[0, 0.66, 0, 0.36, 0.28, 0.36], [0.24, 0.52, 0.1, 0.22, 0.18, 0.22], [-0.22, 0.54, -0.12, 0.22, 0.18, 0.22], [0.05, 0.86, -0.06, 0.22, 0.15, 0.2], [-0.08, 0.56, 0.24, 0.2, 0.17, 0.2]], alb: 0.46, bark: 0.22 },
  ash: { trunk: 0.42, r: 0.036, lobes: [[0, 0.68, 0, 0.27, 0.3, 0.27], [0.16, 0.52, 0.06, 0.18, 0.17, 0.18], [-0.15, 0.56, -0.1, 0.18, 0.17, 0.18], [0.03, 0.9, 0.02, 0.17, 0.12, 0.17]], alb: 0.52, bark: 0.3 },
  aspen: { trunk: 0.4, r: 0.028, lobes: [[0, 0.48, 0, 0.17, 0.17, 0.17], [0.02, 0.66, -0.02, 0.18, 0.18, 0.18], [-0.01, 0.84, 0.01, 0.13, 0.15, 0.13]], alb: 0.6, bark: 0.78 },
};

export function broad(kind, lod, v = 0) {
  const K = new Kit(), c = CROWNS[kind];
  K.occ = (y) => 0.5 + 0.5 * Math.min(1, Math.max(0, (y - 0.3) / 0.6));
  if (lod === 2) {
    blob(K, [0, c.lobes[0][1], 0], [c.lobes[0][3] * 1.2, c.lobes[0][4] * 1.3, c.lobes[0][5] * 1.2], v + 3, 0.1, c.alb, VEG, { mask: 1, shape: "octa" });
    frustum(K, { y0: -0.05, r0: c.r * 1.2, y1: c.lobes[0][1] - 0.1, r1: c.r, n: 3, alb: c.bark, cls: VEG, caps: false });
    return K.geometry();
  }
  frustum(K, { y0: -0.08, r0: c.r, y1: c.trunk, r1: c.r * 0.65, n: lod === 0 ? 6 : 4, a0: v, alb: c.bark, cls: VEG });
  if (lod === 0) {
    tube(K, [0, c.trunk * 0.7, 0], [0.13, c.trunk + 0.12, 0.05], c.r * 0.45, 4, c.bark, VEG);
    tube(K, [0, c.trunk * 0.78, 0], [-0.12, c.trunk + 0.14, -0.07], c.r * 0.4, 4, c.bark, VEG);
  }
  const lobes = lod === 0 ? c.lobes : c.lobes.slice(0, 2);
  lobes.forEach(([x, y, z, rx, ry, rz], k) => {
    const s = lod === 0 ? 1 : 1.18;
    blob(K, [x, y, z], [rx * s, ry * s, rz * s], v * 31 + k, 0.2, c.alb * (1 - 0.05 * k), VEG, { mask: 1 });
  });
  return K.geometry();
}

export function shrub(heath, lod, v = 0) {
  const K = new Kit();
  K.occ = (y) => 0.55 + 0.45 * Math.min(1, y / 0.8);
  const alb = heath ? 0.3 : 0.42;
  if (heath) {
    blob(K, [0, 0.18, 0], [0.7, 0.3, 0.62], v, 0.25, alb, VEG, { mask: 1, flatBottom: 0 });
    if (lod === 0) blob(K, [0.35, 0.14, 0.2], [0.4, 0.22, 0.4], v + 5, 0.25, alb * 0.9, VEG, { mask: 1, flatBottom: 0 });
  } else {
    blob(K, [0, 0.42, 0], [0.5, 0.45, 0.5], v, 0.22, alb, VEG, { mask: 1, flatBottom: 0 });
    if (lod === 0) blob(K, [0.3, 0.3, -0.18], [0.32, 0.3, 0.32], v + 5, 0.22, alb * 1.08, VEG, { mask: 1, flatBottom: 0 });
  }
  return K.geometry();
}

export function rock(v = 0, detail = 0) {
  const K = new Kit();
  K.occ = (y) => 0.65 + 0.35 * Math.min(1, Math.max(0, y + 0.3));
  blob(K, [0, 0, 0], [1, 0.62, 0.85], v * 7 + 1, 0.3, 0.66, OBJ, { mask: 1, shape: "dodeca", detail });
  return K.geometry();
}

// ---------- the small stuff near the camera ----------

export const INK = 6;

// Near the eye, blades are drawn straight in ink, like hatching; further off they are lit like everything else.
export function grassTuft(v = 0, cls = VEG) {
  const K = new Kit();
  K.occ = (y) => 0.5 + 0.5 * y;
  const n = cls === INK ? 5 : 7;
  for (let k = 0; k < n; k++) {
    const a = (k / n) * TAU + hash(k, v, 1) * 0.8, r = 0.05 + 0.08 * hash(k, v, 2), h = 0.6 + 0.5 * hash(k, v, 3), lean = 0.12 + 0.3 * hash(k, v, 4), w = cls === INK ? 0.022 : 0.035;
    const bx = Math.cos(a) * r, bz = Math.sin(a) * r, px = -Math.sin(a) * w, pz = Math.cos(a) * w;
    K.tri([bx - px, 0, bz - pz], [bx + px, 0, bz + pz], [bx + Math.cos(a) * lean, h, bz + Math.sin(a) * lean], 0.55 + 0.1 * hash(k, v, 6), cls, 1);
  }
  return K.geometry();
}

export function reeds(v = 0) {
  const K = new Kit();
  K.occ = (y) => 0.5 + 0.5 * y;
  for (let k = 0; k < 9; k++) {
    const a = hash(k, v, 11) * TAU, r = 0.12 * hash(k, v, 12), h = 0.7 + 0.3 * hash(k, v, 13), lean = 0.04 + 0.12 * hash(k, v, 14), w = 0.018;
    const bx = Math.cos(a) * r, bz = Math.sin(a) * r, px = -Math.sin(a) * w, pz = Math.cos(a) * w;
    K.tri([bx - px, 0, bz - pz], [bx + px, 0, bz + pz], [bx + Math.cos(a) * lean, h, bz + Math.sin(a) * lean], 0.5, VEG, 1);
  }
  for (let k = 0; k < 3; k++) {
    const a = hash(k, v, 21) * TAU, x = Math.cos(a) * 0.06, z = Math.sin(a) * 0.06, h = 0.8 + 0.15 * hash(k, v, 22);
    tube(K, [x, 0, z], [x * 1.4, h - 0.12, z * 1.4], 0.006, 3, 0.45, VEG);
    tube(K, [x * 1.4, h - 0.12, z * 1.4], [x * 1.45, h, z * 1.45], 0.022, 5, 0.12, VEG);
  }
  return K.geometry();
}

export function flower(v = 0) {
  const K = new Kit();
  K.tri([-0.01, 0, 0], [0.01, 0, 0], [0, 0.9, 0.02], 0.45, VEG);
  for (let k = 0; k < 5; k++) {
    const a = (k / 5) * TAU + v;
    K.tri([0, 0.9, 0], [Math.cos(a) * 0.14, 0.93, Math.sin(a) * 0.14], [Math.cos(a + 0.6) * 0.14, 0.93, Math.sin(a + 0.6) * 0.14], 0.97, VEG);
  }
  return K.geometry();
}

// A fallen log one unit long along x and one unit thick; cut ends read pale.
export function log() {
  const K = new Kit();
  tube(K, [-0.5, 0, 0], [0.5, 0, 0], 0.5, 6, 0.3, OBJ, { capAlb: 0.85, a0: 0.3 });
  return K.geometry();
}

// ---------- the camp ----------

// One unit across; the door faces local +z.
export function tent(v = 0) {
  const K = new Kit();
  const n = 7, r = 0.56, top = 0.95, a0 = Math.PI / n;
  K.occ = (y) => 0.7 + 0.3 * y;
  cone(K, { y0: 0, r, top, n, a0, alb: 0.84, cls: OBJ, cap: false });
  // The door: a dark opening on the facet facing the fire, and its flap folded back.
  const f = Math.cos(a0) / Math.cos(a0 * 0.62), d0 = [Math.sin(-a0 * 0.62) * r * f, 0.001, Math.cos(-a0 * 0.62) * r * f];
  const d1 = [Math.sin(a0 * 0.62) * r * f, 0.001, Math.cos(a0 * 0.62) * r * f];
  const out = 0.01, dt = [0, 0.62, r * Math.cos(a0) * (1 - 0.62 / top)];
  const lift = (p) => [p[0], p[1], p[2] + out];
  K.tri(lift(d0), lift(d1), lift(dt), 0.03, OBJ);
  K.tri(lift(d1), [d1[0] + 0.12, 0.001, d1[2] + 0.12], lift(dt), 0.95, OBJ);
  // Poles crossing out of the smoke hole.
  tube(K, [0, top - 0.08, 0], [0.07, top + 0.16, 0.03], 0.012, 4, 0.18, OBJ);
  tube(K, [0, top - 0.08, 0], [-0.06, top + 0.14, -0.05], 0.012, 4, 0.18, OBJ);
  tube(K, [0, top - 0.08, 0], [0.01, top + 0.18, -0.08], 0.012, 4, 0.18, OBJ);
  // Stakes where the guy ropes land.
  for (let k = 0; k < n; k++) {
    const a = a0 + ((k + 0.5) * TAU) / n, R = r * 1.3;
    tube(K, [Math.sin(a) * R, -0.02, Math.cos(a) * R], [Math.sin(a) * R * 1.02, 0.06, Math.cos(a) * R * 1.02], 0.012, 3, 0.25, OBJ);
  }
  return K.geometry();
}

// The guy ropes of a tent, as line segments in tent units.
export function tentRopes() {
  const n = 7, r = 0.56, top = 0.95, a0 = Math.PI / n, seg = [];
  for (let k = 0; k < n; k++) {
    const a = a0 + ((k + 0.5) * TAU) / n, R = r * 1.3, t = 0.62;
    seg.push([Math.sin(a) * r * (1 - t) * 1.01, top * t, Math.cos(a) * r * (1 - t) * 1.01], [Math.sin(a) * R * 1.02, 0.06, Math.cos(a) * R * 1.02]);
  }
  return seg;
}

// A person, 1.7 m, in meters; standing or sitting by the fire.
export function person(cloth, pose = 0, v = 0) {
  const K = new Kit();
  const legs = 0.16, skin = 0.72, dark = 0.14;
  if (pose === 0) {
    for (const s of [-1, 1]) tube(K, [s * 0.1, 0, 0.02 * s], [s * 0.09, 0.56, 0], 0.075, 5, legs, OBJ);
    frustum(K, { y0: 0.4, r0: 0.33, y1: 1.4, r1: 0.25, sz: 0.74, n: 7, a0: 0.2, alb: cloth, cls: OBJ, capAlb: legs });
    frustum(K, { y0: 1.4, r0: 0.25, y1: 1.5, r1: 0.12, sz: 0.74, n: 7, a0: 0.2, alb: cloth * 0.85, cls: OBJ, caps: false });
    const swing = 0.06 + 0.12 * hash(v, 1, 2);
    for (const s of [-1, 1]) tube(K, [s * 0.27, 1.38, 0], [s * 0.34, 0.9, s * swing], 0.07, 5, cloth * 0.9, OBJ);
    blob(K, [0, 1.62, 0], [0.12, 0.14, 0.12], v + 40, 0.06, skin, OBJ);
    if (v % 3 === 0) {
      frustum(K, { y0: 1.68, r0: 0.3, y1: 1.7, r1: 0.3, n: 8, alb: dark, cls: OBJ });
      cone(K, { y0: 1.7, r: 0.15, top: 1.86, n: 6, alb: dark, cls: OBJ, capAlb: dark });
    } else if (v % 3 === 1) blob(K, [0, 1.64, -0.04], [0.15, 0.16, 0.15], v + 44, 0.08, cloth * 0.8, OBJ);
    if (v === 4) tube(K, [0.42, -0.05, 0.14], [0.44, 1.95, 0.1], 0.028, 4, 0.2, OBJ);
    if (v === 2) blob(K, [0, 1.12, -0.26], [0.22, 0.27, 0.13], v + 48, 0.1, 0.34, OBJ);
  } else {
    for (const s of [-1, 1]) {
      tube(K, [s * 0.11, 0.42, -0.05], [s * 0.13, 0.46, 0.4], 0.08, 5, legs, OBJ);
      tube(K, [s * 0.13, 0.46, 0.4], [s * 0.13, 0.02, 0.5], 0.07, 5, legs, OBJ);
    }
    frustum(K, { y0: 0.36, r0: 0.27, y1: 0.98, r1: 0.23, sz: 0.8, n: 7, alb: cloth, cls: OBJ });
    cone(K, { y0: 0.52, r: 0.38, rz: 0.32, top: 1.1, n: 7, a0: 0.3, alb: cloth * 0.75, cls: OBJ, cap: false });
    for (const s of [-1, 1]) tube(K, [s * 0.26, 0.92, 0.04], [s * 0.14, 0.72, 0.44], 0.065, 5, cloth * 0.9, OBJ);
    blob(K, [0, 1.15, 0.07], [0.12, 0.14, 0.12], v + 40, 0.06, skin, OBJ);
    // Something to sit on.
    tube(K, [-0.5, 0.2, -0.08], [0.5, 0.2, -0.08], 0.2, 6, 0.3, OBJ, { capAlb: 0.85 });
  }
  return K.geometry();
}

// Flames burn white; the rest is charred wood and a ring of stones.
export function fire() {
  const K = new Kit();
  cone(K, { y0: 0, r: 0.3, top: 1.25, tx: 0.05, n: 5, alb: 1, cls: FIRE, cap: false });
  cone(K, { x: 0.18, z: 0.1, y0: 0, r: 0.18, top: 0.85, tx: 0.04, n: 4, a0: 0.4, alb: 1, cls: FIRE, cap: false });
  cone(K, { x: -0.16, z: -0.08, y0: 0, r: 0.16, top: 0.75, tx: -0.05, n: 4, a0: 1.1, alb: 1, cls: FIRE, cap: false });
  cone(K, { x: 0.02, z: -0.2, y0: 0.2, r: 0.1, top: 1.55, tx: 0.1, n: 3, a0: 0.2, alb: 1, cls: FIRE, cap: false });
  for (let k = 0; k < 5; k++) {
    const a = (k / 5) * TAU + 0.3;
    tube(K, [Math.cos(a) * 0.62, 0.04, Math.sin(a) * 0.62], [Math.cos(a) * 0.05, 0.42, Math.sin(a) * 0.05], 0.06, 5, 0.12, OBJ, { capAlb: 0.5 });
  }
  for (let k = 0; k < 11; k++) {
    const a = (k / 11) * TAU;
    blob(K, [Math.cos(a) * 0.85, 0.02, Math.sin(a) * 0.85], [0.17, 0.12, 0.15], k + 70, 0.3, 0.38, OBJ, { shape: "dodeca" });
  }
  return K.geometry();
}

// Split logs stacked in a pyramid, 1.4 m long, with a chopping block.
export function woodpile() {
  const K = new Kit();
  const r = 0.1;
  for (let row = 0; row < 4; row++)
    for (let k = 0; k < 5 - row; k++) {
      const x = (k - (4 - row) / 2) * r * 2.05, y = r + row * r * 1.75;
      tube(K, [x, y, -0.7], [x + 0.02 * (hash(row, k, 1) - 0.5), y, 0.7], r, 5, 0.3, OBJ, { capAlb: 0.88, a0: hash(row, k, 2) });
    }
  frustum(K, { x: 0.95, z: 0.3, y0: 0, r0: 0.26, y1: 0.45, r1: 0.24, n: 7, alb: 0.34, cls: OBJ, capAlb: 0.86 });
  tube(K, [0.95, 0.46, 0.3], [1.3, 0.8, 0.42], 0.022, 4, 0.2, OBJ);
  return K.geometry();
}

// Smoke from the fire, drifting downwind, puff by puff.
export function smoke(wind) {
  const K = new Kit();
  const n = 56;
  for (let k = 0; k < n; k++) {
    const t = k / (n - 1), rise = 2.3 + t * 30, drift = t ** 1.7 * 18, r = 0.3 + t * 2.4, sway = Math.sin(t * 9) * 0.7 * t;
    blob(K, [wind[0] * drift - wind[1] * sway, rise, wind[1] * drift + wind[0] * sway], [r, r * 0.8, r], k + 90, 0.22, 0.45, OBJ, { detail: t > 0.5 ? 1 : 0 });
  }
  return K.geometry();
}
