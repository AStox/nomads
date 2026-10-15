// The objects' sprites, made once for every size any level draws them at, in one atlas the GPU reads (webgpu.js). An
// object belongs to a family (a tree's species, layout, tint and the forest's darkness at its foot; anything else's kind,
// species, layout and moss), and each level wants it at one size of that family: the same drawing main.js collectLive
// asked sprites.js and things.js for, so the GPU stands the very sprite the bake once blitted. Sizes are worked out in
// float32 exactly as the GPU's cull pass works them out, so the sprite it asks for is the one made.
import { NS, ATLAS } from "./webgpu.js";

// kinds whose sprites lie flat and cast no shadow (main.js FLAT)
const FLAT = new Set(["clay", "stick", "pebble", "flowers", "herb", "mushroom"]);
// the kinds the page draws itself every frame (px.js ObjBins.LIVE)
export const LIVE = new Set(["fire", "structure", "item", "trap", "pit", "ash", "well", "grave"]);
const f32 = Math.fround;
// the size in meters an object is drawn at (px.js ObjBins.shown)
const shown = (size) => (size < 1 ? size ** 0.55 : size);
// the table's size index of a sprite hpx art px tall: a tree's whole pixels, anything else's half pixels under 8, then
// whole ones (main.js collectLive's hp and hq), as the GPU's cull pass works it out
export function sizeIndex(hpx, tree) {
  if (tree) return Math.min(NS - 1, Math.max(1, Math.floor(hpx + 0.5)));
  return Math.min(NS - 1, hpx < 8 ? Math.floor(f32(hpx * 2) + 0.5) : 8 + Math.floor(hpx + 0.5));
}

// The families and per-object words of a set of objects. fields: { aoAt(x, z), treeAt(x, z) } for a tree's darkness
// (main.js dimAt, under the GPU's light: the hollows' share only) and a stone's moss; treeTint: sprites.js treeTint.
export class Families {
  constructor(treeTint) {
    this.keys = []; this.index = new Map(); this.treeTint = treeTint;
  }
  // a family's index, made if new; a tree's shrunk family is the next one
  of(key, tree) {
    let f = this.index.get(key);
    if (f === undefined) {
      f = this.keys.length;
      this.index.set(key, f); this.keys.push(key);
      if (tree) { this.keys.push(`${key}|1`); }
    }
    return f;
  }
  // meta and shown size of one object (kind and species names, world x, z, size, seed, n): webgpu.js CULL_WGSL's words
  word(K, sp, x, z, size, seed, n, fields) {
    if (LIVE.has(K)) return null;
    const vr = seed % 8, tint = ((seed >>> 8) & 255) / 255, mirror = (seed >>> 3) & 1, tree = K === "tree", grass = K === "grass";
    let key;
    if (tree) {
      const dim = Math.round(Math.max(-0.75, Math.min(1, 0.05 - Math.max(0, fields.aoAt(x, z)) * 0.4 * 0.75)) * 4) / 4;
      key = `t|${sp}|${vr}|${this.treeTint(tint, sp)}|${dim === 0 ? 0 : dim}`;
    } else {
      const moss = K === "boulder" || K === "stone" ? (fields.treeAt(x, z) > 0.4 ? 0.6 : 0.1) : 0;
      key = `o|${K}|${sp}|${vr}|${moss}|${n === undefined ? "" : n > 0 ? 1 : 0}`;
    }
    const fam = this.of(key, tree);
    return { meta: fam | (grass ? 1 << 20 : 0) | (tree ? 1 << 21 : 0) | (FLAT.has(K) ? 1 << 22 : 0) | (mirror << 23) | (1 << 24), hk: f32(grass ? size : shown(size)) };
  }
}

// Every family and size (its slot, family * NS + size index) any level draws objects k0..k1 at, given their four words
// each (webgpu.js CULL_WGSL: the shown size's bits third, meta fourth). levels: [{ pv, pw, shrunk }].
export function markNeeds(words, k0, k1, levels, mark) {
  const L = levels.map((l) => ({ pv: f32(l.pv), pw: f32(l.pw), shrunk: l.shrunk ? 1 : 0 })), F = new Float32Array(words.buffer, words.byteOffset, words.length);
  for (let k = k0; k < k1; k++) {
    const m = words[k * 4 + 3];
    if (!(m & (1 << 24))) continue;
    const grass = (m >>> 20) & 1, tree = (m >>> 21) & 1, fam = m & 0xfffff, h = F[k * 4 + 2];
    for (const l of L) {
      const hpx = f32(h * (grass ? l.pw : l.pv));
      if (hpx < 1) continue;
      mark((fam + (tree && l.shrunk ? 1 : 0)) * NS + sizeIndex(hpx, tree));
    }
  }
}

// One sprite of a family at a size index: the drawing sprites.js or things.js makes for it.
export function makeSprite(key, idx, SP, TH) {
  const f = key.split("|");
  if (f[0] === "t") return SP.tree(idx, f[1], +f[2], +f[3], +f[4], f[5] === "1");
  const o = { species: f[2], moss: +f[4] };
  if (f[5] !== "") o.n = +f[5];
  return TH.object?.(f[1], idx < 16 ? idx / 2 : idx - 8, +f[3] * 131 + 7, o) ?? null;
}
// a sprite as plain data, for posting between workers
// A sprite as plain data, for posting between workers, trimmed to its painted pixels: blit places a pixel by its offset
// from the anchor (mirrored, by the anchor), so cropping both together moves nothing, and a speck of one pixel becomes
// a 1 x 1 sprite the GPU draws as a point. Null where nothing is painted.
export function flat(s) {
  if (!s) return null;
  let x0 = s.w, x1 = -1, y0 = s.h, y1 = -1;
  for (let y = 0; y < s.h; y++)
    for (let x = 0; x < s.w; x++)
      if (s.p[y * s.w + x] !== 255) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  if (x1 < 0) return null;
  const w = x1 - x0 + 1, h = y1 - y0 + 1, p = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) p.set(s.p.subarray((y0 + y) * s.w + x0, (y0 + y) * s.w + x0 + w), y * w);
  return { w, h, ax: s.ax - x0, ay: s.ay - y0, foot: s.foot || 0, p };
}

// The rows of a sprite that cast a shadow, as px.js shadowRows reads them: for each row at or above the anchor, its
// leftmost and rightmost painted columns, packed y | a << 10 | b << 20.
export function castRows(s) {
  const out = [];
  for (let y = Math.min(s.ay, s.h - 1); y >= 0; y--) {
    let a = -1, b = -1;
    for (let x = 0; x < s.w; x++) if (s.p[y * s.w + x] !== 255) { if (a < 0) a = x; b = x; }
    if (a >= 0) out.push(y | (a << 10) | (b << 20));
  }
  return out;
}

// Shelves in layers of ATLAS x ATLAS: each sprite at the next free place of the current shelf, a new shelf when it is
// full, a new layer when the layer is.
export class Shelves {
  constructor(layer0 = 0, layers = Infinity) { this.layer0 = layer0; this.max = layers; this.reset(); }
  reset() { this.l = 0; this.x = 0; this.y = 0; this.rowH = 0; }
  place(w, h) {
    if (w > ATLAS || h > ATLAS) return null;
    if (this.x + w > ATLAS) { this.x = 0; this.y += this.rowH; this.rowH = 0; }
    if (this.y + h > ATLAS) { this.l++; this.x = 0; this.y = 0; this.rowH = 0; }
    if (this.l >= this.max) return null;
    const at = { l: this.layer0 + this.l, x: this.x, y: this.y };
    this.x += w; this.rowH = Math.max(this.rowH, h);
    return at;
  }
  get layers() { return this.l + 1; }
}
// a sprite's two entry words at `at` (its place in the atlas) with its cast rows at rowsOff
export function entryWords(s, at, rowsOff, rowsN) {
  return [at.x | (at.y << 16), s.w | (s.h << 16), (s.ax + 32768) | ((s.ay + 32768) << 16), at.l | (((s.foot + 128) & 255) << 8), rowsOff, rowsN, 0, 0];
}
