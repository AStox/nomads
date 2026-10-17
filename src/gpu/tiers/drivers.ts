// Recorded drivers: per-cell histories of what the world's laws read (air temperature, rain, canopy over a cell...),
// written by kernels in fixed point and kept as exact running sums, so a law that depends on accumulated drivers
// (degree-hours, wet-hours) evaluates its integral between any two hours in O(1). Dormant kinds (dormant.ts) read
// them to compute an object's state from its birth; event-driven kinds (events.ts) read the hazards' drivers at a
// candidate tick. Plan: docs/plans/2026-10-14-001-refactor-gpu-object-world-plan.md, Unit 4.
//
// A channel holds one i32 a cell an hour, a quantity in a stated unit times a stated scale, at most `bound` in size.
// Buffers, all u32 words:
// - cur, C x CELLS: the hour being written, channel-major. Writers set it (write); a value written once a day holds
//   for every hour until it is written again.
// - ring, C x R x CELLS + 1, R = hours + 1: S_c(h), the sum of channel c over hours 0 to h - 1, at the start of each of
//   the last R hours (h mod R), then the hour word: the hours committed so far, H. advance() commits hour H.
// Sums wrap modulo 2^32, so an integral S_c(h1) - S_c(h0), read as an i32, is exact whenever the true integral is
// under 2^31 in size: over any span of up to span(c) = floor((2^31 - 1) / bound) hours. That is the documented fold:
// hours older than the ring live on only in the running sums, which is all an integral from a stored anchor needs.
// An object that integrates from its birth keeps S_c at its birth (an anchor, dormant.ts) and reads S_c(H) - anchor;
// hourly values and integrals between hours inside the ring come straight from it.
//
// The CPU sees the newest sums of the cells it asks for (sums), copied back with each landing.
import { type Rider, type Store, reload, savedNumber } from "../store";
import { cover, storage } from "../kernel";
import { CELLS } from "../wgsl/index";
import { PENDING, type Pending } from "../mirror";
import { type DriverLayout, driverAdvance, driverGather, driverRecord } from "../wgsl/drivers";

export type Channel = { name: string; unit: string; scale: number; bound: number };
// name tells one history apart from another riding the same store (its state is saved under it); "drivers" if none.
export type DriversSpec = { channels: Channel[]; hours: number; name?: string };

const NAME = /^[a-z][a-z0-9]*$/;

export class Drivers implements Rider {
  readonly name: string;
  readonly layout: DriverLayout;
  readonly cur: GPUBuffer;
  readonly ring: GPUBuffer;
  // Hours committed on the GPU as recorded so far (the hour word once the recorded kernels have run).
  hour = 0;
  // The hour of the sums the last landing brought back, and those sums by cell.
  landedHour = -1;
  private landed = new Map<number, Uint32Array>();
  private asked = new Set<number>();
  private writers = new Map<string, string>(); // writers' sources by inputs and body, made once
  private sent: number[] = [];

  constructor(readonly store: Store, readonly spec: DriversSpec) {
    const names = new Set<string>();
    for (const c of spec.channels) {
      if (!NAME.test(c.name) || names.has(c.name)) throw new Error(`driver channel "${c.name}" must be new, lower case letters and digits`);
      if (!(c.bound >= 1 && c.bound < 2 ** 31)) throw new Error(`driver channel ${c.name}: bound ${c.bound} must be from 1 to 2^31 - 1`);
      names.add(c.name);
    }
    if (!Number.isInteger(spec.hours) || spec.hours < 1) throw new Error(`a drivers history holds at least one hour, not ${spec.hours}`);
    const C = spec.channels.length, R = spec.hours + 1;
    this.name = spec.name ?? "drivers";
    this.layout = { channels: spec.channels.map((c) => c.name), ring: R };
    this.cur = storage(store.g, C * CELLS * 4);
    this.ring = storage(store.g, (C * R * CELLS + 1) * 4);
    store.ride(this);
  }
  channel(name: string): number {
    const i = this.layout.channels.indexOf(name);
    if (i < 0) throw new Error(`no driver channel ${name}`);
    return i;
  }
  // The longest span of hours over which an integral of a channel is exact.
  span(name: string): number {
    return Math.floor((2 ** 31 - 1) / this.spec.channels[this.channel(name)].bound);
  }
  destroy() { this.cur.destroy(); this.ring.destroy(); }
  // ---------- saving: the current values, the ring and its hour word, and the hours recorded ----------
  buffers(): [string, GPUBuffer][] { return [["cur", this.cur], ["ring", this.ring]]; }
  save() { return { hour: this.hour }; }
  restore(state: unknown, data: Record<string, Uint8Array>) {
    reload(this.store.g, this.cur, data.cur, `drivers ${this.name} cur`);
    reload(this.store.g, this.ring, data.ring, `drivers ${this.name} ring`);
    this.hour = savedNumber(state, "hour", `drivers ${this.name}`);
  }
  bytes(): number {
    return this.cur.size + this.ring.size;
  }

  // ---------- writing ----------
  // Runs a writer over every cell for the hour about to be committed (wgsl/drivers.ts driverRecord), with the
  // buffers given bound as in0, in1...
  write(body: string, inputs: GPUBuffer[] = []) {
    this.store.run(this.writer(body, inputs.length), [this.cur, this.ring, ...inputs], cover(this.store.g, CELLS), [this.hour, 0, 0, 0]);
  }
  // The source of a writer with body over n inputs, made once.
  writer(body: string, n: number): string {
    const key = `${n}:${body}`;
    let src = this.writers.get(key);
    if (src === undefined) this.writers.set(key, (src = driverRecord(this.layout, n, body)));
    return src;
  }
  kernelSources(): string[] {
    return [...this.writers.values(), driverAdvance(this.layout), driverGather(this.layout)];
  }
  // Commits the current values as hour `hour`.
  advance() {
    const C = this.layout.channels.length;
    this.store.run(driverAdvance(this.layout), [this.cur, this.ring], cover(this.store.g, C * CELLS), [this.hour, 0, 0, 0]);
    this.hour++;
  }

  // ---------- reading on the CPU ----------
  // S_c at the start of the newest hour committed, for every channel, of a cell: from the last landing while no hour
  // has been committed since, and before the first commit all zeros; otherwise PENDING, asked for in the next landing.
  sums(cell: number): Uint32Array | Pending {
    if (this.hour === 0) return new Uint32Array(this.layout.channels.length);
    this.asked.add(cell);
    const got = this.landed.get(cell);
    return got && this.landedHour === this.hour ? got : PENDING;
  }

  // ---------- riding the landing ----------
  words() {
    this.sent = [...this.asked].sort((a, b) => a - b);
    this.sentHour = this.hour;
    this.asked.clear();
    return this.sent.length * this.layout.channels.length;
  }
  record(out: GPUBuffer, at: number) {
    const n = this.sent.length;
    if (!n) return;
    const cells = this.store.scratch(`drvcells:${this.name}`, n);
    this.store.g.device.queue.writeBuffer(cells, 0, Uint32Array.from(this.sent));
    this.store.run(driverGather(this.layout), [this.ring, cells, out], cover(this.store.g, n), [n, at, 0, 0]);
  }
  land(o: Uint32Array, at: number) {
    const C = this.layout.channels.length;
    this.landed = new Map(this.sent.map((c, e) => [c, o.slice(at + e * C, at + (e + 1) * C)]));
    this.landedHour = this.sentHour;
  }
  private sentHour = -1;
}
