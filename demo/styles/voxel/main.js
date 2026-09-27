// Voxel diorama: the island cut out of the world as a floating square slab of cubes, lit like a MagicaVoxel render.
import * as THREE from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { ShaderPass } from "three/addons/postprocessing/ShaderPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { grow } from "../world.js";
import { Grid, SMOKE, mesh } from "./grid.js";
import { terrain } from "./terrain.js";
import { models } from "./models.js";

const fail = (e) => {
  document.body.dataset.error = String(e?.stack || e);
  document.body.classList.add("failed");
};

const params = new URLSearchParams(location.search);
const view = ["island", "valley", "camp"].includes(params.get("view")) ? params.get("view") : "valley";
const seed = Number(params.get("seed") || 1);
const log = [];
let t0 = performance.now();
const lap = (what) => { const t = performance.now(); log.push(`${what} ${Math.round(t - t0)}ms`); t0 = t; };

// Which way the woods are from the fire: the tree cover out past the clearing, weighted so thick cover dominates.
function forestward(W) {
  const f = W.camp.fire;
  let vx = 0, vz = 0;
  for (let d = 0; d < 32; d++) {
    const a = (d / 32) * Math.PI * 2;
    let s = 0;
    for (let r = 18; r <= 42; r += 4) s += W.fine(W.cover.tree, f.x + Math.cos(a) * r, f.z + Math.sin(a) * r);
    vx += Math.cos(a) * s * s;
    vz += Math.sin(a) * s * s;
  }
  const l = Math.hypot(vx, vz) || 1;
  return [vx / l, vz / l];
}

function slab(W) {
  const C = W.camp.at, up = W.camp.uphill;
  if (view === "island") return { name: "island", vox: 25, ex: 4, cx: -40, cz: 70, size: 9800, depth: 34, head: 24, frameUp: 2, bandH: 4, dirt: 1, wave: 2, el: 32, sunEl: 26, sunAz: 58 };
  if (view === "valley") return { name: "valley", vox: 2, ex: 2, cx: C.x + Math.cos(up) * 40, cz: C.z + Math.sin(up) * 40, size: 500, depth: 16, head: 14, frameUp: 6, bandH: 3, dirt: 2, wave: 2.5, el: 30, sunEl: 25, sunAz: 58, camp: true };
  // The camp sits against the slab's far side from the woods, leaving the rest of the slab to the clearing's edge.
  const size = 32, forest = forestward(W), pad = 1.5;
  const spots = [C, W.camp.woodpile, ...W.camp.people.map((p) => ({ ...p.at, r: 1 })), ...W.camp.tents.map((t) => ({ ...t.at, r: t.size * 0.7 }))];
  const lo = (k) => Math.min(...spots.map((p) => p[k] - (p.r || 1))), hi = (k) => Math.max(...spots.map((p) => p[k] + (p.r || 1)));
  const place = (k, dir) => (dir > 0.5 ? lo(k) - pad : dir < -0.5 ? hi(k) + pad - size : (lo(k) + hi(k) - size) / 2);
  return { name: "camp", vox: 0.25, ex: 1, cx: place("x", forest[0]) + size / 2, cz: place("z", forest[1]) + size / 2, size, forest, depth: 9, head: 56, frameUp: 3, bandH: 6, dirt: 6, wave: 6, el: 30, sunEl: 17, sunAz: 105, camp: true };
}

function patch(material, { ao = false } = {}) {
  material.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace("#include <common>", `#include <common>\n${ao ? "attribute float ao;\nvarying float vAo;" : ""}`)
      .replace(
        "#include <color_vertex>",
        `#if defined( USE_COLOR_ALPHA )\n vColor = vec4( pow( color.rgb, vec3( 2.2 ) ), color.a );\n#elif defined( USE_COLOR )\n vColor = vec4( pow( color.rgb, vec3( 2.2 ) ), 1.0 );\n#endif\n${ao ? "vAo = ao;" : ""}`,
      );
    if (ao)
      sh.fragmentShader = sh.fragmentShader
        .replace("#include <common>", "#include <common>\nvarying float vAo;")
        .replace("#include <lights_fragment_end>", "#include <lights_fragment_end>\nreflectedLight.indirectDiffuse *= vAo * vAo;\nreflectedLight.directDiffuse *= 0.3 + 0.7 * vAo;");
  };
  return material;
}

function geometry(b) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(b.pos, 3));
  geo.setAttribute("normal", new THREE.BufferAttribute(b.nrm, 3, true));
  geo.setAttribute("color", new THREE.BufferAttribute(b.col, b.alpha ? 4 : 3, true));
  geo.setAttribute("ao", new THREE.BufferAttribute(b.ao, 1, true));
  geo.setIndex(new THREE.BufferAttribute(b.idx, 1));
  return geo;
}

// Fit an orthographic camera around a set of points as seen from its own position.
function fit(cam, points, margin, aspect) {
  cam.updateMatrixWorld();
  const inv = cam.matrixWorldInverse, p = new THREE.Vector3();
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const q of points) {
    p.copy(q).applyMatrix4(inv);
    x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y); z0 = Math.min(z0, p.z); z1 = Math.max(z1, p.z);
  }
  let w = (x1 - x0) * (1 + margin), h = (y1 - y0) * (1 + margin);
  const mx = (x0 + x1) / 2, my = (y0 + y1) / 2;
  if (aspect) { if (w / h > aspect) h = w / aspect; else w = h * aspect; }
  Object.assign(cam, { left: mx - w / 2, right: mx + w / 2, top: my + h / 2, bottom: my - h / 2, near: -z1 - 10, far: -z0 + 10 });
  cam.updateProjectionMatrix();
}

const TiltShift = {
  uniforms: { tDiffuse: { value: null }, dir: { value: new THREE.Vector2() }, focus: { value: 0.5 }, band: { value: 0.16 }, amount: { value: 1.2 } },
  vertexShader: "varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }",
  fragmentShader: `uniform sampler2D tDiffuse; uniform vec2 dir; uniform float focus, band, amount; varying vec2 vUv;
    void main() {
      float k = smoothstep(band, band + 0.42, abs(vUv.y - focus)) * amount;
      vec4 s = vec4(0.0); float ws = 0.0;
      for (int i = -6; i <= 6; i++) { float w = exp(-float(i * i) / 14.0); s += texture2D(tDiffuse, vUv + dir * float(i) * k) * w; ws += w; }
      gl_FragColor = s / ws;
    }`,
};
// A little more color and a soft vignette, like a finished render.
const Grade = {
  uniforms: { tDiffuse: { value: null }, sat: { value: 1.14 }, vig: { value: 0.32 } },
  vertexShader: TiltShift.vertexShader,
  fragmentShader: `uniform sampler2D tDiffuse; uniform float sat, vig; varying vec2 vUv;
    void main() {
      vec4 c = texture2D(tDiffuse, vUv);
      float l = dot(c.rgb, vec3(0.2126, 0.7152, 0.0722));
      c.rgb = max(mix(vec3(l), c.rgb, sat), 0.0);
      vec2 d = vUv - 0.5;
      c.rgb *= 1.0 - vig * dot(d, d) * 1.6;
      gl_FragColor = c;
    }`,
};

function backdrop(w, h) {
  const c = Object.assign(document.createElement("canvas"), { width: w, height: h }), g = c.getContext("2d");
  const lin = g.createLinearGradient(0, 0, 0, h);
  lin.addColorStop(0, "#9fbfd6");
  lin.addColorStop(0.55, "#dbe6e9");
  lin.addColorStop(1, "#efe4d4");
  g.fillStyle = lin;
  g.fillRect(0, 0, w, h);
  const rad = g.createRadialGradient(w / 2, h * 0.48, h * 0.2, w / 2, h * 0.5, h * 1.05);
  rad.addColorStop(0, "rgba(255,255,255,0.18)");
  rad.addColorStop(1, "rgba(40,50,70,0.28)");
  g.fillStyle = rad;
  g.fillRect(0, 0, w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

async function main() {
  const W = grow(seed);
  lap("grow");
  const S = slab(W);
  const { vox, ex } = S;
  const n = Math.round(S.size / vox), x0 = S.cx - (n * vox) / 2, z0 = S.cz - (n * vox) / 2;
  let lo = Infinity, hi = -Infinity;
  for (let j = 0; j <= 40; j++)
    for (let i = 0; i <= 40; i++) {
      const h = W.heightAt(x0 + (i / 40) * n * vox, z0 + (j / 40) * n * vox);
      lo = Math.min(lo, h);
      hi = Math.max(hi, h);
    }
  const yBase = Math.floor((Math.min(lo, 0) * ex) / vox - S.depth) * vox;
  const ny = Math.ceil((Math.max(hi, 0) * ex - yBase) / vox) + S.head + 4;
  const V = { ...S, x0, z0, nx: n, nz: n, ny, yBase };
  const g = new Grid(n, ny, n);
  const T = terrain(W, g, V);
  lap("terrain");
  const M = models(W, g, V, T);
  lap("models");

  // The camera looks down the slab diagonal that best matches the camp's open side; close up it also keeps the woods
  // behind the camp rather than between it and the viewer.
  const f = W.camp.from, fw = S.forest || [0, 0];
  let dx = 1, dz = 1, pick = -Infinity;
  for (const [a, b] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
    const s = a * Math.cos(f) + b * Math.sin(f) - 1.6 * (a * fw[0] + b * fw[1]);
    if (s > pick) { pick = s; dx = a; dz = b; }
  }
  const el = THREE.MathUtils.degToRad(S.el), sunEl = THREE.MathUtils.degToRad(S.sunEl);
  const toCamera = new THREE.Vector3(dx * Math.SQRT1_2 * Math.cos(el), Math.sin(el), dz * Math.SQRT1_2 * Math.cos(el));
  const left = new THREE.Vector3(-dz, 0, dx).normalize(), back = new THREE.Vector3(dx, 0, dz).normalize();
  const az = THREE.MathUtils.degToRad(S.sunAz);
  const toSun = back.clone().multiplyScalar(Math.cos(az)).addScaledVector(left, Math.sin(az)).normalize().multiplyScalar(Math.cos(sunEl)).setY(Math.sin(sunEl)).normalize();
  const B = mesh(g, { toCamera: toCamera.toArray(), toSun: toSun.toArray() });
  lap(`mesh ${B.opaque.faces}+${B.clear.faces}+${B.glow.faces} faces`);

  const canvas = document.getElementById("view"), w = innerWidth, h = innerHeight;
  const renderer = new THREE.WebGLRenderer({ canvas, preserveDrawingBuffer: true, antialias: false, powerPreference: "high-performance" });
  renderer.setPixelRatio(1);
  renderer.setSize(w, h, false);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.toneMappingExposure = 1.0;

  const scene = new THREE.Scene();
  scene.background = backdrop(w, h);
  const unit = vox / B.Q;
  const solid = new THREE.Mesh(geometry(B.opaque), patch(new THREE.MeshLambertMaterial({ vertexColors: true }), { ao: true }));
  solid.castShadow = solid.receiveShadow = true;
  const water = new THREE.Mesh(geometry(B.clear), patch(new THREE.MeshPhongMaterial({ vertexColors: true, transparent: true, shininess: 90, specular: 0x557788, depthWrite: false })));
  water.receiveShadow = true;
  water.renderOrder = 2;
  const glow = new THREE.Mesh(geometry(B.glow), patch(new THREE.MeshBasicMaterial({ vertexColors: true, color: new THREE.Color().setScalar(view === "camp" ? 1.6 : 5) })));
  for (const m of [solid, water, glow]) {
    m.scale.setScalar(unit);
    m.frustumCulled = false;
    scene.add(m);
  }

  // Bounds of the slab in scene meters: the shadow covers bedrock to the tallest thing, the frame bedrock to the ground.
  let topY = 0, groundY = 0;
  for (let y = ny - 1; y >= 0 && !topY; y--) for (let k = y * n * n, e = k + n * n; k < e; k++) if (g.kind[k]) { topY = y + 1; break; }
  for (const v of T.ground) groundY = Math.max(groundY, v + 1);
  const L = n * vox, center = new THREE.Vector3(L / 2, (topY * vox) / 2, L / 2);
  const box = (top) => {
    const out = [];
    for (const a of [0, L]) for (const b of [0, top * vox]) for (const c of [0, L]) out.push(new THREE.Vector3(a, b, c));
    return out;
  };
  const corners = box(topY);

  const camera = new THREE.OrthographicCamera();
  camera.position.copy(center).addScaledVector(toCamera, L * 3);
  camera.lookAt(center);
  if (view === "camp") {
    // Close up the trees are part of the picture: frame what stands on every column, letting only crowns run off the top.
    const tops = box(0);
    for (let j = 0; j < n; j += 2)
      for (let i = 0; i < n; i += 2)
        for (let y = ny - 1; y > 0; y--) {
          const k = g.kind[(y * n + j) * n + i];
          if (k && k !== SMOKE) { tops.push(new THREE.Vector3((i + 0.5) * vox, Math.min(y + 1, T.ground[j * n + i] + 1 + 3.5 / vox) * vox, (j + 0.5) * vox)); break; }
        }
    fit(camera, tops, 0.02, w / h);
  } else fit(camera, box(groundY + S.frameUp), 0.05, w / h);

  const sun = new THREE.DirectionalLight(view === "camp" ? 0xffc890 : 0xffd29a, view === "camp" ? 5.2 : 4.4);
  sun.position.copy(center).addScaledVector(toSun, L * 3);
  sun.target.position.copy(center);
  scene.add(sun, sun.target);
  sun.castShadow = true;
  sun.shadow.mapSize.set(4096, 4096);
  sun.shadow.camera.position.copy(sun.position);
  sun.shadow.camera.lookAt(center);
  fit(sun.shadow.camera, corners, 0.02);
  sun.shadow.bias = -0.0004;
  sun.shadow.radius = 2.5;
  scene.add(new THREE.HemisphereLight(0xa9c4f0, 0x8f7c62, view === "camp" ? 1.1 : 0.95));
  if (view === "camp") {
    // A cool bounce from the viewer's right keeps the cut face away from the low sun out of black.
    const fill = new THREE.DirectionalLight(0xa4bce4, 1.1);
    fill.position.copy(center).addScaledVector(back.clone().multiplyScalar(0.55).addScaledVector(left, -0.8).setY(0.45), L);
    fill.target.position.copy(center);
    scene.add(fill, fill.target);
  }
  for (const l of M.lights) {
    const p = new THREE.PointLight(0xff8a3a, 0, 0, 2);
    p.position.set(l.x * vox, l.y * vox, l.z * vox);
    p.intensity = view === "camp" ? 14 : view === "valley" ? 160 : 0;
    scene.add(p);
  }

  const rt = new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, samples: 4 });
  const composer = new EffectComposer(renderer, rt);
  composer.setPixelRatio(1);
  composer.setSize(w, h);
  composer.addPass(new RenderPass(scene, camera));
  composer.addPass(new UnrealBloomPass(new THREE.Vector2(w, h), view === "camp" ? 0.35 : 0.5, view === "camp" ? 0.25 : 0.4, 1.3));
  // Keep the camp in focus; blur grows toward the top and bottom of the frame.
  const fire = M.lights[0] && new THREE.Vector3(M.lights[0].x * vox, M.lights[0].y * vox, M.lights[0].z * vox).project(camera);
  const focus = fire ? THREE.MathUtils.clamp(fire.y * 0.5 + 0.5, 0.3, 0.7) : 0.5;
  for (const dir of [new THREE.Vector2(1 / w, 0), new THREE.Vector2(0, 1 / h)]) {
    const pass = new ShaderPass(TiltShift);
    Object.assign(pass.uniforms.dir.value, dir);
    pass.uniforms.focus.value = focus;
    pass.uniforms.amount.value = view === "camp" ? 1.2 : 1.1;
    composer.addPass(pass);
  }
  composer.addPass(new ShaderPass(Grade));
  composer.addPass(new OutputPass());
  lap("setup");
  composer.render();
  renderer.getContext().finish();
  lap("render");
  console.warn(`voxel ${view}: ${log.join(", ")}; grid ${n}x${ny}x${n}`);
  document.body.classList.add("ready");
}

main().catch(fail);
