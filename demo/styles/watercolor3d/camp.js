// The camp from the world's data: painted cone tents with poles and a banded hem, the fire with its stone ring, flames
// and smoke drifting downwind, the woodpile, the trodden earth, and five people round the fire.
import * as THREE from "three";
import { hash } from "../world.js";
import { COLORS } from "../island.js";
import { NOISE, OUT, CLS, hex3, vec3 } from "./glsl.js";
import { Batch, pool, poolMesh } from "./flora.js";

const PROP_VS = `
in vec3 aCol; in float aShade;
out vec3 vN; out vec3 vW; out float vD; out vec3 vCol; out float vS; out vec3 vL;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vW = wp.xyz; vL = position; vN = mat3(modelMatrix) * normal; vCol = aCol; vS = aShade;
  vec4 v = viewMatrix * wp;
  vD = -v.z;
  gl_Position = projectionMatrix * v;
}`;

const PROP_FS = `
precision highp float;
${NOISE}
${OUT}
uniform float uId, uCls, uJit;
uniform vec3 uSh1, uSh2;
in vec3 vN; in vec3 vW; in float vD; in vec3 vCol; in float vS; in vec3 vL;
void main() {
  vec3 n = normalize(vN);
  if (!gl_FrontFacing) n = -n;
  float s = dot(n, uLight) * 0.8 + 0.2 * n.y + vS;
  float j = uJit * (0.12 * gnoise(vL.xz * 4.0 + vL.y * 5.0 + uId) + 0.05 * gnoise(vL.xy * 15.0));
  vec3 c = over(vCol, uSh1, 0.85 * cut(-0.02 + j - s));
  c = over(c, uSh2, 0.55 * cut(-0.5 + j - s));
  emit(c, uId, vD, uCls, 0.0, vW);
}`;

// A painted hide tent: flat facets, a door opening toward the fire, stitched seams, a banded hem and a smoke flap.
const TENT_FS = `
precision highp float;
${NOISE}
${OUT}
uniform float uId, uH, uSeg;
uniform vec3 uCol, uBand, uSh1, uSh2;
in vec3 vN; in vec3 vW; in float vD; in vec3 vCol; in float vS; in vec3 vL;
const vec3 DOOR = ${vec3("#5a4640")};
void main() {
  vec3 n = normalize(vN);
  float y = vL.y / uH, th = atan(vL.x, vL.z);
  float s = dot(n, uLight) * 0.8 + 0.2 * n.y;
  float j = 0.1 * gnoise(vL.xy * 3.0 + uId) + 0.04 * gnoise(vL.zy * 11.0);
  vec3 c = uCol;
  float zig = abs(fract(th * uSeg / 3.14159 + 0.25) - 0.5);
  float band = cut(y - 0.17 - 0.035 * zig) * cut(0.25 + 0.035 * zig - y);
  c = mix(c, uBand, band);
  c = over(c, uBand, 0.45 * cut(0.05 - y));
  c = over(c, ${vec3("#6d5a4e")}, 0.5 * cut(y - 0.86));
  c = over(c, uSh1, 0.85 * cut(-0.02 + j - s));
  c = over(c, uSh2, 0.5 * cut(-0.45 + j - s));
  float halfW = 0.34 * (1.0 - y / 0.56);
  float door = cut(halfW - abs(th));
  if (!gl_FrontFacing) door = 1.0;
  c = mix(c, DOOR, door);
  // seams where the hides are stitched, and a pen line round the door
  float seam = abs(fract(th * uSeg / 6.28318) - 0.5) * 2.0;
  float seamL = 1.0 - smoothstep(0.0, 1.2, (1.0 - seam) / max(fwidth(seam), 1e-4));
  float doorL = 1.0 - smoothstep(0.4, 1.3, abs(halfW - abs(th)) / max(fwidth(th), 1e-4));
  float ink = max(seamL * 0.45 * step(y, 0.9), doorL * step(0.0, halfW) * 0.9) * float(gl_FrontFacing);
  emit(c, uId, vD, ${CLS.tent}.0, ink, vW);
}`;

const FLAME_VS = `
in vec4 iA; in vec4 iB;
out vec2 vUv; out float vD; out vec3 vW; out float vSeed;
void main() {
  vec4 c = viewMatrix * vec4(iA.xyz, 1.0);
  vec3 p = c.xyz + vec3(position.x * iA.w * 0.75, (position.y + 0.5) * iA.w, 0.25);
  vUv = vec2(position.x * 2.0, position.y + 0.5);
  vD = -p.z; vW = iA.xyz; vSeed = iB.x;
  gl_Position = projectionMatrix * vec4(p, 1.0);
}`;

const FLAME_FS = `
precision highp float;
${NOISE}
${OUT}
in vec2 vUv; in float vD; in vec3 vW; in float vSeed;
const vec3 RIM = ${vec3("#e0553a")}, MID = ${vec3("#f29a38")}, CORE = ${vec3("#fbd968")};
void main() {
  float u = vUv.x, v = vUv.y;
  float W = 0.95 * pow(v, 0.4) * pow(1.0 - v, 0.85) * (1.0 + 0.4 * gnoise(vec2(u * 2.0, v * 2.5 - vSeed * 9.0)));
  float f = W - abs(u + 0.12 * sin(v * 5.0 + vSeed * 6.0) * v);
  if (f < 0.0) discard;
  if (v > 0.42 && gnoise(vec2(u * 4.0 + vSeed * 3.0, v * 1.6)) > 0.35) discard;
  float t = f / max(W, 1e-3);
  vec3 c = mix(RIM, MID, smoothstep(0.15, 0.35, t));
  c = mix(c, CORE, smoothstep(0.5, 0.7, t) * smoothstep(0.85, 0.35, v));
  emit(c, 2001.0 + vSeed, vD, ${CLS.fire}.0, 0.0, vW);
}`;

const SMOKE_FS = `
precision highp float;
${NOISE}
layout(location = 0) out vec4 oCol;
layout(location = 1) out vec4 oInfo;
layout(location = 2) out vec4 oAux;
in vec2 vUv; in float vD; in vec3 vW; in float vSeed;
const vec3 SMOKE = ${vec3("#a9a8bd")};
void main() {
  vec2 q = vec2(vUv.x, vUv.y * 2.0 - 1.0);
  float r = length(q) + 0.28 * gnoise(q * 1.7 + vSeed * 11.0) + 0.08 * gnoise(q * 6.0 + vSeed);
  float a = smoothstep(1.0, 0.7, r) * 0.5;
  if (a < 0.01) discard;
  oCol = vec4(SMOKE, a);
  oInfo = vec4(0.0);
  oAux = vec4(0.0);
}`;

const mat = (vs, fs, uniforms, extra = {}) => new THREE.ShaderMaterial({ glslVersion: THREE.GLSL3, vertexShader: vs, fragmentShader: fs, uniforms, ...extra });

// Non-indexed parts with a per-vertex pigment and shade bias, merged into one geometry.
function paint(g, hexc, shade = 0) {
  const f = g.index ? g.toNonIndexed() : g;
  f.deleteAttribute("uv");
  const c = hex3(hexc), n = f.attributes.position.count;
  f.setAttribute("aCol", new THREE.BufferAttribute(new Float32Array(n * 3).map((_, i) => c[i % 3]), 3));
  f.setAttribute("aShade", new THREE.BufferAttribute(new Float32Array(n).fill(shade), 1));
  return f;
}
function merge(parts) {
  const n = parts.reduce((s, g) => s + g.attributes.position.count, 0), out = new THREE.BufferGeometry();
  for (const [name, size] of [["position", 3], ["normal", 3], ["aCol", 3], ["aShade", 1]]) {
    const arr = new Float32Array(n * size);
    let o = 0;
    for (const g of parts) { arr.set(g.attributes[name].array, o); o += g.attributes[name].array.length; }
    out.setAttribute(name, new THREE.BufferAttribute(arr, size));
  }
  return out;
}
// A tapered round limb from a to b.
function limb(a, b, r0, r1, hexc, seg = 7) {
  const A = new THREE.Vector3(...a), B = new THREE.Vector3(...b), d = B.clone().sub(A), L = d.length();
  const g = new THREE.CylinderGeometry(r1, r0, L, seg, 1, false);
  g.translate(0, L / 2, 0);
  g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize()));
  g.translate(A.x, A.y, A.z);
  return paint(g, hexc);
}
function ball(c, r, hexc, sy = 1, shade = 0) {
  const g = new THREE.SphereGeometry(r, 12, 9);
  g.scale(1, sy, 1);
  g.translate(...c);
  return paint(g, hexc, shade);
}

const SKIN = ["#d9a27c", "#c68a64", "#e0b08c", "#b37a58", "#d49b74"], HAIR = ["#4a3526", "#2f2622", "#7a4a2a", "#5a4030", "#3a2c24"];

// People face +z. Poses: standing, sitting cross-legged, kneeling to tend the fire with one arm out.
function person(k, pose) {
  const lift = (h) => "#" + [1, 3, 5].map((i) => Math.round(parseInt(h.slice(i, i + 2), 16) * 0.62 + 255 * 0.38).toString(16).padStart(2, "0")).join("");
  const cloth = lift(COLORS[[0, 2, 8, 5, 3][k % 5]]), cloth2 = lift(COLORS[[6, 4, 11, 1, 7][k % 5]]);
  const legs = "#6e5a4c", skin = SKIN[k % 5], hair = HAIR[k % 5], P = [];
  if (pose === "stand") {
    // one wears a long cloak, another leans on a staff
    const staff = k % 2 === 0 && k > 0, hand = staff ? [0.3, 1.08, 0.16] : [0.24, 0.9, 0.12];
    P.push(limb([-0.09, 0, 0], [-0.1, 0.84, 0], 0.07, 0.085, legs), limb([0.09, 0, 0.02], [0.1, 0.84, 0], 0.07, 0.085, legs));
    P.push(limb([0, 0.72, 0], [0, 1.4, 0], 0.235, 0.17, cloth, 9));
    P.push(limb([-0.2, 1.36, 0], [-0.25, 0.88, 0.1], 0.06, 0.055, cloth), limb([0.2, 1.36, 0], hand, 0.06, 0.055, cloth));
    P.push(ball([-0.25, 0.86, 0.1], 0.05, skin), ball(hand, 0.05, skin));
    P.push(limb([0, 1.36, 0], [0, 1.44, 0], 0.08, 0.06, skin), ball([0, 1.56, 0.01], 0.125, skin, 1.08), ball([0, 1.6, -0.03], 0.13, hair, 0.9, 0.1));
    P.push(limb([-0.19, 1.3, -0.02], [0.19, 1.3, -0.02], 0.05, 0.05, cloth2, 6), limb([0, 0.98, 0], [0, 1.02, 0], 0.232, 0.232, cloth2, 9));
    if (staff) P.push(limb([0.32, 0, 0.2], [0.29, 1.9, 0.14], 0.025, 0.02, "#6e4c38", 5));
    else P.push(limb([0, 0.42, -0.04], [0, 1.4, -0.03], 0.33, 0.2, cloth2, 10));
  } else if (pose === "sit") {
    P.push(limb([-0.1, 0.1, 0], [-0.2, 0.2, 0.38], 0.08, 0.075, legs), limb([0.1, 0.1, 0], [0.2, 0.2, 0.38], 0.08, 0.075, legs));
    P.push(limb([-0.2, 0.2, 0.38], [0.06, 0.07, 0.48], 0.07, 0.06, legs), limb([0.2, 0.2, 0.38], [-0.06, 0.07, 0.5], 0.07, 0.06, legs));
    P.push(limb([0, 0.05, -0.02], [0, 0.66, 0.06], 0.24, 0.17, cloth, 9));
    P.push(limb([-0.2, 0.62, 0.06], [-0.2, 0.3, 0.34], 0.06, 0.055, cloth), limb([0.2, 0.62, 0.06], [0.2, 0.3, 0.34], 0.06, 0.055, cloth));
    P.push(limb([0, 0.62, 0.06], [0, 0.7, 0.07], 0.08, 0.06, skin), ball([0, 0.82, 0.09], 0.125, skin, 1.08), ball([0, 0.86, 0.05], 0.13, hair, 0.9, 0.1));
    P.push(limb([-0.19, 0.58, 0.04], [0.19, 0.58, 0.04], 0.05, 0.05, cloth2, 6));
  } else {
    P.push(limb([-0.1, 0.05, -0.3], [-0.1, 0.12, 0.08], 0.075, 0.08, legs), limb([-0.1, 0.12, 0.08], [-0.1, 0.5, 0.02], 0.08, 0.085, legs));
    P.push(limb([0.1, 0.02, -0.25], [0.12, 0.45, 0.12], 0.075, 0.085, legs));
    P.push(limb([0, 0.45, 0], [0, 1.02, 0.2], 0.23, 0.17, cloth, 9));
    P.push(limb([-0.2, 0.98, 0.18], [-0.26, 0.6, 0.3], 0.06, 0.055, cloth), limb([0.2, 0.98, 0.18], [0.22, 0.75, 0.62], 0.06, 0.05, cloth));
    P.push(limb([0.22, 0.75, 0.62], [0.24, 0.55, 1.05], 0.022, 0.02, "#6e4c38", 5));
    P.push(limb([0, 0.98, 0.18], [0, 1.06, 0.22], 0.08, 0.06, skin), ball([0, 1.17, 0.26], 0.125, skin, 1.08), ball([0, 1.21, 0.22], 0.13, hair, 0.9, 0.1));
    P.push(limb([-0.19, 0.92, 0.16], [0.19, 0.92, 0.16], 0.05, 0.05, cloth2, 6));
  }
  return merge(P);
}

function tentGeometry(size, seg) {
  const R = size * 0.52, H = size * 1.12;
  const g = new THREE.ConeGeometry(R, H, seg, 1, true).translate(0, H / 2, 0).toNonIndexed();
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) if (p.getY(i) < 0.01) p.setY(i, -0.15);
  g.computeVertexNormals();
  g.deleteAttribute("uv");
  return { g, R, H };
}

export function camp(w, common, V) {
  const out = [], C = w.camp, E = V.exag, sh = (a, b) => ({ uSh1: { value: hex3(a) }, uSh2: { value: hex3(b) } });
  const propMat = (id, cls, jit = 1) => mat(PROP_VS, PROP_FS, { ...common, uId: { value: id }, uCls: { value: cls }, uJit: { value: jit }, ...sh("#857ca8", "#6a628c") });
  const place = (geom, material, at, yaw = 0, order = 2) => {
    const m = new THREE.Mesh(geom, material);
    m.position.set(at.x, at.y * E, at.z);
    m.rotation.y = yaw;
    m.renderOrder = order;
    m.frustumCulled = false;
    out.push(m);
    return m;
  };
  const TENT = [["#dcc39a", "#a8553a"], ["#c28262", "#3f6a7a"], ["#a9b089", "#8a4a36"]];
  C.tents.forEach((t, k) => {
    const seg = 9, { g, R, H } = tentGeometry(t.size, seg);
    const [c0, band] = TENT[k % 3];
    const tm = mat(PROP_VS, TENT_FS, { ...common, uId: { value: 2100 + k }, uH: { value: H }, uSeg: { value: seg }, uCol: { value: hex3(c0) }, uBand: { value: hex3(band) }, ...sh("#8c7ea6", "#6c6288") }, { side: THREE.DoubleSide });
    place(g, tm, { x: t.at.x, y: t.at.y - 0.05, z: t.at.z }, t.yaw);
    // poles crossing at the top and sticking out past the smoke flap
    const poles = [];
    for (let q = 0; q < 6; q++) {
      const a = (q / 6) * 6.283 + 0.5, bx = Math.sin(a) * R * 0.92, bz = Math.cos(a) * R * 0.92;
      poles.push(limb([bx, -0.1, bz], [-bx * 0.32, H * 1.3, -bz * 0.32], 0.035, 0.025, "#6e4c38", 5));
    }
    place(merge(poles), propMat(2110 + k, CLS.wood, 0), { x: t.at.x, y: t.at.y, z: t.at.z }, t.yaw);
  });

  const pools = new Batch(), L = common.uLight.value;
  C.tents.forEach((t, k) => pool(pools, w, L, t.at.x, t.at.z, t.at.y, t.size * 0.45, t.size * 0.95, t.size * 0.62, k * 0.3));
  C.people.forEach((p, k) => pool(pools, w, L, p.at.x, p.at.z, p.at.y + 0.02, 0.35, 0.5, 0.34, k * 0.7));
  pool(pools, w, L, C.woodpile.x, C.woodpile.z, C.woodpile.y, 0.4, 0.95, 0.6, 5);
  if (E === 1) out.push(poolMesh(pools));
  const poses = ["stand", "sit", "kneel", "sit", "stand"];
  if (E !== 1) C.people.length = 0;
  C.people.forEach((p, k) => place(person(k, poses[k]), propMat(2200 + k, CLS.person), p.at, p.yaw));

  // fire: a ring of stones, a teepee of sticks, the flames, and the trodden, ashy ground under it
  const F = C.fire, stones = [], sticks = [];
  for (let q = 0; q < 11; q++) {
    const a = (q / 11) * 6.283, r = 0.62 + 0.05 * hash(q, 1, 61), s = 0.12 + 0.06 * hash(q, 2, 61);
    const g = new THREE.IcosahedronGeometry(s, 0);
    g.scale(1.2, 0.75, 1);
    g.rotateY(hash(q, 3, 61) * 6);
    g.translate(Math.cos(a) * r, s * 0.35, Math.sin(a) * r);
    stones.push(paint(g, hash(q, 4, 61) < 0.5 ? "#a39d94" : "#8f8a88"));
  }
  for (let q = 0; q < 5; q++) {
    const a = (q / 5) * 6.283 + 0.3;
    sticks.push(limb([Math.cos(a) * 0.45, 0.02, Math.sin(a) * 0.45], [Math.cos(a) * 0.04, 0.55, Math.sin(a) * 0.04], 0.05, 0.035, q % 2 ? "#5e4232" : "#74553f", 6));
  }
  place(merge(stones), propMat(2301, CLS.rock), F);
  place(merge(sticks), propMat(2302, CLS.wood), F);
  const ground = (r0, hexc, id, rag) => {
    const seg = 48, pos = [], cols = hex3(hexc), g = new THREE.BufferGeometry(), P = [], idx = [];
    P.push(0, w.heightAt(F.x, F.z) - F.y + 0.06, 0);
    for (let q = 0; q < seg; q++) {
      const a = (q / seg) * 6.283, r = r0 * (1 + rag * (0.5 * Math.sin(a * 3 + id) + 0.3 * Math.sin(a * 7 + id * 2) + 0.2 * (hash(q, id, 9) - 0.5)));
      const x = Math.cos(a) * r, z = Math.sin(a) * r;
      P.push(x, w.heightAt(F.x + x, F.z + z) - F.y + 0.06, z);
      idx.push(0, 1 + q, 1 + ((q + 1) % seg));
    }
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(P), 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    const f = paint(g, hexc, 0.3);
    const m = mat(PROP_VS, PROP_FS, { ...common, uId: { value: 0 }, uCls: { value: CLS.ground }, uJit: { value: 1 }, ...sh("#9a90b0", "#857ca8") }, { polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2 - id, side: THREE.DoubleSide });
    place(f, m, F, 0, 6);
  };
  ground(3.1, "#c7ae8a", 1, 0.12);
  ground(0.95, "#8d8078", 2, 0.1);

  const flames = [[0, 1.25, 0.1], [0.12, 0.85, 0.7], [-0.14, 0.75, 0.35], [0.02, 0.55, 0.9]];
  const fg = new THREE.InstancedBufferGeometry(), plane = new THREE.PlaneGeometry(1, 1);
  fg.index = plane.index;
  fg.setAttribute("position", plane.attributes.position);
  fg.setAttribute("iA", new THREE.InstancedBufferAttribute(new Float32Array(flames.flatMap(([dx, hgt]) => [F.x + dx, F.y + 0.08, F.z + dx * 0.5, hgt])), 4));
  fg.setAttribute("iB", new THREE.InstancedBufferAttribute(new Float32Array(flames.flatMap(([, , s]) => [s, 0, 0, 0])), 4));
  fg.instanceCount = flames.length;
  const fm = new THREE.Mesh(fg, mat(FLAME_VS, FLAME_FS, { ...common }, { side: THREE.DoubleSide }));
  fm.frustumCulled = false;
  fm.renderOrder = 2;
  out.push(fm);

  // smoke rises and leans downwind, spreading as it goes
  const wind = w.isle.wind, puffs = [];
  for (let q = 0; q < V.smokePuffs; q++) {
    const t = q / (V.smokePuffs - 1), up = 1.6 + t * t * V.smokeRise + t * V.smokeRise * 0.25, drift = t * t * V.smokeRise * 0.9;
    const wob = Math.sin(q * 1.7) * 0.6 * t;
    puffs.push(F.x + wind[0] * drift + wob, F.y * E + up, F.z + wind[1] * drift + wob * 0.5, (0.35 + t * V.smokeRise * 0.2) * 2, hash(q, 5, 71), 0, 0, 0);
  }
  const sg = new THREE.InstancedBufferGeometry();
  sg.index = plane.index;
  sg.setAttribute("position", plane.attributes.position);
  sg.setAttribute("iA", new THREE.InstancedBufferAttribute(new Float32Array(puffs.filter((_, i) => i % 8 < 4)), 4));
  sg.setAttribute("iB", new THREE.InstancedBufferAttribute(new Float32Array(puffs.filter((_, i) => i % 8 >= 4)), 4));
  sg.instanceCount = V.smokePuffs;
  const sm = new THREE.Mesh(sg, mat(FLAME_VS.replace("(position.y + 0.5) * iA.w", "position.y * iA.w"), SMOKE_FS, {}, {
    transparent: true, depthWrite: false, blending: THREE.CustomBlending, blendEquation: THREE.AddEquation,
    blendSrc: THREE.SrcAlphaFactor, blendDst: THREE.OneMinusSrcAlphaFactor, blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor,
  }));
  sm.frustumCulled = false;
  sm.renderOrder = 20;
  out.push(sm);

  // the woodpile: split logs stacked in rows, pale cut ends out
  const WP = C.woodpile, logs = [], yawW = Math.atan2(F.x - WP.x, F.z - WP.z) + Math.PI / 2;
  const rows = [5, 4, 3, 2];
  rows.forEach((n, r) => {
    for (let q = 0; q < n; q++) {
      const x = (q - (n - 1) / 2) * 0.25 + (hash(q, r, 81) - 0.5) * 0.03, y = 0.11 + r * 0.2;
      const g = new THREE.CylinderGeometry(0.11, 0.11, 1.1 + 0.15 * hash(q, r, 82), 8, 1, false);
      g.rotateX(Math.PI / 2);
      g.translate(x, y, (hash(q, r, 83) - 0.5) * 0.1);
      const f = g.toNonIndexed(), n2 = f.attributes.normal, c = new Float32Array(f.attributes.position.count * 3), bark = hex3(hash(q, r, 84) < 0.5 ? "#7a5a44" : "#6a4d3b"), cut = hex3("#d8b98e");
      for (let i = 0; i < n2.count; i++) c.set(Math.abs(n2.getZ(i)) > 0.9 ? cut : bark, i * 3);
      f.deleteAttribute("uv");
      f.setAttribute("aCol", new THREE.BufferAttribute(c, 3));
      f.setAttribute("aShade", new THREE.BufferAttribute(new Float32Array(n2.count), 1));
      logs.push(f);
    }
  });
  place(merge(logs), propMat(2400, CLS.wood), WP, yawW);
  return out;
}
