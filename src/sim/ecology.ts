// The world keeps moving on its own: weather, fire, plants, animals, rot, and sickness.
import { THING_MATERIAL, clamp01, ensure, p } from "./materials";
import { changed, dropPile, newKinds, removeThing } from "./physics";
import { see } from "./beliefs";
import {
  DAY, H, W, Tile, addAnimal, addThing, dayOfYear, dist, isNight, log, nearWater, seasonOf, tileAt, walkable,
  type Agent, type Animal, type Thing, type World,
} from "./world";
import { count, timed, trace } from "./trace";

export const pathChanges = new Set<number>();
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
    wx.wind = { dx: clamp(wx.wind.dx + (Math.random() - 0.5) * 0.3, -1, 1), dy: clamp(wx.wind.dy + (Math.random() - 0.5) * 0.3, -1, 1) };
    if (wx.sky !== before) {
      const words = { clear: "The sky cleared.", cloudy: "Clouds rolled in.", rain: "It started to rain.", storm: "A storm broke." };
      log(w, "weather", [], { x: W / 2, y: H / 2 }, words[wx.sky]);
      trace("weather", "sky", { from: before, to: wx.sky, season });
    }
  }
  const hour = ((w.t % DAY) / DAY) * 24;
  wx.temp = BASE_TEMP[season] + Math.sin(((hour - 9) / 24) * Math.PI * 2) * 5 - (wx.sky === "cloudy" ? 2 : rainy(w) ? 4 : 0);
  wx.dryTicks = rainy(w) ? 0 : wx.dryTicks + 1;
  const drought = season === "summer" && wx.dryTicks > DAY * 4;
  if (drought && !wx.drought) log(w, "weather", [], { x: W / 2, y: H / 2 }, "It hasn't rained in days. Everything is bone dry.");
  wx.drought = drought;
  if (wx.sky === "storm" && Math.random() < 1 / 150) {
    const trees = w.things.filter((t) => t.kind === "tree");
    const t = trees[Math.floor(Math.random() * trees.length)];
    if (t) {
      t.burning = 0.6;
      changed.add(t.id);
      log(w, "lightning", [], t, "Lightning struck a tree and set it burning.");
      see(w, t, "lightning", "Lightning can set a tree on fire, and fire eats wood.", 10);
    }
  }
}
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

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
  if (t.kind === "sapling" || t.kind === "herb" || t.kind === "mushroom") return 0.3;
  if (t.kind === "stick") return 0.7;
  return THING_MATERIAL[t.kind]?.flammable ?? 0;
}
function burnOut(w: World, t: Thing, by?: string) {
  if (t.kind === "tree") { t.kind = "burnt_stump"; t.burning = 0; t.hp = 30; t.maxHp = 30; t.until = w.t + DAY * 10; changed.add(t.id); return; }
  if (t.kind === "structure") {
    const owner = w.agents.find((a) => a.id === t.owner);
    const text = `Fire burned down ${owner ? `${owner.name}'s` : "a"} ${["pile", "lean-to", "hut", "cabin"][t.shelter?.tier ?? 0]}.`;
    log(w, "burned", [owner?.id, by].filter(Boolean) as string[], t, text);
    if (owner) { burnedHomes.push({ owner: owner.id, by, text }); if (owner.home === t.id) owner.home = null; }
  }
  removeThing(w, t);
  if (t.kind !== "item" && t.kind !== "stick") changed.add(addThing(w, "ash", t.x, t.y, { born: w.t, until: w.t + DAY * 2 }).id);
}
function fire(w: World) {
  const dry = dryness(w);
  const byTile = new Map<number, Thing[]>();
  const sources: { t: Thing; heat: number; by?: string }[] = [];
  for (const t of w.things) {
    if (t.kind === "fire") {
      t.hp = (t.hp ?? 0) - (t.contained ? 0.5 : 1) - (rainy(w) && !t.contained ? 2 : 0);
      if (t.hp <= 0) {
        removeThing(w, t);
        log(w, "fire_out", t.owner ? [t.owner] : [], t, rainy(w) ? "The rain put out a campfire." : "A campfire burned out.");
        continue;
      }
      if (!t.contained) sources.push({ t, heat: Math.min(1, (t.hp ?? 0) / 150) * 0.6, by: t.owner });
    } else if (t.burning) {
      t.burning = clamp01(t.burning + (rainy(w) ? -0.08 : 0.05));
      t.hp = (t.hp ?? THING_MATERIAL[t.kind]?.hp ?? 10) - 2 * t.burning;
      changed.add(t.id);
      if (t.burning <= 0) { t.burning = 0; continue; }
      if (t.hp <= 0) { burnOut(w, t, t.burnedBy); continue; }
      sources.push({ t, heat: t.burning, by: t.burnedBy });
    }
    if (flammability(w, t) > 0 && !t.burning && t.kind !== "fire") {
      const i = t.y * W + t.x;
      (byTile.get(i) ?? byTile.set(i, []).get(i)!).push(t);
    }
  }
  const { dx: wdx, dy: wdy } = w.weather.wind;
  for (const s of sources) {
    for (let dy = -2; dy <= 2; dy++)
      for (let dx = -2; dx <= 2; dx++) {
        const far = Math.max(Math.abs(dx), Math.abs(dy)) === 2;
        const downwind = dx * wdx + dy * wdy > 0.5;
        if (far && !downwind) continue;
        for (const t of byTile.get((s.t.y + dy) * W + s.t.x + dx) ?? []) {
          if (t === s.t || t.burning) continue;
          const chance = s.heat * flammability(w, t) * dry * 0.02 * (downwind ? 2 : 1) * (far ? 0.4 : 1);
          if (Math.random() >= chance) continue;
          t.burning = 0.3;
          t.burnedBy = s.by;
          changed.add(t.id);
          count("fire.spread");
          trace("fire", "spread", { from: s.t.id, to: t.id, kind: t.kind, chance });
          if (t.kind === "structure") log(w, "fire_spread", [t.owner ?? ""].filter(Boolean), t, "Fire caught on a shelter!");
          else if (Math.random() < 0.1) log(w, "fire_spread", [], t, `Fire spread to a ${t.kind.replace("_", " ")}.`);
        }
      }
  }
}

// ---------- plants ----------
function plants(w: World) {
  const season = w.weather.season;
  const growing = season !== "winter";
  for (const t of [...w.things]) {
    if (t.burning) continue;
    if (t.kind === "bush") {
      if (growing && (t.n ?? 0) < 4 && Math.random() < (season === "autumn" ? 1 / 140 : 1 / 70)) { t.n = (t.n ?? 0) + 1; changed.add(t.id); }
      if ((t.hp ?? 20) < (t.maxHp ?? 20)) t.hp = (t.hp ?? 20) + 0.02;
      if ((t.hp ?? 20) <= 0) { t.kind = "dead_bush"; t.n = 0; changed.add(t.id); log(w, "grow", [], t, "A berry bush was picked to death."); }
      if (growing && season !== "autumn" && Math.random() < 1 / 7000) seedNear(w, t);
    } else if (t.kind === "dead_bush" && season === "spring" && Math.random() < 1 / 4000) {
      t.kind = "bush"; t.n = 0; t.hp = 20; t.maxHp = 20; changed.add(t.id);
    } else if (t.kind === "sapling" && growing) {
      t.stage = (t.stage ?? 0) + (1 / (3 * DAY)) * (nearWater(w, t.x, t.y, 4) ? 1.5 : 1);
      if (Math.round((t.stage ?? 0) * 20) !== Math.round(((t.stage ?? 0) - 1 / (3 * DAY)) * 20)) changed.add(t.id);
      if (t.stage >= 1) matured(w, t);
    } else if ((t.kind === "stump" || t.kind === "burnt_stump") && t.until! <= w.t && growing) {
      t.kind = "tree"; t.hp = 100; t.maxHp = 100; delete t.until; changed.add(t.id);
    } else if (t.kind === "ash" && t.until! <= w.t) removeThing(w, t);
  }
  if (Math.random() < (growing ? 1 / 18 : 1 / 60)) {
    const x = Math.floor(Math.random() * W), y = Math.floor(Math.random() * H);
    if (!walkable(w, x, y) || w.things.some((t) => t.x === x && t.y === y)) return;
    const forest = tileAt(w, x, y) === Tile.Forest, shore = nearWater(w, x, y, 1);
    const r = Math.random();
    const kind = shore && growing ? (r < 0.7 ? "reeds" : "clay") : forest ? (!growing ? "stick" : r < 0.45 ? "mushroom" : r < 0.6 ? "herb" : "stick") : r < 0.5 ? "stick" : "stone";
    changed.add(addThing(w, kind, x, y, kind === "reeds" ? { hp: 6, maxHp: 6 } : {}).id);
  }
}
function seedNear(w: World, t: Thing) {
  const x = t.x + Math.floor(Math.random() * 5) - 2, y = t.y + Math.floor(Math.random() * 5) - 2;
  if (tileAt(w, x, y) !== Tile.Grass || w.things.some((o) => o.x === x && o.y === y)) return;
  changed.add(addThing(w, "sapling", x, y, { stage: 0, item: "berry", born: w.t, hp: 5, maxHp: 5 }).id);
}
function matured(w: World, t: Thing) {
  const from = t.item ?? "berry";
  t.kind = "bush"; t.n = 1; t.hp = 20; t.maxHp = 20; delete t.stage;
  changed.add(t.id);
  log(w, "grow", t.owner ? [t.owner] : [], t, t.owner ? `The ${w.kinds[from]?.name ?? from} ${w.agents.find((a) => a.id === t.owner)?.name} pushed into the ground grew into a berry bush.` : "A new berry bush sprang up.");
  see(w, t, `grows:${from}`, `A ${w.kinds[from]?.name ?? from} in the ground can grow into a berry bush.`, 8);
  if (t.owner) grewFor(w, t.owner, from, t);
}
// The planter connects planting to the bush, whenever they see it.
export let grewFor: (w: World, owner: string, from: string, at: Thing) => void = () => {};
export const onGrew = (fn: typeof grewFor) => (grewFor = fn);

// ---------- animals ----------
function step(w: World, an: Animal, tx: number, ty: number, away = false) {
  let best: [number, number] | null = null, bd = away ? -Infinity : Infinity;
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
    const nx = an.x + dx, ny = an.y + dy;
    if (!walkable(w, nx, ny)) continue;
    const d = Math.hypot(nx - tx, ny - ty);
    if (away ? d > bd : d < bd) { bd = d; best = [nx, ny]; }
  }
  if (best) { an.dx = best[0] - an.x; an.dy = best[1] - an.y; an.x = best[0]; an.y = best[1]; }
}
function wander(w: World, an: Animal) {
  if (Math.random() > 0.35) return;
  step(w, an, an.x + Math.floor(Math.random() * 7) - 3, an.y + Math.floor(Math.random() * 7) - 3);
}
function nearestOf<T extends { x: number; y: number }>(from: { x: number; y: number }, list: T[], r: number) {
  let best: T | null = null, bd = r + 1;
  for (const o of list) { const d = dist(from, o); if (d < bd) { bd = d; best = o; } }
  return best;
}
function carcass(w: World, an: Animal) {
  w.animals = w.animals.filter((x) => x !== an);
  for (const [k, n] of Object.entries(THING_MATERIAL[an.species].breaks)) dropPile(w, an.x, an.y, k, n);
}
function animals(w: World) {
  const winter = w.weather.season === "winter", spring = w.weather.season === "spring";
  const deer = w.animals.filter((a) => a.species === "deer"), wolves = w.animals.filter((a) => a.species === "wolf");
  const awake = w.agents.filter((a) => a.down <= w.t);
  for (const d of deer) {
    d.hunger -= winter ? 0.1 : 0.05;
    const wolf = nearestOf(d, wolves, 6), person = nearestOf(d, awake, 3);
    const threat = wolf ?? person;
    if (threat || d.hp < d.maxHp * 0.6) {
      d.state = "flee";
      if (threat) step(w, d, threat.x, threat.y, true);
      else wander(w, d);
    } else {
      const tile = tileAt(w, d.x, d.y);
      if (tile === Tile.Grass && d.hunger < 90) { d.state = "graze"; d.hunger = Math.min(100, d.hunger + (winter ? 0.12 : 0.35)); }
      else d.state = "wander";
      const mate = nearestOf(d, deer.filter((x) => x !== d), 20);
      if (mate && dist(d, mate) > 4 && Math.random() < 0.3) step(w, d, mate.x, mate.y);
      else if (d.state !== "graze" || Math.random() < 0.15) wander(w, d);
      if ((spring || w.weather.season === "summer") && mate && dist(d, mate) <= 2 && d.hunger > 55 && deer.length < 18 && Math.random() < 1 / 400) {
        addAnimal(w, "deer", d.x, d.y);
        log(w, "birth", [], d, "A fawn was born.");
      }
    }
    if (d.hunger <= 0) { carcass(w, d); log(w, "death", [], d, "A deer starved."); }
  }
  for (const wf of wolves) {
    wf.hunger -= winter ? 0.12 : 0.08;
    const fireNear = w.things.some((t) => t.kind === "fire" && dist(t, wf) <= 3);
    const crowd = awake.filter((a) => dist(a, wf) <= 2).length >= 2;
    if (fireNear || crowd || wf.hp < wf.maxHp * 0.4) {
      wf.state = "flee";
      const from = fireNear ? w.things.find((t) => t.kind === "fire" && dist(t, wf) <= 3)! : nearestOf(wf, awake, 3)!;
      if (from) step(w, wf, from.x, from.y, true);
      wf.target = undefined;
      continue;
    }
    const meat = w.things.find((t) => t.kind === "item" && (t.item === "meat" || t.item?.startsWith("rotten:meat")) && dist(t, wf) <= 8);
    if (wf.hunger < 70 && meat) {
      wf.state = "eat";
      if (dist(wf, meat) <= 0) {
        meat.n = (meat.n ?? 1) - 1; wf.hunger = Math.min(100, wf.hunger + 30); changed.add(meat.id);
        if (meat.n <= 0) removeThing(w, meat);
      } else step(w, wf, meat.x, meat.y);
      continue;
    }
    const prey = wf.hunger < 50 ? nearestOf(wf, deer, 20) : null;
    const lone = (a: Agent) => awake.every((b) => b === a || dist(a, b) > 3) && !w.things.some((t) => t.kind === "fire" && dist(t, a) <= 4);
    const desperate = wf.hunger < 12 || (wf.hunger < 30 && (isNight(w.t) || winter));
    const person = !prey && desperate ? nearestOf(wf, awake.filter(lone), 15) : null;
    const target = person ?? prey;
    if (!target) { wf.state = "wander"; wf.target = undefined; wander(w, wf); continue; }
    wf.state = "hunt";
    if (dist(wf, target) > 1) { step(w, wf, target.x, target.y); continue; }
    wf.state = "attack";
    if ("species" in target) {
      target.hp -= 6;
      if (target.hp <= 0) {
        carcass(w, target);
        log(w, "death", [], target, "Wolves brought down a deer.");
        see(w, target, "breaks:deer", "A deer can be killed. It's all meat, hide, and bone inside.", 9);
      }
    } else {
      const victim = target as Agent;
      victim.needs.health = Math.max(0, victim.needs.health - 5);
      if (wf.target !== victim.id) log(w, "attack", [victim.id], victim, `A wolf attacked ${victim.name}!`);
      wf.target = victim.id;
      attacked.set(victim.id, wf.id);
      trace("animal", "attack", { wolf: wf.id, victim: victim.id, health: victim.needs.health }, victim.id);
    }
  }
  const wolfCount = wolves.filter((x) => w.animals.includes(x)).length;
  if (spring && wolfCount >= 2 && wolfCount < 6 && Math.random() < 1 / 4000) {
    const mom = wolves.find((x) => w.animals.includes(x))!;
    addAnimal(w, "wolf", mom.x, mom.y);
    log(w, "birth", [], mom, "A wolf pup was born.");
  }
  for (const wf of w.animals.filter((a) => a.species === "wolf" && a.hunger <= 0)) { carcass(w, wf); log(w, "death", [], wf, "A wolf starved."); }
}
// Agents being attacked this tick, agent id -> wolf id.
export const attacked = new Map<string, string>();

// ---------- rot, wear, weathering ----------
function decay(w: World) {
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
    for (const s of a.inv) {
      if (!spoiled(s.k, s.born)) continue;
      if (s.k.startsWith("rotten:")) { a.inv.splice(a.inv.indexOf(s), 1); continue; }
      log(w, "spoil", [a.id], a, `${a.name}'s ${w.kinds[s.k]?.name} went bad.`);
      s.k = rot(s.k); s.born = w.t;
    }
    if (a.wearing && (a.wearing.hp -= 0.006) <= 0) { log(w, "break", [a.id], a, `${a.name}'s ${w.kinds[a.wearing.k]?.name} wore through.`); a.wearing = null; }
  }
  for (const t of [...w.things]) {
    if (t.kind === "item" && t.item && spoiled(t.item, t.born ?? w.t)) {
      if (t.item.startsWith("rotten:")) { removeThing(w, t); continue; }
      t.item = rot(t.item); t.born = w.t; changed.add(t.id);
    }
    if (t.kind === "structure" && t.shelter) {
      const sky = w.weather.sky;
      t.hp = (t.hp ?? 100) - (0.03 + (sky === "rain" ? 0.1 : sky === "storm" ? 0.5 : 0)) * (1.2 - t.shelter.sturdy);
      if (t.hp <= 0) {
        const owner = w.agents.find((a) => a.id === t.owner);
        log(w, "collapse", owner ? [owner.id] : [], t, `${owner ? `${owner.name}'s` : "A"} shelter fell apart in the weather.`);
        for (const [k, n] of Object.entries(t.parts ?? {})) if (Math.random() < 0.5) dropPile(w, t.x, t.y, k, Math.ceil(n / 2));
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
      if (b === a || b.sickness || dist(a, b) > 1 || Math.random() > 0.003 * s.severity) continue;
      b.sickness = { until: w.t + Math.round(DAY * (0.5 + s.severity)), severity: s.severity * 0.8 };
      log(w, "sick", [b.id, a.id], b, `${b.name} caught ${a.name}'s sickness.`);
      see(w, b, "contagion", "Sickness spreads between people who stay close.", 4);
    }
  }
}

// ---------- paths ----------
export function trample(w: World, x: number, y: number) {
  const i = y * W + x;
  if (w.paths[i] < 9 && Math.random() < 0.06) { w.paths[i]++; pathChanges.add(i); }
}
function paths(w: World) {
  if (w.t % DAY) return;
  for (let i = 0; i < w.paths.length; i++) if (w.paths[i] && Math.random() < 0.3) { w.paths[i]--; pathChanges.add(i); }
}

export function ecology(w: World) {
  attacked.clear();
  timed("weather", () => weather(w));
  timed("fire", () => fire(w));
  timed("plants", () => plants(w));
  timed("animals", () => animals(w));
  timed("decay", () => decay(w));
  timed("disease", () => disease(w));
  paths(w);
}
