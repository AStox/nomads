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
//
// The bed's law (look, tick, burnFor, output and what they call) is integer arithmetic on reals (src/gpu/real.ts: 24-bit
// mantissas, every result truncated), so the GPU's beds (src/gpu/wgsl/beds.ts) step the same beds bit for bit: this file
// is their twin, operation for operation, and a world not resident on the GPU burns its beds here. A bed is stepped a
// look at a time, ten seconds (fire-constants sec. 37); what a lay or a feeding comes to is stepped the same way. The
// readers that only the CPU asks (how long a bed lasts, what something set in it comes to) take the law's numbers in
// floating point.
import { BURNS, type Phys } from "./fuel";
import { MAXR, T, add as A, cbrt, div as D, exp, ln, mul as M, p4, pow, sq, sqrt, sub as S } from "../gpu/real";

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
// Pieces laid: what one is (none if it isn't anything that burns), how many, and the water in each, kg to the kg dry, and
// in its outer half where that differs (wetness.ts skin).
export type Laid = { phys: Phys | undefined; n: number; m: number; skin?: number };
// A group of pieces alike: what each was as laid, how many, the dry mass each has left, its water (and its skin's, where
// that differs), whether it's alight, how old the bed was when it was laid, and the shell it lies in, counted from the
// heart. Yet to light, it keeps the heat toward lighting (kJ/m2) of its pieces inside the flame and of those outside it,
// the share of its shell the flame has already lit, and the share of it the flame held when last looked at. Every number
// is a real (gpu/real.ts).
export type Group = {
  phys: Phys; n: number; mass: number; m: number; skin?: number; lit: boolean; since: number; ring: number;
  heat: number; warm: number; cover: number; inside: number;
};
// Coals: the char of one shell's pieces, glowing at the heart, kg, how thick its lumps are, m, and how dense, kg/m3.
export type Coals = { ring: number; kg: number; d: number; rho: number };
// A bed: its groups, its coals, and its age, s.
export type Bed = { groups: Group[]; coals: Coals[]; age: number };

// ---------- the law's constants, as reals (wgsl/beds.ts reads these same words) ----------
const SIGMA = 5.67e-11; // kW/m2K4
const T_FLAME = 1173, KAPPA = 0.8; // a wood fire's flame gases, K, and how they absorb, 1/m (sec. 2)
const CONTACT = T(100), BLADE = T(0.00061); // kW/m2 on fine fuel in any visible flame, falling as d^-1/2 (sec. 2)
const EPS = 0.95; // char (sec. 2)
const T_BURN = T(873.15); // K: a flaming piece's surface, glowing char's in still air (secs. 8, 17)
const PACK = T(0.1); // a heap's solid share (sec. 17)
const CRIB = T(10.8); // g/m2s off pieces 1 cm thick in a burning crib, falling as b^-1/2 (Heskestad's loose regime, sec. 3)
const LARGE = T(0.05), STEADY = T(6.2); // m and g/m2s: Anderson's large-fuel cribs, and their steady burning (sec. 3)
const EXTINCT = T(3.5); // g/m2s: the least gas that holds a flame (sec. 3)
export const LEAST = T(12); // kW/m2: nothing lights under this (sec. 1)
const MX = T(0.3), ONE_HOUR = T(0.00635); // fine dead fuel, the 1-h class, wetter than MX carries no flame (sec. 5)
const WATER = T(2.6); // MJ to boil off each kg of water (sec. 5)
const RAIN = T(0.72); // kW/m2 for each mm an hour of rain, all boiled off (sec. 5)
const K_CHAR = 0.0064, RHO_AIR = 1.2, DRAWN = T(1); // Albini's char law (sec. 6), and the flow a fire draws (R85)
const COAL_PACK = T(0.5); // coals lie as touching layers pack (sec. 17's crib)
const G = T(9.81);
const NU = T(1.55e-5), K_AIR = T(0.0257), PR = 0.71; // air's kinematic viscosity, conductivity and Prandtl number (sec. 15)
const CHAR_HEAT = T(BURNS.char.char * 1000); // kJ from each kg of coals glowing away
const STEP = T(10), TENTH = T(0.1); // s at most between looks at a bed, and the most of a burning piece one step eats
const DAY = 86400; // s: the longest a lighting is followed
// A ring shelters what lies below its top to 0.20 of the wind, and 0.44 more for each share of it left open (sec. 29a).
const LEE = T(0.2), LEE_OPEN = T(0.44);
// Under a cover a smoulder's front eats 1 cm an hour into each piece, giving off 9 kJ for each g lost, at 500 C (sec. 29e).
const FRONT = 0.01 / 3600, SMOULDER = T(9000), T_SMOULDER = T(773.15);
// Air blown in by hand, m/s, through a mouth 2.5 cm across (sec. 29d), its oxygen, 23.2% of it by mass, burning char
// (taken as carbon) to CO2 (sec. 29g).
export const BLOWN = 11.8;
const MOUTH = 0.025, O2 = 0.232;
// Something heated in a fire: its emissivity (sec. 29g); and water boils at 100 C.
const EPS_ITEM = 0.9, BOIL = 373.15;
// The law's bounds (fire-constants sec. 37) [design]: a bed holds at most GROUPS groups and COALS lots of coals (a
// tree's five parts and the shares its flame lights, or a hearth fed for a night, are well within them); a look takes at
// most STEPS steps; a share of a group lights once its heat comes within 2^-16 of what lighting needs (the law's
// truncation to 24 bits leaves it short by up to some 2^-21).
export const GROUPS = 48, COALS = 24, STEPS = 256;
const NEARLY = T(1 - 2 ** -16);
// The rest of the law's numbers, folded where the float law multiplied constants together, each named by what it is.
const N = {
  ZERO: 0, HALF: T(0.5), ONE: T(1), TWO: T(2), THREE: T(3), FOUR: T(4), FIVE: T(5), SIX: T(6), HUNDRED: T(100), THOUSAND: T(1000),
  E9: T(1e-9), E12: T(1e-12), RIM: T(1 - 1e-9), KELVIN: T(273.15), PI: T(Math.PI), PI_4: T(Math.PI / 4), TWO_PI: T(2 * Math.PI),
  TWO_PI_PACK: T(2 * Math.PI * 0.1), Z0: T(0.005), LN_Z: T(Math.log(2 / 0.005)), V64: T(0.64), V13: T(0.13), Z_MIN: T(0.05),
  C03: T(0.3), CB: T((0.62 * Math.cbrt(PR)) / (1 + (0.4 / PR) ** (2 / 3)) ** 0.25), RE_C: T(282000), C0625: T(0.625), C08: T(0.8),
  GLOW_MAX: T(1373), GLOW_A: T(1019.6), C029: T(0.29), C0125: T(0.125), C0235: T(0.235), C04: T(0.4), C102: T(1.02), C15: T(1.5),
  CRIB_C: T(-50 * 0.1), CRIB_K: T((1 / 0.1 - 1) ** 2.5), C02: T(0.2), C085: T(0.85), C81: T(8.1), QUARTER: T(-0.25),
  NEG_KAPPA: T(-KAPPA), SIGMA_TF4: T(SIGMA * T_FLAME ** 4), EPS_SIGMA: T(EPS * SIGMA), SIGMA: T(SIGMA), K_CHAR_AIR: T(K_CHAR * RHO_AIR),
  JET: T((Math.PI / 4) * MOUTH * MOUTH * RHO_AIR * O2 * (12 / 32)), TWO_FRONT: T(2 * FRONT), FOUR_FRONT: T(4 * FRONT),
  C0999: T(0.999), NEG_PACK: T(-0.1), C025: T(0.25), FRESH: T(1 - 0.1), EPS: T(EPS),
};
// Every constant the GPU's law reads, by name.
export const LAW = {
  ...N, CONTACT, BLADE, T_BURN, PACK, CRIB, LARGE, STEADY, EXTINCT, LEAST, MX, ONE_HOUR, WATER, RAIN, DRAWN, COAL_PACK, G, NU, K_AIR,
  CHAR_HEAT, STEP, TENTH, LEE, LEE_OPEN, SMOULDER, T_SMOULDER, NEARLY,
};

// What a piece is to the law: its numbers as reals, made once for each record a group points at.
export type LawPhys = { d: number; mass: number; rho: number; c: number; L: number; cy: number; tig: number; krc: number; qcr: number; flame: number; share: number };
const laws = new WeakMap<Phys, LawPhys>();
export function lawOf(p: Phys): LawPhys {
  let l = laws.get(p);
  if (!l) {
    const b = p.burn!;
    l = { d: T(p.d), mass: T(p.mass), rho: T(p.rho), c: T(p.c), L: T(b.L), cy: T(b.charYield), tig: T(b.tig), krc: T(b.krc), qcr: T(b.qcr), flame: T(b.flame), share: T(b.share) };
    laws.set(p, l);
  }
  return l;
}
// The air as the law takes it: every number a real, none left out.
export type LawAir = { temp: number; wind: number; rain: number; veg: number; blown: number; ring?: Ring; covered: boolean; held: number };
export const lawAir = (a: Air): LawAir => ({
  temp: T(a.temp), wind: T(a.wind), rain: T(a.rain), veg: T(a.veg ?? 0), blown: T(a.blown ?? 0), covered: !!a.covered, held: T(a.held ?? 0),
  ...(a.ring ? { ring: { tall: T(a.ring.tall), width: T(a.ring.width) } } : {}),
});

// The wind at a height over plants this tall (sec. 14a): the log profile over bare ground or over low plants, taking
// the wind at their tops for anything inside them; under trees the head-height wind itself.
export function windAt(head: number, z: number, veg = 0) {
  if (veg >= N.TWO) return head;
  if (veg <= 0) return M(head, Math.max(0, D(ln(D(z, N.Z0)), N.LN_Z)));
  const v64 = M(N.V64, veg), v13 = M(N.V13, veg);
  return D(M(head, ln(D(S(Math.max(z, veg), v64), v13))), ln(D(S(N.TWO, v64), v13)));
}
// Churchill and Bernstein's forced convection on a round piece d thick in a wind u (sec. 15), kW/m2K.
function convection(u: number, d: number) {
  const re = D(M(u, d), NU), nu = A(N.C03, M(M(N.CB, sqrt(re)), pow(A(N.ONE, pow(D(re, N.RE_C), N.C0625)), N.C08)));
  return D(D(M(nu, K_AIR), d), N.THOUSAND);
}
// Glowing char's surface in the air at it, u m/s (sec. 29d): 600 C in still air, rising as u^(1/8), and no hotter than
// any ember yet seen, 1100 C.
const glow = (u: number) => Math.min(N.GLOW_MAX, M(N.GLOW_A, pow(A(u, N.C029), N.C0125)));
// Heskestad's flame over a fire of q kW, d m across (sec. 4).
const flameOf = (q: number, d: number) => (q > 0 ? Math.max(0, S(M(N.C0235, pow(q, N.C04)), M(N.C102, d))) : 0);

// A piece of a group now: as thick as a round piece of its length burnt down to the mass it has left, and its side.
const thick = (g: Group) => M(lawOf(g.phys).d, sqrt(D(Math.max(0, g.mass), lawOf(g.phys).mass)));
const side = (g: Group) => D(D(M(N.FOUR, g.mass), lawOf(g.phys).rho), Math.max(N.E9, thick(g)));
const solid = (g: Group) => D(M(g.n, g.mass), lawOf(g.phys).rho);
// The radius of a half-sphere holding so much solid at a heap's packing (sec. 17): the whole heap, and what burns in it.
const half = (v: number) => cbrt(D(M(N.THREE, v), N.TWO_PI_PACK));
const coalSolid = (b: Bed) => b.coals.reduce((t, c) => A(t, D(c.kg, c.rho)), 0);
// pieces at the heap's packing round coals at their own
const heap = (pieces: number, coals: number) => cbrt(D(M(N.THREE, A(D(pieces, PACK), D(coals, COAL_PACK))), N.TWO_PI));
export const radius = (b: Bed) => heap(b.groups.reduce((t, g) => A(t, solid(g)), 0), coalSolid(b));
// the flaming part, which coals glowing don't widen
const burning = (b: Bed) => half(b.groups.reduce((t, g) => (g.lit ? A(t, solid(g)) : t), 0));
const coalSide = (b: Bed) => b.coals.reduce((t, c) => A(t, D(M(N.FOUR, c.kg), M(c.rho, c.d))), 0);
// The heap's own wind, at its mid-height or the height it's held at (sec. 14a), as far as a ring round it lets it in: what
// lies below the ring's top (a half-sphere's volume below that height, sec. 17) takes the wind times 0.20 + 0.44 of the
// share the ring leaves open, the rest the full wind (sec. 29a); none under a cover.
function windOf(b: Bed, air: LawAir) {
  const R = radius(b), u = air.covered ? 0 : windAt(air.wind, Math.max(Math.max(N.Z_MIN, M(R, N.HALF)), air.held), air.veg);
  if (!air.ring || R <= 0 || u <= 0) return u;
  const h = Math.min(N.ONE, D(air.ring.tall, R)), below = S(M(N.C15, h), M(N.HALF, M(sq(h), h)));
  return M(u, A(S(N.ONE, below), M(below, A(LEE, M(LEE_OPEN, gaps(air.ring, R))))));
}
// The share of a ring left open, its stone laid side by side round the rim of a heap of radius R (sec. 29g).
const gaps = (ring: Ring, R: number) => Math.max(0, S(N.ONE, D(ring.width, M(N.TWO_PI, R))));

// How the lay lies (sec. 28): for each group, the outer radius of its shell, whether it lies against what burns (its own
// shell or one beside it burning, or, innermost, coals glowing at the heart), and whether something burns beside it
// (another of its own, anything burning in its shell or beside it or, innermost, coals at the heart from another shell
// than its own). The shells beside a group's are the nearest inside and outside it.
function lies(b: Bed) {
  const burns = (ring: number) => b.groups.some((g) => g.lit && g.ring === ring), coal = coalSolid(b);
  return b.groups.map((g) => {
    let inner = NaN, outer = NaN, within = 0, kin = 0;
    for (const x of b.groups) {
      if (x.ring < g.ring && !(x.ring <= inner)) inner = x.ring;
      if (x.ring > g.ring && !(x.ring >= outer)) outer = x.ring;
      if (x.ring <= g.ring) within = A(within, solid(x));
      // pieces of a kind laid together lie against each other however much of them has caught
      if (x.ring === g.ring && x.phys === g.phys) kin = A(kin, x.n);
    }
    const first = Number.isNaN(inner), near = (!first && burns(inner)) || (!Number.isNaN(outer) && burns(outer));
    return {
      rim: heap(within, coal),
      touches: near || burns(g.ring) || (first && b.coals.length > 0),
      beside: near || kin >= N.TWO || b.groups.some((x) => x !== g && x.lit && x.ring === g.ring) || (first && b.coals.some((c) => c.ring !== g.ring)),
    };
  });
}
// The gas a lit group drives off, g/m2s (sec. 28): pieces under 5 cm as thick as these were laid do in a burning crib of
// them at the heap's packing, as porous as that crib was built (Heskestad, secs. 3 and 15); thicker ones as Anderson's
// large-fuel cribs did, while something burns beside them. Faster with the air reaching it, slower for the water it boils
// off with its gas, less what the rain on it takes.
function crib(g: Group, u: number, rain: number, beside: boolean) {
  const p = lawOf(g.phys), b = M(p.d, N.HUNDRED), h = Math.max(b, M(N.HUNDRED, half(D(M(g.n, p.mass), p.rho))));
  const open = S(N.ONE, exp(D(M(M(M(N.CRIB_C, b), b), N.CRIB_K), M(N.FOUR, h))));
  const wet = A(p.L, D(M(WATER, g.m), Math.max(N.E9, S(N.ONE, p.cy))));
  const rate = p.d < LARGE ? D(M(CRIB, open), sqrt(b)) : beside ? STEADY : 0;
  return S(D(M(M(Math.min(N.SIX, A(N.ONE, M(A(N.C02, M(N.C085, S(N.ONE, open))), u))), rate), p.L), wet), D(rain, wet));
}
// Fine dead fuel, of the 1-h class as laid, too wet to carry a flame (sec. 5).
export const drowned = (g: { phys: Phys; m: number }) => lawOf(g.phys).d < ONE_HOUR && g.m > MX;
// The heat a piece yet to light must take before it does, under a net flux q_n (R4's Eq. 7, sec. 28): heating it through,
// with all its water (thin, kJ/m2); or heating its face as a thick piece does, which a skin's water slows as kρc's does
// (deep, kJ/m2 times kW/m2: the face's heat under q_n is deep / q_n) (sec. 27g).
function depths(g: Group, ta: number) {
  const p = lawOf(g.phys), dT = S(A(p.tig, N.KELVIN), ta);
  return {
    thin: M(M(M(M(p.rho, p.c), D(thick(g), N.FOUR)), dT), A(N.ONE, M(N.FIVE, g.m))),
    deep: M(M(M(M(N.PI_4, p.krc), A(N.ONE, M(N.C81, g.skin ?? g.m))), dT), dT),
  };
}
// (thin^-4 + (q_n / deep)^4)^(-1/4); MAXR where nothing nets.
function needs(g: Group, ta: number, qn: number) {
  if (!(qn > 0)) return MAXR;
  const { thin, deep } = depths(g, ta);
  return pow(A(D(N.ONE, p4(thin)), p4(D(qn, deep))), N.QUARTER);
}
// What a piece yet to light nets, kW/m2, of a flux coming in: less what lighting it needs to make up, the wind and the rain.
function nets(g: Group, into: number, ta: number, u: number, rain: number) {
  const p = lawOf(g.phys);
  return S(S(S(into, p.qcr), M(convection(u, thick(g)), S(A(p.tig, N.KELVIN), ta))), rain);
}
// Whether a flux can light a piece at all.
const can = (g: Group, into: number, net: number) => net > 0 && into >= LEAST && !drowned(g);

const fuel = (x: Laid) =>
  !!x.phys?.burn && x.n > 0 && Number.isFinite(x.n) && x.m >= 0 && Number.isFinite(x.m) &&
  [x.phys.d, x.phys.mass, x.phys.rho, x.phys.c].every((v) => Number.isFinite(v) && v > 0);
// Pieces laid as a group, none alight, in a shell.
export function group(phys: Phys, n: number, m: number, since = 0, ring = 0, skin?: number): Group {
  const mm = T(m), sk = skin === undefined ? mm : T(skin);
  return { phys, n: T(n), mass: lawOf(phys).mass, m: mm, ...(sk === mm ? {} : { skin: sk }), lit: false, since: T(since), ring: T(ring), heat: 0, warm: 0, cover: 0, inside: 0 };
}
// Pieces laid on a bed full to GROUPS join the last group of their kind and water in the same shell, or are not laid
// [gap].
function add(b: Bed, g: Group) {
  if (b.groups.length < GROUPS) return void b.groups.push(g);
  const kin = b.groups.findLast((x) => x.phys === g.phys && x.m === g.m && x.ring === g.ring && !x.lit);
  if (kin) kin.n = A(kin.n, g.n);
}
// A lay: its pieces in shells by thickness, the finest at the heart; nothing if none of them is fuel.
export function lay(pieces: Laid[]): Bed | undefined {
  const b: Bed = { groups: [], coals: [], age: 0 };
  pieces.filter(fuel).sort((x, y) => x.phys!.d - y.phys!.d).forEach((x, i) => add(b, group(x.phys!, x.n, x.m, 0, i, x.skin)));
  return b.groups.length ? b : undefined;
}
// More pieces laid on a bed: against what burns in it, outside its outermost burning shell; on the coals at the heart if
// only they glow; round the outside if nothing burns.
export function feed(bed: Bed, pieces: Laid[]): Bed {
  const b = copyBed(bed), rings = b.groups.map((g) => g.ring), lit = b.groups.filter((g) => g.lit).map((g) => g.ring);
  const ring = lit.length ? Math.max(...lit) + 0.5 : b.coals.length ? Math.min(0, ...rings) - 1 : Math.max(-1, ...rings) + 1;
  for (const x of pieces.filter(fuel)) add(b, group(x.phys!, x.n, x.m, b.age, ring, x.skin));
  return b;
}
// A bed copied, its groups and coals its own (their records shared).
export const copyBed = (b: Bed): Bed => ({ ...b, groups: b.groups.map((g) => ({ ...g })), coals: b.coals.map((c) => ({ ...c })) });

// An ember caught in the finest of what's laid, blown to flame: that group alight.
export function kindle(bed: Bed): Bed {
  const b = copyBed(bed), fine = b.groups.filter((g) => !g.lit && !drowned(g)).sort((x, y) => x.ring - y.ring || thick(x) - thick(y))[0];
  if (fine) Object.assign(fine, { lit: true, heat: 0, warm: 0, cover: 0, inside: N.ONE });
  return b;
}

export const alight = (b: Bed) => b.groups.some((g) => g.lit) || b.coals.length > 0;
// Whether a bed has anything left to step: alight, or holding heat toward lighting.
export const live = (b: Bed) => alight(b) || b.groups.some((g) => g.heat > 0 || g.warm > 0);
// What a bed gives off: kW from its flames and from its coals (under a cover, from what smoulders in it), how tall its
// flame stands, how wide the burning part under it is (the flame's base, m) and the heap, m, the gas its flames burn, kg/s,
// and how hot its coals glow, K.
export function output(b: Bed, air: Air) {
  const a = lawAir(air), { flaming, lf, u, hot, rates } = look(b, a);
  const gas = b.groups.reduce((t, g, i) => (g.lit ? A(t, D(M(M(g.n, rates[i].gas), side(g)), N.THOUSAND)) : t), 0);
  return { flaming, glowing: a.covered ? smoulder(b) : coalHeat(b, u, a.blown), flame: lf, base: burning(b), radius: radius(b), gas, hot };
}
// The flux on a piece d thick inside a flame lf tall, kW/m2: the flame's contact, falling as d^-1/2, and its radiation,
// by how tall it stands (sec. 2, 28).
export const contact = (d: number) => M(CONTACT, sqrt(D(BLADE, d)));
export const flameRadiation = (lf: number) => M(S(N.ONE, exp(M(N.NEG_KAPPA, lf))), N.SIGMA_TF4);
export const inFlame = (d: number, lf: number) => A(contact(d), flameRadiation(lf));
// how fast coals this dense lose thickness, m/s, in a wind u (Albini, sec. 6); the char air blown in at u burns, kg/s
// (sec. 29g); and the heat a bed's coals give, kW
const coalRate = (u: number, rho: number) => D(M(N.K_CHAR_AIR, Math.max(DRAWN, u)), rho);
const jet = (u: number) => M(u, N.JET);
const coalKg = (b: Bed) => b.coals.reduce((t, c) => A(t, c.kg), 0);
const coalHeat = (b: Bed, u: number, blown: number) =>
  M(A(b.coals.reduce((t, c) => A(t, M(D(M(N.TWO, c.kg), c.d), coalRate(u, c.rho))), 0), b.coals.length ? jet(blown) : 0), CHAR_HEAT);
// Under a cover: how fast a smouldering piece's square root of mass falls, its front eating into it (sec. 29e); and the
// heat what smoulders gives off, kW, of the wood it eats less the char that leaves, and of the coals.
const sinks = (g: Group) => D(M(N.TWO_FRONT, sqrt(lawOf(g.phys).mass)), lawOf(g.phys).d);
const smoulder = (b: Bed) =>
  M(SMOULDER, A(
    b.groups.reduce((t, g) => (g.lit ? A(t, M(M(M(M(g.n, N.TWO), sqrt(g.mass)), sinks(g)), S(N.ONE, Math.min(N.ONE, lawOf(g.phys).cy)))) : t), 0),
    b.coals.reduce((t, c) => A(t, D(M(N.FOUR_FRONT, c.kg), c.d)), 0),
  ));
// How long a bed has left, s, as anyone by it can judge from what burns now (sec. 28, the same closed forms): the longest of
// each burning group's time to burn or smoulder through at the rate it does, and each lot of coals' time to glow or
// smoulder away, air blown in burning them by their share.
export function lasts(b: Bed, air: Air) {
  const a = lawAir(air), { rates, u } = look(b, a), j = a.covered ? 0 : jet(a.blown), kg = coalKg(b);
  let s = 0;
  b.groups.forEach((g, i) => {
    if (g.lit && a.covered) s = Math.max(s, Math.sqrt(g.mass) / sinks(g));
    else if (g.lit && rates[i].gas > 0) s = Math.max(s, Math.sqrt(g.mass) / shrink(g, rates[i].gas));
  });
  for (const c of b.coals) s = Math.max(s, c.d / (a.covered ? 2 * FRONT : coalRate(u, c.rho) + (j * c.d) / (2 * kg)));
  return s;
}

// A bed dt seconds on in this air: look by look, each at most STEP seconds.
export function advance(bed: Bed, dt: number, air: Air): Bed {
  const b = copyBed(bed), a = lawAir(air);
  for (let left = T(dt); left > 0; ) {
    const span = Math.min(STEP, left);
    if (!live(b)) { b.age = A(b.age, left); break; }
    burnFor(b, span, a);
    left = S(left, span);
  }
  return b;
}
// A look at a bed, span seconds of it (at most STEP), in steps as long as nothing in it changes much, at most STEPS of
// them: the bed changed in place, and its age on by span. The GPU's beds (wgsl/beds.ts) step a look the same way.
export function burnFor(b: Bed, span: number, air: LawAir) {
  for (let left = span, k = 0; k < STEPS && left > N.E9 && live(b); k++) left = S(left, tick(b, air, left));
  b.age = A(b.age, span);
}

// How the bed stands this moment: the gas each lit group drives off (none if it can't hold a flame, the wind beats it or
// it's heaped over) and the flame that makes; and for each group yet to light, the share of it inside that flame and what
// its pieces there and outside it take in and net (kW/m2). Also the wind at the heap, and how warm its coals glow: in the
// air at them, with any blown into its base, or under a cover as it smoulders.
function look(b: Bed, air: LawAir) {
  const R = radius(b), rb = burning(b), u = windOf(b, air), ub = air.covered ? 0 : A(u, air.blown), ta = A(air.temp, N.KELVIN), lay = lies(b);
  const lit = air.covered ? T_SMOULDER : T_BURN, hot = air.covered ? T_SMOULDER : glow(ub);
  const coal = coalSide(b), area = A(b.groups.reduce((t, g) => A(t, M(g.n, side(g))), 0), coal);
  // the heat the burning and glowing surfaces give off, kW, over how much of them there is, and the rain the heap takes
  // on its footprint, per m2 of everything in it
  const burns = A(b.groups.reduce((t, g) => (g.lit ? A(t, M(g.n, side(g))) : t), 0), coal);
  const shine = A(M(M(S(burns, coal), N.EPS_SIGMA), p4(lit)), M(M(coal, N.EPS_SIGMA), p4(hot)));
  const rain = area > 0 && !air.covered ? D(M(M(M(M(RAIN, air.rain), N.PI), R), R), area) : 0;
  // a ring's stone gives back, over the cold air's, the mean of what its face sees, half of it fire and half air (sec. 29b),
  // over the outward half of the view of what lies in the heap's outer shell, as far as stone fills it below its top
  const back = air.ring && burns > 0
    ? M(M(M(N.C025, S(N.ONE, gaps(air.ring, R))), Math.min(N.ONE, D(air.ring.tall, R))), Math.max(0, S(D(shine, M(burns, N.EPS)), M(N.SIGMA, p4(ta)))))
    : 0;
  const gas = b.groups.map((g, i) => (g.lit && !air.covered ? crib(g, ub, rain, lay[i].beside) : 0));
  let out = b.groups.map((g, i) => g.lit && (air.covered || gas[i] < EXTINCT || drowned(g))), flaming = 0, lf = 0;
  // what the wind blows off lowers the flame, which may let it blow off more
  for (let k = 0; k <= b.groups.length; k++) {
    flaming = b.groups.reduce((t, g, i) => (g.lit && !out[i] ? A(t, M(M(M(g.n, gas[i]), side(g)), lawOf(g.phys).flame)) : t), 0);
    lf = flameOf(flaming, M(N.TWO, rb));
    const next = b.groups.map((g, i) => out[i] || (g.lit && u > sqrt(D(M(M(G, lf), gas[i]), EXTINCT))));
    if (next.every((x, i) => x === out[i])) break;
    out = next;
  }
  const rates = b.groups.map((g, i) => {
    if (g.lit) return { gas: out[i] ? 0 : gas[i], f: N.ONE, inInto: 0, inNet: 0, outInto: 0, outNet: 0 };
    const d = thick(g), { rim, touches } = lay[i];
    // a piece against what burns sees it over the half of its view it turns to it, filled as the heap fills a view
    const seen = A(touches && burns > 0 ? M(M(N.HALF, S(N.ONE, exp(D(M(N.NEG_PACK, M(R, N.HALF)), d)))), D(shine, burns)) : 0, rim >= M(R, N.RIM) ? back : 0);
    const f = !touches || g.cover >= N.ONE ? 0 : Math.min(N.ONE, Math.max(0, D(S(Math.min(N.ONE, D(lf, rim)), g.cover), S(N.ONE, g.cover))));
    const inInto = A(inFlame(d, lf), seen);
    return { gas: 0, f, inInto, inNet: nets(g, inInto, ta, u, rain), outInto: seen, outNet: nets(g, seen, ta, u, rain) };
  });
  return { rates, flaming, lf, u, hot, ta };
}

// One step of a bed, as long as nothing in it changes much, at most what's left; the seconds it took. A share of a group
// lighting, a group going out or turning to coals ends a step; a burning or smouldering piece loses at most a tenth of what
// was laid of it, and air blown in burns at most a tenth of the coals.
function tick(b: Bed, air: LawAir, left: number) {
  const { rates, u, ta } = look(b, air), covered = air.covered;
  // the flame takes in or lets go of pieces yet to light, each carrying its heat
  b.groups.forEach((g, i) => {
    const f = rates[i].f;
    if (g.lit || f === g.inside) return;
    if (f > g.inside) g.heat = D(A(M(g.heat, g.inside), M(g.warm, S(f, g.inside))), f);
    else g.warm = D(A(M(g.warm, S(N.ONE, g.inside)), M(g.heat, S(g.inside, f))), S(N.ONE, f));
    g.inside = f;
  });
  // how fast a lit piece's square root of mass falls as it burns, or under a cover as it smoulders; how fast coals lose
  // thickness as they glow or smoulder; and the char air blown in burns, kg/s
  const fall = (g: Group, i: number) => (covered ? sinks(g) : shrink(g, rates[i].gas));
  const thin = (c: Coals) => (covered ? N.TWO_FRONT : coalRate(u, c.rho)), j = covered ? 0 : jet(air.blown), kg = coalKg(b);
  let dt = Math.min(left, STEP);
  b.groups.forEach((g, i) => {
    const r = rates[i], p = lawOf(g.phys), ash = M(p.mass, S(N.ONE, p.share));
    if (g.lit && ((!covered && r.gas <= 0) || p.cy >= N.ONE)) dt = 0;
    else if (g.lit) dt = Math.min(dt, D(S(sqrt(g.mass), sqrt(Math.max(ash, S(g.mass, M(TENTH, p.mass))))), fall(g, i)));
    else {
      if (r.f > 0 && can(g, r.inInto, r.inNet)) dt = Math.min(dt, Math.max(0, D(S(needs(g, ta, r.inNet), g.heat), r.inNet)));
      if (r.f < N.ONE && can(g, r.outInto, r.outNet)) dt = Math.min(dt, Math.max(0, D(S(needs(g, ta, r.outNet), g.warm), r.outNet)));
    }
  });
  for (const c of b.coals) dt = Math.min(dt, D(c.d, A(thin(c), D(M(j, c.d), M(N.TWO, kg)))));
  if (j > 0 && kg > 0) dt = Math.min(dt, D(M(TENTH, kg), j));
  // the coals glow or smoulder down, each lot by its own thickness, air blown in burning each by its share, and what
  // burns adds its char to them
  for (const c of b.coals) {
    const d = S(c.d, M(thin(c), dt)), glowed = d <= N.E9 ? 0 : M(c.kg, sq(D(d, c.d))), rest = S(glowed, D(M(M(j, dt), c.kg), kg));
    if (rest <= N.E12) { c.kg = 0; c.d = 0; } else { c.d = M(d, sqrt(D(rest, glowed))); c.kg = rest; }
  }
  b.coals = b.coals.filter((c) => c.kg > 0);
  const caught: Group[] = [];
  for (const [i, g] of b.groups.entries()) {
    const r = rates[i], p = lawOf(g.phys), ash = M(p.mass, S(N.ONE, p.share));
    if (g.lit && p.cy >= N.ONE) {
      char(b, g.ring, M(g.n, g.mass), thick(g), p.rho);
      g.mass = 0;
    } else if (g.lit && !covered && r.gas <= 0) Object.assign(g, { lit: false, heat: 0, warm: 0, cover: 0, inside: 0 });
    else if (g.lit) {
      const root = Math.max(sqrt(ash), S(sqrt(g.mass), M(fall(g, i), dt))), was = g.mass;
      g.mass = M(root, root);
      char(b, g.ring, M(M(g.n, S(was, g.mass)), p.cy), p.d, M(p.rho, p.cy));
    } else {
      g.warm = Math.max(0, A(g.warm, M(r.outNet, dt)));
      // pieces inside the flame take its heat; with none inside, those the flame next takes in come from outside
      g.heat = r.f > 0 ? Math.max(0, A(g.heat, M(r.inNet, dt))) : g.warm;
      const lights = (into: number, net: number, heat: number) => can(g, into, net) && heat >= M(needs(g, ta, net), NEARLY);
      // the part outside lighting from what it sees lights the part inside with it, as does the flame holding all of it;
      // a share caught in a bed with no room for another group lights the whole group
      const share = r.f > 0 && lights(r.inInto, r.inNet, g.heat);
      if ((r.f < N.ONE && lights(r.outInto, r.outNet, g.warm)) || (r.f >= N.ONE && lights(r.inInto, r.inNet, g.heat)) || (share && b.groups.length + caught.length >= GROUPS)) {
        Object.assign(g, { lit: true, heat: 0, warm: 0, cover: 0, inside: N.ONE });
      } else if (share) {
        caught.push({ ...g, n: M(g.n, r.f), lit: true, heat: 0, warm: 0, cover: 0, inside: N.ONE });
        Object.assign(g, { n: M(g.n, S(N.ONE, r.f)), cover: A(g.cover, M(r.f, S(N.ONE, g.cover))), heat: g.warm, inside: 0 });
      }
    }
  }
  // what has just caught joins a lit group of its own kind still as fresh, or burns as a group of its own
  for (const c of caught) {
    const kin = b.groups.find((g) => g.lit && g.phys === c.phys && g.m === c.m && g.ring === c.ring && g.mass >= M(c.mass, N.FRESH));
    if (kin) { kin.mass = D(A(M(kin.mass, kin.n), M(c.mass, c.n)), A(kin.n, c.n)); kin.n = A(kin.n, c.n); }
    else b.groups.push(c);
  }
  b.groups = b.groups.filter((g) => g.n > N.E9 && g.mass > A(M(lawOf(g.phys).mass, S(N.ONE, lawOf(g.phys).share)), N.E12));
  return dt;
}
// How fast the square root of a burning piece's mass falls, gas g/m2s off its side (sec. 28).
function shrink(g: Group, gas: number) {
  const p = lawOf(g.phys);
  return D(M(M(N.TWO, gas), sqrt(p.mass)), M(M(M(N.THOUSAND, S(N.ONE, Math.min(N.C0999, p.cy))), p.rho), p.d));
}
// Char joining the coals from a shell: as thick as the pieces it came off were laid, and as dense as that leaves it
// (sec. 27e), with the char that shell has already left there; in a bed holding COALS lots, char from a shell with none
// joins the last lot.
function char(b: Bed, ring: number, kg: number, d: number, rho: number) {
  if (kg <= 0) return;
  const c = b.coals.find((x) => x.ring === ring) ?? (b.coals.length >= COALS ? b.coals[COALS - 1] : undefined);
  if (!c) return void b.coals.push({ ring, kg, d, rho });
  const sum = A(c.kg, kg);
  [c.d, c.rho, c.kg] = [D(A(M(c.d, c.kg), M(d, kg)), sum), D(sum, A(D(c.kg, c.rho), D(kg, rho))), sum];
}

// A piece by itself under a flux on its surface, kW/m2: heated for dt seconds, and how long it takes to light.
function alone(g: Group, flux: number, air: Air) {
  const a = lawAir(air), ta = A(a.temp, N.KELVIN), u = windAt(a.wind, Math.max(Math.max(N.Z_MIN, M(thick(g), N.HALF)), a.held), a.veg);
  return { ta, net: nets(g, T(flux), ta, u, D(M(RAIN, a.rain), N.PI)), ok: flux >= LEAST && !drowned(g) };
}
export function expose(g: Group, flux: number, dt: number, air: Air): Group {
  if (g.lit) return { ...g };
  const { ta, net, ok } = alone(g, flux, air), heat = Math.max(0, g.heat + net * dt);
  return { ...g, heat, lit: ok && net > 0 && heat >= needs(g, ta, net) };
}
// expose's law for a law that sums the flux on a piece yet to light itself (gpu/wgsl/fire.ts): what the piece loses of
// any flux coming in, kW/m2 (its critical flux, the wind's cooling and the rain: expose's net is the flux less this),
// needs' thin and deep, and whether it can light at all (it isn't drowned).
export function exposure(g: Group, air: Air) {
  const { ta, net } = alone(g, 0, air);
  return { loss: -net, ...depths(g, ta), ok: !drowned(g) };
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
  const b = feed(bed, [{ phys, n: 1, m: 0 }]), { lf, rates } = look(b, lawAir(air)), r = rates[rates.length - 1];
  return r.outInto + (r.f > 0 ? flameRadiation(lf) : 0);
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
  const { flaming, lf, hot } = look(b, lawAir(air)), F = buried(b, d);
  return Math.max(ta, (F * hot ** 4 + (1 - F) * ta ** 4) ** 0.25, flaming > 0 ? flameWarmth(d, lf, ta) : ta);
}
// How much of something d thick its coals bury (sec. 29g): all of it once their heap is as wide as it is thick, and short of
// that the share of its surface their heap's breadth covers, as the square of the two [design].
const buried = (b: Bed, d: number) => Math.min(1, (heap(0, coalSolid(b)) / d) ** 2);
// The warmth at which something d thick inside a flame lf tall radiates what it takes (sec. 29g): the flame's radiation
// and, past it, the air's, and the flame's contact flux on a piece its thickness, falling as it warms toward the flame.
function flameWarmth(d: number, lf: number, ta: number) {
  const ef = 1 - Math.exp(-KAPPA * lf), h = (100 * Math.sqrt(0.00061 / d)) / (T_FLAME - ta);
  const net = (t: number) => EPS_ITEM * SIGMA * (ef * T_FLAME ** 4 + (1 - ef) * ta ** 4 - t ** 4) + h * (T_FLAME - t);
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
  const { flaming, lf, hot } = look(b, lawAir(air));
  return Math.max(buried(b, d) * EPS * SIGMA * hot ** 4, flaming > 0 ? inFlame(T(d), lf) : 0);
}
// Whether wood smoulders in a bed, giving off the smoke that cures (sec. 29e): only under a cover.
export const smokes = (b: Bed, air: Air) => !!air.covered && b.groups.some((g) => g.lit && g.phys.burn!.charYield < 1);
// The plume's rise z m over a bed, K (Heskestad, sec. 29e): the 0.65 of what it gives off that its plume carries up, from a
// fire as wide as what flames in it, or as the heap if nothing does.
export function plumeRise(b: Bed, air: Air, z: number) {
  const o = output(b, air), q = o.flaming + o.glowing;
  if (q <= 0) return 0;
  const D2 = 2 * (o.flaming > 0 ? o.base : o.radius), z0 = -1.02 * D2 + 0.083 * q ** 0.4;
  return 0.0853 * (air.temp + 273.15) * (0.65 * q) ** (2 / 3) * Math.max(0.01, z - z0) ** (-5 / 3);
}
// Churchill and Bernstein's forced convection in floating point, for what cools out of a fire.
function cools(u: number, d: number) {
  const re = (u * d) / 1.55e-5;
  const nu = 0.3 + ((0.62 * Math.sqrt(re) * Math.cbrt(PR)) / (1 + (0.4 / PR) ** (2 / 3)) ** 0.25) * (1 + (re / 282000) ** 0.625) ** 0.8;
  return (nu * 0.0257) / d / 1000;
}
// How warm something taken out of a fire at T, K, is s seconds on, in air at ta, K, with a wind of u m/s over it (docs/
// research/time-constants.md sec. 2): what it gives off from its whole surface, its own glow to the air's (as anything
// lying about glows, EPS_ITEM) and what the air carries off it (Churchill and Bernstein), out of its heat as a whole, a
// piece small and conducting enough to cool evenly through (its Biot number well under a tenth), stepped five seconds at
// a time.
export function cooling(phys: Phys, temp: number, ta: number, u: number, s: number) {
  const area = Math.PI * phys.d * ((4 * phys.mass) / (Math.PI * phys.rho * phys.d * phys.d) + phys.d / 2), held = phys.mass * phys.c, h = cools(u, phys.d);
  for (let t = 0; t < s && temp > ta; t += 5) temp -= (Math.min(5, s - t) * area * (EPS_ITEM * SIGMA * (temp ** 4 - ta ** 4) + h * (temp - ta))) / held;
  return Math.max(temp, ta);
}
// How warm something's core gets, K, held s seconds where it comes toward T, K, from the air's warmth ta (sec. 29g): while
// it holds water (m, kg to the kg dry) its surface stays at 100 C, what the warmth there nets it boiling the water off; its
// core lags its surface as a round piece heated all round does, wet and then dry.
export function heats(phys: Phys, m: number, temp: number, s: number, ta: number) {
  const d = phys.d, area = Math.PI * d * ((4 * phys.mass) / (Math.PI * phys.rho * d * d) + d / 2);
  const tau = (w: number) => (0.35 * (d / 2) ** 2 * 1000 * phys.rho * (phys.c + 4.19 * w)) / (2 * phys.k);
  const lag = (from: number, to: number, t: number, w: number) => to + (from - to) * Math.exp(-t / tau(w));
  if (temp <= BOIL || m <= 0) return lag(ta, temp, s, m);
  const wet = (m * phys.mass * 2.6 * 1000) / (EPS_ITEM * SIGMA * (temp ** 4 - BOIL ** 4) * area);
  return s <= wet ? lag(ta, BOIL, s, m) : lag(lag(ta, BOIL, wet, m), temp, s - wet, 0);
}
