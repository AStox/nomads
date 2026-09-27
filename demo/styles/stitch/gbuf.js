// A height-field picture: every thread, weave, ring of wood and bit of steel is written as height, colour, fibre
// direction and material per pixel, and the higher surface wins. One lighting pass then shades it all the same way,
// with cast shadows, cavity darkening and a hair-style sheen along the fibres, so it reads as a photograph.
import { clamp, hash } from "../world.js";

export const TABLE = 1, CLOTH = 2, FLOSS = 3, WOOD = 4, METAL = 5, PAPER = 6, BRASS = 7;
const TAU = Math.PI * 2, PI = Math.PI;
const ss = (a, b, v) => { const t = clamp((v - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const angQ = (a) => { a %= PI; if (a < 0) a += PI; return (a * 255) / PI; };

export class GBuf {
  constructor(W, H) {
    this.W = W; this.H = H;
    const n = W * H;
    this.z = new Float32Array(n).fill(-500);
    this.c = new Uint8ClampedArray(n * 3);
    this.t = new Uint8Array(n);
    this.m = new Uint8Array(n);
    this.g = new Uint8Array(n);
  }

  // Highest surface within radius r around (x, y), for threads that lie on whatever is already there.
  peak(x, y, r) {
    const { W, H, z } = this;
    let best = -500;
    const x0 = Math.max(0, Math.floor(x - r)), x1 = Math.min(W - 1, Math.ceil(x + r)), y0 = Math.max(0, Math.floor(y - r)), y1 = Math.min(H - 1, Math.ceil(y + r));
    const st = Math.max(1, Math.floor(r / 2));
    for (let j = y0; j <= y1; j += st) for (let i = x0; i <= x1; i += st) if (z[j * W + i] > best) best = z[j * W + i];
    return best;
  }

  // One thread lying straight from (x0,y0) to (x1,y1): two twisted plies side by side (or one), rounded in section,
  // pinched and sunk where it dives through the cloth. Options: r half-width, c [r,g,b], plies, z0/z1 base height or
  // drape (lie on what is below), lift (arch), h (section height per r), pitch, twist, dive0/dive1, gloss, seed.
  strand(x0, y0, x1, y1, o) {
    const { W, H, z, c, t, m, g } = this;
    const r = o.r, col = o.c, plies = o.plies ?? 2, lift = o.lift ?? 0, hk = (o.h ?? 0.75) * r;
    const d0 = o.dive0 ?? o.dive ?? 1, d1 = o.dive1 ?? o.dive ?? 1;
    const dx = x1 - x0, dy = y1 - y0, L = Math.max(0.01, Math.hypot(dx, dy)), ux = dx / L, uy = dy / L;
    const tw = o.twist ?? 0.55, S = Math.sin(tw), C = Math.cos(tw), pitch = r * (o.pitch ?? 1.15);
    const seed = o.seed ?? 0, gl = Math.round(255 * (o.gloss ?? 0.8)), fiber = angQ(Math.atan2(uy, ux) + tw), a0 = o.a0 ?? 0;
    const cr = col[0], cg = col[1], cb = col[2];
    let zb0 = o.z0 ?? o.z ?? 0, zb1 = o.z1 ?? zb0, drape = null, K = 0;
    if (o.drape) {
      K = Math.max(2, Math.ceil(L / Math.max(1, r * 0.8)) + 1);
      drape = new Float32Array(K);
      for (let k = 0; k < K; k++) { const s = k / (K - 1); drape[k] = this.peak(x0 + dx * s, y0 + dy * s, r * 0.7) + (o.above ?? 0.15); }
      // dive ends go down into the hole instead of resting on the stitches beside it
      if (d0) drape[0] = Math.min(drape[0], drape[1] - r * 0.6);
      if (d1) drape[K - 1] = Math.min(drape[K - 1], drape[K - 2] - r * 0.6);
    }
    const fz = Math.max(0.9, r * 0.22), ext = r + fz + 1;
    const bx0 = Math.max(0, Math.floor(Math.min(x0, x1) - ext)), bx1 = Math.min(W - 1, Math.ceil(Math.max(x0, x1) + ext));
    const by0 = Math.max(0, Math.floor(Math.min(y0, y1) - ext)), by1 = Math.min(H - 1, Math.ceil(Math.max(y0, y1) + ext));
    const wob = hash(seed, 7, 3) * TAU, rp = plies === 2 ? 0.6 : 1, cOff = plies === 2 ? 0.5 : 0;
    for (let py = by0; py <= by1; py++) {
      const ry = py + 0.5 - y0;
      for (let px = bx0; px <= bx1; px++) {
        const rx = px + 0.5 - x0;
        const a = rx * ux + ry * uy;
        let d = ry * ux - rx * uy;
        if (d > r + fz || d < -r - fz) continue;
        const e = a < L - a ? a : L - a, dv = a < L - a ? d0 : d1;
        let wf = 1, hf = 1;
        if (e < 0) {
          if (dv) continue;
          if (e * e + d * d > r * r) continue;
          wf = 1; hf = Math.sqrt(Math.max(0, 1 - (e * e) / (r * r)));
        } else if (dv) {
          const q = e / (1.5 * r);
          if (q < 1) { const s = q * q * (3 - 2 * q); wf = 0.72 + 0.28 * s; hf = 0.3 + 0.7 * s; }
        }
        const w = r * wf;
        if (d > w || d < -w) {
          // stray fibres standing off the edge of the thread
          const out = (d > 0 ? d - w : -w - d) / fz;
          if (e > 0 && out < 1 && hash(px, py, seed + 5) < 0.28 * (1 - out)) {
            const s = a / L, i = py * W + px, hz = (drape ? drape[Math.min(K - 1, Math.round(s * (K - 1)))] : zb0 + (zb1 - zb0) * s) + lift * Math.sin(PI * s) * 0.8 + hk * 0.15 * hf;
            if (hz > z[i]) { z[i] = hz; const f = 0.95 + 0.1 * hash(px, py, seed + 6); c[i * 3] = cr * f; c[i * 3 + 1] = cg * f; c[i * 3 + 2] = cb * f; t[i] = (fiber + 40 * hash(px, py, seed + 7)) & 255; m[i] = FLOSS; g[i] = gl >> 1; }
          }
          continue;
        }
        // which ply, and where across it
        let q;
        if (plies === 2) {
          const wig = 0.08 * Math.sin(a / (r * 3.1) + wob);
          const dd = d / w - wig;
          q = (dd > 0 ? dd - cOff : dd + cOff) / rp;
          if (q > 1 || q < -1) { q = q > 0 ? 1 : -1; }
        } else q = d / w;
        const prof = Math.sqrt(1 - q * q * 0.96);
        const s = a <= 0 ? 0 : a >= L ? 1 : a / L;
        let base;
        if (drape) { const f = s * (K - 1), k = f < K - 1 ? Math.floor(f) : K - 2, u = f - k; base = drape[k] * (1 - u) + drape[k + 1] * u; }
        else base = zb0 + (zb1 - zb0) * s;
        const ph = (d * C - (a + a0) * S) / pitch;
        const gs = 0.5 + (o.soft ? 0.2 : 0.5) * Math.cos(TAU * ph + (d > 0 ? 1.7 : 0) + wob);
        const fib = hash(Math.floor((d * C - (a + a0) * S) * 1.7 / Math.max(1, r * 0.25)), seed, 17) - 0.5;
        const hz = base + lift * Math.sin(PI * s) + hk * hf * prof * (0.93 + 0.07 * gs + 0.04 * fib);
        const i = py * W + px;
        if (hz <= z[i]) continue;
        z[i] = hz;
        const n = hash(px, py, seed) - 0.5, f = (0.9 + 0.06 * gs + 0.07 * fib + 0.03 * n) * (0.78 + 0.22 * hf) * (0.82 + 0.18 * prof);
        c[i * 3] = cr * f; c[i * 3 + 1] = cg * f; c[i * 3 + 2] = cb * f;
        t[i] = fiber; m[i] = FLOSS; g[i] = gl;
      }
    }
  }

  // A thread following a path of points, sinking only at the chosen ends. A draped thread takes its heights from
  // what lies under the whole path before any of it is laid, so it rests in one smooth line.
  thread(pts, o) {
    const step = Math.max(2, o.r * 1.5), P = [pts[0]];
    for (let k = 1; k < pts.length; k++) {
      const [ax, ay] = pts[k - 1], [bx, by] = pts[k], n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / step));
      const za = pts[k - 1][2], zb = pts[k][2];
      for (let q = 1; q <= n; q++) P.push([ax + ((bx - ax) * q) / n, ay + ((by - ay) * q) / n, za === undefined ? undefined : za + ((zb - za) * q) / n]);
    }
    let Z;
    if (o.drape) {
      Z = P.map(([x, y]) => this.peak(x, y, o.r * 0.7) + (o.above ?? 0.15));
      for (let pass = 0; pass < 3; pass++) for (let k = 1; k < Z.length - 1; k++) Z[k] = Math.max(Z[k], (Z[k - 1] + Z[k + 1]) / 2 - o.r * 0.1);
      if (o.dive0 ?? 1) Z[0] -= o.r * 0.6;
      if (o.dive1 ?? 1) Z[Z.length - 1] -= o.r * 0.6;
    } else Z = P.map((p) => p[2] ?? o.z0 ?? o.z ?? 0);
    let a0 = 0;
    for (let k = 1; k < P.length; k++) {
      this.strand(P[k - 1][0], P[k - 1][1], P[k][0], P[k][1], { ...o, drape: false, z0: Z[k - 1], z1: Z[k], dive0: k === 1 ? (o.dive0 ?? 1) : 0, dive1: k === P.length - 1 ? (o.dive1 ?? 1) : 0, a0 });
      a0 += Math.hypot(P[k][0] - P[k - 1][0], P[k][1] - P[k - 1][1]);
    }
  }

  // A French knot: the wraps round the needle pulled into a tight double ring of thread with the tail sunk in its
  // middle, drawn with the same threads as everything else.
  knot(x, y, r, col, o = {}) {
    const base = o.drape === false ? (o.z ?? 0) : this.peak(x, y, r * 0.5) - r * 0.25, seed = o.seed ?? 0, spin = hash(seed, 3, 9) * TAU;
    this.dome(x, y, r * 0.62, col, base + r * 0.1, seed);
    for (let w = 0; w < 2; w++) {
      const rr = r * (w ? 0.34 : 0.52), rt = r * (w ? 0.36 : 0.44), cx = x + Math.cos(spin) * r * 0.1 * w, cy = y + Math.sin(spin) * r * 0.1 * w;
      const n = 11, pts = [];
      for (let k = 0; k <= n; k++) {
        const a = spin + w * 1.9 + (k / n) * TAU * 1.08, wob = 1 + 0.08 * Math.sin(a * 3 + seed);
        pts.push([cx + Math.cos(a) * rr * wob, cy + Math.sin(a) * rr * wob]);
      }
      const f = w ? 1.04 : 0.96;
      for (let k = 1; k < pts.length; k++)
        this.strand(pts[k - 1][0], pts[k - 1][1], pts[k][0], pts[k][1], { r: rt, c: [col[0] * f, col[1] * f, col[2] * f], z: base + r * (0.15 + w * 0.3) + r * 0.08 * Math.sin(k), plies: 2, dive: 0, seed: seed + k + w * 20, gloss: 0.85, h: 0.85, pitch: 1.3 });
    }
  }

  dome(x, y, r, col, base, seed) {
    const { W, H, z, c, t, m, g } = this;
    const x0 = Math.max(0, Math.floor(x - r - 1)), x1 = Math.min(W - 1, Math.ceil(x + r + 1)), y0 = Math.max(0, Math.floor(y - r - 1)), y1 = Math.min(H - 1, Math.ceil(y + r + 1));
    for (let py = y0; py <= y1; py++)
      for (let px = x0; px <= x1; px++) {
        const q = Math.hypot(px + 0.5 - x, py + 0.5 - y) / r;
        if (q >= 1) continue;
        const hz = base + r * 0.7 * Math.sqrt(1 - q * q), i = py * W + px;
        if (hz <= z[i]) continue;
        z[i] = hz;
        const f = 0.8 + 0.08 * hash(px, py, seed);
        c[i * 3] = col[0] * f; c[i * 3 + 1] = col[1] * f; c[i * 3 + 2] = col[2] * f;
        t[i] = angQ(Math.atan2(py - y, px - x) + PI / 2); m[i] = FLOSS; g[i] = 150;
      }
  }

  // Older bead-like knot, kept for tiny scales where a ring of thread would be a pixel wide.
  bead(x, y, r, col, o = {}) {
    const { W, H, z, c, t, m, g } = this;
    const base = o.drape === false ? (o.z ?? 0) : this.peak(x, y, r * 0.6) - r * 0.2;
    const seed = o.seed ?? 0, spin = hash(seed, 3, 9) * TAU, wraps = o.wraps ?? 2;
    const ax = Math.cos(spin), ay = Math.sin(spin);
    const x0 = Math.max(0, Math.floor(x - r - 1)), x1 = Math.min(W - 1, Math.ceil(x + r + 1)), y0 = Math.max(0, Math.floor(y - r - 1)), y1 = Math.min(H - 1, Math.ceil(y + r + 1));
    for (let py = y0; py <= y1; py++)
      for (let px = x0; px <= x1; px++) {
        const ddx = px + 0.5 - x, ddy = py + 0.5 - y;
        const rr = Math.hypot(ddx, ddy), ang = Math.atan2(ddy, ddx);
        const lump = 1 + 0.08 * Math.sin(ang * 3 + spin) + 0.05 * Math.sin(ang * 5 - spin);
        const q = rr / (r * lump);
        if (q >= 1) continue;
        const prof = Math.pow(1 - q * q, 0.5);
        // the wraps lie across the ball like thread on a spool, bowed by its roundness
        const along = (ddx * ax + ddy * ay) / r, across = (ddy * ax - ddx * ay) / r;
        const ph = (along * (wraps + 0.5)) / (0.6 + 0.4 * prof) + 0.35 * across * across;
        const gs = 0.5 + 0.5 * Math.cos(TAU * ph);
        const hz = base + r * (0.9 * prof * (0.8 + 0.2 * gs));
        const i = py * W + px;
        if (hz <= z[i]) continue;
        z[i] = hz;
        const n = hash(px, py, seed) - 0.5, f = 0.82 + 0.16 * gs + 0.05 * n;
        c[i * 3] = col[0] * f; c[i * 3 + 1] = col[1] * f; c[i * 3 + 2] = col[2] * f;
        t[i] = angQ(spin + PI / 2 + 0.5 * across * (along > 0 ? 1 : -1)); m[i] = FLOSS; g[i] = 210;
      }
  }

  // Ink or print on a surface: colour only, the height is left alone.
  ink(x0, y0, x1, y1, r, col, alpha = 1) {
    const { W, H, c } = this;
    const dx = x1 - x0, dy = y1 - y0, L2 = dx * dx + dy * dy || 1e-6;
    const bx0 = Math.max(0, Math.floor(Math.min(x0, x1) - r - 1)), bx1 = Math.min(W - 1, Math.ceil(Math.max(x0, x1) + r + 1));
    const by0 = Math.max(0, Math.floor(Math.min(y0, y1) - r - 1)), by1 = Math.min(H - 1, Math.ceil(Math.max(y0, y1) + r + 1));
    for (let py = by0; py <= by1; py++)
      for (let px = bx0; px <= bx1; px++) {
        const rx = px + 0.5 - x0, ry = py + 0.5 - y0, s = clamp((rx * dx + ry * dy) / L2, 0, 1);
        const d = Math.hypot(rx - s * dx, ry - s * dy);
        if (d > r + 0.5) continue;
        const a = alpha * clamp(r + 0.5 - d, 0, 1), i = (py * W + px) * 3;
        c[i] += (col[0] - c[i]) * a; c[i + 1] += (col[1] - c[i + 1]) * a; c[i + 2] += (col[2] - c[i + 2]) * a;
      }
  }

  // Shade everything under one soft key light from the upper left, then box-filter down by `down`.
  shade({ light = [-0.6, -0.55, 0.58], exposure = 1.18, aoR = [4, 16, 48], aoK = [0.5, 0.35, 0.25], down = 2, warm = [1.0, 0.97, 0.9], cool = [0.9, 0.95, 1.04], amb = 0.3 } = {}) {
    const { W, H, z, c, t, m, g } = this, n = W * H;
    const ll = Math.hypot(...light), Lx = light[0] / ll, Ly = light[1] / ll, Lz = light[2] / ll;
    const lxy = Math.hypot(Lx, Ly), sx = Lx / lxy, sy = Ly / lxy, tanE = Lz / lxy;
    let hx = Lx, hy = Ly, hz = Lz + 1; const hl = Math.hypot(hx, hy, hz); hx /= hl; hy /= hl; hz /= hl;
    // summed-area table of height for the cavity terms
    const S = new Float64Array((W + 1) * (H + 1));
    for (let y = 0; y < H; y++) {
      let row = 0;
      for (let x = 0; x < W; x++) { row += Math.max(z[y * W + x], -120); S[(y + 1) * (W + 1) + x + 1] = S[y * (W + 1) + x + 1] + row; }
    }
    const boxMean = (x, y, r) => {
      const xa = Math.max(0, x - r), xb = Math.min(W, x + r + 1), ya = Math.max(0, y - r), yb = Math.min(H, y + r + 1);
      return (S[yb * (W + 1) + xb] - S[ya * (W + 1) + xb] - S[yb * (W + 1) + xa] + S[ya * (W + 1) + xa]) / ((xb - xa) * (yb - ya));
    };
    const steps = [1, 2, 3, 4, 6, 8, 11, 15, 20, 27, 36, 48, 64, 85];
    const out = new Float32Array(n * 3);
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const i = y * W + x, h0 = z[i];
        const zl = z[x > 0 ? i - 1 : i], zr = z[x < W - 1 ? i + 1 : i], zu = z[y > 0 ? i - W : i], zd = z[y < H - 1 ? i + W : i];
        let gx = clamp((zr - zl) * 0.5, -3, 3), gy = clamp((zd - zu) * 0.5, -3, 3);
        let nx = -gx, ny = -gy, nz = 1; const nl = Math.hypot(nx, ny, nz); nx /= nl; ny /= nl; nz /= nl;
        // cast shadow: march toward the light and see if anything rises above the ray
        let sh = 0;
        for (let k = 0; k < steps.length; k++) {
          const d = steps[k], qx = Math.round(x + sx * d), qy = Math.round(y + sy * d);
          if (qx < 0 || qy < 0 || qx >= W || qy >= H) break;
          const over = (z[qy * W + qx] - (h0 + d * tanE)) / (0.3 * d + 0.8);
          if (over > sh) { sh = over; if (sh >= 1) { sh = 1; break; } }
        }
        const lit = 1 - sh;
        let ao = 1;
        for (let k = 0; k < 3; k++) { const mean = boxMean(x, y, aoR[k]); ao *= 1 - clamp(((mean - h0) / aoR[k]) * aoK[k] * 2, 0, 0.85); }
        const ndl = Math.max(0, nx * Lx + ny * Ly + nz * Lz);
        const mt = m[i];
        let r = c[i * 3] / 255, gg = c[i * 3 + 1] / 255, b = c[i * 3 + 2] / 255;
        const skyv = amb * ao * (0.75 + 0.25 * nz), dif = 0.82 * ndl * lit;
        let R = r * (skyv * cool[0] + dif * warm[0]), G = gg * (skyv * cool[1] + dif * warm[1]), B = b * (skyv * cool[2] + dif * warm[2]);
        let spec = 0, tint = 0;
        if (mt === FLOSS || mt === CLOTH) {
          // a thread's sheen runs across its fibres (Kajiya-Kay)
          const ta = (t[i] / 255) * PI; let tx = Math.cos(ta), ty = Math.sin(ta), tzz = 0;
          const tn = tx * nx + ty * ny; tx -= nx * tn; ty -= ny * tn; tzz = -nz * tn; const tl = Math.hypot(tx, ty, tzz) || 1;
          const th = (tx * hx + ty * hy + tzz * hz) / tl, sn = Math.sqrt(Math.max(0, 1 - th * th));
          let p = sn * sn; p *= p; p *= p; p *= p; p *= p; // sn^32
          const gls = g[i] / 255;
          spec = mt === FLOSS ? (0.3 * p + 0.07 * sn * sn * sn * sn) * gls * lit : 0.04 * p * lit;
          tint = 0.35;
        } else {
          const nh = Math.max(0, nx * hx + ny * hy + nz * hz);
          let p = nh * nh; p *= p; p *= p; p *= p; // nh^16
          if (mt === WOOD || mt === TABLE) spec = (mt === WOOD ? 0.16 : 0.1) * p * p * lit + 0.03 * p * lit;
          else if (mt === METAL || mt === BRASS) {
            const p2 = p * p * p * p; // nh^64
            // a sharp highlight plus the room reflected in the steel: bright toward the window, dark below
            const rz = 2 * nz * nz - 1, rx = 2 * nz * nx, ry = 2 * nz * ny;
            const env = 0.3 + 0.75 * clamp(-(rx * sx + ry * sy) * 0.9 + rz * 0.45, 0, 1);
            R = r * env + R * 0.35; G = gg * env + G * 0.35; B = b * env + B * 0.35;
            spec = (2.2 * p2 + 0.35 * p) * lit; tint = mt === BRASS ? 0.6 : 0.1;
          } else if (mt === PAPER) spec = 0.03 * p * lit;
        }
        const sw = 1 - tint;
        out[i * 3] = (R * exposure + spec * (sw + tint * r)) ;
        out[i * 3 + 1] = (G * exposure + spec * (sw + tint * gg));
        out[i * 3 + 2] = (B * exposure + spec * (sw + tint * b));
      }
    // box-filter down to the output size
    const w2 = Math.floor(W / down), h2 = Math.floor(H / down), img = new Float32Array(w2 * h2 * 3), inv = 1 / (down * down);
    for (let y = 0; y < h2; y++)
      for (let x = 0; x < w2; x++) {
        let r = 0, gg = 0, b = 0;
        for (let j = 0; j < down; j++) for (let k = 0; k < down; k++) { const i = ((y * down + j) * W + x * down + k) * 3; r += out[i]; gg += out[i + 1]; b += out[i + 2]; }
        const o = (y * w2 + x) * 3; img[o] = r * inv; img[o + 1] = gg * inv; img[o + 2] = b * inv;
      }
    return { img, w: w2, h: h2 };
  }
}
