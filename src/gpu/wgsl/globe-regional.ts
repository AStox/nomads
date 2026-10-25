// The regional tier's erosion on the cube-sphere, on the GPU (host side, laws, constants and sources: src/gpu/globe/regional.ts and
// docs/research/globe/2026-10-20-regional-impl.md). A tier is a quadtree tier of the globe's grid, 2^tier by 2^tier children to each tier-0
// cell, held as one flat array of 6 * fn * fn cells in the grid's cell order k = (face * fn + Y) * fn + X. The grid's per-tile kernels (a
// halo and tables a tile) cannot hold a tier of 25 million cells (their tables alone are 41 words a cell), so these kernels find a cell's
// eight neighbours from its place (across tile and face edges as grid.ts haloSource does) and read what varies slowly (the rock's
// erodibility, the area weight, the distances to the neighbours) from a table of the tier-0 cell it lies in. Four bindings: P the
// parameters, E the cells' fields, AT the atomic words (the flooded surface, the depth sort's counts, counters, the parents' sums), X the
// table of tier-0 cells. All integer: no float sits between a buffer read and a buffer write.
//
// One step, in the order the host records it:
//   weights  each land cell's share of the discharge: its area weight times its rain over the reference rain;
//   flood    the flooded surface f = max(h, least neighbour f + eps) from the sea inwards, one round a dispatch, until a round changes nothing;
//   recv     every land cell drains to its steepest neighbour on the flooded surface (a forest rooted at the sea);
//   tree     depth by pointer jumping, the cells filed by depth (a counting sort), the discharge area gathered deepest first;
//   incise   the implicit stream power step in order of depth, receivers first;
//   slide    the threshold hillslopes: each land cell is lowered to the least, over its neighbours, of their height plus the rock's steepest fall to them (rounds until none moves);
//   tally    the height each land cell lost, summed by the tier-0 cell it lies in (and the number of land cells it holds);
//   lift     every land cell of a parent rises by the parent's mean loss, so the parent's total height is what it was (a remainder is carried).
import { FIXED } from "./fixed";

// Fields of E (flat cells, one i32 word each).
export const RF = { H: 0, W: 1, TO: 2, RD: 3, UA: 4, UB: 5, DA: 6, DB: 7, DP: 8, ORD: 9, ACC: 10, ER: 11, RHO: 12, KQ: 13, TQ: 14, COUNT: 15 } as const;
// Fields below SPLIT live in E, the rest in E2: tier 4's thirteen fields of 100 million words are 5.2 GB, over a buffer's 4 GB.
export const SPLIT = 7;
export const MAXD = 16382; // the deepest flow path the counting sort holds, in cells
export const HIST = 16384;
// AT words after the flooded surface (N words): the depth histogram, its cursors, the start of each depth's run, 16 counters, then three words for each tier-0 cell (loss, land count, carry).
export const CNT = { flags: 0, top: 1, changed: 2, pending: 3 } as const;
export const FLAG = { chain: 1, depth: 2, area: 4 } as const;
// Words a tier-0 cell holds in X: [0] the rock's erodibility (a pool-weighted K word), [1] the area weight (Q15 of the mean cell), [2..9] eight inverse distances (Q28 of 1/m at the tier's
// spacing), [10..17] the distance to each of the eight neighbours (Q16 m), [18] the rock's threshold slope (tan, Q20), [19] the year's rain over the reference rain (Q8), [20..27] each
// direction's creep coefficient for one step (D dt weight / d^2, Q24). The erodibility, the threshold slope and the rain are read at a cell by interpolating the four tier-0 cells round
// it (`smooth`), not as one value to a block, so none steps at a block's edge.
// ...[28..35] the distance to each of the eight knight-move cells (Q16 m), the slides' 16-neighbour reach.
export const XSTRIDE = 36;

// The neighbours the flood and the receivers read: 8, as the island's flood and receivers do (terrain-upstream.ts flround, recv; an earlier note here said 4, which the island does not), or 4,
// which sends water along rows and columns only; the landslides read all 8.
export const FLOW_NEIGHBOURS: 4 | 8 = 8;
// The sweeps of the uplift's solve (even, so the coefficients end in the buffer they started in): a damped sweep contracts the stencil's worst mode by 0.83, so 128 leave under 1e-10 of the error
// of the first guess [derived].
export const SOLVE_SWEEPS = 128;
// `patch` lays the kernels on a patch (src/gpu/globe/patch.ts: a block of tiles and a halo of cells all round it, side * side cells flat, the global cell id of each in the IDS binding, a
// cube corner's missing cell NONE) instead of the whole tier: a cell's neighbours are its neighbours in the patch, its place is read from IDS, and the cells of the halo are read and never
// written (`interior`). Every law is the same text in both layouts.
export function regionalWgsl(edges: readonly (readonly { face: number; side: number; flip: boolean }[])[], fn: number, nflow: 4 | 8 = FLOW_NEIGHBOURS, patch?: { side: number; halo: number }, slideN: 8 | 16 = 8): string {
  const P = patch !== undefined;
  const flat = edges.flatMap((e) => e);
  const fields = Object.entries(RF).filter(([k]) => k !== "COUNT").map(([k, v]) => `const E_${k}: u32 = ${v}u;`).join("\n");
  return /* wgsl */ `${FIXED}
const FN = ${fn}u; const FNI = ${fn}i; const CELLS = ${fn * fn}u; const N = ${P ? patch.side * patch.side : 6 * fn * fn}u; const NP = 393216u; const FACT = ${fn / 256}u; const NFLOW = ${nflow}u;
const SIDE = ${P ? patch.side : 0}u; const HALO = ${P ? patch.halo : 0}u; const SLIDEN = ${slideN}u;
const KNIGHT = array<vec2i, 8>(vec2i(2, 1), vec2i(1, 2), vec2i(-1, 2), vec2i(-2, 1), vec2i(-2, -1), vec2i(-1, -2), vec2i(1, -2), vec2i(2, -1));
const EDGE_FACE = array<u32, 24>(${flat.map((e) => `${e.face}u`).join(", ")});
const EDGE_SIDE = array<u32, 24>(${flat.map((e) => `${e.side}u`).join(", ")});
const EDGE_FLIP = array<u32, 24>(${flat.map((e) => (e.flip ? "1u" : "0u")).join(", ")});
const DXY = array<vec2i, 8>(vec2i(1, 0), vec2i(0, 1), vec2i(-1, 0), vec2i(0, -1), vec2i(1, 1), vec2i(-1, 1), vec2i(-1, -1), vec2i(1, -1));
@group(0) @binding(0) var<storage, read> P: array<u32>;
@group(0) @binding(1) var<storage, read_write> E: array<i32>;
@group(0) @binding(2) var<storage, read_write> AT: array<atomic<i32>>;
@group(0) @binding(3) var<storage, read> X: array<u32>;
@group(0) @binding(4) var<storage, read_write> E2: array<i32>;
${P ? "@group(0) @binding(5) var<storage, read> IDS: array<u32>;" : ""}

${fields}
const MAXD = ${MAXD}u; const SPLIT = ${P ? RF.COUNT : SPLIT}u;
const A_HIST = N; const A_CUR = N + ${HIST}u; const A_LVS = N + ${2 * HIST}u; const A_CNT = N + ${3 * HIST}u; const A_PS = A_CNT + 16u; const A_PC = A_PS + NP; const A_CARRY = A_PC + NP; const A_PM = A_CARRY + NP; const A_PL = A_PM + NP; const A_ST = A_PL + NP; const A_PM2 = A_ST + 9u * NP;
const INF = 0x7fffffffi;
const NONE = 0xffffffffu;
const CNT_FLAGS = ${CNT.flags}u; const CNT_TOP = ${CNT.top}u; const CNT_CHANGED = ${CNT.changed}u; const CNT_PENDING = ${CNT.pending}u;
const FLAG_CHAIN = ${FLAG.chain}i; const FLAG_DEPTH = ${FLAG.depth}i; const FLAG_AREA = ${FLAG.area}i;

fn touch() { _ = P[0]; _ = E[0]; _ = atomicLoad(&AT[0]); _ = X[0]; _ = E2[0]; ${P ? "_ = IDS[0];" : ""} }
fn gk(g: vec3u, n: vec3u) -> u32 { return g.x + g.y * n.x * 256u; }
fn e_get(f: u32, k: u32) -> i32 { if (f < SPLIT) { return E[f * N + k]; } return E2[(f - SPLIT) * N + k]; }
fn e_set(f: u32, k: u32, v: i32) { if (f < SPLIT) { E[f * N + k] = v; } else { E2[(f - SPLIT) * N + k] = v; } }
fn e_getu(f: u32, k: u32) -> u32 { return bitcast<u32>(e_get(f, k)); }
fn e_setu(f: u32, k: u32, v: u32) { e_set(f, k, bitcast<i32>(v)); }
fn fl(k: u32) -> i32 { return atomicLoad(&AT[k]); }
fn flag(f: i32) { atomicOr(&AT[A_CNT + CNT_FLAGS], f); }
fn is_land(k: u32) -> bool { return e_get(E_H, k) > 0i; }
// the global id of cell k (the cell's own number in the whole tier; a patch holds it in IDS) and whether the kernels may write it (all of a tier's cells; a patch's interior)
${P ? `fn cid(k: u32) -> u32 { return IDS[k]; }
fn interior(k: u32) -> bool { let x = k % SIDE; let y = k / SIDE; return x >= HALO && x < SIDE - HALO && y >= HALO && y < SIDE - HALO; }` : `fn cid(k: u32) -> u32 { return k; }
fn interior(k: u32) -> bool { return true; }`}
// the tier-0 cell a cell lies in
fn pid(k: u32) -> u32 {
  let c = cid(k); let f = c / CELLS; let r = c - f * CELLS; let y = r / FN; let x = r - y * FN;
  return (f * 256u + y / FACT) * 256u + x / FACT;
}
fn invd(k: u32, d: u32) -> u32 { return X[pid(k) * ${XSTRIDE}u + 2u + d]; }

// The cell next to k in direction d (0 east, 1 north, 2 west, 3 south, 4 NE, 5 NW, 6 SW, 7 SE), across a face's edge where it is one: grid.ts
// haloSource. NONE at a cube's corner, where the diagonal cell does not exist.
${P ? `fn nbr(k: u32, d: u32) -> u32 {
  let x = i32(k % SIDE); let y = i32(k / SIDE); let o = DXY[d]; let nx = x + o.x; let ny = y + o.y;
  if (nx < 0 || ny < 0 || nx >= i32(SIDE) || ny >= i32(SIDE)) { return NONE; }
  let j = u32(ny) * SIDE + u32(nx);
  if (IDS[j] == NONE) { return NONE; }
  return j;
}` : `fn nbr(k: u32, d: u32) -> u32 {
  let f = k / CELLS; let r = k - f * CELLS; let y = i32(r / FN); let x = i32(r - u32(y) * FN);
  let o = DXY[d]; let nx = x + o.x; let ny = y + o.y;
  let xo = nx < 0 || nx >= FNI; let yo = ny < 0 || ny >= FNI;
  if (!xo && !yo) { return u32(i32(k) + o.y * FNI + o.x); }
  if (xo && yo) { return NONE; }
  var s = 1u; var along = nx;
  if (xo) { s = select(0u, 2u, nx < 0); along = ny; } else { s = select(1u, 3u, ny < 0); }
  let e = f * 4u + s;
  let gs = EDGE_SIDE[e];
  let a = select(along, FNI - 1 - along, EDGE_FLIP[e] == 1u);
  var gx = a; var gy = a;
  if (gs == 0u) { gx = FNI - 1; } else if (gs == 1u) { gy = FNI - 1; } else if (gs == 2u) { gx = 0; } else { gy = 0; }
  return EDGE_FACE[e] * CELLS + u32(gy) * FN + u32(gx);
}`}

// each land cell's discharge weight: its area weight times its rain over the reference rain, in 1/512 of the mean cell (Q15 area, Q8 rain, shift 14)
@compute @workgroup_size(256)
fn weights(@builtin(global_invocation_id) gid: vec3u, @builtin(num_workgroups) nwg: vec3u) {
  touch();
  let k = gk(gid, nwg);
  if (k >= N) { return; }
  var w = 0u;
  if (interior(k) && is_land(k)) { w = (X[pid(k) * ${XSTRIDE}u + 1u] * e_getu(E_RHO, k) + 8192u) >> 14u; }
  e_setu(E_W, k, w);
  e_set(E_ER, k, 0i);
}

// ---- the priority flood ----
@compute @workgroup_size(256)
fn flinit(@builtin(global_invocation_id) gid: vec3u, @builtin(num_workgroups) nwg: vec3u) {
  touch();
  let k = gk(gid, nwg);
  if (k >= N) { return; }
  atomicStore(&AT[k], select(e_get(E_H, k), INF, is_land(k)));
}
@compute @workgroup_size(256)
fn flood(@builtin(global_invocation_id) gid: vec3u, @builtin(num_workgroups) nwg: vec3u) {
  touch();
  let k = gk(gid, nwg);
  if (k >= N) { return; }
  if (!interior(k) || !is_land(k)) { return; }
  var m = INF;
  for (var d = 0u; d < NFLOW; d++) {
    let j = nbr(k, d);
    if (j != NONE) { m = min(m, fl(j)); }
  }
  if (m == INF) { return; }
  let cand = max(e_get(E_H, k), m + bitcast<i32>(P[0]));
  if (cand >= fl(k)) { return; }
  atomicMin(&AT[k], cand);
  atomicAdd(&AT[A_CNT + CNT_CHANGED], 1i);
}

// ---- receivers: steepest descent on the flooded surface, the sea ending every river ----
// With the routing parameter P[3] = 1 the receiver is instead drawn among the lower neighbours with the probability proportional to the fall to each over its distance, anew each step (P[2]):
// the draw Tarboton 1997 reads Fairfield and Leymarie 1991 to make, their remedy for the grid bias of steepest descent, which sends water down any slope within 22.5 degrees of a lattice
// direction along that direction. Every lower neighbour is a valid receiver (the flooded surface falls strictly along it), so the forest stays a forest; the draw is a Philox word of the cell's
// own id, so it is the same for the same cell whatever the tiling.
// With P[3] = 2 (Rho8, Fairfield and Leymarie 1991 as WhiteboxTools rho8_pointer has it: the fall to a cardinal neighbour over 1, to a diagonal one over 2 - r, r uniform in [0, 1), a draw
// for each diagonal link and step) the receiver is the steepest of those: the lower neighbours only, so again every receiver is strictly lower on the flooded surface and no chain can loop.
// On the sphere the diagonal link has its own length (the table's inverse length), so the draw scales that link by (2 - r) / sqrt 2, which is 2 - r on a square grid, where the diagonal
// is sqrt 2 long: in integers the link's inverse length is multiplied by sqrt 2 x 2^16 / (2 - r) / 2^16 (sqrt 2 x 2^16 = 92682). The incision still reads the link's true length.
fn philox(c0: vec4u, k0: vec2u) -> vec4u {
  var c = c0; var k = k0;
  for (var r = 0u; r < 10u; r++) {
    let x = mul64(0xD2511F53u, c.x); let y = mul64(0xCD9E8D57u, c.z);
    c = vec4u(y.y ^ c.y ^ k.x, y.x, x.y ^ c.w ^ k.y, x.x);
    k = k + vec2u(0x9E3779B9u, 0xBB67AE85u);
  }
  return c;
}
@compute @workgroup_size(256)
fn recv(@builtin(global_invocation_id) gid: vec3u, @builtin(num_workgroups) nwg: vec3u) {
  touch();
  let k = gk(gid, nwg);
  if (k >= N) { return; }
  var to = k; var rd = 0u; var best = vec2u(0u, 0u);
  var rw = vec4u(0u, 0u, 0u, 0u);
  if (P[3] == 2u && interior(k) && is_land(k)) { rw = philox(vec4u(cid(k), P[2], FN, 0x52484f38u), vec2u(0x4c414e44u, 0x524f5554u)); }
  if (interior(k) && is_land(k)) {
    let f = fl(k);
    var share = array<u32, 8>(0u, 0u, 0u, 0u, 0u, 0u, 0u, 0u); var total = 0u;
    for (var d = 0u; d < NFLOW; d++) {
      let j = nbr(k, d);
      if (j == NONE) { continue; }
      let dz = f - fl(j);
      if (dz <= 0i) { continue; }
      let iv = invd(k, d);
      var ev = iv;
      if (P[3] == 2u && d >= 4u) { ev = shr64(mul64(iv, (92682u << 15u) / ((131072u - (rw[d - 4u] & 0xffffu)) >> 1u)), 16u).x; }
      let key = mul64(u32(dz), ev);
      if (lt64(best, key)) { best = key; to = j; rd = iv; }
      let skey = mul64(u32(dz), iv);
      share[d] = max(1u, min(shr64(skey, 16u).x, 0x0fffffffu)); total += share[d];
    }
    if (P[3] == 1u && total > 0u) {
      let r = philox(vec4u(cid(k), P[2], 0u, 0x52434456u), vec2u(0x4c414e44u, 0x524f5554u)).x % total;
      var acc = 0u;
      for (var d = 0u; d < NFLOW; d++) {
        acc += share[d];
        if (share[d] != 0u && r < acc) { to = nbr(k, d); rd = invd(k, d); break; }
      }
    }
  }
  e_setu(E_TO, k, to);
  e_setu(E_RD, k, rd);
}

// ---- the tree: depth by pointer jumping, then the cells filed by depth ----
@compute @workgroup_size(256)
fn lvinit(@builtin(global_invocation_id) gid: vec3u, @builtin(num_workgroups) nwg: vec3u) {
  touch();
  let k = gk(gid, nwg);
  if (k >= N) { return; }
  let j = e_getu(E_TO, k);
  e_setu(E_UA, k, j);
  e_set(E_DA, k, select(1i, 0i, j == k));
  if (k <= MAXD + 1u) { atomicStore(&AT[A_HIST + k], 0i); }
  if (k == 0u) { atomicStore(&AT[A_CNT + CNT_TOP], 0i); }
}
fn jump(src: u32, srcd: u32, into: u32, intod: u32, k: u32) {
  let j = e_getu(src, k);
  e_setu(into, k, e_getu(src, j));
  e_set(intod, k, e_get(srcd, k) + e_get(srcd, j));
}
@compute @workgroup_size(256)
fn jumpa(@builtin(global_invocation_id) gid: vec3u, @builtin(num_workgroups) nwg: vec3u) {
  touch();
  let k = gk(gid, nwg);
  if (k >= N) { return; }
  jump(E_UA, E_DA, E_UB, E_DB, k);
}
@compute @workgroup_size(256)
fn jumpb(@builtin(global_invocation_id) gid: vec3u, @builtin(num_workgroups) nwg: vec3u) {
  touch();
  let k = gk(gid, nwg);
  if (k >= N) { return; }
  jump(E_UB, E_DB, E_UA, E_DA, k);
}
@compute @workgroup_size(256)
fn lvhist(@builtin(global_invocation_id) gid: vec3u, @builtin(num_workgroups) nwg: vec3u) {
  touch();
  let k = gk(gid, nwg);
  if (k >= N) { return; }
  let u = e_getu(E_UA, k);
  if (e_getu(E_TO, u) != u) { flag(FLAG_CHAIN); }
  let d = e_get(E_DA, k);
  e_set(E_DP, k, d);
  if (u32(d) > MAXD) { flag(FLAG_DEPTH); } else { atomicAdd(&AT[A_HIST + u32(d)], 1i); }
}
var<workgroup> wsum: array<i32, 256>;
@compute @workgroup_size(256)
fn lvscan(@builtin(local_invocation_index) t: u32) {
  touch();
  var local = 0i; var top = 0i;
  for (var j = 0u; j < 64u; j++) {
    let c = fl(A_HIST + t * 64u + j);
    local += c;
    if (c > 0i) { top = i32(t * 64u + j); }
  }
  wsum[t] = local;
  workgroupBarrier();
  var before = 0i;
  for (var u = 0u; u < t; u++) { before += wsum[u]; }
  var run = before;
  for (var j = 0u; j < 64u; j++) {
    let d = t * 64u + j;
    atomicStore(&AT[A_CUR + d], run);
    atomicStore(&AT[A_LVS + d], run);
    run += fl(A_HIST + d);
  }
  atomicMax(&AT[A_CNT + CNT_TOP], top);
}
@compute @workgroup_size(256)
fn lvscatter(@builtin(global_invocation_id) gid: vec3u, @builtin(num_workgroups) nwg: vec3u) {
  touch();
  let k = gk(gid, nwg);
  if (k >= N) { return; }
  let d = u32(e_get(E_DP, k));
  if (d <= MAXD) { let p = atomicAdd(&AT[A_CUR + d], 1i); e_set(E_ORD, u32(p), i32(k)); }
}

// ---- walks over the depths, one workgroup: the deepest first or the shallowest first, each level a barrier apart ----
var<workgroup> wtop: u32;
fn top_depth(t: u32) -> u32 {
  if (t == 0u) { wtop = u32(fl(A_CNT + CNT_TOP)); }
  workgroupBarrier();
  return workgroupUniformLoad(&wtop);
}
fn level_lo(d: u32) -> u32 { return u32(fl(A_LVS + d)); }
fn level_hi(d: u32, top: u32) -> u32 { return select(u32(fl(A_LVS + d + 1u)), N, d >= top); }

// the discharge area: a cell's own weight and everything that drains into it (saturating, with a flag)
@compute @workgroup_size(256)
fn area(@builtin(local_invocation_index) t: u32) {
  touch();
  let top = top_depth(t);
  for (var s = 0u; s <= top; s++) {
    let d = top - s;
    let lo = level_lo(d); let hi = level_hi(d, top);
    for (var p = lo + t; p < hi; p += 256u) {
      let k = u32(e_get(E_ORD, p));
      var a = e_getu(E_W, k);
      for (var e = 0u; e < 8u; e++) {
        let j = nbr(k, e);
        if (j != NONE && j != k && e_getu(E_TO, j) == k) {
          let c = e_getu(E_ACC, j);
          let sum = a + c;
          if (sum < a) { flag(FLAG_AREA); a = 0xffffffffu; } else { a = sum; }
        }
      }
      e_setu(E_ACC, k, a);
    }
    storageBarrier(); workgroupBarrier();
  }
}

// the same gather exact in 64 bits: each cell's weight and everything that drains into it, the low word in ACC and the high word in ER (free between steps), no overflow
// (the planet's whole weight must stay under 2^64, which any u32 weights over 2^28 cells do)
@compute @workgroup_size(256)
fn area64(@builtin(local_invocation_index) t: u32) {
  touch();
  let top = top_depth(t);
  for (var s = 0u; s <= top; s++) {
    let d = top - s;
    let lo = level_lo(d); let hi = level_hi(d, top);
    for (var p = lo + t; p < hi; p += 256u) {
      let k = u32(e_get(E_ORD, p));
      var a = vec2u(e_getu(E_W, k), 0u);
      for (var e = 0u; e < 8u; e++) {
        let j = nbr(k, e);
        if (j != NONE && j != k && e_getu(E_TO, j) == k) { a = add64(a, vec2u(e_getu(E_ACC, j), e_getu(E_ER, j))); }
      }
      e_setu(E_ACC, k, a.x);
      e_setu(E_ER, k, a.y);
    }
    storageBarrier(); workgroupBarrier();
  }
}

// the gather with signed weights and a mask word a cell (E_RD): bit 1 a cell whose negative sum passes down as nothing, bit 2 a cell whose sum is not passed down at all; the sums as 64-bit
// two's complement, the low word in ACC and the high in ER
@compute @workgroup_size(256)
fn areaS64(@builtin(local_invocation_index) t: u32) {
  touch();
  let top = top_depth(t);
  for (var s = 0u; s <= top; s++) {
    let d = top - s;
    let lo = level_lo(d); let hi = level_hi(d, top);
    for (var p = lo + t; p < hi; p += 256u) {
      let k = u32(e_get(E_ORD, p));
      let w = e_get(E_W, k);
      var a = vec2u(bitcast<u32>(w), select(0u, 0xffffffffu, w < 0i));
      for (var e = 0u; e < 8u; e++) {
        let j = nbr(k, e);
        if (j != NONE && j != k && e_getu(E_TO, j) == k) {
          let c = vec2u(e_getu(E_ACC, j), e_getu(E_ER, j)); let m = e_getu(E_RD, j);
          if ((m & 2u) == 0u && !((m & 1u) != 0u && isneg64(c))) { a = add64(a, c); }
        }
      }
      e_setu(E_ACC, k, a.x);
      e_setu(E_ER, k, a.y);
    }
    storageBarrier(); workgroupBarrier();
  }
}
// the nearest cell at or below each cell (down its receivers) whose flag (E_W, not 0) is set, NONE where there is none: the shallowest first
@compute @workgroup_size(256)
fn reach64(@builtin(local_invocation_index) t: u32) {
  touch();
  let top = top_depth(t);
  for (var d = 0u; d <= top; d++) {
    let lo = level_lo(d); let hi = level_hi(d, top);
    for (var p = lo + t; p < hi; p += 256u) {
      let k = u32(e_get(E_ORD, p));
      let j = e_getu(E_TO, k);
      var r = NONE;
      if (e_getu(E_W, k) != 0u) { r = k; } else if (j != k) { r = e_getu(E_ACC, j); }
      e_setu(E_ACC, k, r);
    }
    storageBarrier(); workgroupBarrier();
  }
}

// ---- the implicit stream power step, shallowest depth first ----
// n = 1 (m = 1/2): h' = h_r + (h - h_r) / (1 + f), f = K dt sqrt(A) / d, Braun and Willett 2013. A is the discharge area at the reference rain.
// a cell the step leaves as it is whatever its receiver does: sea, a lake (the flooded surface above it) or rock with no erodibility
fn incise_skip(k: u32) -> bool { let hk = e_get(E_H, k); return hk <= 0i || fl(k) > hk || e_getu(E_KQ, k) == 0u; }
// the step of a cell that is not skipped, given its receiver j at its final height
fn incise_one(k: u32, j: u32) {
  let hk = e_get(E_H, k);
  var hj = 0i;
  if (is_land(j)) { hj = e_get(E_H, j); }
  if (hj >= hk) { return; }
  let kc = e_getu(E_KQ, k);
  let acc = e_getu(E_ACC, k); let rd = e_getu(E_RD, k);
  let delta = u32(hk - hj);
  var x = delta;
  let s8 = sqrt64(vec2u(acc << 16u, acc >> 16u));
  let p1 = mul64(kc, rd);
  let p1s = select((p1.x >> 16u) | (p1.y << 16u), 0xffffffffu, (p1.y >> 16u) != 0u);
  let f64_ = shr64(mul64(p1s, s8), 16u);
  let f16 = select(f64_.x, 0x7fffffffu, f64_.y != 0u || f64_.x > 0x7fffffffu);
  if (f16 > 0u) {
    let u = divw(65536u, 0u, f16 + 65536u).x;
    x = umulsh(delta, u, 32u);
  }
  let nh = max(hj + i32(x), 1i);
  if (nh < hk) { e_set(E_ER, k, hk - nh); e_set(E_H, k, nh); }
}
@compute @workgroup_size(256)
fn incise(@builtin(local_invocation_index) t: u32) {
  touch();
  let top = top_depth(t);
  for (var d = 1u; d <= top; d++) {
    let lo = level_lo(d); let hi = level_hi(d, top);
    for (var p = lo + t; p < hi; p += 256u) {
      let k = u32(e_get(E_ORD, p));
      let j = e_getu(E_TO, k);
      if (j == k || incise_skip(k)) { continue; }
      incise_one(k, j);
    }
    storageBarrier(); workgroupBarrier();
  }
}
fn shr64(v: vec2u, s: u32) -> vec2u {
  if (s == 0u) { return v; }
  if (s >= 32u) { return vec2u(v.y >> (s - 32u), 0u); }
  return vec2u((v.x >> s) | (v.y << (32u - s)), v.y >> s);
}
fn sqrt64(n: vec2u) -> u32 {
  var r = 0u;
  for (var bit = 0x80000000u; bit != 0u; bit = bit >> 1u) {
    let c = r | bit;
    if (!lt64(n, mul64(c, c))) { r = c; }
  }
  return r;
}
fn umulsh(a: u32, b: u32, s: u32) -> u32 { return shr64(add64(mul64(a, b), vec2u(1u << (s - 1u), 0u)), s).x; }

// The cell at offset (dx, dy) of k, up to two cells away: in a patch the cell there in the patch (NONE past its edge or at a cube corner's missing cell), over the whole tier the cell the face's
// lattice continues to across an edge as patch.ts cellAcross lays it (NONE at a cube's corner), so that a patch of halo two and the whole tier see the same cells.
${P ? `fn nbr2(k: u32, dx: i32, dy: i32) -> u32 {
  let nx = i32(k % SIDE) + dx; let ny = i32(k / SIDE) + dy;
  if (nx < 0 || ny < 0 || nx >= i32(SIDE) || ny >= i32(SIDE)) { return NONE; }
  let j = u32(ny) * SIDE + u32(nx);
  if (IDS[j] == NONE) { return NONE; }
  return j;
}` : `fn nbr2(k: u32, dx: i32, dy: i32) -> u32 {
  let f = k / CELLS; let r = k - f * CELLS; let y = i32(r / FN); let x = i32(r - u32(y) * FN);
  let nx = x + dx; let ny = y + dy;
  let xo = nx < 0 || nx >= FNI; let yo = ny < 0 || ny >= FNI;
  if (!xo && !yo) { return u32(i32(k) + dy * FNI + dx); }
  if (xo && yo) { return NONE; }
  var s = 1u; var along = nx; var depth = 0;
  if (xo) { s = select(0u, 2u, nx < 0); along = ny; depth = select(nx - FNI, -nx - 1, nx < 0); } else { s = select(1u, 3u, ny < 0); depth = select(ny - FNI, -ny - 1, ny < 0); }
  let e = f * 4u + s;
  let gs = EDGE_SIDE[e];
  let a = select(along, FNI - 1 - along, EDGE_FLIP[e] == 1u);
  var gx = a; var gy = a;
  if (gs == 0u) { gx = FNI - 1 - depth; } else if (gs == 1u) { gy = FNI - 1 - depth; } else if (gs == 2u) { gx = depth; } else { gy = depth; }
  return EDGE_FACE[e] * CELLS + u32(gy) * FN + u32(gx);
}`}

// ---- the threshold hillslopes: the greatest surface under the heights with no fall steeper than the rock's threshold (the sea at 0 beside the coast) ----
// The eight neighbours alone give an envelope that is an octagonal cone round every peak (the least over the neighbours of h + tan(threshold) d, with d the length of the one-step path: the
// surface is planar between rays at multiples of 45 degrees, so a slope reads as streaks at 45 degrees); with the eight knight moves too (SLIDEN 16) the cone has sixteen sides, which is
// within 3% of round [derived: the longest of the two metrics' difference is 1 - cos(22.5 degrees) = 0.076 for eight directions and 1 - cos(11.25 degrees) = 0.019 for sixteen].
@compute @workgroup_size(256)
fn slide(@builtin(global_invocation_id) gid: vec3u, @builtin(num_workgroups) nwg: vec3u) {
  touch();
  let k = gk(gid, nwg);
  if (k >= N) { return; }
  if (!interior(k)) { return; }
  let h = e_get(E_H, k);
  if (h <= 1i) { return; }
  let base = pid(k) * ${XSTRIDE}u + 10u; let tq = e_getu(E_TQ, k);
  var lim = h;
  for (var d = 0u; d < 8u; d++) {
    let j = nbr(k, d);
    if (j == NONE) { continue; }
    lim = min(lim, max(e_get(E_H, j), 0i) + i32(shr64(mul64(tq, X[base + d]), 28u).x));
  }
  if (SLIDEN == 16u) {
    for (var q = 0u; q < 8u; q++) {
      let j = nbr2(k, KNIGHT[q].x, KNIGHT[q].y);
      if (j == NONE) { continue; }
      lim = min(lim, max(e_get(E_H, j), 0i) + i32(shr64(mul64(tq, X[pid(k) * ${XSTRIDE}u + 28u + q]), 28u).x));
    }
  }
  let nh = max(lim, 1i);
  if (nh < h) {
    e_set(E_ER, k, e_get(E_ER, k) + (h - nh));
    e_set(E_H, k, nh);
    atomicAdd(&AT[A_CNT + CNT_CHANGED], 1i);
  }
}

// ---- the uplift: what each tier-0 cell's land cells lost comes back as a smooth field, the tier-0 cell's total height kept ----
// Every land cell of a tier-0 cell rises by the mean height that cell's land cells lost, so the cell's total is the planet's [design, R1762]; the mean is read at each
// land cell by the bilinear interpolation, in the face's index space, of the means of the four tier-0 cells round it (the weights regional.ts remap uses), not as one
// constant to a block, whose edges stood as steps of 3 to 4 times the slope inside a block [measured, tiers 2 to 4]. The interpolated rises add up to a little more or less
// than the cell's loss: the difference is returned once more the same way, then spread evenly (a constant of the difference over the land cells it leaves, which is small)
// and the rest, under one unit a cell, or a deficit the next steps pay (a cell is never lowered by it), is carried. Total height plus carry of every tier-0 cell is kept exactly.
@compute @workgroup_size(256)
fn pzero(@builtin(global_invocation_id) gid: vec3u, @builtin(num_workgroups) nwg: vec3u) {
  touch();
  let p = gk(gid, nwg);
  if (p >= NP) { return; }
  atomicStore(&AT[A_PS + p], 0i);
  atomicStore(&AT[A_PC + p], 0i);
  atomicStore(&AT[A_PL + p], 0i);
}
// the land cells of each tier-0 cell, and what they lost (a patch tallies the two at different times: the count once, the loss after each stage's visit)
fn tally_count(k: u32) { if (interior(k) && is_land(k)) { atomicAdd(&AT[A_PC + pid(k)], 1i); } }
fn tally_loss(k: u32) { if (interior(k) && is_land(k)) { atomicAdd(&AT[A_PS + pid(k)], e_get(E_ER, k)); } }
@compute @workgroup_size(256)
fn tally(@builtin(global_invocation_id) gid: vec3u, @builtin(num_workgroups) nwg: vec3u) {
  touch();
  let k = gk(gid, nwg);
  if (k >= N) { return; }
  tally_count(k);
  tally_loss(k);
}
// the tier-0 cell next to p in direction d (0 east, 1 north, 2 west, 3 south, 4 NE, 5 NW, 6 SW, 7 SE), across a face's edge where it is one; NONE at a cube's corner's missing diagonal
fn pnbr(p: u32, d: u32) -> u32 {
  let f = p / 65536u; let r = p - f * 65536u; let y = i32(r / 256u); let x = i32(r - u32(y) * 256u);
  let o = DXY[d]; let nx = x + o.x; let ny = y + o.y;
  let xo = nx < 0 || nx >= 256; let yo = ny < 0 || ny >= 256;
  if (!xo && !yo) { return u32(i32(p) + o.y * 256 + o.x); }
  if (xo && yo) { return NONE; }
  var s = 1u; var along = nx;
  if (xo) { s = select(0u, 2u, nx < 0); along = ny; } else { s = select(1u, 3u, ny < 0); }
  let e = f * 4u + s;
  let gs = EDGE_SIDE[e];
  let a = select(along, 255 - along, EDGE_FLIP[e] == 1u);
  var gx = a; var gy = a;
  if (gs == 0u) { gx = 255; } else if (gs == 1u) { gy = 255; } else if (gs == 2u) { gx = 0; } else { gy = 0; }
  return EDGE_FACE[e] * 65536u + u32(gy) * 256u + u32(gx);
}
// the signed 64-bit n over a positive u32 d, rounded toward zero, for a quotient that fits 31 bits
fn sdiv(neg: bool, n: vec2u, d: u32) -> i32 {
  let qh = n.y / d;
  let q = i32(divw(n.y - qh * d, n.x, d).x);
  return select(q, -q, neg);
}
// a mean loss, Q8, of the tier-0 cell p: (loss + carry) * 256 / the land cells, or 0 where it has no land or owes nothing
fn mean_q8(p: u32, extra: i32) -> i32 {
  let c = fl(A_PC + p);
  if (c == 0i) { return 0i; }
  let tot = extra;
  if (tot <= 0i) { return 0i; }
  return sdiv(false, mul64(u32(tot), 256u), u32(c));
}
@compute @workgroup_size(256)
fn pmean(@builtin(global_invocation_id) gid: vec3u, @builtin(num_workgroups) nwg: vec3u) {
  touch();
  let p = gk(gid, nwg);
  if (p >= NP) { return; }
  atomicStore(&AT[A_PM + p], mean_q8(p, fl(A_PS + p) + fl(A_CARRY + p)));
}
// The rise of a land cell is the quadratic B-spline interpolation of coefficients m on the tier-0 cells round it (the nine whose centres lie within one cell, the weights along an axis for a cell
// at offset u from its tier-0 centre, |u| < 1/2: (1/2 - u)^2 / 2, 3/4 - u^2 and (1/2 + u)^2 / 2 for the neighbour on the low side, the cell itself and the one on the high side; those with no land
// left out): lift_at gives them as integers over a common denominator. It is the limit of the 3/4, 1/4 stencil the tiers' heights are carried down by (refineSmooth, child4: Chaikin's corner
// cutting, whose limit curve is the quadratic B-spline), so it is as smooth as the surface it adds to: C1, where the bilinear weights it replaces had a crease along every tier-0 centre line
// (the second difference of the heights at the two cells beside a centre was 2 to 2.5 times its value elsewhere on the range [measured: 6.2 and 6.4 m against 2.6]). The coefficients are
// solved (psolve) so that the land of every tier-0 cell rises by exactly what it lost.
struct LiftAt { p: array<u32, 9>, s: array<u32, 9>, w: array<u32, 9> }
fn lift_at(k: u32) -> LiftAt {
  let c = cid(k); let f = c / CELLS; let r = c - f * CELLS; let Y = r / FN; let X = r - Y * FN;
  let B = i32(FACT); let ax = 2 * i32(X % FACT) + 1 - B; let ay = 2 * i32(Y % FACT) + 1 - B;
  // numerators over 8 B^2 for the neighbour on the low side, the cell, the one on the high side
  let wx = array<u32, 3>(u32((B - ax) * (B - ax)), u32(2 * (3 * B * B - ax * ax)), u32((B + ax) * (B + ax)));
  let wy = array<u32, 3>(u32((B - ay) * (B - ay)), u32(2 * (3 * B * B - ay * ay)), u32((B + ay) * (B + ay)));
  let p = pid(k);
  var o: LiftAt;
  for (var m = 0u; m < 9u; m++) {
    // slot 0 is the cell itself; the others the directions 0 to 7 (0 east, 1 north, 2 west, 3 south, 4 NE, 5 NW, 6 SW, 7 SE)
    var dx = 0i; var dy = 0i; var slot = 8u;
    if (m > 0u) { slot = m - 1u; dx = DXY[slot].x; dy = DXY[slot].y; }
    o.s[m] = slot;
    o.p[m] = select(p, pnbr(p, slot), m > 0u);
    o.w[m] = wx[u32(dx + 1)] * wy[u32(dy + 1)];
    if (m > 0u && (o.p[m] == NONE || fl(A_PC + o.p[m]) == 0i)) { o.w[m] = 0u; }
  }
  return o;
}
// the interpolated coefficient at a land cell, Q8
fn interp(k: u32) -> i32 {
  let o = lift_at(k);
  var wsum = 0u; var pos = vec2u(0u, 0u); var neg = vec2u(0u, 0u);
  for (var j = 0u; j < 9u; j++) {
    if (o.w[j] == 0u) { continue; }
    wsum += o.w[j];
    let m = fl(A_PM + o.p[j]);
    if (m >= 0i) { pos = add64(pos, mul64(u32(m), o.w[j])); } else { neg = add64(neg, mul64(u32(-m), o.w[j])); }
  }
  if (lt64(pos, neg)) { return sdiv(true, add64(vec2u(neg.x - pos.x, neg.y - pos.y - select(0u, 1u, neg.x < pos.x)), vec2u(wsum >> 1u, 0u)), wsum); }
  return sdiv(false, add64(vec2u(pos.x - neg.x, pos.y - neg.y - select(0u, 1u, pos.x < neg.x)), vec2u(wsum >> 1u, 0u)), wsum);
}
// every land cell rises (or sinks, where the coefficients are negative; never under one unit) by the interpolated coefficients
fn raise(k: u32) {
  if (!interior(k) || !is_land(k)) { return; }
  let h = e_get(E_H, k);
  let nh = max(1i, h + (interp(k) >> 8u));
  e_set(E_H, k, nh);
  atomicAdd(&AT[A_PL + pid(k)], nh - h);
}
@compute @workgroup_size(256)
fn lift(@builtin(global_invocation_id) gid: vec3u, @builtin(num_workgroups) nwg: vec3u) {
  touch();
  let k = gk(gid, nwg);
  if (k >= N) { return; }
  raise(k);
}
// The stencil of the solve: the land of tier-0 cell p rises, summed over its cells, by (the sum over the nine tier-0 cells q round p, slot s, of ST[p][s] * m[q]) / 2^16 / 256 units, ST the
// cells' normalized weights (Q16, each cell's four summing to 2^16 exactly) added up by the slot of the neighbour they fall on (the slots are the neighbour directions 0 to 7 and 8 the cell
// itself). It depends on which cells are land and where, so it is made once, after the land cells of every tier-0 cell are counted.
@compute @workgroup_size(256)
fn pstzero(@builtin(global_invocation_id) gid: vec3u, @builtin(num_workgroups) nwg: vec3u) {
  touch();
  let p = gk(gid, nwg);
  if (p >= NP) { return; }
  for (var s = 0u; s < 9u; s++) { atomicStore(&AT[A_ST + p * 9u + s], 0i); }
}
@compute @workgroup_size(256)
fn pstencil(@builtin(global_invocation_id) gid: vec3u, @builtin(num_workgroups) nwg: vec3u) {
  touch();
  let k = gk(gid, nwg);
  if (k >= N) { return; }
  if (!interior(k) || !is_land(k)) { return; }
  let o = lift_at(k);
  var wsum = 0u;
  for (var j = 0u; j < 9u; j++) { wsum += o.w[j]; }
  var rest = 65536u;
  for (var j = 1u; j < 9u; j++) {
    if (o.w[j] == 0u) { continue; }
    let q = divw(mul64(o.w[j], 65536u).y, mul64(o.w[j], 65536u).x, wsum).x;
    atomicAdd(&AT[A_ST + o.p[0] * 9u + o.s[j]], i32(q));
    rest -= q;
  }
  atomicAdd(&AT[A_ST + o.p[0] * 9u + 8u], i32(rest));
}
// One Jacobi sweep of the solve from the coefficients in one buffer to the other (the coefficients start as the mean loss, pmean): m[p] moves by what the land of p is short of its
// loss (and carry), over its own weight. A coefficient may be negative: where one tier-0 cell loses a great deal beside cells that lose little, the field that is smooth and holds every
// mean has to dip beside the peak. The B-spline stencil's smooth modes make a plain Jacobi sweep overshoot (its factor is -1.25 there), so a sweep moves two thirds of the way (factors between -0.5 and 0.83); the carry is what rounding, a cell held at one unit or a
// cell next to the cube's corner leaves, and is paid in the next step's loss.
fn solve_sweep(p: u32, src: u32, dst: u32) {
  let c = fl(A_PC + p);
  if (c == 0i) { atomicStore(&AT[dst + p], 0i); return; }
  var pos = vec2u(0u, 0u); var neg = vec2u(0u, 0u);
  for (var s = 0u; s < 9u; s++) {
    var q = p;
    if (s < 8u) { q = pnbr(p, s); }
    if (q == NONE) { continue; }
    let w = u32(fl(A_ST + p * 9u + s)); let mq = fl(src + q);
    if (mq >= 0i) { pos = add64(pos, mul64(w, u32(mq))); } else { neg = add64(neg, mul64(w, u32(-mq))); }
  }
  let tot = fl(A_PS + p) + fl(A_CARRY + p);
  // pos - neg = tot << 24 is the equation, as lo = pos + the negative part of the aim and hi = the positive part of the aim + neg
  let lo = select(pos, add64(pos, mul64(u32(-tot), 1u << 24u)), tot < 0i);
  let hi = select(neg, add64(neg, mul64(u32(tot), 1u << 24u)), tot > 0i);
  let own = u32(fl(A_ST + p * 9u + 8u));
  var nm = fl(src + p);
  if (lt64(lo, hi)) {
    let d = sdiv(false, vec2u(hi.x - lo.x, hi.y - lo.y - select(0u, 1u, hi.x < lo.x)), own);
    nm = min(nm + d - d / 3i, 0x3fffffffi);
  } else {
    let d = sdiv(false, vec2u(lo.x - hi.x, lo.y - hi.y - select(0u, 1u, lo.x < hi.x)), own);
    nm = max(nm - d + d / 3i, -0x3fffffffi);
  }
  atomicStore(&AT[dst + p], nm);
}
@compute @workgroup_size(256)
fn psolve(@builtin(global_invocation_id) gid: vec3u, @builtin(num_workgroups) nwg: vec3u) {
  touch();
  let p = gk(gid, nwg);
  if (p >= NP) { return; }
  solve_sweep(p, A_PM, A_PM2);
}
@compute @workgroup_size(256)
fn psolve2(@builtin(global_invocation_id) gid: vec3u, @builtin(num_workgroups) nwg: vec3u) {
  touch();
  let p = gk(gid, nwg);
  if (p >= NP) { return; }
  solve_sweep(p, A_PM2, A_PM);
}
@compute @workgroup_size(256)
fn pcarry(@builtin(global_invocation_id) gid: vec3u, @builtin(num_workgroups) nwg: vec3u) {
  touch();
  let p = gk(gid, nwg);
  if (p >= NP) { return; }
  if (fl(A_PC + p) == 0i) { return; }
  atomicStore(&AT[A_CARRY + p], fl(A_PS + p) + fl(A_CARRY + p) - fl(A_PL + p));
}
// ---- the rock, the threshold slope and the rain at each cell: the four tier-0 cells round it weighted by the cell's place, as interp weights them ----
fn interpx(k: u32, wd: u32) -> u32 {
  let c = cid(k); let f = c / CELLS; let r = c - f * CELLS; let cy = r / FN; let cx = r - cy * FN;
  let ix = i32(cx % FACT); let iy = i32(cy % FACT); let B = i32(FACT);
  let wxn = u32(abs(2 * ix + 1 - B)) * (32768u / FACT); let wyn = u32(abs(2 * iy + 1 - B)) * (32768u / FACT);
  let wxc = 65536u - wxn; let wyc = 65536u - wyn;
  let p = pid(k);
  let dxs = select(0u, 2u, 2 * ix + 1 < B);
  let dys = select(1u, 3u, 2 * iy + 1 < B);
  var dd = 4u;
  if (dxs == 2u && dys == 1u) { dd = 5u; } else if (dxs == 2u && dys == 3u) { dd = 6u; } else if (dxs == 0u && dys == 3u) { dd = 7u; }
  let px = pnbr(p, dxs); let py = pnbr(p, dys); let pd = pnbr(p, dd);
  var w = array<u32, 4>(shr64(mul64(wxc, wyc), 16u).x, 0u, 0u, 0u);
  var v = array<u32, 4>(X[p * ${XSTRIDE}u + wd], 0u, 0u, 0u);
  if (px != NONE) { w[1] = shr64(mul64(wxn, wyc), 16u).x; v[1] = X[px * ${XSTRIDE}u + wd]; }
  if (py != NONE) { w[2] = shr64(mul64(wxc, wyn), 16u).x; v[2] = X[py * ${XSTRIDE}u + wd]; }
  if (pd != NONE) { w[3] = shr64(mul64(wxn, wyn), 16u).x; v[3] = X[pd * ${XSTRIDE}u + wd]; }
  var wsum = 0u; var acc = vec2u(0u, 0u);
  for (var j = 0u; j < 4u; j++) { wsum += w[j]; acc = add64(acc, mul64(v[j], w[j])); }
  let n = add64(acc, vec2u(wsum >> 1u, 0u));
  return divw(n.y, n.x, wsum).x;
}
@compute @workgroup_size(256)
fn cellmeans(@builtin(global_invocation_id) gid: vec3u, @builtin(num_workgroups) nwg: vec3u) {
  touch();
  let k = gk(gid, nwg);
  if (k >= N) { return; }
  e_setu(E_KQ, k, interpx(k, 0u));
  e_setu(E_TQ, k, interpx(k, 18u));
  e_setu(E_RHO, k, interpx(k, 19u));
}

// ---- hillslope creep: dh = D dt (9-point Laplacian) per step, in P[1] substeps, over land (the sea is the base at zero); what a cell loses or gains is booked like the rest ----
fn mulq24(a: i32, c: u32) -> i32 {
  let m = shr64(add64(mul64(u32(abs(a)), c), vec2u(1u << 23u, 0u)), 24u).x;
  return select(i32(m), -i32(m), a < 0i);
}
@compute @workgroup_size(256)
fn creep(@builtin(global_invocation_id) gid: vec3u, @builtin(num_workgroups) nwg: vec3u) {
  touch();
  let k = gk(gid, nwg);
  if (k >= N) { return; }
  let h = e_get(E_H, k);
  if (h <= 0i) { e_set(E_UA, k, h); return; }
  let base = pid(k) * ${XSTRIDE}u + 20u; let subs = max(1u, P[1]);
  var dh = 0i;
  for (var d = 0u; d < 8u; d++) {
    let j = nbr(k, d);
    if (j == NONE) { continue; }
    dh += mulq24(max(e_get(E_H, j), 0i) - h, X[base + d] / subs);
  }
  e_set(E_UA, k, max(1i, h + dh));
}
@compute @workgroup_size(256)
fn creepapply(@builtin(global_invocation_id) gid: vec3u, @builtin(num_workgroups) nwg: vec3u) {
  touch();
  let k = gk(gid, nwg);
  if (k >= N) { return; }
  if (!interior(k)) { return; }
  let h = e_get(E_H, k);
  if (h <= 0i) { return; }
  let nh = e_get(E_UA, k);
  e_set(E_ER, k, e_get(E_ER, k) + (h - nh));
  e_set(E_H, k, nh);
}
${P ? `
// ---- the patch layout's own kernels: what a tile-by-tile solve does between the laws (src/gpu/globe/regional-patch.ts) ----
@compute @workgroup_size(256)
fn erzero(@builtin(global_invocation_id) gid: vec3u, @builtin(num_workgroups) nwg: vec3u) {
  touch();
  let k = gk(gid, nwg);
  if (k >= N) { return; }
  e_set(E_ER, k, 0i);
}
@compute @workgroup_size(256)
fn tallyc(@builtin(global_invocation_id) gid: vec3u, @builtin(num_workgroups) nwg: vec3u) {
  touch();
  let k = gk(gid, nwg);
  if (k >= N) { return; }
  tally_count(k);
}
@compute @workgroup_size(256)
fn tallyl(@builtin(global_invocation_id) gid: vec3u, @builtin(num_workgroups) nwg: vec3u) {
  touch();
  let k = gk(gid, nwg);
  if (k >= N) { return; }
  tally_loss(k);
}
// the receiver of a cell from the direction kept for it (E_DB: 0 to 3, the flow neighbours, else its own: a sea cell or a cell of the halo, which a patch treats as a root)
@compute @workgroup_size(256)
fn todfrom(@builtin(global_invocation_id) gid: vec3u, @builtin(num_workgroups) nwg: vec3u) {
  touch();
  let k = gk(gid, nwg);
  if (k >= N) { return; }
  var to = k; var rd = 0u;
  if (interior(k)) {
    let d = e_getu(E_DB, k);
    if (d < NFLOW) { let j = nbr(k, d); if (j != NONE) { to = j; rd = invd(k, d); } }
  }
  e_setu(E_TO, k, to);
  e_setu(E_RD, k, rd);
}
// the same, with every interior cell that drains into a cell of the halo a root of its own: the pointer jumps then end at the cell that carries a chain out of the patch and not at the halo cell
// it drains into (with eight neighbours several cells of the patch's edge drain into one cell of the halo)
@compute @workgroup_size(256)
fn todexit(@builtin(global_invocation_id) gid: vec3u, @builtin(num_workgroups) nwg: vec3u) {
  touch();
  let k = gk(gid, nwg);
  if (k >= N) { return; }
  var to = k; var rd = 0u;
  if (interior(k)) {
    let d = e_getu(E_DB, k);
    if (d < NFLOW) { let j = nbr(k, d); if (j != NONE && interior(j)) { to = j; rd = invd(k, d); } }
  }
  e_setu(E_TO, k, to);
  e_setu(E_RD, k, rd);
}
// the direction of the receiver recv chose (255: none)
@compute @workgroup_size(256)
fn todir(@builtin(global_invocation_id) gid: vec3u, @builtin(num_workgroups) nwg: vec3u) {
  touch();
  let k = gk(gid, nwg);
  if (k >= N) { return; }
  var dir = 255u;
  let to = e_getu(E_TO, k);
  if (interior(k) && to != k) { for (var d = 0u; d < NFLOW; d++) { if (nbr(k, d) == to) { dir = d; } } }
  e_setu(E_DB, k, dir);
}
// which cells the incision has settled before any receiver is known: the sea, lakes, rock with no erodibility and the roots (E_W 1), the rest 0
@compute @workgroup_size(256)
fn resinit(@builtin(global_invocation_id) gid: vec3u, @builtin(num_workgroups) nwg: vec3u) {
  touch();
  let k = gk(gid, nwg);
  if (k >= N) { return; }
  e_set(E_W, k, select(0i, 1i, interior(k) && (incise_skip(k) || e_getu(E_TO, k) == k)));
}
// the incision of the cells whose receiver is settled (E_W 1), the shallowest first within the patch; a cell whose chain leaves the patch by a cell not yet settled waits
@compute @workgroup_size(256)
fn incisep(@builtin(local_invocation_index) t: u32) {
  touch();
  let top = top_depth(t);
  for (var d = 1u; d <= top; d++) {
    let lo = level_lo(d); let hi = level_hi(d, top);
    for (var p = lo + t; p < hi; p += 256u) {
      let k = u32(e_get(E_ORD, p));
      if (!interior(k) || e_get(E_W, k) != 0i) { continue; }
      let j = e_getu(E_TO, k);
      if (e_get(E_W, j) == 0i) { continue; }
      incise_one(k, j);
      e_set(E_W, k, 1i);
    }
    storageBarrier(); workgroupBarrier();
  }
}
@compute @workgroup_size(256)
fn rescount(@builtin(global_invocation_id) gid: vec3u, @builtin(num_workgroups) nwg: vec3u) {
  touch();
  let k = gk(gid, nwg);
  if (k >= N) { return; }
  if (interior(k) && e_get(E_W, k) == 0i) { atomicAdd(&AT[A_CNT + CNT_PENDING], 1i); }
}
// the discharge that enters the patch from beyond its edge (E_DP, u32 at the receiving interior cell) added to that cell's own weight
@compute @workgroup_size(256)
fn inject(@builtin(global_invocation_id) gid: vec3u, @builtin(num_workgroups) nwg: vec3u) {
  touch();
  let k = gk(gid, nwg);
  if (k >= N) { return; }
  if (interior(k)) { e_setu(E_W, k, e_getu(E_W, k) + e_getu(E_DP, k)); }
}
` : ""}
`;
}
