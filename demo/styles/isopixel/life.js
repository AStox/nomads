// Wildlife and landmarks for the island, painted like sprites.js: the same upper-left key light, short ramps, ordered
// dither and a selective outline. Each sprite is anchored at its ground point unless its comment says otherwise.
import { P, ramp, SHADOW } from "./pal.js";
import { Spr, dith, h2 } from "./px.js";
import { R } from "./sprites.js";

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const LX = -0.55, LY = -0.62, LZ = 0.56;
export const lit = (nx, ny, nz) => nx * LX + ny * LY + nz * LZ;
const pick = (a, u) => a[Math.min(a.length - 1, Math.floor(u * a.length))];
const tone = (r, v0, span = 1.6) => (x, y, l) => dith(r, v0 + l * span, x, y);
// Smooth 1D value noise in [0, 1).
export const vnoise = (t, s) => { const i = Math.floor(t), f = t - i, u = f * f * (3 - 2 * f); return h2(i, 17, s) * (1 - u) + h2(i + 1, 17, s) * u; };
// a well-mixed pick per seed: h2 alone correlates across small consecutive seeds
export const rv = (seed, k) => h2(Math.floor(h2(seed, k, 77) * 1e9), k, 5);
export const solid = (c) => () => c;

// paint(x, y, light, nx, ny) returns a palette index, or -1 to leave the pixel alone.
export function blob(S, cx, cy, rx, ry, paint) {
  rx = Math.max(0.55, rx); ry = Math.max(0.55, ry);
  const x0 = Math.floor(cx - rx), x1 = Math.ceil(cx + rx), y0 = Math.floor(cy - ry), y1 = Math.ceil(cy + ry);
  let any = false;
  for (let y = y0; y <= y1; y++)
    for (let x = x0; x <= x1; x++) {
      const nx = (x + 0.5 - cx) / rx, ny = (y + 0.5 - cy) / ry, d2 = nx * nx + ny * ny;
      if (d2 >= 1) continue;
      any = true;
      const c = paint(x, y, lit(nx, ny, Math.sqrt(1 - d2)), nx, ny);
      if (c >= 0) S.set(x, y, c);
    }
  // too small to cover a pixel center: still leave one pixel
  if (!any) { const x = Math.floor(cx), y = Math.floor(cy), c = paint(x, y, 0.2, 0, 0); if (c >= 0) S.set(x, y, c); }
}

// A tapered rod shaded as a lit cylinder. Rods thinner than a pixel become a stepped one-pixel line.
export function seg(S, ax, ay, bx, by, ra, rb, paint) {
  const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy || 1e-6;
  if (Math.max(ra, rb) < 0.72) {
    const n = Math.ceil(Math.sqrt(L2) * 3) + 1;
    for (let k = 0; k <= n; k++) {
      const x = Math.floor(ax + (dx * k) / n), y = Math.floor(ay + (dy * k) / n), c = paint(x, y, 0.15, 0, 0);
      if (c >= 0) S.set(x, y, c);
    }
    return;
  }
  const r = Math.max(ra, rb), x0 = Math.floor(Math.min(ax, bx) - r), x1 = Math.ceil(Math.max(ax, bx) + r);
  const y0 = Math.floor(Math.min(ay, by) - r), y1 = Math.ceil(Math.max(ay, by) + r);
  for (let y = y0; y <= y1; y++)
    for (let x = x0; x <= x1; x++) {
      const px = x + 0.5, py = y + 0.5, t = clamp(((px - ax) * dx + (py - ay) * dy) / L2, 0, 1);
      const rr = ra + (rb - ra) * t, ox = px - ax - dx * t, oy = py - ay - dy * t, d2 = (ox * ox + oy * oy) / (rr * rr);
      if (d2 >= 1) continue;
      const nx = ox / rr, ny = oy / rr, c = paint(x, y, lit(nx, ny, Math.sqrt(1 - d2)), nx, ny);
      if (c >= 0) S.set(x, y, c);
    }
}
// A polyline of rods, radius running from r0 to r1 over its length.
export function rod(S, pts, r0, r1, paint) {
  let total = 0;
  for (let k = 1; k < pts.length; k++) total += Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]);
  let at = 0;
  for (let k = 1; k < pts.length; k++) {
    const l = Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]);
    const ra = r0 + (r1 - r0) * (at / total), rb = r0 + (r1 - r0) * ((at + l) / total);
    seg(S, pts[k - 1][0], pts[k - 1][1], pts[k][0], pts[k][1], ra, rb, paint);
    at += l;
  }
}

// Hand-placed pixel rows for sizes too small to paint procedurally; `key` maps characters to palette indices.
// Characters in `late` (legs, bills) go on after the outline, so a one-pixel leg stays one pixel wide.
export function rows(list, key, dir, { lift = 0, outline = -1, late = "" } = {}) {
  const w = list[0].length, n = list.length, S = new Spr(w + 1, n + 1 + lift, dir > 0 ? (w - 1) >> 1 : w - 1 - ((w - 1) >> 1), n - 1 + lift);
  const paint = (pass) => list.forEach((row, y) => [...row].forEach((ch, x) => {
    const c = key[ch];
    if (c !== undefined && c >= 0 && late.includes(ch) === pass) S.set(dir > 0 ? x : w - 1 - x, y, c);
  }));
  paint(false);
  if (outline >= 0) S.outline(outline, true);
  paint(true);
  return S;
}
// Fill only the empty pixels of S from T: parts that sit behind what is already drawn.
export function under(S, T) { for (let i = 0; i < S.p.length; i++) if (S.p[i] === 255) S.p[i] = T.p[i]; }

// ---------------------------------------------------------------------------------------------------------------- deer

const COATS = [ramp("d0", "d1", "d2", "d3", "d4"), ramp("d0", "d1", "k2", "d3", "k1"), ramp("d0", "d1", "d2", "d3", "d5")];
const TINY_DEER = {
  stand5: [".....HN", "WLLLLB.", ".BBBBD.", ".E..E..", ".E..E.."],
  graze5: ["WLLLL..", ".BBBBB.", ".E..E.H", ".E..E.N"],
  run5: [".....HN", "WLLLLB.", "EBBBBD.", "E....E.", ".....E."],
  stand4: ["....HN", "WLLLB.", ".E..E.", ".E..E."],
  graze4: ["WLLL..", ".BBBB.", ".E.E.H", ".E.E.N"],
  run4: ["....HN", "WLLLB.", "E.BB.E", "E....E"],
  stand3: ["...HN", "LLLB.", "E..E."],
  graze3: ["LLL..", "BBBBH", "E.E.N"],
  run3: ["...HN", "WLLB.", "E...E"],
  fawn3: ["..HN", "LLB.", "E.E."],
  fawn4: ["...HN", ".LLB.", ".E.E.", ".E.E."],
};
// Deer poses in body units (1 = standing head height), facing right: legs [hip, knee, hoof], far pair first.
const DEER = {
  stand: { body: [0, 0.62], legs: [[-0.19, 0.6, -0.23, 0.3, -0.2, 0], [0.25, 0.56, 0.27, 0.28, 0.28, 0], [-0.27, 0.6, -0.33, 0.32, -0.3, 0], [0.19, 0.56, 0.18, 0.28, 0.17, 0]], neck: [0.25, 0.66, 0.36, 0.86], head: [0.39, 0.9], snout: [0.53, 0.86], ear: [0.32, 1.02], tail: [-0.36, 0.68, -0.4, 0.6] },
  graze: { body: [-0.06, 0.62], legs: [[-0.25, 0.6, -0.29, 0.3, -0.26, 0], [0.19, 0.56, 0.22, 0.28, 0.24, 0], [-0.33, 0.6, -0.39, 0.32, -0.36, 0], [0.12, 0.56, 0.14, 0.28, 0.16, 0]], neck: [0.2, 0.62, 0.5, 0.22], head: [0.55, 0.13], snout: [0.6, 0.02], ear: [0.47, 0.27], tail: [-0.42, 0.68, -0.46, 0.6] },
  run: { body: [0, 0.68], legs: [[-0.2, 0.64, -0.34, 0.44, -0.42, 0.26], [0.22, 0.62, 0.34, 0.44, 0.36, 0.24], [-0.27, 0.64, -0.46, 0.5, -0.62, 0.4], [0.26, 0.62, 0.44, 0.52, 0.58, 0.46]], neck: [0.26, 0.74, 0.4, 0.88], head: [0.45, 0.9], snout: [0.59, 0.86], ear: [0.38, 1.02], tail: [-0.35, 0.74, -0.39, 0.86] },
};

// hpx: an adult's standing height at this scale; a fawn draws itself about two thirds as tall. facing 1 = right.
export function deer(hpx, pose = "stand", facing = 1, seed = 0) {
  const fawn = pose === "fawn", h = Math.max(3, Math.round(hpx * (fawn ? 0.66 : 1))), dir = facing ? 1 : -1;
  const coat = pick(COATS, rv(seed, 1)), buck = !fawn && rv(seed, 2) < 0.45;
  if (h <= 5) {
    const key = { L: coat[3], B: coat[2], D: coat[1], E: coat[1], H: coat[3], N: P.ink, W: P.s3 };
    const name = fawn ? (h <= 4 ? "fawn" + Math.max(3, h) : "stand5") : pose + h;
    return rows(TINY_DEER[name] || TINY_DEER["stand" + h], key, dir, { late: "EN" });
  }
  const G = DEER[fawn ? "stand" : pose] || DEER.stand, big = h >= 9, fine = h >= 14;
  const W = Math.ceil(h * 1.45) + 4, H = Math.ceil(h * 1.35) + 3, S = new Spr(W, H, W >> 1, H - 2), gy = S.ay + 0.95;
  const X = (u) => S.ax + 0.5 + dir * u * h, Y = (v) => gy - v * h, pt = (u, v) => [X(u), Y(v)];
  const fur = (dv) => (x, y, l) => dith(coat, 2.1 + dv + l * 1.5 + (h2(x, y, seed) - 0.5) * 0.35, x, y);
  const near = fur(0), belly = ramp("d3", "s1", "s2");
  const coatP = (x, y, l, nx, ny) => {
    if (fawn && ny < -0.1 && h2(x, y, seed + 5) < 0.2) return P.s3;
    return big && ny > 0.55 ? dith(belly, 0.6 + l * 1.4, x, y) : near(x, y, l);
  };
  const [bu, bv] = G.body;
  const bl = fawn ? 0.9 : 1; // a fawn is short in the body and long in the leg
  blob(S, X(bu - 0.21 * bl), Y(bv + 0.01), 0.13 * h, 0.13 * h, coatP);
  blob(S, X(bu), Y(bv), 0.3 * h * bl, 0.12 * h, coatP);
  blob(S, X(bu + 0.21 * bl), Y(bv - 0.01), 0.11 * h, 0.12 * h, coatP);
  if (big && !fawn) blob(S, X(bu - 0.31), Y(bv + 0.02), 0.05 * h, 0.07 * h, solid(P.s3)); // pale rump
  seg(S, X(G.tail[0]), Y(G.tail[1]), X(G.tail[2]), Y(G.tail[3]), 0.045 * h, 0.035 * h, (x, y, l) => (l > -0.1 ? P.s3 : P.s1));
  const [hu, hv] = G.head, hs = fawn ? 1.3 : 1;
  const nr = pose === "graze" ? 0.07 : 0.085;
  seg(S, X(G.neck[0]), Y(G.neck[1]), X(G.neck[2]), Y(G.neck[3]), Math.max(0.8, nr * h), Math.max(0.75, 0.06 * h), near);
  const ear = (du, paint) => seg(S, X(hu - 0.03 + du), Y(hv + 0.03), X(G.ear[0] + du), Y(G.ear[1] + (fawn ? 0.03 : 0)), 0.035 * h * hs, 0.025 * h * hs, paint);
  ear(0.04, fur(-0.7));
  blob(S, X(hu), Y(hv), Math.max(0.8, 0.08 * h * hs), Math.max(0.6, 0.06 * h * hs), near);
  seg(S, X(hu + 0.02), Y(hv - 0.005), X(G.snout[0]), Y(G.snout[1]), Math.max(0.6, 0.045 * h), 0.032 * h, near);
  ear(0, near);
  if (buck && h >= 7) {
    const up = pose === "graze" ? -0.6 : 1, ant = tone(ramp("d2", "d4", "s1"), 1.2, 1.2);
    rod(S, [pt(hu - 0.03, hv + 0.05), pt(hu - 0.08, hv + 0.2 * up), pt(hu - 0.17, hv + 0.3 * up)], 0.3, 0.3, ant);
    seg(S, X(hu - 0.07), Y(hv + 0.15 * up), X(hu), Y(hv + 0.26 * up), 0.3, 0.3, ant);
    if (fine) seg(S, X(hu - 0.12), Y(hv + 0.25 * up), X(hu - 0.1), Y(hv + 0.36 * up), 0.3, 0.3, ant);
  }
  if (h >= 7) S.set(Math.floor(X(G.snout[0])), Math.floor(Y(G.snout[1])), P.ink);
  if (h >= 10) S.set(Math.floor(X(hu + 0.02)), Math.floor(Y(hv + 0.01)), P.ink);
  S.outline(coat[0], true);
  // legs after the outline: one pixel thin at field sizes, a tapered thigh up close; hooves dark
  const T = new Spr(S.w, S.h, S.ax, S.ay);
  const leg = (on, L, c, hind) => {
    const hip = pt(L[0], L[1]), hock = pt(L[2], L[3]), hoof = pt(L[4], L[5]), paint = fine ? fur(hind ? -0.2 : -0.5) : solid(c);
    seg(on, hip[0], hip[1], hock[0], hock[1], fine ? (hind ? 0.075 : 0.05) * h : 0.5, 0.5, paint);
    seg(on, hock[0], hock[1], hoof[0], hoof[1], 0.5, 0.5, solid(c));
    if (h >= 12) on.set(Math.floor(hoof[0]), Math.floor(hoof[1] - 0.2), coat[0]);
  };
  leg(T, G.legs[0], coat[1], true); leg(T, G.legs[1], coat[1], false);
  under(S, T);
  leg(S, G.legs[2], coat[2], true); leg(S, G.legs[3], coat[2], false);
  return S;
}

// -------------------------------------------------------------------------------------------------------------- rabbit

const FURS = [ramp("d0", "d1", "d3", "d4", "s1"), ramp("r0", "r1", "r3", "r4", "r5"), ramp("r1", "r3", "r4", "s3", "snow")];
const TINY_RABBIT = {
  sit2: [".E", "LB"],
  sit3: ["..E", ".LB", "TBD"],
  sit4: ["..E.", "..LN", ".LBB", "TBBD"],
  sit5: ["..EE.", "..LLN", ".LLB.", "TBBBD", ".BBD."],
  hop2: ["LLE", "D.D"],
  hop3: ["..EE", "TLLN", "D..D"],
  hop4: ["...E.", "TLLLN", "D...D"],
  hop5: ["...EE.", ".LLLLN", "TBBBD.", "D....D"],
};
// hpx: sitting height to the ear tips. The facing comes from the seed.
export function rabbit(hpx, pose = "sit", seed = 0) {
  const h = Math.max(2, Math.round(hpx)), dir = rv(seed, 7) < 0.5 ? 1 : -1, fur = pick(FURS, rv(seed, 1) * rv(seed, 2) * 1.6);
  const hop = pose === "hop";
  if (h <= 5) {
    const key = { L: fur[3], B: fur[2], D: fur[1], E: fur[2], N: P.ink, T: P.snow };
    return rows(TINY_RABBIT[(hop ? "hop" : "sit") + h], key, dir, { lift: hop ? 1 : 0, outline: fur[0], late: "N" });
  }
  const W = Math.ceil(h * 1.4) + 4, S = new Spr(W, h + 4, W >> 1, h + 1), gy = S.ay + 0.95;
  const X = (u) => S.ax + 0.5 + dir * u * h, Y = (v) => gy - v * h, near = tone(fur, 2.1, 1.5), far = tone(fur, 1.3, 1.2);
  if (hop) {
    // mid-bound: back arched, hind feet kicked out behind, forepaws reaching down, ears laid up and back
    seg(S, X(-0.2), Y(0.36), X(-0.48), Y(0.2), 0.1 * h, 0.05 * h, far);
    seg(S, X(-0.48), Y(0.2), X(-0.64), Y(0.2), 0.05 * h, 0.04 * h, far);
    seg(S, X(0.3), Y(0.3), X(0.42), Y(0.06), 0.05 * h, 0.04 * h, far);
    blob(S, X(-0.06), Y(0.46), 0.3 * h, 0.2 * h, near);
    blob(S, X(0.14), Y(0.5), 0.14 * h, 0.15 * h, near);
    blob(S, X(0.32), Y(0.46), 0.14 * h, 0.12 * h, near);
    seg(S, X(0.24), Y(0.34), X(0.34), Y(0.04), 0.045 * h, 0.04 * h, near);
    seg(S, X(0.24), Y(0.54), X(0.0), Y(0.74), 0.06 * h, 0.04 * h, far);
    seg(S, X(0.28), Y(0.56), X(0.06), Y(0.8), 0.06 * h, 0.045 * h, near);
    blob(S, X(-0.36), Y(0.54), 0.08 * h, 0.08 * h, solid(P.snow));
    if (h >= 8) S.set(Math.floor(X(0.36)), Math.floor(Y(0.5)), P.ink);
  } else {
    blob(S, X(-0.08), Y(0.28), 0.3 * h, 0.28 * h, near);
    seg(S, X(0.16), Y(0.22), X(0.18), Y(0.02), 0.06 * h, 0.05 * h, near);
    blob(S, X(0.18), Y(0.58), 0.17 * h, 0.15 * h, near);
    seg(S, X(0.1), Y(0.68), X(0.04), Y(0.98), 0.06 * h, 0.04 * h, far);
    seg(S, X(0.16), Y(0.7), X(0.13), Y(1.0), 0.06 * h, 0.045 * h, near);
    blob(S, X(-0.38), Y(0.18), 0.1 * h, 0.1 * h, solid(P.snow));
    if (h >= 8) S.set(Math.floor(X(0.24)), Math.floor(Y(0.61)), P.ink);
  }
  S.outline(fur[0], true);
  return S;
}

// --------------------------------------------------------------------------------------------------------------- heron

const TINY_HERON = {
  stand5: ["..WY", "..W.", ".gW.", "DGG.", "..L."],
  stand6: ["..WY", ".KW.", "..W.", ".gW.", "DGG.", "..L."],
  fish5: [".gGWW.", "DGG..W", "..L..Y", "..L..."],
  fish6: [".gG...", "DGGWW.", "..L..W", "..L..Y", "..L..."],
};
// A grey heron, or for some seeds a white egret. 'fish' wades with its neck out and bill down, in a ripple ring.
export function heron(hpx, pose = "stand", seed = 0) {
  const h = Math.max(5, Math.round(hpx)), dir = rv(seed, 3) < 0.5 ? 1 : -1, egret = rv(seed, 4) < 0.3, fishing = pose === "fish";
  const plume = egret ? ramp("r3", "r4", "r5", "snow") : ramp("r1", "r2", "r3", "r4", "r5"), neckR = egret ? plume : ramp("r3", "r4", "r5", "snow");
  const legC = egret ? P.r0 : P.d2, bill = P.a2, edge = egret ? P.r3 : P.r0;
  let S;
  if (h <= 6) {
    const key = { W: neckR[2], G: plume[2], g: plume[3], D: egret ? plume[1] : P.r1, Y: bill, L: legC, K: egret ? neckR[2] : P.ink };
    S = rows(TINY_HERON[(fishing ? "fish" : "stand") + h], key, dir, { outline: edge, late: "LYW" });
  } else {
    const W = Math.ceil(h * 1.1) + 4;
    S = new Spr(W, h + 4, W >> 1, h + 1);
    const gy = S.ay + 0.95, X = (u) => S.ax + 0.5 + dir * u * h, Y = (v) => gy - v * h, pt = (u, v) => [X(u), Y(v)];
    const feathers = tone(plume, egret ? 1.9 : 1.6, 1.4), neckP = tone(neckR, 1.7, 1.2), thin = Math.max(0.5, 0.045 * h);
    // a teardrop body, tail low behind; fishing tips it forward
    const tail = fishing ? pt(-0.26, 0.62) : pt(-0.26, 0.5), chest = fishing ? pt(0.1, 0.54) : pt(0.08, 0.62);
    seg(S, tail[0], tail[1], chest[0], chest[1], Math.max(0.6, 0.07 * h), Math.max(1, 0.12 * h), feathers);
    if (!egret) seg(S, tail[0] + dir * 0.02 * h, tail[1] + 0.02 * h, tail[0] + dir * 0.16 * h, tail[1] - 0.01 * h, 0.5, 0.5, solid(P.r1));
    const neck = fishing ? [pt(0.1, 0.56), pt(0.26, 0.5), pt(0.38, 0.36)] : [pt(0.08, 0.66), pt(0.15, 0.76), pt(0.09, 0.86), pt(0.13, 0.95)];
    rod(S, neck, Math.max(0.6, 0.06 * h), thin, neckP);
    const [hx, hy] = neck[neck.length - 1];
    blob(S, hx, hy, Math.max(0.8, 0.06 * h), Math.max(0.6, 0.045 * h), neckP);
    if (!egret) seg(S, hx, hy - 0.03 * h, hx - dir * 0.14 * h, hy - (fishing ? 0.04 : 0.01) * h, 0.4, 0.4, solid(P.ink));
    if (!egret && h >= 10) seg(S, neck[1][0] + dir * 0.03 * h, neck[1][1], neck[2][0] + dir * 0.03 * h, neck[2][1], 0.4, 0.4, solid(P.r2));
    if (h >= 12) S.set(Math.floor(hx + dir * 0.02 * h), Math.floor(hy - 0.01 * h), P.ink);
    S.outline(edge, true);
    // legs and the dagger bill after the outline, so they stay one pixel thin
    const legs = solid(legC), T = new Spr(S.w, S.h, S.ax, S.ay);
    rod(T, [pt(-0.04, 0.52), pt(-0.06, 0.26), pt(-0.08, 0)], 0.4, 0.4, legs);
    under(S, T);
    rod(S, [pt(0.04, 0.52), pt(fishing ? 0.12 : 0.06, 0.26), pt(0.07, 0)], 0.4, 0.4, legs);
    if (fishing) seg(S, hx + dir * 0.03 * h, hy + 0.03 * h, hx + dir * 0.08 * h, hy + 0.2 * h, 0.4, 0.4, solid(bill));
    else seg(S, hx + dir * 0.05 * h, hy, hx + dir * 0.21 * h, hy + 0.02 * h, 0.4, 0.4, solid(bill));
  }
  if (fishing) {
    // ripples round the legs: the bird is wading
    const rx = Math.max(2, h * 0.22);
    for (let x = -Math.ceil(rx) - 1; x <= Math.ceil(rx) + 1; x++) {
      const t = x / (rx + 0.5);
      if (Math.abs(t) > 1) continue;
      const y = Math.round(Math.sqrt(1 - t * t) * rx * 0.45);
      if (S.get(S.ax + x, S.ay + y) === 255 && ((x + seed) & 3) !== 3) S.set(S.ax + x, S.ay + y, P.w6);
      if (S.get(S.ax + x, S.ay - y) === 255 && Math.abs(x) > rx * 0.5) S.set(S.ax + x, S.ay - y, P.w5);
    }
  }
  return S;
}

// ---------------------------------------------------------------------------------------------------------------- bird

// Wing [elbow, tip] per frame, in half-spans (y down): up, downstroke, down, upstroke.
const WINGS = {
  gull: [[0.45, -0.45, 0.95, -0.75], [0.45, -0.12, 1, -0.05], [0.45, 0.12, 0.9, 0.42], [0.45, -0.3, 1, 0.05]],
  crow: [[0.45, -0.35, 0.95, -0.6], [0.45, -0.08, 1, -0.02], [0.45, 0.12, 0.92, 0.36], [0.45, -0.18, 1, -0.12]],
  eagle: [[0.45, -0.22, 1, -0.38], [0.45, -0.05, 1, -0.1], [0.45, 0.05, 0.95, 0.2], [0.45, -0.12, 1, -0.22]],
};
const TINY_BIRD = [["a.a", ".b."], ["aba"], [".b.", "a.a"], ["aba"]];
// Anchored at the body's center, so a flock can bob without the wings jittering. span: wingspan in pixels.
export function bird(span, frame = 0, kind = "gull", seed = 0) {
  frame &= 3;
  const sp = Math.max(3, Math.round(span)), W = WINGS[kind] ? kind : "gull";
  const bald = rv(seed, 1) < 0.6;
  const c = W === "gull" ? { wing: ramp("r3", "r4", "r5", "snow"), tip: P.ink, body: P.snow, head: P.snow }
    : W === "crow" ? { wing: ramp("ink", "r0", "r1"), tip: P.ink, body: P.r0, head: P.ink }
      : { wing: ramp("d0", "d1", "d2", "d3"), tip: P.d0, body: P.d1, head: bald ? P.snow : P.d3 };
  if (sp <= 4) {
    const S = rows(TINY_BIRD[frame], { a: c.wing[W === "crow" ? 1 : 2], b: c.body }, 1);
    S.ax = 1; S.ay = TINY_BIRD[frame].length > 1 ? (frame === 0 ? 1 : 0) : 0;
    return S;
  }
  const half = sp / 2, S = new Spr(sp + 3, Math.ceil(sp * 1.3) + 3, (sp + 3) >> 1, Math.ceil(sp * 0.7) + 1);
  const cx = S.ax + 0.5, cy = S.ay + 0.5, [eu, ev, tu, tv] = WINGS[W][frame];
  const chord = sp * (W === "eagle" ? 0.085 : W === "crow" ? 0.08 : 0.07), under = frame === 0 ? -0.6 : 0;
  const wingP = (x, y, l, nx, ny) => dith(c.wing, 1 + under + (ny < 0 ? 1 : 0) + l * 0.8, x, y);
  for (const s of [-1, 1]) {
    const ex = cx + s * eu * half, ey = cy + ev * half, tx = cx + s * tu * half, ty = cy + tv * half;
    seg(S, cx, cy, ex, ey, chord, chord * 0.9, wingP);
    seg(S, ex, ey, tx, ty, chord * 0.9, W === "eagle" ? chord * 0.7 : chord * 0.3, wingP);
    // dark primaries on the outer part of each wing; an eagle's spread into fingers
    const fx = ex + (tx - ex) * 0.6, fy = ey + (ty - ey) * 0.6;
    seg(S, fx, fy, tx, ty, Math.min(0.7, chord * 0.5), 0.3, solid(c.tip));
    if (W === "eagle" && sp >= 10) { S.set(Math.floor(tx + s), Math.floor(ty) + 1, c.tip); S.set(Math.floor(tx), Math.floor(ty) + 1, c.tip); }
  }
  const neck = Math.max(1, Math.round(sp * (W === "eagle" ? 0.12 : 0.09)));
  blob(S, cx, cy, Math.max(0.6, sp * 0.06), Math.max(0.8, sp * 0.09), tone([c.body, c.body, c.head], 0.8, 1));
  for (let k = 1; k <= neck; k++) S.set(Math.floor(cx), Math.floor(cy) - k, c.head);
  if (W === "eagle") for (const dx of sp >= 10 ? [-1, 0, 1] : [0]) S.set(Math.floor(cx) + dx, Math.floor(cy) + neck + (dx ? 0 : 1), bald ? P.snow : P.d2);
  if (W === "gull" && sp >= 8) S.outline(P.r3, true);
  return S;
}

// ---------------------------------------------------------------------------------------------------------------- fish

const SCALES = [ramp("w1", "w3", "r3", "r5", "snow"), ramp("m0", "m2", "a1", "k0", "s3"), ramp("r0", "r2", "k1", "k0", "s3")];
// A fish leaping from the water, anchored at the surface where it broke through. len: body length in pixels.
export function fish(frame = 0, seed = 0, len = 5) {
  frame &= 3;
  const L = Math.max(3, Math.round(len)), dir = rv(seed, 2) < 0.5 ? 1 : -1, sc = pick(SCALES, rv(seed, 1));
  const W = L * 2 + 9, S = new Spr(W, L + 9, W >> 1, L + 5), cx = S.ax + 0.5, sy = S.ay + 0.5;
  // splash ring, back half first so the fish sits in front of it
  const rx = (0.3 + frame * 0.28) * L, ry = rx * 0.5, fade = frame === 3;
  for (let y = Math.floor(sy - ry - 1); y <= Math.ceil(sy + ry + 1); y++)
    for (let x = Math.floor(cx - rx - 1); x <= Math.ceil(cx + rx + 1); x++) {
      const e = Math.hypot((x + 0.5 - cx) / rx, (y + 0.5 - sy) / ry);
      if (Math.abs(e - 1) > 0.9 / rx + 0.08) continue;
      if (fade && h2(x, y, seed + frame) < 0.45) continue;
      S.set(x, y, y + 0.5 >= sy ? (fade ? P.w6 : P.w7) : P.w6);
    }
  const U = (u) => cx + dir * u * L, V = (v) => sy - v * L;
  const arcs = [
    [[-0.05, -0.1], [0.05, 0.35], [0.1, 0.7]],
    [[-0.35, 0.8], [0.05, 1.1], [0.45, 0.85]],
    [[0.35, 1.0], [0.55, 0.6], [0.65, 0.12]],
    null,
  ][frame];
  if (arcs) {
    // a dark back and pale belly, edged in deep water so it reads against the splash
    const T = new Spr(S.w, S.h, S.ax, S.ay), pts = arcs.map(([u, v]) => [U(u), V(v)]), head = pts[2];
    const bodyP = (x, y, l, nx, ny) => (y + 0.5 > sy ? -1 : dith(sc, 2.2 + l * 1.4 + (ny < -0.35 ? -1.2 : ny > 0.35 ? 0.8 : 0), x, y));
    rod(T, pts, 0.35 * L * 0.5, 0.18 * L * 0.9, bodyP);
    blob(T, head[0], head[1], 0.17 * L, 0.17 * L, bodyP);
    const tail = pts[0], dx = pts[1][0] - tail[0], dy = pts[1][1] - tail[1], dl = Math.hypot(dx, dy) || 1;
    if (tail[1] < sy) {
      T.set(Math.floor(tail[0] - (dx / dl) * 1.2 - dy / dl), Math.floor(tail[1] - (dy / dl) * 1.2 + dx / dl), sc[1]);
      T.set(Math.floor(tail[0] - (dx / dl) * 1.2 + dy / dl), Math.floor(tail[1] - (dy / dl) * 1.2 - dx / dl), sc[1]);
    }
    if (L >= 6) T.set(Math.floor(head[0]), Math.floor(head[1]), P.ink);
    T.outline(P.w1, true);
    for (let i = 0; i < S.p.length; i++) if (T.p[i] !== 255 && (i / S.w | 0) < S.ay + (T.p[i] === P.w1 ? 0 : 1)) S.p[i] = T.p[i];
  }
  // droplets thrown up at the break and at the re-entry
  const drops = [[[-0.3, 0.3], [0.3, 0.45], [0.05, 0.6]], [[-0.45, 0.35], [0.5, 0.25], [-0.2, 0.55]], [[0.4, 0.4], [0.8, 0.3], [-0.5, 0.15]], [[0.6, 0.2], [0.75, 0.35], [0.5, 0.1]]][frame];
  for (const [u, v] of drops) S.set(Math.floor(U(u)), Math.floor(V(v)), frame === 3 ? P.w6 : P.w7);
  if (frame === 3) S.set(Math.floor(U(0.65)), Math.floor(sy), P.snow);
  return S;
}

// --------------------------------------------------------------------------------------------------------------- canoe

const LU = -0.958, LV = 0.287, SUN = 0.9, L3 = [LU * Math.cos(SUN), LV * Math.cos(SUN), Math.sin(SUN)];
const WOODS = [ramp("d0", "d1", "d2", "d3", "d4"), ramp("d0", "d1", "k2", "d3", "k1"), ramp("d1", "d2", "d3", "d4", "d5")];
// A dugout drawn up on the sand, its paddle laid inside. dir 0..3 points the bow along +u, +v, -u, -v
// (screen down-right, down-left, up-left, up-right). len: hull length in ground pixels.
export function canoe(len, dir = 0, seed = 0) {
  const Lh = Math.max(3, len / 2), Wd = Math.max(1.3, len * 0.15), Hg = Math.max(1, len * 0.08);
  const ax = [[1, 0], [0, 1], [-1, 0], [0, -1]][dir & 3], pv = [-ax[1], ax[0]], nearSide = Math.sign(pv[0] + pv[1]);
  const wood = pick(WOODS, rv(seed, 1)), hollow = ramp("d0", "d1", "d2");
  const Wsp = Math.ceil(len * 1.3) + 8, Hsp = Math.ceil(len * 0.8) + 8, S = new Spr(Wsp, Hsp, Wsp >> 1, Hsp >> 1);
  const Z = new Float32Array(Wsp * Hsp).fill(-1e9), cx = S.ax + 0.5, cy = S.ay + 0.5;
  const G = (t, b) => [ax[0] * t * Lh + pv[0] * b, ax[1] * t * Lh + pv[1] * b];
  // ground (u, v) and height z to screen; nearer the eye is further down the screen and higher up
  const put = (t, b, z, r, val, force = false) => {
    const [u, v] = G(t, b), x = Math.floor(cx + u - v), y = Math.floor(cy + (u + v) * 0.5 - z), n = (u + v) * 0.5 + z * 0.7;
    if (x < 0 || y < 0 || x >= Wsp || y >= Hsp || (!force && n < Z[y * Wsp + x])) return;
    Z[y * Wsp + x] = Math.max(Z[y * Wsp + x], n);
    S.set(x, y, typeof r === "number" ? r : dith(r, val, x, y));
  };
  const shade = (nu, nv, nz) => nu * L3[0] + nv * L3[1] + nz * L3[2];
  const width = (t) => Wd * (t > 0 ? Math.pow(Math.max(0, 1 - t ** 1.4), 0.6) : Math.pow(Math.max(0, 1 - (-t) ** 2.6), 0.5)); // pointed bow, fuller stern
  const rim = (t) => Hg * (1 + Math.max(0, Math.abs(t) - 0.7) / 0.3 * (t > 0 ? 1.1 : 0.5)); // the bow sweeps up more than the stern
  const stepT = 0.3 / Lh, stepP = 0.25 / (Wd + Hg), shadow = [];
  for (let t = -1; t <= 1; t += stepT) {
    const w = width(t), hr = rim(t);
    for (let ph = 0; ph <= Math.PI; ph += stepP) {
      const cp = Math.cos(ph), sp = Math.sin(ph), z = hr * (1 - sp), [u, v] = G(t, w * cp);
      put(t, w * cp, z, wood, 2.1 + shade(pv[0] * cp, pv[1] * cp, 0.3 - sp * 0.5) * 2.2);
      shadow.push([cx + u - v + z * 0.81, cy + (u + v) * 0.5 + z * 0.22]);
    }
  }
  // the hollowed top: dark inside with the far inner wall lit, pale gunwales round it
  for (let t = -0.86; t <= 0.86; t += stepT) {
    const w = width(t), hr = rim(t), iw = w * 0.62;
    for (let b = -iw; b <= iw; b += 0.2) put(t, b, hr, hollow, 1 - ((b * nearSide) / iw) * 0.9, true);
    for (const s of [-1, 1]) put(t, w * s * 0.97, hr, s * nearSide < 0 ? wood[4] : wood[3], 0, true);
  }
  put(1, 0, rim(1), wood[4], 0, true);
  if (len >= 10) {
    // paddle along the inside, blade toward the stern
    const off = (rv(seed, 2) - 0.5) * Wd * 0.5;
    for (let t = -0.5; t <= 0.45; t += stepT * 0.5) put(t, off, rim(t) + 0.2, t > 0.38 ? P.d3 : P.d5, 0, true);
    for (let t = -0.74; t <= -0.5; t += stepT * 0.5) for (let b = -0.45; b <= 0.45; b += 0.2) put(t, off + b * width(t), rim(t) + 0.3, b * nearSide < 0 ? P.d5 : P.d4, 0, true);
  }
  S.outline(P.d0, true);
  // contact shadow on the sand where nothing else is drawn
  const sh = SHADOW[P.s2];
  for (const [x, y] of shadow) if (S.get(Math.floor(x), Math.floor(y)) === 255) S.set(x - 0.5, y - 0.5, sh);
  return S;
}

// ------------------------------------------------------------------------------------------------------------ seastack

// A sea stack: a strata-banded rock pillar with a grassy cap, guano streaks under its ledges and surf at its foot.
// Anchored at the water line under its center. Some seeds wear a sea arch through the base.
export function seastack(hpx, seed = 0) {
  const h = Math.max(8, Math.round(hpx)), sand = rv(seed, 1) < 0.3, rr = sand ? ramp("d0", "d1", "d2", "d3", "d4", "d5", "s2") : R.rock;
  const bw = Math.max(4, h * (0.34 + 0.14 * rv(seed, 2))), W = Math.ceil(bw * 2.1) + 10, S = new Spr(W, h + 7, W >> 1, h + 2);
  const cx = S.ax + 0.5, base = S.ay + 1, top = base - h, lean = (rv(seed, 3) - 0.5) * bw * 0.45, band = Math.max(2, Math.round(h / 10));
  const y0 = Math.floor(top), n = S.ay + 1 - y0, cap = Math.max(2, Math.round(h * 0.11));
  // each row's span: a tapering column whose sides step out in rockfall ledges and bulge where softer beds erode
  const span = [];
  for (let k = 0; k < n; k++) {
    const y = y0 + k, t = (y + 0.5 - top) / h, mid = cx + lean * (1 - t) * (1 - t);
    const side = (s) => {
      const smooth = vnoise(t * 4 + s * 7, seed + s) - 0.5, step = vnoise(Math.floor((y + s) / band) * 0.9, seed * 3 + s) - 0.5;
      return (bw / 2) * (0.74 + 0.26 * t + smooth * 0.3 + step * 0.26 + Math.max(0, t - 0.86) * 1.6 + (t < 0.1 ? 0.06 : 0));
    };
    span.push([Math.round(mid - side(-1)), Math.round(mid + side(1))]);
  }
  const inRow = (x, y) => { const k = y - y0; return k >= 0 && k < n && x >= span[k][0] && x < span[k][1]; };
  const arch = rv(seed, 5) < 0.35 && bw >= 9, ax0 = cx + lean * 0.05 + (rv(seed, 6) - 0.5) * bw * 0.2, arx = bw * 0.15, ary = h * 0.14;
  const holed = (x, y) => arch && ((x + 0.5 - ax0) / arx) ** 2 + ((base - y - 0.5) / ary) ** 2 < 1;
  const joints = [0, 1, 2].map((k) => h2(k, seed, 7));
  const wet = Math.max(1.5, h * 0.06);
  for (let k = 0; k < n; k++) {
    const y = y0 + k, [xl, xr] = span[k], depth = base - y - 0.5;
    for (let x = xl; x < xr; x++) {
      if (holed(x, y)) continue;
      const f = (x + 0.5 - xl) / Math.max(1, xr - xl), fn = Math.round((f * 2 - 1) * 2) / 2; // chipped into flat faces
      const sb = (y + x * 0.18 + vnoise(x * 0.25, seed) * 1.5) / band, b = Math.floor(sb);
      let v = 3.2 - fn * 1.5 + (h2(b, seed, 5) - 0.5) * 0.8 + (h2(x >> 1, y, seed) - 0.5) * 0.4;
      if (sb - b < 1 / band && h2(b, seed, 8) < 0.55) v -= 0.8; // bedding planes
      if (!inRow(x, y - 1)) v += 1.1; // ledge tops catch the light
      else if (!inRow(x, y + 1)) v -= 0.9;
      for (const j of joints) if (Math.abs(x - (xl + 1 + j * (xr - xl - 2))) < 0.5 && h2(b, j * 99, seed) < 0.6) v -= 0.9; // vertical joints
      let c;
      if (depth < wet) c = h2(x, y, seed + 1) < 0.3 ? P.m1 : dith(rr, v - 1.6, x, y);
      else c = dith(rr, v, x, y);
      S.set(x, y, c);
    }
  }
  // guano streaks run down from a few ledge tops
  const tops = [];
  for (let k = cap + 2; k < n - wet - 2; k++) for (let x = span[k][0]; x < span[k][1]; x++) if (!inRow(x, y0 + k - 1) && S.get(x, y0 + k) !== 255) tops.push([x, y0 + k]);
  const nst = Math.min(tops.length, 2 + Math.floor(rv(seed, 9) * 3) + Math.floor(h / 20));
  for (let s = 0; s < nst; s++) {
    const [x, y] = tops[Math.floor(h2(s, seed, 10) * tops.length)], len = 2 + Math.floor(h2(s, seed, 11) * Math.max(2, h * 0.12));
    for (let j = 0; j < len; j++) if (S.get(x, y + j) !== 255 && (j < 2 || h2(j, s, seed) > 0.25)) S.set(x, y + j, j === 0 ? P.snow : j < len * 0.6 ? P.r5 : P.r4);
  }
  // grassy cap overhanging the top edge, ragged on top, a few strands hanging down the face
  const [cl, cr] = span[Math.min(n - 1, cap)], capR = ramp("t1", "g1", "g2", "g3", "g4", "g5");
  for (let x = cl - 2; x <= cr + 1; x++) {
    const f = (x + 0.5 - (cl - 2)) / (cr - cl + 3), dome = Math.sqrt(Math.max(0, 1 - (f * 2 - 1) ** 2));
    const ya = Math.round(top + cap * (1 - dome) * 0.9 - (h2(x, seed, 14) < 0.3 ? 1 : 0)), yb = Math.round(top + cap + (h2(x, seed, 15) < 0.3 ? 1 + Math.floor(h2(x, seed, 16) * 2.5) : 0));
    for (let y = ya; y <= yb; y++) {
      if (y > top + cap && !inRow(x, y)) continue;
      S.set(x, y, dith(capR, 3.5 - (f * 2 - 1) * 1.5 - ((y - ya) / Math.max(1, yb - ya)) * 1.6 + (h2(x, y, seed + 2) - 0.5) * 0.6, x, y));
    }
  }
  if (h >= 24)
    for (let k = 0; k < 3; k++) {
      const x = Math.floor(cl + 1 + h2(k, seed, 17) * (cr - cl - 2));
      let y = 0;
      while (y < S.h && S.get(x, y) === 255 && S.get(x + 1, y) === 255) y++;
      if (h2(k, seed, 18) < 0.7 && y > 0) { S.set(x, y - 1, P.snow); S.set(x + 1, y - 1, P.r3); }
    }
  // fallen blocks at the foot, washed by the surf
  const [fl, fr] = span[n - 1];
  for (let k = 0; k < 1 + Math.floor(h / 16); k++) {
    const s = h2(k, seed, 30) < 0.5 ? -1 : 1, r = Math.max(1, bw * (0.1 + 0.08 * h2(k, seed, 31)));
    const x = s < 0 ? fl - r * 0.4 - h2(k, seed, 32) * 2 : fr + r * 0.4 + h2(k, seed, 32) * 2;
    blob(S, x, S.ay + 0.4 - r * 0.3, r * 1.2, r * 0.8, (px, py, l) => (py > S.ay ? -1 : dith(rr, 2.6 + l * 2.4 - (py === S.ay ? 1.2 : 0), px, py)));
  }
  S.outline(P.r0, true);
  // surf hugging the foot: dense against the rock, flecks further out, a wave line in front
  const [bl, br] = span[n - 1], foamR = bw * 0.55 + 3;
  for (let x = bl - 5; x <= br + 4; x++) {
    const d = Math.max(0, bl - x, x - br + 1);
    for (let dy = -1; dy <= 1; dy++) {
      const y = S.ay + dy, p = (dy === 0 ? 0.95 : 0.55) - d * 0.22;
      if (h2(x, y, seed + 20) < p && (dy >= 0 || S.get(x, y) === 255)) S.set(x, y, h2(x, y, seed + 21) < 0.55 ? P.snow : P.w7);
    }
    if (d === 0 && h2(x, seed, 22) < 0.4 && S.get(x, S.ay - 1) !== 255) S.set(x, S.ay - 1, P.w7);
  }
  for (let k = 0; k < Math.round(foamR * 1.5); k++) {
    const a = h2(k, seed, 23) * 6.283, r = foamR * (0.8 + 0.4 * h2(k, seed, 24));
    const x = Math.round(cx + Math.cos(a) * r), y = Math.round(S.ay + Math.sin(a) * r * 0.45);
    if (S.get(x, y) === 255 && (Math.sin(a) > 0 || !inRow(x, y))) S.set(x, y, h2(k, seed, 25) < 0.5 ? P.w6 : P.w7);
  }
  for (let x = Math.round(cx - foamR * 0.6); x <= Math.round(cx + foamR * 0.6); x++) if (h2(x, seed, 26) < 0.7) S.set(x, S.ay + 2 + (Math.abs(x - cx) > foamR * 0.35 ? 0 : 1) - 1, P.w6);
  return S;
}

// --------------------------------------------------------------------------------------------------------------- giant

// A landmark tree, two to three times any other: a spreading, gnarled old oak, or a towering redwood with a dead
// lightning-struck spire. hpx: full height.
export function giant(hpx, kind = "oak", seed = 0) {
  return kind === "pine" ? giantPine(Math.max(24, Math.round(hpx)), seed) : giantOak(Math.max(24, Math.round(hpx)), seed);
}

function clumps(x, y, c, seed) {
  const gx = x / c, gy = y / c, ix = Math.floor(gx), iy = Math.floor(gy);
  let bd = 9, ox = 0, oy = 0;
  for (let j = -1; j <= 1; j++)
    for (let i = -1; i <= 1; i++) {
      const px = ix + i + 0.2 + 0.6 * h2(ix + i, iy + j, seed + 1), py = iy + j + 0.2 + 0.6 * h2(ix + i, iy + j, seed + 2);
      const d = (gx - px) ** 2 + (gy - py) ** 2;
      if (d < bd) { bd = d; ox = gx - px; oy = gy - py; }
    }
  return -(ox * 0.7 + oy * 0.8) * 0.9 - bd * 0.6 + 0.15;
}

// Leaf masses as overlapping spheres, the nearest (lowest) in front, each with its own lit side and clump texture.
function canopy(S, blobs, r, c, seed, lift = 0) {
  let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
  for (const [bx, by, br] of blobs) { x0 = Math.min(x0, bx - br); x1 = Math.max(x1, bx + br); y0 = Math.min(y0, by - br); y1 = Math.max(y1, by + br); }
  for (let y = Math.floor(y0); y <= Math.ceil(y1); y++)
    for (let x = Math.floor(x0); x <= Math.ceil(x1); x++) {
      let best = -1, nx = 0, ny = 0, nz = 0, rim = 0;
      for (const [bx, by, br, sq = 1] of blobs) {
        const dx = (x + 0.5 - bx) / br, dy = (y + 0.5 - by) / (br * sq), d2 = dx * dx + dy * dy;
        if (d2 >= 1) continue;
        const z = Math.sqrt(1 - d2), score = z * br + by * 0.3;
        if (score > best) { best = score; nx = dx; ny = dy; nz = z; rim = d2; }
      }
      if (best < 0) continue;
      let l = lit(nx, ny, nz) + (h2(x, y, seed) - 0.5) * 0.25 + clumps(x, y, c, seed);
      let v = 1.1 + (l * 0.55 + 0.45) * (r.length - 1.4) + lift;
      if (rim > 0.72 && nx + ny > 0.45) v -= 1.2;
      S.set(x, y, dith(r, v, x, y));
    }
}

function barkP(r, seed, moss) {
  return (x, y, l, nx) => {
    let v = 1.6 + l * 1.8 + (h2(x, y >> 1, seed) - 0.5) * 0.7;
    if (((x + (h2(x >> 1, y >> 2, seed) < 0.3 ? 1 : 0)) % 3) === 0) v -= 0.7; // furrows
    if (moss && nx < -0.35 && h2(x, y, seed + 3) < 0.35) return h2(x, y, seed + 4) < 0.5 ? P.g2 : P.g3;
    return dith(r, v, x, y);
  };
}

function giantOak(h, seed) {
  const W = Math.round(h * 1.6) + 8, S = new Spr(W, h + 4, W >> 1, h + 1), cx = S.ax + 0.5, gy = S.ay + 0.95;
  const bark = ramp("d0", "d1", "d2", "d3", "d4"), bp = barkP(bark, seed, true), leaf = R.oak;
  const crownY = gy - h * 0.66, rx = h * 0.62, ry = h * 0.3, fork = [cx + (rv(seed, 1) - 0.5) * h * 0.06, gy - h * 0.34];
  const blobs = [], n = clamp(Math.round(h / 6), 6, 14);
  for (let k = 0; k < n; k++) {
    const a = Math.PI * (-0.06 + (1.12 * (k + 0.2 + 0.6 * h2(k, seed, 2))) / n), d = 0.72 + 0.28 * h2(k, seed, 3);
    const br = h * (0.13 + 0.07 * h2(k, seed, 4)) * (0.8 + 0.4 * Math.sin(a));
    blobs.push([cx - Math.cos(a) * rx * d, crownY - Math.sin(a) * ry * d + ry * 0.35, br, 0.8]);
  }
  for (let k = 0; k < 3; k++) blobs.push([cx + (h2(k, seed, 5) - 0.5) * rx * 0.9, crownY - ry * 0.2 + h2(k, seed, 6) * ry * 0.3, h * (0.16 + 0.04 * h2(k, seed, 7)), 0.8]);
  // trunk: short, massive, leaning a little, flaring into roots
  const tr = Math.max(1.5, h * 0.075);
  seg(S, cx, gy - 0.5, fork[0], fork[1], tr, tr * 0.72, bp);
  blob(S, cx, gy - tr * 0.6, tr * 1.5, tr * 0.9, bp);
  // limbs twist out from the fork to the outer leaf masses
  const limbs = blobs.slice(0, n).filter((_, k) => k % 2 === 0 || k === n - 1);
  limbs.forEach(([bx, by], k) => {
    const mx = (fork[0] + bx) / 2 + (h2(k, seed, 8) - 0.5) * h * 0.12, my = (fork[1] + by) / 2 + h * 0.04 + (h2(k, seed, 9) - 0.3) * h * 0.08;
    rod(S, [fork, [mx, my], [bx, by + h * 0.04]], tr * 0.6, Math.max(0.5, tr * 0.18), bp);
  });
  canopy(S, blobs, leaf, Math.max(2.4, h / 17), seed, -0.15);
  // roots spread along the ground in 2:1
  for (const [dx, dy, rl] of [[-1, 0.3, 0.2], [1, 0.45, 0.17], [0.25, 1, 0.1], [-0.5, 0.9, 0.11]]) {
    const L = h * rl;
    rod(S, [[cx + dx * tr * 0.6, gy - tr * 0.5], [cx + dx * L * 0.55, gy - 0.4 + dy * L * 0.1], [cx + dx * L, gy + dy * L * 0.12]], tr * 0.55, 0.5, bp);
  }
  if (h >= 30) blob(S, cx + tr * 0.25, gy - h * 0.2, Math.max(0.8, tr * 0.28), Math.max(1, tr * 0.42), (x, y, l, nx, ny) => (ny < -0.5 ? P.d1 : P.ink));
  S.outline(P.ink, true);
  return S;
}

function giantPine(h, seed) {
  const W = Math.round(h * 0.62) + 8, S = new Spr(W, h + 4, W >> 1, h + 1), cx = S.ax + 0.5, gy = S.ay + 0.95;
  const bark = ramp("d0", "d1", "k2", "d3", "k1"), bp = barkP(bark, seed, false), leaf = R.pine;
  const snag = rv(seed, 1) < 0.7, top = gy - h, crownTop = top + h * (snag ? 0.1 : 0.02), crownBot = gy - h * 0.4;
  const rb = Math.max(1.5, h * 0.05), lean = (rv(seed, 2) - 0.5) * h * 0.04;
  const X = (y) => cx + lean * ((gy - y) / h);
  // trunk, fluted and flaring at the foot
  seg(S, X(gy), gy - 0.5, X(top + h * 0.1), top + h * 0.1, rb, Math.max(0.5, rb * 0.25), bp);
  blob(S, cx, gy - rb * 0.7, rb * 1.8, rb * 1.1, bp);
  for (const s of [-1, 1]) seg(S, cx + s * rb * 0.5, gy - rb * 1.5, cx + s * rb * 2.2, gy + 0.2, rb * 0.5, rb * 0.25, bp);
  // bare lower branch stubs
  const dead = tone(ramp("r1", "r2", "r3", "r4"), 1.4, 1.2);
  for (let k = 0; k < 3; k++) {
    const y = crownBot + (gy - crownBot) * (0.2 + 0.25 * k) * 0.8, s = k & 1 ? 1 : -1;
    if (h2(k, seed, 3) < 0.7) seg(S, X(y), y, X(y) + s * h * (0.05 + 0.04 * h2(k, seed, 4)), y - h * 0.02, 0.5, 0.4, dead);
  }
  // sparse tiers of drooping branch pads, gaps between them showing the trunk: columnar, not round
  const blobs = [], tiers = clamp(Math.round(h / 7), 5, 13), gap = (crownBot - crownTop) / tiers;
  for (let k = 0; k < tiers; k++) {
    const t = (k + 0.5) / tiers, y = crownTop + gap * (k + 0.5) + (h2(k, seed, 9) - 0.5) * gap * 0.5, half = h * (0.06 + 0.16 * Math.sqrt(t)) + 1;
    for (const s of [-1, 1]) {
      if (k > 1 && h2(k, s, seed + 5) < 0.15) continue;
      const reach = half * (0.65 + 0.55 * h2(k, s, seed + 6)), rx = Math.max(2, reach * 0.5), ry = Math.max(1.6, gap * 0.62);
      seg(S, X(y), y, X(y) + s * reach * 0.8, y + ry * 0.3, Math.max(0.5, rb * 0.22), 0.5, bp);
      blobs.push([X(y) + s * (reach - rx * 0.85), y + ry * 0.2, rx, ry / rx]);
      // the branch tip droops under its own weight
      if (reach > 4 && h2(k, s, seed + 7) < 0.7) blobs.push([X(y) + s * (reach - rx * 0.1), y + ry * 0.75, Math.max(1.4, rx * 0.42), 0.85]);
    }
    if (k < 3) blobs.push([X(y), y - gap * 0.3, Math.max(1.5, half * 0.5), 0.9]);
  }
  canopy(S, blobs, leaf, Math.max(2.2, h / 22), seed, 0.1);
  if (snag) {
    const spire = [[X(crownTop + 2), crownTop + 2], [X(top) + (rv(seed, 9) - 0.5) * 2, top + 0.5]];
    rod(S, spire, Math.max(0.6, rb * 0.3), 0.4, dead);
    const my = crownTop - (crownTop - top) * 0.5;
    seg(S, X(my), my, X(my) + h * 0.04, my - h * 0.03, 0.4, 0.4, dead);
    seg(S, X(my + 2), my + 2, X(my) - h * 0.03, my - h * 0.01, 0.4, 0.4, dead);
  }
  S.outline(P.ink, true);
  return S;
}

// --------------------------------------------------------------------------------------------------------------- cairn

const TINY_CAIRN = {
  4: [".a.", "abc", "ccc", "abc"],
  5: ["..a..", ".abc.", ".ccc.", "abbbc", "ccccc"],
};
// A summit cairn of stacked stones, the upper ones smaller; some carry a marker stick with a red rag.
export function cairn(hpx, seed = 0) {
  const h = Math.max(4, Math.round(hpx));
  if (h <= 5) return rows(TINY_CAIRN[h], { a: P.r5, b: P.r3, c: P.r1 }, 1, { outline: P.ink });
  const W = Math.ceil(h * 1.1) + 6, flag = rv(seed, 1) < 0.45 && h >= 6, fh = flag ? Math.ceil(h * 0.6) : 0;
  const S = new Spr(W, h + fh + 4, W >> 1, h + fh + 1), cx = S.ax + 0.5, gy = S.ay + 0.95;
  const courses = clamp(Math.round(h / 3), 2, 7), rowH = h / (courses + 0.5);
  const stone = (x, yc, rx, ry, k) => {
    // each stone gets its own dark edge, so the joints between stones read
    const T = new Spr(S.w, S.h, S.ax, S.ay);
    blob(T, x, yc, rx, ry, (px, py, l, nx, ny) => {
      const a = Math.round(Math.atan2(ny, nx) / 1.0472) * 1.0472, m = Math.hypot(nx, ny);
      const v = 3 + (Math.cos(a) * m * LX + Math.sin(a) * m * LY + Math.sqrt(Math.max(0, 1 - m * m)) * LZ) * 2.6 + (h2(k, 3, seed) - 0.5) * 0.9;
      if (ny < -0.45 && h2(px, py, seed + 7) < 0.14) return h2(px, py, seed + 8) < 0.5 ? P.a2 : P.a1; // lichen
      return dith(R.rock, v, px, py);
    });
    T.outline(P.r0, true);
    for (let i = 0; i < S.p.length; i++) if (T.p[i] !== 255) S.p[i] = T.p[i];
  };
  let y = gy, k = 0;
  for (let r = 0; r < courses; r++) {
    const width = h * 0.95 * (1 - (r / courses) * 0.62), cnt = Math.max(1, Math.round(width / (rowH * 1.7))), sw = width / cnt;
    const ry = rowH * 0.62;
    for (let i = 0; i < cnt; i++, k++) {
      const x = cx - width / 2 + sw * (i + 0.5) + (h2(r, i, seed) - 0.5) * sw * 0.25;
      stone(x, y - ry + (h2(i, r, seed + 2) - 0.5) * 0.6, sw * (0.5 + 0.1 * h2(i, r, seed + 1)), ry, k);
    }
    y -= rowH * 0.95;
  }
  const capH = rowH * 1.3;
  stone(cx + (rv(seed, 3) - 0.5), y - capH * 0.35, Math.max(0.9, rowH * 0.5), capH * 0.62, k);
  if (flag) {
    const sx = Math.floor(cx + 0.5), y0 = Math.floor(y - capH * 0.7);
    for (let j = 0; j < fh; j++) S.set(sx, y0 - j, j === fh - 1 ? P.d4 : P.d2);
    const rag = Math.max(2, Math.round(h * 0.2));
    for (let j = 1; j <= rag; j++) { S.set(sx + j, y0 - fh + 1 + (j === rag ? 1 : 0), P.red); if (h >= 12 && j < rag) S.set(sx + j, y0 - fh + 2, SHADOW[P.red]); }
  }
  return S;
}

// ----------------------------------------------------------------------------------------------------------- mushrooms

const CAPS = [
  { cap: ramp("f0", "f1", "red"), stem: ramp("s1", "s3", "snow"), spots: true, sq: 0.6 },
  { cap: ramp("d1", "d2", "d3", "d4"), stem: ramp("s0", "s2", "s3"), spots: false, sq: 0.7 },
  { cap: ramp("a0", "a1", "a2", "a3"), stem: ramp("a1", "a2", "a3"), spots: false, sq: 0.45 },
  { cap: ramp("s0", "s2", "s3", "snow"), stem: ramp("s1", "s3", "snow"), spots: false, sq: 0.9 },
  { cap: ramp("s0", "s2", "s3", "snow"), stem: ramp("s0", "s1", "s2"), spots: false, sq: 1, ball: true },
];
const CAP_NAMES = { agaric: 0, fly_agaric: 0, bolete: 1, penny_bun: 1, chanterelle: 2, inkcap: 3, puffball: 4 };
// A little cluster of one kind: fly agaric, bolete, chanterelle, shaggy inkcap or puffball. size: the largest cap's
// width. species: one of those names; omitted, the seed picks among the first four.
export function mushrooms(size = 3, seed = 0, species) {
  const s = Math.max(2, Math.round(size)), kind = CAPS[CAP_NAMES[species]] ?? pick(CAPS.slice(0, 4), rv(seed, 1)), n = 1 + Math.floor(rv(seed, 2) * 3.2);
  const W = s * 4 + 4, H = s * 2 + 5, S = new Spr(W, H, W >> 1, H - 2), gy = S.ay + 0.95;
  const list = [];
  for (let k = 0; k < n; k++) {
    const sc = k === 0 ? 1 : 0.55 + 0.3 * h2(k, seed, 3);
    list.push([(k === 0 ? 0 : (h2(k, seed, 4) - 0.5) * s * 2.4), k === 0 ? 0 : (h2(k, seed, 5) - 0.5) * s * 0.9, sc]);
  }
  list.sort((a, b) => a[1] - b[1]);
  for (const [ox, oy, sc] of list) {
    const cw = Math.max(1, s * sc), x = S.ax + 0.5 + ox, base = gy + oy;
    if (kind.ball) {
      // a puffball has no stem: a pale ball sitting on the ground with a flat dark foot
      blob(S, x, base - cw * 0.4, cw / 2 + 0.3, cw * 0.42 + 0.2, (px, py, l) => dith(kind.cap, 1.8 + l * 1.6 + (h2(px, py, seed) < 0.12 ? -0.8 : 0), px, py));
      continue;
    }
    const sh = Math.max(1, Math.round(cw * (kind.sq > 0.8 ? 0.9 : 0.6)));
    const sw = cw >= 4 ? 2 : 1, sx = Math.floor(x - sw / 2 + 0.5);
    for (let j = 0; j < sh; j++) for (let i = 0; i < sw; i++) S.set(sx + i, Math.floor(base) - j, kind.stem[sw === 1 ? 1 : i === 0 ? 2 : 0]);
    const cy = Math.floor(base) - sh + 0.5, rx = cw / 2 + 0.3, ry = Math.max(0.6, cw * kind.sq * 0.5);
    for (let y = Math.floor(cy - ry); y <= Math.ceil(cy); y++)
      for (let xx = Math.floor(x - rx - 1); xx <= Math.ceil(x + rx); xx++) {
        const nx = (xx + 0.5 - x) / rx, ny = (y + 0.5 - cy) / ry, d2 = nx * nx + ny * ny;
        if (d2 >= 1 || ny > 0.35) continue;
        let c = dith(kind.cap, 1 + lit(nx, ny, Math.sqrt(1 - d2)) * 1.6 + (kind.cap.length - 3) * 0.5, xx, y);
        if (kind.spots && cw >= 3 && h2(xx, y, seed + 6) < 0.22 && ny < 0) c = P.snow;
        S.set(xx, y, c);
      }
    if (cw >= 4) for (let xx = Math.floor(x - rx + 1); xx < Math.ceil(x + rx - 1); xx++) if (S.get(xx, Math.floor(cy) + 1) === 255) S.set(xx, Math.floor(cy) + 1, kind.stem[0]);
  }
  S.outline(P.d0, true);
  return S;
}

// ----------------------------------------------------------------------------------------------------------- butterfly

const WINGSETS = [[P.a3, P.a1], [P.f2, P.d0], [P.snow, P.r3], [P.w6, P.w4], [P.red, P.ink]];
const FLAP = [["WW.WW", "wWbWw", ".w.w."], [".W.W.", ".WbW.", "..w.."], ["..W..", "..W..", "..b.."], ["W...W", "wWbWw", "....."]];
// Anchored at the ground point under it; it hovers a few pixels up and bobs with its wingbeat.
export function butterfly(frame = 0, seed = 0) {
  frame &= 3;
  const [a, b] = pick(WINGSETS, rv(seed, 1)), lift = 4 + [0, 1, 1, 0][frame] + Math.floor(rv(seed, 2) * 2);
  const list = FLAP[frame], S = new Spr(5, list.length + lift + 1, 2, list.length + lift - 1);
  list.forEach((row, y) => [...row].forEach((ch, x) => { if (ch !== ".") S.set(x, y, ch === "W" ? a : ch === "w" ? b : P.ink); }));
  return S;
}
