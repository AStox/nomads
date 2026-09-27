// The ground as the old client builds it: a square tile grid, two triangles a tile, corner heights from the world,
// soft "underlay" colors blended across corners and hard-edged "overlay" tiles (paths, beach, rock, water) whose
// edges step in 45 degree half tiles where three corners agree.
import * as THREE from "three";
import { hash, fbm, clamp } from "../world.js";

export function hsl(h, s, l) {
  h = (((h % 360) + 360) % 360) / 360;
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
  const f = (t) => { t = (t + 1) % 1; return t < 1 / 6 ? p + (q - p) * 6 * t : t < 0.5 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p; };
  return [f(h + 1 / 3), f(h), f(h - 1 / 3)];
}
export const css = (c, k = 1) => `rgb(${c.map((v) => Math.round(clamp(v * k, 0, 1) * 255)).join(",")})`;

export const UNDER = {
  tree: hsl(96, 0.42, 0.22), shrub: hsl(80, 0.4, 0.29), grass: hsl(83, 0.47, 0.35),
  marsh: hsl(64, 0.34, 0.28), bare: hsl(38, 0.13, 0.38), sand: hsl(44, 0.4, 0.52),
};
const DRYGRASS = hsl(64, 0.45, 0.39);
export const OVER = { path: hsl(30, 0.34, 0.3), beach: hsl(43, 0.46, 0.6), rock: hsl(34, 0.07, 0.42), water: hsl(214, 0.45, 0.4) };
export const NONE = 0, PATH = 1, BEACH = 2, ROCK = 3, WATER = 4;
const OVERCOL = [null, OVER.path, OVER.beach, OVER.rock, OVER.water];

// Water level from the generator's coarse cells: the sea sits at 0, lakes at floor plus depth.
function levels(W) {
  const { isle, N } = W, L = new Float32Array(N * N).fill(-1e9);
  for (let k = 0; k < N * N; k++) if (isle.water[k] > 0) L[k] = isle.height[k] + isle.water[k];
  return (x, z) => {
    const cx = (x - W.START) / W.CELL, cy = (z - W.START) / W.CELL, i = Math.floor(cx), j = Math.floor(cy);
    let m = -1e9;
    for (const [a, b] of [[0, 0], [1, 0], [0, 1], [1, 1]]) m = Math.max(m, L[clamp(j + b, 0, N - 1) * N + clamp(i + a, 0, N - 1)]);
    return m;
  };
}

// Worn dirt: from the fire to each tent door, to the woodpile, and a wandering track down to the nearest shore.
export function campPaths(W) {
  const c = W.camp, f = c.fire, level = levels(W), segs = [];
  const wetAt = (x, z) => W.heightAt(x, z) < Math.max(0.2, level(x, z));
  for (const t of c.tents) {
    const d = Math.hypot(f.x - t.at.x, f.z - t.at.z), ux = (f.x - t.at.x) / d, uz = (f.z - t.at.z) / d;
    segs.push({ a: [f.x, f.z], b: [t.at.x + ux * t.size * 0.62, t.at.z + uz * t.size * 0.62], w: 0.72 });
  }
  segs.push({ a: [f.x, f.z], b: [c.woodpile.x, c.woodpile.z], w: 0.72 });
  let shore = null;
  for (let r = 10; r < 260 && !shore; r += 3)
    for (let k = 0; k < 72; k++) {
      const a = (k / 72) * Math.PI * 2, x = f.x + Math.cos(a) * r, z = f.z + Math.sin(a) * r;
      if (wetAt(x, z)) { shore = { x, z, a, r }; break; }
    }
  if (shore) {
    const n = Math.ceil(shore.r / 12), px = -Math.sin(shore.a), pz = Math.cos(shore.a);
    let prev = [f.x, f.z];
    for (let k = 1; k <= n; k++) {
      const t = k / n, wob = k === n ? 0 : fbm(t * 2.3, 0.5, 91, 2) * 5 * Math.sin(Math.PI * t);
      const p = [f.x + (shore.x - f.x) * t + px * wob, f.z + (shore.z - f.z) * t + pz * wob];
      segs.push({ a: prev, b: p, w: 1.02 });
      prev = p;
    }
  }
  const dist = (x, z, s) => {
    const [ax, az] = s.a, dx = s.b[0] - ax, dz = s.b[1] - az, t = clamp(((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz || 1), 0, 1);
    return Math.hypot(x - ax - dx * t, z - az - dz * t);
  };
  // Returns how far inside the worn ground a point is, in tile units (>0 inside), for a given tile size.
  const inside = (x, z, T) => {
    let best = 3.9 - Math.hypot(x - f.x, z - f.z);
    best = Math.max(best, 2.2 - Math.hypot(x - c.woodpile.x, z - c.woodpile.z));
    for (const s of segs) best = Math.max(best, Math.max(s.w * T, 1.1) - dist(x, z, s));
    return best;
  };
  return { segs, shore, inside, level };
}

export function buildGround(W, { focus, T, R, vex, paths }) {
  const n = 2 * R + 3, off = R + 1, ox = Math.round(focus.x / T) * T, oz = Math.round(focus.z / T) * T;
  const level = paths.level, idx = (i, j) => (j + off) * n + (i + off);
  const H = new Float32Array(n * n), type = new Uint8Array(n * n), shallow = new Float32Array(n * n), col = new Float32Array(n * n * 3);
  const X = (i) => ox + i * T, Z = (j) => oz + j * T;
  const cover = (k, x, z) => W.fine(W.cover[k], x, z);
  function classify(x, z, h, lv) {
    if (h < lv - 0.02) return WATER;
    // trodden ground fords a stream: where the data puts the camp on one, the campers stand on dirt
    if (paths.inside(x, z, T) > 0) return PATH;
    if (W.riverAt(x, z) > 0.5) return WATER;
    const cv = { tree: cover("tree", x, z), shrub: cover("shrub", x, z), grass: cover("grass", x, z), marsh: cover("marsh", x, z), bare: cover("bare", x, z), sand: cover("sand", x, z) };
    const top = Math.max(cv.tree, cv.shrub, cv.grass, cv.marsh);
    if (cv.sand > 0.18 && cv.sand >= top * 0.95 && cv.sand >= cv.bare) return BEACH;
    if (cv.bare > 0.42 && cv.bare >= top) return ROCK;
    return NONE;
  }
  for (let j = -off; j <= off; j++)
    for (let i = -off; i <= off; i++) {
      const x = X(i), z = Z(j), k = idx(i, j), h = W.heightAt(x, z), lv = level(x, z), t = classify(x, z, h, lv);
      type[k] = t;
      const river = W.riverAt(x, z) > 0.5 && h >= lv;
      const jitter = t === WATER ? 0 : ((hash(Math.round(x / T), Math.round(z / T), 17) - 0.5) * 0.5 + fbm(x / (T * 3), z / (T * 3), 23, 2) * 0.55) * Math.sqrt(T) * 0.8;
      H[k] = t === WATER && !river ? lv * vex : Math.max(h, lv) * vex + jitter * (t === PATH ? 0.4 : 1);
      shallow[k] = river ? 0.7 : clamp(1 - (lv - h) / 1.6, 0, 1);
      // underlay: cover shares blended in rgb, drier grass yellower, patchy lightness like blended underlay ids
      const m = clamp(W.fine(W.moist, x, z), 0, 1.2), c = [0, 0, 0];
      for (const key of Object.keys(UNDER)) {
        const w = cover(key, x, z), base = key === "grass" ? UNDER.grass.map((v, q) => v + (DRYGRASS[q] - v) * clamp(1 - m, 0, 1) * 0.8) : UNDER[key];
        for (let q = 0; q < 3; q++) c[q] += base[q] * w;
      }
      const patch = 1 + 0.2 * fbm(x / 30, z / 30, 5, 2) + 0.1 * (hash(Math.round(x / T), Math.round(z / T), 3) - 0.5), warm = 0.1 * fbm(x / 70, z / 70, 9, 2);
      const sky = 0.82 + 0.18 * W.fine(W.sky, x, z);
      col[k * 3] = c[0] * patch * sky * (1 + warm);
      col[k * 3 + 1] = c[1] * patch * sky;
      col[k * 3 + 2] = c[2] * patch * sky * (1 - warm);
    }
  const normal = (i, j) => {
    const a = H[idx(Math.max(i - 1, -off), j)], b = H[idx(Math.min(i + 1, off), j)], c = H[idx(i, Math.max(j - 1, -off))], d = H[idx(i, Math.min(j + 1, off))];
    const v = new THREE.Vector3(a - b, 2 * T, c - d);
    return v.normalize();
  };

  // One triangle split per tile, with its overlay (if any) and which diagonal it uses.
  const tiles = [];
  for (let j = -R; j < R; j++)
    for (let i = -R; i < R; i++) {
      if (Math.hypot(i + 0.5, j + 0.5) > R) continue;
      const cs = [idx(i, j), idx(i + 1, j), idx(i + 1, j + 1), idx(i, j + 1)];
      let over = NONE, odd = -1;
      for (const t of [WATER, PATH, BEACH, ROCK]) {
        const has = cs.map((k) => type[k] === t), count = has.filter(Boolean).length;
        if (count === 4 || (count === 2 && classify(X(i + 0.5), Z(j + 0.5), W.heightAt(X(i + 0.5), Z(j + 0.5)), level(X(i + 0.5), Z(j + 0.5))) === t)) { over = t; break; }
        if (count === 3) { over = t; odd = has.indexOf(false); break; }
      }
      tiles.push({ i, j, cs, over, odd, tint: 0.94 + hash(i + ox / T, j + oz / T, 11) * 0.12 });
    }

  function geometry() {
    const land = { p: [], n: [], c: [] }, water = { p: [], n: [], c: [] };
    const corner = (cs, q) => { const k = cs[q], i = (k % n) - off, j = Math.floor(k / n) - off; return { k, i, j, x: X(i), z: Z(j) }; };
    const put = (buf, cs, qs, color, isWater) => {
      for (const q of qs) {
        const c = corner(cs, q);
        buf.p.push(c.x, H[c.k], c.z);
        if (isWater) {
          buf.n.push(0, 1, 0);
          const s = shallow[c.k];
          buf.c.push(1 + 0.25 * s, 1 + 0.45 * s, 1 + 0.3 * s);
        } else {
          const nv = normal(c.i, c.j);
          buf.n.push(nv.x, nv.y, nv.z);
          if (color) buf.c.push(...color);
          else buf.c.push(col[c.k * 3], col[c.k * 3 + 1], col[c.k * 3 + 2]);
        }
      }
    };
    for (const t of tiles) {
      // triangles listed counter-clockwise seen from above (x east, z south)
      const diagA = [[0, 2, 1], [0, 3, 2]], diagB = [[0, 3, 1], [1, 3, 2]];
      const tris = t.odd === 1 || t.odd === 3 ? diagA : t.odd >= 0 ? diagB : diagA;
      const ocol = t.over && t.over !== WATER ? OVERCOL[t.over].map((v) => v * t.tint) : null;
      tris.forEach((tri) => {
        const overTri = t.over && (t.odd < 0 || !tri.includes(t.odd));
        if (overTri && t.over === WATER) put(water, t.cs, tri, null, true);
        else put(land, t.cs, tri, overTri ? ocol : null, false);
      });
    }
    const make = (b) => {
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.Float32BufferAttribute(b.p, 3));
      g.setAttribute("normal", new THREE.Float32BufferAttribute(b.n, 3));
      g.setAttribute("color", new THREE.Float32BufferAttribute(b.c, 3));
      return g;
    };
    return { land: make(land), water: make(water) };
  }

  // Height of the drawn surface, so props sit on the tiles they stand on.
  function groundAt(x, z) {
    const fi = (x - ox) / T, fj = (z - oz) / T, i = clamp(Math.floor(fi), -off, off - 1), j = clamp(Math.floor(fj), -off, off - 1), u = fi - i, v = fj - j;
    const h0 = H[idx(i, j)], h1 = H[idx(i + 1, j)], h2 = H[idx(i + 1, j + 1)], h3 = H[idx(i, j + 1)];
    return u >= v ? h0 + (h1 - h0) * u + (h2 - h1) * v : h0 + (h2 - h3) * u + (h3 - h0) * v;
  }
  const tileMap = new Map(tiles.map((t) => [t.j * 4096 + t.i, t]));
  const tileAt = (x, z) => tileMap.get(Math.floor((z - oz) / T) * 4096 + Math.floor((x - ox) / T));
  // Flat color of a tile for the minimap: its overlay, or its underlay averaged.
  function flatColor(t) {
    if (t.over === WATER) return hsl(214, 0.42, 0.38 + shallow[t.cs[0]] * 0.1);
    if (t.over) return OVERCOL[t.over].map((v) => v * t.tint);
    const c = [0, 0, 0];
    for (const k of t.cs) for (let q = 0; q < 3; q++) c[q] += col[k * 3 + q] / 4;
    return c;
  }
  return { T, R, ox, oz, tiles, geometry, groundAt, tileAt, overAt: (x, z) => tileAt(x, z)?.over ?? -1, flatColor, level };
}
