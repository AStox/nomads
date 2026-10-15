// A low-resolution indexed framebuffer with a depth buffer, and the few primitives everything is drawn with.
import { RGB, SHADOW } from "./pal.js";

const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((v) => (v + 0.5) / 16);
export const bayer = (x, y) => BAYER[((y & 3) << 2) | (x & 3)];
// Ordered dither of a continuous ramp position into an index of `r`.
export const dith = (r, v, x, y) => r[Math.max(0, Math.min(r.length - 1, Math.floor(v + bayer(x, y))))];
export function h2(x, y, s = 0) {
  let h = (x * 374761393 + y * 668265263 + s * 1442695041) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

export class Buf {
  constructor(w, h) {
    this.w = w; this.h = h;
    this.c = new Uint8Array(w * h);
    this.z = new Float32Array(w * h).fill(-1e30);
    this.id = new Uint16Array(w * h); // 0 terrain, else the object that drew the pixel
    this.sh = new Uint8Array(w * h); // already shadowed
  }
  // `clear`: an index left fully transparent, for overlays
  toImage(g, clear = -1) {
    const img = g.createImageData(this.w, this.h), d = img.data;
    for (let p = 0; p < this.w * this.h; p++) {
      if (this.c[p] === clear) continue;
      const c = RGB[this.c[p]];
      d[p * 4] = c[0]; d[p * 4 + 1] = c[1]; d[p * 4 + 2] = c[2]; d[p * 4 + 3] = 255;
    }
    g.putImageData(img, 0, 0);
  }
}

// Triangle fill sampled at pixel centers with a top-left rule, so neighbouring tiles share edges without gaps or
// double pixels. fn(p, x, y, la, lb, lc) gets barycentrics in the caller's vertex order.
export function tri(B, ax, ay, bx, by, cx, cy, fn) {
  let area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  if (area === 0) return;
  let flip = false;
  if (area < 0) { let t = bx; bx = cx; cx = t; t = by; by = cy; cy = t; area = -area; flip = true; }
  const x0 = Math.max(0, Math.floor(Math.min(ax, bx, cx))), x1 = Math.min(B.w - 1, Math.ceil(Math.max(ax, bx, cx)));
  const y0 = Math.max(0, Math.floor(Math.min(ay, by, cy))), y1 = Math.min(B.h - 1, Math.ceil(Math.max(ay, by, cy)));
  const tl = (dx, dy) => dy < 0 || (dy === 0 && dx > 0);
  const t0 = tl(cx - bx, cy - by), t1 = tl(ax - cx, ay - cy), t2 = tl(bx - ax, by - ay);
  for (let y = y0; y <= y1; y++) {
    const py = y + 0.5;
    for (let x = x0; x <= x1; x++) {
      const px = x + 0.5;
      const w0 = (cx - bx) * (py - by) - (cy - by) * (px - bx);
      if (w0 < 0 || (w0 === 0 && !t0)) continue;
      const w1 = (ax - cx) * (py - cy) - (ay - cy) * (px - cx);
      if (w1 < 0 || (w1 === 0 && !t1)) continue;
      const w2 = (bx - ax) * (py - ay) - (by - ay) * (px - ax);
      if (w2 < 0 || (w2 === 0 && !t2)) continue;
      const la = w0 / area, lb = w1 / area, lc = w2 / area;
      fn(y * B.w + x, x, y, la, flip ? lc : lb, flip ? lb : lc);
    }
  }
}

// A vertical strip between two screen-space lines over columns [xa, xb): top and bottom run linearly from a to b.
// fn(p, x, y, t, depth) with t along the strip and depth in pixels below the top line.
export function strip(B, xa, xb, ta, tb, ba, bb, fn) {
  const c0 = Math.max(0, Math.ceil(xa - 0.5)), c1 = Math.min(B.w - 1, Math.ceil(xb - 0.5) - 1);
  for (let x = c0; x <= c1; x++) {
    const t = (x + 0.5 - xa) / (xb - xa), top = ta + (tb - ta) * t, bot = ba + (bb - ba) * t;
    if (bot <= top) continue;
    const y0 = Math.max(0, Math.ceil(top - 0.5)), y1 = Math.min(B.h - 1, Math.ceil(bot - 0.5) - 1);
    for (let y = y0; y <= y1; y++) fn(y * B.w + x, x, y, t, y + 0.5 - top, bot - top);
  }
}

export class Spr {
  constructor(w, h, ax, ay) { this.w = w; this.h = h; this.ax = ax; this.ay = ay; this.p = new Uint8Array(w * h).fill(255); }
  set(x, y, c) { x = Math.round(x); y = Math.round(y); if (x >= 0 && y >= 0 && x < this.w && y < this.h) this.p[y * this.w + x] = c; }
  get(x, y) { return x >= 0 && y >= 0 && x < this.w && y < this.h ? this.p[y * this.w + x] : 255; }
  // Paint `c` into transparent pixels that touch opaque ones (4-neighbourhood), optionally only below and right.
  outline(c, lowerRightOnly = false) {
    const q = this.p.slice();
    for (let y = 0; y < this.h; y++)
      for (let x = 0; x < this.w; x++) {
        if (q[y * this.w + x] !== 255) continue;
        const at = (i, j) => i >= 0 && j >= 0 && i < this.w && j < this.h && q[j * this.w + i] !== 255;
        const hit = lowerRightOnly ? at(x - 1, y) || at(x, y - 1) : at(x - 1, y) || at(x + 1, y) || at(x, y - 1) || at(x, y + 1);
        if (hit) this.p[y * this.w + x] = c;
      }
  }
}

// The mean colour of a sprite's opaque pixels.
export function meanColor(S) {
  let r = 0, g = 0, b = 0, n = 0;
  for (let i = 0; i < S.p.length; i++) if (S.p[i] !== 255) { const c = RGB[S.p[i]]; r += c[0]; g += c[1]; b += c[2]; n++; }
  return n ? [r / n, g / n, b / n] : [0, 0, 0];
}

// A sprite averaged down by f (> 1), so a small one keeps the footprint and the colour of its big self. Each pixel of the
// result is an f x f block of S: columns centred on the anchor's, rows ending on the bottom edge of the anchor's row (the
// ground line). It is drawn if it is among the k most covered, k being the opaque area S has at this size, so the area
// holds at every f and a sprite is never emptied, and it takes the entry S uses nearest the mean colour of its block.
// contrast < 1 pulls each block's colour toward `toward` (S's own mean unless given) first, so a speck keeps the tone of
// the big one but not all of its light and shade.
export function shrink(S, f, { contrast = 1, toward } = {}) {
  if (f <= 1.0001) return S;
  const cx = S.ax + 0.5, by = S.ay + 1;
  const Tax = Math.max(0, Math.ceil(cx / f - 0.5)), Tay = Math.max(0, Math.ceil(by / f) - 1);
  const W = Tax + 1 + Math.max(0, Math.ceil((S.w - cx) / f - 0.5)), H = Tay + 1 + Math.max(0, Math.ceil((S.h - by) / f));
  const T = new Spr(W, H, Tax, Tay), n = W * H, cov = new Float32Array(n), mean = new Float32Array(n * 3);
  // each column's span of S and its share of every pixel in it, once for all the rows
  const xa = new Int32Array(W), xb = new Int32Array(W), wx = new Array(W);
  for (let i = 0; i < W; i++) {
    const x0 = cx + (i - Tax - 0.5) * f, x1 = x0 + f, a = Math.max(0, Math.floor(x0)), b = Math.min(S.w, Math.ceil(x1)), w = new Float32Array(Math.max(0, b - a));
    for (let x = a; x < b; x++) w[x - a] = Math.min(x + 1, x1) - Math.max(x, x0);
    xa[i] = a; xb[i] = b; wx[i] = w;
  }
  let total = 0;
  for (let j = 0; j < H; j++) {
    const y0 = by + (j - Tay - 1) * f, y1 = y0 + f, ya = Math.max(0, Math.floor(y0)), yb = Math.min(S.h, Math.ceil(y1));
    for (let i = 0; i < W; i++) {
      const xs = xa[i], xe = xb[i], wi = wx[i];
      let a = 0, r = 0, g = 0, b = 0;
      for (let y = ya; y < yb; y++) {
        const wy = Math.min(y + 1, y1) - Math.max(y, y0), row = y * S.w;
        for (let x = xs; x < xe; x++) {
          const c = S.p[row + x];
          if (c === 255) continue;
          const w = wy * wi[x - xs], q = RGB[c];
          a += w; r += q[0] * w; g += q[1] * w; b += q[2] * w;
        }
      }
      if (a <= 0) continue;
      const q = j * W + i;
      cov[q] = a / (f * f); total += cov[q];
      mean[q * 3] = r / a; mean[q * 3 + 1] = g / a; mean[q * 3 + 2] = b / a;
    }
  }
  // the coverage of the k-th most covered pixel, to 1/256: everything at or above it is drawn
  const hist = new Int32Array(258), k = Math.max(1, Math.round(total));
  for (let q = 0; q < n; q++) if (cov[q] > 0) hist[Math.min(256, Math.floor(cov[q] * 256))]++;
  let bin = 256, got = hist[256];
  while (got < k && bin > 0) got += hist[--bin];
  const used = (S.used ??= [...new Set(S.p)].filter((c) => c !== 255)), cols = used.map((c) => RGB[c]);
  const [gr, gg, gb] = contrast === 1 ? [0, 0, 0] : toward ?? meanColor(S);
  for (let j = 0; j < H; j++)
    for (let i = 0; i < W; i++) {
      const q = j * W + i;
      if (!(cov[q] > 0) || Math.min(256, Math.floor(cov[q] * 256)) < bin) continue;
      const r = gr + (mean[q * 3] - gr) * contrast, g = gg + (mean[q * 3 + 1] - gg) * contrast, b = gb + (mean[q * 3 + 2] - gb) * contrast;
      let best = 0, bd = Infinity;
      for (let u = 0; u < cols.length; u++) {
        const c = cols[u], e = 2 * (c[0] - r) ** 2 + 4 * (c[1] - g) ** 2 + 3 * (c[2] - b) ** 2;
        if (e < bd) { bd = e; best = u; }
      }
      T.p[q] = used[best];
    }
  if (S.foot != null) T.foot = Math.round(S.foot / f);
  return T;
}

// Sprites are camera-facing: a pixel k rows above the anchor is k units nearer the eye than the base. A buffer with an
// `ax` array also gets each drawn pixel's column from the anchor, which a turned view needs to keep the sprite whole.
// A buffer with `need` is composed lazily: every primitive names the box it is about to touch first.
export function blit(B, s, bx, by, cz, id, mirror = false, bias = 0) {
  const ax = mirror ? s.w - 1 - s.ax : s.ax, A = B.ax;
  B.need?.(bx - ax, by - s.ay, bx - ax + s.w - 1, by - s.ay + s.h - 1);
  for (let y = 0; y < s.h; y++) {
    const sy = by - s.ay + y;
    if (sy < 0 || sy >= B.h) continue;
    const z = cz + (s.ay - y) + bias;
    for (let x = 0; x < s.w; x++) {
      const col = s.p[y * s.w + (mirror ? s.w - 1 - x : x)];
      if (col === 255) continue;
      const sx = bx - ax + x;
      if (sx < 0 || sx >= B.w) continue;
      const p = sy * B.w + sx;
      if (z < B.z[p]) continue;
      B.c[p] = col; B.z[p] = z; B.id[p] = id;
      if (A) A[p] = sx - bx;
    }
  }
}

// Darken terrain once where the sprite's silhouette falls when flattened along the light: a pixel k rows up lands
// k*ax right and k*ay down of the base.
export function castShadow(B, s, bx, by, ax, ay, mirror = false) {
  const x0 = mirror ? s.w - 1 - s.ax : s.ax;
  if (B.need) { const k = Math.max(0, s.ay), dx = k * ax, dy = k * ay; B.need(Math.floor(bx - x0 + Math.min(0, dx)) - 1, Math.floor(by + Math.min(0, dy)) - 1, Math.ceil(bx - x0 + s.w + Math.max(0, dx)) + 1, Math.ceil(by + Math.max(0, dy)) + 1); }
  for (let y = 0; y < s.h; y++) {
    const k = s.ay - y;
    if (k < 0) continue;
    for (let x = 0; x < s.w; x++) {
      if (s.p[y * s.w + (mirror ? s.w - 1 - x : x)] === 255) continue;
      const gx = Math.round(bx - x0 + x + k * ax), gy = Math.round(by + k * ay);
      for (let e = 0; e < 2; e++) shadowPx(B, gx + e, gy);
    }
  }
}
export function shadowPx(B, x, y) {
  if (x < 0 || y < 0 || x >= B.w || y >= B.h) return;
  const p = y * B.w + x;
  if (B.sh[p] || B.id[p] !== 0) return;
  B.sh[p] = 1;
  B.c[p] = SHADOW[B.c[p]];
}

// A sprite as the GPU casts it along the sun: each row the round slab it stands for (a crown or a trunk is as deep as it
// is wide), pushed onto `out` as four numbers in art px: twice the row's centre column, its anchor's row, its width,
// and its rows above the anchor. Its shadow falls from there as castShadow lays a pixel's.
const SPANS = new WeakMap();
export function shadowRows(s, bx, by, mirror, out) {
  let r = SPANS.get(s);
  if (!r) {
    r = new Int16Array(s.h * 2).fill(-1);
    for (let y = 0; y < s.h; y++) for (let x = 0; x < s.w; x++) if (s.p[y * s.w + x] !== 255) { if (r[2 * y] < 0) r[2 * y] = x; r[2 * y + 1] = x; }
    SPANS.set(s, r);
  }
  const left = bx - (mirror ? s.w - 1 - s.ax : s.ax);
  for (let y = Math.min(s.ay, s.h - 1); y >= 0; y--) {
    let a = r[2 * y], b = r[2 * y + 1];
    if (a < 0) continue;
    if (mirror) { const t = a; a = s.w - 1 - b; b = s.w - 1 - t; }
    out.push(2 * left + a + b + 1, by, b - a + 1, s.ay - y);
  }
}

// The kinds the page draws every frame, since they change, burn or get picked up too often to stand in the GPU's
// object buffers; the worker draws everything else straight from them (wgsl/objects.js).
export const LIVE = new Set(["fire", "structure", "item", "trap", "pit", "ash", "well", "grave"]);
// the size in meters an object is drawn at: small things a little larger than life, so a stone still reads up close
export const shown = (size) => (size < 1 ? size ** 0.55 : size);
// an animal's body in meters (standing height, a bird's wingspan, a fish's length), drawn at 1.5 times its shown size
export const ANIMAL_BODY = { deer: 1.5, wolf: 0.9, fox: 0.5, rabbit: 0.35, heron: 1, gull: 1.2, crow: 0.9, eagle: 2, fish: 0.5, butterfly: 0.1 };
export const ANIMAL_DRAWN = 1.5;
