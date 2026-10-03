// How people's theories of why things fail hold up, and whether what they do gets better for them: run one world
// headless and write, as JSON lines, every attempt judged (what was done, the conditions, whether it worked), every
// planting as it goes in, every theory formed, dropped, taught or put to the test, and each day the theories everyone
// alive holds. scripts/theory-report.ts pools many
// runs into the world's own odds and scores the theories, and the attempts, against them.
//   NOMADS_BRAIN=random bun scripts/theories.ts --seed 3 --days 80 --out /tmp/theories/3.jsonl
import { DAY, newWorld } from "../src/sim/world";
import { tick } from "../src/sim/sim";
import { changed, newKinds, removed } from "../src/sim/physics";
import { trailChanges } from "../src/sim/ecology";
import { traceListeners } from "../src/sim/trace";
import { asking, brainKind } from "../src/sim/brain";

const arg = (name: string, d: string) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : d; };
const seed = Number(arg("seed", "1")), days = Number(arg("days", "80")), out = arg("out", `/tmp/theories/${seed}.jsonl`);
const w = newWorld(seed);
const lines: string[] = [];
traceListeners.push((e) => {
  if (e.sys === "theory") lines.push(JSON.stringify({ ev: e.kind, t: e.t, agent: e.agent, ...(e.data as object) }));
  // a theory put to the test: offered among the goals, and taken up or not
  if (e.sys === "brain" && e.kind === "decided") {
    const d = e.data as { chosen: string; odds: Record<string, number> }, test = Object.keys(d.odds).find((k) => k.startsWith("test:"));
    if (test) lines.push(JSON.stringify({ ev: "test", t: e.t, agent: e.agent, goal: test, p: d.odds[test], chosen: d.chosen === test }));
  }
});
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
  lines.push(JSON.stringify({ ev: "day", t: w.t, day: d, alive: w.agents.length }));
  if (d % 20 === 0) console.error(`seed ${seed} day ${d}: ${Math.round((performance.now() - t0) / 1000)}s, ${w.agents.length} alive`);
  if (!w.agents.length) break;
}
await Bun.write(out, lines.join("\n") + "\n");
process.exit(0);
