// Lumped kinds in WGSL (tiers/lumped.ts drives these and describes the bins, the step and identity). A bin table is
// four runs of `cap` words: key (cell << 16 | state), e (the step its members entered), tt (the members that entered,
// T, with bit 31 set while the bin is held as individuals) and out (members gone, which took ranks 0 to out - 1); a
// wide kind's table has a fifth run, part (the bin's number among its key's bins, each under 2^31 members). ctl words
// (CTL_WORDS of them): 0 bins, 1 contributions this step, 2 bins kept, 3 bins new, 4 bins lost for want of room (so
// far), 5 contributions lost (so far), 6 departures and births this step, 7 stayers' contributions this step (a merging
// kind), 8 births from the GPU this step, 9 members taken at the GPU's request this step, 10 the watch log's words.
import { CTL } from "./alloc";
import { CELL_MM } from "./index";
import { N } from "../../terrain/grid";
import { FIXED } from "./fixed";
import { RAND } from "./rand";

export const DENSE = 0x80000000;
// The states a member can leave to that are no state: fates. DEATH; PROMOTED, singled out into an individual; TAKEN,
// taken away by people; EATEN(p), eaten by predator class p (p under 13).
export const DEATH = 0xffffffff;
export const PROMOTED = 0xfffffffe;
export const TAKEN = 0xfffffffd;
export const FATE = 0xfffffff0;
export const EATEN = (p: number) => {
  if (!(Number.isInteger(p) && p >= 0 && p < 13)) throw new Error(`predator class ${p}: classes are 0 to 12`);
  return (FATE + p) >>> 0;
};
export const isFate = (s: number) => s >>> 0 >= FATE;
export const NONE = 0xffffffff;
// Outcomes a law may have at most, the words of counts a bin holds by default; a law that bears has one fewer, and the
// bin's births take the last word of its counts. A kind whose law has fewer gives its own count (LumpedLayout.outs).
export const OUTCOMES = 16;
export const CTL_WORDS = 16;
export const C = { bins: 0, contribs: 1, kept: 2, made: 3, lostBins: 4, lostContribs: 5, dep: 6, stays: 7, gb: 8, gtakes: 9, wlog: 10, parts: 11 } as const;
// Most members the GPU may ask to take a step [design: a day's held predators, a few at a time].
export const REQ_MAX = 1024;
// A wide kind's bins hold under this many members each.
export const PART_MAX = 0x7fffffff;
// The stream a bin draws on and keys its identity by: its entry step, and a wide kind's part mixed in.
export const lstream = (e: number, part: number) => (e ^ Math.imul(part, 0x9e3779b9)) >>> 0;

const FLAT = /* wgsl */ `
fn flat(g: vec3u, n: vec3u) -> u32 { return g.x + g.y * n.x * 256u; }`;

export type LumpedLayout = { seed: number; law: string; wide?: boolean; outs?: number };

// Bin rows of a table bound as `name` with capacity P.cap.
const rows = (name: string, wide = false) => /* wgsl */ `
fn ${name}_key(i: u32) -> u32 { return ${name}[i]; }
fn ${name}_e(i: u32) -> u32 { return ${name}[P.cap + i]; }
fn ${name}_tt(i: u32) -> u32 { return ${name}[2u * P.cap + i]; }
fn ${name}_out(i: u32) -> u32 { return ${name}[3u * P.cap + i]; }
fn ${name}_part(i: u32) -> u32 { ${wide ? `return ${name}[4u * P.cap + i];` : "return 0u;"} }`;

// What every lumped kernel that draws or names members needs: the law, a member's identity (its rank put through
// the bin's Feistel permutation of [0, T)), its place in its cell, and a law's births.
export function lumpedCore(l: LumpedLayout): string {
  return /* wgsl */ `
${FIXED}
${RAND}
const LSEED = ${l.seed >>> 0}u;
const DEATH = ${DEATH}u;
const PROMOTED = ${PROMOTED}u;
const TAKEN = ${TAKEN}u;
const FATE = ${FATE}u;
struct Split { m: u32, t: array<u32, 15>, s: array<u32, 16>, bm: u32, bt: array<u32, 3>, bo: u32, bs: u32, bk: u32 }
${l.law}
fn lstream(e: u32, part: u32) -> u32 { return e ^ (part * 0x9e3779b9u); }
fn lsigmap(key: u32, e: u32, part: u32, T: u32, rank: u32) -> u32 { return feistel(rank, T, fkeys(LSEED, lstream(e, part), key, 0u)); }
fn lsigma(key: u32, e: u32, T: u32, rank: u32) -> u32 { return lsigmap(key, e, 0u, T, rank); }
fn lplace(key: u32, e: u32, sigma: u32) -> vec2u {
  let h = philox(vec4u(key, sigma, e, 0xfffffffeu), vec2u(LSEED, 0x80000000u));
  let cell = key >> 16u;
  return vec2u((cell % ${N}u) * ${CELL_MM}u + h.x % ${CELL_MM}u, (cell / ${N}u) * ${CELL_MM}u + h.y % ${CELL_MM}u);
}
// The members a split's outcomes bear (Split.bm, bt, bo, bs, bk): the members of the outcomes in bo, split over the
// counts 0, bk, 2 bk and 3 bk by the intervals bt, on the bin's stream after the split's own draws; saturating.
fn lborn(sp: Split, c: array<u32, 16>) -> u32 {
  if (sp.bm == 0u) { return 0u; }
  var nb = 0u;
  for (var j = 0u; j < 16u; j++) { if (j > sp.m) { break; } if (((sp.bo >> j) & 1u) == 1u) { nb += c[j]; } }
  var bt: array<u32, 15>;
  bt[0] = sp.bt[0]; bt[1] = sp.bt[1]; bt[2] = sp.bt[2];
  let k = multinom(nb, bt, sp.bm);
  var born = 0u;
  for (var i = 1u; i < 4u; i++) { if (i > sp.bm) { break; }
    let p = mul64(k[i], i * sp.bk);
    let add = select(p.x, 0xffffffffu, p.y != 0u);
    born = select(born + add, 0xffffffffu, born > 0xffffffffu - add);
  }
  return born;
}`;
}

// Takes, in one invocation: the CPU's requests (key, e, count, code) in order, then the GPU's (a key each, one member
// each, P.gcode) in their order, at most REQ_MAX of them; each takes the next ranks of its bin, at most what it holds
// (a merging kind's table is in key order, so a bin is found by its key; e NONE matches any). took[r] gets the members
// promoted (none for another code), info[4r..4r + 3] the first rank taken, the bin, the code and the members taken.
// Bindings: bins, ctl, req (count, then key, e, count, code each), gq (P.ng keys, NONE for none), took, info, P (cap,
// merge, ng, gcode).
export function lumpTake(wide: boolean) {
  return /* wgsl */ `
struct Params { cap: u32, merge: u32, ng: u32, gcode: u32 }
@group(0) @binding(0) var<storage, read_write> bins: array<u32>;
@group(0) @binding(1) var<storage, read_write> ctl: array<u32>;
@group(0) @binding(2) var<storage, read> req: array<u32>;
@group(0) @binding(3) var<storage, read> gq: array<u32>;
@group(0) @binding(4) var<storage, read_write> took: array<u32>;
@group(0) @binding(5) var<storage, read_write> info: array<u32>;
@group(0) @binding(6) var<uniform> P: Params;
${rows("bins", wide)}
fn find(key: u32, e: u32) -> u32 {
  let n = ctl[0];
  if (P.merge == 1u) {
    var lo = 0u; var hi = n;
    loop { if (lo >= hi) { break; } let mid = (lo + hi) / 2u; if (bins_key(mid) < key) { lo = mid + 1u; } else { hi = mid; } }
    // a wide kind's parts of one key lie together: the first with members left
    loop {
      if (lo >= n || bins_key(lo) != key) { return ${NONE}u; }
      if ((e == ${NONE}u || bins_e(lo) == e) && bins_out(lo) < (bins_tt(lo) & ${~DENSE >>> 0}u)) { return lo; }
      lo++;
    }
  }
  for (var i = 0u; i < n; i++) { if (bins_key(i) == key && (e == ${NONE}u || bins_e(i) == e)) { return i; } }
  return ${NONE}u;
}
fn take(key: u32, e: u32, count: u32, code: u32, r: u32) {
  took[r] = 0u; info[4u * r] = 0u; info[4u * r + 1u] = ${NONE}u; info[4u * r + 2u] = code; info[4u * r + 3u] = 0u;
  let row = find(key, e);
  if (row == ${NONE}u) { return; }
  let T = bins_tt(row) & ${~DENSE >>> 0}u; let out = bins_out(row);
  let k = min(count, T - out);
  if (code == ${PROMOTED}u) { took[r] = k; }
  info[4u * r] = out; info[4u * r + 1u] = row; info[4u * r + 3u] = k;
  bins[3u * P.cap + row] = out + k;
}
@compute @workgroup_size(1) fn main() {
  var r = 0u;
  for (var q = 0u; q < req[0]; q++) { take(req[1u + 4u * q], req[2u + 4u * q], req[3u + 4u * q], req[4u + 4u * q], r); r++; }
  var g = 0u;
  for (var j = 0u; j < P.ng; j++) {
    if (g >= ${REQ_MAX}u) { break; }
    let key = gq[j];
    if (key == ${NONE}u) { continue; }
    take(key, ${NONE}u, 1u, P.gcode, r); r++; g++;
  }
  ctl[${C.gtakes}u] = g;
}`;
}

// The split, per bin: the law's outcome intervals for the bin's state, the multinomial of its members over them on
// the stream of (seed, e, key, t); departures (outcomes to another state, or fates) take the next ranks in outcome
// order; cnt gets every outcome's count and, for a law that bears, the births in its last word; nc the contributions
// to other states (and the births'), keep 1 while members are left. Bindings: bins, ctl, cnt, nc, keep, inp, P (cap,
// t).
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
${rows("bins", l.wide)}
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
  rinit(LSEED, lstream(e, bins_part(i)), key, P.t);
  let c = multinom(T - out, sp.t, sp.m);
  var dep = 0u; var k = 0u;
  for (var j = 0u; j < 16u; j++) { if (j > sp.m) { break; }
    cnt[i * ${l.outs ?? OUTCOMES}u + j] = c[j];
    if (sp.s[j] != state) { dep += c[j]; if (sp.s[j] < FATE && c[j] > 0u) { k++; } }
  }
  if (sp.bm > 0u) {
    let born = lborn(sp, c);
    cnt[i * ${l.outs ?? OUTCOMES}u + ${(l.outs ?? OUTCOMES) - 1}u] = born;
    if (born > 0u) { k++; }
  }
  bins[3u * P.cap + i] = out + dep;
  nc[i] = k;
  keep[i] = select(0u, 1u, out + dep < T);
}`;
}

// Births from the GPU: flags (1 where a pair's count is above 0) to be scanned, then each such pair put after the
// CPU's births in ck. Bindings: gb (pairs key, count), flags, P (n).
export const LUMP_GBFLAG = /* wgsl */ `
struct Params { n: u32, a: u32, b: u32, c: u32 }
@group(0) @binding(0) var<storage, read> gb: array<u32>;
@group(0) @binding(1) var<storage, read_write> flags: array<u32>;
@group(0) @binding(2) var<uniform> P: Params;
${FLAT}
@compute @workgroup_size(256) fn main(@builtin(global_invocation_id) g: vec3u, @builtin(num_workgroups) n: vec3u) {
  let i = flat(g, n);
  if (i >= P.n) { return; }
  flags[i] = select(0u, 1u, gb[2u * i + 1u] > 0u);
}`;
// Bindings: gb, flags (scanned), tot, ck, ctl, P (n, ccap, nb).
export const LUMP_GBPUT = /* wgsl */ `
struct Params { n: u32, ccap: u32, nb: u32, a: u32 }
@group(0) @binding(0) var<storage, read> gb: array<u32>;
@group(0) @binding(1) var<storage, read> flags: array<u32>;
@group(0) @binding(2) var<storage, read> tot: array<u32>;
@group(0) @binding(3) var<storage, read_write> ck: array<u32>;
@group(0) @binding(4) var<storage, read_write> ctl: array<u32>;
@group(0) @binding(5) var<uniform> P: Params;
${FLAT}
@compute @workgroup_size(256) fn main(@builtin(global_invocation_id) g: vec3u, @builtin(num_workgroups) n: vec3u) {
  let i = flat(g, n);
  if (i == 0u) { ctl[${C.gb}u] = tot[0]; }
  if (i >= P.n || gb[2u * i + 1u] == 0u) { return; }
  let at = 2u * P.ccap + 2u * P.nb + 2u * flags[i];
  ck[at] = gb[2u * i]; ck[at + 1u] = gb[2u * i + 1u];
}`;

// The contributions, per bin: a merging kind's stayers first, one (key, members left) a bin at its place in the
// scanned keep flags; then each bin's (key of the state reached, count) for each outcome to another state and its
// births, at its offset in the scanned nc after all the stayers'; then the CPU's births and the GPU's after them all;
// len the count (capped at P.ccap, the rest counted lost). ck holds the keys in words 0 to ccap - 1, the counts in
// words ccap to 2 ccap - 1, and the births as written by the CPU and put by LUMP_GBPUT from word 2 ccap. ctl[6] and
// ctl[7] hold the totals of nc and (merging) keep. Bindings: bins, ctl, ofs (scanned nc), ks (scanned keep), cnt, ck,
// len, inp, P (cap, t, nb, ccap, merge, gn).
export function lumpEmit(l: LumpedLayout): string {
  return /* wgsl */ `
${lumpedCore(l)}
struct Params { cap: u32, t: u32, nb: u32, ccap: u32, merge: u32, gn: u32, a: u32, b: u32 }
@group(0) @binding(0) var<storage, read> bins: array<u32>;
@group(0) @binding(1) var<storage, read_write> ctl: array<u32>;
@group(0) @binding(2) var<storage, read> ofs: array<u32>;
@group(0) @binding(3) var<storage, read> ks: array<u32>;
@group(0) @binding(4) var<storage, read> cnt: array<u32>;
@group(0) @binding(5) var<storage, read_write> ck: array<u32>;
@group(0) @binding(6) var<storage, read_write> len: array<u32>;
@group(0) @binding(7) var<storage, read> inp: array<u32>;
@group(0) @binding(8) var<uniform> P: Params;
${rows("bins", l.wide)}
${FLAT}
fn cput(at: u32, key: u32, c: u32) { if (at < P.ccap) { ck[at] = key; ck[P.ccap + at] = c; } }
@compute @workgroup_size(256) fn main(@builtin(global_invocation_id) g: vec3u, @builtin(num_workgroups) n: vec3u) {
  let i = flat(g, n);
  _ = &inp;
  let stays = select(0u, ctl[${C.stays}u], P.merge == 1u);
  let base = stays + ctl[${C.dep}u];
  let ngb = ctl[${C.gb}u];
  if (i == 0u) {
    let all = base + P.nb + ngb;
    let kept = min(all, P.ccap);
    len[0] = kept; ctl[1] = kept; ctl[5] = ctl[5] + (all - kept);
  }
  if (i < P.nb) { cput(base + i, ck[2u * P.ccap + 2u * i], ck[2u * P.ccap + 2u * i + 1u]); }
  if (i < ngb) { cput(base + P.nb + i, ck[2u * P.ccap + 2u * P.nb + 2u * i], ck[2u * P.ccap + 2u * P.nb + 2u * i + 1u]); }
  if (i >= ctl[0] || i >= P.cap) { return; }
  let key = bins_key(i); let state = key & 0xffffu;
  let T = bins_tt(i) & ${~DENSE >>> 0}u; let out = bins_out(i);
  if (P.merge == 1u && out < T) {
    var next = stays;
    if (i + 1u < P.cap) { next = ks[i + 1u]; }
    if (next > ks[i]) { cput(ks[i], key, T - out); }
  }
  var at = stays + ofs[i];
  var end = base;
  if (i + 1u < P.cap) { end = stays + ofs[i + 1u]; }
  if (end == at) { return; }
  let sp = law(key >> 16u, state, P.t);
  for (var j = 0u; j < 16u; j++) { if (j > sp.m) { break; }
    let c = cnt[i * ${l.outs ?? OUTCOMES}u + j];
    if (sp.s[j] != state && sp.s[j] < FATE && c > 0u) { cput(at, (key & 0xffff0000u) | sp.s[j], c); at++; }
  }
  if (sp.bm > 0u) {
    let born = cnt[i * ${l.outs ?? OUTCOMES}u + ${(l.outs ?? OUTCOMES) - 1}u];
    if (born > 0u) { cput(at, (key & 0xffff0000u) | sp.bs, born); }
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
// Bindings: old, new, ctl (word 7 the bins kept), keep (scanned), remap, dn, P (cap, dense, lump).
export const LUMP_KEEP = /* wgsl */ `
struct Params { cap: u32, dense: u32, lump: u32, a: u32 }
@group(0) @binding(0) var<storage, read> old: array<u32>;
@group(0) @binding(1) var<storage, read_write> nb: array<u32>;
@group(0) @binding(2) var<storage, read_write> ctl: array<u32>;
@group(0) @binding(3) var<storage, read> keep: array<u32>;
@group(0) @binding(4) var<storage, read_write> remap: array<u32>;
@group(0) @binding(5) var<storage, read_write> dn: array<u32>;
@group(0) @binding(6) var<uniform> P: Params;
${rows("old")}
${FLAT}
@compute @workgroup_size(256) fn main(@builtin(global_invocation_id) g: vec3u, @builtin(num_workgroups) n: vec3u) {
  let i = flat(g, n);
  if (i == 0u) { ctl[2] = ctl[${C.stays}u]; }
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

// The new bins, one for each key the contributions reached, after the kept ones (a merging kind keeps none: ctl[2] is
// 0): entered at step P.t, T the contributions' sum. Bindings: skey, hpos, pc (scanned counts), ctl, new, dn, P (cap,
// t, dense).
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

// A merging kind's new table starts empty of kept bins. Bindings: ctl.
export const LUMP_NOKEEP = /* wgsl */ `
@group(0) @binding(0) var<storage, read_write> ctl: array<u32>;
@compute @workgroup_size(1) fn main() { ctl[2] = 0u; }`;

// A wide kind's new bins: each key's run of contributions (pc unscanned: each place's count) packed in order into
// parts of at most PART_MAX members, a contribution never split. Count: parts a key takes (wn, to be scanned). Write:
// the parts, from the key's place in the scanned wn (cleared before the count, so wn[keys] is the parts in all, which
// ctl[11] gets). Bindings (both): skey, hpos, pc, ctl,
// wn, new, P (cap, t, entry: 0 count, 1 write).
export const LUMP_WIDE = /* wgsl */ `
struct Params { cap: u32, t: u32, write: u32, a: u32 }
@group(0) @binding(0) var<storage, read> skey: array<u32>;
@group(0) @binding(1) var<storage, read> hpos: array<u32>;
@group(0) @binding(2) var<storage, read> pc: array<u32>;
@group(0) @binding(3) var<storage, read_write> ctl: array<u32>;
@group(0) @binding(4) var<storage, read_write> wn: array<u32>;
@group(0) @binding(5) var<storage, read_write> nb: array<u32>;
@group(0) @binding(6) var<uniform> P: Params;
${FLAT}
@compute @workgroup_size(256) fn main(@builtin(global_invocation_id) g: vec3u, @builtin(num_workgroups) n: vec3u) {
  let j = flat(g, n);
  let heads = ctl[3];
  if (P.write == 1u && j == 0u) { ctl[${C.parts}u] = wn[heads]; }
  if (j >= heads) { return; }
  let key = skey[hpos[j]];
  var acc = 0u; var part = 0u;
  for (var p = hpos[j]; p < hpos[j + 1u]; p++) {
    let c = pc[p];
    if (acc > 0u && acc > ${PART_MAX}u - c) {
      if (P.write == 1u) { let row = wn[j] + part; if (row < P.cap) { nb[row] = key; nb[P.cap + row] = P.t; nb[2u * P.cap + row] = acc; nb[3u * P.cap + row] = 0u; nb[4u * P.cap + row] = part; } }
      part++; acc = c;
    } else { acc += c; }
  }
  if (P.write == 1u) { let row = wn[j] + part; if (row < P.cap) { nb[row] = key; nb[P.cap + row] = P.t; nb[2u * P.cap + row] = acc; nb[3u * P.cap + row] = 0u; nb[4u * P.cap + row] = part; } }
  else { wn[j] = part + 1u; }
}`;

// One invocation: the new table's bin count (a wide kind's new bins are its parts), and bins lost for want of room
// counted. Bindings: ctl, P (cap, wide).
export const LUMP_COUNT = /* wgsl */ `
struct Params { cap: u32, wide: u32, b: u32, c: u32 }
@group(0) @binding(0) var<storage, read_write> ctl: array<u32>;
@group(0) @binding(1) var<uniform> P: Params;
@compute @workgroup_size(1) fn main() {
  let all = ctl[2] + select(ctl[3], ctl[${C.parts}u], P.wide == 1u);
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

// Promoted members, per slot of the active kind: a step of the law as an individual, its draw keyed by its identity
// (lkey, lsig, le) and the step: the outcome its uniform word falls in; a fate kills it, any other state is its
// own. Bindings: body, alloc, inp, P (cap, t, lkey, le, lsig, lstate: word offsets).
export function lumpActive(l: LumpedLayout): string {
  return /* wgsl */ `
${lumpedCore(l)}
struct Params { cap: u32, t: u32, lkey: u32, le: u32, lsig: u32, lstate: u32, a: u32, b: u32 }
@group(0) @binding(0) var<storage, read_write> b: array<u32>;
@group(0) @binding(1) var<storage, read> a: array<u32>;
@group(0) @binding(2) var<storage, read> inp: array<u32>;
@group(0) @binding(3) var<uniform> P: Params;
${FLAT}
@compute @workgroup_size(256) fn main(@builtin(global_invocation_id) g: vec3u, @builtin(num_workgroups) n: vec3u) {
  let i = flat(g, n);
  _ = &inp;
  if (i >= P.cap || i >= a[${CTL.tail}u] || (b[i] & 1u) == 0u) { return; }
  let key = b[P.lkey + i]; let state = b[P.lstate + i];
  let sp = law(key >> 16u, state, P.t);
  let u = philox(vec4u(key, b[P.lsig + i], b[P.le + i], P.t), vec2u(LSEED, 0x80000001u)).x;
  let s = sp.s[outcome(sp.t, sp.m, u)];
  if (s >= FATE) { b[i] = b[i] & ~1u; return; }
  b[P.lstate + i] = s;
}`;
}

// The watch log of a merging kind, appended each step: the GPU's takes (P.ng0 = the CPU's takes before them in info),
// then the bins of the watched cells (cells, P.nw of them, sorted; the table is in key order, so a cell's bins are one
// run of it) and their input words. A record: t, takes g, then g x (key, e, part, first, code, members), bins b, then
// b x (key, e, T, part), cells w, then w x (cell, then P.cw words). wlog[0] counts the words written after it; a
// record past P.wcap is dropped and ctl[10] counts it. One invocation (records are short). Bindings: bins (the new
// table), old (the table the takes took from), ctl, info, cells, inp, wlog, P (cap, t, ng0, nw, cw, base, wcap, wide).
export const LUMP_WATCH = /* wgsl */ `
struct Params { cap: u32, t: u32, ng0: u32, nw: u32, cw: u32, base: u32, wcap: u32, wide: u32 }
@group(0) @binding(0) var<storage, read> bins: array<u32>;
@group(0) @binding(1) var<storage, read> old: array<u32>;
@group(0) @binding(2) var<storage, read_write> ctl: array<u32>;
@group(0) @binding(3) var<storage, read> info: array<u32>;
@group(0) @binding(4) var<storage, read> cells: array<u32>;
@group(0) @binding(5) var<storage, read> inp: array<u32>;
@group(0) @binding(6) var<storage, read_write> wlog: array<u32>;
@group(0) @binding(7) var<uniform> P: Params;
// The first row whose key is at least k.
fn first(k: u32) -> u32 {
  var lo = 0u; var hi = ctl[0];
  loop { if (lo >= hi) { break; } let mid = (lo + hi) / 2u; if (bins[mid] < k) { lo = mid + 1u; } else { hi = mid; } }
  return lo;
}
fn upto(c: u32) -> u32 { if (c == 0xffffu) { return ctl[0]; } return first((c + 1u) << 16u); }
@compute @workgroup_size(1) fn main() {
  var at = 1u + wlog[0];
  let start = at;
  let g = ctl[${C.gtakes}u];
  var b = 0u;
  for (var c = 0u; c < P.nw; c++) { b += upto(cells[c]) - first(cells[c] << 16u); }
  let need = 3u + 6u * g + 4u * b + P.nw * (1u + P.cw);
  if (at + need > P.wcap) { ctl[${C.wlog}u] = ctl[${C.wlog}u] + 1u; return; }
  wlog[at] = P.t; wlog[at + 1u] = g; at += 2u;
  for (var r = P.ng0; r < P.ng0 + g; r++) {
    let row = info[4u * r + 1u];
    if (row == ${NONE}u) { wlog[at] = ${NONE}u; wlog[at + 1u] = 0u; wlog[at + 2u] = 0u; }
    else { wlog[at] = old[row]; wlog[at + 1u] = old[P.cap + row]; wlog[at + 2u] = select(0u, old[4u * P.cap + row], P.wide == 1u); }
    wlog[at + 3u] = info[4u * r]; wlog[at + 4u] = info[4u * r + 2u]; wlog[at + 5u] = info[4u * r + 3u];
    at += 6u;
  }
  wlog[at] = b; at++;
  for (var c = 0u; c < P.nw; c++) {
    for (var i = first(cells[c] << 16u); i < upto(cells[c]); i++) {
      wlog[at] = bins[i]; wlog[at + 1u] = bins[P.cap + i]; wlog[at + 2u] = bins[2u * P.cap + i] & ${~DENSE >>> 0}u;
      wlog[at + 3u] = select(0u, bins[4u * P.cap + i], P.wide == 1u);
      at += 4u;
    }
  }
  wlog[at] = P.nw; at++;
  for (var c = 0u; c < P.nw; c++) {
    wlog[at] = cells[c]; at++;
    for (var k = 0u; k < P.cw; k++) { wlog[at] = inp[P.base + cells[c] * P.cw + k]; at++; }
  }
  wlog[0] = wlog[0] + (at - start);
}`;
