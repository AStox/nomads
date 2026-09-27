// The land, the sea and lakes, and the streams, as meshes whose shaders lay flat washes chosen by the world's fields.
import * as THREE from "three";
import { NOISE, OUT, CLS, vec3 } from "./glsl.js";

const P = {
  forest: "#6c984c", forest2: "#5a8a58", heath: "#b0917a", scrub: "#94a55a", meadow: "#a8c05c", meadow2: "#c4b75e",
  marsh: "#97b385", marsh2: "#7fa996", bare: "#c2ab88", stone: "#aaa194", sand: "#e8d3a0", sea2: "#468f9a", shade: "#8a80b4", shade2: "#6f6699",
  sea: "#6aa7bf", shallow: "#80bcb2", deep: "#4f8fab", lake: "#66a6b8", lakeDeep: "#4a8fa8", stream: "#6aa9bd",
};

const TERRAIN_VS = `
in vec4 aA; in vec4 aB; in vec4 aC;
out vec4 vA; out vec4 vB; out vec4 vC; out vec3 vW; out vec3 vN; out float vD;
void main() {
  vA = aA; vB = aB; vC = aC; vW = position; vN = normal;
  vec4 v = viewMatrix * vec4(position, 1.0);
  vD = -v.z;
  gl_Position = projectionMatrix * v;
}`;

const TERRAIN_FS = `
precision highp float;
${NOISE}
${OUT}
in vec4 vA; in vec4 vB; in vec4 vC; in vec3 vW; in vec3 vN; in float vD;
uniform float uContour, uInkFar, uPatch;
${Object.entries(P).map(([k, v]) => `const vec3 ${k.toUpperCase()} = ${vec3(v)};`).join("\n")}
void main() {
  vec2 xz = vW.xz;
  vec3 n = normalize(vN);
  float slope = 1.0 - n.y;
  // The leading cover claims the ground; jittered margins make neighbours gap or overlap like a real hand.
  float s[6] = float[6](vA.x, vA.y, vA.z, vA.w, vB.x, vB.y);
  float best = -9.0; int k = 2;
  for (int i = 0; i < 6; i++) {
    float v = s[i] + 0.08 * gnoise(xz / (5.0 * uPatch) + float(i) * 11.3) + 0.04 * gnoise(xz / (1.3 * uPatch) + float(i) * 5.1);
    if (v > best) { best = v; k = i; }
  }
  float moist = vC.x, sky = vC.y, wet = vB.z;
  float n1 = fbm2(xz / (9.0 * uPatch) + 3.0), n2 = gnoise(xz / (2.2 * uPatch) + 9.0);
  vec3 c;
  if (k == 0) c = mix(FOREST, FOREST2, smoothstep(-0.25, 0.35, n1 + moist - 0.6));
  else if (k == 1) c = mix(HEATH, SCRUB, smoothstep(0.4, 0.8, moist + 0.25 * n1));
  else if (k == 2) c = mix(MEADOW, MEADOW2, smoothstep(-0.2, 0.3, n1 - (moist - 0.6)));
  else if (k == 3) c = mix(MARSH, MARSH2, smoothstep(-0.2, 0.3, n1 + wet * 0.6));
  else if (k == 4) c = mix(BARE, STONE, smoothstep(0.15, 0.4, slope + 0.1 * n2));
  else c = SAND;
  // a pale strand where land meets the sea
  float strand = cut(1.1 + 0.8 * n2 + 0.5 * n1 - vW.y) * step(0.02, wet + vB.y);
  c = mix(c, SAND, strand);

  // One soft shade glaze on slopes turned from the light and in hollows that see little sky; never a lit gradient.
  float sl = dot(n, uLight) - uLight.y;
  float j = 0.04 * gnoise(xz / (4.0 * uPatch) + 5.0) + 0.015 * gnoise(xz / (1.2 * uPatch));
  float g1 = cut(-0.2 - j - sl), g2 = cut(-0.42 - j - sl);
  float ao = cut(0.74 + 0.05 * n1 - sky);
  c = over(c, SHADE, 0.42 * g1 + 0.2 * ao + 0.3 * g2);

  // a few contour hints on the hills, where the ground is steep enough to carry them
  float fd = abs(fract(vW.y / uContour + 0.5) - 0.5) * uContour;
  float line = 1.0 - smoothstep(0.35, 0.95, fd / max(fwidth(vW.y), 1e-4));
  float gate = smoothstep(0.04, 0.16, slope) * smoothstep(0.08, 0.3, fbm2(xz / (40.0 * uPatch) + 21.0)) * step(-0.25, gnoise(xz / (2.5 * uPatch))) * (1.0 - smoothstep(uInkFar * 0.35, uInkFar * 0.8, vD)) * step(4.0, vW.y);
  // pen hatching laid over the shaded slopes, in patches, the way a sketcher models a hill
  float hl = abs(fract(dot(gl_FragCoord.xy, vec2(0.5, 0.866)) / 4.5) - 0.5);
  float hatch = (1.0 - smoothstep(0.07, 0.19, hl)) * max(g1, 0.6 * g2) * smoothstep(0.02, 0.09, slope)
    * smoothstep(0.0, 0.3, fbm2(xz / (30.0 * uPatch) + 3.0)) * (1.0 - smoothstep(uInkFar * 0.6, uInkFar * 1.8, vD));
  emit(c, 0.0, vD, ${CLS.ground}.0, max(line * gate * 0.75, hatch * 0.55), vW);
  oAux.w = float(k);
}`;

const WATER_VS = `
in vec2 aW;
out vec3 vW; out float vD; out vec2 vWa;
void main() {
  vW = position; vWa = aW;
  vec4 v = viewMatrix * vec4(position, 1.0);
  vD = -v.z;
  gl_Position = projectionMatrix * v;
}`;

const WATER_FS = `
precision highp float;
${NOISE}
${OUT}
in vec3 vW; in float vD; in vec2 vWa;
uniform float uShore, uPatch;
${Object.entries(P).map(([k, v]) => `const vec3 ${k.toUpperCase()} = ${vec3(v)};`).join("\n")}
void main() {
  vec2 xz = vW.xz;
  float lake = vWa.y;
  float n1 = fbm2(xz / (12.0 * uPatch) + 1.0), n2 = gnoise(xz / (2.0 * uPatch) + 4.0);
  float d = vWa.x;
  vec3 c = lake > 0.5
    ? mix(mix(SHALLOW, LAKE, smoothstep(0.3, 2.5, d + n1)), LAKEDEEP, smoothstep(3.0, 9.0, d + 3.0 * n1))
    : mix(mix(SHALLOW, SEA, smoothstep(0.6, 5.0, d + 1.5 * n1)), DEEP, smoothstep(12.0, 45.0, d + 12.0 * n1));
  // a darker glaze ring just off the shore, as on the painted atlas
  float band = cut(d - 1.2 * (1.0 + 0.5 * n1)) * cut(4.5 * (1.0 + 0.4 * n1) - d);
  c = over(c, SEA2, 0.55 * band);
  // raw paper left along the water's edge
  float rim = cut(d - uShore * (1.0 + 0.6 * n2 + 0.5 * n1));
  c = mix(vec3(1.0), c, rim);
  emit(c, 0.0, vD, ${CLS.water}.0, 0.0, vW);
  oAux.w = d;
}`;

const STREAM_FS = `
precision highp float;
${NOISE}
${OUT}
in vec3 vW; in float vD; in vec2 vWa;
${Object.entries(P).map(([k, v]) => `const vec3 ${k.toUpperCase()} = ${vec3(v)};`).join("\n")}
void main() {
  float e = abs(vWa.x);
  vec3 c = mix(STREAM, SHALLOW, smoothstep(0.55, 0.95, e + 0.2 * gnoise(vW.xz / 7.0)));
  emit(c, 0.0, vD, ${CLS.water}.0, 0.0, vW);
  oAux.w = 1.0;
}`;

const mat = (vs, fs, uniforms, extra = {}) => new THREE.ShaderMaterial({ glslVersion: THREE.GLSL3, vertexShader: vs, fragmentShader: fs, uniforms, ...extra });

export function terrain(w, common, V) {
  const { M, STEP, START, h, cover, wet, river, moist, sky } = w, LEN = M * M;
  const pos = new Float32Array(LEN * 3), A = new Float32Array(LEN * 4), B = new Float32Array(LEN * 4), C = new Float32Array(LEN * 4);
  for (let v = 0; v < M; v++)
    for (let u = 0; u < M; u++) {
      const i = v * M + u;
      pos.set([START + u * STEP, h[i] * V.exag, START + v * STEP], i * 3);
      A.set([cover.tree[i], cover.shrub[i], cover.grass[i], cover.marsh[i]], i * 4);
      B.set([cover.bare[i], cover.sand[i], wet[i], river[i]], i * 4);
      C.set([moist[i], sky[i], 0, 0], i * 4);
    }
  const idx = new Uint32Array((M - 1) * (M - 1) * 6);
  let n = 0;
  for (let v = 0; v < M - 1; v++)
    for (let u = 0; u < M - 1; u++) {
      const a = v * M + u, b = a + 1, c = a + M, d = c + 1;
      idx.set([a, c, b, b, c, d], n);
      n += 6;
    }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  g.setAttribute("aA", new THREE.BufferAttribute(A, 4));
  g.setAttribute("aB", new THREE.BufferAttribute(B, 4));
  g.setAttribute("aC", new THREE.BufferAttribute(C, 4));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  g.computeVertexNormals();
  const m = new THREE.Mesh(g, mat(TERRAIN_VS, TERRAIN_FS, { ...common, uContour: { value: V.contour }, uInkFar: { value: V.inkFar }, uPatch: { value: V.patch } }));
  m.frustumCulled = false;
  m.renderOrder = 5;
  return m;
}

// Lakes stand at their own level, the sea at zero; the water mesh sits at that level wherever the ground dips under it,
// but only near cells that hold water, so ground that merely lies below a lake's level nearby stays dry.
export function water(w, common, V) {
  const { M, STEP, START, h, isle, N, CELL } = w;
  const lvl = new Float32Array(N * N).fill(NaN);
  for (let k = 0; k < N * N; k++) if (isle.water[k] > 0) lvl[k] = isle.height[k] + isle.water[k];
  const levelAt = (x, z) => {
    const cx = (x - START) / CELL, cy = (z - START) / CELL;
    let best = 2.4, L = NaN, lake = 0;
    for (let j = Math.floor(cy) - 2; j <= Math.floor(cy) + 3; j++)
      for (let i = Math.floor(cx) - 2; i <= Math.floor(cx) + 3; i++) {
        if (i < 0 || j < 0 || i >= N || j >= N) continue;
        const l = lvl[j * N + i];
        if (Number.isNaN(l)) continue;
        const d = Math.hypot(i - cx, j - cy);
        if (d < best) { best = d; L = l; lake = l > 0.5 ? 1 : 0; }
      }
    return [L, lake];
  };
  const LEN = M * M, level = new Float32Array(LEN), lakeOf = new Uint8Array(LEN);
  for (let v = 0; v < M; v++)
    for (let u = 0; u < M; u++) {
      const i = v * M + u, [L, lk] = levelAt(START + u * STEP, START + v * STEP);
      level[i] = Number.isNaN(L) ? h[i] - 3 : L;
      lakeOf[i] = lk;
    }
  const pos = [], aw = [], idx = [], map = new Int32Array(LEN).fill(-1);
  const vert = (i) => {
    if (map[i] >= 0) return map[i];
    const u = i % M, v = (i - u) / M;
    map[i] = pos.length / 3;
    pos.push(START + u * STEP, level[i] * V.exag, START + v * STEP);
    aw.push(level[i] - h[i], lakeOf[i]);
    return map[i];
  };
  for (let v = 0; v < M - 1; v++)
    for (let u = 0; u < M - 1; u++) {
      const a = v * M + u, b = a + 1, c = a + M, d = c + 1;
      if (Math.min(h[a] - level[a], h[b] - level[b], h[c] - level[c], h[d] - level[d]) > 0.4) continue;
      const q = [a, c, b, b, c, d].map(vert);
      idx.push(...q);
    }
  // the open sea around the grid, out to the horizon
  const E = START, F = START + (M - 1) * STEP, R = 60000;
  const ring = [[-R, -R, R, E], [-R, F, R, R], [-R, E, E, F], [F, E, R, F]];
  for (const [x0, z0, x1, z1] of ring) {
    const b = pos.length / 3;
    pos.push(x0, 0, z0, x1, 0, z0, x0, 0, z1, x1, 0, z1);
    aw.push(60, 0, 60, 0, 60, 0, 60, 0);
    idx.push(b, b + 2, b + 1, b + 1, b + 2, b + 3);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(pos), 3));
  g.setAttribute("aW", new THREE.BufferAttribute(new Float32Array(aw), 2));
  g.setIndex(idx);
  const m = new THREE.Mesh(g, mat(WATER_VS, WATER_FS, { ...common, uShore: { value: V.shore }, uPatch: { value: V.patch } }, { side: THREE.DoubleSide }));
  m.frustumCulled = false;
  m.renderOrder = 6;
  return m;
}

// Streams as ribbons draped on the ground, a little proud of it.
export function streams(w, common, V) {
  const pos = [], aw = [], idx = [];
  for (const line of w.rivers) {
    const b0 = pos.length / 3;
    for (let k = 0; k < line.length; k++) {
      const [x, z, q] = line[k], a = line[Math.max(0, k - 1)], c = line[Math.min(line.length - 1, k + 1)];
      let tx = c[0] - a[0], tz = c[1] - a[1];
      const tl = Math.hypot(tx, tz) || 1;
      tx /= tl; tz /= tl;
      const half = w.riverWidth(q) * 0.5;
      for (const s of [-1, 1]) {
        const px = x - tz * half * s, pz = z + tx * half * s;
        pos.push(px, w.heightAt(px, pz) * V.exag + 0.45, pz);
        aw.push(s, 0);
      }
      if (k > 0) { const b = b0 + (k - 1) * 2; idx.push(b, b + 1, b + 2, b + 1, b + 3, b + 2); }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(pos), 3));
  g.setAttribute("aW", new THREE.BufferAttribute(new Float32Array(aw), 2));
  g.setIndex(idx);
  const m = new THREE.Mesh(g, mat(WATER_VS, STREAM_FS, { ...common }, { side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 }));
  m.frustumCulled = false;
  m.renderOrder = 7;
  return m;
}
