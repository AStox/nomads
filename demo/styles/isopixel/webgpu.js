// The isopixel renderer on WebGPU, run inside the render worker (worker.js) on an OffscreenCanvas. Nothing is baked on
// the CPU: every frame the GPU lays out the ground of the level and bearing shown, paints it pixel by pixel from the
// world's fields (ground.wgsl.js), stands every object of the sim on it as a sprite from one atlas, casts the sun and
// the moon, lights it all for the hour and scales it to the canvas. A zoom, a pan or a turn is only another frame.
//
// A frame, per view (one, or two cross-fading levels):
//   1. tiles: a compute pass lays out the level's tile map under the view, as main.js buildMap laid out the live levels:
//      each tile's water and every vertex's level, so the ground keeps z = 1.5H(u + v) + lev lp;
//   2. cull: a compute pass per drawn kind reads the sim's own object buffers (wgsl/objects.js), walking the spatial
//      index's cells under the view, keeps the objects drawn at a pixel or more where they can reach into the view,
//      works out each one's sprite from its buffer, stands it on the tile map's ground and lists it for an indirect
//      draw, with its shadow-casting rows;
//   3. world: the ground's triangles and banks, the objects' sprites and the page's live sprites go into a G-buffer of
//      what each pixel shows (ground to paint at a world point, or a sprite's colour and its anchor), depth tested;
//   4. mask: every shadow-casting row's swept round laid along the sun, as px.js shadowRows lists them, on the ground
//      the world left uncovered (only ground takes it);
//   5. overlays (smoke, labels, icons, paths, pins) in palette indices, and the people seen through the leaves;
//   6. shade: each pixel's ground painted (paintGround), lit by the sun map, its slope, the sprites' shadows and the
//      ambient occlusion, its fire light and haze added, and taken through the sky's light table;
// then every view onto the canvas at the exact zoom (present). Between two bearings the tile map of the nearer one is
// drawn turned to the bearing shown, so the island turns as a solid thing with its sprites upright.

import { GROUND_BINDINGS, groundWGSL } from "./ground.wgsl.js";
import { NS, ATLAS, META_WORDS, M_WRAP, M_PAGES } from "./atlas.js";
import { PAGE_LAYERS, PAGE_ROW, PAGE_SLOTS, PAGE_TEX, PAGE_WORDS } from "./pages.js";
import { CELLS_N, CELL_M, CELLS, FAR_LVL, objectWGSL, sourceWGSL, cullWGSL, cacheFillWGSL, CLAMP_WGSL, NEEDS_WGSL, FAR_COUNT_WGSL, FAR_FILE_WGSL, farScanWGSL, frontScanWGSL, cellsOf, CANOPY_WGSL, CANOPY_BYTES_WGSL, CANOPY_WIDE_WGSL, CANOPY_TALL_WGSL } from "./wgsl/objects.js";

// steps of the key light in the light table, each at the fire's four levels, the palette as drawn in a last row
export const LEVELS = 16;
const ROWS = LEVELS * 4 + 1;
export { NS, ATLAS };
// the sun map is traced again once the sun has moved this far (radians), over SUN_STRIPES frames [design: a stripe
// about 0.6 ms of a frame on AMD RDNA-1, measured 2026-10-16 at 1.0 to 1.4 ms for six stripes; a tick's move of the sun
// is traced in a fifth of a second at 60 Hz]
const SUN_MOVE = 0.004, SUN_STRIPES = 12;
// how far from each cell of the island's heights the ground's folds are looked over for the sky they hide (meters)
const TER_REACH = 450;
// the most objects one view draws, their shadow rows, and tiles under a view
const MAX_INST = 1 << 21, MAX_ROWS = 1 << 22, MAX_TILES = 1 << 20;
// the tile blocks a view works on at most (live.js windowOf), and the flags the map keeps for them
const BLK_MAX = MAX_TILES >> 6;
const FOFF_B = (3 * MAX_TILES + 4096) * 4;
// every block of a window's rectangle, each one that can show
const fullBlocks = (U) => {
  const n = Math.min(BLK_MAX, Math.ceil(U.ni / 16) * Math.ceil(U.nj / 16)), a = new Uint32Array(n);
  for (let b = 0; b < n; b++) a[b] = b | 0x40000000;
  return a;
};
// the most live sprites, their shadow rows, overlay primitives and fires a frame sends
const MAX_LIVE = 1 << 14, MAX_LIVE_ROWS = 1 << 16, MAX_PRIMS = 1 << 16, MAX_FIRES = 64;

// One uniform struct of scalars, its WGSL text and a packer, from one list, so the two never disagree.
function struct(name, fields) {
  const n = Math.ceil(fields.length / 4) * 4, all = [...fields];
  for (let k = fields.length; k < n; k++) all.push([`_p${k}`, "u"]);
  const at = Object.fromEntries(all.map(([f], k) => [f, k])), T = { f: "f32", u: "u32", i: "i32" };
  return {
    bytes: n * 4,
    wgsl: `struct ${name} {\n${all.map(([f, t]) => `  ${f}: ${T[t]},`).join("\n")}\n}`,
    pack(o) {
      const buf = new ArrayBuffer(n * 4), F = new Float32Array(buf), U = new Uint32Array(buf), I = new Int32Array(buf);
      for (const [k, v] of Object.entries(o)) {
        const i = at[k];
        if (i === undefined) throw new Error(`no field ${name}.${k}`);
        const t = all[i][1];
        if (t === "f") F[i] = v; else if (t === "u") U[i] = v >>> 0; else I[i] = v | 0;
      }
      return buf;
    },
  };
}
const VU = struct("U", [
  // the tile grid's bearing (axes and origin in world meters) and the bearing shown, which differ mid-turn
  ["eubx", "f"], ["euby", "f"], ["evbx", "f"], ["evby", "f"], ["obx", "f"], ["obz", "f"],
  ["eux", "f"], ["euy", "f"], ["evx", "f"], ["evy", "f"],
  // the camera: its target in world meters and its level; the target's offset in the art buffer; the buffer's global
  // origin and size
  ["cx", "f"], ["cz", "f"], ["levc", "f"], ["offx", "f"], ["offy", "f"], ["gx0", "i"], ["gy0", "i"], ["aw", "u"], ["ah", "u"],
  // the tile window in the grid
  ["i0", "i"], ["j0", "i"], ["ni", "u"], ["nj", "u"], ["nbi", "u"], ["nblk", "u"], ["bsum", "u"],
  // the level
  ["H", "f"], ["hb", "f"], ["lp", "f"], ["tileM", "f"], ["levelM", "f"], ["k", "f"], ["pv", "f"], ["pw", "f"], ["shrunk", "u"], ["bias", "f"], ["peak", "f"], ["mapN", "i"],
  ["zinv", "f"], ["frame", "u"], ["season", "u"], ["gflags", "u"],
  // objects: the cells under the view (the sim's spatial index), the most instances and rows, whether anything casts and
  // a row's shadow step per px of height
  ["cx0", "u"], ["cy0", "u"], ["cx1", "u"], ["cy1", "u"], ["maxinst", "u"], ["maxrows", "u"], ["casting", "u"], ["sunx", "f"], ["suny", "f"],
  // the far level this view walks its sources' far lists at (wgsl/objects.js FAR_WGSL)
  ["farL", "u"],
  // the light (live.js skyFor)
  ["lx", "f"], ["ly", "f"], ["lz", "f"], ["ar", "f"], ["ag", "f"], ["ab", "f"], ["kr", "f"], ["kg", "f"], ["kb", "f"],
  ["sunK", "f"], ["flat", "f"], ["relief", "f"], ["spr", "f"], ["toneK", "f"], ["toneLo", "f"], ["toneHi", "f"], ["toneN", "u"],
  ["aoK", "f"], ["aoTer", "f"], ["aoCan", "f"], ["aoTree", "f"], ["aoTop", "f"], ["aoSelf", "f"], ["aoKey", "f"], ["aoDbg", "f"],
  ["gridN", "u"], ["gridStep", "f"], ["canN", "u"], ["canStep", "f"], ["can3", "u"], ["half", "f"],
  ["hmost", "f"], ["htop", "f"], ["hreach", "f"], ["sea", "u"], ["wlo", "u"], ["whi", "u"], ["nfires", "u"], ["night", "f"], ["ncol", "u"], ["edge", "f"],
]);
const TU = struct("Tr", [["n", "u"], ["step", "f"], ["exag", "f"], ["tan", "f"], ["dx", "f"], ["dz", "f"], ["row0", "u"], ["reach", "f"], ["top", "f"]]);
const PU = struct("Pr", [["dx", "f"], ["dy", "f"], ["sc", "f"], ["nn", "f"], ["alpha", "f"], ["aw", "u"], ["ah", "u"], ["nearest", "u"], ["sr", "f"], ["sg", "f"], ["sb", "f"]]);
// the object passes outside a frame (wgsl/objects.js): the survey's mode and levels, and the trees' cover's grids
const KU = struct("Ks", [["mode", "u"], ["nl", "u"], ["l0", "u"], ["stride", "u"], ["vx0", "f"], ["vz0", "f"], ["vx1", "f"], ["vz1", "f"], ["canN", "u"], ["canStep", "f"], ["gn", "u"], ["gs", "f"], ["rp", "u"], ["n3", "u"], ["rp3", "u"], ["rpt", "u"]]);
// a slice of a far list's build: its first slot, how many, and how many far levels; a front list's level
const FU = struct("Fs", [["base", "u"], ["n", "u"], ["nf", "u"], ["lvl", "u"]]);

// Every resource a pass may bind in group 0: its binding, kind and type. A pass names the ones it uses (":w" for
// read-write storage); its declarations and its layout are made from the same list.
const RES = {
  V: [0, "uniform", "U"],
  map: [1, "storage", "array<f32>"],
  body: [3, "storage", "array<u32>"],
  entries: [5, "storage", "array<vec4u>"],
  rows: [6, "storage", "array<u32>"],
  inst: [7, "storage", "array<Inst>"],
  pts: [30, "storage", "array<Inst>"],
  rowInst: [8, "storage", "array<vec2u>"],
  args: [9, "storage", "Args"],
  atlas: [10, "texture_2d_array<u32>", "uint"],
  live: [11, "storage", "array<Inst>"],
  liveRows: [12, "storage", "array<vec4i>"],
  prims: [13, "storage", "array<vec4i>"],
  gK: [14, "texture_2d<u32>", "uint"],
  gW: [15, "texture_2d<f32>", "unfilterable-float"],
  mask: [16, "texture_2d<f32>", "unfilterable-float"],
  over: [17, "texture_2d<u32>", "uint"],
  xray: [18, "texture_2d<u32>", "uint"],
  sun: [19, "texture_2d<f32>", "unfilterable-float"],
  can0: [20, "texture_2d<u32>", "uint"],
  can3: [21, "texture_2d<f32>", "unfilterable-float"],
  tables: [22, "storage", "array<u32>"],
  fires: [23, "uniform", "Fires"],
  order: [24, "storage", "array<u32>"],
  T: [25, "uniform", "Tr"],
  sunOut: [26, "texture_storage_2d<r32float, write>", "r32float"],
  P: [27, "uniform", "Pr"],
  art: [28, "texture_2d<f32>", "unfilterable-float"],
  argsR: [29, "storage", "array<u32>"],
  keys: [31, "storage", "array<atomic<u32>>"],
  keysR: [31, "storage", "array<u32>"],
  zbuf: [32, "texture_depth_2d", "depth"],
  gKs: [33, "texture_storage_2d<rg32uint, write>", "rg32uint"],
  gWs: [34, "texture_storage_2d<rgba32float, write>", "rgba32float"],
  start: [35, "storage", "array<u32>"],
  marks: [36, "storage", "array<u32>"],
  looks: [37, "storage", "array<u32>"],
  gridTex: [45, "texture_2d_array<f32>", "unfilterable-float"],
  fineTex: [46, "texture_2d_array<f32>", "unfilterable-float"],
  need: [38, "storage", "array<atomic<u32>>"],
  canAcc: [39, "storage", "array<atomic<u32>>"],
  canAccR: [39, "storage", "array<u32>"],
  canTall: [40, "storage", "array<atomic<u32>>"],
  canTallR: [40, "storage", "array<u32>"],
  canBytes: [41, "storage", "array<u32>"],
  canWide: [42, "storage", "array<f32>"],
  canTallOut: [43, "storage", "array<f32>"],
  Kp: [44, "uniform", "Ks"],
  Fp: [47, "uniform", "Fs"],
  fkey: [48, "storage", "array<u32>"],
  fcnt: [49, "storage", "array<atomic<u32>>"],
  fcntR: [49, "storage", "array<u32>"],
  flist: [50, "storage", "array<u32>"],
  fidx: [51, "storage", "array<u32>"],
  // a source's own buffers beyond its body (worker.js): the deadwood's rot ring, a sorted list of the members gone, and
  // a count of members a cell
  drv: [52, "storage", "array<u32>"],
  gone: [53, "storage", "array<u32>"],
  counts: [54, "storage", "array<u32>"],
  // a source of cells' cache (wgsl/objects.js cacheFillWGSL): each cell's slot, each slot's count, the members, and the
  // cells to fill this frame
  cslot: [55, "storage", "array<u32>"],
  ccnt: [56, "storage", "array<atomic<u32>>"],
  ccntR: [56, "storage", "array<u32>"],
  cache: [57, "storage", "array<u32>"],
  cfill: [58, "storage", "array<u32>"],
  // a far level's front list as it is built (wgsl/objects.js frontWalk): each pixel's nearest speck's depth key, the
  // list, and its index laid out as a far list's
  fkeys: [59, "storage", "array<atomic<u32>>"],
  fkeysR: [59, "storage", "array<u32>"],
  flistOut: [60, "storage", "array<u32>"],
  fout: [61, "storage", "array<u32>"],
  // the ground tiles a view can show: the compacted list of the tile cull pass and its indirect draw's arguments (vertex count first)
  tlist: [62, "storage", "array<u32>"],
  tcnt: [63, "storage", "array<atomic<u32>>"],
  // the tile blocks of a view (live.js windowOf): each as its index in the window's blocks, bit 30 set for one that can show
  blk: [64, "storage", "array<u32>"],
};
const TYPES = `
struct Inst { sp: u32, x: i32, y: i32, z: f32, flags: u32, pick: u32, wx: f32, wz: f32 }
struct Args { vc: u32, ic: atomic<u32>, fv: u32, fi: u32, rvc: u32, ric: atomic<u32>, rfv: u32, rfi: u32, pvc: u32, pic: atomic<u32>, pfv: u32, pfi: u32, dx: u32, dy: u32, dz: u32, dw: u32 }
struct Fires { f: array<vec4f, ${MAX_FIRES}> }
struct GOut { @location(0) k: vec2u, @location(1) w: vec4f }`;
function decl(list) {
  return list.map((n) => {
    const [name, mode] = n.split(":"), [b, kind, ty] = RES[name];
    if (kind === "uniform") return `@group(0) @binding(${b}) var<uniform> ${name}: ${ty};`;
    if (kind === "storage") return `@group(0) @binding(${b}) var<storage, ${mode === "w" ? "read_write" : "read"}> ${name}: ${ty};`;
    return `@group(0) @binding(${b}) var ${name}: ${kind};`;
  }).join("\n");
}
function layoutEntries(list, compute) {
  const all = compute ? GPUShaderStage.COMPUTE : GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT;
  return list.map((n) => {
    const [name, mode] = n.split(":"), [b, kind, ty] = RES[name], e = { binding: b, visibility: all };
    if (kind === "uniform") e.buffer = { type: "uniform" };
    else if (kind === "storage") e.buffer = { type: mode === "w" ? "storage" : "read-only-storage" };
    else if (kind.startsWith("texture_storage")) e.storageTexture = { access: "write-only", format: ty, viewDimension: "2d" };
    else e.texture = { sampleType: ty, viewDimension: kind.includes("array") ? "2d-array" : "2d" };
    return e;
  });
}

// Common WGSL: the ordered dither and the light table's steps, and the
// projection: world meters to the shown bearing's tile units about the camera target, and on to the art buffer's
// pixels and depth (gy + z = 2H(u + v), larger z nearer).
const COMMON = `
var<private> BAYT: array<f32, 16> = array<f32, 16>(0.0, 8.0, 2.0, 10.0, 12.0, 4.0, 14.0, 6.0, 3.0, 11.0, 1.0, 9.0, 15.0, 7.0, 13.0, 5.0);
fn bay(g: vec2i) -> f32 { return (BAYT[((g.y & 3) << 2u) | (g.x & 3)] + 0.5) / 16.0; }
const LEVELS: i32 = ${LEVELS};
const EMISSIVE: u32 = ${LEVELS * 4}u;
fn lvl(f: f32, g: vec2i) -> u32 { return u32(min(f32(LEVELS - 1), floor(f * f32(LEVELS - 1) + bay(g)))); }
fn rnd(v: f32) -> f32 { return floor(v + 0.5); }
`;
const COMMON_V = `
fn rel(x: f32, z: f32) -> vec2f { let d = vec2f(x - V.cx, z - V.cz); return vec2f(d.x * V.eux + d.y * V.euy, d.x * V.evx + d.y * V.evy) / V.tileM; }
fn screen(d: vec2f, lev: f32) -> vec3f {
  return vec3f((d.x - d.y) * V.H + V.offx, (d.x + d.y) * V.hb - (lev - V.levc) * V.lp + V.offy, 1.5 * V.H * (d.x + d.y) + (lev - V.levc) * V.lp);
}
// the depth runs linearly over the view's whole span of z (live.js zSpan), so what lies past it is clipped, never squashed
fn clip(p: vec3f) -> vec4f { return vec4f(p.x / f32(V.aw) * 2.0 - 1.0, 1.0 - p.y / f32(V.ah) * 2.0, 0.5 - p.z * V.zinv, 1.0); }
fn gridW(u: f32, v: f32) -> vec2f { return vec2f(V.obx + (u * V.eubx + v * V.evbx) * V.tileM, V.obz + (u * V.euby + v * V.evby) * V.tileM); }
fn gridUV(x: f32, z: f32) -> vec2f { let d = vec2f(x - V.obx, z - V.obz); return vec2f(d.x * V.eubx + d.y * V.euby, d.x * V.evbx + d.y * V.evby) / V.tileM; }
const QX = array<f32, 6>(0.0, 1.0, 0.0, 0.0, 1.0, 1.0);
const QY = array<f32, 6>(0.0, 0.0, 1.0, 1.0, 0.0, 1.0);
`;

// ---------- 1. the tile map ----------
// One buffer (map): each tile's water and level as a pair, then from VOFF each vertex's level. A tile's water (main.js
// buildMap on a live level): over 0.45 of five points under standing water, or over 0.1 and below sea level, is water at
// the surface of the nearest water cell, a lake above half a meter, else the sea.
const VOFF = `${2 * MAX_TILES}u`, FOFF = `${3 * MAX_TILES + 4096}u`;
// The map is made for the blocks of 16 by 16 tiles live.js windowOf lists (blk: a block's index in the rectangle, bit 30 set for one that can show, clear for the ring of neighbours that its
// vertices and banks read), a workgroup each, and a block that can show says so with a flag at FOFF, where groundLev reads it: a tile of any other block has no ground.
const TILES_WGSL = `
@compute @workgroup_size(256)
fn tilesMain(@builtin(workgroup_id) wg: vec3u, @builtin(local_invocation_index) li: u32) {
  let e = blk[wg.x];
  let b = e & 0x3FFFFFFFu;
  let ti = (b % V.nbi) * 16u + (li & 15u);
  let tj = (b / V.nbi) * 16u + (li >> 4u);
  if (li == 0u && (e & 0x40000000u) != 0u) { map[${FOFF} + b] = 1.0; }
  if (ti >= V.ni || tj >= V.nj) { return; }
  let id = tj * V.ni + ti;
  let u = f32(V.i0 + i32(ti));
  let v = f32(V.j0 + i32(tj));
  let offs = array<vec2f, 5>(vec2f(0.5, 0.5), vec2f(0.22, 0.5), vec2f(0.78, 0.5), vec2f(0.5, 0.22), vec2f(0.5, 0.78));
  var wet = 0.0;
  for (var k = 0; k < 5; k++) { let p = gridW(u + offs[k].x, v + offs[k].y); wet += waterAt(p.x, p.y); }
  wet /= 5.0;
  let c = gridW(u + 0.5, v + 0.5);
  let hh = heightAt(c.x, c.y);
  var out = vec2f(0.0, 0.0);
  if (wet > 0.45 || (wet > 0.1 && hh < -0.5)) { let s = surfAt(c.x, c.y); out = vec2f(select(1.0, 2.0, s > 0.5), s / V.levelM); }
  map[2u * id] = out.x;
  map[2u * id + 1u] = out.y;
}`;
// A vertex's level: the ground's height, or where it touches standing water the highest water's level, never below
// the sea.
const VERTS_WGSL = `
@compute @workgroup_size(256)
fn vertsMain(@builtin(workgroup_id) wg: vec3u, @builtin(local_invocation_index) li: u32) {
  let b = blk[wg.x] & 0x3FFFFFFFu;
  let vi = V.ni + 1u;
  // the block's 17 by 17 vertices (a vertex on a shared edge is made by both blocks, the same value)
  for (var s = li; s < 289u; s += 256u) {
    let iu = (b % V.nbi) * 16u + s % 17u;
    let ju = (b / V.nbi) * 16u + s / 17u;
    if (iu > V.ni || ju > V.nj) { continue; }
    let i = i32(iu);
    let j = i32(ju);
    let p = gridW(f32(V.i0 + i), f32(V.j0 + j));
    var lev = heightAt(p.x, p.y) / V.levelM;
    var wetv = false;
    var fl = 0.0;
    for (var bb = j - 1; bb <= j; bb++) {
      for (var a = i - 1; a <= i; a++) {
        if (a < 0 || bb < 0 || a >= i32(V.ni) || bb >= i32(V.nj)) { continue; }
        let t = vec2f(map[2u * (u32(bb) * V.ni + u32(a))], map[2u * (u32(bb) * V.ni + u32(a)) + 1u]);
        if (t.x > 0.5) { fl = select(t.y, max(fl, t.y), wetv); wetv = true; }
      }
    }
    if (wetv) { lev = fl; }
    map[${VOFF} + ju * vi + iu] = max(0.0, lev);
  }
}`;
// The tile map read back: a tile's corners (top, right, bottom, left as main.js), its diagonal and its water.
const MAP_READ = `
struct T4 { c: vec4f, diag: u32, kind: u32 }
fn tileAt(ti: i32, tj: i32) -> T4 {
  var o: T4;
  let ix = u32(tj) * V.ni + u32(ti);
  let t = vec2f(map[2u * ix], map[2u * ix + 1u]);
  let vi = V.ni + 1u;
  let k = u32(tj) * vi + u32(ti);
  o.kind = u32(t.x + 0.5);
  if (o.kind > 0u) { o.c = vec4f(t.y); } else { o.c = vec4f(map[${VOFF} + k], map[${VOFF} + k + 1u], map[${VOFF} + k + vi + 1u], map[${VOFF} + k + vi]); }
  let dTB = abs(o.c.x - o.c.z);
  let dLR = abs(o.c.w - o.c.y);
  if (dTB < dLR) { o.diag = 0u; } else if (dLR < dTB) { o.diag = 1u; } else { o.diag = select(1u, 0u, o.c.x + o.c.z > o.c.y + o.c.w); }
  return o;
}
// the drawn ground's level at grid point (u, v), on the triangles its tile is drawn with; -1e9 off the window
fn groundLev(u: f32, v: f32) -> f32 {
  let fi = floor(u);
  let fj = floor(v);
  let ti = i32(fi) - V.i0;
  let tj = i32(fj) - V.j0;
  if (ti < 0 || tj < 0 || ti >= i32(V.ni) || tj >= i32(V.nj)) { return -1e9; }
  if (map[${FOFF} + (u32(tj) >> 4u) * V.nbi + (u32(ti) >> 4u)] < 0.5) { return -1e9; }
  let o = tileAt(ti, tj);
  let fu = u - fi;
  let fv = v - fj;
  let T = o.c.x;
  let R = o.c.y;
  let B = o.c.z;
  let L = o.c.w;
  if (o.diag == 0u) { if (fu >= fv) { return T + (R - T) * fu + (B - R) * fv; } return T + (B - L) * fu + (L - T) * fv; }
  if (fu + fv <= 1.0) { return T + (R - T) * fu + (L - T) * fv; }
  return R + L - B + (B - L) * fu + (B - R) * fv;
}`;
// A tile can show only where some part of it (its four corners at its lowest and highest level, and a bank strip down to the water beside it) lies on the art buffer. The window's grid is a
// rectangle in tile axes, laid for the lowest and highest ground the view can see, so on steep ground most of it lies off the buffer; this lists the tiles that do and the world pass draws only those.
const TCULL_WGSL = `
fn flatCorner(u: f32, v: f32) -> vec3f { let w = gridW(u, v); return screen(rel(w.x, w.y), 0.0); }
@compute @workgroup_size(256)
fn tcullMain(@builtin(workgroup_id) wg: vec3u, @builtin(local_invocation_index) li: u32) {
  let e = blk[wg.x];
  if ((e & 0x40000000u) == 0u) { return; }
  let b = e & 0x3FFFFFFFu;
  let tiu = (b % V.nbi) * 16u + (li & 15u);
  let tju = (b / V.nbi) * 16u + (li >> 4u);
  if (tiu < 1u || tju < 1u || tiu + 1u >= V.ni || tju + 1u >= V.nj) { return; }
  let ti = i32(tiu);
  let tj = i32(tju);
  if (V.mapN > 0 && (V.i0 + ti < 0 || V.j0 + tj < 0 || V.i0 + ti >= V.mapN || V.j0 + tj >= V.mapN)) { return; }
  let T = tileAt(ti, tj);
  var lo = min(min(T.c.x, T.c.y), min(T.c.z, T.c.w));
  let hi = max(max(T.c.x, T.c.y), max(T.c.z, T.c.w));
  if (T.kind == 0u) {
    let a = tileAt(ti, tj + 1);
    let n = tileAt(ti + 1, tj);
    if (a.kind > 0u) { lo = min(lo, min(a.c.x, a.c.y)); }
    if (n.kind > 0u) { lo = min(lo, min(n.c.w, n.c.x)); }
  }
  let u = f32(V.i0 + ti);
  let v = f32(V.j0 + tj);
  let s0 = flatCorner(u, v);
  let s1 = flatCorner(u + 1.0, v);
  let s2 = flatCorner(u + 1.0, v + 1.0);
  let s3 = flatCorner(u, v + 1.0);
  let xmin = min(min(s0.x, s1.x), min(s2.x, s3.x));
  let xmax = max(max(s0.x, s1.x), max(s2.x, s3.x));
  let yTop = min(min(s0.y, s1.y), min(s2.y, s3.y)) - hi * V.lp;
  let yBot = max(max(s0.y, s1.y), max(s2.y, s3.y)) - lo * V.lp;
  if (xmax < -1.0 || xmin > f32(V.aw) + 1.0 || yBot < -1.0 || yTop > f32(V.ah) + 1.0) { return; }
  let k = atomicAdd(&tcnt[0], 18u) / 18u;
  tlist[k] = (tju - 1u) * (V.ni - 2u) + (tiu - 1u);
}`;

// ---------- 3. the world pass: the ground ----------
// Each tile of the window but its outer ring is 18 vertices: two triangles, then a bank strip on each near edge where
// it stands above the water in front of it (main.js drawTerrainLive). A triangle turned away from the camera is the far
// side of a slope and is dropped, as the CPU dropped it. The G-buffer: K = kind | colour << 8 | flags << 16, and the
// pick; W = the world point the light reads (the ground's own; a bank's edge; a sprite's foot) and a sprite pixel's
// height in art px over its foot. Kinds: 0 ground to paint, 1 an object's sprite, 2 a live sprite, 3 a bank, coloured.
const TERRAIN_WGSL = `
struct TOut { @builtin(position) pos: vec4f, @location(0) w: vec2f, @location(1) @interpolate(flat) kind: u32, @location(2) bank: vec3f }
fn corner(u: f32, v: f32, lev: f32) -> vec3f { let w = gridW(u, v); return screen(rel(w.x, w.y), lev); }
@vertex
fn terrainVS(@builtin(vertex_index) vid: u32) -> TOut {
  var o: TOut;
  o.pos = vec4f(2.0, 2.0, 2.0, 1.0); o.kind = 0u; o.w = vec2f(0.0); o.bank = vec3f(0.0);
  let t = tlist[vid / 18u];
  let q = vid % 18u;
  let iw = V.ni - 2u;
  let ti = i32(t % iw) + 1;
  let tj = i32(t / iw) + 1;
  if (tj >= i32(V.nj) - 1) { return o; }
  // an island-wide level's map ends where the frame its bearing turns the island in does; past it the sea runs on
  if (V.mapN > 0 && (V.i0 + ti < 0 || V.j0 + tj < 0 || V.i0 + ti >= V.mapN || V.j0 + tj >= V.mapN)) { return o; }
  let T = tileAt(ti, tj);
  let u = f32(V.i0 + ti);
  let v = f32(V.j0 + tj);
  let P4 = array<vec3f, 4>(vec3f(u, v, T.c.x), vec3f(u + 1.0, v, T.c.y), vec3f(u + 1.0, v + 1.0, T.c.z), vec3f(u, v + 1.0, T.c.w));
  if (q < 6u) {
    var idx = array<u32, 6>(0u, 1u, 2u, 0u, 2u, 3u);
    if (T.diag == 1u) { idx = array<u32, 6>(0u, 1u, 3u, 3u, 1u, 2u); }
    let base = (q / 3u) * 3u;
    let A = P4[idx[base]];
    let B = P4[idx[base + 1u]];
    let C = P4[idx[base + 2u]];
    let a = corner(A.x, A.y, A.z);
    let b = corner(B.x, B.y, B.z);
    let c = corner(C.x, C.y, C.z);
    if ((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x) <= 0.0) { return o; }
    let P = P4[idx[q]];
    o.pos = clip(corner(P.x, P.y, P.z)); o.w = gridW(P.x, P.y);
    return o;
  }
  // a bank: face 0 along the near-left edge, toward the tile at v + 1; face 1 along the near-right, toward u + 1
  let face = select(0u, 1u, q >= 12u);
  let r = (q - 6u) % 6u;
  if (T.kind > 0u) { return o; }
  let nb = tileAt(ti + i32(face), tj + 1 - i32(face));
  if (nb.kind == 0u) { return o; }
  var pa = P4[3]; var pb = P4[2]; var botA = nb.c.x; var botB = nb.c.y;
  if (face == 1u) { pa = P4[2]; pb = P4[1]; botA = nb.c.w; botB = nb.c.x; }
  if (botA >= pa.z && botB >= pb.z) { return o; }
  let ta = corner(pa.x, pa.y, pa.z);
  let tb = corner(pb.x, pb.y, pb.z);
  let ba = corner(pa.x, pa.y, botA);
  let bb = corner(pb.x, pb.y, botB);
  if (tb.x <= ta.x) { return o; }
  // the strip's corners: top a, top b, bottom a, bottom b; its top and bottom lines run along x
  let sel = array<u32, 6>(0u, 1u, 2u, 2u, 1u, 3u)[r];
  let atB = sel == 1u || sel == 3u;
  let atBot = sel >= 2u;
  let P = select(pa, pb, atB);
  o.pos = clip(select(select(ta, tb, atB), select(ba, bb, atB), atBot)); o.w = gridW(P.x, P.y); o.kind = 3u + face;
  o.bank = vec3f(select(ta.y, tb.y, atB), select(ba.y, bb.y, atB), select(P.z, select(botA, botB, atB), atBot));
  return o;
}
@fragment
fn terrainFS(i: TOut) -> GOut {
  var o: GOut;
  o.w = vec4f(i.w, 0.0, 0.0);
  if (i.kind == 0u) { o.k = vec2u(0u, 0u); return o; }
  // a bank's pixel is coloured here, by its depth below the strip's top and the level it stands at
  let X = i32(floor(i.pos.x)) + V.gx0;
  let Y = i32(floor(i.pos.y)) + V.gy0;
  let c = bankColour(i.kind - 3u, X, Y, i.pos.y - i.bank.x, i.bank.y - i.bank.x, i.bank.z, V.lp);
  o.k = vec2u(3u | (c << 8u), 0u);
  return o;
}`;

// ---------- 3. the world pass: sprites ----------
// A sprite's quad, row y of it at depth z + (ay - y) as blit draws it (px.js; z holds the bias), so the quad's depth runs
// exactly along it. A pixel the atlas holds 255 at is clear. Flags: kind (bits 0, 1), mirrored (4), gives its own light
// (5), seen through the leaves (6).
const SPRITE_WGSL = (src) => `
struct SOut { @builtin(position) pos: vec4f, @location(0) @interpolate(flat) s: vec4i, @location(1) @interpolate(flat) e: vec4u, @location(2) @interpolate(flat) w: vec4f }
@vertex
fn spriteVS(@builtin(vertex_index) vid: u32, @builtin(instance_index) ii: u32) -> SOut { return spriteOut(vid, ii); }
fn spriteOut(vid: u32, ii: u32) -> SOut {
  var o: SOut;
  let it = ${src}[ii];
  let e0 = entries[it.sp * 2u];
  let w = i32(e0.y & 0xFFFFu);
  let h = i32(e0.y >> 16u);
  let ax = i32(e0.z & 0xFFFFu) - 32768;
  let ay = i32(e0.z >> 16u) - 32768;
  let mirror = (it.flags >> 4u) & 1u;
  let left = it.x - select(ax, w - 1 - ax, mirror == 1u);
  let top = it.y - ay;
  let p = vec2f(f32(left) + QX[vid] * f32(w), f32(top) + QY[vid] * f32(h));
  o.pos = clip(vec3f(p, it.z + f32(it.y) + 0.5 - p.y));
  o.s = vec4i(left, top, w, h);
  o.e = vec4u(e0.x, e0.w & 255u, it.flags, it.pick);
  // the light's measure of how far up its sprite a pixel stands, as the WebGL2 renderer took it from a baked pixel's depth: the
  // drawn ground's height at the foot (gy + z = 2H(u + v), so z = 3 gy + 4 lev lp) and the rows above the anchor
  let foot = f32(i32((e0.w >> 8u) & 255u) - 128);
  let levlp = (it.z - V.bias - 3.0 * (f32(it.y) - foot - V.offy)) * 0.25 + V.levc * V.lp;
  o.w = vec4f(it.wx, it.wz, levlp + f32(ay) - 0.75 * foot, 0.0);
  return o;
}
fn spriteTexel(i: SOut) -> u32 {
  let px = i32(floor(i.pos.x)) - i.s.x;
  let py = i32(floor(i.pos.y)) - i.s.y;
  let sx = select(px, i.s.z - 1 - px, ((i.e.z >> 4u) & 1u) == 1u);
  return textureLoad(atlas, vec2i(i32(i.e.x & 0xFFFFu) + sx, i32(i.e.x >> 16u) + py), i32(i.e.y), 0).r;
}
@fragment
fn spriteFS(i: SOut) -> GOut {
  var o: GOut;
  let c = spriteTexel(i);
  if (c == 255u) { discard; }
  let py = f32(i32(floor(i.pos.y)) - i.s.y);
  o.k = vec2u((i.e.z & 3u) | (c << 8u) | ((i.e.z & 0x60u) << 11u), i.e.w);
  o.w = vec4f(i.w.x, i.w.y, i.w.z - py, 0.0);
  return o;
}
@fragment
fn xrayFS(i: SOut) -> @location(0) vec2u {
  let c = spriteTexel(i);
  if (c == 255u) { discard; }
  return vec2u(c + 1u, i.e.w);
}`;

// A one-pixel sprite (a far level's tree is mostly one) as a splat: a quad or a point a pixel big keeps the GPU's
// shader lanes mostly idle, so the specks are written by two compute passes instead. The first keeps, per pixel, the
// nearest speck in front of what the world pass drew there; the second writes that speck into the G-buffer, as the
// sprite pass would have (its depth: blit's for its only row).
const SPLAT_WGSL = `
fn speck(it: Inst) -> vec4f {
  let e0 = entries[it.sp * 2u];
  let ax = i32(e0.z & 0xFFFFu) - 32768;
  let ay = i32(e0.z >> 16u) - 32768;
  let left = it.x - select(ax, -ax, ((it.flags >> 4u) & 1u) == 1u);
  return vec4f(f32(left), f32(it.y - ay), 0.5 - (it.z + f32(ay)) * V.zinv, f32(ay));
}
fn speckKey(i: u32) -> vec2u {
  if (i >= argsR[9]) { return vec2u(0u); }
  let p = speck(pts[i]);
  let q = vec2i(p.xy);
  if (q.x < 0 || q.y < 0 || q.x >= i32(V.aw) || q.y >= i32(V.ah) || p.z < 0.0 || p.z > textureLoad(zbuf, q, 0)) { return vec2u(0u); }
  return vec2u(u32(q.y) * V.aw + u32(q.x) + 1u, 0xFFFFFFFFu - bitcast<u32>(p.z));
}
@compute @workgroup_size(64)
fn splatA(@builtin(global_invocation_id) id: vec3u) {
  let k = speckKey(id.x);
  if (k.x != 0u) { atomicMax(&keys[k.x - 1u], k.y); }
}
@compute @workgroup_size(64)
fn splatB(@builtin(global_invocation_id) id: vec3u) {
  let k = speckKey(id.x);
  if (k.x == 0u || keysR[k.x - 1u] != k.y) { return; }
  let it = pts[id.x];
  let p = speck(it);
  let e0 = entries[it.sp * 2u];
  let c = textureLoad(atlas, vec2i(i32(e0.x & 0xFFFFu), i32(e0.x >> 16u)), i32(e0.w & 255u), 0).r;
  if (c == 255u) { return; }
  let foot = f32(i32((e0.w >> 8u) & 255u) - 128);
  let levlp = (it.z - V.bias - 3.0 * (f32(it.y) - foot - V.offy)) * 0.25 + V.levc * V.lp;
  let q = vec2i(p.xy);
  textureStore(gKs, q, vec4u(1u | (c << 8u), it.pick, 0u, 0u));
  textureStore(gWs, q, vec4f(it.wx, it.wz, levlp + p.w - 0.75 * foot, 0.0));
}`;

// ---------- 4. the sun's mask ----------
// A shadow-casting row's shadow: k art px above its anchor it falls k * vec off the
// anchor's row, the whole row as the round slab it stands for, flattened 2:1 as the ground shows a circle, and swept
// on to k + 1 so that a low sun's long shadow has no gaps. P: twice the row's centre column, the anchor's row, the
// row's width and k, as px.js shadowRows lists them. Only ground takes the mask (shadeFS: kinds 0 and 3, and the sea
// past the map), so after the world pass maskZ puts every pixel a sprite or speck covers at depth 0 and the rest at 1,
// and the shadows, drawn at depth 0.5, are tested against it before their fragments run.
const MASK_COMMON = `
struct MOut { @builtin(position) pos: vec4f, @location(0) @interpolate(flat) a: vec4f, @location(1) @interpolate(flat) r: f32 }
fn shadeQuad(P: vec4f, vid: u32) -> MOut {
  var o: MOut;
  let vec = vec2f(V.sunx, V.suny);
  let R = P.z * 0.5 + 0.25;
  let A = vec2f(P.x * 0.5, P.y + 0.5) + P.w * vec;
  let B = A + vec;
  let e = vec2f(R + 1.0, R * 0.5 + 1.0);
  let lo = min(A, B) - e;
  let hi = max(A, B) + e;
  // a strip of four corners
  let p = mix(lo, hi, vec2f(f32(vid & 1u), f32(vid >> 1u)));
  o.pos = vec4f(p.x / f32(V.aw) * 2.0 - 1.0, 1.0 - p.y / f32(V.ah) * 2.0, 0.5, 1.0);
  o.a = vec4f(A, B); o.r = R;
  return o;
}
@fragment
fn maskFS(i: MOut) -> @location(0) vec4f {
  let s = vec2f(1.0, 2.0);
  let q = i.pos.xy * s;
  let a = i.a.xy * s;
  let ab = i.a.zw * s - a;
  let t = clamp(dot(q - a, ab) / max(dot(ab, ab), 1e-6), 0.0, 1.0);
  if (length(q - a - t * ab) > i.r) { discard; }
  return vec4f(1.0);
}`;
const MASK_WGSL = `${MASK_COMMON}
@vertex
fn maskVS(@builtin(vertex_index) vid: u32, @builtin(instance_index) ii: u32) -> MOut {
  let ri = rowInst[ii];
  let it = inst[ri.x];
  let e0 = entries[it.sp * 2u];
  let row = rows[ri.y];
  let w = i32(e0.y & 0xFFFFu);
  let ax = i32(e0.z & 0xFFFFu) - 32768;
  let ay = i32(e0.z >> 16u) - 32768;
  let mirror = ((it.flags >> 4u) & 1u) == 1u;
  let y = i32(row & 1023u);
  var a = i32((row >> 10u) & 1023u);
  var b = i32(row >> 20u);
  if (mirror) { let t = a; a = w - 1 - b; b = w - 1 - t; }
  let left = it.x - select(ax, w - 1 - ax, mirror);
  return shadeQuad(vec4f(f32(2 * left + a + b + 1), f32(it.y), f32(b - a + 1), f32(ay - y)), vid);
}`;
const MASK_LIVE_WGSL = `${MASK_COMMON}
@vertex
fn maskLiveVS(@builtin(vertex_index) vid: u32, @builtin(instance_index) ii: u32) -> MOut { return shadeQuad(vec4f(liveRows[ii]), vid); }`;
const MASK_Z_WGSL = `
@vertex
fn fullVS(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f { return vec4f(f32((i << 1u) & 2u) * 2.0 - 1.0, f32(i & 2u) * 2.0 - 1.0, 0.0, 1.0); }
@fragment
fn maskZFS(@builtin(position) pos: vec4f) -> @builtin(frag_depth) f32 {
  let kind = textureLoad(gK, vec2i(floor(pos.xy)), 0).x & 3u;
  return select(1.0, 0.0, kind == 1u || kind == 2u);
}`;
// the shadows' test against maskZ's depth: drawn where nothing stands, never written
const MASK_TEST = { format: "depth16unorm", depthWriteEnabled: false, depthCompare: "less" };

// ---------- 5. overlays ----------
// A primitive is two vec4i, [type, x, y, a] [b, c, d, e], in the view's art px, each drawn over the last: 0 a sprite at
// anchor (x, y) (a: its id, b: mirrored); 1 a glyph of the 5x7 font at its top left (a: char code, b: colour); 2 a dot
// (b: colour); 3 a smoke puff as live.js smoke() draws one (x, y its centre and a its radius in 1/16 px, b its alpha in
// 1/1000); 4 a line's pixels as live.js along() lays them, to (b, c) (a: colour; d: 0 solid, 1 kept where the dither is
// under e / 1000, 2 dashes 3 px on and 3 off, e the distance along at its start, in 1/16 px).
const OVER_WGSL = (FONT0, extra, smoke) => `
// px.js h2
fn oh2(x: i32, y: i32, s: i32) -> f32 {
  var h = bitcast<u32>(x * 374761393 + y * 668265263 + s * 1442695041);
  h = (h ^ (h >> 13u)) * 1274126177u;
  return f32(h ^ (h >> 16u)) / 4294967296.0;
}
// a glyph's row j: the font's rows sit in the tables from FONT0, A to Z, 0 to 9, then the few other characters
fn glyphAt(g: u32, j: i32) -> u32 { return tables[${FONT0}u + g * 7u + u32(j)]; }
struct OOut { @builtin(position) pos: vec4f, @location(0) @interpolate(flat) p: vec4i, @location(1) @interpolate(flat) q: vec4i, @location(2) @interpolate(flat) r: vec4i }
@vertex
fn overVS(@builtin(vertex_index) vid: u32, @builtin(instance_index) ii: u32) -> OOut {
  var o: OOut;
  let p = prims[ii * 2u];
  let q = prims[ii * 2u + 1u];
  var lo = vec2f(f32(p.y), f32(p.z));
  var hi = lo + vec2f(1.0);
  var r = vec4i(0);
  if (p.x == 0) {
    let e0 = entries[u32(p.w) * 2u];
    let w = i32(e0.y & 0xFFFFu);
    let h = i32(e0.y >> 16u);
    let ax = i32(e0.z & 0xFFFFu) - 32768;
    let ay = i32(e0.z >> 16u) - 32768;
    r = vec4i(p.y - select(ax, w - 1 - ax, q.x == 1), p.z - ay, w, h);
    lo = vec2f(f32(r.x), f32(r.y)); hi = lo + vec2f(f32(w), f32(h));
  } else if (p.x == 1) { hi = lo + vec2f(5.0, 7.0); }
  else if (p.x == 3) { let c = lo / 16.0; let rr = f32(p.w) / 16.0; lo = floor(c - rr); hi = floor(c + rr) + 1.0; }
  else if (p.x == 4) { let b = vec2f(f32(q.x), f32(q.y)); hi = max(lo, b) + 1.0; lo = min(lo, b); }
  let s = mix(lo, hi, vec2f(QX[vid], QY[vid]));
  o.pos = vec4f(s.x / f32(V.aw) * 2.0 - 1.0, 1.0 - s.y / f32(V.ah) * 2.0, 0.0, 1.0);
  o.p = p; o.q = q; o.r = r;
  return o;
}
fn glyphRow(ch: i32, j: i32) -> u32 {
  if (j < 0 || j > 6) { return 0u; }
  if (ch >= 97 && ch <= 122) { return glyphAt(u32(ch - 97), j); }
  if (ch >= 65 && ch <= 90) { return glyphAt(u32(ch - 65), j); }
  if (ch >= 48 && ch <= 57) { return glyphAt(26u + u32(ch - 48), j); }
${extra.map((c, k) => `  if (ch == ${c}) { return glyphAt(${36 + k}u, j); }`).join("\n")}
  return 0u;
}
@fragment
fn overFS(i: OOut) -> @location(0) u32 {
  let x = i32(floor(i.pos.x));
  let y = i32(floor(i.pos.y));
  let p = i.p;
  let q = i.q;
  if (p.x == 0) {
    let e0 = entries[u32(p.w) * 2u];
    let px = x - i.r.x;
    let py = y - i.r.y;
    let sx = select(px, i.r.z - 1 - px, q.x == 1);
    let c = textureLoad(atlas, vec2i(i32(e0.x & 0xFFFFu) + sx, i32(e0.x >> 16u) + py), i32(e0.w & 255u), 0).r;
    if (c == 255u) { discard; }
    return c;
  }
  if (p.x == 1) { if ((glyphRow(p.w, y - p.z) & (16u >> u32(x - p.y))) == 0u) { discard; } return u32(q.x); }
  if (p.x == 2) { return u32(q.x); }
  if (p.x == 3) {
    let c = vec2f(f32(p.y), f32(p.z)) / 16.0;
    let r = f32(p.w) / 16.0;
    let alpha = f32(q.x) / 1000.0;
    if (f32(y) > c.y + r || f32(x) > c.x + r) { discard; }
    let dx = (f32(x) + 0.5 - c.x) / r;
    let dy = (f32(y) + 0.5 - c.y) / r;
    let d = dx * dx + dy * dy;
    let X = x + V.gx0;
    let Y = y + V.gy0;
    if (d > 1.0 || bay(vec2i(X, Y)) > alpha * (1.3 - d * 0.8)) { discard; }
    let l = -(dx * 0.7 + dy * 0.75) + (oh2(X, Y, 78) - 0.5) * 0.2;
    if (d > 0.7 && dx + dy > 0.25) { return ${smoke[0]}u; }
    if (l > 0.35) { return ${smoke[1]}u; }
    return ${smoke[2]}u;
  }
  let x0 = p.y; let y0 = p.z; let x1 = q.x; let y1 = q.y;
  let n = max(abs(x1 - x0), abs(y1 - y0));
  if (n == 0) { discard; }
  var hit = -1;
  for (var k = 0; k < n; k++) {
    let px = i32(rnd(f32(x0) + f32((x1 - x0) * k) / f32(n)));
    let py = i32(rnd(f32(y0) + f32((y1 - y0) * k) / f32(n)));
    if (px == x && py == y) { hit = k; break; }
  }
  if (hit < 0) { discard; }
  if (q.z == 1 && bay(vec2i(x + V.gx0, y + V.gy0)) >= f32(q.w) / 1000.0) { discard; }
  if (q.z == 2) {
    let s = f32(q.w) / 16.0 + length(vec2f(f32(x1 - x0), f32(y1 - y0))) * f32(hit) / f32(n);
    if ((s % 6.0 + 6.0) % 6.0 >= 3.0) { discard; }
  }
  return u32(p.w);
}`;

// ---------- 6. shade ----------
// The light at art px q, at world point wp: ground by its slope toward the key
// light (the island's heights' gradient made relief times as steep), water lying flat; a live sprite as an upright thing
// half lit by the view's share and half by the slope it stands on; an object's sprite likewise, as a forest's canopy
// follows its hillside. Shadow takes sunK of it away: the island's own toward the light, and on ground the sprites'
// silhouettes (mask). A slope turned to the light takes brighter tones (pal.js TONE). Ambient occlusion: the share of
// the sky's light the ground's folds and the trees' cover hide, in 7 dithered steps (the trees' share in the next two
// bits); a sprite pixel takes the wide cover only, the less the higher up the canopy it stands (k art px over its
// foot against the trees' mean height there).
const SHADE_WGSL = (LUT0) => `
fn gridBil(layer: i32, p: vec2f) -> f32 {
  let n = f32(V.gridN) - 1.0;
  let f = clamp(p, vec2f(0.0), vec2f(n));
  let i = vec2i(floor(f));
  let i1 = min(i + 1, vec2i(i32(n)));
  let t = f - floor(f);
  if (layer < 5 && pgOn()) { let q = pgGridQ(gGrid, layer, i); return mix(mix(q.x, q.y, t.x), mix(q.z, q.w, t.x), t.y); }
  let a = textureLoad(gGrid, g_wr(i, 2u, g_WN), layer, 0).r;
  let b = textureLoad(gGrid, g_wr(vec2i(i1.x, i.y), 2u, g_WN), layer, 0).r;
  let c = textureLoad(gGrid, g_wr(vec2i(i.x, i1.y), 2u, g_WN), layer, 0).r;
  let d = textureLoad(gGrid, g_wr(i1, 2u, g_WN), layer, 0).r;
  return mix(mix(a, b, t.x), mix(c, d, t.x), t.y);
}
fn sunBil(p: vec2f) -> f32 {
  let n = f32(V.gridN) - 1.0;
  let f = clamp(p, vec2f(0.0), vec2f(n));
  let i = vec2i(floor(f));
  let i1 = min(i + 1, vec2i(i32(n)));
  let t = f - floor(f);
  return mix(mix(textureLoad(sun, i, 0).r, textureLoad(sun, vec2i(i1.x, i.y), 0).r, t.x), mix(textureLoad(sun, vec2i(i.x, i1.y), 0).r, textureLoad(sun, i1, 0).r, t.x), t.y);
}
fn can0Bil(p: vec2f) -> f32 {
  let n = f32(V.canN) - 1.0;
  let f = clamp(p, vec2f(0.0), vec2f(n));
  let i = vec2i(floor(f));
  let i1 = min(i + 1, vec2i(i32(n)));
  let t = f - floor(f);
  let a = f32(textureLoad(can0, i, 0).r);
  let b = f32(textureLoad(can0, vec2i(i1.x, i.y), 0).r);
  let c = f32(textureLoad(can0, vec2i(i.x, i1.y), 0).r);
  let d = f32(textureLoad(can0, i1, 0).r);
  return mix(mix(a, b, t.x), mix(c, d, t.x), t.y) / 255.0;
}
fn can3Bil(p: vec2f) -> f32 {
  let n = f32(V.can3) - 1.0;
  let f = clamp(p, vec2f(0.0), vec2f(n));
  let i = vec2i(floor(f));
  let i1 = min(i + 1, vec2i(i32(n)));
  let t = f - floor(f);
  return mix(mix(textureLoad(can3, i, 0).r, textureLoad(can3, vec2i(i1.x, i.y), 0).r, t.x), mix(textureLoad(can3, vec2i(i.x, i1.y), 0).r, textureLoad(can3, i1, 0).r, t.x), t.y);
}
struct Lit { row: u32, ao: u32, c: u32 }
fn lightAt(q: vec2i, kind: u32, stand: bool, c0: u32, wp: vec2f, kk: f32) -> Lit {
  var o: Lit;
  o.c = c0; o.ao = 0u;
  let g0 = vec2i(V.gx0, V.gy0);
  let p = (wp + V.half) / V.gridStep;
  let g = vec2f(gridBil(3, p), gridBil(4, p)) * V.relief;
  let tall = gridBil(5, p);
  let fold0 = gridBil(6, p);
  let slope = max(0.0, dot(vec3f(V.lx, V.ly, V.lz), normalize(vec3f(-g.x, 1.0, -g.y))));
  let wet = c0 >= V.wlo && c0 <= V.whi;
  var sh = 0.0;
  if (V.sunK > 0.0) {
    sh = smoothstep(0.3, 0.7, sunBil(p));
    if (kind == 0u || kind == 3u) { sh = max(sh, textureLoad(mask, q, 0).r); }
    sh *= V.sunK;
  }
  if (V.aoK > 0.0 && !wet) {
    let pc = (wp + V.half) / V.canStep;
    let near = can0Bil(pc) * 2.0;
    let wide = can3Bil((pc + 0.5) * f32(V.can3) / f32(V.canN) - 0.5) * 2.0;
    // art px over its foot: its height as drawn less the ground's own height there
    let k = select(0.0, max(0.0, kk - gridBil(0, p) * V.lp / V.levelM), stand);
    let up = 1.0 - smoothstep(0.15, 1.0, k / max(tall * V.pv, 1.0));
    let cover = select(0.5 * (near + wide), max(0.0, wide - V.aoSelf) * (V.aoTop + (1.0 - V.aoTop) * up), stand);
    let treeOcc = 1.0 - exp(-select(V.aoCan, V.aoTree, stand) * cover);
    let fold = V.aoTer * fold0 * select(1.0, 0.6, stand);
    let lost = clamp(1.0 - (1.0 - fold) * (1.0 - treeOcc), 0.0, 1.0);
    o.ao = u32(min(7.0, floor(lost * V.aoK * 7.0 + bay(q + g0)))) | (u32(floor(3.0 * treeOcc / max(treeOcc + fold, 1e-3) + 0.5)) << 3u);
  }
  if (kind != 2u && !wet) {
    let s = 1.5 * tanh(V.toneK * max(0.0, slope - V.flat) * (1.0 - sh) / 1.5);
    let n = f32(V.toneN - 1u);
    let j = u32(clamp(floor((s - V.toneLo) / (V.toneHi - V.toneLo) * n + 0.5 + (bay(q + g0) - 0.5) * 0.55), 0.0, n));
    o.c = tables[2u * V.ncol + j * V.ncol + c0];
  }
  var f = slope;
  if (kind == 2u || kind == 1u) { f = 0.5 * (V.spr + slope); } else if (wet) { f = V.flat; }
  o.row = lvl(f * (1.0 - sh), q + g0);
  return o;
}
fn aoMul(ao: u32, row: u32) -> vec3f {
  if (ao == 0u) { return vec3f(1.0); }
  let a = f32(ao & 7u) / 7.0 * (1.0 - 0.27 * f32(row & 3u));
  let f = f32((row >> 2u) & 15u) / f32(LEVELS - 1);
  let A = vec3f(V.ar, V.ag, V.ab);
  let key = vec3f(V.kr, V.kg, V.kb) * f;
  let hue = mix(vec3f(1.0), vec3f(1.1, 0.85, 1.1), f32(ao >> 3u) / 3.0);
  return max(vec3f(0.0), 1.0 - a * hue * (A + V.aoKey * key) / (A + key + 1e-4));
}
fn hazed(c: u32, q: vec2i) -> u32 {
  let a = V.hmost * pow(max(0.0, 1.0 - (f32(q.y) - V.htop) / V.hreach), 1.5);
  if (a >= 0.001 && bay(q + vec2i(V.gx0, V.gy0)) < min(a, V.hmost)) { return tables[c]; }
  return c;
}
@vertex
fn fullVS(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f { return vec4f(f32((i << 1u) & 2u) * 2.0 - 1.0, f32(i & 2u) * 2.0 - 1.0, 0.0, 1.0); }
@fragment
fn shadeFS(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let q = vec2i(floor(pos.xy));
  let X = q.x + V.gx0;
  let Y = q.y + V.gy0;
  let g = textureLoad(gK, q, 0);
  let w = textureLoad(gW, q, 0);
  var kind = g.x & 3u;
  var c = (g.x >> 8u) & 255u;
  let empty = g.x == 0xFFFFFFFFu;
  let emits = !empty && (g.x & (1u << 16u)) != 0u;
  var pick = g.y;
  var stand = kind == 1u;
  var groundish = kind == 0u || kind == 3u;
  // beyond an island-wide level's map the sea runs on, deep and plain, as the CPU bake once laid it under every chunk
  if (empty) { c = select(V.sea + 1u, V.sea, bay(vec2i(X, Y)) < 0.65); }
  else if (groundish && (V.gflags & 2u) != 0u) {
    // the ground (and the banks between its levels) is left to the planet pass under this one (wgsl/globe.js): nothing is drawn here but the shade the sprites cast on it, as the light's loss over flat ground
    let sh = select(0.0, textureLoad(mask, q, 0).r * V.sunK, V.sunK > 0.0);
    if (sh <= 0.0) { return vec4f(0.0); }
    let lit = vec3f(V.ar, V.ag, V.ab) + vec3f(V.kr, V.kg, V.kb) * V.flat;
    let shd = vec3f(V.ar, V.ag, V.ab) + vec3f(V.kr, V.kg, V.kb) * V.flat * (1.0 - sh);
    return vec4f(0.0, 0.0, 0.0, 1.0 - dot(shd / lit, vec3f(0.3, 0.59, 0.11)));
  }
  else if (kind == 0u) {
    var ctx: PaintCtx;
    ctx.k = V.k; ctx.frame = V.frame; ctx.season = V.season; ctx.flags = V.gflags;
    c = paintGround(w.x, w.y, X, Y, ctx);
  }
  // people seen through the leaves: a checkered silhouette over any other sprite
  let xr = textureLoad(xray, q, 0);
  if (xr.x != 0u && !empty && !groundish && pick != xr.y && ((q.x + q.y) & 1) == 0) { c = xr.x - 1u; kind = 2u; stand = false; }
  // a fire's glow: its light in the row's low two bits, and the ground it tints
  var fire = 0u;
  for (var f = 0u; f < V.nfires; f++) {
    let F = fires.f[f];
    let R = F.z;
    if (f32(q.y) < floor(F.y - R * 0.6) || f32(q.y) > F.y + R * 0.6 || f32(q.x) < floor(F.x - R) || f32(q.x) > F.x + R) { continue; }
    let d = length(vec2f((f32(q.x) - F.x) / R, (f32(q.y) - F.y) / (R * 0.55)));
    if (d >= 1.0) { continue; }
    fire = max(fire, u32(min(3.0, floor((1.0 - d) * 3.4 + bay(vec2i(X, Y))))));
    if (groundish && !empty && bay(vec2i(X, Y)) < (1.0 - d) * (1.4 - V.night * 0.6)) { c = tables[V.ncol + c]; }
  }
  var row = 0u;
  var ao = 0u;
  var pw = w.xy;
  if (emits) { row = EMISSIVE; }
  else if (empty) {
    // the open sea at sea level under the pixel, lit as the bake's deep sea was
    let a = (f32(q.x) + 0.5 - V.offx) / V.H;
    let b = (f32(q.y) + 0.5 - V.offy - V.levc * V.lp) / V.hb;
    let du = (a + b) * 0.5;
    let dv = (b - a) * 0.5;
    let wp = vec2f(V.cx, V.cz) + (du * vec2f(V.eux, V.euy) + dv * vec2f(V.evx, V.evy)) * V.tileM;
    pw = wp;
    let L = lightAt(q, 0u, false, c, wp, 0.0);
    row = L.row * 4u + fire;
  }
  else { let L = lightAt(q, kind, stand, c, w.xy, w.z); row = L.row * 4u + fire; ao = L.ao; c = L.c; }
  let ov = textureLoad(over, q, 0).r;
  if (ov != 255u) { c = ov; row = lvl(V.flat, vec2i(X, Y)) * 4u + fire; ao = 0u; }
  let rgba = unpack4x8unorm(tables[${LUT0}u + row * V.ncol + hazed(c, q)]);
  if (V.aoDbg > 0.5) { return vec4f(vec3f(1.0 - f32(ao & 7u) / 7.0), 1.0); }
  // where a planet shows under the ladder the play area's ground fades into it over V.edge metres at its sides
  var am = 1.0;
  if (V.edge > 0.0) { am = smoothstep(0.0, V.edge, V.half - max(abs(pw.x), abs(pw.y))); }
  return vec4f(rgba.rgb * aoMul(ao, row), am);
}`;

// ---------- the sun map and the ground's folds ----------
// Which ground sees the sun: from each texel of the island's heights, how far the ground
// toward the sun rises above the ray to it (the drawn, exaggerated heights), softened at the edge. The march stops once
// the ray stands above T.top, the island's highest drawn ground and 3.5 m more: past there every step's rise is under
// the -3 m below which the edge's softening gives none, so the map is what the whole march gives, to the bit.
const TRACE_WGSL = `
fn hAt(i: vec2i) -> f32 {
  if (pgOn()) { return pgGridAt(gGrid, 0, i); }
  return textureLoad(gGrid, g_wr(i, 2u, g_WN), 0, 0).r;
}
fn hBil(p: vec2f) -> f32 {
  let n = f32(T.n) - 1.0;
  let f = clamp(p, vec2f(0.0), vec2f(n));
  let i = vec2i(floor(f));
  let i1 = min(i + 1, vec2i(i32(n)));
  let t = f - floor(f);
  if (pgOn()) { let q = pgGridQ(gGrid, 0, i); return mix(mix(q.x, q.y, t.x), mix(q.z, q.w, t.x), t.y); }
  let a = textureLoad(gGrid, g_wr(i, 2u, g_WN), 0, 0).r;
  let b = textureLoad(gGrid, g_wr(vec2i(i1.x, i.y), 2u, g_WN), 0, 0).r;
  let c = textureLoad(gGrid, g_wr(vec2i(i.x, i1.y), 2u, g_WN), 0, 0).r;
  let d = textureLoad(gGrid, g_wr(i1, 2u, g_WN), 0, 0).r;
  return mix(mix(a, b, t.x), mix(c, d, t.x), t.y);
}
@compute @workgroup_size(8, 8)
fn sunMain(@builtin(global_invocation_id) id: vec3u) {
  let y = id.y + T.row0;
  if (id.x >= T.n || y >= T.n) { return; }
  let p = vec2f(f32(id.x), f32(y));
  let h0 = hAt(vec2i(p)) * T.exag;
  let dir = vec2f(T.dx, T.dz);
  var ex = -1e9;
  for (var d = T.step; d < 2400.0; d *= 1.09) {
    if (h0 + d * T.tan > T.top) { break; }
    ex = max(ex, hBil(p + dir * (d / T.step)) * T.exag - (h0 + d * T.tan));
  }
  textureStore(sunOut, vec2i(p), vec4f(smoothstep(-3.0, 10.0, ex), 0.0, 0.0, 1.0));
}
// How much sky the ground's own folds hide: round the point, in 12 directions, how far the
// horizon stands above the tangent plane, out to reach meters, as the sine of the angle between them, averaged.
fn sinAt(t: f32) -> f32 { return t * inverseSqrt(1.0 + t * t); }
@compute @workgroup_size(8, 8)
fn foldMain(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= T.n || id.y >= T.n) { return; }
  let p = vec2f(f32(id.x), f32(id.y));
  let h0 = hAt(vec2i(p)) * T.exag;
  let g = vec2f(hBil(p + vec2f(2.0, 0.0)) - hBil(p - vec2f(2.0, 0.0)), hBil(p + vec2f(0.0, 2.0)) - hBil(p - vec2f(0.0, 2.0))) * T.exag / (4.0 * T.step);
  var occ = 0.0;
  for (var i = 0; i < 12; i++) {
    let a = 6.2831853 * (f32(i) + 0.5) / 12.0;
    let dir = vec2f(cos(a), sin(a));
    let tan0 = dot(g, dir);
    var tanH = tan0;
    for (var d = T.step; d < T.reach; d *= 1.12) { tanH = max(tanH, (hBil(p + dir * (d / T.step)) * T.exag - h0) / d); }
    occ += sinAt(tanH) - sinAt(tan0);
  }
  textureStore(sunOut, vec2i(p), vec4f(occ / 12.0, 0.0, 0.0, 1.0));
}`;

// ---------- present ----------
// The art buffer onto the canvas at (dx, dy), scale sc: nearest at a whole scale, else bilinear between the texels of its
// nn-times nearest upscale, as live.js present() drew with two canvases. A cross-fading level goes over at alpha.
const PRESENT_WGSL = `
@vertex
fn fullVS(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f { return vec4f(f32((i << 1u) & 2u) * 2.0 - 1.0, f32(i & 2u) * 2.0 - 1.0, 0.0, 1.0); }
// premultiplied, so the texels a bilinear read blends weigh by their cover and a clear texel leaves no dark fringe on what is next to it
fn pre(c: vec4f) -> vec4f { return vec4f(c.rgb * c.a, c.a); }
fn artAt(k: vec2f) -> vec4f { return pre(textureLoad(art, clamp(vec2i(floor(k / P.nn)), vec2i(0), vec2i(i32(P.aw) - 1, i32(P.ah) - 1)), 0)); }
@fragment
fn presentFS(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let pc = pos.xy;
  let a = (pc - vec2f(P.dx, P.dy)) / P.sc;
  var c: vec4f;
  if (a.x < 0.0 || a.y < 0.0 || a.x >= f32(P.aw) || a.y >= f32(P.ah)) { discard; }
  else if (P.nearest == 1u) { c = pre(textureLoad(art, vec2i(floor(a)), 0)); }
  else {
    let m = (pc - vec2f(P.dx, P.dy)) * P.nn / P.sc - 0.5;
    let m0 = floor(m);
    let f = m - m0;
    c = mix(mix(artAt(m0), artAt(m0 + vec2f(1.0, 0.0)), f.x), mix(artAt(m0 + vec2f(0.0, 1.0)), artAt(m0 + vec2f(1.0, 1.0)), f.x), f.y);
  }
  return c * P.alpha;
}`;

const GLYPHS = {
  A: "01110 10001 10001 11111 10001 10001 10001", B: "11110 10001 10001 11110 10001 10001 11110", C: "01110 10001 10000 10000 10000 10001 01110", D: "11110 10001 10001 10001 10001 10001 11110",
  E: "11111 10000 10000 11110 10000 10000 11111", F: "11111 10000 10000 11110 10000 10000 10000", G: "01110 10001 10000 10111 10001 10001 01111", H: "10001 10001 10001 11111 10001 10001 10001",
  I: "01110 00100 00100 00100 00100 00100 01110", J: "00111 00010 00010 00010 00010 10010 01100", K: "10001 10010 10100 11000 10100 10010 10001", L: "10000 10000 10000 10000 10000 10000 11111",
  M: "10001 11011 10101 10101 10001 10001 10001", N: "10001 10001 11001 10101 10011 10001 10001", O: "01110 10001 10001 10001 10001 10001 01110", P: "11110 10001 10001 11110 10000 10000 10000",
  Q: "01110 10001 10001 10001 10101 10010 01101", R: "11110 10001 10001 11110 10100 10010 10001", S: "01111 10000 10000 01110 00001 00001 11110", T: "11111 00100 00100 00100 00100 00100 00100",
  U: "10001 10001 10001 10001 10001 10001 01110", V: "10001 10001 10001 10001 10001 01010 00100", W: "10001 10001 10001 10101 10101 10101 01010", X: "10001 10001 01010 00100 01010 10001 10001",
  Y: "10001 10001 01010 00100 00100 00100 00100", Z: "11111 00001 00010 00100 01000 10000 11111",
  0: "01110 10001 10011 10101 11001 10001 01110", 1: "00100 01100 00100 00100 00100 00100 01110", 2: "01110 10001 00001 00010 00100 01000 11111", 3: "11111 00010 00100 00010 00001 10001 01110",
  4: "00010 00110 01010 10010 11111 00010 00010", 5: "11111 10000 11110 00001 00001 10001 01110", 6: "00110 01000 10000 11110 10001 10001 01110", 7: "11111 00001 00010 00100 01000 01000 01000",
  8: "01110 10001 10001 01110 10001 10001 01110", 9: "01110 10001 10001 01111 00001 00010 01100",
  ":": "00000 01100 01100 00000 01100 01100 00000", ".": "00000 00000 00000 00000 00000 01100 01100", ",": "00000 00000 00000 00000 01100 00100 01000", "-": "00000 00000 00000 11111 00000 00000 00000",
  "/": "00001 00001 00010 00100 01000 10000 10000", " ": "00000 00000 00000 00000 00000 00000 00000", "°": "01100 10010 10010 01100 00000 00000 00000",
};

// The renderer. pal: palette indices and tables (pal.js P, NCOL, HAZE, GLOW, TONE, TONE_S, the water ramp's indices,
// TILE_M and ORIGIN of the sim's tiles); ground: ground.wgsl.js packGround's arrays.
export async function createRenderer({ device, context, format, pal, ground, timing }) {
  const { P, NCOL, HAZE, GLOW, TONE, TONE_S, WATER } = pal;
  const errors = [], stats = { traces: 0, gpuMs: 0, tiles: 0, compile: {} };
  const STRUCTS = `${VU.wgsl}\n${TU.wgsl}\n${PU.wgsl}\n${KU.wgsl}\n${FU.wgsl}\n${TYPES}`, GROUND = groundWGSL(1);
  const stage = GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT | GPUShaderStage.COMPUTE;
  const groundLayout = device.createBindGroupLayout({
    label: "ground",
    entries: GROUND_BINDINGS.map((b, i) => (b.kind === "storage" ? { binding: i, visibility: stage, buffer: { type: "read-only-storage" } } : { binding: i, visibility: stage, texture: { sampleType: b.sampleType, viewDimension: b.dim ?? "2d" } })),
  });
  function pipe({ label, binds, code, compute, vs, fs, targets, depth, depthStencil, writeMask, blend, withGround = false, topology = "triangle-list" }) {
    const bgl = device.createBindGroupLayout({ label, entries: layoutEntries(binds, !!compute).map((e) => (e.buffer?.type === "storage" && !compute ? { ...e, visibility: GPUShaderStage.FRAGMENT } : e)) });
    const layout = device.createPipelineLayout({ bindGroupLayouts: withGround ? [bgl, groundLayout] : [bgl] });
    const src = `${STRUCTS}\n${decl(binds)}\n${COMMON}\n${binds.includes("V") ? COMMON_V : ""}\n${withGround ? GROUND : ""}\n${code}`;
    const m = device.createShaderModule({ code: src, label });
    m.getCompilationInfo?.().then((info) => { for (const msg of info.messages) if (msg.type === "error") errors.push(`${label}: ${msg.message} at line ${msg.lineNum}: ${src.split("\n")[msg.lineNum - 1]?.trim()}`); });
    // made asynchronously, all at once, so the shader compiler works on them in parallel
    const t0 = performance.now(), o = { p: null, bgl, binds, label };
    o.ready = (compute
      ? device.createComputePipelineAsync({ label, layout, compute: { module: m, entryPoint: compute } })
      : device.createRenderPipelineAsync({
        label, layout, vertex: { module: m, entryPoint: vs }, primitive: { topology, cullMode: "none" },
        fragment: { module: m, entryPoint: fs, targets: targets.map((f) => ({ format: f, ...(blend && { blend }), ...(writeMask !== undefined && { writeMask }) })) },
        ...(depth && { depthStencil: { format: "depth32float", depthWriteEnabled: true, depthCompare: "less-equal" } }),
        ...(depthStencil && { depthStencil }),
      })).then((p) => { o.p = p; stats.compile[label] = Math.round(performance.now() - t0); }, (e) => errors.push(`${label}: ${e.message.slice(0, 300)}`));
    return o;
  }
  const GT = ["rg32uint", "rgba32float"];
  const fontRows = [], extra = [":", ".", ",", "-", "/", " ", "°"];
  for (const ch of [..."ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789", ...extra]) fontRows.push(...GLYPHS[ch].split(" ").map((r) => parseInt(r, 2)));
  const LUT0 = 10 * NCOL, FONT0 = LUT0 + ROWS * NCOL;
  const S = {
    tiles: pipe({ label: "tiles", binds: ["V", "map:w", "blk"], code: TILES_WGSL, compute: "tilesMain", withGround: true }),
    verts: pipe({ label: "verts", binds: ["V", "map:w", "blk"], code: VERTS_WGSL, compute: "vertsMain", withGround: true }),
    tcull: pipe({ label: "tcull", binds: ["V", "map", "tlist:w", "tcnt:w", "blk"], code: `${MAP_READ}\n${TCULL_WGSL}`, compute: "tcullMain" }),
    clampArgs: pipe({ label: "clampArgs", binds: ["V", "args:w"], code: CLAMP_WGSL, compute: "clampMain" }),
    canBytes: pipe({ label: "canBytes", binds: ["Kp", "canAccR", "canBytes:w"], code: CANOPY_BYTES_WGSL, compute: "canBytesMain" }),
    canWide: pipe({ label: "canWide", binds: ["Kp", "canAccR", "canWide:w"], code: CANOPY_WIDE_WGSL, compute: "canWideMain" }),
    canTall: pipe({ label: "canTall", binds: ["Kp", "canTallR", "canTallOut:w"], code: CANOPY_TALL_WGSL, compute: "canTallMain" }),
    terrain: pipe({ label: "terrain", binds: ["V", "map", "tlist"], code: `${MAP_READ}\n${TERRAIN_WGSL}`, vs: "terrainVS", fs: "terrainFS", targets: GT, depth: true, withGround: true }),
    sprites: pipe({ label: "sprites", binds: ["V", "inst", "entries", "atlas"], code: SPRITE_WGSL("inst").replace(/@fragment\nfn xrayFS[\s\S]*$/, ""), vs: "spriteVS", fs: "spriteFS", targets: GT, depth: true }),
    splatA: pipe({ label: "splatA", binds: ["V", "pts", "entries", "argsR", "keys:w", "zbuf"], code: SPLAT_WGSL.replace(/@compute @workgroup_size\(64\)\nfn splatB[\s\S]*$/, ""), compute: "splatA" }),
    splatB: pipe({ label: "splatB", binds: ["V", "pts", "entries", "argsR", "keysR", "zbuf", "gKs", "gWs", "atlas"], code: SPLAT_WGSL.replace(/@compute @workgroup_size\(64\)\nfn splatA[\s\S]*?\n}\n/, ""), compute: "splatB" }),
    live: pipe({ label: "live", binds: ["V", "live", "entries", "atlas"], code: SPRITE_WGSL("live").replace(/@fragment\nfn xrayFS[\s\S]*$/, ""), vs: "spriteVS", fs: "spriteFS", targets: GT, depth: true }),
    xray: pipe({ label: "xray", binds: ["V", "live", "entries", "atlas"], code: SPRITE_WGSL("live").replace(/@fragment\nfn spriteFS[\s\S]*?\n}\n(?=@fragment)/, ""), vs: "spriteVS", fs: "xrayFS", targets: ["rg32uint"] }),
    mask: pipe({ label: "mask", binds: ["V", "rowInst", "inst", "entries", "rows"], code: MASK_WGSL, vs: "maskVS", fs: "maskFS", targets: ["r8unorm"], topology: "triangle-strip", depthStencil: MASK_TEST }),
    maskLive: pipe({ label: "maskLive", binds: ["V", "liveRows"], code: MASK_LIVE_WGSL, vs: "maskLiveVS", fs: "maskFS", targets: ["r8unorm"], topology: "triangle-strip", depthStencil: MASK_TEST }),
    maskZ: pipe({ label: "maskZ", binds: ["gK"], code: MASK_Z_WGSL, vs: "fullVS", fs: "maskZFS", targets: ["r8unorm"], writeMask: 0, depthStencil: { format: "depth16unorm", depthWriteEnabled: true, depthCompare: "always" } }),
    over: pipe({ label: "over", binds: ["V", "prims", "entries", "atlas", "tables"], code: OVER_WGSL(FONT0, extra.map((c) => c.codePointAt(0)), [P.r4, P.snow, P.r5]), vs: "overVS", fs: "overFS", targets: ["r8uint"] }),
    shade: pipe({ label: "shade", binds: ["V", "gK", "gW", "mask", "over", "xray", "sun", "can0", "can3", "tables", "fires"], code: SHADE_WGSL(LUT0), vs: "fullVS", fs: "shadeFS", targets: ["rgba8unorm"], withGround: true }),
    sun: pipe({ label: "sun", binds: ["T", "sunOut"], code: TRACE_WGSL, compute: "sunMain", withGround: true }),
    fold: pipe({ label: "fold", binds: ["T", "sunOut"], code: TRACE_WGSL, compute: "foldMain", withGround: true }),
    present: pipe({ label: "present", binds: ["P", "art"], code: PRESENT_WGSL, vs: "fullVS", fs: "presentFS", targets: [format], blend: { color: { srcFactor: "one", dstFactor: "one-minus-src-alpha" }, alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha" } } }),
  };

  // ---------- resources ----------
  const B = (size, usage, label) => device.createBuffer({ size: Math.max(16, Math.ceil(size / 4) * 4), usage, label });
  const STOR = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST, UNI = GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST;
  const tex = (o) => device.createTexture({ usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC, dimension: "2d", ...o });
  const upload = (t, data, w, h, bpp, layer = 0) => device.queue.writeTexture({ texture: t, origin: [0, 0, layer] }, data, { bytesPerRow: w * bpp, rowsPerImage: h }, [w, h, 1]);
  // the ground's fields
  const gp = ground;
  // an empty ground (ground-at.js emptyGround: a page whose ground is its windows' pages) holds no fine layers: one texel, which reads as 0 wherever the painter loads past it
  const FS = gp.fine.data ? gp.fine.size : 1, fineW = tex({ size: [FS, FS, gp.fine.layers], format: "r32float", label: "fine" });
  if (gp.fine.data) for (let l = 0; l < gp.fine.layers; l++) upload(fineW, gp.fine.data.subarray(l * gp.fine.size ** 2, (l + 1) * gp.fine.size ** 2), gp.fine.size, gp.fine.size, 4, l);
  const isleW = tex({ size: [gp.isle.size, gp.isle.size, gp.isle.layers], format: "r32float", label: "isle" });
  for (let l = 0; l < gp.isle.layers; l++) upload(isleW, gp.isle.data.subarray(l * gp.isle.size ** 2, (l + 1) * gp.isle.size ** 2), gp.isle.size, gp.isle.size, 4, l);
  const GN = gp.grid.size, gridW = device.createTexture({ size: [GN, GN, 8], format: "r32float", usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC, label: "grid" });
  if (gp.grid.data) for (let l = 0; l < 3; l++) upload(gridW, gp.grid.data.subarray(l * GN * GN, (l + 1) * GN * GN), GN, GN, 4, l);
  const RMN = Math.round(Math.sqrt(gp.river.length)), riverW = tex({ size: [RMN, RMN], format: "r8uint", label: "river" });
  upload(riverW, gp.river, RMN, RMN, 1);
  // the textures the painter reads: the window's (above), or the pages' atlas (setGroundPages)
  let fineT = fineW, isleT = isleW, gridT = gridW, riverT = riverW;
  const TN = pal.TRAIL_N, trailT = tex({ size: [TN, TN], format: "r8uint", label: "trails" });
  const iceT = tex({ size: [pal.TILES, pal.TILES], format: "r8uint", label: "ice" });
  const stor = (data, label) => { const b = B(data.byteLength, STOR, label); device.queue.writeBuffer(b, 0, data); return b; };
  // the gradient table's words, then room for the page table's (pages.js): an on word and sixteen entries, as eighteen words
  const GRAD_WORDS = gp.grad.length, withTable = (data, i) => { if (i !== 7) return data; const o = new Float32Array(GRAD_WORDS + 18); o.set(data); return o; };
  let groundBuffers = GROUND_BINDINGS.map((b, i) => {
    if (b.kind !== "storage") return null;
    const data = [gp.dq, gp.grad, gp.streams, gp.streamBins][i - 6];
    return stor(data.length ? withTable(data, i) : new Uint32Array(4), `ground${i}`);
  });
  const makeGroundGroup = () => device.createBindGroup({
    layout: groundLayout,
    entries: [fineT, isleT, gridT, riverT, trailT, iceT].map((t, i) => ({ binding: i, resource: t.createView(i < 3 ? { dimension: "2d-array" } : {}) })).concat(groundBuffers.slice(6).map((b, k) => ({ binding: 6 + k, resource: { buffer: b } }))),
  });
  let groundGroup = makeGroundGroup();
  // the gradient of the heights for the light (setHeights of old: over two steps each way), into grid layers 3 and 4; the
  // highest of them, under which the sun's trace stops marching
  let gridTop = -Infinity;
  function gradientOf(h) {
    const gx = new Float32Array(GN * GN), gz = new Float32Array(GN * GN), step = pal.GRID_STEP;
    gridTop = -Infinity;
    for (const v of h) if (v > gridTop) gridTop = v;
    const at = (i, j) => h[Math.min(GN - 1, Math.max(0, j)) * GN + Math.min(GN - 1, Math.max(0, i))];
    for (let j = 0; j < GN; j++)
      for (let i = 0; i < GN; i++) {
        gx[j * GN + i] = (at(i + 2, j) + at(i + 1, j) - at(i - 1, j) - at(i - 2, j)) / (6 * step);
        gz[j * GN + i] = (at(i, j + 2) + at(i, j + 1) - at(i, j - 1) - at(i, j - 2)) / (6 * step);
      }
    upload(gridT, gx, GN, GN, 4, 3); upload(gridT, gz, GN, GN, 4, 4);
  }
  if (gp.grid.data) gradientOf(gp.grid.data.subarray(0, GN * GN)); else gridTop = 0;
  // tables: haze, glow, the ground's tones by light, then the sky's light table
  const tables = new Uint32Array(FONT0 + fontRows.length);
  tables.set(HAZE, 0); tables.set(GLOW, NCOL); tables.set(TONE, 2 * NCOL); tables.set(fontRows, FONT0);
  const tablesB = stor(tables, "tables");
  // the sun maps (front and back) and the scratch the ground's folds are traced into
  const sunTex = () => device.createTexture({ size: [GN, GN], format: "r32float", usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC, label: "sun" });
  const sunMaps = [sunTex(), sunTex()], foldT = sunTex();
  let sunFront = 0, sunJob = null, sunShown = null, exagFolded = null;
  // The ground replaced by another of the same size (a window of the planet in place of the island): its layers written into the
  // textures, its stream buffers made again, the gradient and the highest ground worked out again, and the sun's trace and the
  // folds' laid again from the new heights. The trails and the ice are the caller's to set (setTrails, setIce).
  function setGround(g2) {
    useTextures(fineW, isleW, gridW, riverW);
    for (let l = 0; l < g2.isle.layers; l++) upload(isleT, g2.isle.data.subarray(l * g2.isle.size ** 2, (l + 1) * g2.isle.size ** 2), g2.isle.size, g2.isle.size, 4, l);
    const gpu = g2.fine.gpu;
    if (gpu) {
      // made on the GPU (packGround's onGpu): copied into the textures, their buffers let go once the copies are queued
      const enc = device.createCommandEncoder(), M = g2.fine.size, fp = g2.fine.pitch, gp2 = g2.grid.pitch;
      for (let l = 0; l < g2.fine.layers; l++) enc.copyBufferToTexture({ buffer: gpu, offset: l * g2.fine.layerWords * 4, bytesPerRow: fp * 4, rowsPerImage: M }, { texture: fineT, origin: [0, 0, l] }, [M, M, 1]);
      for (let l = 0; l < 5; l++) enc.copyBufferToTexture({ buffer: g2.grid.gpu, offset: l * g2.grid.layerWords * 4, bytesPerRow: gp2 * 4, rowsPerImage: GN }, { texture: gridT, origin: [0, 0, l] }, [GN, GN, 1]);
      enc.copyBufferToTexture({ buffer: g2.river.gpu, bytesPerRow: RMN }, { texture: riverT }, [RMN, RMN, 1]);
      device.queue.submit([enc.finish()]);
      if (!g2.keep) { gpu.destroy(); g2.grid.gpu.destroy(); g2.river.gpu.destroy(); }
      gridTop = g2.grid.top;
    } else {
      for (let l = 0; l < g2.fine.layers; l++) upload(fineT, g2.fine.data.subarray(l * g2.fine.size ** 2, (l + 1) * g2.fine.size ** 2), g2.fine.size, g2.fine.size, 4, l);
      for (let l = 0; l < 3; l++) upload(gridT, g2.grid.data.subarray(l * GN * GN, (l + 1) * GN * GN), GN, GN, 4, l);
      upload(riverT, g2.river, RMN, RMN, 1);
    }
    const old = groundBuffers;
    groundBuffers = GROUND_BINDINGS.map((b, i) => {
      if (b.kind !== "storage") return null;
      const data = [g2.dq, g2.grad, g2.streams, g2.streamBins][i - 6];
      return stor(data.length ? withTable(data, i) : new Uint32Array(4), `ground${i}`);
    });
    groundGroup = makeGroundGroup();
    for (const b of old) b?.destroy();
    setWrap(new Int32Array(10));
    setPages(null);
    if (!gpu) gradientOf(g2.grid.data.subarray(0, GN * GN));
    exagFolded = null; sunShown = null; sunJob = null;
  }
  // ---------- the ground as pages (pages.js) ----------
  // The window's 4 by 4 pages of 64 cells in slots of an atlas of textures, read through a page table in place of the window's own textures. setGroundPages copies the pages
  // made on the GPU (demo/tile.ts pageAtlas, groundPages) into the slots and turns the table on; setGround turns it off again; setGroundPagesOn flips between the two ground
  // sets once both are loaded. The caller owns the atlas buffers. The painter's rasters over the whole window (the trees' mean height, the folds: grid layers 5 and 6) stay
  // window-sized, in layers 5 and 6 of the first group's grid texture; the caller lays them again after a flip (buildCanopy), as it does after setGround.
  let PT = null, pgLogical = null, pgTop = 0, pgOnNow = false;
  const pageNow = new Int32Array(17);
  const useTextures = (f, i, g, r) => { fineT = f; isleT = i; gridT = g; riverT = r; };
  // the table words, to the painter's gradient buffer (after its wrap words) and the looks' table: logical page p read from entry p
  function setPages(logical) {
    pageNow.fill(0);
    pgOnNow = !!logical;
    if (logical) { pageNow[0] = 1; pageNow.set(logical, 1); }
    const words = new Int32Array(18);
    words[0] = pageNow[0]; words.set(pageNow.subarray(1), 2);
    device.queue.writeBuffer(groundBuffers[7], GRAD_WORDS * 4, words);
    metaCPU.set(new Uint32Array(pageNow.buffer), M_PAGES);
    device.queue.writeBuffer(looksB, M_PAGES * 4, pageNow);
  }
  function pageTextures(groups) {
    const T = (size, format, label) => tex({ size, format, label });
    return {
      groups,
      fine: T([PAGE_TEX.fine, PAGE_TEX.fine, groups * PAGE_LAYERS.fine], "r32float", "fine pages"),
      grid: T([PAGE_TEX.grid, PAGE_TEX.grid, groups * PAGE_LAYERS.grid], "r32float", "grid pages"), river: T([PAGE_TEX.river, 1024 * 2 * groups], "r8uint", "river pages"),
    };
  }
  // a slot's page, from the atlas buffers into the textures: fine and grid as the 4 by 4 tile of its group of 16 slots, the mask 8 slots across
  function copySlot(enc, atlas, from, s) {
    const g = s >> 4, tx = s & 3, ty = (s >> 2) & 3;
    enc.copyBufferToTexture({ buffer: atlas.fine, offset: from * PAGE_WORDS.fine * 4, bytesPerRow: PAGE_ROW.fine, rowsPerImage: 257 }, { texture: PT.fine, origin: [tx * 257, ty * 257, g * PAGE_LAYERS.fine] }, [257, 257, PAGE_LAYERS.fine]);
    enc.copyBufferToTexture({ buffer: atlas.grid, offset: from * PAGE_WORDS.grid * 4, bytesPerRow: PAGE_ROW.grid, rowsPerImage: 385 }, { texture: PT.grid, origin: [tx * 385, ty * 385, g * PAGE_LAYERS.grid] }, [385, 385, 5]);
    enc.copyBufferToTexture({ buffer: atlas.mask, offset: from * PAGE_WORDS.mask * 4, bytesPerRow: PAGE_ROW.mask, rowsPerImage: 1024 }, { texture: PT.river, origin: [(s & 7) * 1024, (s >> 3) * 1024] }, [1024, 1024, 1]);
  }
  // The block of pages round the window's, for the planet pass alone (planet.js opts.pages.block): p { block: { face, x0, y0, n, table } or null }, the block's table (n by n slots, row 0 the northmost, -1 for a page not there)
  // being what pageGround gives; its pages are in the textures already (copyPages).
  let blockNow = null;
  function setBlockPages(p) {
    blockNow = p.block ? { ...p.block, table: Int32Array.from(p.block.table) } : null;
    return true;
  }
  // Pages made in the staging atlas (demo/tile.ts pageAtlas) into their slots of the textures: list [{ from, to }], slots how many the textures hold (made by the first call: groundwin.js SLOTS)
  function copyPages(atlas, list, slots) {
    PT ??= pageTextures(Math.ceil(slots / PAGE_SLOTS));
    const enc = device.createCommandEncoder();
    for (const { from, to } of list) copySlot(enc, atlas, from, to);
    device.queue.submit([enc.finish()]);
  }
  // p: { atlas: { slots, fine, grid, mask } (demo/tile.ts pageAtlas), pages: [{ ox, oy, slot, copy }] (the page's corner cell from the window's, in the face's axes as groundPages takes it,
  // multiples of 64 up to 192; copy: false for a slot already holding the page), isle: the window's island fields as setGround takes them (they stay one window texture, uploaded when the pages are turned on), top: the highest ground, and the
  // rest of a setGround pack: dq, grad, streams, streamBins, need: { x0, z0, x1, z1 } the metres the view (and its prefetch margin) will read, in the painter's x and z }. A page of the 4 by 4 that is
  // not listed reads as the nearest listed page's edge, which would show as a smear: so while a page under `need` (the whole window when it is not given) is missing, the pages are loaded
  // but not turned on, the whole screen stays on the window's own textures, and the call returns { on: false, missing: [{ ox, oy }] }; once the pages are there, one call turns them on for the whole screen.
  let winQuick = new Float32Array(4);
  function setGroundPages(p) {
    winQuick = p.grad.slice(8192, 8196);
    const { pages } = p, logical = new Int32Array(16).fill(-1);
    if (!pages.length) throw new Error("setGroundPages: no pages");
    if (!PT) throw new Error("setGroundPages: no page was copied into the textures (copyPages)");
    const slots = PT.groups * PAGE_SLOTS;
    for (const pg of pages) {
      if (pg.ox % 64 || pg.oy % 64 || pg.ox < 0 || pg.oy < 0 || pg.ox > 192 || pg.oy > 192) throw new Error(`setGroundPages: the page at ${pg.ox}, ${pg.oy} is not one of the window's 16`);
      if (!(pg.slot >= 0 && pg.slot < slots)) throw new Error(`setGroundPages: slot ${pg.slot} of ${slots}`);
      // the window's rows are turned against the face's: the page at oy cells up the face is the (192 - oy) / 64 th of the window's rows
      const ix = pg.ox / 64, iy = 3 - pg.oy / 64;
      logical[iy * 4 + ix] = pg.slot;
    }
    const half = -pal.ORIGIN, pm = half / 2, need = p.need ?? { x0: -half, z0: -half, x1: half, z1: half }, missing = [];
    for (let k = 0; k < 16; k++) {
      const ix = k % 4, iy = k >> 2;
      if (logical[k] < 0 && need.x1 > -half + ix * pm && need.x0 < -half + (ix + 1) * pm && need.z1 > -half + iy * pm && need.z0 < -half + (iy + 1) * pm) missing.push({ ox: ix * 64, oy: (3 - iy) * 64 });
    }
    // a page of the 4 by 4 not listed reads as the nearest listed one (logical index, held to its edge by the shader): -(2 + its index)
    for (let k = 0; k < 16; k++) {
      if (logical[k] >= 0) continue;
      let best = -1, bd = Infinity;
      for (let j = 0; j < 16; j++) if (logical[j] >= 0) { const d = (j % 4 - k % 4) ** 2 + ((j >> 2) - (k >> 2)) ** 2; if (d < bd) { bd = d; best = j; } }
      logical[k] = -(2 + best);
    }
    if (missing.length) return { on: false, missing };
    pgLogical = logical; pgTop = p.top ?? p.grid?.top ?? 0;
    adoptPages(p);
    return { on: true, missing };
  }
  // the atlas textures and the table, read from now on; the stream buffers and the trace's top as setGround makes them
  function adoptPages(p) {
    for (let l = 0; l < p.isle.layers; l++) upload(isleW, p.isle.data.subarray(l * p.isle.size ** 2, (l + 1) * p.isle.size ** 2), p.isle.size, p.isle.size, 4, l);
    useTextures(PT.fine, isleW, PT.grid, PT.river);
    const old = groundBuffers;
    groundBuffers = GROUND_BINDINGS.map((b, i) => {
      if (b.kind !== "storage") return null;
      const data = [p.dq, p.grad, p.streams, p.streamBins][i - 6];
      return stor(data.length ? withTable(data, i) : new Uint32Array(4), `ground${i}`);
    });
    groundGroup = makeGroundGroup();
    for (const b of old) b?.destroy();
    gridTop = pgTop;
    setWrap(new Int32Array(10));
    setPages(pgLogical);
    exagFolded = null; sunShown = null; sunJob = null;
  }
  // The pages on or off (the window's own textures read when off), for a check that draws both: false until pages are loaded. The window's textures must hold the window (setGround).
  function setGroundPagesOn(on) {
    if (!PT || !pgLogical) return false;
    if (on) {
      useTextures(PT.fine, isleW, PT.grid, PT.river);
      groundGroup = makeGroundGroup();
      setWrap(new Int32Array(10));
      setPages(pgLogical);
    } else {
      useTextures(fineW, isleW, gridW, riverW);
      groundGroup = makeGroundGroup();
      setWrap(new Int32Array(10));
      setPages(null);
    }
    exagFolded = null; sunShown = null; sunJob = null;
    return on;
  }
  // The trees' cover, laid by the GPU from the trees in the object buffers (wgsl/objects.js canopyMain): cells of
  // canopy.step metres over the island (3 m, or coarser on an island too big for 3 m cells to stay under about 4800 a
  // side), a byte each, its 8 x 8 means, and the scratch it is summed in; rows padded for the copies into textures.
  const SIZE = -2 * pal.ORIGIN, pitch = (bytes) => Math.ceil(bytes / 256) * 256;
  const canopy = { step: Math.max(3, SIZE / 4800) };
  canopy.n = Math.ceil(SIZE / canopy.step) + 1; canopy.n3 = Math.floor(canopy.n / 8);
  Object.assign(canopy, {
    rp: pitch(canopy.n), rp3: pitch(canopy.n3 * 4) / 4, rpt: pitch(GN * 4) / 4,
    t0: tex({ size: [canopy.n, canopy.n], format: "r8uint", label: "canopy" }), t3: tex({ size: [canopy.n3, canopy.n3], format: "r32float", label: "canopy3" }),
  });
  Object.assign(canopy, {
    acc: B(Math.ceil((canopy.n * canopy.n) / 2) * 4, STOR, "canAcc"), tall: B(GN * GN * 8, STOR, "canTall"),
    bytes: B(canopy.rp * canopy.n, STOR | GPUBufferUsage.COPY_SRC, "canBytes"), wide: B(canopy.rp3 * 4 * canopy.n3, STOR | GPUBufferUsage.COPY_SRC, "canWide"),
    tallOut: B(canopy.rpt * 4 * GN, STOR | GPUBufferUsage.COPY_SRC, "canTallOut"),
  });
  const traceU = B(TU.bytes, UNI, "trace"), kpU = B(KU.bytes, UNI, "objpass");

  // objects and sprites: the drawn kinds' sources (setSources), the tables their looks are read by, the survey's bits
  let sources = [];
  // the looks' tables (atlas.js Looks.meta), then from META_WORDS the sprite table: one binding, as a pass may bind only
  // so many storage buffers (ten on some GPUs)
  let looksB = B(META_WORDS * 4 + 16, STOR, "looks");
  const metaCPU = new Uint32Array(META_WORDS);
  let needB = B(16, STOR | GPUBufferUsage.COPY_SRC, "need");
  let entriesB = B(32, STOR, "entries"), rowsB = B(16, STOR, "rows");
  let atlasT = device.createTexture({ size: [ATLAS, ATLAS, 1], format: "r8uint", usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC, label: "atlas" });
  let entriesCap = 0;
  // the instances of the sprites a view draws, then from MAX_INST its one-pixel specks
  const instB = B(2 * MAX_INST * 32, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC, "inst"), rowInstB = B(MAX_ROWS * 8, GPUBufferUsage.STORAGE, "rowInst");
  const argsB = B(64, GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC, "args"), argsInit = B(64, GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST, "argsInit");
  // the indirect draws: sprites (6 vertices), shadow rows (a strip of 4), specks (a dispatch)
  device.queue.writeBuffer(argsInit, 0, new Uint32Array([6, 0, 0, 0, 4, 0, 0, 0, 1, 0, 0, 0, 0, 1, 1, 0]));
  const mapB = B((3 * MAX_TILES + 4096 + BLK_MAX) * 4, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST, "map");
  const blkB = [0, 1].map((k) => B(BLK_MAX * 4, STOR, `blk${k}`));
  const blkF = B(BLK_MAX * 4, STOR, "blkFront");
  // the tile cull's list (every tile of the grid at most) and the indirect draw's arguments: [vertex count, 1, 0, 0] and the count the cull pass adds to
  const tlistB = B(MAX_TILES * 4, GPUBufferUsage.STORAGE, "tlist"), tcntB = B(16, GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC, "tcnt"), tcntInit = B(16, GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST, "tcntInit");
  device.queue.writeBuffer(tcntInit, 0, new Uint32Array([0, 1, 0, 0]));
  // a view's own (two cross-fading views go in one submit, whose queued writes all land before it runs)
  const liveB = [0, 1].map((k) => B(MAX_LIVE * 32, STOR, `live${k}`)), liveRowsB = [0, 1].map((k) => B(MAX_LIVE_ROWS * 16, STOR, `liveRows${k}`)), primsB = [0, 1].map((k) => B(MAX_PRIMS * 32, STOR, `prims${k}`));
  const viewU = [0, 1].map((k) => B(VU.bytes, UNI, `view${k}`)), firesU = [0, 1].map((k) => B(MAX_FIRES * 16, UNI, `fires${k}`)), presentU = [0, 1].map((k) => B(PU.bytes, UNI, `present${k}`));
  // views of textures that live on, made once (a bind group built at every use made 200 a frame)
  const viewCache = new WeakMap();
  const vw = (t, o) => { let m = viewCache.get(t); if (!m) viewCache.set(t, m = new Map()); const k = o ? "a" : ""; let v = m.get(k); if (!v) m.set(k, v = t.createView(o)); return v; };
  const vw2 = (t) => vw(t, { dimension: "2d-array" });
  // per-frame targets, sized to the largest view
  let cap = null;
  function ensure(w, h) {
    if (cap && cap.w >= w && cap.h >= h) return;
    w = Math.max(w, cap?.w ?? 0); h = Math.max(h, cap?.h ?? 0);
    cap?.list.forEach((t) => t.destroy()); cap?.keys.destroy();
    const T = (format, usage = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING) => device.createTexture({ size: [w, h], format, usage });
    const c = { w, h, gK: T("rg32uint", GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC), gW: T("rgba32float", GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING), depth: T("depth32float", GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING), keys: B(w * h * 4, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST, "keys"), mask: T("r8unorm"), maskZ: T("depth16unorm", GPUTextureUsage.RENDER_ATTACHMENT), over: T("r8uint"), xray: T("rg32uint"), art: [0, 1, 2].map(() => T("rgba8unorm", GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC)), pickBuf: null };
    // what each art buffer holds: the level and bearing it was drawn at, its absolute art px origin and size, and the frame
    // it was drawn in (frame's cross-fade presents one from these instead of drawing it again); the third is the page
    // checks' (fadeCheck), a kept view drawn again to compare
    c.list = [c.gK, c.gW, c.depth, c.mask, c.maskZ, c.over, c.xray, ...c.art]; c.tags = [null, null, null];
    cap = c;
  }

  // ---------- bind groups ----------
  const res = (name, v) => {
    switch (name) {
      case "V": return { buffer: viewU[v] };
      case "map": return { buffer: mapB };
      case "tlist": return { buffer: tlistB };
      case "blk": return { buffer: blkB[v] };
      case "tcnt": return { buffer: tcntB };
      case "gridTex": return vw2(gridT);
      case "fineTex": return vw2(fineT);
      case "need": return { buffer: needB };
      case "Kp": return { buffer: kpU };
      case "Fp": return { buffer: farU };
      case "canAcc": case "canAccR": return { buffer: canopy.acc };
      case "canTall": case "canTallR": return { buffer: canopy.tall };
      case "canBytes": return { buffer: canopy.bytes };
      case "canWide": return { buffer: canopy.wide };
      case "canTallOut": return { buffer: canopy.tallOut };
      case "looks": return { buffer: looksB };
      case "entries": return { buffer: entriesB };
      case "rows": return { buffer: rowsB };
      case "inst": return { buffer: instB };
      case "pts": return { buffer: instB, offset: MAX_INST * 32, size: MAX_INST * 32 };
      case "keys": case "keysR": return { buffer: cap.keys };
      case "argsR": return { buffer: argsB };
      case "zbuf": return vw(cap.depth);
      case "gKs": return vw(cap.gK);
      case "gWs": return vw(cap.gW);
      case "rowInst": return { buffer: rowInstB };
      case "args": return { buffer: argsB };
      case "atlas": return vw2(atlasT);
      case "live": return { buffer: liveB[v] };
      case "liveRows": return { buffer: liveRowsB[v] };
      case "prims": return { buffer: primsB[v] };
      case "gK": return vw(cap.gK);
      case "gW": return vw(cap.gW);
      case "mask": return vw(cap.mask);
      case "over": return vw(cap.over);
      case "xray": return vw(cap.xray);
      case "sun": return vw(sunMaps[sunFront]);
      case "can0": return vw(canopy.t0);
      case "can3": return vw(canopy.t3);
      case "tables": return { buffer: tablesB };
      case "fires": return { buffer: firesU[v] };
      case "T": return { buffer: traceU };
      case "P": return { buffer: presentU[v] };
      case "art": return vw(cap.art[v]);
      default: throw new Error(`no resource ${name}`);
    }
  };
  // A bind group is made again only when no one made for this pass and view bound the same resources (a frame used to make 100): buffers are compared by the buffer, views by identity. A pass shared by
  // several sources (the window's blocks of one size) keeps a group for each, up to 64 (the oldest goes, with the buffers it names let go of by the engine's own reference counts).
  const sameRes = (a, b) => a === b || (a?.buffer !== undefined && a.buffer === b?.buffer && a.offset === b.offset && a.size === b.size);
  const groupCache = new WeakMap();
  const group = (s, v = 0, over = {}) => {
    const rs = s.binds.map((n) => { const name = n.split(":")[0]; return over[name] ?? res(name, v); });
    let byView = groupCache.get(s);
    if (!byView) groupCache.set(s, byView = new Map());
    let list = byView.get(v);
    if (!list) byView.set(v, list = []);
    for (const c of list) if (c.layout === s.bgl && c.rs.every((r, i) => sameRes(r, rs[i]))) return c.bg;
    const bg = device.createBindGroup({ layout: s.bgl, entries: s.binds.map((n, i) => ({ binding: RES[n.split(":")[0]][0], resource: rs[i] })) });
    list.push({ layout: s.bgl, rs, bg });
    if (list.length > 64) list.shift();
    return bg;
  };

  // ---------- the light's fields ----------
  // The ground's wrap (ground.wgsl.js g_wrapW): where its logical cell 0 lies in the fine, isle, grid and mask textures, and the noise's offset in whole metres, an x y
  // pair each; the object passes read the same words from the looks' table. All zero for a ground as laid.
  const wrapNow = new Int32Array(10);
  function setWrap(w) {
    wrapNow.set(w);
    device.queue.writeBuffer(groundBuffers[7], 4098 * 8, wrapNow);
    device.queue.writeBuffer(looksB, M_WRAP * 4, wrapNow);
    metaCPU.set(new Uint32Array(wrapNow.buffer), M_WRAP);
  }
  // a logical layer of the grid's size put into a grid-texture layer where the wrap puts it: up to four rectangles, put(x0, y0, w, h, dx, dy) from the layer's (x0, y0) to the texture's (dx, dy)
  function gridRects(layer, put) {
    const sx = wrapNow[4], sy = wrapNow[5];
    for (const [x0, w, dx] of [[0, GN - sx, sx], [GN - sx, sx, 0]])
      for (const [y0, h, dy] of [[0, GN - sy, sy], [GN - sy, sy, 0]]) if (w > 0 && h > 0) put(x0, y0, w, h, dx, dy);
  }
  // A check: the ground's textures rolled kx, ky cells in their own storage and the wrap set to match. Nothing logical changes, so a frame drawn after is the frame drawn before.
  function debugRoll(kx, ky) {
    if (pgOnNow) return debugRollPages(kx, ky);
    if (wrapNow.some(Boolean)) throw new Error("debugRoll: the ground is already rolled");
    const w = new Int32Array(10), enc = device.createCommandEncoder(), temps = [];
    [[fineT, gp.fine.size, 4], [isleT, gp.isle.size, 1], [gridT, GN, 6], [riverT, RMN, 16]].forEach(([t, n, per], k) => {
      const mod = (v) => ((v % n) + n) % n, sx = mod(per * kx), sy = mod(per * ky), d = t.depthOrArrayLayers;
      w[2 * k] = sx; w[2 * k + 1] = sy;
      const tmp = device.createTexture({ size: [n, n, d], format: t.format, usage: GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST });
      enc.copyTextureToTexture({ texture: t }, { texture: tmp }, [n, n, d]);
      for (const [x0, ww, dx] of [[0, n - sx, sx], [n - sx, sx, 0]])
        for (const [y0, hh, dy] of [[0, n - sy, sy], [n - sy, sy, 0]]) if (ww > 0 && hh > 0) enc.copyTextureToTexture({ texture: tmp, origin: [x0, y0, 0] }, { texture: t, origin: [dx, dy, 0] }, [ww, hh, d]);
      temps.push(tmp);
    });
    device.queue.submit([enc.finish()]);
    setWrap(w);
    for (const t of temps) t.destroy();
    // the sun map and the folds traced again over the rolled heights, so their reads and the layer copies are checked too
    exagFolded = null; sunShown = null; sunJob = null;
  }
  // The same check over pages: the page table rolled kx, ky cells (whole pages), which is a permutation of its entries, and the window's own rasters (grid layers 5 and 6) rolled in storage.
  function debugRollPages(kx, ky) {
    if (kx % 64 || ky % 64) throw new Error("debugRoll: pages roll by whole pages (multiples of 64 cells)");
    if (pgLogical.some((v) => v < 0)) throw new Error("debugRoll: the pages roll only when all 16 are resident");
    const mod = (v, n) => ((v % n) + n) % n, w = new Int32Array(10), gx = mod(6 * kx, GN), gy = mod(6 * ky, GN), sx = mod(kx / 64, 4), sy = mod(ky / 64, 4);
    w[4] = gx; w[5] = gy;
    const U = GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST, enc = device.createCommandEncoder();
    const old = { fine: PT.fine, grid: PT.grid, river: PT.river };
    // the pages' data moved: page p's slot is the one the page at (p + shift) held, its tile copied there from a copy of the atlas, and the table made to match
    const copies = Object.fromEntries(Object.entries(old).map(([k, t]) => {
      const c = device.createTexture({ size: [t.width, t.height, t.depthOrArrayLayers], format: t.format, usage: U });
      enc.copyTextureToTexture({ texture: t }, { texture: c }, [t.width, t.height, t.depthOrArrayLayers]);
      return [k, c];
    }));
    const next = new Int32Array(16);
    for (let y = 0; y < 4; y++)
      for (let x = 0; x < 4; x++) {
        const s = pgLogical[y * 4 + x], t = pgLogical[((y + sy) & 3) * 4 + ((x + sx) & 3)];
        next[y * 4 + x] = t;
        const put = (k, n, layers, per) => {
          const at = (q) => (k === "river" ? [(q & 3) * n, (q >> 2) * n, 0] : [(q & 3) * n, ((q >> 2) & 3) * n, (q >> 4) * per]);
          enc.copyTextureToTexture({ texture: copies[k], origin: at(s) }, { texture: old[k], origin: at(t) }, [n, n, layers]);
        };
        put("fine", 257, PAGE_LAYERS.fine, PAGE_LAYERS.fine); put("grid", 385, 5, PAGE_LAYERS.grid); put("river", 1024, 1, 1);
      }
    // the window's own rasters (grid layers 5 and 6) rolled in storage as the window's are
    const tmp = device.createTexture({ size: [GN, GN, 2], format: "r32float", usage: U });
    enc.copyTextureToTexture({ texture: gridT, origin: [0, 0, 5] }, { texture: tmp }, [GN, GN, 2]);
    for (const [x0, ww, dx] of [[0, GN - gx, gx], [GN - gx, gx, 0]])
      for (const [y0, hh, dy] of [[0, GN - gy, gy], [GN - gy, gy, 0]]) if (ww > 0 && hh > 0) enc.copyTextureToTexture({ texture: tmp, origin: [x0, y0, 0] }, { texture: gridT, origin: [dx, dy, 5] }, [ww, hh, 2]);
    device.queue.submit([enc.finish()]);
    pgLogical = next;
    setWrap(w);
    setPages(pgLogical);
    for (const c of [tmp, ...Object.values(copies)]) c.destroy();
    exagFolded = null; sunShown = null; sunJob = null;
  }
  // How much sky the ground's folds hide, traced once over the heights at the drawn exaggeration into grid layer 6.
  function fold(enc, exag) {
    if (exagFolded === exag) return;
    device.queue.writeBuffer(traceU, 0, TU.pack({ n: GN, step: pal.GRID_STEP, exag, reach: TER_REACH }));
    const pass = enc.beginComputePass(tw("fold"));
    pass.setPipeline(S.fold.p); pass.setBindGroup(0, group(S.fold, 0, { sunOut: vw(foldT) })); pass.setBindGroup(1, groundGroup);
    pass.dispatchWorkgroups(Math.ceil(GN / 8), Math.ceil(GN / 8));
    pass.end();
    gridRects(6, (x0, y0, w, h, dx, dy) => enc.copyTextureToTexture({ texture: foldT, origin: [x0, y0] }, { texture: gridT, origin: [dx, dy, 6] }, [w, h, 1]));
    exagFolded = exag;
  }
  // The map for what casts shadows, the sun or the moon (cast: { dir: [x, z] toward it, tan of its elevation, exag }):
  // once it has moved, traced into the back map SUN_STRIPES frames a pass for it as it stood when the pass began, then
  // swapped to the front; the first is traced whole, so shadows show at once.
  function traceSun(enc, cast) {
    if (!cast) return;
    const az = Math.atan2(cast.dir[1], cast.dir[0]), el = Math.atan(cast.tan);
    if (!sunJob) {
      if (sunShown && Math.abs(az - sunShown.az) < SUN_MOVE && Math.abs(el - sunShown.el) < SUN_MOVE && cast.exag === sunShown.exag) return;
      sunJob = { az, el, exag: cast.exag, dir: cast.dir, tan: cast.tan, row: 0 };
    }
    const rows = sunShown ? Math.ceil(GN / SUN_STRIPES) : GN;
    device.queue.writeBuffer(traceU, 0, TU.pack({ n: GN, step: pal.GRID_STEP, exag: sunJob.exag, tan: sunJob.tan, dx: sunJob.dir[0], dz: sunJob.dir[1], row0: sunJob.row, reach: TER_REACH, top: gridTop * sunJob.exag + 3.5 }));
    const pass = enc.beginComputePass(tw("sun"));
    pass.setPipeline(S.sun.p); pass.setBindGroup(0, group(S.sun, 0, { sunOut: vw(sunMaps[1 - sunFront]) })); pass.setBindGroup(1, groundGroup);
    pass.dispatchWorkgroups(Math.ceil(GN / 8), Math.ceil(Math.min(rows, GN - sunJob.row) / 8));
    pass.end();
    sunJob.row += rows;
    if (sunJob.row >= GN) { sunFront = 1 - sunFront; sunShown = sunJob; sunJob = null; stats.traces++; }
  }
  // ---------- objects ----------
  // The drawn kinds (worker.js): each { spec (wgsl/objects.js sourceWGSL's, with indexed and canopy), body, order,
  // start, marks }, the GPU buffers the cull reads, most of them the sim's own. Its cull, survey and canopy passes are
  // made for it here, all at once.
  // A source's passes are made once for its spec (a new spec, as a grown records buffer brings, makes them again). A
  // source names any more buffers its reader binds in binds (drv, gone, counts) and gives them in over, or each frame in
  // dyn() when they are replaced as the sim runs; a source of members has no survey, canopy or far lists.
  function passesOf(s) {
    const sp = s.spec;
      if (!sp.passes) {
        const own = [...(sp.members === "cells" ? [] : ["body"]), ...(sp.marks ? ["marks"] : []), ...(sp.binds ?? [])];
        const src = `${objectWGSL({ ORIGIN: pal.ORIGIN, GN, WS: pal.GRID_STEP, M: gp.fine.size, FSTART: pal.FINE.start, FSTEP: pal.FINE.step })}\n${sourceWGSL(sp, pal.ORIGIN)}`;
        const index = [...(sp.ordered || sp.members === "bins" ? ["order"] : []), ...(sp.indexed || sp.members === "bins" ? ["start"] : [])];
        const out = ["looks", "entries", "inst:w", ...(sp.flat ? [] : ["rowInst:w"]), "args:w", "gridTex", "fineTex"];
        const slots = !sp.members, ground = ["looks", "gridTex", "fineTex"];
        sp.passes = {
          cull: pipe({ label: `cull ${s.name}`, binds: ["V", "map", ...own, ...index, ...(sp.cache ? ["cslot", "ccntR", "cache"] : []), ...out], code: `${MAP_READ}\n${src}\n${cullWGSL(sp)}`, compute: "cullMain" }),
          fill: sp.cache ? pipe({ label: `fill ${s.name}`, binds: ["counts", ...own, "cfill", "ccnt:w", "cache:w", "looks", "gridTex", "fineTex"], code: `${src}\n${cacheFillWGSL(sp)}`, compute: "fillMain" }) : null,
          needs: slots ? pipe({ label: `needs ${s.name}`, binds: ["Kp", ...own, "looks", "need:w", "gridTex", "fineTex"], code: `${src}\n${NEEDS_WGSL}`, compute: "needsMain" }) : null,
          canopy: sp.canopy ? pipe({ label: `canopy ${s.name}`, binds: ["Kp", ...own, "looks", "canAcc:w", "canTall:w", "gridTex", "fineTex"], code: `${src}\n${CANOPY_WGSL(pal.ORIGIN)}`, compute: "canopyMain" }) : null,
          far: slots && sp.indexed && !sp.moves ? {
            cull: pipe({ label: `cull far ${s.name}`, binds: ["V", "map", ...own, "flist", "fidx", ...out], code: `${MAP_READ}\n${src}\n${cullWGSL(sp, true)}`, compute: "cullMain" }),
            count: pipe({ label: `far count ${s.name}`, binds: ["Fp", ...own, "fkey:w", "fcnt:w", ...ground], code: `${src}\n${FAR_COUNT_WGSL}`, compute: "farCount" }),
            // a source builds front lists when its keep pass's storage buffers fit the device's limit (a log's reader
            // and its driver ring do, ten of ten on AMD RDNA-1 2026-10-17), its own buffers all given once (over)
            ...(!s.dyn && sp.front !== false && ["map", ...own, "flist", "fidx", "looks", "entries", "fkeysR", "flistOut", "fout"].filter((n) => RES[n][1] === "storage").length <= device.limits.maxStorageBuffersPerShaderStage && {
              mark: pipe({ label: `front mark ${s.name}`, binds: ["V", "map", ...own, "flist", "fidx", "looks", "entries", "gridTex", "fineTex", "fkeys:w"], code: `${MAP_READ}\n${src}\n${cullWGSL(sp, true, "mark")}`, compute: "cullMain" }),
              keep: pipe({ label: `front keep ${s.name}`, binds: ["V", "map", ...own, "flist", "fidx", "looks", "entries", "gridTex", "fineTex", "fkeysR", "flistOut:w", "fout:w"], code: `${MAP_READ}\n${src}\n${cullWGSL(sp, true, "keep")}`, compute: "cullMain" }),
            }),
          } : null,
        };
      }
    return sp;
  }
  // a spec's passes compiled before any source of it exists (the planet window's, in each size it comes in)
  async function warmSpec(name, spec) {
    const sp = passesOf({ name, spec }).passes;
    await Promise.all([sp.cull.ready, sp.fill?.ready, sp.needs?.ready, sp.canopy?.ready, sp.far?.cull.ready, sp.far?.count.ready, sp.far?.mark?.ready, sp.far?.keep?.ready]);
  }
  async function setSources(list) {
    const made = list.map((s) => {
      const sp = passesOf(s);
      const over = { body: s.body && { buffer: s.body }, order: s.order && { buffer: s.order }, start: s.start && { buffer: s.start }, marks: s.marks && { buffer: s.marks }, ...s.over };
      return { ...s, ...sp.passes, over };
    });
    for (const s of made) if (s.far) { const sc = scanOf(s.spec.n); await Promise.all([sc.far.ready, sc.front.ready]); }
    await Promise.all(made.flatMap((s) => [s.cull.ready, s.fill?.ready, s.needs?.ready, s.canopy?.ready, s.far?.cull.ready, s.far?.count.ready, s.far?.mark?.ready, s.far?.keep?.ready]));
    if (errors.length) throw new Error(errors.join("\n"));
    // a source that is gone (the planet window the camera left) holds no far lists, front lists or cell caches any more
    for (const old of sources) if (!made.some((s) => s.name === old.name)) forgetSource(old.name);
    sources = made;
  }
  function forgetSource(name) {
    const f = farState.get(name);
    if (f) { for (const b of [f.key, f.cnt, ...f.idx, ...f.list]) b?.destroy(); farState.delete(name); }
    for (const [k, fr] of frontState) if (k.startsWith(`${name}|`)) { frontRetired.push(fr.list, fr.idx); frontState.delete(k); }
    for (let i = frontWant.length - 1; i >= 0; i--) if (frontWant[i].startsWith(`${name}|`)) frontWant.splice(i, 1);
    const c = cacheState.get(name);
    if (c) { cacheRetired.push(c.cslot, c.cnt, c.buf, c.fill); cacheState.delete(name); }
  }
  // ---------- the cells' caches (wgsl/objects.js cacheFillWGSL) ----------
  // Per source of cells, by name so they outlive setSources: each cell's slot (NO_SLOT for none), each slot's count and
  // members, and on the CPU the cell each slot holds and the frame that last showed it. A frame fills the cells its
  // views reach that no slot holds, at most FILL_MEMBERS members' worth (at least one cell), into slots no view showed
  // this frame, the least lately shown first; the slots grow when a frame shows more cells than they hold.
  const FILL_MEMBERS = 1 << 19, FILL_MAX = 256, NO_SLOT = 0xffffffff, cacheState = new Map();
  // rev counts what the page changes in the renderer between frames (the mutators below); idleAfter: the last frame left no build, trace, fill or fold to go on with; cacheLeft: cells of a source's cache still to fill
  let cacheFrameNo = 0, cacheRetired = [], cacheLeft = false, rev = 0, idleAfter = false;
  function cacheOf(s) {
    let c = cacheState.get(s.name);
    if (c && c.cm === s.spec.cache.cm) return c;
    if (c) cacheRetired.push(c.cslot, c.cnt, c.buf, c.fill);
    c = { cm: s.spec.cache.cm, slots: 0, cslot: B(CELLS * 4, STOR, "cslot"), cnt: null, buf: null, fill: B((1 + 2 * FILL_MAX) * 4, STOR, "cfill"), cellOf: new Int32Array(0), used: new Uint32Array(0), slotOf: new Map() };
    device.queue.writeBuffer(c.cslot, 0, new Uint32Array(CELLS).fill(NO_SLOT));
    cacheGrow(c, 64, null);
    cacheState.set(s.name, c);
    return c;
  }
  // a cache's slots grown to n, what they hold copied over in enc
  function cacheGrow(c, n, enc) {
    const cnt = B(n * 4, STOR | GPUBufferUsage.COPY_SRC, "ccnt"), buf = B(n * c.cm * 12, STOR | GPUBufferUsage.COPY_SRC, "cache");
    if (c.slots) {
      enc.copyBufferToBuffer(c.cnt, 0, cnt, 0, c.slots * 4);
      enc.copyBufferToBuffer(c.buf, 0, buf, 0, c.slots * c.cm * 12);
      cacheRetired.push(c.cnt, c.buf);
    }
    const cellOf = new Int32Array(n).fill(-1), used = new Uint32Array(n);
    cellOf.set(c.cellOf); used.set(c.used);
    Object.assign(c, { slots: n, cnt, buf, cellOf, used });
  }
  // Whether any object of a cell reaching at most reach px can reach into a view (wgsl/objects.js cellSeen).
  function cellSeen(U, cell, reach) {
    const x0 = (cell % CELLS_N) * CELL_M + pal.ORIGIN, z0 = Math.floor(cell / CELLS_N) * CELL_M + pal.ORIGIN;
    let lx = Infinity, hx = -Infinity, ly = Infinity, hy = -Infinity;
    for (let k = 0; k < 4; k++) {
      const dx = x0 + (k & 1) * CELL_M - U.cx, dz = z0 + (k >> 1) * CELL_M - U.cz;
      const a = (dx * U.eux + dz * U.euy) / U.tileM, b = (dx * U.evx + dz * U.evy) / U.tileM;
      const sx = (a - b) * U.H + U.offx, sy = (a + b) * U.hb + U.offy;
      lx = Math.min(lx, sx); hx = Math.max(hx, sx); ly = Math.min(ly, sy); hy = Math.max(hy, sy);
    }
    return !(hx < -reach || lx > U.aw + reach || hy + U.levc * U.lp < -reach || ly - (U.peak - U.levc) * U.lp > U.ah + reach);
  }
  // The cells this frame's views reach, held or filled. The reach is four px wider than the cull's, so every cell the
  // GPU walks is held whatever the floats round to.
  function cacheFrame(enc, views) {
    cacheFrameNo++; cacheLeft = false;
    const jobs = [];
    for (const s of sources) {
      if (!s.fill) continue;
      const c = cacheOf(s), counts = s.spec.cache.counts, most = s.spec.most, shown = new Set(), want = [];
      for (const v of views) {
        const U = v.U, hm = (most < 1 ? most ** 0.55 : most) * Math.max(U.pv, U.pw);
        if (hm < 1) continue;
        const r = cellRect(U), reach = hm * 6 + 8 + 4;
        for (let cy = r.cy0; cy <= r.cy1; cy++)
          for (let cx = r.cx0; cx <= r.cx1; cx++) {
            const cell = cy * CELLS_N + cx;
            if (!counts[cell] || shown.has(cell) || !cellSeen(U, cell, reach)) continue;
            shown.add(cell);
            const slot = c.slotOf.get(cell);
            if (slot === undefined) want.push(cell);
            else c.used[slot] = cacheFrameNo;
          }
      }
      if (shown.size > c.slots) cacheGrow(c, Math.ceil(shown.size * 1.25), enc);
      const fill = [];
      let budget = FILL_MEMBERS, fullest = 1;
      for (const cell of want) {
        if (fill.length && (budget < counts[cell] || fill.length >= 2 * FILL_MAX)) break;
        let slot = -1;
        for (let j = 0; j < c.slots; j++) {
          if (c.used[j] === cacheFrameNo) continue;
          if (c.cellOf[j] < 0) { slot = j; break; }
          if (slot < 0 || c.used[j] < c.used[slot]) slot = j;
        }
        if (slot < 0) break;
        const old = c.cellOf[slot];
        if (old >= 0) { c.slotOf.delete(old); device.queue.writeBuffer(c.cslot, old * 4, Uint32Array.of(NO_SLOT)); }
        c.cellOf[slot] = cell; c.slotOf.set(cell, slot); c.used[slot] = cacheFrameNo;
        device.queue.writeBuffer(c.cslot, cell * 4, Uint32Array.of(slot));
        // after any copy of a grown cache's counts, which the queue's writes would come before
        enc.clearBuffer(c.cnt, slot * 4, 4);
        fill.push(cell, slot);
        budget -= counts[cell];
        fullest = Math.max(fullest, counts[cell]);
      }
      if (want.length > fill.length / 2) cacheLeft = true;
      if (!fill.length) continue;
      device.queue.writeBuffer(c.fill, 0, Uint32Array.from([fill.length / 2, ...fill]));
      jobs.push({ s, c, n: fill.length / 2, fullest });
      cacheLeft = true;
    }
    if (!jobs.length) return;
    const pass = enc.beginComputePass(tw("fill"));
    for (const { s, c, n, fullest } of jobs) {
      pass.setPipeline(s.fill.p);
      pass.setBindGroup(0, group(s.fill, 0, { ...s.over, ...s.dyn?.(), cfill: { buffer: c.fill }, ccnt: { buffer: c.cnt }, cache: { buffer: c.buf } }));
      // a thread for every 64 of the fullest cell's members, at most 256 workgroups a cell
      pass.dispatchWorkgroups(Math.min(256, Math.ceil(fullest / 4096)), n);
    }
    pass.end();
  }
  // A source of cells' cache buffers as its cull binds them.
  const cacheBinds = (s) => { const c = cacheState.get(s.name); return { cslot: { buffer: c.cslot }, ccntR: { buffer: c.cnt }, cache: { buffer: c.buf } }; };
  // ---------- the far levels' lists (wgsl/objects.js FAR_COUNT_WGSL) ----------
  // Per indexed source, by name so they outlive setSources: the slots' keys, the counts (then the runs' cursors), and two
  // lists with their cell index, one drawn from (front) while the other is built. A build goes a slice of slots a frame.
  const FAR_SLICE = 1 << 20;
  // the far index's and the front lists' sizes for a source of n cells a side (spec.n, 256 unless it says)
  const farIdxWords = (n) => { const c = cellsOf(n); return c.FAR_LVL + 8 * c.CELLS; };
  const farU = B(FU.bytes, UNI, "far"), farState = new Map();
  // farUse: off for the page checks (scripts/play/objects.ts), which compare a far view drawn both ways
  // farGens numbers every far list built, so a front list knows the far list it came from (f.gen, and f.prevGen before it)
  let farN = 0, farUse = true, skipped = new Set(), farGens = 0;
  // the scans lay out a source's cells, so one pair per cell count
  const scanPipes = new Map();
  function scanOf(n = CELLS_N) {
    let p = scanPipes.get(n);
    if (!p) scanPipes.set(n, p = { far: pipe({ label: `far scan ${n}`, binds: ["Fp", "fcntR:w", "fidx:w"], code: farScanWGSL(n), compute: "farScan" }), front: pipe({ label: `front scan ${n}`, binds: ["Fp", "fidx", "fout:w"], code: frontScanWGSL(n), compute: "frontScan" }) });
    return p;
  }
  const farFileP = pipe({ label: "far file", binds: ["Fp", "fkey", "fcnt:w", "flist:w"], code: FAR_FILE_WGSL, compute: "farFile" });
  function farOf(s) {
    let f = farState.get(s.name);
    if (f && f.body === s.body) return f;
    if (f) for (const b of [f.key, f.cnt, ...f.idx, ...f.list]) b?.destroy();
    f = { body: s.body, cap: s.spec.cap, key: B(s.spec.cap * 4, STOR, "farKey"), cnt: B(cellsOf(s.spec.n).CELLS * 8 * 4, STOR, "farCnt"), idx: [0, 1].map(() => B(farIdxWords(s.spec.n) * 4, STOR | GPUBufferUsage.COPY_SRC, "farIdx")), list: [null, null], n: [0, 0], front: -1, job: null, gen: 0 };
    farState.set(s.name, f);
    return f;
  }
  // Every indexed source's lists built again from its buffers as they are now, a slice a frame (farFrame); nf: how many
  // levels (the coarsest) are far.
  function farBuild(nf) {
    farN = nf;
    for (const s of sources) if (s.far) { const f = farOf(s); f.job = { phase: "count", at: 0 }; }
  }
  // One step of a source's build into enc; after: what to run once enc is submitted.
  function farStep(enc, s, f, slice) {
    const j = f.job, back = f.front === 0 ? 1 : 0;
    if (j.phase === "count" || j.phase === "file") {
      const n = Math.min(slice, f.cap - j.at);
      device.queue.writeBuffer(farU, 0, FU.pack({ base: j.at, n, nf: farN }));
      if (j.phase === "count" && j.at === 0) enc.clearBuffer(f.cnt);
      const pass = enc.beginComputePass(tw("far"));
      if (j.phase === "count") { pass.setPipeline(s.far.count.p); pass.setBindGroup(0, group(s.far.count, 0, { ...s.over, fkey: { buffer: f.key }, fcnt: { buffer: f.cnt } })); pass.setBindGroup(1, groundGroup); }
      else { pass.setPipeline(farFileP.p); pass.setBindGroup(0, group(farFileP, 0, { fkey: { buffer: f.key }, fcnt: { buffer: f.cnt }, flist: { buffer: f.list[back] } })); }
      pass.dispatchWorkgroups(...spread(n));
      pass.end();
      j.at += n;
      if (j.at < f.cap) return null;
      if (j.phase === "count") { j.phase = "scan"; return null; }
      f.front = back; f.job = null; f.prevGen = f.gen; f.gen = ++farGens; stats.far = { ...stats.far, [s.name]: f.n[back] };
      return null;
    }
    if (j.phase !== "scan") return null;
    device.queue.writeBuffer(farU, 0, FU.pack({ base: 0, n: 0, nf: farN }));
    const pass = enc.beginComputePass();
    const scanP = scanOf(s.spec.n).far;
    pass.setPipeline(scanP.p); pass.setBindGroup(0, group(scanP, 0, { fcntR: { buffer: f.cnt }, fidx: { buffer: f.idx[back] } })); pass.dispatchWorkgroups(1);
    pass.end();
    const rb = B(4, GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST, "farTotal");
    enc.copyBufferToBuffer(f.idx[back], cellsOf(s.spec.n).CELLS * 4, rb, 0, 4);
    j.phase = "wait";
    return () => rb.mapAsync(GPUMapMode.READ).then(() => {
      const total = new Uint32Array(rb.getMappedRange())[0];
      rb.unmap(); rb.destroy();
      // a slot is in the list once at most: a total over the cap is a scan of counts that were not this build's (a submit of it was dropped), so the build is made again, and never sized from it
      if (total > f.cap) {
        if (f.job === j) f.job = (j.tries ?? 0) < 3 ? { phase: "count", at: 0, tries: (j.tries ?? 0) + 1 } : null;
        return;
      }
      f.n ??= [0, 0]; f.n[back] = total;
      if (!f.list[back] || f.list[back].size < total * 4) { f.list[back]?.destroy(); f.list[back] = B(Math.max(16, Math.ceil(total * 1.25) * 4), STOR, "farList"); }
      if (f.job === j) { j.phase = "file"; j.at = 0; }
    });
  }
  // in a frame: one step of the first source with a build under way; whether one is under way
  function farFrame(enc) {
    for (const s of sources) {
      const f = s.far && farState.get(s.name);
      if (!f?.job || f.body !== s.body) continue;
      if (f.job.phase === "wait" || !scanOf(s.spec.n).far.p || !farFileP.p) return true;
      const after = farStep(enc, s, f, FAR_SLICE);
      if (after) pendingPickReads.push(after);
      return true;
    }
    return false;
  }
  // ---------- the far levels' front lists (wgsl/objects.js frontWalk) ----------
  // Per source that builds them, level and whole bearing, by name so they outlive setSources: the list and its index,
  // laid out as a far list's, and the far list generation it was built from. One is built at a time, FRONT_ROWS rows
  // of cells a frame [design: a thirty-second of the island a slice, under 2 ms of a frame; sixteen rows measured 0.3 to
  // 5.3 ms on AMD RDNA-1 2026-10-16], from the view of the whole
  // island at its level and bearing (frontViews, from live.js islandView): the far list's counts at the level scanned
  // into the cells' runs, every slice marked, then every slice kept; it replaces the one it was built again for when
  // done. A view walks a front list while its far list is the one it was built from or one a sim day newer (its objects
  // are drawn as their buffers hold them now; one grown into a pixel since is in neither); the frame asks for the front
  // lists of its views' bearing at every level that has them, its own level first.
  const FRONT_ROWS = 8;
  const frontU = B(FU.bytes, UNI, "front"), frontV = B(VU.bytes, UNI, "frontView"), frontState = new Map(), frontWant = [];
  let frontViews = new Map(), frontUse = true, frontJob = null, frontKeys = null;
  // the views of the whole island live.js laid out, [{ L, b, U }], those whose tile map fits the map buffer
  function setFrontViews(list) { frontViews = new Map(list.filter((v) => v.U.ni * v.U.nj <= MAX_TILES && (v.U.ni + 1) * (v.U.nj + 1) <= MAX_TILES + 4096).map((v) => [`${v.L}|${v.b}`, v.U])); }
  // the front list a view of source s draws from, if any
  function frontOf(s, f, L, beta) {
    if (!frontUse || !Number.isInteger(beta) || !frontViews.has(`${L}|${beta}`) || !s.far.keep) return null;
    const key = `${s.name}|${L}|${beta}`, fr = frontState.get(key);
    if ((!fr || fr.gen !== f.gen) && !frontWant.includes(key) && frontJob?.key !== key) frontWant.push(key);
    return fr && (fr.gen === f.gen || fr.gen === f.prevGen) ? fr : null;
  }
  // the levels and bearings a frame's views ask for: those the page says it will show next first (ahead: [{ L, b }], a
  // zoom's first level before its first frame), then each view's own, then every other level at its bearing, the
  // nearest levels first (those a zoom's cross-fade reaches next), so a level is seldom first drawn walking its far list
  function frontAsk(views, ahead = []) {
    const at = [...frontViews.keys()].map((k) => k.split("|").map(Number));
    for (const s of sources) {
      const f = s.far && farState.get(s.name);
      if (!f || f.front < 0 || !s.far.keep) continue;
      for (const a of ahead) frontOf(s, f, a.L, a.b);
      for (const v of views) for (const L of [v.L, ...at.filter(([, b]) => b === v.beta).map(([l]) => l)]) frontOf(s, f, L, v.beta);
    }
    const rank = (key) => {
      const [, L, b] = key.split("|").map(Number);
      if (ahead.some((a) => a.L === L && a.b === b)) return -1;
      return Math.min(...views.map((v) => (b === v.beta ? Math.abs(L - v.L) : Infinity)));
    };
    if (frontWant.length > 1) frontWant.sort((a, b) => rank(a) - rank(b));
  }
  // The levels and whole bearings ("L|b") whose front lists are all built for the far lists drawn now, so a view there
  // walks no far list; none before the far lists are.
  function frontsReady() {
    const keep = sources.filter((s) => s.far?.keep);
    const fars = keep.map((s) => farState.get(s.name));
    if (!keep.length || fars.some((f) => !f || f.front < 0)) return [];
    return [...frontViews.keys()].filter((v) => keep.every((s, i) => {
      const fr = frontState.get(`${s.name}|${v}`), f = fars[i];
      return fr && (fr.gen === f.gen || fr.gen === f.prevGen);
    }));
  }
  // One step of the front list being built, into enc; after: what to run once enc is submitted.
  function frontFrame(enc) {
    if (!frontJob) {
      const key = frontWant.shift();
      if (!key) return null;
      const [name, L, b] = key.split("|"), s = sources.find((x) => x.name === name), f = s && farState.get(name), U = frontViews.get(`${L}|${b}`);
      if (!f || f.front < 0 || !U || !s.far.keep?.p || !s.far.mark?.p || !scanOf(s.spec.n).front.p) return null;
      frontJob = { key, s, f, L: +L, U, gen: f.gen, phase: "scan", row: 0 };
    }
    const j = frontJob, f = j.f, s = j.s;
    // a far list built again under the job, or a source made again: begun again
    if (f.gen !== j.gen || farState.get(s.name) !== f || !sources.includes(s)) { frontRetired.push(...[j.idx, j.list].filter(Boolean)); frontWant.unshift(j.key); frontJob = null; return null; }
    const flist = { buffer: f.list[f.front] }, fidx = { buffer: f.idx[f.front] };
    if (j.phase === "scan") {
      j.idx = B(farIdxWords(s.spec.n) * 4, STOR | GPUBufferUsage.COPY_SRC, "frontIdx");
      device.queue.writeBuffer(frontU, 0, FU.pack({ lvl: j.L }));
      const pass = enc.beginComputePass();
      const fscan = scanOf(s.spec.n).front;
      pass.setPipeline(fscan.p); pass.setBindGroup(0, group(fscan, 0, { Fp: { buffer: frontU }, fidx, fout: { buffer: j.idx } })); pass.dispatchWorkgroups(1);
      pass.end();
      const rb = B(4, GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST, "frontTotal");
      enc.copyBufferToBuffer(j.idx, cellsOf(s.spec.n).CELLS * 4, rb, 0, 4);
      j.phase = "wait";
      return () => rb.mapAsync(GPUMapMode.READ).then(() => {
        j.n = new Uint32Array(rb.getMappedRange())[0];
        rb.unmap(); rb.destroy();
        j.list = B(Math.max(16, j.n * 4), STOR, "frontList");
        if (frontJob !== j) j.list.destroy();
        // nothing at this level to mark or keep: done (drawView walks no empty list)
        else if (!j.n) frontDone(j);
        else j.phase = "mark";
      });
    }
    if (j.phase === "wait") return null;
    const U = j.U, words = U.aw * U.ah;
    if (!frontKeys || frontKeys.size < words * 4) { frontKeys?.destroy(); frontKeys = B(words * 4, STOR | GPUBufferUsage.COPY_DST, "frontKeys"); }
    if (j.phase === "mark" && j.row === 0) enc.clearBuffer(frontKeys, 0, words * 4);
    const rows = Math.min(FRONT_ROWS, CELLS_N - j.row);
    device.queue.writeBuffer(frontV, 0, VU.pack({ ...U, cx0: 0, cx1: CELLS_N - 1, cy0: j.row, cy1: j.row + rows - 1, farL: j.L, maxinst: MAX_INST, maxrows: MAX_ROWS, gridN: GN, gridStep: pal.GRID_STEP, canN: canopy.n, canStep: canopy.step, can3: canopy.n3, ncol: NCOL }));
    const V = { buffer: frontV };
    // the island's tile map at the level and bearing, as a frame lays out a view's (every block of its rectangle), then the slice
    const blk = (j.blk ??= fullBlocks(U));
    device.queue.writeBuffer(blkF, 0, blk);
    enc.clearBuffer(mapB, FOFF_B, Math.min(BLK_MAX, U.nbi * Math.ceil(U.nj / 16)) * 4);
    let pass = enc.beginComputePass(tw("front"));
    pass.setBindGroup(1, groundGroup);
    pass.setPipeline(S.tiles.p); pass.setBindGroup(0, group(S.tiles, 0, { V, blk: { buffer: blkF } })); pass.dispatchWorkgroups(blk.length);
    pass.setPipeline(S.verts.p); pass.setBindGroup(0, group(S.verts, 0, { V, blk: { buffer: blkF } })); pass.dispatchWorkgroups(blk.length);
    pass.end();
    pass = enc.beginComputePass(tw("front"));
    pass.setBindGroup(1, groundGroup);
    const p = j.phase === "mark" ? s.far.mark : s.far.keep, own = j.phase === "mark" ? { fkeys: { buffer: frontKeys } } : { fkeysR: { buffer: frontKeys }, flistOut: { buffer: j.list }, fout: { buffer: j.idx } };
    pass.setPipeline(p.p); pass.setBindGroup(0, group(p, 0, { ...s.over, V, flist, fidx, ...own })); pass.dispatchWorkgroups(CELLS_N, rows);
    pass.end();
    j.row += rows;
    if (j.row < CELLS_N) return null;
    if (j.phase === "mark") { j.phase = "keep"; j.row = 0; return null; }
    frontDone(j);
    return null;
  }
  function frontDone(j) {
    const old = frontState.get(j.key);
    if (old) frontRetired.push(old.list, old.idx);
    frontState.set(j.key, { list: j.list, idx: j.idx, gen: j.gen, n: j.n });
    stats.front = { ...stats.front, [j.key]: j.n };
    frontJob = null;
  }
  const frontRetired = [];
  // a source's slots as workgroups, 256 threads each, folded into two dimensions past the 65535 limit
  const spread = (n) => { const wg = Math.max(1, Math.ceil(n / 256)), wx = Math.min(wg, 32768); return [wx, Math.ceil(wg / wx)]; };
  // the tables looks are read by (atlas.js Looks.meta)
  function setMeta(words) {
    metaCPU.set(words); device.queue.writeBuffer(looksB, 0, words); device.queue.writeBuffer(looksB, M_WRAP * 4, wrapNow);
    metaCPU.set(new Uint32Array(wrapNow.buffer), M_WRAP); metaCPU.set(new Uint32Array(pageNow.buffer), M_PAGES); device.queue.writeBuffer(looksB, M_PAGES * 4, pageNow);
  }
  // The survey (wgsl/objects.js needsMain) over every source: mode 0 the kind and species pairs, mode 1 the families and
  // sizes the first nl levels draw, as bits; words: how many 32-bit words of them.
  // rect: the part of the sources (their frame, metres from the origin) the families and sizes are asked of, [x0, z0, x1, z1]; none asks of all of them
  // split: one set of bits for each level from l0 to nl, one after another (words each), not all in one
  async function survey(mode, nl, words, l0 = 0, rect = null, split = false) {
    const total = words * (split ? Math.max(1, nl - l0) : 1);
    if (needB.size < total * 4) { needB.destroy(); needB = B(total * 4, STOR | GPUBufferUsage.COPY_SRC, "need"); }
    const read = B(total * 4, GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST, "needRead");
    device.queue.writeBuffer(kpU, 0, KU.pack({ mode, nl, l0, stride: split ? words : 0, vx0: rect ? rect[0] : -1e30, vz0: rect ? rect[1] : -1e30, vx1: rect ? rect[2] : 1e30, vz1: rect ? rect[3] : 1e30 }));
    const enc = device.createCommandEncoder();
    enc.clearBuffer(needB, 0, total * 4);
    const pass = enc.beginComputePass();
    for (const s of sources) {
      if (!s.needs) continue;
      pass.setPipeline(s.needs.p); pass.setBindGroup(0, group(s.needs, 0, s.over)); pass.setBindGroup(1, groundGroup);
      pass.dispatchWorkgroups(...spread(s.spec.cap));
    }
    pass.end();
    enc.copyBufferToBuffer(needB, 0, read, 0, total * 4);
    device.queue.submit([enc.finish()]);
    await read.mapAsync(GPUMapMode.READ);
    const out = new Uint32Array(read.getMappedRange().slice(0));
    read.destroy();
    return out;
  }
  // The trees' cover laid again from every tree the sources hold now: summed, packed and copied into the textures the
  // light reads (can0, can3, and the trees' mean height into grid layer 5).
  function buildCanopy() {
    const c = canopy;
    device.queue.writeBuffer(kpU, 0, KU.pack({ canN: c.n, canStep: c.step, gn: GN, gs: pal.GRID_STEP, rp: c.rp, n3: c.n3, rp3: c.rp3, rpt: c.rpt }));
    const enc = device.createCommandEncoder();
    enc.clearBuffer(c.acc); enc.clearBuffer(c.tall);
    let pass = enc.beginComputePass();
    for (const s of sources) if (s.canopy) { pass.setPipeline(s.canopy.p); pass.setBindGroup(0, group(s.canopy, 0, s.over)); pass.setBindGroup(1, groundGroup); pass.dispatchWorkgroups(...spread(s.spec.cap)); }
    pass.end();
    pass = enc.beginComputePass();
    pass.setPipeline(S.canBytes.p); pass.setBindGroup(0, group(S.canBytes)); pass.dispatchWorkgroups(Math.ceil(c.rp / 4 / 64), c.n);
    pass.setPipeline(S.canWide.p); pass.setBindGroup(0, group(S.canWide)); pass.dispatchWorkgroups(Math.ceil(c.n3 / 8), Math.ceil(c.n3 / 8));
    pass.setPipeline(S.canTall.p); pass.setBindGroup(0, group(S.canTall)); pass.dispatchWorkgroups(Math.ceil(GN / 8), Math.ceil(GN / 8));
    pass.end();
    enc.copyBufferToTexture({ buffer: c.bytes, bytesPerRow: c.rp }, { texture: c.t0 }, [c.n, c.n, 1]);
    enc.copyBufferToTexture({ buffer: c.wide, bytesPerRow: c.rp3 * 4 }, { texture: c.t3 }, [c.n3, c.n3, 1]);
    gridRects(5, (x0, y0, w, h, dx, dy) => enc.copyBufferToTexture({ buffer: c.tallOut, offset: y0 * c.rpt * 4 + x0 * 4, bytesPerRow: c.rpt * 4 }, { texture: gridT, origin: [dx, dy, 5] }, [w, h, 1]));
    device.queue.submit([enc.finish()]);
  }
  // The cells of the sim's spatial index under a view's tile window, whose corners in world metres bound it.
  function cellRect(U) {
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const u of [U.i0, U.i0 + U.ni])
      for (const v of [U.j0, U.j0 + U.nj]) {
        const x = U.obx + (u * U.eubx + v * U.evbx) * U.tileM, z = U.obz + (u * U.euby + v * U.evby) * U.tileM;
        x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z);
      }
    const c = (m) => Math.max(0, Math.min(CELLS_N - 1, Math.floor((m - pal.ORIGIN) / CELL_M)));
    return { cx0: c(x0), cx1: c(x1), cy0: c(z0), cy1: c(z1) };
  }
  // The atlas: layers of ATLAS x ATLAS palette indices; entries two vec4u per sprite; rows each casting row's span; table
  // the sprite (id + 1) of each family and size, 0 where none was made.
  function setAtlas({ layers, entries, rows, table }) {
    atlasT.destroy();
    atlasT = device.createTexture({ size: [ATLAS, ATLAS, layers], format: "r8uint", usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC, label: "atlas" });
    entriesB.destroy(); rowsB.destroy();
    entriesCap = entries.length / 8;
    entriesB = B(entries.byteLength, STOR, "entries"); rowsB = B(Math.max(16, rows.byteLength), STOR, "rows");
    device.queue.writeBuffer(entriesB, 0, entries); if (rows.length) device.queue.writeBuffer(rowsB, 0, rows);
    setTable(table);
  }
  // pixels into the atlas: a w x h block at (x, y) of layer l
  const atlasPut = (l, x, y, w, h, px) => device.queue.writeTexture({ texture: atlasT, origin: [x, y, l] }, px, { bytesPerRow: w }, [w, h, 1]);
  // sprite entries from `at` on (live sprites, made as they are needed)
  const tablePut = (slot, v) => { if ((META_WORDS + slot + 1) * 4 <= looksB.size) device.queue.writeBuffer(looksB, (META_WORDS + slot) * 4, Uint32Array.of(v)); };
  // the whole table again, when families were numbered since the atlas was laid out (the tables before it kept)
  function setTable(table) {
    if (looksB.size < (META_WORDS + table.length) * 4) {
      looksB.destroy();
      looksB = B((META_WORDS + Math.ceil(table.length * 1.25)) * 4, STOR, "looks");
      device.queue.writeBuffer(looksB, 0, metaCPU);
    }
    device.queue.writeBuffer(looksB, META_WORDS * 4, table);
  }
  const entriesPut = (at, words) => { if (at + words.length / 8 <= entriesCap) device.queue.writeBuffer(entriesB, at * 32, words); };
  const rowsPut = (at, words) => device.queue.writeBuffer(rowsB, at * 4, words);
  const setTrails = (bytes) => upload(trailT, bytes, TN, TN, 1);
  const setTrailRect = (x, y, w, h, bytes) => device.queue.writeTexture({ texture: trailT, origin: [x, y] }, bytes, { bytesPerRow: w }, [w, h, 1]);
  const setIce = (bytes) => upload(iceT, bytes, pal.TILES, pal.TILES, 1);

  // ---------- a frame ----------
  // timestamps: the GPU's own time for a frame, read back a few frames late
  // each pass's start and end, by the pass's name: tw(name) gives a pass its timestamp writes
  const QN = 64, qs = timing ? device.createQuerySet({ type: "timestamp", count: QN }) : null;
  const qBuf = timing ? B(QN * 8, GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC, "q") : null, qRead = timing ? [0, 1, 2].map(() => ({ b: B(QN * 8, GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST, "qr"), busy: false })) : [];
  let qNames = [];
  const tw = (name) => { if (!qs || qNames.length * 2 >= QN) return {}; const i = qNames.length * 2; qNames.push(name); return { timestampWrites: { querySet: qs, beginningOfPassWriteIndex: i, endOfPassWriteIndex: i + 1 } }; };
  // picks asked for: { v, x, y, resolve } read from the G-buffer after the frame's world pass
  const picks = [];
  const pickRead = [0, 1, 2, 3].map(() => ({ b: B(256, GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST, "pick"), busy: false }));
  // how many sprites, points and shadow rows view 0 drew, read back a frame or two late
  const countRead = [0, 1, 2].map(() => ({ b: B(64, GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST, "counts"), busy: false }));
  let inFlight = 0;

  // f: worker.js's frame: { views: [{ U (VU fields), alpha, present: { dx, dy, sc, nn, nearest }, live, liveRows, prims, fires, xray }], lut, out, sea, cast, exag, ahead (frontAsk) }
  // The tile map and its vertices share one buffer sized for MAX_TILES: a view whose grid is past it (a mountain in the window widened it to a million tiles at the page's own opening place) wrote the tiles over the
  // vertices and the picture came out differently at every load. Such a view is cut down round its middle to what the buffer holds, never past it.
  function fitTiles(v) {
    const U = v.U;
    stats.tilesMax = Math.max(stats.tilesMax ?? 0, U.ni * U.nj);
    if (U.ni * U.nj <= MAX_TILES && (U.ni + 1) * (U.nj + 1) <= MAX_TILES + 4096) return v;
    const k = Math.sqrt((MAX_TILES * 0.97) / (U.ni * U.nj)), ni = Math.max(3, Math.floor(U.ni * k)), nj = Math.max(3, Math.floor(U.nj * k));
    stats.tilesCut = (stats.tilesCut ?? 0) + 1;
    return { ...v, blk: null, U: { ...U, ni, nj, nbi: Math.ceil(ni / 16), i0: U.i0 + ((U.ni - ni) >> 1), j0: U.j0 + ((U.nj - nj) >> 1) } };
  }
  function frame(f) {
    const views = f.views.map(fitTiles);
    if (views.length) ensure(Math.max(...views.map((v) => v.U.aw)), Math.max(...views.map((v) => v.U.ah)));
    if (f.lut) device.queue.writeBuffer(tablesB, LUT0 * 4, f.lut);
    const enc = device.createCommandEncoder();
    qNames = [];
    frameNo++;
    fold(enc, f.exag);
    traceSun(enc, f.cast);
    // a front list's slice only in a frame no far list's build steps in, so a frame pays for one or the other
    const farBusy = farFrame(enc);
    frontAsk(views, f.ahead);
    if (!farBusy) { const after = frontFrame(enc); if (after) pendingPickReads.push(after); }
    const slots = fadePlan(views);
    // the cells of a kept view are held too, so two fading levels drawn in turn don't evict each other's cells
    cacheFrame(enc, views);
    views.forEach((v, k) => { if (slots[k].draw) drawView(enc, v, k, f.id, slots[k].slot); });
    // the page checks: a kept view drawn again into the third art buffer, both read back to compare (fadeCheck)
    const kept = slots.findIndex((o) => !o.draw);
    if (fadeWant.length && kept >= 0) fadeReads(enc, views[kept], kept, f.id, slots[kept].slot);
    // present every view onto the canvas, over what f.under draws first (the planet, its own pass) or the sea
    const out = context.getCurrentTexture();
    f.under?.(enc, out.createView());
    const pass = enc.beginRenderPass({ colorAttachments: [{ view: out.createView(), loadOp: f.under ? "load" : "clear", storeOp: "store", clearValue: { r: f.seaRGB[0], g: f.seaRGB[1], b: f.seaRGB[2], a: 1 } }], ...tw("present") });
    pass.setPipeline(S.present.p);
    views.forEach((v, k) => {
      const p = v.present, s = slots[k], t = cap.tags[s.slot];
      // an art buffer drawn for an earlier camera at the same level and bearing lies at its own absolute origin
      const dx = p.dx + (t.gx0 - v.U.gx0) * p.sc, dy = p.dy + (t.gy0 - v.U.gy0) * p.sc;
      device.queue.writeBuffer(presentU[k], 0, PU.pack({ dx, dy, sc: p.sc, nn: p.nn, alpha: v.alpha, aw: t.aw, ah: t.ah, nearest: p.nearest, sr: f.seaRGB[0], sg: f.seaRGB[1], sb: f.seaRGB[2] }));
      pass.setBindGroup(0, group(S.present, k, { art: vw(cap.art[s.slot]) }));
      pass.draw(3);
    });
    pass.end();
    // the picks asked for, from view 0's G-buffer as it was before the second view reused it: copied in drawView
    let qr = null;
    const names = qNames, nq = names.length * 2;
    if (qs && nq) { qr = qRead.find((r) => !r.busy); if (qr) { enc.resolveQuerySet(qs, 0, nq, qBuf, 0); enc.copyBufferToBuffer(qBuf, 0, qr.b, 0, nq * 8); } }
    device.queue.submit([enc.finish()]);
    for (const b of cacheRetired.splice(0)) b.destroy();
    for (const b of frontRetired.splice(0)) b.destroy();
    inFlight++;
    device.queue.onSubmittedWorkDone().then(() => { inFlight--; });
    idleAfter = !farBusy && !frontJob && !frontWant.length && !sunJob && !cacheLeft && exagFolded === f.exag && (!f.cast || !!sunShown);
    if (qr) {
      qr.busy = true;
      qr.b.mapAsync(GPUMapMode.READ).then(() => {
        const t = new BigUint64Array(qr.b.getMappedRange(), 0, nq), parts = {};
        // On Metal a pass's pair can run backwards or for hours, and one such pair made a frame's span read 34 ms for
        // passes that took 8. A pair that reads so (not backwards, under a second) is left out of the span and the parts.
        let lo = null, hi = null;
        names.forEach((n, i) => {
          const a = t[2 * i], b = t[2 * i + 1];
          if (b < a || b - a > 1000000000n) return;
          if (lo === null || a < lo) lo = a;
          if (hi === null || b > hi) hi = b;
          parts[n] = +((parts[n] ?? 0) + Number(b - a) / 1e6).toFixed(3);
        });
        stats.gpuMs = lo === null ? 0 : Number(hi - lo) / 1e6; stats.passes = parts;
        qr.b.unmap(); qr.busy = false;
      }).catch(() => { qr.busy = false; });
    }
    for (const r of pendingPickReads.splice(0)) r();
  }
  const pendingPickReads = [], instWant = [], fadeWant = [], gbufWant = [];
  // an art buffer's absolute art px origin and size, and its texels read back into enc (rows of rp bytes); done(bytes)
  // once enc is submitted and the copy mapped
  function artRead(enc, slot) {
    const t = cap.tags[slot], rp = Math.ceil((t.aw * 4) / 256) * 256, b = B(rp * t.ah, GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST, "artRead");
    enc.copyTextureToBuffer({ texture: cap.art[slot] }, { buffer: b, bytesPerRow: rp }, [t.aw, t.ah, 1]);
    return { ...t, rp, read: () => b.mapAsync(GPUMapMode.READ).then(() => { const a = new Uint8Array(b.getMappedRange().slice(0)); b.destroy(); return a; }) };
  }
  // For the page checks: view k, presented from the art buffer in slot it was kept in, drawn again into the third, and
  // every pixel both hold compared: { pixels, differ, most } (most: the largest difference of a channel), a pixel
  // round each edge left out. The haze band is tied to the canvas, so it moves on the art as the view zooms; the new
  // drawing takes the band where the kept art has it, so what is compared is the art's own.
  function fadeReads(enc, v, k, frameId, slot) {
    const want = fadeWant.splice(0), t = cap.tags[slot];
    drawView(enc, { ...v, U: { ...v.U, htop: t.hazeTop - v.U.gy0, hreach: t.hreach } }, k, frameId, 2);
    const a = artRead(enc, slot), b = artRead(enc, 2);
    pendingPickReads.push(() => Promise.all([a.read(), b.read()]).then(([pa, pb]) => {
      let pixels = 0, differ = 0, most = 0;
      const box = [Infinity, Infinity, -Infinity, -Infinity];
      for (let y = Math.max(a.gy0, b.gy0) + 1; y < Math.min(a.gy0 + a.ah, b.gy0 + b.ah) - 1; y++)
        for (let x = Math.max(a.gx0, b.gx0) + 1; x < Math.min(a.gx0 + a.aw, b.gx0 + b.aw) - 1; x++) {
          const ia = (y - a.gy0) * a.rp + (x - a.gx0) * 4, ib = (y - b.gy0) * b.rp + (x - b.gx0) * 4;
          let d = 0;
          for (let c = 0; c < 3; c++) d = Math.max(d, Math.abs(pa[ia + c] - pb[ib + c]));
          pixels++;
          if (d) { differ++; most = Math.max(most, d); box[0] = Math.min(box[0], x); box[1] = Math.min(box[1], y); box[2] = Math.max(box[2], x); box[3] = Math.max(box[3], y); }
        }
      // box: the differing pixels' bounds in absolute art px, against the compared span's
      for (const r of want) r({ level: v.L, keptFrame: a.frame, frame: b.frame, moved: [b.gx0 - a.gx0, b.gy0 - a.gy0], pixels, differ, most, box: differ ? box : null, span: [Math.max(a.gx0, b.gx0), Math.max(a.gy0, b.gy0), Math.min(a.gx0 + a.aw, b.gx0 + b.aw), Math.min(a.gy0 + a.ah, b.gy0 + b.ah)] });
    }));
  }
  // A cross-fade's two levels are drawn one a frame, in turn, the one drawn longer ago first: the other is presented from
  // the art buffer it was last drawn into. Every level and whole or turning bearing lays its art px on one lattice (a
  // point's art px less the buffer's origin gx0, gy0 is the same for every camera), so that art placed at its own origin
  // shows each pixel where a new drawing would; it is used only when drawn at the same level and bearing and when it
  // still covers the canvas (live.js draws a fading level with a margin for it). A single view is always drawn, and every
  // view while fadeKeep is off (the page checks, which compare the two). Gives each view its art buffer (slot) and
  // whether it is drawn.
  let frameNo = 0, fadeKeep = true;
  function fadePlan(views) {
    const W = context.canvas.width, H = context.canvas.height, used = new Set();
    const keep = views.map((v) => {
      if (views.length < 2 || !fadeKeep) return -1;
      const p = v.present, U = v.U;
      return cap.tags.findIndex((t, i) => {
        if (i > 1 || !t || t.L !== v.L || t.beta !== v.beta) return false;
        // the canvas in absolute art px, a pixel round for the present's bilinear
        const x0 = U.gx0 + Math.floor(-p.dx / p.sc) - 1, x1 = U.gx0 + Math.ceil((W - p.dx) / p.sc) + 1, y0 = U.gy0 + Math.floor(-p.dy / p.sc) - 1, y1 = U.gy0 + Math.ceil((H - p.dy) / p.sc) + 1;
        return x0 >= t.gx0 && y0 >= t.gy0 && x1 <= t.gx0 + t.aw && y1 <= t.gy0 + t.ah;
      });
    });
    // both could be kept: the one drawn longer ago is drawn again; one: the other is drawn; none: both are
    let redraw = -1;
    if (views.length && keep.every((s) => s >= 0)) redraw = cap.tags[keep[0]].frame <= cap.tags[keep[1]].frame ? 0 : 1;
    const out = views.map((v, k) => ({ draw: keep[k] < 0 || k === redraw, slot: keep[k] }));
    for (const o of out) if (o.slot >= 0) used.add(o.slot);
    for (const o of out) if (o.slot < 0) { o.slot = [0, 1].find((s) => !used.has(s)); used.add(o.slot); }
    return out;
  }
  function drawView(enc, v, k, frameId, slot) {
    const U = v.U, nTiles = U.ni * U.nj, rect = cellRect(U), objCount = sources.length;
    // a far level walks its sources' far lists where they are built (v.L: the view's level, coarsest first)
    const farL = farUse && v.L < farN ? v.L : -1;
    device.queue.writeBuffer(viewU[k], 0, VU.pack({ ...U, ...rect, farL: Math.max(0, farL), maxinst: MAX_INST, maxrows: MAX_ROWS, gridN: GN, gridStep: pal.GRID_STEP, canN: canopy.n, canStep: canopy.step, can3: canopy.n3, ncol: NCOL, toneN: TONE_S.length, toneLo: TONE_S[0], toneHi: TONE_S[TONE_S.length - 1], wlo: Math.min(...WATER), whi: Math.max(...WATER) }));
    if (v.fires?.length) device.queue.writeBuffer(firesU[k], 0, v.fires);
    stats.tiles = nTiles;
    // 1. the tile map, 2. cull
    enc.copyBufferToBuffer(argsInit, 0, argsB, 0, 64);
    enc.copyBufferToBuffer(tcntInit, 0, tcntB, 0, 16);
    const blk = v.blk ?? fullBlocks(U), nBlk = Math.min(blk.length, BLK_MAX);
    device.queue.writeBuffer(blkB[k], 0, blk, 0, nBlk);
    enc.clearBuffer(mapB, FOFF_B, Math.min(BLK_MAX, U.nbi * Math.ceil(U.nj / 16)) * 4);
    stats.blocks = nBlk;
    let pass = enc.beginComputePass(tw("map"));
    pass.setBindGroup(1, groundGroup);
    pass.setPipeline(S.tiles.p); pass.setBindGroup(0, group(S.tiles, k)); pass.dispatchWorkgroups(nBlk);
    pass.setPipeline(S.verts.p); pass.setBindGroup(0, group(S.verts, k)); pass.dispatchWorkgroups(nBlk);
    pass.end();
    pass = enc.beginComputePass(tw("tcull"));
    pass.setPipeline(S.tcull.p); pass.setBindGroup(0, group(S.tcull, k)); pass.dispatchWorkgroups(nBlk);
    pass.end();
    if (objCount) {
      // an indexed source's rows of cells under the view, each row's run split among enough workgroups to keep the GPU busy
      const rows = rect.cy1 - rect.cy0 + 1, perRow = Math.min(64, Math.max(1, Math.ceil(2048 / rows)));
      // a source that stands in the window's frame by its origin (s.oc, in cells) is walked over its own part of the rectangle only
      const part = (s) => {
        if (!s.oc) return { cols: rect.cx1 - rect.cx0 + 1, rows };
        const c0 = Math.max(rect.cx0, s.oc[0]), c1 = Math.min(rect.cx1, s.oc[0] + s.spec.n - 1), r0 = Math.max(rect.cy0, s.oc[1]), r1 = Math.min(rect.cy1, s.oc[1] + s.spec.n - 1);
        return { cols: Math.max(0, c1 - c0 + 1), rows: Math.max(0, r1 - r0 + 1) };
      };
      pass = enc.beginComputePass(tw("cull"));
      pass.setBindGroup(1, groundGroup);
      for (const s of sources) {
        // a source of members drawn under a pixel at this level (its biggest, spec.most metres) is not walked
        const most = s.spec.most;
        if (skipped.has(s.name) || skipped.has("*")) continue;
        const pt = part(s);
        if (!pt.cols || !pt.rows) continue;
        if (most !== undefined && (most < 1 ? most ** 0.55 : most) * Math.max(U.pv, U.pw) < 1) continue;
        const over = { ...s.over, ...s.dyn?.(), ...(s.fill ? cacheBinds(s) : {}) };
        const f = farL >= 0 && s.far && farState.get(s.name);
        if (f && f.front >= 0 && f.body === s.body) {
          // a far level at a whole bearing walks its front list where one is built; a list with nothing in it is not
          // walked (a workgroup a cell of the island costs some 0.6 ms at the island levels even when every cell's run
          // is empty, measured on AMD RDNA-1 2026-10-17)
          const fr = frontOf(s, f, v.L, v.beta);
          if ((fr ? fr.n : f.n[f.front]) === 0) continue;
          const lists = fr ? { flist: { buffer: fr.list }, fidx: { buffer: fr.idx } } : { flist: { buffer: f.list[f.front] }, fidx: { buffer: f.idx[f.front] } };
          pass.setPipeline(s.far.cull.p); pass.setBindGroup(0, group(s.far.cull, k, { ...over, ...lists }));
          pass.dispatchWorkgroups(pt.cols, pt.rows);
          continue;
        }
        pass.setPipeline(s.cull.p); pass.setBindGroup(0, group(s.cull, k, over));
        if (s.spec.members === "cells") pass.dispatchWorkgroups(rect.cx1 - rect.cx0 + 1, rows);
        else if (s.spec.members === "bins" || s.spec.indexed) pass.dispatchWorkgroups(perRow, pt.rows);
        else pass.dispatchWorkgroups(...spread(s.spec.cap));
      }
      pass.setPipeline(S.clampArgs.p); pass.setBindGroup(0, group(S.clampArgs, k)); pass.dispatchWorkgroups(1);
      pass.end();
    }
    // 3. the world
    const nLive = v.live ? v.live.byteLength / 32 : 0;
    if (nLive) device.queue.writeBuffer(liveB[k], 0, v.live);
    let rp = enc.beginRenderPass({
      colorAttachments: [
        { view: vw(cap.gK), loadOp: "clear", storeOp: "store", clearValue: { r: 0xffffffff, g: 0, b: 0, a: 0 } },
        { view: vw(cap.gW), loadOp: "clear", storeOp: "store", clearValue: { r: 0, g: 0, b: 0, a: 0 } },
      ],
      depthStencilAttachment: { view: vw(cap.depth), depthLoadOp: "clear", depthStoreOp: "store", depthClearValue: 1 },
      ...tw("world"),
    });
    rp.setViewport(0, 0, U.aw, U.ah, 0, 1);
    rp.setPipeline(S.terrain.p); rp.setBindGroup(0, group(S.terrain, k)); rp.setBindGroup(1, groundGroup);
    rp.drawIndirect(tcntB, 0);
    if (objCount) {
      rp.setPipeline(S.sprites.p); rp.setBindGroup(0, group(S.sprites, k)); rp.drawIndirect(argsB, 0);
    }
    if (nLive) { rp.setPipeline(S.live.p); rp.setBindGroup(0, group(S.live, k)); rp.draw(6, nLive); }
    rp.end();
    // the one-pixel specks, splatted after the world: the nearest of each pixel's specks in front of what is drawn there
    if (objCount) {
      enc.clearBuffer(cap.keys, 0, Math.ceil((U.aw * U.ah * 4) / 4) * 4);
      pass = enc.beginComputePass(tw("specks"));
      pass.setPipeline(S.splatA.p); pass.setBindGroup(0, group(S.splatA, k)); pass.dispatchWorkgroupsIndirect(argsB, 48);
      pass.setPipeline(S.splatB.p); pass.setBindGroup(0, group(S.splatB, k)); pass.dispatchWorkgroupsIndirect(argsB, 48);
      pass.end();
    }
    // 4. the sun's mask, on the ground the world pass left uncovered (maskZ)
    const nLiveRows = v.liveRows ? v.liveRows.length / 4 : 0;
    if (nLiveRows) device.queue.writeBuffer(liveRowsB[k], 0, Int32Array.from(v.liveRows));
    rp = enc.beginRenderPass({
      colorAttachments: [{ view: vw(cap.mask), loadOp: "clear", storeOp: "store", clearValue: { r: 0, g: 0, b: 0, a: 0 } }],
      depthStencilAttachment: { view: vw(cap.maskZ), depthLoadOp: "clear", depthStoreOp: "discard", depthClearValue: 1 },
      ...tw("mask"),
    });
    rp.setViewport(0, 0, U.aw, U.ah, 0, 1);
    if (U.casting && (objCount || nLiveRows)) {
      rp.setPipeline(S.maskZ.p); rp.setBindGroup(0, group(S.maskZ, k)); rp.draw(3);
      if (objCount) { rp.setPipeline(S.mask.p); rp.setBindGroup(0, group(S.mask, k)); rp.drawIndirect(argsB, 16); }
      if (nLiveRows) { rp.setPipeline(S.maskLive.p); rp.setBindGroup(0, group(S.maskLive, k)); rp.draw(4, nLiveRows); }
    }
    rp.end();
    if (k === 0) {
      const cr = countRead.find((q) => !q.busy);
      if (cr) {
        cr.busy = true;
        enc.copyBufferToBuffer(argsB, 0, cr.b, 0, 48);
        enc.copyBufferToBuffer(tcntB, 0, cr.b, 48, 16);
        pendingPickReads.push(() => cr.b.mapAsync(GPUMapMode.READ).then(() => { const a = new Uint32Array(cr.b.getMappedRange().slice(0)); cr.b.unmap(); cr.busy = false; stats.counts = { sprites: a[1], rows: a[5], points: a[9], tiles: nTiles, tilesDrawn: a[12] / 18 }; }).catch(() => { cr.busy = false; }));
      }
    }
    // the instances asked for (checks: scripts/play/objects.ts), as view 0 drew them: sprites, then specks
    if (k === 0 && instWant.length) {
      const want = instWant.splice(0), n = 1 << 16, rb = B(48 + n * 64, GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST, "instRead");
      enc.copyBufferToBuffer(argsB, 0, rb, 0, 48);
      enc.copyBufferToBuffer(instB, 0, rb, 48, n * 32);
      enc.copyBufferToBuffer(instB, MAX_INST * 32, rb, 48 + n * 32, n * 32);
      pendingPickReads.push(() => rb.mapAsync(GPUMapMode.READ).then(() => {
        const all = rb.getMappedRange(), a = new Uint32Array(all, 0, 12), out = { sprites: [], points: [], counts: [a[1], a[9]] };
        const read = (list, off, count) => {
          const U = new Uint32Array(all, off, Math.min(count, n) * 8), I = new Int32Array(all, off, U.length), F = new Float32Array(all, off, U.length);
          for (let i = 0; i < U.length; i += 8) list.push({ sp: U[i], x: I[i + 1], y: I[i + 2], pick: U[i + 5], wx: F[i + 6], wz: F[i + 7] });
        };
        read(out.sprites, 48, a[1]); read(out.points, 48 + n * 32, a[9]);
        rb.unmap(); rb.destroy();
        for (const r of want) r(out);
      }));
    }
    // what view 0's G-buffer holds, asked for by the page checks: each pixel's kind, colour and flags, and its pick
    if (k === 0 && gbufWant.length) {
      const want = gbufWant.splice(0), rp = Math.ceil((U.aw * 8) / 256) * 256, rb = B(rp * U.ah, GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST, "gRead");
      enc.copyTextureToBuffer({ texture: cap.gK }, { buffer: rb, bytesPerRow: rp }, [U.aw, U.ah, 1]);
      pendingPickReads.push(() => rb.mapAsync(GPUMapMode.READ).then(() => {
        const a = new Uint32Array(rb.getMappedRange()), out = new Uint32Array(U.aw * U.ah * 2);
        for (let y = 0; y < U.ah; y++) out.set(a.subarray((y * rp) / 4, (y * rp) / 4 + U.aw * 2), y * U.aw * 2);
        rb.unmap(); rb.destroy();
        for (const r of want) r({ w: U.aw, h: U.ah, gx0: U.gx0, gy0: U.gy0, level: v.L, k: out });
      }));
    }
    // the picks asked for, read from view 0's G-buffer
    if (k === 0) for (const pk of picks.splice(0)) {
      const r = pickRead.find((q) => !q.busy);
      if (!r || pk.x < 0 || pk.y < 0 || pk.x >= U.aw || pk.y >= U.ah) { pk.resolve(null); continue; }
      r.busy = true;
      enc.copyTextureToBuffer({ texture: cap.gK, origin: [pk.x, pk.y] }, { buffer: r.b, bytesPerRow: 256 }, [1, 1, 1]);
      pendingPickReads.push(() => r.b.mapAsync(GPUMapMode.READ).then(() => { const a = new Uint32Array(r.b.getMappedRange().slice(0, 8)); r.b.unmap(); r.busy = false; pk.resolve(a[0] === 0xffffffff ? { kind: -1, pick: 0, frame: frameId } : { kind: a[0] & 3, pick: a[1], frame: frameId }); }).catch(() => { r.busy = false; pk.resolve(null); }));
    }
    // 5. overlays and the x-ray
    const nPrims = v.prims ? v.prims.length / 8 : 0;
    if (nPrims) device.queue.writeBuffer(primsB[k], 0, v.prims);
    rp = enc.beginRenderPass({ colorAttachments: [{ view: vw(cap.over), loadOp: "clear", storeOp: "store", clearValue: { r: 255, g: 0, b: 0, a: 0 } }], ...tw("over") });
    rp.setViewport(0, 0, U.aw, U.ah, 0, 1);
    if (nPrims) { rp.setPipeline(S.over.p); rp.setBindGroup(0, group(S.over, k)); rp.setBindGroup(1, groundGroup); rp.draw(6, nPrims); }
    rp.end();
    rp = enc.beginRenderPass({ colorAttachments: [{ view: vw(cap.xray), loadOp: "clear", storeOp: "store", clearValue: { r: 0, g: 0, b: 0, a: 0 } }] });
    rp.setViewport(0, 0, U.aw, U.ah, 0, 1);
    if (v.xray && nLive) { rp.setPipeline(S.xray.p); rp.setBindGroup(0, group(S.xray, k)); for (const i of v.xray) rp.draw(6, 1, 0, i); }
    rp.end();
    // 6. shade into the view's art buffer
    rp = enc.beginRenderPass({ colorAttachments: [{ view: vw(cap.art[slot]), loadOp: "clear", storeOp: "store", clearValue: { r: 0, g: 0, b: 0, a: 1 } }], ...tw("shade") });
    rp.setViewport(0, 0, U.aw, U.ah, 0, 1);
    rp.setPipeline(S.shade.p); rp.setBindGroup(0, group(S.shade, k)); rp.setBindGroup(1, groundGroup);
    rp.draw(3);
    rp.end();
    cap.tags[slot] = { L: v.L, beta: v.beta, gx0: U.gx0, gy0: U.gy0, aw: U.aw, ah: U.ah, frame: frameNo, hazeTop: U.gy0 + U.htop, hreach: U.hreach };
  }
  await Promise.all(Object.values(S).map((o) => o.ready));
  const api = {
    errors, stats, frame, setSources, warmSpec, setGround, setGroundPages, setGroundPagesOn, setWrap, debugRoll, setMeta, survey, buildCanopy, farBuild, setAtlas, setTable, atlasPut, entriesPut, rowsPut, tablePut, setTrails, setTrailRect, setIce,
    get busy() { return inFlight; },
    // whether drawing the last frame's inputs again would draw the same picture: nothing the renderer builds or traces is half done, nothing asked of it (a pick, a check) waits for a frame, and nothing was
    // changed in it since (rev, which the caller compares with the one it saw at that frame)
    get rev() { return rev; },
    get settled() { return idleAfter && !picks.length && !instWant.length && !fadeWant.length && !gbufWant.length && !pendingPickReads.length && !cacheRetired.length && !frontRetired.length; },
    setFarUse: (on) => { farUse = on; },
    setFadeKeep: (on) => { fadeKeep = on; },
    // the ground's pages as the planet pass reads them (slice H): the textures and the table, on only while the page table is what the painter reads. table: [on, entry 0 to 15], entries as the painter's page table (a slot, or -(2 + n) for a page not resident)
    pageGround: () => ({ on: pgOnNow && !!PT, fine: PT?.fine ?? null, grid: PT?.grid ?? null, river: PT?.river ?? null, table: pageNow, block: blockNow }),
    setBlockPages, copyPages,
    // the light's rasters the planet pass reads over the window (wgsl/globe.js lightFine): the sun's map (the front one), the trees' cover near and wide, and their grids' sizes
    streamGround: () => ({ streams: groundBuffers[8], streamBins: groundBuffers[9], quick: winQuick }),
    lightGround: () => ({ sun: sunMaps[sunFront], can0: canopy.t0, can3: canopy.t3, gridN: GN, gridStep: pal.GRID_STEP, canN: canopy.n, canStep: canopy.step, can3N: canopy.n3, half: SIZE / 2 }),
    setFrontUse: (on) => { frontUse = on; },
    setFrontViews, frontsReady,
    // sources the cull leaves out, by name (the page checks, to time each source's share)
    setSkipped: (names) => { skipped = new Set(names); },
    // what view 0 shows at art px (x, y) in the next frame: { kind, pick } (kind -1: nothing), or null
    pick: (x, y) => new Promise((resolve) => picks.push({ x, y, resolve })),
    // every object instance view 0 draws in the next frame: { sprites, points: [{ sp, x, y, pick, wx, wz }] }
    instances: () => new Promise((resolve) => instWant.push(resolve)),
    // view 0's G-buffer as the next frame draws it: { w, h, gx0, gy0, level, k (two words a pixel) }
    gbuffer: () => new Promise((resolve) => gbufWant.push(resolve)),
    // the next cross-fade frame that presents a kept view, that view drawn again and compared (fadeReads)
    fadeCheck: () => new Promise((resolve) => fadeWant.push(resolve)),
  };
  // what the page changes between frames: any of these makes the next frame differ
  for (const k of ["setSources", "setGround", "setGroundPages", "setGroundPagesOn", "setWrap", "debugRoll", "setMeta", "survey", "buildCanopy", "farBuild", "setAtlas", "setTable", "atlasPut", "entriesPut", "rowsPut", "tablePut", "setTrails", "setTrailRect", "setIce", "setBlockPages", "copyPages", "setFarUse", "setFadeKeep", "setFrontUse", "setFrontViews", "setSkipped"]) {
    const fn = api[k];
    api[k] = (...a) => { rev++; return fn(...a); };
  }
  return api;
}
