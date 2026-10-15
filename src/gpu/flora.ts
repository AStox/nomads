// What the ground grew, resident on the GPU. Plan: docs/plans/2026-10-14-001-refactor-gpu-object-world-plan.md, Units
// 5 and 6. The generator lays every tree, bush, rock, stick and low plant down once (src/terrain/flora.ts scatter),
// and its entries are the world's objects one for one: entry k is object number k + 1, the game's thing t{k + 1}, for
// as long as it stands, whether the game holds it as a Thing (space.ts stock) or not, and whichever representation
// holds it on the GPU.
//
// Representations, by what changes each kind now (Capacity and Representation in the plan):
// - Trees and bushes are active: store kind "plant", one object a stem, in slots 0 onward in entry order, written
//   straight from the generator's arrays when the world first runs on a GPU (Store.write). Unit 7 gives them laws.
// - Everything else that lies or grows low (boulders, stones, pebbles, sticks, logs, clay, mushrooms, herbs, reeds,
//   ferns, flowers, grass tussocks) is static dormant: nothing changes it until something touches it, so the GPU
//   stores nothing of it and the generator's arrays are its state. One changed where it lies (a tussock grazed) is
//   lifted into store kind "piece" and kept there from then on, with its entry number; one taken is gone, stored
//   nowhere; one come back as it grew (ecology.ts regrowth) is the generator's again.
// Both kinds are still (store.ts): only the CPU's deltas change them, so their index is rebuilt only in a tick that
// had some.
//
// Fields, each a u32: x and y in millimetres (PLACE), which hold the generator's place exactly, since it puts a thing
// at a whole number of ten-thousandths of a 150 m tile, 15 mm each, and the game's px is that number over 10^4 as a
// binary32; what, the kind's index in FLORA plus 256 times the species' index in SPECIES; size, the generator's
// metres as binary32 bits, carried bit for bit and never computed with on the GPU until a law gives the kind an
// integer size (Unit 7); seed, its variation; and, for a piece, e, its object number.
//
// What the CPU reads, and why it is exact. Agent code runs synchronously inside a tick, so no lookup can wait on the
// GPU. The flora at a cell is answered by the first of these that applies:
// 1. For trees and bushes, the mirror, when the last landing brought the cell. Every person watches a window out to
//    the farthest any lookup of theirs reaches (watch, set before each landing), so the cells round people come
//    back every tick with the CPU's own deltas laid over them.
// 2. The changes the CPU has made (held), laid over the generator's arrays. That is the GPU's state exactly wherever
//    no law of the GPU changes the flora's kinds, which holds everywhere while none runs on them (so far none does),
//    so a lookup outside every window is never pending and never answered differently from the GPU.
// A law that changes flora on the GPU (Unit 7 onward) ends rule 2 for the cells it changes: from then on those cells
// must be in a window before anything looks there, or the lookup is pending.
import { FLORA, SPECIES, TILES, type Scatter } from "../terrain/flora";
import { CELL, N, TILE_CELLS } from "../terrain/grid";
import type { Obj } from "./mirror";
import { type Field, type KindSpec, type Rider, type Store, idOf, savedArray } from "./store";

// An object as it stands: kind and species as indices into FLORA and SPECIES, place in game tiles, size in metres.
export type Stand = { kind: number; species: number; px: number; py: number; size: number; seed: number };
// A change the CPU made to an entry: how it stands now (null once gone), and the piece it was lifted into, if any (an
// object, while its spawn waits for a slot, or its id).
type Held = { v: Stand | null; obj: Obj | number | null };

export const PLANT = "plant", PIECE = "piece";
const U32 = (name: string, unit: string): Field => ({ name, type: "u32", unit, scale: 1 });
const FIELDS = [U32("what", "FLORA index + 256 x SPECIES index"), U32("size", "m, binary32 bits"), U32("seed", "variation")];
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

const same = (a: Stand | null, b: Stand | null) =>
  a === b || (!!a && !!b && a.kind === b.kind && a.species === b.species && a.px === b.px && a.py === b.py && a.size === b.size && a.seed === b.seed);
// A stand's fields as the GPU holds them, and back.
export function fieldsOf(s: Stand): Record<string, number> {
  bits[0] = s.size;
  return { x: Math.round(s.px * 1e4) * STEP_MM, y: Math.round(s.py * 1e4) * STEP_MM, what: s.kind + 256 * s.species, size: word[0], seed: s.seed >>> 0 };
}
export function standOf(v: Record<string, number>): Stand {
  word[0] = v.size;
  return { kind: v.what & 255, species: v.what >>> 8, px: Math.fround(v.x / STEP_MM / 1e4), py: Math.fround(v.y / STEP_MM / 1e4), size: bits[0], seed: v.seed };
}

export class Flora implements Rider {
  readonly name = "flora";
  store: Store | null = null;
  private readonly held = new Map<number, Held>();
  private readonly active: Uint8Array; // 1 for the FLORA kinds held as plants
  private readonly plants: Uint32Array; // the entries (k) of the trees and bushes, in slot order
  private readonly kinds = new Map<number, Uint32Array>(); // the object numbers each kind was written with, made when asked
  private watched = new Set<string>();

  constructor(readonly f: Scatter) {
    this.active = Uint8Array.from(FLORA, (k) => (k === "tree" || k === "bush" ? 1 : 0));
    let n = 0;
    for (let k = 0; k < f.n; k++) n += this.active[f.kind[k]];
    this.plants = new Uint32Array(n);
    for (let k = 0, j = 0; k < f.n; k++) if (this.active[f.kind[k]]) this.plants[j++] = k;
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
  // Object e as the generator laid it down: the GPU's state before anything touched it.
  written(e: number): Stand {
    const f = this.f, k = e - 1;
    return { kind: f.kind[k], species: f.species[k], px: f.px[k], py: f.py[k], size: f.size[k], seed: f.seed[k] };
  }
  // Object e as it stands now, or null once gone (rules 1 and 2 above).
  stand(e: number): Stand | null {
    if (this.store && this.isPlant(e)) {
      const w = this.written(e), page = this.store.mirror.landed(PLANT, Math.min(N - 1, Math.floor(w.px * TILE_CELLS)), Math.min(N - 1, Math.floor(w.py * TILE_CELLS)));
      if (page) {
        const id = this.stem(e), obj = page.find((o) => o.id === id);
        return obj ? standOf(obj.v) : null;
      }
    }
    return this.now(e);
  }
  // Object e as the CPU's own changes leave it (rule 2).
  private now(e: number): Stand | null {
    const h = this.held.get(e);
    return h ? h.v : this.written(e);
  }
  // The tile object e stands on now, or -1 once gone.
  tileOf(e: number): number {
    const s = this.now(e);
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
  // The object numbers gone since the generator laid them down.
  gone(): number[] {
    const out: number[] = [];
    for (const [e, h] of this.held) if (!h.v) out.push(e);
    return out;
  }

  // ---------- changing ----------
  // Object e now stands as given (null: it is gone: taken, eaten, burned, or turned into something no longer
  // growing or lying as the ground laid it). The change goes to the GPU as deltas: a stem's fields set or the stem
  // killed; a static member lifted into a piece, the piece's fields set, or the piece killed. Trees and bushes never
  // come back where they stood once gone.
  change(e: number, next: Stand | null) {
    const was = this.now(e), w = this.written(e), s = this.store;
    if (same(was, next)) return;
    if (this.isPlant(e)) {
      if (!was) throw new Error(`object ${e}, a tree or bush, is gone and doesn't come back`);
      if (s) {
        if (!next) s.kill(this.stem(e));
        else this.setFields(this.stem(e), was, next);
      }
      if (next && same(next, w)) this.held.delete(e);
      else this.held.set(e, { v: next, obj: null });
      return;
    }
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
  // got them yet, every tree and bush written from the generator's arrays and every change made so far queued over
  // them. A store loaded from a save has them, and its saved changes replace those worked out from the world's JSON.
  attach(store: Store) {
    if (this.store) throw new Error("the flora already lives on a store");
    const fresh = !store.kinds.some((k) => k.name === PLANT);
    const plant: KindSpec = { name: PLANT, capacity: this.plants.length + SPARE, placed: true, still: true, fields: FIELDS };
    store.adopt(plant);
    store.adopt({ name: PIECE, capacity: PIECES, placed: true, still: true, fields: [...FIELDS, U32("e", "object number")] });
    this.store = store;
    if (fresh) {
      const f = this.f, n = this.plants.length, sizeBits = new Uint32Array(f.size.buffer, f.size.byteOffset, f.n);
      const cols = { x: new Uint32Array(n), y: new Uint32Array(n), what: new Uint32Array(n), size: new Uint32Array(n), seed: new Uint32Array(n) };
      // fieldsOf's encoding, column by column
      for (let j = 0; j < n; j++) {
        const k = this.plants[j];
        cols.x[j] = Math.round(f.px[k] * 1e4) * STEP_MM; cols.y[j] = Math.round(f.py[k] * 1e4) * STEP_MM;
        cols.what[j] = f.kind[k] + 256 * f.species[k]; cols.size[j] = sizeBits[k]; cols.seed[j] = f.seed[k];
      }
      store.write(PLANT, n, cols);
      const changes = [...this.held].sort((a, b) => a[0] - b[0]);
      this.held.clear();
      for (const [e, h] of changes) this.change(e, h.v);
    }
    store.ride(this);
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

  // ---------- riding the store: nothing read back; saved, the changes and the pieces they made ----------
  words() { return 0; }
  record() {}
  land() {}
  save() {
    return { held: [...this.held].map(([e, h]) => [e, h.v && [h.v.kind, h.v.species, h.v.px, h.v.py, h.v.size, h.v.seed], h.obj === null ? null : typeof h.obj === "number" ? h.obj : h.obj.id]) };
  }
  restore(state: unknown) {
    this.held.clear();
    for (const row of savedArray(state, "held", this.name)) {
      const [e, v, id] = row as [number, number[] | null, number | null];
      const obj = id === null ? null : id >= 0 ? id : this.store!.mirror.spawned(id) ?? null;
      if (id !== null && obj === null) throw new Error(`flora: object ${e}'s piece ${id} is neither in the store nor waiting in its queue`);
      this.held.set(e, { v: v && { kind: v[0], species: v[1], px: v[2], py: v[3], size: v[4], seed: v[5] }, obj });
    }
  }
}
