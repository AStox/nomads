// What a fire is: a bed of pieces laid together, lighting, burning and going out by the physics of
// docs/research/fire-constants.md, put together as its section 28 says (as twice revised). Pieces alike in what they are,
// how big and how wet lie in a bed as one group, and a lay is built from its heart outward, the finest at the heart and
// each size against the next. The flame stands over what burns, as wide as the burning part and as tall as Heskestad makes
// it, and reaches the pieces that touch the burning part: those take its contact and radiation where it stands over them,
// and the burning part's own radiation; the rest are shielded. A piece yet to light keeps the heat it has taken and lights
// once that would bring its surface to its lighting temperature, so a group lights a share at a time as the flame climbs
// it. A lit piece burns as pieces of its size burn in a burning crib, faster with air, and keeps its flame while that rate
// holds one, the wind doesn't beat it and, if it is thick, something beside it burns; it eats itself down and leaves its
// char among the coals at the heart, which glow away as the air reaches them. As section 29 sets a fire up: a ring of
// stone round it shelters what lies below its top from the wind and gives back what it takes of the fire; a cover heaped
// over it starves it of air, so nothing flames and what's alight smoulders; air blown into its base feeds what flames and
// the coals. Nothing here touches the world: physics.ts lays and feeds beds, and formulas.ts asks these same functions
// what a lay or a feeding comes to, and what a fire does to what's heated in it.
import { BURNS, type Phys } from "./fuel";

// The air at a bed: C; the wind at head height, m/s, as air.ts gives it under any canopy; rain on it, mm an hour; the
// height of the plants it sits in, m (none for bare ground, 2 or more under trees); air blown into its base, m/s; the ring
// of stone round it; whether it's heaped over; and the height it's held at, m, if it's carried (a brand, a lamp).
export type Air = { temp: number; wind: number; rain: number; veg?: number; blown?: number; ring?: Ring; covered?: boolean; held?: number };
// A ring of stone: how tall it stands, m, and how much stone is laid side by side round the fire, m.
export type Ring = { tall: number; width: number };
// A fire's setup on the air it burns in (sec. 29g): the stone ringed round it, a cover heaped over it, which keeps the rain
// off, and air blown in by hand until a time, at the time t.
export const setUp = (f: { walls?: Ring; covered?: boolean; air?: number }, air: Air, t: number): Air =>
  ({ ...air, ...(f.walls ? { ring: f.walls } : {}), ...(f.covered ? { covered: true, rain: 0 } : {}), ...((f.air ?? 0) > t ? { blown: BLOWN } : {}) });
// Pieces laid: what one is (none if it isn't anything that burns), how many, and the water in each, kg to the kg dry.
export type Laid = { phys: Phys | undefined; n: number; m: number };
// A group of pieces alike: what each was as laid, how many, the dry mass each has left, its water, whether it's alight,
// how old the bed was when it was laid, and the shell it lies in, counted from the heart. Yet to light, it keeps the heat
// toward lighting (kJ/m2) of its pieces inside the flame and of those outside it, the share of its shell the flame has
// already lit, and the share of it the flame held when last looked at.
export type Group = {
  phys: Phys; n: number; mass: number; m: number; lit: boolean; since: number; ring: number;
  heat: number; warm: number; cover: number; inside: number;
};
// Coals: the char of one shell's pieces, glowing at the heart, kg, how thick its lumps are, m, and how dense, kg/m3.
export type Coals = { ring: number; kg: number; d: number; rho: number };
// A bed: its groups, its coals, and its age, s.
export type Bed = { groups: Group[]; coals: Coals[]; age: number };

const SIGMA = 5.67e-11; // kW/m2K4
const T_FLAME = 1173, KAPPA = 0.8; // a wood fire's flame gases, K, and how they absorb, 1/m (sec. 2)
const CONTACT = 100, BLADE = 0.00061; // kW/m2 on fine fuel in any visible flame, falling as d^-1/2 (sec. 2)
const EPS = 0.95; // char (sec. 2)
const T_BURN = 873.15; // K: a flaming piece's surface, glowing char's in still air (secs. 8, 17)
const PACK = 0.1; // a heap's solid share (sec. 17)
const CRIB = 10.8; // g/m2s off pieces 1 cm thick in a burning crib, falling as b^-1/2 (Heskestad's loose regime, sec. 3)
const LARGE = 0.05, STEADY = 6.2; // m and g/m2s: Anderson's large-fuel cribs, and their steady burning (sec. 3)
const EXTINCT = 3.5; // g/m2s: the least gas that holds a flame (sec. 3)
export const LEAST = 12; // kW/m2: nothing lights under this (sec. 1)
const MX = 0.3, ONE_HOUR = 0.00635; // fine dead fuel, the 1-h class, wetter than MX carries no flame (sec. 5)
const WATER = 2.6; // MJ to boil off each kg of water (sec. 5)
const RAIN = 0.72; // kW/m2 for each mm an hour of rain, all boiled off (sec. 5)
const K_CHAR = 0.0064, RHO_AIR = 1.2, DRAWN = 1; // Albini's char law (sec. 6), and the flow a fire draws (R85)
const COAL_PACK = 0.5; // coals lie as touching layers pack (sec. 17's crib)
const G = 9.81;
const NU = 1.55e-5, K_AIR = 0.0257, PR = 0.71; // air's kinematic viscosity, conductivity and Prandtl number (sec. 15)
const CHAR_HEAT = BURNS.char.char * 1000; // kJ from each kg of coals glowing away
const STEP = 10, TENTH = 0.1; // s at most between looks at a bed, and the most of a burning piece one step eats
const DAY = 86400; // s: the longest a lighting is followed
// A ring shelters what lies below its top to 0.20 of the wind, and 0.44 more for each share of it left open (sec. 29a).
const LEE = 0.2, LEE_OPEN = 0.44;
// Under a cover a smoulder's front eats 1 cm an hour into each piece, giving off 9 kJ for each g lost, at 500 C (sec. 29e).
const FRONT = 0.01 / 3600, SMOULDER = 9000, T_SMOULDER = 773.15;
// Air blown in by hand, m/s, through a mouth 2.5 cm across (sec. 29d), its oxygen, 23.2% of it by mass, burning char
// (taken as carbon) to CO2 (sec. 29g).
export const BLOWN = 11.8;
const MOUTH = 0.025, O2 = 0.232;
// Something heated in a fire: its emissivity (sec. 29g); and water boils at 100 C.
const EPS_ITEM = 0.9, BOIL = 373.15;

// The wind at a height over plants this tall (sec. 14a): the log profile over bare ground or over low plants, taking
// the wind at their tops for anything inside them; under trees the head-height wind itself.
export function windAt(head: number, z: number, veg = 0) {
  if (veg >= 2) return head;
  if (veg <= 0) return head * Math.max(0, Math.log(z / 0.005) / Math.log(2 / 0.005));
  return (head * Math.log((Math.max(z, veg) - 0.64 * veg) / (0.13 * veg))) / Math.log((2 - 0.64 * veg) / (0.13 * veg));
}
// Churchill and Bernstein's forced convection on a round piece d thick in a wind u (sec. 15), kW/m2K.
function convection(u: number, d: number) {
  const re = (u * d) / NU;
  const nu = 0.3 + ((0.62 * Math.sqrt(re) * Math.cbrt(PR)) / (1 + (0.4 / PR) ** (2 / 3)) ** 0.25) * (1 + (re / 282000) ** 0.625) ** 0.8;
  return (nu * K_AIR) / d / 1000;
}
// Glowing char's surface in the air at it, u m/s (sec. 29d): 600 C in still air, rising as u^(1/8), and no hotter than
// any ember yet seen, 1100 C.
const glow = (u: number) => Math.min(1373, 1019.6 * (u + 0.29) ** 0.125);
// Heskestad's flame over a fire of q kW, d m across (sec. 4).
const flameOf = (q: number, d: number) => (q > 0 ? Math.max(0, 0.235 * q ** 0.4 - 1.02 * d) : 0);

// A piece of a group now: as thick as a round piece of its length burnt down to the mass it has left, and its side.
const thick = (g: Group) => g.phys.d * Math.sqrt(Math.max(0, g.mass) / g.phys.mass);
const side = (g: Group) => (4 * g.mass) / g.phys.rho / Math.max(1e-9, thick(g));
const solid = (g: Group) => (g.n * g.mass) / g.phys.rho;
// The radius of a half-sphere holding so much solid at a heap's packing (sec. 17): the whole heap, and what burns in it.
const half = (v: number) => Math.cbrt((3 * v) / (2 * Math.PI * PACK));
const coalSolid = (b: Bed) => b.coals.reduce((t, c) => t + c.kg / c.rho, 0);
// pieces at the heap's packing round coals at their own
const heap = (pieces: number, coals: number) => Math.cbrt((3 * (pieces / PACK + coals / COAL_PACK)) / (2 * Math.PI));
const radius = (b: Bed) => heap(b.groups.reduce((t, g) => t + solid(g), 0), coalSolid(b));
// the flaming part, which coals glowing don't widen
const burning = (b: Bed) => half(b.groups.reduce((t, g) => t + (g.lit ? solid(g) : 0), 0));
const coalSide = (b: Bed) => b.coals.reduce((t, c) => t + (4 * c.kg) / (c.rho * c.d), 0);
// The heap's own wind, at its mid-height or the height it's held at (sec. 14a), as far as a ring round it lets it in: what
// lies below the ring's top (a half-sphere's volume below that height, sec. 17) takes the wind times 0.20 + 0.44 of the
// share the ring leaves open, the rest the full wind (sec. 29a); none under a cover.
function windOf(b: Bed, air: Air) {
  const R = radius(b), u = air.covered ? 0 : windAt(air.wind, Math.max(0.05, R / 2, air.held ?? 0), air.veg);
  if (!air.ring || R <= 0 || u <= 0) return u;
  const h = Math.min(1, air.ring.tall / R), below = 1.5 * h - 0.5 * h ** 3;
  return u * (1 - below + below * (LEE + LEE_OPEN * gaps(air.ring, R)));
}
// The share of a ring left open, its stone laid side by side round the rim of a heap of radius R (sec. 29g).
const gaps = (ring: Ring, R: number) => Math.max(0, 1 - ring.width / (2 * Math.PI * R));

// How the lay lies (sec. 28): its shells from the heart; for each group, the outer radius of its shell, whether it lies
// against what burns (its own shell or one beside it burning, or, innermost, coals glowing at the heart), and whether
// something burns beside it (another of its own, anything burning in its shell or beside it or, innermost, coals at the
// heart from another shell than its own).
function lies(b: Bed) {
  const rings = [...new Set(b.groups.map((g) => g.ring))].sort((x, y) => x - y);
  const burns = (ring: number | undefined) => ring !== undefined && b.groups.some((g) => g.lit && g.ring === ring);
  const within = (ring: number) => b.groups.reduce((t, g) => t + (g.ring <= ring ? solid(g) : 0), 0);
  return b.groups.map((g) => {
    const i = rings.indexOf(g.ring), near = burns(rings[i - 1]) || burns(rings[i + 1]);
    return {
      rim: heap(within(g.ring), coalSolid(b)),
      touches: near || burns(g.ring) || (i === 0 && b.coals.length > 0),
      // pieces of a kind laid together lie against each other however much of them has caught
      beside: near || b.groups.reduce((t, x) => t + (x.ring === g.ring && x.phys === g.phys ? x.n : 0), 0) >= 2 ||
        b.groups.some((x) => x !== g && x.lit && x.ring === g.ring) || (i === 0 && b.coals.some((c) => c.ring !== g.ring)),
    };
  });
}
// The gas a lit group drives off, g/m2s (sec. 28): pieces under 5 cm as thick as these were laid do in a burning crib of
// them at the heap's packing, as porous as that crib was built (Heskestad, secs. 3 and 15); thicker ones as Anderson's
// large-fuel cribs did, while something burns beside them. Faster with the air reaching it, slower for the water it boils
// off with its gas, less what the rain on it takes.
function crib(g: Group, u: number, rain: number, beside: boolean) {
  const b = g.phys.d * 100, h = Math.max(b, 100 * half((g.n * g.phys.mass) / g.phys.rho));
  const open = 1 - Math.exp((-50 * PACK * b * b * (1 / PACK - 1) ** 2.5) / (4 * h));
  const burn = g.phys.burn!, wet = burn.L + (WATER * g.m) / Math.max(1e-9, 1 - burn.charYield);
  const rate = g.phys.d < LARGE ? (CRIB * open) / Math.sqrt(b) : beside ? STEADY : 0;
  return (Math.min(6, 1 + (0.2 + 0.85 * (1 - open)) * u) * rate * burn.L) / wet - rain / wet;
}
// Fine dead fuel, of the 1-h class as laid, too wet to carry a flame (sec. 5).
export const drowned = (g: { phys: Phys; m: number }) => g.phys.d < ONE_HOUR && g.m > MX;
// The heat a piece yet to light must take before it does, under a net flux q_n (R4's Eq. 7, sec. 28).
function needs(g: Group, ta: number, qn: number) {
  const burn = g.phys.burn!, dT = burn.tig + 273.15 - ta;
  const thin = g.phys.rho * g.phys.c * (thick(g) / 4) * dT * (1 + 5 * g.m), deep = (Math.PI / 4) * burn.krc * (1 + 8.1 * g.m) * dT * dT;
  return qn > 0 ? (thin ** -4 + (qn / deep) ** 4) ** -0.25 : Infinity;
}
// What a piece yet to light nets, kW/m2, of a flux coming in: less what lighting it needs to make up, the wind and the rain.
const nets = (g: Group, into: number, ta: number, u: number, rain: number) =>
  into - g.phys.burn!.qcr - convection(u, thick(g)) * (g.phys.burn!.tig + 273.15 - ta) - rain;
// Whether a flux can light a piece at all.
const can = (g: Group, into: number, net: number) => net > 0 && into >= LEAST && !drowned(g);

const fuel = (x: Laid) =>
  !!x.phys?.burn && x.n > 0 && Number.isFinite(x.n) && x.m >= 0 && Number.isFinite(x.m) &&
  [x.phys.d, x.phys.mass, x.phys.rho, x.phys.c].every((v) => Number.isFinite(v) && v > 0);
// Pieces laid as a group, none alight, in a shell.
export const group = (phys: Phys, n: number, m: number, since = 0, ring = 0): Group =>
  ({ phys, n, mass: phys.mass, m, lit: false, since, ring, heat: 0, warm: 0, cover: 0, inside: 0 });
// A lay: its pieces in shells by thickness, the finest at the heart; nothing if none of them is fuel.
export function lay(pieces: Laid[]): Bed | undefined {
  const groups = pieces.filter(fuel).sort((x, y) => x.phys!.d - y.phys!.d).map((x, i) => group(x.phys!, x.n, x.m, 0, i));
  return groups.length ? { groups, coals: [], age: 0 } : undefined;
}
// More pieces laid on a bed: against what burns in it, outside its outermost burning shell; on the coals at the heart if
// only they glow; round the outside if nothing burns.
export function feed(bed: Bed, pieces: Laid[]): Bed {
  const b = copy(bed), rings = b.groups.map((g) => g.ring), lit = b.groups.filter((g) => g.lit).map((g) => g.ring);
  const ring = lit.length ? Math.max(...lit) + 0.5 : b.coals.length ? Math.min(0, ...rings) - 1 : Math.max(-1, ...rings) + 1;
  b.groups.push(...pieces.filter(fuel).map((x) => group(x.phys!, x.n, x.m, b.age, ring)));
  return b;
}
const copy = (b: Bed): Bed => ({ ...b, groups: b.groups.map((g) => ({ ...g })), coals: b.coals.map((c) => ({ ...c })) });

// An ember caught in the finest of what's laid, blown to flame: that group alight.
export function kindle(bed: Bed): Bed {
  const b = copy(bed), fine = b.groups.filter((g) => !g.lit && !drowned(g)).sort((x, y) => x.ring - y.ring || thick(x) - thick(y))[0];
  if (fine) Object.assign(fine, { lit: true, heat: 0, warm: 0, cover: 0, inside: 1 });
  return b;
}

export const alight = (b: Bed) => b.groups.some((g) => g.lit) || b.coals.length > 0;
// What a bed gives off: kW from its flames and from its coals (under a cover, from what smoulders in it), how tall its
// flame stands, how wide the burning part under it is (the flame's base, m) and the heap, m, the gas its flames burn, kg/s,
// and how hot its coals glow, K.
export function output(b: Bed, air: Air) {
  const { flaming, lf, u, hot, rates } = look(b, air);
  const gas = b.groups.reduce((t, g, i) => t + (g.lit ? (g.n * rates[i].gas * side(g)) / 1000 : 0), 0);
  return { flaming, glowing: air.covered ? smoulder(b) : coalHeat(b, u, air.blown ?? 0), flame: lf, base: burning(b), radius: radius(b), gas, hot };
}
// The flux on a piece d thick inside a flame lf tall, kW/m2: the flame's contact and its radiation (sec. 2, 28).
export const inFlame = (d: number, lf: number) => CONTACT * Math.sqrt(BLADE / d) + (1 - Math.exp(-KAPPA * lf)) * SIGMA * T_FLAME ** 4;
// how fast coals this dense lose thickness, m/s, in a wind u (Albini, sec. 6); the char air blown in at u burns, kg/s
// (sec. 29g); and the heat a bed's coals give, kW
const coalRate = (u: number, rho: number) => (K_CHAR * RHO_AIR * Math.max(DRAWN, u)) / rho;
const jet = (u: number) => u * (Math.PI / 4) * MOUTH * MOUTH * RHO_AIR * O2 * (12 / 32);
const coalKg = (b: Bed) => b.coals.reduce((t, c) => t + c.kg, 0);
const coalHeat = (b: Bed, u: number, blown: number) =>
  (b.coals.reduce((t, c) => t + ((2 * c.kg) / c.d) * coalRate(u, c.rho), 0) + (b.coals.length ? jet(blown) : 0)) * CHAR_HEAT;
// Under a cover: how fast a smouldering piece's square root of mass falls, its front eating into it (sec. 29e); and the
// heat what smoulders gives off, kW, of the wood it eats less the char that leaves, and of the coals.
const sinks = (g: Group) => (2 * FRONT * Math.sqrt(g.phys.mass)) / g.phys.d;
const smoulder = (b: Bed) =>
  SMOULDER * (b.groups.reduce((t, g) => t + (g.lit ? g.n * 2 * Math.sqrt(g.mass) * sinks(g) * (1 - Math.min(1, g.phys.burn!.charYield)) : 0), 0) +
    b.coals.reduce((t, c) => t + (4 * FRONT * c.kg) / c.d, 0));
// How long a bed has left, s, as anyone by it can judge from what burns now (sec. 28, the same closed forms): the longest of
// each burning group's time to burn or smoulder through at the rate it does, and each lot of coals' time to glow or
// smoulder away, air blown in burning them by their share.
export function lasts(b: Bed, air: Air) {
  const { rates, u } = look(b, air), j = air.covered ? 0 : jet(air.blown ?? 0), kg = coalKg(b);
  let s = 0;
  b.groups.forEach((g, i) => {
    if (g.lit && air.covered) s = Math.max(s, Math.sqrt(g.mass) / sinks(g));
    else if (g.lit && rates[i].gas > 0) s = Math.max(s, Math.sqrt(g.mass) / shrink(g, rates[i].gas));
  });
  for (const c of b.coals) s = Math.max(s, c.d / (air.covered ? 2 * FRONT : coalRate(u, c.rho) + (j * c.d) / (2 * kg)));
  return s;
}

// A bed dt seconds on in this air.
export function advance(bed: Bed, dt: number, air: Air): Bed {
  const b = copy(bed);
  for (let left = dt; left > 1e-9 && (alight(b) || b.groups.some((g) => g.heat > 0 || g.warm > 0)); ) left -= tick(b, air, left);
  b.age += dt;
  return b;
}

// How the bed stands this moment: the gas each lit group drives off (none if it can't hold a flame, the wind beats it or
// it's heaped over) and the flame that makes; and for each group yet to light, the share of it inside that flame and what
// its pieces there and outside it take in and net (kW/m2). Also the wind at the heap, and how warm its coals glow: in the
// air at them, with any blown into its base, or under a cover as it smoulders.
function look(b: Bed, air: Air) {
  const R = radius(b), rb = burning(b), u = windOf(b, air), ub = air.covered ? 0 : u + (air.blown ?? 0), ta = air.temp + 273.15, lay = lies(b);
  const lit = air.covered ? T_SMOULDER : T_BURN, hot = air.covered ? T_SMOULDER : glow(ub);
  const coal = coalSide(b), area = b.groups.reduce((t, g) => t + g.n * side(g), 0) + coal;
  // the heat the burning and glowing surfaces give off, kW, over how much of them there is, and the rain the heap takes
  // on its footprint, per m2 of everything in it
  const burns = b.groups.reduce((t, g) => t + (g.lit ? g.n * side(g) : 0), 0) + coal;
  const shine = (burns - coal) * EPS * SIGMA * lit ** 4 + coal * EPS * SIGMA * hot ** 4;
  const rain = area > 0 && !air.covered ? (RAIN * air.rain * Math.PI * R * R) / area : 0;
  // a ring's stone gives back, over the cold air's, the mean of what its face sees, half of it fire and half air (sec. 29b),
  // over the outward half of the view of what lies in the heap's outer shell, as far as stone fills it below its top
  const back = air.ring && burns > 0 ? 0.25 * (1 - gaps(air.ring, R)) * Math.min(1, air.ring.tall / R) * Math.max(0, shine / (burns * EPS) - SIGMA * ta ** 4) : 0;
  const gas = b.groups.map((g, i) => (g.lit && !air.covered ? crib(g, ub, rain, lay[i].beside) : 0));
  let out = b.groups.map((g, i) => g.lit && (!!air.covered || gas[i] < EXTINCT || drowned(g))), flaming = 0, lf = 0;
  // what the wind blows off lowers the flame, which may let it blow off more
  for (let k = 0; k <= b.groups.length; k++) {
    flaming = b.groups.reduce((t, g, i) => t + (g.lit && !out[i] ? g.n * gas[i] * side(g) * g.phys.burn!.flame : 0), 0);
    lf = flameOf(flaming, 2 * rb);
    const next = b.groups.map((g, i) => out[i] || (g.lit && u > Math.sqrt((G * lf * gas[i]) / EXTINCT)));
    if (next.every((x, i) => x === out[i])) break;
    out = next;
  }
  const rates = b.groups.map((g, i) => {
    if (g.lit) return { gas: out[i] ? 0 : gas[i], f: 1, inInto: 0, inNet: 0, outInto: 0, outNet: 0 };
    const d = thick(g), { rim, touches } = lay[i];
    // a piece against what burns sees it over the half of its view it turns to it, filled as the heap fills a view
    const seen = (touches && burns > 0 ? 0.5 * (1 - Math.exp((-PACK * (R / 2)) / d)) * (shine / burns) : 0) + (rim >= R * (1 - 1e-9) ? back : 0);
    const f = !touches || g.cover >= 1 ? 0 : Math.min(1, Math.max(0, (Math.min(1, lf / rim) - g.cover) / (1 - g.cover)));
    const inInto = inFlame(d, lf) + seen;
    return { gas: 0, f, inInto, inNet: nets(g, inInto, ta, u, rain), outInto: seen, outNet: nets(g, seen, ta, u, rain) };
  });
  return { rates, flaming, lf, u, hot, ta };
}

// One step of a bed, as long as nothing in it changes much, at most what's left; the seconds it took. A share of a group
// lighting, a group going out or turning to coals ends a step; a burning or smouldering piece loses at most a tenth of what
// was laid of it, and air blown in burns at most a tenth of the coals.
function tick(b: Bed, air: Air, left: number) {
  const { rates, u, ta } = look(b, air), covered = !!air.covered;
  // the flame takes in or lets go of pieces yet to light, each carrying its heat
  b.groups.forEach((g, i) => {
    const f = rates[i].f;
    if (g.lit || f === g.inside) return;
    if (f > g.inside) g.heat = (g.heat * g.inside + g.warm * (f - g.inside)) / f;
    else g.warm = (g.warm * (1 - g.inside) + g.heat * (g.inside - f)) / (1 - f);
    g.inside = f;
  });
  // how fast a lit piece's square root of mass falls as it burns, or under a cover as it smoulders; how fast coals lose
  // thickness as they glow or smoulder; and the char air blown in burns, kg/s
  const fall = (g: Group, i: number) => (covered ? sinks(g) : shrink(g, rates[i].gas));
  const thin = (c: Coals) => (covered ? 2 * FRONT : coalRate(u, c.rho)), j = covered ? 0 : jet(air.blown ?? 0), kg = coalKg(b);
  let dt = Math.min(left, STEP);
  b.groups.forEach((g, i) => {
    const r = rates[i], burn = g.phys.burn!, ash = g.phys.mass * (1 - burn.share);
    if (g.lit && ((!covered && r.gas <= 0) || burn.charYield >= 1)) dt = 0;
    else if (g.lit) dt = Math.min(dt, (Math.sqrt(g.mass) - Math.sqrt(Math.max(ash, g.mass - TENTH * g.phys.mass))) / fall(g, i));
    else {
      if (r.f > 0 && can(g, r.inInto, r.inNet)) dt = Math.min(dt, Math.max(0, (needs(g, ta, r.inNet) - g.heat) / r.inNet));
      if (r.f < 1 && can(g, r.outInto, r.outNet)) dt = Math.min(dt, Math.max(0, (needs(g, ta, r.outNet) - g.warm) / r.outNet));
    }
  });
  for (const c of b.coals) dt = Math.min(dt, c.d / (thin(c) + (j * c.d) / (2 * kg)));
  if (j > 0 && kg > 0) dt = Math.min(dt, (TENTH * kg) / j);
  // the coals glow or smoulder down, each lot by its own thickness, air blown in burning each by its share, and what
  // burns adds its char to them
  for (const c of b.coals) {
    const d = c.d - thin(c) * dt, glowed = d <= 1e-9 ? 0 : c.kg * (d / c.d) ** 2, rest = glowed - (j * dt * c.kg) / kg;
    [c.kg, c.d] = rest <= 1e-12 ? [0, 0] : [rest, d * Math.sqrt(rest / glowed)];
  }
  b.coals = b.coals.filter((c) => c.kg > 0);
  const caught: Group[] = [];
  for (const [i, g] of b.groups.entries()) {
    const r = rates[i], burn = g.phys.burn!, ash = g.phys.mass * (1 - burn.share);
    if (g.lit && burn.charYield >= 1) {
      char(b, g.ring, g.n * g.mass, thick(g), g.phys.rho);
      g.mass = 0;
    } else if (g.lit && !covered && r.gas <= 0) Object.assign(g, { lit: false, heat: 0, warm: 0, cover: 0, inside: 0 });
    else if (g.lit) {
      const root = Math.max(Math.sqrt(ash), Math.sqrt(g.mass) - fall(g, i) * dt), was = g.mass;
      g.mass = root * root;
      char(b, g.ring, g.n * (was - g.mass) * burn.charYield, g.phys.d, g.phys.rho * burn.charYield);
    } else {
      g.warm = Math.max(0, g.warm + r.outNet * dt);
      // pieces inside the flame take its heat; with none inside, those the flame next takes in come from outside
      g.heat = r.f > 0 ? Math.max(0, g.heat + r.inNet * dt) : g.warm;
      const lights = (into: number, net: number, heat: number) => can(g, into, net) && heat >= needs(g, ta, net) * (1 - 1e-9);
      // the part outside lighting from what it sees lights the part inside with it, as does the flame holding all of it
      if ((r.f < 1 && lights(r.outInto, r.outNet, g.warm)) || (r.f >= 1 && lights(r.inInto, r.inNet, g.heat))) {
        Object.assign(g, { lit: true, heat: 0, warm: 0, cover: 0, inside: 1 });
      } else if (r.f > 0 && lights(r.inInto, r.inNet, g.heat)) {
        caught.push({ ...g, n: g.n * r.f, lit: true, heat: 0, warm: 0, cover: 0, inside: 1 });
        Object.assign(g, { n: g.n * (1 - r.f), cover: g.cover + r.f * (1 - g.cover), heat: g.warm, inside: 0 });
      }
    }
  }
  // what has just caught joins a lit group of its own kind still as fresh, or burns as a group of its own
  for (const c of caught) {
    const kin = b.groups.find((g) => g.lit && g.phys === c.phys && g.m === c.m && g.ring === c.ring && g.mass >= c.mass * (1 - TENTH));
    if (kin) [kin.mass, kin.n] = [(kin.mass * kin.n + c.mass * c.n) / (kin.n + c.n), kin.n + c.n];
    else b.groups.push(c);
  }
  b.groups = b.groups.filter((g) => g.n > 1e-9 && g.mass > g.phys.mass * (1 - g.phys.burn!.share) + 1e-12);
  return dt;
}
// How fast the square root of a burning piece's mass falls, gas g/m2s off its side (sec. 28).
const shrink = (g: Group, gas: number) =>
  (2 * gas * Math.sqrt(g.phys.mass)) / (1000 * (1 - Math.min(0.999, g.phys.burn!.charYield)) * g.phys.rho * g.phys.d);
// Char joining the coals from a shell: as thick as the pieces it came off were laid, and as dense as that leaves it
// (sec. 27e), with the char that shell has already left there.
function char(b: Bed, ring: number, kg: number, d: number, rho: number) {
  if (kg <= 0) return;
  const c = b.coals.find((x) => x.ring === ring);
  if (!c) return void b.coals.push({ ring, kg, d, rho });
  [c.d, c.rho, c.kg] = [(c.d * c.kg + d * kg) / (c.kg + kg), (c.kg + kg) / (c.kg / c.rho + kg / rho), c.kg + kg];
}

// A piece by itself under a flux on its surface, kW/m2: heated for dt seconds, and how long it takes to light.
function alone(g: Group, flux: number, air: Air) {
  const ta = air.temp + 273.15, u = windAt(air.wind, Math.max(0.05, thick(g) / 2, air.held ?? 0), air.veg);
  return { ta, net: nets(g, flux, ta, u, (RAIN * air.rain) / Math.PI), ok: flux >= LEAST && !drowned(g) };
}
export function expose(g: Group, flux: number, dt: number, air: Air): Group {
  if (g.lit) return { ...g };
  const { ta, net, ok } = alone(g, flux, air), heat = Math.max(0, g.heat + net * dt);
  return { ...g, heat, lit: ok && net > 0 && heat >= needs(g, ta, net) };
}
export function lightsIn(g: Group, flux: number, air: Air) {
  if (g.lit) return 0;
  const { ta, net, ok } = alone(g, flux, air);
  return ok && net > 0 ? Math.max(0, (needs(g, ta, net) - g.heat) / net) : Infinity;
}

// What a lighting comes to: the lay with an ember caught in its finest, or a carried brand set at its heart, and whether it
// lasts, followed until it goes out: whether everything laid with what caught first catches and burns through (sec. 28).
export function lighting(pieces: Laid[], air: Air, by?: Group) {
  const laid = lay(pieces);
  if (!laid) return { bed: undefined, lasts: false };
  const bed = by ? { ...laid, groups: [{ ...by, lit: true, ring: -1, since: 0 }, ...laid.groups] } : kindle(laid);
  return { bed, lasts: (by ? laid.groups.length > 0 : bed.groups.some((g) => !g.lit)) && !advance(bed, DAY, air).groups.some((g) => g.ring >= 0) };
}
// The radiation a piece of this kind laid on a bed would take, kW/m2, against what it burns, as feed lays it: the flame's
// radiation where the flame reaches it and what it sees of the burning and glowing surfaces, without the flame's contact.
export function radiation(bed: Bed, air: Air, phys: Phys) {
  const b = feed(bed, [{ phys, n: 1, m: 0 }]), { lf, rates } = look(b, air), r = rates[rates.length - 1];
  return r.outInto + (r.f > 0 ? (1 - Math.exp(-KAPPA * lf)) * SIGMA * T_FLAME ** 4 : 0);
}
// What feeding a bed comes to after seconds on: whether what's laid on it burns, and whether the bed is still alight.
export function feeding(bed: Bed, pieces: Laid[], air: Air, after: number) {
  const fed = feed(bed, pieces), end = advance(fed, after, air);
  const fresh = (b: Bed) => b.groups.filter((g) => g.since === bed.age);
  const left = (b: Bed) => fresh(b).reduce((t, g) => t + g.n * g.mass, 0);
  return { bed: end, lights: left(end) < left(fed) * (1 - 1e-9) || fresh(end).some((g) => g.lit), survives: alight(end) };
}

// What something d thick set in a bed comes toward, K (sec. 29g): under a cover the smoulder's warmth while anything in it
// is alight; in the open the warmest of its coals' glow, which a thing nested in them sees all round, and the warmth at
// which a thing in its flame radiates what it takes of it; the air's if nothing burns.
export function setIn(b: Bed, air: Air, d: number) {
  const ta = air.temp + 273.15;
  if (!alight(b)) return ta;
  if (air.covered) return T_SMOULDER;
  const { flaming, lf, hot } = look(b, air), F = buried(b, d);
  return Math.max(ta, (F * hot ** 4 + (1 - F) * ta ** 4) ** 0.25, flaming > 0 ? flameWarmth(d, lf, ta) : ta);
}
// How much of something d thick its coals bury (sec. 29g): all of it once their heap is as wide as it is thick, and short of
// that the share of its surface their heap's breadth covers, as the square of the two [design].
const buried = (b: Bed, d: number) => Math.min(1, (heap(0, coalSolid(b)) / d) ** 2);
// The warmth at which something d thick inside a flame lf tall radiates what it takes (sec. 29g): the flame's radiation
// and, past it, the air's, and the flame's contact flux on a piece its thickness, falling as it warms toward the flame.
function flameWarmth(d: number, lf: number, ta: number) {
  const ef = 1 - Math.exp(-KAPPA * lf), h = (CONTACT * Math.sqrt(BLADE / d)) / (T_FLAME - ta);
  const net = (T: number) => EPS_ITEM * SIGMA * (ef * T_FLAME ** 4 + (1 - ef) * ta ** 4 - T ** 4) + h * (T_FLAME - T);
  let lo = ta, hi = T_FLAME;
  for (let i = 0; i < 50; i++) {
    const mid = (lo + hi) / 2;
    if (net(mid) > 0) lo = mid;
    else hi = mid;
  }
  return lo;
}
// The flux on a piece d thick set in a bed, kW/m2 (sec. 29g): nested in its coals their glow, in its flame its contact and
// radiation, whichever is more; nothing flames or glows under a cover.
export function fluxIn(b: Bed, air: Air, d: number) {
  if (air.covered || !alight(b)) return 0;
  const { flaming, lf, hot } = look(b, air);
  return Math.max(buried(b, d) * EPS * SIGMA * hot ** 4, flaming > 0 ? inFlame(d, lf) : 0);
}
// Whether wood smoulders in a bed, giving off the smoke that cures (sec. 29e): only under a cover.
export const smokes = (b: Bed, air: Air) => !!air.covered && b.groups.some((g) => g.lit && g.phys.burn!.charYield < 1);
// The plume's rise z m over a bed, K (Heskestad, sec. 29e): the 0.65 of what it gives off that its plume carries up, from a
// fire as wide as what flames in it, or as the heap if nothing does.
export function plumeRise(b: Bed, air: Air, z: number) {
  const o = output(b, air), q = o.flaming + o.glowing;
  if (q <= 0) return 0;
  const D = 2 * (o.flaming > 0 ? o.base : o.radius), z0 = -1.02 * D + 0.083 * q ** 0.4;
  return 0.0853 * (air.temp + 273.15) * (0.65 * q) ** (2 / 3) * Math.max(0.01, z - z0) ** (-5 / 3);
}
// How warm something's core gets, K, held s seconds where it comes toward T, K, from the air's warmth ta (sec. 29g): while
// it holds water (m, kg to the kg dry) its surface stays at 100 C, what the warmth there nets it boiling the water off; its
// core lags its surface as a round piece heated all round does, wet and then dry.
export function heats(phys: Phys, m: number, T: number, s: number, ta: number) {
  const d = phys.d, area = Math.PI * d * ((4 * phys.mass) / (Math.PI * phys.rho * d * d) + d / 2);
  const tau = (w: number) => (0.35 * (d / 2) ** 2 * 1000 * phys.rho * (phys.c + 4.19 * w)) / (2 * phys.k);
  const lag = (from: number, to: number, t: number, w: number) => to + (from - to) * Math.exp(-t / tau(w));
  if (T <= BOIL || m <= 0) return lag(ta, T, s, m);
  const wet = (m * phys.mass * WATER * 1000) / (EPS_ITEM * SIGMA * (T ** 4 - BOIL ** 4) * area);
  return s <= wet ? lag(ta, BOIL, s, m) : lag(lag(ta, BOIL, wet, m), T, s - wet, 0);
}
