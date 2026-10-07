---
date: 2026-10-07
topic: places-from-memory
---

# Choosing places from what people remember

## Problem Frame

Nobody in the sim remembers a place. Every destination is worked out from the world itself each time someone thinks.
- **Free knowledge within radii.** Inside fixed radii (800 m for things, 600 m for things lying about, 100 m for ground, 3 m for the spot itself) a person knows everything, whether they've seen it or not.
- **Goals gated by distance.** More fixed distances decide which goals are offered at all: prey within 400 m, a fire within 60 m, home within 150 m.
- **No places in the record.** Their record of tries is kept by condition, never by where.
- **A fallback into bad spots.** When no spot within 3 m suits their theories, they plant in an unsuitable one anyway.
- **One friend rule.** Distance from home and friends enters only one choice of place, and as a rule: a new shelter goes 6 to 15 m from the best-liked friend's home, or at home if that's within 150 m (sim.ts homesite, plan.ts BUILD_NEAR).

See docs/brainstorms/2026-10-07-places-from-memory-brainstorm.md.

People no longer forget a try, and the operator wants them to use all they remember for every decision. They should know only what they've seen, and choose among known places by what each means for their survival, with no fixed weights and no hard rules.

## Requirements

**What people know**
- R1. A person knows a place, and what is there, only once they've been there or seen it.
  - How far something can be made out follows from its size and the light, by formula, and hills and woods hide what's behind them.
  - What a spot's soil is like (dry, sour, limy, poor, thin, boggy, exposed, salty) they know only where they've stood.
  - Nothing is known for free within any radius. Exploring is how new places come to be known.
- R2. They know a place as it was when they last saw it. Something that moves, gets used up or goes is still where they saw it, to them, until either of these happens:
  - they see that spot without it;
  - for what they could recognise (a person, their own things, something distinctive), they see it somewhere else, and then they needn't go back to the old spot.
- R3. Nothing they've seen or done is forgotten. Every try keeps where it happened and what came of it, for good. A decision draws on all of it, not a recent slice.

**Choosing where**
- R4. Every place a decision sends someone to draws its candidates from what they know. No fixed radius, nearest-only shortcut, first-spot fallback or rule about friends is left in any of them. All of them move in one piece of work, covering at least:
  - planting and digging;
  - foraging;
  - gathering flint (a boulder seen studded with nodules is a place of its own), stones, sticks, reeds, clay, resin, bark and ore;
  - picking up things lying about;
  - working trees, stumps, logs and dead bushes;
  - fetching water;
  - making a fire, and going to a fire, hearth, kiln or forge;
  - going home to rest or warm up;
  - storing and sharing food, and the camp's store;
  - seeing to their seedlings and their pits;
  - building a shelter and moving home (the friend rule in homesite and move_home retires);
  - hunting and raiding;
  - finding a person.
- R5. Each candidate is weighed by what doing it there means for their survival, as they understand it:
  - **What they expect to come of it there,** from their theories and from their record by the conditions noticed there. What happened at that very spot counts as evidence about that spot, set against what its conditions say: one failure at a spot that looks like the rest says little.
  - **The time it takes to get there and back,** now and on every later trip the place will need (tending, picking, carrying home). That time is costed by what it does to them through the needs formulas: food, energy and warmth draining, and the cold out of shelter.
  - **What being out there means:** getting back before dark, the cold and wet of being caught out, wolves.
  - **How it stands to what keeps them alive:** home's stores, shelter and fire, and the help of others.

  Nothing about home or friends is a weight or a preference; they count only through what they do for survival. The one-day limit on a goal and giving up a foray at dark (sim.ts agentTick) give way to this reckoning, so a trip longer than the daylight left is weighed as a night out rather than cut off.
- R6. They foresee what they can work out from what they remember, with the world's own formulas:
  - how long the walk is, by walking's own routing over the ground they remember;
  - how much daylight is left;
  - the weather as they read it;
  - the cold of a night out;
  - the food in their store;
  - the shared warmth of sleeping near others.

  The uncertain parts they judge from their own record of what happened: wolves, whether someone will help, and whether a remembered thing is still where they saw it.
- R7. A spot a theory of theirs rules out is ruled out, except when they set out to test that theory, which plants just where it holds, as now. If no known place suits, they go and look, or do something else. Otherwise they never plant into a spot a theory of theirs rules out.
- R8. Remembered ground picks where to go, and the exact spot is chosen on arrival from what's in sight, by the same theories and reckoning, because shade and crowding change within a few metres.
- R9. What they choose to do at all takes account of what the places they know offer. A goal served by a good place close by is worth more than the same goal served only by a poor or distant one. Whether a goal is open at all depends on the places they know, not on a fixed distance.

## Success Criteria

- **Unseen things.** Someone who has never seen flint can't plan to fetch it. Once they've seen it they can, however far it is, and they can get there even if the trip takes more than a day.
- **Moved things.** Something that moved is looked for where they last saw it. They update when they see the empty spot, or when they first see elsewhere a thing they'd recognise.
- **Staged choices,** judged by truth from src/sim/formulas.ts:
  - With good ground known an hour or two's walk off and only bad ground at hand: when the walk, the daylight left and the cold of a night out say going pays, the planter goes, and when they say it doesn't, the planter stays.
  - Someone who knows a better place farther from home and a poorer one near it chooses as the reckoning says.
  - Nobody plants into a spot their theory rules out, except to test it.
- **Whole worlds.** People end up staying, planting and foraging near home and others, and settling into camps, because it pays, with no weight written for it. The worlds tier gains the measures to show it, taken on the round-five baseline's seeds before the change and after:
  - how far plantings and forays are from home and from others' homes;
  - deaths away from home and fire at night;
  - camps formed.
- **No peeking.** No decision code reads anything about the world that the person hasn't seen, except their own body and what's in sight now.
- **Planting probes.** The probes bound what their planters know to their own plot, judge every planting by the seedling formula wherever it lands, and report the share made off the plot. That keeps them testing learning, not exploring.
- **The gate.** Probe claims that hold at the round-five baseline still hold after the change, except any this document names as expected to move. Whole worlds are compared on the same seeds, and the bench shows the cost.

## Scope Boundaries

- People telling each other about places is a later step, alongside making talk carry theories (round five's hearsay finding).
- No new pathfinding or route map beyond what walking uses now. How long a trip is, and whether it can be made at all, are worked out with walking's own routing (walk.ts) over the ground they remember, not today's land and ice.
- What Jev is shown stays bounded: a relevant selection from full memory, not everything (see Outstanding Questions).

## Key Decisions

- **Only what they've seen.** Every decision rests on their own memory, and exploring matters. Early days may get harder, and that is accepted.
- **All place choices move together.** Anything left on the old radii would use knowledge people don't have.
- **As last seen, with no peeking.** Memory is of things as seen, and the world's present state stays hidden until seen again.
- **Survival, not preference.** Staying near home and others must emerge from foresight and experience. A weight for it would be the kind of hard rule round five removed, so the friend rule for shelters retires too.
- **Foresee and learn.** They work out what the world's formulas can tell them from what they remember, and learn what's uncertain from their own record.
- **A spot's own history is evidence, not a verdict.** A place's record is weighed against what its conditions say, so one unlucky failure doesn't drive planters off good ground.
- **Talk about places later.** This piece stays with each person's own memory.

## Dependencies / Assumptions

- A save from before this change seeds each person's memory from their journey, as it stands at load: everything within sight of where they walked. That way the live world doesn't wake knowing nothing. Journeys are kept forever and saved (src/sim/journeys.ts), though they record where someone has been better than when.
- Walking costs the body nothing today beyond the time it takes (needs() drains the same whether walking or standing). A trip's effort is therefore its time and what that time costs them.

## Outstanding Questions

### Deferred to Planning
- [Affects R1, R2][Technical] How memory is held:
  - remembered things by id, with their last-seen place, time and state (not Thing objects, since shelved tiles restock as new objects);
  - remembered ground by cell;
  - its size per person, how it's indexed for every kind of place, and what goes in the save (optional fields; VERSION stays).
- [Affects R1][Technical] The sight formula: how far each kind of thing and each look of ground can be made out, by size and light, and how hills and woods block it. canSee tests only distance and light today, and its ranges (25 to 800 m) were set for other uses.
- [Affects R4, R5][Technical] The planner holds one place per kind (plan.ts Ctx.dist, PState.at), and a goto re-finds its place by kind every tick (sim.ts run, spot). Where are candidates weighed, and how is the chosen place held on the step? It has to be an optional field so saved plans still load.
- [Affects R5, R6, R9][Technical] How the survival reckoning is expressed in the planner's cost so it stays comparable across goals, and how much of it can be cached between thinks. The cold of a night out, worked out inline in needs() today, gets pulled into a shared function both can use.
- [Affects R9][Technical] Goal choice is a Jev choice over option texts (brain.ts decide), with numeric leans only for the offline brain (needBias), and the planner runs only after a goal is chosen. How does what known places offer reach that choice, for both brains?
- [Affects R6][Needs research] Which records count as "what happened" for wolves, for help from others, and for remembered things still being there? Does what someone sees happen to another person count?
- [Affects R2, R6][Technical] Are things that change by the world's formulas between sightings (berries regrowing, grain ripening, soil drying) projected forward with those formulas, or held as last seen?
- [Affects R3][Technical] Today's caps (the event log at 12, a relationship's history at 10, waiting on a seedling at 30 days): which become uncapped, and which only stop being what decisions read?
- [Affects R3][Needs research] How Jev's view draws on full memory by relevance without the prompt growing.
- [Affects R4, R7][Technical] Exploring when nothing known suits: where they go to look, how a goal waits on what exploring finds, and whether exploring trips are weighed by R5's costs of being out there.
- [Affects R1, R4][Technical] Free knowledge outside place choice: see() hands facts to everyone within a radius (a wolf kill within 90 m, a spreading fire within 60 m), and there are dark-time rules in ctxFor and feasible. Which go, and which become sight?
- [Affects R5][Technical] formulas.ts predict for planting and digging uses spotNear for where the seed or pit goes. The answer key follows whatever the act's spot choice becomes.

## Next Steps

-> /ce:plan for structured implementation planning
