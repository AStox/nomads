// How wet everything is. Every material thing holds water, kg of it to each kg of the dry stuff (fuel.ts), and draws
// toward what its surroundings would leave in it, the faster the thinner it is: toward all it can hold in rain or
// standing water, and otherwise toward the equilibrium of the air at its own warmth, which the sun on it, a fire by it or
// the body it's carried against raises (docs/research/fire-constants.md sections 5, 10, 11, 18, 20 and 27f). Roofs and
// bags keep the rain off and nothing else. The grass, fern and dead wood lying about the island hold what the island's
// weather has left in dead stuff of their thickness (Weather.dead) until somebody picks them up. What it comes to
// decides whether a spark or an ember catches in tinder (physics.ts), and how cold the wet-through feel (sim.ts needs).
import { DAY, YEAR_DAYS, hourOf, meters, wetAt, type Agent, type Stack, type Thing, type World } from "./world";
import { anyAround, liveThings, nearestThing } from "./space";
import { airAt, airOn, humidity, islandAir, rainAt, snowAt, vapourAt } from "./air";
import { canopyAt } from "./light";
import { daylight, sunAt } from "./sky";
import { p, type Kind } from "./materials";
import { PHYS, stackPhys, type Phys } from "./fuel";
import { output, setUp } from "./combustion";
import { esat } from "../terrain/climate";

// A struck spark catches in tinder this wet or drier, an ember blown into it in tinder this wet or drier (sec. 10).
export const DAMP = 0.1, SOAKED = 0.13;
// Wood holds no free water below this (sec. 5).
const FSP = 0.3;
export const raining = (w: World) => w.weather.sky === "rain" || w.weather.sky === "storm";
// Under a roof: a shelter of their own or anyone's close enough to be under.
export function sheltered(w: World, a: { px: number; py: number }) {
  return !!anyAround(w, a.px, a.py, 4, ["structure"], (t) => (t.shelter?.tier ?? 0) >= 1);
}
// Tinder: fine, dry, stringy stuff an ember or a spark can catch in, as fiber and bark are.
export const tinder = (k?: Kind) => !!k && !k.parts?.length && p(k, "fibrous") >= 0.6 && p(k, "flammable") >= 0.7;
export const moistureOf = (s?: { m?: number }) => s?.m ?? 0;

// Simard's equilibrium water of dead wood and plant matter in air this damp (0 to 1) and warm (C), kg to the kg (R30).
export function emc(rh: number, temp: number) {
  const RH = Math.max(0, Math.min(100, rh * 100)), T = temp * 1.8 + 32;
  const pct = RH < 10 ? 0.03229 + 0.281073 * RH - 0.000578 * T * RH : RH < 50 ? 2.22749 + 0.160107 * RH - 0.014784 * T : 21.0606 + 0.005565 * RH * RH - 0.00035 * RH * T - 0.483199 * RH;
  return Math.max(0, pct / 100);
}
// The share of the sun's beam each sky lets through, as the NFDRS has the cloud of its states of weather (sec. 11).
const COVER: Record<World["weather"]["sky"], number> = { clear: 0.05, cloudy: 0.7, rain: 0.95, storm: 0.95 };
// The sun on something lying in the open at tick t under a sky, W/m2: the clear-sky beam at the sun's height (sec. 11).
export function sunOn(t: number, sky: World["weather"]["sky"]) {
  const el = sunAt(Math.floor(t / DAY) + 1, hourOf(t)).el;
  return el > 0 ? 1381.6 * 0.745 ** (1 / Math.sin(el)) * Math.sin(el) * (1 - COVER[sky]) : 0;
}
// The equilibrium water of something heated above the air (C) by what shines on it (W/m2), the less the harder the wind
// at it blows (m/s), in air holding this much water (kPa): Byram and Jemison's (sec. 11).
export function equilibrium(temp: number, vapour: number, shine = 0, wind = 0) {
  const own = temp + shine / (32.7 + 42.2 * wind);
  return emc(humidity(vapour, own), own);
}
// Against the body, in clothes or a bag, the air is the body's: 32 C and half a kPa damper than outside (sec. 18).
const body = (vapour: number) => equilibrium(32, vapour + 0.5);
// The wind at the tops of short grass against the wind at head height (sec. 14): what reaches dead stuff on the ground.
const GROUND = Math.log(0.36 / 0.13) / Math.log((2 - 0.064) / 0.013);
// A fire's radiant flux on something near it, kW/m2 (sec. 18): the radiant share of what its bed gives off, flaming and
// glowing, from a point at the distance (combustion.ts, in the air where the fire stands, ringed and heaped over as it is).
const CHI_R = 0.3;
function fireFlux(w: World, at: { px: number; py: number }) {
  const f = nearestThing(w, at.px, at.py, ["fire"], (t) => !!t.bed, 3);
  if (!f?.bed) return 0;
  const air = airAt(w, f.px, f.py), o = output(f.bed, setUp(f, { temp: air.temp, wind: air.wind, rain: rainAt(w, f.px, f.py), veg: 0.1 }, w.t));
  return (CHI_R * (o.flaming + o.glowing)) / (4 * Math.PI * Math.max(0.5, meters(at, f)) ** 2);
}

// How long something takes to come 63% of the way to new surroundings, hours (sec. 5, 20, 27f): as the square of its
// thickness from the 10-hour stick; green wood above fibre saturation slower, as its thickness to the 1.5; herbaceous
// stuff, behind its waxy skin, as slowly as R34's weathered fine fuel, though rain soaks it as fast as it soaks wood as thin.
const tau = (d: number) => 10 * (d / 0.0127) ** 2;
const tauGreen = (d: number) => 500 * (d / 0.025) ** 1.5;
const TAU_HERB = 2.2;
// An hour on for something (x) holding m: in rain on it (mm an hour) soaking toward all it holds, no faster than the rain
// on its face brings water; otherwise drawing toward the equilibrium of the air at its own warmth (eq), and drying
// besides by the water a fire's flux on it (kW/m2) boils off at 2.6 MJ/kg (sec. 5). green: wood still green.
function hour(m: number, x: Phys, rain: number, eq: number, fire: number, green: boolean) {
  const face = 4 / (Math.PI * x.rho * x.d); // m2 it turns to the rain or a fire, for each kg of it
  if (rain > 0) return Math.min(x.mmax + (m - x.mmax) * Math.exp(-1 / tau(x.d)), m + rain * face);
  const to = Math.min(x.mmax, eq), t = x.herb ? TAU_HERB : green && m > FSP ? tauGreen(x.d) : tau(x.d);
  return Math.max(Math.min(to, m), to + (m - to) * Math.exp(-1 / t) - (fire * face * 3600) / 2600);
}
// An hour on for one thing held, lying or laid.
function soak(w: World, s: Stack, rain: number, eq: number, fire: number) {
  const x = stackPhys(w.kinds, s);
  if (!x) return;
  const m = hour(moistureOf(s), x, rain, eq, fire, !!s.green);
  if (m > 0.0005) s.m = m; else delete s.m;
  if (s.green && m <= FSP) delete s.green;
}

// ---------- the island's dead stuff ----------
// The thicknesses the island's dead stuff is reckoned at: a blade of grass (the NFDRS herbaceous class), and the bounds of
// the 1-, 10-, 100- and 1000-hour classes of dead wood (sec. 5, 22e).
export const REF = [0.00061, 0.00635, 0.0254, 0.0762, 0.2032];
const REF_PHYS = REF.map((d, i) => ({ ...(i ? PHYS.stick : PHYS.fiber), d }));
type Dead = NonNullable<World["weather"]["dead"]>;
// The island's dead stuff an hour on from tick t under a sky, a wind over the open sea and a warmth: in the open, under
// the sun and in the wind at the grass tops (open ground takes 0.6 of the sea's wind), and in the shade; the rain on both
// alike. With none yet, it starts as the shade would leave it.
export function deadHour(w: World, dead: Dead | undefined, t: number, sky: World["weather"]["sky"], speed: number, temp: number): Dead {
  const { vapour, rain } = islandAir(w, t, sky), shade = equilibrium(temp, vapour), open = equilibrium(temp, vapour, sunOn(t, sky), speed * 0.6 * GROUND);
  const from = dead ?? { open: REF.map(() => shade), shade: REF.map(() => shade) };
  const on = (ms: number[], eq: number) => ms.map((m, i) => hour(m, REF_PHYS[i], rain, eq, 0, false));
  return { open: on(from.open, open), shade: on(from.shade, shade) };
}
// The water in dead stuff d thick lying at a point now, as the island's weather has left it: in the open, or in the
// shade as deep as the canopy over it, read between the two thicknesses reckoned either side of it by their logs.
export function deadAt(w: World, at: { px: number; py: number }, d: number) {
  const wx = w.weather, dead = wx.dead ?? deadHour(w, undefined, w.t, wx.sky, wx.speed, wx.temp), c = canopyAt(w, at.px, at.py);
  const l = Math.log(Math.min(Math.max(d, REF[0]), REF[REF.length - 1]));
  let i = 0;
  while (i < REF.length - 2 && l > Math.log(REF[i + 1])) i++;
  const f = (l - Math.log(REF[i])) / (Math.log(REF[i + 1]) - Math.log(REF[i])), of = (ms: number[]) => ms[i] * (1 - f) + ms[i + 1] * f;
  return of(dead.open) * (1 - c) + of(dead.shade) * c;
}

// ---------- the island's grass and leaves ----------
// Living plants come green as the growing season index of the NFDRS's 2024 rule climbs (sec. 12, R72): each day's product
// of four ramps, its coldest air from -2 C to 5 C, its driest from a vapour pressure deficit of 4100 Pa down to 900, its
// daylight from 10 h to 11 h, and the rain of the window before it from none to 10 mm, averaged over the window, 28 real
// days being 3.1 of the sim's (sec. 12). The island keeps it hourly from its own weather, as it keeps its dead stuff; the
// average is a running one over the window, and the rain a running sum over it (sec. 30a).
const WINDOW = (28 * YEAR_DAYS) / 365.25; // days
const ramp = (v: number, lo: number, hi: number) => Math.max(0, Math.min(1, (v - lo) / (hi - lo)));
type Grow = NonNullable<World["weather"]["gsi"]>;
const dayOf = (g: Grow) => ramp(g.tmin, -2, 5) * (1 - ramp(g.vpd, 900, 4100)) * ramp(daylight(g.day + 1), 10, 11) * ramp(g.rain, 0, 10);
// The island's growing season an hour on from tick t under a sky and a warmth. With none yet, it starts from this hour as
// though the day had been like it, with the window's rain full, as the island's rain fills it in any season (sec. 12).
export function gsiHour(w: World, g: Grow | undefined, t: number, sky: World["weather"]["sky"], temp: number): Grow {
  const { vapour, rain } = islandAir(w, t, sky), day = Math.floor(t / DAY), vpd = Math.max(0, esat(temp) - vapour) * 1000;
  if (!g) { const first = { day, tmin: temp, vpd, rain: 10, index: 0 }; return { ...first, index: dayOf(first) }; }
  const kept = g.rain * Math.exp(-1 / (WINDOW * 24)) + rain;
  if (day === g.day) return { ...g, tmin: Math.min(g.tmin, temp), vpd: Math.max(g.vpd, vpd), rain: kept };
  return { day, tmin: temp, vpd, rain: kept, index: g.index + (dayOf(g) - g.index) / WINDOW };
}
// How green the island's living plants are now (sec. 12, R72): the growing season index; the water in living grass,
// 30% until the index passes the green-up threshold of 0.2, then rising to 250% at 1, and the share of it cured, at
// dead-fuel water, by the 1978 transfer, 1.33 - 0.0111 for each percent of it; and the water in living leaves and twigs of
// trees and shrubs, 60% rising to 200% the same way. The index is not divided by the island's highest, which a world
// just made has no record of (sec. 30a).
export function growing(w: World) {
  const wx = w.weather, index = (wx.gsi ?? gsiHour(w, undefined, w.t, wx.sky, wx.temp)).index, up = ramp(index, 0.2, 1);
  const herb = 0.3 + 2.2 * up;
  return { index, herb, cured: Math.max(0, Math.min(1, 1.33 - 1.11 * herb)), woody: 0.6 + 1.4 * up };
}
// The grass at a point: its living blades' water, the share of them cured, and the cured blades' water, as dead stuff a
// blade thick lies there.
export function grassAt(w: World, at: { px: number; py: number }) {
  const { herb, cured } = growing(w);
  return { herb, cured, dead: deadAt(w, at, REF[0]) };
}

// ---------- every hour ----------
export function wetness(w: World) {
  if (w.t % 12) return;
  const wx = w.weather;
  wx.dead = deadHour(w, wx.dead, w.t, wx.sky, wx.speed, wx.temp);
  wx.gsi = gsiHour(w, wx.gsi, w.t, wx.sky, wx.temp);
  for (const a of w.agents) carried(w, a);
  for (const t of liveThings(w)) {
    if (t.kind === "item") laid(w, t, true);
    else if (t.kind === "structure") { if (t.pieces) laid(w, t, false); if (t.store) stored(w, t); }
  }
}
// What someone holds and wears, and their skin. Rain reaches what they hold but in a bag or under a roof; held against
// the body, in clothes or a bag, it sits in the body's own air, and otherwise in the air about them, with the sun on it
// in the open and a fire's warmth by one.
function carried(w: World, a: Agent) {
  const roof = sheltered(w, a), bag = a.inv.some((s) => p(w.kinds[s.k], "container") >= 0.6), air = airOn(w, a, roof);
  const vapour = vapourAt(w, a.px, a.py, w.t), rain = roof ? 0 : rainAt(w, a.px, a.py), fire = fireFlux(w, a);
  const open = equilibrium(air.temp, vapour, (roof ? 0 : sunOn(w.t, w.weather.sky) * (1 - canopyAt(w, a.px, a.py))) + fire * 1000, air.wind);
  const against = !!a.wearing || bag;
  for (const s of a.inv) soak(w, s, bag ? 0 : rain, against ? body(vapour) : open, against ? 0 : fire);
  if (a.wearing) soak(w, a.wearing, rain, open, fire);
  // bare skin is soaked and dried as a thin piece a millimeter deep would be (sec. 27f)
  const k = Math.exp(-1 / tau(0.001)), skin = rain ? 1 - (1 - (a.skin ?? 0)) * k : (a.skin ?? 0) * k;
  if (!a.wearing && skin > 0.005) a.skin = skin; else delete a.skin;
}
// A pile lying on the ground (pile: in standing water, if that's where it lies), or a shelter's pieces of wood, out in
// the rain and the sun, and the wind at the ground.
function laid(w: World, t: Thing, pile: boolean) {
  const roof = pile && sheltered(w, t), air = airAt(w, t.px, t.py, roof), vapour = vapourAt(w, t.px, t.py, w.t), fire = fireFlux(w, t);
  const rain = pile && wetAt(w, t.px, t.py) ? Infinity : roof ? 0 : rainAt(w, t.px, t.py);
  const eq = equilibrium(air.temp, vapour, (roof ? 0 : sunOn(w.t, w.weather.sky) * (1 - canopyAt(w, t.px, t.py))) + fire * 1000, air.wind * GROUND);
  if (pile && t.item && (t.n ?? 1) > (t.pieces?.length ?? 0)) {
    const x = stackPhys(w.kinds, { k: t.item });
    if (x) t.m = hour(t.m ?? 0, x, rain, eq, fire, false);
  }
  for (const s of t.pieces ?? []) soak(w, s, rain, eq, fire);
}
// What's put away inside a home: out of the rain and the sun, in the air of the place.
function stored(w: World, t: Thing) {
  const air = airAt(w, t.px, t.py, true), eq = equilibrium(air.temp, vapourAt(w, t.px, t.py, w.t));
  for (const s of t.store!) soak(w, s, 0, eq, 0);
}

// What lies about to light a fire with, if they hold no tinder: grass or fern at their feet that snow hasn't buried, or
// the dead twigs of a bush, which stand above it.
const GROUND_TINDER: Record<string, string> = { grass: "grass at their feet", fern: "fern at their feet", dead_bush: "dead twigs of a bush" };
// The tinder they'd light a fire with and the water in it: what they hold of a kind (k, for a spark struck over it), or
// any tinder they hold, or failing that what lies about within arm's reach, dead blades or twigs as the island's weather
// has left them; null if there's none.
export function tinderOf(w: World, a: Agent, k?: string): { kind?: Kind; name: string; m: number } | null {
  const s = a.inv.find((x) => (k ? x.k === k : tinder(w.kinds[x.k])));
  if (s) return { kind: w.kinds[s.k], name: w.kinds[s.k]?.name ?? s.k, m: moistureOf(s) };
  if (k) return null;
  const buried = snowAt(w, a.px, a.py) > 0.5;
  const t = nearestThing(w, a.px, a.py, buried ? ["dead_bush"] : Object.keys(GROUND_TINDER), () => true, 2);
  return t ? { name: GROUND_TINDER[t.kind], m: deadAt(w, a, t.kind === "dead_bush" ? REF[1] : REF[0]) } : null;
}
