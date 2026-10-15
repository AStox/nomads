// The objects' sprites, made once for every size any level draws them at, in one atlas the GPU reads (webgpu.js). The
// GPU works out each object's look straight from the sim's buffers (wgsl/objects.js famOf): its family (a tree's species,
// layout, tint, the forest's darkness at its foot, its crown's width and whether its level draws it shrunk; anything
// else's kind, species, layout, moss and berries) and its size at the level shown. Looks numbers the families, gives the
// GPU the tables it reads them by, and turns a family back into the drawing sprites.js and things.js make for it, so the
// GPU stands the very sprite asked for.
import { LIVE } from "./px.js";

// the sprite table's sizes per family, and the atlas's layer side
export const NS = 320, ATLAS = 4096;

// kinds whose sprites lie flat and cast no shadow (main.js FLAT)
const FLAT = new Set(["clay", "stick", "pebble", "flowers", "herb", "mushroom"]);
// kinds whose sprites take moss where the trees stand thick
const MOSSY = new Set(["boulder", "stone"]);

// The tables the GPU reads, one u32 buffer (wgsl/objects.js reads them at these offsets): each kind code's flags; each
// kind and species code pair's first family (NONE before the pair is seen); each species code's tree species (pine,
// oak, ash, aspen: anything else draws as an oak, as things.js does); by tree species and height in quarter metres, a
// crown's width bucket and its radius (m, f32 bits); and each zoom level's sprite scales (pv, pw as f32 bits, shrunk).
export const CODES = 64, HSTEPS = 256, MAX_LEVELS = 16;
export const M_KIND = 0, M_BASE = M_KIND + CODES, M_TSP = M_BASE + CODES * CODES, M_WB = M_TSP + CODES, M_CROWN = M_WB + 4 * HSTEPS, M_LEV = M_CROWN + 4 * HSTEPS;
export const META_WORDS = M_LEV + 4 * MAX_LEVELS;
export const K_TREE = 1, K_GRASS = 2, K_FLAT = 4, K_MOSSY = 8, K_DRAWN = 16;
export const NONE = 0xffffffff;
// A tree's crown is drawn as wide as Unit 7's crowns stand (light.ts crownRadius, flora.ts crownShare): its width over
// its drawn height (sprite px across over px up, a metre across being 1 / 0.866 of a metre up in the art) in NB buckets
// RHO0 * RHO_STEP^b apart, about six per cent either side of each [design: the sprite's width is whole pixels anyway].
export const NB = 16, RHO0 = 0.14, RHO_STEP = 1.13;
// families of one kind and species pair: a tree's by layout (8), tint (4), darkness (4), crown width (NB) and shrunk;
// anything else's by layout (8), moss (2) and berries (3: unknown, none, some)
export const TREE_LOCAL = 8 * 4 * 4 * NB * 2, OTHER_LOCAL = 8 * 2 * 3;
const TREES = ["pine", "oak", "ash", "aspen"];
const ts = (sp) => Math.max(0, TREES.indexOf(sp === "pine" || sp === "ash" || sp === "aspen" ? sp : "oak"));
// a tree's tint index's value (sprites.js treeTint's steps): pine always the middle one, aspen's gold the fourth
const tintOf = (sp, ti) => [0.17, 0.5, sp === "aspen" ? 0.75 : 0.83, 0.9][ti];
// a crown's width over its drawn height: twice its radius over 0.866 of its height
export const crownRatio = (crownShare, sp, h) => (2 * Math.sqrt(crownShare(TREES[ts(sp)], h) / Math.PI)) / (0.866 * h);
export const rhoOf = (b) => RHO0 * RHO_STEP ** b;

// Kind and species codes (the sim's FLORA and SPECIES first, as its objects' `what` holds them), the families seen,
// and the tables. levels: the zoom ladder's { pv, pw, shrunk }; crownShare: flora.ts crownShare.
export class Looks {
  constructor(kinds, species, levels, crownShare) {
    if (levels.length > MAX_LEVELS) throw new Error(`at most ${MAX_LEVELS} zoom levels`);
    this.kinds = [...kinds]; this.species = [...species]; this.levels = levels; this.crownShare = crownShare;
    this.base = new Map(); this.pairs = []; this.n = 0;
  }
  // a name's code in its table, added if new; null past CODES
  code(table, name) {
    let k = table.indexOf(name ?? "");
    if (k < 0) { if (table.length >= CODES) return null; k = table.length; table.push(name ?? ""); }
    return k;
  }
  // the pair (kind code, species code) given families, if new; true when it was
  add(kind, sp) {
    const pair = kind * CODES + sp;
    if (this.base.has(pair)) return false;
    this.base.set(pair, this.n);
    this.pairs.push([this.n, kind, sp]);
    this.n += this.kinds[kind] === "tree" ? TREE_LOCAL : OTHER_LOCAL;
    return true;
  }
  // every pair set in a bitset of CODES * CODES bits (the GPU's survey of the objects)
  addAll(bits) {
    let added = false;
    for (let p = 0; p < CODES * CODES; p++) if ((bits[p >> 5] >>> (p & 31)) & 1) added = this.add(Math.floor(p / CODES), p % CODES) || added;
    return added;
  }
  meta() {
    const m = new Uint32Array(META_WORDS), F = new Float32Array(m.buffer);
    for (let k = 0; k < CODES; k++) {
      const K = this.kinds[k];
      if (K === undefined) continue;
      m[M_KIND + k] = (K === "tree" ? K_TREE : 0) | (K === "grass" ? K_GRASS : 0) | (FLAT.has(K) ? K_FLAT : 0) | (MOSSY.has(K) ? K_MOSSY : 0) | (LIVE.has(K) ? 0 : K_DRAWN);
    }
    m.fill(NONE, M_BASE, M_BASE + CODES * CODES);
    for (const [pair, b] of this.base) m[M_BASE + pair] = b;
    for (let s = 0; s < CODES; s++) m[M_TSP + s] = ts(this.species[s] ?? "");
    for (let t = 0; t < 4; t++)
      for (let i = 0; i < HSTEPS; i++) {
        const h = Math.max(0.05, (i + 0.5) / 4), b = Math.round(Math.log(crownRatio(this.crownShare, TREES[t], h) / RHO0) / Math.log(RHO_STEP));
        m[M_WB + t * HSTEPS + i] = Math.max(0, Math.min(NB - 1, b));
        F[M_CROWN + t * HSTEPS + i] = Math.sqrt(this.crownShare(TREES[t], Math.max(0.05, i / 4)) / Math.PI);
      }
    this.levels.forEach((l, i) => { F[M_LEV + i * 4] = l.pv; F[M_LEV + i * 4 + 1] = l.pw; m[M_LEV + i * 4 + 2] = l.shrunk ? 1 : 0; });
    return m;
  }
  // the drawing family f stands for (makeSprite's key)
  key(f) {
    let lo = 0, hi = this.pairs.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (this.pairs[mid][0] <= f) lo = mid; else hi = mid - 1; }
    const [b, kind, spc] = this.pairs[lo], K = this.kinds[kind], sp = this.species[spc];
    let l = f - b;
    if (K === "tree") {
      const sh = l & 1;
      l >>= 1;
      const wb = l % NB; l = Math.floor(l / NB);
      const di = l % 4; l >>= 2;
      const ti = l % 4, vr = l >> 2;
      return `t|${sp}|${vr}|${tintOf(sp, ti)}|${di ? -di / 4 : 0}|${sh}|${rhoOf(wb)}`;
    }
    const nst = l % 3; l = Math.floor(l / 3);
    const moss = l % 2, vr = l >> 1;
    return `o|${K}|${sp}|${vr}|${MOSSY.has(K) ? (moss ? 0.6 : 0.1) : 0}|${["", 0, 1][nst]}`;
  }
}

// One sprite of a family at a size index: the drawing sprites.js or things.js makes for it (an animal of the GPU's store
// standing, its layout its variation).
export function makeSprite(key, idx, SP, TH) {
  const f = key.split("|");
  if (f[0] === "t") return SP.tree(idx, f[1], +f[2], +f[3], +f[4], f[5] === "1", +f[6]);
  const hpx = idx < 16 ? idx / 2 : idx - 8;
  if (f[1] === "animal") return TH.animal?.(f[2], "stand", hpx, 0, +f[3], 1) ?? null;
  const o = { species: f[2], moss: +f[4] };
  if (f[5] !== "") o.n = +f[5];
  return TH.object?.(f[1], hpx, +f[3] * 131 + 7, o) ?? null;
}
// A sprite as plain data, for posting between workers, trimmed to its painted pixels: blit places a pixel by its offset
// from the anchor (mirrored, by the anchor), so cropping both together moves nothing, and a speck of one pixel becomes
// a 1 x 1 sprite the GPU draws as a point. Null where nothing is painted. Its shadow-casting rows come with it.
export function flat(s) {
  if (!s) return null;
  let x0 = s.w, x1 = -1, y0 = s.h, y1 = -1;
  for (let y = 0; y < s.h; y++)
    for (let x = 0; x < s.w; x++)
      if (s.p[y * s.w + x] !== 255) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  if (x1 < 0) return null;
  const w = x1 - x0 + 1, h = y1 - y0 + 1, p = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) p.set(s.p.subarray((y0 + y) * s.w + x0, (y0 + y) * s.w + x0 + w), y * w);
  const t = { w, h, ax: s.ax - x0, ay: s.ay - y0, foot: s.foot || 0, p };
  t.rows = castRows(t);
  return t;
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
