// The little statistics the eval scripts share: judging whether a condition hurts a way from counts in it and out of it
// (scripts/truth.ts, scripts/theory-report.ts), and intervals over seeds for comparing one build with another
// (scripts/evals.ts).
import { rng } from "../src/sim/world";
import type { Verdict } from "./answer-key";

type Count = { n: number; wins: number };

// A Wilson interval for a share, 90% two-sided by default.
export function wilson(wins: number, n: number, z = 1.645): [number, number] {
  if (!n) return [0, 1];
  const p = wins / n, d = 1 + (z * z) / n, c = p + (z * z) / (2 * n), m = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [(c - m) / d, (c + m) / d];
}

// A condition hurts when it works clearly less often in it than out of it (90% Wilson intervals apart, 15 points or
// more); it has no effect when there's enough of both and it does no more than 10 points worse in it, or better.
export function judge(inn: Count, out: Count): Verdict {
  const gap = out.wins / out.n - inn.wins / inn.n;
  if (inn.n >= 3 && out.n >= 3 && wilson(inn.wins, inn.n)[1] < wilson(out.wins, out.n)[0] && gap >= 0.15) return "hurts";
  return inn.n >= 8 && out.n >= 8 && gap <= 0.1 ? "no effect" : "unclear";
}

export const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);

// An interval for the mean of one number per seed (95% unless asked otherwise), by resampling the seeds: they are what
// varies from run to run. Seeded, so the same numbers always give the same interval.
export function bootstrap(xs: number[], level = 0.95, reps = 4000, seed = 1): [number, number] {
  if (xs.length < 2) return [NaN, NaN];
  const r = rng(seed), means: number[] = [];
  for (let i = 0; i < reps; i++) {
    let s = 0;
    for (let j = 0; j < xs.length; j++) s += xs[Math.floor(r() * xs.length)];
    means.push(s / xs.length);
  }
  means.sort((a, b) => a - b);
  const tail = (1 - level) / 2;
  return [means[Math.floor(reps * tail)], means[Math.ceil(reps * (1 - tail)) - 1]];
}
