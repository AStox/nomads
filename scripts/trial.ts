// One try of a way of doing things, by someone standing where they are with what they hold, run the way sim.ts runs a
// plan's act step: tick by tick until it comes off or doesn't. The world's clock stands still meanwhile, so whatever
// conditions hold at the start hold for the whole try. scripts/truth.ts tries every way this way for the answer key, and
// scripts/probes.ts tries a probe's ways to know which is truly faster.
import type { Agent, Step, World } from "../src/sim/world";
import type { Outcome } from "../src/sim/physics";
import { actFromBelief, doAct } from "../src/sim/sim";
import { cameOff, type Belief } from "../src/sim/beliefs";

export type Try = { worked: boolean; took: number; out: Outcome };

// Whether it came off as meant (beliefs.ts cameOff) and the ticks it took, or why it couldn't be done. A combination the
// rules don't cover waits on a ruling, which settles between ticks: hence the await.
export async function tryAct(w: World, a: Agent, b: Belief, max = 400): Promise<Try | string> {
  const s: Step = { op: "act", key: b.key, arg: b.key, progress: 0, started: w.t, act: actFromBelief(b) };
  for (let took = 1; took <= max; took++) {
    const r = doAct(w, a, s);
    if (typeof r === "object") return { worked: cameOff(b, r), took, out: r };
    if (r !== "wait") return r;
    await null;
  }
  return "it never came to an end";
}
