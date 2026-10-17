// Throwing, hunting and fishing by physics (docs/research/people-constants.md sec. 9). A throw is a launch by the
// thrower's arm or a bow, a flight through the air with drag, a scatter of aim, a hit or a miss on the animal's own
// body where it stands, and a wound by the energy that arrives: a cutting point driven in against the flesh, a blunt one
// by the blunt criterion. A kill gives the animal's own body: its meat, fat, bone and skin by its mass. A fish comes to
// a basket swept or a line dangled by how often each fish of that water meets it.
import { SPEC, herded, type Herded } from "./animals";
import { FOOD_KJ, PHYS, asFound, physOf, stackPhys, type Edge, type Phys } from "./fuel";
import { CHOP_MET, GROWN, NET_EFF, TICK_S, isWood, type Striker } from "./mechanics";
import { frame, newBody } from "./body";
import type { Kind, Registry } from "./materials";
import type { Animal, Stack } from "./world";

const G = 9.81, RHO_AIR = 1.2, RHO_WATER = 1000; // m/s2; air and water, kg/m3 (fire-constants sec. 6)

// ---------- the body aimed at (secs. 9.4, 9.5) ----------
// A body about as dense as water [design]. A red deer's chest: a point has to reach about its middle to kill, 20 to 25
// cm in for large ungulates (Sitton et al., R1035, after Friis-Hansen), 22.5 cm at the red deer's 116 kg (R304); a deer
// stands 1.07 to 1.37 m at the shoulder (R304). Every other body is a deer's scaled by its mass to the third
// [derived: geometric similarity]. The trunk is a cylinder as wide as twice the depth to the middle, as long as its
// mass makes it [derived].
// (SPEC is read only when called: animals.ts and this module import each other through physics.ts.)
const BODY_RHO = 1000, DEER_MIDDLE = 0.225, DEER_SHOULDER = (1.07 + 1.37) / 2;
// The vital zone, heart and lungs, as one sphere in the chest: Stahl's lungs, 53.5 M^1.06 mL, and heart, 0.0058 M^0.98
// kg, M in kg (R1038).
const lungs = (kg: number) => 53.5e-6 * kg ** 1.06, heart = (kg: number) => (0.0058 * kg ** 0.98) / BODY_RHO;
export type Body = { kg: number; dia: number; len: number; vital: number; middle: number; chest: number };
export function animalBody(kg: number): Body {
  const s = Math.cbrt(kg / SPEC.deer.kg), middle = DEER_MIDDLE * s, dia = 2 * middle;
  const len = kg / BODY_RHO / ((Math.PI / 4) * dia * dia), vital = Math.cbrt((6 * (lungs(kg) + heart(kg))) / Math.PI);
  return { kg, dia, len, vital, middle, chest: DEER_SHOULDER * s - middle };
}
// An animal's live mass, kg: its kind's (animals.ts SPEC), taken at a full fat reserve [design], less the fat it lacks of
// that now (its object's reserve, as its hunger reads it, animals.ts sync).
const FAT_KJ = FOOD_KJ.fat;
export const fatOf = (sp: Herded, hunger = 100) => (Math.max(0, Math.min(100, hunger)) / 100) * (SPEC[sp].full / FAT_KJ);
export const massOf = (an: Pick<Animal, "species" | "hunger">) => (herded(an.species) ? SPEC[an.species].kg - fatOf(an.species) + fatOf(an.species, an.hunger) : 0);
// Top running speed, m/s: Hirt et al.'s law for running animals, 26 M^0.26 (1 - e^(-22 M^-0.6)) km/h (R1039).
export const topSpeed = (kg: number) => (26 * kg ** 0.26 * (1 - Math.exp(-22 * kg ** -0.6))) / 3.6;

// ---------- what a carcass gives (sec. 9.8; body-constants sec. 10) ----------
// The dressed share of live mass, and of the dressed carcass the bone and the carcass's own fat: a red deer's measured
// (R297, R300, R303), a rabbit's measured (R298, R301, R302); the other kinds take a deer's [design]. The fat about the
// gut and kidneys and in the carcass is the fat reserve the animal carries (animals.ts reserve), so a lean one gives
// less of it.
const SHARES: Partial<Record<Herded, { dressed: number; bone: number; fat: number }>> = { rabbit: { dressed: 0.555, bone: 0.13, fat: 0.035 } };
const DEER = { dressed: 0.55, bone: 0.22, fat: 0.0517 };
export function carcassOf(sp: Herded, fatKg = fatOf(sp)): Record<string, number> {
  const c = SHARES[sp] ?? DEER, kg = SPEC[sp].kg, dressed = kg * c.dressed;
  const out: Record<string, number> = {};
  const meat = Math.round((dressed * (1 - c.bone - c.fat)) / asFound(PHYS.meat)), fat = Math.round(fatKg / asFound(PHYS.fat)), bone = Math.round((dressed * c.bone) / asFound(PHYS.bone));
  if (meat > 0) out.meat = meat;
  if (fat > 0) out.fat = fat;
  if (bone > 0) out.bone = bone;
  out.hide = 1;
  return out;
}
// Its skin as one piece: Meeh's surface area, 0.1 M^(2/3) m2 (R1042), as thick as a deer's hide (fire-constants sec.
// 27c, 3 mm) scaled by mass to the third [derived], at the hide's dry density (fuel.ts PHYS.hide).
export function hideOf(kg: number) {
  const d = PHYS.hide.d * Math.cbrt(kg / SPEC.deer.kg), area = 0.1 * kg ** (2 / 3);
  return { d, len: Math.sqrt(area), mass: area * d * PHYS.hide.rho };
}

// ---------- the missile (secs. 9.1, 9.2) ----------
// What flies: its mass, thickness and length; its point, the finest edge among its parts (a head hafted on), and that
// part's thickness; whether it flies point first, which a shaft of wood as long as holdOf's 0.3 m (physics.ts) with an
// edge on it does [design], a stone or a flake tumbling; and its
// drag, Cd times the area it meets the air with. A shaft point first: Miyazaki et al.'s fletched arrow, Cd 2.65 at 58
// m/s on its cross-section, 625 mm long and 5.25 mm across (R1033), its drag skin friction, so scaled by length over
// thickness [derived]. Anything tumbling: a sphere of its volume, Cd 0.47 (Hoerner, R1034).
const LONG = 0.3, ARROW_CD = 2.65, ARROW_LD = 625 / 5.25, SPHERE_CD = 0.47;
export type Missile = { m: number; d: number; len: number; tip?: Edge; tipD: number; point: boolean; cdA: number };
const lengthOf = (x: Phys, s?: Stack) => s?.size?.len ?? x.mass / ((x.rho * Math.PI * x.d * x.d) / 4);
function partsOf(reg: Registry, k: Kind): Phys[] {
  const parts = k.verb === "join" ? (k.parts ?? []).map((id) => physOf(reg, reg[id])).filter((x): x is Phys => !!x) : [];
  return parts.length >= 2 ? parts : [];
}
// The point of something held or thrown: the edge of its finest-edged part, and how thick that part is; none if no part
// has an edge.
export function tipOf(reg: Registry, k: Kind, s?: Stack): { tip?: Edge; d: number } {
  const parts = partsOf(reg, k), x = (s && stackPhys(reg, s)) ?? physOf(reg, k);
  const head = [...(parts.length ? parts : x ? [x] : [])].filter((q) => q.edge).sort((u, v) => u.edge!.r - v.edge!.r)[0];
  return head ? { tip: head.edge, d: head.d } : { d: x?.d ?? 0 };
}
export function missileOf(reg: Registry, k: Kind, s?: Stack): Missile | undefined {
  const x = (s && stackPhys(reg, s)) ?? physOf(reg, k);
  if (!x) return undefined;
  const parts = partsOf(reg, k), wood = (parts.length ? parts : [x]).filter(isWood).sort((u, v) => lengthOf(v) - lengthOf(u))[0];
  const len = wood ? lengthOf(wood, parts.length ? undefined : s) : x.d, d = wood ? wood.d : x.d, { tip, d: tipD } = tipOf(reg, k, s);
  const point = !!tip && len >= LONG;
  const ball = Math.cbrt((6 * (x.mass / x.rho)) / Math.PI);
  const cdA = point ? ARROW_CD * (len / d / ARROW_LD) * (Math.PI / 4) * d * d : SPHERE_CD * (Math.PI / 4) * ball * ball;
  return { m: x.mass, d: point ? d : ball, len, tip, tipD, point, cdA };
}

// ---------- the launch (sec. 9.1) ----------
// Who throws: their lean mass and stature, against a grown body's.
export type Thrower = Striker & { m: number };
const grownFrame = frame(newBody(18), 18);
export const GROWN_THROWER: Thrower = { ...GROWN, m: grownFrame.m };
// By hand: Cross's overarm throws, KE = A m / (m + B), the mean of his five throwers, A 128.4 J and B 0.52 kg (a third
// of the forearm and hand they swing, R1030), A by the thrower's lean mass against a grown body's, as a blow's energy
// (mechanics.ts) [derived].
const ARM_A = (94 + 179 + 99 + 149 + 121) / 5, ARM_B = (0.9 + 2.13 + 1.53 + 1.5 + 1.74) / 5 / 3;
export const handKE = (m: number, who: Thrower = GROWN_THROWER) => ((ARM_A * m) / (m + ARM_B)) * (who.lean / GROWN.lean);
// From a bow: Kooi and Bergman's straight-ended self bow, storing q = 0.407 of draw weight times draw length and giving
// eta = 0.765 of it to the arrow; a wooden self bow's draw weight times draw over the mass of one limb, 180 (a flatbow)
// and 230 (the Mary Rose longbow) J/kg, 205 here; drawn 0.7112 m; and the heaviest bow drawn, the Mary Rose's 465 N
// (R1032), by lean mass, and the draw by stature, against a grown body's [derived].
const BOW_Q = 0.407, BOW_ETA = 0.765, BOW_DBV = (180 + 230) / 2, BOW_DRAW = 0.7112, BOW_MOST = 465;
export function bowKE(reg: Registry, bow: Kind, who: Thrower = GROWN_THROWER) {
  const parts = partsOf(reg, bow), wood = (parts.length ? parts : [physOf(reg, bow)].filter((x): x is Phys => !!x)).filter(isWood);
  const limbs = wood.reduce((t, x) => t + x.mass, 0) / 2, draw = BOW_DRAW * (who.m / GROWN_THROWER.m);
  const WD = Math.min(BOW_DBV * limbs, BOW_MOST * (who.lean / GROWN.lean) * draw);
  return BOW_ETA * BOW_Q * WD;
}
// Released at the shoulder: 0.818 of stature (Drillis and Contini, R1062).
export const releaseAt = (who: Thrower) => 0.818 * who.m;

// ---------- the flight (sec. 9.2) ----------
// Steps of 5 ms (10 cm at 20 m/s) and elevations scanned a degree apart, then bisected [design: numerics].
const DT = 0.005, SCAN = Math.PI / 180;
// A flight at elevation th from h0 over the ground, by gravity and drag, until it passes x or falls to the ground: the
// height there (or -1 if it landed short), the time, the speed and how far it went.
function fly(ms: Missile, v0: number, th: number, h0: number, x: number) {
  let px = 0, pz = h0, vx = v0 * Math.cos(th), vz = v0 * Math.sin(th), t = 0;
  const k = (0.5 * RHO_AIR * ms.cdA) / ms.m;
  while (px < x) {
    const v = Math.hypot(vx, vz);
    vx -= k * v * vx * DT;
    vz -= (G + k * v * vz) * DT;
    px += vx * DT; pz += vz * DT; t += DT;
    if (pz < 0) return { z: -1, t, v, dist: px };
    if (t > 30) return { z: -1, t, v, dist: px };
  }
  return { z: pz, t, v: Math.hypot(vx, vz), dist: px };
}
// The flattest throw that reaches height h at distance d: the time it takes and the speed it arrives at; or, past its
// reach, how far its farthest throw goes.
export type Flight = { reached: true; t: number; v: number } | { reached: false; dist: number };
export function flight(ms: Missile, v0: number, h0: number, d: number, h: number): Flight {
  let lo = -Math.PI / 4, best = { dist: 0 };
  for (let th = lo; th <= Math.PI / 3; th += SCAN) {
    const f = fly(ms, v0, th, h0, d);
    if (f.z >= h) {
      let hi = th;
      for (let i = 0; i < 24; i++) { const mid = (lo + hi) / 2; if (fly(ms, v0, mid, h0, d).z >= h) hi = mid; else lo = mid; }
      const g = fly(ms, v0, hi, h0, d);
      return { reached: true, t: g.t, v: g.v };
    }
    lo = th;
    if (f.z < 0 && f.dist > best.dist) best = { dist: f.dist };
  }
  return { reached: false, dist: best.dist };
}
// How far a throw can reach a body's chest, m: the farthest distance the flight still gets there, to the metre.
// (Each missile, launch and height asked once: stalkers ask it every tick.)
const ranges = new Map<string, number>();
export function throwRange(ms: Missile, v0: number, h0: number, h: number) {
  const key = `${ms.m}|${ms.cdA}|${v0}|${h0}|${h}`, known = ranges.get(key);
  if (known !== undefined) return known;
  let lo = 0, hi = 1;
  while (hi < 400 && flight(ms, v0, h0, hi, h).reached) { lo = hi; hi *= 2; }
  while (hi - lo > 1) { const mid = Math.floor((lo + hi) / 2); if (flight(ms, v0, h0, mid, h).reached) lo = mid; else hi = mid; }
  if (ranges.size >= 4096) ranges.clear();
  ranges.set(key, lo);
  return lo;
}

// ---------- the aim (sec. 9.3) ----------
// Where a throw lands about the point aimed at, as a normal spread of angle, the same across and up: 0.048 rad, the
// spread that fits Milks et al.'s javelin throwers' hits on a hay bale lying 105 by 50 cm to them at 5 to 25 m (58,
// 25, 25, 17 and 0%; R1031) [derived]. A bow's own spread was not found and takes the same [gap].
export const SPREAD = 0.048;
const normal = (r1: number, r2: number) => Math.sqrt(-2 * Math.log(1 - r1)) * Math.cos(2 * Math.PI * r2);

// ---------- the wound (secs. 9.4, 9.6, 9.7) ----------
// A cutting point drives in against the flesh with a force that grows with the point's cross-section's perimeter: the
// line through Sitton et al.'s fourteen stone points' energy over depth in clay, which cuts as meat does, 110.8 N plus
// 1.475 N a mm of perimeter (R1035) [derived]. Depth, m, from energy E, J.
const PEN_F0 = 110.8, PEN_F1 = 1.475;
export const tcsp = (tip: Edge, d: number) => 4 * Math.hypot((tip.len * 1000) / 2, (d * 1000) / 2);
export const depthOf = (E: number, tip: Edge, d: number) => E / (PEN_F0 + PEN_F1 * tcsp(tip, d));
// A blunt blow by the blunt criterion, BC = ln(E / (W^(1/3) T D)), W the body's kg, T its wall's thickness, 0.7 W^(1/3)
// cm, D the impactor's diameter, cm (Sturdivan et al., R1036); its injury on the abbreviated scale, AIS = 1.33 BC + 0.6
// (Bir and Viano, R1036); an AIS 3 injury fatal one time in ten and an AIS 4 up to half the time (R1037), AIS 5 and
// over taken as fatal [derived], straight between.
export function bluntAIS(E: number, kg: number, D: number) {
  const W = Math.cbrt(kg), T = 0.7 * W;
  return 1.33 * Math.log(E / (W * T * D * 100)) + 0.6;
}
export const deathOf = (ais: number) => (ais < 3 ? 0 : ais < 4 ? 0.1 + 0.4 * (ais - 3) : ais < 5 ? 0.5 + 0.5 * (ais - 4) : 1);
export type Wound = "kill" | "wound" | "none";
// What a hit does: the energy E it arrives with, the missile, the body, and whether it struck the vital zone; draw, for
// a blunt blow's chance of death.
export function woundOf(E: number, ms: Pick<Missile, "tip" | "tipD" | "point" | "d">, body: Body, vital: boolean, draw: number): { wound: Wound; depth?: number; ais?: number } {
  if (ms.point && ms.tip) {
    const depth = depthOf(E, ms.tip, ms.tipD);
    return { wound: vital && depth >= body.middle ? "kill" : "wound", depth };
  }
  const ais = bluntAIS(E, body.kg, ms.d);
  return { wound: draw < deathOf(ais) ? "kill" : ais >= 1 ? "wound" : "none", ais };
}

// ---------- one throw (sec. 9) ----------
// A throw at an animal d m off, aimed at its chest: by hand, or by the bow (its energy, J); its flight there (flightTo).
// draws: five draws in [0, 1), two for each of the scatter's two ways and one for a blunt blow's chance of death. What
// it comes to: missed (how far past or short of the animal it came down, m, along the line, and how far wide), or hit,
// and the wound.
export type Throw = { hit: false; along: number; across: number; t?: number } | { hit: true; vital: boolean; E: number; t: number; wound: Wound; depth?: number; ais?: number };
export const flightTo = (ms: Missile, KE: number, who: Thrower, an: Animal, d: number) => flight(ms, Math.sqrt((2 * KE) / ms.m), releaseAt(who), d, animalBody(massOf(an)).chest);
export function throwAt(ms: Missile, an: Animal, d: number, bearing: number, draws: number[], f: Flight): Throw {
  if (!f.reached) return { hit: false, along: f.dist - d, across: 0 };
  // the scatter of the aim, and an animal on the run moving across the line in the throw's time (Hirt's top speed)
  const body = animalBody(massOf(an)), rel = an.heading - bearing, run = an.state === "flee" ? topSpeed(body.kg) * f.t : 0;
  const ex = SPREAD * d * normal(draws[0], draws[1]) + run * Math.sin(rel), ez = SPREAD * d * normal(draws[2], draws[3]);
  const wide = Math.abs(Math.sin(rel)) * body.len + Math.abs(Math.cos(rel)) * body.dia;
  if (Math.abs(ex) > wide / 2 || Math.abs(ez) > body.dia / 2) return { hit: false, along: ez > 0 ? ez : 0, across: ex, t: f.t };
  const vital = ex * ex + ez * ez <= (body.vital / 2) ** 2, E = 0.5 * ms.m * f.v * f.v;
  return { hit: true, vital, E, t: f.t, ...woundOf(E, ms, body, vital, draws[4]) };
}
// The chance a throw kills an animal standing broadside d m off, taking the scatter's draws on a grid and a blunt blow's
// at its middle [derived]: what anyone who knows the weapon and the animal would expect of a throw (formulas.ts).
export function killChance(ms: Missile, KE: number, who: Thrower, an: Animal, d: number) {
  const N = 8, f = flightTo(ms, KE, who, an, d), bearing = an.heading - Math.PI / 2, u = (i: number) => (i + 0.5) / N;
  let kills = 0;
  for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) for (let k = 0; k < N; k++) for (let l = 0; l < N; l++) {
    const r = throwAt(ms, an, d, bearing, [u(i), u(j), u(k), u(l), 0.5], f);
    if (r.hit && r.wound === "kill") kills++;
  }
  return kills / N ** 4;
}
// A hunter loosing one aimed arrow after another: ten to twelve a minute from a longbow (R1046), every 5.5 s
// [UNVERIFIED]; a throw is taken at the same pace [design].
export const SHOT_S = 60 / 11;
export const throwsInTick = () => Math.max(1, Math.floor(TICK_S / SHOT_S));
// As close as hunters throw from: thrown spears' effective distance in the ethnographic review Milks et al. cite, 5 to
// 10 m (R1031), its middle.
export const STALK = 7.5;

// ---------- fishing (sec. 9.9) ----------
// A fish meets a gear as molecules of a gas meet a target (Gerritsen and Strickler, R1045, in the plane of the water):
// at a rate of 2 R s / A, R how near it has to come, s how fast the two close, A the water of the cell it ranges over
// in a day (waters.ts: the GPU moves it once a day) [derived]. A fish cruises at a body length a second (Videler,
// R1043) [UNVERIFIED]; it notices a bait within two body lengths (Hughes and Dill, R1044) [UNVERIFIED] and takes it
// [design]; it is taken by a basket whose mouth it swims into or is swept over [design: none escape].
const CRUISE = 1, NOTICE = 2;
// A basket: a hemisphere of its own wall, its mass over its density and thickness, swept through the water by the
// arms at the power they keep up at work (mechanics.ts: chopping's net mechanical power) against the water's drag on its
// mouth, a disk's Cd 1.17 (Hoerner, R1034) [derived].
const DISK_CD = 1.17;
export function basketOf(x: Phys, basal: number) {
  const r = Math.sqrt(x.mass / (x.rho * x.d) / (2 * Math.PI));
  const P = NET_EFF * (CHOP_MET - 1) * basal, u = Math.cbrt((2 * P) / (RHO_WATER * DISK_CD * Math.PI * r * r));
  return { r, u };
}
export type Gear = { line: true } | { line: false; r: number; u: number };
export type Meeting = { fish: { id: number; cm: number }[]; area: number };
// Each fish's chance of being caught over s seconds of fishing.
export function catchChances(gear: Gear, meet: Meeting, s: number) {
  return meet.fish.map((f) => {
    const L = f.cm / 100, v = CRUISE * L;
    const rate = gear.line ? (2 * NOTICE * L * v) / meet.area : (2 * gear.r * Math.hypot(gear.u, v)) / meet.area;
    return meet.area > 0 ? 1 - Math.exp(-rate * s) : 0;
  });
}
// The fish a gear brings up in s seconds: a line, the first that bites, if any does; a basket, every one it takes.
// draws: one for each fish, and one more.
export function caught(gear: Gear, meet: Meeting, s: number, draw: () => number): number[] {
  const p = catchChances(gear, meet, s);
  if (!gear.line) return meet.fish.filter((_, i) => draw() < p[i]).map((f) => f.id);
  const none = p.reduce((t, q) => t * (1 - q), 1);
  if (draw() >= 1 - none) return [];
  // which bit first: in proportion to how often each meets the line
  const rates = p.map((q) => -Math.log(1 - Math.min(q, 1 - 1e-12))), total = rates.reduce((t, r) => t + r, 0);
  let pick = draw() * total;
  for (let i = 0; i < rates.length; i++) if ((pick -= rates[i]) <= 0) return [meet.fish[i].id];
  return [meet.fish[meet.fish.length - 1].id];
}
