// Light is an attribute of every point of the island, as moisture is: how much of it reaches the ground there now. It is
// the sky's (the sun's beam and glow, the moon and the stars, less cloud), less what stands in the way (hills hide the sun's
// beam, the crowns of trees hide all of the sky), plus what fires, burning things and flames carried throw. The crowns are
// the island's crown raster (gpu/crowns.ts), made each day from the stems as the GPU holds them, so felling a wood
// changes the light under it after the next crown pass; the sky and fires are worked out as they stand now.
//
// People and animals answer to how bright a place looks, which is the log of its lux: they see less far, walk and work
// slower, sleep better and keep to a fire when it is dark. The rates below are those answers.
import { DAY, TILE_M, groundOf, hourOf, type Thing, type World } from "./world";
import { SIZE, clamp, crownShare, smooth } from "../terrain/flora";
import { crownsOf, liveThings } from "./space";
import { ablaze, carriedOutput, fireOutput, isFlame } from "./physics";
import { CLOUD, NIGHT_EL, SKYLIGHT, STAR_LUX, moonAt, moonLux, sunAt, sunLux } from "./sky";
import { UNDER_CROWN, through } from "../terrain/growth";

// ---------- crowns ----------
// A tree's crown holds the ground its share of a closed stand holds (terrain/flora.ts crownShare: Reineke's maximum
// density for pine and oak, Hemery et al.'s crown widths for ash and aspen), as a disc; a bush's crown a ball as wide as
// it is tall.
const TREE: Record<string, true> = { pine: true, oak: true, ash: true, aspen: true };
export const crownRadius = (t: { species?: string; size: number }) => (TREE[t.species ?? ""] ? Math.sqrt(crownShare(t.species!, t.size) / Math.PI) : t.size / 2);
// The trees' crowns over a point, from the crown raster (gpu/wgsl/crowns.ts): their cover in layers, the pines' and the
// broadleaves' (one layer is a texel's ground under crowns, more where they lie deeper), and over the point's cell the
// crowns' height, m, and how much of the space under it they fill, their crown ratio (a crown as deep as it is wide),
// read as a pine's where pines cover more and as an oak's otherwise at that height [design: the raster keeps no ratio].
// None before the world's crowns are on the GPU.
const MM = TILE_M * 1000;
export function crownsAt(w: World, px: number, py: number) {
  const c = crownsOf(w), x = Math.max(0, px * MM), y = Math.max(0, py * MM);
  if (!c) return { pine: 0, broad: 0, cover: 0, height: 0, ratio: 0 };
  const { pine, broad } = c.coverAt(x, y), height = c.heightAt(x, y), species = pine > broad ? "pine" : "oak";
  return { pine: pine / 65536, broad: broad / 65536, cover: (pine + broad) / 65536, height, ratio: height > 0 ? Math.min(1, (2 * crownRadius({ species, size: height })) / height) : 0 };
}
export const canopyAt = (w: World, px: number, py: number) => crownsAt(w, px, py).cover;
// Leaves let a little through (terrain/growth.ts through): under one layer of crowns a fiftieth of the sky's glow and
// less of the sun's beam, which crosses more of them (a 450th with the sun 53 degrees up), and as much again under each
// layer more. The share of the sky's light that reaches the ground through the crowns over a point.
export const skyShare = (w: World, px: number, py: number) => through(canopyAt(w, px, py));

// ---------- the sky now ----------
type Sky = { t: number; sky: string; el: number; tan: number; dir: [number, number]; day: number; beam: number; night: number };
const skies = new WeakMap<World, Sky>();
function skyNow(w: World): Sky {
  const old = skies.get(w);
  if (old && old.t === w.t && old.sky === w.weather.sky) return old;
  const hour = hourOf(w.t), day = Math.floor(w.t / DAY) + 1, sun = sunAt(day, hour), moon = moonAt(day, hour);
  // day: the sun's beam and the sky's glow on open ground, as much of a clear sky's as the cloud lets down, the beam only
  // where the cloud doesn't hide it; night: the moon's and the stars', through the same cloud
  const lit = SKYLIGHT[w.weather.sky], clear = sunLux(sun.el);
  const s: Sky = { t: w.t, sky: w.weather.sky, el: sun.el, tan: sun.tan, dir: sun.dir, day: clear.lux * lit, beam: lit > 0 ? Math.min(1, (clear.beam * (1 - CLOUD[w.weather.sky])) / lit) : 0, night: (moonLux(moon) + STAR_LUX) * lit };
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
  beam: number; // share of the sun's beam that reaches the point, past the land and through the crowns
  fire: number; // lux from fires, burning things and flames carried
};
export function lightAt(w: World, px: number, py: number): Light {
  // the beam crosses each layer slantwise, 1 / (0.8 sin el) as much leaf as the glow does on its way down (no less steep
  // than 0.2), so a layer lets the glow's share to that power of it through
  const s = skyNow(w), cover = canopyAt(w, px, py);
  const glow = through(cover), shaft = through(cover, UNDER_CROWN ** (1 / (0.8 * Math.max(0.2, Math.sin(s.el)))));
  const clear = s.beam > 0 ? beamClears(w, px, py, s) : 0;
  let fire = 0;
  for (const f of glowing(w)) {
    const d = Math.hypot(f.px - px, f.py - py) * TILE_M;
    fire += f.cd / (d * d + f.r2);
  }
  const lux = s.day * (s.beam * clear * shaft + (1 - s.beam) * glow) + s.night * glow + fire;
  return { lux, bright: brightOf(lux), sky: s.day + s.night, canopy: 1 - glow, sun: clear, beam: clear * shaft, fire };
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
// How bright lux looks, 0 to 1, on the log scale eyes meet light on: a hundredth of a lux black, ten thousand full day.
const brightOf = (lux: number) => clamp((Math.log10(Math.max(lux, 1e-6)) + 2) / 6, 0, 1);
// Below this it is dark: nobody sets out to forage, explore or hunt, and a wolf takes a lone person for prey. It is the
// light under a clear sky at the end of civil twilight, after which, as the US Naval Observatory has it, light other than
// the sky's is normally needed to carry on ordinary outdoor work (fire-constants sec. 33, R483): some 3 lux.
export const DARK = brightOf(sunLux(NIGHT_EL).lux);
// Work goes at this share of its pace (walking's pace is gait.ts's).
export const workRate = (b: number) => clamp(0.15 + 1.1 * b, 0.2, 1);
// Rest is full in the dark and slows to a little over half in bright light.
export const restRate = (b: number) => 0.55 + 0.45 * (1 - clamp((b - 0.25) / 0.55, 0, 1));

// What it is like, in a few words for whoever reads the inspector or answers for a person.
export function lightWords(l: Light) {
  const b = l.bright;
  const how = b >= 0.8 ? "bright daylight" : b >= 0.6 ? "daylight" : b >= 0.45 ? "dim" : b >= DARK ? "dusk" : b >= 0.15 ? "dark" : "pitch black";
  const why = l.fire > l.lux * 0.5 ? ", by firelight" : l.canopy > 0.5 && l.sky > 100 ? ", under thick leaves" : l.sun === 0 && l.sky > 1000 ? ", in shade" : "";
  return how + why;
}
