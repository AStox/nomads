// The answer key: how often each way of doing things works on this island, in each condition anyone can see and out of
// it, and how long it takes, found by trying it rather than written down (scripts/truth.ts). scripts/theory-report.ts
// scores what people believed and chose against it, and a world run with learning known from the start (the ceiling,
// rules.ts RULES.learning) gives everyone its conditions that hurt.
import { readFileSync } from "node:fs";

export type Tally = { n: number; wins: number; ticks: number }; // trials, how many worked, ticks they took all told
export type Verdict = "hurts" | "no effect" | "unclear";
export type Cond = { in: Tally; out: Tally; verdict: Verdict };
export type Way = {
  verb: string;
  aim: string; // what it's for: what it builds, or the things it gives joined by +, as sim.ts judged names it
  at: string; // where it's done (a belief key's fifth field), "-" for anywhere
  all: Tally;
  conds: Record<string, Cond>; // rain, dark, cold, wind, and for what's done to the ground shade, dry, crowded, ground:*
  why?: string; // why it couldn't be tried, when it couldn't
};
export type AnswerKey = { seed: number; days: number; trials: number; ways: Record<string, Way> };

export const loadKey = (path: string): AnswerKey => JSON.parse(readFileSync(path, "utf8"));

// Whether a theory truly holds where a way is hurt, by the key; unclear where the key couldn't say. A theory of several
// conditions together, with exceptions ("rain+!wind", beliefs.ts holds), goes by the conditions it names it won't work
// in, the exceptions only narrowing it: right if one of those truly hurts, wrong if none does.
export const verdict = (k: AnswerKey, key: string, t: string): Verdict => {
  const named = t.split("+").filter((c) => !c.startsWith("!")).map((c) => k.ways[key]?.conds[c]?.verdict ?? "unclear");
  return named.includes("hurts") ? "hurts" : named.length && named.every((v) => v === "no effect") ? "no effect" : "unclear";
};

// Each way's conditions that truly hurt it, for RULES.truth.
export function hurting(k: AnswerKey): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [key, way] of Object.entries(k.ways)) {
    const bad = Object.entries(way.conds).filter(([, c]) => c.verdict === "hurts").map(([c]) => c);
    if (bad.length) out[key] = bad;
  }
  return out;
}

// The ticks it takes, on average, to get what a way is for in these conditions, trying again until it works: how long
// one try takes over the odds of a try working. As people weigh their own records (beliefs.ts chance), a way goes by
// the worst of the conditions it was tried in that hold, and by all its tries where none do; a try that never worked
// counts as working one time in fifty.
export function expectedTicks(way: Way, now: string[]): number {
  const tried = now.map((c) => way.conds[c]?.in).filter((t): t is Tally => !!t && t.n > 0);
  const odds = (t: Tally) => t.wins / t.n, ticks = (t: Tally) => t.ticks / t.n;
  const p = tried.length ? Math.min(...tried.map(odds)) : way.all.n ? odds(way.all) : 0;
  const t = tried.length ? Math.max(...tried.map(ticks)) : way.all.n ? ticks(way.all) : 0;
  return t / Math.max(p, 0.02);
}
