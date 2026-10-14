// Dormant kinds in WGSL (tiers/dormant.ts drives these and describes the kinds): the evaluation of every member's
// state at the newest committed hour from its birth, its anchors and the recorded drivers of its cell; the anchors a
// birth sets; and the enumeration of a static kind's members from the hash of (seed, stream, member, cell).
import type { Field } from "../store";
import { CTL, type Layout, access } from "./alloc";
import { type DriverLayout, drvAccess } from "./drivers";
import { CELLS, CELL_MM } from "./index";
import { N } from "../../terrain/grid";
import { FIXED } from "./fixed";
import { RAND } from "./rand";

const FLAT = /* wgsl */ `
fn flat(g: vec3u, n: vec3u) -> u32 { return g.x + g.y * n.x * 256u; }`;

export type DormantLayout = { kind: Layout; channels: readonly string[]; attrs: readonly Field[]; state: readonly Field[]; body: string };

// dstate(i, hour): the state of dormant member i at the start of hour `hour`, the law's body run with born, hour, age
// (hours since birth), cell, I_<channel> (the i32 integral of each channel from its birth) and attr_<name> in scope,
// assigning out_<state field>. Needs the member's kind accessors (prefix d) and the drivers' accessors.
export function dstate(d: DormantLayout): string {
  return /* wgsl */ `
struct DState { ${d.state.map((f) => `${f.name}: ${f.type}`).join(", ")} }
fn dstate(i: u32, hour: u32) -> DState {
  let born = d_born(i);
  let age = hour - born;
  let cell = cell_of(d_x(i), d_y(i));
  ${d.channels.map((c) => `let I_${c} = bitcast<i32>(drv_sum(CH_${c.toUpperCase()}, cell, hour) - d_a${c}(i));`).join("\n  ")}
  ${d.attrs.map((f) => `let attr_${f.name} = d_${f.name}(i);`).join("\n  ")}
  ${d.state.map((f) => `var out_${f.name}: ${f.type};`).join("\n  ")}
  {
${d.body}
  }
  return DState(${d.state.map((f) => `out_${f.name}`).join(", ")});
}`;
}

// Every live member's state at the newest committed hour into out, field f at words f cap to (f + 1) cap (zeros for
// a slot with no live member). A member older than P.life hours (its integrals may have wrapped) is counted in
// past[0] and its state still written. Bindings: body, alloc, ring, out, past, P (cap, life).
export function dormantEval(d: DormantLayout, drv: DriverLayout): string {
  return /* wgsl */ `
${FIXED}
struct Params { cap: u32, life: u32, b: u32, c: u32 }
@group(0) @binding(0) var<storage, read> b: array<u32>;
@group(0) @binding(1) var<storage, read> a: array<u32>;
@group(0) @binding(2) var<storage, read> drv: array<u32>;
@group(0) @binding(3) var<storage, read_write> out: array<u32>;
@group(0) @binding(4) var<storage, read_write> past: array<atomic<u32>>;
@group(0) @binding(5) var<uniform> P: Params;
${access("d", "b", "P.cap", d.kind, false)}
${drvAccess(drv)}
${dstate(d)}
${FLAT}
@compute @workgroup_size(256) fn main(@builtin(global_invocation_id) g: vec3u, @builtin(num_workgroups) n: vec3u) {
  let i = flat(g, n);
  if (i >= P.cap) { return; }
  if (i < a[${CTL.tail}u] && d_alive(i)) {
    if (drv_hour() - d_born(i) > P.life) { atomicAdd(&past[0], 1u); }
    let s = dstate(i, drv_hour());
    ${d.state.map((f, k) => `out[${k}u * P.cap + i] = ${f.type === "i32" ? `bitcast<u32>(s.${f.name})` : `s.${f.name}`};`).join("\n    ")}
  } else {
    ${d.state.map((_, k) => `out[${k}u * P.cap + i] = 0u;`).join("\n    ")}
  }
}`;
}

// What a dormant birth adds after the kind's own initialization has placed the child: its birth hour and the running
// sum of each channel its law integrates, at the child's cell. Runs inside births with the ring bound as drv.
export function dormantAnchors(channels: readonly string[]): string {
  return /* wgsl */ `
  let dcell = cell_of(child_x(slot), child_y(slot));
  let dhour = drv_hour();
  child_set_born(slot, dhour);
  ${channels.map((c) => `child_set_a${c}(slot, drv_sum(CH_${c.toUpperCase()}, dcell, dhour));`).join("\n  ")}`;
}

export type StaticLayout = { attrs: readonly Field[]; body: string; seed: number; stream: number };

// A static kind's members of one cell: member k (k below the cell's count) is the body run on the stream of
// (seed, stream, k, cell), assigning out_x and out_y (millimetres) and out_<attr>; rows of 1 + 2 + attrs words from
// word 0 of out: present (0 for a member moved or taken), x, y, then each attribute. A member is gone when (cell, k) is
// in the sorted list gone (gone[0] the count, then pairs cell, k). Bindings: counts, gone, out, P (cell).
export function staticMembers(s: StaticLayout): string {
  const row = 3 + s.attrs.length;
  return /* wgsl */ `
${FIXED}
${RAND}
struct Params { cell: u32, a: u32, b: u32, c: u32 }
@group(0) @binding(0) var<storage, read> counts: array<u32>;
@group(0) @binding(1) var<storage, read> gone: array<u32>;
@group(0) @binding(2) var<storage, read_write> out: array<u32>;
@group(0) @binding(3) var<uniform> P: Params;
${FLAT}
fn isGone(cell: u32, k: u32) -> bool {
  var lo = 0u; var hi = gone[0];
  loop {
    if (lo >= hi) { return false; }
    let m = (lo + hi) / 2u; let c = gone[1u + 2u * m]; let j = gone[2u + 2u * m];
    if (c == cell && j == k) { return true; }
    if (c < cell || (c == cell && j < k)) { lo = m + 1u; } else { hi = m; }
  }
}
struct Member { x: u32, y: u32, ${s.attrs.map((f) => `${f.name}: ${f.type}`).join(", ")} }
fn member(cell: u32, k: u32) -> Member {
  rinit(${s.seed >>> 0}u, ${s.stream >>> 0}u, k, cell);
  let cx = cell % ${N}u; let cy = cell / ${N}u; let x0 = cx * ${CELL_MM}u; let y0 = cy * ${CELL_MM}u;
  var out_x: u32; var out_y: u32;
  ${s.attrs.map((f) => `var out_${f.name}: ${f.type};`).join("\n  ")}
  {
${s.body}
  }
  return Member(out_x, out_y, ${s.attrs.map((f) => `out_${f.name}`).join(", ")});
}
@compute @workgroup_size(256) fn main(@builtin(global_invocation_id) g: vec3u, @builtin(num_workgroups) n: vec3u) {
  let k = flat(g, n);
  if (P.cell >= ${CELLS}u || k >= counts[P.cell]) { return; }
  let m = member(P.cell, k);
  let o = k * ${row}u;
  out[o] = select(1u, 0u, isGone(P.cell, k));
  out[o + 1u] = m.x;
  out[o + 2u] = m.y;
  ${s.attrs.map((f, i) => `out[o + ${3 + i}u] = ${f.type === "i32" ? `bitcast<u32>(m.${f.name})` : `m.${f.name}`};`).join("\n  ")}
}`;
}
