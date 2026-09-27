// The game view: tiles and props lit per vertex from one fixed light (no shadows), fading into black past the draw
// distance, rendered small and blown up with nearest sampling.
import * as THREE from "three";
import { hash, clamp } from "../world.js";
import { WATER, PATH, BEACH, ROCK, hsl } from "./terrain.js";
import * as MD from "./models.js";

const VERT = /* glsl */ `
uniform vec3 uLight; uniform vec2 uFocus; uniform vec2 uFade; uniform float uAmb; uniform float uCon; uniform float uTexScale;
varying vec3 vCol; varying vec2 vUv;
void main() {
  vec4 wp = vec4(position, 1.0); vec3 n = normal;
  #ifdef USE_INSTANCING
  wp = instanceMatrix * wp; n = mat3(instanceMatrix) * n;
  #endif
  wp = modelMatrix * wp; n = normalize(mat3(modelMatrix) * n);
  vec3 c = color;
  #ifdef USE_INSTANCING_COLOR
  c *= instanceColor;
  #endif
  #ifdef EMISSIVE
  float lit = 1.0;
  #else
  float d = dot(n, uLight);
  float lit = clamp(uAmb + uCon * d, 0.3, 1.45);
  #endif
  float fade = 1.0 - smoothstep(uFade.x, uFade.y, length(wp.xz - uFocus));
  vCol = c * lit * fade;
  vUv = wp.xz * uTexScale;
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;
const FRAG = /* glsl */ `
uniform sampler2D uTex;
varying vec3 vCol; varying vec2 vUv;
void main() {
  vec3 c = vCol;
  #ifdef WATER
  c *= texture2D(uTex, vUv).rgb;
  #endif
  // the old client's 16 bit palette: a little banding in every gradient
  gl_FragColor = vec4(floor(c * 40.0 + 0.5) / 40.0, 1.0);
}`;

function waterTexture() {
  const S = 32, cv = Object.assign(document.createElement("canvas"), { width: S, height: S }), g = cv.getContext("2d");
  const base = hsl(214, 0.5, 0.36), hi = hsl(208, 0.55, 0.52), lo = hsl(218, 0.5, 0.3);
  const c = (v) => `rgb(${v.map((q) => Math.round(q * 255)).join(",")})`;
  g.fillStyle = c(base); g.fillRect(0, 0, S, S);
  const r = MD.mulberry(4);
  for (let k = 0; k < 16; k++) {
    const y0 = Math.floor(r() * S), x0 = Math.floor(r() * S), len = 5 + Math.floor(r() * 7), light = k % 3 !== 0;
    g.fillStyle = c(light ? hi : lo);
    for (let i = 0; i < len; i++) g.fillRect((x0 + i) % S, (y0 + Math.round(Math.sin((i / len) * Math.PI) * -1.4) + S) % S, 1, 1);
  }
  const t = new THREE.CanvasTexture(cv);
  t.magFilter = t.minFilter = THREE.NearestFilter;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.generateMipmaps = false;
  // Colors are consumed raw by the shader, the same way vertex colors are.
  t.colorSpace = THREE.NoColorSpace;
  return t;
}

function material(u, defines = {}) {
  return new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader: FRAG, uniforms: u, defines, vertexColors: true, side: THREE.DoubleSide });
}

const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
const SKIN = [hsl(24, 0.45, 0.62), hsl(22, 0.4, 0.5), hsl(20, 0.38, 0.38), hsl(26, 0.5, 0.7), hsl(18, 0.35, 0.3)];
const HAIR = [hsl(25, 0.45, 0.2), hsl(30, 0.15, 0.1), hsl(45, 0.55, 0.52), hsl(15, 0.6, 0.35), hsl(30, 0.05, 0.6)];

export function lookFor(k, seed, COLORS) {
  const pick = (n) => rgb(COLORS[(n % 12 + 12) % 12]);
  const shirt = pick(k * 5 + seed * 3), legs = pick(k * 7 + seed + 4).map((v, i) => v * 0.55 + [0.2, 0.15, 0.1][i] * 0.45);
  return { shirt, legs, skin: SKIN[(k * 3 + seed) % SKIN.length], hair: HAIR[(k * 2 + seed) % HAIR.length], beard: (k + seed) % 3 === 0 };
}

// Every prop in view, from the world lists plus more of the same drawn from the cover fields at game density.
export function populate(W, G, V, focus) {
  const T = G.T, reach = G.R * T, camp = W.camp.at, out = { trees: [], bushes: [], rocks: [], decor: [], spots: [] };
  const inDisc = (x, z) => Math.hypot(x - focus.x, z - focus.z) < reach - T * 0.5;
  const cover = (k, x, z) => W.fine(W.cover[k], x, z);
  const blocked = (x, z, beachOk = false) => { const o = G.overAt(x, z); return o < 0 || o === WATER || o === PATH || (!beachOk && o === BEACH); };
  const wetNear = (x, z) => {
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * 6.283, px = x + Math.cos(a) * 9, pz = z + Math.sin(a) * 9;
      if (W.fine(W.wet, px, pz) > 0.3 || W.riverAt(px, pz) > 0.3 || W.heightAt(px, pz) < G.level(px, pz)) return true;
    }
    return cover("marsh", x, z) > 0.35;
  };
  const clearedAt = (x, z, r0, r1, rnd) => { const d = Math.hypot(x - camp.x, z - camp.z); return d < r0 || (d < r1 && rnd() < (r1 - d) / (r1 - r0)); };
  const exposure = (x, z) => W.bilinear(W.isle.exposure, (x - W.START) / W.CELL, (z - W.START) / W.CELL);
  const soil = (x, z) => Math.min(1.5, W.bilinear(W.isle.soil, (x - W.START) / W.CELL, (z - W.START) / W.CELL));
  const kindAt = (x, z, rnd) => {
    const m = W.fine(W.moist, x, z), ex = exposure(x, z), so = soil(x, z);
    const pine = clamp(0.08 + (W.heightAt(x, z) - 80) / 320 + ex * 0.8 - so * 0.3 + (1 - m) * 0.3, 0.03, 0.97);
    return rnd() < pine ? "pine" : m > 0.9 && rnd() < 0.45 ? "aspen" : so > 0.9 && rnd() < 0.6 ? "oak" : "ash";
  };
  const addTree = (x, z, kind, tall, yaw, tint) => {
    if (!inDisc(x, z) || blocked(x, z)) return;
    let model = kind === "pine" ? "evergreen" : kind === "oak" ? "oak" : kind === "aspen" ? (wetNear(x, z) ? "willow" : "light") : "normal";
    if (cover("bare", x, z) > 0.36 || G.overAt(x, z) === ROCK) model = "dead";
    const base = { pine: 17, oak: 15, ash: 16, aspen: 13 }[kind];
    out.trees.push({ x, z, y: G.groundAt(x, z), model, yaw, s: V.treeScale * clamp(tall / base, 0.78, 1.22), tint });
  };
  for (const t of W.trees) if (Math.abs(t.x - focus.x) < reach && Math.abs(t.z - focus.z) < reach) addTree(t.x, t.z, t.kind, t.tall, t.yaw, t.tint);
  for (const s of W.shrubs) if (inDisc(s.x, s.z) && !blocked(s.x, s.z)) out.bushes.push({ x: s.x, z: s.z, y: G.groundAt(s.x, s.z), heath: s.heath, yaw: s.yaw, s: 0.8 + s.tall * 0.3, tint: s.tint });
  for (const r of W.rocks) if (inDisc(r.x, r.z) && G.overAt(r.x, r.z) !== WATER && G.overAt(r.x, r.z) !== PATH) out.rocks.push({ x: r.x, z: r.z, y: G.groundAt(r.x, r.z), yaw: r.yaw, s: 0.5 + r.size * 0.45, tint: r.tint });

  for (const t of G.tiles) {
    const x0 = G.ox + t.i * T, z0 = G.oz + t.j * T, rnd = MD.mulberry(Math.floor(hash(Math.round(x0 * 4), Math.round(z0 * 4), 77) * 1e9));
    const cx = x0 + T / 2, cz = z0 + T / 2;
    if (!inDisc(cx, cz)) continue;
    const tc = cover("tree", cx, cz), sc = cover("shrub", cx, cz), gc = cover("grass", cx, cz), mc = cover("marsh", cx, cz), bc = cover("bare", cx, cz);
    const area = T * T, dry = W.dry(cx, cz);
    const spot = () => [x0 + rnd() * T, z0 + rnd() * T];
    if (dry) {
      for (let n = Math.floor(Math.pow(tc, 1.25) * area / V.treeArea + rnd()); n > 0; n--) {
        const [x, z] = spot();
        if (W.slopeAt(x, z) > 0.7 || clearedAt(x, z, 22, 40, rnd)) continue;
        addTree(x, z, kindAt(x, z, rnd), 12 + rnd() * 8, rnd() * 6.283, rnd());
      }
      const edge = tc * (1 - tc) * 4;
      for (let n = Math.floor((sc * 1.2 + edge * 0.5) * area / 22 + rnd()); n > 0; n--) {
        const [x, z] = spot();
        if (clearedAt(x, z, 12, 24, rnd) || blocked(x, z)) continue;
        out.bushes.push({ x, z, y: G.groundAt(x, z), heath: clamp(exposure(x, z) * 1.4 + sc - W.fine(W.moist, x, z) * 0.3, 0, 1), yaw: rnd() * 6.283, s: 0.7 + rnd() * 0.6, tint: rnd() });
      }
    }
    // bare ground keeps a few dead trees standing, even by the sea where nothing else grows
    for (let n = Math.floor(Math.max(0, bc - 0.35) * area / 260 + rnd()); n > 0; n--) {
      const [x, z] = spot();
      if (blocked(x, z, true) || W.heightAt(x, z) < G.level(x, z) + 0.6 || Math.hypot(x - camp.x, z - camp.z) < 20) continue;
      out.trees.push({ x, z, y: G.groundAt(x, z), model: "dead", yaw: rnd() * 6.283, s: V.treeScale * (0.8 + rnd() * 0.35), tint: rnd() });
    }
    for (let n = Math.floor((bc * 1.4 + (t.over === ROCK ? 0.5 : 0)) * area / 40 + rnd() * 0.6); n > 0; n--) {
      const [x, z] = spot();
      if (blocked(x, z, true) || W.heightAt(x, z) < G.level(x, z) + 0.3 || Math.hypot(x - camp.x, z - camp.z) < 12) continue;
      out.rocks.push({ x, z, y: G.groundAt(x, z), yaw: rnd() * 6.283, s: 0.5 + rnd() ** 2 * 1.6, tint: rnd() });
    }
    // ground decoration, one kind per draw so the tile reads as meadow, woodland floor, marsh or stony ground
    const decor = (model, count, beachOk = false) => {
      for (let n = Math.floor(count * area * V.decor + rnd()); n > 0; n--) {
        const [x, z] = spot();
        if (blocked(x, z, beachOk) || Math.hypot(x - camp.x, z - camp.z) < 4.2) continue;
        out.decor.push({ x, z, y: G.groundAt(x, z), model, yaw: rnd() * 6.283, s: 0.8 + rnd() * 0.5, tint: rnd() });
      }
    };
    if (dry) {
      decor("flower", gc * 0.06 * (0.4 + W.fine(W.moist, cx, cz)));
      decor("tuft", gc * 0.035 + sc * 0.03);
      decor("fern", tc * 0.08);
      decor("mushroom", tc * 0.012);
      decor("pebble", bc * 0.08 + 0.006, true);
    }
    if (wetNear(cx, cz)) decor("reeds", mc * 0.03 + 0.02, true);
  }

  // fishing spots: shore water tiles, spaced out, nearest the camp first
  const shore = G.tiles.filter((t) => t.over === WATER && t.odd < 0 && [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([a, b]) => { const o = G.overAt(G.ox + (t.i + a + 0.5) * T, G.oz + (t.j + b + 0.5) * T); return o >= 0 && o !== WATER; }));
  shore.sort((a, b) => Math.hypot(G.ox + a.i * T - focus.x, G.oz + a.j * T - focus.z) - Math.hypot(G.ox + b.i * T - focus.x, G.oz + b.j * T - focus.z));
  for (const t of shore) {
    const x = G.ox + (t.i + 0.5) * T, z = G.oz + (t.j + 0.5) * T;
    if (out.spots.length >= 4 || !inDisc(x, z) || Math.hypot(x - focus.x, z - focus.z) > reach * 0.86) continue;
    if (out.spots.every((s) => Math.hypot(s.x - x, s.z - z) > 16)) out.spots.push({ x, z, y: G.groundAt(x, z) + 0.03 });
  }
  return out;
}

export function render(W, G, V, P, camp, COLORS, seed) {
  const W3 = 640, H3 = 360, cv = Object.assign(document.createElement("canvas"), { width: W3, height: H3 });
  const renderer = new THREE.WebGLRenderer({ canvas: cv, antialias: false, preserveDrawingBuffer: true, powerPreference: "high-performance" });
  renderer.setPixelRatio(1);
  renderer.setSize(W3, H3, false);
  renderer.setClearColor(0x000000, 1);
  const scene = new THREE.Scene(), focus = V.focus;
  const camera = new THREE.PerspectiveCamera(V.fov, W3 / H3, 0.5, 3000);
  const look = V.look, pitch = (V.pitch * Math.PI) / 180, fy = G.groundAt(focus.x, focus.z);
  camera.position.set(focus.x - Math.cos(look) * Math.cos(pitch) * V.dist, fy + Math.sin(pitch) * V.dist, focus.z - Math.sin(look) * Math.cos(pitch) * V.dist);
  camera.lookAt(focus.x, fy + V.lift, focus.z);

  // one fixed light, up and to the left of the camera
  const la = look + 2.3, light = new THREE.Vector3(Math.cos(la) * 0.62, 0.72, Math.sin(la) * 0.62).normalize();
  const common = { uLight: { value: light }, uFocus: { value: new THREE.Vector2(focus.x, focus.z) }, uFade: { value: new THREE.Vector2(V.fade[0] * G.T, V.fade[1] * G.T) }, uTexScale: { value: 1 / (G.T * 2) }, uTex: { value: null } };
  const terrainMat = material({ ...common, uAmb: { value: 0.42 }, uCon: { value: 0.82 } });
  const modelMat = material({ ...common, uAmb: { value: 0.6 }, uCon: { value: 0.72 } });
  const glowMat = material({ ...common, uAmb: { value: 1 }, uCon: { value: 0 } }, { EMISSIVE: "" });
  const waterMat = material({ ...common, uTex: { value: waterTexture() }, uAmb: { value: 1 }, uCon: { value: 0 } }, { EMISSIVE: "", WATER: "" });

  const geo = G.geometry();
  scene.add(new THREE.Mesh(geo.land, terrainMat), new THREE.Mesh(geo.water, waterMat));

  // instanced props: a few variants of each model, instances spread over them by hash
  const variants = {};
  const variant = (name, k, make) => (variants[name] ||= Array.from({ length: k }, (_, i) => make(i)));
  const bins = new Map();
  const place = (geoms, list, tintFn, mat = modelMat) => {
    list.forEach((o, n) => {
      const g = geoms[Math.floor((o.tint ?? hash(n, 3, 9)) * 997) % geoms.length];
      if (!bins.has(g)) bins.set(g, { mat, items: [] });
      bins.get(g).items.push({ o, tint: tintFn ? tintFn(o) : [1, 1, 1] });
    });
  };
  const byModel = (list, key) => list.reduce((m, o) => ((m[o[key]] ||= []).push(o), m), {});
  const trees = byModel(P.trees, "model");
  const tintLeaf = (o) => { const k = 0.9 + (o.tint % 0.37) * 0.55; return [k, k * (0.98 + o.tint * 0.04), k * 0.95]; };
  if (trees.normal) place(variant("normal", 4, (i) => MD.normalTree(11 + i * 7)), trees.normal, tintLeaf);
  if (trees.light) place(variant("light", 3, (i) => MD.normalTree(51 + i * 5, hsl(84, 0.46, 0.3))), trees.light, tintLeaf);
  if (trees.oak) place(variant("oak", 3, (i) => MD.oak(21 + i * 9)), trees.oak, tintLeaf);
  if (trees.willow) place(variant("willow", 3, (i) => MD.willow(31 + i * 3)), trees.willow, tintLeaf);
  if (trees.evergreen) place(variant("evergreen", 3, (i) => MD.evergreen(41 + i * 13)), trees.evergreen, tintLeaf);
  if (trees.dead) place(variant("dead", 3, (i) => MD.deadTree(61 + i * 3)), trees.dead, null);
  const heath = P.bushes.filter((b) => b.heath > 0.55), green = P.bushes.filter((b) => b.heath <= 0.55);
  place(variant("bush", 4, (i) => MD.bush(71 + i * 5, 0, i === 3)), green, tintLeaf);
  place(variant("heath", 2, (i) => MD.bush(81 + i * 5, 0.9)), heath, null);
  const ores = ["copper", "tin", "iron", "coal", "clay"];
  place(variant("rock", 5, (i) => MD.boulder(91 + i * 7, i === 4 ? ores[seed % 5] : i === 3 ? ores[(seed + 2) % 5] : null)), P.rocks, (o) => { const k = 0.9 + o.tint * 0.2; return [k, k, k]; });
  const decor = byModel(P.decor, "model");
  if (decor.flower) place(variant("flower", 6, (i) => MD.flower(101 + i, MD.PETALS[i])), decor.flower, null);
  if (decor.tuft) place(variant("tuft", 3, (i) => MD.tuft(111 + i)), decor.tuft, tintLeaf);
  if (decor.fern) place(variant("fern", 2, (i) => MD.fern(121 + i)), decor.fern, tintLeaf);
  if (decor.mushroom) place(variant("mushroom", 2, (i) => MD.mushroom(131 + i)), decor.mushroom, null);
  if (decor.pebble) place(variant("pebble", 3, (i) => MD.pebble(141 + i)), decor.pebble, null);
  if (decor.reeds) place(variant("reeds", 3, (i) => MD.reeds(151 + i)), decor.reeds, null);
  if (P.logs?.length) for (const l of P.logs) { const m = new THREE.Mesh(MD.fallenLog(l.length), modelMat); m.position.set(l.x, l.y, l.z); m.rotation.y = l.yaw; scene.add(m); }
  place(variant("spot", 2, (i) => MD.fishingSpot(161 + i)), P.spots.map((s, i) => ({ ...s, tint: i / 4, yaw: i * 1.3, s: 0.6 + G.T * 0.45 })), null, glowMat);

  const M4 = new THREE.Matrix4(), Q = new THREE.Quaternion(), S = new THREE.Vector3(), Pv = new THREE.Vector3(), Y = new THREE.Vector3(0, 1, 0);
  for (const [g, { mat, items }] of bins) {
    const mesh = new THREE.InstancedMesh(g, mat, items.length);
    const tints = new Float32Array(items.length * 3);
    items.forEach(({ o, tint }, i) => {
      M4.compose(Pv.set(o.x, o.y, o.z), Q.setFromAxisAngle(Y, o.yaw || 0), S.setScalar(o.s || 1));
      mesh.setMatrixAt(i, M4);
      tints.set(tint, i * 3);
    });
    mesh.instanceColor = new THREE.InstancedBufferAttribute(tints, 3);
    mesh.frustumCulled = false;
    scene.add(mesh);
  }

  // the camp itself
  const add = (g, x, z, yaw = 0, mat = modelMat, s = 1, dy = 0) => { const m = new THREE.Mesh(g, mat); m.position.set(x, G.groundAt(x, z) + dy, z); m.rotation.y = yaw; m.scale.setScalar(s); scene.add(m); return m; };
  camp.tents.forEach((t, k) => add(MD.tent(t.size, rgb(COLORS[(k * 4 + seed) % 12])), t.at.x, t.at.z, t.yaw));
  const fire = MD.campfire(), f = camp.fire;
  add(fire.solid, f.x, f.z); add(fire.flame, f.x, f.z, 0, glowMat);
  const wp = camp.woodpile;
  add(MD.woodpile(), wp.x, wp.z, Math.atan2(f.x - wp.x, f.z - wp.z) + Math.PI / 2);
  for (const p of camp.people) {
    add(MD.person(p.look, p.pose), p.x, p.z, p.yaw, modelMat, V.personScale, p.pose === "sit" ? 0.0 : 0);
    if (p.pose === "sit") add(MD.fallenLog(1.2), p.x - Math.sin(p.yaw) * 0.05, p.z - Math.cos(p.yaw) * 0.05, p.yaw, modelMat, 0.9 * V.personScale, -0.02);
  }

  renderer.render(scene, camera);
  const project = (x, y, z) => { const v = new THREE.Vector3(x, y, z).project(camera); return [(v.x + 1) * 640, (1 - v.y) * 360, v.z]; };
  return { canvas: cv, project, groundY: (x, z) => G.groundAt(x, z) };
}
