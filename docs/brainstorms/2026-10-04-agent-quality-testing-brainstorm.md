---
date: 2026-10-04
topic: agent-quality-testing
---

# Making sure the agents keep getting better

Status: discussion draft. Not requirements yet; the questions at the end decide its shape.

## The foundation is right

The agents already run a small scientific method:
- Every way of doing something keeps a record, all told and per condition they could see (src/sim/sim.ts `judged`).
- A condition becomes a suspect only when it did worse there by more than a standard error, or the failure points at it (src/sim/beliefs.ts `worseIn`).
- A theory goes when their own success, someone else's, or their record tells against it (`fades`, and "watched").
- When they're safe they test what they blame, and the planner weighs each way by its odds, with hope for the little-tried (src/sim/plan.ts).

That's a learner with a convergence property, which is what you described. scripts/theories.ts and scripts/theory-report.ts already measure it against the world's rules and a planting experiment (scripts/plant-truth.ts). So we have the two things most agent evals lack: an answer key that comes from the world, and a time axis. We can test how fast agents converge, not only where a run ends up.

## What stops it being a test today

1. **It's an instrument, not a gate.** Someone reads a wide table. Nothing passes or fails, no baseline is stored, there's no trend across commits.
2. **Runs can't be replayed.** Over 80 lines in src/sim call `Math.random()` unseeded. Offline rounds of nearly the same build ranged from 21 to 29 cold deaths (napkin). A bad run can't be re-run, and a baseline and a change can't share their random draws.
3. **Part of the answer key is hand-written and goes stale.** `truth()` in scripts/theory-report.ts hard-codes that dark and wind hurt nothing and that rain only hurts fire made by rubbing or striking. Planting and watering are judged by experiment, digging and dipping things in the cold by what agents saw, everything else by those hand-written rules. When the physics changes, the scorer silently calls correct agents wrong.
4. **It scores being right, not being efficient.** The planner already minimizes expected time: a way costs its learned duration over its odds (src/sim/plan.ts). The report scores "within 15 points of the surest way", so a faster, slightly less sure choice counts as regret. The attempt log carries a belief's average duration, not how long that attempt took, so costs like the dark never show in the report: in full dark `fumbles()` (src/sim/sim.ts) throws away 80% of each tick's work.
5. **A harder world looks like a worse learner.** A harsher winter, a new hazard or a new soil model moves success and deaths, and nothing separates that from agents learning worse.
6. **Coverage is hand-picked.** Three lessons are tracked: shade, crowded, rain-fire. A new mechanic isn't scored until someone writes it in.
7. **Too slow to run per change.** 16 worlds of 120 days, 1 to 1.5 GB each by day 30, at most 8 at once.

## One pushback

"Continuously improving" can't mean raw numbers going up: every new mechanic makes the world harder, and a gate on raw numbers would punish adding them. What we can hold steady is the learner: in any world, agents converge toward the best way, recover when the best way changes, and no change makes them learn worse on a fixed benchmark.

And not everyone should end up right. DESIGN.md wants superstition, and wrong beliefs that spread by gossip like true ones. I'd test that truth wins on average and over time (the share holding the right lesson rises, wrong theories die faster than right ones), not that every person is right.

## Ideas

### Make every run replayable
- One seeded generator in place of `Math.random` for the whole run. A failing case re-runs exactly, and a baseline and a candidate on the same seed share their draws. With the offline brain a run should then replay exactly (unverified); Jev's answers stay a source of variation.

### Let the world write the answer key
- Generalize plant-truth.ts to every way of doing things and every condition: a stand-in does it in controlled trials with and without each condition, and the table records how often it works and how long it takes. The table regenerates from the physics, so it can't go stale, and a new verb or condition is covered the day it lands. `truth()` goes away.

### Measure what "optimal" means
- **One currency: expected time to the end.** Score each choice by the expected time to get what they were after, under the true odds and durations, against the best way available. It's what the planner already minimizes, so the agents and the scorer agree on what good is.
- **Two regrets.** Choice regret: against the best way they knew. Discovery regret: against the best way the world allows (known exactly in probes; in whole worlds, the best anyone found across all runs). Striking plain stone for sparks with flint nearby, which sparks three times as often, is discovery regret.
- **Curves, not end states.** Report per try and per ten days, and pass on the shape: regret per try falling, wrong theories short-lived, right ones kept.

### Probes: small worlds with a known optimum
Staged scenarios, a few agents on a small patch for a few days, where we set the truth and so know the optimum exactly. Each passes or fails on its learning curve over many seeds. They should take minutes rather than hours (unmeasured), so they can run on every sim change. A starting set:
- **Choose:** two ways to fire with different odds and speeds. Do they settle on the one that's faster in expected time, and by which try?
- **Blame:** one condition hurts, three don't. Is the right theory formed and the wrong ones dropped, and by which try?
- **Confounded:** rain falls mostly at night and only rain hurts. `worseIn` compares in and out of each condition alone, so I'd expect the dark to get blamed too (unverified; this probe tells).
- **Delayed:** results that show days later. Does the credit land on the right spot?
- **Social:** one person knows, one believes wrongly, and they teach and watch. Which belief spreads?
- **Recover:** let them converge, then change the rule. How long until the old theory goes and the new one forms? This tests the self-correction you described directly.

Every behaviour bug the tech runs found (76 sticks on one hut, hours of rubbing in the rain) becomes a probe too, so it can't come back.

### Make it hard to fake
- **Flipped physics.** Run the probes in worlds where the rule is different: wind kills sparks instead of rain, berries like shade. A learner with the answer baked in passes our world and fails the flipped one; a real learner passes both. It's mutation testing aimed at the learner: change a rule, check the beliefs follow. This is the main guard against the cheapest way to raise every score, which is hard-coding what's true (DESIGN.md: knowledge is observation, not labels). With Jev it also measures how long evidence takes to beat Jev's real-world sense.
- **Floor and ceiling for whole worlds.** Run the same seeds with learning off (floor) and with people who know the answer key from day one (ceiling). Report the share of the gap the real agents close, and how fast. A harder world moves the floor and ceiling too, so this separates the learner from the world, the trick behind human-normalized Atari scores.
- **Check the cheap brain against the real one.** The offline brain is a poor stand-in for Jev at surviving winter (napkin). If the offline tier ranks changes differently from the Jev tier, the cheap gate is lying and needs fixing.

### Make it continuous
- **A ratchet.** Every eval is stored with its commit. A change is compared with the baseline over paired seeds, with confidence intervals: a real regression fails it, a clear improvement moves the baseline up. Thresholds come from the measured spread, not guesses. This replaces the napkin's "run 6 to 10 offline seeds and 3 Jev seeds, then read the dumps" with a verdict.
- **A trend.** One line per commit, charted (a page like history.html would do).
- **The live world as a free Jev run.** It already writes its trace to data/logs/trace.jsonl (DESIGN.md), which should hold the same theory events. Scored daily, it's a Jev curve at no extra cost: one uncontrolled world, so a monitor, not a gate.
- **Theory churn as a health signal.** When people keep forming and dropping the same theory, or a way stays "unclear", either something they can't perceive drives it or the physics is inconsistent. The rain theory flipping on and off (fixed in 4d247a7) was exactly that. Churn per way finds sim bugs and unlearnable rules for free.

## Three ways to build it

**A. Ratchet the whole-world report.** Seeds, headline numbers with intervals, stored baselines; 16 offline worlds nightly and a few Jev worlds weekly on the GoldClaw host.
- Good: reuses everything; tests the real game.
- Bad: hours per verdict; noisy; can't tell a harder world from a worse learner; no known optimum; easy to game.
- Suits: wanting an alarm, not an explanation.

**B. Probes with an answer key, plus a thin whole-world tier.** Seeded runs, the experiment answer key, and probes with flipped and changing rules as the gate on every sim change; whole worlds with floor and ceiling nightly; the ratchet over both.
- Good: fast; exact regret; says which skill broke; hard to fake.
- Bad: probes are artificial; needs a way to stage scenarios and flip a rule; new mechanics want new probes, though the experiment answer key covers their scoring.
- Suits: knowing the agents learn, and why when they don't.

**C. A loop that improves the agents by itself (challenger).** B as the fitness test. An agent proposes changes to the learning (theory statistics, planner, Jev questions), tries each in a worktree, keeps only what beats the baseline, and records kept and dropped changes in a ledger, the way the agents keep theories.
- Good: actually continuous; improvements compound without you.
- Bad: the most exposed to gaming the score; costs Jev; only safe once B is trusted; needs a check that changes keep to DESIGN.md's rules.
- Suits: after B has run long enough to trust.

## Recommendation

B now, C later. A tells you something changed but not what, and can't tell a harder world from a worse learner. The flipped-physics probes in B are what make the scores hard to fake, which matters most once something like C is chasing them.

| Tier | Checks | When | Cost |
| --- | --- | --- | --- |
| Unit tests (plan, garden and beliefs tests exist) | each mechanism does what it says | every change | seconds |
| Probes | convergence to a known optimum, recovery from a changed rule, flipped physics | every sim or brain change | minutes, offline |
| Whole worlds | the same in the real game, between floor and ceiling | nightly offline, Jev less often | hours |
| Live world | the live Jev world's curves from its own trace | daily | free |

Order: seeded runs and the experiment answer key with durations first (they fix replay and staleness in what exists, and make expected-time scoring possible), then the choose, blame, confounded and recover probes with one flipped variant each, then the ratchet, then the nightly whole worlds with floor and ceiling, and the live monitor.

## Questions that decide the shape

1. What does "continuously improving" mean first: a gate on our changes (nothing lands that makes learning worse), a monitor on running worlds, or a loop that improves the agents by itself?
2. Is efficiency (time and effort to reach an end) the target, or is being right enough for now?
3. How much Jev for the expensive tier: weekly, per release, or on demand?
4. How much wrongness is a feature: is truth winning on average enough, or should every person converge?
