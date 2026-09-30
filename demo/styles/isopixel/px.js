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

// The sim's objects binned by 150 m tile: its typed-array snapshot (sim.objects()), with later upserts and removals on
// top by numeric id. Kinds and species are indices into the name tables, which grow as new names turn up.
export class ObjBins {
  constructor(o) {
    const n = o.id.length, start = new Int32Array(4097), tile = new Uint16Array(n);
    this.o = o; this.kinds = [...o.kindNames]; this.species = [...o.speciesNames];
    for (let i = 0; i < n; i++) { const t = ObjBins.tile(o.px[i], o.py[i]); tile[i] = t; start[t + 1]++; }
    for (let t = 0; t < 4096; t++) start[t + 1] += start[t];
    const fill = start.slice(0, 4096), list = new Int32Array(n);
    for (let i = 0; i < n; i++) list[fill[tile[i]]++] = i;
    // ids sorted, for finding a snapshot entry by id without a 600k entry Map
    const byId = new Int32Array(n);
    for (let i = 0; i < n; i++) byId[i] = i;
    byId.sort((a, b) => o.id[a] - o.id[b]);
    Object.assign(this, { start, list, byId, gone: new Set(), extra: new Map(), extraBins: new Map() });
  }
  // kinds the page draws every frame, since they change, burn or get picked up too often to bake
  static LIVE = new Set(["fire", "structure", "item", "trap", "pit", "ash", "well", "grave"]);
  // the size in meters an object is drawn at: small things a little larger than life, so a stone still reads up close
  static shown(size) { return size < 1 ? size ** 0.55 : size; }
  static tile(px, py) { return Math.max(0, Math.min(63, Math.floor(py))) * 64 + Math.max(0, Math.min(63, Math.floor(px))); }
  code(table, name) { if (!name) return 0; let k = table.indexOf(name); if (k < 0) { k = table.length; table.push(name); } return k; }
  // a record from a full sim Thing, in this table's codes
  recOf(t) { return { id: +String(t.id).slice(1), kind: this.code(this.kinds, t.kind), sp: this.code(this.species, t.species), px: t.px, py: t.py, size: t.size ?? 1, seed: t.seed >>> 0, n: t.n }; }
  find(id) {
    const o = this.o, b = this.byId;
    let lo = 0, hi = b.length - 1;
    while (lo <= hi) { const m = (lo + hi) >> 1, v = o.id[b[m]]; if (v === id) return b[m]; if (v < id) lo = m + 1; else hi = m - 1; }
    return -1;
  }
  get(id) {
    if (this.extra.has(id)) return this.extra.get(id);
    if (this.gone.has(id)) return null;
    const i = this.find(id), o = this.o;
    return i < 0 ? null : { id, kind: o.kind[i], sp: o.species[i], px: o.px[i], py: o.py[i], size: o.size[i], seed: o.seed[i], n: undefined };
  }
  upsert(r) {
    this.drop(r.id);
    this.extra.set(r.id, r);
    const t = ObjBins.tile(r.px, r.py);
    (this.extraBins.get(t) ?? this.extraBins.set(t, new Set()).get(t)).add(r.id);
  }
  drop(id) {
    const r = this.extra.get(id);
    if (r) { this.extraBins.get(ObjBins.tile(r.px, r.py))?.delete(id); this.extra.delete(id); }
    this.gone.add(id);
  }
  // fn(kind, species, px, py, size, seed, id, n) for every object on tiles tx0..tx1, ty0..ty1; n (a bush's berries) is
  // only known once the sim has changed the thing, and undefined before
  each(tx0, ty0, tx1, ty1, fn) {
    const o = this.o, { start, list, gone } = this, check = gone.size > 0;
    tx0 = Math.max(0, tx0); ty0 = Math.max(0, ty0); tx1 = Math.min(63, tx1); ty1 = Math.min(63, ty1);
    for (let ty = ty0; ty <= ty1; ty++)
      for (let tx = tx0; tx <= tx1; tx++) {
        const t = ty * 64 + tx;
        for (let k = start[t]; k < start[t + 1]; k++) {
          const i = list[k], id = o.id[i];
          if (check && gone.has(id)) continue;
          fn(o.kind[i], o.species[i], o.px[i], o.py[i], o.size[i], o.seed[i], id);
        }
        const ex = this.extraBins.get(t);
        if (ex) for (const id of ex) { const r = this.extra.get(id); fn(r.kind, r.sp, r.px, r.py, r.size, r.seed, id, r.n); }
      }
  }
}
