// Contour sheets: marching squares on a height grid, loops smoothed and cut with a scissor wobble, then built into
// flat card geometry (tops, cut edges, and the spacer walls hidden under each overhang).
import * as THREE from "three";
import { noise } from "../world.js";

// Case table: [edgeA, edgeB, corner] per segment; edges 0 top, 1 right, 2 bottom, 3 left; corners 0 tl, 1 tr, 2 br, 3 bl.
// The corner fixes the direction so the region at or above the level is always on the left.
const CASES = [
  [], [[3, 2, 3]], [[2, 1, 2]], [[3, 1, 3]], [[0, 1, 1]], null, [[0, 2, 1]], [[3, 0, 0]],
  [[3, 0, 0]], [[0, 2, 0]], null, [[0, 1, 1]], [[3, 1, 0]], [[2, 1, 2]], [[3, 2, 3]], [],
];

// Closed loops of f >= level on a G x G grid; outside the grid counts as far below. Points in world [x, z].
export function trace(f, G, level, x0, z0, dx) {
  const P = G + 2, val = (i, j) => (i < 1 || j < 1 || i > G || j > G ? -1e9 : f[(j - 1) * G + (i - 1)]);
  const next = new Int32Array(2 * P * P).fill(-1), px = new Float32Array(2 * P * P), pz = new Float32Array(2 * P * P);
  const edgeId = (i, j, e) => (e === 0 ? 2 * (j * P + i) : e === 2 ? 2 * ((j + 1) * P + i) : e === 3 ? 2 * (j * P + i) + 1 : 2 * (j * P + i + 1) + 1);
  const corner = [[0, 0], [1, 0], [1, 1], [0, 1]];
  const ends = [[0, 1], [1, 2], [2, 3], [3, 0]];
  const wx = (i) => x0 + (i - 1) * dx, wz = (j) => z0 + (j - 1) * dx;
  for (let j = 0; j < P - 1; j++) {
    for (let i = 0; i < P - 1; i++) {
      const v = [val(i, j), val(i + 1, j), val(i + 1, j + 1), val(i, j + 1)];
      const code = (v[0] >= level ? 8 : 0) | (v[1] >= level ? 4 : 0) | (v[2] >= level ? 2 : 0) | (v[3] >= level ? 1 : 0);
      if (code === 0 || code === 15) continue;
      let segs = CASES[code];
      if (!segs) {
        const mid = (v[0] + v[1] + v[2] + v[3]) / 4 >= level;
        segs = code === 5 ? (mid ? [[3, 0, 0], [2, 1, 2]] : [[0, 1, 1], [3, 2, 3]]) : mid ? [[0, 1, 1], [3, 2, 3]] : [[3, 0, 0], [2, 1, 2]];
      }
      for (const [ea, eb, c] of segs) {
        const pts = [ea, eb].map((e) => {
          const [a, b] = ends[e], t = Math.min(1, Math.max(0, (level - v[a]) / (v[b] - v[a])));
          const cx = corner[a][0] + (corner[b][0] - corner[a][0]) * t, cz = corner[a][1] + (corner[b][1] - corner[a][1]) * t;
          return [wx(i + cx), wz(j + cz)];
        });
        const inside = v[c] >= level, ccx = wx(i + corner[c][0]), ccz = wz(j + corner[c][1]);
        const cross = (pts[1][0] - pts[0][0]) * (ccz - pts[0][1]) - (pts[1][1] - pts[0][1]) * (ccx - pts[0][0]);
        let a = edgeId(i, j, ea), b = edgeId(i, j, eb), pa = pts[0], pb = pts[1];
        if (cross > 0 !== inside) { [a, b] = [b, a]; [pa, pb] = [pb, pa]; }
        next[a] = b;
        px[a] = pa[0]; pz[a] = pa[1]; px[b] = pb[0]; pz[b] = pb[1];
      }
    }
  }
  const loops = [];
  for (let s = 0; s < next.length; s++) {
    if (next[s] < 0) continue;
    const loop = [];
    let e = s;
    while (e >= 0 && next[e] >= 0) {
      loop.push([px[e], pz[e]]);
      const n = next[e];
      next[e] = -1;
      e = n;
    }
    if (loop.length > 3) loops.push(loop);
  }
  return loops;
}

const area = (p) => { let a = 0; for (let i = 0, j = p.length - 1; i < p.length; j = i++) a += p[j][0] * p[i][1] - p[i][0] * p[j][1]; return a / 2; };

function resample(p, step) {
  const out = [], n = p.length;
  let carry = 0;
  for (let i = 0; i < n; i++) {
    const a = p[i], b = p[(i + 1) % n], len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    let t = carry;
    while (t < len) { out.push([a[0] + ((b[0] - a[0]) * t) / len, a[1] + ((b[1] - a[1]) * t) / len]); t += step; }
    carry = t - len;
  }
  return out.length > 3 ? out : p;
}

function relax(p, iters) {
  for (let k = 0; k < iters; k++) {
    const q = p.map((v, i) => { const a = p[(i + p.length - 1) % p.length], b = p[(i + 1) % p.length]; return [v[0] * 0.5 + (a[0] + b[0]) * 0.25, v[1] * 0.5 + (a[1] + b[1]) * 0.25]; });
    p = q;
  }
  return p;
}

// Smooth the grid staircase away, then cut it the way scissors do: a slow drift plus short straight snips.
export function cut(loop, { step, wobble, seed, scallop = 0 }) {
  let p = relax(resample(loop, step * 0.6), 4);
  p = resample(p, step);
  const n = p.length, out = [];
  let s = 0;
  for (let i = 0; i < n; i++) {
    const a = p[(i + n - 1) % n], b = p[(i + 1) % n];
    let tx = b[0] - a[0], tz = b[1] - a[1];
    const tl = Math.hypot(tx, tz) || 1;
    tx /= tl; tz /= tl;
    s += step;
    // Normal pointing out of the region (region is on the left of the direction of travel).
    const nx = tz, nz = -tx;
    let off = wobble * (noise(s / (step * 9), seed, 71) * 0.8 + noise(s / (step * 2.2), seed, 72) * 0.35);
    if (scallop) off += scallop * (Math.abs(Math.sin((s / (scallop * 5)) * Math.PI)) - 0.5);
    out.push([p[i][0] + nx * off, p[i][1] + nz * off]);
  }
  return out;
}

// Group loops into outer rings with their holes (outer loops run counterclockwise, positive area).
export function shapes(loops, minArea) {
  const outers = [], holes = [];
  for (const l of loops) {
    const a = area(l);
    if (Math.abs(a) < minArea) continue;
    const bb = bbox(l);
    (a > 0 ? outers : holes).push({ pts: l, area: Math.abs(a), bb, holes: [] });
  }
  outers.sort((a, b) => a.area - b.area);
  for (const h of holes) {
    const [x, z] = h.pts[0];
    const o = outers.find((o) => x >= o.bb[0] && x <= o.bb[2] && z >= o.bb[1] && z <= o.bb[3] && o.area > h.area && inside(o.pts, x, z));
    if (o) o.holes.push(h.pts);
  }
  return outers.map((o) => ({ outer: o.pts, holes: o.holes }));
}

function bbox(p) {
  let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
  for (const [x, z] of p) { a = Math.min(a, x); b = Math.min(b, z); c = Math.max(c, x); d = Math.max(d, z); }
  return [a, b, c, d];
}

export function inside(p, x, z) {
  let r = false;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
    const [xi, zi] = p[i], [xj, zj] = p[j];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) r = !r;
  }
  return r;
}

// Flat top faces at height y for a list of shapes; the layer index rides along for per-sheet tint.
export function tops(list, y, layer, out) {
  for (const s of list) {
    const contour = s.outer.map(([x, z]) => new THREE.Vector2(x, z));
    const holes = s.holes.map((h) => h.map(([x, z]) => new THREE.Vector2(x, z)));
    const tris = THREE.ShapeUtils.triangulateShape(contour, holes);
    const all = contour.concat(...holes);
    for (const [a, b, c] of tris) {
      const A = all[a], B = all[b], C = all[c];
      // Face up: in (x, z) the triangle must run clockwise seen from above (+y).
      const cr = (B.x - A.x) * (C.y - A.y) - (B.y - A.y) * (C.x - A.x);
      const order = cr > 0 ? [A, C, B] : [A, B, C];
      for (const v of order) out.pos.push(v.x, y, v.y), out.layer.push(layer);
    }
  }
}

// Vertical walls along every loop from y0 to y1, facing out of the region; inset moves the wall into the region.
export function walls(list, y0, y1, layer, out, inset = 0) {
  for (const s of list) {
    for (const loop of [s.outer, ...s.holes]) {
      let p = loop;
      if (inset) p = offset(loop, -inset);
      const n = p.length;
      let run = 0;
      for (let i = 0; i < n; i++) {
        const a = p[i], b = p[(i + 1) % n];
        const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1e-6, nx = (b[1] - a[1]) / len, nz = -(b[0] - a[0]) / len;
        const r0 = run, r1 = run + len;
        run = r1;
        // Two triangles, wound so the face normal points along (nx, nz).
        const q = [[a[0], y0, a[1], r0, 0], [b[0], y0, b[1], r1, 0], [b[0], y1, b[1], r1, 1], [a[0], y1, a[1], r0, 1]];
        for (const k of [0, 2, 1, 0, 3, 2]) {
          out.pos.push(q[k][0], q[k][1], q[k][2]);
          out.nrm.push(nx, 0, nz);
          out.uv.push(q[k][3], q[k][4]);
          out.layer.push(layer);
        }
      }
    }
  }
}

function offset(p, d) {
  const n = p.length;
  return p.map((v, i) => {
    const a = p[(i + n - 1) % n], b = p[(i + 1) % n];
    let tx = b[0] - a[0], tz = b[1] - a[1];
    const l = Math.hypot(tx, tz) || 1;
    return [v[0] + (tz / l) * d, v[1] - (tx / l) * d];
  });
}

export function geometry(out, withNormals) {
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(out.pos, 3));
  if (withNormals) {
    g.setAttribute("normal", new THREE.Float32BufferAttribute(out.nrm, 3));
    g.setAttribute("aWall", new THREE.Float32BufferAttribute(out.uv, 2));
  } else {
    const nrm = new Float32Array(out.pos.length);
    for (let i = 1; i < nrm.length; i += 3) nrm[i] = 1;
    g.setAttribute("normal", new THREE.BufferAttribute(nrm, 3));
  }
  g.setAttribute("aLayer", new THREE.Float32BufferAttribute(out.layer, 1));
  return g;
}
