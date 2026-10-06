import { expect, test } from "bun:test";
import { TILE_M, addThing, newWorld, shoreOf, type Act, type Agent, type Thing, type World } from "./world";
import { WEATHER_NOW, count, eat, fireHeat, giveItems, heat, join, openWater, place, quenched, strikeTick, throwTick, wet, type Outcome } from "./physics";
import { addAnimal } from "./fauna";
import { put as moveTo } from "./space";
import { conditionsNow } from "./sim";
import { RULES } from "./rules";
import { DARK, lightOn } from "./light";

const setup = (): [World, Agent, Thing] => {
  const w = newWorld(42);
  const a = w.agents[0];
  a.inv = [];
  return [w, a, addThing(w, "fire", a.px, a.py, { hp: 400, maxHp: 400 })];
};
const fresh = (): [World, Agent] => { const w = newWorld(42); const a = w.agents[0]; a.inv = []; return [w, a]; };
const heated = (w: World, a: Agent, act: Omit<Act, "verb">): Outcome => {
  const r = heat(w, a, { verb: "heat", ...act });
  if (r === "ask") throw new Error("the heat rules should cover this");
  return r;
};
const put = (w: World, a: Agent, k: string, n: number) => { giveItems(w, a, k, n); return place(w, a, { verb: "place", items: Array(n).fill(k) }); };
// One try of striking something held, blow by blow until it comes to something; over: what it's struck over, if anything
const hammer = (w: World, a: Agent, tool: string, target: string, over?: string) => {
  const st = { progress: 0 };
  let r;
  do r = strikeTick(w, a, { verb: "strike", items: over ? [over] : [], tool, target: { kind: target } }, st); while (!r.done);
  return r.out!;
};

test("clay only hardens in a ringed fire, and ore only gives up metal to ringed charcoal with air blown in", () => {
  const [w, a, fire] = setup();
  giveItems(w, a, "clay");
  expect(heated(w, a, { items: ["clay"] }).effect).toBe("too_cool");
  expect(count(a, "clay")).toBe(1);
  put(w, a, "stone", 3);
  expect(fireHeat(w, fire)).toBe(1.3);
  const pot = heated(w, a, { items: ["clay"] });
  expect(pot.ok).toBe(true);
  expect(pot.fields.at).toBe("hearth");
  giveItems(w, a, "ore");
  expect(heated(w, a, { items: ["ore"] }).ok).toBe(false);
  expect(put(w, a, "charcoal", 2).builds).toBe("forge");
  expect(fireHeat(w, fire)).toBe(2);
  expect(heated(w, a, { items: ["ore"] }).effect).toBe("too_cool");
  giveItems(w, a, "fiber", 3);
  const mat = join(w, a, { verb: "join", items: ["fiber", "fiber", "fiber"] });
  if (mat === "ask") throw new Error();
  const lump = heated(w, a, { items: ["ore"], tool: Object.keys(mat.gives)[0] });
  expect(lump.ok).toBe(true);
  expect(w.kinds[Object.keys(lump.gives)[0]].props.metal).toBe(1);
});

test("wood burns in an open fire but turns to charcoal once the ringed fire is heaped over", () => {
  const [w, a, fire] = setup();
  put(w, a, "stone", 3);
  giveItems(w, a, "log");
  expect(Object.keys(heated(w, a, { items: ["log"] }).gives)[0]).toBe("burning:log");
  expect(put(w, a, "stone", 3).builds).toBe("kiln");
  expect(fire.covered).toBe(true);
  giveItems(w, a, "log");
  expect(heated(w, a, { items: ["log"] }).gives).toEqual({ charcoal: 2 });
});

test("hammering hot metal at a charcoal fire draws out a blade sharper and tougher than flint; cold metal only dents", () => {
  const [w, a] = setup();
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
  const [w, a] = setup();
  a.born = w.t - 1e6;
  giveItems(w, a, "sharp_stone", 11);
  for (const k of ["stick", "clay", "stone", "fiber", "bone"]) giveItems(w, a, k);
  expect(a.inv.length).toBe(16);
  expect(giveItems(w, a, "berry", 3)).toBe(3);
  expect(count(a, "berry")).toBe(3);
  expect(count(a, "sharp_stone")).toBe(8);
});

test("hands full of food still make room for a stick", () => {
  const [w, a] = setup();
  a.born = w.t - 1e6;
  giveItems(w, a, "grain", 16);
  expect(giveItems(w, a, "stick")).toBe(1);
  expect(count(a, "stick")).toBe(1);
  expect(count(a, "grain")).toBe(15);
});

// Whether a try comes off follows from what anyone trying could notice: the same things in hand, weather and spot give
// the same outcome every time, and changing what decides it changes it.
test("struck over fiber, two hard stones light it after the same number of blows every time, flint sooner than plain stone; in the rain the sparks always hiss out, and over a stick they never catch", () => {
  const [w, a] = fresh();
  const light = (tool: string, target: string, over: string) => {
    a.inv = [];
    giveItems(w, a, tool); giveItems(w, a, target); giveItems(w, a, over);
    return hammer(w, a, tool, target, over);
  };
  w.weather.sky = "clear";
  const stone = Array.from({ length: 5 }, () => light("stone", "stone", "fiber"));
  expect(stone.every((o) => o.builds === "fire")).toBe(true);
  expect(new Set(stone.map((o) => o.numbers?.blows)).size).toBe(1);
  const flint = light("stone", "flint", "fiber");
  expect(flint.builds).toBe("fire");
  expect(flint.numbers!.blows).toBeLessThan(stone[0].numbers!.blows);
  w.weather.sky = "rain";
  const soaked = Array.from({ length: 5 }, () => light("stone", "stone", "fiber"));
  expect(soaked.every((o) => !o.ok && /hissed out in the wet fiber/.test(o.text))).toBe(true);
  w.weather.sky = "clear";
  const stick = light("stone", "stone", "stick");
  expect(stick.ok).toBe(false);
  expect(stick.text).toMatch(/isn't fine and dry enough/);
});

test("knapping stone with stone chips off a sharp stone at the same blow every time, fiber in hand or not; a striker too soft never does, and it shows", () => {
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
  expect(soft.text).toMatch(/stick was too soft/);
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

test("a line or a basket dipped where a fish swims within reach catches every time, and with none about never does: that's put down to no fish close by, which only what's dipped in the water records", () => {
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
    expect(out.text).toMatch(/no fish/);
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
    expect(out.text).toMatch(/too far off/);
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

test("a quench rule of several parts holds only where every part does, and what shows of it is its first plain part", () => {
  const [w, a] = fresh();
  // the light as it is under the rain, tick by tick over a day
  w.weather.sky = "rain";
  const from = w.t, ticks = Array.from({ length: 300 }, (_, i) => from + i);
  const dark = (t: number) => { w.t = t; return lightOn(w, a).bright < DARK; };
  const nights = ticks.filter(dark), days = ticks.filter((t) => !dark(t));
  const strike = () => { giveItems(w, a, "stone", 2); giveItems(w, a, "fiber"); return hammer(w, a, "stone", "stone", "fiber"); };
  const saved = RULES.quench;
  try {
    RULES.quench = ["dark+rain", "rain+!wind"];
    w.weather.speed = 2;
    w.t = days[0];
    expect(quenched(w, a)).toBe("rain+!wind");
    w.t = nights[0];
    expect(quenched(w, a)).toBe("dark+rain");
    expect(strike().text).toMatch(/In the dark the sparks fell wide of the fiber/);
    w.weather.speed = 60;
    w.t = days[1];
    expect(WEATHER_NOW.wind(w, a)).toBe(true);
    expect(quenched(w, a)).toBeNull();
    expect(strike().builds).toBe("fire");
    RULES.quench = ["!wind+rain"];
    w.weather.speed = 2;
    w.t = days[2];
    expect(strike().text).toMatch(/hissed out in the wet fiber/);
    w.weather.sky = "clear";
    w.t = days[3];
    expect(quenched(w, a)).toBeNull();
  } finally {
    RULES.quench = saved;
  }
});
