// The pattern: which skein goes in which square, worked out from the world the way a designer would chart a map.
// Water by depth, ground by what covers it, shade by which way the slope faces, trees by kind, then the outlines and
// the small surface stitches (flowers, pebbles, shrubs, reeds) scattered where the world puts them.
import { clamp, hash, fbm } from "../world.js";
import { RAMP } from "./floss.js";

const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((v) => (v + 0.5) / 16 - 0.5);
const bayer = (i, j) => BAYER[(j & 3) * 4 + (i & 3)];

// Water at a point: 0 land, 1 sea, 2 lake; depth in meters (for lakes a rough guess from how far in it lies).
export function waterSampler(w) {
  const { N, CELL, START, isle } = w;
  const lvl = new Float32Array(N * N).fill(NaN);
  for (let k = 0; k < N * N; k++) if (isle.water[k] > 0 && isle.height[k] + isle.water[k] > 0.5) lvl[k] = isle.height[k] + isle.water[k];
  return (x, z) => {
    const cx = (x - START) / CELL, cy = (z - START) / CELL, i0 = Math.round(cx), j0 = Math.round(cy);
    let L = -Infinity;
    for (let dj = -1; dj <= 1; dj++)
      for (let di = -1; di <= 1; di++) {
        const ci = i0 + di, cj = j0 + dj;
        if (ci < 0 || cj < 0 || ci >= N || cj >= N) continue;
        const l = lvl[cj * N + ci];
        if (!Number.isNaN(l) && Math.hypot(ci - cx, cj - cy) < 1.4 && l > L) L = l;
      }
    const h = w.heightAt(x, z);
    if (L > -Infinity) {
      const wet = w.fine(w.wet, x, z), inside = wet - 0.5 + 0.14 * fbm(x / 70, z / 70, 77, 2) + clamp((L - h) * 0.04, -0.15, 0.15);
      if (inside > 0) return [2, 0.5 + inside * 8];
    }
    return h < 0 ? [1, -h] : [0, 0];
  };
}

// A view's pattern. V: { fab, mpc, world(u,v) -> [x,z], fabOf(x,z) -> [u,v], inside(i,j), lightW [x,z], kind }
export function chart(w, V) {
  const { fab, mpc, kind } = V, cols = fab.cols, rows = fab.rows, n = cols * rows;
  const water = waterSampler(w);
  const key = new Array(n).fill(null), type = new Uint8Array(n), cls = new Uint8Array(n), depth = new Float32Array(n);
  const quarter = new Array(n).fill(null), ground = new Array(n).fill(null);
  const ops = [], backs = [];
  const K = (i, j) => j * cols + i;
  const inRange = (i, j) => i >= 0 && j >= 0 && i < cols && j < rows && V.inside(i, j);
  const [Lx, Lz] = V.lightW, Ly = 0.95, Ll = Math.hypot(Lx, Ly, Lz);
  const ex = kind === "island" ? 2.6 : kind === "valley" ? 4 : 1.0, hd = Math.max(mpc * 0.9, 6);
  const covers = ["tree", "shrub", "grass", "marsh", "bare", "sand"];
  const sub = kind === "island" ? [[0, 0], [-0.3, -0.3], [0.3, -0.3], [-0.3, 0.3], [0.3, 0.3]] : [[0, 0]];

  // Tree kinds per square for the island, where a square holds hundreds of trees.
  let kinds = null;
  if (kind === "island") {
    kinds = new Uint16Array(n * 4);
    const ki = { pine: 0, oak: 1, ash: 2, aspen: 3 };
    for (const t of w.trees) { const [u, v] = V.fabOf(t.x, t.z), i = Math.floor(u), j = Math.floor(v); if (i >= 0 && j >= 0 && i < cols && j < rows) kinds[K(i, j) * 4 + ki[t.kind]]++; }
  }

  // ---------- the ground, square by square ----------
  for (let j = 0; j < rows; j++)
    for (let i = 0; i < cols; i++) {
      if (!V.inside(i, j)) continue;
      const k = K(i, j);
      let wet = 0, dsum = 0, sea = 0, lake = 0;
      const share = [0, 0, 0, 0, 0, 0];
      let hsum = 0;
      for (const [a, b] of sub) {
        const [x, z] = V.world(i + 0.5 + a, j + 0.5 + b);
        const [wk, d] = water(x, z);
        if (wk) { wet++; dsum += d; if (wk === 1) sea++; else lake++; }
        for (let c = 0; c < 6; c++) share[c] += w.fine(w.cover[covers[c]], x, z);
        hsum += w.heightAt(x, z);
      }
      const [x, z] = V.world(i + 0.5, j + 0.5);
      if (wet * 2 > sub.length) { cls[k] = sea >= lake ? 1 : 2; depth[k] = dsum / wet; continue; }
      // relief: how squarely the slope faces the light
      const gx = ((w.heightAt(x + hd, z) - w.heightAt(x - hd, z)) / (2 * hd)) * ex, gz = ((w.heightAt(x, z + hd) - w.heightAt(x, z - hd)) / (2 * hd)) * ex;
      const nl = Math.hypot(gx, 1, gz), l = ((-gx * Lx + Ly - gz * Lz) / (nl * Ll)) - Ly / Ll;
      cls[k] = 1 + 8; // land, marked by +8 so water classes stay 1 and 2
      // which cover wins the square: its share, nudged by a slow noise so the edges interlock instead of striping
      let best = -1, bi = 2;
      const speck = kind === "island" ? 0.12 : 0.05;
      for (let c = 0; c < 6; c++) {
        const s = share[c] / sub.length, nz = 0.2 * fbm(i / 4, j / 4, 50 + c, 2) + speck * (hash(i, j, 60 + c) - 0.5);
        const sc = s + (s > 0.04 ? nz : -1);
        if (kind !== "island" && c === 0) continue; // trees come as crowns in the closer views
        if (sc > best) { best = sc; bi = c; }
      }
      let ramp;
      if (bi === 0) {
        const kk = kinds ? [0, 1, 2, 3].map((q) => kinds[k * 4 + q]) : [0, 0, 1, 0];
        const tot = kk[0] + kk[1] + kk[2] + kk[3];
        let pick = 2;
        if (tot > 0) { let r = hash(i, j, 70) * tot; for (pick = 0; pick < 3; pick++) { r -= kk[pick]; if (r < 0) break; } }
        ramp = [RAMP.pine, RAMP.oak, RAMP.ash, RAMP.aspen][pick];
      } else if (bi === 1) ramp = w.fine(w.moist, x, z) < 0.55 || (V.exposureAt?.(x, z) ?? 0) > 0.3 ? RAMP.heath : RAMP.scrub;
      else if (bi === 2) ramp = kind === "camp" ? RAMP.meadowNear : RAMP.meadow;
      else if (bi === 3) ramp = RAMP.marsh;
      else if (bi === 4) ramp = hsum / sub.length < 4 ? RAMP.shingle : RAMP.rock;
      else ramp = RAMP.sand;
      const gain = kind === "island" ? 5.5 : 4;
      // light and dark patches: slope first, then clumps of lighter and darker growth
      const clump = kind === "island" ? 0.5 * fbm(i / 2.2, j / 2.2, 81, 2) : kind === "camp" ? 1.5 * fbm(x / 2.6, z / 2.6, 81, 3) : 1.0 * fbm(x / 24, z / 24, 81, 3);
      const sv = l * gain + clump + (hash(i, j, 80) - 0.5) * (kind === "island" ? 0.45 : 0.28);
      const si = sv > 0.36 ? 2 : sv < -0.36 ? 0 : 1;
      ground[k] = { ramp, cover: bi, h: hsum / sub.length };
      key[k] = ramp[si];
      // open ground in the valley is worked lighter, in half stitches with the cloth showing between
      type[k] = kind === "valley" && bi >= 3 && fbm(i / 3, j / 3, 83, 2) + (hash(i, j, 84) - 0.5) * 0.8 > -0.05 ? 2 : 1;
    }

  // ---------- trees as crowns, in the closer views ----------
  // The biggest trees in view each get a round crown of a few squares, lit on the window side and dark on the far
  // rim, with its shadow thrown on the ground; smaller trees fill in only where they would still show.
  const canopy = new Uint8Array(n);
  if (kind !== "island") {
    const ts = [];
    for (const t of w.trees) {
      const [u, v] = V.fabOf(t.x, t.z);
      if (u < -4 || v < -4 || u > cols + 4 || v > rows + 4) continue;
      const rc = kind === "valley" ? clamp(1.4 + (t.tall - 10) * 0.11, 1.3, 2.7) : clamp((t.tall * 0.3) / mpc, 2, 6);
      ts.push([u, v, t, t.kind === "pine" ? rc * 0.85 : rc]);
    }
    ts.sort((a, b) => b[2].tall - a[2].tall);
    const kept = [], G = new Map(), gk = (u, v) => `${Math.floor(u / 4)},${Math.floor(v / 4)}`;
    for (const tr of ts) {
      const [u, v, , rc] = tr;
      let free = true;
      for (let a = -1; a <= 1 && free; a++)
        for (let b = -1; b <= 1 && free; b++)
          for (const o of G.get(`${Math.floor(u / 4) + a},${Math.floor(v / 4) + b}`) ?? []) if (Math.hypot(o[0] - u, o[1] - v) < (o[3] + rc) * 0.86) { free = false; break; }
      if (!free) continue;
      kept.push(tr);
      const g = gk(u, v);
      if (!G.has(g)) G.set(g, []);
      G.get(g).push(tr);
    }
    kept.sort((a, b) => a[1] - b[1]);
    const shadow = new Uint8Array(n), [sx, sy] = V.lightS, crown = new Int32Array(n), tr_ramp = [];
    for (let q = 0; q < kept.length; q++) {
      const [u, v, t, rc] = kept[q];
      // each tree's own tint nudges it a skein darker or lighter than its kind, so neighbours stand apart
      const fam = ["pine", "oak", "ash", "aspen"], f0 = fam.indexOf(t.kind), fi = t.kind === "pine" ? 0 : clamp(f0 + (t.tint < 0.22 ? -1 : t.tint > 0.82 ? 1 : 0), 1, 3);
      const ramp = RAMP[fam[fi]], seed = Math.floor(t.tint * 1e6), pine = t.kind === "pine";
      tr_ramp[q] = ramp;
      for (let j = Math.floor(v - rc - 3); j <= v + rc + 3; j++)
        for (let i = Math.floor(u - rc - 3); i <= u + rc + 3; i++) {
          if (!inRange(i, j)) continue;
          const k = K(i, j);
          if (cls[k] !== 9) continue;
          const du = i + 0.5 - u, dv = j + 0.5 - v, d = Math.hypot(du, dv), th = Math.atan2(dv, du);
          const edge = rc * (pine ? 1 + 0.22 * Math.cos(th * 7 + seed) : 1 + 0.1 * Math.sin(th * 5 + seed) + 0.06 * Math.sin(th * 3 - seed)) + 0.12;
          if (d > edge) {
            if (Math.hypot(du + sx * rc * 0.85, dv + sy * rc * 0.85) < rc * 0.95) shadow[k] = 1;
            continue;
          }
          const lt = -(du * sx + dv * sy) / rc, sv = lt * 0.75 + (1 - d / rc) * 0.2 - 0.05 + (hash(i, j, seed + 1) - 0.5) * 0.22;
          key[k] = ramp[sv > 0.3 ? 2 : sv < -0.28 ? 0 : 1];
          canopy[k] = 1;
          crown[k] = q + 1;
          type[k] = 1;
        }
    }
    // a knot or two of the lightest green where the sun catches each crown
    for (let q = 0; q < kept.length; q++) {
      const [u, v, t, rc] = kept[q];
      if (u < 0 || v < 0 || u >= cols || v >= rows || crown[K(Math.floor(u), Math.floor(v))] !== q + 1 || rc < 1.55) continue;
      const ramp = tr_ramp[q], n2 = t.kind === "pine" ? 1 : rc > 1.8 ? 3 : 2;
      for (let q = 0; q < n2; q++) {
        const a = Math.atan2(sy, sx) + (q - (n2 - 1) / 2) * 0.9, d = rc * (t.kind === "pine" ? 0.15 : 0.42);
        ops.push({ t: "knot", u: u + Math.cos(a) * d, v: v + Math.sin(a) * d, c: ramp[2], r: t.kind === "pine" ? 0.32 : 0.38 + 0.05 * q });
      }
    }
    // a line of dark backstitch round each crown on its shaded side, the way tree motifs are outlined
    for (let j = 0; j < rows - 1; j++)
      for (let i = 0; i < cols - 1; i++) {
        const k = K(i, j), id = crown[k];
        if (!id) continue;
        const dark = kept[id - 1][2].kind === "pine" ? 890 : 3345;
        if (crown[K(i + 1, j)] !== id && cls[K(i + 1, j)] === 9) backs.push({ i0: i + 1, j0: j, i1: i + 1, j1: j + 1, key: dark, r: 0.12 });
        if (crown[K(i, j + 1)] !== id && cls[K(i, j + 1)] === 9) backs.push({ i0: i, j0: j + 1, i1: i + 1, j1: j + 1, key: dark, r: 0.12 });
      }
    // under the trees and in their shadows the ground is dark
    for (let j = 0; j < rows; j++)
      for (let i = 0; i < cols; i++) {
        const k = K(i, j);
        if (cls[k] !== 9 || canopy[k] || !ground[k]) continue;
        const [x, z] = V.world(i + 0.5, j + 0.5), wood = w.fine(w.cover.tree, x, z);
        if (shadow[k]) key[k] = wood > 0.5 ? 890 : ground[k].ramp[0];
        else if (wood > 0.5) key[k] = hash(i, j, 90) < 0.6 ? 3345 : ground[k].ramp[0];
      }
  }

  // ---------- water ----------
  const dz = V.depthScale ?? 1;
  // on the island the sea is banded by distance from the shore, fading out into bare cloth
  const far = new Float32Array(n).fill(1e9);
  for (let k = 0; k < n; k++) if (cls[k] >= 3) far[k] = 0;
  for (let pass = 0; pass < 2; pass++)
    for (let jj = 0; jj < rows; jj++)
      for (let ii = 0; ii < cols; ii++) {
        const i = pass ? cols - 1 - ii : ii, j = pass ? rows - 1 - jj : jj, k = K(i, j), s = pass ? -1 : 1;
        for (const [a, b, d] of [[-s, 0, 1], [0, -s, 1], [-s, -s, 1.414], [s, -s, 1.414]]) { const x = i + a, y = j + b; if (x >= 0 && y >= 0 && x < cols && y < rows && far[K(x, y)] + d < far[k]) far[k] = far[K(x, y)] + d; }
      }
  for (let j = 0; j < rows; j++)
    for (let i = 0; i < cols; i++) {
      const k = K(i, j);
      if (cls[k] === 1 && kind === "island") {
        const d = far[k] + 0.06 * depth[k] + 0.9 * fbm(i / 5, j / 5, 102, 2) + (hash(i, j, 103) - 0.5) * 0.7;
        if (d < 1.8) { key[k] = 3325; type[k] = 1; }
        else if (d < 3.3) { key[k] = 519; type[k] = 1; }
        else if (d < 5.2) { key[k] = 518; type[k] = 2; }
        else if (d < 8 && hash(i, j, 104) < (8 - d) / 3.2) { key[k] = 519; type[k] = 2; }
      } else if (cls[k] === 1) {
        const d = depth[k] / dz, t = bayer(i, j) * 0.8 + (hash(i, j, 100) - 0.5) * 0.4;
        if (d + t * 0.6 < 1.2) { key[k] = 3325; type[k] = 1; }
        else if (d + t * 1.5 < 3.5) { key[k] = 519; type[k] = 1; }
        else if (d + t * 3 < 8) { key[k] = 519; type[k] = 2; }
        else if (d + t * 10 < 17 && hash(i, j, 101) < 0.75 - (d - 8) / 14) { key[k] = 3325; type[k] = 2; }
      } else if (cls[k] === 2) {
        const d = depth[k] + bayer(i, j) * 1.2;
        key[k] = d > 2.2 ? 518 : 519; type[k] = 1;
      }
    }

  // ---------- rivers ----------
  if (kind === "island") {
    for (const line of w.rivers) {
      let last = null;
      for (let s = 0; s < line.length; s++) {
        const [x, z, q] = line[s];
        if (q < 0.035) { last = null; continue; }
        const [u, v] = V.fabOf(x, z), hi = Math.round(u), hj = Math.round(v);
        if (!inRange(Math.min(hi, cols - 1), Math.min(hj, rows - 1))) { last = null; continue; }
        const k = K(Math.min(hi, cols - 1), Math.min(hj, rows - 1));
        if (water(x, z)[0]) { last = null; continue; }
        if (last && (last[0] !== hi || last[1] !== hj)) {
          if (Math.abs(last[0] - hi) <= 1 && Math.abs(last[1] - hj) <= 1) backs.push({ i0: last[0], j0: last[1], i1: hi, j1: hj, key: 517, r: 0.22 + Math.min(q, 0.15) * 0.6 });
          else { last = [hi, hj]; continue; }
        }
        last = [hi, hj];
      }
    }
  } else {
    for (let j = 0; j < rows; j++)
      for (let i = 0; i < cols; i++) {
        const k = K(i, j);
        if (cls[k] !== 9) continue;
        const [x, z] = V.world(i + 0.5, j + 0.5);
        const rv = w.riverAt(x, z);
        if (rv > 0.45) { cls[k] = 3; key[k] = rv > 0.9 && hash(i, j, 110) < 0.6 ? 518 : 519; type[k] = 1; canopy[k] = 0; }
      }
  }

  // ---------- outlines: the edge of each water body, cut diagonally where it steps ----------
  const outline = (inA, color, r) => {
    // squares that are "in" plus corner triangles where an outside square has two in-neighbours meeting at a corner
    const tri = new Int8Array(n).fill(-1);
    for (let j = 0; j < rows; j++)
      for (let i = 0; i < cols; i++) {
        const k = K(i, j);
        if (!inRange(i, j) || inA(i, j)) continue;
        const N_ = inA(i, j - 1), S_ = inA(i, j + 1), W_ = inA(i - 1, j), E_ = inA(i + 1, j);
        if (N_ + S_ + W_ + E_ !== 2) continue;
        if (N_ && W_) tri[k] = 0; else if (N_ && E_) tri[k] = 1; else if (S_ && W_) tri[k] = 2; else if (S_ && E_) tri[k] = 3;
      }
    const edges = new Map();
    const add = (a, b, c, d) => { const back = `${c},${d},${a},${b}`; if (edges.has(back)) edges.delete(back); else edges.set(`${a},${b},${c},${d}`, [a, b, c, d]); };
    for (let j = 0; j < rows; j++)
      for (let i = 0; i < cols; i++) {
        const k = K(i, j);
        if (inRange(i, j) && inA(i, j)) { add(i, j, i, j + 1); add(i, j + 1, i + 1, j + 1); add(i + 1, j + 1, i + 1, j); add(i + 1, j, i, j); }
        else if (tri[k] >= 0) {
          const P = [[i, j], [i + 1, j], [i, j + 1], [i + 1, j + 1]], c = tri[k];
          // triangle with its right angle at corner c, wound the same way as the squares
          const T = c === 0 ? [P[0], P[2], P[1]] : c === 1 ? [P[0], P[3], P[1]] : c === 2 ? [P[0], P[2], P[3]] : [P[2], P[3], P[1]];
          for (let e = 0; e < 3; e++) add(T[e][0], T[e][1], T[(e + 1) % 3][0], T[(e + 1) % 3][1]);
        }
      }
    for (const [a, b, c, d] of edges.values()) {
      if (a <= 0 || b <= 0 || c <= 0 || d <= 0 || a >= cols || c >= cols || b >= rows || d >= rows) continue;
      backs.push({ i0: a, j0: b, i1: c, j1: d, key: color, r });
    }
    return tri;
  };
  const isLand = (i, j) => inRange(i, j) && cls[K(i, j)] >= 3;
  const coastTri = outline(isLand, 3750, kind === "island" ? 0.17 : 0.13);
  // the in-colour three-quarter stitches that round off the steps
  for (let k = 0; k < n; k++) {
    if (coastTri[k] < 0) continue;
    const i = k % cols, j = (k / cols) | 0, c = coastTri[k];
    const ni = c === 0 || c === 2 ? i - 1 : i + 1, nj = c === 0 || c === 1 ? j - 1 : j + 1;
    const from = key[K(ni, j)] ?? key[K(i, nj)];
    quarter[k] = type[k] ? key[k] : null;
    key[k] = from; type[k] = 3 + c;
  }
  if (kind !== "island") outline((i, j) => inRange(i, j) && cls[K(i, j)] === 3, 517, 0.12);

  // how dense the work is, for the pull of the cloth
  const density = new Float32Array(n);
  for (let k = 0; k < n; k++) density[k] = type[k] === 1 ? 1 : type[k] ? 0.5 : 0;

  return { cols, rows, key, type, quarter, cls, ground, backs, ops, density, canopy };
}
