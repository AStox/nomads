// What the ground grew, resident on the GPU. Plan: docs/plans/2026-10-14-001-refactor-gpu-object-world-plan.md, Units
// 5 to 7. The generator lays every tree, bush, rock, stick and low plant down once (src/terrain/flora.ts scatter),
// and its entries are the world's objects one for one: entry k is object number k + 1, the game's thing t{k + 1}, for
// as long as it stands, whether the game holds it as a Thing (space.ts stock) or not, and whichever representation
// holds it on the GPU.
//
// Representations, by what changes each kind now (Capacity and Representation in the plan):
// - Trees and bushes are active: store kind "plant", one object a stem, in slots 0 onward in entry order, written
//   straight from the generator's arrays when the world first runs on a GPU (Store.write). Once a day the stems' law
//   (wgsl/stems.ts; plant-constants sec. 11) grows each under its own light, crowds out and starves them, and sets
//   their year's seed.
// - Everything else that lies or grows low (boulders, stones, pebbles, sticks, logs, clay, mushrooms, herbs, reeds,
//   ferns, flowers, grass tussocks) is static dormant: nothing changes it until something touches it, so the GPU
//   stores nothing of it and the generator's arrays are its state. One changed where it lies (a tussock grazed) is
//   lifted into store kind "piece" and kept there from then on, with its entry number; one taken is gone, stored
//   nowhere; one come back as it grew (ecology.ts regrowth) is the generator's again.
// Both kinds are still (store.ts): their places change only by the CPU's deltas, so their index is rebuilt only in a
// tick that had some. The stems' law changes sizes and kills stems but moves none, so it marks the plants changed for
// the mirror without rebuilding their index; a dead stem's row the index still holds is passed over (mirror.ts).
//
// Fields, each a u32: x and y in millimetres (PLACE), which hold the generator's place exactly, since it puts a thing
// at a whole number of ten-thousandths of a 150 m tile, 15 mm each, and the game's px is that number over 10^4 as a
// binary32; what, the kind's index in FLORA plus 256 times the species' index in SPECIES; seed, its variation. A
// stem's size is its height in mm (the generator lays stems to the millimetre); q and peak, its mass now and the most
// it has weighed (wgsl/stems.ts); crop, the seed it sheds this year. A piece's size is the generator's metres as
// binary32 bits, carried bit for bit; and e, its object number.
//
// What the CPU reads, and why it is exact. Agent code runs synchronously inside a tick, so no lookup can wait on the
// GPU. An object stands as the GPU held it after the last stems' law, with the CPU's changes since laid over it:
// - Static members are the generator's: no law of the GPU changes them.
// - A stem's height and life come back from the GPU with the landing of the tick its law ran (wgsl/stems.ts stemsLand:
//   whether each of the generator's stems stands, the trees' heights, and every stem born since); between laws the GPU
//   changes stems only by the CPU's own deltas, which the CPU holds. So every lookup anywhere on the island is answered
//   as the GPU has it, never pending.
// The mirror still copies the cells round people (watch), every field of every stem there, for CPU code that reads
// more of a stem than how it stands.
import { FLORA, SPECIES, TILES, type Scatter } from "../terrain/flora";
import { CELL, N, TILE_CELLS } from "../terrain/grid";
import type { Obj } from "./mirror";
import { cover, storage } from "./kernel";
import { type Field, type Kind, type KindSpec, type Rider, type Store, idOf, reload, savedArray, slotOfId } from "./store";
import { CELLS } from "./wgsl/index";
import {
  HQ, LAID, MAP, QSTEP, ROWS, ROW_WORDS, RW, STEMS_BUSY, STEMS_BUSY_LIST, TEXELS, TEXELS_SIDE, TEXEL_MM, type StemLayout, landWords, stemsCount, stemsFile, stemsGrow, stemsInit, stemsLand,
} from "./wgsl/stems";
import { CROWN_WORDS } from "./wgsl/crowns";

// An object as it stands: kind and species as indices into FLORA and SPECIES, place in game tiles, size in metres.
export type Stand = { kind: number; species: number; px: number; py: number; size: number; seed: number };
// A change the CPU made to an entry: how it stands now (null once gone), and the piece it was lifted into, if any (an
// object, while its spawn waits for a slot, or its id).
type Held = { v: Stand | null; obj: Obj | number | null };
// A stem the CPU made, by its Thing's id: how it stood when made, its object (a spawn waiting for its slot, its id once
// placed, or null before the flora is resident), whether a landing has brought it back since it was placed, and its
// height in mm then (0 once the GPU killed it).
type Made = { s: Stand; obj: Obj | number | null; seen: boolean; mm: number };

// What the stems' law reads from the sim (src/sim/plants.ts stemDriver), so this module needs none of it: the tables
// (wgsl/stems.ts: the rows buffer, mast words left 0, and the height and crown tables), when the law is due, and each
// day's coefficients by cell and row (alpha, beta, i32, CELLS x ROWS x 2) with each row's mast this year (1 or 0). A
// driver may work out the next due day's coefficients ahead, a share at a tick (ahead: the day, and coef holding that
// day's from word 0 up to hi), so they go to the GPU before the day comes and its law has less to do.
export type StemTables = { rows: Uint32Array; tables: Uint32Array };
export type StemDay = { coef: Int32Array; mast: readonly number[] };
export type StemAhead = { t: number; coef: Int32Array; hi: number };
export type StemDriver = { due(t: number): boolean; tables(): StemTables; day(t: number): StemDay; ahead?(t: number): StemAhead | null };
// The stems' crown raster as filed (wgsl/stems.ts stemsCount, stemsFile): starts by texel, the list of three words an
// entry, and each texel's tree sums (CROWN_WORDS a texel); release gives its buffers back to the store's pool once its
// last reader of the day has recorded its reads (Flora.raster).
export type Raster = { start: GPUBuffer; list: GPUBuffer; crowns: GPUBuffer; release(): void };

export const PLANT = "plant", PIECE = "piece";
const U32 = (name: string, unit: string, scale = 1): Field => ({ name, type: "u32", unit, scale });
const WHAT = U32("what", "FLORA index + 256 x SPECIES index"), SEED = U32("seed", "variation");
const PLANT_FIELDS = [
  WHAT, U32("size", "m", 1000), SEED,
  U32("q", "a tree's dry mass ^ 1/4, kg^(1/4); a bush's mass against its mass as laid, ^ 1/4", 2 ** 20), U32("peak", "the most q has been", 2 ** 20),
  U32("crop", "seeds shed this year"),
];
const PIECE_FIELDS = [WHAT, U32("size", "m, binary32 bits"), SEED, U32("e", "object number")];
// Room for pieces lifted over a long-running world [design]: 2^18 objects, 7.3 MB of body.
const PIECES = 1 << 18;
// The stems room beyond the generator's, for the young that stand up as stems (gpu/seedlings.ts) and the trees people
// raise (made): 2^20 more, 38 MB of body [design]; stems born past it are not born [gap].
const SPARE = 1 << 20;
// A place in game tiles to millimetres: a whole number of 15 mm steps (a ten-thousandth of a 150 m tile).
const STEP_MM = (CELL * TILE_CELLS * 1000) / 1e4;
// Windows widen to whole blocks of this many cells, 600 m [design]: a person walking 2 m a tick brings in a row of new
// cells about every 150 ticks rather than every 37.
const BLOCK = 8;
const bits = new Float32Array(1), word = new Uint32Array(bits.buffer);
const STEM: Record<number, true> = { [FLORA.indexOf("tree")]: true, [FLORA.indexOf("bush")]: true };

const same = (a: Stand | null, b: Stand | null) =>
  a === b || (!!a && !!b && a.kind === b.kind && a.species === b.species && a.px === b.px && a.py === b.py && a.size === b.size && a.seed === b.seed);
// A stand's fields as the GPU holds them, and back: a stem's size in mm, anything else's as binary32 bits.
export function fieldsOf(s: Stand): Record<string, number> {
  bits[0] = s.size;
  const size = STEM[s.kind] ? Math.round(s.size * 1000) : word[0];
  return { x: Math.round(s.px * 1e4) * STEP_MM, y: Math.round(s.py * 1e4) * STEP_MM, what: s.kind + 256 * s.species, size, seed: s.seed >>> 0 };
}
export function standOf(v: Record<string, number>): Stand {
  word[0] = v.size;
  const kind = v.what & 255;
  return { kind, species: v.what >>> 8, px: Math.fround(v.x / STEP_MM / 1e4), py: Math.fround(v.y / STEP_MM / 1e4), size: STEM[kind] ? Math.fround(v.size / 1000) : bits[0], seed: v.seed };
}

export class Flora implements Rider {
  readonly name = "flora";
  store: Store | null = null;
  private readonly held = new Map<number, Held>();
  private readonly made = new Map<string, Made>();
  private tabs: Uint32Array | null = null; // the stems' height and crown tables, as the CPU works out a made stem's mass
  private readonly active: Uint8Array; // 1 for the FLORA kinds held as plants
  private readonly plants: Uint32Array; // the entries (k) of the trees and bushes, in slot order
  private readonly kinds = new Map<number, Uint32Array>(); // the object numbers each kind was written with, made when asked
  private watched = new Set<string>();
  // The stems as the GPU held them after its last law, by slot: the generator's laid heights in mm, and from the last
  // landing (or a save) whether each of the generator's stems stands (a bit a slot; before any landing, each that was
  // laid with a height), the trees' heights (in the order of tree, a bit a generator's slot, with treeAt the trees in
  // the words before), and the heights of the slots beyond the generator's; and the stems the GPU killed, in the order
  // the landings found them.
  private readonly laidMM: Uint16Array;
  private live: Uint32Array;
  private tree: Uint32Array;
  private treeAt: Uint32Array;
  private treeMM: Uint16Array | null = null;
  private spareMM: Uint16Array | null = null;
  private readonly died: number[] = [];
  // Landings that brought the stems back: anything kept of how stems stood holds until this moves.
  landings = 0;
  private driver: StemDriver | null = null;
  private bufs: { tables: GPUBuffer; rows: GPUBuffer; coef: GPUBuffer; landed: GPUBuffer; trees: GPUBuffer } | null = null;
  private rowWords: Uint32Array | null = null;
  private landing = false;
  private src: { count: string; file: string; grow: string; land: string } | null = null;
  private busyMax = 1;

  constructor(readonly f: Scatter) {
    this.active = Uint8Array.from(FLORA, (k) => (k === "tree" || k === "bush" ? 1 : 0));
    let n = 0;
    for (let k = 0; k < f.n; k++) n += this.active[f.kind[k]];
    this.plants = new Uint32Array(n);
    this.laidMM = new Uint16Array(n);
    this.live = new Uint32Array(Math.ceil(n / 32));
    this.tree = new Uint32Array(this.live.length);
    this.treeAt = new Uint32Array(this.live.length);
    for (let k = 0, j = 0; k < f.n; k++) if (this.active[f.kind[k]]) { this.plants[j] = k; this.laidMM[j] = Math.round(f.size[k] * 1000); if (this.laidMM[j]) this.live[j >> 5] |= 1 << (j & 31); j++; }
  }
  // A stem's height in mm as the GPU held it after its last law (0 once dead), by slot.
  private heightOf(j: number): number {
    if (j >= this.plants.length) return this.spareMM?.[j - this.plants.length] ?? 0;
    const w = j >> 5, bit = 1 << (j & 31);
    if (!(this.live[w] & bit)) return 0;
    if (!this.treeMM || !(this.tree[w] & bit)) return this.laidMM[j];
    // the tree's rank among the trees: those in the words before, and the bits below its own in its word (popcount)
    let v = this.tree[w] & (bit - 1);
    v -= (v >>> 1) & 0x55555555;
    v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
    return this.treeMM[this.treeAt[w] + ((Math.imul((v + (v >>> 4)) & 0x0f0f0f0f, 0x01010101) >>> 24))];
  }
  // How many objects the generator laid down: object numbers run from 1 to n.
  get n() { return this.f.n; }
  isPlant(e: number) { return this.active[this.f.kind[e - 1]] === 1; }
  // The slot of a tree's or bush's stem in kind plant: its place among them in entry order.
  slot(e: number) {
    const k = e - 1, p = this.plants;
    let lo = 0, hi = p.length - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (p[mid] < k) lo = mid + 1; else hi = mid; }
    if (p[lo] !== k) throw new Error(`object ${e} isn't a tree or bush`);
    return lo;
  }
  // The object number of the stem the generator wrote into plant slot j, or 0 for a slot past them (the renderer's
  // picks name the stem it drew by its slot).
  entry(j: number) { return j >= 0 && j < this.plants.length ? this.plants[j] + 1 : 0; }
  // The GPU id of a tree's or bush's stem as the generator wrote it.
  private stem(e: number) { return idOf(this.store!.kind(PLANT).n, this.slot(e), 1); }

  // ---------- reading ----------
  // Object e as the generator laid it down.
  written(e: number): Stand {
    const f = this.f, k = e - 1;
    return { kind: f.kind[k], species: f.species[k], px: f.px[k], py: f.py[k], size: f.size[k], seed: f.seed[k] };
  }
  // Object e as the GPU held it after the last stems' law, before the CPU's changes since: a stem at the height it had
  // grown to, or null once the GPU had killed it; anything else as the generator laid it.
  grownStand(e: number): Stand | null {
    const w = this.written(e);
    if (!this.isPlant(e)) return w;
    const mm = this.heightOf(this.slot(e));
    return mm ? { ...w, size: Math.fround(mm / 1000) } : null;
  }
  // Object e as it stands now, or null once gone: as the GPU held it, the CPU's changes laid over. A stem's height is
  // always the GPU's (the CPU never sets it), and a stem the GPU killed is gone whatever the CPU last made of it.
  stand(e: number): Stand | null {
    const h = this.held.get(e);
    if (!h) return this.grownStand(e);
    if (!h.v || !this.isPlant(e)) return h.v;
    const g = this.grownStand(e);
    return g && { ...h.v, size: g.size };
  }
  // The tile object e stands on now, or -1 once gone.
  tileOf(e: number): number {
    const s = this.stand(e);
    return s ? Math.min(TILES - 1, Math.floor(s.py)) * TILES + Math.min(TILES - 1, Math.floor(s.px)) : -1;
  }
  // The object numbers the generator wrote with a kind (an index into FLORA), in order.
  writtenOf(kind: number): Uint32Array {
    let list = this.kinds.get(kind);
    if (!list) {
      const f = this.f;
      let n = 0;
      for (let k = 0; k < f.n; k++) if (f.kind[k] === kind) n++;
      list = new Uint32Array(n);
      for (let k = 0, j = 0; k < f.n; k++) if (f.kind[k] === kind) list[j++] = k + 1;
      this.kinds.set(kind, list);
    }
    return list;
  }
  // The object numbers gone since the generator laid them down: taken by the CPU, or stems the GPU killed.
  gone(): number[] {
    const out = new Set<number>();
    for (const [e, h] of this.held) if (!h.v) out.add(e);
    for (const e of this.died) out.add(e);
    return [...out];
  }

  // ---------- stems the CPU made ----------
  // A tree or bush people raised (a seedling come up as one, ecology.ts matured) is a stem as the generator's are: a
  // plant object the stems' law grows, crowds and starves, known to the CPU by its Thing's id rather than an entry.
  make(id: string, s: Stand) {
    if (!STEM[s.kind]) throw new Error(`${id} is no tree or bush to stand as a stem`);
    if (this.made.has(id)) throw new Error(`${id} already stands as a stem`);
    this.made.set(id, { s, obj: this.store ? this.spawnStem(s) : null, seen: false, mm: Math.round(s.size * 1000) });
  }
  // The plant object of a made stand: its fields, and its mass (stemsInit's: a tree's least q whose height reaches its
  // own, a bush's as laid).
  private spawnStem(s: Stand): Obj {
    const f = fieldsOf(s), rows = this.rowWords!, r = rows[Math.min(s.species, MAP - 1)], t = this.tabs;
    let q = LAID;
    if (t && rows[MAP + r * ROW_WORDS + RW.tree] === 1) {
      const at = (v: number) => { const j = Math.min(v >>> QSTEP, HQ - 2), lo = t[r * HQ + j], hi = t[r * HQ + j + 1]; return lo + Math.floor(((hi - lo) * Math.min(v - j * 2 ** QSTEP, 2 ** QSTEP)) / 2 ** QSTEP); };
      let lo = 0, hi = rows[MAP + r * ROW_WORDS + RW.qmax];
      while (lo < hi) { const mid = (lo + hi) >>> 1; if (at(mid) >= f.size) hi = mid; else lo = mid + 1; }
      q = lo;
    }
    this.busy(1);
    return this.store!.spawn(PLANT, { ...f, q, peak: q });
  }
  // A made stem as it stands: at the height the GPU last grew it to, null once the GPU killed it, undefined for an id
  // that names no made stem.
  madeStand(id: string): Stand | null | undefined {
    const m = this.made.get(id);
    if (!m) return undefined;
    return m.seen && !m.mm ? null : { ...m.s, size: Math.fround(m.mm / 1000) };
  }
  madeIds() { return [...this.made.keys()]; }
  // The plant slot a made stem holds, or -1 while it waits for one (the renderer hides the slot of a stem it draws
  // from its Thing).
  madeSlot(id: string) {
    const o = this.made.get(id)?.obj ?? null, n = o === null ? -1 : typeof o === "number" ? o : o.id;
    return n >= 0 ? slotOfId(n) : -1;
  }
  // A made stem gone from the world (felled, burned, taken): its object killed, unless the GPU killed it first.
  unmake(id: string) {
    const m = this.made.get(id);
    if (!m) return;
    this.made.delete(id);
    if (this.store && m.obj !== null && !(m.seen && !m.mm)) this.store.kill(typeof m.obj === "number" ? m.obj : m.obj.id);
  }
  // A landing's heights for the made stems placed by then.
  private sawMade() {
    for (const m of this.made.values()) {
      const n = m.obj === null ? -1 : typeof m.obj === "number" ? m.obj : m.obj.id;
      if (n < 0 || (m.seen && !m.mm)) continue;
      m.seen = true;
      m.mm = this.heightOf(slotOfId(n));
    }
  }

  // ---------- changing ----------
  // Object e now stands as given (null: it is gone: taken, eaten, burned, or turned into something no longer
  // growing or lying as the ground laid it). The change goes to the GPU as deltas: a stem's fields set or the stem
  // killed; a static member lifted into a piece, the piece's fields set, or the piece killed. Trees and bushes never
  // come back where they stood once gone, and a stem's height is the GPU's: what the CPU makes of it is let be.
  change(e: number, next: Stand | null) {
    const was = this.stand(e), w = this.written(e), s = this.store;
    if (this.isPlant(e)) {
      if (this.held.get(e)?.v === null) { if (next) throw new Error(`object ${e}, a tree or bush, is gone and doesn't come back`); return; }
      // one the GPU killed is gone already; the CPU's Thing goes when it hears (space.ts)
      if (!was) return;
      const now = next && { ...next, size: was.size };
      // a stem's species decides whether the law grows its height, which the landing counts on (wgsl/stems.ts stemsLand)
      if (now && now.species !== w.species) throw new Error(`object ${e}, a tree or bush, can't change its species`);
      if (same(was, now)) return;
      if (s) {
        if (!now) s.kill(this.stem(e));
        else this.setFields(this.stem(e), was, now);
      }
      if (now && same(now, this.grownStand(e))) this.held.delete(e);
      else this.held.set(e, { v: now, obj: null });
      return;
    }
    if (same(was, next)) return;
    let obj = this.held.get(e)?.obj ?? null;
    if (!next || same(next, w)) {
      if (s && obj !== null) s.kill(typeof obj === "number" ? obj : obj.id);
      if (next) this.held.delete(e);
      else this.held.set(e, { v: null, obj: null });
      return;
    }
    if (s) {
      if (obj === null) obj = s.spawn(PIECE, { ...fieldsOf(next), e });
      else this.setFields(typeof obj === "number" ? obj : obj.id, was!, next);
    }
    this.held.set(e, { v: next, obj });
  }
  private setFields(id: number, was: Stand, next: Stand) {
    const a = fieldsOf(was), b = fieldsOf(next);
    for (const name of Object.keys(b)) if (a[name] !== b[name]) this.store!.set(id, name, b[name]);
  }

  // ---------- on the GPU ----------
  // The world's flora takes up residence on a store: kinds plant and piece declared, and, in a store that hasn't
  // got them yet, every tree and bush written from the generator's arrays (with the driver, each given its mass) and
  // every change made so far queued over them. A store loaded from a save has them, and its saved changes and stems
  // replace those worked out from the world's JSON. With a driver, the stems' law runs on the store when due.
  attach(store: Store, driver: StemDriver | null = null) {
    if (this.store) throw new Error("the flora already lives on a store");
    const fresh = !store.kinds.some((k) => k.name === PLANT);
    const plant = store.adopt({ name: PLANT, capacity: this.plants.length + SPARE, placed: true, still: true, fields: PLANT_FIELDS } satisfies KindSpec);
    store.adopt({ name: PIECE, capacity: PIECES, placed: true, still: true, fields: PIECE_FIELDS });
    this.store = store;
    this.driver = driver;
    const g = store.g, t = driver?.tables();
    this.tabs = t ? t.tables : null;
    this.rowWords = t ? Uint32Array.from(t.rows) : new Uint32Array(MAP + ROWS * ROW_WORDS);
    // the generator's trees by slot, as the rows have them (a stem's species never changes): the law grows their heights
    const rw = this.rowWords, trees: number[] = [];
    for (let j = 0; j < this.plants.length; j++) {
      if (rw[MAP + rw[Math.min(this.f.species[this.plants[j]], MAP - 1)] * ROW_WORDS + RW.tree] !== 1) continue;
      this.tree[j >> 5] |= 1 << (j & 31);
      trees.push(j);
    }
    for (let w = 1, at = 0; w < this.tree.length; w++) { let v = this.tree[w - 1]; for (; v; v &= v - 1) at++; this.treeAt[w] = at; }
    this.bufs = {
      tables: storage(g, t ? t.tables : new Uint32Array(1)), rows: storage(g, this.rowWords), coef: storage(g, CELLS * ROWS * 2 * 4),
      landed: storage(g, landWords(plant.capacity, this.plants.length, trees.length).total * 4), trees: storage(g, Uint32Array.from(trees.length ? trees : [0])),
    };
    this.nTrees = trees.length;
    // the texels holding stems as laid; stems born since may take others, each widening the look (busy)
    const marks = new Uint8Array(TEXELS);
    for (const k of this.plants) {
      const x = Math.round(this.f.px[k] * 1e4) * STEP_MM, y = Math.round(this.f.py[k] * 1e4) * STEP_MM;
      marks[Math.min(Math.floor(y / TEXEL_MM), TEXELS_SIDE - 1) * TEXELS_SIDE + Math.min(Math.floor(x / TEXEL_MM), TEXELS_SIDE - 1)] = 1;
    }
    this.busyMax = Math.max(1, marks.reduce((n, v) => n + v, 0));
    if (fresh) {
      const f = this.f, n = this.plants.length;
      const cols = { x: new Uint32Array(n), y: new Uint32Array(n), what: new Uint32Array(n), size: new Uint32Array(n), seed: new Uint32Array(n) };
      // fieldsOf's encoding, column by column
      for (let j = 0; j < n; j++) {
        const k = this.plants[j];
        cols.x[j] = Math.round(f.px[k] * 1e4) * STEP_MM; cols.y[j] = Math.round(f.py[k] * 1e4) * STEP_MM;
        cols.what[j] = f.kind[k] + 256 * f.species[k]; cols.size[j] = Math.round(f.size[k] * 1000); cols.seed[j] = f.seed[k];
      }
      store.write(PLANT, n, cols);
      if (driver) store.run(stemsInit(this.layout(plant)), [plant.body, this.bufs.tables, this.bufs.rows], cover(g, plant.capacity));
      store.run(this.landSrc(plant), [plant.body, this.bufs.trees, this.bufs.landed], cover(g, landWords(plant.capacity, this.plants.length, this.nTrees).threads));
      const changes = [...this.held].sort((a, b) => a[0] - b[0]);
      this.held.clear();
      for (const [e, h] of changes) this.change(e, h.v);
      for (const m of this.made.values()) if (m.obj === null) m.obj = this.spawnStem(m.s);
    }
    if (driver) store.law({ name: "stems", due: (t) => driver.due(t), run: (s, t) => this.law(s, t) });
    if (driver?.ahead) store.law({ name: "stems ahead", due: (t) => !driver.due(t), run: (_, t) => { const a = driver.ahead!(t); if (a) this.send(a.t, a.coef, a.hi); } });
    store.ride(this);
  }
  private layout(k: Kind): StemLayout {
    const at = (name: string) => (1 + k.field[name]) * k.capacity;
    return { cap: k.capacity, x: at("x"), y: at("y"), what: at("what"), size: at("size"), q: at("q"), peak: at("peak"), crop: at("crop") };
  }
  private nTrees = 0;
  private landSrc(k: Kind) { return (this.landSource ??= stemsLand(this.layout(k), this.plants.length, this.nTrees)); }
  private landSource: string | null = null;
  // The crown raster of the stems as they stand (wgsl/stems.ts): every live stem counted into its texel and filed in
  // its texel's run, the counts scanned into starts, and each texel's trees summed into crowns (CROWN_WORDS a texel).
  // The stems' law files it first each day, and the crowns, deadwood and seedlings read the same day's after it; filed
  // now when asked before any law has run this tick, or when asked for as the stems stand now (now: a crown pass made
  // between ticks, after the CPU's fellings and plantings went up, gpu/crowns.ts refresh). Its buffers are borrowed
  // from the store's pool and held until its last reader of the day lets them go (release: the deer's browse, before
  // the smallest things' step borrows the most); asked for again after that, it is filed again.
  raster(now = false): Raster {
    const s = this.store!, k = s.kind(PLANT), g = s.g, b = this.bufs!, src = this.lawSources();
    if (now || this.filed !== s.t || !this.rbufs) {
      // the list holds the live stems, all below the tail (the last landing's, exact while no births have run since)
      const words = 3 * (k.peek.fresh ? k.peek.tail : k.capacity);
      if (this.rbufs && this.rbufs.list.size < words * 4) this.release();
      const r = (this.rbufs ??= { start: s.borrow(TEXELS + 1), cursor: s.borrow(TEXELS), list: s.borrow(words), crowns: s.borrow(CROWN_WORDS * TEXELS) });
      this.filed = s.t;
      s.encode((e) => { e.clearBuffer(r.start, 0, (TEXELS + 1) * 4); e.clearBuffer(r.cursor, 0, TEXELS * 4); e.clearBuffer(r.crowns, 0, CROWN_WORDS * TEXELS * 4); });
      s.run(src.count, [k.body, r.start], cover(g, k.capacity));
      s.scan(r.start, TEXELS + 1);
      s.run(src.file, [k.body, r.start, r.cursor, r.list, b.tables, b.rows, r.crowns], cover(g, k.capacity));
    }
    const r = this.rbufs;
    return { start: r.start, list: r.list, crowns: r.crowns, release: () => this.release() };
  }
  // The raster's buffers given back to the store's pool once its day's readers have recorded their reads.
  release() {
    if (!this.rbufs) return;
    const r = this.rbufs;
    this.store!.giveBack(r.start, r.cursor, r.list, r.crowns);
    this.rbufs = null;
    this.filed = -1;
  }
  private rbufs: { start: GPUBuffer; cursor: GPUBuffer; list: GPUBuffer; crowns: GPUBuffer } | null = null;
  // the stems' law's own kernels, made once
  private lawSources() {
    const k = this.store!.kind(PLANT), lay = this.layout(k);
    return (this.src ??= { count: stemsCount(lay), file: stemsFile(lay), grow: stemsGrow(lay), land: this.landSrc(k) });
  }
  kernelSources(): string[] {
    const src = this.lawSources();
    return [src.count, src.file, STEMS_BUSY, STEMS_BUSY_LIST, src.grow, src.land];
  }
  private filed = -1;
  // n stems born, or about to be, that may stand in texels no stem held: the stems' law looks over that many more.
  busy(n: number) {
    this.busyMax = Math.min(TEXELS, this.busyMax + n);
  }
  // The stems' tables and rows as the GPU holds them (wgsl/stems.ts), for laws that read the stems' heights and crowns.
  stemBuffers(): { tables: GPUBuffer; rows: GPUBuffer } {
    return { tables: this.bufs!.tables, rows: this.bufs!.rows };
  }
  // The coefficients of day t on the GPU from word 0 up to upto.
  private sent = { t: -1, upto: 0 };
  private send(t: number, coef: Int32Array, hi: number) {
    if (this.sent.t !== t) this.sent = { t, upto: 0 };
    const lo = this.sent.upto;
    if (hi > lo) this.store!.g.device.queue.writeBuffer(this.bufs!.coef, lo * 4, coef.buffer, coef.byteOffset + lo * 4, (hi - lo) * 4);
    this.sent.upto = Math.max(lo, hi);
  }
  // A day of the stems (wgsl/stems.ts): the crown raster filed, every stem grown, crowded or starved, its seed set, and
  // what the CPU keeps of the stems put by for the landing to bring back.
  private law(s: Store, t: number) {
    const k = s.kind(PLANT), g = s.g, b = this.bufs!, rows = this.rowWords!, day = this.driver!.day(t);
    for (let r = 0; r < ROWS; r++) rows[MAP + r * ROW_WORDS + RW.mast] = day.mast[r] ?? 0;
    g.device.queue.writeBuffer(b.rows, 0, rows);
    this.send(t, day.coef, day.coef.length);
    this.filed = -1;
    const { start: count, list } = this.raster(), src = this.src!;
    const flags = s.scratch("stemflags", TEXELS + 1), busy = s.scratch("stembusy", TEXELS);
    s.run(STEMS_BUSY, [count, flags], cover(g, TEXELS + 1));
    s.scan(flags, TEXELS + 1);
    s.run(STEMS_BUSY_LIST, [count, flags, busy], cover(g, TEXELS));
    s.run(src.grow, [k.body, count, list, b.tables, b.rows, b.coef, flags, busy], cover(g, this.busyMax, 1));
    s.run(src.land, [k.body, b.trees, b.landed], cover(g, landWords(k.capacity, this.plants.length, this.nTrees).threads));
    k.stale = true;
    this.landing = true;
  }
  // Every person's window of cells: out to reach metres round where each stands (px, py in game tiles), widened to
  // whole blocks of BLOCK cells so that walking brings a new row of cells only every few hundred metres (each new
  // cell is a copy back from the GPU), watched under the person's id until they are gone.
  watch(people: readonly { id: string; px: number; py: number }[], reach: number) {
    if (!this.store) return;
    const m = this.store.mirror, keys = new Set<string>(), tm = CELL * TILE_CELLS;
    const lo = (v: number) => Math.max(0, Math.floor(Math.floor(v / CELL) / BLOCK) * BLOCK);
    const hi = (v: number) => Math.min(N - 1, (Math.floor(Math.floor(v / CELL) / BLOCK) + 1) * BLOCK - 1);
    for (const a of people) {
      const key = `flora:${a.id}`, x = a.px * tm, y = a.py * tm;
      m.watch(key, { x0: lo(x - reach), y0: lo(y - reach), x1: hi(x + reach), y1: hi(y + reach) });
      keys.add(key);
    }
    for (const key of this.watched) if (!keys.has(key)) m.watch(key, null);
    this.watched = keys;
  }

  // ---------- riding the store: the stems as a law left them; saved, the changes, the pieces they made and the stems ----------
  private landed() { return landWords(this.store!.kind(PLANT).capacity, this.plants.length, this.nTrees); }
  words() { return this.landing ? this.landed().total : 0; }
  record(out: GPUBuffer, at: number) {
    if (!this.landing) return;
    const b = this.bufs!, n = this.landed().total;
    this.store!.encode((e) => e.copyBufferToBuffer(b.landed, 0, out, at * 4, n * 4));
  }
  land(o: Uint32Array, at: number) {
    if (!this.landing) return;
    this.landing = false;
    this.took(o.subarray(at, at + this.landed().total));
    this.sawMade();
  }
  // The stems as a landing or a save brought them back (wgsl/stems.ts stemsLand's words), kept as given (not copied);
  // the generator's stems that stood before and stand no longer go into died, in slot order.
  private took(words: Uint32Array) {
    const L = this.landed(), live = words.subarray(0, L.bits), was = this.live;
    for (let w = 0; w < L.bits; w++)
      for (let gone = was[w] & ~live[w]; gone; gone &= gone - 1) this.died.push(this.plants[w * 32 + 31 - Math.clz32(gone & -gone)] + 1);
    this.live = live;
    this.treeMM = new Uint16Array(words.buffer, words.byteOffset + L.bits * 4, 2 * L.trees);
    this.spareMM = new Uint16Array(words.buffer, words.byteOffset + (L.bits + L.trees) * 4, 2 * L.spare);
    this.landings++;
  }
  buffers(): [string, GPUBuffer][] { return this.bufs ? [["landed", this.bufs.landed]] : []; }
  save() {
    return {
      held: [...this.held].map(([e, h]) => [e, h.v && [h.v.kind, h.v.species, h.v.px, h.v.py, h.v.size, h.v.seed], h.obj === null ? null : typeof h.obj === "number" ? h.obj : h.obj.id]),
      made: [...this.made].map(([id, m]) => [id, [m.s.kind, m.s.species, m.s.px, m.s.py, m.s.size, m.s.seed], m.obj === null ? null : typeof m.obj === "number" ? m.obj : m.obj.id, m.seen, m.mm]),
    };
  }
  restore(state: unknown, data: Record<string, Uint8Array> = {}) {
    this.held.clear();
    for (const row of savedArray(state, "held", this.name)) {
      const [e, v, id] = row as [number, number[] | null, number | null];
      const obj = id === null ? null : id >= 0 ? id : this.store!.mirror.spawned(id) ?? null;
      if (id !== null && obj === null) throw new Error(`flora: object ${e}'s piece ${id} is neither in the store nor waiting in its queue`);
      this.held.set(e, { v: v && { kind: v[0], species: v[1], px: v[2], py: v[3], size: v[4], seed: v[5] }, obj });
    }
    this.made.clear();
    for (const row of savedArray(state, "made", this.name)) {
      const [id, v, oid, seen, mm] = row as [string, number[], number | null, boolean, number];
      const obj = oid === null ? null : oid >= 0 ? oid : this.store!.mirror.spawned(oid) ?? null;
      if (oid !== null && obj === null) throw new Error(`flora: made stem ${id}'s object ${oid} is neither in the store nor waiting in its queue`);
      this.made.set(id, { s: { kind: v[0], species: v[1], px: v[2], py: v[3], size: v[4], seed: v[5] }, obj, seen, mm });
      this.busy(1);
    }
    const landed = data.landed;
    reload(this.store!.g, this.bufs!.landed, landed, "flora landed stems");
    this.took(new Uint32Array(landed.buffer.slice(landed.byteOffset, landed.byteOffset + landed.byteLength)));
  }
  // Lets go of the buffers the flora made (the store's own go with the store).
  destroy() {
    if (!this.bufs) return;
    for (const b of Object.values(this.bufs)) b.destroy();
    this.bufs = null;
  }
}
