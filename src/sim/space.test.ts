import { DAY, H, W, adoptStore, heldStore, newWorld, type World } from "./world";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { releaseGpu, theGpu } from "../gpu/device";
import { idOf, loadStore } from "../gpu/store";
import { PLANT, standOf } from "../gpu/flora";
import { FLORA } from "../terrain/flora";
import { around, deadwoodOf, floraOf, nearestThing, onTile, resident, setKind, shelve, stockedTile, thingById } from "./space";
import { mark, removeThing } from "./physics";
import { tick } from "./sim";
import { stemDriver } from "./plants";
import { seedDriver } from "./seeds";
import { animalsOf, residentAnimals } from "./animals";
import { LAND_S, due } from "./lanes";

afterAll(releaseGpu);

let w: World;
// Ticks up to and through the next one that lands the store (lanes.ts LAND_S), as every tick did when these were written.
const landed = async () => { do await tick(w); while (!due(w.t, LAND_S)); };
beforeAll(async () => {
  w = newWorld(1);
  // the first landing puts the flora on the GPU and lands the windows round people, as many cells as the first copy
  // has room for; the second, sized by the first, lands the rest
  await landed();
  await landed();
  await heldStore(w)!.arriving;
});

test("felling a tree near a person kills its GPU object: gone from the mirror, from around and from what's drawn", async () => {
  const a = w.agents[0], tree = nearestThing(w, a.px, a.py, ["tree"], () => true, 800)!;
  const flora = floraOf(w), s = heldStore(w)!, e = Number(tree.id.slice(1)), id = idOf(s.kind(PLANT).n, flora.slot(e), 1);
  // the Thing is a view of the object round the person, as the mirror holds it
  const held = s.mirror.get(id);
  if (!held || typeof held !== "object") throw new Error("the tree's stem isn't in the mirror round the person");
  expect(standOf(held.v)).toEqual({ kind: FLORA.indexOf("tree"), species: flora.written(e).species, px: tree.px, py: tree.py, size: tree.size, seed: tree.seed });
  // felled as physics.ts fells it
  setKind(w, tree, "stump");
  Object.assign(tree, { size: 0.6 });
  mark(w, tree);
  expect(s.mirror.get(id)).toBeNull();
  expect(flora.stand(e)).toBeNull();
  let found = false;
  around(w, tree.px, tree.py, 1, ["tree"], (t) => { found ||= t === tree; });
  expect(found).toBe(false);
  expect(flora.gone()).toContain(e);
  expect(w.things).toContain(tree);
  await landed();
  expect((await s.read(PLANT, "body"))[flora.slot(e)] & 1).toBe(0);
});

test("shelving and restocking a tile gives the same Things with the same ids", () => {
  const a = w.agents[0], start = floraOf(w).f.start;
  let tile = -1;
  for (let t = 0; t < W * H && tile < 0; t++) {
    const x = t % W, y = (t - x) / W;
    if (Math.hypot(x + 0.5 - a.px, y + 0.5 - a.py) > 20 && start[t + 1] - start[t] > 50 && !stockedTile(w, t)) tile = t;
  }
  const e = start[tile] + 1, things = () => JSON.stringify(FLORA.flatMap((k) => onTile(w, tile, k)).sort((p, q) => Number(p.id.slice(1)) - Number(q.id.slice(1))));
  expect(thingById(w, `t${e}`)?.id).toBe(`t${e}`);
  expect(stockedTile(w, tile)).toBe(true);
  const before = things();
  // a day on, with no one near, it is put back
  const t0 = w.t;
  w.t += DAY;
  shelve(w);
  w.t = t0;
  expect(stockedTile(w, tile)).toBe(false);
  expect(onTile(w, tile, "tree").length).toBe(0);
  thingById(w, `t${e}`);
  expect(things()).toBe(before);
});

test("a world saved with its GPU objects loads with them, and one saved without loads them from its JSON", async () => {
  // a stick taken near a person as well: a piece gone for good (src/gpu/deadwood.ts), stored nowhere
  const a = w.agents[0], stick = nearestThing(w, a.px, a.py, ["stick"], () => true, 800);
  if (stick) removeThing(w, stick);
  const s = heldStore(w)!, gone = floraOf(w).gone().sort((p, q) => p - q);
  expect(gone.length).toBeGreaterThanOrEqual(1);
  if (stick) expect(deadwoodOf(w)!.piece(stick.id)).toBeNull();
  // as server.ts saves, between ticks
  const json = JSON.stringify(w), bytes = await s.dump(), hash = await s.hash();
  const loaded = JSON.parse(json) as World;
  adoptStore(loaded, loadStore(await theGpu(), bytes));
  await resident(loaded, stemDriver(loaded), seedDriver(loaded));
  await residentAnimals(loaded);
  expect(await heldStore(loaded)!.hash()).toBe(hash);
  expect(floraOf(loaded).gone().sort((p, q) => p - q)).toEqual(gone);
  if (stick) expect(deadwoodOf(loaded)!.piece(stick.id)).toBeNull();
  // without its world.gpu (an older save, or one of another tick): the changes are read from the Things
  const bare = JSON.parse(json) as World;
  await resident(bare, stemDriver(bare), seedDriver(bare));
  expect(floraOf(bare).gone().sort((p, q) => p - q)).toEqual(gone);
  // the queued kills uploaded on both
  await s.step(w.t + 1);
  await heldStore(bare)!.step(w.t + 1);
  expect(Bun.hash(await heldStore(bare)!.read(PLANT, "body"))).toBe(Bun.hash(await s.read(PLANT, "body")));
  heldStore(loaded)!.destroy();
  animalsOf(loaded).destroy();
  deadwoodOf(loaded)!.destroy();
  heldStore(bare)!.destroy();
  deadwoodOf(bare)!.destroy();
});
