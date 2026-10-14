// Event-driven kinds in WGSL (tiers/events.ts drives these and describes the rule): the scan flagging the individuals
// with a candidate before the end of the span, the compaction of their slots, the workgroup counts of the event
// kernel written on the GPU, and the event kernel itself, which walks each due individual's candidates.
import { CTL, type Layout, access } from "./alloc";
import { type DriverLayout, drvAccess } from "./drivers";
import { FIXED } from "./fixed";
import { RAND } from "./rand";

const FLAT = /* wgsl */ `
fn flat(g: vec3u, n: vec3u) -> u32 { return g.x + g.y * n.x * 256u; }`;

// The top bit of next marks a wait not yet drawn: the low 31 bits are then the tick it is drawn from (a birth).
export const UNDRAWN = 0x80000000;
// Past every tick: an individual whose next is this has no candidate left.
export const NEVER = 0x7fffffff;
// Invocations to a workgroup of the event kernel, and individuals to a chunk: the kernel runs a chunk at a time, each
// its own submit, so no command buffer runs long enough for the GPU's watchdog (a first day drawing 10^8 waits does).
export const EVENT_WG = 64;
export const EVENT_CHUNK = 1 << 21;

// 1 for every live slot below the tail whose next candidate (or undrawn wait) falls before tick P.end. Bindings:
// body, alloc, flags, P (cap, the next field's word offset, end).
export const EVENT_DUE = /* wgsl */ `
struct Params { cap: u32, at: u32, end: u32, c: u32 }
@group(0) @binding(0) var<storage, read> b: array<u32>;
@group(0) @binding(1) var<storage, read> a: array<u32>;
@group(0) @binding(2) var<storage, read_write> flag: array<u32>;
@group(0) @binding(3) var<uniform> P: Params;
${FLAT}
@compute @workgroup_size(256) fn main(@builtin(global_invocation_id) g: vec3u, @builtin(num_workgroups) n: vec3u) {
  let i = flat(g, n);
  if (i >= P.cap) { return; }
  var due = 0u;
  if (i < a[${CTL.tail}u] && (b[i] & 1u) == 1u) {
    let nx = b[P.at + i];
    if ((nx & ${UNDRAWN}u) != 0u || nx < P.end) { due = 1u; }
  }
  flag[i] = due;
}`;

// The due slots in slot order at their places in the scanned flags; the first invocation copies the total and writes
// the event kernel's workgroup counts for each of the P.c chunks (0 for a chunk past the total). Bindings: body,
// alloc, scanned flags, total, due, ctl (total, overruns), args, P (cap, next field offset, end, chunks).
export const EVENT_COMPACT = /* wgsl */ `
struct Params { cap: u32, at: u32, end: u32, c: u32 }
@group(0) @binding(0) var<storage, read> b: array<u32>;
@group(0) @binding(1) var<storage, read> a: array<u32>;
@group(0) @binding(2) var<storage, read> flag: array<u32>;
@group(0) @binding(3) var<storage, read> tot: array<u32>;
@group(0) @binding(4) var<storage, read_write> due: array<u32>;
@group(0) @binding(5) var<storage, read_write> ctl: array<u32>;
@group(0) @binding(6) var<storage, read_write> args: array<u32>;
@group(0) @binding(7) var<uniform> P: Params;
${FLAT}
@compute @workgroup_size(256) fn main(@builtin(global_invocation_id) g: vec3u, @builtin(num_workgroups) n: vec3u) {
  let i = flat(g, n);
  if (i == 0u) {
    let t = tot[0];
    ctl[0] = t;
    for (var c = 0u; c < P.c; c++) {
      let left = t - min(t, c * ${EVENT_CHUNK}u);
      args[3u * c] = (min(left, ${EVENT_CHUNK}u) + ${EVENT_WG - 1}u) / ${EVENT_WG}u;
      args[3u * c + 1u] = 1u;
      args[3u * c + 2u] = 1u;
    }
  }
  if (i >= P.cap) { return; }
  if (i < a[${CTL.tail}u] && (b[i] & 1u) == 1u) {
    let nx = b[P.at + i];
    if ((nx & ${UNDRAWN}u) != 0u || nx < P.end) { due[flag[i]] = i; }
  }
}`;

export type EventLayout = { kind: Layout; hazard: string; event: string; drv: DriverLayout | null };

// The event kernel: for each due slot, every candidate before P.end in turn. At candidate c the individual's stream
// is opened at (seed, stream << 17 | generation, slot, c): its first word u accepts the candidate with probability
// K / 2^(32 - P.lg) (K the hazard at c, K / 2^32 its probability a step, at most p_max = 2^-P.lg), so (u >> lg) < K;
// an accepted candidate runs the event; then the next candidate is P.step (1 + geowait(p_max)) ticks on. An undrawn
// wait from tick b draws its first wait the same way on the stream of b. hazard and event are the kind's WGSL bodies
// (functions of slot and c, with the kind's accessors self_<field>, self_set_<field>, self_kill, the input buffer inp,
// FIXED, RAND and the drivers' accessors in scope); a hazard over p_max is held to it and counted in ctl[1].
// Bindings: body, alloc, due, ctl, inp, ring (when the kind reads drivers), P (base: the chunk's first due place).
export function eventKernel(e: EventLayout): string {
  return /* wgsl */ `
${FIXED}
${RAND}
struct Params { cap: u32, end: u32, seed: u32, stream: u32, step: u32, lg: u32, base: u32, b: u32 }
@group(0) @binding(0) var<storage, read_write> b: array<u32>;
@group(0) @binding(1) var<storage, read> a: array<u32>;
@group(0) @binding(2) var<storage, read> due: array<u32>;
@group(0) @binding(3) var<storage, read_write> ctl: array<atomic<u32>>;
@group(0) @binding(4) var<storage, read> inp: array<u32>;
${e.drv ? "@group(0) @binding(5) var<storage, read> drv: array<u32>;\n@group(0) @binding(6) var<uniform> P: Params;" : "@group(0) @binding(5) var<uniform> P: Params;"}
${access("self", "b", "P.cap", e.kind, true)}
${e.drv ? drvAccess(e.drv) : ""}
fn hazard(slot: u32, c: u32) -> u32 {
${e.hazard}
}
fn event(slot: u32, c: u32) {
${e.event}
}
// The tick a wait of w steps after candidate c puts the next candidate at, or NEVER past the 31-bit range.
fn later(c: u32, w: u32) -> u32 {
  if (w >= (${NEVER}u - c) / P.step) { return ${NEVER}u; }
  return c + P.step * (w + 1u);
}
@compute @workgroup_size(${EVENT_WG}) fn main(@builtin(global_invocation_id) g: vec3u) {
  let j = P.base + g.x;
  if (j >= atomicLoad(&ctl[0])) { return; }
  _ = &inp; _ = &a;
  ${e.drv ? "_ = drv_hour();" : ""}
  let slot = due[j];
  let key = (P.stream << 17u) | (self_gen(slot) & 0x1ffffu);
  let pmax = 1u << (32u - P.lg);
  var nx = self_next(slot);
  if ((nx & ${UNDRAWN}u) != 0u) {
    let born = nx & ${NEVER}u;
    rinit(P.seed, key, slot, born);
    let w = geowait(pmax);
    nx = later(born, w);
  }
  loop {
    if (nx >= P.end) { break; }
    let c = nx;
    rinit(P.seed, key, slot, c);
    let u = next32();
    var K = hazard(slot, c);
    if (K > pmax) { K = pmax; atomicAdd(&ctl[1], 1u); }
    if ((u >> P.lg) < K) {
      event(slot, c);
      if (!self_alive(slot)) { nx = ${NEVER}u; break; }
    }
    let w = geowait(pmax);
    nx = later(c, w);
  }
  self_set_next(slot, nx);
}`;
}
