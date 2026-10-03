// Pools theory runs (scripts/theories.ts) and scores, over the days, what people believed and what they did against the
// truth: what the world's rules say hurts what (src/sim/physics.ts), and for planting a controlled experiment
// (scripts/plant-truth.ts). Over the days: how often what they did worked; how often they did it in a condition that
// truly hurts it ("wasted"); the theories they held (right: it names a condition that truly hurts; wrong: one that
// doesn't); whether they used the surest way they knew to an end; how good the spots they planted in were; and tests.
//   bun scripts/theory-report.ts /tmp/theories/new --plant /tmp/plant-truth [--json out.json]
import { readdirSync, readFileSync, writeFileSync } from "node:fs";

type Line = {
  ev: string; t: number; agent?: string; key?: string; verb?: string; now?: string[]; worked?: boolean; cond?: string; conds?: string[];
  how?: string; alive?: number; done?: number; aim?: string; alts?: string[]; goal?: string; chosen?: boolean;
};
type Sown = { day: number; conds: string[]; how: "came" | "withered" | "failed" | "pending" };
const DAY = 288, BUCKET = 10;
const argv = process.argv.slice(2);
const opt = (name: string) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : null; };
const dir = argv[0] ?? "/tmp/theories", jsonOut = opt("json"), plantDir = opt("plant");
const jsonl = <T>(path: string) => readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as T);
const files = (d: string) => readdirSync(d).filter((f) => f.endsWith(".jsonl"));
const runs = files(dir).map((f) => ({ run: f.replace(/\.jsonl$/, ""), lines: jsonl<Line>(`${dir}/${f}`) }));

// ---------- the truth ----------
type Tally = { n: number; wins: number };
const tally = (): Tally => ({ n: 0, wins: 0 });
const count = (t: Tally, won: boolean) => { t.n++; if (won) t.wins++; };
const tallyIn = <K>(m: Map<K, Tally>, k: K) => m.get(k) ?? m.set(k, tally()).get(k)!;
const wilson = (wins: number, n: number, z = 1.645): [number, number] => {
  if (!n) return [0, 1];
  const p = wins / n, d = 1 + (z * z) / n, c = p + (z * z) / (2 * n), m = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [(c - m) / d, (c + m) / d];
};
type Verdict = "hurts" | "no effect" | "unclear";
const VERDICTS: Verdict[] = ["hurts", "no effect", "unclear"];
const byVerdict = () => ({ hurts: 0, "no effect": 0, unclear: 0 }) as Record<Verdict, number>;
// A condition hurts when it works clearly less often in it than out of it (90% Wilson intervals apart, 15 points or
// more); it has no effect when there's enough of both and it does no more than 10 points worse in it, or better.
function judge(inn: Tally, out: Tally): Verdict {
  const gap = out.wins / out.n - inn.wins / inn.n;
  if (inn.n >= 3 && out.n >= 3 && wilson(inn.wins, inn.n)[1] < wilson(out.wins, out.n)[0] && gap >= 0.15) return "hurts";
  return inn.n >= 8 && out.n >= 8 && gap <= 0.1 ? "no effect" : "unclear";
}
// what everyone saw, pooled over every run: each way of doing things, all told and in each condition; and what it's for
const pooled = new Map<string, { all: Tally; conds: Map<string, Tally> }>();
const aims = new Map<string, string>();
for (const r of runs) for (const l of r.lines) {
  if (l.ev !== "attempt" || !l.key) continue;
  const k = pooled.get(l.key) ?? pooled.set(l.key, { all: tally(), conds: new Map() }).get(l.key)!;
  count(k.all, !!l.worked);
  for (const c of l.now ?? []) count(tallyIn(k.conds, c), !!l.worked);
  if (l.aim) aims.set(l.key, l.aim);
}
const observed = (key: string, cond: string) => {
  const k = pooled.get(key), inn = k?.conds.get(cond) ?? tally(), all = k?.all ?? tally();
  return judge(inn, { n: all.n - inn.n, wins: all.wins - inn.wins });
};
// planting, by experiment: berries planted from random spots, with and without each condition (one that couldn't go in
// at all failed)
const sown = plantDir ? files(plantDir).flatMap((f) => jsonl<Sown>(`${plantDir}/${f}`)).filter((s) => s.how !== "pending") : [];
const plantVerdicts = new Map<string, Verdict>();
function planted(cond: string): Verdict {
  if (!sown.length) return "unclear";
  const hit = plantVerdicts.get(cond);
  if (hit) return hit;
  const inn = tally(), out = tally();
  for (const s of sown) count(s.conds.includes(cond) ? inn : out, s.how === "came");
  const v = judge(inn, out);
  plantVerdicts.set(cond, v);
  return v;
}
// What hurts what, by the world's rules: a spark or a rubbed stick won't light tinder in the rain with nothing overhead;
// dark and wind hurt nothing; cold freezes the water over (dipping things in it); what's done to the ground goes by the
// spot. Planting, and watering what's planted, by the experiment; digging (rain can fill the low ground with water) and
// dipping in the cold by what was seen.
function truth(key: string, cond: string): Verdict {
  const verb = key.split("|")[0];
  if (verb === "plant" || verb === "pour") return planted(cond);
  if (verb === "dig") return observed(key, cond);
  if (cond === "dark" || cond === "wind") return "no effect";
  if (cond === "rain") return (aims.get(key) ?? (verb === "rub" ? "fire" : "")) === "fire" && (verb === "rub" || verb === "strike") ? "hurts" : "no effect";
  if (cond === "cold") return verb === "wet" ? observed(key, cond) : "no effect";
  return verb === "dig" ? observed(key, cond) : "no effect";
}
// The odds of a way of doing things working in the conditions it was done in, pooled: in the condition that truly hurts
// it most, if any held; otherwise when none held.
const hurtsOf = new Map<string, string[]>();
for (const [key, k] of pooled) hurtsOf.set(key, [...k.conds.keys()].filter((c) => truth(key, c) === "hurts"));
function oddsOf(key: string, now: string[]): Tally {
  const k = pooled.get(key);
  if (!k) return tally();
  const bad = hurtsOf.get(key)!.filter((c) => now.includes(c));
  if (bad.length) return bad.map((c) => k.conds.get(c)!).reduce((a, b) => (b.wins / b.n < a.wins / a.n ? b : a));
  const clean = tally();
  clean.n = k.all.n; clean.wins = k.all.wins;
  for (const c of hurtsOf.get(key)!) { const s = k.conds.get(c)!; clean.n -= s.n; clean.wins -= s.wins; }
  return clean.n >= 3 ? clean : k.all;
}
// The odds a berry planted in a spot like this comes up, by the experiment: spots on the same ground with the same shade,
// dryness and crowding, or failing enough of those, the same ground.
const SPOT = ["shade", "dry", "crowded"];
const groundIn = (conds: string[]) => conds.find((c) => c.startsWith("ground:")) ?? "?";
const spotOf = (conds: string[]) => [groundIn(conds), ...SPOT.filter((c) => conds.includes(c))].join("+");
const bySpot = new Map<string, Tally>(), byGround = new Map<string, Tally>(), sownAll = tally();
for (const s of sown) { count(tallyIn(bySpot, spotOf(s.conds)), s.how === "came"); count(tallyIn(byGround, groundIn(s.conds)), s.how === "came"); count(sownAll, s.how === "came"); }
// ground: by the ground alone (for runs that didn't note the rest of the spot)
function spotOdds(conds: string[], ground = false) {
  const s = bySpot.get(spotOf(conds)), g = byGround.get(groundIn(conds));
  return s && s.n >= 10 && !ground ? s.wins / s.n : g && g.n >= 10 ? g.wins / g.n : sownAll.wins / sownAll.n;
}
const bestSpot = [...bySpot.entries()].filter(([, s]) => s.n >= 20).sort((a, b) => b[1].wins / b[1].n - a[1].wins / a[1].n)[0];

// ---------- over the days ----------
const bucket = (t: number) => Math.floor(t / DAY / BUCKET);
type Row = {
  // what shows at once (everything but planting and watering): attempts, how many worked, how many were done in a
  // condition that truly hurts them
  attempts: number; wins: number; wasted: number; agentDays: number;
  held: Record<Verdict, number>; formed: Record<Verdict, number>; dropped: Record<Verdict, number>;
  offered: number; tested: number;
  // attempts at something they knew another way to (to the same end, at the same place: building onto their home isn't
  // the same as putting up a new pile): how many used a way within 15 points of the surest in the conditions, and what
  // all gave up in odds against the surest, summed
  alt: number; surest: number; regret: number;
  // plantings: how many showed, how many came up, and the odds of the spots chosen (and of their ground alone), summed
  planted: number; came: number; spot: number; ground: number;
  grounds: Record<string, number>;
  // plantings as they went in (runs that note them), whether or not they ever showed: how many, the odds of the spots
  // chosen, and how many went into the shade or in among bushes and trees
  sown: number; sownSpot: number; sownShade: number; sownCrowded: number;
  // person-days holding the lessons that matter most: berries won't come up in the shade, or crowded in among bushes
  // and trees; fire won't light in the rain
  lessons: Record<string, number>;
};
const LESSONS: Record<string, (key: string, cond: string) => boolean> = {
  shade: (key, cond) => key.startsWith("plant|") && cond === "shade",
  crowded: (key, cond) => key.startsWith("plant|") && cond === "crowded",
  "rain-fire": (key, cond) => cond === "rain" && aims.get(key) === "fire",
};
const rows: Row[] = [];
const row = (b: number) => (rows[b] ??= {
  attempts: 0, wins: 0, wasted: 0, agentDays: 0, held: byVerdict(), formed: byVerdict(), dropped: byVerdict(), offered: 0, tested: 0,
  alt: 0, surest: 0, regret: 0, planted: 0, came: 0, spot: 0, ground: 0, grounds: {}, sown: 0, sownSpot: 0, sownShade: 0, sownCrowded: 0, lessons: {},
});
// each person's k-th try at a thing: did it work, and was it done in a condition that hurts it
const curve: { n: number; wins: number; wasted: number }[] = [];
// each kind of doing (plant, rub, strike...) over the days
const verbs: Record<string, Tally[]> = {};
const lives = new Map<string, { t: number; v: Verdict }>();
const lifetimes: Record<Verdict, number[]> = { hurts: [], "no effect": [], unclear: [] };
const dropHow: Record<string, Record<Verdict, number>> = {};
for (const r of runs) {
  const end = r.lines.at(-1)?.t ?? 0;
  const attempts = r.lines.filter((l) => l.ev === "attempt" && l.key).sort((a, b) => (a.done ?? a.t) - (b.done ?? b.t));
  const nth = new Map<string, number>();
  for (const l of attempts) {
    // a planting shows within 30 days or is given up on: one done later than that before the end hasn't all shown, and
    // what has is mostly what withered fast
    if ((l.verb === "plant" || l.verb === "pour") && (l.done ?? l.t) > end - 30 * DAY) continue;
    const key = l.key!, now = l.now ?? [], b = bucket(l.done ?? l.t), x = row(b);
    const wasted = now.some((c) => truth(key, c) === "hurts"), later = l.verb === "plant" || l.verb === "pour";
    count(((verbs[l.verb ?? "?"] ??= [])[b] ??= tally()), !!l.worked);
    if (!later) {
      x.attempts++; if (l.worked) x.wins++; if (wasted) x.wasted++;
      const id = `${l.agent}|${key}`, i = (nth.get(id) ?? 0) + 1;
      nth.set(id, i);
      const c = (curve[Math.min(i, 30)] ??= { n: 0, wins: 0, wasted: 0 });
      c.n++; if (l.worked) c.wins++; if (wasted) c.wasted++;
    }
    const where = key.split("|")[4];
    const alts = (l.alts ?? []).filter((k) => k.split("|")[4] === where).map((k) => oddsOf(k, now)).filter((s) => s.n >= 3);
    const mine = oddsOf(key, now);
    if (alts.length && mine.n >= 3) {
      const best = Math.max(...alts.map((s) => s.wins / s.n)), own = mine.wins / mine.n;
      x.alt++; if (own >= best - 0.15) x.surest++; x.regret += Math.max(0, best - own);
    }
    if (l.verb === "plant") {
      x.planted++; if (l.worked) x.came++; x.spot += spotOdds(now); x.ground += spotOdds(now, true);
      const g = groundIn(now);
      x.grounds[g] = (x.grounds[g] ?? 0) + 1;
    }
  }
  // each person each day counts once for each lesson they hold, however many ways of doing it it's about
  const learned = new Set<string>();
  for (const l of r.lines) {
    if (l.ev === "held" && l.key && l.cond) {
      row(bucket(l.t)).held[truth(l.key, l.cond)]++;
      for (const [lesson, is] of Object.entries(LESSONS)) {
        const id = `${l.t}|${l.agent}|${lesson}`;
        if (!is(l.key, l.cond) || learned.has(id)) continue;
        learned.add(id);
        const x = row(bucket(l.t));
        x.lessons[lesson] = (x.lessons[lesson] ?? 0) + 1;
      }
    }
    else if (l.ev === "day") row(bucket(l.t - 1)).agentDays += l.alive ?? 0;
    else if (l.ev === "test") { row(bucket(l.t)).offered++; if (l.chosen) row(bucket(l.t)).tested++; }
    else if (l.ev === "sown" && l.key?.startsWith("plant|") && l.now) {
      const x = row(bucket(l.t));
      x.sown++; x.sownSpot += spotOdds(l.now); if (l.now.includes("shade")) x.sownShade++; if (l.now.includes("crowded")) x.sownCrowded++;
    }
    else if (l.ev === "formed" && l.key && l.cond) {
      const v = truth(l.key, l.cond);
      row(bucket(l.t)).formed[v]++;
      lives.set(`${r.run}|${l.agent}|${l.key}|${l.cond}`, { t: l.t, v });
    } else if (l.ev === "dropped" && l.key) for (const c of l.conds ?? []) {
      const v = truth(l.key, c);
      row(bucket(l.t)).dropped[v]++;
      (dropHow[l.how ?? "?"] ??= byVerdict())[v]++;
      const id = `${r.run}|${l.agent}|${l.key}|${c}`, born = lives.get(id);
      if (born) { lifetimes[born.v].push((l.t - born.t) / DAY); lives.delete(id); }
    }
  }
  // what was still held at the end, or died with whoever held it, lived to the end of the run at least
  for (const [id, born] of lives) if (id.startsWith(`${r.run}|`)) { lifetimes[born.v].push((end - born.t) / DAY); lives.delete(id); }
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
    const v = truth(f.key!, f.cond!), xs = mine.get(`${f.agent}|${f.key}`) ?? [];
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
const days = (b: number) => `${String(b * BUCKET + 1).padStart(3)}-${String((b + 1) * BUCKET).padEnd(4)}`;
console.log(`${runs.length} runs, ${[...pooled.values()].reduce((t, k) => t + k.all.n, 0)} attempts judged over ${pooled.size} ways of doing things`);
if (sown.length) console.log(`planting truth: ${sown.length} berries planted at random (${pct(sownAll.wins, sownAll.n)} came up); best spot ${bestSpot?.[0]} ${pct(bestSpot?.[1].wins ?? 0, bestSpot?.[1].n ?? 0)} of ${bestSpot?.[1].n}`);
console.log("\nattempts, worked and wasted: what shows at once; planted and came: plantings by when they went in, through the run's last 30 days (later ones haven't all shown)");
console.log("days     attempts worked wasted | theories/person right wrong unclear | formed r/w/u | dropped r/w/u | tests offered/taken | surest way (of n) regret | planted came spot ground");
rows.forEach((x, b) => {
  if (!x) return;
  const held = x.held.hurts + x.held["no effect"] + x.held.unclear, per = x.agentDays ? held / x.agentDays : 0;
  console.log(`${days(b)} ${String(x.attempts).padStart(7)} ${pct(x.wins, x.attempts).padStart(6)} ${pct(x.wasted, x.attempts).padStart(6)} | ${per.toFixed(2).padStart(10)} ${pct(x.held.hurts, held).padStart(5)} ${pct(x.held["no effect"], held).padStart(5)} ${pct(x.held.unclear, held).padStart(7)} | ${`${x.formed.hurts}/${x.formed["no effect"]}/${x.formed.unclear}`.padStart(12)} | ${`${x.dropped.hurts}/${x.dropped["no effect"]}/${x.dropped.unclear}`.padStart(13)} | ${`${x.offered}/${x.tested}`.padStart(19)} | ${`${pct(x.surest, x.alt)} (${x.alt})`.padStart(16)} ${x.alt ? (100 * x.regret / x.alt).toFixed(1).padStart(6) : "     -"} | ${String(x.planted).padStart(7)} ${pct(x.came, x.planted).padStart(4)} ${(x.planted && sown.length ? pct(x.spot, x.planted) : "-").padStart(4)} ${(x.planted && sown.length ? pct(x.ground, x.planted) : "-").padStart(6)}`);
});
if (rows.some((x) => x?.sown)) {
  console.log("\nplantings as they went in, per ten days: how many, odds of the spot (by experiment), in shade, crowded");
  for (const [b, x] of rows.entries()) if (x?.sown) console.log(`${days(b)} ${String(x.sown).padStart(5)} ${pct(x.sownSpot, x.sown).padStart(5)} ${pct(x.sownShade, x.sown).padStart(5)} ${pct(x.sownCrowded, x.sown).padStart(5)}`);
}
console.log("\nshare of people holding each lesson, per ten days:");
for (const lesson of Object.keys(LESSONS)) console.log(`  ${lesson.padEnd(10)} ${rows.map((x) => (x?.agentDays ? pct(x.lessons[lesson] ?? 0, x.agentDays) : "-").padStart(5)).join(" ")}`);
console.log("\nby what was done, worked (attempts) per ten days:");
const total = (xs: Tally[]) => xs.reduce((t, x) => t + (x?.n ?? 0), 0);
for (const [verb, xs] of Object.entries(verbs).sort((a, b) => total(b[1]) - total(a[1])))
  console.log(`  ${verb.padEnd(7)} ${Array.from(xs, (x) => (x ? `${pct(x.wins, x.n)}(${x.n})` : "-")).join("  ")}`);
console.log("\nwhere they planted, share per ten days:");
const allGrounds = [...new Set(rows.flatMap((x) => (x ? Object.keys(x.grounds) : [])))].sort();
for (const g of allGrounds) console.log(`  ${g.slice(7).padEnd(22)} ${rows.map((x) => (x?.planted ? pct(x.grounds[g] ?? 0, x.planted) : "-").padStart(5)).join(" ")}   (truth: ${pct(byGround.get(g)?.wins ?? 0, byGround.get(g)?.n ?? 0)} come up)`);
console.log("\neach person's k-th try at a thing that shows at once: worked / wasted");
console.log(curve.map((c, k) => (c ? `${k}${k === 30 ? "+" : ""}: ${pct(c.wins, c.n)}/${pct(c.wasted, c.n)} (${c.n})` : "")).filter(Boolean).join("  "));
const med = (xs: number[]) => (xs.length ? xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)].toFixed(1) : "-");
console.log(`\ntheory lifetimes in days (median): right ${med(lifetimes.hurts)} (${lifetimes.hurts.length}), wrong ${med(lifetimes["no effect"])} (${lifetimes["no effect"].length}), unclear ${med(lifetimes.unclear)} (${lifetimes.unclear.length})`);
console.log("dropped by how (right/wrong/unclear):", Object.entries(dropHow).map(([h, v]) => `${h} ${v.hurts}/${v["no effect"]}/${v.unclear}`).join(", "));
console.log("\nbefore and after forming a theory, their own attempts at that thing: done in the condition it names, and worked");
for (const v of VERDICTS) {
  const { before: b, after: a } = around_[v];
  console.log(`  ${({ hurts: "right", "no effect": "wrong", unclear: "unclear" } as Record<Verdict, string>)[v].padEnd(8)} before: ${pct(b.inCond, b.n).padStart(4)} in it, ${pct(b.wins, b.n).padStart(4)} worked (${b.n})   after: ${pct(a.inCond, a.n).padStart(4)} in it, ${pct(a.wins, a.n).padStart(4)} worked (${a.n})`);
}
if (sown.length) {
  console.log("\nplanting truth by condition: came up in / out");
  for (const c of [...new Set(sown.flatMap((s) => s.conds))].sort()) {
    const inn = tally(), out = tally();
    for (const s of sown) count(s.conds.includes(c) ? inn : out, s.how === "came");
    console.log(`  ${c.padEnd(28)} ${pct(inn.wins, inn.n).padStart(4)} of ${String(inn.n).padStart(4)}  vs ${pct(out.wins, out.n).padStart(4)} of ${String(out.n).padStart(4)}  ${planted(c)}`);
  }
}
const heldCount = new Map<string, number>();
for (const r of runs) for (const l of r.lines) if (l.ev === "held") heldCount.set(`${l.key}#${l.cond}`, (heldCount.get(`${l.key}#${l.cond}`) ?? 0) + 1);
console.log("\ntheories held most (person-days): truth, and what everyone saw in vs out");
for (const [id, n] of [...heldCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)) {
  const [key, cond] = id.split("#"), k = pooled.get(key), inn = k?.conds.get(cond) ?? tally(), all = k?.all ?? tally();
  console.log(`  ${String(n).padStart(5)}  ${truth(key, cond).padEnd(9)}  ${key}  ${cond}  in ${pct(inn.wins, inn.n)} of ${inn.n}, out ${pct(all.wins - inn.wins, all.n - inn.n)} of ${all.n - inn.n}`);
}
if (jsonOut) writeFileSync(jsonOut, JSON.stringify({ runs: runs.length, rows, curve, lifetimes, dropHow, verbs, verdicts: VERDICTS, around: around_, bestSpot: bestSpot && { spot: bestSpot[0], odds: bestSpot[1].wins / bestSpot[1].n }, sownOdds: sownAll.n ? sownAll.wins / sownAll.n : null }));
