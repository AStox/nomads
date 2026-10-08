// What things are made of, physically: the quantities the fire, heat and water formulas read, one record for each kind
// of stuff. Every number is docs/research/fire-constants.md section 27's, where each traces to its source (fuel.test.ts
// holds the two to each other). A record is of the dry stuff: water is kg of it to each kg of that, and what a thing
// holds comes and goes with the weather (wetness.ts).
import type { Kind, Registry } from "./materials";
import type { Size } from "./world";
import type { SHRUBS, TREES } from "../terrain/flora";

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
  burn?: Burn;
};

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
  gorse: { G: 0.72, green: 0.6, row: "hardwood" },
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
const granite = (d: number, mass: number): Phys => ({ rho: 2630, c: 0.775, k: 2.79, mmax: 0, d, mass });
const flint = (d: number, mass: number): Phys => ({ rho: 2650, c: 0.74, k: 3, mmax: 0, d, mass });
const bone = (d: number, mass: number): Phys => ({ rho: 1920, c: 0.835, k: 0.72, mmax: 0.1, green: 0.1, d, mass });
const flesh = (mass: number): Phys => ({ rho: 263, c: SOLIDS_C, k: 0.47, mmax: 3, green: 3, d: 0.03, mass });
const fruit = (d: number, mass: number): Phys => ({ rho: 150, c: SOLIDS_C, k: 0.51, mmax: 5.67, green: 5.67, d, mass });
const seed = (d: number, mass: number): Phys => ({ rho: 1131, c: SOLIDS_C, k: 0.15, mmax: 0.15, green: 0.15, d, mass });

// Every raw material (materials.ts BASE), as one of it is (sec. 27c).
export const PHYS: Record<string, Phys> = {
  stick: woodOf("generic", 0.025, 0.22),
  log: woodOf("generic", 0.17, 10),
  plank: woodOf("generic", 0.085, 5),
  bark: { rho: 460, c: PLANT_C, k: 0.46 * 0.1941 + 0.01864, mmax: 1.85, d: 0.002, mass: 0.1, burn: BURNS.bark },
  fiber: fine(0.02),
  fern: { ...fine(0.05), green: 3.33, burn: BURNS.fern },
  flower: { ...fine(0.005), green: LIVE_HERB },
  herb: { ...fine(0.01), green: LIVE_HERB },
  hide: { rho: 441, c: SOLIDS_C, k: 0.47, mmax: 1.7, green: 1.7, d: 0.003, mass: 2, burn: BURNS.hide },
  bone: bone(0.02, 0.3),
  bone_shard: bone(0.005, 0.02),
  stone: granite(0.1, 2.6),
  sharp_stone: granite(0.01, 0.066),
  pebble: granite(0.02, 0.021),
  flint: flint(0.08, 1.36),
  flint_blade: flint(0.01, 0.066),
  ore: { rho: 3800, c: 0.8, k: 2.8, mmax: 0, d: 0.05, mass: 0.475 },
  clay: { rho: 1608, c: 0.8, k: 0.52, mmax: 0.65, green: 0.275, d: 0.05, mass: 0.2 },
  charcoal: { ...woodOf("generic", 0.025, 0.05), rho: 1000 * WOODS.generic.G * BURNS.softwood.charYield, burn: BURNS.char },
  fat: { rho: 900, c: 2, k: 0.15, mmax: 0, d: 0.02, mass: 0.5, burn: BURNS.fat },
  resin: { rho: 1080, c: 1.98, k: 0.13, mmax: 0, d: 0.01, mass: 0.05, burn: BURNS.resin },
  meat: flesh(0.13),
  fish: flesh(0.075),
  berry: fruit(0.012, 0.00014),
  mushroom: fruit(0.03, 0.0075),
  grain: seed(0.004, 0.044),
  nut: seed(0.015, 0.002),
};

// The matter making makes new (sec. 27d): clay fired hard, copper bled from ore, hide cured into leather, each the size
// of what it was made from but the copper, and the wall of a pot pressed from clay.
export const FIRED_CLAY = { rho: 1920, c: 0.835, k: 0.72, mmax: 0.1 };
export const LEATHER = { rho: 750, c: SOLIDS_C, k: 0.47, mmax: 1.7, burn: BURNS.hide };
export const COPPER: Phys = { rho: 8930, c: 0.385, k: 401, mmax: 0, d: 0.01, mass: 0.1 };
export const POT_WALL = 0.007;
export const remade = (matter: Omit<Phys, "d" | "mass">, from: Phys | undefined): Phys | undefined => from && { ...matter, d: from.d, mass: from.mass };

// Matter made of other matter, by mass (sec. 27d): the masses add and so do the volumes; heat capacity, conductivity
// and the water it holds go by each part's share of the mass; it is as thick as its thickest part; and it burns as the
// parts that burn do, by their share of the mass.
export function mix(parts: Phys[]): Phys | undefined {
  if (!parts.length) return undefined;
  const mass = parts.reduce((t, x) => t + x.mass, 0);
  const by = (f: (x: Phys) => number) => parts.reduce((t, x) => t + f(x) * x.mass, 0) / mass;
  const burning = parts.flatMap((x) => (x.burn ? [{ b: x.burn, m: x.mass * x.burn.share }] : []));
  const burnt = burning.reduce((t, x) => t + x.m, 0);
  const byBurn = (f: (b: Burn) => number) => burning.reduce((t, x) => t + f(x.b) * x.m, 0) / burnt;
  return {
    rho: mass / parts.reduce((t, x) => t + x.mass / x.rho, 0), c: by((x) => x.c), k: by((x) => x.k), mmax: by((x) => x.mmax),
    d: Math.max(...parts.map((x) => x.d)), mass, ...(parts.every((x) => x.herb) ? { herb: true as const } : {}),
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
// by its species' height-to-diameter ratio, but a gorse stem, which thickens faster, and heather's, which stays thin
// (sec. 19c). A tree's branch is a fifth of its height, a stump's a meter, a bush's stem as long as the bush is tall.
const TRUNK: Partial<Record<Wood | "generic", (H: number) => number>> = {
  pine: (H) => 0.01721 * H ** 0.842, oak: (H) => 0.00489 * H ** 1.334, ash: (H) => ((100 * H) / 290) ** 1.938 / 100, aspen: (H) => 0.00343 * H ** 1.371,
};
const STEM: Record<Wood | "generic", (len: number) => number> = {
  pine: (len) => len / 105, oak: (len) => len / 112, ash: (len) => len / 133, aspen: (len) => len / 142, hazel: (len) => len / 119, berry: (len) => len / 119,
  gorse: (len) => Math.min(0.025 * len, 0.033), heather: () => 0.0035, generic: (len) => len / 123,
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
