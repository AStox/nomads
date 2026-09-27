// What lies about the work: the walnut table, the beech hoop with its brass screw, skeins of the floss used, a threaded
// needle, snips and a few buttons. All written into the same height picture, so they cast shadows onto each other.
import { clamp, hash, fbm, noise } from "../world.js";
import { weave } from "./fabric.js";
import { TABLE, WOOD, METAL, PAPER, BRASS } from "./gbuf.js";
import { col } from "./floss.js";

const TAU = Math.PI * 2, PI = Math.PI;
const FZ = 40; // the cloth in the hoop sits this high above the table
const HALF = 860; // half the side of the square of cloth

export function table(gb, V) {
  const { W, H, z, c, t, m, g } = gb, a = 0.035, ca = Math.cos(a), sa = Math.sin(a), PW = 300;
  const hp = V.hoopAt, cr = Math.cos(hp.rot), sr = Math.sin(hp.rot), hidden = HALF - 12;
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      // under the cloth the table is never seen
      const lx = (x - hp.x) * cr + (y - hp.y) * sr, ly = -(x - hp.x) * sr + (y - hp.y) * cr;
      if (Math.abs(lx) < hidden && Math.abs(ly) < hidden) continue;
      const px = x * ca + y * sa, py = -x * sa + y * ca, plank = Math.floor(py / PW), fy = py - plank * PW;
      const off = hash(plank, 0, 400) * 3000, gx = px + off;
      const grain = fbm(gx / 420, py / 9, 401 + plank, 3), fine = noise(gx / 60, py / 1.6, 402 + plank);
      const ring = 0.5 + 0.5 * Math.sin((py + grain * 60 + fbm(gx / 900, py / 80, 403, 2) * 90) / 5.5);
      const gap = Math.min(fy, PW - fy), groove = clamp(1 - gap / 3.5, 0, 1);
      const i = y * W + x;
      z[i] = -groove * 5 + ring * 0.25 + fine * 0.15;
      const tone = 0.78 + 0.16 * grain + 0.1 * ring * ring + 0.05 * fine + (hash(plank, 1, 404) - 0.5) * 0.12;
      const f = tone * (1 - 0.55 * groove);
      c[i * 3] = 118 * f; c[i * 3 + 1] = 80 * f; c[i * 3 + 2] = 54 * f;
      t[i] = 0; m[i] = TABLE; g[i] = 0;
    }
}

// The hoop and the cloth in it. The cloth is drum-tight inside the rings and falls away to the table outside them,
// cut square with pinking shears.
export function hoop(gb, V) {
  const { fab, hoopAt: hp } = V, { x: hx, y: hy, Ri, rot } = hp, Ro = Ri + 54, half = HALF;
  hp.Ro = Ro; hp.FZ = FZ;
  const cr = Math.cos(rot), sr = Math.sin(rot);
  const base = (x, y) => {
    const dx = x - hx, dy = y - hy, lx = dx * cr + dy * sr, ly = -dx * sr + dy * cr;
    // pinked edge: a zigzag a few millimetres deep
    const zz = (q) => 7 * Math.abs(((q / 13) % 2 + 2) % 2 - 1);
    if (Math.abs(lx) > half - zz(ly) || Math.abs(ly) > half - zz(lx)) return null;
    const r = Math.hypot(dx, dy);
    if (r < Ri) return FZ - 3 * (1 - (r / Ri) ** 2);
    // over the inner ring's rounded top, then under the outer ring, then falling away to the table
    if (r < Ri + 14) return FZ + 5 * Math.sin(((r - Ri) / 14) * PI);
    if (r < Ro) return FZ - 16;
    const o = r - Ro, ang = Math.atan2(dy, dx), fall = Math.exp(-o / 40);
    const wr = (1 - fall) * (4 * Math.sin(ang * 9 + o / 55 + 2 * fbm(ang * 3, o / 120, 410, 2)) + 3 * fbm(x / 160, y / 160, 411, 2));
    return 1.5 + (FZ - 16 - 1.5) * fall + Math.max(0, wr + 3);
  };
  weave(gb, fab, [0, 0, gb.W, gb.H], base, [236, 229, 212], { threads: 3 });
  ring(gb, hx, hy, Ri + 9, Ro, FZ + 12, rot);
}

function ring(gb, hx, hy, r0, r1, top, rot) {
  const { W, H, z, c, t, m, g } = gb, clasp = rot - PI / 2, gapA = 0.012;
  const x0 = Math.max(0, Math.floor(hx - r1 - 80)), x1 = Math.min(W - 1, Math.ceil(hx + r1 + 80)), y0 = Math.max(0, Math.floor(hy - r1 - 90)), y1 = Math.min(H - 1, Math.ceil(hy + r1 + 80));
  for (let y = y0; y <= y1; y++)
    for (let x = x0; x <= x1; x++) {
      const dx = x + 0.5 - hx, dy = y + 0.5 - hy, r = Math.hypot(dx, dy);
      if (r < r0 - 1 || r > r1 + 70) continue;
      const ang = Math.atan2(dy, dx);
      let da = ang - clasp; da = Math.atan2(Math.sin(da), Math.cos(da));
      let hz = -Infinity, alb = null, mat = WOOD, tq = 0;
      if (r >= r0 && r <= r1 && Math.abs(da) > gapA) {
        const q = (r - r0) / (r1 - r0), prof = Math.pow(Math.max(0, Math.sin(PI * q)), 0.3);
        hz = 3 + (top - 3) * prof;
        const gr = fbm(ang * r / 50, r / 4.5, 420, 3), fl = noise(ang * r / 8, r / 1.2, 421);
        const f = 0.86 + 0.12 * gr + 0.04 * fl - 0.12 * (1 - prof);
        alb = [222 * f, 188 * f, 140 * f];
      }
      // the clasp: two blocks either side of the split and the brass screw through them
      const tx = -Math.sin(clasp), ty = Math.cos(clasp), nx = Math.cos(clasp), ny = Math.sin(clasp);
      const along = dx * tx + dy * ty, out = dx * nx + dy * ny - r1;
      if (Math.abs(along) < 34 && out > -20 && out < 30 && Math.abs(along) > 4) {
        const e = Math.min(34 - Math.abs(along), 30 - out, out + 20, Math.abs(along) - 4), prof = clamp(e / 6, 0, 1);
        const h2 = 4 + (top + 4 - 4) * Math.sqrt(prof);
        if (h2 > hz) { hz = h2; const f = 0.84 + 0.1 * fbm(along / 12, out / 3, 422, 2); alb = [214 * f, 180 * f, 132 * f]; mat = WOOD; }
      }
      if (Math.abs(out - 14) < 7 && Math.abs(along) < 56) {
        const q = (out - 14) / 7, h3 = top + 5 + 6 * Math.sqrt(1 - q * q);
        const head = Math.abs(along) > 38, thread = 0.5 + 0.5 * Math.sin(along * 1.6);
        const h4 = head ? top + 7 + 9 * Math.sqrt(Math.max(0, 1 - q * q * 0.6)) : h3 - (1 - thread) * 1.2;
        if (along > -40 && h4 > hz) { hz = h4; alb = head ? [196, 158, 76] : [180, 146, 72]; mat = BRASS; }
      }
      if (hz === -Infinity) continue;
      const i = y * W + x;
      if (hz <= z[i]) continue;
      z[i] = hz; c[i * 3] = alb[0]; c[i * 3 + 1] = alb[1]; c[i * 3 + 2] = alb[2]; m[i] = mat; t[i] = 0; g[i] = 0;
    }
}

// ---------- small things on the table ----------
const DIGITS = {
  1: [[[0.25, 0.35], [0.55, 0], [0.55, 1.6]]],
  2: [[[0.08, 0.4], [0.3, 0.05], [0.7, 0.05], [0.92, 0.4], [0.08, 1.6], [0.95, 1.6]]],
  3: [[[0.08, 0.1], [0.9, 0.05], [0.4, 0.7], [0.9, 1.0], [0.85, 1.4], [0.5, 1.62], [0.05, 1.45]]],
  4: [[[0.72, 1.6], [0.72, 0], [0.05, 1.1], [0.98, 1.1]]],
  5: [[[0.92, 0], [0.18, 0], [0.12, 0.72], [0.6, 0.62], [0.95, 1.05], [0.6, 1.6], [0.05, 1.42]]],
  6: [[[0.85, 0.08], [0.4, 0], [0.08, 0.7], [0.1, 1.35], [0.5, 1.62], [0.9, 1.3], [0.85, 0.9], [0.45, 0.72], [0.08, 0.95]]],
  7: [[[0.05, 0], [0.95, 0], [0.35, 1.6]]],
  9: [[[0.9, 0.6], [0.5, 0.85], [0.1, 0.62], [0.15, 0.15], [0.55, 0], [0.92, 0.3], [0.88, 1.05], [0.45, 1.6], [0.1, 1.5]]],
};
const loop = (cx, cy, rx, ry) => Array.from({ length: 13 }, (_, k) => [cx + Math.cos((k / 12) * TAU) * rx, cy + Math.sin((k / 12) * TAU) * ry]);
DIGITS[0] = [loop(0.5, 0.8, 0.45, 0.8)];
DIGITS[8] = [loop(0.5, 0.4, 0.38, 0.38), loop(0.5, 1.18, 0.45, 0.42)];

function print(gb, text, x, y, size, ang, ink) {
  const ca = Math.cos(ang), sa = Math.sin(ang);
  let cx = 0;
  for (const ch of String(text)) {
    for (const line of DIGITS[ch] ?? [])
      for (let k = 1; k < line.length; k++) {
        const P = (p) => [x + ((cx + p[0]) * ca - p[1] * sa) * size, y + ((cx + p[0]) * sa + p[1] * ca) * size];
        const [a0, a1] = P(line[k - 1]), [b0, b1] = P(line[k]);
        gb.ink(a0, a1, b0, b1, size * 0.13, ink, 0.9);
      }
    cx += 1.25;
  }
}

// A skein: a spindle of floss lengths with a paper band round its middle and a small one near its end.
function skein(gb, x, y, ang, len, wid, key, seed) {
  const C = col(key), ca = Math.cos(ang), sa = Math.sin(ang), n = 13, r = wid / (n * 1.55);
  const base = gb.peak(x, y, 6);
  for (let k = 0; k < n; k++) {
    const off = (k / (n - 1) - 0.5) * wid, pts = [], m = 22;
    for (let q = 0; q <= m; q++) {
      const s = q / m, bulge = Math.pow(Math.sin(PI * (0.04 + s * 0.92)), 0.55), wv = 1.5 * Math.sin(s * 9 + k * 1.3 + seed);
      const a = (s - 0.5) * len, b = off * bulge + wv;
      pts.push([x + a * ca - b * sa, y + a * sa + b * ca]);
    }
    const lift = 3 + 7 * (1 - Math.abs(off / wid) * 2) ** 0.5;
    const f = 0.9 + 0.14 * hash(k, seed, 430);
    gb.thread(pts, { r, c: [C[0] * f, C[1] * f, C[2] * f], z: base + lift, plies: 2, dive0: 0, dive1: 0, seed: seed * 50 + k, gloss: 0.9, pitch: 1.4, twist: 0.5, h: 0.9 });
  }
  band(gb, x, y, ang, len * 0.08, len * -0.12, wid * 1.15, key, true);
  band(gb, x, y, ang, len * 0.035, len * 0.3, wid * 0.95, key, false);
}

function band(gb, x, y, ang, bw, at, wid, key, label) {
  const { W, H, z, c, t, m, g } = gb, ca = Math.cos(ang), sa = Math.sin(ang);
  const cx = x + at * ca, cy = y + at * sa, top = gb.peak(cx, cy, wid * 0.4) + 1.5, R = Math.hypot(bw, wid) + 2;
  const stripe = col(key);
  for (let py = Math.max(0, Math.floor(cy - R)); py <= Math.min(H - 1, cy + R); py++)
    for (let px = Math.max(0, Math.floor(cx - R)); px <= Math.min(W - 1, cx + R); px++) {
      const dx = px + 0.5 - cx, dy = py + 0.5 - cy, a = dx * ca + dy * sa, b = -dx * sa + dy * ca;
      if (Math.abs(a) > bw || Math.abs(b) > wid * 0.5) continue;
      const q = b / (wid * 0.5), hz = top - 6 * q * q, i = py * W + px;
      if (hz <= z[i]) continue;
      z[i] = hz;
      const strip = label && Math.abs(a + bw * 0.62) < bw * 0.22;
      const al = strip ? stripe : [242, 238, 226];
      const f = 0.96 + 0.04 * hash(px, py, 440);
      c[i * 3] = al[0] * f; c[i * 3 + 1] = al[1] * f; c[i * 3 + 2] = al[2] * f; m[i] = PAPER; t[i] = 0; g[i] = 0;
    }
  if (label) print(gb, key, cx + ca * bw * 0.15 - sa * (-wid * 0.36), cy + sa * bw * 0.15 + ca * (-wid * 0.36), wid * 0.17, ang + PI / 2, [34, 30, 28]);
}

// A long steel needle with its eye, and the floss threaded through it.
function needle(gb, x0, y0, x1, y1, r) {
  const { W, H, z, c, t, m, g } = gb, dx = x1 - x0, dy = y1 - y0, L = Math.hypot(dx, dy), ux = dx / L, uy = dy / L;
  const base = Math.max(gb.peak(x0, y0, 4), gb.peak((x0 + x1) / 2, (y0 + y1) / 2, 4), gb.peak(x1, y1, 4));
  const bx0 = Math.max(0, Math.floor(Math.min(x0, x1) - r - 2)), bx1 = Math.min(W - 1, Math.ceil(Math.max(x0, x1) + r + 2));
  const by0 = Math.max(0, Math.floor(Math.min(y0, y1) - r - 2)), by1 = Math.min(H - 1, Math.ceil(Math.max(y0, y1) + r + 2));
  for (let py = by0; py <= by1; py++)
    for (let px = bx0; px <= bx1; px++) {
      const rx = px + 0.5 - x0, ry = py + 0.5 - y0, a = rx * ux + ry * uy, d = ry * ux - rx * uy;
      if (a < 0 || a > L) continue;
      const s = a / L, taper = s > 0.8 ? Math.max(0.05, (1 - s) / 0.2) : s < 0.03 ? 0.75 + 0.25 * (s / 0.03) : 1, rr = r * (s < 0.1 ? 1.12 : 1) * taper;
      if (Math.abs(d) > rr) continue;
      // the eye: a slot near the blunt end
      if (s > 0.025 && s < 0.085 && Math.abs(d) < rr * 0.38) continue;
      const q = d / rr, hz = base + r + rr * Math.sqrt(1 - q * q), i = py * W + px;
      if (hz <= z[i]) continue;
      z[i] = hz; c[i * 3] = 196; c[i * 3 + 1] = 199; c[i * 3 + 2] = 206; m[i] = METAL; t[i] = 0; g[i] = 0;
    }
  return [x0 + ux * L * 0.055, y0 + uy * L * 0.055, base + r * 2];
}

function button(gb, x, y, R, alb, holes, seed) {
  const { W, H, z, c, t, m, g } = gb, base = gb.peak(x, y, R * 0.8);
  for (let py = Math.max(0, Math.floor(y - R - 1)); py <= Math.min(H - 1, y + R + 1); py++)
    for (let px = Math.max(0, Math.floor(x - R - 1)); px <= Math.min(W - 1, x + R + 1); px++) {
      const dx = px + 0.5 - x, dy = py + 0.5 - y, q = Math.hypot(dx, dy) / R;
      if (q > 1) continue;
      let hz = base + R * 0.16 * (q > 0.72 ? Math.sqrt(1 - ((q - 0.86) / 0.14) ** 2) * 1.25 : 0.72 + 0.18 * q * q);
      let f = 0.92 + 0.08 * fbm(dx / 6, dy / 16, seed, 2);
      for (let h = 0; h < holes; h++) {
        const a = (h / holes) * TAU + PI / 4 + seed, hx = Math.cos(a) * R * 0.28, hy = Math.sin(a) * R * 0.28;
        if (Math.hypot(dx - hx, dy - hy) < R * 0.1) { hz = base - 2; f *= 0.25; }
      }
      const i = py * W + px;
      if (hz <= z[i]) continue;
      z[i] = hz; c[i * 3] = alb[0] * f; c[i * 3 + 1] = alb[1] * f; c[i * 3 + 2] = alb[2] * f; m[i] = WOOD; t[i] = 0; g[i] = 0;
    }
}

// Embroidery snips: two slim blades from a pivot, two gold rings for the fingers.
function snips(gb, x, y, ang, L) {
  const { W, H, z, c, t, m, g } = gb, base = 0;
  const shapes = [];
  for (const s of [-1, 1]) {
    const a = ang + s * 0.09;
    shapes.push({ kind: "blade", x0: x, y0: y, a, L, w: L * 0.07, top: base + 7 + (s > 0 ? 2 : 0) });
    const ra = ang + PI + s * 0.42, rc = [x + Math.cos(ra) * L * 0.42, y + Math.sin(ra) * L * 0.42];
    shapes.push({ kind: "ring", x: rc[0], y: rc[1], r0: L * 0.1, r1: L * 0.155, top: base + 8 + (s > 0 ? 2 : 0) });
    shapes.push({ kind: "shank", x0: x, y0: y, x1: rc[0] - Math.cos(ra) * L * 0.12, y1: rc[1] - Math.sin(ra) * L * 0.12, w: L * 0.04, top: base + 8 + (s > 0 ? 2 : 0) });
  }
  const R = L * 1.1;
  for (let py = Math.max(0, Math.floor(y - R)); py <= Math.min(H - 1, y + R); py++)
    for (let px = Math.max(0, Math.floor(x - R)); px <= Math.min(W - 1, x + R); px++) {
      const X = px + 0.5, Y = py + 0.5;
      let hz = -Infinity, brass = false;
      for (const s of shapes) {
        let hh = -Infinity;
        if (s.kind === "blade") {
          const dx = X - s.x0, dy = Y - s.y0, a = dx * Math.cos(s.a) + dy * Math.sin(s.a), d = -dx * Math.sin(s.a) + dy * Math.cos(s.a);
          if (a > -4 && a < s.L) { const wd = s.w * (1 - a / s.L) ** 0.8 + 1; if (Math.abs(d) < wd) hh = s.top - 3 * (d / wd) ** 2; }
        } else if (s.kind === "ring") {
          const q = Math.hypot(X - s.x, Y - s.y);
          if (q > s.r0 && q < s.r1) { const e = (q - s.r0) / (s.r1 - s.r0); hh = s.top - 2 + 4 * Math.sin(PI * e); }
        } else {
          const dx = s.x1 - s.x0, dy = s.y1 - s.y0, l2 = dx * dx + dy * dy, tt = clamp(((X - s.x0) * dx + (Y - s.y0) * dy) / l2, 0, 1), d = Math.hypot(X - s.x0 - tt * dx, Y - s.y0 - tt * dy);
          if (d < s.w) hh = s.top + 1 - 3 * (d / s.w) ** 2;
        }
        if (hh > hz) { hz = hh; brass = s.kind !== "blade"; }
      }
      if (Math.hypot(X - x, Y - y) < L * 0.045) { hz = base + 13; brass = true; }
      if (hz === -Infinity) continue;
      const i = py * W + px;
      if (hz <= z[i]) continue;
      z[i] = hz; m[i] = brass ? BRASS : METAL;
      const a = brass ? [205, 165, 80] : [160, 163, 170];
      c[i * 3] = a[0]; c[i * 3 + 1] = a[1]; c[i * 3 + 2] = a[2]; t[i] = 0; g[i] = 0;
    }
}

// The printed pattern this was worked from: the squares of the chart round the camp in flat ink on a sheet of paper,
// with its grid, heavier every tenth line, and the outlines drawn in.
function pattern(gb, V, x, y, ang, cell, C) {
  const ch = V.chart, { W, H, z, c, t, m, g } = gb, ca = Math.cos(ang), sa = Math.sin(ang);
  const [cu, cv] = V.fabOf(V.campAt.x, V.campAt.z), nc = 44, nr = 34, i0 = Math.round(cu - nc * 0.45), j0 = Math.round(cv - nr * 0.5), pad = 34;
  const pw = nc * cell + pad * 2, ph = nr * cell + pad * 2, R = Math.hypot(pw, ph) / 2 + 2;
  for (let py = Math.max(0, Math.floor(y - R)); py <= Math.min(H - 1, y + R); py++)
    for (let px = Math.max(0, Math.floor(x - R)); px <= Math.min(W - 1, x + R); px++) {
      const dx = px + 0.5 - x, dy = py + 0.5 - y, a = dx * ca + dy * sa + pw / 2, b = -dx * sa + dy * ca + ph / 2;
      if (a < 0 || b < 0 || a > pw || b > ph) continue;
      // the sheet lifts a little at its free corner
      const hz = 2 + 7 * Math.pow(Math.max(0, (a / pw) * (b / ph)) , 3) + 0.3 * fbm(a / 90, b / 90, 450, 2), i = py * W + px;
      if (hz <= z[i]) continue;
      let al = [244, 241, 232];
      const u = (a - pad) / cell, v = (b - pad) / cell;
      if (u >= 0 && v >= 0 && u < nc && v < nr) {
        const ci = i0 + Math.floor(u), cj = j0 + Math.floor(v), fu = u - Math.floor(u), fv = v - Math.floor(v);
        if (ci >= 0 && cj >= 0 && ci < ch.cols && cj < ch.rows) {
          const k = cj * ch.cols + ci, tp = ch.type[k];
          if (tp && ch.key[k] != null) {
            const f = C(ch.key[k]), ink = [f[0] * 0.75 + 60, f[1] * 0.75 + 60, f[2] * 0.75 + 60];
            if (tp !== 2 || Math.abs(fu - (1 - fv)) < 0.16) al = ink;
          }
        }
        const gu = Math.min(fu, 1 - fu), gv = Math.min(fv, 1 - fv), heavy = (Math.floor(u + 0.5) % 10 === 0 && gu < 0.1) || (Math.floor(v + 0.5) % 10 === 0 && gv < 0.1);
        if (gu < 0.05 || gv < 0.05 || heavy) al = heavy ? [70, 66, 62] : [al[0] * 0.72, al[1] * 0.72, al[2] * 0.72];
      }
      z[i] = hz;
      const f = 0.97 + 0.03 * hash(px, py, 451);
      c[i * 3] = al[0] * f; c[i * 3 + 1] = al[1] * f; c[i * 3 + 2] = al[2] * f; m[i] = PAPER; t[i] = 0; g[i] = 0;
    }
  // outlines as the chart prints them
  const P = (hi, hj) => { const a = pad + (hi - i0) * cell - pw / 2, b = pad + (hj - j0) * cell - ph / 2; return [x + a * ca - b * sa, y + a * sa + b * ca]; };
  for (const bk of ch.backs) {
    if (bk.i0 < i0 || bk.j0 < j0 || bk.i0 > i0 + nc || bk.j0 > j0 + nr || bk.i1 < i0 || bk.j1 < j0 || bk.i1 > i0 + nc || bk.j1 > j0 + nr) continue;
    const [a0, a1] = P(bk.i0, bk.j0), [b0, b1] = P(bk.i1, bk.j1), f = C(bk.key);
    gb.ink(a0, a1, b0, b1, 1.6, [f[0] * 0.6, f[1] * 0.6, f[2] * 0.6], 0.95);
  }
}

// A ball of thick wool: wraps laid over a sphere in every direction, one loose end trailing off across the table.
function yarnBall(gb, x, y, R, key, trail) {
  const C0 = col(key), r = R * 0.075;
  gb.dome(x, y, R * 0.9, [C0[0] * 0.7, C0[1] * 0.7, C0[2] * 0.7], 4 + R * 0.55, 461);
  for (let k = 0; k < 34; k++) {
    const a = hash(k, 1, 460) * TAU, b = Math.acos(2 * hash(k, 2, 460) - 1), nx = Math.sin(b) * Math.cos(a), ny = Math.sin(b) * Math.sin(a), nz = Math.cos(b);
    // two axes across the wrap's plane
    let ux = -ny, uy = nx, uz = 0; const ul = Math.hypot(ux, uy) || 1; ux /= ul; uy /= ul;
    const vx = ny * uz - nz * uy, vy = nz * ux - nx * uz, vz = nx * uy - ny * ux, pts = [];
    for (let q = 0; q <= 40; q++) {
      const th = (q / 40) * TAU, px = Math.cos(th) * ux + Math.sin(th) * vx, py = Math.cos(th) * uy + Math.sin(th) * vy, pz = Math.cos(th) * uz + Math.sin(th) * vz;
      if (pz < -0.05) { if (pts.length > 1) draw(pts, k); pts.length = 0; continue; }
      pts.push([x + px * R, y + py * R, 4 + R * 0.55 + pz * R * 0.9 + k * 0.04]);
    }
    if (pts.length > 1) draw(pts, k);
  }
  function draw(pts, k) {
    const f = 0.9 + 0.16 * hash(k, 3, 460);
    gb.thread(pts, { r, c: [C0[0] * f, C0[1] * f, C0[2] * f], plies: 2, dive0: 0, dive1: 0, seed: k * 60, gloss: 0.3, pitch: 1.6, twist: 0.6, h: 0.8 });
  }
  if (trail) {
    // a smooth curve through the given points, so the loose end lies in one easy sweep
    const pts = [];
    for (let k = 0; k < trail.length - 1; k++) for (let q = 0; q < 6; q++) { const s = q / 6, a = trail[Math.max(0, k - 1)], b = trail[k], c2 = trail[k + 1], d = trail[Math.min(trail.length - 1, k + 2)]; pts.push([0, 1].map((e) => b[e] + 0.5 * s * (c2[e] - a[e] + s * (2 * a[e] - 5 * b[e] + 4 * c2[e] - d[e] + s * (3 * (b[e] - c2[e]) + d[e] - a[e]))))); }
    pts.push(trail[trail.length - 1]);
    gb.thread(pts, { r, c: C0, drape: true, plies: 2, dive0: 0, dive1: 0, seed: 470, gloss: 0.3, pitch: 2.4, twist: 0.5, h: 0.75, above: 0.3, soft: 1 });
  }
}

export function props(gb, V, C) {
  if (V.kind !== "island") return needleParked(gb, V);
  const { hoopAt: hp } = V;
  pattern(gb, V, 2190, 1250, 0.09, 13, C);
  // skeins of the colours in the work, lying in a loose fan to the right of the hoop
  const fan = [[3345, 2060, 300, -0.62], [471, 2170, 385, -0.46], [3041, 2290, 455, -0.3], [519, 2220, 650, -0.12], [738, 2100, 740, 0.06], [946, 2370, 850, 0.2]];
  fan.forEach(([key, x, y, a], k) => skein(gb, x, y, a, 470, 64, key, k + 1));
  yarnBall(gb, 2480, 105, 125, 321, [[2380, 170], [2300, 175], [2200, 150], [2120, 110], [2050, 60], [1990, 30], [1940, -10]]);
  button(gb, 1985, 1110, 30, [186, 140, 96], 4, 1.1);
  button(gb, 1935, 1190, 22, [230, 222, 206], 2, 2.3);
  snips(gb, 2360, 1190, -2.5, 300);
  // the threaded needle resting on the cloth below the hoop, its floss running back to the last stitch
  const { x: hx, y: hy, Ro } = hp, fab = V.fab;
  const ne0 = [hx + Ro * 0.78 + 30, hy + Ro * 0.62 + 40], ne1 = [ne0[0] + 250, ne0[1] + 70];
  const eye = needle(gb, ne0[0], ne0[1], ne1[0], ne1[1], 3.2);
  const last = V.lastStitch;
  if (last) {
    const [lx, ly] = fab.hole(last[0], last[1]), pts = [];
    for (let k = 0; k <= 40; k++) {
      const s = k / 40, bend = Math.sin(PI * s) * 120;
      pts.push([lx + (eye[0] - lx) * s + bend * 0.5, ly + (eye[1] - ly) * s - bend * 0.25 + Math.sin(s * 11) * 6]);
    }
    pts.push([eye[0] - 26, eye[1] + 10], [eye[0] - 60, eye[1] + 38], [eye[0] - 70, eye[1] + 80]);
    gb.thread(pts, { r: fab.cs * 0.24, c: C(last[2]), drape: true, plies: 2, dive0: 1, dive1: 0, seed: 77, gloss: 0.8, above: 0.5, pitch: 2.2, twist: 0.3, soft: 1 });
  }
}

// In the close views the needle is parked in the cloth near the edge, its floss trailing back to the work.
function needleParked(gb, V) {
  const { fab, kind } = V, cs = fab.cs, W = gb.W, H = gb.H;
  const x0 = W * (kind === "valley" ? 0.83 : 0.78), y0 = H * (kind === "valley" ? 0.86 : 0.93), L = kind === "valley" ? 330 : 420;
  const a = kind === "valley" ? -0.35 : -0.3;
  const eye = needle(gb, x0, y0, x0 + Math.cos(a) * L, y0 + Math.sin(a) * L, kind === "valley" ? 5 : 6);
  const [u0, v0] = fab.raw(eye[0], eye[1]), hu = Math.round(u0 - 3), hv = Math.round(v0 + 1.5), P = fab.hole(hu, hv);
  const Cc = col(kind === "valley" ? 3346 : 3041), pts = [];
  for (let k = 0; k <= 24; k++) {
    const s = k / 24, bend = Math.sin(PI * s) * cs * 1.6;
    pts.push([eye[0] + (P[0] - eye[0]) * s - bend * 0.3, eye[1] + (P[1] - eye[1]) * s + bend]);
  }
  gb.thread(pts, { r: cs * 0.15, c: Cc, drape: true, plies: 2, dive0: 0, dive1: 1, seed: 91, gloss: 0.8, above: 0.4, pitch: 2.2, twist: 0.3, soft: 1 });
  const tail = [[eye[0], eye[1]], [eye[0] + cs * 0.9, eye[1] - cs * 0.9], [eye[0] + cs * 1.5, eye[1] - cs * 2.2], [eye[0] + cs * 1.2, eye[1] - cs * 3.1]];
  gb.thread(tail, { r: cs * 0.15, c: Cc, drape: true, plies: 2, dive0: 0, dive1: 0, seed: 92, gloss: 0.8, above: 0.4, pitch: 2.2, twist: 0.3, soft: 1 });
}
