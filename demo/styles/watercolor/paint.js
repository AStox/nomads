// The watercolor itself: washes from the world's fields, their wet edges, granulation, blooms and bleeding, the symbol
// dabs and pen work laid over them, on cold-press paper with a deckled edge. Three passes: masks, blur, composite.

const VS = `#version 300 es
in vec2 pos;
void main() { gl_Position = vec4(pos, 0.0, 1.0); }`;

const NOISE = `
vec2 hash22(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}
float gnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p), u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float a = dot(hash22(i) * 2.0 - 1.0, f);
  float b = dot(hash22(i + vec2(1.0, 0.0)) * 2.0 - 1.0, f - vec2(1.0, 0.0));
  float c = dot(hash22(i + vec2(0.0, 1.0)) * 2.0 - 1.0, f - vec2(0.0, 1.0));
  float d = dot(hash22(i + vec2(1.0, 1.0)) * 2.0 - 1.0, f - vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y) * 1.7;
}
float fbm(vec2 p) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 4; i++) { s += a * gnoise(p); p = p * 2.03 + vec2(17.1, 9.3); a *= 0.5; }
  return s;
}
// Cold-press tooth: lumps of a few pixels over a slower swell.
float paperH(vec2 p) {
  return clamp(0.5 + 0.26 * gnoise(p / 4.6) + 0.16 * gnoise(p / 2.1 + 7.0) + 0.13 * gnoise(p / 10.0 + 3.0), 0.0, 1.0);
}
`;

const MASK = `#version 300 es
precision highp float;
uniform vec2 res, origin, ax, ay;
uniform float gStart, gStep, gM;
uniform sampler2D fA, fB, fC, dist;
uniform vec4 frame, vig, hole;
uniform float seaReach, coastBand, highT, shadeT1, shadeT2, warp, gscale, margin, gaps;
layout(location = 0) out vec4 o0;
layout(location = 1) out vec4 o1;
layout(location = 2) out vec4 o2;
layout(location = 3) out vec4 o3;
${NOISE}
vec2 guv(vec2 p) { vec2 w = origin + ax * p.x + ay * p.y; return ((w - gStart) / gStep + 0.5) / gM; }
// A hard wash edge about a pixel wide wherever v crosses zero, shifted by px pixels.
float cut(float v, float px) { return smoothstep(-0.7, 0.7, v / max(fwidth(v), 1e-6) + px); }
void main() {
  vec2 p = vec2(gl_FragCoord.x, res.y - gl_FragCoord.y);
  vec2 wS = vec2(gnoise(p / 21.0), gnoise(p / 21.0 + 19.7)) * 1.5 + vec2(gnoise(p / 5.5), gnoise(p / 5.5 + 7.3)) * 0.5;
  vec2 wL = vec2(fbm(p / 80.0), fbm(p / 80.0 + 31.1)) * warp + wS * 1.6;
  vec4 A = texture(fA, guv(p + wL));
  vec4 BL = texture(fB, guv(p + wL));
  vec4 BS = texture(fB, guv(p + wS));
  vec4 CS = texture(fC, guv(p + wS));
  vec4 D = texture(dist, p / res);
  float depth = texture(dist, (p + wS) / res).w;
  float water = cut(depth, -(1.0 + 0.9 * gnoise(p / 14.0)));
  // the dry rim along a shore, only where real water is near (not along every dip that nearly holds water)
  float land = max(cut(-depth, -0.3 - 0.9 * max(gnoise(p / 10.0 + 4.0), 0.0)), smoothstep(2.0, 4.0, texture(dist, (p + wS) / res).y));

  float dF = min(min(p.x - frame.x, frame.z - p.x), min(p.y - frame.y, frame.w - p.y)) - 2.0 + 1.3 * gnoise(p / 9.0);
  float clip = smoothstep(-0.7, 0.7, dF);
  if (hole.z > hole.x) {
    float dH = max(max(hole.x - p.x, p.x - hole.z), max(hole.y - p.y, p.y - hole.w)) - 2.0 + 1.2 * gnoise(p / 8.0);
    clip *= smoothstep(-0.7, 0.7, dH);
  }
  if (vig.z > 0.0) {
    vec2 q = (p - vig.xy) / vig.zw;
    float dv = (1.0 - length(q)) * 0.5 * (vig.z + vig.w) + 34.0 * fbm(p / 90.0 + 5.0) + 9.0 * gnoise(p / 13.0) + 2.5 * gnoise(p / 3.2);
    // the brush runs dry at the rim of a vignette, so the wash breaks up on the paper tooth there
    clip *= smoothstep(-0.7, 0.7, dv) * smoothstep(0.12, 0.4, paperH(p) + dv / 30.0);
  }
  clip *= 1.0 - D.z;
  water *= clip;
  land *= clip;

  float lake = step(CS.a, 0.5);
  float reach = seaReach * (0.72 + 0.5 * fbm(p / 75.0 + 2.0)) + 7.0 * gnoise(p / 11.0) + 2.5 * gnoise(p / 3.5);
  float sea = water * max(lake, smoothstep(0.7, -0.7, D.x - reach));
  float band = coastBand * (0.7 + 0.5 * fbm(p / 60.0 + 8.0)) + 2.0 * gnoise(p / 7.0);
  float glaze = water * smoothstep(0.7, -0.7, D.x - band) * (1.0 - lake);
  float hi = land * cut(BS.w - highT, 2.0 * gnoise(p / 17.0 + 3.0));

  // Each cover claims the ground where it leads; jittered margins make neighbours gap or overlap like a real hand.
  float s[6] = float[6](A.x, A.y, A.z, A.w, BL.x, BL.y);
  for (int i = 0; i < 6; i++) s[i] += 0.05 * gnoise(p / 37.0 + float(i) * 11.3);
  float t1 = -1.0, t2 = -1.0;
  for (int i = 0; i < 6; i++) { if (s[i] > t1) { t2 = t1; t1 = s[i]; } else if (s[i] > t2) t2 = s[i]; }
  // Paper left unpainted: irregular gaps that favour the sunlit slopes, where a painter would keep the white.
  float gapF = 0.8 * fbm(p / 55.0 + 71.0) + 0.12 * gnoise(p / 9.0) + 1.1 * (0.22 - CS.x) - gaps;
  float paper = 1.0 - cut(gapF, 0.0);
  float c[6];
  for (int i = 0; i < 6; i++) {
    float other = s[i] >= t1 ? t2 : t1;
    c[i] = land * paper * cut(s[i] - other, 1.6 * gnoise(p / 45.0 + float(i) * 5.1) + margin);
  }
  land *= mix(1.0, paper, 0.8);
  float sh1 = land * cut(CS.x - shadeT1, 1.5 * gnoise(p / 15.0 + 2.0));
  float sh2 = land * cut(CS.x - shadeT2, 1.5 * gnoise(p / 15.0 + 9.0));
  o0 = vec4(sea, glaze, hi, land);
  o1 = vec4(c[2], c[0], c[1], c[3]);
  o2 = vec4(c[4], c[5], sh1, sh2);
  // Second glazes dropped over parts of a dry first wash, each with its own hard ragged edge.
  vec2 pg = p / gscale;
  float gA = fbm(pg / 95.0 + 40.0) + 0.1 * gnoise(p / 8.0), gB = fbm(pg / 70.0 + 55.0) + 0.1 * gnoise(p / 7.0), gC = fbm(pg / 130.0 + 60.0) + 0.08 * gnoise(p / 9.0);
  o3 = vec4(c[2] * cut(gA - 0.1, 0.0), c[0] * cut(gB - 0.14, 0.0), sea * cut(gC - 0.12, 0.0) * (1.0 - glaze), c[3] * cut(gA - 0.14, 0.0));
}`;

const BLUR = `#version 300 es
precision highp float;
uniform sampler2D src;
uniform vec2 res, dir;
uniform float sigma;
out vec4 o;
void main() {
  vec2 uv = gl_FragCoord.xy / res;
  vec4 s = vec4(0.0);
  float ws = 0.0, st = sigma * 0.25;
  for (int i = -12; i <= 12; i++) {
    float x = float(i) * st, w = exp(-0.5 * x * x / (sigma * sigma));
    s += w * texture(src, uv + dir * x / res);
    ws += w;
  }
  o = s / ws;
}`;

const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
const K = (h) => `vec3(${hex(h).map((v) => (-Math.log(Math.max(v, 0.02))).toFixed(4)).join(", ")})`;

// Second pigments are dropped into the first wet-in-wet, so a wash drifts between two hues across the page.
export const PIGMENT = {
  sea: "#4b90ad", sea2: "#3d8a98", lake: "#5b9fb3", glaze: "#56a89d", hi: "#b3875a", land: "#e6d195",
  meadow: "#a2bd5a", meadow2: "#bfb45a", forest: "#6c984c", forest2: "#4f866a", heath: "#a88a7a",
  marsh: "#84a996", marsh2: "#6d9fae", bare: "#a99c8b", sand: "#e4cf98", shade: "#7a70a6", shade2: "#665c94",
  gMeadow: "#7a9e45", gForest: "#4a7a3c", gWater: "#3d7ea0", gMarsh: "#5f8f86",
};

const COMPOSITE = `#version 300 es
precision highp float;
uniform vec2 res, origin, ax, ay;
uniform float gStart, gStep, gM, seaReach, symEdge, bloomS, landK, card;
uniform sampler2D m0, m1, m2, m3, b0, b1, b2, b3, sym, symB, ink, dist, fC;
uniform vec4 sheet, tone, glz, vig;
out vec4 outColor;
${NOISE}
${Object.entries(PIGMENT).map(([k, v]) => `const vec3 K_${k.toUpperCase()} = ${K(v)};`).join("\n")}
float turbA, turbB, nHi, bleedF, gran;
// Density of one wash: its coverage, a feathered bleed past the edge where the paper was wet, pigment piled up at the
// wet edge, uneven flow, and granules settling into the paper's hollows.
float dens(float m, float mb, float strength, float g, float we, float bl, float salt) {
  float feather = smoothstep(0.16, 0.62, mb + 0.24 * nHi);
  float cov = max(m, feather * bl * bleedF * 0.75);
  float e = clamp(m - mb, 0.0, 1.0);
  float t = 1.0 + 0.32 * turbA * cos(salt) + 0.26 * turbB * sin(salt * 1.7);
  return cov * strength * t * (1.0 + we * 2.3 * e) * mix(1.0, gran, g);
}
float deck(float t, float s) { return 3.0 + 2.8 * fbm(vec2(t / 11.0, s * 7.3)) + 1.1 * gnoise(vec2(t / 2.1, s * 3.1)); }
float sheetD(vec2 p) {
  float dl = p.x - sheet.x - deck(p.y, 1.0), dr = sheet.z - p.x - deck(p.y, 2.0);
  float dt = p.y - sheet.y - deck(p.x, 3.0), db = sheet.w - p.y - deck(p.x, 4.0);
  return min(min(dl, dr), min(dt, db));
}
vec3 wood(vec2 p) {
  float g = fbm(vec2(p.x / 520.0, p.y / 13.0));
  float r = sin(p.y / 5.5 + 5.0 * fbm(vec2(p.x / 260.0, p.y / 60.0)));
  return vec3(0.215, 0.135, 0.085) * (0.8 + 0.28 * g + 0.07 * r) * (0.94 + 0.06 * gnoise(p / 1.5));
}
void main() {
  vec2 fc = gl_FragCoord.xy, uvF = fc / res, p = vec2(fc.x, res.y - fc.y), uvC = p / res;
  float h0 = paperH(p);
  float hx = paperH(p + vec2(1.0, 0.0)) - paperH(p - vec2(1.0, 0.0));
  float hy = paperH(p + vec2(0.0, 1.0)) - paperH(p - vec2(0.0, 1.0));
  turbA = fbm(p / 210.0);
  turbB = fbm(p / 60.0 + 9.0);
  nHi = gnoise(p / 4.5);
  bleedF = smoothstep(-0.05, 0.4, fbm(p / 160.0 + 4.0));
  float bl = fbm(p / (120.0 * bloomS) + 13.0) + 0.11 * gnoise(p / 3.6) + 0.05 * gnoise(p / 1.8);
  float bIn = smoothstep(0.36, 0.39, bl), bRim = smoothstep(0.29, 0.36, bl) * (1.0 - bIn);
  float bloom = 1.0 - 0.5 * bIn + 0.75 * bRim;
  gran = clamp(0.3 + 1.4 * (1.0 - h0) + 0.4 * gnoise(p / 1.5), 0.05, 2.4);

  vec4 M0 = texture(m0, uvF), M1 = texture(m1, uvF), M2 = texture(m2, uvF), M3 = texture(m3, uvF);
  vec4 B0 = texture(b0, uvF), B1 = texture(b1, uvF), B2 = texture(b2, uvF), B3 = texture(b3, uvF);
  vec4 D = texture(dist, uvC);
  vec2 w = origin + ax * p.x + ay * p.y, g = ((w - gStart) / gStep + 0.5) / gM;
  vec4 FC = texture(fC, g);
  float lake = step(FC.a, 0.5);
  float seaGrad = mix(1.0, 0.4, smoothstep(0.0, seaReach, D.x)) * (0.8 + 0.35 * smoothstep(2.0, 30.0, D.w));
  float vg = fbm(p / 170.0 + 21.0) + 0.15 * gnoise(p / 23.0);
  float v1 = smoothstep(-0.3, 0.3, vg), v2 = smoothstep(-0.3, 0.3, -vg + 0.1);

  vec3 A = vec3(0.0);
  A += mix(mix(K_SEA, K_SEA2, v1), K_LAKE, lake) * dens(M0.x, B0.x, 0.72 * tone.z * mix(seaGrad, 1.0, lake), 0.55, 1.0, 0.7, 1.0) * bloom;
  A += K_GLAZE * dens(M0.y, B0.y, 0.42, 0.3, 1.1, 0.5, 2.0);
  A += K_HI * dens(M0.z, B0.z, 0.3, 0.6, 1.0, 0.4, 3.0);
  A += K_LAND * dens(M0.w, B0.w, 0.5 * landK, 0.25, 0.8, 0.3, 4.0);
  A += mix(K_MEADOW, K_MEADOW2, v1) * dens(M1.x, B1.x, 0.62 * tone.w, 0.15, 1.0, 0.9, 5.0) * bloom;
  A += mix(K_FOREST, K_FOREST2, v2) * dens(M1.y, B1.y, 0.6 * tone.x, 0.3, 1.0, 0.7, 6.0) * bloom;
  A += K_HEATH * dens(M1.z, B1.z, 0.55, 0.5, 1.0, 0.6, 7.0);
  A += mix(K_MARSH, K_MARSH2, v2) * dens(M1.w, B1.w, 0.62, 0.45, 1.0, 0.9, 8.0) * bloom;
  A += K_BARE * dens(M2.x, B2.x, 0.55, 0.8, 1.0, 0.4, 9.0);
  A += K_SAND * dens(M2.y, B2.y, 0.4, 0.6, 0.9, 0.4, 10.0);
  A += K_SHADE * dens(M2.z, B2.z, 0.36 * tone.y, 0.75, 1.1, 0.3, 11.0);
  A += K_SHADE2 * dens(M2.w, B2.w, 0.3 * tone.y, 0.75, 1.1, 0.3, 12.0);
  A += K_GMEADOW * dens(M3.x, B3.x, 0.32 * glz.x, 0.25, 1.4, 0.2, 13.0);
  A += K_GFOREST * dens(M3.y, B3.y, 0.3 * glz.y, 0.35, 1.4, 0.2, 14.0);
  A += K_GWATER * dens(M3.z, B3.z, 0.22 * glz.z, 0.5, 1.4, 0.2, 15.0);
  A += K_GMARSH * dens(M3.w, B3.w, 0.28 * glz.w, 0.4, 1.4, 0.2, 16.0);
  // in a vignette the ground wash thins out toward its rim before the brush runs dry
  if (vig.z > 0.0) A *= 0.12 + 0.88 * (1.0 - smoothstep(0.45, 1.0, length((p - vig.xy) / vig.zw) + 0.1 * fbm(p / 90.0 + 5.0)));

  // Dabs painted in 2D (trees, tents, rivers...): the same wet edge from a difference of blurs, lighter granulation.
  vec3 s = texture(sym, uvC).rgb, sb = texture(symB, uvC).rgb;
  vec3 As = -log(max(s, vec3(0.02))), Asb = -log(max(sb, vec3(0.02)));
  As = As * (0.88 + 0.28 * turbB) + symEdge * max(As - Asb, 0.0);
  A += As * mix(1.0, gran, 0.35);

  vec3 col = vec3(0.965, 0.935, 0.866) * (1.0 + 0.03 * fbm(p / 280.0)) * (1.0 + 0.16 * (hx + hy));
  col *= exp(-A);
  vec4 ik = texture(ink, uvC);
  float ia = ik.a * clamp(0.7 + 0.45 * h0 + 0.12 * nHi, 0.0, 1.0);
  col *= mix(vec3(1.0), ik.rgb, ia);

  float dS = sheetD(p);
  col *= mix(vec3(0.94, 0.91, 0.85), vec3(1.0), smoothstep(0.0, 70.0, dS));
  col *= mix(0.9, 1.0, smoothstep(0.0, 4.0, dS));
  if (card > 0.5) {
    // a card tipped onto the page: transparent outside its deckled edge but for a soft shadow
    float inside = smoothstep(-0.6, 0.6, dS), sh = 0.4 * smoothstep(-12.0, 3.0, sheetD(p - vec2(4.0, 6.0)));
    outColor = vec4(col * inside, inside + sh * (1.0 - inside));
    return;
  }
  vec3 bg = wood(p) * (1.0 - 0.6 * smoothstep(-18.0, 4.0, sheetD(p - vec2(5.0, 8.0))));
  col = mix(bg, col, smoothstep(-0.6, 0.6, dS));
  col *= 1.04 - 0.12 * length((p - res * vec2(0.42, 0.38)) / res);
  outColor = vec4(col, 1.0);
}`;

export function paint(canvas, o) {
  const gl = canvas.getContext("webgl2", { preserveDrawingBuffer: true, antialias: false, alpha: !!o.card });
  if (!gl) throw new Error("WebGL2 unavailable");
  const W = canvas.width, H = canvas.height;
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  gl.bindVertexArray(gl.createVertexArray());
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  const compile = (type, src) => {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  };
  const program = (fs) => {
    const p = gl.createProgram();
    gl.attachShader(p, compile(gl.VERTEX_SHADER, VS));
    gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fs));
    gl.bindAttribLocation(p, 0, "pos");
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    return p;
  };
  const texture = (w, h, internal, type, data) => {
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    if (data instanceof HTMLCanvasElement) gl.texImage2D(gl.TEXTURE_2D, 0, internal, gl.RGBA, type, data);
    else gl.texImage2D(gl.TEXTURE_2D, 0, internal, w, h, 0, gl.RGBA, type, data);
    return t;
  };
  const f16 = (w, h, data) => texture(w, h, gl.RGBA16F, gl.FLOAT, data);
  const rgba = (data = null) => texture(W, H, gl.RGBA8, gl.UNSIGNED_BYTE, data);
  const fbo = (texs) => {
    const f = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, f);
    texs.forEach((t, i) => gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + i, gl.TEXTURE_2D, t, 0));
    gl.drawBuffers(texs.map((_, i) => gl.COLOR_ATTACHMENT0 + i));
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error("framebuffer incomplete");
    return f;
  };
  const run = (prog, target, uniforms) => {
    gl.bindFramebuffer(gl.FRAMEBUFFER, target);
    gl.viewport(0, 0, W, H);
    gl.useProgram(prog);
    let unit = 0;
    for (const [k, v] of Object.entries(uniforms)) {
      const loc = gl.getUniformLocation(prog, k);
      if (loc === null) continue;
      if (v instanceof WebGLTexture) {
        gl.activeTexture(gl.TEXTURE0 + unit);
        gl.bindTexture(gl.TEXTURE_2D, v);
        gl.uniform1i(loc, unit++);
      } else if (typeof v === "number") gl.uniform1f(loc, v);
      else [null, gl.uniform1fv, gl.uniform2fv, gl.uniform3fv, gl.uniform4fv][v.length].call(gl, loc, v);
    }
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  };

  const view = { res: [W, H], origin: o.origin, ax: o.ax, ay: o.ay, gStart: o.gStart, gStep: o.gStep, gM: o.gM };
  const fA = f16(o.gM, o.gM, o.fA), fB = f16(o.gM, o.gM, o.fB), fC = f16(o.gM, o.gM, o.fC), dist = f16(W, H, o.dist);
  const sym = rgba(o.wash), ink = rgba(o.ink);
  const m = [rgba(), rgba(), rgba(), rgba()], mb = [rgba(), rgba(), rgba(), rgba()], tmp = rgba(), symB = rgba();
  run(program(MASK), fbo(m), { ...view, fA, fB, fC, dist, ...o.mask });
  const blurP = program(BLUR), tmpF = fbo([tmp]);
  const blur = (src, dst, sigma) => {
    run(blurP, tmpF, { src, res: [W, H], dir: [1, 0], sigma });
    run(blurP, fbo([dst]), { src: tmp, res: [W, H], dir: [0, 1], sigma });
  };
  m.forEach((t, i) => blur(t, mb[i], o.sigma));
  blur(sym, symB, o.symSigma);
  run(program(COMPOSITE), null, {
    ...view, m0: m[0], m1: m[1], m2: m[2], m3: m[3], b0: mb[0], b1: mb[1], b2: mb[2], b3: mb[3], sym, symB, ink, dist, fC,
    sheet: o.sheet, seaReach: o.mask.seaReach, symEdge: o.symEdge, tone: o.tone, glz: o.glz, vig: o.mask.vig, bloomS: o.bloomS, landK: o.landK, card: o.card ? 1 : 0,
  });
  gl.finish();
  const px = new Uint8Array(4);
  gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
}
