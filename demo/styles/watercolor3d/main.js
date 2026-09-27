// Nomads as a 3D watercolor, after Dordogne and illustrated sketchbooks: the island is built in three.js, every thing
// painted in one flat pigment with only a shade glaze on its underside, then turned into watercolor on paper in screen
// space (paint.js), with white paper left between overlapping things and a sepia pen picking out a few edges.
import * as THREE from "three";
import { grow } from "../world.js";
import { terrain, water, streams } from "./ground.js";
import { flora, closeGround } from "./flora.js";
import { camp } from "./camp.js";
import { Painter } from "./paint.js";

const query = new URLSearchParams(location.search);
const VIEW = ["island", "valley", "camp"].includes(query.get("view")) ? query.get("view") : "valley";
const SEED = Number(query.get("seed") || 1);
const fail = (e) => { document.body.dataset.error = String((e && e.stack) || e); document.body.classList.add("failed"); console.error(e); };
addEventListener("error", (e) => fail(e.error || e.message));
addEventListener("unhandledrejection", (e) => fail(e.reason));

// A camera at pos looking along bearing az (radians in x,z) and pitched down by pitch degrees.
const aim = (pos, az, pitch) => {
  const p = (pitch * Math.PI) / 180;
  return { pos, target: new THREE.Vector3(pos.x + Math.cos(az) * Math.cos(p) * 1000, pos.y - Math.sin(p) * 1000, pos.z + Math.sin(az) * Math.cos(p) * 1000) };
};
const BASE = {
  exag: 1, ticks: 0, tuftScale: 1, poolFar: 0,
  near: 1, far: 120000, haze: 0.5, warp: 3, vig: 50, edge: 1.5, autumn: 0.035, pale: 0.2,
  treeScale: 1, shrubScale: 1, reedScale: 1, nearbyR: 0, nearbyDensity: 3, smokePuffs: 12, smokeRise: 10,
};
// Per view: camera, how far the fog reaches, gap and pen widths (px times meters), and how the woods are thinned.
const VIEWS = {
  island: {
    fov: 40, near: 40, fog: 20000, haze: 1, gap: 900, ink: 900, inkFar: 9000, contour: 40, patch: 14, shore: 0.8, glaze: 9,
    treeFar: 40000, keepFrom: 3000, minKeep: 0.12, maxScale: 2.2, treeScale: 1.5, lobeFar: 0, trunkFar: 0, shrubFar: 0, rockFar: 0, reedFar: 0,
    smokePuffs: 14, smokeRise: 260, fireGlow: 0,
    exag: 1.8,
    camera(w) {
      const az = Math.PI + 0.42, pos = new THREE.Vector3(-200 + Math.cos(az) * 9300, 3150, 400 + Math.sin(az) * 9300);
      return aim(pos, az + Math.PI, 14.7);
    },
  },
  valley: {
    fov: 40, near: 2, fog: 5200, haze: 0.5, gap: 420, ink: 700, inkFar: 2600, contour: 10, patch: 3, shore: 0.2, glaze: 2.2,
    treeFar: 30000, keepFrom: 1300, minKeep: 0.12, maxScale: 2.2, lobeFar: 800, trunkFar: 800, poolFar: 900, shrubFar: 1600, rockFar: 1100, reedFar: 800,
    nearbyR: 70, nearbyDensity: 0.35, ticks: 0.3, tuftScale: 2.2, smokePuffs: 18, smokeRise: 38, fireGlow: 0.6,
    camera(w) {
      const C = w.camp.at, f = w.camp.from, u = w.camp.uphill;
      const pos = new THREE.Vector3(C.x + Math.cos(f) * 165, C.y + 48, C.z + Math.sin(f) * 165);
      return { pos, target: new THREE.Vector3(C.x + Math.cos(u - 0.22) * 95, C.y + 5, C.z + Math.sin(u - 0.22) * 95) };
    },
  },
  camp: {
    fov: 46, near: 0.5, fog: 2400, haze: 0.45, gap: 60, ink: 40, inkFar: 420, contour: 4, patch: 0.7, shore: 0.12, glaze: 0.45,
    treeFar: 12000, keepFrom: 500, minKeep: 0.12, maxScale: 2, lobeFar: 400, trunkFar: 500, poolFar: 500, shrubFar: 700, rockFar: 500, reedFar: 250,
    nearbyR: 36, nearbyDensity: 1.6, ticks: 0.2, smokePuffs: 18, smokeRise: 11, fireGlow: 1,
    camera(w) {
      const C = w.camp.at, f = w.camp.from;
      const pos = new THREE.Vector3(C.x + Math.cos(f) * 9.5, C.y + 2.9, C.z + Math.sin(f) * 9.5);
      return { pos, target: new THREE.Vector3(C.x - Math.cos(f) * 3, C.y + 1.1, C.z - Math.sin(f) * 3) };
    },
  },
};

async function main() {
  const V = { ...BASE, ...VIEWS[VIEW] };
  const canvas = document.getElementById("view"), W = innerWidth, H = innerHeight;
  canvas.width = W;
  canvas.height = H;
  const w = grow(SEED);

  const renderer = new THREE.WebGLRenderer({ canvas, preserveDrawingBuffer: true, antialias: false });
  renderer.setPixelRatio(1);
  renderer.setSize(W, H, false);
  const camera = new THREE.PerspectiveCamera(V.fov, W / H, V.near, V.far);
  const { pos, target } = V.camera(w);
  camera.position.copy(pos);
  camera.lookAt(target);
  camera.updateMatrixWorld();
  camera.updateProjectionMatrix();

  // Light comes from the upper left of the page and a little from the painter's side.
  const fwd = new THREE.Vector3().subVectors(target, pos).normalize(), right = new THREE.Vector3().crossVectors(fwd, new THREE.Vector3(0, 1, 0)).normalize();
  const light = new THREE.Vector3().addScaledVector(right, -0.6).addScaledVector(new THREE.Vector3(0, 1, 0), 0.8).addScaledVector(fwd, -0.3).normalize();
  const lightV = light.clone().transformDirection(camera.matrixWorldInverse);
  const anchor = VIEW === "island" ? new THREE.Vector3(0, 0, 0) : new THREE.Vector3(w.camp.at.x, w.camp.at.y, w.camp.at.z);
  const common = { uAnchor: { value: anchor }, uLight: { value: light }, uRes: { value: new THREE.Vector2(W, H) } };

  const scene = new THREE.Scene();
  scene.add(terrain(w, common, V), water(w, common, V), streams(w, common, V));
  for (const m of flora(w, common, V, camera, lightV)) scene.add(m);
  for (const m of closeGround(w, common, V, lightV)) scene.add(m);
  for (const m of camp(w, common, V)) scene.add(m);

  const painter = new Painter(renderer, W, H);
  painter.drawScene(scene, camera);
  const project = (v) => { const s = v.clone().project(camera); return [(s.x * 0.5 + 0.5) * W, (0.5 - s.y * 0.5) * H, s.z]; };
  const F = w.camp.fire, [fx, fy] = project(new THREE.Vector3(F.x, F.y + 0.4, F.z));
  const fireR = (2.6 * H) / (2 * Math.tan((V.fov * Math.PI) / 360) * camera.position.distanceTo(new THREE.Vector3(F.x, F.y, F.z)));
  const flat = new THREE.Vector3(fwd.x, 0, fwd.z).normalize().multiplyScalar(1e6).add(new THREE.Vector3(pos.x, 0, pos.z));
  const horizon = project(flat)[1];
  painter.paint({ warp: V.warp, fog: V.fog, horizon, gap: V.gap, vig: V.vig, haze: V.haze, fire: [fx, fy, fireR, V.fireGlow], inkFar: V.inkFar, ink: V.ink, glaze: V.glaze, edge: V.edge, ticks: V.ticks });
  // wait for the GPU to finish the last pass before calling the frame ready
  const gl = renderer.getContext();
  gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
}

main().then(() => document.body.classList.add("ready"), fail);
