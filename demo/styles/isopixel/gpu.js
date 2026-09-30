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

const HEAD = "#version 300 es\nprecision highp float;\nprecision highp int;\nprecision highp sampler2D;\nprecision highp usampler2D;\nprecision highp isampler2D;\n";
// live.js packs its tiles this way: TS art px square, TPR to an atlas row
export const TS = 32, TPR = 64;
// The passes that grow into what neither bearing saw, as [mode, step]: ground from its neighbours a pixel away, then
// from ever farther, doubling, so a gap a tree uncovered in a 45 degree turn fills with nearby ground texture in a
// few passes rather than one smeared pixel a pass; last, from anything, so a sprite's own edge can close.
const GROW = [...[1, 1, 1, 1, 2, 2, 4, 4, 8, 8, 16, 32, 64].map((k) => [1, k]), ...[1, 1, 2, 4].map((k) => [2, k])];
// chunk textures kept, and how many a frame may upload or bring to the water's next frame, so no frame stalls on them
const CHUNKS_KEPT = 224, UPLOADS_PER_FRAME = 8, ANIM_PER_FRAME = 8;

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
const VS_CHUNK = `${HEAD}
uniform sampler2D uKz;
uniform usampler2D uKc, uKo;
uniform isampler2D uKa;
uniform ivec2 uOff;
${EMIT}
void main() {
  ivec2 p = ivec2(gl_VertexID & 255, gl_VertexID >> 8);
  bool obj = (texelFetch(uKo, p, 0).r & 1u) != 0u;
  emit(float(uOff.x + p.x), float(uOff.y + p.y), texelFetch(uKz, p, 0).r, obj ? uE1 : 0.0, obj ? texelFetch(uKa, p, 0).r : 0, obj ? 1u : 0u, texelFetch(uKc, p, 0).r, 0u);
}`;
// the tiles the CPU drew into, pixel by pixel from the atlas: uList holds each atlas tile's place in the view
const VS_DYN = `${HEAD}
uniform sampler2D uZ, uE;
uniform usampler2D uC, uL, uId, uList;
uniform isampler2D uAx;
uniform ivec2 uView;
uniform int uTw;
${EMIT}
void main() {
  int k = gl_VertexID >> 10, px = gl_VertexID & 31, py = (gl_VertexID >> 5) & 31;
  int t = int(texelFetch(uList, ivec2(k & 63, k >> 6), 0).r);
  ivec2 v = ivec2((t % uTw) * 32 + px, (t / uTw) * 32 + py), a = ivec2((k & 63) * 32 + px, (k >> 6) * 32 + py);
  float zz = texelFetch(uZ, a, 0).r;
  // off the view, or a chunk still baking that the tile only stood in for: nothing, so a lending bearing shows there
  if (v.x >= uView.x || v.y >= uView.y || zz < -2e30) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 1.0; vS = uvec4(0u); vZ = 0u; return; }
  uint id = texelFetch(uId, a, 0).r;
  int ax = id == 0u ? 0 : texelFetch(uAx, a, 0).r;
  float e = id == 0u ? 0.0 : id == 1u ? uE1 : texelFetch(uE, ivec2(int(id & 255u), int(id >> 8u)), 0).r;
  emit(float(v.x), float(v.y), zz, e, ax, id == 0u ? 0u : id == 1u ? 1u : 2u, texelFetch(uC, a, 0).r, texelFetch(uL, a, 0).r);
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
const float BAY[16] = float[16](0.0, 8.0, 2.0, 10.0, 12.0, 4.0, 14.0, 6.0, 3.0, 11.0, 1.0, 9.0, 15.0, 7.0, 13.0, 5.0);
uniform usampler2D uHaze;
uniform float uMost, uTop, uReach;
uniform ivec2 uG0;
uint hazed(uint c, ivec2 q) {
  float a = uMost * pow(max(0.0, 1.0 - (float(q.y) - uTop) / uReach), 1.5);
  int b = (((q.y + uG0.y) & 3) << 2) | ((q.x + uG0.x) & 3);
  return a >= 0.001 && (BAY[b] + 0.5) / 16.0 < min(a, uMost) ? texelFetch(uHaze, ivec2(int(c), 0), 0).r : c;
}`;
// A turned view: overlays over the world, the haze toward the top of the canvas, then the palette re-lit for the hour.
const FS_COMPOSITE = `${HEAD}
uniform usampler2D uS, uOvT, uOvC;
uniform sampler2D uLut;
uniform uint uSea;
out vec4 o;
${HAZE_GLSL}
void main() {
  ivec2 q = ivec2(gl_FragCoord.xy);
  uvec4 s = texelFetch(uS, q, 0);
  uint c = s.a != 0u ? s.r : uSea, light = s.a != 0u ? (s.a & 3u) : 0u, t = texelFetch(uOvT, q >> 5, 0).r;
  // the overlays' tile where one was drawn, 255 where it is clear
  if (t != 0u) { int k = int(t) - 1; uint ov = texelFetch(uOvC, ivec2((k & 63) << 5, (k >> 6) << 5) + (q & 31), 0).r; if (ov != 255u) c = ov; }
  o = texelFetch(uLut, ivec2(int(hazed(c, q)), int(light)), 0);
}`;
// A still view: the CPU's tile where it drew one, else the static layer; then the haze and the hour's palette.
const FS_FLAT = `${HEAD}
uniform usampler2D uStat, uTiles, uAC, uAL;
uniform sampler2D uLut;
out vec4 o;
${HAZE_GLSL}
void main() {
  ivec2 q = ivec2(gl_FragCoord.xy);
  uint t = texelFetch(uTiles, q >> 5, 0).r, c, light = 0u;
  if (t != 0u) {
    int k = int(t) - 1;
    ivec2 a = ivec2((k & 63) << 5, (k >> 6) << 5) + (q & 31);
    c = texelFetch(uAC, a, 0).r; light = texelFetch(uAL, a, 0).r;
  } else c = texelFetch(uStat, q, 0).r;
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
const FS_STATIC = `${HEAD}
uniform usampler2D uK;
uniform vec2 uA;
uniform float uS;
uniform ivec2 uG;
layout(location = 0) out uvec4 o;
const float BAY[16] = float[16](0.0, 8.0, 2.0, 10.0, 12.0, 4.0, 14.0, 6.0, 3.0, 11.0, 1.0, 9.0, 15.0, 7.0, 13.0, 5.0);
float bay(ivec2 g) { return (BAY[((g.y & 3) << 2) | (g.x & 3)] + 0.5) / 16.0; }
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
  o = uvec4(texelFetch(uK, t, 0).r, 0u, 0u, 0u);
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

// null where WebGL2 is missing or will not build these programs; live.js then draws on the CPU
export function createGPU({ NCOL, HAZE }) {
  const canvas = document.createElement("canvas");
  const gl = canvas.getContext("webgl2", { alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false, preserveDrawingBuffer: false, powerPreference: "high-performance" });
  if (!gl) return null;
  let lost = false;
  canvas.addEventListener("webglcontextlost", (e) => { e.preventDefault(); lost = true; });
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
  const tex = (fmt, w, h) => {
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texStorage2D(gl.TEXTURE_2D, 1, fmt, w, h);
    for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.NEAREST], [gl.TEXTURE_MAG_FILTER, gl.NEAREST], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
    return t;
  };
  const upload = (t, w, h, fmt, type, data) => { gl.bindTexture(gl.TEXTURE_2D, t); gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, fmt, type, data); };
  const bind = (p, name, unit, t) => { gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, t); gl.uniform1i(p.u(name), unit); };
  const warp = (p, W) => { for (const [n, v] of [["uC1", W.c1], ["uHs", W.hs], ["uQ1", W.q1], ["uZ1", W.z1], ["uZs", W.zs], ["uE1", W.e1], ["uW0", W.w0], ["uWf", W.wf], ["uCx", W.cx], ["uCy", W.cy], ["uCz", W.cz]]) gl.uniform1f(p.u(n), v); };

  let P;
  try {
    P = {
      chunk: program(VS_CHUNK, FS_SPLAT), dyn: program(VS_DYN, FS_SPLAT), fill: program(VS_FULL, FS_FILL), combine: program(VS_FULL, FS_COMBINE),
      composite: program(VS_FULL, FS_COMPOSITE), flat: program(VS_FULL, FS_FLAT), stat: program(VS_QUAD, FS_STATIC), present: program(VS_FULL, FS_PRESENT),
    };
  } catch (e) {
    console.warn(`the GPU renderer is off: ${e.message}`);
    return null;
  }
  gl.bindVertexArray(gl.createVertexArray());
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  const hazeTex = tex(gl.R8UI, NCOL, 1), lutTex = tex(gl.RGBA8, NCOL, 4), eTex = tex(gl.R32F, 256, 256);
  upload(hazeTex, NCOL, 1, gl.RED_INTEGER, gl.UNSIGNED_BYTE, HAZE);

  // buffers sized to the compose slots' capacity; a view uses their top-left corner
  let cap = null;
  function ensure(w, h) {
    if (cap && cap.w === w && cap.h === h) return;
    if (cap) { for (const t of cap.textures) gl.deleteTexture(t); for (const fb of cap.fbs) gl.deleteFramebuffer(fb); gl.deleteRenderbuffer(cap.depth); }
    const textures = [], fbs = [], T = (f, tw = w, th = h) => { const t = tex(f, tw, th); textures.push(t); return t; };
    const target = (t) => { const fb = gl.createFramebuffer(); fbs.push(fb); gl.bindFramebuffer(gl.FRAMEBUFFER, fb); gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0); return fb; };
    const depth = gl.createRenderbuffer();
    gl.bindRenderbuffer(gl.RENDERBUFFER, depth);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT32F, w, h);
    const layer = (withDepth) => {
      const s = T(gl.RGBA8UI), z = T(gl.R32UI), fb = target(s);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, z, 0);
      if (withDepth) gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depth);
      gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error("turn layer incomplete");
      return { s, z, fb };
    };
    const art = T(gl.RGBA8), stat = T(gl.R8UI), artFb = target(art), statFb = target(stat);
    const tw = Math.ceil(w / TS), th = Math.ceil(h / TS), rows = Math.ceil((tw * th) / TPR), AW = TS * TPR, AH = TS * rows;
    cap = {
      w, h, rows, textures, fbs, depth, art, artFb, stat, statFb,
      M: layer(true), O: layer(true), A: layer(false), B: layer(false),
      // a cross-fade's two views each have their own tile planes, so neither is overwritten while the GPU still reads it
      tiles: [T(gl.R16UI, tw, th), T(gl.R16UI, tw, th)], list: T(gl.R16UI, TPR, rows),
      atlas: [0, 1].map((k) => ({ c: T(gl.R8UI, AW, AH), l: T(gl.R8UI, AW, AH), ...(k ? {} : { id: T(gl.R16UI, AW, AH), ax: T(gl.R16I, AW, AH), z: T(gl.R32F, AW, AH) }) })),
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
    Object.assign(k, { src: ch.c, fr, used: frameNo });
    stats.uploads++;
    return true;
  }
  function evictChunks() {
    if (chunks.size <= CHUNKS_KEPT) return;
    for (const [key, k] of [...chunks].sort((a, b) => a[1].used - b[1].used).slice(0, chunks.size - CHUNKS_KEPT)) {
      if (k.used === frameNo) break;
      for (const t of [k.c, k.o, k.a, k.z]) gl.deleteTexture(t);
      chunks.delete(key);
    }
  }

  let lutKey = null;
  const zero = new Uint32Array(4), zeroF = new Float32Array([0]), seaFill = new Uint32Array(4);
  const full = () => gl.drawArrays(gl.TRIANGLES, 0, 3);
  function pass(p, dst, TW, TH) { gl.useProgram(p); gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fb); gl.viewport(0, 0, TW, TH); }
  function clearLayer(L, depth) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, L.fb);
    gl.clearBufferuiv(gl.COLOR, 0, zero); gl.clearBufferuiv(gl.COLOR, 1, zero);
    if (depth) gl.clearBufferfv(gl.DEPTH, 0, zeroF);
  }
  function start({ cap: [cw, ch], out, lut, lutKey: lk }) {
    ensure(cw, ch);
    if (canvas.width !== out.W || canvas.height !== out.H) { canvas.width = out.W; canvas.height = out.H; }
    if (lk !== lutKey) { upload(lutTex, NCOL, 4, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(lut.buffer, lut.byteOffset, NCOL * 16)); lutKey = lk; }
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

  // A still view, or two cross-fading levels: views [{ cam: { AW, AH, gx0, gy0, s, dx, dy }, alpha, haze, quads:
  // [{ key, A, s, rect }] in draw order, dyn: live.js packTiles }]; sea: the palette index under nothing at all
  function drawFlat(args) {
    start(args);
    const { out, sea, lut, views } = args, t0 = performance.now();
    gl.disable(gl.DEPTH_TEST); gl.disable(gl.BLEND);
    views.forEach(({ cam, alpha, haze, quads, dyn }, i) => {
      const { AW, AH } = cam;
      gl.bindFramebuffer(gl.FRAMEBUFFER, cap.statFb); gl.viewport(0, 0, AW, AH);
      seaFill[0] = sea;
      gl.clearBufferuiv(gl.COLOR, 0, seaFill);
      gl.useProgram(P.stat); gl.uniform2f(P.stat.u("uT"), AW, AH); gl.uniform2i(P.stat.u("uG"), cam.gx0, cam.gy0);
      for (const q of quads) {
        const k = chunks.get(q.key);
        if (!k) continue;
        bind(P.stat, "uK", 0, k.c);
        gl.uniform4f(P.stat.u("uRect"), q.rect[0], q.rect[1], q.rect[2], q.rect[3]); gl.uniform2f(P.stat.u("uA"), q.A[0], q.A[1]); gl.uniform1f(P.stat.u("uS"), q.s);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      }
      const at = cap.atlas[i];
      upload(cap.tiles[i], dyn.tw, dyn.th, gl.RED_INTEGER, gl.UNSIGNED_SHORT, dyn.index);
      if (dyn.rows) { upload(at.c, W8, TS * dyn.rows, gl.RED_INTEGER, gl.UNSIGNED_BYTE, dyn.c); upload(at.l, W8, TS * dyn.rows, gl.RED_INTEGER, gl.UNSIGNED_BYTE, dyn.light); }
      gl.useProgram(P.flat); gl.bindFramebuffer(gl.FRAMEBUFFER, cap.artFb); gl.viewport(0, 0, AW, AH);
      bind(P.flat, "uStat", 0, cap.stat); bind(P.flat, "uTiles", 1, cap.tiles[i]); bind(P.flat, "uAC", 2, at.c); bind(P.flat, "uAL", 3, at.l); bind(P.flat, "uLut", 4, lutTex);
      setHaze(P.flat, haze, [cam.gx0, cam.gy0]);
      full();
      present(out, AW, AH, cam.s, cam.dx, cam.dy, alpha, lut[sea]);
    });
    evictChunks();
    Object.assign(stats, { drawMs: performance.now() - t0, tiles: views[0].dyn.n, kept: chunks.size });
  }

  // A turned view. main: the bearing whose pixels stand { AW, AH, W, chunks: [{ key, ox, oy }], dyn: live.js packTiles,
  // e, ids }; others: [{ W, chunks }], splatted into their own layer in order; mask: the 16 dither cells where the
  // other's shading shows; any: main is at its own bearing; target: { TW, TH, gx0, gy0 }; over: the overlays' tiles in
  // the turned view as live.js packTiles, 255 clear; out: { W, H }, pres: { s, dx, dy }
  function drawTurn(args) {
    start(args);
    const { out, sea, lut, main, others, mask, any, target, over, haze, pres } = args, { TW, TH } = target, dyn = main.dyn, at = cap.atlas[0], t0 = performance.now();
    if (dyn.rows) {
      for (const [t, plane, fmt, type] of [[at.c, dyn.c, gl.RED_INTEGER, gl.UNSIGNED_BYTE], [at.l, dyn.light, gl.RED_INTEGER, gl.UNSIGNED_BYTE], [at.id, dyn.id, gl.RED_INTEGER, gl.UNSIGNED_SHORT], [at.ax, dyn.ax, gl.RED_INTEGER, gl.SHORT], [at.z, dyn.z, gl.RED, gl.FLOAT]]) upload(t, W8, TS * dyn.rows, fmt, type, plane);
      upload(cap.list, TPR, dyn.rows, gl.RED_INTEGER, gl.UNSIGNED_SHORT, dyn.list);
    }
    const rows = Math.min(256, Math.ceil(main.ids / 256));
    if (rows > 0) upload(eTex, 256, rows, gl.RED, gl.FLOAT, main.e.subarray(0, rows * 256));
    upload(cap.tiles[1], over.tw, over.th, gl.RED_INTEGER, gl.UNSIGNED_SHORT, over.index);
    if (over.rows) upload(cap.atlas[1].c, W8, TS * over.rows, gl.RED_INTEGER, gl.UNSIGNED_BYTE, over.c);

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
    gl.uniform2f(P.chunk.u("uT"), TW, TH); warp(P.chunk, main.W);
    splat(main.chunks);
    if (dyn.n) {
      gl.useProgram(P.dyn);
      gl.uniform2f(P.dyn.u("uT"), TW, TH); warp(P.dyn, main.W);
      gl.uniform2i(P.dyn.u("uView"), main.AW, main.AH); gl.uniform1i(P.dyn.u("uTw"), dyn.tw);
      bind(P.dyn, "uZ", 0, at.z); bind(P.dyn, "uE", 1, eTex); bind(P.dyn, "uC", 2, at.c); bind(P.dyn, "uL", 3, at.l); bind(P.dyn, "uId", 4, at.id); bind(P.dyn, "uList", 5, cap.list); bind(P.dyn, "uAx", 6, at.ax);
      gl.drawArrays(gl.POINTS, 0, dyn.n * TS * TS);
    }
    if (others.length) {
      clearLayer(cap.O, true);
      pass(P.chunk, cap.O, TW, TH);
      gl.uniform2f(P.chunk.u("uT"), TW, TH);
      for (const o of others) { warp(P.chunk, o.W); splat(o.chunks); }
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
    bind(P.composite, "uS", 0, cur.s); bind(P.composite, "uOvT", 1, cap.tiles[1]); bind(P.composite, "uOvC", 2, cap.atlas[1].c); bind(P.composite, "uLut", 3, lutTex);
    setHaze(P.composite, haze, [target.gx0, target.gy0]);
    gl.uniform1ui(P.composite.u("uSea"), sea);
    full();
    present(out, TW, TH, pres.s, pres.dx, pres.dy, 1, lut[sea]);
    evictChunks();
    Object.assign(stats, { drawMs: performance.now() - t0, tiles: dyn.n, kept: chunks.size });
  }

  const stats = { uploads: 0 };
  // any failure turns the GPU off for the session, and live.js draws on the CPU
  const run = (fn) => (args) => {
    if (lost) return false;
    try { fn(args); return true; } catch (e) { console.warn(`the GPU renderer is off: ${e.message}`); lost = true; return false; }
  };
  return {
    canvas, stats, get lost() { return lost; },
    // a frame starts: the upload budget refills
    begin() { frameNo++; budget = { left: UPLOADS_PER_FRAME, anim: ANIM_PER_FRAME }; },
    chunk, flat: run(drawFlat), turn: run(drawTurn),
  };
}
