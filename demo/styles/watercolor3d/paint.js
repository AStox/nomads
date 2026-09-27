// The watercolor itself, in screen space over the flat pigment buffers: wobbled wash edges, aerial fade, the white paper
// gaps where one thing overlaps another, then wet edges, bleeding, blooms, granulation, glazes and dry-brush strokes,
// sepia pen lines, and cold-press paper that the painting fades into at the page's ragged edge.
import * as THREE from "three";
import { NOISE, CLS } from "./glsl.js";

const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
const K = (h) => `vec3(${hex(h).map((v) => (-Math.log(Math.max(v, 0.02))).toFixed(4)).join(", ")})`;

const VS = `void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }`;

const COMMON = `
precision highp float;
${NOISE}
uniform vec2 res;
uniform float uWarp, uVig;
// Where a page pixel's wash was laid: the brush never quite follows the drawing.
vec2 wobble(vec2 p) {
  vec2 wS = vec2(gnoise(p / 21.0), gnoise(p / 21.0 + 19.7)) * 1.4 + vec2(gnoise(p / 5.5), gnoise(p / 5.5 + 7.3)) * 0.55;
  vec2 wL = vec2(fbm(p / 80.0), fbm(p / 80.0 + 31.1)) * uWarp + wS * 1.2;
  return vec2(wL.x, -wL.y);
}
ivec2 texel(vec2 fc) { return ivec2(clamp(fc, vec2(0.0), res - 1.0)); }
float roundRect(vec2 p, vec2 hs, float r) {
  vec2 q = abs(p) - (hs - r);
  return -(length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r);
}
// How far inside the painted part of the page a pixel lies, in px; the edge wanders like a hand-laid wash.
float page(vec2 p) {
  return roundRect(p - res * 0.5, res * 0.5, 140.0) - uVig + 58.0 * fbm(p / 240.0 + 5.0) + 15.0 * fbm(p / 55.0 + 2.0) + 3.0 * gnoise(p / 3.2);
}
`;

const C = Object.fromEntries(Object.entries(CLS).map(([k, v]) => [k, v.toFixed(1)]));

const WASH = `
${COMMON}
uniform sampler2D tCol, tInfo;
uniform float uFog, uHorizon, uGap, uHaze;
layout(location = 0) out vec4 o;
const vec3 K_SKY = ${K("#8ab6d8")}, K_SKY2 = ${K("#aac7e0")}, K_CLOUD = ${K("#a9a6c2")}, K_HAZE = ${K("#a3bfd9")}, K_WARM = ${K("#f1d9a8")};
void main() {
  vec2 fc = gl_FragCoord.xy, p = vec2(fc.x, res.y - fc.y);
  vec2 q = fc + wobble(p);
  vec3 col = texture(tCol, q / res).rgb;
  vec4 I = texelFetch(tInfo, texel(q), 0);
  vec3 A = -log(max(col, vec3(0.02)));
  if (I.y <= 0.0) {
    // sky: a graded wash, darker overhead, with clouds lifted out and a warm breath at the horizon
    // graded over however much sky the view shows, so a thin strip of sky still runs from pale to deep
    float hy = (uHorizon - p.y) / max(uHorizon, 0.2 * res.y);
    float cl = fbm(vec2(p.x / 330.0, p.y / 105.0) + 3.0) + 0.12 * gnoise(p / 19.0);
    float cloud = smoothstep(0.1, 0.28, cl) * smoothstep(0.0, 0.1, hy);
    float under = smoothstep(0.06, 0.32, cl) * smoothstep(0.34, 0.12, fbm(vec2(p.x / 330.0, (p.y - 16.0) / 105.0) + 3.0));
    vec3 sky = mix(K_SKY2, K_SKY, smoothstep(0.05, 0.6, hy)) * (0.3 + 0.7 * smoothstep(0.0, 0.85, hy)) * (1.0 - 0.85 * cloud);
    sky += K_CLOUD * 0.22 * cloud * under + K_WARM * 0.05 * smoothstep(0.08, 0.0, hy);
    A += hy < 0.0 ? K_HAZE * 0.32 : sky;
  } else {
    float f = 1.0 - exp(-I.y / uFog);
    float lum = dot(A, vec3(0.333));
    A = mix(mix(A, vec3(lum), 0.3 * f), K_HAZE * 0.32, f * uHaze);
    // Raw paper left between a thing and whatever it stands in front of, wider for near things.
    float gap = 0.0, n = gnoise(p / 7.0);
    for (int k = 0; k < 18; k++) {
      float r = 0.9 + float(k) * 0.15, ang = float(k) * 2.39996;
      vec4 J = texelFetch(tInfo, texel(q + vec2(cos(ang), sin(ang)) * r), 0);
      bool occ = J.y > 0.0 && J.y < I.y * 0.9 && I.y - J.y > 0.4 && (abs(J.x - I.x) > 0.5 || J.z == ${C.ground})
        && J.z != ${C.blade} && J.z != ${C.flower} && I.z != ${C.blade};
      float width = clamp(uGap / J.y, 0.0, 3.4) * (0.8 + 0.35 * n);
      if (occ && r <= width) gap = 1.0;
    }
    gap *= step(gnoise(p / 11.0 + 3.0), 0.62);
    A *= 1.0 - gap;
  }
  // the painting stops short of the page edge, raggedly, the brush running dry on the tooth there
  float dv = page(p);
  float clip = smoothstep(-0.7, 0.7, dv) * smoothstep(0.1, 0.45, paperH(p) + dv / 70.0 - 0.15 * smoothstep(0.0, 1.0, gnoise(p / 40.0)));
  o = vec4(A * clip, clip);
}`;

const BLUR = `
precision highp float;
uniform sampler2D src;
uniform vec2 res, dir;
uniform float sigma;
layout(location = 0) out vec4 o;
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

// per class: granulation, bloom, bleed, pen probability (as a noise threshold), glaze
const TABLE = {
  //        sky   water ground crown wood  shrub rock  blade tent  person fire flower
  gran:  [0.45, 0.6,  0.4,  0.3,  0.35, 0.35, 0.8,  0.2,  0.35, 0.2,  0.1, 0.1],
  bloom: [1.0,  0.6,  0.7,  0.35, 0.0,  0.3,  0.2,  0.0,  0.2,  0.0,  0.0, 0.0],
  bleed: [1.0,  0.8,  0.8,  0.7,  0.3,  0.6,  0.4,  0.3,  0.35, 0.2,  0.9, 0.5],
  pen:   [9.0,  9.0,  0.25, -0.15, -0.5, 0.2,  -0.2, 9.0,  -9.0, -9.0, 9.0, 9.0],
};
const arr = (a) => `float[12](${a.map((v) => v.toFixed(2)).join(", ")})`;

const COMPOSITE = `
${COMMON}
uniform sampler2D tWash, tBlur, tBlur2, tInfo, tAux;
uniform vec4 uFire;
uniform float uInkFar, uInk, uGlaze, uEdge, uTicks;
layout(location = 0) out vec4 o;
const float GRAN[12] = ${arr(TABLE.gran)}, BLOOM[12] = ${arr(TABLE.bloom)}, BLEED[12] = ${arr(TABLE.bleed)}, PEN[12] = ${arr(TABLE.pen)};
const vec3 K_GMEADOW = ${K("#86a64a")}, K_GFOREST = ${K("#4f7d45")}, K_GWATER = ${K("#3f7ea0")}, K_GMARSH = ${K("#5f8f86")}, K_GHEATH = ${K("#8d6f7c")};
const vec3 K_GSHADE = ${K("#7b72a8")}, K_WARM = ${K("#f3c46a")}, K_STROKE = ${K("#6f9a4a")}, K_GBARE = ${K("#b08c64")}, K_GSAND = ${K("#dcbd82")}, K_TICK = ${K("#5f8a3c")}, K_PEBBLE = ${K("#8e8070")};
const vec3 INK = vec3(0.24, 0.16, 0.1), PAPER = vec3(0.965, 0.935, 0.866);
void main() {
  vec2 fc = gl_FragCoord.xy, uv = fc / res, p = vec2(fc.x, res.y - fc.y);
  float h0 = paperH(p);
  float hx = paperH(p + vec2(1.0, 0.0)) - paperH(p - vec2(1.0, 0.0));
  float hy = paperH(p + vec2(0.0, 1.0)) - paperH(p - vec2(0.0, 1.0));
  vec4 W = texture(tWash, uv);
  vec3 A = W.rgb, B = texture(tBlur, uv).rgb, B2 = texture(tBlur2, uv).rgb;
  float clip = W.a;
  vec2 q = fc + wobble(p);
  vec4 I = texelFetch(tInfo, texel(q), 0);
  vec4 X = texelFetch(tAux, texel(q), 0);
  int cls = int(I.z + 0.5);

  // pigment piles up where a wash dries against lighter paper
  float sa = A.r + A.g + A.b, sb = B.r + B.g + B.b;
  A *= 1.0 + uEdge * clamp((sa - sb) / max(sa, 0.1), 0.0, 1.0);
  // where the paper was still wet, colors crept into their neighbours
  float wetZ = smoothstep(0.0, 0.45, fbm(p / 170.0 + 4.0) + 0.1 * gnoise(p / 23.0));
  A = mix(A, max(A, B2 * 0.9), wetZ * BLEED[cls] * clip);
  // uneven flow, blooms where water crept back into a drying wash, granules settling in the hollows
  A *= 1.0 + 0.3 * fbm(p / 210.0) + 0.24 * fbm(p / 60.0 + 9.0);
  float bl = fbm(p / 125.0 + 13.0) + 0.11 * gnoise(p / 3.6) + 0.05 * gnoise(p / 1.8);
  float bIn = smoothstep(0.34, 0.37, bl), bRim = smoothstep(0.27, 0.34, bl) * (1.0 - bIn);
  A *= mix(1.0, 1.0 - 0.42 * bIn + 0.75 * bRim, BLOOM[cls]);
  float gran = clamp(0.3 + 1.4 * (1.0 - h0) + 0.4 * gnoise(p / 1.5), 0.05, 2.4);
  A *= mix(1.0, gran, GRAN[cls]);

  // second glazes laid over the dry first wash in ragged patches, anchored to the ground so they lie in perspective
  vec2 wz = X.xz / uGlaze;
  float gA = fbm(wz / 95.0 + 40.0) + 0.08 * gnoise(p / 8.0), gB = fbm(wz / 60.0 + 55.0) + 0.08 * gnoise(p / 7.0);
  float g1 = smoothstep(0.08, 0.1, gA), g2 = smoothstep(0.14, 0.16, gB);
  float e1 = smoothstep(0.08, 0.1, gA) * smoothstep(0.16, 0.1, gA), e2 = smoothstep(0.14, 0.16, gB) * smoothstep(0.22, 0.16, gB);
  float fogF = exp(-I.y / (uInkFar * 2.5));
  if (cls == ${CLS.ground}) {
    int k = int(X.w + 0.5);
    vec3 G = k == 0 ? K_GFOREST : k == 1 ? K_GHEATH : k == 3 ? K_GMARSH : k == 2 ? K_GMEADOW : k == 4 ? K_GBARE : K_GSAND;
    A += G * (0.26 * g1 + 0.5 * e1) * clip * (0.4 + 0.6 * fogF);
    A += K_GSHADE * (0.12 * g2 + 0.25 * e2) * clip * fogF;
    // dry-brush strokes across the meadows and heath, broken by the paper tooth
    float st = smoothstep(0.5, 0.8, gnoise(vec2(p.x / 38.0, p.y / 2.6) + vec2(3.0, X.w))) * step(0.44, h0);
    A += K_STROKE * 0.32 * st * clip * step(1.5, X.w) * step(X.w, 3.5);
    // grit and pebbles dotted over bare ground and sand
    if (k >= 4) {
      vec2 cell = floor(p / 6.0), hc = hash22(cell + 41.0);
      vec2 c0 = (cell + 0.25 + 0.5 * hash22(cell + 9.0)) * 6.0;
      float dot1 = (1.0 - smoothstep(0.5, 1.3, length((p - c0) * vec2(1.0, 1.5)) / (0.6 + hc.y))) * step(hc.x, 0.3 * (1.0 - smoothstep(uInkFar * 0.05, uInkFar * 0.2, I.y)));
      A += K_PEBBLE * 0.45 * dot1 * clip;
    }
    // grass ticks flicked over the meadows, heath and marsh, thinning out with distance
    if (k >= 1 && k <= 3) {
      vec2 cell = floor(p / 9.0), hc = hash22(cell + 17.0);
      if (hc.x < uTicks * smoothstep(-0.15, 0.35, fbm(p / 90.0 + 8.0)) * (1.0 - smoothstep(uInkFar * 0.12, uInkFar * 0.45, I.y))) {
        vec2 c0 = (cell + 0.3 + 0.4 * hash22(cell + 3.0)) * 9.0;
        float tick = 0.0;
        for (int s = -1; s <= 1; s++) {
          float a = float(s) * 0.4 + (hc.y - 0.5) * 0.35, L = 3.0 + 3.5 * hash22(cell + float(s) * 5.0 + 1.0).x;
          vec2 dir = vec2(sin(a), -cos(a)), dd = p - c0;
          float t = clamp(dot(dd, dir), 0.0, L);
          tick = max(tick, (1.0 - smoothstep(0.3, 0.85, length(dd - dir * t))) * (1.0 - 0.45 * t / L));
        }
        A += K_TICK * 0.85 * tick * clip * (k == 1 ? 0.6 : 1.0);
      }
    }
  } else if (cls == ${CLS.water}) {
    float gW = fbm(wz / 260.0 + 55.0) + 0.08 * gnoise(p / 7.0), w2 = smoothstep(0.14, 0.16, gW), we2 = w2 * smoothstep(0.22, 0.16, gW);
    A += K_GWATER * (0.16 * w2 + 0.3 * we2) * clip * step(1.0, X.w) * (0.3 + 0.7 * fogF);
    float st = smoothstep(0.55, 0.85, gnoise(vec2(p.x / 70.0, p.y / 2.0) + 7.0)) * step(0.45, h0) * step(1.0, X.w) * smoothstep(0.0, 0.3, fbm(p / 210.0 + 2.0));
    A += K_GWATER * 0.36 * st * clip * fogF;
    // and a few streaks lifted back out to the paper, where the water catches the sky
    float lf = smoothstep(0.62, 0.86, gnoise(vec2(p.x / 48.0, p.y / 1.5) + 21.0)) * smoothstep(-0.1, 0.3, fbm(p / 160.0 + 12.0)) * step(1.0, X.w);
    A *= 1.0 - 0.75 * lf * fogF;
  }

  // the fire lifts the pigment round it, as if the paper were left bare, and warms the ground
  vec2 fd = (p - uFire.xy) / max(uFire.z, 1.0);
  float glow = length(fd * vec2(1.0, 1.5)) + 0.22 * gnoise(p / 13.0) + 0.1 * gnoise(p / 4.0);
  float lift = smoothstep(1.0, 0.35, glow) * uFire.w * step(0.5, abs(float(cls) - ${C.fire}));
  A *= 1.0 - 0.6 * lift;
  A += K_WARM * 0.3 * smoothstep(1.25, 0.5, glow) * uFire.w * clip;

  vec3 col = PAPER * (1.0 + 0.03 * fbm(p / 280.0)) * (1.0 + 0.15 * (hx + hy));
  col *= exp(-A);

  // Sepia pen, drawn separately from the washes, so it misregisters a little: outlines of near things, the coast,
  // and marks the objects asked for (contours, seams).
  vec2 pi = fc + vec2(gnoise(p / 31.0 + 50.0), gnoise(p / 31.0 + 70.0)) * 1.3;
  vec4 P = texelFetch(tInfo, texel(pi), 0);
  int pc = int(P.z + 0.5);
  float ink = 0.0;
  if (P.y > 0.0) {
    // line weight swells and thins along the stroke; soft falloff over three rings keeps it from stair-stepping
    float wpx = clamp(uInk / P.y, 0.7, 2.3) * (0.6 + 0.6 * (0.5 + 0.5 * gnoise(p / 17.0)));
    float edge = 0.0, coast = 0.0;
    for (int k = 0; k < 24; k++) {
      float r = 0.75 * float(1 + k / 8), ang = float(k) * 0.785398 + float(k / 8) * 0.39;
      vec2 dir = vec2(cos(ang), sin(ang));
      vec4 J = texelFetch(tInfo, texel(pi + dir * r), 0);
      float wgt = clamp(wpx - r + 0.75, 0.0, 1.0);
      bool behind = J.y <= 0.0 || J.y > P.y * 1.04 + 0.25;
      bool other = abs(J.x - P.x) > 0.5 || int(J.z + 0.5) != pc;
      if ((behind && other) || (pc == ${CLS.ground} && J.y <= 0.0)) edge = max(edge, wgt);
      if (pc == ${CLS.ground} && int(J.z + 0.5) == ${CLS.water} && J.y < uInkFar * 1.6) coast = max(coast, clamp(1.6 - r, 0.0, 1.0));
    }
    float gate = smoothstep(PEN[pc] - 0.1, PEN[pc] + 0.1, gnoise(p / 26.0 + 17.0) + 0.3 * gnoise(p / 7.0));
    float near = 1.0 - smoothstep(uInkFar * 0.5, uInkFar, P.y);
    ink = edge * gate * near;
    if (pc == ${CLS.ground}) ink *= 0.55;
    ink = max(ink, coast * step(-0.35, gnoise(p / 40.0 + 3.0)) * 0.85);
    // hatching and contours stay inside the paint; only outlines run on past it
    ink = max(ink, P.w * (1.0 - smoothstep(uInkFar, uInkFar * 2.0, P.y)) * smoothstep(0.2, 0.8, clip));
  }
  // the pen skips on the tooth and runs a little past where the paint stopped
  ink *= clamp(0.62 + 0.5 * h0 + 0.15 * gnoise(p / 2.0), 0.0, 1.0) * smoothstep(-0.7, 0.7, page(p) + 26.0);
  col *= mix(vec3(1.0), INK / PAPER, clamp(ink, 0.0, 1.0) * 0.85);
  o = vec4(clamp(col, 0.0, 1.0), 1.0);
}`;

export class Painter {
  constructor(renderer, W, H) {
    this.r = renderer;
    this.W = W;
    this.H = H;
    const rt = (opts = {}) => new THREE.WebGLRenderTarget(W, H, { type: THREE.HalfFloatType, depthBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, ...opts });
    this.scene = new THREE.WebGLRenderTarget(W, H, { count: 3, type: THREE.HalfFloatType, depthBuffer: true, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter });
    this.wash = rt();
    this.tmp = rt();
    this.blur = rt();
    this.blur2 = rt();
    const tri = new THREE.BufferGeometry();
    tri.setAttribute("position", new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
    this.tri = tri;
    this.cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  }
  pass(fs, uniforms, target) {
    const m = new THREE.ShaderMaterial({ glslVersion: THREE.GLSL3, vertexShader: VS, fragmentShader: fs, uniforms, depthTest: false, depthWrite: false });
    const mesh = new THREE.Mesh(this.tri, m);
    mesh.frustumCulled = false;
    const s = new THREE.Scene();
    s.add(mesh);
    this.r.setRenderTarget(target);
    this.r.render(s, this.cam);
    m.dispose();
  }
  // Every object into the three pigment buffers: wash color on white, what it is, and where it is.
  drawScene(scene, camera) {
    const r = this.r, gl = r.getContext();
    r.setRenderTarget(this.scene);
    r.clear(false, true, true);
    // three premultiplies its clear color, so a white clear with zero alpha would come out black
    gl.clearBufferfv(gl.COLOR, 0, [1, 1, 1, 0]);
    gl.clearBufferfv(gl.COLOR, 1, [0, 0, 0, 0]);
    gl.clearBufferfv(gl.COLOR, 2, [0, 0, 0, 0]);
    r.autoClear = false;
    r.render(scene, camera);
    r.autoClear = true;
  }
  paint(o) {
    const u = (v) => ({ value: v }), res = u(new THREE.Vector2(this.W, this.H));
    const [tCol, tInfo, tAux] = this.scene.textures;
    this.pass(WASH, { res, uWarp: u(o.warp), tCol: u(tCol), tInfo: u(tInfo), uFog: u(o.fog), uHorizon: u(o.horizon), uGap: u(o.gap), uVig: u(o.vig), uHaze: u(o.haze) }, this.wash);
    const blur = (src, dst, sigma) => {
      this.pass(BLUR, { src: u(src), res, dir: u(new THREE.Vector2(1, 0)), sigma: u(sigma) }, this.tmp);
      this.pass(BLUR, { src: u(this.tmp.texture), res, dir: u(new THREE.Vector2(0, 1)), sigma: u(sigma) }, dst);
    };
    blur(this.wash.texture, this.blur, 2.6);
    blur(this.wash.texture, this.blur2, 8);
    this.pass(COMPOSITE, {
      res, uWarp: u(o.warp), uVig: u(o.vig), tWash: u(this.wash.texture), tBlur: u(this.blur.texture), tBlur2: u(this.blur2.texture), tInfo: u(tInfo), tAux: u(tAux),
      uFire: u(new THREE.Vector4(...o.fire)), uInkFar: u(o.inkFar), uInk: u(o.ink), uGlaze: u(o.glaze), uEdge: u(o.edge), uTicks: u(o.ticks),
    }, null);
  }
}
