import { groundWGSL } from "../ground.wgsl.js";

// The planet layer's picture (planet.js): each art pixel's ray crosses the shell between the unit sphere and the highest relief (land
// stands exag times its height above the sphere, the sea is the sphere) and is marched to the surface, so a tilted view shifts a high
// point on the screen as the ladder's does. The hit is put on its cube face as the grid does (src/gpu/globe/grid.ts locateVec: the
// face whose normal is nearest, then the equiangular coordinates) and the planet's own ground is read there from the tile pyramid
// (pyramid.js): the tier whose cells are about an art pixel across, the two tiers round the pixel's level told apart by the pixel's
// dither so that a zoom, or a finer tier arriving over the whole view, is one cross-fade of the whole picture. Nothing is made up
// below the cells: the height is a cubic B-spline of them (smooth slope at any zoom), the cover, soil, rock, drift, rain, lakes and
// rivers are what the tile holds.
//
// The colour is the island's, not a second one: the cells fill a GroundSample (ground.wgsl.js GSample, here by fillTop, fillWater,
// fillLand and fillColour below) and the ground painter's own code (g_paint: g_water, g_land, g_rgb) turns it into a palette index,
// with every detail of it faded by the art pixel's size in the noise's metres, so nothing switches between a close view and the
// planet. What stays here is the light of the planet's form: a slope's signed light moves each land colour along its ramp by the
// palette's tone steps (pal.js TONE), dithered by the same Bayer matrix, as the ladder's shade pass tones its ground.
export function globeWgsl({ FRAMES, P, RGB, NCOL, TONE_S, offsets, LEVELS }) {
  const lit = (v) => { const s = String(Math.fround(v)); return /[.e]/.test(s) ? s : `${s}.0`; };
  const v3 = (a) => `vec3f(${a.map(lit).join(", ")})`;
  const u = (n) => `${P[n]}u`;
  const ramp = (...n) => `array<u32, ${n.length}>(${n.map(u).join(", ")})`;
  const rgb = (c) => v3(c.map((x) => x / 255));
  const tiers = offsets.length - 1;
  return /* wgsl */ `
${groundWGSL(0, { planet: true })}
const PI = 3.14159265358979;
var<private> FACE_N: array<vec3f, 6> = array(${FRAMES.map((f) => v3(f.n)).join(", ")});
var<private> FACE_X: array<vec3f, 6> = array(${FRAMES.map((f) => v3(f.ex)).join(", ")});
var<private> FACE_Y: array<vec3f, 6> = array(${FRAMES.map((f) => v3(f.ey)).join(", ")});
// the pyramid's tiers, and where each starts in the page table
const TIERS = ${tiers}u;
var<private> TOFF: array<u32, ${tiers}> = array<u32, ${tiers}>(${offsets.slice(0, tiers).map((o) => `${o}u`).join(", ")});
const NONE = 0xffffffffu;
const HALO = 2.0;
const HS = 260;

const NC = ${NCOL}u;
const LEVELS = ${LEVELS};
const PAL = array<vec3f, ${NCOL}>(${RGB.map((c) => rgb(c)).join(", ")});
// the palette's tables (pal.js): HAZE and SHADOW, one index each, then TONE's rows, one per slope light in TONE_S
const T_SHADOW = NC;
const T_TONE = 2u * NC;
const TONE_LO = ${lit(TONE_S[0])};
const TONE_HI = ${lit(TONE_S[TONE_S.length - 1])};
const TONE_N = ${lit(TONE_S.length - 1)};
const g_AIR = ${ramp("ink", "w0", "w1", "w2", "w3", "w4", "w5")};
// the width of a stream at its mean flow, m (water.ts WIDE_GRASS times the root of the flow)
const WIDE = 3.75;

struct U {
  o: vec3f, tanH: f32,      // the camera's place (the target plus off) in radii from the centre, and the tangent of half the vertical field of view
  fwd: vec3f, aspect: f32,
  right: vec3f, relief: f32, // the relief's exaggeration for the light
  up: vec3f, exag: f32,     // and for the displaced ground
  sun: vec3f, radiusM: f32, // the light that gives the planet its form
  T: vec3f, hmaxR: f32,     // the camera's target on the sphere, and the highest relief above the sphere in radii (exag * hmax / radius)
  off: vec3f, art: f32,     // the camera less its target, and the art pixel in device pixels
  size: vec2f, zNear: f32, zFar: f32, // the canvas in device pixels, and the depth range along the view in radii
  cut: f32, airK: f32, aw: f32, ah: f32, // the river cut (m3/s), how much of the air's haze a camera this high shows, and the art-pixel target's size
  moon: vec3f, moonMix: f32, // the moon's direction, and how much of the key light it is (1 once the sun is down)
  amb: vec4f,               // x: the sky's ambient light where the camera stands, the light tables' row 0 (live.js ambientOf)
  nt: vec4f,                // the noise's frame, the camera's target on its face: x, y the equiangular tangents, z, w the fractions of a metre of its place
  nw: vec4i,                // and the whole metres of that place (noise offsets)
  cf: vec4f,                // x: the finest level the whole view has tiles for (planet.js), y: the water's frame 0 to 7, z: the season 0 to 3
  tf: vec4i,                // x: the face of the camera's target
}
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var fieldsT: texture_2d_array<u32>;  // a tile's cells, 16 bytes each (pyramid.js)
@group(0) @binding(2) var heightT: texture_2d_array<f32>;  // a tile's heights in m with a halo of 2 cells
@group(0) @binding(3) var<storage, read> table: array<u32>; // each tile's atlas layer, or NONE
@group(0) @binding(4) var<storage, read> tables: array<u32>;
@group(0) @binding(5) var<storage, read> gDQ: array<u32>; // ground.wgsl.js dqBuild
@group(0) @binding(6) var<storage, read> lutT: array<u32>; // the sky's light tables the ladder's shade pass maps its palette through (webgpu.js LUT0 on): LEVELS key light steps by the fire's 4 levels, NC colours each
@group(0) @binding(7) var<storage, read> gGradT: array<vec2<f32>>; // the painter's noise gradients (ground.wgsl.js noiseGrads)
@group(0) @binding(8) var artT: texture_2d<f32>;          // the picture at an art pixel, for the blit that shows it by whole pixels
// the painter's noise is offset by whole metres, here those of the noise frame's origin
fn g_wrapW(k: u32) -> vec2<i32> { return u.nw.xy; }

@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  return vec4f(p * 2.0 - 1.0, 0.0, 1.0);
}
// the art-pixel picture shown by whole pixels, nearest
@fragment fn bfs(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let at = min(vec2i(floor(pos.xy / u.art)), vec2i(i32(u.aw) - 1, i32(u.ah) - 1));
  return textureLoad(artT, at, 0);
}

// ---------- px.js: the art pixel ----------
var<private> gX: i32;
var<private> gY: i32;
var<private> gMpp: f32;  // metres to an art pixel at the surface
// the sky's ambient light with the sun at sin(elevation) s: live.js lightOf's a (a power of the sun's height by day, an e-fold each 2.2 degrees below the horizon) and AMB, STAR [change both together]
fn ambOf(s: f32) -> f32 {
  let a0 = pow(0.021 / (0.8512 + 0.021), 0.65);
  let day = pow((max(s, 0.0) + 0.021) / (0.8512 + 0.021), 0.65);
  let night = a0 * exp(degrees(asin(clamp(s, -1.0, 0.0))) / 2.2);
  return 0.9 * select(night, day, s >= 0.0) + 0.0012;
}
var<private> gForm: f32; // the planet's form light in tone steps, 0 where the island's flat ground is

// colour c under a slope light s, as the shade pass lights the ground: the palette's tone rows, dithered
fn toned(c: u32, s: f32) -> u32 {
  let j = u32(clamp(floor((s - TONE_LO) / (TONE_HI - TONE_LO) * TONE_N + 0.5 + (bayer(gX, gY) - 0.5) * 0.55), 0.0, TONE_N));
  return tables[T_TONE + j * NC + c];
}

// ---------- the pyramid ----------
// the cube face under a unit point, and the equiangular fractions across it (src/gpu/globe/grid.ts locateVec)
struct FaceAt { f: i32, fx: f32, fy: f32, ua: f32, vb: f32 }
fn faceOf(p: vec3f) -> FaceAt {
  var f = 0;
  var best = dot(p, FACE_N[0]);
  for (var k = 1; k < 6; k++) { let d = dot(p, FACE_N[k]); if (d > best) { best = d; f = k; } }
  let ua = dot(p, FACE_X[f]) / best;
  let vb = dot(p, FACE_Y[f]) / best;
  return FaceAt(f, atan(ua) / (PI / 2.0) + 0.5, atan(vb) / (PI / 2.0) + 0.5, ua, vb);
}
// the mean cell of tier 0 in metres (the cell at a face's middle is the largest, the mean about 0.8 of it): tier t's is this over 2^t
fn cell0() -> f32 { return u.radiusM * (PI / 2.0) / 256.0 * 0.8; }
// the level whose cells are an art pixel across, as a fraction of tiers
fn levelFor(mpp: f32) -> f32 { return clamp(log2(cell0() / max(mpp, 1e-3)), 0.0, f32(TIERS - 1u)); }
// the tier whose cells are at most an art pixel across
fn tierFor(mpp: f32) -> u32 { return u32(ceil(levelFor(mpp))); }
// the tile that holds a place: the wanted tier's if it has arrived, else the finest coarser one; the cell coordinates in it and the
// cells across the face at its tier
struct Tl { slot: u32, t: u32, lx: f32, ly: f32, cells: f32 }
fn tileAt(f: i32, fx: f32, fy: f32, want: u32) -> Tl {
  var t = min(want, TIERS - 1u);
  loop {
    let n = 1u << t;
    let cells = f32(256u << t);
    let sx = fx * cells;
    let sy = fy * cells;
    let tx = min(u32(max(sx, 0.0)) / 256u, n - 1u);
    let ty = min(u32(max(sy, 0.0)) / 256u, n - 1u);
    let s = table[TOFF[t] + u32(f) * (n * n) + ty * n + tx];
    if (s != NONE) { return Tl(s, t, sx - f32(tx * 256u), sy - f32(ty * 256u), cells); }
    if (t == 0u) { break; }
    t -= 1u;
  }
  return Tl(NONE, 0u, 0.0, 0.0, 256.0);
}
fn hAt(ix: i32, iy: i32, l: i32) -> f32 { return textureLoad(heightT, clamp(vec2i(ix, iy), vec2i(0), vec2i(HS - 1)), l, 0).r; }
// the cells' height at a place, bilinear (the relief march's surface): m
fn hBil(t: Tl) -> f32 {
  let x = t.lx + HALO - 0.5;
  let y = t.ly + HALO - 0.5;
  let ix = i32(floor(x));
  let iy = i32(floor(y));
  let fx = x - floor(x);
  let fy = y - floor(y);
  let l = i32(t.slot);
  return mix(mix(hAt(ix, iy, l), hAt(ix + 1, iy, l), fx), mix(hAt(ix, iy + 1, l), hAt(ix + 1, iy + 1, l), fx), fy);
}
// the cubic B-spline's weights for the taps at -1, 0, 1, 2 of a fraction t, and their derivatives
fn bs(t: f32) -> vec4f {
  let s = 1.0 - t;
  return vec4f(s * s * s, 3.0 * t * t * t - 6.0 * t * t + 4.0, -3.0 * t * t * t + 3.0 * t * t + 3.0 * t + 1.0, t * t * t) / 6.0;
}
fn dbs(t: f32) -> vec4f {
  let s = 1.0 - t;
  return vec4f(-s * s, 3.0 * t * t - 4.0 * t, -3.0 * t * t + 2.0 * t + 1.0, t * t) * 0.5;
}
// the height at a place and its slope along each face axis, m a cell: the cells' cubic B-spline
fn heightSpline(t: Tl) -> vec3f {
  let tx = t.lx + HALO - 0.5;
  let ty = t.ly + HALO - 0.5;
  let ix = i32(floor(tx));
  let iy = i32(floor(ty));
  let wx = bs(tx - floor(tx));
  let wy = bs(ty - floor(ty));
  let dx = dbs(tx - floor(tx));
  let dy = dbs(ty - floor(ty));
  let l = i32(t.slot);
  var r = vec3f(0.0);
  for (var j = 0; j < 4; j++) {
    for (var i = 0; i < 4; i++) {
      r += hAt(ix - 1 + i, iy - 1 + j, l) * vec3f(wx[i] * wy[j], dx[i] * wy[j], wx[i] * dy[j]);
    }
  }
  return r;
}
// a cell's fields, as bake.ts PYRAMID_FIELDS gives them in their steps
struct Fv {
  rock: u32, drift: u32, dd: f32, temp: f32, rain: f32, water: f32, river: f32,
  tree: f32, shrub: f32, grass: f32, marsh: f32, bare: f32, soil: f32,
}
// a cell of the tile by its place in the tile, which may lie one past it: the layer holds a halo of 1 cell from the neighbouring tiles
fn word(l: u32, ix: i32, iy: i32) -> vec4u { return textureLoad(fieldsT, clamp(vec2i(ix + 1, iy + 1), vec2i(0), vec2i(257)), i32(l), 0); }
fn unpack(w: vec4u) -> Fv {
  let t8 = i32((w.y >> 8u) & 255u);
  var F: Fv;
  F.rock = (w.x >> 16u) & 255u;
  F.drift = (w.x >> 24u) & 255u;
  F.dd = f32(w.y & 255u) * 0.125;
  F.temp = f32(select(t8, t8 - 256, t8 > 127)) * 0.5;
  F.rain = f32(w.y >> 16u);
  F.water = f32(w.z & 255u) * 0.5;
  F.river = f32((w.z >> 8u) & 255u);
  F.tree = f32((w.z >> 16u) & 255u) / 255.0;
  F.shrub = f32(w.z >> 24u) / 255.0;
  F.grass = f32(w.w & 255u) / 255.0;
  F.marsh = f32((w.w >> 8u) & 255u) / 255.0;
  F.bare = f32((w.w >> 16u) & 255u) / 255.0;
  F.soil = f32(w.w >> 24u) * 0.025;
  return F;
}
// the continuous fields bilinear between the cells' centres inside the tile, the classes of the cell the place is in
fn fieldsAt(t: Tl) -> Fv {
  let x = t.lx - 0.5;
  let y = t.ly - 0.5;
  let ix = i32(floor(x));
  let iy = i32(floor(y));
  let fx = x - floor(x);
  let fy = y - floor(y);
  var F = unpack(word(t.slot, i32(floor(t.lx)), i32(floor(t.ly))));
  let a = unpack(word(t.slot, ix, iy));
  let b = unpack(word(t.slot, ix + 1, iy));
  let c = unpack(word(t.slot, ix, iy + 1));
  let d = unpack(word(t.slot, ix + 1, iy + 1));
  F.temp = mix(mix(a.temp, b.temp, fx), mix(c.temp, d.temp, fx), fy);
  F.rain = mix(mix(a.rain, b.rain, fx), mix(c.rain, d.rain, fx), fy);
  F.tree = mix(mix(a.tree, b.tree, fx), mix(c.tree, d.tree, fx), fy);
  F.shrub = mix(mix(a.shrub, b.shrub, fx), mix(c.shrub, d.shrub, fx), fy);
  F.grass = mix(mix(a.grass, b.grass, fx), mix(c.grass, d.grass, fx), fy);
  F.marsh = mix(mix(a.marsh, b.marsh, fx), mix(c.marsh, d.marsh, fx), fy);
  F.bare = mix(mix(a.bare, b.bare, fx), mix(c.bare, d.bare, fx), fy);
  F.soil = mix(mix(a.soil, b.soil, fx), mix(c.soil, d.soil, fx), fy);
  F.water = mix(mix(a.water, b.water, fx), mix(c.water, d.water, fx), fy);
  return F;
}
// the stream cells round a place: how much of a stream lies there (the bilinear of the cells that carry one: a ridge along it, one cell either side)
// and the largest flow of them in m3/s; the cells' flow is the byte 16 log2(1 + q)
fn riverRidge(t: Tl, qc: f32) -> vec2f {
  let x = t.lx - 0.5;
  let y = t.ly - 0.5;
  let ix = i32(floor(x));
  let iy = i32(floor(y));
  let fx = x - floor(x);
  let fy = y - floor(y);
  var on = vec4f(0.0);
  var qm = 0.0;
  for (var k = 0; k < 4; k++) {
    let q8 = f32((word(t.slot, ix + (k & 1), iy + (k >> 1u)).z >> 8u) & 255u);
    if (q8 >= qc && q8 > 0.0) { on[k] = 1.0; qm = max(qm, exp2(q8 / 16.0) - 1.0); }
  }
  return vec2f(mix(mix(on.x, on.y, fx), mix(on.z, on.w, fx), fy), qm);
}

// ---------- the ground sample from the tier's cells (the readers of ground.wgsl.js GSample for the planet) ----------
var<private> gTl: Tl;      // the tier's tile at the pixel
var<private> gH: f32;      // its cells' B-spline height there, m
var<private> gGl: f32;     // and slope, m a m
var<private> gSc: f32;     // metres of ground to a metre of the noise's frame here
var<private> gCm: f32;     // metres of the noise's frame to a cell of the tier
var<private> gF: Fv;       // the cells' fields at the pixel
var<private> gRShore: f32; // how far inside a stream the pixel lies, noise metres
fn fillTop(S: ptr<function, GSample>, x: f32, z: f32) {
  gF = fieldsAt(gTl);
  (*S).wet = select(0.0, 1.0, gH < 0.0 || gF.water >= 0.25);
  (*S).river = 0.0;
  if ((*S).wet > 0.5) { return; }
  // a stream is a line as wide as its flow makes it, as a pixel's share of it where that is under the pixel: the cells that carry one give a ridge, cut where its width
  // is the line's, and the pixels left of a line thinner than 0.7 pixel are dithered out
  let mpp = gMpp / gSc;
  let qc = 16.0 * log2(1.0 + 0.5 * u.cut);
  let rr = riverRidge(gTl, qc);
  if (rr.y <= 0.0) { return; }
  let w = WIDE * sqrt(rr.y) / gSc;
  let wEff = max(w, 0.7 * mpp);
  let tau = 1.0 - clamp(wEff / (2.0 * gCm), 0.0, 1.0);
  let show = clamp(w / (0.7 * mpp), 0.0, 1.0) * g_smooth(0.5, 1.0, rr.y / u.cut);
  if (rr.x > tau && bayer(gX, gY) < show) {
    (*S).river = 1.0;
    gRShore = (rr.x - tau) / max(1.0 - tau, 1e-3) * wEff * 0.5;
  }
}
fn fillWater(S: ptr<function, GSample>, x: f32, z: f32, ctx: PaintCtx, river: bool) {
  (*S).bed = false;
  (*S).ice = false;
  if (river) {
    (*S).kind = 3u;
    (*S).depth = 1.5;
    (*S).shore = gRShore;
    return;
  }
  let sea = gH < 0.5;
  (*S).kind = select(2u, 1u, sea);
  let depth = select(gF.water, max(0.0, -gH), sea);
  (*S).depth = depth;
  // a lake's edge is a gentle one, as the island's lakes
  let gl = select(0.05, gGl, sea);
  (*S).shore = select(60.0, depth / gl, gl > 1e-4) / gSc;
}
fn fillLand(S: ptr<function, GSample>, x: f32, z: f32, wx: f32, wz: f32, X: i32, Y: i32, ctx: PaintCtx, mpp: f32) {
  // the covers where the biome edges wander to, in cells
  var t = gTl;
  t.lx += (wx - x) / gCm;
  t.ly += (wz - z) / gCm;
  let F = fieldsAt(t);
  gF = F;
  (*S).c[0] = F.grass;
  (*S).c[1] = F.tree;
  (*S).c[2] = F.shrub;
  (*S).c[3] = F.marsh;
  (*S).c[4] = F.bare;
  // meltwater sand is the painter's sand
  (*S).c[5] = select(0.0, 0.8, F.drift == 3u);
  (*S).soil = F.soil;
  // a cell averages the ground it holds, so the slope that is a cliff at the light grid's 12.5 m (the island's critical slope, 1.25) is gentler the larger the cell: it falls as the root of the cell's size
  let cliff = 1.25 * sqrt(12.5 / max(gCm * gSc, 12.5));
  (*S).rockS = max(g_smooth(3200.0, 4800.0, gH) * g_smooth(0.5 * cliff, cliff, gGl), g_smooth(0.8 * cliff, 1.3 * cliff, gGl));
  (*S).s = 0.0;
  (*S).snowNow = g_smooth(-6.0, -16.0, F.temp);
  (*S).season = ctx.season;
  (*S).trail = false;
}
fn fillColour(S: ptr<function, GSample>) {
  let F = gF;
  // the painter's lushness from the rain over the potential evapotranspiration (Holdridge's, 58.93 times the biotemperature, the year's air clipped to 0 to 30 C: the planet
  // carries the year's mean only [design])
  (*S).pet = max(58.93 * clamp(F.temp, 0.0, 30.0), 120.0);
  (*S).precip = F.rain;
  (*S).table = 1000.0;
  (*S).peat = select(0.0, 1.0, F.drift == 4u);
  (*S).silt = 0.0;
  (*S).fog = 0.0;
  (*S).ex = 0.0;
  (*S).rock = i32(F.rock);
}

// ---------- space: the air's rim in the palette's blue ramp, dithered ----------
fn spaceIdx(rd: vec3f, b: f32) -> u32 {
  let o = u.T + u.off;
  let oo = dot(o, o);
  // rays that look away from the planet keep the rim's glow and lose it by their angle above the horizon, so a camera near the
  // ground has its sky and no hard edge where the ray stops meeting the planet
  let d = select(sqrt(max(oo - b * b, 1.0)), sqrt(oo), b > 0.0);
  // an art pixel in radii at the limb, so the rim is never thinner than two of them
  let px = u.art * 2.0 * u.tanH / u.size.y * sqrt(max(oo - 1.0, 1e-6));
  var glow = exp(-(d - 1.0) / max(0.012, 2.0 * px));
  if (b > 0.0) { glow *= exp(-asin(min(b / sqrt(oo), 1.0)) / 0.05); }
  let lit = max(0.25, dot(normalize(select(o + rd * -b, o, b > 0.0)), u.sun) * 0.5 + 0.5);
  return g_AIR[g_dithIndex(glow * lit * 6.5, gX, gY, 7)];
}

// ---------- the noise's frame: metres on the face of the camera's target, the equiangular map of it, its origin the target ----------
// A point's offset d from the target in radii (small near it, so nothing cancels): the face's gnomonic tangents of the target and of the point differ by dua, dvb, and the
// metres along the equiangular axes are the radius times the arc between them, so the ground's noise stays fixed on the ground as the camera moves on the face.
fn noiseXZ(d: vec3f) -> vec2f {
  let fT = u.tf.x;
  let Nf = FACE_N[fT];
  let tn = dot(u.T, Nf);
  let tx = dot(u.T, FACE_X[fT]);
  let ty = dot(u.T, FACE_Y[fT]);
  let w = max(tn + dot(d, Nf), 0.05);
  let dua = (dot(d, FACE_X[fT]) * tn - tx * dot(d, Nf)) / (tn * w);
  let dvb = (dot(d, FACE_Y[fT]) * tn - ty * dot(d, Nf)) / (tn * w);
  let uaT = u.nt.x;
  let vbT = u.nt.y;
  return vec2f(u.radiusM * atan(dua / (1.0 + (uaT + dua) * uaT)) + u.nt.z, u.radiusM * atan(dvb / (1.0 + (vbT + dvb) * vbT)) + u.nt.w);
}

// ---------- the relief: land stands exag times its height above the unit sphere, and the ray marches that shell ----------
// |T + w| - 1 for a camera-relative step w, with no cancellation however near the ground the camera is
fn radial(w: vec3f) -> f32 {
  let s = 2.0 * dot(u.T, w) + dot(w, w);
  return s / (1.0 + sqrt(max(1.0 + s, 0.0)));
}
var<private> gMarch: u32;
// the surface's height above the sphere, in radii, under unit point p: the sea is the sphere
fn lift(p: vec3f) -> f32 {
  let c = faceOf(p);
  let t = tileAt(c.f, c.fx, c.fy, gMarch);
  if (t.slot == NONE) { return 0.0; }
  return max(hBil(t), 0.0) * u.exag / u.radiusM;
}
fn below(t: f32, rd: vec3f) -> bool {
  let w = u.off + t * rd;
  return radial(w) <= lift(normalize(u.T + w));
}

struct Out {
  @location(0) color: vec4f,
  @builtin(frag_depth) depth: f32,
}
fn depthOf(z: f32) -> f32 { return clamp((z - u.zNear) / (u.zFar - u.zNear), 0.0, 1.0); }

@fragment fn fs(@builtin(position) pos: vec4f) -> Out {
  let a = u.art;
  gX = i32(floor(pos.x));
  gY = i32(floor(pos.y));
  let at = (vec2f(f32(gX), f32(gY)) + 0.5) * a;
  let ndc = vec2f(at.x / u.size.x * 2.0 - 1.0, 1.0 - at.y / u.size.y * 2.0);
  let rd = normalize(u.fwd + ndc.x * u.tanH * u.aspect * u.right + ndc.y * u.tanH * u.up);
  let o = u.T + u.off;
  let b = dot(o, rd);
  // the shell between the sphere and the highest relief; c is |o|^2 - r^2 in the small numbers
  let s0 = 2.0 * dot(u.T, u.off) + dot(u.off, u.off);
  let c1 = s0 - u.hmaxR * (2.0 + u.hmaxR);
  let d1 = b * b - c1;
  var o_: Out;
  o_.depth = 1.0;
  if (d1 < 0.0 || (b > 0.0 && c1 > 0.0)) { o_.color = vec4f(PAL[spaceIdx(rd, b)], 1.0); return o_; }
  let tOut = -b + sqrt(d1);
  let tIn = max(c1 / tOut, 0.0);
  let d0 = b * b - s0;
  let sea = d0 >= 0.0 && b < 0.0;
  var tEnd = tOut;
  if (sea) { tEnd = s0 / (-b + sqrt(d0)); }
  // the relief is marched at the tier of the entry's pixel, never finer than the whole view has tiles for
  gMarch = min(tierFor(a * 2.0 * u.tanH / u.size.y * max(tIn, 1e-6) * u.radiusM), u32(ceil(u.cf.x)));
  // steps: one per 2.5 art pixels the shell's path covers on the screen, at least 2
  let pxPerR = u.size.y / (2.0 * u.tanH * max(tIn, 1e-6)) / a;
  let reach = (tEnd - tIn) * length(cross(rd, normalize(u.T + u.off + tIn * rd))) * pxPerR;
  let n = clamp(i32(ceil(reach / 2.5)) + 2, 2, 40);
  var tHit = tEnd;
  var hit = sea;
  var tp = tIn;
  for (var k = 1; k <= n; k++) {
    let t = mix(tIn, tEnd, f32(k) / f32(n));
    if (below(t, rd)) {
      var lo = tp;
      var hi = t;
      for (var j = 0; j < 6; j++) {
        let m = 0.5 * (lo + hi);
        if (below(m, rd)) { hi = m; } else { lo = m; }
      }
      tHit = hi;
      hit = true;
      break;
    }
    tp = t;
  }
  if (!hit) { o_.color = vec4f(PAL[spaceIdx(rd, b)], 1.0); return o_; }
  let p = normalize(u.T + u.off + tHit * rd);
  gMpp = a * 2.0 * u.tanH / u.size.y * tHit * u.radiusM;
  o_.depth = depthOf(tHit * dot(rd, u.fwd));

  let fc = faceOf(p);
  let f = fc.f;
  // one level of detail on the whole screen: the pixel's level as a fraction, held to the finest level every tile the view reads is held at (u.cf.x, which the page eases up
  // as they arrive), the tier below and the tier above it told apart by the art pixel's dither, so that a zoom, or a finer tier arriving, cross-fades the whole picture at once
  let lv = min(levelFor(gMpp), u.cf.x);
  let want = min(u32(floor(lv)) + select(0u, 1u, bayer(gX, gY) < lv - floor(lv)), TIERS - 1u);
  let tl = tileAt(f, fc.fx, fc.fy, want);
  var idx: u32;
  // the camera's light, flat ground at the view's middle unchanged
  let sd = dot(p, u.sun);
  gForm = 0.0;
  var facing = sd;
  var slopeFacing = sd;
  if (tl.slot == NONE) {
    // no tile of the planet here (a face that is not baked): the deep sea
    idx = ${u("w0")};
  } else {
    let hd = heightSpline(tl);
    let h = hd.x;
    // the surface's tangents along the face's coordinates, in metres a cell, and from them the slope as a vector
    let n3 = FACE_N[f];
    let ex = FACE_X[f];
    let ey = FACE_Y[f];
    let ql = length(n3 + fc.ua * ex + fc.vb * ey);
    let da = (PI / 2.0) / tl.cells;
    let kx = (1.0 + fc.ua * fc.ua) * (ex - p * dot(p, ex)) / ql;
    let ky = (1.0 + fc.vb * fc.vb) * (ey - p * dot(p, ey)) / ql;
    let Tx = u.radiusM * da * kx;
    let Ty = u.radiusM * da * ky;
    let E = dot(Tx, Tx);
    let F2 = dot(Tx, Ty);
    let G2 = dot(Ty, Ty);
    let det = max(E * G2 - F2 * F2, 1e-6);
    let grad = ((G2 * hd.y - F2 * hd.z) * Tx + (E * hd.z - F2 * hd.y) * Ty) / det;
    // the island's light from the upper left, northwest on the planet, as the bake's lightOf: LIGHT 4.4 times the drawn
    // relief, signed, dark faces a little softer, in the palette's tone steps
    let north = normalize(vec3f(0.0, 0.0, 1.0) - p * p.z + vec3f(1e-5, 0.0, 0.0));
    let east = normalize(cross(north, p));
    let toSun = normalize(north - east);
    // the ladder's shade pass lights a slope by the sun on its normal (the row of the light tables) and picks a brighter tone only for a slope that faces it more than flat ground does: here the tone is the bake's light from the upper left, never darker than flat ground
    var sl = clamp(-4.4 * u.relief * dot(grad, toSun), 0.0, 2.0);
    slopeFacing = dot(normalize(p - u.relief * grad), u.sun);
    // the painter's sample: the cells at the pixel, in the metres of the noise's frame (the equiangular map stretches a metre of ground by sc here)
    gSc = sqrt(length(kx) * length(ky));
    gCm = u.radiusM * da;
    gH = h;
    gGl = length(grad);
    gTl = tl;
    let mppN = gMpp / gSc;
    let xz = noiseXZ(u.off + tHit * rd);
    var ctx: PaintCtx;
    ctx.k = 1.0 / mppN;
    ctx.frame = u32(u.cf.y);
    ctx.season = u32(u.cf.z);
    ctx.flags = 0u;
    var S: GSample;
    fillTop(&S, xz.x, xz.y);
    idx = g_paint(&S, xz.x, xz.y, gX, gY, ctx, mppN);
    if (!S.isWater) { idx = toned(idx, sl + gForm); facing = slopeFacing; }
  }
  // the air's haze toward the limb (seen from a height, not from the ground), each dithered
  let mu = max(dot(p, -rd), 0.0);
  let air = pow(1.0 - mu, 5.0) * 0.9 * u.airK;
  if (bayer(gX, gY) < air) { idx = tables[idx]; }
  if (bayer(gX + 2, gY + 1) < air * air) { idx = tables[idx]; }
  // the light the ground has: the key light's share on flat ground here (the sun's height over this place, the moon's once the sun is down), through the same light tables the ladder's shade
  // pass maps its palette through, so the night side, the terminator and the day side show as the close levels show a night, a dusk and a day
  let key = mix(max(facing, 0.0), max(dot(p, u.moon), 0.04), u.moonMix);
  // the tables' row 0 is the ambient light of the sky where the camera stands: a place with less of it (the night side from a day) shows that much darker
  let ambK = min(1.0, ambOf(sd) / max(u.amb.x, 1e-6));
  let row = u32(min(f32(LEVELS - 1), floor(key * f32(LEVELS - 1) + bayer(gX, gY)))) * 4u;
  o_.color = vec4f(unpack4x8unorm(lutT[row * NC + idx]).rgb * ambK, 1.0);
  return o_;
}
`;
}
