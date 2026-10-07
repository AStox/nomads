---
date: 2026-10-07
topic: fire-physics
---

# Fire from heat physics, and moisture in everything

## Problem Frame

Fire in the sim is a countdown, not a fire.
- A catching spark makes a whole fire in one tick.
- Its heat comes from how it's set up (a ring, a cover, charcoal, blown air), not from what's burning.
- Any flammable thing laid on it adds fuel, wind does nothing, and rain takes a fixed toll unless it's ringed.
- A burning tree, shelter or patch of grass burns on a separate 0 to 1 ramp, and spread runs on a counter tied to nothing physical. See the brainstorm, docs/brainstorms/2026-10-07-fire-physics-brainstorm.md.

Round five made every outcome a formula of physical properties, and fire is now the largest piece of the sim that isn't one. The operator wants a fire's size and heat to decide what it lights, what lights it and when it goes out. The tinder, kindling and fuel order should emerge from low-level physics, with no rule for it.

Wetness exists today only for held tinder (each stack's own) and for the litter lying in the open (one island-wide value, Weather.litter). The operator wants everything to have a moisture content.

## Requirements

**Fuel as pieces with their own size**
- R1. Every piece of fuel is an item with its own size (thickness and length). Its mass follows from its size and its kind's density. Each piece takes its size from what it came from: a stick broken from a tree is as thick as that tree's twigs and branches allow, and a log as thick as the trunk. Items that differ in size no longer count as the same item for stacking.
- R2. Kinds carry every property the formulas in R4 to R9 and R16 read:
  - density, heat capacity and conductivity;
  - the temperature at which it lights;
  - how much heat a kilogram gives when it burns;
  - how fast it burns inward from its surface;
  - how much char it leaves;
  - how much water it soaks up.

  These are physical quantities kept beside a kind's fuel and burns, not in its 0 to 1 props. Every flammable kind has them, natural or made, and a made kind takes them from its parts by mass.

**Fire as a bed of pieces**
- R3. A fire is the set of pieces in it, each alight or not, burning down or spent, plus its coals. Everything else comes from that set: its heat output, flame size, warmth, light, and the heat it gives anything held or set in it (cooking, firing clay, softening and smelting metal, charring, smoking).
- R4. A piece lights when the heat reaching it brings its surface to the temperature at which it lights, before that heat runs out.
  - Heat reaches it from flames touching it (hot gas, which lights thin fuel in any flame) and by radiation (which grows with the fire's size).
  - Thin pieces heat through as a whole and thick ones only at the skin, and below some flux a thick piece never lights.
  - The water in it has to be driven off first.
- R5. A lit piece burns inward from its surface at its material's rate, so how long it lasts follows from its thickness. While burning, it gives off heat in proportion to the mass it burns.
- R6. A piece keeps burning only while the heat it gets back from its own flame, the rest of the bed and the coals covers what it loses. A lone log goes out and a bed of them keeps burning, as the formulas make it.
- R7. A fire's flames radiate more the bigger they are. That is what lets a big fire light thick wood and keep it burning, and stops a small one doing so.
- R8. Wind blows out flames too small for it, feeds bigger ones, and cools fuel not yet alight. Rain takes heat from the fire as water landing on it, and wets everything not yet burning (R16).
- R9. What's left after the flames is char, which glows for hours and lights kindling laid on it. A fire banked overnight can be brought back in the morning.
- R10. What people build around a fire changes it only through this physics, never by a fixed factor:
  - a ring of stones cuts the wind on the bed and throws heat back in;
  - a cover starves the bed of air, so wood chars instead of burning;
  - blown air speeds its burning as wind does;
  - charcoal is a fuel with its own R2 properties.

  Hearth, kiln and forge stay as the names people give those setups.
- R11. Lighting a fire is one act, and its inputs are the whole lay: the tinder, and whatever kindling and fuel are set with it.
  - Fire gets into the tinder from an ember, made by striking or rubbing as now, or from a flame carried from another fire (a burning brand or a lamp) and set into it.
  - The climb from there is settled within the act by R4 to R8. Tinder alone flares and dies, tinder and twigs make a small fire, and logs take only on a bed already burning. No rule says this; it comes from the formulas.
  - Experimenting proposes lays, as it now proposes a strike over tinder.
- R12. Feeding a fire is laying fuel on a bed that has outlasted the act that lit it, and it can fail. A log laid on a dying flame doesn't take, wet wood can put out a small fire, and kindling on coals brings a fire back.
- R13. Whether a lighting or a feeding worked is decided when the act ends, by the formulas' closed forms, for the bed as it then stands with nothing more added. A lighting lasts if the bed keeps itself alight once its tinder is spent. Fuel laid on takes if it lights before the bed's heat on it runs out. physics.ts makes that decision before a hand moves, and formulas.ts asks the same decision.

**Fire around it**
- R14. Whatever lies near a fire catches by the heat that actually reaches it: the heat its flames radiate (R7), flames touching it or leaned over it by the wind, and embers the wind carries onto dry fuel. Grass, trees, fallen wood and shelters all catch this way, and the scorch counter goes. A campfire in still air lights only what touches it, while a blaze, or a wind, reaches further.
- R15. Whatever catches then burns as a bed of its own pieces by R3 to R9, a tree struck by lightning included:
  - a tree as its twigs, branches and trunk, from its size;
  - grass as its blades;
  - a shelter as the pieces built into it, which keep their sizes when they go in.

  The separate burning ramp goes along with the scorch counter, so there is one model of fire.

**Moisture in everything**
- R16. Every material thing has a moisture content: what people carry and store, what lies or grows in the world, structures, and what people wear.
  - Things lying about or carried take water up from rain, standing in water and damp air, and lose it to sun, wind, warmth and nearby fire, at rates set by their own properties (thickness, how much water they soak up).
  - Something in a container that keeps rain out, or under a roof, takes no rain but still dries by the other terms.
  - A living plant's moisture follows the water it draws from the soil. What is broken or cut from it starts at that moisture (green wood) and changes as above from then on.
- R17. Today's two wetnesses, each stack's tinder wetness and the litter lying in the open (Weather.litter), become this one moisture, and everything that reads wetness reads it:
  - spark and ember catching, and the damp and soaked conditions people notice;
  - the body's faster heat loss when wet through (sim.ts needs, keyed today on rain with no roof), which comes to read the moisture of what they wear;
  - lighting and burning, by R4 to R8.

  Food keeping and the weight people carry have no place for wetness yet and keep none.

**Learning it**
- R18. People notice what decides these outcomes, each condition cut where its formula turns: how thick the fuel was, how big the fire was (for example coals, a small flame, a fire, a blaze), whether the fuel was damp or soaked, the wind and the rain. Several of these act together, so each one taken alone may only shift the odds, as in planting. Theories form about them as about anything else, so "a log on a small flame doesn't take" can be learned from their own record.
- R19. People choose which piece to lay the way they choose a spot to plant. An act still names the kind, and the piece taken is one none of their theories rules out. The decision, the conditions and formulas.ts all read that piece's own size and moisture.
- R20. src/sim/formulas.ts predicts, from the same formulas, the outcome of everything people do with fire: whether a lighting lasts, whether fuel laid on takes, and what heating does to what's held or set in a fire. The probes' truth and the answer key come from it, never from trial runs.

## Success Criteria

- From the formulas alone, with no fire rule naming a stage or a size class:
  - tinder alone makes no lasting fire;
  - tinder with twigs makes a small fire;
  - a log laid straight on a tinder flame doesn't catch;
  - three logs in a bed keep burning, and one log alone goes out;
  - kindling laid on hours-old coals lights.
- Every constant in those formulas is fixed from a cited measurement before these are checked. A criterion that fails with them is reported as a gap in the model, not met by retuning.
- A small flame goes out in wind or rain that a big fire survives.
- Warmth, light, cooking, firing and forging change with how big the fire is.
- A campfire in still air never lights grass beyond what touches it. In wind, grass downwind of it can catch.
- Everything has a moisture content that rain raises and sun, wind and fire lower. Wet wood and green wood behave as wet.
- Before the gate is read, every fire probe (choose, blame, confounded, recover, spread, two, except, rare) is restaged with lays. Each probe's causes and claims are re-derived from formulas.ts, and every claim is set against what a learner holding exactly the formula's cut conditions would score, as docs/research/learning-round5.md does for planting.
- People in a probe come to build their lays with small fuel under large, from their own record, with the probe's truth from formulas.ts.
- The probe gate and whole worlds are run on the change, and the bench shows its cost.

## Scope Boundaries

- No smoke, air chemistry, or flames as fluid flow. No temperature field over the map. Heat moves only from burning things to what's near them, by the formulas above.
- Sparks and friction stay as they are, except that what they make is an ember in the tinder of a lay rather than a whole fire.
- People telling each other about fires or places is a later step.
- Effects of wetness beyond those in R17 (food keeping, weight) come later.

## Key Decisions

- **Fuel pieces in a bed, not size classes or a heat field.** Per-piece physics is what makes the ladder, the lone log and banked coals emerge. A young fire's first seconds are solved within the act by the formulas' closed forms, not by tiny steps.
- **Each item has its own size.** Truest to the physics. Items stop stacking as one when they differ.
- **Spread, and everything that burns, on the same physics now,** so there are never two models of fire. A spreading grass or forest fire may hold many beds at once; its cost is measured on the bench, not assumed small.
- **Moisture in everything, not just fuel.** The operator's call: wetness is a physical state, and every outcome should come from physical properties. Green wood is wet, so seasoning wood becomes something to learn.
- **Lighting carries its lay.** Tinder lives for seconds and an act lasts minutes, so the climb has to be settled within the act that lights it.

## Dependencies / Assumptions

- The generator gives only heights and lengths (src/terrain/flora.ts size: a tree's height, a stick's or log's length). The thickness of trunks, branches, twigs, sticks and logs is new and has to be modelled.
- The literature values in the brainstorm (ignition times by heat flux, heating by flame contact, burning rate, char yield, flame emissivity) are about right, to be checked and cited when planning. [Unverified until planning]
- The sim's live weather has no humidity. The generator's seasonal relative humidity (src/terrain/climate.ts) is what damp air would read. [To confirm in planning]

## Outstanding Questions

### Deferred to Planning
- [Affects R4, R11, R13][Technical] How the closed-form ignition and burn times per piece cover a young fire's first seconds within a 5-minute tick, with each piece keeping the heat it has taken in from earlier sources and earlier ticks.
- [Affects R1, R16][Technical] How sized items stack, store, move and show in inventories. Gifts, trades, theft, stores, a tool breaking and a death's drops all move items by kind today. Does size stay out of kind ids, as wetness does now, so recipes, plans and belief keys still count a stick as a stick?
- [Affects R1, R3, R16][Technical] How an old save loads. VERSION stays as it is, and new state goes in optional fields. It has to cover:
  - lit fires, with hp and charcoal turned into a bed and coals;
  - things burning or scorched mid-fire;
  - kinds in saved registries, with burning properties read from BASE by id;
  - sizes and moisture filled in;
  - beliefs and laws whose fire-making keys name tinder without a lay.
- [Affects R14][Needs research] Ember lofting and landing: how far, how many, and what they need to land on to catch. Can what catches be predicted as yes or no, or only as odds over the weather?
- [Affects R16][Technical] Moisture for grown things kept as typed arrays until touched (src/sim/world.ts; space.ts shelves a tile only when its things are unchanged). Derive it from soil water, weather and their properties when read, and store it only once something else about them changes, as Weather.litter is derived today?
- [Affects R18][Technical] Where the conditions for fuel size and fire size are cut, from the formulas' turning points, and which fire size a person sees for a bed that changes within an act.
- [Affects R11, R19, R20][Technical] How making a fire's belief key names its lay (each piece with its size, or kinds with size as a condition), how many lays experimenting proposes, and how the answer key stages lays from the island's own spread of piece sizes.
- [Affects R3][Technical] Hours left on a fire (tend_fire, the brain's prompt, the inspector) from the pieces' own burn times instead of hp.
- [Affects R9][Technical] Whether a fire's char is the charcoal kind kilns make and forges burn, so coals can be gathered.
- [Affects R11][Technical] Whether sparks and friction keep their own DAMP and GALE cut-offs, or the tinder's catching moves onto R4 and R8 too, so wetness and wind don't act twice at different turning points.
- [Affects R3, R11][Technical] Whether carried brands and lamps burn down by R5.

## Next Steps

-> /ce:plan for structured implementation planning
