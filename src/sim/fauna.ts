// Everything alive on the island that isn't a person: what each kind is like and where they start. What they do each
// tick is in animals.ts. Speeds are meters a tick of five minutes' game time, the way a person's are.
import { H, Tile, W, YEAR, dryAt, dryNear, sea, tileAt, type Animal, type AnimalSpecies, type World } from "./world";
import { put } from "./space";
import { herded, reveal, startHerds } from "./herds";

type Kind = { hp: number; walk: number; run: number; fly?: number; ground: boolean };
export const FAUNA: Record<AnimalSpecies, Kind> = {
  deer: { hp: 30, walk: 1.5, run: 8, ground: true },
  wolf: { hp: 35, walk: 1.5, run: 8, ground: true },
  fox: { hp: 12, walk: 1.2, run: 7, ground: true },
  rabbit: { hp: 6, walk: 0.6, run: 5, ground: true },
  heron: { hp: 8, walk: 0.4, run: 1, fly: 12, ground: false },
  gull: { hp: 5, walk: 0.5, run: 1, fly: 14, ground: false },
  crow: { hp: 4, walk: 0.5, run: 1.5, fly: 12, ground: false },
  eagle: { hp: 12, walk: 0.3, run: 1, fly: 18, ground: false },
  fish: { hp: 3, walk: 1, run: 3, ground: false },
  butterfly: { hp: 1, walk: 1, run: 2.5, fly: 2.5, ground: false },
};
// People can walk up to and trap what lives on the ground; hunting works on the bigger of those.
export const HUNTED = ["deer", "wolf", "fox", "rabbit"] as const;

// An animal put down in the world: a deer, rabbit or wolf put down by hand is one more on its tile (herds.ts); those
// the herds stand on the ground themselves come by spawn, being theirs already.
export function addAnimal(w: World, species: AnimalSpecies, px: number, py: number, extra: Partial<Animal> = {}): Animal {
  if (herded(species) && w.herds) w.herds[species].n[Math.min(H - 1, Math.floor(py)) * W + Math.min(W - 1, Math.floor(px))] += 1;
  return spawn(w, species, px, py, extra);
}
export function spawn(w: World, species: AnimalSpecies, px: number, py: number, extra: Partial<Animal> = {}): Animal {
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
// How one of a herd stands when it comes into sight: rabbits grazing, fish swimming, herons wading, eagles soaring, gulls
// on the wing, crows feeding, butterflies among the flowers.
const POSE: Partial<Record<AnimalSpecies, [string, number, number]>> = { rabbit: ["graze", 0, 0], fish: ["swim", 0, 0], heron: ["wade", 0, 0], eagle: ["soar", 60, 60], gull: ["fly", 8, 20], crow: ["feed", 0, 0], butterfly: ["flutter", 0.5, 1] };
export const revealed = (sp: AnimalSpecies, px: number, py: number): Partial<Animal> => {
  const [state, alt, spread] = POSE[sp] ?? ["wander", 0, 0];
  return { home: [px, py], state, alt: alt + ((px * 977 + py * 131) % 1) * spread };
};
export function populate(w: World, rand: () => number, main: Uint8Array) {
  const p = placesOf(w), pick = (list: number[]) => list[Math.floor(rand() * list.length)], grass = p.grass.filter((t) => main[t]);
  const people = w.agents.length ? { px: w.agents.reduce((s, a) => s + a.px, 0) / w.agents.length, py: w.agents.reduce((s, a) => s + a.py, 0) / w.agents.length } : { px: W / 2, py: H / 2 };
  const dry = (x: number, y: number) => dryAt(w, x, y);
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
  // Deer, rabbits, wolves, foxes and the fish as populations, run on twenty years of the island's own forage before anyone wakes, a pack
  // of wolves denning some way off (herds.ts); those within sight of anyone stand on the ground from the start.
  const den = nearPeople(5, 10, (t) => w.tiles[t] !== Tile.Water);
  w.herds = startHerds(w, den);
  reveal(w, (sp, px, py) => spawn(w, sp, px, py, revealed(sp, px, py)), rand);
  // The island's first animals were there long before anyone woke; this summer's butterflies are new.
  for (const a of w.animals) if (a.species !== "butterfly") a.born = -Math.floor(rand() * 2 * YEAR);
}
