import { expect, test } from "bun:test";
import { DAY, H, TILE_M, Tile, W, addThing, dryAt, newWorld, rng, shoreOf, type Act, type Agent, type Thing, type World } from "./world";
import { WEATHER_NOW, bedAir, count, eat, fireOf, giveItems, giveStack, heat, join, openWater, place, removeThing, strikeTick, throwTick, wet, type Fields, type Outcome } from "./physics";
import { COPPER, PHYS, pieceOf } from "./fuel";
import { BLADE } from "./mechanics";
import { advance } from "./combustion";
import { predictMaterial } from "./formulas";
import { addAnimal } from "./fauna";
import { fishNear } from "./fish";
import { put as moveTo, thingById } from "./space";
import { conditionsNow } from "./sim";
import { hooks } from "./rules";
import { DAMP } from "./wetness";
import { ecology, forecast } from "./ecology";
import { ahead, bedAt, seedlingFate } from "./seedling";
import { fitHere } from "./plants";

// A fire burning so many seconds (ten minutes unless said) from the usual lay (fireOf), under a clear sky with a breeze
// blowing u m/s.
const burning = (u = 2, sticks = 5, logs = 2, age = 600): [World, Agent, Thing] => {
  const [w, a] = fresh();
  Object.assign(w.weather, { sky: "clear", speed: u });
  w.t++;
  const fire = fireOf(w, a.px, a.py, sticks, logs);
  fire.bed = advance(fire.bed!, age, bedAir(w, fire));
  return [w, a, fire];
};
const fresh = (): [World, Agent] => { const w = newWorld(42); const a = w.agents[0]; a.inv = []; return [w, a]; };
const heated = (w: World, a: Agent, act: Omit<Act, "verb">): Outcome => {
  const r = heat(w, a, { verb: "heat", ...act });
  if (r === "ask") throw new Error("the heat rules should cover this");
  return r;
};
const put = (w: World, a: Agent, k: string, n: number) => { giveItems(w, a, k, n); return place(w, a, { verb: "place", items: Array(n).fill(k) }); };
// One try of striking something held, blow by blow until it comes to something; lay: what it's struck over, if anything
const hammer = (w: World, a: Agent, tool: string, target: string, lay: string[] = []) => {
  const st = { progress: 0 };
  let r;
  do r = strikeTick(w, a, { verb: "strike", items: lay, tool, target: { kind: target } }, st); while (!r.done);
  return r.out!;
};
// Ten half-meter twigs off the ground (fuel.ts pieces), dry as wood kept in: kindling laid with tinder.
const TWIG = pieceOf({ kind: "stick", size: 0.5 }, "stick")!.size;
const twigs = (w: World, a: Agent) => { for (let i = 0; i < 10; i++) giveStack(w, a, { k: "stick", hp: 1, born: w.t, m: 0.12, size: TWIG }); return Array<string>(10).fill("stick"); };

test("clay set in a burning fire fires hard, as pots do in a bonfire, and not in a small fire's few coals; ore gives up its copper only when air is blown into the coals", () => {
  const [w, a] = burning();
  giveItems(w, a, "clay");
  const pot = heated(w, a, { items: ["clay"] });
  expect(pot.ok).toBe(true);
  expect(pot.fields.at).toBe("fire");
  giveItems(w, a, "ore");
  expect(heated(w, a, { items: ["ore"] }).effect).toBe("too_cool");
  giveItems(w, a, "fiber", 3);
  const mat = join(w, a, { verb: "join", items: ["fiber", "fiber", "fiber"] });
  if (mat === "ask") throw new Error();
  const lump = heated(w, a, { items: ["ore"], tool: Object.keys(mat.gives)[0] });
  expect(lump.ok).toBe(true);
  expect(w.kinds[Object.keys(lump.gives)[0]].props.metal).toBe(1);
  // a lay of fibre and twigs a minute after lighting: flames gone and a few coals that can't bury a lump of clay
  const [v, b] = burning(2, 0, 0, 60);
  giveItems(v, b, "clay");
  expect(heated(v, b, { items: ["clay"] }).effect).toBe("too_cool");
  expect(count(b, "clay")).toBe(1);
});

test("a stick set in an open fire catches and is carried off alight; under stone heaped over the same fire it smoulders to charcoal, and a log is still wood when they take it out", () => {
  const [w, a, fire] = burning();
  giveItems(w, a, "stick");
  expect(Object.keys(heated(w, a, { items: ["stick"] }).gives)[0]).toBe("burning:stick");
  put(w, a, "stone", 3);
  expect(put(w, a, "stone", 3).builds).toBe("kiln");
  expect(fire.covered).toBe(true);
  giveItems(w, a, "stick");
  expect(heated(w, a, { items: ["stick"] }).gives).toEqual({ charcoal: 1 });
  giveItems(w, a, "log");
  expect(heated(w, a, { items: ["log"] }).effect).toBe("too_cool");
  expect(count(a, "log")).toBe(1);
});

test("meat set in a small fire of twigs and sticks cooks through; under a cover it cooks in the smoke and comes out smoked", () => {
  const [w, a] = burning(2, 5, 0, 120);
  giveItems(w, a, "meat");
  expect(Object.keys(heated(w, a, { items: ["meat"] }).gives)[0]).toBe("cooked:meat");
  const [v, b] = burning();
  put(v, b, "stone", 3); put(v, b, "stone", 3);
  giveItems(v, b, "meat");
  expect(Object.keys(heated(v, b, { items: ["meat"] }).gives)[0]).toBe("smoked:meat");
});

test("a hide hung over an open fire scorches, and over the same fire heaped over it cures in the smoke", () => {
  const [w, a] = burning();
  giveItems(w, a, "hide");
  expect(heated(w, a, { items: ["hide"] }).effect).toBe("scorched");
  put(w, a, "stone", 3); put(w, a, "stone", 3);
  const cured = heated(w, a, { items: ["hide"] });
  expect(cured.ok).toBe(true);
  expect(Object.keys(cured.gives)[0]).toBe("leather:hide");
});

test("the staged fire, hearth, kiln and forge the answer key asks give what acts at fires laid and set up the same way give", () => {
  for (const at of ["fire", "hearth", "kiln", "forge"] as const) {
    const [w, a, fire] = burning(0);
    if (at !== "fire") put(w, a, "stone", 3);
    if (at === "kiln") put(w, a, "stone", 3);
    if (at === "forge") fire.charcoal = 1;
    giveItems(w, a, "fiber", 3);
    const mat = join(w, a, { verb: "join", items: ["fiber", "fiber", "fiber"] });
    if (mat === "ask") throw new Error();
    const fan = Object.keys(mat.gives)[0];
    for (const [items, tool] of [[["meat"]], [["ore"]], [["ore"], fan], [["stick"]]] as [string[], string?][]) {
      giveItems(w, a, items[0]);
      const f: Fields = { verb: "heat", inputs: items, at, gives: [], ...(tool ? { tool } : {}) };
      const said = predictMaterial(w, f), done = heated(w, a, { items, ...(tool ? { tool } : {}) });
      expect([at, items[0], tool, "ok" in said && said.ok, "ok" in said && said.gives]).toEqual([at, items[0], tool, done.ok, done.fields.gives]);
    }
  }
});

test("hammering copper red hot at a charcoal fire draws its edge out into a blade; cold, it hardens before the edge is thin enough for one", () => {
  const [w, a] = burning();
  put(w, a, "stone", 3);
  put(w, a, "charcoal", 3);
  w.kinds.lump = { id: "lump", name: "metal lump", props: { hard: 0.8, heavy: 0.85, metal: 1, toughness: 0.85 }, parts: ["ore"], verb: "heat", phys: COPPER };
  giveItems(w, a, "stone", 2); giveItems(w, a, "lump", 2);
  const edge = (o: Outcome) => w.kinds[Object.keys(o.gives)[0]].phys!.edge!.r * 2;
  const cold = hammer(w, a, "stone", "lump");
  expect(cold.ok).toBe(true);
  expect(edge(cold)).toBeGreaterThan(BLADE);
  const hot = hammer(w, a, "stone", Object.keys(heated(w, a, { items: ["lump"] }).gives)[0]);
  expect(hot.ok).toBe(true);
  expect(hot.fields.at).toBe("forge");
  expect(edge(hot)).toBeLessThanOrEqual(BLADE * 1.001);
});

test("hands full of tools still make room for food", () => {
  const [w, a] = fresh();
  a.born = w.t - 1e6;
  giveItems(w, a, "sharp_stone", 11);
  for (const k of ["stick", "clay", "stone", "fiber", "bone"]) giveItems(w, a, k);
  expect(a.inv.length).toBe(16);
  expect(giveItems(w, a, "berry", 3)).toBe(3);
  expect(count(a, "berry")).toBe(3);
  expect(count(a, "sharp_stone")).toBe(8);
});

test("hands full of food still make room for a stick", () => {
  const [w, a] = fresh();
  a.born = w.t - 1e6;
  giveItems(w, a, "grain", 16);
  expect(giveItems(w, a, "stick")).toBe(1);
  expect(count(a, "stick")).toBe(1);
  expect(count(a, "grain")).toBe(15);
});

// Whether a try comes off follows from what anyone trying could notice: the same things in hand, weather and spot give
// the same outcome every time, and changing what decides it changes it.
test("struck over fiber laid with twigs, pyrite shaved by flint or a plain stone lights it at the same stroke every time; two stones never do; over damp fiber or in a gale the sparks never catch, and over sticks alone they never do", () => {
  const [w, a] = fresh();
  const light = (tool: string, target: string, over: string, wet = 0) => {
    a.inv = [];
    giveItems(w, a, tool); giveItems(w, a, target); giveItems(w, a, over, 1, wet);
    return hammer(w, a, tool, target, [over, ...twigs(w, a)]);
  };
  w.weather.sky = "clear";
  w.weather.speed = 2;
  const stone = Array.from({ length: 5 }, () => light("stone", "pyrite", "fiber"));
  expect(stone.every((o) => o.builds === "fire")).toBe(true);
  expect(new Set(stone.map((o) => o.numbers?.blows)).size).toBe(1);
  expect(light("flint", "pyrite", "fiber").builds).toBe("fire");
  expect(light("stone", "stone", "fiber").ok).toBe(false);
  expect(light("stone", "flint", "fiber").ok).toBe(false);
  // at the spark limit it still catches; just wetter, it never does
  expect(light("stone", "pyrite", "fiber", DAMP).builds).toBe("fire");
  expect(Array.from({ length: 3 }, () => light("stone", "pyrite", "fiber", DAMP + 0.01)).every((o) => !o.ok)).toBe(true);
  // the air where they stand is worked out once a tick: a new wind, a new tick; out from under the crowns, which keep a
  // gale off (air.ts headWind)
  for (const t of w.things.filter((t) => t.kind === "tree" && Math.hypot(t.px - a.px, t.py - a.py) * TILE_M < 15)) removeThing(w, t);
  w.weather.speed = 60;
  w.t++;
  expect(WEATHER_NOW.wind(w, a)).toBe(true);
  expect(light("stone", "pyrite", "fiber").ok).toBe(false);
  w.weather.speed = 2;
  w.t++;
  expect(light("stone", "pyrite", "stick").ok).toBe(false);
});

test("a stone struck with a stone or a stick knocks off a sharp stone at every blow until the core is spent; bare hands knock off nothing", () => {
  const [w, a] = fresh();
  a.born = w.t - 1e6;
  giveItems(w, a, "stone", 2); giveItems(w, a, "stick");
  const flakes = (PHYS.stone.mass / PHYS.sharp_stone.mass) | 0;
  let n = 0;
  while (count(a, "stone") === 2 && n < 100) { a.inv = a.inv.filter((s) => s.k !== "sharp_stone"); if (hammer(w, a, "stone", "stone").gives.sharp_stone === 1) n++; }
  expect(n).toBe(flakes);
  expect(count(a, "stone")).toBe(1);
  expect(hammer(w, a, "stick", "stone").gives.sharp_stone).toBe(1);
  const bare = strikeTick(w, a, { verb: "strike", items: [], tool: null, target: { kind: "stone" } }, { progress: 0 }).out!;
  expect(bare.ok).toBe(false);
});

test("felling an oak with a hafted flint blade peels the same strips of bark every time, and the oak gives logs and sticks; a stone in the fist never cuts it", () => {
  const [w, a] = fresh();
  a.born = w.t - 1e6;
  w.kinds.axe = { id: "axe", name: "flint axe", props: { sharp: 0.9 }, parts: ["flint_blade", "stick"], verb: "join" };
  // tree: an oak this tall; sharp: the axe kept sharp, as if resharpened whenever it dulled
  const fell = (tool: string, size: number, sharp = false) => {
    const tree = addThing(w, "tree", a.px, a.py, { size, species: "oak", hp: 100, maxHp: 100 });
    a.inv = [];
    giveItems(w, a, tool);
    const st = { progress: 0 };
    let r;
    do { if (sharp) for (const s of a.inv) s.hp = 1; r = strikeTick(w, a, { verb: "strike", items: [], tool, target: { kind: "tree", thing: tree.id } }, st); } while (!r.done);
    return { out: r.out!, bark: tree.bark ?? 0 };
  };
  const young = [fell("axe", 10), fell("axe", 10)];
  expect(young.every((f) => f.out.ok && f.out.gives.log! >= 1 && f.out.gives.stick! > 1)).toBe(true);
  expect(young[1].out.gives).toEqual(young[0].out.gives);
  // a big oak dulls the edge many times over before it's down; kept sharp, it gives its bark over the notch
  expect(fell("axe", 25).out.ok).toBe(false);
  const old = [fell("axe", 25, true), fell("axe", 25, true)];
  expect(old[0].out.ok).toBe(true);
  expect(old[0].bark).toBeGreaterThan(0);
  expect(old[1].bark).toBe(old[0].bark);
  expect(fell("stone", 10).out.ok).toBe(false);
});

test("a line or a basket dipped where a fish swims within reach catches every time, and with none about never does: anyone dipping sees there were no fish close by, and only what's dipped in the water records it", () => {
  const [w, a] = fresh();
  // the water's stock (fish.ts), kg a ha: thick with fish everywhere, and a shore where a basket's sweep reaches it
  const fish = w.pools!.fish;
  for (let i = 0; i < W * H; i++) fish[i] = w.tiles[i] === Tile.Water ? 1000 : 0;
  const shore = shoreOf(w).find((s) => { moveTo(w, a, s.px, s.py); return openWater(w, a) && fishNear(w, fish, a, 15) >= 2; });
  expect(shore).toBeDefined();
  w.kinds.line = { id: "line", name: "line", props: { long: 0.7, flexible: 0.9, binding: 0.8 } };
  w.kinds.basket = { id: "basket", name: "basket", props: { container: 0.7, fibrous: 0.8 } };
  const dip = (k: string) => { giveItems(w, a, k); return wet(w, a, { verb: "wet", items: [k], at: "water" }); };
  for (const k of ["line", "basket", "line", "basket"]) {
    const before = fishNear(w, fish, a, 40);
    expect(dip(k).gives.fish).toBeGreaterThanOrEqual(1);
    // what they lifted out came out of the water's stock
    expect(fishNear(w, fish, a, 40)).toBeLessThan(before);
    // the fish they lifted out was close by
    expect(conditionsNow(w, a, "wet")).not.toContain("nofish");
    w.t++;
  }
  fish.fill(0);
  for (const k of ["line", "basket", "line", "basket"]) {
    const out = dip(k);
    expect(out.ok).toBe(false);
    expect(conditionsNow(w, a, "wet")).toContain("nofish");
    w.t++;
  }
  for (const verb of ["strike", "rub", "plant"]) expect(conditionsNow(w, a, verb)).not.toContain("nofish");
});

test("a stone thrown at a deer within reach hits it every time, for the same harm; at one farther off it always falls short", () => {
  const [w, a] = fresh();
  w.animals = [];
  const deer = addAnimal(w, "deer", a.px + 8 / TILE_M, a.py);
  const toss = () => {
    giveItems(w, a, "stone");
    const st = { progress: 0 };
    let r;
    do r = throwTick(w, a, { verb: "throw", items: ["stone"], target: { kind: "deer", animal: deer.id } }, st); while (!r.done);
    return r.out!;
  };
  const harm = Array.from({ length: 3 }, () => { const hp = deer.hp; toss(); return hp - deer.hp; });
  expect(harm[0]).toBeGreaterThan(0);
  for (const h of harm) expect(h).toBeCloseTo(harm[0]);
  moveTo(w, deer, a.px + 30 / TILE_M, a.py);
  for (let i = 0; i < 3; i++) {
    const hp = deer.hp, out = toss();
    expect(deer.hp).toBe(hp);
    expect(out.ok).toBe(false);
  }
});

test("raw meat makes whoever eats it sick every time; raw fish and cooked meat never do", () => {
  const [w, a] = fresh();
  w.kinds.roast = { id: "roast", name: "cooked meat", props: { edible: 0.5, toxic: 0.045 } };
  for (const [k, sick] of [["meat", true], ["fish", false], ["roast", false]] as const)
    for (let i = 0; i < 4; i++) {
      giveItems(w, a, k);
      const out = eat(w, a, k);
      expect(out.effect === "sick").toBe(sick);
      expect(out.ok).toBe(!sick);
    }
});

test("a seedling's hours ahead come to what ecology makes of the same weather, hour by hour", () => {
  const [w, a] = fresh();
  // nobody about to feed the soil with dung, nothing roaming: the seedling alone with its spot and the weather
  w.agents = [];
  w.animals = [];
  // a spot that suits berries well, the nearest to where they started (a fit over a half [design]): they start on the
  // marsh, where a seedling only burns down, and its soil's water would count for nothing
  let spot: { px: number; py: number } | undefined;
  for (let m = 5; m <= 400 && !spot; m += 5)
    for (let k = 0; k < 16 && !spot; k++) {
      const px = a.px + (Math.cos((k * Math.PI) / 8) * m) / TILE_M, py = a.py + (Math.sin((k * Math.PI) / 8) * m) / TILE_M;
      if (dryAt(w, px, py) && fitHere(w, "berry", px, py) > 0.5) spot = { px, py };
    }
  if (!spot) throw new Error("no ground near them suits berries");
  // the weather ecology will give it: a seeded stretch of the island's own
  const hours = forecast(w, 30 * 24, rng(7));
  const fate = seedlingFate(bedAt(w, spot.px, spot.py, "berry"), ahead(w, spot.px, spot.py, w.t, hours));
  const t = addThing(w, "sapling", spot.px, spot.py, { stage: 0, item: "berry", born: w.t, hp: 5, maxHp: 5 });
  const first = Math.ceil((w.t + 1) / 12) * 12, end = w.t + 30 * DAY;
  // all of it: the sky, the wind and how far the day's air stands from its time of year's (forecast's warm)
  hooks.weather = (w) => { const h = hours[(w.t - first) / 12]; Object.assign(w.weather, { sky: h.sky, speed: h.speed, warm: h.warm }); };
  try {
    while (w.t < end && thingById(w, t.id)?.kind === "sapling") { w.t++; ecology(w); }
  } finally {
    hooks.weather = undefined;
  }
  // the hour it came up or withered, counted from the first it was tended; none if it did neither
  const now = thingById(w, t.id)?.kind;
  expect(now === "bush" ? { up: true, hours: (w.t - first) / 12 } : now === undefined ? { up: false, hours: (w.t - first) / 12 } : null).toEqual(fate);
});
