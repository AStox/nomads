import { afterAll, beforeAll, expect, test } from "bun:test";
import { DAY, TILE_M, addThing, heldStore, isNight, newWorld, type Thing, type World } from "./world";
import { SEEDLINGS, fitHere } from "./plants";
import { bedAir, carriedOutput, fireOf, fireOutput, removeThing } from "./physics";
import { advance } from "./combustion";
import { around, put } from "./space";
import { addAnimal } from "./fauna";
import { cull } from "./animals";
import { ecology } from "./ecology";
import { ctxFor, tick } from "./sim";
import { DARK, canSee, lightAt, lightOn } from "./light";
import { YEAR_DAYS, sunAt } from "./sky";
import { bodyOf } from "./body";
import { releaseGpu } from "../gpu/device";

// tick puts the world's flora on the GPU, and a live device keeps the test process from exiting
afterAll(releaseGpu);

process.env.NOMADS_BRAIN = "random";

// Midsummer, unless a test says otherwise, and a tick on that day at an hour.
const SUMMER = 1 + (YEAR_DAYS * 3) / 8, WINTER = 1 + (YEAR_DAYS * 7) / 8;
const at = (hour: number, day = SUMMER) => (day - 1) * DAY + Math.round((hour / 24) * DAY);
// the hour the sun sets on a day, to the minute
const sunsetOn = (day: number) => { let h = 13; while (sunAt(day, h).el > 0) h += 1 / 60; return h; };
const SUNSET = sunsetOn(SUMMER);

// A world takes seconds to build, so these tests share one island with two people on it, and each works on a pad of its own:
// nine spots 600 m apart round where the first person woke, far enough that a crown (12 m) at one is never seen from
// another. The pad is cleared of everything within `bare` meters, and the island of every fire and everything burning,
// whose light carries any distance, so the light there is the sky's alone.
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
  for (const t of [...here, ...w.things.filter((t) => t.kind === "fire" || t.bed)]) removeThing(w, t);
  w.animals = [];
  w.weather.sky = "clear";
  return { w, ...spot };
}
// Three oaks standing close round a point, their crowns overlapping over it.
function grove(w: World, px: number, py: number) {
  for (const [dx, dy] of [[0, 0], [3, 2], [-3, 2]]) addThing(w, "tree", px + dx / TILE_M, py + dy / TILE_M, { size: 14, species: "oak" });
}
// A fire lit from the standard lay (physics.ts fireOf) so many seconds before, with so many logs in it.
function fire(w: World, px: number, py: number, secs = 300, logs = 2) {
  const f = fireOf(w, px, py, 5, logs);
  f.bed = advance(f.bed!, secs, bedAir(w, f));
  return f;
}

test("night is the sun well under the horizon: it comes after sunset and goes before sunrise, once a day each way, and a winter night is far longer than a summer one", () => {
  const nightOf = (day: number) => {
    const flips: number[] = [];
    for (let h = 0.25; h <= 24; h += 0.25) if (isNight(at(h, day)) !== isNight(at(h - 0.25, day))) flips.push(h);
    expect(flips).toHaveLength(2);
    const [dawn, dusk] = flips, sunset = sunsetOn(day);
    // the sky keeps its glow a while after the sun has set
    expect(dusk).toBeGreaterThan(sunset);
    expect(dusk).toBeLessThan(sunset + 1.5);
    expect(sunAt(day, dawn).el).toBeLessThan(0);
    return 24 - (dusk - dawn);
  };
  expect(nightOf(WINTER)).toBeGreaterThan(nightOf(SUMMER) + 6);
});

test("open ground is lit by the sky: noon far outshines sunset, sunset far outshines midnight, and cloud dims noon", () => {
  const { w, px, py } = pad(0);
  const lux = (hour: number, sky: World["weather"]["sky"] = "clear") => { w.t = at(hour); w.weather.sky = sky; return lightAt(w, px, py).lux; };
  const noon = lux(12);
  expect(noon).toBeGreaterThan(lux(SUNSET) * 50);
  expect(lux(SUNSET)).toBeGreaterThan(lux(0) * 100);
  expect(lux(12, "cloudy")).toBeLessThan(noon);
  expect(lux(12, "rain")).toBeLessThan(lux(12, "cloudy"));
  // a storm's overcast is a rain's (air.ts SKYLIGHT)
  expect(lux(12, "storm")).toBeLessThanOrEqual(lux(12, "rain"));
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
  for (let h = SUNSET; h <= SUNSET + 2; h += 0.25) {
    w.t = at(h);
    dusk.push({ under: lightAt(w, px, py).bright, open: lightAt(w, px + 40 / TILE_M, py).bright });
  }
  expect(dusk.some((d) => d.open >= DARK && d.under < DARK)).toBe(true);
  expect(dusk.every((d) => d.under <= d.open)).toBe(true);
});

test("a fire lights the night around it and not far off", () => {
  const { w, px, py } = pad(3);
  w.t = at(1);
  expect(lightAt(w, px + 100 / TILE_M, py).bright).toBeLessThan(DARK);
  fire(w, px, py);
  w.t = at(1) + 1; // the light of fires is worked out once a tick
  expect(lightAt(w, px + 3 / TILE_M, py).bright).toBeGreaterThanOrEqual(DARK);
  expect(lightAt(w, px + 100 / TILE_M, py).bright).toBeLessThan(DARK);
});

// Light from flames at 0.16 lm a watt of flaming output, and from coals at a glowing body's efficacy at their heat, which
// is far less (fire-constants secs. 9, 31).
test("a big fire lights the dark further than coals do, and a lamp's light follows its output", () => {
  const { w, px, py } = pad(6);
  w.t = at(2); // an hour no other case works at, as the light of fires is kept for the tick it was worked out in
  // the farthest along a line from a fire that is still light enough to see by, m
  const reach = (f: Thing) => { w.t++; let d = 0; while (d < 400 && lightAt(w, f.px + (d + 1) / TILE_M, f.py).bright >= DARK) d++; return d; };
  const big = fire(w, px, py, 300, 6);
  const blazing = reach(big);
  removeThing(w, big);
  const coals = fire(w, px, py, 3600);
  expect(fireOutput(w, coals).flaming).toBe(0);
  expect(fireOutput(w, coals).glowing).toBeGreaterThan(0);
  expect(blazing).toBeGreaterThan(reach(coals) + 20);
  removeThing(w, coals);

  // a lamp in hand, lit and burnt dry, and a brand, burning hotter, on a still night of the test's own rather than the
  // island's wind: a brand held in a head-height wind of 4 m/s blows out (fire-constants sec. 14b), and the case is
  // about the light, not the wind
  const wind = w.weather.speed;
  w.weather.speed = 0;
  const a = w.agents[0];
  put(w, a, px, py);
  w.kinds["lamp"] = { id: "lamp", name: "fat lamp", props: { container: 0.8, hard: 0.6 }, parts: ["stone", "fat"] };
  w.kinds["burning:lamp"] = { id: "burning:lamp", name: "lit fat lamp", props: { container: 0.8, hard: 0.6, flammable: 1 }, parts: ["lamp"], verb: "heat" };
  w.kinds["burning:stick"] = { id: "burning:stick", name: "burning stick", props: { ...w.kinds.stick.props, flammable: 1 }, parts: ["stick"], verb: "heat" };
  const by = (k: string, hp = 1) => { a.inv = [{ k, hp, born: w.t }]; w.t++; return { lux: lightAt(w, a.px, a.py).fire, kw: carriedOutput(w, a, a.inv[0]).flaming }; };
  const lamp = by("burning:lamp"), dry = by("burning:lamp", 0), brand = by("burning:stick");
  expect(lamp.kw).toBeGreaterThan(0);
  w.t++;
  a.inv = [{ k: "burning:lamp", hp: 1, born: w.t }];
  expect(lightOn(w, a).bright).toBeGreaterThanOrEqual(DARK);
  expect(dry.lux).toBe(0);
  expect(brand.kw).toBeGreaterThan(lamp.kw);
  expect(brand.lux / lamp.lux).toBeCloseTo(brand.kw / lamp.kw, 6);
  a.inv = [];
  w.weather.speed = wind;
});

test("a bare fire thing with no bed gives no light", () => {
  const { w, px, py } = pad(6);
  w.t = at(2.5);
  addThing(w, "fire", px, py);
  w.t++;
  expect(lightAt(w, px + 1 / TILE_M, py).fire).toBe(0);
});

test("sight shrinks with the light: at night a person across the clearing can't be made out, until they stand by a fire", () => {
  const { w, px, py } = pad(5, 200);
  const [a, b] = w.agents;
  put(w, a, px, py);
  put(w, b, px + 150 / TILE_M, py);
  w.t = at(12);
  expect(canSee(w, a, b, 300)).toBe(true);
  w.t = at(1);
  expect(canSee(w, a, b, 300)).toBe(false);
  fire(w, b.px + 1 / TILE_M, b.py);
  w.t = at(1) + 1;
  expect(canSee(w, a, b, 300)).toBe(true);
});

test("whoever is out after something when the dark falls gives it up where they stand, but not in daylight, and work at camp goes on", async () => {
  const cases = [[12, "forage", "wander", true], [1, "forage", "wander", false], [1, "rest", "rest", true]] as const;
  for (const [hour, goal, op, keeps] of cases) {
    const { w, px, py } = pad(4);
    const a = w.agents[0];
    put(w, a, px, py);
    w.t = at(hour) - 1;
    a.cooldowns = {};
    bodyOf(w, a).sleep = 0.7; // a long sleep to be in the middle of
    a.goal = { type: goal, since: w.t, odds: {}, fails: 0 };
    a.plan = [{ op, arg: op === "wander" ? `${px + 40 / TILE_M},${py}` : undefined, progress: 0 }];
    const was = a.goal;
    // the goal given up, whatever they choose next (the tick waits on the GPU, and the brain may answer meanwhile)
    await tick(w);
    expect(a.goal === was).toBe(keeps);
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
  w.t = at(1);
  const dark = ctxFor(w, a).dist;
  expect(dark.bush).toBeUndefined();
  expect(dark.stick).toBeDefined();
  a.needs.food = 10;
  w.t = at(1) + 1;
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
        await tick(w);
        // The random brain answers within a few turns of the microtask queue.
        for (let turn = 0; turn < 20; turn++) await Promise.resolve();
        if (a.goal) seen.add(a.goal.type);
      }
    }
    return [...seen];
  };
  expect(await goalsAt(1)).toEqual(["rest"]);
  const day = await goalsAt(12);
  expect(day.includes("eat") || day.includes("forage")).toBe(true);
}, 60_000);

test("a hungry wolf takes a lone person who is out in the dark, and leaves one in the light alone", async () => {
  // a dusk hour when the open is still light enough and the floor of a grove already dark
  const probe = pad(7);
  // the island's own deer and rabbits, GPU objects since a tick made the island resident, would stand in sight as
  // prey or a scent: gone, and a tick landed to bring that back
  cull(probe.w, "deer"); cull(probe.w, "rabbit");
  await tick(probe.w);
  await heldStore(probe.w)?.arriving;
  grove(probe.w, probe.px, probe.py);
  let dusk = SUNSET;
  for (let h = SUNSET; h <= SUNSET + 2; h += 0.25) {
    probe.w.t = at(h);
    if (lightAt(probe.w, probe.px + 40 / TILE_M, probe.py).bright >= DARK && lightAt(probe.w, probe.px, probe.py).bright < DARK) { dusk = h; break; }
  }
  const cases = [[12, false, "wander"], [1, false, "hunt"], [dusk, false, "wander"], [dusk, true, "hunt"]] as const;
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
}, 120_000);

test("seedlings grow in the open and burn down in the deep shade of a grove", () => {
  const pd = pad(8), w = pd.w;
  // the nearest point to the pad's middle where a berry's ground suits it (plants.ts fitHere), there and 40 m east,
  // cleared of anything standing within 60 m
  const suits = (x: number, y: number) => fitHere(w, "berry", x, y) > 0.5 && fitHere(w, "berry", x + 40 / TILE_M, y) > 0.5;
  let px = pd.px, py = pd.py;
  for (let r = 0; r <= 250 && !suits(px, py); r += 10)
    for (let k = 0; k < 16 && !suits(px, py); k++) { px = pd.px + (Math.cos((k * Math.PI) / 8) * r) / TILE_M; py = pd.py + (Math.sin((k * Math.PI) / 8) * r) / TILE_M; }
  expect(suits(px, py)).toBe(true);
  for (const at of [{ px, py }, { px: px + 40 / TILE_M, py }]) {
    const here: Thing[] = [];
    around(w, at.px, at.py, 60, null, (t) => void here.push(t));
    for (const t of here) removeThing(w, t);
  }
  grove(w, px, py);
  const shaded = addThing(w, "sapling", px, py + 1 / TILE_M, { stage: 0 });
  const open = addThing(w, "sapling", px + 40 / TILE_M, py, { stage: 0 });
  w.t = at(12) + 1;
  // seedlings are tended as the sky turns, once an hour
  for (let i = 0; i < 50; i++) { w.t++; ecology(w); }
  expect(open.stage).toBeGreaterThan(0);
  expect(shaded.dry!).toBeLessThan(SEEDLINGS.berry.seed);
});
