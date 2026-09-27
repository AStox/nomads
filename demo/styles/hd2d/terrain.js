// The ground as Octopath builds it: a sculpted, rolling polygon mesh straight from the height field, painted texel by
// texel into one world-space pixel-art texture, with faceted rock outcrops only where the ground turns steep.
import * as THREE from "three";
import { hash, noise } from "../world.js";
import { ramp, rgb, mix, clamp, bayer, smooth } from "./pixels.js";

// Ground kinds painted on the land.
const G = { grass: 0, forest: 1, heath: 2, marsh: 3, dirt: 4, rock: 5, sand: 6, trodden: 7 };

// Height and water, in the view's space: heights are stretched by `vex`; water levels stay in true meters.
export function ground(w, V) {
  const vex = V.vex, { T, region } = V, { x0, z0, nx, nz } = region, RW = nx * T, RH = nz * T;
  // A lake keeps the level of its nearest lake cell; everything else meets the sea at 0.
  const level = (x, z) => {
    const cx = Math.round((x - w.START) / w.CELL), cy = Math.round((z - w.START) / w.CELL);
    let s = Infinity;
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        const i = clamp(cy + dy, 0, w.N - 1) * w.N + clamp(cx + dx, 0, w.N - 1);
        if (w.isle.water[i] > 0) { const L = w.isle.height[i] + w.isle.water[i]; if (L > 0.6) s = Math.min(s, L); }
      }
    return s === Infinity ? 0 : s;
  };
  // Near the waterline the ground wanders a little, so shores curl into coves and spits instead of following cells.
  const hTrue = (x, z) => {
    const h = w.heightAt(x, z), near = 1 - smooth(1.2, 3.5, Math.abs(h - level(x, z)));
    return near > 0 ? h + near * (noise(x / 26, z / 26, 71) * 0.9 + noise(x / 8, z / 8, 72) * 0.3) : h;
  };
  const hAt = (x, z) => hTrue(x, z) * vex;
  const wetAt = (x, z) => hTrue(x, z) < level(x, z) + 0.05 || w.fine(w.wet, x, z) > 0.5 || (V.rivers && w.riverAt(x, z) > 0.5);
  // The mesh grid, kept so painting and outcrops can read slope without resampling the field.
  const g = V.mesh, mx = Math.round(RW / g) + 1, mz = Math.round(RH / g) + 1, H = new Float32Array(mx * mz);
  let ymax = 0;
  for (let j = 0; j < mz; j++) for (let i = 0; i < mx; i++) { const y = hAt(x0 + i * g, z0 + j * g); H[j * mx + i] = y; ymax = Math.max(ymax, y); }
  const slopeAt = (x, z) => {
    const i = clamp(Math.round((x - x0) / g), 1, mx - 2), j = clamp(Math.round((z - z0) / g), 1, mz - 2);
    return Math.hypot(H[j * mx + i + 1] - H[j * mx + i - 1], H[(j + 1) * mx + i] - H[(j - 1) * mx + i]) / (2 * g);
  };
  const t = { hAt, hTrue, level, wetAt, slopeAt, H, mx, mz, ymax, RW, RH, blocked: [] };
  const inside = (x, z) => x > x0 && x < x0 + RW && z > z0 && z < z0 + RH;
  // Where a sprite stands: on the ground, never in water, inside a rock, or off the diorama.
  t.groundAt = (x, z) => (!inside(x, z) || wetAt(x, z) || t.inRock(x, z) ? null : hAt(x, z));
  t.inRock = () => false;
  t.rockNear = () => 9;
  const camp = w.camp, f = camp.fire, paths = V.trodden ? campPaths(w, t) : null;
  // Bare ground where people live: ash at the hearth (2), trodden earth round it, the tents and the woodpile (1).
  t.around = (x, z) => {
    if (!V.trodden) return 0;
    const r = Math.hypot(x - f.x, z - f.z);
    if (r < 1.3) return 2;
    if (r > 30) return 0;
    if (r < 3.6 + noise(x, z, 3) * 0.8) return 1;
    for (const tn of camp.tents) if (Math.hypot(x - tn.at.x, z - tn.at.z) < tn.size * 0.7 + noise(x * 1.3, z * 1.3, 5) * 0.5) return 1;
    return Math.hypot(x - camp.woodpile.x, z - camp.woodpile.z) < 1.6 ? 1 : 0;
  };
  t.path = (x, z) => (paths && Math.abs(x - f.x) < 260 && Math.abs(z - f.z) < 260 ? paths(x, z) : 0);
  t.worn = (x, z) => t.around(x, z) > 0 || t.path(x, z) > 0.7;
  return t;
}

// Worn paths from the fire to every tent door, the woodpile and the nearest water, meandering a little.
function campPaths(w, t) {
  const camp = w.camp, f = camp.fire, pts = [];
  const walk = (ax, az, bx, bz, width, seed) => {
    const L = Math.hypot(bx - ax, bz - az), ux = (bx - ax) / L, uz = (bz - az) / L;
    for (let s = 0; s <= L; s += 0.5) {
      const taper = Math.sin((s / L) * Math.PI), off = noise(s / 11, seed, 50 + seed) * Math.min(4, L * 0.12) * taper;
      pts.push({ x: ax + ux * s - uz * off, z: az + uz * s + ux * off, r: width * (0.8 + 0.4 * noise(s / 3, seed, 60)) });
    }
  };
  camp.tents.forEach((tn, k) => {
    const dx = Math.sin(tn.yaw), dz = Math.cos(tn.yaw);
    walk(f.x + (tn.at.x - f.x) * 0.3, f.z + (tn.at.z - f.z) * 0.3, tn.at.x + dx * tn.size * 0.55, tn.at.z + dz * tn.size * 0.55, 0.5, k + 1);
  });
  walk(f.x, f.z, camp.woodpile.x, camp.woodpile.z, 0.45, 7);
  // The nearest water, searched on a fan of bearings.
  let best = null;
  for (let a = 0; a < 36; a++) {
    const dx = Math.cos((a / 36) * 6.2832), dz = Math.sin((a / 36) * 6.2832);
    for (let s = 6; s < 220; s += 1.5) if (t.wetAt(f.x + dx * s, f.z + dz * s)) { if (!best || s < best.s) best = { s, dx, dz }; break; }
  }
  if (best) walk(f.x, f.z, f.x + best.dx * (best.s + 1), f.z + best.dz * (best.s + 1), 0.7, 11);
  const B = 3, grid = new Map();
  for (const p of pts) { const k = Math.floor(p.x / B) * 65536 + Math.floor(p.z / B); (grid.get(k) || grid.set(k, []).get(k)).push(p); }
  // How deep into a path a point lies: >1 in its worn middle, 0 outside.
  return (x, z) => {
    const i = Math.floor(x / B), j = Math.floor(z / B);
    let best = 0;
    for (let dj = -1; dj <= 1; dj++)
      for (let di = -1; di <= 1; di++) {
        const list = grid.get((i + di) * 65536 + j + dj);
        if (list) for (const p of list) { const q = 1 - Math.hypot(x - p.x, z - p.z) / (p.r * 1.8); if (q > best) best = q; }
      }
    return best * 1.8;
  };
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

// Paints the land texture, the water texture and the water's glow (sparkles), all in world space over the region.
export function paintGround(w, V, t) {
  const { T, ppt, region } = V, { x0, z0, nx, nz } = region, W = nx * ppt, H = nz * ppt, tx = T / ppt, vex = V.vex;
  const canvas = () => { const c = Object.assign(document.createElement("canvas"), { width: W, height: H }), g = c.getContext("2d"); return { c, g, img: g.createImageData(W, H) }; };
  const land = canvas(), water = canvas(), glow = canvas(), d = land.img.data, wd = water.img.data, e = glow.img.data;
  const scaleE = Math.max(1, ppt / 16);
  for (let gy = 0; gy < H; gy++) {
    const z = z0 + (gy + 0.5) * tx;
    for (let gx = 0; gx < W; gx++) {
      const x = x0 + (gx + 0.5) * tx, o = (gy * W + gx) * 4, h = t.hTrue(x, z), L = t.level(x, z), above = h - L;
      // Water: banded by true depth, foam where it thins onto the shore, a broken surf line a little way out.
      if (above < 0.4) {
        const depth = -above;
        let c = P.water[depth < 0.2 ? 0 : depth < 0.6 ? 1 : depth < 1.4 ? 2 : depth < 3 ? 3 : depth < 6 ? 4 : depth < 12 ? 5 : 6];
        if (depth > 1.4) c = mix(c, P.water[1], clamp(noise(gx / 30, gy / 30, 35) * 0.5, 0, 0.3));
        if (ripple(gx & 31, gy & 31)) c = mix(c, [200, 240, 240], 0.32);
        if (depth > 0.45 && depth < 0.62 && noise(gx / (7 * scaleE), gy / (7 * scaleE), 36) > -0.1 && hash(gx >> 1, gy >> 1, 37) < 0.7) c = mix(c, [226, 246, 240], 0.55);
        if (depth < 0.07 && hash(gx, gy >> 1, 32) < 0.85) c = [236, 248, 240];
        wd[o] = c[0]; wd[o + 1] = c[1]; wd[o + 2] = c[2]; wd[o + 3] = 255;
        const spark = depth > 0 && hash(gx, gy, 34) < (depth < 0.6 ? 0.004 : depth < 1.4 ? 0.0008 : 0.0002);
        // Water keeps a little of the sky even in shade; sparkles sit far above that.
        if (spark) { e[o] = 255; e[o + 1] = 246; e[o + 2] = 220; } else { e[o] = SKY[0]; e[o + 1] = SKY[1]; e[o + 2] = SKY[2]; }
        e[o + 3] = 255;
      }
      let c;
      if (above < 0) c = P.sand[1];
      else {
        const tr = t.around(x, z), path = t.path(x, z);
        const worn = tr || path > 1 || (path > 0.55 && hash(gx, gy, 38) < (path - 0.55) * 2.2);
        let kk;
        if (worn) kk = G.trodden;
        else {
          kk = kindAt(w, V, x, z, gx, gy);
          // Scree and bare earth round the foot of every outcrop.
          const q = t.rockNear(x, z), qq = q + (hash(gx, gy, 39) - 0.5) * 0.3;
          if (q > 0.97 && qq < 1.15) kk = G.rock;
          else if (q > 0.97 && qq < 1.35 && kk !== G.sand) kk = G.dirt;
        }
        c = tr === 2 ? P.ash[hash(gx, gy, 3) < 0.3 ? 0 : hash(gx, gy, 4) < 0.1 ? 2 : 1] : paintLand(kk, gx, gy, x, z, w, V, w.fine(w.moist, x, z));
        if (!worn && V.rivers && w.riverAt(x, z) > 0.35) c = ripple(gx & 31, gy & 31) ? mix(P.water[2], [200, 240, 240], 0.3) : P.water[2];
        else if (!worn && V.rivers && w.riverAt(x, z) > 0.2) c = mix(P.dirt[1], P.water[1], 0.3);
        // The wet edge of the shore: foam at the waterline, then dark wet sand.
        if (above < 0.05 && hash(gx, gy >> 1, 40) < 0.7) c = [236, 248, 240];
        else if (above < 0.1) c = mix(c, P.sand[1], 0.6);
        else if (above < 0.2 && hash(gx, gy, 41) < 0.5) c = mix(c, P.sand[3], 0.5);
        const ao = (1 - clamp(w.fine(w.sky, x, z), 0, 1)) * 0.35;
        c = [c[0] * (1 - ao), c[1] * (1 - ao), c[2] * (1 - ao)];
      }
      d[o] = c[0]; d[o + 1] = c[1]; d[o + 2] = c[2]; d[o + 3] = 255;
    }
  }
  for (const k of [land, water, glow]) k.g.putImageData(k.img, 0, 0);
  return { ground: land.c, water: water.c, glow: glow.c };
}

// ---------- rock ----------
// Rock strata: wavy bedding layers of about a meter, broken by irregular joints into slabs, each slab lit on its upper
// edge and shadowed along its underside, drawn at the ground's texel size so cliffs and grass match. Tiles in x and y.
function strataTexture(S, course, seed) {
  const cv = Object.assign(document.createElement("canvas"), { width: S, height: S }), g = cv.getContext("2d"), img = g.createImageData(S, S), d = img.data;
  const rock = ramp("#b4a086", 6, 0.3), moss = ramp("#5e7e34", 3, 0.16);
  const wave = (x) => Math.sin((x / S) * Math.PI * 2 * 2 + seed) * course * 0.35 + Math.sin((x / S) * Math.PI * 2 * 5 + seed * 3) * course * 0.2;
  const layerOf = (x, y) => { const f = (y + wave(x)) / course; return [Math.floor(f), f - Math.floor(f)]; };
  const slabOf = (x, L) => { const bw = course * (2.2 + hash(L, 1, seed) * 2.5); return (x + hash(L, 0, seed) * bw) / bw; };
  for (let y = 0; y < S; y++)
    for (let x = 0; x < S; x++) {
      const [L, f] = layerOf(x, y), sf = slabOf(x - f * course * (hash(L, 2, seed) - 0.5), ((L % 64) + 64) % 64), sb = Math.floor(sf), inS = sf - sb;
      const Lw = ((L % 64) + 64) % 64;
      let t = 2.4 + (hash(sb, Lw, seed + 3) - 0.5) * 1.8 + noise(x / 6, y / 6, seed) * 0.7;
      if (f < 1 / course) t += 1.4;
      else if (f > 1 - 1.5 / course) t -= 1.8;
      if (inS < 0.06 && hash(sb, Lw, seed + 7) < 0.8) t -= 1.6;
      if (hash(x, y, seed + 4) < 0.06) t -= 1;
      let c = rock[clamp(Math.round(t + (bayer(x, y) - 0.5) * 0.5), 0, 5)];
      if (f < 1.5 / course && hash(x >> 1, Lw, seed + 5) < 0.3) c = moss[hash(x, y, 6) < 0.5 ? 1 : 2];
      const o = (y * S + x) * 4;
      d[o] = c[0]; d[o + 1] = c[1]; d[o + 2] = c[2]; d[o + 3] = 255;
    }
  g.putImageData(img, 0, 0);
  return cv;
}
// Grass spilling over a cliff top: ragged strands hanging from the rim, transparent below.
function lipTexture(Wd, Hd, seed) {
  const cv = Object.assign(document.createElement("canvas"), { width: Wd, height: Hd }), g = cv.getContext("2d"), img = g.createImageData(Wd, Hd), d = img.data;
  const moss = ramp("#5c8c36", 5, 0.24);
  for (let x = 0; x < Wd; x++) {
    const L = Math.round(Hd * (0.2 + 0.5 * hash(x, 0, seed) ** 1.6 + (hash(x >> 2, 1, seed) < 0.25 ? 0.3 : 0)));
    for (let y = 0; y < L; y++) {
      const c = moss[clamp(Math.round(3.6 - (y / L) * 3 + (hash(x, y, seed + 2) - 0.5)), 0, 4)], o = (y * Wd + x) * 4;
      d[o] = c[0]; d[o + 1] = c[1]; d[o + 2] = c[2]; d[o + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  return cv;
}

// Faceted outcrops where the ground is steep or bare: uneven, overhanging, cliff-faced on the downhill side, grass on
// top and spilling over the rim. Each lists its footprint so nothing grows inside it.
export function outcrops(w, V, t) {
  const { region } = V, { x0, z0 } = region, R = V.rock, S = R.cell, texel = V.T / V.ppt;
  const course = clamp(Math.round(R.strata / texel), 4, 12), TS = course * Math.round(64 / course), rep = TS * texel;
  const side = { pos: [], uv: [], col: [] }, cap = { pos: [], uv: [] }, lip = { pos: [], uv: [] };
  const foot = [], B = S * 2, grid = new Map();
  // Triangles are wound to face `ref` (outward for walls, up for caps) whatever order the rings give them.
  const tri = (G, a, b, c, ref) => {
    const e1 = [b.p[0] - a.p[0], b.p[1] - a.p[1], b.p[2] - a.p[2]], e2 = [c.p[0] - a.p[0], c.p[1] - a.p[1], c.p[2] - a.p[2]];
    const nx = e1[1] * e2[2] - e1[2] * e2[1], ny = e1[2] * e2[0] - e1[0] * e2[2], nz = e1[0] * e2[1] - e1[1] * e2[0];
    if (nx * ref[0] + ny * ref[1] + nz * ref[2] < 0) [b, c] = [c, b];
    G.pos.push(...a.p, ...b.p, ...c.p); G.uv.push(...a.uv, ...b.uv, ...c.uv); if (G.col) G.col.push(...a.c, ...b.c, ...c.c);
  };
  const regionUV = (x, z) => [(x - x0) / t.RW, (z - z0) / t.RH];
  let n = 0;
  for (let gz = z0 + S; gz < z0 + t.RH - S; gz += S)
    for (let gx = x0 + S; gx < x0 + t.RW - S; gx += S) {
      const i = Math.round(gx / S), j = Math.round(gz / S);
      const cx = gx + (hash(i, j, 81) - 0.5) * S * 0.8, cz = gz + (hash(i, j, 82) - 0.5) * S * 0.8;
      if (t.wetAt(cx, cz)) continue;
      const hx = t.hAt(cx + S / 2, cz) - t.hAt(cx - S / 2, cz), hz = t.hAt(cx, cz + S / 2) - t.hAt(cx, cz - S / 2), sv = Math.hypot(hx, hz) / S;
      const score = smooth(R.slope, R.slope * 1.7, sv) + clamp((w.fine(w.cover.bare, cx, cz) - 0.45) * 2.5, 0, 1) * 0.5;
      if (hash(i, j, 83) >= score) continue;
      const ux = sv > 1e-4 ? hx / (sv * S) : 1, uz = sv > 1e-4 ? hz / (sv * S) : 0, vx = -uz, vz = ux;
      const r = S * (0.5 + hash(i, j, 84) * 0.5), ev = 1.3;
      const yLow = t.hAt(cx - ux * r, cz - uz * r), yHigh = t.hAt(cx + ux * r, cz + uz * r), rise = Math.max(0, yHigh - yLow);
      const top = yHigh + S * R.lift * (0.12 + hash(i, j, 85) ** 2 * 0.75);
      const k = 7 + Math.floor(hash(i, j, 86) * 3), tint = 0.86 + hash(i, j, 87) * 0.22;
      const ring = [];
      for (let q = 0; q < k; q++) {
        const a = ((q + (hash(q, i, j) - 0.5) * 0.5) / k) * Math.PI * 2, rr = r * (0.65 + hash(q, j, i + 1) * 0.6);
        const ca = Math.cos(a), sa = Math.sin(a), px = cx + vx * ca * rr * ev + ux * sa * rr, pz = cz + vz * ca * rr * ev + uz * sa * rr;
        const yb = t.hAt(px, pz) - rise * 0.25 - S * 0.12, yt = Math.max(top + (hash(q, i, j + 2) - 0.5) * S * 0.3, t.hAt(px, pz) + S * 0.08);
        ring.push({ px, pz, yb, yt, ca, sa, rr });
      }
      // Rings from foot to rim: recessed in the middle, bulging just under the rim for an overhang.
      const lev = [[0, 1.0], [0.45, 0.86], [0.82, 1.06], [1, 0.97]];
      const P = lev.map(([f, s]) => ring.map((v) => {
        const x = cx + (v.px - cx) * s, z = cz + (v.pz - cz) * s, y = v.yb + (v.yt - v.yb) * f;
        return { x, y, z };
      }));
      let perim = 0;
      const sAt = [0];
      for (let q = 1; q <= k; q++) { const a = ring[q - 1], b = ring[q % k]; perim += Math.hypot(a.px - b.px, a.pz - b.pz); sAt.push(perim); }
      const u0 = hash(i, j, 88) * 7, shade = (y) => { const g = tint * (1.05 - clamp((top - y) / Math.max(1, top - yLow + S * 0.2), 0, 1) * 0.3); return [g * 1.03, g, g * 0.95]; };
      const vert = (L, q) => { const p = P[L][q % k]; return { p: [p.x, p.y, p.z], uv: [u0 + sAt[q] / rep, p.y / rep], c: shade(p.y) }; };
      for (let L = 0; L < 3; L++)
        for (let q = 0; q < k; q++) {
          const a = vert(L, q), b = vert(L, q + 1), c = vert(L + 1, q + 1), dd = vert(L + 1, q), m = P[L][q];
          const ref = [m.x - cx, 0, m.z - cz];
          tri(side, a, dd, c, ref); tri(side, a, c, b, ref);
        }
      // The top: a low faceted dome carrying the ground's own texture, so the grass above runs onto it.
      const apex = { x: cx + (hash(i, j, 89) - 0.5) * r * 0.4, y: Math.max(...ring.map((v) => v.yt)) + S * 0.14, z: cz + (hash(i, j, 90) - 0.5) * r * 0.4 };
      const cv = (p) => ({ p: [p.x, p.y, p.z], uv: regionUV(p.x, p.z) });
      for (let q = 0; q < k; q++) tri(cap, cv(P[3][q]), cv(apex), cv(P[3][(q + 1) % k]), [0, 1, 0]);
      const green = w.fine(w.cover.grass, cx, cz) + w.fine(w.cover.tree, cx, cz) + w.fine(w.cover.shrub, cx, cz) > 0.5;
      if (green) {
        const drop = texel * 16 * (0.7 + hash(i, j, 91) * 0.6);
        for (let q = 0; q < k; q++) {
          const A = P[3][q], Bq = P[3][(q + 1) % k], out = (p, s) => ({ x: cx + (p.x - cx) * s, z: cz + (p.z - cz) * s });
          const a2 = out(A, 1.1), b2 = out(Bq, 1.1), ua = sAt[q] / (32 * texel), ub = sAt[q + 1] / (32 * texel);
          tri(lip, { p: [A.x, A.y + 0.02, A.z], uv: [ua, 0] }, { p: [a2.x, A.y - drop, a2.z], uv: [ua, 1] }, { p: [b2.x, Bq.y - drop, b2.z], uv: [ub, 1] }, [A.x - cx, 0, A.z - cz]);
          tri(lip, { p: [A.x, A.y + 0.02, A.z], uv: [ua, 0] }, { p: [b2.x, Bq.y - drop, b2.z], uv: [ub, 1] }, { p: [Bq.x, Bq.y + 0.02, Bq.z], uv: [ub, 0] }, [A.x - cx, 0, A.z - cz]);
        }
      }
      const f = { x: cx, z: cz, r: r * ev * 0.9 };
      foot.push(f);
      const key = Math.floor(cx / B) * 65536 + Math.floor(cz / B);
      (grid.get(key) || grid.set(key, []).get(key)).push(f);
      t.ymax = Math.max(t.ymax, apex.y);
      n++;
    }
  // Distance to the nearest outcrop, in units of its footprint radius.
  t.rockNear = (x, z) => {
    const i = Math.floor(x / B), j = Math.floor(z / B);
    let q = 9;
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) { const l = grid.get((i + di) * 65536 + j + dj); if (l) for (const f of l) q = Math.min(q, Math.hypot(x - f.x, z - f.z) / f.r); }
    return q;
  };
  t.inRock = (x, z) => t.rockNear(x, z) < 1;
  return { side, cap, lip, n, strata: strataTexture(TS, course, 3), lipTex: lipTexture(32, 16, 5) };
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

const geom = (G) => {
  const gm = new THREE.BufferGeometry();
  gm.setAttribute("position", new THREE.Float32BufferAttribute(G.pos, 3));
  gm.setAttribute("uv", new THREE.Float32BufferAttribute(G.uv, 2));
  if (G.col) gm.setAttribute("color", new THREE.Float32BufferAttribute(G.col, 3));
  if (G.idx) gm.setIndex(G.idx);
  gm.computeVertexNormals();
  return gm;
};

export function buildTerrain(w, V, t, paint, rock) {
  const { region } = V, { x0, z0 } = region, { mx, mz, H } = t, g = V.mesh;
  // Close views keep every texel crisp; only the island shot needs mipmaps to stay calm.
  const crisp = !V.mini, groundTex = pixelTex(paint.ground, false, crisp);
  const groundMat = new THREE.MeshLambertMaterial({ map: groundTex });
  const land = { pos: [], uv: [], idx: [] };
  for (let j = 0; j < mz; j++) for (let i = 0; i < mx; i++) { const x = x0 + i * g, z = z0 + j * g; land.pos.push(x, H[j * mx + i], z); land.uv.push((x - x0) / t.RW, (z - z0) / t.RH); }
  for (let j = 0; j < mz - 1; j++) for (let i = 0; i < mx - 1; i++) { const a = j * mx + i, b = a + 1, c = a + mx, d = c + 1; land.idx.push(a, c, b, b, c, d); }
  const ground = new THREE.Mesh(geom(land), groundMat);
  ground.castShadow = ground.receiveShadow = true;

  // Water: flat at its level, drawn only where it lies above the ground; off the lake it tucks under the bank.
  const wat = { pos: [], uv: [], idx: [] }, vi = new Int32Array(mx * mz).fill(-1), wy = new Float32Array(mx * mz);
  for (let j = 0; j < mz; j++)
    for (let i = 0; i < mx; i++) {
      const x = x0 + i * g, z = z0 + j * g, L = t.level(x, z) * V.vex, k = j * mx + i;
      wy[k] = L > 0 && w.fine(w.wet, x, z) < 0.08 ? Math.min(L, H[k] - 0.4 * V.vex) : L;
    }
  const vertex = (k) => {
    if (vi[k] < 0) { const i = k % mx, j = (k - i) / mx, x = x0 + i * g, z = z0 + j * g; vi[k] = wat.pos.length / 3; wat.pos.push(x, wy[k], z); wat.uv.push((x - x0) / t.RW, (z - z0) / t.RH); }
    return vi[k];
  };
  for (let j = 0; j < mz - 1; j++)
    for (let i = 0; i < mx - 1; i++) {
      const a = j * mx + i, b = a + 1, c = a + mx, d = c + 1;
      if ([a, b, c, d].some((k) => H[k] < wy[k])) wat.idx.push(vertex(a), vertex(c), vertex(b), vertex(b), vertex(c), vertex(d));
    }
  const out = [ground];
  if (wat.idx.length) {
    const water = new THREE.Mesh(geom(wat), new THREE.MeshLambertMaterial({ map: pixelTex(paint.water, false, crisp), color: new THREE.Color(V.waterTone, V.waterTone, V.waterTone), emissiveMap: pixelTex(paint.glow, false, crisp), emissive: new THREE.Color(V.sparkle, V.sparkle, V.sparkle * 0.9) }));
    out.push(water);
  }
  if (rock.n) {
    const sides = new THREE.Mesh(geom(rock.side), new THREE.MeshLambertMaterial({ map: pixelTex(rock.strata, true, crisp), vertexColors: true, flatShading: true, emissiveMap: pixelTex(rock.strata, true, crisp), emissive: new THREE.Color(0.12, 0.1, 0.08) }));
    const caps = new THREE.Mesh(geom(rock.cap), groundMat);
    const lips = new THREE.Mesh(geom(rock.lip), new THREE.MeshLambertMaterial({ map: (() => { const x = pixelTex(rock.lipTex, true, true); x.wrapT = THREE.ClampToEdgeWrapping; return x; })(), alphaTest: 0.5, side: THREE.DoubleSide }));
    for (const m of [sides, caps, lips]) { m.castShadow = m.receiveShadow = true; out.push(m); }
  }
  return out;
}
