// How people get about and what they carry, by the physics of walking and load carriage (docs/research/people-constants.md
// sec. 6). How fast someone walks or runs over the ground at a point and what it costs their body, how long each tile's
// ground takes to cross for the least-time way over the island, how far they reach, and how much mass and bulk they can
// hold. Speeds are m/s and costs W; ticks come in only through sky.ts TICK_S, where walk.ts spends them.
import { GROUND, SIZE, TILE_M, TILES, groundClass } from "../terrain/flora";
import { CELL, N } from "../terrain/grid";
import { INTERCEPT_SNOW, SNOW_DOY, snowAt, snowDepth } from "./air";
import { radius, type Bed } from "./combustion";
import { frameOf, grown, realAge } from "./body";
import { physOf, stackPhys } from "./fuel";
import { trunkOf } from "./mechanics";
import { p } from "./materials";
import { DAY, seasonAt } from "./sky";
import { streamNow } from "./streams";
import { ageOf, groundOf, type Agent, type Stack, type World } from "./world";

// ---------- the body's size (secs. 6a, 6i) ----------
// Drillis and Contini's segments as shares of stature (R1062): shoulder to fingertip 0.440 (upper arm 0.186, forearm
// 0.146, hand 0.108) and the shoulders 0.259 across. The leg is a fixed share too, so walkers of any size go alike at
// equal Froude number (Alexander and Jayes, R1002).
const ARM = 0.186 + 0.146 + 0.108, SHOULDERS = 0.259;
// How far someone reaches from where they stand: half their shoulders and an arm [derived]. REACH is a grown body's
// (body.ts grown, 1.6964 m).
export const armFor = (stature: number) => (ARM + SHOULDERS / 2) * stature;
export const REACH = armFor(1.6964);
export const armOf = (w: World, a: Agent) => armFor(frameOf(w, a).m);
// How high someone reaches overhead, m: shoulder height, 0.818 of stature (R1062), and an arm [derived].
export const overheadOf = (w: World, a: Agent) => (0.818 + ARM) * frameOf(w, a).m;
// How far from a thing's middle its edge stands, m: a trunk's width at breast height for a tree, a sapling or what was one
// (mechanics.ts trunkOf, a stump's own girth where it was kept), a fire's heap (combustion.ts radius), the width the thing
// has for anything else.
type Sized = { kind: string; size: number; species?: string; girth?: number; bed?: Bed };
export const radiusOf = (t: Sized) =>
  t.kind === "tree" || t.kind === "sapling" ? trunkOf(t) / 2
  : t.kind === "stump" || t.kind === "burnt_stump" ? (t.girth ?? trunkOf(t)) / 2
  : t.kind === "fire" && t.bed ? radius(t.bed)
  : t.size / 2;
// How near someone of arm's length `arm` has to stand to work on a thing: an arm's length from its edge.
export const reachOf = (t: Sized, arm = REACH) => arm + radiusOf(t);

// ---------- the ground (secs. 6c to 6e) ----------
// Soule and Goldman's terrain coefficients as Richmond, Potter and Santee recommend them for Pandolf's equation (R1003):
// blacktop 1.0, dirt road 1.1, light brush 1.2, heavy brush 1.5, swamp 1.8, loose sand 2.1. Each of the generator's
// ground classes (flora.ts GROUND) takes the nearest: grass, grass with outcrops and the forest floor as light brush,
// scrub as heavy brush, marsh as swamp, bare ground as a dirt road, sand as loose sand, bare rock as blacktop
// [analogue]. A stream's bed is walked as bare ground, its water counted apart (wadeOf); the sea and lakes are never
// walked but frozen over, as bare ground [analogue].
const ETA: Record<(typeof GROUND)[number], number> = {
  grassland: 1.2, "forest floor": 1.2, scrub: 1.5, marsh: 1.8, "bare ground": 1.1, sand: 2.1, "grass with outcrops": 1.2, "bare rock": 1.0,
  "": 1.2, sea: 1.1, lake: 1.1, stream: 1.1,
};
const TRODDEN = ETA["bare ground"];
// A trodden path is the ground worn toward a dirt road's coefficient, as far as its tile's wear (world.ts paths, 0 to 9)
// has gone [gap: how many passes beat a cover bare is not wired to the wear count].
const worn = (eta: number, wear: number) => (eta > TRODDEN ? eta + ((TRODDEN - eta) * Math.min(9, wear)) / 9 : eta);
// Richmond, Potter, Looney and Santee's coefficient on snow (R1004): the footprint sinks z = h (1 - rho / 1.186) cm into
// snow h cm deep of density rho g/cm3, and eta = 0.0005 z^3 + 0.0001 z^2 + 0.1072 z + 1.2604.
export function snowEta(h: number, rho: number) {
  const z = h * 100 * Math.max(0, 1 - rho / 1.186);
  return 0.0005 * z ** 3 + 0.0001 * z * z + 0.1072 * z + 1.2604;
}
// The snow lying at a point now, m deep and g/cm3: each season's snowpack as deep as air.ts snowDepth has it, drawn between
// the seasons, less what the crowns hold off (air.ts INTERCEPT_SNOW), as the forage rule reads it; and the share of the
// ground it covers (air.ts snowAt).
export function snowHere(w: World, px: number, py: number) {
  const { isle } = groundOf(w.seed), { s, f } = seasonAt(w.t), s1 = (s + 1) % 4;
  const c = Math.max(0, Math.min(N - 1, Math.floor((py * TILE_M) / CELL))) * N + Math.max(0, Math.min(N - 1, Math.floor((px * TILE_M) / CELL)));
  const a = isle.seasons[s].snowpack[c], b = isle.seasons[s1].snowpack[c], swe = a * (1 - f) + b * f;
  if (!(swe > 0)) return { h: 0, rho: 0, cover: 0 };
  const h = (snowDepth(a, SNOW_DOY[s]) * (1 - f) + snowDepth(b, SNOW_DOY[s1]) * f) * (1 - INTERCEPT_SNOW * Math.min(1, isle.tree[c]));
  return h > 0 ? { h, rho: swe / 1000 / h, cover: snowAt(w, px, py) } : { h: 0, rho: 0, cover: 0 };
}
// A ground's coefficient under the snow lying on its share of it [derived].
function underSnow(ground: number, snow: { h: number; rho: number; cover: number }) {
  return snow.h > 0 ? ground * (1 - snow.cover) + snowEta(snow.h, snow.rho) * snow.cover : ground;
}
// The terrain coefficient of the ground at a point now: its class, worn by its tile's path, under its snow.
export function etaAt(w: World, px: number, py: number) {
  const { isle, fine } = groundOf(w.seed), g = groundClass(isle, fine, px * TILE_M - SIZE / 2, py * TILE_M - SIZE / 2);
  return underSnow(worn(ETA[GROUND[g.cls]] ?? ETA[""], w.paths[Math.floor(py) * TILES + Math.floor(px)] ?? 0), snowHere(w, px, py));
}
// The water someone wades through at a point, m: a stream's depth where it runs (streams.ts), none elsewhere.
export function wadeOf(w: World, px: number, py: number) {
  const st = streamNow(w, px, py);
  return st && st.flowing ? st.depth : 0;
}

// ---------- walking (secs. 6b, 6f, 6h) ----------
// Tobler's hiking function (R1000): 6 e^(-3.5 |S + 0.05|) km/h on a slope S, rise over run, 5.04 km/h on the level: the
// grown walker's.
export const tobler = (S: number) => (6 / 3.6) * Math.exp(-3.5 * Math.abs(S + 0.05));
// At equal Froude number v^2 / gL (R1002), and legs a fixed share of stature, someone of stature m walks sqrt(m / grown)
// as fast as the grown walker [derived].
export const froude = (stature: number) => Math.sqrt(stature / grown(99).m);
// Pandolf, Givoni and Goldman's metabolic rate (R1005), W, for a body of W kg carrying L kg at V m/s up a grade of Gp% on
// ground of coefficient eta; below level, less Santee et al.'s correction (R1007); never less than standing with the
// load [derived].
export function pandolf(W: number, L: number, V: number, Gp: number, eta: number) {
  const stand = 1.5 * W + 2 * (W + L) * (L / W) ** 2;
  let m = stand + eta * (W + L) * (1.5 * V * V + 0.35 * V * Gp);
  if (Gp < 0) m -= eta * ((Gp * (W + L) * V) / 3.5 - ((W + L) * (Gp + 6) ** 2) / W + (25 - V * V));
  return Math.max(stand, m);
}
// The speed that costs least per metre by Pandolf's equation, sqrt((1.5 W + 2 (W + L)(L/W)^2) / (1.5 eta (W + L))), over the
// same unladen on blacktop: how the ground and the load slow a walker [derived]. Lejeune et al.'s walkers slowed on sand
// to 1.1 m/s from a firm 1.3 to 1.4 (in R1003's review), 0.79 of their speed, where this gives 0.69.
export function slowing(W: number, L: number, eta: number) {
  const l = L / W;
  return Math.sqrt((1.5 + 2 * (1 + l) * l * l) / (1.5 * eta * (1 + l)));
}
// Wading (Ivaniski-Mello et al., R1006): men 1.78 m tall in water to the knee, hip, navel and breastbone (28, 48, 63 and
// 73% of stature) chose 0.62, 0.54, 0.49 and 0.43 m/s at a net cost of 3.4, 4.1, 5.9 and 6.7 J/kg/m. A wader of another
// stature at the same share of it goes as the Froude number scales [derived]; between dry ground and the knee, straight
// from what walking dry gives [derived]; deeper than the breastbone, as there [gap: swimming].
const WADE: [share: number, v: number, cot: number][] = [[0.28, 0.62, 3.4], [0.48, 0.54, 4.1], [0.63, 0.49, 5.9], [0.73, 0.43, 6.7]];
function wading(share: number, dry: number, dryCot: number, stature: number) {
  const scale = Math.sqrt(stature / 1.78), [s0, v0, c0] = WADE[0];
  if (share <= s0) { const f = share / s0; return { v: dry + (v0 * scale - dry) * f, cot: dryCot + (c0 - dryCot) * f }; }
  const i = WADE.findIndex((r) => share <= r[0]);
  if (i < 0) { const [, v, cot] = WADE[WADE.length - 1]; return { v: v * scale, cot }; }
  const [sa, va, ca] = WADE[i - 1], [sb, vb, cb] = WADE[i], f = (share - sa) / (sb - sa);
  return { v: (va + (vb - va) * f) * scale, cot: ca + (cb - ca) * f };
}
// Walking in the dark (Kesler et al., R1011): healthy people took 14.3% longer over the same walk in near darkness (5
// lumens) than in ordinary light (1000); between the two, by the log of the light [derived]; darker still, as in near
// darkness [gap].
export function darkPace(lux: number) {
  const slow = 1 / 1.143;
  return lux >= 1000 ? 1 : lux <= 5 ? slow : slow + ((1 - slow) * Math.log(lux / 5)) / Math.log(1000 / 5);
}

// ---------- running (sec. 6g) ----------
// Minetti et al.'s net cost of running (R1008), J/kg/m on a gradient i from -0.45 to 0.45: 155.4 i^5 - 30.4 i^4 - 43.3 i^3
// + 46.3 i^2 + 19.5 i + 3.6, oxygen at their 20.9 J/ml.
export function runCost(i: number) {
  const x = Math.max(-0.45, Math.min(0.45, i));
  return 155.4 * x ** 5 - 30.4 * x ** 4 - 43.3 * x ** 3 + 46.3 * x * x + 19.5 * x + 3.6;
}
const O2_J = 20.9;
// The FRIEND registry's median VO2max (R1009), ml/kg/min, the mean of its men and women: 42.8 in their twenties, falling
// 9.75% a decade (the men's 9.2, the women's 10.3); anyone younger than twenty at the twenties' [gap: no children's data].
export const vo2max = (age: number) => 42.8 * 0.9025 ** (Math.max(0, age - 25) / 10);
// One MET, 3.5 ml/kg/min (R1010): what resting takes of it.
const REST_O2 = 3.5;
// Someone runs as fast as their aerobic power less resting carries them and their load, Minetti et al.'s v = E / Cr, on
// ground of coefficient eta as walking's [derived], and no faster downhill than on the level: Minetti et al.'s downhill
// racers ran a third as fast as their aerobic power allowed (R1008) [design].
export function runSpeed(W: number, L: number, age: number, i: number, eta: number) {
  return ((((vo2max(age) - REST_O2) * O2_J) / 60) * W) / (eta * runCost(Math.max(0, i)) * (W + L));
}

// ---------- a walker (secs. 6f to 6h) ----------
// What sets how someone goes for a tick: their mass, kg, and stature, m, what they carry, kg, their age in years, whether
// they run, and the light, lux.
export type Gait = { W: number; L: number; m: number; age: number; run: boolean; lux: number };
export function gaitOf(w: World, a: Agent, run: boolean, lux: number): Gait {
  const f = frameOf(w, a);
  return { W: f.kg, L: loadOf(w, a), m: f.m, age: realAge(ageOf(w, a)), run, lux };
}
// How someone goes over a stride from one point to another (in tiles), by the slope under it and the ground and water at
// its middle: m/s, and the power it takes, W. In water they wade, whether or not they would run.
export type Stride = { v: number; watts: number };
export function stride(w: World, g: Gait, x0: number, y0: number, x1: number, y1: number): Stride {
  const { fine } = groundOf(w.seed), len = Math.hypot(x1 - x0, y1 - y0) * TILE_M, mx = (x0 + x1) / 2, my = (y0 + y1) / 2;
  const rise = fine.heightAt(x1 * TILE_M - SIZE / 2, y1 * TILE_M - SIZE / 2) - fine.heightAt(x0 * TILE_M - SIZE / 2, y0 * TILE_M - SIZE / 2);
  const S = len > 1e-6 ? rise / len : 0, eta = etaAt(w, mx, my), wade = wadeOf(w, mx, my);
  let v = froude(g.m) * tobler(S) * slowing(g.W, g.L, eta), watts = pandolf(g.W, g.L, v, S * 100, eta);
  if (wade > 0) {
    const stand = 1.5 * g.W + 2 * (g.W + g.L) * (g.L / g.W) ** 2, wd = wading(wade / g.m, v, (watts - stand) / (v * (g.W + g.L)), g.m);
    v = wd.v;
    watts = stand + wd.cot * v * (g.W + g.L);
  } else if (g.run) {
    const r = runSpeed(g.W, g.L, g.age, S, eta);
    if (r > v) { v = r; watts = (vo2max(g.age) * O2_J * g.W) / 60; }
  }
  return { v: v * darkPace(g.lux), watts };
}

// ---------- routes (sec. 6j) ----------
// The terrain coefficient of a tile's ground for the least-time way across the island: the classes at its four cells'
// middles, averaged, once per island; worn by its path; under the snow at its middle, once a day.
const covers = new WeakMap<object, Float32Array>(), snows = new WeakMap<object, { day: number; snow: { h: number; rho: number; cover: number }[] }>();
export function tileEta(w: World, i: number) {
  const ground = groundOf(w.seed), tx = i % TILES, ty = (i - tx) / TILES;
  let c = covers.get(ground);
  if (!c) { c = new Float32Array(TILES * TILES).fill(NaN); covers.set(ground, c); }
  if (Number.isNaN(c[i])) {
    let sum = 0, n = 0;
    for (const [ox, oy] of [[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]]) {
      const g = groundClass(ground.isle, ground.fine, (tx + ox) * TILE_M - SIZE / 2, (ty + oy) * TILE_M - SIZE / 2), e = ETA[GROUND[g.cls]];
      if (e !== undefined && !g.water) { sum += e; n++; }
    }
    c[i] = n ? sum / n : TRODDEN;
  }
  const day = Math.floor(w.t / DAY);
  let s = snows.get(w);
  if (!s || s.day !== day) { s = { day, snow: [] }; snows.set(w, s); }
  return underSnow(worn(c[i], w.paths[i] ?? 0), (s.snow[i] ??= snowHere(w, tx + 0.5, ty + 0.5)));
}
// Seconds the grown, unladen walker takes from the middle of tile a to the middle of tile b, d tiles apart, the ground
// rising dh tile widths, over the two tiles' ground.
export const legTime = (w: World, a: number, b: number, d: number, dh: number) =>
  (d * TILE_M) / (tobler(dh / d) * slowing(1, 0, (tileEta(w, a) + tileEta(w, b)) / 2));
// The fastest anyone of grown size goes, m/s: down Tobler's best slope on blacktop, which no route beats.
export const FASTEST = tobler(-0.05);

// ---------- carrying (sec. 6i) ----------
// A stack's mass as it is, kg: its dry mass and the water in it (wetness.ts); and its bulk, m3, its dry stuff at its own
// density and its water at water's.
export const massOf = (w: World, s: Stack) => { const x = stackPhys(w.kinds, s); return x ? x.mass * (1 + (s.m ?? 0)) : 0; };
export const bulkOf = (w: World, s: Stack) => { const x = stackPhys(w.kinds, s); return x ? x.mass / x.rho + (x.mass * (s.m ?? 0)) / 1000 : 0; };
// What someone has on them, kg: what they hold and what they wear.
export const loadOf = (w: World, a: Agent) => a.inv.reduce((t, s) => t + massOf(w, s), a.wearing ? massOf(w, a.wearing) : 0);
const bulkHeld = (w: World, a: Agent) => a.inv.reduce((t, s) => t + bulkOf(w, s), 0);
// FM 21-18's approach march load, 45% of body mass (Knapik, Reynolds and Harman, R1012): the most anyone carries anywhere.
export const LOAD = 0.45;
// Things held together lie at random close packing, 0.64 of their bulk solid (Scott and Kilgour, R1013) [analogue].
const PACKING = 0.64;
// What a hollow thing holds, m3: the most a wall of its own area closes round, a sphere's [derived], its area its mass
// over its wall's density and thickness (fuel.ts). Whether it is hollow is what its kind's matter says (materials.ts
// container) [gap: a made thing's shape is not kept].
export function holdsOf(w: World, s: Stack) {
  const k = w.kinds[s.k];
  if (p(k, "container") < 0.6) return 0;
  const x = stackPhys(w.kinds, s) ?? physOf(w.kinds, k);
  return x && x.d > 0 ? (x.mass / (x.rho * x.d)) ** 1.5 / (6 * Math.sqrt(Math.PI)) : 0;
}
// How much someone can carry: kg by their body's mass, and bulk, m3, by an armful and whatever they hold that holds
// things. An armful is a bundle as round as both arms and the shoulders' width close round it, as long as the
// shoulders are wide (R1062) [derived].
export function capacityOf(w: World, a: Agent) {
  const f = frameOf(w, a), girth = (2 * ARM + SHOULDERS) * f.m;
  return { kg: LOAD * f.kg, m3: PACKING * (((girth * girth) / (4 * Math.PI)) * SHOULDERS * f.m + a.inv.reduce((t, s) => t + holdsOf(w, s), 0)) };
}
// Whether someone could take this up too, by its mass and its bulk with what they already carry; a bag or basket taken
// up brings its own room.
export function canHold(w: World, a: Agent, s: Stack) {
  const cap = capacityOf(w, a);
  return loadOf(w, a) + massOf(w, s) <= cap.kg && bulkHeld(w, a) + bulkOf(w, s) <= cap.m3 + holdsOf(w, s) * PACKING;
}
// How full their hands are: the greater of their load's share of what they can carry by mass and by bulk.
export function fullness(w: World, a: Agent) {
  const cap = capacityOf(w, a);
  return Math.max(loadOf(w, a) / cap.kg, bulkHeld(w, a) / cap.m3);
}
