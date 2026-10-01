import { beforeAll, expect, test } from "bun:test";
import { DAY, TILE_M, addThing, isNight, newWorld, type Thing, type World } from "./world";
import { removeThing } from "./physics";
import { around, put } from "./space";
import { addAnimal } from "./fauna";
import { ecology } from "./ecology";
import { ctxFor, tick } from "./sim";
import { DARK, canSee, lightAt } from "./light";

process.env.NOMADS_BRAIN = "random";

// A tick on the first day at an hour.
const at = (hour: number, day = 1) => (day - 1) * DAY + Math.round((hour / 24) * DAY);

// A world takes seconds to build, so these tests share one island with two people on it, and each works on a pad of its own:
// nine spots 600 m apart round where the first person woke, far enough that a fire's glow (80 m) or a crown (12 m) at one is
// never seen from another. The pad is cleared of everything within `bare` meters, so the light there is the sky's alone.
let island: World, origin: { px: number; py: number };
beforeAll(() => {
  island = newWorld(5);
  island.agents = island.agents.slice(0, 2);
  origin = { px: island.agents[0].px, py: island.agents[0].py };
}, 120_000);
function pad(n: number, bare = 60) {
  const w = island;
  const spot = { px: origin.px + (((n % 3) - 1) * 600) / TILE_M, py: origin.py + ((Math.floor(n / 3) - 1) * 600) / TILE_M };
  const here: Thing[] = [];
  around(w, spot.px, spot.py, bare, null, (t) => void here.push(t));
  for (const t of here) removeThing(w, t);
  w.animals = [];
  w.weather.sky = "clear";
  return { w, ...spot };
}
// Three oaks standing close round a point, their crowns overlapping over it.
function grove(w: World, px: number, py: number) {
  for (const [dx, dy] of [[0, 0], [3, 2], [-3, 2]]) addThing(w, "tree", px + dx / TILE_M, py + dy / TILE_M, { size: 14, species: "oak" });
}

test("night is the sun well under the horizon: it comes after sunset and goes before sunrise, once a day each way", () => {
  const flips: number[] = [];
  for (let h = 0.25; h <= 24; h += 0.25) if (isNight(at(h)) !== isNight(at(h - 0.25))) flips.push(h);
  expect(flips).toHaveLength(2);
  const [dawn, dusk] = flips;
  expect(dawn).toBeGreaterThan(4);
  expect(dawn).toBeLessThan(6);
  expect(dusk).toBeGreaterThan(20.5); // the sun sets at half past eight and the sky keeps its glow a while
  expect(dusk).toBeLessThan(22);
});

test("open ground is lit by the sky: noon far outshines sunset, sunset far outshines midnight, and cloud dims noon", () => {
  const { w, px, py } = pad(0);
  const lux = (hour: number, sky: World["weather"]["sky"] = "clear") => { w.t = at(hour); w.weather.sky = sky; return lightAt(w, px, py).lux; };
  const noon = lux(12);
  expect(noon).toBeGreaterThan(lux(20.5) * 50);
  expect(lux(20.5)).toBeGreaterThan(lux(0) * 100);
  let dimmer = noon;
  for (const sky of ["cloudy", "rain", "storm"] as const) {
    expect(lux(12, sky)).toBeLessThan(dimmer);
    dimmer = lux(12, sky);
  }
});

test("a crown shades the ground under it, and felling the tree gives the light back", () => {
  const { w, px, py } = pad(1);
  w.t = at(12);
  const open = lightAt(w, px, py);
  const tree = addThing(w, "tree", px, py, { size: 14, species: "oak" });
  expect(lightAt(w, px, py).lux).toBeLessThan(open.lux * 0.2);
  expect(lightAt(w, px + 30 / TILE_M, py).canopy).toBe(0);
  removeThing(w, tree);
  expect(lightAt(w, px, py).lux).toBe(open.lux);
});

test("the forest floor goes dark in the evening while open ground is still lit", () => {
  const { w, px, py } = pad(2);
  grove(w, px, py);
  const dusk = [];
  for (let h = 20.5; h <= 22.5; h += 0.25) {
    w.t = at(h);
    dusk.push({ under: lightAt(w, px, py).bright, open: lightAt(w, px + 40 / TILE_M, py).bright });
  }
  expect(dusk.some((d) => d.open >= DARK && d.under < DARK)).toBe(true);
  expect(dusk.every((d) => d.under <= d.open)).toBe(true);
});

test("a fire lights the night around it and not far off", () => {
  const { w, px, py } = pad(3);
  w.t = at(2);
  expect(lightAt(w, px + 100 / TILE_M, py).bright).toBeLessThan(DARK);
  addThing(w, "fire", px, py);
  w.t = at(2) + 1; // the light of fires is worked out once a tick
  expect(lightAt(w, px + 3 / TILE_M, py).bright).toBeGreaterThanOrEqual(DARK);
  expect(lightAt(w, px + 100 / TILE_M, py).fire).toBe(0);
});

test("sight shrinks with the light: at night a person across the clearing can't be made out, until they stand by a fire", () => {
  const { w, px, py } = pad(5, 200);
  const [a, b] = w.agents;
  put(w, a, px, py);
  put(w, b, px + 150 / TILE_M, py);
  w.t = at(12);
  expect(canSee(w, a, b, 300)).toBe(true);
  w.t = at(2);
  expect(canSee(w, a, b, 300)).toBe(false);
  addThing(w, "fire", b.px + 1 / TILE_M, b.py);
  w.t = at(2) + 1;
  expect(canSee(w, a, b, 300)).toBe(true);
});

test("whoever is out after something when the dark falls gives it up where they stand, but not in daylight, and work at camp goes on", () => {
  const cases = [[12, "forage", "wander", "forage"], [2, "forage", "wander", "none"], [2, "rest", "rest", "rest"]] as const;
  for (const [hour, goal, op, kept] of cases) {
    const { w, px, py } = pad(4);
    const a = w.agents[0];
    put(w, a, px, py);
    w.t = at(hour) - 1;
    a.cooldowns = {};
    a.needs.energy = 30; // a long rest to be in the middle of
    a.goal = { type: goal, since: w.t, odds: {}, fails: 0 };
    a.plan = [{ op, arg: op === "wander" ? `${px + 40 / TILE_M},${py}` : undefined, progress: 0 }];
    tick(w);
    expect(a.goal?.type ?? "none").toBe(kept);
  }
});

test("in the dark they plan around what they can see: a bush 100 m off is no place to go, a stick at 20 m is, unless they are starving", () => {
  const { w, px, py } = pad(4, 150);
  const a = w.agents[0];
  put(w, a, px, py);
  addThing(w, "bush", px + 100 / TILE_M, py, { species: "berry", n: 3, hp: 20, maxHp: 20 });
  addThing(w, "stick", px + 20 / TILE_M, py);
  Object.assign(a.needs, { food: 60, warmth: 90 });
  w.t = at(12);
  expect(ctxFor(w, a).dist.bush).toBeDefined();
  w.t = at(2);
  const dark = ctxFor(w, a).dist;
  expect(dark.bush).toBeUndefined();
  expect(dark.stick).toBeDefined();
  a.needs.food = 10;
  w.t = at(2) + 1;
  expect(ctxFor(w, a).dist.bush).toBeDefined();
});

test("a hungry person with a bush 100 m off goes out after food by day, but in the dark does nothing but rest", async () => {
  const goalsAt = async (hour: number) => {
    const seen = new Set<string>();
    for (let trial = 0; trial < 12; trial++) {
      const { w, px, py } = pad(4, 150);
      const a = w.agents[0];
      put(w, a, px, py);
      addThing(w, "bush", px + 100 / TILE_M, py, { species: "berry", n: 3, hp: 20, maxHp: 20 });
      Object.assign(a, { goal: null, plan: [], cooldowns: {}, inv: [], nextDecide: 0, thinking: false });
      Object.assign(a.needs, { food: 40, energy: 90, warmth: 90, health: 100 });
      w.t = at(hour) - 1;
      for (let i = 0; i < 10; i++) {
        tick(w);
        // The random brain answers within a few turns of the microtask queue.
        for (let turn = 0; turn < 20; turn++) await Promise.resolve();
        if (a.goal) seen.add(a.goal.type);
      }
    }
    return [...seen];
  };
  expect(await goalsAt(2)).toEqual(["rest"]);
  const day = await goalsAt(12);
  expect(day.includes("eat") || day.includes("forage")).toBe(true);
}, 60_000);

test("a hungry wolf takes a lone person who is out in the dark, and leaves one in the light alone", () => {
  const cases = [[12, false, "wander"], [2, false, "hunt"], [21.25, false, "wander"], [21.25, true, "hunt"]] as const;
  for (const [i, [hour, trees, state]] of cases.entries()) {
    const { w, px, py } = pad(7);
    const a = w.agents[0];
    put(w, a, px, py);
    if (trees) grove(w, px, py);
    const wolf = addAnimal(w, "wolf", px + 100 / TILE_M, py, { hunger: 20 });
    // Each case gets a tick of its own, since how bright it is where someone stands is worked out once a tick. None of
    // them falls on the dozen-tick turn of the weather.
    w.t = at(hour) + 1 + i;
    ecology(w);
    expect(wolf.state).toBe(state);
  }
});

test("seedlings grow slower in the shade of trees than in the open", () => {
  const { w, px, py } = pad(8);
  grove(w, px, py);
  const shaded = addThing(w, "sapling", px, py + 1 / TILE_M, { stage: 0 });
  const open = addThing(w, "sapling", px + 40 / TILE_M, py, { stage: 0 });
  w.t = at(12) + 1;
  for (let i = 0; i < 50; i++) ecology(w);
  expect(shaded.stage).toBeGreaterThan(0);
  expect(shaded.stage!).toBeLessThan(open.stage! * 0.5);
});
