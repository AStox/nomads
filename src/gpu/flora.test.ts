import { groundOf } from "../sim/world";
import { afterAll, expect, test } from "bun:test";
import { releaseGpu, theGpu } from "./device";
import { Store, idOf, loadStore } from "./store";
import { Flora, PIECE, PLANT, fieldsOf, standOf } from "./flora";
import { FLORA, SPECIES, TILES, type Scatter } from "../terrain/flora";

afterAll(releaseGpu);

const K = (k: (typeof FLORA)[number]) => FLORA.indexOf(k), S = (s: (typeof SPECIES)[number]) => SPECIES.indexOf(s);

test("seed 1's scatter becomes the flora's objects one for one, every field as the generator wrote it", async () => {
  const f = groundOf(1).flora, s = new Store(await theGpu()), flora = new Flora(f);
  flora.attach(s);
  await s.step(1);
  const plant = s.kind(PLANT), C = plant.capacity, body = await s.read(PLANT, "body"), names = plant.fields.map((x) => x.name);
  const want = new Map<number, number>(), got = new Map<number, number>(), add = (m: Map<number, number>, key: number) => m.set(key, (m.get(key) ?? 0) + 1);
  let j = 0, wrong = 0;
  for (let e = 1; e <= f.n; e++) {
    add(want, f.kind[e - 1] + 256 * f.species[e - 1]);
    if (!flora.isPlant(e)) {
      // static: stored nowhere, read as the generator wrote it
      const v = flora.stand(e)!;
      add(got, v.kind + 256 * v.species);
      continue;
    }
    const v: Record<string, number> = {};
    names.forEach((name, i) => { v[name] = body[(1 + i) * C + j]; });
    const written = fieldsOf(flora.written(e)), back = standOf(v), as = flora.written(e);
    if (body[j] !== 3 || names.some((n) => v[n] !== written[n]) || JSON.stringify(back) !== JSON.stringify(as)) wrong++;
    add(got, v.what);
    j++;
  }
  expect(wrong).toBe(0);
  expect(body[j]).toBe(0); // nothing past the generator's
  expect(new Map([...got].sort())).toEqual(new Map([...want].sort()));
  expect(j).toBe([...want].filter(([w]) => (w & 255) === K("tree") || (w & 255) === K("bush")).reduce((n, [, c]) => n + c, 0));
  s.destroy();
}, 120_000);

// A scatter of a few objects on tiles 0 and 5: a pine and a stick and a grass tussock, then a bramble and a boulder.
function small(): Scatter {
  const rows: [number, number, number, number, number][] = [
    [K("tree"), S("pine"), 0.25, 0.5, 14.5], [K("stick"), 0, 0.5, 0.5, 0.9], [K("grass"), 0, 0.75, 0.25, 1.3],
    [K("bush"), S("berry"), 5.5, 0.5, 1.2], [K("boulder"), 0, 5.75, 0.75, 2.5],
  ];
  const n = rows.length, start = new Int32Array(TILES * TILES + 1);
  for (let t = 1; t <= 5; t++) start[t] = 3;
  for (let t = 6; t <= TILES * TILES; t++) start[t] = n;
  const at = (v: number) => Math.fround(Math.round(v * 1e4) / 1e4);
  return {
    n, start, kind: Uint8Array.from(rows, (r) => r[0]), species: Uint8Array.from(rows, (r) => r[1]),
    px: Float32Array.from(rows, (r) => at(r[2])), py: Float32Array.from(rows, (r) => at(r[3])), size: Float32Array.from(rows, (r) => r[4]),
    seed: Uint32Array.from(rows, (_, i) => 0x9e3779b9 * (i + 1)), ore: [],
  };
}

test("changes reach the GPU as kills, sets and pieces, the mirror answers round people, and a save loads", async () => {
  const f = small(), s = new Store(await theGpu()), flora = new Flora(f);
  // a change made before the world runs on a GPU is queued when it takes up residence: a tussock grazed
  const grazed = { ...flora.written(3), size: Math.fround(1.04) };
  flora.change(3, grazed);
  flora.attach(s);
  flora.watch([{ id: "a", px: 5.5, py: 0.5 }], 10);
  await s.step(1);
  const plant = s.kind(PLANT), piece = s.kind(PIECE), pine = idOf(plant.n, 0, 1), berry = idOf(plant.n, 1, 1);
  expect(flora.stand(3)).toEqual(grazed);
  let pieces = await s.read(PIECE, "body");
  expect(pieces[0]).toBe(3);
  expect(pieces[(1 + piece.field.e) * piece.capacity]).toBe(3);
  expect(standOf(Object.fromEntries(piece.fields.map((x, i) => [x.name, pieces[(1 + i) * piece.capacity]])))).toEqual(grazed);
  // round the person, the bramble comes from the mirror; the pine, outside every window, from the generator's data
  expect(s.mirror.landed(PLANT, 11, 1)?.map((o) => o.id)).toEqual([berry]);
  expect(s.mirror.landed(PLANT, 0, 1)).toBeUndefined();
  expect(flora.stand(4)).toEqual(flora.written(4));
  expect(flora.stand(1)).toEqual(flora.written(1));
  // the bramble picked to death: gone from the mirror at once, dead on the GPU after the next upload
  flora.change(4, null);
  expect(s.mirror.get(berry)).toBeNull();
  expect(flora.stand(4)).toBeNull();
  // the stick taken: nothing was stored, nothing is; the grazed tussock taken: its piece dies
  flora.change(2, null);
  flora.change(3, null);
  await s.step(2);
  expect((await s.read(PLANT, "body"))[1] & 1).toBe(0);
  expect((await s.read(PIECE, "body"))[0] & 1).toBe(0);
  expect(flora.gone().sort()).toEqual([2, 3, 4]);
  // the tussock grows back from its roots as it grew: the generator's again
  flora.change(3, flora.written(3));
  expect(flora.stand(3)).toEqual(flora.written(3));
  // a tree or bush gone doesn't come back where it stood
  expect(() => flora.change(4, flora.written(4))).toThrow();
  // the pine felled after the boulder is rolled a little: one more kill, one more piece
  const rolled = { ...flora.written(5), px: Math.fround(5.8) };
  flora.change(5, rolled);
  flora.change(1, null);
  await s.step(3);
  expect(s.mirror.get(pine)).toBeNull(); // known dead, though outside every window
  expect((await s.read(PLANT, "body"))[0] & 1).toBe(0);
  // saved and loaded: the same buffers, and the same changes for a flora taking up residence on the loaded store
  const bytes = await s.dump(), hash = await s.hash(), t = loadStore(await theGpu(), bytes), again = new Flora(f);
  again.attach(t);
  expect(await t.hash()).toBe(hash);
  for (let e = 1; e <= f.n; e++) expect(again.stand(e)).toEqual(flora.stand(e));
  expect(again.gone().sort()).toEqual([1, 2, 4]);
  // the rolled boulder's piece (the tussock's slot again, its next generation) answers to the loaded flora: taking it
  // kills it there
  again.change(5, null);
  await t.step(4);
  pieces = await t.read(PIECE, "body");
  expect([pieces[0] & 1, pieces[0] >>> 1]).toEqual([0, 2]);
  s.destroy();
  t.destroy();
});
