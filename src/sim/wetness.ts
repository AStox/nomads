// How wet everything is. Every material thing holds water, kg of it to each kg of the dry stuff (fuel.ts), and draws
// toward what its surroundings would leave in it, the faster the thinner it is: toward all it can hold in rain or
// standing water, and otherwise toward the equilibrium of the air at its own warmth, which the sun on it, a fire by it or
// the body it's carried against raises (docs/research/fire-constants.md sections 5, 10, 11, 18, 20, 27f and 35). The rain
// on anything is what reaches the ground where it is, through the trees and past the rocks (rain.ts), less what a roof's
// cover keeps off along the rain's slant (rainUnder); bags keep it off altogether. Everything lying out on the island
// (logs, snags, sticks, litter and cured grass, and dead stuff standing) holds its own water on the GPU, stepped every
// hour in the air, rain and shade where it lies (gpu/moisture.ts), and the CPU reads it there (deadOf). What people hold,
// wear, lay or build holds its own here. What
// it comes to decides whether a spark or an ember catches in tinder (physics.ts), and how cold the wet-through feel
// (sim.ts needs).
import { GREEN_UP } from "../terrain/growth";
import { DAY, TILE_M, YEAR_DAYS, groundOf, wetAt, type Agent, type Dead, type Stack, type Thing, type Weather, type World } from "./world";
import { anyAround, around, deadwoodOf, liveThings, moistOf as gpuMoisture, nearestThing } from "./space";
import { airAt, airOn, headWind, humidity, islandAir, islandMeans, islandPooled, shelterTables, snowAt, sunOn, vapourAt, wetHours } from "./air";
import { canopyAt, heatAt } from "./light";
import { crownKind, crownsHour, drift, fallSpeed, rainOn, through } from "./rain";
import { WIDEST, within } from "./shelter";
import { topKr } from "./soil";
import { daylight, seasonAt } from "./sky";
import { p, type Kind } from "./materials";
import { stackPhys, type Phys } from "./fuel";
import { DIRS, POOL_C, SEASONS, SEASON_DAYS, esat } from "../terrain/climate";
import { CELL, N } from "../terrain/grid";
import { TREES } from "../terrain/niche";
import {
  CELL_WORDS, CLASSES, FSP, GROUND, HEART, SKIN, TAU_HERB, cellAir, envQ, fromW, tau, tauGreen, texelHour, toW,
  type Hour, type MoistureDriver, type Shelter,
} from "../gpu/moisture";

// A struck spark catches in tinder this wet or drier, an ember blown into it in tinder this wet or drier (sec. 10).
export const DAMP = 0.1, SOAKED = 0.13;
export const raining = (w: World) => w.weather.sky === "rain" || w.weather.sky === "storm";
// Under a roof: the shelter whose floor they stand on (shelter.ts), none out in the open.
export function sheltered(w: World, a: { px: number; py: number }) {
  return anyAround(w, a.px, a.py, WIDEST, ["structure"], (t) => !!t.shelter?.tier && Math.hypot(a.px - t.px, a.py - t.py) * TILE_M <= t.shelter.r);
}
// The rain reaching a point under the roofs round it, mm an hour: what reaches the ground there (rain.ts), less what a
// roof's cover keeps off wherever a drop's slanting path back up into the wind (rain.ts drift) passes through a roof or
// its walls. A roof lets through the share of it its cover leaves open.
export function rainUnder(w: World, a: { px: number; py: number }) {
  const rain = rainOn(w, a.px, a.py);
  if (rain <= 0) return 0;
  const wx = w.weather, head = headWind(w, a.px, a.py, wx.wind, wx.speed), v = fallSpeed(rain);
  const len = Math.hypot(wx.wind.dx, wx.wind.dy) || 1, ux = wx.wind.dx / len, uy = wx.wind.dy / len;
  let share = 1;
  around(w, a.px, a.py, WIDEST + drift(2 * WIDEST, head, v), ["structure"], (t) => {
    const sh = t.shelter;
    if (!sh?.tier) return;
    const x = (a.px - t.px) * TILE_M, y = (a.py - t.py) * TILE_M;
    for (let i = 0; i <= 8; i++) {
      const z = (sh.top * i) / 8, s = drift(z, head, v);
      if (within(sh, x - ux * s, y - uy * s, z)) { share *= 1 - sh.closed; return; }
    }
  });
  return rain * share;
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
// The equilibrium water of something heated above the air (C) by what shines on it (W/m2), the less the harder the wind
// at it blows (m/s), in air holding this much water (kPa): Byram and Jemison's (sec. 11).
export function equilibrium(temp: number, vapour: number, shine = 0, wind = 0) {
  const own = temp + shine / (32.7 + 42.2 * wind);
  return emc(humidity(vapour, own), own);
}
// Against the body, in clothes or a bag, the air is the body's: 32 C and half a kPa damper than outside (sec. 18).
const body = (vapour: number) => equilibrium(32, vapour + 0.5);
// What fires throw on something near them, kW/m2: the radiant heat light.ts heatAt has them throw on anyone (sec. 31).
const fireFlux = (w: World, at: { px: number; py: number }) => heatAt(w, at.px, at.py).q;

// How long something takes to come 63% of the way to new surroundings (gpu/moisture.ts tau, tauGreen, TAU_HERB).
// A piece's water lies in two halves of it: its skin, the outer half (a round piece beyond 0.707 of its radius), and its
// heart, the inner half. Water passes between the skin and the air across the skin's half-thickness, and between skin
// and heart between their middles, both by diffusion, so the skin answers in 0.211 of the piece's time and the heart
// takes 0.782 of it to answer the skin, and the piece as a whole still comes 63% of the way to new surroundings in 1.05 of
// its time [derived: the first mode of diffusion in a cylinder, sec. 27g].
// (gpu/moisture.ts SKIN and HEART.)
export type Water = { m: number; skin: number };
export const waterOf = (s?: { m?: number; skin?: number }): Water => ({ m: s?.m ?? 0, skin: s?.skin ?? s?.m ?? 0 });
// The two halves an hour on toward water `to` for a piece whose time is t hours: the pair's linear exchange, solved exactly.
function toward(x: Water, to: number, t: number): Water {
  const a = 1 / (SKIN * t), b = 1 / (HEART * t), s0 = x.skin - to, c0 = 2 * x.m - x.skin - to;
  const tr = -(a + 2 * b), disc = Math.sqrt(tr * tr - 4 * a * b), l1 = (tr + disc) / 2, l2 = (tr - disc) / 2;
  const e1 = Math.exp(l1), e2 = Math.exp(l2), f = (l1 * e2 - l2 * e1) / (l1 - l2), g = (e1 - e2) / (l1 - l2);
  const s = f * s0 + g * (-(a + b) * s0 + b * c0), c = f * c0 + g * (b * s0 - b * c0);
  return { m: to + (s + c) / 2, skin: to + s };
}
// An hour on for something (x) holding water: in rain on it (mm an hour) soaking toward all it holds, no faster than the
// rain on its face brings water; otherwise drawing toward the equilibrium of the air at its own warmth (eq), and drying
// besides by the water a fire's flux on it (kW/m2) boils off its skin at 2.6 MJ/kg (sec. 5). green: wood still green.
function hour(was: Water, x: Phys, rain: number, eq: number, fire: number, green: boolean): Water {
  const face = 4 / (Math.PI * x.rho * x.d); // m2 it turns to the rain or a fire, for each kg of it
  if (rain > 0) {
    const next = toward(was, x.mmax, tau(x.d)), gain = next.m - was.m, most = rain * face;
    if (gain <= most) return next;
    const k = most / gain;
    return { m: was.m + gain * k, skin: was.skin + (next.skin - was.skin) * k };
  }
  const to = Math.min(x.mmax, eq), next = toward(was, to, x.herb ? TAU_HERB : green && was.m > FSP ? tauGreen(x.d) : tau(x.d));
  const boil = (fire * face * 3600) / 2600, m = Math.max(Math.min(to, was.m), next.m - boil);
  return { m, skin: Math.min(2 * m, Math.max(Math.min(to, was.skin), next.skin - 2 * boil)) };
}
// An hour on for one thing held, lying or laid.
function soak(w: World, s: Stack, rain: number, eq: number, fire: number) {
  const x = stackPhys(w.kinds, s);
  if (!x) return;
  keep(s, hour(waterOf(s), x, rain, eq, fire, !!s.green));
  if (s.green && (s.m ?? 0) <= FSP) delete s.green;
}
// A piece split along its grain into n wedges: each holds the whole's water, and its new skin lies along its share of
// the old face, π/n of the round's width against the two cut faces' width, and along the cut faces, which run 0.707 of
// their length through the old heart and the rest through the old skin [derived: wedges of a round piece, the skin
// taken as its face's water].
export function splitWater(x: Water, n: number): Water {
  if (n <= 1) return x;
  const old = Math.PI / n / (Math.PI / n + 1), heart = 2 * x.m - x.skin;
  return { m: x.m, skin: Math.min(2 * x.m, old * x.skin + (1 - old) * (0.707 * heart + 0.293 * x.skin)) };
}
// Water set on a thing held or lying: none kept below half a gram a kilo, and its skin only where it differs.
function keep(s: { m?: number; skin?: number }, x: Water) {
  if (x.m > 0.0005) s.m = x.m; else delete s.m;
  if (Math.abs(x.skin - x.m) > 0.0005) s.skin = x.skin; else delete s.skin;
}
// What dead stuff lying on the ground draws toward: half its face against the air and half against the ground, where
// the air in the soil's top is as near saturated as the soil can still give it water, the share FAO-56's stage-2
// reduction leaves (soil.ts topKr of the top soil's wetness) [derived], at the air's warmth [design: half its face].
const lying = (air: number, temp: number, vapour: number, wet: number) => {
  const rh = humidity(vapour, temp);
  return (air + emc(rh + (1 - rh) * topKr(wet), temp)) / 2;
};

// ---------- the island's dead stuff ----------
// The thicknesses of the NFDRS's dead fuel classes: a blade of grass (the herbaceous class), and the bounds of the 1-,
// 10-, 100- and 1000-hour classes of dead wood (sec. 5, 22e).
export const REF = [0.00061, 0.00635, 0.0254, 0.0762, 0.2032];
const Q = (x: number) => Math.round(x * 65536);
// The island's hour as the GPU's water law reads it (gpu/moisture.ts Hour): the time of year, the island's air and
// pooled cold, a wet sky (1 rain, 5 a storm, 0 dry), the wind's speed over the open sea, its bearing and way, the island
// rain's fall speed, the sun on open ground, the top soil's stage-2 reduction, and the share of the rain a layer of
// pines' and of broadleaves' crowns lets through as the hour's rain begins on what they hold (rain.ts through).
export function islandHour(w: World, t: number, sky: Weather["sky"], speed: number, temp: number, wind: Weather["wind"], soil: number, held: number[], bare: boolean): Hour {
  const { s, f } = seasonAt(t), { rain } = islandAir(w, t, sky), len = Math.hypot(wind.dx, wind.dy) || 1;
  const a = Math.atan2(wind.dy, wind.dx), k = ((Math.round((a / (2 * Math.PI)) * DIRS) % DIRS) + DIRS) % DIRS;
  const share = (kind: number) => Math.min(65535, rain > 0 ? Q(through(kind, held[kind] ?? 0, rain, bare)) : 65535);
  return {
    hour: Math.floor(t / 12), s, f: Q(f), temp: Q(temp), pooled: Q(islandPooled(w, t, sky, speed)), wet: sky === "storm" ? 5 : sky === "rain" ? 1 : 0,
    speed: Q(speed), k, ux: Q(wind.dx / len), uy: Q(wind.dy / len), v: rain > 0 ? Q(fallSpeed(rain)) : 0, sun: Q(sunOn(t, sky)), kr: Q(topKr(soil)),
    tp: share(TREES.indexOf("pine")), tb: share(crownKind("oak")),
  };
}
// The island's own reference dead stuff of each class (gpu/moisture.ts CLASSES) an hour on: in the open, in the island's
// air (a cell of the land's season means, level, its ground leaving 0.6 of the sea's wind, as open ground does) and its
// sun; and in the shade, under a whole layer of broadleaves. The GPU's law stepped in that cell's air, so a piece lying
// in the open where the air is the island's holds exactly what the open reference does. With none yet, both start as
// their equilibrium would leave them.
let shelters: Shelter | null = null;
const shelter = () => (shelters ??= shelterTables());
export const OPEN_LEE = 60;
export function islandCell(w: World): { cells: Int32Array; lee: Uint8Array } {
  const { vapour, rain } = islandMeans(w), cells = new Int32Array(CELL_WORDS);
  for (let k = 0; k < 4; k++) { cells[4 + k] = Q(vapour[k]); cells[8 + k] = Q(rain[k]); }
  cells[15] = 1;
  return { cells, lee: new Uint8Array(DIRS).fill(OPEN_LEE) };
}
export function deadHour(w: World, dead: Dead | undefined, H: Hour): Dead {
  const isle = islandCell(w), air = cellAir(isle.cells, isle.lee, 0, H)!;
  const open = envQ(air, 0, 0, 0, H, shelter()), shade = envQ(air, 0, 65536, 0, H, shelter());
  const at = (ms: number[] | undefined, skins: number[] | undefined, e: typeof open) => {
    const from = CLASSES.map((c, i) => ({ m: toW(ms?.[i] ?? 0), skin: toW(skins?.[i] ?? ms?.[i] ?? 0) }));
    if (!ms) from.forEach((x, i) => { x.m = x.skin = CLASSES[i].lying ? e.lying : e.aloft; });
    return texelHour(from, e);
  };
  const o = at(dead?.open, dead?.skin?.open, open), s = at(dead?.shade, dead?.skin?.shade, shade);
  return { open: o.map((x) => fromW(x.m)), shade: s.map((x) => fromW(x.m)), skin: { open: o.map((x) => fromW(x.skin)), shade: s.map((x) => fromW(x.skin)) } };
}
// What the GPU's water law reads from the world (gpu/moisture.ts MoistureDriver): each cell's season fields at its
// middle (air.ts placeTemp, vapourAt, rainWhen, slopeAt, the generator's lee), and the island's reference now.
export function moistureDriver(w: World): MoistureDriver {
  return {
    cells() {
      const { isle } = groundOf(w.seed), n = Math.round(Math.sqrt(isle.height.length)), out = new Int32Array(N * N * CELL_WORDS);
      if (n !== N) throw new Error(`the island's fields are ${n} cells a side, not ${N}`);
      for (let c = 0; c < N * N; c++) {
        if (isle.height[c] <= 0) continue;
        const b = c * CELL_WORDS, x = c % N, y = Math.floor(c / N), pool = isle.pool[c];
        for (let k = 0; k < 4; k++) {
          const S = isle.seasons[k];
          out[b + k] = Q(S.temp[c] - SEASONS[k].t + POOL_C[k] * pool);
          out[b + 4 + k] = Q(S.humid[c] * esat(S.temp[c]));
          out[b + 8 + k] = Q(S.precip[c] / wetHours(w, k));
        }
        const h = (i: number, j: number) => isle.height[Math.min(N - 1, Math.max(0, j)) * N + Math.min(N - 1, Math.max(0, i))];
        out[b + 12] = Q(pool);
        out[b + 13] = Q((h(x + 1, y) - h(x - 1, y)) / (2 * CELL));
        out[b + 14] = Q((h(x, y + 1) - h(x, y - 1)) / (2 * CELL));
        out[b + 15] = 1;
      }
      return out;
    },
    lee: () => groundOf(w.seed).isle.lee,
    shelter,
    start() {
      const d = w.weather.dead;
      return CLASSES.map((c, i) => ({ m: toW(d?.open[i] ?? FSP / 2), skin: toW(d?.skin?.open[i] ?? d?.open[i] ?? FSP / 2) }));
    },
  };
}
// How dead stuff lies: on the ground (lying), or standing clear of it (a crown's dead twigs, crown its tree's kind; a dead
// bush's stems; what a shelter is built of).
export type Lie = { lying?: boolean; crown?: string };
// Each class's water at a point now: its texel's on the GPU, as the last landing brought it; until its cell has come
// back, the island's reference, as deep in the shade as the crowns over it.
function classesAt(w: World, at: { px: number; py: number }): Water[] {
  const held = gpuMoisture(w)?.texelAt(Math.max(0, at.px * TILE_M * 1000), Math.max(0, at.py * TILE_M * 1000), w.t);
  if (held) return CLASSES.map((_, i) => ({ m: fromW(held[2 * i]), skin: fromW(held[2 * i + 1]) }));
  const wx = w.weather, dead = wx.dead ?? { open: CLASSES.map(() => FSP / 2), shade: CLASSES.map(() => FSP / 2) }, c = Math.min(1, canopyAt(w, at.px, at.py));
  return CLASSES.map((_, i) => {
    const o = { m: dead.open[i], skin: dead.skin?.open[i] ?? dead.open[i] }, s = { m: dead.shade[i], skin: dead.skin?.shade[i] ?? dead.shade[i] };
    return { m: o.m * (1 - c) + s.m * c, skin: o.skin * (1 - c) + s.skin * c };
  });
}
// The water in dead stuff d thick at a point now, the whole and its skin: the classes lying as it lies, read between the
// two either side of it by their thicknesses' logs, and as the nearest past the thinnest or the thickest.
export function deadOf(w: World, at: { px: number; py: number }, d: number, lie: Lie = {}): Water {
  const ms = classesAt(w, at), lying = !!lie.lying && lie.crown === undefined;
  const idx = CLASSES.map((_, i) => i).filter((i) => CLASSES[i].lying === lying).sort((a, b) => CLASSES[a].d - CLASSES[b].d);
  const l = Math.log(d);
  if (l <= Math.log(CLASSES[idx[0]].d)) return ms[idx[0]];
  for (let j = 0; j + 1 < idx.length; j++) {
    const a = idx[j], b = idx[j + 1], la = Math.log(CLASSES[a].d), lb = Math.log(CLASSES[b].d);
    if (l > lb) continue;
    const f = (l - la) / (lb - la);
    return { m: ms[a].m * (1 - f) + ms[b].m * f, skin: ms[a].skin * (1 - f) + ms[b].skin * f };
  }
  return ms[idx[idx.length - 1]];
}
export function deadAt(w: World, at: { px: number; py: number }, d: number, lie: Lie = {}) { return deadOf(w, at, d, lie).m; }
// A piece lying out as its own object holds: a fallen log or snag its own (gpu/moisture.ts), as the last landing
// brought it, its thickness's dead stuff lying there until it has come back; a stick its texel's sticks'.
export function pieceWater(w: World, t: Thing, d: number): Water {
  const id = t.kind === "fallen_log" ? deadwoodOf(w)?.gpuId(t.id) : undefined, held = id === undefined ? undefined : gpuMoisture(w)?.logAt(id, w.t);
  return held ? { m: fromW(held.m), skin: fromW(held.skin) } : deadOf(w, t, d, { lying: true });
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
// A wet hour rains as a real one does (air.ts rainWhen), so each hour's rain counts for the real hours it stands for in
// the season, as the window's 3.1 days stand for 28 [derived].
const REAL_DAYS = SEASON_DAYS / (YEAR_DAYS / 4);
export function gsiHour(w: World, g: Grow | undefined, t: number, sky: World["weather"]["sky"], temp: number): Grow {
  const { vapour, rain } = islandAir(w, t, sky), day = Math.floor(t / DAY), vpd = Math.max(0, esat(temp) - vapour) * 1000;
  if (!g) { const first = { day, tmin: temp, vpd, rain: 10, index: 0 }; return { ...first, index: dayOf(first) }; }
  const kept = g.rain * Math.exp(-1 / (WINDOW * 24)) + rain * REAL_DAYS;
  if (day === g.day) return { ...g, tmin: Math.min(g.tmin, temp), vpd: Math.max(g.vpd, vpd), rain: kept };
  return { day, tmin: temp, vpd, rain: kept, index: g.index + (dayOf(g) - g.index) / WINDOW };
}
// How green the island's living plants are now (sec. 12, R72): the growing season index; the water in living grass,
// 30% until the index passes the green-up threshold of 0.2, then rising to 250% at 1, and the share of it cured, at
// dead-fuel water, by the 1978 transfer, 1.33 - 0.0111 for each percent of it; and the water in living leaves and twigs of
// trees and shrubs, 60% rising to 200% the same way. The index is not divided by the island's highest, which a world
// just made has no record of (sec. 30a).
export function growing(w: World) {
  const wx = w.weather, index = (wx.gsi ?? gsiHour(w, undefined, w.t, wx.sky, wx.temp)).index, up = ramp(index, GREEN_UP, 1);
  const herb = 0.3 + 2.2 * up;
  return { index, herb, cured: Math.max(0, Math.min(1, 1.33 - 1.11 * herb)), woody: 0.6 + 1.4 * up };
}
// Whether the broadleaves stand bare: until the growing season index passes green-up (sec. 30a).
export const leafless = (w: World) => growing(w).index < GREEN_UP;
// The grass at a point: its living blades' water, the share of them cured, and the cured blades' water, as dead stuff a
// blade thick lies there.
export function grassAt(w: World, at: { px: number; py: number }) {
  const { herb, cured } = growing(w);
  return { herb, cured, dead: deadAt(w, at, REF[0], { lying: true }) };
}

// ---------- every hour ----------
// The island's hour: its reference dead stuff, the water its crowns hold (rain.ts crownsHour: what they held as the
// hour's rain began, kept for the rain through them, and what they hold after it), and its growing season; the hour
// queued for the GPU's water law (gpu/moisture.ts), which steps everything lying out at the next tick's laws, and the
// cells round people asked of; then what people hold, lay and store.
export function wetness(w: World) {
  if (w.t % 12) return;
  const wx = w.weather, crowns = crownsHour(w, wx.past?.crowns, w.t, wx.sky, wx.speed, wx.temp);
  const H = islandHour(w, w.t, wx.sky, wx.speed, wx.temp, wx.wind, wx.wet, crowns.held, crowns.bare);
  wx.dead = deadHour(w, wx.dead, H);
  wx.past = { crowns: crowns.next, held: crowns.held, bare: crowns.bare };
  wx.gsi = gsiHour(w, wx.gsi, w.t, wx.sky, wx.temp);
  const gpu = gpuMoisture(w);
  gpu?.queue(H);
  gpu?.watch(w.agents, TILE_M * 1000, w.t);
  for (const a of w.agents) carried(w, a);
  for (const t of liveThings(w)) {
    if (t.kind === "item") laid(w, t, true);
    else if (t.kind === "structure") { if (t.pieces) laid(w, t, false); if (t.store) stored(w, t); }
  }
}
// What someone holds and wears, and their skin. The rain reaching the ground where they stand reaches what they hold but
// in a bag or under a roof; held against the body, in clothes or a bag, it sits in the body's own air, and otherwise in
// the air about them, with the sun the crowns let through on it and a fire's warmth by one.
function carried(w: World, a: Agent) {
  const roof = !!sheltered(w, a), bag = a.inv.some((s) => p(w.kinds[s.k], "container") >= 0.6), air = airOn(w, a, roof);
  const vapour = vapourAt(w, a.px, a.py, w.t), rain = rainUnder(w, a), fire = fireFlux(w, a);
  const open = equilibrium(air.temp, vapour, (roof ? 0 : sunOn(w.t, w.weather.sky) * (1 - Math.min(1, canopyAt(w, a.px, a.py)))) + fire * 1000, air.wind);
  const against = !!a.wearing || bag;
  for (const s of a.inv) soak(w, s, bag ? 0 : rain, against ? body(vapour) : open, against ? 0 : fire);
  if (a.wearing) soak(w, a.wearing, rain, open, fire);
  // bare skin is soaked and dried as a thin piece a millimeter deep would be (sec. 27f)
  const k = Math.exp(-1 / tau(0.001)), skin = rain ? 1 - (1 - (a.skin ?? 0)) * k : (a.skin ?? 0) * k;
  if (!a.wearing && skin > 0.005) a.skin = skin; else delete a.skin;
}
// A pile lying on the ground (pile: in standing water, if that's where it lies), or a shelter's pieces of wood, out in
// the rain reaching the ground there and the sun the crowns let through, and the wind at the ground; a pile takes the
// damp of the top soil under it as dead stuff lying there does, the island's top soil even under a roof [gap].
function laid(w: World, t: Thing, pile: boolean) {
  const roof = pile && !!sheltered(w, t), air = airAt(w, t.px, t.py, roof), vapour = vapourAt(w, t.px, t.py, w.t), fire = fireFlux(w, t);
  const rain = pile && wetAt(w, t.px, t.py) ? Infinity : pile ? rainUnder(w, t) : rainOn(w, t.px, t.py);
  const own = equilibrium(air.temp, vapour, (roof ? 0 : sunOn(w.t, w.weather.sky) * (1 - Math.min(1, canopyAt(w, t.px, t.py)))) + fire * 1000, air.wind * GROUND);
  const eq = pile ? lying(own, air.temp, vapour, w.weather.wet) : own;
  if (pile && t.item && (t.n ?? 1) > (t.pieces?.length ?? 0)) {
    const x = stackPhys(w.kinds, { k: t.item });
    if (x) keep(t, hour(waterOf(t), x, rain, eq, fire, false));
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
// any tinder they hold, or failing that what lies about within arm's reach, dead blades or twigs as the weather has left
// them where they are; null if there's none.
export function tinderOf(w: World, a: Agent, k?: string): { kind?: Kind; name: string; m: number } | null {
  const s = a.inv.find((x) => (k ? x.k === k : tinder(w.kinds[x.k])));
  if (s) return { kind: w.kinds[s.k], name: w.kinds[s.k]?.name ?? s.k, m: moistureOf(s) };
  if (k) return null;
  const buried = snowAt(w, a.px, a.py) > 0.5;
  const t = nearestThing(w, a.px, a.py, buried ? ["dead_bush"] : Object.keys(GROUND_TINDER), () => true, 2);
  return t ? { name: GROUND_TINDER[t.kind], m: t.kind === "dead_bush" ? deadAt(w, t, REF[1]) : deadAt(w, t, REF[0], { lying: true }) } : null;
}
