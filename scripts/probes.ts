// Learning probes: small staged worlds where we set what's true, so the best anyone could do is known exactly, run to
// see whether people come to it and how fast. A few people stand on open ground in summer for a few days, wanting a fire
// and holding what it takes; each fire is cleared away as soon as it catches, so they keep making them; the probe sets
// the weather by the hour; and they weigh only lighting a fire, resting in the dark, and putting a theory of theirs to
// the test. Each probe runs in the world as it is and in a flipped one, where the rule is otherwise (the wind kills
// sparks instead of the rain): a learner with the answer written in passes one and fails the other.
//   bun scripts/probes.ts --probe blame --variant flipped --seed 3 [--days 6] [--people 6] [--brain jev] [--out run.json]
// scripts/evals.ts runs every probe over many seeds and holds each build to the last good one.
import { DAY, TILE_M, dryAt, newWorld, type Thing, type World } from "../src/sim/world";
import { tick } from "../src/sim/sim";
import { changed, counts, giveItems, newKinds, removeThing, removed } from "../src/sim/physics";
import { trailChanges } from "../src/sim/ecology";
import { traceListeners } from "../src/sim/trace";
import { asking, brainKind, useBrain } from "../src/sim/brain";
import { DARK, lightOn, skyShare } from "../src/sim/light";
import { anyAround, around, put } from "../src/sim/space";
import { fieldsOf, type Belief } from "../src/sim/beliefs";
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

const STONE = "strike|fiber+stone|stone|stone|-|-", FLINT = "strike|fiber+flint|stone|flint|-|-";
// Each hour, the chance of rain and of a strong wind, given whether it is dark where they are.
type Sky = (dark: boolean) => { rain: number; wind: number };
// starts: by person, the causes they start out blaming, or null for someone who doesn't know how at all; talk: they may
// also teach and talk
type Setup = { quench: Quench; then?: Quench; tell: boolean; sparks: "harder" | "softer"; ways: string[]; sky: Sky; starts?: (Quench[] | null)[]; talk?: boolean };
type Probe = { text: string; metrics: Record<string, Metric>; claims: Claim[]; variants: Record<string, Setup> };

const fair: Sky = () => ({ rain: 0, wind: 0 });
const changeable: Sky = () => ({ rain: 0.35, wind: 0.35 });
const nightRain: Sky = (dark) => ({ rain: dark ? 0.7 : 0.05, wind: 0 });

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
      real: { quench: "rain", tell: true, sparks: "harder", ways: [STONE, FLINT], sky: fair },
      // plain stone does
      flipped: { quench: "rain", tell: true, sparks: "softer", ways: [STONE, FLINT], sky: fair },
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
      real: { quench: "rain", tell: true, sparks: "harder", ways: [STONE], sky: changeable },
      flipped: { quench: "wind", tell: true, sparks: "harder", ways: [STONE], sky: changeable },
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
      real: { quench: "rain", tell: false, sparks: "harder", ways: [STONE], sky: nightRain },
      flipped: { quench: "dark", tell: false, sparks: "harder", ways: [STONE], sky: nightRain },
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
      real: { quench: "rain", then: "wind", tell: true, sparks: "harder", ways: [STONE], sky: changeable },
      flipped: { quench: "wind", then: "rain", tell: true, sparks: "harder", ways: [STONE], sky: changeable },
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
      real: { quench: "rain", tell: true, sparks: "harder", ways: [STONE], sky: changeable, starts: [["rain"], ["rain"], ["dark"], ["dark"], null, null], talk: true },
      flipped: { quench: "dark", tell: true, sparks: "harder", ways: [STONE], sky: changeable, starts: [["dark"], ["dark"], ["rain"], ["rain"], null, null], talk: true },
    },
  },
};

// Summer, a little after sunrise: no frost at night to muddy what they see.
const START = 12 * DAY + 6 * 12;
type Attempt = { agent: string; key: string; t: number; now: string[]; worked: boolean; testing: boolean };
type Change = { agent: string; key: string; cond: string; t: number };

// A way they know that has lit fires for them, as if they'd lit one with it once.
const knownWay = (key: string, t: number): Belief => ({
  key, fields: { ...fieldsOf(key), builds: "fire" }, uses: { fiber: 1 }, out: {}, ticks: 3, tries: 1, wins: 1, tally: { tries: 1, wins: 1 }, how: "discovered", t,
});

// Open ground near where they came ashore: dry, the sky clear overhead, nothing standing within a few meters.
function openGround(w: World, px: number, py: number): [number, number] {
  for (let r = 0; r < 300; r += 7) for (let k = 0; k < 16; k++) {
    const x = px + (Math.cos((k / 16) * Math.PI * 2) * r) / TILE_M, y = py + (Math.sin((k / 16) * Math.PI * 2) * r) / TILE_M;
    if (dryAt(w, x, y) && skyShare(w, x, y) > 0.95 && !anyAround(w, x, y, 6, ["tree", "bush", "dead_bush", "boulder", "structure"])) return [x, y];
  }
  return [px, py];
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
  if (brain === "random") useBrain({ kind: "random" });
  seedRandom(seed);
  const t0 = performance.now();
  const w = newWorld(seed, people);
  w.t = Math.max(w.t, START);
  w.animals = w.animals.filter((m) => m.species !== "wolf");
  Object.assign(RULES, { quench: v.quench, tell: v.tell, sparks: v.sparks, learning: "seen" });
  const [cx, cy] = openGround(w, w.agents[0].px, w.agents[0].py);
  const fresh: string[] = [];
  w.agents.forEach((a, i) => {
    put(w, a, cx + (Math.cos(i) * 2) / TILE_M, cy + (Math.sin(i) * 2) / TILE_M);
    a.home = null; a.goal = null; a.plan = [];
    const start = v.starts?.[i];
    a.beliefs = start === null ? {} : Object.fromEntries(v.ways.map((key) => [key, start?.length ? { ...knownWay(key, w.t), unless: [...start] } : knownWay(key, w.t)]));
    if (start === null) fresh.push(a.id);
  });
  const truth: Record<string, string | number> = { quench: v.quench, ...(v.then ? { then: v.then } : {}) };
  const ticks = probe === "choose" ? await fastest(w, v.ways) : {};
  const best = probe === "choose" ? v.ways.reduce((x, y) => (ticks[y] < ticks[x] ? y : x)) : "";
  if (best) Object.assign(truth, { best, ...Object.fromEntries(v.ways.map((k) => [`ticks:${k}`, Math.round(ticks[k] * 10) / 10])) });

  hooks.weather = (w) => {
    if (w.t % 12) return;
    const s = v.sky(lightOn(w, w.agents[0]).bright < DARK);
    w.weather.sky = Math.random() < s.rain ? "rain" : "clear";
    w.weather.speed = Math.random() < s.wind ? 18 : 2;
  };
  const weighs = (k: string) => k === "make_fire" || k === "rest" || k.startsWith("test:") || (!!v.talk && (k === "teach" || k === "talk"));
  hooks.options = (_w, _a, opts) => { for (const k of Object.keys(opts)) if (!weighs(k)) delete opts[k]; };

  const attempts: Attempt[] = [], formed: Change[] = [], dropped: Change[] = [];
  traceListeners.push((e) => {
    if (e.sys !== "theory" || !e.agent) return;
    const d = e.data as { key: string; now?: string[]; worked?: boolean; testing?: boolean; cond?: string; conds?: string[] };
    if (!v.ways.includes(d.key)) return;
    if (e.kind === "attempt") attempts.push({ agent: e.agent, key: d.key, t: e.t, now: d.now ?? [], worked: !!d.worked, testing: !!d.testing });
    else if (e.kind === "formed" && d.cond) formed.push({ agent: e.agent, key: d.key, cond: d.cond, t: e.t });
    else if (e.kind === "dropped") for (const c of d.conds ?? []) dropped.push({ agent: e.agent, key: d.key, cond: c, t: e.t });
  });
  const blames = (c: string) => w.agents.filter((a) => v.ways.some((k) => a.beliefs[k]?.unless?.includes(c))).map((a) => a.id);
  const begin = w.t, end = begin + days * DAY, half = begin + Math.floor((days * DAY) / 2);
  let heldOld: string[] = [];
  while (w.t < end) {
    if (v.then && w.t === half) { heldOld = blames(v.quench); RULES.quench = v.then; }
    // they keep wanting a fire and keep what it takes in hand; whatever they light is gone by the next tick
    for (const a of w.agents) {
      Object.assign(a.needs, { food: Math.max(a.needs.food, 80), energy: Math.max(a.needs.energy, 90), health: Math.max(a.needs.health, 90), warmth: 50 });
      const c = counts(a);
      if ((c.stone ?? 0) < 3) giveItems(w, a, "stone", 3 - (c.stone ?? 0));
      // two flints, so one chipped away mid-try doesn't leave them only the other way to choose for the next
      if (v.ways.includes(FLINT) && (c.flint ?? 0) < 2) giveItems(w, a, "flint", 2 - (c.flint ?? 0));
      if ((c.fiber ?? 0) < 2) giveItems(w, a, "fiber", 2 - (c.fiber ?? 0));
    }
    const fires: Thing[] = [];
    around(w, cx, cy, 200, ["fire"], (t) => { fires.push(t); });
    for (const t of fires) removeThing(w, t);
    tick(w);
    changed.clear(); removed.clear(); newKinds.clear(); trailChanges.clear();
    if (w.t % 4 === 0) await Bun.sleep(0);
    if (brainKind() !== "random") for (;;) { await Bun.sleep(asking() ? 10 : 0); if (!asking()) { await Bun.sleep(0); if (!asking()) break; } }
  }

  // what they did, by thirds of the run, tests aside
  const tries = attempts.filter((x) => !x.testing);
  const third = (k: 0 | 2) => tries.filter((x) => (k === 0 ? x.t < begin + (end - begin) / 3 : x.t >= begin + ((end - begin) * 2) / 3));
  const share = (xs: Attempt[], ok: (x: Attempt) => boolean) => (xs.length ? xs.filter(ok).length / xs.length : null);
  const n = w.agents.length, day = (t: number) => (t - begin) / DAY;
  // days from `from` until each person (or each of `who`) first did it, the rest of the run if they never did
  const until = (xs: Change[], cond: string, from: number, who = w.agents.map((a) => a.id)) =>
    who.length ? who.reduce((s, id) => s + day(xs.find((x) => x.agent === id && x.cond === cond && x.t >= from)?.t ?? end) - day(from), 0) / who.length : null;
  const metrics: Record<string, number | null> = {};
  if (probe === "choose") {
    const worse = Math.max(...v.ways.map((k) => ticks[k])), lost = (x: Attempt) => Math.min(ticks[x.key], worse) - ticks[best];
    Object.assign(metrics, {
      best: share(third(2), (x) => x.key === best),
      first: share(w.agents.flatMap((a) => tries.filter((x) => x.agent === a.id).slice(0, 5)), (x) => x.key === best),
      regret: tries.length ? tries.reduce((s, x) => s + lost(x), 0) / tries.length : null,
    });
  } else {
    const cause = v.then ?? v.quench, wasted = (x: Attempt) => x.now.includes(cause);
    const others = (id: string) => v.ways.some((k) => w.agents.find((a) => a.id === id)?.beliefs[k]?.unless?.some((c) => c !== cause && c !== v.quench));
    Object.assign(metrics, {
      right: blames(cause).length / n,
      wasted: share(third(2), wasted),
    });
    if (probe === "recover") Object.assign(metrics, {
      kept: blames(v.quench).length / n,
      dropped: until(dropped, v.quench, half, heldOld),
      found: until(formed, cause, half),
    });
    else if (probe === "spread") {
      const told = v.starts?.flat().find((c) => c && c !== cause), newcomers = w.agents.filter((a) => fresh.includes(a.id));
      Object.assign(metrics, {
        wrong: told ? blames(told).length / n : null,
        learned: newcomers.length ? newcomers.filter((a) => v.ways.some((k) => a.beliefs[k])).length / newcomers.length : null,
      });
    } else Object.assign(metrics, {
      wrong: w.agents.filter((a) => others(a.id)).length / n,
      wastedEarly: share(third(0), wasted),
      formed: until(formed, cause, begin),
      ...(probe === "confounded" ? { bystander: blames(v.quench === "rain" ? "dark" : "rain").length / n } : {}),
    });
  }
  hooks.weather = hooks.options = undefined;
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
