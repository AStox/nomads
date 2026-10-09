// Learning probes: small staged worlds whose truth is the world's own formulas, run to see whether people come to it and
// how fast. A few people stand on open ground in summer for days, wanting a fire and holding what it takes; each fire
// is cleared away as soon as it catches, so they keep making them; the probe sets the weather by the hour; and they
// weigh only lighting a fire, resting in the dark, and putting a theory of theirs to the test. Whether a try comes off
// is the physics' alone (physics.ts, wetness.ts): a spark catches only in tinder drier than damp, out of a gale; an ember
// in tinder short of soaked through. The probe stages what decides it (the rain that soaks their tinder, the gales, bags
// to keep it dry), never the outcome, and works out from the same formulas whether a try would come off for each person
// in each hour they met, so what they come to think can be held against the truth at the midpoint and at the end. The
// planting probes do the same with seed: each person on a plot of their own with an oak's deep shade over part of it
// (and bushes crowding another, in one), a berry coming to hand every few hours (or once a day, sparse), and whether a
// seed put in a spot would come up worked out by running the seedling's formula ahead over the weather the coming days
// might bring (seedling.ts), as often as it would under the probe's sky.
//   bun scripts/probes.ts --probe blame --variant real --seed 3 [--days 6] [--people 6] [--brain jev] [--out run.json]
//   bun scripts/probes.ts --batch runs.json: several runs (ProbeSpec), one after another in one process, each island grown
//   once however many of them are on it
// scripts/evals.ts runs every probe over many seeds and holds each build to the last good one.
import { readFileSync } from "node:fs";
import { DAY, TILE_M, addThing, dryAt, isNight, newWorld, rng, type Agent, type Thing, type World } from "../src/sim/world";
import { conditionsNow, tick } from "../src/sim/sim";
import { DURATION, changed, count, counts, emberCatches, frictionPer, giveItems, groundWord, newKinds, occupied, removeThing, removed, soilAt, sparkCatches, sparksPer, SEED_SOIL } from "../src/sim/physics";
import { nextWet, trailChanges } from "../src/sim/ecology";
import { traceListeners, type TraceEntry } from "../src/sim/trace";
import { asking, brainKind, useBrain } from "../src/sim/brain";
import { DARK, lightOn, skyShare } from "../src/sim/light";
import { airOn } from "../src/sim/air";
import { anyAround, around, put, thingById } from "../src/sim/space";
import { fieldsOf, groundKey, ofPlace, ruledOut, type Belief } from "../src/sim/beliefs";
import { REF, deadAt, tinder, tinderOf } from "../src/sim/wetness";
import { ahead, bedAt, seedlingFate, type Bed, type Hour } from "../src/sim/seedling";
import { envHere } from "../src/sim/plants";
import { feedRate, fertilityAt } from "../src/sim/soil";
import { fit } from "../src/terrain/niche";
import { RULES, hooks } from "../src/sim/rules";
import { seedRandom } from "./seeded";

export type Metric = { better: "higher" | "lower"; tol: number; text: string };
// What a probe expects of learning, held over every seed with a 95% interval (scripts/evals.ts): a number's mean above
// or below a value, or one number's mean above another's by more than a value.
export type Claim = { id: string; text: string } & ({ above: string; value: number } | { below: string; value: number } | { gap: [string, string]; value: number });
export type ProbeRun = {
  probe: string; variant: string; seed: number; brain: string; days: number; people: number; secs: number;
  attempts: number; jev: { calls: number; tokens: number }; truth: Record<string, string | number>; metrics: Record<string, number | null>;
};
// One run, and the file its result goes to (printed, without one).
export type ProbeSpec = { probe: string; variant: string; seed: number; days: number; people: number; brain: "random" | "jev"; out?: string };

const STONE = "strike|fiber+stone|stone|stone|-|-", FLINT = "strike|fiber+flint|stone|flint|-|-", RUB = "rub|stick+stick+fiber|-|-|-|-", PLANT = "plant|berry|-|-|-|-";
// Each hour, the chance of rain and of a gale, given whether it is dark where they are.
type Sky = (dark: boolean) => { rain: number; wind: number };
// ways: what they know to make a fire with; causes: the conditions anyone can see that the formula makes it fail in, as
// staged (what the evidence is held to, and the record); bystander: one that comes with them and doesn't matter; half:
// what changes halfway, the sky and bags to keep their tinder dry, the causes from then on and the one they'd have had
// cause to blame before that no longer fails (old); starts: by person, the theories they start out with, or null for
// someone who doesn't know how at all; talk: they may also teach and talk
type Setup = {
  ways: string[]; sky: Sky; causes: string[]; bystander?: string; half?: { sky: Sky; causes: string[]; old: string };
  starts?: (string[] | null)[]; talk?: boolean;
};
// A planter's plot, in meters from where they stand facing east: an oak this tall this far to the west, its deep shade
// over the spots on that side of them, and bushes at these offsets east and south of them, crowding the spots round
// them.
type Plot = { oak: number; west: number; bushes: [number, number][] };
// The planting probes': the plot; causes as for fire; every: how often a berry comes to hand for a planter who has none;
// starts: by person, what they start out blaming for seedlings that never come up (none, for most); talk: they may also
// teach and talk
type Sow = { plot: Plot; sky: Sky; causes: string[]; every: number; starts?: string[][]; talk?: boolean };
// days: how long it runs, whatever the run asks (scripts/evals.ts asks the same of every probe), for a probe whose
// outcomes take days to show or whose cause comes seldom
type Probe = { text: string; metrics: Record<string, Metric>; claims: Claim[]; variants: Record<string, Setup | Sow>; days?: number };

const fair: Sky = () => ({ rain: 0, wind: 0 });
const wet: Sky = () => ({ rain: 0.35, wind: 0 });
const stormy: Sky = () => ({ rain: 0.35, wind: 0.35 });
const nightRain: Sky = (dark) => ({ rain: dark ? 0.7 : 0.05, wind: 0 });
const gusty: Sky = () => ({ rain: 0, wind: 1 / 12 });
const changeable: Sky = () => ({ rain: 0.35, wind: 0.35 });

// What the evidence would support, beside what they came to: evident, the share of people whose own tries (all they saw
// the outcome of, tests too) show the true cause doing worse than its absence beyond chance, as a statistician holding
// every one of their tries would judge it (two proportions, one-sided at 95%); not judged, since it rises and falls with
// where they choose to try (tol 1 never flags it). caught: of those, the share whose theories came to rule it out
// wherever it holds.
const EVIDENCE = {
  evident: { better: "higher", tol: 1, text: "share of people whose own tries show the true cause worse beyond chance (not judged)" },
  caught: { better: "higher", tol: 0.1, text: "share of those whose own tries show the true cause whose theories rule it out wherever it holds" },
} satisfies Record<string, Metric>;
const CAUGHT: Claim = { id: "caught", text: "nearly all whose own tries show the true cause beyond chance come to rule it out wherever it holds (more than 75%)", above: "caught", value: 0.75 };
// How what they'd do matches what would happen, over the probe's own hours (and, planting, every spot of their plot in
// them), each as often as it came: what they'd do is whether their theories rule it out there (beliefs.ts ruledOut).
// acc: the share where they'd do it just where it would work; needless: where they'd hold back though it would work,
// what a wrong theory costs; blind: where they'd go ahead though it can't. At the end, and at the midpoint (Mid), on
// the same hours; of those who know how.
const TRUTH = {
  acc: { better: "higher", tol: 0.05, text: "share of the probe's hours (and spots) where what they'd do matches whether it would work, at the end" },
  accMid: { better: "higher", tol: 0.05, text: "the same at the midpoint" },
  needless: { better: "lower", tol: 0.05, text: "share where they'd hold back though it would work, at the end" },
  needlessMid: { better: "lower", tol: 0.05, text: "the same at the midpoint" },
  blind: { better: "lower", tol: 0.05, text: "share where they'd go ahead though it can't work, at the end" },
} satisfies Record<string, Metric>;
// Theories that tend toward the truth: no worse at the end than at the midpoint, nearly always right by the end, and
// holding back needlessly no more as time goes on.
const TREND: Claim[] = [
  { id: "truthward", text: "what they'd do matches whether it would work at least as often at the end as at the midpoint", gap: ["acc", "accMid"], value: -0.02 },
  { id: "knows", text: "what they'd do matches whether it would work more than nine times in ten by the end", above: "acc", value: 0.9 },
  { id: "unsuperstitious", text: "they hold back where it would work no more at the end than at the midpoint", gap: ["needlessMid", "needless"], value: -0.02 },
];
const CAUSE = {
  right: { better: "higher", tol: 0.1, text: "share of people whose theories rule it out wherever it truly fails" },
  wrong: { better: "lower", tol: 0.1, text: "share of people whose theories rule it out somewhere it would work" },
  exact: { better: "higher", tol: 0.1, text: "share of people whose theories rule it out just where it fails, and nowhere else" },
  wasted: { better: "lower", tol: 0.05, text: "share of their last third of tries (tests aside) made where it can't work" },
  wastedEarly: { better: "lower", tol: 0.05, text: "share of their first third of tries (tests aside) made where it can't work" },
  formed: { better: "lower", tol: 0.5, text: "days until each first rules it out wherever it truly fails (the whole run if never)" },
  ...EVIDENCE,
  ...TRUTH,
} satisfies Record<string, Metric>;
const SOWN = {
  ...CAUSE,
  right: { ...CAUSE.right, text: "share of people whose theories rule out planting wherever seedlings truly never come up" },
  wasted: { ...CAUSE.wasted, text: "share of their last third of plantings (tests aside) made where nothing comes up" },
  wastedEarly: { ...CAUSE.wastedEarly, text: "share of their first third of plantings (tests aside) made where nothing comes up" },
} satisfies Record<string, Metric>;

// The plot every planting probe stages, but for one: an oak of 18 m five paces west, its crown deep over the spots on
// that side of them and thinning over those north and south; no bushes.
const SHADED: Plot = { oak: 18, west: 5, bushes: [] };

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
      // flint, the harder, throws more sparks a blow, under a fair sky where both always catch
      real: { ways: [STONE, FLINT], sky: fair, causes: [] },
    },
  },
  blame: {
    text: "Rain soaks their tinder and a spark won't catch in it damp; the dark and the cold come and go too: do they come to blame the damp, and only it?",
    metrics: CAUSE,
    claims: [
      { id: "most", text: "most come to blame the true cause", above: "right", value: 0.5 },
      { id: "only", text: "more blame the true cause than anything else", gap: ["right", "wrong"], value: 0 },
      { id: "less-waste", text: "fewer of their tries go to waste late than early", gap: ["wastedEarly", "wasted"], value: 0 },
      CAUGHT,
      ...TREND,
    ],
    variants: {
      real: { ways: [STONE], sky: wet, causes: ["damp"] },
    },
  },
  confounded: {
    text: "The rain falls mostly at night, and the damp it leaves in their tinder keeps sparks from catching: do they tell it from the dark?",
    days: 10,
    metrics: { ...CAUSE, bystander: { better: "lower", tol: 0.1, text: "share of people who end up blaming the dark, which comes with it" } },
    claims: [
      { id: "cause", text: "more blame the true cause than the dark that comes with it", gap: ["right", "bystander"], value: 0 },
      { id: "most", text: "nearly everyone comes to blame the true cause (more than 85%)", above: "right", value: 0.85 },
      { id: "few-bystanders", text: "fewer than one in four also blame the dark, which only comes with it", below: "bystander", value: 0.25 },
      CAUGHT,
      ...TREND,
    ],
    variants: {
      real: { ways: [STONE], sky: nightRain, causes: ["damp"], bystander: "dark" },
    },
  },
  // Nothing in the world changes its laws; what changes here is what they have: halfway, bags that keep their tinder dry
  // in the rain, as the gales start. Those who blamed the rain should try it there again and see it work, and find what
  // kills sparks now.
  recover: {
    text: "Halfway they get bags that keep their tinder dry in the rain, and the gales start: do those who blamed the rain try it in the rain again and see it work, and do they find the gale?",
    days: 10,
    metrics: {
      right: { better: "higher", tol: 0.1, text: "share of people whose theories rule it out wherever it fails after the change" },
      retried: { better: "higher", tol: 0.1, text: "of those who blamed the rain at the change, the share who tried it in the rain again and saw it work" },
      kept: { better: "lower", tol: 1, text: "share of people who end up still blaming the rain (not judged: people who never forget a try keep the failures they saw there)" },
      wasted: CAUSE.wasted,
      found: { better: "lower", tol: 0.5, text: "days from the change until each first rules it out wherever it fails after it" },
      acc: { ...TRUTH.acc, tol: 1, text: `${TRUTH.acc.text}, after the change (not judged, as kept)` },
      ...EVIDENCE,
    },
    claims: [
      { id: "retry", text: "nearly all who blamed the rain try it there again after the change and see it work (more than 75%)", above: "retried", value: 0.75 },
      { id: "find", text: "at least two in three come to blame the gale", above: "right", value: 0.65 },
      CAUGHT,
    ],
    variants: {
      real: { ways: [STONE], sky: wet, causes: ["damp"], half: { sky: stormy, causes: ["wind"], old: "rain" } },
    },
  },
  spread: {
    text: "Some know damp tinder won't take a spark, some were told the dark is to blame, some don't know how to make a fire at all: which belief spreads?",
    metrics: {
      right: CAUSE.right,
      wrong: { better: "lower", tol: 0.1, text: "share of people who end up blaming the false cause some started with" },
      wasted: CAUSE.wasted,
      learned: { better: "higher", tol: 0.15, text: "share of those who didn't know how who learned to make a fire" },
      ...TRUTH,
    },
    claims: [
      { id: "truth-wins", text: "more end up blaming the true cause than the false one", gap: ["right", "wrong"], value: 0 },
      { id: "error-fades", text: "fewer than half end up with the false one", below: "wrong", value: 0.5 },
      ...TREND,
    ],
    variants: {
      real: { ways: [STONE], sky: wet, causes: ["damp"], starts: [["damp"], ["damp"], ["dark"], ["dark"], null, null], talk: true },
    },
  },
  // The second round: what the first five don't reach.
  two: {
    text: "Damp tinder kills sparks, and so does a gale that carries them off: do they come to blame both, or stop at the first?",
    metrics: { ...CAUSE, partly: { better: "lower", tol: 0.1, text: "share of people whose theories rule it out where some of the causes hold but not all" } },
    claims: [
      { id: "both", text: "most come to blame both", above: "right", value: 0.5 },
      { id: "only", text: "more blame both than anything else", gap: ["right", "wrong"], value: 0 },
      CAUGHT,
      ...TREND,
    ],
    variants: {
      real: { ways: [STONE], sky: stormy, causes: ["damp", "wind"] },
    },
  },
  // The fourth round: an exception, as the physics makes one. An ember keeps glowing against tinder a spark couldn't light:
  // damp tinder catches from rubbing, and only tinder soaked through doesn't. Someone who blames the damp holds back
  // where it would work.
  except: {
    text: "An ember from rubbing catches in damp tinder, though not in tinder soaked through, and nothing they see says which: do they find just where it fails?",
    days: 10,
    metrics: CAUSE,
    claims: [
      { id: "exact", text: "most end up ruling it out just where it fails", above: "exact", value: 0.5 },
      CAUGHT,
      ...TREND,
    ],
    variants: {
      real: { ways: [RUB], sky: wet, causes: ["soaked"] },
    },
  },
  rare: {
    text: "A gale that carries the sparks off comes only one hour in twelve: do they come to blame it?",
    days: 10,
    metrics: CAUSE,
    claims: [
      { id: "most", text: "most come to blame it", above: "right", value: 0.5 },
      { id: "only", text: "more blame it than anything else", gap: ["right", "wrong"], value: 0 },
      CAUGHT,
      ...TREND,
    ],
    variants: {
      real: { ways: [STONE], sky: gusty, causes: ["wind"] },
    },
  },
  // The third round: what's done to the ground, where most of what an island can teach lies. Tries are few, what comes
  // of one shows days later, and a seedling that withers says nothing of why. Seedlings they planted crowd the next:
  // the formula has them take their share of the light and water from anything planted after them close by.
  seed: {
    text: "Seedlings never come up in deep shade, nor crowded in close among others, though they do in the light shade at its edge, and it shows only days later: do they come to blame what withers them, and not the weather?",
    // a seedling shows some days after it goes in, and a planter with a berry a day sees twenty come up or not
    days: 20,
    metrics: { ...SOWN, weather: { better: "lower", tol: 0.1, text: "share of people who end up blaming any weather for their plantings" } },
    claims: [
      { id: "most", text: "most come to blame the true cause", above: "right", value: 0.5 },
      { id: "only", text: "more blame the true cause than anything else", gap: ["right", "wrong"], value: 0 },
      { id: "less-waste", text: "fewer of their plantings go where nothing comes up late than early", gap: ["wastedEarly", "wasted"], value: 0 },
      { id: "not-weather", text: "fewer than one in four blame the weather", below: "weather", value: 0.25 },
      CAUGHT,
      ...TREND,
    ],
    variants: {
      // a berry to plant every four hours, so a few plantings a day (with berries in hand all the time, they plant thirty
      // a day)
      real: { plot: SHADED, sky: changeable, causes: ["deep", "crowded"], every: DAY / 6 },
      // as real, with a berry a day: nearer what a planter in a whole world goes on
      sparse: { plot: SHADED, sky: changeable, causes: ["deep", "crowded"], every: DAY },
      // as sparse, with three bushes crowding the spots east of them so close that what they leave a seedling of the
      // light and water can't keep it alive: crowding stands out less from the rest, as on the islands where whole worlds
      // learned least
      two: { plot: { ...SHADED, bushes: [[1.8, 0], [1.3, -1.3], [1.3, 1.3]] }, sky: changeable, causes: ["deep", "crowded"], every: DAY },
    },
  },
  // The third round: what passes between planters who all know how.
  hearsay: {
    text: "Two planters already blame the deep shade seedlings never come up in, and the rest know how to plant but not that: does it pass among them, beside what each sees for themselves?",
    days: 20,
    metrics: {
      right: SOWN.right,
      heard: { better: "higher", tol: 0.1, text: "share of those who started out not blaming it whose theories come to rule it out" },
      wrong: CAUSE.wrong,
      ...EVIDENCE,
      ...TRUTH,
    },
    claims: [
      { id: "spreads", text: "nearly all who started out not blaming it come to (more than 75%)", above: "heard", value: 0.75 },
      CAUGHT,
      ...TREND,
    ],
    variants: {
      // a berry a day, so what each sees for themselves is thin
      real: { plot: SHADED, sky: changeable, causes: ["deep", "crowded"], every: DAY, starts: [["deep"], ["deep"], [], [], [], []], talk: true },
    },
  },
  unlearn: {
    text: "Planters start out sure seedlings won't come up in the rain, which is false, while deep shade and crowding are what wither them: do they let the false theory go, and find the true one?",
    days: 20,
    metrics: { ...SOWN, kept: { better: "lower", tol: 0.1, text: "share of people who end up still blaming the weather they started out blaming" } },
    claims: [
      { id: "let-go", text: "fewer than three in ten keep the false theory they started with", below: "kept", value: 0.3 },
      { id: "most", text: "most come to blame the true cause", above: "right", value: 0.5 },
      CAUGHT,
      ...TREND,
    ],
    variants: {
      // a berry every four hours, as seed/real, so there is time enough to put the false theory to the test
      real: { plot: SHADED, sky: changeable, causes: ["deep", "crowded"], every: DAY / 6, starts: [["rain"], ["rain"], ["rain"], ["rain"], ["rain"], ["rain"]] },
      // as real, with a berry a day: what planters in whole worlds go on, where a false theory about the weather was
      // never once tested (nobody plants in weather they blame, and a planting can't be watched coming up)
      sparse: { plot: SHADED, sky: changeable, causes: ["deep", "crowded"], every: DAY, starts: [["rain"], ["rain"], ["rain"], ["rain"], ["rain"], ["rain"]] },
    },
  },
};

// Fires in summer, a little after sunrise: no frost at night to muddy what they see. Planting in spring, through
// midsummer into the start of autumn, while it's warm enough for seed to come up.
const START = 12 * DAY + 6 * 12, SOW_START = 5 * DAY + 6 * 12;
type Attempt = { agent: string; key: string; t: number; now: string[]; worked: boolean; testing: boolean };
// What holds in an hour (and, planting, at a spot): how often it came, and how often a try there would have come off by
// the formulas. A case fails where most tries would.
type Case = { now: string[]; n: number; ok: number };
// Whether one of these conditions holds in what someone saw (now): every part of it, a "!" part by its lack.
const holds = (t: string, now: string[]) => t.split("+").every((c) => (c.startsWith("!") ? !now.includes(c.slice(1)) : now.includes(c)));
// What someone's theories of these ways would have them do over the cases, each as often as it came: they'd hold back
// where every way they know is ruled out (beliefs.ts ruledOut). acc, needless and blind as TRUTH says; missed, the
// cases that mostly fail they'd go ahead in, and over, those that mostly work they'd hold back in; null for someone who
// knows no way.
type Judged = { acc: number; needless: number; blind: number; missed: number; over: number } | null;
function judge(bs: Belief[], cases: Case[]): Judged {
  if (!bs.length) return null;
  let all = 0, needless = 0, blind = 0, missed = 0, over = 0;
  for (const c of cases) {
    const out = bs.every((b) => ruledOut(b, c.now)), fails = c.ok * 2 < c.n;
    all += c.n;
    if (out) { needless += c.ok; if (!fails) over++; } else { blind += c.n - c.ok; if (fails) missed++; }
  }
  return all ? { acc: 1 - (needless + blind) / all, needless: needless / all, blind: blind / all, missed, over } : null;
}
// Whether any of their theories names a condition, as one that has to hold for it.
const names = (bs: Belief[], c: string) => bs.some((b) => b.unless?.some((t) => t.split("+").includes(c)));

// A way they know that has worked for them, as if they'd done it once and it took the ticks given: lit a fire, or pushed
// a berry into the ground and seen it come up some days later.
const knownWay = (key: string, t: number, ticks: number): Belief => {
  const f = fieldsOf(key), plant = f.verb === "plant", rub = f.verb === "rub";
  const uses: Record<string, number> = plant ? { berry: 1 } : rub ? { stick: 1, fiber: 1 } : { fiber: 1 };
  return {
    key, fields: { ...f, builds: plant ? "bush" : "fire" }, uses, out: {}, ticks, ...(plant ? { later: 3 * DAY } : {}),
    tries: 1, wins: 1, tally: { tries: 1, wins: 1 }, how: "discovered", t,
  };
};
// The ticks a way takes to a fire in daylight, by the formulas: a blow a tick until a spark catches (physics.ts sparksPer),
// or a tick's rubbing at a time until the wood is hot enough (frictionPer), practised at neither.
function ticksOf(w: World, key: string) {
  const f = fieldsOf(key);
  return f.verb === "rub" ? Math.ceil(1 / frictionPer(false, 0)) : Math.ceil(1 / sparksPer(w.kinds[f.tool!], w.kinds[f.target!]));
}
// Whether a try of a way would come off for someone now, by the physics' own formulas: a spark struck over their tinder
// catches if it holds no more water than damp and no gale carries the sparks off; an ember, no more than soaked.
function catchesNow(w: World, a: Agent, key: string) {
  const f = fieldsOf(key);
  if (f.verb === "rub") return emberCatches(tinderOf(w, a)?.m ?? 0);
  const over = f.inputs.find((k) => tinder(w.kinds[k])) ?? "fiber";
  return sparkCatches(tinderOf(w, a, over)?.m ?? 0, airOn(w, a).wind);
}

// Open ground near where they came ashore: dry, the sky clear overhead, nothing standing within a few meters.
function openGround(w: World, px: number, py: number): [number, number] {
  for (let r = 0; r < 300; r += 7) for (let k = 0; k < 16; k++) {
    const x = px + (Math.cos((k / 16) * Math.PI * 2) * r) / TILE_M, y = py + (Math.sin((k / 16) * Math.PI * 2) * r) / TILE_M;
    if (dryAt(w, x, y) && skyShare(w, x, y) > 0.95 && !anyAround(w, x, y, 6, ["tree", "bush", "dead_bush", "boulder", "structure"])) return [x, y];
  }
  return [px, py];
}

// The plots, in meters from where each planter stands: the next plot this far to the south, and everything else cleared
// off this far round.
const PLOT_APART = 16, PLOT_CLEAR = 12;
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
// The weather of the hours ahead under the probe's sky, from the rain still running off the land now, drawn with r (its
// own draws, not the world's): K stretches of it, for working out what a seed put in now would come to.
const K = 6, AHEAD = 30 * 24;
function skies(w: World, sky: Sky, r: () => number): Hour[][] {
  return Array.from({ length: K }, () => {
    let wet = w.weather.wet, t = Math.ceil((w.t + 1) / 12) * 12;
    const hours: Hour[] = [];
    for (let i = 0; i < AHEAD; i++, t += 12) {
      const s = sky(isNight(t)), rain = r() < s.rain, gale = r() < s.wind;
      wet = nextWet(wet, rain ? "rain" : "clear");
      hours.push({ sky: rain ? "rain" : "clear", speed: gale ? 18 : 2, wet });
    }
    return hours;
  });
}
// How many of those stretches a berry pushed into the ground in each bed now would come up in (seedling.ts), the
// weather at each worked out at a point among them (at), whose fields they share.
function comingUp(w: World, at: Pos, beds: Bed[], weathers: Hour[][]) {
  const up = beds.map(() => 0);
  for (const hours of weathers) {
    const to = ahead(w, at.px, at.py, w.t, hours);
    beds.forEach((b, i) => { if (seedlingFate(b, false, to) !== null) up[i]++; });
  }
  return up;
}
// What open ground at a point would give a berry once cleared: the whole sky's light, and nothing round it to share with.
const openBed = (w: World, at: Pos): Bed => ({ fit: fit("berry", { ...envHere(w, at.px, at.py), light: 1, fert: fertilityAt(w, at.px, at.py) }), share: 1, light: 1, feed: feedRate(w, at.px, at.py) });
// A plot for each of n planters, in a column running south from the first spot near (at) where every plot is dry and
// has soil enough for a seed everywhere a seed or the oak or a bush could go, no other kind of ground is in sight to go
// and try, and a berry put in the open spots east of them would come up, as the probe's sky makes the weather (or
// failing that, the first that is all one ground, or at itself): cleared, with its oak and its bushes. With nowhere else
// to go, they plant on their plots and nowhere else.
function plots(w: World, at: Pos, n: number, plot: Plot, sky: Sky, r: () => number): Pos[] {
  let ps: Pos[] | undefined, fallback: Pos[] | undefined;
  const weathers = skies(w, sky, r);
  for (let d = 0; d < 1000 && !ps; d += 10) for (let k = 0; k < 16 && !ps; k++) {
    const c = off(at, Math.cos((k / 16) * Math.PI * 2) * d, Math.sin((k / 16) * Math.PI * 2) * d);
    const col = Array.from({ length: n }, (_, i) => off(c, 0, i * PLOT_APART)), g = groundWord(w, c.px, c.py);
    if (!col.flatMap((p) => [p, off(p, -plot.west, 0), ...plot.bushes.map(([x, y]) => off(p, x, y)), ...ring(p)]).every((s) => dryAt(w, s.px, s.py) && soilAt(w, s.px, s.py) >= SEED_SOIL && groundWord(w, s.px, s.py) === g)) continue;
    fallback ??= col;
    if (groundsSeen(w, col).size !== 1) continue;
    if (col.every((p) => comingUp(w, p, [openBed(w, off(p, 3, 0))], weathers)[0] * 2 > K)) ps = col;
  }
  ps ??= fallback ?? Array.from({ length: n }, (_, i) => off(at, 0, i * PLOT_APART));
  for (const p of ps) {
    const here: Thing[] = [];
    around(w, p.px, p.py, PLOT_CLEAR, null, (t) => void here.push(t));
    for (const t of here) removeThing(w, t);
    const tree = off(p, -plot.west, 0);
    addThing(w, "tree", tree.px, tree.py, { species: "oak", size: plot.oak, hp: 53, maxHp: 53 });
    for (const [x, y] of plot.bushes) { const b = off(p, x, y); addThing(w, "bush", b.px, b.py, { species: "berry", size: 1, n: 0, hp: 20, maxHp: 20 }); }
  }
  return ps;
}

export async function runProbe(probe: string, variant: string, seed: number, days: number, people: number, brain: "random" | "jev"): Promise<ProbeRun> {
  const P = PROBES[probe], v = P?.variants[variant];
  if (!v) throw new Error(`no probe ${probe}/${variant}: ${Object.entries(PROBES).map(([p, x]) => Object.keys(x.variants).map((k) => `${p}/${k}`).join(", ")).join(", ")}`);
  days = P.days ?? days;
  if (brain === "random") useBrain({ kind: "random" });
  RULES.learning = "seen";
  seedRandom(seed);
  // the probe's own draws, for the weather it looks ahead to, which never move the world's
  const draws = rng(seed * 7919 + 13);
  const t0 = performance.now();
  const w = newWorld(seed, people);
  const sowing = "plot" in v, ways = sowing ? [PLANT] : v.ways, change = sowing ? undefined : v.half;
  w.t = Math.max(w.t, sowing ? SOW_START : START);
  w.animals = w.animals.filter((m) => m.species !== "wolf");
  const [cx, cy] = openGround(w, w.agents[0].px, w.agents[0].py);
  const fresh: string[] = [];
  const truth: Record<string, string | number> = { causes: v.causes.join(" or ") || "none" };
  const ps = sowing ? plots(w, { px: cx, py: cy }, w.agents.length, v.plot, v.sky, draws) : [];
  // what stands on each plot as staged, which is all that may: whatever comes up there is cleared away the tick after,
  // as a fire is, and nothing else grows in
  const staged = new Set<string>();
  for (const p of ps) around(w, p.px, p.py, PLOT_CLEAR, null, (t) => void staged.add(t.id));
  if (sowing) {
    // each on a plot of their own, facing east to start, nothing in hand, knowing that a berry pushed into the ground
    // comes up (one did for them, on the ground of their plot), and blaming what the probe says they start out blaming
    w.agents.forEach((a, i) => {
      put(w, a, ps[i].px, ps[i].py);
      a.heading = 0; a.home = null; a.goal = null; a.plan = []; a.inv = [];
      const start = v.starts?.[i] ?? [];
      a.beliefs = { [PLANT]: { ...knownWay(PLANT, w.t, DURATION.plant), when: { [groundKey(groundWord(w, a.px, a.py))]: { tries: 1, wins: 1 } }, ...(start.length ? { unless: [...start] } : {}) } };
    });
    Object.assign(truth, { grounds: groundsSeen(w, ps).size });
  } else {
    // every way to a fire they know looks as quick as the quickest of them, so which is slower is theirs to find: of
    // ways that look alike they plan the first they know (plan.ts search), and a try that takes longer than they thought
    // makes it look slower, where one that took as long as they thought would leave the two alike for good
    const quick = Math.min(...v.ways.map((k) => ticksOf(w, k)));
    w.agents.forEach((a, i) => {
      put(w, a, cx + (Math.cos(i) * 2) / TILE_M, cy + (Math.sin(i) * 2) / TILE_M);
      a.home = null; a.goal = null; a.plan = [];
      const start = v.starts?.[i];
      a.beliefs = start === null ? {} : Object.fromEntries(v.ways.map((key) => [key, start?.length ? { ...knownWay(key, w.t, quick), unless: [...start] } : knownWay(key, w.t, quick)]));
      if (start === null) fresh.push(a.id);
    });
  }
  // which way is truly faster, by the formulas
  const ticks: Record<string, number> = probe === "choose" ? Object.fromEntries(ways.map((k) => [k, ticksOf(w, k)])) : {};
  const best = probe === "choose" ? ways.reduce((x, y) => (ticks[y] < ticks[x] ? y : x)) : "";
  if (best) Object.assign(truth, { best, ...Object.fromEntries(ways.map((k) => [`ticks:${k}`, ticks[k]])) });

  const begin = w.t, end = begin + days * DAY, half = begin + Math.floor((days * DAY) / 2);
  let sky = v.sky, bagged = false;
  hooks.weather = (w) => {
    const s = sky(lightOn(w, w.agents[0]).bright < DARK);
    w.weather.sky = Math.random() < s.rain ? "rain" : "clear";
    w.weather.speed = Math.random() < s.wind ? 18 : 2;
  };
  // they weigh only doing it (lighting a fire, or planting a berry in hand: one fetched from a bush would have them
  // planting more often than the probe hands them out, and far from where it put them), resting, and putting a theory
  // to the test
  const aim = sowing ? "plant" : "make_fire", talk = !!v.talk;
  hooks.options = (_w, a, opts) => {
    const held = !sowing || count(a, "berry") > 0;
    for (const k of Object.keys(opts)) if (!(k === "rest" || (held && (k === aim || k.startsWith("test:"))) || (talk && (k === "teach" || k === "talk")))) delete opts[k];
  };

  // what they did and saw come of it: a try at a fire, judged at once, or a planting, judged when it came up or withered
  const attempts: Attempt[] = [];
  const listen = (e: TraceEntry) => {
    if (e.sys !== "theory" || e.kind !== "attempt" || !e.agent) return;
    const d = e.data as { key: string; now?: string[]; worked?: boolean; testing?: boolean; done?: number };
    if (ways.includes(d.key)) attempts.push({ agent: e.agent, key: d.key, t: d.done ?? e.t, now: d.now ?? [], worked: !!d.worked, testing: !!d.testing });
  };
  traceListeners.push(listen);
  // each planting as it went in, and whether by the formulas it would come up there then
  const sown: Attempt[] = [];
  // each person's theories of these ways as they stood, from the start, whenever they changed, at the midpoint and at
  // the end
  const states = new Map<string, { t: number; bs: Belief[]; shape: string }[]>();
  const shapeOf = (a: Agent) => JSON.stringify(ways.map((k) => (a.beliefs[k] ? a.beliefs[k].unless ?? [] : null)));
  const note = (a: Agent, force = false) => {
    const list = states.get(a.id) ?? [], shape = shapeOf(a);
    if (!force && list.at(-1)?.shape === shape) return;
    list.push({ t: w.t, shape, bs: structuredClone(ways.map((k) => a.beliefs[k]).filter((b): b is Belief => !!b)) });
    states.set(a.id, list);
  };
  for (const a of w.agents) note(a, true);
  // the cases each person met: for a fire, each hour once its weather has turned, what holds for them and whether a try
  // would come off; planting, every few hours, the same at each spot of their plot; and for what changes halfway, the
  // cases after it apart
  const cases = w.agents.map(() => new Map<string, Case>()), after = w.agents.map(() => new Map<string, Case>());
  const bump = (m: Map<string, Case>, now: string[], ok: boolean) => {
    const k = [...now].sort().join("+"), c = m.get(k) ?? m.set(k, { now: k ? k.split("+") : [], n: 0, ok: 0 }).get(k)!;
    c.n++; if (ok) c.ok++;
  };
  const plotSpots = sowing ? w.agents.map((_, i) => ring(ps[i]).filter((s) => !occupied(w, s.px, s.py))) : [];
  const way = fieldsOf(ways[0]);
  while (w.t < end) {
    if (w.t === half) {
      if (change) {
        sky = change.sky;
        bagged = true;
        // a leather bag, as anyone could tie one of a hide: something that shuts, to keep what's in it out of the rain
        w.kinds.bag ??= { id: "bag", name: "leather bag", props: { container: 0.75, flexible: 0.7, insulating: 0.4, toughness: 0.4 } };
        for (const a of w.agents) giveItems(w, a, "bag");
      }
      for (const a of w.agents) note(a, true);
    }
    // they keep wanting a fire and keep what it takes in hand, the fiber gathered round about as wet as what lies there
    // (or from their bag, dry), or to plant and get a berry to plant as often as the probe says, the first as it starts,
    // turning to face a new way with each (the first spot they'd try is the one in front of them: physics.ts spotNear),
    // so their seed goes in all round them however seldom they plant; whatever fire they light is gone by the next tick
    for (const a of w.agents) {
      Object.assign(a.needs, { food: Math.max(a.needs.food, 80), energy: Math.max(a.needs.energy, 90), health: Math.max(a.needs.health, 90), warmth: 50 });
      const c = counts(a);
      if (sowing) {
        if (!c.berry && (w.t - begin) % v.every === 0) { giveItems(w, a, "berry"); a.heading = Math.random() * Math.PI * 2; }
        continue;
      }
      if (ways.includes(STONE) || ways.includes(FLINT)) { if ((c.stone ?? 0) < 3) giveItems(w, a, "stone", 3 - (c.stone ?? 0)); }
      // two flints, so one chipped away mid-try doesn't leave them only the other way to choose for the next
      if (ways.includes(FLINT) && (c.flint ?? 0) < 2) giveItems(w, a, "flint", 2 - (c.flint ?? 0));
      if (ways.includes(RUB) && (c.stick ?? 0) < 3) giveItems(w, a, "stick", 3 - (c.stick ?? 0));
      if ((c.fiber ?? 0) < 2) giveItems(w, a, "fiber", 2 - (c.fiber ?? 0), bagged ? 0 : deadAt(w, a, REF[0]));
    }
    if (sowing) {
      // whatever came up last tick, and anything else that grew in, cleared off the plots
      const grown: Thing[] = [];
      for (const p of ps) around(w, p.px, p.py, PLOT_CLEAR, null, (t) => { if (!staged.has(t.id) && !(t.kind === "sapling" && t.owner)) grown.push(t); });
      for (const t of grown) removeThing(w, t);
    } else {
      const fires: Thing[] = [];
      around(w, cx, cy, 200, ["fire"], (t) => { fires.push(t); });
      for (const t of fires) removeThing(w, t);
    }
    // who is out to test a theory as the tick starts: a planting that tick is a test
    const testing = sowing ? w.agents.filter((a) => a.goal?.type.startsWith("test:")).map((a) => a.id) : [];
    const before = sowing ? w.agents.map((a) => new Set((a.waiting ?? []).map((e) => e.thing))) : [];
    tick(w);
    if (sowing) w.agents.forEach((a, i) => {
      for (const e of a.waiting ?? []) {
        if (before[i].has(e.thing) || !ways.includes(e.key)) continue;
        const t = thingById(w, e.thing);
        if (!t) continue;
        const up = comingUp(w, t, [bedAt(w, t.px, t.py, "berry")], skies(w, v.sky, draws))[0] * 2 > K;
        sown.push({ agent: a.id, key: e.key, t: e.t, now: e.now, worked: up, testing: testing.includes(a.id) });
      }
    });
    if (!sowing && w.t % 12 === 6) w.agents.forEach((a, i) => {
      const now = conditionsNow(w, a, way.verb, a, way.inputs), ok = catchesNow(w, a, ways[0]);
      bump(cases[i], now, ok);
      if (change && w.t >= half) bump(after[i], now, ok);
    });
    if (sowing && w.t % 48 === 6) {
      const weathers = skies(w, v.sky, draws);
      w.agents.forEach((a, i) => {
        const spots = plotSpots[i].filter((s) => !occupied(w, s.px, s.py)), up = comingUp(w, ps[i], spots.map((s) => bedAt(w, s.px, s.py, "berry")), weathers);
        spots.forEach((s, j) => bump(cases[i], conditionsNow(w, a, "plant", s), up[j] * 2 > K));
      });
    }
    for (const a of w.agents) note(a);
    changed.clear(); removed.clear(); newKinds.clear(); trailChanges.clear();
    if (w.t % 4 === 0) await Bun.sleep(0);
    if (brainKind() !== "random") for (;;) { await Bun.sleep(asking() ? 10 : 0); if (!asking()) { await Bun.sleep(0); if (!asking()) break; } }
  }
  for (const a of w.agents) note(a, true);

  // what they did, by thirds of the run, tests aside: tries at a fire, which failed just where the formulas say it can't
  // work, or plantings as they went in, by what the formulas say comes of them
  const tries = (sowing ? sown : attempts).filter((x) => !x.testing);
  const third = (k: 0 | 2) => tries.filter((x) => (k === 0 ? x.t < begin + (end - begin) / 3 : x.t >= begin + ((end - begin) * 2) / 3));
  const share = (xs: Attempt[], ok: (x: Attempt) => boolean) => (xs.length ? xs.filter(ok).length / xs.length : null);
  const n = w.agents.length, day = (t: number) => (t - begin) / DAY, avg = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);
  // their theories as they stood at a time
  const at = (a: Agent, t: number) => states.get(a.id)!.filter((s) => s.t <= t).at(-1)!.bs;
  const metrics: Record<string, number | null> = {};
  // how far the cases' own tries agree with what most tries there would do: 1 where every condition it's staged in
  // decides it
  const all = cases.flatMap((m) => [...m.values()]), sum = all.reduce((s, c) => s + c.n, 0);
  if (sum) Object.assign(truth, { pure: Math.round((all.reduce((s, c) => s + Math.max(c.ok, c.n - c.ok), 0) / sum) * 1000) / 1000, fails: Math.round((all.reduce((s, c) => s + c.n - c.ok, 0) / sum) * 100) / 100 });
  if (probe === "choose") {
    const worse = Math.max(...ways.map((k) => ticks[k])), lost = (x: Attempt) => Math.min(ticks[x.key], worse) - ticks[best];
    Object.assign(metrics, {
      best: share(third(2), (x) => x.key === best),
      first: share(w.agents.flatMap((a) => tries.filter((x) => x.agent === a.id).slice(0, 5)), (x) => x.key === best),
      regret: tries.length ? tries.reduce((s, x) => s + lost(x), 0) / tries.length : null,
    });
  } else {
    // every case each person met, judged as the formulas have it, from the change on where something changes halfway
    const judged = (change ? after : cases).map((m) => [...m.values()]);
    const ends = w.agents.map((a, i) => judge(at(a, end), judged[i])), mids = w.agents.map((a, i) => judge(at(a, half), judged[i]));
    const failing = judged.some((cs) => cs.some((c) => c.ok * 2 < c.n));
    // whose theories rule it out wherever it mostly fails, and whose somewhere it mostly works
    const knows = (j: Judged) => !!j && j.missed === 0, overcautious = (j: Judged) => !!j && j.over > 0;
    const causes = change?.causes ?? v.causes, wasted = (x: Attempt) => !x.worked;
    Object.assign(metrics, {
      right: failing ? ends.filter(knows).length / n : null,
      wasted: share(third(2), wasted),
      acc: avg(ends.flatMap((j) => (j ? [j.acc] : []))),
      ...(change ? {} : {
        accMid: avg(mids.flatMap((j) => (j ? [j.acc] : []))),
        needless: avg(ends.flatMap((j) => (j ? [j.needless] : []))),
        needlessMid: avg(mids.flatMap((j) => (j ? [j.needless] : []))),
        blind: avg(ends.flatMap((j) => (j ? [j.blind] : []))),
      }),
    });
    // what the evidence would support (EVIDENCE): each person's own tries since the change, if any, all they saw the
    // outcome of, and whether they show every staged cause doing worse than its absence beyond chance
    if (probe !== "spread") {
      const from = change ? half : begin;
      const shows = (xs: Attempt[], t: string) => {
        const inn = xs.filter((x) => holds(t, x.now)), out = xs.filter((x) => !holds(t, x.now));
        if (inn.length < 2 || !out.length) return false;
        const wi = inn.filter((x) => x.worked).length, wo = out.filter((x) => x.worked).length, p = (wi + wo) / xs.length;
        const se = Math.sqrt(p * (1 - p) * (1 / inn.length + 1 / out.length));
        return se > 0 && (wo / out.length - wi / inn.length) / se > 1.645;
      };
      const evident = w.agents.flatMap((a, i) => {
        const xs = attempts.filter((x) => x.agent === a.id && x.t >= from);
        return causes.every((t) => shows(xs, t)) ? [i] : [];
      });
      Object.assign(metrics, { evident: evident.length / n, caught: evident.length ? evident.filter((i) => knows(ends[i])).length / evident.length : null });
    }
    // days from a time until each person's theories first rule it out wherever it truly fails, the rest of the run if
    // they never do
    const until = (from: number) => w.agents.reduce((s, a, i) => s + day(states.get(a.id)!.find((x) => x.t >= from && knows(judge(x.bs, judged[i])))?.t ?? end) - day(from), 0) / n;
    // ruling out some of where it fails, but not all of it
    const failingKeys = (i: number) => judged[i].filter((c) => c.ok * 2 < c.n).length;
    if (change) {
      const old = change.old, blamed = w.agents.filter((a) => names(at(a, half), old));
      Object.assign(metrics, {
        kept: w.agents.filter((a) => names(at(a, end), old)).length / n,
        retried: blamed.length ? blamed.filter((a) => attempts.some((x) => x.agent === a.id && x.t >= half && x.worked && x.now.includes(old))).length / blamed.length : null,
        found: until(half),
      });
    } else if (probe === "spread") {
      const told = v.starts?.flat().find((c) => c && !v.causes.includes(c)), newcomers = w.agents.filter((a) => fresh.includes(a.id));
      Object.assign(metrics, {
        wrong: told ? w.agents.filter((a) => names(at(a, end), told)).length / n : null,
        learned: newcomers.length ? newcomers.filter((a) => ways.some((k) => a.beliefs[k])).length / newcomers.length : null,
      });
    } else Object.assign(metrics, {
      wrong: ends.filter(overcautious).length / n,
      exact: failing ? ends.filter((j) => knows(j) && !overcautious(j)).length / n : null,
      wastedEarly: share(third(0), wasted),
      formed: failing ? until(begin) : null,
      ...(sowing
        ? { weather: w.agents.filter((a) => at(a, end).some((b) => b.unless?.some((t) => t.split("+").some((c) => !c.startsWith("!") && !ofPlace(c))))).length / n }
        : !sowing && v.bystander ? { bystander: w.agents.filter((a) => names(at(a, end), v.bystander!)).length / n } : {}),
      ...(v.causes.length > 1 ? { partly: ends.filter((j, i) => !!j && j.missed > 0 && j.missed < failingKeys(i)).length / n } : {}),
    });
    // for planters who start out blaming something: those who still blame what they were wrong about, and of those who
    // started out not blaming the true cause, those whose theories came to rule it out
    if (sowing && v.starts) {
      const told = [...new Set(v.starts.flat())].filter((c) => !v.causes.includes(c));
      const unaware = w.agents.flatMap((_, i) => (v.starts?.[i]?.some((c) => v.causes.includes(c)) ? [] : [i]));
      Object.assign(metrics, {
        ...(told.length ? { kept: w.agents.filter((a) => told.some((c) => names(at(a, end), c))).length / n } : {}),
        ...(unaware.length < n ? { heard: unaware.length ? unaware.filter((i) => knows(ends[i])).length / unaware.length : null } : {}),
      });
    }
  }
  hooks.weather = hooks.options = undefined;
  traceListeners.splice(traceListeners.indexOf(listen), 1);
  return { probe, variant, seed, brain, days, people: n, secs: Math.round((performance.now() - t0) / 1000), attempts: attempts.length, jev: { calls: w.jev.calls, tokens: w.jev.tokens }, truth, metrics };
}

if (import.meta.main) {
  const arg = (name: string, d: string) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : d; };
  const brain = arg("brain", "random"), batch = arg("batch", "");
  if (brain !== "random" && brain !== "jev") throw new Error(`--brain ${brain}: random or jev`);
  const specs: ProbeSpec[] = batch
    ? JSON.parse(readFileSync(batch, "utf8"))
    : [{ probe: arg("probe", "blame"), variant: arg("variant", "real"), seed: Number(arg("seed", "1")), days: Number(arg("days", "6")), people: Number(arg("people", "6")), brain, out: arg("out", "") }];
  for (const s of specs) {
    const r = await runProbe(s.probe, s.variant, s.seed, s.days, s.people, s.brain);
    if (s.out) await Bun.write(s.out, JSON.stringify(r) + "\n");
    else console.log(JSON.stringify(r));
  }
  process.exit(0);
}
