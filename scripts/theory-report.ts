// Pools theory runs (scripts/theories.ts) and scores, over the days, what people believed and chose against the answer
// key (scripts/answer-key.ts): what trying each way of doing things on the island found hurts it, and how long it takes.
// Over the days: how often what they did worked; how often they did it in a condition that truly hurts it ("wasted",
// plantings judged as they went in); how long it took; the theories they held (right: it names a condition that truly
// hurts; wrong: one that doesn't) and how many were formed again after being dropped; whether, of the ways they knew to
// an end, they used the quickest in the conditions they were in, and how much quicker the best way the island has would
// have been; how good the spots they planted in were; and the tests they made. --json adds the numbers scripts/evals.ts
// compares builds by, over the first and the last third of the runs' days.
//   bun scripts/theory-report.ts /tmp/theories/new --key key.json [--evidence /tmp/theories/seen] [--json out.json]
// --evidence: the runs whose tries say what could be learned on the island (below), when not the runs scored: the real
// people's, for a world where everyone knew from the start.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { DAY } from "../src/sim/world";
import { expectedTicks, loadKey, verdict } from "./answer-key";
import type { Tally, Verdict, Way } from "./answer-key";

type Line = {
  ev: string; t: number; agent?: string; key?: string; verb?: string; now?: string[]; worked?: boolean; cond?: string; conds?: string[];
  how?: string; alive?: number; day?: number; done?: number; took?: number; testing?: boolean; aim?: string; alts?: string[]; goal?: string;
  chosen?: boolean;
};
const BUCKET = 10;
const argv = process.argv.slice(2);
const opt = (name: string) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : null; };
const dir = argv[0] ?? "/tmp/theories", jsonOut = opt("json"), keyPath = opt("key"), evidenceDir = opt("evidence");
if (!keyPath) throw new Error("--key key.json: the answer key to score against (scripts/truth.ts writes it)");
const answers = loadKey(keyPath);
const jsonl = <T>(path: string) => readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as T);
const load = (from: string) => readdirSync(from).filter((f) => f.endsWith(".jsonl")).map((f) => ({ run: f.replace(/\.jsonl$/, ""), lines: jsonl<Line>(`${from}/${f}`) }));
const runs = load(dir);

// ---------- the answer key ----------
type Count = { n: number; wins: number };
const tally = (): Count => ({ n: 0, wins: 0 });
const count = (t: Count, won: boolean) => { t.n++; if (won) t.wins++; };
const VERDICTS: Verdict[] = ["hurts", "no effect", "unclear"];
const byVerdict = () => ({ hurts: 0, "no effect": 0, unclear: 0 }) as Record<Verdict, number>;
// A way the key judged: tried on the island, in and out of its conditions, and not one it couldn't try.
function judged(key: string): Way | undefined {
  const w = answers.ways[key];
  return w && !w.why && w.all.n > 0 && Object.keys(w.conds).length ? w : undefined;
}
// The odds of a way working in these conditions by the key, weighed as expectedTicks weighs them: by the worst of the
// conditions it was tried in that hold, and by all its tries where none do.
function oddsIn(way: Way, now: string[]) {
  const tried = now.map((c) => way.conds[c]?.in).filter((t): t is Tally => !!t && t.n > 0);
  return tried.length ? Math.min(...tried.map((t) => t.wins / t.n)) : way.all.wins / way.all.n;
}
// Every way the key judged, by what it's for and where it's done: what someone might have found to do instead. A way
// with no aim named has nothing to stand in for it.
const island = new Map<string, Way[]>();
for (const key of Object.keys(answers.ways)) {
  const w = judged(key);
  if (w?.aim) (island.get(`${w.aim}|${w.at}`) ?? island.set(`${w.aim}|${w.at}`, []).get(`${w.aim}|${w.at}`)!).push(w);
}
// How many ticks the quickest way to the same end, at the same place, would have saved over the one chosen, in the
// conditions it was chosen in, trying again until it worked: of the other ways they knew (choice; best when within a
// tenth of the quickest), and of every way the key knows, whether they knew it or not (discovery). Building onto their
// home isn't the same as putting up a new pile, so only ways done at the same place count. A way that would take more
// than a day of trying counts as a day: one that never works in those conditions would otherwise count as fifty tries,
// and one such choice would swamp everything else people chose.
function regrets(l: Line) {
  const mine = judged(l.key!), now = l.now ?? [];
  if (!mine) return null;
  const ticks = (way: Way) => Math.min(expectedTicks(way, now), DAY), e = ticks(mine), where = l.key!.split("|")[4];
  const known = (l.alts ?? []).filter((k) => k !== l.key && k.split("|")[4] === where).map(judged).filter((w): w is Way => !!w).map(ticks);
  const least = Math.min(e, ...known), found = Math.min(e, ...(island.get(`${mine.aim}|${mine.at}`) ?? []).map(ticks));
  return { choice: known.length ? { regret: e - least, best: e <= least * 1.1 } : null, discovery: e - found };
}

// What could be learned on the island: a way done in a condition at least twice (tries whose outcome showed, tests among
// them) by someone in the runs, or in the --evidence runs. A true theory counts as right only for that: one that names
// a way nobody there did in that condition, or did at all, is nothing learning could have come to, though someone who
// knew from the start holds it. All of them, judged or not, make rightAll.
const EVIDENCE = 2;
const tried = new Map<string, number>();
for (const r of evidenceDir ? load(evidenceDir) : runs) for (const l of r.lines) {
  if (l.ev !== "attempt" || !l.key) continue;
  for (const c of l.now ?? []) tried.set(`${l.key}#${c}`, (tried.get(`${l.key}#${c}`) ?? 0) + 1);
}

// ---------- over the days ----------
// Each run's own days, 1 on: its first day ends DAY ticks after it starts, and the daily lines (held, day) are written
// at a day's last moment.
const dayIn = (start: number, t: number) => Math.max(1, Math.ceil((t - start) / DAY));
const bucket = (day: number) => Math.floor((day - 1) / BUCKET);
type Row = {
  // what shows at once (everything but planting and watering), tests left out: attempts, how many worked, how many were
  // done in a condition that truly hurts them, and the ticks they took (of those that noted it)
  attempts: number; wins: number; wasted: number; took: number; timed: number; agentDays: number;
  // tries made to see whether a theory holds, all of them, planting too
  tests: number;
  held: Record<Verdict, number>; formed: Record<Verdict, number>; dropped: Record<Verdict, number>;
  reformed: number; // theories formed again by someone who had dropped them
  offered: number; tested: number;
  // attempts (tests left out) at something they knew another way to: how many used the quickest, and the ticks they
  // gave up against it, summed; and the ticks given up against the quickest way on the island, over attempts at a way
  // the key judged
  chose: number; best: number; regret: number; found: number; discovery: number;
  // plantings: how many showed, how many came up, and the odds of the spots chosen by the key, summed
  planted: number; came: number; spot: number;
  grounds: Record<string, number>;
  // plantings as they went in (runs that note them), whether or not they ever showed: how many, the odds of the spots
  // chosen, how many went into the shade or in among bushes and trees, and how many into a condition that truly hurts
  sown: number; sownSpot: number; sownShade: number; sownCrowded: number; sownHurt: number;
  // person-days holding the lessons that matter most: berries won't come up in the shade, or crowded in among bushes
  // and trees; fire won't light in the rain
  lessons: Record<string, number>;
};
// what a way is for, by the key or as the runs noted it
const aims = new Map<string, string>();
for (const r of runs) for (const l of r.lines) if (l.ev === "attempt" && l.key && l.aim) aims.set(l.key, l.aim);
const LESSONS: Record<string, (key: string, cond: string) => boolean> = {
  shade: (key, cond) => key.startsWith("plant|") && cond === "shade",
  crowded: (key, cond) => key.startsWith("plant|") && cond === "crowded",
  "rain-fire": (key, cond) => cond === "rain" && (answers.ways[key]?.aim ?? aims.get(key)) === "fire",
};
const rows: Row[] = [];
const row = (b: number) => (rows[b] ??= {
  attempts: 0, wins: 0, wasted: 0, took: 0, timed: 0, agentDays: 0, tests: 0, held: byVerdict(), formed: byVerdict(), dropped: byVerdict(), reformed: 0,
  offered: 0, tested: 0, chose: 0, best: 0, regret: 0, found: 0, discovery: 0, planted: 0, came: 0, spot: 0, grounds: {},
  sown: 0, sownSpot: 0, sownShade: 0, sownCrowded: 0, sownHurt: 0, lessons: {},
});
// The first and the last third of each run's days, pooled over the runs, for scripts/evals.ts. attempts and wins are of
// what shows at once; tries and wasted take in plantings too, as they went in; right is of what could be learned there,
// rightAll of every true theory held.
type Part = {
  attempts: number; wins: number; tries: number; wasted: number; agentDays: number; right: number; rightAll: number; wrong: number;
  chose: number; regret: number; found: number; discovery: number; formed: number; reformed: number; all: number; judged: number;
};
const part = (): Part => ({ attempts: 0, wins: 0, tries: 0, wasted: 0, agentDays: 0, right: 0, rightAll: 0, wrong: 0, chose: 0, regret: 0, found: 0, discovery: 0, formed: 0, reformed: 0, all: 0, judged: 0 });
const parts = { early: part(), late: part() };
// each person's k-th try at a thing: did it work, and was it done in a condition that hurts it
const curve: { n: number; wins: number; wasted: number }[] = [];
// each kind of doing (plant, rub, strike...) over the days
const verbs: Record<string, Count[]> = {};
const lives = new Map<string, { t: number; v: Verdict }>();
const lifetimes: Record<Verdict, number[]> = { hurts: [], "no effect": [], unclear: [] };
const dropHow: Record<string, Record<Verdict, number>> = {};
// theories formed again after being dropped, pooled over who formed them: how often, and by how many people
const churned = new Map<string, { again: number; people: Set<string> }>();
let attemptsAll = 0, attemptsJudged = 0;
const seenWays = new Set<string>();
for (const r of runs) {
  const daily = r.lines.filter((l) => l.ev === "day"), end = r.lines.at(-1)?.t ?? 0;
  const start = daily.length ? daily[0].t - DAY * (daily[0].day ?? 1) : 0, days = Math.max(0, ...daily.map((l) => l.day ?? 0));
  const third = (day: number) => (day <= days / 3 ? parts.early : day > (2 * days) / 3 ? parts.late : null);
  const attempts = r.lines.filter((l) => l.ev === "attempt" && l.key).sort((a, b) => (a.done ?? a.t) - (b.done ?? b.t));
  const nth = new Map<string, number>();
  for (const l of attempts) {
    const key = l.key!, now = l.now ?? [], day = dayIn(start, l.done ?? l.t), b = bucket(day), x = row(b), k = third(day);
    const later = l.verb === "plant" || l.verb === "pour", known = !!judged(key);
    attemptsAll++; seenWays.add(key);
    if (known) attemptsJudged++;
    if (k) { k.all++; if (known) k.judged++; }
    if (l.testing) { x.tests++; continue; }
    // what was chosen is scored whether or not it has shown yet
    const g = regrets(l);
    if (g) {
      x.found++; x.discovery += g.discovery;
      if (k) { k.found++; k.discovery += g.discovery; }
      if (g.choice) {
        x.chose++; x.regret += g.choice.regret; if (g.choice.best) x.best++;
        if (k) { k.chose++; k.regret += g.choice.regret; }
      }
    }
    // a planting shows within 30 days or is given up on: one done later than that before the end hasn't all shown, and
    // what has is mostly what withered fast
    if (later && (l.done ?? l.t) > end - 30 * DAY) continue;
    const wasted = now.some((c) => verdict(answers, key, c) === "hurts");
    count(((verbs[l.verb ?? "?"] ??= [])[b] ??= tally()), !!l.worked);
    if (!later) {
      x.attempts++; if (l.worked) x.wins++; if (wasted) x.wasted++;
      if (l.took !== undefined) { x.took += l.took; x.timed++; }
      if (k) { k.attempts++; k.tries++; if (l.worked) k.wins++; if (wasted) k.wasted++; }
      const id = `${l.agent}|${key}`, i = (nth.get(id) ?? 0) + 1;
      nth.set(id, i);
      const c = (curve[Math.min(i, 30)] ??= { n: 0, wins: 0, wasted: 0 });
      c.n++; if (l.worked) c.wins++; if (wasted) c.wasted++;
    }
    if (l.verb === "plant") {
      const way = judged(key), ground = now.find((c) => c.startsWith("ground:")) ?? "?";
      x.planted++; if (l.worked) x.came++; if (way) x.spot += oddsIn(way, now);
      x.grounds[ground] = (x.grounds[ground] ?? 0) + 1;
    }
  }
  // What went into the ground (planted, or a seedling watered) is wasted if it went into a condition that truly hurts it,
  // whenever it showed or if it never did: each on the day it went in, by its attempt once it showed (which says whether
  // it was a test) or else as it was sown (runs that note it).
  const inGround = new Map<string, Line>();
  for (const l of r.lines) {
    if (l.ev !== "sown" && !(l.ev === "attempt" && (l.verb === "plant" || l.verb === "pour"))) continue;
    const id = `${l.agent}|${l.key}|${l.done ?? l.t}`;
    if (l.ev === "attempt" || !inGround.has(id)) inGround.set(id, l);
  }
  for (const l of inGround.values()) {
    const k = third(dayIn(start, l.done ?? l.t));
    if (!k || !l.key || l.testing) continue;
    k.tries++;
    if ((l.now ?? []).some((c) => verdict(answers, l.key!, c) === "hurts")) k.wasted++;
  }
  // each person each day counts once for each lesson they hold, however many ways of doing it it's about
  const learned = new Set<string>(), dropped = new Set<string>(), lastHeld = new Map<string, number>();
  for (const l of r.lines) {
    const day = dayIn(start, l.t), x = row(bucket(day)), k = third(day);
    if (l.ev === "held" && l.key && l.cond) {
      const v = verdict(answers, l.key, l.cond);
      x.held[v]++;
      lastHeld.set(`${r.run}|${l.agent}|${l.key}|${l.cond}`, l.t);
      if (k && v === "hurts") { k.rightAll++; if ((tried.get(`${l.key}#${l.cond}`) ?? 0) >= EVIDENCE) k.right++; }
      if (k && v === "no effect") k.wrong++;
      for (const [lesson, is] of Object.entries(LESSONS)) {
        const id = `${day}|${l.agent}|${lesson}`;
        if (!is(l.key, l.cond) || learned.has(id)) continue;
        learned.add(id);
        x.lessons[lesson] = (x.lessons[lesson] ?? 0) + 1;
      }
    }
    else if (l.ev === "day") { x.agentDays += l.alive ?? 0; if (k) k.agentDays += l.alive ?? 0; }
    else if (l.ev === "test") { x.offered++; if (l.chosen) x.tested++; }
    else if (l.ev === "sown" && l.key?.startsWith("plant|") && l.now) {
      const way = judged(l.key);
      x.sown++; if (way) x.sownSpot += oddsIn(way, l.now); if (l.now.includes("shade")) x.sownShade++; if (l.now.includes("crowded")) x.sownCrowded++;
      if (l.now.some((c) => verdict(answers, l.key!, c) === "hurts")) x.sownHurt++;
    }
    else if (l.ev === "formed" && l.key && l.cond) {
      const v = verdict(answers, l.key, l.cond), id = `${r.run}|${l.agent}|${l.key}|${l.cond}`, again = dropped.has(id);
      x.formed[v]++;
      if (k) { k.formed++; if (again) k.reformed++; }
      if (again) {
        x.reformed++;
        const c = churned.get(`${l.key}#${l.cond}`) ?? churned.set(`${l.key}#${l.cond}`, { again: 0, people: new Set() }).get(`${l.key}#${l.cond}`)!;
        c.again++; c.people.add(`${r.run}|${l.agent}`);
      }
      lives.set(id, { t: l.t, v });
    } else if (l.ev === "dropped" && l.key) for (const c of l.conds ?? []) {
      const v = verdict(answers, l.key, c), id = `${r.run}|${l.agent}|${l.key}|${c}`, born = lives.get(id);
      x.dropped[v]++;
      (dropHow[l.how ?? "?"] ??= byVerdict())[v]++;
      dropped.add(id);
      if (born) { lifetimes[born.v].push((l.t - born.t) / DAY); lives.delete(id); }
    }
  }
  // what nobody dropped lived as long as it was held (each day's end, by everyone alive who held it): to the end of the
  // run, or the last day its holder lived through, or not past the day it was formed if they died that same day
  for (const [id, born] of lives) if (id.startsWith(`${r.run}|`)) { lifetimes[born.v].push(Math.max(0, (lastHeld.get(id) ?? born.t) - born.t) / DAY); lives.delete(id); }
}

// ---------- before and after a theory ----------
// For each theory someone formed, their own attempts at that thing before it and after it (until they dropped it): how
// many were made in the condition it names, and how many worked. A right theory should take them out of the condition
// and raise what works; a wrong one takes them out of it for nothing.
type Side = { n: number; inCond: number; wins: number };
const side = (): Side => ({ n: 0, inCond: 0, wins: 0 });
const around_ = { hurts: { before: side(), after: side() }, "no effect": { before: side(), after: side() }, unclear: { before: side(), after: side() } } as Record<Verdict, { before: Side; after: Side }>;
for (const r of runs) {
  const mine = new Map<string, Line[]>();
  for (const l of r.lines) if (l.ev === "attempt" && l.key && l.agent) (mine.get(`${l.agent}|${l.key}`) ?? mine.set(`${l.agent}|${l.key}`, []).get(`${l.agent}|${l.key}`)!).push(l);
  const formed = r.lines.filter((l) => l.ev === "formed" && l.key && l.cond && l.agent);
  for (const f of formed) {
    const v = verdict(answers, f.key!, f.cond!), xs = mine.get(`${f.agent}|${f.key}`) ?? [];
    const end = r.lines.find((l) => l.ev === "dropped" && l.agent === f.agent && l.key === f.key && l.t > f.t && l.conds?.includes(f.cond!))?.t ?? Infinity;
    for (const l of xs) {
      const at = l.done ?? l.t, s = at < f.t ? around_[v].before : at < end ? around_[v].after : null;
      if (!s) continue;
      s.n++; if (l.now?.includes(f.cond!)) s.inCond++; if (l.worked) s.wins++;
    }
  }
}

// ---------- tell ----------
const pct = (a: number, b: number) => (b ? `${Math.round((100 * a) / b)}%` : "-");
const per = (a: number, b: number, digits = 0) => (b ? (a / b).toFixed(digits) : "-");
const days = (b: number) => `${String(b * BUCKET + 1).padStart(3)}-${String((b + 1) * BUCKET).padEnd(4)}`;
console.log(`${runs.length} runs, ${attemptsAll} attempts at ${seenWays.size} ways of doing things, ${pct(attemptsJudged, attemptsAll)} of them at a way the key judged`);
console.log(`answer key: seed ${answers.seed}, ${answers.days} days, ${answers.trials} trials, ${Object.keys(answers.ways).length} ways (${Object.keys(answers.ways).filter((k) => judged(k)).length} judged)`);
console.log("\nattempts, took, worked and wasted: what shows at once, tests left out; tests: tries made to see whether a theory holds");
console.log("again: theories formed that had been dropped by the same person before; best, regret: of the ways they knew to that end, how often they took");
console.log("the quickest, and the ticks given up against it; island: the ticks given up against the quickest way the key knows, known or not");
console.log("planted and came: plantings by when they went in, through the run's last 30 days (later ones haven't all shown); spot: their odds by the key");
console.log("days     attempts took worked wasted tests | theories/person right wrong unclear | formed r/w/u again | dropped r/w/u | tests offered/taken | best (of n) regret island | planted came spot");
rows.forEach((x, b) => {
  if (!x) return;
  const held = x.held.hurts + x.held["no effect"] + x.held.unclear, formed = x.formed.hurts + x.formed["no effect"] + x.formed.unclear;
  console.log([
    `${days(b)} ${String(x.attempts).padStart(8)} ${per(x.took, x.timed, 1).padStart(4)} ${pct(x.wins, x.attempts).padStart(6)} ${pct(x.wasted, x.attempts).padStart(6)} ${String(x.tests).padStart(5)}`,
    `${per(held, x.agentDays, 2).padStart(15)} ${pct(x.held.hurts, held).padStart(5)} ${pct(x.held["no effect"], held).padStart(5)} ${pct(x.held.unclear, held).padStart(7)}`,
    `${`${x.formed.hurts}/${x.formed["no effect"]}/${x.formed.unclear}`.padStart(12)} ${pct(x.reformed, formed).padStart(5)}`,
    `${`${x.dropped.hurts}/${x.dropped["no effect"]}/${x.dropped.unclear}`.padStart(13)}`,
    `${`${x.offered}/${x.tested}`.padStart(19)}`,
    `${`${pct(x.best, x.chose)} (${x.chose})`.padStart(11)} ${per(x.regret, x.chose).padStart(6)} ${per(x.discovery, x.found).padStart(6)}`,
    `${String(x.planted).padStart(7)} ${pct(x.came, x.planted).padStart(4)} ${pct(x.spot, x.planted).padStart(4)}`,
  ].join(" | "));
});
if (rows.some((x) => x?.sown)) {
  console.log("\nplantings as they went in, per ten days: how many, odds of the spot (by the key), in shade, crowded, in a condition that truly hurts");
  for (const [b, x] of rows.entries()) if (x?.sown) console.log(`${days(b)} ${String(x.sown).padStart(5)} ${pct(x.sownSpot, x.sown).padStart(5)} ${pct(x.sownShade, x.sown).padStart(5)} ${pct(x.sownCrowded, x.sown).padStart(5)} ${pct(x.sownHurt, x.sown).padStart(5)}`);
}
console.log("\nshare of people holding each lesson, per ten days:");
for (const lesson of Object.keys(LESSONS)) console.log(`  ${lesson.padEnd(10)} ${rows.map((x) => (x?.agentDays ? pct(x.lessons[lesson] ?? 0, x.agentDays) : "-").padStart(5)).join(" ")}`);
console.log("\nby what was done, worked (attempts) per ten days:");
const total = (xs: Count[]) => xs.reduce((t, x) => t + (x?.n ?? 0), 0);
for (const [verb, xs] of Object.entries(verbs).sort((a, b) => total(b[1]) - total(a[1])))
  console.log(`  ${verb.padEnd(7)} ${Array.from(xs, (x) => (x ? `${pct(x.wins, x.n)}(${x.n})` : "-")).join("  ")}`);
// what the key found came up on each ground, for each thing planted
const sowings = Object.entries(answers.ways).filter(([key]) => key.startsWith("plant|") && judged(key));
console.log("\nwhere they planted, share per ten days (and how often what was planted comes up there, by the key):");
const allGrounds = [...new Set(rows.flatMap((x) => (x ? Object.keys(x.grounds) : [])))].sort();
for (const g of allGrounds) {
  const came = sowings.filter(([, w]) => w.conds[g]).map(([k, w]) => `${k.split("|")[1]} ${pct(w.conds[g].in.wins, w.conds[g].in.n)} of ${w.conds[g].in.n}`);
  console.log(`  ${g.replace(/^ground:/, "").padEnd(22)} ${rows.map((x) => (x?.planted ? pct(x.grounds[g] ?? 0, x.planted) : "-").padStart(5)).join(" ")}   (${came.join(", ") || "not in the key"})`);
}
console.log("\neach person's k-th try at a thing that shows at once, tests left out: worked / wasted");
console.log(curve.map((c, k) => (c ? `${k}${k === 30 ? "+" : ""}: ${pct(c.wins, c.n)}/${pct(c.wasted, c.n)} (${c.n})` : "")).filter(Boolean).join("  "));
const med = (xs: number[]) => (xs.length ? xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)].toFixed(1) : "-");
console.log(`\ntheory lifetimes in days (median): right ${med(lifetimes.hurts)} (${lifetimes.hurts.length}), wrong ${med(lifetimes["no effect"])} (${lifetimes["no effect"].length}), unclear ${med(lifetimes.unclear)} (${lifetimes.unclear.length})`);
console.log("dropped by how (right/wrong/unclear):", Object.entries(dropHow).map(([h, v]) => `${h} ${v.hurts}/${v["no effect"]}/${v.unclear}`).join(", "));
console.log("\nbefore and after forming a theory, their own attempts at that thing: done in the condition it names, and worked");
for (const v of VERDICTS) {
  const { before: b, after: a } = around_[v];
  console.log(`  ${({ hurts: "right", "no effect": "wrong", unclear: "unclear" } as Record<Verdict, string>)[v].padEnd(8)} before: ${pct(b.inCond, b.n).padStart(4)} in it, ${pct(b.wins, b.n).padStart(4)} worked (${b.n})   after: ${pct(a.inCond, a.n).padStart(4)} in it, ${pct(a.wins, a.n).padStart(4)} worked (${a.n})`);
}
const heldCount = new Map<string, number>();
for (const r of runs) for (const l of r.lines) if (l.ev === "held") heldCount.set(`${l.key}#${l.cond}`, (heldCount.get(`${l.key}#${l.cond}`) ?? 0) + 1);
// what the key found in a condition and out of it
const inOut = (key: string, cond: string) => {
  const c = answers.ways[key]?.conds[cond];
  return c ? `in ${pct(c.in.wins, c.in.n)} of ${c.in.n}, out ${pct(c.out.wins, c.out.n)} of ${c.out.n}` : "not in the key";
};
console.log("\ntheories held most (person-days): the key's verdict, and what it found in vs out");
for (const [id, n] of [...heldCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)) {
  const [key, cond] = id.split("#");
  console.log(`  ${String(n).padStart(5)}  ${verdict(answers, key, cond).padEnd(9)}  ${key}  ${cond}  ${inOut(key, cond)}`);
}
if (churned.size) {
  console.log("\ntheories formed again most often after being dropped: times, by how many people, the key's verdict");
  for (const [id, c] of [...churned.entries()].sort((a, b) => b[1].again - a[1].again).slice(0, 10)) {
    const [key, cond] = id.split("#");
    console.log(`  ${String(c.again).padStart(5)} ${String(c.people.size).padStart(4)}  ${verdict(answers, key, cond).padEnd(9)}  ${key}  ${cond}  ${inOut(key, cond)}`);
  }
}
// the numbers scripts/evals.ts compares builds by; null where there was nothing to measure. tries: what wasted is over
const share = (a: number, b: number) => (b ? a / b : null);
const kpi = (p: Part) => ({
  attempts: p.attempts, tries: p.tries, worked: share(p.wins, p.attempts), wasted: share(p.wasted, p.tries),
  right: share(p.right, p.agentDays), rightAll: share(p.rightAll, p.agentDays), wrong: share(p.wrong, p.agentDays),
  regret: share(p.regret, p.chose), discovery: share(p.discovery, p.found), churn: share(p.reformed, p.formed), coverage: share(p.judged, p.all),
});
if (jsonOut) writeFileSync(jsonOut, JSON.stringify({ runs: runs.length, rows, curve, lifetimes, dropHow, verbs, verdicts: VERDICTS, around: around_, kpis: { early: kpi(parts.early), late: kpi(parts.late) } }));
