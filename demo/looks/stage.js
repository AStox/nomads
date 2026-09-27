// The stage every look is dressed on: one generated island, with the same trees, rocks, grass and camp in the same
// places, under the same cameras and lens. A look only chooses materials, light and color, so looks compare fairly.
import * as THREE from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { ShaderPass } from "three/addons/postprocessing/ShaderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { CELL, N, generateIsland, rng } from "./island.js";

export const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
export const smooth = (a, b, v) => { const t = clamp((v - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
export function hash(x, y, s) {
  let h = (x * 374761393 + y * 668265263 + s * 982451653) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
// Gradient noise, roughly -1..1, and a few octaves of it.
export function noise(x, y, s) {
  const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
  const g = (i, j) => { const a = hash(i, j, s) * 6.2831853; return Math.cos(a) * (fx - (i - x0)) + Math.sin(a) * (fy - (j - y0)); };
  const u = fx * fx * fx * (fx * (fx * 6 - 15) + 10), v = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
  const a = g(x0, y0), b = g(x0 + 1, y0), c = g(x0, y0 + 1), d = g(x0 + 1, y0 + 1);
  return (a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v) * 1.4;
}
export function fbm(x, y, s, octaves = 3) {
  let total = 0, amp = 0.5, f = 1;
  for (let o = 0; o < octaves; o++) { total += noise(x * f, y * f, s + o * 31) * amp; f *= 2.03; amp *= 0.5; }
  return total;
}

export const COVERS = ["tree", "shrub", "grass", "marsh", "bare", "sand"];

// `shadow` is the sun's shadow map size and `samples` the multisampling; software renderers need both lower.
export function makeStage(seed, { shadow = 4096, samples = 4 } = {}) {
  const isle = generateIsland(rng(seed)), rand = rng(seed ^ 0x51f15e);
  // The fine grid puts four quads across every 75 m cell, with a vertex on every cell center.
  const K = 4, M = (N - 1) * K + 1, STEP = CELL / K, SIZE = N * CELL, START = CELL / 2 - SIZE / 2, LEN = M * M;
  const Hc = isle.height, wetC = Float32Array.from(isle.water, (w) => (w > 0 ? 1 : 0));
  const at = (f, i, j) => f[clamp(j, 0, N - 1) * N + clamp(i, 0, N - 1)];
  const bilinear = (f, cx, cy) => {
    const x = Math.floor(cx), y = Math.floor(cy), tx = cx - x, ty = cy - y;
    return (at(f, x, y) * (1 - tx) + at(f, x + 1, y) * tx) * (1 - ty) + (at(f, x, y + 1) * (1 - tx) + at(f, x + 1, y + 1) * tx) * ty;
  };
  const cr = (p0, p1, p2, p3, t) => p1 + 0.5 * t * (p2 - p0 + t * (2 * p0 - 5 * p1 + 4 * p2 - p3 + t * (3 * (p1 - p2) + p3 - p0)));
  const bicubic = (f, cx, cy) => {
    const x = Math.floor(cx), y = Math.floor(cy), tx = cx - x, ty = cy - y;
    const row = (j) => cr(at(f, x - 1, j), at(f, x, j), at(f, x + 1, j), at(f, x + 2, j), tx);
    return cr(row(y - 1), row(y), row(y + 1), row(y + 2), ty);
  };
  const cellOf = (x) => (x - START) / CELL; // world to coarse coordinate

  // Streams, smoothed, in world meters, each point carrying its discharge; drawn into a mask for carving and shading.
  const chaikin = (p) => [p[0], ...p.slice(0, -1).flatMap((a, i) => [a.map((v, k) => v * 0.75 + p[i + 1][k] * 0.25), a.map((v, k) => v * 0.25 + p[i + 1][k] * 0.75)]), p.at(-1)];
  const rivers = isle.rivers.map((line) => chaikin(chaikin(chaikin(line.map(([x, y, q]) => [START + x * CELL, START + y * CELL, q])))));
  const RM = 2048, canvas = Object.assign(document.createElement("canvas"), { width: RM, height: RM }), g = canvas.getContext("2d");
  g.fillStyle = "#000";
  g.fillRect(0, 0, RM, RM);
  g.strokeStyle = "#fff";
  g.lineCap = g.lineJoin = "round";
  const px = (x) => ((x + SIZE / 2) / SIZE) * RM;
  const riverWidth = (q) => clamp(2.5 + 2.8 * Math.sqrt(q), 2.5, 16);
  for (const line of rivers)
    for (let k = 1; k < line.length; k++) {
      g.lineWidth = (riverWidth((line[k - 1][2] + line[k][2]) / 2) * RM) / SIZE + 1;
      g.beginPath();
      g.moveTo(px(line[k - 1][0]), px(line[k - 1][1]));
      g.lineTo(px(line[k][0]), px(line[k][1]));
      g.stroke();
    }
  const mask = g.getImageData(0, 0, RM, RM).data;
  const riverAt = (x, z) => mask[(clamp(Math.floor(px(z)), 0, RM - 1) * RM + clamp(Math.floor(px(x)), 0, RM - 1)) * 4] / 255;

  // ---------- the fine ground ----------
  // Heights come from a smooth cubic through the generator's cells, plus a little ground swell the cells are too
  // coarse to hold. Streams cut their beds. Covers wander at their edges instead of following the cell grid.
  const h = new Float32Array(LEN), wet = new Float32Array(LEN), river = new Float32Array(LEN), moist = new Float32Array(LEN);
  const cover = Object.fromEntries(COVERS.map((k) => [k, new Float32Array(LEN)]));
  for (let v = 0; v < M; v++)
    for (let u = 0; u < M; u++) {
      const i = v * M + u, cx = u / K, cy = v / K, x = START + u * STEP, z = START + v * STEP;
      const base = bicubic(Hc, cx, cy), wf = bilinear(wetC, cx, cy), rv = riverAt(x, z);
      const swell = 2.6 * fbm(x / 240, z / 240, 7, 3) + 0.8 * fbm(x / 60, z / 60, 8, 2);
      h[i] = base + smooth(-2, 6, base) * (1 - wf) * swell - rv * 1.8;
      wet[i] = wf;
      river[i] = rv;
      moist[i] = bilinear(isle.moist, cx, cy);
      let sum = 0;
      COVERS.forEach((k, n) => {
        const w = Math.max(0, bilinear(isle[k], cx, cy) * (1 + 0.85 * fbm(x / 150, z / 150, 40 + n, 2)));
        cover[k][i] = w;
        sum += w;
      });
      if (sum > 0) for (const k of COVERS) cover[k][i] /= sum;
    }
  const fine = (f, x, z) => {
    const fu = clamp((x - START) / STEP, 0, M - 1.001), fv = clamp((z - START) / STEP, 0, M - 1.001);
    const u = Math.floor(fu), v = Math.floor(fv), tu = fu - u, tv = fv - v, i = v * M + u;
    return (f[i] * (1 - tu) + f[i + 1] * tu) * (1 - tv) + (f[i + M] * (1 - tu) + f[i + M + 1] * tu) * tv;
  };
  const heightAt = (x, z) => fine(h, x, z);
  const slopeAt = (x, z) => Math.hypot(heightAt(x + 4, z) - heightAt(x - 4, z), heightAt(x, z + 4) - heightAt(x, z - 4)) / 8;
  const dry = (x, z) => fine(wet, x, z) < 0.15 && riverAt(x, z) < 0.25 && heightAt(x, z) > 0.8;

  // How much sky each vertex sees: the highest horizon along eight bearings, out to 450 m.
  const sky = new Float32Array(LEN);
  const reach = [20, 40, 70, 110, 160, 230, 320, 450];
  for (let v = 0; v < M; v++)
    for (let u = 0; u < M; u++) {
      const i = v * M + u, x = START + u * STEP, z = START + v * STEP, h0 = h[i];
      let open = 0;
      for (let d = 0; d < 8; d++) {
        const dx = Math.cos((d * Math.PI) / 4), dz = Math.sin((d * Math.PI) / 4);
        let rise = 0;
        for (const r of reach) rise = Math.max(rise, (heightAt(x + dx * r, z + dz * r) - h0) / r);
        open += 1 - Math.sin(Math.atan(rise));
      }
      sky[i] = open / 8;
    }

  function terrainGeometry() {
    const pos = new Float32Array(LEN * 3), uv = new Float32Array(LEN * 2), index = new Uint32Array((M - 1) * (M - 1) * 6);
    for (let v = 0; v < M; v++)
      for (let u = 0; u < M; u++) {
        const i = v * M + u;
        pos.set([START + u * STEP, h[i], START + v * STEP], i * 3);
        uv.set([u / (M - 1), v / (M - 1)], i * 2);
      }
    let n = 0;
    for (let v = 0; v < M - 1; v++)
      for (let u = 0; u < M - 1; u++) {
        const a = v * M + u, b = a + M;
        index.set([a, b, a + 1, b, b + 1, a + 1], n);
        n += 6;
      }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geo.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
    geo.setAttribute("sky", new THREE.BufferAttribute(sky, 1));
    geo.setIndex(new THREE.BufferAttribute(index, 1));
    geo.computeVertexNormals();
    return geo;
  }
  // Covers as two textures over the fine grid: tree, shrub, grass, marsh; then bare, sand, moisture, standing water.
  function coverTextures() {
    const a = new Uint8Array(LEN * 4), b = new Uint8Array(LEN * 4), byte = (f) => Math.round(clamp(f, 0, 1) * 255);
    for (let i = 0; i < LEN; i++) {
      a.set([cover.tree[i], cover.shrub[i], cover.grass[i], cover.marsh[i]].map(byte), i * 4);
      b.set([cover.bare[i], cover.sand[i], moist[i], wet[i]].map(byte), i * 4);
    }
    return [a, b].map((data) => {
      const t = new THREE.DataTexture(data, M, M);
      t.magFilter = t.minFilter = THREE.LinearFilter;
      t.needsUpdate = true;
      return t;
    });
  }
  function heightTexture() {
    const t = new THREE.DataTexture(Uint16Array.from(h, (v) => THREE.DataUtils.toHalfFloat(v)), M, M, THREE.RedFormat, THREE.HalfFloatType);
    t.magFilter = t.minFilter = THREE.LinearFilter;
    t.needsUpdate = true;
    return t;
  }
  function riverTexture() {
    const t = new THREE.CanvasTexture(canvas);
    t.flipY = false;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    return t;
  }
  // Each lake is a sheet at its own level over its cells and their rim; the ground rising through it draws the shore.
  function lakeGeometry() {
    const Wc = isle.water, lake = (k) => Wc[k] > 0 && Hc[k] + Wc[k] > 0.3, sheet = [];
    for (let y = 0; y < N - 1; y++)
      for (let x = 0; x < N - 1; x++) {
        const corners = [y * N + x, (y + 1) * N + x, y * N + x + 1, (y + 1) * N + x + 1], wetCorners = corners.filter(lake);
        if (!wetCorners.length) continue;
        const level = Math.max(...wetCorners.map((k) => Hc[k] + Wc[k]));
        if (corners.some((k) => !lake(k) && Hc[k] < level - 0.5)) continue;
        const [p, q, r, s] = corners.map((k) => [START + (k % N) * CELL, level, START + Math.floor(k / N) * CELL]);
        sheet.push(...p, ...q, ...r, ...q, ...s, ...r);
      }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(sheet, 3));
    geo.computeVertexNormals();
    return geo;
  }
  // Streams as ribbons of water lying in their beds, widening downstream.
  function riverGeometry() {
    const pos = [], index = [];
    for (const line of rivers) {
      const base = pos.length / 3;
      line.forEach(([x, z, q], k) => {
        const [ax, az] = line[Math.max(0, k - 1)], [bx, bz] = line[Math.min(line.length - 1, k + 1)];
        const len = Math.hypot(bx - ax, bz - az) || 1, nx = -(bz - az) / len, nz = (bx - ax) / len, w = riverWidth(q) * 0.5;
        const y = heightAt(x, z) + 0.45;
        pos.push(x + nx * w, y, z + nz * w, x - nx * w, y, z - nz * w);
        if (k) index.push(base + 2 * k - 2, base + 2 * k - 1, base + 2 * k, base + 2 * k - 1, base + 2 * k + 1, base + 2 * k);
      });
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    geo.setIndex(index);
    geo.computeVertexNormals();
    return geo;
  }

  // ---------- the camp, and the views ----------
  // A camp on a meadow near water, with woods close by and hills behind: the kind of spot people would pick.
  let best = null;
  for (let cy = 12; cy < N - 12; cy++)
    for (let cx = 12; cx < N - 12; cx++) {
      const k = cy * N + cx;
      if (isle.grass[k] < 0.35 || isle.water[k] > 0 || Hc[k] < 3) continue;
      const x = START + cx * CELL, z = START + cy * CELL;
      if (slopeAt(x, z) > 0.12) continue;
      let woods = 0, water = 99, rise = 0;
      for (let dy = -5; dy <= 5; dy++)
        for (let dx = -5; dx <= 5; dx++) {
          const j = at(isle.tree, cx + dx, cy + dy), d = Math.hypot(dx, dy);
          if (j > 0.5 && d <= 4) woods++;
          if ((at(wetC, cx + dx, cy + dy) > 0 || riverAt(x + dx * CELL, z + dy * CELL) > 0.3) && d < water) water = d;
          rise = Math.max(rise, at(Hc, cx + dx * 2, cy + dy * 2) - Hc[k]);
        }
      const score = Math.min(woods, 20) + Math.min(rise, 120) / 8 + (water <= 2 ? 10 : water <= 4 ? 5 : 0) + rand();
      if (!best || score > best.score) best = { score, x, z };
    }
  const camp = new THREE.Vector3(best.x, heightAt(best.x, best.z), best.z);
  // Look toward the rising ground, so the hills stand behind the camp, from whichever side the woods leave open.
  let uphill = 0, most = -Infinity;
  for (let d = 0; d < 16; d++) {
    const a = (d / 16) * Math.PI * 2, gain = heightAt(camp.x + Math.cos(a) * 900, camp.z + Math.sin(a) * 900);
    if (gain > most) { most = gain; uphill = a; }
  }
  const wooded = (a, dist) => { let s = 0; for (let k = 1; k <= 10; k++) s += fine(cover.tree, camp.x + (Math.cos(a) * dist * k) / 10, camp.z + (Math.sin(a) * dist * k) / 10); return s / 10; };
  let from = uphill + Math.PI, shut = Infinity;
  for (let d = -5; d <= 5; d++) {
    const a = uphill + Math.PI + d * 0.25, cost = wooded(a, 70) + 0.4 * wooded(a, 400) + 0.03 * Math.abs(d);
    if (cost < shut) { shut = cost; from = a; }
  }
  const view = (target, dist, pitch, fov) => {
    const eye = new THREE.Vector3(target.x + Math.cos(from) * Math.cos(pitch) * dist, 0, target.z + Math.sin(from) * Math.cos(pitch) * dist);
    eye.y = Math.max(target.y + Math.sin(pitch) * dist, heightAt(eye.x, eye.z) + 25);
    return { eye, target, fov };
  };
  const views = {
    island: { eye: new THREE.Vector3(-6600, 5800, 7600), target: new THREE.Vector3(0, 0, 0), fov: 34, span: 6500, blur: 1 },
    valley: { ...view(camp.clone().add(new THREE.Vector3(0, 4, 0)), 380, 0.42, 36), span: 520, blur: 0.8 },
    camp: { ...view(camp.clone().add(new THREE.Vector3(0, 1.5, 0)), 58, 0.36, 38), span: 110, blur: 0.55 },
  };

  // ---------- what grows and lies about, everywhere ----------
  // Conifers take cold, thin, windswept ground; oak the deep soils; ash the moist ones; aspen the wet edges. People
  // have cleared the ground around the camp, thinning out toward its edge.
  const trees = [], shrubs = [], rocks = [];
  const cleared = (x, z, r0, r1) => { const d = Math.hypot(x - camp.x, z - camp.z); return d < r0 || (d < r1 && rand() < (r1 - d) / (r1 - r0)); };
  for (let v = 0; v < M - 1; v++)
    for (let u = 0; u < M - 1; u++) {
      const i = v * M + u, x0 = START + u * STEP, z0 = START + v * STEP;
      if (wet[i] > 0.3 || h[i] < 0.8) continue;
      const cx = cellOf(x0), cy = cellOf(z0), exposure = bilinear(isle.exposure, cx, cy), soil = Math.min(1.5, bilinear(isle.soil, cx, cy));
      const m = moist[i], vigor = clamp(0.6 + m * 0.35 + soil * 0.2 - exposure * 0.4, 0.4, 1.2);
      for (let n = Math.floor(cover.tree[i] * 3.6 + rand()); n > 0; n--) {
        const x = x0 + rand() * STEP, z = z0 + rand() * STEP;
        if (!dry(x, z) || slopeAt(x, z) > 0.7 || cleared(x, z, 22, 40)) continue;
        const pine = clamp(0.08 + (heightAt(x, z) - 80) / 320 + exposure * 0.8 - soil * 0.3 + (1 - m) * 0.3, 0.03, 0.97);
        const kind = rand() < pine ? "pine" : m > 0.9 && rand() < 0.45 ? "aspen" : soil > 0.9 && rand() < 0.6 ? "oak" : "ash";
        const tall = { pine: 17, oak: 15, ash: 16, aspen: 13 }[kind] * vigor * (0.7 + rand() * 0.55);
        trees.push({ x, y: heightAt(x, z), z, tall, kind, yaw: rand() * Math.PI * 2, tint: rand() });
      }
      const edge = cover.tree[i] * (1 - cover.tree[i]) * 4;
      for (let n = Math.floor((cover.shrub[i] * 5 + edge * 1.2) * 0.6 + rand()); n > 0; n--) {
        const x = x0 + rand() * STEP, z = z0 + rand() * STEP;
        if (dry(x, z) && !cleared(x, z, 14, 26)) shrubs.push({ x, y: heightAt(x, z), z, tall: 0.8 + rand() * 1.8, heath: clamp(exposure * 1.4 + cover.shrub[i] - m * 0.3, 0, 1), yaw: rand() * 6.283, tint: rand() });
      }
      for (let n = Math.floor(cover.bare[i] * 1.6 + slopeAt(x0, z0) * 1.5 + rand() * 0.8); n > 0; n--) {
        const x = x0 + rand() * STEP, z = z0 + rand() * STEP;
        if (fine(wet, x, z) < 0.3 && !cleared(x, z, 12, 20)) rocks.push({ x, y: heightAt(x, z), z, size: 0.5 + rand() ** 3 * 5, yaw: rand() * 6.283, tint: rand() });
      }
    }

  // Near the camp, the small stuff only a close look can see: grass tufts, flowers, pebbles, fallen wood. Nothing grows
  // where people have trodden: round the fire, under the tents, by the woodpile.
  const trodden = (x, z) => Math.hypot(x - camp.x, z - camp.z) < 3.4 || Math.hypot(x - camping.woodpile.x, z - camping.woodpile.z) < 1.4 || tents.some((t) => Math.hypot(x - t.at.x, z - t.at.z) < t.size * 0.62);
  function nearby(center, radius, density = 3) {
    const grass = [], flowers = [], pebbles = [], logs = [];
    const r2 = radius * radius;
    for (let n = 0; n < r2 * 4 * density; n++) {
      const x = center.x + (rand() * 2 - 1) * radius, z = center.z + (rand() * 2 - 1) * radius;
      const d2 = (x - center.x) ** 2 + (z - center.z) ** 2;
      if (d2 > r2 || !dry(x, z) || trodden(x, z)) continue;
      const meadow = fine(cover.grass, x, z) + fine(cover.shrub, x, z) * 0.5 + fine(cover.marsh, x, z) * 0.8;
      // Thinner over the outer half of the patch, so it fades into the ground rather than stopping.
      if (rand() > meadow * 1.2 * (1 - smooth(radius * 0.4, radius, Math.sqrt(d2)))) continue;
      grass.push({ x, y: heightAt(x, z), z, tall: 0.35 + rand() * 0.5, yaw: rand() * 6.283, tint: rand() });
      if (rand() < 0.035) flowers.push({ x: x + rand() - 0.5, y: heightAt(x, z), z: z + rand() - 0.5, hue: rand(), tall: 0.25 + rand() * 0.3 });
    }
    for (let n = 0; n < radius * 1.2; n++) {
      const x = center.x + (rand() * 2 - 1) * radius, z = center.z + (rand() * 2 - 1) * radius;
      if (!dry(x, z)) continue;
      if (rand() < 0.5 + fine(cover.bare, x, z)) pebbles.push({ x, y: heightAt(x, z), z, size: 0.15 + rand() * 0.5, yaw: rand() * 6.283, tint: rand() });
      if (fine(cover.tree, x, z) > 0.35 && rand() < 0.1 && Math.hypot(x - camp.x, z - camp.z) > 14) logs.push({ x, y: heightAt(x, z), z, length: 3 + rand() * 6, yaw: rand() * 6.283 });
    }
    return { grass, flowers, pebbles, logs };
  }
  const circle = (r, a) => new THREE.Vector3(camp.x + Math.cos(a) * r, 0, camp.z + Math.sin(a) * r);
  const set = (p) => { p.y = heightAt(p.x, p.z); return p; };
  const facing = (p) => Math.atan2(camp.x - p.x, camp.z - p.z);
  // Tents stand behind the fire and to its sides, as the camera sees it, so the fire and the people stay in view.
  const tents = [2.0, 3.1, 4.3].map((a, k) => { const p = set(circle(9 + k, from + a)); return { at: p, yaw: facing(p), size: 3.2 + k * 0.4 }; });
  const people = [0.8, 1.5, 2.6, 4.2, 5.3].map((a) => { const p = set(circle(2.6, from + a)); return { at: p, yaw: facing(p) }; });
  const camping = { at: camp, tents, people, woodpile: set(circle(5.5, from + 2.9)), fire: camp.clone() };

  // ---------- rendering ----------
  const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: "high-performance", preserveDrawingBuffer: true });
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(36, 16 / 9, 1, 60000);
  const sun = new THREE.DirectionalLight(0xffffff, 3);
  sun.castShadow = true;
  sun.shadow.mapSize.set(shadow, shadow);
  sun.shadow.bias = -0.0002;
  scene.add(sun, sun.target);
  const composer = new EffectComposer(renderer, new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples }));
  composer.addPass(new RenderPass(scene, camera));
  const tilt = new ShaderPass(TILT_SHIFT), bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.25, 0.6, 1.0), grade = new ShaderPass(GRADE);
  composer.addPass(tilt);
  composer.addPass(bloom);
  composer.addPass(new OutputPass());
  composer.addPass(grade);
  function resize(w, hgt) {
    renderer.setPixelRatio(1);
    renderer.setSize(w, hgt, false);
    composer.setSize(w, hgt);
    tilt.uniforms.uTexel.value.set(1 / w, 1 / hgt);
    camera.aspect = w / hgt;
    camera.updateProjectionMatrix();
  }
  // The camera on a view, and the frustum it sees, before anything is dressed, so looks can spend detail on what shows.
  const frustum = new THREE.Frustum(), sphere = new THREE.Sphere(), viewing = new THREE.Matrix4();
  function aim(v) {
    camera.fov = v.fov;
    camera.position.copy(v.eye);
    camera.lookAt(v.target);
    const dist = v.eye.distanceTo(v.target);
    camera.near = Math.max(0.3, dist * 0.004);
    camera.far = Math.max(8000, dist * 6);
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld();
    frustum.setFromProjectionMatrix(viewing.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
  }
  const sees = (o, r = o.tall ?? o.size ?? 2) => { sphere.center.set(o.x, o.y + r * 0.5, o.z); sphere.radius = r; return frustum.intersectsSphere(sphere); };
  // Levels of detail by distance from the camera. Level 0 takes the nearest `most` things in view within reach[0];
  // everything else goes to the first level whose reach holds it, or past the last reach to the last level.
  function levels(list, reach, most = Infinity) {
    const eye = camera.position, out = [...reach.map(() => []), []];
    const byDistance = list.map((o) => [Math.hypot(o.x - eye.x, o.y - eye.y, o.z - eye.z), o]).sort((a, b) => a[0] - b[0]);
    let taken = 0;
    for (const [d, o] of byDistance) {
      let k = reach.findIndex((r) => d < r);
      if (k < 0) k = reach.length;
      if (k === 0 && (taken >= most || !sees(o))) k = 1;
      else if (k === 0) taken++;
      out[k].push(o);
    }
    return out;
  }
  // Shadows cover what the view holds, snapped to whole texels so they hold still as the camera moves.
  function frame(v, sunDir) {
    aim(v);
    const texel = (2 * v.span) / sun.shadow.mapSize.x, c = sun.shadow.camera;
    sun.target.position.set(Math.round(v.target.x / texel) * texel, v.target.y, Math.round(v.target.z / texel) * texel);
    sun.position.copy(sun.target.position).addScaledVector(sunDir, v.span * 3 + 2000);
    c.left = c.bottom = -v.span;
    c.right = c.top = v.span;
    c.near = 10;
    c.far = v.span * 6 + 4000;
    c.updateProjectionMatrix();
    sun.shadow.normalBias = texel * 0.8;
    const focus = v.target.clone().project(camera);
    tilt.uniforms.uFocus.value = focus.y * 0.5 + 0.5;
    tilt.uniforms.uBlur.value = v.blur * renderer.domElement.height * 0.011;
  }
  const render = () => composer.render();

  return { isle, M, STEP, START, SIZE, h, cover, wet, river, moist, heightAt, slopeAt, fine, dry, riverAt, rivers, riverWidth, trees, shrubs, rocks, camp: camping, views, nearby, terrainGeometry, coverTextures, heightTexture, riverTexture, lakeGeometry, riverGeometry, renderer, scene, camera, sun, composer, tilt, bloom, grade, resize, aim, sees, levels, frame, render, rand };
}

// ---------- shapes every look can use ----------
export function merged(geos) {
  const parts = geos.map((g) => (g.index ? g.toNonIndexed() : g)), out = new THREE.BufferGeometry();
  for (const name of ["position", "normal", "uv"]) {
    const all = new Float32Array(parts.reduce((s, g) => s + g.attributes[name].array.length, 0));
    parts.reduce((o, g) => (all.set(g.attributes[name].array, o), o + g.attributes[name].array.length), 0);
    out.setAttribute(name, new THREE.BufferAttribute(all, parts[0].attributes[name].itemSize));
  }
  return out;
}
// A lumpy stone, a unit across, sunk a little into the ground it sits on.
export function rockGeometry(detail = 2) {
  const g = new THREE.IcosahedronGeometry(0.5, detail), p = g.attributes.position, v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    const k = 1 + 0.18 * Math.sin(v.x * 7.1 + v.y * 3.3) * Math.cos(v.z * 5.7 - v.y * 2.1) + 0.08 * Math.sin(v.x * 17 + v.z * 13);
    p.setXYZ(i, v.x * k, v.y * k - 0.14, v.z * k);
  }
  g.computeVertexNormals();
  return g;
}
// A tuft of grass: blades bowing outward, dark at the root and light at the tip.
export function tuft() {
  const pos = [], col = [];
  for (let b = 0; b < 9; b++) {
    const a = b * 2.4, lean = 0.15 + (b % 3) * 0.1, w = 0.03, h = 0.7 + ((b * 7) % 5) * 0.08, dx = Math.cos(a), dz = Math.sin(a);
    const base = [dx * 0.05, 0, dz * 0.05], mid = [dx * lean * 0.5, h * 0.55, dz * lean * 0.5], tip = [dx * lean, h, dz * lean];
    const side = [-dz * w, 0, dx * w];
    const quad = (p0, p1, k0, k1, w0, w1) => {
      const A = [p0[0] - side[0] * w0, p0[1], p0[2] - side[2] * w0], B = [p0[0] + side[0] * w0, p0[1], p0[2] + side[2] * w0];
      const C = [p1[0] - side[0] * w1, p1[1], p1[2] - side[2] * w1], D = [p1[0] + side[0] * w1, p1[1], p1[2] + side[2] * w1];
      pos.push(...A, ...B, ...C, ...B, ...D, ...C);
      col.push(k0, k0, k0, k0, k0, k0, k1, k1, k1, k0, k0, k0, k1, k1, k1, k1, k1, k1);
    };
    quad(base, mid, 0.35, 0.8, 1, 0.8);
    quad(mid, tip, 0.8, 1.15, 0.8, 0.05);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
  g.computeVertexNormals();
  return g;
}
// Copies of a shape at each thing, grouped in square tiles so the renderer skips the tiles a camera, or the sun's
// shadow camera, can't see.
export function scatter(geometry, material, list, size, tint, { cast = true, tile = 500 } = {}) {
  const group = new THREE.Group(), tiles = new Map();
  for (const o of list) {
    const key = Math.floor(o.x / tile) * 4096 + Math.floor(o.z / tile);
    if (!tiles.has(key)) tiles.set(key, []);
    tiles.get(key).push(o);
  }
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0), c = new THREE.Color(), p = new THREE.Vector3(), s = new THREE.Vector3();
  for (const part of tiles.values()) {
    const mesh = new THREE.InstancedMesh(geometry, material, part.length);
    part.forEach((o, i) => {
      mesh.setMatrixAt(i, m.compose(p.set(o.x, o.y, o.z), q.setFromAxisAngle(up, o.yaw ?? o.hue * 6.283), s.fromArray(size(o))));
      mesh.setColorAt(i, tint(o, c));
    });
    mesh.castShadow = cast;
    mesh.receiveShadow = true;
    mesh.computeBoundingSphere();
    group.add(mesh);
  }
  return group;
}

// A tilt-shift: a band held sharp across the focus, and a round bokeh blur growing toward the top and bottom of the
// frame, the way a macro lens renders a model. Bright taps count for more, so highlights bloom into discs.
const TILT_SHIFT = {
  uniforms: { tDiffuse: { value: null }, uTexel: { value: new THREE.Vector2() }, uFocus: { value: 0.5 }, uBand: { value: 0.1 }, uBlur: { value: 0 } },
  vertexShader: "varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }",
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform vec2 uTexel;
    uniform float uFocus, uBand, uBlur;
    varying vec2 vUv;
    void main() {
      float r = uBlur * smoothstep(0.0, 0.42, max(0.0, abs(vUv.y - uFocus) - uBand));
      if (r < 0.6) { gl_FragColor = texture2D(tDiffuse, vUv); return; }
      float turn = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715)))) * 6.2832;
      vec3 sum = vec3(0.0);
      float total = 0.0;
      for (int i = 0; i < 40; i++) {
        float f = float(i) + 0.5, a = f * 2.39996 + turn;
        vec3 s = texture2D(tDiffuse, vUv + vec2(cos(a), sin(a)) * sqrt(f / 40.0) * r * uTexel).rgb;
        float w = 1.0 + 4.0 * max(0.0, max(s.r, max(s.g, s.b)) - 1.0);
        sum += s * w;
        total += w;
      }
      gl_FragColor = vec4(sum / total, 1.0);
    }`,
};

// A last pass on the finished picture: color, contrast, a warm or cool cast to lights and darks, and a vignette.
const GRADE = {
  uniforms: { tDiffuse: { value: null }, uSaturation: { value: 1.1 }, uContrast: { value: 1.05 }, uShadows: { value: new THREE.Vector3() }, uHighlights: { value: new THREE.Vector3() }, uVignette: { value: 0.3 } },
  vertexShader: "varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }",
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uSaturation, uContrast, uVignette;
    uniform vec3 uShadows, uHighlights;
    varying vec2 vUv;
    void main() {
      vec3 c = texture2D(tDiffuse, vUv).rgb;
      float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
      c = mix(vec3(l), c, uSaturation);
      c = (c - 0.5) * uContrast + 0.5;
      c += uShadows * (1.0 - smoothstep(0.0, 0.55, l)) + uHighlights * smoothstep(0.45, 1.0, l);
      vec2 q = vUv - 0.5;
      gl_FragColor = vec4(clamp(c * (1.0 - uVignette * dot(q, q) * 1.8), 0.0, 1.0), 1.0);
    }`,
};
