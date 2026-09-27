// The camp close up, in quarter-meter cubes: the clearing's edge growing back where the tree cover is thick, stumps
// where the wood was cut, A-frame tents, people round a ringed fire, log seats, a woodpile and clumps of grass.
// Positions come from the world's camp; what grows comes from its cover fields.
import { COLORS } from "../island.js";
import { clamp, hash, noise, smooth } from "../world.js";
import { EARTH, GLOW, SMALL, SMOKE, THING } from "./grid.js";
import { CAP, jit, mix, scale, withAlpha } from "./terrain.js";

const hex = (s) => parseInt(s.slice(1), 16);
const cloth = (k) => scale(hex(COLORS[((k % COLORS.length) + COLORS.length) % COLORS.length]), 1.3);
const SKIN = [0xe2b690, 0xc68e64, 0x8d5b3c, 0xd9a47a, 0xa8714c];
const HAIR = [0x2e2118, 0x6b4526, 0x1c1714, 0xa3753e, 0x4a3322];
const BARK = 0x5a3b24, CUT = 0xcfae7a;

export function campScene(W, g, V, T, kit) {
  const { vox, x0, z0, nx, nz } = V;
  const { put, line, tree, bush, groundAt, inside, lights } = kit;
  const C = W.camp, fire = C.fire, m = 1 / vox, S = nx * vox;
  const at = (x, z) => [(x - x0) * m, (z - z0) * m];
  const top = (i, j) => groundAt(i, j) + 1;
  const grassy = (i, j) => { const k = inside(i, j) ? T.cap[j * nx + i] : -1; return k === CAP.meadow || k === CAP.heath || k === CAP.forest || k === CAP.marsh; };
  const busy = (x, z, r) => Math.hypot(x - fire.x, z - fire.z) < 4 + r || Math.hypot(x - C.woodpile.x, z - C.woodpile.z) < 2 + r || C.tents.some((t) => Math.hypot(x - t.at.x, z - t.at.z) < t.size + r);
  const { isle, START, CELL } = W;
  const site = (x, z) => {
    const cx = (x - START) / CELL, cy = (z - START) / CELL;
    return { exposure: W.bilinear(isle.exposure, cx, cy), soil: Math.min(1.5, W.bilinear(isle.soil, cx, cy)), moist: W.fine(W.moist, x, z) };
  };
  // A jittered lattice over the slab, one sample per cell.
  const scatter = (step, seed, fn) => {
    for (let gz = z0 - step; gz < z0 + S + step; gz += step)
      for (let gx = x0 - step; gx < x0 + S + step; gx += step) {
        const a = Math.floor(gx * 3), b = Math.floor(gz * 3);
        fn(gx + hash(a, b, seed) * step, gz + hash(a, b, seed + 1) * step, (k) => hash(a, b, seed + 2 + k));
      }
  };

  // ---------- the clearing's edge ----------
  // Young trees take hold where the tree cover is thick and people no longer cut, by the same rules world.js grows its
  // trees by; bushes fill in under them; stumps are left nearer the fire, where the camp's wood came from.
  scatter(2.4, 101, (x, z, r) => {
    const d = Math.hypot(x - fire.x, z - fire.z), tr = W.fine(W.cover.tree, x, z);
    if (r(0) > clamp((tr - 0.12) * 4, 0, 0.95) * smooth(8, 13, d) || busy(x, z, 2) || !W.dry(x, z)) return;
    const { exposure, soil, moist } = site(x, z), vigor = clamp(0.6 + moist * 0.35 + soil * 0.2 - exposure * 0.4, 0.4, 1.2);
    const pine = clamp(0.08 + (W.heightAt(x, z) - 80) / 320 + exposure * 0.8 - soil * 0.3 + (1 - moist) * 0.3, 0.03, 0.97);
    const kind = r(1) < pine ? "pine" : moist > 0.9 && r(2) < 0.45 ? "aspen" : soil > 0.9 && r(3) < 0.6 ? "oak" : "ash";
    const tall = (5.5 + 4.5 * r(4)) * vigor, R = tall * 0.3;
    if (x < x0 + R * 0.6 || z < z0 + R * 0.6 || x > x0 + S - R * 0.6 || z > z0 + S - R * 0.6) return;
    tree({ x, z, tall, kind, yaw: r(5) * 6.283, tint: r(6) });
  });
  scatter(1.6, 111, (x, z, r) => {
    const d = Math.hypot(x - fire.x, z - fire.z), tr = W.fine(W.cover.tree, x, z), sh = W.fine(W.cover.shrub, x, z);
    if (r(0) > clamp((tr + sh * 0.8 - 0.14) * 3, 0, 0.8) * smooth(7, 12, d) || busy(x, z, 1) || !W.dry(x, z)) return;
    const { exposure, moist } = site(x, z);
    bush({ x, z, tall: 0.7 + 1.1 * r(1), heath: clamp(exposure * 1.4 + sh - moist * 0.3, 0, 1), tint: r(2) });
  });
  scatter(2.2, 121, (x, z, r) => {
    const d = Math.hypot(x - fire.x, z - fire.z), tr = W.fine(W.cover.tree, x, z);
    if (r(0) > clamp((tr - 0.06) * 0.3, 0, 0.07) * smooth(7, 11, d) * (1 - smooth(16, 21, d)) || busy(x, z, 0.8)) return;
    const [fi, fj] = at(x, z).map(Math.floor), w = r(1) < 0.4 ? 3 : 2, h = r(2) < 0.5 ? 3 : 2, y = top(fi, fj);
    for (let a = 0; a < w; a++)
      for (let b = 0; b < w; b++) {
        if (w === 3 && (a === 1) === (b === 1) && a !== 1) continue;
        for (let e = 0; e < h; e++) put(fi + a, y + e, fj + b, THING, e === h - 1 ? CUT : BARK, 0.1);
      }
    for (const [a, b] of [[-1, 0], [w, 1], [1, -1]]) put(fi + a, y, fj + b, SMALL, BARK, 0.12);
  });

  // ---------- tents ----------
  // A-frames: two canvas slopes over a hollow with a mat inside, a closed back, an open door with its flaps tied back,
  // and poles at both ends carrying a ridge pole that sticks out past the canvas.
  const CANVAS = [[0xe4d6ae, 0xc4ae80], [0xc85c3c, 0x9a4028], [0x4d8e9c, 0x356c7c]];
  C.tents.forEach((tent, k) => {
    const L = tent.size * 1.15 * m, hw = tent.size * 0.5 * m, H = tent.size * 0.64 * m, slope = H / hw, norm = Math.hypot(1, slope);
    const Hd = H * 0.78, dw = hw * 0.48;
    // Squared to the grid so the canvas slopes step evenly instead of breaking up into a brick pattern.
    const yaw = Math.round(tent.yaw / (Math.PI / 2)) * (Math.PI / 2);
    const fx = Math.round(Math.sin(yaw)), fz = Math.round(Math.cos(yaw)), rx = fz, rz = -fx;
    const [cx, cz] = at(tent.at.x, tent.at.z), R = Math.ceil(Math.hypot(L / 2 + 4, hw + 2));
    const local = (i, j) => { const dx = i + 0.5 - cx, dz = j + 0.5 - cz; return [dx * rx + dz * rz, dx * fx + dz * fz]; };
    let base = Infinity;
    for (let j = Math.floor(cz - R); j <= cz + R; j++)
      for (let i = Math.floor(cx - R); i <= cx + R; i++) {
        const [lx, lz] = local(i, j);
        if (Math.abs(lz) <= L / 2 && Math.abs(lx) <= hw) base = Math.min(base, top(i, j));
      }
    const [c0, c1] = CANVAS[k % 3], mat = cloth(k * 4 + 3);
    const doorway = (lx, ly) => ly < Hd - (Hd / dw) * Math.abs(lx);
    for (let y = base; y <= base + Math.ceil(H) + 1; y++)
      for (let j = Math.floor(cz - R); j <= cz + R; j++)
        for (let i = Math.floor(cx - R); i <= cx + R; i++) {
          const [lx, lz] = local(i, j), ly = y - base + 0.5, depth = (H - ly - slope * Math.abs(lx)) / norm;
          let col = -1, kind = THING;
          if (Math.abs(lz) <= L / 2 && depth >= 0) {
            const back = lz < -L / 2 + 1.3, front = lz > L / 2 - 1.3;
            if (depth < 1.5 || back || (front && !doorway(lx, ly))) col = ly < 1.2 || ly > H - 1.4 ? c1 : c0; else if (ly < 1) { col = mat; kind = SMALL; }
          } else if (lz > L / 2 && lz < L / 2 + 2.6) {
            const u = lz - L / 2, edge = Math.max(0, dw * (1 - ly / Hd));
            if (Math.abs(Math.abs(lx) - edge - u * 0.85) < 0.7 && ly < Hd * (1 - u / 3.6)) col = mix(c0, 0xffffff, 0.14);
          }
          if (col >= 0) put(i, y, j, kind, col, 0.03);
        }
    const pole = (lx, ly, lz) => put(Math.floor(cx + lx * rx + lz * fx), base + Math.floor(ly), Math.floor(cz + lx * rz + lz * fz), THING, 0x6b4a2c, 0.08);
    for (let ly = 0; ly <= H + 0.5; ly++) { pole(0, ly, L / 2 + 0.7); pole(0, ly, -L / 2 - 0.7); }
    for (let lz = -L / 2 - 1.4; lz <= L / 2 + 1.4; lz += 0.5) pole(0, H + 0.6, lz);
  });

  // ---------- people ----------
  // Seven cubes tall: boots, legs, a body and sleeves in camp colors, a head with hair; turned to face the fire. The
  // sitting ones sit on log seats laid round the ring.
  C.people.forEach((p, k) => {
    const q = ((Math.round(p.yaw / (Math.PI / 2)) % 4) + 4) % 4, f = [[0, 1], [1, 0], [0, -1], [-1, 0]][q], r = [f[1], -f[0]];
    const [pi, pj] = at(p.at.x, p.at.z).map(Math.floor), y0 = top(pi, pj);
    const cell = (lx, ly, lz, col, kind = THING) => put(pi + lx * r[0] + lz * f[0], y0 + ly, pj + lx * r[1] + lz * f[1], kind, col, 0.05);
    const body = cloth(k * 5 + 1), sleeve = cloth(k * 5 + 6), legs = mix(hex(COLORS[(k * 7 + 3) % COLORS.length]), 0x1c1a18, 0.55), skin = SKIN[k % 5], hair = HAIR[k % 5];
    const head = (y, back) => {
      for (const lx of [0, 1]) for (const lz of [back, back + 1]) { cell(lx, y, lz, skin); cell(lx, y + 1, lz, lz === back ? hair : skin); }
      if (k % 3 === 0) for (const lx of [0, 1]) for (const lz of [back, back + 1]) cell(lx, y + 2, lz, cloth(k * 3 + 8), SMALL);
    };
    if (k % 2 === 1) {
      for (let lx = -3; lx <= 4; lx++) for (const lz of [-1, 0]) for (const ly of [0, 1]) cell(lx, ly, lz, lx === -3 || lx === 4 ? CUT : mix(BARK, 0x6b4a2e, hash(lx, ly + lz, 130)));
      for (const lx of [0, 1]) {
        cell(lx, 2, -1, legs); cell(lx, 2, 0, legs); cell(lx, 2, 1, legs); cell(lx, 1, 1, legs); cell(lx, 0, 1, 0x3a2a1e); cell(lx, 0, 2, 0x3a2a1e);
        for (const lz of [-1, 0]) { cell(lx, 3, lz, body); cell(lx, 4, lz, body); }
      }
      for (const lx of [-1, 2]) { cell(lx, 4, 0, sleeve); cell(lx, 3, 0, sleeve); cell(lx, 3, 1, skin); }
      head(5, -1);
    } else {
      for (const lx of [0, 1])
        for (const lz of [0, 1]) { cell(lx, 0, lz, 0x3a2a1e); cell(lx, 1, lz, legs); cell(lx, 2, lz, legs); cell(lx, 3, lz, body); cell(lx, 4, lz, body); }
      for (const lx of [-1, 2]) { cell(lx, 4, 0, sleeve); cell(lx, 3, 0, sleeve); cell(lx, 2, 0, skin); }
      if (k % 4 === 0) for (const lx of [0, 1]) for (const ly of [2, 3, 4]) cell(lx, ly, -1, 0x7a6a44);
      head(5, 0);
    }
  });

  // ---------- the fire ----------
  const [ffx, ffz] = at(fire.x, fire.z), fi = Math.floor(ffx), fj = Math.floor(ffz), fy = top(fi, fj);
  for (let dj = -4; dj <= 4; dj++)
    for (let di = -4; di <= 4; di++) {
      const d = Math.hypot(di, dj);
      if (d > 3.4) continue;
      const gy = groundAt(fi + di, fj + dj);
      g.set(fi + di, gy, fj + dj, EARTH, jit(mix(0x2e2926, 0x5a524b, d / 3.4 + 0.3 * hash(di, dj, 131)), di, gy, dj, 0.1));
    }
  for (let k = 0; k < 13; k++) {
    const a = (k / 13) * 6.283 + hash(k, 1, 132) * 0.25, rr = 3.9 + hash(k, 2, 132) * 0.5;
    const si = Math.floor(ffx + Math.cos(a) * rr), sj = Math.floor(ffz + Math.sin(a) * rr), sy = top(si, sj), col = mix(0x958f86, 0x625e58, hash(k, 3, 132));
    put(si, sy, sj, SMALL, col, 0.12);
    if (hash(k, 4, 132) < 0.55) put(si, sy + 1, sj, SMALL, scale(col, 1.08), 0.12);
    if (hash(k, 5, 132) < 0.5) put(si + Math.round(Math.cos(a + 1.57)), sy, sj + Math.round(Math.sin(a + 1.57)), SMALL, scale(col, 0.92), 0.12);
  }
  for (let k = 0; k < 4; k++) {
    const a = k * 1.571 + 0.5;
    line([ffx + Math.cos(a) * 2.8, fy, ffz + Math.sin(a) * 2.8], [ffx + Math.cos(a) * 0.4, fy + 3.6, ffz + Math.sin(a) * 0.4], THING, k % 2 ? 0x4a2f1c : 0x2e231c);
  }
  for (let y = 0; y < 8; y++) {
    const rf = 2.3 * (1 - y / 8.5);
    for (let dj = -3; dj <= 3; dj++)
      for (let di = -3; di <= 3; di++) {
        const d = Math.hypot(di, dj);
        if (d > rf + 0.3 || hash(di * 7 + y, dj * 3, 133) < y * 0.07) continue;
        const t = y / 8 + d / 4.5;
        put(fi + di, fy + y, fj + dj, GLOW, t < 0.3 ? 0xffd868 : t < 0.55 ? 0xffa532 : t < 0.8 ? 0xff7a1e : 0xe0501a, 0.05);
      }
  }
  for (let k = 0; k < 3; k++) put(fi + Math.round((hash(k, 1, 134) - 0.5) * 7), fy + 9 + Math.round(k * 3 + hash(k, 5, 134) * 3), fj + Math.round((hash(k, 2, 134) - 0.5) * 7), GLOW, 0xffa040, 0.05);
  const wa = Math.atan2(W.isle.wind[1], W.isle.wind[0]);
  for (let k = 0; k < 11; k++) {
    // Smoke rises in puffs that drift downwind, grow and fade.
    const up = 13 + k * 2.6, drift = k * 1.1, px = ffx + Math.cos(wa) * drift + (hash(k, 3, 134) - 0.5) * 2, pz = ffz + Math.sin(wa) * drift + (hash(k, 4, 134) - 0.5) * 2, s = 1 + Math.floor(k / 4);
    for (let a = 0; a <= s; a++) for (let b = 0; b <= s; b++) for (let c = 0; c < 2; c++) g.add(Math.floor(px) + a, fy + Math.floor(up) + c, Math.floor(pz) + b, SMOKE, withAlpha(mix(0xe0ddd8, 0xb9b6b1, k / 11), 0.3 - k * 0.022));
  }
  lights.push({ x: ffx, y: fy + 2.5, z: ffz });

  // ---------- woodpile, chopping block ----------
  const [wx, wz] = at(C.woodpile.x, C.woodpile.z), wi = Math.floor(wx), wj = Math.floor(wz);
  const toward = Math.atan2(fire.z - C.woodpile.z, fire.x - C.woodpile.x), along = Math.abs(Math.cos(toward)) > Math.abs(Math.sin(toward)) ? [1, 0] : [0, 1], across = [along[1], along[0]];
  let wy = Infinity;
  for (let c = -4; c <= 4; c++) for (let s = 0; s < 5; s++) wy = Math.min(wy, top(wi + c * across[0] + s * along[0], wj + c * across[1] + s * along[1]));
  [7, 6, 5, 3].forEach((n, layer) => {
    for (let c = 0; c < n; c++)
      for (let s = 0; s < 5; s++) {
        const o = c - Math.floor(n / 2), end = s === 0 || s === 4;
        put(wi + o * across[0] + s * along[0], wy + layer, wj + o * across[1] + s * along[1], THING, end ? mix(0xd8b27a, 0xb88a52, hash(c, layer, 135)) : mix(0x5c3b22, 0x6e4a2a, hash(c, layer, 136)), 0.08);
      }
  });
  const bi = wi + across[0] * 6, bj = wj + across[1] * 6, by = top(bi, bj);
  for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) if (a * b === 0) for (let e = 0; e < 2; e++) put(bi + a, by + e, bj + b, THING, e === 1 ? CUT : BARK, 0.08);
  line([bi + 0.5, by + 2, bj + 0.5], [bi + 0.5 + along[0] * 2.5, by + 4.5, bj + 0.5 + along[1] * 2.5], THING, 0x7a5a36);
  put(bi, by + 2, bj, THING, 0x8c9096, 0.05);
  put(bi + across[0], by + 2, bj + across[1], THING, 0x6f7378, 0.05);

  // ---------- the ground's small stuff ----------
  // Grass grows in clumps of blades of mixed height where the grass cover is thick, worn short toward the fire;
  // flowers and pebbles come from world.js's scatter.
  const GREEN = [0x7fb842, 0x6aa53a, 0x93c24e, 0x5b9334, 0xa4c457];
  const FLOWER = [0xf6f2e6, 0xf2c93a, 0x9a6ad0, 0xe27aa8, 0x6f8ee8, 0xd9483a];
  for (let j = 1; j < nz - 1; j += 3)
    for (let i = 1; i < nx - 1; i += 3) {
      const ci = i + Math.floor(hash(i, j, 140) * 3), cj = j + Math.floor(hash(i, j, 141) * 3);
      if (!grassy(ci, cj)) continue;
      const x = x0 + (ci + 0.5) * vox, z = z0 + (cj + 0.5) * vox, gr = W.fine(W.cover.grass, x, z) + 0.5 * W.fine(W.cover.shrub, x, z) + 0.7 * W.fine(W.cover.marsh, x, z);
      const wear = smooth(4.5, 12, Math.hypot(x - fire.x, z - fire.z)), clump = noise(x / 3.2, z / 3.2, 142);
      if (hash(ci, cj, 143) > (0.03 + 0.3 * gr) * wear * clamp(0.2 + clump * 1.8, 0, 1.5)) continue;
      const blades = 2 + Math.floor(hash(ci, cj, 144) * 4), hmax = 1 + Math.floor(hash(ci, cj, 145) * (1 + 3 * wear));
      const base = mix(GREEN[Math.floor(hash(ci, cj, 146) * 5)], 0xb4b058, clamp(noise(x / 9, z / 9, 147), 0, 0.5)), tip = mix(base, 0xd8d47e, 0.35);
      const bloom = clump > 0.2 && hash(ci, cj, 148) < 0.2 ? FLOWER[Math.floor(hash(Math.floor(x / 3), Math.floor(z / 3), 149) * FLOWER.length)] : -1;
      for (let b = 0; b < blades; b++) {
        const bi2 = ci + Math.round((hash(ci + b, cj, 150) - 0.5) * 2.6), bj2 = cj + Math.round((hash(ci, cj + b, 151) - 0.5) * 2.6);
        if (!grassy(bi2, bj2)) continue;
        const h = Math.max(1, Math.round(hmax * (0.45 + 0.6 * hash(bi2, bj2, 152)))), y = top(bi2, bj2);
        for (let e = 0; e < h; e++) put(bi2, y + e, bj2, SMALL, e === h - 1 && h > 1 ? tip : scale(base, 0.9 + 0.06 * e), 0.12);
        if (b === 0 && bloom >= 0) put(bi2, y + h, bj2, SMALL, bloom, 0.06);
      }
    }
  const small = W.nearby({ x: x0 + S / 2, y: 0, z: z0 + S / 2 }, S * 0.72, 1.2);
  for (const f of small.flowers) {
    const [a, b] = at(f.x, f.z).map(Math.floor);
    if (!grassy(a, b)) continue;
    const y = top(a, b), h = Math.max(1, Math.round(f.tall * m));
    for (let e = 0; e < h; e++) put(a, y + e, b, SMALL, 0x5c9636, 0.1);
    put(a, y + h, b, SMALL, FLOWER[Math.floor(f.hue * FLOWER.length)], 0.06);
    if (f.tall > 0.4) for (const [p, q] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) if (hash(a + p, b + q, 153) < 0.5) put(a + p, y + h, b + q, SMALL, FLOWER[Math.floor(f.hue * FLOWER.length)], 0.1);
  }
  for (const p of small.pebbles) {
    const [a, b] = at(p.x, p.z).map(Math.floor);
    if (!inside(a, b) || T.waterTop[b * nx + a] >= 0) continue;
    const n = Math.max(1, Math.round(p.size * m * 0.8)), col = mix(0x9a968f, 0x6f6b66, p.tint), y = top(a, b);
    for (let u = 0; u < n; u++) for (let w = 0; w < n; w++) put(a + u, y, b + w, SMALL, scale(col, 0.9 + 0.2 * hash(u, w, 154)), 0.1);
    if (n > 2) put(a + 1, y + 1, b + 1, SMALL, col, 0.1);
  }
  for (const l of small.logs) {
    const [a, b] = at(l.x, l.z), y = top(Math.floor(a), Math.floor(b)), len = l.length * m;
    for (const o of [0, 1]) line([a, y + o, b], [a + Math.cos(l.yaw) * len, y + o, b + Math.sin(l.yaw) * len], THING, BARK);
  }
}
