// The globe's grid on the GPU (host side and the rules: src/gpu/globe/grid.ts, docs/research/globe/2026-10-19-grid.md): the
// halo exchange that fills each tile's one-cell ring from the neighbouring tiles and faces, a least-squares gradient, and
// a conservative diffusion step. All integer: no float sits between a buffer read and a buffer write.
//
// Fields. A field on the sphere is one i32 word a cell, kept a tile at a time with a one-cell halo, so a tile is PAD by
// PAD words (258 by 258) and a kernel reads its four neighbours as plus or minus 1 and plus or minus PAD. A state buffer
// S holds several fields one after another; field f of tile slot s is at word f * FW + s * PAD * PAD + y * PAD + x with
// FW = tiles * PAD * PAD (the halo is x or y = 0 or 257). A tile slot is (face * T + ty) * T + tx with T tiles on a face's
// side. The tables T are the unpadded 256 by 256 tiles, field after field (TAB below), TW = tiles * 256 * 256 words a field.
//
// Parameters (P, u32): 0 T (tiles on a face's side), 1 cells on a face's side, 2 tiles in all, 3 halo mode, 4 and 5 the
// halo's fields, 6 to 9 the flux step's q and r in and out, 10 and 11 the gradient's east and north fields, 12 the
// diffusion number.
//
// Corners. At a cube's corner three cells meet and no cell stands diagonal to the corner cell of a tile. The halo's corner
// word there is the (rounded down) mean of the three cells that meet at that vertex, which makes the mean of the four cells
// round a vertex that every cell's 3 by 3 neighbourhood takes come out as the mean of the three, the same word in all three
// cells' tiles. The gradient gives that word no weight.
//
// Fixed point (a value x is held as round(x * 2^n), Qn; the formats are [design] choices, sized by the ranges below [derived];
// the host checks the bounds):
// - the cell's area weight a: Q15 of the mean cell's area, so a is 2^15 for an average cell and under 2^16 for every cell
//   (the flux step's division takes 16-bit limbs);
// - the field q: any integer scale; a tracer's mass in a cell is q * a + r with the remainder r in [0, a), so the sum of
//   q * a + r over the sphere is the conserved total, exactly, and a field of one value has no flux at all;
// - the gradient's weights: Q28; its answer: Q6 of the field's unit a cell's width (Delta = pi / 2 / cells, radians);
// - a link's two coefficients, kappa (the two-point flux) and the cross term's (the correction for the grid's lines not
//   crossing at right angles): Q24; the vertex weights: Q20, each vertex's summing to exactly 2^20;
// - the diffusion number fo = D dt / (the mean cell's area): Q24.
// Ranges: |q| under 2^20 (the differences the gradient and the flux take stay under 2^21).
import { FIXED } from "./fixed";

export const TILE = 256;
export const PAD = TILE + 2;
// Cells of a tile's halo ring: the east and west columns without their corners, the north and south rows with them.
export const RING = 2 * TILE + 2 * PAD;
// Table fields: A the area weight, K and C the four links' coefficients (east, north, west, south), V the weights of the
// cell's four corner vertices (corner c lies between directions c and c + 1, so NE, NW, SW, SE; each vertex has the weights
// of the four cells round it: the cell, its neighbour in direction c, its neighbour in direction c + 1, the one diagonal),
// W the gradient's sixteen weights (east component for the eight neighbours, then north; neighbours east, north, west,
// south, NE, NW, SW, SE).
export const TAB = { A: 0, K: 1, C: 5, V: 9, W: 25, COUNT: 41 } as const;
// vertex: the vertex weights, Q20 and summing to exactly 2^20; ends: the difference of the two ends' values is taken to Q6.
export const SHIFT = { area: 15, kappa: 24, cross: 24, grad: 6, weight: 28, fo: 24, vertex: 20, ends: 6 } as const;
// The parameter words.
export const PARAM = { tiles: 0, face: 1, count: 2, mode: 3, fa: 4, fb: 5, qIn: 6, rIn: 7, qOut: 8, rOut: 9, ge: 10, gn: 11, fo: 12, WORDS: 16 } as const;
// Halo modes: 0 copy; 1 a direction code (0 east, 1 north, 2 west, 3 south in the face's own axes, 4 and over none) turned by
// the axes' rotation; 2 a pair of components along the face's own axes (fields fa and fb) turned the same way.
export const HALO = { copy: 0, code: 1, pair: 2 } as const;

// edges: for each face f and side s (0 east, 1 north, 2 west, 3 south), the face across and its side that faces f.
export function globeWgsl(edges: readonly (readonly { face: number; side: number; flip: boolean }[])[]): string {
  const flat = edges.flatMap((e) => e);
  return /* wgsl */ `
${FIXED}
const TILE = ${TILE}i;
const PAD = ${PAD}u;
const PAD2 = ${PAD * PAD}u;
const EDGE_FACE = array<u32, 24>(${flat.map((e) => `${e.face}u`).join(", ")});
const EDGE_SIDE = array<u32, 24>(${flat.map((e) => `${e.side}u`).join(", ")});
const EDGE_FLIP = array<u32, 24>(${flat.map((e) => (e.flip ? "1u" : "0u")).join(", ")});

@group(0) @binding(0) var<storage, read_write> S: array<i32>;
@group(0) @binding(1) var<storage, read> T: array<i32>;
@group(0) @binding(2) var<storage, read> P: array<u32>;

fn flatIndex(g: vec3u, n: vec3u) -> u32 { return g.x + g.y * n.x * 256u; }

struct Src { ok: bool, face: u32, x: u32, y: u32, rot: u32 }

// The cell that stands where face (x, y) is, one cell past the face's edge at most: the same cell, or the cell across the
// edge with the quarter turns the axes take going there; none at a cube's corner, where x and y are both past the edge.
fn source(face: u32, x: i32, y: i32) -> Src {
  let n = i32(P[1]);
  let xo = x < 0 || x >= n; let yo = y < 0 || y >= n;
  if (xo && yo) { return Src(false, 0u, 0u, 0u, 0u); }
  if (!xo && !yo) { return Src(true, face, u32(x), u32(y), 0u); }
  var s = 1u; var along = x;
  if (xo) { s = select(0u, 2u, x < 0); along = y; } else { s = select(1u, 3u, y < 0); }
  let e = face * 4u + s;
  let gs = EDGE_SIDE[e];
  let a = select(along, n - 1 - along, EDGE_FLIP[e] == 1u);
  var gx = a; var gy = a;
  if (gs == 0u) { gx = n - 1; } else if (gs == 1u) { gy = n - 1; } else if (gs == 2u) { gx = 0; } else { gy = 0; }
  return Src(true, EDGE_FACE[e], u32(gx), u32(gy), (gs + 6u - s) & 3u);
}

// The word of field f at a cell's place in its tile.
fn wordOf(f: u32, c: Src) -> u32 {
  let t = P[0]; let fw = P[2] * PAD2;
  let slot = (c.face * t + (c.y >> 8u)) * t + (c.x >> 8u);
  return f * fw + slot * PAD2 + ((c.y & 255u) + 1u) * PAD + (c.x & 255u) + 1u;
}

fn turnCode(v: i32, rot: u32) -> i32 {
  if (v < 0 || v > 3) { return v; }
  return i32((u32(v) + 4u - rot) & 3u);
}
fn turnPair(u: i32, v: i32, rot: u32) -> vec2i {
  let k = (4u - rot) & 3u;
  if (k == 0u) { return vec2i(u, v); }
  if (k == 1u) { return vec2i(-v, u); }
  if (k == 2u) { return vec2i(-u, -v); }
  return vec2i(v, -u);
}
fn floorThird(s: i32) -> i32 { let q = s / 3; return select(q, q - 1, s < 0 && q * 3 != s); }

// One thread for each cell of every tile's halo ring.
@compute @workgroup_size(256)
fn halo(@builtin(global_invocation_id) gid: vec3u, @builtin(num_workgroups) nwg: vec3u) {
  _ = T[0];
  let idx = flatIndex(gid, nwg);
  if (idx >= P[2] * ${RING}u) { return; }
  let slot = idx / ${RING}u; let h = idx % ${RING}u;
  var pi = 0u; var pj = 0u;
  if (h < ${TILE}u) { pi = ${PAD - 1}u; pj = h + 1u; }
  else if (h < ${2 * TILE}u) { pi = 0u; pj = h - ${TILE}u + 1u; }
  else if (h < ${2 * TILE + PAD}u) { pj = ${PAD - 1}u; pi = h - ${2 * TILE}u; }
  else { pj = 0u; pi = h - ${2 * TILE + PAD}u; }
  let tn = P[0];
  let face = slot / (tn * tn); let rem = slot % (tn * tn);
  let tx = rem % tn; let ty = rem / tn;
  let gx = i32(tx * 256u + pi) - 1; let gy = i32(ty * 256u + pj) - 1;
  let fw = P[2] * PAD2;
  let at = slot * PAD2 + pj * PAD + pi;
  let n = i32(P[1]);
  let s = source(face, gx, gy);
  let mode = P[3]; let fa = P[4]; let fb = P[5];
  // At a cube's corner no cell stands diagonal to the corner cell: the mean of the three cells that meet there.
  var sa = Src(false, 0u, 0u, 0u, 0u); var sb = sa; var own = sa;
  if (!s.ok) {
    sa = source(face, gx, clamp(gy, 0, n - 1));
    sb = source(face, clamp(gx, 0, n - 1), gy);
    own = Src(true, face, u32(clamp(gx, 0, n - 1)), u32(clamp(gy, 0, n - 1)), 0u);
  }
  if (mode == ${HALO.pair}u) {
    var uv = vec2i(0, 0);
    if (s.ok) { uv = turnPair(S[wordOf(fa, s)], S[wordOf(fb, s)], s.rot); }
    else {
      let o = turnPair(S[wordOf(fa, own)], S[wordOf(fb, own)], 0u);
      let a = turnPair(S[wordOf(fa, sa)], S[wordOf(fb, sa)], sa.rot);
      let b = turnPair(S[wordOf(fa, sb)], S[wordOf(fb, sb)], sb.rot);
      uv = vec2i(floorThird(o.x + a.x + b.x), floorThird(o.y + a.y + b.y));
    }
    S[fa * fw + at] = uv.x; S[fb * fw + at] = uv.y;
    return;
  }
  var v = 4;
  if (mode == ${HALO.code}u) {
    if (s.ok) { v = turnCode(S[wordOf(fa, s)], s.rot); }
  } else if (s.ok) {
    v = S[wordOf(fa, s)];
  } else {
    v = floorThird(S[wordOf(fa, own)] + S[wordOf(fa, sa)] + S[wordOf(fa, sb)]);
  }
  S[fa * fw + at] = v;
}

fn smul(a: i32, b: i32) -> vec2u {
  let m = mul64(mag(a), mag(b));
  return select(m, neg64(m), (a < 0) != (b < 0));
}
// v * c for a signed 64-bit v and a u32 c, modulo 2^64.
fn smul64u(v: vec2u, c: u32) -> vec2u {
  let m = abs64(v);
  let p = mul64(m.x, c);
  let r = vec2u(p.x, p.y + m.y * c);
  return select(r, neg64(r), isneg64(v));
}
// v / 2^n rounded half away from zero, n in 1 to 31.
fn shrRound(v: vec2u, n: u32) -> vec2u {
  let m = add64(abs64(v), vec2u(1u << (n - 1u), 0u));
  let r = vec2u((m.x >> n) | (m.y << (32u - n)), m.y >> n);
  return select(r, neg64(r), isneg64(v));
}

const OFF = array<i32, 8>(1, ${PAD}, -1, -${PAD}, ${PAD + 1}, ${PAD - 1}, -${PAD + 1}, -${PAD - 1});

// The gradient of field qIn at every interior cell, east and north components, from the eight neighbours and the table's
// least-squares weights: Q6 of the field's unit a cell's width.
@compute @workgroup_size(256)
fn grad(@builtin(global_invocation_id) gid: vec3u, @builtin(num_workgroups) nwg: vec3u) {
  let idx = flatIndex(gid, nwg);
  let count = P[2] * 65536u;
  if (idx >= count) { return; }
  let slot = idx >> 16u; let c = idx & 65535u;
  let fw = P[2] * PAD2;
  let at = slot * PAD2 + ((c >> 8u) + 1u) * PAD + (c & 255u) + 1u;
  let q0 = S[P[6] * fw + at];
  var e = vec2u(0u, 0u); var n = vec2u(0u, 0u);
  for (var d = 0u; d < 8u; d++) {
    let dq = S[P[6] * fw + u32(i32(at) + OFF[d])] - q0;
    e = add64(e, smul(T[(${TAB.W}u + d) * count + idx], dq));
    n = add64(n, smul(T[(${TAB.W + 8}u + d) * count + idx], dq));
  }
  S[P[10] * fw + at] = bitcast<i32>(shrRound(e, ${SHIFT.weight - SHIFT.grad}u).x);
  S[P[11] * fw + at] = bitcast<i32>(shrRound(n, ${SHIFT.weight - SHIFT.grad}u).x);
}

// m / a for an unsigned 64-bit m and a under 2^16, by 16-bit limbs: the quotient (under 2^32) and the remainder.
fn divLimbs(m: vec2u, a: u32) -> vec2u {
  var rem = 0u; var q = 0u;
  for (var k = 0u; k < 4u; k++) {
    var limb = m.x & 0xffffu;
    if (k == 0u) { limb = m.y >> 16u; } else if (k == 1u) { limb = m.y & 0xffffu; } else if (k == 2u) { limb = m.x >> 16u; }
    let cur = (rem << 16u) | limb;
    q = (q << 16u) | (cur / a);
    rem = cur % a;
  }
  return vec2u(q, rem);
}

// The value at a vertex of cell i minus the cell's own: the sum of weight * (q_k - q_i) over the four cells round vertex
// corner c, Q20 (the weights sum to exactly 2^20, so this is the vertex's value less q_i exactly).
fn corner(at: u32, qi: u32, q0: i32, c: u32, idx: u32, count: u32) -> vec2u {
  var sum = vec2u(0u, 0u);
  for (var k = 0u; k < 4u; k++) {
    var off = 0;
    if (k == 1u) { off = OFF[c]; } else if (k == 2u) { off = OFF[(c + 1u) & 3u]; } else if (k == 3u) { off = OFF[4u + c]; }
    sum = add64(sum, smul(T[(${TAB.V}u + 4u * c + k) * count + idx], S[qi + u32(i32(at) + off)] - q0));
  }
  return sum;
}

// One diffusion step: each cell takes, from each of its four neighbours, the flux of its link, an integer that the other
// cell of the link takes with the opposite sign, so the total of q * a + r over the sphere does not change. The flux is
//   fo * (kappa * (q_j - q_i) + c * (the value at the link's left end less the value at its right end)),
// the left and right end seen from cell i looking at cell j, and the value at an end the weighted mean of the four cells
// that meet at that vertex. Rounded half away from zero at three places that both cells of a link round the same way.
@compute @workgroup_size(256)
fn flux(@builtin(global_invocation_id) gid: vec3u, @builtin(num_workgroups) nwg: vec3u) {
  let idx = flatIndex(gid, nwg);
  let count = P[2] * 65536u;
  if (idx >= count) { return; }
  let slot = idx >> 16u; let c = idx & 65535u;
  let fw = P[2] * PAD2;
  let at = slot * PAD2 + ((c >> 8u) + 1u) * PAD + (c & 255u) + 1u;
  let qi = P[6] * fw;
  let q0 = S[qi + at];
  let a = u32(T[idx]);
  var total = vec2u(u32(S[P[7] * fw + at]), 0u);
  for (var d = 0u; d < 4u; d++) {
    let nb = u32(i32(at) + OFF[d]);
    let ends = shrRound(sub64(corner(at, qi, q0, d, idx, count), corner(at, qi, q0, (d + 3u) & 3u, idx, count)), ${SHIFT.vertex - SHIFT.ends}u);
    let cr = shrRound(smul(T[(${TAB.C}u + d) * count + idx], bitcast<i32>(ends.x)), ${SHIFT.ends}u);
    let s = add64(smul(T[(${TAB.K}u + d) * count + idx], S[qi + nb] - q0), cr);
    let s1 = shrRound(s, ${SHIFT.kappa - 16}u);
    total = add64(total, shrRound(smul64u(s1, P[12]), ${SHIFT.fo + 1}u));
  }
  let neg = isneg64(total);
  let dm = divLimbs(abs64(total), a);
  var qn = q0 + i32(dm.x); var rn = dm.y;
  if (neg) {
    qn = q0 - i32(dm.x);
    if (dm.y != 0u) { qn = qn - 1; rn = a - dm.y; }
  }
  S[P[8] * fw + at] = qn;
  S[P[9] * fw + at] = i32(rn);
  _ = P[0];
}
`;
}
