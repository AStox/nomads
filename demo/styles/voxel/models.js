// Everything standing on the ground, built from cubes of the same size as the ground's: trees, bushes, rocks, clouds
// over the island, and the camp as a handful of cubes in the valley (camp.js builds it close up).
import { COLORS } from "../island.js";
import { clamp, hash } from "../world.js";
import { GLOW, SMALL, THING } from "./grid.js";
import { CAP, jit, mix, scale } from "./terrain.js";
import { campScene } from "./camp.js";

const hex = (s) => parseInt(s.slice(1), 16);
// Smooth 3D value noise, 0..1, for foliage that clumps instead of speckling.
function clumps(x, y, z) {
  const X = Math.floor(x), Y = Math.floor(y), Z = Math.floor(z), u = x - X, v = y - Y, w = z - Z;
  const s = (t) => t * t * (3 - 2 * t), h = (a, b, c) => hash(a * 7 + c * 131, b, 97);
  const l = (a, b, t) => a + (b - a) * s(t);
  return l(l(l(h(X, Y, Z), h(X + 1, Y, Z), u), l(h(X, Y + 1, Z), h(X + 1, Y + 1, Z), u), v), l(l(h(X, Y, Z + 1), h(X + 1, Y, Z + 1), u), l(h(X, Y + 1, Z + 1), h(X + 1, Y + 1, Z + 1), u), v), w);
}

export function models(W, g, V, T) {
  const { vox, ex, x0, z0, nx, nz, yBase } = V;
  const toI = (x) => Math.floor((x - x0) / vox), toJ = (z) => Math.floor((z - z0) / vox);
  const inside = (i, j) => i >= 0 && j >= 0 && i < nx && j < nz;
  const groundAt = (i, j) => (inside(i, j) ? T.ground[j * nx + i] : Math.round((W.heightAt(x0 + (i + 0.5) * vox, z0 + (j + 0.5) * vox) * ex - yBase) / vox) - 1);
  const wetAt = (i, j) => inside(i, j) && T.waterTop[j * nx + i] >= 0;
  const near = (x, z, m) => x > x0 - m && z > z0 - m && x < x0 + nx * vox + m && z < z0 + nz * vox + m;
  const put = (i, y, j, kind, col, amt = 0.16) => g.add(i, y, j, kind, jit(col, i, y, j, amt, 3));
  const out = { lights: [] };

  // Leafy blobs: a few overlapping spheres, their edges nibbled by per-voxel noise, or by clump noise close up.
  function blobs(list, colorAt, kind = THING, amt = 0.2, clump = 0) {
    let lo = [1e9, 1e9, 1e9], hi = [-1e9, -1e9, -1e9];
    for (const b of list) for (let a = 0; a < 3; a++) { lo[a] = Math.min(lo[a], Math.floor(b.c[a] - b.r[a] * 1.3 - 1)); hi[a] = Math.max(hi[a], Math.ceil(b.c[a] + b.r[a] * 1.3 + 1)); }
    for (let y = lo[1]; y <= hi[1]; y++)
      for (let j = lo[2]; j <= hi[2]; j++)
        for (let i = lo[0]; i <= hi[0]; i++) {
          let best = 9;
          for (const b of list) {
            const dx = (i + 0.5 - b.c[0]) / b.r[0], dy = (y + 0.5 - b.c[1]) / b.r[1], dz = (j + 0.5 - b.c[2]) / b.r[2];
            best = Math.min(best, dx * dx + dy * dy + dz * dz);
          }
          const nib = clump ? 0.45 + 0.95 * clumps(i / clump, y / clump, j / clump) + 0.12 * hash(i * 17 + y, j * 29, 41) : 0.78 + 0.4 * hash(i * 17 + y, j * 29 + y * 3, 41);
          if (best < nib) put(i, y, j, kind, colorAt(i, y, j, best), amt);
        }
  }
  const line = (a, b, kind, col) => {
    const n = Math.ceil(Math.max(Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1]), Math.abs(b[2] - a[2]))) + 1;
    for (let k = 0; k <= n; k++) put(Math.floor(a[0] + ((b[0] - a[0]) * k) / n), Math.floor(a[1] + ((b[1] - a[1]) * k) / n), Math.floor(a[2] + ((b[2] - a[2]) * k) / n), kind, col, 0.12);
  };

  function tree(t) {
    const ci = toI(t.x), cj = toJ(t.z);
    if (wetAt(ci, cj)) return;
    const base = groundAt(ci, cj) + 1, H = Math.max(3, t.tall / vox), big = H > 18;
    const fx = (t.x - x0) / vox, fz = (t.z - z0) / vox;
    const r = (k) => hash(Math.floor(t.x * 13), Math.floor(t.z * 17), k);
    if (t.kind === "pine") {
      const top = base + Math.round(H), cb = base + Math.max(1, Math.round(H * 0.2)), R = Math.max(1.3, H * 0.28), th = Math.max(2, Math.round(H / 4.2));
      const needle = mix(mix(0x2f5b3b, 0x2a4f4a, t.tint), 0x3f6c3c, r(1) * 0.5);
      for (let y = base; y < top - 1; y++) put(ci, y, cj, THING, 0x5a3b27, 0.1);
      for (let y = cb; y <= top; y++) {
        const f = (y - cb) / Math.max(1, top - cb), phase = ((y - cb) % th) / th;
        const rr = y === top ? 0 : R * (1 - f) * (1 - 0.42 * phase) + 0.35;
        const n = Math.ceil(rr);
        for (let dz = -n; dz <= n; dz++)
          for (let dx = -n; dx <= n; dx++) {
            const d2 = dx * dx + dz * dz;
            if (d2 > rr * rr + 0.3) continue;
            if (d2 > (rr - 1) * (rr - 1) && hash(ci + dx, y * 7 + dz, 43) < 0.18) continue;
            put(ci + dx, y, cj + dz, THING, scale(needle, 0.82 + 0.3 * f + 0.1 * phase), 0.18);
          }
      }
      return;
    }
    const aspen = t.kind === "aspen", oak = t.kind === "oak";
    const bark = aspen ? 0xd6d1c2 : oak ? 0x5e4129 : 0x6f6250;
    const trunkTop = base + Math.round(H * (aspen ? 0.55 : 0.5));
    const w = big && !aspen ? 2 : 1;
    for (let y = base; y <= trunkTop; y++)
      for (let a = 0; a < w; a++)
        for (let b = 0; b < w; b++) put(ci + a, y, cj + b, THING, aspen && hash(ci, y, 44) < 0.3 ? 0x3a3835 : bark, 0.1);
    if (big && !aspen) for (const [a, b] of [[-1, 0], [2, 1], [0, 2], [1, -1]]) put(ci + a, base, cj + b, THING, bark, 0.12);
    const cy = base + H * (aspen ? 0.68 : 0.64);
    let leaf, list;
    if (aspen) {
      const gold = t.tint > 0.86;
      leaf = gold ? mix(0xd9b43e, 0xe39a36, r(2)) : mix(0x8fb93a, 0xb3cd4d, t.tint * 1.2);
      const rx = Math.max(1.1, H * 0.18), ry = Math.max(1.4, H * 0.33);
      list = [{ c: [fx, cy, fz], r: [rx, ry, rx] }, { c: [fx + (r(3) - 0.5) * rx, cy + ry * 0.35, fz + (r(4) - 0.5) * rx], r: [rx * 0.75, ry * 0.6, rx * 0.75] }];
    } else {
      const R = Math.max(1.3, H * (oak ? 0.4 : 0.35));
      leaf = oak ? mix(0x3b7128, 0x55892f, t.tint) : mix(0x5b9a3b, 0x78a843, t.tint);
      list = [{ c: [fx, cy, fz], r: [R * 0.85, R * 0.72, R * 0.85] }];
      const n = 3 + Math.floor(R / 3);
      for (let k = 0; k < n; k++) {
        const a = t.yaw + (k / n) * 6.283 + r(10 + k), d = R * (0.45 + 0.25 * r(20 + k));
        list.push({ c: [fx + Math.cos(a) * d, cy + (r(30 + k) - 0.35) * R * 0.5, fz + Math.sin(a) * d], r: [R * 0.62, R * 0.55, R * 0.62] });
      }
      if (big) for (const b of list.slice(1)) line([ci + 0.5, trunkTop, cj + 0.5], b.c, THING, bark);
    }
    const lo = cy - H * 0.3, span = H * 0.6;
    blobs(list, (i, y, j) => scale(leaf, 0.8 + 0.35 * clamp((y - lo) / span, 0, 1) + (hash(i, y * 3, j) < 0.08 ? 0.2 : 0)), THING, 0.2, vox < 1 ? 2.6 : 0);
  }

  function bush(s) {
    const ci = toI(s.x), cj = toJ(s.z);
    if (wetAt(ci, cj)) return;
    const R = s.tall * 0.6 / vox;
    if (R < 0.45 && hash(ci, cj, 45) > R * 2) return;
    const base = groundAt(ci, cj) + 1, rr = Math.max(0.55, R), ry = Math.max(0.55, R * 0.75);
    const col = s.heath > 0.5 ? mix(0x6f5a5d, 0x8e5f86, s.tint) : mix(0x4a7a30, 0x6a8f38, s.tint);
    const berry = s.heath > 0.5 ? 0xc9a0d8 : s.tint > 0.6 ? 0xc0392f : 0xf2eee0;
    blobs([{ c: [(s.x - x0) / vox, base + ry * 0.55, (s.z - z0) / vox], r: [rr, ry, rr] }], (i, y, j) => (vox < 1 && hash(i, y, j + 5) < 0.07 ? berry : scale(col, 0.85 + 0.25 * (y - base) / (ry * 2 + 0.01))));
  }

  function rock(k) {
    const ci = toI(k.x), cj = toJ(k.z);
    if (wetAt(ci, cj)) return;
    const R = k.size * 0.5 / vox;
    if (R < 0.4) return;
    const base = groundAt(ci, cj) + 1, rr = Math.max(0.55, R), ry = Math.max(0.55, R * 0.62);
    const col = mix(0x938f88, 0x6e6b67, k.tint);
    blobs([{ c: [(k.x - x0) / vox, base - 0.2 + ry * 0.35, (k.z - z0) / vox], r: [rr * 1.1, ry, rr * 0.9] }], (i, y, j) => (vox < 1 && y > base + ry * 0.4 && hash(i, y, j) < 0.3 ? 0x8f9a52 : col), THING);
  }

  if (V.name === "island") {
    // At 25 m a cube is a stand of trees: each column holds the trees that grow in it, counted by kind.
    const cnt = new Uint16Array(nx * nz), kinds = new Uint16Array(nx * nz * 4), rocks = new Float32Array(nx * nz);
    const KI = { pine: 0, oak: 1, ash: 2, aspen: 3 };
    for (const t of W.trees) {
      const i = toI(t.x), j = toJ(t.z);
      if (!inside(i, j)) continue;
      cnt[j * nx + i]++;
      kinds[(j * nx + i) * 4 + KI[t.kind]]++;
    }
    for (const k of W.rocks) { const i = toI(k.x), j = toJ(k.z); if (inside(i, j)) rocks[j * nx + i] += k.size; }
    const LEAF = [0x22473a, 0x2e5e25, 0x3f7a30, 0x6c9a34];
    for (let j = 0; j < nz; j++)
      for (let i = 0; i < nx; i++) {
        const c = j * nx + i, n = cnt[c];
        if (T.waterTop[c] >= 0) continue;
        const y = T.ground[c] + 1;
        if (n >= 2 + 2 * hash(i, j, 46)) {
          let kbest = 0;
          for (let k = 1; k < 4; k++) if (kinds[c * 4 + k] > kinds[c * 4 + kbest]) kbest = k;
          const col = mix(LEAF[kbest], LEAF[Math.floor(hash(i, j, 47) * 4)], 0.25);
          put(i, y, j, THING, scale(col, 0.85 + 0.3 * hash(i, j, 48)), 0.2);
          if (n >= 7 && hash(i, j, 49) < (kbest === 0 ? 0.8 : 0.35)) put(i, y + 1, j, THING, scale(col, 1.08), 0.2);
        } else if (rocks[c] > 6 + 6 * hash(i, j, 50)) put(i, y, j, THING, mix(0x8d877f, 0x6c6863, hash(i, j, 51)), 0.12);
      }
    // Clouds pile up over the wet high ground, a few voxel puffs floating above the slab.
    let peak = 0;
    for (const v of T.ground) peak = Math.max(peak, v);
    const { isle, N: NC, CELL, START } = W, picks = [];
    const cand = [];
    for (let j = 4; j < NC - 4; j++) for (let i = 4; i < NC - 4; i++) { const k = j * NC + i; if (isle.height[k] > 20) cand.push([isle.precip[k] * (0.5 + isle.height[k] / 300) + isle.fog[k] + 0.3 * hash(i, j, 64), i, j]); }
    cand.sort((a, b) => b[0] - a[0]);
    for (const [, i, j] of cand) if (picks.length < 4 && picks.every(([a, b]) => Math.hypot(a - i, b - j) > 30)) picks.push([i, j]);
    const [wx, wz] = W.isle.wind;
    picks.forEach(([ci, cj], k) => {
      // Flat stacked layers, streaked out along the wind and blown off the high ground, like a MagicaVoxel cloud.
      const x = (START + ci * CELL - x0) / vox + wx * 40, z = (START + cj * CELL - z0) / vox + wz * 40, y0 = Math.round(peak + 7 + 5 * hash(k, 1, 65)), R = 9 + 6 * hash(k, 2, 65);
      const a = Math.atan2(wz, wx) + (hash(k, 3, 65) - 0.5) * 0.6, ux = Math.cos(a), uz = Math.sin(a);
      const lobes = [[0, 0, 1], [1.1, 0.25, 0.78], [-1.05, -0.2, 0.72], [2.0, 0.1, 0.5], [-1.9, 0.3, 0.45], [0.4, -0.6, 0.55]];
      const layers = [[0, 1, 1], [1, 1, 0.66]];
      for (const [dy, thick, s] of layers)
        for (let j = Math.floor(z - R * 3); j <= z + R * 3; j++)
          for (let i = Math.floor(x - R * 3); i <= x + R * 3; i++) {
            const di = i + 0.5 - x, dj = j + 0.5 - z, along = (di * ux + dj * uz) / R, across = (-di * uz + dj * ux) / R;
            let inn = -1;
            for (const [p, q, r] of lobes) inn = Math.max(inn, r * s - Math.hypot(along - p * s, (across - q * s) * 1.4));
            if (inn < 0 || (inn * R < 1 && hash(i, j, 68 + dy) < 0.45)) continue;
            for (let e = 0; e < thick; e++) g.add(i, y0 + dy + e, j, SMALL, jit(dy === 0 ? 0xe3e9ef : 0xfafbfc, i, y0 + dy + e, j, 0.03));
          }
    });
    return out;
  }

  const m = V.name === "camp" ? 12 : 6;
  for (const t of W.trees) if (near(t.x, t.z, m)) tree(t);
  for (const s of W.shrubs) if (near(s.x, s.z, 2)) bush(s);
  for (const k of W.rocks) if (near(k.x, k.z, 2)) rock(k);
  if (V.name === "camp") {
    campScene(W, g, V, T, { put, blobs, line, tree, bush, groundAt, toI, toJ, inside, lights: out.lights });
    return out;
  }

  // ---------- the camp as the valley sees it: a handful of cubes ----------
  const C = W.camp, fire = C.fire;
  const fi = toI(fire.x), fj = toJ(fire.z), fy = groundAt(fi, fj) + 1;
  const CANVAS = [0xd9c69a, 0xcc5a3a, 0x3f8898];
  C.tents.forEach((tent, k) => {
    const S = tent.size, L = S / vox, Wd = S / vox, Ht = (S * 0.75) / vox;
    const sy = Math.sin(tent.yaw), cyw = Math.cos(tent.yaw), cx = (tent.at.x - x0) / vox, cz = (tent.at.z - z0) / vox;
    const base = groundAt(Math.floor(cx), Math.floor(cz)) + 1, R = Math.ceil(Math.max(L, Wd)) + 1;
    for (let y = base; y <= base + Math.ceil(Ht) + 1; y++)
      for (let j = Math.floor(cz - R); j <= cz + R; j++)
        for (let i = Math.floor(cx - R); i <= cx + R; i++) {
          const dx = i + 0.5 - cx, dz = j + 0.5 - cz, ly = y - base + 0.5;
          const lz = dx * sy + dz * cyw, lx = dx * cyw - dz * sy;
          if (Math.abs(lz) <= L / 2 && ly >= 0 && ly <= Ht * (1 - Math.abs(lx) / (Wd / 2))) put(i, y, j, THING, CANVAS[k % 3], 0.07);
        }
  });
  C.people.forEach((p, k) => put(toI(p.at.x), groundAt(toI(p.at.x), toJ(p.at.z)) + 1, toJ(p.at.z), THING, scale(hex(COLORS[[1, 2, 6, 0, 8][k % 5]]), 1.35), 0.05));
  put(fi, fy, fj, GLOW, 0xffb040);
  out.lights.push({ x: fi + 0.5, y: fy + 1.2, z: fj + 0.5 });
  put(toI(C.woodpile.x), groundAt(toI(C.woodpile.x), toJ(C.woodpile.z)) + 1, toJ(C.woodpile.z), SMALL, 0x6b4a2e);

  // Undergrowth: ferns and saplings fill the floor wherever the tree cover is thick.
  for (let j = 0; j < nz; j++)
    for (let i = 0; i < nx; i++) {
      const c = j * nx + i;
      if (T.waterTop[c] >= 0 || T.cap[c] === CAP.trodden) continue;
      const x = x0 + (i + 0.5) * vox, z = z0 + (j + 0.5) * vox, tr = W.fine(W.cover.tree, x, z), sh = W.fine(W.cover.shrub, x, z);
      if (hash(i, j, 61) > Math.max(0, tr - 0.2) * 0.22 + sh * 0.05 || g.get(i, T.ground[c] + 1, j) !== 0) continue;
      const col = mix(0x3d6a2b, 0x5d8a34, hash(i, j, 62)), R = 0.6 + hash(i, j, 63) * 0.8;
      blobs([{ c: [i + 0.5, T.ground[c] + 1 + R * 0.4, j + 0.5], r: [R, R * 0.8, R] }], (a, y, b) => scale(col, 0.9 + 0.15 * hash(a, y, b)), SMALL);
    }
  return out;
}
