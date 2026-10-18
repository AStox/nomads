import { expect, test } from "bun:test";
import { DAY, TILE_M, Tile, addThing, islandOf, newWorld, tileAt, type Agent, type World } from "./world";
import { beside, diggable, digTick, giveItems, giveStack, place, shelterOf, throwTick } from "./physics";
import { roundSize } from "./fuel";
import { addAnimal } from "./fauna";
import { put } from "./space";
import { ecology } from "./ecology";
import { die, life } from "./life";
import { newRel } from "./brain";

await Promise.all([3, 4, 5, 6].map(islandOf));

// Stand someone on open grass with room in front of them to dig.
const grassSpot = (w: World, a: Agent) => {
  for (let y = 5; y < 60; y++)
    for (let x = 5; x < 60; x++) {
      if (tileAt(w, x, y) !== Tile.Grass) continue;
      put(w, a, x + 0.5, y + 0.5);
      a.heading = 0;
      if (diggable(w, ...beside(w, a, 1))) return;
    }
  throw new Error("no grass");
};

test("a dug pit covered with sticks long enough to span it traps the next deer that walks onto it", () => {
  const w = newWorld(3);
  const a = w.agents[0];
  grassSpot(w, a);
  a.inv = [];
  giveItems(w, a, "sharp_stone");
  const st = { progress: 0 };
  let r;
  do r = digTick(w, a, { verb: "dig", items: [], tool: "sharp_stone" }, st); while (!r.done);
  expect(r.out!.builds).toBe("pit");
  // three 2 m sticks, each breaking under about 200 N at its middle: a deer's 1.1 kN breaks them (shelter.ts coverHolds)
  for (let i = 0; i < 3; i++) giveStack(w, a, { k: "stick", hp: 1, born: w.t, size: roundSize("generic", 0.025, 2) });
  expect(place(w, a, { verb: "place", items: ["stick", "stick", "stick"] }).builds).toBe("trap");
  const trap = w.things.find((t) => t.kind === "trap")!;
  w.animals = [];
  const deer = addAnimal(w, "deer", trap.px, trap.py);
  put(w, a, a.px + 5, a.py); // out of the deer's sight so it doesn't bolt first
  ecology(w);
  expect(deer.state).toBe("trapped");
  expect(trap.caught).toBe("deer");
});

test("a thrown stone that kills a rabbit leaves the thrower its meat and its skin", () => {
  const w = newWorld(4);
  const a = w.agents[0];
  a.inv = [];
  w.animals = [];
  const rabbit = addAnimal(w, "rabbit", a.px + 2 / TILE_M, a.py);
  let out;
  for (let i = 0; i < 400 && !out?.ok; i++) {
    if (!a.inv.some((s) => s.k === "stone")) giveItems(w, a, "stone", 8);
    const st = { progress: 0 };
    let r;
    do r = throwTick(w, a, { verb: "throw", items: ["stone"], target: { kind: "rabbit", animal: rabbit.id } }, st); while (!r.done && rabbit.state !== "flee");
    out = r.out;
    put(w, rabbit, a.px + 2 / TILE_M, a.py);
    rabbit.state = "graze";
  }
  expect(out?.ok).toBe(true);
  expect(a.inv.some((s) => s.k === "meat")).toBe(true);
  expect(a.inv.find((s) => s.k === "hide")?.size?.mass).toBeGreaterThan(0);
});

test("sweethearts with a home and full bellies have a child who inherits from them and knows them as kin", () => {
  const w = newWorld(5);
  const [a, b] = w.agents;
  w.agents = [a, b];
  put(w, b, a.px, a.py);
  for (const [x, y] of [[a, b], [b, a]]) x.rel[y.id] = { ...newRel(0), affinity: 0.8, trust: 0.8, label: "sweetheart" };
  addThing(w, "structure", a.px, a.py, { owner: a.id, parts: { stick: 3, hide: 2 }, shelter: shelterOf(w, { stick: 3, hide: 2 }) });
  for (const x of [a, b]) { x.needs.food = 90; x.needs.health = 100; }
  let tries = 0;
  while (!a.pregnant && !b.pregnant && tries++ < 50) { w.t = DAY * tries + Math.round(DAY * 0.88); life(w); }
  const mother = a.pregnant ? a : b;
  expect(mother.pregnant).not.toBeNull();
  w.t = mother.pregnant!.due;
  life(w);
  const kid = w.agents.find((x) => x.parents.includes(mother.id))!;
  expect(kid).toBeDefined();
  expect(kid.rel[mother.id].label).toBe("kin");
  expect(Object.keys(kid.traits).some((t) => t in a.traits || t in b.traits)).toBe(true);
});

test("when someone dies their things fall to the ground, their home is left empty, and a grave marks the spot", () => {
  const w = newWorld(6);
  const a = w.agents[0];
  a.inv = [];
  giveItems(w, a, "stone", 2);
  const home = addThing(w, "structure", a.px, a.py, { owner: a.id });
  die(w, a, "cold");
  expect(w.agents.includes(a)).toBe(false);
  expect(w.people[a.id].alive).toBe(false);
  expect(home.owner).toBeUndefined();
  expect(w.things.some((t) => t.kind === "grave" && t.name === a.name)).toBe(true);
  expect(w.things.some((t) => t.kind === "item" && t.item === "stone" && t.n === 2)).toBe(true);
});
