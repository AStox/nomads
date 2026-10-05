// Learning probes: small staged worlds where we set what's true, so the best anyone could do is known exactly, run to
// see whether people come to it and how fast. A few people stand on open ground in summer for a few days, wanting a fire
// and holding what it takes; each fire is cleared away as soon as it catches, so they keep making them; the probe sets
// the weather by the hour; and they weigh only lighting a fire, resting in the dark, and putting a theory of theirs to
// the test. Each probe runs in the world as it is and in a flipped one, where the rule is otherwise (the wind kills
// sparks instead of the rain): a learner with the answer written in passes one and fails the other. The planting probe
// (seed) does the same with seed in place of fire: each person on a plot of their own with a tree's shade over part of
// it and a bush crowding another, a berry coming to hand every few hours (or once a day, sparse), and the probe deciding
// as each seed goes in whether it comes up two days later.
//   bun scripts/probes.ts --probe blame --variant flipped --seed 3 [--days 6] [--people 6] [--brain jev] [--out run.json]
// scripts/evals.ts runs every probe over many seeds and holds each build to the last good one.
import { DAY, TILE_M, addThing, dryAt, newWorld, type Agent, type Thing, type World } from "../src/sim/world";
import { conditionsNow, tick } from "../src/sim/sim";
import { changed, count, counts, giveItems, groundWord, newKinds, occupied, removeThing, removed, soilAt } from "../src/sim/physics";
import { trailChanges } from "../src/sim/ecology";
import { traceListeners } from "../src/sim/trace";
import { asking, brainKind, useBrain } from "../src/sim/brain";
import { DARK, lightOn, skyShare } from "../src/sim/light";
import { anyAround, around, put, thingById } from "../src/sim/space";
import { fieldsOf, groundKey, ofPlace, type Belief } from "../src/sim/beliefs";
import { RULES, hooks, type Quench } from "../src/sim/rules";
import { seedRandom } from "./seeded";
import { tryAct } from "./trial";

export type Metric = { better: "higher" | "lower"; tol: number; text: string };
// What a probe expects of learning, held over every seed with a 95% interval (scripts/evals.ts): a number's mean above
// or below a value, or one number's mean above another's by more than a value.
export type Claim = { id: string; text: string } & ({ above: string; value: number } | { below: string; value: number } | { gap: [string, string]; value: number });
export type ProbeRun = {
  probe: string; variant: string; seed: number; brain: string; days: number; people: number; secs: number;
  attempts: number; jev: { calls: number; tokens: number }; truth: Record<string, string | number>; metrics: Record<string, number | null>;
};

const STONE = "strike|fiber+stone|stone|stone|-|-", FLINT = "strike|fiber+flint|stone|flint|-|-", PLANT = "plant|berry|-|-|-|-";
// Each hour, the chance of rain and of a strong wind, given whether it is dark where they are.
type Sky = (dark: boolean) => { rain: number; wind: number };
// quench: what truly keeps sparks from catching, any of them (none, for bad luck alone); then: what does from halfway on;
// leak: how often a spark catches anyway where it's quenched (rules.ts RULES.leak); bystander: what comes with the cause
// and doesn't matter; starts: by person, the causes they start out blaming, or null for someone who doesn't know how at
// all; talk: they may also teach and talk
type Setup = {
  quench: Quench[]; then?: Quench[]; leak?: number; bystander?: Quench; tell: boolean; sparks: "harder" | "softer"; ways: string[]; sky: Sky;
  starts?: (Quench[] | null)[]; talk?: boolean;
};
// The planting probe's: withers: the kind of spot (sim.ts CONDITIONS: shade, crowded) a seedling put in never comes up
// in; comes: how often one comes up anywhere else; every: how often a berry comes to hand for a planter who has none
type Sow = { withers: string; comes: number; sky: Sky; every: number };
// days: how long it runs, whatever the run asks (scripts/evals.ts asks the same of every probe), for a probe whose
// outcomes take days to show
type Probe = { text: string; metrics: Record<string, Metric>; claims: Claim[]; variants: Record<string, Setup | Sow>; days?: number };

const fair: Sky = () => ({ rain: 0, wind: 0 });
const changeable: Sky = () => ({ rain: 0.35, wind: 0.35 });
const nightRain: Sky = (dark) => ({ rain: dark ? 0.7 : 0.05, wind: 0 });
const rareWind: Sky = () => ({ rain: 0.35, wind: 0.08 });
const rareRain: Sky = () => ({ rain: 0.08, wind: 0.35 });

const CAUSE = {
  right: { better: "higher", tol: 0.1, text: "share of people who end up blaming what truly kills the sparks" },
  wrong: { better: "lower", tol: 0.1, text: "share of people who end up blaming something that doesn't" },
  wasted: { better: "lower", tol: 0.05, text: "share of their last third of tries (tests aside) made where it can't work" },
  wastedEarly: { better: "lower", tol: 0.05, text: "share of their first third of tries (tests aside) made where it can't work" },
  formed: { better: "lower", tol: 0.5, text: "days until each first blames the true cause (the whole run if never)" },
} satisfies Record<string, Metric>;

export const PROBES: Record<string, Probe> = {
  choose: {
    text: "Two ways to a fire that look alike at first, one truly faster: do they settle on it?",
    metrics: {
      best: { better: "higher", tol: 0.1, text: "share of their last third of tries made the faster way" },
      first: { better: "higher", tol: 0.1, text: "share of each person's first five tries made the faster way" },
      regret: { better: "lower", tol: 1, text: "ticks lost per try to choosing the slower way, against the faster" },
    },
    claims: [
      { id: "learn", text: "they use the faster way more once they've learned than in their first tries", gap: ["best", "first"], value: 0 },
      { id: "settle", text: "nearly all their late tries use the faster way (more than 85%)", above: "best", value: 0.85 },
    ],
    variants: {
      // flint throws three times the sparks
      real: { quench: ["rain"], tell: true, sparks: "harder", ways: [STONE, FLINT], sky: fair },
      // plain stone does
      flipped: { quench: ["rain"], tell: true, sparks: "softer", ways: [STONE, FLINT], sky: fair },
    },
  },
  blame: {
    text: "Sparks die in one kind of weather and not the others: do they come to blame it, and only it?",
    metrics: CAUSE,
    claims: [
      { id: "most", text: "most come to blame the true cause", above: "right", value: 0.5 },
      { id: "only", text: "more blame the true cause than anything else", gap: ["right", "wrong"], value: 0 },
      { id: "less-waste", text: "fewer of their tries go to waste late than early", gap: ["wastedEarly", "wasted"], value: 0 },
    ],
    variants: {
      real: { quench: ["rain"], tell: true, sparks: "harder", ways: [STONE], sky: changeable },
      flipped: { quench: ["wind"], tell: true, sparks: "harder", ways: [STONE], sky: changeable },
    },
  },
  confounded: {
    text: "The rain falls mostly at night and only one of the two kills sparks, which nothing they see says: do they tell which?",
    metrics: { ...CAUSE, bystander: { better: "lower", tol: 0.1, text: "share of people who end up blaming the other of the two" } },
    claims: [
      { id: "cause", text: "more blame the true cause than the one that comes with it", gap: ["right", "bystander"], value: 0 },
      { id: "most", text: "nearly everyone comes to blame the true cause (more than 85%)", above: "right", value: 0.85 },
      { id: "few-bystanders", text: "fewer than one in four also blame the one that only comes with it", below: "bystander", value: 0.25 },
    ],
    variants: {
      real: { quench: ["rain"], bystander: "dark", tell: false, sparks: "harder", ways: [STONE], sky: nightRain },
      flipped: { quench: ["dark"], bystander: "rain", tell: false, sparks: "harder", ways: [STONE], sky: nightRain },
    },
  },
  recover: {
    text: "What kills sparks changes halfway: do they let go of the old cause and find the new one?",
    metrics: {
      right: { better: "higher", tol: 0.1, text: "share of people who end up blaming the new cause" },
      kept: { better: "lower", tol: 0.1, text: "share of people who end up still blaming the old one" },
      wasted: { better: "lower", tol: 0.05, text: "share of their last third of tries (tests aside) made where it can't work" },
      dropped: { better: "lower", tol: 0.5, text: "days from the change until those who blamed the old cause let it go" },
      found: { better: "lower", tol: 0.5, text: "days from the change until each blames the new cause" },
    },
    claims: [
      { id: "let-go", text: "fewer than three in ten still blame the old cause at the end", below: "kept", value: 0.3 },
      { id: "find", text: "at least two in three come to blame the new cause", above: "right", value: 0.65 },
    ],
    variants: {
      real: { quench: ["rain"], then: ["wind"], tell: true, sparks: "harder", ways: [STONE], sky: changeable },
      flipped: { quench: ["wind"], then: ["rain"], tell: true, sparks: "harder", ways: [STONE], sky: changeable },
    },
  },
  spread: {
    text: "Some know the true cause, some were told a false one, some don't know how to make a fire at all: which belief spreads?",
    metrics: {
      right: CAUSE.right,
      wrong: { better: "lower", tol: 0.1, text: "share of people who end up blaming the false cause some started with" },
      wasted: CAUSE.wasted,
      learned: { better: "higher", tol: 0.15, text: "share of those who didn't know how who learned to make a fire" },
    },
    claims: [
      { id: "truth-wins", text: "more end up blaming the true cause than the false one", gap: ["right", "wrong"], value: 0 },
      { id: "error-fades", text: "fewer than half end up with the false one", below: "wrong", value: 0.5 },
    ],
    variants: {
      real: { quench: ["rain"], tell: true, sparks: "harder", ways: [STONE], sky: changeable, starts: [["rain"], ["rain"], ["dark"], ["dark"], null, null], talk: true },
      flipped: { quench: ["dark"], tell: true, sparks: "harder", ways: [STONE], sky: changeable, starts: [["dark"], ["dark"], ["rain"], ["rain"], null, null], talk: true },
    },
  },
  // The second round: what the first five don't reach.
  superstition: {
    text: "Nothing in the weather matters, but sparks die now and then by bad luck: do they come to blame something anyway?",
    metrics: { wrong: { better: "lower", tol: 0.1, text: "share of people who end up blaming anything at all" } },
    claims: [{ id: "few", text: "fewer than one in four come to blame anything", below: "wrong", value: 0.25 }],
    variants: {
      // plain stone: about one try in four dies for want of a spark
      real: { quench: [], tell: false, sparks: "harder", ways: [STONE], sky: changeable },
      // the rain falls mostly at night, so the rain and the dark go together in what they see
      flipped: { quench: [], tell: false, sparks: "harder", ways: [STONE], sky: nightRain },
    },
  },
  two: {
    text: "Two kinds of weather each kill sparks: do they come to blame both, or stop at the first?",
    metrics: { ...CAUSE, partly: { better: "lower", tol: 0.1, text: "share of people who end up blaming one of the two and not the other" } },
    claims: [
      { id: "both", text: "most come to blame both", above: "right", value: 0.5 },
      { id: "only", text: "more blame both than anything else", gap: ["right", "wrong"], value: 0 },
    ],
    variants: {
      real: { quench: ["rain", "wind"], tell: true, sparks: "harder", ways: [STONE], sky: changeable },
      flipped: { quench: ["wind", "dark"], tell: true, sparks: "harder", ways: [STONE], sky: changeable },
    },
  },
  weak: {
    text: "A kind of weather only halves the sparks that catch, and nothing they see says so: do they still come to blame it?",
    metrics: CAUSE,
    claims: [
      { id: "most", text: "most come to blame it", above: "right", value: 0.5 },
      { id: "only", text: "more blame it than anything else", gap: ["right", "wrong"], value: 0 },
    ],
    variants: {
      real: { quench: ["rain"], leak: 0.5, tell: false, sparks: "harder", ways: [STONE], sky: changeable },
      flipped: { quench: ["wind"], leak: 0.5, tell: false, sparks: "harder", ways: [STONE], sky: changeable },
    },
  },
  rare: {
    text: "What kills sparks comes only one hour in twelve, and nothing they see says so: do they come to blame it?",
    metrics: CAUSE,
    claims: [
      { id: "most", text: "most come to blame it", above: "right", value: 0.5 },
      { id: "only", text: "more blame it than anything else", gap: ["right", "wrong"], value: 0 },
    ],
    variants: {
      real: { quench: ["wind"], tell: false, sparks: "harder", ways: [STONE], sky: rareWind },
      flipped: { quench: ["rain"], tell: false, sparks: "harder", ways: [STONE], sky: rareRain },
    },
  },
  // The third round: what's done to the ground, where most of what an island can teach lies. Tries are few, what comes
  // of one shows days later, and a seedling that withers says nothing of why.
  seed: {
    text: "Seedlings never come up in one kind of spot, and it shows only days later: do they come to blame the spot, and not the weather?",
    // a seedling shows two days after it goes in (SPROUT): in the five days the fire probes run, each planter would see
    // what came of their first three days of planting and no more
    days: 10,
    metrics: {
      ...CAUSE,
      right: { ...CAUSE.right, text: "share of people who end up blaming the kind of spot seedlings truly never come up in" },
      wasted: { ...CAUSE.wasted, text: "share of their last third of plantings (tests aside) made where nothing comes up" },
      wastedEarly: { ...CAUSE.wastedEarly, text: "share of their first third of plantings (tests aside) made where nothing comes up" },
      weather: { better: "lower", tol: 0.1, text: "share of people who end up blaming any weather for their plantings" },
    },
    claims: [
      { id: "most", text: "most come to blame the true cause", above: "right", value: 0.5 },
      { id: "only", text: "more blame the true cause than anything else", gap: ["right", "wrong"], value: 0 },
      { id: "less-waste", text: "fewer of their plantings go where nothing comes up late than early", gap: ["wastedEarly", "wasted"], value: 0 },
      { id: "not-weather", text: "fewer than one in four blame the weather", below: "weather", value: 0.25 },
    ],
    variants: {
      // in the shade of trees, as in the world; elsewhere seven in ten come up; a berry to plant every four hours, so
      // a few plantings a day (with berries in hand all the time, they plant thirty a day)
      real: { withers: "shade", comes: 0.7, sky: changeable, every: DAY / 6 },
      // crowded in among bushes, and the shade does no harm
      flipped: { withers: "crowded", comes: 0.7, sky: changeable, every: DAY / 6 },
      // as real, with a berry a day: ten plantings each, nearer what a planter in a whole world goes on (one to a dozen
      // seen to come up or not in sixty days), where a record that fades with every try and one lucky seedling count most
      sparse: { withers: "shade", comes: 0.7, sky: changeable, every: DAY },
      // as sparse, where only four in ten come up elsewhere: a failure in the shade stands out less from the rest, as on
      // the islands where whole worlds learned least
      poor: { withers: "shade", comes: 0.4, sky: changeable, every: DAY },
    },
  },
};

// Summer, a little after sunrise: no frost at night to muddy what they see.
const START = 12 * DAY + 6 * 12;
type Attempt = { agent: string; key: string; t: number; now: string[]; worked: boolean; testing: boolean };
type Change = { agent: string; key: string; cond: string; t: number };

// A way they know that has worked for them, as if they'd done it once: lit a fire, or pushed a berry into the ground and
// seen it come up, SPROUT later.
const knownWay = (key: string, t: number): Belief => {
  const f = fieldsOf(key), plant = f.verb === "plant";
  return {
    key, fields: { ...f, builds: plant ? "bush" : "fire" }, uses: { [f.inputs[0]]: 1 }, out: {}, ticks: 3, ...(plant ? { later: SPROUT } : {}),
    tries: 1, wins: 1, tally: { tries: 1, wins: 1 }, how: "discovered", t,
  };
};

// Open ground near where they came ashore: dry, the sky clear overhead, nothing standing within a few meters.
function openGround(w: World, px: number, py: number): [number, number] {
  for (let r = 0; r < 300; r += 7) for (let k = 0; k < 16; k++) {
    const x = px + (Math.cos((k / 16) * Math.PI * 2) * r) / TILE_M, y = py + (Math.sin((k / 16) * Math.PI * 2) * r) / TILE_M;
    if (dryAt(w, x, y) && skyShare(w, x, y) > 0.95 && !anyAround(w, x, y, 6, ["tree", "bush", "dead_bush", "boulder", "structure"])) return [x, y];
  }
  return [px, py];
}

// How long after it goes into the ground a seedling of the planting probe comes up or withers.
const SPROUT = 2 * DAY;
// A planter's plot (plots), in meters from where they stand: an oak this tall this far to the west, its crown over the
// spots on that side of them (and not over them) but its trunk more than a pace and a half from any; a berry bush this
// far to the east, crowding the spots on that side; the next plot this far to the south; and everything else cleared
// off this far round.
const OAK = { size: 14, west: 5 }, BUSH_EAST = 1.8, PLOT_APART = 14, PLOT_CLEAR = 12;
type Pos = { px: number; py: number };
const off = (at: Pos, dx: number, dy: number): Pos => ({ px: at.px + dx / TILE_M, py: at.py + dy / TILE_M });
// The spots a pace to three off where someone standing at a point facing east would put a seed, in the order they'd try
// them (physics.ts spotNear).
const ring = (at: Pos) => [1, 2, 3].flatMap((m) => [0, 1, 2, 3, 4, 5, 6, 7].map((k) => off(at, Math.cos((k * Math.PI) / 4) * m, Math.sin((k * Math.PI) / 4) * m)));
// The kinds of ground someone standing at any of these points knows of to plant on, looking round as far as they would
// (sim.ts groundsNear: rings out to a hundred meters).
function groundsSeen(w: World, ps: Pos[]) {
  const seen = new Set<string>();
  for (const p of ps) for (const r of [0, 5, 10, 20, 35, 55, 80, 100]) for (let k = 0; k < (r ? 12 : 1); k++) {
    const s = off(p, Math.cos((k / 12) * Math.PI * 2) * r, Math.sin((k / 12) * Math.PI * 2) * r);
    if (dryAt(w, s.px, s.py)) seen.add(groundWord(w, s.px, s.py));
  }
  return seen;
}
// A plot for each of n planters, in a column running south from the first spot near (at) where every plot is dry and
// has soil enough for a seed everywhere a seed or the oak or the bush could go, and no other kind of ground is in sight
// to go and try (or failing that, the first that is all one ground, or at itself): cleared, with its oak and its bush.
// With nowhere else to go, they plant on their plots and nowhere else.
function plots(w: World, at: Pos, n: number): Pos[] {
  let ps: Pos[] | undefined, fallback: Pos[] | undefined;
  for (let r = 0; r < 1000 && !ps; r += 10) for (let k = 0; k < 16 && !ps; k++) {
    const c = off(at, Math.cos((k / 16) * Math.PI * 2) * r, Math.sin((k / 16) * Math.PI * 2) * r);
    const col = Array.from({ length: n }, (_, i) => off(c, 0, i * PLOT_APART)), g = groundWord(w, c.px, c.py);
    if (!col.flatMap((p) => [p, off(p, -OAK.west, 0), off(p, BUSH_EAST, 0), ...ring(p)]).every((s) => dryAt(w, s.px, s.py) && soilAt(w, s.px, s.py) >= 0.03 && groundWord(w, s.px, s.py) === g)) continue;
    fallback ??= col;
    if (groundsSeen(w, col).size === 1) ps = col;
  }
  ps ??= fallback ?? Array.from({ length: n }, (_, i) => off(at, 0, i * PLOT_APART));
  for (const p of ps) {
    const here: Thing[] = [];
    around(w, p.px, p.py, PLOT_CLEAR, null, (t) => void here.push(t));
    for (const t of here) removeThing(w, t);
    const tree = off(p, -OAK.west, 0), bush = off(p, BUSH_EAST, 0);
    addThing(w, "tree", tree.px, tree.py, { species: "oak", size: OAK.size, hp: 53, maxHp: 53 });
    addThing(w, "bush", bush.px, bush.py, { species: "berry", size: 1, n: 0, hp: 20, maxHp: 20 });
  }
  return ps;
}

// Which of the ways is truly faster to a fire, by trying each many times in fair weather: the ticks a fire takes, trying
// until one catches.
async function fastest(w: World, ways: string[]) {
  const a = w.agents[0], held = structuredClone(a.inv), sky = w.weather.sky, speed = w.weather.speed;
  w.weather.sky = "clear"; w.weather.speed = 2;
  const ticks: Record<string, number> = {};
  for (const key of ways) {
    const b = knownWay(key, w.t), f = b.fields;
    let n = 0, wins = 0, took = 0;
    for (let i = 0; i < 400; i++) {
      a.inv = [];
      giveItems(w, a, "fiber"); giveItems(w, a, f.tool!); giveItems(w, a, f.target!);
      const r = await tryAct(w, a, b);
      if (typeof r === "string") continue;
      n++; took += r.took; if (r.worked) wins++;
    }
    ticks[key] = n && wins ? took / wins : Infinity;
  }
  a.inv = held; w.weather.sky = sky; w.weather.speed = speed;
  const fires: Thing[] = [];
  around(w, a.px, a.py, 30, ["fire"], (t) => { fires.push(t); });
  for (const t of fires) removeThing(w, t);
  return ticks;
}

export async function runProbe(probe: string, variant: string, seed: number, days: number, people: number, brain: "random" | "jev"): Promise<ProbeRun> {
  const P = PROBES[probe], v = P?.variants[variant];
  if (!v) throw new Error(`no probe ${probe}/${variant}: ${Object.entries(PROBES).map(([p, x]) => Object.keys(x.variants).map((k) => `${p}/${k}`).join(", ")).join(", ")}`);
  days = P.days ?? days;
  if (brain === "random") useBrain({ kind: "random" });
  seedRandom(seed);
  const t0 = performance.now();
  const w = newWorld(seed, people);
  w.t = Math.max(w.t, START);
  w.animals = w.animals.filter((m) => m.species !== "wolf");
  const sowing = "withers" in v, ways = sowing ? [PLANT] : v.ways;
  if (sowing) RULES.learning = "seen";
  else Object.assign(RULES, { quench: v.quench, leak: v.leak ?? 0, tell: v.tell, sparks: v.sparks, learning: "seen" });
  const [cx, cy] = openGround(w, w.agents[0].px, w.agents[0].py);
  const fresh: string[] = [];
  const truth: Record<string, string | number> = {};
  if (sowing) {
    // each on a plot of their own, facing east to start, nothing in hand, knowing that a berry pushed into the ground
    // comes up: one did for them, on the ground of their plot
    const ps = plots(w, { px: cx, py: cy }, w.agents.length);
    w.agents.forEach((a, i) => {
      put(w, a, ps[i].px, ps[i].py);
      a.heading = 0; a.home = null; a.goal = null; a.plan = []; a.inv = [];
      a.beliefs = { [PLANT]: { ...knownWay(PLANT, w.t), when: { [groundKey(groundWord(w, a.px, a.py))]: { tries: 1, wins: 1 } } } };
    });
    // of the spots a seed could go into round where they stand, the share where nothing comes up; and the kinds of ground
    // they know of to plant on (one, unless the island has nowhere so)
    const spots = ps.flatMap(ring).filter((s) => !occupied(w, s.px, s.py));
    const lost = spots.filter((s) => conditionsNow(w, w.agents[0], "plant", s).includes(v.withers)).length / spots.length;
    Object.assign(truth, { withers: v.withers, comes: v.comes, spots: Math.round(lost * 100) / 100, grounds: groundsSeen(w, ps).size });
  } else {
    w.agents.forEach((a, i) => {
      put(w, a, cx + (Math.cos(i) * 2) / TILE_M, cy + (Math.sin(i) * 2) / TILE_M);
      a.home = null; a.goal = null; a.plan = [];
      const start = v.starts?.[i];
      a.beliefs = start === null ? {} : Object.fromEntries(v.ways.map((key) => [key, start?.length ? { ...knownWay(key, w.t), unless: [...start] } : knownWay(key, w.t)]));
      if (start === null) fresh.push(a.id);
    });
    Object.assign(truth, { quench: v.quench.join("+") || "none", ...(v.then ? { then: v.then.join("+") } : {}), ...(v.leak ? { leak: v.leak } : {}) });
  }
  const ticks = probe === "choose" ? await fastest(w, ways) : {};
  const best = probe === "choose" ? ways.reduce((x, y) => (ticks[y] < ticks[x] ? y : x)) : "";
  if (best) Object.assign(truth, { best, ...Object.fromEntries(ways.map((k) => [`ticks:${k}`, Math.round(ticks[k] * 10) / 10])) });

  hooks.weather = (w) => {
    if (w.t % 12) return;
    const s = v.sky(lightOn(w, w.agents[0]).bright < DARK);
    w.weather.sky = Math.random() < s.rain ? "rain" : "clear";
    w.weather.speed = Math.random() < s.wind ? 18 : 2;
  };
  // they weigh only doing it (lighting a fire, or planting a berry in hand: one fetched from a bush would have them
  // planting more often than the probe hands them out, and far from where it put them), resting, and putting a theory
  // to the test
  const aim = sowing ? "plant" : "make_fire", talk = !sowing && !!v.talk;
  hooks.options = (_w, a, opts) => {
    const held = !sowing || count(a, "berry") > 0;
    for (const k of Object.keys(opts)) if (!(k === "rest" || (held && (k === aim || k.startsWith("test:"))) || (talk && (k === "teach" || k === "talk")))) delete opts[k];
  };
  // Each seedling, as it goes in, fated by what its planter saw of the spot (their waiting list, sim.ts finishAct) to
  // come up or wither SPROUT later; one that comes up is cleared away the tick after, as a fire is, so the spot is free
  // again and crowds no other.
  const fates = new Map<string, { up: boolean; t: number }>(), grown: string[] = [];
  if (sowing) hooks.seedling = (w, t) => {
    const f = fates.get(t.id);
    if (!f) return undefined;
    if (w.t - f.t < SPROUT) return "wait";
    if (f.up) grown.push(t.id);
    return f.up ? "up" : "withered";
  };

  // what they did (a try at a fire, judged at once; a planting, when it went in, whatever came of it) and the theories
  // they came to and gave up
  const attempts: Attempt[] = [], formed: Change[] = [], dropped: Change[] = [];
  traceListeners.push((e) => {
    if (e.sys !== "theory" || !e.agent) return;
    const d = e.data as { key: string; now?: string[]; worked?: boolean; testing?: boolean; cond?: string; conds?: string[] };
    if (!ways.includes(d.key)) return;
    if (e.kind === "attempt") { if (!sowing) attempts.push({ agent: e.agent, key: d.key, t: e.t, now: d.now ?? [], worked: !!d.worked, testing: !!d.testing }); }
    else if (e.kind === "formed" && d.cond) formed.push({ agent: e.agent, key: d.key, cond: d.cond, t: e.t });
    else if (e.kind === "dropped") for (const c of d.conds ?? []) dropped.push({ agent: e.agent, key: d.key, cond: c, t: e.t });
  });
  const holds = (a: Agent, c: string) => ways.some((k) => a.beliefs[k]?.unless?.includes(c));
  // who blames each of these (one, for most probes)
  const blames = (cs: string[]) => w.agents.filter((a) => cs.every((c) => holds(a, c))).map((a) => a.id);
  const begin = w.t, end = begin + days * DAY, half = begin + Math.floor((days * DAY) / 2);
  let heldOld: string[] = [];
  while (w.t < end) {
    if (!sowing && v.then && w.t === half) { heldOld = blames(v.quench); RULES.quench = v.then; }
    // they keep wanting a fire and keep what it takes in hand, or to plant and get a berry to plant as often as the
    // probe says, the first as it starts, turning to face a new way with each (the first spot they'd try is the one in
    // front of them: physics.ts spotNear), so their seed goes in all round them however seldom they plant; whatever
    // fire they light is gone by the next tick
    for (const a of w.agents) {
      Object.assign(a.needs, { food: Math.max(a.needs.food, 80), energy: Math.max(a.needs.energy, 90), health: Math.max(a.needs.health, 90), warmth: 50 });
      const c = counts(a);
      if (sowing) {
        if (!c.berry && (w.t - begin) % v.every === 0) { giveItems(w, a, "berry"); a.heading = Math.random() * Math.PI * 2; }
        continue;
      }
      if ((c.stone ?? 0) < 3) giveItems(w, a, "stone", 3 - (c.stone ?? 0));
      // two flints, so one chipped away mid-try doesn't leave them only the other way to choose for the next
      if (ways.includes(FLINT) && (c.flint ?? 0) < 2) giveItems(w, a, "flint", 2 - (c.flint ?? 0));
      if ((c.fiber ?? 0) < 2) giveItems(w, a, "fiber", 2 - (c.fiber ?? 0));
    }
    const fires: Thing[] = [];
    if (!sowing) around(w, cx, cy, 200, ["fire"], (t) => { fires.push(t); });
    for (const t of fires) removeThing(w, t);
    // who is out to test a theory as the tick starts: a planting that tick is a test
    const testing = sowing ? w.agents.filter((a) => a.goal?.type.startsWith("test:")).map((a) => a.id) : [];
    tick(w);
    if (sowing) {
      for (const a of w.agents) for (const e of a.waiting ?? []) {
        if (fates.has(e.thing) || !ways.includes(e.key)) continue;
        const up = !e.now.includes(v.withers) && Math.random() < v.comes;
        fates.set(e.thing, { up, t: e.t });
        attempts.push({ agent: a.id, key: e.key, t: e.t, now: e.now, worked: up, testing: testing.includes(a.id) });
      }
      for (const id of grown.splice(0)) { const t = thingById(w, id); if (t) removeThing(w, t); }
    }
    changed.clear(); removed.clear(); newKinds.clear(); trailChanges.clear();
    if (w.t % 4 === 0) await Bun.sleep(0);
    if (brainKind() !== "random") for (;;) { await Bun.sleep(asking() ? 10 : 0); if (!asking()) { await Bun.sleep(0); if (!asking()) break; } }
  }

  // what they did, by thirds of the run, tests aside
  const tries = attempts.filter((x) => !x.testing);
  const third = (k: 0 | 2) => tries.filter((x) => (k === 0 ? x.t < begin + (end - begin) / 3 : x.t >= begin + ((end - begin) * 2) / 3));
  const share = (xs: Attempt[], ok: (x: Attempt) => boolean) => (xs.length ? xs.filter(ok).length / xs.length : null);
  const n = w.agents.length, day = (t: number) => (t - begin) / DAY;
  // days from `from` until each person (or each of `who`) first did it for every one of these, the rest of the run if
  // they never did
  const until = (xs: Change[], conds: string[], from: number, who = w.agents.map((a) => a.id)) =>
    who.length ? who.reduce((s, id) => s + day(Math.max(...conds.map((cond) => xs.find((x) => x.agent === id && x.cond === cond && x.t >= from)?.t ?? end))) - day(from), 0) / who.length : null;
  const metrics: Record<string, number | null> = {};
  if (probe === "choose") {
    const worse = Math.max(...ways.map((k) => ticks[k])), lost = (x: Attempt) => Math.min(ticks[x.key], worse) - ticks[best];
    Object.assign(metrics, {
      best: share(third(2), (x) => x.key === best),
      first: share(w.agents.flatMap((a) => tries.filter((x) => x.agent === a.id).slice(0, 5)), (x) => x.key === best),
      regret: tries.length ? tries.reduce((s, x) => s + lost(x), 0) / tries.length : null,
    });
  } else {
    // what truly kills sparks by the end (none at all, for bad luck alone), or what seedlings never come up in
    const causes: string[] = sowing ? [v.withers] : v.then ?? v.quench, quench: string[] = sowing ? causes : v.quench, wasted = (x: Attempt) => x.now.some((c) => causes.includes(c));
    const others = (a: Agent) => ways.some((k) => a.beliefs[k]?.unless?.some((c) => !causes.includes(c) && !quench.includes(c)));
    Object.assign(metrics, {
      right: causes.length ? blames(causes).length / n : null,
      wasted: causes.length ? share(third(2), wasted) : null,
    });
    if (!sowing && probe === "recover") Object.assign(metrics, {
      kept: blames(v.quench).length / n,
      dropped: until(dropped, v.quench, half, heldOld),
      found: until(formed, causes, half),
    });
    else if (!sowing && probe === "spread") {
      const told = v.starts?.flat().find((c) => c && !causes.includes(c)), newcomers = w.agents.filter((a) => fresh.includes(a.id));
      Object.assign(metrics, {
        wrong: told ? blames([told]).length / n : null,
        learned: newcomers.length ? newcomers.filter((a) => ways.some((k) => a.beliefs[k])).length / newcomers.length : null,
      });
    } else Object.assign(metrics, {
      wrong: w.agents.filter(others).length / n,
      wastedEarly: causes.length ? share(third(0), wasted) : null,
      formed: causes.length ? until(formed, causes, begin) : null,
      ...(sowing
        ? { weather: w.agents.filter((a) => ways.some((k) => a.beliefs[k]?.unless?.some((c) => !ofPlace(c)))).length / n }
        : v.bystander ? { bystander: blames([v.bystander]).length / n } : {}),
      ...(causes.length > 1 ? { partly: w.agents.filter((a) => causes.some((c) => holds(a, c)) && !causes.every((c) => holds(a, c))).length / n } : {}),
    });
  }
  hooks.weather = hooks.options = hooks.seedling = undefined;
  return { probe, variant, seed, brain, days, people: n, secs: Math.round((performance.now() - t0) / 1000), attempts: attempts.length, jev: { calls: w.jev.calls, tokens: w.jev.tokens }, truth, metrics };
}

if (import.meta.main) {
  const arg = (name: string, d: string) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : d; };
  const brain = arg("brain", "random");
  if (brain !== "random" && brain !== "jev") throw new Error(`--brain ${brain}: random or jev`);
  const r = await runProbe(arg("probe", "blame"), arg("variant", "real"), Number(arg("seed", "1")), Number(arg("days", "6")), Number(arg("people", "6")), brain);
  const out = arg("out", "");
  if (out) await Bun.write(out, JSON.stringify(r) + "\n");
  else console.log(JSON.stringify(r));
  process.exit(0);
}
