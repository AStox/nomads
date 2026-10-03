import { beforeAll, expect, test } from "bun:test";
import { DAY, H, TILE_M, W, addThing, dryAt, meters, newWorld, type Agent, type Thing, type World } from "./world";
import { giveItems, groundWord, plant, removeThing, soilAt } from "./physics";
import { around, put, thingById } from "./space";
import { groundKey, type Belief } from "./beliefs";
import { plan } from "./plan";
import { tick } from "./sim";
import { YEAR_DAYS } from "./sky";

process.env.NOMADS_BRAIN = "random";

// One island with one person on it; each test clears the ground round where they stand.
let w: World, a: Agent, home: { px: number; py: number };
beforeAll(() => {
  w = newWorld(5);
  w.agents = w.agents.slice(0, 1);
  a = w.agents[0];
  home = { px: a.px, py: a.py };
}, 120_000);
const clear = (r: number) => {
  const here: Thing[] = [];
  around(w, a.px, a.py, r, null, (t) => void here.push(t));
  for (const t of here) removeThing(w, t);
  w.animals = [];
};
const ring = (m: number, k: number) => [a.px + (Math.cos((k * Math.PI) / 4) * m) / TILE_M, a.py + (Math.sin((k * Math.PI) / 4) * m) / TILE_M] as const;
// ticks until done, the random brain answering within a few turns of the microtask queue
const run = async (n: number, done: () => boolean) => {
  for (let i = 0; i < n && !done(); i++) { tick(w); for (let k = 0; k < 20; k++) await Promise.resolve(); }
};
// a berry pushed into the ground where they started, once they've finished whatever they were thinking
const sow = async () => {
  await run(50, () => !a.thinking);
  put(w, a, home.px, home.py);
  a.heading = 0;
  giveItems(w, a, "berry");
  a.nextDecide = w.t + DAY * 10;
  a.goal = { type: "plant", since: w.t, odds: {}, fails: 0 };
  a.plan = [{ op: "tinker", progress: 0, started: w.t, act: { verb: "plant", items: ["berry"] } }];
  await run(40, () => a.plan[0]?.op !== "tinker");
  return thingById(w, a.waiting?.at(-1)?.thing)!;
};
// midsummer, midday, everything they need
const summer = () => {
  w.t = (Math.round((YEAR_DAYS * 3) / 8) * DAY) + DAY / 2;
  a.inv = [];
  a.needs = { food: 100, energy: 100, warmth: 100, health: 100, social: 100 };
};

test("a seed goes into the ground right beside a bush, and bare rock takes none", () => {
  put(w, a, home.px, home.py);
  clear(20);
  a.inv = [];
  a.heading = 0;
  // bushes all round, a pace and a half off, between the spots a seed could go: every spot is within a pace of one
  const bushes = [0, 1, 2, 3, 4, 5, 6, 7].map((k) => addThing(w, "bush", ...ring(1.5, k + 0.5), { species: "berry", size: 1 }));
  giveItems(w, a, "berry");
  const out = plant(w, a, { verb: "plant", items: ["berry"] });
  expect(out.ok).toBe(true);
  const seedling = thingById(w, out.later!)!;
  expect(Math.min(...bushes.map((b) => meters(seedling, b)))).toBeLessThan(1);
  // a stretch of rock with no soil on it anywhere within reach, the first found scanning the island
  let rock: [number, number] | null = null;
  for (let y = 0.5; y < H && !rock; y += 0.25)
    for (let x = 0.5; x < W && !rock; x += 0.25) {
      const all = [[x, y], ...[1, 2, 3].flatMap((m) => [0, 1, 2, 3, 4, 5, 6, 7].map((k) => [x + (Math.cos((k * Math.PI) / 4) * m) / TILE_M, y + (Math.sin((k * Math.PI) / 4) * m) / TILE_M]))];
      if (all.every(([px, py]) => dryAt(w, px, py) && soilAt(w, px, py) < 0.03)) rock = [x, y];
    }
  expect(rock).not.toBeNull();
  put(w, a, rock![0], rock![1]);
  giveItems(w, a, "berry");
  const none = plant(w, a, { verb: "plant", items: ["berry"] });
  expect(none.ok).toBe(false);
  expect(none.text).toMatch(/rock/);
});

test("what's planted is judged when it comes up: the planter waits, learns how long it took and what ground it came up on, and counts one that withers against that ground", async () => {
  put(w, a, home.px, home.py);
  clear(20);
  summer();
  const ground = groundKey(groundWord(w, a.px, a.py));
  const key = "plant|berry|-|-|-|-";
  // done, but nothing to show yet: tried, not worked
  const first = await sow();
  expect(first.kind).toBe("sapling");
  expect(a.beliefs[key]).toMatchObject({ tries: 1, wins: 0 });
  // it comes up: now it has worked, on this ground, and they know how long it took
  first.stage = 0.95;
  const planted = a.waiting![0].t;
  await run(600, () => first.kind !== "sapling");
  expect(first.kind).toBe("bush");
  const b = a.beliefs[key];
  expect(b).toMatchObject({ tries: 1, wins: 1 });
  expect(b.fields.builds).toBe("bush");
  expect(b.later).toBe(w.t - planted);
  expect(b.when?.[ground]).toEqual({ tries: 1, wins: 1 });
  expect(a.waiting).toBeUndefined();
  // the next one, on the same ground, starved of what it needs: it withers, and that counts against the ground
  const second = await sow();
  second.fit = 0;
  second.hp = 0.01;
  await run(30, () => !thingById(w, second.id));
  expect(thingById(w, second.id)).toBeUndefined();
  expect(b).toMatchObject({ tries: 2, wins: 1 });
  expect(b.when?.[ground]).toEqual({ tries: 2, wins: 1 });
  expect(a.waiting).toBeUndefined();
});

test("someone whose berries came up on grassland walks to grassland to plant, and someone who thinks they won't come up on sand plants none on sand", () => {
  const b: Belief = {
    key: "plant|berry|-|-|-|-", fields: { verb: "plant", inputs: ["berry"], gives: [], builds: "bush", effect: "buried" }, uses: { berry: 1 }, out: {},
    ticks: 3, later: DAY * 3, tries: 3, wins: 2, how: "discovered", t: 0,
    when: { "ground:grassland": { tries: 2, wins: 2 }, "ground:sand": { tries: 1, wins: 0 } }, unless: ["ground:sand"],
  };
  const ctx = (dist: Record<string, number>) => ({ dist, beliefs: [b], facts: {}, kinds: w.kinds, toxic: [], now: ["ground:sand"] });
  const start = { inv: { berry: 2 }, at: null, flags: [] };
  const steps = plan(start, "plant", ctx({ "ground:grassland": 4 }));
  expect(steps?.map((s) => [s.op, s.arg ?? ""])).toEqual([["goto", "ground:grassland"], ["act", b.key]]);
  expect(plan(start, "plant", ctx({}))).toBeNull();
});

test("berries that come up only now and then on their own ground send them to try new ground nearby, and back again once the new ground does worse", () => {
  const b: Belief = {
    key: "plant|berry|-|-|-|-", fields: { verb: "plant", inputs: ["berry"], gives: [], builds: "bush", effect: "buried" }, uses: { berry: 1 }, out: {},
    ticks: 3, later: DAY * 3, tries: 8, wins: 4, how: "discovered", t: 0, tally: { tries: 8, wins: 4 },
    when: { "ground:forest_floor": { tries: 8, wins: 4 } },
  };
  const ctx = { dist: { "ground:forest_floor": 0.5, "ground:grassland": 2 }, beliefs: [b], facts: {}, kinds: w.kinds, toxic: [], now: ["ground:forest_floor"] };
  const start = { inv: { berry: 2 }, at: null, flags: [] };
  expect(plan(start, "plant", ctx)?.[0]).toMatchObject({ op: "goto", arg: "ground:grassland" });
  b.when!["ground:grassland"] = { tries: 4, wins: 1 };
  b.tally = { tries: 12, wins: 5 };
  expect(plan(start, "plant", ctx)?.[0]).toMatchObject({ op: "goto", arg: "ground:forest_floor" });
});

test("someone who thinks berries won't come up crowded in among bushes and trees puts the seed clear of them, and counts it against the spot it went into", async () => {
  put(w, a, home.px, home.py);
  clear(20);
  summer();
  // bushes two paces off to the east: the first spots turning round from the east are within a pace and a half of one
  const bushes = [-1, 0, 1].map((k) => addThing(w, "bush", ...ring(2, k), { species: "berry", size: 1 }));
  const nearest = (t: Thing) => Math.min(...bushes.map((b) => meters(t, b)));
  const b = a.beliefs["plant|berry|-|-|-|-"];
  delete b.unless;
  const crowded = await sow();
  expect(nearest(crowded)).toBeLessThan(1.5);
  expect(a.waiting?.at(-1)?.now).toContain("crowded");
  removeThing(w, crowded);
  b.unless = ["crowded"];
  const clearOf = await sow();
  expect(nearest(clearOf)).toBeGreaterThan(1.5);
  expect(a.waiting?.at(-1)?.now).not.toContain("crowded");
});
