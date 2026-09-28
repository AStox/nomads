import { expect, test } from "bun:test";
import { addThing, meters, newWorld, type Act, type Agent, type World } from "./world";
import { count, giveItems, heat, join, place, rubTick, strikeDamage, strikeTick } from "./physics";
import { thingById } from "./space";
import { record } from "./beliefs";
import { plan } from "./plan";

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
