import { expect, test } from "bun:test";
import { DAY, Tile, addAnimal, addThing, newWorld, tileAt, type World } from "./world";
import { digTick, giveItems, place, throwTick } from "./physics";
import { ecology } from "./ecology";
import { die, life } from "./life";
import { newRel } from "./brain";

const grassSpot = (w: World) => {
  for (let y = 5; y < 60; y++) for (let x = 5; x < 60; x++) if (tileAt(w, x, y) === Tile.Grass && !w.things.some((t) => t.x === x && t.y === y)) return { x, y };
  throw new Error("no grass");
};

test("a dug pit covered with sticks traps the next deer that walks onto it", () => {
  const w = newWorld(3);
  const a = w.agents[0];
  Object.assign(a, grassSpot(w));
  a.inv = [];
  giveItems(w, a, "sharp_stone");
  const st = { progress: 0 };
  let r;
  do r = digTick(w, a, { verb: "dig", items: [], tool: "sharp_stone" }, st); while (!r.done);
  expect(r.out!.builds).toBe("pit");
  giveItems(w, a, "stick", 3);
  expect(place(w, a, { verb: "place", items: ["stick", "stick", "stick"] }).builds).toBe("trap");
  const trap = w.things.find((t) => t.kind === "trap")!;
  w.animals = [];
  const deer = addAnimal(w, "deer", trap.x, trap.y);
  a.x += 30; // out of the deer's sight so it doesn't bolt first
  ecology(w);
  expect(deer.state).toBe("trapped");
  expect(trap.caught).toBe("deer");
});

test("a thrown heavy stone can kill a deer at range and the meat ends up with the thrower", () => {
  const w = newWorld(4);
  const a = w.agents[0];
  a.inv = [];
  giveItems(w, a, "stone", 16);
  w.animals = [];
  const deer = addAnimal(w, "deer", a.x + 3, a.y);
  let out;
  for (let i = 0; i < 400 && !out?.ok; i++) {
    if (!a.inv.some((s) => s.k === "stone")) giveItems(w, a, "stone", 8);
    const st = { progress: 0 };
    let r;
    do r = throwTick(w, a, { verb: "throw", items: ["stone"], target: { kind: "deer", animal: deer.id } }, st); while (!r.done);
    out = r.out;
    deer.x = a.x + 3; deer.y = a.y;
  }
  expect(out?.ok).toBe(true);
  expect(a.inv.some((s) => s.k === "meat")).toBe(true);
});

test("sweethearts with a home and full bellies have a child who inherits from them and knows them as kin", () => {
  const w = newWorld(5);
  const [a, b] = w.agents;
  w.agents = [a, b];
  b.x = a.x; b.y = a.y;
  for (const [x, y] of [[a, b], [b, a]]) x.rel[y.id] = { ...newRel(0), affinity: 0.8, trust: 0.8, label: "sweetheart" };
  addThing(w, "structure", a.x, a.y, { owner: a.id, shelter: { tier: 1, style: "sticks", cover: 0.5, insul: 0.3, sturdy: 0.3, flam: 0.5 } });
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
  const home = addThing(w, "structure", a.x, a.y, { owner: a.id });
  die(w, a, "cold");
  expect(w.agents.includes(a)).toBe(false);
  expect(w.people[a.id].alive).toBe(false);
  expect(home.owner).toBeUndefined();
  expect(w.things.some((t) => t.kind === "grave" && t.name === a.name)).toBe(true);
  expect(w.things.some((t) => t.kind === "item" && t.item === "stone" && t.n === 2)).toBe(true);
});
