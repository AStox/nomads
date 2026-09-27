// The stage: faceted ground from the world's heights, flat dark water that only catches the moon and the fire, and a
// painted night sky. Everything is flat shaded; light and fog do the rest.
import * as THREE from "three";
import { hash, smooth, clamp } from "../world.js";

const lin = (hex) => new THREE.Color(hex);
export const PAL = {
  grass: lin("#4e5745"), floor: lin("#343d33"), shrub: lin("#4d4c3e"), marsh: lin("#3d4b45"), bare: lin("#625d54"),
  sand: lin("#77715f"), rock: lin("#615d63"), wet: lin("#2c373a"), trod: lin("#5b4f40"),
};

// Ground color for a face centred at (x, z) whose normal has vertical part ny: a weighted mix of the covers there,
// rock on steep faces, and darker hollows where little sky is seen.
function groundColor(w, x, z, ny, out) {
  const f = (k) => w.fine(w.cover[k], x, z);
  const t = f("tree"), s = f("shrub"), g = f("grass"), m = f("marsh"), b = f("bare"), sd = f("sand");
  out.setRGB(0, 0, 0);
  const add = (c, k) => { out.r += c.r * k; out.g += c.g * k; out.b += c.b * k; };
  add(PAL.floor, t); add(PAL.shrub, s); add(PAL.grass, g); add(PAL.marsh, m); add(PAL.bare, b); add(PAL.sand, sd);
  const sum = t + s + g + m + b + sd || 1;
  out.multiplyScalar(1 / sum);
  const h = w.heightAt(x, z);
  out.lerp(PAL.sand, smooth(2.2, 0.6, h) * 0.7);
  out.lerp(PAL.wet, clamp(w.fine(w.wet, x, z) * 1.5 + w.riverAt(x, z), 0, 1) * 0.8);
  out.lerp(PAL.rock, smooth(0.86, 0.6, ny));
  const sky = w.fine(w.sky, x, z);
  out.multiplyScalar((0.5 + 0.5 * sky) * (0.9 + 0.2 * hash(Math.round(x * 7.1), Math.round(z * 7.3), 5)));
  return out;
}

// A grid of jittered vertices over box, split into flat triangles with alternating diagonals. `skip(x, z)` drops quads
// another, finer mesh covers; `tint(x, z, color)` lets a view darken or warm the ground (the camp's trodden earth).
export function ground(w, { x0, z0, x1, z1 }, step, { skip, tint, drop = 0, jitter = 0.34 } = {}) {
  const i0 = Math.floor(x0 / step), i1 = Math.ceil(x1 / step), j0 = Math.floor(z0 / step), j1 = Math.ceil(z1 / step);
  const nx = i1 - i0 + 1, nz = j1 - j0 + 1, P = new Float32Array(nx * nz * 3);
  for (let j = 0; j < nz; j++)
    for (let i = 0; i < nx; i++) {
      const gi = i0 + i, gj = j0 + j, edge = i === 0 || j === 0 || i === nx - 1 || j === nz - 1;
      const x = gi * step + (edge ? 0 : (hash(gi, gj, 11) - 0.5) * jitter * step), z = gj * step + (edge ? 0 : (hash(gi, gj, 12) - 0.5) * jitter * step);
      const o = (j * nx + i) * 3;
      P[o] = x; P[o + 1] = w.heightAt(x, z) - drop; P[o + 2] = z;
    }
  const pos = [], col = [], c = new THREE.Color(), a = new THREE.Vector3(), b = new THREE.Vector3(), e = new THREE.Vector3(), n = new THREE.Vector3();
  const tri = (p, q, r) => {
    a.fromArray(P, p); b.fromArray(P, q); e.fromArray(P, r);
    if (a.y < -6 && b.y < -6 && e.y < -6) return;
    n.subVectors(e, b).cross(a.clone().sub(b)).normalize();
    if (n.y < 0) n.negate();
    const cx = (a.x + b.x + e.x) / 3, cz = (a.z + b.z + e.z) / 3;
    groundColor(w, cx, cz, n.y, c);
    if (tint) tint(cx, cz, c);
    pos.push(a.x, a.y, a.z, b.x, b.y, b.z, e.x, e.y, e.z);
    for (let k = 0; k < 3; k++) col.push(c.r, c.g, c.b);
  };
  for (let j = 0; j < nz - 1; j++)
    for (let i = 0; i < nx - 1; i++) {
      const p00 = (j * nx + i) * 3, p10 = p00 + 3, p01 = p00 + nx * 3, p11 = p01 + 3;
      if (skip && skip(P[p00], P[p00 + 2]) && skip(P[p11], P[p11 + 2]) && skip(P[p10], P[p10 + 2]) && skip(P[p01], P[p01 + 2])) continue;
      if (hash(i0 + i, j0 + j, 13) < 0.5) { tri(p00, p01, p10); tri(p10, p01, p11); }
      else { tri(p00, p01, p11); tri(p00, p11, p10); }
    }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
  g.computeVertexNormals();
  const mesh = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true }));
  mesh.receiveShadow = true;
  return mesh;
}

// Lake surfaces: flat facets at each lake's level (the generator's bed plus standing water), laid over every fine quad
// that touches water; the ground clips them to the shore.
export function lakes(w, box) {
  const { N, CELL, START, isle } = w, lvl = new Float32Array(N * N).fill(NaN);
  for (let k = 0; k < N * N; k++) if (isle.water[k] > 0 && isle.height[k] + isle.water[k] > 0.3) lvl[k] = isle.height[k] + isle.water[k];
  for (let it = 0; it < 2; it++) {
    const next = lvl.slice();
    for (let y = 1; y < N - 1; y++)
      for (let x = 1; x < N - 1; x++) {
        const k = y * N + x;
        if (!Number.isNaN(lvl[k]) || isle.water[k] > 0) continue;
        let s = 0, c = 0;
        for (const d of [1, -1, N, -N]) if (!Number.isNaN(lvl[k + d])) { s += lvl[k + d]; c++; }
        if (c) next[k] = s / c;
      }
    lvl.set(next);
  }
  const pos = [], S = w.STEP;
  const u0 = Math.max(0, Math.floor((box.x0 - START) / S)), u1 = Math.min(w.M - 2, Math.ceil((box.x1 - START) / S));
  const v0 = Math.max(0, Math.floor((box.z0 - START) / S)), v1 = Math.min(w.M - 2, Math.ceil((box.z1 - START) / S));
  for (let v = v0; v <= v1; v++)
    for (let u = u0; u <= u1; u++) {
      const i = v * w.M + u;
      if (Math.max(w.wet[i], w.wet[i + 1], w.wet[i + w.M], w.wet[i + w.M + 1]) < 0.04) continue;
      if (Math.min(w.h[i], w.h[i + 1], w.h[i + w.M], w.h[i + w.M + 1]) < -0.5) continue;
      const x = START + (u + 0.5) * S, z = START + (v + 0.5) * S;
      const L = lvl[clamp(Math.round((z - START) / CELL), 0, N - 1) * N + clamp(Math.round((x - START) / CELL), 0, N - 1)];
      if (!(L > 0.3)) continue;
      const xa = x - S * 0.5, xb = x + S * 0.5, za = z - S * 0.5, zb = z + S * 0.5;
      pos.push(xa, L, za, xa, L, zb, xb, L, za, xb, L, za, xa, L, zb, xb, L, zb);
    }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  return g;
}

export function blurred(w, passes) {
  let h = w.h;
  const M = w.M;
  for (let it = 0; it < passes; it++) {
    const o = new Float32Array(h.length);
    for (let v = 0; v < M; v++) for (let u = 0; u < M; u++) { let s = 0, n = 0; for (let dv = -1; dv <= 1; dv++) for (let du = -1; du <= 1; du++) { const a = u + du, b = v + dv; if (a >= 0 && b >= 0 && a < M && b < M) { s += h[b * M + a]; n++; } } o[v * M + u] = s / n; }
    h = o;
  }
  return h;
}

// A contour of a fine-grid field as 1 px line segments (marching squares), lifted to height y.
export function contour(w, f, level, y, color, opacity = 1) {
  const Y = typeof y === "function" ? y : () => y;
  const M = w.M, S = w.STEP, X = (u) => w.START + u * S, pos = [];
  const cut = (a, b) => (level - a) / (b - a);
  for (let v = 0; v < M - 1; v++)
    for (let u = 0; u < M - 1; u++) {
      const a = f[v * M + u], b = f[v * M + u + 1], c = f[(v + 1) * M + u + 1], d = f[(v + 1) * M + u];
      const code = (a > level ? 1 : 0) | (b > level ? 2 : 0) | (c > level ? 4 : 0) | (d > level ? 8 : 0);
      if (code === 0 || code === 15) continue;
      const e = [];
      if ((a > level) !== (b > level)) e.push([X(u + cut(a, b)), X(v)]);
      if ((b > level) !== (c > level)) e.push([X(u + 1), X(v + cut(b, c))]);
      if ((d > level) !== (c > level)) e.push([X(u + cut(d, c)), X(v + 1)]);
      if ((a > level) !== (d > level)) e.push([X(u), X(v + cut(a, d))]);
      for (let k = 0; k + 1 < e.length; k += 2) pos.push(e[k][0], Y(e[k][0], e[k][1]), e[k][1], e[k + 1][0], Y(e[k + 1][0], e[k + 1][1]), e[k + 1][1]);
    }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  return new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color, transparent: opacity < 1, opacity, fog: true }));
}

// The fine heights as a half-float texture, so water can find its own shoreline.
export function heightTexture(w, blur = 0) {
  const h = blurred(w, blur), data = new Uint16Array(w.M * w.M);
  for (let i = 0; i < data.length; i++) data[i] = THREE.DataUtils.toHalfFloat(h[i]);
  const t = new THREE.DataTexture(data, w.M, w.M, THREE.RedFormat, THREE.HalfFloatType);
  t.magFilter = t.minFilter = THREE.LinearFilter;
  t.needsUpdate = true;
  return t;
}

const NOISE = /* glsl */ `
float h21(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
`;

// Dark water. It reflects the sky only faintly, breaks the moon and the fire into horizontal dashes along their paths,
// and draws a thin pale line where it meets the ground.
export function waterMaterial(w, U) {
  return new THREE.ShaderMaterial({
    uniforms: {
      uH: { value: U.heightTex }, uBox: { value: new THREE.Vector2(w.START, w.STEP * (w.M - 1)) },
      uMoon: { value: U.moonDir }, uMoonCol: { value: U.moonCol }, uDeep: { value: U.deep }, uHor: { value: U.skyHor }, uTop: { value: U.skyTop },
      uFog: { value: U.fogCol }, uDensity: { value: U.fogDensity }, uRight: { value: U.right }, uFwd: { value: U.fwd },
      uDash: { value: new THREE.Vector2(U.dashL, U.dashS) }, uPathW: { value: U.pathW }, uFire: { value: U.fire }, uFireCol: { value: U.fireCol },
      uFoam: { value: U.foam }, uFoamW: { value: U.foamW }, uRefl: { value: U.refl }, uLineK: { value: U.lineK ?? 1 }, uLakeGlow: { value: U.lakeGlow ?? 0 },
    },
    vertexShader: /* glsl */ `
      varying vec3 vW;
      void main() { vec4 p = modelMatrix * vec4(position, 1.0); vW = p.xyz; gl_Position = projectionMatrix * viewMatrix * p; }`,
    fragmentShader: /* glsl */ `
      uniform sampler2D uH; uniform vec2 uBox; uniform vec3 uMoon, uMoonCol, uDeep, uHor, uTop, uFog, uRight, uFwd, uFire, uFireCol, uFoam;
      uniform float uDensity, uPathW, uFoamW, uRefl, uLineK, uLakeGlow; uniform vec2 uDash;
      varying vec3 vW;
      ${NOISE}
      float dashes(vec3 R, vec3 L, float wAz, float wEl, float thin) {
        vec2 ra = normalize(R.xz), la = normalize(L.xz);
        float daz = acos(clamp(dot(ra, la), -1.0, 1.0));
        float path = exp(-pow(daz / wAz, 2.0)) * exp(-pow((R.y - L.y) / wEl, 2.0));
        vec2 q = vec2(dot(vW, uRight) / uDash.x, dot(vW, uFwd) / uDash.y);
        q.x += h21(vec2(floor(q.y), 3.1)) * 17.0;
        vec2 c = floor(q), f = fract(q);
        float r = h21(c), len = 0.3 + 0.6 * h21(c + 7.7);
        float on = step(1.0 - path * 1.15, r) * step(0.5 - len * 0.5, f.x) * step(f.x, 0.5 + len * 0.5) * step(abs(f.y - 0.5), thin);
        return on * (0.35 + 0.65 * path) + path * 0.06;
      }
      void main() {
        vec3 V = normalize(vW - cameraPosition), R = reflect(V, vec3(0.0, 1.0, 0.0));
        float fres = 0.02 + 0.98 * pow(1.0 - abs(V.y), 5.0);
        vec3 col = mix(uDeep, mix(uHor, uTop, smoothstep(0.0, 0.4, R.y)), fres * uRefl);
        if (vW.y > 0.2) col += uHor * uLakeGlow;
        col += uMoonCol * dashes(R, uMoon, uPathW, 0.16, 0.18);
        vec3 toF = uFire - vW; float dF = length(toF);
        col += uFireCol * dashes(R, toF / dF, uPathW * 0.6, 0.12, 0.2) * clamp(90.0 / dF, 0.0, 1.0);
        float h = texture2D(uH, (vW.xz - uBox.x) / uBox.y).r, depth = vW.y - h;
        float foot = fwidth(vW.x) + fwidth(vW.z), fw = max(fwidth(depth), 0.01 * foot);
        float line = (1.0 - smoothstep(0.6, 1.6, abs(depth) / fw)) * (vW.y > 0.2 ? 0.3 : 1.0) * uLineK;
        float shelf = (1.0 - smoothstep(0.0, uFoamW, depth)) * 0.03;
        col = mix(col, uFoam, clamp(line * 0.7 + shelf, 0.0, 1.0));
        float d = length(vW - cameraPosition), fog = 1.0 - exp(-uDensity * uDensity * d * d);
        gl_FragColor = vec4(mix(col, uFog, fog), 1.0);
        #include <colorspace_fragment>
      }`,
  });
}

// A painted cyclorama: near-black overhead, a pale teal band at the horizon, a violet bruise under it, and the moon.
export function sky(U) {
  const m = new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, fog: false,
    uniforms: {
      uMoon: { value: U.moonDir }, uMoonCol: { value: U.moonCol }, uTop: { value: U.skyTop }, uMid: { value: U.skyMid }, uHor: { value: U.skyHor },
      uBand: { value: U.skyBand }, uR: { value: Math.cos(U.moonSize) }, uHalo: { value: U.halo }, uHaloCol: { value: U.haloCol },
    },
    vertexShader: /* glsl */ `varying vec3 vD; void main() { vD = position; vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0); gl_Position = p.xyww; }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uMoon, uMoonCol, uTop, uMid, uHor, uBand, uHaloCol; uniform float uR, uHalo; varying vec3 vD;
      void main() {
        vec3 d = normalize(vD); float e = d.y;
        vec3 c = mix(uHor, uMid, smoothstep(0.0, 0.3, e));
        c = mix(c, uTop, smoothstep(0.12, 0.7, e));
        c = mix(c, uBand, exp(-pow((e - 0.05) / 0.1, 2.0)) * 0.35);
        if (e < 0.0) c = uHor;
        float m = dot(d, uMoon);
        c += uHaloCol * (pow(max(m, 0.0), 1400.0) * 0.6 + pow(max(m, 0.0), 120.0) * 0.14 + pow(max(m, 0.0), 12.0) * 0.035) * uHalo;
        float disc = smoothstep(uR - 0.000004, uR + 0.000004, m);
        vec3 moon = uMoonCol * (1.0 - 0.18 * smoothstep(uR + 0.00002, uR, m));
        gl_FragColor = vec4(mix(c, moon, disc), 1.0);
        #include <colorspace_fragment>
      }`,
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 24), m);
  mesh.frustumCulled = false;
  mesh.renderOrder = -10;
  mesh.onBeforeRender = (r, s, cam) => { mesh.position.copy(cam.position); mesh.scale.setScalar(cam.far * 0.9); mesh.updateMatrixWorld(); };
  return mesh;
}

// Sparse stars on a dome, dimmer toward the horizon and none near the moon.
export function stars(U, rand, n = 900) {
  const pos = [], col = [];
  for (let k = 0; k < n; k++) {
    const y = Math.pow(rand(), 0.7), a = rand() * Math.PI * 2, r = Math.sqrt(1 - y * y);
    const d = new THREE.Vector3(Math.cos(a) * r, y, Math.sin(a) * r);
    if (d.y < 0.05 || d.dot(U.moonDir) > 0.985) continue;
    const b = (0.25 + rand() ** 3 * 0.9) * smooth(0.04, 0.35, d.y);
    pos.push(d.x, d.y, d.z);
    col.push(b * 0.9, b * 0.95, b);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
  const p = new THREE.Points(g, new THREE.PointsMaterial({ size: 1.6, sizeAttenuation: false, vertexColors: true, fog: false, depthWrite: false, transparent: true }));
  p.frustumCulled = false;
  p.renderOrder = -9;
  p.onBeforeRender = (r, s, cam) => { p.position.copy(cam.position); p.scale.setScalar(cam.far * 0.85); p.updateMatrixWorld(); };
  return p;
}
