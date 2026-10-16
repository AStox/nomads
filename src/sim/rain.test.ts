import { expect, test } from "bun:test";
import { TILE_M, addThing, dryAt, heldStore, newWorld, type Thing, type World } from "./world";
import { removeThing } from "./physics";
import { around, crownsOf, makeStem } from "./space";
import { airAt, rainAt } from "./air";
import { canopyAt, crownsAt } from "./light";
import { crownKind, rainOn, through } from "./rain";
import { through as layers } from "../terrain/growth";
import { tick } from "./sim";
import { releaseGpu } from "../gpu/device";
import { afterAll } from "bun:test";

afterAll(releaseGpu);

// docs/research/fire-constants.md sec. 25c: a crown holds what lands on it until it's wet through, and a drop slants
// with the wind as it falls, so what stands upwind keeps the rain off the ground behind it. The crowns are the island's
// crown raster (gpu/crowns.ts), layer on layer over each 18.75 m texel.
const m = (meters: number) => meters / TILE_M;
// A patch of open, dry, level-enough ground, cleared of everything for 80 m round, under a rain sky.
function patch(w: World = newWorld(42)): [World, { px: number; py: number }] {
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

test("a dry crown keeps a light shower off the ground beneath it, and once wet through lets it all fall but what runs down the trunk", async () => {
  const pine = crownKind("pine");
  expect(through(pine, 0, 0.5, false)).toBeLessThan(0.1);
  expect(through(pine, 1.21, 0.5, false)).toBeCloseTo(1 - 0.029, 9);
  const w = newWorld(42);
  await tick(w);
  const [, at] = patch(w);
  w.weather.speed = 0;
  // a closed stand of 15 m pines over the point's texel (5.5 m2 of crown each, flora.ts crownShare), each a stem on the
  // GPU as a tree people raised is (space.ts makeStem), the crowns passed over them
  const T = 18.75, x0 = Math.floor((at.px * TILE_M) / T) * T, y0 = Math.floor((at.py * TILE_M) / T) * T;
  for (let i = 0; i < 8; i++) for (let j = 0; j < 8; j++) makeStem(w, addThing(w, "tree", (x0 + ((i + 0.5) * T) / 8) / TILE_M, (y0 + ((j + 0.5) * T) / 8) / TILE_M, { species: "pine", size: 15 }));
  await tick(w);
  await heldStore(w)?.arriving;
  await crownsOf(w)!.refresh();
  w.weather.sky = "rain";
  delete w.weather.past;
  const under = { px: at.px, py: at.py }, open = { px: at.px + m(60), py: at.py };
  w.t++;
  expect(rainOn(w, under.px, under.py)).toBeLessThan(rainOn(w, open.px, open.py));
  w.weather.past = { crowns: [1.21, 0.8, 0.8, 0.8], held: [1.21, 0.8, 0.8, 0.8], bare: false };
  w.t++;
  const c = crownsAt(w, under.px, under.py);
  expect(c.pine).toBeGreaterThan(0.5);
  expect(rainOn(w, under.px, under.py)).toBeCloseTo(rainAt(w, under.px, under.py) * layers(c.pine, 1 - 0.029) * layers(c.broad, 1 - 0.029), 9);
}, 600_000);

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
