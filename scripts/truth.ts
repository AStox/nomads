// The answer key for one island, worked out from the world's own formulas rather than by trying anything: for every way
// of doing things people used there (the runs' attempts and plantings), what it comes to (src/sim/formulas.ts predict)
// in each of many situations the island gives over the run's days: a random dry spot (by the water, for what needs
// water), a random hour, the island's weather then as its own weather, drawn on from the start, would bring it, and what
// they use as wet as dead stuff its thickness lying there. Each is noted with the conditions anyone there could see
// (sim.ts conditionsNow), whether the way would come off for what it's for, and the ticks it would take a hand practised
// at nothing (more in poor light, where work goes slower). Then, for each condition, whether it truly hurts the way, like
// for like (stats.ts judge). scripts/answer-key.ts has the key's shape, and scripts/theory-report.ts scores people's
// theories and choices against it.
//   NOMADS_BRAIN=random bun scripts/truth.ts --seed 3 --runs /tmp/theories/3 --days 40 --out /tmp/truth/3.json
// --runs: a directory of scripts/theories.ts runs of this island. Their ways are what gets worked out, and the things
// they made and the rulings they settled come too, so the same things can be made here.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { W, H, dryAt, meters, newWorld, rng, shoreOf, stageOf, type World } from "../src/sim/world";
import { forecast } from "../src/sim/ecology";
import { FISH_REACH, giveItems, lineLike, openWater, type Fields } from "../src/sim/physics";
import { airOn, islandTemp } from "../src/sim/air";
import { lightOn, workRate } from "../src/sim/light";
import { put, shelve } from "../src/sim/space";
import { fieldsOf, ofPlace } from "../src/sim/beliefs";
import { conditionsNow } from "../src/sim/sim";
import { deadAt, deadHour, tinder, tinderOf } from "../src/sim/wetness";
import { stackPhys } from "../src/sim/fuel";
import { ahead } from "../src/sim/seedling";
import { predict, type Prediction } from "../src/sim/formulas";
import { seedRandom } from "./seeded";
import { judge } from "./stats";
import type { AnswerKey, Cond, Tally, Verdict, Way } from "./answer-key";

const arg = (name: string, d: string) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : d; };
const seed = Number(arg("seed", "1")), days = Number(arg("days", "40")), samples = Number(arg("samples", "400"));
const runs = arg("runs", ""), out = arg("out", `/tmp/truth/${seed}.json`);
if (!runs) throw new Error("--runs: a directory of scripts/theories.ts runs of this island");
seedRandom(seed);
const w = newWorld(seed);
// one of the island's grown people, taken out of the world to stand where each situation is, knowing nothing and
// practised at nothing, so neither a theory of theirs nor a skill tips what the formulas make of it
const stand = w.agents.find((a) => stageOf(w, a) !== "child") ?? w.agents[0];
w.agents = [];
Object.assign(stand, { skills: {}, beliefs: {}, goal: null, plan: [], home: null });

// What the runs did, and what for (the aim sim.ts judged gives each attempt), and what they made and settled.
type Line = { ev: string; key?: string; aim?: string; kinds?: World["kinds"]; rulings?: World["rulings"] };
const aims: Record<string, Record<string, number>> = {};
for (const file of readdirSync(runs).filter((f) => f.endsWith(".jsonl")))
  for (const line of readFileSync(`${runs}/${file}`, "utf8").split("\n")) {
    if (!line) continue;
    const e: Line = JSON.parse(line);
    if ((e.ev === "attempt" || e.ev === "sown") && e.key) {
      const seen = (aims[e.key] ??= {});
      if (e.aim) seen[e.aim] = (seen[e.aim] ?? 0) + 1;
    }
    if (e.ev === "kinds") {
      for (const [id, k] of Object.entries(e.kinds ?? {})) w.kinds[id] ??= k;
      Object.assign(w.rulings, e.rulings);
    }
  }

// The island's weather through the run's days and a month past them, turn by turn of the sky from how it stood at the
// start, drawn once (its own draws, not the world's): the sky, the wind, the rain running off the land, and the water in
// the dead stuff lying about the island.
const start = w.t, hours = forecast(w, (days + 30) * 24, rng(seed * 104729 + 7));
const dead: NonNullable<typeof w.weather.dead>[] = [];
{
  let d = w.weather.dead, t = Math.ceil((start + 1) / 12) * 12;
  for (const h of hours) { d = deadHour(w, d, t, h.sky, h.speed, islandTemp(t, h.sky)); dead.push(d); t += 12; }
}
const first = Math.ceil((start + 1) / 12) * 12;
// Set the world to an hour of the run (i) and a tick in it, as the weather had it then.
function setHour(i: number, tick: number) {
  const h = hours[i];
  w.t = first + i * 12 + tick;
  Object.assign(w.weather, { sky: h.sky, speed: h.speed, wet: h.wet, dead: dead[i], temp: islandTemp(w.t, h.sky) });
}

function drySpot(): [number, number] {
  for (let guard = 0; guard < 10000; guard++) {
    const px = Math.random() * W, py = Math.random() * H;
    if (dryAt(w, px, py)) return [px, py];
  }
  throw new Error("no dry ground on the island");
}
const shore = shoreOf(w).filter((s) => openWater(w, s));

// Each way as anyone might hold it: what's done, and what it's for, so what it comes to is judged by what the way is
// meant to get (a fire, not the chips a strike knocked off the stone), as beliefs.ts cameOff judges a try. An aim of
// things to hold is what it gives; anything else is what it builds.
type Plan = { fields: Fields; aim: string; builds?: string; gives: string[] };
// Kinds joined by "+", as keys and aims list them, back into kinds: a made kind's own id can hold a "+" (cord twisted of
// fiber and fiber), so the longest run of parts that names a kind is one.
function kindsIn(joined: string) {
  const parts = joined ? joined.split("+") : [], out: string[] = [];
  for (let i = 0; i < parts.length; ) {
    let j = parts.length;
    while (j > i + 1 && !w.kinds[parts.slice(i, j).join("+")]) j--;
    out.push(parts.slice(i, j).join("+"));
    i = j;
  }
  return out;
}
const plans: Record<string, Plan> = {};
for (const [key, seen] of Object.entries(aims)) {
  const aim = Object.entries(seen).sort((x, y) => y[1] - x[1])[0]?.[0] ?? "", parts = kindsIn(aim), f = fieldsOf(key);
  const held = parts.length > 0 && parts.every((k) => w.kinds[k]);
  plans[key] = { fields: { ...f, inputs: kindsIn(f.inputs.join("+")) }, aim, ...(held ? { gives: parts } : { builds: aim || undefined, gives: [] }) };
}
const meant = (plan: Plan, r: Prediction) => r.ok && (!plan.builds || r.builds === plan.builds) && (!plan.gives.length || plan.gives.some((k) => r.gives.includes(k)));

// A situation for a way: where (the water's edge for what needs water), when, and what they hold: the way's things,
// tinder as wet as what lies about there. What the formulas make of it there, and what anyone could see.
type Trial = { now: string[]; worked: boolean; ticks: number };
function situation(plan: Plan): Trial | string {
  const f = plan.fields, water = f.at === "water" || f.verb === "wet";
  const i = Math.floor(Math.random() * days * 24);
  setHour(i, Math.floor(Math.random() * 12));
  const edge = water ? shore[Math.floor(Math.random() * shore.length)] : null, [px, py] = edge ? [edge.px, edge.py] : drySpot();
  put(w, stand, px, py);
  stand.heading = Math.random() * Math.PI * 2;
  stand.inv = [];
  // each as wet as dead stuff its thickness lying there, as much as it holds
  for (const k of [...f.inputs, ...(f.tool ? [f.tool] : [])]) {
    const x = stackPhys(w.kinds, { k });
    giveItems(w, stand, k, 1, x ? Math.min(x.mmax, deadAt(w, stand, x.d)) : 0);
  }
  const over = f.verb === "strike" ? f.inputs.find((k) => tinder(w.kinds[k])) : undefined;
  const lit = f.verb === "strike" ? (over ? tinderOf(w, stand, over) : null) : tinderOf(w, stand);
  const reach = f.inputs.some((k) => lineLike(w.kinds[k])) ? FISH_REACH.line : FISH_REACH.basket;
  const fish = w.animals.filter((m) => m.species === "fish" && meters(m, stand) <= reach).length;
  const ground = f.verb === "plant" || f.verb === "pour" || f.verb === "dig";
  const r = predict(w, f, { tinder: lit ? lit.m : null, wind: airOn(w, stand).wind, spot: stand, ahead: ground ? ahead(w, px, py, w.t, hours.slice(i + 1)) : { soil: [], temp: [] }, fish });
  if ("why" in r) return r.why;
  // a ruling settled in the runs is the law for it; one never settled leaves it unsaid
  const ruled = "ask" in r ? w.rulings[r.ask] : undefined;
  const done: Prediction | null = "ask" in r ? (ruled ? { ok: ruled.useful, gives: ruled.useful ? [`law:${r.ask}`] : [], at: f.at ?? null, ticks: 8 } : null) : r;
  if (!done) return "no ruling was settled for it";
  const at = done.spot ? { px: done.spot[0], py: done.spot[1] } : stand;
  return { now: conditionsNow(w, stand, f.verb, at, f.inputs), worked: meant(plan, done), ticks: done.ticks / (f.verb === "eat" ? 1 : workRate(lightOn(w, stand).bright)) };
}

const tally = (ts: Trial[]): Tally => ({ n: ts.length, wins: ts.filter((t) => t.worked).length, ticks: ts.reduce((s, t) => s + t.ticks, 0) });
// What judging a condition like for like sets aside: what comes of it rather than with it (rain soaks the tinder, so
// the damp it leaves takes none of the rain's blame), and the coarser level of one cut finer (soaked is damp, and deep
// shade is shade, so neither is set against the other's own kind). The coarser is judged within the finer's levels:
// damp tinder that isn't soaked against dry, light shade against open sky.
const AFTER: Record<string, string[]> = { rain: ["damp", "soaked"], soaked: ["damp"], deep: ["shade"] };
// A condition in and out of it like for like: the trials split by the rest of what was seen of its own sort (the
// weather and the tinder for those, the spot for a spot's, any ground but its own for a ground, since a spot is of
// one sort or another), and the odds in it and out of it pooled over the splits that have both, by how much each can
// tell (Mantel and Haenszel's weights), as if over the trials in those splits. So the dark takes no blame for the rain
// that falls mostly at night, nor crowding for the shade it comes with.
type Count = { n: number; wins: number };
function likeForLike(ts: Trial[], c: string): [Count, Count] {
  const place = ofPlace(c), ground = c.startsWith("ground:"), aside = AFTER[c] ?? [], splits = new Map<string, { in: Trial[]; out: Trial[] }>();
  for (const t of ts) {
    const rest = t.now.filter((o) => o !== c && ofPlace(o) === place && !aside.includes(o) && !(ground && o.startsWith("ground:"))).sort().join(" ");
    const s = splits.get(rest) ?? splits.set(rest, { in: [], out: [] }).get(rest)!;
    (t.now.includes(c) ? s.in : s.out).push(t);
  }
  let weight = 0, oddsIn = 0, oddsOut = 0, nIn = 0, nOut = 0;
  for (const s of splits.values()) {
    if (!s.in.length || !s.out.length) continue;
    const a = tally(s.in), b = tally(s.out), wt = (a.n * b.n) / (a.n + b.n);
    weight += wt; oddsIn += (wt * a.wins) / a.n; oddsOut += (wt * b.wins) / b.n; nIn += a.n; nOut += b.n;
  }
  return [{ n: nIn, wins: weight ? (nIn * oddsIn) / weight : 0 }, { n: nOut, wins: weight ? (nOut * oddsOut) / weight : 0 }];
}

const t0 = performance.now();
const ways: Record<string, Way> = {};
let worked = 0;
for (const [key, plan] of Object.entries(plans)) {
  const f = plan.fields, ts: Trial[] = [];
  let why: string | undefined;
  for (let n = 0; n < samples && !why; n++) {
    const t = situation(plan);
    if (typeof t === "string") why = t;
    else ts.push(t);
    if (++worked % 200 === 0) shelve(w);
  }
  const conds: Record<string, Cond> = {};
  if (!why) for (const c of new Set(ts.flatMap((t) => t.now))) {
    const verdict: Verdict = judge(...likeForLike(ts, c));
    conds[c] = { in: tally(ts.filter((t) => t.now.includes(c))), out: tally(ts.filter((t) => !t.now.includes(c))), verdict };
  }
  ways[key] = { verb: f.verb, aim: plan.aim, at: f.at ?? "-", all: tally(why ? [] : ts), conds, ...(why ? { why } : {}) };
}
const key: AnswerKey = { seed, days, trials: Object.values(ways).reduce((s, x) => s + x.all.n, 0), ways };
writeFileSync(out, JSON.stringify(key, null, 1) + "\n");
const whys = Object.entries(ways).filter(([, x]) => x.why);
console.error(`seed ${seed}: ${Object.keys(ways).length - whys.length} ways worked out, ${key.trials} situations, ${whys.length} with why, ${((performance.now() - t0) / 1000).toFixed(0)} s`);
for (const [k, x] of whys) console.error(`  ${k}: ${x.why}`);
for (const [k, x] of Object.entries(ways)) {
  const hurt = Object.entries(x.conds).filter(([, c]) => c.verdict === "hurts").map(([c]) => c);
  if (hurt.length) console.error(`  ${k} (${x.aim}): ${hurt.join(", ")}`);
}
process.exit(0);
