// The world keeps moving on its own: weather, fire, plants, animals, rot, and sickness.
import { ensure, p } from "./materials";
import { ablaze, bedAir, dropStacks, mark, nearFire, newKinds, occupied, removeThing, residentsOf, shelterName } from "./physics";
import { advance, alight, cooling, group, output, setIn, type Group } from "./combustion";
import { PHYS, physOf } from "./fuel";
import { BURNABLE, WIDEST, bedOf, blazeOf, blazeWords, landsOn, partsOf, reach, receiverWords, struck, type Part } from "./spread";
import { pack, receive } from "../gpu/fire";
import { BY, LIT, LOOK_S } from "../gpu/wgsl/fire";
import { see } from "./beliefs";
import { personSize } from "./senses";
import {
  DAY, H, HP, TILE_M, W, Tile, YEAR, addThing, cropOf, dayOfYear, groundOf, log, meters, rng, sea, seasonOf, tileAt, dryNear, wetAt,
  type Agent, type Thing, type World,
} from "./world";
import { anyAround, around, exists, grownOn, liveThings, makeStem, onPath, put, receiversOf, regrow, seedlingsOf, setKind, stockedAt } from "./space";
import { FAUNA } from "./fauna";
import { animals, attacked, gone, perished } from "./animals";
import { enrich, settle, soilWaterAt, wetHour } from "./soil";
import { SIZE, START } from "../terrain/flora";
import { TALLEST } from "../terrain/niche";
import { YEAR_DAYS, onDay } from "./sky";
import { CELL } from "../terrain/grid";
import { ACORN_KG, ACORN_YEARS, YEARS_PACE, fitHere, growth } from "./plants";
import { runoffHour } from "./streams";
import { airAt, airOn, islandAir, islandTemp, nextAnomaly, nextSky, nextWarmth, nextWay, rainAt, sunOn, windOf } from "./air";
import { crownRadius, skyShare } from "./light";
import { nicheOf, seedlingHour, seedlingOf, shareAt, treeOf, type Hour } from "./seedling";
import { count, timed, trace } from "./trace";
import { hooks } from "./rules";
import { growing, wetness } from "./wetness";
import { GREEN_UP } from "../terrain/growth";
import { rotPerHour } from "./spoil";
import { bodyOf, frameOf } from "./body";
import { PIT_DEPTH } from "./shelter";
import { HOUR, chance, rate } from "./ticks";
import { FIRE_S, LAND_S, SENSES_S, due, secs } from "./lanes";

const G = 9.81; // m/s2

export const pathChanges = new Set<number>();
export const iceChanged = { now: false };
// Homes destroyed by fire this tick, for the social layer: [owner, whoseFire, text].
export const burnedHomes: { owner: string; by?: string; text: string }[] = [];

const rainy = (sky: World["weather"]["sky"]) => sky === "rain" || sky === "storm";

// ---------- weather and seasons ----------
// A normal draw from two uniform ones (Box and Muller).
const normal = (r1: number, r2: number) => Math.sqrt(-2 * Math.log(1 - r1)) * Math.cos(2 * Math.PI * r2);
// The island's weather at the next n turns of the sky after now, from how it stands, drawn with r (a seeded draw of the
// caller's own, so nothing here moves the world's): what the coming days might bring (seedling.ts seedlingFate).
export function forecast(w: World, n: number, r: () => number): Hour[] {
  let { sky, speed, wet, anomaly, warm } = w.weather, t = Math.ceil((w.t + 1) / HOUR) * HOUR;
  const out: Hour[] = [];
  for (let i = 0; i < n; i++, t += HOUR) {
    sky = nextSky(sky, r(), t);
    anomaly = nextAnomaly(anomaly, normal(r(), r()));
    warm = nextWarmth(warm, normal(r(), r()));
    speed = windOf(t, sky, anomaly);
    wet = wetHour(w, wet, t, sky, speed, islandTemp(t, sky, warm));
    out.push({ sky, speed, wet, warm });
  }
  return out;
}
function weather(w: World) {
  const wx = w.weather;
  const season = seasonOf(w.t);
  if (season !== wx.season) {
    wx.season = season;
    log(w, "season", [], { x: W / 2, y: H / 2 }, `${season[0].toUpperCase() + season.slice(1)} arrived.`);
  }
  wx.dayOfYear = dayOfYear(w.t);
  wx.year = Math.floor(w.t / DAY / YEAR_DAYS) + 1;
  if (w.t % HOUR === 0) {
    const before = wx.sky;
    wx.sky = nextSky(wx.sky, Math.random(), w.t);
    // The wind wanders, but keeps coming back to blow the way it prevails, the way that laid the island's rain.
    wx.wind = nextWay(w.t, wx.wind, w.terrain.wind, normal(Math.random(), Math.random()), normal(Math.random(), Math.random()));
    wx.anomaly = nextAnomaly(wx.anomaly, normal(Math.random(), Math.random()));
    // the day's air wanders from its time of year's, and keeps its standing for days
    wx.warm = nextWarmth(wx.warm, normal(Math.random(), Math.random()));
    wx.speed = windOf(w.t, wx.sky, wx.anomaly);
    // a probe's own weather, set as the sky turns (rules.ts hooks), so the runoff, the air and how wet things get follow
    // from it as from the island's own
    hooks.weather?.(w);
    wx.wet = wetHour(w, wx.wet, w.t, wx.sky, wx.speed, islandTemp(w.t, wx.sky, wx.warm));
    wx.runoff = runoffHour(w, wx.runoff, w.t, wx.sky);
    if (wx.sky !== before) {
      const words = { clear: "The sky cleared.", cloudy: "Clouds rolled in.", rain: "It started to rain.", storm: "A storm broke." };
      log(w, "weather", [], { x: W / 2, y: H / 2 }, words[wx.sky]);
      trace("weather", "sky", { from: before, to: wx.sky, season });
    }
  }
  wx.temp = islandTemp(w.t, wx.sky, wx.warm);
  wetness(w);
  if (w.t % HOUR === 0) ice(w);
  // A drought, as Met Éireann and the Met Office count an absolute one: fifteen days or more on end, none with 0.2 mm of
  // rain (fire-constants sec. 33, R477); the island's own rain an hour, summed over each day.
  if (w.t % HOUR === 0) wx.today += rainy(wx.sky) ? islandAir(w, w.t, wx.sky).rain : 0;
  if (w.t % DAY === DAY - 1) {
    wx.dryDays = wx.today < 0.2 ? wx.dryDays + 1 : 0;
    wx.today = 0;
    const drought = wx.dryDays >= 15;
    if (drought && !wx.drought) log(w, "weather", [], { x: W / 2, y: H / 2 }, "It hasn't rained in over two weeks.");
    wx.drought = drought;
  }
  // Flashes come down in a storm as often as the island's thunder days bring them over its land (stormFlashes, flashes
  // an hour), a tick's share of the hour's each tick, each at a spot anywhere on it and onto the tallest tree that stands
  // within three of its heights of the spot, as a structure draws a flash from that far round
  // (docs/research/time-constants.md sec. 4); one landing where no tree does strikes the ground.
  for (let n = wx.sky === "storm" ? poisson(stormFlashes(w) / HOUR) : 0; n > 0; n--) {
    const land = landTiles(w), i = land[Math.floor(Math.random() * land.length)], px = (i % W) + Math.random(), py = Math.floor(i / W) + Math.random();
    const hit: { t: Thing | null } = { t: null };
    around(w, px, py, 3 * TALLEST, ["tree"], (x, d) => { if (d <= 3 * x.size && (!hit.t || x.size > hit.t.size)) hit.t = x; });
    const t = hit.t;
    if (t && !t.bed) {
      // the strike lights the tree's dead twigs if they're dry enough to carry a flame (spread.ts struck)
      const bed = struck(w, t);
      if (bed) {
        t.bed = bed;
        delete t.absorbed;
        log(w, "lightning", [], t, "Lightning struck a tree and set it burning.");
        see(w, t, "lightning", "Lightning can set a tree on fire, and fire eats wood.", t.size);
      } else log(w, "lightning", [], t, "Lightning struck a tree.");
      mark(w, t);
    }
  }
}
// How many of something that comes at a mean of m a time come this time, by the world's own draws.
function poisson(m: number) {
  let n = 0, p = Math.exp(-m), s = p;
  for (const r = Math.random(); r > s && n < 1000; ) { n++; p *= m / n; s += p; }
  return n;
}
// The island's dry land, tile by tile.
const lands = new WeakMap<World, number[]>(), flashes = new WeakMap<World, number>();
function landTiles(w: World) {
  let out = lands.get(w);
  if (!out) { out = []; for (let i = 0; i < W * H; i++) if (tileAt(w, i % W, Math.floor(i / W)) !== Tile.Water) out.push(i); lands.set(w, out); }
  return out;
}
// Flashes to ground over the island's land in an hour of storm: its ground flash density from its thunder days a year,
// 0.04 Td^1.25 a km2 (Chisholm), over its land, shared among its storm hours a year, both as twenty years of its own sky
// come out (nextSky, drawn from the island's seed) (docs/research/time-constants.md sec. 4).
function stormFlashes(w: World) {
  const known = flashes.get(w);
  if (known !== undefined) return known;
  const r = rng(w.seed * 7919 + 101), years = 20;
  let sky: World["weather"]["sky"] = "clear", hours = 0, days = 0, lastDay = -1;
  for (let h = 0; h < years * YEAR_DAYS * 24; h++) {
    const t = h * HOUR;
    sky = nextSky(sky, r(), t);
    if (sky !== "storm") continue;
    hours++;
    if (Math.floor(h / 24) !== lastDay) { days++; lastDay = Math.floor(h / 24); }
  }
  const km2 = (landTiles(w).length * TILE_M * TILE_M) / 1e6, Ng = 0.04 * (days / years) ** 1.25, rate = hours ? (Ng * km2) / (hours / years) : 0;
  flashes.set(w, rate);
  return rate;
}

// ---------- ice ----------
// Ice on the island's fresh still water, the same thickness on all of it, grows an hour at a time by Stefan's law
// (h^2 rising by a^2 for each degree-day of frost) and melts from the air above freezing at the degree-day rate a lake's
// ice does (docs/research/time-constants.md sec. 3). Salt water holds out. Anyone can walk on it once it is as thick as
// new clear ice should be to walk on; once it thins under that, anyone standing on it goes through.
export const STEFAN = 0.033, MELT = 0.0043, WALK_ICE = 0.1; // m per (C day)^0.5; m per C day; m
// Called once an hour as the sky turns (weather), so each call is an hour, a day's 1/24, of frost or thaw.
function ice(w: World) {
  const wx = w.weather, t = wx.temp, was = wx.ice ?? 0, day = 1 / 24;
  const h = t < 0 ? Math.sqrt(was * was + STEFAN * STEFAN * -t * day) : Math.max(0, was - MELT * t * day);
  if (h > 0) wx.ice = h; else delete wx.ice;
  const bears = h >= WALK_ICE;
  if (bears && !w.ice.length) {
    const salt = sea(w);
    for (let i = 0; i < W * H; i++) if (!salt[i] && tileAt(w, i % W, Math.floor(i / W)) === Tile.Water) w.ice.push(i);
    iceChanged.now = true;
    log(w, "weather", [], { x: W / 2, y: H / 2 }, "The ice on the still water grew thick enough to stand on.");
  } else if (!bears && w.ice.length) {
    for (const a of w.agents) {
      if (!wetAt(w, a.px, a.py)) continue;
      // The ice water soaks them and all they wear, and takes their skin down to near its own cold, as ten minutes in
      // ice water does (body-constants sec. 4); their core, minutes in, is still as it was.
      const b = bodyOf(w, a), worn = a.wearing && physOf(w.kinds, w.kinds[a.wearing.k]);
      a.skin = 1;
      if (a.wearing && worn) a.wearing.m = a.wearing.skin = worn.mmax;
      b.skin = Math.min(b.skin, 5);
      log(w, "hazard", [a.id], a, `The ice gave way under ${a.name}. They crawled out soaked and freezing.`);
      see(w, a, "thin_ice", "Ice melts when it warms up. Don't be standing on it.", personSize(w, a));
      // They crawl out to the nearest dry ground once the ice is gone.
      const out = dryNear({ ...w, ice: [] }, a.px, a.py);
      if (out) put(w, a, ...out);
    }
    for (const an of w.animals) if (FAUNA[an.species].ground && wetAt(w, an.px, an.py)) an.hp = 0;
    w.ice = [];
    iceChanged.now = true;
    log(w, "weather", [], { x: W / 2, y: H / 2 }, "The ice thinned and broke up.");
  }
}

// ---------- pits, traps, wells ----------
// A pit is dug as deep as shelter.ts PIT_DEPTH; where the water table lies above its floor (water.ts table, the
// generator's depth to it there), the groundwater seeps in and stands in it: a well (docs/research/time-constants.md
// sec. 5) [gap: how long the seeping takes].
const tableAt = (w: World, px: number, py: number) => {
  const { isle, fine } = groundOf(w.seed);
  return fine.bilinear(isle.table, (px * TILE_M - SIZE / 2 - START) / CELL, (py * TILE_M - SIZE / 2 - START) / CELL);
};
function holes(w: World, live: Thing[]) {
  for (const t of live) {
    if (t.kind === "pit" && tableAt(w, t.px, t.py) < PIT_DEPTH) {
      setKind(w, t, "well"); mark(w, t);
      log(w, "dig", t.owner ? [t.owner] : [], t, "Water seeped into a pit and stood in it. A well.");
      see(w, t, "well", "A pit dug near water fills up with water.", t.size);
    }
    if (t.kind === "trap" && t.caught) {
      // A pit with steep walls as deep as someone stands in holds what falls in (docs/research/time-constants.md sec. 7):
      // it stays till it's killed, or starves there, burning its reserve with nothing to eat (its object on the GPU,
      // src/gpu/animals.ts, held fast while it lies there).
      const an = w.animals.find((m) => m.state === "trapped" && meters(m, t) <= 1);
      const starved = !!an && perished(w, an);
      if (an && starved) {
        gone(w, an);
        log(w, "trap", t.owner ? [t.owner] : [], t, `The ${an.species} in the pit starved.`);
      }
      // once nothing is in it, its cover lies broken in the bottom: an open pit again
      if (!an || starved) { delete t.caught; setKind(w, t, "pit"); mark(w, t); }
    }
  }
}
// A hidden pit catches people too, unless they know it's there or its cover holds their weight (people-constants sec. 8).
export function trapped(w: World, a: Agent, x0: number, y0: number) {
  const trap = onPath(w, x0, y0, a.px, a.py, 0.8, ["trap"], (t) => t.owner !== a.id && !t.caught && !a.facts[`trap:${t.id}`] && frameOf(w, a).kg * G > (t.holds ?? 0));
  if (!trap) return false;
  setKind(w, trap, "pit"); delete trap.holds; mark(w, trap);
  put(w, a, trap.px, trap.py);
  a.needs.health = Math.max(0, a.needs.health - 10);
  const owner = w.agents.find((x) => x.id === trap.owner);
  log(w, "trap", [a.id, ...(owner ? [owner.id] : [])], a, `${a.name} fell into ${owner ? `${owner.name}'s` : "a"} hidden pit and hurt themselves.`);
  a.facts[`trap:${trap.id}`] = "There's a pit here.";
  return owner ?? true;
}

// Crowds without clean water get sick.
function crowding(w: World) {
  if (w.t % DAY !== Math.round(DAY / 2)) return;
  for (const a of w.agents) {
    if (a.sickness) continue;
    const crowd = w.agents.filter((b) => b !== a && meters(a, b) <= 30).length;
    if (crowd < 3 || anyAround(w, a.px, a.py, 300, ["well"])) continue;
    if (Math.random() > 0.12) continue;
    a.sickness = { until: w.t + DAY, severity: 0.4 };
    log(w, "sick", [a.id], a, `${a.name} fell sick. Too many people, and no clean water.`);
  }
}

// ---------- fire ----------
// A thing burnt out: a tree is left a burnt stump, a shelter is burned down with its people out in the cold, and anything
// else is gone to ash where it stood. What the fire leaves feeds the soil, a tree's ash most.
function burnOut(w: World, t: Thing, by?: string) {
  delete t.bed;
  if (t.kind === "tree") { setKind(w, t, "burnt_stump"); t.hp = 30; t.maxHp = 30; t.size = 0.6; mark(w, t); enrich(w, t.px, t.py, 0.25); return; }
  if (t.kind === "structure") {
    const owner = w.agents.find((a) => a.id === t.owner);
    const text = `Fire burned down ${owner ? `${owner.name}'s` : "a"} ${shelterName(w, t)}.`;
    log(w, "burned", [owner?.id, by].filter(Boolean) as string[], t, text, owner ? `${owner.name}'s home burned` : "a home burned");
    if (owner) burnedHomes.push({ owner: owner.id, by, text });
    // everyone who lived there is out in the cold
    for (const x of residentsOf(w, t)) x.home = null;
  }
  removeThing(w, t);
  if (t.kind !== "item" && t.kind !== "stick" && t.size >= 0.4) {
    mark(w, addThing(w, "ash", t.px, t.py, { born: w.t, rained: 0, size: Math.min(3, t.kind === "bush" ? t.size : 1.2) }));
    enrich(w, t.px, t.py, 0.1);
  }
}
// A campfire with nothing in it alight any more.
function fireOut(w: World, t: Thing) {
  removeThing(w, t);
  enrich(w, t.px, t.py, 0.03);
  log(w, "fire_out", t.owner ? [t.owner] : [], t, rainy(w.weather.sky) && !t.covered ? "The rain put out a campfire." : "A campfire burned out.");
  fireOutFor(w, t, rainy(w.weather.sky));
}
// Something near a fire caught: it burns as a bed of its own pieces, those that lit alight and the rest holding the heat
// they've taken (spread.ts), lit by whoever's fire it was.
function caught(w: World, x: Thing, parts: Part[], groups: Group[], by: Thing) {
  x.bed = bedOf(parts, groups);
  delete x.absorbed;
  const who = by.owner ?? by.burnedBy;
  if (who) x.burnedBy = who;
  mark(w, x);
  count("fire.spread");
  trace("fire", "spread", { from: by.id, to: x.id, kind: x.kind });
  if (x.kind === "structure") log(w, "fire_spread", [x.owner ?? ""].filter(Boolean), x, "Fire caught on a shelter!");
  else if (Math.random() < 0.1) log(w, "fire_spread", [], x, `Fire spread to a ${x.kind.replace("_", " ")}.`);
}
// Every bed, a campfire's or a burning thing's own, burns on through the fire lane's seconds in the air where it stands
// (combustion.ts), looked at as often as a bed steps, every ten seconds (fire-constants sec. 28), one look for each ten
// seconds owed; a bed gone out is a campfire gone, or a thing burnt out. A fire heaped over with stone keeps its flames,
// its heat and its brands under the stone. How each bed blazed at each look, and every fuel object within its reach (and
// anything still warm from an earlier fire), are gathered over the runs since the last landing and go with the
// landing's tick to the receivers' law on the GPU (gpu/fire.ts, wgsl/fire.ts): there each part of each takes the
// flames' heat and their radiation look by look and the brands landing on it, and the first look one lights is the last
// it takes. What comes back with the landing settles it: a thing that lit burns as a bed of its own from then on, and
// the rest keep the heat they hold, or are as they were once cooled right down. A world not resident on the GPU works
// the same law out by its twin at once.
type Gathered = { looks: number[][][]; order: Thing[]; at: Map<Thing, number>; near: Set<Thing> };
const gathered = new WeakMap<World, Gathered>();
export function fire(w: World, live: Thing[], dt = secs(FIRE_S), landing = due(w.t, LAND_S)) {
  // each burning bed, how far it has looked for what it might heat and for what its brands might land on; each bed's
  // place in the batch's order, and what might take their heat, kept from the runs since the last landing
  const beds = new Map<Thing, { heat: number; brands: number }>();
  const g = gathered.get(w) ?? { looks: [], order: [], at: new Map<Thing, number>(), near: new Set<Thing>() }, { order, at, near } = g;
  const seen = (x: Thing) => { if (!x.bed) near.add(x); };
  for (const t of live) {
    if (t.bed) { beds.set(t, { heat: -1, brands: -1 }); if (!at.has(t)) at.set(t, order.push(t) - 1); }
    else if (t.kind === "fire") fireOut(w, t);
    else if (t.absorbed) near.add(t);
  }
  for (let k = 0; k < dt; k += LOOK_S) {
    const look: number[][] = [];
    g.looks.push(look);
    for (const [t, src] of beds) {
      const air = bedAir(w, t);
      if (alight(t.bed!) && !t.covered) {
        const b = blazeOf(w, t, output(t.bed!, air), air), r = reach(b);
        if (r.heat > src.heat) {
          src.heat = r.heat;
          around(w, t.px, t.py, r.heat + WIDEST, BURNABLE, seen);
        }
        if (r.brands > src.brands) {
          src.brands = r.brands;
          around(w, t.px, t.py, r.brands + WIDEST, BURNABLE, (x) => { if (landsOn(x)) seen(x); });
        }
        look.push(blazeWords(b, at.get(t)!));
      }
      t.bed = advance(t.bed!, LOOK_S, air);
      if (alight(t.bed)) continue;
      beds.delete(t);
      if (t.kind === "fire") fireOut(w, t);
      else burnOut(w, t, t.burnedBy);
    }
  }
  for (const t of beds.keys()) mark(w, t);
  if (!landing) { gathered.set(w, g); return; }
  gathered.delete(w);
  const taking = [...near].filter((x) => exists(w, x)).map((x) => ({ x, parts: partsOf(w, x) })).filter((r) => r.parts.length);
  if (!taking.length) return;
  const batch = pack(w.seed, w.t, g.looks, taking.map((r) => receiverWords(w, r.x, r.parts)));
  let first = batch.nr;
  const starts = taking.map((r) => (first += r.parts.length) - r.parts.length);
  const settle = (out: Uint32Array) => taking.forEach(({ x, parts }, i) => {
    if (x.bed || !exists(w, x)) return;
    const at = starts[i], heat = parts.map((_, j) => (out[at + j] & 0x7fffffff) / 256);
    if (out[i] & LIT) {
      const groups = parts.map((p, j) => ({ ...group(p.phys, p.n, p.m, 0, 0, p.skin), heat: heat[j], lit: (out[at + j] & LIT) !== 0 }));
      caught(w, x, parts, groups, order[out[i] & BY]);
    } else if (heat.some((v) => v > 0)) { x.absorbed = heat; mark(w, x); }
    else if (x.absorbed) { delete x.absorbed; mark(w, x); }
  });
  const gpu = receiversOf(w);
  if (gpu) gpu.queue(batch, settle);
  else settle(receive(batch));
}

// ---------- plants ----------
// Nothing here asks the season or what a tile is called. Plants grow by the air's warmth, the soil's water, the light and
// the soil's nourishment where they stand (plants.ts growth); seed falls where it fits (niche.ts) and takes root as it
// fits; trees ripen their nuts as the days draw in (cues.ts); what's taken of the ground's growth comes back as it grows.
const BERRY_HP = 20;
// A mushroom's fruit body lasts a week or two (R453), days.
const FRUIT_DAYS = 10;
// The acorns left on the ground under twelve Southampton oaks, kg fresh a m2 of their crowns: 0.196 in the 13 of 27 years
// that had a crop and none in the rest (R454; plants.ts ACORN_KG), a year's mean. They fall from mid September
// [UNVERIFIED] to the last week of October, by when the trees had shed the bulk of them (R454): real days after the
// spring equinox.
const ACORNS = ACORN_KG * ACORN_YEARS, ACORNS_FROM = onDay(179), ACORNS_TO = onDay(218);
// Mice, jays and boar take what lies on the ground: 92 to 97% of fallen acorns were gone by the next spring (Kamler et
// al., R456), some 165 days on, so 94.5% at a steady rate, a day [derived].
const ACORN_LOSS = Math.log(1 / 0.055) / 165;
// The share of something lying under the oaks since ticks ago that the animals haven't taken.
const lasting = (ticks: number) => Math.exp(-ACORN_LOSS * (ticks / DAY) * YEARS_PACE);
// The acorns lying under an oak at tick t, in nuts (fuel.ts): falling evenly through the fall at the rate that leaves
// its crown's measured crop on the ground at the end of it, each one lasting as long as the animals let it, less what
// people have gleaned there [derived]. Worked out when anyone looks, from the date: nothing lies there as things.
// The acorns lying under an oak at the end of the fall, nuts: its crown's measured crop.
export const acornCrop = (t: Thing) => (t.kind === "tree" && t.species === "oak" ? (ACORNS * Math.PI * crownRadius(t) ** 2) / (PHYS.nut.mass * (1 + (PHYS.nut.green ?? 0))) : 0);
export function acornsUnder(w: World, t: Thing) {
  if (t.kind !== "tree" || t.species !== "oak") return 0;
  const k = ACORN_LOSS, L = (ACORNS_TO - ACORNS_FROM) * YEARS_PACE, d = ((((w.t / DAY - ACORNS_FROM) % YEAR_DAYS) + YEAR_DAYS) % YEAR_DAYS) * YEARS_PACE;
  const end = acornCrop(t), fall = (end * k) / (1 - Math.exp(-k * L));
  const lying = d <= L ? (fall / k) * (1 - Math.exp(-k * d)) : end * Math.exp(-k * (d - L));
  return Math.max(0, Math.floor(lying - (t.gleaned ? t.gleaned.n * lasting(w.t - t.gleaned.t) : 0)));
}
// n nuts gleaned from under an oak.
export function glean(w: World, t: Thing, n: number) {
  t.gleaned = { n: (t.gleaned ? t.gleaned.n * lasting(w.t - t.gleaned.t) : 0) + n, t: w.t };
  mark(w, t);
}
const FROM_ROOTS = new Set(["herb", "reeds", "fern", "flowers", "grass"]);
// When the growing season last turned on, each world.
const greenings = new WeakMap<World, { on: boolean; since: number }>();
// The rain that washes ash away, mm (R449).
const ASH_RAIN = 120;
// How fast a pine's wound stops running, days (R450).
const RESIN_DAYS = 0.8;
// Which stumps put up a new stem from their roots: oak, ash and hazel coppice, aspen suckers, a bramble regrows from its
// crown; a cut Scots pine dies (docs/research/time-constants.md sec. 6).
const SPROUTS = new Set(["oak", "ash", "aspen", "hazel", "berry"]);
const sprouts = (t: Thing) => SPROUTS.has(t.kind === "dead_bush" ? "berry" : t.species ?? "");
function plants(w: World, live: Thing[]) {
  const greening = growing(w).index >= GREEN_UP;
  for (const t of live) {
    if (ablaze(t)) continue;
    if (t.oozing) {
      // a pine's wound runs resin fastest at first and stops within days, as its ducts seal: an exponential with a time
      // constant of 0.8 days (R450). It beads on the bark, in beads as heavy as resin's piece (fuel.ts)
      const ran = t.oozing * (1 - Math.exp(-1 / (RESIN_DAYS * DAY))), was = Math.floor(t.resin ?? 0);
      t.oozing -= ran; t.resin = (t.resin ?? 0) + ran / (PHYS.resin.mass * 1000);
      if (t.oozing < 0.01) delete t.oozing;
      if (Math.floor(t.resin) !== was) mark(w, t);
    }
    if (t.kind === "bush") {
      // the crop sets as the bush grows, a year's over half a year of the best growth (plants.ts growth) [design]; its
      // picked hit points come back 0.02 a tick [design: today's per-tick value]
      const full = cropOf(t), was = t.n ?? 0;
      if (t.species === "berry" && was < full) {
        t.n = Math.min(full, was + (full * growth(w, t.px, t.py)) / (YEAR / 2));
        if (Math.floor(t.n) !== Math.floor(was) || t.n === full) mark(w, t);
      }
      if ((t.hp ?? BERRY_HP) < (t.maxHp ?? BERRY_HP)) t.hp = Math.min(t.maxHp ?? BERRY_HP, (t.hp ?? BERRY_HP) + rate(0.02, 300));
      if ((t.hp ?? BERRY_HP) <= 0) { setKind(w, t, "dead_bush"); t.n = 0; mark(w, t); log(w, "grow", [], t, "A berry bush was picked to death."); }
    } else if ((t.kind === "dead_bush" || t.kind === "stump" || t.kind === "burnt_stump") && greening && sprouts(t)) {
      // Broadleaves and brambles put up a new stem from the old roots once the growing season comes round; a pine's stump
      // dies (docs/research/time-constants.md sec. 6). The sprout grows as a seedling of its kind does [gap: what the
      // roots hold makes a sprout grow far faster than a seedling].
      const sp = t.kind === "dead_bush" ? "berry" : t.species!;
      // a felled or burned aspen sends up suckers all round from its roots as well, on the GPU (gpu/seedlings.ts), named
      // by the stump's id
      if (sp === "aspen") {
        let id = 0x811c9dc5;
        for (let k = 0; k < t.id.length; k++) id = Math.imul(id ^ t.id.charCodeAt(k), 0x01000193);
        seedlingsOf(w)?.sucker(Math.round(t.px * TILE_M * 1000), Math.round(t.py * TILE_M * 1000), id);
      }
      // The sprout is a new stem on the old roots, a thing of its own as a sucker is: the stem the ground laid down stays
      // gone (gpu/flora.ts: a tree or bush never comes back where it stood once gone).
      const { px, py, owner } = t;
      removeThing(w, t);
      mark(w, addThing(w, "sapling", px, py, { ...(sp === "berry" ? { item: "berry" } : { species: sp }), ...(owner ? { owner } : {}), stage: 0, born: w.t, hp: 5, maxHp: 5, size: 0.3 }));
    } else if (t.kind === "sapling") {
      // tended once an hour as the sky turns (seedling.ts), by the spot's fit as it was the first time and the share of
      // it the plants round it leave it now, in the sun on the open ground and the share the crowns let through
      if (w.t % HOUR) continue;
      t.fit ??= fitHere(w, nicheOf(t), t.px, t.py);
      if (t.share === undefined || stockedAt(w, t.px, t.py)) t.share = shareAt(w, t.px, t.py, t.stage ?? 0, t);
      const was = t.stage ?? 0;
      const fate = seedlingHour(t, seedlingOf(nicheOf(t)), t.fit, t.share, soilWaterAt(w, t.px, t.py), airAt(w, t.px, t.py).temp, sunOn(w.t, w.weather.sky), skyShare(w, t.px, t.py));
      if (fate === "withered") { wither(w, t); continue; }
      if (Math.round((t.stage ?? 0) * 20) !== Math.round(was * 20)) { t.size = Math.round((0.3 + (t.stage ?? 0) * 0.5) * 100) / 100; mark(w, t); }
      if (fate === "up") matured(w, t);
    } else if (t.kind === "ash") {
      // the rain beats it down and washes it into the soil: after a grassland fire, little of the ash went in the first
      // 10 mm, most of it with the next 81 and all but traces by 120 mm (Pereira et al., time-constants sec. 8); the rain
      // falls in mm an hour, a day's 24 of them spread over the day's ticks
      t.rained = (t.rained ?? 0) + (rainAt(w, t.px, t.py) * 24) / DAY;
      if (t.rained >= ASH_RAIN) removeThing(w, t);
    }
  }
  // what someone gleaned from under an oak counts for nothing once the mice would have had it anyway
  if (w.t % DAY === 0) for (const t of w.things) if (t.gleaned && t.gleaned.n * lasting(w.t - t.gleaned.t) < 0.5) { delete t.gleaned; mark(w, t); }
  // the season's growth turning on: what grew from roots comes back from them from here
  const g = greenings.get(w) ?? { on: greening, since: -Infinity };
  if (greening && !g.on) g.since = w.t;
  g.on = greening;
  greenings.set(w, g);
  // once a day, what was taken of the ground's growth comes back as its kind does (time-constants sec. 8): a mushroom's
  // as the fungus fruits again, a fruit body lasting 44 days for a chanterelle and a week or two for the rest (R453);
  // herbs, reeds, ferns, flowers and grass from their roots at the next green-up, as a broadleaf's stump does; clay and
  // ore never, nothing making more of them in a lifetime. Sticks are pieces that fall from the crowns and rot on the GPU,
  // a stick taken never coming back (src/gpu/deadwood.ts); stones too are pieces there, never made again.
  if (w.t % DAY === 0) regrow(w, (t, went) => {
    if (t.kind === "mushroom") return Math.random() < 1 - Math.exp(-YEARS_PACE / (t.species === "chanterelle" ? 44 : FRUIT_DAYS));
    return FROM_ROOTS.has(t.kind) && g.since > went;
  });
}
// A seedling wilted away: gone. Whoever put it in the ground or watered it sees it withered, and nothing tells them why:
// what they make of it is their own theory (sim.ts judged), from what they saw when they planted it.
function wither(w: World, t: Thing) {
  removeThing(w, t);
  const owner = w.agents.find((a) => a.id === t.owner);
  if (owner) log(w, "grow", [owner.id], t, `The ${w.kinds[t.item ?? ""]?.name ?? t.item ?? "seed"} ${owner.name} pushed into the ground withered.`);
  witheredFor(w, t);
}
function matured(w: World, t: Thing) {
  delete t.fit; delete t.water; delete t.share;
  if (treeOf(t)) {
    // a nut grows into an oak; a tree's seedling into its own kind
    const from = t.item;
    setKind(w, t, "tree"); t.species = t.species && t.species !== "berry" ? t.species : "oak"; t.size = 4 + Math.random() * 2; t.hp = 48; t.maxHp = 48; delete t.stage; delete t.item;
    mark(w, t);
    // from now on a stem on the GPU, which grows it as it does the ground's own (space.ts makeStem)
    makeStem(w, t);
    if (from && t.owner) {
      log(w, "grow", [t.owner], t, `The ${w.kinds[from]?.name ?? from} ${w.agents.find((a) => a.id === t.owner)?.name} pushed into the ground grew into a young tree.`);
      see(w, t, `grows:${from}`, `A ${w.kinds[from]?.name ?? from} in the ground can grow into a tree.`, t.size);
    }
    grewFor(w, t, "tree");
    return;
  }
  const from = t.item ?? "berry";
  // grain sown in the ground comes up as a tuft of grass that bears seed in its season
  if (from === "grain") {
    setKind(w, t, "grass"); t.size = 0.7; t.hp = 4; t.maxHp = 4; delete t.stage;
    mark(w, t);
    if (t.owner) {
      log(w, "grow", [t.owner], t, `The grain ${w.agents.find((a) => a.id === t.owner)?.name} sowed came up as grass.`);
      see(w, t, "grows:grain", "Grain pushed into the ground comes up as grass that bears more grain.", t.size);
    }
    grewFor(w, t, "grass");
    return;
  }
  setKind(w, t, "bush"); t.species = "berry"; t.n = 1; t.hp = BERRY_HP; t.maxHp = BERRY_HP; t.size = 0.9; delete t.stage;
  mark(w, t);
  makeStem(w, t);
  log(w, "grow", t.owner ? [t.owner] : [], t, t.owner ? `The ${w.kinds[from]?.name ?? from} ${w.agents.find((a) => a.id === t.owner)?.name} pushed into the ground grew into a berry bush.` : "A new berry bush sprang up.");
  see(w, t, `grows:${from}`, `A ${w.kinds[from]?.name ?? from} in the ground can grow into a berry bush.`, t.size);
  grewFor(w, t, "bush");
}
// What came of a seedling, for whoever is waiting to see (sim.ts): it came up as a bush, a tree or grass, or it withered.
export let grewFor: (w: World, t: Thing, builds: string) => void = () => {};
export const onGrew = (fn: typeof grewFor) => (grewFor = fn);
export let witheredFor: (w: World, t: Thing) => void = () => {};
export const onWithered = (fn: typeof witheredFor) => (witheredFor = fn);
// A fire gone out, for whoever was keeping it: rained out, or burned down to nothing.
export let fireOutFor: (w: World, t: Thing, rained: boolean) => void = () => {};
export const onFireOut = (fn: typeof fireOutFor) => (fireOutFor = fn);

// ---------- heat leaving things ----------
// Each run of the senses lane, what heat made of a thing (hot metal soft enough to work, physics.ts heating) lasts only
// while it stays warm enough (Kind.hotAbove): held at a fire that keeps it that warm it takes the fire's warmth there
// (combustion.ts setIn); anywhere else it cools in the air where it is over the lane's seconds (combustion.ts cooling),
// and once under that warmth it is what it was (docs/research/time-constants.md sec. 2).
function cool(w: World, live: Thing[], dt: number) {
  const tick = (s: { k: string; T?: number }, at: { px: number; py: number }, f: Thing | null) => {
    const k = w.kinds[s.k], phys = k && physOf(w.kinds, k);
    if (!k?.hotAbove || !phys || !k.parts?.[0]) return false;
    if (f?.bed) {
      const T = setIn(f.bed, bedAir(w, f), phys.d);
      if (T >= k.hotAbove) { s.T = T; return false; }
    }
    const air = airOn(w, at);
    s.T = cooling(phys, s.T ?? k.hotAbove, air.temp + 273.15, air.wind, dt);
    if (s.T >= k.hotAbove) return false;
    s.k = k.parts[0];
    delete s.T;
    return true;
  };
  for (const a of w.agents) { const f = nearFire(w, a); for (const s of a.inv) tick(s, a, f); }
  for (const t of live) {
    if (t.kind !== "item" || !t.item || !w.kinds[t.item]?.hotAbove) continue;
    const s = { k: t.item, T: t.heat };
    if (tick(s, t, nearFire(w, t))) { t.item = s.k; delete t.heat; mark(w, t); } else t.heat = s.T;
  }
}

// ---------- rot, wear, weathering ----------
function decay(w: World, live: Thing[]) {
  if (w.t % HOUR) return;
  const rot = (k: string) => {
    const [kind, isNew] = ensure(w.kinds, `rotten:${k}`, () => ({
      name: `rotten ${w.kinds[k]?.name ?? k}`, props: { edible: 0.05, toxic: 0.85, seed: p(w.kinds[k], "seed") }, parts: [k], shelf: 3, spoils: "chill",
    }));
    if (isNew) newKinds.add(kind.id);
    return kind.id;
  };
  // An hour's spoiling of food at the warmth of the air it's kept in, C (spoil.ts), the more slowly in with a pot, a
  // basket or a bag, half as long again (keep) [design]: true once it has gone all the way.
  const spoiled = (s: { k: string; rot?: number }, T: number, keep = 1) => {
    const r = rotPerHour(w.kinds, w.kinds[s.k], T) / keep;
    if (r <= 0) return false;
    s.rot = (s.rot ?? 0) + r;
    return s.rot >= 1;
  };
  const vessel = (ks: { k: string }[]) => (ks.some((s) => p(w.kinds[s.k], "container") >= 0.6) ? 1.5 : 1);
  for (const a of w.agents) {
    const keep = vessel(a.inv), T = airOn(w, a).temp;
    for (const s of [...a.inv]) {
      if (w.kinds[s.k]?.hotAbove || !spoiled(s, T, keep)) continue;
      if (s.k.startsWith("rotten:")) { a.inv.splice(a.inv.indexOf(s), 1); continue; }
      log(w, "spoil", [a.id], a, `${a.name}'s ${w.kinds[s.k]?.name} went bad.`);
      s.k = rot(s.k); s.born = w.t; delete s.rot;
    }
    if (a.wearing && (a.wearing.hp -= 0.006 * (1.3 - p(w.kinds[a.wearing.k], "toughness"))) <= 0) { log(w, "break", [a.id], a, `${a.name}'s ${w.kinds[a.wearing.k]?.name} wore through.`); a.wearing = null; }
  }
  for (const t of live) {
    if (t.kind === "item" && t.item && w.kinds[t.item]?.hotAbove) continue;
    const food = t.kind === "item" && t.item ? { k: t.item, rot: t.rot } : null;
    if (food && w.kinds[food.k]?.spoils) {
      const gone = spoiled(food, airOn(w, t).temp);
      t.rot = food.rot;
      if (gone) {
        if (t.item!.startsWith("rotten:")) { removeThing(w, t); continue; }
        t.item = rot(t.item!); t.born = w.t; delete t.rot; mark(w, t);
      }
    }
    // a pile's pieces are of whatever the pile has become
    for (const s of t.pieces ?? []) if (t.kind === "item") s.k = t.item!;
    const kept = vessel(t.store ?? []), inside = t.store?.length ? airOn(w, t, true).temp : 0;
    for (const s of [...(t.store ?? [])]) {
      if (!spoiled(s, inside, kept)) continue;
      if (s.k.startsWith("rotten:")) { t.store!.splice(t.store!.indexOf(s), 1); continue; }
      s.k = rot(s.k); s.born = w.t; delete s.rot;
    }
    // A shelter stands until a wind blows that breaks its rafters, and a heap until one moves its lightest piece
    // (shelter.ts); snow on a roof is left out [gap].
    if (t.kind === "structure" && t.shelter && airAt(w, t.px, t.py).wind > t.shelter.wind) fallApart(w, t);
  }
}
// A shelter fallen apart in the weather: half of each thing it was built of falls where it stood, its pieces of wood as
// they were laid, and nobody lives there any more.
export function fallApart(w: World, t: Thing) {
  const owner = w.agents.find((a) => a.id === t.owner);
  log(w, "ruin", owner ? [owner.id] : [], t, `${owner ? `${owner.name}'s` : "A"} shelter fell apart in the weather.`);
  for (const [k, n] of Object.entries(t.parts ?? {})) {
    if (Math.random() >= 0.5) continue;
    const m = Math.ceil(n / 2), laid = (t.pieces ?? []).filter((s) => s.k === k).slice(0, m);
    dropStacks(w, t.px, t.py, [...laid, ...Array.from({ length: m - laid.length }, () => ({ k, hp: 1, born: w.t }))]);
  }
  for (const x of residentsOf(w, t)) x.home = null;
  removeThing(w, t);
}

// ---------- sickness ----------
// A sickness takes 0.06 of health and adds 0.0005 to the want of sleep each 300 s at its severity, and passes to
// someone within 10 m with a chance of 0.003 each 300 s at its severity [design: today's per-tick values], over the
// senses lane's dt seconds.
function disease(w: World, dt: number) {
  for (const a of w.agents) {
    const s = a.sickness;
    if (!s) continue;
    a.needs.health = Math.max(0, a.needs.health - rate(0.06 * s.severity, 300, dt));
    a.hurt = "sickness";
    // and wears them out, adding to their want of sleep (body.ts) [design]
    const b = bodyOf(w, a);
    b.sleep = Math.min(1, b.sleep + rate(0.0005 * s.severity, 300, dt));
    if (w.t >= s.until) {
      a.sickness = null;
      log(w, "recover", [a.id], a, `${a.name} got over their sickness.`);
      continue;
    }
    for (const b of w.agents) {
      if (b === a || b.sickness || meters(a, b) > 10 || Math.random() > chance(0.003 * s.severity, 300, dt)) continue;
      b.sickness = { until: w.t + Math.round(DAY * (0.5 + s.severity)), severity: s.severity * 0.8 };
      log(w, "sick", [b.id, a.id], b, `${b.name} caught ${a.name}'s sickness.`);
      see(w, b, "contagion", "Sickness spreads between people who stay close.", personSize(w, b));
    }
  }
}

// ---------- paths ----------
// Feet wear a path where they pass often: a chance with every forty meters walked.
export function trample(w: World, at: { x: number; y: number }, walked: number) {
  const i = at.y * W + at.x;
  if (w.paths[i] < 9 && Math.random() < 0.06 * (walked / 40)) { w.paths[i]++; pathChanges.add(i); }
}
function paths(w: World) {
  if (w.t % DAY) return;
  for (let i = 0; i < w.paths.length; i++) if (w.paths[i] && Math.random() < 0.3) { w.paths[i]--; pathChanges.add(i); }
}

// Wear where feet actually fall, on cells of about 3 m, for drawing trails that follow the way people really walk. The
// 150 m tile wear above is what the game's rules read; this is kept beside the world, not saved with it. Only worn cells
// are held, by their row-major index across the island's n x n cells.
export const TRAIL_CELL = 3;
export const trailChanges = new Set<number>();
type Trails = { cell: number; n: number; wear: Map<number, number> };
const trailsOf = new WeakMap<World, Trails>();
export function trails(w: World): Trails {
  let t = trailsOf.get(w);
  if (!t) { t = { cell: TRAIL_CELL, n: Math.round((W * TILE_M) / TRAIL_CELL), wear: new Map() }; trailsOf.set(w, t); }
  return t;
}
// Wear every cell crossed walking from one point to another (in tiles), once each.
export function tread(w: World, x0: number, y0: number, x1: number, y1: number) {
  const t = trails(w), k = TILE_M / TRAIL_CELL, steps = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) * k * 2));
  let last = -1;
  for (let s = 1; s <= steps; s++) {
    const cx = Math.floor((x0 + ((x1 - x0) * s) / steps) * k), cy = Math.floor((y0 + ((y1 - y0) * s) / steps) * k), i = cy * t.n + cx;
    if (i === last || cx < 0 || cy < 0 || cx >= t.n || cy >= t.n) continue;
    last = i;
    const v = t.wear.get(i) ?? 0;
    if (v < 255) { t.wear.set(i, v + 1); trailChanges.add(i); }
  }
}
// Trails grow over: once a day each worn cell loses a tenth of its wear, and at least one.
function overgrow(w: World) {
  if (w.t % DAY) return;
  const t = trails(w);
  for (const [i, v] of t.wear) {
    const left = Math.max(0, v - Math.max(1, Math.floor(v / 10)));
    if (left) t.wear.set(i, left); else t.wear.delete(i);
    trailChanges.add(i);
  }
}

// A tick of the world's own processes, each on its lane (lanes.ts) in the order they have always run: fire's looks owed,
// the animals (their sighting on the senses lane, the ones in sight each tick), hot things cooling and sickness on the
// senses lane, and the hourly and daily ones on their own clocks.
export function ecology(w: World) {
  attacked.clear();
  // the stems as the GPU last grew them, on the ground being looked at
  grownOn(w);
  timed("weather", () => weather(w));
  // The live set as it stands, less anything an earlier step burned, ate or took away (leaving the world takes a thing out
  // of it: space.ts leave).
  const live = () => [...liveThings(w)], senses = due(w.t, SENSES_S);
  if (due(w.t, FIRE_S)) timed("fire", () => fire(w, live()));
  timed("plants", () => plants(w, live()));
  timed("holes", () => holes(w, live()));
  timed("animals", () => animals(w));
  if (senses) timed("cool", () => cool(w, live(), secs(SENSES_S)));
  timed("decay", () => decay(w, live()));
  timed("disease", () => { if (senses) disease(w, secs(SENSES_S)); crowding(w); });
  paths(w);
  overgrow(w);
  settle(w);
}
