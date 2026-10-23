// The planet layer's picture (planet.js): each art pixel's ray crosses the shell between the unit sphere and the highest relief (land
// stands exag times its height above the sphere, the sea is the sphere) and is marched to the surface, so a tilted view shifts a high
// point on the screen as the ladder's does. The hit is put on its cube face as the grid does (src/gpu/globe/grid.ts locateVec: the
// face whose normal is nearest, then the equiangular coordinates) and the planet's own 75 m ground is read there from the tile
// pyramid (pyramid.js): the tier whose cells are about an art pixel across, or the finest coarser one that has arrived, so the finer
// replaces the coarser as it comes. Nothing is made up below the cells: the height is a cubic B-spline of them (smooth slope at any
// zoom), the cover, soil, rock, drift, air, rain, lakes and rivers are what the tile holds.
//
// The picture is the island's, not a second one (ground.wgsl.js, main.js): every colour is an index into pal.js's one palette, the
// cover is the ground painter's (tree, shrub, grass, marsh, bare ground, sand, rock, snow) mixed as g_rgb mixes it and put into the
// palette by the same dithered nearest pair (dqBuild), rock and snow take the painter's ramps, the sea is the w ramp by depth with
// the surf line and the dithered shallows, and light is the bake's: a slope's signed light moves each colour along its ramp by the
// palette's tone steps (pal.js TONE), dithered by the same Bayer matrix. The pass draws at an art pixel of `art` device pixels and the
// canvas shows it by whole pixels, so nothing is smoother than the island.
export function globeWgsl({ FRAMES, P, RGB, NCOL, TONE_S, offsets, LEVELS }) {
  const lit = (v) => { const s = String(Math.fround(v)); return /[.e]/.test(s) ? s : `${s}.0`; };
  const v3 = (a) => `vec3f(${a.map(lit).join(", ")})`;
  const u = (n) => `${P[n]}u`;
  const ramp = (...n) => `array<u32, ${n.length}>(${n.map(u).join(", ")})`;
  const rgb = (c) => v3(c.map((x) => x / 255));
  const c255 = (c) => v3(c);
  const tiers = offsets.length - 1;
  return /* wgsl */ `
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
const g_BAYER = array<f32, 16>(${[0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((v) => lit((v + 0.5) / 16)).join(", ")});
const g_WA = ${ramp("w0", "w1", "w2", "w3", "w4", "w5", "w6", "w7")};
const g_RK = ${ramp("r0", "r1", "r2", "r3", "r4", "r5")};
const g_DI = ${ramp("d0", "d1", "d2", "d3", "d4", "d5")};
const g_SA = ${ramp("d3", "s0", "s1", "s2", "s3")};
const g_AIR = ${ramp("ink", "w0", "w1", "w2", "w3", "w4", "w5")};
const g_RIV = ${ramp("w5", "w4", "w3")};
// the rock classes' bare ground (ground.wgsl.js g_BARE_ROCK)
const BARE_ROCK = array<vec3f, 5>(${[[118, 104, 92], [176, 140, 96], [204, 196, 176], [164, 144, 138], [92, 88, 84]].map(c255).join(", ")});

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
}
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var fieldsT: texture_2d_array<u32>;  // a tile's cells, 16 bytes each (pyramid.js)
@group(0) @binding(2) var heightT: texture_2d_array<f32>;  // a tile's heights in m with a halo of 2 cells
@group(0) @binding(3) var<storage, read> table: array<u32>; // each tile's atlas layer, or NONE
@group(0) @binding(4) var<storage, read> tables: array<u32>;
@group(0) @binding(5) var<storage, read> dqT: array<u32>; // ground.wgsl.js dqBuild
@group(0) @binding(6) var<storage, read> lutT: array<u32>; // the sky's light tables the ladder's shade pass maps its palette through (webgpu.js LUT0 on): LEVELS key light steps by the fire's 4 levels, NC colours each
@group(0) @binding(8) var artT: texture_2d<f32>;          // the picture at an art pixel, for the blit that shows it by whole pixels

@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  return vec4f(p * 2.0 - 1.0, 0.0, 1.0);
}
// the art-pixel picture shown by whole pixels, nearest
@fragment fn bfs(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let at = min(vec2i(floor(pos.xy / u.art)), vec2i(i32(u.aw) - 1, i32(u.ah) - 1));
  return textureLoad(artT, at, 0);
}

// ---------- px.js: the art pixel's dither and hash ----------
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

fn bayer(x: i32, y: i32) -> f32 { return g_BAYER[((y & 3) << 2u) | (x & 3)]; }
fn hu(x: i32, y: i32, s: i32) -> u32 {
  var h = bitcast<u32>(x * 374761393 + y * 668265263 + s * 1442695041);
  h = (h ^ (h >> 13u)) * 1274126177u;
  return h ^ (h >> 16u);
}
fn hf(x: i32, y: i32, s: i32) -> f32 { return f32(hu(x, y, s) >> 8u) * (1.0 / 16777216.0); }
fn sm(a: f32, b: f32, v: f32) -> f32 { let t = clamp((v - a) / (b - a), 0.0, 1.0); return t * t * (3.0 - 2.0 * t); }
fn toneIndex(v: f32, n: i32) -> i32 { return clamp(i32(floor(v + 0.5 + (bayer(gX, gY) - 0.5) * 0.55)), 0, n - 1); }
fn dithIndex(v: f32, n: i32) -> i32 { return clamp(i32(floor(v + bayer(gX, gY))), 0, n - 1); }

// the nearest pair of palette colours to a colour (0 to 255), dithered by how far along the pair it lies
fn dq(c: vec3f) -> u32 {
  let r = clamp(i32(c.x) >> 3u, 0, 31);
  let g = clamp(i32(c.y) >> 3u, 0, 31);
  let b = clamp(i32(c.z) >> 3u, 0, 31);
  let e = dqT[(r << 10u) | (g << 5u) | b];
  return select(e & 255u, (e >> 8u) & 255u, bayer(gX, gY) * 255.0 < f32(e >> 16u));
}
// colour c under a slope light s, as the shade pass lights the ground: the palette's tone rows, dithered
fn toned(c: u32, s: f32) -> u32 {
  let j = u32(clamp(floor((s - TONE_LO) / (TONE_HI - TONE_LO) * TONE_N + 0.5 + (bayer(gX, gY) - 0.5) * 0.55), 0.0, TONE_N));
  return tables[T_TONE + j * NC + c];
}
fn mixc(a: vec3f, b: vec3f, t: f32) -> vec3f { return a + (b - a) * clamp(t, 0.0, 1.0); }

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
// the tier whose cells are at most an art pixel across (the cell at a face's middle is the largest, the mean about 0.8 of it)
fn tierFor(mpp: f32) -> u32 {
  let c0 = u.radiusM * (PI / 2.0) / 256.0 * 0.8;
  return u32(clamp(ceil(log2(c0 / max(mpp, 1e-3))), 0.0, f32(TIERS - 1u)));
}
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
  return g_AIR[dithIndex(glow * lit * 6.5, 7)];
}

// ---------- the sea (ground.wgsl.js g_water): the w ramp by depth, the surf, the shallows dithered ----------
fn seaIdx(depth: f32, gl: f32) -> u32 {
  let px = depth / max(gl, 1e-6) / gMpp;
  if (px < 0.9) { return ${u("w7")}; }
  if (px < 1.5 && hu(gX, gY, 45) < ${Math.ceil(0.45 * 2 ** 32)}u) { return ${u("w6")}; }
  // a few pixels of turquoise along the shore as the island's, then the shelf, which ends at about 130 m [design: Kennett's
  // median shelf break, shown by the shelf's gentler tone], then the slope down to the abyss
  let near = 1.0 - sm(1.2, 4.0, px);
  let shelf = 1.0 - sm(30.0, 200.0, depth);
  let open = mix(0.7, 2.4, 1.0 - sm(250.0, 4500.0, depth));
  let v = mix(mix(open, 3.2, shelf), 4.9, near) + gForm;
  return g_WA[toneIndex(v, 8)];
}

// ---------- the land (ground.wgsl.js g_rgb, g_rock, g_soil) ----------
// h m, gl the slope (m a m), F the cell's fields, sl the slope's light in tone steps
fn landIdx(h: f32, gl: f32, F: Fv, sl0: f32) -> u32 {
  let tC = F.temp;
  // the painter's lushness: the rain over the potential evapotranspiration (Holdridge's, 58.93 times the biotemperature, the
  // year's air clipped to 0 to 30 C: the planet carries the year's mean only [design])
  let pet = 58.93 * clamp(tC, 0.0, 30.0);
  let bal = (F.rain - pet) / max(pet, 120.0);
  let lush = sm(-0.3, 0.3, bal);
  let cold = sm(2.0, -4.0, tC);
  var rockC = ${c255([146, 136, 116])};
  if (F.rock < 5u) { rockC = BARE_ROCK[F.rock]; }
  var grass: vec3f;
  if (lush > 0.5) { grass = mixc(${c255([98, 126, 60])}, ${c255([56, 96, 48])}, (lush - 0.5) * 2.0); } else { grass = mixc(${c255([160, 150, 90])}, ${c255([98, 126, 60])}, lush * 2.0); }
  let peat = select(0.0, 1.0, F.drift == 4u);
  let marsh = mixc(${c255([74, 94, 56])}, ${c255([48, 50, 38])}, peat);
  let bare = mixc(mixc(${c255([146, 136, 116])}, rockC, 0.45), ${c255([126, 98, 70])}, sm(0.3, 1.5, F.soil) * 0.6);
  let heath = ${c255([112, 86, 96])};
  let tr = F.tree;
  let sh = F.shrub;
  let ma = F.marsh;
  let gr = F.grass;
  let ba = F.bare;
  var sum = gr + tr + sh + ma + ba;
  if (sum <= 0.0) { sum = 1.0; }
  // meltwater sand is the painter's sand
  let sa = select(0.0, 0.8, F.drift == 3u);
  var c = (tr * ${c255([38, 68, 44])} + sh * heath + gr * grass + ma * marsh + ba * bare) / sum;
  c = mixc(c, ${c255([220, 202, 150])}, sa * 1.4);
  let snowS = sm(-6.0, -16.0, tC);
  var L0 = c.x * 0.3 + c.y * 0.59 + c.z * 0.11;
  if (L0 <= 0.0) { L0 = 1.0; }
  // the canopy's grain
  let mot = (hf(gX, gY, 17) - 0.5) * (0.07 + 0.4 * tr / sum);
  let band = 112.0 * (1.0 + (L0 / 112.0 - 1.0) * 0.18) * mix(1.0, 0.7, tr / sum);
  var idx = dq(c * ((1.0 + mot) * band / L0));
  // bare ground is the island's soil ramp, lighter on pale rock and darker on dark; above the tree line it is rock's
  let soilPix = ba / sum + (bayer(gX, gY) - 0.5) * 0.3 > 0.5;
  if (soilPix) {
    let lum = rockC.x * 0.3 + rockC.y * 0.59 + rockC.z * 0.11;
    let v = (lum - 140.0) / 45.0 + (hf(gX, gY, 20) - 0.5) * 0.4;
    if (cold + (bayer(gX + 1, gY + 2) - 0.5) * 0.4 > 0.5) { idx = g_RK[toneIndex(2.4 + v * 0.7, 6)]; } else { idx = g_DI[toneIndex(2.6 + v, 6)]; }
  }
  // sand takes the island's sand ramp
  if (sa + (bayer(gX, gY) - 0.5) * 0.3 > 0.5) { idx = g_SA[toneIndex(2.3 + (hf(gX, gY, 18) - 0.5) * 0.5, 5)]; }
  // past the critical slope bare rock, on the range's high ground too
  let rockS = max(sm(3200.0, 4800.0, h) * sm(0.03, 0.12, gl), sm(0.12, 0.28, gl));
  if (rockS + (bayer(gX, gY) - 0.5) * 0.3 > 0.5) { idx = g_RK[toneIndex(2.6 + (0.9 + 0.25 * f32(F.rock)) * 1.3 + (hf(gX, gY, 29) - 0.5) * 0.8, 6)]; }
  // snow in solid shapes with a dithered edge
  if (snowS > 0.03) {
    let snowV = snowS * 3.0 - 0.6;
    if (snowV > 0.04) { idx = ${u("snow")}; }
    else if (snowV > -0.02 && bayer(gX, gY) < (snowV + 0.02) / 0.06) { idx = ${u("snow")}; }
  }
  return toned(idx, sl0 + gForm);
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
  gMarch = tierFor(a * 2.0 * u.tanH / u.size.y * max(tIn, 1e-6) * u.radiusM);
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
  let tl = tileAt(f, fc.fx, fc.fy, tierFor(gMpp));
  var idx: u32;
  var gl = 0.0;
  // the camera's light, flat ground at the view's middle unchanged
  let sd = dot(p, u.sun);
  gForm = 0.0;
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
    let Tx = u.radiusM * da * (1.0 + fc.ua * fc.ua) * (ex - p * dot(p, ex)) / ql;
    let Ty = u.radiusM * da * (1.0 + fc.vb * fc.vb) * (ey - p * dot(p, ey)) / ql;
    let E = dot(Tx, Tx);
    let F2 = dot(Tx, Ty);
    let G2 = dot(Ty, Ty);
    let det = max(E * G2 - F2 * F2, 1e-6);
    let grad = ((G2 * hd.y - F2 * hd.z) * Tx + (E * hd.z - F2 * hd.y) * Ty) / det;
    gl = length(grad);
    // the island's light from the upper left, northwest on the planet, as the bake's lightOf: LIGHT 4.4 times the drawn
    // relief, signed, dark faces a little softer, in the palette's tone steps
    let north = normalize(vec3f(0.0, 0.0, 1.0) - p * p.z + vec3f(1e-5, 0.0, 0.0));
    let east = normalize(cross(north, p));
    let toSun = normalize(north - east);
    var sl = -4.4 * u.relief * dot(grad, toSun);
    sl = clamp(select(sl, sl * 0.6, sl < 0.0), -1.3, 2.0);
    let F = fieldsAt(tl);
    if (h < 0.0) { idx = seaIdx(-h, gl); }
    else if (F.water >= 0.25) { idx = seaIdx(F.water, 0.05); }
    else {
      idx = landIdx(h, gl, F, sl);
      // a river's cell, from the tier a cell or two an art pixel across so it is a line on the screen at any zoom
      let tr = tileAt(f, fc.fx, fc.fy, max(tierFor(gMpp), 1u) - 1u);
      if (tr.slot != NONE) {
        let q = f32((word(tr.slot, i32(floor(tr.lx)), i32(floor(tr.ly))).z >> 8u) & 255u);
        let qc = 16.0 * log2(1.0 + u.cut);
        if (q >= qc && q > 0.0) { idx = g_RIV[u32(clamp(floor((q - qc) / 32.0), 0.0, 2.0))]; }
      }
    }
  }
  // the air's haze toward the limb (seen from a height, not from the ground), each dithered
  let mu = max(dot(p, -rd), 0.0);
  let air = pow(1.0 - mu, 5.0) * 0.9 * u.airK;
  if (bayer(gX, gY) < air) { idx = tables[idx]; }
  if (bayer(gX + 2, gY + 1) < air * air) { idx = tables[idx]; }
  // the light the ground has: the key light's share on flat ground here (the sun's height over this place, the moon's once the sun is down), through the same light tables the ladder's shade
  // pass maps its palette through, so the night side, the terminator and the day side show as the close levels show a night, a dusk and a day
  let key = mix(max(sd, 0.0), max(dot(p, u.moon), 0.04), u.moonMix);
  // the tables' row 0 is the ambient light of the sky where the camera stands: a place with less of it (the night side from a day) shows that much darker
  let ambK = min(1.0, ambOf(sd) / max(u.amb.x, 1e-6));
  let row = u32(min(f32(LEVELS - 1), floor(key * f32(LEVELS - 1) + bayer(gX, gY)))) * 4u;
  o_.color = vec4f(unpack4x8unorm(lutT[row * NC + idx]).rgb * ambK, 1.0);
  return o_;
}
`;

}
