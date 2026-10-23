// The objects of a window laid straight into the renderer's buffers on the GPU, from what the scatter's write kernel leaves of a tile (px, py, size, seed, ks of every entry in the run):
// each entry is put in the window's frame (a turn by a multiple of a quarter and a shift, in integers: one unit is 15 mm, a game tile is 10,000 and a cell 5,000), kept when it
// lies in the window and its seed's hash is under the share (a draw-time density: the entries kept at a half are kept at a whole), appended to a staging list with its cell, and
// counted by cell; then the counts are summed into the runs' starts and each staged entry goes to its place in a run of its cell. Nothing is read back but the staged total.
export const CELLS = 256 * 256;
export const UNITS_PER_CELL = 5000;
export const STAGE_WORDS = 6;

const MIX = /* wgsl */ `
// the murmur finaliser's mix of a seed (winobjects.js unitHash, which divides it by 2^32 for its place in [0, 1)), as 32 bits
fn mixSeed(seed: u32) -> u32 {
  var h = seed;
  h ^= h >> 16u; h *= 0x85ebca6bu; h ^= h >> 13u; h *= 0xc2b2ae35u; h ^= h >> 16u;
  return h;
}
`;

// U: lo, hi (the span of entries), groups (workgroups along x, for a dispatch in two dimensions), shift (the share is 2^-shift), cap (staging entries), then the tile's
// transform: a0, a1 (the tile's corner in units), s0x, s0y, w0x, w0y, d0, d1, win (the window's side in units), then q0: the cells a side of the frame (the window's 256, a block's 64).
// PX, PY, SZ, SD, KS: the write kernel's arrays. STAGE: STAGE_WORDS words an entry (x and z in mm, what, size as f32 bits, seed, cell). COUNTS: a word a cell, then the staged total and an overflow flag.
export const placeKernel = /* wgsl */ `
struct P { lo: u32, hi: u32, groups: u32, shift: u32, cap: u32, p0: u32, p1: u32, p2: u32, a0: i32, a1: i32, s0x: i32, s0y: i32, w0x: i32, w0y: i32, d0: i32, d1: i32, win: i32, q0: i32, q1: i32, q2: i32 }
@group(0) @binding(0) var<uniform> U: P;
@group(0) @binding(1) var<storage, read> PX: array<u32>;
@group(0) @binding(2) var<storage, read> PY: array<u32>;
@group(0) @binding(3) var<storage, read> SZ: array<u32>;
@group(0) @binding(4) var<storage, read> SD: array<u32>;
@group(0) @binding(5) var<storage, read> KS: array<u32>;
@group(0) @binding(6) var<storage, read_write> STAGE: array<u32>;
@group(0) @binding(7) var<storage, read_write> COUNTS: array<atomic<u32>>;
${MIX}
@compute @workgroup_size(256)
fn place(@builtin(global_invocation_id) gid: vec3u) {
  let e = U.lo + gid.x + gid.y * U.groups * 256u;
  if (e >= U.hi) { return; }
  let size = SZ[e];
  if (size == 0u) { return; }
  let seed = SD[e];
  if (U.shift > 0u && (mixSeed(seed) >> (32u - U.shift)) != 0u) { return; }
  let dx = U.a0 + i32(PX[e]) - U.s0x;
  let dy = U.a1 + i32(PY[e]) - U.s0y;
  let o0 = U.d0 * dx + U.d1 * dy + U.w0x;
  let o1 = U.win - (-U.d1 * dx + U.d0 * dy + U.w0y);
  if (o0 < 0 || o0 >= U.win || o1 < 0 || o1 >= U.win) { return; }
  let at = atomicAdd(&COUNTS[${CELLS}u], 1u);
  if (at >= U.cap) { atomicStore(&COUNTS[${CELLS + 1}u], 1u); return; }
  let cell = u32(o1 / ${UNITS_PER_CELL}) * u32(U.q0) + u32(o0 / ${UNITS_PER_CELL});
  atomicAdd(&COUNTS[cell], 1u);
  let b = at * ${STAGE_WORDS}u;
  STAGE[b] = u32(o0) * 15u;
  STAGE[b + 1u] = u32(o1) * 15u;
  STAGE[b + 2u] = KS[e];
  STAGE[b + 3u] = bitcast<u32>(f32(size) / 1000000.0);
  STAGE[b + 4u] = seed;
  STAGE[b + 5u] = cell;
}
`;

// The runs' starts: START[c] is the sum of the counts before cell c, START[n * n] the total; CUR a copy of them for the scatter's cursors. One workgroup, a thread a run of n * n / 256 cells.
export const scanKernelFor = (n: number) => /* wgsl */ `
@group(0) @binding(0) var<storage, read> COUNTS: array<u32>;
@group(0) @binding(1) var<storage, read_write> START: array<u32>;
@group(0) @binding(2) var<storage, read_write> CUR: array<u32>;
var<workgroup> part: array<u32, 256>;
const PER = ${(n * n) / 256}u;
@compute @workgroup_size(256)
fn scan(@builtin(local_invocation_id) lid: vec3u) {
  let t = lid.x;
  var s = 0u;
  for (var i = 0u; i < PER; i++) { s += COUNTS[t * PER + i]; }
  part[t] = s;
  workgroupBarrier();
  if (t == 0u) {
    var a = 0u;
    for (var i = 0u; i < 256u; i++) { let v = part[i]; part[i] = a; a += v; }
    START[${n * n}u] = a;
  }
  workgroupBarrier();
  var a = part[t];
  for (var i = 0u; i < PER; i++) {
    let c = t * PER + i;
    START[c] = a;
    CUR[c] = a;
    a += COUNTS[c];
  }
}
`;
export const scanKernel = scanKernelFor(256);

// U: n (staged entries), groups, slots (the body's capacity). BODY: the renderer's source body, a word a slot for the alive flag, then x, z, what, size, seed and pick columns of slots words each.
export const scatterKernel = /* wgsl */ `
struct S { n: u32, groups: u32, slots: u32, pad: u32 }
@group(0) @binding(0) var<uniform> U: S;
@group(0) @binding(1) var<storage, read> STAGE: array<u32>;
@group(0) @binding(2) var<storage, read_write> CUR: array<atomic<u32>>;
@group(0) @binding(3) var<storage, read_write> BODY: array<u32>;
@compute @workgroup_size(256)
fn scatter(@builtin(global_invocation_id) gid: vec3u) {
  let e = gid.x + gid.y * U.groups * 256u;
  if (e >= U.n) { return; }
  let b = e * ${STAGE_WORDS}u;
  let slot = atomicAdd(&CUR[STAGE[b + 5u]], 1u);
  let C = U.slots;
  BODY[slot] = 1u;
  BODY[C + slot] = STAGE[b];
  BODY[2u * C + slot] = STAGE[b + 1u];
  BODY[3u * C + slot] = STAGE[b + 2u];
  BODY[4u * C + slot] = STAGE[b + 3u];
  BODY[5u * C + slot] = STAGE[b + 4u];
}
`;
