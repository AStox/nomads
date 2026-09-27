// The ground as a diorama: height quantized into flat tiers on a square tile grid, vertical cliff walls between them,
// and every top face painted texel by texel into one pixel-art ground texture from the world's cover fields.
import * as THREE from "three";
import { hash, noise } from "../world.js";
import { ramp, rgb, mix, clamp, bayer } from "./pixels.js";

const LAND = 0, WATER = 1;
// Ground kinds painted on the tops.
const G = { grass: 0, forest: 1, heath: 2, marsh: 3, dirt: 4, rock: 5, sand: 6, trodden: 7 };

// A tile's height: a few samples averaged over the tile, stretched by the view's vertical exaggeration.
function tileHeight(w, V, x, z) {
  let h = 0;
  for (const [a, b] of [[0, 0], [-0.3, -0.3], [0.3, -0.3], [-0.3, 0.3], [0.3, 0.3]]) h += w.heightAt(x + a * V.T, z + b * V.T) / 5;
  return h * (V.vex || 1);
}
// The top of the land tile holding (x, z), before any region exists (the camera needs it to aim).
export function landTop(w, V, x, z) {
  const cx = (Math.floor(x / V.T) + 0.5) * V.T, cz = (Math.floor(z / V.T) + 0.5) * V.T, h = tileHeight(w, V, cx, cz);
  return V.base + (V.levels ? V.levels.filter((b, i) => i > 0 && h >= b).length : Math.max(0, Math.floor((h - V.base) / V.step))) * V.step;
}

export function tiers(w, V) {
  const { T, region } = V, { x0, z0, nx, nz } = region, n = nx * nz;
  const top = new Float32Array(n), kind = new Uint8Array(n), level = new Int16Array(n), cover = new Uint8Array(n), trueY = new Float32Array(n), slope = new Float32Array(n);
  const levelOf = V.levels
    ? (h) => { let L = 0; while (L + 1 < V.levels.length && h >= V.levels[L + 1]) L++; return L; }
    : (h) => Math.max(0, Math.floor((h - V.base) / V.step));
  const topOf = (L) => V.base + L * V.step;
  const surface = (x, z) => {
    // Standing water keeps the level of the nearest water cell.
    const cx = Math.round((x - w.START) / w.CELL), cy = Math.round((z - w.START) / w.CELL);
    let s = Infinity;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const i = clamp(cy + dy, 0, w.N - 1) * w.N + clamp(cx + dx, 0, w.N - 1); if (w.isle.water[i] > 0) s = Math.min(s, w.isle.height[i] + w.isle.water[i]); }
    return s === Infinity ? w.heightAt(x, z) : s;
  };
  for (let j = 0; j < nz; j++)
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i, x = x0 + (i + 0.5) * T, z = z0 + (j + 0.5) * T;
      const h = tileHeight(w, V, x, z);
      slope[k] = w.slopeAt(x, z);
      const wet = w.fine(w.wet, x, z), river = V.rivers ? w.riverAt(x, z) : 0;
      if (wet > 0.5 || h < 0 || river > 0.55) {
        kind[k] = WATER;
        const s = river > 0.55 && wet <= 0.5 ? h + 1.2 : surface(x, z) * (V.vex || 1);
        trueY[k] = s < 0.6 ? 0 : s;
        level[k] = s < 0.6 ? -1 : levelOf(s);
        top[k] = s < 0.6 ? 0 : topOf(level[k]) - V.drop;
      } else {
        level[k] = levelOf(h);
        top[k] = topOf(level[k]);
        trueY[k] = h;
      }
    }
  const at = (i, j) => (i < 0 || j < 0 || i >= nx || j >= nz ? -1 : j * nx + i);
  const tileOf = (x, z) => at(Math.floor((x - x0) / T), Math.floor((z - z0) / T));
  // Where a sprite stands: the top of its tile, or null in water or outside.
  const groundAt = (x, z) => { const k = tileOf(x, z); return k < 0 || kind[k] === WATER ? null : top[k]; };
  return { top, kind, level, cover, trueY, slope, at, tileOf, groundAt, topOf, levelOf };
}

// ---------- the painted ground ----------
const P = {
  grass: ramp("#5f9440", 6, 0.25),
  dry: ramp("#9a9c4a", 6, 0.24),
  forest: ramp("#4f6a2c", 5, 0.2),
  litter: [rgb("#7a5a2e"), rgb("#946c34"), rgb("#aa803c"), rgb("#5e4a2a")],
  heath: ramp("#66703a", 5, 0.2),
  heather: [rgb("#8e4c80"), rgb("#b068a2"), rgb("#6e3c66")],
  marsh: ramp("#5c6c3a", 5, 0.18),
  pool: [rgb("#46686c"), rgb("#6a9094"), rgb("#9cc0c0")],
  dirt: ramp("#8c6c48", 5, 0.2),
  rock: ramp("#8a867c", 5, 0.24),
  sand: ramp("#dac792", 5, 0.16),
  trodden: ramp("#7c6048", 5, 0.18),
  ash: ramp("#5a524c", 3, 0.12),
  water: ["#8fd2c8", "#5cb6bc", "#3c97b2", "#2f7aa4", "#2a6394", "#265084", "#224474"].map(rgb),
  flowers: ["#f5f1e4", "#f3d14a", "#ea88b8", "#f5f1e4", "#9d6ad2", "#f3d14a"].map(rgb),
};

function kindAt(w, V, x, z, gx, gy) {
  const f = (c) => w.fine(w.cover[c], x, z);
  const d = (s) => noise(gx / 11 + s, gy / 11 - s, 60 + s) * 0.16 + (hash(gx, gy, 70 + s) - 0.5) * 0.14;
  let best = G.grass, bs = -1;
  const cand = [[G.forest, f("tree") * 0.95 + d(1)], [G.heath, f("shrub") + d(2)], [G.grass, f("grass") + d(3)], [G.marsh, f("marsh") * 1.1 + d(4)], [G.dirt, f("bare") + d(5)], [G.sand, f("sand") * 1.15 + d(6)]];
  for (const [k, s] of cand) if (s > bs) { bs = s; best = k; }
  return best;
}

function paintLand(k, gx, gy, x, z, w, V, moist) {
  const n1 = noise(gx / 9, gy / 9, 5) * 0.55 + noise(gx / 3.3, gy / 3.3, 6) * 0.3;
  const h = hash(gx, gy, 7), hb = hash(gx, gy + 1, 7);
  switch (k) {
    case G.grass: {
      const pal = moist < 0.35 ? P.dry : P.grass, patch = noise(gx / 40, gy / 40, 18);
      let t = 2.4 + n1 * 2.2 + patch * 1.6;
      if (h < 0.1) t -= 2;
      else if (hb < 0.1) t += 1.6;
      if (hash(gx, gy, 8) < V.flowers * (0.3 + 3 * Math.max(0, noise(gx / 25, gy / 25, 19)))) return P.flowers[Math.floor(hash(gx, gy, 9) * 6)];
      return pal[clamp(Math.round(t + (bayer(gx, gy) - 0.5) * 0.6), 0, 5)];
    }
    case G.forest: {
      if (h < 0.07) return P.litter[Math.floor(hash(gx, gy, 10) * 4)];
      let t = 2 + n1 * 2.2;
      if (hb < 0.08) t += 1.2;
      if (hash(gx >> 1, gy >> 1, 11) < 0.08) return P.litter[3];
      return P.forest[clamp(Math.round(t + (bayer(gx, gy) - 0.5) * 0.6), 0, 4)];
    }
    case G.heath: {
      if (h < 0.09) return P.heather[Math.floor(hash(gx, gy, 12) * 3)];
      const t = 2 + n1 * 2.2 + (hb < 0.08 ? 1 : 0) - (h > 0.93 ? 1.5 : 0);
      return P.heath[clamp(Math.round(t), 0, 4)];
    }
    case G.marsh: {
      const pool = noise(gx / 6, gy / 6, 13) + noise(gx / 2.5, gy / 2.5, 14) * 0.3;
      if (pool > 0.42) return P.pool[pool > 0.7 ? 0 : hash(gx, gy, 15) < 0.12 ? 2 : 1];
      const t = 2 + n1 * 2 + (h < 0.1 ? -1.5 : hb < 0.1 ? 1 : 0);
      return P.marsh[clamp(Math.round(t), 0, 4)];
    }
    case G.dirt: {
      if (h < 0.04) return P.rock[4];
      if (hash(gx, gy - 1, 7) < 0.04) return P.dirt[0];
      return P.dirt[clamp(Math.round(2 + n1 * 2 + (bayer(gx, gy) - 0.5) * 0.8), 0, 4)];
    }
    case G.rock: {
      const crack = Math.abs(noise(gx / 5, gy / 5, 16)) < 0.05;
      return P.rock[clamp(Math.round(2.3 + n1 * 2 - (crack ? 2 : 0) + (h < 0.05 ? 1 : 0)), 0, 4)];
    }
    case G.sand: {
      const rip = Math.sin((gx * 0.35 + gy * 0.9 + noise(gx / 8, gy / 8, 17) * 4) * 1.1) > 0.82;
      return P.sand[clamp(Math.round(2.6 + n1 * 1.4 + (rip ? 1 : 0) - (h < 0.05 ? 1.5 : 0)), 0, 4)];
    }
    default: {
      const t = 2 + n1 * 1.6 + (h < 0.06 ? -1 : 0);
      return P.trodden[clamp(Math.round(t + (bayer(gx, gy) - 0.5) * 0.7), 0, 4)];
    }
  }
}

// The water's ripple marks repeat every 32 texels so the open sea past the diorama can carry the same pattern.
export const SKY = [34, 50, 66];
export const ripple = (x, y) => (y + Math.floor(x / 9)) % 6 === 0 && hash(x >> 2, y, 31) < 0.4;

// Returns the ground canvas, an emissive canvas (water sparkles), and records the lip kind of every tile.
export function paintGround(w, V, t) {
  const { T, ppt, region } = V, { x0, z0, nx, nz } = region, W = nx * ppt, H = nz * ppt, tx = T / ppt;
  const cv = Object.assign(document.createElement("canvas"), { width: W, height: H }), g = cv.getContext("2d"), img = g.createImageData(W, H), d = img.data;
  const ev = Object.assign(document.createElement("canvas"), { width: W, height: H }), eg = ev.getContext("2d"), eimg = eg.createImageData(W, H), e = eimg.data;
  const tally = new Float32Array(nx * nz * 8);
  const camp = w.camp, near = V.trodden;
  const trodden = (x, z) => {
    const r = Math.hypot(x - camp.fire.x, z - camp.fire.z);
    if (r < 1.3) return 2;
    if (r < 3.6 + noise(x, z, 3) * 0.8) return 1;
    for (const tn of camp.tents) if (Math.hypot(x - tn.at.x, z - tn.at.z) < tn.size * 0.75 + noise(x * 1.3, z * 1.3, 5) * 0.5) return 1;
    if (Math.hypot(x - camp.woodpile.x, z - camp.woodpile.z) < 1.8) return 1;
    // a worn path from the fire toward the water side
    const a = camp.from, px = x - camp.fire.x, pz = z - camp.fire.z, along = px * Math.cos(a) + pz * Math.sin(a), across = -px * Math.sin(a) + pz * Math.cos(a);
    if (along > 2 && along < 34 && Math.abs(across - noise(along / 14, 0.5, 9) * 5) < 0.55 + noise(along / 3, 1, 9) * 0.3 && hash(Math.floor(x * 3), Math.floor(z * 3), 8) > along / 40) return 1;
    return 0;
  };
  for (let gy = 0; gy < H; gy++) {
    const j = Math.floor(gy / ppt), ly = gy - j * ppt, z = z0 + (gy + 0.5) * tx;
    for (let gx = 0; gx < W; gx++) {
      const i = Math.floor(gx / ppt), lx = gx - i * ppt, x = x0 + (gx + 0.5) * tx, k = j * nx + i, o = (gy * W + gx) * 4;
      let c;
      if (t.kind[k] === WATER) {
        const depth = (t.trueY[k] - w.heightAt(x, z) * (V.vex || 1)) / (V.vex || 1);
        let band = depth < 0.35 ? 0 : depth < 0.9 ? 1 : depth < 1.8 ? 2 : depth < 3.2 ? 3 : depth < 6 ? 4 : depth < 12 ? 5 : 6;
        // shore: how many texels to the nearest land edge of this tile
        let edge = 99;
        const sides = [[-1, 0, lx], [1, 0, ppt - 1 - lx], [0, -1, ly], [0, 1, ppt - 1 - ly]];
        for (const [di, dj, dist] of sides) { const nb = t.at(i + di, j + dj); if (nb >= 0 && t.kind[nb] === LAND) edge = Math.min(edge, dist); }
        const scaleE = Math.max(1, ppt / 16);
        if (edge < 99) band = Math.min(band, Math.floor(edge / (3 * scaleE)));
        c = P.water[band];
        if (band >= 3) c = mix(c, P.water[band - 1], clamp(noise(gx / 30, gy / 30, 35) * 0.9, 0, 0.6));
        if (ripple(gx & 31, gy & 31)) c = mix(c, [200, 240, 240], 0.32);
        // a broken line of surf a little way off the shore
        if (edge >= 4 * scaleE && edge < 5 * scaleE && noise(gx / 7, gy / 7, 36) > -0.1 && hash(gx >> 1, gy >> 1, 37) < 0.7) c = mix(c, [226, 246, 240], 0.55);
        if (edge < scaleE && hash(gx, gy >> 1, 32) < 0.8) c = [236, 248, 240];
        else if (edge < 2 * scaleE && hash(gx >> 1, gy, 33) < 0.35) c = mix(c, [236, 248, 240], 0.6);
        const spark = hash(gx, gy, 34) < (edge < 4 * scaleE ? 0.0045 : band < 2 ? 0.0008 : 0);
        // Water keeps a little of the sky even in shade; sparkles sit far above that.
        if (spark) { e[o] = 255; e[o + 1] = 246; e[o + 2] = 220; } else { e[o] = SKY[0]; e[o + 1] = SKY[1]; e[o + 2] = SKY[2]; }
        e[o + 3] = 255;
      } else {
        let kk;
        const tr = near ? trodden(x, z) : 0;
        if (tr) kk = G.trodden;
        else {
          kk = kindAt(w, V, x, z, gx, gy);
          if (kk === G.dirt && (t.level[k] >= V.rockLevel || t.slope[k] > 0.3)) kk = G.rock;
        }
        tally[k * 8 + kk]++;
        c = tr === 2 ? P.ash[hash(gx, gy, 3) < 0.3 ? 0 : hash(gx, gy, 4) < 0.1 ? 2 : 1] : paintLand(kk, gx, gy, x, z, w, V, w.fine(w.moist, x, z));
        if (!tr && V.rivers && w.riverAt(x, z) > 0.35) c = P.water[2];
        // Rims: a lit lip where the tile drops away, a dark foot where a higher tile rises.
        let lift = 0;
        const rim = Math.max(1, Math.round(ppt / 16));
        for (const [di, dj, dist] of [[-1, 0, lx], [1, 0, ppt - 1 - lx], [0, -1, ly], [0, 1, ppt - 1 - ly]]) {
          if (dist >= rim * 2) continue;
          const nb = t.at(i + di, j + dj);
          if (nb < 0) continue;
          if (t.top[nb] < t.top[k] - 0.1) lift = Math.max(lift, dist < rim ? 0.3 : 0.14);
          else if (t.top[nb] > t.top[k] + 0.1) lift = Math.min(lift, dist < rim ? -0.32 : -0.16);
        }
        const tileJit = (hash(i, j, 41) - 0.5) * 0.05, ao = (1 - clamp(w.fine(w.sky, x, z), 0, 1)) * 0.35;
        const m = 1 + tileJit - ao + lift;
        c = lift > 0 ? mix(c, [250, 240, 190], lift * 0.6) : [c[0] * m, c[1] * m, c[2] * m];
        e[o + 3] = 255;
      }
      d[o] = c[0]; d[o + 1] = c[1]; d[o + 2] = c[2]; d[o + 3] = 255;
    }
  }
  for (let k = 0; k < nx * nz; k++) {
    let best = 0;
    for (let q = 1; q < 8; q++) if (tally[k * 8 + q] > tally[k * 8 + best]) best = q;
    t.cover[k] = best;
  }
  g.putImageData(img, 0, 0);
  eg.putImageData(eimg, 0, 0);
  return { ground: cv, glow: ev };
}

// ---------- cliff walls ----------
// Rock strata in stone courses, texel density matching the tops; the lip variants hang grass or sand over the edge.
export function wallTexture(wpx, hpx, lip, seed) {
  const cv = Object.assign(document.createElement("canvas"), { width: wpx, height: hpx }), g = cv.getContext("2d"), img = g.createImageData(wpx, hpx), d = img.data;
  const rock = ramp(lip === "sand" ? "#c2a87e" : "#b09a80", 6, 0.3), moss = ramp("#5e7e34", 4, 0.2), sandy = ramp("#cdb884", 4, 0.16), wet = ramp("#7ab8c8", 4, 0.2);
  const course = Math.max(2, Math.round(hpx / 4.5));
  for (let y = 0; y < hpx; y++) {
    const row = Math.floor(y / course), inRow = y - row * course;
    for (let x = 0; x < wpx; x++) {
      let c;
      if (lip === "fall") {
        const streak = hash(x, 0, seed) * 0.6 + hash(x, Math.floor((y + x * 3) / 3), seed + 1) * 0.4;
        c = wet[clamp(Math.floor(streak * 4 + (y / hpx) * 0.6), 0, 3)];
        if (hash(x, y, seed + 2) < 0.03) c = [240, 250, 255];
      } else {
        const off = Math.floor(hash(row, 0, seed) * 7), bw = 4 + Math.floor(hash(row, 1, seed) * 5), bx = Math.floor((x + off) / bw), inB = (x + off) - bx * bw;
        const base = 2.4 + (hash(bx, row, seed + 3) - 0.5) * 1.6 + noise(x / 7, y / 7, seed) * 0.8;
        let t = base;
        if (inRow === 0) t += 1.3;
        else if (inRow === course - 1) t -= 1.6;
        if (inB === 0) t -= 1.4;
        if (hash(x, y, seed + 4) < 0.05) t -= 1;
        t -= (y / hpx) * 0.6;
        c = rock[clamp(Math.round(t + (bayer(x, y) - 0.5) * 0.5), 0, 5)];
        if (lip === "green" || lip === "sand") {
          const hang = (lip === "green" ? 2 : 1) + Math.floor(hash(x, 5, seed) * (lip === "green" ? 3.2 : 2)) + (hash(x >> 1, 6, seed) < 0.2 ? 2 : 0);
          const L = Math.max(1, Math.round((hpx / 12) * hang));
          const pal = lip === "green" ? moss : sandy;
          if (y < L) c = pal[y === L - 1 ? 0 : y === 0 ? 3 : 2 - (hash(x, y, seed + 5) < 0.3 ? 1 : 0)];
          else if (y === L) c = mix(c, [20, 16, 24], 0.45);
          else if (lip === "green" && hash(x, y, seed + 6) < 0.02 * (1 - y / hpx)) c = moss[1];
        }
      }
      const o = (y * wpx + x) * 4;
      d[o] = c[0]; d[o + 1] = c[1]; d[o + 2] = c[2]; d[o + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  return cv;
}

const pixelTex = (cv, repeat, crisp = false) => {
  const tx = new THREE.CanvasTexture(cv);
  tx.magFilter = THREE.NearestFilter;
  tx.minFilter = crisp ? THREE.NearestFilter : THREE.NearestMipmapLinearFilter;
  tx.generateMipmaps = !crisp;
  tx.colorSpace = THREE.SRGBColorSpace;
  tx.flipY = false;
  tx.anisotropy = 4;
  if (repeat) tx.wrapS = tx.wrapT = THREE.RepeatWrapping;
  return tx;
};
export { pixelTex, P as PALETTE };

export function buildTerrain(w, V, t, paint) {
  const { T, region, step } = V, { x0, z0, nx, nz } = region, RW = nx * T, RH = nz * T;
  // Land and water tops share the painted texture; water answers light more dimly, as a deep surface would.
  // Close views keep every texel crisp; only the island shot needs mipmaps to stay calm.
  const groundTex = pixelTex(paint.ground, false, !V.mini), glowTex = pixelTex(paint.glow, false, !V.mini);
  const surfaces = [LAND, WATER].map((want) => {
    const pos = [], uv = [], idx = [];
    for (let j = 0; j < nz; j++)
      for (let i = 0; i < nx; i++) {
        const k = j * nx + i;
        if (t.kind[k] !== want) continue;
        const y = t.top[k], a = x0 + i * T, b = z0 + j * T, v = pos.length / 3;
        pos.push(a, y, b, a + T, y, b, a + T, y, b + T, a, y, b + T);
        uv.push(i / nx, j / nz, (i + 1) / nx, j / nz, (i + 1) / nx, (j + 1) / nz, i / nx, (j + 1) / nz);
        idx.push(v, v + 2, v + 1, v, v + 3, v + 2);
      }
    const gm = new THREE.BufferGeometry();
    gm.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    gm.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
    gm.setAttribute("normal", new THREE.Float32BufferAttribute(new Float32Array(pos.length).map((_, q) => (q % 3 === 1 ? 1 : 0)), 3));
    gm.setIndex(idx);
    const mat = want === LAND ? new THREE.MeshLambertMaterial({ map: groundTex }) : new THREE.MeshLambertMaterial({ map: groundTex, color: new THREE.Color(V.waterTone, V.waterTone, V.waterTone), emissiveMap: glowTex, emissive: new THREE.Color(V.sparkle, V.sparkle, V.sparkle * 0.9) });
    const m = new THREE.Mesh(gm, mat);
    // Water reads as sky-lit glass, so land shadow would only make it a dark hole.
    m.receiveShadow = want === LAND;
    m.castShadow = want === LAND;
    return m;
  });
  const tops = new THREE.Group();
  tops.add(...surfaces);

  // Walls, one set of buffers per material: 0 plain rock, 1 grass lip, 2 sand lip, 3 waterfall.
  const sets = [0, 1, 2, 3].map(() => ({ pos: [], uv: [], nor: [], col: [], idx: [] }));
  const lipOf = (k) => (t.kind[k] === WATER ? 3 : t.cover[k] === G.sand ? 2 : t.cover[k] === G.rock || t.cover[k] === G.dirt || t.cover[k] === G.trodden ? 0 : 1);
  const texW = 2 * T;
  const quad = (s, p0, p1, yTop, yBot, vTop, nrm, shade) => {
    const S = sets[s], v = S.pos.length / 3, u0 = (p0[0] + p0[1]) / texW, u1 = u0 + T / texW, vb = vTop + (yTop - yBot) / step;
    S.pos.push(p0[0], yTop, p0[1], p1[0], yTop, p1[1], p1[0], yBot, p1[1], p0[0], yBot, p0[1]);
    S.uv.push(u0, vTop, u1, vTop, u1, vb, u0, vb);
    for (let q = 0; q < 4; q++) S.nor.push(...nrm);
    const top = shade[0], bot = shade[1];
    S.col.push(...top, ...top, ...bot, ...bot);
    S.idx.push(v, v + 2, v + 1, v, v + 3, v + 2);
  };
  const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  for (let j = 0; j < nz; j++)
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i, y = t.top[k];
      for (const [di, dj] of dirs) {
        const nb = t.at(i + di, j + dj);
        if (nb < 0) continue;
        const ny = t.top[nb];
        if (ny >= y - 0.01) continue;
        const a = x0 + i * T, b = z0 + j * T;
        // Edge endpoints ordered so the face points outward (counter-clockwise seen from outside).
        let p0, p1;
        if (di === 1) { p0 = [a + T, b + T]; p1 = [a + T, b]; }
        else if (di === -1) { p0 = [a, b]; p1 = [a, b + T]; }
        else if (dj === 1) { p0 = [a, b + T]; p1 = [a + T, b + T]; }
        else { p0 = [a + T, b]; p1 = [a, b]; }
        const bottom = ny - 0.25, lip = lipOf(k);
        const sun = V.sunDir, face = di * sun.x + dj * sun.z;
        for (let s = 0, yt = y; yt > bottom + 1e-3; s++, yt -= step) {
          const yb = Math.max(bottom, yt - step), mat = lip === 3 ? 3 : s === 0 ? lip : 0;
          const warm = 1 + Math.max(0, face) * 0.06;
          const tone = (f) => { const g = 1.35 - f * 0.4; return [g * warm, g, g / warm]; };
          const f0 = (y - yt) / Math.max(step, y - bottom), f1 = (y - yb) / Math.max(step, y - bottom);
          quad(mat, p0, p1, yt, yb, 0, [di, 0, dj], [tone(f0), tone(f1)]);
        }
      }
    }
  const cpx = Math.max(3, Math.round((V.ppt * step) / T)), wpx = V.ppt * 2;
  const texes = [wallTexture(wpx, cpx, "plain", 3), wallTexture(wpx, cpx, "green", 5), wallTexture(wpx, cpx, "sand", 7), wallTexture(wpx, cpx, "fall", 9)].map((c) => pixelTex(c, true));
  const walls = sets.map((S, s) => {
    if (!S.idx.length) return null;
    const gm = new THREE.BufferGeometry();
    gm.setAttribute("position", new THREE.Float32BufferAttribute(S.pos, 3));
    gm.setAttribute("uv", new THREE.Float32BufferAttribute(S.uv, 2));
    gm.setAttribute("normal", new THREE.Float32BufferAttribute(S.nor, 3));
    gm.setAttribute("color", new THREE.Float32BufferAttribute(S.col, 3));
    gm.setIndex(S.idx);
    const m = new THREE.Mesh(gm, new THREE.MeshLambertMaterial({ map: texes[s], vertexColors: true, emissiveMap: texes[s], emissive: s === 3 ? new THREE.Color(0.3, 0.34, 0.38) : new THREE.Color(0.1, 0.085, 0.07) }));
    m.castShadow = m.receiveShadow = true;
    return m;
  }).filter(Boolean);
  return { tops, walls, RW, RH };
}
