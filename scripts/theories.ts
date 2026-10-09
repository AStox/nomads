// How people's theories of why things fail hold up, and whether what they do gets better for them: run one world
// headless and write, as JSON lines, every attempt judged (what was done, the conditions, whether it worked, how long it
// took, whether it was a test), every planting as it goes in, every theory formed, dropped, taught or put to the test,
// every death and what it was of, each day the theories everyone alive holds and the water in the wood they hold (how
// far what they'll burn has seasoned), and at the end the things this world made and the rulings it settled, so
// scripts/truth.ts can try its ways. scripts/theory-report.ts pools many runs and scores them against the answer key.
//   NOMADS_BRAIN=random bun scripts/theories.ts --seed 3 --days 80 --out /tmp/theories/3.jsonl
// --learning off: nobody ever forms a theory (the floor a world is measured against); --learning known --key key.json:
// everyone knows from the start what truly hurts each way they learn (the ceiling). --rng: the run's own draws, when
// they should differ from the island's seed.
import { DAY, newWorld } from "../src/sim/world";
import { tick } from "../src/sim/sim";
import { changed, newKinds, removed } from "../src/sim/physics";
import { trailChanges } from "../src/sim/ecology";
import { traceListeners } from "../src/sim/trace";
import { asking, brainKind } from "../src/sim/brain";
import { RULES } from "../src/sim/rules";
import { moistureOf } from "../src/sim/wetness";
import { seedRandom } from "./seeded";
import { hurting, loadKey } from "./answer-key";

const arg = (name: string, d: string) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : d; };
const seed = Number(arg("seed", "1")), days = Number(arg("days", "80")), out = arg("out", `/tmp/theories/${seed}.jsonl`);
const learning = arg("learning", "seen");
if (learning !== "seen" && learning !== "off" && learning !== "known") throw new Error(`--learning ${learning}: seen, off or known`);
RULES.learning = learning;
if (learning === "known") RULES.truth = hurting(loadKey(arg("key", "")));
seedRandom(Number(arg("rng", String(seed))));
const w = newWorld(seed);
const lines: string[] = [];
traceListeners.push((e) => {
  if (e.sys === "theory") lines.push(JSON.stringify({ ev: e.kind, t: e.t, agent: e.agent, ...(e.data as object) }));
  // a theory put to the test: offered among the goals, and taken up or not
  if (e.sys === "brain" && e.kind === "decided") {
    const d = e.data as { chosen: string; odds: Record<string, number> }, test = Object.keys(d.odds).find((k) => k.startsWith("test:"));
    if (test) lines.push(JSON.stringify({ ev: "test", t: e.t, agent: e.agent, goal: test, p: d.odds[test], chosen: d.chosen === test }));
  }
  if (e.sys === "world" && e.kind === "died") {
    const d = e.data as { id: string; cause: string };
    lines.push(JSON.stringify({ ev: "died", t: e.t, agent: d.id, cause: d.cause }));
  }
});
// the wood people burn
const WOOD = new Set(["stick", "log", "plank"]);
const t0 = performance.now();
for (let d = 1; d <= days; d++) {
  for (let i = 0; i < DAY; i++) {
    tick(w);
    changed.clear(); removed.clear(); newKinds.clear(); trailChanges.clear();
    // what was planted (or watered) this tick, where it went in, whether or not it ever shows
    for (const a of w.agents) for (const e of a.waiting ?? []) if (e.t === w.t) lines.push(JSON.stringify({ ev: "sown", t: w.t, agent: a.id, key: e.key, now: e.now }));
    if (i % 4 === 0) await Bun.sleep(0);
    if (brainKind() !== "random") for (;;) { await Bun.sleep(asking() ? 10 : 0); if (!asking()) { await Bun.sleep(0); if (!asking()) break; } }
  }
  for (const a of w.agents) for (const b of Object.values(a.beliefs)) for (const c of b.unless ?? []) lines.push(JSON.stringify({ ev: "held", t: w.t, agent: a.id, key: b.key, cond: c }));
  const wood = w.agents.flatMap((a) => a.inv.filter((s) => WOOD.has(s.k)).map((s) => Math.round(moistureOf(s) * 1000) / 1000));
  if (wood.length) lines.push(JSON.stringify({ ev: "wood", t: w.t, day: d, m: wood }));
  lines.push(JSON.stringify({ ev: "day", t: w.t, day: d, alive: w.agents.length }));
  if (d % 20 === 0) console.error(`seed ${seed} day ${d}: ${Math.round((performance.now() - t0) / 1000)}s, ${w.agents.length} alive`);
  if (!w.agents.length) break;
}
// what this world made and settled, for trying its ways on the island afterwards
lines.push(JSON.stringify({ ev: "kinds", t: w.t, learning, kinds: Object.fromEntries(Object.entries(w.kinds).filter(([, k]) => k.made)), rulings: w.rulings }));
await Bun.write(out, lines.join("\n") + "\n");
process.exit(0);
