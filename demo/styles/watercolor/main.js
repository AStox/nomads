// Nomads as a painted atlas: a pen-and-watercolor map of the island in the manner of old naturalist maps. The world's
// fields decide every wash and every pen line; the paint itself happens in paint.js.
import { grow, clamp, hash, noise, fbm } from "../world.js";
import { COLORS } from "../island.js";
import { paint } from "./paint.js";
import { Pen, INK, TAU, rng, chaikin, resample, isolines, edt, length, Spacing, blob, polyPath } from "./draw.js";
import * as S from "./symbols.js";

const fail = (e) => { document.body.dataset.error = String((e && e.stack) || e); document.body.classList.add("failed"); };
addEventListener("error", (e) => fail(e.error || e.message));
addEventListener("unhandledrejection", (e) => fail(e.reason));

const inset = (r, d) => [r[0] + d, r[1] + d, r[2] - d, r[3] - d];

// Water depth below the local lake or sea level at any point, and whether that water is the sea. Sea shores follow the
// smooth ground. Lake cells are too coarse to trust, so lake shores are rounded and wander, leaning toward where the
// ground sits below the water line; evaluated per pixel so they stay smooth at any zoom.
function waterSampler(w) {
  const { N, CELL, START, isle, wet } = w;
  const lvl = new Float32Array(N * N).fill(NaN), wetBin = Float32Array.from(isle.water, (v) => (v > 0 ? 1 : 0));
  for (let k = 0; k < N * N; k++) if (isle.water[k] > 0) lvl[k] = isle.height[k] + isle.water[k];
  return (x, z) => {
    // beyond the generated square it is open sea, as at its edge
    x = clamp(x, START, START + (N - 1) * CELL);
    z = clamp(z, START, START + (N - 1) * CELL);
    const cx = (x - START) / CELL, cy = (z - START) / CELL, i0 = Math.round(cx), j0 = Math.round(cy);
    let L = -Infinity, near = Infinity, sea = 1;
    for (let dj = -1; dj <= 1; dj++)
      for (let di = -1; di <= 1; di++) {
        const ci = i0 + di, cj = j0 + dj;
        if (ci < 0 || cj < 0 || ci >= N || cj >= N) continue;
        const l = lvl[cj * N + ci];
        if (Number.isNaN(l)) continue;
        const d = Math.hypot(ci - cx, cj - cy);
        if (d < 1.3 && l > L) L = l;
        if (d < near) { near = d; sea = l < 0.5 ? 1 : 0; }
      }
    const hh = w.heightAt(x, z);
    if (L === -Infinity || w.fine(wet, x, z) <= 0.02) return [-Math.max(hh, 0.5), sea];
    if (L < 0.5) return [-hh, sea];
    return [(w.bicubic(wetBin, cx, cy) - 0.5) * 5 + clamp(L - hh, -3, 3) * 0.8 + 3.2 * fbm(x / 50, z / 50, 77, 3), sea];
  };
}

// Fine-grid fields for the paint: covers, depth, heights, a hillshade from the northwest, sky and which water is sea.
function fields(w, exag, water) {
  const { M, STEP, START, h } = w, LEN = M * M;
  const depth = new Float32Array(LEN), sea = new Float32Array(LEN), shade = new Float32Array(LEN);
  for (let v = 0; v < M; v++)
    for (let u = 0; u < M; u++) {
      const [d, s] = water(START + u * STEP, START + v * STEP);
      depth[v * M + u] = d;
      sea[v * M + u] = s;
    }
  const Lx = -0.55, Ly = 0.63, Lz = -0.55;
  for (let v = 0; v < M; v++)
    for (let u = 0; u < M; u++) {
      const i = v * M + u;
      if (depth[i] > 0) continue;
      const dx = ((h[v * M + Math.min(M - 1, u + 1)] - h[v * M + Math.max(0, u - 1)]) / (2 * STEP)) * exag;
      const dz = ((h[Math.min(M - 1, v + 1) * M + u] - h[Math.max(0, v - 1) * M + u]) / (2 * STEP)) * exag;
      const lit = (-dx * Lx + Ly - dz * Lz) / Math.hypot(dx, 1, dz);
      shade[i] = clamp((Ly - lit) / Ly, 0, 1);
    }
  const pack = (a, b, c, d) => { const o = new Float32Array(LEN * 4); for (let i = 0; i < LEN; i++) { o[i * 4] = a[i]; o[i * 4 + 1] = b[i]; o[i * 4 + 2] = c[i]; o[i * 4 + 3] = d[i]; } return o; };
  const cv = w.cover;
  return { depth, sea, shade, fA: pack(cv.tree, cv.shrub, cv.grass, cv.marsh), fB: pack(cv.bare, cv.sand, depth, h), fC: pack(shade, w.sky, w.moist, sea) };
}

function makeView(kind, w, F, W, H) {
  const c = w.camp.at;
  if (kind === "camp") {
    // A field sketch: the ground seen a little obliquely from the camp's open side, symbols standing up.
    const s = 52, k = 0.5, from = w.camp.from, f = [Math.cos(from), Math.sin(from)], r = [Math.sin(from), -Math.cos(from)];
    const C = [c.x - f[0] * 6.4 + r[0] * 0.9, c.z - f[1] * 6.4 + r[1] * 0.9];
    const toS = (x, z) => [W / 2 + s * ((x - C[0]) * r[0] + (z - C[1]) * r[1]), H / 2 + s * k * ((x - C[0]) * f[0] + (z - C[1]) * f[1])];
    const sheet = [16, 12, W - 16, H - 12];
    return {
      kind, W, H, s, k, f, r, mpp: 1 / s, toS, sheet, frame: inset(sheet, 6), vig: [W * 0.5, H * 0.5, W * 0.45, H * 0.44],
      origin: [C[0] - (r[0] * W) / 2 / s - (f[0] * H) / 2 / (s * k), C[1] - (r[1] * W) / 2 / s - (f[1] * H) / 2 / (s * k)], ax: [r[0] / s, r[1] / s], ay: [f[0] / (s * k), f[1] / (s * k)],
    };
  }
  let cx, cz, mpp, sheet, outer, band;
  if (kind === "island") {
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
    for (let v = 0; v < w.M; v++)
      for (let u = 0; u < w.M; u++)
        if (F.depth[v * w.M + u] < 0) {
          const x = w.START + u * w.STEP, z = w.START + v * w.STEP;
          x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z);
        }
    sheet = [22, 14, W - 22, H - 14];
    outer = inset(sheet, 16);
    band = 7;
    const fr = inset(outer, band);
    mpp = Math.max((x1 - x0) / (fr[2] - fr[0] - 80), (z1 - z0) / (fr[3] - fr[1] - 46));
    cx = (x0 + x1) / 2;
    cz = (z0 + z1) / 2;
  } else {
    sheet = [10, 8, W - 10, H - 8];
    outer = inset(sheet, 14);
    band = 6;
    mpp = 0.7;
    cx = c.x;
    cz = c.z + 45;
  }
  return {
    kind, W, H, mpp, s: 1 / mpp, toS: (x, z) => [W / 2 + (x - cx) / mpp, H / 2 + (z - cz) / mpp], sheet, outer, frame: inset(outer, band), vig: [0, 0, 0, 0],
    origin: [cx - (W / 2) * mpp, cz - (H / 2) * mpp], ax: [mpp, 0], ay: [0, mpp],
  };
}

function layer(W, H, white) {
  const c = Object.assign(document.createElement("canvas"), { width: W, height: H }), g = c.getContext("2d");
  if (white) { g.fillStyle = "#fff"; g.fillRect(0, 0, W, H); g.globalCompositeOperation = "multiply"; }
  g.lineCap = g.lineJoin = "round";
  return { c, g };
}

async function main() {
  const q = new URLSearchParams(location.search);
  const kind = ["island", "valley", "camp"].includes(q.get("view")) ? q.get("view") : "valley";
  const seed = Number(q.get("seed")) || 1;
  const canvas = document.getElementById("view");
  const W = (canvas.width = innerWidth || 1280), H = (canvas.height = innerHeight || 720);
  const w = grow(seed);
  const water = waterSampler(w), F = fields(w, kind === "island" ? 2.2 : kind === "valley" ? 4 : 1, water);
  const V = makeView(kind, w, F, W, H);
  const toW = (sx, sy) => [V.origin[0] + V.ax[0] * sx + V.ay[0] * sy, V.origin[1] + V.ax[1] * sx + V.ay[1] * sy];
  const at = (arr, sx, sy) => { const [x, z] = toW(sx, sy); return w.fine(arr, x, z); };

  // Water depth per pixel and how far each pixel lies from the shore, both ways.
  const depthPx = new Float32Array(W * H), landPx = new Uint8Array(W * H), waterPx = new Uint8Array(W * H);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = y * W + x, d = water(...toW(x + 0.5, y + 0.5))[0];
      depthPx[i] = d;
      landPx[i] = d <= 0 ? 1 : 0;
      waterPx[i] = d > 0 ? 1 : 0;
    }
  const dep = (sx, sy) => depthPx[clamp(Math.floor(sy), 0, H - 1) * W + clamp(Math.floor(sx), 0, W - 1)];
  const dWater = edt(landPx, W, H), dLand = edt(waterPx, W, H), dist = new Float32Array(W * H * 4);
  for (let i = 0; i < W * H; i++) { dist[i * 4] = Math.min(dWater[i], 6e4); dist[i * 4 + 1] = Math.min(dLand[i], 6e4); dist[i * 4 + 3] = clamp(depthPx[i], -60, 60); }

  // A 2 px grid for pen lines: heights, depth and a softened shore distance.
  const gs = 2, gw = Math.floor(W / gs) + 1, gh = Math.floor(H / gs) + 1;
  const hG = new Float32Array(gw * gh), dG = new Float32Array(gw * gh);
  let rG = new Float32Array(gw * gh);
  for (let j = 0; j < gh; j++)
    for (let i = 0; i < gw; i++) {
      const [x, z] = toW(i * gs, j * gs), k = j * gw + i;
      hG[k] = w.heightAt(x, z);
      dG[k] = water(x, z)[0];
      rG[k] = dWater[Math.min(H - 1, j * gs) * W + Math.min(W - 1, i * gs)];
    }
  for (let pass = 0; pass < 2; pass++) {
    const o = new Float32Array(gw * gh);
    for (let j = 0; j < gh; j++)
      for (let i = 0; i < gw; i++) {
        let s = 0, n = 0;
        for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) { const a = i + di, b = j + dj; if (a >= 0 && b >= 0 && a < gw && b < gh) { s += rG[b * gw + a]; n++; } }
        o[j * gw + i] = s / n;
      }
    rG = o;
  }
  const gridAt = (G, x, y) => {
    const fx = clamp(x / gs, 0, gw - 1.001), fy = clamp(y / gs, 0, gh - 1.001), i = Math.floor(fx), j = Math.floor(fy), tx = fx - i, ty = fy - j, k = j * gw + i;
    return (G[k] * (1 - tx) + G[k + 1] * tx) * (1 - ty) + (G[k + gw] * (1 - tx) + G[k + gw + 1] * tx) * ty;
  };
  const toPx = (L) => L.pts.map(([i, j]) => [i * gs, j * gs]);
  const splitRuns = (pts, bad) => { const runs = []; let run = []; for (const p of pts) { if (bad(p)) { if (run.length > 2) runs.push(run); run = []; } else run.push(p); } if (run.length > 2) runs.push(run); return runs; };

  // `res` marks paper the painter kept dry around tents and figures, so ground washes stop at them with a wet edge.
  const inkL = layer(W, H, false), washL = layer(W, H, true), resL = layer(W, H, false);
  const D = { ink: inkL.g, wash: washL.g, res: resL.g, pen: new Pen(inkL.g) }, pen = D.pen;
  const R = rng(seed * 7919 + (kind === "island" ? 1 : kind === "valley" ? 2 : 3));
  const fr = V.frame, map = kind !== "camp";
  for (const g of [D.ink, D.wash]) { g.save(); g.beginPath(); g.rect(fr[0], fr[1], fr[2] - fr[0], fr[3] - fr[1]); g.clip(); }
  const wind = w.isle.wind;
  let hole = [0, 0, 0, 0];

  if (map) {
    const isl = kind === "island";
    // A cartouche for the scale bar in the valley map, cleared of paint and symbols.
    const seg = isl ? 1000 / V.mpp : 50 / V.mpp, segs = isl ? 3 : 4;
    const barX = fr[0] + (isl ? 40 : 30) + seg, barY = fr[3] - (isl ? 42 : 34);
    if (!isl) hole = [barX - seg - 16, barY - 16, barX + segs * seg + 16, barY + 21];
    const inHole = (x, y) => x > hole[0] - 4 && x < hole[2] + 4 && y > hole[1] - 4 && y < hole[3] + 14;

    // Pencil graticule under everything: the cartographer's construction lines.
    if (isl) {
      for (let m = -6000; m <= 6000; m += 1000) {
        const [ax0] = V.toS(m, 0), [, ay0] = V.toS(0, m);
        pen.stroke([[ax0, fr[1]], [ax0 + 0.8, fr[3]]], { w: 0.6, alpha: 0.16, color: "#5a5652", wob: 0.5, taper: 1 });
        pen.stroke([[fr[0], ay0], [fr[2], ay0 + 0.8]], { w: 0.6, alpha: 0.16, color: "#5a5652", wob: 0.5, taper: 1 });
      }
    }

    // Contours in a warm brown, index lines heavier; not drawn over water. The interval opens up on steep ground so
    // typical lines stay about ten pixels apart.
    let hmax = 0;
    for (const v of hG) hmax = Math.max(hmax, v);
    const grads = [];
    for (let j = 1; j < gh - 1; j += 3)
      for (let i = 1; i < gw - 1; i += 3) {
        const k = j * gw + i;
        if (dG[k] < 0) grads.push(Math.hypot(hG[k + 1] - hG[k - 1], hG[k + gw] - hG[k - gw]) / (4 * gs));
      }
    grads.sort((a, b) => a - b);
    const want = Math.max(isl ? 20 : 2, (grads[Math.floor(grads.length * 0.7)] || 0) * 10);
    const ci = [1, 2, 2.5, 5, 10, 20, 25, 50, 100, 200].find((v) => v >= want) || 200, index = ci * (ci === 2.5 || ci === 25 ? 4 : 5);
    for (let lev = ci; lev < hmax; lev += ci)
      for (const L of isolines(hG, gw, gh, lev)) {
        const pts = chaikin(toPx(L), L.closed, 2);
        if (length(pts) < 14) continue;
        const major = lev % index === 0;
        for (const run of splitRuns(pts, (p) => gridAt(dG, p[0], p[1]) > -0.2 || inHole(p[0], p[1])))
          pen.stroke(run, { w: major ? 1.1 : 0.7, alpha: major ? 0.62 : 0.45, color: "#7b4a2b", wob: 0.35, taper: 6 });
      }

    // Hachures down the steep ground: ticks between fine contours, heavier where steeper. Where contours crowd, only
    // every k-th row is ticked (with ticks k rows long) so the hatching keeps an even density.
    const hInt = isl ? 7 : 0.8, sMin = isl ? 0.36 : 0.24, sp = isl ? 2.6 : 3.6, rowPx = isl ? 3.5 : 7, buckets = [[], [], [], []];
    for (let li = 1; li * hInt < hmax; li++)
      for (const L of isolines(hG, gw, gh, li * hInt)) {
        if (L.pts.length < 3) continue;
        for (const [x, y] of resample(chaikin(toPx(L), L.closed, 1), sp, L.closed)) {
          const gx = (gridAt(hG, x + 1, y) - gridAt(hG, x - 1, y)) / 2, gy = (gridAt(hG, x, y + 1) - gridAt(hG, x, y - 1)) / 2, g = Math.hypot(gx, gy), slope = g / V.mpp;
          if (slope < sMin || gridAt(dG, x, y) > -0.3 || inHole(x, y)) continue;
          const k = Math.max(1, Math.ceil((rowPx * g) / hInt));
          if (li % k) continue;
          const len = Math.min(((k * hInt) / g) * 0.8, isl ? 7 : 12), kk = clamp((slope - sMin) / (isl ? 0.6 : 0.4), 0, 0.999);
          buckets[Math.floor(kk * 4)].push([x, y, x - (gx / g) * len, y - (gy / g) * len]);
        }
      }
    buckets.forEach((b, i) => {
      D.ink.beginPath();
      for (const [x0, y0, x1, y1] of b) { D.ink.moveTo(x0, y0); D.ink.lineTo(x1, y1); }
      D.ink.lineWidth = (isl ? 0.4 : 0.45) + i * (isl ? 0.2 : 0.28);
      D.ink.strokeStyle = INK;
      D.ink.globalAlpha = (isl ? 0.3 : 0.42) + i * 0.12;
      D.ink.stroke();
      D.ink.globalAlpha = 1;
    });

    // Sand stippled with the pen.
    const sg = isl ? 2.4 : 3.4;
    D.ink.fillStyle = "#5a3d24";
    for (let y = fr[1]; y < fr[3]; y += sg)
      for (let x = fr[0]; x < fr[2]; x += sg) {
        const px = x + R() * sg, py = y + R() * sg, sand = at(w.cover.sand, px, py);
        if (sand < 0.3 || dep(px, py) > -0.1 || inHole(px, py)) continue;
        if (R() < (sand - 0.3) * 1.5) { D.ink.globalAlpha = 0.35 + R() * 0.35; D.ink.fillRect(px, py, 0.9, 0.9); }
      }
    D.ink.globalAlpha = 1;

    // The shore, then water-lining: ripples following it offshore, thinner and more broken as they go out.
    for (const L of isolines(dG, gw, gh, 0)) {
      const pts = chaikin(toPx(L), L.closed, 2);
      if (length(pts) < 5) continue;
      pen.stroke(pts, { w: isl ? 1.15 : 1.6, alpha: 0.92, wob: 0.35, closed: L.closed, taper: 4 });
    }
    const rip = isl ? [3.4, 6.8, 10.6, 15, 20, 26, 33] : [5, 10.5, 17, 25, 34, 45, 58];
    rip.forEach((rd, k) => {
      for (const L of isolines(rG, gw, gh, rd)) {
        const pts = chaikin(toPx(L), L.closed, 2);
        if (length(pts) < 12) continue;
        const mid = pts[Math.floor(pts.length / 2)];
        if (k > 1 && at(F.sea, mid[0], mid[1]) < 0.5) continue;
        for (const run of splitRuns(pts, (p) => inHole(p[0], p[1])))
          pen.broken(run, -0.8 + 0.15 * k, 16 + 5 * k, { w: (isl ? 0.8 : 1) - 0.07 * k, alpha: 0.62 - 0.06 * k, color: "#2f3438", wob: 0.35, taper: 5 });
      }
    });

    // Rivers: a blue wash under a pen line that swells downstream.
    for (const line of w.rivers) {
      const pts = line.map(([x, z]) => V.toS(x, z));
      const runs = [];
      let run = [];
      pts.forEach((p, i) => { if (dep(p[0], p[1]) > 0.3) { if (run.length > 1) runs.push(run); run = []; } else run.push([...p, line[i][2]]); });
      if (run.length > 1) runs.push(run);
      for (const r of runs) {
        const q0 = r[0][2], q1 = r[r.length - 1][2], wpx = (q) => w.riverWidth(q) / V.mpp;
        D.wash.globalAlpha = 0.55;
        D.wash.strokeStyle = "#5f9ab8";
        D.wash.lineWidth = Math.max(isl ? 2.2 : 3, wpx((q0 + q1) / 2) * 1.3);
        D.wash.beginPath();
        r.forEach(([x, y], i) => (i ? D.wash.lineTo(x, y) : D.wash.moveTo(x, y)));
        D.wash.stroke();
        D.wash.globalAlpha = 1;
        const iw = (q) => clamp(0.45 + 0.3 * Math.sqrt(q), 0.45, 2.2) * (isl ? 1 : 1.5);
        pen.stroke(r.map(([x, y]) => [x, y]), { w: iw(q0), w1: iw(q1), alpha: 0.85, color: "#2f3a45", wob: 0.4, taper: 10 });
      }
    }

    // Ground cover marks: grass ticks on meadows, reeds on the marsh.
    const tg = isl ? 5.5 : 9, ticks = [], reedList = [];
    for (let y = fr[1]; y < fr[3]; y += tg)
      for (let x = fr[0]; x < fr[2]; x += tg) {
        const px = x + R() * tg, py = y + R() * tg;
        if (dep(px, py) > -0.4 || inHole(px, py)) continue;
        const g = at(w.cover.grass, px, py), m = at(w.cover.marsh, px, py), t = at(w.cover.tree, px, py);
        if (R() < (m - 0.3) * 1.3) reedList.push([px, py]);
        else if (R() < (g - 0.25) * 1.5 * (1 - t * 1.4)) ticks.push([px, py]);
      }
    for (const [x, y] of ticks) S.grassTick(D, x, y, isl ? 2.4 : 4.6, R);
    const occR = new Spacing(8);
    for (const [x, y] of reedList) { if (occR.near(x, y, isl ? 7 : 15)) continue; occR.add(x, y); S.reeds(D, x, y, isl ? 4.5 : 11, R); }

    // Trees, shrubs and rocks from the world, thinned to a readable spacing and drawn back to front.
    const syms = [], occ = new Spacing(8);
    const place = (items, spc, fn, keep = () => true) => {
      const cand = [];
      for (const it of items) {
        const [sx, sy] = V.toS(it.x, it.z);
        if (sx < fr[0] - 8 || sx > fr[2] + 8 || sy < fr[1] - 2 || sy > fr[3] + 24 || inHole(sx, sy) || !keep(it, sx, sy) || dep(sx, sy) > -0.3) continue;
        cand.push([hash(Math.round(it.x * 8), Math.round(it.z * 8), 5), sx, sy, it]);
      }
      cand.sort((a, b) => a[0] - b[0]);
      for (const [, sx, sy, it] of cand) { if (occ.near(sx, sy, spc)) continue; occ.add(sx, sy); syms.push({ y: sy, draw: () => fn(sx, sy, it) }); }
    };
    // the camp first, so trees keep clear of it
    const cp = w.camp, [csx, csy] = V.toS(cp.at.x, cp.at.z), tentCols = ["#d9bf88", "#c9875a", "#a9b087"];
    if (isl) {
      occ.add(csx, csy);
      for (let a = 0; a < TAU; a += 0.4) occ.add(csx + Math.cos(a) * 9, csy - 5 + Math.sin(a) * 9);
      syms.push({ y: csy, draw: () => {
        S.tentIcon(D, csx, csy, 14, "#c0623a", 11);
        S.smoke(D, csx + 2, csy - 15, 30, wind[0] * 0.8, 1.3, pen);
        // a red ring marks the camp, as a surveyor would mark a station
        for (const [rr, a] of [[15, 0.85], [18, 0.5]]) pen.stroke(Array.from({ length: 48 }, (_, i) => [csx + Math.cos((i / 48) * TAU) * rr, csy - 6 + Math.sin((i / 48) * TAU) * rr]), { w: 1.4, alpha: a + 0.1, color: "#a8321e", closed: true, wob: 0.4 });
      } });
    } else {
      // The camp drawn a little larger than life, spread about its fire so every piece reads.
      const ex = 2.6, spot = (p) => { const [x, y] = V.toS(p.x, p.z); return [csx + (x - csx) * ex, csy + (y - csy) * ex]; };
      S.dab(D, blob(csx, csy + 6, 58, 44, 4, 0.22, 13), "#d6bd8c", 0.3);
      cp.tents.forEach((t, i) => { const [x, y] = spot(t.at); syms.push({ y, draw: () => S.tentIcon(D, x, y, 16 + t.size * 1.4, tentCols[i], 20 + i) }); });
      cp.people.forEach((p, i) => {
        const [x, y] = spot(p.at), col = COLORS[(i * 5 + 2) % 12];
        syms.push({ y, draw: () => { S.shadow(D, x + 2, y, 3, 1, 0.3); S.dab(D, blob(x, y - 3.4, 2.3, 3.4, i, 0.1, 8), col, 0.9); S.dab(D, blob(x, y - 8.2, 1.5, 1.5, i + 5, 0.1, 8), "#e0ae86", 0.85); S.line(D, [[x - 1.8, y], [x - 2, y - 6], [x, y - 7], [x + 2, y - 6], [x + 1.8, y]], 0.7, 0.85); S.line(D, [[x - 1.2, y - 8.2], [x, y - 9.7], [x + 1.2, y - 8.2], [x, y - 6.9], [x - 1.2, y - 8.2]], 0.6, 0.8); } });
      });
      const [wx, wy] = spot(cp.woodpile);
      syms.push({ y: wy, draw: () => { S.dab(D, polyPath([[wx - 6, wy], [wx + 6, wy], [wx + 4, wy - 5], [wx - 4, wy - 5]]), "#8a5a34", 0.8); S.line(D, [[wx - 6, wy], [wx + 6, wy], [wx + 4, wy - 5], [wx - 4, wy - 5], [wx - 6, wy]], 0.7, 0.85); S.line(D, [[wx - 5, wy - 2.5], [wx + 5, wy - 2.5]], 0.5, 0.6); } });
      syms.push({ y: csy, draw: () => { S.dab(D, blob(csx, csy - 2, 3.6, 3, 3, 0.2, 8), "#e2542c", 0.9); S.dab(D, blob(csx, csy - 2.4, 1.8, 1.6, 4, 0.2, 8), "#f5c64a", 0.8); S.smoke(D, csx + 1, csy - 6, 86, wind[0] * 0.8, 2.1, pen); } });
      for (let a = 0; a < TAU; a += 0.3) for (const rr of [8, 20, 34, 46]) occ.add(csx + Math.cos(a) * rr, csy + 6 + Math.sin(a) * rr * 0.8);
    }
    const tS = isl ? 10 : 19;
    place(w.trees, isl ? 7.2 : 8.5, (x, y, t) => {
      const size = tS * (0.82 + 0.35 * clamp(t.tall / 17, 0, 1.2));
      (t.kind === "pine" ? S.pine(D, x, y, size * 1.05, t.tint, (t.x * 13 + t.z * 7) | 0) : S.broadleaf(D, x, y, size, t.kind, t.tint, (t.x * 13 + t.z * 7) | 0));
    });
    if (!isl) place(w.shrubs, 7, (x, y, s) => S.shrub(D, x, y, 7 + s.tall * 1.5, s.heath, s.tint, (s.x * 11 + s.z * 5) | 0));
    place(w.rocks, isl ? 7 : 6, (x, y, r) => S.rock(D, x, y, isl ? 1.3 + r.size * 0.25 : clamp(2 + r.size * 1.2, 2, 8), (r.x * 7 + r.z * 3) | 0, r.tint), (r) => r.size > (isl ? 1.2 : 0.4));
    syms.sort((a, b) => a.y - b.y);
    for (const s of syms) s.draw();

    // Page furniture: neatline with a graduated border, compass rose, scale bar.
    for (const g of [D.ink, D.wash]) g.restore();
    if (!isl) {
      D.ink.save(); D.ink.globalCompositeOperation = "destination-out"; D.ink.fillRect(hole[0], hole[1], hole[2] - hole[0], hole[3] - hole[1]); D.ink.restore();
      D.wash.save(); D.wash.globalCompositeOperation = "source-over"; D.wash.fillStyle = "#fff"; D.wash.fillRect(hole[0], hole[1], hole[2] - hole[0], hole[3] - hole[1]); D.wash.restore();
      pen.stroke([[hole[0], hole[1]], [hole[2], hole[1]], [hole[2], hole[3]], [hole[0], hole[3]]], { w: 1.1, alpha: 0.9, closed: true, wob: 0.3 });
      pen.stroke([[hole[0] + 3, hole[1] + 3], [hole[2] - 3, hole[1] + 3], [hole[2] - 3, hole[3] - 3], [hole[0] + 3, hole[3] - 3]], { w: 0.6, alpha: 0.7, closed: true, wob: 0.3 });
    }
    S.scaleBar(D, barX, barY, seg, segs);
    const o = V.outer, step = isl ? 1000 : 100;
    pen.stroke([[o[0], o[1]], [o[2], o[1]], [o[2], o[3]], [o[0], o[3]]], { w: 1.7, alpha: 0.92, closed: true, wob: 0.35 });
    pen.stroke([[fr[0], fr[1]], [fr[2], fr[1]], [fr[2], fr[3]], [fr[0], fr[3]]], { w: 0.8, alpha: 0.9, closed: true, wob: 0.3 });
    // alternate bands between the rules, cut at the world's grid lines
    const graduate = (a0, a1, toScreen, toWorld, bandRect) => {
      const cuts = [a0], first = Math.ceil(toWorld(a0) / step) * step;
      for (let m = first; ; m += step) { const p = toScreen(m); if (p >= a1) break; if (p > a0) cuts.push(p); }
      cuts.push(a1);
      for (let i = 0; i < cuts.length - 1; i++) if ((((Math.round(first / step) + i - 1) % 2) + 2) % 2 === 1) bandRect(cuts[i], cuts[i + 1]);
    };
    D.ink.fillStyle = INK;
    D.ink.globalAlpha = 0.8;
    graduate(fr[0], fr[2], (m) => V.toS(m, 0)[0], (a) => toW(a, 0)[0], (a, b) => { D.ink.fillRect(a, o[1] + 1.5, b - a, fr[1] - o[1] - 3); D.ink.fillRect(a, fr[3] + 1.5, b - a, o[3] - fr[3] - 3); });
    graduate(fr[1], fr[3], (m) => V.toS(0, m)[1], (a) => toW(0, a)[1], (a, b) => { D.ink.fillRect(o[0] + 1.5, a, fr[0] - o[0] - 3, b - a); D.ink.fillRect(fr[2] + 1.5, a, o[2] - fr[2] - 3, b - a); });
    D.ink.globalAlpha = 1;
    // compass over open water: the corner with the most sea
    const corners = [[fr[2] - 110, fr[1] + 110], [fr[0] + 110, fr[1] + 110], [fr[2] - 110, fr[3] - 110]];
    const wet = ([x, y]) => { let n = 0; for (let k = 0; k < 40; k++) { const a = k * 2.4, r = 70 * Math.sqrt(k / 40); if (dep(x + Math.cos(a) * r, y + Math.sin(a) * r) > 0) n++; } return n; };
    const cc = isl ? [fr[2] - 125, fr[1] + 120] : corners.reduce((b, c) => (wet(c) > wet(b) ? c : b));
    S.compass(D, cc[0], cc[1], isl ? 60 : 48);
    if (isl) {
      // A field sketch of the camp in the margin, tied to its mark on the map by a dotted leader.
      const x0 = fr[0] + 112, y0 = fr[1] + 360, s2 = 6.8, k2 = 0.55, f2 = [Math.cos(cp.from), Math.sin(cp.from)], r2 = [Math.sin(cp.from), -Math.cos(cp.from)];
      const toS2 = (x, z) => [x0 + s2 * ((x - cp.at.x) * r2[0] + (z - cp.at.z) * r2[1]), y0 + 22 + s2 * k2 * ((x - cp.at.x) * f2[0] + (z - cp.at.z) * f2[1])];
      S.dab(D, blob(x0, y0 + 4, 100, 56, 31, 0.26, 16), "#a9bf66", 0.5);
      S.dab(D, blob(x0 - 20, y0 + 20, 62, 28, 32, 0.3, 12), "#7f9f4a", 0.3);
      const [ex, ey] = toS2(cp.at.x, cp.at.z);
      S.dab(D, blob(ex, ey, 3.8 * s2, 3.8 * s2 * k2, 33, 0.2, 12), "#c9a674", 0.4);
      for (let n = 0; n < 70; n++) {
        const a = R() * TAU, e = Math.sqrt(R()) * 0.9, gx = x0 + Math.cos(a) * 95 * e, gy = y0 + 4 + Math.sin(a) * 52 * e;
        if (Math.hypot(gx - ex, (gy - ey) / k2) > 3.4 * s2) S.grassTick(D, gx, gy, 3 + R() * 2, R);
      }
      const pieces = campPieces(w, D, toS2, s2, k2, f2, r2).sort((a, b) => a.y - b.y);
      for (const it of pieces) it.draw();
      const a0 = [csx - 20, csy - 4], a1 = [x0 + 96, y0 - 22], mid = [(a0[0] + a1[0]) / 2 - 10, Math.min(a0[1], a1[1]) - 30];
      for (let i = 0; i < 40; i += 2) {
        const q = (t) => [(1 - t) ** 2 * a0[0] + 2 * (1 - t) * t * mid[0] + t * t * a1[0], (1 - t) ** 2 * a0[1] + 2 * (1 - t) * t * mid[1] + t * t * a1[1]];
        S.line(D, [q(i / 40), q((i + 1) / 40)], 1.3, 0.9, "#a8321e");
      }
    }
  } else {
    drawCamp(w, V, D, R);
    for (const g of [D.ink, D.wash]) g.restore();
  }
  // A few flicks of spatter from the brush, each the color of the wash it flew from.
  for (let n = 0; n < (kind === "camp" ? 70 : 120); n++) {
    let x, y;
    if (kind === "camp") { const a = R() * TAU, e = 0.82 + R() * 0.32; x = V.vig[0] + Math.cos(a) * V.vig[2] * e; y = V.vig[1] + Math.sin(a) * V.vig[3] * e; }
    else { x = fr[0] + R() * (fr[2] - fr[0]); y = fr[1] + R() * (fr[3] - fr[1]); }
    if (x < V.sheet[0] + 12 || x > V.sheet[2] - 12 || y < V.sheet[1] + 12 || y > V.sheet[3] - 12) continue;
    const d = dep(x, y), g = at(w.cover.grass, x, y), t = at(w.cover.tree, x, y);
    if (kind === "island" && d > 0 && dWater[Math.floor(y) * W + Math.floor(x)] > 100) continue;
    const col = d > 0 ? "#4b90ad" : t > g ? "#5f8f45" : "#a0b85a", r0 = 0.6 + R() ** 3 * 2.6;
    S.dab(D, blob(x, y, r0, r0 * (0.75 + R() * 0.3), n, 0.25, 7), col, 0.6);
    for (let k2 = 0; k2 < 3; k2++) if (R() < 0.5) S.dab(D, blob(x + (R() - 0.5) * 9, y + (R() - 0.5) * 9, 0.5, 0.45, n + k2, 0.2, 6), col, 0.55);
  }
  const resPx = D.res.getImageData(0, 0, W, H).data;
  for (let i = 0; i < W * H; i++) dist[i * 4 + 2] = resPx[i * 4 + 3] / 255;
  paint(canvas, {
    origin: V.origin, ax: V.ax, ay: V.ay, gStart: w.START, gStep: w.STEP, gM: w.M,
    fA: F.fA, fB: F.fB, fC: F.fC, dist, wash: washL.c, ink: inkL.c, sheet: V.sheet,
    sigma: kind === "island" ? 2.4 : 3.6, symSigma: kind === "camp" ? 2.2 : kind === "island" ? 1.1 : 1.5,
    symEdge: kind === "island" ? 0.45 : kind === "valley" ? 1.1 : 1.25, tone: kind === "island" ? [0.62, 0.72, 0.9, 1] : kind === "camp" ? [1, 1, 1, 0.55] : [1, 1, 1, 1],
    mask: {
      frame: V.frame, vig: V.vig, hole, warp: kind === "island" ? 6 : 10, gscale: kind === "camp" ? 2.4 : kind === "valley" ? 1.3 : 1,
      seaReach: kind === "island" ? 95 : 4000, coastBand: kind === "island" ? 15 : 34,
      highT: kind === "island" ? 150 : kind === "valley" ? 16 : 1e9, shadeT1: kind === "valley" ? 0.3 : 0.2, shadeT2: kind === "valley" ? 0.62 : 0.5,
    },
  });
}

function drawCamp(w, V, D, R) {
  const { s, k, f, r } = V, cp = w.camp, items = [];
  D.pencil = true;
  const [vx, vy, vrx, vry] = V.vig;
  const inVig = (x, y, slack = 0) => Math.hypot((x - vx) / vrx, (y - vy) / vry) < 0.96 + slack + 0.08 * noise(x / 90, y / 90, 3);
  const scr = (p) => V.toS(p.x, p.z);
  // trodden earth round the fire, the woodpile and under the tents
  const earth = (p, rad, sd) => { const [x, y] = scr(p); S.dab(D, blob(x, y, rad * s, rad * s * k, sd, 0.2, 13), "#c9a674", 0.42); };
  earth(cp.at, 3.9, 1);
  earth(cp.woodpile, 1.5, 2);
  cp.tents.forEach((t, i) => earth(t.at, t.size * 0.45, 3 + i));

  const nb = w.nearby(cp.at, 27, 2.4);
  nb.grass.forEach((g, i) => {
    const [x, y] = scr(g);
    if (!inVig(x, y, -0.02)) return;
    items.push({ y, draw: () => S.grassTuft(D, x, y, g.tall * s * 0.55, i, R() < 0.6) });
  });
  nb.flowers.forEach((fl) => { const [x, y] = scr(fl); if (inVig(x, y)) items.push({ y, draw: () => S.flower(D, x, y, fl.hue, fl.tall * s * 0.6) }); });
  nb.pebbles.forEach((p, i) => { const [x, y] = scr(p); if (inVig(x, y)) items.push({ y, draw: () => S.pebble(D, x, y, Math.max(2, p.size * s * 0.45), 100 + i) }); });
  for (const rk of w.rocks) { const [x, y] = scr(rk); if (x > 0 && x < V.W && y > 0 && y < V.H && inVig(x, y)) items.push({ y, draw: () => S.rock(D, x, y, clamp(rk.size * s * 0.4, 6, 40), 300, rk.tint) }); }
  nb.logs.forEach((l, i) => {
    const [x, y] = scr(l);
    if (!inVig(x, y)) return;
    const L = l.length * s * 0.5, dx = Math.cos(l.yaw) * L, dy = Math.sin(l.yaw) * L * k;
    items.push({ y, draw: () => { D.pen.stroke([[x - dx, y - dy], [x + dx, y + dy]], { w: s * 0.25, color: "#7a5030", alpha: 0.7, wob: 0.3, taper: 4 }); } });
  });
  items.push(...campPieces(w, D, V.toS, s, k, f, r));
  items.sort((a, b) => a.y - b.y);
  for (const it of items) it.draw();
}

// Tents, people, fire and woodpile of the camp as sortable drawing items, for any oblique mapping `toS`.
function campPieces(w, D, toS, s, k, f, r) {
  const cp = w.camp, items = [], scr = (p) => toS(p.x, p.z), tentCols = ["#dcc28c", "#c98a5c", "#a7b087"];
  cp.tents.forEach((t, i) => {
    const [x, y] = scr(t.at), rx = (t.size / 2) * s, ry = rx * k, dir = [Math.sin(t.yaw), Math.cos(t.yaw)];
    const door = Math.atan2(dir[0] * f[0] + dir[1] * f[1], dir[0] * r[0] + dir[1] * r[1]);
    items.push({ y: y + ry * 0.7, draw: () => S.campTent(D, x, y, rx, ry, t.size * 0.8 * s, tentCols[i], door, 40 + i) });
  });
  const [fx, fy] = scr(cp.fire), windDx = w.isle.wind[0] * r[0] + w.isle.wind[1] * r[1];
  cp.people.forEach((p, i) => {
    // stood a little wider round the fire than life, so the figures don't hide each other
    const [px, py] = scr(p.at), x = fx + (px - fx) * 1.35, y = fy + (py - fy) * 1.35, dir = [Math.sin(p.yaw), Math.cos(p.yaw)];
    items.push({ y, draw: () => S.person(D, x, y, 1.85 * s, COLORS[(i * 5 + 2) % 12], i, dir[0] * f[0] + dir[1] * f[1] > 0, Math.sign(fx - x) || 1, 60 + i) });
  });
  items.push({ y: fy + 0.7 * s * k, draw: () => S.fireplace(D, fx, fy, s, k, windDx, 7, D.pen) });
  const [wx, wy] = scr(cp.woodpile);
  items.push({ y: wy, draw: () => S.woodpile(D, wx, wy, s, 9) });
  return items;
}

main().then(() => document.body.classList.add("ready"), fail);
