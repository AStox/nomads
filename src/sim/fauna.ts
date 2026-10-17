// Everything alive on the island that isn't a person: what each kind is like and where they start. What they do each
// tick is in animals.ts. Speeds are meters a tick (animals.ts, walk.ts steer), each written in m/s and taken a tick's
// share of. Cited (docs/research/animal-constants.md sec. 15): a ground mammal's run is its fastest sprint on record
// (Garland 1983, R1104), a wolf's and a fox's walk the trot they travel at (R1105, R1106), a deer's trot and a rabbit's
// hop Heglund and Taylor's treadmill speeds (R1108), a deer's walk a person's at the same Froude number, a heron's
// wading a foraging crane's walk, a bird's flight its cruising airspeed tracked by radar (Alerstam et al. 2007, R1107)
// and its climb Hedenström and Alerstam's (R1113). A crow's walk and run and a butterfly's flight are uncited [gap].
import { H, Tile, W, dryAt, dryNear, sea, tileAt, type Animal, type AnimalSpecies, type World } from "./world";
import { put } from "./space";
import { reveal, startPools } from "./pools";
import { rate } from "./ticks";
import { tobler } from "./gait";
import { grown } from "./body";

// A tick's share of a speed in m/s.
const perSecond = (v: number) => rate(v, 1);
// km/h as m/s.
const kmh = (v: number) => v / 3.6;
// Heglund and Taylor's equivalent speeds of 16 quadrupeds from mice to horses on treadmills, m/s, M in kg (R1108, Table
// 2): the least speed each trots at, 0.593 M^0.249, and the trot it prefers, 1.09 M^0.222.
const leastTrot = (kg: number) => 0.593 * kg ** 0.249;
const trot = (kg: number) => 1.09 * kg ** 0.222;
// A walker goes as a person does at the same Froude number v^2 / gL (Alexander and Jayes, R1002): Tobler's speed on the
// level (R1000) for a grown body's leg, its hip 0.530 of its stature (Drillis and Contini, R1062), times the square root
// of the animal's leg over that [derived].
const walkOf = (leg: number) => tobler(0) * Math.sqrt(leg / (0.53 * grown(99).m));
// Hedenström and Alerstam's radar-tracked migrants climbed under power at 1.63 m/s, the dunlin's, down to 0.32 m/s, the
// mute swan's (R1113) [UNVERIFIED: the dunlin taken at 50 g, the swan at 10 kg]; a bird between them by the log of its
// mass [derived].
const climbOf = (kg: number) => 1.63 * (kg / 0.05) ** (Math.log(0.32 / 1.63) / Math.log(10 / 0.05));
// walk, trot, run, fly: meters a tick on foot and on the wing; climb, meters a tick up or down.
export type Kind = { hp: number; walk?: number; trot?: number; run?: number; fly?: number; climb?: number; ground: boolean };
export const FAUNA = {
  // Cervus elaphus 72 km/h (R1104); its trot at 116 kg (animals.ts SPEC), 3.1 m/s; its walk on legs as long as it is
  // tall at the shoulder, 1.07 to 1.37 m (R304) taken at the middle [derived], 1.6 m/s
  deer: { hp: 30, walk: perSecond(walkOf(1.22)), trot: perSecond(trot(116)), run: perSecond(kmh(72)), ground: true },
  // Canis lupus 64 km/h (R1104); trots 8 to 9 km/h for hours (R1105)
  wolf: { hp: 35, walk: perSecond(kmh(8.5)), run: perSecond(kmh(64)), ground: true },
  // Vulpes 72 km/h (R1104, Garland's red fox as Vulpes fulva); trots 6 to 13 km/h (R1106)
  fox: { hp: 12, walk: perSecond(kmh(9.5)), run: perSecond(kmh(72)), ground: true },
  // Oryctolagus cuniculus 56 km/h (R1104); hopping about as it grazes at the least speed a 1.6 kg quadruped trots, 0.67
  // m/s [analogue: a rabbit hops]
  rabbit: { hp: 6, walk: perSecond(leastTrot(1.6)), run: perSecond(kmh(56)), ground: true },
  // cruising airspeeds (R1107): Ardea cinerea 12.5 m/s, Larus argentatus 12.8, Corvus corone 13.5, Haliaeetus albicilla
  // 13.6; each climbing at its mass (animals.ts SPEC: 1.5, 0.97, 0.51 and 4.38 kg). A heron wades at the slowest walk of
  // whooping cranes filmed walking to food, 0.30 m/s (Kinloch et al., R1114) [analogue: a crane for a heron].
  heron: { hp: 8, walk: perSecond(0.3), fly: perSecond(12.5), climb: perSecond(climbOf(1.5)), ground: false },
  gull: { hp: 5, fly: perSecond(12.8), climb: perSecond(climbOf(0.97)), ground: false },
  // a crow's walk and run the meters a step it took a five-minute tick, as meters a second [gap: no crow's walking speed]
  crow: { hp: 4, walk: perSecond(0.5), run: perSecond(1.5), fly: perSecond(13.5), climb: perSecond(climbOf(0.51)), ground: false },
  eagle: { hp: 12, fly: perSecond(13.6), climb: perSecond(climbOf(4.38)), ground: false },
  // a fish seen is stood where its object is (waters.ts showFish) and never moved here
  fish: { hp: 3, ground: false },
  // a butterfly's flight the meters it went a five-minute tick, as meters a second [gap: no temperate butterfly's
  // airspeed]; it rises and falls at 16% of its airspeed, the mean of Dudley's neotropical butterflies' (R1115)
  butterfly: { hp: 1, fly: perSecond(2.5), climb: perSecond(0.16 * 2.5), ground: false },
} satisfies Record<AnimalSpecies, Kind>;
// How near each lets a threat come before it flees, m: its flight initiation distance, walked up to by one person.
export const FID = {
  // red deer in Norway, 57 m on average (Meisingset et al., R1109); from wolves [gap: today's 60 m]
  deer: { person: 57, wolf: 60 },
  // rabbits in Bristol's fields (Huang et al., R1111, Fig. 4): 31.7 m from a person, 30.0 from a fox drawn up on a trolley
  // (and a wolf as a fox [analogue]), 20.4 from a live buzzard (an eagle as a buzzard [analogue])
  rabbit: { person: 31.7, fox: 30, wolf: 30, eagle: 20.4 },
  // rural Danish grey herons 62.08 m, rural French carrion crows 20.41 m (Díaz et al., R1112, Table S1)
  heron: { person: 62.08 },
  crow: { person: 20.41 },
  // [gap: no fox's flight initiation distance; today's 40 m from people and 80 m from wolves]
  fox: { person: 40, wolf: 80 },
};
// How far a red deer runs once flushed: Meisingset et al.'s ran 2036 m on average before stopping for 20 minutes (R1109).
export const ESCAPE_M = 2036;
// People can walk up to and trap what lives on the ground; hunting works on the bigger of those.
export const HUNTED = ["deer", "wolf", "fox", "rabbit"] as const;

// An animal put down in the world by hand: a deer, rabbit, wolf, fox or bird gets a new object on the GPU at the next
// tick (animals.ts sync), held where it stands; those people see of the GPU's own come by spawn as views of theirs.
export const addAnimal = spawn;
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
// The animals a new world starts with, placed from the world's own stream on dry ground.
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
  // The butterflies as each tile's count, and a pack of wolves denning some way off; the fish, deer, rabbits, wolves,
  // foxes and birds take up residence on the GPU with the world's first tick, run on the island's own food before
  // anyone wakes (waters.ts, animals.ts).
  const den = nearPeople(5, 10, (t) => w.tiles[t] !== Tile.Water);
  w.pools = startPools(w, den);
  reveal(w, (sp, px, py) => spawn(w, sp, px, py, revealed(sp, px, py)), rand);
}
