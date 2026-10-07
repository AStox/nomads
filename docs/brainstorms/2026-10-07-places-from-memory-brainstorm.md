---
date: 2026-10-07
topic: places-from-memory
---

# Choosing places from everything they remember

Status: discussion draft. The questions at the end decide its shape.

## What you asked for

People shouldn't be limited to spots within 3 m. A good place they know further off should be weighed against the effort of getting there and how far it is from their home and their friends. And since they no longer forget, every decision should draw on all they remember.

## What the sim does today

- **Nobody remembers a place.** Every destination is worked out again from the world itself each time someone thinks, and again on every tick of a walk. Within each search radius a person knows everything, whether or not they've seen it; sight is checked only in the dark (src/sim/sim.ts `ctxFor`, `spot`, `groundsNear`). Their journeys are kept forever (src/sim/journeys.ts), but only the inspector reads them.
- **Their record of tries has no places in it.** It is kept by condition (`ground:grassland`, `shade`, the weather), never by where (src/sim/beliefs.ts `noteTry`). Two patches of grassland with the same flags are one "place" to them.
- **Planting goes like this:**
  1. groundsNear samples 85 points out to 100 m and keeps the first point of each kind of ground, skipping any point a theory of theirs blames.
  2. They walk there.
  3. spotNear tries 24 points 1 to 3 m away. If none suits their theories, it plants at the first point the ground will take anyway (src/sim/physics.ts 885). That fallback is why round five found people who knew a spot was bad planting in it.
- **Distance barely enters a choice.** Walking costs 1 + metres/60 in the planner, measured from where they stand (src/sim/plan.ts). It never decides which goal they pick, and nothing scores a site by its distance from home or from friends. Friends count in one place only: a new shelter goes 6 to 15 m from the best-liked friend's home.
- **Fixed radii stand in for knowledge everywhere:** SEARCH 800 m, ground 100 m, spot 3 m, HOME_NEAR 150 m, FIRESIDE 60 m, hunting 400 m, Jev's view 60 to 300 m. Some memory is still capped: the event log at 12 entries, a relationship's history at 10, waiting on a seedling at 30 days.

## The idea

A person knows a place because they've been there or seen it, and knows it as it was when they last saw it. Any choice of where to do something looks over every place they know that would serve. It weighs what they expect to come of it there, from their own record and their theories, including what happened at that very spot, against what it costs:
- the walk there and back;
- how far it is from home, since a field far from home costs a walk every time they tend it or pick it;
- how far it is from the people they like.

Places they've never seen are unknown; exploring is how new ones come in.

Every cost goes in the planner's own currency, where a unit is 60 m of walking, so it weighs naturally against how sure and how quick the doing is. Planting would score each known spot roughly as

  (chance it comes up there) × (what a bush is worth to them) − (walk there now) − (expected trips to tend and pick) × (distance from home) − (distance from friends) × (how much they care)

where the chance is zero wherever a theory of theirs rules it out. That means no fallback into a spot they believe is bad: they go elsewhere, or don't plant at all.

## Ways to build it

**A. Journeys are the memory.**
- What someone has seen is everything within sight of where they've walked, and those journeys are already kept forever and saved.
- Anything lasting about a place (the ground, the soil, how sour, how shaded by trees) is read from the world's fields for any place in sight of their path.
- Their own tries gain where they happened: every planting keeps its spot and what came of it, for good.
- Pros: almost no new state, nothing to forget, cheap.
- Cons: things that change (a bush's berries, sticks lying about, a seedling) would be known as they are now, not as last seen.

**B. A remembered map.**
- Each person keeps a sparse map of 25 m cells they've seen. Each cell records what they noticed there and when: the ground, the shade, the soil, what grew or lay there, and their tries.
- Decisions query it, and walking about updates it.
- Pros: they are wrong about places that have changed since they saw them, which is true to life and gives new things to learn.
- Cons: more state (a few thousand cells per person), more code on every move, and the save grows (an optional field, no VERSION bump).

**C. Places pass by talk** (the higher-upside option).
- On top of A or B, people tell each other where the good ground, the flint or the berries are. A newcomer starts from the camp's knowledge, and a wrong tip spreads like a wrong theory.
- It also gives hearsay something to carry. Round five found theories can't pass to anyone who already knows how to plant.
- Pros: social learning of places, camps settling around good ground.
- Cons: a new kind of thing to say, and more to judge in the probes.

**Recommendation:**
- A first, with every try keeping its place, and B's "as last seen" for things that change (berries, sticks, seedlings) when a decision needs them.
- Score planting sites as above, then move the other place choices (foraging, flint and stones, water, a fire's site, a shelter's site, hunting ground) onto the same "known places weighed by effort" path one by one, retiring the fixed radii as they go.
- C after that, as its own step.

## What it changes around it

- **Knowledge stops being free.** Within 800 m people now know every bush and flint boulder without looking. If knowledge becomes what they've seen, early days get harder and exploring starts to matter. If memory only adds to what they can see now, nothing gets harder, but the old omniscience stays.
- **A planting probe has to stage the plot as something its planters know.** Each planter has walked it, or it is all in sight from where they stand, so the probe still tests learning and not exploring.
- **Goal choice can see place.** A goal is worth more when a good known place for it is close, so planting waits until they're near good ground rather than happening wherever they stand.
- **Costs per decision rise.** Indexes per kind of place will be needed, kept per person and updated as they move.

## Questions

1. Should what people know be limited to what they've seen (more realistic, and exploration matters), or should memory only add to what they can see now (safer, keeps today's omniscience within the radii)?
2. Planting first and the other place choices after, or every place decision in one go?
3. Is distance from home a physical cost (the future trips to tend and pick), a preference, or both? And distance from friends: a cost of being far, or a pull toward them?
4. Should places pass by talk (C) now, or later?
