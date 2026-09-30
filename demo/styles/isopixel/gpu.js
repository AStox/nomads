// The renderer's GPU half. Baked chunks go up once as textures and stay, so a frame costs the CPU only what moves:
// live.js draws people, animals, fire, smoke and labels into the 32 px tiles they touch and sends those up as an atlas.
// A still view draws each chunk 1:1 into the art-pixel buffer, with coarser or finer levels scaled in under chunks
// still baking, lays the tiles over it, and applies the haze and the hour's palette. Between two bearings, or at a
// bearing still baking, every baked pixel goes back into the world by its depth and is splatted as a one-pixel point
// into the view at the bearing shown (live.js warpOf has the maths, the shaders repeat it). Depth tests keep what is in
// front; a pass closes the one-pixel cracks a turn stretches into the ground; the other bearing fills what the turn
// uncovers and, mid-turn, lends its shading through an ordered dither; a few passes grow whatever neither saw from its
// neighbours, ground first. Last the art buffer is scaled to the canvas as present() does it: nearest to the next
// whole factor, then one smoothed step down. Every layer is palette indices, so the pixels stay the art's own.
// The sun is cast here for the hour, as the bake cannot: a map of which ground sees it, traced over the island's heights
// whenever it moves, and every shadow-casting sprite's silhouette laid along it, darken what lies in shadow through the
// palette's own shadow colours in the ordered dither.

const HEAD = "#version 300 es\nprecision highp float;\nprecision highp int;\nprecision highp sampler2D;\nprecision highp usampler2D;\nprecision highp isampler2D;\n";
// live.js packs its tiles this way: TS art px square, TPR to an atlas row
export const TS = 32, TPR = 64;
// The passes that grow into what neither bearing saw, as [mode, step]: ground from its neighbours a pixel away, then
// from ever farther, doubling, so a gap a tree uncovered in a 45 degree turn fills with nearby ground texture in a
// few passes rather than one smeared pixel a pass; last, from anything, so a sprite's own edge can close.
const GROW = [...[1, 1, 1, 1, 2, 2, 4, 4, 8, 8, 16, 32, 64].map((k) => [1, k]), ...[1, 1, 2, 4].map((k) => [2, k])];
// chunk textures kept, and how many a frame may upload or bring to the water's next frame, so no frame stalls on them
const CHUNKS_KEPT = 224, UPLOADS_PER_FRAME = 8, ANIM_PER_FRAME = 8;
// the sun map is traced again once the sun has moved this far (radians), over SUN_STRIPES frames
const SUN_MOVE = 0.004, SUN_STRIPES = 6;

const BAY_GLSL = `
const float BAY[16] = float[16](0.0, 8.0, 2.0, 10.0, 12.0, 4.0, 14.0, 6.0, 3.0, 11.0, 1.0, 9.0, 15.0, 7.0, 13.0, 5.0);
float bay(ivec2 g) { return (BAY[((g.y & 3) << 2) | (g.x & 3)] + 0.5) / 16.0; }`;
// Colour c as the sun leaves it at art px q of a camera: in the shadow the island's ground casts toward the sun (a
// sprite by its anchor's ground), or, for ground, of a sprite's silhouette laid along the sun (uMask), through the
// palette's shadow remap in the ordered dither at the camera's global art px (uSunG its origin). World meters of an art
// px of the camera: uWO + x uWA + (y + depth) uWB. uSunK: how strongly the sun casts, 0 while it is down.
const SUN_GLSL = `
uniform sampler2D uSun, uMask;
uniform usampler2D uShadow;
uniform vec2 uWO, uWA, uWB;
uniform float uSunK, uSunN, uSunStep;
uniform ivec2 uSunG;
uint sunlit(uint c, ivec2 q, float z, uint kind, int ax, float e) {
  if (uSunK <= 0.0 || kind > 2u || z < -1e29) return c;
  vec2 wp = uWO + float(q.x - (kind == 0u ? 0 : ax)) * uWA + (float(q.y) + z - e) * uWB;
  float sh = smoothstep(0.3, 0.7, texture(uSun, ((wp + 4800.0) / uSunStep + 0.5) / uSunN).r);
  ivec2 ms = textureSize(uMask, 0);
  if (kind == 0u && q.x >= 0 && q.y >= 0 && q.x < ms.x && q.y < ms.y) sh = max(sh, texelFetch(uMask, q, 0).r);
  return bay(q + uSunG) < sh * uSunK ? texelFetch(uShadow, ivec2(int(c), 0), 0).r : c;
}`;

// A source pixel into the view: (X, Y) its target pixel, Z its depth (larger is nearer), as warpOf's formulas.
// State: r colour, g ax + 128, b kind (0 ground, 1 baked sprite, 2 live sprite), a light | 128 (0 is empty).
const EMIT = `
uniform float uC1, uHs, uQ1, uZ1, uZs, uE1, uW0, uWf, uCx, uCy, uCz;
uniform vec2 uT;
flat out uvec4 vS;
flat out uint vZ;
void emit(float x, float y, float zz, float e, int ax, uint kind, uint c, uint light) {
  float u = x - float(ax), w, Z;
  if (zz > -1e29) { w = y + zz - e + uW0; Z = zz + uCz + uZ1 * w + uZs * u; }
  // no depth (a coarser level standing in, or open sea): taken as lying at the target's height, behind everything
  else { u = x; ax = 0; kind = 0u; w = uWf + 4.0 * y; Z = -1e29; }
  float X = x + floor(uCx + uC1 * u - uHs * w + 0.5), Y = y + floor(uCy + uHs * u + uQ1 * w + 0.5);
  gl_Position = vec4((X + 0.5) / uT.x * 2.0 - 1.0, (Y + 0.5) / uT.y * 2.0 - 1.0, clamp(Z / 2097152.0, -1.0, 1.0), 1.0);
  gl_PointSize = 1.0;
  vS = uvec4(c, uint(clamp(ax, -128, 127) + 128), kind, light | 128u);
  vZ = floatBitsToUint(Z);
}`;
// a chunk's pixels, in the sun as their own camera sees it, then turned
const VS_CHUNK = `${HEAD}
uniform sampler2D uKz;
uniform usampler2D uKc, uKo;
uniform isampler2D uKa;
uniform ivec2 uOff;
${EMIT}
${BAY_GLSL}
${SUN_GLSL}
void main() {
  ivec2 p = ivec2(gl_VertexID & 255, gl_VertexID >> 8), q = uOff + p;
  bool obj = (texelFetch(uKo, p, 0).r & 1u) != 0u;
  float z = texelFetch(uKz, p, 0).r;
  int ax = obj ? texelFetch(uKa, p, 0).r : 0;
  uint c = sunlit(texelFetch(uKc, p, 0).r, q, z, obj ? 1u : 0u, ax, obj ? uE1 : 0.0);
  emit(float(q.x), float(q.y), z, obj ? uE1 : 0.0, ax, obj ? 1u : 0u, c, 0u);
}`;
// the tiles the CPU drew into, pixel by pixel from the atlas: uList holds each atlas tile's place in the view. Light
// bit 4: where the sun leaves the pixel alone (live.js packTiles).
const VS_DYN = `${HEAD}
uniform sampler2D uZ, uE;
uniform usampler2D uC, uL, uId, uList;
uniform isampler2D uAx;
uniform ivec2 uView;
uniform int uTw;
${EMIT}
${BAY_GLSL}
${SUN_GLSL}
void main() {
  int k = gl_VertexID >> 10, px = gl_VertexID & 31, py = (gl_VertexID >> 5) & 31;
  int t = int(texelFetch(uList, ivec2(k & 63, k >> 6), 0).r);
  ivec2 v = ivec2((t % uTw) * 32 + px, (t / uTw) * 32 + py), a = ivec2((k & 63) * 32 + px, (k >> 6) * 32 + py);
  float zz = texelFetch(uZ, a, 0).r;
  // off the view, or a chunk still baking that the tile only stood in for: nothing, so a lending bearing shows there
  if (v.x >= uView.x || v.y >= uView.y || zz < -2e30) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 1.0; vS = uvec4(0u); vZ = 0u; return; }
  uint id = texelFetch(uId, a, 0).r, kind = min(id, 2u), l = texelFetch(uL, a, 0).r;
  int ax = id == 0u ? 0 : texelFetch(uAx, a, 0).r;
  float e = id == 0u ? 0.0 : id == 1u ? uE1 : texelFetch(uE, ivec2(int(id & 255u), int(id >> 8u)), 0).r;
  emit(float(v.x), float(v.y), zz, e, ax, kind, sunlit(texelFetch(uC, a, 0).r, v, zz, (l & 4u) != 0u ? 3u : kind, ax, e), l & 3u);
}`;
const FS_SPLAT = `${HEAD}
flat in uvec4 vS;
flat in uint vZ;
layout(location = 0) out uvec4 oS;
layout(location = 1) out uvec4 oZ;
void main() { oS = vS; oZ = uvec4(vZ, 0u, 0u, 0u); }`;
const VS_FULL = `${HEAD}
void main() { gl_Position = vec4(float((gl_VertexID << 1) & 2) * 2.0 - 1.0, float(gl_VertexID & 2) * 2.0 - 1.0, 0.0, 1.0); }`;
// uMode 0: a crack, filled pixels either side in a row or a column; 1: any gap, from ground only; 2: from anything.
// Neighbours uStep pixels away.
const FS_FILL = `${HEAD}
uniform usampler2D uS, uZ;
uniform ivec2 uSize;
uniform int uMode, uStep;
layout(location = 0) out uvec4 oS;
layout(location = 1) out uvec4 oZ;
bool filled(ivec2 q) { return q.x >= 0 && q.y >= 0 && q.x < uSize.x && q.y < uSize.y && texelFetch(uS, q, 0).a != 0u && (uMode != 1 || texelFetch(uS, q, 0).b == 0u); }
// ground before sprite, then the farther
bool better(ivec2 a, ivec2 b) {
  uint ka = texelFetch(uS, a, 0).b, kb = texelFetch(uS, b, 0).b;
  return ka < kb || (ka == kb && uintBitsToFloat(texelFetch(uZ, a, 0).r) < uintBitsToFloat(texelFetch(uZ, b, 0).r));
}
void main() {
  ivec2 q = ivec2(gl_FragCoord.xy);
  uvec4 s = texelFetch(uS, q, 0);
  if (s.a != 0u) { oS = s; oZ = texelFetch(uZ, q, 0); return; }
  ivec2 n[4] = ivec2[4](q + ivec2(0, -uStep), q + ivec2(0, uStep), q + ivec2(-uStep, 0), q + ivec2(uStep, 0));
  bool f[4] = bool[4](filled(n[0]), filled(n[1]), filled(n[2]), filled(n[3]));
  int best = -1;
  if (uMode == 0) {
    if (f[2] && f[3]) best = better(n[2], n[3]) ? 2 : 3;
    else if (f[0] && f[1]) best = better(n[0], n[1]) ? 0 : 1;
  } else for (int k = 0; k < 4; k++) if (f[k] && (best < 0 || better(n[k], n[best]))) best = k;
  if (best < 0) { oS = uvec4(0u); oZ = uvec4(0u); return; }
  oS = texelFetch(uS, n[best], 0); oZ = texelFetch(uZ, n[best], 0);
}`;
// The main bearing's pixel stands, the other's colour showing through the dither mask where both show the same
// surface (same kind, a sprite's same column, depth within 4). Where main has only a stand-in without depth, or
// nothing, the other's pixel: its ground, or anything of it when main is at its own bearing (uAny), since main's gaps
// are then chunks still baking rather than ground a turn uncovered behind a sprite.
const FS_COMBINE = `${HEAD}
uniform usampler2D uMS, uMZ, uOS, uOZ;
uniform uint uMask;
uniform int uHaveO, uAny;
layout(location = 0) out uvec4 oS;
layout(location = 1) out uvec4 oZ;
void main() {
  ivec2 q = ivec2(gl_FragCoord.xy);
  uvec4 m = texelFetch(uMS, q, 0), mz = texelFetch(uMZ, q, 0);
  if (uHaveO == 0) { oS = m; oZ = mz; return; }
  uvec4 o = texelFetch(uOS, q, 0), oz = texelFetch(uOZ, q, 0);
  float Mz = uintBitsToFloat(mz.r), Oz = uintBitsToFloat(oz.r);
  bool oReal = o.a != 0u && Oz > -1e28;
  if (m.a != 0u && (Mz > -1e28 || !oReal)) {
    bool other = ((uMask >> uint(((q.y & 3) << 2) | (q.x & 3))) & 1u) != 0u;
    if (other && oReal && m.b <= 1u && o.b == m.b && (m.b == 0u || o.g == m.g) && Mz > -1e28 && abs(Oz - Mz) <= 4.0) oS = uvec4(o.r, m.g, m.b, m.a);
    else oS = m;
    oZ = mz;
    return;
  }
  if (oReal && (o.b == 0u || uAny == 1 || m.a != 0u)) { oS = o; oZ = oz; return; }
  if (m.a != 0u) { oS = m; oZ = mz; return; }
  oS = uvec4(0u); oZ = uvec4(0u);
}`;
const HAZE_GLSL = `
uniform usampler2D uHaze;
uniform float uMost, uTop, uReach;
uniform ivec2 uG0;
uint hazed(uint c, ivec2 q) {
  float a = uMost * pow(max(0.0, 1.0 - (float(q.y) - uTop) / uReach), 1.5);
  return a >= 0.001 && bay(q + uG0) < min(a, uMost) ? texelFetch(uHaze, ivec2(int(c), 0), 0).r : c;
}`;
// A turned view: overlays over the world, the haze toward the top of the canvas, then the palette re-lit for the hour.
const FS_COMPOSITE = `${HEAD}
uniform usampler2D uS, uOvT, uOvC;
uniform sampler2D uLut;
uniform uint uSea;
out vec4 o;
${BAY_GLSL}
${HAZE_GLSL}
void main() {
  ivec2 q = ivec2(gl_FragCoord.xy);
  uvec4 s = texelFetch(uS, q, 0);
  uint c = s.a != 0u ? s.r : uSea, light = s.a != 0u ? (s.a & 3u) : 0u, t = texelFetch(uOvT, q >> 5, 0).r;
  // the overlays' tile where one was drawn, 255 where it is clear
  if (t != 0u) { int k = int(t) - 1; uint ov = texelFetch(uOvC, ivec2((k & 63) << 5, (k >> 6) << 5) + (q & 31), 0).r; if (ov != 255u) c = ov; }
  o = texelFetch(uLut, ivec2(int(hazed(c, q)), int(light)), 0);
}`;
// A still view: the CPU's tile where it drew one, else the static layer; the sun; the overlays; then the haze and the
// hour's palette. A tile copies the baked chunk under what it draws, so the static layer's kind, anchor and depth serve
// for the sun there too. Light bit 4: a flame, which the sun leaves alone; bit 8: another live sprite, lit as what lies
// behind it, but as a sprite (a foot on that ground), so the shadows cast on that ground, its own among them, pass it by.
const FS_FLAT = `${HEAD}
uniform usampler2D uStat, uStatZ, uTiles, uAC, uAL, uOvT, uOvC;
uniform sampler2D uLut;
uniform float uE1;
out vec4 o;
${BAY_GLSL}
${HAZE_GLSL}
${SUN_GLSL}
void main() {
  ivec2 q = ivec2(gl_FragCoord.xy);
  uvec4 s = texelFetch(uStat, q, 0);
  uint t = texelFetch(uTiles, q >> 5, 0).r, c = s.r, light = 0u, kind = s.b;
  float e = kind == 1u ? uE1 : 0.0;
  if (t != 0u) {
    int k = int(t) - 1;
    ivec2 a = ivec2((k & 63) << 5, (k >> 6) << 5) + (q & 31);
    uint l = texelFetch(uAL, a, 0).r;
    c = texelFetch(uAC, a, 0).r; light = l & 3u;
    if ((l & 4u) != 0u) kind = 3u;
    else if ((l & 8u) != 0u && kind == 0u) kind = 1u;
  }
  c = sunlit(c, q, uintBitsToFloat(texelFetch(uStatZ, q, 0).r), kind, int(s.g) - 128, e);
  // the overlays' tile where one was drawn, 255 where it is clear
  uint ot = texelFetch(uOvT, q >> 5, 0).r;
  if (ot != 0u) { int k = int(ot) - 1; uint ov = texelFetch(uOvC, ivec2((k & 63) << 5, (k >> 6) << 5) + (q & 31), 0).r; if (ov != 255u) c = ov; }
  o = texelFetch(uLut, ivec2(int(hazed(c, q)), int(light)), 0);
}`;
// One chunk into the static layer: art px q reads texel floor(uA + q * uS), a chunk of this level at uS 1, a stand-in
// level's scaled as live.js fallback() samples it.
const VS_QUAD = `${HEAD}
uniform vec4 uRect;
uniform vec2 uT;
void main() {
  vec2 p = mix(uRect.xy, uRect.zw, vec2(float(gl_VertexID & 1), float(gl_VertexID >> 1)));
  gl_Position = vec4(p / uT * 2.0 - 1.0, 0.0, 1.0);
}`;
// a chunk of this level keeps its kind (3: none, a stand-in level's), anchor column and depth, for the sun
const FS_STATIC = `${HEAD}
uniform usampler2D uK, uKo;
uniform isampler2D uKa;
uniform sampler2D uKz;
uniform vec2 uA;
uniform float uS;
uniform ivec2 uG;
layout(location = 0) out uvec4 o;
layout(location = 1) out uvec4 oZ;
${BAY_GLSL}
void main() {
  vec2 q = floor(gl_FragCoord.xy);
  ivec2 t;
  if (uS >= 0.75) t = ivec2(floor(uA + q * uS));
  else {
    // blown up: between its texels by the ordered dither at the view's art px (uG its origin), as fallback() does
    vec2 f = uA + (q + 0.5) * uS - 0.5, f0 = floor(f), r = f - f0;
    ivec2 g = ivec2(q) + uG;
    t = ivec2(f0) + ivec2(r.x > bay(g) ? 1 : 0, r.y > bay(g + ivec2(1, 2)) ? 1 : 0);
  }
  if (t.x < 0 || t.y < 0 || t.x >= 256 || t.y >= 256) discard;
  bool own = uS == 1.0;
  o = uvec4(texelFetch(uK, t, 0).r, own ? uint(texelFetch(uKa, t, 0).r + 128) : 128u, own ? texelFetch(uKo, t, 0).r & 1u : 3u, 0u);
  oZ = uvec4(floatBitsToUint(own ? texelFetch(uKz, t, 0).r : -1e30), 0u, 0u, 0u);
}`;
// A shadow-casting row's shadow: k art px above its anchor, it falls k * uVec off the anchor's row as castShadow lays a
// pixel's, here the whole row as the round slab it stands for, flattened 2:1 as the ground shows a circle, and swept on
// to k + 1 so that a low sun's long shadow has no gaps. aP: twice the row's centre column, the anchor's row, the row's
// width and k (px.js shadowRows), a quad round each for the fragments to keep what lies inside.
const VS_SHADE = `${HEAD}
layout(location = 0) in ivec4 aP;
uniform ivec2 uOff;
uniform vec2 uVec, uT;
flat out vec2 vA, vB;
flat out float vR;
void main() {
  vR = float(aP.z) * 0.5 + 0.25;
  vA = vec2(uOff) + vec2(float(aP.x) * 0.5, float(aP.y) + 0.5) + float(aP.w) * uVec;
  vB = vA + uVec;
  vec2 e = vec2(vR + 1.0, vR * 0.5 + 1.0), lo = min(vA, vB) - e, hi = max(vA, vB) + e;
  gl_Position = vec4(mix(lo, hi, vec2(float(gl_VertexID & 1), float(gl_VertexID >> 1))) / uT * 2.0 - 1.0, 0.0, 1.0);
}`;
// inside the swept round: within vR of the segment once the rows are stretched back to the ground's true depth
const FS_SHADE = `${HEAD}
flat in vec2 vA, vB;
flat in float vR;
out vec4 o;
void main() {
  vec2 s = vec2(1.0, 2.0), q = gl_FragCoord.xy * s, a = vA * s, ab = vB * s - a;
  float t = clamp(dot(q - a, ab) / max(dot(ab, ab), 1e-6), 0.0, 1.0);
  if (length(q - a - t * ab) > vR) discard;
  o = vec4(1.0);
}`;
// Which ground sees the sun: from each texel of the island's heights, how far the ground toward the sun rises above
// the ray to it (the drawn, exaggerated heights), softened at the edge as the bake's own shadows were. The heights are
// filtered by the texture unit, one fetch a step.
const FS_SUNMAP = `${HEAD}
uniform sampler2D uH;
uniform float uN, uStep, uExag, uTan;
uniform vec2 uDir;
out vec4 o;
void main() {
  vec2 p = gl_FragCoord.xy;
  float h0 = texture(uH, p / uN).r * uExag, ex = -1e9;
  for (float d = uStep; d < 2400.0; d *= 1.09) ex = max(ex, texture(uH, (p + uDir * (d / uStep)) / uN).r * uExag - (h0 + d * uTan));
  o = vec4(smoothstep(-3.0, 10.0, ex), 0.0, 0.0, 1.0);
}`;
// The art buffer onto the canvas at (uD, scale uSc): nearest at a whole scale, else bilinear between the texels of its
// uN-times nearest upscale, as present() draws with two canvases. A cross-fading level goes over at uAlpha.
const FS_PRESENT = `${HEAD}
uniform sampler2D uArt;
uniform vec2 uD;
uniform float uSc, uN, uCH, uAlpha;
uniform ivec2 uAS;
uniform int uNearest;
uniform vec4 uSea;
out vec4 o;
vec4 art(vec2 k) { return texelFetch(uArt, clamp(ivec2(floor(k / uN)), ivec2(0), uAS - 1), 0); }
void main() {
  vec2 pc = vec2(gl_FragCoord.x, uCH - gl_FragCoord.y), a = (pc - uD) / uSc;
  vec4 c;
  if (a.x < 0.0 || a.y < 0.0 || a.x >= float(uAS.x) || a.y >= float(uAS.y)) { if (uAlpha < 1.0) discard; c = uSea; }
  else if (uNearest == 1) c = texelFetch(uArt, ivec2(floor(a)), 0);
  else {
    vec2 m = (pc - uD) * uN / uSc - 0.5, m0 = floor(m), f = m - m0;
    c = mix(mix(art(m0), art(m0 + vec2(1.0, 0.0)), f.x), mix(art(m0 + vec2(0.0, 1.0)), art(m0 + vec2(1.0, 1.0)), f.x), f.y);
  }
  o = vec4(c.rgb * uAlpha, uAlpha);
}`;

// Throws where WebGL2 is missing (cause "none") or will not build these programs ("build"); live.js then draws on the
// CPU. `why` says what turned it off later, `name` which GPU it runs on.
export function createGPU({ NCOL, HAZE, SHADOW }) {
  const canvas = document.createElement("canvas");
  const gl = canvas.getContext("webgl2", { alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false, preserveDrawingBuffer: false, powerPreference: "high-performance" });
  if (!gl) throw new Error("this browser gives no WebGL2 context", { cause: "none" });
  let lost = false, why = "";
  canvas.addEventListener("webglcontextlost", (e) => { e.preventDefault(); lost = true; why = "the browser took the WebGL2 context away"; });
  // browsers that mask RENDERER give the real one through the debug extension; Firefox warns when that is asked for
  let name = String(gl.getParameter(gl.RENDERER) || "");
  if (/^webkit/i.test(name)) { const dbg = gl.getExtension("WEBGL_debug_renderer_info"); if (dbg) name = String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) || name); }
  const program = (vs, fs) => {
    const p = gl.createProgram();
    for (const [type, src] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]]) {
      const s = gl.createShader(type);
      gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      gl.attachShader(p, s);
    }
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    const locs = new Map();
    p.u = (n) => { let l = locs.get(n); if (l === undefined) locs.set(n, (l = gl.getUniformLocation(p, n))); return l; };
    return p;
  };
  const tex = (fmt, w, h, filter = gl.NEAREST) => {
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texStorage2D(gl.TEXTURE_2D, 1, fmt, w, h);
    for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, filter], [gl.TEXTURE_MAG_FILTER, filter], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
    return t;
  };
  const upload = (t, w, h, fmt, type, data) => { gl.bindTexture(gl.TEXTURE_2D, t); gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, fmt, type, data); };
  const bind = (p, name, unit, t) => { gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, t); gl.uniform1i(p.u(name), unit); };
  const warp = (p, W) => { for (const [n, v] of [["uC1", W.c1], ["uHs", W.hs], ["uQ1", W.q1], ["uZ1", W.z1], ["uZs", W.zs], ["uE1", W.e1], ["uW0", W.w0], ["uWf", W.wf], ["uCx", W.cx], ["uCy", W.cy], ["uCz", W.cz]]) gl.uniform1f(p.u(n), v); };
  const target = (texs, fbs) => {
    const fb = gl.createFramebuffer();
    fbs?.push(fb);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    texs.forEach((t, i) => gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + i, gl.TEXTURE_2D, t, 0));
    gl.drawBuffers(texs.map((_, i) => gl.COLOR_ATTACHMENT0 + i));
    return fb;
  };

  let P;
  try {
    P = {
      chunk: program(VS_CHUNK, FS_SPLAT), dyn: program(VS_DYN, FS_SPLAT), fill: program(VS_FULL, FS_FILL), combine: program(VS_FULL, FS_COMBINE),
      composite: program(VS_FULL, FS_COMPOSITE), flat: program(VS_FULL, FS_FLAT), stat: program(VS_QUAD, FS_STATIC), present: program(VS_FULL, FS_PRESENT),
      shade: program(VS_SHADE, FS_SHADE), sunmap: program(VS_FULL, FS_SUNMAP),
    };
  } catch (e) {
    throw new Error(`WebGL2 would not build the renderer's shaders: ${e.message}`, { cause: "build" });
  }
  // every draw but the shadow casting reads no vertex attributes; that one reads its rows per instance, a chunk's kept
  // with it and the live sprites' streamed each frame
  const mainVao = gl.createVertexArray(), shadeVao = gl.createVertexArray(), liveBuf = gl.createBuffer();
  gl.bindVertexArray(shadeVao);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribDivisor(0, 1);
  gl.bindVertexArray(mainVao);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  const hazeTex = tex(gl.R8UI, NCOL, 1), shadowTex = tex(gl.R8UI, NCOL, 1), lutTex = tex(gl.RGBA8, NCOL, 4), eTex = tex(gl.R32F, 256, 256);
  upload(hazeTex, NCOL, 1, gl.RED_INTEGER, gl.UNSIGNED_BYTE, HAZE);
  upload(shadowTex, NCOL, 1, gl.RED_INTEGER, gl.UNSIGNED_BYTE, SHADOW);
  // the sun map, a lit placeholder until the island's heights arrive
  const lit = tex(gl.R8, 1, 1, gl.LINEAR);
  upload(lit, 1, 1, gl.RED, gl.UNSIGNED_BYTE, new Uint8Array(1));
  let heights = null, job = null, shown = null;

  // buffers sized to the compose slots' capacity; a view uses their top-left corner
  let cap = null;
  function ensure(w, h) {
    if (cap && cap.w === w && cap.h === h) return;
    if (cap) { for (const t of cap.textures) gl.deleteTexture(t); for (const fb of cap.fbs) gl.deleteFramebuffer(fb); gl.deleteRenderbuffer(cap.depth); }
    const textures = [], fbs = [], T = (f, tw = w, th = h) => { const t = tex(f, tw, th); textures.push(t); return t; };
    const depth = gl.createRenderbuffer();
    gl.bindRenderbuffer(gl.RENDERBUFFER, depth);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT32F, w, h);
    const layer = (withDepth) => {
      const s = T(gl.RGBA8UI), z = T(gl.R32UI), fb = target([s, z], fbs);
      if (withDepth) gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depth);
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error("turn layer incomplete");
      return { s, z, fb };
    };
    const art = T(gl.RGBA8), stat = T(gl.RGBA8UI), statZ = T(gl.R32UI);
    const tw = Math.ceil(w / TS), th = Math.ceil(h / TS), rows = Math.ceil((tw * th) / TPR), AW = TS * TPR, AH = TS * rows;
    // a mask per camera a frame casts sprite shadows for: a still view or its cross-fade, a turn's main and two others
    const masks = [0, 1, 2].map(() => T(gl.R8));
    cap = {
      w, h, rows, textures, fbs, depth, art, artFb: target([art], fbs), stat, statZ, statFb: target([stat, statZ], fbs), masks, maskFb: masks.map((m) => target([m], fbs)),
      M: layer(true), O: layer(true), A: layer(false), B: layer(false),
      // a cross-fade's two views each have their own tile planes, so neither is overwritten while the GPU still reads it;
      // and their overlays theirs, as does a turn's in the first
      tiles: [T(gl.R16UI, tw, th), T(gl.R16UI, tw, th)], list: T(gl.R16UI, TPR, rows),
      atlas: [0, 1].map((k) => ({ c: T(gl.R8UI, AW, AH), l: T(gl.R8UI, AW, AH), ...(k === 0 && { id: T(gl.R16UI, AW, AH), ax: T(gl.R16I, AW, AH), z: T(gl.R32F, AW, AH) }) })),
      ov: [0, 1].map(() => ({ index: T(gl.R16UI, tw, th), c: T(gl.R8UI, AW, AH) })),
    };
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  // the chunks, uploaded once and kept while they stay the same bake; the water's frame is written into the colour
  const chunks = new Map(), scratch = new Uint8Array(65536);
  let frameNo = 0, budget = { left: 0, anim: 0 };
  const colours = (ch, fr) => {
    if (!ch.animP.length) return ch.c;
    scratch.set(ch.c);
    const aP = ch.animP, aC = ch.animC;
    for (let i = 0; i < aP.length; i++) scratch[aP[i]] = aC[i * 8 + fr];
    return scratch;
  };
  // true once the chunk is on the GPU; a rebake still waiting for its upload shows the one before
  function chunk(ch, fr) {
    if (lost) return false;
    let k = chunks.get(ch.key);
    if (k && (k.src === ch.c || budget.left <= 0)) {
      k.used = frameNo;
      if (k.src === ch.c && k.fr !== fr && ch.animP.length && budget.anim > 0) { budget.anim--; upload(k.c, 256, 256, gl.RED_INTEGER, gl.UNSIGNED_BYTE, colours(ch, fr)); k.fr = fr; }
      return true;
    }
    if (budget.left <= 0) return false;
    budget.left--;
    if (!k) chunks.set(ch.key, (k = { c: tex(gl.R8UI, 256, 256), o: tex(gl.R8UI, 256, 256), a: tex(gl.R8I, 256, 256), z: tex(gl.R32F, 256, 256) }));
    upload(k.c, 256, 256, gl.RED_INTEGER, gl.UNSIGNED_BYTE, colours(ch, fr));
    upload(k.o, 256, 256, gl.RED_INTEGER, gl.UNSIGNED_BYTE, ch.obj);
    upload(k.a, 256, 256, gl.RED_INTEGER, gl.BYTE, ch.ax);
    upload(k.z, 256, 256, gl.RED, gl.FLOAT, ch.z);
    // the rows that cast shadows, one instance each for castSprites
    k.sn = ch.cast ? ch.cast.length >> 2 : 0;
    if (k.sn) { k.sb ??= gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, k.sb); gl.bufferData(gl.ARRAY_BUFFER, ch.cast, gl.STATIC_DRAW); }
    Object.assign(k, { src: ch.c, fr, used: frameNo });
    stats.uploads++;
    return true;
  }
  function evictChunks() {
    if (chunks.size <= CHUNKS_KEPT) return;
    for (const [key, k] of [...chunks].sort((a, b) => a[1].used - b[1].used).slice(0, chunks.size - CHUNKS_KEPT)) {
      if (k.used === frameNo) break;
      for (const t of [k.c, k.o, k.a, k.z]) gl.deleteTexture(t);
      if (k.sb) gl.deleteBuffer(k.sb);
      chunks.delete(key);
    }
  }

  // The island's heights for the sun map: n x n, texel i at -4800 + i * step meters. Half floats, which filter.
  function setHeights(n, step, h) {
    const ht = tex(gl.R16F, n, n, gl.LINEAR);
    upload(ht, n, n, gl.RED, gl.FLOAT, h);
    const maps = [0, 1].map(() => { const t = tex(gl.R8, n, n, gl.LINEAR); return { t, fb: target([t]) }; });
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    heights = { n, step, ht, maps, front: 0 }; job = shown = null;
  }
  // The map for the sun of a frame (sun: { dir: [x, z] toward it, tan of its elevation, k how strongly it casts, exag }):
  // once it has moved, traced into the back map SUN_STRIPES frames a pass, a stripe of rows each, for the sun as it stood
  // when the pass began, and then swapped to the front; the first is traced whole, so shadows show at once.
  function traceSun(sun) {
    if (!sun || !heights) return;
    const az = Math.atan2(sun.dir[1], sun.dir[0]), el = Math.atan(sun.tan);
    if (!job) {
      if (shown && Math.abs(az - shown.az) < SUN_MOVE && Math.abs(el - shown.el) < SUN_MOVE && sun.exag === shown.exag) return;
      job = { az, el, exag: sun.exag, dir: [sun.dir[0], sun.dir[1]], tan: sun.tan, row: 0 };
    }
    const { n } = heights, rows = shown ? Math.ceil(n / SUN_STRIPES) : n;
    gl.disable(gl.DEPTH_TEST); gl.disable(gl.BLEND);
    gl.useProgram(P.sunmap); gl.bindFramebuffer(gl.FRAMEBUFFER, heights.maps[1 - heights.front].fb); gl.viewport(0, 0, n, n);
    gl.enable(gl.SCISSOR_TEST); gl.scissor(0, job.row, n, rows);
    bind(P.sunmap, "uH", 0, heights.ht);
    gl.uniform1f(P.sunmap.u("uN"), n); gl.uniform1f(P.sunmap.u("uStep"), heights.step); gl.uniform1f(P.sunmap.u("uExag"), job.exag);
    gl.uniform1f(P.sunmap.u("uTan"), job.tan); gl.uniform2f(P.sunmap.u("uDir"), job.dir[0], job.dir[1]);
    full();
    gl.disable(gl.SCISSOR_TEST);
    job.row += rows;
    if (job.row >= n) { heights.front = 1 - heights.front; shown = job; job = null; stats.traces++; }
  }
  // A camera's sprite shadows into mask i: shade { vec, list: [{ key, ox, oy }] }, the shadow step per art px of
  // height, the chunks whose rows can cast into its AW x AH art px, and live: the live sprites' rows, in its art px.
  function castSprites(i, AW, AH, sun, shade) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, cap.maskFb[i]); gl.viewport(0, 0, AW, AH);
    gl.clearBufferfv(gl.COLOR, 0, zeroF4);
    if (!sun || (!shade.list.length && !shade.live)) return;
    gl.useProgram(P.shade);
    gl.bindVertexArray(shadeVao);
    gl.uniform2f(P.shade.u("uVec"), shade.vec[0], shade.vec[1]); gl.uniform2f(P.shade.u("uT"), AW, AH);
    const rows = (buf, n, ox, oy) => {
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.vertexAttribIPointer(0, 4, gl.SHORT, 8, 0);
      gl.uniform2i(P.shade.u("uOff"), ox, oy);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, n);
    };
    for (const s of shade.list) { const k = chunks.get(s.key); if (k?.sn) rows(k.sb, k.sn, s.ox, s.oy); }
    if (shade.live) {
      gl.bindBuffer(gl.ARRAY_BUFFER, liveBuf);
      gl.bufferData(gl.ARRAY_BUFFER, shade.live, gl.STREAM_DRAW);
      rows(liveBuf, shade.live.length >> 2, 0, 0);
    }
    gl.bindVertexArray(mainVao);
  }
  // the sun's uniforms for a program drawing camera `shade` (wo: world meters of its art px) with mask i
  function setSun(p, sun, shade, i, g0, unit) {
    bind(p, "uSun", unit, heights ? heights.maps[heights.front].t : lit); bind(p, "uMask", unit + 1, cap.masks[i]); bind(p, "uShadow", unit + 2, shadowTex);
    gl.uniform1f(p.u("uSunK"), sun && heights ? sun.k : 0);
    gl.uniform1f(p.u("uSunN"), heights?.n ?? 1); gl.uniform1f(p.u("uSunStep"), heights?.step ?? 1);
    const w = shade.wo;
    gl.uniform2f(p.u("uWO"), w[0], w[1]); gl.uniform2f(p.u("uWA"), w[2], w[3]); gl.uniform2f(p.u("uWB"), w[4], w[5]);
    gl.uniform2i(p.u("uSunG"), g0[0], g0[1]);
  }

  let lutKey = null;
  const zero = new Uint32Array(4), zeroF = new Float32Array([0]), zeroF4 = new Float32Array(4), statClear = new Uint32Array([0, 128, 3, 0]);
  const noDepth = new Uint32Array([new Uint32Array(new Float32Array([-1e30]).buffer)[0], 0, 0, 0]);
  const full = () => gl.drawArrays(gl.TRIANGLES, 0, 3);
  function pass(p, dst, TW, TH) { gl.useProgram(p); gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fb); gl.viewport(0, 0, TW, TH); }
  function clearLayer(L, depth) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, L.fb);
    gl.clearBufferuiv(gl.COLOR, 0, zero); gl.clearBufferuiv(gl.COLOR, 1, zero);
    if (depth) gl.clearBufferfv(gl.DEPTH, 0, zeroF);
  }
  function start({ cap: [cw, ch], out, lut, lutKey: lk, sun }) {
    ensure(cw, ch);
    if (canvas.width !== out.W || canvas.height !== out.H) { canvas.width = out.W; canvas.height = out.H; }
    if (lk !== lutKey) { upload(lutTex, NCOL, 4, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(lut.buffer, lut.byteOffset, NCOL * 16)); lutKey = lk; }
    traceSun(sun);
  }
  const setHaze = (p, haze, g0) => {
    bind(p, "uHaze", 7, hazeTex);
    gl.uniform1f(p.u("uMost"), haze.most); gl.uniform1f(p.u("uTop"), haze.top); gl.uniform1f(p.u("uReach"), haze.reach);
    gl.uniform2i(p.u("uG0"), g0[0], g0[1]);
  };
  // the art buffer (AW x AH at the top-left of cap.art) onto the canvas
  function present(out, AW, AH, s, dx, dy, alpha, seaRGB) {
    gl.useProgram(P.present); gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, out.W, out.H);
    if (alpha < 1) { gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA); }
    const n = Math.max(1, Math.ceil(s - 1e-3));
    bind(P.present, "uArt", 0, cap.art);
    gl.uniform2f(P.present.u("uD"), dx, dy); gl.uniform1f(P.present.u("uSc"), s); gl.uniform1f(P.present.u("uN"), n); gl.uniform1f(P.present.u("uCH"), out.H);
    gl.uniform1f(P.present.u("uAlpha"), alpha); gl.uniform4f(P.present.u("uSea"), (seaRGB & 255) / 255, ((seaRGB >> 8) & 255) / 255, ((seaRGB >> 16) & 255) / 255, 1);
    gl.uniform2i(P.present.u("uAS"), AW, AH); gl.uniform1i(P.present.u("uNearest"), Math.abs(s - n) < 1e-3 ? 1 : 0);
    full();
    gl.disable(gl.BLEND);
  }
  const W8 = TS * TPR;
  // a tile plane into the atlas: only the columns its tiles fill when they fit in one row, read out of the packed rows
  const atlas = (t, d, plane, fmt, type) => {
    const w = d.rows > 1 ? W8 : d.n * TS;
    gl.pixelStorei(gl.UNPACK_ROW_LENGTH, W8);
    upload(t, w, TS * d.rows, fmt, type, plane);
    gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0);
  };
  // a pack's planes into an atlas: colour and light, and a turn's kind, anchor column and depth
  const tilePlanes = (at, d) => {
    atlas(at.c, d, d.c, gl.RED_INTEGER, gl.UNSIGNED_BYTE); atlas(at.l, d, d.light, gl.RED_INTEGER, gl.UNSIGNED_BYTE);
    if (d.id) { atlas(at.id, d, d.id, gl.RED_INTEGER, gl.UNSIGNED_SHORT); atlas(at.ax, d, d.ax, gl.RED_INTEGER, gl.SHORT); atlas(at.z, d, d.z, gl.RED, gl.FLOAT); }
  };
  // a view's overlays: its tile plane and their colours, 255 where clear
  const overlayPlanes = (ov, d) => {
    upload(ov.index, d.tw, d.th, gl.RED_INTEGER, gl.UNSIGNED_SHORT, d.index);
    if (d.rows) atlas(ov.c, d, d.c, gl.RED_INTEGER, gl.UNSIGNED_BYTE);
  };

  // A still view, or two cross-fading levels: views [{ cam: { AW, AH, gx0, gy0, s, dx, dy }, alpha, haze, quads:
  // [{ key, A, s, rect }] in draw order, dyn and over: live.js packTiles of its tiles and overlays, shade: its sun (live.js
  // shadeFor), e1: a baked sprite pixel's depth past its foot }]; sea: the palette index under nothing at all; sun: null
  // while it is down
  function drawFlat(args) {
    start(args);
    const { out, sea, lut, views, sun } = args, t0 = performance.now();
    gl.disable(gl.DEPTH_TEST); gl.disable(gl.BLEND);
    views.forEach(({ cam, alpha, haze, quads, dyn, over, shade, e1 }, i) => {
      const { AW, AH } = cam;
      castSprites(i, AW, AH, sun, shade);
      gl.bindFramebuffer(gl.FRAMEBUFFER, cap.statFb); gl.viewport(0, 0, AW, AH);
      statClear[0] = sea;
      gl.clearBufferuiv(gl.COLOR, 0, statClear); gl.clearBufferuiv(gl.COLOR, 1, noDepth);
      gl.useProgram(P.stat); gl.uniform2f(P.stat.u("uT"), AW, AH); gl.uniform2i(P.stat.u("uG"), cam.gx0, cam.gy0);
      for (const q of quads) {
        const k = chunks.get(q.key);
        if (!k) continue;
        bind(P.stat, "uK", 0, k.c); bind(P.stat, "uKo", 1, k.o); bind(P.stat, "uKa", 2, k.a); bind(P.stat, "uKz", 3, k.z);
        gl.uniform4f(P.stat.u("uRect"), q.rect[0], q.rect[1], q.rect[2], q.rect[3]); gl.uniform2f(P.stat.u("uA"), q.A[0], q.A[1]); gl.uniform1f(P.stat.u("uS"), q.s);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      }
      const at = cap.atlas[i];
      upload(cap.tiles[i], dyn.tw, dyn.th, gl.RED_INTEGER, gl.UNSIGNED_SHORT, dyn.index);
      if (dyn.rows) tilePlanes(at, dyn);
      overlayPlanes(cap.ov[i], over);
      gl.useProgram(P.flat); gl.bindFramebuffer(gl.FRAMEBUFFER, cap.artFb); gl.viewport(0, 0, AW, AH);
      bind(P.flat, "uStat", 0, cap.stat); bind(P.flat, "uStatZ", 1, cap.statZ); bind(P.flat, "uTiles", 2, cap.tiles[i]); bind(P.flat, "uAC", 3, at.c);
      bind(P.flat, "uAL", 4, at.l); bind(P.flat, "uLut", 9, lutTex);
      bind(P.flat, "uOvT", 13, cap.ov[i].index); bind(P.flat, "uOvC", 14, cap.ov[i].c);
      setHaze(P.flat, haze, [cam.gx0, cam.gy0]);
      setSun(P.flat, sun, shade, i, [cam.gx0, cam.gy0], 10);
      gl.uniform1f(P.flat.u("uE1"), e1);
      full();
      present(out, AW, AH, cam.s, cam.dx, cam.dy, alpha, lut[sea]);
    });
    evictChunks();
    Object.assign(stats, { drawMs: performance.now() - t0, tiles: views[0].dyn.n, kept: chunks.size });
  }

  // A turned view. main: the bearing whose pixels stand { AW, AH, W, g0, shade, chunks: [{ key, ox, oy }], dyn:
  // live.js packTiles, e, ids }; others: [{ AW, AH, W, g0, shade, chunks }], splatted into their own layer in order;
  // mask: the 16 dither cells where the other's shading shows; any: main is at its own bearing; target: { TW, TH, gx0,
  // gy0 }; over: the overlays' tiles in the turned view as live.js packTiles, 255 clear; out: { W, H }, pres: { s, dx, dy }
  function drawTurn(args) {
    start(args);
    const { out, sea, lut, main, others, mask, any, target, over, haze, pres, sun } = args, { TW, TH } = target, dyn = main.dyn, at = cap.atlas[0], t0 = performance.now();
    if (dyn.rows) {
      tilePlanes(at, dyn);
      upload(cap.list, TPR, dyn.rows, gl.RED_INTEGER, gl.UNSIGNED_SHORT, dyn.list);
    }
    const rows = Math.min(256, Math.ceil(main.ids / 256));
    if (rows > 0) upload(eTex, 256, rows, gl.RED, gl.FLOAT, main.e.subarray(0, rows * 256));
    overlayPlanes(cap.ov[0], over);
    // each camera's sprite shadows in its own art px, laid on its ground before it is turned
    gl.disable(gl.DEPTH_TEST);
    castSprites(0, main.AW, main.AH, sun, main.shade);
    others.forEach((o, j) => { if (j < 2) castSprites(1 + j, o.AW, o.AH, sun, o.shade); });

    // the main bearing's chunks and then its tiles into one layer, the others into another, each with its own depth test
    gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.GEQUAL);
    const splat = (list) => {
      for (const c of list) {
        const k = chunks.get(c.key);
        if (!k) continue;
        bind(P.chunk, "uKz", 0, k.z); bind(P.chunk, "uKc", 1, k.c); bind(P.chunk, "uKo", 2, k.o); bind(P.chunk, "uKa", 3, k.a);
        gl.uniform2i(P.chunk.u("uOff"), c.ox, c.oy);
        gl.drawArrays(gl.POINTS, 0, 65536);
      }
    };
    clearLayer(cap.M, true);
    pass(P.chunk, cap.M, TW, TH);
    gl.uniform2f(P.chunk.u("uT"), TW, TH); warp(P.chunk, main.W); setSun(P.chunk, sun, main.shade, 0, main.g0, 4);
    splat(main.chunks);
    if (dyn.n) {
      gl.useProgram(P.dyn);
      gl.uniform2f(P.dyn.u("uT"), TW, TH); warp(P.dyn, main.W);
      gl.uniform2i(P.dyn.u("uView"), main.AW, main.AH); gl.uniform1i(P.dyn.u("uTw"), dyn.tw);
      bind(P.dyn, "uZ", 0, at.z); bind(P.dyn, "uE", 1, eTex); bind(P.dyn, "uC", 2, at.c); bind(P.dyn, "uL", 3, at.l); bind(P.dyn, "uId", 4, at.id); bind(P.dyn, "uList", 5, cap.list); bind(P.dyn, "uAx", 6, at.ax);
      setSun(P.dyn, sun, main.shade, 0, main.g0, 7);
      gl.drawArrays(gl.POINTS, 0, dyn.n * TS * TS);
    }
    if (others.length) {
      clearLayer(cap.O, true);
      pass(P.chunk, cap.O, TW, TH);
      gl.uniform2f(P.chunk.u("uT"), TW, TH);
      others.forEach((o, j) => { warp(P.chunk, o.W); setSun(P.chunk, j < 2 ? sun : null, o.shade, Math.min(2, 1 + j), o.g0, 4); splat(o.chunks); });
    }
    gl.disable(gl.DEPTH_TEST);
    const fill = (src, dst, mode, step = 1) => {
      pass(P.fill, dst, TW, TH);
      bind(P.fill, "uS", 0, src.s); bind(P.fill, "uZ", 1, src.z);
      gl.uniform2i(P.fill.u("uSize"), TW, TH); gl.uniform1i(P.fill.u("uMode"), mode); gl.uniform1i(P.fill.u("uStep"), step);
      full();
    };
    // each layer's one-pixel cracks first, so neither shows the other, or a stand-in, through its own
    fill(cap.M, cap.A, 0);
    if (others.length) fill(cap.O, cap.B, 0);
    pass(P.combine, cap.M, TW, TH);
    bind(P.combine, "uMS", 0, cap.A.s); bind(P.combine, "uMZ", 1, cap.A.z); bind(P.combine, "uOS", 2, cap.B.s); bind(P.combine, "uOZ", 3, cap.B.z);
    gl.uniform1ui(P.combine.u("uMask"), mask >>> 0); gl.uniform1i(P.combine.u("uHaveO"), others.length ? 1 : 0); gl.uniform1i(P.combine.u("uAny"), any ? 1 : 0);
    full();
    let cur = cap.M, next = cap.A;
    for (const [mode, step] of GROW) { fill(cur, next, mode, step); [cur, next] = [next, cur]; }

    gl.useProgram(P.composite); gl.bindFramebuffer(gl.FRAMEBUFFER, cap.artFb); gl.viewport(0, 0, TW, TH);
    bind(P.composite, "uS", 0, cur.s); bind(P.composite, "uOvT", 1, cap.ov[0].index); bind(P.composite, "uOvC", 2, cap.ov[0].c); bind(P.composite, "uLut", 3, lutTex);
    setHaze(P.composite, haze, [target.gx0, target.gy0]);
    gl.uniform1ui(P.composite.u("uSea"), sea);
    full();
    present(out, TW, TH, pres.s, pres.dx, pres.dy, 1, lut[sea]);
    evictChunks();
    Object.assign(stats, { drawMs: performance.now() - t0, tiles: dyn.n, kept: chunks.size });
  }

  const stats = { uploads: 0, traces: 0 };
  // any failure turns the GPU off for the session, and live.js draws on the CPU
  const run = (fn) => (args) => {
    if (lost) return false;
    try { fn(args); return true; } catch (e) { console.warn(`the GPU renderer is off: ${e.message}`); lost = true; why = e.message; return false; }
  };
  return {
    canvas, stats, name, get lost() { return lost; }, get why() { return why; },
    // a frame starts: the upload budget refills
    begin() { frameNo++; budget = { left: UPLOADS_PER_FRAME, anim: ANIM_PER_FRAME }; },
    chunk, setHeights, flat: run(drawFlat), turn: run(drawTurn),
  };
}
