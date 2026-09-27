// Procedural pixel art. Every sprite is painted texel by texel into a small canvas: limited hue-shifted ramps, light from
// the upper left, a selective dark outline. Sizes are in texels so each view can paint at its own pixel density.
import { hash } from "../world.js";

export const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
export const smooth = (a, b, v) => { const t = clamp((v - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
export function mulberry(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((v) => (v + 0.5) / 16);
export const bayer = (x, y) => BAYER[(y & 3) * 4 + (x & 3)];

export const rgb = (h) => { const n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
export const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
export const scale = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
function toHsl([r, g, b]) {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2, d = mx - mn;
  if (d === 0) return [0, 0, l];
  const s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
  const h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h / 6, s, l];
}
function fromHsl(h, s, l) {
  h = ((h % 1) + 1) % 1;
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
  const f = (t) => { t = ((t % 1) + 1) % 1; return t < 1 / 6 ? p + (q - p) * 6 * t : t < 0.5 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p; };
  return [f(h + 1 / 3) * 255, f(h) * 255, f(h - 1 / 3) * 255];
}
const toward = (h, target, amt) => { let d = target - h; d -= Math.round(d); return h + d * amt; };
// n tones from shadow to light: shadows drift toward blue-violet, lights toward warm yellow, as pixel artists do.
export function ramp(base, n = 5, reach = 0.3, hueShift = 1) {
  const [h, s, l] = toHsl(typeof base === "string" ? rgb(base) : base);
  return Array.from({ length: n }, (_, i) => {
    const t = n === 1 ? 0 : (i / (n - 1)) * 2 - 1;
    const hh = t < 0 ? toward(h, 0.7, -t * 0.09 * hueShift) : toward(h, 0.13, t * 0.07 * hueShift);
    const ss = clamp(s * (1 + (t < 0 ? -t * 0.1 : -t * 0.18)), 0, 1);
    return fromHsl(hh, ss, clamp(l + t * reach, 0.03, 0.96)).map(Math.round);
  });
}
export const tone = (t, n, x, y, dither = 0.5) => clamp(Math.floor(t * n + (bayer(x, y) - 0.5) * dither), 0, n - 1);

export class Px {
  constructor(w, h) { this.w = w; this.h = h; this.d = new Uint8ClampedArray(w * h * 4); }
  in(x, y) { return x >= 0 && y >= 0 && x < this.w && y < this.h; }
  set(x, y, c, a = 255) {
    x = Math.floor(x); y = Math.floor(y);
    if (!this.in(x, y)) return;
    const i = (y * this.w + x) * 4;
    this.d[i] = c[0]; this.d[i + 1] = c[1]; this.d[i + 2] = c[2]; this.d[i + 3] = a;
  }
  a(x, y) { return this.in(x, y) ? this.d[(y * this.w + x) * 4 + 3] : 0; }
  get(x, y) { const i = (y * this.w + x) * 4; return [this.d[i], this.d[i + 1], this.d[i + 2]]; }
  line(x0, y0, x1, y1, c) {
    x0 = Math.round(x0); y0 = Math.round(y0); x1 = Math.round(x1); y1 = Math.round(y1);
    const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0), sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
    let e = dx + dy;
    for (;;) {
      this.set(x0, y0, typeof c === "function" ? c(x0, y0) : c);
      if (x0 === x1 && y0 === y1) break;
      const e2 = 2 * e;
      if (e2 >= dy) { e += dy; x0 += sx; }
      if (e2 <= dx) { e += dx; y0 += sy; }
    }
  }
  canvas() {
    const c = document.createElement("canvas");
    c.width = this.w; c.height = this.h;
    const g = c.getContext("2d"), img = g.createImageData(this.w, this.h);
    img.data.set(this.d);
    g.putImageData(img, 0, 0);
    return c;
  }
}
const INK = [28, 20, 34];
// Selective outline: each empty texel touching the sprite takes a deep, slightly violet version of its darkest neighbour.
export function outline(px, k = 0.34, sides = 4) {
  const out = new Uint8ClampedArray(px.d);
  const nb = sides === 8 ? [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1]] : [[1, 0], [-1, 0], [0, 1], [0, -1]];
  for (let y = 0; y < px.h; y++)
    for (let x = 0; x < px.w; x++) {
      if (px.a(x, y)) continue;
      let best = null, lum = 1e9;
      for (const [dx, dy] of nb) if (px.a(x + dx, y + dy)) { const c = px.get(x + dx, y + dy), l = c[0] + c[1] * 1.5 + c[2]; if (l < lum) { lum = l; best = c; } }
      if (!best) continue;
      const c = mix(scale(best, k), INK, 0.45), i = (y * px.w + x) * 4;
      out[i] = c[0]; out[i + 1] = c[1]; out[i + 2] = c[2]; out[i + 3] = 255;
    }
  px.d = out;
  return px;
}

const LIGHT = (() => { const v = [-0.55, -0.62, 0.56], l = Math.hypot(...v); return v.map((x) => x / l); })();
const sphere = (dx, dy) => { const q = dx * dx + dy * dy; return q >= 1 ? [dx / Math.sqrt(q), dy / Math.sqrt(q), 0] : [dx, dy, Math.sqrt(1 - q)]; };
const lit = (n) => n[0] * LIGHT[0] + n[1] * LIGHT[1] + n[2] * LIGHT[2];

// A leafy mass: overlapping leaf clusters, upper ones in front, each shaded as a small sphere inside the crown's big one,
// with the dark line a front cluster casts on the one behind it. Returns the coverage mask.
function crown(px, { cx, cy, rx, ry, leaves, pal, dark = 0.2, seed, sheen = 0 }) {
  const n = pal.length, w = px.w, h = px.h, own = new Int32Array(w * h).fill(-1);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let best = -1, bd = -1e9;
      for (let k = 0; k < leaves.length; k++) {
        const L = leaves[k], dx = x + 0.5 - L.x, dy = y + 0.5 - L.y;
        if (dx * dx + dy * dy < L.r * L.r && L.d > bd) { bd = L.d; best = k; }
      }
      own[y * w + x] = best;
    }
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const k = own[y * w + x];
      if (k < 0) continue;
      const L = leaves[k];
      const big = sphere((x + 0.5 - cx) / rx, (y + 0.5 - cy) / ry), small = sphere((x + 0.5 - L.x) / L.r, (y + 0.5 - L.y) / L.r);
      let t = 0.4 + 0.58 * (0.55 * lit(big) + 0.45 * lit(small));
      t -= dark * smooth(-0.2, 1, (y + 0.5 - cy) / ry);
      const up = y > 0 ? own[(y - 1) * w + x] : -1, up2 = y > 1 ? own[(y - 2) * w + x] : -1;
      if (up >= 0 && up !== k && leaves[up].d > L.d) t -= 0.32;
      else if (up2 >= 0 && up2 !== k && leaves[up2].d > L.d && rx > 10) t -= 0.14;
      t += (hash(x, y, seed) - 0.5) * 0.12 + sheen * (small[2] > 0.9 && hash(x, y, seed + 3) < 0.25 ? 0.2 : 0);
      px.set(x, y, pal[tone(t, n, x, y, 0.55)]);
    }
  return own;
}
function scatterLeaves(rnd, inside, x0, y0, x1, y1, r, { holes = 0, jitter = 0.6 } = {}) {
  const leaves = [], step = r * 1.22;
  for (let y = y0; y <= y1; y += step)
    for (let x = x0; x <= x1; x += step) {
      const lx = x + (rnd() - 0.5) * step * jitter, ly = y + (rnd() - 0.5) * step * jitter;
      if (!inside(lx, ly)) continue;
      if (holes && rnd() < holes) continue;
      leaves.push({ x: lx, y: ly, r: r * (0.8 + rnd() * 0.45), d: -ly + rnd() * r * 1.6 });
    }
  return leaves;
}
function trunk(px, rnd, cx, y0, y1, w, pal, marks) {
  for (let y = Math.floor(y0); y <= y1; y++) {
    const flare = y >= y1 - 1 ? 1 : 0, ww = w + flare * 2, left = Math.round(cx - ww / 2);
    for (let i = 0; i < ww; i++) {
      const f = ww === 1 ? 0.5 : i / (ww - 1);
      let t = f < 0.3 ? 2 : f < 0.72 ? 1 : 0;
      if (hash(left + i, y, 17) < 0.14) t = Math.max(0, t - 1);
      let c = pal[t];
      if (marks && hash(Math.floor((left + i) / 2), y, 23) < 0.18) c = marks;
      px.set(left + i, y, c);
    }
  }
}

const LEAF = {
  oak: ["#3f6e2a", "#4a762c", "#386432", "#527228"],
  ash: ["#588a38", "#629040", "#4e8040", "#6a8c36"],
  aspen: ["#8aa83c", "#9eac3a", "#7ea244", "#c0a038"],
};
const BARK = { oak: "#5a3e2a", ash: "#6a5a4c", aspen: "#cfc6b4", pine: "#5b3a26" };

export function deciduous(kind, H, seed, tint = 0.5) {
  const rnd = mulberry(seed), shape = { oak: [1.0, 0.21], ash: [0.8, 0.3], aspen: [0.5, 0.36] }[kind];
  const W = Math.max(5, Math.round(H * shape[0])), px = new Px(W + 2, H + 2);
  const cx = (W + 2) / 2, top = 1.2, bottom = 1 + H * (1 - shape[1]), cy = (top + bottom) / 2, rx = W / 2 - 0.4, ry = (bottom - top) / 2;
  const pal = ramp(LEAF[kind][Math.floor(tint * 3.99)], H > 24 ? 6 : 5, 0.3);
  const bark = ramp(BARK[kind], 3, 0.16);
  const tw = Math.max(2, Math.round(W * (kind === "aspen" ? 0.13 : kind === "oak" ? 0.14 : 0.11)));
  trunk(px, rnd, cx, cy, H, tw, bark, kind === "aspen" ? [58, 50, 46] : null);
  // Branches show through the crown's gaps.
  for (let b = 0; b < 3; b++) {
    const s = b % 2 ? 1 : -1, y0 = cy + ry * (0.1 + rnd() * 0.4);
    px.line(cx + s * 0.5, y0, cx + s * rx * (0.35 + rnd() * 0.3), y0 - ry * (0.35 + rnd() * 0.35), bark[0]);
  }
  const blobs = [];
  const nb = kind === "aspen" ? 4 : 6;
  for (let k = 0; k < nb; k++) {
    const a = rnd() * Math.PI * 2, rr = Math.sqrt(rnd()) * 0.5;
    blobs.push({ x: cx + Math.cos(a) * rr * rx * 0.75, y: kind === "aspen" ? top + ry * (0.35 + (k / (nb - 1)) * 1.3) : cy + Math.sin(a) * rr * ry * 0.7, r: (0.42 + rnd() * 0.16) * (kind === "aspen" ? rx * 1.35 : Math.min(rx, ry * 1.15)) });
  }
  const inside = (x, y) => { const e = ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2; return (e < 0.86 && blobs.some((b) => (x - b.x) ** 2 + (y - b.y) ** 2 < b.r * b.r * 1.4)) || e < 0.42; };
  const lr = Math.max(1.3, H / { oak: 10.5, ash: 11.5, aspen: 12.5 }[kind]);
  const leaves = scatterLeaves(rnd, inside, cx - rx, top + lr * 0.6, cx + rx, bottom, lr, { holes: kind === "ash" ? 0.12 : kind === "oak" ? 0.04 : 0.03 });
  crown(px, { cx: cx - rx * 0.1, cy: cy - ry * 0.1, rx, ry, leaves, pal, dark: kind === "oak" ? 0.24 : 0.18, seed, sheen: kind === "aspen" ? 1 : 0.5 });
  return outline(px);
}

export function pine(H, seed, tint = 0.5) {
  const rnd = mulberry(seed), W = Math.max(5, Math.round(H * 0.5)), px = new Px(W + 2, H + 2), cx = (W + 2) / 2;
  const pal = ramp(["#2e5a40", "#335c3a", "#2a5446", "#3a6038"][Math.floor(tint * 3.99)], H > 28 ? 6 : 5, 0.28);
  trunk(px, rnd, cx, H - H * 0.2, H, Math.max(2, Math.round(W * 0.14)), ramp(BARK.pine, 3, 0.15));
  const n = clamp(Math.round(H / 8.5), 3, 9), yb0 = H - Math.max(2, Math.round(H * 0.1)), tiers = [];
  for (let k = 0; k < n; k++) {
    const s = (k + 1) / n, yb = 1.5 + (yb0 - 1.5) * Math.pow(s, 0.92), yt = k === 0 ? 1 : tiers[k - 1].yb - (yb - tiers[k - 1].yb) * 0.9;
    tiers.push({ yt, yb, hw: (W / 2 - 0.3) * (0.26 + 0.74 * s) * (0.9 + rnd() * 0.12) });
  }
  const w = px.w, own = new Int8Array(w * px.h).fill(-1);
  for (let y = 0; y < px.h; y++)
    for (let x = 0; x < w; x++)
      for (let k = 0; k < n; k++) {
        const T = tiers[k], dy = (y + 0.5 - T.yt) / (T.yb - T.yt), dx = x + 0.5 - cx;
        if (dy < 0 || dy > 1) continue;
        const edge = T.hw * (0.12 + 0.88 * Math.pow(dy, 0.85)), side = Math.abs(dx) / T.hw;
        const jag = (Math.floor(x + k * 2) % 3 === 0 ? 1 : 0) + (side > 0.72 ? 1 : 0) - (side > 0.9 && hash(x, k, seed) < 0.5 ? -1 : 0);
        if (Math.abs(dx) <= edge && y + 0.5 <= T.yb - jag * 0.8) { own[y * w + x] = k; break; }
      }
  for (let y = 0; y < px.h; y++)
    for (let x = 0; x < w; x++) {
      const k = own[y * w + x];
      if (k < 0) continue;
      const T = tiers[k], dx = (x + 0.5 - cx) / T.hw, dy = (y + 0.5 - T.yt) / (T.yb - T.yt);
      let t = 0.55 - dx * 0.34 + (0.4 - dy) * 0.3 - (k / n) * 0.1;
      const above = y > 0 ? own[(y - 1) * w + x] : -1, above2 = y > 1 ? own[(y - 2) * w + x] : -1;
      if (above >= 0 && above < k) t -= 0.4;
      else if (above2 >= 0 && above2 < k) t -= 0.18;
      if ((x + Math.floor(y * 0.5) * Math.sign(dx || 1)) % 3 === 0) t -= 0.07;
      t += (hash(x, y, seed) - 0.5) * 0.14;
      px.set(x, y, pal[tone(t, pal.length, x, y, 0.5)]);
    }
  return outline(px);
}

export function bush(H, seed, heath = 0, tint = 0.5) {
  const rnd = mulberry(seed), W = Math.max(5, Math.round(H * (1.35 + rnd() * 0.3))), px = new Px(W + 2, H + 2);
  const base = heath > 0.5 ? ["#6a7438", "#5e6c3c"][seed & 1] : ["#4c7a34", "#56843a", "#467236", "#5a7a30"][Math.floor(tint * 3.99)];
  const pal = ramp(base, 5, 0.28), cx = (W + 2) / 2, cy = 1 + H * 0.56, rx = W / 2 - 0.3, ry = H / 2;
  const inside = (x, y) => ((x - cx) / rx) ** 2 + ((y - cy) / (ry * 0.95)) ** 2 < 0.72 && y < H;
  const lr = Math.max(1.2, H / 3.6);
  const leaves = scatterLeaves(rnd, inside, cx - rx, 1 + lr * 0.5, cx + rx, H, lr);
  const own = crown(px, { cx: cx - rx * 0.15, cy: cy - ry * 0.2, rx, ry, leaves, pal, dark: 0.26, seed });
  // Heather flowers on the heath, berries or blossom on the rest, on the lit upper side.
  const bloom = heath > 0.5 ? [rgb("#b0579c"), rgb("#d58ac2")] : seed % 3 === 0 ? [rgb("#c8392e"), rgb("#e8604a")] : seed % 3 === 1 ? [rgb("#f2eee0"), rgb("#fffaf0")] : null;
  if (bloom)
    for (let y = 0; y < px.h; y++)
      for (let x = 0; x < px.w; x++)
        if (own[y * px.w + x] >= 0 && hash(x, y, seed + 9) < (heath > 0.5 ? 0.16 : 0.06) && y < cy + ry * 0.3) px.set(x, y, bloom[hash(x, y, seed + 2) < 0.6 ? 0 : 1]);
  return outline(px);
}

export function grass(H, seed, dryness = 0) {
  const rnd = mulberry(seed), W = H + 3, px = new Px(W, H + 1), cx = W / 2;
  const pal = ramp(mix(rgb("#5e9238"), rgb("#a09848"), dryness), 5, 0.26);
  const blades = 3 + Math.round(H / 2.2);
  for (let b = 0; b < blades; b++) {
    const bx = cx + (rnd() - 0.5) * W * 0.45, lean = (rnd() - 0.5) * W * 0.8, len = H * (0.5 + rnd() * 0.5), light = bx + lean * 0.5 < cx ? 1 : 0;
    let lx = null, ly = null;
    for (let s = 0; s <= len; s += 0.5) {
      const f = s / len, x = Math.round(bx + lean * f * f), y = Math.round(H - s);
      if (x === lx && y === ly) continue;
      lx = x; ly = y;
      px.set(x, y, pal[clamp(Math.floor(f * 2.6 + light + (b % 3 === 0 ? -1 : 0)), 0, 4)]);
    }
  }
  if (H >= 8 && rnd() < 0.5) {
    const x = Math.round(cx + (rnd() - 0.5) * W * 0.3), top = 1 + Math.floor(rnd() * 2);
    for (let y = top; y <= H; y++) px.set(x, y, pal[y < top + 2 ? 4 : 2]);
    px.set(x + 1, top + 1, rgb("#e8dca0"));
  }
  return px;
}

export const FLOWER = ["#f5f1e4", "#f3d14a", "#ea88b8", "#9d6ad2", "#6c8ee8", "#dc4a3a", "#f19b3a"];
export function flower(H, seed, hue) {
  const W = Math.max(4, Math.round(H * 0.9)) + 2, px = new Px(W, H + 1), cx = Math.floor(W / 2);
  const stem = ramp("#5a8a34", 3, 0.2), petal = ramp(FLOWER[Math.floor(hue * FLOWER.length) % FLOWER.length], 3, 0.18);
  const top = H >= 6 ? 2 : 1;
  for (let y = top; y <= H; y++) px.set(cx, y, stem[1]);
  if (H >= 5) { px.set(cx - 1, H - 1, stem[2]); px.set(cx + 1, H - 2, stem[0]); }
  if (H >= 6) {
    px.set(cx, top - 1, petal[2]); px.set(cx - 1, top, petal[2]); px.set(cx + 1, top, petal[1]); px.set(cx, top + 1, petal[0]);
    px.set(cx, top, hue > 0.15 && hue < 0.3 ? [140, 80, 30] : rgb("#f6c93a"));
  } else { px.set(cx, top, petal[2]); px.set(cx + 1, top, petal[1]); }
  return H >= 6 ? outline(px, 0.45) : px;
}

export function fern(H, seed) {
  const rnd = mulberry(seed), W = Math.round(H * 2) + 2, px = new Px(W, H + 1), cx = W / 2;
  const pal = ramp(["#3f7a38", "#4b8436", "#57803a"][seed % 3], 4, 0.24);
  const fronds = 5 + Math.floor(rnd() * 3);
  for (let f = 0; f < fronds; f++) {
    const a = -Math.PI / 2 + (f / (fronds - 1) - 0.5) * 2.6 + (rnd() - 0.5) * 0.3, len = H * (0.8 + rnd() * 0.5), light = Math.cos(a) < 0 ? 1 : 0;
    for (let s = 0; s < len; s += 0.6) {
      const g = s / len, x = cx + Math.cos(a) * s, y = H + Math.sin(a) * s + g * g * len * 0.55;
      px.set(x, y, pal[clamp(1 + light + (g > 0.7 ? 1 : 0), 0, 3)]);
      if (Math.floor(s) % 2 === 0 && g < 0.85 && H > 5) { px.set(x, y + 1, pal[0]); px.set(x + Math.sign(Math.cos(a)), y - 1, pal[2 + light]); }
    }
  }
  return outline(px, 0.4);
}

export function reeds(H, seed) {
  const rnd = mulberry(seed), W = Math.max(5, Math.round(H * 0.8)), px = new Px(W, H + 1);
  const pal = ramp("#8a9444", 4, 0.22), head = ramp("#6a4428", 2, 0.12);
  for (let k = 0; k < 4 + Math.floor(rnd() * 4); k++) {
    const x0 = 1 + rnd() * (W - 2), lean = (rnd() - 0.5) * 3, len = H * (0.55 + rnd() * 0.45);
    for (let s = 0; s <= len; s++) px.set(x0 + lean * (s / len) ** 2, H - s, pal[clamp(Math.floor((s / len) * 3) + (x0 < W / 2 ? 1 : 0), 0, 3)]);
    if (rnd() < 0.45 && H >= 8) for (let s = 0; s < 3; s++) { px.set(x0 + lean, H - len + s, head[1]); px.set(x0 + lean + 1, H - len + s, head[0]); }
  }
  return px;
}

export function rock(H, seed, moss = 0) {
  const rnd = mulberry(seed), W = Math.max(4, Math.round(H * (1.25 + rnd() * 0.45))), px = new Px(W + 2, H + 2);
  const pal = ramp(["#7a766e", "#847c70", "#6e7074", "#88827a"][seed % 4], 5, 0.26), mosspal = ramp("#6c8a3a", 3, 0.16);
  const cx = (W + 2) / 2, cy = H * 0.6 + 1, rx = W / 2, ry = H * 0.62, facets = [];
  const phase = rnd() * 6;
  for (let k = 0; k < 3 + Math.floor(H / 4); k++) {
    const n = [(rnd() - 0.6) * 1.1, -0.2 - rnd() * 0.8, 0.5 + rnd() * 0.5], l = Math.hypot(...n);
    facets.push({ x: cx + (rnd() - 0.5) * W * 0.8, y: cy + (rnd() - 0.6) * H * 0.8, n: n.map((v) => v / l) });
  }
  const w = px.w, own = new Int8Array(w * px.h).fill(-1);
  for (let y = 0; y < px.h; y++)
    for (let x = 0; x < w; x++) {
      const dx = (x + 0.5 - cx) / rx, dy = (y + 0.5 - cy) / ry, a = Math.atan2(dy, dx), r = 1 + 0.14 * Math.sin(a * 3 + phase) + 0.08 * Math.sin(a * 5 - phase);
      if (dx * dx + dy * dy > r * r || y > H) continue;
      let best = 0, bd = 1e9;
      facets.forEach((f, k) => { const d = (x - f.x) ** 2 + (y - f.y) ** 2; if (d < bd) { bd = d; best = k; } });
      own[y * w + x] = best;
    }
  for (let y = 0; y < px.h; y++)
    for (let x = 0; x < w; x++) {
      const k = own[y * w + x];
      if (k < 0) continue;
      const f = facets[k], s = sphere((x + 0.5 - cx) / rx, (y + 0.5 - cy) / ry);
      let t = 0.32 + 0.5 * (0.6 * lit(f.n) + 0.5 * lit(s)) - smooth(0.2, 1, (y - cy) / ry) * 0.25;
      const r = x + 1 < w ? own[y * w + x + 1] : -1, d = y + 1 < px.h ? own[(y + 1) * w + x] : -1;
      if ((r >= 0 && r !== k) || (d >= 0 && d !== k)) t -= 0.14;
      t += (hash(x, y, seed) - 0.5) * 0.1;
      if (moss > 0.3 && f.n[1] < -0.55 && hash(x, y, seed + 1) < moss) { px.set(x, y, mosspal[tone(t, 3, x, y)]); continue; }
      px.set(x, y, pal[tone(t, 5, x, y, 0.5)]);
    }
  return outline(px);
}

export function log(L, seed) {
  const rnd = mulberry(seed), H = Math.max(3, Math.round(L * 0.24)), px = new Px(L + 2, H + 2);
  const bark = ramp("#5e4430", 4, 0.18), wood = ramp("#c8a878", 3, 0.14);
  for (let y = 1; y <= H; y++)
    for (let x = 1; x <= L - Math.ceil(H / 2); x++) {
      const f = (y - 1) / Math.max(1, H - 1);
      let t = f < 0.3 ? 3 : f < 0.7 ? 2 : 1;
      if (hash(x, y, seed) < 0.18) t -= 1;
      px.set(x, y, bark[clamp(t, 0, 3)]);
    }
  const ex = L - Math.ceil(H / 2), r = H / 2;
  for (let y = 1; y <= H; y++)
    for (let x = ex - r; x <= ex + r; x++) {
      const dx = (x + 0.5 - ex) / (r * 0.6), dy = (y + 0.5 - 1 - r) / r, q = dx * dx + dy * dy;
      if (q > 1) continue;
      px.set(x, y, q > 0.6 ? bark[1] : Math.floor(q * 5) % 2 ? wood[1] : wood[2]);
    }
  if (rnd() < 0.5 && L > 12) px.set(Math.floor(L * 0.4), 0, bark[2]);
  return outline(px);
}

export function stump(H, seed) {
  const W = Math.max(4, Math.round(H * 1.3)), px = new Px(W + 2, H + 2), cx = (W + 2) / 2;
  const bark = ramp("#5a4030", 4, 0.18), wood = ramp("#c9a672", 3, 0.14), top = Math.max(1, Math.round(H * 0.3));
  for (let y = 1; y <= H; y++)
    for (let x = 1; x <= W; x++) {
      const f = (x - 1) / Math.max(1, W - 1), flare = y > H - 2 ? 0 : 1;
      if ((x === 1 || x === W) && flare) continue;
      if (y <= top) {
        const dx = (x + 0.5 - cx) / (W / 2), dy = (y - top / 2 - 0.5) / (top / 2 + 0.5), q = dx * dx + dy * dy;
        if (q > 1.05) continue;
        px.set(x, y, q > 0.7 ? bark[3] : Math.floor(q * 4) % 2 ? wood[1] : wood[2]);
      } else px.set(x, y, bark[clamp((f < 0.35 ? 3 : f < 0.7 ? 2 : 1) - (hash(x, y, seed) < 0.2 ? 1 : 0), 0, 3)]);
    }
  return outline(px);
}

function poly(px, pts, c) {
  let y0 = Infinity, y1 = -Infinity;
  for (const [, y] of pts) { y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  for (let y = Math.floor(y0); y <= Math.ceil(y1); y++) {
    const xs = [], yy = y + 0.5;
    for (let i = 0; i < pts.length; i++) {
      const [ax, ay] = pts[i], [bx, by] = pts[(i + 1) % pts.length];
      if ((ay <= yy && by > yy) || (by <= yy && ay > yy)) xs.push(ax + ((yy - ay) / (by - ay)) * (bx - ax));
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) for (let x = Math.round(xs[k]); x < Math.round(xs[k + 1]); x++) px.set(x, y, typeof c === "function" ? c(x, y) : c);
  }
}
// A ridge tent seen from the front (door toward us) or three quarters (one flank showing).
export function tent(view, W, seed, cloth = "#d8c7a0") {
  const H = Math.round(W * 0.7), px = new Px(W + 2, H + 3), c = ramp(cloth, 5, 0.26), dark = ramp("#2e2220", 2, 0.06), rope = rgb("#b09a70"), pole = rgb("#6a4a2c");
  const gy = H + 1, patch = (x, y, t) => c[clamp(t + (hash(Math.floor(x / 3), Math.floor(y / 3), seed) < 0.12 ? -1 : 0), 0, 4)];
  const flip = view === "left" ? (x) => W + 1 - x : (x) => x;
  if (view === "front") {
    const cx = (W + 2) / 2, ax = cx, ay = 2, bl = W * 0.12, br = W * 0.9;
    px.line(ax, ay, 1, gy, rope); px.line(ax, ay, W, gy, rope);
    poly(px, [[ax, ay], [br, gy], [bl, gy]], (x, y) => patch(x, y, x < ax - 0.5 ? 3 : 2) );
    for (let y = ay; y <= gy; y++) px.set(ax, y, c[1]);
    const dy = ay + (gy - ay) * 0.36, dw = W * 0.19;
    poly(px, [[ax, dy], [ax + dw, gy], [ax - dw, gy]], (x, y) => dark[(y + x) % 7 === 0 ? 1 : 0]);
    poly(px, [[ax - 0.5, dy], [ax - dw - 0.5, gy], [ax - dw * 1.6, gy]], (x, y) => c[4]);
    for (let x = Math.round(bl); x <= br; x++) px.set(x, gy, c[1]);
    px.set(ax, ay - 1, pole); px.set(ax, ay - 2, pole);
    px.set(1, gy, pole); px.set(W, gy, pole);
  } else {
    const fa = [W * 0.3, 2], ba = [W * 0.84, 3.5], fl = [W * 0.04, gy], fr = [W * 0.58, gy], brr = [W * 0.99, gy - 1];
    const P = (p) => [flip(p[0]), p[1]];
    px.line(...P(fa), ...P([1, gy]), rope); px.line(...P(ba), ...P([W, gy - 2]), rope);
    poly(px, [P(fa), P(ba), P(brr), P(fr)], (x, y) => patch(x, y, view === "right" ? 1 : 2) );
    for (let k = 1; k < 3; k++) px.line(...P([fa[0] + (ba[0] - fa[0]) * (k / 3), fa[1] + (ba[1] - fa[1]) * (k / 3)]), ...P([fr[0] + (brr[0] - fr[0]) * (k / 3), gy]), c[view === "right" ? 0 : 1]);
    poly(px, [P(fa), P(fr), P(fl)], (x, y) => patch(x, y, view === "right" ? 3 : 3));
    const dy = 2 + (gy - 2) * 0.4, dxm = fa[0], dw = W * 0.1;
    poly(px, [P([dxm, dy]), P([dxm + dw, gy]), P([dxm - dw, gy])], (x, y) => dark[0]);
    px.line(...P(fa), ...P(ba), c[4]);
    px.set(...P([fa[0], 0.5]), pole); px.set(...P([fa[0], 1.5]), pole);
  }
  return outline(px);
}

const SKIN = ["#f0c8a2", "#dca77c", "#c08457", "#8e5a3a"], HAIR = ["#3a281c", "#6a4222", "#c89a52", "#a44a26", "#2a2228", "#8c8478"];
// A little adventurer, about three heads tall, in one of four facings, standing or sitting.
export function person(H, seed, clothes, view = "front", sitting = false) {
  const rnd = mulberry(seed), skin = ramp(SKIN[seed % 4], 3, 0.12), hair = ramp(HAIR[Math.floor(rnd() * HAIR.length)], 3, 0.14);
  const cl = ramp(clothes, 4, 0.2), legs = ramp(["#4a3a30", "#3a3a44", "#5a4a36"][seed % 3], 3, 0.12), boot = ramp("#3a2618", 2, 0.08), belt = rgb("#4a2e1c");
  const W = Math.max(5, Math.round(H * 0.6)) + 2, px = new Px(W + (view === "front" || view === "back" ? 0 : 2), H + 2), cx = Math.floor(px.w / 2);
  const sit = sitting ? Math.round(H * 0.18) : 0;
  const hh = Math.max(2, Math.round(H * 0.37)), hw = Math.max(2, Math.round(H * 0.36)), bh = Math.max(2, Math.round(H * 0.33)), lh = H - hh - bh;
  const y0 = 1 + sit, bodyTop = y0 + hh, legTop = bodyTop + bh, side = view === "left" ? -1 : view === "right" ? 1 : 0;
  const bw = Math.max(2, hw - 1), bl = cx - Math.floor(bw / 2);
  // legs
  if (sitting) {
    for (let y = legTop; y <= H; y++) for (let i = 0; i < bw; i++) px.set(bl + i + side * Math.max(0, y - legTop), y, i < bw / 2 ? legs[1] : legs[0]);
    for (let i = 0; i < bw; i++) px.set(bl + i + side * (H - legTop + 1), H, boot[1]);
  } else {
    const gap = H >= 12 && !side ? 1 : 0, lw = Math.max(1, Math.floor((bw - gap) / 2));
    for (let y = legTop; y <= H; y++) {
      const stride = side && H >= 12 ? Math.round((y - legTop) * 0.35) : 0;
      for (let i = 0; i < lw; i++) {
        const b = y >= H - Math.max(0, Math.round(H / 10)) ? boot : legs;
        px.set(bl + i - stride, y, b[side ? 1 : 1]);
        px.set(bl + bw - lw + i + stride, y, b[side ? 0 : 0]);
      }
    }
  }
  // body and arms
  for (let y = bodyTop; y < legTop; y++)
    for (let i = -1; i <= bw; i++) {
      const arm = i < 0 || i === bw, f = (i + 1) / (bw + 1);
      if (arm && side && (i < 0) === side > 0) continue;
      let t = f < 0.34 ? 3 : f < 0.7 ? 2 : 1;
      if (arm) t = i < 0 ? 2 : 0;
      if (view === "back") t = Math.max(0, t - 1);
      const hand = arm && y === legTop - 1;
      px.set(bl + i, y, hand ? skin[1] : cl[t]);
    }
  if (H >= 10) for (let i = 0; i < bw; i++) px.set(bl + i, legTop - 1, belt);
  if (H >= 14 && view === "front") px.set(cx, legTop - 1, rgb("#d8b04a"));
  // head
  const hl = cx - Math.floor(hw / 2) + side;
  for (let y = y0; y < bodyTop; y++)
    for (let i = 0; i < hw; i++) {
      const corner = (y === y0 || y === bodyTop - 1) && (i === 0 || i === hw - 1) && hw > 3;
      if (corner) continue;
      const fy = (y - y0) / hh, fx = i / Math.max(1, hw - 1);
      let isHair = fy < 0.34 || view === "back" || (side === 0 && (i === 0 || i === hw - 1) && fy < 0.7) || (side && (side > 0 ? fx < 0.4 : fx > 0.6) && fy < 0.85);
      if (fy > 0.8 && view !== "back") isHair = false;
      const t = fx < 0.4 ? 2 : fx < 0.75 ? 1 : 0;
      px.set(hl + i, y, isHair ? hair[t] : skin[t]);
    }
  if (view !== "back" && H >= 9) {
    const ey = y0 + Math.round(hh * 0.58), eye = [34, 24, 30];
    if (side === 0) { px.set(hl + Math.round(hw * 0.28), ey, eye); px.set(hl + hw - 1 - Math.round(hw * 0.28), ey, eye); }
    else { px.set(hl + (side > 0 ? hw - 2 : 1), ey, eye); px.set(hl + (side > 0 ? hw : -1), ey + 1, skin[1]); }
  }
  // a staff or a pack on some
  if (seed % 5 === 1 && H >= 10) px.line(bl + bw + 1, y0 - 1, bl + bw + 1, H, rgb("#7a5634"));
  if (seed % 5 === 3 && view === "back") { const pack = ramp("#6a4a30", 3, 0.12); for (let y = bodyTop; y < legTop - 1; y++) for (let i = 1; i < bw - 1; i++) px.set(bl + i, y, pack[y === bodyTop ? 2 : i < bw / 2 ? 1 : 0]); }
  return outline(px);
}

export function hearth(W, seed) {
  const H = Math.max(4, Math.round(W * 0.42)), px = new Px(W + 2, H + 2), cx = (W + 2) / 2, cy = H * 0.62, rnd = mulberry(seed);
  const stone = ramp("#8a8680", 4, 0.26), wood = ramp("#5a3a24", 3, 0.14), ash = ramp("#5a4e48", 2, 0.1);
  for (let y = 0; y < px.h; y++) for (let x = 0; x < px.w; x++) if (((x + 0.5 - cx) / (W * 0.4)) ** 2 + ((y + 0.5 - cy) / (H * 0.36)) ** 2 < 1) px.set(x, y, hash(x, y, 4) < 0.2 ? [240, 120, 40] : ash[hash(x, y, 5) < 0.5 ? 0 : 1]);
  px.line(cx - W * 0.3, cy + H * 0.1, cx + W * 0.28, cy - H * 0.3, wood[1]); px.line(cx - W * 0.28, cy - H * 0.28, cx + W * 0.3, cy + H * 0.12, wood[2]);
  const n = 9;
  for (let k = 0; k < n; k++) {
    const a = (k / n) * Math.PI * 2 + rnd() * 0.3, sx = cx + Math.cos(a) * W * 0.44, sy = cy + Math.sin(a) * H * 0.4, r = Math.max(1, W * 0.07);
    for (let y = -r; y <= r; y++) for (let x = -r * 1.3; x <= r * 1.3; x++) if ((x / (r * 1.3)) ** 2 + (y / r) ** 2 <= 1) px.set(sx + x, sy + y, stone[clamp(Math.round(1.8 - y / r - x / (r * 2.6)), 0, 3)]);
  }
  return outline(px);
}
// Flame tongues, painted in fire colors only; the renderer pushes them above white so they bloom.
export function flames(W, seed) {
  const H = Math.round(W * 1.4), px = new Px(W + 2, H + 2), rnd = mulberry(seed), cx = (W + 2) / 2;
  const col = ["#b02a1a", "#e8601c", "#ffa628", "#ffe07a", "#fffbe0"].map(rgb), tongues = [];
  for (let k = 0; k < 4; k++) tongues.push({ x: cx + (k - 1.5) * W * 0.17 + (rnd() - 0.5) * 1.5, h: H * (0.5 + rnd() * 0.5) * (k === 1 || k === 2 ? 1 : 0.7), w: W * (0.2 + rnd() * 0.1), lean: (rnd() - 0.5) * 2 });
  for (let y = 0; y < px.h; y++)
    for (let x = 0; x < px.w; x++) {
      let heat = 0;
      for (const t of tongues) {
        const f = (H + 1 - y) / t.h;
        if (f < 0 || f > 1) continue;
        const half = t.w * Math.sin(Math.min(1, f * 1.3 + 0.12) * Math.PI) * (1 - f * 0.5), dx = Math.abs(x + 0.5 - t.x - t.lean * f * f);
        if (dx < half) heat = Math.max(heat, (1 - dx / half) * 0.7 + (1 - f) * 0.5);
      }
      if (heat > 0.12) px.set(x, y, col[clamp(Math.floor(heat * 4.2 + (bayer(x, y) - 0.5) * 0.6), 0, 4)]);
    }
  return px;
}

export function woodpile(W, seed) {
  const H = Math.round(W * 0.55), px = new Px(W + 2, H + 2), rnd = mulberry(seed);
  const bark = ramp("#5c4030", 3, 0.16), wood = ramp("#caa674", 3, 0.16), r = Math.max(1.5, W / 11);
  const rows = [4, 3, 2];
  for (let x = 1; x < W * 0.72; x++) for (let y = H - r * 5.2; y < H - r * 4.2; y++) px.set(x + r, y, bark[hash(x, 1, seed) < 0.2 ? 0 : 1]);
  rows.forEach((n, row) => {
    for (let k = 0; k < n; k++) {
      const x0 = 1 + r + (row * r) + k * r * 2.05 + (rnd() - 0.5) * 0.6, y0 = H - r - row * r * 1.8;
      for (let y = -r; y <= r; y++)
        for (let x = -r; x <= r; x++) {
          const q = (x * x + y * y) / (r * r);
          if (q > 1) continue;
          px.set(x0 + x, y0 + y, q > 0.62 ? bark[x + y < 0 ? 2 : 0] : Math.floor(q * 4) % 2 ? wood[1] : wood[x + y < 0 ? 2 : 1]);
        }
    }
  });
  // A chopping block with an axe in it.
  const bx = W * 0.86, by = H;
  for (let y = by - r * 1.6; y <= by; y++) for (let x = bx - r; x <= bx + r; x++) px.set(x, y, y < by - r * 1.2 ? wood[2] : bark[x < bx ? 2 : 1]);
  px.line(bx - r * 0.2, by - r * 1.6, bx + r * 0.8, by - r * 3.8, rgb("#8a6038"));
  px.set(bx - r * 0.4, by - r * 1.7, rgb("#b8bcc0")); px.set(bx - r * 0.9, by - r * 1.8, rgb("#9ca0a6")); px.set(bx - r * 0.3, by - r * 2.1, rgb("#d8dce0"));
  return outline(px);
}

export function puff(S, seed) {
  const px = new Px(S, S), c = ramp("#b8b4b0", 3, 0.12), cx = S / 2, rnd = mulberry(seed), blobs = [];
  for (let k = 0; k < 4; k++) blobs.push({ x: cx + (rnd() - 0.5) * S * 0.4, y: cx + (rnd() - 0.5) * S * 0.3, r: S * (0.2 + rnd() * 0.12) });
  for (let y = 0; y < S; y++)
    for (let x = 0; x < S; x++) {
      let v = 0;
      for (const b of blobs) v = Math.max(v, 1 - Math.hypot(x + 0.5 - b.x, y + 0.5 - b.y) / b.r);
      if (v <= 0) continue;
      const a = v > 0.35 ? 150 : bayer(x, y) < v * 2.4 ? 110 : 0;
      if (a) px.set(x, y, c[y < cx - 1 ? 2 : y < cx + 2 ? 1 : 0], a);
    }
  return px;
}

// A cooking tripod with an iron pot hung over the fire.
export function tripod(W, seed) {
  const H = Math.round(W * 1.25), px = new Px(W + 2, H + 2), cx = (W + 2) / 2, pole = ramp("#5e3e26", 3, 0.14), iron = ramp("#3c3a40", 4, 0.2);
  px.line(cx, 1, 1, H, pole[1]); px.line(cx, 1, W, H, pole[0]); px.line(cx, 1, cx + 1, H * 0.7, pole[2]);
  const py = H * 0.5, pw = W * 0.26, ph = Math.max(2, W * 0.2);
  px.line(cx, 2, cx, py - ph, iron[0]);
  for (let y = Math.floor(py - ph); y <= py + ph * 0.6; y++)
    for (let x = Math.floor(cx - pw); x <= cx + pw; x++) {
      const dx = (x + 0.5 - cx) / pw, dy = (y + 0.5 - py) / ph;
      if (dx * dx + Math.max(0, dy) ** 2 * 2.2 > 1) continue;
      px.set(x, y, y <= py - ph + 1 ? iron[3] : iron[clamp(Math.round(2 - dx * 1.2 - dy), 0, 3)]);
    }
  return outline(px);
}
// A lantern on a short post; `glass` paints only the lit panes so the renderer can make them glow.
export function lantern(H, glass = false) {
  const W = Math.max(3, Math.round(H * 0.45)), px = new Px(W + 4, H + 2), cx = Math.floor((W + 4) / 2), wood = ramp("#5a3c26", 3, 0.14), iron = rgb("#2e2a2c");
  const lh = Math.max(3, Math.round(H * 0.28)), lw = Math.max(2, Math.round(W * 0.8)), top = 1, left = cx - Math.floor(lw / 2);
  if (!glass) {
    for (let y = top + 1; y <= H; y++) px.set(cx + Math.ceil(lw / 2), y, wood[y < H - 1 ? 1 : 0]);
    for (let x = left - 1; x <= left + lw; x++) { px.set(x, top, iron); px.set(x, top + lh + 1, iron); }
    for (let y = top; y <= top + lh + 1; y++) { px.set(left - 1, y, iron); px.set(left + lw, y, iron); }
    return outline(px);
  }
  const pane = [rgb("#ffe08a"), rgb("#fff4c8"), rgb("#ffb84a")];
  for (let y = top + 1; y <= top + lh; y++) for (let x = left; x < left + lw; x++) px.set(x, y, pane[x === left ? 1 : y === top + lh ? 2 : 0]);
  return px;
}
