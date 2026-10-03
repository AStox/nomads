import { expect, test } from "bun:test";
import { DAY, addThing, meters, newWorld, type Act, type Agent, type World } from "./world";
import { count, giveItems, heat, join, place, rubTick, strikeDamage, strikeTick, type Outcome } from "./physics";
import { thingById } from "./space";
import { cameOff, record, type Belief } from "./beliefs";
import { plan } from "./plan";
import { tick } from "./sim";

const fresh = (): [World, Agent] => { const w = newWorld(42); const a = w.agents[0]; a.inv = []; return [w, a]; };
const K = (w: World, id: string) => w.kinds[id];

test("a heavier, sharper, longer tool fells a tree faster, and bare hands barely mark it", () => {
  const [w, a] = fresh();
  giveItems(w, a, "sharp_stone"); giveItems(w, a, "stick"); giveItems(w, a, "fiber", 2);
  const cord = join(w, a, { verb: "join", items: ["fiber", "fiber"] });
  if (cord === "ask") throw new Error("cord should not need a ruling");
  const axe = join(w, a, { verb: "join", items: [...Object.keys(cord.gives), "sharp_stone", "stick"] });
  if (axe === "ask") throw new Error("axe should not need a ruling");
  const hafted = K(w, Object.keys(axe.gives)[0]);
  const tree = 0.55;
  const dmg = [K(w, "stone"), K(w, "sharp_stone"), hafted].map((k) => strikeDamage(k, tree));
  expect(strikeDamage({ id: "hands", name: "", props: { hard: 0.2, heavy: 0.1 } }, tree)).toBe(0);
  expect(dmg[0]).toBeGreaterThan(0);
  expect(dmg[1]).toBeGreaterThan(dmg[0]);
  expect(dmg[2]).toBeGreaterThan(dmg[1]);
});

test("striking a stone with a stone eventually chips off a sharp stone", () => {
  const [w, a] = fresh();
  giveItems(w, a, "stone", 30);
  let got = false;
  for (let i = 0; i < 200 && !got; i++) {
    const st = { progress: 0 };
    let r;
    do r = strikeTick(w, a, { verb: "strike", items: [], tool: "stone", target: { kind: "stone" } }, st); while (!r.done);
    got = count(a, "sharp_stone") > 0;
  }
  expect(got).toBe(true);
});

test("rubbing sticks with a bow and tinder makes a fire; without tinder it only gets hot", () => {
  const [w, a] = fresh();
  giveItems(w, a, "stick", 3); giveItems(w, a, "fiber", 2);
  const bow = join(w, a, { verb: "join", items: ["fiber", "fiber"] });
  if (bow === "ask") throw new Error();
  const strung = join(w, a, { verb: "join", items: [Object.keys(bow.gives)[0], "stick"] });
  if (strung === "ask") throw new Error();
  const bowId = Object.keys(strung.gives)[0];
  const rub = (act: Act) => { const st = { progress: 0 }; let r; do r = rubTick(w, a, act, st); while (!r.done); return r.out!; };
  expect(rub({ verb: "rub", items: [bowId, "stick"] }).effect).toBe("heat"); // no fiber left
  giveItems(w, a, "fiber");
  w.weather.sky = "clear";
  expect(rub({ verb: "rub", items: [bowId, "stick"] }).builds).toBe("fire");
  expect(w.things.some((t) => t.kind === "fire" && meters(t, a) <= 2)).toBe(true);
});

test("sticks leaned together shelter someone; enough logs make it a sturdier hut", () => {
  const [w, a] = fresh();
  giveItems(w, a, "stick", 6); giveItems(w, a, "fiber", 3);
  const lean = place(w, a, { verb: "place", items: ["stick", "stick", "stick", "stick", "stick", "fiber", "fiber", "fiber"] });
  expect(lean.builds).toBe("shelter");
  const home = thingById(w, a.home)!;
  const before = home.shelter!;
  giveItems(w, a, "log", 6);
  place(w, a, { verb: "place", items: Array(6).fill("log") });
  expect(home.shelter!.tier).toBeGreaterThanOrEqual(before.tier);
  expect(home.shelter!.sturdy).toBeGreaterThan(before.sturdy);
});

test("cooking in a fired bowl makes a stew and keeps the bowl", () => {
  const [w, a] = fresh();
  addThing(w, "fire", a.px, a.py, { hp: 100 });
  w.kinds["pot"] = { id: "pot", name: "fired clay bowl", props: { container: 0.8, hard: 0.75 } };
  giveItems(w, a, "pot"); giveItems(w, a, "mushroom");
  const out = heat(w, a, { verb: "heat", items: ["pot", "mushroom"], at: "fire" });
  if (out === "ask") throw new Error();
  expect(out.ok).toBe(true);
  expect(count(a, "pot")).toBe(1);
  expect(Object.keys(out.gives)[0]).toContain("stew");
});

test("the planner only uses what an agent believes works", () => {
  const [w, a] = fresh();
  const dist = { stone: 3, stick: 2, reeds: 3, tree: 4 };
  const ctx = () => ({ dist, beliefs: Object.values(a.beliefs), facts: a.facts, kinds: w.kinds, toxic: [] });
  const start = { inv: {}, at: null, flags: [] };
  expect(plan(start, "make:sharp_stone", ctx())).toBeNull();
  giveItems(w, a, "stone", 2);
  let out;
  for (let i = 0; i < 300; i++) {
    const st = { progress: 0 };
    let r;
    do r = strikeTick(w, a, { verb: "strike", items: [], tool: "stone", target: { kind: "stone" } }, st); while (!r.done);
    out = r.out!;
    if (out.ok) break;
    giveItems(w, a, "stone");
  }
  record(w, a, out!, 5);
  const steps = plan(start, "make:sharp_stone", ctx())!;
  expect(steps.at(-1)?.op).toBe("act");
  expect(steps.filter((s) => s.op === "pick_stone").length).toBe(2);
});

test("out in the rain rubbing sticks is soaked within the hour, and someone who has come to think fire won't light in the rain plans none while it rains", () => {
  const [w, a] = fresh();
  const rub = () => { const st = { progress: 0 }; let r, n = 0; do { r = rubTick(w, a, { verb: "rub", items: ["stick", "stick"] }, st); n++; } while (!r.done); return { out: r.out!, n }; };
  giveItems(w, a, "stick", 2); giveItems(w, a, "fiber");
  w.weather.sky = "clear";
  const lit = rub().out;
  expect(lit.builds).toBe("fire");
  const knows = record(w, a, lit, 30)!;
  giveItems(w, a, "stick", 2); giveItems(w, a, "fiber");
  w.weather.sky = "rain";
  const soaked = rub();
  expect(soaked.out.builds).toBeUndefined();
  expect(soaked.n).toBeLessThanOrEqual(12);
  const ctx = (now: string[]) => ({ dist: { stick: 2, reeds: 3 }, beliefs: Object.values(a.beliefs), facts: a.facts, kinds: w.kinds, toxic: [], now });
  const start = { inv: { stick: 2, fiber: 1 }, at: null, flags: [] };
  // with no theory of why it failed, they would try again
  expect(plan(start, "make_fire", ctx(["rain"]))).not.toBeNull();
  knows.unless = ["rain"];
  expect(plan(start, "make_fire", ctx(["rain", "dark"]))).toBeNull();
  expect(plan(start, "make_fire", ctx(["dark"]))).not.toBeNull();
});

test("someone who has seen wood laid on a fire plans to keep a dying fire going with what they carry", () => {
  const [w, a] = fresh();
  const fire = addThing(w, "fire", a.px, a.py, { hp: 40, maxHp: 400 });
  giveItems(w, a, "stick", 2);
  const ctx = () => ({ dist: { stick: 2 }, beliefs: Object.values(a.beliefs), facts: a.facts, kinds: w.kinds, toxic: [] });
  expect(plan({ inv: { stick: 1 }, at: "fire", flags: [] }, "tend_fire", ctx())).toBeNull();
  const fed = place(w, a, { verb: "place", items: ["stick"] });
  expect(fed.builds).toBe("fed_fire");
  expect(fire.hp!).toBeGreaterThan(70);
  record(w, a, fed, 1);
  expect(plan({ inv: { stick: 1 }, at: "fire", flags: [] }, "tend_fire", ctx())?.at(-1)?.op).toBe("act");
});

// Two ways they know to light a fire, with the record of each, all told and in the rain.
const fireBelief = (tinder: string, tries: number, wins: number, rain: { tries: number; wins: number }): Belief => ({
  key: `rub|${[tinder, "stick", "stick"].sort().join("+")}|-|-|-|-`, fields: { verb: "rub", inputs: ["stick", "stick", tinder], gives: [], builds: "fire" },
  uses: { [tinder]: 1 }, out: {}, ticks: 20, tries, wins, tally: { tries, wins }, how: "discovered", t: 0, when: { rain },
});

test("knowing two ways to light a fire, they use whichever has worked best for them in the conditions they're in", () => {
  const [w] = fresh();
  const fiber = fireBelief("fiber", 10, 9, { tries: 3, wins: 0 }), bark = fireBelief("bark", 4, 3, { tries: 2, wins: 2 });
  const ctx = (now: string[]) => ({ dist: {}, beliefs: [fiber, bark], facts: {}, kinds: w.kinds, toxic: [], now });
  const start = { inv: { stick: 2, fiber: 1, bark: 1 }, at: null, flags: [] };
  expect(plan(start, "make_fire", ctx([]))?.at(-1)?.key).toBe(fiber.key);
  expect(plan(start, "make_fire", ctx(["rain"]))?.at(-1)?.key).toBe(bark.key);
});

test("someone who thinks fire won't light in the rain lights none in the rain, unless they set out to test it", () => {
  const [w] = fresh();
  const fiber = { ...fireBelief("fiber", 10, 9, { tries: 1, wins: 0 }), unless: ["rain"] };
  const ctx = (testing?: string) => ({ dist: {}, beliefs: [fiber], facts: {}, kinds: w.kinds, toxic: [], now: ["rain"], testing });
  const start = { inv: { stick: 2, fiber: 1 }, at: null, flags: [] };
  expect(plan(start, "make_fire", ctx())).toBeNull();
  expect(plan(start, `try:${fiber.key}`, ctx(fiber.key))?.map((s) => s.op)).toEqual(["act"]);
});

test("striking stone for fire in the rain only chips it: that's no fire, and it doesn't count as having worked; dry, a spark that catches does", () => {
  const [w, a] = fresh();
  const b: Belief = {
    key: "strike|fiber+stone|stone|stone|-|-", fields: { verb: "strike", inputs: ["fiber", "stone"], tool: "stone", target: "stone", gives: [], builds: "fire" },
    uses: { fiber: 1 }, out: {}, ticks: 3, tries: 1, wins: 1, how: "discovered", t: 0,
  };
  // strikes with tinder in hand until one comes off one way or the other
  const strikeUntil = (ok: (o: Outcome) => boolean) => {
    for (let i = 0; i < 200; i++) {
      giveItems(w, a, "stone", 2); giveItems(w, a, "fiber");
      const st = { progress: 0 };
      let r;
      do r = strikeTick(w, a, { verb: "strike", items: [], tool: "stone", target: { kind: "stone" } }, st); while (!r.done);
      if (ok(r.out!)) return r.out!;
    }
    throw new Error("never came off");
  };
  w.weather.sky = "rain";
  const chipped = strikeUntil((o) => o.ok);
  expect(chipped.builds).toBeUndefined();
  expect(cameOff(b, chipped)).toBe(false);
  w.weather.sky = "clear";
  expect(cameOff(b, strikeUntil((o) => o.builds === "fire"))).toBe(true);
});

test("rain that starts after they planned a fire stops them rubbing sticks, if they think fire won't light in the rain", () => {
  const [w, a] = fresh();
  w.agents = [a];
  const b = { ...fireBelief("fiber", 10, 9, { tries: 2, wins: 0 }), unless: ["rain"] };
  a.beliefs = { [b.key]: b };
  giveItems(w, a, "stick", 2); giveItems(w, a, "fiber");
  a.needs = { food: 100, energy: 100, warmth: 100, health: 100, social: 100 };
  a.nextDecide = w.t + DAY;
  a.goal = { type: "make_fire", since: w.t, odds: {}, fails: 0 };
  a.plan = [{ op: "act", key: b.key, arg: b.key, progress: 0 }];
  // the sky only turns on the twelfth tick: this one keeps the rain
  w.t = Math.ceil(w.t / 12) * 12 + 1;
  w.weather.sky = "rain";
  tick(w);
  expect(b.tally).toEqual({ tries: 10, wins: 9 });
  expect(a.goal?.type).not.toBe("make_fire");
  expect(count(a, "fiber")).toBe(1);
});
