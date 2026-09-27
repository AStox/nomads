// The ground as a wireframe: rings of grid patches (finer near the focus), every quad a black occluder drawn far to
// near with its edges on top, so nearer ridges cut off the lines behind them. Water is flat with scan lines instead.
import { clamp, hash, noise } from "../world.js";
import { PAL } from "./beam.js";

const hot = (c, t) => [c[0] + (1 - c[0]) * t, c[1] + (1 - c[1]) * t, c[2] + (1 - c[2]) * t];

export function terrain(w, V, cam, beam, items) {
  const lo = w.START, hi = w.START + (w.M - 1) * w.STEP;
  const snap = (v, s, f) => clamp(lo + f((v - lo) / s) * s, lo, hi);
  const L = V.levels, c = V.focus, bounds = [];
  for (let n = 0; n < L.length; n++) {
    const s = L[Math.min(n + 1, L.length - 1)].step;
    bounds.push([snap(c.x - L[n].radius, s, Math.floor), snap(c.z - L[n].radius, s, Math.floor), snap(c.x + L[n].radius, s, Math.ceil), snap(c.z + L[n].radius, s, Math.ceil)]);
  }
  // standing water keeps the level of its cells: the lowest surface among the nearest water cells
  const lvl = new Float32Array(w.N * w.N).fill(NaN);
  for (let k = 0; k < lvl.length; k++) if (w.isle.water[k] > 0) lvl[k] = w.isle.height[k] + w.isle.water[k];
  const surfAt = (x, z) => {
    const cx = Math.round((x - w.START) / w.CELL), cy = Math.round((z - w.START) / w.CELL);
    let s = Infinity;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const v = lvl[clamp(cy + dy, 0, w.N - 1) * w.N + clamp(cx + dx, 0, w.N - 1)];
      if (v === v && v < s) s = v;
    }
    return s === Infinity ? NaN : s;
  };
  const light = V.light;
  L.forEach((lev, n) => patch(w, V, cam, beam, items, lev.step, bounds[n], n ? bounds[n - 1] : null, surfAt, light));
  return bounds;
}

function patch(w, V, cam, beam, items, step, b, hole, surfAt, light) {
  const [x0, z0, x1, z1] = b;
  const nx = Math.round((x1 - x0) / step) + 1, nz = Math.round((z1 - z0) / step) + 1, n = nx * nz;
  if (nx < 2 || nz < 2) return;
  const SX = new Float32Array(n), SY = new Float32Array(n), D = new Float32Array(n), I = new Float32Array(n);
  const WT = new Float32Array(n), DEP = new Float32Array(n), CL = new Uint8Array(n), FW = new Float32Array(n), AL = new Float32Array(n);
  const GR = new Float32Array(n), SA = new Float32Array(n), MA = new Float32Array(n), BA = new Float32Array(n), X = new Float32Array(n), Z = new Float32Array(n), FV = new Float32Array(n);
  const vex = cam.vex, fh = cam.fh, e = Math.max(step, 8), out = { x: 0, y: 0, d: 0 };
  const riverWater = step <= V.riverWaterStep;
  for (let j = 0; j < nz; j++)
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i, x = x0 + i * step, z = z0 + j * step, h = w.heightAt(x, z);
      const wet = w.fine(w.wet, x, z), rv = riverWater ? w.riverAt(x, z) : 0;
      let y = h, wt = 0, dep = 0;
      if (wet > 0.02) {
        const s = surfAt(x, z);
        if (s === s) {
          // the shore is where the smooth ground meets the water's level, not the blocky edge of the water cells
          wt = Math.min(clamp(0.5 + (s - h) / 1.2, 0, 1), clamp(wet * 5, 0, 1));
          dep = Math.max(0, s - h);
          if (wt >= 0.5) y = s;
        }
      }
      if (rv > 0.2 && wt < 0.5) { wt = Math.max(wt, clamp((rv - 0.2) / 0.5, 0, 1)); if (wt >= 0.5) { y = h + 0.5; dep = 1; } }
      X[k] = x; Z[k] = z; WT[k] = wt; DEP[k] = dep;
      D[k] = cam.project(x, y, z, out);
      SX[k] = out.x + beam.j();
      SY[k] = out.y + beam.j();
      // relief shading by a light from the viewer's upper left, dimmed with distance and in hollows
      const gx = ((w.heightAt(x + e, z) - w.heightAt(x - e, z)) / (2 * e)) * vex, gz = ((w.heightAt(x, z + e) - w.heightAt(x, z - e)) / (2 * e)) * vex;
      const nl = Math.hypot(gx, 1, gz), shade = clamp((-gx * light[0] + light[1] - gz * light[2]) / nl, 0, 1);
      const t = clamp((D[k] - V.fog[0]) / (V.fog[1] - V.fog[0]), 0, 1);
      let fog = 1 - 0.78 * t;
      if (V.edgeFade) fog *= clamp((V.edgeFade[1] - Math.hypot(x - V.edgeFade[2], z - V.edgeFade[3])) / (V.edgeFade[1] - V.edgeFade[0]), 0, 1);
      FW[k] = fog;
      const sky = w.fine(w.sky, x, z);
      I[k] = fog * (0.22 + 0.9 * shade ** 1.6) * (0.72 + 0.28 * sky) * V.landGain;
      const sand = w.fine(w.cover.sand, x, z), bare = w.fine(w.cover.bare, x, z), slope = Math.hypot(gx, gz) / vex;
      CL[k] = sand > 0.3 && h < 14 ? 1 : bare > 0.42 || slope > 0.85 ? 2 : 0;
      GR[k] = w.fine(w.cover.grass, x, z);
      SA[k] = sand;
      MA[k] = w.fine(w.cover.marsh, x, z);
      BA[k] = bare;
      AL[k] = x * -fh[1] + z * fh[0];
      FV[k] = x * fh[0] + z * fh[1];
    }
  const qx = nx - 1, qz = nz - 1, face = new Int8Array(qx * qz).fill(-1), W = cam.W, H = cam.H;
  for (let j = 0; j < qz; j++)
    for (let i = 0; i < qx; i++) {
      const q = j * qx + i, v0 = j * nx + i, v1 = v0 + 1, v2 = v0 + nx + 1, v3 = v0 + nx;
      if (hole) { const cx = x0 + (i + 0.5) * step, cz = z0 + (j + 0.5) * step; if (cx > hole[0] && cx < hole[2] && cz > hole[1] && cz < hole[3]) continue; }
      if (D[v0] <= cam.near || D[v1] <= cam.near || D[v2] <= cam.near || D[v3] <= cam.near) continue;
      const mnx = Math.min(SX[v0], SX[v1], SX[v2], SX[v3]), mxx = Math.max(SX[v0], SX[v1], SX[v2], SX[v3]);
      const mny = Math.min(SY[v0], SY[v1], SY[v2], SY[v3]), mxy = Math.max(SY[v0], SY[v1], SY[v2], SY[v3]);
      if (mxx < -4 || mnx > W + 4 || mxy < -4 || mny > H + 4) continue;
      // a quad is seen from its front when either of its triangles winds forward on screen
      const a1 = (SX[v1] - SX[v0]) * (SY[v2] - SY[v0]) - (SY[v1] - SY[v0]) * (SX[v2] - SX[v0]);
      const a2 = (SX[v2] - SX[v0]) * (SY[v3] - SY[v0]) - (SY[v2] - SY[v0]) * (SX[v3] - SX[v0]);
      face[q] = a1 > 0 || a2 > 0 ? 1 : 0;
    }
  const P = { SX, SY, D, I, WT, DEP, CL, FW, AL, FV, GR, SA, MA, BA, X, Z, nx, qx, qz, face, step, V, beam, cam };
  for (let q = 0; q < face.length; q++) {
    if (face[q] !== 1) continue;
    const j = Math.floor(q / qx), i = q - j * qx, v0 = j * nx + i;
    items.push({ k: (D[v0] + D[v0 + 1] + D[v0 + nx] + D[v0 + nx + 1]) / 4, f: drawQuad, a: q, p: P });
  }
}

const tmp = new Float32Array(12);
// Where a level of `F` crosses the triangle (a, b, c): writes two points (screen x, y, water share, along) to `o`.
function iso(P, a, b, c, F, lv, o) {
  let m = 0;
  const e = [a, b, b, c, c, a];
  for (let s = 0; s < 6; s += 2) {
    const p = e[s], q = e[s + 1], fp = F[p] - lv, fq = F[q] - lv;
    if ((fp < 0) === (fq < 0)) continue;
    const t = fp / (fp - fq);
    o[m] = P.SX[p] + (P.SX[q] - P.SX[p]) * t;
    o[m + 1] = P.SY[p] + (P.SY[q] - P.SY[p]) * t;
    o[m + 2] = P.WT[p] + (P.WT[q] - P.WT[p]) * t;
    o[m + 3] = P.AL[p] + (P.AL[q] - P.AL[p]) * t;
    o[m + 4] = P.DEP[p] + (P.DEP[q] - P.DEP[p]) * t;
    o[m + 5] = P.FW[p] + (P.FW[q] - P.FW[p]) * t;
    m += 6;
    if (m === 12) break;
  }
  return m === 12;
}

function drawQuad(q, P) {
  const { SX, SY, WT, I, CL, nx, qx, qz, face, beam, V } = P;
  const j = Math.floor(q / qx), i = q - j * qx, v0 = j * nx + i, v1 = v0 + 1, v2 = v0 + nx + 1, v3 = v0 + nx;
  beam.occlude([SX[v0], SY[v0], SX[v1], SY[v1], SX[v2], SY[v2], SX[v3], SY[v3]]);
  const wmin = Math.min(WT[v0], WT[v1], WT[v2], WT[v3]), wmax = Math.max(WT[v0], WT[v1], WT[v2], WT[v3]);
  const size = Math.max(Math.hypot(SX[v2] - SX[v0], SY[v2] - SY[v0]), Math.hypot(SX[v3] - SX[v1], SY[v3] - SY[v1]));
  const lod = size < V.lodPx * 0.5 ? 4 : size < V.lodPx ? 2 : 1;
  if (wmax >= 0.5) water(P, v0, v1, v2, v3);
  if (wmin < 0.5) {
    // edges: [a, b, neighbour quad, grid line index]
    const E = [[v0, v1, j > 0 ? q - qx : -1, j], [v1, v2, i < qx - 1 ? q + 1 : -1, i + 1], [v3, v2, j < qz - 1 ? q + qx : -1, j + 1], [v0, v3, i > 0 ? q - 1 : -1, i]];
    for (const [a, b, nb, line] of E) {
      const sil = nb >= 0 && face[nb] === 0;
      if (!sil && line % lod) continue;
      let ax = SX[a], ay = SY[a], bx = SX[b], by = SY[b];
      const wa = WT[a], wb = WT[b];
      if (wa >= 0.5 && wb >= 0.5) continue;
      if (wa >= 0.5 || wb >= 0.5) {
        const t = (0.5 - wa) / (wb - wa);
        if (wa >= 0.5) { ax += (bx - ax) * t; ay += (by - ay) * t; } else { bx = ax + (bx - ax) * t; by = ay + (by - ay) * t; }
      }
      const cl = CL[a] === CL[b] ? CL[a] : 0, col = cl === 1 ? PAL.sand : cl === 2 ? PAL.rock : PAL.land;
      let it = (I[a] + I[b]) / 2;
      if (cl === 1) it *= 0.8;
      if (sil) beam.seg(ax, ay, bx, by, hot(col, 0.35), Math.max(it, (P.FW[a] + P.FW[b]) * 0.5 * 0.85) * 1.25, beam.width * 1.2);
      else beam.seg(ax, ay, bx, by, col, it);
    }
    if (size > V.dotPx) for (const v of [v0, v1, v2, v3]) if (WT[v] < 0.5) beam.dot(SX[v], SY[v], CL[v] === 1 ? PAL.sand : CL[v] === 2 ? PAL.rock : PAL.land, I[v] * 1.35, 1.6);
    if (size > V.markPx) marks(P, q, v0, v1, v2, v3, size);
  }
  if (wmax >= 0.5 && wmin < 0.5) {
    // the shoreline, bright, where the water share crosses a half
    for (const [a, b, c] of [[v0, v1, v2], [v0, v2, v3]])
      if (iso(P, a, b, c, WT, 0.5, tmp)) beam.seg(tmp[0], tmp[1], tmp[6], tmp[7], hot(PAL.water, 0.25), Math.max(0.4, tmp[5]) * 1.15 * V.waterGain, beam.width * 1.15);
  }
  if (wmax >= 0.5 && V.surf) {
    // a broken line of surf where the bottom shelves to a set depth
    for (const [a, b, c] of [[v0, v1, v2], [v0, v2, v3]]) {
      if (!iso(P, a, b, c, P.DEP, V.surf, tmp) || tmp[2] < 0.5 || tmp[8] < 0.5) continue;
      const ax = tmp[0], ay = tmp[1], dx = tmp[6] - ax, dy = tmp[7] - ay, n = Math.max(1, Math.round(Math.hypot(dx, dy) / 4));
      const it = Math.max(0.35, (tmp[5] + tmp[11]) / 2) * 0.8 * V.waterGain;
      for (let s = 0; s < n; s += 2) beam.seg(ax + (dx * s) / n, ay + (dy * s) / n, ax + (dx * Math.min(n, s + 1)) / n, ay + (dy * Math.min(n, s + 1)) / n, PAL.water, it);
    }
  }
}

// Water: flat, black, crossed by scan lines square to the view, broken into dashes that drift like swell.
function water(P, v0, v1, v2, v3) {
  const { WT, SY, V, beam } = P, ws = V.waterStep, f = P.FV;
  const fmin = Math.min(f[v0], f[v1], f[v2], f[v3]), fmax = Math.max(f[v0], f[v1], f[v2], f[v3]);
  const ey = Math.max(SY[v0], SY[v1], SY[v2], SY[v3]) - Math.min(SY[v0], SY[v1], SY[v2], SY[v3]);
  const pxPer = ey / Math.max(1e-3, fmax - fmin);
  let lw = 1;
  while (ws * lw * pxPer < V.waterPx && lw < 64) lw *= 2;
  const k0 = Math.ceil(fmin / ws - 0.5), k1 = Math.floor(fmax / ws - 0.5);
  for (let k = k0; k <= k1; k++) {
    if (((k % lw) + lw) % lw) continue;
    const lv = (k + 0.5) * ws;
    for (const [a, b, c] of [[v0, v1, v2], [v0, v2, v3]]) {
      if (!iso(P, a, b, c, f, lv, tmp)) continue;
      let ax = tmp[0], ay = tmp[1], wa = tmp[2], la = tmp[3], bx = tmp[6], by = tmp[7], wb = tmp[8], lb = tmp[9];
      if (wa < 0.5 && wb < 0.5) continue;
      if (wa < 0.5 || wb < 0.5) {
        const t = (0.5 - wa) / (wb - wa);
        if (wa < 0.5) { ax += (bx - ax) * t; ay += (by - ay) * t; la += (lb - la) * t; } else { bx = ax + (bx - ax) * t; by = ay + (by - ay) * t; lb = la + (lb - la) * t; }
      }
      const dep = (tmp[4] + tmp[10]) / 2, fog = (tmp[5] + tmp[11]) / 2;
      const base = fog * (0.45 + 0.45 * clamp(1 - dep / V.shallow, 0, 1)) * V.waterGain;
      // split into dashes along the line; each piece lights where the swell pattern is up
      const len = Math.hypot(bx - ax, by - ay), m = Math.max(1, Math.ceil(len / 3));
      let run = -1;
      for (let s = 0; s <= m; s++) {
        let on = false, br = 0;
        if (s < m) {
          const t = (s + 0.5) / m, al = la + (lb - la) * t;
          const sw = noise(al / V.swell, k * 0.37, 77) + 0.55 * Math.sin(al / (V.swell * 0.23) + k * 1.9);
          on = sw > V.dashCut;
          br = clamp(0.55 + sw * 0.6, 0.3, 1.3);
        }
        if (on && run < 0) run = s;
        if ((!on || s === m) && run >= 0) {
          const t0 = run / m, t1 = s / m;
          beam.seg(ax + (bx - ax) * t0, ay + (by - ay) * t0, ax + (bx - ax) * t1, ay + (by - ay) * t1, PAL.water, base * (br || 0.8));
          run = -1;
        }
      }
    }
  }
}

// Ground cover as marks inside a quad: grass ticks, marsh reeds, sand stipple, scree dots, each from the cover shares.
function marks(P, q, v0, v1, v2, v3, size) {
  const { SX, SY, D, WT, I, GR, SA, MA, BA, beam, cam, V } = P;
  const g = (GR[v0] + GR[v1] + GR[v2] + GR[v3]) / 4, s = (SA[v0] + SA[v1] + SA[v2] + SA[v3]) / 4;
  const m = (MA[v0] + MA[v1] + MA[v2] + MA[v3]) / 4, br = (BA[v0] + BA[v1] + BA[v2] + BA[v3]) / 4;
  const area = size * size * 0.5, it = (I[v0] + I[v1] + I[v2] + I[v3]) / 4;
  const seed = Math.floor(P.X[v0] * 7.1 + P.Z[v0] * 3.3);
  const at = (u, v) => {
    const x = (SX[v0] * (1 - u) + SX[v1] * u) * (1 - v) + (SX[v3] * (1 - u) + SX[v2] * u) * v;
    const y = (SY[v0] * (1 - u) + SY[v1] * u) * (1 - v) + (SY[v3] * (1 - u) + SY[v2] * u) * v;
    const d = (D[v0] * (1 - u) + D[v1] * u) * (1 - v) + (D[v3] * (1 - u) + D[v2] * u) * v;
    const w = (WT[v0] * (1 - u) + WT[v1] * u) * (1 - v) + (WT[v3] * (1 - u) + WT[v2] * u) * v;
    return [x, y, d, w];
  };
  const up = cam.F * cam.u[1] * cam.vex;
  const bright = Math.max(it, 0.25) * V.markGain;
  const put = (count, fn) => { for (let k = 0; k < count; k++) { const [x, y, d, wv] = at(hash(seed, k, 101), hash(seed, k, 102)); if (wv < 0.4) fn(x, y, d, k); } };
  const tufted = V.tuftR && Math.hypot(P.X[v0] - V.camp.x, P.Z[v0] - V.camp.z) < V.tuftR;
  if (!tufted) put(Math.min(16, Math.floor(g * area / V.grassArea + hash(seed, 0, 103))), (x, y, d, k) => {
    const L = (0.55 * up) / d, lean = (hash(seed, k, 104) - 0.5) * L * 0.6;
    if (L < 2.2) return;
    beam.seg(x - L * 0.25, y, x + lean - L * 0.1, y - L, PAL.plant, bright * 0.55);
    beam.seg(x + L * 0.25, y, x + lean + L * 0.2, y - L * 0.8, PAL.plant, bright * 0.45);
  });
  put(Math.min(20, Math.floor(s * area / (V.grassArea * 0.5))), (x, y) => beam.dot(x, y, PAL.sand, bright * 0.8, 1.3));
  put(Math.min(10, Math.floor(m * area / (V.grassArea * 1.5))), (x, y, d) => {
    const L = Math.max(2, (1.4 * cam.F) / d);
    beam.seg(x - L / 2, y, x + L / 2, y, PAL.water, bright * 0.6);
    beam.seg(x, y, x + L * 0.1, y - L * 0.6, PAL.plant, bright * 0.5);
  });
  put(Math.min(10, Math.floor(br * area / V.grassArea)), (x, y) => beam.dot(x, y, PAL.rock, bright * 0.7, 1.4));
}
