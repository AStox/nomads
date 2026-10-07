// The switch that runs whole worlds with learning off or known from the start (scripts/evals.ts worlds), and where a
// probe stages its world (scripts/probes.ts). Nothing here says what works: every outcome comes of the physics. The live
// world never changes them.
import type { Agent, World } from "./world";

export const RULES = {
  // how people come by their theories of why things fail: from what they see (as in the world); never (learning off,
  // the floor a world is measured against); or knowing from the start what truly hurts each way (the ceiling), by
  // `truth`, the answer key's conditions that hurt each belief key (scripts/truth.ts)
  learning: "seen" as "seen" | "off" | "known",
  truth: {} as Record<string, string[]>,
};

// Where a probe steps in: the weather just after each hour's turn of the sky (ecology.ts), and what people weigh doing
// (sim.ts feasible).
export const hooks: {
  weather?: (w: World) => void;
  options?: (w: World, a: Agent, opts: Record<string, string>) => void;
} = {};
