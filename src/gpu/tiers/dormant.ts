// Dormant kinds: objects whose state is computed exactly on demand, not stepped. Plan:
// docs/plans/2026-10-14-001-refactor-gpu-object-world-plan.md, Unit 4 and Capacity and Representation.
//
// A dormant kind (logs, sticks) stores identity and birth only: each member is an object of a placed store kind with
// its birth hour (born), one anchor for each driver channel its law integrates (a<channel>: the channel's running sum
// at its cell when it was born, drivers.ts) and its static attributes. Its law is a registered pair, a WGSL body and
// its TypeScript twin giving the same bits, that computes the state at any hour from born, the age, the integrals of
// the channels since birth (S_c(hour) - anchor, exact, O(1)) and the attributes. So a law of accumulated drivers
// (degree-hours, wet-hours, and anything computed from them) gives exactly what stepping the object hourly over the
// same recorded drivers gives, for as long as each integral stays inside its channel's span. Memory a member: the
// slot word, x and y, born, 4 bytes an integrated channel and its attributes.
//
// Touching a member (a lookup with intent to act, or a change) promotes it: the active kind gets an object with the
// member's place, birth and attributes, the state its law gives at the newest committed hour, and its identity (oslot
// and ogen, the dormant id's slot and generation); the dormant member is killed, and the object stays active. The
// promotion is made on the CPU with the twin, from the sums of its cell the last landing brought back, while no hour
// has been committed since: then the GPU, which gets the spawn before any law of the next tick runs, holds the same
// state the twin computed. Otherwise the touch answers PENDING and resolves after the next landing.
//
// A static dormant kind (stones, sand) stores nothing at all: a cell's members are its count (from the generator)
// and member k of a cell is a hash of (seed, stream, k, cell) through its own registered pair. A member moved or
// taken is recorded (cell, k) in a sparse list and stored from then on in a placed store kind at its new place, with
// its origin (ocell, ok) and attributes; enumerating the cell leaves it out.
import { type Field, type KindSpec, type Rider, type Store, genOfId, reload, savedArray, savedNumber, savedNumbers, slotOfId } from "../store";
import { cover, storage } from "../kernel";
import { PENDING, type Obj, type Pending } from "../mirror";
import { CELL_MM, CELLS } from "../wgsl/index";
import { N } from "../../terrain/grid";
import { rinit } from "../rand";
import { type DormantLayout, dormantAnchors, dormantEval, staticMembers } from "../wgsl/dormant";
import { drvAccess } from "../wgsl/drivers";
import type { Drivers } from "./drivers";

// What a dormant law's twin is given: born, hour and age in hours, the member's cell, the integral of each channel
// since birth (i32) and the attributes: what the WGSL law has in scope.
export type DormantInput = { born: number; hour: number; age: number; cell: number; I: Record<string, number>; attr: Record<string, number> };
export type DormantSpec = {
  dormant: string; // the store kind holding dormant members
  active: string; // the store kind a touched member becomes
  capacity: number;
  activeCapacity: number;
  channels: string[]; // the driver channels the law integrates
  attrs: Field[]; // static attributes, kept by both kinds
  state: Field[]; // the state the law computes, kept only by the active kind
  wgsl: string; // the law: assigns out_<state> from born, hour, age, cell, I_<channel>, attr_<name> (wgsl/dormant.ts)
  ts: (v: DormantInput) => Record<string, number>; // its twin
  life: number; // the most hours a member stays dormant; every integrated channel's span must cover it, and a state
  // read past it fails (stateOf and touch throw; evaluate counts such members and the next landing throws)
};

// The cell a place in millimetres stands in (as the spatial index files it).
export const cellAt = (x: number, y: number) => Math.min(Math.floor(y / CELL_MM), N - 1) * N + Math.min(Math.floor(x / CELL_MM), N - 1);

// The objects a saved map of ids led to, in a loaded store: the spawn still waiting in its queue, or the object by id.
function objects(store: Store, kind: string, pairs: unknown[], what: string): Map<number, Obj> {
  return new Map(pairs.map((p) => {
    const [key, id] = savedNumbers(p, what);
    return [key, store.mirror.spawned(id) ?? { id, kind, v: {}, cell: -1 }];
  }));
}

export class Dormant implements Rider {
  readonly name: string;
  readonly layout: DormantLayout;
  private forward = new Map<number, Obj>();

  constructor(readonly store: Store, readonly drivers: Drivers, readonly spec: DormantSpec) {
    for (const c of spec.channels) {
      if (drivers.span(c) < spec.life) throw new Error(`dormant ${spec.dormant}: channel ${c} stays exact for ${drivers.span(c)} hours, under its life of ${spec.life}`);
    }
    const u = (name: string, unit: string): Field => ({ name, type: "u32", unit, scale: 1 });
    const dormant: KindSpec = {
      name: spec.dormant, capacity: spec.capacity, placed: true,
      fields: [u("born", "hour"), ...spec.channels.map((c) => u(`a${c}`, `running sum of ${c} at birth`)), ...spec.attrs],
    };
    const active: KindSpec = {
      name: spec.active, capacity: spec.activeCapacity, placed: true,
      fields: [u("born", "hour"), ...spec.attrs, ...spec.state, u("oslot", `${spec.dormant} slot`), u("ogen", `${spec.dormant} generation`)],
    };
    this.layout = { kind: store.adopt(dormant), channels: spec.channels, attrs: spec.attrs, state: spec.state, body: spec.wgsl };
    store.adopt(active);
    this.name = `dormant:${spec.dormant}`;
    this.past = storage(store.g, 4);
    store.ride(this);
  }
  // ---------- riding: the count of members evaluate found past their life; saved is which dormant members became
  // which active objects ----------
  private readonly past: GPUBuffer;
  private pastSeen = 0;
  words() { return 1; }
  record(out: GPUBuffer, at: number) {
    this.store.encode((e) => e.copyBufferToBuffer(this.past, 0, out, at * 4, 4));
  }
  land(o: Uint32Array, at: number) {
    if (o[at] === this.pastSeen) return;
    const n = o[at] - this.pastSeen;
    this.pastSeen = o[at];
    throw new Error(`dormant ${this.spec.dormant}: ${n} members were evaluated past their life of ${this.spec.life} hours, where their integrals are no longer exact`);
  }
  buffers(): [string, GPUBuffer][] { return [["past", this.past]]; }
  save() { return { forward: [...this.forward].map(([from, o]) => [from, o.id]), pastSeen: this.pastSeen }; }
  restore(state: unknown, data: Record<string, Uint8Array>) {
    reload(this.store.g, this.past, data.past, `${this.name} past`);
    this.pastSeen = savedNumber(state, "pastSeen", this.name);
    this.forward = objects(this.store, this.spec.active, savedArray(state, "forward", this.name), this.name);
  }
  destroy() { this.past.destroy(); }

  // The state of a member at the newest committed hour, by the twin, from its record and its cell's sums; a member
  // past its life throws.
  stateOf(v: Record<string, number>, sums: Uint32Array, hour: number): Record<string, number> {
    const age = (hour - v.born) >>> 0;
    if (age > this.spec.life) throw new Error(`dormant ${this.spec.dormant}: a member born at hour ${v.born} is ${age} hours old at hour ${hour}, past its life of ${this.spec.life} hours`);
    const I: Record<string, number> = {}, attr: Record<string, number> = {};
    for (const c of this.spec.channels) I[c] = (sums[this.drivers.channel(c)] - v[`a${c}`]) | 0;
    for (const f of this.spec.attrs) attr[f.name] = v[f.name];
    return this.spec.ts({ born: v.born, hour, age, cell: cellAt(v.x, v.y), I, attr });
  }

  // A member laid by the CPU at the newest committed hour (its anchors from its cell's sums), or PENDING until they
  // have landed.
  lay(values: Record<string, number>): Obj | Pending {
    const sums = this.drivers.sums(cellAt(values.x, values.y));
    if (sums === PENDING) return PENDING;
    const v: Record<string, number> = { ...values, born: this.drivers.hour };
    for (const c of this.spec.channels) v[`a${c}`] = sums[this.drivers.channel(c)];
    return this.store.spawn(this.spec.dormant, v);
  }
  // Members born of a parent kind's objects on the GPU (store.births), the kind's own init placing them; their birth
  // hour and anchors are set after it.
  births(parent: string, counts: GPUBuffer, init: string) {
    this.store.births(parent, this.spec.dormant, counts, `${init}\n${dormantAnchors(this.spec.channels)}`, {
      bufs: [{ name: "drv", buf: this.drivers.ring }], wgsl: drvAccess(this.drivers.layout),
    });
  }
  // Every live member's state at the newest committed hour into out (state field f at words f C to (f + 1) C, C the
  // capacity), on the GPU.
  evaluate(out: GPUBuffer) {
    const k = this.store.kind(this.spec.dormant), C = this.spec.capacity;
    this.store.run(dormantEval(this.layout, this.drivers.layout), [k.body, k.alloc, this.drivers.ring, out, this.past], cover(this.store.g, C), [C, this.spec.life, 0, 0]);
  }

  // Touches a member: the active object it became (made now if it is still dormant), null if it is gone, or PENDING
  // (its record or its cell's sums not landed, or an hour committed since the last landing).
  touch(id: number): Obj | null | Pending {
    const done = this.forward.get(id);
    if (done) return this.store.mirror.get(done.id);
    if (this.store.kindOf(id).name !== this.spec.dormant) throw new Error(`object ${id} isn't a dormant ${this.spec.dormant}`);
    const rec = this.store.mirror.get(id);
    if (rec === PENDING || rec === null) return rec;
    const sums = this.drivers.sums(cellAt(rec.v.x, rec.v.y));
    if (sums === PENDING) { this.store.mirror.want(id); return PENDING; }
    const v: Record<string, number> = { x: rec.v.x, y: rec.v.y, born: rec.v.born, oslot: slotOfId(id), ogen: genOfId(id) };
    for (const f of this.spec.attrs) v[f.name] = rec.v[f.name];
    Object.assign(v, this.stateOf(rec.v, sums, this.drivers.hour));
    const obj = this.store.spawn(this.spec.active, v);
    this.store.kill(id);
    this.forward.set(id, obj);
    return obj;
  }
}

export type StaticSpec = {
  name: string; // the store kind members moved or taken are kept in
  capacity: number;
  counts: Uint32Array; // members in each cell
  attrs: Field[];
  seed: number;
  stream: number;
  wgsl: string; // assigns out_x, out_y (millimetres) and out_<attr> from cell, k, x0 and y0 (the cell's corner), the stream open
  ts: (cell: number, k: number) => Record<string, number>; // its twin, the stream (rand.ts) opened the same way
};
// A static member as the hash makes it, or the id of what it became once moved or taken.
export type Member = { cell: number; k: number; v: Record<string, number> } | { cell: number; k: number; moved: Obj };

export class StaticDormant implements Rider {
  readonly name: string;
  readonly counts: GPUBuffer;
  private gone = new Map<number, Obj>(); // by cell * 2^32 + k
  private goneBuf: GPUBuffer;

  constructor(readonly store: Store, readonly spec: StaticSpec) {
    if (spec.counts.length !== CELLS) throw new Error(`static ${spec.name}: counts must hold one word for each of the ${CELLS} cells`);
    store.adopt({
      name: spec.name, capacity: spec.capacity, placed: true,
      fields: [{ name: "ocell", type: "u32", unit: "cell", scale: 1 }, { name: "ok", type: "u32", unit: "member of its cell", scale: 1 }, ...spec.attrs],
    });
    this.name = `static:${spec.name}`;
    this.counts = storage(store.g, spec.counts);
    this.goneBuf = storage(store.g, 4);
    store.ride(this);
  }
  // ---------- riding: nothing is read back; saved is the sparse list of members moved and what they became ----------
  words() { return 0; }
  record() {}
  land() {}
  save() { return { gone: [...this.gone].map(([key, o]) => [key, o.id]) }; }
  restore(state: unknown) {
    this.gone = objects(this.store, this.spec.name, savedArray(state, "gone", this.name), this.name);
    this.upload();
  }
  // Members moved or taken so far.
  get moved(): number {
    return this.gone.size;
  }
  bytes(): number {
    return this.counts.size + this.goneBuf.size;
  }
  destroy() { this.counts.destroy(); this.goneBuf.destroy(); }
  // Member k of a cell, made by the twin; what it became once moved; null past the cell's count.
  member(cell: number, k: number): Member | null {
    if (k >= this.spec.counts[cell]) return null;
    const moved = this.gone.get(cell * 2 ** 32 + k);
    if (moved) return { cell, k, moved };
    rinit(this.spec.seed, this.spec.stream, k, cell);
    return { cell, k, v: this.spec.ts(cell, k) };
  }
  // The members still lying in a cell, in member order, by the twin.
  members(cell: number): { cell: number; k: number; v: Record<string, number> }[] {
    const out = [];
    for (let k = 0; k < this.spec.counts[cell]; k++) {
      const m = this.member(cell, k);
      if (m && "v" in m) out.push(m);
    }
    return out;
  }
  // Moves (or takes) a member: it is stored from now on, at the place given or where it lay.
  lift(cell: number, k: number, place?: { x: number; y: number }): Obj {
    const m = this.member(cell, k);
    if (!m || !("v" in m)) throw new Error(`static ${this.spec.name}: member ${k} of cell ${cell} isn't lying there`);
    const obj = this.store.spawn(this.spec.name, { ...m.v, ...(place ?? {}), ocell: cell, ok: k });
    this.gone.set(cell * 2 ** 32 + k, obj);
    this.upload();
    return obj;
  }
  // The sorted list of members gone, for the GPU's enumeration: always a new buffer, the old one let go after the next
  // submit, so an enumeration recorded before a lift (look, then take) still reads the list as it was, as recorded
  // kernels run in the order they were recorded and a write to the queue would run ahead of them.
  private upload() {
    const keys = [...this.gone.keys()].sort((a, b) => a - b), words = new Uint32Array(1 + 2 * keys.length);
    words[0] = keys.length;
    keys.forEach((key, i) => { words[1 + 2 * i] = Math.floor(key / 2 ** 32); words[2 + 2 * i] = key % 2 ** 32; });
    this.store.retire(this.goneBuf);
    this.goneBuf = storage(this.store.g, words);
  }
  // Every member of a cell on the GPU into out: rows of present (0 once moved), x, y and the attributes.
  enumerate(cell: number, out: GPUBuffer) {
    const src = staticMembers({ attrs: this.spec.attrs, body: this.spec.wgsl, seed: this.spec.seed, stream: this.spec.stream });
    this.store.run(src, [this.counts, this.goneBuf, out], cover(this.store.g, Math.max(1, this.spec.counts[cell])), [cell, 0, 0, 0]);
  }
}
