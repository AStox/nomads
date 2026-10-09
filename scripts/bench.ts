// How fast the sim runs, and proof that a change made it faster without changing what it does: a few fixed workloads,
// each timed, each ending in a checksum of what came of it (the world, or a probe's numbers, and the next draw of the
// seeded random stream, which any change in what was decided would move). Same checksum before and after a change:
// the same world, only quicker.
//   NOMADS_BRAIN=random bun scripts/bench.ts [--only make,seed,blame,world,spread] [--days 20]
// Profile one: NOMADS_BRAIN=random bun --cpu-prof-md --cpu-prof-dir=/tmp/prof scripts/bench.ts --only seed
import { DAY, TILE_M, addThing, dryAt, newWorld, type Thing, type World } from "../src/sim/world";
import { tick } from "../src/sim/sim";
import { bedAir, changed, fireOf, newKinds, removeThing, removed } from "../src/sim/physics";
import { ecology, trailChanges } from "../src/sim/ecology";
import { advance } from "../src/sim/combustion";
import { REF } from "../src/sim/wetness";
import { airAt } from "../src/sim/air";
import { canopyAt } from "../src/sim/light";
import { around, liveThings } from "../src/sim/space";
import { hooks } from "../src/sim/rules";
import { traceListeners, type TraceEntry } from "../src/sim/trace";
import { runProbe } from "./probes";
import { seedRandom } from "./seeded";

const arg = (name: string, d: string) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : d; };
const only = arg("only", "make,blame,seed,world,spread").split(","), days = Number(arg("days", "20"));
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
  // A grass fire through a field, staged as fire.test.ts stages its spread cases: open, dry ground cleared for 60 m
  // round; 60 ranks of 31 cured tussocks 1.5 m across, 1.2 m apart so they touch as standing grass does (the island's
  // own lie too far apart to carry a fire); dead stuff at 10%, the most a struck spark catches in; and a campfire at the
  // field's west edge, lit in still air, burning two minutes before the land's 90th-percentile wind gets up, 6.9 m/s at
  // head height (fire-constants sec. 25), blowing east and a little across, for an hour.
  spread: async () => {
    seedRandom(7);
    const w = newWorld(5);
    w.agents = [];
    const m = (meters: number) => meters / TILE_M;
    let speed = 1;
    const pin = (x: World) => {
      Object.assign(x.weather, { sky: "clear", wind: { dx: 1, dy: 0.25 }, speed });
      x.weather.dead = { open: REF.map(() => 0.1), shade: REF.map(() => 0.1) };
      x.weather.gsi = { day: Math.floor(x.t / DAY), tmin: -5, vpd: 500, rain: 10, index: 0 };
    };
    pin(w);
    let at: { px: number; py: number } | undefined;
    for (let k = 0; k < 400 && !at; k++) {
      const px = 40.5 + 3 * (k % 20), py = 40.5 + 3 * Math.floor(k / 20);
      if (dryAt(w, px, py) && dryAt(w, px + m(60), py) && canopyAt(w, px, py) === 0 && airAt(w, px, py).wind >= 0.8) at = { px, py };
    }
    if (!at) throw new Error("no open ground");
    const cleared: Thing[] = [];
    around(w, at.px + m(40), at.py, 60, null, (t) => { cleared.push(t); });
    for (const t of cleared) removeThing(w, t);
    for (let i = 0; i < 60; i++) for (let j = -15; j <= 15; j++) addThing(w, "grass", at.px + m(1.5 + 1.2 * i), at.py + m(1.2 * j), { size: 1.5 });
    speed = 0; pin(w);
    const f = fireOf(w, at.px, at.py);
    f.bed = advance(f.bed!, 120, bedAir(w, f));
    speed = 1; pin(w); w.t++;
    speed = 6.9 / airAt(w, at.px, at.py).wind; pin(w);
    hooks.weather = pin;
    let spread = 0;
    const watch = (e: TraceEntry) => { if (e.sys === "fire" && e.kind === "spread") spread++; };
    traceListeners.push(watch);
    try {
      for (let i = 0; i < 12; i++) { w.t++; ecology(w); changed.clear(); removed.clear(); trailChanges.clear(); }
    } finally {
      hooks.weather = undefined;
      traceListeners.splice(traceListeners.indexOf(watch), 1);
    }
    return hash(JSON.stringify({ spread, burning: [...liveThings(w)].filter((t) => !!t.bed).length, world: stateOf(w) }));
  },
};
for (const name of only) {
  const t0 = performance.now();
  const sum = await WORK[name]();
  console.log(JSON.stringify({ work: name, secs: Math.round((performance.now() - t0) / 100) / 10, check: `${sum}:${Math.random().toFixed(12)}` }));
}
process.exit(0);
