// What grows and lies about: tree crowns as clusters of painted lobes (ray-traced spheres on camera-facing cards, with
// leafy ragged rims), pines as stacked cones, trunks, shrubs, rocks, reeds, grass tufts and flowers. Each thing is one
// flat pigment with a shade glaze on its underside; the paint passes turn it into watercolor.
import * as THREE from "three";
import { hash } from "../world.js";
import { NOISE, OUT, CLS, hex3, vec3 } from "./glsl.js";

const LOBE_VS = `
in vec4 iA; in vec4 iB; in vec4 iC;
out vec3 vC; out float vR; out vec3 vCol; out float vId; out vec4 vMisc;
void main() {
  vec4 c = viewMatrix * vec4(iA.xyz, 1.0);
  vC = c.xyz; vR = iA.w; vCol = iB.rgb; vId = iB.a; vMisc = iC;
  // the card is pulled toward the eye by the radius so it covers the sphere's outline; the fragment sets true depth
  vec3 p = c.xyz + vec3(position.xy * 2.7 * iA.w, iA.w);
  gl_Position = projectionMatrix * vec4(p, 1.0);
}`;

const LOBE_FS = `
precision highp float;
${NOISE}
${OUT}
uniform mat4 projectionMatrix;
uniform vec2 uRes;
uniform vec3 uLightV;
in vec3 vC; in float vR; in vec3 vCol; in float vId; in vec4 vMisc;
const vec3 SH1 = ${vec3("#7c86ad")}, SH2 = ${vec3("#606c92")};
void main() {
  vec2 ndc = gl_FragCoord.xy / uRes * 2.0 - 1.0;
  vec3 d = normalize(vec3(ndc.x / projectionMatrix[0][0], ndc.y / projectionMatrix[1][1], -1.0));
  float b = dot(d, vC);
  vec3 off = d * b - vC;
  float m = length(off);
  vec2 dir = off.xy / max(length(off.xy), 1e-6);
  float seed = vMisc.z, leafy = vMisc.w;
  // leafy rim: a few big lumps and many small scallops
  float ang = atan(dir.y, dir.x);
  float flower = step(${CLS.flower}.0 - 0.5, vMisc.y);
  float rim = flower > 0.5 ? 0.6 + 0.4 * abs(cos(2.5 * ang + seed * 6.0)) : 1.0 - leafy * (0.09 * (0.5 + 0.5 * gnoise(dir * 1.6 + seed * 7.0)) + 0.07 * abs(sin(ang * 6.0 + seed * 40.0)) + 0.04 * abs(sin(ang * 13.0 + seed * 9.0)));
  float re = vR * rim;
  float disc = re * re - m * m;
  if (disc < 0.0) discard;
  vec3 P = d * (b - sqrt(disc));
  vec3 n = (P - vC) / re;
  vec4 clip = projectionMatrix * vec4(P, 1.0);
  gl_FragDepth = clip.z / clip.w * 0.5 + 0.5;
  vec3 nw = n * mat3(viewMatrix);
  float s = dot(nw, uLight) * 0.8 + 0.2 * nw.y + vMisc.x;
  float j = 0.16 * gnoise(n.xy * 2.2 + seed * 13.0) + 0.06 * gnoise(n.xy * 7.0 + seed * 5.0);
  vec3 c = vCol;
  if (flower > 0.5) c = mix(c, ${vec3("#f0c848")}, step(m, 0.28 * vR));
  else {
    c = over(c, SH1, 0.85 * cut(-0.02 + j - s));
    c = over(c, SH2, 0.6 * cut(-0.5 + j - s));
    c = mix(c, vec3(1.0), 0.16 * cut(s - 0.72 - j));
  }
  emit(c, vId, -P.z, vMisc.y, 0.0, cameraPosition + transpose(mat3(viewMatrix)) * P);
}`;

const SOLID_VS = `
in vec4 iA; in vec4 iB; in vec4 iC;
in float aShade;
out vec3 vN; out vec3 vW; out float vD; out vec3 vCol; out float vId; out float vS; out vec3 vL;
void main() {
  float c = cos(iC.x), s = sin(iC.x);
  vec3 sc = iC.yzw * iA.w;
  vec3 p = position * sc;
  p = vec3(c * p.x + s * p.z, p.y, -s * p.x + c * p.z);
  vec3 n = normal / sc;
  vN = vec3(c * n.x + s * n.z, n.y, -s * n.x + c * n.z);
  vW = iA.xyz + p;
  vL = position;
  vec4 v = viewMatrix * vec4(vW, 1.0);
  vD = -v.z; vCol = iB.rgb; vId = iB.a; vS = aShade;
  gl_Position = projectionMatrix * v;
}`;

const SOLID_FS = `
precision highp float;
${NOISE}
${OUT}
uniform float uCls, uJit;
uniform vec3 uSh1, uSh2;
in vec3 vN; in vec3 vW; in float vD; in vec3 vCol; in float vId; in float vS; in vec3 vL;
void main() {
  vec3 n = normalize(vN);
  // blades are lit the same from both sides; closed shapes seen from inside are in shade
  if (!gl_FrontFacing && uJit > 0.0) n = -n;
  float s = dot(n, uLight) * 0.8 + 0.2 * n.y + vS;
  float j = uJit * (0.14 * gnoise(vL.xz * 5.0 + vL.y * 3.0 + vId) + 0.06 * gnoise(vL.xy * 17.0 + vId));
  vec3 c = over(vCol, uSh1, 0.85 * cut(-0.02 + j - s));
  c = over(c, uSh2, 0.6 * cut(-0.5 + j - s));
  emit(c, vId, vD, uCls, 0.0, vW);
}`;

// Painted shade pools on the ground beside things, falling away from the light, multiplied over the ground wash and
// leaving the other buffers alone.
const POOL_VS = `
in vec4 iA; in vec4 iB; in vec4 iC;
out vec2 vQ; out float vSeed; out vec3 vT;
void main() {
  float c = cos(iC.x), s = sin(iC.x);
  vec2 l = vec2(position.x * iA.w, position.y * iB.w), r = vec2(c * l.x - s * l.y, s * l.x + c * l.y);
  vec3 w = vec3(iA.x + r.x, iA.y + iC.y * r.x + iC.z * r.y, iA.z + r.y);
  vQ = position.xy; vSeed = iC.w; vT = iB.rgb;
  gl_Position = projectionMatrix * viewMatrix * vec4(w, 1.0);
}`;
const POOL_FS = `
precision highp float;
${NOISE}
layout(location = 0) out vec4 oCol;
layout(location = 1) out vec4 oInfo;
layout(location = 2) out vec4 oAux;
in vec2 vQ; in float vSeed; in vec3 vT;
void main() {
  float r = length(vQ) + 0.16 * gnoise(vQ * 2.2 + vSeed * 17.0) + 0.05 * gnoise(vQ * 7.0 + vSeed * 3.0);
  if (r > 0.9) discard;
  oCol = vec4(vT, 1.0);
  oInfo = vec4(1.0);
  oAux = vec4(1.0);
}`;
const POOL = hex3("#cbc3dc");
// Where a thing's shade pool lies: pushed away from the light, on the ground's tilt there.
export function pool(batch, w, L, x, z, y, reach, rx, ry, seed) {
  const sx = -L.x, sz = -L.z, sl = Math.hypot(sx, sz) || 1, cx = x + (sx / sl) * reach, cz = z + (sz / sl) * reach;
  const gx = (w.heightAt(cx + 2, cz) - w.heightAt(cx - 2, cz)) / 4, gz = (w.heightAt(cx, cz + 2) - w.heightAt(cx, cz - 2)) / 4;
  batch.push([cx, (y ?? w.heightAt(cx, cz)) + 0.1, cz, rx], [...POOL, ry], [Math.atan2(sz, sx), gx, gz, seed]);
}
export function poolMesh(batch) {
  const g = batch.geometry(new THREE.CircleGeometry(1, 20));
  const m = new THREE.Mesh(g, new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3, vertexShader: POOL_VS, fragmentShader: POOL_FS, transparent: true, depthWrite: false, side: THREE.DoubleSide,
    blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.ZeroFactor, blendDst: THREE.SrcColorFactor,
    blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor,
  }));
  m.frustumCulled = false;
  m.renderOrder = 10;
  return m;
}

const mat = (vs, fs, uniforms, extra = {}) => new THREE.ShaderMaterial({ glslVersion: THREE.GLSL3, vertexShader: vs, fragmentShader: fs, uniforms, ...extra });

// Growable float lists that become instanced attributes.
export class Batch {
  constructor() { this.a = []; this.b = []; this.c = []; }
  push(a, b, c) { this.a.push(...a); this.b.push(...b); this.c.push(...c); }
  get count() { return this.a.length / 4; }
  geometry(base) {
    const g = new THREE.InstancedBufferGeometry();
    g.index = base.index;
    for (const [k, v] of Object.entries(base.attributes)) g.setAttribute(k, v);
    g.setAttribute("iA", new THREE.InstancedBufferAttribute(new Float32Array(this.a), 4));
    g.setAttribute("iB", new THREE.InstancedBufferAttribute(new Float32Array(this.b), 4));
    g.setAttribute("iC", new THREE.InstancedBufferAttribute(new Float32Array(this.c), 4));
    g.instanceCount = this.count;
    return g;
  }
}

const mixc = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
const withShade = (g, f) => {
  const p = g.attributes.position, s = new Float32Array(p.count);
  for (let i = 0; i < p.count; i++) s[i] = f(p.getX(i), p.getY(i), p.getZ(i));
  g.setAttribute("aShade", new THREE.BufferAttribute(s, 1));
  return g;
};

// Stacked drooping cones, unit tall, with ragged hems; lower rims of each tier sit in shade.
function pineGeometry(tiers, seg) {
  const parts = [];
  for (let t = 0; t < tiers; t++) {
    const f = t / tiers, r = 0.36 * (1 - f * 0.62), y0 = 0.14 + f * 0.62, y1 = y0 + 0.34 - f * 0.05;
    const g = new THREE.ConeGeometry(r, y1 - y0, seg, 1, true);
    g.translate(0, (y0 + y1) / 2, 0);
    const p = g.attributes.position;
    for (let i = 0; i < p.count; i++) if (p.getY(i) < y0 + 0.01) {
      const a = Math.atan2(p.getZ(i), p.getX(i)), k = 1 + 0.16 * Math.sin(a * 3 + t * 2.1) + 0.1 * Math.sin(a * 7 + t);
      p.setXYZ(i, p.getX(i) * k, y0 - 0.035 * (1 + Math.sin(a * 5 + t)), p.getZ(i) * k);
    }
    const tier = g.toNonIndexed();
    withShade(tier, (x, y) => -0.55 * (1 - Math.min(1, (y - y0) / (y1 - y0) * 1.6)));
    parts.push(tier);
  }
  return merge(parts);
}

function merge(parts) {
  const n = parts.reduce((s, g) => s + g.attributes.position.count, 0);
  const out = new THREE.BufferGeometry();
  for (const name of ["position", "normal", "aShade"]) {
    const size = parts[0].attributes[name].itemSize, arr = new Float32Array(n * size);
    let o = 0;
    for (const g of parts) { arr.set(g.attributes[name].array, o); o += g.attributes[name].array.length; }
    out.setAttribute(name, new THREE.BufferAttribute(arr, size));
  }
  return out;
}

function trunkGeometry() {
  const g = new THREE.CylinderGeometry(0.65, 1, 1, 6, 1, true).translate(0, 0.5, 0).toNonIndexed();
  g.computeVertexNormals();
  return withShade(g, () => -0.15);
}

function rockGeometry() {
  const g = new THREE.IcosahedronGeometry(1, 1);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i), k = 1 + 0.22 * Math.sin(x * 3.1 + z * 2.3) + 0.14 * Math.sin(y * 4.7 + x * 1.3);
    p.setXYZ(i, x * k, Math.max(y * k, -0.25), z * k);
  }
  g.computeVertexNormals();
  return withShade(g, () => 0);
}

// A clump of thin blades, unit tall, fanning out and leaning; darker toward the root.
function bladeGeometry(blades, lean, width) {
  const pos = [], nor = [], sh = [];
  for (let b = 0; b < blades; b++) {
    const a = (b / blades) * Math.PI * 2 + b * 0.7, r = 0.05 + 0.1 * ((b * 0.37) % 1), l = lean * (0.5 + ((b * 0.61) % 1));
    const bx = Math.cos(a) * r, bz = Math.sin(a) * r, tx = bx + Math.cos(a) * l, tz = bz + Math.sin(a) * l, ty = 0.7 + 0.3 * ((b * 0.83) % 1);
    const px = -Math.sin(a) * width, pz = Math.cos(a) * width;
    pos.push(bx - px, 0, bz - pz, bx + px, 0, bz + pz, tx, ty, tz);
    for (let k = 0; k < 3; k++) nor.push(Math.cos(a) * 0.3, 0.95, Math.sin(a) * 0.3);
    sh.push(-0.6, -0.6, 0.25);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(pos), 3));
  g.setAttribute("normal", new THREE.BufferAttribute(new Float32Array(nor), 3));
  g.setAttribute("aShade", new THREE.BufferAttribute(new Float32Array(sh), 1));
  return g;
}

const TREE = {
  oak: { r: 0.34, base: 0.3, n: 6, stretch: 1.0, col: "#5f8c3e", alt: "#4f7f47" },
  ash: { r: 0.27, base: 0.36, n: 5, stretch: 1.12, col: "#76a24a", alt: "#8fab4d" },
  aspen: { r: 0.19, base: 0.3, n: 5, stretch: 1.8, col: "#a3b24e", alt: "#c0b55a" },
  pine: { col: "#3f6f58", alt: "#4f7d4f" },
};
const AUTUMN = [hex3("#c79a44"), hex3("#b8763f"), hex3("#d0b04e")];

// Every tree, shrub and rock that stands in the view, thinned and enlarged with distance so far woods stay a texture.
export function flora(w, common, V, camera, lightV) {
  const frustum = new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
  const sphere = new THREE.Sphere(), cam = camera.position;
  const visible = (x, y, z, r) => { sphere.center.set(x, y, z); sphere.radius = r; return frustum.intersectsSphere(sphere); };
  const keep = (d, i, salt) => {
    const p = d < V.keepFrom ? 1 : Math.max(V.minKeep, (V.keepFrom / d) ** 1.6);
    return hash(i, salt, 91) < p ? Math.min(V.maxScale, p ** -0.5) : 0;
  };
  const lobes = new Batch(), pinesNear = new Batch(), pinesFar = new Batch(), trunks = new Batch(), rocks = new Batch(), blades = new Batch(), pools = new Batch();
  const L = common.uLight.value;
  const col = Object.fromEntries(Object.entries(TREE).map(([k, v]) => [k, [hex3(v.col), hex3(v.alt)]]));
  let trees = 0;
  const E = V.exag;
  w.trees.forEach((t0, i) => {
    const t = E === 1 ? t0 : { ...t0, y: t0.y * E };
    if (!visible(t.x, t.y + t.tall * 0.6, t.z, t.tall)) return;
    const d = Math.hypot(t.x - cam.x, t.y - cam.y, t.z - cam.z);
    if (d > V.treeFar) return;
    const s = keep(d, i, 1);
    if (!s) return;
    trees++;
    const T = t.tall * (0.85 + 0.3 * hash(i, 2, 5)) * V.treeScale, id = 1 + Math.floor(hash(i, 7, 3) * 2000), seed = hash(i, 9, 1);
    const [c0, c1] = col[t.kind];
    let c = mixc(c0, c1, t.tint);
    if (t.kind !== "pine" && hash(i, 11, 2) < V.autumn) c = mixc(c, AUTUMN[i % 3], 0.75);
    c = mixc(c, [1, 1, 1], V.pale * (hash(i, 13, 4) - 0.3));
    const near = d < V.lobeFar;
    if (t.kind === "pine") {
      const g = near ? pinesNear : pinesFar, wS = (0.9 + 0.25 * hash(i, 3, 3)) * Math.sqrt(s);
      g.push([t.x, t.y - 0.3, t.z, T * s], [...c, id], [t.yaw, wS, 1, wS]);
      if (near && d < V.trunkFar) trunks.push([t.x, t.y - 0.3, t.z, T], [...hex3("#6e4c38"), id], [0, 0.028, 0.3, 0.028]);
      if (d < V.poolFar) pool(pools, w, L, t.x, t.z, undefined, T * 0.3, T * 0.42, T * 0.3, seed);
      return;
    }
    const K = TREE[t.kind], R = K.r * T, cy = t.y + T * K.base + R * K.stretch;
    if (d < V.trunkFar) trunks.push([t.x, t.y - 0.2, t.z, T], [...hex3("#6e4c38"), id], [0, 0.03, K.base + 0.2, 0.03]);
    if (d < V.poolFar) pool(pools, w, L, t.x, t.z, undefined, T * 0.35, R * 1.45, R * 1.0, seed);
    if (!near) {
      lobes.push([t.x, cy, t.z, R * 1.05 * s], [...c, id], [0, CLS.crown, seed, 0.7]);
      return;
    }
    const n = K.n, rot = seed * 6.283;
    lobes.push([t.x, cy, t.z, R * 0.8], [...c, id], [0.05, CLS.crown, seed, 1]);
    for (let k = 1; k < n; k++) {
      const a = rot + (k / (n - 1)) * 6.283, hr = R * (0.5 + 0.18 * hash(i, k, 21)), dy = (hash(i, k, 22) - 0.45) * R * K.stretch * 1.1;
      const off = t.kind === "aspen" ? R * 0.3 : R * 0.58;
      lobes.push([t.x + Math.cos(a) * off, cy + dy, t.z + Math.sin(a) * off, hr], [...c, id], [dy / (R * K.stretch) * 0.35 - 0.05, CLS.crown, hash(i, k, 23), 1]);
    }
    lobes.push([t.x + (seed - 0.5) * R * 0.4, cy + R * K.stretch * 0.62, t.z, R * 0.55], [...c, id], [0.15, CLS.crown, hash(i, 31, 3), 1]);
  });

  const heathC = hex3("#9c7489"), shrubC = hex3("#7f9c4e"), shrubC2 = hex3("#96a653");
  w.shrubs.forEach((b0, i) => {
    const b = E === 1 ? b0 : { ...b0, y: b0.y * E };
    const d = Math.hypot(b.x - cam.x, b.y - cam.y, b.z - cam.z);
    if (d > V.shrubFar || !visible(b.x, b.y, b.z, b.tall * 2)) return;
    const s = keep(d, i, 4);
    if (!s) return;
    const c = mixc(mixc(shrubC, shrubC2, b.tint), heathC, Math.min(1, b.heath * 1.3)), id = 1 + Math.floor(hash(i, 5, 8) * 2000), R = b.tall * 0.62 * V.shrubScale;
    const n = d < V.lobeFar ? 1 + Math.floor(hash(i, 1, 9) * 3) : 1;
    for (let k = 0; k < n; k++) {
      const a = b.yaw + k * 2.1, o = k ? R * 0.6 : 0;
      lobes.push([b.x + Math.cos(a) * o, b.y + R * (k ? 0.45 : 0.62), b.z + Math.sin(a) * o, R * (k ? 0.72 : 1) * s], [...c, id], [k ? -0.1 : 0, CLS.shrub, hash(i, k, 10), 1]);
    }
  });

  const rockC = hex3("#a8a195"), rockC2 = hex3("#948e89");
  w.rocks.forEach((r, i) => {
    const d = Math.hypot(r.x - cam.x, r.y - cam.y, r.z - cam.z);
    if (d > V.rockFar || !visible(r.x, r.y, r.z, r.size * 2)) return;
    rocks.push([r.x, r.y - r.size * 0.12, r.z, r.size * 0.55], [...mixc(rockC, rockC2, r.tint), 1 + Math.floor(hash(i, 3, 12) * 2000)], [r.yaw, 1, 0.62, 0.85]);
  });

  if (E === 1) reeds(w, V, cam, visible, blades);

  const out = [];
  const plane = new THREE.PlaneGeometry(1, 1);
  const lobeMat = mat(LOBE_VS, LOBE_FS, { ...common, uLightV: { value: lightV } });
  const add = (batch, base, material, order) => {
    if (!batch.count) return;
    const m = new THREE.Mesh(batch.geometry(base), material);
    m.frustumCulled = false;
    m.renderOrder = order;
    out.push(m);
  };
  const solid = (cls, sh1, sh2, jit = 1, side = THREE.FrontSide) => mat(SOLID_VS, SOLID_FS, { ...common, uCls: { value: cls }, uSh1: { value: hex3(sh1) }, uSh2: { value: hex3(sh2) }, uJit: { value: jit } }, { side });
  add(lobes, plane, lobeMat, 1);
  if (pools.count) out.push(poolMesh(pools));
  add(pinesNear, pineGeometry(4, 8), solid(CLS.crown, "#7c86ad", "#606c92", 1, THREE.DoubleSide), 1);
  add(pinesFar, pineGeometry(2, 5), solid(CLS.crown, "#7c86ad", "#606c92", 1, THREE.DoubleSide), 1);
  add(trunks, trunkGeometry(), solid(CLS.wood, "#8a7c9a", "#6c6484"), 2);
  add(rocks, rockGeometry(), solid(CLS.rock, "#8e86ad", "#6f6990"), 2);
  add(blades, bladeGeometry(9, 0.45, 0.035), solid(CLS.blade, "#8a86a0", "#77738f", 0, THREE.DoubleSide), 3);
  return out;
}

// Reeds in marshy ground and along the fresh water's edge, placed from the covers on the fine grid.
function reeds(w, V, cam, visible, batch) {
  if (!V.reedFar) return;
  const { M, STEP, START, cover, wet, h, isle, N, CELL } = w;
  const u0 = Math.max(0, Math.floor((cam.x - V.reedFar - START) / STEP)), u1 = Math.min(M - 1, Math.ceil((cam.x + V.reedFar - START) / STEP));
  const v0 = Math.max(0, Math.floor((cam.z - V.reedFar - START) / STEP)), v1 = Math.min(M - 1, Math.ceil((cam.z + V.reedFar - START) / STEP));
  const reedC = hex3("#9aa25a"), reedC2 = hex3("#b7a05c");
  for (let v = v0; v < v1; v++)
    for (let u = u0; u < u1; u++) {
      const i = v * M + u, x0 = START + u * STEP, z0 = START + v * STEP;
      const salt = w.bilinear(isle.salt, (x0 - START) / CELL, (z0 - START) / CELL);
      const shore = wet[i] > 0.08 && wet[i] < 0.75 && h[i] > -0.2 && h[i] < 2.5 && salt < 0.45 ? 1 : 0;
      const want = cover.marsh[i] * 5 + shore * 5;
      for (let n = Math.floor(want + hash(u, v, 41)); n > 0; n--) {
        const x = x0 + hash(u * 7 + n, v, 42) * STEP, z = z0 + hash(u, v * 7 + n, 43) * STEP, y = w.heightAt(x, z);
        if (y < -0.25 || w.slopeAt(x, z) > 0.3) continue;
        const d = Math.hypot(x - cam.x, y - cam.y, z - cam.z);
        if (d > V.reedFar || !visible(x, y, z, 3)) continue;
        const tint = hash(u + n, v, 44);
        batch.push([x, Math.max(y, 0) - 0.1, z, (1.2 + tint * 1.3) * V.reedScale], [...mixc(reedC, reedC2, tint), 0], [tint * 6.283, 1, 1, 1]);
      }
    }
}

// Grass tufts, flowers, pebbles and fallen wood round the camp, from the world's close scatter.
export function closeGround(w, common, V, lightV) {
  if (!V.nearbyR) return [];
  const near = w.nearby(w.camp.at, V.nearbyR, V.nearbyDensity);
  const tufts = new Batch(), flowers = new Batch(), pebbles = new Batch(), logs = new Batch();
  const gC = hex3("#6f9a3f"), gC2 = hex3("#9aad4c"), gC3 = hex3("#b9ad62");
  near.grass.forEach((g, i) => tufts.push([g.x, g.y - 0.02, g.z, g.tall * 0.85 * V.tuftScale], [...mixc(g.tint < 0.55 ? gC : gC2, gC3, g.tint > 0.85 ? 0.7 : 0), 0], [g.yaw, 1, 1, 1]));
  const FL = ["#d8473a", "#f4eee0", "#e8c24a", "#9a6fb8", "#e27aa0"].map(hex3);
  near.flowers.forEach((f, i) => flowers.push([f.x, f.y + f.tall, f.z, 0.055], [...FL[Math.floor(f.hue * FL.length) % FL.length], 0], [0, CLS.flower, f.hue, 0.3]));
  const pc = hex3("#a9a298");
  near.pebbles.forEach((p, i) => pebbles.push([p.x, p.y - p.size * 0.15, p.z, p.size * 0.5], [...mixc(pc, hex3("#8f8a86"), p.tint), 1 + Math.floor(hash(i, 1, 77) * 2000)], [p.yaw, 1, 0.6, 0.85]));
  near.logs.forEach((l, i) => logs.push([l.x, l.y + 0.15, l.z, 1], [...hex3("#80614a"), 1 + Math.floor(hash(i, 2, 78) * 2000)], [l.yaw, l.length, 0.22, 0.22]));
  const out = [];
  const add = (batch, base, material, order) => {
    if (!batch.count) return;
    const m = new THREE.Mesh(batch.geometry(base), material);
    m.frustumCulled = false;
    m.renderOrder = order;
    out.push(m);
  };
  const solid = (cls, sh1, sh2, jit = 1, side = THREE.FrontSide) => mat(SOLID_VS, SOLID_FS, { ...common, uCls: { value: cls }, uSh1: { value: hex3(sh1) }, uSh2: { value: hex3(sh2) }, uJit: { value: jit } }, { side });
  add(tufts, bladeGeometry(6, 0.5, 0.045), solid(CLS.blade, "#8a86a0", "#77738f", 0, THREE.DoubleSide), 3);
  add(flowers, new THREE.PlaneGeometry(1, 1), mat(LOBE_VS, LOBE_FS, { ...common, uLightV: { value: lightV } }), 3);
  add(pebbles, rockGeometry(), solid(CLS.rock, "#8e86ad", "#6f6990"), 2);
  // logs are unit cylinders along x, scaled by length and radius
  const logG = withShade(new THREE.CylinderGeometry(1, 1, 1, 7).rotateZ(Math.PI / 2).toNonIndexed(), () => 0);
  logG.computeVertexNormals();
  add(logs, logG, solid(CLS.wood, "#8a7c9a", "#6c6484"), 2);
  return out;
}
