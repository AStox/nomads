# Plant constants

Substrate 4 of `rule-audit.md`: how plants grow. One rule (`src/terrain/growth.ts`) lays the island's plants down in the generator and grows them in the game: a plant's leaves make dry matter of the sun that reaches them while it is warm and watered enough, and it burns a share of itself to stay alive. Seedlings are that balance in grams; grown plants keep a relative rate built from the same limits; the generator asks of each plant, at each place and in the light its layer gets, whether it keeps itself over the year. Every number below is cited, [derived], [design], [gap] or [UNVERIFIED]. References continue from `matter-constants.md` (R335 on).

Code: `src/terrain/growth.ts` (warmEnough, watered, the carbon constants, SLA, madeOf, keptOf, through, thrive, yearComp); `src/terrain/ground.ts` (cover shares); `src/terrain/flora.ts` scatter (what grows in each layer); `src/sim/plants.ts` (growthOf, seedlingGain, SEEDLINGS, seasonsHere); `src/sim/seedling.ts` (seedlingHour, seedlingFate, PATIENCE, tooDark); `src/sim/sim.ts` (CONDITIONS `deep`, giveUpWaiting); `scripts/probes.ts` (the planting probes).

## 1. What replaced what

| Old rule | Now |
|---|---|
| `light.ts growRate`: 0.25 + 0.75 of the sky's share [design] | Removed. Light enters as the sun's W/m2 times the share the crowns let through (growth.ts through), into the plant's leaves |
| Seedling `stage` 0..1 by a ramp product, `hp` by a drink curve (rule-audit-findings P20) | `dry` grams, gaining each hour by sec. 4; `stage` and `hp` are views of the mass |
| Comes up at stage 1; withers at hp 0 | Comes up at the kind's `up` mass [design]; withers at half its peak [design] |
| Niche light curves for every plant (niche.ts, ~40 hand-set bounds) | Gone for green plants: light acts through their carbon. Fungi keep theirs [gap] |
| Generator: shrubs in 1 - 0.7 of the tree share's light, low plants in a hand-set mix of evergreen and leafless shade, each by its niche light curve | Every layer under trees gets the open share plus one crown's light, as the game's skyShare; a plant's weight is its fit times how far that light clears its year's compensation point (sec. 6) |
| Generator cover: trees from summer 11 to 15 C and soil water 0.72 to 0.92, shrubs from water 0.6 to 0.85, grass from water 0.15 to 0.4 (ground.ts ramps) | Each form only where one of its kinds keeps itself over the year (sec. 6); the soil, shelter, peat, sand and moor terms are the old ramps [gap] |
| CONDITIONS `deep`: light < 0.2 [design] | Too dark for the seed to come up within a planter's patience, in the light the crowns and the plants round it leave it (sec. 5) |
| A planting waited on 30 days is dropped, unjudged | One standing unsprouted after PATIENCE counts as not having worked (sec. 5) |

## 2. Warm enough

| Quantity | Value | Units | Source |
|---|---|---|---|
| Growing-season index, minimum temperature ramp | 0 at -2 C, 1 at 5 C | - | R72 (fire-constants) [read] |

Pick: `warmEnough(T) = clamp((T + 2) / 7)`, for the hour's air (game) or the season's mean (generator) [derived].

## 3. Watered enough

| Quantity | Value | Units | Source |
|---|---|---|---|
| FAO-56 water stress coefficient Ks | (TAW - Dr) / ((1 - p) TAW) | - | R221 eq. 84 [read] |
| Depletion before stress, p | 0.5 | - | R221 Table 22, the common value [read] |

Pick: `watered(share) = clamp(share / (1 - 0.5))`, share being the root zone's water against what it can hold: soil.ts now in the game, ground.ts soilWater at each season's end in the generator.

Grown plants: `growthOf = warmEnough x watered x light x feed`, a 0..1 rate against their best. `feed` (soil.ts feedRate) stays [gap: fertility's own physics].

## 4. A plant's carbon

| Quantity | Value | Units | Source |
|---|---|---|---|
| Radiation use efficiency | 1.4 | g dry matter per MJ of solar radiation intercepted | R335 [ex] |
| Growth respiration coefficient k | 0.25 (Y_G 0.75) | g C respired per g C made | R336 [read] |
| Maintenance respiration c | 0.015 | per day, of the plant's dry mass, at 20 C | R336 [read] |
| Q10 of maintenance | 2 | - | R336 [read] |
| Leaf mass fraction of seedlings | about 0.5 | - | R337 [ex] |
| Specific leaf area, every green plant | sec. 4b | m2/kg | R344 [read] |

Pick, per gram of plant:

    made(day) = (1 - k) x RUE x sun(MJ/m2) x light x SLA x LMF x warmEnough x watered x fit
    kept(day) = c x Q10^((T - 20) / 10)

- A seedling gains (made - kept) x dry each hour (sun as W/m2 x 3600 / 1e6, kept / 24), times YEARS_PACE = 365.25 / 40: the island's 40-day year does a real year's growing [design, as fire-constants sec. 12].
- Leaf area intercepts all the light falling on it [design: a seedling's leaves do not shade one another].
- fit: the niche's fit at the spot without light (plants.ts fitHere) [design: the island's lasting suitability scales what is made].
- Crowns: through(cover) = exp(-0.8 x 2.6 x min(cover, 2)), an eighth of the sky under one crown (light.ts, unchanged).

### 4b. Leaf area and seed mass

SLA is FloraVeg.EU's mean over its trait datasets, mostly Kleyer et al.'s LEDA (R344), read for every species on 2026-10-12. These are adult leaves; seedlings' run higher, most in shade (R343) [gap]. Seed mass is FloraVeg's but for the berry, whose FloraVeg seed (199 to 236 mg for Rubus) is plainly the fruitlet; R342 is used.

| Plant | Species read | SLA, m2/kg | Seed, mg | Comes up at, g |
|---|---|---|---|---|
| pine | Pinus sylvestris | 5.89 | 6.58 | 10 [design] |
| oak | Quercus robur | 13.32 | 3122 | 10 |
| ash | Fraxinus excelsior | 12.68 | 62.3 | 10 |
| aspen | Populus tremula | 17.62 | 0.11 | 10 |
| berry | Rubus caesius (bramble analogue, Rubus fruticosus agg. absent) | 18.29 | 2.5 (R342) | 5 [design] |
| hazel | Corylus avellana | 23.63 | | |
| heather | Calluna vulgaris | 9.71 | | |
| gorse | Ulex europaeus | 8.2 | | |
| yarrow | Achillea millefolium | 17.68 | | |
| sorrel | Rumex acetosa | 23.76 | | |
| mint | Mentha aquatica | 30.02 | | |
| bracken | Pteridium aquilinum | 18.45 | | |
| lady fern | Athyrium filix-femina | 12.1 | | |
| buttercup | Ranunculus acris | 21.24 | | |
| daisy | Bellis perennis | 32.32 | | |
| clover | Trifolium repens | 32.07 | | |
| harebell | Campanula rotundifolia | 25.45 | | |
| poppy | Papaver rhoeas | 23.89 | | |
| reeds | Phragmites australis | 11.07 | | |
| grass | mean of Festuca rubra 17.78, Agrostis capillaris 29.95, Holcus lanatus 30.7, Dactylis glomerata 22.28, Anthoxanthum odoratum 31.25 [derived] | 26.39 | 0.6 (their mean: 1.06, 0.07, 0.39, 0.87, 0.61) | 0.5 [design] |

Checks against the earlier sources: oak SLA 13.32 against seedlings' 13.24 in the open (R343); acorn 3.12 g within 1.77 to 4.70 (R338); ash seed 62 mg against 70 (R339); pine 6.6 mg within 3.05 to 6.99 (R340); aspen 0.11 mg against Herzog's 0.5 (R341).

## 5. Deep shade and a planter's patience

A seed in deep shade does not wither within days: below its compensation point it burns down slowly, and a little above it grows too slowly to come up in a season. What a planter sees is that it never comes up.

- **PATIENCE** = a growing season, the warm half of the island's year, 20 days [design]. A planting that stands unsprouted that long is given up and counts as not having worked (sim.ts giveUpWaiting), as one that withers does. Plantings whose seedling is gone (burnt, broken off) are dropped unjudged as before. The probes' truth looks this far ahead.
- **tooDark** (seedling.ts): the least share of the open sky's sun in which seed going in at a point now comes up within PATIENCE [derived], from the island's seasons there drawn between their middles (sun, warmth, soil water), the niche's fit, and the share of the soil's water the plants round it leave:

      L* = (ln(up / seed) / YEARS_PACE + sum of kept over the days) / (fit x sum of made in the open over the days)

- **CONDITIONS `deep`** ("It was in deep shade"): the light the crowns leave times the share the plants round it leave (seedling.ts shareAt) below L*. Crowding is shade too: `crowded` stays a condition anyone sees, no longer a cause of its own.

## 6. The generator

- **What keeps itself where** (growth.ts yearComp): over the four seasons at a cell, a plant's compensation point is the sum of kept over the sum of made in the open, both per gram and day, with the seasons' sun (climate.ts, MJ/m2 a day on the slope through cloud), mean warmth and end-of-season soil water, and its fit. Comp 1 or more: it can't keep itself there even in the open.
- **Cover shares** (ground.ts): each form (trees, shrubs, grass) only where one of its kinds keeps itself in the open (comp < 1); taller forms take the light first, as before.
- **Layers** (flora.ts): trees are drawn in the open sky; shrubs and low plants in 1 - tree + tree x through(1). A green plant's weight is fit x thrive(light, comp), thrive = (light - comp) / (1 - comp) clamped to 0..1, nothing at or below its compensation point; a layer none of whose plants can keep itself grows nothing there.

Cover over land, the same four islands before and after (scripts/tmp-cover.ts, removed after):

| Seed | tree | shrub | grass | marsh | bare |
|---|---|---|---|---|---|
| 1 | 0.434 to 0.477 | 0.088 to 0.091 | 0.195 to 0.159 | 0.052 | 0.231 to 0.221 |
| 10 | 0.425 to 0.432 | 0.226 to 0.225 | 0.106 to 0.101 | 0.062 | 0.181 to 0.180 |
| 19 | 0.466 to 0.570 | 0.030 to 0.034 | 0.258 to 0.169 | 0.064 | 0.182 to 0.164 |
| 22 | 0.443 to 0.578 | 0.035 to 0.040 | 0.304 to 0.189 | 0.044 | 0.173 to 0.149 |

Trees take ground the old summer-warmth and soil-water ramps kept from them, most of it from grass. Under the trees, lady fern (SLA 12.1) falls from about 100,000 to 15,000 an island and bracken from 70,000 to 35,000, while daisies and clover hold.

A first try had cover follow each form's relative growth (its year's net against its best); it left 41% of the land bare where the ground is merely slow, and was dropped for whether it keeps itself.

## 7. Checks

Run with `scripts/tmp-seed.ts` (removed after), each seedling at fit 1, share 1, soil 0.8, 15 C, under a repeating sky of clear, cloudy, cloudy, rain, rain, five hours each, 20 island days:

- Midsummer compensation (share of open sun): pine 0.43, gorse 0.31, heather 0.26, reeds 0.23, lady fern 0.21, ash 0.20, oak 0.19, aspen, berry, bracken and yarrow 0.14, buttercup 0.12, hazel and sorrel 0.11, harebell and poppy 0.10, grass 0.09, mint, daisy and clover 0.08.
- Open ground, spring (day 6): oak up in 5.4 days, grass 8.5, berry 10.7, ash 10.8, aspen 15.7; pine reaches stage 0.39 in 20 days. Summer (day 16): oak 3.6, grass 8.5; berry 0.89 of the way. Autumn (day 26): none comes up in 20 days.
- 40% light, spring: oak up in 9.5 days; the rest part of the way.
- 12.5% light (one crown): pine withers in 10 days; the others hold near their seed mass in spring and wither in 15 to 19 days in summer, 8 to 9 in autumn.
- The probe's plot (seed 1, the probe's overcast sky): open spots come up in 6 to 18 days through spring; spots under 0.32 of the sky never within PATIENCE; tooDark there is 0.40 at the first of spring and marks every spot that fails but two at 0.42 on days 1 to 3.

Gaps the checks show:
- Pine never comes up: adult needles' SLA (5.89) puts its compensation at 0.43. Pine seedlings carry juvenile needles of far higher SLA [UNVERIFIED]; until SLA is the seedling's, pine regenerates nowhere in the game, though the generator still lays it down where its year comes out ahead [gap].
- Compensation points of 8 to 43% of open sun are high against the few percent commonly put for shade-tolerant seedlings [UNVERIFIED]: maintenance at McCree's crop value for every plant, and no shade acclimation (R343: oak's SLA rises 17% from open to 40% sun) [gap]. Lady fern, a shade plant, comes out light-demanding for it.
- Oak's leaf area ratio (SLA x LMF = 0.0067 m2/g) against R343's 43 cm2/g in full daylight: an acorn seedling puts much of its mass in root and the acorn [gap: LMF per kind].
- Treeline: the GSI ramp lets trees grow wherever the year's means stay above freezing long enough, so only soil, shelter and exposure keep them off the heights; the sink limit at a growing-season mean near 6 C (Körner, not read) is not in [gap].
- The generator's warmth and water are seasons' means, not the days [derived].

## 8. The planting probes

Restaged for this (scripts/probes.ts; evals probes 7):
- They sow from the first day of spring for as long as a berry in the open spot by a plot still comes up within PATIENCE in most of the probe's weathers (sowingEnds: 16 days on seed 1), see over the summer and autumn what never came up, and sow again the next spring: 56 days.
- The weather is overcast as often as the island's season (climate.ts SEASONS cloud) as well as raining 16% of hours, so seedlings get the sun the island's climate gives and the truth matches tooDark's means.
- The one cause is `deep`. The early and late waste are the first and the second spring's plantings.
- Seed/real seed 1: truth 0.989 pure, 86% of cases failing; right 1.0, wrong 0.67, wasted 0.99 the first spring and 0.44 the second, evident 0.67.
- The probe gate at a8bf4da (evals probes 7, a new baseline; every other probe's claims hold): over ten seeds, the share who come to blame deep shade (right) is 0.90 for seed/real, 0.72 sparse, 0.95 two, 0.57 hearsay, 0.87 unlearn/real, 0.92 unlearn/sparse; wasted plantings fall from 0.98 to 1.00 the first spring to 0.10 to 0.33 the second. Every seed/two claim holds. Open: seed/real's "more blame the true cause than anything else" (wrong 0.82: they also blame crowding and light shade) and its scaled accuracy; seed/sparse's evidence and scaled accuracy; hearsay's spreading (0.57 of those not told come to blame it); and both unlearn variants' letting go of the rain (kept 0.58 and 0.92), as before: a planter who blames the rain never plants in it, so never sees it work.
- The worlds tier at a8bf4da fails on wasted, 0.09 to 0.50, over 0 to 7 judged tries a world: people plant at any time of year, and a berry sown from midsummer on, or anywhere shaded, no longer comes up within a planter's patience. The answer key then looked ahead to the run's end and a month past it rather than PATIENCE; it now looks PATIENCE ahead (scripts/truth.ts), as a planter does, and at 92b9c90 the tier fails the same (0.07 to 0.50). Of the 14 plantings over the six worlds, 12 went in where it was deep shade, nearly all crowded too: a seed goes in right beside a bush (physics.ts spotNear), and the bush's share of the light (seedling.ts shareAt) now makes that deep [gap: where a seed goes in, and shareAt's own weights].

## 9. Still open

- `shareAt` (seedling.ts): how much light and water grown plants close by take [gap].
- A pour's own physics (seedling.ts) [gap].
- Fertility (soil.ts feedRate) [gap].
- The niche curves for warmth, water, soil, wind and salt (niche.ts) and the generator's soil, shelter and moor ramps [gap].
- Grown plants' growth stays a 0..1 rate; the berry crop sets over half a year of the best growth (world.ts cropOf, body-constants sec. 10) [design].
- Stumps resprouting, dead bushes returning, nut fall: old rolls, unchanged [gap].

## References

- R335 Monteith J.L. (1977), Climate and the efficiency of crop production in Britain, Phil Trans R Soc Lond B 281:277-294 (1.4 g/MJ as commonly quoted) (search excerpt)
- R336 Thornley J.H.M. (2011), Plant growth and respiration re-visited: maintenance respiration defined, Ann Bot 108:1365-1380. https://pmc.ncbi.nlm.nih.gov/articles/PMC3197462/ (read 2026-10-12)
- R337 Poorter H., Niklas K.J., Reich P.B., Oleksyn J., Poot P., Mommer L. (2012), Biomass allocation to leaves, stems and roots: meta-analyses of interspecific variation and environmental control, New Phytol 193:30-50 (search excerpt)
- R338 Variability of Quercus robur L. and Quercus petraea (Matt.) Liebl. acorns, Dendrobiology 47 suppl:25-31, citing Barzdajn 1994. https://www.idpan.poznan.pl/images/stories/dendrobiology/vol47suppl/47s_25_31.pdf (search excerpt)
- R339 Arboseed, European ash (Fraxinus excelsior) seeds. https://arboseed.eu/en/deciduous-tree-seeds/8-fraxinus-excelsior (search excerpt)
- R340 Variability of weight characteristics of Pinus sylvestris seeds in the taiga zone, AGRIS R12019000027. https://agris.fao.org/agris-search/search.do?recordID=R12019000027 (search excerpt)
- R341 Herzog Samen, Populus tremula (thousand grain weight 0.5 g). https://shop.herzog-samen.com/en/c/ola1-99/a/ola1-3105.html (search excerpt)
- R342 Seed dimension and weight of selected Rubus species, HERO 7631142. https://hero.epa.gov/reference/7631142/ (search excerpt)
- R343 Valladares F., Chico J.M., Aranda I., Balaguer L., Dizengremel P., Manrique E., Dreyer E. (2002), The greater seedling high-light tolerance of Quercus robur over Fagus sylvatica is linked to a greater physiological plasticity, Trees 16:395-403; and High-light acclimation in Quercus robur L. seedlings upon over-topping a shaded environment (leaf area ratio 43 cm2/g). https://www.researchgate.net/publication/225128746 (search excerpt)
- R344 Axmanová I. (2022), Specific leaf area; and Seed mass. FloraVeg.EU, drawing on Kleyer M. et al. (2008) The LEDA Traitbase, J Ecol 96:1266-1274, Tavşanoğlu Ç. & Pausas J.G. (2018) and Ladouceur E. et al. (2019). https://floraveg.eu/taxon/overview/ (each species' page, read 2026-10-12)
