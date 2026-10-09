import { expect, test } from "bun:test";
import { DAY, TILE_M, addThing, newWorld, rng, shoreOf, type Act, type Agent, type Thing, type World } from "./world";
import { WEATHER_NOW, bedAir, count, eat, fireOf, giveItems, giveStack, heat, join, openWater, place, strikeTick, throwTick, wet, type Fields, type Outcome } from "./physics";
import { pieceOf } from "./fuel";
import { advance } from "./combustion";
import { predictMaterial } from "./formulas";
import { addAnimal } from "./fauna";
import { put as moveTo, thingById } from "./space";
import { conditionsNow } from "./sim";
import { hooks } from "./rules";
import { DAMP } from "./wetness";
import { ecology, forecast } from "./ecology";
import { ahead, bedAt, seedlingFate } from "./seedling";

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

test("hammering hot metal at a charcoal fire draws out a blade sharper and tougher than flint; cold metal only dents", () => {
  const [w, a] = burning();
  put(w, a, "stone", 3);
  put(w, a, "charcoal", 3);
  w.kinds.lump = { id: "lump", name: "metal lump", props: { hard: 0.8, heavy: 0.85, metal: 1, toughness: 0.85 }, parts: ["ore"], verb: "heat" };
  giveItems(w, a, "stone", 2); giveItems(w, a, "sharp_stone"); giveItems(w, a, "lump", 2);
  expect(hammer(w, a, "stone", "lump").effect).toBe("dented");
  const blade = (tool: string) => {
    const hot = Object.keys(heated(w, a, { items: ["lump"] }).gives)[0];
    const out = hammer(w, a, tool, hot);
    expect(out.ok).toBe(true);
    return w.kinds[Object.keys(out.gives)[0]].props;
  };
  const heavy = blade("stone"), light = blade("sharp_stone");
  expect(heavy.sharp!).toBeGreaterThan(w.kinds.flint_blade.props.sharp!);
  expect(heavy.toughness!).toBeGreaterThan(w.kinds.flint_blade.props.toughness! + 0.3);
  expect(light.sharp!).toBeLessThan(heavy.sharp!);
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
test("struck over fiber laid with twigs, two hard stones light it after the same number of blows every time, flint sooner than plain stone; over damp fiber or in a gale the sparks never catch, and over sticks alone they never do", () => {
  const [w, a] = fresh();
  const light = (tool: string, target: string, over: string, wet = 0) => {
    a.inv = [];
    giveItems(w, a, tool); giveItems(w, a, target); giveItems(w, a, over, 1, wet);
    return hammer(w, a, tool, target, [over, ...twigs(w, a)]);
  };
  w.weather.sky = "clear";
  w.weather.speed = 2;
  const stone = Array.from({ length: 5 }, () => light("stone", "stone", "fiber"));
  expect(stone.every((o) => o.builds === "fire")).toBe(true);
  expect(new Set(stone.map((o) => o.numbers?.blows)).size).toBe(1);
  const flint = light("stone", "flint", "fiber");
  expect(flint.builds).toBe("fire");
  expect(flint.numbers!.blows).toBeLessThan(stone[0].numbers!.blows);
  // at the spark limit it still catches; just wetter, it never does
  expect(light("stone", "stone", "fiber", DAMP).builds).toBe("fire");
  expect(Array.from({ length: 3 }, () => light("stone", "stone", "fiber", DAMP + 0.01)).every((o) => !o.ok)).toBe(true);
  // the air where they stand is worked out once a tick: a new wind, a new tick
  w.weather.speed = 60;
  w.t++;
  expect(WEATHER_NOW.wind(w, a)).toBe(true);
  expect(light("stone", "stone", "fiber").ok).toBe(false);
  w.weather.speed = 2;
  w.t++;
  const stick = light("stone", "stone", "stick");
  expect(stick.ok).toBe(false);
});

test("knapping stone with stone chips off a sharp stone at the same blow every time, fiber in hand or not; a striker too soft never does", () => {
  const [w, a] = fresh();
  const knap = (tool: string, target: string) => {
    a.inv = [];
    giveItems(w, a, tool); giveItems(w, a, target); giveItems(w, a, "fiber");
    return hammer(w, a, tool, target);
  };
  const chips = Array.from({ length: 5 }, () => knap("stone", "stone"));
  expect(chips.every((o) => o.ok && o.gives.sharp_stone === 1 && !o.builds)).toBe(true);
  expect(new Set(chips.map((o) => o.numbers?.blows)).size).toBe(1);
  expect(count(a, "fiber")).toBe(1);
  const soft = knap("stick", "stone");
  expect(soft.ok).toBe(false);
  expect(soft.gives.sharp_stone).toBeUndefined();
});

test("felling a tree with a sharp stone peels the same strips of bark every time; a blunt stone peels none", () => {
  const [w, a] = fresh();
  // the strips a tree gave in up to 60 blows of a tool
  const strips = (tool: string) => {
    const tree = addThing(w, "tree", a.px, a.py, { size: 10 });
    a.inv = [];
    giveItems(w, a, tool);
    const st = { progress: 0 };
    for (let i = 0; i < 60 && !strikeTick(w, a, { verb: "strike", items: [], tool, target: { kind: "tree", thing: tree.id } }, st).done; i++);
    return tree.bark ?? 0;
  };
  const sharp = [strips("sharp_stone"), strips("sharp_stone"), strips("sharp_stone")];
  expect(sharp[0]).toBeGreaterThan(0);
  expect(new Set(sharp).size).toBe(1);
  expect(strips("stone")).toBe(0);
});

test("a line or a basket dipped where a fish swims within reach catches every time, and with none about never does: anyone dipping sees there were no fish close by, and only what's dipped in the water records it", () => {
  const [w, a] = fresh();
  const shore = shoreOf(w).find((s) => { moveTo(w, a, s.px, s.py); return openWater(w, a); });
  expect(shore).toBeDefined();
  w.kinds.line = { id: "line", name: "line", props: { long: 0.7, flexible: 0.9, binding: 0.8 } };
  w.kinds.basket = { id: "basket", name: "basket", props: { container: 0.7, fibrous: 0.8 } };
  w.animals = [];
  const dip = (k: string) => { giveItems(w, a, k); return wet(w, a, { verb: "wet", items: [k], at: "water" }); };
  for (const k of ["line", "basket", "line", "basket"]) {
    const fish = addAnimal(w, "fish", a.px + 10 / TILE_M, a.py);
    expect(dip(k).gives.fish).toBeGreaterThanOrEqual(1);
    expect(w.animals).not.toContain(fish);
    // the fish they lifted out was close by, though it swims there no more
    expect(conditionsNow(w, a, "wet")).not.toContain("nofish");
    w.t++;
  }
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
  const spot = { px: a.px + 2 / TILE_M, py: a.py };
  // the weather ecology will give it: a seeded stretch of the island's own
  const hours = forecast(w, 30 * 24, rng(7));
  const fate = seedlingFate(bedAt(w, spot.px, spot.py, "berry"), false, ahead(w, spot.px, spot.py, w.t, hours));
  const t = addThing(w, "sapling", spot.px, spot.py, { stage: 0, item: "berry", born: w.t, hp: 5, maxHp: 5 });
  const first = Math.ceil((w.t + 1) / 12) * 12, end = w.t + 30 * DAY;
  hooks.weather = (w) => { const h = hours[(w.t - first) / 12]; Object.assign(w.weather, { sky: h.sky, speed: h.speed }); };
  try {
    while (w.t < end && thingById(w, t.id)?.kind === "sapling") { w.t++; ecology(w); }
  } finally {
    hooks.weather = undefined;
  }
  // the hour it came up, counted from the first it was tended; none if it withered or never did
  expect(thingById(w, t.id)?.kind === "bush" ? (w.t - first) / 12 : null).toBe(fate);
});
