// The world's objects on the GPU: every kind (stems, seedlings, logs, each animal...) a structure of arrays in GPU
// buffers, indexed by slot, with deterministic births and deaths, a spatial index rebuilt every tick, a CPU mirror of
// the cells round people (mirror.ts) that CPU code changes through queued deltas, and dump and load for saves. Plan:
// docs/plans/2026-10-14-001-refactor-gpu-object-world-plan.md, Unit 4.
//
// A kind is declared with a name, a capacity and its fields, each a u32 or an i32 word holding a quantity in a stated
// unit times a stated scale (a field { unit: "m", scale: 1000 } holds millimetres). A placed kind also has x and y,
// millimetres east of the island's west edge and south of its north edge (the grid of src/terrain/grid.ts), and is
// indexed by cell. Buffers of a kind with capacity C and F fields, all u32 words:
// - body, (1 + F) C words: C slot words (bit 0 alive, bits 1 to 31 the slot's generation, 0 before its first birth),
//   then field f in words (1 + f) C to (2 + f) C.
// - alloc, 16 + C words: control words (CTL in wgsl/alloc.ts: the free list's head and length, the tail, children
//   lost for want of capacity), then the free list.
// - order (C words) and start (N^2 + 1 words), placed kinds only: the live slots sorted by cell, stable by slot, and
//   where each cell's run begins (start[N^2] is the live count). Rebuilt every tick (a still kind's only in a tick
//   that changed it); kept so a save holds every buffer.
//
// An object's id packs (kind, slot, generation) into one exact JavaScript number, kind * 2^47 + (generation mod 2^17)
// * 2^30 + slot, so a slot given to a new object never answers to an old object's id (until the same slot has been
// reborn 2^17 times). A kernel that keeps a reference keeps the slot and the generation in two fields.
//
// Births: a kernel writes each parent's child count; the counts are scanned in parent-slot order, so the j-th child of
// the tick's call takes the j-th free slot (free slots in index order) and then the tail; its slot gets the next
// generation and its fields zero, and the kind's own initialization runs with the parent and the slot. Deaths clear
// the alive bit; dead slots join the free list at one fixed point in the tick (after the laws have run), so births in
// a tick only ever take slots that were free when it began. Integer scans in a fixed order throughout, so the same ids
// come out every run on any GPU.
//
// A tick: begin(t) uploads the deltas queued since the last tick and applies them, runs the laws due, reclaims dead
// slots and rebuilds the index, all in one submit; the CPU does its own work while that runs; land() copies the
// windows round people into one staging buffer, awaits it and keeps it for the mirror. Spawns the CPU queues get their
// slots at the upload, placed from the free list's head the last landing read back, the same rule the GPU follows.
// Kernels recorded outside a tick (births, reclaim, index called directly) go to the GPU at flush().
//
// Representation tiers (src/gpu/tiers: recorded drivers, dormant, event-driven and lumped kinds) run their kernels
// through run, scan and births from inside laws, and ride the landing: a rider gets words of the tick's one staging
// copy, records its own copies into them and reads them back when the tick lands.
import type { Gpu } from "./device";
import { cover, pipeline, readback, storage } from "./kernel";
import { SCAN, SCAN_TOP } from "./wgsl/scan";
import { BIRTH_COMMIT, BIRTH_MASK, CTL, CTL_WORDS, DELTA_APPLY, type Extra, OP, PEEK, RECLAIM_CTL, RECLAIM_CTL_LIVE, RECLAIM_FLAG, RECLAIM_SCATTER, RECLAIM_SCATTER_LIVE, birthAssign } from "./wgsl/alloc";
import { CELLS, GATHER_HEAD, GATHER_ROWS, INDEX_COMPACT, INDEX_KEYS, RADIX_HIST, RADIX_SCATTER } from "./wgsl/index";
import { Mirror, type Obj } from "./mirror";

// ---------- ids ----------
const IX = 2 ** 30, GEN = 2 ** 17;
export const MAX_KINDS = 64;
export const idOf = (kind: number, slot: number, gen: number) => (kind * GEN + (gen % GEN)) * IX + slot;
export const kindOfId = (id: number) => Math.floor(id / (IX * GEN));
export const slotOfId = (id: number) => id % IX;
export const genOfId = (id: number) => Math.floor(id / IX) % GEN;

// ---------- kinds ----------
export type Field = { name: string; type: "u32" | "i32"; unit: string; scale: number };
// A still kind's slots and places change only by the CPU's deltas, by births, and by a law that marks the kind touched
// when it moves them (the animals' hourly step), so its dead slots are reclaimed and its index rebuilt only in a tick
// that had some (the index costs about 65 ms per 10^7 objects).
export type KindSpec = { name: string; capacity: number; fields: Field[]; placed?: boolean; still?: boolean };
// The two fields every placed kind starts with.
export const PLACE: readonly Field[] = [
  { name: "x", type: "u32", unit: "m", scale: 1000 },
  { name: "y", type: "u32", unit: "m", scale: 1000 },
];
// What the last landing read back of a kind's allocation: control words, the next PEEK_SLOTS free slots and their slot
// words. Fresh until a law runs births again.
export const PEEK_SLOTS = 1024;
// Words between one dispatch's params and the next in the params buffer: a uniform binding's offset is a multiple of
// 256 bytes (WebGPU's minUniformBufferOffsetAlignment by default).
const PARAM_WORDS = 64;
export type Peek = { head: number; nfree: number; tail: number; overflow: number; free: Uint32Array; meta: Uint32Array; fresh: boolean };
export type Kind = {
  n: number; name: string; capacity: number; placed: boolean; spec: KindSpec;
  fields: readonly Field[]; field: Record<string, number>; // every field, place first, and each one's number
  body: GPUBuffer; alloc: GPUBuffer; order: GPUBuffer | null; start: GPUBuffer | null;
  peek: Peek;
  touched: boolean; // a still kind changed since its index was last built
  stale: boolean; // changed on the GPU since the mirror's last landing of it (a still kind's pages are kept while not)
};

// A law: kernels run in begin when due, in the order laws were added.
export type Law = { name: string; due: (t: number) => boolean; run: (s: Store, t: number) => void };

// Something read back with every landing: it asks for so many words of the staging copy, records its copies into
// them (at word at of out) after the kinds' gathers, and reads them when the tick lands. A rider with a name is part
// of the store's state: its buffers and what save returns (JSON) go into hash and dump, and a store loaded from a
// dump hands them to restore when a rider of that name rides it again.
export type Rider = {
  words(): number; record(out: GPUBuffer, at: number): void; land(o: Uint32Array, at: number): void;
  name?: string; buffers?(): [string, GPUBuffer][]; save?(): unknown; restore?(state: unknown, data: Record<string, Uint8Array>): void;
};
// A rider's state as a dump holds it, waiting for the rider to ride the loaded store.
type Stashed = { state: unknown; data: Record<string, Uint8Array> };
// A rider's saved buffer written back into the buffer it was dumped from (made again with the same size).
export function reload(g: Gpu, buf: GPUBuffer, bytes: Uint8Array | undefined, what: string) {
  if (!bytes || bytes.byteLength !== buf.size) throw new Error(`saved ${what}: ${bytes?.byteLength ?? 0} bytes for a buffer of ${buf.size}`);
  for (let c = 0; c < bytes.byteLength; c += CHUNK) g.device.queue.writeBuffer(buf, c, bytes.buffer, bytes.byteOffset + c, Math.min(CHUNK, bytes.byteLength - c));
}
// A number or an array a rider saved, read back from its state with a check that it is there (states come from a
// dump, so from outside the program).
export function savedNumber(state: unknown, key: string, what: string): number {
  const v = state && typeof state === "object" && key in state ? Reflect.get(state, key) : undefined;
  if (typeof v !== "number") throw new Error(`saved ${what}: ${key} is not a number`);
  return v;
}
export function savedArray(state: unknown, key: string, what: string): unknown[] {
  const v = state && typeof state === "object" && key in state ? Reflect.get(state, key) : undefined;
  if (!Array.isArray(v)) throw new Error(`saved ${what}: ${key} is not a list`);
  return v;
}
export function savedNumbers(v: unknown, what: string): number[] {
  if (!Array.isArray(v) || !v.every((x) => typeof x === "number")) throw new Error(`saved ${what} is not a list of numbers`);
  return v;
}

// A change CPU code queued: applied to the mirror at once, to the GPU at the next upload.
export type Delta =
  | { seq: number; op: "set"; id: number; field: number; value: number }
  | { seq: number; op: "kill"; id: number }
  | { seq: number; op: "spawn"; obj: Obj };

const NAME = /^[a-z][a-z0-9]*$/;
const RESERVED: Record<string, true> = { alive: true, gen: true, kill: true };
const CHUNK = 64 << 20;
const MAGIC = 0x55504d4e; // "NMPU"

// The 64-bit hash state of buffers being folded, two 32-bit lanes.
type Hash = { a: number; b: number };
function fold(h: Hash, w: Uint32Array) {
  let a = h.a, b = h.b;
  for (let i = 0; i < w.length; i++) {
    const x = w[i];
    a = Math.imul(a ^ x, 0x01000193);
    b = Math.imul(b ^ ((x << 16) | (x >>> 16)), 0x85ebca77) ^ (b >>> 13);
  }
  h.a = a; h.b = b;
}

export class Store {
  readonly kinds: Kind[] = [];
  readonly laws: Law[] = [];
  readonly riders: Rider[] = [];
  readonly mirror: Mirror;
  queue: Delta[] = [];
  t = 0;
  private seq = 0;
  private prov = 0;
  private landing: Promise<void> | null = null;
  // The last tick's landing while it is still on its way: what a caller awaits before the next begin, or before
  // reading the mirror it brings.
  get arriving(): Promise<void> | null { return this.landing; }
  private begun = false;
  private budget = 1 << 16;
  private readonly scratchBufs = new Map<string, GPUBuffer>();
  private readonly stash = new Map<string, Stashed>();
  private enc: GPUCommandEncoder | null = null;
  private pass: GPUComputePassEncoder | null = null;
  // the params of the runs recorded since the last submit, PARAM_WORDS apart in one uniform buffer, written once at the
  // submit (words staged), and how many are in use
  private params: { buf: GPUBuffer; words: Uint32Array } | null = null;
  private used = 0;
  private retired: GPUBuffer[] = [];
  private readonly pipes = new Map<string, Map<string, GPUComputePipeline>>(); // by source, then entry point

  constructor(readonly g: Gpu) {
    this.mirror = new Mirror(this);
  }

  // Declares a kind; its slots start empty, never born.
  declare(spec: KindSpec): Kind {
    const fields = [...(spec.placed ? PLACE : []), ...spec.fields];
    if (this.kinds.length >= MAX_KINDS) throw new Error(`a store holds at most ${MAX_KINDS} kinds`);
    if (!NAME.test(spec.name) || this.kinds.some((k) => k.name === spec.name)) throw new Error(`kind name "${spec.name}" must be new, lower case letters and digits`);
    if (!Number.isInteger(spec.capacity) || spec.capacity < 1 || spec.capacity > IX) throw new Error(`kind ${spec.name}: capacity ${spec.capacity} must be from 1 to 2^30`);
    const names = new Set<string>();
    for (const f of fields) {
      if (!NAME.test(f.name) || RESERVED[f.name] || names.has(f.name)) throw new Error(`kind ${spec.name}: field name "${f.name}" must be new, lower case letters and digits, not alive, gen or kill`);
      if (f.type !== "u32" && f.type !== "i32") throw new Error(`kind ${spec.name}: field ${f.name} must be u32 or i32`);
      names.add(f.name);
    }
    const C = spec.capacity, bytes = (1 + fields.length) * C * 4, most = this.g.device.limits.maxStorageBufferBindingSize;
    if (bytes > most) throw new Error(`kind ${spec.name}: its body of ${bytes} bytes is past the GPU's ${most}-byte binding limit`);
    const k: Kind = {
      n: this.kinds.length, name: spec.name, capacity: C, placed: !!spec.placed, spec: structuredClone(spec),
      fields, field: Object.fromEntries(fields.map((f, i) => [f.name, i])),
      body: storage(this.g, bytes), alloc: storage(this.g, (CTL_WORDS + C) * 4),
      order: spec.placed ? storage(this.g, C * 4) : null, start: spec.placed ? storage(this.g, (CELLS + 1) * 4) : null,
      peek: { head: 0, nfree: 0, tail: 0, overflow: 0, free: new Uint32Array(0), meta: new Uint32Array(0), fresh: true },
      touched: false, // an empty index (start all zero) is the index of no objects
      stale: true,
    };
    this.kinds.push(k);
    this.mirror.add(k);
    return k;
  }
  // The first objects of a kind never born into, written straight into its buffers: n objects in slots 0 to n - 1,
  // each of generation 1, with the fields given as one column of n words each (missing ones zero). A generator's
  // initial objects go in this way, millions at once, rather than as spawns through the delta queue.
  write(kind: string, n: number, columns: Record<string, Uint32Array | Int32Array>) {
    const k = this.kind(kind);
    if (k.peek.tail || k.peek.nfree || this.queue.some((d) => d.op === "spawn" && d.obj.kind === kind)) throw new Error(`kind ${kind}: initial objects go only into a kind never born into`);
    if (!Number.isInteger(n) || n < 0 || n > k.capacity) throw new Error(`kind ${kind}: ${n} initial objects don't fit its capacity of ${k.capacity}`);
    for (const name of Object.keys(columns)) if (k.field[name] === undefined) throw new Error(`kind ${kind} has no field ${name}`);
    const q = this.g.device.queue, C = k.capacity;
    q.writeBuffer(k.body, 0, new Uint32Array(n).fill(3)); // alive, generation 1
    k.fields.forEach((f, i) => {
      const col = columns[f.name];
      if (!col) return;
      if (col.length !== n) throw new Error(`kind ${kind}: column ${f.name} holds ${col.length} words, not ${n}`);
      for (let c = 0; c < n * 4; c += CHUNK) q.writeBuffer(k.body, (1 + i) * C * 4 + c, col.buffer, col.byteOffset + c, Math.min(CHUNK, n * 4 - c));
    });
    q.writeBuffer(k.alloc, CTL.tail * 4, Uint32Array.of(n));
    k.peek = { ...k.peek, tail: n };
    k.touched = k.stale = true;
  }
  // The kind of a loaded store declared again by what uses it (a tier): the kind already there when its declaration
  // is the same, else a new one.
  adopt(spec: KindSpec): Kind {
    const k = this.kinds.find((x) => x.name === spec.name);
    if (!k) return this.declare(spec);
    if (JSON.stringify(k.spec) !== JSON.stringify(spec)) throw new Error(`kind ${spec.name} is already declared otherwise`);
    return k;
  }
  kind(name: string): Kind {
    const k = this.kinds.find((x) => x.name === name);
    if (!k) throw new Error(`no kind ${name} in the store`);
    return k;
  }
  law(l: Law) { this.laws.push(l); }
  ride(r: Rider) {
    if (r.name !== undefined && this.riders.some((x) => x.name === r.name)) throw new Error(`a rider named ${r.name} already rides this store`);
    this.riders.push(r);
    const saved = r.name === undefined ? undefined : this.stash.get(r.name);
    if (saved) { this.stash.delete(r.name!); r.restore?.(saved.state, saved.data); }
  }
  // Riders that are part of the store's state, in the order they ride.
  private saved(): Rider[] {
    return this.riders.filter((r) => r.name !== undefined);
  }

  // ---------- running kernels ----------
  // Kernels, clears and copies go into one command encoder, submitted by flush (begin and land flush; so do reads),
  // since a submit costs the CPU a few tenths of a millisecond. Each dispatch's parameters (up to 8 words) get their
  // own 32 bytes of one uniform buffer, PARAM_WORDS apart, all written by one writeBuffer at the submit (one a dispatch
  // cost the CPU a millisecond or more a day). groups is the workgroup counts, or where in a buffer made with INDIRECT
  // usage an earlier kernel wrote them.
  run(src: string, bufs: GPUBuffer[], groups: [number, number?, number?] | { buffer: GPUBuffer; offset: number }, params?: number[], entry = "main") {
    const d = this.g.device;
    let byEntry = this.pipes.get(src);
    if (!byEntry) this.pipes.set(src, (byEntry = new Map()));
    let p = byEntry.get(entry);
    if (!p) byEntry.set(entry, (p = pipeline(this.g, src, entry)));
    const entries: GPUBindGroupEntry[] = bufs.map((buffer, binding) => ({ binding, resource: { buffer } }));
    if (params) {
      if (!this.params || (this.used + 1) * PARAM_WORDS > this.params.words.length) this.moreParams();
      const at = this.used * PARAM_WORDS, P = this.params!;
      P.words.fill(0, at, at + 8);
      P.words.set(params, at);
      entries.push({ binding: bufs.length, resource: { buffer: P.buf, offset: at * 4, size: 32 } });
      this.used++;
    }
    const bind = d.createBindGroup({ layout: p.getBindGroupLayout(0), entries });
    this.pass ??= (this.enc ??= d.createCommandEncoder()).beginComputePass();
    this.pass.setPipeline(p);
    this.pass.setBindGroup(0, bind);
    if (Array.isArray(groups)) this.pass.dispatchWorkgroups(groups[0], groups[1] ?? 1, groups[2] ?? 1);
    else this.pass.dispatchWorkgroupsIndirect(groups.buffer, groups.offset);
  }
  encode(f: (e: GPUCommandEncoder) => void) {
    this.pass?.end();
    this.pass = null;
    f((this.enc ??= this.g.device.createCommandEncoder()));
  }
  // Submits what has been recorded, the runs' params written first.
  flush() {
    this.pass?.end();
    this.pass = null;
    this.writeParams();
    if (this.enc) this.g.device.queue.submit([this.enc.finish()]);
    this.enc = null;
    for (const b of this.retired) b.destroy();
    this.retired = [];
  }
  private writeParams() {
    if (this.used) this.g.device.queue.writeBuffer(this.params!.buf, 0, this.params!.words, 0, this.used * PARAM_WORDS);
    this.used = 0;
  }
  // A params buffer twice the size, the one outgrown written as it stands and let go after the next submit.
  private moreParams() {
    const old = this.params, slots = Math.max(256, old ? (2 * old.words.length) / PARAM_WORDS : 0);
    if (old) { this.writeParams(); this.retire(old.buf); }
    this.params = { buf: this.g.device.createBuffer({ size: slots * PARAM_WORDS * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }), words: new Uint32Array(slots * PARAM_WORDS) };
  }
  // Lets go of every buffer the store made (its kinds' and its scratch), once what was recorded has been submitted;
  // the store is not used after. Tiers own their buffers and let go of their own.
  destroy() {
    this.flush();
    for (const k of this.kinds) for (const [, b] of buffersOf(k)) b.destroy();
    for (const b of [...this.scratchBufs.values(), ...(this.params ? [this.params.buf] : [])]) b.destroy();
    this.params = null;
    this.scratchBufs.clear();
  }
  // A buffer replaced while commands recorded but not yet submitted may still use it: let go after the next submit.
  retire(b: GPUBuffer) { this.retired.push(b); }
  // A scratch buffer of at least so many words, kept and grown as needed (an outgrown one is let go after the next
  // submit, since recorded commands may still use it).
  scratch(name: string, words: number): GPUBuffer {
    let b = this.scratchBufs.get(name);
    if (!b || b.size < words * 4) {
      if (b) this.retire(b);
      b = storage(this.g, Math.max(words, 1) * 4);
      this.scratchBufs.set(name, b);
    }
    return b;
  }
  // An exclusive prefix sum of the first n words of buf, in place; the buffer returned holds the total at word 0. Each
  // level scans blocks of 1,024 words and keeps their totals; once the totals fit one block, each block sums those
  // before it itself (SCAN_TOP) and the levels below add theirs back.
  scan(buf: GPUBuffer, n: number): GPUBuffer {
    const levels: [GPUBuffer, number, GPUBuffer][] = [];
    let total: GPUBuffer;
    for (let cur = buf, len = n, level = 0; ; level++) {
      const blocks = Math.max(1, Math.ceil(len / 1024)), sums = this.scratch(`sum${level}`, blocks);
      this.run(SCAN, [cur, sums], cover(this.g, blocks, 1), [len, 0, 0, 0], "blocks");
      levels.push([cur, len, sums]);
      if (blocks === 1) { total = sums; break; }
      if (blocks <= 1024) {
        total = this.scratch(`total${level}`, 1);
        this.run(SCAN_TOP, [cur, sums, total], cover(this.g, blocks, 1), [len, blocks, 0, 0]);
        break;
      }
      cur = sums; len = blocks;
    }
    for (let i = levels.length - 2; i >= 0; i--) {
      const [cur, len, sums] = levels[i];
      this.run(SCAN, [cur, sums], cover(this.g, Math.ceil(len / 1024), 1), [len, 0, 0, 0], "add");
    }
    return total;
  }

  // ---------- births and deaths ----------
  // Children of the live parents of one kind into another (or the same): counts holds a u32 for every parent slot,
  // init the WGSL body run for each child, with slot, parent, k (its place among its siblings), j (its place among all
  // the call's children) and tick in scope, and the accessors parent_<field>(i), child_<field>(i) and
  // child_set_<field>(i, v) (wgsl/alloc.ts); extra binds more buffers for it to read or write. Children past the
  // child kind's capacity are not born; they count as lost (the next landing throws) unless drop is set, for a law
  // whose young past its room are simply not born.
  births(parent: string, child: string, counts: GPUBuffer, init: string, extra?: Extra, drop = false) {
    const P = this.kind(parent), C = this.kind(child), same = P === C, g = this.g;
    const m = this.scratch("m", P.capacity), kept = this.scratch("kept", P.capacity);
    this.run(BIRTH_MASK, [P.body, P.alloc, counts, m, kept], cover(g, P.capacity), [P.capacity, 0, 0, 0]);
    const tot = this.scan(m, P.capacity);
    const src = birthAssign(P, C, same, init, extra), more = extra?.bufs.map((b) => b.buf) ?? [];
    this.run(src, same ? [C.body, C.alloc, kept, m, ...more] : [P.body, C.body, C.alloc, kept, m, ...more], cover(g, P.capacity), [P.capacity, this.t, P.capacity, C.capacity]);
    this.run(BIRTH_COMMIT, [C.alloc, tot], [1], [C.capacity, drop ? 1 : 0, 0, 0]);
    C.peek.fresh = false;
    C.touched = C.stale = true;
  }
  // Children with no parent object: counts holds a u32 for each of n rows (bins of a lumped kind, requests), and the
  // children are born in row order by the same rule as births, with parent the row's number and no parent accessors;
  // drop as for births.
  bear(child: string, counts: GPUBuffer, n: number, init: string, extra?: Extra, drop = false) {
    const C = this.kind(child), m = this.scratch("m", n), g = this.g;
    this.encode((e) => e.copyBufferToBuffer(counts, 0, m, 0, n * 4));
    const tot = this.scan(m, n);
    this.run(birthAssign(null, C, false, init, extra), [C.body, C.alloc, counts, m, ...(extra?.bufs.map((b) => b.buf) ?? [])], cover(g, n), [n, this.t, 0, C.capacity]);
    this.run(BIRTH_COMMIT, [C.alloc, tot], [1], [C.capacity, drop ? 1 : 0, 0, 0]);
    C.peek.fresh = false;
    C.touched = C.stale = true;
  }
  // The fixed point where dead slots join the free list: all of them below the tail, in index order.
  reclaim(k: Kind) {
    const f = this.scratch("flag", k.capacity), g = this.g;
    this.run(RECLAIM_FLAG, [k.body, k.alloc, f], cover(g, k.capacity), [k.capacity, 0, 0, 0]);
    const tot = this.scan(f, k.capacity);
    this.run(RECLAIM_SCATTER, [k.body, k.alloc, f], cover(g, k.capacity), [k.capacity, 0, 0, 0]);
    this.run(RECLAIM_CTL, [k.alloc, tot], [1]);
  }

  // ---------- the spatial index ----------
  // With reclaim, the kind's dead slots join its free list too, from the same scan of its live flags (the same free
  // list as reclaim makes, without a scan of its own).
  index(k: Kind, reclaim = false) {
    if (!k.placed) return;
    const C = k.capacity, g = this.g, tiles = Math.ceil(C / 1024), order = k.order!, start = k.start!;
    const key = this.scratch("key", C), flag = this.scratch("flag", C), ids = this.scratch("ids", C), cells = this.scratch("cells", C);
    const len = this.scratch("len", 1), hist = this.scratch("hist", 256 * tiles);
    this.encode((e) => e.clearBuffer(start));
    this.run(INDEX_KEYS, [k.body, k.alloc, key, flag, start], cover(g, C), [C, k.field.x, k.field.y, 0]);
    const live = this.scan(flag, C);
    if (reclaim) {
      this.run(RECLAIM_SCATTER_LIVE, [k.body, k.alloc, flag], cover(g, C), [C, 0, 0, 0]);
      this.run(RECLAIM_CTL_LIVE, [k.alloc, live], [1]);
    }
    this.encode((e) => e.copyBufferToBuffer(live, 0, len, 0, 4));
    this.run(INDEX_COMPACT, [k.body, k.alloc, flag, key, ids, cells], cover(g, C), [C, 0, 0, 0]);
    // (slots, cells) from ids and cells into flag and key, and back into order and cells
    const pass = (src: GPUBuffer, kin: GPUBuffer, dst: GPUBuffer, kout: GPUBuffer, shift: number) => {
      this.run(RADIX_HIST, [kin, len, hist], cover(g, tiles, 1), [shift, tiles, 0, 0]);
      this.scan(hist, 256 * tiles);
      this.run(RADIX_SCATTER, [kin, src, len, hist, dst, kout], cover(g, tiles, 1), [shift, tiles, 0, 0]);
    };
    pass(ids, cells, flag, key, 0);
    pass(flag, key, order, cells, 8);
    const total = this.scan(start, CELLS);
    this.encode((e) => e.copyBufferToBuffer(total, 0, start, CELLS * 4, 4));
  }

  // ---------- deltas ----------
  private word(k: Kind, f: number, v: number) {
    const t = k.fields[f].type, ok = Number.isInteger(v) && (t === "u32" ? v >= 0 && v <= 0xffffffff : v >= -(2 ** 31) && v < 2 ** 31);
    if (!ok) throw new Error(`kind ${k.name}: ${v} doesn't fit field ${k.fields[f].name} (${t})`);
    return v >>> 0;
  }
  kindOf(id: number): Kind {
    const k = id < 0 ? this.mirror.spawned(id)?.kind : this.kinds[kindOfId(id)]?.name;
    if (k === undefined) throw new Error(`no kind for object ${id}`);
    return this.kind(k);
  }
  // Sets a field of an object (by id, or the provisional id of a spawn not yet uploaded).
  set(id: number, field: string, value: number) {
    const k = this.kindOf(id), f = k.field[field];
    if (f === undefined) throw new Error(`kind ${k.name} has no field ${field}`);
    this.word(k, f, value);
    this.push({ seq: this.seq++, op: "set", id, field: f, value });
  }
  kill(id: number) {
    this.kindOf(id);
    this.push({ seq: this.seq++, op: "kill", id });
  }
  // A new object of a kind with the field values given (the rest zero). Its id is provisional, below zero, until the
  // next upload gives it a slot, when the object's id becomes the real one.
  spawn(kind: string, values: Record<string, number>): Obj {
    const k = this.kind(kind), v: Record<string, number> = {};
    for (const name of Object.keys(values)) if (k.field[name] === undefined) throw new Error(`kind ${kind} has no field ${name}`);
    k.fields.forEach((f, i) => { v[f.name] = values[f.name] ?? 0; this.word(k, i, v[f.name]); });
    const obj: Obj = { id: -++this.prov, kind, v, cell: -1 };
    this.push({ seq: this.seq++, op: "spawn", obj });
    return obj;
  }
  private push(d: Delta) {
    this.queue.push(d);
    this.mirror.apply(d);
  }

  // The queue's records for the GPU, by kind, sorted by slot and then by queue order (each delta's seq, whatever
  // order the queue's array holds them in); spawns placed as the GPU places births, from the free list's head and then
  // the tail. A spawn the read-back head can't place (more spawns of a kind in one tick than PEEK_SLOTS while the free
  // list is longer) waits for the next tick, and with it every later spawn of its kind and every delta to a spawn
  // still waiting.
  private upload() {
    const recs = this.kinds.map(() => [] as { slot: number; w: number[] }[]);
    const placed = this.kinds.map(() => ({ j: 0, blocked: false }));
    const keep: Delta[] = [];
    for (const d of [...this.queue].sort((a, b) => a.seq - b.seq)) {
      if (d.op === "spawn") {
        const k = this.kind(d.obj.kind), p = k.peek, s = placed[k.n], avail = p.nfree - p.head;
        if (!p.fresh) throw new Error(`kind ${k.name}: spawns are placed from the last landing's free list, and births have run since`);
        if (s.blocked || (s.j < avail && s.j >= p.free.length)) { s.blocked = true; keep.push(d); continue; }
        let slot: number, gen: number;
        if (s.j < avail) { slot = p.free[s.j]; gen = (((p.meta[s.j] >>> 1) + 1) & 0x7fffffff) || 1; } else {
          slot = p.tail + (s.j - avail);
          if (slot >= k.capacity) throw new Error(`kind ${k.name} is full: capacity ${k.capacity}`);
          gen = 1;
        }
        s.j++;
        const old = d.obj.id;
        d.obj.id = idOf(k.n, slot, gen);
        this.mirror.placed(d.obj, old);
        recs[k.n].push({ slot, w: [slot, gen, OP.born << 16, 0] });
        k.fields.forEach((f, i) => { const v = d.obj.v[f.name]; if (v) recs[k.n].push({ slot, w: [slot, gen, (OP.set << 16) | i, v >>> 0] }); });
        continue;
      }
      const id = d.id < 0 ? this.mirror.spawned(d.id)?.id ?? d.id : d.id;
      if (id < 0) { keep.push(d); continue; }
      const k = this.kinds[kindOfId(id)], slot = slotOfId(id), gen = genOfId(id);
      recs[k.n].push({ slot, w: d.op === "set" ? [slot, gen, (OP.set << 16) | d.field, d.value >>> 0] : [slot, gen, OP.kill << 16, 0] });
    }
    this.queue = keep;
    this.mirror.uploaded();
    for (const k of this.kinds) {
      const s = placed[k.n], p = k.peek;
      if (s.j) {
        const used = Math.min(s.j, p.nfree - p.head);
        p.head += used;
        p.tail += s.j - used;
        p.free = p.free.subarray(used);
        p.meta = p.meta.subarray(used);
        this.g.device.queue.writeBuffer(k.alloc, CTL.head * 4, Uint32Array.of(p.head));
        this.g.device.queue.writeBuffer(k.alloc, CTL.tail * 4, Uint32Array.of(p.tail));
      }
    }
    // every kind's records in one buffer, each kind's sorted by slot (a stable sort, so one slot's stay in queue order)
    const all: number[] = [], from = this.kinds.map((k) => {
      const at = all.length;
      for (const r of recs[k.n].sort((a, b) => a.slot - b.slot)) all.push(...r.w);
      return at;
    });
    if (!all.length) return;
    const buf = this.scratch("deltas", all.length);
    this.g.device.queue.writeBuffer(buf, 0, Uint32Array.from(all));
    for (const k of this.kinds) {
      const n = recs[k.n].length;
      if (n) { this.run(DELTA_APPLY, [k.body, buf], cover(this.g, n), [n, k.capacity, k.fields.length, from[k.n]]); k.touched = k.stale = true; }
    }
  }

  // ---------- a tick ----------
  begin(t: number) {
    for (const _ of this.beginSteps(t));
  }
  // begin as a caller that has other work between the laws runs it (the play page's render worker draws its frames
  // there): the same work in the same order, pause awaited after the upload and after each law due.
  async beginPaced(t: number, pause: () => Promise<void>) {
    for (const _ of this.beginSteps(t)) await pause();
  }
  private *beginSteps(t: number) {
    if (this.begun || this.landing) throw new Error("a store tick begins only once the last one has landed");
    this.flush();
    this.t = t;
    this.begun = true;
    try {
      // each law's work goes to the GPU as soon as it is recorded, so the GPU runs it while the CPU works out the next
      // law's: the queue keeps the order, and no law writes a buffer (writeBuffer) an earlier law's kernels read
      this.upload();
      this.flush();
      yield;
      for (const l of this.laws) if (l.due(t)) { l.run(this, t); this.flush(); yield; }
      // a still kind untouched since its last index has no dead slot to reclaim and no object out of place; a placed
      // kind's reclaim rides its index's scan
      const due = this.kinds.filter((k) => !k.spec.still || k.touched);
      for (const k of due) if (!k.placed) this.reclaim(k);
      for (const k of due) { this.index(k, true); k.touched = false; }
    } catch (e) {
      // the failure stays with this tick: what was recorded goes out (an upload that finished has already taken its
      // deltas off the queue), and the next tick can begin
      this.begun = false;
      throw e;
    } finally {
      this.flush();
    }
  }
  // The windowed objects and each kind's allocation head copied back in one staging copy and merged into the mirror,
  // the deltas queued since the upload laid over them again. When every kind is still and unchanged since its last
  // landing, every window cell is already held and no rider reads anything, there is nothing to copy and no wait.
  land(): Promise<void> {
    if (!this.begun) throw new Error("a store tick lands only after it has begun");
    this.begun = false;
    const g = this.g;
    // a still kind the GPU hasn't changed since its last landing keeps its pages and allocation as they are, and has
    // only what its pages lack copied
    const asked = this.kinds.map((k) => this.mirror.entries(k, !!k.spec.still && !k.stale));
    const ents = asked.map((a) => a.ents), peeked = this.kinds.map((k) => !k.spec.still || k.stale), words = this.riders.map((r) => r.words());
    if (ents.every((e) => !e.length) && !peeked.some(Boolean) && words.every((n) => !n)) {
      // nothing to copy: the mirror stays as it is, and no wait on the GPU
      this.riders.forEach((r) => r.land(new Uint32Array(0), 0));
      return Promise.resolve();
    }
    let w = 1 + this.kinds.length;
    const at = this.kinds.map((k) => { const peek = w; if (peeked[k.n]) w += CTL_WORDS + 2 * PEEK_SLOTS; const head = w; w += 2 * ents[k.n].length; return { peek, head }; });
    const rat = words.map((n) => { const a = w; w += n; return a; });
    const limit = w + this.budget, out = this.scratch("out", limit), dummy = this.scratch("dummy", 1);
    const from: number[] = [], flat = new Uint32Array(ents.reduce((s, e) => { from.push(s); return s + e.length; }, 0));
    ents.forEach((e, i) => flat.set(e, from[i]));
    const eb = this.scratch("ents", flat.length);
    g.device.queue.writeBuffer(out, 0, Uint32Array.from([w, ...this.kinds.map(() => 0)]));
    g.device.queue.writeBuffer(eb, 0, flat);
    for (const k of this.kinds) {
      const e = ents[k.n], row = 2 + k.fields.length;
      if (peeked[k.n]) this.run(PEEK, [k.body, k.alloc, out], cover(g, CTL_WORDS + PEEK_SLOTS), [at[k.n].peek, PEEK_SLOTS, 0, 0]);
      if (!e.length) continue;
      this.run(GATHER_HEAD, [k.start ?? dummy, eb, out], [1], [e.length, at[k.n].head, row, limit, 1 + k.n, from[k.n], 0, 0]);
      this.run(GATHER_ROWS, [k.body, k.order ?? dummy, k.start ?? dummy, eb, out], cover(g, e.length, 1), [e.length, at[k.n].head, row, k.capacity, from[k.n], 0, 0, 0]);
    }
    this.riders.forEach((r, i) => r.record(out, rat[i]));
    this.flush();
    const back = readback(g, out, limit * 4);
    this.landing = (async () => {
      try {
        const o = new Uint32Array(await back);
        let need = 0;
        for (const k of this.kinds) {
          if (peeked[k.n]) this.peekFrom(k, o, at[k.n].peek);
          need += o[1 + k.n];
          this.mirror.land(k, ents[k.n], o, at[k.n].head, asked[k.n].keep);
          k.stale = false;
        }
        this.budget = Math.max(this.budget, Math.ceil((need * 1.25) / 4096) * 4096);
        this.riders.forEach((r, i) => r.land(o, rat[i]));
        for (const d of [...this.queue].sort((a, b) => a.seq - b.seq)) this.mirror.apply(d);
      } finally {
        this.landing = null;
      }
    })();
    return this.landing;
  }
  step(t: number) {
    this.begin(t);
    return this.land();
  }
  // A kind's allocation as words p on of a readback hold it (PEEK's layout): the next free slots the CPU places its
  // spawns from.
  private peekFrom(k: Kind, o: Uint32Array, p: number) {
    const ctl = o.subarray(p, p + CTL_WORDS), lost = ctl[CTL.overflow] - k.peek.overflow, n = Math.min(PEEK_SLOTS, ctl[CTL.nfree] - ctl[CTL.head]);
    k.peek = {
      head: ctl[CTL.head], nfree: ctl[CTL.nfree], tail: ctl[CTL.tail], overflow: ctl[CTL.overflow], fresh: true,
      free: o.slice(p + CTL_WORDS, p + CTL_WORDS + n), meta: o.slice(p + CTL_WORDS + PEEK_SLOTS, p + CTL_WORDS + PEEK_SLOTS + n),
    };
    if (lost) throw new Error(`kind ${k.name} is full: ${lost} children found no slot in its capacity of ${k.capacity}`);
  }
  // Reads back the allocation of every kind births have run on outside a tick (a world's animals born through the
  // years before anyone wakes), so spawns the CPU queues can be placed again.
  async refresh() {
    if (this.begun || this.landing) throw new Error("a store refreshes its allocations between ticks");
    const stale = this.kinds.filter((k) => !k.peek.fresh);
    if (!stale.length) return;
    const words = CTL_WORDS + 2 * PEEK_SLOTS, out = this.scratch("peek", words * stale.length);
    stale.forEach((k, i) => this.run(PEEK, [k.body, k.alloc, out], cover(this.g, CTL_WORDS + PEEK_SLOTS), [i * words, PEEK_SLOTS, 0, 0]));
    this.flush();
    const o = new Uint32Array(await readback(this.g, out, words * stale.length * 4));
    stale.forEach((k, i) => this.peekFrom(k, o, i * words));
  }

  // ---------- reading every buffer ----------
  private async *chunks(buf: GPUBuffer): AsyncGenerator<ArrayBuffer> {
    this.flush();
    for (let o = 0; o < buf.size; o += CHUNK) yield await readback(this.g, buf, Math.min(CHUNK, buf.size - o), o);
  }
  // A whole buffer of a kind read back.
  async read(kind: string, part: "body" | "alloc" | "order" | "start"): Promise<Uint32Array> {
    const buf = buffersOf(this.kind(kind)).find(([n]) => n === part)?.[1];
    if (!buf) throw new Error(`kind ${kind} has no ${part} buffer`);
    const all = new Uint8Array(buf.size);
    let o = 0;
    for await (const c of this.chunks(buf)) { all.set(new Uint8Array(c), o); o += c.byteLength; }
    return new Uint32Array(all.buffer);
  }
  // A hash of every buffer of every kind and of their declarations, and of the named riders' state and buffers, read
  // back from the GPU.
  async hash(): Promise<string> {
    if (this.landing) await this.landing;
    const h: Hash = { a: 0x811c9dc5, b: 0x2545f491 };
    fold(h, Uint32Array.from(new TextEncoder().encode(JSON.stringify(this.kinds.map((k) => k.spec)))));
    for (const k of this.kinds) for (const [, buf] of buffersOf(k)) for await (const c of this.chunks(buf)) fold(h, new Uint32Array(c));
    for (const r of this.saved()) {
      fold(h, Uint32Array.from(new TextEncoder().encode(JSON.stringify([r.name, r.save?.() ?? null]))));
      for (const [, buf] of r.buffers?.() ?? []) for await (const c of this.chunks(buf)) fold(h, new Uint32Array(c));
    }
    return (h.a >>> 0).toString(16).padStart(8, "0") + (h.b >>> 0).toString(16).padStart(8, "0");
  }

  // ---------- saving ----------
  // Every buffer of every kind, with the kinds' declarations and the deltas still queued, and every named rider's state
  // and buffers: a little-endian u32 magic ("NMPU"), a u32 format (1), a u32 header length in bytes, the header as JSON
  // padded with spaces to four bytes, then each kind's buffers in the header's order, then each rider's.
  async dump(): Promise<Uint8Array> {
    if (this.landing) await this.landing;
    if (this.begun) throw new Error("a store is saved between ticks, not inside one");
    const parts: Uint8Array[] = [];
    const kinds = [];
    for (const k of this.kinds) {
      const bufs = [];
      for (const [name, buf] of buffersOf(k)) {
        for await (const c of this.chunks(buf)) parts.push(new Uint8Array(c));
        bufs.push({ name, bytes: buf.size });
      }
      kinds.push({ spec: k.spec, buffers: bufs });
    }
    const tiers = [];
    for (const r of this.saved()) {
      const bufs = [];
      for (const [name, buf] of r.buffers?.() ?? []) {
        for await (const c of this.chunks(buf)) parts.push(new Uint8Array(c));
        bufs.push({ name, bytes: buf.size });
      }
      tiers.push({ name: r.name!, state: r.save?.() ?? null, buffers: bufs });
    }
    const queue = this.queue.map((d) => (d.op === "spawn" ? { seq: d.seq, op: d.op, obj: d.obj } : d));
    const header = { format: 1, t: this.t, seq: this.seq, prov: this.prov, budget: this.budget, kinds, queue, tiers };
    let json = JSON.stringify(header);
    json = json.padEnd(Math.ceil(json.length / 4) * 4, " ");
    const head = new TextEncoder().encode(json);
    const total = 12 + head.length + parts.reduce((s, p) => s + p.length, 0), bytes = new Uint8Array(total);
    new Uint32Array(bytes.buffer, 0, 3).set([MAGIC, 1, head.length]);
    bytes.set(head, 12);
    let o = 12 + head.length;
    for (const p of parts) { bytes.set(p, o); o += p.length; }
    return bytes;
  }
  // The counters and queued deltas of a dump (loadStore), and its riders' state kept for them.
  restore(h: SavedHeader, tiers: [string, Stashed][] = []) {
    this.t = h.t; this.seq = h.seq; this.prov = h.prov; this.budget = h.budget;
    for (const d of h.queue) this.push(d);
    for (const [name, s] of tiers) this.stash.set(name, s);
  }
}

// A kind's buffers by name, in the order a dump keeps them.
function buffersOf(k: Kind): [string, GPUBuffer][] {
  return [["body", k.body], ["alloc", k.alloc], ...(k.placed ? [["order", k.order!], ["start", k.start!]] as [string, GPUBuffer][] : [])];
}

type SavedHeader = {
  format: number; t: number; seq: number; prov: number; budget: number; kinds: { spec: KindSpec; buffers: { name: string; bytes: number }[] }[]; queue: Delta[];
  tiers?: { name: string; state: unknown; buffers: { name: string; bytes: number }[] }[];
};
// The header of a dump, read without a GPU.
export function savedHeader(bytes: Uint8Array): SavedHeader {
  const w = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 12 || w.getUint32(0, true) !== MAGIC || w.getUint32(4, true) !== 1) throw new Error("not a saved object store");
  return JSON.parse(new TextDecoder().decode(bytes.subarray(12, 12 + w.getUint32(8, true))));
}
// A store made again from a dump: the same kinds, buffers and queued deltas; an empty mirror. The riders' state waits
// for riders of the same names (each tier made again on the loaded store, with the same declaration).
export function loadStore(g: Gpu, bytes: Uint8Array): Store {
  const h = savedHeader(bytes), s = new Store(g), len = new DataView(bytes.buffer, bytes.byteOffset).getUint32(8, true);
  let o = 12 + len;
  for (const saved of h.kinds) {
    const k = s.declare(saved.spec);
    const got: Record<string, Uint8Array> = {};
    for (const b of saved.buffers) {
      const buf = buffersOf(k).find(([n]) => n === b.name)?.[1];
      if (!buf || buf.size !== b.bytes) throw new Error(`saved kind ${k.name}: buffer ${b.name} of ${b.bytes} bytes doesn't match its declaration`);
      got[b.name] = bytes.slice(o, o + b.bytes);
      for (let c = 0; c < b.bytes; c += CHUNK) g.device.queue.writeBuffer(buf, c, got[b.name].buffer, c, Math.min(CHUNK, b.bytes - c));
      o += b.bytes;
    }
    const alloc = new Uint32Array(got.alloc.buffer), body = new Uint32Array(got.body.buffer);
    const head = alloc[CTL.head], nfree = alloc[CTL.nfree], free = alloc.slice(CTL_WORDS + head, CTL_WORDS + head + Math.min(PEEK_SLOTS, nfree - head));
    k.peek = { head, nfree, tail: alloc[CTL.tail], overflow: alloc[CTL.overflow], free, meta: free.map((slot) => body[slot]), fresh: true };
  }
  const tiers: [string, Stashed][] = (h.tiers ?? []).map((t) => {
    const data: Record<string, Uint8Array> = {};
    for (const b of t.buffers) { data[b.name] = bytes.slice(o, o + b.bytes); o += b.bytes; }
    return [t.name, { state: t.state, data }];
  });
  s.restore(h, tiers);
  return s;
}
