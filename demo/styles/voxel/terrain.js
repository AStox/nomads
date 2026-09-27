// The ground as columns of cubes: a cap chosen from the cover fields, dirt, banded stone and bedrock under it, and
// water filling sea, lakes and streams up to their level. The slab edges cut straight through all of it.
import { clamp, fbm, hash, noise } from "../world.js";
import { EARTH, WATER } from "./grid.js";

export function mix(a, b, t) {
  t = clamp(t, 0, 1);
  const r = ((a >>> 16) & 255) * (1 - t) + ((b >>> 16) & 255) * t;
  const g = ((a >>> 8) & 255) * (1 - t) + ((b >>> 8) & 255) * t;
  const bl = (a & 255) * (1 - t) + (b & 255) * t;
  return ((r & 255) << 16) | ((g & 255) << 8) | (bl & 255);
}
export function scale(c, f) {
  const r = Math.min(255, ((c >>> 16) & 255) * f), g = Math.min(255, ((c >>> 8) & 255) * f), b = Math.min(255, (c & 255) * f);
  return ((r & 255) << 16) | ((g & 255) << 8) | (b & 255);
}
// Per-voxel color noise: a brightness wobble and a slight warm/cool drift, so no two cubes are quite the same.
export function jit(c, x, y, z, amt = 0.12, s = 1) {
  const h = hash(x * 73 + z * 9157, y, s), k = hash(x * 31 + z * 5003, y, s + 9) - 0.5;
  const f = 1 + (h - 0.5) * amt;
  const r = clamp(((c >>> 16) & 255) * f * (1 + k * amt * 0.35), 0, 255), g = clamp(((c >>> 8) & 255) * f, 0, 255), b = clamp((c & 255) * f * (1 - k * amt * 0.35), 0, 255);
  return ((r & 255) << 16) | ((g & 255) << 8) | (b & 255);
}
export const withAlpha = (c, a) => ((Math.round(a * 255) << 24) | (c & 0xffffff)) >>> 0;

const STONE = [0x9b8f7e, 0x7d766e, 0xb09a78, 0x68615b, 0xa37e62, 0x8a8a84, 0xc2b08e, 0x5f5a57, 0x94806a];
export const CAP = { meadow: 0, forest: 1, heath: 2, marsh: 3, rock: 4, sand: 5, snow: 6, seabed: 7, lakebed: 8, trodden: 9, riverbed: 10 };

export function terrain(W, g, V) {
  const { vox, ex, x0, z0, nx, nz, yBase } = V;
  const { isle, N, CELL, START, cover } = W;
  const vy = (m) => (m * ex - yBase) / vox;
  const ground = new Int16Array(nx * nz), waterTop = new Int16Array(nx * nz).fill(-1), cap = new Uint8Array(nx * nz);
  const level = (x, z) => {
    const i0 = Math.floor((x - START) / CELL), j0 = Math.floor((z - START) / CELL);
    let L = -Infinity;
    for (let dj = 0; dj <= 1; dj++)
      for (let di = 0; di <= 1; di++) {
        const k = clamp(j0 + dj, 0, N - 1) * N + clamp(i0 + di, 0, N - 1);
        if (isle.water[k] > 0) L = Math.max(L, isle.height[k] + isle.water[k]);
      }
    return L;
  };
  const riverHere = (x, z) => {
    if (vox < 10) return W.riverAt(x, z);
    let r = 0;
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) r = Math.max(r, W.riverAt(x + a * vox * 0.33, z + b * vox * 0.33));
    return r;
  };
  const camp = W.camp, fire = camp.fire;
  // Worn ground: round the fire, under the tents and woodpile, and the paths people walk between them.
  const walks = [...camp.tents.map((t) => t.at), camp.woodpile];
  const toSeg = (x, z, a) => {
    const vx = a.x - fire.x, vz = a.z - fire.z, t = clamp(((x - fire.x) * vx + (z - fire.z) * vz) / (vx * vx + vz * vz), 0, 1);
    return Math.hypot(x - fire.x - vx * t, z - fire.z - vz * t);
  };
  // And one path out toward the nearest water, where they go to fetch it.
  let wa = 0, wr = Infinity;
  for (let d = 0; d < 32; d++) {
    const a = (d / 32) * Math.PI * 2;
    for (let r = 8; r < Math.min(wr, 600); r += 6)
      if (W.fine(W.wet, fire.x + Math.cos(a) * r, fire.z + Math.sin(a) * r) > 0.5 || W.riverAt(fire.x + Math.cos(a) * r, fire.z + Math.sin(a) * r) > 0.5) { wr = r; wa = a; break; }
  }
  const ux = Math.cos(wa), uz = Math.sin(wa), pw = Math.max(0.6, vox * 0.55);
  const toWater = (x, z) => {
    const t = (x - fire.x) * ux + (z - fire.z) * uz;
    return t > 3 && t < wr ? Math.abs((x - fire.x) * -uz + (z - fire.z) * ux - 3.5 * noise(t / 26, 0.5, 81)) : Infinity;
  };
  const trodden = (x, z) =>
    Math.hypot(x - fire.x, z - fire.z) < 3.4 + 0.9 * noise(x / 1.6, z / 1.6, 83) || Math.hypot(x - camp.woodpile.x, z - camp.woodpile.z) < 1.5 || camp.tents.some((t) => Math.hypot(x - t.at.x, z - t.at.z) < t.size * 0.66) ||
    walks.some((a) => toSeg(x, z, a) < 0.55 + 0.35 * noise(x / 3, z / 3, 80)) || toWater(x, z) < pw + 0.3 * noise(x / 3, z / 3, 82);
  const bandH = V.bandH, dirtD = V.dirt;
  // Rock layers of uneven thickness, so the cut faces read as strata rather than stripes.
  const layer = new Uint16Array(512);
  for (let y = 0, k = 0; y < 512; k++) for (let t = Math.max(1, Math.round(bandH * (0.5 + 1.3 * hash(k, 5, 76)))); t > 0 && y < 512; t--) layer[y++] = k;

  for (let j = 0; j < nz; j++)
    for (let i = 0; i < nx; i++) {
      const c = j * nx + i, x = x0 + (i + 0.5) * vox, z = z0 + (j + 0.5) * vox;
      const h = W.heightAt(x, z);
      let gy = clamp(Math.round(vy(h)) - 1, 3, g.ny - 3);
      const L = level(x, z), sea = L > -1 && L < 0.01;
      let wt = L > -1e8 ? Math.min(Math.round(vy(L)) - 1, g.ny - 2) : -1;
      let kind;
      const river = wt <= gy ? riverHere(x, z) : 0;
      if (river > 0.45) {
        const top = vox < 1 ? Math.floor(vy(h + 1.1 * river)) : gy;
        if (top <= gy) gy = top - 1;
        wt = Math.max(wt, top);
        kind = CAP.riverbed;
      }
      const under = wt > gy, depth = under ? (wt - gy) * vox / ex : 0;
      const cx = (x - START) / CELL, cy = (z - START) / CELL;
      const moist = W.fine(W.moist, x, z);
      if (kind === undefined) {
        if (under) kind = sea ? (depth < 6 * (vox < 10 ? 1 : 3) ? CAP.sand : CAP.seabed) : CAP.lakebed;
        else if (V.camp && trodden(x, z)) kind = CAP.trodden;
        else {
          const snow = W.bilinear(isle.snow, cx, cy), slope = W.slopeAt(x, z);
          const wob = (k) => 0.16 * (hash(i, j, 11 + k) - 0.5) + 0.1 * noise(x / (vox * 9 + 30), z / (vox * 9 + 30), 50 + k);
          const beach = L > -1e8 && sea && h < 2.4 ? 0.7 : 0;
          const score = [
            W.fine(cover.grass, x, z) + wob(0),
            W.fine(cover.tree, x, z) + wob(1),
            W.fine(cover.shrub, x, z) + wob(2),
            W.fine(cover.marsh, x, z) + wob(3),
            W.fine(cover.bare, x, z) + slope * 0.5 + wob(4),
            W.fine(cover.sand, x, z) + beach + wob(5),
          ];
          kind = score.indexOf(Math.max(...score));
          if (snow > 0.1 + 0.02 * hash(i, j, 3) && h > 220) kind = CAP.snow;
        }
      }
      ground[c] = gy;
      waterTop[c] = under ? wt : -1;
      cap[c] = kind;

      // ---- colors of the column ----
      const tone = fbm(x / 90, z / 90, 21, 2);
      let top;
      switch (kind) {
        case CAP.meadow: {
          top = mix(mix(0xb0b04c, 0x74a83f, moist * 1.1 + tone * 0.5), 0x8cb449, 0.25 + 0.2 * noise(x / 23, z / 23, 4));
          const s = vox > 1 && vox < 10 ? hash(i, j, 22) : 1;
          if (s < 0.03) top = [0xf4efe0, 0xf0c63c, 0xa274c9, 0xe0849f][Math.floor(hash(i, j, 23) * 4)];
          else if (s < 0.16) top = mix(top, 0x5e8f33, 0.45);
          else if (s < 0.26) top = mix(top, 0xb9c25a, 0.35);
          break;
        }
        case CAP.forest: top = mix(0x4c6e2b, 0x62633a, 0.5 + tone); break;
        case CAP.heath: {
          const heath = clamp(W.bilinear(isle.exposure, cx, cy) * 1.4 + W.fine(cover.shrub, x, z) - moist * 0.3, 0, 1);
          top = mix(0x7a8b41, 0x8b6177, heath * (0.6 + 0.5 * hash(i, j, 8)));
          break;
        }
        case CAP.marsh: top = mix(0x5c7747, 0x6f7a3a, tone + 0.5); break;
        case CAP.rock: top = h < 3 && hash(i, j, 24) < 0.55 ? mix(0xd9c690, 0xc9b27e, hash(i, j, 25)) : mix(0x9a948a, 0x7f796f, hash(i, j, 12)); break;
        case CAP.sand: top = mix(0xe3cf95, 0xd4bd82, hash(i, j, 13)); break;
        case CAP.snow: top = 0xf1f4f7; break;
        case CAP.seabed: top = mix(0x9c9676, 0x767a68, clamp(depth / 50, 0, 1)); break;
        case CAP.lakebed: top = 0x76704f; break;
        case CAP.trodden: top = mix(0x8e7150, 0x7b6246, hash(i, j, 14)); break;
        case CAP.riverbed: top = mix(0x8c8778, 0xa59c83, hash(i, j, 15)); break;
      }
      const sandy = kind === CAP.sand || kind === CAP.seabed || kind === CAP.riverbed;
      // At camp scale the turf sits under the tufts: darker, dithered, so the tufts read against it.
      if (vox < 1 && (kind === CAP.meadow || kind === CAP.heath || kind === CAP.forest || kind === CAP.marsh)) {
        const s = hash(i, j, 26);
        top = mix(scale(top, 0.84), 0x4d7a2e, 0.3);
        top = s < 0.18 ? mix(top, 0x3f6a28, 0.4) : s > 0.84 ? mix(top, 0xa9b650, 0.35) : top;
      }
      const dirt = Math.max(1, Math.round(dirtD + (dirtD > 1 ? 1.2 * noise(i / 14, j / 14, 60) : 0)));
      const wav = V.wave * noise(i / 21, j / 21, 70) + V.wave * 0.5 * noise(i / 7, j / 7, 71);
      const bed = 2 + (hash(i, j, 16) < 0.45 ? 1 : 0);
      const deep = vox < 1 ? 1.5 : vox < 10 ? 5 : 45, t = clamp(depth / deep, 0, 1);
      if (under) top = mix(top, sea ? 0x2a8aa0 : 0x3f7a6a, 0.3 + 0.5 * t);
      for (let y = 0; y <= gy; y++) {
        const d = gy - y;
        let col;
        if (y < bed) col = mix(0x2c292b, 0x3d3638, hash(i * 7 + y, j, 17));
        else if (d === 0) col = top;
        else if (d <= dirt) {
          if (sandy) col = mix(0xd9c38a, 0xc4a977, d / (dirt + 1));
          else if (kind === CAP.rock || kind === CAP.snow) col = mix(0x8a847a, 0x6f6a63, hash(i, y, j));
          else col = mix(0x7e5838, 0x62432c, d / (dirt + 1));
        } else {
          col = STONE[Math.floor(hash(layer[clamp(Math.floor(y + wav), 0, 511)], 3, 77) * STONE.length)];
          const s = hash(i * 13 + y, j * 7 + y, 18);
          if (s < 0.05) col = scale(col, 0.78);
          else if (s > 0.96) col = scale(col, 1.16);
        }
        g.set(i, y, j, EARTH, jit(col, i, y, j, d === 0 ? 0.14 : 0.1));
      }
      if (under) {
        const lake = !sea && kind !== CAP.riverbed;
        for (let y = gy + 1; y <= wt; y++) {
          const below = (wt - y) / Math.max(1, wt - gy);
          let col = lake ? mix(0x4fb3a6, 0x1f6178, t) : mix(0x36b3cf, 0x164f8f, t);
          col = mix(col, 0x174a80, below * 0.35);
          if (y === wt && (hash(i, j, 20) < 0.07 || Math.sin((i + j) * 0.42 + 4 * noise(i / 11, j / 11, 21)) > 0.94)) col = mix(col, 0xffffff, 0.28);
          const a = 0.46 + 0.4 * t + 0.1 * below;
          g.set(i, y, j, WATER, withAlpha(jit(col, i, y, j, 0.07, 5), a));
        }
      }
    }
  // Foam where the surface meets the shore.
  for (let j = 0; j < nz; j++)
    for (let i = 0; i < nx; i++) {
      const c = j * nx + i, wt = waterTop[c];
      if (wt < 0) continue;
      let shore = 0;
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const ii = i + di, jj = j + dj;
        if (ii >= 0 && jj >= 0 && ii < nx && jj < nz && g.get(ii, wt, jj) === EARTH) shore++;
      }
      if (shore && hash(i, j, 19) < 0.75) g.set(i, wt, j, WATER, withAlpha(jit(0xd8f0f2, i, wt, j, 0.08), 0.8));
    }
  return { ground, waterTop, cap };
}
