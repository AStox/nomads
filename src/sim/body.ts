// A person's body by physics (docs/research/body-constants.md). Heat is held in two nodes, a core and a skin, and traded
// with what is round them by radiation, convection, evaporation and breath; the body answers with its skin's blood
// flow, sweat and shivering. Energy is held as glycogen, fat and lean tissue, spent at the basal rate times what they
// are doing (and whatever shivering costs), and taken up from what they have eaten. The pressure to sleep rises while
// they are awake and falls while they sleep. Nothing here asks where they are: sim.ts says what is round them.
import { esat } from "../terrain/climate";
import { ageOf, type Agent, type World } from "./world";

export type Body = {
  core: number; // C
  skin: number; // C, the mean over the whole skin
  gly: number; // kJ of glycogen, muscle and liver
  fat: number; // kg of fat
  lost: number; // kg of lean tissue burnt for want of anything else
  gut: number; // kJ eaten and not yet taken up
  gutKg: number; // kg of food in the stomach
  sleep: number; // the homeostatic pressure to sleep, Borbely's process S, 0 to 1
  asleep?: true;
  dry?: number; // W: the heat their skin gave off in the last tick, which warms any shelter they are in
};

// ---------- size (sec. 1) ----------
// Median mass and stature by age, the mean of boys' and girls' (sec. 1): age in years, kg, m.
const GROWN: [number, number, number][] = [
  [0, 3.465, 0.4964], [0.5, 7.554, 0.6613], [1, 9.913, 0.7466], [2, 12.363, 0.8571], [3, 14.098, 0.9444], [5, 18.162, 1.0828],
  [8, 25.634, 1.2773], [10, 32.414, 1.383], [12, 41.059, 1.5012], [15, 54.162, 1.659], [18, 61.692, 1.6964],
];
// People here have three ages, child, adult and elder (world.ts stageOf), turning at 1 and 5 of the island's years. They
// are taken as grown at 18 and old at 60, with a human year's ageing the same share of each stage [design].
export function realAge(years: number) {
  return years < 1 ? years * 18 : years < 5 ? 18 + ((years - 1) * 42) / 4 : 60 + ((years - 5) * 42) / 4;
}
export function grown(age: number) {
  if (age >= GROWN[GROWN.length - 1][0]) return { kg: GROWN[GROWN.length - 1][1], m: GROWN[GROWN.length - 1][2] };
  const i = GROWN.findIndex((r) => r[0] > age), [a0, k0, m0] = GROWN[i - 1], [a1, k1, m1] = GROWN[i], f = (age - a0) / (a1 - a0);
  return { kg: k0 + (k1 - k0) * f, m: m0 + (m1 - m0) * f };
}
// DuBois and DuBois's skin area, m2, from mass and stature (sec. 1).
export const duBois = (kg: number, m: number) => 0.202 * kg ** 0.425 * m ** 0.725;
// The fat a lean young adult carries, and the least anyone can live with: the Minnesota men's 14% before they were
// starved, and the mean of essential fat's 3 to 5% in men and 8 to 12% in women (sec. 8).
export const FAT0 = 0.14, ESSENTIAL = 0.07;
// Someone of this age as they are now: their lean tissue as grown, less what they have burnt, and their fat.
export function frame(b: Body, age: number) {
  const g = grown(age), lean = g.kg * (1 - FAT0) - b.lost, kg = lean + b.fat;
  return { kg, lean, m: g.m, area: duBois(kg, g.m), age };
}
export type Frame = ReturnType<typeof frame>;

// ---------- energy (sec. 8) ----------
// Glycogen: 500 g in muscle and 100 g in the liver of a young man, 17.2 kJ/g, so about 10 MJ, held in proportion to
// lean tissue (his 60 kg of it) [derived].
const GLY_G = 600, GLY_KJ = 17.2, GLY_LEAN = 70 * (1 - FAT0);
export const glyMax = (f: Frame) => (GLY_G * GLY_KJ * f.lean) / GLY_LEAN;
// Fat and lean tissue as stores, kJ/kg (Hall), and the share of a surplus they keep of what goes into them (Horton,
// a mixed diet).
const RHO_F = 39500, RHO_L = 7600, KEEP = 0.85;
// Schofield's basal rate, the mean of the men's and women's equations for each age band, MJ/day for mass W kg (sec. 8).
const SCHOFIELD: [number, number, number][] = [
  [3, 0.2465, -0.1285], [10, 0.09, 2.0715], [18, 0.065, 2.826], [30, 0.0625, 2.466], [60, 0.041, 3.5955], [Infinity, 0.0435, 2.607],
];
export function basal(f: Frame) {
  const [, a, c] = SCHOFIELD.find((r) => f.age < r[0])!;
  return ((a * f.kg + c) * 1e6) / 86400;
}
// A new body of this age, as fed and rested as these needs say, at the warmth a body keeps.
export function newBody(age: number, food = 90, energy = 90): Body {
  const g = grown(age), b: Body = { core: CORE_N, skin: SKIN_N, gly: 0, fat: g.kg * FAT0, lost: 0, gut: 0, gutKg: 0, sleep: 1 - energy / 100 };
  b.gly = (glyMax(frame(b, age)) * food) / 100;
  return b;
}
// Someone's body, made the first time it's asked of anyone who has none: the first people, someone just born, or anyone
// in a world saved before bodies, from the needs they have.
export const bodyOf = (w: World, a: Agent): Body => (a.body ??= newBody(realAge(ageOf(w, a)), a.needs.food, a.needs.energy));
export const frameOf = (w: World, a: Agent) => frame(bodyOf(w, a), realAge(ageOf(w, a)));

// ---------- heat (secs. 2 to 6) ----------
// Gagge's two-node body: the neutral core and skin, the skin's blood flow at neutral, and how hard warmth and cold
// drive it, sweat and the share of mass the skin holds (sec. 2).
const CORE_N = 36.8, SKIN_N = 33.7, BLOOD_N = 6.3, BLOOD_MAX = 90, SWEAT_MAX = 500;
const C_SW = 170, C_DIL = 120, C_STR = 0.5, TISSUE = 5.28, BLOOD_C = 1.163, BODY_N = 0.1 * SKIN_N + 0.9 * CORE_N;
// The body's specific heat, J/kgK (Xu, Rioux and Castellani).
const C_BODY = 2980;
// Radiation: the skin and clothing's emissivity, and the share of the body's area that radiates, standing (sec. 4).
const SIGMA = 5.67e-8, EPS = 0.95, RAD = 0.73;
// Convection, as the warmth of fires has it (fire-constants sec. 18): still air, and a wind of V m/s.
export const hc = (wind: number) => Math.max(3.4, 10.4 * wind ** 0.56);
// The Lewis relation, K/kPa, and the share of the vapour that passes through clothing (sec. 4).
const LR = 16.5, I_CL = 0.45;
// 1 clo, m2K/W.
export const CLO = 0.155;
// Shivering (sec. 3): Tikuisis and Giesbrecht's heat for the core and the skin, on top of the resting rate, no more than
// 4.9 times that rate in all (Eyolfson), failing between a core of 32 C and 30 C. Work's own heat stands in for it: someone
// at work makes the more of what the work and what shivering at rest would make (Young).
const PEAK = 4.9, SHIVER_FAILS = 32, SHIVER_GONE = 30;
export function shivering(core: number, skin: number, fatShare: number) {
  const s = 155.5 * (37 - core) + 47 * (33 - skin) - 1.57 * (33 - skin) ** 2;
  return Math.max(0, s / Math.sqrt(Math.max(1, fatShare * 100)));
}

// What is round a body for a tick.
export type Around = {
  air: number; // C
  wind: number; // m/s at them
  vapour: number; // kPa
  radiant: number; // C: the mean radiant temperature of the sky, ground, walls and crowns they see
  gain: number; // W for each m2 of skin: the fires' and the sun's radiation they take in
  cover: number; // the share of them a garment covers
  r: number; // m2K/W: that garment's insulation where it covers, as wet as it is
  wetCloth: number; // the share of the garment's outside that is wet
  wetSkin: number; // the share of their bare skin that is wet
  contact: number; // the share of their skin against someone else's
};
// The heat a body of this size trades with what is round it for dt seconds: its own heat production M W/m2 aside from
// shivering, of which basal is its resting rate, and what it takes in and loses. The core and skin move, and what it
// spent, J, gave off dry from its skin, W/m2, and gained or lost in all, W, come back.
const STEP = 60;
export function warm(b: Body, f: Frame, M: number, basal: number, e: Around, dt: number) {
  let spent = 0, dry = 0, store = 0;
  const steps = Math.max(1, Math.round(dt / STEP)), h = dt / steps, fatShare = b.fat / f.kg;
  for (let i = 0; i < steps; i++) {
    const coldSk = Math.max(0, SKIN_N - b.skin), warmSk = Math.max(0, b.skin - SKIN_N), warmCr = Math.max(0, b.core - CORE_N);
    const blood = Math.min(BLOOD_MAX, Math.max(0.5, (BLOOD_N + C_DIL * warmCr) / (1 + C_STR * coldSk)));
    const alfa = 0.0417737 + 0.7451833 / (blood + 0.585417), bodyT = alfa * b.skin + (1 - alfa) * b.core;
    const sweat = Math.min(SWEAT_MAX, C_SW * Math.max(0, bodyT - BODY_N) * Math.exp(warmSk / 10.7));
    const cap = (PEAK - 1) * basal * Math.max(0, Math.min(1, (b.core - SHIVER_GONE) / (SHIVER_FAILS - SHIVER_GONE)));
    const m = Math.max(M, basal + Math.min(cap, shivering(b.core, b.skin, fatShare)));
    const out = exchange(b.skin, e), exposed = 1 - e.contact;
    // the most the skin could sweat away, and what it does: its regulatory sweat and the vapour diffusing through it,
    // or all of it where it is wet
    const vp = Math.max(0, esat(b.skin) - e.vapour), bareMax = vp * out.eBare, coverMax = vp * out.eCover;
    const eMax = e.cover * coverMax + (1 - e.cover) * bareMax;
    const reg = 0.68 * sweat, wSweat = eMax > 0 ? Math.min(1, 0.06 + (0.94 * reg) / eMax) : 0.06;
    const evap = e.cover * coverMax * wSweat + (1 - e.cover) * bareMax * Math.max(wSweat, e.wetSkin);
    const res = 0.0014 * m * (34 - e.air) + 0.0173 * m * (5.87 - e.vapour);
    const cs = (b.core - b.skin) * (TISSUE + BLOOD_C * blood);
    const sCore = m - cs - res, sSkin = cs - exposed * (out.dry + evap);
    b.core += (sCore * f.area * h) / (C_BODY * (1 - alfa) * f.kg);
    b.skin += (sSkin * f.area * h) / (C_BODY * alfa * f.kg);
    spent += m * f.area * h;
    dry += (exposed * out.dry) / steps;
    store += (sCore + sSkin) / steps;
  }
  return { spent, dry, store: store * f.area };
}
// The skin's dry heat out to its surroundings, W/m2, over its bare share and through its garment where it covers, and
// the vapour conductance of each, W/m2kPa.
function exchange(skin: number, e: Around) {
  const c = hc(e.wind), hr = (t: number) => 4 * EPS * SIGMA * RAD * ((t + e.radiant) / 2 + 273.15) ** 3;
  const to = (r: number) => (c * e.air + r * e.radiant + e.gain) / (c + r);
  const bareR = hr(skin), bare = (c + bareR) * (skin - to(bareR)), eBare = LR * c;
  if (e.cover <= 0 || e.r < 1e-4) return { dry: bare, eBare, eCover: eBare };
  // the garment's outside settles where what comes through it from the skin leaves it by radiation, the air and any
  // water drying off it
  const fcl = 1 + (0.3 * e.r) / CLO;
  let cl = skin;
  for (let i = 0; i < 6; i++) {
    const r = hr(cl), dryOff = e.wetCloth * LR * c, slope = dryOff * (esat(cl + 0.05) - esat(cl - 0.05)) * 10;
    const out = fcl * ((c + r) * (cl - to(r)) + dryOff * Math.max(0, esat(cl) - e.vapour));
    const f = (skin - cl) / e.r - out, df = -1 / e.r - fcl * (c + r + slope);
    cl -= f / df;
  }
  const covered = (skin - cl) / e.r;
  return { dry: e.cover * covered + (1 - e.cover) * bare, eBare, eCover: 1 / (1 / (LR * c * fcl) + e.r / (LR * I_CL)) };
}
// A garment's insulation for so much of it standing proud of the skin, m: clothing and fur alike, 1.57 clo for each cm
// (sec. 5), less as it gets wet: at half its weight in water it keeps 35% (sec. 5), and no more is lost past that.
export const insulation = (depth: number, water: number) => depth * 100 * 1.57 * CLO * (1 - 0.65 * Math.min(1, water / 0.5));
// The sky's temperature, C, over air at this temperature with this share of it clouded: Swinbank's clear sky, and the
// air's own under full cloud (sec. 4).
export function skyTemp(air: number, cloud: number) {
  const k = air + 273.15, clear = 0.0552 * k ** 1.5 - 273.15;
  return clear + (air - clear) * cloud;
}
// The mean radiant temperature of the open, C: half sky and half ground for someone standing, the ground at the air's
// warmth, and what crowns hide of the sky at the air's warmth too (sec. 4).
export function openRadiant(air: number, sky: number, crowns: number) {
  const k = (t: number) => (t + 273.15) ** 4, s = 0.5 * (1 - Math.min(1, crowns));
  return (s * k(sky) + (1 - s) * k(air)) ** 0.25 - 273.15;
}
// What a fire's radiant flux q (kW/m2, at its strongest across the line to it) or the sun's beam I (W/m2 across the
// beam) gives each m2 of a standing body's skin (sec. 4): the share of the body that radiates, Fanger's projected area
// for a fire low down or the sun at its height, and the skin's or clothing's absorptivity for long or short waves.
const F_LOW = 0.35, A_LW = 0.95, A_SW = 0.7;
const F_SUN = [0.35, 0.35, 0.314, 0.258, 0.206, 0.144, 0.082]; // standing, sun in front, every 15 degrees up
export const fireGain = (q: number) => A_LW * F_LOW * RAD * q * 1000;
export function sunGain(beam: number, el: number) {
  if (beam <= 0 || el <= 0) return 0;
  const x = Math.min(6, (el * 180) / Math.PI / 15), i = Math.min(5, Math.floor(x));
  return A_SW * (F_SUN[i] + (F_SUN[i + 1] - F_SUN[i]) * (x - i)) * RAD * beam;
}

// ---------- the energy stores (sec. 8) ----------
// Gastric emptying: an exponential with a half-time of 90 minutes (sec. 8).
const EMPTY = 90 * 60;
// A tick of dt seconds: what they ate is taken up, and what they spent comes out of glycogen, fat and lean tissue. What
// a deficit takes from glycogen is the share of the store that is full; the rest comes from fat, and once fat is down to
// what a body can't do without, from lean tissue [design: the check in sec. 8 is the 45 to 73 days of a total fast].
export function feed(b: Body, f: Frame, spent: number, dt: number) {
  const k = 1 - 0.5 ** (dt / EMPTY), up = b.gut * k;
  b.gut -= up; b.gutKg *= 1 - k;
  let net = up - spent / 1000;
  const max = glyMax(f);
  if (net >= 0) {
    const g = Math.min(net, max - b.gly);
    b.gly += g; net -= g;
    const lean = Math.min(b.lost, (net * KEEP) / RHO_L);
    b.lost -= lean; net -= (lean * RHO_L) / KEEP;
    b.fat += (net * KEEP) / RHO_F;
    return;
  }
  let need = -net;
  const g = Math.min(b.gly, (need * b.gly) / max);
  b.gly -= g; need -= g;
  const spare = Math.max(0, b.fat - ESSENTIAL * f.kg), fat = Math.min(spare, need / RHO_F);
  b.fat -= fat; need -= fat * RHO_F;
  if (need > 0) {
    const gl = Math.min(b.gly, need);
    b.gly -= gl; need -= gl;
    b.lost += need / RHO_L;
  }
}
// What eating something puts in the stomach: its energy, kJ, and its mass, kg. The stomach holds GUT kg, a woman's measured
// gastric capacity at food's density of about 1 kg/L (sec. 8).
export const GUT = 1.1;
export function ingest(b: Body, kj: number, kg: number) {
  b.gut += kj;
  b.gutKg += kg;
}
// The thinnest a body lives: BMI 12 (sec. 8).
export const LETHAL_BMI = 12;

// ---------- sleep (sec. 9) ----------
// Borbely's two processes with Daan, Beersma and Borbely's parameters: S rises toward 1 awake with a time constant of
// 18.2 h and falls toward 0 asleep with 4.2 h; sleep comes when it reaches the upper threshold and ends at the lower,
// both swung by the circadian clock, lowest at 04:00.
const CHI_W = 18.2, CHI_S = 4.2, UPPER = 0.67, LOWER = 0.17, SWAY = 0.12, LOW_HOUR = 4;
const clock = (hour: number) => -Math.cos((2 * Math.PI * (hour - LOW_HOUR)) / 24);
export const sleepy = (hour: number) => UPPER + SWAY * clock(hour);
export const rested = (hour: number) => LOWER + SWAY * clock(hour);
// S after dt seconds, awake or asleep; asleep, it falls at the share rate of its pace that the place lets them sleep.
export function pressure(b: Body, asleep: boolean, rate: number, dt: number) {
  const hours = dt / 3600;
  b.sleep = asleep ? b.sleep * Math.exp((-hours * rate) / CHI_S) : 1 - (1 - b.sleep) * Math.exp(-hours / CHI_W);
}

// ---------- how it feels, and how it ends (secs. 7, 8) ----------
// The three bars the rest of the sim reads, 0 to 100: food, how full their glycogen and stomach are; warmth, the colder
// of their skin between where cold hurts (15 C) and the edge of cool discomfort (32.6 C) and their core between the
// onset of hypothermia (35 C) and its neutral 36.8; energy, how far they are from the most S can be.
export function feels(b: Body, f: Frame) {
  const pct = (x: number) => Math.round(Math.max(0, Math.min(100, x * 100)) * 10) / 10;
  return {
    food: pct((b.gly + b.gut) / glyMax(f)),
    warmth: Math.min(pct((b.skin - 15) / (32.6 - 15)), pct((b.core - 35) / (CORE_N - 35))),
    energy: pct(1 - b.sleep),
  };
}
// Swiss staging: impaired consciousness under 32 C, no vital signs under 24 C; heat stroke over 40 C, death all but
// certain at 43 C. And the thinnest a body lives.
export const DOWN_COLD = 32, DEAD_COLD = 24, DOWN_HOT = 40, DEAD_HOT = 43;
export function fate(b: Body, f: Frame): "cold" | "heat" | "hunger" | "down" | null {
  if (b.core <= DEAD_COLD) return "cold";
  if (b.core >= DEAD_HOT) return "heat";
  if (f.kg <= LETHAL_BMI * f.m * f.m) return "hunger";
  return b.core < DOWN_COLD || b.core > DOWN_HOT ? "down" : null;
}
