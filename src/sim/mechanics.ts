// How matter takes a blow, a rub and a hammering: the energy a body puts into a swing, wood cut across its grain and
// split along it, stone flaked and boulders broken, an edge worn down, pyrite's sparks, a rubbed ember and copper drawn
// out. Every number is docs/research/matter-constants.md's, by its section; what a material is made of comes from fuel.ts.
import { BURNS, WOODS, pieceOf, type Edge, type Phys, type Wood } from "./fuel";
import { basal, frame, newBody } from "./body";
import { TICK_S } from "./ticks";

// ---------- a blow (sec. 1) ----------
// Chopping: 8.0 MET at 35 blows a minute (Compendium 11262); the arms' net efficiency, arm cranking's 10 to 17%; a swing's
// speed against what is swung, Cross and Bower's V = C / I^0.27, set by a wood bat's 35.2 m/s at its tip, 0.209 kg m2 about
// a pivot 0.152 m along its 0.864 m; a hand, 0.53 kg at the last 10 cm of what it holds.
export const NET_EFF = 0.135, CHOP_MET = 8, CADENCE = 35 / 60;
const HAND = 0.53, GRIP = 0.1, I_REF = 0.209, W_REF = 35.2 / (0.864 - 0.152), SWING_N = 0.27;
// What is swung: a head of so many kg at the end of a handle so long and heavy, or held in the fist (no handle).
export type Swung = { mass: number; lever?: number; handle?: number };
export const swingI = (s: Swung) =>
  s.lever ? s.mass * s.lever ** 2 + ((s.handle ?? 0) * s.lever ** 2) / 3 + HAND * GRIP ** 2 : (s.mass + HAND) * GRIP ** 2;
// The mass a blow lands with, kg: what is swung as a point at its striking end.
export const landsWith = (s: Swung) => swingI(s) / (s.lever ?? GRIP) ** 2;
// Who swings: their basal rate, W, and their lean mass, kg (body.ts).
export type Striker = { basal: number; lean: number };
const grownFrame = frame(newBody(18), 18);
export const GROWN: Striker = { basal: basal(grownFrame), lean: grownFrame.lean };
// A blow's energy, J: the least of what the body keeps up at chopping over 35 blows a minute and what the swing reaches,
// that by their lean mass against a grown body's.
export function blowEnergy(s: Swung, who: Striker = GROWN) {
  const kept = (NET_EFF * (CHOP_MET - 1) * who.basal) / CADENCE;
  const I = swingI(s), w = W_REF * (I / I_REF) ** -SWING_N;
  return Math.min(kept, ((0.5 * I * w * w) * who.lean) / GROWN.lean);
}
// What someone keeps at in a day before they give it up as more than a day's work: eight hours' blows [design].
export const DAY_WORK = 8 * 3600 * CADENCE;
// Blows struck in a tick of steady work.
export const BLOWS = CADENCE * TICK_S;

// ---------- wood (sec. 2) ----------
// The Wood Handbook's functions of specific gravity, green and at 12% water, softwood and hardwood: compression parallel to
// the grain, kPa, as [a, b] in a G^b.
const CRUSH = { green: { soft: [49700, 0.94], hard: [49000, 1.11] }, dry: { soft: [93700, 0.97], hard: [76000, 0.89] } } as const;
// Wood's crushing strength parallel to its grain, Pa, at its water m (kg to the kg dry): green past 25%, at 12% below 12%,
// log-linear between.
export function crushOf(G: number, hard: boolean, m: number) {
  const row = hard ? "hard" : "soft", [ag, bg] = CRUSH.green[row], [ad, bd] = CRUSH.dry[row];
  const green = ag * G ** bg * 1000, dry = ad * G ** bd * 1000, M = m * 100;
  if (M >= 25) return green;
  if (M <= 12) return dry;
  return dry * (dry / green) ** ((12 - M) / (25 - 12));
}
// The work of fracture across the grain, J/m2; splitting with a blade 30 deg or wider and at 7 deg, J/m2; and friction on
// wood.
export const GF_CROSS = 75000, SPLIT_WIDE = 1400, SPLIT_NARROW = 4200, MU_WOOD = 0.25;
export const splitCost = (angle: number) => {
  const deg = (angle * 180) / Math.PI;
  return deg >= 30 ? SPLIT_WIDE : SPLIT_NARROW - ((SPLIT_NARROW - SPLIT_WIDE) * (Math.max(7, deg) - 7)) / (30 - 7);
};
// The wood a piece is: its species' (generic softwood for none).
export const woodKind = (species?: string) => {
  const sp = (species && species in WOODS ? species : "generic") as Wood | "generic", wd = WOODS[sp];
  return { G: wd.G, hard: wd.row === "hardwood", green: wd.green, heart: wd.heart };
};
// Whether a record is wood: it burns as softwood or hardwood does (fuel.ts).
export const isWood = (x?: Phys) => !!x && (x.burn === BURNS.softwood || x.burn === BURNS.hardwood);
// The water in living wood of a species with none recorded, kg to the kg: fibre saturation [design].
export const FSP = 0.3;
// A record's G and grain row, if it's wood.
export const gOf = (x: Phys) => ({ G: x.rho / 1000, hard: x.burn === BURNS.hardwood });
// What an edge of wood is as hard as: its crushing strength, kept in [design].
export const woodH = (x: Phys) => crushOf(x.rho / 1000, x.burn === BURNS.hardwood, 0.12);

// ---------- cutting across the grain (sec. 3) ----------
// How deep a blow's energy E, J, drives a blade into wood across its fibres, m, along L of its edge: the new surface, the
// crushing ahead of the rounded edge and the faces wedging the fibres apart against friction.
export function cutDepth(E: number, edge: Edge, crush: number, L = edge.len) {
  const a = crush * (Math.tan(Math.min(edge.angle, Math.PI * 0.999) / 2) + MU_WOOD), c = GF_CROSS + 2 * edge.r * crush, k = E / L;
  return (2 * k) / (c + Math.sqrt(c * c + 4 * a * k));
}
// The share of a blow's energy a struck stem takes into the cut, its effective mass m_s against the mass the blow lands
// with: a plastic impact. A stem rooted or lying takes it all.
export const intoCut = (stem: number, hits: number) => (Number.isFinite(stem) ? stem / (stem + hits) : 1);
// A stem's effective mass at the blow, kg: a tip-loaded cantilever's 33/140 of its mass.
export const stemEffective = (kg: number) => (33 / 140) * kg;
// Blows to cut through a stem D across with a blade cutting x deep a blow along L of edge: a 90 deg notch to its middle from
// either side, D^3 / 3 of wood, taken out a chip of L x^2 / 2 to each two blows.
export function blowsThrough(D: number, edgeLen: number, x: number) {
  const L = Math.min(edgeLen, D);
  return x > 0 ? (4 * D ** 3) / (3 * L * x * x) : Infinity;
}

// ---------- splitting along the grain (sec. 4) ----------
// The energy to split a piece d thick and len long into n along its grain, J: n - 1 faces through its middle.
export const splitEnergy = (d: number, len: number, n: number, angle: number) => (n - 1) * d * len * splitCost(angle);
// Only a blade drives a split.
export const isBlade = (e?: Edge) => !!e && e.angle < Math.PI / 2;

// ---------- flaking and breaking rock (sec. 5) ----------
// The energy a flake's two new faces take, J/m2 of each; and granite's Bond work index, kWh/t.
export const W_F = 74, WI_GRANITE = 15.13;
// The energy to knock a flake of this record off a stone: its two faces, each its volume over its thickness.
export const flakeEnergy = (flake: Phys) => (2 * W_F * flake.mass) / flake.rho / flake.d;
// Bond's law: the energy to break a kg of rock from F m across to P m across, J.
export const bond = (F: number, P: number, wi = WI_GRANITE) => (P >= F ? 0 : 10 * wi * (1 / Math.sqrt(P * 1e6) - 1 / Math.sqrt(F * 1e6)) * 3600);
// A boulder D across, kg, as a sphere of the stone it is.
export const boulderKg = (D: number, rock: Phys) => (Math.PI / 6) * D ** 3 * rock.rho;

// ---------- edges and wear (sec. 6) ----------
// The stone axe's edge lasts 3.5 trees of 168 strokes on 5 cm laurel oak; a chert edge's hardness, Pa; laurel oak's
// specific gravity [UNVERIFIED], green.
export const EDGE_LIFE = 3.5 * 168, H_CHERT = 10e9, OAK_G = 0.56;
export const STONE_AXE: Swung = { mass: 0.5, lever: 0.7, handle: 0.4 };
export const OAK_CRUSH = crushOf(OAK_G, true, 1);
// The share of an edge's life one blow of energy E into wood of crushing strength crush wears away, for an edge this hard:
// Archard's law, scaled from the stone axe.
export const wearOf = (E: number, crush: number, H: number) => (E / blowEnergy(STONE_AXE)) * (H_CHERT / H) * (crush / OAK_CRUSH) / EDGE_LIFE;
// Something blunt, end on: as round as it is thick.
export const blunt = (d: number): Edge => ({ angle: Math.PI, r: d / 2, len: d });

// ---------- sparks (sec. 7) ----------
// Pyrite shaved by a harder stone burns; plant tinder catches at the 55th spark, one a stroke.
export const PYRITE_MOHS = 6.25, SPARKS_TO_CATCH = 55;
export const sparks = (a?: Phys, b?: Phys) =>
  !!a?.mech && !!b?.mech && ((!!a.mech.pyrite && (b.mech.mohs ?? 0) > PYRITE_MOHS) || (!!b.mech.pyrite && (a.mech.mohs ?? 0) > PYRITE_MOHS));

// ---------- friction fire (sec. 8) ----------
// A bow drill: Duncan's 60 N at 1.86 m/s, a 4.2 mm divot; two sticks worked by hand: 30 N at 0.5 m/s; wood on wood's
// 0.25; and char dust lights at 371 C.
export const BOW = { force: 60, speed: 1.86 }, HANDS = { force: 30, speed: 0.5 }, DIVOT = 0.0042, T_DUST = 371;
// Seconds of rubbing until the dust in the notch lights: the friction's power, half into each piece, over the contact,
// heating its face as a thick piece's (combustion.ts needs) with the wood's kρc and water.
export function emberSeconds(spindle: Phys, m: number, bow: boolean, air: number) {
  const { force, speed } = bow ? BOW : HANDS, r = spindle.d / 2;
  const q = (MU_WOOD * force * speed) / 2 / (Math.PI * (r * r + DIVOT * DIVOT)) / 1000; // kW/m2
  const krc = spindle.burn?.krc ?? BURNS.softwood.krc, dT = T_DUST - air;
  return ((Math.PI / 4) * krc * (1 + 8.1 * m) * dT * dT) / (q * q);
}

// ---------- copper (sec. 9) ----------
// Annealed copper's Hollomon curve; cold, it splits past a true strain of 1.5; red hot, each blow works it annealed; the
// edge's last 2 cm is what is drawn out; a blade's edge is thinner than 0.5 mm.
export const COLD_SPLITS = 1.5, HOT_STRAIN = 0.002, WORKED = 0.02, BLADE = 0.0005;
// The plastic work to draw a strip from strain e0 to e1, J/m3, hot (annealed throughout) or cold (hardening).
export function drawWork(K: number, n: number, e0: number, e1: number, hot: boolean) {
  return hot ? K * HOT_STRAIN ** n * (e1 - e0) : (K * (e1 ** (n + 1) - e0 ** (n + 1))) / (n + 1);
}
// The strain a piece reaches from e0 with work W, J/m3.
export function drawnTo(K: number, n: number, e0: number, W: number, hot: boolean) {
  return hot ? e0 + W / (K * HOT_STRAIN ** n) : ((W * (n + 1)) / K + e0 ** (n + 1)) ** (1 / (n + 1));
}

// ---------- what things break into (sec. 10) ----------
// Repola's Scots pine: dry kg of stem wood, living and dead branches from breast-height diameter d, cm, and height h, m,
// each retransformed by its log-normal variance.
const dS = (d: number) => 2 + 1.25 * d;
export const stemKg = (d: number, h: number) => Math.exp(-3.721 + (8.103 * dS(d)) / (dS(d) + 14) + (5.066 * h) / (h + 12) + (0.002 + 0.009) / 2);
export const branchKg = (d: number, h: number) => Math.exp(-6.162 + (15.075 * dS(d)) / (dS(d) + 12) - (2.618 * h) / (h + 12) + (0.041 + 0.089) / 2);
export const deadKg = (d: number) => 0.911 * Math.exp(-5.201 + (10.574 * dS(d)) / (dS(d) + 16) + (0.253 + 0.362) / 2);
// A standing tree's trunk, m across at breast height, by its height (fuel.ts pieces).
export const trunkOf = (t: { kind: string; species?: string; size: number }) => pieceOf({ ...t, kind: "tree" }, "log")!.size.d;
