import { TRAITS } from "./traits";
import { baseRegistry, type Registry } from "./materials";
import type { Belief } from "./beliefs";

export const W = 64;
export const H = 64;
export const DAY = 288; // ticks per in-game day, 5 minutes each
export const YEAR_DAYS = 40;
export const VERSION = 5;
export const YEAR = DAY * YEAR_DAYS;

export enum Tile {
  Grass = 0,
  Forest = 1,
  Water = 2,
  Rock = 3,
}

export type ThingKind =
  | "tree" | "stump" | "burnt_stump" | "bush" | "dead_bush" | "sapling" | "mushroom" | "herb"
  | "stick" | "stone" | "boulder" | "reeds" | "clay" | "fire" | "structure" | "item" | "ash"
  | "pit" | "trap" | "well" | "grave";
export type Shelter = { tier: 0 | 1 | 2 | 3; style: string; cover: number; insul: number; sturdy: number; flam: number };
export type Thing = {
  id: string; kind: ThingKind; x: number; y: number;
  n?: number; owner?: string; hp?: number; maxHp?: number; burning?: number; contained?: boolean; stage?: number;
  item?: string; parts?: Record<string, number>; shelter?: Shelter; until?: number; born?: number; burnedBy?: string;
  store?: Stack[]; name?: string; died?: number; cause?: string; caught?: string; progress?: number;
  inside?: Record<string, number>; // hidden in a boulder until it breaks
  scarred?: number; resin?: number; bark?: number; // when a tree was last cut into, resin beaded on it, bark peeled off it
  covered?: boolean; charcoal?: number; air?: number; heat?: number; // fires: closed over, charcoal left, air blown in until, heat level
  shared?: string; given?: Record<string, number>; // a store a camp treats as its own, and who put how much in
};
export type Stack = { k: string; hp: number; born: number };
export type Animal = {
  id: string; species: "deer" | "wolf"; x: number; y: number; hp: number; maxHp: number;
  hunger: number; state: string; target?: string; born: number; dx: number; dy: number;
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
  id: string; name: string; named: boolean; founder: string; founded: number; members: string[]; x: number; y: number;
  leader: string | null; leaderSince?: number; precedents: Precedent[]; customs: Custom[];
  shunned: Record<string, { until: number; precedent: string }>;
  exiled: Record<string, { until: number; precedent: string }>;
  store?: string; gone?: number; mergedInto?: string; from?: string;
};

export type Event = { id: number; t: number; kind: string; who: string[]; x: number; y: number; text: string };

export type World = {
  version: number;
  seed: number;
  t: number;
  tiles: Tile[];
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

function noise(rand: () => number, cell: number) {
  const gw = Math.ceil(W / cell) + 2;
  const g = Array.from({ length: gw * gw }, rand);
  const smooth = (t: number) => t * t * (3 - 2 * t);
  return (x: number, y: number) => {
    const gx = x / cell, gy = y / cell;
    const x0 = Math.floor(gx), y0 = Math.floor(gy);
    const fx = smooth(gx - x0), fy = smooth(gy - y0);
    const v = (a: number, b: number) => g[b * gw + a];
    const top = v(x0, y0) * (1 - fx) + v(x0 + 1, y0) * fx;
    const bot = v(x0, y0 + 1) * (1 - fx) + v(x0 + 1, y0 + 1) * fx;
    return top * (1 - fy) + bot * fy;
  };
}

export function nearWater(w: World, x: number, y: number, r: number) {
  for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) if (tileAt(w, x + dx, y + dy) === Tile.Water) return true;
  return false;
}
export const tileAt = (w: World, x: number, y: number) =>
  x < 0 || y < 0 || x >= W || y >= H ? Tile.Water : w.tiles[y * W + x];
export const walkable = (w: World, x: number, y: number) => {
  const t = tileAt(w, x, y);
  return t === Tile.Grass || t === Tile.Forest || t === Tile.Rock || (t === Tile.Water && iceAt(w, x, y));
};
// ponytail: linear scan of the ice list; index it if winters ever freeze more than a few hundred tiles.
export const iceAt = (w: World, x: number, y: number) => w.ice.length > 0 && w.ice.includes(y * W + x);
export const ageOf = (w: World, a: { born: number }) => (w.t - a.born) / YEAR;
export const stageOf = (w: World, a: { born: number }) => { const y = ageOf(w, a); return y < 1 ? "child" : y < 5 ? "adult" : "elder"; };
export const dist = (a: { x: number; y: number }, b: { x: number; y: number }) =>
  Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));

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

export function newWorld(seed: number, agentCount = 5): World {
  const rand = rng(seed);
  const hills = noise(rand, 12), woods = noise(rand, 7), wet = noise(rand, 16);
  const tiles: Tile[] = [];
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const edge = Math.min(x, y, W - 1 - x, H - 1 - y) / 8;
      const water = wet(x, y) - Math.min(edge, 1) * 0.35;
      tiles.push(water > 0.62 ? Tile.Water : hills(x, y) > 0.72 ? Tile.Rock : woods(x, y) > 0.55 ? Tile.Forest : Tile.Grass);
    }
  const w: World = {
    version: VERSION, seed, t: Math.round(DAY * 0.3), tiles, paths: new Array(W * H).fill(0), things: [], agents: [], animals: [], events: [],
    nextId: 1, jev: { calls: 0, tokens: 0, rulings: 0 }, kinds: baseRegistry(), laws: {}, rulings: {}, ice: [], people: {},
    weather: { season: "spring", dayOfYear: 0, year: 1, sky: "clear", temp: 14, wind: { dx: 0.3, dy: 0.1 }, drought: false, dryTicks: 0 },
    camps: [], incidents: [],
  };
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const t = tiles[y * W + x], r = rand();
      if (t === Tile.Forest) {
        if (r < 0.3) addThing(w, "tree", x, y, { hp: 100, maxHp: 100 });
        else if (r < 0.34) addThing(w, "stick", x, y);
        else if (r < 0.37) addThing(w, "mushroom", x, y);
        else if (r < 0.39) addThing(w, "herb", x, y);
      } else if (t === Tile.Grass && nearWater(w, x, y, 1) && r < 0.12) {
        addThing(w, r < 0.05 ? "clay" : "reeds", x, y, r < 0.05 ? {} : { hp: 6, maxHp: 6 });
      } else if (t === Tile.Grass) {
        if (r < 0.025) addThing(w, "bush", x, y, { n: 3, hp: 20, maxHp: 20 });
        else if (r < 0.03 && nearWater(w, x, y, 3)) addThing(w, "reeds", x, y, { hp: 6, maxHp: 6 });
        else if (r < 0.03) addThing(w, "stick", x, y);
        else if (r < 0.034) addThing(w, "stone", x, y);
      } else if (t === Tile.Rock) {
        // Flint forms as nodules inside the rock; ore shows as reddish stones, and sometimes inside boulders too.
        const q = (r - 0.12) / 0.04;
        if (r < 0.12) addThing(w, "stone", x, y);
        else if (r < 0.16) addThing(w, "boulder", x, y, { hp: 120, maxHp: 120, ...(q < 0.45 ? { inside: { flint: q < 0.15 ? 2 : 1 } } : q > 0.85 ? { inside: { ore: 1 } } : {}) });
        else if (r < 0.172) addThing(w, "item", x, y, { item: "ore", n: 1, born: 0 });
      }
    }
  const traitNames = Object.keys(TRAITS);
  for (let i = 0; i < agentCount; i++) {
    let x = 0, y = 0;
    do {
      x = 12 + Math.floor(rand() * (W - 24));
      y = 12 + Math.floor(rand() * (H - 24));
    } while (tileAt(w, x, y) !== Tile.Grass || w.agents.some((a) => dist(a, { x, y }) < 10));
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
      id: name.toLowerCase(), name, color: COLORS[i % COLORS.length], x, y,
      bio: `${name} is ${top.slice(0, -1).join(", ")} and ${top.at(-1)}. ${name} wants to ${desires[0]} and to ${desires[1]}.`,
      traits, desires,
      needs: { food: 55 + rand() * 30, energy: 60 + rand() * 30, warmth: 70 + rand() * 20, health: 100, social: 40 + rand() * 40 },
      skills: {}, inv: [], wearing: null, beliefs: {}, facts: {}, tried: {}, watching: {}, sickness: null, home: null,
      born: -Math.round(YEAR * (1.2 + rand() * 0.8)), parents: [], children: [], pregnant: null,
      rel: {}, memory: [], goal: null, plan: [], status: "Waking up in the wilderness", lastDecision: null,
      thinking: false, engaged: null, down: 0, nextDecide: 0, cooldowns: {}, seen: {}, near: {}, customs: {},
    });
  }
  const openGrass = () => {
    for (let i = 0; i < 500; i++) {
      const x = Math.floor(rand() * W), y = Math.floor(rand() * H);
      if (tileAt(w, x, y) === Tile.Grass && w.agents.every((a) => dist(a, { x, y }) > 8)) return { x, y };
    }
    return { x: W / 2, y: H / 2 };
  };
  for (let herd = 0; herd < 2; herd++) {
    const c = openGrass();
    for (let i = 0; i < 4; i++) addAnimal(w, "deer", c.x + (i % 2), c.y + (i >> 1));
  }
  const den = openGrass();
  for (let i = 0; i < 3; i++) addAnimal(w, "wolf", den.x + i, den.y);
  for (const a of w.agents) {
    w.people[a.id] = { id: a.id, name: a.name, color: a.color, alive: true };
    log(w, "wake", [a.id], a, `${a.name} woke up alone in the wilderness.`);
  }
  return w;
}

export function addThing(w: World, kind: ThingKind, x: number, y: number, extra: Partial<Thing> = {}): Thing {
  const t = { id: `t${w.nextId++}`, kind, x, y, ...extra };
  w.things.push(t);
  return t;
}
export function addAnimal(w: World, species: "deer" | "wolf", x: number, y: number): Animal {
  const hp = species === "deer" ? 30 : 35;
  const a: Animal = { id: `a${w.nextId++}`, species, x, y, hp, maxHp: hp, hunger: 80, state: "wander", born: w.t, dx: 0, dy: 0 };
  w.animals.push(a);
  return a;
}

export const dayOfYear = (t: number) => Math.floor(t / DAY) % YEAR_DAYS;
export const seasonOf = (t: number): Weather["season"] => (["spring", "summer", "autumn", "winter"] as const)[Math.floor(dayOfYear(t) / 10)];

// Routine events stay in the chronicle but not in an agent's memory, so Jev and stories see what mattered.
const QUIET: Record<string, true> = { goal: true, gather: true, eat: true, stuck: true, tinker: true, craft: true, spoil: true, grow: true, birth: true, weather: true, fire_spread: true, fire_out: true, level: true };

export function log(w: World, kind: string, who: string[], at: { x: number; y: number }, text: string): Event {
  const e = { id: w.nextId++, t: w.t, kind, who, x: at.x, y: at.y, text };
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
