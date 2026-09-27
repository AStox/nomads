// Nomads in HD-2D: a stepped, pixel-textured diorama of the island, peopled entirely by pixel-art cards, under soft
// modern light (low sun and shadow maps, fire light, bloom, light shafts, motes and a tilt-shift lens).
import * as THREE from "three";
import { grow, hash } from "../world.js";
import { COLORS } from "../island.js";
import * as PX from "./pixels.js";
import { tiers, paintGround, buildTerrain, pixelTex, ripple, PALETTE, landTop, SKY } from "./terrain.js";
import { Cards, mirror, spriteTex } from "./sprites.js";
import { makePost } from "./post.js";

const { clamp, mulberry } = PX;
const DEG = Math.PI / 180;

const VIEWS = {
  island: {
    fov: 32, pitch: 40, T: 60, ppt: 5, base: 8, step: 56, drop: 5, levels: [0, 4, 10, 20, 34, 52, 75, 105, 145, 195, 260, 340],
    rockLevel: 7, rivers: true, flowers: 0, sparkle: 2, waterTone: 0.6, trodden: false, mini: true, tree: 16, small: 13, treeScale: 1,
    sun: [0.8, 0.3, 0.5], lens: { k: 26, band: 1.0, max: 26, tilt: 14 }, fog: [0.9, 2.3], shadow: 4096,
  },
  valley: {
    fov: 32, pitch: 31, dist: 270, lift: 0, ahead: 0, vex: 3.6, T: 6, ppt: 16, base: 1, step: 4.5, drop: 0.6, rockLevel: 30, rivers: true, flowers: 0.012,
    sparkle: 2.2, waterTone: 0.5, trodden: true, tree: 0.45, small: 0.28, treeScale: 1.0, sun: [0.82, 0.3, 0.52],
    lens: { k: 32, band: 2.2, max: 28, tilt: 10 }, fog: [1.2, 4.5], shadow: 4096,
  },
  camp: {
    fov: 30, pitch: 28, dist: 22, lift: 0.8, frame: true, yaw: -0.4, vex: 3.6, T: 6, ppt: 60, base: 1, step: 2.4, drop: 0.6, rockLevel: 30, rivers: true, flowers: 0.003,
    sparkle: 2.2, waterTone: 0.5, trodden: true, tree: 0.17, small: 0.1, treeScale: 0.9, sun: [0.82, 0.34, 0.4], person: 1.6, tent: 1.1,
    lens: { k: 70, max: 30, tilt: 0 }, fog: [3, 12], shadow: 2048,
  },
};

function regionFor(camera, w, T, pad) {
  const ray = new THREE.Raycaster(), plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), hit = new THREE.Vector3();
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (let a = -1; a <= 1.001; a += 0.25)
    for (let b = -1; b <= 1.001; b += 0.25) {
      ray.setFromCamera(new THREE.Vector2(a, b), camera);
      let p = ray.ray.intersectPlane(plane, hit);
      if (!p || p.distanceTo(camera.position) > camera.far) p = ray.ray.at(camera.far * 0.6, hit);
      x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); z0 = Math.min(z0, p.z); z1 = Math.max(z1, p.z);
    }
  const lo = w.START, hi = w.START + w.SIZE;
  x0 = Math.max(lo, Math.floor((x0 - pad) / T) * T); z0 = Math.max(lo, Math.floor((z0 - pad) / T) * T);
  x1 = Math.min(hi, Math.ceil((x1 + pad) / T) * T); z1 = Math.min(hi, Math.ceil((z1 + pad) / T) * T);
  return { x0, z0, nx: Math.round((x1 - x0) / T), nz: Math.round((z1 - z0) / T) };
}

function softTex(W, H, paint) {
  const cv = Object.assign(document.createElement("canvas"), { width: W, height: H }), g = cv.getContext("2d"), img = g.createImageData(W, H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const v = paint(x / (W - 1), y / (H - 1)), o = (y * W + x) * 4; img.data[o] = img.data[o + 1] = img.data[o + 2] = 255; img.data[o + 3] = clamp(v, 0, 1) * 255; }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(cv);
  return t;
}

export async function run() {
  const q = new URLSearchParams(location.search), name = VIEWS[q.get("view")] ? q.get("view") : "valley", seed = Number(q.get("seed") || 1);
  const V = { ...VIEWS[name] };
  const t0 = performance.now(), w = grow(seed), log = (s) => console.log(`[hd2d] ${s} ${Math.round(performance.now() - t0)} ms`);
  log("grow");
  const camp = w.camp, fire = camp.fire, rnd = mulberry(seed * 7919 + name.length);
  fire.y = landTop(w, V, fire.x, fire.z);

  // ---------- camera ----------
  const up = new THREE.Vector3(0, 1, 0);
  const yaw = camp.from + (V.yaw || 0);
  const fwd = new THREE.Vector3(-Math.cos(yaw), 0, -Math.sin(yaw)), right = new THREE.Vector3(-fwd.z, 0, fwd.x), left = right.clone().negate();
  let target, dist;
  if (V.mini) {
    let sx = 0, sz = 0, sn = 0;
    for (let k = 0; k < w.N * w.N; k++) if (w.isle.height[k] > 0 && w.isle.water[k] <= 0) { sx += w.START + (k % w.N) * w.CELL; sz += w.START + Math.floor(k / w.N) * w.CELL; sn++; }
    target = new THREE.Vector3(sx / sn, 20, sz / sn);
    dist = 13800;
  } else if (V.frame) {
    // Frame the whole camp: centre on its footprint as the camera sees it and back off until it fits across.
    const pts = [fire, camp.woodpile, ...camp.tents.map((tn) => tn.at), ...camp.people.map((p) => p.at)];
    let s0 = Infinity, s1 = -Infinity, d0 = Infinity, d1 = -Infinity;
    for (const p of pts) { const s = (p.x - fire.x) * right.x + (p.z - fire.z) * right.z, d = (p.x - fire.x) * fwd.x + (p.z - fire.z) * fwd.z; s0 = Math.min(s0, s); s1 = Math.max(s1, s); d0 = Math.min(d0, d); d1 = Math.max(d1, d); }
    target = new THREE.Vector3(fire.x, fire.y + V.lift, fire.z).addScaledVector(right, (s0 + s1) / 2).addScaledVector(fwd, (d0 + d1) / 2);
    V.campPts = pts;
    dist = V.dist;
  } else {
    target = new THREE.Vector3(fire.x, fire.y + V.lift, fire.z).addScaledVector(fwd, V.ahead ?? V.dist * 0.06);
    dist = V.dist;
  }
  const camera = new THREE.PerspectiveCamera(V.fov, innerWidth / innerHeight, dist * 0.15, dist * 12);
  camera.position.copy(target).addScaledVector(fwd, -dist * Math.cos(V.pitch * DEG)).addScaledVector(up, dist * Math.sin(V.pitch * DEG));
  camera.lookAt(target);
  camera.updateMatrixWorld();
  if (V.frame) {
    // Back off until every tent, person and the woodpile sits inside the frame with a margin.
    const v = new THREE.Vector3(), fits = () => V.campPts.every((p) => [-2.6, 2.6].every((o) => { v.set(p.x + right.x * o, fire.y + 1.2, p.z + right.z * o).project(camera); return Math.abs(v.x) < 0.9 && Math.abs(v.y) < 0.78; }));
    while (!fits() && dist < V.dist * 3) {
      dist *= 1.04;
      camera.position.copy(target).addScaledVector(fwd, -dist * Math.cos(V.pitch * DEG)).addScaledVector(up, dist * Math.sin(V.pitch * DEG));
      camera.near = dist * 0.15; camera.far = dist * 12; camera.updateProjectionMatrix(); camera.updateMatrixWorld();
    }
  }
  const camYaw = Math.atan2(-fwd.x, -fwd.z);
  const sunDir = new THREE.Vector3().addScaledVector(left, V.sun[0]).addScaledVector(fwd, V.sun[1]).addScaledVector(up, V.sun[2]).normalize();
  V.sunDir = sunDir;

  // ---------- ground ----------
  V.region = V.mini ? regionFor(camera, w, V.T, 600) : regionFor(camera, w, V.T, V.T * 4);
  const t = tiers(w, V);
  const paint = paintGround(w, V, t);
  log(`ground ${V.region.nx}x${V.region.nz} tiles`);
  const scene = new THREE.Scene();
  const terrain = buildTerrain(w, V, t, paint);
  scene.add(terrain.tops, ...terrain.walls);
  // Open sea past the diorama's edge, well under the water tiles so depth precision never lets it through.
  {
    const sp = new PX.Px(32, 32), deep = PALETTE.water[6];
    for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) sp.set(x, y, ripple(x, y) ? PX.mix(deep, [200, 240, 240], 0.3) : deep);
    const tx = pixelTex(sp.canvas(), true), size = 80000, rep = 32 * (V.T / V.ppt), X0 = V.region.x0, Z0 = V.region.z0;
    const gm = new THREE.PlaneGeometry(size, size).rotateX(-Math.PI / 2).translate(target.x, -1.5, target.z), uv = gm.attributes.uv, ps = gm.attributes.position;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, (ps.getX(i) - X0) / rep, (ps.getZ(i) - Z0) / rep);
    const sky = new THREE.Color().setRGB(...SKY.map((v) => v / 255), THREE.SRGBColorSpace).multiplyScalar(V.sparkle);
    const sea = new THREE.Mesh(gm, new THREE.MeshLambertMaterial({ map: tx, color: new THREE.Color(V.waterTone, V.waterTone, V.waterTone), emissive: sky }));
    scene.add(sea);
  }

  // ---------- cards ----------
  const SQ = 1.14;
  const cards = new Cards(camYaw, sunDir, SQ);
  const v3 = new THREE.Vector3();
  const inView = (x, y, z, h, m = 1.12) => { v3.set(x, y + h * 0.5, z).project(camera); return v3.z < 1 && Math.abs(v3.x) < m && v3.y > -m - 0.1 && v3.y < m + 0.15; };
  const R = V.region, rx1 = R.x0 + R.nx * V.T, rz1 = R.z0 + R.nz * V.T;
  const inRegion = (x, z) => x > R.x0 && x < rx1 && z > R.z0 && z < rz1;
  const variants = (make, n, texel, opts) => { const out = []; for (let k = 0; k < n; k++) { const px = make(k); out.push(cards.type(px, texel, opts), cards.type(mirror(px), texel, opts)); } return out; };
  const pick = (list, u) => list[Math.floor(u * list.length) % list.length];

  const TK = ["oak", "ash", "aspen", "pine"];
  const treeSets = {};
  const treeH = V.mini ? { oak: [9], ash: [10], aspen: [9], pine: [11] } : { oak: [9.5, 13], ash: [10, 14], aspen: [8.5, 12], pine: [11, 16] };
  for (const kind of TK)
    treeSets[kind] = treeH[kind].map((hm, b) => {
      const H = V.mini ? hm : Math.round((hm * 1.0) / V.tree);
      return { H, list: variants((k) => (kind === "pine" ? PX.pine(H, 100 + b * 10 + k, k / 3) : PX.deciduous(kind, H, 200 + b * 10 + k + kind.length * 31, k / 3)), V.mini ? 3 : 3, V.tree) };
    });
  let nTrees = 0;
  if (V.mini) {
    // One mini tree stands for a whole stand: cells of real forest get one or two, thin woods none.
    const cell = 130, stands = new Map();
    for (const tr of w.trees) {
      const key = Math.floor(tr.x / cell) * 100000 + Math.floor(tr.z / cell), st = stands.get(key);
      if (st) { st.n++; if (st.n === 40) st.second = tr; } else stands.set(key, { n: 1, first: tr, second: null });
    }
    for (const st of stands.values()) {
      if (st.n < 22) continue;
      for (const tr of st.n > 70 && st.second ? [st.first, st.second] : [st.first]) {
        const y = t.groundAt(tr.x, tr.z);
        if (y === null) continue;
        cards.add(pick(treeSets[tr.kind][0].list, tr.tint), tr.x, y, tr.z, 0.85 + (tr.tall / 17) * 0.3);
        nTrees++;
      }
    }
  } else {
    for (const tr of w.trees) {
      if (!inRegion(tr.x, tr.z)) continue;
      const hm = tr.tall * V.treeScale, y = t.groundAt(tr.x, tr.z);
      if (y === null || !inView(tr.x, y, tr.z, hm)) continue;
      const sets = treeSets[tr.kind], set = sets.length > 1 && hm * 1.0 > (sets[0].H + sets[1].H) * 0.5 * V.tree ? sets[1] : sets[0];
      const T = pick(set.list, tr.tint);
      cards.add(T, tr.x, y, tr.z, hm / (set.H * V.tree));
      nTrees++;
    }
  }
  log(`trees ${nTrees}`);

  if (V.mini) {
    const bushes = variants((k) => PX.bush(4, 300 + k, k === 2 ? 1 : 0, k / 3), 3, V.small);
    const seen = new Set();
    for (const s of w.shrubs) {
      const key = Math.floor(s.x / 160) * 100000 + Math.floor(s.z / 160);
      if (seen.has(key)) continue;
      seen.add(key);
      const y = t.groundAt(s.x, s.z);
      if (y !== null) cards.add(pick(bushes, s.tint), s.x, y, s.z, 1);
    }
  } else {
    const bushH = Math.max(4, Math.round(1.6 / V.small));
    const bushes = variants((k) => PX.bush(bushH, 300 + k, 0, k / 4), 4, V.small), heaths = variants((k) => PX.bush(bushH, 320 + k, 1), 2, V.small);
    for (const s of w.shrubs) {
      if (!inRegion(s.x, s.z)) continue;
      const y = t.groundAt(s.x, s.z), hm = s.tall * 0.9;
      if (y === null || !inView(s.x, y, s.z, hm)) continue;
      cards.add(pick(s.heath > 0.5 ? heaths : bushes, s.tint), s.x, y, s.z, hm / (bushH * V.small));
    }
    const rockH = Math.max(3, Math.round(1.4 / V.small));
    const rocks = variants((k) => PX.rock(rockH, 400 + k, k % 2 ? 0.55 : 0), 4, V.small);
    for (const r of w.rocks) {
      if (!inRegion(r.x, r.z)) continue;
      const y = t.groundAt(r.x, r.z), hm = r.size * 0.55;
      if (y === null || !inView(r.x, y, r.z, hm)) continue;
      cards.add(pick(rocks, r.tint), r.x, y, r.z, hm / (rockH * V.small));
    }
    // The small stuff: grass, flowers, pebbles and fallen wood from the world, plus ferns, reeds and stumps grown from
    // the cover fields.
    const radius = name === "camp" ? 75 : 340, near = w.nearby(fire, radius, name === "camp" ? 2.2 : 0.22);
    const gH = Math.max(3, Math.round((name === "camp" ? 0.6 : 1.1) / V.small));
    const grasses = variants((k) => PX.grass(gH, 500 + k, [0, 0.15, 0.45, 0.8][k]), 4, V.small, { cast: name === "camp" });
    const fH = name === "camp" ? 7 : Math.max(3, Math.round(0.45 / V.small)), flowers = PX.FLOWER.map((_, k) => cards.type(PX.flower(fH, 600 + k, k / PX.FLOWER.length + 0.01), V.small, { cast: false }));
    const gscale = name === "camp" ? 1.1 : 1.6;
    for (const g of near.grass) {
      if (name === "camp" && g.tint > 0.55) continue;
      const y = t.groundAt(g.x, g.z);
      if (y === null || !inView(g.x, y, g.z, 1)) continue;
      cards.add(pick(grasses, g.tint), g.x, y, g.z, (g.tall * gscale) / (gH * V.small));
    }
    for (const f of near.flowers) {
      const y = t.groundAt(f.x, f.z);
      if (y === null || !inView(f.x, y, f.z, 1)) continue;
      cards.add(flowers[Math.floor(f.hue * flowers.length) % flowers.length], f.x, y, f.z, name === "camp" ? (f.tall + 0.15) / (fH * V.small) : 2.2);
    }
    const pH = Math.max(2, Math.round(0.35 / V.small)), pebbles = variants((k) => PX.rock(pH, 450 + k), 3, V.small, { cast: name === "camp" });
    for (const p of near.pebbles) { const y = t.groundAt(p.x, p.z); if (y !== null && inView(p.x, y, p.z, 1)) cards.add(pick(pebbles, p.tint), p.x, y, p.z, (p.size * 0.6) / (pH * V.small)); }
    const lL = Math.round(5 / V.small), logs = variants((k) => PX.log(lL, 700 + k), 2, V.small);
    for (const l of near.logs) { const y = t.groundAt(l.x, l.z); if (y !== null && inView(l.x, y, l.z, 1)) cards.add(pick(logs, hash(l.x | 0, l.z | 0, 1)), l.x, y, l.z, l.length / (lL * V.small)); }
    const ferns = variants((k) => PX.fern(Math.max(3, Math.round((name === "camp" ? 0.8 : 1.3) / V.small)), 800 + k), 3, V.small), reeds = variants((k) => PX.reeds(Math.max(4, Math.round(1.4 / V.small)), 820 + k), 2, V.small);
    const stumps = variants((k) => PX.stump(Math.max(3, Math.round(0.6 / V.small)), 840 + k), 2, V.small);
    const step = name === "camp" ? 1.6 : 3.2, span = name === "camp" ? 80 : 360;
    for (let gz = fire.z - span; gz < fire.z + span; gz += step)
      for (let gx = fire.x - span; gx < fire.x + span; gx += step) {
        const x = gx + (hash(gx | 0, gz | 0, 91) - 0.5) * step, z = gz + (hash(gx | 0, gz | 0, 92) - 0.5) * step, u = hash(gx | 0, gz | 0, 93);
        const y = t.groundAt(x, z);
        if (y === null || !inView(x, y, z, 1)) continue;
        const tree = w.fine(w.cover.tree, x, z), marsh = w.fine(w.cover.marsh, x, z), wet = w.fine(w.wet, x, z), d = Math.hypot(x - fire.x, z - fire.z);
        if (u < tree * 0.55 && d > 14) cards.add(pick(ferns, hash(gx | 0, gz | 0, 94)), x, y, z, 0.8 + hash(gx | 0, gz | 0, 95) * 0.6);
        else if (u < marsh * 0.8 + wet * 0.5) cards.add(pick(reeds, hash(gx | 0, gz | 0, 96)), x, y, z, 0.8 + hash(gx | 0, gz | 0, 97) * 0.5);
        else if (d > 16 && d < 45 && u > 0.985 - tree * 0.06) cards.add(pick(stumps, u), x, y, z, 1);
      }
  }

  // ---------- the camp ----------
  if (!V.mini) {
    const s = V.small, toCam = fwd.clone().negate();
    const view = (yaw) => { const f = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw)), a = f.dot(toCam), b = f.dot(right); return a > 0.45 ? "front" : a < -0.45 ? "back" : b > 0 ? "right" : "left"; };
    camp.tents.forEach((tn, k) => {
      const W = Math.round((tn.size * (V.tent || 1.2)) / s), v = view(tn.yaw), doorSide = new THREE.Vector3(Math.sin(tn.yaw), 0, Math.cos(tn.yaw)).dot(right);
      const px = PX.tent(v === "front" || v === "back" ? "front" : doorSide < 0 ? "right" : "left", W, 11 + k, ["#d9c7a0", "#c7ae84", "#b89a74"][k]);
      const T = cards.type(px, s);
      const y = t.groundAt(tn.at.x, tn.at.z) ?? tn.at.y;
      cards.add(T, tn.at.x, y, tn.at.z, 1);
    });
    const seat = variants((k) => PX.log(Math.round(1.4 / s), 760 + k), 1, s);
    camp.people.forEach((p, k) => {
      const H = Math.max(6, Math.round((V.person || 2.1) / s)), sit = k === 0 || k === 3, y = t.groundAt(p.at.x, p.at.z) ?? p.at.y;
      const T = cards.type(PX.person(H, 20 + k * 3, COLORS[(k * 5 + 1) % COLORS.length], view(p.yaw), sit), s);
      cards.add(T, p.at.x, y, p.at.z, 1);
      if (sit) cards.add(seat[k % 2], p.at.x + fwd.x * 0.35, y, p.at.z + fwd.z * 0.35, 1);
    });
    // Each tent keeps a lantern by its door.
    const post = cards.type(PX.lantern(Math.round(1.5 / s)), s), pane = cards.type(PX.lantern(Math.round(1.5 / s), true), s, { lit: false, cast: false, color: new THREE.Color(4, 3.2, 2) });
    V.lanterns = camp.tents.map((tn) => {
      const door = new THREE.Vector3(Math.sin(tn.yaw), 0, Math.cos(tn.yaw)), side = new THREE.Vector3(door.z, 0, -door.x);
      const x = tn.at.x + door.x * tn.size * 0.55 + side.x * tn.size * 0.45, z = tn.at.z + door.z * tn.size * 0.55 + side.z * tn.size * 0.45, y = t.groundAt(x, z) ?? tn.at.y;
      cards.add(post, x, y, z, 1);
      cards.add(pane, x + fwd.x * -0.02, y, z + fwd.z * -0.02, 1);
      return new THREE.Vector3(x, y + 1.25 * SQ, z);
    });
    const wp = camp.woodpile, wy = t.groundAt(wp.x, wp.z) ?? wp.y;
    cards.add(cards.type(PX.woodpile(Math.round(2.2 / s), 5), s), wp.x, wy, wp.z, 1);
    const fy = t.groundAt(fire.x, fire.z) ?? fire.y;
    cards.add(cards.type(PX.hearth(Math.round(2 / s), 3), s, { cast: false }), fire.x - fwd.x * 0.05, fy, fire.z - fwd.z * 0.05, 1);
    cards.add(cards.type(PX.tripod(Math.round(1.8 / s), 2), s), fire.x + fwd.x * 0.25, fy, fire.z + fwd.z * 0.25, 1);
    const flame = cards.type(PX.flames(Math.round(1.3 / s), 4), s, { lit: false, cast: false, color: new THREE.Color(5, 3.6, 2.4), sink: 0.5 });
    cards.add(flame, fire.x + fwd.x * 0.1, fy + 0.05, fire.z + fwd.z * 0.1, 1);
    fire.y = fy;
  }
  cards.build(scene);
  log(`cards ${cards.count} in ${cards.types.length} kinds`);

  // ---------- light ----------
  const fogC = new THREE.Color(0xc8b8a0);
  scene.background = fogC;
  scene.fog = new THREE.Fog(fogC, dist * V.fog[0], dist * V.fog[1]);
  const sun = new THREE.DirectionalLight(0xffc88c, 2.8);
  const hemi = new THREE.HemisphereLight(0x94b4f4, 0x5e5040, 1.15);
  const fill = new THREE.DirectionalLight(0xbccaf4, 0.8);
  fill.position.copy(camera.position).sub(target).setY(0).normalize().add(new THREE.Vector3(0, 0.5, 0)).add(target);
  fill.target.position.copy(target);
  scene.add(hemi, sun, sun.target, fill, fill.target);
  sun.target.position.copy(target);
  const L = dist * 4;
  sun.position.copy(target).addScaledVector(sunDir, L);
  sun.castShadow = true;
  sun.shadow.mapSize.set(V.shadow, V.shadow);
  sun.shadow.radius = V.mini ? 1.5 : 2.2;
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = V.T / V.ppt * 0.6;
  {
    // Fit the shadow frustum to the diorama as the sun sees it.
    sun.updateMatrixWorld(); sun.target.updateMatrixWorld();
    const lc = sun.shadow.camera;
    lc.position.copy(sun.position); lc.lookAt(target); lc.updateMatrixWorld();
    const inv = lc.matrixWorldInverse, b = new THREE.Box3();
    let ymax = 0;
    for (let k = 0; k < t.top.length; k++) ymax = Math.max(ymax, t.top[k]);
    for (const x of [R.x0, rx1]) for (const z of [R.z0, rz1]) for (const y of [-2, ymax + 30]) b.expandByPoint(new THREE.Vector3(x, y, z).applyMatrix4(inv));
    lc.left = b.min.x; lc.right = b.max.x; lc.bottom = b.min.y; lc.top = b.max.y; lc.near = Math.max(1, -b.max.z - 10); lc.far = -b.min.z + 10;
    lc.updateProjectionMatrix();
  }
  if (!V.mini) {
    const fl = new THREE.PointLight(0xff8a3a, name === "camp" ? 11 : 120, name === "camp" ? 30 : 60, 2);
    fl.position.set(fire.x, fire.y + 1.3, fire.z);
    scene.add(fl);
    // A soft glow round the flames for the bloom to catch.
    const glow = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: softTex(64, 64, (u, v) => Math.exp(-(((u - 0.5) ** 2 + (v - 0.5) ** 2) * 18))), color: new THREE.Color(1.4, 0.62, 0.2), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }));
    const gs = name === "camp" ? 3 : 7;
    glow.scale.set(gs, gs * 0.8, 1);
    glow.position.set(fire.x, fire.y + gs * 0.18, fire.z);
    glow.quaternion.copy(camera.quaternion);
    scene.add(glow);
    for (const L of V.lanterns || []) {
      const g2 = glow.clone();
      g2.material = glow.material.clone();
      g2.material.color.setRGB(0.9, 0.6, 0.25);
      g2.scale.set(gs * 0.35, gs * 0.35, 1);
      g2.position.copy(L);
      scene.add(g2);
    }
  }

  // ---------- light shafts ----------
  {
    const shaftTex = softTex(64, 256, (u, v) => {
      let s = 0;
      for (let k = 0; k < 5; k++) { const c = 0.15 + hash(k, 1, 5) * 0.7, wdt = 0.03 + hash(k, 2, 5) * 0.09; s += Math.exp(-(((u - c) / wdt) ** 2)) * (0.5 + hash(k, 3, 5) * 0.5); }
      return Math.min(1, s) * PX.smooth(0, 0.35, v) * (1 - PX.smooth(0.7, 1, v)) * Math.sin(u * Math.PI);
    });
    const n = V.mini ? 5 : V.frame ? 4 : 9, len = dist * (V.mini ? 0.5 : V.frame ? 0.8 : 0.55), wid = dist * (V.mini ? 0.06 : V.frame ? 0.06 : 0.07);
    const spots = [];
    // Close on the camp, the beams fall across it rather than wherever the woods thin.
    if (V.frame) for (let k = 0; k < 4; k++) { const p = target.clone().addScaledVector(right, -3 + k * 3.4 + rnd() * 1.5).addScaledVector(fwd, -2 + rnd() * 7); spots.push({ x: p.x, z: p.z, y: t.groundAt(p.x, p.z) ?? fire.y }); }
    for (let tries = 0; tries < 400 && spots.length < n; tries++) {
      const a = (rnd() - 0.5) * 1.6, b = (rnd() - 0.35) * 1.3;
      const x = target.x + right.x * a * dist * 0.45 + fwd.x * b * dist * 0.5, z = target.z + right.z * a * dist * 0.45 + fwd.z * b * dist * 0.5;
      const edge = w.fine(w.cover.tree, x, z);
      if (!V.mini && (edge < 0.15 || edge > 0.85) && tries < 300) continue;
      if (spots.some((s) => Math.hypot(s.x - x, s.z - z) < wid * 2.2)) continue;
      spots.push({ x, z, y: t.groundAt(x, z) ?? 0 });
    }
    const toCam = new THREE.Vector3();
    for (const s of spots) {
      const L2 = len * (0.7 + rnd() * 0.6), W2 = wid * (0.6 + rnd() * 0.9), base = new THREE.Vector3(s.x, s.y, s.z), mid = base.clone().addScaledVector(sunDir, L2 * 0.5);
      toCam.copy(camera.position).sub(mid).normalize();
      const n2 = toCam.clone().addScaledVector(sunDir, -toCam.dot(sunDir)).normalize(), side = new THREE.Vector3().crossVectors(sunDir, n2).normalize();
      const gm = new THREE.BufferGeometry(), top = base.clone().addScaledVector(sunDir, L2);
      const P = [top.clone().addScaledVector(side, -W2), top.clone().addScaledVector(side, W2), base.clone().addScaledVector(side, W2 * 0.8), base.clone().addScaledVector(side, -W2 * 0.8)];
      gm.setAttribute("position", new THREE.Float32BufferAttribute(P.flatMap((p) => [p.x, p.y, p.z]), 3));
      gm.setAttribute("uv", new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
      gm.setIndex([0, 2, 1, 0, 3, 2]);
      const m = new THREE.Mesh(gm, new THREE.MeshBasicMaterial({ map: shaftTex, color: new THREE.Color(1.0, 0.78, 0.5).multiplyScalar((V.frame ? 0.16 : 0.1) + rnd() * 0.1), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false }));
      scene.add(m);
    }
    V.shafts = spots.map((s) => ({ ...s, len, wid }));
  }

  // ---------- smoke ----------
  {
    const puffs = [0, 1, 2].map((k) => spriteTex(PX.puff(16, 900 + k).canvas()));
    const n = V.mini ? 9 : 8, base = V.mini ? new THREE.Vector3(fire.x, t.groundAt(fire.x, fire.z) ?? 10, fire.z) : new THREE.Vector3(fire.x, fire.y + (name === "camp" ? 3.2 : 5), fire.z);
    const wind = w.isle.wind || [1, 0], S0 = V.mini ? 60 : name === "camp" ? 0.9 : 4, rise = V.mini ? 70 : name === "camp" ? 1.6 : 7;
    for (let k = 0; k < n; k++) {
      const f = k / n, sz = S0 * (1 + f * 2.2);
      const m = new THREE.Mesh(new THREE.PlaneGeometry(sz, sz), new THREE.MeshBasicMaterial({ map: puffs[k % 3], transparent: true, opacity: (V.frame ? 0.35 : 0.75) * (1 - f * 0.8), depthWrite: false, color: new THREE.Color(1.05, 1.0, 0.95) }));
      m.position.copy(base).add(new THREE.Vector3(wind[0] * f * f * rise * 3, k * rise, wind[1] * f * f * rise * 3));
      m.quaternion.copy(camera.quaternion);
      scene.add(m);
    }
  }

  // ---------- lens ----------
  const renderer = new THREE.WebGLRenderer({ canvas: document.getElementById("view"), preserveDrawingBuffer: true, antialias: false, powerPreference: "high-performance" });
  renderer.setPixelRatio(1);
  renderer.setSize(innerWidth, innerHeight, false);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.shadowMap.autoUpdate = false;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  const Wd = renderer.domElement.width, Hd = renderer.domElement.height;
  const sunScreen = camera.position.clone().addScaledVector(sunDir, dist * 40).project(camera);
  const lensCfg = { near: camera.near, far: camera.far, focus: camera.position.distanceTo(target), ...V.lens, focusY: 0.5, sunX: clamp(sunScreen.x * 0.5 + 0.5, -0.2, 0.15), sunY: clamp(sunScreen.y * 0.5 + 0.5, 0.9, 1.3), haze: [0.15, 0.1, 0.045], ca: 0.004, bloom: [0.55, 0.62, 0.92] };
  if (V.frame) {
    // The sharp band is exactly as deep as the camp, so everything in it is crisp and only what lies beyond blurs.
    const inv = camera.matrixWorldInverse, f = lensCfg.focus, v = new THREE.Vector3();
    let worst = 0;
    for (const p of V.campPts) for (const hy of [0, 2.4]) { const z = -v.set(p.x, (t.groundAt(p.x, p.z) ?? fire.y) + hy, p.z).applyMatrix4(inv).z; worst = Math.max(worst, lensCfg.k * Math.abs(1 - f / z)); }
    lensCfg.band = worst + 0.6;
  }
  const post = makePost(renderer, Wd, Hd, lensCfg);
  // Motes and embers are drawn after the lens blur, each as its own bokeh disc sized by its depth.
  const overlay = new THREE.Scene();
  {
    const pos = [], col = [], size = [];
    const add = (p, c, s) => { pos.push(p.x, p.y, p.z); col.push(...c); size.push(s); };
    const px = name === "camp" ? 3 : 2;
    for (const s of V.shafts || []) {
      const cnt = V.mini ? 6 : name === "camp" ? 4 : 10;
      for (let k = 0; k < cnt; k++) {
        const a = rnd(), p = new THREE.Vector3(s.x, s.y, s.z).addScaledVector(sunDir, a * s.len * 0.75).add(new THREE.Vector3((rnd() - 0.5) * s.wid * 2, (rnd() - 0.5) * s.wid, (rnd() - 0.5) * s.wid * 2));
        const b = 1.6 + rnd() * 2.4;
        add(p, [b, b * 0.86, b * 0.62], px);
      }
    }
    if (!V.mini) {
      const spread = name === "camp" ? 14 : 160;
      for (let k = 0; k < (name === "camp" ? 10 : 40); k++) {
        const x = target.x + (rnd() - 0.5) * spread * 2, z = target.z + (rnd() - 0.5) * spread * 2, gy = t.groundAt(x, z) ?? 0, b = 1.2 + rnd() * 2;
        add(new THREE.Vector3(x, gy + 0.5 + rnd() * spread * 0.16, z), [b, b * 0.9, b * 0.7], px);
      }
      const eh = name === "camp" ? 3.5 : 14;
      for (let k = 0; k < 10; k++) {
        const f = rnd(), r = f * (name === "camp" ? 1.4 : 4) * (0.3 + rnd()), a = rnd() * 6.283, b = 5 + rnd() * 6;
        add(new THREE.Vector3(fire.x + Math.cos(a) * r, fire.y + 0.6 + f * eh, fire.z + Math.sin(a) * r), [b, b * 0.42, b * 0.1], px);
      }
    }
    const gm = new THREE.BufferGeometry();
    gm.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    gm.setAttribute("tint", new THREE.Float32BufferAttribute(col, 3));
    gm.setAttribute("size", new THREE.Float32BufferAttribute(size, 1));
    const U = post.lensUniforms();
    const pm = new THREE.ShaderMaterial({
      uniforms: U,
      vertexShader: /* glsl */ `
        attribute vec3 tint; attribute float size; varying vec3 vT; varying float vBig;
        uniform sampler2D tDepth; uniform float uNear, uFar, uFocus, uK, uBand, uMax, uTilt, uFocusY;
        float linZ(float d) { return uNear * uFar / (uFar - d * (uFar - uNear)); }
        void main() {
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mv;
          vec2 suv = gl_Position.xy / gl_Position.w * 0.5 + 0.5;
          float z = -mv.z, scene = linZ(texture2D(tDepth, suv).x);
          float c = clamp(max(uK * abs(1.0 - uFocus / z), uTilt * smoothstep(0.18, 0.62, abs(suv.y - uFocusY))) - uBand, 0.0, uMax * 1.4);
          float s = max(size, c * 2.0);
          vBig = step(size + 1.5, s);
          vT = tint * max((size * size) / (s * s) * 1.6, 0.05);
          gl_PointSize = floor(s + 0.5);
          if (z > scene + 0.02 * z) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        varying vec3 vT; varying float vBig;
        void main() {
          if (vBig > 0.5) { float r = length(gl_PointCoord * 2.0 - 1.0); if (r > 1.0) discard; gl_FragColor = vec4(vT * (0.75 + 0.5 * smoothstep(0.72, 0.95, r)), 1.0); }
          else gl_FragColor = vec4(vT, 1.0);
        }`,
      transparent: true, blending: THREE.AdditiveBlending, depthTest: false, depthWrite: false,
    });
    overlay.add(new THREE.Points(gm, pm));
  }

  // ---------- render ----------
  const tiny = new THREE.WebGLRenderTarget(1, 1);
  cards.shadowPhase(true);
  renderer.shadowMap.needsUpdate = true;
  renderer.setRenderTarget(tiny);
  renderer.render(scene, camera);
  cards.shadowPhase(false);
  log("shadows");
  post.render(scene, camera, overlay);
  log("frame");
  document.body.classList.add("ready");
}
