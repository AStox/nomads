// What things are made of, physically: the quantities the fire, heat and water formulas read, one record for each kind
// of stuff. Every number is docs/research/fire-constants.md section 27's, where each traces to its source (fuel.test.ts
// holds the two to each other). A record is of the dry stuff: water is kg of it to each kg of that, and what a thing
// holds comes and goes with the weather (wetness.ts).
import type { Kind, Registry } from "./materials";
import type { Size } from "./world";
import type { SHRUBS, TREES } from "../terrain/niche";

// How something burns, if it does: what lights it, the heat its flames and its glowing char give, the char it leaves,
// and the heat it takes to drive its gases off.
export type Burn = {
  tig: number; // C: it lights when its surface comes to this
  qcr: number; // kW/m2: the least flux that ever lights it
  krc: number; // (kW/m2K)^2 s: the kρc a thick piece of it heats by, dry
  flame: number; // MJ from each kg of the gases its flames burn
  char: number; // MJ from each kg of its char glowing away
  charYield: number; // kg of char each kg burnt leaves
  L: number; // kJ to drive off each g of its gases
  share: number; // the share of its mass that burns: all of it, unless it was made with something that doesn't
};
export type Phys = {
  rho: number; // kg of the dry stuff in each m3 of a piece
  c: number; // kJ/kgK, dry
  k: number; // W/mK: dry across the grain for plant matter and char, as found for the rest
  mmax: number; // the most water it holds
  green?: number; // the water in it alive, or as it's found
  heart?: number; // the water in a living trunk's heartwood
  d: number; // m: how thick one is, which sets how fast heat and water reach its middle
  mass: number; // kg of one, dry
  herb?: true; // herbaceous, behind a waxy skin that lets water in and out slowly (sec. 27f)
  kj?: number; // kJ in each kg of it, dry, to whoever eats it (body-constants sec. 10)
  pile?: number; // m of hair standing proud of it, which insulates whoever wears it (body-constants sec. 5)
  burn?: Burn;
  mech?: Mech; // how it takes a blow, if not as wood does (matter-constants)
  edge?: Edge; // its edge, if it has one (matter-constants sec. 6)
};
// A blade's edge: its included angle, rad; how round it is across, m; and how long, m.
export type Edge = { angle: number; r: number; len: number };
// How a solid takes a blow (matter-constants): its scratch hardness on Mohs's scale and its indentation hardness, Pa;
// whether it flakes; pyrite, which burns where it's shaved; and a metal's Hollomon curve, Pa.
export type Mech = { mohs?: number; H?: number; flakes?: true; pyrite?: true; flow?: { K: number; n: number } };

// The ways things burn (sec. 27a).
export const BURNS = {
  softwood: { tig: 350, qcr: 11, krc: 0.22, flame: 13, char: 30, charYield: 0.45, L: 12.5, share: 1 },
  hardwood: { tig: 305, qcr: 11, krc: 0.22, flame: 13, char: 30, charYield: 0.45, L: 9.4, share: 1 },
  fine: { tig: 250, qcr: 11, krc: 0.22, flame: 12, char: 30, charYield: 0.45, L: 12.5, share: 1 },
  fern: { tig: 250, qcr: 11, krc: 0.22, flame: 13.7, char: 30, charYield: 0.45, L: 12.5, share: 1 },
  bark: { tig: 350, qcr: 11, krc: 0.22, flame: 13, char: 30, charYield: 0.45, L: 12.5, share: 1 },
  hide: { tig: 305, qcr: 11, krc: 0.22, flame: 14, char: 30, charYield: 0.45, L: 9.4, share: 1 },
  fat: { tig: 265, qcr: 11, krc: 0.27, flame: 36, char: 30, charYield: 0, L: 1.82, share: 1 },
  resin: { tig: 187, qcr: 11, krc: 0.28, flame: 36, char: 30, charYield: 0, L: 1.82, share: 1 },
  char: { tig: 350, qcr: 11, krc: 0.22, flame: 0, char: 30, charYield: 1, L: 12.5, share: 1 },
} satisfies Record<string, Burn>;
export type Row = keyof typeof BURNS;

// Plant matter by its specific gravity G (R6): its dry heat capacity at 20 C, its dry conductivity across the grain, and
// the most water its cell walls and hollows hold. The dry stuff of an animal or a fruit, by Chen's model with no water
// left in it (sec. 23).
const PLANT_C = 0.1031 + 0.003867 * 293.15, SOLIDS_C = 4.19 - 2.3 - 0.628;
const plant = (G: number, row: Row, d: number, mass: number): Phys =>
  ({ rho: 1000 * G, c: PLANT_C, k: G * 0.1941 + 0.01864, mmax: (1.54 - G) / (1.54 * G), d, mass, burn: BURNS[row] });

// Wood by the plant it grew on (sec. 27b): how dense it is, the water in it alive, and which way it burns. Wood of no
// known species is the generic wood the checks of sections 3 and 16 use.
export type Wood = (typeof TREES)[number] | (typeof SHRUBS)[number];
export const WOODS: Record<Wood | "generic", { G: number; green?: number; heart?: number; row: Row }> = {
  pine: { G: 0.42, green: 1.2, heart: 0.35, row: "softwood" },
  oak: { G: 0.58, green: 0.78, heart: 0.64, row: "hardwood" },
  ash: { G: 0.57, green: 0.44, heart: 0.46, row: "hardwood" },
  aspen: { G: 0.35, green: 1.13, heart: 0.95, row: "hardwood" },
  hazel: { G: 0.5, green: 0.8, row: "hardwood" },
  heather: { G: 0.55, green: 0.8, row: "hardwood" },
  berry: { G: 0.55, green: 0.65, row: "hardwood" },
  generic: { G: 0.45, row: "softwood" },
};
// A piece of wood of a species (or of none), so thick and so heavy.
export function woodOf(species: Wood | "generic", d: number, mass: number): Phys {
  const { G, green, heart, row } = WOODS[species];
  return { ...plant(G, row, d, mass), ...(green === undefined ? {} : { green }), ...(heart === undefined ? {} : { heart }) };
}

// Fine dead fuel, the NFDRS's (R30): grass, fiber, fronds and petals, a blade thick, herbaceous. Living herbaceous
// matter holds the NFDRS's most, 250% (R30 [read]; reeds' too, an analogue, sec. 27f).
const fine = (mass: number): Phys => ({ ...plant(0.513, "fine", 0.00061, mass), herb: true });
export const LIVE_HERB = 2.5;
// How the hard things take a blow (matter-constants secs. 5 to 7): granite scratches like its quartz and feldspar and flakes,
// coarsely; flint and chert harder still, finely; bone flakes into shards; each flake's edge as knapping leaves it.
const deg = Math.PI / 180;
const GRANITE = { mohs: 6.5, H: 7e9, flakes: true as const }, FLINT = { mohs: 7, H: 10e9, flakes: true as const }, BONE = { mohs: 2.5, H: 0.6e9, flakes: true as const };
const granite = (d: number, mass: number, edge?: Edge): Phys => ({ rho: 2630, c: 0.775, k: 2.79, mmax: 0, d, mass, mech: GRANITE, ...(edge ? { edge } : {}) });
const flint = (d: number, mass: number, edge?: Edge): Phys => ({ rho: 2650, c: 0.74, k: 3, mmax: 0, d, mass, mech: FLINT, ...(edge ? { edge } : {}) });
const bone = (d: number, mass: number, edge?: Edge): Phys => ({ rho: 1920, c: 0.835, k: 0.72, mmax: 0.1, green: 0.1, d, mass, mech: BONE, ...(edge ? { edge } : {}) });
const flesh = (mass: number): Phys => ({ rho: 263, c: SOLIDS_C, k: 0.47, mmax: 3, green: 3, d: 0.03, mass });
const fruit = (d: number, mass: number): Phys => ({ rho: 150, c: SOLIDS_C, k: 0.51, mmax: 5.67, green: 5.67, d, mass });
const seed = (d: number, mass: number): Phys => ({ rho: 1131, c: SOLIDS_C, k: 0.15, mmax: 0.15, green: 0.15, d, mass });

// What eating a kind gives, kJ for each kg of it dry (body-constants sec. 10): USDA's energy over the dry matter of the
// wild food each stands for, blackberries, raw acorns, wild rice, chanterelles, dandelion greens, venison, wild trout (half
// a whole fish is eaten, FAO) and rendered fat.
export const FOOD_KJ = { berry: 15230, nut: 22470, grain: 16190, mushroom: 13140, greens: 13100, meat: 19040, fish: 17740 * 0.5, fat: 37740 };
// Food gathered off plants comes in portions as picked (body-constants sec. 10): berries as much as fills both hands,
// grain and nuts a handful.
export const BOTH_HANDS = 0.25, HANDFUL = 0.05;
// Every raw material (materials.ts BASE), as one of it is (sec. 27c).
export const PHYS: Record<string, Phys> = {
  stick: woodOf("generic", 0.025, 0.22),
  log: woodOf("generic", 0.17, 10),
  plank: woodOf("generic", 0.085, 5),
  bark: { rho: 460, c: PLANT_C, k: 0.46 * 0.1941 + 0.01864, mmax: 1.85, d: 0.002, mass: 0.1, burn: BURNS.bark },
  fiber: fine(0.02),
  fern: { ...fine(0.05), green: 3.33, burn: BURNS.fern },
  flower: { ...fine(0.005), green: LIVE_HERB, kj: FOOD_KJ.greens },
  herb: { ...fine(0.01), green: LIVE_HERB, kj: FOOD_KJ.greens },
  hide: { rho: 441, c: SOLIDS_C, k: 0.47, mmax: 1.7, green: 1.7, d: 0.003, mass: 2, burn: BURNS.hide, pile: 0.02 },
  bone: bone(0.02, 0.3),
  bone_shard: bone(0.005, 0.02, { angle: 40 * deg, r: 20e-6, len: 0.03 }),
  stone: granite(0.1, 2.6),
  sharp_stone: granite(0.01, 0.066, { angle: 70 * deg, r: 1e-3, len: 0.04 }),
  pebble: granite(0.02, 0.021),
  flint: flint(0.08, 1.36),
  flint_blade: flint(0.01, 0.066, { angle: 35 * deg, r: 1e-6, len: 0.04 }),
  ore: { rho: 3800, c: 0.8, k: 2.8, mmax: 0, d: 0.05, mass: 0.475, mech: { mohs: 4 } },
  // a nodule of iron pyrite, as one lies in chalk or mudstone (matter-constants sec. 7) [UNVERIFIED]
  pyrite: { rho: 5010, c: 0.52, k: 19, mmax: 0, d: 0.05, mass: 0.33, mech: { mohs: 6.25, pyrite: true } },
  clay: { rho: 1608, c: 0.8, k: 0.52, mmax: 0.65, green: 0.275, d: 0.05, mass: 0.2 },
  charcoal: { ...woodOf("generic", 0.025, 0.05), rho: 1000 * WOODS.generic.G * BURNS.softwood.charYield, burn: BURNS.char },
  fat: { rho: 900, c: 2, k: 0.15, mmax: 0, d: 0.02, mass: 0.5, burn: BURNS.fat, kj: FOOD_KJ.fat },
  resin: { rho: 1080, c: 1.98, k: 0.13, mmax: 0, d: 0.01, mass: 0.05, burn: BURNS.resin },
  meat: { ...flesh(0.13), kj: FOOD_KJ.meat },
  fish: { ...flesh(0.075), kj: FOOD_KJ.fish },
  berry: { ...fruit(0.012, BOTH_HANDS / (1 + 5.67)), kj: FOOD_KJ.berry },
  mushroom: { ...fruit(0.03, 0.0075), kj: FOOD_KJ.mushroom },
  grain: { ...seed(0.004, HANDFUL / (1 + 0.15)), kj: FOOD_KJ.grain },
  nut: { ...seed(0.015, HANDFUL / (1 + 0.15)), kj: FOOD_KJ.nut },
};
// One of something as it's found, kg: its dry mass and the water it holds alive.
export const asFound = (x: Phys) => x.mass * (1 + (x.green ?? 0));

// The matter making makes new (sec. 27d): clay fired hard, copper bled from ore, hide cured into leather, each the size
// of what it was made from but the copper, and the wall of a pot pressed from clay.
export const FIRED_CLAY = { rho: 1920, c: 0.835, k: 0.72, mmax: 0.1 };
export const LEATHER = { rho: 750, c: SOLIDS_C, k: 0.47, mmax: 1.7, burn: BURNS.hide };
// annealed copper drawn out under the hammer by its Hollomon curve, 55 HV annealed (matter-constants sec. 9)
export const COPPER: Phys = { rho: 8930, c: 0.385, k: 401, mmax: 0, d: 0.01, mass: 0.1, mech: { mohs: 3, H: 0.54e9, flow: { K: 320e6, n: 0.54 } } };
export const POT_WALL = 0.007;
export const remade = (matter: Omit<Phys, "d" | "mass">, from: Phys | undefined): Phys | undefined => from && { ...matter, d: from.d, mass: from.mass };

// Matter made of other matter, by mass (sec. 27d): the masses add and so do the volumes; heat capacity, conductivity
// and the water it holds go by each part's share of the mass; it is as thick as its thickest part; and it burns as the
// parts that burn do, by their share of the mass.
export function mix(parts: Phys[]): Phys | undefined {
  if (parts.length <= 1) return parts[0];
  const mass = parts.reduce((t, x) => t + x.mass, 0);
  const by = (f: (x: Phys) => number) => parts.reduce((t, x) => t + f(x) * x.mass, 0) / mass;
  const burning = parts.flatMap((x) => (x.burn ? [{ b: x.burn, m: x.mass * x.burn.share }] : []));
  const burnt = burning.reduce((t, x) => t + x.m, 0);
  const byBurn = (f: (b: Burn) => number) => burning.reduce((t, x) => t + f(x.b) * x.m, 0) / burnt;
  return {
    rho: mass / parts.reduce((t, x) => t + x.mass / x.rho, 0), c: by((x) => x.c), k: by((x) => x.k), mmax: by((x) => x.mmax),
    d: Math.max(...parts.map((x) => x.d)), mass, ...(parts.every((x) => x.herb) ? { herb: true as const } : {}),
    // what it gives eaten is its parts' by mass, food or not; its hair is its hairiest part's
    ...(parts.some((x) => x.kj) ? { kj: by((x) => x.kj ?? 0) } : {}),
    ...(parts.some((x) => x.pile) ? { pile: Math.max(...parts.map((x) => x.pile ?? 0)) } : {}),
    ...(burnt > 0 ? { burn: {
      tig: byBurn((b) => b.tig), qcr: byBurn((b) => b.qcr), krc: byBurn((b) => b.krc), flame: byBurn((b) => b.flame), char: byBurn((b) => b.char),
      charYield: byBurn((b) => b.charYield), L: byBurn((b) => b.L), share: burnt / mass,
    } } : {}),
  };
}

// What a kind is made of: a raw material's record from the table (so a saved world reads today's), a made kind's as it
// was made, or, for one made before records were kept, its parts' by mass.
export function physOf(reg: Registry, k: Kind | undefined): Phys | undefined {
  if (!k) return undefined;
  if (k.base) return PHYS[k.base];
  return k.phys ?? mix((k.parts ?? []).flatMap((id) => physOf(reg, reg[id]) ?? []));
}
// What one held thing is made of: its kind's record, as big as the piece it is, and a piece of wood (a thing that chars,
// not char itself) of its own species' wood.
export function stackPhys(reg: Registry, s: { k: string; size?: Size; species?: string }): Phys | undefined {
  const kind = physOf(reg, reg[s.k]);
  if (!kind || !s.size) return kind;
  const wood = s.species && s.species in WOODS && kind.burn && kind.burn.charYield < 1;
  return { ...(wood ? woodOf(s.species as Wood, s.size.d, s.size.mass) : kind), d: s.size.d, mass: s.size.mass };
}
// The water in wood cut from a living plant of a species (sec. 27b, 27f): a branch's or stem's is its sapwood's, a log's
// the mean of its sapwood and heartwood. None for no known species.
export function greenOf(species: string | undefined, log = false) {
  const w = species && species in WOODS ? WOODS[species as Wood] : undefined;
  return w?.green === undefined ? undefined : log && w.heart !== undefined ? (w.green + w.heart) / 2 : w.green;
}

// ---------- pieces of wood ----------
// What a plant gives, piece by piece (sec. 27e). A trunk is as thick as a forest tree of its height (sec. 19a; a fallen log
// is a trunk as tall as it is long), and a log is a meter of it. A stick, branch or stem is a young stem as long as it is,
// by its species' height-to-diameter ratio, but heather's, which stays thin (sec. 19c). A tree's branch is a fifth of its
// height, a stump's a meter, a bush's stem as long as the bush is tall.
const TRUNK: Partial<Record<Wood | "generic", (H: number) => number>> = {
  pine: (H) => 0.01721 * H ** 0.842, oak: (H) => 0.00489 * H ** 1.334, ash: (H) => ((100 * H) / 290) ** 1.938 / 100, aspen: (H) => 0.00343 * H ** 1.371,
};
const STEM: Record<Wood | "generic", (len: number) => number> = {
  pine: (len) => len / 105, oak: (len) => len / 112, ash: (len) => len / 133, aspen: (len) => len / 142, hazel: (len) => len / 119, berry: (len) => len / 119,
  heather: () => 0.0035, generic: (len) => len / 123,
};
export const LOG_LEN = 1;
// A round piece of a species' wood, so thick and so long.
export const roundSize = (species: Wood | "generic", d: number, len: number): Size => ({ d, len, mass: (Math.PI / 4) * d * d * len * 1000 * WOODS[species].G });
// The piece of wood of the item a thing standing or lying in the world gives, with what it grew as: none if it gives none.
export function pieceOf(t: { kind: string; species?: string; size: number }, item: string): { size: Size; species?: Wood } | undefined {
  const sp = t.species && t.species in WOODS ? (t.species as Wood) : "generic", grew = sp === "generic" ? {} : { species: sp };
  const trunk = t.kind === "tree" || t.kind === "fallen_log";
  if (item === "log" && trunk) return { size: roundSize(sp, TRUNK[sp]?.(t.size) ?? STEM[sp](t.size), LOG_LEN), ...grew };
  if (item !== "stick" || !["tree", "fallen_log", "stump", "bush", "dead_bush", "stick"].includes(t.kind)) return undefined;
  const len = trunk ? t.size / 5 : t.kind === "stump" ? 1 : t.size;
  return { size: roundSize(sp, STEM[sp](len), len), ...grew };
}
// Splitting a piece into n along its grain: each 1/n as thick, as long, with 1/n of its mass.
export const splitSize = (s: Size, n: number): Size => ({ d: s.d / n, len: s.len, mass: s.mass / n });
// The char a piece of wood leaves burnt in a smothered fire, shared among n lumps: each as thick as the wood (no shrinkage
// was read, sec. 27e), its length shared out, with its row's char yield of the wood's mass.
export const charSize = (s: Size, charYield: number, n: number): Size => ({ d: s.d, len: s.len / n, mass: (s.mass * charYield) / n });
