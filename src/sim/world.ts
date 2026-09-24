import { TRAITS } from "./traits";

export const W = 64;
export const H = 64;
export const DAY = 288; // ticks per in-game day, 5 minutes each

export enum Tile {
  Grass = 0,
  Forest = 1,
  Water = 2,
  Rock = 3,
}

export type Item =
  | "berry" | "mushroom" | "fish" | "meal" | "stew"
  | "stick" | "stone" | "fiber" | "clay"
  | "sharp_stone" | "cord" | "axe" | "log" | "plank" | "wedge" | "bow_drill" | "fishing_line" | "pot" | "brick";
export const FOOD: Partial<Record<Item, number>> = { berry: 20, mushroom: 18, fish: 14, meal: 45, stew: 70 };
export type Inv = Partial<Record<Item, number>>;

export type ThingKind =
  | "tree" | "stump" | "bush" | "mushroom" | "stick" | "stone" | "reeds" | "clay"
  | "fire" | "hearth" | "lean_to" | "log_hut" | "cabin";
export type Thing = { id: string; kind: ThingKind; x: number; y: number; n?: number; owner?: string; until?: number };

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
  none: "Nothing lasting came of this",
} as const;
export type BondKind = keyof typeof BONDS;
// weight kept per day; betrayals and life debts linger
export const BOND_FADE: Partial<Record<BondKind, number>> = { saved_my_life: 0.97, stole_from_me: 0.97, lied_to_me: 0.97, humiliated_me: 0.97, sweetheart: 0.97 };

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
} as const;
export type Label = keyof typeof LABELS;

export const BELIEFS = ["generous", "honest", "friendly", "dangerous", "hardworking"] as const;
export type Belief = (typeof BELIEFS)[number];

export type Relationship = {
  affinity: number; // -1..1
  trust: number; // 0..1
  label: Label;
  bonds: { kind: BondKind; t: number; weight: number }[];
  beliefs: Partial<Record<Belief, number>>;
  ledger: number; // favors they did me minus favors I did them
  history: string[];
  met: number;
};

export type Step = { op: string; arg?: string; progress: number };
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
  skills: Record<string, number>; // craft -> xp; a craft appears once they first use it
  know: Record<string, { how: "discovered" | "watched" | "taught"; t: number; from?: string }>;
  clues: Record<string, number>; // recipe id -> progress toward figuring it out
  tried: Record<string, number>; // tinker combo -> times it led nowhere
  inv: Inv;
  home: { x: number; y: number } | null;
  rel: Record<string, Relationship>;
  memory: string[];
  goal: Goal | null;
  plan: Step[];
  status: string;
  lastDecision: { t: number; goal: Record<string, number>; who?: Record<string, number>; chosen: string; target?: string } | null;
  thinking: boolean;
  engaged: string | null; // id of the agent they're interacting with
  down: number; // tick until they recover from collapse
  nextDecide: number;
  cooldowns: Record<string, number>;
  seen: Record<string, number>;
};

export type Event = { id: number; t: number; kind: string; who: string[]; x: number; y: number; text: string };

export type World = {
  seed: number;
  t: number;
  tiles: Tile[];
  things: Thing[];
  agents: Agent[];
  events: Event[];
  nextId: number;
  jev: { calls: number; tokens: number };
  inventions: Record<string, { by: string; t: number }>;
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
  return t === Tile.Grass || t === Tile.Forest || t === Tile.Rock;
};
export const dist = (a: { x: number; y: number }, b: { x: number; y: number }) =>
  Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));

export const level = (xp: number) => Math.min(10, Math.floor(Math.sqrt(xp / 10)));

const NAMES = ["Aldric", "Mara", "Osric", "Tamsin", "Brenna", "Wulf", "Edda", "Rowan", "Isolde", "Cedric"];
// Heraldic tinctures, muted to sit on parchment.
const COLORS = ["#9e3b2f", "#2f4a6d", "#a8812a", "#4e6b3a", "#6b3f5e", "#8a5a2b", "#3d6b6b", "#7a2f3f"];
const DESIRES = [
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
const clash = (a: string, b: string) => OPPOSITES.some(([x, y]) => (x === a && y === b) || (x === b && y === a));

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
  const w: World = { seed, t: Math.round(DAY * 0.3), tiles, things: [], agents: [], events: [], nextId: 1, jev: { calls: 0, tokens: 0 }, inventions: {} };
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const t = tiles[y * W + x], r = rand();
      if (t === Tile.Forest) {
        if (r < 0.3) addThing(w, "tree", x, y);
        else if (r < 0.34) addThing(w, "stick", x, y);
        else if (r < 0.37) addThing(w, "mushroom", x, y);
      } else if (t === Tile.Grass && nearWater(w, x, y, 1) && r < 0.12) {
        addThing(w, r < 0.05 ? "clay" : "reeds", x, y);
      } else if (t === Tile.Grass) {
        if (r < 0.025) addThing(w, "bush", x, y, { n: 3 });
        else if (r < 0.03 && nearWater(w, x, y, 3)) addThing(w, "reeds", x, y);
        else if (r < 0.03) addThing(w, "stick", x, y);
        else if (r < 0.034) addThing(w, "stone", x, y);
      } else if (t === Tile.Rock && r < 0.12) addThing(w, "stone", x, y);
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
      id: name.toLowerCase(),
      name,
      color: COLORS[i % COLORS.length],
      x,
      y,
      bio: `${name} is ${top.slice(0, -1).join(", ")} and ${top.at(-1)}. ${name} wants to ${desires[0]} and to ${desires[1]}.`,
      traits,
      desires,
      needs: { food: 55 + rand() * 30, energy: 60 + rand() * 30, warmth: 70 + rand() * 20, health: 100, social: 40 + rand() * 40 },
      skills: {},
      know: {},
      clues: {},
      tried: {},
      inv: {},
      home: null,
      rel: {},
      memory: [],
      goal: null,
      plan: [],
      status: "Waking up in the wilderness",
      lastDecision: null,
      thinking: false,
      engaged: null,
      down: 0,
      nextDecide: 0,
      cooldowns: {},
      seen: {},
    });
  }
  for (const a of w.agents) log(w, "wake", [a.id], a, `${a.name} woke up alone in the wilderness.`);
  return w;
}

export function addThing(w: World, kind: ThingKind, x: number, y: number, extra: Partial<Thing> = {}): Thing {
  const t = { id: `t${w.nextId++}`, kind, x, y, ...extra };
  w.things.push(t);
  return t;
}

// Routine events stay in the chronicle but not in an agent's memory, so Jev and stories see what mattered.
const QUIET: Record<string, true> = { goal: true, gather: true, eat: true, stuck: true };

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
