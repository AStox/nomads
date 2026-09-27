// The aida cloth: a lattice of holes on screen, a little pulled toward where the stitching is dense and never quite
// regular, and the woven blocks between the holes drawn thread by thread.
import { clamp, hash, fbm } from "../world.js";
import { CLOTH } from "./gbuf.js";

export class Fabric {
  // (ox, oy): screen position of hole (0, 0); cs: cell size in pixels; rot: turn of the weave on screen.
  constructor({ ox, oy, cs, rot = 0, cols, rows }) {
    Object.assign(this, { ox, oy, cs, rot, cols, rows });
    this.ex = [Math.cos(rot) * cs, Math.sin(rot) * cs];
    this.ey = [-Math.sin(rot) * cs, Math.cos(rot) * cs];
    this.GW = cols + 1; this.GH = rows + 1;
    this.du = new Float32Array(this.GW * this.GH);
    this.dv = new Float32Array(this.GW * this.GH);
  }
  disp(u, v) {
    const { GW, GH, du, dv } = this;
    const x = clamp(u, 0, GW - 1.001), y = clamp(v, 0, GH - 1.001), i = Math.floor(x), j = Math.floor(y), a = x - i, b = y - j, k = j * GW + i;
    return [
      (du[k] * (1 - a) + du[k + 1] * a) * (1 - b) + (du[k + GW] * (1 - a) + du[k + GW + 1] * a) * b,
      (dv[k] * (1 - a) + dv[k + 1] * a) * (1 - b) + (dv[k + GW] * (1 - a) + dv[k + GW + 1] * a) * b,
    ];
  }
  // Screen point of fabric coordinates (u, v), pulled.
  at(u, v) {
    const [a, b] = this.disp(u, v), U = u + a, V = v + b;
    return [this.ox + U * this.ex[0] + V * this.ey[0], this.oy + U * this.ex[1] + V * this.ey[1]];
  }
  hole(i, j) { return this.at(i, j); }
  // Fabric coordinates of a screen point, without the pull.
  raw(x, y) {
    const dx = x - this.ox, dy = y - this.oy, c2 = this.cs * this.cs;
    return [(dx * this.ex[0] + dy * this.ex[1]) / c2, (dx * this.ey[0] + dy * this.ey[1]) / c2];
  }
  // Stitching draws the weave together: holes lean toward dense work, plus the small unevenness of any cloth.
  pull(density, k = 0.22, jitter = 0.035, seed = 3) {
    const { cols, rows, GW, GH } = this;
    const R = 5, tmp = new Float32Array(cols * rows), blur = new Float32Array(cols * rows);
    for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) { let s = 0, n = 0; for (let d = -R; d <= R; d++) { const x = i + d; if (x >= 0 && x < cols) { s += density[j * cols + x]; n++; } } tmp[j * cols + i] = s / n; }
    for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) { let s = 0, n = 0; for (let d = -R; d <= R; d++) { const y = j + d; if (y >= 0 && y < rows) { s += tmp[y * cols + i]; n++; } } blur[j * cols + i] = s / n; }
    const B = (i, j) => blur[clamp(j, 0, rows - 1) * cols + clamp(i, 0, cols - 1)];
    for (let j = 0; j < GH; j++)
      for (let i = 0; i < GW; i++) {
        const gx = (B(i, j - 1) + B(i, j) - B(i - 1, j - 1) - B(i - 1, j)) * 0.5, gy = (B(i - 1, j) + B(i, j) - B(i - 1, j - 1) - B(i, j - 1)) * 0.5;
        const k2 = j * GW + i;
        this.du[k2] = gx * k * R + jitter * (fbm(i / 7, j / 7, seed, 2) + (hash(i, j, seed) - 0.5) * 0.8);
        this.dv[k2] = gy * k * R + jitter * (fbm(i / 7, j / 7, seed + 9, 2) + (hash(i, j, seed + 1) - 0.5) * 0.8);
      }
  }
}

// Weave the cloth into the picture over a screen rectangle. base(x, y) gives the cloth's height there, or null where
// there is no cloth. Colour col is the cloth's own.
export function weave(gb, fab, rect, base, col = [238, 231, 214], o = {}) {
  const { W, z, c, t, m, g } = gb, cs = fab.cs, hole = o.hole ?? 0.1, per = o.threads ?? 4;
  const [x0, y0, x1, y1] = rect.map(Math.round);
  const tq = [0, 128];
  for (let y = Math.max(0, y0); y < Math.min(gb.H, y1); y++)
    for (let x = Math.max(0, x0); x < Math.min(W, x1); x++) {
      const b = base(x, y);
      if (b === null) continue;
      let [u, v] = fab.raw(x + 0.5, y + 0.5);
      const [du, dv] = fab.disp(u, v);
      u -= du; v -= dv;
      const iu = Math.floor(u), iv = Math.floor(v), fu = u - iu, fv = v - iv;
      const hx = fu < 0.5 ? fu : 1 - fu, hy = fv < 0.5 ? fv : 1 - fv;
      const hd = Math.sqrt(Math.sqrt(hx * hx * hx * hx + hy * hy * hy * hy));
      const sx = fu * per, sy = fv * per, fx = Math.floor(sx), fy = Math.floor(sy), ax = sx - fx, ay = sy - fy;
      const warp = Math.sin(Math.PI * ax), weft = Math.sin(Math.PI * ay);
      const par = (fx + fy + iu + iv) & 1;
      const top = par ? warp : weft, bot = par ? weft : warp;
      const tex = Math.max(top, bot * 0.6);
      const pillow = Math.pow(Math.max(0, Math.sin(Math.PI * fu) * Math.sin(Math.PI * fv)), 0.3);
      const holeness = clamp((hole + 0.04 - hd) / 0.07, 0, 1);
      const slub = par ? hash(iu * per + fx, iv, 11) : hash(iv * per + fy, iu, 12);
      const hz = b + cs * (0.07 * pillow + 0.04 * tex * (0.9 + 0.2 * slub) - 0.12 * holeness);
      const i = y * W + x;
      if (hz <= z[i]) continue;
      z[i] = hz;
      const f = (0.9 + 0.07 * tex + 0.05 * (slub - 0.5) + 0.02 * (hash(x, y, 5) - 0.5)) * (1 - 0.5 * holeness);
      c[i * 3] = col[0] * f; c[i * 3 + 1] = col[1] * f; c[i * 3 + 2] = col[2] * f;
      t[i] = tq[par]; m[i] = CLOTH; g[i] = 60;
    }
}
