// The answer key for one island, found by trying every way of doing things people used there: someone taken out of the
// world does each way over and over, a few times every day, each try at a random hour and a random spot (by the water for
// what needs water, beside the tree or boulder for a strike at one, by a fire of the right kind for what's done at a
// fire), under a sky of rain or clear and a gale or a breath of wind taken in turn, whatever the hour and the season
// bring besides. Each try is noted with the conditions they could see (sim.ts conditionsNow), whether it came
// off as meant (beliefs.ts cameOff) and how long it took (scripts/trial.ts). A seed pushed into the ground, or a young
// plant watered, counts when it comes up or withers, the island's own ecology running on meanwhile. Then, for each
// condition, whether it truly hurts the way (stats.ts judge). scripts/answer-key.ts has the key's shape, and
// scripts/theory-report.ts scores people's theories and choices against it.
//   NOMADS_BRAIN=random bun scripts/truth.ts --seed 3 --runs /tmp/theories/3 --days 40 --per 6 --out /tmp/truth/3.json
// --runs: a directory of scripts/theories.ts runs of this island. Their ways are what gets tried, and the things they
// made and the rulings they settled come too, so the same things can be made here.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { DAY, W, H, addThing, dryAt, newWorld, reachOf, shoreOf, stageOf, type Agent, type World } from "../src/sim/world";
import { ecology, trailChanges } from "../src/sim/ecology";
import { beside, changed, fireHeat, giveItems, newKinds, plant, removeThing, removed, sheltered, shelterOf, sizeOf, type Fields } from "../src/sim/physics";
import { airAt } from "../src/sim/air";
import { nearestThing, put, shelve, thingById } from "../src/sim/space";
import { THING_MATERIAL, type Registry } from "../src/sim/materials";
import { FAUNA } from "../src/sim/fauna";
import { fieldsOf, groundOfKey, type Belief } from "../src/sim/beliefs";
import { conditionsNow } from "../src/sim/sim";
import { seedRandom } from "./seeded";
import { tryAct } from "./trial";
import { judge } from "./stats";
import type { AnswerKey, Cond, Tally, Way } from "./answer-key";

const arg = (name: string, d: string) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : d; };
const seed = Number(arg("seed", "1")), days = Number(arg("days", "40")), per = Number(arg("per", "6"));
const runs = arg("runs", ""), out = arg("out", `/tmp/truth/${seed}.json`);
if (!runs) throw new Error("--runs: a directory of scripts/theories.ts runs of this island");
seedRandom(seed);
const w = newWorld(seed);
// one of the island's grown people, taken out of the world to do the trying and nothing else, knowing nothing and
// practised at nothing, so neither a theory of theirs nor a skill tips a try
const stand = w.agents.find((a) => stageOf(w, a) !== "child") ?? w.agents[0];
w.agents = [];
Object.assign(stand, { skills: {}, beliefs: {}, goal: null, plan: [], home: null });

// What the runs did, and what for (the aim sim.ts judged gives each attempt), and what they made and settled.
type Line = { ev: string; key?: string; aim?: string; kinds?: Registry; rulings?: World["rulings"] };
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

// Each way as a belief anyone might hold of it: what's done, and what it's for, so cameOff judges a try by what the way
// is meant to get (a fire, not the chips a strike knocked off the stone). An aim of things to hold is what it gives;
// anything else is what it builds.
const FIRES: Record<string, true> = { fire: true, hearth: true, kiln: true, forge: true };
// A try: the conditions it was done in, whether it worked and how long it took; open: the weather given it that could
// have held where it was done (rain with nothing overhead, a gale felt as a strong wind out of the lee of the land and
// the trees).
type Trial = { now: string[]; worked: boolean; took: number; open: string[] };
// ground: whether it's done to the ground, which brings in the spot's own conditions (sim.ts conditionsNow)
type Plan = { belief: Belief; ground: boolean; trials: Trial[]; reasons: Record<string, number>; grew: Record<string, number>; why?: string };
const plans: Record<string, Plan> = {};
for (const [key, seen] of Object.entries(aims)) {
  const f = fieldsOf(key), aim = Object.entries(seen).sort((x, y) => y[1] - x[1])[0]?.[0] ?? "";
  const gives = aim ? aim.split("+") : [], holds = gives.length > 0 && gives.every((k) => w.kinds[k]);
  const belief: Belief = { key, fields: { ...f, ...(aim && !holds ? { builds: aim } : {}) }, uses: {}, out: holds ? Object.fromEntries(gives.map((k) => [k, 1])) : {}, ticks: 0, tries: 0, wins: 0, how: "discovered", t: w.t };
  const struck = f.verb === "strike" && !f.inputs.length ? f.target : undefined;
  const unknown = [...f.inputs, f.tool, struck && !THING_MATERIAL[struck] ? struck : null].find((k) => k && !w.kinds[k]);
  const why = f.verb === "throw" || (struck && struck in FAUNA) ? "hunting isn't tried"
    : unknown ? `no run made the ${unknown}`
      : f.at && !FIRES[f.at] && f.at !== "water" && f.at !== "home" && f.at !== "pit" ? `there's no setting it up at a ${f.at}` : undefined;
  const ground = conditionsNow(w, stand, f.verb).some((c) => groundOfKey(c));
  plans[key] = { belief, ground, trials: [], reasons: {}, grew: {}, ...(why ? { why } : {}) };
}

function drySpot(): [number, number] {
  for (let guard = 0; guard < 10000; guard++) {
    const px = Math.random() * W, py = Math.random() * H;
    if (dryAt(w, px, py)) return [px, py];
  }
  throw new Error("no dry ground on the island");
}
// Where it's done, and whatever has to be there: the water's edge, the tree or boulder struck at, a fire of the kind it's
// done at, a pit, a shelter of their own; then what it takes in hand. Why it can't be, when it can't. What's done to the
// ground is done every other time by a tree or a bush: so few random spots have one close enough round to crowd them
// that crowding could never be judged.
function setUp(plan: Plan, a: Agent): string | null {
  const f = plan.belief.fields;
  if (f.at === "water" || f.verb === "wet") {
    const shore = shoreOf(w), edge = shore[Math.floor(Math.random() * shore.length)];
    put(w, a, edge.px, edge.py);
  } else put(w, a, ...drySpot());
  const by = plan.ground && Math.random() < 0.5 ? nearestThing(w, a.px, a.py, ["tree", "bush"], () => true, 300) : null;
  if (by) put(w, a, by.px, by.py);
  if (f.verb === "strike" && !f.inputs.length && f.target && THING_MATERIAL[f.target]) {
    const t = nearestThing(w, a.px, a.py, [f.target], (x) => !x.burning, 300);
    if (!t) return `no ${f.target} within 300 m`;
    put(w, a, ...beside(w, t, reachOf(t) - 0.3));
  }
  // a fire as fireKind tells them apart: ringed for a hearth, ringed and heaped over for a kiln, charcoal in the ring
  // for a forge
  if (f.at && FIRES[f.at]) {
    const fire = addThing(w, "fire", ...beside(w, a, 0.8), { hp: 200, maxHp: 400, born: w.t, contained: f.at !== "fire", covered: f.at === "kiln", ...(f.at === "forge" ? { charcoal: 100 } : {}) });
    fire.heat = fireHeat(w, fire);
  }
  if (f.at === "pit") addThing(w, "pit", ...beside(w, a, 1), { owner: a.id, born: w.t });
  if (f.at === "home") {
    const parts = { stick: 4 }, home = addThing(w, "structure", ...beside(w, a, 1.5), { owner: a.id, parts, hp: 100, maxHp: 100, born: w.t });
    home.shelter = shelterOf(w, parts);
    home.size = sizeOf(home.shelter);
    a.home = home.id;
  }
  // a young plant to water: a berry pushed into the ground the way anyone does
  if (f.verb === "pour" && f.target === "sapling") {
    giveItems(w, a, "berry");
    if (!plant(w, a, { verb: "plant", items: ["berry"], tool: null }).later) return "nowhere to plant something to water";
  }
  for (const k of f.inputs) giveItems(w, a, k);
  if (f.tool) giveItems(w, a, f.tool);
  return null;
}

// What's been put into the ground (planted, or watered as a seedling), waiting to come up or wither.
type Sown = { key: string; id: string; at: number; now: string[]; took: number; open: string[] };
const sown: Sown[] = [];
// One try of a way, under the sky and the wind given it, cleaned up after: whatever it added to the island (the fire it
// lit, the pit, the shelter it stood by) goes, save a seedling still to show what comes of it. A tree it felled stays
// felled, a few hundred on an island of millions.
async function attempt(key: string, rain: boolean, gale: boolean) {
  const plan = plans[key], f = plan.belief.fields, sky = w.weather.sky, speed = w.weather.speed, from = w.nextId;
  w.weather.sky = rain ? "rain" : "clear";
  // a fresh copy of the stand-in each time: nothing the last try left in their hands, and nothing worked out for them
  // this tick (the light and air on them) carries over
  const a: Agent = { ...stand, inv: [], needs: { ...stand.needs }, heading: Math.random() * Math.PI * 2 };
  const bar = setUp(plan, a);
  w.weather.speed = 18;
  const open = [...(sheltered(w, a) ? [] : ["rain"]), ...(airAt(w, a.px, a.py).wind > 8 ? ["wind"] : [])];
  w.weather.speed = gale ? 18 : 2;
  const now = conditionsNow(w, a, f.verb);
  const r = bar ?? (await tryAct(w, a, plan.belief));
  let keep: string | undefined;
  if (typeof r === "string") plan.reasons[r] = (plan.reasons[r] ?? 0) + 1;
  else if (r.out.later && (f.verb === "plant" || f.verb === "pour")) {
    // what shows later is judged where it went in, when it shows
    const t = thingById(w, r.out.later)!;
    t.owner = undefined;
    keep = t.id;
    sown.push({ key, id: t.id, at: w.t, now: conditionsNow(w, a, f.verb, t), took: r.took, open });
  } else plan.trials.push({ now, worked: r.worked, took: r.took, open });
  // what the try made took the ids from nextId on: look those up, never the whole island's things
  for (let n = from; n < w.nextId; n++) { const t = thingById(w, `t${n}`); if (t && t.id !== keep) removeThing(w, t); }
  w.weather.sky = sky;
  w.weather.speed = speed;
}

// A day's tries, each way's at hours of their own, so the dark falls on some of a day's tries and not others and what
// the days after bring (a drought, a frost) can't side with it. Rain and the gale go round in turn through a way's tries
// of the day, so no day's luck sides with them either.
type Due = { key: string; rain: boolean; gale: boolean };
const due = new Map<number, Due[]>();
function schedule(start: number, end: number) {
  for (const [key, plan] of Object.entries(plans)) {
    if (plan.why) continue;
    for (let i = 0; i < per; i++) {
      const t = start + Math.floor(Math.random() * (end - start)), list = due.get(t) ?? [];
      list.push({ key, rain: i % 2 === 0, gale: (i >> 1) % 2 === 0 });
      due.set(t, list);
    }
  }
}

const t0 = performance.now();
// the world starts some hours into its first day: its tries come in what's left of it
schedule(w.t + 1, DAY);
while (w.t < (days + 30) * DAY) {
  w.t++;
  ecology(w);
  changed.clear(); removed.clear(); newKinds.clear(); trailChanges.clear();
  // ground looked at a day ago and left as it grew goes back to the generator's arrays, as in a running world
  if (w.t % DAY === DAY / 2) shelve(w);
  if (w.t % DAY === 0 && w.t < days * DAY) schedule(w.t, w.t + DAY);
  for (const d of due.get(w.t) ?? []) await attempt(d.key, d.rain, d.gale);
  due.delete(w.t);
  if (w.t % 12) continue;
  // come up, withered, or 30 days in the ground and still a seedling (counted neither way)
  for (let i = sown.length - 1; i >= 0; i--) {
    const s = sown[i], t = thingById(w, s.id), came = !!t && t.kind !== "sapling";
    if (t && !came && w.t - s.at < 30 * DAY) continue;
    sown.splice(i, 1);
    if (t && !came) continue;
    const plan = plans[s.key];
    plan.trials.push({ now: s.now, worked: came, took: s.took, open: s.open });
    if (t && came) plan.grew[t.kind] = (plan.grew[t.kind] ?? 0) + 1;
  }
}

const tally = (ts: Trial[]): Tally => ({ n: ts.length, wins: ts.filter((t) => t.worked).length, ticks: ts.reduce((s, t) => s + t.took, 0) });
// The tries each condition is judged over, so that it takes no blame for what comes with it. The weather is judged only
// over tries when no other weather held: rain soaks the tinder whatever the hour, and rain clouds darken the day, so dark
// would take the blame for it. So dark and cold, which come with the hour and the season and go together at night and in
// winter, are each judged without the other; and dark not in the shade of trees either, which darkens a spot before the
// rest. Rain and wind are judged only over the tries they could have reached: under a roof it never rains on anyone, and
// a gale is felt only on open ground, which is ground of its own sort. What's in a spot itself is judged as it falls.
const WEATHER = ["rain", "dark", "cold", "wind"];
const ways: Record<string, Way> = {};
for (const [key, plan] of Object.entries(plans)) {
  const f = plan.belief.fields, ts = plan.trials, conds: Record<string, Cond> = {};
  const reason = Object.entries(plan.reasons).sort((x, y) => y[1] - x[1])[0]?.[0];
  const why = plan.why ?? (!ts.length ? reason ?? "never tried" : undefined);
  for (const c of new Set([...WEATHER, ...ts.flatMap((t) => t.now)])) {
    const over = !WEATHER.includes(c) ? ts : ts.filter((t) =>
      !t.now.some((o) => o !== c && (WEATHER.includes(o) || (c === "dark" && o === "shade"))) && ((c !== "rain" && c !== "wind") || t.open.includes(c)));
    const inn = ts.filter((t) => t.now.includes(c)), rest = ts.filter((t) => !t.now.includes(c));
    conds[c] = { in: tally(inn), out: tally(rest), verdict: judge(tally(over.filter((t) => t.now.includes(c))), tally(over.filter((t) => !t.now.includes(c)))) };
  }
  // a planting's aim, if no run saw one come up: what came up here
  const grew = Object.entries(plan.grew).sort((x, y) => y[1] - x[1])[0]?.[0];
  const aim = f.builds ?? (Object.keys(plan.belief.out).sort().join("+") || grew || "");
  ways[key] = { verb: f.verb, aim, at: f.at ?? "-", all: tally(ts), conds: ts.length ? conds : {}, ...(why ? { why } : {}) };
}
const key: AnswerKey = { seed, days, trials: Object.values(ways).reduce((s, x) => s + x.all.n, 0), ways };
writeFileSync(out, JSON.stringify(key, null, 1) + "\n");
const whys = Object.entries(ways).filter(([, x]) => x.why);
console.error(`seed ${seed}: ${Object.keys(ways).length - whys.length} ways tried, ${key.trials} trials, ${whys.length} with why, ${((performance.now() - t0) / 1000).toFixed(0)} s`);
for (const [k, x] of whys) console.error(`  ${k}: ${x.why}`);
process.exit(0);
