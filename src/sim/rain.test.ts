import { expect, test } from "bun:test";
import { TILE_M, addThing, dryAt, newWorld, type Thing, type World } from "./world";
import { removeThing } from "./physics";
import { around } from "./space";
import { airAt, rainAt } from "./air";
import { canopyAt } from "./light";
import { REF, deadAt, wetness } from "./wetness";
import { crownKind, rainOn, through } from "./rain";

// docs/research/fire-constants.md sec. 25c: a crown holds what lands on it until it's wet through, and a drop slants
// with the wind as it falls, so what stands upwind keeps the rain off the ground behind it.
const m = (meters: number) => meters / TILE_M;
// A patch of open, dry, level-enough ground, cleared of everything for 80 m round, under a rain sky.
function patch(): [World, { px: number; py: number }] {
  const w = newWorld(42);
  w.agents = [];
  for (let k = 0; k < 400; k++) {
    const px = 40.5 + 3 * (k % 20), py = 40.5 + 3 * Math.floor(k / 20);
    Object.assign(w.weather, { speed: 1, wind: { dx: 1, dy: 0 } });
    if (!dryAt(w, px, py) || canopyAt(w, px, py) > 0 || airAt(w, px, py).wind < 0.5) continue;
    const all: Thing[] = [];
    around(w, px, py, 80, null, (t) => { all.push(t); });
    for (const t of all) removeThing(w, t);
    w.weather.sky = "rain";
    delete w.weather.past;
    return [w, { px, py }];
  }
  throw new Error("no open ground");
}

test("a dry crown keeps a light shower off the ground beneath it, and once wet through lets it all fall but what runs down the trunk", () => {
  const pine = crownKind("pine");
  expect(through(pine, 0, 0.5, false)).toBeLessThan(0.1);
  expect(through(pine, 1.21, 0.5, false)).toBeCloseTo(1 - 0.029, 9);
  const [w, at] = patch();
  w.weather.speed = 0;
  addThing(w, "tree", at.px, at.py, { species: "pine", size: 15 });
  const under = { px: at.px + m(0.5), py: at.py }, open = { px: at.px + m(30), py: at.py };
  expect(rainOn(w, under.px, under.py)).toBeLessThan(rainOn(w, open.px, open.py));
  w.weather.past = { base: { open: [], shade: [] }, hours: [{ t: w.t, sky: "rain", temp: 10, speed: 0, wind: { dx: 1, dy: 0 }, held: [1.21, 0.8, 0.8, 0.8], bare: false }], crowns: [1.21, 0.8, 0.8, 0.8] };
  w.t++;
  expect(rainOn(w, under.px, under.py)).toBeCloseTo(rainAt(w, under.px, under.py) * (1 - 0.029), 9);
});

test("in a wind the rain slants, so the ground in a boulder's lee takes none of it, though in still air it takes it all", () => {
  const [w, at] = patch();
  addThing(w, "boulder", at.px, at.py, { size: 3 });
  const lee = { px: at.px + m(1.8), py: at.py }, windward = { px: at.px - m(1.8), py: at.py };
  w.weather.speed = 5 / airAt(w, lee.px, lee.py).wind;
  expect(rainOn(w, lee.px, lee.py)).toBe(0);
  expect(rainOn(w, windward.px, windward.py)).toBeGreaterThan(0);
  w.weather.speed = 0;
  w.t++;
  expect(rainOn(w, lee.px, lee.py)).toBeGreaterThan(0);
});

test("twigs lying in a boulder's lee through a wind-driven rain stay drier than twigs out in it", () => {
  const [w, at] = patch();
  addThing(w, "boulder", at.px, at.py, { size: 3 });
  const lee = { px: at.px + m(1.8), py: at.py }, open = { px: at.px + m(30), py: at.py };
  w.weather.speed = 5 / airAt(w, lee.px, lee.py).wind;
  w.weather.dead = { open: REF.map(() => 0.1), shade: REF.map(() => 0.1) };
  for (let i = 0; i < 3; i++) { w.t = (Math.floor(w.t / 12) + 1) * 12; wetness(w); }
  expect(deadAt(w, lee, REF[1])).toBeLessThan(deadAt(w, open, REF[1]));
});
