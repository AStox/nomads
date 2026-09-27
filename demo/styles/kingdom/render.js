// A side-on dusk shot of the island in pixel art: a vertical slice through the camp as the ground strip, the world's
// trees in parallax layers behind it, the land farther back as ever paler silhouettes, and still water in front
// mirroring all of it.
import { clamp, noise } from "../world.js";
import { h2, rng, pine, broad, shrub, rock } from "./sprites.js";
import * as camp from "./camp.js";

export const WIDTH = 427, HEIGHT = 240;

// ---------- color ----------
const BAY = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((v) => (v + 0.5) / 16);
const bayer = (x, y) => BAY[((y & 3) << 2) | (x & 3)];
const hex = (s) => parseInt(s.slice(1), 16);
const cr = (c) => (c >> 16) & 255, cg = (c) => (c >> 8) & 255, cb = (c) => c & 255;
const rgb = (r, g, b) => (clamp(Math.round(r), 0, 255) << 16) | (clamp(Math.round(g), 0, 255) << 8) | clamp(Math.round(b), 0, 255);
const mix = (a, b, t) => rgb(cr(a) + (cr(b) - cr(a)) * t, cg(a) + (cg(b) - cg(a)) * t, cb(a) + (cb(b) - cb(a)) * t);
const mul = (a, f) => rgb(cr(a) * f, cg(a) * f, cb(a) * f);
const add = (a, b, t) => rgb(cr(a) + cr(b) * t, cg(a) + cg(b) * t, cb(a) + cb(b) * t);
const H = (list) => list.map(hex);

// Base materials as they look near the eye at dusk: cool shadows, warm sunward highlights.
const WOOD = H(["#110b0a", "#241813", "#3c291d"]);
const NONE = H(["#000000", "#000000"]);
const MAT = {
  pine: { main: H(["#07131a", "#0c2224", "#153330", "#214536", "#8c7a4c"]), wood: WOOD, acc: NONE },
  oak: { main: H(["#0a1510", "#132619", "#1e3a20", "#305226", "#9a8a4a"]), wood: WOOD, acc: NONE },
  ash: { main: H(["#0b1a17", "#152e23", "#22452d", "#365f35", "#a49452"]), wood: WOOD, acc: NONE },
  aspenG: { main: H(["#121f10", "#223817", "#39521e", "#587028", "#b8a452"]), wood: WOOD, acc: H(["#8e8878", "#000000"]) },
  aspenY: { main: H(["#221710", "#442d14", "#6a4a1a", "#977024", "#d8b45a"]), wood: WOOD, acc: H(["#8e8878", "#000000"]) },
  shrub: { main: H(["#09130d", "#112217", "#1c3420", "#2d4c28", "#8a7c4a"]), wood: WOOD, acc: H(["#a0587a", "#000000"]) },
  heath: { main: H(["#120b16", "#24172c", "#3a2440", "#553654", "#9a7068"]), wood: WOOD, acc: H(["#a45c94", "#000000"]) },
  rock: { main: H(["#121219", "#22222b", "#363642", "#50525e", "#8a8078"]), wood: WOOD, acc: H(["#2e4626", "#000000"]) },
  canopy: { main: H(["#08141a", "#0f2224", "#173430", "#244a38", "#7c7048"]), wood: WOOD, acc: NONE },
  ground: { main: H(["#0b120c", "#121d15", "#1b2a1b", "#2b4024", "#566a34"]), wood: WOOD, acc: NONE },
  canvas: { main: H(["#2e221e", "#5a4538", "#846a52", "#ab8e6c", "#d6bc90"]), wood: H(["#1a120c", "#36251a", "#56402c"]), acc: H(["#0e0806", "#7a2f3f"]) },
  hide: { main: H(["#2c1b16", "#543322", "#7a4f30", "#a07044", "#cc9c62"]), wood: H(["#1a120c", "#36251a", "#56402c"]), acc: H(["#0e0806", "#2f4a6d"]) },
  flame: { main: H(["#6a1e18", "#b83a1c", "#f07a22", "#ffc040", "#fff2b0"]), wood: H(["#1a100b", "#342014", "#5e3e26"]), acc: H(["#34303a", "#56505a"]) },
  logs: { main: H(["#2e1e12", "#5a3e24", "#7e5c38", "#a07c4e", "#c29c68"]), wood: H(["#140c08", "#2c1c12", "#4a3220"]), acc: NONE },
  iron: { main: H(["#121016", "#211e26", "#36323c", "#4e4a56", "#7a7280"]), wood: H(["#1a120c", "#36251a", "#56402c"]), acc: NONE },
};

// Dusk sky from zenith to horizon, in bands.
const SKY = H(["#0e0d27", "#131232", "#19163c", "#201a47", "#281e51", "#32225a", "#3e2662", "#4b2b69", "#5a306e", "#6b3672", "#7e3d74", "#924574", "#a64e73", "#b95970", "#ca656c", "#d97468", "#e68664", "#ef9b63", "#f5b168", "#f9c674", "#fbd687"]);
const SUN = H(["#fff8dc", "#ffeaa8", "#ffd27e", "#ffb862"]);
const FIRE = hex("#ff8a30"), FIRE_RIM = hex("#ffc06a"), SUN_RIM = hex("#e8a060"), SKY_RIM = hex("#7a6ca4");
const WATER = hex("#10162e"), WATER_HI = hex("#5c5c94"), DUSK = hex("#1c1a3c");
// Haze from near (dark blue) to the horizon glow (pale mauve).
const HAZE = H(["#161d30", "#232a46", "#343660", "#4b4476", "#655488", "#846896", "#a47ea2", "#c296a8"]);

// ---------- the frame ----------
class Frame {
  constructor(w, h) {
    this.w = w; this.h = h;
    this.c = new Int32Array(w * h);
    this.z = new Float32Array(w * h).fill(1e9);
    this.lay = new Uint8Array(w * h).fill(255);
  }
  put(x, y, c, z, lay) {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    const i = y * this.w + x;
    this.c[i] = c; this.z[i] = z; this.lay[i] = lay;
  }
}
function blit(F, S, x, y, pal, z, lay, flip = false, clip = null) {
  const x0 = Math.round(x) - (flip ? S.w - 1 - Math.round(S.ax) : Math.round(S.ax)), y0 = Math.round(y) - S.ay;
  for (let j = 0; j < S.h; j++) {
    const yy = y0 + j;
    if (yy < 0 || yy >= F.h) continue;
    for (let i = 0; i < S.w; i++) {
      const code = S.c[j * S.w + (flip ? S.w - 1 - i : i)], xx = x0 + i;
      if (code && !(clip && xx >= 0 && xx < F.w && yy >= clip[xx])) F.put(xx, yy, pal[code], z, lay);
    }
  }
}

// ---------- which slice ----------
// The slice runs through the camp from the sea up into the hills, and the camera looks at it across water.
function chooseSlice(W) {
  const c = W.camp.at, wetAt = (x, z) => W.fine(W.wet, x, z) > 0.5 || W.heightAt(x, z) < 0;
  let best = null;
  for (let k = 0; k < 72; k++) {
    const a = (k / 72) * Math.PI * 2, ux = Math.cos(a), uz = Math.sin(a);
    for (const side of [1, -1]) {
      const nx = -uz * side, nz = ux * side;
      let front = 0, fsum = 0;
      for (let s = -200; s <= 200; s += 20) {
        let f = 400;
        for (let q = 10; q < 400; q += 10) if (wetAt(c.x + ux * s + nx * q, c.z + uz * s + nz * q)) { f = q; break; }
        if (f < 400) front++;
        fsum += f;
      }
      let sea = 2000;
      for (let r = 10; r < 2000; r += 10) if (W.heightAt(c.x - ux * r, c.z - uz * r) < 0) { sea = r; break; }
      let hill = 0, tree = 0;
      for (let r = 300; r <= 1500; r += 20) hill = Math.max(hill, W.heightAt(c.x + ux * r, c.z + uz * r));
      for (let r = 50; r <= 600; r += 25) tree += W.fine(W.cover.tree, c.x + ux * r, c.z + uz * r) / 23;
      const score = (front / 21) * 3 - fsum / 21 / 200 - sea / 800 + Math.min(hill, 200) / 100 + tree;
      if (!best || score > best.score) best = { score, ux, uz, nx, nz };
    }
  }
  const F = [-best.nx, -best.nz], R = [-F[1], F[0]];
  return {
    O: c, R, F, hills: Math.sign(best.ux * R[0] + best.uz * R[1]),
    P: (s, d) => [c.x + R[0] * s + F[0] * d, c.z + R[1] * s + F[1] * d],
    sd: (x, z) => { const dx = x - c.x, dz = z - c.z; return [dx * R[0] + dz * R[1], dx * F[0] + dz * F[1]]; },
    wetAt,
  };
}

// ---------- views ----------
// Each layer: [nearest depth, farthest depth, its depth, height exaggeration, sprite size factor].
function layers(spec, D0, gamma) {
  return spec.map(([d0, d1, D, ex, sig], i) => {
    const n = i === 0 ? 1 : Math.max(1, Math.min(6, Math.ceil((d1 - d0) / 60)));
    const lines = Array.from({ length: n }, (_, k) => (i === 0 ? 0 : d0 + ((k + 0.5) / n) * (d1 - d0)));
    return { i, d0, d1, D, ex, sig, sL: Math.pow(D0 / (D0 + D), gamma), lines, items: [] };
  });
}
function makeView(name, S) {
  const hs = S.hills;
  if (name === "camp") {
    const D0 = 45;
    return {
      name, k0: 13, sc: -1.5 * hs, D0, yh: 178, stones: 0.22, cap: 100, fogD: 170, fogFar: 4500, sunR: 15, spread: 1,
      L: layers([[-9, 13, 0, 0.2, 1], [13, 30, 20, 0.3, 1], [30, 70, 48, 0.45, 1.05], [70, 160, 110, 0.7, 1.15], [160, 400, 260, 1, 1.3], [400, 1000, 650, 0.8, 0.9], [1000, 2200, 1500, 1.4, 1.2], [2200, 4200, 3000, 2.4, 1.5], [4200, 7000, 5400, 3.6, 2]], D0, 1),
    };
  }
  if (name === "island") {
    // Far out at sea: the whole island across the frame.
    const D0 = 7000, spec = [], cuts = [-3700, -2200, -900, 400, 1800, 3300, 4700, 6200];
    for (let k = 0; k < cuts.length - 1; k++) spec.push([cuts[k], cuts[k + 1], (cuts[k] + cuts[k + 1]) / 2, 4.2, 3.2]);
    const L = layers(spec, D0, 1);
    L.forEach((l) => (l.lines = Array.from({ length: 6 }, (_, k) => l.d0 + ((k + 0.5) / 6) * (l.d1 - l.d0))));
    return { name, k0: 0, sc: 0, D0, yh: 150, cap: 120, fogD: 6000, fogFar: 10500, fogBase: -3700, fogMin: 0.6, flat: 0.8, sunR: 13, spread: 1.6, L, island: true };
  }
  const D0 = 250;
  return {
    name, k0: 1.52, sc: 36 * hs, D0, yh: 170, cap: 104, fogD: 520, fogFar: 6500, sunR: 14, spread: 1.2, campScale: 1.6, stones: 0.1,
    L: layers([[-12, 12, 0, 1.6, 2.4], [12, 40, 26, 1.8, 2.4], [40, 100, 70, 2.2, 2.4], [100, 240, 170, 2.3, 2.5], [240, 600, 420, 2.4, 2.6], [600, 1400, 1000, 2.6, 2.4], [1400, 2600, 2000, 3.2, 2], [2600, 4200, 3400, 4.2, 2], [4200, 7000, 5500, 5.4, 2]], D0, 1),
  };
}
const lift = (V, l, h) => { const v = h * V.k0 * l.sL * l.ex; return l.i === 0 && !V.island ? v : V.cap * Math.tanh(v / V.cap); };

// Atmosphere: near layers sink into dark blue, the middle into violet, the farthest into the horizon glow.
function fogOf(V, D) {
  const rel = Math.max(0, D - (V.fogBase ?? 0)), t = Math.pow(clamp(rel / V.fogFar, 0, 1), 0.6) * (HAZE.length - 1);
  const k = Math.min(HAZE.length - 2, Math.floor(t));
  const f = 1 - Math.exp(-rel / V.fogD), m = V.fogMin ?? 0;
  return { col: mix(HAZE[k], HAZE[k + 1], t - k), f: clamp(m + (1 - m) * f, 0, 0.96) };
}
function palette(L, key) {
  L.pals ??= {};
  if (L.pals[key]) return L.pals[key];
  const m = MAT[key], { col, f } = L.fog, p = new Int32Array(11), dusk = L.dusk;
  const tone = (c) => mix(mix(c, DUSK, dusk), col, f);
  m.main.forEach((c, k) => (p[1 + k] = tone(c)));
  m.wood.forEach((c, k) => (p[6 + k] = tone(c)));
  p[9] = tone(m.acc[0]); p[10] = tone(m.acc[1]);
  // Far layers read as flat silhouettes: squeeze the ramp to two tones.
  const flat = L.flat;
  if (f > flat) { const fill = tone(MAT.ground.main[2]); for (let k = 1; k <= 9; k++) p[k] = mix(p[k], fill, clamp((f - flat) / 0.22, 0, 1)); }
  return (L.pals[key] = p);
}

// ---------- sky ----------
// The land is drawn first; the sky then fills whatever is still empty, so the sun can sit in the lowest gap of the
// skyline on its side of the frame.
function placeSun(F, V) {
  const R = V.sunR, top = new Float32Array(F.w);
  for (let x = 0; x < F.w; x++) { let y = 0; while (y < V.yh && F.lay[y * F.w + x] === 255) y++; top[x] = y; }
  let bx = Math.round(F.w * 0.78), best = -1;
  for (let x = Math.round(F.w * 0.6); x < F.w * 0.9; x++) {
    let s = 0;
    for (let k = -R; k <= R; k++) s += top[clamp(x + k, 0, F.w - 1)];
    if (s > best) { best = s; bx = x; }
  }
  const sy = clamp(best / (2 * R + 1) - R * 0.4, V.yh * 0.3, V.yh - R * 0.45);
  V.sun = [bx, Math.round(sy)];
}
function drawSky(F, V, seed) {
  const { yh } = V, [sx, sy] = V.sun, r = rng(seed * 11 + 5), open = (i) => F.lay[i] === 255;
  for (let y = 0; y < yh; y++) for (let x = 0; x < F.w; x++) {
    const i = y * F.w + x;
    if (!open(i)) continue;
    const t = y / yh, d = Math.hypot((x - sx) * 0.5, (y - sy) * 1.25);
    let v = Math.pow(t, 1.3) * 0.84 + Math.exp(-d / 75) * 0.3 + Math.exp(-d / 22) * 0.18;
    v = clamp(v, 0, 1) * (SKY.length - 1);
    let k = Math.floor(v);
    const fr = v - k;
    if (fr > 0.75 && bayer(x, y) < (fr - 0.75) / 0.25) k++;
    F.c[i] = SKY[Math.min(SKY.length - 1, k)];
  }
  for (let y = 1; y < yh * 0.55; y++) for (let x = 1; x < F.w - 1; x++) {
    const p = h2(x, y, seed + 71), lim = 0.005 * (1 - y / (yh * 0.55)) * (1 - Math.exp(-Math.abs(x - sx) / 70)), i = y * F.w + x;
    if (p >= lim || !open(i)) continue;
    const bright = p < lim * 0.22;
    F.c[i] = bright ? hex("#f2eaff") : mix(F.c[i], hex("#cfc4ee"), 0.5);
    if (bright && p < lim * 0.07) for (const j of [i - 1, i + 1, i - F.w, i + F.w]) if (open(j)) F.c[j] = mix(F.c[j], hex("#b0a6dc"), 0.45);
  }
  // A pale moon high on the dark side, with a faint halo.
  const mx = Math.round(F.w - sx + 26 * (sx > F.w / 2 ? -1 : 1)), my = Math.round(yh * 0.16), mr = 6;
  for (let y = -mr - 4; y <= mr + 4; y++) for (let x = -mr - 4; x <= mr + 4; x++) {
    const q = Math.hypot(x, y), i = (my + y) * F.w + mx + x;
    if (!open(i)) continue;
    if (q <= mr) F.c[i] = h2(x + 9, y + 9, 3) < 0.14 && q < mr - 1 ? hex("#b4acd0") : x + y * 0.4 < -mr * 0.6 ? hex("#c8c0de") : hex("#efe9f6");
    else if (q < mr + 4 && bayer(mx + x, my + y) < 0.55 * (1 - (q - mr) / 4)) F.c[i] = mix(F.c[i], hex("#8c7cbc"), 0.3);
  }
  const R = V.sunR;
  for (let y = -R; y <= R; y++) for (let x = -R; x <= R; x++) {
    const q = Math.hypot(x, y) / R, i = (sy + y) * F.w + sx + x;
    if (q > 1 || sy + y >= yh || sx + x < 0 || sx + x >= F.w || !open(i)) continue;
    F.c[i] = SUN[q < 0.55 ? 0 : q < 0.8 ? 1 : q < 0.93 ? 2 : 3];
  }
  drawClouds(F, V, r, open);
}

// Clouds: heaps of round puffs on flat bases. Each puff is dark on top and lit underneath and toward the low sun;
// lower puffs overlap higher ones so every lump keeps its own outline.
function drawClouds(F, V, r, open) {
  const { yh } = V, [sx, sy] = V.sun, n = 7, sky = Int32Array.from(F.c);
  for (let k = 0; k < n; k++) {
    const lvl = (k + r() * 0.7) / n, cy = Math.round(yh * (0.12 + lvl * 0.6)), size = 1.3 - lvl * 0.9;
    const w = (70 + r() * 130) * size, th = (8 + r() * 10) * size, cx = ((k * 0.382 + 0.15 + r() * 0.25) % 1) * (F.w + 120) - 60;
    const puffs = [], m = 3 + Math.floor(w / 12);
    for (let j = 0; j < m; j++) {
      const u = (j + r() * 0.8) / m - 0.5, pr = th * (0.5 + r() * 0.55) * Math.sqrt(Math.max(0.12, 1 - 4 * u * u));
      puffs.push({ x: cx + u * w * 0.95, y: cy - pr * (0.15 + r() * 0.4), r: Math.max(1.5, pr) });
    }
    for (let j = 0; j < m / 2; j++) {
      const u = (r() - 0.5) * 0.7, pr = th * (0.35 + r() * 0.4) * Math.sqrt(Math.max(0.12, 1 - 4 * u * u));
      puffs.push({ x: cx + u * w, y: cy - th * (0.7 + r() * 0.35) - pr * 0.1, r: Math.max(1.5, pr) });
    }
    puffs.sort((p, q) => p.y - q.y);
    for (const p of puffs) {
      const near = Math.exp(-Math.abs(p.x - sx) / 120 - Math.abs(cy - sy) / 90), side = Math.sign(sx - p.x) || 1;
      const glow = mix(hex("#b85a74"), hex("#ffc482"), near), lit = mix(hex("#7c3c6c"), hex("#ee8c70"), near);
      for (let y = Math.max(0, Math.floor(p.y - p.r)); y <= Math.min(cy, yh - 1); y++) for (let x = Math.max(0, Math.floor(p.x - p.r)); x <= Math.min(F.w - 1, p.x + p.r); x++) {
        const nx = (x + 0.5 - p.x) / p.r, ny = (y + 0.5 - p.y) / p.r, i = y * F.w + x;
        if (nx * nx + ny * ny > 1 || !open(i) || (y >= cy && p.r < 3.5)) continue;
        const q = nx * nx + ny * ny, v = ny + nx * side * 0.12;
        let col = mix(sky[i], hex("#7a4478"), 0.5);
        if (y >= cy) col = near > 0.3 ? glow : lit;
        else if (v > 0.32 && q > 0.35) col = q > 0.72 && v > 0.62 ? glow : lit;
        else if (v < -0.5 && q > 0.5) col = mix(sky[i], hex("#34204e"), 0.5);
        F.c[i] = col;
      }
    }
  }
  for (let k = 0; k < 3; k++) {
    const y = sy - V.sunR + 5 + k * 5 + Math.floor(r() * 2), x0 = sx - V.sunR - 16 - r() * 30, x1 = sx + V.sunR + 12 + r() * 40;
    for (let x = Math.floor(x0); x < x1; x++) if (y < yh && x >= 0 && x < F.w && (x * 7 + k * 13) % 29 > 2 && open(y * F.w + x)) F.c[y * F.w + x] = mix(hex("#a64a64"), hex("#e8845e"), Math.exp(-Math.abs(x - sx) / 22));
  }
}

// ---------- world items into layers ----------
function sortIntoLayers(W, V, S) {
  const L = V.L, last = L[L.length - 1];
  const take = (list, type) => {
    for (const o of list) {
      const [s, d] = S.sd(o.x, o.z);
      if (d < L[0].d0 || d >= last.d1) continue;
      let l = null;
      for (const q of L) if (d >= q.d0 && d < q.d1) { l = q; break; }
      const x = WIDTH / 2 + (s - V.sc) * V.k0 * l.sL;
      if (x < -70 || x > WIDTH + 70) continue;
      l.items.push({ type, o, s, d, x });
    }
  };
  take(W.trees, "tree");
  take(W.shrubs, "shrub");
  take(W.rocks, "rock");
}

function profileOf(W, V, S, l) {
  const prof = new Float32Array(WIDTH);
  for (let x = 0; x < WIDTH; x++) {
    const s = V.sc + (x + 0.5 - WIDTH / 2) / (V.k0 * l.sL);
    let h = -1e9;
    for (const d of l.lines) { const [px, pz] = S.P(s, d); h = Math.max(h, W.heightAt(px, pz)); }
    prof[x] = h;
  }
  return prof;
}

// ---------- drawing a layer ----------
function drawBand(F, V, l, prof) {
  const pal = palette(l, "ground"), tops = new Int16Array(WIDTH).fill(V.yh);
  for (let x = 0; x < WIDTH; x++) {
    if (prof[x] <= 0.05) continue;
    const top = (tops[x] = Math.round(V.yh - lift(V, l, prof[x])));
    for (let y = Math.max(0, top); y < V.yh; y++) F.put(x, y, y === top ? pal[4] : y === top + 1 ? pal[3] : pal[2], l.D, l.i);
  }
  return tops;
}

// Hazy far layers only let their trees break the skyline, as round or pointed crowns in the layer's own tone, so
// they read as clean silhouettes with forested ridges.
function dome(F, cx, base, w, hgt, pointy, pal, z, lay, clip) {
  const hw = w / 2;
  for (let dx = -Math.floor(hw); dx <= hw; dx++) {
    const x = Math.round(cx + dx);
    if (x < 0 || x >= F.w) continue;
    const u = Math.abs(dx) / (hw + 0.5), top = Math.round(base - hgt * (pointy ? 1 - u : Math.sqrt(1 - u * u))), lim = Math.min(clip[x], base);
    for (let y = Math.max(0, top); y < lim; y++) F.put(x, y, y === top && dx > 0 ? pal[3] : pal[2], z, lay);
  }
}
function drawItems(F, V, l, W, y0, clip = null) {
  l.items.sort((a, b) => b.d - a.d);
  const k = V.k0 * l.sL * l.sig;
  for (const it of l.items) {
    const o = it.o, base = y0 ? y0(it.x) : V.yh - lift(V, l, o.y);
    if (it.type === "tree") {
      const hp = Math.round(o.tall * k);
      const key = V.island ? (o.kind === "pine" ? "pine" : o.tint < 0.12 ? "aspenY" : "canopy") : o.kind === "aspen" ? (o.tint < 0.3 ? "aspenY" : "aspenG") : o.kind;
      const pal = palette(l, key);
      if (clip) { dome(F, it.x, Math.round(base), Math.max(1, hp * (o.kind === "pine" ? 0.42 : o.kind === "aspen" ? 0.5 : 0.75)), Math.max(1, hp), o.kind === "pine", palette(l, "ground"), it.d, l.i, clip); continue; }
      if (hp < 2) { F.put(Math.round(it.x), Math.round(base) - 1, pal[2], it.d, l.i); continue; }
      blit(F, o.kind === "pine" ? pine(hp, Math.floor(o.tint * 6)) : broad(o.kind, hp, Math.floor(o.tint * 6)), it.x, base, pal, it.d, l.i);
    } else if (it.type === "shrub") {
      const hp = Math.round(o.tall * k * 0.8);
      if (hp < 1) continue;
      const heath = o.heath > 0.55;
      blit(F, shrub(Math.max(1, hp), heath ? 1 : 0, Math.floor(o.tint * 4)), it.x, base, palette(l, heath ? "heath" : "shrub"), it.d, l.i, false, clip);
    } else if (it.type === "rock") {
      const wp = Math.round(o.size * k);
      if (wp < 2) continue;
      const moss = W.fine(W.moist, o.x, o.z) > 0.55 ? 0.45 : 0;
      blit(F, rock(wp, Math.floor(o.tint * 5), moss), it.x, base + 1, palette(l, "rock"), it.d, l.i, false, clip);
    } else if (it.draw) it.draw(F, it, l, base);
  }
}

// The slice itself: a grass edge over a bank of earth with stones and roots, down to the waterline.
const SOIL = H(["#100a0a", "#1c1210", "#281913", "#372218", "#4a2f1e"]), SAND = H(["#28201e", "#3e3229", "#5a4a38", "#78644a", "#94805c"]);
const TURF = H(["#15220f", "#223614", "#33501a", "#4c6a22", "#728434"]), MARSH = H(["#152014", "#1f2e19", "#2c3e20", "#3e5226", "#5e6c32"]);
function slicecover(W, V, S, l, prof) {
  const cov = new Array(WIDTH);
  for (let x = 0; x < WIDTH; x++) {
    const s = V.sc + (x + 0.5 - WIDTH / 2) / (V.k0 * l.sL), [px, pz] = S.P(s, 0);
    cov[x] = { sand: W.fine(W.cover.sand, px, pz) + (prof[x] < 1.4 ? 0.5 : 0), marsh: W.fine(W.cover.marsh, px, pz), tree: W.fine(W.cover.tree, px, pz), grass: W.fine(W.cover.grass, px, pz), bare: W.fine(W.cover.bare, px, pz) };
  }
  return cov;
}
function drawBank(F, V, l, prof, cov, roots) {
  const yh = V.yh, topOf = (x) => Math.round(yh - lift(V, l, prof[x]));
  for (let x = 0; x < WIDTH; x++) {
    if (prof[x] <= 0) continue;
    const top = topOf(x), c = cov[x], sandy = c.sand > 0.45, turf = sandy ? SAND : c.marsh > 0.4 ? MARSH : TURF, deep = Math.max(1, yh - top);
    const hang = sandy ? 1 : 2 + Math.floor(h2(x, 1, 5) * 2.2);
    const drip = sandy ? 0 : h2(x, 9, 7) < 0.3 ? 1 + Math.floor(h2(x, 10, 7) * 3.5) : 0;
    for (let y = Math.max(0, top); y < yh; y++) {
      const dep = y - top, left = yh - y;
      let col;
      if (dep === 0) col = turf[4];
      else if (dep === 1) col = turf[3];
      else if (dep <= hang) col = turf[dep === hang ? 1 : 2];
      else if (dep <= hang + drip && left > 2) col = turf[dep === hang + drip ? 0 : 1];
      else {
        const ramp = sandy ? SAND : SOIL, strata = noise(x / 26, y / 3.2, 17);
        let v = 3.4 - (dep / deep) * 1.6 + (strata > 0.3 ? 0.9 : strata < -0.35 ? -0.9 : 0);
        if (noise(x / 7, y / 4, 18) > 0.5) v -= 1;
        if (h2(x, y, 19) < 0.014) v += 1.5;
        if (left <= 2) v = left === 1 ? 0 : 1;
        col = ramp[clamp(Math.floor(v), 0, 4)];
      }
      F.put(x, y, col, 0, 0);
    }
  }
  // Stones set in the bank.
  const cell = Math.max(8, Math.round(V.k0 * 1.8));
  for (let gy = 0; gy < yh; gy += cell) for (let gx = 0; gx < WIDTH; gx += cell) {
    if (h2(gx, gy, 77) > (V.stones ?? 0.34)) continue;
    const x = gx + Math.floor(h2(gx, gy, 78) * cell), y = gy + Math.floor(h2(gx, gy, 79) * cell);
    if (x >= WIDTH || prof[x] <= 0) continue;
    const top = topOf(x);
    const rr = 1.2 + h2(gx, gy, 80) * Math.min(4, cell * 0.3), ry = rr * 0.72;
    if (y < top + 4 + ry || y > yh - 2) continue;
    for (let dy = -Math.ceil(ry); dy <= ry; dy++) for (let dx = -Math.ceil(rr); dx <= rr; dx++) {
      const q = (dx / rr) ** 2 + (dy / ry) ** 2;
      if (q > 1 || y + dy >= yh) continue;
      const v = q < 0.55 && dx * 0.5 - dy * 0.8 > 0.2 ? hex("#6e6874") : q > 0.55 && dy > 0 ? hex("#1e1a22") : hex("#46424c");
      F.put(x + dx, y + dy, v, 0, 0);
    }
  }
  // Roots under trees standing on the edge.
  for (const [x0, len, seed] of roots) {
    const r = rng(seed);
    for (let b = 0; b < 4; b++) {
      let x = x0 + (r() - 0.5) * 4, dir = (r() - 0.5) * 2;
      const xi = Math.round(clamp(x, 0, WIDTH - 1));
      if (prof[xi] <= 0) continue;
      let y = topOf(xi) + 2;
      for (let n = 0; n < len * (0.5 + r()); n++) {
        F.put(Math.round(x), y, n < 4 ? hex("#2c1c13") : hex("#1e140e"), 0, 0);
        if (h2(n, b, seed) < 0.6) y++;
        x += dir * 0.6 + (r() - 0.5) * 0.9;
        if (y >= yh - 2) break;
      }
    }
  }
}

// Grass, reeds and flowers along the edge, drawn over the feet of everything standing on it.
const BLADE = H(["#18280f", "#2c4418", "#436224", "#688232"]), REED = H(["#22261a", "#384024", "#566030"]);
const FLOWER = H(["#e8d86a", "#f0ecdc", "#b07ad0", "#e06a6a", "#f0a050"]);
function tuft(F, x, y, hgt, dark) {
  const n = hgt > 3 ? 3 : 2;
  for (let b = 0; b < n; b++) {
    const lean = (b - (n - 1) / 2) * 0.5, hh = Math.max(1, Math.round(hgt * (b === 1 ? 1 : 0.7)));
    for (let j = 0; j < hh; j++) F.put(Math.round(x + b - 1 + lean * j * 0.6), y - j, BLADE[clamp(Math.round((j / hh) * 3) - (dark ? 1 : 0), 0, 3)], -1, 0);
  }
}
function flower(F, x, y, hh, hue, big) {
  for (let j = 1; j < hh; j++) F.put(x, y - j, BLADE[1], -1, 0);
  const col = FLOWER[Math.floor(hue * FLOWER.length) % FLOWER.length];
  F.put(x, y - hh, col, -1, 0);
  if (big) { F.put(x - 1, y - hh, mul(col, 0.75), -1, 0); F.put(x + 1, y - hh, mul(col, 0.75), -1, 0); F.put(x, y - hh - 1, mul(col, 0.9), -1, 0); }
}
function drawEdge(F, V, l, prof, cov) {
  const yh = V.yh, s = V.k0 * l.sig;
  for (let x = 0; x < WIDTH; x++) {
    if (prof[x] <= 0) continue;
    const top = Math.round(yh - lift(V, l, prof[x])), c = cov[x], p = h2(x, 3, 91);
    if (c.sand > 0.6) { if (p < 0.08) tuft(F, x, top, 2, true); continue; }
    if (c.marsh > 0.35 && p < c.marsh * 0.4) {
      const hh = Math.round((1.1 + h2(x, 4, 92) * 1.2) * s);
      for (let j = 0; j < hh; j++) F.put(x, top - j, REED[j > hh * 0.6 ? 2 : 1], -1, 0);
      if (h2(x, 5, 93) < 0.3) { F.put(x, top - hh, hex("#4a2e1a"), -1, 0); F.put(x, top - hh - 1, hex("#4a2e1a"), -1, 0); }
      continue;
    }
    if (p < 0.22 + c.grass * 0.3) tuft(F, x, top, Math.max(1, Math.round((0.22 + h2(x, 6, 94) * 0.4) * s)), c.tree > 0.5);
    if (h2(x, 7, 95) < c.grass * 0.08) flower(F, x, top, Math.max(2, Math.round(0.3 * s)), h2(x, 8, 96), false);
  }
}

// ---------- the camp ----------
function campItems(W, V, S, l, colors) {
  const cs = V.campScale ?? 1, kS = V.k0 * l.sig * cs, out = [], cp = W.camp, [fs] = S.sd(cp.fire.x, cp.fire.z);
  // A camp drawn larger than life for legibility is spread out by the same factor around its fire.
  const X = (s) => WIDTH / 2 + (fs - V.sc) * V.k0 * l.sL + (s - fs) * V.k0 * l.sL * cs;
  const item = (p, draw) => { const [s, d] = S.sd(p.x, p.z); out.push({ type: "camp", s, d, x: X(s), draw }); };
  const lights = [];
  cp.tents.forEach((t, k) => {
    const kind = k % 3, w = Math.round(t.size * kS * (kind === 2 ? 1.25 : 1)), h = Math.round(t.size * kS * (kind === 1 ? 1.05 : kind === 0 ? 0.78 : 0.5));
    const [ts] = S.sd(t.at.x, t.at.z), toward = fs > ts ? 1 : -1;
    const pal = palette(l, kind === 1 ? "hide" : "canvas").slice();
    pal[10] = hex(colors[(k * 5 + 3) % colors.length]);
    item(t.at, (F, it, l, base) => blit(F, camp.tent(kind, w, h, toward, 11 + k), it.x, base, pal, it.d, 0));
  });
  // Torches flank the camp.
  for (const a of [1.35, 4.95]) {
    const p = { x: cp.at.x + Math.cos(cp.from + a) * 7, z: cp.at.z + Math.sin(cp.from + a) * 7 };
    item(p, (F, it, l, base) => {
      const hp = Math.max(5, Math.round(2.1 * kS));
      blit(F, camp.torch(hp, 5), it.x, base, palette(l, "flame"), it.d, 0);
      lights.push({ x: it.x, y: base - hp + 1, z: it.d, r: 3.2 * kS + 6, a: 0.5 });
    });
  }
  item(cp.woodpile, (F, it, l, base) => blit(F, camp.woodpile(Math.max(5, Math.round(2.1 * kS)), 3), it.x, base, palette(l, "logs"), it.d, 0));
  item(cp.fire, (F, it, l, base) => {
    const w = Math.max(4, Math.round(1.25 * kS)) | 1, fh = Math.max(3, Math.round(1.0 * kS));
    blit(F, camp.tripod(Math.max(5, Math.round(1.5 * kS)) | 1, Math.max(5, Math.round(1.6 * kS))), it.x, base - 1, palette(l, "iron"), it.d + 0.1, 0);
    blit(F, camp.fire(w, fh, 7), it.x, base, palette(l, "flame"), it.d, 0);
    const r = rng(31);
    for (let k = 0; k < Math.max(3, fh * 0.8); k++) {
      const t = r();
      F.put(Math.round(it.x + (r() - 0.5) * fh * (0.5 + t)), Math.round(base - fh * (1.1 + t * 2.4)), t < 0.4 ? hex("#fff0a0") : t < 0.75 ? hex("#ffb444") : hex("#e0602c"), it.d - 0.2, 0);
    }
    lights.push({ x: it.x, y: base - fh * 0.6, z: it.d, r: 7.5 * kS + 10, a: 1, fire: true, base });
  });
  const SKIN = [H(["#6a4028", "#9a6644"]), H(["#8a5a3c", "#c08a64"]), H(["#4e3020", "#7a5034"]), H(["#a06c4a", "#d4a07a"])];
  const HAIR = H(["#1a1210", "#3a2418", "#6a3a1e", "#8a8078", "#2a1a14"]);
  cp.people.forEach((p, k) => {
    const [ps] = S.sd(p.at.x, p.at.z), pose = [0, 1, 2, 1, 3][k], hp = Math.max(5, Math.round(1.75 * kS)), flip = ps > fs;
    const base = hex(colors[(k * 7 + 2) % colors.length]), pal = new Int32Array(12), sk = SKIN[k % SKIN.length];
    [mul(base, 0.42), mul(base, 0.68), base, mix(base, hex("#f0d8b0"), 0.25), mix(base, hex("#ffe0b0"), 0.5)].forEach((c, i) => (pal[1 + i] = c));
    pal[6] = sk[0]; pal[7] = sk[1]; pal[8] = HAIR[k % HAIR.length]; pal[9] = hex("#221a24"); pal[10] = hex("#0c0808"); pal[11] = hex("#5a3c24");
    item(p.at, (F, it, l, bs) => {
      // Sitters get a log under them.
      if (pose === 1) { const big = hp >= 12, sw = big ? 7 : 3, sh = big ? 3 : 1; blit(F, camp.seat(sw, sh), it.x + (flip ? 2 : -2) * (big ? 1 : 0.5), bs, palette(l, "flame"), it.d + 0.05, 0); }
      blit(F, camp.person(hp, pose, k + 1), it.x, bs, pal, it.d, 0, flip);
    });
  });
  return { items: out, lights };
}

// Smoke climbs from the fire in soft puffs and leans with the wind.
function drawSmoke(F, V, fire, lean, scale) {
  const len = Math.round(scale * 14), a = new Float32Array(F.w * F.h), warm = new Float32Array(F.w * F.h);
  for (let k = 0; k < len; k++) {
    const t = k / len, y = Math.round(fire.base - scale * 1.4 - k);
    if (y < 0) break;
    const cx = fire.x + lean * scale * t * t * 8 + Math.sin(k / (scale * 1.3) + 1) * scale * 0.3 * (0.3 + t);
    const hw = Math.max(0.6, scale * (0.14 + t * 0.85) * (0.8 + 0.4 * noise(k / 5, 0, 5)));
    for (let x = Math.floor(cx - hw); x <= cx + hw; x++) {
      if (x < 0 || x >= F.w || (t > 0.25 && noise(x / 3.5, y / 3, 6) < -0.35)) continue;
      const e = Math.abs(x + 0.5 - cx) / hw, i = y * F.w + x;
      a[i] = Math.max(a[i], 0.5 * Math.pow(1 - t, 1.2) * (e > 0.7 ? 0.55 : 1));
      warm[i] = Math.max(0, 1 - t * 3);
    }
  }
  for (let i = 0; i < a.length; i++) {
    if (!a[i]) continue;
    const q = Math.round(a[i] * 8) / 8;
    if (q > 0) F.c[i] = mix(F.c[i], mix(hex("#665c74"), hex("#a0705c"), warm[i]), q);
  }
}

// ---------- light ----------
function lighting(F, V, lights) {
  const { w } = F, yh = V.yh;
  const LF = [1, 0.7, 0.45, 0.3, 0.2, 0.14, 0.1, 0.08, 0.06];
  const out = Int32Array.from(F.c);
  for (let y = 0; y < yh; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x, lay = F.lay[i], z = F.z[i];
    let c = F.c[i];
    // Sunward rims on silhouettes standing well in front of what is behind them.
    if ((lay < 4 || (V.island && lay < 250)) && x + 1 < w) {
      const far = (j) => (V.island ? F.lay[j] === 255 : F.z[j] > z + 3 + z * 0.2);
      if (far(i + 1)) c = mix(c, SUN_RIM, V.island ? 0.34 : [0.38, 0.26, 0.16, 0.08][lay]);
      else if (y > 0 && far(i - w)) c = mix(c, SKY_RIM, V.island ? 0.12 : [0.16, 0.1, 0.06, 0.04][lay]);
    }
    for (const L of lights) {
      const dx = x - L.x, dy = (y - L.y) * 1.3, d = Math.hypot(dx, dy);
      if (d > L.r) continue;
      // Light falls off with depth too, so what stands behind the fire gets less of it.
      const lf = lay === 255 ? 0.22 : LF[Math.min(lay, LF.length - 1)] * (lay === 0 && z > -1 ? Math.exp(-Math.abs(z - L.z) / 9) * (z === 0 ? 0.6 : 1) : 1);
      const I = Math.floor(Math.pow(1 - d / L.r, 1.6) * L.a * 5) / 5;
      if (I <= 0) continue;
      // Firelight warms what it touches without washing out its darks; only the air glows additively.
      const e = I * lf;
      c = lay === 255 ? add(c, FIRE, e * 0.42) : rgb(cr(c) * (1 + 1.5 * e) + 34 * e, cg(c) * (1 + 0.75 * e) + 12 * e, cb(c) * (1 + 0.1 * e) + 2 * e);
      if (lay <= 1 && L.fire && I >= 0.2) {
        const nx = x + Math.sign(L.x - x);
        if (nx >= 0 && nx < w && F.z[y * w + nx] > z + 1.5) c = mix(c, FIRE_RIM, Math.min(0.7, I * 1.1 * lf));
      }
    }
    out[i] = c;
  }
  F.c.set(out);
}

// ---------- water ----------
function drawWater(F, V, front, fireXs) {
  const { w, h } = F, yh = V.yh, band = h - yh, [sx] = V.sun, src = Int32Array.from(F.c);
  const ground = H(["#07090a", "#0b100d", "#131a13", "#1c2717"]);
  // The mirror is sliced into rows that slide sideways on a slow swell, wider toward the eye; thin troughs darken
  // and crests catch the sky.
  const crest = mix(WATER_HI, SUN[3], 0.25);
  for (let y = yh; y < h; y++) {
    const k = y - yh, t = k / band, A = 0.15 + k * 0.038, row = A * (0.8 * Math.sin(k * 0.23 + 1.3) + 1.2 * noise(k / 5.5, 0.5, 44)) + (h2(k, 3, 45) < 0.12 ? (h2(k, 4, 46) < 0.5 ? -1 : 1) * (1 + t * 2) : 0);
    const ys = clamp(yh - 1 - k - Math.round(Math.sin(k * 1.3) * 0.7 * t), 0, yh - 1);
    for (let x = 0; x < w; x++) {
      if (!front[x]) {
        const g = k === 0 ? 3 : k < 3 ? 2 : k < 8 ? 1 : 0;
        F.put(x, y, ground[g], -2, 0);
        continue;
      }
      const dx = Math.round(row + Math.sin(x / (70 + k) + k * 0.7) * A * 0.8);
      let c = src[ys * w + clamp(x + dx, 0, w - 1)];
      c = mix(mul(c, 0.84), WATER, 0.18 + t * 0.3);
      const wave = Math.sin(k * 0.95 + noise(x / 60, k / 5, 32) * 2.5);
      if (k > 2 && wave > 0.94) c = mix(c, WATER, 0.5);
      else if (k > 1 && wave < -0.96 && noise(x / 14, k, 33) > 0) c = mix(c, crest, 0.22);
      F.put(x, y, c, 1e9, 254);
    }
  }
  // Glints: a glitter road under the sun, warm flecks under the fires, and a sprinkle across the water.
  const r = rng(4242);
  const dash = (x, y, len, col, a) => { for (let i = 0; i < len; i++) { const xx = x + i; if (xx >= 0 && xx < w && front[xx]) F.c[y * w + xx] = mix(F.c[y * w + xx], col, a); } };
  for (let y = yh + 1; y < h; y++) {
    const k = y - yh, spread = (4 + k * 0.9) * V.spread;
    for (let n = 0; n < 3 + k * 0.08; n++) {
      const x = Math.round(sx + (r() - 0.5) * 2 * spread * (0.3 + r() * 0.7));
      if (r() < 0.75) dash(x, y, 1 + Math.floor(r() * (2 + k * 0.1)), r() < 0.5 ? SUN[0] : SUN[2], 0.85);
    }
    for (const fx of fireXs) if (r() < 0.5) dash(Math.round(fx + (r() - 0.5) * (3 + k * 0.35)), y, 1 + Math.floor(r() * 3), r() < 0.5 ? hex("#ffd070") : FIRE, 0.7);
    for (let n = 0; n < 2; n++) if (r() < 0.55) dash(Math.floor(r() * w), y, 1 + Math.floor(r() * 3), hex("#8c86c0"), 0.32);
  }
  // A dark lip where banks meet the water.
  for (let x = 0; x < w; x++) if (front[x] && F.lay[(yh - 1) * w + x] < 250) F.c[yh * w + x] = mix(F.c[yh * w + x], hex("#05060c"), 0.6);
}

// ---------- the whole picture ----------
export function render(W, viewName, colors, seed = 1) {
  const S = chooseSlice(W), V = makeView(viewName, S), F = new Frame(WIDTH, HEIGHT);
  V.L.forEach((l) => { l.fog = fogOf(V, l.D); l.flat = V.flat ?? 0.7; l.dusk = V.island ? 0 : 0.16; });
  if (V.island) fitIsland(W, V, S);
  sortIntoLayers(W, V, S);
  const L0 = V.L[0];
  let lights = [];
  for (let n = V.L.length - 1; n >= 0; n--) {
    const l = V.L[n], prof = profileOf(W, V, S, l);
    if (n > 0 || V.island) { const tops = drawBand(F, V, l, prof); drawItems(F, V, l, W, null, l.fog.f > l.flat - 0.15 ? tops : null); continue; }
    const y0 = (x) => Math.round(V.yh - lift(V, l, prof[clamp(Math.round(x), 0, WIDTH - 1)])) + 1;
    const roots = l.items.filter((it) => it.type === "tree" && Math.abs(it.d) < 5).map((it) => [Math.round(it.x), Math.round(it.o.tall * V.k0 * l.sig * 0.16), Math.floor(it.o.tint * 1e6)]);
    const cov = slicecover(W, V, S, l, prof);
    drawBank(F, V, l, prof, cov, roots);
    const cp = campItems(W, V, S, l, colors);
    l.items.push(...cp.items);
    // Up close the camp ground is the world's own scatter of grass, flowers and pebbles.
    let close = null;
    if (V.name === "camp") {
      const nb = W.nearby(W.camp.at, 30, 2), kS = V.k0 * l.sig;
      close = { back: [], front: [] };
      const put = (p, fn) => {
        const [s, d] = S.sd(p.x, p.z);
        if (d < -6 || d > 9) return;
        const x = Math.round(WIDTH / 2 + (s - V.sc) * V.k0);
        (d > 1.5 ? close.back : close.front).push(() => fn(x, y0(x), d));
      };
      nb.grass.forEach((g, k) => k % 2 === 0 && put(g, (x, y, d) => tuft(F, x, y, Math.max(1, Math.round(g.tall * kS * 0.45)), d > 1.5)));
      nb.flowers.forEach((f) => put(f, (x, y) => flower(F, x, y, Math.max(2, Math.round(f.tall * kS * 0.7)), f.hue, true)));
      nb.pebbles.forEach((p) => put(p, (x, y) => { const wp = Math.round(p.size * kS * 1.1); if (wp >= 2) blit(F, rock(wp, Math.floor(p.tint * 5), 0), x, y, palette(L0, "rock"), -1, 0); }));
      close.back.forEach((f) => f());
    } else drawEdge(F, V, l, prof, cov);
    drawItems(F, V, l, W, y0);
    if (close) close.front.forEach((f) => f());
    lights = cp.lights;
  }
  placeSun(F, V);
  drawSky(F, V, seed);
  const fire = lights.find((q) => q.fire);
  if (fire) drawSmoke(F, V, fire, Math.sign(W.isle.wind[0] * S.R[0] + W.isle.wind[1] * S.R[1]) || -1, V.k0 * L0.sig * 0.9);
  if (V.island) {
    // From out at sea the camp is a spark of firelight on the shore.
    const l = V.L.find((q) => 0 >= q.d0 && 0 < q.d1) || V.L[0], [s] = S.sd(W.camp.fire.x, W.camp.fire.z), x = WIDTH / 2 + (s - V.sc) * V.k0 * l.sL;
    const y = V.yh - lift(V, l, W.camp.fire.y) - 1;
    lights = [{ x, y, r: 9, a: 0.9 }];
    F.put(Math.round(x), Math.round(y), hex("#ffd070"), -1, 0);
    F.put(Math.round(x), Math.round(y) - 1, hex("#ff9a3a"), -1, 0);
  }
  lighting(F, V, lights);
  // What lies in front of the slice: water wherever the world has it, else dark near ground.
  const front = new Uint8Array(WIDTH);
  for (let x = 0; x < WIDTH; x++) {
    if (V.island) { front[x] = 1; continue; }
    const s = V.sc + (x + 0.5 - WIDTH / 2) / V.k0;
    for (let q = 0; q < 600; q += 5) { const [px, pz] = S.P(s, -q); if (S.wetAt(px, pz)) { front[x] = 1; break; } }
  }
  drawWater(F, V, front, lights.map((q) => q.x));
  vignette(F);
  return F;
}

// For the far shot: pick the scale and center so the whole island spans the frame.
function fitIsland(W, V, S) {
  const pts = [];
  for (let v = 0; v < W.M; v += 3) for (let u = 0; u < W.M; u += 3) if (W.h[v * W.M + u] > 0.5) pts.push(S.sd(W.START + u * W.STEP, W.START + v * W.STEP));
  V.sc = 0;
  for (let it = 0; it < 4; it++) {
    let lo = 1e9, hi = -1e9;
    for (const [s, d] of pts) { const f = V.D0 / (V.D0 + d), x = (s - V.sc) * f; lo = Math.min(lo, x); hi = Math.max(hi, x); }
    V.k0 = (WIDTH * 0.9) / (hi - lo);
    V.sc += (lo + hi) / 2;
  }
  V.sc -= (WIDTH * 0.03) / V.k0;
}

// A soft darkening toward the corners, in small steps.
function vignette(F) {
  for (let y = 0; y < F.h; y++) for (let x = 0; x < F.w; x++) {
    const dx = (x - F.w / 2) / (F.w / 2), dy = (y - F.h * 0.45) / (F.h / 2), v = dx * dx * 0.55 + dy * dy * 0.6;
    const f = 1 - Math.round(0.26 * clamp((v - 0.35) / 1.1, 0, 1) * 10) / 10;
    if (f < 1 && F.lay[y * F.w + x] !== 255) F.c[y * F.w + x] = mul(F.c[y * F.w + x], f);
  }
}

export function toRGBA(F) {
  const out = new Uint8ClampedArray(F.w * F.h * 4);
  for (let i = 0; i < F.w * F.h; i++) { const c = F.c[i]; out[i * 4] = cr(c); out[i * 4 + 1] = cg(c); out[i * 4 + 2] = cb(c); out[i * 4 + 3] = 255; }
  return out;
}
