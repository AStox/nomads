// Everything alive on the island that isn't a person: what each kind is like and where they start. What they do each
// tick is in animals.ts. Speeds are meters a tick of five minutes' game time, the way a person's are.
import { H, TILE_M, Tile, W, YEAR, sea, tileAt, walkable, type Animal, type AnimalSpecies, type World } from "./world";
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
const inTile = (t: number, rand: () => number): [number, number] => [(t % W) + 0.1 + rand() * 0.8, ((t / W) | 0) + 0.1 + rand() * 0.8];

// The animals a new world starts with, placed from the world's own stream.
export function populate(w: World, rand: () => number, main: Uint8Array) {
  const p = placesOf(w), pick = (list: number[]) => list[Math.floor(rand() * list.length)], grass = p.grass.filter((t) => main[t]);
  const people = w.agents.length ? { px: w.agents.reduce((s, a) => s + a.px, 0) / w.agents.length, py: w.agents.reduce((s, a) => s + a.py, 0) / w.agents.length } : { px: W / 2, py: H / 2 };
  // A spot on the mainland between lo and hi tiles from where people woke, on tiles that pass ok.
  const nearPeople = (lo: number, hi: number, ok: (t: number) => boolean): [number, number] => {
    for (let tries = 0; tries < 500; tries++) {
      const a = rand() * Math.PI * 2, d = lo + rand() * (hi - lo), px = people.px + Math.cos(a) * d, py = people.py + Math.sin(a) * d;
      const t = Math.floor(py) * W + Math.floor(px);
      if (px >= 0 && py >= 0 && px < W && py < H && main[t] && ok(t)) return [px, py];
    }
    return inTile(pick(grass), rand);
  };
  const scatter = (c: [number, number], r: number): [number, number] => {
    for (let tries = 0; tries < 20; tries++) {
      const a = rand() * Math.PI * 2, d = (rand() * r) / TILE_M, px = c[0] + Math.cos(a) * d, py = c[1] + Math.sin(a) * d;
      if (walkable(w, Math.floor(px), Math.floor(py))) return [px, py];
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
    const c = k < 6 ? nearPeople(0.5, 1.7, (t) => w.tiles[t] === Tile.Grass) : inTile(pick(grass), rand);
    for (let i = 0; i < 4; i++) addAnimal(w, "rabbit", ...scatter(c, 6), { home: c, state: "graze" });
  }
  // Fish keep to the margins, a few paces to a stone's throw out from the bank, where anyone fishing from shore can reach.
  const waters = [...p.coast, ...p.lake], near = [...waters].sort((a, b) => Math.hypot((a % W) - people.px, ((a / W) | 0) - people.py) - Math.hypot((b % W) - people.px, ((b / W) | 0) - people.py)).slice(0, 12);
  const margin = (t: number): [number, number] => {
    const x = t % W, y = (t / W) | 0, banks = [[1, 0], [-1, 0], [0, 1], [0, -1]].filter(([dx, dy]) => tileAt(w, x + dx, y + dy) !== Tile.Water && x + dx >= 0 && y + dy >= 0 && x + dx < W && y + dy < H);
    if (!banks.length) return inTile(t, rand);
    const [dx, dy] = banks[Math.floor(rand() * banks.length)], out = (5 + rand() * 20) / TILE_M, along = 0.1 + rand() * 0.8;
    return [x + (dx ? (dx > 0 ? 1 - out : out) : along), y + (dy ? (dy > 0 ? 1 - out : out) : along)];
  };
  for (let i = 0; i < 160 && waters.length; i++) { const c = margin(i < 30 && near.length ? near[i % near.length] : pick(waters)); addAnimal(w, "fish", ...c, { home: c }); }
  for (let i = 0; i < 12 && p.shore.length; i++) { const c = inTile(pick(p.shore), rand); addAnimal(w, "heron", ...c, { home: c, state: "wade" }); }
  for (let k = 0; k < 6 && p.coast.length; k++) {
    const c = inTile(pick(p.coast), rand);
    for (let i = 0; i < 6; i++) addAnimal(w, "gull", c[0] + (rand() - 0.5) * 0.2, c[1] + (rand() - 0.5) * 0.2, { home: c, alt: 8 + rand() * 20, state: "fly" });
  }
  for (let k = 0; k < 10 && p.edge.length; k++) {
    const c = k < 2 ? nearPeople(0.5, 3, (t) => p.edge.includes(t)) : inTile(pick(p.edge), rand);
    for (let i = 0; i < 3; i++) addAnimal(w, "crow", ...scatter(c, 10), { home: c, state: "feed" });
  }
  for (let i = 0; i < 4 && p.high.length; i++) { const c = inTile(p.high[i * 5] ?? pick(p.high), rand); addAnimal(w, "eagle", ...c, { home: c, alt: 60 + rand() * 60, state: "soar" }); }
  for (let k = 0; k < 30; k++) {
    const f = anyOf(w, "flowers", rand);
    if (!f) break;
    for (let i = 0; i < 3; i++) addAnimal(w, "butterfly", f.px + (rand() - 0.5) * 0.05, f.py + (rand() - 0.5) * 0.05, { home: [f.px, f.py], alt: 0.5 + rand(), state: "flutter" });
  }
  // The island's first animals were there long before anyone woke; this spring's butterflies are new.
  for (const a of w.animals) if (a.species !== "butterfly") a.born = -Math.floor(rand() * 2 * YEAR);
}
