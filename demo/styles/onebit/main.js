// One bit, two inks. The island is lit in gray on the GPU (sun, shadow, fog, a fire), then on the CPU it is outlined
// from depth, normals and ids, blurred toward the top and bottom, and dithered to 1 bit at 640x360: blue noise for
// land and everything on it, an ordered Bayer tile for sky and water. The result is doubled into the canvas.
import * as THREE from "three";
import { grow, clamp, smooth, hash, noise } from "../world.js";
import { COLORS } from "../island.js";
import { blueNoise, bayer } from "./dither.js";
import * as MD from "./models.js";
import * as SH from "./shaders.js";

const W = 640, H = 360, SCALE = 2, SS = 2;
const INK = [0x33, 0x33, 0x19], PAPER = [0xe5, 0xff, 0xff];
const SKY = 0, LAND = 1, VEG = 2, OBJ = 3, WATER = 4, FIRE = 5, ROPE = 6;
const params = new URLSearchParams(location.search);
const VIEW = ["island", "valley", "camp"].includes(params.get("view")) ? params.get("view") : "valley";
const SEED = Number(params.get("seed") || 1), DEBUG = params.get("debug");

class Buf {
  constructor(n = 4096) { this.a = new Float32Array(n); this.n = 0; }
  room(k) { if (this.n + k > this.a.length) { const b = new Float32Array(Math.max(this.a.length * 2, this.n + k)); b.set(this.a); this.a = b; } }
  push3(x, y, z) { this.room(3); this.a[this.n++] = x; this.a[this.n++] = y; this.a[this.n++] = z; }
  push1(v) { this.room(1); this.a[this.n++] = v; }
  view() { return this.a.slice(0, this.n); }
}

// ---------- the ground: a faceted mesh, finer near the camp, and the exact height of its facets ----------

// `stride` coarsens the far mesh (in fine-grid steps) for a view so distant its facets would be finer than a pixel.
function makeGround(w, patch, stride = 1) {
  const { M, STEP, START, h } = w;
  let near = null;
  if (patch) {
    const u0 = Math.round((patch.x - patch.r - START) / STEP), v0 = Math.round((patch.z - patch.r - START) / STEP), nq = Math.round((2 * patch.r) / STEP);
    const s = STEP / 2, n = nq * 2, x0 = START + u0 * STEP, z0 = START + v0 * STEP, hh = new Float32Array((n + 1) * (n + 1));
    for (let j = 0; j <= n; j++)
      for (let i = 0; i <= n; i++) {
        const x = x0 + i * s, z = z0 + j * s;
        // Extra relief for the finer facets, faded to nothing at the patch edge so it meets the coarse mesh exactly.
        const edge = Math.min(1, Math.min(i, j, n - i, n - j) / 4);
        const calm = (1 - w.fine(w.wet, x, z)) * (1 - w.riverAt(x, z)) * smooth(9, 22, Math.hypot(x - w.camp.at.x, z - w.camp.at.z));
        hh[j * (n + 1) + i] = w.heightAt(x, z) + edge * calm * (0.6 * noise(x / 26, z / 26, 91) + 0.25 * noise(x / 11, z / 11, 92));
      }
    near = { u0, v0, nq, x0, z0, s, n, hh };
  }
  const flipFar = (i, j) => hash(i, j, 3) < 0.5, flipNear = (i, j) => hash(i + 7777, j, 4) < 0.5;
  const facet = (h00, h10, h01, h11, fu, fv, flip) => {
    if (!flip) return fu >= fv ? h00 + fu * (h10 - h00) + fv * (h11 - h10) : h00 + fv * (h01 - h00) + fu * (h11 - h01);
    return fu + fv <= 1 ? h00 + fu * (h10 - h00) + fv * (h01 - h00) : h11 + (1 - fu) * (h01 - h11) + (1 - fv) * (h10 - h11);
  };
  const groundY = (x, z) => {
    if (near) {
      const fu = (x - near.x0) / near.s, fv = (z - near.z0) / near.s;
      if (fu >= 0 && fv >= 0 && fu < near.n && fv < near.n) {
        const i = Math.floor(fu), j = Math.floor(fv), N1 = near.n + 1, k = j * N1 + i, hh = near.hh;
        return facet(hh[k], hh[k + 1], hh[k + N1], hh[k + N1 + 1], fu - i, fv - j, flipNear(i, j));
      }
    }
    const S = stride, Q = (M - 1) / S, fu = clamp((x - START) / (STEP * S), 0, Q - 0.001), fv = clamp((z - START) / (STEP * S), 0, Q - 0.001);
    const i = Math.floor(fu), j = Math.floor(fv), k = j * S * M + i * S;
    return facet(h[k], h[k + S], h[k + S * M], h[k + S * M + S], fu - i, fv - j, flipFar(i, j));
  };
  return { near, groundY, flipFar, flipNear, stride };
}

function groundTone(w, x, z, ny) {
  const c = w.cover, f = (k) => w.fine(c[k], x, z);
  let a = f("tree") * 0.3 + f("shrub") * 0.46 + f("grass") * 0.72 + f("marsh") * 0.42 + f("bare") * 0.78 + f("sand") * 0.95;
  a += (0.62 - a) * smooth(0.82, 0.6, ny);
  const cx = (x - w.START) / w.CELL, cz = (z - w.START) / w.CELL;
  a += (0.97 - a) * smooth(0.32, 0.55, w.bilinear(w.isle.snow, cx, cz)) * smooth(0.55, 0.8, ny);
  // Trodden dark earth and ash round the fire, so its glow has something to light.
  const d = Math.hypot(x - w.camp.at.x, z - w.camp.at.z);
  a += (0.4 - a) * smooth(5.5, 2.5, d);
  return a;
}

function terrainGeometry(w, G, inView) {
  const { M, STEP, START, h } = w, P = new Buf(1 << 22), A = new Buf(1 << 20), O = new Buf(1 << 20), S = G.stride, Q = (M - 1) / S, D = STEP * S;
  const face = (a, b, c) => {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx, ln = Math.hypot(nx, ny, nz) || 1;
    const cx = (a[0] + b[0] + c[0]) / 3, cz = (a[2] + b[2] + c[2]) / 3;
    const alb = groundTone(w, cx, cz, Math.abs(ny / ln)) * (0.93 + 0.14 * hash(Math.round(cx * 3), Math.round(cz * 3), 12));
    const ao = 0.35 + 0.65 * w.fine(w.sky, cx, cz);
    for (const p of [a, b, c]) { P.push3(p[0], p[1], p[2]); A.push1(alb); O.push1(ao); }
  };
  const quad = (p00, p10, p01, p11, flip) => {
    if (!flip) { face(p00, p10, p11); face(p00, p11, p01); }
    else { face(p00, p10, p01); face(p10, p11, p01); }
  };
  const nr = G.near, CH = 16, box = new THREE.Box3();
  for (let cj = 0; cj < Q; cj += CH)
    for (let ci = 0; ci < Q; ci += CH) {
      let lo = Infinity, hi = -Infinity;
      for (let j = cj; j <= Math.min(cj + CH, Q); j++) for (let i = ci; i <= Math.min(ci + CH, Q); i++) { const v = h[j * S * M + i * S]; lo = Math.min(lo, v); hi = Math.max(hi, v); }
      if (hi < -2.5) continue;
      box.min.set(START + ci * D, lo, START + cj * D);
      box.max.set(START + (ci + CH) * D, hi, START + (cj + CH) * D);
      if (!inView(box)) continue;
      for (let j = cj; j < Math.min(cj + CH, Q); j++)
        for (let i = ci; i < Math.min(ci + CH, Q); i++) {
          if (nr && i >= nr.u0 && i < nr.u0 + nr.nq && j >= nr.v0 && j < nr.v0 + nr.nq) continue;
          const k = j * S * M + i * S, h00 = h[k], h10 = h[k + S], h01 = h[k + S * M], h11 = h[k + S * M + S];
          if (h00 < -2.5 && h10 < -2.5 && h01 < -2.5 && h11 < -2.5) continue;
          const x = START + i * D, z = START + j * D;
          quad([x, h00, z], [x + D, h10, z], [x, h01, z + D], [x + D, h11, z + D], G.flipFar(i, j));
        }
    }
  if (nr) {
    const N1 = nr.n + 1, s = nr.s;
    for (let j = 0; j < nr.n; j++)
      for (let i = 0; i < nr.n; i++) {
        const k = j * N1 + i, x = nr.x0 + i * s, z = nr.z0 + j * s, hh = nr.hh;
        if (hh[k] < -2.5 && hh[k + 1] < -2.5 && hh[k + N1] < -2.5 && hh[k + N1 + 1] < -2.5) continue;
        quad([x, hh[k], z], [x + s, hh[k + 1], z], [x, hh[k + N1], z + s], [x + s, hh[k + N1 + 1], z + s], G.flipNear(i, j));
      }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(P.view(), 3));
  g.setAttribute("aAlb", new THREE.BufferAttribute(A.view(), 1));
  g.setAttribute("aAO", new THREE.BufferAttribute(O.view(), 1));
  return g;
}

// ---------- water: the sea, lakes at their spill level, and streams as ribbons ----------

function waterGeometry(w, G, cam, pxScale, wide) {
  const P = new Buf(1 << 16), { isle, N, M, K, STEP, START } = w;
  const quad = (a, b, c, d) => { for (const p of [a, b, c, a, c, d]) P.push3(p[0], p[1], p[2]); };
  const S = 40000;
  quad([-S, 0, -S], [S, 0, -S], [S, 0, S], [-S, 0, S]);
  const level = (u, v) => {
    const cx = u / K, cy = v / K;
    let best = NaN;
    for (const [i, j] of [[Math.floor(cx), Math.floor(cy)], [Math.ceil(cx), Math.floor(cy)], [Math.floor(cx), Math.ceil(cy)], [Math.ceil(cx), Math.ceil(cy)]]) {
      const k = clamp(j, 0, N - 1) * N + clamp(i, 0, N - 1);
      if (isle.water[k] > 0) { const L = isle.height[k] + isle.water[k]; if (!(L <= best)) best = L; }
    }
    return best;
  };
  for (let v = 0; v < M - 1; v++)
    for (let u = 0; u < M - 1; u++) {
      const i = v * M + u;
      if (Math.max(w.wet[i], w.wet[i + 1], w.wet[i + M], w.wet[i + M + 1]) < 0.02) continue;
      let L = NaN;
      for (const [a, b] of [[u, v], [u + 1, v], [u, v + 1], [u + 1, v + 1]]) { const l = level(a, b); if (!(l <= L)) L = l; }
      if (!(L > 0.25)) continue;
      const x = START + u * STEP, z = START + v * STEP;
      quad([x, L, z], [x + STEP, L, z], [x + STEP, L, z + STEP], [x, L, z + STEP]);
    }
  // Streams: a ribbon laid just above the lower bank, so the higher bank can hide its edge.
  const ds = wide ? 24 : 4;
  for (const line of w.rivers) {
    const pts = [];
    for (let k = 1; k < line.length; k++) {
      const [x0, z0, q0] = line[k - 1], [x1, z1, q1] = line[k], len = Math.hypot(x1 - x0, z1 - z0), n = Math.max(1, Math.ceil(len / ds));
      for (let s = 0; s < n; s++) { const t = s / n; pts.push([x0 + (x1 - x0) * t, z0 + (z1 - z0) * t, q0 + (q1 - q0) * t]); }
    }
    pts.push(line.at(-1));
    let prev = null;
    for (let k = 0; k < pts.length; k++) {
      const [x, z, q] = pts[k], a = pts[Math.max(0, k - 1)], b = pts[Math.min(pts.length - 1, k + 1)];
      if (w.fine(w.wet, x, z) > 0.5) { prev = null; continue; }
      let tx = b[0] - a[0], tz = b[1] - a[1];
      const tl = Math.hypot(tx, tz) || 1;
      tx /= tl; tz /= tl;
      const dist = Math.hypot(x - cam.position.x, z - cam.position.z, G.groundY(x, z) - cam.position.y);
      const hw = Math.max(w.riverWidth(q) / 2, wide ? (0.8 * dist) / pxScale : 0);
      const lx = x - tz * hw, lz = z + tx * hw, rx = x + tz * hw, rz = z - tx * hw;
      // Widened for a far view, a stream is wider than the facets it runs through, so it rides over its banks.
      const y = wide ? Math.max(G.groundY(lx, lz), G.groundY(rx, rz), G.groundY(x, z)) + 3 : Math.max(Math.min(G.groundY(lx, lz), G.groundY(rx, rz)) + 0.1, G.groundY(x, z) + 0.35);
      const cur = [[lx, y, lz], [rx, y, rz]];
      if (prev) quad(prev[0], prev[1], cur[1], cur[0]);
      prev = cur;
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(P.view(), 3));
  return g;
}

// ---------- instanced models ----------

class Bucket {
  constructor(geo, unit, opt = {}) { this.geo = geo; this.unit = unit; this.opt = opt; this.m = new Buf(1024); this.t = new Buf(64); this.id = new Buf(64); }
  add(x, y, z, yaw, sx, sy, sz, tint, id) {
    const c = Math.cos(yaw), s = Math.sin(yaw), m = this.m;
    m.room(16);
    m.a.set([c * sx, 0, -s * sx, 0, 0, sy, 0, 0, s * sz, 0, c * sz, 0, x, y, z, 1], m.n);
    m.n += 16;
    this.t.push1(tint);
    this.id.push1(id);
  }
  get count() { return this.t.n; }
}

function lum(hex) {
  const v = parseInt(hex.slice(1), 16), r = ((v >> 16) & 255) / 255, g = ((v >> 8) & 255) / 255, b = (v & 255) / 255;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

// ---------- cameras ----------

// Yaw and pitch that put `target` at a chosen spot on screen.
function aim(cam, eye, target, ndcX, ndcY) {
  const dx = target.x - eye.x, dy = target.y - eye.y, dz = target.z - eye.z, hd = Math.hypot(dx, dz);
  const vf = THREE.MathUtils.degToRad(cam.fov) / 2, hf = Math.atan(Math.tan(vf) * cam.aspect);
  const yaw = Math.atan2(dz, dx) + ndcX * hf, pitch = Math.atan2(dy, hd) - ndcY * vf;
  cam.position.copy(eye);
  cam.up.set(0, 1, 0);
  cam.lookAt(eye.x + Math.cos(yaw) * Math.cos(pitch), eye.y + Math.sin(pitch), eye.z + Math.sin(yaw) * Math.cos(pitch));
  cam.updateMatrixWorld();
  return yaw;
}

function treeIndex(w, cx, cz, R, cell = 16) {
  const map = new Map();
  w.trees.forEach((t, i) => {
    if (Math.abs(t.x - cx) > R || Math.abs(t.z - cz) > R) return;
    const key = Math.floor(t.x / cell) * 100003 + Math.floor(t.z / cell);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(i);
  });
  return { near(x, z, r, fn) { for (let a = Math.floor((x - r) / cell); a <= Math.floor((x + r) / cell); a++) for (let b = Math.floor((z - r) / cell); b <= Math.floor((z + r) / cell); b++) for (const i of map.get(a * 100003 + b) || []) fn(i); } };
}

// Trees whose crowns cross the line of sight from an eye to a target.
const CROWN = { pine: 0.26, oak: 0.46, ash: 0.34, aspen: 0.2 };
function blockers(w, idx, x, z, eye, c, ty) {
  const hits = new Map(), r = Math.hypot(c.x - x, c.z - z), steps = Math.ceil(r / 3);
  for (let s = 1; s < steps - 1; s++) {
    const t = s / steps, px = x + (c.x - x) * t, pz = z + (c.z - z) * t, ly = eye + (ty - eye) * t;
    idx.near(px, pz, 10, (i) => {
      const tr = w.trees[i];
      if (!hits.has(i) && Math.hypot(tr.x - px, tr.z - pz) < tr.tall * CROWN[tr.kind] + 0.5 && ly < tr.y + tr.tall && ly > tr.y) hits.set(i, t * r);
    });
  }
  return hits;
}

function sunVector(az, el) { return new THREE.Vector3(Math.cos(el) * Math.cos(az), Math.sin(el), Math.cos(el) * Math.sin(az)); }

function planShot(w) {
  const c = w.camp.at, camp = new THREE.Vector3(c.x, c.y, c.z), cam = new THREE.PerspectiveCamera(40, W / H, 1, 60000);
  if (VIEW === "island") {
    const land = [];
    let cx = 0, cz = 0;
    for (let k = 0; k < w.N * w.N; k++) {
      if (w.isle.height[k] <= 1) continue;
      const p = new THREE.Vector3(w.START + (k % w.N) * w.CELL, w.isle.height[k], w.START + Math.floor(k / w.N) * w.CELL);
      land.push(p);
      cx += p.x; cz += p.z;
    }
    cx /= land.length; cz /= land.length;
    const el = THREE.MathUtils.degToRad(38), target = new THREE.Vector3(cx, 0, cz);
    cam.fov = 32; cam.near = 200; cam.far = 80000; cam.updateProjectionMatrix();
    const place = (az, dist) => aim(cam, new THREE.Vector3(cx + Math.cos(az) * Math.cos(el) * dist, Math.sin(el) * dist, cz + Math.sin(az) * Math.cos(el) * dist), target, 0, -0.06);
    const fit = (az, pts, f) => {
      let dist = 40000;
      while (dist > 2000) {
        place(az, dist * f);
        if (pts.some((p) => { const v = p.clone().project(cam); return Math.abs(v.x) > 0.95 || Math.abs(v.y) > 0.88; })) break;
        dist *= f;
      }
      return dist;
    };
    // Look along the island's short side, so it fills the wide frame.
    const few = land.filter((_, i) => i % 6 === 0);
    let az = 0, best = Infinity;
    for (let a = 0; a < 16; a++) { const d = fit((a / 16) * Math.PI * 2, few, 0.96); if (d < best) { best = d; az = (a / 16) * Math.PI * 2; } }
    const yaw = place(az, fit(az, land, 0.985) * 1.04);
    return {
      cam, G: makeGround(w, null, 4), yaw, focus: target, sun: sunVector(yaw - 2.2, THREE.MathUtils.degToRad(17)), sunI: 1.5, ambI: 0.3,
      fogDist: 140000, fogGray: 0.9, fogLow: 0, cascades: [{ c: target, r: 5600 }, { c: target, r: 5600 }], treeScale: 2, tilt: { band: 0.3, max: 3 },
      sky: { top: 0.55, horizon: 0.92, cover: 0.62 }, exposure: 1.0, gamma: 0.95, contrast: 1.35, wideRivers: true, maxDist: 80000, remove: () => false, iso: true,
    };
  }
  if (VIEW === "valley") {
    // A raised vantage on the camp's open side, 180 to 250 m off and 40 m up, where the fewest crowns cross the view.
    const G = makeGround(w, { x: c.x, z: c.z, r: 450 }), idx = treeIndex(w, c.x, c.z, 400), f = w.camp.from;
    let spot = null;
    for (let a = -0.5; a <= 0.5; a += 0.05)
      for (let r = 180; r <= 250; r += 10) {
        const x = c.x + Math.cos(f + a) * r, z = c.z + Math.sin(f + a) * r, y = Math.max(G.groundY(x, z), 0) + 50;
        const hits = blockers(w, idx, x, z, y, c, c.y + 1.2).size, score = hits + Math.abs(a) * 2 + (r - 180) / 100;
        if (!spot || score < spot.score) spot = { x, y, z, r, score, hits };
      }
    const eye = new THREE.Vector3(spot.x, spot.y, spot.z), d = eye.distanceTo(camp);
    // Long enough a lens that a tent, about 4 m across, spans some 28 px of the 640 wide frame.
    cam.fov = 2 * Math.atan(180 / ((28 * d) / 4)) * 57.3; cam.near = 1; cam.far = 50000; cam.updateProjectionMatrix();
    const yaw = aim(cam, eye, new THREE.Vector3(c.x, c.y + 1, c.z), 0, -0.08);
    return {
      cam, G, yaw, focus: camp, sun: sunVector(yaw - 1.6, THREE.MathUtils.degToRad(48)), sunI: 1.5, ambI: 0.3,
      fogDist: 3000, fogGray: 0.88, fogLow: 0.6, cascades: [{ c: camp, r: 160 }, { c: camp, r: 2500 }],
      treeScale: 1, tilt: { band: 0.2, max: 3 }, sky: { top: 0.5, horizon: 0.9, cover: 0.6 }, exposure: 1.0, gamma: 0.95, contrast: 1.3, maxDist: 20000,
      remove: () => false, note: [`vantage r ${spot.r} up 50 crowns ${spot.hits} fov ${cam.fov.toFixed(1)}`],
    };
  }
  const G = makeGround(w, { x: c.x, z: c.z, r: 450 });
  const f = w.camp.from, side = f + Math.PI / 2;
  cam.fov = 50; cam.near = 0.15; cam.far = 40000; cam.updateProjectionMatrix();
  // On the open side, a little off the axis, so the white fire stands against the dark door of the tent behind it.
  const ex = c.x + Math.cos(f) * 12 + Math.cos(side) * 0.4, ez = c.z + Math.sin(f) * 12 + Math.sin(side) * 0.4;
  const eye = new THREE.Vector3(ex, G.groundY(ex, ez) + 1.7, ez);
  const yaw = aim(cam, eye, new THREE.Vector3(c.x, c.y + 0.6, c.z), 0, 0.02);
  return {
    cam, G, yaw, focus: new THREE.Vector3(c.x, c.y + 0.6, c.z), sun: sunVector(yaw + 2.4, THREE.MathUtils.degToRad(30)), sunI: 1.5, ambI: 0.3,
    fogDist: 140, fogGray: 0.88, fogLow: 0, cascades: [{ c: camp, r: 75 }, { c: camp, r: 1400 }],
    treeScale: 1, tilt: { band: 0.24, max: 2 }, sky: { top: 0.5, horizon: 0.9, cover: 0.6 }, exposure: 1.0, gamma: 0.95, contrast: 1.3, maxDist: 12000,
    grassAt: [{ at: eye, r: 12, density: 2.5 }, { at: c, r: 36, density: 1.2 }], remove: () => false,
  };
}

// ---------- the scene ----------

function build(w, shot, U) {
  const { cam, G } = shot, scene = new THREE.Scene();
  const vf = THREE.MathUtils.degToRad(cam.fov) / 2, pxScale = H / 2 / Math.tan(vf);
  U.pxScale.value = pxScale;
  const frustum = new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse));
  const padded = (pad) => { const f = frustum.clone(); for (const p of f.planes) p.constant += pad; return f; };
  const wide = padded(VIEW === "island" ? 200 : 400), tight = padded(VIEW === "island" ? 30 : 20), sphere = new THREE.Sphere();
  const seen = (x, y, z, r) => { sphere.center.set(x, y, z); sphere.radius = r; return tight.intersectsSphere(sphere); };
  const eye = cam.position;
  const distTo = (x, y, z) => Math.hypot(x - eye.x, y - eye.y, z - eye.z);

  const mat = (unit, opt = {}) => new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3, vertexShader: SH.solidVS, fragmentShader: SH.solidFS, side: THREE.DoubleSide, defines: opt.defines || {},
    uniforms: { ...U, uUnit: { value: unit }, uTintAmt: { value: opt.tint ?? 0.5 }, silPx: { value: opt.silPx ?? U.silPx.value }, crPx: { value: opt.crPx ?? U.crPx.value }, uFlat: { value: opt.flat ?? 0 }, uHard: { value: opt.hard ?? 0 } },
  });
  const shadowMat = new THREE.ShaderMaterial({ glslVersion: THREE.GLSL3, vertexShader: SH.shadowVS, fragmentShader: SH.shadowFS, side: THREE.DoubleSide });
  const add = (mesh, main, casts = true) => { mesh.material = main; mesh.userData.main = main; mesh.userData.shadow = casts ? shadowMat : null; mesh.frustumCulled = false; scene.add(mesh); return mesh; };
  let tris = 0;
  const instanced = (b, opt = {}) => {
    if (!b.count) return;
    const g = new THREE.BufferGeometry();
    for (const k of ["position", "aAlb", "aCls", "aMask", "aAO"]) g.setAttribute(k, b.geo.getAttribute(k));
    g.setAttribute("iTint", new THREE.InstancedBufferAttribute(b.t.view(), 1));
    g.setAttribute("iId", new THREE.InstancedBufferAttribute(b.id.view(), 1));
    const m = new THREE.InstancedMesh(g, null, b.count);
    m.instanceMatrix = new THREE.InstancedBufferAttribute(b.m.view(), 16);
    tris += (b.geo.getAttribute("position").count / 3) * b.count;
    add(m, mat(b.unit, opt), opt.casts ?? true);
  };

  // Sky dome.
  const sky = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 24), new THREE.ShaderMaterial({ glslVersion: THREE.GLSL3, vertexShader: SH.skyVS, fragmentShader: SH.skyFS, side: THREE.BackSide, depthTest: false, depthWrite: false, uniforms: U }));
  sky.renderOrder = -1;
  add(sky, sky.material, false);

  // Ground and water.
  const terrain = new THREE.Mesh(terrainGeometry(w, G, (box) => wide.intersectsBox(box)));
  tris += terrain.geometry.getAttribute("position").count / 3;
  add(terrain, mat(G.near ? G.near.s : w.STEP * G.stride, { defines: { TERRAIN: 1 }, crPx: U.crPx.value * 0.35 }));
  const water = new THREE.Mesh(waterGeometry(w, G, cam, pxScale, !!shot.wideRivers));
  add(water, new THREE.ShaderMaterial({ glslVersion: THREE.GLSL3, vertexShader: SH.plainVS, fragmentShader: SH.waterFS, side: THREE.DoubleSide, uniforms: U }), false);

  // Trees, three levels of detail, several variants each.
  const kinds = ["pine", "oak", "ash", "aspen"];
  const trees = Object.fromEntries(kinds.map((k) => [k, [0, 1, 2].map((lod) => [0, 1, 2].slice(0, 3 - lod).map((v) => new Bucket(k === "pine" ? MD.pine(lod, v) : MD.broad(k, lod, v), 1)))]));
  const widths = { pine: 0.9, oak: 1.1, ash: 0.95, aspen: 0.85 };
  const fogCut = shot.fogDist * 4.5;
  for (let i = 0; i < w.trees.length; i++) {
    const t = w.trees[i];
    const d = distTo(t.x, t.y, t.z);
    if (d > fogCut || d > shot.maxDist || shot.remove(t)) continue;
    const s = t.tall * shot.treeScale;
    if (!seen(t.x, t.y + s * 0.5, t.z, s * 0.6)) continue;
    const px = (s / d) * pxScale, lod = px > 70 ? 0 : px > 16 ? 1 : 2, set = trees[t.kind][lod];
    const wf = s * widths[t.kind] * (0.85 + 0.3 * hash(i, 1, 1));
    set[Math.floor(hash(i, 2, 2) * set.length)].add(t.x, G.groundY(t.x, t.z), t.z, t.yaw, wf, s, wf, t.tint, hash(i, 5, 5) * 0.999 + 0.001);
  }
  const isle = VIEW === "island";
  for (const k of kinds) trees[k].forEach((lod, l) => lod.forEach((b) => instanced(b, { tint: isle ? 0.1 : 0.55, flat: isle ? 1 : l === 2 ? 0.35 : 0, hard: isle ? 0 : 1, casts: !isle })));

  const shrubs = [0, 1].map((heath) => [0, 1].map((lod) => [0, 1].map((v) => new Bucket(MD.shrub(heath, lod, v), 1))));
  for (let i = 0; i < w.shrubs.length; i++) {
    const t = w.shrubs[i], d = distTo(t.x, t.y, t.z), px = (t.tall / d) * pxScale;
    if (px < 0.45 || d > fogCut || shot.remove(t) || !seen(t.x, t.y, t.z, t.tall)) continue;
    const s = t.tall * (VIEW === "island" ? 1.4 : 1);
    shrubs[t.heath > 0.5 ? 1 : 0][px > 14 ? 0 : 1][i & 1].add(t.x, G.groundY(t.x, t.z), t.z, t.yaw, s, s * (0.8 + 0.4 * t.tint), s, t.tint, hash(i, 6, 6) * 0.999 + 0.001);
  }
  for (const a of shrubs) for (const b of a) for (const c of b) instanced(c, { tint: 0.6, flat: isle ? 0.85 : 0, hard: isle ? 0 : 1, casts: !isle });

  const rocks = [0, 1, 2, 3].map((v) => new Bucket(MD.rock(v), 1.2));
  const addRock = (r, i, scale = 1) => {
    const d = distTo(r.x, r.y, r.z), s = r.size * scale, px = (s / d) * pxScale;
    if (px < 0.5 || d > fogCut || !seen(r.x, r.y, r.z, s)) return;
    rocks[i & 3].add(r.x, G.groundY(r.x, r.z) - s * 0.22, r.z, r.yaw, s, s * (0.8 + 0.5 * hash(i, 3, 3)), s, r.tint, hash(i, 7, 7) * 0.999 + 0.001);
  };
  w.rocks.forEach((r, i) => addRock(r, i));

  // Ground cover close to the eye: grass, flowers, pebbles, fallen wood, and reeds on wet edges.
  const inked = [0, 1, 2].map((v) => new Bucket(MD.grassTuft(v, MD.INK), 0.8));
  const flowers = [0, 1].map((v) => new Bucket(MD.flower(v), 0.4));
  const logs = new Bucket(MD.log(), 0.4), reeds = [0, 1].map((v) => new Bucket(MD.reeds(v), 1.6));
  let tuftId = 0;
  for (const spot of shot.grassAt || []) {
    const got = w.nearby(spot.at, spot.r, spot.density);
    for (const g of got.grass) {
      const d = distTo(g.x, g.y, g.z), s = g.tall * 0.55;
      // Only tufts big enough to draw as strokes; smaller ones would only add static to the ground's facets.
      if (!seen(g.x, g.y, g.z, 1) || d < 0.6 || (s / d) * pxScale < 8) continue;
      inked[tuftId++ % 3].add(g.x, G.groundY(g.x, g.z) - 0.02, g.z, g.yaw, s * 1.4, s, s * 1.4, g.tint, 0);
    }
    for (const f of got.flowers) if (seen(f.x, f.y, f.z, 1)) flowers[tuftId++ & 1].add(f.x, G.groundY(f.x, f.z), f.z, f.hue * 6.28, f.tall * 1.3, f.tall * 1.3, f.tall * 1.3, 0.5, 0);
    got.pebbles.forEach((p, i) => addRock(p, i + 17, 1));
    for (const l of got.logs) if (seen(l.x, l.y, l.z, l.length)) logs.add(l.x, G.groundY(l.x, l.z) + 0.14, l.z, l.yaw, l.length, 0.34, 0.34, 0.5, hash(l.x, l.z, 9));
  }
  if (VIEW !== "island") {
    const R = VIEW === "camp" ? 60 : 90, st = 1.4;
    for (let x = eye.x - R; x < eye.x + R; x += st)
      for (let z = eye.z - R; z < eye.z + R; z += st) {
        const jx = x + (hash(x * 7, z * 7, 31) - 0.5) * st, jz = z + (hash(x * 7, z * 7, 32) - 0.5) * st;
        const wet = w.fine(w.wet, jx, jz), rv = w.riverAt(jx, jz), gy = w.heightAt(jx, jz);
        const edge = Math.max(smooth(0.02, 0.2, wet) * smooth(0.55, 0.3, wet), smooth(0.05, 0.2, rv) * smooth(0.5, 0.3, rv), smooth(0.3, 0.6, w.fine(w.cover.marsh, jx, jz)) * 0.5);
        if (gy < 0.1 || edge * 0.8 < hash(x * 3, z * 3, 33) || !seen(jx, gy, jz, 2)) continue;
        const s = 1.2 + 0.8 * hash(x, z, 34);
        reeds[hash(x, z, 35) < 0.5 ? 0 : 1].add(jx, G.groundY(jx, jz) - 0.05, jz, hash(x, z, 36) * 6.28, s, s, s, hash(x, z, 37), 0);
      }
  }
  for (const b of [...inked, ...flowers, ...reeds]) instanced(b, { tint: 0.6, silPx: 1e9, crPx: 1e9, flat: 0.6 });
  instanced(logs);
  for (const b of rocks) instanced(b, { tint: 0.5 });

  // The camp.
  const camp = w.camp;
  const tentB = new Bucket(MD.tent(0), 1), ropes = new Buf();
  const ropeSeg = MD.tentRopes();
  camp.tents.forEach((t, k) => {
    const y = G.groundY(t.at.x, t.at.z) - 0.05;
    tentB.add(t.at.x, y, t.at.z, t.yaw, t.size, t.size, t.size, 0.5, 0.21 + k * 0.1);
    const c = Math.cos(t.yaw), s = Math.sin(t.yaw);
    for (const p of ropeSeg) {
      const lx = p[0] * t.size, lz = p[2] * t.size, x = t.at.x + c * lx + s * lz, z = t.at.z - s * lx + c * lz;
      ropes.push3(x, p[1] < 0.1 ? G.groundY(x, z) + 0.05 : y + p[1] * t.size, z);
    }
  });
  instanced(tentB, { tint: 0 });
  const ropeGeo = new THREE.BufferGeometry();
  ropeGeo.setAttribute("position", new THREE.BufferAttribute(ropes.view(), 3));
  add(new THREE.LineSegments(ropeGeo), new THREE.ShaderMaterial({ glslVersion: THREE.GLSL3, vertexShader: SH.plainVS, fragmentShader: SH.lineFS, uniforms: U }), false);
  camp.people.forEach((p, k) => {
    const b = new Bucket(MD.person(lum(COLORS[(k * 5 + 2) % COLORS.length]) * 0.6 + 0.12, k === 1 || k === 3 ? 1 : 0, k), 1.7);
    b.add(p.at.x, G.groundY(p.at.x, p.at.z), p.at.z, p.yaw, 1, 1, 1, 0.5, 0.61 + k * 0.05);
    instanced(b, { tint: 0 });
  });
  const f = camp.fire, fy = G.groundY(f.x, f.z);
  const one = (geo, x, y, z, yaw, s, id, opt) => { const b = new Bucket(geo, 1); b.add(x, y, z, yaw, s, s, s, 0.5, id); instanced(b, opt); };
  one(MD.fire(), f.x, fy, f.z, 0, 1, 0.91, { tint: 0 });
  one(MD.woodpile(), camp.woodpile.x, G.groundY(camp.woodpile.x, camp.woodpile.z), camp.woodpile.z, Math.atan2(f.x - camp.woodpile.x, f.z - camp.woodpile.z) + Math.PI / 2, 1, 0.93, { tint: 0 });
  one(MD.smoke(w.isle.wind), f.x, fy, f.z, 0, 1, 0.95, { tint: 0, silPx: 1e9, crPx: 1e9, casts: false, flat: 0.85 });

  U.firePos.value.set(f.x, fy + 0.7, f.z);
  return { scene, tris, pxScale };
}

// ---------- render: shadow atlas, then the g-buffer ----------

function render(renderer, w, shot, scene, U) {
  const SM = 2048, shadowRT = new THREE.WebGLRenderTarget(SM * 2, SM, { type: THREE.FloatType, format: THREE.RedFormat, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: true });
  const gRT = new THREE.WebGLRenderTarget(W * SS, H * SS, { count: 2, type: THREE.FloatType, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: true });
  const bias = new THREE.Matrix4().set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1);
  U.shadowMap.value = shadowRT.texture;
  U.shTexel.value.set(1 / (SM * 2), 1 / SM);
  const L = shot.sun.clone().normalize();

  scene.traverse((m) => { if (m.userData.main) { m.visible = !!m.userData.shadow; if (m.userData.shadow) m.material = m.userData.shadow; } });
  renderer.setRenderTarget(shadowRT);
  renderer.setClearColor(0xffffff, 1);
  renderer.clear();
  renderer.autoClear = false;
  shot.cascades.forEach(({ c, r }, k) => {
    const D = r + 4000, lc = new THREE.OrthographicCamera(-r, r, r, -r, 1, 2 * D);
    lc.position.copy(c).addScaledVector(L, D);
    lc.up.set(0, 1, 0);
    lc.lookAt(c);
    lc.updateMatrixWorld();
    lc.updateProjectionMatrix();
    shadowRT.viewport.set(k * SM, 0, SM, SM);
    renderer.setRenderTarget(shadowRT);
    renderer.render(scene, lc);
    const m = new THREE.Matrix4().multiplyMatrices(bias, lc.projectionMatrix).multiply(lc.matrixWorldInverse);
    (k === 0 ? U.shM0 : U.shM1).value.copy(m);
    const texel = (2 * r) / SM;
    U.shOff.value.setComponent(k, texel * 2.2);
    U.shBias.value.setComponent(k, (texel * 2.5) / (2 * D));
  });
  scene.traverse((m) => { if (m.userData.main) { m.visible = true; m.material = m.userData.main; } });

  renderer.setRenderTarget(gRT);
  renderer.setClearColor(0x000000, 0);
  renderer.clear();
  renderer.render(scene, shot.cam);
  const A = new Float32Array(W * H * SS * SS * 4), B = new Float32Array(W * H * SS * SS * 4);
  renderer.readRenderTargetPixels(gRT, 0, 0, W * SS, H * SS, A, undefined, 0);
  renderer.readRenderTargetPixels(gRT, 0, 0, W * SS, H * SS, B, undefined, 1);
  renderer.setRenderTarget(null);
  return { A, B };
}

// ---------- 1 bit ----------

function compose(A, B, shot, glow) {
  const N = W * H, tone = new Float32Array(N), cls = new Uint8Array(N), idv = new Float32Array(N), inv = new Float32Array(N), nrm = new Float32Array(N * 3), flg = new Uint8Array(N);
  // Down from the supersampled buffers: light is averaged, so detail finer than a pixel becomes a tone, not static;
  // everything else comes from the nearest sample, except that fire and ink in any sample win.
  const RW = W * SS, RH = H * SS;
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      let t = 0, best = -1, near = Infinity, ink = false, fire = false;
      for (let dy = 0; dy < SS; dy++)
        for (let dx = 0; dx < SS; dx++) {
          const s = ((RH - 1 - (y * SS + dy)) * RW + x * SS + dx) * 4, c = Math.round(A[s + 1]), d = c === SKY || !(A[s + 3] > 0) ? Infinity : A[s + 3];
          t += A[s];
          if (c === ROPE) ink = true;
          if (c === FIRE) fire = true;
          if (best < 0 || d < near) { near = d; best = s; }
        }
      tone[i] = t / (SS * SS);
      cls[i] = fire ? FIRE : ink ? ROPE : Math.round(A[best + 1]);
      idv[i] = A[best + 2];
      inv[i] = near === Infinity ? 0 : 1 / near;
      nrm[i * 3] = B[best]; nrm[i * 3 + 1] = B[best + 1]; nrm[i * 3 + 2] = B[best + 2]; flg[i] = Math.round(B[best + 3]);
    }
  // The fire's glow hangs in the air: full over what stands behind it, fainter over what stands in front.
  if (glow)
    for (let y = Math.max(0, Math.floor(glow.y - glow.r * 3)); y < Math.min(H, glow.y + glow.r * 3); y++)
      for (let x = Math.max(0, Math.floor(glow.x - glow.r * 3)); x < Math.min(W, glow.x + glow.r * 3); x++) {
        const i = y * W + x, rr = Math.hypot(x - glow.x, (y - glow.y) * 1.15) / glow.r;
        const g = glow.i * Math.exp(-rr * rr * 0.9);
        tone[i] += inv[i] > 0 && 1 / inv[i] < glow.d - 1.5 ? g * 0.3 : g;
      }
  // Posterized to five tones (lit, half, shade, deep shade, near black) so broad areas dither into flat patterns.
  const LV = [0.03, 0.22, 0.45, 0.7, 0.93];
  for (let i = 0; i < N; i++) {
    const t = clamp(0.5 + (Math.pow(Math.max(0, tone[i] * shot.exposure), shot.gamma) - 0.5) * (shot.contrast ?? 1.25), 0, 1);
    tone[i] = t > 0.97 ? 1 : LV[t < 0.12 ? 0 : t < 0.34 ? 1 : t < 0.57 ? 2 : t < 0.82 ? 3 : 4];
  }

  // Tilt-shift: a box blur that widens with distance from the band in focus, run twice so it rounds off.
  const rad = new Float32Array(H), band = shot.tilt.band * H;
  for (let y = 0; y < H; y++) rad[y] = shot.tilt.max * Math.pow(smooth(band, band + (H / 2 - band) * 1.1 + Math.abs(shot.tilt.fy - H / 2), Math.abs(y - shot.tilt.fy)), 1.4);
  const soft = boxBlur(boxBlur(tone, rad, 0.72), rad, 0.72);

  const blue = blueNoise(), bay = bayer();
  const bn = (x, y) => blue.t[(y & 63) * 64 + (x & 63)];

  // Ink: silhouettes where depth jumps off the plane of its neighbors, creases where facets fold, borders between
  // objects, and the shoreline wherever ground meets water.
  const edge = new Uint8Array(N), K = 0.14;
  for (let y = 1; y < H - 1; y++)
    for (let x = 1; x < W - 1; x++) {
      const i = y * W + x, c = cls[i];
      if (c === SKY || c === FIRE) continue;
      const wi = inv[i], f = flg[i];
      let e = c === ROPE ? 1 : 0;
      if (!e && f & 1)
        for (const [a, b] of [[i - 1, i + 1], [i - W, i + W]])
          for (const [q, o] of [[a, b], [b, a]]) if (inv[q] < wi * 0.97 && inv[q] < 2 * wi - inv[o] - K * wi) e = 1;
      if (!e && c !== WATER) for (const q of [i - 1, i + 1, i - W, i + W]) if (cls[q] === WATER && inv[q] <= wi * 1.02) e = 1;
      if (!e && c !== WATER)
        for (const q of [i + 1, i + W]) {
          const cq = cls[q];
          if (cq === SKY || cq === WATER || cq === ROPE || Math.abs(inv[q] - wi) > 0.06 * wi) continue;
          if ((f & 2) && (flg[q] & 2)) {
            const dot = nrm[i * 3] * nrm[q * 3] + nrm[i * 3 + 1] * nrm[q * 3 + 1] + nrm[i * 3 + 2] * nrm[q * 3 + 2];
            if (dot < (c === LAND && cq === LAND ? 0.9 : 0.8)) e = 1;
          }
          if (c >= VEG && cq >= VEG && (f & 1) && (flg[q] & 1) && Math.abs(idv[i] - idv[q]) > 1e-5) e = 1;
        }
      if (e && rad[y] > 0.8 && bn(x + 23, y + 41) < (rad[y] - 0.8) / 1.2) e = 0;
      edge[i] = e;
    }

  const bits = new Uint8Array(N);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = y * W + x, c = cls[i];
      const thr = c === SKY || c === WATER ? bay.t[(y & 7) * 8 + (x & 7)] : bn(x, y);
      let b = soft[i] > thr ? 1 : 0;
      if (c === FIRE && rad[y] < 1.5) b = 1;
      if (edge[i]) {
        let s = 0, n = 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const j = i + dy * W + dx; if (j >= 0 && j < N) { s += soft[j]; n++; } }
        b = s / n > 0.24 ? 0 : 1;
      }
      bits[i] = b;
    }
  return { bits, tone: soft, edge, cls };
}

function boxBlur(src, rad, k) {
  const S = new Float64Array((W + 1) * (H + 1));
  for (let y = 0; y < H; y++) {
    let row = 0;
    for (let x = 0; x < W; x++) { row += src[y * W + x]; S[(y + 1) * (W + 1) + x + 1] = S[y * (W + 1) + x + 1] + row; }
  }
  const box = (x, y, r) => {
    const x0 = Math.max(0, x - r), x1 = Math.min(W, x + r + 1), y0 = Math.max(0, y - r), y1 = Math.min(H, y + r + 1);
    return (S[y1 * (W + 1) + x1] - S[y0 * (W + 1) + x1] - S[y1 * (W + 1) + x0] + S[y0 * (W + 1) + x0]) / ((x1 - x0) * (y1 - y0));
  };
  const out = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    const r = rad[y] * k, r0 = Math.floor(r), t = r - r0;
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      out[i] = r < 0.25 ? src[i] : (1 - t) * box(x, y, r0) + t * box(x, y, r0 + 1);
    }
  }
  return out;
}

function paint(canvas, out) {
  const g = canvas.getContext("2d"), img = g.createImageData(W * SCALE, H * SCALE), d = img.data;
  const debug = DEBUG === "gray" ? (i) => { const v = Math.round(out.tone[i] * 255); return [v, v, v]; } : DEBUG === "edges" ? (i) => (out.edge[i] ? INK : PAPER) : null;
  for (let y = 0; y < H * SCALE; y++)
    for (let x = 0; x < W * SCALE; x++) {
      const i = ((y / SCALE) | 0) * W + ((x / SCALE) | 0), c = debug ? debug(i) : out.bits[i] ? PAPER : INK, o = (y * W * SCALE + x) * 4;
      d[o] = c[0]; d[o + 1] = c[1]; d[o + 2] = c[2]; d[o + 3] = 255;
    }
  g.putImageData(img, 0, 0);
  const back = g.getImageData(0, 0, W * SCALE, H * SCALE).data, seen = new Set();
  for (let o = 0; o < back.length; o += 4) seen.add((back[o] << 16) | (back[o + 1] << 8) | back[o + 2]);
  return seen.size;
}

// A top-down chart of the ground round the camp, with the eye and its view: for choosing cameras, not for the mock.
function debugMap(w, shot) {
  const g = document.getElementById("view").getContext("2d"), c = w.camp.at, R = Number(params.get("r") || 700), S = 720;
  const img = g.createImageData(S, S);
  for (let y = 0; y < S; y++)
    for (let x = 0; x < S; x++) {
      const wx = c.x - R + (x / S) * 2 * R, wz = c.z - R + (y / S) * 2 * R, hh = shot.G.groundY(wx, wz), o = (y * S + x) * 4;
      const band = Math.floor(hh / 10) % 2 ? 20 : 0, wet = w.fine(w.wet, wx, wz) > 0.5 || w.riverAt(wx, wz) > 0.5;
      const t = w.fine(w.cover.tree, wx, wz);
      img.data.set(wet ? [40, 70, 160, 255] : [120 + band + hh * 0.3, 150 + band - t * 70, 100 + band, 255], o);
    }
  g.putImageData(img, 0, 0);
  const px = (x) => ((x - c.x + R) / (2 * R)) * S, pz = (z) => ((z - c.z + R) / (2 * R)) * S;
  g.fillStyle = "#030";
  for (const t of w.trees) if (Math.abs(t.x - c.x) < R && Math.abs(t.z - c.z) < R) g.fillRect(px(t.x) - 1, pz(t.z) - 1, 2, 2);
  g.fillStyle = "red";
  g.fillRect(px(c.x) - 4, pz(c.z) - 4, 8, 8);
  const e = shot.cam.position, f = new THREE.Vector3();
  shot.cam.getWorldDirection(f);
  g.strokeStyle = "yellow"; g.lineWidth = 2;
  g.beginPath(); g.moveTo(px(e.x), pz(e.z)); g.lineTo(px(e.x + f.x * 300), pz(e.z + f.z * 300)); g.stroke();
  g.fillStyle = "yellow"; g.fillRect(px(e.x) - 4, pz(e.z) - 4, 8, 8);
  const hf = Math.atan(Math.tan(THREE.MathUtils.degToRad(shot.cam.fov) / 2) * shot.cam.aspect), fa = Math.atan2(f.z, f.x);
  for (const s of [-1, 1]) { g.beginPath(); g.moveTo(px(e.x), pz(e.z)); g.lineTo(px(e.x + Math.cos(fa + s * hf) * 200), pz(e.z + Math.sin(fa + s * hf) * 200)); g.stroke(); }
  const cp = w.camp;
  g.fillStyle = "#fff"; for (const t of cp.tents) { g.beginPath(); g.arc(px(t.at.x), pz(t.at.z), (t.size * 0.56 / (2 * R)) * S, 0, 7); g.fill(); }
  g.fillStyle = "#f0f"; for (const p of cp.people) g.fillRect(px(p.at.x) - 3, pz(p.at.z) - 3, 6, 6);
  g.fillStyle = "#840"; g.fillRect(px(cp.woodpile.x) - 4, pz(cp.woodpile.z) - 2, 8, 4);
  g.fillStyle = "#fff"; g.font = "14px monospace";
  const lines = [`camp ${c.x.toFixed(0)} ${c.y.toFixed(1)} ${c.z.toFixed(0)}`, `eye ${e.x.toFixed(0)} ${e.y.toFixed(1)} ${e.z.toFixed(0)}`, `uphill ${w.camp.uphill.toFixed(2)} from ${w.camp.from.toFixed(2)}`, `wind ${w.isle.wind.map((v) => v.toFixed(2))}`, `R ${R} m, bands 10 m`, ...(shot.note || [])];
  lines.forEach((s, k) => g.fillText(s, 740, 30 + k * 20));
  document.body.classList.add("ready");
}

async function main() {
  const t0 = performance.now();
  const w = grow(SEED);
  const t1 = performance.now();
  const shot = planShot(w);
  const { cam } = shot;
  if (DEBUG === "map") return debugMap(w, shot);
  const renderer = new THREE.WebGLRenderer({ canvas: document.createElement("canvas"), antialias: false, preserveDrawingBuffer: true });
  renderer.setPixelRatio(1);
  renderer.setSize(W, H, false);
  // Ground height and, out at sea, distance to the nearest shore (chamfer transform), for the water shader.
  const M = w.M, shore = new Float32Array(M * M).map((_, i) => (w.h[i] > 0 ? 0 : 1e9)), D = w.STEP, DD = w.STEP * Math.SQRT2;
  for (let pass = 0; pass < 2; pass++)
    for (let n = 0; n < M * M; n++) {
      const i = pass ? M * M - 1 - n : n, u = i % M, v = (i - u) / M, s = pass ? -1 : 1;
      let d = shore[i];
      if (u - s >= 0 && u - s < M) d = Math.min(d, shore[i - s] + D);
      if (v - s >= 0 && v - s < M) {
        const j = i - s * M;
        d = Math.min(d, shore[j] + D);
        if (u - 1 >= 0) d = Math.min(d, shore[j - 1] + DD);
        if (u + 1 < M) d = Math.min(d, shore[j + 1] + DD);
      }
      shore[i] = d;
    }
  const hs = new Float32Array(M * M * 2);
  for (let i = 0; i < M * M; i++) { hs[i * 2] = w.h[i]; hs[i * 2 + 1] = shore[i]; }
  const hTex = new THREE.DataTexture(hs, M, M, THREE.RGFormat, THREE.FloatType);
  hTex.needsUpdate = true;
  const U = {
    camPos: { value: cam.position.clone() }, sunDir: { value: shot.sun.clone().normalize() }, windDir: { value: new THREE.Vector2(...w.isle.wind).normalize() },
    sunI: { value: shot.sunI }, ambI: { value: shot.ambI }, fogDist: { value: shot.fogDist }, fogGray: { value: shot.fogGray }, fogLow: { value: shot.fogLow },
    skyTop: { value: shot.sky.top }, skyHorizon: { value: shot.sky.horizon }, cloudCover: { value: shot.sky.cover },
    firePos: { value: new THREE.Vector3() }, fireI: { value: VIEW === "island" ? 0 : 0.75 }, fireR: { value: 2.2 }, logC: { value: 2 / Math.log2(cam.far + 1) },
    shadowMap: { value: null }, shM0: { value: new THREE.Matrix4() }, shM1: { value: new THREE.Matrix4() }, shTexel: { value: new THREE.Vector2() }, shOff: { value: new THREE.Vector2() }, shBias: { value: new THREE.Vector2() },
    pxScale: { value: 1 }, silPx: { value: 6 }, crPx: { value: 45 }, heightTex: { value: hTex }, hGrid: { value: new THREE.Vector3(w.START, w.STEP, w.M) }, isoLines: { value: shot.iso ? 1 : 0 },
  };
  const { scene, tris, pxScale } = build(w, shot, U);
  const t2 = performance.now();
  const { A, B } = render(renderer, w, shot, scene, U);
  const t3 = performance.now();
  const fp = U.firePos.value.clone(), fd = fp.distanceTo(cam.position), fs = fp.clone().project(cam);
  const glow = VIEW === "island" || fs.z > 1 ? null : { x: ((fs.x + 1) / 2) * W, y: ((1 - fs.y) / 2) * H, r: Math.max(4, (0.45 / fd) * pxScale), d: fd, i: 0.35 };
  const fy = shot.focus.clone().project(cam);
  shot.tilt.fy = clamp(((1 - fy.y) / 2) * H, H * 0.25, H * 0.75);
  const out = compose(A, B, shot, glow);
  const canvas = document.getElementById("view");
  const colors = paint(canvas, out);
  const t4 = performance.now();
  document.body.dataset.colors = String(colors);
  console.warn(`onebit ${VIEW}: grow ${Math.round(t1 - t0)} ms, build ${Math.round(t2 - t1)} ms, render ${Math.round(t3 - t2)} ms, post ${Math.round(t4 - t3)} ms; ${Math.round(tris / 1000)}k triangles; ${colors} colors`);
  renderer.dispose();
  document.body.classList.add("ready");
}

const fail = (e) => { document.body.dataset.error = String((e && e.stack) || e); document.body.classList.add("failed"); };
window.addEventListener("error", (e) => fail(e.error || e.message));
window.addEventListener("unhandledrejection", (e) => fail(e.reason));
main().catch(fail);
