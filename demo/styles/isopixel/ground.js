// The drawn ground of every level, worked out on the page as the GPU lays it out (webgpu.js TILES_WGSL, VERTS_WGSL,
// MAP_READ), so the camera, the people's feet and the picks stand on the ground the frame shows. From the worker's
// fields: the fine heights and the cells' heights and standing water.
import { waterAt, M, STEP, START, CELL, N } from "../island.js";

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const OFFS = [[0.5, 0.5], [0.22, 0.5], [0.78, 0.5], [0.5, 0.22], [0.5, 0.78]];

export function createGround({ h, height, water }) {
  const isle = { height, water };
  // flora.ts fineGround's heightAt: the fine grid read between its texels
  const heightAt = (x, z) => {
    const fu = clamp((x - START) / STEP, 0, M - 1.001), fv = clamp((z - START) / STEP, 0, M - 1.001), u = Math.floor(fu), v = Math.floor(fv), tu = fu - u, tv = fv - v, i = v * M + u;
    return (h[i] * (1 - tu) + h[i + 1] * tu) * (1 - tv) + (h[i + M] * (1 - tu) + h[i + M + 1] * tu) * tv;
  };
  const g = { heightAt };
  // main.js buildMap's surfAt: the surface of the nearest water cell within two, 0 if none
  const surfAt = (x, z) => {
    const cx = Math.round((x - START) / CELL), cy = Math.round((z - START) / CELL);
    let best = 0, bd = Infinity;
    for (let dy = -2; dy <= 2; dy++)
      for (let dx = -2; dx <= 2; dx++) {
        const X = cx + dx, Y = cy + dy;
        if (X < 0 || Y < 0 || X >= N || Y >= N || water[Y * N + X] <= 0) continue;
        if (dx * dx + dy * dy < bd) { bd = dx * dx + dy * dy; best = height[Y * N + X] + water[Y * N + X]; }
      }
    return best;
  };
  const caches = new Map();
  const cacheOf = (grid) => {
    let c = caches.get(grid.key);
    if (!c || c.t.size + c.v.size > 400000) caches.set(grid.key, (c = { t: new Map(), v: new Map() }));
    return c;
  };
  // a tile of `grid` ({ key, levelM, toW(u, v) }): [kind 0 land, 1 sea, 2 lake; its water's level]
  function tile(grid, i, j) {
    const c = cacheOf(grid), key = i * 1048576 + j;
    let t = c.t.get(key);
    if (t) return t;
    let wet = 0;
    for (const [a, b] of OFFS) wet += waterAt(isle, g, ...grid.toW(i + a, j + b));
    wet /= 5;
    const [x, z] = grid.toW(i + 0.5, j + 0.5);
    if (wet > 0.45 || (wet > 0.1 && heightAt(x, z) < -0.5)) { const s = surfAt(x, z); t = [s > 0.5 ? 2 : 1, s / grid.levelM]; }
    else t = [0, 0];
    c.t.set(key, t);
    return t;
  }
  function vertex(grid, i, j) {
    const c = cacheOf(grid), key = i * 1048576 + j;
    let v = c.v.get(key);
    if (v !== undefined) return v;
    v = heightAt(...grid.toW(i, j)) / grid.levelM;
    let wet = false, fl = 0;
    for (let b = j - 1; b <= j; b++) for (let a = i - 1; a <= i; a++) { const t = tile(grid, a, b); if (t[0]) { fl = wet ? Math.max(fl, t[1]) : t[1]; wet = true; } }
    if (wet) v = fl;
    v = Math.max(0, v);
    c.v.set(key, v);
    return v;
  }
  // the drawn ground's level at grid point (u, v), on the triangles its tile is drawn with; and whether it is water
  function ground(grid, u, v) {
    const i = Math.floor(u), j = Math.floor(v), t = tile(grid, i, j), fu = u - i, fv = v - j;
    const C = t[0] ? [t[1], t[1], t[1], t[1]] : [vertex(grid, i, j), vertex(grid, i + 1, j), vertex(grid, i + 1, j + 1), vertex(grid, i, j + 1)];
    const [T, R, B, L] = C, dTB = Math.abs(T - B), dLR = Math.abs(L - R), diag = dTB < dLR ? 0 : dLR < dTB ? 1 : T + B > R + L ? 0 : 1;
    if (diag === 0) return fu >= fv ? T + (R - T) * fu + (B - R) * fv : T + (B - L) * fu + (L - T) * fv;
    return fu + fv <= 1 ? T + (R - T) * fu + (L - T) * fv : R + L - B + (B - L) * fu + (B - R) * fv;
  }
  const isWater = (grid, u, v) => tile(grid, Math.floor(u), Math.floor(v))[0] !== 0;
  return { heightAt, ground, isWater };
}
