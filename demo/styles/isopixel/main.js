// Nomads as a 90s isometric sim: a 2:1 tile map with integer height steps, slope shapes and cliff strips, painted
// pixel by pixel into a small indexed buffer with one fixed palette, then blown up with nearest neighbour.
import { grow, fbm, noise, smooth } from "../world.js";
import { P, ramp, SHADOW, GLOW } from "./pal.js";
import { Buf, Spr, tri, strip, blit, castShadow, shadowPx, bayer, dith, h2 } from "./px.js";
import * as SP from "./sprites.js";
import { drawUI } from "./ui.js";

const Q = new URLSearchParams(location.search);
const VIEW = ["island", "valley", "camp"].includes(Q.get("view")) ? Q.get("view") : "valley";
const SEED = Number(Q.get("seed") || 1);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

const CFG = {
  island: { S: 2, W: 12, lp: 2, exag: 5, detail: 0, foam: 1.2, deep: 45, sparkle: 0.0005, grid: 0, gain: 1.5, tsun: 0.5, cell: [4, 3] },
  valley: { S: 2, W: 32, lp: 4, tileM: 18, exag: 5.5, relief: 80, detail: 1, foam: 2.4, deep: 9, sparkle: 0.002, focus: [0.5, 0.64], treeK: 1.15, campK: 4.5, campOff: 3.0, grid: 0.45, gain: 1.2, tsun: 0.5, cell: [5, 3] },
  camp: { S: 2, W: 72, lp: 9, tileM: 3, exag: 1.0, detail: 2, foam: 4, deep: 3, sparkle: 0.002, focus: [0.5, 0.66], treeK: 0.5, campK: 1.2, campOff: 1, grid: 0.5, gain: 0.55, tsun: 0, cell: [8, 5] },
};
const SEA = 1, LAKE = 2, RIVER = 3;
const MEADOW = 0, FOREST = 1, SCRUB = 2, MARSH = 3, ROCK = 4, SAND = 5;
const COV = ["grass", "tree", "shrub", "marsh", "bare", "sand"];
const WEIGHT = [1.0, 1.05, 1.2, 1.5, 1.3, 1.6];

const GR = ramp("g0", "g1", "g2", "g3", "g4", "g5", "g6");
const FF = ramp("p0", "t1", "t2", "g1", "g2", "g3");
const SC = ramp("g0", "m0", "m1", "m2", "g3", "a1", "a2");
const SA = ramp("d3", "s0", "s1", "s2", "s3");
const RK = ramp("r0", "r1", "r2", "r3", "r4", "r5");
const MA = ramp("m0", "m1", "m2", "m3", "a1");
const DI = ramp("d0", "d1", "d2", "d3", "d4", "d5");
const WA = ramp("w0", "w1", "w2", "w3", "w4", "w5", "w6", "w7");
const FLOWER = [P.f3, P.snow, P.red, P.violet, P.a3];
// one step down each terrain ramp, for the faint tile grid
const DARKER = Uint8Array.from({ length: 64 }, (_, i) => i);
for (const r of [DI, SA, RK, MA, SC, FF, GR]) for (let k = 1; k < r.length; k++) DARKER[r[k]] = r[k - 1];
// shadows on the ground stay in their own ramp, two steps down, so sand in shade reads as darker sand
for (const r of [WA, DI, SA, RK, MA, SC, FF, GR]) for (let k = 0; k < r.length; k++) SHADOW[r[k]] = r[Math.max(0, k - 2)];

// Light arrives from screen left and a little behind, in tile axes (u, v); shadows fall right and slightly down.
const LU = -0.958, LV = 0.287, SUN = 0.9; // SUN: elevation, radians
const L3 = [LU * Math.cos(SUN), LV * Math.cos(SUN), Math.sin(SUN)];

function makeView(w, cfg, AW, AH) {
  const V = { ...cfg, name: VIEW, AW, AH, H: cfg.W / 2 };
  const phi = w.camp.from;
  V.eu = [Math.cos(phi - Math.PI / 4), Math.sin(phi - Math.PI / 4)];
  V.ev = [Math.cos(phi + Math.PI / 4), Math.sin(phi + Math.PI / 4)];
  V.scale = (tileM) => { V.tileM = tileM; V.k = V.W / (tileM * Math.SQRT2); V.levelM = V.lp / (V.k * 0.866 * V.exag); };
  V.toUV = (x, z) => { const dx = x - V.ox, dz = z - V.oz; return [(dx * V.eu[0] + dz * V.eu[1]) / V.tileM, (dx * V.ev[0] + dz * V.ev[1]) / V.tileM]; };
  V.toW = (u, v) => [V.ox + (u * V.eu[0] + v * V.ev[0]) * V.tileM, V.oz + (u * V.eu[1] + v * V.ev[1]) * V.tileM];
  V.sx = (u, v) => V.X0 + (u - v) * V.H;
  V.sy = (u, v, hz) => V.Y0 + (u + v) * V.H * 0.5 - hz * V.lp;
  V.cz = (u, v, hz) => 1.5 * V.H * (u + v) + hz * V.lp;
  V.hsample = (x, z) => w.heightAt(x, z);
  if (VIEW === "island") fitIsland(w, V);
  else fitLocal(w, V);
  V.NI = V.i1 - V.i0; V.NJ = V.j1 - V.j0;
  V.ms = V.tileM * (VIEW === "island" ? 3 : 2.6); // mottling scale
  V.pm = V.tileM * 0.9;
  V.rip = VIEW === "camp" ? 0.8 : 3;
  // one art pixel up the screen on flat ground, in world meters
  const d = -1 / V.H;
  V.upW = [(d * V.eu[0] + d * V.ev[0]) * V.tileM, (d * V.eu[1] + d * V.ev[1]) * V.tileM];
  // flattened sprite shadows, in art pixels per pixel of height
  const cot = 1 / Math.tan(SUN), sd = [-LU / Math.hypot(LU, LV), -LV / Math.hypot(LU, LV)];
  V.shx = (sd[0] - sd[1]) * 0.8165 * cot;
  V.shy = (sd[0] + sd[1]) * 0.5 * 0.8165 * cot;
  V.sd = sd; V.cot = cot;
  return V;
}

function fitIsland(w, V) {
  V.ox = 0; V.oz = 0;
  const I = w.isle, N = w.N;
  let umin = Infinity, umax = -Infinity, vmin = Infinity, vmax = -Infinity;
  for (let cy = 0; cy < N; cy++)
    for (let cx = 0; cx < N; cx++) {
      if (I.height[cy * N + cx] <= 0) continue;
      for (const [a, b] of [[-0.5, -0.5], [0.5, -0.5], [-0.5, 0.5], [0.5, 0.5]]) {
        const x = w.START + (cx + a) * w.CELL, z = w.START + (cy + b) * w.CELL;
        const u = x * V.eu[0] + z * V.eu[1], v = x * V.ev[0] + z * V.ev[1];
        umin = Math.min(umin, u); umax = Math.max(umax, u); vmin = Math.min(vmin, v); vmax = Math.max(vmax, v);
      }
    }
  const lim = w.SIZE / 2 - 60;
  const smoothH = (x, z) => Math.abs(x) > lim || Math.abs(z) > lim ? -60 : (w.heightAt(x, z) * 2 + w.heightAt(x + 45, z) + w.heightAt(x - 45, z) + w.heightAt(x, z + 45) + w.heightAt(x, z - 45)) / 6;
  V.hsample = smoothH;
  for (let tm = 110; tm < 400; tm += 4) {
    V.scale(tm);
    V.i0 = Math.floor(umin / tm) - 2; V.i1 = Math.ceil(umax / tm) + 2; V.j0 = Math.floor(vmin / tm) - 2; V.j1 = Math.ceil(vmax / tm) + 2;
    const NI = V.i1 - V.i0, NJ = V.j1 - V.j0;
    if ((NI + NJ) * V.H > V.AW - 12) continue;
    let top = Infinity, floor = 0;
    for (let j = 0; j <= NJ; j++)
      for (let i = 0; i <= NI; i++) {
        const [x, z] = [(V.i0 + i) * tm * V.eu[0] + (V.j0 + j) * tm * V.ev[0], (V.i0 + i) * tm * V.eu[1] + (V.j0 + j) * tm * V.ev[1]];
        const hh = smoothH(x, z), lev = Math.max(0, Math.round(hh / V.levelM));
        top = Math.min(top, (i + j) * V.H * 0.5 - lev * V.lp);
        if (i === NI || j === NJ) floor = Math.min(floor, Math.round(hh / V.levelM));
      }
    V.base = Math.max(floor, -14) - 3;
    const bottom = (NI + NJ) * V.H * 0.5 - V.base * V.lp;
    if (bottom - top > V.AH - 14) continue;
    V.X0 = Math.round((V.AW - (NI + NJ) * V.H) / 2 - (V.i0 - V.j1) * V.H);
    V.Y0 = Math.round((V.AH - (bottom - top)) / 2 - top - (V.i0 + V.j0) * V.H * 0.5);
    break;
  }
  V.visible = () => true;
}

function fitLocal(w, V) {
  V.scale(V.tileM);
  const c = w.camp.at, e = [(V.eu[0] + V.ev[0]) * 0.5 * V.tileM, (V.eu[1] + V.ev[1]) * 0.5 * V.tileM];
  V.ox = c.x - e[0]; V.oz = c.z - e[1];
  const R = (V.AW / V.k) * 0.9;
  let hmin = Infinity, hmax = -Infinity;
  for (let a = -R; a <= R; a += R / 12) for (let b = -R; b <= R; b += R / 12) { const hh = Math.max(0, w.heightAt(c.x + a, c.z + b)); hmin = Math.min(hmin, hh); hmax = Math.max(hmax, hh); }
  // flat shores get lifted so their few meters read as steps; hill country is left near true scale
  if (V.relief) { V.exag = clamp((V.relief * (V.lp / (V.k * 0.866))) / Math.max(1, hmax - hmin), 1, V.exag); V.scale(V.tileM); }
  V.X0 = Math.round(V.AW * V.focus[0]);
  V.Y0 = Math.round(V.AH * V.focus[1] - V.H * 0.5 + Math.round(c.y / V.levelM) * V.lp);
  const lo = hmin / V.levelM, hi = hmax / V.levelM, hb = V.H * 0.5;
  const amin = -V.X0 / V.H - 2, amax = (V.AW - V.X0) / V.H + 2;
  const bmin = (lo * V.lp - V.Y0) / hb - 3, bmax = (V.AH - V.Y0 + hi * V.lp) / hb + 3;
  const bobj = bmax + (VIEW === "camp" ? 110 : 40) / hb; // tall sprites standing below the frame still reach into it
  V.i0 = Math.floor((amin + bmin) / 2); V.i1 = Math.ceil((amax + bobj) / 2);
  V.j0 = Math.floor((bmin - amax) / 2); V.j1 = Math.ceil((bobj - amin) / 2);
  V.visible = (u, v) => { const a = u - v, b = u + v; return a >= amin - 1 && a <= amax + 1 && b >= bmin && b <= bmax; };
  V.objVisible = (u, v) => { const a = u - v, b = u + v; return a >= amin - 1 && a <= amax + 1 && b >= bmin && b <= bobj; };
}

// ---------- the tile map ----------
function buildMap(w, V) {
  const { i0, j0, NI, NJ } = V, VI = NI + 1, n = NI * NJ, I = w.isle, N = w.N;
  const VL = new Int16Array(VI * (NJ + 1));
  for (let j = 0; j <= NJ; j++) for (let i = 0; i <= NI; i++) { const [x, z] = V.toW(i0 + i, j0 + j); VL[j * VI + i] = Math.round(V.hsample(x, z) / V.levelM); }
  const surfAt = (x, z) => {
    const cx = Math.round((x - w.START) / w.CELL), cy = Math.round((z - w.START) / w.CELL);
    let best = 0, bd = Infinity;
    for (let dy = -2; dy <= 2; dy++)
      for (let dx = -2; dx <= 2; dx++) {
        const X = cx + dx, Y = cy + dy;
        if (X < 0 || Y < 0 || X >= N || Y >= N || I.water[Y * N + X] <= 0) continue;
        if (dx * dx + dy * dy < bd) { bd = dx * dx + dy * dy; best = I.height[Y * N + X] + I.water[Y * N + X]; }
      }
    return best;
  };
  const M = { kind: new Uint8Array(n), wlev: new Int16Array(n), surf: new Float32Array(n), cls: new Uint8Array(n), C: new Int16Array(n * 4), diag: new Uint8Array(n), hc: new Float32Array(n), moist: new Float32Array(n), heath: new Float32Array(n), cov: COV.map(() => new Float32Array(n)) };
  const offs = VIEW === "island" ? [1 / 6, 0.5, 5 / 6].flatMap((a) => [1 / 6, 0.5, 5 / 6].map((b) => [a, b])) : [[0.5, 0.5], [0.22, 0.5], [0.78, 0.5], [0.5, 0.22], [0.5, 0.78]];
  for (let j = 0; j < NJ; j++)
    for (let i = 0; i < NI; i++) {
      const t = j * NI + i, cv = COV.map(() => 0);
      let wet = 0, m = 0, ex = 0;
      for (const [a, b] of offs) {
        const [x, z] = V.toW(i0 + i + a, j0 + j + b);
        wet += w.fine(w.wet, x, z);
        COV.forEach((k, q) => (cv[q] += w.fine(w.cover[k], x, z)));
        m += w.fine(w.moist, x, z);
        ex += w.bilinear(I.exposure, (x - w.START) / w.CELL, (z - w.START) / w.CELL);
      }
      wet /= offs.length; m /= offs.length; ex /= offs.length;
      const [x, z] = V.toW(i0 + i + 0.5, j0 + j + 0.5);
      const hh = V.hsample(x, z);
      M.hc[t] = hh; M.moist[t] = m;
      COV.forEach((k, q) => (M.cov[q][t] = cv[q] / offs.length));
      M.heath[t] = clamp(ex * 1.4 + M.cov[2][t] - m * 0.3, 0, 1);
      if (wet > 0.45 || (wet > 0.1 && hh < -0.5)) {
        const s = surfAt(x, z);
        M.kind[t] = s > 0.5 ? LAKE : SEA; M.surf[t] = s; M.wlev[t] = Math.round(s / V.levelM);
      } else {
        let best = 0, bs = -1;
        COV.forEach((k, q) => { const s = M.cov[q][t] * WEIGHT[q]; if (s > bs) { bs = s; best = q; } });
        M.cls[t] = best;
      }
    }
  // land touching standing water never dips under its surface
  const vi = (i, j) => j * VI + i;
  for (let j = 0; j < NJ; j++)
    for (let i = 0; i < NI; i++) {
      const t = j * NI + i;
      if (!M.kind[t]) continue;
      for (const [a, b] of [[0, 0], [1, 0], [1, 1], [0, 1]]) VL[vi(i + a, j + b)] = Math.max(VL[vi(i + a, j + b)], M.wlev[t]);
    }
  for (let k = 0; k < VL.length; k++) VL[k] = Math.max(0, VL[k]);
  const minCorner = (i, j) => Math.min(VL[vi(i, j)], VL[vi(i + 1, j)], VL[vi(i + 1, j + 1)], VL[vi(i, j + 1)]);
  // Streams become one-tile channels, walked from source to mouth so the water only ever steps down.
  for (const line of w.rivers) {
    let pts = line;
    if (w.heightAt(pts[0][0], pts[0][1]) < w.heightAt(pts.at(-1)[0], pts.at(-1)[1])) pts = [...pts].reverse();
    const path = [];
    let prev = null;
    for (let k = 0; k < pts.length - 1; k++) {
      const [ua, va] = V.toUV(pts[k][0], pts[k][1]), [ub, vb] = V.toUV(pts[k + 1][0], pts[k + 1][1]);
      const steps = Math.ceil(Math.hypot(ub - ua, vb - va) / 0.15) + 1;
      for (let s = 0; s <= steps; s++) {
        const u = ua + ((ub - ua) * s) / steps, v = va + ((vb - va) * s) / steps, ti = Math.floor(u) - i0, tj = Math.floor(v) - j0;
        if (prev && ti === prev[0] && tj === prev[1]) continue;
        if (prev && ti !== prev[0] && tj !== prev[1]) {
          const da = Math.hypot(u - (i0 + ti + 0.5), v - (j0 + prev[1] + 0.5)), db = Math.hypot(u - (i0 + prev[0] + 0.5), v - (j0 + tj + 0.5));
          path.push(da < db ? [ti, prev[1]] : [prev[0], tj]);
        }
        path.push([ti, tj]);
        prev = [ti, tj];
      }
    }
    let lev = Infinity;
    for (const [ti, tj] of path) {
      if (ti < 0 || tj < 0 || ti >= NI || tj >= NJ) continue;
      const t = tj * NI + ti;
      if (M.kind[t] === SEA || M.kind[t] === LAKE) { lev = M.wlev[t]; continue; }
      lev = Math.min(lev, minCorner(ti, tj));
      if (M.kind[t] === RIVER) { M.wlev[t] = Math.min(M.wlev[t], lev); continue; }
      M.kind[t] = RIVER; M.wlev[t] = lev; M.surf[t] = lev * V.levelM;
    }
  }
  for (let j = 0; j < NJ; j++)
    for (let i = 0; i < NI; i++) {
      const t = j * NI + i;
      let c = [VL[vi(i, j)], VL[vi(i + 1, j)], VL[vi(i + 1, j + 1)], VL[vi(i, j + 1)]];
      if (M.kind[t]) c = [M.wlev[t], M.wlev[t], M.wlev[t], M.wlev[t]];
      else {
        const lo = Math.min(...c), hi = Math.max(...c);
        if (hi - lo > 1) {
          // too steep for a slope tile: keep a one-step shape and let cliff strips take the rest
          const b = clamp(Math.floor(M.hc[t] / V.levelM), lo, hi - 1);
          c = c.map((q) => clamp(q, b, b + 1));
        }
      }
      M.C.set(c, t * 4);
      const dTB = Math.abs(c[0] - c[2]), dLR = Math.abs(c[3] - c[1]);
      M.diag[t] = dTB < dLR ? 0 : dLR < dTB ? 1 : c[0] + c[2] > c[1] + c[3] ? 0 : 1;
    }
  M.maxLev = Math.max(...M.C);
  M.at = (i, j) => (i >= 0 && j >= 0 && i < NI && j < NJ ? j * NI + i : -1);
  // The rendered ground level under (u, v), on the same triangles the tile was drawn with.
  M.ground = (u, v) => {
    const i = Math.floor(u) - i0, j = Math.floor(v) - j0, t = M.at(i, j);
    if (t < 0) return null;
    const fu = u - Math.floor(u), fv = v - Math.floor(v), [T, R, B, L] = M.C.subarray(t * 4, t * 4 + 4);
    let lev;
    if (M.diag[t] === 0) lev = fu >= fv ? T + (R - T) * fu + (B - R) * fv : T + (B - L) * fu + (L - T) * fv;
    else lev = fu + fv <= 1 ? T + (R - T) * fu + (L - T) * fv : R + L - B + (B - L) * fu + (B - R) * fv;
    return { lev, t, water: M.kind[t] };
  };
  return M;
}

// Ground in the shadow of higher ground: march toward a low sun on the rendered tiles.
function shadowTest(V, M) {
  const rise = (Math.tan(V.tsun) * V.tileM) / (V.lp / (V.k * 0.866)), step = 0.3, su = -V.sd[0] * step, sv = -V.sd[1] * step;
  return (u, v, lev) => {
    let cu = u, cv = v;
    for (let k = 1; k < 80; k++) {
      cu += su; cv += sv;
      const need = lev + rise * step * k;
      if (need > M.maxLev) return false;
      const g = M.ground(cu, cv);
      if (!g) return false;
      if (g.lev > need + 0.05) return true;
    }
    return false;
  };
}

// ---------- terrain textures ----------
function flowerCol(wx, wz) {
  return FLOWER[Math.floor((fbm(wx / 70, wz / 70, 51, 2) + 0.6) * 3.3 + 10) % FLOWER.length];
}
function texWater(w, V, K, x, y, wx, wz, fu, fv) {
  const H = V.H, dU0 = fu * H, dU1 = (1 - fu) * H, dV0 = fv * H, dV1 = (1 - fv) * H, ln = K.ln;
  let d = 99;
  if (ln & 1) d = Math.min(d, dU0);
  if (ln & 2) d = Math.min(d, dU1);
  if (ln & 4) d = Math.min(d, dV0);
  if (ln & 8) d = Math.min(d, dV1);
  if (ln & 16) d = Math.min(d, Math.max(dU0, dV0));
  if (ln & 32) d = Math.min(d, Math.max(dU1, dV0));
  if (ln & 64) d = Math.min(d, Math.max(dU0, dV1));
  if (ln & 128) d = Math.min(d, Math.max(dU1, dV1));
  const fw = V.foam;
  if (d < fw * 0.55 && h2(x, y, 44) < 0.82) return P.w7;
  if (d < fw && h2(x, y, 45) < 0.45) return P.w6;
  let v;
  if (K.kind === RIVER) v = 4.1 + (h2(x, y, 46) - 0.5) * 0.7 + (d < fw * 2 ? 0.4 : 0);
  else {
    const depth = K.surf - w.heightAt(wx, wz);
    v = (VIEW === "island" ? 1.8 : 1.4) + 3.4 * (1 - smooth(0, V.deep, depth)) + fbm(wx / (V.tileM * 4), wz / (V.tileM * 4), 41, 2) * 0.6;
    if (d < fw * 2.4) v += 0.6;
  }
  if (V.detail) {
    const row = y >> 2, seg = (x + row * 7) >> 2;
    if ((y & 3) === 0 && h2(seg, row, 42) < 0.15) v += 1.1;
  } else if ((y & 1) === 0 && h2(x >> 1, y, 42) < 0.06) v += 0.9;
  if (h2(x, y, 43) < V.sparkle || h2(x - 1, y, 43) < V.sparkle * 0.7) return P.w7;
  return dith(WA, v, x, y);
}

function texTop(w, V, K, x0, y0, wx, wz, lev, s, fu, fv) {
  if (K.kind) return texWater(w, V, K, x0, y0, wx, wz, fu, fv);
  const c = texLand(w, V, K, x0, y0, wx, wz, lev, s, fu, fv);
  return V.grid && (fu * V.H < 1 || fv * V.H < 1) && h2(x0, y0, 96) < V.grid ? DARKER[DARKER[c]] : c;
}
function texLand(w, V, K, x0, y0, wx, wz, lev, s, fu, fv) {
  const H = V.H;
  // Fine pattern in tile-local pixels: every tile repeats one of a few hand-made looking stamps, as real tile sets did.
  const x = x0 - K.ox, y = Math.round(y0 - K.oy + lev * V.lp);
  let edge = 0;
  if (K.rimU && (1 - fu) * H < 1) edge += 0.5;
  if (K.rimV && (1 - fv) * H < 1) edge += 0.8;
  if (K.aoU && fu * H < 1.7) edge -= 0.9;
  if (K.aoV && fv * H < 1.7) edge -= 0.9;
  if (V.trodden) {
    const t = V.trodden(wx, wz);
    if (t < 0 || (t < V.fringe && h2(x, y, 90) < (1 - t / V.fringe) * 0.55)) {
      if (h2(x, y, 91) < 0.03) return P.r3;
      if (h2(x, y - 1, 91) < 0.03) return P.r1;
      return dith(DI, (VIEW === "valley" ? 3.5 : 2.9) + s + fbm(wx / 3, wz / 3, 92, 2) * 0.9 + edge + (h2(x, y, 93) - 0.5) * 0.7, x0, y0);
    }
  }
  const mot = fbm(wx / V.ms, wz / V.ms, 11, 2) + K.var;
  switch (K.cls) {
    case FOREST: {
      const v = 2.0 + s * 0.8 + mot * 0.9 + edge + (h2(x, y, 1) - 0.5) * 0.7;
      if (V.detail) { const q = h2(x, y, 4); if (q < 0.05) return P.d2; if (q < 0.065) return P.d3; if (q > 0.975) return P.g3; }
      return dith(FF, v, x0, y0);
    }
    case SCRUB: {
      if (V.detail && K.heath > 0.45 && h2(x, y, 6) < 0.05) return P.violet;
      return dith(SC, 3.0 + s + mot + (h2(x >> 1, y >> 1, 5) - 0.5) * 1.5 + edge, x0, y0);
    }
    case SAND: {
      let v = 2.5 + s * 0.7 + mot * 0.5 + edge + (h2(x, y, 1) - 0.5) * 0.4;
      if (V.detail) {
        const r = (wx * 0.6 + wz * 0.8) / V.rip + fbm(wx / (V.rip * 8), wz / (V.rip * 8), 61, 2) * 2, f = r - Math.floor(r);
        if (f < 0.13) v -= 0.9; else if (f < 0.22) v += 0.35;
      }
      if (lev < 0.5 && K.wet) v -= 1.0;
      if (h2(x, y, 7) < 0.02) return P.d4;
      return dith(SA, v, x0, y0);
    }
    case ROCK: {
      // stones: cells of a jittered grid, each lit on its upper left, with dark cracks between
      const gx = x / V.cell[0], gy = y / V.cell[1], ix = Math.floor(gx), iy = Math.floor(gy);
      let f1 = 9, f2 = 9, ox = 0, oy = 0, id = 0;
      for (let j = -1; j <= 1; j++)
        for (let i = -1; i <= 1; i++) {
          const cx = ix + i + 0.15 + 0.7 * h2(ix + i, iy + j, 23), cy = iy + j + 0.15 + 0.7 * h2(ix + i, iy + j, 24);
          const d = (gx - cx) ** 2 + (gy - cy) ** 2;
          if (d < f1) { f2 = f1; f1 = d; ox = gx - cx; oy = gy - cy; id = h2(ix + i, iy + j, 25); } else if (d < f2) f2 = d;
        }
      if (Math.sqrt(f2) - Math.sqrt(f1) < 0.16) return K.grass > 0.25 && id < 0.4 ? P.g1 : P.r0;
      if (K.grass > 0.3 && id < 0.18) return dith(GR, 2.6 + s - (ox + oy) * 1.2, x0, y0);
      return dith(RK, 2.7 + s * 0.9 + mot * 0.4 - (ox * 0.8 + oy * 1.0) * 1.9 + (id - 0.5) * 1.1 + edge, x0, y0);
    }
    case MARSH: {
      const pool = (a, b) => noise(a / V.pm, b / V.pm, 31) + 0.3 * noise(a / (V.pm * 0.4), b / (V.pm * 0.4), 32);
      const pn = pool(wx, wz);
      if (pn > 0.32) {
        const up = pool(wx + V.upW[0], wz + V.upW[1]);
        return up <= 0.32 ? P.m0 : dith(WA, 3.3 + (pn - 0.32) * 2.5 + (h2(x, y, 8) < 0.05 ? 2 : 0), x0, y0);
      }
      return dith(MA, 2.3 + s + mot + edge + (h2(x, y, 1) - 0.5) * 0.8, x0, y0);
    }
    default: {
      let v = 3.1 + s + mot * 1.2 + (K.moist - 0.5) * 0.8 + edge + (h2(x, y, 1) - 0.5) * 0.45;
      if (V.detail) {
        if (h2(x, y, 2) < 0.08) v += 1.2;
        else if (h2(x, y - 1, 2) < 0.08) v -= 1.0;
        if (h2(x, y, 3) < K.flowers * Math.max(0, fbm(wx / (V.tileM * 1.6), wz / (V.tileM * 1.6), 52, 2) + 0.12) * 5) return flowerCol(wx, wz);
      }
      if (K.wet && lev < 0.5) v -= 0.6;
      return dith(GR, v, x0, y0);
    }
  }
}

const FALL = 1, ROCKW = 2, DIRTW = 3, SECT = 4;
function texWall(V, mat, face, x, y, depth, hpx, lev, veg, floorLev) {
  const bottom = hpx - depth < 1;
  if (mat === SECT) {
    if (bottom) return P.ink;
    if (lev > floorLev + 0.01) {
      if (depth < 1) return P.w5;
      return dith(WA, (face ? 1.6 : 2.3) + (h2(x, y, 80) - 0.5) * 0.5 + (lev - floorLev) * 0.05, x, y);
    }
    const below = (floorLev - lev) * V.lp;
    if (below < 1) return face ? P.s0 : P.s1;
    const layer = Math.floor((below + h2(x >> 2, 3, 81) * 1.5) / 4);
    const r = layer > 3 ? RK : DI;
    return dith(r, (face ? 1.5 : 2.4) + (layer & 1 ? 0.6 : 0) + (h2(x, y, 82) - 0.5) * 0.6 - (layer > 3 ? 0.4 : 0), x, y);
  }
  if (mat === FALL) {
    if (hpx - depth < 2) return h2(x, y, 72) < 0.7 ? P.w7 : P.w6;
    return dith(WA, 4.7 + (h2(x, 7, 70) - 0.5) * 2 + (h2(x, y >> 1, 71) - 0.5) * 0.8 - face * 0.7, x, y);
  }
  if (veg && depth < 1) return face ? P.g2 : P.g3;
  if (veg && depth < 2 && h2(x, 0, 73) < 0.5) return face ? P.g1 : P.g2;
  if (mat === ROCKW) {
    const v = (face ? 1.9 : 3.1) + (h2(x, 11, 74) < 0.2 ? -1.1 : 0) + (Math.floor((lev * V.lp) / 4) & 1 ? 0.4 : -0.2) + (h2(x, y, 75) - 0.5) * 0.7 - (bottom ? 1 : 0);
    return dith(RK, v, x, y);
  }
  if (h2(x, y, 78) < 0.035) return face ? P.r2 : P.r3;
  const band = Math.floor((lev * V.lp) / 3 + h2(x >> 2, 0, 76) * 0.6);
  return dith(DI, (face ? 1.8 : 2.9) + (band & 1 ? 0.35 : -0.25) + (h2(x, y, 77) - 0.5) * 0.6 - (bottom ? 1 : 0), x, y);
}

function drawTerrain(B, w, V, M) {
  const { NI, NJ, i0, j0 } = V, C = M.C;
  const corner = (t, k) => C[t * 4 + k];
  const land = (i, j) => { const t = M.at(i, j); return t >= 0 && !M.kind[t]; };
  const water = (i, j) => { const t = M.at(i, j); return t >= 0 && M.kind[t] === SEA; };
  for (let s = 0; s < NI + NJ - 1; s++)
    for (let i = Math.max(0, s - NJ + 1); i <= Math.min(NI - 1, s); i++) {
      const j = s - i, t = j * NI + i, uT = i0 + i, vT = j0 + j;
      if (!V.visible(uT + 0.5, vT + 0.5)) continue;
      const c = [corner(t, 0), corner(t, 1), corner(t, 2), corner(t, 3)];
      const P4 = [[uT, vT, c[0]], [uT + 1, vT, c[1]], [uT + 1, vT + 1, c[2]], [uT, vT + 1, c[3]]];
      const tu = M.at(i + 1, j), tv = M.at(i, j + 1), bu = M.at(i - 1, j), bv = M.at(i, j - 1);
      const K = {
        kind: M.kind[t], cls: M.cls[t], surf: M.surf[t], moist: M.moist[t], heath: M.heath[t], grass: M.cov[0][t],
        var: (h2(i, j, 99) - 0.5) * (VIEW === "island" ? 0.5 : 0.25),
        flowers: 0.012 * smooth(0.3, 0.8, M.cov[0][t]),
        rimU: tu >= 0 && (corner(tu, 0) < c[1] || corner(tu, 3) < c[2]),
        rimV: tv >= 0 && (corner(tv, 0) < c[3] || corner(tv, 1) < c[2]),
        aoU: bu >= 0 && (corner(bu, 1) > c[0] || corner(bu, 2) > c[3]),
        aoV: bv >= 0 && (corner(bv, 3) > c[0] || corner(bv, 2) > c[1]),
        wet: water(i - 1, j) || water(i + 1, j) || water(i, j - 1) || water(i, j + 1),
        ln: 0, ox: V.sx(uT, vT) - Math.floor(h2(i, j, 7) * 3) * 37, oy: V.sy(uT, vT, 0),
      };
      if (K.kind) {
        [[-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [1, -1], [-1, 1], [1, 1]].forEach(([a, b], q) => { if (land(i + a, j + b)) K.ln |= 1 << q; });
      }
      // cliff strips on the two faces that look at the camera
      for (const face of [0, 1]) {
        const nb = face ? tu : tv;
        const [A, Bk] = face ? [2, 1] : [3, 2]; // this tile's corners along the edge, left to right on screen
        const nA = face ? 3 : 0, nB = face ? 0 : 1; // the neighbour's matching corners
        let botA, botB, mat, floorA = 0, floorB = 0;
        if (nb >= 0) {
          botA = corner(nb, nA); botB = corner(nb, nB);
          if (botA >= c[A] && botB >= c[Bk]) continue;
          const drop = Math.max(c[A] - botA, c[Bk] - botB);
          mat = M.kind[t] && M.kind[nb] ? FALL : K.cls === ROCK || drop >= 6 || (M.kind[t] === 0 && M.hc[t] > 200) ? ROCKW : DIRTW;
        } else if (VIEW === "island") {
          botA = botB = V.base; mat = SECT;
          const fl = (u, v) => { const [x, z] = V.toW(u, v); return clamp(Math.round(V.hsample(x, z) / V.levelM), V.base + 2, 0); };
          floorA = M.kind[t] ? fl(P4[A][0], P4[A][1]) : c[A]; floorB = M.kind[t] ? fl(P4[Bk][0], P4[Bk][1]) : c[Bk];
        } else continue;
        const pa = P4[A], pb = P4[Bk];
        const veg = !M.kind[t] && K.cls !== ROCK && K.cls !== SAND;
        strip(B, V.sx(pa[0], pa[1]), V.sx(pb[0], pb[1]), V.sy(pa[0], pa[1], pa[2]), V.sy(pb[0], pb[1], pb[2]), V.sy(pa[0], pa[1], botA), V.sy(pb[0], pb[1], botB), (p, x, y, tt, depth, hpx) => {
          const u = pa[0] + (pb[0] - pa[0]) * tt, v = pa[1] + (pb[1] - pa[1]) * tt;
          const lev = (V.Y0 + (u + v) * V.H * 0.5 - (y + 0.5)) / V.lp;
          B.c[p] = texWall(V, mat, face ? 1 : 0, x, y, depth, hpx, lev, veg, floorA + (floorB - floorA) * tt);
          B.z[p] = V.cz(u, v, lev); B.id[p] = 0;
        });
      }
      const tris = M.diag[t] === 0 ? [[0, 1, 2], [0, 2, 3]] : [[0, 1, 3], [3, 1, 2]];
      for (const [a, b, cc] of tris) {
        const A = P4[a], Bv = P4[b], Cv = P4[cc];
        const e1 = [Bv[0] - A[0], Bv[1] - A[1], Bv[2] - A[2]], e2 = [Cv[0] - A[0], Cv[1] - A[1], Cv[2] - A[2]];
        const det = e1[0] * e2[1] - e1[1] * e2[0];
        const du = (e1[2] * e2[1] - e1[1] * e2[2]) / det, dv = (e1[0] * e2[2] - e1[2] * e2[0]) / det;
        const s = K.kind ? 0 : Math.round(clamp(V.gain * (-LU * du - LV * dv), -2, 2) * 2) / 2;
        tri(B, V.sx(A[0], A[1]), V.sy(A[0], A[1], A[2]), V.sx(Bv[0], Bv[1]), V.sy(Bv[0], Bv[1], Bv[2]), V.sx(Cv[0], Cv[1]), V.sy(Cv[0], Cv[1], Cv[2]), (p, x, y, la, lb, lc) => {
          const u = la * A[0] + lb * Bv[0] + lc * Cv[0], v = la * A[1] + lb * Bv[1] + lc * Cv[1], lev = la * A[2] + lb * Bv[2] + lc * Cv[2];
          const [wx, wz] = V.toW(u, v);
          let col = texTop(w, V, K, x, y, wx, wz, lev, s, u - uT, v - vT);
          if (V.shaded && V.shaded(u, v, lev)) { col = SHADOW[col]; B.sh[p] = 1; }
          B.c[p] = col; B.z[p] = V.cz(u, v, lev); B.id[p] = 0;
        });
      }
    }
}

// ---------- objects ----------
const cache = new Map();
const cached = (key, make) => { let s = cache.get(key); if (!s) { s = make(); cache.set(key, s); } return s; };

function place(V, M, x, z) {
  const [u, v] = V.toUV(x, z), g = M.ground(u, v);
  if (!g) return null;
  return { u, v, g, sx: Math.round(V.sx(u, v)), sy: Math.round(V.sy(u, v, g.lev)), z: V.cz(u, v, g.lev) };
}

function collectObjects(w, V, M) {
  const O = [];
  const add = (at, spr, opt = {}) => O.push({ z: at.z, sx: at.sx, sy: at.sy, spr, shadow: opt.shadow !== false, mirror: !!opt.mirror, bias: opt.bias ?? V.H * 0.5 + 2 });
  if (VIEW === "island") {
    const n = V.NI * V.NJ, count = new Float32Array(n), pines = new Float32Array(n), gold = new Float32Array(n);
    for (const t of w.trees) {
      const [u, v] = V.toUV(t.x, t.z), k = M.at(Math.floor(u) - V.i0, Math.floor(v) - V.j0);
      if (k < 0) continue;
      count[k]++;
      if (t.kind === "pine") pines[k]++;
      else if (t.kind === "aspen" && t.tint > 0.8) gold[k]++;
    }
    // three ramps per kind: on ground facing away from the light, flat, facing it
    const RP = {
      pine: [[P.p1, P.p2, P.p3], [P.p1, P.p3, P.p4], [P.p2, P.p4, P.g4]],
      oak: [[P.t1, P.t3, P.g3], [P.t2, P.g3, P.g4], [P.t3, P.g4, P.g5]],
      ash: [[P.t2, P.g3, P.g4], [P.g2, P.g4, P.g5], [P.g3, P.g5, P.g6]],
      gold: [[P.d1, P.a1, P.a2], [P.a0, P.a2, P.a3], [P.a1, P.a3, P.s3]],
    };
    const [cu, cv] = V.toUV(w.camp.at.x, w.camp.at.z), ci = Math.floor(cu) - V.i0, cj = Math.floor(cv) - V.j0;
    for (let j = 0; j < V.NJ; j++)
      for (let i = 0; i < V.NI; i++) {
        const t = j * V.NI + i;
        if (M.kind[t] || count[t] < 3 || (i === ci && j === cj)) continue;
        const m = clamp(Math.round(M.cov[1][t] * 6.5 - 0.9 + h2(t, 9, 9) * 0.8), 0, 5);
        for (let q = 0; q < m; q++) {
          const fu = 0.12 + 0.76 * h2(t, q, 1), fv = 0.12 + 0.76 * h2(t, q, 2), r = h2(t, q, 3);
          const pine = r < pines[t] / count[t], isGold = !pine && h2(t, q, 4) < gold[t] / count[t];
          const kind = pine ? (h2(t, q, 5) < 0.5 ? "pine" : "pine2") : h2(t, q, 5) < 0.6 ? "broad" : "broad2";
          const rp = pine ? "pine" : isGold ? "gold" : M.moist[t] > 0.6 ? "ash" : "oak";
          const u = V.i0 + i + fu, v = V.j0 + j + fv, g = M.ground(u, v);
          const c = M.C.subarray(t * 4, t * 4 + 4), du = (c[1] + c[2] - c[0] - c[3]) / 2, dv = (c[2] + c[3] - c[0] - c[1]) / 2;
          const lit = V.shaded && V.shaded(u, v, g.lev) ? 0 : clamp(Math.round(-LU * du - LV * dv) + 1, 0, 2);
          add({ z: V.cz(u, v, g.lev), sx: Math.round(V.sx(u, v)), sy: Math.round(V.sy(u, v, g.lev)) }, cached(kind + rp + lit, () => SP.mini(kind, RP[rp][lit])), { bias: 2 });
        }
      }
    const camp = place(V, M, w.camp.at.x, w.camp.at.z);
    if (camp) {
      add(camp, cached("minitent", () => SP.miniTent()), { bias: 4 });
      add({ ...camp, sx: camp.sx + 5, sy: camp.sy + 1, z: camp.z + 3 }, cached("minitent", () => SP.miniTent()), { bias: 4 });
      add({ ...camp, sx: camp.sx - 4, sy: camp.sy + 2, z: camp.z + 4 }, cached("minitent", () => SP.miniTent()), { bias: 4 });
      V.fireAt = { x: camp.sx + 1, y: camp.sy + 3, r: 5 };
      V.smokes = [{ x: camp.sx + 1, y: camp.sy + 1, h: 24, r: 1.3, drift: -0.6 }];
    }
    return O;
  }
  const pv = V.k * 0.866; // true-scale pixels per vertical meter
  trodden(w, V);
  const fire = w.camp.fire, spread = V.campOff - 1;
  // the camp is drawn spread out, so the clearing world.js made around it is widened by the same amount
  const clear = (x, z, r0, r1) => { const d = Math.hypot(x - fire.x, z - fire.z); return spread > 0 && (d < r0 * V.campOff || (d < r1 * V.campOff && h2(Math.round(x * 10), Math.round(z * 10), 5) < (r1 * V.campOff - d) / (r1 * V.campOff - r0 * V.campOff))); };
  const inView = (x, z) => { const [u, v] = V.toUV(x, z); return V.objVisible(u, v); };
  for (const t of w.trees) {
    if (!inView(t.x, t.z) || clear(t.x, t.z, 22, 40)) continue;
    const at = place(V, M, t.x, t.z);
    if (!at || at.g.water) continue;
    const hp = Math.round(t.tall * pv * V.treeK), vr = Math.floor(t.tint * 5);
    const spr = t.kind === "pine" ? cached(`p${hp}|${vr}`, () => SP.pine(hp, vr * 17 + hp)) : cached(`${t.kind}${hp}|${vr}|${t.tint > 0.8 ? 1 : 0}`, () => SP.broad(hp, t.kind, vr * 31 + hp, t.tint));
    add(at, spr, { mirror: t.yaw > Math.PI });
  }
  for (const s of w.shrubs) {
    if (!inView(s.x, s.z) || clear(s.x, s.z, 14, 26)) continue;
    const at = place(V, M, s.x, s.z);
    if (!at || at.g.water) continue;
    const sz = Math.max(2, Math.round(s.tall * pv * (VIEW === "camp" ? 0.9 : 1.7))), vr = Math.floor(s.tint * 4);
    add(at, cached(`b${sz}|${vr}|${s.heath > 0.5 ? 1 : 0}`, () => SP.bush(sz, vr * 13 + sz, s.heath, s.tint)), { mirror: s.yaw > Math.PI });
  }
  for (const r of w.rocks) {
    if (!inView(r.x, r.z) || clear(r.x, r.z, 12, 20)) continue;
    const at = place(V, M, r.x, r.z);
    if (!at || at.g.water) continue;
    const sz = Math.max(1.5, r.size * pv * (VIEW === "camp" ? 0.9 : 1.4)), vr = Math.floor(r.tint * 4), moss = w.fine(w.cover.tree, r.x, r.z);
    add(at, cached(`r${Math.round(sz * 2)}|${vr}|${moss > 0.4 ? 1 : 0}`, () => SP.rock(sz, vr * 7 + 3, moss)), { mirror: r.yaw > Math.PI });
  }
  // reeds along marsh tiles and wet margins
  for (let j = 0; j < V.NJ; j++)
    for (let i = 0; i < V.NI; i++) {
      const t = j * V.NI + i;
      if (M.kind[t] || M.cov[3][t] < 0.25 || !V.objVisible(V.i0 + i + 0.5, V.j0 + j + 0.5)) continue;
      const n = Math.round(M.cov[3][t] * (VIEW === "camp" ? 3 : 5));
      for (let q = 0; q < n; q++) {
        const u = V.i0 + i + h2(t, q, 11), v = V.j0 + j + h2(t, q, 12), g = M.ground(u, v);
        if (!g || g.water) continue;
        const hp = Math.round((1.2 + h2(t, q, 13)) * pv * (VIEW === "camp" ? 1 : 2.4));
        add({ z: V.cz(u, v, g.lev), sx: Math.round(V.sx(u, v)), sy: Math.round(V.sy(u, v, g.lev)) }, cached(`reed${hp}|${q % 4}`, () => SP.reeds(hp, q * 5 + hp)), { shadow: false });
      }
    }
  if (VIEW === "camp") {
    const near = w.nearby(w.camp.at, 45, 3.6);
    for (const g of near.grass) {
      if (V.trodden(g.x, g.z) < 0) continue;
      const at = place(V, M, g.x, g.z);
      if (!at || at.g.water || !V.objVisible(at.u, at.v)) continue;
      const hp = Math.round(g.tall * pv * 0.95), vr = Math.floor(g.tint * 6);
      add(at, cached(`t${hp}|${vr}`, () => SP.tuft(hp, vr * 3 + hp, w.fine(w.cover.shrub, g.x, g.z))), { shadow: false, bias: 1, mirror: g.yaw > Math.PI });
    }
    for (const f of near.flowers) {
      if (V.trodden(f.x, f.z) < 0) continue;
      const at = place(V, M, f.x, f.z);
      if (!at || at.g.water || !V.objVisible(at.u, at.v)) continue;
      const hp = Math.round(f.tall * pv * 1.4);
      add(at, cached(`f${hp}|${Math.floor(f.hue * 6)}`, () => SP.flower(hp, f.hue, hp)), { shadow: false, bias: 1 });
    }
    for (const p of near.pebbles) {
      const at = place(V, M, p.x, p.z);
      if (!at || at.g.water) continue;
      const sz = p.size * pv * 0.7;
      add(at, cached(`pb${Math.round(sz)}`, () => (sz < 3 ? SP.pebble(sz, Math.round(p.size * 10)) : SP.rock(sz, Math.round(p.size * 10), 0))), { shadow: sz >= 3, bias: 1 });
    }
  }
  campObjects(w, V, M, O, add, pv);
  return O;
}

// Where people have worn the grass away: round the fire, under the tents, by the woodpile, and the paths between.
function trodden(w, V) {
  const cp = w.camp, fire = cp.fire, off = V.campOff, K = V.campK;
  const moved = (p) => ({ x: fire.x + (p.x - fire.x) * off, z: fire.z + (p.z - fire.z) * off });
  const tents = cp.tents.map((t) => ({ ...moved(t.at), size: t.size * K })), wp = moved(cp.woodpile);
  const seg = (x, z, b) => { const dx = b.x - fire.x, dz = b.z - fire.z, t = clamp(((x - fire.x) * dx + (z - fire.z) * dz) / (dx * dx + dz * dz), 0, 1); return Math.hypot(x - fire.x - dx * t, z - fire.z - dz * t); };
  V.trodden = (x, z) => {
    let d = Math.hypot(x - fire.x, z - fire.z) - 3.4 * K;
    d = Math.min(d, Math.hypot(x - wp.x, z - wp.z) - 1.4 * K);
    // worn paths from the fire to each tent door and to the woodpile
    const wob = fbm(x / (1.5 * K), z / (1.5 * K), 94, 2) * 0.35 * K;
    d = Math.min(d, seg(x, z, wp) - 0.45 * K + wob);
    for (const t of tents) d = Math.min(d, Math.hypot(x - t.x, z - t.z) - t.size * 0.7, seg(x, z, t) - 0.6 * K + wob);
    return d;
  };
  V.fringe = 1.6 * K;
}

// The camp: tents as little 3D meshes, people and woodpile as sprites, the fire with stones, flames, glow and smoke.
function campObjects(w, V, M, O, add, pv) {
  const cp = w.camp, fire = cp.fire, off = V.campOff, K = V.campK;
  const moved = (p) => ({ x: fire.x + (p.x - fire.x) * off, z: fire.z + (p.z - fire.z) * off });
  const tents = cp.tents.map((t, k) => ({ ...moved(t.at), size: t.size * K, k }));
  const wp = moved(cp.woodpile);
  tents.forEach((t) => O.push(tentMesh(w, V, M, t, fire)));
  const around = VIEW === "valley" ? 4.5 : 1;
  cp.people.forEach((p, k) => {
    const q = { x: fire.x + (p.at.x - fire.x) * around, z: fire.z + (p.at.z - fire.z) * around }, at = place(V, M, q.x, q.z);
    if (!at) return;
    const dx = fire.x - q.x, dz = fire.z - q.z, du = dx * V.eu[0] + dz * V.eu[1], dv = dx * V.ev[0] + dz * V.ev[1];
    const toCam = du + dv, across = du - dv;
    const facing = Math.abs(across) > Math.abs(toCam) * 1.3 ? "side" : toCam > 0 ? "front" : "back";
    const pose = k === 1 || k === 3 ? "sit" : "stand";
    const hp = 1.75 * pv * K * (VIEW === "valley" ? 1.45 : 1);
    const spr = cached(`man${k}|${facing}|${hp > 12}`, () => SP.person(hp, P["c" + k], facing, pose, k * 7 + 1, across > 0 ? 1 : 0));
    add(at, spr, { mirror: facing !== "side" && across < 0, bias: 3 });
  });
  const wpAt = place(V, M, wp.x, wp.z);
  if (wpAt) add(wpAt, cached("wood", () => SP.woodpile(Math.max(1, Math.round(0.14 * pv * K)), 3)));
  const f = place(V, M, fire.x, fire.z);
  if (!f) return;
  // ring of stones
  for (let k = 0; k < 9; k++) {
    const a = (k / 9) * Math.PI * 2 + 0.3, r = 0.62 * K;
    const at = place(V, M, fire.x + Math.cos(a) * r, fire.z + Math.sin(a) * r);
    if (at) add(at, cached(`st${k % 3}`, () => SP.rock(Math.max(1.5, 0.28 * pv * K), k % 3, 0)), { shadow: false, bias: 1 });
  }
  const fl = Math.max(4, Math.round(1.25 * pv * K * (VIEW === "valley" ? 1.1 : 1)));
  add({ ...f, z: f.z + 1 }, cached("embers", () => embers(fl)), { shadow: false, bias: 2 });
  add({ ...f, z: f.z + 2, sy: f.sy + 1 }, cached("flames", () => SP.flames(fl, 5)), { shadow: false, bias: 3 });
  V.fireAt = { x: f.sx, y: f.sy, r: Math.round(3.6 * pv * K * (VIEW === "valley" ? 1.3 : 1)) };
  const wind = w.isle.wind || [1, 0], wu = wind[0] * V.eu[0] + wind[1] * V.eu[1], wv = wind[0] * V.ev[0] + wind[1] * V.ev[1];
  V.smokes = [{ x: f.sx, y: f.sy - fl, h: VIEW === "camp" ? 250 : 110, r: VIEW === "camp" ? 6 : 3, drift: clamp((wu - wv) * 0.3, -0.45, 0.45) }];
}

function embers(fl) {
  const w = Math.max(5, Math.round(fl * 1.3)), S = new Spr(w + 2, 5, (w + 2) >> 1, 3);
  for (let x = 0; x < w + 2; x++) {
    const d = Math.abs(x - (w + 2) / 2) / ((w + 2) / 2);
    S.set(x, 3, d < 0.9 ? (h2(x, 1) < 0.4 ? P.f1 : P.d0) : 255);
    S.set(x, 2, d < 0.6 ? (h2(x, 2) < 0.5 ? P.f0 : P.ink) : 255);
  }
  return S;
}

// A pitched tent or a pole tent, built from triangles so its slopes shade and sort like the ground.
function tentMesh(w, V, M, t, fire) {
  const at = place(V, M, t.x, t.z);
  const dirx = fire.x - t.x, dirz = fire.z - t.z, dl = Math.hypot(dirx, dirz) || 1, fx = dirx / dl, fz = dirz / dl;
  const base = at ? at.g.lev : 0, s = t.size, vert = 1 / (V.levelM * V.exag);
  // local (a toward the fire, b across, h up) in meters to (u, v, level), keeping the local point for texturing
  const P3 = (a, b, hh) => { const x = t.x + fx * a - fz * b, z = t.z + fz * a + fx * b, [u, v] = V.toUV(x, z); return [u, v, base + hh * vert, a, b, hh]; };
  const faces = [];
  const cloth = [P.c0, P.c1, P.c2, P.c3, P.c4][t.k + 1] ?? P.c0;
  const mats = [
    { r: ramp("d2", "d3", "s0", "s1", "s2", "s3"), seam: P.s0 },
    { r: ramp("d0", "d1", "d2", "d3", "d4", "d5"), seam: P.d1 },
    { r: ramp("d1", "d2", "d3", "d4", "d5", "s2"), seam: P.d2 },
  ];
  const mat = mats[t.k % 3];
  if (t.k === 2) {
    // pole tent: a cone of hide on a ring of poles
    const r = s * 0.55, hh = s * 1.0, n = 16, apex = P3(0, 0, hh);
    for (let q = 0; q < n; q++) {
      const a0 = (q / n) * Math.PI * 2, a1 = ((q + 1) / n) * Math.PI * 2;
      faces.push({ p: [P3(Math.cos(a0) * r, Math.sin(a0) * r, 0), P3(Math.cos(a1) * r, Math.sin(a1) * r, 0), apex], mat, cone: true, band: cloth, hh, s });
    }
    faces.push({ p: [P3(r * 0.99, -r * 0.28, 0), P3(r * 0.99, r * 0.28, 0), P3(r * 0.57, 0, hh * 0.46)], dark: true });
    for (let q = 0; q < 6; q++) {
      const a = (q / 6) * Math.PI * 2 + 0.4;
      faces.push({ line: [P3(Math.cos(a) * r * 0.08, Math.sin(a) * r * 0.08, hh * 0.92), P3(-Math.cos(a) * r * 0.26, -Math.sin(a) * r * 0.26, hh * 1.3)], col: q & 1 ? P.d1 : P.d2 });
    }
  } else {
    const L = s * 0.55, B2 = s * 0.44, hh = s * 0.5;
    const fl = P3(L, -B2, 0), fr = P3(L, B2, 0), bl = P3(-L, -B2, 0), br = P3(-L, B2, 0), rf = P3(L, 0, hh), rb = P3(-L, 0, hh);
    const roof = { mat, roof: true, hh, s };
    faces.push({ p: [bl, fl, rf], ...roof }, { p: [bl, rf, rb], ...roof }, { p: [fr, br, rb], ...roof }, { p: [fr, rb, rf], ...roof });
    faces.push({ p: [fl, fr, rf], mat, end: true, hh }, { p: [br, bl, rb], mat, end: true, hh });
    faces.push({ p: [P3(L + 0.02, -B2 * 0.46, 0), P3(L + 0.02, B2 * 0.46, 0), P3(L + 0.02, 0, hh * 0.8)], dark: true });
    faces.push({ line: [P3(L, 0, hh), P3(L, 0, hh * 1.2)], col: P.d1 }, { line: [P3(-L, 0, hh), P3(-L, 0, hh * 1.2)], col: P.d1 });
    if (VIEW === "camp") for (const e of [1, -1]) for (const sd of [1, -1]) faces.push({ line: [P3(e * L, 0, hh * 1.1), P3(e * (L + s * 0.32), sd * B2 * 1.1, 0)], col: P.r4, thin: true });
  }
  return { z: at ? at.z : -1e9, mesh: faces, id: 0, base, tent: t };
}

function drawMesh(B, V, o, id) {
  const disp = V.levelM * V.exag;
  for (const f of o.mesh) {
    if (f.line) { line3(B, V, f.line[0], f.line[1], f.col, id, f.thin); continue; }
    const [A, Bv, Cv] = f.p;
    const toM = (p) => [p[0] * V.tileM, p[1] * V.tileM, p[2] * disp];
    const a = toM(A), b = toM(Bv), c = toM(Cv);
    const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    let n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    const nl = Math.hypot(...n) || 1;
    n = n.map((q) => q / nl);
    if (n[2] < 0) n = n.map((q) => -q);
    const lit = n[0] * L3[0] + n[1] * L3[1] + n[2] * L3[2];
    tri(B, V.sx(A[0], A[1]), V.sy(A[0], A[1], A[2]), V.sx(Bv[0], Bv[1]), V.sy(Bv[0], Bv[1], Bv[2]), V.sx(Cv[0], Cv[1]), V.sy(Cv[0], Cv[1], Cv[2]), (p, x, y, la, lb, lc) => {
      const u = la * A[0] + lb * Bv[0] + lc * Cv[0], v = la * A[1] + lb * Bv[1] + lc * Cv[1], hz = la * A[2] + lb * Bv[2] + lc * Cv[2];
      const z = V.cz(u, v, hz) + (f.dark ? 1.5 : 0.5);
      if (z < B.z[p]) return;
      let col;
      if (f.dark) col = lc > 0.8 ? P.d0 : P.ink;
      else {
        const qa = la * A[3] + lb * Bv[3] + lc * Cv[3], qb = la * A[4] + lb * Bv[4] + lc * Cv[4], qh = la * A[5] + lb * Bv[5] + lc * Cv[5], fh = qh / f.hh;
        let val = 0.9 + (lit + 0.2) * 3.1 + (h2(x, y, 60) - 0.5) * 0.35;
        if (f.roof) {
          const pn = qa / (f.s * 0.24) + 20;
          if (pn - Math.floor(pn) < 0.09) val -= 0.9;
          if (fh > 0.93) val += 0.9;
          if (fh < 0.07) val -= 1;
        } else if (f.end) {
          if (fh < 0.07) val -= 1;
        } else if (f.cone) {
          if (Math.abs(fh - 0.3) < 0.05) { col = fh > 0.31 ? SHADOW[f.band] : f.band; }
          else if (Math.abs(fh - 0.36) < 0.012 || Math.abs(fh - 0.62) < 0.012) val -= 0.9;
          const ang = Math.atan2(qb, qa), pn = ang * 2.5 + 20;
          if (pn - Math.floor(pn) < 0.07 && fh < 0.85) val -= 0.7;
          if (fh > 0.84) val -= 1.3 * (fh - 0.84) * 8;
          if (fh < 0.05) val -= 1;
        }
        if (col === undefined) col = dith(f.mat.r, val, x, y);
      }
      B.c[p] = col; B.z[p] = z; B.id[p] = id;
    });
  }
}

function line3(B, V, a, b, col, id, thin) {
  const x0 = V.sx(a[0], a[1]), y0 = V.sy(a[0], a[1], a[2]), x1 = V.sx(b[0], b[1]), y1 = V.sy(b[0], b[1], b[2]);
  const n = Math.ceil(Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0))) + 1;
  for (let k = 0; k <= n; k++) {
    const t = k / n, x = Math.floor(x0 + (x1 - x0) * t), y = Math.floor(y0 + (y1 - y0) * t);
    if (x < 0 || y < 0 || x >= B.w || y >= B.h) continue;
    if (thin && (k & 1) && k > 2 && k < n - 2) continue;
    const p = y * B.w + x, z = V.cz(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t) + 1;
    if (z < B.z[p]) continue;
    B.c[p] = col; B.z[p] = z; B.id[p] = id;
  }
}

function meshShadow(B, V, o) {
  const len = (V.levelM * V.exag * V.cot) / V.tileM;
  const drop = (p) => { const hgt = p[2] - o.base; return [p[0] + V.sd[0] * hgt * len, p[1] + V.sd[1] * hgt * len, o.base]; };
  for (const f of o.mesh) {
    if (!f.p) continue;
    const [A, Bv, Cv] = f.p.map(drop);
    tri(B, V.sx(A[0], A[1]), V.sy(A[0], A[1], A[2]), V.sx(Bv[0], Bv[1]), V.sy(Bv[0], Bv[1], Bv[2]), V.sx(Cv[0], Cv[1]), V.sy(Cv[0], Cv[1], Cv[2]), (p, x, y) => shadowPx(B, x, y));
  }
}

function drawObjects(B, V, O) {
  O.sort((a, b) => a.z - b.z);
  for (const o of O) {
    if (o.mesh) meshShadow(B, V, o);
    else if (o.shadow) castShadow(B, o.spr, o.sx, o.sy, V.shx, V.shy, o.mirror);
  }
  let id = 1;
  const meshes = [];
  for (const o of O) {
    id = (id % 65000) + 1;
    if (o.mesh) { drawMesh(B, V, o, id); meshes.push(id); }
    else blit(B, o.spr, o.sx, o.sy, o.z, id, o.mirror, o.bias);
  }
  // dark outline where a tent meets anything behind it
  const ids = new Set(meshes), mark = [];
  for (let y = 1; y < B.h - 1; y++)
    for (let x = 1; x < B.w - 1; x++) {
      const p = y * B.w + x, me = B.id[p];
      if (!ids.has(me)) continue;
      for (const q of [p - 1, p + 1, p - B.w, p + B.w]) if (B.id[q] !== me && B.z[q] < B.z[p] - 0.5) { mark.push(p); break; }
    }
  for (const p of mark) B.c[p] = P.ink;
}

function fireGlow(B, V) {
  const f = V.fireAt;
  if (!f) return;
  const R = f.r;
  for (let y = Math.floor(f.y - R * 0.6); y <= f.y + R * 0.6; y++)
    for (let x = Math.floor(f.x - R); x <= f.x + R; x++) {
      if (x < 0 || y < 0 || x >= B.w || y >= B.h) continue;
      const d = Math.hypot((x - f.x) / R, (y - f.y) / (R * 0.55));
      if (d >= 1) continue;
      const p = y * B.w + x, c = B.c[p];
      if (B.id[p] !== 0) continue;
      const a = (1 - d) * 1.5;
      if (bayer(x, y) < a) B.c[p] = GLOW[c];
      if (bayer(x, y) < a - 1) B.c[p] = GLOW[B.c[p]];
    }
}

// Smoke: a stack of lit puffs that swell, bend with the wind and thin out by ordered dither as they rise.
function drawSmoke(B, V) {
  for (const s of V.smokes || []) {
    const ts = [];
    for (let t = 0, k = 0; t < 1; k++, t += (s.r * (0.8 + t * 4.5) * (0.7 + h2(k, 3, 77) * 0.8)) / s.h) ts.push(t);
    for (let k = ts.length - 1; k >= 0; k--) {
      const t = ts[k], rise = s.h * t;
      const r = s.r * (0.8 + t * 4.5) * (0.8 + h2(k, 2, 77) * 0.4);
      const cx = s.x + (s.drift || 0) * s.h * t * t + Math.sin(t * 4.5 + 1) * s.r * 1.6 * t + (h2(k, 1, 77) - 0.5) * r * 1.3 * Math.min(1, t * 3);
      const cy = s.y - rise, alpha = t < 0.35 ? 1.3 : 1.3 - (t - 0.35) * 1.8;
      for (let y = Math.floor(cy - r); y <= cy + r; y++)
        for (let x = Math.floor(cx - r); x <= cx + r; x++) {
          if (x < 0 || y < 0 || x >= B.w || y >= B.h) continue;
          const dx = (x + 0.5 - cx) / r, dy = (y + 0.5 - cy) / r, d = dx * dx + dy * dy;
          if (d > 1 || bayer(x, y) > alpha * (1.35 - d * 0.8)) continue;
          const l = -(dx * 0.7 + dy * 0.75) + (h2(x, y, 78) - 0.5) * 0.2;
          B.c[y * B.w + x] = d > 0.7 && dx + dy > 0.25 ? P.r3 : l > 0.45 ? P.snow : l > -0.05 ? P.r5 : P.r4;
        }
    }
  }
}

async function main() {
  const cv = document.getElementById("view");
  const CW = window.innerWidth || 1280, CH = window.innerHeight || 720;
  cv.width = CW; cv.height = CH;
  const cfg = CFG[VIEW], AW = Math.ceil(CW / cfg.S), AH = Math.ceil(CH / cfg.S);
  const w = grow(SEED);
  const V = makeView(w, cfg, AW, AH);
  const M = buildMap(w, V);
  if (V.tsun) V.shaded = shadowTest(V, M);
  const B = new Buf(AW, AH);
  B.c.fill(P.ink);
  const O = collectObjects(w, V, M);
  drawTerrain(B, w, V, M);
  drawObjects(B, V, O);
  fireGlow(B, V);
  drawSmoke(B, V);
  const c = w.camp, a = Math.atan2(-c.at.z, c.at.x), side = ["east", "northeast", "north", "northwest", "west", "southwest", "south", "southeast"][((Math.round(a / (Math.PI / 4)) % 8) + 8) % 8];
  const info = {
    island: `Island ${(w.SIZE / 1000).toFixed(1)} km across  ${w.trees.length.toLocaleString("en")} trees  ${c.people.length} nomads`,
    valley: `${side} shore  camp ${c.at.y.toFixed(1)} m above the sea`,
    camp: `Camp  ${c.people.length} nomads  ${c.tents.length} tents  1 fire`,
  }[VIEW];
  drawUI(B, `Nomads  seed ${SEED}`, info);

  const off = Object.assign(document.createElement("canvas"), { width: AW, height: AH });
  B.toImage(off.getContext("2d"));
  const g = cv.getContext("2d");
  g.imageSmoothingEnabled = false;
  g.drawImage(off, 0, 0, AW * cfg.S, AH * cfg.S);
  document.body.classList.add("ready");
}

const fail = (e) => { document.body.dataset.error = String((e && e.stack) || e); document.body.classList.add("failed"); };
window.addEventListener("error", (e) => fail(e.error || e.message));
window.addEventListener("unhandledrejection", (e) => fail(e.reason));
main().catch(fail);
