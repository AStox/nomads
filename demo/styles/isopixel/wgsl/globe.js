// The globe's one pass (play/globe.js): each pixel's ray meets the unit sphere, the hit is put on its cube face as the grid
// does (src/gpu/globe/grid.ts locateVec: the face whose normal is nearest, then the equiangular coordinates), and the tier-0
// fields are read there from face textures that carry an apron of the neighbouring faces' cells, so no read crosses an
// edge. The height is a cubic B-spline of the cells, so its slope, and with it the hillshade, is smooth at any zoom; the
// climate is bilinear. Colours are a picture's [design]: ocean by depth, land by the year's rain and warmth, rock showing
// on high ground, ice white.
export function globeWgsl({ FRAMES, FN, APRON }) {
  const v3 = (a) => `vec3f(${a.map((x) => x.toFixed(1)).join(", ")})`;
  const side = FN + 2 * APRON;
  return /* wgsl */ `
const PI = 3.14159265358979;
const FN = ${FN.toFixed(1)};
const APRON = ${APRON.toFixed(1)};
const SIDE = ${side.toFixed(1)};
var<private> FACE_N: array<vec3f, 6> = array(${FRAMES.map((f) => v3(f.n)).join(", ")});
var<private> FACE_X: array<vec3f, 6> = array(${FRAMES.map((f) => v3(f.ex)).join(", ")});
var<private> FACE_Y: array<vec3f, 6> = array(${FRAMES.map((f) => v3(f.ey)).join(", ")});

struct U {
  o: vec3f, alt: f32,       // the camera, in radii from the centre, and its height above the sphere in radii
  fwd: vec3f, tanH: f32,    // where it looks, and the tangent of half the vertical field of view
  right: vec3f, aspect: f32,
  up: vec3f, exag: f32,     // the relief's exaggeration for the shading
  sun: vec3f, radiusM: f32,
  size: vec2f, pad: vec2f,
}
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var heightT: texture_2d_array<f32>; // m, r32float
@group(0) @binding(2) var climT: texture_2d_array<f32>;   // the year's air at the ground, rain, ice, river (globe.js climTexel)
@group(0) @binding(3) var rockT: texture_2d_array<f32>;   // the colour of the rock at the surface
@group(0) @binding(4) var samp: sampler;

@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  return vec4f(p * 2.0 - 1.0, 0.0, 1.0);
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

fn sky(rd: vec3f, b: f32) -> vec3f {
  let bg = vec3f(0.051, 0.043, 0.078);
  if (b > 0.0) { return bg; }
  let d = sqrt(max(dot(u.o, u.o) - b * b, 1.0));
  let glow = exp(-(d - 1.0) / 0.012);
  return bg + vec3f(0.35, 0.55, 0.95) * glow * 0.7 * max(0.2, dot(normalize(u.o + rd * -b), u.sun) * 0.5 + 0.5);
}

@fragment fn fs(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let ndc = vec2f(pos.x / u.size.x * 2.0 - 1.0, 1.0 - pos.y / u.size.y * 2.0);
  let rd = normalize(u.fwd + ndc.x * u.tanH * u.aspect * u.right + ndc.y * u.tanH * u.up);
  let b = dot(u.o, rd);
  let disc = b * b - u.alt * (2.0 + u.alt);
  if (disc < 0.0) { return vec4f(sky(rd, b), 1.0); }
  let t = -b - sqrt(disc);
  if (t < 0.0) { return vec4f(sky(rd, b), 1.0); }
  let p = normalize(u.o + t * rd);

  var f = 0;
  var best = dot(p, FACE_N[0]);
  for (var k = 1; k < 6; k++) { let d = dot(p, FACE_N[k]); if (d > best) { best = d; f = k; } }
  let n = FACE_N[f];
  let ex = FACE_X[f];
  let ey = FACE_Y[f];
  let ua = dot(p, ex) / best;
  let vb = dot(p, ey) / best;
  let sx = (atan(ua) / (PI / 2.0) + 0.5) * FN;
  let sy = (atan(vb) / (PI / 2.0) + 0.5) * FN;

  // the surface's normal: the sphere's tangents along the face's coordinates, a cell long, raised by the relief
  let hd = heightAt(f, sx, sy);
  let h = hd.x;
  let ql = length(n + ua * ex + vb * ey);
  let da = (PI / 2.0) / FN;
  let tx = da * (1.0 + ua * ua) * (ex - p * dot(p, ex)) / ql;
  let ty = da * (1.0 + vb * vb) * (ey - p * dot(p, ey)) / ql;
  let k = select(u.exag, u.exag * 0.4, h < 0.0);
  var nn = normalize(cross(u.radiusM * tx + p * k * hd.y, u.radiusM * ty + p * k * hd.z));
  if (dot(nn, p) < 0.0) { nn = -nn; }

  let uv = vec2f((sx + APRON) / SIDE, (sy + APRON) / SIDE);
  let c = textureSampleLevel(climT, samp, uv, f, 0.0);
  let tC = (c.r * 255.0 - 128.0) * 0.5;
  let rain = exp2(c.g * 255.0 / 16.0) - 1.0;
  let ice = pow(c.b * 255.0 / 4.0, 2.0);
  let rock = textureSampleLevel(rockT, samp, uv, f, 0.0).rgb;

  let lit = max(dot(nn, u.sun), 0.0);
  var col: vec3f;
  if (h < 0.0) {
    let deep = smoothstep(0.0, 4500.0, -h);
    col = mix(vec3f(0.24, 0.55, 0.62), vec3f(0.04, 0.12, 0.27), sqrt(deep));
    col *= 0.45 + 0.55 * lit;
    col += vec3f(0.5) * pow(max(dot(reflect(rd, p), u.sun), 0.0), 60.0) * 0.35;
    col = mix(col, vec3f(0.92, 0.95, 1.0), smoothstep(0.0, 30.0, ice));
  } else {
    let wet = smoothstep(150.0, 1600.0, rain);
    let warm = smoothstep(-12.0, 22.0, tC);
    let dry = mix(vec3f(0.55, 0.53, 0.45), vec3f(0.84, 0.73, 0.52), warm);
    let green = mix(vec3f(0.20, 0.32, 0.22), vec3f(0.16, 0.42, 0.17), warm);
    var land = mix(dry, green, wet);
    land = mix(land, vec3f(0.56, 0.56, 0.50), smoothstep(-2.0, -14.0, tC) * 0.8);
    land = mix(land, rock, smoothstep(2500.0, 4500.0, h) * 0.55);
    land = mix(land, vec3f(0.94, 0.96, 0.99), smoothstep(0.0, 30.0, ice));
    // the coast a shade lighter, where the B-spline's height crosses the sea
    land = mix(vec3f(0.78, 0.74, 0.58), land, smoothstep(0.0, 60.0, h));
    col = land * (0.25 + 0.85 * lit);
  }
  // the air's haze toward the limb
  let mu = max(dot(p, -rd), 0.0);
  col = mix(col, vec3f(0.45, 0.62, 0.92), pow(1.0 - mu, 5.0) * 0.55);
  return vec4f(col, 1.0);
}
`;
}
