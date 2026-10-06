// The few rules of the world a probe can set otherwise (scripts/probes.ts), to see whether people learn what is so
// rather than what we wrote, and the switch that runs whole worlds with learning off or known from the start
// (scripts/evals.ts worlds). The live world never changes them.
import type { Agent, Thing, World } from "./world";

export const RULES = {
  // what keeps tinder from catching, the first that holds where they are (none at all, for a probe of bad luck alone):
  // each a condition anyone can see they're in (sim.ts CONDITIONS: rain, wind, dark, cold), or several joined by "+",
  // any of them written with "!" before it for its lack, which holds only when every part does ("dark+rain" for rain
  // at night, "rain+!wind" for rain unless the wind is up). In the world, wet tinder in the rain with nothing overhead.
  quench: ["rain"] as string[],
  // whether a fire that wouldn't catch shows why (sparks hissing out in the wet tinder), or only that it didn't
  tell: true,
  // which of two hard stones struck together throws more sparks: the harder, as in the world, or the softer
  sparks: "harder" as "harder" | "softer",
  // how people come by their theories of why things fail: from what they see (as in the world); never (learning off,
  // the floor a world is measured against); or knowing from the start what truly hurts each way (the ceiling), by
  // `truth`, the answer key's conditions that hurt each belief key (scripts/truth.ts)
  learning: "seen" as "seen" | "off" | "known",
  truth: {} as Record<string, string[]>,
};

// Where a probe steps in: the weather just after each hour's turn of the sky (ecology.ts), what people weigh doing
// (sim.ts feasible), and what becomes of each seedling (ecology.ts plants): it comes up now, withers now, or neither yet
// (wait), through the same paths as in the world; or, undefined, whatever its spot makes of it, as in the world.
export const hooks: {
  weather?: (w: World) => void;
  options?: (w: World, a: Agent, opts: Record<string, string>) => void;
  seedling?: (w: World, t: Thing) => "up" | "withered" | "wait" | undefined;
} = {};
