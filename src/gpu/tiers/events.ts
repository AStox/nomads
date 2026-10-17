// Event-driven kinds: individuals stored but stepped only at their events. Plan:
// docs/plans/2026-10-14-001-refactor-gpu-object-world-plan.md, Unit 4 and Key Technical Decisions.
//
// A kind whose state changes only at events (a death, a moult) keeps in a u32 field next the tick of its next
// candidate. Its law gives the event's probability a step at a tick, K / 2^32 for a step of `step` ticks, at most
// p_max = 2^-lg (lg 8 by default, where exact geometric waits are fast: docs/research/gpu-math.md), and what the event
// does. Candidates come as a Bernoulli(p_max) process on the step grid, drawn as exact geometric waits (rand.ts
// geowait) keyed by (seed, kind stream and generation, slot, candidate tick); a candidate is kept with probability
// K / (2^32 p_max), K read at the candidate itself, so it may follow the drivers (thinning). Kept candidates are the
// events: each step brings an event with probability exactly K / 2^32, independently, as stepping the kind every step
// with Bernoulli(K / 2^32) would, and the path is a pure function of the keys, the same on every GPU.
//
// A birth at tick b sets next to UNDRAWN | b; the first wait is then drawn from b. Once a day (or over any span) run
// flags every individual with a candidate before the span's end, compacts their slots in slot order and runs the
// event kernel over them, its workgroups counted on the GPU. Hazards that read drivers are read at the candidate's
// hour, so a span is run once its hours are committed (and still in the ring). Memory an individual: its slot word and
// next, 8 bytes, plus its own fields.
import { type Rider, type Store, reload, savedNumber } from "../store";
import { cover, storage } from "../kernel";
import { EVENT_CHUNK, EVENT_COMPACT, EVENT_DUE, eventKernel } from "../wgsl/events";
import type { Drivers } from "./drivers";
import { DAY, HOUR } from "../../sim/ticks";

export { NEVER, UNDRAWN } from "../wgsl/events";

export type EventSpec = {
  kind: string; // a store kind with a u32 field next
  seed: number;
  stream: number; // below 2^15
  step?: number; // ticks a step (1)
  lg?: number; // p_max = 2^-lg (8)
  hazard: string; // WGSL body of fn hazard(slot, c) -> u32
  event: string; // WGSL body of fn event(slot, c)
  inputs?: GPUBuffer; // bound as inp
  drivers?: Drivers;
};

export class Events implements Rider {
  readonly name: string;
  readonly step: number;
  readonly lg: number;
  // Ticks before which every candidate has been run.
  end = 0;
  // From the last landing: individuals the last run took up, and hazards held to p_max so far.
  due = 0;
  overruns = 0;
  private readonly ctl: GPUBuffer;
  private readonly args: GPUBuffer;
  private readonly inp: GPUBuffer;
  private readonly src: string;

  constructor(readonly store: Store, readonly spec: EventSpec) {
    const k = store.kind(spec.kind), f = k.fields[k.field.next];
    if (!f || f.type !== "u32") throw new Error(`event-driven kind ${spec.kind} needs a u32 field next`);
    if (!(spec.stream >= 0 && spec.stream < 2 ** 15)) throw new Error(`event stream ${spec.stream} must be below 2^15`);
    this.name = `events:${spec.kind}`;
    this.step = spec.step ?? 1;
    this.lg = spec.lg ?? 8;
    if (!(this.lg >= 1 && this.lg <= 31)) throw new Error(`p_max = 2^-${this.lg} must be from 2^-1 to 2^-31`);
    this.ctl = storage(store.g, 16);
    this.args = storage(store.g, 12 * Math.ceil(k.capacity / EVENT_CHUNK), GPUBufferUsage.INDIRECT);
    this.inp = spec.inputs ?? storage(store.g, 4);
    this.src = eventKernel({ kind: k, hazard: spec.hazard, event: spec.event, drv: spec.drivers?.layout ?? null });
    store.ride(this);
  }

  destroy() { this.ctl.destroy(); this.args.destroy(); if (!this.spec.inputs) this.inp.destroy(); }
  kernelSources(): string[] { return [EVENT_DUE, EVENT_COMPACT, this.src]; }
  // ---------- saving: the control words and how far candidates have run (next is in the kind itself) ----------
  buffers(): [string, GPUBuffer][] { return [["ctl", this.ctl]]; }
  save() { return { end: this.end, due: this.due, overruns: this.overruns }; }
  restore(state: unknown, data: Record<string, Uint8Array>) {
    reload(this.store.g, this.ctl, data.ctl, this.name);
    this.end = savedNumber(state, "end", this.name);
    this.due = savedNumber(state, "due", this.name);
    this.overruns = savedNumber(state, "overruns", this.name);
  }
  // Runs every candidate before tick end (from where the last run stopped).
  run(end: number) {
    const s = this.store, k = s.kind(this.spec.kind), C = k.capacity, d = this.spec.drivers;
    if (end <= this.end) throw new Error(`events of ${k.name} have run to tick ${this.end} already`);
    if (d) {
      const last = Math.floor((end - 1) / HOUR), first = Math.floor(this.end / HOUR);
      if (last + 1 > d.hour) throw new Error(`events of ${k.name} to tick ${end} read hour ${last}, not committed yet (${d.hour})`);
      if (first < d.hour - d.spec.hours) throw new Error(`events of ${k.name} from tick ${this.end} read hour ${first}, gone from the drivers' ring`);
    }
    const at = (k.field.next + 1) * C, flag = s.scratch("evflag", C), due = s.scratch("evdue", C), chunks = Math.ceil(C / EVENT_CHUNK);
    s.run(EVENT_DUE, [k.body, k.alloc, flag], cover(s.g, C), [C, at, end, 0]);
    const tot = s.scan(flag, C);
    s.run(EVENT_COMPACT, [k.body, k.alloc, flag, tot, due, this.ctl, this.args], cover(s.g, C), [C, at, end, chunks]);
    const bufs = [k.body, k.alloc, due, this.ctl, this.inp, ...(d ? [d.ring] : [])];
    for (let c = 0; c < chunks; c++) {
      s.run(this.src, bufs, { buffer: this.args, offset: 12 * c }, [C, end, this.spec.seed >>> 0, this.spec.stream, this.step, this.lg, c * EVENT_CHUNK, 0]);
      if (chunks > 1) s.flush();
    }
    this.end = end;
  }
  // The day d: every candidate before its last tick.
  day(d: number) {
    this.run((d + 1) * DAY);
  }

  words() { return 2; }
  record(out: GPUBuffer, at: number) {
    this.store.encode((e) => e.copyBufferToBuffer(this.ctl, 0, out, at * 4, 8));
  }
  land(o: Uint32Array, at: number) {
    this.due = o[at];
    if (o[at + 1] !== this.overruns) {
      this.overruns = o[at + 1];
      throw new Error(`event-driven kind ${this.spec.kind}: ${this.overruns} hazards above p_max = 2^-${this.lg} were held to it`);
    }
  }
}
