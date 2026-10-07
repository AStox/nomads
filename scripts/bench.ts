// How fast the sim runs, and proof that a change made it faster without changing what it does: a few fixed workloads,
// each timed, each ending in a checksum of what came of it (the world, or a probe's numbers, and the next draw of the
// seeded random stream, which any change in what was decided would move). Same checksum before and after a change:
// the same world, only quicker.
//   NOMADS_BRAIN=random bun scripts/bench.ts [--only make,seed,blame,world] [--days 20]
// Profile one: NOMADS_BRAIN=random bun --cpu-prof-md --cpu-prof-dir=/tmp/prof scripts/bench.ts --only seed
import { DAY, newWorld, type World } from "../src/sim/world";
import { tick } from "../src/sim/sim";
import { changed, newKinds, removed } from "../src/sim/physics";
import { trailChanges } from "../src/sim/ecology";
import { runProbe } from "./probes";
import { seedRandom } from "./seeded";

const arg = (name: string, d: string) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : d; };
const only = arg("only", "make,blame,seed,world").split(","), days = Number(arg("days", "20"));
const hash = (s: string) => Bun.hash(s).toString(36);
// What a world came to: its clock, its people (where they are, what they need and hold, what they know and think), what
// stands on it and roams it.
const stateOf = (w: World) => hash(JSON.stringify({
  t: w.t, things: w.things.length, laws: Object.keys(w.laws).length,
  agents: w.agents.map((a) => ({ id: a.id, px: a.px, py: a.py, needs: a.needs, inv: a.inv, beliefs: a.beliefs })),
  animals: w.animals.map((m) => [m.species, m.px, m.py]),
}));
const WORK: Record<string, () => Promise<string>> = {
  make: async () => hash(JSON.stringify(newWorld(1, 6))),
  blame: async () => hash(JSON.stringify((await runProbe("blame", "real", 1, 5, 6, "random")).metrics)),
  seed: async () => hash(JSON.stringify((await runProbe("seed", "real", 1, 5, 6, "random")).metrics)),
  world: async () => {
    seedRandom(1);
    const w = newWorld(1);
    for (let i = 0; i < days * DAY; i++) {
      tick(w);
      changed.clear(); removed.clear(); newKinds.clear(); trailChanges.clear();
      // as scripts/theories.ts runs a world: what people are thinking over comes to them every few ticks
      if (i % 4 === 0) await Bun.sleep(0);
    }
    return stateOf(w);
  },
};
for (const name of only) {
  const t0 = performance.now();
  const sum = await WORK[name]();
  console.log(JSON.stringify({ work: name, secs: Math.round((performance.now() - t0) / 100) / 10, check: `${sum}:${Math.random().toFixed(12)}` }));
}
process.exit(0);
