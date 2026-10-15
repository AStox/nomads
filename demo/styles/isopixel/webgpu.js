// The isopixel renderer on WebGPU, run inside the render worker (worker.js) on an OffscreenCanvas. Nothing is baked on
// the CPU: every frame the GPU lays out the ground of the level and bearing shown, paints it pixel by pixel from the
// world's fields (ground.wgsl.js), stands every object of the sim on it as a sprite from one atlas, casts the sun and
// the moon, lights it all for the hour and scales it to the canvas. A zoom, a pan or a turn is only another frame.
//
// A frame, per view (one, or two cross-fading levels):
//   1. tiles: a compute pass lays out the level's tile map under the view, as main.js buildMap laid out the live levels:
//      each tile's water and every vertex's level, so the ground keeps z = 1.5H(u + v) + lev lp;
//   2. cull: a compute pass walks every object, keeps those drawn at a pixel or more where they can reach into the view,
//      stands each on the tile map's ground, picks its sprite from the atlas table and lists it for an indirect draw,
//      with its shadow-casting rows;
//   3. world: the ground's triangles and banks, the objects' sprites and the page's live sprites go into a G-buffer of
//      what each pixel shows (ground to paint at a world point, or a sprite's colour and its anchor), depth tested;
//   4. mask: every shadow-casting row's swept round laid along the sun, as px.js shadowRows lists them;
//   5. overlays (smoke, labels, icons, paths, pins) in palette indices, and the people seen through the leaves;
//   6. shade: each pixel's ground painted (paintGround), lit by the sun map, its slope, the sprites' shadows and the
//      ambient occlusion, its fire light and haze added, and taken through the sky's light table;
// then every view onto the canvas at the exact zoom (present). Between two bearings the tile map of the nearer one is
// drawn turned to the bearing shown, so the island turns as a solid thing with its sprites upright.

import { GROUND_BINDINGS, groundWGSL } from "./ground.wgsl.js";

// steps of the key light in the light table, each at the fire's four levels, the palette as drawn in a last row
export const LEVELS = 16;
const ROWS = LEVELS * 4 + 1;
// the sprite table's sizes per family, and the atlas's layer side
export const NS = 320, ATLAS = 4096;
// the sun map is traced again once the sun has moved this far (radians), over SUN_STRIPES frames
const SUN_MOVE = 0.004, SUN_STRIPES = 6;
// how far from each cell of the island's heights the ground's folds are looked over for the sky they hide (meters)
const TER_REACH = 450;
// the most objects one view draws, their shadow rows, and tiles under a view
const MAX_INST = 1 << 21, MAX_ROWS = 1 << 22, MAX_TILES = 1 << 19;
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
  ["i0", "i"], ["j0", "i"], ["ni", "u"], ["nj", "u"],
  // the level
  ["H", "f"], ["hb", "f"], ["lp", "f"], ["tileM", "f"], ["levelM", "f"], ["k", "f"], ["pv", "f"], ["pw", "f"], ["shrunk", "u"], ["bias", "f"], ["peak", "f"], ["mapN", "i"],
  ["zinv", "f"], ["frame", "u"], ["season", "u"], ["gflags", "u"],
  // objects: how many, the most instances and rows, whether anything casts and a row's shadow step per px of height
  ["nobj", "u"], ["maxinst", "u"], ["maxrows", "u"], ["casting", "u"], ["sunx", "f"], ["suny", "f"],
  // the light (live.js skyFor)
  ["lx", "f"], ["ly", "f"], ["lz", "f"], ["ar", "f"], ["ag", "f"], ["ab", "f"], ["kr", "f"], ["kg", "f"], ["kb", "f"],
  ["sunK", "f"], ["flat", "f"], ["relief", "f"], ["spr", "f"], ["toneK", "f"], ["toneLo", "f"], ["toneHi", "f"], ["toneN", "u"],
  ["aoK", "f"], ["aoTer", "f"], ["aoCan", "f"], ["aoTree", "f"], ["aoTop", "f"], ["aoSelf", "f"], ["aoKey", "f"], ["aoDbg", "f"],
  ["gridN", "u"], ["gridStep", "f"], ["canN", "u"], ["canStep", "f"], ["can3", "u"], ["half", "f"],
  ["hmost", "f"], ["htop", "f"], ["hreach", "f"], ["sea", "u"], ["wlo", "u"], ["whi", "u"], ["nfires", "u"], ["night", "f"], ["ncol", "u"],
]);
const TU = struct("Tr", [["n", "u"], ["step", "f"], ["exag", "f"], ["tan", "f"], ["dx", "f"], ["dz", "f"], ["row0", "u"], ["reach", "f"]]);
const PU = struct("Pr", [["dx", "f"], ["dy", "f"], ["sc", "f"], ["nn", "f"], ["alpha", "f"], ["aw", "u"], ["ah", "u"], ["nearest", "u"], ["sr", "f"], ["sg", "f"], ["sb", "f"]]);

// Every resource a pass may bind in group 0: its binding, kind and type. A pass names the ones it uses (":w" for
// read-write storage); its declarations and its layout are made from the same list.
const RES = {
  V: [0, "uniform", "U"],
  tiles: [1, "storage", "array<vec2f>"],
  verts: [2, "storage", "array<f32>"],
  objs: [3, "storage", "array<vec4u>"],
  table: [4, "storage", "array<u32>"],
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
  ids: [24, "storage", "array<u32>"],
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
// A tile's water (main.js buildMap on a live level): over 0.45 of five points under standing water, or over 0.1 and
// below sea level, is water at the surface of the nearest water cell, a lake above half a meter, else the sea.
const TILES_WGSL = `
@compute @workgroup_size(64)
fn tilesMain(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= V.ni * V.nj) { return; }
  let u = f32(V.i0 + i32(id.x % V.ni));
  let v = f32(V.j0 + i32(id.x / V.ni));
  let offs = array<vec2f, 5>(vec2f(0.5, 0.5), vec2f(0.22, 0.5), vec2f(0.78, 0.5), vec2f(0.5, 0.22), vec2f(0.5, 0.78));
  var wet = 0.0;
  for (var k = 0; k < 5; k++) { let p = gridW(u + offs[k].x, v + offs[k].y); wet += waterAt(p.x, p.y); }
  wet /= 5.0;
  let c = gridW(u + 0.5, v + 0.5);
  let hh = heightAt(c.x, c.y);
  var out = vec2f(0.0, 0.0);
  if (wet > 0.45 || (wet > 0.1 && hh < -0.5)) { let s = surfAt(c.x, c.y); out = vec2f(select(1.0, 2.0, s > 0.5), s / V.levelM); }
  tiles[id.x] = out;
}`;
// A vertex's level: the ground's height, or where it touches standing water the highest water's level, never below
// the sea.
const VERTS_WGSL = `
@compute @workgroup_size(64)
fn vertsMain(@builtin(global_invocation_id) id: vec3u) {
  let vi = V.ni + 1u;
  if (id.x >= vi * (V.nj + 1u)) { return; }
  let i = i32(id.x % vi);
  let j = i32(id.x / vi);
  let p = gridW(f32(V.i0 + i), f32(V.j0 + j));
  var lev = heightAt(p.x, p.y) / V.levelM;
  var wetv = false;
  var fl = 0.0;
  for (var b = j - 1; b <= j; b++) {
    for (var a = i - 1; a <= i; a++) {
      if (a < 0 || b < 0 || a >= i32(V.ni) || b >= i32(V.nj)) { continue; }
      let t = tiles[u32(b) * V.ni + u32(a)];
      if (t.x > 0.5) { fl = select(t.y, max(fl, t.y), wetv); wetv = true; }
    }
  }
  if (wetv) { lev = fl; }
  verts[id.x] = max(0.0, lev);
}`;
// The tile map read back: a tile's corners (top, right, bottom, left as main.js), its diagonal and its water.
const MAP_READ = `
struct T4 { c: vec4f, diag: u32, kind: u32 }
fn tileAt(ti: i32, tj: i32) -> T4 {
  var o: T4;
  let t = tiles[u32(tj) * V.ni + u32(ti)];
  let vi = V.ni + 1u;
  let k = u32(tj) * vi + u32(ti);
  o.kind = u32(t.x + 0.5);
  if (o.kind > 0u) { o.c = vec4f(t.y); } else { o.c = vec4f(verts[k], verts[k + 1u], verts[k + vi + 1u], verts[k + vi]); }
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
  let t = vid / 18u;
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

// ---------- 2. cull ----------
// An object: its tile position, its shown size (meters of height, or a tussock's width), and meta: its sprite family
// (bits 0..19), grass (20, sized by width), a tree (21: its shrunk family next, its shadow from 8 px), flat (22, no
// shadow), mirrored (23) and there (24). Drawn at a pixel or more and able to reach into the view, it stands on the
// tile map's ground and takes its sprite at its size, as main.js collectLive drew it; should float rounding ask for a
// size never made, the nearest one made.
const CULL_WGSL = (TILE_M, ORIGIN) => `
@compute @workgroup_size(256)
fn cullMain(@builtin(global_invocation_id) gid: vec3u, @builtin(num_workgroups) nw: vec3u) {
  let k = gid.x + gid.y * nw.x * 256u;
  if (k >= V.nobj) { return; }
  let o = objs[k];
  let mt = o.w;
  if ((mt & (1u << 24u)) == 0u) { return; }
  let grass = (mt & (1u << 20u)) != 0u;
  let tree = (mt & (1u << 21u)) != 0u;
  let hpx = bitcast<f32>(o.z) * select(V.pv, V.pw, grass);
  if (hpx < 1.0) { return; }
  let x = bitcast<f32>(o.x) * ${TILE_M} + (${ORIGIN});
  let z = bitcast<f32>(o.y) * ${TILE_M} + (${ORIGIN});
  let d = rel(x, z);
  // within reach whatever the ground's height: as tall and as wide as it is drawn, and its shadow
  let reach = hpx * 2.0 + 8.0 + select(0.0, hpx * 4.0, V.casting != 0u);
  let sx = (d.x - d.y) * V.H + V.offx;
  let base = (d.x + d.y) * V.hb + V.offy;
  if (sx < -reach || sx > f32(V.aw) + reach || base + V.levc * V.lp < -reach || base - (V.peak - V.levc) * V.lp > f32(V.ah) + reach) { return; }
  let g = gridUV(x, z);
  let lev = groundLev(g.x, g.y);
  if (lev < -1e8) { return; }
  let s = screen(d, lev);
  let ax = rnd(s.x);
  let ay = rnd(s.y);
  if (ax < -reach || ay < -reach || ax > f32(V.aw) + reach || ay - hpx * 2.0 > f32(V.ah) + reach) { return; }
  var fam = mt & 0xFFFFFu;
  if (tree && V.shrunk != 0u) { fam += 1u; }
  var si = 0u;
  if (tree) { si = u32(max(1.0, rnd(hpx))); } else if (hpx < 8.0) { si = u32(rnd(hpx * 2.0)); } else { si = 8u + u32(rnd(hpx)); }
  si = min(si, ${NS - 1}u);
  var sp = table[fam * ${NS}u + si];
  for (var dd = 1u; sp == 0u && dd < 24u; dd++) {
    if (si >= dd) { sp = table[fam * ${NS}u + si - dd]; }
    if (sp == 0u && si + dd < ${NS}u) { sp = table[fam * ${NS}u + si + dd]; }
  }
  if (sp == 0u || sp == 0xFFFFFFFFu) { return; }
  let e0 = entries[(sp - 1u) * 2u];
  let foot = f32(i32((e0.w >> 8u) & 255u) - 128);
  var it: Inst;
  it.sp = sp - 1u; it.x = i32(ax); it.y = i32(ay + foot); it.z = s.z + V.bias; it.flags = 1u | (((mt >> 23u) & 1u) << 4u); it.pick = ids[k]; it.wx = x; it.wz = z;
  // a speck of one pixel, as far levels draw most trees, is one point, not a quad
  if (e0.y == 0x10001u) {
    let ps = atomicAdd(&args.pic, 1u);
    if (ps < V.maxinst) { pts[ps] = it; }
    return;
  }
  let slot = atomicAdd(&args.ic, 1u);
  if (slot >= V.maxinst) { return; }
  inst[slot] = it;
  let casts = (mt & (1u << 22u)) == 0u && hpx >= select(3.0, 8.0, tree);
  if (V.casting == 0u || !casts) { return; }
  let e1 = entries[(sp - 1u) * 2u + 1u];
  if (e1.y == 0u) { return; }
  let r0 = atomicAdd(&args.ric, e1.y);
  for (var r = 0u; r < e1.y; r++) { if (r0 + r < V.maxrows) { rowInst[r0 + r] = vec2u(slot, e1.x + r); } }
}
@compute @workgroup_size(1)
fn clampMain() {
  atomicStore(&args.ic, min(atomicLoad(&args.ic), V.maxinst));
  atomicStore(&args.ric, min(atomicLoad(&args.ric), V.maxrows));
  atomicStore(&args.pic, min(atomicLoad(&args.pic), V.maxinst));
  args.dx = (atomicLoad(&args.pic) + 63u) / 64u;
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
// row's width and k, as px.js shadowRows lists them.
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
  let p = mix(lo, hi, vec2f(QX[vid], QY[vid]));
  o.pos = vec4f(p.x / f32(V.aw) * 2.0 - 1.0, 1.0 - p.y / f32(V.ah) * 2.0, 0.0, 1.0);
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
  let a = textureLoad(gGrid, i, layer, 0).r;
  let b = textureLoad(gGrid, vec2i(i1.x, i.y), layer, 0).r;
  let c = textureLoad(gGrid, vec2i(i.x, i1.y), layer, 0).r;
  let d = textureLoad(gGrid, i1, layer, 0).r;
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
  if (emits) { row = EMISSIVE; }
  else if (empty) {
    // the open sea at sea level under the pixel, lit as the bake's deep sea was
    let a = (f32(q.x) + 0.5 - V.offx) / V.H;
    let b = (f32(q.y) + 0.5 - V.offy - V.levc * V.lp) / V.hb;
    let du = (a + b) * 0.5;
    let dv = (b - a) * 0.5;
    let wp = vec2f(V.cx, V.cz) + (du * vec2f(V.eux, V.euy) + dv * vec2f(V.evx, V.evy)) * V.tileM;
    let L = lightAt(q, 0u, false, c, wp, 0.0);
    row = L.row * 4u + fire;
  }
  else { let L = lightAt(q, kind, stand, c, w.xy, w.z); row = L.row * 4u + fire; ao = L.ao; c = L.c; }
  let ov = textureLoad(over, q, 0).r;
  if (ov != 255u) { c = ov; row = lvl(V.flat, vec2i(X, Y)) * 4u + fire; ao = 0u; }
  let rgba = unpack4x8unorm(tables[${LUT0}u + row * V.ncol + hazed(c, q)]);
  if (V.aoDbg > 0.5) { return vec4f(vec3f(1.0 - f32(ao & 7u) / 7.0), 1.0); }
  return vec4f(rgba.rgb * aoMul(ao, row), 1.0);
}`;

// ---------- the sun map and the ground's folds ----------
// Which ground sees the sun: from each texel of the island's heights, how far the ground
// toward the sun rises above the ray to it (the drawn, exaggerated heights), softened at the edge.
const TRACE_WGSL = `
fn hBil(p: vec2f) -> f32 {
  let n = f32(T.n) - 1.0;
  let f = clamp(p, vec2f(0.0), vec2f(n));
  let i = vec2i(floor(f));
  let i1 = min(i + 1, vec2i(i32(n)));
  let t = f - floor(f);
  let a = textureLoad(gGrid, i, 0, 0).r;
  let b = textureLoad(gGrid, vec2i(i1.x, i.y), 0, 0).r;
  let c = textureLoad(gGrid, vec2i(i.x, i1.y), 0, 0).r;
  let d = textureLoad(gGrid, i1, 0, 0).r;
  return mix(mix(a, b, t.x), mix(c, d, t.x), t.y);
}
@compute @workgroup_size(8, 8)
fn sunMain(@builtin(global_invocation_id) id: vec3u) {
  let y = id.y + T.row0;
  if (id.x >= T.n || y >= T.n) { return; }
  let p = vec2f(f32(id.x), f32(y));
  let h0 = textureLoad(gGrid, vec2i(p), 0, 0).r * T.exag;
  let dir = vec2f(T.dx, T.dz);
  var ex = -1e9;
  for (var d = T.step; d < 2400.0; d *= 1.09) { ex = max(ex, hBil(p + dir * (d / T.step)) * T.exag - (h0 + d * T.tan)); }
  textureStore(sunOut, vec2i(p), vec4f(smoothstep(-3.0, 10.0, ex), 0.0, 0.0, 1.0));
}
// How much sky the ground's own folds hide: round the point, in 12 directions, how far the
// horizon stands above the tangent plane, out to reach meters, as the sine of the angle between them, averaged.
fn sinAt(t: f32) -> f32 { return t * inverseSqrt(1.0 + t * t); }
@compute @workgroup_size(8, 8)
fn foldMain(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= T.n || id.y >= T.n) { return; }
  let p = vec2f(f32(id.x), f32(id.y));
  let h0 = textureLoad(gGrid, vec2i(p), 0, 0).r * T.exag;
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
fn artAt(k: vec2f) -> vec4f { return textureLoad(art, clamp(vec2i(floor(k / P.nn)), vec2i(0), vec2i(i32(P.aw) - 1, i32(P.ah) - 1)), 0); }
@fragment
fn presentFS(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let pc = pos.xy;
  let a = (pc - vec2f(P.dx, P.dy)) / P.sc;
  var c: vec4f;
  if (a.x < 0.0 || a.y < 0.0 || a.x >= f32(P.aw) || a.y >= f32(P.ah)) { if (P.alpha < 1.0) { discard; } c = vec4f(P.sr, P.sg, P.sb, 1.0); }
  else if (P.nearest == 1u) { c = textureLoad(art, vec2i(floor(a)), 0); }
  else {
    let m = (pc - vec2f(P.dx, P.dy)) * P.nn / P.sc - 0.5;
    let m0 = floor(m);
    let f = m - m0;
    c = mix(mix(artAt(m0), artAt(m0 + vec2f(1.0, 0.0)), f.x), mix(artAt(m0 + vec2f(0.0, 1.0)), artAt(m0 + vec2f(1.0, 1.0)), f.x), f.y);
  }
  return vec4f(c.rgb * P.alpha, P.alpha);
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
  const STRUCTS = `${VU.wgsl}\n${TU.wgsl}\n${PU.wgsl}\n${TYPES}`, GROUND = groundWGSL(1, ground.consts ?? {});
  const stage = GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT | GPUShaderStage.COMPUTE;
  const groundLayout = device.createBindGroupLayout({
    label: "ground",
    entries: GROUND_BINDINGS.map((b, i) => (b.kind === "storage" ? { binding: i, visibility: stage, buffer: { type: "read-only-storage" } } : { binding: i, visibility: stage, texture: { sampleType: b.sampleType, viewDimension: b.dim ?? "2d" } })),
  });
  function pipe({ label, binds, code, compute, vs, fs, targets, depth, blend, withGround = false, topology = "triangle-list" }) {
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
        fragment: { module: m, entryPoint: fs, targets: targets.map((f) => ({ format: f, ...(blend && { blend }) })) },
        ...(depth && { depthStencil: { format: "depth32float", depthWriteEnabled: true, depthCompare: "less-equal" } }),
      })).then((p) => { o.p = p; stats.compile[label] = Math.round(performance.now() - t0); }, (e) => errors.push(`${label}: ${e.message.slice(0, 300)}`));
    return o;
  }
  const GT = ["rg32uint", "rgba32float"];
  const fontRows = [], extra = [":", ".", ",", "-", "/", " ", "°"];
  for (const ch of [..."ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789", ...extra]) fontRows.push(...GLYPHS[ch].split(" ").map((r) => parseInt(r, 2)));
  const LUT0 = 10 * NCOL, FONT0 = LUT0 + ROWS * NCOL;
  const S = {
    tiles: pipe({ label: "tiles", binds: ["V", "tiles:w"], code: TILES_WGSL, compute: "tilesMain", withGround: true }),
    verts: pipe({ label: "verts", binds: ["V", "tiles", "verts:w"], code: VERTS_WGSL, compute: "vertsMain", withGround: true }),
    cull: pipe({ label: "cull", binds: ["V", "tiles", "verts", "objs", "table", "entries", "ids", "inst:w", "rowInst:w", "args:w", "pts:w"], code: `${MAP_READ}\n${CULL_WGSL(pal.TILE_M.toFixed(4), pal.ORIGIN.toFixed(4))}`, compute: "cullMain" }),
    clampArgs: pipe({ label: "clampArgs", binds: ["V", "args:w"], code: CULL_WGSL(1, 0).replace(/@compute @workgroup_size\(256\)[\s\S]*?\n}\n(?=@compute)/, ""), compute: "clampMain" }),
    terrain: pipe({ label: "terrain", binds: ["V", "tiles", "verts"], code: `${MAP_READ}\n${TERRAIN_WGSL}`, vs: "terrainVS", fs: "terrainFS", targets: GT, depth: true, withGround: true }),
    sprites: pipe({ label: "sprites", binds: ["V", "inst", "entries", "atlas"], code: SPRITE_WGSL("inst").replace(/@fragment\nfn xrayFS[\s\S]*$/, ""), vs: "spriteVS", fs: "spriteFS", targets: GT, depth: true }),
    splatA: pipe({ label: "splatA", binds: ["V", "pts", "entries", "argsR", "keys:w", "zbuf"], code: SPLAT_WGSL.replace(/@compute @workgroup_size\(64\)\nfn splatB[\s\S]*$/, ""), compute: "splatA" }),
    splatB: pipe({ label: "splatB", binds: ["V", "pts", "entries", "argsR", "keysR", "zbuf", "gKs", "gWs", "atlas"], code: SPLAT_WGSL.replace(/@compute @workgroup_size\(64\)\nfn splatA[\s\S]*?\n}\n/, ""), compute: "splatB" }),
    live: pipe({ label: "live", binds: ["V", "live", "entries", "atlas"], code: SPRITE_WGSL("live").replace(/@fragment\nfn xrayFS[\s\S]*$/, ""), vs: "spriteVS", fs: "spriteFS", targets: GT, depth: true }),
    xray: pipe({ label: "xray", binds: ["V", "live", "entries", "atlas"], code: SPRITE_WGSL("live").replace(/@fragment\nfn spriteFS[\s\S]*?\n}\n(?=@fragment)/, ""), vs: "spriteVS", fs: "xrayFS", targets: ["rg32uint"] }),
    mask: pipe({ label: "mask", binds: ["V", "rowInst", "inst", "entries", "rows"], code: MASK_WGSL, vs: "maskVS", fs: "maskFS", targets: ["r8unorm"] }),
    maskLive: pipe({ label: "maskLive", binds: ["V", "liveRows"], code: MASK_LIVE_WGSL, vs: "maskLiveVS", fs: "maskFS", targets: ["r8unorm"] }),
    over: pipe({ label: "over", binds: ["V", "prims", "entries", "atlas", "tables"], code: OVER_WGSL(FONT0, extra.map((c) => c.codePointAt(0)), [P.r4, P.snow, P.r5]), vs: "overVS", fs: "overFS", targets: ["r8uint"] }),
    shade: pipe({ label: "shade", binds: ["V", "gK", "gW", "mask", "over", "xray", "sun", "can0", "can3", "tables", "fires"], code: SHADE_WGSL(LUT0), vs: "fullVS", fs: "shadeFS", targets: ["rgba8unorm"], withGround: true }),
    sun: pipe({ label: "sun", binds: ["T", "sunOut"], code: TRACE_WGSL, compute: "sunMain", withGround: true }),
    fold: pipe({ label: "fold", binds: ["T", "sunOut"], code: TRACE_WGSL, compute: "foldMain", withGround: true }),
    present: pipe({ label: "present", binds: ["P", "art"], code: PRESENT_WGSL, vs: "fullVS", fs: "presentFS", targets: [format], blend: { color: { srcFactor: "one", dstFactor: "one-minus-src-alpha" }, alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha" } } }),
  };

  // ---------- resources ----------
  const B = (size, usage, label) => device.createBuffer({ size: Math.max(16, Math.ceil(size / 4) * 4), usage, label });
  const STOR = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST, UNI = GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST;
  const tex = (o) => device.createTexture({ usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST, dimension: "2d", ...o });
  const upload = (t, data, w, h, bpp, layer = 0) => device.queue.writeTexture({ texture: t, origin: [0, 0, layer] }, data, { bytesPerRow: w * bpp, rowsPerImage: h }, [w, h, 1]);
  // the ground's fields
  const gp = ground;
  const fineT = tex({ size: [gp.fine.size, gp.fine.size, gp.fine.layers], format: "r32float", label: "fine" });
  for (let l = 0; l < gp.fine.layers; l++) upload(fineT, gp.fine.data.subarray(l * gp.fine.size ** 2, (l + 1) * gp.fine.size ** 2), gp.fine.size, gp.fine.size, 4, l);
  const isleT = tex({ size: [gp.isle.size, gp.isle.size, gp.isle.layers], format: "r32float", label: "isle" });
  for (let l = 0; l < gp.isle.layers; l++) upload(isleT, gp.isle.data.subarray(l * gp.isle.size ** 2, (l + 1) * gp.isle.size ** 2), gp.isle.size, gp.isle.size, 4, l);
  const GN = gp.grid.size, gridT = device.createTexture({ size: [GN, GN, 8], format: "r32float", usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC, label: "grid" });
  for (let l = 0; l < 3; l++) upload(gridT, gp.grid.data.subarray(l * GN * GN, (l + 1) * GN * GN), GN, GN, 4, l);
  const RMN = Math.round(Math.sqrt(gp.river.length)), riverT = tex({ size: [RMN, RMN], format: "r8uint", label: "river" });
  upload(riverT, gp.river, RMN, RMN, 1);
  const TN = pal.TRAIL_N, trailT = tex({ size: [TN, TN], format: "r8uint", label: "trails" });
  const iceT = tex({ size: [pal.TILES, pal.TILES], format: "r8uint", label: "ice" });
  const stor = (data, label) => { const b = B(data.byteLength, STOR, label); device.queue.writeBuffer(b, 0, data); return b; };
  const groundBuffers = GROUND_BINDINGS.map((b, i) => {
    if (b.kind !== "storage") return null;
    const data = [gp.dq, gp.grad, gp.streams, gp.streamBins][i - 6];
    return stor(data.length ? data : new Uint32Array(4), `ground${i}`);
  });
  const groundGroup = device.createBindGroup({
    layout: groundLayout,
    entries: [fineT, isleT, gridT, riverT, trailT, iceT].map((t, i) => ({ binding: i, resource: t.createView() })).concat(groundBuffers.slice(6).map((b, k) => ({ binding: 6 + k, resource: { buffer: b } }))),
  });
  // the gradient of the heights for the light (setHeights of old: over two steps each way), into grid layers 3 and 4
  {
    const h = gp.grid.data.subarray(0, GN * GN), gx = new Float32Array(GN * GN), gz = new Float32Array(GN * GN), step = pal.GRID_STEP;
    const at = (i, j) => h[Math.min(GN - 1, Math.max(0, j)) * GN + Math.min(GN - 1, Math.max(0, i))];
    for (let j = 0; j < GN; j++)
      for (let i = 0; i < GN; i++) {
        gx[j * GN + i] = (at(i + 2, j) + at(i + 1, j) - at(i - 1, j) - at(i - 2, j)) / (6 * step);
        gz[j * GN + i] = (at(i, j + 2) + at(i, j + 1) - at(i, j - 1) - at(i, j - 2)) / (6 * step);
      }
    upload(gridT, gx, GN, GN, 4, 3); upload(gridT, gz, GN, GN, 4, 4);
  }
  // tables: haze, glow, the ground's tones by light, then the sky's light table
  const tables = new Uint32Array(FONT0 + fontRows.length);
  tables.set(HAZE, 0); tables.set(GLOW, NCOL); tables.set(TONE, 2 * NCOL); tables.set(fontRows, FONT0);
  const tablesB = stor(tables, "tables");
  // the sun maps (front and back) and the scratch the ground's folds are traced into
  const sunTex = () => device.createTexture({ size: [GN, GN], format: "r32float", usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC, label: "sun" });
  const sunMaps = [sunTex(), sunTex()], foldT = sunTex();
  let sunFront = 0, sunJob = null, sunShown = null, exagFolded = null;
  // the trees' cover (canopy.js) and its wide average
  let canopy = { n: 1, step: 1, t0: tex({ size: [1, 1], format: "r8uint" }), t3: tex({ size: [1, 1], format: "r32float" }), n3: 1 };
  const traceU = B(TU.bytes, UNI, "trace");

  // objects and sprites
  let objCount = 0, objCap = 0, objsB = B(16, STOR, "objs"), idsB = B(16, STOR, "ids");
  let tableB = B(16, STOR, "table"), entriesB = B(32, STOR, "entries"), rowsB = B(16, STOR, "rows");
  let atlasT = device.createTexture({ size: [ATLAS, ATLAS, 1], format: "r8uint", usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC, label: "atlas" });
  let entriesCap = 0;
  const instB = B(MAX_INST * 32, GPUBufferUsage.STORAGE, "inst"), rowInstB = B(MAX_ROWS * 8, GPUBufferUsage.STORAGE, "rowInst");
  const argsB = B(64, GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC, "args"), argsInit = B(64, GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST, "argsInit");
  device.queue.writeBuffer(argsInit, 0, new Uint32Array([6, 0, 0, 0, 6, 0, 0, 0, 1, 0, 0, 0, 0, 1, 1, 0]));
  const ptsB = B(MAX_INST * 32, GPUBufferUsage.STORAGE, "pts");
  const tilesB = B(MAX_TILES * 8, GPUBufferUsage.STORAGE, "tiles"), vertsB = B(MAX_TILES * 4 + 4 * 4096, GPUBufferUsage.STORAGE, "verts");
  const liveB = B(MAX_LIVE * 32, STOR, "live"), liveRowsB = B(MAX_LIVE_ROWS * 16, STOR, "liveRows"), primsB = B(MAX_PRIMS * 32, STOR, "prims");
  const viewU = [0, 1].map((k) => B(VU.bytes, UNI, `view${k}`)), firesU = [0, 1].map((k) => B(MAX_FIRES * 16, UNI, `fires${k}`)), presentU = [0, 1].map((k) => B(PU.bytes, UNI, `present${k}`));
  // per-frame targets, sized to the largest view
  let cap = null;
  function ensure(w, h) {
    if (cap && cap.w >= w && cap.h >= h) return;
    w = Math.max(w, cap?.w ?? 0); h = Math.max(h, cap?.h ?? 0);
    cap?.list.forEach((t) => t.destroy());
    const T = (format, usage = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING) => device.createTexture({ size: [w, h], format, usage });
    const c = { w, h, gK: T("rg32uint", GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC), gW: T("rgba32float", GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING), depth: T("depth32float", GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING), keys: B(w * h * 4, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST, "keys"), mask: T("r8unorm"), over: T("r8uint"), xray: T("rg32uint"), art: [T("rgba8unorm"), T("rgba8unorm")], pickBuf: null };
    c.list = [c.gK, c.gW, c.depth, c.mask, c.over, c.xray, ...c.art];
    cap = c;
  }

  // ---------- bind groups ----------
  const res = (name, v) => {
    switch (name) {
      case "V": return { buffer: viewU[v] };
      case "tiles": return { buffer: tilesB };
      case "verts": return { buffer: vertsB };
      case "objs": return { buffer: objsB };
      case "ids": return { buffer: idsB };
      case "table": return { buffer: tableB };
      case "entries": return { buffer: entriesB };
      case "rows": return { buffer: rowsB };
      case "inst": return { buffer: instB };
      case "pts": return { buffer: ptsB };
      case "keys": case "keysR": return { buffer: cap.keys };
      case "argsR": return { buffer: argsB };
      case "zbuf": return cap.depth.createView();
      case "gKs": return cap.gK.createView();
      case "gWs": return cap.gW.createView();
      case "rowInst": return { buffer: rowInstB };
      case "args": return { buffer: argsB };
      case "atlas": return atlasT.createView({ dimension: "2d-array" });
      case "live": return { buffer: liveB };
      case "liveRows": return { buffer: liveRowsB };
      case "prims": return { buffer: primsB };
      case "gK": return cap.gK.createView();
      case "gW": return cap.gW.createView();
      case "mask": return cap.mask.createView();
      case "over": return cap.over.createView();
      case "xray": return cap.xray.createView();
      case "sun": return sunMaps[sunFront].createView();
      case "can0": return canopy.t0.createView();
      case "can3": return canopy.t3.createView();
      case "tables": return { buffer: tablesB };
      case "fires": return { buffer: firesU[v] };
      case "T": return { buffer: traceU };
      case "P": return { buffer: presentU[v] };
      case "art": return cap.art[v].createView();
      default: throw new Error(`no resource ${name}`);
    }
  };
  const group = (s, v = 0, over = {}) => device.createBindGroup({ layout: s.bgl, entries: s.binds.map((n) => { const name = n.split(":")[0]; return { binding: RES[name][0], resource: over[name] ?? res(name, v) }; }) });

  // ---------- the light's fields ----------
  // How much sky the ground's folds hide, traced once over the heights at the drawn exaggeration into grid layer 6.
  function fold(enc, exag) {
    if (exagFolded === exag) return;
    device.queue.writeBuffer(traceU, 0, TU.pack({ n: GN, step: pal.GRID_STEP, exag, reach: TER_REACH }));
    const pass = enc.beginComputePass(tw("fold"));
    pass.setPipeline(S.fold.p); pass.setBindGroup(0, group(S.fold, 0, { sunOut: foldT.createView() })); pass.setBindGroup(1, groundGroup);
    pass.dispatchWorkgroups(Math.ceil(GN / 8), Math.ceil(GN / 8));
    pass.end();
    enc.copyTextureToTexture({ texture: foldT }, { texture: gridT, origin: [0, 0, 6] }, [GN, GN, 1]);
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
    device.queue.writeBuffer(traceU, 0, TU.pack({ n: GN, step: pal.GRID_STEP, exag: sunJob.exag, tan: sunJob.tan, dx: sunJob.dir[0], dz: sunJob.dir[1], row0: sunJob.row, reach: TER_REACH }));
    const pass = enc.beginComputePass(tw("sun"));
    pass.setPipeline(S.sun.p); pass.setBindGroup(0, group(S.sun, 0, { sunOut: sunMaps[1 - sunFront].createView() })); pass.setBindGroup(1, groundGroup);
    pass.dispatchWorkgroups(Math.ceil(GN / 8), Math.ceil(Math.min(rows, GN - sunJob.row) / 8));
    pass.end();
    sunJob.row += rows;
    if (sunJob.row >= GN) { sunFront = 1 - sunFront; sunShown = sunJob; sunJob = null; stats.traces++; }
  }
  // The trees' cover of the ground, n x n cells of `step` meters (canopy.js bytes), with its 8x8 means for the wide
  // read, and the trees' mean height on the heights' grid into layer 5.
  function setCanopy(n, step, bytes, tall) {
    const n3 = Math.floor(n / 8), wide = new Float32Array(n3 * n3);
    for (let j = 0; j < n3; j++)
      for (let i = 0; i < n3; i++) {
        let s = 0;
        for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) s += bytes[(j * 8 + y) * n + i * 8 + x];
        wide[j * n3 + i] = s / (64 * 255);
      }
    canopy.t0.destroy(); canopy.t3.destroy();
    canopy = { n, step, n3, bytes, wide, t0: tex({ size: [n, n], format: "r8uint", label: "canopy" }), t3: tex({ size: [n3, n3], format: "r32float", label: "canopy3" }) };
    upload(canopy.t0, bytes, n, n, 1); upload(canopy.t3, wide, n3, n3, 4);
    if (tall) upload(gridT, tall, GN, GN, 4, 5);
  }
  // cells of the cover that changed: the w x h block at (x, y), its bytes in rows
  function updateCanopy(x, y, w, h, bytes) {
    const c = canopy, n = c.n;
    for (let j = 0; j < h; j++) c.bytes.set(bytes.subarray(j * w, j * w + w), (y + j) * n + x);
    device.queue.writeTexture({ texture: c.t0, origin: [x, y] }, bytes, { bytesPerRow: w }, [w, h, 1]);
    const i0 = Math.floor(x / 8), i1 = Math.min(c.n3 - 1, Math.floor((x + w - 1) / 8)), j0 = Math.floor(y / 8), j1 = Math.min(c.n3 - 1, Math.floor((y + h - 1) / 8));
    if (i1 < i0 || j1 < j0) return;
    const ww = i1 - i0 + 1, out = new Float32Array(ww * (j1 - j0 + 1));
    for (let j = j0; j <= j1; j++)
      for (let i = i0; i <= i1; i++) {
        let s = 0;
        for (let yy = 0; yy < 8; yy++) for (let xx = 0; xx < 8; xx++) s += c.bytes[(j * 8 + yy) * n + i * 8 + xx];
        out[(j - j0) * ww + i - i0] = c.wide[j * c.n3 + i] = s / (64 * 255);
      }
    device.queue.writeTexture({ texture: c.t3, origin: [i0, j0] }, out, { bytesPerRow: ww * 4 }, [ww, j1 - j0 + 1, 1]);
  }

  // ---------- objects and sprites ----------
  // The objects (worker.js packs them): objs four words each (px, py, shown size as f32 bits, meta), ids their sim ids.
  function setObjects(objs, ids, count) {
    objCap = ids.length; objCount = count;
    objsB.destroy(); idsB.destroy();
    objsB = B(objCap * 16, STOR, "objs"); idsB = B(objCap * 4, STOR, "ids");
    device.queue.writeBuffer(objsB, 0, objs); device.queue.writeBuffer(idsB, 0, ids);
  }
  // objects k.. changed: their words and ids
  function updateObjects(k, objs, ids) {
    device.queue.writeBuffer(objsB, k * 16, objs); device.queue.writeBuffer(idsB, k * 4, ids);
    objCount = Math.max(objCount, k + ids.length);
  }
  // The atlas: layers of ATLAS x ATLAS palette indices; entries two vec4u per sprite; rows each casting row's span; table
  // the sprite (id + 1) of each family and size, 0 where none was made.
  function setAtlas({ layers, entries, rows, table }) {
    atlasT.destroy();
    atlasT = device.createTexture({ size: [ATLAS, ATLAS, layers], format: "r8uint", usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC, label: "atlas" });
    entriesB.destroy(); rowsB.destroy(); tableB.destroy();
    entriesCap = entries.length / 8;
    entriesB = B(entries.byteLength, STOR, "entries"); rowsB = B(Math.max(16, rows.byteLength), STOR, "rows"); tableB = B(table.byteLength, STOR, "table");
    device.queue.writeBuffer(entriesB, 0, entries); if (rows.length) device.queue.writeBuffer(rowsB, 0, rows); device.queue.writeBuffer(tableB, 0, table);
  }
  // pixels into the atlas: a w x h block at (x, y) of layer l
  const atlasPut = (l, x, y, w, h, px) => device.queue.writeTexture({ texture: atlasT, origin: [x, y, l] }, px, { bytesPerRow: w }, [w, h, 1]);
  // sprite entries from `at` on (live sprites, made as they are needed)
  const tablePut = (slot, v) => device.queue.writeBuffer(tableB, slot * 4, Uint32Array.of(v));
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
  const countRead = [0, 1, 2].map(() => ({ b: B(48, GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST, "counts"), busy: false }));
  let inFlight = 0;

  // f: worker.js's frame: { views: [{ U (VU fields), alpha, present: { dx, dy, sc, nn, nearest }, live, liveRows, prims, fires, xray }], lut, out, sea, cast, exag }
  function frame(f) {
    const views = f.views;
    ensure(Math.max(...views.map((v) => v.U.aw)), Math.max(...views.map((v) => v.U.ah)));
    if (f.lut) device.queue.writeBuffer(tablesB, LUT0 * 4, f.lut);
    const enc = device.createCommandEncoder();
    qNames = [];
    fold(enc, f.exag);
    traceSun(enc, f.cast);
    views.forEach((v, k) => drawView(enc, v, k, f.id));
    // present every view onto the canvas
    const out = context.getCurrentTexture();
    const pass = enc.beginRenderPass({ colorAttachments: [{ view: out.createView(), loadOp: "clear", storeOp: "store", clearValue: { r: f.seaRGB[0], g: f.seaRGB[1], b: f.seaRGB[2], a: 1 } }], ...tw("present") });
    pass.setPipeline(S.present.p);
    views.forEach((v, k) => {
      const p = v.present;
      device.queue.writeBuffer(presentU[k], 0, PU.pack({ dx: p.dx, dy: p.dy, sc: p.sc, nn: p.nn, alpha: v.alpha, aw: v.U.aw, ah: v.U.ah, nearest: p.nearest, sr: f.seaRGB[0], sg: f.seaRGB[1], sb: f.seaRGB[2] }));
      pass.setBindGroup(0, group(S.present, k));
      pass.draw(3);
    });
    pass.end();
    // the picks asked for, from view 0's G-buffer as it was before the second view reused it: copied in drawView
    let qr = null;
    const names = qNames, nq = names.length * 2;
    if (qs && nq) { qr = qRead.find((r) => !r.busy); if (qr) { enc.resolveQuerySet(qs, 0, nq, qBuf, 0); enc.copyBufferToBuffer(qBuf, 0, qr.b, 0, nq * 8); } }
    device.queue.submit([enc.finish()]);
    inFlight++;
    device.queue.onSubmittedWorkDone().then(() => { inFlight--; });
    if (qr) {
      qr.busy = true;
      qr.b.mapAsync(GPUMapMode.READ).then(() => {
        const t = new BigUint64Array(qr.b.getMappedRange(), 0, nq), parts = {};
        let lo = t[0], hi = t[1];
        names.forEach((n, i) => { const a = t[2 * i], b = t[2 * i + 1]; if (a < lo) lo = a; if (b > hi) hi = b; parts[n] = +((parts[n] ?? 0) + Number(b - a) / 1e6).toFixed(3); });
        stats.gpuMs = Number(hi - lo) / 1e6; stats.passes = parts;
        qr.b.unmap(); qr.busy = false;
      }).catch(() => { qr.busy = false; });
    }
    for (const r of pendingPickReads.splice(0)) r();
  }
  const pendingPickReads = [];
  function drawView(enc, v, k, frameId) {
    const U = v.U, nTiles = U.ni * U.nj;
    device.queue.writeBuffer(viewU[k], 0, VU.pack({ ...U, nobj: objCount, maxinst: MAX_INST, maxrows: MAX_ROWS, gridN: GN, gridStep: pal.GRID_STEP, canN: canopy.n, canStep: canopy.step, can3: canopy.n3, ncol: NCOL, toneN: TONE_S.length, toneLo: TONE_S[0], toneHi: TONE_S[TONE_S.length - 1], wlo: Math.min(...WATER), whi: Math.max(...WATER) }));
    if (v.fires?.length) device.queue.writeBuffer(firesU[k], 0, v.fires);
    stats.tiles = nTiles;
    // 1. the tile map, 2. cull
    enc.copyBufferToBuffer(argsInit, 0, argsB, 0, 64);
    let pass = enc.beginComputePass(tw("map"));
    pass.setBindGroup(1, groundGroup);
    pass.setPipeline(S.tiles.p); pass.setBindGroup(0, group(S.tiles, k)); pass.dispatchWorkgroups(Math.ceil(nTiles / 64));
    pass.setPipeline(S.verts.p); pass.setBindGroup(0, group(S.verts, k)); pass.dispatchWorkgroups(Math.ceil(((U.ni + 1) * (U.nj + 1)) / 64));
    pass.end();
    if (objCount) {
      pass = enc.beginComputePass(tw("cull"));
      const wg = Math.ceil(objCount / 256), wx = Math.min(wg, 32768), wy = Math.ceil(wg / wx);
      pass.setPipeline(S.cull.p); pass.setBindGroup(0, group(S.cull, k)); pass.dispatchWorkgroups(wx, wy);
      pass.setPipeline(S.clampArgs.p); pass.setBindGroup(0, group(S.clampArgs, k)); pass.dispatchWorkgroups(1);
      pass.end();
    }
    // 4. the sun's mask (first, so the world pass may reuse nothing of it)
    const nLiveRows = v.liveRows ? v.liveRows.length / 4 : 0;
    if (nLiveRows) device.queue.writeBuffer(liveRowsB, 0, Int32Array.from(v.liveRows));
    let rp = enc.beginRenderPass({ colorAttachments: [{ view: cap.mask.createView(), loadOp: "clear", storeOp: "store", clearValue: { r: 0, g: 0, b: 0, a: 0 } }], ...tw("mask") });
    rp.setViewport(0, 0, U.aw, U.ah, 0, 1);
    if (U.casting) {
      if (objCount) { rp.setPipeline(S.mask.p); rp.setBindGroup(0, group(S.mask, k)); rp.drawIndirect(argsB, 16); }
      if (nLiveRows) { rp.setPipeline(S.maskLive.p); rp.setBindGroup(0, group(S.maskLive, k)); rp.draw(6, nLiveRows); }
    }
    rp.end();
    // 3. the world
    const nLive = v.live ? v.live.byteLength / 32 : 0;
    if (nLive) device.queue.writeBuffer(liveB, 0, v.live);
    rp = enc.beginRenderPass({
      colorAttachments: [
        { view: cap.gK.createView(), loadOp: "clear", storeOp: "store", clearValue: { r: 0xffffffff, g: 0, b: 0, a: 0 } },
        { view: cap.gW.createView(), loadOp: "clear", storeOp: "store", clearValue: { r: 0, g: 0, b: 0, a: 0 } },
      ],
      depthStencilAttachment: { view: cap.depth.createView(), depthLoadOp: "clear", depthStoreOp: "store", depthClearValue: 1 },
      ...tw("world"),
    });
    rp.setViewport(0, 0, U.aw, U.ah, 0, 1);
    rp.setPipeline(S.terrain.p); rp.setBindGroup(0, group(S.terrain, k)); rp.setBindGroup(1, groundGroup);
    rp.draw(18 * Math.max(0, U.ni - 2) * Math.max(0, U.nj - 2));
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
    if (k === 0) {
      const cr = countRead.find((q) => !q.busy);
      if (cr) {
        cr.busy = true;
        enc.copyBufferToBuffer(argsB, 0, cr.b, 0, 48);
        pendingPickReads.push(() => cr.b.mapAsync(GPUMapMode.READ).then(() => { const a = new Uint32Array(cr.b.getMappedRange().slice(0)); cr.b.unmap(); cr.busy = false; stats.counts = { sprites: a[1], rows: a[5], points: a[9], tiles: nTiles }; }).catch(() => { cr.busy = false; }));
      }
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
    if (nPrims) device.queue.writeBuffer(primsB, k * 0, v.prims);
    rp = enc.beginRenderPass({ colorAttachments: [{ view: cap.over.createView(), loadOp: "clear", storeOp: "store", clearValue: { r: 255, g: 0, b: 0, a: 0 } }], ...tw("over") });
    rp.setViewport(0, 0, U.aw, U.ah, 0, 1);
    if (nPrims) { rp.setPipeline(S.over.p); rp.setBindGroup(0, group(S.over, k)); rp.setBindGroup(1, groundGroup); rp.draw(6, nPrims); }
    rp.end();
    rp = enc.beginRenderPass({ colorAttachments: [{ view: cap.xray.createView(), loadOp: "clear", storeOp: "store", clearValue: { r: 0, g: 0, b: 0, a: 0 } }] });
    rp.setViewport(0, 0, U.aw, U.ah, 0, 1);
    if (v.xray && nLive) { rp.setPipeline(S.xray.p); rp.setBindGroup(0, group(S.xray, k)); for (const i of v.xray) rp.draw(6, 1, 0, i); }
    rp.end();
    // 6. shade into the view's art buffer
    rp = enc.beginRenderPass({ colorAttachments: [{ view: cap.art[k].createView(), loadOp: "clear", storeOp: "store", clearValue: { r: 0, g: 0, b: 0, a: 1 } }], ...tw("shade") });
    rp.setViewport(0, 0, U.aw, U.ah, 0, 1);
    rp.setPipeline(S.shade.p); rp.setBindGroup(0, group(S.shade, k)); rp.setBindGroup(1, groundGroup);
    rp.draw(3);
    rp.end();
  }
  await Promise.all(Object.values(S).map((o) => o.ready));
  return {
    errors, stats, frame, setObjects, updateObjects, setAtlas, atlasPut, entriesPut, rowsPut, tablePut, setCanopy, updateCanopy, setTrails, setTrailRect, setIce,
    get busy() { return inFlight; },
    // what view 0 shows at art px (x, y) in the next frame: { kind, pick } (kind -1: nothing), or null
    pick: (x, y) => new Promise((resolve) => picks.push({ x, y, resolve })),
  };
}
