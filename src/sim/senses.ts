// What people make out of the world with their eyes and ears (docs/research/people-constants.md sec. 12). Nothing here
// asks what a thing is called: a thing is seen by how big it is, how far off, how lit, through how much air, and heard by
// how loud it was said, how far off, through how much air and leaf, against how much noise.
import { meters, type Animal, type Agent, type World } from "./world";
import { canopyAt, lightOn } from "./light";
import { airOn, vapourAt } from "./air";
import { bodyOf, duBois, frameOf } from "./body";
import { SPEC, herded } from "./animals";
import { fishKg } from "./waters";

// ---------- sight ----------
// Blackwell's contrast threshold for a disc of solid angle A, sr, on a field of luminance B, cd/m2: his table 8's 450,000
// observations as Crumey fitted them (2014, eqs. 25, 28, 39, 40 to 44, R1060), Ricco's law R / A for small discs joined
// to the large disc's threshold C_inf, the field taken as black below 1e-5 cd/m2, where vision stops getting better.
const A_ = [5.949e-8, -2.389e-7, 2.459e-7, 4.12e-4, -4.225e-4], B_ = [9.606e-6, -4.112e-5, 5.019e-5, 4.837e-3, -4.884e-3];
const hyper = (k: number[], b: number) => { const r = b ** -0.25; return Math.sqrt(Math.max(0, k[0] * r * r + k[1] * r + k[2])) + k[3] * r + k[4]; };
export function threshold(A: number, B: number) {
  const b = Math.max(B, 1e-5), R = hyper(A_, b) ** 2, inf = hyper(B_, b), lg = Math.log10(b);
  const q = b >= 3.4 ? 1.146 - 0.0885 * lg : b >= 0.193 ? 0.8861 + 0.4 * lg : 0.6;
  return ((R / A) ** q + inf ** q) ** (1 / q);
}
// Blackwell's thresholds are where a trained observer in the laboratory picks the disc half the time; Blackwell and
// Blackwell's 2.4 raises them to plain seeing, sure of what one saw (1971, as Crumey has it, R1060).
const SEEING = 2.4;
// The ground's share of the light that falls on it, FAO-56's grass reference albedo 0.23 (R221), and a person's or a
// thing's, one less skin's short-wave absorptivity 0.7 (R90): what anything stands out from the ground by, (0.3 - 0.23)
// / 0.23 [derived: both are shares of the whole sun's spectrum, not of what the eye sees; gap].
const GROUND = 0.23, STANDS_OUT = (1 - 0.7 - GROUND) / GROUND;
// The air thins a contrast as exp(-sigma d) (Koschmieder): Hammer Odde's hours, 2015 to 2024, give its extinction under
// each sky, the mean of 3.912 / visibility, per m (docs/research/isd/bornholm.py vis; R479) [derived].
const EXTINCTION: Record<World["weather"]["sky"], number> = { clear: 0.2217e-3, cloudy: 0.3442e-3, rain: 0.7062e-3, storm: 0.7615e-3 };
// Johnson's criteria (1958, R1061): the cycles of detail across a thing's critical dimension one must resolve to notice
// it, to tell what it is, and to tell it from things like it; a cycle is two of the details sees() is asked about.
export const JOHNSON = { notice: 1, recognise: 4, identify: 6.4 } as const;
export type Task = keyof typeof JOHNSON;
const detailOf = (size: number, task: Task) => size / (2 * JOHNSON[task]);

// Whether a detail `detail` m across, d m off on ground of luminance `there`, cd/m2, stands out to an eye adapted to
// `adapted`: by STANDS_OUT of the ground's luminance, thinned by the air between, against Blackwell's threshold for its
// solid angle at the adaptation luminance.
function shown(d: number, detail: number, there: number, adapted: number, sky: World["weather"]["sky"]) {
  return STANDS_OUT * Math.exp(-EXTINCTION[sky] * d) * there >= SEEING * threshold(Math.PI * (detail / (2 * d)) ** 2, adapted) * Math.max(adapted, 1e-5);
}
// Whether an eye at `eye` makes out a detail `detail` m across at `at`: the ground's luminance is the light on it, lux,
// as the ground gives it back, rho E / pi; the eye is adapted to the brighter of the ground round itself and round what
// it looks at [design], so one standing by a fire sees less into the dark.
export function sees(w: World, eye: { px: number; py: number }, at: { px: number; py: number }, detail: number) {
  const d = meters(eye, at);
  if (d < detail) return true;
  const there = (GROUND * lightOn(w, at).lux) / Math.PI, here = (GROUND * lightOn(w, eye).lux) / Math.PI;
  return shown(d, detail, there, Math.max(there, here), w.weather.sky);
}
// The farthest a detail `detail` m across is made out on ground lit by `lux`, the eye adapted to it, under a sky, m.
export function sightRange(detail: number, lux: number, sky: World["weather"]["sky"]) {
  const B = (GROUND * lux) / Math.PI, ok = (d: number) => shown(d, detail, B, B, sky);
  let lo = detail, hi = detail;
  if (!ok(lo)) return lo;
  while (ok(hi) && hi < 1e6) hi *= 2;
  for (let k = 0; k < 40; k++) { const m = (lo + hi) / 2; if (ok(m)) lo = m; else hi = m; }
  return lo;
}

// How big the things people look at are, as their critical dimension, m: the square root of what they show of themselves.
// A person standing shows Fanger's projected share 0.35 of the 0.73 of their skin that radiates (R90) [derived].
export const personSize = (w: World, a: Agent) => { const f = frameOf(w, a); return Math.sqrt(0.35 * 0.73 * duBois(f.kg, f.m)); };
// What they hold and work at is a hand's length across, 0.108 of their stature (Drillis and Contini 1966, R1062).
export const handSize = (w: World, a: Agent) => 0.108 * frameOf(w, a).m;
// An animal as a body of water's density, its critical dimension its mass's cube root [design: geometric similarity]; a
// butterfly by its wings (a peacock's 55 mm) [gap].
export const animalSize = (kg: number) => Math.cbrt(kg / 1000);
const BUTTERFLY_SPAN = 0.055;
// An animal's critical dimension: its kind's mass (animals.ts SPEC), a fish's own (waters.ts), a butterfly's wings.
const sizeOf = (w: World, an: Animal) => (an.species === "butterfly" ? BUTTERFLY_SPAN : animalSize(herded(an.species) ? SPEC[an.species].kg : fishKg(w, an)));

export const seesPerson = (w: World, a: { px: number; py: number }, b: Agent, task: Task) => sees(w, a, b, detailOf(personSize(w, b), task));
export const seesHands = (w: World, a: { px: number; py: number }, b: Agent, task: Task) => sees(w, a, b, detailOf(handSize(w, b), task));
export const seesThing = (w: World, a: { px: number; py: number }, t: { px: number; py: number; size: number }, task: Task) => sees(w, a, t, detailOf(t.size, task));
export const seesAnimal = (w: World, a: { px: number; py: number }, an: Animal, task: Task) => sees(w, a, an, detailOf(sizeOf(w, an), task));
// Whoever is awake and makes out what is going on at a place: a thing of `size` m happening there, recognised.
export const witnesses = (w: World, at: { px: number; py: number }, size: number) => w.agents.filter((b) => b.down <= w.t && !bodyOf(w, b).asleep && sees(w, b, at, detailOf(size, "recognise")));

// ---------- hearing ----------
// Speech at 1 m in front of the speaker, ANSI S3.5's overall levels for each vocal effort, dB SPL (R1063).
export const VOICE = { normal: 62.35, raised: 68.34, loud: 74.85, shout: 82.3 } as const;
// The quiet of the land, the floor speech must stand above, dB [gap: natural quiet runs 20 to 30 dB(A) by general
// knowledge, no measurement read; wind in leaves, rain and fire add to it and are left out].
const QUIET = 30;
// Speech is followed where its long-term level is at least the noise's: ANSI S3.5's band audibility (E - N + 15) / 30 at
// one half (R1063) [design: half its 30 dB range heard].
const FOLLOWED = 0.5;
// The air's absorption of sound at f Hz, dB/m, by ISO 9613-1 (R1064): at T K and a molar water vapour h in %, at sea level.
export function airAbsorption(f: number, T: number, h: number) {
  const t = T / 293.15, frO = 24 + (4.04e4 * h * (0.02 + h)) / (0.391 + h), frN = t ** -0.5 * (9 + 280 * h * Math.exp(-4.17 * (t ** (-1 / 3) - 1)));
  return 8.686 * f * f * (1.84e-11 * t ** 0.5 + t ** -2.5 * ((0.01275 * Math.exp(-2239.1 / T)) / (frO + (f * f) / frO) + (0.1068 * Math.exp(-3352 / T)) / (frN + (f * f) / frN)));
}
// Speech carries at 1 kHz, where its intelligibility weighs most (ANSI S3.5's band importance) [design].
const SPEECH_HZ = 1000;
// Dense foliage takes 1 dB off a 1 kHz band over 10 to 20 m of it and 0.06 dB a metre over 20 to 200 m (ISO 9613-2 Table
// A.1, R1065); the path's foliage is the crowns' cover along it, sampled every SAMPLE m [design], no more than full.
const SAMPLE = 10;
function foliage(w: World, a: { px: number; py: number }, b: { px: number; py: number }, d: number) {
  const n = Math.max(1, Math.round(d / SAMPLE));
  let df = 0;
  for (let k = 0; k < n; k++) {
    const f = (k + 0.5) / n;
    df += Math.min(1, canopyAt(w, a.px + (b.px - a.px) * f, a.py + (b.py - a.py) * f)) * (d / n);
  }
  return df < 10 ? 0 : df <= 20 ? 1 : 0.06 * Math.min(df, 200);
}
// The level of speech said at `effort` by `from`, heard at `to`, dB: spreading as a sphere, less the air's and the leaves'.
export function speechAt(w: World, from: { px: number; py: number }, to: { px: number; py: number }, effort: keyof typeof VOICE = "normal") {
  const d = Math.max(1, meters(from, to)), air = airOn(w, from), h = (100 * vapourAt(w, from.px, from.py, w.t)) / 101.325;
  return VOICE[effort] - 20 * Math.log10(d) - airAbsorption(SPEECH_HZ, air.temp + 273.15, h) * d - foliage(w, from, to, d);
}
// How far off speech at `effort` can be followed in still, dry, open air, m: where spreading alone brings it to the floor.
export const earshot = (effort: keyof typeof VOICE = "normal") => 10 ** ((VOICE[effort] - QUIET + 15 - 30 * FOLLOWED) / 20);
// Whether `to` follows what `from` says at `effort` (beyond earshot nothing is, and the rest needn't be worked out).
export function hears(w: World, from: { px: number; py: number }, to: { px: number; py: number }, effort: keyof typeof VOICE = "normal") {
  if (meters(from, to) > earshot(effort)) return false;
  return (speechAt(w, from, to, effort) - QUIET + 15) / 30 >= FOLLOWED;
}
