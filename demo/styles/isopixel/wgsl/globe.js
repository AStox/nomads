// The planet layer's picture (planet.js): each art pixel's ray crosses the shell between the unit sphere and the highest
// relief (land stands exag times its height above the sphere, the sea is the sphere) and is marched to the surface, so a
// tilted view shifts a high point on the screen as the ladder's does. The hit is put on its cube face as the grid does
// (src/gpu/globe/grid.ts locateVec: the face whose normal is nearest, then the equiangular coordinates), and the tier-0
// fields are read there from face textures that carry an apron of the neighbouring faces' cells, so no read crosses an
// edge. The height is a cubic B-spline of the cells, so its slope is smooth at any zoom; the climate is bilinear.
//
// The picture is the island's, not a second one (ground.wgsl.js, main.js): every colour is an index into pal.js's one
// palette, the cover is the ground painter's (forest, grass, scrub, bare ground, sand, rock, snow) mixed as g_rgb mixes it
// and put into the palette by the same dithered nearest pair (dqBuild), rock and snow take the painter's ramps, the sea is
// the w ramp by depth with the surf line and the dithered shallows, and light is the bake's: a slope's signed light moves
// each colour along its ramp by the palette's tone steps (pal.js TONE), dithered by the same Bayer matrix. The pass draws
// at an art pixel of `art` device pixels and the canvas shows it by whole pixels, so nothing is smoother than the island.
export function globeWgsl({ FRAMES, FN, APRON, P, RGB, NCOL, TONE_S }) {
  const lit = (v) => { const s = String(Math.fround(v)); return /[.e]/.test(s) ? s : `${s}.0`; };
  const v3 = (a) => `vec3f(${a.map(lit).join(", ")})`;
  const u = (n) => `${P[n]}u`;
  const ramp = (...n) => `array<u32, ${n.length}>(${n.map(u).join(", ")})`;
  const rgb = (c) => v3(c.map((x) => x / 255));
  const c255 = (c) => v3(c);
  return /* wgsl */ `
var<private> FACE_N: array<vec3f, 6> = array(${FRAMES.map((f) => v3(f.n)).join(", ")});
var<private> FACE_X: array<vec3f, 6> = array(${FRAMES.map((f) => v3(f.ex)).join(", ")});
var<private> FACE_Y: array<vec3f, 6> = array(${FRAMES.map((f) => v3(f.ey)).join(", ")});

const NC = ${NCOL}u;
const PAL = array<vec3f, ${NCOL}>(${RGB.map((c) => rgb(c)).join(", ")});
// the palette's tables (pal.js): HAZE and SHADOW, one index each, then TONE's rows, one per slope light in TONE_S
const T_SHADOW = NC;
const T_TONE = 2u * NC;
const TONE_LO = ${lit(TONE_S[0])};
const TONE_HI = ${lit(TONE_S[TONE_S.length - 1])};
const TONE_N = ${lit(TONE_S.length - 1)};
const g_BAYER = array<f32, 16>(${[0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((v) => lit((v + 0.5) / 16)).join(", ")});
const g_WA = ${ramp("w0", "w1", "w2", "w3", "w4", "w5", "w6", "w7")};
const g_ICE = ${ramp("w6", "haze", "snow")};
const g_RK = ${ramp("r0", "r1", "r2", "r3", "r4", "r5")};
const g_DI = ${ramp("d0", "d1", "d2", "d3", "d4", "d5")};
const g_SA = ${ramp("d3", "s0", "s1", "s2", "s3")};
const g_AIR = ${ramp("ink", "w0", "w1", "w2", "w3", "w4", "w5")};
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
}
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var heightT: texture_2d_array<f32>; // m, r32float
@group(0) @binding(2) var climT: texture_2d_array<f32>;   // the year's air at the ground, rain, ice, rock class (globe.js climTexel)
@group(0) @binding(3) var samp: sampler;
@group(0) @binding(4) var<storage, read> tables: array<u32>;
@group(0) @binding(5) var<storage, read> dqT: array<u32>; // ground.wgsl.js dqBuild
@group(0) @binding(6) var fineT: texture_2d_array<f32>;   // heights at a quarter cell, filtered (fineWgsl)
@group(0) @binding(7) var<storage, read> segs: array<vec4f>; // the rivers: a point and its flow, then the receiver's point, per segment, strongest first
@group(0) @binding(8) var artT: texture_2d<f32>;          // the picture at an art pixel, for the blit that shows it by whole pixels
const RIVER_SUB = ${RIVER_SUB}u;
const RIVER_CORNER = array<u32, 6>(0u, 1u, 2u, 2u, 1u, 3u);
const g_RIV = ${ramp("w5", "w4", "w3")};

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
var<private> gQ: vec3f;  // the surface point in metres from the centre
var<private> gForm: f32; // the planet's form light in tone steps, 0 where the island's flat ground is
var<private> gSun: vec3f; // the unit vector toward the light along the ground, northwest

fn bayer(x: i32, y: i32) -> f32 { return g_BAYER[((y & 3) << 2u) | (x & 3)]; }
fn hu(x: i32, y: i32, s: i32) -> u32 {
  var h = bitcast<u32>(x * 374761393 + y * 668265263 + s * 1442695041);
  h = (h ^ (h >> 13u)) * 1274126177u;
  return h ^ (h >> 16u);
}
fn hf(x: i32, y: i32, s: i32) -> f32 { return f32(hu(x, y, s) >> 8u) * (1.0 / 16777216.0); }
fn sm(a: f32, b: f32, v: f32) -> f32 { let t = clamp((v - a) / (b - a), 0.0, 1.0); return t * t * (3.0 - 2.0 * t); }
fn fade(s: f32, mpp: f32) -> f32 { return 1.0 - sm(s * 0.45, s * 1.4, mpp); }
fn toneIndex(v: f32, n: i32) -> i32 { return clamp(i32(floor(v + 0.5 + (bayer(gX, gY) - 0.5) * 0.55)), 0, n - 1); }
fn dithIndex(v: f32, n: i32) -> i32 { return clamp(i32(floor(v + bayer(gX, gY))), 0, n - 1); }

// ---------- flora.ts noise, on the sphere: value noise on a lattice of metres ----------
fn h3(i: vec3i, s: u32) -> f32 {
  var h = bitcast<u32>(i.x) * 374761393u + bitcast<u32>(i.y) * 668265263u + bitcast<u32>(i.z) * 2246822519u + s * 3266489917u;
  h = (h ^ (h >> 13u)) * 1274126177u;
  h = h ^ (h >> 16u);
  return f32(h >> 8u) * (1.0 / 16777216.0);
}
fn vn(q: vec3f, s: u32) -> f32 {
  let i = vec3i(floor(q));
  let f = fract(q);
  let w = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  let a = mix(mix(h3(i, s), h3(i + vec3i(1, 0, 0), s), w.x), mix(h3(i + vec3i(0, 1, 0), s), h3(i + vec3i(1, 1, 0), s), w.x), w.y);
  let b = mix(mix(h3(i + vec3i(0, 0, 1), s), h3(i + vec3i(1, 0, 1), s), w.x), mix(h3(i + vec3i(0, 1, 1), s), h3(i + vec3i(1, 1, 1), s), w.x), w.y);
  return 2.0 * mix(a, b, w.z) - 1.0;
}
fn fbm3(q: vec3f, s: u32) -> f32 { return vn(q, s) * 0.5 + vn(q * 2.03, s + 31u) * 0.25; }

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

${splineWgsl({ FN, APRON })}
// the cube face under a unit point, and the equiangular coordinates in it, in cells (src/gpu/globe/grid.ts locateVec)
struct FaceAt { f: i32, sx: f32, sy: f32, ua: f32, vb: f32 }
fn faceOf(p: vec3f) -> FaceAt {
  var f = 0;
  var best = dot(p, FACE_N[0]);
  for (var k = 1; k < 6; k++) { let d = dot(p, FACE_N[k]); if (d > best) { best = d; f = k; } }
  let ua = dot(p, FACE_X[f]) / best;
  let vb = dot(p, FACE_Y[f]) / best;
  return FaceAt(f, (atan(ua) / (PI / 2.0) + 0.5) * FN, (atan(vb) / (PI / 2.0) + 0.5) * FN, ua, vb);
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
fn seaIdx(h: f32, gl: f32, ice: f32) -> u32 {
  let depth = -h;
  let px = depth / max(gl, 1e-6) / gMpp;
  if (px < 0.9) { return ${u("w7")}; }
  if (px < 1.5 && hu(gX, gY, 45) < ${Math.ceil(0.45 * 2 ** 32)}u) { return ${u("w6")}; }
  // a few pixels of turquoise along the shore as the island's, then the shelf, which ends at about 130 m [design: Kennett's
  // median shelf break, shown by the shelf's gentler tone], then the slope down to the abyss
  let near = 1.0 - sm(1.2, 4.0, px);
  let shelf = 1.0 - sm(30.0, 200.0, depth);
  let swell = vn(gQ / 90000.0, 41u) * 0.5 + vn(gQ / 14000.0, 42u) * 0.3 * fade(14000.0, gMpp) + vn(gQ / 2500.0, 43u) * 0.3 * fade(2500.0, gMpp);
  let open = mix(0.7, 2.4, 1.0 - sm(250.0, 4500.0, depth));
  let v = mix(mix(open, 3.2, shelf), 4.9, near) + swell * 0.45 * (1.0 - 0.7 * near) + gForm;
  // pack ice, floes of the ice ramp thickening toward the pole's cap (ground.wgsl.js g_ICE)
  if (ice > 0.4) {
    let iv = 0.6 + min(ice, 12.0) * 0.14 + swell * 0.3 + gForm * 0.5;
    return g_ICE[toneIndex(iv, 3)];
  }
  return g_WA[toneIndex(v, 8)];
}

// ---------- the land (ground.wgsl.js g_land, g_rgb, g_rock) ----------
// h m, gl the slope (m a m), tC the year's air, rain mm, ice m, rk the rock class, sl0 the slope's light in tone steps
fn landIdx(h: f32, gl: f32, tC0: f32, rain0: f32, ice: f32, rk: i32, sl0: f32) -> u32 {
  let mpp = gMpp;
  let q = gQ;
  // biome edges wander, as the island's do
  let w1 = fbm3(q / 60000.0, 11u);
  let w2 = fbm3(q / 9000.0, 12u) * fade(9000.0, mpp);
  let w3 = vn(q / 1500.0, 13u) * fade(1500.0, mpp);
  let w4 = vn(q / 200.0, 14u) * fade(200.0, mpp);
  let w5 = vn(q / 600.0, 15u) * fade(600.0, mpp);
  let tC = tC0 + w1 * 1.5 + w2;
  let rain = max(0.0, rain0 * (1.0 + 0.3 * w1 + 0.25 * w2 + 0.15 * w3));
  // Holdridge's potential evapotranspiration, 58.93 times the biotemperature (the year's air clipped to 0 to 30 C, the
  // annual mean standing for the months) [design: the planet carries the year's mean only]; the painter's balance
  // (rain less pet over pet) is lushness, and Koppen-Geiger's BW (rain under 5 Pth, Pth = 2 T + 14 mm, Peel 2007) is desert
  let pet = 58.93 * clamp(tC, 0.0, 30.0);
  let bal = (rain - pet) / max(pet, 120.0);
  let pth = max(10.0, 2.0 * tC + 14.0);
  let desert = 1.0 - sm(4.0 * pth, 6.0 * pth, rain);
  let cold = sm(2.0, -4.0, tC); // above the tree line at a mean of about -1 C [design]
  let lush = sm(-0.3, 0.3, bal);
  let tr = sm(0.0, 0.5, bal) * (1.0 - cold) * (1.0 - desert);
  let sh = (1.0 - desert) * (1.0 - tr) * min(1.0, cold * 0.8 + (1.0 - sm(-0.6, -0.25, bal)) * 0.5);
  let gr = (1.0 - desert) * (1.0 - tr) * (1.0 - sh);
  // hot desert is sand, and the shore is a strip of it a pixel or two wide on low ground, as the island's is
  let toWater = h / max(gl, 1e-6) / mpp;
  let beach = (1.0 - sm(0.0, 1.8, toWater)) * (1.0 - sm(4.0, 20.0, h));
  let sa = max(desert * sm(6.0, 16.0, tC), beach * 0.9);
  let ba = desert * (1.0 - sa) + cold * (1.0 - desert) * 0.3;
  let snowS = max(sm(-6.0, -16.0, tC), sm(0.0, 30.0, ice));
  var rockC = ${c255([146, 136, 116])};
  if (rk >= 0 && rk < 5) { rockC = BARE_ROCK[rk]; }
  var grass: vec3f;
  if (lush > 0.5) { grass = mixc(${c255([98, 126, 60])}, ${c255([56, 96, 48])}, (lush - 0.5) * 2.0); } else { grass = mixc(${c255([160, 150, 90])}, ${c255([98, 126, 60])}, lush * 2.0); }
  let bare = mixc(${c255([146, 136, 116])}, rockC, 0.45);
  let heath = ${c255([112, 86, 96])};
  var sum = gr + tr + sh + ba;
  if (sum <= 0.0) { sum = 1.0; }
  let c = (tr * ${c255([38, 68, 44])} + sh * heath + gr * grass + ba * bare) / sum;
  // mottle at every scale the pixel can show, and the canopy's grain
  let mot = w1 * 0.04 + w2 * 0.06 + w3 * 0.08 + w5 * 0.08 + w4 * 0.08 + (hf(gX, gY, 17) - 0.5) * (0.07 + 0.4 * tr);
  var L0 = c.x * 0.3 + c.y * 0.59 + c.z * 0.11;
  if (L0 <= 0.0) { L0 = 1.0; }
  let band = 112.0 * (1.0 + (L0 / 112.0 - 1.0) * 0.18) * mix(1.0, 0.7, tr / max(sum, 1e-3));
  var idx = dq(c * ((1.0 + mot) * band / L0));
  // hillshade the data lacks below its 12 km cells: ridges and gullies of a few km and some hundred m, as steep as the
  // slope there already is and nowhere flat [design: invented relief, scaled by the cell's own ruggedness]
  let rug = sm(0.004, 0.04, gl);
  let d3 = (fbm3((q + gSun * 500.0) / 3000.0, 51u) - fbm3(q / 3000.0, 51u)) * fade(3000.0, mpp);
  let d6 = (vn((q + gSun * 100.0) / 600.0, 52u) - vn(q / 600.0, 52u)) * fade(600.0, mpp);
  let sl = sl0 - rug * 1.6 * (d3 + d6);
  // bare ground is the island's soil ramp, lighter on pale rock and darker on dark; above the tree line it is rock's
  let soilPix = ba / sum + (bayer(gX, gY) - 0.5) * 0.3 > 0.5;
  if (soilPix) {
    let lum = rockC.x * 0.3 + rockC.y * 0.59 + rockC.z * 0.11;
    let v = (lum - 140.0) / 45.0 + w2 * 0.5 + w3 * 0.5 + w5 * 0.5 + (hf(gX, gY, 20) - 0.5) * 0.4;
    if (cold + (bayer(gX + 1, gY + 2) - 0.5) * 0.4 > 0.5) { idx = g_RK[toneIndex(2.4 + v * 0.7, 6)]; } else { idx = g_DI[toneIndex(2.6 + v, 6)]; }
  }
  // sand takes the island's sand ramp, rippled
  let sandPix = sa + (bayer(gX, gY) - 0.5) * 0.3 + w4 * 0.1 > 0.5;
  if (sandPix) { idx = g_SA[toneIndex(2.3 + w2 * 0.5 + w3 * 0.5 + w5 * 0.5 + (hf(gX, gY, 18) - 0.5) * 0.5, 5)]; }
  // past the critical slope bare rock, on the range's high ground too
  let rockS = max(sm(3200.0, 4800.0, h) * sm(0.03, 0.12, gl), sm(0.12, 0.28, gl)) + (w3 * 0.25 + w4 * 0.15);
  let face = (floor(fbm3(q / 30000.0, 27u) * 1.4 + 0.5) * 0.5) + 0.9;
  let hard = rockS + (bayer(gX, gY) - 0.5) * 0.3 > 0.5;
  if (hard) { idx = g_RK[toneIndex(2.6 + face * 1.3 + vn(q / 3000.0, 28u) * 0.7 * fade(3000.0, mpp) + (hf(gX, gY, 29) - 0.5) * 0.8, 6)]; }
  // snow in solid shapes with a dithered edge
  if (snowS > 0.03) {
    let snowV = fbm3(q / 20000.0, 30u) + snowS * 3.0 - 0.6 + w4 * 0.05;
    if (snowV > 0.04) { idx = ${u("snow")}; }
    else if (snowV > -0.02 && bayer(gX, gY) < (snowV + 0.02) / 0.06) { idx = ${u("snow")}; }
  }
  // standing ice: the ice ramp, white where thick and blue-grey at the thin edge and in the crevasses
  if (ice > 1.0) {
    let iv = 0.8 + 0.8 * sm(2.0, 80.0, ice) + w2 * 0.8 + w3 * 0.6 + w5 * 0.5 + (hf(gX, gY, 19) - 0.5) * 0.4;
    idx = g_ICE[toneIndex(iv, 3)];
  }
  return toned(idx, sl + gForm);
}

// ---------- the relief: land stands exag times its height above the unit sphere, and the ray marches that shell ----------
// |T + w| - 1 for a camera-relative step w, with no cancellation however near the ground the camera is
fn radial(w: vec3f) -> f32 {
  let s = 2.0 * dot(u.T, w) + dot(w, w);
  return s / (1.0 + sqrt(max(1.0 + s, 0.0)));
}
// the fine height field (the cells' B-spline at a quarter cell, filtered): m
fn fineH(p: vec3f) -> f32 {
  let c = faceOf(p);
  return textureSampleLevel(fineT, samp, vec2f((c.sx + APRON) / SIDE, (c.sy + APRON) / SIDE), c.f, 0.0).r;
}
// the surface's height above the sphere, in radii, under unit point p: the sea is the sphere
fn lift(p: vec3f) -> f32 { return max(fineH(p), 0.0) * u.exag / u.radiusM; }
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
  gQ = p * u.radiusM;
  gMpp = a * 2.0 * u.tanH / u.size.y * tHit * u.radiusM;
  o_.depth = depthOf(tHit * dot(rd, u.fwd));

  let fc = faceOf(p);
  let f = fc.f;
  let n3 = FACE_N[f];
  let ex = FACE_X[f];
  let ey = FACE_Y[f];
  let ua = fc.ua;
  let vb = fc.vb;
  let sx = fc.sx;
  let sy = fc.sy;

  // the surface's tangents along the face's coordinates, in metres a cell, and from them the slope as a vector
  let hd = heightAt(f, sx, sy);
  let h = hd.x;
  let ql = length(n3 + ua * ex + vb * ey);
  let da = (PI / 2.0) / FN;
  let Tx = u.radiusM * da * (1.0 + ua * ua) * (ex - p * dot(p, ex)) / ql;
  let Ty = u.radiusM * da * (1.0 + vb * vb) * (ey - p * dot(p, ey)) / ql;
  let E = dot(Tx, Tx);
  let F = dot(Tx, Ty);
  let G = dot(Ty, Ty);
  let det = max(E * G - F * F, 1e-6);
  let grad = ((G * hd.y - F * hd.z) * Tx + (E * hd.z - F * hd.y) * Ty) / det;
  let gl = length(grad);

  // the island's light from the upper left, northwest on the planet, as the bake's lightOf: LIGHT 4.4 times the drawn
  // relief, signed, dark faces a little softer, in the palette's tone steps [design: relief 1.7 times the island's 1.5,
  // since a 12 km cell's slopes are the island's smoothed]
  let north = normalize(vec3f(0.0, 0.0, 1.0) - p * p.z + vec3f(1e-5, 0.0, 0.0));
  let east = normalize(cross(north, p));
  let toSun = normalize(north - east);
  gSun = toSun;
  var sl = -4.4 * u.relief * dot(grad, toSun);
  sl = clamp(select(sl, sl * 0.6, sl < 0.0), -1.3, 2.0);
  // the sphere's own form: the camera's light, flat ground at the view's middle unchanged
  let sd = dot(p, u.sun);
  gForm = clamp(1.7 * (sd - 0.7), -2.6, 0.7);

  let uv = vec2f((sx + APRON) / SIDE, (sy + APRON) / SIDE);
  let c = textureSampleLevel(climT, samp, uv, f, 0.0);
  let tC = (c.r * 255.0 - 128.0) * 0.5;
  let rain = exp2(c.g * 255.0 / 16.0) - 1.0;
  let ice = pow(c.b * 255.0 / 4.0, 2.0);
  let rk = i32(floor(textureLoad(climT, vec2i(vec2f(sx + APRON, sy + APRON)), f, 0).a * 255.0 + 0.5));

  var idx: u32;
  if (h < 0.0) { idx = seaIdx(h, gl, ice); } else { idx = landIdx(h, gl, tC, rain, ice, rk, sl); }
  // past the terminator the night's shadow tones, then the air's haze toward the limb (seen from a height, not from the
  // ground), each dithered
  let night = sm(0.0, -0.5, sd);
  if (bayer(gX, gY) < night) { idx = tables[T_SHADOW + idx]; }
  let mu = max(dot(p, -rd), 0.0);
  let air = pow(1.0 - mu, 5.0) * 0.9 * u.airK;
  if (bayer(gX, gY) < air) { idx = tables[idx]; }
  if (bayer(gX + 2, gY + 1) < air * air) { idx = tables[idx]; }
  o_.color = vec4f(PAL[idx], 1.0);
  return o_;
}

// ---------- the rivers: art pixel lines on the island's water ramp, the surface they lie on hiding them ----------
struct RV {
  @builtin(position) pos: vec4f,
  @location(0) @interpolate(flat) a: vec2f, // the line's ends, in art pixels
  @location(1) @interpolate(flat) b: vec2f,
  @location(2) @interpolate(flat) wc: vec2f, // the ramp's step: 0 to 2, which is the width less one and the colour
}
// a unit point lifted to the surface, on the screen in art pixels, with its depth along the view in radii and 1 if it is in front
fn rscreen(p: vec3f) -> vec4f {
  let n = normalize(p);
  let v = n * (1.0 + lift(n)) - (u.T + u.off);
  let z = dot(v, u.fwd);
  let x = dot(v, u.right) / (z * u.tanH * u.aspect);
  let y = dot(v, u.up) / (z * u.tanH);
  return vec4f((x * 0.5 + 0.5) * u.size.x / u.art, (0.5 - y * 0.5) * u.size.y / u.art, z, select(0.0, 1.0, z > 1e-6));
}
@vertex fn rvs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> RV {
  let seg = ii / RIVER_SUB;
  let piece = ii % RIVER_SUB;
  let A = segs[2u * seg];
  let B = segs[2u * seg + 1u];
  let pa = rscreen(mix(A.xyz, B.xyz, f32(piece) / f32(RIVER_SUB)));
  let pb = rscreen(mix(A.xyz, B.xyz, f32(piece + 1u) / f32(RIVER_SUB)));
  var r: RV;
  r.pos = vec4f(2.0, 2.0, 2.0, 1.0);
  if (pa.w < 0.5 || pb.w < 0.5) { return r; }
  let step = u32(clamp(floor(log2(A.w / u.cut) * 0.5), 0.0, 2.0));
  let width = f32(step + 1u);
  let d = pb.xy - pa.xy;
  let len = length(d);
  var dir = vec2f(1.0, 0.0);
  if (len > 1e-4) { dir = d / len; }
  let perp = vec2f(-dir.y, dir.x);
  let half = width * 0.5 + 1.5;
  let corner = RIVER_CORNER[vi];
  let atB = (corner & 1u) == 1u;
  let side = select(-1.0, 1.0, (corner >> 1u) == 1u);
  let base = select(pa, pb, atB);
  let xy = base.xy + dir * half * select(-1.0, 1.0, atB) + perp * half * side;
  // a few art pixels toward the camera, more where the ground leans from the view, so a river never z-fights its own ground
  let zc = select(pa.z, pb.z, atB);
  let bias = 6.0 * u.art * 2.0 * u.tanH / u.size.y * zc;
  r.pos = vec4f(xy.x / u.aw * 2.0 - 1.0, 1.0 - xy.y / u.ah * 2.0, depthOf(zc - bias), 1.0);
  r.a = pa.xy;
  r.b = pb.xy;
  r.wc = vec2f(width, f32(step));
  return r;
}
@fragment fn rfs(in: RV) -> @location(0) vec4f {
  let ax = i32(floor(in.pos.x));
  let ay = i32(floor(in.pos.y));
  let t = i32(in.wc.x);
  let lo = t >> 1u;
  let hi = t - 1 - lo;
  let A = vec2i(floor(in.a));
  let B = vec2i(floor(in.b));
  let d = B - A;
  let mx = abs(d.x) >= abs(d.y);
  // the line's cells run one a step of the major axis, the brush t wide on both axes, as Bresenham's line is laid
  let cm = select(ay, ax, mx);
  let cn = select(ax, ay, mx);
  let am = select(A.y, A.x, mx);
  let an = select(A.x, A.y, mx);
  let bm = select(B.y, B.x, mx);
  let bn = select(B.x, B.y, mx);
  let dm = bm - am;
  let dn = bn - an;
  var hitc = false;
  for (var x = cm - hi; x <= cm + lo; x++) {
    if (x < min(am, bm) || x > max(am, bm)) { continue; }
    var row = an;
    if (dm != 0) { row = an + i32(floor(f32((x - am) * dn) / f32(dm) + 0.5)); }
    let off = cn - row;
    if (off >= -lo && off <= hi) { hitc = true; }
  }
  if (!hitc) { discard; }
  let k = u32(in.wc.y);
  return vec4f(PAL[g_RIV[k]], 1.0);
}
`;
}

// the cells' height as a cubic B-spline, one place for the fine map's build and the picture's own reading
export function splineWgsl({ FN, APRON }) {
  return /* wgsl */ `
const PI = 3.14159265358979;
const FN = ${FN.toFixed(1)};
const APRON = ${APRON.toFixed(1)};
const SIDE = ${(FN + 2 * APRON).toFixed(1)};
// the cubic B-spline's weights for the taps at -1, 0, 1, 2 of a fraction t, and their derivatives
fn bs(t: f32) -> vec4f {
  let s = 1.0 - t;
  return vec4f(s * s * s, 3.0 * t * t * t - 6.0 * t * t + 4.0, -3.0 * t * t * t + 3.0 * t * t + 3.0 * t + 1.0, t * t * t) / 6.0;
}
fn dbs(t: f32) -> vec4f {
  let s = 1.0 - t;
  return vec4f(-s * s, 3.0 * t * t - 4.0 * t, -3.0 * t * t + 2.0 * t + 1.0, t * t) * 0.5;
}
// the height at face coordinates (sx, sy) in cells, and its slope along each, m a cell
fn heightAt(f: i32, sx: f32, sy: f32) -> vec3f {
  let tx = sx + APRON - 0.5;
  let ty = sy + APRON - 0.5;
  let ix = i32(floor(tx));
  let iy = i32(floor(ty));
  let wx = bs(tx - floor(tx));
  let wy = bs(ty - floor(ty));
  let dx = dbs(tx - floor(tx));
  let dy = dbs(ty - floor(ty));
  var r = vec3f(0.0);
  for (var j = 0; j < 4; j++) {
    for (var i = 0; i < 4; i++) {
      let at = clamp(vec2i(ix - 1 + i, iy - 1 + j), vec2i(0), vec2i(i32(SIDE) - 1));
      let h = textureLoad(heightT, at, f, 0).r;
      r += h * vec3f(wx[i] * wy[j], dx[i] * wy[j], wx[i] * dy[j]);
    }
  }
  return r;
}
`;
}

// the fine height map: the spline above sampled SS times a cell, stored half precision so one filtered read gives the
// relief march a smooth surface
export function fineWgsl({ FN, APRON, SS }) {
  return /* wgsl */ `
@group(0) @binding(0) var heightT: texture_2d_array<f32>;
@group(0) @binding(1) var fineW: texture_storage_2d_array<rgba16float, write>;
${splineWgsl({ FN, APRON })}
const SS = ${SS.toFixed(1)};
@compute @workgroup_size(8, 8, 1) fn main(@builtin(global_invocation_id) id: vec3u) {
  let n = u32(SS * SIDE);
  if (id.x >= n || id.y >= n) { return; }
  let sx = (f32(id.x) + 0.5) / SS - APRON;
  let sy = (f32(id.y) + 0.5) / SS - APRON;
  textureStore(fineW, vec2i(id.xy), i32(id.z), vec4f(heightAt(i32(id.z), sx, sy).x, 0.0, 0.0, 0.0));
}
`;
}

// pieces a river segment is cut into, so its line follows the relief it lies on
export const RIVER_SUB = 8;
