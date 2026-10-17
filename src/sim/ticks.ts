// The island's clock: how long a tick lasts, and how many ticks make an hour, a day and a year. Everything that counts
// time in ticks counts it through here, so the CPU sim, the GPU laws, the harness and the page keep one clock. It imports
// nothing, so the GPU's kernel modules read it without pulling in the sim.
//
// Durations, cooldowns and speeds are written in seconds and become ticks through ticksOf; a chance or an amount that
// came once a tick is written as a chance or an amount over a stated span of seconds and becomes a tick's through chance
// and rate, which give back the very number they were handed when the span is a tick, so a world at today's tick runs
// exactly as it did when those numbers were written per tick.

// The clock for a tick of tickS seconds: built by a function so a test can look at the clock of another tick.
export function clockOf(tickS: number) {
  // A tick nests with the hour, and with fire's 10 s look and the minute (combustion.ts STEP, ecology.ts LOOK_S): one of
  // each pair divides the other, so a look or a minute never straddles two ticks unevenly.
  const nests = (s: number) => s % tickS === 0 || tickS % s === 0;
  if (3600 % tickS !== 0 || !nests(10) || !nests(60)) throw new Error(`a tick of ${tickS} s does not nest with 10 s, a minute and an hour`);
  const HOUR = 3600 / tickS, DAY = 86400 / tickS;
  return {
    TICK_S: tickS,
    HOUR,
    DAY,
    YEAR: DAY * YEAR_DAYS,
    // Whether tick t falls on a period of so many seconds: every tick when the period is a tick or shorter.
    every: (t: number, seconds: number) => seconds <= tickS || t % (seconds / tickS) === 0,
    // The chance over secs seconds (a tick unless a lane says otherwise, lanes.ts) of something that comes with chance p
    // over `over` seconds; p itself when the two are the same.
    chance: (p: number, over: number, secs = tickS) => (over === secs ? p : 1 - (1 - p) ** (secs / over)),
    // The share over secs seconds (a tick unless a lane says otherwise) of an amount x that comes over `over` seconds;
    // x itself when the two are the same.
    rate: (x: number, over: number, secs = tickS) => (over === secs ? x : (x * secs) / over),
    // Ticks in so many seconds.
    ticksOf: (seconds: number) => seconds / tickS,
  };
}

// Days in the island's year (sky.ts: the first ten spring, the year's pace in onDay).
export const YEAR_DAYS = 40;
// Five minutes a tick [design: the world's step since its first version; the real-time tick plan,
// docs/plans/2026-10-16-001-refactor-real-time-tick-plan.md, shortens it in its Phase C].
export const { TICK_S, HOUR, DAY, YEAR, every, chance, rate, ticksOf } = clockOf(300);
