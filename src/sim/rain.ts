// Where the rain lands. The sky's rain (air.ts rainWhen) is what falls on open level ground; a point gets less of it
// where something stands between it and the sky along the way the rain comes. Drops fall as fast as their size lets them
// and the wind carries them sideways as they fall, so in a wind the rain slants in, and the ground it misses lies
// downwind of what stopped it: the lee of a boulder, the far side of a tree, a slope turned from the wind. A crown holds
// the rain that lands on it until its leaves and twigs are wet through, about a millimetre of water over the ground it
// covers, and only then lets the rest drip; what it holds dries off into the air again between showers. So a shower
// that wets the open leaves the ground under a pine dry, and a long rain soaks both (docs/research/fire-constants.md
// sec. 25c).
import { esat } from "../terrain/climate";
import { BOULDER, TALL, TALLEST, TREES } from "../terrain/flora";
import { CLOUD, headWind, islandAir, rainAt, slopeAt, sunOn } from "./air";
import { CROWN_REACH, crownCover } from "./light";
import { around, lookAround } from "./space";
import { leafless } from "./wetness";
import { glowAway } from "./soil";
import { TILE_M, perWorld, type Thing, type World } from "./world";

// ---------- drops ----------
// The rain's water falls at the speed of its median drop by volume: Marshall and Palmer's spread of drop sizes at R mm
// an hour falls off exponentially at 4.1 R^-0.21 per mm, which puts half the water in drops under 3.67 over that across
// (R218), and a drop D mm across falls at Atlas's 9.65 - 10.3 e^(-0.6 D) m/s (R219).
export const fallSpeed = (rain: number) => 9.65 - 10.3 * Math.exp((-0.6 * 3.67) / (4.1 * rain ** -0.21));
// The open ground's wind (z0 0.03 m, sec. 14) below a height carries a drop sideways for as long as it takes to fall.
const Z0 = 0.03, TO_2M = Math.log(2 / Z0);
// How far upwind of where it lands a drop falling at v m/s was when it was z meters up, in a head-height wind u: the log
// profile's mean wind below z for the z / v seconds of its fall.
export const drift = (z: number, u: number, v: number) => (z > Z0 * Math.E ? (z * u * (Math.log(z / Z0) - 1)) / (TO_2M * v) : 0);

// ---------- crowns ----------
// How deep a tree's crown hangs, as a share of its height: half, as forest-grown Scots pines and oaks carry theirs (BAAD,
// R98; sec. 30a).
export const CROWN = 0.5;
// A crown in leaf, and a pine's in any season, lets 0.07 of the rain straight through its own gaps, as a closed stand's
// crowns let through before they wet (R214; the stand's 0.3 counts the gaps between crowns too, which a place here has
// for itself); a broadleaf's bare branches let through 0.9 (R216). Wet through, a pine's crown holds 1.21 mm over the
// ground it covers (R215) and a broadleaf's in leaf 0.8 mm (R217); bare, its branches hold as much for each share of the
// ground they still cover [derived]. Trees of a kind these don't know hold as an oak does.
const GAP = 0.07, BARE_GAP = 0.9;
const HOLDS: Record<string, number> = { pine: 1.21, oak: 0.8, ash: 0.8, aspen: 0.8 };
export const crownKind = (species?: string) => { const k = TREES.indexOf(species as (typeof TREES)[number]); return k < 0 ? TREES.indexOf("oak") : k; };
function crownWay(k: number, bare: boolean) {
  const p = bare && TREES[k] !== "pine" ? BARE_GAP : GAP;
  return { p, full: (HOLDS[TREES[k]] * (1 - p)) / (1 - GAP) };
}
// The share of the sky a crown of kind k shows through its own gaps: the rain falls straight through them, and the sun's
// beam shines through them onto what lies among its branches.
export const crownGap = (k: number, bare: boolean) => crownWay(k, bare).p;
// The share of rain falling at this rate (mm an hour) that reaches the ground under a crown of kind k holding `held` mm
// as the rain begins: what falls through its gaps, and whatever lands on it past what it can hold (Rutter's bucket,
// R220), less the 0.029 of the rain the branches lead down the trunk (Gash's stemflow share, R214), which wets only the
// trunk's foot.
const STEM = 0.029;
export function through(k: number, held: number, rain: number, bare: boolean) {
  if (rain <= 0) return 1;
  const { p, full } = crownWay(k, bare);
  return (p * rain + Math.max(0, held + (1 - p - STEM) * rain - full)) / rain;
}
// How fast a wet crown h meters tall dries, mm an hour: FAO-56's Penman-Monteith with nothing in the way at the surface,
// as wet leaves have no stomata to close (R221). The sun it takes in, 0.88 of it [UNVERIFIED], less the warmth it glows
// away to a sky this cloudy (soil.ts glowAway); and the damp air the wind carries off it, by the log law over a crown
// (z0 0.13 h and d 0.64 h, sec. 14, and heat's z0 a tenth of the wind's, FAO-56), with the wind over it read from the
// open ground's at twice its height, where its own stirring of the air gives out [design]. In air at temp C holding
// vapour kPa, under sun W/m2, cloud the sky's share hidden, and a head-height wind on open ground.
export function wetDrying(temp: number, vapour: number, sun: number, cloud: number, head: number, h: number) {
  if (h <= 0) return 0;
  const es = esat(temp), slope = (4098 * es) / (temp + 237.3) ** 2, gamma = 0.000665 * 101.3, z = 2 * h;
  const u = (head * Math.log(z / Z0)) / TO_2M, ra = (Math.log((z - 0.64 * h) / (0.13 * h)) * Math.log((z - 0.64 * h) / (0.013 * h))) / (0.41 ** 2 * u);
  const net = 0.88 * sun * 0.0036 - glowAway(temp, vapour, cloud); // MJ/m2 an hour
  return Math.max(0, (slope * net + (1.2 * 1.013e-3 * 3600 * Math.max(0, es - vapour)) / ra) / (slope + gamma) / 2.45);
}

// The water each kind of crown on the island holds (mm) an hour on from tick t under a sky, a wind over the open sea and a
// warmth: what it held dries off by Rutter's rate, as fast as a wet crown dries for the share of it still wet (R220), a
// crown as tall as its kind grows where it fits best (flora.ts TALL), and the hour's rain tops it up to what it can hold.
// held: what it holds when the hour's rain starts falling on it; next: at the hour's end. With none yet, the crowns
// start dry.
export function crownsHour(w: World, crowns: number[] | undefined, t: number, sky: World["weather"]["sky"], speed: number, temp: number) {
  const { vapour, rain } = islandAir(w, t, sky), bare = leafless(w), sun = sunOn(t, sky);
  const held = TREES.map((_, k) => {
    const c = crowns?.[k] ?? 0;
    return c > 0 ? c * Math.exp(-wetDrying(temp, vapour, sun, CLOUD[sky], speed * 0.6, TALL[TREES[k]]) / crownWay(k, bare).full) : 0;
  });
  return { held, bare, next: held.map((c, k) => { const { p, full } = crownWay(k, bare); return Math.min(full, c + (1 - p) * rain); }) };
}

// ---------- a place ----------
// What stands round a point between it and the sky, as the rain sees it: each crown (its tree, how far east and south of
// the point it stands in meters, the height of the middle of its crown, its kind), each boulder (where, how wide and how
// tall), and how the ground slopes. A boulder is taken as a dome as tall as it is half wide [design]. reach: how far the
// rain might slant, m, so how far out to look.
export type Place = {
  crowns: { t: Thing; x: number; y: number; z: number; k: number }[];
  rocks: { x: number; y: number; r: number; h: number }[];
  slope: [number, number];
  reach: number;
};
const places = perWorld(() => new Map<string, { at: number; place: Place }>());
export function placeOf(w: World, px: number, py: number, reach: number): Place {
  const all = places(w), key = `${px},${py}`, at = lookAround(w, px, py, CROWN_REACH + reach), kept = all.get(key);
  if (kept && kept.at === at && kept.place.reach >= reach) return kept.place;
  const place: Place = { crowns: [], rocks: [], slope: slopeAt(w, px, py), reach };
  around(w, px, py, CROWN_REACH + reach, ["tree", "boulder"], (t) => {
    const x = (t.px - px) * TILE_M, y = (t.py - py) * TILE_M;
    if (t.kind === "tree") place.crowns.push({ t, x, y, z: t.size * (1 - CROWN / 2), k: crownKind(t.species) });
    else place.rocks.push({ x, y, r: t.size / 2, h: t.size / 2 });
  });
  if (all.size >= 8192) all.clear();
  all.set(key, { at, place });
  return place;
}
// How far the rain falling at this rate in this head-height wind might slant past anything that stands, m: from the
// middle of the tallest crown or the top of the biggest boulder (flora.ts TALLEST, BOULDER).
export const reachOf = (rain: number, head: number) => drift(Math.max(TALLEST * (1 - CROWN / 2), BOULDER / 2), head, fallSpeed(rain));
// The rain reaching the ground at a place, mm an hour, of the open ground's rain falling at this rate in a head-height
// wind blowing this way, the crowns holding what they hold (held, by kind) and the broadleaves bare or not. The ground
// takes more of the slanting rain where it rises into the wind and less where it falls away from it, none on a slope
// steeper than the rain, by Sharon's reckoning (R222); none reaches it through a boulder upwind, and through each crown
// over the drop's path the share that crown lets through where the path crosses it.
export function rainThere(place: Place, rain: number, way: { dx: number; dy: number }, head: number, held: number[], bare: boolean) {
  if (rain <= 0) return 0;
  const len = Math.hypot(way.dx, way.dy) || 1, ux = way.dx / len, uy = way.dy / len, v = fallSpeed(rain);
  let share = Math.max(0, 1 + (head / v) * (place.slope[0] * ux + place.slope[1] * uy));
  for (const r of place.rocks) {
    const s = Math.max(0, Math.min(-(r.x * ux + r.y * uy), drift(r.h, head, v)));
    if (Math.hypot(r.x + ux * s, r.y + uy * s) < r.r) return 0;
  }
  for (const c of place.crowns) {
    const s = drift(c.z, head, v), cover = crownCover(c.t, Math.hypot(c.x + ux * s, c.y + uy * s));
    if (cover > 0) share *= 1 - cover * (1 - through(c.k, held[c.k] ?? 0, rain, bare));
  }
  return rain * share;
}
// The rain reaching the ground at a point now, mm an hour: no roof's doing (wetness.ts sheltered), only what stands.
// Fires and what burns ask it of the same points tick after tick, so each point's answer is kept while the tick and the
// weather hold.
const nows = perWorld(() => new Map<string, { at: string; rain: number }>());
export function rainOn(w: World, px: number, py: number) {
  const rain = rainAt(w, px, py);
  if (rain <= 0) return 0;
  const wx = w.weather, all = nows(w), key = `${px},${py}`, at = `${w.t},${rain},${wx.speed},${wx.wind.dx},${wx.wind.dy}`, kept = all.get(key);
  if (kept?.at === at) return kept.rain;
  const last = wx.past?.hours.at(-1), head = headWind(w, px, py, wx.wind, wx.speed);
  const on = rainThere(placeOf(w, px, py, reachOf(rain, head)), rain, wx.wind, head, last?.held ?? [], last?.bare ?? leafless(w));
  if (all.size >= 8192) all.clear();
  all.set(key, { at, rain: on });
  return on;
}
