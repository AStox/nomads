// The spatial index in WGSL: live objects of a kind counted into the island's 75 m cells and sorted by cell, stable by
// slot, so every cell's objects are one run of `order` in slot order, from start[c] to start[c + 1]; and the mirror's
// gather, which copies the objects of the cells (or the single slots) it is asked for into one buffer for one
// staging copy. store.ts drives these; positions are the kind's x and y fields in millimetres from the island's
// north-west corner, the grid of src/terrain/grid.ts (N cells of CELL metres a side; past the edge counts as the edge).
//
// The sort is a two-pass least-significant-digit radix sort on the cell number, eight bits a pass. A pass splits the
// list into tiles of 1,024; each tile counts its digits, the counts are scanned digit by digit across tiles, and each
// tile sorts its own (digit, place) pairs in workgroup memory with a bitonic network, which gives every object its rank
// among the tile's objects with the same digit in their old order. No atomic decides a position, so the order is the
// same on every GPU and every run.
import { CELL, N } from "../../terrain/grid";
import { CTL } from "./alloc";

if (N !== 256) throw new Error("the spatial index sorts cells in two 8-bit passes, so the grid must be 256 cells a side");
export const CELL_MM = CELL * 1000;
export const CELLS = N * N;

const FLAT = /* wgsl */ `
fn flat(g: vec3u, n: vec3u) -> u32 { return g.x + g.y * n.x * 256u; }`;

// Each slot's cell (keys), a 1 for every live slot below the tail (flags, to be scanned) and the count of live objects
// in each cell. Bindings: body, alloc, keys, flags, counts, P (cap, the x and y fields' numbers).
export const INDEX_KEYS = /* wgsl */ `
struct Params { cap: u32, xf: u32, yf: u32, c: u32 }
@group(0) @binding(0) var<storage, read> b: array<u32>;
@group(0) @binding(1) var<storage, read> a: array<u32>;
@group(0) @binding(2) var<storage, read_write> key: array<u32>;
@group(0) @binding(3) var<storage, read_write> flag: array<u32>;
@group(0) @binding(4) var<storage, read_write> cnt: array<atomic<u32>>;
@group(0) @binding(5) var<uniform> P: Params;
${FLAT}
@compute @workgroup_size(256) fn main(@builtin(global_invocation_id) g: vec3u, @builtin(num_workgroups) n: vec3u) {
  let i = flat(g, n);
  if (i >= P.cap) { return; }
  if (i < a[${CTL.tail}u] && (b[i] & 1u) == 1u) {
    let cx = min(b[(P.xf + 1u) * P.cap + i] / ${CELL_MM}u, ${N - 1}u);
    let cy = min(b[(P.yf + 1u) * P.cap + i] / ${CELL_MM}u, ${N - 1}u);
    let c = cy * ${N}u + cx;
    key[i] = c;
    flag[i] = 1u;
    atomicAdd(&cnt[c], 1u);
  } else {
    flag[i] = 0u;
  }
}`;

// The live slots in slot order, each at its place in the scanned flags, with its cell beside it (the sort carries
// the cells along with the slots, so every pass reads them in order). Bindings: body, alloc, flags, keys by slot, ids,
// keys by place, P (cap).
export const INDEX_COMPACT = /* wgsl */ `
struct Params { cap: u32, a: u32, b: u32, c: u32 }
@group(0) @binding(0) var<storage, read> b: array<u32>;
@group(0) @binding(1) var<storage, read> a: array<u32>;
@group(0) @binding(2) var<storage, read> flag: array<u32>;
@group(0) @binding(3) var<storage, read> key: array<u32>;
@group(0) @binding(4) var<storage, read_write> ids: array<u32>;
@group(0) @binding(5) var<storage, read_write> kout: array<u32>;
@group(0) @binding(6) var<uniform> P: Params;
${FLAT}
@compute @workgroup_size(256) fn main(@builtin(global_invocation_id) g: vec3u, @builtin(num_workgroups) n: vec3u) {
  let i = flat(g, n);
  if (i >= P.cap) { return; }
  if (i < a[${CTL.tail}u] && (b[i] & 1u) == 1u) { ids[flag[i]] = i; kout[flag[i]] = key[i]; }
}`;

const TILE = /* wgsl */ `
struct Params { shift: u32, tiles: u32, a: u32, b: u32 }
fn tileOf(w: vec3u, n: vec3u) -> u32 { return w.x + w.y * n.x; }
fn digit(i: u32) -> u32 {
  if (i >= len[0]) { return 256u; }
  return (key[i] >> P.shift) & 255u;
}`;

// One radix pass, step one: each tile's count of each digit, written digit-major (hist[d * tiles + tile]) so a scan
// gives every (digit, tile) its first place in the pass's output. Bindings: keys, len (the live count), hist, P.
export const RADIX_HIST = /* wgsl */ `
@group(0) @binding(0) var<storage, read> key: array<u32>;
@group(0) @binding(1) var<storage, read> len: array<u32>;
@group(0) @binding(2) var<storage, read_write> hist: array<u32>;
@group(0) @binding(3) var<uniform> P: Params;
${TILE}
var<workgroup> h: array<atomic<u32>, 256>;
@compute @workgroup_size(256) fn main(@builtin(workgroup_id) w: vec3u, @builtin(num_workgroups) n: vec3u, @builtin(local_invocation_index) l: u32) {
  let tile = tileOf(w, n);
  atomicStore(&h[l], 0u);
  workgroupBarrier();
  for (var r = 0u; r < 4u; r++) {
    let d = digit(tile * 1024u + l + 256u * r);
    if (d < 256u) { atomicAdd(&h[d], 1u); }
  }
  workgroupBarrier();
  if (tile < P.tiles) { hist[l * P.tiles + tile] = atomicLoad(&h[l]); }
}`;

// One radix pass, step two: every object to its digit's first place for its tile plus its rank among the tile's
// objects with that digit, in their old order. Bindings: keys, ids, len, scanned hist, ids out, keys out, P.
export const RADIX_SCATTER = /* wgsl */ `
@group(0) @binding(0) var<storage, read> key: array<u32>;
@group(0) @binding(1) var<storage, read> ids: array<u32>;
@group(0) @binding(2) var<storage, read> len: array<u32>;
@group(0) @binding(3) var<storage, read> hist: array<u32>;
@group(0) @binding(4) var<storage, read_write> out: array<u32>;
@group(0) @binding(5) var<storage, read_write> kout: array<u32>;
@group(0) @binding(6) var<uniform> P: Params;
${TILE}
var<workgroup> s: array<u32, 1024>;
var<workgroup> h: array<atomic<u32>, 256>;
var<workgroup> first: array<u32, 256>;
@compute @workgroup_size(256) fn main(@builtin(workgroup_id) w: vec3u, @builtin(num_workgroups) n: vec3u, @builtin(local_invocation_index) l: u32) {
  let tile = tileOf(w, n);
  atomicStore(&h[l], 0u);
  workgroupBarrier();
  for (var r = 0u; r < 4u; r++) {
    let e = l + 256u * r;
    let d = digit(tile * 1024u + e);
    s[e] = (d << 10u) | e;
    if (d < 256u) { atomicAdd(&h[d], 1u); }
  }
  workgroupBarrier();
  // the tile's digits counted and scanned (exclusive), for each digit's first place in the sorted tile
  let own = atomicLoad(&h[l]);
  first[l] = own;
  workgroupBarrier();
  for (var d = 1u; d < 256u; d <<= 1u) {
    var u = 0u;
    if (l >= d) { u = first[l - d]; }
    workgroupBarrier();
    first[l] += u;
    workgroupBarrier();
  }
  first[l] -= own;
  // bitonic sort of the 1,024 (digit, place) pairs, two compare-exchanges to an invocation a stage. Each exchange
  // writes both words whether they swap or not: on the AMD under Metal a swap written only under an if came out
  // wrong (264 of 1,023 neighbours out of order in a 1,024-word test), the unconditional form right on both GPUs.
  for (var k = 2u; k <= 1024u; k <<= 1u) {
    for (var j = k >> 1u; j > 0u; j >>= 1u) {
      for (var r = 0u; r < 2u; r++) {
        let q = l + 256u * r;
        let i = 2u * j * (q / j) + (q % j);
        let o = i + j;
        let up = (i & k) == 0u;
        let x = s[i];
        let y = s[o];
        let lo = min(x, y);
        let hi = max(x, y);
        s[i] = select(hi, lo, up);
        s[o] = select(lo, hi, up);
      }
      workgroupBarrier();
    }
  }
  if (tile >= P.tiles) { return; }
  for (var r = 0u; r < 4u; r++) {
    let p = l + 256u * r;
    let v = s[p];
    let d = v >> 10u;
    if (d < 256u) {
      let at = hist[d * P.tiles + tile] + (p - first[d]);
      let src = tile * 1024u + (v & 1023u);
      out[at] = ids[src];
      kout[at] = key[src];
    }
  }
}`;

// The mirror's gather, step one, one workgroup: each entry's object count (a cell's run in the index, or 1 for a
// single slot, the entry's top bit set), scanned into each entry's place among the rows; an entry that would end past
// the limit is marked with count 0xffffffff and left out. out[0] is the cursor the kinds' rows go on from; out[P.sum]
// gets the words this kind asked for. The kind's entries start at word P.base. Bindings: start, entries, out, P.
export const GATHER_HEAD = /* wgsl */ `
struct Params { n: u32, head: u32, row: u32, limit: u32, sum: u32, base: u32, b: u32, c: u32 }
@group(0) @binding(0) var<storage, read> start: array<u32>;
@group(0) @binding(1) var<storage, read> ents: array<u32>;
@group(0) @binding(2) var<storage, read_write> out: array<u32>;
@group(0) @binding(3) var<uniform> P: Params;
var<workgroup> t: array<u32, 256>;
fn size(e: u32) -> u32 {
  let v = ents[P.base + e];
  if ((v & 0x80000000u) != 0u) { return 1u; }
  return start[v + 1u] - start[v];
}
@compute @workgroup_size(256) fn main(@builtin(local_invocation_index) l: u32) {
  let per = (P.n + 255u) / 256u;
  let lo = min(l * per, P.n);
  let hi = min(lo + per, P.n);
  var s = 0u;
  for (var e = lo; e < hi; e++) { s += size(e); }
  t[l] = s;
  let base = out[0];
  workgroupBarrier();
  for (var d = 1u; d < 256u; d <<= 1u) {
    var u = 0u;
    if (l >= d) { u = t[l - d]; }
    workgroupBarrier();
    t[l] += u;
    workgroupBarrier();
  }
  var o = t[l] - s;
  for (var e = lo; e < hi; e++) {
    let c = size(e);
    let at = base + o * P.row;
    if (at + c * P.row <= P.limit) { out[P.head + 2u * e] = at; out[P.head + 2u * e + 1u] = c; }
    else { out[P.head + 2u * e] = 0u; out[P.head + 2u * e + 1u] = 0xffffffffu; }
    o += c;
  }
  storageBarrier();
  workgroupBarrier();
  if (l == 255u) {
    out[P.sum] = t[255] * P.row;
    out[0] = min(base + t[255] * P.row, P.limit);
  }
}`;

// The mirror's gather, step two, a workgroup for each entry: its rows (slot, slot word, then each field). Bindings:
// body, order, start, entries, out, P.
export const GATHER_ROWS = /* wgsl */ `
struct Params { n: u32, head: u32, row: u32, cap: u32, base: u32, a: u32, b: u32, c: u32 }
@group(0) @binding(0) var<storage, read> b: array<u32>;
@group(0) @binding(1) var<storage, read> order: array<u32>;
@group(0) @binding(2) var<storage, read> start: array<u32>;
@group(0) @binding(3) var<storage, read> ents: array<u32>;
@group(0) @binding(4) var<storage, read_write> out: array<u32>;
@group(0) @binding(5) var<uniform> P: Params;
@compute @workgroup_size(64) fn main(@builtin(workgroup_id) w: vec3u, @builtin(num_workgroups) n: vec3u, @builtin(local_invocation_index) l: u32) {
  let e = w.x + w.y * n.x;
  if (e >= P.n) { return; }
  let at = out[P.head + 2u * e];
  let c = out[P.head + 2u * e + 1u];
  if (c == 0xffffffffu) { return; }
  let v = ents[P.base + e];
  for (var r = l; r < c; r += 64u) {
    var slot = v & 0x7fffffffu;
    if ((v & 0x80000000u) == 0u) { slot = order[start[v] + r]; }
    let o = at + r * P.row;
    out[o] = slot;
    for (var f = 0u; f + 1u < P.row; f++) {
      var x = 0u;
      if (slot < P.cap) { x = b[f * P.cap + slot]; }
      out[o + 1u + f] = x;
    }
  }
}`;
