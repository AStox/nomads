# Where the world still runs on rules (2026-10-11)

The operator asked for every place the source decides a world outcome by a hardcoded high-level rule (a named category, a dice roll, a fixed timer, a lookup table or an uncited constant) where a low-level physical law should decide it. Ten readers each went through every line of a share of src/sim and src/terrain; their findings, with exact lines, quoted code and the physics that would replace each rule, are in docs/research/rule-audit-findings.md. Line numbers are as of commit 0db366d. This page groups them by what the rules stand in for, most consequential first.

About 260 world rules were found, besides the agents' own decision rules, which are listed separately. They are not scattered: nearly all of them sit in a few substrates that the fire rebuild never reached. Fix a substrate and its rules go together.

## What already meets the standard

Fire from ignition to spread (combustion.ts, spread.ts, fuel.ts), the water in everything (wetness.ts, its skin and heart), the rain reaching the ground (rain.ts), the top soil and runoff (soil.ts water, streams.ts), the radiant warmth of fires on bodies (sim.ts warming's fire terms, light.ts heatAt), firelight, the sun's geometry (sky.ts astronomy), the rain-onset term of the sky chain, the conditions people can notice (sim.ts CONDITIONS, cut where cited formulas turn), and in the generator Magnus vapour pressure, clear-sky insolation, FAO-56 evapotranspiration, priority-flood, stream-power erosion's scheme, Dupuit groundwater and the niche architecture (fit as a product of response curves).

## The substrates still run on rules

### 1. The body is four 0 to 100 bars (high impact)

People's food, warmth, energy and health are unitless pools drained and refilled by additive constants (sim.ts 2038 to 2044, 1441 to 1445, 1469 to 1479). Starving or freezing takes a flat health tax; health heals past thresholds; a person collapses at zero, gets a free top-up, and dies on a second collapse soon after (2131 to 2139). The cause of death is chosen by a priority switch. Eating adds edible x 100 straight to the food bar, bypassing physics.ts eat() (1332, 1444, 1727). Clothing is (1 - worn x 0.6), shelter is tier points, huddling 0.25 a body capped at two, the sun on a body a flat 0.05 scaled by lux (2025 to 2031; fire-constants sec. 31 already lists these as open). Melee damage is fists as a fake tool against a body toughness of 0.1, doubled (1930). Sickness is a step at toxic 0.25 with dice severity and day timers (physics.ts 1520 to 1548); crowding sickness a daily 12% roll (ecology.ts 191 to 199) and transmission per-tick dice (534 to 543). Ageing is three named stages switching at 1 and 5 years (world.ts 387); death of age a linear-ramp dice from 6.5 years (life.ts 130); births capped at 12 people (life.ts 10) and gated by a shelter tier and a 30% evening roll; gestation 10 days.

**Physics that replaces it:** a body heat balance with core temperature (metabolic heat, the cited radiant and convective terms already in warming, clothing and shelter as thermal resistances in clo and m2K/W, evaporative loss when wet), and an energy store in kJ (basal metabolism by body mass, activity by MET, food energy by mass and kind). Collapse and death then follow from core temperature and depleted reserves; healing from tissue repair rates; senescence as a Gompertz hazard; fecundability per cycle modulated by energy balance; disease as dose and exposure. Most of these have textbook constants (ISO 7730 and ASHRAE for heat, FAO/WHO for energy, life tables for mortality).

### 2. Matter has no mechanics (high impact)

Every material is a sheet of unit-free 0 to 1 props (materials.ts BASE 34 to 64), and every world thing and animal a name-keyed row of hp, toughness and what it breaks into (THING_MATERIAL 66 to 82). Striking is force() and focus() ramps over those props, damage into hp pools (physics.ts strikeDamage, force, focus); splitting is a two-value grain label; knapping a hardness polynomial with a 10-blow give-up; forging an exponential sharpness ramp into named buckets; a dent takes four blows; tools wear and bare hands hurt by per-blow decrements; bark peels on a ramp capped at 3; sparks come from hardness where the real variable is chemistry (pyrite and flint, or steel); friction fire is a per-tick heat counter with a bow flag; joining invents its product's properties by arithmetic and stops at depth 2 (physics.ts 1 to 800). What a felled tree, a broken boulder or a butchered deer gives is a fixed table. Jev rulings mint new matter whose properties are an LLM's 0 to 4 scores clamped by uncited factors (brain.ts 423 to 453, physics.ts 1573 to 1590).

**Physics that replaces it:** give materials measured mechanical properties in SI beside the thermal ones fuel.ts already holds (density, elastic modulus, fracture toughness, hardness, tensile and shear strength along and across the grain). Then a blow is an impact energy from the striker's mass and speed, cutting and splitting are fracture against the material's toughness along its grain, knapping is Hertzian cone fracture, wear follows Archard's law, friction fire is frictional heating against conduction into the wood, sparks follow from a striker's ability to shave off a pyrophoric particle, and what something breaks into follows from its geometry and the fracture. A Jev ruling would then have to return measured properties of a real material, not scores.

### 3. Time is counted, not caused (high impact)

Food spoils on a fixed day count per kind (materials.ts shelf, physics.ts 846 to 989, inspect); hot metal cools on a 36-tick countdown; resin beads on a dice capped at 2; berries are a capped dice and bushes regrow hp at a flat rate; a dead bush comes back on a 1-in-4000 roll; stumps regrow after fixed days; nuts fall on a 30% global roll; seeds disperse by two global dice into fixed rings; litter, mushrooms, herbs, sticks, stones, reeds and clay appear by a threshold table on one draw (ecology.ts 339 to 396); ash lies two days; a pit turns into a well after a day; a trapped animal escapes after half a day; lightning strikes a random tree on a 1-in-150 storm roll; ice forms per tile on a 25% roll below freezing and melts at once (ecology.ts 109 to 154).

**Physics that replaces it:** spoilage as microbial growth against temperature and water activity (Q10 or Ratkowsky models, already the shape of the water model); cooling by Newton's law with the piece's own heat capacity and surface; fruiting, nut fall and regrowth as phenology on thermal time (degree-days) and the plant's carbon budget; dispersal kernels by vector; lightning from flash density and the electric field's preference for the tallest conductors; ice by Stefan's growth law from freezing degree-days; a well by groundwater head against the pit's floor.

### 4. Plants grow by hand-set curves (high impact on planting)

The seedling hour is uncited end to end: a drink curve smooth(0.35, 0.75), a stage rate of five hand-set factors (three days, trees a quarter as fast, 0.4 + 0.6 drink, 0.5 + 0.5 fit, share), a 5-point health bar breaking even at 0.25, poured water fading 3% an hour, and competition as a 2 m radius with weights 1.5, 1 and 0.3 (seedling.ts). Growth reads a soil-water ramp that ignores the FAO-56 stress coefficient already cited in soil.ts (plants.ts growthOf), a warmth ramp from 4 to 14 C beside the cited GSI ramp (cues.ts warmRate), photoperiod cuts at 11 h and 13.5 to 8.5 h, a quarter of the speed in deepest shade (light.ts growRate), fertility by a ramp (soil.ts feedRate) and a fertility ledger of hand-set dung, ash and washout. The canopy's crowns take their widths from sprite drawings and stop dimming past two crowns (light.ts SHARE, LEAVES 2.6, the cap).

**Physics that replaces it:** growth as light-use efficiency times intercepted radiation (Beer-Lambert through crowns with a leaf area index from the iLand foliage masses spread.ts already cites), limited by FAO-56's water-stress coefficient Ks and thermal time; seedling death from carbon starvation or drought stress against measured seedling tolerances; competition as shared light and water rather than a radius; crown radius from crown allometry.

### 5. Animals live on caps and drains (medium to high)

Each species has a hand-tuned hunger drain, fixed founding counts and a hard population cap (deer 18, wolves 6, rabbits 120, fish 200, butterflies 90), breeds on photoperiod and dice, and is a row of hp, speed and habitat in FAUNA; a struck deer flees and a wolf fights by species name; a hunt ends past 250 m or after 40, 60 or 80 tries; a wolf's bite is a fixed damage (animals.ts, fauna.ts, sim.ts 1097).

**Physics that replaces it:** metabolism by Kleiber's allometry, intake from forage biomass, breeding and survival from energy reserves, so populations emerge from food and predation; flight and pursuit from speed and endurance by body mass.

### 6. Walking and carrying ignore the ground and the load (medium)

People walk 2 m a tick and run 6, a child at 0.6 of that and anyone on a path trodden five times at 1.4 (sim.ts 226); routes are uniform-cost with no slope, cover, snow or wading cost (walk.ts); obstacles take radii by kind; carrying is 24 items of each kind regardless of mass (plan.ts 22, physics.ts carryOf); reach is a constant plus a kind switch.

**Physics that replaces it:** speed and cost from the metabolic cost of walking on slope and surface (Tobler, Minetti, Pandolf's load-carriage equation), leg length by the Froude number for children, carrying by mass and bulk against the body's capacity.

### 7. Work takes tick counts (medium)

Every act lasts a fixed number of ticks by verb, faster 10% per skill level (physics.ts DURATION 218, sim.ts); gathering is a 2.5-tick quantum with fixed yields per place (2 berries, 3 grain, 2 clay; plan.ts GATHER) and plants lose fixed hp per harvest; a clay deposit vanishes on a 25% roll; digging is 12 abstract units; poor light loses a tick on a coin flip; helping adds exactly 1 a tick.

**Physics that replaces it:** work as energy over a person's sustainable power (about 75 to 100 W), each act's energy from the physics of the act (soil volume and its shear strength for digging, the mass picked for gathering), yields from the stock actually there, and skill as efficiency.

### 8. Shelters are scores and tiers (medium)

A shelter is a hand-weighted score over cover, insulation and sturdiness laid out in a tier ladder with rooms and widths by tier, hp pools topped up 20 a load, and a roof that shelters anyone within 4 m (physics.ts 1219 to 1252, 1400 to 1428; wetness.ts sheltered). A fire ring and a cover are piece counts (3 and 6 stones), a forge a fuel-count test rather than a temperature, a trap two sticks over a hole.

**Physics that replaces it:** a shelter's thermal resistance from its materials' conductivities and thicknesses, its rain shedding from its roof's geometry and cover (rain.ts already has the rain's slant), its strength from its members, and fire setups judged by the temperature and air they achieve, which combustion.ts already computes.

### 9. Throwing, hunting and fishing (medium)

Ballistics is two cases, bow or arm (40 m or 20 m, damage 5.5 or 2.2), and a hit is anything in range; prey hp and what a carcass yields come from the name table; catching a fish is a roll and a presence check, and fishing reach a name table (physics.ts 963 to 1111).

**Physics that replaces it:** projectile motion with launch speed by thrower and weapon, drag and dispersion, wounding by kinetic energy and penetration; fish catch by encounter rates.

### 10. The sky's residue (medium, several small fixes)

The sky is four states read by hand-set tables (air.ts SWING, WIND; sky.ts COVER, which disagrees with air.ts's cited CLOUD; the -2 C in rain); headWind cuts the wind under crowns by a flat 0.65 while Albini and Baughman's sheltered adjustment, already cited in sec. 14, goes unused; cold pools reach 5 degrees by fiat; snow covers by a 3 to 30 mm ramp; STORMY comes from the old sky model; the sun's lux is a ten-point table beside the computed sun; the dark is a cut at brightness 0.3; wind wanders by relaxation and jitter; a drought is four dry days above 14 C; and wetness.ts fireFlux uses a second, weaker radiant law than light.ts heatAt for the same fire.

### 11. The generator (medium; it shapes every island)

The island's yearly rainfall is drawn at random and the orographic field rescaled to hit it (climate.ts 77, 88 to 95); the SEASONS table is a hand-written row per season (13 to 20); erosion is dimensionless and the relief a die roll (island.ts 62, 112); the rock table, ~700 niche curve bounds, every object density and size range, and four separate cover classifiers (ground.ts 93 to 107 duplicating niche.ts, flora.ts groundClass, land.ts tiles) are uncited.

### 12. What touches the world from the mind (low to medium)

What people can perceive is switched by kind and species names, with a dozen fixed sight, witness and hearing radii (brain.ts, beliefs.ts, groups.ts) where light.ts already computes visibility; narration asserts causes by verb name; groups move fixed counts of items and dock needs by fixed amounts per verdict. Determinism: world.ts landing() and space.ts anyOf() use unseeded Math.random.

## Cheapest fixes with a cited replacement already in the repo

1. headWind's 0.65 canopy cut to Albini and Baughman's sheltered wind adjustment (sec. 14a, R81).
2. wetness.ts fireFlux to light.ts heatAt, one law for one fire.
3. sky.ts COVER to air.ts's cited CLOUD.
4. The sun on a body as a flux with skin absorptivity (sec. 18) instead of a flat term.
5. One eating path through physics.ts eat().
6. growthOf's water ramp to FAO-56's Ks; warmRate to the cited GSI temperature ramp.
7. Seeded randomness in landing() and anyOf().

## The order that buys the most

1. **The body** (substrate 1): every world's survival, cold deaths and population turn on it, and half its physics (fire warmth, air, wind chill, wetness) is already cited.
2. **Matter's mechanics** (substrate 2): it unlocks toolmaking, felling, splitting, butchery and hunting by physics, and removes THING_MATERIAL, BASE's props and the Jev property scores.
3. **Plant growth** (substrate 4): the planting probes' open claims sit on it.
4. **Processes in time** (substrate 3): spoilage, cooling, phenology, lightning and ice.
5. Then animals, walking and carrying, work, shelters, projectiles, the sky's residue, and the generator.
