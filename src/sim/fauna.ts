// Everything alive on the island that isn't a person: what each kind is like and where they start. What they do each
// tick is in animals.ts. Speeds are meters a tick of five minutes' game time, the way a person's are.
import { H, TILE_M, Tile, W, YEAR, dryAt, dryNear, sea, shoreOf, tileAt, wetAt, type Animal, type AnimalSpecies, type World } from "./world";
import { anyOf, put } from "./space";

type Kind = { hp: number; walk: number; run: number; fly?: number; ground: boolean };
export const FAUNA: Record<AnimalSpecies, Kind> = {
  deer: { hp: 30, walk: 1.5, run: 8, ground: true },
  wolf: { hp: 35, walk: 1.5, run: 8, ground: true },
  rabbit: { hp: 6, walk: 0.6, run: 5, ground: true },
  heron: { hp: 8, walk: 0.4, run: 1, fly: 12, ground: false },
  gull: { hp: 5, walk: 0.5, run: 1, fly: 14, ground: false },
  crow: { hp: 4, walk: 0.5, run: 1.5, fly: 12, ground: false },
  eagle: { hp: 12, walk: 0.3, run: 1, fly: 18, ground: false },
  fish: { hp: 3, walk: 1, run: 3, ground: false },
  butterfly: { hp: 1, walk: 1, run: 2.5, fly: 2.5, ground: false },
};
// People can walk up to and trap what lives on the ground; hunting works on the bigger of those.
export const HUNTED = ["deer", "wolf", "rabbit"] as const;

export function addAnimal(w: World, species: AnimalSpecies, px: number, py: number, extra: Partial<Animal> = {}): Animal {
  const n = w.nextId++, hp = FAUNA[species].hp;
  const a: Animal = { id: `a${n}`, species, x: 0, y: 0, px: 0, py: 0, alt: 0, heading: (n * 2.39996) % (Math.PI * 2), hp, maxHp: hp, hunger: 80, state: species === "fish" ? "swim" : "wander", born: w.t, dx: 0, dy: 0, ...extra };
  put(w, a, px, py);
  w.animals.push(a);
  return a;
}

// Tiles by what can live on them, worked out once per world.
type Places = { shore: number[]; coast: number[]; lake: number[]; edge: number[]; high: number[]; grass: number[] };
const places = new WeakMap<World, Places>();
export function placesOf(w: World): Places {
  let p = places.get(w);
  if (p) return p;
  const salt = sea(w), wet = (x: number, y: number) => tileAt(w, x, y) === Tile.Water;
  const near = (x: number, y: number, f: (x: number, y: number) => boolean) => [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => x + dx >= 0 && y + dy >= 0 && x + dx < W && y + dy < H && f(x + dx, y + dy));
  p = { shore: [], coast: [], lake: [], edge: [], high: [], grass: [] };
  const heights: [number, number][] = [];
  for (let t = 0; t < W * H; t++) {
    const x = t % W, y = (t / W) | 0, tile = w.tiles[t];
    if (tile === Tile.Water) {
      if (!salt[t]) p.lake.push(t);
      else if (near(x, y, (a, b) => !wet(a, b))) p.coast.push(t);
      continue;
    }
    if (near(x, y, wet)) p.shore.push(t);
    if (tile === Tile.Grass) p.grass.push(t);
    if (tile === Tile.Grass && near(x, y, (a, b) => tileAt(w, a, b) === Tile.Forest)) p.edge.push(t);
    heights.push([t, w.heights[y * (W + 1) + x]]);
  }
  p.high = heights.sort((a, b) => b[1] - a[1]).slice(0, 24).map(([t]) => t);
  places.set(w, p);
  return p;
}
// The animals a new world starts with, placed from the world's own stream: walkers on dry ground, fish in water.
export function populate(w: World, rand: () => number, main: Uint8Array) {
  const p = placesOf(w), pick = (list: number[]) => list[Math.floor(rand() * list.length)], grass = p.grass.filter((t) => main[t]);
  const people = w.agents.length ? { px: w.agents.reduce((s, a) => s + a.px, 0) / w.agents.length, py: w.agents.reduce((s, a) => s + a.py, 0) / w.agents.length } : { px: W / 2, py: H / 2 };
  const dry = (x: number, y: number) => dryAt(w, x, y);
  const ring = (x: number, y: number, m: number, ok: (x: number, y: number) => boolean) =>
    [0, 1, 2, 3, 4, 5, 6, 7].some((k) => ok(x + (Math.cos((k * Math.PI) / 4) * m) / TILE_M, y + (Math.sin((k * Math.PI) / 4) * m) / TILE_M));
  // A point in a tile that passes ok, or null if thirty tries find none.
  const inTile = (t: number, ok: (x: number, y: number) => boolean = dry): [number, number] | null => {
    for (let tries = 0; tries < 30; tries++) {
      const x = (t % W) + 0.05 + rand() * 0.9, y = ((t / W) | 0) + 0.05 + rand() * 0.9;
      if (ok(x, y)) return [x, y];
    }
    return null;
  };
  const onGround = (t: number): [number, number] => inTile(t) ?? dryNear(w, (t % W) + 0.5, ((t / W) | 0) + 0.5) ?? [(t % W) + 0.5, ((t / W) | 0) + 0.5];
  // A spot on the mainland between lo and hi tiles from where people woke, on tiles that pass ok.
  const nearPeople = (lo: number, hi: number, ok: (t: number) => boolean): [number, number] => {
    for (let tries = 0; tries < 500; tries++) {
      const a = rand() * Math.PI * 2, d = lo + rand() * (hi - lo), px = people.px + Math.cos(a) * d, py = people.py + Math.sin(a) * d;
      const t = Math.floor(py) * W + Math.floor(px);
      if (px >= 0 && py >= 0 && px < W && py < H && main[t] && ok(t) && dry(px, py)) return [px, py];
    }
    return onGround(pick(grass));
  };
  const scatter = (c: [number, number], r: number): [number, number] => {
    for (let tries = 0; tries < 20; tries++) {
      const a = rand() * Math.PI * 2, d = (rand() * r) / TILE_M, px = c[0] + Math.cos(a) * d, py = c[1] + Math.sin(a) * d;
      if (dry(px, py)) return [px, py];
    }
    return c;
  };
  for (let herd = 0; herd < 2; herd++) {
    const c = nearPeople(herd ? 1 : 0.5, herd ? 3 : 1.2, (t) => w.tiles[t] === Tile.Grass);
    for (let i = 0; i < 4; i++) addAnimal(w, "deer", ...scatter(c, 12), { home: c });
  }
  const den = nearPeople(5, 10, (t) => w.tiles[t] !== Tile.Water);
  for (let i = 0; i < 3; i++) addAnimal(w, "wolf", ...scatter(den, 8), { home: den });
  for (let k = 0; k < 20; k++) {
    const c = k < 6 ? nearPeople(0.5, 1.7, (t) => w.tiles[t] === Tile.Grass) : onGround(pick(grass));
    for (let i = 0; i < 4; i++) addAnimal(w, "rabbit", ...scatter(c, 6), { home: c, state: "graze" });
  }
  // Fish keep to the margins, in water within a stone's throw of the bank, where anyone fishing from shore can reach.
  const waters = [...p.coast, ...p.lake], near = [...waters].sort((a, b) => Math.hypot((a % W) - people.px, ((a / W) | 0) - people.py) - Math.hypot((b % W) - people.px, ((b / W) | 0) - people.py)).slice(0, 12);
  const wet = (x: number, y: number) => wetAt(w, x, y), banked = (x: number, y: number) => wet(x, y) && ring(x, y, 25, dry);
  for (let i = 0; i < 160 && waters.length; i++) {
    const t = i < 30 && near.length ? near[i % near.length] : pick(waters), c = inTile(t, banked) ?? inTile(t, wet);
    if (c) addAnimal(w, "fish", ...c, { home: c });
  }
  const edges = shoreOf(w);
  for (let i = 0; i < 12 && edges.length; i++) { const e = edges[Math.floor(rand() * edges.length)], c: [number, number] = [e.px, e.py]; addAnimal(w, "heron", ...c, { home: c, state: "wade" }); }
  for (let k = 0; k < 6 && p.coast.length; k++) {
    const c = inTile(pick(p.coast), () => true)!;
    for (let i = 0; i < 6; i++) addAnimal(w, "gull", c[0] + (rand() - 0.5) * 0.2, c[1] + (rand() - 0.5) * 0.2, { home: c, alt: 8 + rand() * 20, state: "fly" });
  }
  for (let k = 0; k < 10 && p.edge.length; k++) {
    const c = k < 2 ? nearPeople(0.5, 3, (t) => p.edge.includes(t)) : onGround(pick(p.edge));
    for (let i = 0; i < 3; i++) addAnimal(w, "crow", ...scatter(c, 10), { home: c, state: "feed" });
  }
  for (let i = 0; i < 4 && p.high.length; i++) { const c = onGround(p.high[i * 5] ?? pick(p.high)); addAnimal(w, "eagle", ...c, { home: c, alt: 60 + rand() * 60, state: "soar" }); }
  for (let k = 0; k < 30; k++) {
    const f = anyOf(w, "flowers", rand);
    if (!f) break;
    for (let i = 0; i < 3; i++) addAnimal(w, "butterfly", f.px + (rand() - 0.5) * 0.05, f.py + (rand() - 0.5) * 0.05, { home: [f.px, f.py], alt: 0.5 + rand(), state: "flutter" });
  }
  // The island's first animals were there long before anyone woke; this spring's butterflies are new.
  for (const a of w.animals) if (a.species !== "butterfly") a.born = -Math.floor(rand() * 2 * YEAR);
}
