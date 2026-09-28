// The world keeps moving on its own: weather, fire, plants, animals, rot, and sickness.
import { THING_MATERIAL, clamp01, ensure, p } from "./materials";
import { dropPile, fireHeat, mark, nearFire, newKinds, removeThing } from "./physics";
import { see } from "./beliefs";
import {
  DAY, H, TILE_M, W, Tile, addThing, dayOfYear, log, meters, nearWater, sea, seasonOf, tileAt, walkable,
  type Agent, type Thing, type World,
} from "./world";
import { anyAround, anyOf, around, exists, liveThings, onPath, put, setKind } from "./space";
import { FAUNA } from "./fauna";
import { animals, attacked } from "./animals";
import { count, timed, trace } from "./trace";

export const pathChanges = new Set<number>();
export const iceChanged = { now: false };
// Homes destroyed by fire this tick, for the social layer: [owner, whoseFire, text].
export const burnedHomes: { owner: string; by?: string; text: string }[] = [];

const rainy = (w: World) => w.weather.sky === "rain" || w.weather.sky === "storm";

// ---------- weather and seasons ----------
const RAIN_START: Record<string, number> = { spring: 0.14, summer: 0.05, autumn: 0.2, winter: 0.12 };
const BASE_TEMP: Record<string, number> = { spring: 12, summer: 24, autumn: 10, winter: -4 };
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
    const r = Math.random();
    if (wx.sky === "clear") wx.sky = r < 0.25 ? "cloudy" : "clear";
    else if (wx.sky === "cloudy") wx.sky = r < RAIN_START[season] * 2 ? "rain" : r < 0.4 ? "clear" : "cloudy";
    else if (wx.sky === "rain") wx.sky = r < 0.25 ? "cloudy" : r < (season === "summer" || season === "autumn" ? 0.33 : 0.28) ? "storm" : "rain";
    else wx.sky = r < 0.35 ? "rain" : "storm";
    // The wind wanders, but keeps coming back to blow the way it prevails, the way that laid the island's rain.
    const [px, py] = w.terrain.wind, pull = (v: number, p: number) => clamp(v + (p * 0.5 - v) * 0.02 + (Math.random() - 0.5) * 0.3, -1, 1);
    wx.wind = { dx: pull(wx.wind.dx, px), dy: pull(wx.wind.dy, py) };
    if (wx.sky !== before) {
      const words = { clear: "The sky cleared.", cloudy: "Clouds rolled in.", rain: "It started to rain.", storm: "A storm broke." };
      log(w, "weather", [], { x: W / 2, y: H / 2 }, words[wx.sky]);
      trace("weather", "sky", { from: before, to: wx.sky, season });
    }
  }
  const hour = ((w.t % DAY) / DAY) * 24;
  wx.temp = BASE_TEMP[season] + Math.sin(((hour - 9) / 24) * Math.PI * 2) * 5 - (wx.sky === "cloudy" ? 2 : rainy(w) ? 4 : 0);
  wx.dryTicks = rainy(w) ? 0 : wx.dryTicks + 1;
  if (w.t % 12 === 0) ice(w);
  const drought = season === "summer" && wx.dryTicks > DAY * 4;
  if (drought && !wx.drought) log(w, "weather", [], { x: W / 2, y: H / 2 }, "It hasn't rained in days. Everything is bone dry.");
  wx.drought = drought;
  if (wx.sky === "storm" && Math.random() < 1 / 150) {
    const t = anyOf(w, "tree");
    if (t) {
      t.burning = 0.6;
      mark(w, t);
      log(w, "lightning", [], t, "Lightning struck a tree and set it burning.");
      see(w, t, "lightning", "Lightning can set a tree on fire, and fire eats wood.", 1000);
    }
  }
}
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

// ---------- ice ----------
// Hard frost freezes the shallows of the lakes, then further out; salt water holds out. A thaw drops everyone
// standing on the ice into the water.
function ice(w: World) {
  const t = w.weather.temp;
  if (t < -2 && w.weather.season === "winter") {
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
      if (tileAt(w, a.x, a.y) !== Tile.Water) continue;
      a.needs.health = Math.max(0, a.needs.health - 25);
      a.needs.warmth = Math.max(0, a.needs.warmth - 50);
      log(w, "hazard", [a.id], a, `The ice gave way under ${a.name}. They crawled out soaked and freezing.`);
      see(w, a, "thin_ice", "Ice melts when it warms up. Don't be standing on it.", 80);
      for (let r = 1; r < 10; r++) {
        const spot = [[r, 0], [-r, 0], [0, r], [0, -r]].find(([dx, dy]) => tileAt(w, a.x + dx, a.y + dy) !== Tile.Water);
        if (spot) { put(w, a, a.x + spot[0] + 0.5, a.y + spot[1] + 0.5); break; }
      }
    }
    for (const an of w.animals) if (FAUNA[an.species].ground && tileAt(w, an.x, an.y) === Tile.Water) an.hp = 0;
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
function dryness(w: World) {
  const wx = w.weather;
  if (wx.sky === "storm") return 0.03;
  if (wx.sky === "rain") return 0.05;
  return wx.drought ? 1.6 : wx.season === "summer" ? 1.1 : wx.season === "winter" ? 0.4 : 0.8;
}
export function flammability(w: World, t: Thing) {
  if (t.kind === "structure") return t.shelter?.flam ?? 0.5;
  if (t.kind === "item") return p(w.kinds[t.item ?? ""], "flammable");
  if (t.kind === "sapling" || t.kind === "herb" || t.kind === "mushroom" || t.kind === "flowers") return 0.3;
  if (t.kind === "stick") return 0.7;
  if (t.kind === "fern") return 0.6;
  if (t.kind === "grass") return 0.5;
  return THING_MATERIAL[t.kind]?.flammable ?? 0;
}
function burnOut(w: World, t: Thing, by?: string) {
  if (t.kind === "tree") { setKind(w, t, "burnt_stump"); t.burning = 0; t.hp = 30; t.maxHp = 30; t.size = 0.6; t.until = w.t + DAY * 10; mark(w, t); return; }
  if (t.kind === "structure") {
    const owner = w.agents.find((a) => a.id === t.owner);
    const text = `Fire burned down ${owner ? `${owner.name}'s` : "a"} ${["pile", "lean-to", "hut", "cabin"][t.shelter?.tier ?? 0]}.`;
    log(w, "burned", [owner?.id, by].filter(Boolean) as string[], t, text, owner ? `${owner.name}'s home burned` : "a home burned");
    if (owner) { burnedHomes.push({ owner: owner.id, by, text }); if (owner.home === t.id) owner.home = null; }
  }
  removeThing(w, t);
  if (t.kind !== "item" && t.kind !== "stick" && t.size >= 0.4) mark(w, addThing(w, "ash", t.px, t.py, { born: w.t, until: w.t + DAY * 2, size: Math.min(3, t.kind === "bush" ? t.size : 1.2) }));
}
// Flames reach what's within a few meters, and twice as far downwind.
const NEAR = 5, DOWNWIND = 10;
function fire(w: World, live: Thing[]) {
  const dry = dryness(w);
  const sources: { t: Thing; heat: number; by?: string }[] = [];
  for (const t of live) {
    if (t.kind === "fire") {
      const burn = t.covered ? 0.3 : t.contained ? 0.5 : 1;
      t.hp = (t.hp ?? 0) - burn - (rainy(w) && !t.contained ? 2 : 0);
      if (t.charcoal) t.charcoal = Math.max(0, t.charcoal - burn);
      const h = fireHeat(w, t);
      if (h !== (t.heat ?? 1)) { t.heat = h; mark(w, t); }
      if (t.hp <= 0) {
        removeThing(w, t);
        log(w, "fire_out", t.owner ? [t.owner] : [], t, rainy(w) ? "The rain put out a campfire." : "A campfire burned out.");
        continue;
      }
      if (!t.contained) sources.push({ t, heat: Math.min(1, (t.hp ?? 0) / 150) * 0.6, by: t.owner });
    } else if (t.burning) {
      t.burning = clamp01(t.burning + (rainy(w) ? -0.08 : 0.05));
      t.hp = (t.hp ?? THING_MATERIAL[t.kind]?.hp ?? 10) - 2 * t.burning;
      mark(w, t);
      if (t.burning <= 0) { t.burning = 0; continue; }
      if (t.hp <= 0) { burnOut(w, t, t.burnedBy); continue; }
      sources.push({ t, heat: t.burning, by: t.burnedBy });
    }
  }
  const { dx: wdx, dy: wdy } = w.weather.wind;
  for (const s of sources) {
    around(w, s.t.px, s.t.py, DOWNWIND, null, (t, d) => {
      if (t === s.t || t.burning || t.kind === "fire" || d < 1e-6) return;
      const along = (((t.px - s.t.px) * wdx + (t.py - s.t.py) * wdy) * TILE_M) / d;
      const far = d > NEAR, downwind = along > 0.3;
      if (far && !downwind) return;
      const flam = flammability(w, t);
      if (flam <= 0) return;
      const chance = s.heat * flam * dry * 0.02 * (downwind ? 2 : 1) * (far ? 0.4 : 1);
      if (Math.random() >= chance) return;
      t.burning = 0.3;
      t.burnedBy = s.by;
      mark(w, t);
      count("fire.spread");
      trace("fire", "spread", { from: s.t.id, to: t.id, kind: t.kind, chance });
      if (t.kind === "structure") log(w, "fire_spread", [t.owner ?? ""].filter(Boolean), t, "Fire caught on a shelter!");
      else if (Math.random() < 0.1) log(w, "fire_spread", [], t, `Fire spread to a ${t.kind.replace("_", " ")}.`);
    });
  }
}

// ---------- plants ----------
const BERRY_HP = 20;
function plants(w: World, live: Thing[]) {
  const season = w.weather.season;
  const growing = season !== "winter";
  for (const t of live) {
    if (t.burning) continue;
    if (t.scarred && (t.kind === "tree" || t.kind === "stump") && (t.resin ?? 0) < 2 && w.t - t.scarred > DAY && Math.random() < 1 / (DAY * 1.5)) {
      t.resin = (t.resin ?? 0) + 1;
      mark(w, t);
    }
    if (t.kind === "bush") {
      const regrow = season === "winter" ? 1 / 500 : season === "autumn" ? 1 / 140 : 1 / 70;
      if (t.species === "berry" && (t.n ?? 0) < 4 && Math.random() < regrow) { t.n = (t.n ?? 0) + 1; mark(w, t); }
      if ((t.hp ?? BERRY_HP) < (t.maxHp ?? BERRY_HP)) t.hp = Math.min(t.maxHp ?? BERRY_HP, (t.hp ?? BERRY_HP) + 0.02);
      if ((t.hp ?? BERRY_HP) <= 0) { setKind(w, t, "dead_bush"); t.n = 0; mark(w, t); log(w, "grow", [], t, "A berry bush was picked to death."); }
    } else if (t.kind === "dead_bush" && season === "spring" && Math.random() < 1 / 4000) {
      setKind(w, t, "bush"); t.species = "berry"; t.n = 0; t.hp = BERRY_HP; t.maxHp = BERRY_HP; mark(w, t);
    } else if (t.kind === "sapling" && growing) {
      t.stage = (t.stage ?? 0) + (1 / (3 * DAY)) * (nearWater(w, t.x, t.y, 1) ? 1.5 : 1);
      if (Math.round((t.stage ?? 0) * 20) !== Math.round(((t.stage ?? 0) - 1 / (3 * DAY)) * 20)) { t.size = Math.round((0.3 + t.stage * 0.5) * 100) / 100; mark(w, t); }
      if (t.stage >= 1) matured(w, t);
    } else if ((t.kind === "stump" || t.kind === "burnt_stump") && t.until! <= w.t && growing) {
      // A new stem comes up from the old roots.
      setKind(w, t, "tree"); t.size = 5; t.hp = 53; t.maxHp = 53; delete t.until; delete t.scarred; delete t.resin; delete t.bark; mark(w, t);
    } else if (t.kind === "ash" && t.until! <= w.t) removeThing(w, t);
  }
  // Trees drop nuts in autumn, a few a day over the island. They keep for weeks, if someone gathers and stores them.
  if (season === "autumn" && Math.random() < 0.3) {
    const t = anyOf(w, "tree");
    if (t && !t.burning) { const a = Math.random() * Math.PI * 2, d = (1 + Math.random() * 3) / TILE_M; dropPile(w, t.px + Math.cos(a) * d, t.py + Math.sin(a) * d, "nut", 1); }
  }
  // Birds carry berry seeds off and drop them in the open.
  if (growing && season !== "autumn" && Math.random() < 1 / 100) {
    const b = anyOf(w, "bush");
    if (b?.species === "berry") seedNear(w, b);
  }
  if (Math.random() < (growing ? 1 / 18 : 1 / 60)) {
    const x = Math.floor(Math.random() * W), y = Math.floor(Math.random() * H), px = x + Math.random(), py = y + Math.random();
    if (!walkable(w, x, y)) return;
    const forest = tileAt(w, x, y) === Tile.Forest, shore = nearWater(w, x, y, 1);
    const r = Math.random();
    // Weather wears reddish stones out of rocky ground now and then.
    if (tileAt(w, x, y) === Tile.Rock && r > 0.94) { dropPile(w, px, py, "ore", 1); return; }
    const kind = shore && growing ? (r < 0.7 ? "reeds" : "clay") : forest ? (!growing ? (r < 0.2 ? "mushroom" : "stick") : r < 0.45 ? "mushroom" : r < 0.6 ? "herb" : "stick") : r < 0.5 ? "stick" : "stone";
    if (anyAround(w, px, py, 3, [kind])) return;
    const extra: Partial<Thing> = kind === "reeds" ? { hp: 6, maxHp: 6, size: 1 + Math.random() * 1.5 } : kind === "mushroom" ? { species: "bolete", hp: 2, maxHp: 2 } : kind === "herb" ? { species: "yarrow", hp: 3, maxHp: 3 } : kind === "stick" ? { hp: 8, maxHp: 8, size: 0.4 + Math.random() * 1.2 } : kind === "stone" ? { hp: 40, maxHp: 40 } : { hp: 10, maxHp: 10 };
    mark(w, addThing(w, kind, px, py, extra));
  }
}
function seedNear(w: World, t: Thing) {
  const a = Math.random() * Math.PI * 2, d = (5 + Math.random() * 40) / TILE_M, px = t.px + Math.cos(a) * d, py = t.py + Math.sin(a) * d;
  if (tileAt(w, Math.floor(px), Math.floor(py)) !== Tile.Grass || anyAround(w, px, py, 2, ["tree", "bush", "sapling", "boulder", "structure", "dead_bush"])) return;
  mark(w, addThing(w, "sapling", px, py, { stage: 0, item: "berry", born: w.t, hp: 5, maxHp: 5 }));
}
function matured(w: World, t: Thing) {
  const from = t.item ?? "berry";
  setKind(w, t, "bush"); t.species = "berry"; t.n = 1; t.hp = BERRY_HP; t.maxHp = BERRY_HP; t.size = 0.9; delete t.stage;
  mark(w, t);
  log(w, "grow", t.owner ? [t.owner] : [], t, t.owner ? `The ${w.kinds[from]?.name ?? from} ${w.agents.find((a) => a.id === t.owner)?.name} pushed into the ground grew into a berry bush.` : "A new berry bush sprang up.");
  see(w, t, `grows:${from}`, `A ${w.kinds[from]?.name ?? from} in the ground can grow into a berry bush.`, 80);
  if (t.owner) grewFor(w, t.owner, from, t);
}
// The planter connects planting to the bush, whenever they see it.
export let grewFor: (w: World, owner: string, from: string, at: Thing) => void = () => {};
export const onGrew = (fn: typeof grewFor) => (grewFor = fn);

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
  const spoiled = (k: string, born: number) => {
    const kind = w.kinds[k];
    return !!kind?.shelf && w.t - born > kind.shelf * DAY;
  };
  for (const a of w.agents) {
    const f = nearFire(w, a);
    const forge = !!f && fireHeat(w, f) >= 1.5;
    for (const s of a.inv) {
      // Hot metal stays soft only while it's kept at a hot fire.
      const k = w.kinds[s.k];
      if (k?.cools && k.parts?.[0]) { if (forge) s.born = w.t; else if (w.t - s.born > k.cools) { s.k = k.parts[0]; s.born = w.t; } continue; }
      if (!spoiled(s.k, s.born)) continue;
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
    for (const s of t.store ?? []) {
      if (!spoiled(s.k, s.born)) continue;
      if (s.k.startsWith("rotten:")) { t.store!.splice(t.store!.indexOf(s), 1); continue; }
      s.k = rot(s.k); s.born = w.t;
    }
    if (t.kind === "structure" && t.shelter) {
      const sky = w.weather.sky;
      // Loose piles that aren't ringing a fire scatter within a few days.
      const pile = t.shelter.tier === 0 && !anyAround(w, t.px, t.py, 1, ["fire"]);
      t.hp = (t.hp ?? 100) - (0.03 + (pile ? 0.5 : 0) + (sky === "rain" ? 0.1 : sky === "storm" ? 0.5 : 0)) * (1.2 - t.shelter.sturdy);
      if (t.hp <= 0) {
        const owner = w.agents.find((a) => a.id === t.owner);
        log(w, "ruin", owner ? [owner.id] : [], t, `${owner ? `${owner.name}'s` : "A"} shelter fell apart in the weather.`);
        for (const [k, n] of Object.entries(t.parts ?? {})) if (Math.random() < 0.5) dropPile(w, t.px, t.py, k, Math.ceil(n / 2));
        if (owner?.home === t.id) owner.home = null;
        removeThing(w, t);
      }
    }
  }
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
// 150 m tile wear above is what the game's rules read; this is kept beside the world, not saved with it.
export const TRAIL_CELL = 3;
export const trailChanges = new Set<number>();
type Trails = { cell: number; n: number; wear: Uint8Array; worn: Set<number> };
const trailsOf = new WeakMap<World, Trails>();
export function trails(w: World): Trails {
  let t = trailsOf.get(w);
  if (!t) { const n = Math.round((W * TILE_M) / TRAIL_CELL); t = { cell: TRAIL_CELL, n, wear: new Uint8Array(n * n), worn: new Set() }; trailsOf.set(w, t); }
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
    if (t.wear[i] < 255) { t.wear[i]++; t.worn.add(i); trailChanges.add(i); }
  }
}
// Trails grow over: once a day each worn cell loses a tenth of its wear, and at least one.
function overgrow(w: World) {
  if (w.t % DAY) return;
  const t = trails(w);
  for (const i of t.worn) {
    t.wear[i] = Math.max(0, t.wear[i] - Math.max(1, Math.floor(t.wear[i] / 10)));
    trailChanges.add(i);
    if (!t.wear[i]) t.worn.delete(i);
  }
}

export function ecology(w: World) {
  attacked.clear();
  timed("weather", () => weather(w));
  // The live set as it stands, less anything an earlier step burned, ate or took away.
  const live = () => [...liveThings(w)].filter((t) => exists(w, t));
  timed("fire", () => fire(w, live()));
  timed("plants", () => plants(w, live()));
  timed("holes", () => holes(w, live()));
  timed("animals", () => animals(w));
  timed("decay", () => decay(w, live()));
  timed("disease", () => { disease(w); crowding(w); });
  paths(w);
  overgrow(w);
}
