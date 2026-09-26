// Fly around a generated island in PS1 style, at true scale. Orbit it, follow someone, or walk it yourself.
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { CELL, COLORS, N, NAMES, generateIsland, rng } from "./island.js";
import { post, setTime, skyMaterial, uniforms } from "./ps1.js";
import { buildWorld } from "./world.js";

THREE.ColorManagement.enabled = false;
const $ = (s) => document.querySelector(s);
const seed = Math.max(1, Math.floor(Number(new URLSearchParams(location.search).get("seed")) || 1));
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// Let the loading screen paint before the generator takes the thread.
await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 30)));
const isle = generateIsland(rng(seed));
const renderer = new THREE.WebGLRenderer({ canvas: $("#view"), antialias: false, powerPreference: "high-performance" });
renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
renderer.setPixelRatio(1);
const scene = new THREE.Scene();
const world = buildWorld(isle, { N, CELL, rand: rng(seed ^ 0x2545f491), people: NAMES.slice(0, 5).map((name, i) => ({ name, color: COLORS[i] })) });
scene.add(world.group);
const sky = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 10), skyMaterial());
sky.renderOrder = -1;
scene.add(sky);
const camera = new THREE.PerspectiveCamera(55, 1, 1, 60000);
camera.rotation.order = "YXZ";
const frame = new THREE.WebGLRenderTarget(1, 1, { minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
const pass = post(frame);

// ---------- the small frame ----------
const LINES = [240, 360, 480];
let lines = 240, retro = true;
function resize() {
  const aspect = innerWidth / innerHeight, h = retro ? lines : Math.round(innerHeight * Math.min(2, devicePixelRatio)), w = Math.round(h * aspect);
  renderer.setSize(w, h, false);
  frame.setSize(w, h);
  uniforms.uRes.value.set(w, h);
  uniforms.uPxPerM.value = h / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)));
  camera.aspect = aspect;
  camera.updateProjectionMatrix();
}
addEventListener("resize", resize);
resize();
function setRetro(on) {
  retro = on;
  uniforms.uSnap.value = uniforms.uAffine.value = pass.material.uniforms.uDither.value = on ? 1 : 0;
  $("#view").classList.toggle("smooth", !on);
  resize();
  hud();
}

// ---------- time of day ----------
const TIMES = [[6.8, "Dawn"], [9.5, "Morning"], [13, "Midday"], [18.2, "Dusk"], [22.5, "Night"]];
let when = 1;
setTime(TIMES[when][0], sky.material);

// ---------- camera ----------
const controls = new OrbitControls(camera, renderer.domElement);
Object.assign(controls, { enableDamping: true, dampingFactor: 0.08, minDistance: 4, maxDistance: 32000, maxPolarAngle: Math.PI * 0.495, zoomSpeed: 1.3, zoomToCursor: true, screenSpacePanning: false, autoRotate: true, autoRotateSpeed: 0.25 });
controls.target.set(0, Math.max(0, world.ground(0, 0)), 0);
camera.position.set(-6400, 5600, 7400);
const settle = () => { controls.autoRotate = false; };
controls.addEventListener("start", settle);

let follow = null, fly = null;
const walk = { on: false, x: 0, z: 0, yaw: 0, pitch: 0, step: 0 };
const keys = new Set();
const tmp = new THREE.Vector3(), tmp2 = new THREE.Vector3();

function followPerson(k) {
  if (walk.on) toggleWalk();
  settle();
  follow = world.people[k] ?? null;
  if (!follow) return hud();
  // Swoop down to a spot a little above and behind them, keeping the side we came from.
  const from = camera.position.clone().sub(controls.target).normalize(), flat = from.clone().setY(0);
  if (flat.lengthSq() < 1e-4) flat.set(0, 0, 1);
  const to = flat.normalize().multiplyScalar(Math.cos(0.32)).setY(Math.sin(0.32));
  fly = { t: 0, target: controls.target.clone(), from, to, dist: camera.position.distanceTo(controls.target) };
  hud();
}
function stopFollow() {
  follow = fly = null;
  hud();
}
function toggleWalk() {
  walk.on = !walk.on;
  controls.enabled = !walk.on;
  settle();
  if (walk.on) {
    // Step in a few paces short of where the camera was looking, facing it, so whoever it followed stands in front.
    follow = fly = null;
    const d = tmp.subVectors(controls.target, camera.position).setY(0);
    if (d.lengthSq() < 1e-4) d.set(0, 0, -1);
    d.normalize();
    Object.assign(walk, { x: controls.target.x - d.x * 7, z: controls.target.z - d.z * 7, yaw: Math.atan2(-d.x, -d.z), pitch: -0.08 });
  } else {
    document.exitPointerLock?.();
    const f = tmp.set(-Math.sin(walk.yaw), 0, -Math.cos(walk.yaw));
    controls.target.set(walk.x + f.x * 20, world.floor(walk.x + f.x * 20, walk.z + f.z * 20) + 1, walk.z + f.z * 20);
    camera.position.set(walk.x - f.x * 10, world.floor(walk.x, walk.z) + 8, walk.z - f.z * 10);
  }
  hud();
}

// Keeps the orbit's focus on the ground and the camera out of it; pans with the keys; eases onto whoever is followed.
function orbit(dt) {
  const dist = camera.position.distanceTo(controls.target);
  const f = tmp.subVectors(controls.target, camera.position).setY(0).normalize(), r = tmp2.set(-f.z, 0, f.x);
  const ax = (keys.has("d") || keys.has("arrowright")) - (keys.has("a") || keys.has("arrowleft"));
  const az = (keys.has("w") || keys.has("arrowup")) - (keys.has("s") || keys.has("arrowdown"));
  if (ax || az) {
    settle();
    follow = fly = null;
    const move = f.multiplyScalar(az).addScaledVector(r, ax).multiplyScalar(dist * 0.8 * dt);
    controls.target.add(move);
    camera.position.add(move);
  }
  if (follow) {
    const at = follow.focus(new THREE.Vector3());
    if (fly) {
      fly.t = Math.min(1, fly.t + dt / 2);
      const e = fly.t * fly.t * (3 - 2 * fly.t), dir = tmp.lerpVectors(fly.from, fly.to, e).normalize();
      controls.target.lerpVectors(fly.target, at, e);
      camera.position.copy(controls.target).addScaledVector(dir, Math.exp(Math.log(fly.dist) + (Math.log(14) - Math.log(fly.dist)) * e));
      if (fly.t >= 1) fly = null;
    } else {
      const delta = tmp.subVectors(at, controls.target);
      controls.target.add(delta);
      camera.position.add(delta);
    }
  } else controls.target.y += (world.floor(controls.target.x, controls.target.z) - controls.target.y) * Math.min(1, dt * 5);
  controls.update(dt);
  const floor = world.floor(camera.position.x, camera.position.z) + 2;
  if (camera.position.y < floor) camera.position.y = floor;
  const far = clamp(dist * 3.2, 2500, 42000);
  fog(far * 0.3, far, clamp(dist * 0.004, 0.25, 30));
}

function stroll(dt) {
  const f = tmp.set(-Math.sin(walk.yaw), 0, -Math.cos(walk.yaw)), r = tmp2.set(-f.z, 0, f.x);
  const ax = (keys.has("d") || keys.has("arrowright")) - (keys.has("a") || keys.has("arrowleft"));
  const az = (keys.has("w") || keys.has("arrowup")) - (keys.has("s") || keys.has("arrowdown"));
  const speed = keys.has("shift") ? 14 : 4.5;
  if (ax || az) {
    const move = f.multiplyScalar(az).addScaledVector(r, ax).normalize().multiplyScalar(speed * dt);
    walk.x = clamp(walk.x + move.x, -world.size * 0.6, world.size * 0.6);
    walk.z = clamp(walk.z + move.z, -world.size * 0.6, world.size * 0.6);
    walk.step += speed * dt;
  }
  camera.position.set(walk.x, world.floor(walk.x, walk.z) + 1.65 + Math.sin(walk.step * 1.7) * 0.05, walk.z);
  camera.rotation.set(walk.pitch, walk.yaw, 0);
  fog(300, 3200, 0.2);
}

function fog(near, far, clip) {
  uniforms.uFogNear.value = near;
  uniforms.uFogFar.value = far;
  const depth = far * 1.3 + 2000;
  if (Math.abs(camera.near - clip) > clip * 0.1 || Math.abs(camera.far - depth) > far * 0.1) {
    camera.near = clip;
    camera.far = depth;
    camera.updateProjectionMatrix();
  }
  world.cull(camera.position, uniforms.uPxPerM.value, far);
}

// ---------- input ----------
const view = $("#view");
addEventListener("keydown", (e) => {
  const k = e.key.toLowerCase();
  keys.add(k);
  if (e.repeat) return;
  if (k === "e") toggleWalk();
  else if (k === "t") nextTime();
  else if (k === "p") setRetro(!retro);
  else if (k === "r") { lines = LINES[(LINES.indexOf(lines) + 1) % LINES.length]; resize(); hud(); }
  else if (k === "n") newIsland();
  else if (k >= "1" && k <= "5") followPerson(Number(k) - 1);
  else if (k === "0" || k === "escape") stopFollow();
  else if (k === "h") $("#keys").hidden = !$("#keys").hidden;
});
addEventListener("keyup", (e) => keys.delete(e.key.toLowerCase()));
addEventListener("blur", () => keys.clear());
// Walking looks around with the mouse: pointer lock where the browser allows it, dragging where it doesn't.
let dragging = false;
view.addEventListener("pointerdown", () => {
  if (!walk.on) return;
  dragging = true;
  if (document.pointerLockElement !== view) view.requestPointerLock?.()?.catch?.(() => {});
});
addEventListener("pointerup", () => { dragging = false; });
addEventListener("pointermove", (e) => {
  if (!walk.on || (!dragging && document.pointerLockElement !== view)) return;
  walk.yaw -= e.movementX * 0.0025;
  walk.pitch = clamp(walk.pitch - e.movementY * 0.0025, -1.3, 1.3);
});
view.addEventListener("wheel", settle, { passive: true });

// ---------- heads-up display ----------
const tags = world.people.map((p, i) => {
  const tag = document.createElement("button");
  tag.className = "tag";
  tag.textContent = p.name;
  tag.style.setProperty("--c", p.color);
  tag.addEventListener("click", () => followPerson(i));
  $("#tags").append(tag);
  const row = document.createElement("li"), button = document.createElement("button");
  button.innerHTML = `<i style="--c: ${p.color}"></i>${i + 1} ${p.name}`;
  button.addEventListener("click", () => followPerson(i));
  row.append(button);
  $("#list").append(row);
  return tag;
});
$("#walk").addEventListener("click", toggleWalk);
$("#retro").addEventListener("click", () => setRetro(!retro));
$("#time").addEventListener("click", () => nextTime());
$("#next").addEventListener("click", () => newIsland());
function nextTime() {
  when = (when + 1) % TIMES.length;
  setTime(TIMES[when][0], sky.material);
  hud();
}
function newIsland() {
  location.search = `?seed=${1 + Math.floor(Math.random() * 9999)}`;
}
function hud() {
  $("#where").textContent = `Island ${seed} · ${TIMES[when][1]}`;
  $("#mode").textContent = walk.on ? "Walking. Drag to look, WASD to move, E to fly." : follow ? `Following ${follow.name}. 0 to stop.` : "Drag to turn, right drag to pan, scroll to zoom.";
  $("#walk").textContent = walk.on ? "Fly" : "Walk";
  $("#retro").textContent = retro ? `PS1 ${lines}p` : "PS1 off";
  document.querySelectorAll("#list button").forEach((b, i) => b.classList.toggle("on", follow === world.people[i]));
}
hud();
// Name tags ride above each head, hidden when a hill stands between them and the camera.
function inSight(from, to) {
  for (let k = 1; k < 24; k++) {
    const t = k / 24, x = from.x + (to.x - from.x) * t, z = from.z + (to.z - from.z) * t;
    if (world.ground(x, z) > from.y + (to.y - from.y) * t + 0.5) return false;
  }
  return true;
}
function place() {
  const w = innerWidth, h = innerHeight;
  world.people.forEach((p, i) => {
    const v = p.focus(tmp).add(tmp2.set(0, 1, 0)), d = v.distanceTo(camera.position), seen = d < uniforms.uFogFar.value && inSight(camera.position, v);
    v.project(camera);
    const show = seen && v.z < 1 && Math.abs(v.x) < 1.1 && Math.abs(v.y) < 1.1;
    tags[i].hidden = !show;
    if (show) tags[i].style.transform = `translate(${Math.round((v.x * 0.5 + 0.5) * w)}px, ${Math.round((0.5 - v.y * 0.5) * h)}px) translate(-50%, -100%)`;
  });
}

// ---------- loop ----------
let last = performance.now();
renderer.setAnimationLoop((now) => {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  uniforms.uClock.value += dt;
  world.update(dt);
  if (walk.on) stroll(dt);
  else orbit(dt);
  sky.position.copy(camera.position);
  sky.scale.setScalar(camera.far * 0.9);
  renderer.setRenderTarget(frame);
  renderer.render(scene, camera);
  renderer.setRenderTarget(null);
  renderer.render(pass.scene, pass.camera);
  place();
});
$("#loading").hidden = true;
document.body.classList.add("ready");
Object.assign(window, { nomads: { world, camera, controls, followPerson, toggleWalk, walk, setRetro } });
