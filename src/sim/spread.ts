// Everything in the world that burns burns as a bed of its own pieces (combustion.ts), and what lies near a burning bed
// takes its heat: the radiant share of what it gives off, from a point at its flame; the flame's own heat where the flame,
// leaning in the wind, stands over it; and brands lofted from the flame and carried downwind, which light dead fine fuel
// where they land by the odds the NFDRS gives (docs/research/fire-constants.md sections 4, 6 and 7, put together as section
// 30 says). A tree is its leaves, twigs, branches and trunk by its height and species (sec. 19); grass its living and
// cured blades (sec. 12); a bush its stems and leaves; a shelter, a pile, a stick or a fallen log the pieces it is made of,
// each holding the water the world has left in it (wetness.ts). Nothing here changes the world: ecology.ts fire() advances
// the beds, heats what's near them and lights what catches, drawing brands from the world's own random stream.
import { group, inFlame, kindle, lay, windAt, type Air, type Bed, type Group } from "./combustion";
import { BURNS, PHYS, WOODS, greenOf, pieceOf, stackPhys, woodOf, type Phys, type Wood } from "./fuel";
import { REF, deadAt, grassAt, growing, moistureOf, sunOn } from "./wetness";
import { TILE_M, type Thing, type World } from "./world";
import { airOn, rainAt } from "./air";
import { canopyAt } from "./light";
import { TREES } from "../terrain/flora";

const G = 9.81, RHO_AIR = 1.2; // air, kg/m3 (sec. 6)
const CHI_R = 0.3; // the radiant share of a fire's heat (sec. 7)
// kW/m2: no flux under the least critical flux of anything that burns heats it toward lighting (sec. 1, 27a)
const NOTHING = Math.min(...Object.values(BURNS).map((b) => b.qcr));
const LOFT = 12.2; // brands rise to this many flame heights over a steady flame (sec. 6, R29)
const BURNOUT = 0.39e5; // a brand falls this many of its diameters before it has burnt away (Albini's D44, sec. 6)
// The mean brand off a burning tree, 3 mm across (sec. 6, R27), as dense as Albini takes brands to be, which is what his
// D44 burnout height carries (sec. 30b)
const BRAND = 0.003, BRAND_RHO = 300;
// m/s: how fast it falls, broadside, by Albini's drag on a cylinder in cross flow, C_D 1.2 (R28, sec. 30b)
const FALL = Math.sqrt((Math.PI * G * BRAND_RHO * BRAND) / (2 * 1.2 * RHO_AIR));
// Hot brands lofted for each kg a flame burns: about a thousand to the kg burning trees lose (Adusumilli and others 2021,
// sec. 30b)
const BRANDS = 1000;
// Glowing brands light fine fuel only landing several together: four did in R26's test, where one never did (sec. 6, 30b)
export const TOGETHER = 4;
const ONE_HOUR = REF[1]; // fine dead fuel, the NFDRS's 1-hour class, is thinner than this (sec. 5)

// ---------- what a thing is, as fuel ----------
// Pieces laid, and how high they stand, m from the ground to their top.
export type Part = { phys: Phys; n: number; m: number; lo: number; hi: number };

// Trees by section 19: the trunk as thick as a forest tree of its height (19a), in meter logs to iLand's stem mass; the
// crown iLand's branch and foliage mass at that trunk (19b), its branchwood split into twigs and branches, and a share of
// it dead (19b).
type Tree = (typeof TREES)[number];
const POW = (a: number, b: number) => (D: number) => a * D ** b; // kg, for a trunk D cm across
const STEM: Record<Tree, (D: number) => number> = { pine: POW(0.061544, 2.4051), oak: POW(0.180585, 2.20123), ash: POW(0.22225, 2.2504), aspen: POW(0.035707, 2.7398) };
const BRANCH: Record<Tree, (D: number) => number> = { pine: POW(0.011057, 2.4796), oak: POW(0.1349, 1.8113), ash: POW(0.022, 2.3), aspen: POW(0.042851, 1.8733) };
const LEAVES: Record<Tree, (D: number) => number> = { pine: POW(0.012504, 2.1826), oak: POW(0.02493, 1.7), ash: POW(0.048475, 1.43), aspen: POW(0.03, 1.4816) };
// The share of a tree's branchwood in twigs: pine's branchwood up to a centimetre against the rest (0.23 of 0.78, Pinus
// densiflora); the broadleaves' under 0.63 cm by the ponderosa pine fractions, renormalised without the foliage (sec. 19b).
function twigShare(sp: Tree, D: number) {
  if (sp === "pine") return 0.23 / 0.78;
  const d = D / 2.54, p1 = 0.65 * Math.exp(-0.154 * d), p2 = 0.844 * Math.exp(-0.166 * d);
  return Math.max(0, p2 - p1) / (1 - p1);
}
// The dead share of a crown (sec. 19b): ponderosa pine's for pine, and for the broadleaves, which have none read, the mean
// of the four conifers' (sec. 30a).
const DEAD: Record<Tree, number> = { pine: 0.183, oak: 0.097, ash: 0.097, aspen: 0.097 };
// A twig: as thick as the brands burning trees shed, which are their twigs, 3 to 4 mm (sec. 6, R27; sec. 30a).
const TWIG = 0.0035;
// How deep a tree's crown hangs, as a share of its height: half, as forest-grown Scots pines and oaks carry theirs (BAAD,
// R98; sec. 30a).
const CROWN = 0.5;
// Pine's needles hold its live foliage water (sec. 21); the broadleaves' leaves, and the live twigs and leaves of every
// tree and shrub, the NFDRS's live woody water (sec. 12); the broadleaves stand bare while the growing season index is
// under its green-up threshold (sec. 30a).
const NEEDLES = 1.2, GREEN_UP = 0.2;

function tree(w: World, t: Thing): Part[] {
  const sp: Tree = (TREES as readonly string[]).includes(t.species ?? "") ? (t.species as Tree) : "oak", H = t.size, as = { kind: "tree", species: sp, size: H };
  const log = pieceOf(as, "log")!.size, branch = pieceOf(as, "stick")!.size, D = log.d * 100, { woody, index } = growing(w);
  const wood = BRANCH[sp](D), leaves = sp !== "pine" && index < GREEN_UP ? 0 : LEAVES[sp](D), alive = 1 - DEAD[sp];
  const twigs = wood * alive * twigShare(sp, D), twig = woodOf(sp, TWIG, (Math.PI / 4) * TWIG * TWIG * 1000 * WOODS[sp].G), crown = H * (1 - CROWN);
  // the live twigs bear the leaves, and the dead ones lie in among the branches they died on (sec. 30a)
  return [
    { phys: { ...PHYS.fiber }, n: (leaves * alive) / PHYS.fiber.mass, m: sp === "pine" ? NEEDLES : woody, lo: crown, hi: H },
    { phys: twig, n: twigs / twig.mass, m: woody, lo: crown, hi: H },
    { phys: { ...twig }, n: (DEAD[sp] * (wood + leaves)) / twig.mass, m: deadAt(w, t, TWIG), lo: crown, hi: H },
    { phys: woodOf(sp, branch.d, branch.mass), n: (wood * alive - twigs) / branch.mass, m: greenOf(sp)!, lo: crown, hi: H },
    { phys: woodOf(sp, log.d, log.mass), n: STEM[sp](D) / log.mass, m: greenOf(sp, true)!, lo: 0, hi: H },
  ];
}
// Where among a tree's parts its dead twigs are, which lightning lights.
const DEAD_TWIGS = 2;

// Grass: a tussock as wide as its patch and as tall as tall grass, 0.5 m (sec. 14a), holding tall grass's load of blades,
// 0.675 kg/m2 (Anderson's fuel model 3, R32; sec. 30a), a blade thick (sec. 22e), its living blades at the island's living
// grass water and its cured ones at dead stuff's (sec. 12).
const GRASS_H = 0.5, GRASS_LOAD = 0.675;
function grass(w: World, t: Thing): Part[] {
  const blade = { ...PHYS.fiber, mass: (Math.PI / 4) * PHYS.fiber.d ** 2 * GRASS_H * PHYS.fiber.rho };
  const kg = GRASS_LOAD * Math.PI * (t.size / 2) ** 2, { herb, cured, dead } = grassAt(w, t);
  return [
    { phys: blade, n: (kg * (1 - cured)) / blade.mass, m: herb, lo: 0, hi: GRASS_H },
    { phys: { ...blade }, n: (kg * cured) / blade.mass, m: dead, lo: 0, hi: GRASS_H },
  ];
}

// A bush: a crown as wide as it is tall at a live crown's bulk density, half of it leaves and half its stems as felling
// cuts them (sec. 19b, 19c, 27e; sec. 30a); a dead bush its stems, dead.
const SHRUB = 1.4; // kg/m3
function bush(w: World, t: Thing, dead: boolean): Part[] {
  const stem = pieceOf(t, "stick");
  if (!stem) return [];
  const kg = (SHRUB * Math.PI * t.size ** 3) / 12, sp: Wood | "generic" = stem.species ?? "generic", { woody } = growing(w);
  const stems: Part = { phys: woodOf(sp, stem.size.d, stem.size.mass), n: kg / stem.size.mass, m: dead ? deadAt(w, t, stem.size.d) : (greenOf(sp) ?? woody), lo: 0, hi: t.size };
  return dead ? [stems] : [{ phys: { ...PHYS.fiber }, n: kg / PHYS.fiber.mass, m: woody, lo: 0, hi: t.size }, stems];
}

// What was made or dropped: a shelter's or a pile's pieces of wood, each as it is, and the rest counted, a pile's at its
// own water and a shelter's at what dead stuff of their thickness holds there (sec. 30a). Pieces alike lie as one group.
function made(w: World, t: Thing, hi?: number): Part[] {
  const out = new Map<string, Part>();
  const add = (s: { k: string; size?: { d: number; mass: number; len: number }; species?: string }, m: number | undefined, n: number) => {
    const phys = stackPhys(w.kinds, s);
    if (!phys?.burn || n <= 0) return;
    const water = m ?? deadAt(w, t, phys.d), key = `${s.k}|${s.size?.d}|${s.size?.mass}|${s.species}|${water}`, had = out.get(key);
    if (had) had.n += n;
    else out.set(key, { phys, n, m: water, lo: 0, hi: hi ?? phys.d });
  };
  for (const s of t.pieces ?? []) add(s, moistureOf(s), 1);
  if (t.kind === "item" && t.item) add({ k: t.item }, t.m ?? 0, (t.n ?? 1) - (t.pieces?.length ?? 0));
  for (const [k, n] of Object.entries(t.kind === "structure" ? t.parts ?? {} : {})) add({ k }, undefined, n - (t.pieces ?? []).filter((s) => s.k === k).length);
  return [...out.values()];
}

// What a thing in the world is, as fuel, in an order its kind keeps: none if nothing of it burns. Living herbaceous
// plants and seedlings are left out: they hold their green water, more than fine fuel carries a flame at (sec. 5, 30a).
export function partsOf(w: World, t: Thing): Part[] {
  if (t.kind === "tree") return tree(w, t);
  if (t.kind === "grass") return grass(w, t);
  if (t.kind === "bush" || t.kind === "dead_bush") return bush(w, t, t.kind === "dead_bush");
  if (t.kind === "stick" || t.kind === "fallen_log") {
    const piece = pieceOf(t, t.kind === "stick" ? "stick" : "log");
    if (!piece) return [];
    const phys = woodOf(piece.species ?? "generic", piece.size.d, piece.size.mass);
    return [{ phys, n: t.kind === "stick" ? 1 : t.size / piece.size.len, m: deadAt(w, t, piece.size.d), lo: 0, hi: piece.size.d }];
  }
  if (t.kind === "structure") return made(w, t, t.size / 2);
  if (t.kind === "item") return made(w, t);
  return [];
}
// The kinds of things partsOf lays.
export const BURNABLE = ["tree", "grass", "bush", "dead_bush", "stick", "fallen_log", "structure", "item"];
// How far a thing spreads either side of where it stands, m: a patch, a bush or a shelter half its width; anything else
// at its middle.
const halfOf = (t: Thing) => (t.kind === "grass" || t.kind === "bush" || t.kind === "dead_bush" || t.kind === "structure" ? t.size / 2 : 0);
// Half the widest thing that stands, a hazel bush near 6 m across (flora.ts): how far beyond a fire's reach to look for
// what it might reach.
export const WIDEST = 3;

// A thing's parts as groups yet to light, each holding the heat it has taken toward lighting.
export const warmed = (t: Thing, parts: Part[]): Group[] => parts.map((p, i) => ({ ...group(p.phys, p.n, p.m), heat: t.absorbed?.[i] ?? 0 }));
// A thing's parts laid as its bed, each group with the heat its part has taken and alight if it is (from warmed).
export function bedOf(parts: Part[], groups: Group[]): Bed | undefined {
  const bed = lay(parts);
  for (const g of bed?.groups ?? []) {
    const from = groups[parts.findIndex((p) => p.phys === g.phys)];
    Object.assign(g, from.lit ? { lit: true, heat: 0, warm: 0, cover: 0, inside: 1 } : { heat: from.heat, warm: from.heat });
  }
  return bed;
}
// The air a part of a thing takes heat in: where the thing stands, with the wind at the top of what the part stands in,
// short grass for what lies on the ground and the head-height wind for anything as high as a head (combustion.ts windAt).
export function airFor(w: World, t: Thing, p: Part): Air {
  const air = airOn(w, t);
  return { temp: air.temp, wind: air.wind, rain: rainAt(w, t.px, t.py), veg: Math.max(0.1, p.hi) };
}
// A tree struck by lightning: its bed with its dead twigs alight, if they're dry enough to carry a flame (combustion.ts
// kindle); none if not.
export function struck(w: World, t: Thing): Bed | undefined {
  const parts = partsOf(w, t), groups = warmed(t, parts), twigs = groups[DEAD_TWIGS];
  if (!twigs || !kindle({ groups: [twigs], coals: [], age: 0 }).groups[0].lit) return undefined;
  twigs.lit = true;
  return bedOf(parts, groups);
}

// ---------- a burning bed, as what's near it meets it ----------
// Where a bed burns, what it gives off, kW, its flame, m tall over a base rb m across the middle, its heap's radius, m, the
// gas its flames burn, kg/s, how far the flame leans from upright in the wind (Thomas, sec. 4: cos = 0.7 u*^-0.49, u* the
// wind at the flame's mid-height over (g m'' D / ρa)^1/3, m'' its gas over its base), the way the wind blows (a unit vector)
// and the head-height wind and plants, for the wind aloft.
export type Blaze = {
  px: number; py: number; q: number; lf: number; rb: number; heap: number; gas: number;
  cos: number; sin: number; dx: number; dy: number; head: number; veg: number;
};
export function blazeOf(w: World, t: Thing, o: { flaming: number; glowing: number; flame: number; base: number; radius: number; gas: number }, air: Air): Blaze {
  const { dx, dy } = w.weather.wind, len = Math.hypot(dx, dy) || 1;
  const u = windAt(air.wind, Math.max(0.05, o.flame / 2), air.veg), m = o.base > 0 ? o.gas / (Math.PI * o.base ** 2) : 0;
  const us = m > 0 ? u / Math.cbrt((G * m * 2 * o.base) / RHO_AIR) : 0, cos = us > 0 ? Math.min(1, 0.7 * us ** -0.49) : 1;
  return {
    px: t.px, py: t.py, q: o.flaming + o.glowing, lf: o.flame, rb: o.base, heap: o.radius, gas: o.gas,
    cos, sin: Math.sqrt(1 - cos * cos), dx: dx / len, dy: dy / len, head: air.wind, veg: air.veg ?? 0,
  };
}
// How far downwind a brand lofted so high lands, m: carried by the wind at that height while it falls.
function flight(b: Blaze, z: number) {
  return (windAt(b.head, Math.max(0.05, z), b.veg) * z) / FALL;
}
// How far from a bed things near it could take its heat, m, as far as its flame reaches or its radiation stays above what
// heats nothing; and how far downwind its brands land.
export function reach(b: Blaze) {
  const rad = b.lf / 2 + Math.sqrt((CHI_R * b.q) / (4 * Math.PI * NOTHING));
  return { heat: Math.max(b.rb + b.lf, rad), brands: b.rb + flight(b, Math.min(LOFT * b.lf, BURNOUT * BRAND)) };
}
// Whether brands can land on a thing: it has a footprint (one taken at its middle has none).
export const landsOn = (t: Thing) => halfOf(t) > 0;

// The least distance between the flame's axis, from its base to its tip (tx, tz) along the wind and up, and an upright
// span at distance a along the wind from lo to hi, in the plane along the wind.
function apart(tx: number, tz: number, a: number, lo: number, hi: number) {
  const along = (px: number, pz: number) => {
    const l2 = tx * tx + tz * tz, s = l2 > 0 ? Math.max(0, Math.min(1, (px * tx + pz * tz) / l2)) : 0;
    return Math.hypot(px - s * tx, pz - s * tz);
  };
  const up = (px: number, pz: number) => Math.hypot(px - a, pz - Math.max(lo, Math.min(hi, pz)));
  if (tx > 0 && a >= 0 && a <= tx) { const z = (a * tz) / tx; if (z >= lo && z <= hi) return 0; }
  if (tx === 0 && a === 0 && hi >= 0 && lo <= tz) return 0;
  return Math.min(along(a, lo), along(a, hi), up(0, 0), up(tx, tz));
}
// The flux on each part of a thing near a burning bed, kW/m2: the flame's own (combustion.ts inFlame) on a part it stands
// over, its column rb across leaning along the wind; on the rest the radiant share of what the bed gives off, from a point
// at the middle of its flame, no nearer than the heap's edge (sec. 7, 30b).
export function fluxOn(b: Blaze, t: Thing, parts: Part[]): number[] {
  const ex = (t.px - b.px) * TILE_M, ey = (t.py - b.py) * TILE_M, d = Math.hypot(ex, ey), half = halfOf(t), k = d > half ? (d - half) / d : 0;
  const a = (ex * b.dx + ey * b.dy) * k, c = (ey * b.dx - ex * b.dy) * k, tx = b.lf * b.sin, tz = b.lf * b.cos;
  return parts.map((p) => {
    if (b.lf > 0 && Math.abs(c) < b.rb && apart(tx, tz, a, p.lo, p.hi) <= Math.sqrt(b.rb * b.rb - c * c)) return inFlame(p.phys.d, b.lf);
    const z = Math.max(p.lo, Math.min(p.hi, tz / 2)), r = Math.max(b.heap, Math.hypot(a - tx / 2, c, z - tz / 2));
    return (CHI_R * b.q) / (4 * Math.PI * r * r);
  });
}

// ---------- brands ----------
// How many brands lofted from a flaming bed over dt seconds land on a thing, on average (sec. 6, 30b): so many for each kg
// of gas its flames burn, each rising to a height drawn evenly up to 12.2 times its flame, carried downwind while it falls
// from there, and landing anywhere across the flame's base; one lofted higher than a brand can fall before it has burnt
// away (Albini) lands as ash. A thing takes those landing on its footprint, a square as wide as it is; one taken at its
// middle takes none.
export function landing(b: Blaze, t: Thing, dt: number) {
  const half = halfOf(t);
  if (b.lf <= 0 || b.gas <= 0 || half <= 0 || b.rb <= 0) return 0;
  const ex = (t.px - b.px) * TILE_M, ey = (t.py - b.py) * TILE_M, a = ex * b.dx + ey * b.dy, c = ey * b.dx - ex * b.dy;
  const across = Math.max(0, Math.min(c + half, b.rb) - Math.max(c - half, -b.rb)) / (2 * b.rb);
  const top = LOFT * b.lf, alive = Math.min(top, BURNOUT * BRAND);
  // the height a brand landing x m downwind was lofted to, found by halving, as the distance grows with the height
  const lofted = (x: number) => {
    if (x <= 0) return 0;
    if (flight(b, alive) <= x) return alive;
    let lo = 0, hi = alive;
    for (let i = 0; i < 30; i++) { const z = (lo + hi) / 2; if (flight(b, z) < x) lo = z; else hi = z; }
    return lo;
  };
  return across > 0 ? (BRANDS * b.gas * dt * across * (lofted(a + half) - lofted(a - half))) / top : 0;
}
// The odds that TOGETHER brands or more land on a thing where on average so many do (Poisson).
export function together(mean: number) {
  let term = Math.exp(-mean), below = term;
  for (let i = 1; i < TOGETHER; i++) below += term *= mean / i;
  return Math.max(0, 1 - below);
}
// The NFDRS's odds that a brand lights fine dead fuel holding m kg of water to the kg, at a fuel temperature of T C (sec. 6,
// R30): from the heat to bring it to ignition, QIGN, cal/g.
export function odds(m: number, T: number) {
  const M = m * 100, qign = 144.5 - 0.266 * T - 0.00058 * T * T - 0.01 * T * M + 18.54 * (1 - Math.exp(-0.151 * M)) + 6.4 * M;
  const chi = Math.max(0, (344 - qign) / 10);
  return Math.max(0, Math.min(1, ((chi ** 3.6 * 1.85e-5 - 0.00232) * 100) / 0.99767 / 100));
}
// The part of a thing brands landing on it may light, the driest of its fine fuel, thinner than the 1-hour class's 6.35 mm,
// and the odds they do at the warmth the sun brings the fuel to (Byram and Jemison, sec. 11); none if it has no fine fuel.
export function tinderIn(w: World, t: Thing, parts: Part[]) {
  let best = -1;
  parts.forEach((p, i) => { if (p.n > 0 && p.phys.d < ONE_HOUR && (best < 0 || p.m < parts[best].m)) best = i; });
  if (best < 0) return { i: -1, odds: 0 };
  const air = airFor(w, t, parts[best]), u = windAt(air.wind, parts[best].hi, air.veg);
  const T = air.temp + (sunOn(w.t, w.weather.sky) * (1 - canopyAt(w, t.px, t.py))) / (32.7 + 42.2 * u);
  return { i: best, odds: odds(parts[best].m, T) };
}
