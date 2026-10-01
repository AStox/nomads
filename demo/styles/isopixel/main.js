// Nomads as a 90s isometric sim: a 2:1 tile map with integer height steps, slope shapes and cliff strips, painted
// pixel by pixel into a small indexed buffer with one fixed palette, then blown up with nearest neighbour.
import { grow, fbm, noise, smooth } from "../world.js";
import { groundClass, waterAt, riverSmooth, streamAt, flowNow, widthOf, depthOf, TRICKLE, SEA as G_SEA, LAKE as G_LAKE, RIVER as G_RIVER, ROCKY as G_ROCKY, SIZE, TILE_M } from "../island.js";
import { LADDER } from "./ladder.js";
import { P, RGB as RGB_, ramp, SHADOW, GLOW, HAZE, MIST, NCOL, THEME } from "./pal.js";
import { Buf, Spr, ObjBins, tri, strip, blit, castShadow, shadowPx, bayer, dith, h2 } from "./px.js";
import * as SP from "./sprites.js";
import { drawUI } from "./ui.js";

const Q = new URLSearchParams(globalThis.location?.search ?? "");
let VIEW = ["island", "valley", "camp", "peak", "lake", "coast"].includes(Q.get("view")) ? Q.get("view") : "valley";
// peak, lake and coast are discovery views found in the data and framed like the valley
let LOCAL = VIEW !== "island", FAR = VIEW !== "camp";
const SEED = Number(Q.get("seed") || 1);
const pick = (key, opts, def) => (opts.includes(Number(Q.get(key) ?? def)) ? Number(Q.get(key) ?? def) : def);
// px: screen pixels per art pixel; Z rescales anything sized in art pixels so the framing holds at every px
const PX = pick("px", [1, 2, 3], 2), Z = 2 / PX;
// dense: 0 sparse and clean, 1 as designed, 2 rich with props gathered in clumps
const DENSE = pick("dense", [0, 1, 2], 2);
const UI = Q.get("ui") === "1";
// frame 0..7 of a seamless loop: only water, foam, fire, smoke, birds, fish and butterflies change
let FRAME = pick("frame", [0, 1, 2, 3, 4, 5, 6, 7], 0), PH = (FRAME / 8) * Math.PI * 2;
const TAU = Math.PI * 2;
// the live renderer bakes several zoom levels in one worker, so the view and frame are switchable
export function setMode(view, frame = FRAME) {
  VIEW = view; LOCAL = VIEW !== "island"; FAR = VIEW !== "camp";
  FRAME = frame; PH = (FRAME / 8) * TAU;
}
const LOWSUN = THEME === "dawn" || THEME === "dusk" || THEME === "adventure";
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

// cliff: ground steeper than this (rise over run, sampled a tile apart) keeps its drops as rock faces; everything
// gentler is laid out in slope tiles
const CFG = {
  island: { S: 2, W: 12, lp: 2, exag: 1.8, cliff: 0.3, detail: 0, foam: 1.2, deep: 45, sparkle: 0.0005, grid: 0, gain: 1.5, tsun: 0.5, cell: [4, 3] },
  valley: { S: 2, W: 32, lp: 4, tileM: 18, exag: 1.6, cliff: 0.45, relief: 80, detail: 1, foam: 2.4, deep: 9, sparkle: 0.002, focus: [0.5, 0.64], treeK: 1.15, campK: 7, campOff: 4.4, grid: 0.45, gain: 1.2, tsun: 0.5, cell: [5, 3] },
  get peak() { return { ...this.valley, focus: [0.5, 0.42], relief: 200, exag: 1.4, gain: 1.7, cell: [8, 5] }; },
  get lake() { return { ...this.valley, focus: [0.5, 0.5], relief: 90 }; },
  get coast() { return { ...this.valley, focus: [0.5, 0.5], relief: 170, exag: 3, cell: [8, 5] }; },
  camp: { S: 2, W: 58, lp: 7, tileM: 4, exag: 1.0, cliff: 0.6, detail: 2, foam: 4, deep: 3, sparkle: 0.002, focus: [0.5, 0.6], treeK: 0.8, campK: 1.25, campOff: 1, grid: 1, gain: 0.55, tsun: 0, cell: [8, 5] },
};
const SEA = 1, LAKE = 2, RIVER = 3;
const MEADOW = 0, FOREST = 1, SCRUB = 2, MARSH = 3, ROCK = 4, SAND = 5, HILL = 6;
const COV = ["grass", "tree", "shrub", "marsh", "bare", "sand"];
const WEIGHT = [1.0, 1.05, 1.2, 1.5, 1.3, 1.6];

const GR = ramp("g0", "g1", "g2", "g3", "g4", "g5", "g6");
const FF = ramp("p0", "t1", "t2", "g1", "g2", "g3");
const SC = ramp("g0", "m0", "m1", "m2", "g3", "a1", "a2");
const SA = ramp("d3", "s0", "s1", "s2", "s3");
const RK = ramp("r0", "r1", "r2", "r3", "r4", "r5");
const MA = ramp("m0", "m1", "m2", "m3", "a1");
const DI = ramp("d0", "d1", "d2", "d3", "d4", "d5");
const MUD = ramp("d0", "m0", "m1", "m2");
const WA = ramp("w0", "w1", "w2", "w3", "w4", "w5", "w6", "w7");
const FLOWER = [P.f3, P.snow, P.red, P.violet, P.a3];
// one step down each terrain ramp, for the faint tile grid
const DARKER = Uint8Array.from({ length: NCOL }, (_, i) => i);
for (const r of [DI, SA, RK, MA, SC, FF, GR, WA]) for (let k = 1; k < r.length; k++) DARKER[r[k]] = r[k - 1];
// shadows on the ground stay in their own ramp, two steps down, so sand in shade reads as darker sand
for (const r of [WA, DI, SA, RK, MA, SC, FF, GR]) for (let k = 0; k < r.length; k++) SHADOW[r[k]] = r[Math.max(0, k - 2)];

// Light arrives from screen left and a little behind, in tile axes (u, v); shadows fall right and slightly down.
const LU = -0.958, LV = 0.287, SUN = { adventure: 0.55, dawn: 0.42, dusk: 0.33 }[THEME] ?? 0.9; // SUN: elevation, radians
const L3 = [LU * Math.cos(SUN), LV * Math.cos(SUN), Math.sin(SUN)];

function makeView(w, cfg, AW, AH) {
  const V = { ...cfg, name: VIEW, AW, AH, H: cfg.W / 2 };
  if (LOWSUN) V.tsun = SUN * 0.75;
  if (THEME === "adventure") V.band = { island: 1.3, camp: 3 }[VIEW] ?? 1.9;
  V.T = target(w, V);
  if (V.T.campK) V.campK = V.T.campK;
  V.marks = []; V.falls = []; V.rings = []; V.drifts = [];
  const phi = V.T.from;
  V.eu = [Math.cos(phi - Math.PI / 4), Math.sin(phi - Math.PI / 4)];
  V.ev = [Math.cos(phi + Math.PI / 4), Math.sin(phi + Math.PI / 4)];
  V.scale = (tileM) => { V.tileM = tileM; V.k = V.W / (tileM * Math.SQRT2); V.levelM = V.lp / (V.k * 0.866 * V.exag); };
  V.toUV = (x, z) => { const dx = x - V.ox, dz = z - V.oz; return [(dx * V.eu[0] + dz * V.eu[1]) / V.tileM, (dx * V.ev[0] + dz * V.ev[1]) / V.tileM]; };
  V.toW = (u, v) => [V.ox + (u * V.eu[0] + v * V.ev[0]) * V.tileM, V.oz + (u * V.eu[1] + v * V.ev[1]) * V.tileM];
  V.sx = (u, v) => V.X0 + (u - v) * V.H;
  V.sy = (u, v, hz) => V.Y0 + (u + v) * V.H * 0.5 - hz * V.lp;
  V.cz = (u, v, hz) => 1.5 * V.H * (u + v) + hz * V.lp;
  V.hsample = (x, z) => w.heightAt(x, z);
  if (VIEW === "island") fitIsland(w, V);
  else fitLocal(w, V);
  V.NI = V.i1 - V.i0; V.NJ = V.j1 - V.j0;
  V.ms = V.tileM * (VIEW === "island" ? 3 : 2.6); // mottling scale
  V.pm = V.tileM * 0.9;
  V.rip = VIEW === "camp" ? 0.8 : 3;
  // one art pixel up the screen on flat ground, in world meters
  const d = -1 / V.H;
  V.upW = [(d * V.eu[0] + d * V.ev[0]) * V.tileM, (d * V.eu[1] + d * V.ev[1]) * V.tileM];
  // flattened sprite shadows, in art pixels per pixel of height
  const cot = 1 / Math.tan(SUN), sd = [-LU / Math.hypot(LU, LV), -LV / Math.hypot(LU, LV)];
  V.shx = (sd[0] - sd[1]) * 0.8165 * cot;
  V.shy = (sd[0] + sd[1]) * 0.5 * 0.8165 * cot;
  V.sd = sd; V.cot = cot;
  return V;
}

function fitIsland(w, V) {
  V.ox = 0; V.oz = 0;
  const I = w.isle, N = w.N;
  const lim = w.SIZE / 2 - 60;
  const smoothH = (x, z) => Math.abs(x) > lim || Math.abs(z) > lim ? -60 : (w.heightAt(x, z) * 2 + w.heightAt(x + 45, z) + w.heightAt(x - 45, z) + w.heightAt(x, z + 45) + w.heightAt(x, z - 45)) / 6;
  V.hsample = smoothH;
  const land = [];
  for (let cy = 0; cy < N; cy++)
    for (let cx = 0; cx < N; cx++) {
      if (I.height[cy * N + cx] <= 0) continue;
      const x = w.START + cx * w.CELL, z = w.START + cy * w.CELL;
      land.push([x * V.eu[0] + z * V.eu[1], x * V.ev[0] + z * V.ev[1], Math.max(0, smoothH(x, z))]);
    }
  // zoom in until the island spans most of the frame width, as long as it still fits between the menu bars
  const top = 16 * Z, bot = V.AH - 18 * Z;
  let ext;
  for (let tm = 400; tm > 60; tm -= 2) {
    V.scale(tm);
    let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
    for (const [u, v, hh] of land) {
      const a = ((u - v) / tm) * V.H, b = ((u + v) / tm) * V.H * 0.5;
      a0 = Math.min(a0, a); a1 = Math.max(a1, a);
      b0 = Math.min(b0, b - Math.round(hh / V.levelM) * V.lp); b1 = Math.max(b1, b);
    }
    const fits = a1 - a0 + V.H * 2 <= V.AW * 0.86 && b1 - b0 + V.H <= bot - top;
    if (!fits && ext) break;
    ext = [tm, a0, a1, b0, b1];
  }
  const [tm, a0, a1, b0, b1] = ext;
  V.scale(tm);
  V.X0 = Math.round(V.AW / 2 - (a0 + a1) / 2);
  V.Y0 = Math.round((top + bot) / 2 - (b0 + b1) / 2);
  let maxLev = 0;
  for (const l of land) maxLev = Math.max(maxLev, Math.round(l[2] / V.levelM));
  frameTiles(V, 0, maxLev, 4 * Z);
}

// The tile range whose ground can show in the frame, given the level range; `below` extra rows for tall sprites.
function frameTiles(V, lo, hi, below) {
  const hb = V.H * 0.5;
  const amin = -V.X0 / V.H - 2, amax = (V.AW - V.X0) / V.H + 2;
  const bmin = (lo * V.lp - V.Y0) / hb - 3, bmax = (V.AH - V.Y0 + hi * V.lp) / hb + 3, bobj = bmax + below / hb;
  V.i0 = Math.floor((amin + bmin) / 2); V.i1 = Math.ceil((amax + bobj) / 2);
  V.j0 = Math.floor((bmin - amax) / 2); V.j1 = Math.ceil((bobj - amin) / 2);
  V.visible = (u, v) => { const a = u - v, b = u + v; return a >= amin - 1 && a <= amax + 1 && b >= bmin && b <= bmax; };
  V.objVisible = (u, v) => { const a = u - v, b = u + v; return a >= amin - 1 && a <= amax + 1 && b >= bmin && b <= bobj; };
}

function fitLocal(w, V) {
  V.scale(V.T.tileM ?? V.tileM);
  const c = V.T.at, e = [(V.eu[0] + V.ev[0]) * 0.5 * V.tileM, (V.eu[1] + V.ev[1]) * 0.5 * V.tileM];
  V.ox = c.x - e[0]; V.oz = c.z - e[1];
  const R = (V.AW / V.k) * 0.9;
  let hmin = Infinity, hmax = -Infinity;
  for (let a = -R; a <= R; a += R / 12) for (let b = -R; b <= R; b += R / 12) { const hh = Math.max(0, w.heightAt(c.x + a, c.z + b)); hmin = Math.min(hmin, hh); hmax = Math.max(hmax, hh); }
  // flat shores get lifted so their few meters read as steps; hill country is left near true scale
  if (V.relief) { V.exag = clamp((V.relief * (V.lp / (V.k * 0.866))) / Math.max(1, hmax - hmin), 1, V.exag); V.scale(V.tileM); }
  // and squashed until most of its slopes rise less than a level a tile, so it climbs in slope tiles, not cliffs
  const slopes = [], d = V.tileM;
  for (let a = -R; a <= R; a += R / 16)
    for (let b = -R; b <= R; b += R / 16) {
      const x = c.x + a, z = c.z + b;
      if (w.heightAt(x, z) > 0.5) slopes.push(Math.hypot(w.heightAt(x + d, z) - w.heightAt(x - d, z), w.heightAt(x, z + d) - w.heightAt(x, z - d)) / (2 * d));
    }
  slopes.sort((p, q) => p - q);
  const steep = slopes[Math.floor(slopes.length * 0.85)] ?? 0;
  // the coast is the one view that keeps real cliffs, so it is squashed less
  if (steep > 0) { V.exag = clamp(V.lp / (V.k * 0.866 * steep * V.tileM), { coast: 1.4, peak: 1.2 }[VIEW] ?? 0.5, V.exag); V.scale(V.tileM); }
  const focus = V.T.focus ?? V.focus;
  V.X0 = Math.round(V.AW * focus[0]);
  V.Y0 = Math.round(V.AH * focus[1] - V.H * 0.5 + Math.round(c.y / V.levelM) * V.lp);
  if (VIEW === "camp" && !V.T.focus) frameCamp(w, V);
  V.hl = [hmin, hmax];
  frameTiles(V, hmin / V.levelM, hmax / V.levelM, (VIEW === "camp" ? 110 : 40) * Z);
}

// What each view looks at, and the side it is seen from (a world bearing; the viewer stands that way from `at`).
function target(w, V) {
  const I = w.isle, N = w.N, camp = { at: w.camp.at, from: w.camp.from };
  if (VIEW === "camp") return campShot(w, V) || camp;
  if (VIEW === "island" || VIEW === "valley") return camp;
  const bearing = (score) => { let best = 0, bs = -Infinity; for (let d = 0; d < 32; d++) { const a = (d / 32) * TAU, s = score(Math.cos(a), Math.sin(a)); if (s > bs) { bs = s; best = a; } } return best; };
  if (VIEW === "peak") {
    let k0 = 0;
    for (let k = 0; k < N * N; k++) if (I.height[k] > I.height[k0]) k0 = k;
    let x = w.START + (k0 % N) * w.CELL, z = w.START + Math.floor(k0 / N) * w.CELL;
    for (let r = 60; r >= 5; r /= 2) for (let n = 0; n < 12; n++) { const a = (n / 12) * TAU; if (w.heightAt(x + Math.cos(a) * r, z + Math.sin(a) * r) > w.heightAt(x, z)) { x += Math.cos(a) * r; z += Math.sin(a) * r; } }
    // stand on the wooded side so the woods spread out below the summit
    const from = bearing((cx, cz) => { let s = 0; for (let r = 150; r <= 750; r += 100) s += w.fine(w.cover.tree, x + cx * r, z + cz * r) - (w.fine(w.wet, x + cx * r, z + cz * r) > 0.5 ? 0.5 : 0); return s; });
    return { at: { x, y: w.heightAt(x, z), z }, from, summit: true };
  }
  if (VIEW === "lake") {
    // the island's largest lake: its cells flood-filled on the generator grid, seen from the side with the least woods so
    // the far shore's forest rises behind the water
    const lake = (k) => I.water[k] > 0 && I.height[k] + I.water[k] > 1, seen = new Uint8Array(N * N);
    let best = null;
    for (let k0 = 0; k0 < N * N; k0++) {
      if (seen[k0] || !lake(k0)) continue;
      const cells = [k0];
      seen[k0] = 1;
      for (let q = 0; q < cells.length; q++) {
        const k = cells[q], x = k % N, y = (k / N) | 0;
        for (const [a, b] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const X = x + a, Y = y + b, r = Y * N + X;
          if (X >= 0 && Y >= 0 && X < N && Y < N && !seen[r] && lake(r)) { seen[r] = 1; cells.push(r); }
        }
      }
      if (!best || cells.length > best.length) best = cells;
    }
    let sx = 0, sz = 0;
    for (const k of best) { sx += w.START + (k % N) * w.CELL; sz += w.START + Math.floor(k / N) * w.CELL; }
    const x = sx / best.length, z = sz / best.length;
    let span = 0;
    for (const k of best) span = Math.max(span, Math.hypot(w.START + (k % N) * w.CELL - x, w.START + Math.floor(k / N) * w.CELL - z));
    const from = bearing((cx, cz) => { let s = 0; for (let r = span; r <= span + 400; r += 100) s -= w.fine(w.cover.tree, x + cx * r, z + cz * r) - w.fine(w.cover.tree, x - cx * r, z - cz * r) * 0.5; return s; });
    return { at: { x, y: w.heightAt(x, z), z }, from, tileM: clamp((span * 2.4) / 22, 14, 36) };
  }
  // coast: the highest, barest ground with the most sea close around it, seen from the sea
  let best = null;
  for (let y = 3; y < N - 3; y++)
    for (let x = 3; x < N - 3; x++) {
      const k = y * N + x;
      if (I.height[k] <= 2) continue;
      let sea = 0, sx = 0, sz = 0;
      for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) if (I.height[(y + dy) * N + x + dx] <= 0) { sea++; sx += dx; sz += dy; }
      if (sea < 8) continue;
      const score = I.height[k] * (0.3 + I.bare[k]) * (sea / 49);
      if (!best || score > best.score) best = { score, x: w.START + x * w.CELL, z: w.START + y * w.CELL, from: Math.atan2(sz, sx) };
    }
  return { at: { x: best.x, y: w.heightAt(best.x, best.z), z: best.z }, from: best.from };
}

// The close view turns and widens until the shore where the canoe lies fits below the camp: the camp on the upper
// third, the water along the bottom or a side. Scale stays as close as it can; turning prefers the camp's own `from`.
function campShot(w, V) {
  const f = w.camp.fire;
  let water = null;
  for (let r = 6; r < 160 && !water; r += 2) for (let a = 0; a < TAU; a += 0.03) { const x = f.x + Math.cos(a) * r, z = f.z + Math.sin(a) * r; if (w.fine(w.wet, x, z) > 0.5) { water = { x, z, r }; break; } }
  if (!water) return null;
  // ground in direction `from` sits lower on screen, so looking from the water puts the shore straight below the fire
  const from = Math.atan2(water.z - f.z, water.x - f.x);
  // a point r meters along `from` lands r * H / (tileM * sqrt2) art px lower; fit the shore at 88% down, fire at 30%
  const tm = clamp((water.r * V.H) / (V.AH * 0.5 * Math.SQRT2), V.tileM, 9);
  // wider tiles shrink the camp, so its tents, fire and people grow part of the way back
  return { at: w.camp.at, from, tileM: tm, focus: [0.5, 0.3], campK: V.campK * (tm / V.tileM) ** 0.8 };
}

// Slide the close view so the nearest woods edge comes into frame while the whole camp stays in it.
function frameCamp(w, V) {
  const c = w.camp.at, pv = V.k * 0.866;
  const scr = (x, z) => { const [u, v] = V.toUV(x, z), [u0, v0] = V.toUV(c.x, c.z); return [(u - u0 - (v - v0)) * V.H, (u - u0 + v - v0) * V.H * 0.5]; };
  const pts = [...w.camp.tents.map((t) => [t.at, t.size * V.campK * 1.1]), ...w.camp.people.map((p) => [p.at, 2]), [w.camp.woodpile, 2]];
  // the shore where the canoe lies and the fisher stands should be in frame too, if it fits
  const f = w.camp.fire;
  let water = null;
  for (let r = 6; r < 120 && !water; r += 2) for (let a = 0; a < TAU; a += 0.04) { const x = f.x + Math.cos(a) * r, z = f.z + Math.sin(a) * r; if (w.fine(w.wet, x, z) > 0.5 || w.riverAt(x, z) > 0.4) { water = { x, z }; break; } }
  const boxOf = (list) => {
    const box = [Infinity, Infinity, -Infinity, -Infinity];
    for (const [p, r] of list) {
      const [a, b] = scr(p.x, p.z), rp = r * V.k;
      box[0] = Math.min(box[0], a - rp); box[2] = Math.max(box[2], a + rp); box[1] = Math.min(box[1], b - rp * 1.3); box[3] = Math.max(box[3], b + rp * 0.3);
    }
    return box;
  };
  const x0 = V.X0, y0 = V.Y0;
  if (water && search(boxOf([...pts, [water, 4]]))) return;
  V.X0 = x0; V.Y0 = y0;
  search(boxOf(pts));
  function search(box) {
    const trees = w.trees.filter((t) => Math.hypot(t.x - c.x, t.z - c.z) < 110).map((t) => { const [a, b] = scr(t.x, t.z), h = t.tall * pv * V.treeK; return [a, b, h]; });
    const cx = V.X0, cy = V.Y0;
    let best = -Infinity;
    for (let dy = -90 * Z; dy <= 60 * Z; dy += 6 * Z)
      for (let dx = -140 * Z; dx <= 140 * Z; dx += 8 * Z) {
        const X = cx + dx, Y = cy + dy, m = 18 * Z;
        if (X + box[0] < m || X + box[2] > V.AW - m || Y + box[1] < 30 * Z || Y + box[3] > V.AH - 30 * Z) continue;
        let seen = 0;
        for (const [a, b, h] of trees) {
          const x0 = X + a - h * 0.35, x1 = X + a + h * 0.35, y0 = Y + b - h, y1 = Y + b;
          const ox = Math.max(0, Math.min(x1, V.AW) - Math.max(x0, 0)), oy = Math.max(0, Math.min(y1, V.AH - 16 * Z) - Math.max(y0, 14 * Z));
          seen += (ox * oy) / (h * h * 0.7);
        }
        const score = Math.min(seen, 30) - (Math.abs(dx) + Math.abs(dy)) * 0.015 / Z;
        if (score > best) { best = score; V.X0 = X; V.Y0 = Y; }
      }
    return best > -Infinity;
  }
}

// ---------- the tile map ----------
function buildMap(w, V) {
  const { i0, j0, NI, NJ } = V, VI = NI + 1, n = NI * NJ, I = w.isle, N = w.N;
  // the live map keeps every vertex at its exact height, a point sample of one continuous surface, so every level puts
  // a place at the same height; the stills step heights into whole levels for their cliffs
  const HA = V.live ? Float32Array : Int16Array, q = V.live ? (v) => v : Math.round;
  const VL = new HA(VI * (NJ + 1));
  for (let j = 0; j <= NJ; j++) for (let i = 0; i <= NI; i++) { const [x, z] = V.toW(i0 + i, j0 + j); VL[j * VI + i] = q(V.hsample(x, z) / V.levelM); }
  const surfAt = (x, z) => {
    const cx = Math.round((x - w.START) / w.CELL), cy = Math.round((z - w.START) / w.CELL);
    let best = 0, bd = Infinity;
    for (let dy = -2; dy <= 2; dy++)
      for (let dx = -2; dx <= 2; dx++) {
        const X = cx + dx, Y = cy + dy;
        if (X < 0 || Y < 0 || X >= N || Y >= N || I.water[Y * N + X] <= 0) continue;
        if (dx * dx + dy * dy < bd) { bd = dx * dx + dy * dy; best = I.height[Y * N + X] + I.water[Y * N + X]; }
      }
    return best;
  };
  const M = { kind: new Uint8Array(n), wlev: new HA(n), surf: new Float32Array(n), cls: new Uint8Array(n), C: new HA(n * 4), diag: new Uint8Array(n), hc: new Float32Array(n), moist: new Float32Array(n), heath: new Float32Array(n), snow: new Float32Array(n), cov: COV.map(() => new Float32Array(n)) };
  M.at = (i, j) => (i >= 0 && j >= 0 && i < NI && j < NJ ? j * NI + i : -1);
  M.i0 = i0; M.j0 = j0; M.NI = NI; M.NJ = NJ;
  let peak = 0;
  for (const v of I.height) peak = Math.max(peak, v);
  // on the island map, bare ground reads as rock only on the summits; below them it is grass with outcrops and scree
  const capH = peak * 0.68;
  const offs = VIEW === "island" ? [1 / 6, 0.5, 5 / 6].flatMap((a) => [1 / 6, 0.5, 5 / 6].map((b) => [a, b])) : [[0.5, 0.5], [0.22, 0.5], [0.78, 0.5], [0.5, 0.22], [0.5, 0.78]];
  for (let j = 0; j < NJ; j++)
    for (let i = 0; i < NI; i++) {
      const t = j * NI + i, cv = COV.map(() => 0);
      let wet = 0, m = 0, ex = 0;
      for (const [a, b] of offs) {
        const [x, z] = V.toW(i0 + i + a, j0 + j + b);
        wet += V.live ? waterAt(w.isle, w, x, z) : w.fine(w.wet, x, z);
        COV.forEach((k, q) => (cv[q] += w.fine(w.cover[k], x, z)));
        m += w.fine(w.moist, x, z);
        ex += w.bilinear(I.exposure, (x - w.START) / w.CELL, (z - w.START) / w.CELL);
      }
      wet /= offs.length; m /= offs.length; ex /= offs.length;
      const [x, z] = V.toW(i0 + i + 0.5, j0 + j + 0.5);
      const hh = V.hsample(x, z);
      M.hc[t] = hh; M.moist[t] = m;
      COV.forEach((k, q) => (M.cov[q][t] = cv[q] / offs.length));
      M.heath[t] = clamp(ex * 1.4 + M.cov[2][t] - m * 0.3, 0, 1);
      if (wet > 0.45 || (wet > 0.1 && hh < -0.5)) {
        const s = surfAt(x, z);
        M.kind[t] = s > 0.5 ? LAKE : SEA; M.surf[t] = s; M.wlev[t] = q(s / V.levelM);
      } else {
        let best = 0, bs = -1;
        COV.forEach((k, q) => { const s = M.cov[q][t] * WEIGHT[q]; if (s > bs) { bs = s; best = q; } });
        M.cls[t] = best === ROCK && hh < capH && (VIEW === "island" || THEME === "adventure") ? HILL : best;
        if (M.cls[t] === ROCK || (LOCAL && hh > 0.8 * peak)) M.snow[t] = 0.6 * snowLying(w, V, x, z);
        // near the summit even grassy ground turns to bare rock with snow in its hollows
        if (LOCAL && hh > 0.9 * peak) M.cls[t] = ROCK;
      }
    }
  // tiles of land between each land tile and the sea, for the coast's rock band and headland cliffs
  const bfs = (from, pass, cap) => {
    const d = new Float32Array(n).fill(cap + 1), q = [];
    for (let t = 0; t < n; t++) if (from(t)) { d[t] = 0; q.push(t); }
    for (let k = 0; k < q.length; k++) {
      const t = q[k], i = t % NI, j = (t / NI) | 0, e = d[t] + 1;
      if (e > cap) continue;
      for (const [a, b] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const ii = i + a, jj = j + b, r = jj * NI + ii;
        if (ii < 0 || jj < 0 || ii >= NI || jj >= NJ || d[r] <= e || !pass(r)) continue;
        d[r] = e; q.push(r);
      }
    }
    return d;
  };
  M.toSea = bfs((t) => M.kind[t] === SEA, (t) => !M.kind[t], 10);
  // The coast view is where real cliffs belong: bare ground near the sea is a headland of rock, its shore a band of
  // boulders and tide pools.
  M.head = new Uint8Array(n);
  if (VIEW === "coast")
    for (let t = 0; t < n; t++) {
      if (M.kind[t] || M.toSea[t] > 9) continue;
      if (M.cov[4][t] > 0.2 || M.cls[t] === HILL || M.cls[t] === ROCK) { M.head[t] = M.toSea[t] <= 1 ? 2 : 1; if (M.toSea[t] <= 1) M.cls[t] = ROCK; else if (M.cls[t] === ROCK) M.cls[t] = HILL; }
      else if (M.toSea[t] <= 1 && M.cls[t] !== SAND && M.cls[t] !== MARSH) { M.head[t] = 1; M.cls[t] = ROCK; }
    }
  // scree: tiles of ground below rock, for stone fans and boulder clusters
  M.toRock = bfs((t) => !M.kind[t] && M.cls[t] === ROCK, (t) => !M.kind[t], 3);
  // land touching standing water never dips under its surface; on the live map it meets it exactly, so a steep shore
  // is a slope up from the water rather than a wall standing at the tile edge
  const vi = (i, j) => j * VI + i, floor = new HA(VL.length), wetV = new Uint8Array(VL.length);
  for (let j = 0; j < NJ; j++)
    for (let i = 0; i < NI; i++) {
      const t = j * NI + i;
      if (!M.kind[t]) continue;
      for (const [a, b] of [[0, 0], [1, 0], [1, 1], [0, 1]]) {
        const k = vi(i + a, j + b);
        floor[k] = wetV[k] ? Math.max(floor[k], M.wlev[t]) : M.wlev[t]; wetV[k] = 1;
        VL[k] = V.live ? floor[k] : Math.max(VL[k], M.wlev[t]);
      }
    }
  for (let k = 0; k < VL.length; k++) VL[k] = Math.max(0, VL[k]);
  // Slopes, not cliffs: no corner stands more than one level above any of its eight neighbours, so nearly every tile
  // takes a slope shape. Heights give way from the top rather than valleys filling, which would lift land over the
  // shores. Only truly steep ground keeps its drops, and those are the few rock faces left.
  // Rock ground climbs up to two levels a tile in steep slope tiles, keeping cliffs only for truly sheer drops, so a
  // summit reads as one rugged slope rather than stacked blocks; the coast's headland does the opposite.
  const keep = new Uint8Array(VL.length), step = new Uint8Array(VL.length).fill(1);
  const tileAt = (i, j, f) => { for (const [a, b] of [[-1, -1], [0, -1], [-1, 0], [0, 0]]) { const t = M.at(i + a, j + b); if (t >= 0 && f(t)) return true; } return false; };
  for (let j = 0; j <= NJ; j++)
    for (let i = 0; i <= NI; i++) {
      const [x, z] = V.toW(i0 + i, j0 + j), d = V.tileM, k = vi(i, j);
      const gx = V.hsample(x + d, z) - V.hsample(x - d, z), gz = V.hsample(x, z + d) - V.hsample(x, z - d), sl = Math.hypot(gx, gz) / (2 * d);
      let cliff = V.cliff;
      if (tileAt(i, j, (t) => M.head[t] === 2)) cliff *= 0.3;
      else if (tileAt(i, j, (t) => M.head[t])) { cliff *= 3.4; step[k] = 3; }
      else if (LOCAL && THEME === "adventure" && tileAt(i, j, (t) => !M.kind[t] && (M.cls[t] === ROCK || M.cls[t] === HILL))) { cliff *= 3.4; step[k] = VIEW === "peak" || V.live ? 4 : 3; }
      // the live levels span the whole island, so steep grass climbs two levels a tile rather than stepping in blocks
      else if (V.live && LOCAL) step[k] = 2;
      // the peak view is one continuous mountain: every drop becomes slope tiles, and so is the live map
      keep[k] = VIEW !== "peak" && !V.live && sl > cliff ? 1 : 0;
    }
  const settle = (fwd) => {
    let moved = false;
    const near = fwd ? [[-1, 0], [-1, -1], [0, -1], [1, -1]] : [[1, 0], [1, 1], [0, 1], [-1, 1]];
    for (let jj = 0; jj <= NJ; jj++)
      for (let ii = 0; ii <= NI; ii++) {
        const i = fwd ? ii : NI - ii, j = fwd ? jj : NJ - jj, k = vi(i, j);
        if (keep[k]) continue;
        let lim = VL[k];
        for (const [a, b] of near) if (i + a >= 0 && j + b >= 0 && i + a <= NI && j + b <= NJ) lim = Math.min(lim, VL[vi(i + a, j + b)] + step[k]);
        lim = Math.max(lim, floor[k]);
        if (lim < VL[k]) { VL[k] = lim; moved = true; }
      }
    return moved;
  };
  // the live map keeps every height: the z-tested terrain hides steep far sides instead of flattening them
  if (!V.live) for (let n = 0; n < 6 && (settle(true) | settle(false)); n++);
  const minCorner = (i, j) => Math.min(VL[vi(i, j)], VL[vi(i + 1, j)], VL[vi(i + 1, j + 1)], VL[vi(i, j + 1)]);
  // Streams become one-tile channels, walked from source to mouth so the water only ever steps down.
  for (const line of V.live ? [] : w.rivers) {
    let pts = line;
    if (w.heightAt(pts[0][0], pts[0][1]) < w.heightAt(pts.at(-1)[0], pts.at(-1)[1])) pts = [...pts].reverse();
    const path = [];
    let prev = null;
    for (let k = 0; k < pts.length - 1; k++) {
      const [ua, va] = V.toUV(pts[k][0], pts[k][1]), [ub, vb] = V.toUV(pts[k + 1][0], pts[k + 1][1]);
      const steps = Math.ceil(Math.hypot(ub - ua, vb - va) / 0.15) + 1;
      for (let s = 0; s <= steps; s++) {
        const u = ua + ((ub - ua) * s) / steps, v = va + ((vb - va) * s) / steps, ti = Math.floor(u) - i0, tj = Math.floor(v) - j0;
        if (prev && ti === prev[0] && tj === prev[1]) continue;
        if (prev && ti !== prev[0] && tj !== prev[1]) {
          const da = Math.hypot(u - (i0 + ti + 0.5), v - (j0 + prev[1] + 0.5)), db = Math.hypot(u - (i0 + prev[0] + 0.5), v - (j0 + tj + 0.5));
          path.push(da < db ? [ti, prev[1]] : [prev[0], tj]);
        }
        path.push([ti, tj]);
        prev = [ti, tj];
      }
    }
    let lev = Infinity;
    for (const [ti, tj] of path) {
      if (ti < 0 || tj < 0 || ti >= NI || tj >= NJ) continue;
      const t = tj * NI + ti;
      if (M.kind[t] === SEA || M.kind[t] === LAKE) { lev = M.wlev[t]; continue; }
      lev = Math.min(lev, minCorner(ti, tj));
      if (M.kind[t] === RIVER) { M.wlev[t] = Math.min(M.wlev[t], lev); continue; }
      M.kind[t] = RIVER; M.wlev[t] = lev; M.surf[t] = lev * V.levelM;
    }
  }
  for (let j = 0; j < NJ; j++)
    for (let i = 0; i < NI; i++) {
      const t = j * NI + i;
      let c = [VL[vi(i, j)], VL[vi(i + 1, j)], VL[vi(i + 1, j + 1)], VL[vi(i, j + 1)]];
      if (M.kind[t]) c = [M.wlev[t], M.wlev[t], M.wlev[t], M.wlev[t]];
      else {
        const lo = Math.min(...c), hi = Math.max(...c), span = LOCAL && THEME === "adventure" && M.head[t] !== 2 && (M.cls[t] === ROCK || M.cls[t] === HILL) ? (VIEW === "peak" ? 4 : 3) : 1;
        if (VIEW !== "peak" && !V.live && hi - lo > span) {
          // too steep for a slope tile: keep a slope shape and let cliff strips take the rest
          const b = clamp(Math.floor(M.hc[t] / V.levelM), lo, hi - span);
          c = c.map((q) => clamp(q, b, b + span));
        }
      }
      M.C.set(c, t * 4);
      const dTB = Math.abs(c[0] - c[2]), dLR = Math.abs(c[3] - c[1]);
      M.diag[t] = dTB < dLR ? 0 : dLR < dTB ? 1 : c[0] + c[2] > c[1] + c[3] ? 0 : 1;
    }
  M.maxLev = 0;
  for (const c of M.C) if (c > M.maxLev) M.maxLev = c;
  // tiles of water between each water tile and the nearest land, so shallows hug the shore and open water reads dark
  M.shore = new Float32Array(n).fill(9);
  const queue = [];
  for (let t = 0; t < n; t++) if (!M.kind[t]) { M.shore[t] = 0; queue.push(t); }
  for (let q = 0; q < queue.length; q++) {
    const t = queue[q], i = t % NI, j = (t / NI) | 0, d = M.shore[t] + 1;
    if (d > 8) continue;
    for (const [a, b] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const ii = i + a, jj = j + b, k = jj * NI + ii;
      if (ii < 0 || jj < 0 || ii >= NI || jj >= NJ || M.shore[k] <= d) continue;
      M.shore[k] = d; queue.push(k);
    }
  }
  M.at = (i, j) => (i >= 0 && j >= 0 && i < NI && j < NJ ? j * NI + i : -1);
  // The rendered ground level under (u, v), on the same triangles the tile was drawn with.
  M.ground = (u, v) => {
    const i = Math.floor(u) - i0, j = Math.floor(v) - j0, t = M.at(i, j);
    if (t < 0) return null;
    const fu = u - Math.floor(u), fv = v - Math.floor(v), [T, R, B, L] = M.C.subarray(t * 4, t * 4 + 4);
    let lev;
    if (M.diag[t] === 0) lev = fu >= fv ? T + (R - T) * fu + (B - R) * fv : T + (B - L) * fu + (L - T) * fv;
    else lev = fu + fv <= 1 ? T + (R - T) * fu + (L - T) * fv : R + L - B + (B - L) * fu + (B - R) * fv;
    return { lev, t, water: M.kind[t] };
  };
  return M;
}

// Ground in the shadow of higher ground: march toward a low sun on the rendered tiles.
function shadowTest(V, M) {
  const rise = (Math.tan(V.tsun) * V.tileM) / (V.lp / (V.k * 0.866)), step = 0.3, su = -V.sd[0] * step, sv = -V.sd[1] * step;
  return (u, v, lev) => {
    let cu = u, cv = v;
    for (let k = 1; k < 80; k++) {
      cu += su; cv += sv;
      const need = lev + rise * step * k;
      if (need > M.maxLev) return false;
      const g = M.ground(cu, cv);
      if (!g) return false;
      if (g.lev > need + 0.05) return true;
    }
    return false;
  };
}

// ---------- terrain textures ----------
// Stones: cells of a jittered grid, each lit on its upper left, with dark cracks between. -> [crack, ox, oy, id]
function stone(V, x, y) {
  const gx = x / V.cell[0], gy = y / V.cell[1], ix = Math.floor(gx), iy = Math.floor(gy);
  let f1 = 9, f2 = 9, ox = 0, oy = 0, id = 0;
  for (let j = -1; j <= 1; j++)
    for (let i = -1; i <= 1; i++) {
      const cx = ix + i + 0.15 + 0.7 * h2(ix + i, iy + j, 23), cy = iy + j + 0.15 + 0.7 * h2(ix + i, iy + j, 24);
      const d = (gx - cx) ** 2 + (gy - cy) ** 2;
      if (d < f1) { f2 = f1; f1 = d; ox = gx - cx; oy = gy - cy; id = h2(ix + i, iy + j, 25); } else if (d < f2) f2 = d;
    }
  return [Math.sqrt(f2) - Math.sqrt(f1) < 0.16, ox, oy, id];
}
function flowerCol(wx, wz) {
  return FLOWER[Math.floor((fbm(wx / 70, wz / 70, 51, 2) + 0.6) * 3.3 + 10) % FLOWER.length];
}
function iceTex(x, y, wx, wz) {
  if (Math.abs(noise(wx / 9, wz / 9, 131)) < 0.025 || Math.abs(noise(wx / 23, wz / 17, 132)) < 0.015) return P.w5;
  const v = 1.4 + fbm(wx / 30, wz / 30, 133, 2) * 1.2 + (h2(x >> 1, y, 134) < 0.05 ? 1 : 0);
  return dith([P.w6, P.haze, P.snow], v, x, y);
}
function texWater(w, V, K, x, y, wx, wz, fu, fv) {
  if (V.iceAt && K.kind !== SEA && V.iceAt(wx, wz)) return iceTex(x, y, wx, wz);
  const H = V.H, dU0 = fu * H, dU1 = (1 - fu) * H, dV0 = fv * H, dV1 = (1 - fv) * H, ln = K.ln;
  let d = 99;
  if (ln & 1) d = Math.min(d, dU0);
  if (ln & 2) d = Math.min(d, dU1);
  if (ln & 4) d = Math.min(d, dV0);
  if (ln & 8) d = Math.min(d, dV1);
  if (ln & 16) d = Math.min(d, Math.max(dU0, dV0));
  if (ln & 32) d = Math.min(d, Math.max(dU1, dV0));
  if (ln & 64) d = Math.min(d, Math.max(dU0, dV1));
  if (ln & 128) d = Math.min(d, Math.max(dU1, dV1));
  const fw = V.foam, lap = 0.5 + 0.18 * Math.sin(PH + (wx + wz) / (V.tileM * 1.3));
  if (d < fw * lap) return P.w7;
  if (d < fw * (lap + 0.5) && h2(x, y, 45) < 0.45) return P.w6;
  let v, near = 0;
  if (K.kind === RIVER) v = 4.1 + (h2(x, y, 46) - 0.5) * 0.7 + (d < fw * 2 ? 0.4 : 0);
  else {
    const depth = K.surf - w.heightAt(wx, wz), c = K.sc;
    if (c && V.band) {
      // shallows only in a band along the shore, bright turquoise, falling off to a dark open-water blue
      const dist = (c[0] * (1 - fu) + c[1] * fu) * (1 - fv) + (c[3] * (1 - fu) + c[2] * fu) * fv;
      const shallow = (1 - smooth(0, V.band, dist)) * (0.6 + 0.4 * (1 - smooth(0, V.deep, depth)));
      near = 1 - smooth(0, V.band * 1.8, dist);
      v = 1.35 + 3.9 * shallow + fbm(wx / (V.tileM * 4), wz / (V.tileM * 4), 41, 2) * 0.45;
    } else v = (VIEW === "island" ? 1.8 : 1.4) + 3.4 * (1 - smooth(0, V.deep, depth)) + fbm(wx / (V.tileM * 4), wz / (V.tileM * 4), 41, 2) * 0.6;
    if (d < fw * 2.4) v += 0.6;
  }
  if (V.band) {
    // ripple dashes, 2 or 3 px, on every other row; denser near the shallows and toward the sun (upper left)
    if ((y & 1) === 0) {
      const sx = x + (y >> 1) * 3, cell = Math.floor(sx / 6), r = h2(cell, y, 47), toSun = V.live ? 0.5 : 1 - smooth(0.2, 1.3, x / V.AW + y / V.AH);
      const rate = (VIEW === "island" ? 0.25 : 1) * (0.012 + 0.1 * near + 0.06 * toSun), life = ((FRAME + Math.floor(h2(cell, y, 48) * 8)) & 7) < 5;
      if (r < rate && life && sx - cell * 6 < 2 + (r * 97 & 1)) return r < rate * 0.3 ? P.w7 : WA[Math.min(WA.length - 2, Math.floor(v) + 2)];
    }
    if (h2(x, y, 43) < V.sparkle * 0.3 && ((FRAME + (h2(x, y, 49) * 8) | 0) & 7) < 3) return P.w7;
  } else {
    if (V.detail) {
      const row = y >> 2, seg = (x + row * 7) >> 2;
      if ((y & 3) === 0 && h2(seg, row, 42) < 0.1) v += 0.9;
    } else if ((y & 1) === 0 && h2(x >> 1, y, 42) < 0.06) v += 0.9;
    if (h2(x, y, 43) < V.sparkle || h2(x - 1, y, 43) < V.sparkle * 0.7) return P.w7;
  }
  return dith(WA, v, x, y);
}

function texTop(w, V, K, x0, y0, wx, wz, lev, s, fu, fv) {
  if (K.kind) return texWater(w, V, K, x0, y0, wx, wz, fu, fv);
  const c = texLand(w, V, K, x0, y0, wx, wz, lev, s, fu, fv);
  if (!V.grid || (fu * V.H >= 1 && fv * V.H >= 1) || (THEME === "adventure" && (K.cls === ROCK || K.cls === HILL || K.toRock <= 1))) return c;
  if (V.grid >= 1) return THEME === "adventure" ? (h2(x0, y0, 97) < (K.flat ? 0.12 : 0.3) ? DARKER[c] : c) : DARKER[DARKER[c]];
  return h2(x0, y0, 96) < V.grid ? DARKER[DARKER[c]] : c;
}
function texLand(w, V, K, x0, y0, wx, wz, lev, s, fu, fv) {
  const H = V.H;
  // scree strewn down from rock, thinning with distance, in fans rather than an even sprinkle
  if (THEME === "adventure" && (VIEW === "peak" || !FAR) && K.cls !== ROCK && K.cls !== SAND && K.toRock <= 2) {
    const fan = fbm(wx / (V.tileM * 0.6), wz / (V.tileM * 0.6), 39, 2) + 0.35 - K.toRock * 0.22;
    const st = (a, b) => h2(a >> 1, b, 40) < fan * 0.55; // stones two pixels wide
    if (fan > 0 && st(x0, y0)) return st(x0, y0 - 1) ? P.r3 : h2(x0 >> 1, y0, 41) < 0.5 ? P.r5 : P.r4;
    if (fan > 0 && st(x0, y0 - 1)) return P.r1;
  }
  // Fine pattern in tile-local pixels: every tile repeats one of a few hand-made looking stamps, as real tile sets did.
  const x = x0 - K.ox, y = Math.round(y0 - K.oy + lev * V.lp);
  let edge = 0;
  if (K.rimU && (1 - fu) * H < 1) edge += 0.5;
  if (K.rimV && (1 - fv) * H < 1) edge += 0.8;
  if (K.aoU && fu * H < 1.7) edge -= 0.9;
  if (K.aoV && fv * H < 1.7) edge -= 0.9;
  if (V.trodden) {
    const t = V.trodden(wx, wz);
    if (t < 0 || (t < V.fringe && h2(x, y, 90) < (1 - t / V.fringe) * 0.55)) {
      if (h2(x, y, 91) < 0.03) return P.r3;
      if (h2(x, y - 1, 91) < 0.03) return P.r1;
      return dith(DI, (VIEW === "valley" ? 3.9 : 2.9) + s + fbm(wx / 3, wz / 3, 92, 2) * 0.9 + edge + (h2(x, y, 93) - 0.5) * 0.7, x0, y0);
    }
  }
  const mot = fbm(wx / V.ms, wz / V.ms, 11, 2) + K.var;
  switch (K.cls) {
    case FOREST: {
      const v = 2.0 + s * 0.8 + mot * 0.9 + edge + (h2(x, y, 1) - 0.5) * 0.7;
      if (V.detail) { const q = h2(x, y, 4); if (q < 0.05) return P.d2; if (q < 0.065) return P.d3; if (q > 0.975) return P.g3; }
      return dith(FF, v, x0, y0);
    }
    case SCRUB: {
      if (V.detail && K.heath > 0.45 && h2(x, y, 6) < 0.05) return P.violet;
      return dith(SC, 3.0 + s + mot + (h2(x >> 1, y >> 1, 5) - 0.5) * 1.5 + edge, x0, y0);
    }
    case SAND: {
      let v = 2.5 + s * 0.7 + mot * 0.5 + edge + (h2(x, y, 1) - 0.5) * 0.4;
      if (V.detail) {
        const r = (wx * 0.6 + wz * 0.8) / V.rip + fbm(wx / (V.rip * 8), wz / (V.rip * 8), 61, 2) * 2, f = r - Math.floor(r);
        if (f < 0.13) v -= 0.9; else if (f < 0.22) v += 0.35;
      }
      if (lev < 0.5 && K.wet) v -= 1.0;
      if (h2(x, y, 7) < 0.02) return P.d4;
      return dith(SA, v, x0, y0);
    }
    case ROCK: {
      // far views: big weathered slabs with soft cracks, not a pavement of cobbles
      if (V.band && FAR) {
        // texture in world meters, so slabs, cracks and snow run on across tile edges
        const m = V.tileM * 0.16, gx = wx / m, gy = wz / m;
        const sl = noise(gx, gy, 27) + 0.5 * noise(gx * 2.3, gy * 2.3, 28) + 0.25 * noise(gx * 5, gy * 5, 26);
        // the shore of the headland: boulders with tide pools between them
        if (K.head === 2) {
          const [crack, ox, oy, id] = stone(V, x0, y0);
          if (crack) return id < 0.35 ? (h2(x0, y0, 37) < 0.4 ? P.w5 : P.w4) : P.r0;
          if (id < 0.12) return (ox + oy) < -0.2 ? P.w6 : P.w4;
          if (id > 0.85 && oy > 0.1) return P.m1;
          return dith(RK, 2.9 + s - (ox * 0.8 + oy) * 1.9 + (id - 0.5), x0, y0);
        }
        // Painted rock: broad flat planes in three tones picked by facing, clean edges between them, a few dark cracks
        // down the fall line and a light edge on ridges; no per-pixel noise. Snow lies in solid shapes on top.
        const plane = Math.round(fbm(wx / (V.tileM * 1.4), wz / (V.tileM * 1.4), 27, 2) * 1.4) * 0.5;
        // faces toward the viewer sit in half light with the sun behind-left, so tones are read relative to that
        const face = s * 1.1 + plane + edge + 0.9;
        const snowV = K.snow > 0.03 ? fbm(wx / (V.tileM * 1.1), wz / (V.tileM * 2.2), 29, 2) + K.snow * 3 - 0.6 : -1;
        if (snowV > 0.04) return face < -0.2 ? P.haze : P.snow;
        if (snowV > -0.02) return bayer(x0, y0) < (snowV + 0.02) / 0.06 ? (face < -0.2 ? P.haze : P.snow) : face < -0.2 ? P.r2 : P.r4;
        if (K.Q) {
          // negative curvature is a ridge, positive a gully; short 1 px cracks run only along those
          const q = (K.Q[0] * (1 - fu) + K.Q[1] * fu) * (1 - fv) + (K.Q[3] * (1 - fu) + K.Q[2] * fu) * fv;
          const crease = Math.abs(q) > V.crease && Math.abs(noise(x0 / 6, y0 / 26, 83)) < 0.03 && noise(x0 / 7, y0 / 11, 85) > 0.3;
          if (crease) return q < 0 ? P.r5 : P.r1;
          const tv = 2.6 + face * 1.3, tone = clamp(Math.round(tv + (bayer(x0, y0) - 0.5) * 0.3), 1, 4);
          // gullies collect scree: little rock clusters lit upper left, and streaks of loose stone down the fall line
          if (q > V.crease * 0.5) {
            const cx = Math.floor(x0 / 5), cy = Math.floor(y0 / 4);
            if (h2(cx, cy, 122) < 0.4) {
              const dx = x0 - cx * 5 - 1 - Math.floor(h2(cx, cy, 123) * 3), dy = y0 - cy * 4 - 1 - Math.floor(h2(cx, cy, 124) * 2);
              if (dx >= 0 && dx <= 1 && dy >= 0 && dy <= 1) return dx + dy === 0 ? P.r5 : dx + dy === 2 ? P.r1 : P.r3;
              if (dy === 2 && dx >= 0 && dx <= 1) return RK[clamp(tone - 2, 0, 4)];
            }
            if (noise(x0 / 1.6, y0 / 12, 121) > 0.42 && h2(x0, y0, 125) < 0.65) return RK[clamp(tone + (h2(x0, y0 - 1, 126) < 0.6 ? 2 : -1), 1, 5)];
          }
          // sparse pebbles and lichen, two pixels wide, lighter on lit faces and darker in shade
          const sp = h2(x0 >> 1, y0, 120);
          if (sp < 0.04) return sp < 0.012 ? (face > 0 ? P.m3 : P.m1) : RK[clamp(tone + (face > 0 ? 1 : -1), 0, 5)];
          return RK[tone];
        } else {
          const crack = Math.abs(noise(x0 / 6, y0 / 26, 83)) < 0.035 && noise(x0 / 30, y0 / 40, 84) > 0.1;
          if (crack) return P.r1;
          if (edge > 0.3) return P.r5;
        }
        return RK[clamp(Math.round(2.6 + face * 1.3), 1, 4)];
      }
      const [crack, ox, oy, id] = stone(V, x, y);
      if (crack) return K.grass > 0.25 && id < 0.4 ? P.g1 : P.r0;
      if (K.snow > 0.02 && (ox + oy < -0.1 || id < K.snow * 4)) return ox + oy < -0.35 ? P.snow : P.r5;
      if (K.grass > 0.3 && id < 0.18) return dith(GR, 2.6 + s - (ox + oy) * 1.2, x0, y0);
      return dith(RK, (VIEW === "island" ? 3.2 : 2.7) + s * 0.9 + mot * 0.4 - (ox * 0.8 + oy * 1.0) * 1.9 + (id - 0.5) * 1.1 + edge, x0, y0);
    }
    case HILL: {
      // grass slope; outcrops break through where the ground is barest, with scree strewn below them
      const o = fbm(wx / (V.tileM * 1.3), wz / (V.tileM * 1.3), 26, 2) + K.bare * 0.6 - (V.band && FAR ? 0.85 : 0.72);
      if (o > 0) {
        const [crack, ox, oy, id] = stone(V, x, y);
        if (crack) return P.r0;
        return dith(RK, 2.9 + s * 0.9 - (ox * 0.8 + oy) * 1.9 + (id - 0.5) + (o < 0.08 ? -0.8 : 0), x0, y0);
      }
      const q = h2(x0, y0, 27);
      if (!(V.band && FAR) && o > -0.15 && q < 0.1 + o * 0.4) return q < 0.04 ? P.r4 : P.r2;
      const dryness = clamp(K.heath, 0, 1);
      return dith(dryness > 0.55 ? SC : GR, 2.9 + s * 1.1 + mot + edge + (h2(x0 >> 1, y0, 28) - 0.5) * 0.9 + (dryness > 0.55 ? 0.3 : 0), x0, y0);
    }
    case MARSH: {
      // wet hollows gather where a broad wetness field is high, so they come in clusters with firmer ground between
      const pm = V.band ? V.pm * 2.2 : V.pm, thr = V.band ? 0.42 : 0.32;
      const pool = (a, b) => noise(a / pm, b / pm, 31) + 0.3 * noise(a / (pm * 0.4), b / (pm * 0.4), 32) + (V.band ? noise(a / (pm * 3), b / (pm * 3), 33) * 0.5 : 0);
      const pn = pool(wx, wz);
      if (pn > thr) {
        const up = pool(wx + V.upW[0], wz + V.upW[1]);
        if (up <= thr) return P.m0;
        if (V.band && pn - thr < 0.025) return P.w6;
        return dith(WA, (V.band ? 4.6 - Math.min(1, (pn - thr) * 5) * 2.4 : 3.3 + (pn - thr) * 2.5) + (h2(x, y, 8) < 0.04 ? 1.5 : 0), x0, y0);
      }
      if (V.band && pn > thr - 0.07) {
        // reed rim: short upright strokes around each pool
        if ((h2(x0, 0, 34) < 0.45 && h2(x0, y0 >> 1, 35) < 0.7)) return h2(x0, y0, 36) < 0.3 ? P.a1 : P.m3;
        return P.m1;
      }
      return dith(MA, (V.band ? 2.6 : 2.7) + s + (V.band ? mot * 0.4 : mot) + edge + (h2(x, y, 1) - 0.5) * (V.band ? 0.35 : 0.8), x0, y0);
    }
    default: {
      let v = 3.35 + s + mot * 1.2 + (K.moist - 0.5) * 0.8 + edge + (h2(x, y, 1) - 0.5) * 0.45;
      if (V.detail === 2 && V.band) {
        // broad lighter and darker swathes, and now and then a patch worn to bare earth
        const sw = fbm(wx / 11, wz / 11, 54, 2), bare = fbm(wx / 5, wz / 5, 55, 2);
        v += sw * 1.4;
        if (bare > 0.3 + K.grass * 0.15) return dith(DI, 3.2 + s + (bare - 0.5) * 2 + (h2(x0, y0, 56) - 0.5) * 0.8, x0, y0);
        if (bare > 0.24 + K.grass * 0.15 && h2(x0, y0, 57) < 0.5) return dith(DI, 3.4 + s, x0, y0);
      }
      if (V.detail) {
        if (h2(x, y, 2) < 0.08) v += 1.2;
        else if (h2(x, y - 1, 2) < 0.08) v -= 1.0;
        if (DENSE !== 2 && h2(x, y, 3) < K.flowers * Math.max(0, fbm(wx / (V.tileM * 1.6), wz / (V.tileM * 1.6), 52, 2) + 0.12) * (DENSE === 0 ? 2.5 : 5)) return flowerCol(wx, wz);
        // dense=2: fewer stray flowers, gathered instead into bigger drifts
        if (DENSE === 2 && h2(x, y, 3) < K.flowers * Math.max(0, fbm(wx / (V.tileM * 2.4), wz / (V.tileM * 2.4), 53, 2) - 0.05) * 16) return flowerCol(wx, wz);
      }
      if (K.wet && lev < 0.5) v -= 0.6;
      // under the woods edge the grass goes darker and strewn with leaf litter
      if (V.detail === 2 && K.tree > 0.2) {
        v -= (K.tree - 0.2) * 3.5;
        if (h2(x0, y0, 29) < (K.tree - 0.2) * 0.35) return h2(x0, y0, 30) < 0.5 ? P.d2 : P.d3;
      }
      return dith(GR, v, x0, y0);
    }
  }
}

const FALL = 1, ROCKW = 2, DIRTW = 3, SECT = 4;
function texWall(V, mat, face, x, y, depth, hpx, lev, veg, floorLev) {
  const bottom = hpx - depth < 1;
  if (mat === SECT) {
    if (bottom) return P.ink;
    if (lev > floorLev + 0.01) {
      if (depth < 1) return P.w5;
      return dith(WA, (face ? 1.6 : 2.3) + (h2(x, y, 80) - 0.5) * 0.5 + (lev - floorLev) * 0.05, x, y);
    }
    const below = (floorLev - lev) * V.lp;
    if (below < 1) return face ? P.s0 : P.s1;
    const layer = Math.floor((below + h2(x >> 2, 3, 81) * 1.5) / 4);
    const r = layer > 3 ? RK : DI;
    return dith(r, (face ? 1.5 : 2.4) + (layer & 1 ? 0.6 : 0) + (h2(x, y, 82) - 0.5) * 0.6 - (layer > 3 ? 0.4 : 0), x, y);
  }
  if (mat === FALL) {
    if (hpx - depth < 2) return h2(x, y, 72) < 0.7 ? P.w7 : P.w6;
    // falling water: bright vertical streaks that slide down a pixel a frame
    const streak = h2(x, 7, 70), run = ((y - FRAME * 2) >> 2) & 3;
    if (streak < 0.4 && run === 0) return P.w7;
    return dith(WA, 5.4 + (streak - 0.5) * 2 + (h2(x, (y - FRAME * 2) >> 1, 71) - 0.5) * 0.8 - face * 0.6, x, y);
  }
  if (veg && depth < 1) return face ? P.g2 : P.g3;
  if (veg && depth < 2 && h2(x, 0, 73) < 0.5) return face ? P.g1 : P.g2;
  if (mat === ROCKW && THEME === "adventure") {
    // crags: fissured, weathered faces with ledges of lighter stone, not coursed blocks
    const n = noise(x / 3.2, (y + lev * V.lp * 0.3) / 7, 83) + 0.5 * noise(x / 1.4, y / 3, 84);
    if (Math.abs(n) < 0.06) return P.r0;
    if (veg && depth < 1.5 && h2(x, 1, 85) < 0.6) return face ? P.g2 : P.g3;
    return dith(RK, (face ? 1.7 : 2.8) + n * 1.4 - (depth / Math.max(hpx, 1)) * 0.8 - (bottom ? 1 : 0), x, y);
  }
  if (mat === ROCKW) {
    const v = (face ? 1.9 : 3.1) + (h2(x, 11, 74) < 0.2 ? -1.1 : 0) + (Math.floor((lev * V.lp) / 4) & 1 ? 0.4 : -0.2) + (h2(x, y, 75) - 0.5) * 0.7 - (bottom ? 1 : 0);
    return dith(RK, v, x, y);
  }
  if (h2(x, y, 78) < 0.035) return face ? P.r2 : P.r3;
  const band = Math.floor((lev * V.lp) / 3 + h2(x >> 2, 0, 76) * 0.6);
  return dith(DI, (face ? 1.8 : 2.9) + (band & 1 ? 0.35 : -0.25) + (h2(x, y, 77) - 0.5) * 0.6 - (bottom ? 1 : 0), x, y);
}

function drawTerrain(B, w, V, M) {
  // M may cover far more than this buffer (the live bake builds one map per zoom); only V's tile window is drawn
  const { NI, NJ, i0, j0 } = M, C = M.C, GX = V.gx || 0, GY = V.gy || 0;
  const corner = (t, k) => C[t * 4 + k];
  const land = (i, j) => { const t = M.at(i, j); return t >= 0 && !M.kind[t]; };
  const water = (i, j) => { const t = M.at(i, j); return t >= 0 && M.kind[t] === SEA; };
  // Light per vertex: each tile's slope from its four corners, averaged over the tiles meeting at a vertex and then
  // blended across the tile, so gentle ground rolls smoothly instead of striping triangle by triangle.
  const VI = NI + 1;
  if (!M.light) M.light = vertexLight(V, M);
  const { lightV, curvV } = M.light;
  if (M.light.crease) V.crease = M.light.crease;
  // Biomes meet over two or three tiles: each pixel takes its cover from a tile a wandering, dithered step away, so a
  // meadow runs into marsh along a ragged edge instead of a seam down a tile row.
  const blend = LOCAL && THEME === "adventure", reachT = VIEW === "camp" ? 1.2 : 0.8;
  const coverOf = (K, t) => ({ ...K, cls: M.cls[t], moist: M.moist[t], heath: M.heath[t], grass: M.cov[0][t], bare: M.cov[4][t], snow: M.snow[t], tree: M.cov[1][t], toRock: M.toRock[t], flowers: 0.012 * smooth(0.3, 0.8, M.cov[0][t]) });
  const shade = (col, X, Y) => (THEME === "adventure" && DARKER[col] !== col ? (bayer(X, Y) < 0.6 ? DARKER[col] : col) : SHADOW[col]);
  // live bake: every animated water or falls pixel records its colour in all eight frames of the loop
  const anim = V.anim, frames = (p, f0, paint) => {
    const cols = [f0];
    let moving = false;
    for (let f = 1; f < 8; f++) { setMode(VIEW, f); const c = paint(); cols.push(c); if (c !== f0) moving = true; }
    setMode(VIEW, 0);
    if (moving) anim.set(p, cols);
  };
  const a0 = clamp((V.i0 ?? i0) - i0, 0, NI), a1 = clamp((V.i1 ?? i0 + NI) - i0, 0, NI), b0 = clamp((V.j0 ?? j0) - j0, 0, NJ), b1 = clamp((V.j1 ?? j0 + NJ) - j0, 0, NJ);
  for (let s = a0 + b0; s <= a1 + b1 - 2; s++)
    for (let i = Math.max(a0, s - b1 + 1); i <= Math.min(a1 - 1, s - b0); i++) {
      const j = s - i, t = j * NI + i, uT = i0 + i, vT = j0 + j, hi = V.live ? uT : i, hj = V.live ? vT : j;
      if (!V.visible(uT + 0.5, vT + 0.5)) continue;
      const c = [corner(t, 0), corner(t, 1), corner(t, 2), corner(t, 3)];
      const P4 = [[uT, vT, c[0]], [uT + 1, vT, c[1]], [uT + 1, vT + 1, c[2]], [uT, vT + 1, c[3]]];
      const tu = M.at(i + 1, j), tv = M.at(i, j + 1), bu = M.at(i - 1, j), bv = M.at(i, j - 1);
      const K = {
        kind: M.kind[t], cls: M.cls[t], surf: M.surf[t], moist: M.moist[t], heath: M.heath[t], grass: M.cov[0][t], bare: M.cov[4][t], snow: M.snow[t], tree: M.cov[1][t],
        var: (h2(hi, hj, 99) - 0.5) * (VIEW === "island" ? 0.5 : 0.25),
        flowers: 0.012 * smooth(0.3, 0.8, M.cov[0][t]),
        rimU: tu >= 0 && (corner(tu, 0) < c[1] || corner(tu, 3) < c[2]),
        rimV: tv >= 0 && (corner(tv, 0) < c[3] || corner(tv, 1) < c[2]),
        aoU: bu >= 0 && (corner(bu, 1) > c[0] || corner(bu, 2) > c[3]),
        aoV: bv >= 0 && (corner(bv, 3) > c[0] || corner(bv, 2) > c[1]),
        wet: water(i - 1, j) || water(i + 1, j) || water(i, j - 1) || water(i, j + 1),
        ln: 0, ox: V.sx(uT, vT) + GX - Math.floor(h2(hi, hj, 7) * 3) * 37, oy: V.sy(uT, vT, 0) + GY, sc: null,
        toSea: M.toSea[t], toRock: M.toRock[t], head: M.head[t], flat: c[0] === c[1] && c[1] === c[2] && c[2] === c[3],
        L: [lightV[j * VI + i], lightV[j * VI + i + 1], lightV[(j + 1) * VI + i + 1], lightV[(j + 1) * VI + i]],
        Q: curvV && [curvV[j * VI + i], curvV[j * VI + i + 1], curvV[(j + 1) * VI + i + 1], curvV[(j + 1) * VI + i]],
      };
      if (K.kind) {
        [[-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [1, -1], [-1, 1], [1, 1]].forEach(([a, b], q) => { if (land(i + a, j + b)) K.ln |= 1 << q; });
        // shore distance at the tile's four corners (top, right, bottom, left), each the mean of the tiles meeting there
        const sd = (a, b) => { const k = M.at(a, b); return k < 0 ? 9 : M.shore[k]; };
        const cn = (a, b) => (sd(a - 1, b - 1) + sd(a, b - 1) + sd(a - 1, b) + sd(a, b)) / 4 - 0.5;
        K.sc = [cn(i, j), cn(i + 1, j), cn(i + 1, j + 1), cn(i, j + 1)];
      }
      // cliff strips on the two faces that look at the camera
      for (const face of [0, 1]) {
        const nb = face ? tu : tv;
        const [A, Bk] = face ? [2, 1] : [3, 2]; // this tile's corners along the edge, left to right on screen
        const nA = face ? 3 : 0, nB = face ? 0 : 1; // the neighbour's matching corners
        let botA, botB, mat, floorA = 0, floorB = 0;
        if (nb >= 0) {
          botA = corner(nb, nA); botB = corner(nb, nB);
          if (botA >= c[A] && botB >= c[Bk]) continue;
          const drop = Math.max(c[A] - botA, c[Bk] - botB);
          mat = M.kind[t] && M.kind[nb] ? FALL : K.cls === ROCK || K.head === 2 || drop >= 6 || (K.cls === HILL && drop >= 5) ? ROCKW : DIRTW;
          if (mat === FALL && V.falls) { const pa = P4[A], pb = P4[Bk]; V.falls.push({ x0: V.sx(pa[0], pa[1]), x1: V.sx(pb[0], pb[1]), y: (V.sy(pa[0], pa[1], botA) + V.sy(pb[0], pb[1], botB)) / 2, drop: drop * V.lp }); }
        } else if (VIEW === "island" && !V.live) {
          botA = botB = V.base; mat = SECT;
          const fl = (u, v) => { const [x, z] = V.toW(u, v); return clamp(Math.round(V.hsample(x, z) / V.levelM), V.base + 2, 0); };
          floorA = M.kind[t] ? fl(P4[A][0], P4[A][1]) : c[A]; floorB = M.kind[t] ? fl(P4[Bk][0], P4[Bk][1]) : c[Bk];
        } else continue;
        const pa = P4[A], pb = P4[Bk];
        const veg = !M.kind[t] && K.cls !== ROCK && K.cls !== SAND;
        strip(B, V.sx(pa[0], pa[1]), V.sx(pb[0], pb[1]), V.sy(pa[0], pa[1], pa[2]), V.sy(pb[0], pb[1], pb[2]), V.sy(pa[0], pa[1], botA), V.sy(pb[0], pb[1], botB), (p, x, y, tt, depth, hpx) => {
          const u = pa[0] + (pb[0] - pa[0]) * tt, v = pa[1] + (pb[1] - pa[1]) * tt;
          const lev = (V.Y0 + (u + v) * V.H * 0.5 - (y + 0.5)) / V.lp;
          const paint = () => texWall(V, mat, face ? 1 : 0, x + GX, y + GY, depth, hpx, lev, veg, floorA + (floorB - floorA) * tt);
          B.c[p] = paint();
          if (anim && mat === FALL) frames(p, B.c[p], paint);
          B.z[p] = V.cz(u, v, lev); B.id[p] = 0;
        });
      }
      const tris = M.diag[t] === 0 ? [[0, 1, 2], [0, 2, 3]] : [[0, 1, 3], [3, 1, 2]];
      for (const [a, b, cc] of tris) {
        const A = P4[a], Bv = P4[b], Cv = P4[cc];
        const e1 = [Bv[0] - A[0], Bv[1] - A[1], Bv[2] - A[2]], e2 = [Cv[0] - A[0], Cv[1] - A[1], Cv[2] - A[2]];
        const det = e1[0] * e2[1] - e1[1] * e2[0];
        const du = (e1[2] * e2[1] - e1[1] * e2[2]) / det, dv = (e1[0] * e2[2] - e1[2] * e2[0]) / det;
        const sTri = K.kind ? 0 : Math.round(clamp(V.gain * (-LU * du - LV * dv), -2, 2) * 2) / 2, smoothL = THEME === "adventure" && !K.kind;
        tri(B, V.sx(A[0], A[1]), V.sy(A[0], A[1], A[2]), V.sx(Bv[0], Bv[1]), V.sy(Bv[0], Bv[1], Bv[2]), V.sx(Cv[0], Cv[1]), V.sy(Cv[0], Cv[1], Cv[2]), (p, x, y, la, lb, lc) => {
          const X = x + GX, Y = y + GY;
          const u = la * A[0] + lb * Bv[0] + lc * Cv[0], v = la * A[1] + lb * Bv[1] + lc * Cv[1], lev = la * A[2] + lb * Bv[2] + lc * Cv[2];
          const wx = V.ox + (u * V.eu[0] + v * V.ev[0]) * V.tileM, wz = V.oz + (u * V.eu[1] + v * V.ev[1]) * V.tileM;
          const fu = u - uT, fv = v - vT, L = K.L;
          let Kp = K;
          if (blend && !K.kind && K.head !== 2) {
            const ms = V.tileM * 1.3, du = fbm(wx / ms, wz / ms, 64, 2) * reachT + (h2(X, Y, 65) - 0.5) * 0.45, dv = fbm(wx / ms, wz / ms, 66, 2) * reachT + (h2(X, Y, 67) - 0.5) * 0.45;
            const t2 = M.at(Math.floor(u + du) - i0, Math.floor(v + dv) - j0);
            if (t2 >= 0 && t2 !== t && !M.kind[t2] && M.cls[t2] !== K.cls && M.head[t2] !== 2) Kp = (K.alt ??= new Map()).get(t2) ?? K.alt.set(t2, coverOf(K, t2)).get(t2);
          }
          const s = smoothL ? (L[0] * (1 - fu) + L[1] * fu) * (1 - fv) + (L[3] * (1 - fu) + L[2] * fu) * fv : sTri;
          let col = texTop(w, V, Kp, X, Y, wx, wz, lev, s, fu, fv);
          if (V.mist) { const m = V.mist(wx, wz, K.kind, Kp, fu, fv, y); if (m < 0) B.mistW[p] = -m; else B.mist[p] = m; }
          // cast shadows are sampled per tile, which on smooth rock would print tile squares
          // the sample point jitters a little per pixel so a shadow's edge dithers instead of following tile steps
          const ju = (h2(X, Y, 98) - 0.5) * 0.7, jv = (h2(X, Y, 99) - 0.5) * 0.7;
          const dark = V.shaded && !(VIEW === "peak" && Kp.cls === ROCK) && V.shaded(u + ju, v + jv, lev);
          if (dark) { col = shade(col, X, Y); B.sh[p] = 1; }
          B.c[p] = col; B.z[p] = V.cz(u, v, lev); B.id[p] = 0;
          if (anim && K.kind) frames(p, col, () => { const c2 = texTop(w, V, Kp, X, Y, wx, wz, lev, s, fu, fv); return dark ? shade(c2, X, Y) : c2; });
        });
      }
    }
}

// Light per vertex: each tile's slope from its four corners, averaged over the tiles meeting at a vertex and then
// blended across the tile, so gentle ground rolls smoothly instead of striping triangle by triangle.
function vertexLight(V, M) {
  const { NI, NJ, i0, j0 } = M, C = M.C, VI = NI + 1, lightV = new Float32Array(VI * (NJ + 1)), nV = new Uint8Array(VI * (NJ + 1));
  for (let t = 0; t < NI * NJ; t++) {
    if (M.kind[t]) continue;
    const i = t % NI, j = (t / NI) | 0, c = C.subarray(t * 4, t * 4 + 4);
    const gu = (c[1] - c[0] + c[2] - c[3]) / 2, gv = (c[3] - c[0] + c[2] - c[1]) / 2, l = V.gain * (-LU * gu - LV * gv);
    for (const k of [j * VI + i, j * VI + i + 1, (j + 1) * VI + i, (j + 1) * VI + i + 1]) { lightV[k] += l; nV[k]++; }
  }
  const shadeFloor = VIEW === "coast" ? -0.7 : VIEW === "peak" ? -2 : -1.2;
  for (let k = 0; k < lightV.length; k++) { const l = nV[k] ? lightV[k] / nV[k] : 0; lightV[k] = clamp(l < 0 ? l * 0.6 : l, shadeFloor, 2); }
  // On the peak, facing comes from the true ground blurred over about three tiles, so lit and shaded planes follow
  // the ridges and gullies rather than tile columns; curvature marks where ridge and gully cracks may run.
  let curvV = null, crease = 0;
  if (VIEW === "peak" || (V.live && LOCAL)) {
    const NV = NJ + 1, hv = new Float32Array(VI * NV), tmp = new Float32Array(VI * NV);
    for (let j = 0; j < NV; j++) for (let i = 0; i < VI; i++) hv[j * VI + i] = V.hsample(...V.toW(i0 + i, j0 + j)) / V.levelM;
    const blur = (src, dst, di, dj) => {
      for (let j = 0; j < NV; j++) for (let i = 0; i < VI; i++) {
        let a = 0, n = 0;
        for (let r = -1; r <= 1; r++) { const ii = i + r * di, jj = j + r * dj; if (ii >= 0 && jj >= 0 && ii < VI && jj < NV) { a += src[jj * VI + ii]; n++; } }
        dst[j * VI + i] = a / n;
      }
    };
    for (let pass = 0; pass < 2; pass++) { blur(hv, tmp, 1, 0); blur(tmp, hv, 0, 1); }
    const H = (i, j) => hv[clamp(j, 0, NV - 1) * VI + clamp(i, 0, VI - 1)];
    curvV = new Float32Array(VI * NV);
    for (let j = 0; j < NV; j++) for (let i = 0; i < VI; i++) {
      const gu = (H(i + 1, j) - H(i - 1, j)) / 2, gv = (H(i, j + 1) - H(i, j - 1)) / 2, l = V.gain * (-LU * gu - LV * gv);
      lightV[j * VI + i] = clamp(l < 0 ? l * 0.6 : l, shadeFloor, 2);
      curvV[j * VI + i] = (H(i + 1, j) + H(i - 1, j) + H(i, j + 1) + H(i, j - 1)) / 4 - H(i, j);
    }
    // only the sharpest tenth of creases count, whatever the seed's relief
    const mag = Float32Array.from(curvV, Math.abs).sort();
    crease = V.live ? 0.12 : Math.max(0.05, mag[Math.floor(mag.length * 0.9)]);
  }
  return { lightV, curvV, crease };
}

// ---------- live: a fixed camera over the whole island, baked in chunks ----------
export { LADDER };
// One vertical exaggeration for every zoom and bearing, so a mountain has the same shape at each. 1.2 keeps the drawn
// 99th percentile slope under 40 degrees at the generator's 75 m cells (true p99 34.4 degrees, seed 1); 1.5 trades a
// little of that for more mountain. ?exag= overrides it once at load, in the page and in the bake workers alike.
export const EXAG = (() => { const q = Number(new URLSearchParams(globalThis.location?.search ?? "").get("exag")); return q ? clamp(q, 1, 3) : 1.5; })();
// hillshade gain on the true slope, strong enough that eroded ridges and valleys read at the low exaggeration
const LIGHT = 4.4;
export const BEARINGS = 8;
export const ORIGIN = -SIZE / 2;

// Bearing b turns the camera b * 45 degrees clockwise: tile axes eu, ev are the world axes turned by -b * 45 degrees,
// from an origin that keeps the whole island at u, v >= 0. At b = 0, +x runs down-right and +z down-left like the sim.
export function bearingFrame(b) {
  const a = (b * Math.PI) / 4, c = Math.cos(a), sn = Math.sin(a), R = (SIZE / 2) * (Math.abs(c) + Math.abs(sn));
  const eu = [c, sn], ev = [-sn, c];
  return { eu, ev, ox: -R * (eu[0] + ev[0]), oz: -R * (eu[1] + ev[1]), span: 2 * R };
}
export function makeLiveView(w, level, bearing = 0) {
  const Zl = LADDER[level];
  setMode("valley", 0);
  const V = { ...CFG.valley, ...Zl, view: "valley", level, bearing, live: true, name: VIEW, AW: 0, AH: 0, gx: 0, gy: 0, X0: 0, Y0: 0, exag: EXAG, grid: 0 };
  // sprites grow a little slower than the world as you zoom in, the same curve at every level so sizes run smoothly
  V.treeK = 1.15 * (Zl.W / 2 / Zl.tileM / 0.8533) ** -0.15;
  V.H = V.W / 2;
  if (LOWSUN) V.tsun = SUN * 0.75;
  if (THEME === "adventure") V.band = VIEW === "island" ? 1.3 : 1.9;
  V.marks = []; V.falls = null; V.rings = []; V.drifts = []; V.campOff = 1;
  const F = bearingFrame(bearing);
  V.eu = F.eu; V.ev = F.ev; V.ox = F.ox; V.oz = F.oz;
  V.scale = (tileM) => { V.tileM = tileM; V.k = V.W / (tileM * Math.SQRT2); V.levelM = V.lp / (V.k * 0.866 * V.exag); };
  V.toUV = (x, z) => { const dx = x - V.ox, dz = z - V.oz; return [(dx * V.eu[0] + dz * V.eu[1]) / V.tileM, (dx * V.ev[0] + dz * V.ev[1]) / V.tileM]; };
  V.toW = (u, v) => [V.ox + (u * V.eu[0] + v * V.ev[0]) * V.tileM, V.oz + (u * V.eu[1] + v * V.ev[1]) * V.tileM];
  V.sx = (u, v) => V.X0 + (u - v) * V.H;
  V.sy = (u, v, hz) => V.Y0 + (u + v) * V.H * 0.5 - hz * V.lp;
  V.cz = (u, v, hz) => 1.5 * V.H * (u + v) + hz * V.lp;
  V.hsample = (x, z) => w.heightAt(x, z);
  if (VIEW === "island") {
    const lim = w.SIZE / 2 - 60;
    V.hsample = (x, z) => Math.abs(x) > lim || Math.abs(z) > lim ? -60 : (w.heightAt(x, z) * 2 + w.heightAt(x + 45, z) + w.heightAt(x - 45, z) + w.heightAt(x, z + 45) + w.heightAt(x, z - 45)) / 6;
  }
  // exaggeration is fixed per level (island-wide slopes gave 1 for every local level), stepping down from the
  // island map's so neighbouring levels agree when they cross-fade
  V.scale(V.tileM);
  const NT = Math.ceil(F.span / V.tileM);
  let peak = 0;
  for (const h of w.isle.height) peak = Math.max(peak, h);
  V.peakLev = Math.ceil((peak + 10) / V.levelM);
  V.peakM = peak; V.capH = peak * 0.68;
  V.mpp = 1 / V.k;
  V.i0 = 0; V.j0 = 0; V.i1 = NT; V.j1 = NT; V.NI = NT; V.NJ = NT;
  V.visible = () => true; V.objVisible = () => true;
  V.ms = V.tileM * (VIEW === "island" ? 3 : 2.6);
  V.pm = V.tileM * 0.9;
  V.rip = 3;
  const dd = -1 / V.H;
  V.upW = [(dd * V.eu[0] + dd * V.ev[0]) * V.tileM, (dd * V.eu[1] + dd * V.ev[1]) * V.tileM];
  const cot = 1 / Math.tan(SUN), sd = [-LU / Math.hypot(LU, LV), -LV / Math.hypot(LU, LV)];
  V.shx = (sd[0] - sd[1]) * 0.8165 * cot;
  V.shy = (sd[0] + sd[1]) * 0.5 * 0.8165 * cot;
  V.sd = sd; V.cot = cot;
  return V;
}

// Point V at one chunk of global art pixels [gx0, gx0 + CS) x [gy0, gy0 + CS). Objects are gathered from a wider
// window: tall sprites standing below the chunk, and sprites to its left whose shadows fall into it.
export function chunkWindow(V, maxLev, gx0, gy0, CS, tall, shadowL) {
  V.X0 = -gx0; V.Y0 = -gy0; V.gx = gx0; V.gy = gy0; V.AW = CS; V.AH = CS;
  const hb = V.H * 0.5;
  const amin = -V.X0 / V.H - 2, amax = (CS - V.X0) / V.H + 2;
  const bmin = -V.Y0 / hb - 3, bmax = (CS - V.Y0 + maxLev * V.lp) / hb + 3;
  const oa0 = amin - shadowL / V.H, ob0 = bmin - (shadowL * 0.4) / hb, ob1 = bmax + tall / hb;
  V.i0 = Math.floor((amin + bmin) / 2); V.i1 = Math.ceil((amax + bmax) / 2);
  V.j0 = Math.floor((bmin - amax) / 2); V.j1 = Math.ceil((bmax - amin) / 2);
  V.visible = (u, v) => { const a = u - v, b = u + v; return a >= amin - 1 && a <= amax + 1 && b >= bmin && b <= bmax; };
  V.objVisible = (u, v) => { const a = u - v, b = u + v; return a >= oa0 && a <= amax + 1 && b >= ob0 && b <= ob1; };
  V.obox = [Math.floor((oa0 + ob0) / 2), Math.ceil((amax + 1 + ob1) / 2), Math.floor((ob0 - amax - 1) / 2), Math.ceil((ob1 - oa0) / 2)];
}

// How high the ground below a chunk climbs into it, in levels: tiles further down the screen whose hills rise into
// view. Scanned from the true heights, so a paged level can size its map before building it.
export function liftInto(w, V, gy0, gx0, CS) {
  const hb = V.H * 0.5, b0 = (CS + gy0) / hb + 3, amin = gx0 / V.H - 2, amax = (gx0 + CS) / V.H + 2;
  let need = 0;
  for (let b = Math.floor(b0); (b - b0) * hb <= V.peakLev * V.lp; b++)
    for (let a = Math.floor(amin); a <= amax; a += 2) {
      const u = (a + b) / 2, v = (b - a) / 2, lev = w.heightAt(...V.toW(u, v)) / V.levelM;
      if (lev * V.lp + 2 * V.lp >= (b - b0) * hb) need = Math.max(need, lev + 2);
    }
  return Math.ceil(need);
}

// Terrain shadow as a horizon per vertex: the lowest level a point there must stand at to see the sun. One march per
// vertex when the map is built, instead of one per pixel.
export function shadowHorizon(V, M) {
  const rise = (Math.tan(V.tsun) * V.tileM) / (V.lp / (V.k * 0.866)), step = 0.3, su = -V.sd[0] * step, sv = -V.sd[1] * step;
  const { NI, NJ, C, diag } = M, VI = NI + 1, hz = new Float32Array(VI * (NJ + 1)), top = M.maxLev;
  const lev = (u, v) => {
    const i = Math.floor(u), j = Math.floor(v);
    if (i < 0 || j < 0 || i >= NI || j >= NJ) return -1e9;
    const t = j * NI + i, fu = u - i, fv = v - j, T = C[t * 4], R = C[t * 4 + 1], B = C[t * 4 + 2], L = C[t * 4 + 3];
    if (diag[t] === 0) return fu >= fv ? T + (R - T) * fu + (B - R) * fv : T + (B - L) * fu + (L - T) * fv;
    return fu + fv <= 1 ? T + (R - T) * fu + (L - T) * fv : R + L - B + (B - L) * fu + (B - R) * fv;
  };
  for (let j = 0; j <= NJ; j++)
    for (let i = 0; i <= NI; i++) {
      let best = -1e9, cu = i, cv = j;
      for (let k = 1; k < 80; k++) {
        cu += su; cv += sv;
        const drop = rise * step * k;
        if (top - drop <= best) break;
        const g = lev(cu, cv);
        if (g === -1e9) break;
        if (g - drop > best) best = g - drop;
      }
      hz[j * VI + i] = best;
    }
  return (u, v, l) => {
    const x = clamp(u - M.i0, 0, NI - 0.001), y = clamp(v - M.j0, 0, NJ - 0.001), i = Math.floor(x), j = Math.floor(y), fx = x - i, fy = y - j, k = j * VI + i;
    const h = (hz[k] * (1 - fx) + hz[k + 1] * fx) * (1 - fy) + (hz[k + VI] * (1 - fx) + hz[k + VI + 1] * fx) * fy;
    return l < h - 0.05;
  };
}

// The sim's objects for one live chunk, from D.objs (an ObjBins of sim.objects() and its changes since). Each is drawn
// wherever it is at least one art pixel, at its size in meters times the level's art px per meter, so it keeps its
// world position at every zoom and grows smoothly from a dot to its full sprite. D.trodden gives the worn paths.
export function collectLive(w, V, M, D) {
  const O = [], ob = D.objs;
  if (!ob) return O;
  // footprint sprites anchor below their footprint centre
  const add = (at, spr, opt = {}) => O.push({ z: at.z, sx: at.sx, sy: at.sy + (spr.foot || 0), spr, shadow: opt.shadow !== false, mirror: !!opt.mirror, bias: opt.bias ?? V.H * 0.5 + 2, oid: opt.oid, ax: at.sx, ay: at.sy });
  // art px per meter up (heights) and across (a tussock's width); a level coarser than DIRECT_PV draws its trees shrunk
  const pv = V.k * 0.866 * V.treeK, pw = V.k * V.treeK, visW = (x, z) => V.objVisible(...V.toUV(x, z)), shrunk = pv < SP.DIRECT_PV;
  // a canopy takes the value of the ground it stands on, so the forest reads as texture over the hillshade: lit slopes
  // bright, shaded slopes and cast shadows dark
  const cov = (x, z) => w.fine(w.cover.tree, x, z);
  const dimAt = (x, z) => Math.round(clamp(0.05 - terrainLight(w, V, x, z) * 0.75, -0.75, 1) * 4) / 4;
  const [u0, u1, v0, v1] = V.obox, cs = [V.toW(u0, v0), V.toW(u1, v0), V.toW(u0, v1), V.toW(u1, v1)], xs = cs.map((c) => c[0]), zs = cs.map((c) => c[1]);
  const tile = (m) => Math.floor((m - ORIGIN) / TILE_M), kinds = ob.kinds, spn = ob.species, skip = kinds.map((k) => ObjBins.LIVE.has(k));
  ob.each(tile(Math.min(...xs)), tile(Math.min(...zs)), tile(Math.max(...xs)), tile(Math.max(...zs)), (ki, si, px, py, size, seed, id, n) => {
    if (skip[ki]) return;
    const K = kinds[ki], hpx = K === "grass" ? size * pw : ObjBins.shown(size) * pv;
    if (hpx < 1) return;
    const x = px * TILE_M + ORIGIN, z = py * TILE_M + ORIGIN;
    if (!visW(x, z)) return;
    // drawn wherever the sim holds it, so what is drawn and what can be picked always agree
    const sp = spn[si], at = place(V, M, x, z);
    if (!at) return;
    const mirror = ((seed >>> 3) & 1) === 1, vr = seed % 8, tint = ((seed >>> 8) & 255) / 255;
    let spr;
    if (K === "tree") {
      // one drawing at every zoom (sprites.js tree); the terrain's light only sets how dark the wood is at its foot
      const hp = Math.max(1, Math.round(hpx)), dim = dimAt(x, z), tq = SP.treeTint(tint, sp);
      spr = cached(`tr${sp}|${hp}|${vr}|${tq}|${dim}|${shrunk ? 1 : 0}`, () => SP.tree(hp, sp, vr, tq, dim, shrunk));
    } else if (!TH.object) return;
    else {
      const hq = hpx < 8 ? Math.round(hpx * 2) / 2 : Math.round(hpx), moss = K === "boulder" || K === "stone" ? (cov(x, z) > 0.4 ? 0.6 : 0.1) : 0;
      const o = n === undefined ? { species: sp, moss } : { species: sp, moss, n };
      spr = cached(`o${K}|${sp}|${hq}|${vr}|${moss}|${n === undefined ? "" : n > 0}`, () => TH.object(K, hq, vr * 131 + 7, o));
    }
    // a continuous canopy of minis casting shadows would darken the whole forest; trees cast theirs once they stand apart
    if (spr) add(at, spr, { mirror, shadow: (K === "tree" ? hpx >= 8 : hpx >= 3) && !FLAT.has(K), oid: id });
  });
  return O;
}
const FLAT = new Set(["clay", "stick", "pebble", "flowers", "herb", "mushroom"]);


// ---------- live terrain: every feature from world-space fields in meters ----------
// Only the dither pattern belongs to a level: biome edges, pools, bare patches, shores and rivers are sampled from
// the world at each pixel, so they line up exactly at every zoom and bearing.
const G = {};
// Every ground fact at a world point comes from the generator's shared rule (flora.ts groundClass), the one the sim's
// inspector uses too, so the drawn class and the inspected one never disagree; only shore distance and depth are added.
function groundAt(w, V, x, z) {
  const r = groundClass(w.isle, w, x, z);
  G.water = r.water === G_SEA ? SEA : r.water === G_LAKE ? LAKE : r.water === G_RIVER ? RIVER : 0;
  G.x = x; G.z = z;
  if (G.water) {
    // distance to the shore in meters, from the field's value and slope near its 0.5 contour
    const f = G.water === RIVER ? (a, b) => riverSmooth(w, a, b) : (a, b) => waterAt(w.isle, w, a, b), v = G.water === RIVER ? r.river : r.wet;
    const gx = (f(x + 3, z) - f(x - 3, z)) / 6, gz = (f(x, z + 3) - f(x, z - 3)) / 6, gl = Math.hypot(gx, gz);
    G.shore = gl > 1e-4 ? (v - 0.5) / gl : 60;
    G.depth = G.water === SEA ? Math.max(0, -w.heightAt(x, z)) : G.water === LAKE ? w.bilinear(w.isle.water, (x - w.START) / w.CELL, (z - w.START) / w.CELL) : 1.5;
    G.bed = 0;
    if (G.water === RIVER) {
      // the channel is cut to the wettest season's width; this season's water runs down the middle of it, or not at all
      // (the season's runoff, with the rain of an ordinary few days, src/sim/streams.ts)
      const st = streamAt(w, x, z), q = st ? flowNow(st.q, st.base, w.isle.quick[SEASON_I[V.season] ?? 0] * 1.2) : 0;
      G.depth = depthOf(q);
      G.bed = !st || q < TRICKLE || st.d > widthOf(q) / 2 ? 1 : 0;
    }
    return G;
  }
  for (let q = 0; q < 6; q++) G["c" + q] = r.cover[q];
  G.cls = r.cls === G_ROCKY ? ROCKY : r.cls;
  G.h = w.heightAt(x, z); G.moist = w.fine(w.moist, x, z); G.ex = r.exposure;
  // the generator's share of the year's precipitation falling as snow: only its highest reaches keep patches of it
  G.snowNow = snowLying(w, V, x, z);
  G.snow = 0.6 * G.snowNow;
  G.nearWet = r.wet > 0.2 || r.river > 0.2;
  // the generator's climate and soil at this point, for the ground's colour: summer rain against evaporation and a
  // water table near the surface make grass lush, peat darkens marsh, soil and silt tint bare ground
  const I = w.isle, cx = (x - w.START) / w.CELL, cy = (z - w.START) / w.CELL, b = (f) => w.bilinear(f, cx, cy), S1 = I.seasons[1];
  const bal = (b(S1.precip) - b(S1.pet)) / Math.max(1, b(S1.pet)), table = b(I.table);
  G.lush = Math.max(smooth(-0.3, 0.3, bal), Math.exp(-table / 2.5));
  G.peat = b(I.peat); G.soil = b(I.soil); G.silt = b(I.silt); G.fog = b(I.fog);
  G.rock = I.rock[clamp(Math.round(cy), 0, w.N - 1) * w.N + clamp(Math.round(cx), 0, w.N - 1)];
  return G;
}
// Pixel-art ground at every zoom, the mipmap way: detail lives in world meters at a few scales, each scale fades out
// once a pixel is wider than it, so the far colour is the mean of the close texture. Tones are picked with a narrow
// ordered-dither band, so light and mottling step through the palette instead of ramping smoothly.
const fade = (S, mpp) => 1 - smooth(S * 0.45, S * 1.4, mpp);
function tone(r, v, X, Y) { return r[clamp(Math.floor(v + 0.5 + (bayer(X, Y) - 0.5) * 0.55), 0, r.length - 1)]; }
// a cluster pattern of size S meters: +1, 0 or -1 with even odds of the two, so it adds texture without shifting the mean
function clusters(x, z, S, seed, mpp, cut = 0.42) {
  const a = fade(S, mpp);
  if (a <= 0) return 0;
  const n = noise(x / S, z / S, seed) * a;
  return n > cut ? 1 : n < -cut ? -1 : 0;
}
// What paintWater last painted, for the bake: its tone on the water ramp (-1 for foam, a ripple dash, a sparkle or ice),
// and whether any frame of the loop could paint it otherwise, so still water is painted once rather than eight times.
export const WV = { v: -1, moves: false };
function paintWater(w, V, g, X, Y) {
  WV.v = -1; WV.moves = false;
  // a stream's bed where no water runs this season: gravel and cobbles the floods left
  if (g.bed) return h2(X, Y, 44) < 0.08 * fade(0.4, V.mpp) ? P.d5 : tone(DI, 3.6 + clusters(g.x, g.z, 0.8, 45, V.mpp, 0.45) * 0.8, X, Y);
  if (V.iceAt && g.water !== SEA && V.iceAt(g.x, g.z)) return iceTex(X, Y, g.x, g.z);
  const px = g.shore * V.k, lap = 0.5 + 0.18 * Math.sin(PH + (g.x + g.z) / 25);
  // the foam's edge laps in and out, lap between 0.32 and 0.68
  WV.moves = px < 2.2 * 0.68 + 0.3;
  if (px < 1.2 * lap + 0.3) return P.w7;
  if (px < 2.2 * lap + 0.3 && h2(X, Y, 45) < 0.45) return P.w6;
  let v;
  if (g.water === RIVER) v = 4.2 + clusters(g.x, g.z, 1.5, 46, V.mpp) * 0.6 + (g.shore < 1.5 ? 0.5 : 0);
  else {
    // a narrow band of shallows along the shore in meters, then open water by depth
    const shallow = Math.max((1 - smooth(0, 2.5, g.depth)) * 0.8, 1 - smooth(0, 12, g.shore)) * (0.6 + 0.4 * (1 - smooth(0, 9, g.depth)));
    v = 1.4 + 3.9 * shallow + Math.round(fbm(g.x / 90, g.z / 90, 41, 2) * 1.5) * 0.4 + clusters(g.x, g.z, 3, 42, V.mpp, 0.5) * 0.5;
  }
  // ripple dashes, 2 or 3 px on every other row, and sparkles: the level's own dither, each shown in some frames only
  if ((Y & 1) === 0) {
    const sx = X + (Y >> 1) * 3, cell = Math.floor(sx / 6), r = h2(cell, Y, 47), near = 1 - smooth(0, 40, g.shore);
    const rate = 0.012 + 0.1 * near + 0.03, life = ((FRAME + Math.floor(h2(cell, Y, 48) * 8)) & 7) < 5;
    if (r < rate && sx - cell * 6 < 2 + ((r * 97) & 1)) { WV.moves = true; if (life) return r < rate * 0.3 ? P.w7 : WA[Math.min(WA.length - 2, Math.floor(v) + 2)]; }
  }
  if (h2(X, Y, 43) < 0.0006) { WV.moves = true; if (((FRAME + (h2(X, Y, 49) * 8)) | 0) & 7) return P.w7; }
  WV.v = v;
  return tone(WA, v, X, Y);
}
// bare rock, the shared rule's code for it
const ROCKY = 7;
// What a ground point is, for the consistency check: a water kind (40 + SEA, LAKE, RIVER) or its land class.
export function surfaceAt(w, V, x, z) {
  const g = groundAt(w, V, x, z);
  return g.water ? 40 + g.water : g.cls;
}
const TRACE = { cls: 0 };
// Worn footpaths from the sim's 3 m wear cells, stepped into five widths (T maps a worn cell's row-major index to 1..4).
// Each worn cell's centre is jittered inside it and joined to its worn neighbours, so a path wiggles through the grass
// and widens with use.
const TC = 3, TN = Math.round(SIZE / TC), HALF = [0, 0.45, 0.6, 0.78, 1];
const tcx = (i, j) => (i + 0.5 + (h2(i, j, 521) - 0.5) * 0.7) * TC + ORIGIN, tcz = (i, j) => (j + 0.5 + (h2(i, j, 522) - 0.5) * 0.7) * TC + ORIGIN;
function trailDist(T, x, z) {
  const i = Math.floor((x - ORIGIN) / TC), j = Math.floor((z - ORIGIN) / TC);
  // where three or four of the cells round a point are worn it is trodden ground, not a braid of paths with grass between
  const ci = Math.floor((x - ORIGIN) / TC - 0.5), cj = Math.floor((z - ORIGIN) / TC - 0.5);
  if (ci >= 0 && cj >= 0 && ci < TN - 1 && cj < TN - 1) { const k = cj * TN + ci; if (T.has(k) + T.has(k + 1) + T.has(k + TN) + T.has(k + TN + 1) >= 3) return -0.3; }
  let best = Infinity;
  for (let b = j - 1; b <= j + 1; b++)
    for (let a = i - 1; a <= i + 1; a++) {
      if (a < 1 || b < 1 || a >= TN - 1 || b >= TN - 1) continue;
      const q = T.get(b * TN + a);
      if (!q) continue;
      const ax = tcx(a, b), az = tcz(a, b);
      best = Math.min(best, Math.hypot(x - ax, z - az) - HALF[q]);
      for (let db = -1; db <= 1; db++)
        for (let da = -1; da <= 1; da++) {
          const q2 = (da || db) && T.get((b + db) * TN + a + da);
          if (!q2) continue;
          const bx = tcx(a + da, b + db), bz = tcz(a + da, b + db), dx = bx - ax, dz = bz - az;
          const t = clamp(((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz), 0, 1);
          best = Math.min(best, Math.hypot(x - ax - dx * t, z - az - dz * t) - (HALF[q] + (HALF[q2] - HALF[q]) * t));
        }
    }
  return best;
}
// whether a worn cell lies within the reach of trailDist from a point's wobbled position (the wobble stays under a cell,
// and trailDist reads cells up to 2 beyond it), so the wobble's noise is paid only near a path; kept for the last 3 m
// cell, as neighbouring pixels share one, and dropped at every bake since the wear changes between bakes
let nearI = NaN, nearJ = NaN, nearAny = false;
function trailNear(T, x, z) {
  const i = Math.floor((x - ORIGIN) / TC), j = Math.floor((z - ORIGIN) / TC);
  if (i === nearI && j === nearJ) return nearAny;
  nearI = i; nearJ = j; nearAny = false;
  for (let b = Math.max(0, j - 3); b <= Math.min(TN - 1, j + 3) && !nearAny; b++)
    for (let a = Math.max(0, i - 3); a <= Math.min(TN - 1, i + 3); a++) if (T.has(b * TN + a)) { nearAny = true; break; }
  return nearAny;
}
// on a path at this point: a rough edge up close; far out, where a pixel is wider than the path, a dither in
// proportion to the share of the pixel the path covers, so the far colour is the close one's mean
function onTrail(T, x, z, mpp, X, Y) {
  const wx = x + fbm(x / 9, z / 9, 523, 2) * 0.8, wz = z + fbm(x / 9, z / 9, 524, 2) * 0.8, d = trailDist(T, wx, wz);
  if (mpp < 1) return d + noise(x / 0.45, z / 0.45, 525) * 0.18 * fade(0.45, mpp) < 0;
  const r = mpp * 0.5;
  return d < r && bayer(X, Y) < Math.min(1, 1.6 / mpp) * (1 - Math.max(0, d) / r) * 1.5;
}
// How much of the ground snow covers this season at a world point: the generator's mean snowpack for the season (mm of
// water), a thin cover from a few millimetres and whole by thirty.
const SEASON_I = { spring: 0, summer: 1, autumn: 2, winter: 3 };
function snowLying(w, V, x, z) {
  const pack = w.isle.seasons[SEASON_I[V.season] ?? 0].snowpack;
  return smooth(3, 30, w.bilinear(pack, (x - w.START) / w.CELL, (z - w.START) / w.CELL));
}
// ---------- ground colour from the generator's continuous fields ----------
// Each cover share contributes its own paint, the way the generator's own map blends them, so woods fade into grass
// and grass into heath without a hard class edge; then light, mottle and texture in world meters; then the palette.
const C_LUSH = [56, 96, 48], C_MID = [98, 126, 60], C_STRAW = [160, 150, 90], C_TREE = [38, 68, 44], C_HEATH = [112, 86, 96];
const C_MARSH = [74, 94, 56], C_PEAT = [48, 50, 38], C_BARE = [146, 136, 116], C_SOIL = [126, 98, 70], C_SILT = [186, 168, 128], C_SAND = [220, 202, 150];
const C_BURN = [152, 128, 84], C_FOG = [140, 162, 152], C_AUTUMN = [178, 138, 64], C_WINTER = [150, 150, 142];
// bare ground takes the colour of the rock it weathered from (src/terrain/geology.ts ROCKS): grey-brown mudstone, ochre
// sandstone, pale limestone, pinkish granite, dark basalt
const BARE_ROCK = [[118, 104, 92], [176, 140, 96], [204, 196, 176], [164, 144, 138], [92, 88, 84]];
const mixc = (a, b, t) => { t = clamp(t, 0, 1); return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]; };
// m60: the broad mottle at (x, z), which paintLand has already worked out
function groundRGB(V, g, s, x, z, m60 = fbm(x / 60, z / 60, 11, 2)) {
  // ground the shared rule calls grass with outcrops shows as grass, its bare share mostly grassed over
  const hill = g.cls === HILL, m = V.mpp, tr = g.c1, sh = g.c2, ma = g.c3, sa = g.c5, gr = g.c0 + (hill ? g.c4 * 0.8 : 0), ba = g.c4 * (hill ? 0.2 : 1), sum = gr + tr + sh + ma + ba || 1;
  let grass = g.lush > 0.5 ? mixc(C_MID, C_LUSH, (g.lush - 0.5) * 2) : mixc(C_STRAW, C_MID, g.lush * 2);
  const marsh = mixc(C_MARSH, C_PEAT, g.peat), bare = mixc(mixc(mixc(C_BARE, BARE_ROCK[g.rock] ?? C_BARE, 0.45), C_SOIL, smooth(0.3, 1.5, g.soil) * 0.6), C_SILT, g.silt * 8);
  let heath = C_HEATH;
  if (V.season === "autumn") { grass = mixc(grass, C_AUTUMN, 0.45); heath = mixc(heath, [140, 76, 60], 0.35); }
  else if (V.season === "winter") { grass = mixc(grass, C_WINTER, 0.4); heath = mixc(heath, C_WINTER, 0.3); }
  let c = [0, 1, 2].map((k) => (tr * C_TREE[k] + sh * heath[k] + gr * grass[k] + ma * marsh[k] + ba * bare[k]) / sum);
  c = mixc(c, C_SAND, sa * 1.4);
  // wind-scoured ground goes tawny, foggy hollows grey-green
  c = mixc(c, C_BURN, smooth(0.3, 0.42, g.ex) * 0.35);
  c = mixc(c, C_FOG, g.fog * 0.3);
  c = mixc(c, [236, 240, 244], g.snowNow * 0.75);
  // pigment gathers where one cover gives way to another
  const sh2 = [gr, tr, sh, ma, ba].sort((a, b) => b - a), pool = Math.max(0, 1 - ((sh2[0] - sh2[1]) / sum) * 3) * 0.07;
  const mot = m60 * 0.05 + clusters(x, z, 6, 12, m, 0.4) * 0.05 + clusters(x, z, 1.8, 13, m) * 0.08 + clusters(x, z, 0.5, 14, m, 0.5) * 0.11;
  // colour keeps its hue and saturation in a narrow value band; the light sets value over a much wider range
  const L0 = c[0] * 0.3 + c[1] * 0.59 + c[2] * 0.11 || 1, band = 112 * (1 + (L0 / 112 - 1) * 0.18);
  const k = ((1 + mot - pool) * band * clamp(1 + s * 0.3, 0.42, 1.6)) / L0;
  return [c[0] * k, c[1] * k, c[2] * k];
}
// The nearest pair of natural ground colours for every RGB, and how far along the pair the colour lies, so a smooth
// field comes out as two palette tones in ordered dither.
const DQ_NAMES = ["g0", "g1", "g2", "g3", "g4", "g5", "g6", "t1", "t2", "t3", "a0", "a1", "a2", "a3", "d0", "d1", "d2", "d3", "d4", "d5", "r0", "r1", "r2", "r3", "r4", "r5", "s0", "s1", "s2", "s3", "m0", "m1", "m2", "m3", "h0", "h1", "h2", "h3", "o0", "o1", "o2", "o3"];
let DQ = null;
function dqBuild() {
  const ids = DQ_NAMES.map((n) => P[n]), cols = ids.map((i) => RGB_[i]), W8 = [3, 4, 2], d2 = (a, b) => W8[0] * (a[0] - b[0]) ** 2 + W8[1] * (a[1] - b[1]) ** 2 + W8[2] * (a[2] - b[2]) ** 2;
  DQ = new Uint8Array(32768 * 3);
  for (let r = 0; r < 32; r++)
    for (let gg = 0; gg < 32; gg++)
      for (let b = 0; b < 32; b++) {
        const t0 = [r * 8 + 4, gg * 8 + 4, b * 8 + 4], near = cols.map((c, k) => [d2(c, t0), k]).sort((a, b) => a[0] - b[0]).slice(0, 6);
        let best = [near[0][0], near[0][1], near[0][1], 0];
        for (const [, i] of near)
          for (let j = 0; j < cols.length; j++) {
            if (j === i) continue;
            const A = cols[i], Bc = cols[j], e = [Bc[0] - A[0], Bc[1] - A[1], Bc[2] - A[2]];
            const t = clamp(((t0[0] - A[0]) * e[0] * W8[0] + (t0[1] - A[1]) * e[1] * W8[1] + (t0[2] - A[2]) * e[2] * W8[2]) / (W8[0] * e[0] ** 2 + W8[1] * e[1] ** 2 + W8[2] * e[2] ** 2 || 1), 0, 1);
            const q = d2([A[0] + e[0] * t, A[1] + e[1] * t, A[2] + e[2] * t], t0) + d2(A, Bc) * 0.2 * t * (1 - t);
            if (q < best[0]) best = [q, i, j, t];
          }
        const o = ((r << 10) | (gg << 5) | b) * 3;
        DQ[o] = ids[best[1]]; DQ[o + 1] = ids[best[2]]; DQ[o + 2] = Math.round(best[3] * 255);
      }
}
function dq(c, X, Y) {
  if (!DQ) dqBuild();
  const o = ((clamp(c[0] >> 3, 0, 31) << 10) | (clamp(c[1] >> 3, 0, 31) << 5) | clamp(c[2] >> 3, 0, 31)) * 3;
  return bayer(X, Y) * 255 < DQ[o + 2] ? DQ[o + 1] : DQ[o];
}
function paintLand(w, V, g, X, Y, s) {
  const x = g.x, z = g.z, m = V.mpp;
  if (V.trail && trailNear(V.trail, x, z) && onTrail(V.trail, x, z, m, X, Y)) { TRACE.cls = 255; return soil(x, z, s + 0.4, X, Y, m); }
  const mot = fbm(x / 60, z / 60, 11, 2), cls = g.cls;
  TRACE.cls = cls;
  if (cls === ROCKY) return rock(x, z, s, g.snow, X, Y, m);
  switch (cls) {
    case FOREST: {
      // leaf litter in small drifts, a few twigs of dark soil, lit patches where the canopy opens
      const lit = clusters(x, z, 4, 3, m, 0.5), litter = clusters(x, z, 0.7, 4, m, 0.5);
      if (litter > 0 && noise(x / 0.35, z / 0.35, 5) * fade(0.35, m) > 0.3) return P.d2;
      const c = groundRGB(V, g, s, x, z, mot), k = 1 + lit * 0.06;
      return dq([c[0] * k, c[1] * k, c[2] * k], X, Y);
    }
    case SCRUB: return dq(groundRGB(V, g, s, x, z, mot), X, Y);
    case SAND: {
      let v = 2.5 + s * 0.7 + Math.round(mot * 2) * 0.3 + clusters(x, z, 0.4, 8, m, 0.55) * 0.8;
      // ripples 3 m apart, fading out once they are narrower than a pixel
      const rf = fade(1.2, m);
      if (rf > 0) { const r = (x * 0.6 + z * 0.8) / 3 + fbm(x / 24, z / 24, 61, 2) * 2, f = r - Math.floor(r); if (f < 0.13 * rf) v -= 1; else if (f < 0.22 * rf) v += 0.6; }
      if (g.nearWet) v -= 0.8;
      return tone(SA, v, X, Y);
    }
    case MARSH: {
      // wet hollows gather where a broad wetness field is high, so they come in clusters with firmer ground between
      const pool = (a, b) => noise(a / 37, b / 37, 31) + 0.3 * noise(a / 15, b / 15, 32) + noise(a / 110, b / 110, 33) * 0.5, pn = pool(x, z);
      // the wettest hollows are dark mud with small still puddles, not open water: waterAt is the only open water drawn
      if (pn > 0.42) {
        if (pn > 0.5 && noise(x / 1.6, z / 1.6, 36) * fade(1.6, m) > 0.35) return bayer(X, Y) < 0.3 ? P.w1 : P.w0;
        return tone(MUD, 1.8 + s * 0.6 + clusters(x, z, 1.2, 9, m, 0.5) * 0.8 + clusters(x, z, 0.4, 37, m, 0.5) * 0.6 - Math.min(1, (pn - 0.42) * 6) * 0.8, X, Y);
      }
      // reed rims round the pools: short upright strokes, a meter long
      if (pn > 0.35) return noise(x / 0.5, z / 2.2, 34) * fade(0.5, m) > 0.1 ? P.m3 : clusters(x, z, 1.5, 35, m) > 0 ? P.a1 : P.m1;
      return dq(groundRGB(V, g, s, x, z, mot), X, Y);
    }
    default: {
      // meadow: broad swathes, then tone clusters at a few meters, then blade speckle at half a meter
      // bare patches only where the generator's soil is thin
      const bare = fbm(x / 14, z / 14, 55, 2);
      if (bare > 0.3 + g.c0 * 0.15 + smooth(0.3, 1.2, g.soil) * 0.4) return soil(x, z, s + (bare - 0.5) * 1.5, X, Y, m);
      // under the woods edge the grass is strewn with leaf litter
      if (g.c1 > 0.2 && clusters(x, z, 0.6, 15, m, 0.55 - (g.c1 - 0.2) * 0.4) > 0) return P.d2;
      return dq(groundRGB(V, g, s, x, z, mot), X, Y);
    }
  }
}
// bare earth: soil tones with grit and the odd pale stone, all in meters
function soil(x, z, s, X, Y, m) {
  if (noise(x / 0.3, z / 0.3, 91) * fade(0.3, m) > 0.62) return P.d5;
  return tone(DI, 3.1 + s + clusters(x, z, 1.4, 92, m) * 0.8 + clusters(x, z, 0.4, 93, m, 0.5) * 0.8, X, Y);
}
// rock: broad planes picked by facing, fissures a meter wide, cracks and grain below that, and snow in solid shapes
function rock(x, z, s, snow, X, Y, m) {
  const plane = Math.round(fbm(x / 30, z / 30, 27, 2) * 1.4) * 0.5, face = s * 1.1 + plane + 0.9;
  const snowV = snow > 0.03 ? fbm(x / 20, z / 40, 29, 2) + snow * 3 - 0.6 + clusters(x, z, 2, 30, m) * 0.05 : -1;
  if (snowV > 0.04) return face < -0.2 ? P.haze : P.snow;
  if (snowV > -0.02) return bayer(X, Y) < (snowV + 0.02) / 0.06 ? (face < -0.2 ? P.haze : P.snow) : face < -0.2 ? P.r2 : P.r4;
  // fissures and cracks only in some stretches of the face, so most of it reads as sound stone
  if (noise(x / 45, z / 45, 214) > 0.3) {
    const fis = Math.abs(noise(x / 12, z / 26, 211));
    if (fis < 0.035 * fade(3, m)) return fis < 0.015 ? P.r0 : P.r1;
  }
  if (noise(x / 9, z / 9, 215) > 0.35 && Math.abs(noise(x / 2.5, z / 5.5, 210)) < 0.04 * fade(0.9, m)) return P.r1;
  return tone(RK, 2.6 + face * 1.3 + clusters(x, z, 2.2, 212, m) * 0.7 + clusters(x, z, 0.5, 213, m, 0.5) * 0.8, X, Y);
}
// ---------- world-space light: one height surface, the same at every zoom ----------
// Heights on a 12.5 m grid, a broad occlusion that darkens valley floors against the ground around them, and per bearing
// the sun's horizon: whether the drawn (exaggerated) ground toward the sun rises above the ray, softened at its edge.
const WS = 12.5, WN = Math.ceil(SIZE / WS) + 1;
function worldHeights(w) {
  if (w.hGrid) return w.hGrid;
  const g = new Float32Array(WN * WN);
  for (let j = 0; j < WN; j++) for (let i = 0; i < WN; i++) g[j * WN + i] = Math.max(0, w.heightAt(ORIGIN + i * WS, ORIGIN + j * WS));
  return (w.hGrid = g);
}
function worldAO(w) {
  if (w.aoGrid) return w.aoGrid;
  const h = worldHeights(w), r = 16, tmp = new Float32Array(WN * WN), m = new Float32Array(WN * WN);
  // a box mean over about 400 m, in two passes
  for (let j = 0; j < WN; j++) { let a = 0, c = 0; for (let i = -r; i < WN + r; i++) { if (i + r < WN) { a += h[j * WN + i + r]; c++; } if (i - r - 1 >= 0) { a -= h[j * WN + i - r - 1]; c--; } if (i >= 0 && i < WN) tmp[j * WN + i] = a / c; } }
  for (let i = 0; i < WN; i++) { let a = 0, c = 0; for (let j = -r; j < WN + r; j++) { if (j + r < WN) { a += tmp[(j + r) * WN + i]; c++; } if (j - r - 1 >= 0) { a -= tmp[(j - r - 1) * WN + i]; c--; } if (j >= 0 && j < WN) m[j * WN + i] = a / c; } }
  const ao = new Float32Array(WN * WN);
  for (let k = 0; k < ao.length; k++) ao[k] = clamp((h[k] - m[k]) / 45, -1, 0.6);
  return (w.aoGrid = ao);
}
function worldShadow(w, b) {
  w.shGrid ??= new Map();
  let g = w.shGrid.get(b);
  if (g) return g;
  const h = worldHeights(w), F = bearingFrame(b), n = Math.hypot(LU, LV), dx = (LU * F.eu[0] + LV * F.ev[0]) / n, dz = (LU * F.eu[1] + LV * F.ev[1]) / n;
  const tanS = Math.tan(SUN * 0.75), E = EXAG, steps = [];
  for (let d = WS; d < 2400; d *= 1.09) steps.push(d);
  const at = (x, z) => { const fx = clamp((x - ORIGIN) / WS, 0, WN - 1.001), fz = clamp((z - ORIGIN) / WS, 0, WN - 1.001), i = Math.floor(fx), j = Math.floor(fz), a = fx - i, c = fz - j, k = j * WN + i; return (h[k] * (1 - a) + h[k + 1] * a) * (1 - c) + (h[k + WN] * (1 - a) + h[k + WN + 1] * a) * c; };
  g = new Uint8Array(WN * WN);
  for (let j = 0; j < WN; j++)
    for (let i = 0; i < WN; i++) {
      const x = ORIGIN + i * WS, z = ORIGIN + j * WS, h0 = h[j * WN + i] * E;
      let ex = -1e9;
      for (const d of steps) { const e = at(x + dx * d, z + dz * d) * E - (h0 + d * tanS); if (e > ex) ex = e; }
      g[j * WN + i] = Math.round(smooth(-3, 10, ex) * 255);
    }
  w.shGrid.set(b, g);
  return g;
}
const wsample = (g, x, z) => { const fx = clamp((x - ORIGIN) / WS, 0, WN - 1.001), fz = clamp((z - ORIGIN) / WS, 0, WN - 1.001), i = Math.floor(fx), j = Math.floor(fz), a = fx - i, c = fz - j, k = j * WN + i; return (g[k] * (1 - a) + g[k + 1] * a) * (1 - c) + (g[k + WN] * (1 - a) + g[k + WN + 1] * a) * c; };
// the terrain's light at a world point for bearing b: slope light, less occlusion in hollows, less the cast shadow.
// With V.realtime the GPU lights the slopes and casts the shadows for the hour, so only the occlusion is baked; and with
// V.aoGpu it takes the hollows' share of the sky as well (gpu.js ambient occlusion), leaving only the ridges' light here.
export function terrainLight(w, V, x, z) {
  const ao = wsample(worldAO(w), x, z), sh = V.realtime ? 0 : wsample(worldShadow(w, V.bearing), x, z) / 255;
  TL.sh = sh;
  const s = (V.aoGpu ? 0 : Math.min(0, ao) * 1.1) + Math.max(0, ao) * 0.4 - sh * 1.5;
  if (V.realtime) return s;
  const gg = worldGrad(w, x, z);
  return s + lightOf(gg[0] * V.eu[0] + gg[1] * V.eu[1], gg[0] * V.ev[0] + gg[1] * V.ev[1]);
}
const TL = { sh: 0 };
// The ground's gradient on a fixed 12.5 m world grid (over an 18.75 m baseline), shared by the fine levels, so yard and
// close light each point alike and nothing pops between them.
function worldGrad(w, x, z) {
  const S = 12.5, n = Math.ceil(SIZE / S) + 1;
  if (!w.gradGrid) {
    const g = new Float32Array(n * n * 2), d = 18.75;
    for (let j = 0; j < n; j++)
      for (let i = 0; i < n; i++) {
        const X = ORIGIN + i * S, Z = ORIGIN + j * S, k = (j * n + i) * 2;
        g[k] = (w.heightAt(X + d, Z) - w.heightAt(X - d, Z)) / (2 * d); g[k + 1] = (w.heightAt(X, Z + d) - w.heightAt(X, Z - d)) / (2 * d);
      }
    w.gradGrid = g;
  }
  const g = w.gradGrid, fx = clamp((x - ORIGIN) / S, 0, n - 1.001), fz = clamp((z - ORIGIN) / S, 0, n - 1.001), i = Math.floor(fx), j = Math.floor(fz), a = fx - i, b = fz - j, k = (j * n + i) * 2, m = n * 2;
  WG[0] = (g[k] * (1 - a) + g[k + 2] * a) * (1 - b) + (g[k + m] * (1 - a) + g[k + m + 2] * a) * b;
  WG[1] = (g[k + 1] * (1 - a) + g[k + 3] * a) * (1 - b) + (g[k + m + 1] * (1 - a) + g[k + m + 3] * a) * b;
  return WG;
}
const WG = [0, 0];
const lightOf = (gu, gv) => { const l = LIGHT * EXAG * (-LU * gu - LV * gv); return clamp(l < 0 ? l * 0.6 : l, -1.3, 2); };
// The live ground: z-tested so steep slopes hide what is behind them, back faces culled, every pixel textured from
// the world at its own position. Land meets standing water with a short bank strip. V.waterV, when the bake gives
// one, gets 1 + 16 x the tone of each pixel of still open water, 0 elsewhere.
export function drawTerrainLive(B, w, V, M) {
  const { NI, NJ, i0, j0 } = M, C = M.C, GX = V.gx, GY = V.gy, VI = NI + 1;
  const dbg = V.debug;
  nearI = NaN;
  const anim = V.anim, wv = V.waterV, frames = (p, f0, paint) => {
    const cols = [f0];
    let moving = false;
    for (let f = 1; f < 8; f++) { setMode(VIEW, f); const c = paint(); cols.push(c); if (c !== f0) moving = true; }
    setMode(VIEW, 0);
    if (moving) anim.set(p, cols);
  };
  const shade = (col, X, Y) => (DARKER[col] !== col ? (bayer(X, Y) < 0.6 ? DARKER[col] : col) : SHADOW[col]);
  const a0 = clamp(V.i0 - i0, 0, NI), a1 = clamp(V.i1 - i0, 0, NI), b0 = clamp(V.j0 - j0, 0, NJ), b1 = clamp(V.j1 - j0, 0, NJ);
  for (let j = b0; j < b1; j++)
    for (let i = a0; i < a1; i++) {
      const t = j * NI + i, uT = i0 + i, vT = j0 + j;
      if (!V.visible(uT + 0.5, vT + 0.5)) continue;
      const c = [C[t * 4], C[t * 4 + 1], C[t * 4 + 2], C[t * 4 + 3]], P4 = [[uT, vT, c[0]], [uT + 1, vT, c[1]], [uT + 1, vT + 1, c[2]], [uT, vT + 1, c[3]]];
      // a bank where this tile stands above the flat water tile in front of it
      for (const face of [0, 1]) {
        const nb = M.at(face ? i + 1 : i, face ? j : j + 1);
        if (nb < 0 || !M.kind[nb] || M.kind[t]) continue;
        const [A, Bk] = face ? [2, 1] : [3, 2], botA = C[nb * 4 + (face ? 3 : 0)], botB = C[nb * 4 + (face ? 0 : 1)];
        if (botA >= c[A] && botB >= c[Bk]) continue;
        const pa = P4[A], pb = P4[Bk];
        strip(B, V.sx(pa[0], pa[1]), V.sx(pb[0], pb[1]), V.sy(pa[0], pa[1], pa[2]), V.sy(pb[0], pb[1], pb[2]), V.sy(pa[0], pa[1], botA), V.sy(pb[0], pb[1], botB), (p, x, y, tt, depth, hpx) => {
          const u = pa[0] + (pb[0] - pa[0]) * tt, v = pa[1] + (pb[1] - pa[1]) * tt, lev = (V.Y0 + (u + v) * V.H * 0.5 - (y + 0.5)) / V.lp, z = V.cz(u, v, lev);
          if (z < B.z[p]) return;
          B.c[p] = texWall(V, DIRTW, face, x + GX, y + GY, depth, hpx, lev, true, 0); B.z[p] = z; B.id[p] = 0;
          anim?.delete(p); if (wv) wv[p] = 0;
          if (dbg) dbg.cls[p] = 254;
        });
      }
      const tris = M.diag[t] === 0 ? [[0, 1, 2], [0, 2, 3]] : [[0, 1, 3], [3, 1, 2]];
      for (const [a, b, cc] of tris) {
        const A = P4[a], Bv = P4[b], Cv = P4[cc];
        const ax = V.sx(A[0], A[1]), ay = V.sy(A[0], A[1], A[2]), bx = V.sx(Bv[0], Bv[1]), by = V.sy(Bv[0], Bv[1], Bv[2]), cx = V.sx(Cv[0], Cv[1]), cy = V.sy(Cv[0], Cv[1], Cv[2]);
        // a triangle turned away from the camera is the far side of a slope; the near side hides it
        const uvA = (Bv[0] - A[0]) * (Cv[1] - A[1]) - (Bv[1] - A[1]) * (Cv[0] - A[0]), scA = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
        if (uvA * scA <= 0) continue;
        tri(B, ax, ay, bx, by, cx, cy, (p, x, y, la, lb, lc) => {
          const u = la * A[0] + lb * Bv[0] + lc * Cv[0], v = la * A[1] + lb * Bv[1] + lc * Cv[1], lev = la * A[2] + lb * Bv[2] + lc * Cv[2], z = V.cz(u, v, lev);
          if (z < B.z[p]) return;
          // what lay here before is painted over, its loop with it
          anim?.delete(p);
          const X = x + GX, Y = y + GY, fu = u - uT, fv = v - vT;
          const wx = V.ox + (u * V.eu[0] + v * V.ev[0]) * V.tileM, wz = V.oz + (u * V.eu[1] + v * V.ev[1]) * V.tileM;
          // light owns value: slope, hollows and cast shadows from one world surface, at every level alike
          const s = terrainLight(w, V, wx, wz), inShade = TL.sh > 0.5;
          const g = groundAt(w, V, wx, wz);
          let col;
          const dark = inShade && bayer(X, Y) < smooth(0.5, 0.8, TL.sh) + 0.5;
          if (g.water) {
            // g is groundAt's one shared record; nothing samples the ground again before this pixel is done
            col = paintWater(w, V, g, X, Y);
            const still = !WV.moves, tv = WV.v;
            if (dark) col = shade(col, X, Y);
            if (anim && !still) frames(p, col, () => { const c2 = paintWater(w, V, g, X, Y); return dark ? shade(c2, X, Y) : c2; });
            // open water, which the GPU paints again from its tone on a turned grid so its dither does not swim
            if (wv) wv[p] = tv >= 0 && still && !dark ? 1 + Math.min(126, Math.round(tv * 16)) : 0;
            if (dbg) dbg.cls[p] = 40 + g.water;
          } else {
            col = paintLand(w, V, g, X, Y, s);
            // land takes its shadow in its value already; the flag keeps sprite shadows from darkening it twice
            if (inShade) B.sh[p] = 1;
            if (wv) wv[p] = 0;
            if (dbg) dbg.cls[p] = TRACE.cls;
          }
          if (dbg) { dbg.wx[p] = wx; dbg.wz[p] = wz; }
          B.c[p] = col; B.z[p] = z; B.id[p] = 0;
        });
      }
    }
}

// ---------- objects ----------
// Sprites by key, the least recently used dropped past SPRITE_BYTES. A forest chunk wants thousands of tree variants;
// emptying the whole cache at a count, as it once did, had most of them drawn again for every chunk.
const cache = new Map(), SPRITE_BYTES = 12e6;
let spriteBytes = 0;
const cached = (key, make) => {
  let s = cache.get(key);
  if (s) { cache.delete(key); cache.set(key, s); return s; }
  s = make();
  cache.set(key, s);
  spriteBytes += (s?.p?.length ?? 0) + 64;
  if (spriteBytes > SPRITE_BYTES) for (const [k, v] of cache) { if (spriteBytes <= SPRITE_BYTES * 0.8) break; cache.delete(k); spriteBytes -= (v?.p?.length ?? 0) + 64; }
  return s;
};
// Creature and landmark sprites from life.js; anything it does not (yet) export is simply left out.
let LIFE = {};
export const setLife = (mod) => { LIFE = mod; };
// Isolife's sprites for every sim kind; the stills never need them
let TH = {};
export const setThings = (mod) => { TH = mod; };
const life = (name, key, ...args) => (typeof LIFE[name] === "function" ? cached(`L:${name}:${key}`, () => LIFE[name](...args)) : null);

function place(V, M, x, z) {
  const [u, v] = V.toUV(x, z), g = M.ground(u, v);
  if (!g) return null;
  return { u, v, g, sx: Math.round(V.sx(u, v)), sy: Math.round(V.sy(u, v, g.lev)), z: V.cz(u, v, g.lev) };
}

function collectObjects(w, V, M) {
  const O = [];
  const add = (at, spr, opt = {}) => O.push({ z: at.z, sx: at.sx, sy: at.sy, spr, shadow: opt.shadow !== false, mirror: !!opt.mirror, bias: opt.bias ?? V.H * 0.5 + 2 });
  if (VIEW === "island") {
    const n = V.NI * V.NJ, count = new Float32Array(n), pines = new Float32Array(n), gold = new Float32Array(n);
    for (const t of w.trees) {
      const [u, v] = V.toUV(t.x, t.z), k = M.at(Math.floor(u) - V.i0, Math.floor(v) - V.j0);
      if (k < 0) continue;
      count[k]++;
      if (t.kind === "pine") pines[k]++;
      else if (t.kind === "aspen" && t.tint > 0.8) gold[k]++;
    }
    // three ramps per kind: on ground facing away from the light, flat, facing it
    const RP = {
      pine: [[P.p0, P.p1, P.p2], [P.p1, P.p2, P.p3], [P.p1, P.p3, P.p4], [P.p2, P.p4, P.g4]],
      oak: [[P.p0, P.t1, P.t2], [P.t1, P.t3, P.g3], [P.t2, P.g3, P.g4], [P.t3, P.g4, P.g5]],
      ash: [[P.t1, P.t2, P.g2], [P.t2, P.g3, P.g4], [P.g2, P.g4, P.g5], [P.g3, P.g5, P.g6]],
      gold: [[P.d0, P.a0, P.a1], [P.d1, P.a1, P.a2], [P.a0, P.a2, P.a3], [P.a1, P.a3, P.s3]],
    };
    const [cu, cv] = V.toUV(w.camp.at.x, w.camp.at.z), ci = Math.floor(cu) - V.i0, cj = Math.floor(cv) - V.j0;
    // hand-placed minis are drawn for 12 px tiles; finer pixels get real sprites, chunkier ones smaller minis
    const fine = Z >= 1.5, small = Z < 1, at3 = (u, v, g) => ({ z: V.cz(u, v, g.lev), sx: Math.round(V.sx(u, v)), sy: Math.round(V.sy(u, v, g.lev)) });
    for (let j = 0; j < V.NJ; j++)
      for (let i = 0; i < V.NI; i++) {
        const t = j * V.NI + i;
        if (M.kind[t] || (i === ci && j === cj) || !V.objVisible(V.i0 + i + 0.5, V.j0 + j + 0.5)) continue;
        if (M.cls[t] === HILL) {
          const nr = Math.round((M.cov[4][t] * 1.8 + h2(t, 7, 7) - 0.5) * (DENSE === 2 ? 1.8 : 1));
          for (let q = 0; q < nr; q++) {
            if (DENSE === 0 && h2(t, q, 24) < 0.5) continue;
            const u = V.i0 + i + 0.15 + 0.7 * h2(t, q, 21), v = V.j0 + j + 0.15 + 0.7 * h2(t, q, 22), g = M.ground(u, v);
            const big = h2(t, q, 23) < 0.35 ? 1 : 0, snow = M.cls[t] === ROCK && M.snow[t] > 0.02 ? 1 : 0;
            const spr = fine ? cached(`irk${big}`, () => SP.rock(big ? 4.5 : 2.8, big + 1, 0.3)) : cached(`mr${small ? 0 : big}${snow}`, () => SP.miniRock(small ? 0 : big, snow));
            add(at3(u, v, g), spr, { bias: 1 });
          }
        }
        // dense=2: thickets of scrub along the woods edge
        if (DENSE === 2 && M.cov[1][t] > 0.2 && M.cov[1][t] < 0.75) {
          const nb = Math.floor(M.cov[1][t] * (1 - M.cov[1][t]) * 8 + h2(t, 8, 8));
          for (let q = 0; q < nb; q++) {
            const u = V.i0 + i + 0.1 + 0.8 * h2(t, q, 25), v = V.j0 + j + 0.1 + 0.8 * h2(t, q, 26), g = M.ground(u, v);
            const spr = fine ? cached(`ibush${q & 1}${M.heath[t] > 0.5}`, () => SP.bush(3 + (q & 1) * 2, q + 3, M.heath[t], 0)) : cached(`mbush${small}`, () => SP.mini(small ? "broadS" : "broad2", [P.g1, P.g3, P.g5]));
            add(at3(u, v, g), spr, { bias: 1 });
          }
        }
        if (count[t] < 3) continue;
        const m = clamp(Math.round(M.cov[1][t] * 6.5 - 0.9 + h2(t, 9, 9) * 0.8), 0, 5);
        for (let q = 0; q < m; q++) {
          const fu = 0.12 + 0.76 * h2(t, q, 1), fv = 0.12 + 0.76 * h2(t, q, 2), r = h2(t, q, 3);
          const pine = r < pines[t] / count[t], isGold = !pine && h2(t, q, 4) < gold[t] / count[t];
          const kind = pine ? (h2(t, q, 5) < 0.5 ? "pine" : "pine2") : h2(t, q, 5) < 0.6 ? "broad" : "broad2";
          const rp = pine ? "pine" : isGold ? "gold" : M.moist[t] > 0.6 ? "ash" : "oak";
          const u = V.i0 + i + fu, v = V.j0 + j + fv, g = M.ground(u, v);
          const c = M.C.subarray(t * 4, t * 4 + 4), du = (c[1] + c[2] - c[0] - c[3]) / 2, dv = (c[2] + c[3] - c[0] - c[1]) / 2;
          const around = [M.at(i - 1, j), M.at(i, j - 1), M.at(i + 1, j), M.at(i, j + 1)].map((k) => (k >= 0 && !M.kind[k] ? M.cov[1][k] : 0));
          const deep = M.cov[1][t] > 0.6 && Math.min(...around) > 0.55, edgeLit = around[0] < 0.3 || around[1] < 0.3;
          const lit = deep ? 0 : V.shaded && V.shaded(u, v, g.lev) ? 1 : clamp(Math.round(-LU * du - LV * dv) + 2 + (edgeLit ? 1 : 0), 1, 3);
          let spr;
          if (fine) {
            const hp = Math.round((pine ? 5.5 : 5) * Z * (0.85 + 0.3 * h2(t, q, 6)));
            spr = pine ? cached(`ip${hp}`, () => SP.pine(hp, hp * 3)) : cached(`ib${rp}${hp}${lit}`, () => SP.broad(hp, rp === "gold" ? "aspen" : rp, hp * 5, rp === "gold" ? 0.9 : 0.25 + lit * 0.25));
          } else spr = cached(kind + rp + lit + small, () => SP.mini(small ? (pine ? "pineS" : "broadS") : kind, RP[rp][lit]));
          add(at3(u, v, g), spr, { bias: 2 });
        }
      }
    islandMarks(w, V, M, add);
    const camp = place(V, M, w.camp.at.x, w.camp.at.z);
    if (camp) {
      const tent = cached("minitent", () => SP.miniTent(fine ? 2 : 1)), o = (d) => Math.round(d * Z);
      add(camp, tent, { bias: 4 });
      add({ ...camp, sx: camp.sx + o(5), sy: camp.sy + o(1), z: camp.z + 3 }, tent, { bias: 4 });
      add({ ...camp, sx: camp.sx - o(4), sy: camp.sy + o(2), z: camp.z + 4 }, tent, { bias: 4 });
      V.fireAt = { x: camp.sx + o(1), y: camp.sy + o(3), r: 5 * Z };
      const wind = w.isle.wind || [1, 0], wu = wind[0] * V.eu[0] + wind[1] * V.eu[1], wv = wind[0] * V.ev[0] + wind[1] * V.ev[1];
      V.smokes = [{ x: camp.sx + o(1), y: camp.sy + o(1), h: 12 * Z, r: 0.8 * Z, drift: clamp(((wu - wv) / (Math.hypot(wu, wv) || 1)) * 0.75, -0.8, 0.8) }];
    }
    return O;
  }
  const pv = V.k * 0.866; // true-scale pixels per vertical meter
  trodden(w, V);
  const fire = w.camp.fire, spread = V.campOff - 1;
  // the camp is drawn spread out, so the clearing world.js made around it is widened by the same amount
  const clear = (x, z, r0, r1) => { const d = Math.hypot(x - fire.x, z - fire.z); return spread > 0 && (d < r0 * V.campOff || (d < r1 * V.campOff && h2(Math.round(x * 10), Math.round(z * 10), 5) < (r1 * V.campOff - d) / (r1 * V.campOff - r0 * V.campOff))); };
  const inView = (x, z) => { const [u, v] = V.toUV(x, z); return V.objVisible(u, v); };
  // dense=0 drops half of the small stuff, picked by position so the rest stays put
  const thin = (x, z, s) => DENSE === 0 && h2(Math.round(x * 7), Math.round(z * 7), s) < 0.5;
  const qs = VIEW === "camp" ? 25 : 70, quiet = (x, z) => DENSE === 2 && fbm(x / qs, z / qs, 206, 2) < -0.12;
  // Value: crowns darken toward a forest's interior so woods read as dark masses; trees on the sunward edge of a wood
  // or out in the open keep their bright rims.
  const sunW = [-(V.sd[0] * V.eu[0] + V.sd[1] * V.ev[0]), -(V.sd[0] * V.eu[1] + V.sd[1] * V.ev[1])], reachW = VIEW === "camp" ? 14 : 30;
  const cov = (x, z) => w.fine(w.cover.tree, x, z);
  const dimAt = (x, z) => {
    const c0 = cov(x, z), sun = cov(x + sunW[0] * reachW, z + sunW[1] * reachW);
    if (sun < 0.28) return -0.75;
    if (c0 < 0.3) return -0.25;
    let ring = 0;
    for (let k = 0; k < 4; k++) ring += cov(x + Math.cos(k * 1.571) * reachW * 1.4, z + Math.sin(k * 1.571) * reachW * 1.4) / 4;
    return Math.round(smooth(0.35, 0.8, Math.min(c0, sun, ring)) * 4) / 4;
  };
  // the giant's foot must stand well inside the frame, so its crown is seen whole
  const whole = (t) => { const at = place(V, M, t.x, t.z); return at && onScreen(V, at.sx, at.sy, 60) && at.sy > 0.35 * V.AH; };
  const giants = new Set(w.trees.filter((t) => t.tall > 16 && cov(t.x, t.z) < 0.3 && inView(t.x, t.z) && !clear(t.x, t.z, 22, 40) && whole(t)).sort((a, b) => b.tall - a.tall).slice(0, FAR ? 2 : 1));
  for (const t of w.trees) {
    if (!inView(t.x, t.z) || clear(t.x, t.z, 22, 40)) continue;
    const at = place(V, M, t.x, t.z);
    if (!at || at.g.water) continue;
    if (giants.has(t)) {
      const gp = Math.round(t.tall * pv * V.treeK * (FAR ? 1.9 : 1.35)), g = life("giant", `${gp}|${t.kind}`, gp, t.kind === "pine" ? "pine" : "oak", 7);
      if (g) { add(at, g, { mirror: t.yaw > Math.PI }); V.marks.push("giant"); continue; }
    }
    const hp = Math.round(t.tall * pv * V.treeK), vr = Math.floor(t.tint * 5), dim = dimAt(t.x, t.z);
    const spr = t.kind === "pine" ? cached(`p${hp}|${vr}|${dim}`, () => SP.pine(hp, vr * 17 + hp, false, dim)) : cached(`${t.kind}${hp}|${vr}|${t.tint > 0.8 ? 1 : 0}|${dim}`, () => SP.broad(hp, t.kind, vr * 31 + hp, t.tint, dim));
    add(at, spr, { mirror: t.yaw > Math.PI });
  }
  for (const s of w.shrubs) {
    if (!inView(s.x, s.z) || clear(s.x, s.z, 14, 26) || thin(s.x, s.z, 201) || quiet(s.x, s.z)) continue;
    const at = place(V, M, s.x, s.z);
    if (!at || at.g.water) continue;
    const sz = Math.max(2, Math.round(s.tall * pv * (VIEW === "camp" ? 0.9 : 1.7))), vr = Math.floor(s.tint * 4);
    add(at, cached(`b${sz}|${vr}|${s.heath > 0.5 ? 1 : 0}`, () => SP.bush(sz, vr * 13 + sz, s.heath, s.tint)), { mirror: s.yaw > Math.PI });
  }
  // Far off, single stones read as confetti: nearby rocks gather into one outcrop per cell, lone small ones drop out, and
  // on the peak only the scree fans at its foot keep boulders.
  const clumped = FAR && THEME === "adventure", cellM = V.tileM * 2.6, bins = new Map();
  if (clumped)
    for (const r of w.rocks) {
      if (!inView(r.x, r.z) || clear(r.x, r.z, 12, 20)) continue;
      const key = `${Math.floor(r.x / cellM)},${Math.floor(r.z / cellM)}`, b = bins.get(key) ?? { n: 0, s: 0, x: 0, z: 0, big: r };
      b.n++; b.s += r.size; b.x += r.x * r.size; b.z += r.z * r.size;
      if (r.size > b.big.size) b.big = r;
      bins.set(key, b);
    }
  for (const b of bins.values()) {
    // outcrops gather where a broad field says the ground is stony, leaving open grass between the groups
    const gx = b.x / b.s, gz = b.z / b.s;
    if ((b.n < 6 && b.s < 10) || fbm(gx / (cellM * 4), gz / (cellM * 4), 209, 2) < 0.08) continue;
    const x = b.x / b.s, z = b.z / b.s, at = place(V, M, x, z);
    if (!at || at.g.water || !w.dry(x, z)) continue;
    const t = at.g.t;
    if (VIEW === "peak" && (M.cls[t] === ROCK || M.toRock[t] > 2)) continue;
    if (VIEW !== "peak" && M.cls[t] === ROCK && !M.head[t]) continue;
    const sz = clamp(Math.sqrt(b.s) * 2.2 * pv, 3 * Z, 14 * Z), vr = Math.floor(b.big.tint * 4), moss = w.fine(w.cover.tree, x, z);
    add(at, cached(`rc${Math.round(sz)}|${vr}|${moss > 0.4 ? 1 : 0}`, () => SP.rock(sz, vr * 7 + 3, moss)), { mirror: b.big.yaw > Math.PI });
    // a companion stone or two at the outcrop's foot
    for (let k = 0; k < Math.min(2, b.n >> 2); k++) {
      const a = h2(b.n, k, 208) * TAU, d = (sz * 0.8) / V.k, q = place(V, M, x + Math.cos(a) * d, z + Math.sin(a) * d);
      if (q && !q.g.water) add(q, cached(`rc${Math.round(sz * 0.45)}|${(vr + k) & 3}|0`, () => SP.rock(sz * 0.45, ((vr + k) & 3) * 7 + 3, 0)), { mirror: k === 1 });
    }
  }
  for (const r of clumped ? [] : w.rocks) {
    if (!inView(r.x, r.z) || clear(r.x, r.z, 12, 20) || thin(r.x, r.z, 202) || quiet(r.x, r.z)) continue;
    // far off, small stones are texture already; keep the big ones and the scree fans below outcrops
    if (FAR && V.band && r.size < 2.2 && fbm(r.x / 60, r.z / 60, 207, 2) < 0.15) continue;
    const at = place(V, M, r.x, r.z);
    if (!at || at.g.water) continue;
    const sz = Math.max(1.5, r.size * pv * (VIEW === "camp" ? 0.9 : 1.4)), vr = Math.floor(r.tint * 4), moss = w.fine(w.cover.tree, r.x, r.z);
    add(at, cached(`r${Math.round(sz * 2)}|${vr}|${moss > 0.4 ? 1 : 0}`, () => SP.rock(sz, vr * 7 + 3, moss)), { mirror: r.yaw > Math.PI });
  }
  if (VIEW === "camp") {
    // up close the canopy trees stand ~13 m apart, so the woods get their understory: saplings and ferns in
    // proportion to the tree cover, cleared round the camp the same way world.js cleared the trees
    for (let j = 0; j < V.NJ; j++)
      for (let i = 0; i < V.NI; i++) {
        const t = j * V.NI + i, tc = M.cov[1][t];
        if (M.kind[t] || tc < 0.2 || !V.objVisible(V.i0 + i + 0.5, V.j0 + j + 0.5)) continue;
        const n = Math.floor(tc * 5 + h2(i, j, 71));
        for (let q = 0; q < n; q++) {
          const u = V.i0 + i + h2(t, q, 72), v = V.j0 + j + h2(t, q, 73), [x, z] = V.toW(u, v), d = Math.hypot(x - fire.x, z - fire.z);
          if (d < 22 || (d < 40 && h2(t, q, 74) > (d - 22) / 18) || !w.dry(x, z) || thin(x, z, 203)) continue;
          const g = M.ground(u, v);
          if (!g || g.water) continue;
          const at = { u, v, g, sx: Math.round(V.sx(u, v)), sy: Math.round(V.sy(u, v, g.lev)), z: V.cz(u, v, g.lev) }, r = h2(t, q, 75);
          if (r < 0.35) {
            const hp = Math.round((2.2 + r * 12) * pv * V.treeK), k = h2(t, q, 76), kind = k < 0.25 ? "pine" : k < 0.5 ? "oak" : k < 0.75 ? "aspen" : "ash";
            add(at, kind === "pine" ? cached(`p${hp}|9`, () => SP.pine(hp, 9 + hp)) : cached(`${kind}${hp}|8|0`, () => SP.broad(hp, kind, 8 + hp, 0.5)), { mirror: r < 0.17 });
          } else if (r < 0.6) {
            const sz = Math.round((0.5 + r * 0.7) * pv);
            add(at, cached(`b${sz}|1|0`, () => SP.bush(sz, 13 + sz, 0, 0)), { mirror: r > 0.5 });
          } else {
            const sz = Math.round((0.5 + (r - 0.6) * 1.2) * pv);
            add(at, cached(`fern${sz}|${Math.floor(r * 10)}`, () => SP.fern(sz, Math.floor(r * 10))), { shadow: false, mirror: r > 0.8 });
          }
        }
      }
  }
  if (VIEW === "camp") {
    // the clearing world.js made round the camp was woodland once: stumps where the tree cover says trees stood,
    // now and then the felled trunk beside one
    const step = 2.2;
    for (let gz = -48; gz <= 48; gz += step)
      for (let gx = -48; gx <= 48; gx += step) {
        const x = fire.x + gx + (h2(gx * 10, gz * 10, 61) - 0.5) * step, z = fire.z + gz + (h2(gx * 10, gz * 10, 62) - 0.5) * step, d = Math.hypot(x - fire.x, z - fire.z);
        if (d < 7 || d > 46 || !w.dry(x, z) || V.trodden(x, z) < 0.6 || !inView(x, z) || thin(x, z, 204)) continue;
        const cover = w.fine(w.cover.tree, x, z) + 0.08;
        if (h2(gx * 10, gz * 10, 63) > cover * 3.6 * (step * step) / (w.STEP * w.STEP) * 0.9) continue;
        const at = place(V, M, x, z);
        if (!at || at.g.water) continue;
        const q = h2(gx * 10, gz * 10, 64), r = Math.round((0.22 + q * 0.18) * pv * 1.25);
        add(at, cached(`stump${r}`, () => SP.stump(r, r * 0.9, r)), { bias: 1 });
        if (q < 0.4) {
          const dir = q < 0.2 ? 1 : -1, len = Math.round((3 + q * 12) * pv * 0.55), lat = place(V, M, x + V.eu[0] * 1.5, z + V.eu[1] * 1.5);
          if (lat && !lat.g.water) add(lat, cached(`log${len}|${dir}|${r}`, () => SP.log(len, r * 0.8, dir, len)), { bias: 1 });
        }
      }
  }
  // reeds along marsh tiles and wet margins
  for (let j = 0; j < V.NJ; j++)
    for (let i = 0; i < V.NI; i++) {
      const t = j * V.NI + i;
      if (M.kind[t] || M.cov[3][t] < 0.25 || !V.objVisible(V.i0 + i + 0.5, V.j0 + j + 0.5)) continue;
      const n = Math.round(M.cov[3][t] * (VIEW === "camp" ? 3 : 5));
      for (let q = 0; q < n; q++) {
        const u = V.i0 + i + h2(t, q, 11), v = V.j0 + j + h2(t, q, 12), g = M.ground(u, v);
        if (!g || g.water || (DENSE === 0 && h2(t, q, 14) < 0.5)) continue;
        const hp = Math.round((1.2 + h2(t, q, 13)) * pv * (VIEW === "camp" ? 1 : 2.4));
        add({ z: V.cz(u, v, g.lev), sx: Math.round(V.sx(u, v)), sy: Math.round(V.sy(u, v, g.lev)) }, cached(`reed${hp}|${q % 4}`, () => SP.reeds(hp, q * 5 + hp)), { shadow: false });
      }
    }
  if (VIEW === "camp") {
    const near = w.nearby(w.camp.at, 45, DENSE === 0 ? 1.8 : 3.6);
    for (const g of near.grass) {
      // tufts gather in clumps, leaving quiet lawn between
      if (V.trodden(g.x, g.z) < 0 || (DENSE === 2 && fbm(g.x / 4, g.z / 4, 59, 2) < -0.05)) continue;
      const at = place(V, M, g.x, g.z);
      if (!at || at.g.water || !V.objVisible(at.u, at.v)) continue;
      const hp = Math.round(g.tall * pv * 0.95), vr = Math.floor(g.tint * 6);
      add(at, cached(`t${hp}|${vr}`, () => SP.tuft(hp, vr * 3 + hp, w.fine(w.cover.shrub, g.x, g.z))), { shadow: false, bias: 1, mirror: g.yaw > Math.PI });
    }
    for (const f of near.flowers) {
      if (V.trodden(f.x, f.z) < 0) continue;
      const at = place(V, M, f.x, f.z);
      if (!at || at.g.water || !V.objVisible(at.u, at.v)) continue;
      const hp = Math.round(f.tall * pv * 1.4);
      add(at, cached(`f${hp}|${Math.floor(f.hue * 6)}`, () => SP.flower(hp, f.hue, hp)), { shadow: false, bias: 1 });
    }
    for (const p of near.pebbles) {
      if (thin(p.x, p.z, 205)) continue;
      const at = place(V, M, p.x, p.z);
      if (!at || at.g.water) continue;
      const sz = p.size * pv * 0.7;
      add(at, cached(`pb${Math.round(sz)}`, () => (sz < 3 ? SP.pebble(sz, Math.round(p.size * 10)) : SP.rock(sz, Math.round(p.size * 10), 0))), { shadow: sz >= 3, bias: 1 });
    }
  }
  if (DENSE === 2) clumps(w, V, M, add, pv, clear);
  landmarks(w, V, M, add, pv);
  wildlife(w, V, M, add, pv, clear);
  campObjects(w, V, M, O, add, pv);
  return O;
}

// dense=2: extra dressing gathered in clumps where the cover fields call for it, not spread evenly. Rates are clumps per
// hectare times the field's weight; the close view gets more of them, since it shows what the far one cannot.
function clumps(w, V, M, add, pv, clear) {
  const camp = VIEW === "camp", A = (V.tileM * V.tileM) / 10000, more = camp ? 2.5 : 1, grow = camp ? 1 : 1.6, reach = camp ? 1 : 2;
  const fire = w.camp.fire, fireD = (x, z) => Math.hypot(x - fire.x, z - fire.z);
  const nextTo = (i, j, kinds) => [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([a, b]) => { const t = M.at(i + a, j + b); return t >= 0 && kinds.includes(M.kind[t]); });
  const free = (x, z, wet) => (wet || w.dry(x, z)) && V.trodden(x, z) > 1 && !clear(x, z, 14, 26);
  // n props within R meters of a jittered point in tile t; fn(at, x, z, r) with a per-prop random r
  const spawn = (t, q, n, R, wet, fn) => {
    const [cx, cz] = V.toW(V.i0 + (t % V.NI) + h2(t, q, 301), V.j0 + Math.floor(t / V.NI) + h2(t, q, 302));
    for (let k = 0; k < n; k++) {
      const key = q * 37 + k, a = h2(t, key, 303) * 6.283, d = R * Math.sqrt(h2(t, key, 304)), x = cx + Math.cos(a) * d, z = cz + Math.sin(a) * d;
      if (!free(x, z, wet)) continue;
      const at = place(V, M, x, z);
      if (at && !at.g.water && V.objVisible(at.u, at.v)) fn(at, x, z, h2(t, key, 305));
    }
  };
  for (let j = 0; j < V.NJ; j++)
    for (let i = 0; i < V.NI; i++) {
      const t = j * V.NI + i;
      if (M.kind[t] || !V.objVisible(V.i0 + i + 0.5, V.j0 + j + 0.5)) continue;
      const tc = M.cov[1][t], gc = M.cov[0][t], bare = M.cov[4][t], marsh = M.cov[3][t], edge = tc * (1 - tc) * 4;
      const roll = (q, rate) => h2(t, q, 300) < rate * more * A;
      // bush thickets along the woods edge
      if (edge > 0.5 && roll(1, 12 * edge))
        spawn(t, 1, 7 + Math.floor(h2(t, 1, 306) * 8), 3.5 * reach, false, (at, x, z, r) => {
          const sz = Math.max(2, Math.round((0.6 + r * 1.1) * pv * 0.9 * grow));
          add(at, cached(`b${sz}|${Math.floor(r * 4)}|${M.heath[t] > 0.5 ? 1 : 0}`, () => SP.bush(sz, Math.floor(r * 4) * 13 + sz, M.heath[t], r)), { mirror: r > 0.5 });
        });
      // mossy boulders in the woods and on bare ground
      // far off, the outcrop pass covers bare ground; boulders here are only the headland's shore band
      const boulders = camp ? 4 * (tc * 0.6 + bare * 1.5) + (M.cls[t] !== ROCK && M.toRock[t] <= 1 ? 10 : 0) : M.head[t] === 2 ? 30 : 0;
      if (boulders > 0 && roll(2, boulders) && fireD(...V.toW(V.i0 + i, V.j0 + j)) > 8)
        spawn(t, 2, 2 + Math.floor(h2(t, 2, 306) * 4), 2.5 * reach, false, (at, x, z, r) => {
          const sz = Math.max(1.5, (0.6 + r * r * 2.4) * pv * 0.9 * (camp ? 1 : 2)), moss = tc > 0.3 ? 0.75 + r * 0.25 : 0.2;
          add(at, cached(`r${Math.round(sz * 2)}|${Math.floor(r * 4)}|${moss > 0.4 ? 1 : 0}`, () => SP.rock(sz, Math.floor(r * 4) * 7 + 3, moss)), { mirror: r > 0.5 });
        });
      // fallen trunks under the trees
      if (tc > 0.4 && roll(3, 5 * tc) && fireD(...V.toW(V.i0 + i, V.j0 + j)) > 18)
        spawn(t, 3, 1 + Math.floor(h2(t, 3, 306) * 2.5), 3 * reach, false, (at, x, z, r) => {
          const len = Math.round((3 + r * 6) * pv * (camp ? 0.55 : 1)), rad = Math.max(1.5, 0.2 * pv * (camp ? 1.25 : 2));
          add(at, cached(`log${len}|${r < 0.5 ? 1 : -1}|${Math.round(rad)}`, () => SP.log(len, rad, r < 0.5 ? 1 : -1, len)), { bias: 1 });
        });
      // driftwood on beaches, bleached pale
      if (M.cov[5][t] > 0.25 && nextTo(i, j, [SEA, LAKE]) && roll(4, 40))
        spawn(t, 4, 1 + Math.floor(h2(t, 4, 306) * 2.5), 2 * reach, false, (at, x, z, r) => {
          const len = Math.round((2 + r * 4) * pv * (camp ? 0.55 : 1)), rad = Math.max(1.2, 0.15 * pv * (camp ? 1.25 : 2));
          add(at, cached(`drift${len}|${r < 0.5 ? 1 : -1}|${Math.round(rad)}`, () => SP.log(len, rad, r < 0.5 ? 1 : -1, len, true)), { bias: 1 });
        });
      // reed beds in the marsh and along still water
      const shore = nextTo(i, j, [LAKE, RIVER]) || (nextTo(i, j, [SEA]) && M.moist[t] > 0.5);
      if ((marsh > 0.15 || shore) && roll(5, 40 * (marsh + (shore ? (VIEW === "lake" ? 1.5 : 0.5) : 0))))
        spawn(t, 5, 8 + Math.floor(h2(t, 5, 306) * 12), 1.8 * reach * (camp ? 1 : 1.4), true, (at, x, z, r) => {
          const hp = Math.round((1.2 + r) * pv * (camp ? 1 : 3));
          add(at, cached(`reed${hp}|${Math.floor(r * 4)}`, () => SP.reeds(hp, Math.floor(r * 4) * 5 + hp)), { shadow: false });
        });
      // close up, mushrooms come up in rings under the trees and on fallen wood
      if (camp && tc > 0.3 && roll(7, 14 * tc) && fireD(...V.toW(V.i0 + i, V.j0 + j)) > 12)
        spawn(t, 7, 2 + Math.floor(h2(t, 7, 306) * 3), 1.2, false, (at, x, z, r) => {
          const ms = life("mushrooms", `${2 + Math.floor(r * 3)}|${Math.floor(h2(t, 7, 309) * 4)}`, 2 + Math.floor(r * 3), Math.floor(h2(t, 7, 309) * 4));
          if (ms) add(at, ms, { shadow: false, bias: 1 });
        });
      // close up, flowers bloom in drifts of one color
      if (camp && gc > 0.3 && roll(6, 12 * gc)) {
        const hue = h2(t, 6, 307);
        V.drifts.push({ x: V.toW(V.i0 + i + h2(t, 6, 301), V.j0 + j + h2(t, 6, 302))[0], z: V.toW(V.i0 + i + h2(t, 6, 301), V.j0 + j + h2(t, 6, 302))[1] });
        spawn(t, 6, 20 + Math.floor(h2(t, 6, 306) * 30), 1.5 + h2(t, 6, 308) * 2.5, false, (at, x, z, r) => {
          const hp = Math.round((0.25 + r * 0.3) * pv * 1.4), hh = (hue + (r - 0.5) * 0.08 + 1) % 1;
          add(at, cached(`f${hp}|${Math.floor(hh * 6)}`, () => SP.flower(hp, hh, hp)), { shadow: false, bias: 1 });
        });
      }
    }
}

// A screen-space prop hanging in the air (birds): drawn over everything, no shadow.
const sky = (sx, sy) => ({ sx: Math.round(sx), sy: Math.round(sy), z: 1e9 });
// Greedy pick of up to n candidates, best first, at least `gap` meters apart.
function spaced(cands, n, gap) {
  const out = [];
  for (const c of cands.sort((a, b) => b.s - a.s)) {
    if (out.length >= n) break;
    if (out.every((o) => Math.hypot(o.x - c.x, o.z - c.z) >= gap)) out.push(c);
  }
  return out;
}
// Land and water tiles in view as world points, with a few fields the pickers score on.
function tilesInView(V, M) {
  const out = [];
  for (let j = 0; j < V.NJ; j++)
    for (let i = 0; i < V.NI; i++) {
      const u = V.i0 + i + 0.5, v = V.j0 + j + 0.5;
      if (!V.visible(u, v)) continue;
      const t = j * V.NI + i, [x, z] = V.toW(u, v);
      out.push({ t, i, j, u, v, x, z, kind: M.kind[t], shore: M.shore[t], hc: M.hc[t] });
    }
  return out;
}
// Whether a screen point is comfortably inside the frame.
const onScreen = (V, sx, sy, m = 8) => sx > m * Z && sx < V.AW - m * Z && sy > m * Z && sy < V.AH - m * Z;

// Landmarks, all found in the data: the summit cairn, sea stacks off bare headlands, a flock wheeling over the coast or
// a cliff, eagles over the summit. Giant trees are picked in the tree pass and waterfalls in the terrain pass.
function landmarks(w, V, M, add, pv) {
  const far = FAR, lk = far ? 4 : 1.1, tiles = tilesInView(V, M);
  const S = summit(w), sAt = place(V, M, S.x, S.z);
  if (sAt && V.visible(sAt.u, sAt.v)) {
    const hp = Math.max(6 * Z, Math.round(1.6 * pv * lk)), c = life("cairn", hp, hp, 3);
    if (c) { add(sAt, c, { bias: 2 }); V.marks.push("cairn"); }
    const n = VIEW === "peak" ? 2 : 1;
    for (let k = 0; k < n; k++) {
      const sp = Math.round((far ? 11 : 16) * Z), b = life("bird", `eagle${sp}|${(FRAME + k * 3) & 3}`, sp, (FRAME + k * 3) & 3, "eagle", k);
      const a = PH + k * Math.PI, R = 22 * Z * (1 + k * 0.4);
      if (b) add(sky(sAt.sx + Math.cos(a) * R, sAt.sy - 55 * Z - k * 14 * Z + Math.sin(a) * R * 0.4), b, { shadow: false, bias: 0 });
    }
  }
  // sea stacks: in shallow sea off headlands whose ground is bare and high
  const land = tiles.filter((o) => !o.kind);
  const headland = (o) => { let best = 0; for (const l of land) { const d = Math.hypot(l.i - o.i, l.j - o.j); if (d <= 3.2) best = Math.max(best, M.cov[4][l.t] * Math.max(0, l.hc)); } return best; };
  const stackCands = tiles.filter((o) => o.kind === SEA && o.shore >= 1.5 && o.shore <= 3.5).map((o) => ({ ...o, s: headland(o) * (0.6 + 0.4 * h2(o.i, o.j, 310)) })).filter((o) => o.s > 3);
  const stacks = spaced(stackCands, far ? 4 : 2, V.tileM * 3.5);
  stacks.forEach((o, k) => {
    const g = M.ground(o.u, o.v);
    if (!g) return;
    const hp = Math.round(clamp((10 + Math.min(o.s, 40)) * pv * (far ? 3.2 : 1.8), 44 * Z, 112 * Z) * (k ? 0.5 + 0.4 * h2(k, 1, 311) : 1));
    const spr = life("seastack", `${hp}|${k % 3}`, hp, k % 3);
    if (!spr) return;
    const at = { z: V.cz(o.u, o.v, g.lev), sx: Math.round(V.sx(o.u, o.v)), sy: Math.round(V.sy(o.u, o.v, g.lev)) };
    add(at, spr, { shadow: false, bias: 2 });
    o.hp = hp;
    V.rings.push({ x: at.sx, y: at.sy, r: Math.max(3 * Z, hp * 0.26) }, { x: at.sx, y: at.sy, r: Math.max(5 * Z, hp * 0.4) });
    V.marks.push("stack");
  });
  // a flock wheeling above the highest point of the coast in view, or failing that the tallest cliff
  const coast = land.filter((o) => [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([a, b]) => { const k = M.at(o.i + a, o.j + b); return k >= 0 && M.kind[k] === SEA; }));
  const spot = (stacks[0] && { ...stacks[0], gull: true }) || spaced(coast.map((o) => ({ ...o, s: o.hc, gull: true })), 1, 0)[0] || spaced(land.map((o) => ({ ...o, s: M.C[o.t * 4] - Math.min(...M.C.subarray(o.t * 4, o.t * 4 + 4)) + o.hc * 0.01 })), 1, 0)[0];
  if (spot) {
    // over a stack the flock wheels out over the sea around its top, where white birds read against dark water
    // over a stack the flock wheels round its top on the seaward side, where grey birds read against dark water
    let seaward = [0, 0];
    if (spot.hp) for (const o of tiles) if (o.kind === SEA && o.shore >= 3 && Math.hypot(o.i - spot.i, o.j - spot.j) < 6) { seaward[0] += o.u - spot.u; seaward[1] += o.v - spot.v; }
    const sl = Math.hypot(...seaward) || 1, su = spot.u + (seaward[0] / sl) * 2.5, sv = spot.v + (seaward[1] / sl) * 2.5;
    const g = M.ground(spot.u, spot.v), cx = V.sx(su, sv), cy = V.sy(su, sv, g ? g.lev : 0) - (spot.hp ? spot.hp * 0.35 : (far ? 45 : 90) * Z);
    if (onScreen(V, cx, cy, 30)) {
      const n = 7 + Math.floor(h2(spot.i, spot.j, 312) * 5), kind = spot.gull ? "gull" : "crow";
      for (let k = 0; k < n; k++) {
        const sp = Math.round((far ? 9 : 10) * Z * (0.8 + 0.4 * h2(k, 2, 313))), f = (FRAME + k) & 3;
        const b = life("bird", `${kind}${sp}|${f}|${k & 1}`, sp, f, kind, k & 1);
        const a0 = h2(k, 3, 313) * TAU, R = (14 + h2(k, 4, 313) * 30) * Z, a = a0 + PH;
        // each bird wheels on its own small loop round a point of the flock, so eight frames close the loop
        const bx = cx + Math.cos(a0) * R, by = cy + Math.sin(a0) * R * 0.45, rr = 6 * Z;
        if (b) add(sky(bx + Math.cos(a) * rr, by + Math.sin(a) * rr * 0.5), b, { shadow: false, bias: 0 });
      }
      V.marks.push("flock");
    }
  }
}

// The same landmarks at map scale: the summit cairn, the two greatest trees standing in the open, stacks off the
// barest headlands with a few gulls over the best of them.
function islandMarks(w, V, M, add) {
  const S = summit(w), sAt = place(V, M, S.x, S.z);
  const c = life("cairn", `i${Math.round(7 * Z)}`, Math.round(7 * Z), 3);
  if (sAt && c) add(sAt, c, { bias: 3 });
  const open = w.trees.filter((t) => t.tall > 18 && w.fine(w.cover.tree, t.x, t.z) < 0.22).sort((a, b) => b.tall - a.tall);
  const giants = spaced(open.map((t) => ({ x: t.x, z: t.z, s: t.tall, kind: t.kind })), 2, 1500);
  for (const g of giants) {
    const at = place(V, M, g.x, g.z), hp = Math.round(15 * Z), spr = life("giant", `i${hp}|${g.kind}`, hp, g.kind === "pine" ? "pine" : "oak", 7);
    if (at && spr) add(at, spr, { bias: 3 });
  }
  const tiles = tilesInView(V, M), land = tiles.filter((o) => !o.kind);
  const cands = tiles.filter((o) => o.kind === SEA && o.shore === 1).map((o) => {
    let s = 0;
    for (const l of land) if (Math.abs(l.i - o.i) <= 1 && Math.abs(l.j - o.j) <= 1) s = Math.max(s, M.cov[4][l.t] * Math.max(0, l.hc));
    return { ...o, s: s * (0.6 + 0.4 * h2(o.i, o.j, 340)) };
  }).filter((o) => o.s > 4);
  const stacks = spaced(cands, 6, V.tileM * 5);
  stacks.forEach((o, k) => {
    const g = M.ground(o.u, o.v), hp = Math.round((6 + Math.min(o.s, 30) * 0.15) * Z), spr = life("seastack", `i${hp}|${k % 3}`, hp, k % 3);
    if (!g || !spr) return;
    const at = { z: V.cz(o.u, o.v, g.lev), sx: Math.round(V.sx(o.u, o.v)), sy: Math.round(V.sy(o.u, o.v, g.lev)) };
    add(at, spr, { shadow: false, bias: 2 });
    V.rings.push({ x: at.sx, y: at.sy, r: 2.5 * Z });
  });
  if (stacks[0]) {
    const o = stacks[0], g = M.ground(o.u, o.v), cx = V.sx(o.u, o.v), cy = V.sy(o.u, o.v, g.lev) - 18 * Z;
    for (let k = 0; k < 5; k++) {
      const sp = Math.round(4 * Z), f = (FRAME + k) & 3, b = life("bird", `gi${sp}|${f}`, sp, f, "gull", k & 1), a = h2(k, 5, 341) * TAU + PH;
      if (b) add(sky(cx + Math.cos(h2(k, 6, 341) * TAU) * 12 * Z + Math.cos(a) * 3 * Z, cy + Math.sin(h2(k, 6, 341) * TAU) * 5 * Z + Math.sin(a) * 1.5 * Z), b, { shadow: false, bias: 0 });
    }
  }
}

// The summit: the island's highest point, refined on the fine ground.
function summit(w) {
  if (w.summit) return w.summit;
  const I = w.isle, N = w.N;
  let k0 = 0;
  for (let k = 0; k < N * N; k++) if (I.height[k] > I.height[k0]) k0 = k;
  let x = w.START + (k0 % N) * w.CELL, z = w.START + Math.floor(k0 / N) * w.CELL;
  for (let r = 60; r >= 5; r /= 2) for (let n = 0; n < 12; n++) { const a = (n / 12) * TAU; if (w.heightAt(x + Math.cos(a) * r, z + Math.sin(a) * r) > w.heightAt(x, z)) { x += Math.cos(a) * r; z += Math.sin(a) * r; } }
  return (w.summit = { x, z, y: w.heightAt(x, z) });
}

// Wildlife: deer herds on meadows by the woods edge, rabbits, herons in marsh and by still water, fish jumping by the
// shore, gulls over the sea, butterflies over flower drifts by the camp.
function wildlife(w, V, M, add, pv, clear) {
  const far = FAR, lk = far ? 5.5 : 1.1, tiles = tilesInView(V, M), fire = w.camp.fire;
  const px = (m, lo) => Math.max(lo * Z, Math.round(m * pv * lk));
  const campFree = (x, z) => Math.hypot(x - fire.x, z - fire.z) > (far ? 34 * V.campOff : 30) && !clear(x, z, 22, 40);
  const tc = (x, z) => w.fine(w.cover.tree, x, z), gc = (x, z) => w.fine(w.cover.grass, x, z);
  const edgeOf = (x, z, r) => { let m = 0; for (let k = 0; k < 8; k++) m = Math.max(m, tc(x + Math.cos(k * 0.785) * r, z + Math.sin(k * 0.785) * r)); return m; };
  const spot = (x, z) => { const at = place(V, M, x, z); return at && !at.g.water && V.visible(at.u, at.v) && w.dry(x, z) ? at : null; };
  const land = tiles.filter((o) => !o.kind);
  const R = far ? 30 : 12;
  // deer: meadow, woods within a short run, well away from people
  const meadows = land.filter((o) => gc(o.x, o.z) > 0.35 && tc(o.x, o.z) < 0.3 && campFree(o.x, o.z)).map((o) => ({ ...o, s: edgeOf(o.x, o.z, R * 1.5) + h2(o.i, o.j, 320) * 0.4 })).filter((o) => o.s > 0.55);
  const dh = px(1.4, 9), herds = spaced(meadows, far ? 3 : 1, far ? 140 : 40);
  herds.forEach((hd, hk) => {
    const n = 3 + Math.floor(h2(hk, 1, 321) * 5), gap = (dh * 1.5) / V.k;
    for (let k = 0; k < n; k++) {
      const a = h2(hk, k, 322) * TAU, d = gap * (0.5 + Math.sqrt(k) * 0.9), x = hd.x + Math.cos(a) * d, z = hd.z + Math.sin(a) * d, at = spot(x, z);
      if (!at) continue;
      const pose = k === 0 ? "stand" : n > 4 && k === n - 1 ? "fawn" : h2(hk, k, 323) < 0.8 ? "graze" : "stand", facing = h2(hk, k, 324) < 0.5 ? 0 : 1;
      const d0 = life("deer", `${dh}|${pose}|${facing}|${k % 3}`, dh, pose, facing, k % 3);
      if (d0) add(at, d0, { bias: 2 });
    }
  });
  // rabbits: meadow edges by scrub or woods, in pairs
  const burrows = land.filter((o) => gc(o.x, o.z) > 0.3 && campFree(o.x, o.z)).map((o) => ({ ...o, s: w.fine(w.cover.shrub, o.x, o.z) + edgeOf(o.x, o.z, R) * 0.5 + h2(o.i, o.j, 325) * 0.5 }));
  const rh = px(0.35, 3);
  spaced(burrows, far ? 4 : 3, far ? 60 : 12).forEach((b, bk) => {
    for (let k = 0; k < 1 + (h2(bk, 1, 326) < 0.6 ? 1 : 0); k++) {
      const x = b.x + (h2(bk, k, 327) - 0.5) * rh * 3 / V.k * 2, z = b.z + (h2(bk, k, 328) - 0.5) * rh * 3 / V.k * 2, at = spot(x, z);
      const pose = h2(bk, k, 329) < 0.35 ? "hop" : "sit", r0 = life("rabbit", `${rh}|${pose}|${(bk + k) % 4}`, rh, pose, (bk + k) % 4);
      if (at && r0) add(at, r0, { bias: 1 });
    }
  });
  // herons: in the marsh, or on the margin of a lake or stream
  const wetEdge = (o) => [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([a, b]) => { const k = M.at(o.i + a, o.j + b); return k >= 0 && (M.kind[k] === LAKE || M.kind[k] === RIVER); });
  const fens = land.map((o) => ({ ...o, wet: wetEdge(o), s: M.cov[3][o.t] * 2 + (wetEdge(o) ? 1 : 0) + h2(o.i, o.j, 330) * 0.3 })).filter((o) => o.s > 0.8 && campFree(o.x, o.z));
  const hh = px(1, 8);
  spaced(fens, VIEW === "lake" ? 4 : far ? 2 : 1, far ? 90 : 20).forEach((o, k) => {
    const at = spot(o.x, o.z), pose = o.wet ? "fish" : "stand", hr = life("heron", `${hh}|${pose}|${k}`, hh, pose, k);
    if (at && hr) { add(at, hr, { bias: 2 }); V.marks.push("heron"); }
  });
  // fish jumping just off the shore; each shows for half the loop
  const shallows = tiles.filter((o) => o.kind && o.shore >= 1 && o.shore <= 2).map((o) => ({ ...o, s: h2(o.i, o.j, 331) }));
  spaced(shallows, VIEW === "lake" ? 7 : far ? 4 : 2, far ? 60 : 10).forEach((o, k) => {
    const off = Math.floor(h2(k, 1, 332) * 8), f = (FRAME + off) & 7;
    if (f >= 4) return;
    const g = M.ground(o.u, o.v), fs = life("fish", `${f}|${k & 1}|${Math.round(5 * Z)}`, f, k & 1, Math.round(5 * Z));
    if (g && fs) add({ z: V.cz(o.u, o.v, g.lev) + 1, sx: Math.round(V.sx(o.u, o.v)), sy: Math.round(V.sy(o.u, o.v, g.lev)) }, fs, { shadow: false, bias: 1 });
  });
  // gulls out over the sea, each on its own slow loop
  const open = tiles.filter((o) => o.kind === SEA && o.shore >= 2).map((o) => ({ ...o, s: h2(o.i, o.j, 333) }));
  spaced(open, far ? 4 : 2, far ? 120 : 30).forEach((o, k) => {
    const g = M.ground(o.u, o.v), sp = Math.round((far ? 7 : 10) * Z), f = (FRAME + k * 2) & 3, b = life("bird", `gull${sp}|${f}|${k & 1}`, sp, f, "gull", k & 1);
    if (!g || !b) return;
    const a = PH + k, cx = V.sx(o.u, o.v), cy = V.sy(o.u, o.v, g.lev) - (35 + h2(k, 2, 334) * 30) * Z;
    add(sky(cx + Math.cos(a) * 10 * Z, cy + Math.sin(a) * 4 * Z), b, { shadow: false, bias: 0 });
  });
  // butterflies over the flower drifts round the camp
  if (!far) (V.drifts || []).slice(0, 4).forEach((d, dk) => {
    for (let k = 0; k < 2; k++) {
      const at = spot(d.x + (h2(dk, k, 335) - 0.5) * 3, d.z + (h2(dk, k, 336) - 0.5) * 3), f = (FRAME + k * 2 + dk) & 3, bf = life("butterfly", `${f}|${(dk + k) % 3}`, f, (dk + k) % 3);
      if (at && bf) add({ ...at, sx: at.sx + Math.round(Math.cos(PH + k * 2 + dk) * 3 * Z), z: at.z + 4 }, bf, { shadow: false, bias: 6 });
    }
  });
}

// Where people have worn the grass away: round the fire, under the tents, by the woodpile, and the paths that link
// the fire to each tent, the woodpile, the nearest water and the nearest woods.
function trodden(w, V) {
  const cp = w.camp, fire = cp.fire, off = V.campOff, K = V.campK;
  const moved = (p) => ({ x: fire.x + (p.x - fire.x) * off, z: fire.z + (p.z - fire.z) * off });
  const tents = cp.tents.map((t) => ({ ...moved(t.at), size: t.size * K })), wp = moved(cp.woodpile);
  const nearest = (hit) => { for (let r = 6; r < 260; r += 2) for (let a = 0; a < 6.283; a += 0.04) { const x = fire.x + Math.cos(a) * r, z = fire.z + Math.sin(a) * r; if (hit(x, z)) return { x, z }; } return null; };
  const water = nearest((x, z) => w.fine(w.wet, x, z) > 0.5);
  let wood = null, wd = Infinity;
  for (const t of w.trees) { const d = Math.hypot(t.x - fire.x, t.z - fire.z); if (d < wd) { wd = d; wood = t; } }
  // each path is a meandering polyline of segments [x0, z0, x1, z1, half width]
  const segs = [];
  const path = (b, half, wander, seed) => {
    const len = Math.hypot(b.x - fire.x, b.z - fire.z), n = Math.max(2, Math.ceil(len / 2.5)), nx = -(b.z - fire.z) / len, nz = (b.x - fire.x) / len;
    let px = fire.x, pz = fire.z;
    for (let k = 1; k <= n; k++) {
      const t = k / n, o = k === n ? 0 : noise((t * len) / 14, 0.5, seed) * Math.min(wander, len * 0.2) * Math.min(1, t * 4, (1 - t) * 4);
      const x = fire.x + (b.x - fire.x) * t + nx * o, z = fire.z + (b.z - fire.z) * t + nz * o;
      segs.push([px, pz, x, z, half]);
      px = x; pz = z;
    }
  };
  path(wp, 0.45 * K, 0.5 * K, 95);
  tents.forEach((t, k) => path(t, 0.55 * K, 0.6 * K, 96 + k));
  if (water) path(water, 0.6 * K, 6 * K, 99);
  if (wood && wd < 200) path(wood, 0.5 * K, 5 * K, 100);
  const seg = (x, z, [ax, az, bx, bz]) => { const dx = bx - ax, dz = bz - az, t = clamp(((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz || 1), 0, 1); return Math.hypot(x - ax - dx * t, z - az - dz * t); };
  V.trodden = (x, z) => {
    let d = Math.hypot(x - fire.x, z - fire.z) - 3.4 * K;
    d = Math.min(d, Math.hypot(x - wp.x, z - wp.z) - 1.4 * K);
    for (const t of tents) d = Math.min(d, Math.hypot(x - t.x, z - t.z) - t.size * 0.7);
    const wob = fbm(x / (1.5 * K), z / (1.5 * K), 94, 2) * 0.3 * K;
    for (const s of segs) d = Math.min(d, seg(x, z, s) - s[4] + wob);
    return d;
  };
  V.fringe = 1.6 * K;
  V.woodsAt = wood;
  V.waterAt = water;
}

// The camp: tents as little 3D meshes, people and woodpile as sprites, the fire with stones, flames, glow and smoke.
function campObjects(w, V, M, O, add, pv) {
  const cp = w.camp, fire = cp.fire, off = V.campOff, K = V.campK;
  const moved = (p) => ({ x: fire.x + (p.x - fire.x) * off, z: fire.z + (p.z - fire.z) * off });
  const tents = cp.tents.map((t, k) => ({ ...moved(t.at), size: t.size * K, k }));
  const wp = moved(cp.woodpile);
  tents.forEach((t) => O.push(tentMesh(w, V, M, t, fire)));
  const around = FAR ? 6.5 : 1, hp = 1.75 * pv * K * (FAR ? 1.25 : 1);
  // how a figure at q looking at `look` is drawn: front, back or side, and which way
  const facingOf = (q, look) => {
    const dx = look.x - q.x, dz = look.z - q.z, du = dx * V.eu[0] + dz * V.eu[1], dv = dx * V.ev[0] + dz * V.ev[1], toCam = du + dv, across = du - dv;
    return { facing: Math.abs(across) > Math.abs(toCam) * 1.3 ? "side" : toCam > 0 ? "front" : "back", across };
  };
  const figure = (k, q, look, pose) => {
    const at = place(V, M, q.x, q.z);
    if (!at) return null;
    const { facing, across } = facingOf(q, look);
    const spr = cached(`man${k}|${facing}|${pose}|${hp > 12}`, () => SP.person(hp, P["c" + k], facing, pose, k * 7 + 1, across > 0 ? 1 : 0));
    add(at, spr, { mirror: facing !== "side" && across < 0, bias: 3 });
    return { at, facing, across };
  };
  // Roles: two sit at the fire and one tends it, one brings wood up from the pile, one fishes from the shore.
  const lerp = (a, b, t) => ({ x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t });
  // the waterline as drawn: step back from the water toward the fire until the tile under us is land
  let water = V.waterAt;
  if (water) {
    const d = Math.hypot(water.x - fire.x, water.z - fire.z);
    const dir = { x: (water.x - fire.x) / d, z: (water.z - fire.z) / d };
    let last = null;
    for (let r = 0; r < d * 2; r += V.tileM * 0.08) {
      const q = { x: fire.x + dir.x * r, z: fire.z + dir.z * r }, at = place(V, M, q.x, q.z);
      if (!at) break;
      if (at.g.water) break;
      last = q;
    }
    water = last ? { ...last, dir } : null;
  }
  cp.people.forEach((p, k) => {
    const q = { x: fire.x + (p.at.x - fire.x) * around, z: fire.z + (p.at.z - fire.z) * around };
    if (k === 2) {
      const c = lerp(wp, fire, 0.55), f = figure(k, c, fire, "stand");
      if (f) add({ ...f.at, sy: f.at.sy - Math.round(hp * 0.55), z: f.at.z + 3 }, cached(`bundle${Math.round(hp)}`, () => SP.log(Math.max(4, Math.round(hp * 0.45)), Math.max(1.5, hp * 0.08), 1, 5)), { shadow: false, bias: 4 });
    } else if (k === 4 && water) {
      const back = V.tileM * 0.04, d = Math.hypot(water.x - fire.x, water.z - fire.z), at0 = lerp(water, fire, back / d);
      const f = figure(k, at0, V.waterAt, "stand");
      if (f) {
        const side = f.across < 0 ? -1 : 1, len = Math.round(hp * 0.9);
        add({ ...f.at, sx: f.at.sx + side * Math.round(hp * 0.2), sy: f.at.sy - Math.round(hp * 0.45), z: f.at.z + 4 }, cached(`rod${len}|${side}`, () => SP.rod(len, side)), { shadow: false, bias: 4 });
      }
    } else figure(k, q, fire, k === 1 || k === 3 ? "sit" : "stand");
  });
  // the canoe pulled up on the shore beside the fisher, bow toward the water
  if (water) {
    const nx = water.dir.x, nz = water.dir.z;
    const along = V.tileM * (FAR ? 0.6 : 0.55), c = { x: water.x - nx * V.tileM * 0.05 - nz * along, z: water.z - nz * V.tileM * 0.05 + nx * along };
    const at = place(V, M, c.x, c.z), du = nx * V.eu[0] + nz * V.eu[1], dv = nx * V.ev[0] + nz * V.ev[1];
    const dir = Math.abs(du) > Math.abs(dv) ? (du > 0 ? 0 : 2) : dv > 0 ? 1 : 3, len = Math.round(4.5 * pv * (FAR ? 3.2 : 1.1));
    const cn = life("canoe", `${len}|${dir}`, len, dir, 2);
    if (at && cn) { add(at, cn, { shadow: false, bias: 2 }); V.marks.push("canoe"); }
  }
  const wpAt = place(V, M, wp.x, wp.z);
  if (wpAt) add(wpAt, cached("wood", () => SP.woodpile(Math.max(1, Math.round(0.14 * pv * K)), 3)));
  const f = place(V, M, fire.x, fire.z);
  if (!f) return;
  // ring of stones
  for (let k = 0; k < 9; k++) {
    const a = (k / 9) * Math.PI * 2 + 0.3, r = 0.62 * K;
    const at = place(V, M, fire.x + Math.cos(a) * r, fire.z + Math.sin(a) * r);
    if (at) add(at, cached(`st${k % 3}`, () => SP.rock(Math.max(1.5, 0.28 * pv * K), k % 3, 0)), { shadow: false, bias: 1 });
  }
  const fl = Math.max(4, Math.round(1.25 * pv * K * (VIEW === "valley" ? 1.1 : 1)));
  add({ ...f, z: f.z + 1 }, cached("embers", () => embers(fl)), { shadow: false, bias: 2 });
  add({ ...f, z: f.z + 2, sy: f.sy + 1 }, cached(`flames${FRAME}`, () => SP.flames(fl, 5 + FRAME)), { shadow: false, bias: 3 });
  V.fireAt = { x: f.sx, y: f.sy, r: Math.round(3.6 * pv * K * (VIEW === "valley" ? 1.05 : 1.5)), boost: THEME === "adventure" ? 0.6 : 0 };
  const wind = w.isle.wind || [1, 0], wu = wind[0] * V.eu[0] + wind[1] * V.eu[1], wv = wind[0] * V.ev[0] + wind[1] * V.ev[1];
  // the wind on screen: sideways it leans the column, toward or away from us it only shortens it a little
  const wl = Math.hypot(wu, wv) || 1;
  V.smokes = [{ x: f.sx, y: f.sy - fl, h: (VIEW === "camp" ? 110 : 42) * Z, r: (VIEW === "camp" ? 4.4 : 1.7) * Z, drift: clamp(((wu - wv) / wl) * 0.25, -0.3, 0.3), sink: ((wu + wv) / wl) * 0.25 }];
}

function embers(fl) {
  const w = Math.max(5, Math.round(fl * 1.3)), S = new Spr(w + 2, 5, (w + 2) >> 1, 3);
  for (let x = 0; x < w + 2; x++) {
    const d = Math.abs(x - (w + 2) / 2) / ((w + 2) / 2);
    S.set(x, 3, d < 0.9 ? (h2(x, 1) < 0.4 ? P.f1 : P.d0) : 255);
    S.set(x, 2, d < 0.6 ? (h2(x, 2) < 0.5 ? P.f0 : P.ink) : 255);
  }
  return S;
}

// A pitched tent or a pole tent, built from triangles so its slopes shade and sort like the ground.
function tentMesh(w, V, M, t, fire) {
  const at = place(V, M, t.x, t.z);
  const dirx = fire.x - t.x, dirz = fire.z - t.z, dl = Math.hypot(dirx, dirz) || 1, fx = dirx / dl, fz = dirz / dl;
  const base = at ? at.g.lev : 0, s = t.size, vert = 1 / (V.levelM * V.exag);
  // local (a toward the fire, b across, h up) in meters to (u, v, level), keeping the local point for texturing
  const P3 = (a, b, hh) => { const x = t.x + fx * a - fz * b, z = t.z + fz * a + fx * b, [u, v] = V.toUV(x, z); return [u, v, base + hh * vert, a, b, hh]; };
  const faces = [];
  const cloth = [P.c0, P.c1, P.c2, P.c3, P.c4][t.k + 1] ?? P.c0;
  const mats = [
    { r: ramp("d2", "d3", "s0", "s1", "s2", "s3"), seam: P.s0 },
    { r: ramp("d0", "d1", "d2", "d3", "d4", "d5"), seam: P.d1 },
    { r: ramp("d1", "d2", "d3", "d4", "d5", "s2"), seam: P.d2 },
  ];
  const mat = mats[t.k % 3];
  if (t.k === 2) {
    // pole tent: a cone of hide on a ring of poles
    const r = s * 0.55, hh = s * 1.0, n = 16, apex = P3(0, 0, hh);
    for (let q = 0; q < n; q++) {
      const a0 = (q / n) * Math.PI * 2, a1 = ((q + 1) / n) * Math.PI * 2;
      faces.push({ p: [P3(Math.cos(a0) * r, Math.sin(a0) * r, 0), P3(Math.cos(a1) * r, Math.sin(a1) * r, 0), apex], mat, cone: true, band: cloth, hh, s });
    }
    faces.push({ p: [P3(r * 0.99, -r * 0.28, 0), P3(r * 0.99, r * 0.28, 0), P3(r * 0.57, 0, hh * 0.46)], dark: true });
    for (let q = 0; q < 6; q++) {
      const a = (q / 6) * Math.PI * 2 + 0.4;
      faces.push({ line: [P3(Math.cos(a) * r * 0.08, Math.sin(a) * r * 0.08, hh * 0.92), P3(-Math.cos(a) * r * 0.26, -Math.sin(a) * r * 0.26, hh * 1.3)], col: q & 1 ? P.d1 : P.d2 });
    }
  } else {
    const L = s * 0.55, B2 = s * 0.44, hh = s * 0.5;
    const fl = P3(L, -B2, 0), fr = P3(L, B2, 0), bl = P3(-L, -B2, 0), br = P3(-L, B2, 0), rf = P3(L, 0, hh), rb = P3(-L, 0, hh);
    const roof = { mat, roof: true, hh, s };
    faces.push({ p: [bl, fl, rf], ...roof }, { p: [bl, rf, rb], ...roof }, { p: [fr, br, rb], ...roof }, { p: [fr, rb, rf], ...roof });
    faces.push({ p: [fl, fr, rf], mat, end: true, hh }, { p: [br, bl, rb], mat, end: true, hh });
    faces.push({ p: [P3(L + 0.02, -B2 * 0.46, 0), P3(L + 0.02, B2 * 0.46, 0), P3(L + 0.02, 0, hh * 0.8)], dark: true });
    faces.push({ line: [P3(L, 0, hh), P3(L, 0, hh * 1.2)], col: P.d1 }, { line: [P3(-L, 0, hh), P3(-L, 0, hh * 1.2)], col: P.d1 });
    if (VIEW === "camp") for (const e of [1, -1]) for (const sd of [1, -1]) faces.push({ line: [P3(e * L, 0, hh * 1.1), P3(e * (L + s * 0.32), sd * B2 * 1.1, 0)], col: P.r4, thin: true });
  }
  return { z: at ? at.z : -1e9, mesh: faces, id: 0, base, tent: t };
}

// A tent's pixels, in a buffer that records each sprite pixel's column from its anchor (B.ax), carry this instead: a
// mesh pixel's depth already places it where it stands.
export const MESH_PX = -32768;
function drawMesh(B, V, o, id) {
  const disp = V.levelM * V.exag;
  for (const f of o.mesh) {
    if (f.line) { line3(B, V, f.line[0], f.line[1], f.col, id, f.thin); continue; }
    const [A, Bv, Cv] = f.p;
    const toM = (p) => [p[0] * V.tileM, p[1] * V.tileM, p[2] * disp];
    const a = toM(A), b = toM(Bv), c = toM(Cv);
    const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    let n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    const nl = Math.hypot(...n) || 1;
    n = n.map((q) => q / nl);
    if (n[2] < 0) n = n.map((q) => -q);
    const lit = n[0] * L3[0] + n[1] * L3[1] + n[2] * L3[2];
    tri(B, V.sx(A[0], A[1]), V.sy(A[0], A[1], A[2]), V.sx(Bv[0], Bv[1]), V.sy(Bv[0], Bv[1], Bv[2]), V.sx(Cv[0], Cv[1]), V.sy(Cv[0], Cv[1], Cv[2]), (p, x, y, la, lb, lc) => {
      const u = la * A[0] + lb * Bv[0] + lc * Cv[0], v = la * A[1] + lb * Bv[1] + lc * Cv[1], hz = la * A[2] + lb * Bv[2] + lc * Cv[2];
      const z = V.cz(u, v, hz) + (f.dark ? 1.5 : 0.5);
      if (z < B.z[p]) return;
      let col;
      if (f.dark) col = lc > 0.8 ? P.d0 : P.ink;
      else {
        const qa = la * A[3] + lb * Bv[3] + lc * Cv[3], qb = la * A[4] + lb * Bv[4] + lc * Cv[4], qh = la * A[5] + lb * Bv[5] + lc * Cv[5], fh = qh / f.hh;
        let val = 0.9 + (lit + 0.2) * 3.1 + (h2(x, y, 60) - 0.5) * 0.35;
        if (f.roof) {
          const pn = qa / (f.s * 0.24) + 20;
          if (pn - Math.floor(pn) < 0.09) val -= 0.9;
          if (fh > 0.93) val += 0.9;
          if (fh < 0.07) val -= 1;
        } else if (f.end) {
          if (fh < 0.07) val -= 1;
        } else if (f.cone) {
          if (Math.abs(fh - 0.3) < 0.05) { col = fh > 0.31 ? SHADOW[f.band] : f.band; }
          else if (Math.abs(fh - 0.36) < 0.012 || Math.abs(fh - 0.62) < 0.012) val -= 0.9;
          const ang = Math.atan2(qb, qa), pn = ang * 2.5 + 20;
          if (pn - Math.floor(pn) < 0.07 && fh < 0.85) val -= 0.7;
          if (fh > 0.84) val -= 1.3 * (fh - 0.84) * 8;
          if (fh < 0.05) val -= 1;
        }
        if (col === undefined) col = dith(f.mat.r, val, x, y);
      }
      B.c[p] = col; B.z[p] = z; B.id[p] = id;
      if (B.ax) B.ax[p] = MESH_PX;
    });
  }
}

function line3(B, V, a, b, col, id, thin) {
  const x0 = V.sx(a[0], a[1]), y0 = V.sy(a[0], a[1], a[2]), x1 = V.sx(b[0], b[1]), y1 = V.sy(b[0], b[1], b[2]);
  const n = Math.ceil(Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0))) + 1;
  for (let k = 0; k <= n; k++) {
    const t = k / n, x = Math.floor(x0 + (x1 - x0) * t), y = Math.floor(y0 + (y1 - y0) * t);
    if (x < 0 || y < 0 || x >= B.w || y >= B.h) continue;
    if (thin && (k & 1) && k > 2 && k < n - 2) continue;
    const p = y * B.w + x, z = V.cz(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t) + 1;
    if (z < B.z[p]) continue;
    B.c[p] = col; B.z[p] = z; B.id[p] = id;
    if (B.ax) B.ax[p] = MESH_PX;
  }
}

function meshShadow(B, V, o) {
  const len = (V.levelM * V.exag * V.cot) / V.tileM;
  const drop = (p) => { const hgt = p[2] - o.base; return [p[0] + V.sd[0] * hgt * len, p[1] + V.sd[1] * hgt * len, o.base]; };
  for (const f of o.mesh) {
    if (!f.p) continue;
    const [A, Bv, Cv] = f.p.map(drop);
    tri(B, V.sx(A[0], A[1]), V.sy(A[0], A[1], A[2]), V.sx(Bv[0], Bv[1]), V.sy(Bv[0], Bv[1], Bv[2]), V.sx(Cv[0], Cv[1]), V.sy(Cv[0], Cv[1], Cv[2]), (p, x, y) => shadowPx(B, x, y));
  }
}

function drawObjects(B, V, O) {
  O.sort((a, b) => a.z - b.z);
  if (!V.realtime)
    for (const o of O) {
      if (o.mesh) meshShadow(B, V, o);
      else if (o.shadow) castShadow(B, o.spr, o.sx, o.sy, V.shx, V.shy, o.mirror);
    }
  let id = 1;
  const meshes = [];
  for (const o of O) {
    id = (id % 65000) + 1;
    if (o.mesh) { drawMesh(B, V, o, id); meshes.push(id); }
    else blit(B, o.spr, o.sx, o.sy, o.z, id, o.mirror, o.bias);
    o.lid = id;
  }
  // dark outline where a tent meets anything behind it
  const ids = new Set(meshes), mark = [];
  for (let y = 1; y < B.h - 1; y++)
    for (let x = 1; x < B.w - 1; x++) {
      const p = y * B.w + x, me = B.id[p];
      if (!ids.has(me)) continue;
      for (const q of [p - 1, p + 1, p - B.w, p + B.w]) if (B.id[q] !== me && B.z[q] < B.z[p] - 0.5) { mark.push(p); break; }
    }
  for (const p of mark) B.c[p] = P.ink;
}

function fireGlow(B, V) {
  const f = V.fireAt;
  if (!f) return;
  const R = f.r;
  for (let y = Math.floor(f.y - R * 0.6); y <= f.y + R * 0.6; y++)
    for (let x = Math.floor(f.x - R); x <= f.x + R; x++) {
      if (x < 0 || y < 0 || x >= B.w || y >= B.h) continue;
      const d = Math.hypot((x - f.x) / R, (y - f.y) / (R * 0.55));
      if (d >= 1) continue;
      const p = y * B.w + x, c = B.c[p];
      if (B.id[p] !== 0) continue;
      const a = (1 - d) * (2.2 + (f.boost || 0) * 2);
      if (bayer(x, y) < a) B.c[p] = GLOW[c];
      if (bayer(x, y) < a - 1) B.c[p] = GLOW[B.c[p]];
      if (bayer(x, y) < a - 1.7) B.c[p] = GLOW[B.c[p]];
      if (bayer(x, y) < a - 2.6) B.c[p] = GLOW[B.c[p]];
    }
}

// Smoke: a thin column that leans off downwind, swells a little, breaks into separate puffs and fades out. Puffs sit
// at even steps of q and move up an eighth of a step each frame; rising faster than they swell is what pulls the column
// apart. Every wobble is a smooth function of height, so frame 8 would be frame 0 again.
function drawSmoke(B, V) {
  for (const s of V.smokes || []) {
    const n = Math.max(5, Math.round(s.h / (s.r * 2.2)));
    for (let k = n; k >= 0; k--) {
      const q = (k + FRAME / 8) / (n + 1), t = q ** 1.8, rise = s.h * t;
      const r = s.r * (0.6 + t * 1.8) * (0.8 + 0.4 * (noise(t * 9, 1.5, 77) + 0.5));
      const lean = (s.drift || 0) * s.h * t ** 1.6;
      const cx = s.x + lean + Math.sin(t * 5 + 1) * s.r * 0.6 * t + noise(t * 7, 3.5, 78) * r * 0.5 * Math.min(1, t * 3);
      const cy = s.y - rise + Math.abs(lean) * (s.sink || 0), alpha = Math.min(1, q * 14) * (1.2 - t * 1.25);
      if (alpha <= 0) continue;
      for (let y = Math.floor(cy - r); y <= cy + r; y++)
        for (let x = Math.floor(cx - r); x <= cx + r; x++) {
          if (x < 0 || y < 0 || x >= B.w || y >= B.h) continue;
          const dx = (x + 0.5 - cx) / r, dy = (y + 0.5 - cy) / r, d = dx * dx + dy * dy;
          if (d > 1 || bayer(x, y) > alpha * (1.3 - d * 0.8)) continue;
          const l = -(dx * 0.7 + dy * 0.75) + (h2(x, y, 78) - 0.5) * 0.2;
          B.c[y * B.w + x] = d > 0.7 && dx + dy > 0.25 ? P.r4 : l > 0.35 ? P.snow : P.r5;
        }
    }
  }
}

// The view config at the requested pixel size: tile width and level step in art pixels scale with Z, rounded so tiles
// stay a whole 2:1 diamond.
function scaled(c) {
  if (PX === 2) return c;
  return { ...c, S: PX, W: Math.max(8, 4 * Math.round((c.W * Z) / 4)), lp: Math.max(1, Math.round(c.lp * Z)), foam: c.foam * Z, cell: c.cell.map((v) => Math.max(2, Math.round(v * Z))) };
}

// Island weather: a few small cumulus drifting over the land, each with its soft shadow on the ground below and to the
// lower right, away from the sun. They drift on a small loop so the eight frames close.
function clouds(B, V, M) {
  if (VIEW !== "island" || THEME !== "adventure") return;
  const land = tilesInView(V, M).filter((o) => !o.kind).map((o) => ({ ...o, s: h2(o.i, o.j, 350) }));
  const picks = spaced(land, 4, V.tileM * 9), hgt = 34 * Z;
  const cl = picks.map((o, k) => {
    const g = M.ground(o.u, o.v), gx = V.sx(o.u, o.v), gy = V.sy(o.u, o.v, g ? g.lev : 0);
    const dx = Math.cos(PH + k) * 2 * Z, dy = Math.sin(PH + k) * Z;
    const n = 6 + Math.floor(h2(k, 1, 351) * 4), R = (7 + h2(k, 2, 351) * 5) * Z, blobs = [];
    // puffs along a flat base, taller toward the middle, and a few more piled on top
    for (let q = 0; q < n; q++) { const f = q / (n - 1) - 0.5, r = R * (0.45 + (1 - Math.abs(f) * 1.6) * 0.45 + h2(k, q, 355) * 0.2); blobs.push([f * R * 3.2, -r * 0.55, r]); }
    for (let q = 0; q < 3; q++) blobs.push([(h2(k, q, 356) - 0.5) * R * 1.4, -R * (0.9 + h2(k, q, 357) * 0.4), R * (0.5 + h2(k, q, 358) * 0.25)]);
    return { x: gx + dx, y: gy - hgt + dy, sx: gx + dx + 14 * Z, sy: gy - hgt + dy + 24 * Z, blobs, R };
  });
  const inside = (c, x, y, sq) => { let best = -1; for (const [bx, by, br] of c.blobs) { const ex = (x - bx) / br, ey = (y - by) / (br * sq); best = Math.max(best, 1 - (ex * ex + ey * ey)); } return best; };
  for (const c of cl) {
    // the shadow: the cloud's outline flattened onto the ground, darkened by a soft dither toward its middle
    for (let y = Math.floor(c.sy - c.R * 1.4); y <= c.sy + c.R * 0.6; y++)
      for (let x = Math.floor(c.sx - c.R * 3); x <= c.sx + c.R * 3; x++) {
        if (x < 0 || y < 0 || x >= B.w || y >= B.h) continue;
        const d = inside(c, x - c.sx, (y - c.sy) * 1.6, 1);
        if (d > 0 && bayer(x, y) < 0.35 + d * 1.5) { const p = y * B.w + x; B.c[p] = DARKER[B.c[p]] !== B.c[p] ? DARKER[B.c[p]] : SHADOW[B.c[p]]; }
      }
  }
  for (const c of cl)
    for (let y = Math.floor(c.y - c.R * 2.2); y <= c.y + 1; y++)
      for (let x = Math.floor(c.x - c.R * 2.8); x <= c.x + c.R * 2.8; x++) {
        if (x < 0 || y < 0 || x >= B.w || y >= B.h) continue;
        const lx = x - c.x, ly = y - c.y, d = inside(c, lx, ly, 1);
        // feathered edge: the outermost ring of each puff thins out by ordered dither
        if (d <= 0 || (d < 0.3 && bayer(x, y) > d / 0.3)) continue;
        // lit from the upper left, grey toward the flat underside
        // light from the upper left: a point is lit if the cloud does not continue toward the sun from it
        const toSun = inside(c, lx - 2.5 * Z, ly - 2.5 * Z, 1), belly = (ly + c.R * 0.6) / (c.R * 0.6);
        let col = toSun <= 0.05 ? P.snow : toSun < 0.4 ? P.haze2 : P.haze;
        // the underside greys by ordered dither toward the flat base
        if (belly > 0.3 && bayer(x, y) < (belly - 0.3) * 1.6) col = belly > 0.8 && bayer(x + 2, y) < belly - 0.8 ? P.r4 : P.r5;
        B.c[y * B.w + x] = col;
      }
}

// Surf round the foot of each sea stack: broken white rings on the water, one step out every other frame.
function rings(B, V) {
  V.rings.forEach((r, k) => {
    const R0 = r.r * (1 + 0.1 * Math.sin(PH + k)), outer = k & 1;
    for (let a = 0; a < TAU; a += 0.35 / R0) {
      // broken arcs of foam, their radius and width wandering round the stack
      const n = noise(a * 1.7 + k * 3.1, FRAME * 0.25, 92), R = R0 * (1 + 0.18 * noise(a * 2.3, k, 93));
      if (n < (outer ? 0.15 : -0.1)) continue;
      const wdt = n > 0.35 && !outer ? 2 : 1;
      for (let d = 0; d < wdt; d++) {
        const x = Math.round(r.x + Math.cos(a) * (R + d)), y = Math.round(r.y + Math.sin(a) * (R + d) * 0.5);
        if (x < 0 || y < 0 || x >= B.w || y >= B.h) continue;
        const p = y * B.w + x;
        if (B.id[p] === 0 && h2(x, y + FRAME, 90) < (outer ? 0.5 : 0.85)) B.c[p] = n > 0.3 && !outer ? P.w7 : P.w6;
      }
    }
  });
}
// Spray at the foot of every waterfall: a cloud of white and pale droplets that churns frame to frame.
function spray(B, V) {
  for (const f of V.falls) {
    const w = Math.abs(f.x1 - f.x0), cx = (f.x0 + f.x1) / 2, R = Math.max(3 * Z, Math.min(w * 0.6, f.drop * 0.5 + 2 * Z));
    for (let y = Math.floor(f.y - R * 1.2); y <= f.y + R * 0.4; y++)
      for (let x = Math.floor(cx - w / 2 - R * 0.4); x <= cx + w / 2 + R * 0.4; x++) {
        if (x < 0 || y < 0 || x >= B.w || y >= B.h) continue;
        const dx = Math.max(0, Math.abs(x - cx) - w / 2) / (R * 0.6 + 1), dy = (y - f.y) / R, d = dx * dx + dy * dy;
        if (d > 1) continue;
        const q = h2(x, y + FRAME * 3, 91);
        if (q < (1 - d) * 0.55) B.c[y * B.w + x] = q < (1 - d) * 0.25 ? P.w7 : P.w6;
      }
  }
}

// Morning mist lies in the lowest hollows and over lakes and streams, in wisps drawn out along the wind. Returns 0..255.
function mistField(w, V) {
  if (THEME !== "adventure" && THEME !== "dawn") return null;
  const wind = w.isle.wind || [1, 0], wl = Math.hypot(...wind) || 1, ax = wind[0] / wl, az = wind[1] / wl;
  const R = Math.max(90, V.tileM * 4), wisp = Math.max(30, V.tileM * 1.6), fireAt = w.camp.fire, clearR = VIEW === "camp" ? 26 : 16 * (V.campOff || 1);
  return (x, z, kind, K, fu, fv, sy) => {
    const clearing = smooth(clearR, clearR * 1.7, Math.hypot(x - fireAt.x, z - fireAt.z));
    if (clearing <= 0) return 0;
    if (kind === LAKE || kind === RIVER) {
      // one soft band lying a little off the far shore, feathered along its length; negative marks water mist
      const c = K.sc, dist = c ? (c[0] * (1 - fu) + c[1] * fu) * (1 - fv) + (c[3] * (1 - fu) + c[2] * fu) * fv : 3;
      const band = smooth(0.5, 1.4, dist) * (1 - smooth(2.4, 4.2, dist)), far = 1 - smooth(0.35, 0.7, sy / V.AH);
      const feather = clamp(0.5 + fbm((x * ax + z * az) / (wisp * 5), (-x * az + z * ax) / (wisp * 5), 59, 2) * 1.6, 0, 1);
      return -Math.round(255 * band * far * feather * clearing);
    }
    let m = 0;
    if (K && (K.cls === ROCK || K.cls === HILL) && FAR) return 0;
    if (!kind) {
      const h = w.heightAt(x, z), around = (w.heightAt(x + R, z) + w.heightAt(x - R, z) + w.heightAt(x, z + R) + w.heightAt(x, z - R)) / 4;
      m = Math.max(smooth(0.93, 0.8, w.fine(w.sky, x, z)) * 0.8, smooth(-2, -14, h - around) * 0.9, w.fine(w.river, x, z) * 0.7, smooth(4, 1, h) * 0.5);
    }
    m *= clearing;
    if (m <= 0) return 0;
    const along = x * ax + z * az, across = -x * az + z * ax;
    // thin bands lying across the wind, broken up into wisps
    const band = 0.5 + 0.5 * Math.sin(across / (wisp * 0.45) + fbm(along / (wisp * 4), across / (wisp * 2), 58, 2) * 3);
    return Math.round(255 * m * clamp((0.35 + fbm(along / (wisp * 3), across / wisp, 57, 2) * 1.6) * (0.3 + band ** 1.5 * 0.9), 0, 1));
  };
}
// Scattered threshold for air: a hash softened by its neighbours so the pixels clump into soft specks, not a grid.
const airy = (x, y) => (h2(x, y, 401) * 2 + h2(x >> 1, y >> 1, 402) + h2((x + 1) >> 1, y >> 1, 403)) / 4;
function mist(B) {
  if (!B.hasMist) return;
  for (let p = 0; p < B.w * B.h; p++) {
    const m = B.mist[p];
    if (m && airy(p % B.w, (p / B.w) | 0) < m * (VIEW === "camp" ? 0.0024 : 0.0026)) B.c[p] = MIST[B.c[p]];
    // over water: a sparse ordered dither, at most a third of the pixels, in the pale haze tone
    const mw = B.mistW[p];
    if (mw && bayer(p % B.w, (p / B.w) | 0) < mw * 0.0016) B.c[p] = HAZE[HAZE[B.c[p]]];
  }
}

// Low sun: distance haze, dithered toward the horizon color over the top of the frame.
function haze(B) {
  if (!LOWSUN) return;
  const most = { adventure: 0.32, dusk: 0.55 }[THEME] ?? 0.5, reach = THEME === "adventure" ? 0.42 : 0.55;
  for (let y = 0; y < B.h; y++) {
    const a = most * Math.max(0, 1 - y / (B.h * reach)) ** 1.5;
    if (a <= 0) break;
    for (let x = 0; x < B.w; x++) if (bayer(x, y) < a) { const p = y * B.w + x; B.c[p] = HAZE[B.c[p]]; }
  }
}

async function main() {
  const cv = document.getElementById("view");
  const CW = window.innerWidth || 1280, CH = window.innerHeight || 720;
  cv.width = CW; cv.height = CH;
  const cfg = scaled(CFG[VIEW]), AW = Math.ceil(CW / cfg.S), AH = Math.ceil(CH / cfg.S);
  const w = grow(SEED);
  LIFE = await import("./life.js").catch((e) => (console.warn(`life.js not loaded: ${e.message}`), {}));
  const V = makeView(w, cfg, AW, AH);
  let M = buildMap(w, V);
  // the slope limiter can pull a tall summit down; frame the mountain where it is actually drawn
  if (VIEW === "peak") {
    const [u, v] = V.toUV(V.T.at.x, V.T.at.z), g = M.ground(u, v), want = V.T.at.y / V.levelM;
    if (g && want - g.lev > 2) {
      V.Y0 -= Math.round((want - g.lev) * V.lp);
      frameTiles(V, V.hl[0] / V.levelM, V.hl[1] / V.levelM, 40 * Z);
      V.NI = V.i1 - V.i0; V.NJ = V.j1 - V.j0;
      M = buildMap(w, V);
    }
  }
  if (V.tsun) V.shaded = shadowTest(V, M);
  V.mist = mistField(w, V);
  const B = new Buf(AW, AH);
  if (V.mist) { B.mist = new Uint8Array(AW * AH); B.mistW = new Uint8Array(AW * AH); B.hasMist = true; }
  B.c.fill(P.ink);
  const O = collectObjects(w, V, M);
  drawTerrain(B, w, V, M);
  rings(B, V);
  drawObjects(B, V, O);
  spray(B, V);
  mist(B);
  fireGlow(B, V);
  drawSmoke(B, V);
  clouds(B, V, M);
  haze(B);
  const c = w.camp, a = Math.atan2(-c.at.z, c.at.x), side = ["east", "northeast", "north", "northwest", "west", "southwest", "south", "southeast"][((Math.round(a / (Math.PI / 4)) % 8) + 8) % 8];
  const info = {
    island: `Island ${(w.SIZE / 1000).toFixed(1)} km across  ${w.trees.length.toLocaleString("en")} trees  ${c.people.length} nomads`,
    valley: `${side} shore  camp ${c.at.y.toFixed(1)} m above the sea`,
    camp: `Camp  ${c.people.length} nomads  ${c.tents.length} tents  1 fire`,
  }[VIEW];
  if (Q.get("debug")) console.warn(`${VIEW} marks ${[...new Set(V.marks)]} falls ${V.falls.length} rings ${V.rings.length} tileM ${V.tileM} exag ${V.exag.toFixed(2)} levelM ${V.levelM.toFixed(2)} target ${V.T.at.x.toFixed(0)},${V.T.at.z.toFixed(0)} y ${V.T.at.y.toFixed(0)}`);
  const off = Object.assign(document.createElement("canvas"), { width: AW, height: AH });
  B.toImage(off.getContext("2d"));
  const g = cv.getContext("2d");
  g.imageSmoothingEnabled = false;
  g.drawImage(off, 0, 0, AW * cfg.S, AH * cfg.S);
  // the chrome keeps its own 2x pixel grid whatever px the world uses
  if (UI) {
    const U = new Buf(Math.ceil(CW / 2), Math.ceil(CH / 2));
    U.c.fill(255);
    drawUI(U, `Nomads  seed ${SEED}`, info);
    const uc = Object.assign(document.createElement("canvas"), { width: U.w, height: U.h });
    U.toImage(uc.getContext("2d"), 255);
    g.drawImage(uc, 0, 0, U.w * 2, U.h * 2);
  }
  document.body.classList.add("ready");
}

// the still page runs itself; the live bake worker imports this file as a library
if (typeof window !== "undefined" && document.getElementById("view") && !globalThis.ISO_LIB) {
  const fail = (e) => { document.body.dataset.error = String((e && e.stack) || e); document.body.classList.add("failed"); };
  window.addEventListener("error", (e) => fail(e.error || e.message));
  window.addEventListener("unhandledrejection", (e) => fail(e.reason));
  main().catch(fail);
}

export { CFG, buildMap, drawTerrain, drawObjects, place, cached, SEA, LAKE, RIVER };
