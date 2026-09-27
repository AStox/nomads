// Everything that stands on the board, modeled the way an animator would roll it: balls pressed into canopies,
// rolled snakes for trunks, grass and limbs, cones pinched into pine tiers, sheets for tents. Geometry is in meters
// at real size with vertex colors; `aTint` marks the parts an instance color should tint.
import * as THREE from "three";
import { mergeGeometries, mergeVertices } from "three/addons/utils/BufferGeometryUtils.js";
import { CLAY } from "./clay.js";

const V = (x, y, z) => new THREE.Vector3(x, y, z);

function h3(x, y, z) {
  let h = (x * 374761393 + y * 668265263 + z * 1440662683) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
// Smooth 3D value noise, about -1..1.
export function noise3(x, y, z) {
  const i = Math.floor(x), j = Math.floor(y), k = Math.floor(z);
  let u = x - i, v = y - j, w = z - k;
  u = u * u * (3 - 2 * u); v = v * v * (3 - 2 * v); w = w * w * (3 - 2 * w);
  const l = (a, b, t) => a + (b - a) * t;
  const c = (di, dj, dk) => h3(i + di, j + dj, k + dk) * 2 - 1;
  return l(l(l(c(0, 0, 0), c(1, 0, 0), u), l(c(0, 1, 0), c(1, 1, 0), u), v), l(l(c(0, 0, 1), c(1, 0, 1), u), l(c(0, 1, 1), c(1, 1, 1), u), v), w);
}

export function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => { s = (s + 0x6d2b79f5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// Keep position and normal only, welded, so parts merge and shade smooth.
function clean(g) {
  for (const k of Object.keys(g.attributes)) if (k !== "position") g.deleteAttribute(k);
  g = mergeVertices(g, 1e-5);
  g.computeVertexNormals();
  return g;
}

// Hand-rolled irregularity: a slow wobble along the normals, a few thumb presses, and pinches (two presses side by
// side that squeeze a little ridge up between them).
export function knead(g, { amp = 0.06, freq = 2.2, seed = 1, dents = 0, dentR = 0.35, dentD = 0.08, pinches = 0, flatBase = null } = {}) {
  const p = g.attributes.position, n = g.attributes.normal, r = rng(seed * 7919 + 13), s = seed * 17.31;
  const dent = [], dir = () => { const a = r() * Math.PI * 2, e = (r() - 0.3) * 1.2; return V(Math.cos(a) * Math.cos(e), Math.sin(e), Math.sin(a) * Math.cos(e)); };
  for (let k = 0; k < dents; k++) dent.push([dir(), dentR, dentD]);
  for (let k = 0; k < pinches; k++) {
    const t = dir(), b = new THREE.Vector3().crossVectors(t, dir()).normalize();
    for (const sgn of [-1, 1]) dent.push([t.clone().addScaledVector(b, sgn * 0.22).normalize(), 0.22, 0.11]);
  }
  const nd = dent.length;
  g.computeBoundingSphere();
  const R = g.boundingSphere.radius, C = g.boundingSphere.center;
  const q = new THREE.Vector3(), d = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    q.fromBufferAttribute(p, i);
    const nx = n.getX(i), ny = n.getY(i), nz = n.getZ(i);
    let off = amp * R * (noise3(q.x / R * freq + s, q.y / R * freq, q.z / R * freq - s) * 0.75 + 0.25 * noise3(q.x / R * freq * 2.7 - s, q.y / R * freq * 2.7 + 3, q.z / R * freq * 2.7));
    if (nd) {
      d.copy(q).sub(C).normalize();
      for (const [t, dr, dd] of dent) { const x = 1 - d.dot(t); off -= dd * R * Math.exp(-(x * x) / (dr * dr * 0.25)); }
    }
    q.x += nx * off; q.y += ny * off; q.z += nz * off;
    if (flatBase !== null && q.y < flatBase) q.y = flatBase + (q.y - flatBase) * 0.15;
    p.setXYZ(i, q.x, q.y, q.z);
  }
  g.computeVertexNormals();
  return g;
}

export function ball(detail = 2, seed = 1, opts = {}) {
  return knead(clean(new THREE.IcosahedronGeometry(1, detail)), { seed, ...opts });
}

// A rolled snake along a smooth curve through `pts`, tapering r0 to r1, with round ends.
export function snake(pts, r0, r1 = r0, { radial = 7, seg = 0, wobble = 0.08, seed = 1, caps = true, capRings: cr = 3 } = {}) {
  const curve = new THREE.CatmullRomCurve3(pts);
  const n = seg || Math.max(4, pts.length * 3), frames = curve.computeFrenetFrames(n, false);
  const pos = [], idx = [], ring = (c, T, N, B, r) => {
    const base = pos.length / 3;
    for (let j = 0; j < radial; j++) {
      const a = (j / radial) * Math.PI * 2, cs = Math.cos(a), sn = Math.sin(a);
      pos.push(c.x + (N.x * cs + B.x * sn) * r, c.y + (N.y * cs + B.y * sn) * r, c.z + (N.z * cs + B.z * sn) * r);
    }
    return base;
  };
  const rings = [], rr = rng(seed);
  const radius = (t) => (r0 + (r1 - r0) * t) * (1 + wobble * Math.sin(t * 9 + rr() * 6) * 0.5);
  const capRings = caps ? cr : 0;
  const T0 = frames.tangents[0], Tn = frames.tangents[n];
  const start = curve.getPointAt(0), end = curve.getPointAt(1);
  for (let k = capRings; k >= 1; k--) {
    const ph = (k / (capRings + 1)) * Math.PI * 0.5, r = radius(0);
    rings.push(ring(start.clone().addScaledVector(T0, -Math.sin(ph) * r), T0, frames.normals[0], frames.binormals[0], Math.cos(ph) * r));
  }
  for (let i = 0; i <= n; i++) rings.push(ring(curve.getPointAt(i / n), frames.tangents[i], frames.normals[i], frames.binormals[i], radius(i / n)));
  for (let k = 1; k <= capRings; k++) {
    const ph = (k / (capRings + 1)) * Math.PI * 0.5, r = radius(1);
    rings.push(ring(end.clone().addScaledVector(Tn, Math.sin(ph) * r), Tn, frames.normals[n], frames.binormals[n], Math.cos(ph) * r));
  }
  for (let i = 0; i < rings.length - 1; i++)
    for (let j = 0; j < radial; j++) {
      const a = rings[i] + j, b = rings[i] + ((j + 1) % radial), c = rings[i + 1] + j, d = rings[i + 1] + ((j + 1) % radial);
      idx.push(a, c, b, b, c, d);
    }
  if (caps) {
    const p0 = start.clone().addScaledVector(T0, -radius(0)), p1 = end.clone().addScaledVector(Tn, radius(1));
    const i0 = pos.length / 3; pos.push(p0.x, p0.y, p0.z);
    const i1 = pos.length / 3; pos.push(p1.x, p1.y, p1.z);
    const f = rings[0], l = rings[rings.length - 1];
    for (let j = 0; j < radial; j++) {
      idx.push(i0, f + j, f + ((j + 1) % radial));
      idx.push(i1, l + ((j + 1) % radial), l + j);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

export function lathe(profile, segs = 12) {
  return clean(new THREE.LatheGeometry(profile.map(([x, y]) => new THREE.Vector2(x, y)), segs));
}

// Merge parts ({ g, c: hex or null for tinted white, m: Matrix4, f: (p, n) => shade }) into one geometry with color
// and aTint; `f` darkens vertices, for the creases where pressed balls meet.
export function assemble(parts) {
  const gs = parts.map(({ g, c = null, m = null, f = null }) => {
    const x = g.clone();
    if (m) x.applyMatrix4(m);
    // An already assembled part keeps its own colors unless a color is given.
    const own = !c && x.attributes.color, col = new THREE.Color(c ?? "#ffffff"), n = x.attributes.position.count;
    const ca = own ? Float32Array.from(x.attributes.color.array) : new Float32Array(n * 3), p = new THREE.Vector3(), q = new THREE.Vector3();
    const ta = own && x.attributes.aTint ? Float32Array.from(x.attributes.aTint.array) : new Float32Array(n).fill(c ? 0 : 1);
    for (let i = 0; i < n; i++) {
      if (!own) col.toArray(ca, i * 3);
      if (f) {
        const k = f(p.fromBufferAttribute(x.attributes.position, i), q.fromBufferAttribute(x.attributes.normal, i));
        ca[i * 3] *= k; ca[i * 3 + 1] *= k; ca[i * 3 + 2] *= k;
      }
    }
    x.setAttribute("color", new THREE.BufferAttribute(ca, 3));
    x.setAttribute("aTint", new THREE.BufferAttribute(ta, 1));
    for (const k of Object.keys(x.attributes)) if (!["position", "normal", "color", "aTint"].includes(k)) x.deleteAttribute(k);
    return x.index ? x : mergeVertices(x);
  });
  return mergeGeometries(gs, false);
}

// Shade for a vertex of ball `i` among `balls` ([x, y, z, r]): dark where another ball presses close, and a little
// under the canopy.
function creases(balls, i, under = 0.25) {
  return (p, n) => {
    let k = 1;
    balls.forEach(([x, y, z, r], j) => {
      if (j === i) return;
      const d = Math.hypot(p.x - x, p.y - y, p.z - z) - r;
      if (d < r * 0.45) k *= 0.55 + 0.45 * smoothstep(-r * 0.05, r * 0.45, d);
    });
    return k * (1 - under + under * smoothstep(-0.7, 0.5, n.y));
  };
}
const smoothstep = (a, b, v) => { const t = Math.max(0, Math.min(1, (v - a) / (b - a))); return t * t * (3 - 2 * t); };

export const M = (x = 0, y = 0, z = 0, sx = 1, sy = sx, sz = sx, ry = 0, rx = 0, rz = 0) =>
  new THREE.Matrix4().compose(V(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz, "YXZ")), V(sx, sy, sz));

// ---------------------------------------------------------------------------------------------------------------
// Trees, unit height (the instance scales by the tree's height). Canopies tint by instance; trunks are their own.

// A rolled trunk snake with a few roots pressed into the ground and, on broadleaves, two branch stubs into the canopy.
export function trunk(kind, seed) {
  const r = rng(seed), lean = (r() - 0.5) * 0.06, top = kind === "pine" ? 0.5 : kind === "aspen" ? 0.55 : 0.5;
  const w = kind === "aspen" ? 0.03 : kind === "pine" ? 0.038 : 0.048;
  const parts = [{ g: snake([V(0, -0.04, 0), V(lean * 0.3, top * 0.35, 0), V(lean, top * 0.7, lean * 0.4), V(lean * 1.3, top, lean * 0.6)], w * 1.4, w * 0.75, { radial: 8, seg: 7, seed, wobble: 0.16 }), f: (p) => 0.7 + 0.3 * smoothstep(0, 0.2, p.y) }];
  for (let k = 0; k < 3; k++) {
    const a = (k / 3) * 6.28 + r(), l = w * (2.2 + r());
    parts.push({ g: snake([V(0, w * 1.2, 0), V(Math.cos(a) * l * 0.6, w * 0.4, Math.sin(a) * l * 0.6), V(Math.cos(a) * l, -w * 0.2, Math.sin(a) * l)], w * 0.6, w * 0.35, { radial: 6, seg: 4 }), f: () => 0.72 });
  }
  if (kind === "oak" || kind === "ash")
    for (const s of [-1, 1]) parts.push({ g: snake([V(lean * 0.8, top * 0.62, 0), V(s * 0.1, top * 0.9, 0.03), V(s * 0.17, top * 1.12, 0.05)], w * 0.55, w * 0.35, { radial: 6, seg: 4 }) });
  return assemble(parts);
}

export function canopy(kind, seed, lod = 2) {
  const r = rng(seed * 31 + 7), d = lod, dd = Math.max(0, lod - 1);
  const parts = [], balls = [];
  const blob = (x, y, z, s, sy = s, det = d, k = {}) => {
    balls.push([x, y, z, (s + sy) / 2]);
    parts.push({ g: ball(det, seed * 13 + parts.length, { amp: 0.1, freq: 1.7, dents: lod > 1 ? 3 : 1, dentR: 0.5, dentD: 0.09, pinches: lod > 2 ? 1 + (parts.length % 2) : 0, ...k }), m: M(x, y, z, s, sy, s, r() * 6.28) });
  };
  if (kind === "oak") {
    blob(0, 0.64, 0, 0.3, 0.27);
    const k = 3 + Math.floor(r() * 2);
    for (let i = 0; i < k; i++) { const a = (i / k) * 6.28 + r(), rr = 0.19 + r() * 0.06; blob(Math.cos(a) * 0.22, 0.54 + r() * 0.1, Math.sin(a) * 0.22, rr, rr * 0.9, dd); }
    blob((r() - 0.5) * 0.08, 0.86, (r() - 0.5) * 0.08, 0.19, 0.17, dd);
  } else if (kind === "ash") {
    blob(0, 0.52, 0, 0.23, 0.2, dd);
    blob((r() - 0.5) * 0.07, 0.7, (r() - 0.5) * 0.07, 0.25, 0.22);
    blob((r() - 0.5) * 0.06, 0.88, (r() - 0.5) * 0.06, 0.17, 0.16, dd);
    blob(0.15 * (r() < 0.5 ? 1 : -1), 0.62, 0.1, 0.14, 0.13, dd);
  } else if (kind === "aspen") {
    // A teardrop pinched to a point at the top.
    const prof = [[0, 0.36], [0.1, 0.38], [0.165, 0.46], [0.18, 0.56], [0.165, 0.68], [0.12, 0.82], [0.06, 0.94], [0.015, 1.0], [0, 1.01]];
    parts.push({ g: knead(lathe(prof, lod > 1 ? 12 : 8), { amp: 0.07, freq: 2, seed, dents: lod > 1 ? 3 : 1, dentR: 0.5, dentD: 0.07 }), m: M(0, 0, 0, 1, 1, 1, r() * 6.28), f: (p, n) => 0.75 + 0.25 * smoothstep(-0.7, 0.5, n.y) });
  } else {
    // Pine: three cones stacked, each with a rolled lip where it was pinched off.
    const tiers = [[0.2, 0.62, 0.29], [0.44, 0.84, 0.22], [0.65, 1.02, 0.15]];
    for (const [yb, yt, R] of tiers) {
      const hgt = yt - yb, prof = [[0, yb + hgt * 0.1], [R * 0.7, yb + hgt * 0.02], [R * 0.98, yb], [R * 1.06, yb + hgt * 0.06], [R * 0.86, yb + hgt * 0.2], [R * 0.55, yb + hgt * 0.5], [R * 0.25, yb + hgt * 0.8], [R * 0.06, yb + hgt * 0.98], [0, yt]];
      parts.push({ g: knead(lathe(prof, lod > 1 ? 11 : 7), { amp: 0.07, freq: 2.4, seed: seed + yb * 100, dents: lod > 1 ? 2 : 0, dentR: 0.5, dentD: 0.05 }), m: M((r() - 0.5) * 0.03, 0, (r() - 0.5) * 0.03, 1, 1, 1, r() * 6.28), f: (p, n) => (p.y < yb + hgt * 0.15 ? 0.6 : 1) * (0.8 + 0.2 * smoothstep(-0.7, 0.5, n.y)) });
    }
  }
  balls.forEach((b, i) => { parts[i].f = creases(balls, i); });
  return assemble(parts);
}

// A low clay lump: two or three balls pressed together, flat underneath.
export function lump(seed, lod = 1, n = 3) {
  const r = rng(seed), parts = [], balls = [];
  for (let i = 0; i < n; i++) {
    const a = r() * 6.28, d = i ? 0.35 + r() * 0.2 : 0, s = i ? 0.55 + r() * 0.2 : 0.8;
    balls.push([Math.cos(a) * d, s * 0.45, Math.sin(a) * d, s * 0.9]);
    parts.push({ g: ball(lod, seed * 5 + i, { amp: 0.1, flatBase: -0.1, dents: 1, dentD: 0.08 }), m: M(Math.cos(a) * d, s * 0.45, Math.sin(a) * d, s, s * 0.8, s) });
  }
  balls.forEach((b, i) => { parts[i].f = creases(balls, i, 0.3); });
  return assemble(parts);
}

export function pebble(seed, lod = 1) {
  return assemble([{ g: ball(lod, seed, { amp: 0.16, freq: 1.3, flatBase: -0.35, dents: 1, dentR: 0.6, dentD: 0.1 }), m: M(0, 0.3, 0, 1, 0.62, 0.85) }]);
}

// A grass tuft of fat rolled clay snakes curling out from one foot, unit height.
export function tuft(seed, blades = 4, lite = false) {
  const r = rng(seed), parts = [];
  for (let i = 0; i < blades; i++) {
    const a = (i / blades) * 6.28 + r() * 0.8, lean = 0.2 + r() * 0.3, hgt = 0.6 + r() * 0.4, ox = Math.cos(a) * 0.05, oz = Math.sin(a) * 0.05;
    const pts = [V(ox, -0.02, oz), V(ox + Math.cos(a) * lean * 0.2, hgt * 0.45, oz + Math.sin(a) * lean * 0.2), V(ox + Math.cos(a) * lean * 0.7, hgt * 0.85, oz + Math.sin(a) * lean * 0.7), V(ox + Math.cos(a) * lean * 1.2, hgt * 0.92, oz + Math.sin(a) * lean * 1.2)];
    parts.push({ g: snake(pts, 0.1, 0.06, lite ? { radial: 4, seg: 3, capRings: 1, seed: seed + i } : { radial: 6, seg: 5, capRings: 2, wobble: 0.12, seed: seed + i }), f: (p) => 0.62 + 0.38 * smoothstep(0, 0.5, p.y) });
  }
  return assemble(parts);
}

// Clover dots: a few flattened clay beads pressed into the meadow.
export function dots(seed, n = 4) {
  const r = rng(seed), parts = [];
  for (let i = 0; i < n; i++) {
    const a = r() * 6.28, d = i ? 0.25 + r() * 0.35 : 0, s = 0.16 + r() * 0.1;
    parts.push({ g: ball(1, seed * 3 + i, { amp: 0.12 }), m: M(Math.cos(a) * d, s * 0.35, Math.sin(a) * d, s, s * 0.6, s) });
  }
  return assemble(parts);
}

// A clay flower: a green stalk, a yellow bead in the middle and five petal dots that take the instance color.
export function flower(seed) {
  const r = rng(seed), parts = [], lean = (r() - 0.5) * 0.2, top = V(lean, 1, 0);
  parts.push({ g: snake([V(0, -0.02, 0), V(lean * 0.3, 0.5, 0), top], 0.05, 0.04, { radial: 5, seg: 4 }), c: "#4f8a2c" });
  parts.push({ g: snake([V(0, 0.2, 0), V(0.12, 0.3, 0.05), V(0.2, 0.28, 0.08)], 0.045, 0.03, { radial: 5, seg: 3 }), c: "#5a962f" });
  parts.push({ g: ball(1, seed), c: "#f3c83a", m: M(top.x, top.y + 0.04, top.z, 0.09, 0.07, 0.09) });
  for (let k = 0; k < 5; k++) {
    const a = (k / 5) * 6.28 + r();
    parts.push({ g: ball(1, seed + k + 3, { amp: 0.1 }), m: M(top.x + Math.cos(a) * 0.14, top.y + 0.01, top.z + Math.sin(a) * 0.14, 0.1, 0.06, 0.1) });
  }
  return assemble(parts);
}

// Reeds: stiff olive snakes, some with a brown cattail head.
export function reeds(seed) {
  const r = rng(seed), parts = [];
  for (let i = 0; i < 6; i++) {
    const a = r() * 6.28, d = r() * 0.25, x = Math.cos(a) * d, z = Math.sin(a) * d, hgt = 0.6 + r() * 0.45, lean = (r() - 0.5) * 0.25;
    parts.push({ g: snake([V(x, -0.02, z), V(x + lean * 0.3, hgt * 0.5, z), V(x + lean, hgt, z + lean * 0.3)], 0.025, 0.018, { radial: 5, seg: 4 }), c: i % 3 ? "#7d8a3c" : "#95994a" });
    if (i % 2 === 0) parts.push({ g: snake([V(x + lean * 0.85, hgt * 0.8, z + lean * 0.25), V(x + lean * 0.97, hgt * 0.95, z + lean * 0.29)], 0.045, 0.045, { radial: 6, seg: 3 }), c: "#6a4526" });
  }
  return assemble(parts);
}

// ---------------------------------------------------------------------------------------------------------------
// The camp.

// A ridge tent: two rolled sheets hung off a ridge pole, sagging between the poles, pinched to the ground along the
// bottom, with seams, a door flap folded back, poles poking out and guy lines to pegs. Front is +z.
export function ridgeTent(size, color, seed) {
  const r = rng(seed), L = size * 1.05, Hh = size * 0.62, W = size * 0.52, T = size * 0.035, parts = [];
  const nu = 18, nv = 10;
  const surf = (side, u, v, t) => {
    // u along the ridge 0..1 (z), v down the slope 0..1, t through the sheet -1..1
    const z = (u - 0.5) * L, sag = Math.sin(Math.PI * u) * 0.05 * size * Math.sin(Math.PI * v * 0.9);
    const bottomFlare = v * v * 0.06 * size;
    const x = side * (v * W + bottomFlare) - side * sag * 0.6;
    const y = Hh * (1 - v) - sag * 0.4 + (v > 0.94 ? -0.02 * size : 0);
    const pinch = v > 0.9 ? Math.cos(u * Math.PI * 12) * 0.012 * size * (v - 0.9) * 10 : 0;
    const ny = W, nx = Hh * side, nl = Math.hypot(nx, ny);
    return V(x + (nx / nl) * t * T * 0.5 + side * pinch, y + (ny / nl) * t * T * 0.5, z);
  };
  for (const side of [-1, 1]) {
    const pos = [], idx = [];
    for (const t of [1, -1])
      for (let j = 0; j <= nv; j++)
        for (let i = 0; i <= nu; i++) { const p = surf(side, i / nu, j / nv, t); pos.push(p.x, p.y, p.z); }
    const g0 = (t, i, j) => t * (nu + 1) * (nv + 1) + j * (nu + 1) + i;
    for (let j = 0; j < nv; j++)
      for (let i = 0; i < nu; i++) {
        const a = g0(0, i, j), b = g0(0, i + 1, j), c = g0(0, i, j + 1), d = g0(0, i + 1, j + 1);
        if (side > 0) idx.push(a, b, c, b, d, c); else idx.push(a, c, b, b, c, d);
        const a2 = g0(1, i, j), b2 = g0(1, i + 1, j), c2 = g0(1, i, j + 1), d2 = g0(1, i + 1, j + 1);
        if (side > 0) idx.push(a2, c2, b2, b2, c2, d2); else idx.push(a2, b2, c2, b2, d2, c2);
      }
    // Close the edges of the sheet.
    const edge = (list) => { for (let k = 0; k < list.length - 1; k++) { const [i0, j0] = list[k], [i1, j1] = list[k + 1]; const a = g0(0, i0, j0), b = g0(0, i1, j1), c = g0(1, i0, j0), d = g0(1, i1, j1); if (side > 0) idx.push(a, c, b, b, c, d); else idx.push(a, b, c, b, d, c); } };
    const e1 = [], e2 = [], e3 = [], e4 = [];
    for (let i = 0; i <= nu; i++) { e1.push([i, nv]); e2.push([nu - i, 0]); }
    for (let j = 0; j <= nv; j++) { e3.push([0, nv - j]); e4.push([nu, j]); }
    edge(e1); edge(e2); edge(e3); edge(e4);
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    parts.push({ g, c: color });
    // A seam rolled down the middle of each sheet.
    const seam = [0.33, 0.66].map((u) => [0, 0.3, 0.6, 0.97].map((v) => surf(side, u, v, 1.2)));
    for (const s of seam) parts.push({ g: snake(s, T * 0.3, T * 0.3, { radial: 5, seg: 8 }), c: shade(color, 0.82) });
  }
  // Ridge roll, door, flap and poles.
  parts.push({ g: snake([V(0, Hh + T * 0.2, -L / 2 - T), V(0, Hh + T * 0.1 - 0.03 * size, 0), V(0, Hh + T * 0.2, L / 2 + T)], T * 0.6, T * 0.6, { radial: 6, seg: 10 }), c: shade(color, 0.85) });
  const door = new THREE.ShapeGeometry(new THREE.Shape([new THREE.Vector2(-W * 0.62, 0), new THREE.Vector2(W * 0.62, 0), new THREE.Vector2(0, Hh * 0.9)]));
  parts.push({ g: door, c: "#2a1c14", m: M(0, 0.01, L / 2 - T * 0.2) });
  parts.push({ g: door.clone(), c: "#2a1c14", m: M(0, 0.01, -L / 2 + T * 0.2, 1, 1, 1, Math.PI) });
  const flap = [V(W * 0.05, Hh * 0.92, L / 2 + T), V(W * 0.45, Hh * 0.55, L / 2 + T * 3), V(W * 0.7, Hh * 0.18, L / 2 + T * 2), V(W * 0.8, 0.02 * size, L / 2 + T * 0.5)];
  parts.push({ g: snake(flap, T * 2.2, T * 3.2, { radial: 6, seg: 8, wobble: 0.2 }), c: shade(color, 1.08), m: M(0, 0, 0, 1, 1, 1) });
  for (const z of [-L / 2 - T * 1.5, L / 2 + T * 1.5]) {
    parts.push({ g: snake([V(0, -0.05, z), V(0.01, Hh * 0.6, z), V(0, Hh + 0.12 * size, z)], 0.028 * size, 0.022 * size, { radial: 6, seg: 5 }), c: CLAY.wood });
    const peg = V(0, 0, z + Math.sign(z) * size * 0.55);
    parts.push({ g: snake([V(0, Hh + 0.06 * size, z), peg.clone().add(V(0, 0.03, 0))], 0.008 * size, 0.008 * size, { radial: 4, seg: 4, caps: false }), c: "#d8cfb4" });
    parts.push({ g: ball(1, seed + z), c: CLAY.wood, m: M(peg.x, peg.y + 0.02, peg.z, 0.05 * size, 0.07 * size, 0.05 * size) });
  }
  for (const s of [-1, 1]) for (const u of [0.15, 0.85]) {
    const p = V(s * (W + 0.1 * size), 0.02, (u - 0.5) * L);
    parts.push({ g: ball(1, seed + u * 10 + s), c: CLAY.wood, m: M(p.x, p.y, p.z, 0.045 * size, 0.06 * size, 0.045 * size) });
  }
  return assemble(parts);
}

// A hide tepee: a cone of rolled sheet with poles crossed at the top, a painted band of rolled snakes and a door.
export function tepee(size, color, band, seed) {
  const r = rng(seed), R = size * 0.55, Hh = size * 1.2, parts = [];
  const prof = [[0.001, 0], [R * 0.97, 0], [R * 1.03, 0.03 * size], [R * 0.99, 0.06 * size], [R * 0.72, Hh * 0.3], [R * 0.42, Hh * 0.6], [R * 0.16, Hh * 0.86], [R * 0.08, Hh * 0.93], [0.001, Hh * 0.95]];
  parts.push({ g: knead(lathe(prof, 20), { amp: 0.02, freq: 3, seed }), c: color });
  // Seams from the top down, the way hides were joined.
  for (let k = 0; k < 6; k++) {
    const a = (k / 6) * 6.28 + 0.3, rim = (t) => V(Math.cos(a) * R * (1 - t * 0.92) * 1.01, Hh * 0.95 * t, Math.sin(a) * R * (1 - t * 0.92) * 1.01);
    parts.push({ g: snake([rim(0.02), rim(0.3), rim(0.6), rim(0.88)], 0.012 * size, 0.01 * size, { radial: 4, seg: 8 }), c: shade(color, 0.8) });
  }
  for (const [t, c, th] of [[0.25, band, 0.022], [0.31, "#f0e4c8", 0.012], [0.19, "#f0e4c8", 0.012]]) {
    const rr = R * (1 - t * 0.92) * 1.02 + 0.01 * size, pts = [];
    for (let k = 0; k <= 24; k++) { const a = (k / 24) * 6.28; pts.push(V(Math.cos(a) * rr, Hh * 0.95 * t + (c === band ? Math.sin(a * 9) * 0.035 * size : 0), Math.sin(a) * rr)); }
    parts.push({ g: snake(pts, th * size, th * size, { radial: 5, seg: 72, caps: false }), c });
  }
  for (let k = 0; k < 5; k++) {
    const a = (k / 5) * 6.28 + r() * 0.3;
    parts.push({ g: snake([V(Math.cos(a) * R * 0.08, Hh * 0.9, Math.sin(a) * R * 0.08), V(-Math.cos(a) * R * 0.2, Hh * 1.18, -Math.sin(a) * R * 0.2)], 0.022 * size, 0.018 * size, { radial: 5, seg: 3 }), c: CLAY.wood });
  }
  const door = new THREE.ShapeGeometry(new THREE.Shape([new THREE.Vector2(-R * 0.28, 0), new THREE.Vector2(R * 0.28, 0), new THREE.Vector2(R * 0.18, Hh * 0.3), new THREE.Vector2(0, Hh * 0.36), new THREE.Vector2(-R * 0.18, Hh * 0.3)]));
  const tilt = Math.atan2(R, Hh * 0.95);
  parts.push({ g: door, c: "#2a1c14", m: M(0, 0.02, R * 0.985, 1, 1, 1, 0, -tilt) });
  return assemble(parts);
}

// A chunky figure in the Aardman manner: a pear of a body in its clothing color, stubby limbs, mitten hands, a
// big head with a blob nose, a wide smile, bead eyes and a lump of hair. Faces +z, about 1.55 m tall.
export function person(cloth, skin, hair, seed, pose = 0) {
  const r = rng(seed), parts = [], beads = [];
  const trousers = shade(cloth, 0.55, -0.1), boots = "#3a2718";
  for (const s of [-1, 1]) {
    parts.push({ g: ball(2, seed + s, { amp: 0.05 }), c: boots, m: M(s * 0.12, 0.06, 0.05, 0.1, 0.07, 0.15) });
    parts.push({ g: snake([V(s * 0.12, 0.08, 0), V(s * 0.12, 0.3, 0.01), V(s * 0.12, 0.5, 0)], 0.085, 0.09, { radial: 7, seg: 4 }), c: trousers });
  }
  // Body: a pear rolled in the clothing color with a tunic hem and a belt.
  const body = [[0.001, 0.42], [0.22, 0.44], [0.27, 0.52], [0.28, 0.66], [0.26, 0.82], [0.22, 0.95], [0.14, 1.03], [0.001, 1.06]];
  parts.push({ g: knead(lathe(body, 16), { amp: 0.03, freq: 2.5, seed, dents: 3, dentR: 0.35, dentD: 0.03 }), c: cloth });
  parts.push({ g: snake(ringPts(0.285, 0.44, 20), 0.035, 0.035, { radial: 6, seg: 40, caps: false }), c: shade(cloth, 0.8) });
  parts.push({ g: snake(ringPts(0.285, 0.62, 20), 0.03, 0.03, { radial: 6, seg: 40, caps: false }), c: "#5a3a22" });
  parts.push({ g: ball(1, seed + 9), c: "#c9a04a", m: M(0, 0.62, 0.29, 0.045, 0.04, 0.025) });
  // Arms: snakes from the shoulders; pose 0 hands to the fire, 1 one hand raised, 2 arms folded down.
  for (const s of [-1, 1]) {
    const sh = V(s * 0.24, 0.93, 0);
    const hand = pose === 0 ? V(s * 0.2, 0.78, 0.42) : pose === 1 && s > 0 ? V(0.42, 1.2, 0.18) : V(s * 0.34, 0.55, 0.1);
    const elbow = pose === 0 ? V(s * 0.34, 0.76, 0.18) : pose === 1 && s > 0 ? V(0.42, 0.92, 0.06) : V(s * 0.36, 0.72, 0.02);
    parts.push({ g: snake([sh, elbow, hand], 0.07, 0.06, { radial: 7, seg: 6 }), c: cloth });
    parts.push({ g: ball(2, seed + s * 3, { amp: 0.06 }), c: skin, m: M(hand.x, hand.y, hand.z, 0.075, 0.07, 0.075) });
  }
  // Head.
  const hy = 1.3, hr = 0.25;
  parts.push({ g: ball(3, seed + 21, { amp: 0.025, freq: 2 }), c: skin, m: M(0, hy, 0, hr, hr * 0.96, hr * 0.95) });
  parts.push({ g: ball(2, seed + 22, { amp: 0.06 }), c: shade(skin, 0.95), m: M(0, hy - 0.01, hr * 0.95, 0.085, 0.075, 0.08) });
  for (const s of [-1, 1]) parts.push({ g: ball(1, seed + 23 + s), c: skin, m: M(s * hr * 0.97, hy, 0, 0.05, 0.07, 0.04) });
  // A wide smile pressed in as a dark snake, with cheeks.
  const mouth = [];
  for (let k = 0; k <= 6; k++) { const a = -0.75 + (k / 6) * 1.5; mouth.push(V(Math.sin(a) * hr * 0.85, hy - 0.1 - Math.cos(a * 1.3) * 0.03, Math.cos(a) * hr * 0.86)); }
  parts.push({ g: snake(mouth, 0.013, 0.013, { radial: 5, seg: 10 }), c: "#4a1d18" });
  for (const s of [-1, 1]) parts.push({ g: ball(1, seed + 30 + s), c: shade(skin, 1.0, 0.1), m: M(s * 0.14, hy - 0.05, hr * 0.8, 0.06, 0.05, 0.04) });
  // Eyes: white beads with black pupils, and brows.
  for (const s of [-1, 1]) {
    const e = V(s * 0.085, hy + 0.06, hr * 0.86);
    beads.push({ g: ball(2, seed + 40 + s, { amp: 0.01 }), c: "#f4efe4", m: M(e.x, e.y, e.z, 0.055, 0.065, 0.04) });
    beads.push({ g: ball(2, seed + 42 + s, { amp: 0.01 }), c: "#15100e", m: M(e.x + s * 0.004, e.y - 0.005, e.z + 0.035, 0.028, 0.032, 0.02) });
    parts.push({ g: snake([V(e.x - s * 0.04, e.y + 0.07, e.z - 0.005), V(e.x + s * 0.01, e.y + 0.085 + (pose === 1 ? 0.015 : 0), e.z + 0.005), V(e.x + s * 0.05, e.y + 0.075, e.z - 0.01)], 0.012, 0.01, { radial: 4, seg: 4 }), c: shade(hair, 0.8) });
  }
  // Hair or a knitted hat.
  if (r() < 0.4) {
    parts.push({ g: knead(lathe([[0.001, 0.2], [0.2, 0.18], [0.26, 0.06], [0.265, 0], [0.24, -0.02], [0.001, -0.02]], 16), { amp: 0.03, seed }), c: shade(cloth, 1.1, 0.15), m: M(0, hy + 0.1, -0.01, 1, 1, 1, 0, -0.2) });
    parts.push({ g: ball(2, seed + 50), c: "#efe6d2", m: M(0, hy + 0.34, -0.06, 0.07) });
  } else {
    parts.push({ g: ball(2, seed + 51, { amp: 0.12, freq: 3.5 }), c: hair, m: M(0, hy + 0.08, -0.04, hr * 1.06, hr * 0.85, hr * 1.02, 0, -0.35) });
    for (let k = 0; k < 4; k++) { const a = -0.9 + k * 0.6; parts.push({ g: ball(1, seed + 52 + k), c: hair, m: M(Math.sin(a) * hr * 0.7, hy + 0.2, Math.cos(a) * hr * 0.55, 0.07, 0.05, 0.06) }); }
  }
  return { body: assemble(parts), beads: assemble(beads) };
}

function ringPts(rad, y, n) { const p = []; for (let k = 0; k <= n; k++) { const a = (k / n) * 6.28318; p.push(V(Math.cos(a) * rad, y, Math.sin(a) * rad)); } return p; }

// A log: a bark snake with pale cut ends and a dark heart.
export function log(len, rad, seed, bark = CLAY.wood) {
  const r = rng(seed), bend = (r() - 0.5) * 0.08 * len, parts = [];
  parts.push({ g: snake([V(-len / 2, 0, 0), V(0, bend * 0.4, bend), V(len / 2, 0, 0)], rad, rad * 0.92, { radial: 8, seg: 6, caps: false, wobble: 0.1 }), c: bark });
  for (const s of [-1, 1]) {
    const e = new THREE.CircleGeometry(rad * 0.98, 10);
    parts.push({ g: e, c: CLAY.woodEnd, m: M(s * len / 2, 0, 0, 1, 1, 1, s * Math.PI / 2) });
    const ring = [];
    for (let k = 0; k <= 12; k++) { const a = (k / 12) * 6.28; ring.push(V(s * (len / 2 + 0.002), Math.cos(a) * rad * 0.55, Math.sin(a) * rad * 0.55)); }
    parts.push({ g: snake(ring, rad * 0.05, rad * 0.05, { radial: 4, seg: 24, caps: false }), c: "#b58a55" });
    parts.push({ g: ball(1, seed + s), c: "#8a6238", m: M(s * len / 2, 0, 0, rad * 0.06, rad * 0.14, rad * 0.14) });
  }
  return assemble(parts);
}

// The fire: a ring of stones, crossed logs and flames pinched up in three colors; flames glow (emissive).
export function fire(seed) {
  const r = rng(seed), stones = [], wood = [], flames = [];
  for (let k = 0; k < 11; k++) {
    const a = (k / 11) * 6.28 + r() * 0.2, s = 0.13 + r() * 0.06;
    stones.push({ g: ball(2, seed + k, { amp: 0.14, flatBase: -0.3 }), c: CLAY.stone[k % 4], m: M(Math.cos(a) * 0.62, s * 0.4, Math.sin(a) * 0.62, s, s * 0.7, s * 0.9, r() * 6) });
  }
  for (let k = 0; k < 5; k++) {
    const a = (k / 5) * 6.28 + 0.3;
    wood.push({ g: log(0.9, 0.06, seed + k * 3, "#5e3d24"), m: M(Math.cos(a) * 0.18, 0.2, Math.sin(a) * 0.18, 1, 1, 1, -a, 0, 0.62) });
  }
  wood.push({ g: ball(2, seed + 70, { amp: 0.2, flatBase: -0.2 }), c: CLAY.char, m: M(0, 0.02, 0, 0.42, 0.12, 0.42) });
  const drop = (x, z, h, w, c, ry) => {
    const prof = [[0.001, 0], [w * 0.8, h * 0.05], [w, h * 0.22], [w * 0.8, h * 0.45], [w * 0.45, h * 0.7], [w * 0.14, h * 0.92], [0.001, h]];
    flames.push({ g: knead(lathe(prof, 12), { amp: 0.08, freq: 2.2, seed: seed + flames.length }), c, m: M(x, 0.12, z, 1, 1, 0.8, ry, (r() - 0.5) * 0.3, (r() - 0.5) * 0.3) });
  };
  for (let k = 0; k < 5; k++) { const a = (k / 5) * 6.28 + r(); drop(Math.cos(a) * 0.2, Math.sin(a) * 0.2, 0.55 + r() * 0.2, 0.15, CLAY.flame[0], a); }
  for (let k = 0; k < 3; k++) { const a = (k / 3) * 6.28 + r(); drop(Math.cos(a) * 0.1, Math.sin(a) * 0.1, 0.75 + r() * 0.15, 0.13, CLAY.flame[1], a); }
  drop(0, 0, 0.95, 0.12, CLAY.flame[2], 0);
  for (let k = 0; k < 9; k++) { const a = r() * 6.28, d = 0.2 + r() * 0.2; flames.push({ g: ball(1, seed + 90 + k), c: CLAY.ember, m: M(Math.cos(a) * d, 0.07, Math.sin(a) * d, 0.035 + r() * 0.03) }); }
  return { stones: assemble([...stones, ...wood]), flames: assemble(flames) };
}

// Smoke as the animators do it: pale puffs rolled from cotton-soft clay, rising and drifting.
export function smoke(seed, drift) {
  const r = rng(seed), parts = [];
  for (let k = 0; k < 7; k++) {
    const t = k / 6, s = 0.2 + t * 0.3, a = t * 7 + seed, x = drift.x * t * t * 1.8 + Math.cos(a) * 0.1 * t, z = drift.z * t * t * 1.8 + Math.sin(a) * 0.1 * t, y = 1.8 + t * 1.9;
    parts.push({ g: ball(2, seed + k, { amp: 0.22, freq: 2.2, dents: 2, dentD: 0.12 }), c: shade("#a39c95", 1.02 - t * 0.1), m: M(x, y, z, s, s * 0.8, s * 0.95, r() * 6) });
    parts.push({ g: ball(1, seed + k + 40, { amp: 0.2 }), c: shade("#958e87", 1 - t * 0.1), m: M(x + s * 0.7, y - s * 0.2, z - s * 0.3, s * 0.62) });
  }
  return assemble(parts);
}
// A woodpile: logs stacked in a pyramid, a chopping stump with an axe in it.
export function woodpile(seed) {
  const r = rng(seed), parts = [];
  const rows = [[4, 0.13], [3, 0.35], [2, 0.57], [1, 0.79]];
  for (const [n, y] of rows)
    for (let k = 0; k < n; k++) parts.push({ g: log(1.5 + r() * 0.2, 0.12 + r() * 0.02, seed + y * 100 + k), m: M(0, y, (k - (n - 1) / 2) * 0.25, 1, 1, 1, (r() - 0.5) * 0.08) });
  const sx = 1.35;
  parts.push({ g: log(0.45, 0.24, seed + 7, "#6b4528"), m: M(sx, 0.225, 0.2, 1, 1, 1, 0, 0, Math.PI / 2) });
  parts.push({ g: snake([V(sx - 0.05, 0.48, 0.18), V(sx + 0.2, 0.75, 0.2), V(sx + 0.36, 0.98, 0.22)], 0.03, 0.027, { radial: 6, seg: 5 }), c: "#b07a45" });
  parts.push({ g: knead(clean(new THREE.BoxGeometry(0.2, 0.12, 0.05, 3, 2, 1)), { amp: 0.05, seed }), c: "#7d8288", m: M(sx - 0.07, 0.47, 0.18, 1, 1, 1, 0, 0, -0.75) });
  for (let k = 0; k < 7; k++) { const a = r() * 6.28, d = 0.5 + r() * 0.9; parts.push({ g: ball(1, seed + 80 + k, { amp: 0.2 }), c: CLAY.woodEnd, m: M(Math.cos(a) * d + 0.5, 0.02, Math.sin(a) * d, 0.08 + r() * 0.05, 0.02, 0.05) }); }
  return assemble(parts);
}

// A color darkened or lightened and warmed (w > 0) or cooled.
export function shade(hex, k, w = 0) {
  const c = new THREE.Color(hex), hsl = {};
  c.getHSL(hsl);
  c.setHSL((hsl.h + w * 0.05 + 1) % 1, Math.min(1, hsl.s * (1 + Math.abs(w) * 0.5)), Math.min(1, hsl.l * k));
  return "#" + c.getHexString();
}
