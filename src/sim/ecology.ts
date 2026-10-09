// The world keeps moving on its own: weather, fire, plants, animals, rot, and sickness.
import { ensure, p } from "./materials";
import { ablaze, bedAir, dropPile, dropStacks, mark, nearFire, newKinds, occupied, redHot, removeThing, residentsOf, shelterName } from "./physics";
import { advance, alight, expose, output, type Air, type Group } from "./combustion";
import { physOf } from "./fuel";
import { BURNABLE, WIDEST, airFor, bedOf, blazeOf, fluxOn, landing, landsOn, partsOf, reach, struck, tinderIn, together, warmed, type Part } from "./spread";
import { see } from "./beliefs";
import {
  DAY, H, TILE_M, W, Tile, addThing, dayOfYear, groundOf, log, meters, nearWater, sea, seasonOf, tileAt, dryAt, dryNear, wetAt,
  type Agent, type Thing, type World,
} from "./world";
import { anyAround, anyOf, around, exists, liveThings, onPath, put, setKind, stockedAt } from "./space";
import { FAUNA } from "./fauna";
import { animals, attacked } from "./animals";
import { enrich, feedRate, settle, soilWaterAt } from "./soil";
import { SIZE, rockAt } from "../terrain/flora";
import { fitHere, growth, growthOf, pickHere } from "./plants";
import { ripening, warmRate } from "./cues";
import { streamNow } from "./streams";
import { WIND, airAt, baseTemp, islandTemp, seasonAt } from "./air";
import { growRate } from "./light";
import { nicheOf, seedlingHour, shareAt, treeOf, type Hour } from "./seedling";
import { SEASONS } from "../terrain/climate";
import { count, timed, trace } from "./trace";
import { hooks } from "./rules";
import { wetness } from "./wetness";

// Seconds a tick lasts (world.ts DAY: five minutes each).
const TICK_S = 86400 / DAY;

export const pathChanges = new Set<number>();
export const iceChanged = { now: false };
// Homes destroyed by fire this tick, for the social layer: [owner, whoseFire, text].
export const burnedHomes: { owner: string; by?: string; text: string }[] = [];

const rainy = (sky: World["weather"]["sky"]) => sky === "rain" || sky === "storm";

// ---------- weather and seasons ----------
// The time of year's share of the year's storms, drawn between the seasons' as the air is.
const stormShare = (t: number) => { const { s, f } = seasonAt(t); return SEASONS[s].wet * (1 - f) + SEASONS[(s + 1) % 4].wet * f; };
// The sky an hour on (r: a draw): cloud turns to rain as often as the time of year brings its share of the year's storms
// (climate.ts SEASONS), and rain to storm the more often the warmer the air (temp), which feeds the thunderheads.
export function nextSky(sky: World["weather"]["sky"], r: number, t: number, temp: number): World["weather"]["sky"] {
  if (sky === "clear") return r < 0.25 ? "cloudy" : "clear";
  if (sky === "cloudy") return r < stormShare(t) * 1.1 ? "rain" : r < 0.4 ? "clear" : "cloudy";
  if (sky === "rain") return r < 0.25 ? "cloudy" : r < 0.27 + 0.06 * warmRate(temp) ? "storm" : "rain";
  return r < 0.35 ? "rain" : "storm";
}
// The wind over the open sea an hour on (r: a draw), settling toward what the sky brings.
export const nextSpeed = (speed: number, sky: World["weather"]["sky"], r: number) => Math.max(0.5, speed + (WIND[sky] - speed) * 0.25 + (r - 0.5) * 2);
// Rain runs off into the streams and drains away over a day or so (Weather.wet), an hour on under this sky.
export const nextWet = (wet: number, sky: World["weather"]["sky"]) => (rainy(sky) ? wet + (sky === "storm" ? 0.15 : 0.06) * (1 - wet) : wet * 0.97);
// The island's weather at the next n turns of the sky after now, from how it stands, drawn with r (a seeded draw of the
// caller's own, so nothing here moves the world's): what the coming days might bring (seedling.ts seedlingFate).
export function forecast(w: World, n: number, r: () => number): Hour[] {
  let { sky, speed, wet } = w.weather, t = Math.ceil((w.t + 1) / 12) * 12;
  const out: Hour[] = [];
  for (let i = 0; i < n; i++, t += 12) {
    sky = nextSky(sky, r(), t, islandTemp(t - 1, sky));
    speed = nextSpeed(speed, sky, r());
    wet = nextWet(wet, sky);
    out.push({ sky, speed, wet });
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
  wx.year = Math.floor(w.t / DAY / 40) + 1;
  if (w.t % 12 === 0) {
    const before = wx.sky;
    wx.sky = nextSky(wx.sky, Math.random(), w.t, wx.temp);
    // The wind wanders, but keeps coming back to blow the way it prevails, the way that laid the island's rain.
    const [px, py] = w.terrain.wind, pull = (v: number, p: number) => clamp(v + (p * 0.5 - v) * 0.02 + (Math.random() - 0.5) * 0.3, -1, 1);
    wx.wind = { dx: pull(wx.wind.dx, px), dy: pull(wx.wind.dy, py) };
    wx.speed = nextSpeed(wx.speed, wx.sky, Math.random());
    // a probe's own weather, set as the sky turns (rules.ts hooks), so the runoff, the air and how wet things get follow
    // from it as from the island's own
    hooks.weather?.(w);
    wx.wet = nextWet(wx.wet, wx.sky);
    if (wx.sky !== before) {
      const words = { clear: "The sky cleared.", cloudy: "Clouds rolled in.", rain: "It started to rain.", storm: "A storm broke." };
      log(w, "weather", [], { x: W / 2, y: H / 2 }, words[wx.sky]);
      trace("weather", "sky", { from: before, to: wx.sky, season });
    }
  }
  wx.temp = islandTemp(w.t, wx.sky);
  wx.dryTicks = rainy(wx.sky) ? 0 : wx.dryTicks + 1;
  wetness(w);
  if (w.t % 12 === 0) ice(w);
  // days without rain in warm weather dry everything out
  const drought = wx.dryTicks > DAY * 4 && baseTemp(w.t) > 14;
  if (drought && !wx.drought) log(w, "weather", [], { x: W / 2, y: H / 2 }, "It hasn't rained in days. Everything is bone dry.");
  wx.drought = drought;
  if (wx.sky === "storm" && Math.random() < 1 / 150) {
    const t = anyOf(w, "tree");
    if (t && !t.bed) {
      // the strike lights the tree's dead twigs if they're dry enough to carry a flame (spread.ts struck)
      const bed = struck(w, t);
      if (bed) {
        t.bed = bed;
        delete t.absorbed;
        log(w, "lightning", [], t, "Lightning struck a tree and set it burning.");
        see(w, t, "lightning", "Lightning can set a tree on fire, and fire eats wood.", 1000);
      } else log(w, "lightning", [], t, "Lightning struck a tree.");
      mark(w, t);
    }
  }
}
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

// ---------- ice ----------
// Hard frost freezes the shallows of the lakes, then further out; salt water holds out. A thaw drops everyone
// standing on the ice into the water.
function ice(w: World) {
  const t = w.weather.temp;
  if (t < -2) {
    const frozen = new Set(w.ice), salt = sea(w);
    let grew = false;
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        if (frozen.has(i) || salt[i] || tileAt(w, x, y) !== Tile.Water) continue;
        const edge = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => { const nx = x + dx, ny = y + dy; return (tileAt(w, nx, ny) !== Tile.Water && nx >= 0 && ny >= 0 && nx < W && ny < H) || frozen.has(ny * W + nx); });
        if (edge && Math.random() < 0.25) { w.ice.push(i); grew = true; }
      }
    if (grew) iceChanged.now = true;
    if (grew && w.ice.length < 40) log(w, "weather", [], { x: W / 2, y: H / 2 }, "The water's edge froze over.");
  } else if (t > 1 && w.ice.length) {
    for (const a of w.agents) {
      if (!wetAt(w, a.px, a.py)) continue;
      a.needs.health = Math.max(0, a.needs.health - 25);
      a.needs.warmth = Math.max(0, a.needs.warmth - 50);
      log(w, "hazard", [a.id], a, `The ice gave way under ${a.name}. They crawled out soaked and freezing.`);
      see(w, a, "thin_ice", "Ice melts when it warms up. Don't be standing on it.", 80);
      // They crawl out to the nearest dry ground once the ice is gone.
      const out = dryNear({ ...w, ice: [] }, a.px, a.py);
      if (out) put(w, a, ...out);
    }
    for (const an of w.animals) if (FAUNA[an.species].ground && wetAt(w, an.px, an.py)) an.hp = 0;
    w.ice = [];
    iceChanged.now = true;
    log(w, "weather", [], { x: W / 2, y: H / 2 }, "The ice broke up and melted.");
  }
}

// ---------- pits, traps, wells ----------
function holes(w: World, live: Thing[]) {
  for (const t of live) {
    if (t.kind === "pit" && nearWater(w, t.x, t.y, 2) && w.t - (t.born ?? w.t) > DAY) {
      setKind(w, t, "well"); mark(w, t);
      log(w, "dig", t.owner ? [t.owner] : [], t, "Water seeped into a pit near the shore and filled it. A well.");
      see(w, t, "well", "A pit dug near water fills up with water.", 80);
    }
    if (t.kind === "trap" && t.caught && w.t - (t.until ?? w.t) > DAY / 2) {
      const an = w.animals.find((m) => m.state === "trapped" && meters(m, t) <= 1);
      if (an) an.state = "wander";
      delete t.caught; setKind(w, t, "pit"); mark(w, t);
      log(w, "trap", t.owner ? [t.owner] : [], t, "Something broke out of a trap and got away.");
    }
  }
}
// A hidden pit catches people too, unless they know it's there.
export function trapped(w: World, a: Agent, x0: number, y0: number) {
  const trap = onPath(w, x0, y0, a.px, a.py, 0.8, ["trap"], (t) => t.owner !== a.id && !t.caught && !a.facts[`trap:${t.id}`]);
  if (!trap) return false;
  setKind(w, trap, "pit"); mark(w, trap);
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
  if (t.kind === "tree") { setKind(w, t, "burnt_stump"); t.hp = 30; t.maxHp = 30; t.size = 0.6; t.until = w.t + DAY * 10; mark(w, t); enrich(w, t.px, t.py, 0.25); return; }
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
    mark(w, addThing(w, "ash", t.px, t.py, { born: w.t, until: w.t + DAY * 2, size: Math.min(3, t.kind === "bush" ? t.size : 1.2) }));
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
function caught(w: World, x: Thing, h: Warm, by: Thing) {
  x.bed = bedOf(h.parts, h.groups);
  delete x.absorbed;
  const who = by.owner ?? by.burnedBy;
  if (who) x.burnedBy = who;
  mark(w, x);
  count("fire.spread");
  trace("fire", "spread", { from: by.id, to: x.id, kind: x.kind });
  if (x.kind === "structure") log(w, "fire_spread", [x.owner ?? ""].filter(Boolean), x, "Fire caught on a shelter!");
  else if (Math.random() < 0.1) log(w, "fire_spread", [], x, `Fire spread to a ${x.kind.replace("_", " ")}.`);
}
// A thing near a fire: its parts as fuel, each part's heat toward lighting, and the air each takes it in.
type Warm = { parts: Part[]; groups: Group[]; air: Air[] };
// Every bed, a campfire's or a burning thing's own, burns on through the tick in the air where it stands (combustion.ts),
// looked at as often as a bed steps, every ten seconds (fire-constants sec. 28). At each look what stands within a burning
// bed's reach takes its flame's heat or its radiation, and its brands where they land (spread.ts); a part that lights
// makes the thing a bed of its own from then on, and whatever nothing heats any more cools. A bed gone out is a campfire
// gone, or a thing burnt out. A fire heaped over with stone keeps its flames, its heat and its brands under the stone.
const LOOK = 10;
export function fire(w: World, live: Thing[]) {
  // each burning bed, how far it has looked for what it might heat and for what its brands might land on, and what it found
  const beds = new Map<Thing, { heat: number; brands: number; close: Thing[]; far: Thing[] }>(), warm = new Map<Thing, Warm>();
  const burning = (t: Thing) => beds.set(t, { heat: -1, brands: -1, close: [], far: [] });
  const heated = (x: Thing) => {
    let h = warm.get(x);
    if (!h) {
      const parts = partsOf(w, x);
      warm.set(x, (h = { parts, groups: warmed(x, parts), air: parts.map((p) => airFor(w, x, p)) }));
    }
    return h;
  };
  const light = (x: Thing, h: Warm, by: Thing) => {
    caught(w, x, h, by);
    warm.delete(x);
    burning(x);
  };
  for (const t of live) {
    if (t.bed) burning(t);
    else if (t.kind === "fire") fireOut(w, t);
    else if (t.absorbed) heated(t);
  }
  for (let s = 0; s < TICK_S; s += LOOK) {
    // what things near a burning bed take over this look, from each bed as it stands at the look's start: the flux on
    // each part and the bed giving the most of it; the brands landing, and the bed landing the most
    const hot = new Map<Thing, { f: number[]; by: Thing; most: number }>(), landed = new Map<Thing, { n: number; from: Thing; most: number }>();
    for (const [t, src] of beds) {
      const air = bedAir(w, t);
      if (alight(t.bed!) && !t.covered) {
        const b = blazeOf(w, t, output(t.bed!, air), air), r = reach(b);
        if (r.heat > src.heat) {
          [src.heat, src.close] = [r.heat, []];
          around(w, t.px, t.py, r.heat + WIDEST, BURNABLE, (x) => { if (x !== t) src.close.push(x); });
        }
        if (r.brands > src.brands) {
          [src.brands, src.far] = [r.brands, []];
          around(w, t.px, t.py, r.brands + WIDEST, BURNABLE, (x) => { if (x !== t && landsOn(x)) src.far.push(x); });
        }
        for (const x of src.close) {
          if (x.bed || !exists(w, x)) continue;
          const f = fluxOn(b, x, heated(x).parts), sum = f.reduce((u, v) => u + v, 0), had = hot.get(x);
          if (!had) hot.set(x, { f, by: t, most: sum });
          else {
            had.f = had.f.map((v, i) => v + f[i]);
            if (sum > had.most) Object.assign(had, { by: t, most: sum });
          }
        }
        for (const x of src.far) {
          const n = x.bed ? 0 : landing(b, x, LOOK), had = landed.get(x);
          if (n <= 0) continue;
          if (!had) landed.set(x, { n, from: t, most: n });
          else Object.assign(had, { n: had.n + n }, n > had.most ? { from: t, most: n } : {});
        }
      }
      t.bed = advance(t.bed!, LOOK, air);
      if (alight(t.bed)) continue;
      beds.delete(t);
      if (t.kind === "fire") fireOut(w, t);
      else burnOut(w, t, t.burnedBy);
    }
    for (const [x, h] of warm) {
      if (x.bed || !exists(w, x)) { warm.delete(x); continue; }
      const on = hot.get(x);
      h.groups = h.groups.map((g, i) => expose(g, on?.f[i] ?? 0, LOOK, h.air[i]));
      if (on && h.groups.some((g) => g.lit)) light(x, h, on.by);
    }
    // brands landing together light the driest fine fuel they land in by the NFDRS's odds (spread.ts)
    for (const [x, l] of landed) {
      if (x.bed || !exists(w, x) || Math.random() >= together(l.n)) continue;
      const h = heated(x), tinder = tinderIn(w, x, h.parts);
      if (tinder.i < 0 || Math.random() >= tinder.odds) continue;
      h.groups[tinder.i].lit = true;
      light(x, h, l.from);
    }
  }
  // what's still warm keeps the heat it has taken, and what has cooled right down is as it was
  for (const [x, h] of warm) {
    const heat = h.groups.map((g) => g.heat);
    if (heat.some((v) => v > 0)) { x.absorbed = heat; mark(w, x); }
    else if (x.absorbed) { delete x.absorbed; mark(w, x); }
  }
  for (const t of beds.keys()) mark(w, t);
}

// ---------- plants ----------
// Nothing here asks the season or what a tile is called. Plants grow by the air's warmth, the soil's water, the light and
// the soil's nourishment where they stand (plants.ts growth); seed falls where it fits (niche.ts) and takes root as it
// fits; trees ripen their nuts as the days draw in (cues.ts).
const BERRY_HP = 20;
function plants(w: World, live: Thing[]) {
  const warm = warmRate(w.weather.temp);
  for (const t of live) {
    if (ablaze(t)) continue;
    if (t.scarred && (t.kind === "tree" || t.kind === "stump") && (t.resin ?? 0) < 2 && w.t - t.scarred > DAY && Math.random() < 1 / (DAY * 1.5)) {
      t.resin = (t.resin ?? 0) + 1;
      mark(w, t);
    }
    if (t.kind === "bush") {
      if (t.species === "berry" && (t.n ?? 0) < 4 && Math.random() < 1 / 70 && Math.random() < growth(w, t.px, t.py)) { t.n = (t.n ?? 0) + 1; mark(w, t); }
      if ((t.hp ?? BERRY_HP) < (t.maxHp ?? BERRY_HP)) t.hp = Math.min(t.maxHp ?? BERRY_HP, (t.hp ?? BERRY_HP) + 0.02);
      if ((t.hp ?? BERRY_HP) <= 0) { setKind(w, t, "dead_bush"); t.n = 0; mark(w, t); log(w, "grow", [], t, "A berry bush was picked to death."); }
    } else if (t.kind === "dead_bush" && Math.random() < 1 / 4000 && Math.random() < growth(w, t.px, t.py)) {
      setKind(w, t, "bush"); t.species = "berry"; t.n = 0; t.hp = BERRY_HP; t.maxHp = BERRY_HP; mark(w, t);
    } else if (t.kind === "sapling") {
      // tended once an hour as the sky turns (seedling.ts), by the spot's fit as it was the first time and the share of
      // it the plants round it leave it now
      if (w.t % 12) continue;
      t.fit ??= fitHere(w, nicheOf(t), t.px, t.py);
      if (t.share === undefined || stockedAt(w, t.px, t.py)) t.share = shareAt(w, t.px, t.py, t.stage ?? 0, t);
      const was = t.stage ?? 0, soil = soilWaterAt(w, t.px, t.py);
      const fate = seedlingHour(t, t.fit, t.share, soil, growthOf(airAt(w, t.px, t.py).temp, soil, growRate(w, t.px, t.py), feedRate(w, t.px, t.py)), treeOf(t));
      if (fate === "withered") { wither(w, t); continue; }
      if (Math.round((t.stage ?? 0) * 20) !== Math.round(was * 20)) { t.size = Math.round((0.3 + (t.stage ?? 0) * 0.5) * 100) / 100; mark(w, t); }
      if (fate === "up") matured(w, t);
    } else if ((t.kind === "stump" || t.kind === "burnt_stump") && t.until! <= w.t && warm > 0.3) {
      // A new stem comes up from the old roots.
      setKind(w, t, "tree"); t.size = 5; t.hp = 53; t.maxHp = 53; delete t.until; delete t.scarred; delete t.resin; delete t.bark; mark(w, t);
    } else if (t.kind === "ash" && t.until! <= w.t) removeThing(w, t);
  }
  // Trees drop nuts as the days draw in, a few a day over the island. They keep for weeks, if someone gathers and stores them.
  if (ripening(w.t) && Math.random() < 0.3) {
    const t = anyOf(w, "tree");
    if (t && !ablaze(t)) { const a = Math.random() * Math.PI * 2, d = (1 + Math.random() * 3) / TILE_M; dropPile(w, t.px + Math.cos(a) * d, t.py + Math.sin(a) * d, "nut", 1); }
  }
  // Birds carry berry seeds off, and trees shed theirs about them; what lands where it fits may take root.
  if (Math.random() < warm / 100) {
    const b = anyOf(w, "bush");
    if (b?.species === "berry") seedNear(w, b, "berry", 5, 45);
  }
  if (Math.random() < warm / 60) {
    const t = anyOf(w, "tree");
    if (t?.species && !ablaze(t)) seedNear(w, t, t.species, 4, 30);
  }
  if (Math.random() < 1 / 60 + (1 / 18 - 1 / 60) * warm) {
    const x = Math.floor(Math.random() * W), y = Math.floor(Math.random() * H), px = x + Math.random(), py = y + Math.random();
    if (!dryAt(w, px, py)) return;
    const { isle, fine } = groundOf(w.seed), mx = px * TILE_M - SIZE / 2, mz = py * TILE_M - SIZE / 2, r = Math.random();
    // Weather wears reddish stones out of bare ground over rock that carries iron, now and then.
    if (r > 0.94 && Math.random() < 2 * fine.fine(fine.cover.bare, mx, mz) * rockAt(isle, mx, mz).ore) { dropPile(w, px, py, "ore", 1); return; }
    // Reeds and clay at the water's edge while it is warm; under trees fungi, herbs and fallen sticks; elsewhere sticks and stones.
    const edge = [0, 1, 2, 3, 4, 5, 6, 7].some((k) => { const ex = px + (Math.cos((k * Math.PI) / 4) * 8) / TILE_M, ey = py + (Math.sin((k * Math.PI) / 4) * 8) / TILE_M; return wetAt(w, ex, ey) || !!streamNow(w, ex, ey)?.flowing; });
    const wooded = fine.fine(fine.cover.tree, mx, mz) > 0.45;
    const kind = edge && warm > 0.3 ? (r < 0.7 ? "reeds" : "clay") : wooded ? (warm < 0.3 ? (r < 0.2 ? "mushroom" : "stick") : r < 0.45 ? "mushroom" : r < 0.6 ? "herb" : "stick") : r < 0.5 ? "stick" : "stone";
    if (anyAround(w, px, py, 3, [kind])) return;
    const extra: Partial<Thing> = kind === "reeds" ? { hp: 6, maxHp: 6, size: 1 + Math.random() * 1.5 } : kind === "mushroom" ? { species: pickHere(w, FUNGI, px, py, Math.random()), hp: 2, maxHp: 2 } : kind === "herb" ? { species: pickHere(w, HERBS, px, py, Math.random()), hp: 3, maxHp: 3 } : kind === "stick" ? { hp: 8, maxHp: 8, size: 0.4 + Math.random() * 1.2 } : kind === "stone" ? { hp: 40, maxHp: 40 } : { hp: 10, maxHp: 10 };
    mark(w, addThing(w, kind, px, py, extra));
  }
}
const FUNGI = ["bolete", "chanterelle", "puffball"] as const, HERBS = ["yarrow", "sorrel", "mint"] as const;
// Seed of a species falling between near and far meters from a plant, taking root as the spot fits it, on any ground
// nothing stands on: whether it lives is up to the light, water and soil it finds there, other plants' share included.
function seedNear(w: World, t: Thing, species: string, near: number, far: number) {
  const a = Math.random() * Math.PI * 2, d = (near + Math.random() * (far - near)) / TILE_M, px = t.px + Math.cos(a) * d, py = t.py + Math.sin(a) * d;
  // Ground nobody has looked at since it grew stays as it grew: seed takes root, as a seedling the world keeps, only where
  // it's been looked at.
  if (!dryAt(w, px, py) || !stockedAt(w, px, py) || occupied(w, px, py)) return;
  const fit = fitHere(w, species, px, py);
  if (Math.random() > fit) return;
  mark(w, addThing(w, "sapling", px, py, species === "berry" ? { stage: 0, item: "berry", born: w.t, hp: 5, maxHp: 5, fit } : { stage: 0, species, born: w.t, hp: 5, maxHp: 5, fit }));
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
    if (from && t.owner) {
      log(w, "grow", [t.owner], t, `The ${w.kinds[from]?.name ?? from} ${w.agents.find((a) => a.id === t.owner)?.name} pushed into the ground grew into a young tree.`);
      see(w, t, `grows:${from}`, `A ${w.kinds[from]?.name ?? from} in the ground can grow into a tree.`, 80);
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
      see(w, t, "grows:grain", "Grain pushed into the ground comes up as grass that bears more grain.", 80);
    }
    grewFor(w, t, "grass");
    return;
  }
  setKind(w, t, "bush"); t.species = "berry"; t.n = 1; t.hp = BERRY_HP; t.maxHp = BERRY_HP; t.size = 0.9; delete t.stage;
  mark(w, t);
  log(w, "grow", t.owner ? [t.owner] : [], t, t.owner ? `The ${w.kinds[from]?.name ?? from} ${w.agents.find((a) => a.id === t.owner)?.name} pushed into the ground grew into a berry bush.` : "A new berry bush sprang up.");
  see(w, t, `grows:${from}`, `A ${w.kinds[from]?.name ?? from} in the ground can grow into a berry bush.`, 80);
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

// ---------- rot, wear, weathering ----------
function decay(w: World, live: Thing[]) {
  if (w.t % 12) return;
  const rot = (k: string) => {
    const [kind, isNew] = ensure(w.kinds, `rotten:${k}`, () => ({
      name: `rotten ${w.kinds[k]?.name ?? k}`, props: { edible: 0.05, toxic: 0.85, seed: p(w.kinds[k], "seed") }, parts: [k], shelf: 3,
    }));
    if (isNew) newKinds.add(kind.id);
    return kind.id;
  };
  // keep: how much longer than loose food keeps it does where it is: half as long again in with a pot, a basket or a bag
  const spoiled = (k: string, born: number, keep = 1) => {
    const kind = w.kinds[k];
    return !!kind?.shelf && w.t - born > kind.shelf * DAY * keep;
  };
  const vessel = (ks: { k: string }[]) => (ks.some((s) => p(w.kinds[s.k], "container") >= 0.6) ? 1.5 : 1);
  for (const a of w.agents) {
    const f = nearFire(w, a), keep = vessel(a.inv);
    for (const s of a.inv) {
      // Hot metal stays soft only while it's kept at a fire that holds it at red heat (fire-constants sec. 29g).
      const k = w.kinds[s.k], forge = !!k?.cools && redHot(w, f, physOf(w.kinds, k)?.d);
      if (k?.cools && k.parts?.[0]) { if (forge) s.born = w.t; else if (w.t - s.born > k.cools) { s.k = k.parts[0]; s.born = w.t; } continue; }
      if (!spoiled(s.k, s.born, keep)) continue;
      if (s.k.startsWith("rotten:")) { a.inv.splice(a.inv.indexOf(s), 1); continue; }
      log(w, "spoil", [a.id], a, `${a.name}'s ${w.kinds[s.k]?.name} went bad.`);
      s.k = rot(s.k); s.born = w.t;
    }
    if (a.wearing && (a.wearing.hp -= 0.006 * (1.3 - p(w.kinds[a.wearing.k], "toughness"))) <= 0) { log(w, "break", [a.id], a, `${a.name}'s ${w.kinds[a.wearing.k]?.name} wore through.`); a.wearing = null; }
  }
  for (const t of live) {
    const cools = t.kind === "item" && t.item ? w.kinds[t.item]?.cools : undefined;
    if (cools && w.t - (t.born ?? w.t) > cools) { t.item = w.kinds[t.item!].parts![0]; t.born = w.t; mark(w, t); }
    if (t.kind === "item" && t.item && spoiled(t.item, t.born ?? w.t)) {
      if (t.item.startsWith("rotten:")) { removeThing(w, t); continue; }
      t.item = rot(t.item); t.born = w.t; mark(w, t);
    }
    // a pile's pieces are of whatever the pile has become
    for (const s of t.pieces ?? []) if (t.kind === "item") s.k = t.item!;
    const kept = vessel(t.store ?? []);
    for (const s of t.store ?? []) {
      if (!spoiled(s.k, s.born, kept)) continue;
      if (s.k.startsWith("rotten:")) { t.store!.splice(t.store!.indexOf(s), 1); continue; }
      s.k = rot(s.k); s.born = w.t;
    }
    if (t.kind === "structure" && t.shelter) {
      const sky = w.weather.sky;
      // Loose piles that aren't ringing a fire scatter within a few days. Weather tells on a flimsy shelter far more than
      // a sturdy one: sticks and grass are down after a few days of rain, walls of stone or logs stand for a season.
      const pile = t.shelter.tier === 0 && !anyAround(w, t.px, t.py, 1, ["fire"]);
      const weather = 0.03 + (sky === "rain" ? 0.1 : sky === "storm" ? 0.5 : 0);
      t.hp = (t.hp ?? 100) - (pile ? 0.5 * (1.2 - t.shelter.sturdy) : 0) - weather * Math.max(0.02, 1.4 * (1 - t.shelter.sturdy) ** 2);
      if (t.hp <= 0) fallApart(w, t);
    }
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
function disease(w: World) {
  for (const a of w.agents) {
    const s = a.sickness;
    if (!s) continue;
    a.needs.health = Math.max(0, a.needs.health - 0.06 * s.severity);
    a.needs.energy = Math.max(0, a.needs.energy - 0.05 * s.severity);
    if (w.t >= s.until) {
      a.sickness = null;
      log(w, "recover", [a.id], a, `${a.name} got over their sickness.`);
      continue;
    }
    for (const b of w.agents) {
      if (b === a || b.sickness || meters(a, b) > 10 || Math.random() > 0.003 * s.severity) continue;
      b.sickness = { until: w.t + Math.round(DAY * (0.5 + s.severity)), severity: s.severity * 0.8 };
      log(w, "sick", [b.id, a.id], b, `${b.name} caught ${a.name}'s sickness.`);
      see(w, b, "contagion", "Sickness spreads between people who stay close.", 40);
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

export function ecology(w: World) {
  attacked.clear();
  timed("weather", () => weather(w));
  // The live set as it stands, less anything an earlier step burned, ate or took away (leaving the world takes a thing out
  // of it: space.ts leave).
  const live = () => [...liveThings(w)];
  timed("fire", () => fire(w, live()));
  timed("plants", () => plants(w, live()));
  timed("holes", () => holes(w, live()));
  timed("animals", () => animals(w));
  timed("decay", () => decay(w, live()));
  timed("disease", () => { disease(w); crowding(w); });
  paths(w);
  overgrow(w);
  settle(w);
}
