---
date: 2026-10-04
topic: agent-quality-testing
---

# Making sure the agents keep getting better

Status: built (scripts/evals.ts and the scripts it runs; DESIGN.md "Testing that people learn"). The thinking behind it, the gaps and the approaches weighed are in docs/brainstorms/2026-10-04-agent-quality-testing-brainstorm.md.

## Problem Frame

The agents already run a small scientific method: a record per way of doing things, all told and per condition they could see (src/sim/sim.ts `judged`); a condition suspected only when it did worse there by more than a standard error, or the failure points at it (src/sim/beliefs.ts `worseIn`); a theory dropped when their own success, someone else's, or their record tells against it; tests of what they blame when they're safe; and a planner that weighs each way by its odds with hope for the little-tried. That is a learner with a convergence property, and scripts/theories.ts with scripts/theory-report.ts already measured it.

It was an instrument, not a test: a person read a wide table, nothing passed or failed, no baseline was stored, runs couldn't be replayed (over 80 unseeded `Math.random()` calls in src/sim), part of the answer key was hand-written and went stale with the physics (`truth()` said dark and wind hurt nothing), it scored being right and not being efficient, a harder world looked exactly like a worse learner, coverage was three hand-picked lessons, and a verdict took 16 worlds of 120 days.

"Continuously improving" can't mean raw numbers going up, since every new mechanic makes the world harder. What we hold steady is the learner: in any world people converge toward the best way, recover when it changes, and no change to the sim makes them learn worse on a fixed benchmark.

## Requirements

**Replay**
- R1. Every headless run seeds `Math.random` from the island seed (or `--rng`), so the same seed runs the same world with the offline brain.

**An answer key from the world**
- R2. The truth about every way people used (how often it works and how long it takes, in each condition and out of it, and whether the condition truly hurts) is found by trying it on the island, not written down. No hand-written rules remain in the scorer.
- R3. Planting is tried the same way (left to come up or wither); ways that can't be tried say why, and the report shows how much of what people did the key could judge.

**Measuring what optimal means**
- R4. Choices are scored in expected time to the end (a try's ticks over its odds, as the planner weighs them): choice regret against the best way they knew, discovery regret against the best way the world allows.
- R5. Tests are counted apart and not called waste; a theory formed again after being dropped (churn) is tracked.

**Probes with a known optimum**
- R6. Staged scenarios where the truth is set: choose (two ways, one faster), blame (one condition kills sparks), confounded (two conditions come together, only one is the cause, the failure doesn't say which), recover (the cause changes halfway), spread (some know the true cause, some were told a false one, some don't know how: which belief spreads).
- R7. Each probe also runs flipped (the rule otherwise), through one seam in the sim (src/sim/rules.ts) that the live world never changes, so a learner with the answer written in fails.

**A gate that only rises**
- R8. One command runs every probe over many seeds and compares each number with the baseline seed by seed, failing on a regression beyond tolerance with the whole 99% interval of the change on the worse side, or on losing a claim the baseline met.
- R9. A passing build with a clear improvement becomes the baseline. Each tier run is a file in evals/, committed with the code it judged, and a trend view charts them.

**Whole worlds and the live world**
- R10. Whole worlds run with learning as it is, off (the floor) and known from the start (the ceiling), each scored against its island's key, reporting the share of the gap the real people close.
- R11. The live world's own trace is scored the same way, as a monitor.
- R12. The offline brain, which every gate runs on, can be checked against Jev: the probes run with either, and a proxy view says whether the two moved the same way between builds.

## Success Criteria
- A deliberate regression in how people learn fails the probe gate, and the unchanged build passes it.
- A seed replays exactly.
- The flipped probes show learning wherever the as-is ones do.
- A verdict on a sim change takes minutes, not an evening of reading dumps.

## Scope Boundaries
- Not fixing what the probes find in how people learn (the first runs found the dark blamed alongside the rain at night, and old theories that outlive the change that made them true); that's the next piece of work, judged by this gate.
- No loop that changes the agents by itself yet (approach C in the brainstorm); it needs this gate trusted first, and a check that changes keep to DESIGN.md's rules.
- No new UI page: the trend is a terminal view.

## Key Decisions
- "Continuously improving" means first a gate on our changes (probes on every sim change), with whole worlds and the live world watched nightly. A self-improving loop is later.
- Efficiency is the target: scores are in expected time, the quantity the planner already minimizes.
- Jev runs only on demand (`--brain jev`), not on a schedule: a probe asks Jev about 90 times per person per day (about 180,000 tokens), so even a small Jev tier is millions of tokens.
- Truth winning on average is enough: the claims are about shares of people and trends over time, not every person being right. DESIGN.md wants superstition and wrong beliefs that spread.
- Flipped physics goes through one module (src/sim/rules.ts) with the world's own rules as defaults, so the live world and its saves are untouched (no VERSION bump).
- The ledger is a file per tier run, so runs on different machines never conflict when pushed.

## Outstanding Questions

### Deferred to Planning
- [Affects R11][Operational] Installing scripts/nightly.sh on the host: it needs its own checkout (pulling in the live service's checkout changes the live world) and the live data path.
- [Affects R6][Needs research] A probe for results that show days later (planting, judged by where the seed went in), with a flipped niche, and probes for the behaviour bugs the tech runs found (76 sticks on one hut, hours of rubbing in the rain) were in the brainstorm's starting set and aren't built: flipping what a plant needs touches the niche tables the island is grown from, which needs its own plan.

## Next Steps
Use the gate: `bun scripts/evals.ts probes` before committing any change to the sim; then the findings above are the first things to improve.
