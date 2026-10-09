// Light is an attribute of every point of the island, as moisture is: how much of it reaches the ground there now. It is
// the sky's (the sun's beam and glow, the moon and the stars, less cloud), less what stands in the way (hills hide the sun's
// beam, the crowns of trees hide all of the sky), plus what fires, burning things and flames carried throw. Nothing here is
// stored; any point is worked out from the world as it stands, so felling a wood or lighting a fire changes it at once.
//
// People and animals answer to how bright a place looks, which is the log of its lux: they see less far, walk and work
// slower, sleep better and keep to a fire when it is dark. The rates below are those answers.
import { DAY, TILE_M, groundOf, hourOf, meters, perWorld, type Thing, type World } from "./world";
import { SIZE, clamp, smooth } from "../terrain/flora";
import { around, liveThings, lookAround } from "./space";
import { ablaze, carriedOutput, fireOutput, isFlame } from "./physics";
import { COVER, STAR_LUX, beam, moonAt, moonLux, sunAt, sunLux, through } from "./sky";

// ---------- crowns ----------
// A crown's radius as a share of its tree's height, by species: the width sprites.js draws it at (oak 0.8 of its height, ash
// 0.68, the rest 0.5, a pine's cone 0.42) over its height's 0.866 of a meter across, halved. The renderer's ambient
// occlusion (demo/styles/isopixel/canopy.js) shades the same crowns the same way: change one, change both.
const SHARE: Record<string, number> = { oak: 0.35, ash: 0.29, pine: 0.18 };
// A crown hides all of the sky within CORE of its radius and none past EDGE, easing out between.
const CORE = 0.55, EDGE = 1.2;
const REACH = 12; // meters: no crown, of the tallest tree, reaches further from its trunk
// How much of the sky the trees overhead hide, in crowns: 1 under one, more where they overlap. Seedlings and the air
// under the trees ask it of the same points tick after tick, so each point's answer is kept until anything round it
// comes, goes or changes (space.ts lookAround); the points are let go of when they pile up past a few thousand.
const canopies = perWorld(() => new Map<number, Map<number, { at: number; cover: number }>>());
export function canopyAt(w: World, px: number, py: number) {
  const at = lookAround(w, px, py, REACH), xs = canopies(w);
  let ys = xs.get(px);
  const kept = ys?.get(py);
  if (kept?.at === at) return kept.cover;
  let cover = 0;
  around(w, px, py, REACH, ["tree"], (t, d) => {
    const r = (SHARE[t.species ?? ""] ?? 0.22) * t.size;
    if (d <= r * EDGE) cover += d <= r * CORE ? 1 : 1 - smooth(CORE, EDGE, d / r);
  });
  if (!ys) {
    if (xs.size >= 4096) xs.clear();
    xs.set(px, (ys = new Map()));
  }
  ys.set(py, { at, cover });
  return cover;
}
// Leaves let a little through: under one crown an eighth of the sky's glow and a twenty-sixth of the sun's beam, which crosses
// more of them; where two overlap, a sixty-fourth of the glow, and no more is lost past that.
const LEAVES = 2.6;
const sieve = (cover: number) => LEAVES * Math.min(cover, 2);
// How well a plant grows in the light it gets at a point, whatever the hour: a quarter as well under the deepest canopy as in
// the open. Seedlings and berry bushes answer to it.
export const growRate = (w: World, px: number, py: number) => 0.25 + 0.75 * skyShare(w, px, py);
// The share of the sky's light that reaches the ground through the crowns over a point.
export const skyShare = (w: World, px: number, py: number) => Math.exp(-0.8 * sieve(canopyAt(w, px, py)));

// ---------- the sky now ----------
type Sky = { t: number; sky: string; el: number; tan: number; dir: [number, number]; day: number; beam: number; night: number };
const skies = new WeakMap<World, Sky>();
function skyNow(w: World): Sky {
  const old = skies.get(w);
  if (old && old.t === w.t && old.sky === w.weather.sky) return old;
  const hour = hourOf(w.t), day = Math.floor(w.t / DAY) + 1, sun = sunAt(day, hour), moon = moonAt(day, hour);
  const cover = COVER[w.weather.sky], open = through(cover);
  // day: the sun's beam and the sky's glow on open ground; night: the moon's and the stars'
  const s: Sky = { t: w.t, sky: w.weather.sky, el: sun.el, tan: sun.tan, dir: sun.dir, day: sunLux(sun.el) * open, beam: beam(sun.el, cover), night: (moonLux(moon) + STAR_LUX) * (0.3 + 0.7 * open) };
  skies.set(w, s);
  return s;
}

// The steepest the ground climbs toward a direction from a point 1.7 m up: the tangent of the angle to the skyline.
function skyline(height: (x: number, z: number) => number, x: number, z: number, dx: number, dz: number) {
  const h0 = height(x, z) + 1.7;
  let top = -Infinity;
  for (let d = 15; d <= 2400; d *= 1.25) top = Math.max(top, (height(x + dx * d, z + dz * d) - h0) / d);
  return top;
}
// The share of the sun's beam that clears the land, easing over about a degree either side of the skyline.
function beamClears(w: World, px: number, py: number, s: Sky) {
  const { fine } = groundOf(w.seed), x = px * TILE_M - SIZE / 2, z = py * TILE_M - SIZE / 2;
  return smooth(-0.012, 0.012, s.tan - skyline(fine.heightAt, x, z, s.dir[0], s.dir[1]));
}

// ---------- fires and flames carried ----------
// What every fire, everything alight and every flame someone carries throws round it, from what it gives off now
// (physics.ts fireOutput and carriedOutput; fire-constants sec. 31): light, its flames' at FLAME_LM lumens a watt (sec. 9)
// and its coals' at a glowing body's efficacy at their heat, the same every way; and radiant heat, a share CHI_R of all it
// gives off (sec. 7). Both fall off as from a disc of the fire's own heap seen on its axis, I / (d^2 + r^2): the point
// source's inverse square a few fire-widths off, and finite at the fire. A flame carried is held HELD m from what its
// holder sees and works by (R122's lamp). A cover of stone over a fire hides it, its light and its heat alike.
const FLAME_LM = 0.16, CHI_R = 0.3, HELD = 0.4;
// cd and radiant kW of a source, and its r^2, m2
type Source = { px: number; py: number; cd: number; kw: number; r2: number; thing?: Thing };
const sources = new WeakMap<World, { t: number; list: Source[] }>();
// A glowing body's luminous efficacy at T K, lm/W: Planck's spectral emittance seen through the eye's photopic curve (CIE
// 1924, in its Gaussian fit), 380 to 780 nm, over all it radiates (sec. 31).
const C1 = 3.7418e-16, C2 = 0.014388, SIGMA = 5.670374e-8; // W m2, m K, W/m2K4
function efficacy(T: number) {
  if (T <= 0) return 0;
  let lm = 0;
  for (let nm = 380; nm <= 780; nm += 10) lm += 1.019 * Math.exp(-285.4 * (nm / 1000 - 0.559) ** 2) * (C1 / (nm * 1e-9) ** 5 / Math.expm1(C2 / (nm * 1e-9 * T))) * 1e-8;
  return (683 * lm) / (SIGMA * T ** 4);
}
function glowing(w: World) {
  const old = sources.get(w);
  if (old && old.t === w.t) return old.list;
  const list: Source[] = [];
  for (const t of liveThings(w)) {
    if (t.covered || !ablaze(t)) continue;
    const o = fireOutput(w, t);
    list.push({ px: t.px, py: t.py, cd: ((FLAME_LM * o.flaming + efficacy(o.hot) * o.glowing) * 1000) / (4 * Math.PI), kw: CHI_R * (o.flaming + o.glowing), r2: o.radius ** 2, thing: t });
  }
  // flames carried: their own flames' light only, a brand's coals being too dim to count
  for (const a of w.agents)
    for (const s of a.inv) {
      if (!isFlame(w.kinds[s.k])) continue;
      const o = carriedOutput(w, a, s);
      if (o.flaming + o.glowing > 0) list.push({ px: a.px, py: a.py, cd: (FLAME_LM * o.flaming * 1000) / (4 * Math.PI), kw: CHI_R * (o.flaming + o.glowing), r2: HELD ** 2 });
    }
  sources.set(w, { t: w.t, list });
  return list;
}
// The radiant heat fires throw on a point now, kW/m2, and the fire or burning thing throwing the most of it.
export function heatAt(w: World, px: number, py: number) {
  let q = 0, most = 0, from: Thing | null = null;
  for (const f of glowing(w)) {
    const d = Math.hypot(f.px - px, f.py - py) * TILE_M, h = f.kw / (4 * Math.PI * (d * d + f.r2));
    q += h;
    if (f.thing && h > most) { most = h; from = f.thing; }
  }
  return { q, from };
}

// ---------- light at a point ----------
export type Light = {
  lux: number;
  bright: number; // 0 to 1: how bright it looks, the log of lux: a hundredth of a lux is black, ten thousand is full day
  sky: number; // lux on open ground, clear of trees and hills
  canopy: number; // share of the sky the trees overhead hide
  sun: number; // share of the sun's beam that clears the land; 0 whenever there is no beam
  fire: number; // lux from fires, burning things and flames carried
};
export function lightAt(w: World, px: number, py: number): Light {
  const s = skyNow(w), cover = canopyAt(w, px, py), tau = sieve(cover);
  const glow = Math.exp(-0.8 * tau), shaft = Math.exp(-tau / Math.max(0.2, Math.sin(s.el)));
  const clear = s.beam > 0 ? beamClears(w, px, py, s) : 0;
  let fire = 0;
  for (const f of glowing(w)) {
    const d = Math.hypot(f.px - px, f.py - py) * TILE_M;
    fire += f.cd / (d * d + f.r2);
  }
  const lux = s.day * (s.beam * clear * shaft + (1 - s.beam) * glow) + s.night * glow + fire;
  return { lux, bright: clamp((Math.log10(Math.max(lux, 1e-6)) + 2) / 6, 0, 1), sky: s.day + s.night, canopy: 1 - glow, sun: clear, fire };
}

// Where an entity stands, worked out once a tick however many questions ask.
const memo = new WeakMap<object, { t: number; px: number; py: number; light: Light }>();
export function lightOn(w: World, e: { px: number; py: number }): Light {
  const m = memo.get(e);
  if (m && m.t === w.t && m.px === e.px && m.py === e.py) return m.light;
  const light = lightAt(w, e.px, e.py);
  memo.set(e, { t: w.t, px: e.px, py: e.py, light });
  return light;
}

// ---------- what it does to people ----------
// Below this it is dark: nobody sets out to forage, explore or hunt, and a wolf takes a lone person for prey.
export const DARK = 0.3;
// Work goes at this share of its pace, and walking at this share of its speed.
export const workRate = (b: number) => clamp(0.15 + 1.1 * b, 0.2, 1);
export const moveRate = (b: number) => clamp(0.55 + 0.7 * b, 0.55, 1);
// Rest is full in the dark and slows to a little over half in bright light.
export const restRate = (b: number) => 0.55 + 0.45 * (1 - clamp((b - 0.25) / 0.55, 0, 1));

// Whether one can make out another within `range` meters, the distance in full light. Someone is seen by how bright it is
// where they stand, down to a tenth of the range in the dark, and 0.7 as far by a viewer standing in a glare much brighter
// than the other's surroundings.
export function canSee(w: World, from: { px: number; py: number }, target: { px: number; py: number }, range: number) {
  const d = meters(from, target);
  if (d > range) return false;
  const b = lightOn(w, target).bright;
  return d <= range * clamp((b - 0.05) / 0.6, 0.1, 1) * (lightOn(w, from).bright - b > 0.2 ? 0.7 : 1);
}

// What it is like, in a few words for whoever reads the inspector or answers for a person.
export function lightWords(l: Light) {
  const b = l.bright;
  const how = b >= 0.8 ? "bright daylight" : b >= 0.6 ? "daylight" : b >= 0.45 ? "dim" : b >= DARK ? "dusk" : b >= 0.15 ? "dark" : "pitch black";
  const why = l.fire > l.lux * 0.5 ? ", by firelight" : l.canopy > 0.5 && l.sky > 100 ? ", under thick leaves" : l.sun === 0 && l.sky > 1000 ? ", in shade" : "";
  return how + why;
}
