import { expect, test } from "bun:test";
import { DAY, meters, newWorld, type Act, type Agent, type Stack, type Step, type World } from "./world";
import { LEAST, advance, alight, output, radiation } from "./combustion";
import { PHYS, pieceOf, roundSize } from "./fuel";
import { ensure } from "./materials";
import { GALE, ablaze, bedAir, breeze, carry, count, fireHours, fireOf, giveItems, giveStack, heat, join, place, rubTick, strikeDamage, strikeTick, type Fields, type Outcome } from "./physics";
import { DAMP, SOAKED } from "./wetness";
import { thingById } from "./space";
import { apart, beliefKey, cameOff, chance, differed, fades, noteTry, record, refuted, rethink, suspected, teach, weighs, worseIn, type Belief } from "./beliefs";
import { plan } from "./plan";
import { actFromBelief, conditionsNow, doAct, tick, tinkerOptions } from "./sim";

const fresh = (): [World, Agent] => { const w = newWorld(42); const a = w.agents[0]; a.inv = []; return [w, a]; };
const K = (w: World, id: string) => w.kinds[id];
// Pieces of wood as the island gives them (fuel.ts): half-meter twigs off the ground, the stems of a 2 m hazel, a meter of
// a full-grown oak's trunk; things held, so many of them, this wet (tinder kept against the body at 6%, wood kept in at
// 10%, the most a spark catches in, fire-constants secs. 10, 18); and air with no wind and no rain.
const TWIG = pieceOf({ kind: "stick", size: 0.5 }, "stick")!, STICK = pieceOf({ kind: "bush", species: "hazel", size: 2 }, "stick")!;
const LOG = pieceOf({ kind: "tree", species: "oak", size: 15 }, "log")!;
const DRY = 0.1, KEPT = 0.06;
const hold = (w: World, a: Agent, k: string, n: number, m: number, piece: Partial<Stack> = {}) => { for (let i = 0; i < n; i++) giveStack(w, a, { k, hp: 1, born: w.t, m, ...piece }); };
const still = (w: World) => { w.weather.sky = "clear"; w.weather.speed = 0; w.t++; };
const sticks = (n: number) => Array<string>(n).fill("stick");
// Striking stone on stone over a lay until the strike comes to something.
const strike = (w: World, a: Agent, items: string[]) => {
  const st = { progress: 0 };
  let r;
  do r = strikeTick(w, a, { verb: "strike", items, tool: "stone", target: { kind: "stone" } }, st); while (!r.done);
  return r.out!;
};
// The usual fire (fireOf) an hour or so on, its logs' flame just too small to light another log by its radiation, and
// still flaming: a dying flame, and a small fire.
function dying(w: World, a: Agent) {
  const fire = fireOf(w, a.px, a.py), air = bedAir(w, fire);
  while (output(fire.bed!, air).flaming > 0 && radiation(fire.bed!, air, PHYS.log) >= LEAST) fire.bed = advance(fire.bed!, 10, air);
  return fire;
}
// A flame they carry: a stick alight (a brand), or a lamp of fat with a fibre wick in a fired bowl, lit.
const brandKind = (w: World) => ensure(w.kinds, "burning:stick", () => ({ name: "burning stick", props: { ...w.kinds.stick.props, flammable: 1 }, parts: ["stick"], verb: "heat" }))[0];
function lampKind(w: World) {
  ensure(w.kinds, "pot", () => ({ name: "fired clay bowl", props: { container: 0.8, hard: 0.75 } }));
  ensure(w.kinds, "lamp", () => ({ name: "bowl filled with fat and a fiber wick", props: { container: 0.8, hard: 0.75, flammable: 0.8 }, parts: ["fat", "fiber", "pot"], verb: "join" }));
  return ensure(w.kinds, "burning:lamp", () => ({ name: "lit lamp", props: { container: 0.8, hard: 0.75, flammable: 1 }, parts: ["lamp"], verb: "heat" }))[0];
}

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

test("rubbing a stick with a bow over tinder laid with twigs makes a fire; with nothing laid it only gets hot", () => {
  const [w, a] = fresh();
  still(w);
  giveItems(w, a, "stick", 2); giveItems(w, a, "fiber", 2);
  const bow = join(w, a, { verb: "join", items: ["fiber", "fiber"] });
  if (bow === "ask") throw new Error();
  const strung = join(w, a, { verb: "join", items: [Object.keys(bow.gives)[0], "stick"] });
  if (strung === "ask") throw new Error();
  const bowId = Object.keys(strung.gives)[0];
  const rub = (act: Act) => { const st = { progress: 0 }; let r; do r = rubTick(w, a, act, st); while (!r.done); return r.out!; };
  expect(rub({ verb: "rub", items: [bowId, "stick"] }).effect).toBe("heat");
  hold(w, a, "fiber", 1, KEPT); hold(w, a, "stick", 5, DRY, TWIG);
  const lit = rub({ verb: "rub", items: [bowId, "stick", "fiber", ...sticks(5)] });
  expect(lit.builds).toBe("fire");
  expect(beliefKey(lit.fields)).toBe(`rub|${[bowId, "stick"].sort().join("+")}+fiber+stick+stick+stick+stick+stick|-|-|-|-`);
  expect(w.things.some((t) => t.kind === "fire" && ablaze(t) && meters(t, a) <= 2)).toBe(true);
  // the bow and the stick it turned are still in hand; the lay is in the fire
  expect([count(a, bowId), count(a, "stick"), count(a, "fiber")]).toEqual([1, 1, 0]);
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
  fireOf(w, a.px, a.py);
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

test("rubbing sticks for an ember over tinder soaked through only makes them hot, and someone who has come to think fire won't light in the rain plans none while it rains", () => {
  const [w, a] = fresh();
  still(w);
  const lay = ["stick", "stick", "fiber", ...sticks(5)];
  const rub = () => { const st = { progress: 0 }; let r; do r = rubTick(w, a, { verb: "rub", items: lay }, st); while (!r.done); return r.out!; };
  const stock = (m: number) => { a.inv = []; giveItems(w, a, "stick", 2); hold(w, a, "fiber", 1, m); hold(w, a, "stick", 5, DRY, TWIG); };
  stock(KEPT);
  const lit = rub();
  expect(lit.builds).toBe("fire");
  const knows = record(w, a, lit, 30)!;
  stock(SOAKED + 0.05);
  const soaked = rub();
  expect(soaked.builds).toBeUndefined();
  expect(soaked.effect).toBe("heat");
  const ctx = (now: string[]) => ({ dist: { stick: 2, reeds: 3 }, beliefs: Object.values(a.beliefs), facts: a.facts, kinds: w.kinds, toxic: [], now });
  const start = { inv: { stick: 7, fiber: 1 }, at: null, flags: [] };
  // with no theory of why it failed, they would try again
  expect(plan(start, "make_fire", ctx(["rain"]))).not.toBeNull();
  knows.unless = ["rain"];
  expect(plan(start, "make_fire", ctx(["rain", "dark"]))).toBeNull();
  expect(plan(start, "make_fire", ctx(["dark"]))).not.toBeNull();
});

test("someone who has seen wood laid on a fire plans to keep it going with what they carry, and the wood goes into its bed", () => {
  const [w, a] = fresh();
  still(w);
  const fire = fireOf(w, a.px, a.py);
  fire.bed = advance(fire.bed!, 15 * 60, bedAir(w, fire));
  hold(w, a, "stick", 2, DRY, STICK);
  const ctx = () => ({ dist: { stick: 2 }, beliefs: Object.values(a.beliefs), facts: a.facts, kinds: w.kinds, toxic: [] });
  expect(plan({ inv: { stick: 1 }, at: "fire", flags: [] }, "tend_fire", ctx())).toBeNull();
  const before = fire.bed!.groups.length;
  const fed = place(w, a, { verb: "place", items: ["stick"] });
  expect(fed.builds).toBe("fed_fire");
  expect(fire.bed!.groups.length).toBe(before + 1);
  record(w, a, fed, 1);
  expect(plan({ inv: { stick: 1 }, at: "fire", flags: [] }, "tend_fire", ctx())?.at(-1)?.op).toBe("act");
});

// Two ways they know to light a fire, rubbing two sticks for an ember to blow into tinder, with the record of each, all
// told and in the rain.
const fireBelief = (tinder: string, tries: number, wins: number, rain: { tries: number; wins: number }): Belief => ({
  key: `rub|stick+stick+${tinder}|-|-|-|-`, fields: { verb: "rub", inputs: ["stick", "stick", tinder], gives: [], builds: "fire" },
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

test("striking stone over a lay whose tinder is damp only throws sparks that won't catch: that's no fire, and it doesn't count as having worked; dry, the spark catches", () => {
  const [w, a] = fresh();
  still(w);
  const b: Belief = {
    key: "strike|fiber+stick+stick+stick+stone|stone|stone|-|-", fields: { verb: "strike", inputs: ["fiber", "stick", "stick", "stick", "stone"], tool: "stone", target: "stone", gives: [], builds: "fire" },
    uses: { fiber: 1, stick: 3 }, out: {}, ticks: 3, tries: 1, wins: 1, how: "discovered", t: 0,
  };
  // what they believe lights a fire is striking the stone over the fiber laid with three sticks
  const act = actFromBelief(b);
  expect(act.items).toEqual(["fiber", "stick", "stick", "stick"]);
  const tried = (m: number) => { a.inv = []; giveItems(w, a, "stone", 2); hold(w, a, "fiber", 1, m); hold(w, a, "stick", 3, DRY, TWIG); return strike(w, a, act.items); };
  const drowned = tried(DAMP + 0.02);
  expect(drowned.ok).toBe(false);
  expect(drowned.builds).toBeUndefined();
  expect(cameOff(b, drowned)).toBe(false);
  expect(cameOff(b, tried(KEPT))).toBe(true);
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

test("a condition is only suspected when it has done worse there by more than chance: a couple of berries lost in the dark among many aren't enough, a run of them in the shade is", () => {
  const berries = (when: Belief["when"], tries: number, wins: number): Belief => ({
    key: "plant|berry|-|-|-|-", fields: { verb: "plant", inputs: ["berry"], gives: [], builds: "bush" }, uses: { berry: 1 }, out: {},
    ticks: 3, tries, wins, tally: { tries, wins }, how: "discovered", t: 0, when,
  });
  // 3 of 5 in the dark against 6 of 9 out of it: no worse than luck
  expect(worseIn(berries({ dark: { tries: 5, wins: 3 } }, 14, 9), "dark")).toBe(false);
  // 1 of 6 in the shade against 8 of 10 out of it
  expect(worseIn(berries({ shade: { tries: 6, wins: 1 } }, 16, 9), "shade")).toBe(true);
  // a single failure there says little either way
  expect(worseIn(berries({ shade: { tries: 1, wins: 0 } }, 11, 8), "shade")).toBe(false);
});

test("a theory that it won't work in the rain stands while it has never once worked there, however rarely it works anywhere; it fades once it works there about as often as not", () => {
  const sparks = (rain: { tries: number; wins: number }, tries: number, wins: number): Belief => ({
    key: "strike|fiber+stone|stone|stone|-|-", fields: { verb: "strike", inputs: ["fiber", "stone"], tool: "stone", target: "stone", gives: [], builds: "fire" },
    uses: { fiber: 1 }, out: {}, ticks: 3, tries, wins, tally: { tries, wins }, how: "discovered", t: 0, when: { rain }, unless: ["rain"],
  });
  // never in 6 strikes in the rain, 2 of 12 out of it
  expect(fades(sparks({ tries: 6, wins: 0 }, 18, 2), "rain")).toBe(false);
  // 2 of 4 in the rain, 3 of 6 out of it
  expect(fades(sparks({ tries: 4, wins: 2 }, 10, 5), "rain")).toBe(true);
});

// Striking a spark into tinder, as someone who has lit a fire that way would know it, and their tries of it one by one:
// n tries in what they could see (now), every other one catching (from the first) or none.
const striking = (): Belief => ({
  key: "strike|fiber+stone|stone|stone|-|-", fields: { verb: "strike", inputs: ["fiber", "stone"], tool: "stone", target: "stone", gives: [], builds: "fire" },
  uses: { fiber: 1 }, out: {}, ticks: 3, tries: 1, wins: 1, how: "discovered", t: 0,
});
const tries = (b: Belief, now: string[], n: number, catches: boolean) => { for (let i = 0; i < n; i++) noteTry(b, catches && i % 2 === 0, now); };

test("where the rain falls mostly at night, the dark is suspected along with it until it has been seen dark and dry often enough: like for like, it does as well as by day, and the rain takes the blame alone; to someone who already blames the rain, sooner", () => {
  const b = striking();
  // by day it catches every other time; at night it rains, and it never does
  for (let i = 0; i < 4; i++) { tries(b, [], 4, true); tries(b, ["dark", "rain"], 2, false); }
  // never seen apart, either could be why
  expect(worseIn(b, "dark")).toBe(true);
  expect(worseIn(b, "rain")).toBe(true);
  // dark and dry, it catches as often as by day; dark and raining it still never does
  const blames: Belief = { ...structuredClone(b), unless: ["rain"] };
  const night = (x: Belief) => { tries(x, ["dark"], 2, true); tries(x, [], 2, true); tries(x, ["dark", "rain"], 1, false); };
  for (let i = 0; i < 2; i++) { night(b); night(blames); }
  expect(worseIn(b, "dark")).toBe(true);
  expect(worseIn(blames, "dark")).toBe(false);
  for (let i = 0; i < 6; i++) night(b);
  expect(worseIn(b, "dark")).toBe(false);
  expect(worseIn(b, "rain")).toBe(true);
});

test("once the rain stops mattering, the sparks that died in it are never forgotten: the theory stands until the tries there that catch have come to make it look no worse than anywhere, like for like; the wind that kills them all along keeps its theory", () => {
  const b = striking();
  b.unless = ["rain", "wind"];
  // for a long while the rain and the wind each killed every spark; out of both it caught every other time
  for (let i = 0; i < 20; i++) { tries(b, [], 2, true); tries(b, ["rain"], 1, false); tries(b, ["wind"], 1, false); }
  expect(fades(b, "rain")).toBe(false);
  // then the rain stopped mattering: in the rain it catches every other time, as out of it, and the wind still kills it
  let rounds = 0;
  while (!fades(b, "rain") && rounds < 60) { tries(b, [], 2, true); tries(b, ["rain"], 2, true); tries(b, ["wind"], 1, false); rounds++; }
  // twenty failures take as many good rounds and more to outweigh
  expect(rounds).toBeGreaterThan(20);
  expect(rounds).toBeLessThan(60);
  for (let i = 0; i < 30; i++) { tries(b, [], 2, true); tries(b, ["wind"], 1, false); }
  expect(fades(b, "wind")).toBe(false);
});

test("a spark that catches in the rain after twenty that died there doesn't wipe them: the theory still rests on them, and what was different that once (the wind was up, as it never was when they died) is the exception it offers, not the dark that came with half of them", () => {
  const b = striking();
  b.unless = ["rain"];
  for (let i = 0; i < 10; i++) { tries(b, [], 2, true); tries(b, ["rain"], 1, false); tries(b, ["dark", "rain"], 1, false); }
  noteTry(b, true, ["rain", "wind"]);
  expect(weighs(b, "rain")).toEqual({ fails: 20, wins: 1 });
  expect(differed(b, "rain", ["rain", "wind"]).map((x) => [x.theory, x.agree])).toEqual([["!wind+rain", 1]]);
});

test("an exception they believe in goes once it has failed as often as it worked: a spark dying in the rain with the wind up takes them back to blaming the rain, and one that caught there doesn't", () => {
  const b = striking();
  b.unless = ["!wind+rain"];
  for (let i = 0; i < 5; i++) { tries(b, [], 2, true); tries(b, ["rain"], 1, false); }
  noteTry(b, true, ["rain", "wind"]);
  expect(refuted(b, ["rain", "wind"])).toEqual([]);
  noteTry(b, false, ["rain", "wind"]);
  expect(refuted(b, ["rain", "wind"])).toEqual([{ theory: "!wind+rain", to: "rain" }]);
  // where the theory holds, the failure is its own, and nothing is refuted
  expect(refuted(b, ["rain"])).toEqual([]);
});

// Planting berries, as someone who has seen one come up would know it, on grassland (GRASS) or in the shade there (SHADE).
const planting = (): Belief => ({
  key: "plant|berry|-|-|-|-", fields: { verb: "plant", inputs: ["berry"], gives: [], builds: "bush" }, uses: { berry: 1 }, out: {},
  ticks: 3, tries: 1, wins: 1, tally: { tries: 1, wins: 1 }, how: "discovered", t: 0,
});
const GRASS = ["ground:grassland"], SHADE = ["shade", "ground:grassland"];

test("one failure is one failure: a seedling lost in the shade after two came up there is no suspect, though it has done worse there", () => {
  const b = planting();
  for (let i = 0; i < 20; i++) noteTry(b, true, GRASS);
  for (const ok of [true, true, false]) noteTry(b, ok, SHADE);
  const d = apart(b, "shade");
  expect(d.diff).toBeGreaterThan(d.se);
  expect(worseIn(b, "shade")).toBe(false);
});

test("giving up the dark leaves the rain theory the record it rests on: dark and raining, the rain still explains every spark that died", () => {
  const b = striking();
  b.unless = ["rain", "dark"];
  // by day it catches every other time; at night it rains and none catch
  for (let i = 0; i < 6; i++) { tries(b, [], 2, true); tries(b, ["dark", "rain"], 2, false); }
  rethink(b, ["dark"]);
  expect(worseIn(b, "rain")).toBe(true);
});

test("a record kept before the weather had its mixes (an old save) keeps what it held of the rain through the first try after loading", () => {
  const b: Belief = { ...striking(), tries: 40, wins: 30, tally: { tries: 40, wins: 30 }, when: { rain: { tries: 10, wins: 0 } }, unless: ["rain"] };
  expect(worseIn(b, "rain")).toBe(true);
  noteTry(b, true, []);
  expect(worseIn(b, "rain")).toBe(true);
});

test("a way they were taught looks to them as any way they've yet to try does, and no surer than one that works for them", () => {
  const [w, teacher] = fresh();
  const learner = w.agents[1];
  const bark = fireBelief("bark", 30, 28, { tries: 0, wins: 0 }), fiber = fireBelief("fiber", 10, 8, { tries: 0, wins: 0 });
  teacher.beliefs = { [bark.key]: bark };
  learner.beliefs = { [fiber.key]: fiber };
  teach(w, teacher, learner, bark.key);
  const taught = learner.beliefs[bark.key];
  expect(chance(taught)).toBeCloseTo(0.5 + 0.3);
  const ctx = { dist: {}, beliefs: [fiber, taught], facts: {}, kinds: w.kinds, toxic: [], now: [] };
  expect(plan({ inv: { stick: 2, fiber: 1, bark: 1 }, at: null, flags: [] }, "make_fire", ctx)?.at(-1)?.key).toBe(fiber.key);
});

test("nothing about how a try failed points anywhere: a condition becomes a suspect only once their record shows it doing worse, never on one failure", () => {
  const b = striking();
  // it catches two times in five, whatever the weather
  for (let i = 0; i < 20; i++) noteTry(b, i % 5 < 2, []);
  noteTry(b, false, ["rain"]);
  expect(suspected(b, ["rain"])).toEqual([]);
  noteTry(b, false, ["rain"]);
  noteTry(b, false, ["rain"]);
  expect(suspected(b, ["rain"])).toEqual(["rain"]);
});

// ---------- lighting with a lay, feeding, and choosing pieces (fire plan, Unit 7) ----------
// No failure says why: what a person sees of it is the conditions they were in, never a cause in the words.
const CAUSES = /\b(damp|wet|soak\w*|wind\w*|breez\w*|thick|thin|small|big|coals?|cold|rain\w*|dark)\b/i;

test("struck over fiber laid with twigs and finger-thick sticks in still, dry air, a spark lights a fire that lasts; over fiber alone it flares and dies within the act, and says nothing of why", () => {
  const [w, a] = fresh();
  still(w);
  giveItems(w, a, "stone", 2); hold(w, a, "fiber", 1, KEPT); hold(w, a, "stick", 8, DRY, TWIG); hold(w, a, "stick", 5, DRY, STICK);
  const lit = strike(w, a, ["fiber", ...sticks(13)]);
  expect(lit.builds).toBe("fire");
  expect(beliefKey(lit.fields)).toBe(`strike|fiber+${sticks(13).join("+")}+stone|stone|stone|-|-`);
  const fire = w.things.find((t) => t.kind === "fire" && meters(t, a) <= 2)!;
  expect(ablaze(fire)).toBe(true);
  expect(count(a, "fiber") + count(a, "stick")).toBe(0);
  // the fibre alone: it flares, burns itself up, and no fire is left of it
  a.inv = [];
  giveItems(w, a, "stone", 2); hold(w, a, "fiber", 1, KEPT);
  const fires = w.things.filter((t) => t.kind === "fire").length;
  const flare = strike(w, a, ["fiber"]);
  expect(flare.ok).toBe(false);
  expect(flare.builds).toBeUndefined();
  expect(count(a, "fiber")).toBe(0);
  expect(w.things.filter((t) => t.kind === "fire").length).toBe(fires);
  expect(flare.text).not.toMatch(CAUSES);
});

test("a stick laid on a fire with an hour left lights; a log laid on a dying flame doesn't, and is seen laid as thick wood on a small fire", () => {
  const [w, a] = fresh();
  still(w);
  const fire = fireOf(w, a.px, a.py);
  fire.bed = advance(fire.bed!, 15 * 60, bedAir(w, fire));
  expect(fireHours(w, fire)).toBeGreaterThan(1);
  hold(w, a, "stick", 1, DRY, STICK);
  const fed = place(w, a, { verb: "place", items: ["stick"] });
  expect(fed.ok).toBe(true);
  expect(fed.builds).toBe("fed_fire");
  const [v, b] = fresh();
  still(v);
  const low = dying(v, b);
  expect(output(low.bed!, bedAir(v, low)).flaming).toBeGreaterThan(0);
  hold(v, b, "log", 1, DRY, LOG);
  expect(conditionsNow(v, b, "place", b, ["log"])).toEqual(expect.arrayContaining(["thick", "small"]));
  const laid = place(v, b, { verb: "place", items: ["log"] });
  expect(laid.ok).toBe(false);
  expect(laid.builds).toBeUndefined();
  expect(laid.text).not.toMatch(CAUSES);
  // laid on it all the same
  expect(count(b, "log")).toBe(0);
});

test("twigs laid on the coals a fire leaves once its flames are gone light it again", () => {
  const [w, a] = fresh();
  still(w);
  const fire = fireOf(w, a.px, a.py), air = bedAir(w, fire);
  while (fire.bed!.age < 30 * 60 || output(fire.bed!, air).flaming > 0) fire.bed = advance(fire.bed!, 60, air);
  expect(alight(fire.bed!)).toBe(true);
  hold(w, a, "stick", 5, DRY, TWIG);
  expect(conditionsNow(w, a, "place", a, sticks(5), undefined, 0)).toContain("coals");
  const fed = place(w, a, { verb: "place", items: sticks(5) });
  expect(fed.builds).toBe("fed_fire");
  // within the act's time after it, the fire flames again
  let bed = fire.bed!, flamed = false;
  for (let t = 0; t < 15 * 60 && !flamed; t += 10) flamed = output((bed = advance(bed, 10, air)), air).flaming > 0;
  expect(flamed).toBe(true);
});

test("someone who thinks thick wood won't take on a small fire lays their thinnest stick on one instead; without the theory, the first that comes to hand", () => {
  const thick = roundSize("generic", 0.04, 1);
  const feed = (theory: boolean) => {
    const [w, a] = fresh();
    still(w);
    dying(w, a);
    hold(w, a, "stick", 1, DRY, { size: thick }); hold(w, a, "stick", 1, DRY, STICK);
    const fields: Fields = { verb: "place", inputs: ["stick"], at: "fire", builds: "fed_fire", gives: [] };
    const b: Belief = { key: beliefKey(fields), fields, uses: { stick: 1 }, out: {}, ticks: 3, tries: 4, wins: 2, how: "discovered", t: 0, ...(theory ? { unless: ["small+thick"] } : {}) };
    a.beliefs = { [b.key]: b };
    const s: Step = { op: "act", key: b.key, act: actFromBelief(b), progress: 0 };
    let r;
    do r = doAct(w, a, s); while (r === "wait");
    return a.inv.find((x) => x.k === "stick")?.size;
  };
  // the one they kept
  expect(feed(true)).toEqual(thick);
  expect(feed(false)).toEqual(STICK.size);
});

test("a burning brand set into fiber and twigs lights them; a brand carried too long has burned out and lights nothing", () => {
  const [w, a] = fresh();
  still(w);
  brandKind(w);
  const brand: Stack = { k: "burning:stick", hp: 1, born: w.t, m: DRY, ...STICK };
  giveStack(w, a, { ...brand }); hold(w, a, "fiber", 1, KEPT); hold(w, a, "stick", 8, DRY, TWIG);
  const lit = place(w, a, { verb: "place", items: ["burning:stick", "fiber", ...sticks(8)] });
  expect(lit.builds).toBe("fire");
  expect(w.things.some((t) => t.kind === "fire" && ablaze(t))).toBe(true);
  const [v, b] = fresh();
  still(v);
  brandKind(v);
  giveStack(v, b, { ...brand }); hold(v, b, "fiber", 1, KEPT); hold(v, b, "stick", 8, DRY, TWIG);
  // two ticks, ten minutes, in hand
  carry(v, b); carry(v, b);
  expect(count(b, "burning:stick")).toBe(0);
  const late = place(v, b, { verb: "place", items: ["burning:stick", "fiber", ...sticks(8)] });
  expect(late.builds).toBeUndefined();
  expect(v.things.some((t) => t.kind === "fire")).toBe(false);
});

test("a lit lamp held to fiber and twigs lights them and keeps its flame; set into a log alone it lights nothing", () => {
  const [w, a] = fresh();
  still(w);
  const lamp = lampKind(w);
  hold(w, a, lamp.id, 1, 0); hold(w, a, "log", 1, DRY, LOG);
  const log = place(w, a, { verb: "place", items: [lamp.id, "log"] });
  expect(log.ok).toBe(false);
  expect(log.text).not.toMatch(CAUSES);
  expect(w.things.some((t) => t.kind === "fire")).toBe(false);
  expect([count(a, lamp.id), count(a, "log")]).toEqual([1, 1]);
  hold(w, a, "fiber", 1, KEPT); hold(w, a, "stick", 8, DRY, TWIG);
  expect(place(w, a, { verb: "place", items: [lamp.id, "fiber", ...sticks(8)] }).builds).toBe("fire");
  expect(count(a, lamp.id)).toBe(1);
});

test("what anyone sees of a lay: tinder soaked through is soaked (and so damp), not wet kindling; twigs too wet to carry a flame are wet kindling; a breeze blows short of a gale", () => {
  const [w, a] = fresh();
  still(w);
  const lay = ["fiber", ...sticks(3)];
  giveItems(w, a, "stone", 2); hold(w, a, "fiber", 1, SOAKED + 0.05); hold(w, a, "stick", 3, DRY, TWIG);
  const soaked = conditionsNow(w, a, "strike", a, lay);
  expect(soaked).toEqual(expect.arrayContaining(["soaked", "damp"]));
  expect(soaked).not.toContain("sodden");
  a.inv = [];
  giveItems(w, a, "stone", 2); hold(w, a, "fiber", 1, KEPT); hold(w, a, "stick", 3, 0.35, TWIG);
  const wet = conditionsNow(w, a, "strike", a, lay);
  expect(wet).toContain("sodden");
  expect(wet).not.toContain("damp");
  expect(wet).not.toContain("breezy");
  // the breeze that blows a small fire's flames off is less than the gale that carries sparks off
  expect(breeze()).toBeLessThan(GALE);
  w.weather.speed = 60;
  w.t++;
  expect(conditionsNow(w, a, "strike", a, lay)).toEqual(expect.arrayContaining(["wind", "breezy"]));
});

test("experimenting with only tinder and logs lights no fire, until they hold something thinner", () => {
  const [w, a] = fresh();
  still(w);
  const stock = (twigs: number) => { a.inv = []; giveItems(w, a, "stone", 2); hold(w, a, "fiber", 1, KEPT); hold(w, a, "log", 2, DRY, LOG); hold(w, a, "stick", twigs, DRY, TWIG); };
  const lights = (twigs: number) => {
    stock(twigs);
    const tries = tinkerOptions(w, a, "fire").filter((o) => o.act.verb === "strike" && o.act.items.length);
    expect(tries.length).toBeGreaterThan(0);
    return tries.some((o) => { stock(twigs); return strike(w, a, o.act.items).builds === "fire"; });
  };
  expect(lights(0)).toBe(false);
  expect(lights(5)).toBe(true);
});

test("the make_fire plan gathers the sticks the only lay they know needs", () => {
  const [w] = fresh();
  const way: Belief = {
    key: "strike|fiber+stick+stick+stone|stone|stone|-|-", fields: { verb: "strike", inputs: ["fiber", "stick", "stick", "stone"], tool: "stone", target: "stone", gives: [], builds: "fire" },
    uses: { fiber: 1, stick: 2 }, out: {}, ticks: 3, tries: 2, wins: 2, how: "discovered", t: 0,
  };
  const steps = plan({ inv: { fiber: 1, stone: 2 }, at: null, flags: [] }, "make_fire", { dist: { stick: 2, reeds: 3, stone: 2 }, beliefs: [way], facts: {}, kinds: w.kinds, toxic: [] })!;
  expect(steps.filter((s) => s.op === "pick_stick").length).toBe(2);
  expect(steps.at(-1)?.key).toBe(way.key);
});
