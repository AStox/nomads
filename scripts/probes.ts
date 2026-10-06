// Learning probes: small staged worlds where we set what's true, so the best anyone could do is known exactly, run to
// see whether people come to it and how fast. A few people stand on open ground in summer for days, wanting a fire and
// holding what it takes; each fire is cleared away as soon as it catches, so they keep making them; the probe sets the
// weather by the hour; and they weigh only lighting a fire, resting in the dark, and putting a theory of theirs to the
// test. Nothing they try comes off or fails by chance (physics.ts): a try fails just where the probe's cause holds, so
// what they come to think can be held against the truth hour by hour, at the midpoint and at the end. Each probe runs in
// the world as it is and in a flipped one, where the rule is otherwise (the wind kills sparks instead of the rain): a
// learner with the answer written in passes one and fails the other. The planting probes do the same with seed in place
// of fire: each person on a plot of their own with a tree's shade over part of it and a bush crowding another, a berry
// coming to hand every few hours (or once a day, sparse), and every seed put where the probe's cause holds withering two
// days later, every other coming up.
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
import { fieldsOf, groundKey, holds, ofPlace, ruledOut, type Belief } from "../src/sim/beliefs";
import { RULES, hooks } from "../src/sim/rules";
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
// quench: what truly keeps sparks from catching, any of them (rules.ts RULES.quench: a condition, or several joined by
// "+" that do only together, "!" before one for its lack); then: what does from halfway on; bystander: what comes with
// the cause and doesn't matter; starts: by person, the theories they start out with, or null for someone who doesn't
// know how at all; talk: they may also teach and talk
type Setup = {
  quench: string[]; then?: string[]; bystander?: string; tell: boolean; sparks: "harder" | "softer"; ways: string[]; sky: Sky;
  starts?: (string[] | null)[]; talk?: boolean;
};
// The planting probes': withers: the kinds of spot (sim.ts CONDITIONS: shade, crowded), any of them, a seedling put in
// never comes up in, every other coming up; every: how often a berry comes to hand for a planter who has none; starts:
// by person, what they start out blaming for seedlings that never come up (none, for most); talk: they may also teach
// and talk
type Sow = { withers: string[]; sky: Sky; every: number; starts?: string[][]; talk?: boolean };
// days: how long it runs, whatever the run asks (scripts/evals.ts asks the same of every probe), for a probe whose
// outcomes take days to show or whose cause comes seldom
type Probe = { text: string; metrics: Record<string, Metric>; claims: Claim[]; variants: Record<string, Setup | Sow>; days?: number };

const fair: Sky = () => ({ rain: 0, wind: 0 });
const changeable: Sky = () => ({ rain: 0.35, wind: 0.35 });
const nightRain: Sky = (dark) => ({ rain: dark ? 0.7 : 0.05, wind: 0 });
const rareWind: Sky = () => ({ rain: 0.35, wind: 0.08 });
const rareRain: Sky = () => ({ rain: 0.08, wind: 0.35 });

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
      // flint lights a fire sooner
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
      CAUGHT,
      ...TREND,
    ],
    variants: {
      real: { quench: ["rain"], tell: true, sparks: "harder", ways: [STONE], sky: changeable },
      flipped: { quench: ["wind"], tell: true, sparks: "harder", ways: [STONE], sky: changeable },
    },
  },
  confounded: {
    text: "The rain falls mostly at night and only one of the two kills sparks, which nothing they see says: do they tell which?",
    days: 10,
    metrics: { ...CAUSE, bystander: { better: "lower", tol: 0.1, text: "share of people who end up blaming the other of the two" } },
    claims: [
      { id: "cause", text: "more blame the true cause than the one that comes with it", gap: ["right", "bystander"], value: 0 },
      { id: "most", text: "nearly everyone comes to blame the true cause (more than 85%)", above: "right", value: 0.85 },
      { id: "few-bystanders", text: "fewer than one in four also blame the one that only comes with it", below: "bystander", value: 0.25 },
      CAUGHT,
      ...TREND,
    ],
    variants: {
      real: { quench: ["rain"], bystander: "dark", tell: false, sparks: "harder", ways: [STONE], sky: nightRain },
      flipped: { quench: ["dark"], bystander: "rain", tell: false, sparks: "harder", ways: [STONE], sky: nightRain },
    },
  },
  // Nothing in the world changes its rules; this one does, to see that people who never let go of a failure still try
  // again where it used to fail, and find what fails now.
  recover: {
    text: "What kills sparks changes halfway: do those who blamed the old cause try it there again and see it work, and do they find the new one?",
    days: 10,
    metrics: {
      right: { better: "higher", tol: 0.1, text: "share of people whose theories rule it out wherever the new cause holds" },
      retried: { better: "higher", tol: 0.1, text: "of those who blamed the old cause at the change, the share who tried it there again and saw it work" },
      kept: { better: "lower", tol: 1, text: "share of people who end up still blaming the old cause (not judged: people who never forget a try keep the failures they saw there)" },
      wasted: CAUSE.wasted,
      found: { better: "lower", tol: 0.5, text: "days from the change until each first rules it out wherever the new cause holds" },
      acc: { ...TRUTH.acc, tol: 1, text: `${TRUTH.acc.text} (not judged, as kept)` },
      ...EVIDENCE,
    },
    claims: [
      { id: "retry", text: "nearly all who blamed the old cause try it there again after the change and see it work (more than 75%)", above: "retried", value: 0.75 },
      { id: "find", text: "at least two in three come to blame the new cause", above: "right", value: 0.65 },
      CAUGHT,
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
      ...TRUTH,
    },
    claims: [
      { id: "truth-wins", text: "more end up blaming the true cause than the false one", gap: ["right", "wrong"], value: 0 },
      { id: "error-fades", text: "fewer than half end up with the false one", below: "wrong", value: 0.5 },
      ...TREND,
    ],
    variants: {
      real: { quench: ["rain"], tell: true, sparks: "harder", ways: [STONE], sky: changeable, starts: [["rain"], ["rain"], ["dark"], ["dark"], null, null], talk: true },
      flipped: { quench: ["dark"], tell: true, sparks: "harder", ways: [STONE], sky: changeable, starts: [["dark"], ["dark"], ["rain"], ["rain"], null, null], talk: true },
    },
  },
  // The second round: what the first five don't reach. (Its probe of bad luck alone went with the luck: nothing fails
  // now without a cause.)
  two: {
    text: "Two kinds of weather each kill sparks: do they come to blame both, or stop at the first?",
    metrics: { ...CAUSE, partly: { better: "lower", tol: 0.1, text: "share of people whose theories rule it out where some of the causes hold but not all" } },
    claims: [
      { id: "both", text: "most come to blame both", above: "right", value: 0.5 },
      { id: "only", text: "more blame both than anything else", gap: ["right", "wrong"], value: 0 },
      CAUGHT,
      ...TREND,
    ],
    variants: {
      real: { quench: ["rain", "wind"], tell: true, sparks: "harder", ways: [STONE], sky: changeable },
      flipped: { quench: ["wind", "dark"], tell: true, sparks: "harder", ways: [STONE], sky: changeable },
    },
  },
  // The fourth round: a cause with an exception. To someone who doesn't see the exception, the weather only lowers the
  // odds, as the second round's half-strength cause did by luck; here a condition they can see decides it.
  except: {
    text: "Sparks die in one kind of weather unless another comes with it, and nothing they see says so: do they find the exception?",
    days: 10,
    metrics: CAUSE,
    claims: [
      { id: "exact", text: "most end up ruling it out just where it fails", above: "exact", value: 0.5 },
      CAUGHT,
      ...TREND,
    ],
    variants: {
      // the rain, unless the wind is up
      real: { quench: ["rain+!wind"], tell: false, sparks: "harder", ways: [STONE], sky: changeable },
      flipped: { quench: ["wind+!rain"], tell: false, sparks: "harder", ways: [STONE], sky: changeable },
    },
  },
  rare: {
    text: "What kills sparks comes only one hour in twelve, and nothing they see says so: do they come to blame it?",
    days: 10,
    metrics: CAUSE,
    claims: [
      { id: "most", text: "most come to blame it", above: "right", value: 0.5 },
      { id: "only", text: "more blame it than anything else", gap: ["right", "wrong"], value: 0 },
      CAUGHT,
      ...TREND,
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
    // a seedling shows two days after it goes in (SPROUT), and a planter with a berry a day sees twenty come up or not
    days: 20,
    metrics: {
      ...CAUSE,
      right: { ...CAUSE.right, text: "share of people whose theories rule out planting wherever seedlings truly never come up" },
      wasted: { ...CAUSE.wasted, text: "share of their last third of plantings (tests aside) made where nothing comes up" },
      wastedEarly: { ...CAUSE.wastedEarly, text: "share of their first third of plantings (tests aside) made where nothing comes up" },
      weather: { better: "lower", tol: 0.1, text: "share of people who end up blaming any weather for their plantings" },
    },
    claims: [
      { id: "most", text: "most come to blame the true cause", above: "right", value: 0.5 },
      { id: "only", text: "more blame the true cause than anything else", gap: ["right", "wrong"], value: 0 },
      { id: "less-waste", text: "fewer of their plantings go where nothing comes up late than early", gap: ["wastedEarly", "wasted"], value: 0 },
      { id: "not-weather", text: "fewer than one in four blame the weather", below: "weather", value: 0.25 },
      CAUGHT,
      ...TREND,
    ],
    variants: {
      // in the shade of trees, as in the world; a berry to plant every four hours, so a few plantings a day (with berries
      // in hand all the time, they plant thirty a day)
      real: { withers: ["shade"], sky: changeable, every: DAY / 6 },
      // crowded in among bushes, and the shade does no harm
      flipped: { withers: ["crowded"], sky: changeable, every: DAY / 6 },
      // as real, with a berry a day: nearer what a planter in a whole world goes on (one to a dozen seen to come up or not
      // in sixty days)
      sparse: { withers: ["shade"], sky: changeable, every: DAY },
      // as sparse, where both the shade and crowding wither them: a failure in the one stands out less from the rest, as
      // on the islands where whole worlds learned least
      two: { withers: ["shade", "crowded"], sky: changeable, every: DAY },
    },
  },
  // The third round: what passes between planters who all know how, and a false theory a planter starts out with.
  hearsay: {
    text: "Two planters already blame the kind of spot seedlings never come up in, and the rest know how to plant but not that: does it pass among them, beside what each sees for themselves?",
    days: 20,
    metrics: {
      right: { better: "higher", tol: 0.1, text: "share of people whose theories rule out planting wherever seedlings truly never come up" },
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
      real: { withers: ["shade"], sky: changeable, every: DAY, starts: [["shade"], ["shade"], [], [], [], []], talk: true },
      flipped: { withers: ["crowded"], sky: changeable, every: DAY, starts: [["crowded"], ["crowded"], [], [], [], []], talk: true },
    },
  },
  unlearn: {
    text: "Planters start out sure seedlings won't come up in one kind of weather, which is false, while a kind of spot is what withers them: do they let the false theory go, and find the true one?",
    days: 20,
    metrics: {
      ...CAUSE,
      right: { ...CAUSE.right, text: "share of people whose theories rule out planting wherever seedlings truly never come up" },
      kept: { better: "lower", tol: 0.1, text: "share of people who end up still blaming the weather they started out blaming" },
    },
    claims: [
      { id: "let-go", text: "fewer than three in ten keep the false theory they started with", below: "kept", value: 0.3 },
      { id: "most", text: "most come to blame the true cause", above: "right", value: 0.5 },
      CAUGHT,
      ...TREND,
    ],
    variants: {
      // a berry every four hours, as seed/real, so there is time enough to put the false theory to the test
      real: { withers: ["shade"], sky: changeable, every: DAY / 6, starts: [["rain"], ["rain"], ["rain"], ["rain"], ["rain"], ["rain"]] },
      flipped: { withers: ["crowded"], sky: changeable, every: DAY / 6, starts: [["wind"], ["wind"], ["wind"], ["wind"], ["wind"], ["wind"]] },
      // as real, with a berry a day: what planters in whole worlds go on, where a false theory about the weather was
      // never once tested (nobody plants in weather they blame, and a planting can't be watched coming up)
      sparse: { withers: ["shade"], sky: changeable, every: DAY, starts: [["rain"], ["rain"], ["rain"], ["rain"], ["rain"], ["rain"]] },
    },
  },
};

// Summer, a little after sunrise: no frost at night to muddy what they see.
const START = 12 * DAY + 6 * 12;
type Attempt = { agent: string; key: string; t: number; now: string[]; worked: boolean; testing: boolean };
// What holds in an hour (and, planting, at a spot), how often it came, and whether a try there would come off.
type Case = { now: string[]; works: boolean; n: number };
// Whether the probe's causes make it fail in conditions like these.
const fails = (causes: string[], now: string[]) => causes.some((t) => holds(t, now));
// What someone's theories of these ways would have them do over the cases (Case), each as often as it came: they'd
// hold back where every way they know is ruled out (beliefs.ts ruledOut). acc, needless and blind as TRUTH says; null
// for someone who knows no way.
type Judged = { acc: number; needless: number; blind: number } | null;
function judge(bs: Belief[], cases: Case[]): Judged {
  if (!bs.length) return null;
  let all = 0, needless = 0, blind = 0;
  for (const c of cases) {
    const out = bs.every((b) => ruledOut(b, c.now));
    all += c.n;
    if (out && c.works) needless += c.n;
    if (!out && !c.works) blind += c.n;
  }
  return all ? { acc: 1 - (needless + blind) / all, needless: needless / all, blind: blind / all } : null;
}
// Whether any of their theories names a condition, as one that has to hold for it.
const names = (bs: Belief[], c: string) => bs.some((b) => b.unless?.some((t) => t.split("+").includes(c)));

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
  else Object.assign(RULES, { quench: v.quench, tell: v.tell, sparks: v.sparks, learning: "seen" });
  const [cx, cy] = openGround(w, w.agents[0].px, w.agents[0].py);
  const fresh: string[] = [];
  const truth: Record<string, string | number> = {};
  const ps = sowing ? plots(w, { px: cx, py: cy }, w.agents.length) : [];
  if (sowing) {
    // each on a plot of their own, facing east to start, nothing in hand, knowing that a berry pushed into the ground
    // comes up (one did for them, on the ground of their plot), and blaming what the probe says they start out blaming
    w.agents.forEach((a, i) => {
      put(w, a, ps[i].px, ps[i].py);
      a.heading = 0; a.home = null; a.goal = null; a.plan = []; a.inv = [];
      const start = v.starts?.[i] ?? [];
      a.beliefs = { [PLANT]: { ...knownWay(PLANT, w.t), when: { [groundKey(groundWord(w, a.px, a.py))]: { tries: 1, wins: 1 } }, ...(start.length ? { unless: [...start] } : {}) } };
    });
    // of the spots a seed could go into round where they stand, the share where nothing comes up; and the kinds of ground
    // they know of to plant on (one, unless the island has nowhere so)
    const spots = ps.flatMap(ring).filter((s) => !occupied(w, s.px, s.py));
    const lost = spots.filter((s) => fails(v.withers, conditionsNow(w, w.agents[0], "plant", s))).length / spots.length;
    Object.assign(truth, { withers: v.withers.join(" or "), spots: Math.round(lost * 100) / 100, grounds: groundsSeen(w, ps).size });
  } else {
    w.agents.forEach((a, i) => {
      put(w, a, cx + (Math.cos(i) * 2) / TILE_M, cy + (Math.sin(i) * 2) / TILE_M);
      a.home = null; a.goal = null; a.plan = [];
      const start = v.starts?.[i];
      a.beliefs = start === null ? {} : Object.fromEntries(v.ways.map((key) => [key, start?.length ? { ...knownWay(key, w.t), unless: [...start] } : knownWay(key, w.t)]));
      if (start === null) fresh.push(a.id);
    });
    Object.assign(truth, { quench: v.quench.join(" or ") || "none", ...(v.then ? { then: v.then.join(" or ") } : {}) });
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
  const aim = sowing ? "plant" : "make_fire", talk = !!v.talk;
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

  // what they did (a try at a fire, judged at once; a planting, when it went in, whatever came of it)
  const attempts: Attempt[] = [];
  traceListeners.push((e) => {
    if (e.sys !== "theory" || e.kind !== "attempt" || !e.agent || sowing) return;
    const d = e.data as { key: string; now?: string[]; worked?: boolean; testing?: boolean };
    if (ways.includes(d.key)) attempts.push({ agent: e.agent, key: d.key, t: e.t, now: d.now ?? [], worked: !!d.worked, testing: !!d.testing });
  });
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
  // the hours as they came, each hour once its weather has turned: what holds for someone trying here (for a fire) or,
  // planting, at each spot of their plot
  const hours = new Map<string, number>(), plotSpots = sowing ? w.agents.map((_, i) => ring(ps[i]).filter((s) => !occupied(w, s.px, s.py))) : [];
  const atSpots: Map<string, number>[] = w.agents.map(() => new Map());
  const bump = (m: Map<string, number>, now: string[]) => { const k = [...now].sort().join("+"); m.set(k, (m.get(k) ?? 0) + 1); };
  const begin = w.t, end = begin + days * DAY, half = begin + Math.floor((days * DAY) / 2);
  while (w.t < end) {
    if (w.t === half) {
      if (!sowing && v.then) RULES.quench = v.then;
      for (const a of w.agents) note(a, true);
    }
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
        const up = !fails(v.withers, e.now);
        fates.set(e.thing, { up, t: e.t });
        attempts.push({ agent: a.id, key: e.key, t: e.t, now: e.now, worked: up, testing: testing.includes(a.id) });
      }
      for (const id of grown.splice(0)) { const t = thingById(w, id); if (t) removeThing(w, t); }
    }
    if (w.t % 12 === 6) {
      if (sowing) w.agents.forEach((a, i) => { for (const s of plotSpots[i]) bump(atSpots[i], conditionsNow(w, a, "plant", s)); });
      else bump(hours, conditionsNow(w, w.agents[0], "strike"));
    }
    for (const a of w.agents) note(a);
    changed.clear(); removed.clear(); newKinds.clear(); trailChanges.clear();
    if (w.t % 4 === 0) await Bun.sleep(0);
    if (brainKind() !== "random") for (;;) { await Bun.sleep(asking() ? 10 : 0); if (!asking()) { await Bun.sleep(0); if (!asking()) break; } }
  }
  for (const a of w.agents) note(a, true);

  // what they did, by thirds of the run, tests aside
  const tries = attempts.filter((x) => !x.testing);
  const third = (k: 0 | 2) => tries.filter((x) => (k === 0 ? x.t < begin + (end - begin) / 3 : x.t >= begin + ((end - begin) * 2) / 3));
  const share = (xs: Attempt[], ok: (x: Attempt) => boolean) => (xs.length ? xs.filter(ok).length / xs.length : null);
  const n = w.agents.length, day = (t: number) => (t - begin) / DAY, avg = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);
  // their theories as they stood at a time
  const at = (a: Agent, t: number) => states.get(a.id)!.filter((s) => s.t <= t).at(-1)!.bs;
  const metrics: Record<string, number | null> = {};
  if (probe === "choose") {
    const worse = Math.max(...ways.map((k) => ticks[k])), lost = (x: Attempt) => Math.min(ticks[x.key], worse) - ticks[best];
    Object.assign(metrics, {
      best: share(third(2), (x) => x.key === best),
      first: share(w.agents.flatMap((a) => tries.filter((x) => x.agent === a.id).slice(0, 5)), (x) => x.key === best),
      regret: tries.length ? tries.reduce((s, x) => s + lost(x), 0) / tries.length : null,
    });
  } else {
    // what truly kills sparks by the end, or what seedlings never come up in, and every case each person met, judged by it
    const causes = sowing ? v.withers : v.then ?? v.quench, wasted = (x: Attempt) => fails(causes, x.now);
    const cases = w.agents.map((_, i) => [...(sowing ? atSpots[i] : hours)].map(([k, c]): Case => { const now = k ? k.split("+") : []; return { now, works: !fails(causes, now), n: c }; }));
    const ends = w.agents.map((a, i) => judge(at(a, end), cases[i])), mids = w.agents.map((a, i) => judge(at(a, half), cases[i]));
    const failing = cases.some((cs) => cs.some((c) => !c.works));
    // whose theories rule it out wherever it truly fails, and whose somewhere it would work
    const knows = (j: Judged) => !!j && j.blind === 0, overcautious = (j: Judged) => !!j && j.needless > 0;
    // the share of each person's cases where it can't work
    const failShare = (cs: Case[]) => cs.reduce((s, c) => s + (c.works ? 0 : c.n), 0) / cs.reduce((s, c) => s + c.n, 0);
    Object.assign(metrics, {
      right: failing ? ends.filter(knows).length / n : null,
      wasted: share(third(2), wasted),
      acc: avg(ends.flatMap((j) => (j ? [j.acc] : []))),
      ...(probe === "recover" ? {} : {
        accMid: avg(mids.flatMap((j) => (j ? [j.acc] : []))),
        needless: avg(ends.flatMap((j) => (j ? [j.needless] : []))),
        needlessMid: avg(mids.flatMap((j) => (j ? [j.needless] : []))),
        blind: avg(ends.flatMap((j) => (j ? [j.blind] : []))),
      }),
    });
    // what the evidence would support (EVIDENCE): each person's own tries since the cause last changed, all they saw the
    // outcome of, and whether they show every true cause doing worse than its absence beyond chance
    if (probe !== "spread") {
      const from = !sowing && v.then ? half : begin;
      const shows = (xs: Attempt[], t: string) => {
        const inn = xs.filter((x) => holds(t, x.now)), out = xs.filter((x) => !holds(t, x.now));
        if (inn.length < 2 || !out.length) return false;
        const wi = inn.filter((x) => x.worked).length, wo = out.filter((x) => x.worked).length, p = (wi + wo) / xs.length;
        const se = Math.sqrt(p * (1 - p) * (1 / inn.length + 1 / out.length));
        return se > 0 && (wo / out.length - wi / inn.length) / se > 1.645;
      };
      const evident = w.agents.flatMap((a, i) => {
        const xs = attempts.filter((x) => x.agent === a.id && x.t >= from && (!sowing || x.t + SPROUT <= end));
        return causes.every((t) => shows(xs, t)) ? [i] : [];
      });
      Object.assign(metrics, { evident: evident.length / n, caught: evident.length ? evident.filter((i) => knows(ends[i])).length / evident.length : null });
    }
    // days from a time until each person's theories first rule it out wherever it truly fails, the rest of the run if
    // they never do
    const until = (from: number) => w.agents.reduce((s, a, i) => s + day(states.get(a.id)!.find((x) => x.t >= from && knows(judge(x.bs, cases[i])))?.t ?? end) - day(from), 0) / n;
    if (!sowing && probe === "recover") {
      const old = w.agents.filter((a) => v.quench.some((c) => names(at(a, half), c)));
      Object.assign(metrics, {
        kept: w.agents.filter((a) => v.quench.some((c) => names(at(a, end), c))).length / n,
        retried: old.length ? old.filter((a) => attempts.some((x) => x.agent === a.id && x.t >= half && x.worked && fails(v.quench, x.now))).length / old.length : null,
        found: until(half),
      });
    } else if (!sowing && probe === "spread") {
      const told = v.starts?.flat().find((c) => c && !causes.includes(c)), newcomers = w.agents.filter((a) => fresh.includes(a.id));
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
        : v.bystander ? { bystander: w.agents.filter((a) => names(at(a, end), v.bystander!)).length / n } : {}),
      // ruling out some of where it fails, but not all of it
      ...(causes.length > 1 ? { partly: ends.filter((j, i) => !!j && j.blind > 0 && j.blind < failShare(cases[i])).length / n } : {}),
    });
    // for planters who start out blaming something: those who still blame what they were wrong about, and of those who
    // started out not blaming the true cause, those whose theories came to rule it out
    if (sowing && v.starts) {
      const told = [...new Set(v.starts.flat())].filter((c) => !causes.includes(c));
      const unaware = w.agents.flatMap((_, i) => (v.starts?.[i]?.some((c) => causes.includes(c)) ? [] : [i]));
      Object.assign(metrics, {
        ...(told.length ? { kept: w.agents.filter((a) => told.some((c) => names(at(a, end), c))).length / n } : {}),
        ...(unaware.length < n ? { heard: unaware.length ? unaware.filter((i) => knows(ends[i])).length / unaware.length : null } : {}),
      });
    }
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
