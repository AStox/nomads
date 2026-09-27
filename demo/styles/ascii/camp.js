// The camp drawn over a local grid: at valley scale a cluster of glyphs, at a metre a cell tents that span cells,
// a fire with its light, people, the woodpile, and every tuft, flower and pebble around them.
import { clamp, hash, noise } from "../world.js";
import { P, sc, mix, hexRGB } from "./term.js";
import { TREE } from "./map.js";

export const TENT_COLORS = [["R", "red"], ["W", "yellow"], ["B", "blue"]];
// Clothing colors scaled up to full brightness, hue kept, so an @ reads on dark ground.
export const personColor = (hex) => { const c = hexRGB(hex), m = Math.max(...c); return mix(sc(c, 235 / m), [255, 250, 235], 0.12); };

const wind = (w) => { const [x, z] = w.isle.wind, l = Math.hypot(x, z) || 1; return [x / l, z / l]; };

function glowAround(g, x, z, radius, strength) {
  for (let k = 0; k < g.cols * g.rows; k++) {
    const i = k % g.cols, j = (k / g.cols) | 0, d = Math.hypot(g.cx(i) - x, g.cz(j) - z) / radius;
    if (d >= 1) continue;
    const f = Math.pow(1 - d, 2) * strength;
    g.bg[k] = mix(g.bg[k], sc(P.O, 0.55), f * 0.75);
    g.fg[k] = sc(mix(g.fg[k], P.W, f * 0.35), 1 + f * 0.45);
    g.bgGlow[k] = Math.max(g.bgGlow[k], f * 0.35);
  }
}

// Smoke leans downwind and breaks into puffs: a grey haze over whatever is below, shade glyphs only in its core.
function smoke(w, g, x, z, reach, step) {
  const [wx, wz] = wind(w), haze = sc(P.y, 0.42);
  for (let k = 0; k < g.cols * g.rows; k++) {
    if (g.used[k] === 1) continue;
    const i = k % g.cols, j = (k / g.cols) | 0, dx = g.cx(i) - x, dz = g.cz(j) - z;
    const d = dx * wx + dz * wz, o = -dx * wz + dz * wx;
    if (d < -step * 0.3 || d > reach) continue;
    const spread = step * 0.7 + Math.max(0, d) * 0.24;
    const dens = (1 - d / reach) * Math.exp(-((o / spread) ** 2)) * (0.55 + 0.75 * (0.5 + 0.5 * noise(g.cx(i) / (step * 2.2), g.cz(j) / (step * 2.2), 63)));
    if (dens < 0.12) continue;
    g.bg[k] = mix(g.bg[k], haze, Math.min(0.7, dens * 0.75));
    g.fg[k] = mix(g.fg[k], sc(P.y, 0.8), Math.min(0.6, dens * 0.6));
    if (dens > 0.64) { g.ch[k] = dens > 0.86 ? "▒" : "░"; g.fg[k] = sc(P.y, 0.5 + dens * 0.4); }
    g.used[k] = 2;
  }
}

// Nearest free cell to (x, z), searching outward, so glyphs that share a cell at this scale still all show.
function freeCell(g, x, z) {
  const k0 = g.at(x, z), i0 = k0 % g.cols, j0 = (k0 / g.cols) | 0;
  for (let r = 0; r < 4; r++) {
    let best = -1, bd = 1e9;
    for (let b = -r; b <= r; b++) for (let a = -r; a <= r; a++) {
      if (Math.max(Math.abs(a), Math.abs(b)) !== r) continue;
      const i = i0 + a, j = j0 + b, k = j * g.cols + i;
      if (i < 0 || j < 0 || i >= g.cols || j >= g.rows || g.used[k] === 1) continue;
      const d = Math.hypot(g.cx(i) - x, g.cz(j) - z);
      if (d < bd) { bd = d; best = k; }
    }
    if (best >= 0) return best;
  }
  return k0;
}

// ---------------------------------------------------------------- valley scale: the camp as a knot of glyphs
// Offsets from the fire are stretched so tents, people and woodpile each get a cell of their own at this scale.
export function campValley(w, g, colors) {
  const c = w.camp, f = c.fire, out = (p, m) => [f.x + (p.x - f.x) * m, f.z + (p.z - f.z) * m];
  const fk = g.at(f.x, f.z), fi = fk % g.cols, fj = (fk / g.cols) | 0;
  // Trodden ground: the clearing reads as a camp before the glyphs do.
  for (let b = -3; b <= 3; b++) for (let a = -3; a <= 3; a++) {
    const d = Math.hypot(a, b), i = fi + a, j = fj + b, k = j * g.cols + i;
    if (d > 2.9 || i < 0 || j < 0 || i >= g.cols || j >= g.rows || g.water[k]) continue;
    const worn = 1 - d / 3;
    g.bg[k] = mix(g.bg[k], sc(mix(P.w, P.s, 0.3), 0.36), worn);
    if (d > 0.5) { g.ch[k] = hash(i, j, 55) < 0.5 ? "." : ","; g.fg[k] = sc(P.w, 0.75); }
  }
  glowAround(g, f.x, f.z, g.s * 3.4, 1);
  g.put(fk, "☼", P.Y, sc(P.o, 0.8)); g.glow[fk] = 1; g.bgGlow[fk] = 0.7; g.used[fk] = 1;
  c.tents.forEach((t, n) => {
    const k = freeCell(g, ...out(t.at, 1.7)), col = P[TENT_COLORS[n][0]];
    g.put(k, "▲", col, sc(col, 0.32)); g.glow[k] = 0.45; g.used[k] = 1;
  });
  const wk = freeCell(g, ...out(c.woodpile, 1.6));
  g.put(wk, "≡", sc(P.w, 1.35), sc(P.w, 0.3)); g.used[wk] = 1;
  c.people.forEach((p, n) => {
    const k = freeCell(g, ...out(p.at, 3.2));
    g.put(k, "@", personColor(colors[n]), mix(g.bg[k], P[0], 0.4)); g.glow[k] = 0.5; g.used[k] = 1;
  });
  smoke(w, g, f.x, f.z, g.s * 9, g.s);
  return { fire: fk };
}

// ---------------------------------------------------------------- a metre a cell
export function plantClose(w, g) {
  const c = w.camp.at, half = Math.hypot(g.cols, g.rows) * g.s * 0.5;
  const near = w.nearby(c, half * 1.9, 2.1);
  // A few more scatter passes close in, for pebbles: the world scatters them thinly, one per metre of radius.
  for (let n = 0; n < 4; n++) near.pebbles.push(...w.nearby(c, half * 0.95, 0.01).pebbles);
  const x0 = g.ox, z0 = g.oz, x1 = g.ox + g.cols * g.s, z1 = g.oz + g.rows * g.s;
  const inView = (o, m = 0) => o.x >= x0 - m && o.x < x1 + m && o.z >= z0 - m && o.z < z1 + m;
  const stats = { grass: 0, flowers: 0, pebbles: 0, trees: 0, shrubs: 0, rocks: 0, logs: 0 };
  // Each cell shows its tallest tuft; several tufts in one metre make a clump, the shortest leave bare ground.
  const top = new Array(g.cols * g.rows).fill(null), count = new Uint8Array(g.cols * g.rows);
  for (const t of near.grass) {
    const k = g.at(t.x, t.z);
    if (k < 0 || g.water[k]) continue;
    count[k]++;
    stats.grass++;
    if (!top[k] || top[k].tall < t.tall) top[k] = t;
  }
  for (let k = 0; k < top.length; k++) {
    const t = top[k];
    if (!t || (t.tall < 0.55 && count[k] < 2)) continue;
    const lit = g.lit[k] || 1, u = t.tint, h = t.tall + (count[k] - 1) * 0.06;
    // Height picks the kind of mark, the tuft's own heading picks among marks of that height.
    const q = Math.floor((t.yaw / (Math.PI * 2)) * 4) & 3;
    const ch = h > 0.84 ? '"' : h > 0.7 ? ['"', "'", ";", '"'][q] : h > 0.56 ? [",", "'", "`", ";"][q] : [".", "`", ",", "."][q];
    const code = u < 0.3 ? "l" : u < 0.6 ? "G" : u < 0.75 ? "g" : u < 0.93 ? "v" : "W";
    g.put(k, ch, sc(P[code], lit * (0.5 + Math.min(1, h) * 0.5)), null);
  }
  for (const fl of near.flowers) {
    const k = g.at(fl.x, fl.z);
    if (k < 0 || g.water[k]) continue;
    const code = fl.hue < 0.3 ? "P" : fl.hue < 0.5 ? "M" : fl.hue < 0.68 ? "W" : fl.hue < 0.86 ? "Y" : "m";
    g.put(k, code === "P" && fl.hue < 0.08 ? "♥" : "*", sc(P[code], 0.9), null);
    g.glow[k] = 0.15;
    stats.flowers++;
  }
  for (const pb of near.pebbles) {
    const k = g.at(pb.x, pb.z);
    if (k < 0 || g.water[k]) continue;
    g.put(k, pb.size > 0.48 ? "o" : pb.size > 0.3 ? "∙" : "·", sc(pb.tint < 0.4 ? P.y : pb.tint < 0.85 ? P.s : P.Y, 0.85), null);
    stats.pebbles++;
  }
  for (const lg of near.logs) {
    const dx = Math.cos(lg.yaw), dz = Math.sin(lg.yaw), gl = Math.abs(dx) > 0.85 ? "═" : Math.abs(dz) > 0.85 ? "║" : dx * dz > 0 ? "\\" : "/";
    let any = false;
    for (let d = -lg.length / 2; d <= lg.length / 2; d += g.s * 0.5) {
      const k = g.at(lg.x + dx * d, lg.z + dz * d);
      if (k >= 0) { g.put(k, gl, sc(P.w, 1.2), sc(P.w, 0.3)); any = true; }
    }
    if (any) stats.logs++;
  }
  // Rocks, then shrubs, then the crowns of trees with their shadows cast to the southeast.
  for (const r of w.rocks) if (inView(r, 4)) {
    const rad = Math.max(0.5, r.size * 0.45);
    for (let b = -rad; b <= rad; b += g.s) for (let a = -rad; a <= rad; a += g.s) {
      const d = Math.hypot(a, b) / rad, k = g.at(r.x + a, r.z + b);
      if (d > 1 || k < 0) continue;
      const lit = clamp(1 - (a + b) / (rad * 2.4), 0.5, 1.3);
      g.put(k, d < 0.5 ? "▓" : d < 0.8 ? "▒" : "o", sc(r.tint < 0.5 ? P.y : P.s, lit), sc(P.s, 0.3 * lit));
    }
    stats.rocks++;
  }
  for (const sh of w.shrubs) if (inView(sh, 3)) {
    const rad = 0.45 + sh.tall * 0.4;
    for (let b = -rad; b <= rad; b += g.s) for (let a = -rad; a <= rad; a += g.s) {
      const d = Math.hypot(a, b) / rad, k = g.at(sh.x + a, sh.z + b);
      if (d > 1 || k < 0) continue;
      const lit = clamp(1.05 - (a + b) / (rad * 2.5), 0.55, 1.3), heath = sh.heath > 0.5;
      g.put(k, heath ? (d < 0.6 ? "*" : '"') : d < 0.6 ? "♣" : "τ", sc(heath ? P.m : P.g, lit), sc(heath ? mix(P.m, P.v, 0.5) : P.g, 0.25 * lit));
    }
    stats.shrubs++;
  }
  const trees = w.trees.filter((t) => inView(t, 8)).sort((a, b) => a.tall - b.tall);
  for (const t of trees) {
    const rad = t.tall * (t.kind === "pine" ? 0.17 : 0.24);
    for (let b = -rad; b <= rad * 1.6; b += g.s) for (let a = -rad; a <= rad * 1.6; a += g.s) {
      const k = g.at(t.x + a, t.z + b), d = Math.hypot(a - rad * 0.55, b - rad * 0.55) / rad;
      if (k < 0 || d > 1 || g.used[k]) continue;
      g.bg[k] = sc(g.bg[k], 0.55);
      g.fg[k] = sc(g.fg[k], 0.6);
    }
  }
  for (const t of trees) {
    const rad = t.tall * (t.kind === "pine" ? 0.17 : 0.24), [gl, code, mul] = TREE[t.kind];
    for (let b = -rad; b <= rad; b += g.s) for (let a = -rad; a <= rad; a += g.s) {
      const k = g.at(t.x + a, t.z + b), d = Math.hypot(a, b) / rad;
      if (k < 0 || d > 1) continue;
      const i = k % g.cols, j = (k / g.cols) | 0, lit = clamp(1.05 - (a + b) / (rad * 2.2) - d * 0.25, 0.45, 1.35);
      const r = hash(i, j, 41);
      const ch = t.kind === "pine" ? (d < 0.3 ? "▲" : r < 0.7 ? "♠" : "↑") : d < 0.3 ? "♣" : r < 0.6 ? "♣" : r < 0.8 ? "♠" : '"';
      g.put(k, ch, sc(P[code], lit * mul * (0.85 + t.tint * 0.3)), sc(BG_TREE, lit));
    }
    stats.trees++;
  }
  return stats;
}
const BG_TREE = sc(P.p, 0.36);

export function campClose(w, g, colors) {
  const c = w.camp, f = c.fire, [wx, wz] = wind(w);
  // Evening: the meadow dims so the firelight carries the scene.
  for (let k = 0; k < g.cols * g.rows; k++) { g.fg[k] = sc(g.fg[k], 0.8); g.bg[k] = sc(g.bg[k], 0.75); }
  // Trodden earth round the fire, under the tents and by the woodpile, the same ground the scatter keeps clear of.
  for (let k = 0; k < g.cols * g.rows; k++) {
    const i = k % g.cols, j = (k / g.cols) | 0, x = g.cx(i), z = g.cz(j);
    const worn = Math.max(1 - Math.hypot(x - f.x, z - f.z) / 3.6, 1 - Math.hypot(x - c.woodpile.x, z - c.woodpile.z) / 1.6);
    if (worn <= 0) continue;
    const r = hash(i, j, 51);
    g.put(k, r < 0.35 ? "." : r < 0.5 ? "," : r < 0.62 ? "∙" : " ", sc(P.w, 0.9), sc(mix(P.w, P.s, 0.3), 0.3 + worn * 0.12));
  }
  // Worn paths from each tent door and the woodpile to the fire.
  const path = (x0, z0) => {
    const n = Math.ceil(Math.hypot(f.x - x0, f.z - z0) / (g.s * 0.5));
    for (let q = 0; q <= n; q++) {
      const x = x0 + ((f.x - x0) * q) / n, z = z0 + ((f.z - z0) * q) / n, k = g.at(x, z);
      if (Math.hypot(x - f.x, z - f.z) < 1.6) break;
      if (k < 0 || g.used[k]) continue;
      const i = k % g.cols, j = (k / g.cols) | 0, r = hash(i, j, 54);
      g.put(k, r < 0.4 ? "." : r < 0.6 ? "," : r < 0.7 ? "∙" : " ", sc(P.w, 0.8), sc(mix(P.w, P.s, 0.3), 0.34));
    }
  };
  path(c.woodpile.x, c.woodpile.z);
  // Tents squared to the grid: a ridge pointing at the fire, a lit and a shaded roof panel, a dark doorway on the fire
  // side, a cast shadow to the southeast, and stakes.
  c.tents.forEach((t, n) => {
    const col = P[TENT_COLORS[n][0]], dx0 = f.x - t.at.x, dz0 = f.z - t.at.z;
    const [ux, uz] = Math.abs(dx0) > Math.abs(dz0) ? [Math.sign(dx0), 0] : [0, Math.sign(dz0)];
    const vx = -uz, vz = ux, len = Math.max(4, Math.round(t.size * 1.25)), back = -Math.floor((len - 1) / 2), front = back + len - 1;
    const k0 = g.at(t.at.x, t.at.z), ti = k0 % g.cols, tj = (k0 / g.cols) | 0;
    const litSide = vx + vz < 0 ? 1 : -1; // the panel whose outward side faces the northwest light
    const cell = (du, dv) => { const i = ti + du * ux + dv * vx, j = tj + du * uz + dv * vz; return i >= 0 && j >= 0 && i < g.cols && j < g.rows ? j * g.cols + i : -1; };
    const cells = [];
    for (let du = back; du <= front; du++) for (let dv = -1; dv <= 1; dv++) { const k = cell(du, dv); if (k >= 0) cells.push([k, du, dv]); }
    { const k = cell(front + 1, 0); if (k >= 0) path(g.cx(k % g.cols), g.cz((k / g.cols) | 0)); }
    for (const [k] of cells) {
      const i = k % g.cols, j = (k / g.cols) | 0, s = (j + 1) * g.cols + i + 1;
      if (i + 1 < g.cols && j + 1 < g.rows && !g.used[s]) { g.bg[s] = sc(g.bg[s], 0.4); g.fg[s] = sc(g.fg[s], 0.45); }
    }
    for (const [k, du, dv] of cells) {
      const lit = dv === litSide;
      let ch = lit ? "▒" : "▓", fg = lit ? col : sc(col, 0.7), bg = sc(col, lit ? 0.5 : 0.28);
      if (dv === 0) { ch = ux ? "═" : "║"; fg = mix(col, P.Y, 0.4); bg = sc(col, 0.6); }
      if (dv === 0 && du === front) { ch = "■"; fg = sc(col, 0.12); bg = sc(col, 0.8); }
      g.put(k, ch, fg, bg); g.used[k] = 1; g.glow[k] = dv === 0 ? 0.3 : lit ? 0.2 : 0.08;
    }
    for (const [du, dv] of [[back - 1, 0], [front + 1, 0]]) {
      const k = cell(du, dv);
      if (k >= 0 && !g.used[k]) g.put(k, "·", sc(P.y, 0.9), null);
    }
    // Guy lines run out from the corners on the diagonal.
    for (const [su, sv] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
      const k = cell(su > 0 ? front + 1 : back - 1, sv * 2), dx = su * ux + sv * vx, dz = su * uz + sv * vz;
      if (k >= 0 && !g.used[k]) g.put(k, dx * dz > 0 ? "\\" : "/", sc(P.y, 0.7), null);
    }
  });
  // The woodpile: split logs stacked across the line to the fire.
  {
    const p = c.woodpile, ux = (f.x - p.x) / Math.hypot(f.x - p.x, f.z - p.z), uz = (f.z - p.z) / Math.hypot(f.x - p.x, f.z - p.z);
    for (const o of [-1, 0, 1]) for (const d of [0, -1]) {
      const k = g.at(p.x - uz * o * g.s + ux * d * g.s, p.z + ux * o * g.s + uz * d * g.s);
      if (k < 0) continue;
      g.put(k, "≡", sc(P.w, d ? 1.05 : 1.35), sc(P.w, d ? 0.35 : 0.45)); g.used[k] = 1;
    }
  }
  // Fire, its ring of stones and a few embers.
  const fk = g.at(f.x, f.z);
  glowAround(g, f.x, f.z, 10.5, 1);
  for (let b = -1; b <= 1; b++) for (let a = -1; a <= 1; a++) {
    if (!a && !b) continue;
    const k = g.at(f.x + a * g.s, f.z + b * g.s);
    if (k < 0) continue;
    const i = k % g.cols, j = (k / g.cols) | 0;
    g.put(k, hash(i, j, 52) < 0.6 ? "o" : "•", mix(P.s, P.O, 0.3), sc(P.o, 0.4)); g.used[k] = 1; g.bgGlow[k] = 0.45; g.glow[k] = 0.2;
  }
  g.put(fk, "☼", P.Y, sc(P.O, 0.95)); g.glow[fk] = 1; g.bgGlow[fk] = 0.7; g.used[fk] = 1;
  for (let e = 0; e < 7; e++) {
    const a = hash(e, 3, 53) * Math.PI * 2, d = 2 + hash(e, 4, 53) * 1.6, k = g.at(f.x + Math.cos(a) * d, f.z + Math.sin(a) * d);
    if (k >= 0 && !g.used[k]) { g.put(k, hash(e, 5, 53) < 0.5 ? "·" : "∙", hash(e, 6, 53) < 0.5 ? P.o : P.R, null); g.glow[k] = 0.8; }
  }
  // Smoke leans downwind.
  smoke(w, g, f.x + wx * 1.2, f.z + wz * 1.2, 16, g.s);
  c.people.forEach((p, n) => {
    const k = g.at(p.at.x, p.at.z);
    g.put(k, "@", personColor(colors[n]), mix(g.bg[k], P[0], 0.55)); g.glow[k] = 0.6; g.used[k] = 1;
  });
  return { fire: fk };
}
