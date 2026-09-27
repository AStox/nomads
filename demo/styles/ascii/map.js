// World data to glyph grids. Each cell is a CP437 character with a foreground and a background from the palette;
// shading only scales a palette color, it never invents a new hue.
import { clamp, smooth, hash, fbm } from "../world.js";
import { P, sc, mix } from "./term.js";

const LIGHT = (() => { const v = [-1, 1.3, -1], l = Math.hypot(...v); return v.map((c) => c / l); })(); // from the northwest
// Lambert against the northwest light, 1 on flat ground; `ex` exaggerates relief so it reads at the view's scale.
export function shade(w, x, z, d, ex) {
  const hx = ((w.heightAt(x + d, z) - w.heightAt(x - d, z)) / (2 * d)) * ex;
  const hz = ((w.heightAt(x, z + d) - w.heightAt(x, z - d)) / (2 * d)) * ex;
  return (-hx * LIGHT[0] + LIGHT[1] - hz * LIGHT[2]) / Math.hypot(hx, 1, hz) / LIGHT[1];
}

export function makeGrid(cols, rows, s, ox, oz) {
  const n = cols * rows;
  return {
    cols, rows, s, ox, oz,
    ch: new Array(n).fill(" "), fg: new Array(n).fill(P[0]), bg: new Array(n).fill(P[0]),
    glow: new Float32Array(n), bgGlow: new Float32Array(n), used: new Uint8Array(n),
    cx(i) { return ox + (i + 0.5) * s; },
    cz(j) { return oz + (j + 0.5) * s; },
    at(x, z) {
      const i = Math.floor((x - ox) / s), j = Math.floor((z - oz) / s);
      return i >= 0 && j >= 0 && i < cols && j < rows ? j * cols + i : -1;
    },
    put(k, ch, fg, bg) { if (k < 0) return; this.ch[k] = ch; if (fg) this.fg[k] = fg; if (bg) this.bg[k] = bg; },
  };
}

// Weighted glyph sets: [char, palette letter, weight].
const SETS = {
  grass: [['"', "l", 5], ['"', "G", 3], [",", "l", 3], [",", "G", 2], ["'", "v", 2], ["`", "l", 1], [".", "v", 2], [";", "G", 1]],
  shrub: [["τ", "g", 3], ["τ", "v", 2], ['"', "v", 2], ["ƒ", "g", 1]],
  heath: [['"', "m", 4], [";", "m", 2], ["τ", "v", 2], [",", "M", 1], ["∙", "m", 1]],
  marsh: [['"', "v", 3], [",", "c", 2], ["√", "c", 2], ["⌠", "g", 2], ["~", "B", 1], [".", "v", 2]],
  bare: [[":", "s", 3], ["∙", "s", 2], [".", "y", 2], [",", "w", 2], ["·", "y", 1]],
  scree: [["░", "s", 3], [":", "y", 2], ["∙", "y", 2], ["^", "s", 1]],
  sand: [[".", "t", 4], ["∙", "t", 3], ["·", "W", 1], [",", "w", 1], ["~", "t", 1]],
  floor: [[",", "v", 3], ["ƒ", "g", 2], ['"', "p", 2], [".", "w", 2], ["τ", "p", 1]],
};
const pick = (set, r) => {
  let total = 0;
  for (const e of set) total += e[2];
  let t = r * total;
  for (const e of set) if ((t -= e[2]) < 0) return e;
  return set[0];
};

const BG = {
  tree: sc(P.p, 0.26),
  shrub: sc(mix(P.v, P.g, 0.3), 0.3),
  heath: sc(mix(P.m, P.v, 0.5), 0.27),
  grass: sc(mix(P.g, P.v, 0.55), 0.35),
  marsh: sc(mix(P.c, P.v, 0.35), 0.33),
  bare: sc(P.s, 0.33),
  sand: sc(P.t, 0.33),
};
const COVER = ["tree", "shrub", "grass", "marsh", "bare", "sand"];
// ♣ and ♠ with their base row cleared: a tree on a short trunk, so a column of trees no longer fuses into one stripe.
export const BROAD = "\uE000", PINE = "\uE001";
export function defineGlyphs(face) {
  for (const [ch, from] of [[BROAD, "♣"], [PINE, "♠"]]) { const m = face.get(from).slice(); m.fill(0, 56, 64); face.define(ch, m); }
}
export const TREE = { pine: [PINE, "p", 1.3], oak: [BROAD, "g", 1], ash: [BROAD, "G", 0.68], aspen: [BROAD, "G", 0.86] };

// Background blended from the cover shares, lit by the hillshade, darkened where the sky is hidden.
function groundBg(w, x, z, sh, heath) {
  let c = [0, 0, 0];
  for (const k of COVER) {
    const f = w.fine(w.cover[k], x, z);
    const base = k === "shrub" && heath > 0.5 ? BG.heath : BG[k];
    c = [c[0] + base[0] * f, c[1] + base[1] * f, c[2] + base[2] * f];
  }
  const ao = 0.8 + 0.2 * w.fine(w.sky, x, z);
  return sc(c, clamp(sh, 0.55, 1.5) * ao);
}
// The cover to draw a glyph for, picked in proportion to the shares so that biome edges dither.
function coverPick(w, x, z, r, power) {
  const wts = COVER.map((k) => Math.pow(w.fine(w.cover[k], x, z), power));
  let total = wts.reduce((a, b) => a + b, 0), t = r * total;
  for (let n = 0; n < COVER.length; n++) if ((t -= wts[n]) < 0) return COVER[n];
  return "grass";
}

function waterDepthBg(depth, shoreDist) {
  if (depth < 1.2 || shoreDist <= 1) return sc(mix(P.c, P.b, 0.35), 0.5);
  if (depth < 4) return sc(mix(P.c, P.b, 0.6), 0.42);
  if (depth < 12) return sc(P.b, 0.52);
  if (depth < 30) return sc(P.b, 0.38);
  return sc(P.b, 0.26);
}

// Distance in cells from each water cell to the nearest land cell (0 on land).
function shoreDistance(g, isWater) {
  const n = g.cols * g.rows, d = new Int32Array(n).fill(1e9), q = [];
  for (let k = 0; k < n; k++) if (!isWater[k]) { d[k] = 0; q.push(k); }
  for (let h = 0; h < q.length; h++) {
    const k = q[h], i = k % g.cols, j = (k / g.cols) | 0;
    for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const a = i + di, b = j + dj;
      if (a < 0 || b < 0 || a >= g.cols || b >= g.rows) continue;
      const m = b * g.cols + a;
      if (d[m] > d[k] + 1) { d[m] = d[k] + 1; q.push(m); }
    }
  }
  return d;
}

function drawWater(g, k, x, z, depth, dist, lake, fine, chop = 0.34) {
  const i = k % g.cols, j = (k / g.cols) | 0, r = hash(i, j, 71), r2 = hash(i, j, 72);
  const bg = waterDepthBg(depth, dist);
  if (dist === 1) {
    g.put(k, r < 0.45 ? "~" : r < 0.8 ? "≈" : "∙", sc(r2 < 0.7 ? P.C : P.Y, 0.8), bg);
    g.glow[k] = 0.3;
    return;
  }
  // Swell runs in bands along the shore; between them a low chop of dark glyphs.
  const wobble = fbm(x / (fine ? 60 : 700), z / (fine ? 60 : 700), 90, 2);
  const band = (dist + wobble * 3) / (lake ? 2.6 : 3.4);
  const onBand = band - Math.floor(band) < 0.26 && hash(i >> 1, j, 73) < 0.85;
  if (onBand && dist < 7) g.put(k, "≈", sc(P.C, 0.72), bg);
  else if (onBand) g.put(k, "~", sc(P.B, 0.8), bg);
  else if (r < chop) g.put(k, "~", sc(P.b, 1.25 + r2 * 0.3), bg);
  else if (r < chop + 0.05) g.put(k, r2 < 0.5 ? "∙" : "·", sc(P.B, 0.65), bg);
  else g.put(k, " ", null, bg);
}

// ---------------------------------------------------------------- the island, about one glyph per 75 m cell
export function islandGrid(w, cols, rows, pad = 1.5) {
  const { isle, N, CELL, START } = w;
  let x0 = N, x1 = 0, y0 = N, y1 = 0;
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const k = y * N + x;
    if (isle.height[k] > 0 && isle.water[k] <= 0) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  }
  const s = Math.max(((x1 - x0 + 1 + pad * 2) * CELL) / cols, ((y1 - y0 + 1 + pad * 2) * CELL) / rows);
  const mx = START + ((x0 + x1) / 2) * CELL, mz = START + ((y0 + y1) / 2) * CELL;
  const g = makeGrid(cols, rows, s, mx - (cols * s) / 2, mz - (rows * s) / 2);
  const n = cols * rows;

  // Bins of what grows in each cell.
  const kinds = { pine: new Float32Array(n), oak: new Float32Array(n), ash: new Float32Array(n), aspen: new Float32Array(n) };
  for (const t of w.trees) { const k = g.at(t.x, t.z); if (k >= 0) kinds[t.kind][k]++; }
  const heath = new Float32Array(n), heathN = new Float32Array(n);
  for (const sh of w.shrubs) { const k = g.at(sh.x, sh.z); if (k >= 0) { heath[k] += sh.heath; heathN[k]++; } }

  const H = new Float32Array(n), Hmax = new Float32Array(n), wet = new Float32Array(n), cov = COVER.map(() => new Float32Array(n)), slope = new Float32Array(n);
  const S = 4;
  for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
    const k = j * cols + i;
    let hs = 0, hm = -1e9, ws = 0;
    for (let b = 0; b < S; b++) for (let a = 0; a < S; a++) {
      const x = g.ox + (i + (a + 0.5) / S) * s, z = g.oz + (j + (b + 0.5) / S) * s, h = w.heightAt(x, z);
      hs += h; hm = Math.max(hm, h); ws += w.fine(w.wet, x, z);
      COVER.forEach((c, m) => { cov[m][k] += w.fine(w.cover[c], x, z) / (S * S); });
    }
    H[k] = hs / (S * S); Hmax[k] = hm; wet[k] = ws / (S * S);
    slope[k] = w.slopeAt(g.cx(i), g.cz(j));
  }
  const water = Uint8Array.from(wet, (v, k) => (v > 0.5 ? 1 : 0));
  const dist = shoreDistance(g, water);

  // Streams, walked cell to cell so every glyph joins its neighbours; bits N=1 E=2 S=4 W=8.
  const link = new Uint8Array(n), flow = new Float32Array(n);
  for (const line of w.rivers) {
    let pi = null, pj = null;
    for (const [x, z, q] of line) {
      const i = Math.floor((x - g.ox) / s), j = Math.floor((z - g.oz) / s);
      if (pi === null) { pi = i; pj = j; }
      while (pi !== i || pj !== j) {
        const ni = Math.abs(i - pi) >= Math.abs(j - pj) ? pi + Math.sign(i - pi) : pi, nj = ni === pi ? pj + Math.sign(j - pj) : pj;
        const a = pj * cols + pi, b = nj * cols + ni, inA = pi >= 0 && pj >= 0 && pi < cols && pj < rows, inB = ni >= 0 && nj >= 0 && ni < cols && nj < rows;
        const dirAB = nj < pj ? 1 : ni > pi ? 2 : nj > pj ? 4 : 8, dirBA = { 1: 4, 2: 8, 4: 1, 8: 2 }[dirAB];
        if (inA) { link[a] |= dirAB; flow[a] = Math.max(flow[a], q); }
        if (inB) { link[b] |= dirBA; flow[b] = Math.max(flow[b], q); }
        pi = ni; pj = nj;
      }
    }
  }
  const SINGLE = { 1: "│", 4: "│", 5: "│", 2: "─", 8: "─", 10: "─", 3: "└", 9: "┘", 6: "┌", 12: "┐", 7: "├", 13: "┤", 14: "┬", 11: "┴", 15: "┼" };
  const DOUBLE = { 1: "║", 4: "║", 5: "║", 2: "═", 8: "═", 10: "═", 3: "╚", 9: "╝", 6: "╔", 12: "╗", 7: "╠", 13: "╣", 14: "╦", 11: "╩", 15: "╬" };

  // Each cell takes its dominant cover, then a majority vote of its neighbours, so biomes read as masses. Shore
  // cells skip the vote so one-cell beaches survive.
  const bias = [1, 1, 1.22, 1, 1, 1.3], coast = (i, j) => [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([a, b]) => water[clamp(j + b, 0, rows - 1) * cols + clamp(i + a, 0, cols - 1)]);
  const dom = new Int8Array(n).fill(-1);
  for (let k = 0; k < n; k++) if (!water[k]) { let b = 0; for (let m = 1; m < 6; m++) if (cov[m][k] * bias[m] > cov[b][k] * bias[b]) b = m; dom[k] = b; }
  const region = Int8Array.from(dom);
  for (let j = 1; j < rows - 1; j++) for (let i = 1; i < cols - 1; i++) {
    const k = j * cols + i;
    if (dom[k] < 0 || coast(i, j)) continue;
    const votes = [0, 0, 0, 0, 0, 0];
    for (let b = -1; b <= 1; b++) for (let a = -1; a <= 1; a++) { const m = dom[k + b * cols + a]; if (m >= 0) votes[m] += a || b ? 1 : 2.5; }
    region[k] = votes.indexOf(Math.max(...votes));
  }
  // Tree kind from a 5x5 neighbourhood, so kinds form stands rather than speckle.
  const KINDS = ["pine", "oak", "ash", "aspen"];
  const kindAt = (i, j) => {
    const sum = [0, 0, 0, 0];
    for (let b = -2; b <= 2; b++) for (let a = -2; a <= 2; a++) {
      const ii = i + a, jj = j + b;
      if (ii < 0 || jj < 0 || ii >= cols || jj >= rows) continue;
      const wgt = 3 - Math.max(Math.abs(a), Math.abs(b));
      KINDS.forEach((kk, q) => { sum[q] += kinds[kk][jj * cols + ii] * wgt * (kk === "pine" ? 1.6 : 1); });
    }
    const best = Math.max(...sum);
    return best > 0 ? KINDS[sum.indexOf(best)] : "ash";
  };

  for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
    const k = j * cols + i, x = g.cx(i), z = g.cz(j), r2 = hash(i, j, 12), r3 = hash(i, j, 13);
    if (water[k]) {
      const lake = H[k] > 0.5;
      drawWater(g, k, x, z, lake ? w.bilinear(w.isle.water, (x - START) / CELL, (z - START) / CELL) : -H[k], dist[k], lake, false, 0.16);
      continue;
    }
    const sh = shade(w, x, z, s * 0.6, 2.4), lit = clamp(0.8 + (sh - 1) * 0.9, 0.5, 1.3);
    const hk = heathN[k] ? heath[k] / heathN[k] : 0, cls = COVER[region[k]];
    let bg = [0, 0, 0];
    COVER.forEach((c, m) => { const b = c === "shrub" && hk > 0.5 ? BG.heath : BG[c]; bg = [bg[0] + b[0] * cov[m][k], bg[1] + b[1] * cov[m][k], bg[2] + b[2] * cov[m][k]]; });
    const own = cls === "shrub" && hk > 0.5 ? BG.heath : BG[cls], alt = smooth(40, 330, H[k]);
    bg = sc(mix(mix(bg, own, 0.55), sc(P.y, 0.3), alt * 0.45), clamp(sh, 0.55, 1.45));
    const f = (code, mul = 1) => sc(P[code], lit * mul);
    let ch = " ", fg = P.y;
    const peak = Hmax[k] > 140 && [...Array(49).keys()].every((q) => { const a = i + (q % 7) - 3, b = j + ((q / 7) | 0) - 3; return a < 0 || b < 0 || a >= cols || b >= rows || Hmax[b * cols + a] <= Hmax[k]; });

    if (peak) { ch = "▲"; fg = P.Y; g.glow[k] = 0.4; }
    else if (slope[k] > 0.45 && cls !== "tree" && cls !== "sand") { ch = slope[k] > 0.65 ? "▓" : "▒"; fg = f(alt > 0.3 ? "y" : "s", 0.9); }
    else if (cls === "tree") { const [gl, code, mul] = TREE[kindAt(i, j)]; ch = gl; fg = f(code, mul * (0.9 + r3 * 0.1)); }
    else if (cls === "shrub") { ch = hk > 0.5 ? '"' : "τ"; fg = f(hk > 0.5 ? "m" : "v"); }
    else if (cls === "grass" && H[k] > 110) { ch = "∩"; fg = f("v", 1.05); }
    else if (cls === "grass") {
      ch = r2 < 0.55 ? '"' : r2 < 0.85 ? "," : "."; fg = f("l", r2 < 0.55 ? 0.95 : 0.8);
      if (r3 < 0.012) { ch = "*"; fg = P[["P", "M", "W"][(r3 * 1000) % 3 | 0]]; }
    } else if (cls === "marsh") { ch = r2 < 0.8 ? '"' : "√"; fg = f("c", 0.85); }
    else if (cls === "bare") {
      if (H[k] > 170) { ch = r2 < 0.7 ? "▲" : "^"; fg = f("y", 0.95); }
      else if (H[k] > 60) { ch = "^"; fg = f("s", 1.15); }
      else { ch = r2 < 0.75 ? ":" : "∙"; fg = f("s", 1.05); }
    } else { ch = r2 < 0.7 ? "░" : "∙"; fg = f("t", 0.95); }
    if (link[k]) {
      const big = flow[k] > 0.8;
      ch = (big ? DOUBLE : SINGLE)[link[k]] || "~";
      fg = big ? P.C : P.c;
      bg = mix(bg, sc(P.b, 0.45), 0.55);
      g.glow[k] = 0.25;
    }
    g.put(k, ch, fg, bg);
  }
  return g;
}

// ---------------------------------------------------------------- the local map: valley (about 10 m) and camp (1 m)
export function localGrid(w, cols, rows, s, cx, cz) {
  const g = makeGrid(cols, rows, s, cx - (cols * s) / 2, cz - (rows * s) / 2), n = cols * rows;
  const fineScale = s < 3;
  const water = new Uint8Array(n), river = new Float32Array(n);
  for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
    const k = j * cols + i, x = g.cx(i), z = g.cz(j);
    water[k] = w.fine(w.wet, x, z) > 0.5 ? 1 : 0;
    river[k] = w.riverAt(x, z);
  }
  const dist = shoreDistance(g, water);
  const ex = fineScale ? 3 : 6, hgt = new Float32Array(n).fill(NaN);
  const heathAt = (x, z) => clamp(w.bilinear(w.isle.exposure, (x - w.START) / w.CELL, (z - w.START) / w.CELL) * 1.4 + w.fine(w.cover.shrub, x, z) - w.fine(w.moist, x, z) * 0.3, 0, 1);
  const lit = new Float32Array(n);
  for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
    const k = j * cols + i, x = g.cx(i), z = g.cz(j), r = hash(i + (g.ox / s | 0), j + (g.oz / s | 0), 21), r2 = hash(i, j, 22), r3 = hash(i, j, 23);
    if (water[k]) {
      const depth = w.heightAt(x, z) < 0.3 ? Math.max(0.5, -w.heightAt(x, z) + 0.5) : w.bilinear(w.isle.water, (x - w.START) / w.CELL, (z - w.START) / w.CELL);
      drawWater(g, k, x, z, depth, dist[k], w.heightAt(x, z) > 0.5, true);
      continue;
    }
    const sh = shade(w, x, z, Math.max(2, s * 0.6), ex), heath = heathAt(x, z);
    hgt[k] = w.heightAt(x, z);
    lit[k] = clamp(0.85 + (sh - 1) * 1.2, 0.5, 1.4);
    // Mottling at a few cells' scale, so open ground is not one flat tint.
    let bg = sc(groundBg(w, x, z, sh, heath), 0.82 + 0.36 * (0.5 + 0.5 * fbm(x / (s * 5), z / (s * 5), 33, 2)));
    const cls = coverPick(w, x, z, r, 2.2), sl = w.slopeAt(x, z);
    const set = cls === "tree" ? SETS.floor : cls === "shrub" ? (heath > 0.5 ? SETS.heath : SETS.shrub) : SETS[cls];
    let e = pick(set, r2);
    let fg = sc(P[e[1]], lit[k] * (0.68 + r3 * 0.32) * (cls === "marsh" ? 0.8 : 1)), ch = e[0];
    if (fineScale) {
      // At a metre a cell, bare ground shows between the plants the scatter will place.
      ch = r3 < 0.3 ? (r2 < 0.4 ? "." : r2 < 0.7 ? "∙" : ",") : " ";
      fg = sc(cls === "sand" ? P.t : cls === "bare" ? P.s : cls === "grass" ? P.v : P.w, 0.62 * lit[k]);
      if (cls === "marsh" && r3 < 0.5) { ch = pick(SETS.marsh, r2)[0]; fg = sc(P.c, lit[k] * 0.9); }
    } else if (cls === "grass" && r3 < 0.03) { ch = "*"; fg = sc(P[["P", "M", "W", "Y"][(r3 * 1000) % 4 | 0]], 0.85); }
    // Steep open ground as shade blocks, greyer and lighter the higher it stands.
    const [s1, s2, s3] = fineScale ? [0.34, 0.5, 0.75] : [0.1, 0.18, 0.32];
    if (sl > s1 && (cls !== "tree" || !fineScale)) {
      ch = sl > s3 ? "▓" : sl > s2 ? "▒" : "░";
      fg = sc(mix(P.s, P.y, smooth(20, 250, hgt[k])), lit[k] * (0.55 + r3 * 0.2));
    }
    if (river[k] > 0.3) {
      ch = r2 < 0.55 ? "≈" : "~"; fg = river[k] > 0.7 ? P.C : P.c; bg = sc(mix(P.b, P.c, 0.4), 0.5); g.glow[k] = 0.2;
    }
    g.put(k, ch, fg, bg);
  }
  g.water = water; g.river = river; g.lit = lit; g.dist = dist;
  if (!fineScale) g.relief = relief(g, hgt);
  return g;
}

// Height bands like contours: each band takes a step along a ramp from dark lowland green to pale upland tan, and a
// dark line runs along each band's lower edge, every fifth one heavier. The interval adapts to the view's relief.
const RAMP = [sc(P.p, 0.3), sc(mix(P.p, P.g, 0.5), 0.36), sc(mix(P.g, P.v, 0.4), 0.42), sc(P.v, 0.48), sc(mix(P.v, P.w, 0.5), 0.55), sc(mix(P.w, P.t, 0.5), 0.62)];
const ramp = (t) => { const x = clamp(t, 0, 1) * (RAMP.length - 1), a = Math.floor(x), b = Math.min(RAMP.length - 1, a + 1); return mix(RAMP[a], RAMP[b], x - a); };
function relief(g, hgt) {
  const n = g.cols * g.rows, frac = new Float32Array(n), line = new Uint8Array(n);
  let lo = Infinity, hi = -Infinity;
  for (const h of hgt) if (h === h) { lo = Math.min(lo, h); hi = Math.max(hi, h); }
  const step = [0.5, 1, 2, 5, 10, 20, 50].find((v) => (hi - lo) / v <= 10) ?? 50, band = (h) => Math.floor(h / step);
  for (let k = 0; k < n; k++) {
    const h = hgt[k];
    if (h !== h) continue;
    const i = k % g.cols, j = (k / g.cols) | 0, b = band(h);
    frac[k] = (b - band(lo)) / Math.max(1, band(hi) - band(lo));
    for (const [a, c] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const ii = i + a, jj = j + c;
      if (ii < 0 || jj < 0 || ii >= g.cols || jj >= g.rows) continue;
      const o = hgt[jj * g.cols + ii];
      if (o === o && band(o) < b) { line[k] = b % 5 === 0 ? 2 : 1; break; }
    }
  }
  return { frac, line, step };
}

// Trees, shrubs and rocks as single glyphs (valley scale), with canopy filling the gaps inside woods.
export function plantValley(w, g) {
  const n = g.cols * g.rows, trunk = new Array(n).fill(null), obj = new Uint8Array(n), floor = sc(P.p, 0.36);
  const x0 = g.ox, z0 = g.oz, x1 = g.ox + g.cols * g.s, z1 = g.oz + g.rows * g.s;
  const inView = (o) => o.x >= x0 && o.x < x1 && o.z >= z0 && o.z < z1;
  for (const t of w.trees) if (inView(t)) { const k = g.at(t.x, t.z); if (!trunk[k] || trunk[k].tall < t.tall) trunk[k] = t; }
  let trees = 0;
  for (let k = 0; k < n; k++) {
    if (g.water[k] || g.river[k] > 0.3) continue;
    const i = k % g.cols, j = (k / g.cols) | 0, x = g.cx(i), z = g.cz(j), cover = w.fine(w.cover.tree, x, z);
    const lit = g.lit[k] || 1;
    const t = trunk[k];
    if (t) {
      trees++;
      const [gl, code, mul] = TREE[t.kind];
      g.put(k, t.tall < 9 ? "τ" : gl, sc(P[code], lit * mul * (0.9 + t.tint * 0.14)), sc(floor, clamp(lit, 0.45, 1.4)));
      obj[k] = 1;
      continue;
    }
    // Canopy fill stops on steep ground, so the shade blocks of the slope show between the trunks.
    if (cover > 0.35 && hash(i, j, 31) < (cover - 0.3) * 0.85 && w.slopeAt(x, z) < 0.1) {
      let near = null, best = 1e9;
      for (let b = -2; b <= 2; b++) for (let a = -2; a <= 2; a++) {
        const m = (j + b) * g.cols + i + a, o = i + a >= 0 && i + a < g.cols && j + b >= 0 && j + b < g.rows ? trunk[m] : null;
        if (o && a * a + b * b < best) { best = a * a + b * b; near = o; }
      }
      const kind = near ? near.kind : "ash", [gl, code, mul] = TREE[kind];
      g.put(k, gl, sc(P[code], lit * mul * 0.55), sc(floor, clamp(lit * 0.9, 0.4, 1.3)));
      obj[k] = 1;
    }
  }
  for (const sh of w.shrubs) if (inView(sh)) {
    const k = g.at(sh.x, sh.z);
    if (trunk[k] || g.water[k]) continue;
    const lit = g.lit[k] || 1;
    g.put(k, sh.heath > 0.5 ? (sh.tint < 0.5 ? '"' : "τ") : "τ", sc(sh.heath > 0.5 ? P.m : sh.tint < 0.5 ? P.g : P.v, lit), null);
    obj[k] = 1;
  }
  for (const r of w.rocks) if (inView(r)) {
    const k = g.at(r.x, r.z);
    if (trunk[k] || g.water[k]) continue;
    g.put(k, r.size > 2.6 ? "O" : r.size > 1.2 ? "o" : "∙", sc(r.tint < 0.35 ? P.y : P.s, (g.lit[k] || 1) * 0.85), null);
    obj[k] = 1;
  }
  // The band colour replaces most of the ground tint and keeps the hillshade; each band's edge is a dark, dotted line,
  // like a contour on a survey map, drawn through the woods too so the relief reads under the trees.
  if (g.relief) {
    const { frac, line } = g.relief;
    for (let k = 0; k < n; k++) {
      if (g.water[k] || g.river[k] > 0.3) continue;
      const lit = clamp(g.lit[k] || 1, 0.4, 1.5), edge = line[k] === 2 ? 0.3 : line[k] ? 0.45 : 1;
      g.bg[k] = sc(mix(g.bg[k], sc(ramp(frac[k]), lit), 0.85), edge);
      g.fg[k] = sc(g.fg[k], 0.8 + 0.3 * frac[k]);
      if (line[k]) { g.ch[k] = line[k] === 2 ? "∙" : "·"; g.fg[k] = sc(line[k] === 2 ? P.W : P.t, (line[k] === 2 ? 0.8 : 0.7) * lit); }
    }
  }
  return { trees, contour: g.relief?.step };
}
