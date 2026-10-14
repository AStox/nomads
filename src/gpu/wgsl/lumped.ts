// Lumped kinds in WGSL (tiers/lumped.ts drives these and describes the bins, the step and identity). A bin table is
// four runs of `cap` words: key (cell << 16 | state), e (the step its members entered), tt (the members that entered,
// T, with bit 31 set while the bin is held as individuals) and out (members gone, which took ranks 0 to out - 1). ctl
// words: 0 bins, 1 contributions this step, 2 bins kept, 3 bins new, 4 bins lost for want of room (so far), 5
// contributions lost (so far).
import { CTL } from "./alloc";
import { CELL_MM } from "./index";
import { N } from "../../terrain/grid";
import { FIXED } from "./fixed";
import { RAND } from "./rand";

export const DENSE = 0x80000000;
export const DEATH = 0xffffffff;
export const NONE = 0xffffffff;
// Outcomes a law may have.
export const OUTCOMES = 16;

const FLAT = /* wgsl */ `
fn flat(g: vec3u, n: vec3u) -> u32 { return g.x + g.y * n.x * 256u; }`;

export type LumpedLayout = { seed: number; law: string };

// Bin rows of a table bound as `name` with capacity P.cap.
const rows = (name: string) => /* wgsl */ `
fn ${name}_key(i: u32) -> u32 { return ${name}[i]; }
fn ${name}_e(i: u32) -> u32 { return ${name}[P.cap + i]; }
fn ${name}_tt(i: u32) -> u32 { return ${name}[2u * P.cap + i]; }
fn ${name}_out(i: u32) -> u32 { return ${name}[3u * P.cap + i]; }`;

// What every lumped kernel that draws or names members needs: the law, a member's identity (its rank put through
// the bin's Feistel permutation of [0, T)) and its place in its cell.
export function lumpedCore(l: LumpedLayout): string {
  return /* wgsl */ `
${FIXED}
${RAND}
const LSEED = ${l.seed >>> 0}u;
const DEATH = ${DEATH}u;
struct Split { m: u32, t: array<u32, 15>, s: array<u32, 16> }
${l.law}
fn lsigma(key: u32, e: u32, T: u32, rank: u32) -> u32 { return feistel(rank, T, fkeys(LSEED, e, key, 0u)); }
fn lplace(key: u32, e: u32, sigma: u32) -> vec2u {
  let h = philox(vec4u(key, sigma, e, 0xfffffffeu), vec2u(LSEED, 0x80000000u));
  let cell = key >> 16u;
  return vec2u((cell % ${N}u) * ${CELL_MM}u + h.x % ${CELL_MM}u, (cell / ${N}u) * ${CELL_MM}u + h.y % ${CELL_MM}u);
}`;
}

// Promotions, per bin: each request (key, e, count) naming the bin takes its next ranks, at most what it holds.
// took[r] gets the members taken, info[2r] the first rank taken and info[2r + 1] the bin. Bindings: bins, ctl, req
// (count, then key, e, count each), took, info, P (cap).
export const LUMP_PROMOTE = /* wgsl */ `
struct Params { cap: u32, a: u32, b: u32, c: u32 }
@group(0) @binding(0) var<storage, read_write> bins: array<u32>;
@group(0) @binding(1) var<storage, read> ctl: array<u32>;
@group(0) @binding(2) var<storage, read> req: array<u32>;
@group(0) @binding(3) var<storage, read_write> took: array<u32>;
@group(0) @binding(4) var<storage, read_write> info: array<u32>;
@group(0) @binding(5) var<uniform> P: Params;
${rows("bins")}
${FLAT}
@compute @workgroup_size(256) fn main(@builtin(global_invocation_id) g: vec3u, @builtin(num_workgroups) n: vec3u) {
  let i = flat(g, n);
  if (i >= ctl[0]) { return; }
  let key = bins_key(i); let e = bins_e(i); let T = bins_tt(i) & ${~DENSE >>> 0}u;
  var out = bins_out(i);
  for (var r = 0u; r < req[0]; r++) {
    if (req[1u + 3u * r] != key || req[2u + 3u * r] != e) { continue; }
    let take = min(req[3u + 3u * r], T - out);
    took[r] = take; info[2u * r] = out; info[2u * r + 1u] = i;
    out += take;
  }
  bins[3u * P.cap + i] = out;
}`;

// The split, per bin: the law's outcome intervals for the bin's state, the multinomial of its members over them on
// the stream of (seed, e, key, t); departures (outcomes to another state or death) take the next ranks in outcome
// order; cnt gets every outcome's count, nc the contributions to other states, keep 1 while members are left.
// Bindings: bins, ctl, cnt, nc, keep, inp, P (cap, t).
export function lumpSplit(l: LumpedLayout): string {
  return /* wgsl */ `
${lumpedCore(l)}
struct Params { cap: u32, t: u32, a: u32, b: u32 }
@group(0) @binding(0) var<storage, read_write> bins: array<u32>;
@group(0) @binding(1) var<storage, read> ctl: array<u32>;
@group(0) @binding(2) var<storage, read_write> cnt: array<u32>;
@group(0) @binding(3) var<storage, read_write> nc: array<u32>;
@group(0) @binding(4) var<storage, read_write> keep: array<u32>;
@group(0) @binding(5) var<storage, read> inp: array<u32>;
@group(0) @binding(6) var<uniform> P: Params;
${rows("bins")}
${FLAT}
@compute @workgroup_size(256) fn main(@builtin(global_invocation_id) g: vec3u, @builtin(num_workgroups) n: vec3u) {
  let i = flat(g, n);
  if (i >= P.cap) { return; }
  _ = &inp;
  nc[i] = 0u; keep[i] = 0u;
  if (i >= ctl[0]) { return; }
  let key = bins_key(i); let e = bins_e(i); let T = bins_tt(i) & ${~DENSE >>> 0}u; let out = bins_out(i);
  if (T == out) { return; }
  let state = key & 0xffffu;
  let sp = law(key >> 16u, state, P.t);
  rinit(LSEED, e, key, P.t);
  let c = multinom(T - out, sp.t, sp.m);
  var dep = 0u; var k = 0u;
  for (var j = 0u; j <= sp.m; j++) {
    cnt[i * ${OUTCOMES}u + j] = c[j];
    if (sp.s[j] != state) { dep += c[j]; if (sp.s[j] != DEATH && c[j] > 0u) { k++; } }
  }
  bins[3u * P.cap + i] = out + dep;
  nc[i] = k;
  keep[i] = select(0u, 1u, out + dep < T);
}`;
}

// The contributions, per bin at its offset in the scanned nc: (key of the state reached, count) for each outcome to
// another state; then the births (key, count) after them all; len the count (capped at P.ccap, the rest counted
// lost). ck holds the keys in words 0 to ccap - 1, the counts in words ccap to 2 ccap - 1, and the births as written
// by the CPU from word 2 ccap. Bindings: bins, ctl, ofs (scanned nc), tot, cnt, ck, len, inp, P (cap, t, nb, ccap).
export function lumpEmit(l: LumpedLayout): string {
  return /* wgsl */ `
${lumpedCore(l)}
struct Params { cap: u32, t: u32, nb: u32, ccap: u32 }
@group(0) @binding(0) var<storage, read> bins: array<u32>;
@group(0) @binding(1) var<storage, read_write> ctl: array<u32>;
@group(0) @binding(2) var<storage, read> ofs: array<u32>;
@group(0) @binding(3) var<storage, read> tot: array<u32>;
@group(0) @binding(4) var<storage, read> cnt: array<u32>;
@group(0) @binding(5) var<storage, read_write> ck: array<u32>;
@group(0) @binding(6) var<storage, read_write> len: array<u32>;
@group(0) @binding(7) var<storage, read> inp: array<u32>;
@group(0) @binding(8) var<uniform> P: Params;
${rows("bins")}
${FLAT}
fn put(at: u32, key: u32, c: u32) { if (at < P.ccap) { ck[at] = key; ck[P.ccap + at] = c; } }
@compute @workgroup_size(256) fn main(@builtin(global_invocation_id) g: vec3u, @builtin(num_workgroups) n: vec3u) {
  let i = flat(g, n);
  _ = &inp;
  let total = tot[0];
  if (i == 0u) {
    let all = total + P.nb;
    let kept = min(all, P.ccap);
    len[0] = kept; ctl[1] = kept; ctl[5] = ctl[5] + (all - kept);
  }
  if (i < P.nb) { put(total + i, ck[2u * P.ccap + 2u * i], ck[2u * P.ccap + 2u * i + 1u]); }
  if (i >= ctl[0] || i >= P.cap) { return; }
  let key = bins_key(i); let state = key & 0xffffu;
  var at = ofs[i];
  var end = total;
  if (i + 1u < P.cap) { end = ofs[i + 1u]; }
  if (end == at) { return; }
  let sp = law(key >> 16u, state, P.t);
  for (var j = 0u; j <= sp.m; j++) {
    let c = cnt[i * ${OUTCOMES}u + j];
    if (sp.s[j] != state && sp.s[j] != DEATH && c > 0u) { put(at, (key & 0xffff0000u) | sp.s[j], c); at++; }
  }
}`;
}

// ids 0, 1, 2... for the sort to carry. Bindings: ids, len.
export const LUMP_IOTA = /* wgsl */ `
@group(0) @binding(0) var<storage, read_write> ids: array<u32>;
@group(0) @binding(1) var<storage, read> len: array<u32>;
${FLAT}
@compute @workgroup_size(256) fn main(@builtin(global_invocation_id) g: vec3u, @builtin(num_workgroups) n: vec3u) {
  let i = flat(g, n);
  if (i < len[0]) { ids[i] = i; }
}`;

// After the sort, per place: 1 where a new key starts (to be scanned into new bins' numbers), and each place's
// count (to be scanned into running totals); zeros past len up to P.n. Bindings: skey, sids, ck, len, head, pc, P (n,
// ccap).
export const LUMP_HEADS = /* wgsl */ `
struct Params { n: u32, ccap: u32, a: u32, b: u32 }
@group(0) @binding(0) var<storage, read> skey: array<u32>;
@group(0) @binding(1) var<storage, read> sids: array<u32>;
@group(0) @binding(2) var<storage, read> ck: array<u32>;
@group(0) @binding(3) var<storage, read> len: array<u32>;
@group(0) @binding(4) var<storage, read_write> head: array<u32>;
@group(0) @binding(5) var<storage, read_write> pc: array<u32>;
@group(0) @binding(6) var<uniform> P: Params;
${FLAT}
@compute @workgroup_size(256) fn main(@builtin(global_invocation_id) g: vec3u, @builtin(num_workgroups) n: vec3u) {
  let i = flat(g, n);
  if (i >= P.n) { return; }
  if (i >= len[0]) { head[i] = 0u; pc[i] = 0u; return; }
  head[i] = select(0u, 1u, i == 0u || skey[i] != skey[i - 1u]);
  pc[i] = ck[P.ccap + sids[i]];
}`;

// Where each new bin's run of places starts (hpos[j]), and hpos[new bins] = len. Bindings: skey, len, scanned head,
// tot (new bins), hpos, ctl.
export const LUMP_HPOS = /* wgsl */ `
@group(0) @binding(0) var<storage, read> skey: array<u32>;
@group(0) @binding(1) var<storage, read> len: array<u32>;
@group(0) @binding(2) var<storage, read> head: array<u32>;
@group(0) @binding(3) var<storage, read> tot: array<u32>;
@group(0) @binding(4) var<storage, read_write> hpos: array<u32>;
@group(0) @binding(5) var<storage, read_write> ctl: array<u32>;
${FLAT}
@compute @workgroup_size(256) fn main(@builtin(global_invocation_id) g: vec3u, @builtin(num_workgroups) n: vec3u) {
  let i = flat(g, n);
  let L = len[0];
  if (i == 0u) { hpos[tot[0]] = L; ctl[3] = tot[0]; }
  if (i >= L) { return; }
  if (i == 0u || skey[i] != skey[i - 1u]) { hpos[head[i]] = i; }
}`;

// The bins left, per old bin, into the new table at their places in the scanned keep flags, in their old order; remap
// gets each old bin's new number (NONE once empty). A bin under P.dense members not yet held as individuals is
// marked so, and dn gets its members to be born; one held as individuals with P.lump or more is lumped again.
// Bindings: old, new, ctl, keep (scanned), tot (bins kept), remap, dn, P (cap, dense, lump).
export const LUMP_KEEP = /* wgsl */ `
struct Params { cap: u32, dense: u32, lump: u32, a: u32 }
@group(0) @binding(0) var<storage, read> old: array<u32>;
@group(0) @binding(1) var<storage, read_write> nb: array<u32>;
@group(0) @binding(2) var<storage, read_write> ctl: array<u32>;
@group(0) @binding(3) var<storage, read> keep: array<u32>;
@group(0) @binding(4) var<storage, read> tot: array<u32>;
@group(0) @binding(5) var<storage, read_write> remap: array<u32>;
@group(0) @binding(6) var<storage, read_write> dn: array<u32>;
@group(0) @binding(7) var<uniform> P: Params;
${rows("old")}
${FLAT}
@compute @workgroup_size(256) fn main(@builtin(global_invocation_id) g: vec3u, @builtin(num_workgroups) n: vec3u) {
  let i = flat(g, n);
  if (i == 0u) { ctl[2] = tot[0]; }
  if (i >= ctl[0] || i >= P.cap) { return; }
  let tt = old_tt(i); let T = tt & ${~DENSE >>> 0}u; let out = old_out(i);
  if (out >= T) { remap[i] = ${NONE}u; return; }
  let k = keep[i];
  let left = T - out;
  var dense = (tt & ${DENSE}u) != 0u;
  if (dense && left >= P.lump) { dense = false; }
  else if (!dense && left < P.dense) { dense = true; dn[k] = left; }
  nb[k] = old_key(i); nb[P.cap + k] = old_e(i); nb[2u * P.cap + k] = T | select(0u, ${DENSE}u, dense); nb[3u * P.cap + k] = out;
  remap[i] = k;
}`;

// The new bins, one for each key the contributions reached, after the kept ones: entered at step P.t, T the
// contributions' sum. Bindings: skey, hpos, pc (scanned counts), ctl, new, dn, P (cap, t, dense).
export const LUMP_NEW = /* wgsl */ `
struct Params { cap: u32, t: u32, dense: u32, a: u32 }
@group(0) @binding(0) var<storage, read> skey: array<u32>;
@group(0) @binding(1) var<storage, read> hpos: array<u32>;
@group(0) @binding(2) var<storage, read> pc: array<u32>;
@group(0) @binding(3) var<storage, read> ctl: array<u32>;
@group(0) @binding(4) var<storage, read_write> nb: array<u32>;
@group(0) @binding(5) var<storage, read_write> dn: array<u32>;
@group(0) @binding(6) var<uniform> P: Params;
${FLAT}
@compute @workgroup_size(256) fn main(@builtin(global_invocation_id) g: vec3u, @builtin(num_workgroups) n: vec3u) {
  let j = flat(g, n);
  if (j >= ctl[3]) { return; }
  let row = ctl[2] + j;
  if (row >= P.cap) { return; }
  let T = pc[hpos[j + 1u]] - pc[hpos[j]];
  let dense = T < P.dense;
  nb[row] = skey[hpos[j]]; nb[P.cap + row] = P.t; nb[2u * P.cap + row] = T | select(0u, ${DENSE}u, dense); nb[3u * P.cap + row] = 0u;
  if (dense) { dn[row] = T; }
}`;

// One invocation: the new table's bin count, and bins lost for want of room counted. Bindings: ctl, P (cap).
export const LUMP_COUNT = /* wgsl */ `
struct Params { cap: u32, a: u32, b: u32, c: u32 }
@group(0) @binding(0) var<storage, read_write> ctl: array<u32>;
@group(0) @binding(1) var<uniform> P: Params;
@compute @workgroup_size(1) fn main() {
  let all = ctl[2] + ctl[3];
  ctl[0] = min(all, P.cap);
  ctl[4] = ctl[4] + (all - min(all, P.cap));
}`;

// The members held as individuals, per slot: each goes with its bin to the bin's new number, and dies (leaves the
// store) once its rank has been taken, its bin emptied or lumped again. Bindings: body, alloc, remap, new, P (cap,
// bin table cap, the bin and rank fields' word offsets).
export const LUMP_SWEEP = /* wgsl */ `
struct Params { cap: u32, bcap: u32, bin: u32, rank: u32 }
@group(0) @binding(0) var<storage, read_write> b: array<u32>;
@group(0) @binding(1) var<storage, read> a: array<u32>;
@group(0) @binding(2) var<storage, read> remap: array<u32>;
@group(0) @binding(3) var<storage, read> nb: array<u32>;
@group(0) @binding(4) var<uniform> P: Params;
${FLAT}
@compute @workgroup_size(256) fn main(@builtin(global_invocation_id) g: vec3u, @builtin(num_workgroups) n: vec3u) {
  let i = flat(g, n);
  if (i >= P.cap || i >= a[${CTL.tail}u] || (b[i] & 1u) == 0u) { return; }
  let to = remap[b[P.bin + i]];
  if (to == ${NONE}u || (nb[2u * P.bcap + to] & ${DENSE}u) == 0u || b[P.rank + i] < nb[3u * P.bcap + to]) { b[i] = b[i] & ~1u; return; }
  b[P.bin + i] = to;
}`;
