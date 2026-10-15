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
// - A stem's height and life come back from the GPU in one copy (packed, two stems to a word) with the landing of the
//   tick its law ran; between laws the GPU changes stems only by the CPU's own deltas, which the CPU holds. So every
//   lookup anywhere on the island is answered as the GPU has it, never pending.
// The mirror still copies the cells round people (watch), every field of every stem there, for CPU code that reads
// more of a stem than how it stands.
import { FLORA, SPECIES, TILES, type Scatter } from "../terrain/flora";
import { CELL, N, TILE_CELLS } from "../terrain/grid";
import type { Obj } from "./mirror";
import { cover, storage } from "./kernel";
import { type Field, type Kind, type KindSpec, type Rider, type Store, idOf, reload, savedArray } from "./store";
import { CELLS } from "./wgsl/index";
import {
  MAP, ROWS, ROW_WORDS, RW, STEMS_BUSY, STEMS_BUSY_LIST, TEXELS, TEXELS_SIDE, TEXEL_MM, type StemLayout, stemsCount, stemsFile, stemsGrow, stemsInit, stemsPack,
} from "./wgsl/stems";

// An object as it stands: kind and species as indices into FLORA and SPECIES, place in game tiles, size in metres.
export type Stand = { kind: number; species: number; px: number; py: number; size: number; seed: number };
// A change the CPU made to an entry: how it stands now (null once gone), and the piece it was lifted into, if any (an
// object, while its spawn waits for a slot, or its id).
type Held = { v: Stand | null; obj: Obj | number | null };

// What the stems' law reads from the sim (src/sim/plants.ts stemDriver), so this module needs none of it: the tables
// (wgsl/stems.ts: the rows buffer, mast words left 0, and the height and crown tables), when the law is due, and each
// day's coefficients by cell and row (alpha, beta, i32, CELLS x ROWS x 2) with each row's mast this year (1 or 0).
export type StemTables = { rows: Uint32Array; tables: Uint32Array };
export type StemDay = { coef: Int32Array; mast: readonly number[] };
export type StemDriver = { due(t: number): boolean; tables(): StemTables; day(t: number): StemDay };

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
// The stems room beyond the generator's, for none is born yet [design].
const SPARE = 4096;
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
  private readonly active: Uint8Array; // 1 for the FLORA kinds held as plants
  private readonly plants: Uint32Array; // the entries (k) of the trees and bushes, in slot order
  private readonly kinds = new Map<number, Uint32Array>(); // the object numbers each kind was written with, made when asked
  private watched = new Set<string>();
  // Every stem's height in mm as the GPU held it after its last law (0 once the GPU had killed it), by slot; and the
  // stems the GPU killed, in the order the landings found them.
  private readonly grown: Uint16Array;
  private readonly died: number[] = [];
  // Landings that brought the stems back: anything kept of how stems stood holds until this moves.
  landings = 0;
  private driver: StemDriver | null = null;
  private bufs: { tables: GPUBuffer; rows: GPUBuffer; coef: GPUBuffer; packed: GPUBuffer } | null = null;
  private rowWords: Uint32Array | null = null;
  private packing = false;
  private view: { at: number; size: Float32Array } | null = null;
  private src: { count: string; file: string; grow: string; pack: string } | null = null;
  private busyMax = 1;

  constructor(readonly f: Scatter) {
    this.active = Uint8Array.from(FLORA, (k) => (k === "tree" || k === "bush" ? 1 : 0));
    let n = 0;
    for (let k = 0; k < f.n; k++) n += this.active[f.kind[k]];
    this.plants = new Uint32Array(n);
    this.grown = new Uint16Array(n);
    for (let k = 0, j = 0; k < f.n; k++) if (this.active[f.kind[k]]) { this.plants[j] = k; this.grown[j++] = Math.round(f.size[k] * 1000); }
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
    const mm = this.grown[this.slot(e)];
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
  // The generator's arrays with every stem at the height the GPU last brought back (the gone listed apart): what the
  // renderer draws. The sizes are a copy, brought up to date when asked after a landing.
  drawn(): Scatter {
    const v = (this.view ??= { at: -1, size: Float32Array.from(this.f.size) });
    if (v.at !== this.landings) {
      for (let j = 0; j < this.plants.length; j++) if (this.grown[j]) v.size[this.plants[j]] = Math.fround(this.grown[j] / 1000);
      v.at = this.landings;
    }
    return { ...this.f, size: v.size };
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
    this.rowWords = t ? Uint32Array.from(t.rows) : new Uint32Array(MAP + ROWS * ROW_WORDS);
    this.bufs = {
      tables: storage(g, t ? t.tables : new Uint32Array(1)), rows: storage(g, this.rowWords),
      coef: storage(g, CELLS * ROWS * 2 * 4), packed: storage(g, Math.ceil(plant.capacity / 2) * 4),
    };
    // the texels holding stems as laid: no stem moves or is born yet (Unit 8 births them), so no more are ever busy
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
      store.run(stemsPack(this.layout(plant)), [plant.body, this.bufs.packed], cover(g, Math.ceil(plant.capacity / 2)));
      const changes = [...this.held].sort((a, b) => a[0] - b[0]);
      this.held.clear();
      for (const [e, h] of changes) this.change(e, h.v);
    }
    if (driver) store.law({ name: "stems", due: (t) => driver.due(t), run: (s, t) => this.law(s, t) });
    store.ride(this);
  }
  private layout(k: Kind): StemLayout {
    const at = (name: string) => (1 + k.field[name]) * k.capacity;
    return { cap: k.capacity, x: at("x"), y: at("y"), what: at("what"), size: at("size"), q: at("q"), peak: at("peak"), crop: at("crop") };
  }
  // A day of the stems (wgsl/stems.ts): the crown raster filed, every stem grown, crowded or starved, its seed set, and
  // every stem's height packed for the landing to bring back.
  private law(s: Store, t: number) {
    const k = s.kind(PLANT), g = s.g, b = this.bufs!, rows = this.rowWords!, day = this.driver!.day(t);
    const lay = this.layout(k), src = (this.src ??= { count: stemsCount(lay), file: stemsFile(lay), grow: stemsGrow(lay), pack: stemsPack(lay) });
    for (let r = 0; r < ROWS; r++) rows[MAP + r * ROW_WORDS + RW.mast] = day.mast[r] ?? 0;
    g.device.queue.writeBuffer(b.rows, 0, rows);
    g.device.queue.writeBuffer(b.coef, 0, day.coef.buffer, day.coef.byteOffset, day.coef.byteLength);
    const count = s.scratch("stemcount", TEXELS + 1), cursor = s.scratch("stemcursor", TEXELS), list = s.scratch("stemlist", 3 * k.capacity);
    const flags = s.scratch("stemflags", TEXELS + 1), busy = s.scratch("stembusy", TEXELS);
    s.encode((e) => { e.clearBuffer(count, 0, (TEXELS + 1) * 4); e.clearBuffer(cursor, 0, TEXELS * 4); });
    s.run(src.count, [k.body, count], cover(g, k.capacity));
    s.scan(count, TEXELS + 1);
    s.run(src.file, [k.body, count, cursor, list, b.tables, b.rows], cover(g, k.capacity));
    s.run(STEMS_BUSY, [count, flags], cover(g, TEXELS + 1));
    s.scan(flags, TEXELS + 1);
    s.run(STEMS_BUSY_LIST, [count, flags, busy], cover(g, TEXELS));
    s.run(src.grow, [k.body, count, list, b.tables, b.rows, b.coef, flags, busy], cover(g, this.busyMax, 1));
    s.run(src.pack, [k.body, b.packed], cover(g, Math.ceil(k.capacity / 2)));
    k.stale = true;
    this.packing = true;
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

  // ---------- riding the store: the stems packed after a law; saved, the changes, the pieces they made and the stems ----------
  private packWords() { return Math.ceil(this.store!.kind(PLANT).capacity / 2); }
  words() { return this.packing ? this.packWords() : 0; }
  record(out: GPUBuffer, at: number) {
    if (!this.packing) return;
    const b = this.bufs!.packed;
    this.store!.encode((e) => e.copyBufferToBuffer(b, 0, out, at * 4, this.packWords() * 4));
  }
  land(o: Uint32Array, at: number) {
    if (!this.packing) return;
    this.packing = false;
    this.took(new Uint16Array(o.buffer, o.byteOffset + at * 4, this.plants.length));
  }
  // Stems as a landing or a save brought them back: heights by slot, 0 for the dead.
  private took(next: Uint16Array) {
    const g = this.grown;
    for (let j = 0; j < g.length; j++) if (g[j] && !next[j]) this.died.push(this.plants[j] + 1);
    g.set(next);
    this.landings++;
  }
  buffers(): [string, GPUBuffer][] { return this.bufs ? [["packed", this.bufs.packed]] : []; }
  save() {
    return { held: [...this.held].map(([e, h]) => [e, h.v && [h.v.kind, h.v.species, h.v.px, h.v.py, h.v.size, h.v.seed], h.obj === null ? null : typeof h.obj === "number" ? h.obj : h.obj.id]) };
  }
  restore(state: unknown, data: Record<string, Uint8Array> = {}) {
    this.held.clear();
    for (const row of savedArray(state, "held", this.name)) {
      const [e, v, id] = row as [number, number[] | null, number | null];
      const obj = id === null ? null : id >= 0 ? id : this.store!.mirror.spawned(id) ?? null;
      if (id !== null && obj === null) throw new Error(`flora: object ${e}'s piece ${id} is neither in the store nor waiting in its queue`);
      this.held.set(e, { v: v && { kind: v[0], species: v[1], px: v[2], py: v[3], size: v[4], seed: v[5] }, obj });
    }
    const packed = data.packed;
    reload(this.store!.g, this.bufs!.packed, packed, "flora packed stems");
    this.took(new Uint16Array(packed.buffer.slice(packed.byteOffset, packed.byteOffset + this.plants.length * 2)));
  }
  // Lets go of the buffers the flora made (the store's own go with the store).
  destroy() {
    if (!this.bufs) return;
    for (const b of Object.values(this.bufs)) b.destroy();
    this.bufs = null;
  }
}
