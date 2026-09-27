// Nomads as a hex tile board: the island resampled onto thick painted tiles at stepped heights, dressed with toy
// pieces, lit by a low golden sun and shot through a light tilt-shift over a pastel backdrop.
import * as THREE from "three";
import { grow } from "../world.js";
import { buildBoard, spatial, hkey } from "./board.js";
import { buildTiles } from "./tiles.js";
import { decorate, campLayout, buildCamp, toonRamp } from "./pieces.js";

const TOY = 2.3;
const VIEWS = {
  island: (w) => ({ flat: 160, ox: 0, oz: 0, rot: 0, extent: "island", detail: 4, riverDetail: 10, campDetail: 4, levelOf: (h) => 1 + Math.floor(Math.sqrt(Math.max(0, h)) * 0.8), step: 34, baseT: 120, gap: 0.035, riverW: 0.17, mountainH: 45, unit: 160 / 40, treeScale: 0.68, treeReach: 90, coverScale: 1.8, fine: 0.2, pool: 1.5, patches: true, camp: false, pitch: 40, fov: 24, blur: 3.6, band: 0.15 }),
  valley: (w) => ({ flat: 40, ox: w.camp.at.x, oz: w.camp.at.z, rot: w.camp.from - Math.PI / 2, extent: { radius: 3 }, detail: 10, riverDetail: 16, campDetail: 18, levelOf: (h) => 1 + Math.floor(Math.max(0, h) / 2.2), step: 2.6, baseT: 7, gap: 0.035, riverW: 0.13, mountainH: 40, unit: 1, treeScale: 0.56, treeReach: 11, coverScale: 2.1, fine: 0.1, pool: 1, camp: true, nearR: 34, nearDensity: 2, pitch: 40, fov: 26, blur: 4, band: 0.14 }),
  camp: (w) => ({ ...VIEWS.valley(w), coverScale: 1.5, pitch: 34, fov: 28, blur: 6, band: 0.1, nearR: 40, nearDensity: 3 }),
};

async function main() {
  const q = new URLSearchParams(location.search), name = VIEWS[q.get("view")] ? q.get("view") : "valley", seed = Number(q.get("seed")) || 1;
  const w = grow(seed), view = { name, ...VIEWS[name](w) };
  const board = buildBoard(w, view), { grid } = board;
  const layout = view.camp ? campLayout(w, grid, TOY) : null;
  const { geometry, lines, D } = buildTiles(board, w, { spots: layout?.spots });

  const canvas = document.getElementById("view"), W = innerWidth, H = innerHeight;
  const renderer = new THREE.WebGLRenderer({ canvas, preserveDrawingBuffer: true, antialias: false });
  renderer.setPixelRatio(1);
  renderer.setSize(W, H, false);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;

  const ramp = toonRamp();
  const mats = {
    solid: new THREE.MeshToonMaterial({ vertexColors: true, gradientMap: ramp }),
    tuft: new THREE.MeshToonMaterial({ vertexColors: true, gradientMap: ramp, side: THREE.DoubleSide }),
  };
  mats.reed = mats.flower = mats.tuft;
  const scene = new THREE.Scene();
  const tilesMesh = new THREE.Mesh(geometry, mats.solid);
  tilesMesh.castShadow = tilesMesh.receiveShadow = true;
  scene.add(tilesMesh);
  scene.add(new THREE.LineSegments(lines, new THREE.LineBasicMaterial({ color: 0x3b2618, transparent: true, opacity: name === "island" ? 0.42 : 0.5 })));

  const rand = w.rand, idx = { trees: spatial(w.trees, 30), shrubs: spatial(w.shrubs, 30), rocks: spatial(w.rocks, 30) };
  const decor = decorate(board, w, D, idx, mats, rand);
  if (layout) for (const m of buildCamp(w, board, D, layout, TOY, mats, decor, rand)) scene.add(m);
  for (const m of decor.I.meshes(decor.T, mats)) scene.add(m);

  // Framing points: every tile's rim, top and bottom.
  const pts = [];
  const campTile = board.map.get(hkey(0, 0));
  const framed = name === "camp" ? board.tiles.filter((t) => Math.hypot(t.gx, t.gz) < view.flat * 1.1) : board.tiles;
  for (const t of framed) for (const [dx, dz] of [[-D.R, 0], [D.R, 0], [0, -D.R], [0, D.R]]) pts.push(new THREE.Vector3(t.gx + dx, t.top, t.gz + dz), new THREE.Vector3(t.gx + dx, -view.baseT, t.gz + dz));

  const cam = new THREE.PerspectiveCamera(view.fov, W / H, 1, 1e5);
  let focusAt;
  if (name === "camp") {
    const y = campTile.top, tgt = new THREE.Vector3(0, y + 1.4, -view.flat * 0.05), p = THREE.MathUtils.degToRad(view.pitch);
    const halfW = view.flat * 0.8, dist = halfW / (Math.tan(THREE.MathUtils.degToRad(view.fov) / 2) * cam.aspect);
    cam.position.copy(tgt).add(new THREE.Vector3(0, Math.sin(p) * dist, Math.cos(p) * dist));
    cam.lookAt(tgt);
    focusAt = new THREE.Vector3(0, y, 0);
  } else {
    fit(cam, pts, view.pitch, name === "island" ? [0.95, 0.9] : [0.97, 0.9]);
    focusAt = view.camp ? new THREE.Vector3(0, campTile.top, 0) : new THREE.Vector3(0, 0, 0);
  }
  cam.updateMatrixWorld();
  cam.near = cam.position.length() * 0.02;
  cam.far = cam.position.length() * 4;
  cam.updateProjectionMatrix();

  // Low golden sun from the left and a little toward the camera; a cool sky fill; warm bounce from below.
  const sunDir = new THREE.Vector3(-0.7, 0.42, 0.5).normalize();
  const sun = new THREE.DirectionalLight(0xffdfb2, 3.6);
  scene.add(sun, sun.target);
  scene.add(new THREE.HemisphereLight(0xd6e2ff, 0xa89878, 1.35));
  const fill = new THREE.DirectionalLight(0xb9c8ff, 0.35);
  fill.position.set(0.6, 0.5, -0.6);
  scene.add(fill);
  sun.castShadow = true;
  sun.shadow.mapSize.set(4096, 4096);
  sun.shadow.intensity = 0.72;
  sun.shadow.radius = name === "island" ? 2 : 3;
  fitShadow(sun, sunDir, name === "camp" ? pts.filter((p) => Math.hypot(p.x, p.z) < view.flat * 1.4) : pts);

  // Render the board into a multisampled target, then tilt-shift and composite it over the backdrop.
  const hasFloat = renderer.extensions.has("EXT_color_buffer_float") || renderer.extensions.has("EXT_color_buffer_half_float");
  const rt = new THREE.WebGLRenderTarget(W, H, { samples: 4, type: hasFloat ? THREE.HalfFloatType : THREE.UnsignedByteType, generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter });
  renderer.setRenderTarget(rt);
  renderer.setClearColor(0x000000, 0);
  renderer.clear();
  renderer.render(scene, cam);

  const f = focusAt.clone().project(cam), ctr = new THREE.Vector3(0, 0, 0).project(cam);
  const post = new THREE.ShaderMaterial({
    uniforms: {
      tScene: { value: rt.texture }, res: { value: new THREE.Vector2(W, H) }, focus: { value: f.y * 0.5 + 0.5 }, band: { value: view.band }, blur: { value: view.blur },
      bgTop: { value: new THREE.Color("#f6e7d3") }, bgBot: { value: new THREE.Color("#d5e3e8") }, glow: { value: new THREE.Color("#fff3df") }, glowAt: { value: new THREE.Vector2(ctr.x * 0.5 + 0.5, ctr.y * 0.5 + 0.56) },
    },
    vertexShader: "varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }",
    fragmentShader: POST,
    depthTest: false,
    depthWrite: false,
  });
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), post), pscene = new THREE.Scene();
  quad.frustumCulled = false;
  pscene.add(quad);
  renderer.setRenderTarget(null);
  renderer.render(pscene, new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1));
  document.body.classList.add("ready");
}

function fit(cam, pts, pitchDeg, [mx, my]) {
  const p = THREE.MathUtils.degToRad(pitchDeg), back = new THREE.Vector3(0, Math.sin(p), Math.cos(p));
  const c = new THREE.Vector3();
  for (const v of pts) c.add(v);
  c.divideScalar(pts.length);
  let dist = 20000;
  const v = new THREE.Vector3(), right = new THREE.Vector3(), up = new THREE.Vector3();
  for (let it = 0; it < 14; it++) {
    cam.position.copy(c).addScaledVector(back, dist);
    cam.lookAt(c);
    cam.updateMatrixWorld();
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const pt of pts) { v.copy(pt).project(cam); x0 = Math.min(x0, v.x); x1 = Math.max(x1, v.x); y0 = Math.min(y0, v.y); y1 = Math.max(y1, v.y); }
    const hh = dist * Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2);
    right.setFromMatrixColumn(cam.matrixWorld, 0);
    up.setFromMatrixColumn(cam.matrixWorld, 1);
    c.addScaledVector(right, ((x0 + x1) / 2) * hh * cam.aspect * 0.8).addScaledVector(up, ((y0 + y1) / 2) * hh * 0.8);
    dist *= Math.max((x1 - x0) / 2 / mx, (y1 - y0) / 2 / my) ** 0.8;
  }
}

function fitShadow(sun, dir, pts) {
  const c = new THREE.Vector3();
  for (const v of pts) c.add(v);
  c.divideScalar(pts.length);
  let r = 0;
  for (const v of pts) r = Math.max(r, v.distanceTo(c));
  sun.target.position.copy(c);
  sun.position.copy(c).addScaledVector(dir, r * 2);
  sun.target.updateMatrixWorld();
  sun.updateMatrixWorld();
  const sc = sun.shadow.camera;
  sc.position.copy(sun.position);
  sc.lookAt(c);
  sc.updateMatrixWorld();
  const inv = sc.matrixWorldInverse, v = new THREE.Vector3();
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const p of pts) { v.copy(p).applyMatrix4(inv); x0 = Math.min(x0, v.x); x1 = Math.max(x1, v.x); y0 = Math.min(y0, v.y); y1 = Math.max(y1, v.y); z0 = Math.min(z0, v.z); z1 = Math.max(z1, v.z); }
  const pad = (x1 - x0) * 0.04;
  Object.assign(sc, { left: x0 - pad, right: x1 + pad, bottom: y0 - pad, top: y1 + pad, near: Math.max(0.1, -z1 - r * 0.6), far: -z0 + r * 0.6 });
  sc.updateProjectionMatrix();
  sun.shadow.bias = -0.0004;
}

const POST = /* glsl */ `
precision highp float;
uniform sampler2D tScene; uniform vec2 res; uniform float focus, band, blur; uniform vec3 bgTop, bgBot, glow; uniform vec2 glowAt;
varying vec2 vUv;
vec3 toSRGB(vec3 c) { return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }
float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
void main() {
  float r = blur * smoothstep(band, band + 0.34, abs(vUv.y - focus));
  vec4 s = texture2D(tScene, vUv);
  if (r > 0.3) {
    for (int i = 1; i < 32; i++) {
      float fi = float(i), rr = sqrt(fi / 31.0) * r, a = fi * 2.39996;
      s += texture2D(tScene, vUv + vec2(cos(a), sin(a)) * rr / res);
    }
    s /= 32.0;
  }
  vec3 bg = mix(bgBot, bgTop, smoothstep(0.0, 1.0, vUv.y));
  bg = mix(bg, glow, 0.6 * (1.0 - smoothstep(0.0, 0.8, length((vUv - glowAt) * vec2(res.x / res.y, 1.0)))));
  // The board's soft shadow on the backdrop, from a coarse mip of its coverage.
  float sh = 0.0;
  for (int i = 0; i < 8; i++) { float a = float(i) * 0.785; sh += textureLod(tScene, vUv + vec2(0.012, -0.045) + vec2(cos(a), sin(a)) * 0.018, 5.5).a; }
  bg *= 1.0 - 0.3 * sh / 8.0;
  // A soft painterly glow: the scene screened with a blurred copy of itself.
  vec3 soft = textureLod(tScene, vUv, 3.0).rgb * 0.6 + textureLod(tScene, vUv, 4.5).rgb * 0.4;
  s.rgb = 1.0 - (1.0 - s.rgb) * (1.0 - 0.16 * soft);
  s.rgb = mix(s.rgb, bgTop * s.a, 0.14 * smoothstep(0.45, 1.0, vUv.y));
  vec3 col = bg * (1.0 - s.a) + s.rgb;
  col *= mix(vec3(1.05, 1.01, 0.94), vec3(0.96, 0.98, 1.03), clamp(vUv.x * 0.7 + (1.0 - vUv.y) * 0.3, 0.0, 1.0));
  float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
  col = mix(vec3(l), col, 1.08);
  col = mix(col * vec3(0.9, 0.95, 1.1), col * vec3(1.07, 1.0, 0.88), smoothstep(0.05, 0.6, l));
  vec2 q = vUv - 0.5;
  col *= 1.0 - 0.22 * smoothstep(0.38, 0.9, length(q * vec2(1.15, 1.0)));
  col = toSRGB(max(col, 0.0)) + (hash(vUv * res) - 0.5) * 0.018;
  gl_FragColor = vec4(col, 1.0);
}`;

main().catch((e) => {
  document.body.dataset.error = String(e.stack || e);
  document.body.classList.add("failed");
});
