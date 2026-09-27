// Map symbols in profile over a plan map, the old naturalist convention: each gets a dab of color on the wash layer
// and a pen outline on the ink layer, and knocks out the pen work behind it so front symbols overlap back ones.
import { noise } from "../world.js";
import { TAU, INK, rng, mix, blob, blobPts, smoothPath, polyPath, hull } from "./draw.js";

export const SHADOW = "#6f6a9c";
const OLIVE_INK = "#4a4722";

export function dab(D, path, color, alpha) {
  D.wash.globalAlpha = alpha;
  D.wash.fillStyle = color;
  D.wash.fill(path);
  D.wash.globalAlpha = 1;
}
export function knock(D, path) {
  D.ink.save();
  D.ink.globalCompositeOperation = "destination-out";
  D.ink.fill(path);
  D.ink.restore();
}
// Graphite underdrawing the ink did not quite follow, for the field sketch.
export function pencil(D, pts, closed = false) {
  D.pen.stroke(pts, { w: 0.75, color: "#5f5c5a", alpha: 0.3, wob: 0.6, press: 0.5, taper: 6, closed });
}
// Keep this paper dry: ground washes will be painted around it.
export function reserve(D, path, pad = 2) {
  if (!D.res) return;
  D.res.fillStyle = D.res.strokeStyle = "#000";
  D.res.lineWidth = pad * 2;
  D.res.lineJoin = "round";
  D.res.fill(path);
  if (pad > 0) D.res.stroke(path);
}
export function line(D, pts, w, alpha = 0.9, color = INK) {
  const g = D.ink;
  g.beginPath();
  pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
  g.lineWidth = w;
  g.strokeStyle = color;
  g.globalAlpha = alpha;
  g.stroke();
  g.globalAlpha = 1;
}
const ellipse = (x, y, rx, ry, rot = 0) => { const p = new Path2D(); p.ellipse(x, y, Math.max(rx, 0.1), Math.max(ry, 0.1), rot, 0, TAU); return p; };
export function shadow(D, x, y, rx, ry, alpha = 0.3) { dab(D, ellipse(x, y, rx, ry), SHADOW, alpha); }

// Crown colors by kind, nudged warmer or cooler by the tree's own tint.
const CROWN = { oak: "#557f3a", ash: "#6f9a42", aspen: "#93ad45", pine: "#2f5f50" };
export function crownColor(kind, tint) {
  if (kind === "aspen" && tint > 0.84) return mix("#c9a445", "#b8903a", (tint - 0.84) * 6);
  const base = CROWN[kind];
  return tint < 0.5 ? mix(base, "#a2a53c", (0.5 - tint) * 0.55) : mix(base, "#3c6c5a", (tint - 0.5) * 0.5);
}

export function broadleaf(D, x, y, S, kind, tint, seed) {
  const R = rng(seed), r = S * 0.34, cx = x, cy = y - S * 0.62, col = crownColor(kind, tint), small = S < 13;
  shadow(D, x + r * 0.85, y - r * 0.05, r * 1.15, r * 0.42, small ? 0.14 : 0.26);
  dab(D, blob(cx + (R() - 0.5) * r * 0.3, cy + (R() - 0.5) * r * 0.3, r * 1.04, r, seed, 0.13, 11), col, small ? 0.5 : 0.8);
  dab(D, blob(cx + r * 0.3, cy + r * 0.32, r * 0.64, r * 0.58, seed + 1, 0.2, 9), mix(col, "#1f3a36", 0.45), small ? 0.18 : 0.4);
  // Oaks get a scalloped rim; small trees only a quick C of the pen on their shaded side.
  const n = small ? 14 : 30, bumps = kind === "oak" ? 7 + Math.floor(R() * 3) : kind === "ash" ? 5 : 0, rot = small ? -0.7 - R() * 0.4 : R() * TAU;
  const pts = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * TAU + rot;
    const k = 1 + 0.07 * noise(Math.cos(a) + seed, Math.sin(a) + seed * 0.3, 13) + (bumps ? 0.09 * (Math.abs(Math.sin((a * bumps) / 2)) - 0.6) : 0);
    pts.push([cx + Math.cos(a) * r * k, cy + Math.sin(a) * r * k * 0.97]);
  }
  const crown = smoothPath(pts);
  knock(D, crown);
  knock(D, polyPath([[x - S * 0.06, y + 0.5], [x + S * 0.06, y + 0.5], [x + S * 0.06, cy], [x - S * 0.06, cy]]));
  line(D, [[x + (R() - 0.5) * 0.4, y], [x, cy + r * 0.7]], Math.max(0.7, S * 0.06), 0.85);
  const w = small ? 0.8 : Math.max(0.6, S * 0.045), cut = small ? Math.round(n * (0.62 + R() * 0.12)) : n - Math.floor(R() * n * 0.18);
  line(D, [...pts.slice(0, cut), ...(cut === n ? [pts[0]] : [])], w, 0.95);
  if (S >= 14) for (let k = 0; k < 3; k++) {
    const a = 0.35 + k * 0.38, px = cx + Math.cos(a) * r * 0.55, py = cy + Math.sin(a) * r * 0.55;
    line(D, [[px - r * 0.12, py + r * 0.1], [px + r * 0.12, py - r * 0.06]], 0.6, 0.5);
  }
}

export function pine(D, x, y, S, tint, seed) {
  const R = rng(seed), hgt = S * 1.12, hw = S * 0.3, by = y - S * 0.13, ay = y - hgt, col = crownColor("pine", tint), small = S < 13;
  shadow(D, x + hw * 1.3, y - 0.4, hw * 1.9, hw * 0.48, small ? 0.14 : 0.26);
  const j = () => (R() - 0.5) * hw * 0.25;
  dab(D, smoothPath([[x + j(), ay], [x + hw * 0.55, (ay + by) / 2], [x + hw + j(), by + j()], [x, by + hw * 0.18], [x - hw + j(), by + j()], [x - hw * 0.55, (ay + by) / 2]]), col, small ? 0.6 : 0.84);
  dab(D, polyPath([[x + 0.3, ay + hgt * 0.12], [x + hw * 0.95, by], [x + hw * 0.1, by + 0.5]]), mix(col, "#122a2c", 0.5), small ? 0.2 : 0.4);
  const sil = polyPath([[x, ay - 1], [x + hw * 1.05, by + 1], [x - hw * 1.05, by + 1]]);
  knock(D, sil);
  knock(D, polyPath([[x - S * 0.05, y + 0.5], [x + S * 0.05, y + 0.5], [x + S * 0.05, by], [x - S * 0.05, by]]));
  line(D, [[x, y], [x, by]], Math.max(0.7, S * 0.06), 0.85);
  const w = small ? 0.75 : Math.max(0.6, S * 0.045);
  if (S < 12) {
    line(D, [[x - hw, by], [x - hw * 0.45, (ay + by) / 2 + 0.3], [x, ay], [x + hw * 0.45, (ay + by) / 2 + 0.3], [x + hw, by]], w, 0.88);
    line(D, [[x - hw, by], [x, by + hw * 0.15], [x + hw, by]], w * 0.8, 0.7);
  } else {
    // Tiered: three drooping skirts of branches.
    for (let t = 0; t < 3; t++) {
      const top = ay + t * hgt * 0.22, bot = ay + hgt * (0.36 + t * 0.22), half = hw * (0.5 + t * 0.25);
      line(D, [[x - half, bot], [x - half * 0.4, (top + bot) / 2 + 0.5], [x, top]], w, 0.88);
      line(D, [[x, top], [x + half * 0.4, (top + bot) / 2 + 0.5], [x + half, bot]], w, 0.88);
      line(D, [[x - half, bot], [x - half * 0.5, bot - 1.2], [x, bot + 0.6], [x + half * 0.5, bot - 1.2], [x + half, bot]], w * 0.8, 0.75);
    }
  }
}

export function shrub(D, x, y, S, heath, tint, seed) {
  const R = rng(seed), col = mix(mix("#7d9a45", "#8f6f6c", heath), "#a3a64a", tint * 0.3), n = 2 + (R() < 0.5 ? 1 : 0);
  shadow(D, x + S * 0.35, y - 0.3, S * 0.5, S * 0.18, 0.24);
  for (let i = 0; i < n; i++) {
    const cx = x + (i - (n - 1) / 2) * S * 0.34, cy = y - S * 0.3 - (i === 1 ? S * 0.1 : 0), r = S * 0.27;
    dab(D, blob(cx, cy, r * 1.05, r, seed + i, 0.15, 9), col, 0.75);
    const pts = blobPts(cx, cy, r, r * 0.95, seed + i + 9, 0.1, 12);
    const p = smoothPath(pts);
    knock(D, p);
    line(D, pts.slice(0, 10 + (R() < 0.5 ? 2 : 0)), Math.max(0.5, S * 0.05), 0.8);
  }
}

export function rock(D, x, y, S, seed, tint = 0.5) {
  const R = rng(seed), n = 5 + Math.floor(R() * 2), pts = [];
  for (let i = 0; i < n; i++) {
    const a = Math.PI + (i / (n - 1)) * Math.PI, r = S * (0.75 + R() * 0.3);
    pts.push([x + Math.cos(a) * r, y + Math.sin(a) * r * 0.8]);
  }
  const path = polyPath(pts);
  shadow(D, x + S * 0.4, y + S * 0.05, S * 0.9, S * 0.25, 0.22);
  dab(D, path, mix("#9d968c", "#a58f7a", tint), 0.65);
  dab(D, polyPath([pts[Math.floor(n / 2)], ...pts.slice(Math.floor(n / 2) + 1), [x + S * 0.2, y]]), "#6b6776", 0.35);
  knock(D, path);
  line(D, [...pts, pts[0]], Math.max(0.5, S * 0.12), 0.85);
  const hs = Math.max(1, Math.round(S / 2.5));
  for (let k = 0; k < hs; k++) {
    const t = (k + 1) / (hs + 1), px = x + S * 0.1 + t * S * 0.55;
    line(D, [[px, y - S * 0.08], [px - S * 0.18, y - S * 0.45]], Math.max(0.4, S * 0.07), 0.6);
  }
}

export function grassTick(D, x, y, h, R) {
  const g = D.ink;
  g.beginPath();
  for (const [dx, lean, k] of [[-0.35, -0.55, 0.8], [0, 0.05, 1], [0.35, 0.6, 0.75]]) {
    g.moveTo(x + dx * h * 0.6, y);
    g.lineTo(x + dx * h * 0.6 + lean * h * 0.5 + (R() - 0.5) * 0.4, y - h * k);
  }
  g.lineWidth = Math.max(0.5, h * 0.13);
  g.strokeStyle = OLIVE_INK;
  g.globalAlpha = 0.6;
  g.stroke();
  g.globalAlpha = 1;
}

export function reeds(D, x, y, S, R) {
  const g = D.ink;
  dab(D, ellipse(x, y + S * 0.05, S * 0.55, S * 0.12), "#6f9fa8", 0.35);
  g.beginPath();
  g.moveTo(x - S * 0.55, y); g.lineTo(x + S * 0.55, y);
  g.moveTo(x - S * 0.3, y + S * 0.22); g.lineTo(x + S * 0.35, y + S * 0.22);
  for (let k = 0; k < 4; k++) {
    const px = x - S * 0.3 + k * S * 0.2 + (R() - 0.5) * S * 0.08, hh = S * (0.35 + R() * 0.35);
    g.moveTo(px, y - 0.3); g.lineTo(px + (R() - 0.4) * S * 0.12, y - hh);
  }
  g.lineWidth = Math.max(0.5, S * 0.08);
  g.strokeStyle = "#2f4346";
  g.globalAlpha = 0.75;
  g.stroke();
  g.globalAlpha = 1;
}

// A small conical tent for the maps, with a door and poles crossing at the top.
export function tentIcon(D, x, y, S, color, seed) {
  const R = rng(seed), hw = S * 0.55, top = y - S;
  shadow(D, x + hw * 0.7, y, hw * 1.2, hw * 0.35, 0.28);
  const sil = polyPath([[x, top], [x + hw, y], [x - hw, y]]);
  reserve(D, sil, 1.5);
  dab(D, sil, color, 0.85);
  dab(D, polyPath([[x, top], [x + hw, y], [x + hw * 0.15, y]]), mix(color, "#3b2230", 0.45), 0.45);
  dab(D, polyPath([[x - hw * 0.05, top + S * 0.45], [x + hw * 0.22, y], [x - hw * 0.3, y]]), "#3a2418", 0.6);
  knock(D, sil);
  const w = Math.max(0.6, S * 0.07);
  line(D, [[x - hw, y], [x, top], [x + hw, y]], w, 0.9);
  line(D, [[x - hw - 0.5, y], [x + hw + 0.5, y + (R() - 0.5) * 0.6]], w * 0.8, 0.8);
  line(D, [[x - S * 0.18, top - S * 0.2], [x + S * 0.05, top + S * 0.08]], w * 0.8, 0.85);
  line(D, [[x + S * 0.18, top - S * 0.2], [x - S * 0.05, top + S * 0.08]], w * 0.8, 0.85);
}

// A curl of smoke drifting downwind: pale puffs widening as they rise, one wavering pen line, a spiral at the top.
export function smoke(D, x, y, L, drift, seed, pen, big = false) {
  const c = (t) => [x + drift * L * 0.5 * t ** 1.6 + Math.sin(t * 6 + seed) * L * 0.07 * t, y - L * t];
  const wd = (t) => L * (big ? 0.03 + 0.1 * t : 0.05 + 0.14 * t);
  const R = rng(Math.floor(seed * 1000) + 5);
  for (let i = 0; i <= 16; i++) {
    const t = i / 16, [px, py] = c(t), r0 = wd(t);
    for (let k = 0; k < 2; k++) dab(D, blob(px + (R() - 0.5) * r0 * 0.6, py + (R() - 0.5) * r0 * 0.4, r0 * (0.9 + R() * 0.3), r0 * (0.7 + R() * 0.25), seed * 9 + i * 2 + k, 0.22, 10), "#8d93a9", (big ? 0.3 : 0.2) * (1 - 0.5 * t));
  }
  const wline = big ? 1.1 : Math.max(0.7, L * 0.012), mid = Array.from({ length: 40 }, (_, i) => c(0.05 + (i / 39) * 0.88));
  if (big) pen.broken(mid, -0.5, 14, { w: wline, alpha: 0.6, wob: 0.3, taper: 10 });
  else pen.stroke(mid, { w: wline, alpha: 0.8, wob: 0.2, taper: L * 0.2 });
  const top = c(1), dir = Math.sign(drift) || 1, R0 = wd(1) * 0.8, spiral = [];
  for (let i = 0; i <= 40; i++) { const t = i / 40, a = -Math.PI / 2 + dir * t * TAU * 1.3, rr = R0 * (1 - 0.8 * t); spiral.push([top[0] + dir * R0 * 0.3 + Math.cos(a) * rr * dir, top[1] + R0 * 0.2 + Math.sin(a) * rr]); }
  pen.stroke(spiral, { w: wline, alpha: 0.75, wob: 0.2, taper: 10 });
}

// ---------- camp sketch (oblique): real sizes in pixels ----------

export function campTent(D, x, y, rx, ry, hPx, color, door, seed) {
  const R = rng(seed), ax = x + (R() - 0.5) * rx * 0.08, ay = y - hPx;
  const t0 = Math.asin(Math.min(0.9, ry / hPx));
  const tangentR = [x + rx * Math.cos(t0), y - ry * Math.sin(t0)], tangentL = [x - rx * Math.cos(t0), y - ry * Math.sin(t0)];
  const base = (a) => [x + Math.cos(a) * rx, y + Math.sin(a) * ry];
  const arc = (a0, a1, n = 24) => Array.from({ length: n + 1 }, (_, i) => base(a0 + ((a1 - a0) * i) / n));
  const front = arc(-t0, Math.PI + t0);
  const silPts = [[ax, ay], tangentR, ...front, tangentL];
  const sil = polyPath(silPts);
  // cast shadow: the base and the apex's shadow thrown to the lower right, away from the northwest light
  dab(D, polyPath(hull([...arc(0, TAU, 28), [x + hPx * 0.8, y + hPx * 0.16]])), SHADOW, 0.34);
  reserve(D, sil, 3);
  dab(D, sil, color, 0.82);
  dab(D, polyPath([[ax, ay], ...arc(-t0, 1.05, 12)]), mix(color, "#3b2d45", 0.5), 0.46);
  dab(D, polyPath([[ax, ay], ...arc(1.05, 1.75, 8)]), mix(color, "#3b2d45", 0.4), 0.2);
  knock(D, sil);
  // seams from the apex, a hem, the door facing the fire, poles crossing above
  for (const a of [0.55, 1.25, 2.1, 2.7]) if (Math.abs(a - door) > 0.35) D.pen.stroke([[ax, ay], base(a)], { w: 0.7, alpha: 0.35, wob: 0.4, taper: 8 });
  D.pen.stroke(arc(0.05, Math.PI - 0.05).map(([px, py]) => [px, py - hPx * 0.07]), { w: 0.7, alpha: 0.4, wob: 0.3 });
  if (Math.sin(door) > 0.1) {
    const dt = 0.3, top = [ax + (base(door)[0] - ax) * 0.35, ay + (base(door)[1] - ay) * 0.35];
    const dp = polyPath([top, base(door + dt), base(door - dt)]);
    dab(D, dp, "#3b271b", 0.72);
    dab(D, polyPath([top, base(door - dt), base(door - dt - 0.32)]), mix(color, "#fff4d8", 0.35), 0.55);
    D.pen.stroke([base(door + dt), top, base(door - dt)], { w: 1.0, alpha: 0.85, wob: 0.3, taper: 6 });
    D.pen.stroke([top, base(door - dt - 0.32)], { w: 0.8, alpha: 0.7, wob: 0.3, taper: 6 });
  }
  D.pen.stroke([tangentL, [ax, ay], tangentR], { w: 1.5, alpha: 0.92, wob: 0.5, taper: 10 });
  if (D.pencil) {
    const k = 1.14, ex = (p) => [ax + (p[0] - ax) * -0.12, ay + (p[1] - ay) * -0.12];
    pencil(D, [ex(tangentL), [tangentL[0] + (tangentL[0] - ax) * (k - 1) - 2, tangentL[1] + (tangentL[1] - ay) * (k - 1)]]);
    pencil(D, [ex(tangentR), [tangentR[0] + (tangentR[0] - ax) * (k - 1) + 2, tangentR[1] + (tangentR[1] - ay) * (k - 1)]]);
    pencil(D, arc(-0.2, Math.PI + 0.2, 20).map(([px, py]) => [px + 2.5, py + 2]));
  }
  D.pen.stroke(front, { w: 1.3, alpha: 0.9, wob: 0.5, taper: 12 });
  for (const [dx, dy] of [[-0.09, -0.16], [0.07, -0.18], [0.02, -0.2]]) D.pen.stroke([[ax - dx * hPx * 0.3, ay + hPx * 0.05], [ax + dx * hPx, ay + dy * hPx]], { w: 1.4, alpha: 0.9, wob: 0.2, taper: 4 });
  // guy lines and pegs
  for (const side of [-1, 1]) {
    const a = [ax + side * rx * 0.55 * (1 - 0.45), ay + hPx * 0.55], peg = [x + side * rx * 1.45, y + ry * 0.35];
    D.pen.stroke([a, peg], { w: 0.6, alpha: 0.5, wob: 0.2, taper: 3 });
    D.pen.stroke([[peg[0], peg[1] - 4], [peg[0] + side, peg[1] + 2]], { w: 1.2, alpha: 0.8, wob: 0.1, taper: 2 });
  }
}

function washLine(D, pts, w, color, alpha) {
  const g = D.wash;
  g.beginPath();
  pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
  g.lineWidth = w;
  g.lineCap = g.lineJoin = "round";
  g.strokeStyle = color;
  g.globalAlpha = alpha;
  g.stroke();
  g.globalAlpha = 1;
}

// A small figure in a dyed tunic: standing, sitting by the fire, or stoking it (pose 2). `side` points to the fire.
export function person(D, x, y, h, color, pose, facingViewer, side, seed) {
  const sit = pose === 1 || pose === 3, pen = D.pen, r = h * 0.078, cloth = "#4a3d3a", dark = mix(color, "#241c2c", 0.45);
  const skin = "#e2b08a", hair = ["#4d3120", "#7a4a26", "#2e2420", "#a0703e", "#5b3b2a"][seed % 5];
  const hipY = sit ? y - h * 0.13 : y - h * 0.46, shY = sit ? y - h * 0.52 : y - h * 0.8, hemY = sit ? y - h * 0.1 : y - h * 0.33;
  const lean = sit ? side * h * 0.04 : 0, hx = x + lean * 1.4, headY = shY - r * 1.3, beltY = sit ? y - h * 0.24 : y - h * 0.52;
  shadow(D, x + h * 0.16, y + 1, h * (sit ? 0.34 : 0.24), h * 0.07, 0.32);
  const legs = sit
    ? [[[x - h * 0.06, hipY], [x + side * h * 0.17 - h * 0.05, y - h * 0.21], [x + side * h * 0.23 - h * 0.05, y - h * 0.02]], [[x + h * 0.06, hipY], [x + side * h * 0.21 + h * 0.04, y - h * 0.17], [x + side * h * 0.29 + h * 0.03, y - h * 0.01]]]
    : [[[x - h * 0.058, hemY + h * 0.02], [x - h * 0.062, y - h * 0.18], [x - h * 0.068, y - h * 0.03]], [[x + h * 0.06, hemY + h * 0.02], [x + h * 0.07, y - h * 0.18], [x + h * 0.082, y - h * 0.03]]];
  const body = [[x - h * 0.115 + lean, shY], [x + h * 0.115 + lean, shY], [x + h * 0.17, hemY], [x + h * 0.07, hemY + h * 0.025], [x - h * 0.07, hemY + h * 0.025], [x - h * 0.17, hemY]];
  const bodyP = smoothPath([body[0], [(body[0][0] + body[1][0]) / 2, shY - h * 0.02], body[1], body[2], body[3], body[4], body[5]]);
  const hand = (s) => sit ? [x + side * h * 0.18 + s * h * 0.06, y - h * 0.22] : pose === 2 && s === side ? [x + s * h * 0.34, shY + h * 0.05] : [x + s * h * 0.17, y - h * 0.44];
  const arm = (s) => { const sh = [x + s * h * 0.11 + lean, shY + h * 0.03], hd = hand(s); return [sh, [(sh[0] + hd[0]) / 2 + s * h * 0.03, (sh[1] + hd[1]) / 2], hd]; };
  const head = blob(hx, headY, r, r * 1.08, seed, 0.06, 10);
  // keep the paper dry under the whole figure
  for (const l of legs) { D.res.lineWidth = h * 0.11; D.res.lineCap = "round"; D.res.beginPath(); l.forEach(([px, py], i) => (i ? D.res.lineTo(px, py) : D.res.moveTo(px, py))); D.res.stroke(); }
  reserve(D, bodyP, 1.5);
  reserve(D, head, 1.5);
  for (const s of [-1, 1]) { const a = arm(s); D.res.lineWidth = h * 0.1; D.res.beginPath(); a.forEach(([px, py], i) => (i ? D.res.lineTo(px, py) : D.res.moveTo(px, py))); D.res.stroke(); }
  if (D.pencil) {
    pencil(D, [[x - h * 0.02, y + h * 0.05], [hx + h * 0.02, headY - r * 1.8]]);
    pencil(D, blobPts(hx + 1.5, headY - 1, r * 1.05, r * 1.1, seed + 7, 0.1, 14), true);
  }
  const drawLegs = () => { for (const l of legs) {
    washLine(D, l, h * 0.085, cloth, 0.78);
    const e = l[l.length - 1];
    dab(D, ellipse(e[0] + side * h * 0.015, e[1] + h * 0.01, h * 0.05, h * 0.028), "#2e2420", 0.85);
    pen.stroke(l.map(([px, py]) => [px - h * 0.042, py]), { w: 0.8, alpha: 0.75, wob: 0.2, taper: 3 });
    pen.stroke(l.map(([px, py]) => [px + h * 0.042, py]), { w: 0.8, alpha: 0.75, wob: 0.2, taper: 3 });
  } };
  if (!sit) drawLegs();
  dab(D, bodyP, color, 0.88);
  dab(D, polyPath([[x + lean + h * 0.01, shY], body[1], body[2], [x + h * 0.03, hemY + h * 0.02]]), dark, 0.42);
  washLine(D, [[x - h * 0.15, beltY], [x + h * 0.15, beltY + 1]], h * 0.035, "#7a5230", 0.75);
  knock(D, bodyP);
  pen.stroke([...body, body[0]], { w: 1.1, alpha: 0.88, wob: 0.3, taper: 4, closed: true });
  pen.stroke([[x - h * 0.15, beltY - h * 0.018], [x + h * 0.15, beltY - h * 0.012]], { w: 0.6, alpha: 0.6, wob: 0.2, taper: 3 });
  if (sit) drawLegs();
  for (const s of [-1, 1]) {
    const a = arm(s);
    washLine(D, a, h * 0.075, dark, 0.85);
    pen.stroke(a.map(([px, py]) => [px + s * h * 0.035, py]), { w: 0.8, alpha: 0.8, wob: 0.2, taper: 3 });
    const hd = a[2];
    dab(D, ellipse(hd[0], hd[1], h * 0.03, h * 0.03), skin, 0.85);
  }
  if (pose === 2) { const hd = hand(side); pen.stroke([[hd[0] - side * h * 0.08, hd[1] - h * 0.1], [hd[0] + side * h * 0.3, hd[1] + h * 0.34]], { w: 1.7, color: "#4a2c18", alpha: 0.9, wob: 0.2, taper: 4 }); }
  dab(D, head, skin, 0.82);
  dab(D, facingViewer ? blob(hx, headY - r * 0.5, r * 1.08, r * 0.62, seed + 3, 0.12, 9) : blob(hx, headY - r * 0.12, r * 1.06, r * 0.98, seed + 3, 0.1, 9), hair, 0.82);
  knock(D, head);
  pen.stroke(blobPts(hx, headY, r, r * 1.08, seed, 0.06, 14), { w: 0.9, alpha: 0.88, wob: 0.15, closed: true });
  if (facingViewer) {
    D.ink.fillStyle = INK;
    D.ink.globalAlpha = 0.85;
    for (const s of [-1, 1]) D.ink.fillRect(hx + s * r * 0.36 - 0.6, headY + r * 0.05, 1.3, 1.3);
    D.ink.globalAlpha = 1;
    dab(D, ellipse(hx + r * 0.45, headY + r * 0.45, r * 0.22, r * 0.16), "#d77a6a", 0.4);
  }
}

export function fireplace(D, x, y, s, k, windDx, seed, pen) {
  const R = rng(seed), rr = 0.7 * s, stones = [];
  dab(D, ellipse(x, y, 1.9 * s, 1.9 * s * k), "#f2a65a", 0.22);
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * TAU + R() * 0.2;
    stones.push({ a, px: x + Math.cos(a) * rr, py: y + Math.sin(a) * rr * k, r: s * (0.15 + R() * 0.06) });
  }
  const stone = (st, i) => {
    const p = blob(st.px, st.py, st.r, st.r * 0.75, seed + i, 0.18, 9);
    dab(D, p, "#9b958d", 0.7);
    dab(D, blob(st.px + st.r * 0.25, st.py + st.r * 0.2, st.r * 0.6, st.r * 0.4, seed + i + 50, 0.2, 8), "#5f5b6b", 0.35);
    knock(D, p);
    D.pen.stroke(blobPts(st.px, st.py, st.r, st.r * 0.75, seed + i, 0.18, 12), { w: 0.8, alpha: 0.8, wob: 0.15, closed: true });
  };
  stones.filter((st) => Math.sin(st.a) < 0).forEach(stone);
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI + R() * 0.4, L = s * 0.62;
    const p0 = [x - Math.cos(a) * L, y - Math.sin(a) * L * k - s * 0.08], p1 = [x + Math.cos(a) * L, y + Math.sin(a) * L * k - s * 0.05];
    D.pen.stroke([p0, p1], { w: s * 0.11, color: "#5a3a22", alpha: 0.85, wob: 0.3, taper: 3, press: 0.1 });
  }
  const tongue = (dx, hgt, wd, col, a) => {
    const p = smoothPath([[x + dx - wd, y - s * 0.12], [x + dx - wd * 0.8, y - hgt * 0.45], [x + dx + wd * 0.2, y - hgt], [x + dx + wd * 0.5, y - hgt * 0.5], [x + dx + wd, y - s * 0.1], [x + dx, y - s * 0.02]]);
    dab(D, p, col, a);
    return p;
  };
  const outer = [tongue(-s * 0.15, s * 1.0, s * 0.22, "#e2542c", 0.78), tongue(s * 0.12, s * 1.25, s * 0.25, "#e2542c", 0.78), tongue(0, s * 0.8, s * 0.2, "#d8432c", 0.6)];
  tongue(-s * 0.05, s * 0.75, s * 0.14, "#f5c64a", 0.7);
  tongue(s * 0.1, s * 0.6, s * 0.11, "#f8dc70", 0.6);
  outer.forEach((p) => { knock(D, p); reserve(D, p, 1); });
  for (const [dx, hgt] of [[-s * 0.15, s], [s * 0.12, s * 1.25]]) pen.stroke([[x + dx - s * 0.2, y - s * 0.2], [x + dx - s * 0.1, y - hgt * 0.6], [x + dx + s * 0.05, y - hgt]], { w: 0.8, alpha: 0.6, color: "#6b2a18", wob: 0.3, taper: 4 });
  for (let i = 0; i < 6; i++) dab(D, ellipse(x + (R() - 0.3) * s * 0.9, y - s * (1.3 + R() * 0.9), 1.2, 1.2), "#e8702e", 0.8);
  stones.filter((st) => Math.sin(st.a) >= 0).forEach(stone);
  smoke(D, x + s * 0.05, y - s * 1.25, s * 6.5, windDx * 0.8, seed * 0.37, pen, s > 20);
}

// Split logs stacked four, three, two: the cut ends face us, the logs run back behind them as one body.
export function woodpile(D, x, y, s, seed) {
  const R = rng(seed), d = s * 0.23, run = [s * 0.34, -s * 0.4], ends = [];
  [4, 3, 2].forEach((n, row) => { for (let i = 0; i < n; i++) ends.push([x + (i - (n - 1) / 2) * d * 1.02 + (R() - 0.5), y - d * 0.5 - row * d * 0.86, d * 0.5]); });
  const around = [];
  for (const [cx, cy, r] of ends) for (let a = 0; a < TAU; a += TAU / 12) { around.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]); around.push([cx + Math.cos(a) * r + run[0], cy + Math.sin(a) * r + run[1]]); }
  const outline = hull(around), body = polyPath(outline);
  shadow(D, x + s * 0.55, y + 2, s * 0.95, s * 0.22, 0.32);
  reserve(D, body, 1.5);
  dab(D, body, "#8a5a34", 0.72);
  dab(D, polyPath(hull(around.filter(([, py], i) => i % 2 === 1 || py < y - d * 2.2))), "#5e3a22", 0.25);
  knock(D, body);
  D.pen.stroke(outline, { w: 1, alpha: 0.85, wob: 0.2, closed: true });
  for (const [cx, cy, r] of ends.filter(([, cy]) => cy < y - d * 1.8)) line(D, [[cx - r * 0.3, cy - r * 0.9], [cx - r * 0.3 + run[0], cy - r * 0.9 + run[1]]], 0.6, 0.5);
  ends.forEach(([cx, cy, r], i) => {
    const end = blob(cx, cy, r, r * 0.94, seed + i, 0.08, 10);
    dab(D, end, "#dcb785", 0.8);
    knock(D, end);
    D.pen.stroke(blobPts(cx, cy, r, r * 0.94, seed + i, 0.08, 12), { w: 0.85, alpha: 0.85, wob: 0.1, closed: true });
    D.pen.stroke(blobPts(cx + 0.5, cy, r * 0.45, r * 0.42, seed + i + 20, 0.1, 9), { w: 0.5, alpha: 0.45, wob: 0.1, closed: true });
  });
}

export function grassTuft(D, x, y, L, seed, strong) {
  const R = rng(seed), n = 3 + Math.floor(R() * 3), g = D.ink;
  const greens = ["#86a84a", "#9fb654", "#6f9a4a", "#b3b25a"];
  D.wash.globalAlpha = 0.42;
  D.wash.strokeStyle = greens[seed % 4];
  D.wash.lineWidth = L * 0.28;
  D.wash.lineCap = "round";
  D.wash.beginPath(); D.wash.moveTo(x, y); D.wash.lineTo(x + (R() - 0.5) * L * 0.3, y - L * 0.7); D.wash.stroke();
  D.wash.globalAlpha = 1;
  if (!strong) return;
  g.beginPath();
  for (let i = 0; i < n; i++) {
    const t = n === 1 ? 0 : i / (n - 1) - 0.5, lean = t * 1.1 + (R() - 0.5) * 0.3, hh = L * (0.7 + R() * 0.3) * (1 - Math.abs(t) * 0.4);
    g.moveTo(x + t * L * 0.25, y);
    g.quadraticCurveTo(x + t * L * 0.25 + lean * hh * 0.2, y - hh * 0.6, x + t * L * 0.25 + lean * hh * 0.55, y - hh);
  }
  g.lineWidth = 0.9;
  g.strokeStyle = OLIVE_INK;
  g.globalAlpha = 0.68;
  g.stroke();
  g.globalAlpha = 1;
}

const PETALS = ["#d8483a", "#efc23c", "#f4efe2", "#6f7fd0", "#a064b0", "#e98a3a"];
export function flower(D, x, y, hue, tall) {
  const col = PETALS[Math.floor(hue * PETALS.length) % PETALS.length];
  line(D, [[x, y], [x + 0.6, y - tall]], 0.6, 0.55, OLIVE_INK);
  // white petals are paper kept dry, the painter's way
  if (col === "#f4efe2") { reserve(D, ellipse(x + 0.6, y - tall, 3.6, 3), 0.5); dab(D, ellipse(x + 0.6, y - tall, 1.4, 1.2), "#e8b83a", 0.9); }
  else dab(D, ellipse(x + 0.6, y - tall, 3.6, 3), col, 0.85);
  D.ink.globalAlpha = 0.8;
  D.ink.fillStyle = INK;
  D.ink.fillRect(x + 0.1, y - tall - 0.5, 1.1, 1.1);
  D.ink.globalAlpha = 1;
}

export function pebble(D, x, y, r, seed) {
  const p = blob(x, y, r, r * 0.65, seed, 0.2, 9);
  dab(D, p, "#a59f96", 0.65);
  dab(D, blob(x + r * 0.25, y + r * 0.15, r * 0.6, r * 0.35, seed + 1, 0.2, 8), "#66626f", 0.3);
  knock(D, p);
  D.pen.stroke(blobPts(x, y, r, r * 0.65, seed, 0.2, 12).slice(0, 10), { w: 0.7, alpha: 0.7, wob: 0.1, taper: 2 });
}

// ---------- page furniture ----------

export function compass(D, x, y, R0) {
  const g = D.ink, pen = D.pen;
  dab(D, ellipse(x, y, R0 * 0.98, R0 * 0.98), "#e7d7a8", 0.35);
  pen.stroke(Array.from({ length: 64 }, (_, i) => [x + Math.cos((i / 64) * TAU) * R0, y + Math.sin((i / 64) * TAU) * R0]), { w: 1.3, alpha: 0.9, closed: true, wob: 0.3 });
  pen.stroke(Array.from({ length: 64 }, (_, i) => [x + Math.cos((i / 64) * TAU) * R0 * 0.9, y + Math.sin((i / 64) * TAU) * R0 * 0.9]), { w: 0.7, alpha: 0.8, closed: true, wob: 0.3 });
  g.beginPath();
  for (let i = 0; i < 32; i++) {
    const a = (i / 32) * TAU, k = i % 4 === 0 ? 0.8 : 0.85;
    g.moveTo(x + Math.cos(a) * R0 * k, y + Math.sin(a) * R0 * k);
    g.lineTo(x + Math.cos(a) * R0 * 0.9, y + Math.sin(a) * R0 * 0.9);
  }
  g.lineWidth = 0.7; g.strokeStyle = INK; g.globalAlpha = 0.75; g.stroke(); g.globalAlpha = 1;
  const star = (a, len, wd, colL, colR) => {
    const tip = [x + Math.cos(a) * len, y + Math.sin(a) * len];
    const l = [x + Math.cos(a - Math.PI / 2) * wd, y + Math.sin(a - Math.PI / 2) * wd], r = [x + Math.cos(a + Math.PI / 2) * wd, y + Math.sin(a + Math.PI / 2) * wd];
    const left = polyPath([[x, y], l, tip]), right = polyPath([[x, y], tip, r]);
    dab(D, left, colL, 0.8);
    dab(D, right, colR, 0.8);
    knock(D, polyPath([l, tip, r, [x, y]]));
    g.fillStyle = INK;
    g.globalAlpha = 0.9;
    g.fill(right);
    g.globalAlpha = 1;
    pen.stroke([l, tip, r], { w: 0.9, alpha: 0.9, wob: 0.2, taper: 3 });
  };
  for (let i = 0; i < 4; i++) star(((i + 0.5) / 4) * TAU - Math.PI / 2, R0 * 0.55, R0 * 0.09, "#d8c7a0", "#8a7a6a");
  for (let i = 0; i < 4; i++) star((i / 4) * TAU - Math.PI / 2, R0 * (i === 0 ? 1.08 : 0.86), R0 * 0.13, i === 0 ? "#c4553b" : "#6d8fb0", "#3b3a4a");
  // a small fleur at the north tip, no lettering
  const nx = x, ny = y - R0 * 1.18;
  pen.stroke([[nx - 5, ny + 4], [nx - 7, ny - 2], [nx - 2, ny - 1], [nx, ny - 8], [nx + 2, ny - 1], [nx + 7, ny - 2], [nx + 5, ny + 4]], { w: 0.9, alpha: 0.85, wob: 0.2, taper: 3 });
  dab(D, ellipse(x, y, R0 * 0.06, R0 * 0.06), "#c4553b", 0.9);
}

export function scaleBar(D, x, y, seg, n) {
  const g = D.ink, h = 5;
  for (let i = 0; i < n; i++) {
    const p = polyPath([[x + i * seg, y], [x + (i + 1) * seg, y], [x + (i + 1) * seg, y + h], [x + i * seg, y + h]]);
    if (i % 2 === 0) { g.globalAlpha = 0.85; g.fillStyle = INK; g.fill(p); g.globalAlpha = 1; }
    else dab(D, p, "#c4553b", 0.35);
  }
  // the first segment split in fifths, extended to the left
  for (let i = 0; i < 5; i++) {
    const p = polyPath([[x - seg + (i * seg) / 5, y], [x - seg + ((i + 1) * seg) / 5, y], [x - seg + ((i + 1) * seg) / 5, y + h], [x - seg + (i * seg) / 5, y + h]]);
    if (i % 2 === 1) { g.globalAlpha = 0.85; g.fillStyle = INK; g.fill(p); g.globalAlpha = 1; }
  }
  D.pen.stroke([[x - seg, y], [x + n * seg, y]], { w: 0.8, alpha: 0.9, wob: 0.15, taper: 2 });
  D.pen.stroke([[x - seg, y + h], [x + n * seg, y + h]], { w: 0.8, alpha: 0.9, wob: 0.15, taper: 2 });
  for (let i = -1; i <= n; i++) D.pen.stroke([[x + i * seg, y - 3], [x + i * seg, y + h + 1]], { w: 0.8, alpha: 0.9, wob: 0.1, taper: 2 });
}
