// How far a world's people get up the tech tree: run one world headless and print, as one JSON line, the day each
// milestone was first reached, who is alive, what killed the rest, and where plans fail.
//   NOMADS_BRAIN=random bun scripts/tech.ts --seed 7 --days 120
// Many seeds at once: for s in 1 2 3 4; do NOMADS_BRAIN=random bun scripts/tech.ts --seed $s --days 120 & done; wait
// With Jev (TYPESAFE_API_KEY in .env), each tick waits for every question it asked, so the world runs as if Jev answered
// at once: bun scripts/tech.ts --seed 7 --days 10
import { DAY, newWorld, type World } from "../src/sim/world";
import { tick } from "../src/sim/sim";
import { changed, newKinds, removed } from "../src/sim/physics";
import { trailChanges } from "../src/sim/ecology";
import { counters } from "../src/sim/trace";
import { p } from "../src/sim/materials";
import { asking, brainKind } from "../src/sim/brain";

const arg = (name: string, d: string) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : d; };
const seed = Number(arg("seed", "1")), days = Number(arg("days", "120"));
const w = newWorld(seed);

const laws = (w: World) => Object.values(w.laws);
const made = (w: World, ok: (id: string) => boolean) => Object.values(w.kinds).some((k) => k.made && ok(k.id));
const kindIs = (w: World, ok: (k: World["kinds"][string]) => boolean) => Object.values(w.kinds).some((k) => k.made && ok(k));
const lawGives = (w: World, ks: string[]) => laws(w).some((l) => l.result?.gives.some((g) => ks.includes(g)));
const lawBuilds = (w: World, b: string, verbs?: string[]) => laws(w).some((l) => l.result?.builds === b && (!verbs || verbs.includes(l.verb)));
let maxTier = -1;
// Each milestone: true once the world has reached it. Checked every day; the first day it holds is kept.
const MILESTONES: Record<string, (w: World) => boolean> = {
  knapped: (w) => laws(w).some((l) => l.verb === "strike" && l.result?.gives.some((g) => ["sharp_stone", "flint_blade", "bone_shard"].includes(g))),
  pointed_stick: (w) => made(w, (id) => id.startsWith("rub:")),
  cord: (w) => kindIs(w, (k) => k.verb === "join" && (k.parts ?? []).every((id) => p(w.kinds[id], "fibrous") >= 0.6) && p(k, "binding") >= 0.8),
  hafted_tool: (w) => kindIs(w, (k) => k.verb === "join" && p(k, "sharp") >= 0.5 && p(k, "long") >= 0.5),
  fire_by_hand: (w) => lawBuilds(w, "fire", ["rub", "strike"]),
  campfire: (w) => lawBuilds(w, "fire"),
  torch: (w) => made(w, (id) => id.startsWith("burning:")),
  cooked: (w) => made(w, (id) => id.startsWith("cooked:")),
  shelter: () => maxTier >= 1,
  hut: () => maxTier >= 2,
  cabin: () => maxTier >= 3,
  hearth: (w) => lawBuilds(w, "hearth") || lawBuilds(w, "kiln"),
  clay_shaped: (w) => made(w, (id) => id.startsWith("shape:")),
  pottery: (w) => made(w, (id) => id.startsWith("fired:")),
  fired_pot: (w) => kindIs(w, (k) => k.id.startsWith("fired:") && p(k, "container") >= 0.6),
  stew: (w) => made(w, (id) => id.startsWith("stew:")),
  kiln: (w) => lawBuilds(w, "kiln"),
  charcoal: (w) => lawGives(w, ["charcoal"]),
  forge: (w) => lawBuilds(w, "forge"),
  bellows: (w) => laws(w).some((l) => l.verb === "heat" && l.key.split("|")[2] !== "-"),
  metal: (w) => made(w, (id) => id.startsWith("smelt:")),
  metal_blade: (w) => kindIs(w, (k) => k.id.startsWith("forge:") && p(k, "sharp") >= 0.8),
  glue: (w) => made(w, (id) => id.startsWith("melt:")),
  leather: (w) => made(w, (id) => id.startsWith("leather:")),
  bag: (w) => kindIs(w, (k) => k.verb === "join" && / bag tied with /.test(k.plain ?? k.name)),
  basket: (w) => kindIs(w, (k) => k.verb === "join" && p(k, "container") >= 0.6 && p(k, "fibrous") >= 0.6),
  wrap: (w) => kindIs(w, (k) => k.verb === "join" && / wrap laced with /.test(k.plain ?? k.name)),
  basket_fishing: (w) => laws(w).some((l) => l.verb === "wet" && l.result?.gives.includes("fish") && p(w.kinds[l.key.split("|")[1]], "container") >= 0.6),
  lamp: (w) => kindIs(w, (k) => k.verb === "join" && / wick$/.test(k.plain ?? k.desc ?? k.name)),
  sealed: (w) => kindIs(w, (k) => k.verb === "join" && / sealed with /.test(k.plain ?? k.desc ?? k.name)),
  fishing: (w) => laws(w).some((l) => l.verb === "wet" && l.result?.gives.includes("fish")),
  hunted_deer: (w) => laws(w).some((l) => (l.verb === "strike" || l.verb === "throw") && l.result?.target === "deer" && l.result.gives.length > 0),
  pit: (w) => lawBuilds(w, "pit"),
  trap: (w) => lawBuilds(w, "trap"),
  well: (w) => w.things.some((t) => t.kind === "well"),
  planted: (w) => w.events.some((e) => e.kind === "grow" && / pushed into the ground grew/.test(e.text)),
  clothing: (w) => laws(w).some((l) => l.verb === "wear" && l.result?.builds === "worn"),
  smoked: (w) => made(w, (id) => id.startsWith("smoked:")),
  gathered_grain: (w) => w.events.some((e) => e.kind === "gather" && / grains?\.$/.test(e.text)),
  ground_meal: (w) => kindIs(w, (k) => k.verb === "rub" && p(k, "edible") > 0),
  bread: (w) => kindIs(w, (k) => k.name === "bread"),
  sown_grain: (w) => w.events.some((e) => e.kind === "grow" && / sowed came up as grass/.test(e.text)),
  shot_with_bow: (w) => laws(w).some((l) => l.verb === "throw" && l.key.split("|")[2] !== "-"),
  camp: (w) => w.camps.length > 0,
  named_tool: (w) => kindIs(w, (k) => !!k.named && !!k.plain),
};
const reached: Record<string, number> = {};
const t0 = performance.now();
let births = 0;
for (let d = 1; d <= days; d++) {
  for (let i = 0; i < DAY; i++) {
    tick(w);
    changed.clear(); removed.clear(); newKinds.clear(); trailChanges.clear();
    // the random brain answers through promise chains: let them settle as the server's loop would
    if (i % 4 === 0) await Bun.sleep(0);
    // Jev's answers, and whatever they set off, all land before the next tick
    if (brainKind() !== "random") for (;;) { await Bun.sleep(asking() ? 10 : 0); if (!asking()) { await Bun.sleep(0); if (!asking()) break; } }
  }
  for (const t of w.things) if (t.kind === "structure" && t.shelter) maxTier = Math.max(maxTier, t.shelter.tier);
  for (const [name, ok] of Object.entries(MILESTONES)) if (!(name in reached) && ok(w)) reached[name] = d;
  if (d % 10 === 0) console.error(`seed ${seed} day ${d}: ${Math.round((performance.now() - t0) / 1000)}s, ${w.agents.length} alive, ${Object.keys(reached).length} milestones`);
  if (!w.agents.length) break;
}
births = w.events.filter((e) => e.kind === "born").length;
const causes: Record<string, number> = {};
for (const q of Object.values(w.people)) if (!q.alive) causes[q.cause ?? "?"] = (causes[q.cause ?? "?"] ?? 0) + 1;
const fails: Record<string, number> = {};
for (const e of w.events) if (e.kind === "fail" || e.kind === "stuck") { const why = e.text.replace(/^\S+ /, "").replace(/\.$/, ""); fails[why] = (fails[why] ?? 0) + 1; }
const top = (m: Record<string, number>, n: number) => Object.fromEntries(Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, n));
console.log(JSON.stringify({
  seed, days: Math.floor(w.t / DAY), secs: Math.round((performance.now() - t0) / 1000), alive: w.agents.length, everLived: Object.keys(w.people).length, births, deaths: causes,
  reached, missing: Object.keys(MILESTONES).filter((m) => !(m in reached)),
  laws: Object.keys(w.laws).length, ruled: laws(w).filter((l) => l.source === "jev").length, made: Object.values(w.kinds).filter((k) => k.made).length,
  animals: w.animals.reduce<Record<string, number>>((m, a) => ((m[a.species] = (m[a.species] ?? 0) + 1), m), {}),
  jev: w.jev, fails: top(fails, 8), counters: { stepFailed: counters["plan.step_failed"] ?? 0, interrupts: counters["plan.interrupt"] ?? 0, decided: counters["brain.decided"] ?? 0, tinker: counters["brain.tinker_choice"] ?? 0 },
}));
// --dump file: what this world's people found out, what they did, and what happened, to read through afterwards
const dump = arg("dump", "");
if (dump) {
  const kinds: Record<string, number> = {};
  for (const e of w.events) kinds[e.kind] = (kinds[e.kind] ?? 0) + 1;
  await Bun.write(dump, JSON.stringify({
    events: kinds,
    laws: Object.values(w.laws).map((l) => `${(l.t / DAY).toFixed(1)} ${l.by}: ${l.text}`),
    made: Object.values(w.kinds).filter((k) => k.made).map((k) => `${k.name} x${k.count ?? 1}`),
    structures: w.things.filter((t) => t.kind === "structure").map((t) => ({ owner: t.owner, tier: t.shelter?.tier, parts: t.parts })),
    notable: w.events.filter((e) => !["goal", "gather", "eat", "weather", "notice", "talk", "bond", "gossip", "level", "spoil", "grow", "birth", "death", "recover"].includes(e.kind)).map((e) => `${(e.t / DAY).toFixed(2)} ${e.kind}: ${e.text}`),
    goals: w.events.filter((e) => e.kind === "goal").map((e) => e.text.replace(/^\S+ decided to /, "").replace(/ \(\d+% likely\)$/, "").replace(/\. ?$/, "")).reduce<Record<string, number>>((m, g) => ((m[g] = (m[g] ?? 0) + 1), m), {}),
    agents: w.agents.map((a) => ({ name: a.name, inv: a.inv.map((s) => w.kinds[s.k]?.name), beliefs: Object.keys(a.beliefs).length, needs: a.needs })),
  }, null, 1));
}
process.exit(0);
