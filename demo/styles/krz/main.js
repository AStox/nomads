// Nomads as a theatrical low-poly night: faceted ground, trees as thin prisms, flat dark water, and a stage lit by a
// moon, a campfire and a few lanterns, with fog cards hung between the depth layers like scrims.
import * as THREE from "three";
import { grow, hash, clamp } from "../world.js";
import { ground, lakes, heightTexture, waterMaterial, sky, stars, contour, blurred } from "./land.js";
import { trees, shrubs, rocks } from "./props.js";
import { buildCamp, smallStuff } from "./camp.js";
import { glow, mistCard, mistSheet, smoke, embers, grade, dialogue } from "./fx.js";

const DEG = Math.PI / 180;
const C = (h) => new THREE.Color(h);

const NIGHT = {
  skyTop: C("#020306"), skyMid: C("#0a1420"), skyHor: C("#2a3d4c"), skyBand: C("#2f2c44"), fog: C("#17222e"),
  deep: C("#04070a"), moonCol: C("#f1ead4"), halo: C("#8fa6c4"), moonLight: C("#9fb5cf"), hemiSky: C("#3c5670"), hemiGround: C("#0a0c0f"),
  foam: C("#8a98a4"), fireCol: C("#ff9a40"),
};

const VIEWS = {
  island: {
    fov: 34, cam: { dist: 13500, lift: 3300, aim: 900, swing: -12, turn: -9 }, refl: 0.5, moon: { az: 17, el: 5.5, size: 1.1 }, fogDensity: 0.00005, hemi: 0.4, moonI: 0.9, fill: 1.8, dash: [70, 9], pathW: 0.05, foamW: 0.25,
    layers: [{ r: 5200, step: 38 }], vignette: 0.6, grain: 0.05,
  },
  valley: {
    fov: 30, cam: { dist: 185, lift: 22, aim: 10, turn: -8 }, refl: 0.16, moon: { az: 15, el: 9, size: 0.9 }, fogDensity: 0.00042, hemi: 0.3, moonI: 1.6, fill: 0, dash: [3.5, 0.9], pathW: 0.035, foamW: 0.18,
    layers: [{ r: 760, step: 4 }, { r: 1800, step: 12 }, { r: 5200, step: 40 }], vignette: 0.62, grain: 0.06,
  },
  camp: {
    fov: 38, cam: { dist: 10, side: 2.5, lift: 1.9, aim: 1.2, turn: -14 }, refl: 0.3, moon: { az: -62, el: 24, size: 1.2 }, fogDensity: 0.0035, hemi: 0.28, moonI: 0.7, fill: 0, dash: [1.2, 0.3], pathW: 0.03, foamW: 0.12,
    layers: [{ r: 70, step: 1.1 }, { r: 600, step: 6 }, { r: 5200, step: 40 }], vignette: 0.66, grain: 0.07,
  },
};

function mulberry(a) { return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

export async function run() {
  const q = new URLSearchParams(location.search), name = VIEWS[q.get("view")] ? q.get("view") : "valley", seed = Number(q.get("seed") || 1);
  const V = structuredClone(VIEWS[name]), P = NIGHT;
  // Framing overrides for lining up shots: ?dist=&lift=&aim=&turn=&swing=&side=&fov=&az=&el=
  for (const k of ["dist", "lift", "aim", "turn", "swing", "side"]) if (q.has(k)) V.cam[k] = Number(q.get(k));
  if (q.has("fov")) V.fov = Number(q.get("fov"));
  if (q.has("az")) V.moon.az = Number(q.get("az"));
  if (q.has("el")) V.moon.el = Number(q.get("el"));
  const t0 = performance.now(), log = (s) => console.log(`[krz] ${s} ${Math.round(performance.now() - t0)} ms`);
  const w = grow(seed);
  log("grow");
  const rand = mulberry(seed * 977 + name.length * 31);
  const camp = w.camp, cc = camp.at, fire = camp.fire;
  const W = innerWidth, H = innerHeight;

  // ---------- camera ----------
  const camera = new THREE.PerspectiveCamera(V.fov, W / H, 1, 100);
  const heading = camp.from + (name === "island" ? 0 : (V.cam.swing || 0) * DEG), from = new THREE.Vector3(Math.cos(heading), 0, Math.sin(heading));
  let focus;
  if (name === "island") {
    let sx = 0, sz = 0, sn = 0;
    for (let k = 0; k < w.N * w.N; k++) if (w.isle.height[k] > 0 && w.isle.water[k] <= 0) { sx += w.START + (k % w.N) * w.CELL; sz += w.START + Math.floor(k / w.N) * w.CELL; sn++; }
    focus = new THREE.Vector3(sx / sn, 0, sz / sn);
    const dir = new THREE.Vector3(cc.x - focus.x, 0, cc.z - focus.z).normalize().applyAxisAngle(new THREE.Vector3(0, 1, 0), V.cam.swing * DEG);
    camera.position.copy(focus).addScaledVector(dir, V.cam.dist).setY(V.cam.lift);
    camera.near = 200; camera.far = 90000;
    camera.lookAt(focus.x, V.cam.aim, focus.z);
  } else {
    focus = name === "valley" ? new THREE.Vector3(cc.x, cc.y, cc.z) : new THREE.Vector3(fire.x, fire.y, fire.z);
    const p = focus.clone().addScaledVector(from, V.cam.dist).addScaledVector(new THREE.Vector3(-from.z, 0, from.x), V.cam.side || 0);
    camera.position.set(p.x, Math.max(0, w.heightAt(p.x, p.z)) + V.cam.lift, p.z);
    camera.near = name === "valley" ? 2 : 0.2; camera.far = name === "valley" ? 16000 : 5000;
    camera.lookAt(focus.x, focus.y + V.cam.aim, focus.z);
  }
  camera.rotateY(V.cam.turn * DEG);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld();
  const fwd = new THREE.Vector3(), right = new THREE.Vector3();
  camera.getWorldDirection(fwd);
  fwd.y = 0; fwd.normalize();
  right.set(-fwd.z, 0, fwd.x);
  const moonDir = fwd.clone().multiplyScalar(Math.cos(V.moon.az * DEG)).addScaledVector(right, Math.sin(V.moon.az * DEG)).multiplyScalar(Math.cos(V.moon.el * DEG)).setY(Math.sin(V.moon.el * DEG)).normalize();

  const v3 = new THREE.Vector3();
  const seen = (x, y, z, m = 1.15) => { v3.set(x, y, z).project(camera); return v3.z < 1 && v3.z > -1 && Math.abs(v3.x) < m && Math.abs(v3.y) < m + 0.1; };
  const camDist = (x, z) => Math.hypot(x - camera.position.x, z - camera.position.z);

  // ---------- renderer and scene ----------
  const canvas = document.getElementById("view");
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(1);
  renderer.setSize(W, H, false);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(P.fog, V.fogDensity);
  scene.background = P.skyTop;

  const U = {
    moonDir, moonCol: P.moonCol, deep: P.deep, skyHor: P.skyHor, skyTop: P.skyMid, skyMid: P.skyMid, skyBand: P.skyBand, fogCol: P.fog, fogDensity: V.fogDensity,
    right, fwd, dashL: V.dash[0], dashS: V.dash[1], pathW: V.pathW, fire: new THREE.Vector3(fire.x, fire.y + 0.8, fire.z), fireCol: P.fireCol, foam: P.foam, foamW: V.foamW,
    heightTex: heightTexture(w), refl: V.refl, lineK: { island: 0, valley: 0, camp: 0.4 }[name], lakeGlow: name === "island" ? 0.9 : 0, moonSize: V.moon.size * DEG, halo: 1, haloCol: P.halo,
  };
  scene.add(sky({ ...U, skyTop: P.skyTop }), stars(U, rand, name === "island" ? 1400 : 900));

  // ---------- light ----------
  scene.add(new THREE.HemisphereLight(P.hemiSky, P.hemiGround, V.hemi));
  const moon = new THREE.DirectionalLight(P.moonLight, V.moonI);
  const mc = name === "island" ? focus : name === "valley" ? focus.clone().addScaledVector(from, 90) : focus;
  moon.position.copy(mc).addScaledVector(moonDir, name === "island" ? 20000 : 1500);
  moon.target.position.copy(mc);
  if (name !== "island") {
    moon.castShadow = true;
    const e = name === "valley" ? 320 : 60;
    Object.assign(moon.shadow.camera, { left: -e, right: e, top: e, bottom: -e, near: 10, far: 3200 });
    moon.shadow.mapSize.set(name === "valley" ? 4096 : 2048, name === "valley" ? 4096 : 2048);
    moon.shadow.bias = -0.0004;
    moon.shadow.normalBias = name === "valley" ? 0.3 : 0.05;
  }
  scene.add(moon, moon.target);
  if (V.fill) {
    // A cold side fill from behind the camera's left, so the dark mass still shows its facets.
    const fill = new THREE.DirectionalLight("#5d7391", V.fill);
    fill.position.copy(camera.position).addScaledVector(right, -6000).setY(9000);
    fill.target.position.copy(focus);
    scene.add(fill, fill.target);
  }

  // ---------- ground and water ----------
  const centre = name === "island" ? focus : new THREE.Vector3((camera.position.x + focus.x) / 2, 0, (camera.position.z + focus.z) / 2);
  const boxes = V.layers.map((L) => ({ x0: centre.x - L.r, z0: centre.z - L.r, x1: centre.x + L.r, z1: centre.z + L.r }));
  V.layers.forEach((L, k) => {
    const inner = boxes[k - 1], pad = L.step * 1.5;
    const skip = inner && ((x, z) => x > inner.x0 + pad && x < inner.x1 - pad && z > inner.z0 + pad && z < inner.z1 - pad);
    const trodden = name !== "island" && k === 0 ? (x, z, c) => {
      const d = Math.hypot(x - fire.x, z - fire.z), t = clamp(1 - (d - 2.5) / 6, 0, 1) * 0.8;
      if (t > 0) c.lerp(C("#4e4336"), t);
    } : null;
    scene.add(ground(w, boxes[k], L.step, { skip, drop: [0, 0.03, 0.12][k], tint: trodden }));
  });
  const water = waterMaterial(w, U);
  const sea = new THREE.Mesh(new THREE.PlaneGeometry(240000, 240000).rotateX(-Math.PI / 2), water);
  sea.position.set(camera.position.x, 0, camera.position.z);
  scene.add(sea, new THREE.Mesh(lakes(w, boxes.at(-1)), water));
  if (name === "island") {
    // From this far the shore is drawn as a line: the coast, a fainter echo offshore, and the streams.
    const soft = blurred(w, 1);
    scene.add(contour(w, soft, 0.15, 1.5, "#aab7c2"), contour(w, soft, -6, 0.5, "#4f6272", 0.7));
    const inland = Float32Array.from(w.wet, (v, i) => (w.h[i] > 0.2 ? v : 0));
    scene.add(contour(w, inland, 0.5, (x, z) => w.heightAt(x, z) + 4, "#8c9cab", 0.8));
    const rp = [];
    for (const line of w.rivers)
      for (let k = 1; k < line.length; k++) if (line[k][2] > 0.6) rp.push(line[k - 1][0], w.heightAt(line[k - 1][0], line[k - 1][1]) + 10, line[k - 1][1], line[k][0], w.heightAt(line[k][0], line[k][1]) + 10, line[k][1]);
    const rg = new THREE.BufferGeometry();
    rg.setAttribute("position", new THREE.Float32BufferAttribute(rp, 3));
    scene.add(new THREE.LineSegments(rg, new THREE.LineBasicMaterial({ color: "#6f8497", transparent: true, opacity: 0.75 })));
  }
  log("ground");

  // ---------- trees, shrubs, rocks ----------
  let nt = 0;
  if (name === "island") {
    // Trees drawn well over size, so from kilometres out the woods still read as a dark ragged canopy.
    const t = trees(w, () => true, { detail: false, scale: 3 });
    scene.add(...t.meshes); nt = t.count;
  } else {
    const nearR = name === "valley" ? 650 : 260, farR = name === "valley" ? 4200 : 3000, shadowR = name === "valley" ? 300 : 60;
    const near = trees(w, (t) => camDist(t.x, t.z) < nearR && seen(t.x, t.y + t.tall * 0.5, t.z, 1.25) && Math.hypot(t.x - mc.x, t.z - mc.z) < shadowR, { cast: true });
    const mid = trees(w, (t) => camDist(t.x, t.z) < nearR && seen(t.x, t.y + t.tall * 0.5, t.z, 1.25) && Math.hypot(t.x - mc.x, t.z - mc.z) >= shadowR);
    const far = trees(w, (t) => { const d = camDist(t.x, t.z); return d >= nearR && d < farR && seen(t.x, t.y + t.tall * 0.5, t.z, 1.1); }, { detail: false });
    scene.add(...near.meshes, ...mid.meshes, ...far.meshes);
    nt = near.count + mid.count + far.count;
    const r2 = name === "valley" ? 520 : 160;
    const keep = (o) => camDist(o.x, o.z) < r2 && seen(o.x, o.y, o.z, 1.2);
    scene.add(...shrubs(w, keep, { cast: name === "camp" }), rocks(w, keep, { cast: name === "camp" }));
  }
  log(`trees ${nt}`);

  // ---------- camp ----------
  const F = new THREE.Vector3(fire.x, fire.y, fire.z), wind = new THREE.Vector2(w.isle.wind[0], w.isle.wind[1]).normalize();
  if (name === "island") {
    scene.add(glow("#ff8a3a", 520, F.clone().setY(40), 0.85), glow("#ffd08a", 130, F.clone().setY(40), 1));
    // Its reflection, a broken streak on the water between the camp and the camera.
    const toCam = new THREE.Vector3(camera.position.x - F.x, 0, camera.position.z - F.z).normalize();
    for (let k = 1; k <= 9; k++) scene.add(glow("#ff9a48", 110 - k * 7, F.clone().addScaledVector(toCam, 120 + k * 110).setY(3), 0.34 - k * 0.03));
    // Marsh lights: faint cold points over the wettest ground, a few kilometres apart.
    const marsh = [];
    for (let k = 0; k < w.N * w.N; k++) if (w.isle.marsh[k] > 0.45 && w.isle.height[k] > 1 && w.isle.water[k] <= 0) marsh.push(k);
    marsh.sort((a, b) => w.isle.marsh[b] - w.isle.marsh[a]);
    const lit = [];
    for (const k of marsh) {
      const x = w.START + (k % w.N) * w.CELL, z = w.START + Math.floor(k / w.N) * w.CELL;
      if (lit.length >= 6 || lit.some((p) => Math.hypot(p.x - x, p.z - z) < 1500)) continue;
      lit.push({ x, z });
      scene.add(glow("#c6e6d6", 200, new THREE.Vector3(x, w.heightAt(x, z) + 25, z), 0.7), glow("#eafff4", 45, new THREE.Vector3(x, w.heightAt(x, z) + 25, z), 0.9));
    }
  } else {
    const close = name === "camp";
    buildCamp(w, scene, {
      camera, detail: close, fireShadow: 1024,
      fireI: close ? 70 : 110, fireDecay: close ? 2 : 1, fireReach: close ? 0 : 32, tentI: close ? 4 : 10, tentDecay: close ? 2 : 1.5, lanternI: close ? 26 : 40, glowScale: close ? 1 : 3.2,
    });
    scene.add(smoke(F, wind, camera, rand, close ? { n: 30, rise: 20 } : { n: 26, rise: 34 }));
    scene.add(embers(F, wind, rand, close ? 50 : 14, close ? 7 : 6, close ? 2.2 : 1.5));
    if (name === "camp") smallStuff(w, scene, F, 45, 4.5, (o) => seen(o.x, o.y, o.z, 1.2), 0.6);
    else smallStuff(w, scene, F, 60, 0.35, (o) => seen(o.x, o.y, o.z, 1.2), 1);
  }

  // ---------- fog cards ----------
  const mistCol = C("#56697a");
  const dFocus = camDist(focus.x, focus.z);
  // [ahead of the focus, height, opacity, width as a share of the frame]
  const cards = name === "island"
    ? [[-2600, 110, 0.22, 0.45], [4200, 320, 0.3, 0.8]]
    : name === "valley" ? [[40, 3, 0.2, 1.5], [150, 7, 0.34, 1.5], [400, 14, 0.36, 1.5], [900, 40, 0.32, 1.5], [1700, 80, 0.34, 1.5]]
    : [[26, 0.9, 0.14, 1.5], [70, 2.2, 0.2, 1.5], [160, 5, 0.26, 1.5], [380, 12, 0.3, 1.5]];
  cards.forEach(([ahead, h, o, share], k) => {
    const d = dFocus + ahead, at = camera.position.clone().addScaledVector(fwd, d);
    const gy = name === "island" ? 0 : Math.max(0, w.heightAt(at.x, at.z)) - h * 0.15;
    const width = 2 * d * Math.tan((V.fov * DEG * W) / H / 2) * share;
    at.addScaledVector(right, name === "island" ? -width * 0.35 : (hash(k, 3, 77) - 0.5) * width * 0.3);
    at.y = gy;
    scene.add(mistCard(at, width, h * 2.2, fwd, mistCol, o, k));
  });
  if (name !== "island") {
    // A low sheet of mist on the nearest lake beyond the camp.
    const lake = (x, z) => w.fine(w.wet, x, z) > 0.6 && w.heightAt(x, z) > 0.2;
    let best = null;
    for (let x = focus.x - 700; x < focus.x + 700; x += 12) for (let z = focus.z - 700; z < focus.z + 700; z += 12) if (lake(x, z) && camDist(x, z) > dFocus + 30 && (!best || Math.hypot(x - focus.x, z - focus.z) < best.d)) best = { x, z, d: Math.hypot(x - focus.x, z - focus.z) };
    let sx = 0, sz = 0, n = 0, x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity, top = 0;
    if (best)
      for (let x = best.x - 350; x < best.x + 350; x += 10)
        for (let z = best.z - 350; z < best.z + 350; z += 10)
          if (lake(x, z)) { sx += x; sz += z; n++; x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); top = Math.max(top, w.heightAt(x, z)); }
    if (n) scene.add(mistSheet(new THREE.Vector3(sx / n, top + 1.2, sz / n), (x1 - x0) * 1.3 + 40, (z1 - z0) * 1.3 + 40, 0, mistCol, name === "camp" ? 0.35 : 0.3));
  }

  // ---------- render ----------
  renderer.render(scene, camera);
  log("render");
  const g = grade({ vignette: V.vignette, grain: V.grain });
  renderer.autoClear = false;
  renderer.render(g.scene, g.cam);
  if (name === "camp" && !q.has("clean")) {
    const d = await dialogue({
      x: 800, y: 46, width: 424, pick: 0,
      text: "The wood is wet and slow to catch. Nobody says anything until it does, and then everyone talks at once.",
      choices: ["Tell them about the lights out on the marsh.", "Ask who will take the first watch.", "Say nothing. Feed the fire."],
    });
    renderer.render(d.scene, d.cam);
  }
  log("done");
  await new Promise((r) => requestAnimationFrame(() => r()));
  document.body.classList.add("ready");
}
