// Recorded drivers in WGSL (tiers/drivers.ts drives them and describes the buffers): the kernel that runs a writer's
// body over every cell, the hourly commit of the current values into the running sums, the gather of a few cells'
// sums for the landing, and the accessors other kernels use to read sums, hourly values and integrals.
import { CELL_MM, CELLS } from "./index";
import { N } from "../../terrain/grid";
import { FIXED } from "./fixed";
import { RAND } from "./rand";

const FLAT = /* wgsl */ `
fn flat(g: vec3u, n: vec3u) -> u32 { return g.x + g.y * n.x * 256u; }`;

export type DriverLayout = { channels: readonly string[]; ring: number };

// Constants and accessors for a kernel that binds a drivers' ring as `drv` (read): CH_<NAME> for each channel's
// number, drv_hour() the hours committed, drv_sum(c, cell, h) the running sum at the start of hour h (h from
// drv_hour() - ring + 1 to drv_hour()), drv_at(c, cell, h) the value of hour h, drv_int(c, cell, h0, h1) the integral
// over hours h0 to h1 - 1, and cell_of(x, y) the cell of a place in millimetres.
export function drvAccess(d: DriverLayout): string {
  return /* wgsl */ `
${d.channels.map((c, i) => `const CH_${c.toUpperCase()} = ${i}u;`).join("\n")}
const DRV_R = ${d.ring}u;
fn drv_hour() -> u32 { return drv[${d.channels.length * d.ring * CELLS}u]; }
fn drv_sum(c: u32, cell: u32, h: u32) -> u32 { return drv[(c * DRV_R + h % DRV_R) * ${CELLS}u + cell]; }
fn drv_int(c: u32, cell: u32, h0: u32, h1: u32) -> i32 { return bitcast<i32>(drv_sum(c, cell, h1) - drv_sum(c, cell, h0)); }
fn drv_at(c: u32, cell: u32, h: u32) -> i32 { return drv_int(c, cell, h, h + 1u); }
fn cell_of(x: u32, y: u32) -> u32 { return min(y / ${CELL_MM}u, ${N - 1}u) * ${N}u + min(x / ${CELL_MM}u, ${N - 1}u); }`;
}

// A writer: body runs once for each cell with cell, hour (the hour being written, drv_hour() before the commit) and
// the inputs in0, in1... (read-only u32 arrays) in scope, and sets the hour's values by set_<channel>(cell, v: i32);
// FIXED and RAND are in scope, and the ring for reading earlier hours. Bindings: cur, ring, inputs, P (hour).
export function driverRecord(d: DriverLayout, inputs: number, body: string): string {
  return /* wgsl */ `
${FIXED}
${RAND}
struct Params { hour: u32, a: u32, b: u32, c: u32 }
@group(0) @binding(0) var<storage, read_write> cur: array<i32>;
@group(0) @binding(1) var<storage, read> drv: array<u32>;
${Array.from({ length: inputs }, (_, i) => `@group(0) @binding(${2 + i}) var<storage, read> in${i}: array<u32>;`).join("\n")}
@group(0) @binding(${2 + inputs}) var<uniform> P: Params;
${drvAccess(d)}
${d.channels.map((c, i) => `fn set_${c}(cell: u32, v: i32) { cur[${i * CELLS}u + cell] = v; }`).join("\n")}
${FLAT}
fn write(cell: u32, hour: u32) {
${body}
}
@compute @workgroup_size(256) fn main(@builtin(global_invocation_id) g: vec3u, @builtin(num_workgroups) n: vec3u) {
  let cell = flat(g, n);
  if (cell >= ${CELLS}u) { return; }
  ${Array.from({ length: inputs }, (_, i) => `_ = &in${i};`).join(" ")}
  _ = drv_hour();
  write(cell, P.hour);
}`;
}

// The commit of hour h: every channel's running sum at the start of hour h + 1 is its sum at the start of hour h plus
// the hour's value, in wrapping u32 arithmetic; the last invocation moves the hour word on. Bindings: cur, ring, P (h).
export function driverAdvance(d: DriverLayout): string {
  const C = d.channels.length;
  return /* wgsl */ `
struct Params { h: u32, a: u32, b: u32, c: u32 }
@group(0) @binding(0) var<storage, read> cur: array<u32>;
@group(0) @binding(1) var<storage, read_write> drv: array<u32>;
@group(0) @binding(2) var<uniform> P: Params;
${FLAT}
@compute @workgroup_size(256) fn main(@builtin(global_invocation_id) g: vec3u, @builtin(num_workgroups) n: vec3u) {
  let i = flat(g, n);
  if (i >= ${C * CELLS}u) { return; }
  let c = i / ${CELLS}u; let cell = i % ${CELLS}u;
  let was = (c * ${d.ring}u + P.h % ${d.ring}u) * ${CELLS}u + cell;
  let now = (c * ${d.ring}u + (P.h + 1u) % ${d.ring}u) * ${CELLS}u + cell;
  drv[now] = drv[was] + cur[i];
  if (i == 0u) { drv[${C * d.ring * CELLS}u] = P.h + 1u; }
}`;
}

// The landing's copy: the newest running sums of every channel for each cell asked for, C words a cell from word
// P.at of out. Bindings: ring, cells, out, P (n cells, at).
export function driverGather(d: DriverLayout): string {
  const C = d.channels.length;
  return /* wgsl */ `
struct Params { n: u32, at: u32, a: u32, b: u32 }
@group(0) @binding(0) var<storage, read> drv: array<u32>;
@group(0) @binding(1) var<storage, read> cells: array<u32>;
@group(0) @binding(2) var<storage, read_write> out: array<u32>;
@group(0) @binding(3) var<uniform> P: Params;
${drvAccess(d)}
${FLAT}
@compute @workgroup_size(256) fn main(@builtin(global_invocation_id) g: vec3u, @builtin(num_workgroups) n: vec3u) {
  let e = flat(g, n);
  if (e >= P.n) { return; }
  let h = drv_hour();
  for (var c = 0u; c < ${C}u; c++) { out[P.at + e * ${C}u + c] = drv_sum(c, cells[e], h); }
}`;
}
