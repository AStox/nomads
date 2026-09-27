// Nomads as a claymation set. The island view is the whole island sculpted in plasticine on a wooden board; the
// valley and camp views are dioramas: a thick slab of the island around the camp, cut from the clay with rough
// walls, on a board on the sculpting table among the tools. Every tree, shrub, rock, tent and person is rolled,
// pinched and pressed from clay and shot under soft studio lights through a macro lens.
import * as THREE from "three";
import { grow, clamp, smooth, fbm, hash } from "../world.js";
import { COLORS } from "../island.js";
import { CLAY, clayMaterial, sculptTexture, noiseTexture, shared, softerShadows, glsl, dataTex, lin } from "./clay.js";
import * as MD from "./models.js";
import { render } from "./post.js";

const query = new URLSearchParams(location.search);
const VIEW = ["island", "valley", "camp"].includes(query.get("view")) ? query.get("view") : "valley";
const SEED = Number(query.get("seed") || 1);
const fail = (e) => { document.body.dataset.error = String((e && e.stack) || e); document.body.classList.add("failed"); console.error(e); };
addEventListener("error", (e) => fail(e.error || e.message));
addEventListener("unhandledrejection", (e) => fail(e.reason));

// Per view: the model scale (world meters per model centimeter), vertical exaggeration, sculpt texture tiles in
// world meters for the ground, the trees and the small things, lumps pressed into the ground, camera, lamp, and how
// sparse and how big the rolled things are. `dio` is the cut slab: its half size, where it sits against the camp
// (in the camera's right and toward-camera axes), its thickness and the board margin around it.
const VIEWS = {
  island: {
    cm: 160, ex: 3.6, tile: 950, treeTile: 420, objTile: 420, lump: { amp: 20, len: 420 }, ripple: 70,
    fov: 26, elev: 42, turn: 0.35, grid: 860, warp: 1, dist: 19800,
    trees: { cell: 140, scale: 10, lod: 2 }, shrubs: { cell: 240, scale: 12 }, rocks: { cell: 260, scale: 10, min: 1.5 },
    key: { turn: 1.05, elev: 38, power: 3.4 }, shadow: 3, dof: { k: 6, max: 8 },
  },
  valley: {
    cm: 10, ex: 1.7, tile: 140, treeTile: 190, objTile: 30, lump: { amp: 1.6, len: 32 }, ripple: 240,
    dio: { r: 230, at: [0, -90], T: 36, margin: 110 },
    fov: 30, elev: 37, turn: 0.2, frame: 520, lead: 110, grid: 840, warp: 0.55,
    trees: { cell: 48, scale: 3.6, lod: 4 }, shrubs: { cell: 40, scale: 4.4 }, rocks: { cell: 36, scale: 3.4, min: 0 },
    grass: { cell: 10, scale: 5.5 }, camp: { k: 6.5, spread: 4 },
    key: { turn: 1.1, elev: 36, power: 3.5 }, shadow: 4, dof: { k: 6, max: 8 }, props: "front",
  },
  camp: {
    cm: 0.1, ex: 1, tile: 3.4, treeTile: 15, objTile: 2.6, lump: { amp: 0.09, len: 1.8 }, ripple: 900,
    dio: { r: 48, at: [0, -43.5], T: 1.6, margin: 10 },
    fov: 30, elev: 17, turn: 0.6, frame: 16, ahead: 1.5, grid: 900, warp: 0.2,
    trees: { cell: 7, scale: 1.0, lod: 4 }, shrubs: { cell: 3, scale: 1.3 }, rocks: { cell: 2.5, scale: 1.1, min: 0 },
    nearby: { density: 1.4 }, camp: { k: 1.25, spread: 1 },
    key: { turn: 1.15, elev: 34, power: 3.5 }, shadow: 5, dof: { k: 14, max: 15 }, props: "camp",
  },
};
// Layer thickness of each cover's clay in model millimeters (forest, meadow, heath, marsh, rock, sand), and water.
const TH = [3.0, 1.5, 2.2, 0.8, 2.6, 0.3], TH_WATER = -0.4;

const rad = (d) => (d * Math.PI) / 180;
main().catch(fail);

async function main() {
  softerShadows(12);
  const w = grow(SEED);
  const V = VIEWS[VIEW], camp = w.camp, C = camp.at, dio = V.dio;
  for (const k of ["frame", "elev", "ahead", "turn", "fov", "dist", "lead"]) if (query.has(k)) V[k] = Number(query.get(k));
  if (query.has("dof")) V.dof.k = Number(query.get("dof"));
  const ss = Number(query.get("ss") || 2), mm = V.cm / 10;
  shared.tSculpt.value = sculptTexture(MD.rng(SEED * 77 + 1));
  shared.tNoise.value = noiseTexture(MD.rng(SEED * 91 + 5));

  // ---------- the sculpted ground ----------
  // Standing water fills to its surface (the generator's bed plus depth), everything is lifted by the view's
  // exaggeration, and thumb-sized lumps are pressed in.
  const surfC = Float32Array.from(w.isle.height, (h, k) => h + Math.max(0, w.isle.water[k]));
  const cellOf = (x) => (x - w.START) / w.CELL;
  const surfAt = (x, z) => w.bilinear(surfC, cellOf(x), cellOf(z));
  const baseY = (x, z) => {
    let h = w.heightAt(x, z);
    const wet = w.fine(w.wet, x, z);
    if (wet > 0.02) h += (Math.max(h, surfAt(x, z)) - h) * smooth(0.1, 0.5, wet);
    return h;
  };
  const L = V.lump;
  let Y = (x, z) => baseY(x, z) * V.ex + L.amp * (fbm(x / L.len, z / L.len, 91, 3) + 0.35 * fbm(x / (L.len * 0.3), z / (L.len * 0.3), 97, 2));

  const W = innerWidth || 1280, H = innerHeight || 720, aspect = W / H;
  const camera = new THREE.PerspectiveCamera(V.fov, aspect, 1, 10);
  const az = camp.from + V.turn, el = rad(V.elev), hfov = 2 * Math.atan(Math.tan(rad(V.fov / 2)) * aspect);
  const fwd = { x: Math.cos(az), z: Math.sin(az) }, right = { x: Math.sin(az), z: -Math.cos(az) };
  const toWorld = (cx, cz, a, b) => ({ x: cx + right.x * a + fwd.x * b, z: cz + right.z * a + fwd.z * b });
  const toLocal = (cx, cz, x, z) => [(x - cx) * right.x + (z - cz) * right.z, (x - cx) * fwd.x + (z - cz) * fwd.z];

  // ---------- the model's outline: the island slab, or the diorama cut from it ----------
  let target, dist, region, slab = null, cut = null;
  if (!dio) {
    let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
    for (let k = 0; k < w.N * w.N; k++) {
      if (w.isle.height[k] <= 0) continue;
      const [a, b] = toLocal(0, 0, w.START + (k % w.N) * w.CELL, w.START + Math.floor(k / w.N) * w.CELL);
      a0 = Math.min(a0, a); a1 = Math.max(a1, a); b0 = Math.min(b0, b); b1 = Math.max(b1, b);
    }
    const ca = (a0 + a1) / 2, cb = (b0 + b1) / 2, T = 190, c = toWorld(0, 0, ca, cb);
    slab = { cx: c.x, cz: c.z, ha: (a1 - a0) / 2 + 650, hb: (b1 - b0) / 2 + 650, T, roll: 230 };
    slab.sd = (x, z) => {
      const [a, b] = toLocal(slab.cx, slab.cz, x, z), u = Math.abs(a) / slab.ha, v = Math.abs(b) / slab.hb;
      return (Math.pow(u ** 5 + v ** 5, 0.2) - 1) * Math.min(slab.ha, slab.hb) + 90 * fbm(x / 1600, z / 1600, 5, 2);
    };
    const inner = Y;
    Y = (x, z) => {
      const d = -slab.sd(x, z);
      if (d <= 0) return -T - 900;
      const y = inner(x, z);
      if (d >= slab.roll) return y;
      const t = d / slab.roll, prof = Math.sqrt(1 - (1 - t) * (1 - t));
      return -T + (Math.max(y, 0) + T) * prof;
    };
    target = new THREE.Vector3(c.x + fwd.x * 250, 60, c.z + fwd.z * 250);
    dist = V.dist;
    region = { x0: c.x - 8200, z0: c.z - 8200, size: 16400 };
  } else {
    // A rounded square cut square to the lens, its edge wandering a little the way a wire drawn by hand does.
    const c = toWorld(C.x, C.z, dio.at[0], dio.at[1]);
    cut = { cx: c.x, cz: c.z, r: dio.r };
    cut.edge = (a, b) => {
      const th = Math.atan2(b, a), l = Math.hypot(a, b) || 1, u = Math.abs(a) / l, v = Math.abs(b) / l;
      const wob = 1 + 0.03 * fbm(Math.cos(th) * 1.4 + 5, Math.sin(th) * 1.4 + 5, 71, 2) + 0.01 * fbm(Math.cos(th) * 7, Math.sin(th) * 7, 73, 1);
      return (dio.r * wob) / Math.pow(u ** 4 + v ** 4, 0.25);
    };
    cut.inside = (x, z, m = 0) => { const [a, b] = toLocal(cut.cx, cut.cz, x, z); return Math.hypot(a, b) < cut.edge(a, b) - m; };
    const size = dio.r * 2.7;
    region = { x0: c.x - size / 2, z0: c.z - size / 2, size };
    if (VIEW === "camp") {
      const ux = Math.cos(camp.uphill), uz = Math.sin(camp.uphill);
      target = new THREE.Vector3(C.x + ux * V.ahead, Y(C.x, C.z) + 0.9, C.z + uz * V.ahead);
    } else target = new THREE.Vector3(c.x + fwd.x * V.lead, Y(c.x, c.z), c.z + fwd.z * V.lead);
    dist = V.frame / 2 / Math.tan(hfov / 2);
  }
  const inRegion = (x, z) => x > region.x0 && z > region.z0 && x < region.x0 + region.size && z < region.z0 + region.size;
  const onModel = (x, z, m = 0) => (cut ? cut.inside(x, z, m) : slab.sd(x, z) < -m);

  // ---------- plan rasters: covers, water, sky, steepness, canopy shade, and the clay layers ----------
  const R = 1024, px = region.size / R;
  const covA = new Uint8Array(R * R * 4), covB = new Uint8Array(R * R * 4), covC = new Uint8Array(R * R * 4);
  for (let j = 0; j < R; j++)
    for (let i = 0; i < R; i++) {
      const x = region.x0 + (i + 0.5) * px, z = region.z0 + (j + 0.5) * px, o = (j * R + i) * 4, c = w.cover;
      covA[o] = w.fine(c.tree, x, z) * 255; covA[o + 1] = w.fine(c.grass, x, z) * 255; covA[o + 2] = w.fine(c.shrub, x, z) * 255; covA[o + 3] = w.fine(c.marsh, x, z) * 255;
      covB[o] = w.fine(c.bare, x, z) * 255; covB[o + 1] = w.fine(c.sand, x, z) * 255; covB[o + 2] = w.fine(w.wet, x, z) * 255; covB[o + 3] = w.riverAt(x, z) * 255;
      const s = w.slopeAt(x, z) * V.ex, ny = 1 / Math.sqrt(1 + s * s);
      covC[o] = w.fine(w.sky, x, z) * 255; covC[o + 2] = clamp((surfAt(x, z) - w.heightAt(x, z)) / 45, 0, 1) * 255; covC[o + 3] = smooth(0.8, 0.5, ny) * 255;
    }
  // The same choice of clay the ground shader makes, so each color is its own slab: thicker forest floor, thinner
  // meadow, the blue sunk lowest.
  const noiseData = shared.tNoise.value.image.data, NS = shared.tNoise.value.image.width;
  const nz = (u, v, out) => {
    u = (((u * NS - 0.5) % NS) + NS) % NS; v = (((v * NS - 0.5) % NS) + NS) % NS;
    const i0 = Math.floor(u), j0 = Math.floor(v), fu = u - i0, fv = v - j0, i1 = (i0 + 1) % NS, j1 = (j0 + 1) % NS;
    for (let c = 0; c < 4; c++) {
      const a = noiseData[(j0 * NS + i0) * 4 + c], b = noiseData[(j0 * NS + i1) * 4 + c], d = noiseData[(j1 * NS + i0) * 4 + c], e = noiseData[(j1 * NS + i1) * 4 + c];
      out[c] = ((a + (b - a) * fu) * (1 - fv) + (d + (e - d) * fu) * fv) / 255;
    }
    return out;
  };
  const clayClass = new Uint8Array(R * R), thick = new Float32Array(R * R), n1 = [0, 0, 0, 0], n2 = [0, 0, 0, 0], wt = new Float32Array(6);
  for (let j = 0; j < R; j++)
    for (let i = 0; i < R; i++) {
      const o = (j * R + i) * 4, x = region.x0 + (i + 0.5) * px, z = region.z0 + (j + 0.5) * px, qx = x / V.tile, qz = z / V.tile, wob = 0.5;
      nz(qx * 0.09, qz * 0.09, n1); nz(qx * 0.37 + 0.3, qz * 0.37 + 0.3, n2);
      const A = (k) => covA[o + k] / 255, B = (k) => covB[o + k] / 255;
      wt[0] = A(0) * 1.1 + (n1[0] - 0.5) * wob + (n2[1] - 0.5) * wob * 0.5;
      wt[1] = A(1) + (n1[1] - 0.5) * wob + (n2[2] - 0.5) * wob * 0.5;
      wt[2] = A(2) * 1.2 + (n1[2] - 0.5) * wob + (n2[0] - 0.5) * wob * 0.5;
      wt[3] = A(3) * 1.3 + (n1[3] - 0.5) * wob + (n2[3] - 0.5) * wob * 0.5;
      wt[4] = B(0) * 1.4 + (covC[o + 3] / 255) * 0.9 + (0.5 - n1[1]) * wob;
      wt[5] = B(1) * 1.8 - 0.1 + (0.5 - n1[2]) * wob;
      let bi = 0, si = 1, bw = -9, sw = -9;
      for (let k = 0; k < 6; k++) { if (wt[k] > bw) { sw = bw; si = bi; bw = wt[k]; bi = k; } else if (wt[k] > sw) { sw = wt[k]; si = k; } }
      const lo = Math.min(bi, si), hi = Math.max(bi, si), s = wt[lo] - wt[hi];
      let t = TH[hi] + (TH[lo] - TH[hi]) * smooth(-0.025, 0.025, s);
      const wetv = B(2) + (n1[1] - 0.5) * 0.14 + (n2[2] - 0.5) * 0.06, riv = B(3) + (n2[0] - 0.5) * 0.3;
      const water = Math.max(smooth(0.48, 0.52, wetv), smooth(0.48, 0.52, riv));
      thick[j * R + i] = (t + (TH_WATER - t) * water) * mm;
      clayClass[j * R + i] = water > 0.5 ? 6 : bi;
    }
  const thickB = blur(thick, R, 1);
  const rasterAt = (f, x, z) => {
    const u = clamp((x - region.x0) / px - 0.5, 0, R - 1.001), v = clamp((z - region.z0) / px - 0.5, 0, R - 1.001), i = Math.floor(u), j = Math.floor(v), fu = u - i, fv = v - j, k = j * R + i;
    return (f[k] * (1 - fu) + f[k + 1] * fu) * (1 - fv) + (f[k + R] * (1 - fu) + f[k + R + 1] * fu) * fv;
  };
  const Y0 = Y;
  Y = (x, z) => Y0(x, z) + rasterAt(thickB, x, z);
  if (VIEW !== "camp" && dio) target.y = Y(target.x, target.z);

  // ---------- camera ----------
  camera.position.set(target.x + fwd.x * Math.cos(el) * dist, target.y + Math.sin(el) * dist, target.z + fwd.z * Math.cos(el) * dist);
  camera.near = dist * 0.05;
  camera.far = dist * 14;
  camera.lookAt(target);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld();
  const frustum = new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
  const sph = new THREE.Sphere();
  const seen = (x, y, z, r) => { sph.center.set(x, y, z); sph.radius = r; return frustum.intersectsSphere(sph); };
  const camD = (x, y, z) => Math.hypot(x - camera.position.x, y - camera.position.y, z - camera.position.z);

  const scene = new THREE.Scene();

  // ---------- what stands on the clay ----------
  const batches = new Map();
  const put = (key, geo, mat, m, color, d) => {
    let b = batches.get(key);
    if (!b) batches.set(key, (b = { geo, mat, list: [] }));
    b.list.push({ m, c: color, d });
  };
  const mat4 = (x, y, z, s, sy, yaw, tilt = 0, tiltDir = 0) => MD.M(x, y, z, s, sy, s, yaw, Math.cos(tiltDir) * tilt, Math.sin(tiltDir) * tilt);
  const treeMat = clayMaterial({ detail: 1 / V.treeTile, bump: 0.8, spec: 0.42, shine: 16, foot: 0.5, objH: 0.6, tint: true, key: "tree" });
  const lowMat = clayMaterial({ detail: 1 / V.objTile, bump: 0.8, spec: 0.36, shine: 16, foot: 0.55, objH: 0.8, tint: true, key: "low" });
  const geoCache = new Map();
  const cached = (key, make) => { if (!geoCache.has(key)) geoCache.set(key, make()); return geoCache.get(key); };
  const pick = (arr, t) => arr[Math.min(arr.length - 1, Math.floor(t * arr.length))];
  const jitter = (hex, t, amt = 0.08) => { const c = lin(hex); c.multiplyScalar(1 - amt + t * amt * 2); return c; };
  // One of each thing per cell of the view's grid (the biggest), so the model gets a few big hand-rolled pieces
  // where the world has many small ones.
  const thin = (list, cell, size, ok) => {
    const best = new Map();
    for (const t of list) {
      if (!inRegion(t.x, t.z) || !ok(t)) continue;
      const k = Math.floor(t.x / cell) * 100003 + Math.floor(t.z / cell), b = best.get(k);
      if (!b || size(t) > size(b)) best.set(k, t);
    }
    return [...best.values()];
  };
  const clearing = V.camp ? 20 * V.camp.spread : 0;
  const canopyShade = new Float32Array(256 * 256);
  for (const t of w.trees) {
    if (!inRegion(t.x, t.z)) continue;
    canopyShade[Math.floor(((t.z - region.z0) / region.size) * 256) * 256 + Math.floor(((t.x - region.x0) / region.size) * 256)] += t.tall;
  }

  const T = V.trees;
  for (const t of thin(w.trees, T.cell, (t) => t.tall, (t) => onModel(t.x, t.z, t.tall * T.scale * 0.3) && (!V.camp || Math.hypot(t.x - C.x, t.z - C.z) > clearing))) {
    const s = t.tall * T.scale, y = Y(t.x, t.z);
    if (!seen(t.x, y + s * 0.55, t.z, s * 1.6)) continue;
    const d = camD(t.x, y, t.z), variant = Math.floor(t.tint * 3), h1 = hash(Math.round(t.x * 13), Math.round(t.z * 13), 9), h2 = hash(Math.round(t.x * 5), Math.round(t.z * 11), 4);
    const col = t.kind === "aspen" ? jitter(h1 < 0.3 ? CLAY.aspen[1] : pick([CLAY.aspen[0], CLAY.aspen[2]], h2), t.tint) : jitter(pick(CLAY[t.kind], h1), h2);
    const m = mat4(t.x, y - s * 0.02, t.z, s * (0.92 + h1 * 0.14), s * (0.92 + h2 * 0.16), t.yaw, h1 * 0.07, t.yaw * 3);
    const ck = `c-${t.kind}-${variant}-${T.lod}`, tk = `t-${t.kind}-${variant % 2}`;
    put(ck, cached(ck, () => MD.canopy(t.kind, 11 + variant * 7 + ["pine", "oak", "ash", "aspen"].indexOf(t.kind) * 101, T.lod)), treeMat, m, col, d);
    put(tk, cached(tk, () => MD.trunk(t.kind, 5 + (variant % 2))), treeMat, m, jitter(t.kind === "aspen" ? CLAY.birch : CLAY.trunk, h1, 0.12), d);
  }
  const lodNear = dio ? 2 : 1;
  for (const s of thin(w.shrubs, V.shrubs.cell, (s) => s.tall, (s) => onModel(s.x, s.z, s.tall * V.shrubs.scale) && (!V.camp || Math.hypot(s.x - C.x, s.z - C.z) > clearing * 0.7))) {
    const sc = s.tall * V.shrubs.scale, y = Y(s.x, s.z);
    if (!seen(s.x, y, s.z, sc * 2)) continue;
    const v = Math.floor(s.tint * 3), col = lin(CLAY.shrub).lerp(lin(CLAY.heather), smooth(0.35, 0.85, s.heath)).multiplyScalar(0.9 + s.tint * 0.2);
    put(`s-${v}`, cached(`s-${v}`, () => MD.lump(300 + v, lodNear + 1)), lowMat, mat4(s.x, y - sc * 0.08, s.z, sc * 0.75, sc * 0.6, s.yaw), col, camD(s.x, y, s.z));
  }
  for (const r of thin(w.rocks, V.rocks.cell, (r) => r.size, (r) => r.size >= V.rocks.min && onModel(r.x, r.z, r.size * V.rocks.scale))) {
    const sc = r.size * V.rocks.scale * 0.5, y = Y(r.x, r.z);
    if (!seen(r.x, y, r.z, sc * 2)) continue;
    const v = Math.floor(r.tint * 4);
    put(`r-${v}`, cached(`r-${v}`, () => MD.pebble(500 + v, lodNear + 1)), lowMat, mat4(r.x, y - sc * 0.15, r.z, sc, sc, r.yaw), jitter(CLAY.stone[v], r.tint, 0.1), camD(r.x, y, r.z));
  }

  // Grass as a few fat rolled snakes, clover dots and flowers on the meadows, reeds at the wet edges.
  const greens = ["#76a83a", "#8cbc44", "#5f9535", "#9cc24a"];
  if (V.grass) {
    const { cell: st, scale: sc } = V.grass;
    for (let z = region.z0; z < region.z0 + region.size; z += st)
      for (let x = region.x0; x < region.x0 + region.size; x += st) {
        const ix = Math.round(x * 10), iz = Math.round(z * 10), hx = hash(ix, iz, 21), hz = hash(ix, iz, 22), px = x + hx * st, pz = z + hz * st;
        if (!onModel(px, pz, sc) || Math.hypot(px - C.x, pz - C.z) < clearing * 0.75) continue;
        if (!w.dry(px, pz)) {
          const wet = w.fine(w.wet, px, pz);
          if (wet > 0.25 && wet < 0.6 && hx < 0.5 && w.heightAt(px, pz) > 0.3) {
            const y = Y(px, pz);
            if (seen(px, y, pz, sc * 3)) put("reed", cached("reed", () => MD.reeds(7)), lowMat, mat4(px, y, pz, sc * 2.2, sc * 2.6, hz * 6.28), new THREE.Color(1, 1, 1), camD(px, y, pz));
          }
          continue;
        }
        const g = w.fine(w.cover.grass, px, pz) + 0.6 * w.fine(w.cover.marsh, px, pz) + 0.3 * w.fine(w.cover.shrub, px, pz), h3 = hash(ix, iz, 23);
        if (h3 > g * 0.8) continue;
        const y = Y(px, pz);
        if (!seen(px, y, pz, sc * 2)) continue;
        const d = camD(px, y, pz), kind = hash(ix, iz, 24), v = Math.floor(hz * 3);
        if (kind < 0.12) put("flower", cached("flower", () => MD.flower(3)), lowMat, mat4(px, y, pz, sc * 1.2, sc * 1.1, hx * 6.28), lin(pick(["#e84a3a", "#f4f0e6", "#f0c43a", "#9a6ad0", "#ff8ab0"], hz)), d);
        else if (kind < 0.45) put(`dots-${v}`, cached(`dots-${v}`, () => MD.dots(20 + v, 3 + v)), lowMat, mat4(px, y, pz, sc * 1.3, sc * 1.3, hz * 6.28), jitter(pick(greens, hx), kind, 0.12), d);
        else put(`tuft-${v}`, cached(`tuft-${v}`, () => MD.tuft(40 + v, 3 + (v % 2))), lowMat, mat4(px, y - sc * 0.03, pz, sc * 1.1, sc * (0.65 + hx * 0.4), hz * 6.28), jitter(pick(greens, hx), hz, 0.08), d);
      }
  }

  // The camp's close ground, from the world's own scatter: grass snakes, clover, flowers, pebbles, fallen logs.
  if (V.nearby) {
    const nb = w.nearby(C, dio.r * 1.3, V.nearby.density);
    for (const g of nb.grass) {
      if (!onModel(g.x, g.z, 0.3)) continue;
      const y = Y(g.x, g.z), s = g.tall * 0.95;
      if (!seen(g.x, y, g.z, s)) continue;
      const v = Math.floor(g.tint * 3);
      if (g.tint > 0.75) put(`cdots-${v}`, cached(`cdots-${v}`, () => MD.dots(30 + v, 4)), lowMat, mat4(g.x, y - 0.01, g.z, s * 0.9, s * 0.9, g.yaw), jitter(pick(greens, g.yaw / 6.3), g.tint, 0.08), camD(g.x, y, g.z));
      else put(`tuft-${v}`, cached(`tuft-${v}`, () => MD.tuft(60 + v, 3 + (v % 2))), lowMat, mat4(g.x, y - 0.02, g.z, s * 1.1, s * 0.75, g.yaw), jitter(pick(greens, g.tint), g.yaw / 6.3, 0.07), camD(g.x, y, g.z));
    }
    for (const f of nb.flowers) {
      if (!onModel(f.x, f.z, 0.3)) continue;
      const y = Y(f.x, f.z), s = f.tall * 1.4;
      if (seen(f.x, y, f.z, s)) put("flower", cached("flower", () => MD.flower(9)), lowMat, mat4(f.x, y - 0.01, f.z, s, s, f.hue * 40), lin(pick(["#e8463a", "#f6f1e6", "#f2c233", "#8f62cc", "#ff86ad", "#4f8ee0"], f.hue)), camD(f.x, y, f.z));
    }
    for (const p of nb.pebbles) {
      if (!onModel(p.x, p.z, 0.5)) continue;
      const y = Y(p.x, p.z), v = Math.floor(p.tint * 4);
      if (seen(p.x, y, p.z, p.size)) put(`peb-${v}`, cached(`peb-${v}`, () => MD.pebble(700 + v, 2)), lowMat, mat4(p.x, y - p.size * 0.1, p.z, p.size * 0.8, p.size * 0.7, p.yaw), jitter(CLAY.stone[v], p.tint, 0.1), camD(p.x, y, p.z));
    }
    for (const l of nb.logs) {
      if (!onModel(l.x, l.z, l.length * 0.6)) continue;
      const y = Y(l.x, l.z), key = `log-${Math.round(l.length)}`;
      if (seen(l.x, y, l.z, l.length)) put(key, cached(key, () => MD.log(l.length, 0.22, 3)), lowMat, mat4(l.x, y + 0.14, l.z, 1, 1, l.yaw), new THREE.Color(1, 1, 1), camD(l.x, y, l.z));
    }
  }

  // ---------- the camp ----------
  let fireAt = null;
  if (V.camp) {
    const { k, spread } = V.camp, P = (p) => ({ x: C.x + (p.x - C.x) * spread, z: C.z + (p.z - C.z) * spread });
    const campMat = clayMaterial({ detail: 1 / V.objTile, bump: 0.9, spec: 0.4, shine: 18, foot: 0.7, objH: 0.4, key: "camp" });
    const tentMat = clayMaterial({ detail: 1 / V.objTile, bump: 0.9, spec: 0.32, shine: 16, foot: 0.75, objH: 0.5, side: THREE.DoubleSide, key: "tent" });
    const beadMat = clayMaterial({ detail: 1 / V.objTile, bump: 0.1, spec: 1.6, shine: 90, foot: 1, key: "bead" });
    const flameMat = clayMaterial({ detail: 1 / V.objTile, bump: 0.6, spec: 0.3, shine: 30, foot: 1, key: "flame", color: "totalEmissiveRadiance = diffuseColor.rgb * 2.6;" });
    const smokeMat = clayMaterial({ detail: 1 / V.objTile, bump: 0.7, spec: 0.12, shine: 10, foot: 1, wrap: 0.8, scatter: 0.2, key: "smoke" });
    const add = (geo, mat, x, y, z, yaw, s = k) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); m.rotation.y = yaw; m.scale.setScalar(s); m.castShadow = m.receiveShadow = true; scene.add(m); return m; };
    const low = (p, r) => { let y = Infinity; for (let a = 0; a < 6.28; a += 0.8) y = Math.min(y, Y(p.x + Math.cos(a) * r, p.z + Math.sin(a) * r)); return Math.min(y, Y(p.x, p.z)); };
    const tentLook = [["ridge", "#d49a3e"], ["ridge", "#b4553a"], ["tepee", "#e7d7b4"]];
    camp.tents.forEach((t, i) => {
      const [kind, col] = tentLook[i], g = kind === "ridge" ? MD.ridgeTent(t.size, col, 31 + i) : MD.tepee(t.size, col, "#a8412e", 41 + i), p = P(t.at);
      add(g, tentMat, p.x, low(p, t.size * 0.5 * k) - 0.03 * k, p.z, t.yaw);
    });
    const cloth = [0, 5, 10, 3, 8].map((c) => COLORS[c % COLORS.length]);
    camp.people.forEach((pp, i) => {
      const fig = MD.person(cloth[i], CLAY.skin[i % CLAY.skin.length], CLAY.hair[(i * 2) % CLAY.hair.length], 71 + i * 13, i === 2 ? 1 : i === 4 ? 2 : 0), p = P(pp.at);
      const y = Y(p.x, p.z) - 0.02 * k;
      add(fig.body, campMat, p.x, y, p.z, pp.yaw);
      add(fig.beads, beadMat, p.x, y, p.z, pp.yaw);
    });
    const wp = P(camp.woodpile);
    add(MD.woodpile(51), campMat, wp.x, Y(wp.x, wp.z) - 0.02 * k, wp.z, Math.atan2(C.x - wp.x, C.z - wp.z) + Math.PI / 2);
    const fy = Y(C.x, C.z), f = MD.fire(61);
    add(f.stones, campMat, C.x, fy - 0.02 * k, C.z, 0);
    add(f.flames, flameMat, C.x, fy - 0.02 * k, C.z, 0).castShadow = false;
    const wind = w.isle.wind;
    add(MD.smoke(81, { x: wind[0] * 0.9, z: wind[1] * 0.9 + 0.3 }), smokeMat, C.x, fy, C.z, 0).castShadow = false;
    fireAt = new THREE.Vector3(C.x, fy + 0.6 * k, C.z);
    const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture(), color: 0xff8a3a, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0.6 }));
    glow.position.copy(fireAt);
    glow.scale.setScalar(k * 3.4);
    scene.add(glow);
  }

  // Build the batches, nearest first so the far ones fail the depth test instead of being shaded.
  let count = 0;
  for (const [, b] of batches) {
    b.list.sort((p, q) => p.d - q.d);
    const im = new THREE.InstancedMesh(b.geo, b.mat, b.list.length);
    b.list.forEach((e, i) => { im.setMatrixAt(i, e.m); im.setColorAt(i, e.c); });
    im.instanceMatrix.needsUpdate = true;
    if (im.instanceColor) im.instanceColor.needsUpdate = true;
    im.castShadow = im.receiveShadow = true;
    im.frustumCulled = false;
    scene.add(im);
    count += b.list.length;
  }
  console.log("instances", count, "batches", batches.size);

  // Canopy shade on the plan: the ground under the woods is darker.
  const cs = blur(canopyShade, 256, dio ? 3 : 1), cellA = (region.size / 256) ** 2;
  for (let j = 0; j < R; j++)
    for (let i = 0; i < R; i++) covC[(j * R + i) * 4 + 1] = clamp((cs[Math.floor((j * 256) / R) * 256 + Math.floor((i * 256) / R)] / cellA) * (dio ? 6 : 12), 0, 1) * 255;

  // ---------- the ground as a mesh ----------
  const G = V.grid, pos = new Float32Array(G * G * 3);
  const fu = (target.x - region.x0) / region.size, fv = (target.z - region.z0) / region.size;
  const warp = (t, c) => {
    if (V.warp >= 1) return t;
    const a = V.warp, s = t < c ? -1 : 1, span = t < c ? c : 1 - c, u = Math.abs(t - c) / Math.max(span, 1e-6);
    return c + s * span * (a * u + (1 - a) * u * u);
  };
  let floorY = Infinity;
  for (let j = 0; j < G; j++)
    for (let i = 0; i < G; i++) {
      let x = region.x0 + warp(i / (G - 1), fu) * region.size, z = region.z0 + warp(j / (G - 1), fv) * region.size;
      if (cut) {
        // Past the cut, the grid folds onto the cut line so the ground ends exactly where the wall starts.
        const [a, b] = toLocal(cut.cx, cut.cz, x, z), l = Math.hypot(a, b), e = cut.edge(a, b);
        if (l > e) { const p = toWorld(cut.cx, cut.cz, (a / l) * e, (b / l) * e); x = p.x; z = p.z; }
      }
      const o = (j * G + i) * 3;
      pos[o] = x; pos[o + 1] = Y(x, z); pos[o + 2] = z;
      floorY = Math.min(floorY, pos[o + 1]);
    }
  const idx = new Uint32Array((G - 1) * (G - 1) * 6);
  let n = 0;
  for (let j = 0; j < G - 1; j++)
    for (let i = 0; i < G - 1; i++) {
      const a = j * G + i, b = a + 1, c = a + G, d = c + 1;
      idx[n++] = a; idx[n++] = c; idx[n++] = b; idx[n++] = b; idx[n++] = c; idx[n++] = d;
    }
  const tg = new THREE.BufferGeometry();
  tg.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  tg.setAttribute("color", new THREE.BufferAttribute(new Float32Array(G * G * 3).fill(1), 3));
  tg.setIndex(new THREE.BufferAttribute(idx, 1));
  tg.computeVertexNormals();
  const terrainMat = clayMaterial({ detail: 1 / V.tile, bump: 0.75, spec: 0.3, shine: 14, foot: 1, cavity: 0.4, mottle: 0.14, key: "terrain", decl: terrainDecl(), color: terrainColor() });
  Object.assign(terrainMat.userData.uniforms, {
    tCovA: { value: dataTex(covA, R) }, tCovB: { value: dataTex(covB, R) }, tCovC: { value: dataTex(covC, R) },
    uRegion: { value: new THREE.Vector4(region.x0, region.z0, 1 / region.size, 1 / region.size) },
    uTile: { value: V.tile }, uRipple: { value: V.ripple }, uSlab: { value: slab ? 1 : 0 },
  });
  const terrain = new THREE.Mesh(tg, terrainMat);
  terrain.receiveShadow = terrain.castShadow = true;
  terrain.frustumCulled = false;
  scene.add(terrain);

  // ---------- the cut walls, the board, the table and the tools ----------
  if (cut) {
    const y0 = floorY - dio.T * (1 - 0.0);
    scene.add(cutWall(cut, toWorld, Y, y0, V, (x, z) => clayClass[clamp(Math.floor((z - region.z0) / px), 0, R - 1) * R + clamp(Math.floor((x - region.x0) / px), 0, R - 1)]));
    const e = dio.r * 1.19 * 1.04;
    addTable(scene, { cx: cut.cx, cz: cut.cz, ha: e + dio.margin, hb: e + dio.margin, top: y0, cm: V.cm, right, fwd, rand: w.rand, props: V.props, inner: dio.r, camp: C, ground: Y, edge: cut.edge, camera });
  } else addTable(scene, { cx: slab.cx, cz: slab.cz, ha: slab.ha + 900, hb: slab.hb + 900, top: -slab.T, cm: V.cm, right, fwd, rand: w.rand, props: "island", inner: slab.ha, camp: C, ground: Y });

  // ---------- studio lights: a big soft key, a cool fill, a rim from behind ----------
  const kAz = az + V.key.turn, kEl = rad(V.key.elev);
  const dir = (a, e) => new THREE.Vector3(Math.cos(a) * Math.cos(e), Math.sin(e), Math.sin(a) * Math.cos(e));
  const key = new THREE.DirectionalLight(0xfff0dc, V.key.power);
  const reach = dio ? (dio.r + dio.margin) * 1.45 : 8800, shadowAt = new THREE.Vector3(cut ? cut.cx : slab.cx, target.y, cut ? cut.cz : slab.cz);
  key.position.copy(shadowAt).addScaledVector(dir(kAz, kEl), reach * 3);
  key.target.position.copy(shadowAt);
  key.castShadow = true;
  key.shadow.mapSize.set(4096, 4096);
  Object.assign(key.shadow.camera, { left: -reach, right: reach, top: reach, bottom: -reach, near: reach * 0.5, far: reach * 6 });
  key.shadow.camera.updateProjectionMatrix();
  key.shadow.bias = -0.0004;
  key.shadow.normalBias = ((reach * 2) / 4096) * 1.5;
  key.shadow.radius = V.shadow;
  const fill = new THREE.DirectionalLight(0xd6e2ff, 0.45);
  fill.position.copy(dir(az - 1.5, rad(28)));
  const rim = new THREE.DirectionalLight(0xfff4e6, 1.5);
  rim.position.copy(dir(az + Math.PI + 0.35, rad(30)));
  scene.add(key, key.target, fill, rim, new THREE.HemisphereLight(0xdfe6ee, 0xb9956a, 1.3));
  if (fireAt) {
    const fire = new THREE.PointLight(0xff8a3c, VIEW === "camp" ? 30 : 700, 0, 2);
    fire.position.copy(fireAt);
    scene.add(fire);
  }
  scene.background = studioTexture();

  const focus = VIEW === "island" ? target : new THREE.Vector3(C.x, Y(C.x, C.z) + (VIEW === "camp" ? 0.9 : 3), C.z);
  await render(scene, camera, { W, H, focus, dof: V.dof, ss, exposure: 0.95 });
  document.body.classList.add("ready");
}

// ---------------------------------------------------------------------------------------------------------------
// The ground's clay: covers become flat plasticine colors, marbled where two meet the way pressed and smeared clay
// streaks, with a crease at the join. Water is glossy blue clay combed into ripples along the depth, with a white
// roll of foam at the shore.
function terrainDecl() {
  const pal = [CLAY.forest, CLAY.meadow, CLAY.heath, CLAY.marsh, CLAY.rock, CLAY.sand].map(glsl).join(", ");
  return /* glsl */ `
    uniform sampler2D tCovA; uniform sampler2D tCovB; uniform sampler2D tCovC; uniform vec4 uRegion; uniform float uTile, uRipple, uSlab;
    const vec3 PAL[6] = vec3[6]( ${pal} );
    const float TH[6] = float[6]( 0.012, 0.006, 0.009, 0.004, 0.01, 0.002 );`;
}
function terrainColor() {
  return /* glsl */ `
    vec2 cuv = ( vW.xz - uRegion.xy ) * uRegion.zw;
    vec4 A = texture2D( tCovA, cuv ), B = texture2D( tCovB, cuv ), Cv = texture2D( tCovC, cuv );
    vec2 q = vW.xz / uTile;
    vec4 n1 = texture2D( tNoise, q * 0.09 ), n2 = texture2D( tNoise, q * 0.37 + 0.3 );
    float wob = 0.5, steep = Cv.a;
    float wt[6];
    wt[0] = A.r * 1.1 + ( n1.r - 0.5 ) * wob + ( n2.g - 0.5 ) * wob * 0.5;
    wt[1] = A.g + ( n1.g - 0.5 ) * wob + ( n2.b - 0.5 ) * wob * 0.5;
    wt[2] = A.b * 1.2 + ( n1.b - 0.5 ) * wob + ( n2.r - 0.5 ) * wob * 0.5;
    wt[3] = A.a * 1.3 + ( n1.a - 0.5 ) * wob + ( n2.a - 0.5 ) * wob * 0.5;
    wt[4] = B.r * 1.4 + steep * 0.9 + ( 0.5 - n1.g ) * wob;
    wt[5] = B.g * 1.8 - 0.1 + ( 0.5 - n1.b ) * wob;
    int bi = 0, si = 1; float bw = -9.0, sw = -9.0;
    for ( int i = 0; i < 6; i ++ ) {
      if ( wt[i] > bw ) { sw = bw; si = bi; bw = wt[i]; bi = i; } else if ( wt[i] > sw ) { sw = wt[i]; si = i; }
    }
    int lo = min( bi, si ), hi = max( bi, si );
    float s = wt[lo] - wt[hi];
    vec2 wq = q * 1.3 + ( n2.rg - 0.5 ) * 3.0;
    float streak = texture2D( tNoise, wq * vec2( 1.0, 0.3 ) ).r - 0.5 + ( texture2D( tNoise, wq * 2.7 ).g - 0.5 ) * 0.6;
    float b = s + streak * 0.3 * ( 1.0 - smoothstep( 0.0, 0.22, abs( s ) ) );
    float e = fwidth( b ) * 0.9 + 1e-4;
    float side = smoothstep( -e, e, b );
    vec3 col = mix( PAL[hi], PAL[lo], side );
    col *= 0.93 + 0.14 * n1.a;
    // Veins of a second batch of the same clay, never quite kneaded in.
    float vein = texture2D( tNoise, wq * 0.55 + 0.2 ).b, ve = fwidth( vein ) + 0.004;
    col *= 1.0 - 0.14 * ( 1.0 - smoothstep( 0.0, 0.02 + ve, abs( vein - 0.5 ) ) ) + 0.07 * smoothstep( 0.6 - ve, 0.6 + ve, vein );
    float relief = mix( TH[hi], TH[lo], smoothstep( -e * 4.0, e * 4.0, b ) ) * uTile;
    float crease = 1.0 - smoothstep( 0.0, e * 1.8, abs( b ) );
    col *= 1.0 - 0.3 * crease;

    float wetv = B.b + ( n1.g - 0.5 ) * 0.14 + ( n2.b - 0.5 ) * 0.06, riv = B.a + ( n2.r - 0.5 ) * 0.3;
    float ew = fwidth( wetv ) + 1e-4, er = fwidth( riv ) + 1e-4;
    float water = max( smoothstep( 0.5 - ew, 0.5 + ew, wetv ), smoothstep( 0.5 - er, 0.5 + er, riv ) );
    float depth = Cv.b;
    vec3 wc = mix( ${glsl(CLAY.shallow)}, ${glsl(CLAY.sea)}, smoothstep( 0.0, 0.2, depth ) );
    wc = mix( wc, ${glsl(CLAY.deep)}, smoothstep( 0.3, 0.9, depth ) );
    float rip = sin( depth * uRipple + ( n2.b - 0.5 ) * 9.0 + ( n1.r - 0.5 ) * 6.0 ) * ( 1.0 - smoothstep( 0.2, 0.9, depth ) );
    wc *= 1.0 + 0.08 * rip;
    float foam = ( 1.0 - smoothstep( 0.0, 0.035 + ew, abs( wetv - 0.55 ) ) ) * ( 1.0 - smoothstep( 0.3, 0.6, riv ) );
    col = mix( col, wc, water );
    col = mix( col, ${glsl(CLAY.foam)}, foam );
    relief = mix( relief, uTile * ( 0.005 * rip - 0.004 ), water ) + foam * 0.012 * uTile;
    gExtra.xz += groundSlope( relief ) * 0.9;
    gSpec = mix( gSpec, 0.45, water ); gShine = mix( gShine, 50.0, water ); gBump = mix( 1.0, 0.3, water );
    gAO = ( 0.5 + 0.5 * smoothstep( 0.55, 0.97, Cv.r ) ) * ( 1.0 - 0.45 * Cv.g * ( 1.0 - water ) ) * ( 1.0 - 0.35 * crease * ( 1.0 - water ) );
    // Below the sea surface on the island's rolled edge the clay is all sea blue.
    if ( uSlab > 0.5 && vW.y < -2.0 ) { col = mix( ${glsl(CLAY.deep)}, ${glsl(CLAY.sea)}, 0.4 ); gSpec = 0.4; gShine = 40.0; gAO = 0.85; }
    diffuseColor.rgb = col;`;
}

// The cut edge of a diorama: a wall of clay from the ground's edge down to the board, the ground's own color in a
// band at the top over the brown clay it was built on, a rolled lip, a squashed foot, and wire drag lines.
function cutWall(cut, toWorld, Y, y0, V, classAt) {
  const N = 900, J = 12, pos = [], col = [], idx = [], mm = V.cm / 10;
  const top = [CLAY.forest, CLAY.meadow, CLAY.heath, CLAY.marsh, CLAY.rock, CLAY.sand, CLAY.sea].map((h) => new THREE.Color(h));
  const soil = new THREE.Color("#7c5436"), deep = new THREE.Color("#5a3b26"), band = new THREE.Color("#94683f"), c = new THREE.Color();
  for (let i = 0; i < N; i++) {
    const th = (i / N) * Math.PI * 2, a = Math.cos(th), b = Math.sin(th), e = cut.edge(a, b), p = toWorld(cut.cx, cut.cz, a * e, b * e);
    const yt = Y(p.x, p.z), cls = classAt(p.x, p.z), hgt = yt - y0;
    for (let j = 0; j <= J; j++) {
      const t = j / J, y = yt - hgt * t, depthMM = (yt - y) / mm;
      const out = mm * (3.2 * (1 - t) ** 10 + 1.6 * t ** 12 + 0.5 * fbm(th * e * 0.08 / mm, y / (mm * 6), 77, 2) + 0.25 * fbm(th * e * 0.4 / mm, y / (mm * 1.5), 79, 1));
      const q = toWorld(cut.cx, cut.cz, a * (e + out), b * (e + out));
      pos.push(q.x, y, q.z);
      if (depthMM < 2.2 + 0.6 * fbm(th * 40, 3, 81, 1)) c.copy(top[cls]);
      else c.copy(soil).lerp(deep, smooth(0.2, 1, t)).lerp(band, Math.exp(-(((depthMM - 9) / 1.4) ** 2)) * 0.7);
      col.push(c.r, c.g, c.b);
    }
  }
  for (let i = 0; i < N; i++)
    for (let j = 0; j < J; j++) {
      const a = i * (J + 1) + j, b = ((i + 1) % N) * (J + 1) + j;
      idx.push(a, a + 1, b, b, a + 1, b + 1);
    }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  const m = new THREE.Mesh(g, clayMaterial({
    detail: 1 / (V.tile * 0.6), bump: 0.8, spec: 0.3, shine: 14, foot: 1, side: THREE.DoubleSide, key: "wall",
    color: `gExtra.y += 0.35 * sin( vW.y * ${((Math.PI * 2) / (mm * 1.1)).toFixed(4)} + texture2D( tNoise, vW.xz * ${(1 / (mm * 60)).toFixed(5)} ).r * 9.0 );`,
  }));
  m.castShadow = m.receiveShadow = true;
  m.frustumCulled = false;
  return m;
}

function blur(src, n, r) {
  let a = Float32Array.from(src), b = new Float32Array(n * n);
  for (let pass = 0; pass < 2; pass++) {
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) { let s = 0, c = 0; for (let k = -r; k <= r; k++) { const x = i + k; if (x >= 0 && x < n) { s += a[j * n + x]; c++; } } b[j * n + i] = s / c; }
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) { let s = 0, c = 0; for (let k = -r; k <= r; k++) { const y = j + k; if (y >= 0 && y < n) { s += b[y * n + i]; c++; } } a[j * n + i] = s / c; }
  }
  return a;
}

function glowTexture() {
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const g = c.getContext("2d"), gr = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  gr.addColorStop(0, "rgba(255,200,140,1)");
  gr.addColorStop(0.3, "rgba(255,140,60,0.45)");
  gr.addColorStop(1, "rgba(255,120,40,0)");
  g.fillStyle = gr;
  g.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// The studio behind the table: a dim warm wall lit in a soft pool.
function studioTexture() {
  const c = document.createElement("canvas");
  c.width = 256; c.height = 256;
  const g = c.getContext("2d"), gr = g.createRadialGradient(128, 200, 10, 128, 200, 260);
  gr.addColorStop(0, "#9a8a76");
  gr.addColorStop(0.5, "#5e5248");
  gr.addColorStop(1, "#2a231e");
  g.fillStyle = gr;
  g.fillRect(0, 0, 256, 256);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// ---------------------------------------------------------------------------------------------------------------
// The sculpting table: a birch board under the model, a dark worktop, and what the animator left lying about: a
// wire loop tool, a boxwood spatula, a row of fresh plasticine bars, balls and snakes of spare clay, crumbs.
function addTable(scene, { cx, cz, ha, hb, top, cm, right, fwd, rand, props, inner, camp, ground, edge, camera }) {
  const thick = 2 * cm, bev = 0.25 * cm;
  const at = (a, b) => new THREE.Vector3(cx + right.x * a + fwd.x * b, 0, cz + right.z * a + fwd.z * b);
  const yaw = Math.atan2(right.x, right.z) - Math.PI / 2;
  const shape = new THREE.Shape(), rr = Math.min(ha, hb) * 0.12;
  shape.moveTo(-ha + rr, -hb);
  shape.lineTo(ha - rr, -hb); shape.quadraticCurveTo(ha, -hb, ha, -hb + rr);
  shape.lineTo(ha, hb - rr); shape.quadraticCurveTo(ha, hb, ha - rr, hb);
  shape.lineTo(-ha + rr, hb); shape.quadraticCurveTo(-ha, hb, -ha, hb - rr);
  shape.lineTo(-ha, -hb + rr); shape.quadraticCurveTo(-ha, -hb, -ha + rr, -hb);
  const bg = new THREE.ExtrudeGeometry(shape, { depth: thick, bevelEnabled: true, bevelThickness: bev, bevelSize: bev, bevelSegments: 3, curveSegments: 8 });
  bg.rotateX(-Math.PI / 2);
  const uv = bg.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) / (ha * 2) + 0.5, uv.getY(i) / (hb * 2) + 0.5);
  const board = new THREE.Mesh(bg, new THREE.MeshStandardMaterial({ map: woodTexture(rand, "#d9b27c", "#b98a55", 7), roughness: 0.55 }));
  const c0 = at(0, 0);
  board.position.set(c0.x, top - thick - bev, c0.z);
  board.rotation.y = yaw;
  board.receiveShadow = board.castShadow = true;
  scene.add(board);
  const yW = top - thick - bev * 2 - 0.02 * cm;
  const desk = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshStandardMaterial({ map: woodTexture(rand, "#5a3a26", "#3f281a", 3, 8), roughness: 0.7 }));
  desk.scale.set(ha * 14, hb * 14, 1);
  desk.rotation.set(-Math.PI / 2, 0, yaw);
  desk.position.set(c0.x, yW, c0.z);
  desk.receiveShadow = true;
  scene.add(desk);

  const clay = clayMaterial({ detail: 1 / (6 * cm), bump: 0.8, spec: 0.4, shine: 18, foot: 0.85, objH: cm, key: "props" });
  const wood = clayMaterial({ detail: 1 / (9 * cm), bump: 0.25, spec: 0.5, shine: 30, foot: 1, key: "toolwood" });
  const V3 = (x, y, z) => new THREE.Vector3(x * cm, y * cm, z * cm);
  const mesh = (g, mat) => { const m = new THREE.Mesh(g, mat); m.castShadow = m.receiveShadow = true; return m; };
  // A wire loop tool (boxwood handle, brass ferrule, steel loop) and a boxwood spatula, both lying along +x.
  const loopTool = () => {
    const g = new THREE.Group();
    const handle = mesh(MD.assemble([{ g: MD.snake([V3(-7, 0, 0), V3(-2, 0.05, 0), V3(3, 0, 0)], 0.5 * cm, 0.42 * cm, { radial: 10, seg: 10 }), c: "#caa071" }]), wood);
    handle.position.copy(V3(0, 0.5, 0));
    g.add(handle);
    const fer = mesh(new THREE.CylinderGeometry(0.3 * cm, 0.4 * cm, 1.4 * cm, 12), new THREE.MeshStandardMaterial({ color: 0xc9a34a, metalness: 0.85, roughness: 0.3 }));
    fer.position.copy(V3(3.7, 0.45, 0));
    fer.rotation.z = Math.PI / 2;
    const loop = mesh(new THREE.TorusGeometry(1.3 * cm, 0.11 * cm, 8, 32), new THREE.MeshStandardMaterial({ color: 0xa3a9ae, metalness: 0.9, roughness: 0.28 }));
    loop.position.copy(V3(5.7, 0.12, 0));
    loop.rotation.x = -Math.PI / 2;
    g.add(fer, loop);
    return g;
  };
  const spatula = () => mesh(MD.assemble([{ g: MD.snake([V3(-8, 0, 0), V3(-3, 0, 0.1), V3(3, 0, -0.1), V3(8, 0, 0)], 0.6 * cm, 0.5 * cm, { radial: 10, seg: 14 }), c: "#bf8f58", m: MD.M(0, 0.25 * cm, 0, 1, 0.4, 1.25) }]), wood);
  const put = (obj, p, y, ry, tilt = 0) => { obj.position.set(p.x, y, p.z); obj.rotation.order = "YXZ"; obj.rotation.set(0, yaw + ry, tilt); scene.add(obj); return obj; };
  const place = (g, a, b, y, ry) => put(mesh(g, clay), at(a * cm, b * cm), y, ry);
  const bars = (a, b, y, ry) => ["#3f7f2f", "#c9523a", "#2f6fbd", "#e3c37e", "#f1ede2", "#8e5a86"].forEach((col, k) => {
    const g = MD.knead(MD.lathe([[0.001, -3.2], [0.62, -3.2], [0.7, -3.0], [0.7, 3.0], [0.62, 3.2], [0.001, 3.2]].map(([x, z]) => [x * cm, z * cm]), 4), { amp: 0.01, seed: k + 3 });
    g.rotateY(Math.PI / 4);
    place(MD.assemble([{ g, c: col, m: MD.M(0, 0.5 * cm, 0, 1, 1, 1, 0, 0, Math.PI / 2) }]), a + k * 1.6, b + (k % 2) * 0.4, y, ry + Math.PI / 2);
  });
  const lump = (g, col, a, b, y, s, ry = 0, lift = s * 0.8) => place(MD.assemble([{ g, c: col, m: MD.M(0, lift, 0, s, s * 0.85, s) }]), a, b, y, ry);
  const crumbs = (a0, a1, b0, b1, y, n) => {
    for (let k = 0; k < n; k++) {
      const a = a0 + rand() * (a1 - a0), b = b0 + rand() * (b1 - b0), s = (0.12 + rand() * 0.25) * cm;
      place(MD.assemble([{ g: MD.ball(1, k + 90, { amp: 0.2 }), c: [CLAY.meadow, CLAY.forest, CLAY.sea, CLAY.sand, CLAY.heath, "#c9523a"][k % 6], m: MD.M(0, s * 0.35, 0, s, s * 0.55, s) }]), a, b, y, rand() * 6);
    }
  };
  const A = ha / cm, B = hb / cm, I = inner / cm, yT = top, snakeG = MD.snake([V3(-5, 0, 0), V3(-1.5, 0, 1.2), V3(2, 0, -0.6), V3(5, 0, 0.4)], 0.55 * cm, 0.5 * cm, { radial: 10, seg: 16 });
  if (props === "front") {
    // Tools go where the lens actually sees the board margin: the right-most, left-most and nearest free spots.
    const spots = [], v = new THREE.Vector3();
    for (let b = -B + 4; b <= B - 4; b += 2)
      for (let a = -A + 4; a <= A - 4; a += 2) {
        if (Math.hypot(a, b) * cm < edge(a * cm, b * cm) + 7 * cm) continue;
        const p = at(a * cm, b * cm);
        v.set(p.x, yT, p.z).project(camera);
        if (Math.abs(v.x) < 0.86 && Math.abs(v.y) < 0.86 && v.z < 1) spots.push({ a, b, x: v.x, y: v.y });
      }
    const best = (score) => spots.reduce((m, s) => (!m || score(s) > score(m) ? s : m), null);
    const R = best((s) => s.x), Lf = best((s) => -s.x), N = best((s) => -s.y);
    const along = (s) => (Math.abs(s.a) > Math.abs(s.b) ? Math.PI / 2 + 0.12 : 0.1);
    if (R) put(loopTool(), at(R.a * cm, R.b * cm), yT, along(R));
    if (Lf) bars(Lf.a - 4, Lf.b, yT, 0.05);
    if (N && N !== R && N !== Lf) put(spatula(), at(N.a * cm, N.b * cm), yT, along(N) + 0.2);
    lump(snakeG, CLAY.meadow, A * 0.7, B - (B - I) * 0.5, yT, 1, 0.4, 0.5 * cm);
    lump(MD.ball(3, 3), CLAY.sea, A * 0.9, B - 3, yT, 1.1 * cm);
    lump(MD.ball(3, 4, { flatBase: -0.3 }), "#c9523a", -A * 0.85, B - 2.5, yT, 0.9 * cm);
    for (const s of spots.filter((_, k) => k % 97 === 0).slice(0, 5)) lump(MD.ball(3, 7 + s.a), [CLAY.heath, CLAY.sea, "#c9523a", CLAY.sand][Math.floor(Math.abs(s.a)) % 4], s.a, s.b, yT, 0.9 * cm);
    crumbs(-A, A, I + 1, B - 0.5, yT, 26);
  } else if (props === "camp") {
    // On the set itself, beside the camp, where the animator put them down: a loop tool lying in the meadow, a
    // spatula pushed into the clay, a ball and a snake of spare clay.
    const spot = (a, b) => ({ x: camp.x + right.x * a + fwd.x * b, z: camp.z + right.z * a + fwd.z * b });
    const g = (a, b) => { const p = spot(a, b); return [p, ground(p.x, p.z)]; };
    const big = (o) => { o.scale.setScalar(1.7); return o; };
    let [p, y] = g(3.0, 2.8);
    put(big(loopTool()), p, y - 0.15 * cm, 0.55, 0.03);
    [p, y] = g(7.0, -4.5);
    put(big(spatula()), { x: p.x, z: p.z }, y + 6 * cm, 0.4, Math.PI / 2 - 0.3);
    [p, y] = g(-6.2, -2.8);
    put(mesh(MD.assemble([{ g: MD.ball(3, 4, { flatBase: -0.3 }), c: "#c9523a", m: MD.M(0, 2.2 * cm, 0, 2.8 * cm, 2.4 * cm, 2.8 * cm) }]), clay), p, y, 0);
    [p, y] = g(-4.4, 3.4);
    put(mesh(MD.assemble([{ g: snakeG, c: "#3a86c6", m: MD.M(0, 0.8 * cm, 0, 1.5, 1.4, 1.5) }]), clay), p, y, -0.5);
  } else {
    put(loopTool(), at(-(I + (A - I) * 0.5) * cm, B * 0.1 * cm), yT, Math.PI / 2 + 0.1);
    put(spatula(), at((A + 6) * cm, B * 0.25 * cm), yW, Math.PI / 2 - 0.15);
    bars(A + 3, -B * 0.4, yW, 0.05);
    lump(snakeG, CLAY.meadow, A - 2.5, -B * 0.2, yT, 1, 0.7, 0.5 * cm);
    lump(MD.ball(3, 3), CLAY.sea, A - 2.7, B * 0.35, yT, 1.3 * cm);
    lump(MD.ball(3, 4, { flatBase: -0.3 }), "#c9523a", -A + 2.8, B * 0.55, yT, 1.2 * cm);
    lump(MD.ball(3, 5), CLAY.heath, -A + 3.2, -B * 0.3, yT, 1.1 * cm);
    crumbs(-A, A, B - 4, B - 0.6, yT, 20);
  }
}

function woodTexture(rand, light, dark, planks, rings = 14) {
  const S = 1024, c = document.createElement("canvas");
  c.width = c.height = S;
  const g = c.getContext("2d"), img = g.createImageData(S, S), a = new THREE.Color().setStyle(light, THREE.LinearSRGBColorSpace), b = new THREE.Color().setStyle(dark, THREE.LinearSRGBColorSpace);
  const off = Array.from({ length: planks }, () => rand() * 100);
  for (let y = 0; y < S; y++) {
    const p = Math.floor((y / S) * planks), fy = (y / S) * planks - p;
    for (let x = 0; x < S; x++) {
      const u = x / S, wv = fbm(u * 3 + off[p], fy * 2 + off[p], 11, 3);
      let t = 0.5 + 0.5 * Math.sin((fy * rings + wv * 3 + u * 0.8) * Math.PI * 2);
      t = Math.pow(t, 3) * 0.6 + 0.25 * (0.5 + 0.5 * fbm(u * 40 + off[p], fy * 6, 12, 2));
      const edge = fy < 0.012 || fy > 0.988 ? 0.55 : 1, k = (y * S + x) * 4, sh = 0.94 + (off[p] % 1) * 0.12;
      img.data[k] = (a.r + (b.r - a.r) * t) * 255 * edge * sh;
      img.data[k + 1] = (a.g + (b.g - a.g) * t) * 255 * edge * sh;
      img.data[k + 2] = (a.b + (b.b - a.b) * t) * 255 * edge * sh;
      img.data[k + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}
