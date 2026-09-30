// Turning on the GPU. Between two bearings, every art pixel of the nearer bearing's composed buffer, and of the other
// bearing's baked chunks, goes back to its place in the world by its depth and is splatted as a one-pixel point into
// the view at the bearing in between (live.js warpOf has the maths, the shaders repeat it). Depth tests keep what is in
// front. A pass closes the one-pixel cracks the turn stretches into the ground; the other bearing fills the ground the
// turn uncovers behind sprites and, mid-turn, lends its shading through an ordered dither; a few passes grow whatever
// neither saw from its neighbours, ground first. Then the overlays, the haze and the time-of-day palette, and the scale
// to the canvas exactly as present() does it: nearest to the next whole factor, then one smoothed step down.
// Every layer is palette indices, so the pixels stay the art's own.

const HEAD = "#version 300 es\nprecision highp float;\nprecision highp int;\nprecision highp sampler2D;\nprecision highp usampler2D;\nprecision highp isampler2D;\n";
// ground passes, then passes that may also grow a sprite's edge; more than any gap left after the other bearing fills in
const GROUND_PASSES = 16, ANY_PASSES = 8;
// chunk textures kept on the GPU, and how many a frame may upload, so a turn's first frame does not stall
const CHUNKS_KEPT = 96, UPLOADS_PER_FRAME = 8;

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
const VS_MAIN = `${HEAD}
uniform sampler2D uZ, uE;
uniform usampler2D uC, uL, uId;
uniform isampler2D uAx;
uniform int uAW;
${EMIT}
void main() {
  ivec2 p = ivec2(gl_VertexID % uAW, gl_VertexID / uAW);
  uint id = texelFetch(uId, p, 0).r;
  int ax = id == 0u ? 0 : texelFetch(uAx, p, 0).r;
  float e = id == 0u ? 0.0 : id == 1u ? uE1 : texelFetch(uE, ivec2(int(id & 255u), int(id >> 8u)), 0).r;
  emit(float(p.x), float(p.y), texelFetch(uZ, p, 0).r, e, ax, id == 0u ? 0u : id == 1u ? 1u : 2u, texelFetch(uC, p, 0).r, texelFetch(uL, p, 0).r);
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
const FS_SPLAT = `${HEAD}
flat in uvec4 vS;
flat in uint vZ;
layout(location = 0) out uvec4 oS;
layout(location = 1) out uvec4 oZ;
void main() { oS = vS; oZ = uvec4(vZ, 0u, 0u, 0u); }`;
const VS_FULL = `${HEAD}
void main() { gl_Position = vec4(float((gl_VertexID << 1) & 2) * 2.0 - 1.0, float(gl_VertexID & 2) * 2.0 - 1.0, 0.0, 1.0); }`;
// uMode 0: a crack, filled pixels either side in a row or a column; 1: any gap, from ground only; 2: from anything
const FS_FILL = `${HEAD}
uniform usampler2D uS, uZ;
uniform ivec2 uSize;
uniform int uMode;
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
  ivec2 n[4] = ivec2[4](q + ivec2(0, -1), q + ivec2(0, 1), q + ivec2(-1, 0), q + ivec2(1, 0));
  bool f[4] = bool[4](filled(n[0]), filled(n[1]), filled(n[2]), filled(n[3]));
  int best = -1;
  if (uMode == 0) {
    if (f[2] && f[3]) best = better(n[2], n[3]) ? 2 : 3;
    else if (f[0] && f[1]) best = better(n[0], n[1]) ? 0 : 1;
  } else for (int k = 0; k < 4; k++) if (f[k] && (best < 0 || better(n[k], n[best]))) best = k;
  if (best < 0) { oS = uvec4(0u); oZ = uvec4(0u); return; }
  oS = texelFetch(uS, n[best], 0); oZ = texelFetch(uZ, n[best], 0);
}`;
// The nearer bearing's pixel stands; where it has none, the other's ground; where the dither mask picks the other and
// both show the same surface (same kind, a sprite's same column, depth within 4), the other's colour.
const FS_COMBINE = `${HEAD}
uniform usampler2D uMS, uMZ, uOS, uOZ;
uniform uint uMask;
uniform int uHaveO;
layout(location = 0) out uvec4 oS;
layout(location = 1) out uvec4 oZ;
void main() {
  ivec2 q = ivec2(gl_FragCoord.xy);
  uvec4 m = texelFetch(uMS, q, 0), mz = texelFetch(uMZ, q, 0);
  if (uHaveO == 0) { oS = m; oZ = mz; return; }
  uvec4 o = texelFetch(uOS, q, 0), oz = texelFetch(uOZ, q, 0);
  float Mz = uintBitsToFloat(mz.r), Oz = uintBitsToFloat(oz.r);
  if (m.a != 0u) {
    bool other = ((uMask >> uint(((q.y & 3) << 2) | (q.x & 3))) & 1u) != 0u;
    if (other && o.a != 0u && m.b <= 1u && o.b == m.b && (m.b == 0u || o.g == m.g) && Mz > -1e28 && abs(Oz - Mz) <= 4.0) oS = uvec4(o.r, m.g, m.b, m.a);
    else oS = m;
    oZ = mz;
    return;
  }
  if (o.a != 0u && o.b == 0u && Oz > -1e28) { oS = o; oZ = oz; return; }
  oS = uvec4(0u); oZ = uvec4(0u);
}`;
// Overlays over the world, the haze toward the top of the canvas, then the palette re-lit for the hour.
const FS_COMPOSITE = `${HEAD}
uniform usampler2D uS, uOv, uHaze;
uniform sampler2D uLut;
uniform float uMost, uTop, uReach;
uniform ivec2 uG0;
uniform uint uSea;
out vec4 o;
const float BAY[16] = float[16](0.0, 8.0, 2.0, 10.0, 12.0, 4.0, 14.0, 6.0, 3.0, 11.0, 1.0, 9.0, 15.0, 7.0, 13.0, 5.0);
void main() {
  ivec2 q = ivec2(gl_FragCoord.xy);
  uvec4 s = texelFetch(uS, q, 0);
  uint c = s.a != 0u ? s.r : uSea, light = s.a != 0u ? (s.a & 3u) : 0u, ov = texelFetch(uOv, q, 0).r;
  if (ov != 255u) c = ov;
  float a = uMost * pow(max(0.0, 1.0 - (float(q.y) - uTop) / uReach), 1.5);
  int b = (((q.y + uG0.y) & 3) << 2) | ((q.x + uG0.x) & 3);
  if (a >= 0.001 && (BAY[b] + 0.5) / 16.0 < min(a, uMost)) c = texelFetch(uHaze, ivec2(int(c), 0), 0).r;
  o = texelFetch(uLut, ivec2(int(c), int(light)), 0);
}`;
// The art buffer onto the canvas at (uD, scale uSc): nearest at a whole scale, else bilinear between the texels of its
// uN-times nearest upscale, as present() draws with two canvases.
const FS_PRESENT = `${HEAD}
uniform sampler2D uArt;
uniform vec2 uD;
uniform float uSc, uN, uCH;
uniform ivec2 uAS;
uniform int uNearest;
out vec4 o;
vec4 art(vec2 k) { return texelFetch(uArt, clamp(ivec2(floor(k / uN)), ivec2(0), uAS - 1), 0); }
void main() {
  vec2 pc = vec2(gl_FragCoord.x, uCH - gl_FragCoord.y), a = (pc - uD) / uSc;
  if (a.x < 0.0 || a.y < 0.0 || a.x >= float(uAS.x) || a.y >= float(uAS.y)) { o = vec4(0.0); return; }
  if (uNearest == 1) { o = texelFetch(uArt, ivec2(floor(a)), 0); return; }
  vec2 m = (pc - uD) * uN / uSc - 0.5, m0 = floor(m), f = m - m0;
  o = mix(mix(art(m0), art(m0 + vec2(1.0, 0.0)), f.x), mix(art(m0 + vec2(0.0, 1.0)), art(m0 + vec2(1.0, 1.0)), f.x), f.y);
}`;

// null where WebGL2 is missing or will not build these programs; live.js then shows a turn at the nearer bearing
export function createTurnGL({ NCOL, HAZE }) {
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
  const upload = (t, w, h, fmt, type, data, y = 0) => { gl.bindTexture(gl.TEXTURE_2D, t); gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, y, w, h, fmt, type, data); };
  const bind = (p, name, unit, t) => { gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, t); gl.uniform1i(p.u(name), unit); };
  const warp = (p, W) => { for (const [n, v] of [["uC1", W.c1], ["uHs", W.hs], ["uQ1", W.q1], ["uZ1", W.z1], ["uZs", W.zs], ["uE1", W.e1], ["uW0", W.w0], ["uWf", W.wf], ["uCx", W.cx], ["uCy", W.cy], ["uCz", W.cz]]) gl.uniform1f(p.u(n), v); };

  let P;
  try {
    P = { main: program(VS_MAIN, FS_SPLAT), chunk: program(VS_CHUNK, FS_SPLAT), fill: program(VS_FULL, FS_FILL), combine: program(VS_FULL, FS_COMBINE), composite: program(VS_FULL, FS_COMPOSITE), present: program(VS_FULL, FS_PRESENT) };
  } catch (e) {
    console.warn(`turning on the GPU is off: ${e.message}`);
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
    if (cap) for (const t of cap.textures) gl.deleteTexture(t);
    if (cap) { for (const fb of cap.fbs) gl.deleteFramebuffer(fb); gl.deleteRenderbuffer(cap.depth); }
    const textures = [], fbs = [], T = (f) => { const t = tex(f, w, h); textures.push(t); return t; };
    const depth = gl.createRenderbuffer();
    gl.bindRenderbuffer(gl.RENDERBUFFER, depth);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT32F, w, h);
    const layer = (withDepth) => {
      const s = T(gl.RGBA8UI), z = T(gl.R32UI), fb = gl.createFramebuffer();
      fbs.push(fb);
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, s, 0);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, z, 0);
      if (withDepth) gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depth);
      gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error("turn layer incomplete");
      return { s, z, fb };
    };
    const art = T(gl.RGBA8), artFb = gl.createFramebuffer();
    fbs.push(artFb);
    gl.bindFramebuffer(gl.FRAMEBUFFER, artFb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, art, 0);
    cap = {
      w, h, textures, fbs, depth, art, artFb,
      M: layer(true), O: layer(true), A: layer(false), B: layer(false),
      src: { c: T(gl.R8UI), l: T(gl.R8UI), id: T(gl.R16UI), ax: T(gl.R16I), z: T(gl.R32F) },
      ov: T(gl.R8UI),
    };
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  // the other bearing's chunks, uploaded once and kept while they stay the same arrays
  const chunks = new Map();
  let frameNo = 0;
  function chunkTex(ch, budget) {
    let k = chunks.get(ch.key);
    if (k && k.src === ch.c) { k.used = frameNo; return k; }
    if (budget.left <= 0) return null;
    budget.left--;
    if (!k) chunks.set(ch.key, (k = { c: tex(gl.R8UI, 256, 256), o: tex(gl.R8UI, 256, 256), a: tex(gl.R8I, 256, 256), z: tex(gl.R32F, 256, 256) }));
    upload(k.c, 256, 256, gl.RED_INTEGER, gl.UNSIGNED_BYTE, ch.c);
    upload(k.o, 256, 256, gl.RED_INTEGER, gl.UNSIGNED_BYTE, ch.obj);
    upload(k.a, 256, 256, gl.RED_INTEGER, gl.BYTE, ch.ax);
    upload(k.z, 256, 256, gl.RED, gl.FLOAT, ch.z);
    k.src = ch.c; k.used = frameNo;
    return k;
  }
  function evictChunks() {
    if (chunks.size <= CHUNKS_KEPT) return;
    for (const [key, k] of [...chunks].sort((a, b) => a[1].used - b[1].used).slice(0, chunks.size - CHUNKS_KEPT)) {
      if (k.used === frameNo) break;
      for (const t of [k.c, k.o, k.a, k.z]) gl.deleteTexture(t);
      chunks.delete(key);
    }
  }
  let lutKey = null, litLast = true;
  const zero = new Uint32Array(4), zeroF = new Float32Array([0]);
  const full = () => gl.drawArrays(gl.TRIANGLES, 0, 3);
  function pass(p, dst, TW, TH) { gl.useProgram(p); gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fb); gl.viewport(0, 0, TW, TH); }
  function clearLayer(L, depth) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, L.fb);
    gl.clearBufferuiv(gl.COLOR, 0, zero); gl.clearBufferuiv(gl.COLOR, 1, zero);
    if (depth) gl.clearBufferfv(gl.DEPTH, 0, zeroF);
  }

  // main: the nearer bearing's compose slot { AW, AH, c, light, id, ax, z, e, ids, W }; other: { W, list: [{ ch, ox, oy }] } or
  // null; mask: the 16 dither cells where the other's shading shows; target: { TW, TH, gx0, gy0 }; overlay: TW * TH
  // palette indices, 255 clear; lut: the hour's table and its key; haze: { most, top, reach }; out: { W, H, s, dx, dy }
  function draw({ cap: [cw, ch], main, other, mask, target, overlay, sea, lut, lutKey: lk, haze, out }) {
    ensure(cw, ch);
    frameNo++;
    const t0 = performance.now(), { TW, TH } = target, S = cap.src;
    if (canvas.width !== out.W || canvas.height !== out.H) { canvas.width = out.W; canvas.height = out.H; }
    upload(S.c, main.AW, main.AH, gl.RED_INTEGER, gl.UNSIGNED_BYTE, main.c);
    // fire light is rare on screen: its plane goes up only while some pixel is lit, and once more to clear it
    if (main.lit || litLast) upload(S.l, main.AW, main.AH, gl.RED_INTEGER, gl.UNSIGNED_BYTE, main.light);
    litLast = main.lit;
    upload(S.id, main.AW, main.AH, gl.RED_INTEGER, gl.UNSIGNED_SHORT, main.id);
    upload(S.ax, main.AW, main.AH, gl.RED_INTEGER, gl.SHORT, main.ax);
    upload(S.z, main.AW, main.AH, gl.RED, gl.FLOAT, main.z);
    const rows = Math.min(256, Math.ceil(main.ids / 256));
    if (rows > 0) upload(eTex, 256, rows, gl.RED, gl.FLOAT, main.e.subarray(0, rows * 256));
    upload(cap.ov, TW, TH, gl.RED_INTEGER, gl.UNSIGNED_BYTE, overlay);
    if (lk !== lutKey) { upload(lutTex, NCOL, 4, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(lut.buffer, lut.byteOffset, NCOL * 16)); lutKey = lk; }
    const t1 = performance.now();

    // the nearer bearing, then the other, each into its own layer with its own depth test
    gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.GEQUAL);
    clearLayer(cap.M, true);
    pass(P.main, cap.M, TW, TH);
    bind(P.main, "uZ", 0, S.z); bind(P.main, "uC", 1, S.c); bind(P.main, "uL", 2, S.l); bind(P.main, "uId", 3, S.id); bind(P.main, "uAx", 4, S.ax); bind(P.main, "uE", 5, eTex);
    gl.uniform1i(P.main.u("uAW"), main.AW); gl.uniform2f(P.main.u("uT"), TW, TH); warp(P.main, main.W);
    gl.drawArrays(gl.POINTS, 0, main.AW * main.AH);
    let drawn = 0, missing = 0;
    const budget = { left: UPLOADS_PER_FRAME };
    if (other) {
      clearLayer(cap.O, true);
      pass(P.chunk, cap.O, TW, TH);
      gl.uniform2f(P.chunk.u("uT"), TW, TH); warp(P.chunk, other.W);
      for (const { ch, ox, oy } of other.list) {
        const k = chunkTex(ch, budget);
        if (!k) { missing++; continue; }
        bind(P.chunk, "uKz", 0, k.z); bind(P.chunk, "uKc", 1, k.c); bind(P.chunk, "uKo", 2, k.o); bind(P.chunk, "uKa", 3, k.a);
        gl.uniform2i(P.chunk.u("uOff"), ox, oy);
        gl.drawArrays(gl.POINTS, 0, 65536);
        drawn++;
      }
    }
    gl.disable(gl.DEPTH_TEST);
    const fill = (src, dst, mode) => {
      pass(P.fill, dst, TW, TH);
      bind(P.fill, "uS", 0, src.s); bind(P.fill, "uZ", 1, src.z);
      gl.uniform2i(P.fill.u("uSize"), TW, TH); gl.uniform1i(P.fill.u("uMode"), mode);
      full();
    };
    fill(cap.M, cap.A, 0);
    pass(P.combine, cap.B, TW, TH);
    bind(P.combine, "uMS", 0, cap.A.s); bind(P.combine, "uMZ", 1, cap.A.z); bind(P.combine, "uOS", 2, cap.O.s); bind(P.combine, "uOZ", 3, cap.O.z);
    gl.uniform1ui(P.combine.u("uMask"), mask >>> 0); gl.uniform1i(P.combine.u("uHaveO"), other ? 1 : 0);
    full();
    let cur = cap.B, next = cap.A;
    for (let k = 0; k < GROUND_PASSES + ANY_PASSES; k++) { fill(cur, next, k < GROUND_PASSES ? 1 : 2); [cur, next] = [next, cur]; }

    gl.useProgram(P.composite); gl.bindFramebuffer(gl.FRAMEBUFFER, cap.artFb); gl.viewport(0, 0, TW, TH);
    bind(P.composite, "uS", 0, cur.s); bind(P.composite, "uOv", 1, cap.ov); bind(P.composite, "uHaze", 2, hazeTex); bind(P.composite, "uLut", 3, lutTex);
    gl.uniform1f(P.composite.u("uMost"), haze.most); gl.uniform1f(P.composite.u("uTop"), haze.top); gl.uniform1f(P.composite.u("uReach"), haze.reach);
    gl.uniform2i(P.composite.u("uG0"), target.gx0, target.gy0); gl.uniform1ui(P.composite.u("uSea"), sea);
    full();

    gl.useProgram(P.present); gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, out.W, out.H);
    const n = Math.max(1, Math.ceil(out.s - 1e-3));
    bind(P.present, "uArt", 0, cap.art);
    gl.uniform2f(P.present.u("uD"), out.dx, out.dy); gl.uniform1f(P.present.u("uSc"), out.s); gl.uniform1f(P.present.u("uN"), n); gl.uniform1f(P.present.u("uCH"), out.H);
    gl.uniform2i(P.present.u("uAS"), TW, TH); gl.uniform1i(P.present.u("uNearest"), Math.abs(out.s - n) < 1e-3 ? 1 : 0);
    full();
    evictChunks();
    Object.assign(stats, { uploadMs: t1 - t0, drawMs: performance.now() - t1, chunks: drawn, missing, uploads: UPLOADS_PER_FRAME - budget.left, kept: chunks.size });
    return true;
  }
  const stats = {};
  // any failure turns the GPU path off for the session, and live.js shows turns at the nearer bearing
  function render(args) {
    if (lost) return false;
    try { return draw(args); } catch (e) { console.warn(`turning on the GPU is off: ${e.message}`); lost = true; return false; }
  }
  return { canvas, render, stats, get lost() { return lost; } };
}
