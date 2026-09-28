import { generateIsland, type Island } from "../terrain/island";
import { lay, type Lay, type Terrain } from "../terrain/land";
import { FLORA, SIZE, SPECIES, fineGround, riverSmooth, scatter, waterAt, type Fine, type Scatter } from "../terrain/flora";
import { TRAITS } from "./traits";
import { baseRegistry, type Registry } from "./materials";
import type { Belief } from "./beliefs";
import { enter, put } from "./space";
import { populate } from "./fauna";

export const W = 64;
export const H = 64;
export const DAY = 288; // ticks per in-game day, 5 minutes each
export const YEAR_DAYS = 40;
export const VERSION = 8;
export const TILE_M = 150; // meters per tile
export const REACH = 1.5; // meters: close enough to touch, pick up, strike or tend
export const YEAR = DAY * YEAR_DAYS;

export enum Tile {
  Grass = 0,
  Forest = 1,
  Water = 2,
  Rock = 3,
}

export type ThingKind =
  | "tree" | "stump" | "burnt_stump" | "bush" | "dead_bush" | "sapling" | "mushroom" | "herb"
  | "stick" | "stone" | "pebble" | "boulder" | "fallen_log" | "reeds" | "fern" | "flowers" | "grass" | "clay" | "fire" | "structure" | "item" | "ash"
  | "pit" | "trap" | "well" | "grave";
export type Shelter = { tier: 0 | 1 | 2 | 3; style: string; cover: number; insul: number; sturdy: number; flam: number };
// px, py: where it stands, in tiles (150 m each); x, y are always their floor, the tile it's on.
export type Thing = {
  id: string; kind: ThingKind; x: number; y: number; px: number; py: number;
  size: number; // meters: a tree's height, a rock's width, a stick's length, a patch's or a building's width
  seed: number; // for variation in how it looks
  species?: string;
  n?: number; owner?: string; hp?: number; maxHp?: number; burning?: number; contained?: boolean; stage?: number;
  item?: string; parts?: Record<string, number>; shelter?: Shelter; until?: number; born?: number; burnedBy?: string;
  store?: Stack[]; name?: string; died?: number; cause?: string; caught?: string; progress?: number;
  inside?: Record<string, number>; // hidden in a boulder until it breaks
  scarred?: number; resin?: number; bark?: number; // when a tree was last cut into, resin beaded on it, bark peeled off it
  covered?: boolean; charcoal?: number; air?: number; heat?: number; // fires: closed over, charcoal left, air blown in until, heat level
  shared?: string; given?: Record<string, number>; // a store a camp treats as its own, and who put how much in
};
export type Stack = { k: string; hp: number; born: number };
export type AnimalSpecies = "deer" | "wolf" | "rabbit" | "heron" | "gull" | "crow" | "eagle" | "fish" | "butterfly";
export type Animal = {
  id: string; species: AnimalSpecies; x: number; y: number; px: number; py: number;
  alt: number; // meters above the ground: birds in flight or on a perch, butterflies
  heading: number; // radians, 0 toward +x, turning toward +y
  hp: number; maxHp: number; hunger: number; state: string; target?: string; born: number; dx: number; dy: number;
  home?: [number, number]; // the warren, roost, stretch of shore or water it keeps to, in tiles
  aim?: [number, number]; // where it's headed, in tiles
  since?: number; // tick it took up its current state
};
export type Weather = {
  season: "spring" | "summer" | "autumn" | "winter"; dayOfYear: number; year: number;
  sky: "clear" | "cloudy" | "rain" | "storm"; temp: number; wind: { dx: number; dy: number }; drought: boolean; dryTicks: number;
};
export type Law = { id: string; key: string; text: string; verb: string; source: "physics" | "jev"; by: string; t: number; result?: unknown };

export const BONDS = {
  saved_my_life: "They saved me when I was in real danger",
  gave_me_food: "They fed me or gave me something I needed",
  shared_a_fire: "We sat by the same fire",
  shared_a_meal: "We ate together",
  owes_me: "I did them a favor they haven't returned",
  i_owe_them: "They did me a favor I haven't returned",
  helped_me_work: "They worked beside me",
  taught_me: "I learned something from them",
  stole_from_me: "They took something of mine",
  lied_to_me: "They told me something false",
  humiliated_me: "They insulted or shamed me",
  refused_me: "They turned me down when I asked",
  rival: "We want the same thing",
  kindred_spirit: "We think alike and get along easily",
  sweetheart: "I feel drawn to them romantically",
  destroyed_my_home: "Their fire or doing destroyed my home",
  defended_me: "They stood up for me when I was attacked",
  none: "Nothing lasting came of this",
} as const;
export type BondKind = keyof typeof BONDS;
// weight kept per day; betrayals and life debts linger
export const BOND_FADE: Partial<Record<BondKind, number>> = { saved_my_life: 0.97, stole_from_me: 0.97, destroyed_my_home: 0.98, lied_to_me: 0.97, humiliated_me: 0.97, sweetheart: 0.97 };

export const LABELS = {
  stranger: "Barely know each other",
  acquaintance: "Know each other a little",
  friend: "Like and rely on each other",
  confidant: "Trust each other deeply",
  rival: "Compete or clash",
  enemy: "Hostile, wish each other harm",
  sweetheart: "Romantic feelings",
  mentor: "I learn from them",
  apprentice: "They learn from me",
  kin: "Family",
} as const;
export type Label = keyof typeof LABELS;

export const OPINIONS = ["generous", "honest", "friendly", "dangerous", "hardworking"] as const;
export type Opinion = (typeof OPINIONS)[number];

export type Relationship = {
  affinity: number; // -1..1
  trust: number; // 0..1
  label: Label;
  bonds: { kind: BondKind; t: number; weight: number }[];
  beliefs: Partial<Record<Opinion, number>>;
  ledger: number; // favors they did me minus favors I did them
  history: string[];
  met: number;
};

export type Verb = "strike" | "rub" | "join" | "heat" | "wet" | "shape" | "place" | "plant" | "eat" | "wear" | "throw" | "dig";
// One concrete attempt: which verb, with which held items, on what.
export type Act = {
  verb: Verb;
  items: string[]; // kind ids from inventory that are used or worked on
  tool?: string | null; // held kind used to strike or rub with; null = bare hands
  target?: { thing?: string; animal?: string; kind?: string }; // world thing / animal id, and its kind
  shape?: "bowl" | "block";
  at?: string | null; // place the act needs: fire, water, home
};
export type Step = { op: string; arg?: string; progress: number; label?: string; act?: Act; heat?: number; tries?: number; key?: string; started?: number };
export type Goal = { type: string; target?: string; since: number; odds: Record<string, number>; fails: number; stages?: number };

export type Needs = { food: number; energy: number; warmth: number; health: number; social: number };

export type Agent = {
  id: string;
  name: string;
  color: string;
  x: number;
  y: number;
  px: number; // where they stand, in tiles; x and y are its floor
  py: number;
  heading: number; // radians they last faced
  bio: string;
  traits: Record<string, number>;
  desires: string[];
  needs: Needs;
  skills: Record<string, number>; // appears the first time they use a craft
  inv: Stack[];
  wearing: Stack | null;
  beliefs: Record<string, Belief>; // what they think happens when they do things
  facts: Record<string, string>; // what they've seen about the world
  tried: Record<string, number>; // tinker attempts that led nowhere
  watching: Record<string, number>; // progress toward learning a belief by watching someone
  sickness: { until: number; severity: number } | null;
  born: number; // tick; negative for the first generation
  parents: string[];
  children: string[];
  pregnant: { father: string; due: number } | null;
  home: string | null; // structure id
  rel: Record<string, Relationship>;
  memory: string[];
  goal: Goal | null;
  plan: Step[];
  status: string;
  lastDecision: { t: number; goal: Record<string, number>; labels: Record<string, string>; who?: Record<string, number>; chosen: string; target?: string } | null;
  thinking: boolean;
  engaged: string | null;
  down: number;
  nextDecide: number;
  cooldowns: Record<string, number>;
  seen: Record<string, number>;
  near: Record<string, number>; // ticks spent close to each person today
  customs: Record<string, number>; // spoken customs they've heard, custom id -> when
};

// The five ways a camp can answer what someone did. Which acts get which answer is up to the camp's history.
export const RESPONSES = {
  let_go: "Let it go",
  scold: "Scold them in front of everyone",
  repay: "Demand they give it back, or make it up double",
  shun: "Shun them: no one trades, shares, or talks with them for a few days",
  drive_out: "Drive them out: they lose their place here and can't keep a home inside the camp",
} as const;
export type Response = keyof typeof RESPONSES;
export type Incident = {
  id: string; t: number; act: string; by: string; against?: string; x: number; y: number; text: string;
  group?: string; // the camp that answered it
  items?: string[]; // what changed hands, from `against` to `by` (or from giver to receiver)
  features: {
    against_member: boolean; against_kin: boolean; against_child: boolean;
    value: number; need: number; season: string; scarcity: number; repeat: number; seenBy: string[];
  };
};
export type Precedent = {
  id: string; group: string; incident: Incident; response: Response; decidedBy: string; t: number;
  followed: string[]; defied: string[];
  open?: number; // still watching who goes along with it, until this tick
};
export type Custom = { id: string; key: string; text: string; response: Response; spokenBy: string; t: number; held: number; broken: number; faded?: number };
export type Camp = {
  id: string; name: string; named: boolean; founder: string; founded: number; members: string[]; x: number; y: number; px: number; py: number;
  leader: string | null; leaderSince?: number; precedents: Precedent[]; customs: Custom[];
  shunned: Record<string, { until: number; precedent: string }>;
  exiled: Record<string, { until: number; precedent: string }>;
  store?: string; gone?: number; mergedInto?: string; from?: string;
};

// tag: a few words naming a milestone, for timelines.
export type Event = { id: number; t: number; kind: string; who: string[]; x: number; y: number; text: string; tag?: string };

export type World = {
  version: number;
  seed: number;
  t: number;
  tiles: Tile[];
  heights: number[]; // ground height at tile corners, (W + 1) * (H + 1), in tile widths (150 m) above the waterline
  terrain: Terrain; // the simulated ground the tiles were read from, for the map and anything that wants more detail
  paths: number[]; // walking wear per tile, 0..9
  things: Thing[];
  agents: Agent[];
  animals: Animal[];
  events: Event[];
  nextId: number;
  jev: { calls: number; tokens: number; rulings: number };
  kinds: Registry;
  ice: number[]; // frozen water tiles
  people: Record<string, { id: string; name: string; color: string; alive: boolean; died?: number; cause?: string }>;
  laws: Record<string, Law>;
  rulings: Record<string, { useful: boolean; name: string; props: Record<string, number> }>; // Jev answers, cached forever
  weather: Weather;
  camps: Camp[];
  incidents: Incident[]; // recent, judged or not
};

export function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let r = Math.imul(s ^ (s >>> 15), 1 | s);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

export function nearWater(w: World, x: number, y: number, r: number) {
  for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) if (tileAt(w, x + dx, y + dy) === Tile.Water) return true;
  return false;
}
export const tileAt = (w: World, x: number, y: number) =>
  x < 0 || y < 0 || x >= W || y >= H ? Tile.Water : w.tiles[y * W + x];
// Tiles someone could stand somewhere on: any dry ground in them, or ice. A coarse filter; dryAt says for a point.
export const walkable = (w: World, x: number, y: number) =>
  x >= 0 && y >= 0 && x < W && y < H && (groundOf(w.seed).dry[y * W + x] === 1 || (w.tiles[y * W + x] === Tile.Water && iceAt(w, x, y)));
// Standing water at a point (in tiles): the fine wet field the map draws lakes and the sea from.
export const wetAt = (w: World, px: number, py: number) => {
  const g = groundOf(w.seed);
  return waterAt(g.isle, g.fine, px * TILE_M - SIZE / 2, py * TILE_M - SIZE / 2) > 0.5;
};
// Ground at a point: on the map and not under water, unless the water there is frozen.
export const dryAt = (w: World, px: number, py: number) =>
  px >= 0 && py >= 0 && px < W && py < H && (!wetAt(w, px, py) || iceAt(w, Math.floor(px), Math.floor(py)));
// The nearest dry point, searching outward a meter at a time close in and coarser further out.
export function dryNear(w: World, px: number, py: number, max = 3000): [number, number] | null {
  if (dryAt(w, px, py)) return [px, py];
  for (let r = 1; r <= max; r += r < 20 ? 1 : r < 200 ? 5 : 25)
    for (let k = 0; k < 24; k++) {
      const a = (k / 24) * Math.PI * 2, x = px + (Math.cos(a) * r) / TILE_M, y = py + (Math.sin(a) * r) / TILE_M;
      if (dryAt(w, x, y)) return [x, y];
    }
  return null;
}
// The largest stretch of ground one can walk across. Rocks and islets offshore, or in a lake, are cut off from it.
export function mainland(w: World) {
  const seen = new Uint8Array(W * H);
  let best: number[] = [];
  for (let s = 0; s < W * H; s++) {
    if (seen[s] || !walkable(w, s % W, Math.floor(s / W))) continue;
    const part = [s];
    seen[s] = 1;
    for (let i = 0; i < part.length; i++) {
      const x = part[i] % W, y = Math.floor(part[i] / W);
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx, ny = y + dy, n = ny * W + nx;
          if (nx >= 0 && ny >= 0 && nx < W && ny < H && !seen[n] && walkable(w, nx, ny)) { seen[n] = 1; part.push(n); }
        }
    }
    if (part.length > best.length) best = part;
  }
  const main = new Uint8Array(W * H);
  for (const t of best) main[t] = 1;
  return main;
}
// Water joined to the open sea past the map's edge, as against lakes.
export function sea(w: World) {
  const salt = new Uint8Array(W * H), open: number[] = [];
  for (let t = 0; t < W * H; t++) {
    const x = t % W, y = Math.floor(t / W);
    if ((x === 0 || y === 0 || x === W - 1 || y === H - 1) && w.tiles[t] === Tile.Water) { salt[t] = 1; open.push(t); }
  }
  for (let i = 0; i < open.length; i++) {
    const x = open[i] % W, y = Math.floor(open[i] / W);
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy, n = ny * W + nx;
      if (nx >= 0 && ny >= 0 && nx < W && ny < H && !salt[n] && w.tiles[n] === Tile.Water) { salt[n] = 1; open.push(n); }
    }
  }
  return salt;
}
// Where anyone arriving by sea comes ashore: in from a random point off the coast, the first dry ground of the mainland.
export function landing(w: World) {
  const main = mainland(w), a = Math.random() * Math.PI * 2;
  for (let d = Math.hypot(W, H) / 2; d > 0; d -= 0.1) {
    const px = W / 2 + Math.cos(a) * d, py = H / 2 + Math.sin(a) * d, x = Math.floor(px), y = Math.floor(py);
    if (x >= 0 && y >= 0 && x < W && y < H && main[y * W + x] && dryAt(w, px, py)) return { x, y, px, py };
  }
  return null;
}
// ponytail: linear scan of the ice list; index it if winters ever freeze more than a few hundred tiles.
export const iceAt = (w: World, x: number, y: number) => w.ice.length > 0 && w.ice.includes(y * W + x);
export const ageOf = (w: World, a: { born: number }) => (w.t - a.born) / YEAR;
export const stageOf = (w: World, a: { born: number }) => { const y = ageOf(w, a); return y < 1 ? "child" : y < 5 ? "adult" : "elder"; };
export const dist = (a: { x: number; y: number }, b: { x: number; y: number }) =>
  Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
// Straight-line meters between two things that stand somewhere.
export const meters = (a: { px: number; py: number }, b: { px: number; py: number }) => Math.hypot(a.px - b.px, a.py - b.py) * TILE_M;
// How near someone has to stand to work on a thing: arm's length from its edge, or from a tree's trunk.
export const reachOf = (t: { kind: string; size: number }) => REACH + (t.kind === "tree" || t.kind === "stump" || t.kind === "burnt_stump" || t.kind === "sapling" ? 0.3 : Math.min(3, t.size / 2));

export const level = (xp: number) => Math.min(10, Math.floor(Math.sqrt(xp / 10)));

export const NAMES = ["Aldric", "Mara", "Osric", "Tamsin", "Brenna", "Wulf", "Edda", "Rowan", "Isolde", "Cedric", "Hild", "Bran", "Ysolt", "Gareth", "Sabine", "Anselm", "Elowen", "Tobin", "Maud", "Corwin", "Ailsa", "Fenwick", "Gwen", "Leof", "Rhosyn", "Odo", "Nell", "Piers"];
// Heraldic tinctures, muted to sit on parchment.
export const COLORS = ["#9e3b2f", "#2f4a6d", "#a8812a", "#4e6b3a", "#6b3f5e", "#8a5a2b", "#3d6b6b", "#7a2f3f", "#5a4a8a", "#2f6b52", "#8a3b6b", "#6b6b2f"];
export const DESIRES = [
  "own a home of their own",
  "find someone to love",
  "be respected by others",
  "become rich",
  "lead others",
  "master a craft",
  "see what lies beyond the hills",
  "protect the people they care about",
  "be left alone",
  "never go hungry again",
  "make a true friend",
  "build something that lasts",
  "live a quiet, simple life",
];
const OPPOSITES = [
  ["calm", "hot-tempered"], ["brave", "cowardly"], ["gregarious", "loner"], ["honest", "deceitful"],
  ["generous", "greedy"], ["trusting", "suspicious"], ["forgiving", "vengeful"], ["merciful", "cruel"],
  ["humble", "arrogant"], ["lawful", "rebellious"], ["selfless", "selfish"], ["ambitious", "content"],
  ["industrious", "lazy"], ["curious", "cautious"], ["restless", "homebody"], ["stubborn", "adaptable"],
  ["clever", "dim"], ["wise", "naive"], ["traditional", "creative"], ["superstitious", "skeptical"],
  ["glutton", "ascetic"], ["tidy", "slovenly"], ["early riser", "night owl"], ["thrifty", "spendthrift"],
  ["hardy", "frail"], ["cheerful", "melancholy"], ["patient", "impulsive"], ["loyal", "fickle"],
  ["honorable", "opportunist"], ["pious", "cynical"], ["just", "ruthless"], ["scholarly", "practical"],
  ["discreet", "gossip"], ["domineering", "deferential"], ["shy", "charismatic"], ["adventurous", "cautious"],
];
export const clash = (a: string, b: string) => OPPOSITES.some(([x, y]) => (x === a && y === b) || (x === b && y === a));

// Growing an island and everything on it takes a good fraction of a second and depends only on the seed, so tests that
// rebuild the same world reuse it. Callers get their own copies of anything the game might change.
export type Ground = { land: Lay; isle: Island; fine: Fine; flora: Scatter; dry: Uint8Array; shore?: { px: number; py: number }[] }; // dry: 1 per tile with dry ground in it
const grounds = new Map<number, Ground>();
let lastSeed = NaN, last: Ground | null = null;
export function groundOf(seed: number): Ground {
  if (seed === lastSeed && last) return last;
  let g = grounds.get(seed);
  if (!g) {
    const isle = generateIsland(rng(seed)), fine = fineGround(isle), dry = new Uint8Array(W * H);
    for (let t = 0; t < W * H; t++)
      for (let k = 0; k < 36 && !dry[t]; k++) {
        const x = (t % W) + ((k % 6) + 0.5) / 6, y = Math.floor(t / W) + (Math.floor(k / 6) + 0.5) / 6;
        if (waterAt(isle, fine, x * TILE_M - SIZE / 2, y * TILE_M - SIZE / 2) <= 0.5) dry[t] = 1;
      }
    g = { land: lay(isle), isle, fine, flora: scatter(isle, fine, seed), dry };
    grounds.set(seed, g);
  }
  lastSeed = seed; last = g;
  return g;
}
// The one number every sprite of a thing, animal or person is varied by, in the map and in the inspector alike: a
// thing's own seed, or a hash of an animal's or person's id.
export function spriteSeed(e: { id: string; seed?: number }) {
  if (e.seed !== undefined) return e.seed >>> 0;
  let h = 2166136261;
  for (let i = 0; i < e.id.length; i++) h = Math.imul(h ^ e.id.charCodeAt(i), 16777619);
  return h >>> 0;
}
// Where to stand to dip into water: a meter back from the water's edge, found along a grid of about 19 m. It depends
// only on the island, so newWorld works it out once per seed, before the first tick.
export function shoreOf(w: World) {
  const g = groundOf(w.seed);
  if (g.shore) return g.shore;
  const s: { px: number; py: number }[] = [], step = 1 / 8, back = 1 / TILE_M;
  for (let y = step / 2; y < H; y += step)
    for (let x = step / 2; x < W; x += step) {
      if (wetAt(w, x, y)) continue;
      for (const [dx, dy] of [[step, 0], [-step, 0], [0, step], [0, -step]]) {
        if (!wetAt(w, x + dx, y + dy)) continue;
        let lo = 0, hi = 1;
        for (let k = 0; k < 7; k++) { const m = (lo + hi) / 2; if (wetAt(w, x + dx * m, y + dy * m)) hi = m; else lo = m; }
        const px = x + dx * lo - Math.sign(dx) * back, py = y + dy * lo - Math.sign(dy) * back;
        if (!wetAt(w, px, py)) s.push({ px, py });
      }
    }
  return (g.shore = s);
}
// Which of the heraldic colors a person wears, as an index into COLORS.
export const colorIndex = (a: { color: string }) => Math.max(0, COLORS.indexOf(a.color));
// World meters (the island's center at 0) to tiles, to a tenth of a millimeter's worth of tile.
export const tileOf = (m: number) => Math.round(((m + SIZE / 2) / TILE_M) * 1e4) / 1e4;

// What each kind of growing or lying thing can take before it's gone, by its size in meters.
const HP: Record<string, (size: number) => number> = {
  tree: (s) => Math.round(30 + s * 4.5), bush: () => 20, boulder: (s) => Math.round(60 + s * 40), stone: () => 40, pebble: () => 10,
  stick: () => 8, fallen_log: (s) => Math.round(20 + s * 6), mushroom: () => 2, herb: () => 3, reeds: () => 6, fern: () => 4, flowers: () => 2, clay: () => 10, grass: () => 3,
};

export function newWorld(seed: number, agentCount = 5): World {
  const g = groundOf(seed), { land, flora: f } = g;
  // People, animals and loose things draw from their own stream, so a seed's island stays the same whatever they do.
  const rand = rng(seed ^ 0x5f3759df);
  const tiles = [...land.tiles];
  const w: World = {
    version: VERSION, seed, t: Math.round(DAY * 0.3), tiles, heights: [...land.heights], terrain: land.terrain, paths: new Array(W * H).fill(0), things: [], agents: [], animals: [], events: [],
    nextId: 1, jev: { calls: 0, tokens: 0, rulings: 0 }, kinds: baseRegistry(), laws: {}, rulings: {}, ice: [], people: {},
    weather: { season: "spring", dayOfYear: 0, year: 1, sky: "clear", temp: 14, wind: { dx: land.terrain.wind[0] / 2, dy: land.terrain.wind[1] / 2 }, drought: false, dryTicks: 0 },
    camps: [], incidents: [],
  };
  for (let i = 0; i < f.n; i++) {
    const kind = FLORA[f.kind[i]], px = tileOf(f.x[i]), py = tileOf(f.z[i]), size = Math.round(f.size[i] * 100) / 100, seed = f.seed[i];
    // Rounding to tiles can nudge a point at the very edge of water or a stream over it; the map would not draw it there.
    if (wetAt(w, px, py) || riverSmooth(g.fine, px * TILE_M - SIZE / 2, py * TILE_M - SIZE / 2) > 0.5) continue;
    if (kind === "ore") { addThing(w, "item", px, py, { item: "ore", n: 1, size, seed }); continue; }
    const hp = HP[kind](size);
    const t: Thing = { id: `t${w.nextId++}`, kind, x: Math.floor(px), y: Math.floor(py), px, py, size, seed, species: SPECIES[f.species[i]] || undefined, hp, maxHp: hp };
    if (kind === "bush" && t.species === "berry") t.n = 4;
    // Flint forms as nodules inside the rock; ore shows as reddish stones, and sometimes inside boulders too.
    const q = ((seed >>> 8) & 0xffff) / 65536;
    if (kind === "boulder" && (q < 0.45 || q > 0.85)) t.inside = q < 0.45 ? { flint: q < 0.15 ? 2 : 1 } : { ore: 1 };
    enter(w, t, false);
  }
  const traitNames = Object.keys(TRAITS), main = mainland(w);
  const open = (px: number, py: number) => tileAt(w, Math.floor(px), Math.floor(py)) === Tile.Grass && !!main[Math.floor(py) * W + Math.floor(px)] && dryAt(w, px, py);
  // They wake within a few minutes' walk of each other, each alone.
  let cx = 0, cy = 0;
  do { cx = 12 + rand() * (W - 24); cy = 12 + rand() * (H - 24); } while (!open(cx, cy));
  for (let i = 0; i < agentCount; i++) {
    let px = cx, py = cy;
    for (let tries = 0; i > 0; tries++) {
      const a = rand() * Math.PI * 2, d = (60 + rand() * 120) / TILE_M;
      [px, py] = tries < 400 ? [cx + Math.cos(a) * d, cy + Math.sin(a) * d] : [12 + rand() * (W - 24), 12 + rand() * (H - 24)];
      if (open(px, py) && w.agents.every((b) => meters(b, { px, py }) >= 50)) break;
    }
    px = Math.round(px * 1e4) / 1e4; py = Math.round(py * 1e4) / 1e4;
    const traits: Record<string, number> = {};
    const count = 5 + Math.floor(rand() * 4);
    while (Object.keys(traits).length < count) {
      const t = traitNames[Math.floor(rand() * traitNames.length)];
      if (!traits[t] && !Object.keys(traits).some((o) => clash(o, t))) traits[t] = Math.round((0.4 + rand() * 0.6) * 100) / 100;
    }
    const desires = [...DESIRES].sort(() => rand() - 0.5).slice(0, 2);
    const name = NAMES[i % NAMES.length];
    const top = Object.entries(traits).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([t]) => t);
    w.agents.push({
      id: name.toLowerCase(), name, color: COLORS[i % COLORS.length], x: Math.floor(px), y: Math.floor(py), px, py, heading: rand() * Math.PI * 2,
      bio: `${name} is ${top.slice(0, -1).join(", ")} and ${top.at(-1)}. ${name} wants to ${desires[0]} and to ${desires[1]}.`,
      traits, desires,
      needs: { food: 55 + rand() * 30, energy: 60 + rand() * 30, warmth: 70 + rand() * 20, health: 100, social: 40 + rand() * 40 },
      skills: {}, inv: [], wearing: null, beliefs: {}, facts: {}, tried: {}, watching: {}, sickness: null, home: null,
      born: -Math.round(YEAR * (1.2 + rand() * 0.8)), parents: [], children: [], pregnant: null,
      rel: {}, memory: [], goal: null, plan: [], status: "Waking up in the wilderness", lastDecision: null,
      thinking: false, engaged: null, down: 0, nextDecide: 0, cooldowns: {}, seen: {}, near: {}, customs: {},
    });
  }
  populate(w, rand, main);
  shoreOf(w);
  for (const a of w.agents) {
    w.people[a.id] = { id: a.id, name: a.name, color: a.color, alive: true };
    log(w, "wake", [a.id], a, `${a.name} woke up alone in the wilderness.`);
  }
  return w;
}

// How big a thing made or dropped in the world starts out, in meters, when whoever makes it doesn't say.
const MADE_SIZE: Partial<Record<ThingKind, number>> = {
  fire: 1, structure: 2, item: 0.3, ash: 1.2, pit: 1.5, trap: 1.5, well: 1.5, grave: 2, sapling: 0.3, stump: 0.6, burnt_stump: 0.6,
  dead_bush: 1, stick: 1, stone: 0.2, mushroom: 0.1, herb: 0.3, reeds: 1.5, clay: 1,
};
// Anything that comes into the world after the ground was laid out, at a point in tiles.
export function addThing(w: World, kind: ThingKind, px: number, py: number, extra: Partial<Thing> = {}): Thing {
  const n = w.nextId++;
  const t: Thing = { id: `t${n}`, kind, x: 0, y: 0, px: 0, py: 0, size: MADE_SIZE[kind] ?? 0.5, seed: Math.imul(n, 2654435761) >>> 0, ...extra };
  put(w, t, px, py);
  enter(w, t, true);
  return t;
}

export const dayOfYear = (t: number) => Math.floor(t / DAY) % YEAR_DAYS;
export const seasonOf = (t: number): Weather["season"] => (["spring", "summer", "autumn", "winter"] as const)[Math.floor(dayOfYear(t) / 10)];

// Routine events stay in the chronicle but not in an agent's memory, so Jev and stories see what mattered.
export const QUIET: Record<string, true> = { goal: true, gather: true, eat: true, stuck: true, tinker: true, craft: true, spoil: true, grow: true, birth: true, weather: true, fire_spread: true, fire_out: true, level: true };

export function log(w: World, kind: string, who: string[], at: { x: number; y: number }, text: string, tag?: string): Event {
  const e: Event = { id: w.nextId++, t: w.t, kind, who, x: at.x, y: at.y, text, ...(tag ? { tag } : {}) };
  w.events.push(e);
  if (QUIET[kind]) return e;
  for (const id of who) {
    const a = w.agents.find((a) => a.id === id);
    if (a) a.memory = [...a.memory, `${clock(w.t)}: ${text}`].slice(-12);
  }
  return e;
}

export function clock(t: number) {
  const day = Math.floor(t / DAY) + 1;
  const h = ((t % DAY) / DAY) * 24;
  const part = h < 5 ? "night" : h < 8 ? "dawn" : h < 12 ? "morning" : h < 17 ? "afternoon" : h < 20 ? "evening" : "night";
  return `Day ${day}, ${part}`;
}
export const isNight = (t: number) => {
  const h = ((t % DAY) / DAY) * 24;
  return h < 5 || h >= 20;
};
