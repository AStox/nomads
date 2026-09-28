// The simulation's things, people and wolves as pixel sprites, painted like sprites.js and life.js: upper-left key
// light, short ramps, ordered dither, selective outline. Every export returns a Spr anchored at its ground contact
// point (bottom centre). Sprites with a footprint also carry `foot`: how many px above the anchor the footprint's
// centre sits, so drawing one centred on a spot means blitting it at (sx, sy + foot).
import { P, ramp, SHADOW } from "./pal.js";
import { Spr, dith, h2 } from "./px.js";
import * as SP from "./sprites.js";
import * as LF from "./life.js";
import { cairn, mushrooms as LFmushrooms, rv, solid, blob, seg, rod, rows, under, vnoise } from "./life.js";

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const pick = (a, u) => a[Math.min(a.length - 1, Math.floor(u * a.length))];

// ---------------------------------------------------------------------------------------------------- iso splatting

// The morning key light in tile axes (u screen down-right, v down-left, z up), as main.js lights the terrain.
const L3 = [-0.958 * Math.cos(0.9), 0.287 * Math.cos(0.9), Math.sin(0.9)];
// Sprites with a front can be turned in 45 degree steps. The model turns, not the light, so the light stays upper
// left relative to the camera. ROT is set only while one exported sprite is being built.
let ROT = { c: 1, s: 0, k: 0 };
const turn = (u, v) => [u * ROT.c - v * ROT.s, u * ROT.s + v * ROT.c];
function turned(dir, build) {
  const k = ((Math.round(dir) % 8) + 8) % 8, a = (k * Math.PI) / 4, was = ROT;
  ROT = { c: Math.cos(a), s: Math.sin(a), k };
  try { return build(); } finally { ROT = was; }
}
// The screen depth of a box footprint's front corner below its centre, once turned.
const boxFoot = (hu, hv) => Math.max(...[[1, 1], [1, -1], [-1, 1], [-1, -1]].map(([a, b]) => { const [u, v] = turn(a * hu, b * hv); return (u + v) / 2; }));
const shadeOf = (n) => { const [u, v] = turn(n[0], n[1]); return (u * L3[0] + v * L3[1] + n[2] * L3[2]) / (Math.hypot(u, v, n[2]) || 1); };

// Things with volume are splatted point by point in u, v, z (art px) into a depth buffer; nearness grows with u+v
// and with height the way a 2:1 view from 30 degrees up sees it.
function iso(uM, vM, zM) {
  if (ROT.k) uM = vM = Math.hypot(uM, vM);
  const W = Math.ceil(2 * (uM + vM)) + 10, up = Math.ceil(zM + (uM + vM) / 2) + 5, dn = Math.ceil((uM + vM) / 2) + 5;
  const S = new Spr(W, up + dn, W >> 1, up);
  S.Z = new Float32Array(S.w * S.h).fill(-1e9);
  return S;
}
const sx = (S, u, v) => { const [a, b] = turn(u, v); return Math.floor(S.ax + 0.5 + a - b); };
const sy = (S, u, v, z) => { const [a, b] = turn(u, v); return Math.floor(S.ay + 0.5 + (a + b) * 0.5 - z); };
function dot(S, u, v, z, c, x = sx(S, u, v), y = sy(S, u, v, z)) {
  if (c < 0 || x < 0 || y < 0 || x >= S.w || y >= S.h) return;
  const [a, b] = turn(u, v), i = y * S.w + x, n = a + b + 0.667 * z;
  if (n < S.Z[i]) return;
  S.Z[i] = n; S.p[i] = c;
}
// A flat patch o + s*a + t*b; paint(s, t, x, y, shade) gets s and t in px along a and b, returns an index or -1.
function quad(S, o, a, b, n, paint) {
  const la = Math.hypot(...a), lb = Math.hypot(...b), na = Math.ceil(la * 2.8) + 1, nb = Math.ceil(lb * 2.8) + 1, sh = shadeOf(n);
  for (let i = 0; i <= na; i++)
    for (let j = 0; j <= nb; j++) {
      const s = i / na, t = j / nb, u = o[0] + a[0] * s + b[0] * t, v = o[1] + a[1] * s + b[1] * t, z = o[2] + a[2] * s + b[2] * t;
      const x = sx(S, u, v), y = sy(S, u, v, z);
      dot(S, u, v, z, paint(s * la, t * lb, x, y, sh), x, y);
    }
}
// A surface of revolution about (cu, cv); prof(t) -> [radius, z] for t in 0..1, len its length in px.
// paint(angle, along, x, y, shade, arc). Angle 0 faces +u, PI/2 faces +v; the lit side is near 3PI/4.
function rev(S, cu, cv, prof, len, paint) {
  const nt = Math.ceil(len * 2.8) + 1;
  for (let j = 0; j <= nt; j++) {
    const t = j / nt, [r, z] = prof(t), [r2, z2] = prof(Math.min(1, t + 0.01)), [r1, z1] = prof(Math.max(0, t - 0.01));
    const dr = r2 - r1, dz = z2 - z1, na = Math.ceil(r * 2 * Math.PI * 1.5) + 6;
    for (let i = 0; i < na; i++) {
      const a = (i / na) * 2 * Math.PI, ca = Math.cos(a), sa = Math.sin(a), u = cu + r * ca, v = cv + r * sa, x = sx(S, u, v), y = sy(S, u, v, z);
      dot(S, u, v, z, paint(a, t * len, x, y, shadeOf([dz * ca, dz * sa, -dr]), r * a), x, y);
    }
  }
}
// The upper part of an ellipsoid; paint(x, y, shade, nz).
function ball(S, cu, cv, cz, ru, rq, rz, paint) {
  const n = Math.ceil(Math.max(ru, rq, rz) * 5) + 6;
  for (let j = 0; j <= n; j++) {
    const ph = (j / n) * Math.PI * 0.62, sp = Math.sin(ph), cp = Math.cos(ph), na = Math.ceil(Math.max(ru, rq) * sp * 2 * Math.PI * 1.5) + 4;
    for (let i = 0; i < na; i++) {
      const a = (i / na) * 2 * Math.PI, nu = Math.cos(a) * sp, nv = Math.sin(a) * sp, u = cu + ru * nu, v = cv + rq * nv, z = cz + rz * cp;
      if (z < -0.2) continue;
      const x = sx(S, u, v), y = sy(S, u, v, z);
      dot(S, u, v, z, paint(x, y, shadeOf([nu / ru, nv / rq, cp / rz]), cp), x, y);
    }
  }
}
// A cylinder lying along "u" or "v" from a0 to a1, capped at both ends (the depth buffer hides the far one).
// paint(along, angle, x, y, shade), cap(radial 0..1, x, y).
function cyl(S, axis, a0, a1, c, cz, r, paint, cap) {
  const nL = Math.ceil((a1 - a0) * 2.8) + 1, na = Math.ceil(r * 2 * Math.PI * 1.5) + 6;
  const at = (al, q, z) => (axis === "u" ? [al, q, z] : [q, al, z]);
  for (let j = 0; j <= nL; j++)
    for (let i = 0; i < na; i++) {
      const al = a0 + ((a1 - a0) * j) / nL, g = (i / na) * 2 * Math.PI, [u, v, z] = at(al, c + r * Math.cos(g), cz + r * Math.sin(g));
      const x = sx(S, u, v), y = sy(S, u, v, z);
      dot(S, u, v, z, paint(al - a0, g, x, y, shadeOf(axis === "u" ? [0, Math.cos(g), Math.sin(g)] : [Math.cos(g), 0, Math.sin(g)])), x, y);
    }
  if (cap)
    for (const end of [a0 - 0.05, a1 + 0.05])
      for (let rr = 0; rr <= r; rr += 0.3)
        for (let i = 0; i < na; i++) {
          const g = (i / na) * 2 * Math.PI, [u, v, z] = at(end, c + rr * Math.cos(g), cz + rr * Math.sin(g));
          const x = sx(S, u, v), y = sy(S, u, v, z);
          dot(S, u, v, z, cap(rr / Math.max(0.5, r), x, y), x, y);
        }
}
// An upright box, every face drawn so it holds up from any side. top(s, t, x, y, shade), side(a, z, x, y, shade).
function box(S, u0, u1, v0, v1, z0, z1, top, side) {
  const du = u1 - u0, dv = v1 - v0, dz = z1 - z0;
  quad(S, [u0, v0, z1], [du, 0, 0], [0, dv, 0], [0, 0, 1], top);
  quad(S, [u0, v1, z0], [du, 0, 0], [0, 0, dz], [0, 1, 0], side);
  quad(S, [u0, v0, z0], [du, 0, 0], [0, 0, dz], [0, -1, 0], side);
  quad(S, [u1, v0, z0], [0, dv, 0], [0, 0, dz], [1, 0, 0], side);
  quad(S, [u0, v0, z0], [0, dv, 0], [0, 0, dz], [-1, 0, 0], side);
}
// A height field z = f(u, v) over a box (NaN where there is none): roofs, patches on the ground.
function field(S, u0, u1, v0, v1, f, paint) {
  for (let u = u0; u <= u1; u += 0.33)
    for (let v = v0; v <= v1; v += 0.33) {
      const z = f(u, v);
      if (!(z >= 0)) continue;
      const gu = (f(u + 0.2, v) - f(u - 0.2, v)) / 0.4, gv = (f(u, v + 0.2) - f(u, v - 0.2)) / 0.4, x = sx(S, u, v), y = sy(S, u, v, z);
      dot(S, u, v, z, paint(u, v, z, x, y, shadeOf([-(gu || 0), -(gv || 0), 1])), x, y);
    }
}
// A thin straight thing from p to q (u, v, z), one pixel wide.
function line(S, p, q, c) {
  const n = Math.ceil(Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]) * 3) + 1;
  for (let i = 0; i <= n; i++) { const t = i / n; dot(S, p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t, p[2] + (q[2] - p[2]) * t, typeof c === "function" ? c(t) : c); }
}
// Outline, trim the empty margin, and move the anchor from the footprint centre down to its front edge.
function done(S, foot, edge = P.ink) {
  S.Z = null;
  if (edge >= 0) S.outline(edge, true);
  const ay = S.ay + Math.round(foot);
  let x0 = S.w, x1 = -1, y0 = S.h, y1 = -1;
  for (let y = 0; y < S.h; y++) for (let x = 0; x < S.w; x++) if (S.p[y * S.w + x] !== 255) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  if (x1 < 0) { S.foot = 0; return S; }
  x0 = Math.min(x0, S.ax); x1 = Math.max(x1, S.ax); y1 = Math.max(y1, ay);
  const T = new Spr(x1 - x0 + 1, y1 - y0 + 1, S.ax - x0, ay - y0);
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) T.p[(y - y0) * T.w + x - x0] = S.p[y * S.w + x];
  T.foot = Math.round(foot);
  return T;
}
// Copy sprite T into S with T's anchor at (x, y).
function stamp(S, T, x, y) {
  for (let j = 0; j < T.h; j++)
    for (let i = 0; i < T.w; i++) {
      const c = T.p[j * T.w + i], X = x - T.ax + i, Y = y - T.ay + j;
      if (c !== 255 && X >= 0 && Y >= 0 && X < S.w && Y < S.h) S.p[Y * S.w + X] = c;
    }
}
// Grow a sprite's canvas upward by n rows, keeping its anchor on the same pixel.
function grow(S, n) {
  const T = new Spr(S.w, S.h + n, S.ax, S.ay + n);
  T.p.set(S.p, n * S.w);
  T.foot = S.foot;
  return T;
}

// ---------------------------------------------------------------------------------------------------- materials

const MAT = {
  sticks: { wall: ramp("d0", "d1", "d2", "d3", "d4"), wt: "twigs", roof: ramp("d1", "m1", "d2", "m2", "d3", "d4"), rt: "twigs" },
  reeds: { wall: ramp("a0", "a1", "a2", "a3", "s2"), wt: "thatch", roof: ramp("a0", "a1", "a2", "a3", "s2"), rt: "thatch" },
  logs: { wall: ramp("d0", "d1", "d2", "d3", "d4"), wt: "logs", roof: ramp("a0", "a1", "a2", "a3"), rt: "thatch" },
  planks: { wall: ramp("d2", "d3", "d4", "d5", "s2"), wt: "boards", roof: ramp("d0", "f0", "d1", "d2", "d3"), rt: "shingle" },
  stone: { wall: ramp("r1", "r2", "r3", "r4", "r5"), wt: "blocks", roof: ramp("r0", "r1", "r2", "r3"), rt: "shingle" },
  brick: { wall: ramp("d0", "f0", "red", "k1"), wt: "bricks", roof: ramp("r0", "r1", "r2", "r3"), rt: "shingle" },
  hide: { wall: ramp("d1", "d2", "d3", "d4", "d5"), wt: "stitch", roof: ramp("d1", "d2", "d3", "d4", "d5"), rt: "stitch" },
  clay: { wall: ramp("d1", "k2", "d3", "k1", "d4", "d5"), wt: "smooth", roof: ramp("a0", "a1", "a2", "a3"), rt: "thatch" },
};
const mod = (a, m) => ((a % m) + m) % m;
// Offsets to a ramp position from a material's texture; a runs along the surface, z up it (or down a roof), in px.
function grain(kind, a, z, seed, k) {
  switch (kind) {
    case "logs": { const cr = Math.max(2, 2.3 * k), f = mod(z, cr) / cr; return f > 0.66 ? 0.7 : f < 0.3 ? -1.1 : 0; }
    case "boards": { const bw = Math.max(2, 2.2 * k); return mod(a, bw) < 0.7 ? -1 : (h2(Math.floor(a / bw), 1, seed) - 0.5) * 0.7; }
    case "blocks": {
      const bh = Math.max(2, 2.2 * k), row = Math.floor(z / bh), bw = bh * 1.7, off = (row & 1) * bw * 0.5 + h2(row, 3, seed) * bw * 0.4;
      const col = Math.floor((a + off) / bw), fz = z - row * bh, fa = a + off - col * bw;
      return fz < 0.6 || fa < 0.6 ? -1.4 : (h2(row, col, seed) - 0.5) + (fz > bh - 0.9 ? 0.5 : 0);
    }
    case "bricks": {
      const bh = Math.max(1.5, 1.4 * k), row = Math.floor(z / bh), bw = bh * 2.2, off = (row & 1) * bw * 0.5;
      return z - row * bh < 0.5 || mod(a + off, bw) < 0.5 ? 1.3 : (h2(row, Math.floor((a + off) / bw), seed) - 0.5) * 0.7;
    }
    case "thatch": return (h2(Math.floor(a * 1.1), Math.floor(z / 2.5), seed) - 0.5) * 0.9 + (mod(z, 3) < 0.8 ? -0.8 : 0.15);
    case "twigs": return (mod(a * 0.8 + z, 2.6) < 0.9 ? -0.9 : 0.2) + (h2(Math.floor(a), Math.floor(z), seed) - 0.5) * 0.6;
    case "stitch": { const pw = Math.max(3, 4.5 * k); return mod(a, pw) < 0.7 ? -1 : (h2(Math.floor(a / pw), 2, seed) - 0.5) * 0.7; }
    case "smooth": return (vnoise(a * 0.3 + z * 0.23, seed) - 0.5) * 0.5;
    case "leafy": return (h2(Math.floor(a / 1.6), Math.floor(z / 1.6), seed) - 0.5) * 1.5;
    case "shingle": {
      const rh = Math.max(1.6, 1.9 * k), row = Math.floor(z / rh);
      return (z - row * rh > rh - 0.75 ? -1.1 : 0.1) + (h2(row, Math.floor((a + (row & 1) * rh * 0.7) / (rh * 1.4)), seed) - 0.5) * 0.7;
    }
  }
  return 0;
}
const surfer = (r, kind, seed, k, lift = 0) => (a, z, x, y, sh) => dith(r, (r.length - 1) * 0.5 + 0.3 + lift + sh * r.length * 0.42 + grain(kind, a, z, seed, k), x, y);

// A pennant in the owner's color on a short pole above the sprite's highest point.
function pennantOn(S, c, k) {
  if (c < 0) return S;
  const h = Math.max(2, Math.round(2.6 * k)), fw = Math.max(2, Math.round(2 * k));
  let top = 0, x = S.ax;
  outer: for (; top < S.h; top++) for (let i = 0; i < S.w; i++) if (S.p[top * S.w + i] !== 255 && S.p[top * S.w + i] !== P.ink) { x = i; break outer; }
  const T = grow(S, h + 1), y = top + h + 1;
  for (let j = 1; j <= h + 1; j++) T.set(x, y - j, P.d1);
  for (let i = 1; i <= fw; i++) { T.set(x + i, y - h - 1, c); if (i < fw) T.set(x + i, y - h, SHADOW[c]); }
  return T;
}
// A doorway or window: a dark opening with a lit jamb on a +v wall ("v") or a +u wall ("u").
function opening(S, u, v, z, w, h, facing) {
  for (let s = -w; s <= w; s += 0.3)
    for (let t = 0; t <= h; t += 0.3) {
      const uu = facing === "v" ? u + s : u + 0.15, vv = facing === "v" ? v + 0.15 : v + s;
      dot(S, uu, vv, z + t, Math.abs(s) > w - 0.35 || t > h - 0.35 ? P.d3 : P.d0);
    }
}
function roundOpening(S, R, ang, w, h) {
  for (let a = ang - w / R; a <= ang + w / R; a += 0.3 / R)
    for (let z = 0; z <= h; z += 0.3) dot(S, (R + 0.2) * Math.cos(a), (R + 0.2) * Math.sin(a), z, Math.abs(a - ang) > (w - 0.35) / R || z > h - 0.35 ? P.d3 : P.d0);
}

// ----------------------------------------------------------------------------------------------------- shelters

// tier 0 a heap of the material, 1 a lean-to, 2 a hut (a tent for hide), 3 a cabin or lodge. hpx: the height of a
// tier 2 hut at this zoom; the other tiers scale from it. flag: an optional palette index for the owner's pennant.
// dir 0..7 turns it in 45 degree steps clockwise on screen: the door faces down-left at 0, left at 1, up-left at 2,
// up at 3, up-right at 4, right at 5, down-right at 6 and down (toward the camera) at 7.
export function shelter(tier = 2, style = "sticks", hpx = 16, seed = 0, flag = -1, dir = 0) {
  return turned(dir, () => building(tier, style, hpx, seed, flag));
}
function building(tier, style, hpx, seed, flag) {
  tier = clamp(tier | 0, 0, 3);
  const st = MAT[style] ? style : "sticks", k = Math.max(0.45, hpx / 16);
  let S;
  if (tier === 0) return heap(st, hpx * 0.42, seed);
  if (tier === 1) S = leanto(st, k, seed);
  else if (st === "hide") S = tent(k * (tier === 3 ? 1.3 : 1), tier, seed);
  else if (tier === 2) S = st === "reeds" || st === "clay" ? dome(st, k, seed) : st === "sticks" || st === "stone" ? roundhut(st, k, seed) : house(st, k, 5.2 * k, 4 * k, 6 * k, 6.5 * k, seed, false);
  else S = st === "clay" ? adobe(k, seed) : st === "reeds" || st === "sticks" ? longhouse(st, k, seed) : house(st, k, 7.5 * k, 5 * k, 7 * k, 7 * k, seed, true);
  return pennantOn(S, flag, k);
}

// Four walls, gable ends on the u sides, a gabled roof with eaves, a door on +v; big ones get windows and a chimney.
function house(st, k, hu, hv, hw, rise, seed, big) {
  const M = MAT[st], o = Math.max(0.8, k), S = iso(hu + o + 2, hv + o + 2, hw + rise + 6 * k);
  const wall = surfer(M.wall, M.wt, seed, k), roof = surfer(M.roof, M.rt, seed + 1, k, 0.3);
  const gable = (a, z, x, y, sh) => (z > hw + rise * (1 - Math.abs(a - hv) / hv) ? -1 : wall(a, z, x, y, sh));
  for (const s of [1, -1]) {
    quad(S, [-hu, s * hv, 0], [2 * hu, 0, 0], [0, 0, hw], [0, s, 0], wall);
    quad(S, [s * hu, -hv, 0], [0, 2 * hv, 0], [0, 0, hw + rise], [s, 0, 0], gable);
  }
  if (st === "logs")
    for (const [cu, cv] of [[1, 1], [1, -1], [-1, 1], [-1, -1]])
      for (let z = 1; z < hw; z += Math.max(2, 2.3 * k)) ball(S, cu * (hu + 0.5), cv * (hv + 0.5), z, 0.7 * k, 0.7 * k, 0.6 * k, (x, y, sh) => (sh > 0.2 ? P.d5 : P.d4));
  const ridge = hw + rise, fall = rise / hv;
  field(S, -hu - o, hu + o, -hv - o, hv + o, (u, v) => ridge - Math.abs(v) * fall, (u, v, z, x, y, sh) =>
    Math.abs(v) > hv + o - 0.5 || Math.abs(u) > hu + o - 0.5 ? dith(M.roof, 0.6 + sh, x, y) : roof(u, (Math.abs(v) / hv) * Math.hypot(rise, hv), x, y, sh));
  opening(S, -hu * 0.15, hv, 0, Math.max(0.8, 1.1 * k), Math.min(hw - 1, Math.max(2, 3.6 * k)), "v");
  if (big) {
    opening(S, hu * 0.55, hv, hw * 0.4, Math.max(0.5, 0.8 * k), Math.max(1, 1.6 * k), "v");
    opening(S, hu, hv * 0.1, hw * 0.4, Math.max(0.5, 0.8 * k), Math.max(1, 1.6 * k), "u");
    const cu = hu * 0.45, cw = Math.max(0.8, 1.1 * k), top = ridge + 2.5 * k, cm = st === "brick" ? "brick" : "stone";
    const chim = surfer(MAT[cm].wall, MAT[cm].wt, seed + 2, k * 0.6);
    for (const s of [1, -1]) {
      quad(S, [cu - cw, s * cw, ridge - cw * fall - 1], [2 * cw, 0, 0], [0, 0, top - ridge + cw * fall + 1], [0, s, 0], chim);
      quad(S, [cu + s * cw, -cw, ridge - cw * fall - 1], [0, 2 * cw, 0], [0, 0, top - ridge + cw * fall + 1], [s, 0, 0], chim);
    }
    quad(S, [cu - cw, -cw, top], [2 * cw, 0, 0], [0, 2 * cw, 0], [0, 0, 1], () => P.r1);
  }
  return done(S, boxFoot(hu, hv));
}

function roundhut(st, k, seed) {
  const M = MAT[st], R = 4.8 * k, hw = (st === "stone" ? 5 : 4.4) * k, apex = hw + 7 * k, S = iso(R + 2, R + 2, apex + 2);
  const roofR = st === "stone" ? MAT.reeds.roof : M.roof, wall = surfer(M.wall, M.wt, seed, k), thatch = surfer(roofR, st === "stone" ? "thatch" : M.rt, seed + 1, k, 0.2);
  rev(S, 0, 0, (t) => [R, t * hw], hw, (a, z, x, y, sh, arc) => wall(arc, z, x, y, sh));
  const eave = R + Math.max(1, 1.2 * k), z0 = hw - 0.8 * k;
  rev(S, 0, 0, (t) => [eave * (1 - t), z0 + t * (apex - z0)], Math.hypot(eave, apex - z0), (a, d, x, y, sh, arc) => (d < 0.6 ? dith(roofR, 0.5 + sh, x, y) : thatch(arc, d, x, y, sh)));
  roundOpening(S, R, 1.55, Math.max(1.1, 1.3 * k), Math.min(hw - 0.6, 3.8 * k));
  return done(S, R);
}

function dome(st, k, seed) {
  const M = MAT[st], R = (st === "reeds" ? 5.2 : 5) * k, H = (st === "reeds" ? 9 : 7) * k, S = iso(R + 2, R + 2, H + 2);
  const skin = surfer(M.wall, M.wt, seed, k, st === "clay" ? 0.3 : 0);
  // reeds bulge like a beehive, bound in hoops; clay sits lower and rounder with a smoke hole
  const prof = st === "reeds" ? (t) => [R * Math.pow(Math.cos(t * Math.PI * 0.5), 0.8) * (1 + 0.12 * Math.sin(t * Math.PI)), H * Math.sin(t * Math.PI * 0.5)] : (t) => [R * Math.cos(t * Math.PI * 0.5), H * Math.sin(t * Math.PI * 0.5)];
  rev(S, 0, 0, prof, H * 1.6, (a, d, x, y, sh, arc) => skin(arc, d, x, y, sh));
  if (st === "reeds") for (let b = 1; b <= 3; b++) { const [r, z] = prof(b / 4.4); rev(S, 0, 0, () => [r + 0.3, z], 0.1, (a, d, x, y, sh) => dith(M.wall, 0.4 + sh, x, y)); }
  roundOpening(S, R * 0.98, 1.6, Math.max(1.1, 1.3 * k), Math.max(2, 3.4 * k));
  if (st === "clay") ball(S, 0, 0, H - 0.4, 0.9 * k, 0.9 * k, 0.4, () => P.d0);
  return done(S, R);
}

function tent(k, tier, seed) {
  const R = 4.8 * k, H = 11.5 * k, S = iso(R + 3, R + 3, H + 5 * k), skin = surfer(MAT.hide.wall, "stitch", seed, k, 0.4), sl = Math.hypot(R, H);
  rev(S, 0, 0, (t) => [R * (1 - t), t * H], sl, (a, d, x, y, sh, arc) => {
    if (tier >= 3) {
      // a painted zigzag band round the lodge, over a dark stripe
      const z = (d / sl) * H, band = H * 0.3, zz = Math.abs((mod(arc / (1.6 * k), 2)) - 1) * 1.4 * k;
      if (z > band + zz && z < band + zz + 1.2 * k) return sh > 0 ? P.f1 : P.f0;
      if (z > band - 1.4 * k && z < band - 0.6 * k) return P.d1;
    }
    return skin(arc, d, x, y, sh);
  });
  // the door flap pinned open on the lit side
  for (let a = 1.3; a <= 1.9; a += 0.02)
    for (let z = 0; z < H * 0.34 * (1 - Math.abs(a - 1.6) / 0.3); z += 0.3) { const r = R * (1 - z / H) + 0.2; dot(S, r * Math.cos(a), r * Math.sin(a), z, Math.abs(a - 1.6) > 0.26 ? P.d3 : P.d1); }
  // poles crossing above the smoke hole
  const poles = tier >= 3 ? 6 : 4;
  for (let i = 0; i < poles; i++) {
    const a = (i / poles) * Math.PI * 2 + 0.4 + rv(seed, 3), L = H + 2.5 * k + h2(i, seed, 4) * 1.5 * k;
    line(S, [0, 0, H * 0.85], [-(L - H) * 0.28 * Math.cos(a), -(L - H) * 0.28 * Math.sin(a), L], (t) => (t > 0.85 ? P.d3 : P.d1));
  }
  return done(S, R);
}

// A roof leaning from a high back edge down to the ground in front, on two posts. Its inside (the open ends, and the
// underside when turned away) stays in the material's own shade tones with a lit rim, never a black hole.
function leanto(st, k, seed) {
  const M = MAT[st], hu = 4.6 * k, hv = 3.4 * k, hl = 7 * k, S = iso(hu + 2, hv + 2, hl + 4 * k);
  const kind = { sticks: "twigs", reeds: "thatch", logs: "logs", planks: "boards", stone: "shingle", brick: "shingle", hide: "stitch", clay: "smooth" }[st];
  const R0 = st === "reeds" || st === "hide" ? M.roof : M.wall, roof = surfer(R0, kind, seed, k, 0.25), downSlope = st === "logs" || st === "planks";
  const top = R0.length - 2, slope = Math.hypot(hl, 2 * hv);
  // shade in steps 1..2 of the ramp: index 0 of the darker ramps is near black
  const shade = (a, z, x, y, lift = 0) => dith(R0, 1.1 + lift + grain(kind, a, z, seed, k) * 0.45, x, y);
  const [nu, nv] = turn(0, hl / (2 * hv)), under = nu + nv + 0.667 < 0, rafter = Math.max(2, 2.6 * k);
  field(S, -hu, hu, -hv, hv, (u, v) => (hl * (hv - v)) / (2 * hv), (u, v, z, x, y, sh) => {
    const d = ((v + hv) / (2 * hv)) * slope;
    if (under) {
      if (Math.abs(u) > hu - 0.7 || Math.abs(v) > hv - 0.7) return R0[top];
      if (mod(u + hu, rafter) < 0.6) return R0[2];
      return shade(u, d, x, y, (d / slope) * 0.8);
    }
    if (st === "sticks" && h2(Math.floor(u), Math.floor(d), seed + 5) < 0.3) return dith(MAT.sticks.roof, 2 + sh * 2, x, y);
    return downSlope ? roof(d, u, x, y, sh) : roof(u, d, x, y, sh);
  });
  const masonry = st === "stone" || st === "brick" || st === "clay", wall = surfer(M.wall, M.wt, seed, k);
  const end = (a, z, x, y, sh) => {
    const edge = hl * (1 - a / (2 * hv));
    if (z > edge - 0.3) return -1;
    if (z > edge - 1) return R0[top];
    if (masonry && z < hl * 0.4) return wall(a, z, x, y, sh);
    return z < 0.6 ? P.d2 : shade(a, z, x, y, (z / hl) * 0.6);
  };
  for (const s of [1, -1]) quad(S, [s * (hu - 0.4), -hv, 0], [0, 2 * hv, 0], [0, 0, hl], [s, 0, 0], end);
  const pole = hl + (st === "hide" ? 2.5 * k : 0.6);
  line(S, [-hu + 0.3, -hv + 0.3, 0], [-hu + 0.3, -hv + 0.3, pole], P.d4);
  line(S, [hu - 0.3, -hv + 0.3, 0], [hu - 0.3, -hv + 0.3, pole], P.d3);
  if (st === "hide") line(S, [-hu, -hv - 0.4, hl + 0.3], [hu, -hv - 0.4, hl + 0.3], P.d3);
  return done(S, boxFoot(hu, hv));
}

// A flat-roofed adobe block: parapet, roof-beam ends through the wall, a ladder up the lit side.
function adobe(k, seed) {
  const hu = 7 * k, hv = 5 * k, hw = 8 * k, M = MAT.clay, S = iso(hu + 2, hv + 3, hw + 3), wall = surfer(M.wall, "smooth", seed, k, 0.35);
  for (const s of [1, -1]) {
    quad(S, [-hu, s * hv, 0], [2 * hu, 0, 0], [0, 0, hw], [0, s, 0], wall);
    quad(S, [s * hu, -hv, 0], [0, 2 * hv, 0], [0, 0, hw], [s, 0, 0], wall);
  }
  quad(S, [-hu, -hv, hw], [2 * hu, 0, 0], [0, 2 * hv, 0], [0, 0, 1], (a, b, x, y) => (a < 1 || b < 1 || a > 2 * hu - 1 || b > 2 * hv - 1 ? M.wall[5] : a < 2 || b < 2 ? M.wall[1] : dith(M.wall, 3.4, x, y)));
  for (const s of [1, -1]) for (let u = -hu + 1.5 * k; u < hu - 1; u += 2.4 * k) line(S, [u, s * hv, hw - 1.4 * k], [u, s * (hv + 1.2 * k), hw - 1.4 * k], P.d1);
  opening(S, -hu * 0.35, hv, 0, Math.max(0.8, 1.1 * k), 3.8 * k, "v");
  opening(S, hu * 0.45, hv, hw * 0.45, Math.max(0.5, 0.8 * k), 1.6 * k, "v");
  opening(S, hu, 0, hw * 0.45, Math.max(0.5, 0.8 * k), 1.6 * k, "u");
  const lu = hu * 0.1, rail = (s, t) => [lu + s, hv + 2.2 * k - t * 0.22, t];
  for (const s of [0, 1.6 * k]) line(S, rail(s, 0), rail(s, hw + 2 * k), P.d3);
  for (let t = 1.5 * k; t <= hw + 1.5 * k; t += 2 * k) line(S, rail(0, t), rail(1.6 * k, t), P.d2);
  return done(S, boxFoot(hu, hv));
}

// A long low house under a big hipped roof of thatch or leaves reaching nearly to the ground.
function longhouse(st, k, seed) {
  const M = MAT[st], hu = 8 * k, hv = 4.4 * k, hw = (st === "sticks" ? 3.6 : 2.6) * k, rise = 8.5 * k, o = 1.2 * k, S = iso(hu + o + 2, hv + o + 2, hw + rise + 2);
  const wall = surfer(st === "sticks" ? MAT.sticks.wall : MAT.reeds.wall, st === "sticks" ? "twigs" : "thatch", seed, k);
  const roof = surfer(M.roof, M.rt, seed + 1, k, 0.25);
  for (const s of [1, -1]) {
    quad(S, [-hu, s * hv, 0], [2 * hu, 0, 0], [0, 0, hw], [0, s, 0], wall);
    quad(S, [s * hu, -hv, 0], [0, 2 * hv, 0], [0, 0, hw], [s, 0, 0], wall);
  }
  field(S, -hu - o, hu + o, -hv - o, hv + o, (u, v) => Math.min(hw + rise, hw + rise * Math.min(1 - Math.abs(v) / hv, (hu - Math.abs(u)) / hv + 0.25)), (u, v, z, x, y, sh) =>
    Math.abs(v) > hv + o - 0.6 || Math.abs(u) > hu + o - 0.6 ? dith(M.roof, 0.5 + sh, x, y) : roof(u + v * 0.3, (hw + rise - z) * 1.1, x, y, sh));
  opening(S, -hu * 0.1, hv, 0, Math.max(0.8, 1.1 * k), Math.max(1.5, hw - 0.4), "v");
  opening(S, hu, 0, 0, Math.max(0.8, k), Math.max(1.5, hw - 0.4), "u");
  return done(S, boxFoot(hu, hv));
}

// -------------------------------------------------------------------------------------------------------- heaps

const ROCK = ramp("r0", "r1", "r2", "r3", "r4", "r5"), BARK = ramp("d0", "d1", "d2", "d3", "d4");
// A heap of material or stores; size: its height in px.
function heap(what, size, seed) {
  const k = Math.max(0.35, size / 6), R = 4 * k, S = iso(R + 3, R + 3, size + 3);
  switch (what) {
    case "logs": {
      const rr = Math.max(0.9, 1.2 * k), L = 3.6 * k;
      for (const [v, z] of [[-1.1 * rr, rr], [1.1 * rr, rr], [0, rr * 2.7]])
        cyl(S, "u", -L, L, v, z, rr, (a, g, x, y, sh) => dith(BARK, 2 + sh * 2.2 + (h2(Math.floor(a), 3, seed) < 0.2 ? -0.7 : 0), x, y), (q) => (q > 0.72 ? P.d3 : q < 0.3 ? P.d4 : P.d5));
      break;
    }
    case "planks": {
      const pr = ramp("d2", "d3", "d4", "d5");
      for (let i = 0; i < 4; i++) {
        const z0 = i * 0.9 * k, du = (h2(i, seed, 1) - 0.5) * k, dv = (h2(i, seed, 2) - 0.5) * k, L = 3.8 * k, w = 1.6 * k, t = 0.8 * k;
        box(S, -L + du, L + du, -w + dv, w + dv, z0, z0 + t, (a, b, x, y) => dith(pr, 2.4 + (mod(a, 3) < 0.5 ? -0.6 : 0), x, y), (a, b, x, y, sh) => dith(pr, 1.6 + sh * 1.6, x, y));
      }
      break;
    }
    case "sticks": {
      for (let i = 0; i < 9; i++) {
        const a = h2(i, seed, 1) * Math.PI, L = (2.6 + h2(i, seed, 2) * 1.6) * k, z = 0.4 + (i / 9) * size * 0.55, cu = (h2(i, seed, 3) - 0.5) * 2 * k, cv = (h2(i, seed, 4) - 0.5) * 2 * k;
        for (let t = -L; t <= L; t += 0.3) {
          const u = cu + Math.cos(a) * t, v = cv + Math.sin(a) * t, zz = z + (L - Math.abs(t)) * 0.15, x = sx(S, u, v), y = sy(S, u, v, zz);
          dot(S, u, v, zz, i & 1 ? P.d3 : P.d4, x, y); dot(S, u, v, zz - 0.8, P.d1, x, y + 1);
        }
      }
      break;
    }
    case "reeds": {
      const rr = Math.max(0.8, 1.1 * k), L = 4 * k, th = MAT.reeds.wall;
      for (const [v, z] of [[-rr, rr], [rr, rr], [0, rr * 2.6]])
        cyl(S, "u", -L, L, v, z, rr, (a, g, x, y, sh) => (Math.abs(a - L) < 0.6 || Math.abs(a - L * 1.4) < 0.4 ? P.d1 : dith(th, 1.8 + sh * 2 + (h2(Math.floor(g * 3), 1, seed) - 0.5), x, y)), (q) => (q > 0.6 ? P.a1 : P.a0));
      break;
    }
    case "stone": case "brick": {
      let n = 0;
      for (let row = 0; row < 3; row++) {
        const cnt = Math.max(1, 5 - row * 2), rr = (1.4 - row * 0.15) * k;
        for (let i = 0; i < cnt; i++, n++) {
          const a = (i / cnt) * 6.283 + row, d = row === 2 ? 0 : (2.2 - row) * k, u = Math.cos(a) * d, v = Math.sin(a) * d * 0.9, z = row * rr * 1.2;
          if (what === "brick") {
            const br = MAT.brick.wall, bw = 1.3 * k, bd = 0.7 * k, bh = 0.7 * k;
            box(S, u - bw, u + bw, v - bd, v + bd, z, z + bh, (s, t, x, y) => dith(br, 2.8, x, y), (s, t, x, y, sh) => dith(br, 1.4 + sh * 1.6, x, y));
          } else ball(S, u, v, z + rr * 0.5, rr * (0.9 + 0.3 * h2(n, seed)), rr * 0.9, rr * 0.8, (x, y, sh) => dith(ROCK, 2.6 + sh * 2.6 + (h2(n, seed, 2) - 0.5), x, y));
        }
      }
      break;
    }
    case "hide": {
      const hr = MAT.hide.wall;
      for (let i = 0; i < 3; i++) {
        const z = i * 0.7 * k, ru = (3.4 - i * 0.5) * k, rq = (2.4 - i * 0.3) * k, du = (h2(i, seed) - 0.5) * k;
        field(S, -ru + du - 1, ru + du + 1, -rq - 1, rq + 1, (u, v) => { const e = ((u - du) / ru) ** 2 + (v / rq) ** 2 + (vnoise(Math.atan2(v, u - du) * 2, seed + i) - 0.5) * 0.5; return e > 1 ? NaN : z + 0.7 * k * (1 - e * 0.5); },
          (u, v, zz, x, y, sh) => dith(hr, 2.4 + sh * 1.5 + (h2(Math.floor(u), Math.floor(v), seed + i) - 0.5) * 0.8 + (i === 2 ? 0.5 : 0), x, y));
      }
      break;
    }
    case "clay": {
      const cr = MAT.clay.wall;
      for (let i = 0; i < 3; i++) {
        const a = i * 2.1 + rv(seed, 1) * 6, d = i ? 1.8 * k : 0, rr = (i ? 1.5 : 2) * k;
        ball(S, Math.cos(a) * d, Math.sin(a) * d, 0, rr, rr * 0.9, rr * 0.8, (x, y, sh, nz) => (sh > 0.55 && nz > 0.6 && h2(x, y, seed) < 0.35 ? P.k0 : dith(cr, 2 + sh * 2.4, x, y)));
      }
      break;
    }
    case "food": {
      const R0 = 2.6 * k, Hh = 2.2 * k, wick = ramp("d1", "d2", "d3", "d4");
      rev(S, 0, 0, (t) => [R0 * (0.85 + 0.15 * t), t * Hh], Hh, (a, z, x, y, sh, arc) => dith(wick, 1.6 + sh * 1.8 + ((Math.floor(arc) + Math.floor(z)) & 1 ? 0.5 : -0.4), x, y));
      for (let i = 0; i < 8; i++) {
        const a = h2(i, seed, 1) * 6.283, d = Math.sqrt(h2(i, seed, 2)) * R0 * 0.75, c = pick([P.red, P.red, P.f2, P.violet, P.a3, P.g4], h2(i, seed, 3)), s = Math.max(0.6, 0.9 * k);
        ball(S, Math.cos(a) * d, Math.sin(a) * d, Hh - 0.3, s, s, s * 0.9, (x, y, sh) => (sh > 0.55 ? P.snow : sh > -0.1 ? c : SHADOW[c]));
      }
      rev(S, 0, 0, () => [R0 + 0.25, Hh], 0.1, () => P.d4);
      break;
    }
    default: {
      // stores of this and that: a tied sack and a pot
      const sack = ramp("s0", "s1", "s2", "s3"), pot = ramp("d1", "k2", "k1", "d4");
      ball(S, -1 * k, 0.6 * k, 0, 2.2 * k, 2 * k, 2.8 * k, (x, y, sh) => dith(sack, 1.5 + sh * 2, x, y));
      ball(S, -1 * k, 0.6 * k, 2.7 * k, 0.6 * k, 0.6 * k, 0.8 * k, (x, y, sh) => dith(sack, 1.2 + sh * 2, x, y));
      rev(S, -1 * k, 0.6 * k, () => [0.8 * k, 2.6 * k], 0.1, () => P.d1);
      rev(S, 2 * k, 0, (t) => [(1.3 + Math.sin(t * Math.PI) * 0.6 - t * 0.6) * k, t * 2.8 * k], 3 * k, (a, z, x, y, sh) => dith(pot, 1.7 + sh * 2, x, y));
      ball(S, 2 * k, 0, 2.8 * k, 0.7 * k, 0.7 * k, 0.1, () => P.ink);
    }
  }
  return done(S, R * 0.6);
}

// Stores in a heap. Wood is the split woodpile from sprites.js (it ignores dir); the others are heaps of their own.
export function pile(hpx = 6, what = "misc", seed = 0, dir = 0) {
  if (what === "wood") { const S = SP.woodpile(Math.max(1, Math.round(hpx / 5)), seed); S.foot = 0; return S; }
  return turned(dir, () => heap(what, Math.max(2.5, hpx), seed));
}

// ------------------------------------------------------------------------------------------------ ground things

// A ring of stones round a scorched hearth, unlit. r: ring radius in ground px.
export function firering(r = 4, seed = 0) {
  r = Math.max(2, r);
  const S = iso(r + 2, r + 2, 3), n = Math.max(6, Math.round((2 * Math.PI * r) / 2.1)), sr = Math.max(0.8, r * 0.22), soot = ramp("ink", "d0", "d1", "d2");
  field(S, -r, r, -r, r, (u, v) => (u * u + v * v < (r - 0.5) ** 2 ? 0 : NaN), (u, v, z, x, y) =>
    h2(x, y, seed) < 0.12 ? P.ink : h2(x, y, seed + 1) < 0.18 ? P.r2 : dith(soot, 0.8 + (Math.hypot(u, v) / r) * 2, x, y));
  for (let i = 0; i < n; i++) {
    const a = (i / n) * 6.283 + rv(seed, 1), s = sr * (0.8 + 0.4 * h2(i, seed, 2));
    ball(S, Math.cos(a) * r, Math.sin(a) * r, 0, s, s * 0.9, s * 0.8, (x, y, sh) => dith(ROCK, 2.4 + sh * 2.8 + (h2(i, seed, 3) - 0.5), x, y));
  }
  return done(S, r * 0.5 + 0.5, P.r0);
}

// Cold ash where a fire burned out: a soft grey patch with charcoal. No outline; it is a stain on the ground.
export function ash(r = 4, seed = 0) {
  r = Math.max(1.5, r);
  const S = iso(r + 2, r + 2, 1), gr = ramp("r1", "r2", "r3", "r4");
  field(S, -r, r, -r, r, (u, v) => (Math.hypot(u, v) / r + (vnoise(Math.atan2(v, u) * 1.6, seed) - 0.5) * 0.4 < 1 ? 0 : NaN), (u, v, z, x, y) => {
    const e = Math.hypot(u, v) / r;
    if (e > 0.7 && h2(x, y, seed) < (e - 0.7) * 2.2) return -1;
    return h2(x, y, seed + 2) < 0.1 ? P.ink : dith(gr, 2.2 - e * 1.6 + (h2(x >> 1, y, seed + 3) - 0.5) * 0.9, x, y);
  });
  return done(S, r * 0.5, -1);
}

const CHAR = { [P.d5]: P.r3, [P.d4]: P.r2, [P.d3]: P.r1, [P.d2]: P.r0, [P.d1]: P.ink, [P.d0]: P.ink };
// A burnt stump: the sprites.js stump charred black, with snapped spikes above.
export function burnt(hpx = 8, seed = 0) {
  const h = Math.max(3, Math.round(hpx)), r = Math.max(2, Math.round(h * 0.42)), S0 = SP.stump(r, Math.max(2, Math.round(h * 0.45)), seed);
  const spike = Math.max(2, h - S0.ay + 1), S = grow(S0, spike);
  for (let i = 0; i < S.p.length; i++) if (S.p[i] !== 255) S.p[i] = CHAR[S.p[i]] ?? P.r0;
  let top = 0;
  while (top < S.h && S.p[top * S.w + S.ax] === 255) top++;
  const spikes = [[S.ax - 1, spike], [S.ax + 1, Math.round(spike * 0.55)]].slice(0, rv(seed, 1) < 0.6 ? 2 : 1);
  for (const [x, L] of spikes) for (let j = 0; j < L; j++) { S.set(x, top + 1 - j, j === L - 1 ? P.r1 : P.ink); if (j < L * 0.5) S.set(x + 1, top + 1 - j, P.r0); }
  S.outline(P.ink, true);
  S.foot = 0;
  return S;
}

// A dug hole, the far inner wall lit, the floor dark, the spoil heaped behind. stage 0..1: how deep it is dug.
export function pit(r = 4, stage = 1, seed = 0) {
  r = Math.max(2, r);
  const deep = clamp(stage, 0, 1), rr = r * (0.7 + 0.3 * deep), d = Math.max(0.8, rr * (0.2 + 0.45 * deep)), S = iso(r + 4, r + 4, 3 + r);
  const sa = -2.9 - rv(seed, 1) * 0.5, sd = rr + r * 0.25;
  ball(S, Math.cos(sa) * sd, Math.sin(sa) * sd, 0, r * (0.22 + 0.12 * deep), r * (0.2 + 0.1 * deep), r * (0.12 + 0.12 * deep), (x, y, sh) => dith(BARK, 2.4 + sh * 2.2 + (h2(x, y, seed) - 0.5) * 0.6, x, y));
  field(S, -rr - 1, rr + 1, -rr - 1, rr + 1, (u, v) => (u * u + v * v < (rr + 0.8) ** 2 ? 0.01 : NaN), (u, v, z, x, y) => {
    if (Math.hypot(u, v) > rr - 0.2) return u + v > 0 ? P.d4 : P.d3; // the lip
    // the floor is the rim moved down by the depth; what is above it, inside the rim, is the far wall
    const fu = u - d, fv = v - d;
    return fu * fu + fv * fv < rr * rr ? (h2(x, y, seed + 1) < 0.2 ? P.d0 : P.ink) : dith(BARK, 2.3 - clamp((u + v + rr * 1.4) / (rr * 1.4), 0, 1) * 2, x, y);
  });
  return done(S, rr * 0.6, P.d0);
}

// A hidden pit under a lattice of sticks and leaves; sprung, it lies open with the broken sticks fallen in.
export function trap(hpx = 8, sprung = false, seed = 0, flag = -1, dir = 0) {
  return turned(dir, () => trapped(hpx, sprung, seed, flag));
}
function trapped(hpx, sprung, seed, flag) {
  const r = Math.max(2, hpx * 0.45);
  let S;
  if (sprung) {
    S = pit(r, 1, seed);
    for (let i = 0; i < 3; i++) {
      const x0 = Math.round(S.w * (0.25 + 0.5 * h2(i, seed, 1))), y0 = Math.round(S.ay - S.foot - r * 0.4 + r * 0.6 * h2(i, seed, 2)), L = Math.round(r * (0.6 + 0.5 * h2(i, seed, 3))), s = h2(i, seed, 4) < 0.5 ? 1 : -1;
      for (let j = 0; j < L; j++) S.set(x0 + j * s, y0 + Math.round(j * 0.5), j === 0 ? P.d4 : P.d3);
    }
  } else {
    S = iso(r + 3, r + 3, 3);
    const leaf = ramp("m0", "m1", "m2", "g3", "g4");
    field(S, -r, r, -r, r, (u, v) => (u * u + v * v < r * r ? 0.1 : NaN), (u, v, z, x, y) => {
      if (Math.hypot(u, v) / r > 0.86) return P.d3;
      if (mod(u - v, 2.2) < 0.7) return P.d3;
      if (mod(u + v, 2.2) < 0.7) return P.d2;
      return h2(x, y, seed) < 0.55 ? dith(leaf, 1.6 + (h2(x >> 1, y, seed + 1) - 0.3) * 3, x, y) : P.d0;
    });
    S = done(S, r * 0.5, P.d0);
  }
  if (flag < 0) return S;
  // the owner's marker stick beside it
  const T = grow(S, 5), x = T.w - 2, y = T.ay - 1;
  for (let j = 0; j < 6; j++) T.set(x, y - j, P.d2);
  T.set(x + 1, y - 5, flag); T.set(x + 1, y - 4, SHADOW[flag]);
  const U = new Spr(T.w + 2, T.h, T.ax, T.ay); for (let j = 0; j < T.h; j++) for (let i = 0; i < T.w; i++) U.p[j * U.w + i] = T.p[j * T.w + i];
  U.foot = S.foot;
  return U;
}

// A stone-lined well brimming with water; bigger ones get two posts, a bar and a bucket.
export function well(hpx = 10, seed = 0, dir = 0) {
  return turned(dir, () => wellAt(hpx, seed));
}
function wellAt(hpx, seed) {
  const R = Math.max(2.5, hpx * 0.38), wh = Math.max(1.5, hpx * 0.22), frame = hpx >= 12, S = iso(R + 3, R + 3, wh + (frame ? hpx * 0.8 : 1) + 2);
  const stone = surfer(MAT.stone.wall, "blocks", seed, Math.max(0.6, hpx / 16)), rim = Math.max(1, R * 0.28);
  rev(S, 0, 0, (t) => [R, t * wh], wh, (a, z, x, y, sh, arc) => stone(arc, z, x, y, sh));
  field(S, -R, R, -R, R, (u, v) => { const e = Math.hypot(u, v); return e < R ? (e > R - rim ? wh : wh - 0.6) : NaN; }, (u, v, z, x, y) => {
    if (Math.hypot(u, v) > R - rim) return dith(ROCK, 3.6 + (h2(Math.floor(Math.atan2(v, u) * R), 1, seed) - 0.5) * 1.2, x, y);
    return u + v < -R * 0.4 && h2(x, y, seed) < 0.5 ? P.w6 : dith(ramp("w1", "w2", "w3", "w4"), 1.6 - (u + v) / R, x, y);
  });
  if (frame) {
    const top = wh + hpx * 0.7, e = (R + 0.6) * 0.7;
    line(S, [e, -e, 0], [e, -e, top], P.d2);
    line(S, [-e, e, 0], [-e, e, top], P.d3);
    line(S, [-e - 0.4, e + 0.4, top], [e + 0.4, -e - 0.4, top], P.d4);
    line(S, [0, 0, top], [0, 0, wh + 2], P.s1);
    rev(S, 0, 0, (t) => [0.9 + t * 0.3, wh + 0.4 + t * 1.4], 1.6, (a, z, x, y, sh) => (sh > 0 ? P.d4 : P.d2));
  }
  return done(S, R * 0.7);
}

// A grave: a long mound of earth under a marker, a small cairn or a carved board; some have flowers laid on it.
export function grave(hpx = 8, seed = 0, dir = 0) {
  return turned(dir, () => graveAt(hpx, seed));
}
function graveAt(hpx, seed) {
  const h = Math.max(4, hpx), L = h * 0.55, W = h * 0.3, along = rv(seed, 1) < 0.5, S = iso(L + 3, L + 3, h + 3);
  const earth = ramp("d1", "d2", "d3", "d4"), grass = ramp("g2", "g3", "g4");
  ball(S, 0, 0, 0, along ? L : W, along ? W : L, h * 0.16, (x, y, sh, nz) => (h2(x, y, seed) < 0.3 * nz ? dith(grass, 1 + sh * 2, x, y) : dith(earth, 1.8 + sh * 2, x, y)));
  // the marker stands at the head end, which is the far end of the mound
  const hu = along ? -L * 0.75 : 0, hv = along ? 0 : -L * 0.75, mx = sx(S, hu, hv), my = sy(S, hu, hv, h * 0.1);
  let M;
  if (rv(seed, 2) < 0.5) M = cairn(Math.max(4, Math.round(h * 0.55)), seed);
  else {
    const bh = Math.max(3, Math.round(h * 0.55)), bw = Math.max(1, Math.round(h * 0.12));
    M = new Spr(bw * 2 + 3, bh + 2, bw + 1, bh);
    for (let y = 0; y <= bh; y++) for (let x = -bw; x <= bw; x++) if (!(y === 0 && Math.abs(x) === bw && bw > 1)) M.set(M.ax + x, y, x < 0 ? P.d4 : x === 0 ? P.d3 : P.d2);
    if (bh >= 6) for (const [x, y] of [[0, 1], [-1, 2], [0, 2], [1, 2], [0, 3]]) M.set(M.ax + x, y, P.d1);
    M.outline(P.ink, true);
  }
  const ax0 = S.ax, ay0 = S.ay, mound = done(S, (L + W) * 0.35, P.d0), out = grow(mound, M.h);
  stamp(out, M, mx - ax0 + out.ax, my - ay0 + out.ay - out.foot);
  if (rv(seed, 3) >= 0.5)
    for (let i = 0; i < 3; i++) {
      const x = out.ax + Math.round((h2(i, seed, 1) - 0.5) * out.w * 0.5), y = out.ay - 1 - Math.floor(h2(i, seed, 2) * 2);
      if (out.get(x, y) !== 255) out.set(x, y, pick([P.a3, P.violet, P.snow, P.red], h2(i, seed, 3)));
    }
  return out;
}

// A young tree: a whip of a stem and a few leaf clusters.
export function sapling(hpx = 6, seed = 0) {
  const h = Math.max(3, Math.round(hpx)), W = Math.ceil(h * 0.8) + 4, S = new Spr(W, h + 3, W >> 1, h + 1), cx = S.ax + 0.5, gy = S.ay + 0.95;
  const lean = (rv(seed, 1) - 0.5) * h * 0.2, leaf = ramp("g2", "g3", "g4", "g5", "g6");
  seg(S, cx, gy, cx + lean, gy - h * 0.8, 0.4, 0.4, (x, y) => (y > gy - h * 0.3 ? P.d2 : P.d3));
  const n = h < 6 ? 2 : 3 + Math.floor(rv(seed, 2) * 2);
  for (let i = 0; i < n; i++) {
    const t = 0.5 + (i / n) * 0.4, x = cx + lean * t + (i & 1 ? 1 : -1) * h * 0.16 * (1.3 - t), y = gy - h * t;
    if (h >= 7) seg(S, cx + lean * t, y + 1, x, y, 0.4, 0.4, solid(P.d3));
    blob(S, x, y, Math.max(0.8, h * 0.13), Math.max(0.7, h * 0.1), (px, py, l) => dith(leaf, 2.2 + l * 2, px, py));
  }
  blob(S, cx + lean, gy - h * 0.86, Math.max(0.9, h * 0.15), Math.max(0.8, h * 0.13), (px, py, l) => dith(leaf, 2.6 + l * 2, px, py));
  S.outline(P.t1, true);
  return S;
}

// A medicinal herb: a low rosette of bright leaves with a stalk or two of tiny white, violet or yellow flowers.
// species: yarrow (flat white heads), sorrel (rust red spikes) or mint (violet whorls); omitted, the seed picks.
export function herb(hpx = 4, seed = 0, species) {
  const h = Math.max(2, Math.round(hpx)), W = h * 2 + 4, S = new Spr(W, h + 4, W >> 1, h + 2), cx = S.ax + 0.5, gy = S.ay + 0.95;
  const bloom = { yarrow: P.snow, sorrel: P.f1, mint: P.violet }[species] ?? pick([P.snow, P.snow, P.violet, P.a3], rv(seed, 1));
  const leaf = species === "mint" ? ramp("g2", "g3", "g4", "g5") : ramp("g3", "g4", "g5", "g6"), n = 5 + Math.floor(rv(seed, 2) * 3);
  for (let i = 0; i < n; i++) {
    const a = Math.PI * (0.1 + (0.8 * (i + 0.5)) / n), Lf = h * (0.5 + 0.3 * h2(i, seed, 3));
    blob(S, cx - Math.cos(a) * Lf * 0.8, gy - Math.sin(a) * Lf * 0.55 - 0.4, Math.max(0.7, h * 0.22), Math.max(0.55, h * 0.13), (x, y, l) => dith(leaf, 1.4 + l * 2 + (i & 1) * 0.4, x, y));
  }
  S.outline(P.g1, true);
  for (let s = 0; s < (h >= 4 ? 2 : 1); s++) {
    const x = Math.floor(cx) + (h >= 4 ? (s ? 1 : -1) : 0), top = Math.round(gy - h - 0.5 - s);
    for (let y = top + 1; y < gy - h * 0.4; y++) S.set(x, y, P.g2);
    S.set(x, top, bloom);
    if (species === "sorrel") { for (let y = top + 2; y < gy - h * 0.4; y += 2) S.set(x + ((y >> 1) & 1 ? 1 : -1), y, P.f0); }
    else if (species === "mint") { if (h >= 4) S.set(x, top + 2, bloom); }
    else if (h >= 5 || (species === "yarrow" && h >= 3)) { S.set(x - 1, top + (species === "yarrow" ? 0 : 1), bloom); S.set(x + 1, top + (species === "yarrow" ? 0 : 1), bloom); }
  }
  return S;
}

// A wet clay bank: a smear of red-brown clay with a shine on it and a lump or two dug loose.
export function clay(r = 4, seed = 0) {
  r = Math.max(2, r);
  const S = iso(r + 2, r + 2, r), cr = MAT.clay.wall;
  field(S, -r, r, -r, r, (u, v) => (Math.hypot(u, v * 1.2) / r + (vnoise(Math.atan2(v, u) * 1.8, seed) - 0.5) * 0.5 < 1 ? 0.05 : NaN), (u, v, z, x, y) =>
    h2(x, y, seed) < 0.06 ? P.k0 : dith(cr, 2 - (u + v) / (r * 2) + (h2(x >> 1, y, seed + 2) - 0.5) * 0.8, x, y));
  for (let i = 0; i < 1 + Math.floor(rv(seed, 1) * 2); i++) {
    const a = h2(i, seed, 3) * 6.283, d = r * 0.4 * h2(i, seed, 4), s = r * (0.22 + 0.1 * h2(i, seed, 5));
    ball(S, Math.cos(a) * d, Math.sin(a) * d, 0, s, s * 0.9, s * 0.75, (x, y, sh, nz) => (sh > 0.6 && nz > 0.7 ? P.k0 : dith(cr, 2.2 + sh * 2.2, x, y)));
  }
  return done(S, r * 0.5, P.d0);
}

// A dead bush: bare grey-brown twigs fanning up from the root, a few dry leaves hanging on.
export function deadbush(size = 5, seed = 0) {
  const h = Math.max(3, Math.round(size)), W = Math.ceil(h * 1.8) + 4, S = new Spr(W, h + 3, W >> 1, h + 1), cx = S.ax + 0.5, gy = S.ay + 0.95;
  const n = 5 + Math.floor(rv(seed, 1) * 3), tw = ramp("d2", "d3", "r3", "r4");
  for (let i = 0; i < n; i++) {
    const a = Math.PI * (0.12 + (0.76 * (i + 0.2 + 0.6 * h2(i, seed, 2))) / n), L = h * (0.7 + 0.35 * h2(i, seed, 3));
    const mx = cx - Math.cos(a) * L * 0.5, my = gy - Math.sin(a) * L * 0.55, ex = cx - Math.cos(a) * L * 0.95, ey = gy - Math.sin(a) * L;
    const c = (x, y) => tw[clamp(Math.floor(((gy - y) / h) * 3 + h2(i, seed, 4)), 0, 3)];
    rod(S, [[cx, gy], [mx, my], [ex, ey]], 0.4, 0.4, c);
    if (h >= 6) seg(S, mx, my, mx - Math.cos(a + 0.6) * L * 0.3, my - Math.sin(a + 0.6) * L * 0.3, 0.4, 0.4, c);
    if (h2(i, seed, 5) < 0.4) S.set(ex, ey, pick([P.a1, P.a2, P.d4], h2(i, seed, 6)));
  }
  return S;
}

// A stick on the ground, lying along a tile axis or across one. len: its length in ground px.
export function stick(len = 5, seed = 0) {
  // never along PI/4, which would stand the stick upright on screen
  const L = Math.max(2, len), a = [0, Math.PI / 2, -Math.PI / 4, 0.35, 1.2][Math.floor(rv(seed, 1) * 5)], S = iso(L, L, 2);
  for (let t = -L / 2; t <= L / 2; t += 0.25) {
    const u = Math.cos(a) * t, v = Math.sin(a) * t, x = sx(S, u, v), y = sy(S, u, v, 0.6);
    dot(S, u, v, 0.6, P.d3, x, y); dot(S, u, v, 0.1, P.d1, x, y + 1);
  }
  if (L >= 4) { const t = L * 0.15, u = Math.cos(a) * t, v = Math.sin(a) * t; S.set(sx(S, u, v) + 1, sy(S, u, v, 0.6) - 1, P.d4); }
  return done(S, 0, -1);
}

// --------------------------------------------------------------------------------------------------------- icons

const ICONS = {
  think: [["..www..", ".wwwww.", "wwiwiww", ".wwwww.", "..www..", ".......", ".w....."], { w: "snow", i: "r2" }],
  sleep: [["...zzz", "....z.", "..zzz.", "zzz...", ".z....", "zzz..."], { z: "snow" }],
  sick: [["..g..", ".gGg.", "gGGGg", "gGGGg", ".ggg."], { g: "g5", G: "g6" }],
  fight: [["f...f", ".fyf.", ".yWy.", ".fyf.", "f...f"], { f: "f1", y: "f3", W: "f4" }],
};
// A marker above a person's head, anchored at its bottom centre.
export function icon(name = "think") {
  const [list, names] = ICONS[name] ?? ICONS.think, w = list[0].length;
  const S = new Spr(w + 2, list.length + 2, (w + 2) >> 1, list.length + 1);
  list.forEach((row, y) => [...row].forEach((ch, x) => { if (names[ch]) S.set(x + 1, y + 1, P[names[ch]]); }));
  S.outline(P.ink);
  return S;
}

// -------------------------------------------------------------------------------------------------------- wolves

const PELTS = [ramp("r0", "r1", "r2", "r3", "r4"), ramp("r0", "r1", "r2", "r3", "r4"), ramp("ink", "r0", "r1", "r2", "r3"), ramp("r1", "r2", "r3", "r4", "r5")];
// Tiny wolves, a frame list per pose: L back, B body, T tail, K ear, W pale chest, E legs, N nose.
const TINY_WOLF = {
  stand: [[".....K.", "TLLLLBN", "TBBBBW.", ".E..E.."]],
  walk: [[".....K.", "TLLLLBN", "TBBBBW.", "E...E.."], [".....K.", "TLLLLBN", "TBBBBW.", ".E..E.."], [".....K.", "TLLLLBN", "TBBBBW.", "..E..E."], [".....K.", "TLLLLBN", "TBBBBW.", ".E..E.."]],
  run: [[".....K.", "TLLLLBN", ".BBBBW.", "E.....E"], [".....K.", "TLLLLBN", "TBBBBW.", "..EEE.."]],
  eat: [[".......", "TLLLL..", "TBBBBK.", ".E..EWN"], [".......", "TLLLLK.", "TBBBBW.", ".E..E.N"]],
  rest: [["......K", "TLLLLBN", "BBBBBWE"], ["......K", "TLLLLB.", "BBBBBWN"]],
};

// hpx: standing head height. Drawn facing right; callers mirror. pose 'stand' 'walk' 'run' 'eat' 'rest', frame 0..3.
export function wolf(hpx = 6, pose = "stand", frame = 0, seed = 0) {
  frame &= 3;
  const h = Math.max(3, Math.round(hpx)), coat = pick(PELTS, rv(seed, 1)), gait = pose === "walk" || pose === "run";
  if (h <= 5) {
    const f = TINY_WOLF[pose] ?? TINY_WOLF.stand, list = f[(gait ? frame : frame >> 1) % f.length];
    const key = { L: coat[3], B: coat[2], T: coat[2], K: coat[3], W: coat[4] === P.r5 ? P.snow : P.r5, E: coat[1], N: P.ink };
    // 5 px stands on longer legs, 3 px drops the ear row
    const L = h === 5 && pose !== "rest" ? [...list, list[list.length - 1]] : h === 3 && pose !== "rest" ? list.slice(1) : list;
    return rows(L, key, 1, { outline: coat[0], late: "EN" });
  }
  const W = Math.ceil(h * 1.9) + 6, S = new Spr(W, Math.ceil(h * 1.2) + 4, (W >> 1) - Math.round(h * 0.05), Math.ceil(h * 1.2) + 1), gy = S.ay + 0.95;
  const X = (u) => S.ax + 0.5 + u * h, Y = (v) => gy - v * h, pt = (u, v) => [X(u), Y(v)];
  const fur = (dv) => (x, y, l, nx, ny) => dith(coat, 2.2 + dv + l * 1.4 + (ny < -0.55 ? -0.9 : 0) + (h2(x, y, seed) - 0.5) * 0.4, x, y);
  const near = fur(0), pale = (x, y, l) => dith(ramp("r3", "r4", "r5"), 1 + l * 1.4, x, y);
  let body, head, snout, ear, tail, legs = [];
  if (pose === "run") {
    // gallop: gathered, then fully stretched, then landing on the fore feet, then pushing off the hind
    const F = [
      { b: 0.56, feet: [[-0.06, 0.12], [0.08, 0.14], [0.02, 0.06], [0.16, 0.1]], t: 0.6 },
      { b: 0.64, feet: [[-0.62, 0.3], [0.6, 0.3], [-0.52, 0.22], [0.72, 0.36]], t: 0.72 },
      { b: 0.6, feet: [[-0.48, 0.3], [0.34, 0], [-0.4, 0.34], [0.26, 0.06]], t: 0.68 },
      { b: 0.58, feet: [[-0.14, 0], [0.02, 0.24], [-0.22, 0.04], [0.1, 0.3]], t: 0.64 },
    ][frame];
    body = [0, F.b];
    legs = F.feet.map((foot, i) => ({ hip: [i & 1 ? 0.26 : -0.28, F.b - 0.02], foot }));
    head = [0.46, F.b + 0.06]; snout = [0.66, F.b + 0.02]; ear = [0.38, F.b + 0.17]; tail = [[-0.4, F.b + 0.02], [-0.76, F.t]];
  } else if (pose === "rest") {
    // lying, forelegs out in front; frames 2 and 3 lift the head
    const br = [0, 0.012, 0, 0.012][frame], up = frame >= 2;
    body = [-0.04, 0.2 + br];
    head = up ? [0.42, 0.36] : [0.46, 0.18]; snout = up ? [0.6, 0.32] : [0.64, 0.12]; ear = up ? [0.36, 0.5] : [0.38, 0.32];
    tail = [[-0.42, 0.18], [-0.12, 0.04]];
  } else {
    const walk = pose === "walk", eat = pose === "eat", bob = walk && frame & 1 ? 0.02 : 0;
    body = [0, 0.54 + bob];
    // a lateral walk: each leg a quarter cycle behind the last
    legs = [[-0.28, 0], [0.22, 0.25], [-0.22, 0.5], [0.3, 0.75]].map(([fu, ph], i) => {
      const a = (frame / 4 + ph) * 2 * Math.PI;
      return { hip: [i & 1 ? 0.26 : -0.26, 0.52 + bob], foot: [fu + (walk ? 0.12 * Math.sin(a) : 0), walk ? Math.max(0, -Math.cos(a)) * 0.08 : 0] };
    });
    const nod = eat ? [0, 0.03, 0, -0.02][frame] : 0, sway = [0, 0.02, 0, -0.02][frame];
    head = eat ? [0.5, 0.14 + nod] : walk ? [0.5, 0.6 + bob] : [0.46, 0.76];
    snout = eat ? [0.58, 0.04 + nod] : walk ? [0.68, 0.56 + bob] : [0.64, 0.72];
    ear = eat ? [0.44, 0.26 + nod] : walk ? [0.44, 0.74 + bob] : [0.4, 0.92];
    tail = [[-0.4, 0.56 + bob], [-0.54 + sway, eat ? 0.34 : 0.26]];
  }
  const thin = h < 12, T = new Spr(S.w, S.h, S.ax, S.ay);
  const drawLeg = (on, L, i) => {
    const hip = pt(...L.hip), foot = pt(...L.foot), hind = !(i & 1), knee = [(hip[0] + foot[0]) / 2 + (hind ? -0.06 : 0.03) * h, (hip[1] + foot[1]) / 2];
    const lower = solid(coat[i < 2 ? 1 : 2]);
    if (thin) rod(on, [hip, knee, foot], 0.5, 0.5, lower);
    else { seg(on, hip[0], hip[1], knee[0], knee[1], (hind ? 0.08 : 0.05) * h, 0.5, fur(i < 2 ? -0.7 : -0.3)); seg(on, knee[0], knee[1], foot[0], foot[1], 0.5, 0.5, lower); }
  };
  legs.forEach((L, i) => i < 2 && drawLeg(T, L, i));
  // the heavy brush of a tail, dark at the tip
  const [t0, t1] = tail, tipR = Math.max(1, 0.1 * h);
  seg(S, X(t0[0]), Y(t0[1]), X(t1[0]), Y(t1[1]), Math.max(0.7, 0.07 * h), Math.max(0.8, 0.09 * h), (x, y, l, nx, ny) => (Math.hypot(x + 0.5 - X(t1[0]), y + 0.5 - Y(t1[1])) < tipR ? coat[0] : near(x, y, l, nx, ny)));
  const [bu, bv] = body, ry = pose === "rest" ? 0.15 : 0.13;
  blob(S, X(bu - 0.2), Y(bv + 0.01), 0.15 * h, ry * h, near);
  blob(S, X(bu), Y(bv), 0.28 * h, ry * h, near);
  // ruff and pale chest
  blob(S, X(bu + 0.22), Y(bv + 0.02), 0.15 * h, (ry + 0.02) * h, (x, y, l, nx, ny) => (ny > 0.2 && nx > -0.2 ? pale(x, y, l) : near(x, y, l, nx, ny)));
  if (pose === "rest") {
    seg(S, X(0.2), Y(0.05), X(0.62), Y(0.04), Math.max(0.5, 0.04 * h), Math.max(0.5, 0.035 * h), fur(-0.3));
    blob(S, X(-0.26), Y(0.12), 0.12 * h, 0.09 * h, near);
  }
  const neck = [(head[0] + bu + 0.24) / 2, (head[1] + bv + 0.05) / 2];
  seg(S, X(bu + 0.24), Y(bv + 0.05), X(neck[0]), Y(neck[1]), 0.1 * h, 0.08 * h, near);
  seg(S, X(neck[0]), Y(neck[1]), X(head[0]), Y(head[1]), 0.08 * h, 0.07 * h, near);
  blob(S, X(head[0]), Y(head[1]), Math.max(0.8, 0.08 * h), Math.max(0.7, 0.065 * h), near);
  seg(S, X(head[0] + 0.02), Y(head[1] - 0.01), X(snout[0]), Y(snout[1]), Math.max(0.6, 0.045 * h), Math.max(0.5, 0.03 * h), (x, y, l, nx, ny) => (ny > 0.1 ? pale(x, y, l) : near(x, y, l, nx, ny)));
  const ex = X(ear[0]), ey = Y(ear[1]), eb = Y(head[1]) - 0.05 * h;
  seg(S, X(head[0] - 0.02), eb, ex, ey, 0.4, 0.4, solid(coat[3]));
  if (h >= 9) seg(S, X(head[0] - 0.07), eb + 0.02 * h, ex - 0.06 * h, ey + 0.02 * h, 0.4, 0.4, solid(coat[2]));
  S.set(Math.floor(X(snout[0])), Math.floor(Y(snout[1])), P.ink);
  if (h >= 10) S.set(Math.floor(X(head[0] + 0.02)), Math.floor(Y(head[1] + 0.01)), pose === "rest" && frame < 2 ? coat[1] : P.a3);
  S.outline(coat[0], true);
  under(S, T);
  legs.forEach((L, i) => i >= 2 && drawLeg(S, L, i));
  return S;
}

// -------------------------------------------------------------------------------------------------------- people

// The same draws sprites.js person() makes, so a walker and a stander of one seed are the same person.
function looks(seed, cloth, elder) {
  const skin = h2(seed, 1) < 0.35 ? [P.k1, P.k2] : [P.k0, P.k1];
  const hair = elder ? (h2(seed, 9) < 0.5 ? P.r4 : P.r5) : [P.d0, P.d1, P.ink, P.d3, P.d2][Math.floor(h2(seed, 2) * 5)];
  const pants = [P.d1, P.r1, P.d2, P.m1][Math.floor(h2(seed, 3) * 4)];
  return { skin, hair, pants, pd: SHADOW[pants], cloth, dark: SHADOW[cloth] };
}

// A walking person drawn like sprites.js person(), at its sizes and with its anchors, over a 4-frame step: 0 and 2
// are strides, 1 and 3 pass. Side walkers face right (mirror for left). hpx: an adult's height at this zoom; a
// child is about two thirds as tall, an elder is grey, stoops and walks with a stick. carry: 'none', 'wood' (a log
// on the shoulder), 'stone' (held at the chest), 'food' (a basket on the head).
export function walker(hpx = 8, cloth = P.c0, facing = "front", frame = 0, carry = "none", stage = "adult", seed = 0) {
  frame &= 3;
  const elder = stage === "elder", he = hpx * (stage === "child" ? 0.68 : elder ? 0.95 : 1), L = looks(seed, cloth, elder);
  if (he >= 16) return walkBig(Math.round(he), L, facing, frame, carry, elder);
  if (he >= 9) return walkSmall(L, facing, frame, carry, elder);
  return walkTiny(L, facing, frame, carry, he < 6.5, elder);
}

function walkTiny(L, facing, frame, carry, wee, elder) {
  const pad = carry === "food" ? 2 : 0, S = new Spr(6, 9 + pad, 2, 8 + pad), side = facing === "side", back = facing === "back";
  const at = (x, y, c) => S.set(x, y + pad, c), feet = 6;
  if (wee) {
    at(2, 2, L.hair); at(2, 3, back ? L.hair : L.skin[0]);
    for (const y of [4, 5]) { at(2, y, L.cloth); at(3, y, L.dark); }
    if (frame & 1) at(side ? 3 : 2, feet, P.ink);
    else { at(side ? 1 : 2, feet, P.ink); at(side ? 4 : 3, feet, frame === 0 || side ? P.ink : L.pants); }
  } else {
    const hx = side && elder ? 3 : 2;
    at(hx, 0, L.hair); at(hx, 1, back ? L.hair : L.skin[0]);
    for (const y of [2, 3, 4]) { at(1, y, L.cloth); at(2, y, L.cloth); at(3, y, L.dark); }
    if (side) {
      if (frame & 1) { at(2, 5, L.pants); at(2, feet, P.ink); }
      else { at(1, 5, frame ? L.pants : L.pd); at(3, 5, frame ? L.pd : L.pants); at(0, feet, P.ink); at(4, feet, P.ink); }
    } else {
      const lift = frame === 0 ? 3 : frame === 2 ? 1 : -1;
      for (const x of [1, 3]) { if (x === lift) at(x, 5, P.ink); else { at(x, 5, L.pants); at(x, feet, P.ink); } }
    }
  }
  const top = wee ? 2 : 0, sh = top + 2, x0 = wee ? 1 : 0;
  if (carry === "wood") { for (let x = x0; x <= 4; x++) at(x, sh, P.d3); at(side ? 4 : x0, sh, P.d5); }
  else if (carry === "stone") { const x = side ? 4 : 2; at(x, sh + 1, P.r4); at(x, sh + 2, P.r2); }
  else if (carry === "food") { at(1, top - 1, P.d3); at(2, top - 1, P.d4); at(3, top - 1, P.d3); at(2, top - 2, P.red); }
  if (elder) for (let y = sh + 1; y <= feet; y++) at(4, y, P.d2);
  return S;
}

function walkSmall(L, facing, frame, carry, elder) {
  const pad = carry === "food" ? 2 : 0, S = new Spr(8, 14 + pad, 3, 12 + pad), side = facing === "side", back = facing === "back";
  // a side walker's body rises a pixel as it passes; the feet row stays put
  const o = 1 + pad - (side && frame & 1 ? 1 : 0), at = (x, y, c) => S.set(x + 1, y + o, c), foot = (x, y, c) => S.set(x + 1, y + pad, c);
  const hs = side && elder ? 1 : 0, hd = (x, y, c) => S.set(x + 1 + hs, y + o, c);
  hd(1, 0, L.hair); hd(2, 0, L.hair);
  if (back) for (let x = 0; x < 4; x++) hd(x, 1, L.hair);
  else { hd(0, 1, L.hair); hd(1, 1, L.skin[0]); hd(2, 1, L.skin[0]); hd(3, 1, side ? L.skin[1] : L.hair); }
  hd(1, 2, back ? L.hair : L.skin[0]); hd(2, 2, back ? L.hair : L.skin[1]);
  for (let x = 0; x < 4; x++) { at(x, 3, x === 3 ? L.dark : L.cloth); at(x, 4, x >= 2 ? L.dark : L.cloth); }
  at(0, 5, L.skin[0]); at(1, 5, L.cloth); at(2, 5, L.dark); at(3, 5, L.skin[1]);
  for (let x = 0; x < 4; x++) at(x, 6, x >= 2 ? L.pd : L.pants);
  if (side) {
    if (frame & 1) {
      // passing: the planted leg straight under the body, the other lifted behind
      const [pc, lc] = frame === 1 ? [L.pants, L.pd] : [L.pd, L.pants];
      foot(2, 7, pc); foot(2, 8, pc); foot(2, 9, P.ink); foot(3, 9, P.ink);
      foot(1, 7, lc); foot(0, 8, P.ink);
    } else {
      const [fwd, bk] = frame === 0 ? [L.pants, L.pd] : [L.pd, L.pants];
      foot(3, 8, fwd); foot(0, 8, bk); foot(4, 9, P.ink); foot(-1, 9, P.ink);
    }
  } else {
    const lift = frame === 0 ? 3 : frame === 2 ? 0 : -1;
    for (const x of [0, 3]) { if (x === lift) foot(x, 8, P.ink); else { foot(x, 8, x ? L.pd : L.pants); foot(x, 9, P.ink); } }
  }
  if (carry === "wood") {
    for (let x = -1; x <= 4; x++) { at(x, 3, P.d2); if (x < 1 || x > 2) at(x, 2, P.d3); }
    at(side ? 4 : -1, 2, P.d5); at(side ? 4 : -1, 3, P.d4);
  } else if (carry === "stone") { at(side ? 2 : 1, 4, P.r4); at(side ? 3 : 2, 4, P.r3); at(side ? 2 : 1, 5, P.r3); at(side ? 3 : 2, 5, P.r2); }
  else if (carry === "food") { for (let x = 0; x < 4; x++) at(x, -1, x & 1 ? P.d4 : P.d3); at(1, -2, P.red); at(2, -2, P.f2); }
  if (elder) for (let y = 5; y <= 9 - o + pad; y++) at(4, y, P.d2);
  S.outline(P.ink);
  return S;
}

function walkBig(H, L, facing, frame, carry, elder) {
  const back = facing === "back", prof = facing === "side", dir = 1;
  let hd = Math.max(5, Math.round(H * 0.22));
  if (hd % 2 === 0) hd++;
  let tw = hd + 2;
  if (tw % 2 === 0) tw++;
  const th = Math.round(H * 0.34), pad = carry === "food" ? Math.max(3, Math.round(hd * 0.7)) : 0;
  const W = tw + 16, S = new Spr(W, H + 3 + pad, W >> 1, H + pad), cx = W >> 1;
  const rect = (x0, y0, x1, y1, c) => { for (let y = y0; y <= y1; y++) for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x++) S.set(x, y + pad, c); };
  // contact frames sink a pixel so the stride reads as weight; a stooped elder leans the head forward
  const top = prof && !(frame & 1) ? 1 : 0, r = hd / 2, lean = elder && prof ? 1 : 0, hx = cx + lean * dir;
  for (let y = 0; y < hd; y++)
    for (let dx = -Math.ceil(r); dx <= Math.ceil(r); dx++) {
      const dy = y + 0.5 - r;
      if (dx * dx + dy * dy > r * r + 0.6) continue;
      const hairTop = y < hd * 0.36, hairSide = Math.abs(dx) >= r - 1.1 && y < hd * 0.8;
      const c = back ? L.hair : prof ? (hairTop || dx * dir < 0 ? L.hair : L.skin[0]) : hairTop || hairSide ? L.hair : dx > r - 2 ? L.skin[1] : L.skin[0];
      rect(hx + dx, top + y, hx + dx, top + y, c);
    }
  if (!back) {
    const ey = top + Math.round(hd * 0.56);
    if (prof) { rect(hx + dir * Math.round(r - 1.5), ey, hx + dir * Math.round(r - 1.5), ey, P.ink); rect(hx + dir * Math.ceil(r + 0.2), ey + 1, hx + dir * Math.ceil(r + 0.2), ey + 1, L.skin[0]); }
    else { rect(cx - Math.round(r * 0.45), ey, cx - Math.round(r * 0.45), ey, P.ink); rect(cx + Math.round(r * 0.45), ey, cx + Math.round(r * 0.45), ey, P.ink); if (hd >= 7) rect(cx, ey + 2, cx, ey + 2, L.skin[1]); }
  }
  const ty = top + hd, half = tw >> 1, bw = prof ? half - 1 : half;
  for (let y = 0; y < th; y++) { const w0 = y === 0 || y >= th - 2 ? bw - 1 : bw; for (let x = -w0; x <= w0; x++) rect(cx + x, ty + y, cx + x, ty + y, x > w0 * 0.34 ? L.dark : L.cloth); }
  if (!back && !prof) rect(cx, ty, cx, ty + 1, L.skin[1]);
  rect(cx - bw + 1, ty + th - 1, cx + bw - 1, ty + th - 1, P.d1);
  const aw = H >= 26 ? 2 : 1, al = th - 2, ly = ty + th, lw = Math.max(1, half - 1), foot = H - 1;
  // arms swing against the legs
  const swing = [0, 1, 0, -1][frame] * (prof ? 0 : 1), arm = [-1, 0, 2, 0][frame];
  if (!prof) {
    rect(cx - bw - aw, ty + 1, cx - bw - 1, ty + al - swing, L.cloth);
    rect(cx + bw + 1, ty + 1, cx + bw + aw, ty + al + swing, L.dark);
    rect(cx - bw - aw, ty + al + 1 - swing, cx - bw - 1, ty + al + 2 - swing, L.skin[0]);
    rect(cx + bw + 1, ty + al + 1 + swing, cx + bw + aw, ty + al + 2 + swing, L.skin[1]);
  }
  // legs
  const legLine = (hx0, fx, y0, y1, c, w) => { for (let y = y0; y <= y1; y++) { const t = (y - y0) / Math.max(1, y1 - y0), x = Math.round(hx0 + (fx - hx0) * t); rect(x, y, x + (w - 1) * dir, y, c); } };
  if (prof) {
    rect(cx - lw + 1, ly, cx + lw - 1, ly + 1, L.pants);
    const lg = Math.max(1, lw), sole = (x, toe) => rect(x - dir, foot, x + dir * (toe + lg - 1), foot, P.d0);
    if (frame & 1) {
      // passing: one leg planted under the hip, the other bent back with its foot off the ground
      const [pc, bc] = frame === 1 ? [L.pants, L.pd] : [L.pd, L.pants];
      legLine(cx - dir * (lg + 1), cx - dir * (lg + 2), ly + 2, foot - 2, bc, lg); rect(cx - dir * (lg + 3), foot - 2, cx - dir * (lg + 2), foot - 2, P.d0);
      legLine(cx, cx, ly + 2, foot - 1, pc, lg); sole(cx, 1);
    } else {
      const [fc, bc] = frame === 0 ? [L.pants, L.pd] : [L.pd, L.pants], st = lg + 2;
      legLine(cx - dir, cx - dir * st, ly + 2, foot - 1, bc, lg); sole(cx - dir * st, 0);
      legLine(cx + dir, cx + dir * st, ly + 2, foot - 1, fc, lg); sole(cx + dir * st, 1);
    }
    const sh = [cx, ty + 1], hand = [cx + dir * arm, ty + al + 1];
    legLine(sh[0], hand[0], sh[1], hand[1] - 1, L.dark, aw);
    rect(hand[0], hand[1], hand[0] + dir * (aw - 1), hand[1] + 1, L.skin[1]);
  } else {
    const lift = frame === 0 ? 1 : frame === 2 ? -1 : 0;
    for (const s of [-1, 1]) {
      const up = lift === s ? 1 : 0, x0 = s < 0 ? cx - lw : cx + 1, x1 = s < 0 ? cx - 1 : cx + lw;
      rect(x0, ly, x1, foot - 1 - up, s < 0 ? L.pants : L.pd);
      rect(s < 0 ? x0 - 1 : x0, foot - up, s < 0 ? x1 : x1 + 1, foot - up, P.d0);
    }
  }
  // what they carry
  if (carry === "wood") {
    // on the shoulder, behind the head
    const lr = Math.max(1, Math.round(H * 0.06)), yc = ty - lr, x0 = cx - bw - 4, x1 = cx + bw + 5;
    const behind = (x, y) => y < top + hd && (x - hx - 0.5 + 0.5) ** 2 + (y - top + 0.5 - r) ** 2 <= r * r + 0.6;
    for (let y = -lr; y <= lr; y++) for (let x = x0; x <= x1; x++) if (!behind(x, yc + y)) rect(x, yc + y, x, yc + y, x === x1 ? (y === 0 ? P.d4 : P.d5) : y < 0 ? P.d3 : y > 0 ? P.d1 : P.d2);
  } else if (carry === "stone") {
    const R = SP.rock(Math.max(3, tw * 0.75), H, 0), T = new Spr(S.w, S.h, S.ax, S.ay);
    stamp(S, R, cx + (prof ? dir * 2 : 0), ty + th - 1 + pad);
    rect(cx - bw - 1, ty + al, cx - bw, ty + al + 1, L.skin[0]); rect(cx + bw, ty + al, cx + bw + 1, ty + al + 1, L.skin[1]);
    void T;
  } else if (carry === "food") {
    const bwid = Math.ceil(r) + 1, by = top - 1;
    for (let y = 0; y < 2; y++) for (let x = -bwid; x <= bwid; x++) rect(hx + x, by - y, hx + x, by - y, (x + y) & 1 ? P.d4 : P.d3);
    for (let x = -bwid + 1; x <= bwid - 1; x++) rect(hx + x, by - 2, hx + x, by - 2, pick([P.red, P.f2, P.red, P.a3, P.violet], h2(x, 5, H)));
    for (let x = -1; x <= 1; x++) rect(hx + x, by - 3, hx + x, by - 3, x ? P.red : P.f3);
  }
  if (elder) { const x = prof ? cx + dir * (aw + 2) : cx + bw + aw + 1; rect(x, ty + al, x, foot, P.d2); rect(x, ty + al - 1, x, ty + al - 1, P.d3); }
  S.outline(P.ink);
  return S;
}

// A person down on the ground, asleep or out cold, head to the left.
export function lying(hpx = 8, cloth = P.c0, seed = 0) {
  const L = looks(seed, cloth, false);
  if (hpx < 9) {
    const S = new Spr(9, 4, 4, 2);
    [L.hair, L.skin[0], cloth, cloth, L.dark, L.pants, L.pants, P.ink].forEach((c, x) => S.set(x, 1, c));
    S.set(0, 2, L.hair); S.set(1, 2, L.skin[1]); S.set(2, 2, L.dark); S.set(3, 2, L.dark); S.set(4, 2, L.dark); S.set(5, 2, L.pd); S.set(6, 2, L.pd); S.set(7, 2, P.ink);
    if (hpx >= 7) S.set(3, 0, L.skin[0]);
    return S;
  }
  const H = Math.round(hpx), len = Math.round(H * 0.95), d = Math.max(3, Math.round(H * 0.2)), S = new Spr(len + 6, d + 5, (len + 6) >> 1, d + 2);
  const x0 = 2, gy = S.ay, rect = (a, b, c2, e, c) => { for (let y = b; y <= e; y++) for (let x = a; x <= c2; x++) S.set(x, y, c); };
  const hr = d / 2 + 0.3, hcx = x0 + hr, hcy = gy - hr;
  for (let y = Math.floor(hcy - hr); y <= gy; y++) for (let x = x0; x <= x0 + d; x++) if ((x + 0.5 - hcx) ** 2 + (y + 0.5 - hcy) ** 2 < hr * hr) S.set(x, y, x + 0.5 < hcx - hr * 0.2 || y + 0.5 > hcy + hr * 0.4 ? L.hair : (y + 0.5 < hcy ? L.skin[0] : L.skin[1]));
  if (H >= 14) S.set(Math.round(hcx + hr * 0.3), Math.round(hcy - hr * 0.2), P.ink);
  const t0 = x0 + d, t1 = t0 + Math.round(len * 0.36), tt = d - 1, l1 = x0 + len - 1;
  rect(t0, gy - tt + 1, t1, gy - 1, cloth); rect(t0, gy, t1, gy, L.dark); rect(t0, gy - tt + 1, t1, gy - tt + 1, cloth);
  rect(t0 + 1, gy - tt, t1 - 1, gy - tt, L.dark === cloth ? cloth : cloth);
  rect(t1 - 1, gy - tt + 1, t1, gy - tt + 1, L.skin[0]); // a hand resting on the hip
  rect(t1 - 1, gy - tt + 2, t1, gy - tt + 2, P.d1);
  rect(t1 + 1, gy - tt + 2, l1 - 2, gy - 1, L.pants); rect(t1 + 1, gy, l1 - 2, gy, L.pd);
  rect(l1 - 1, gy - tt + 1, l1, gy, P.d0);
  S.outline(P.ink);
  return S;
}

// ------------------------------------------------------------------------------------------------ flower clumps

const HUES = [P.red, P.f3, P.snow, P.violet, P.a3, P.k0, P.w6];
// A drift of one kind of wildflower: stems of a few heights with heads of one colour and a darker centre.
// species buttercup, daisy, clover, harebell or poppy sets the colour; otherwise hue 0..1, otherwise the seed.
const BLOOM = { buttercup: [P.a3, P.f3], daisy: [P.snow, P.a3], clover: [P.k0, P.red], harebell: [P.violet, P.w6], poppy: [P.red, P.ink] };
export function flowers(hpx = 5, seed = 0, hue, species) {
  const h = Math.max(2, Math.round(hpx)), n = 3 + Math.floor(rv(seed, 1) * 5), W = Math.ceil(h * 1.6) + 5, S = new Spr(W, h + 4, W >> 1, h + 2);
  const c = BLOOM[species]?.[0] ?? pick(HUES, hue ?? rv(seed, 2)), eye = BLOOM[species]?.[1] ?? (c === P.f3 || c === P.a3 ? P.d2 : P.f3), gy = S.ay;
  const heads = [];
  for (let i = 0; i < n; i++) {
    const x = Math.round(S.ax + (h2(i, seed, 3) - 0.5) * h * 1.4), top = gy - Math.max(1, Math.round(h * (0.55 + 0.45 * h2(i, seed, 4))));
    for (let y = top + 1; y <= gy; y++) S.set(x, y, y > gy - 2 ? P.g2 : P.g3);
    if (h >= 5 && h2(i, seed, 5) < 0.5) S.set(x + (i & 1 ? 1 : -1), Math.round((top + gy) / 2), P.g4);
    heads.push([x, top]);
  }
  heads.sort((a, b) => a[1] - b[1]);
  for (const [x, y] of heads) {
    if (h >= 6) { S.set(x - 1, y, c); S.set(x + 1, y, c); S.set(x, y - 1, c); S.set(x, y + 1, SHADOW[c]); S.set(x, y, eye); }
    else S.set(x, y, c);
  }
  S.outline(P.g1, true);
  return S;
}

// ---------------------------------------------------------------------------------------------- one entry point

const TIER_M = [1.2, 2.2, 3, 4.5];
const ITEM_HEAP = { stone: "stone", flint: "stone", ore: "stone", flint_blade: "stone", stick: "sticks", log: "logs", plank: "planks", bark: "sticks",
  meat: "food", fish: "food", berry: "food", mushroom: "food", herb: "food", fat: "food", hide: "hide", leather: "hide", clay: "clay", brick: "brick", reeds: "reeds", fiber: "reeds" };
const BRACKEN = { [P.g2]: P.m2, [P.g3]: P.m3, [P.g4]: P.a1, [P.g5]: P.a2, [P.t1]: P.m0 };
const BARKS = { ash: { [P.d1]: P.r1, [P.d2]: P.r2, [P.d3]: P.r3 }, pine: { [P.d2]: P.k2, [P.d3]: P.k1 } };
function recolor(S, map) {
  if (!map) return S;
  for (let i = 0; i < S.p.length; i++) { const c = map[S.p[i]]; if (c !== undefined) S.p[i] = c; }
  return S;
}
// Copy B over A with B's anchor placed (dx, dy) from A's, growing the canvas as needed; keeps A's anchor and foot.
function layer(A, B, dx, dy) {
  const bx = A.ax + dx - B.ax, by = A.ay + dy - B.ay, x0 = Math.min(0, bx), y0 = Math.min(0, by);
  const T = new Spr(Math.max(A.w, bx + B.w) - x0, Math.max(A.h, by + B.h) - y0, A.ax - x0, A.ay - y0);
  for (let y = 0; y < A.h; y++) for (let x = 0; x < A.w; x++) T.p[(y - y0) * T.w + x - x0] = A.p[y * A.w + x];
  for (let y = 0; y < B.h; y++) for (let x = 0; x < B.w; x++) { const c = B.p[y * B.w + x]; if (c !== 255) T.p[(y + by - y0) * T.w + x + bx - x0] = c; }
  T.foot = A.foot;
  return T;
}

// A fire: open on the ground, or in a stone ring (contained), under a clay kiln dome (covered), or a forge bed of
// charcoal. burning 0..1 sizes the flames, 0 leaves it cold; frame 0..3 flickers them. hpx: the fire's size.
export function fire(hpx = 8, seed = 0, { contained, covered, charcoal, burning = 1, frame = 0 } = {}) {
  const r = Math.max(2, hpx * 0.45), lit = burning > 0.05, hot = ramp("f0", "f1", "f2", "f3");
  let S = contained || covered || charcoal ? firering(r, seed) : ash(r * 0.8, seed);
  if (charcoal) {
    const C = iso(r, r, r);
    ball(C, 0, 0, 0, r * 0.6, r * 0.6, r * 0.35, (x, y, sh) => (lit && h2(x, y, seed + frame) < 0.3 ? dith(hot, 1.5 + sh * 1.5, x, y) : sh > 0.3 ? P.r1 : P.r0));
    S = layer(S, done(C, 0, P.ink), 0, -S.foot);
  }
  if (covered) {
    const K = iso(r + 2, r + 2, r * 1.5), cl = MAT.clay.wall;
    ball(K, 0, 0, 0, r * 0.9, r * 0.9, r * 1.2, (x, y, sh) => dith(cl, 2.2 + sh * 2, x, y));
    // the stoke hole faces the camera and glows when the kiln is lit
    for (let a = Math.PI / 4 - 0.35; a <= Math.PI / 4 + 0.35; a += 0.05)
      for (let z = 0; z < r * 0.5; z += 0.3) { const q = r * 0.9 * Math.sqrt(Math.max(0, 1 - (z / (r * 1.2)) ** 2)) + 0.2; dot(K, q * Math.cos(a), q * Math.sin(a), z, lit ? (z < r * 0.25 ? P.f3 : P.f1) : P.d0); }
    if (lit) ball(K, 0, 0, r * 1.15, 0.5, 0.5, 0.3, () => P.f2);
    return layer(S, done(K, 0), 0, -S.foot);
  }
  if (!lit) return S;
  const fh = Math.max(4, Math.round(hpx * (charcoal ? 0.6 : 1.1) * Math.min(1, burning + 0.2)));
  return layer(S, SP.flames(fh, seed * 4 + (frame & 3)), 0, -S.foot);
}

// A tussock of tall grass, sized by its width on the ground (wpx): a dark mounded base under a mass of splaying
// blades in three greens, lit on the left. Some clumps are seeding and carry pale heads on their tallest blades
// (seeding forces it on or off); dry 0..1 turns it to straw. Anchored at the front of its footprint; S.foot as usual.
export function tallgrass(wpx = 8, seed = 0, dry = 0, seeding) {
  const w = Math.max(3, wpx), rx = w / 2, ry = w / 4, h = Math.max(2, w * 0.55), seedy = seeding ?? rv(seed, 5) < 0.35;
  const S = new Spr(Math.ceil(w * 1.5) + 8, Math.ceil(h + ry * 2) + 6, (Math.ceil(w * 1.5) + 8) >> 1, Math.ceil(h + ry * 2) + 3);
  const cx = S.ax + 0.5, cy = S.ay + 0.5 - ry;
  // skip the meadow's own mid green so the clump never melts into the ground under it
  const G = dry > 0.6 ? ramp("m0", "m1", "a0", "a1", "a2", "s2") : ramp("t1", "g1", "g2", "g4", "g5", "g6");
  const head = dry > 0.6 ? P.s3 : pick([P.s2, P.a3, P.s1], rv(seed, 6));
  blob(S, cx, cy, rx * 0.9, ry, (x, y, l) => dith(G, 0.4 + l * 0.9, x, y));
  S.outline(G[0], true);
  const blades = [], n = Math.min(400, Math.round(w * 3.2) + 6);
  for (let i = 0; i < n; i++) {
    const a = h2(i, seed, 1) * 6.283, r = Math.sqrt(h2(i, seed, 2)), ox = Math.cos(a) * r, bx = cx + ox * rx * 0.8, by = cy + Math.sin(a) * r * ry * 0.8;
    // outer blades are shorter and arch outward; the middle ones stand up
    const L = Math.max(1, h * (0.45 + 0.55 * h2(i, seed, 3)) * (1 - r * 0.45)), lean = ox * (0.5 + 0.6 * r) + (h2(i, seed, 4) - 0.5) * 0.4;
    blades.push([by, bx, L, lean, i]);
  }
  blades.sort((p, q) => p[0] - q[0]);
  for (const [by, bx, L, lean, i] of blades)
    for (let k = 0; k <= L; k++) {
      const f = k / L, x = Math.round(bx + lean * k * f * 0.9), y = Math.round(by - k + Math.abs(lean) * f * f * L * 0.25);
      let c = G[clamp(Math.floor(1 + f * 3.8 + (lean < 0 ? 0.7 : -0.3) + (h2(i, k, seed) - 0.5) * 0.6), 1, G.length - 1)];
      if (seedy && i % 3 === 0 && L > h * 0.6 && k >= L - 2.2) c = k >= L - 0.5 ? P.s3 : head;
      S.set(x, y, c);
    }
  S.foot = Math.round(ry);
  return S;
}

// A key colour pair (lit, shade) per kind, for the smallest sizes where only a dot or two reads.
const KEY = {
  tree: [P.g4, P.t2], pine: [P.p4, P.p2], bush: [P.g4, P.g2], dead_bush: [P.d3, P.d1], sapling: [P.g5, P.g3], fern: [P.g4, P.g2],
  flowers: [P.red, P.g3], herb: [P.g5, P.g3], reeds: [P.a2, P.m2], mushroom: [P.red, P.s2], stone: [P.r4, P.r2], pebble: [P.r4, P.r2],
  boulder: [P.r4, P.r1], stick: [P.d4, P.d2], log: [P.d3, P.d1], fallen_log: [P.d3, P.d1], stump: [P.d4, P.d2], burnt_stump: [P.r1, P.ink], clay: [P.k1, P.d2],
  ash: [P.r3, P.r1], pit: [P.d2, P.d0], trap: [P.d3, P.d1], well: [P.r4, P.w3], grave: [P.d3, P.r3], item: [P.s2, P.d2], structure: [P.d4, P.d2], fire: [P.f3, P.f1], grass: [P.g5, P.g3],
};
// Minis: hand-placed rows, a = lit, b = shade, for 2 to 4 px.
const MINIS = {
  tree: [[" a ", "ab"], ["ab", "bb", " t"], [" ab ", "aabb", " bb ", "  t "]],
  pine: [["a", "b"], [" a ", "ab ", " t "], [" a ", "aab", "abb", " t "]],
  bush: [["ab"], ["ab", "bb"], [" ab", "abb"]],
  rock: [["ab"], ["ab", "bb"], [" ab ", "abbb"]],
  stem: [["a", "b"], ["a", "b", "b"], ["a", "b", "b", "b"]],
  flat: [["ab"], ["abb"], ["aabb"]],
};
const SHAPE = { tree: "tree", pine: "pine", bush: "bush", dead_bush: "bush", fern: "bush", herb: "bush", mushroom: "rock", stone: "rock", pebble: "flat", boulder: "rock",
  stick: "flat", log: "flat", fallen_log: "flat", stump: "rock", burnt_stump: "rock", clay: "flat", ash: "flat", pit: "flat", trap: "flat", well: "rock", grave: "flat",
  item: "rock", structure: "rock", fire: "stem", grass: "bush", sapling: "stem", reeds: "stem", flowers: "stem" };
function mini(kind, hpx, species) {
  const k = species === "pine" && kind === "tree" ? "pine" : kind, [a, b] = KEY[k] ?? KEY[kind] ?? [P.r4, P.r2];
  if (hpx < 1.6) { const S = new Spr(1, 1, 0, 0); S.p[0] = a; return S; }
  const list = MINIS[SHAPE[k] ?? SHAPE[kind] ?? "rock"][hpx < 2.6 ? 0 : hpx < 3.6 ? 1 : 2];
  return rows(list, { a, b, t: P.d1 }, 1, { outline: -1 });
}

// Draw any sim object by kind at any size: hpx is its size in art px (its size in meters times the zoom's px per
// meter): height for most kinds, length for stick and fallen_log, width for grass. It grows smoothly from a 1 px dot to the close
// zoom sprite. o: species, stage, berries, tier, style, dir, flag, burning. Anchored at the ground point.
export function object(kind, hpx, seed = 0, o = {}) {
  const S = drawObject(kind, hpx, seed, o), b = o.burning ?? 0;
  if (kind === "fire" || b <= 0.05 || hpx < 4) return S;
  // a thing on fire: flames stood on it, reaching up its height; trees burn in the crown
  const F = SP.flames(Math.max(4, Math.round(hpx * (kind === "tree" ? 0.55 : 0.8) * Math.min(1, b + 0.3))), seed * 4 + (o.frame ?? 0));
  return layer(S, F, 0, kind === "tree" ? -Math.round(hpx * 0.45) : -(S.foot ?? 0));
}
function drawObject(kind, hpx, seed, o) {
  const sp = o.species, h = Math.max(0, hpx), minis = kind === "structure" ? 5 : kind === "boulder" || kind === "tree" ? 4.5 : 4;
  if (h < minis) return mini(kind, h, sp);
  const r = Math.round;
  switch (kind) {
    case "tree": return sp === "pine" ? SP.pine(r(h), seed) : SP.broad(r(h), ["oak", "ash", "aspen"].includes(sp) ? sp : "oak", seed, o.tint ?? 0.5);
    case "sapling": return sapling(h, seed);
    case "bush": {
      const berries = o.berries ?? (o.n != null ? o.n > 0 : sp === "berry");
      const S = SP.bush(h * 0.9, seed, sp === "heath" || sp === "heather" ? 1 : 0, berries ? 0.95 : 0);
      if (sp === "gorse") for (let i = 0; i < S.p.length; i++) if (S.p[i] !== 255 && S.p[i] !== P.ink && h2(i, seed, 7) < 0.14) S.p[i] = h2(i, seed, 8) < 0.5 ? P.a3 : P.f3;
      return S;
    }
    case "dead_bush": return deadbush(h, seed);
    case "fern": return recolor(SP.fern(h * 0.9, seed), sp === "bracken" ? BRACKEN : null);
    case "flowers": case "flower": return flowers(h, seed, o.hue, sp);
    case "herb": return herb(h, seed, sp);
    case "reeds": return SP.reeds(h, seed);
    // hpx is the tussock's width; grazing shrinks it through size
    case "grass": return tallgrass(h, seed, o.dry ?? 0, o.seeding);
    case "mushroom": return LFmushrooms(h, seed, sp);
    case "stone": return SP.rock(h * 1.2, seed, o.moss ?? 0);
    case "pebble": return h < 6 ? SP.pebble(Math.max(1, h * 0.5), seed) : SP.rock(h * 0.7, seed);
    case "boulder": return SP.rock(h * 1.25, seed, o.moss ?? 0.3);
    case "stick": return stick(h, seed);
    case "log": case "fallen_log": return recolor(SP.log(h, Math.max(1.5, h * 0.06), o.dir ?? (rv(seed, 9) < 0.5 ? 1 : -1), seed, sp === "drift" || sp === "driftwood"), BARKS[sp]);
    case "stump": return SP.stump(Math.max(2, h * 0.6), Math.max(2, h * 0.5), seed);
    case "burnt_stump": return burnt(h, seed);
    case "clay": return clay(h * 0.8, seed);
    case "ash": return ash(h, seed);
    case "pit": return pit(h * 0.7, o.stage ?? 1, seed);
    case "trap": return trap(h, !!(o.sprung || o.caught), seed, o.flag ?? -1, o.dir ?? 0);
    case "well": return well(h, seed, o.dir ?? 0);
    case "grave": return grave(h, seed, o.dir ?? 0);
    case "item": return turned(o.dir ?? 0, () => heap(o.what ?? ITEM_HEAP[String(sp ?? "").split(":")[0]] ?? "misc", Math.max(2.5, h), seed));
    case "structure": {
      // size is the building's height by tier; shelter() wants the height a tier 2 hut would have at this zoom
      const tier = o.tier ?? 1;
      return shelter(tier, o.style ?? sp ?? "sticks", (h * 3) / TIER_M[clamp(tier | 0, 0, 3)], seed, o.flag ?? -1, o.dir ?? 0);
    }
    case "fire": return fire(h, seed, o);
  }
  return mini(kind, Math.min(h, 3), sp);
}

// ------------------------------------------------------------------------------------------------ animals

// Mirror a sprite left to right about its anchor.
function flip(S) {
  const T = new Spr(S.w, S.h, S.w - 1 - S.ax, S.ay);
  for (let y = 0; y < S.h; y++) for (let x = 0; x < S.w; x++) T.p[y * S.w + S.w - 1 - x] = S.p[y * S.w + x];
  T.foot = S.foot;
  return T;
}
const BIRD_C = { gull: [P.snow, P.r3, P.a2], crow: [P.r0, P.ink, P.r1], eagle: [P.d2, P.d0, P.a2] };
// A bird sitting on the ground or a branch, facing right. hpx: its height, 2 to 8.
export function perched(kind = "gull", hpx = 4, seed = 0) {
  const [a, b, beak] = BIRD_C[kind] ?? BIRD_C.gull, head = kind === "eagle" && rv(seed, 1) < 0.6 ? P.snow : a, h = Math.max(2, Math.round(hpx));
  const list = h <= 2 ? ["hA", "BB"] : h <= 3 ? [".hk", "aB.", "B.."] : h <= 5 ? ["..hk", ".aB.", "aBB.", "BB..", ".l.."] : ["...hk", "...h.", ".aaB.", "aaBB.", "BBB..", "B.l..", "..l.."];
  const S = rows(list, { h: head, k: beak, a, A: a, B: b, l: P.d1 }, 1, { outline: kind === "gull" ? P.r2 : -1, late: "kl" });
  if (kind === "gull" && h > 3) S.set(S.w - 5, 2, P.ink);
  return S;
}
// A fish swimming just under the surface: a dim shape with a tail beat and a faint wake. frame 0..3, facing right.
export function swimmer(len = 5, frame = 0, seed = 0) {
  const L = Math.max(2, Math.round(len)), S = new Spr(L + 5, 5, (L + 5) >> 1, 2), x0 = 2, beat = [0, 1, 0, -1][frame & 3];
  for (let x = 0; x < L; x++) {
    const t = x / Math.max(1, L - 1), w = t > 0.25 && t < 0.85 && L >= 5 ? 1 : 0;
    S.set(x0 + x, 2, t > 0.8 ? P.w2 : P.w1);
    if (w) S.set(x0 + x, 1, P.w2);
  }
  S.set(x0 - 1, 2 + beat, P.w2);
  if (L >= 4) S.set(x0 - 1, 2 - beat, P.w1);
  for (let x = -1; x < L + 1; x += 2) if (h2(x, frame, seed) < 0.4) S.set(x0 + x, 0, P.w6);
  return S;
}

// Draw any sim animal at any size by species and state. hpx: standing height for walkers, wingspan for birds, length
// for fish, span for butterflies; below each sprite's smallest size it becomes a one or two pixel dot. facing: 1
// right, 0 left (mirrors anything that faces by seed). frame 0..3 animates gaits and wingbeats. Anchors as the
// underlying sprites: ground point, except fliers (body centre) and fish (water surface).
export function animal(species, state = "wander", hpx = 6, frame = 0, seed = 0, facing = 1) {
  frame &= 3;
  const st = String(state), dir = facing ? 1 : -1;
  const dot = (a, b) => { const S = new Spr(hpx >= 1.6 ? 2 : 1, 1, 0, 0); S.p[0] = a; if (S.w > 1) S.p[1] = b; return dir > 0 ? S : flip(S); };
  const face = (S, right) => (right === (dir > 0) ? S : flip(S));
  switch (species) {
    case "deer": {
      if (hpx < 3) return dot(P.d3, P.d2);
      const pose = /flee|run/.test(st) ? "run" : /graze|eat|feed/.test(st) ? "graze" : /fawn/.test(st) ? "fawn" : "stand";
      return LF.deer(hpx, pose, facing, seed);
    }
    case "wolf": {
      if (hpx < 3) return dot(P.r3, P.r1);
      const pose = /hunt|attack|flee|run/.test(st) ? "run" : /wander|walk|move/.test(st) ? "walk" : /eat|feed/.test(st) ? "eat" : /rest|sleep/.test(st) ? "rest" : "stand";
      return face(wolf(hpx, pose, frame, seed), true);
    }
    case "rabbit": case "hare": {
      if (hpx < 2) return dot(P.d3, P.d2);
      return face(LF.rabbit(hpx, /flee|run|hop|wander/.test(st) && frame & 1 ? "hop" : "sit", seed), rv(seed, 7) < 0.5);
    }
    case "heron": case "egret": {
      if (/fly|soar|land|flutter|dive/.test(st)) return birdAt("gull", hpx * 1.4, frame, seed, dir);
      if (hpx < 5) return hpx < 2 ? dot(P.r4, P.r2) : face(perched("gull", hpx, seed), true);
      return face(LF.heron(hpx, /feed|fish|hunt|eat/.test(st) ? "fish" : "stand", seed), rv(seed, 3) < 0.5);
    }
    case "gull": case "crow": case "eagle": {
      if (/perch|rest|sit|feed|eat|land|wade|trapped/.test(st)) return hpx < 2 ? dot(...BIRD_C[species].slice(0, 2)) : face(perched(species, hpx * 0.45, seed), true);
      // soaring holds the wings flat, a dive folds them up
      return birdAt(species, hpx, /soar/.test(st) ? 1 : /dive/.test(st) ? 0 : frame, seed, dir);
    }
    case "fish": {
      if (/jump|leap/.test(st)) return LF.fish(frame, seed, Math.max(3, hpx));
      return hpx < 2 ? dot(P.w2, P.w1) : face(swimmer(hpx, frame, seed), true);
    }
    case "butterfly": return hpx < 3 ? dot(pick([P.a3, P.f2, P.snow, P.w6, P.red], rv(seed, 1)), P.ink) : LF.butterfly(/rest|perch|land|feed/.test(st) ? 2 : frame, seed);
  }
  return dot(P.d3, P.d2);
}
function birdAt(kind, span, frame, seed, dir) {
  if (span < 3) { const S = new Spr(span >= 2 ? 2 : 1, 1, 0, 0); S.p.fill(BIRD_C[kind]?.[kind === "gull" ? 0 : 1] ?? P.snow); return S; }
  const S = LF.bird(span, frame, kind, seed);
  return dir > 0 ? S : flip(S);
}
