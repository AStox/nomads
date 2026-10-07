// How wet the fine dry stuff a fire is lit with is, 0 bone dry to 1 soaked through. Rain falling on it soaks it within
// the hour; out of the rain the sun, the wind and the warmth dry it, a fire close by fastest. Under a roof, or tucked
// into a bag or a pot, the rain never reaches it. Tinder in someone's hands keeps its own wetness (world.ts Stack wet);
// the grass, fern and dead twigs lying about in the open are as wet as the island's weather has left them
// (Weather.litter). What it comes to decides whether a fire catches in it (physics.ts): a spark is a moment's heat,
// spent drying a damp fiber before it can light it, while an ember keeps glowing against tinder that is only damp, and
// only tinder soaked through puts it out.
import { DAY, hourOf, type Agent, type Stack, type World } from "./world";
import { anyAround, nearestThing } from "./space";
import { airOn, snowAt } from "./air";
import { lightOn } from "./light";
import { COVER, sunAt, through } from "./sky";
import { p, type Kind } from "./materials";

export const DAMP = 0.3, SOAKED = 0.6;
export const raining = (w: World) => w.weather.sky === "rain" || w.weather.sky === "storm";
// Under a roof: a shelter of their own or anyone's close enough to be under.
export function sheltered(w: World, a: { px: number; py: number }) {
  return !!anyAround(w, a.px, a.py, 4, ["structure"], (t) => (t.shelter?.tier ?? 0) >= 1);
}
// Tinder: fine, dry, stringy stuff an ember or a spark can catch in, as fiber and bark are.
export const tinder = (k?: Kind) => !!k && !k.parts?.length && p(k, "fibrous") >= 0.6 && p(k, "flammable") >= 0.7;
export const wetOf = (s?: Stack) => s?.wet ?? 0;

// The share of what falls an hour soaks into what it falls on, and what is left of the wetness an hour's drying takes:
// a little at night in the cold and still, most of it in a warm, windy noon.
const SOAK: Record<World["weather"]["sky"], number> = { clear: 0, cloudy: 0, rain: 0.7, storm: 0.9 };
const dryRate = (sun: number, wind: number, temp: number, fire: boolean) => Math.min(0.95, 0.08 + 0.5 * sun + 0.02 * wind + 0.008 * Math.max(0, temp) + (fire ? 1 : 0));
// An hour's change taken a tick at a time: soaking toward 1, drying toward 0.
const soakTick = (wet: number, perHour: number) => 1 - (1 - wet) * (1 - perHour) ** (1 / 12);
const dryTick = (wet: number, perHour: number) => wet * (1 - perHour) ** (1 / 12);
// The sun on open ground at tick t under a sky, 0 to 1: how high it stands, through whatever cloud there is.
function sunOn(t: number, sky: World["weather"]["sky"]) {
  const el = sunAt(Math.floor(t / DAY) + 1, hourOf(t)).el;
  return Math.max(0, Math.sin(el)) * through(COVER[sky]);
}
// The litter in the open an hour on from tick t under a sky, a wind over the open sea and a warmth: what wetness() comes
// to over the hour, taken at its start.
export const litterHour = (wet: number, t: number, sky: World["weather"]["sky"], speed: number, temp: number) =>
  SOAK[sky] ? 1 - (1 - wet) * (1 - SOAK[sky]) : wet * (1 - dryRate(sunOn(t, sky), speed * 0.6, temp, false));

// Every tick: the litter on open ground, and the tinder everyone holds.
export function wetness(w: World) {
  const wx = w.weather, rain = raining(w), sun = sunOn(w.t, wx.sky);
  // open ground takes the wind a little below what it is over the open sea
  wx.litter = rain ? soakTick(wx.litter ?? 0, SOAK[wx.sky]) : dryTick(wx.litter ?? 0, dryRate(sun, wx.speed * 0.6, wx.temp, false));
  if (wx.litter < 0.005) wx.litter = 0;
  for (const a of w.agents) {
    if (!a.inv.some((s) => tinder(w.kinds[s.k]))) continue;
    const roof = sheltered(w, a), bag = a.inv.some((s) => p(w.kinds[s.k], "container") >= 0.6), air = airOn(w, a);
    const k = dryRate(roof ? 0 : sun * (1 - lightOn(w, a).canopy), air.wind, air.temp, !!anyAround(w, a.px, a.py, 3, ["fire"]));
    for (const s of a.inv) {
      if (!tinder(w.kinds[s.k])) continue;
      const wet = rain && !roof && !bag ? soakTick(wetOf(s), SOAK[wx.sky]) : dryTick(wetOf(s), k);
      if (wet < 0.005) delete s.wet;
      else s.wet = wet;
    }
  }
}

// How wet anything picked up here is: as wet as what lies about in the open, or dry under a roof.
export const wetHere = (w: World, at: { px: number; py: number }) => (sheltered(w, at) ? 0 : w.weather.litter ?? 0);

// What lies about to light a fire with, if they hold no tinder: grass or fern at their feet that snow hasn't buried, or
// the dead twigs of a bush, which stand above it.
const GROUND_TINDER: Record<string, string> = { grass: "grass at their feet", fern: "fern at their feet", dead_bush: "dead twigs of a bush" };
// The tinder they'd light a fire with and how wet it is: what they hold of a kind (k, for a spark struck over it), or
// any tinder they hold, or failing that what lies about within arm's reach; null if there's none.
export function tinderOf(w: World, a: Agent, k?: string): { kind?: Kind; name: string; wet: number } | null {
  const s = a.inv.find((x) => (k ? x.k === k : tinder(w.kinds[x.k])));
  if (s) return { kind: w.kinds[s.k], name: w.kinds[s.k]?.name ?? s.k, wet: wetOf(s) };
  if (k) return null;
  const buried = snowAt(w, a.px, a.py) > 0.5;
  const t = nearestThing(w, a.px, a.py, buried ? ["dead_bush"] : Object.keys(GROUND_TINDER), () => true, 2);
  return t ? { name: GROUND_TINDER[t.kind], wet: wetHere(w, a) } : null;
}
