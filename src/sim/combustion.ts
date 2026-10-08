// What a fire is: a bed of pieces laid together, lighting, burning and going out by the physics of
// docs/research/fire-constants.md, put together as its section 28 says (as twice revised). Pieces alike in what they are,
// how big and how wet lie in a bed as one group, and a lay is built from its heart outward, the finest at the heart and
// each size against the next. The flame stands over what burns, as wide as the burning part and as tall as Heskestad makes
// it, and reaches the pieces that touch the burning part: those take its contact and radiation where it stands over them,
// and the burning part's own radiation; the rest are shielded. A piece yet to light keeps the heat it has taken and lights
// once that would bring its surface to its lighting temperature, so a group lights a share at a time as the flame climbs
// it. A lit piece burns as pieces of its size burn in a burning crib, faster with air, and keeps its flame while that rate
// holds one, the wind doesn't beat it and, if it is thick, something beside it burns; it eats itself down and leaves its
// char among the coals at the heart, which glow away as the air reaches them. Nothing here touches the world: physics.ts
// lays and feeds beds, and formulas.ts asks these same functions what a lay or a feeding comes to.
import { BURNS, type Phys } from "./fuel";

// The air at a bed: C; the wind at head height, m/s, as air.ts gives it under any canopy; rain on it, mm an hour; the
// height of the plants it sits in, m (none for bare ground, 2 or more under trees); and any air blown into it, m/s.
export type Air = { temp: number; wind: number; rain: number; veg?: number; blown?: number };
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
const LEAST = 12; // kW/m2: nothing lights under this (sec. 1)
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
// Glowing char's surface (sec. 8): 600 C in still air, 830 C in a wind of 2.5 m/s, straight between.
const glow = (u: number) => 873.15 + 230 * Math.min(1, u / 2.5);
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
// The heap's own wind, at its mid-height (sec. 14a), and any air blown into it.
const windOf = (b: Bed, air: Air) => windAt(air.wind, Math.max(0.05, radius(b) / 2), air.veg) + (air.blown ?? 0);

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
      beside: near || g.n >= 2 || b.groups.some((x) => x !== g && x.lit && x.ring === g.ring) || (i === 0 && b.coals.some((c) => c.ring !== g.ring)),
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
const drowned = (g: Group) => g.phys.d < ONE_HOUR && g.m > MX;
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
// What a bed gives off: kW from its flames and from its coals, how tall its flame stands and how wide its heap is, m.
export function output(b: Bed, air: Air) {
  const { flaming, lf, u } = look(b, air);
  return { flaming, glowing: coalHeat(b, u), flame: lf, radius: radius(b) };
}
// how fast coals this dense lose thickness, m/s, in a wind u (Albini, sec. 6), and the heat a bed's coals give, kW
const coalRate = (u: number, rho: number) => (K_CHAR * RHO_AIR * Math.max(DRAWN, u)) / rho;
const coalHeat = (b: Bed, u: number) => b.coals.reduce((t, c) => t + ((2 * c.kg) / c.d) * coalRate(u, c.rho) * CHAR_HEAT, 0);

// A bed dt seconds on in this air.
export function advance(bed: Bed, dt: number, air: Air): Bed {
  const b = copy(bed);
  for (let left = dt; left > 1e-9 && (alight(b) || b.groups.some((g) => g.heat > 0 || g.warm > 0)); ) left -= tick(b, air, left);
  b.age += dt;
  return b;
}

// How the bed stands this moment: the gas each lit group drives off (none if it can't hold a flame or the wind beats it)
// and the flame that makes; and for each group yet to light, the share of it inside that flame and what its pieces there
// and outside it take in and net (kW/m2).
function look(b: Bed, air: Air) {
  const R = radius(b), rb = burning(b), u = windOf(b, air), ta = air.temp + 273.15, lay = lies(b);
  const coal = coalSide(b), area = b.groups.reduce((t, g) => t + g.n * side(g), 0) + coal;
  // the heat the burning and glowing surfaces give off, kW, over how much of them there is, and the rain the heap takes
  // on its footprint, per m2 of everything in it
  const hot = b.groups.reduce((t, g) => t + (g.lit ? g.n * side(g) : 0), 0) + coal;
  const shine = (hot - coal) * EPS * SIGMA * T_BURN ** 4 + coal * EPS * SIGMA * glow(u) ** 4;
  const rain = area > 0 ? (RAIN * air.rain * Math.PI * R * R) / area : 0;
  const gas = b.groups.map((g, i) => (g.lit ? crib(g, u, rain, lay[i].beside) : 0));
  let out = b.groups.map((g, i) => g.lit && (gas[i] < EXTINCT || drowned(g))), flaming = 0, lf = 0;
  // what the wind blows off lowers the flame, which may let it blow off more
  for (let k = 0; k <= b.groups.length; k++) {
    flaming = b.groups.reduce((t, g, i) => t + (g.lit && !out[i] ? g.n * gas[i] * side(g) * g.phys.burn!.flame : 0), 0);
    lf = flameOf(flaming, 2 * rb);
    const next = b.groups.map((g, i) => out[i] || (g.lit && u > Math.sqrt((G * lf * gas[i]) / EXTINCT)));
    if (next.every((x, i) => x === out[i])) break;
    out = next;
  }
  const rad = (1 - Math.exp(-KAPPA * lf)) * SIGMA * T_FLAME ** 4;
  const rates = b.groups.map((g, i) => {
    if (g.lit) return { gas: out[i] ? 0 : gas[i], f: 1, inInto: 0, inNet: 0, outInto: 0, outNet: 0 };
    const d = thick(g), { rim, touches } = lay[i];
    // a piece against what burns sees it over the half of its view it turns to it, filled as the heap fills a view
    const seen = touches && hot > 0 ? 0.5 * (1 - Math.exp((-PACK * (R / 2)) / d)) * (shine / hot) : 0;
    const f = !touches || g.cover >= 1 ? 0 : Math.min(1, Math.max(0, (Math.min(1, lf / rim) - g.cover) / (1 - g.cover)));
    const inInto = CONTACT * Math.sqrt(BLADE / d) + rad + seen;
    return { gas: 0, f, inInto, inNet: nets(g, inInto, ta, u, rain), outInto: seen, outNet: nets(g, seen, ta, u, rain) };
  });
  return { rates, flaming, lf, u, ta };
}

// One step of a bed, as long as nothing in it changes much, at most what's left; the seconds it took. A share of a group
// lighting, a group going out or turning to coals ends a step; a burning piece loses at most a tenth of what was laid of it.
function tick(b: Bed, air: Air, left: number) {
  const { rates, u, ta } = look(b, air);
  // the flame takes in or lets go of pieces yet to light, each carrying its heat
  b.groups.forEach((g, i) => {
    const f = rates[i].f;
    if (g.lit || f === g.inside) return;
    if (f > g.inside) g.heat = (g.heat * g.inside + g.warm * (f - g.inside)) / f;
    else g.warm = (g.warm * (1 - g.inside) + g.heat * (g.inside - f)) / (1 - f);
    g.inside = f;
  });
  let dt = Math.min(left, STEP);
  b.groups.forEach((g, i) => {
    const r = rates[i], burn = g.phys.burn!, ash = g.phys.mass * (1 - burn.share);
    if (g.lit && (r.gas <= 0 || burn.charYield >= 1)) dt = 0;
    else if (g.lit) dt = Math.min(dt, (Math.sqrt(g.mass) - Math.sqrt(Math.max(ash, g.mass - TENTH * g.phys.mass))) / shrink(g, r.gas));
    else {
      if (r.f > 0 && can(g, r.inInto, r.inNet)) dt = Math.min(dt, Math.max(0, (needs(g, ta, r.inNet) - g.heat) / r.inNet));
      if (r.f < 1 && can(g, r.outInto, r.outNet)) dt = Math.min(dt, Math.max(0, (needs(g, ta, r.outNet) - g.warm) / r.outNet));
    }
  });
  for (const c of b.coals) dt = Math.min(dt, c.d / coalRate(u, c.rho));
  // the coals glow down, each lot by its own thickness, and what burns adds its char to them
  for (const c of b.coals) {
    const d = c.d - coalRate(u, c.rho) * dt;
    [c.kg, c.d] = d <= 1e-9 ? [0, 0] : [c.kg * (d / c.d) ** 2, d];
  }
  b.coals = b.coals.filter((c) => c.kg > 0);
  const caught: Group[] = [];
  for (const [i, g] of b.groups.entries()) {
    const r = rates[i], burn = g.phys.burn!, ash = g.phys.mass * (1 - burn.share);
    if (g.lit && burn.charYield >= 1) {
      char(b, g.ring, g.n * g.mass, thick(g), g.phys.rho);
      g.mass = 0;
    } else if (g.lit && r.gas <= 0) Object.assign(g, { lit: false, heat: 0, warm: 0, cover: 0, inside: 0 });
    else if (g.lit) {
      const root = Math.max(Math.sqrt(ash), Math.sqrt(g.mass) - shrink(g, r.gas) * dt), was = g.mass;
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
  const ta = air.temp + 273.15, u = windAt(air.wind, Math.max(0.05, thick(g) / 2), air.veg);
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

// What a lighting comes to: the lay with an ember caught in it, and whether it lasts, followed until it goes out: whether
// everything laid with what the ember caught catches and burns through (sec. 28).
export function lighting(pieces: Laid[], air: Air) {
  const laid = lay(pieces);
  if (!laid) return { bed: undefined, lasts: false };
  const bed = kindle(laid);
  return { bed, lasts: bed.groups.some((g) => !g.lit) && !advance(bed, DAY, air).groups.length };
}
// What feeding a bed comes to after seconds on: whether what's laid on it burns, and whether the bed is still alight.
export function feeding(bed: Bed, pieces: Laid[], air: Air, after: number) {
  const fed = feed(bed, pieces), end = advance(fed, after, air);
  const fresh = (b: Bed) => b.groups.filter((g) => g.since === bed.age);
  const left = (b: Bed) => fresh(b).reduce((t, g) => t + g.n * g.mass, 0);
  return { bed: end, lights: left(end) < left(fed) * (1 - 1e-9) || fresh(end).some((g) => g.lit), survives: alight(end) };
}
