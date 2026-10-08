import { expect, test } from "bun:test";
import { DAY, TILE_M, addThing, newWorld, type Agent, type Shelter, type Stack, type World } from "./world";
import { DAMP, deadAt, emc, equilibrium, tinderOf, wetness } from "./wetness";
import { PHYS, WOODS } from "./fuel";
import { airOn, vapourAt } from "./air";
import { dropStacks, giveItems, giveStack, strikeTick } from "./physics";
import { nearestThing, put } from "./space";
import { canopyAt } from "./light";
import { needs } from "./sim";

// Before Unit 4 (materials.test.ts, as it stood): fiber held in the rain soaked past SOAKED, 0.6 of a wetness running 0
// to 1, within the hour; eight clear hours on it was drier than DAMP, 0.3; in a bag it stayed drier than DAMP through
// two hours of rain. Those were rates set by hand. What follows is fire-constants sections 5, 11, 18, 20 and 27f.

const setup = (): [World, Agent] => {
  const w = newWorld(42), a = w.agents[0];
  a.inv = []; a.wearing = null; delete a.skin; a.born = w.t - 1e6;
  return [w, a];
};
// The next day at an hour, and hours on from now, the water in everything moving each hour.
const at = (w: World, hour: number) => { w.t = (Math.floor(w.t / DAY) + 1) * DAY + hour * 12; };
const hours = (w: World, n: number) => { for (let i = 0; i < n; i++) { w.t = (Math.floor(w.t / 12) + 1) * 12; wetness(w); } };
const held = (a: Agent, k: string) => a.inv.find((s) => s.k === k)!;
const round = (k: string, d: number, m: number, extra: Partial<Stack> = {}): Stack => ({ k, hp: 1, born: 0, m, size: { d, len: 1, mass: (Math.PI / 4) * d * d * 450 }, ...extra });
const HUT: Shelter = { tier: 1, style: "sticks", cover: 0.6, insul: 0.3, sturdy: 0.4, flam: 0.6, room: 1 };
// someone else, 60 m off, under a roof of their own, by a fire if asked
function apart(w: World, a: Agent, i: number, fire = false) {
  const b = w.agents[i];
  b.inv = []; b.wearing = null;
  put(w, b, a.px + (60 * i) / TILE_M, a.py);
  addThing(w, "structure", b.px, b.py, { shelter: HUT, parts: { stick: 6 } });
  if (fire) addThing(w, "fire", b.px + 1 / TILE_M, b.py, { hp: 400, maxHp: 400 });
  return b;
}

test("in rain with nothing over them, a blade-thin fiber soaks to all it holds within the hour, while a log has barely moved", () => {
  const [w, a] = setup();
  giveItems(w, a, "fiber", 1, 0.1);
  giveStack(w, a, round("log", 0.1, 0.2));
  w.weather.sky = "rain";
  hours(w, 1);
  expect(held(a, "fiber").m).toBeCloseTo(PHYS.fiber.mmax, 2);
  expect(held(a, "log").m! - 0.2).toBeLessThan(0.01);
});

test("out of the rain thin fuel dries within hours while a log takes days, and a stick lying in the sun and wind dries faster than one in still shade", () => {
  const [w, a] = setup();
  at(w, 7);
  Object.assign(w.weather, { sky: "clear", speed: 4 });
  giveItems(w, a, "fiber", 1, PHYS.fiber.mmax);
  giveStack(w, a, round("log", 0.1, 0.5));
  // two sticks on the ground a few meters apart in the open, one under a roof
  let open = { px: a.px, py: a.py };
  for (let r = 0; canopyAt(w, open.px, open.py) > 0.01 && r < 2000; r += 5) open = { px: a.px + r / TILE_M, py: a.py };
  const shade = { px: open.px, py: open.py + 8 / TILE_M };
  addThing(w, "structure", shade.px, shade.py, { shelter: HUT, parts: { stick: 6 } });
  dropStacks(w, open.px, open.py, [round("stick", 0.025, 0.5)]);
  dropStacks(w, shade.px, shade.py, [round("stick", 0.025, 0.5)]);
  const lying = (at: { px: number; py: number }) => nearestThing(w, at.px, at.py, ["item"], (t) => t.item === "stick", 2)!.pieces![0];
  hours(w, 8);
  expect(held(a, "fiber").m!).toBeLessThan(0.3);
  expect(held(a, "log").m!).toBeGreaterThan(0.49);
  expect(lying(open).m!).toBeLessThan(lying(shade).m!);
});

test("a stick 12.7 mm thick comes about 63% of the way to new air in ten hours", () => {
  const [w, a] = setup();
  at(w, 0);
  const b = apart(w, a, 1);
  giveStack(w, b, round("stick", 0.0127, 0.5));
  hours(w, 10);
  const air = airOn(w, b, true), eq = equilibrium(air.temp, vapourAt(w, b.px, b.py, w.t));
  expect((0.5 - held(b, "stick").m!) / (0.5 - eq)).toBeGreaterThan(0.55);
  expect((0.5 - held(b, "stick").m!) / (0.5 - eq)).toBeLessThan(0.72);
});

test("in a bag or under a roof tinder takes no rain but still dries, and dries faster by a fire", () => {
  const [w, a] = setup();
  w.kinds.bag = { id: "bag", name: "bag", props: { container: 0.75, flexible: 0.7 } };
  giveItems(w, a, "bag");
  giveItems(w, a, "fiber", 1, 0.5);
  const b = apart(w, a, 1), c = apart(w, a, 2, true);
  giveItems(w, b, "fiber", 1, 0.5);
  giveItems(w, c, "fiber", 1, 0.5);
  w.weather.sky = "rain";
  hours(w, 1);
  for (const x of [a, b, c]) expect(held(x, "fiber").m!).toBeLessThan(0.5);
  expect(held(c, "fiber").m!).toBeLessThan(held(b, "fiber").m!);
});

test("a stick broken off a living hazel starts as wet as hazel grows, and seasons over days", () => {
  const [w, a] = setup();
  w.kinds.axe = { id: "axe", name: "axe", props: { sharp: 0.9, heavy: 0.8, hard: 0.9, long: 0.8, toughness: 1 } };
  giveItems(w, a, "axe");
  const bush = addThing(w, "bush", a.px, a.py, { species: "hazel", size: 2.5 });
  const st = { progress: 0 };
  for (let i = 0; i < 200 && !strikeTick(w, a, { verb: "strike", items: [], tool: "axe", target: { kind: "bush", thing: bush.id } }, st).done; i++);
  const stick = held(a, "stick");
  expect([stick.m, stick.green]).toEqual([WOODS.hazel.green, true]);
  Object.assign(w.weather, { sky: "clear", speed: 3 });
  hours(w, 72);
  expect(stick.m!).toBeLessThan(WOODS.hazel.green! - 0.05);
  expect(stick.m!).toBeGreaterThan(0.3);
});

test("damp tinder carried in a bag through a dry day catches a spark", () => {
  const [w, a] = setup();
  at(w, 6);
  Object.assign(w.weather, { sky: "clear", speed: 3 });
  w.kinds.bag = { id: "bag", name: "bag", props: { container: 0.75, flexible: 0.7 } };
  giveItems(w, a, "bag");
  giveItems(w, a, "fiber", 1, 0.3);
  giveItems(w, a, "stone", 2);
  hours(w, 12);
  expect(held(a, "fiber").m!).toBeLessThanOrEqual(DAMP);
  const st = { progress: 0 };
  let r;
  do r = strikeTick(w, a, { verb: "strike", items: ["fiber"], tool: "stone", target: { kind: "stone" } }, st); while (!r.done);
  expect(r.out!.builds).toBe("fire");
});

test("dead stuff holds more water the damper the air and less the warmer, in each of Simard's bands", () => {
  for (const t of [5, 25]) expect(emc(0.05, t)).toBeLessThan(emc(0.3, t));
  for (const t of [5, 25]) expect(emc(0.3, t)).toBeLessThan(emc(0.8, t));
  for (const rh of [0.05, 0.3, 0.8]) expect(emc(rh, 30)).toBeLessThan(emc(rh, 0));
});

test("reading the water in dead twigs about them leaves the bush they stand on as it grew", () => {
  const [w, a] = setup();
  const bush = addThing(w, "dead_bush", a.px, a.py, { size: 1 }), before = JSON.stringify(bush);
  const twigs = tinderOf(w, a)!;
  expect(twigs.m).toBe(deadAt(w, a, 0.00635));
  expect(JSON.stringify(bush)).toBe(before);
});

test("soaked clothes, or bare skin in the rain, lose a body's heat faster than dry", () => {
  const [w, a] = setup();
  at(w, 2);
  Object.assign(w.weather, { sky: "clear", speed: 2, temp: -2 });
  const loss = (dress: () => void) => {
    a.needs.warmth = 50;
    dress();
    needs(w, a);
    return 50 - a.needs.warmth;
  };
  const hide = (m: number) => () => { a.wearing = { k: "hide", hp: 1, born: 0, m }; delete a.skin; };
  expect(loss(hide(PHYS.hide.mmax))).toBeGreaterThan(loss(hide(0)));
  expect(loss(() => { a.wearing = null; a.skin = 1; })).toBeGreaterThan(loss(() => { a.wearing = null; delete a.skin; }));
});
