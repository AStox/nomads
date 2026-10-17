// The CPU's view of the GPU's objects: the cells round people, copied back at each landing (store.ts land, every
// LAND_S of sim time, src/sim/lanes.ts), and single objects asked for by id. What CPU code changes goes through the
// store's delta queue and shows here at once, laid over each landing again until the GPU has it, so an agent and the
// next frame see their own felling.
//
// Windows are rectangles of cells, kept under a key (a person's id, the view) until changed or dropped; each landing's
// gather copies the union of them, for every placed kind. A lookup of a cell outside every window, or of an id whose
// slot isn't here, answers PENDING and asks for it in the next landing, so it is answered on the tick after that
// landing; a cell or slot asked for again before a landing stays in the copy for the next.
//
// A landing keeps the copied words as they came; a cell's objects are made from them the first time the cell (or one
// of its objects) is asked for, so a tick costs the CPU what it looks at, not what the windows hold. Objects are made
// again after every landing: hold ids across ticks, not objects. An object read here is at most one landing old,
// apart from the deltas CPU code has queued since, which are already in it. A still kind (store.ts) the GPU hasn't
// changed since its last landing keeps its pages, objects and all, and has only the cells newly wanted copied: what it
// holds is then exactly the GPU's state however old the copy, and a cell held that has left every window still answers.
import { N } from "../terrain/grid";
import { CELL_MM } from "./wgsl/index";
import { genOfId, idOf, kindOfId, slotOfId, type Delta, type Kind, type Store } from "./store";

export const PENDING = Symbol("pending");
export type Pending = typeof PENDING;
// An object as the mirror holds it: its id (below zero while a spawn waits for its slot), its kind, every field, and
// the cell whose page the mirror files it in (-1 for none).
export type Obj = { id: number; kind: string; v: Record<string, number>; cell: number };
// Cells from (x0, y0) to (x1, y1), inclusive, each 0 to N - 1.
export type Rect = { x0: number; y0: number; x1: number; y1: number };

const SLOT = 0x80000000;
const NONE = -1;

// A landing's words: rows of slot, slot word, then each field.
type Words = Uint32Array;
type Pages = {
  raw: Map<number, [o: Words, at: number, n: number]>; // landed cells not yet made into objects: their landing, first word and row count
  alone: Map<number, [o: Words, at: number]>; // live slots landed alone and not yet made into objects: their landing and row's word
  where: Map<number, number> | null; // the cell of every slot in a raw cell, made the first time a slot is looked for
  cells: Map<number, Obj[]>; // cells made into objects: their live objects in slot order
  bySlot: Map<number, Obj>; // objects made, by slot
  dead: Map<number, number>; // the newest generation (mod 2^17) known dead at a slot: it and every older one are gone for good
  wantCells: Set<number>;
  wantSlots: Set<number>;
};
const empty = (dead = new Map<number, number>(), wantCells = new Set<number>(), wantSlots = new Set<number>()): Pages =>
  ({ raw: new Map(), alone: new Map(), where: null, cells: new Map(), bySlot: new Map(), dead, wantCells, wantSlots });

export class Mirror {
  private readonly pages: Pages[] = [];
  private readonly rects = new Map<string, Rect>();
  // every cell some window holds, as a mask and in order, made again only once a window changed (cells, inWindow and
  // entries for every kind read them)
  private winMask: Uint8Array | null = null;
  private winCells: Uint32Array | null = null;
  private readonly prov = new Map<number, Obj>(); // spawns not yet uploaded, by provisional id
  private fresh = new Map<number, Obj>(); // spawns the last upload placed, by the provisional id they had
  private last = new Map<number, Obj>(); // and the upload before
  private readonly gone = new WeakSet<Obj>(); // objects killed here (a spawn killed before its upload stays in prov)

  constructor(private readonly store: Store) {}
  add(k: Kind) {
    this.pages[k.n] = empty();
  }

  // ---------- windows and lookups ----------
  watch(key: string, rect: Rect | null) {
    const was = this.rects.get(key);
    if (rect) {
      if (was && was.x0 === rect.x0 && was.y0 === rect.y0 && was.x1 === rect.x1 && was.y1 === rect.y1) return;
      this.rects.set(key, rect);
    } else if (!this.rects.delete(key)) return;
    this.winMask = this.winCells = null;
  }
  private windows(): Uint8Array {
    if (this.winMask) return this.winMask;
    const m = new Uint8Array(N * N);
    let n = 0;
    for (const r of this.rects.values())
      for (let y = Math.max(0, r.y0); y <= Math.min(N - 1, r.y1); y++)
        for (let x = Math.max(0, r.x0); x <= Math.min(N - 1, r.x1); x++) if (!m[y * N + x]) { m[y * N + x] = 1; n++; }
    const cells = new Uint32Array(n);
    for (let c = 0, i = 0; i < n; c++) if (m[c]) cells[i++] = c;
    this.winCells = cells;
    return (this.winMask = m);
  }
  private inWindow(c: number) {
    return this.windows()[c] === 1;
  }
  // The live objects of a placed kind in a cell, in slot order (spawns not yet uploaded last), or PENDING.
  cell(kind: string, cx: number, cy: number): Obj[] | Pending {
    const k = this.store.kind(kind);
    if (!k.placed) throw new Error(`kind ${kind} isn't placed, so it has no cells`);
    if (cx < 0 || cy < 0 || cx >= N || cy >= N) return [];
    const p = this.pages[k.n], c = cy * N + cx;
    if (!this.inWindow(c)) p.wantCells.add(c);
    return this.page(k, p, c) ?? PENDING;
  }
  // The live objects of a placed kind in a cell, as cell gives them, when the last landing brought the cell; undefined,
  // and nothing asked for, when it didn't (for CPU code that has another exact answer for such a cell).
  landed(kind: string, cx: number, cy: number): Obj[] | undefined {
    const k = this.store.kind(kind);
    if (cx < 0 || cy < 0 || cx >= N || cy >= N) return [];
    return this.page(k, this.pages[k.n], cy * N + cx);
  }
  // An object by id: the object, null if its slot holds another generation or nothing alive, or PENDING.
  get(id: number): Obj | null | Pending {
    if (id < 0) { const s = this.spawned(id); return s && !this.gone.has(s) ? s : null; }
    const k = this.store.kinds[kindOfId(id)];
    if (!k) return null;
    const p = this.pages[k.n], slot = slotOfId(id), o = this.find(k, p, slot);
    if (o) return o.id === id ? o : null;
    if ((p.dead.get(slot) ?? -1) >= genOfId(id)) return null;
    p.wantSlots.add(slot);
    return PENDING;
  }
  // A spawn by its provisional id, before or just after the upload that placed it.
  spawned(id: number): Obj | undefined {
    return this.prov.get(id) ?? this.fresh.get(id) ?? this.last.get(id);
  }
  // Keeps an object's slot in the next landing's copy, as a lookup that missed would (a tier waiting on something
  // else before it can act on the object asks for it this way).
  want(id: number) {
    const k = id >= 0 ? this.store.kinds[kindOfId(id)] : undefined;
    if (k) this.pages[k.n].wantSlots.add(slotOfId(id));
  }

  // ---------- objects made from the landing ----------
  private make(k: Kind, p: Pages, o: Words, w: number, cell: number): Obj {
    const v: Record<string, number> = {}, fs = k.fields;
    for (let i = 0; i < fs.length; i++) v[fs[i].name] = fs[i].type === "i32" ? o[w + 2 + i] | 0 : o[w + 2 + i];
    const obj: Obj = { id: idOf(k.n, o[w], o[w + 1] >>> 1), kind: k.name, v, cell };
    p.bySlot.set(o[w], obj);
    return obj;
  }
  // A landed cell's page, made into objects the first time it is asked for; undefined for a cell not landed. A row of
  // a dead slot (one a law killed in a still kind whose index wasn't rebuilt since) is no object, and its death is noted.
  private page(k: Kind, p: Pages, c: number): Obj[] | undefined {
    const made = p.cells.get(c);
    if (made) return made;
    const raw = p.raw.get(c);
    if (!raw) return undefined;
    p.raw.delete(c);
    const [o, at, n] = raw, row = 2 + k.fields.length, page: Obj[] = [];
    for (let r = 0; r < n; r++) {
      const w = at + r * row;
      if (o[w + 1] & 1) page.push(this.make(k, p, o, w, c));
      else p.dead.set(o[w], Math.max(p.dead.get(o[w]) ?? 0, (o[w + 1] >>> 1) & 0x1ffff));
    }
    p.cells.set(c, page);
    return page;
  }
  // The object held at a slot, made from the landing if need be.
  private find(k: Kind, p: Pages, slot: number): Obj | undefined {
    const o = p.bySlot.get(slot);
    if (o) return o;
    const one = p.alone.get(slot);
    if (one) { p.alone.delete(slot); return this.make(k, p, one[0], one[1], NONE); }
    if (!p.raw.size) return undefined;
    if (!p.where) {
      p.where = new Map();
      const row = 2 + k.fields.length;
      for (const [c, [w, at, n]] of p.raw) for (let r = 0; r < n; r++) p.where.set(w[at + r * row], c);
    }
    const c = p.where.get(slot);
    if (c === undefined || !p.raw.has(c)) return undefined;
    this.page(k, p, c);
    return p.bySlot.get(slot);
  }

  // ---------- what the store asks of it ----------
  // This tick's gather entries for a kind: the cells in every window and the cells and slots asked for, sorted. With
  // keep (the store's word that the GPU hasn't changed the kind since the last landing), what the pages hold already
  // stays as it is and only what they lack is copied; unless they have come to hold more than twice the cells now
  // wanted, when everything wanted is copied again and the rest let go. Says whether it keeps.
  entries(k: Kind, keep = false): { ents: Uint32Array; keep: boolean } {
    const p = this.pages[k.n], mask = this.windows(), win = k.placed ? this.winCells! : new Uint32Array(0);
    // the cells asked for outside every window, then all wanted in order
    const extra = k.placed ? [...p.wantCells].filter((c) => !mask[c]).sort((a, b) => a - b) : [];
    let all: ArrayLike<number> = win;
    if (extra.length) {
      const m = new Uint32Array(win.length + extra.length);
      for (let i = 0, j = 0, o = 0; o < m.length; o++) m[o] = j >= extra.length || (i < win.length && win[i] < extra[j]) ? win[i++] : extra[j++];
      all = m;
    }
    keep &&= p.raw.size + p.cells.size <= 2 * all.length + 64;
    const c = keep ? Array.prototype.filter.call(all, (c: number) => !p.raw.has(c) && !p.cells.has(c)) as number[] : all, s = [...p.wantSlots].filter((s) => !keep || (!p.bySlot.has(s) && !p.alone.has(s)));
    const ents = new Uint32Array(c.length + s.length);
    ents.set(c);
    ents.set(s.sort((a, b) => a - b).map((s) => (SLOT | s) >>> 0), c.length);
    p.wantCells.clear();
    p.wantSlots.clear();
    return { ents, keep };
  }
  // A landing for a kind: the gathered words kept for its pages (added to them, with keep, each cell's rows copied
  // out so the whole landing isn't held for them); entries the copy had no room for asked again.
  land(k: Kind, ents: Uint32Array, o: Words, head: number, keep = false) {
    const old = this.pages[k.n], p = keep ? old : empty(old.dead, old.wantCells, old.wantSlots), row = 2 + k.fields.length;
    if (ents.length) p.where = null;
    for (let e = 0; e < ents.length; e++) {
      const v = ents[e], at = o[head + 2 * e], n = o[head + 2 * e + 1];
      if ((v & SLOT) === 0) {
        if (n === 0xffffffff) p.wantCells.add(v);
        else p.raw.set(v, keep ? [o.slice(at, at + n * row), 0, n] : [o, at, n]);
        continue;
      }
      const slot = v & ~SLOT;
      if (n === 0xffffffff) p.wantSlots.add(slot);
      else if ((o[at + 1] & 1) === 0) p.dead.set(slot, (o[at + 1] >>> 1) & 0x1ffff);
      else { p.dead.delete(slot); p.alone.set(slot, keep ? [o.slice(at, at + row), 0] : [o, at]); }
    }
    this.pages[k.n] = p;
  }
  // A spawn the upload has given a slot (its id now the real one).
  placed(obj: Obj, provisional: number) {
    this.prov.delete(provisional);
    this.fresh.set(provisional, obj);
    if (obj.cell !== NONE) this.pages[this.store.kind(obj.kind).n].bySlot.set(slotOfId(obj.id), obj);
  }
  uploaded() {
    this.last = this.fresh;
    this.fresh = new Map();
  }

  // ---------- write-through ----------
  apply(d: Delta) {
    if (d.op === "spawn") {
      const k = this.store.kind(d.obj.kind), p = this.pages[k.n];
      if (d.obj.id < 0) this.prov.set(d.obj.id, d.obj);
      this.gone.delete(d.obj);
      // laid over a landing again, a spawn its page still holds (one kept) is not filed twice
      this.unfile(p, d.obj);
      this.file(k, p, d.obj);
      return;
    }
    const spawn = d.id < 0 ? this.spawned(d.id) : undefined;
    if (d.id < 0 && !spawn) return;
    const id = spawn ? spawn.id : d.id, k = spawn ? this.store.kind(spawn.kind) : this.store.kinds[kindOfId(id)], p = this.pages[k.n];
    const o = spawn ?? this.find(k, p, slotOfId(id));
    const held = o && o.id === id && !this.gone.has(o) ? o : undefined;
    if (d.op === "kill") {
      if (held) { this.unfile(p, held); this.gone.add(held); }
      // a stale id's kill does nothing: the object the mirror holds at that slot is a newer one
      if (id >= 0 && (!o || o.id === id)) { const s = slotOfId(id); p.bySlot.delete(s); p.dead.set(s, Math.max(p.dead.get(s) ?? 0, genOfId(id))); }
      return;
    }
    if (!held) return;
    const f = k.fields[d.field];
    held.v[f.name] = d.value;
    if (k.placed && (f.name === "x" || f.name === "y")) { this.unfile(p, held); this.file(k, p, held); }
  }
  // An object into the page of the cell it stands in, if that cell is held, in slot order; else out of the mirror.
  private file(k: Kind, p: Pages, obj: Obj) {
    const cell = k.placed ? Math.min(Math.floor(obj.v.y / CELL_MM), N - 1) * N + Math.min(Math.floor(obj.v.x / CELL_MM), N - 1) : NONE;
    const page = cell === NONE ? undefined : this.page(k, p, cell);
    if (!page) { if (obj.id >= 0) p.bySlot.delete(slotOfId(obj.id)); obj.cell = NONE; return; }
    const slot = obj.id < 0 ? Infinity : slotOfId(obj.id);
    let i = page.length;
    while (i > 0 && (page[i - 1].id < 0 ? Infinity : slotOfId(page[i - 1].id)) > slot) i--;
    page.splice(i, 0, obj);
    obj.cell = cell;
    if (obj.id >= 0) p.bySlot.set(slot, obj);
  }
  private unfile(p: Pages, obj: Obj) {
    const page = obj.cell === NONE ? undefined : p.cells.get(obj.cell), i = page ? page.indexOf(obj) : -1;
    if (i >= 0) page!.splice(i, 1);
    obj.cell = NONE;
  }
}
