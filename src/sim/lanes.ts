// The lanes a tick runs its processes in: each process has its own period, runs on the ticks that fall on it, and is
// handed the seconds since it last ran (docs/plans/2026-10-16-001-refactor-real-time-tick-plan.md, Unit 5). A lane whose
// period is a tick or shorter runs every tick with a tick's seconds, so at a tick of five minutes every lane runs every
// tick with 300 s, in the order the tick has always run them, and a world runs as it did before there were lanes.
// Hourly and daily laws keep their own clocks (ticks.ts HOUR and DAY) and are not lanes.
import { LOOK_S } from "../gpu/wgsl/fire";
import { TICK_S, clockOf } from "./ticks";

// People's movement and acts, their glance for threats, and the animals they can see: the second [design: the plan's
// step for anything people chase or flee, where a deer fleeing at 8 m/s moves under half a hand throw's reach].
export const FAST_S = 1;
// Every burning bed steps one look of fire at a time (fire-constants sec. 28, wgsl/fire.ts LOOK_S).
export const FIRE_S = LOOK_S;
// Full perception, the journeys' points, the animals stood in people's sight, hot things cooling, and sickness
// [design: the plan's senses and bookkeeping lane].
export const SENSES_S = 10;
// The body through body.ts: heat, stores, sleep and the needs read off them [design: the plan's body lane; body.ts
// integrates in seconds and ran on 300 s steps before there were lanes].
export const BODY_S = 60;
// The GPU's begin and landing [design: the plan's 60 s; it divides the hour, so the hourly and daily laws fall on
// begins, and fire's look, so a landing tick is a fire tick].
export const LAND_S = 60;

// The lanes of a clock (ticks.ts clockOf): built by a function so a test can look at the lanes of another tick.
export function lanesOf(clock: { TICK_S: number; every: (t: number, seconds: number) => boolean }) {
  if (3600 % LAND_S || LAND_S % FIRE_S) throw new Error(`a landing every ${LAND_S} s must divide the hour and fall on fire's looks`);
  const secs = (period: number) => Math.max(period, clock.TICK_S);
  return {
    // Whether a lane of this period runs at tick t.
    due: (t: number, period: number) => clock.every(t, period),
    // The seconds a lane of this period is handed each time it runs: its period, or a tick when that is longer.
    secs,
    // Ticks from one landing to the next.
    landing: secs(LAND_S) / clock.TICK_S,
  };
}
export const { due, secs, landing: LANDING } = lanesOf(clockOf(TICK_S));
