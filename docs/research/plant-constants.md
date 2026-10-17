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

## 9. Spreading on their own

src/sim/recruits.ts, deleted in the GPU plan's Unit 8: its rule, below, is now each seed's and seedling's own on the GPU (sec. 13), its constants carried over but for pine's establishment (6.7% as R457 reads, not 6.5%), and its cohort counts became the test oracle (src/gpu/seedlings.test.ts). The old rule: two island-wide rolls a tick dropped a seedling of a random bush or tree 4 to 45 m off, kept as the spot's fit allowed. Then each kind spread as it does, and its young were counts on each tile being looked at, so many of a kind, an age and a place (the open, or under the crowns), each as heavy as the rest, until they stood up as things. Ground put back as it grew dropped its young: the generator's layout already held them.

| Kind | What it puts out, a parent a year | When | How far | Source |
|---|---|---|---|---|
| Scots pine | 12,000 seeds in good years (13 of 19), 50 to 70% viable, 6.5% standing as seedlings on unprepared ground: 320 | mid May (shed April to July, up within two weeks above 10 C) | exponential, 80% within the tree's height (within 20 m of a 20 m tree) | R455, R457 [derived] |
| Ash | up to 140,000 fruits in a mast year, masts every 2 to 5 years; seedlings 1.1 to 24.5% of the fruit two years before, their geometric middle: 2,080 | early May (mid April to May, the second spring) | exponential-power, mean 39.1 m, shape 2.085, by parentage of seedlings | R458, R459 [derived] |
| Oak | of the acorns lying at the end of the fall (time-constants sec. 8), 2% cached by mice and never found, 68.5% of buried acorns coming up; 3.5 g an acorn | June 1 (May and June) | lognormal, median 25.9 m, 95th percentile 116 m, mothers to seedlings in the open | R460, R461, R462 [derived]; what jays cache and leave [gap] |
| Bramble | daughters at cane tips, 25% of the bushes a year (fenced Dutch thickets, 434 to 4,085 a ha in ten years); seedlings 0.4 a m2 of crown | daughters October 1 (autumn), seedlings April 20 (spring) | daughters 3.3 m out; birds' seed exponential, mean 33 m (most within 50 m, nearly all within 100 m) | R466, R468, R475 [derived] |
| Aspen | felled or burned: suckers at 75,000 a ha (50,000 to 100,000 after clear-cuts in hybrid and quaking aspen) over its roots, each 4.2 g | at the green-up the stump resprouts at (sec. 6 of time-constants) | within 40 m | R463, R464, R465 [derived; proxies]; its seed seldom comes up [gap] |

Where they land: on dry ground on a tile being looked at, in the open or under the crowns as the tile's crowns cover it. Growth:

- A seedling grows by the plant rule (sec. 4), in its place's light: all of it in the open, one crown's worth under them.
- Past coming up (plants.ts SEEDLINGS up), a young tree grows as its mass to the 3/4, dM/dt = c M^(3/4) (Niklas and Enquist, R469), c set so that one reaches its height in British yield tables at 20 years from planting, plus three for the years before planting (R470): Scots pine 7.5 m (YC 100) and oak 7.8 m (YC 60) from Bradley et al.'s tables, ash 11.4 m planted on Irish grassland (Wellock et al.), aspen suckers 11.4 m at 20 in Sweden (Johansson). Its mass at a height is Repola's stem and branches on the game's stem for that height (mechanics.ts) [derived]. Elsewhere it grows as the plant rule's net gain in its place stands to that on the island's typical open ground at a perfect fit, which shade or a poor fit can take below nothing. In the open on typical ground: pine 2.5 m at 10 years and 11 m at 30, oak 3.4 m and 10.5 m, ash 6.5 m and 14.5 m, aspen 6.2 m and 17.7 m.
- One that has burned down to half the most it weighed dies, the cohort with it.
- Crowded, they're thinned smallest first until their crowns (light.ts crownRadius of their height) fit their place [derived].
- Browsing: red deer reach 1.8 m and rabbits 0.54 m (R471). The share of saplings browsed a year rises with red deer: under 15% below 2 a km2, 30% at 10, 80% at 20 (Palmer and Truscott, R472), along those points; a browsing kills 52% of those it takes, browsed saplings dying 50 to 70% against 15 to 20% unbrowsed (Brooker et al., R473) [derived]. Rabbits at 11.7 a ha left 26% of oak transplants alive in a year against 85% fenced (Bakker et al., R474): a yearly kill of 1 - e^(-R/10.1) [derived]. What the deer and rabbits eat of them doesn't feed them [gap].
- They stand up as things where there's room in their place: young trees once as tall as the ground's own trees of their kind there (the generator's height for the spot's fit, its spread's middle), so not for decades; brambles in their second summer, when their canes first fruit (R466), with the crop a grown bush carries.

Checks, seed 1, the ground round its people over ten island years with nothing but the herds' browsing on it: pine's young grow to 3.5 m and oak's to about 4 m, ash's to 7 m; pine under crowns dies out while ash and oak persist there small for years, as ash's persistent juveniles do (R458); brambles add about 15% a year. No young tree stood up in the ten years.

Gaps: planted seed still comes up as a 4 to 6 m tree at once (seedling.ts matured, the planting probes' rule); the young aren't drawn; trees once up don't grow; grass's competition with the young beyond what emergence counts hold; bushes once up aren't browsed; hazel, heather and gorse don't spread, having no seedling of their own (their seed would grow up as a bramble).

Gates at c321a54: probes, against a8bf4da, fail three, the claims that have come and gone pass by pass (seed/two's and unlearn/real's that nearly all whose own tries show the true cause come to rule it out) and unlearn/real caught 0.87 to 0.68; seed/sparse caught 0.56 to 0.76. Worlds, against 2258536, fail one claim, fewer tries going to waste late than early, with wasted at 0.06 against 0.10 and worked 0.94 against 0.91, both within their intervals. Not retuned.

## 10. Still open

- `shareAt` (seedling.ts): how much light and water grown plants close by take [gap].
- A pour's own physics (seedling.ts) [gap].
- Fertility (soil.ts feedRate) [gap].
- The niche curves for warmth, water, soil, wind and salt (niche.ts) and the generator's soil, shelter and moor ramps [gap].
- Grown plants' growth stays a 0..1 rate; the berry crop sets over half a year of the best growth (world.ts cropOf, body-constants sec. 10) [design].
- Stumps resprouting, dead bushes returning, nut fall: old rolls, unchanged [gap].

## 11. Stems (the GPU plan's Unit 7; the rule audit's substrate 11f)

Every tree and bush is a stem object on the GPU (src/gpu/flora.ts, src/gpu/wgsl/stems.ts), laid by the generator at the stand's measured density (src/terrain/flora.ts) and grown, crowded and starved once a day by the rules below. The research behind the generator's rows is docs/research/generator/2026-10-14-flora.md.

### 11a. What replaced what

| Old rule | Now |
|---|---|
| Trees `floor(tree x 3.6 + r)` a 351.6 m2 quad, about 102 stems a ha at full cover | Stems laid until their crowns' shares of a closed stand fill the quad's tree cover (`crownShare`): Reineke's maximum density for pine and oak, crown packing by Hemery's crown widths for ash and aspen; never past a closed quad but for a lone tree |
| Bushes `floor((5 shrub + 1.2 edge) x 0.6 + r)` | A Boolean cover of their crowns (a ball as wide as tall): crowns filling -ln(1 - shrub) of the quad [derived]; the edge term is gone, the understorey's light carrying the edge |
| Tree height `tall x clamp(0.45 + 0.75 f) x (0.7 + 0.55 r)` [design] | The stand's quadratic mean height at the site (the fit standing in for site index across del Río's measured span), each stem's diameter a Weibull draw about the stand's, its height that diameter's, capped at its kind's maximum |
| Trees skip slope > 0.7 | Trees skip ground bare of soil (ground.ts soil) [derived] |
| light.ts `crownRadius` 0.18 to 0.35 of the height | The radius of a disc of the crown's share of a closed stand; a bush's half its height. CROWN_REACH follows the widest (ash at 42 m, 22 m) |
| TALLEST 30 m (PLANTATT's tallest) | 42 m, iLand's tallest tree (R97) |
| Trees once up never grew (sec. 9 gaps) | Each stem grows daily by the M^(3/4) law under its own light (11c) |
| recruits.ts treeKg on the rounded log diameter, its own c and reference | plants.ts treeKg on flora.ts dbhOf, GROWTH_C and openNet, shared by the young trees and the stems; the plant rule there takes each kind's own FAO-56 p |

### 11b. Constants

| Quantity | Value | Units | Source |
|---|---|---|---|
| Reineke SDImax, Scots pine | 890 (395 to 1,354), b = 1.593 | stems a ha at D 25 cm | R650 Table 1, R651 [read via the generator notes] |
| Reineke SDImax, oak | 733 (393 to 1,113), b = 1.424 | stems a ha at D 25 cm | R650, R651 |
| Crown width by diameter | ash K = 0.758 + 20.357 d; poplar (for aspen) 0.801 + 18.950 d; oak 1.717 + 15.616 d (not used, below) | m, d in m | R652 Table 1 |
| Stand mean height about 72 years old | pine 22.7 (10.8 to 31.2); oak 21.7 (9.1 to 32.3) | m | R650 Table 1 |
| Ash and aspen stand heights | the same span as shares of their maximum height, 0.248 to 0.796 | - | [gap] |
| Weibull shape of diameters | 3.6, the dense end of 2 to 3.6 | - | R653 [abs]; pick [design] |
| Maximum heights | pine 42, oak 38, ash 42, aspen 30 | m | R97 (fire-constants) |
| Height to diameter | pine 1.721 H^0.842, oak 0.489 H^1.334, aspen 0.343 H^1.371, ash (100 H / 290)^1.938 | cm, m | fire-constants sec. 19 (R97, R98) |
| Crop, Scots pine | 12,000 seeds a tree in good years, 13 of 19 | seeds | R455 |
| Crop, ash | up to 140,000 fruits a tree in a mast year, masts every 2 to 5 years (a year in 3.5) | fruits | R458 [derived] |
| Crop, oak | 0.196 kg fresh a m2 of crown in the 13 of 27 years with a crop | kg/m2 | R454 |
| Crop, aspen, hazel, bramble, heather | none recorded | - | [gap] |

### 11c. The daily law

- **The crown raster.** Every live stem is filed by its 18.75 m texel (the generator's quads, four to a cell), with its height and its crown's share of a closed stand as a Q16 share of the texel. Unit 12 reads the same lists for light, interception and the renderer's canopy.
- **Light.** The crowns of the stems taller than it in its texel, and half of those exactly as tall, spread evenly over the texel, layer on layer, each letting 2% through (growth.ts UNDER_CROWN), no more lost past two layers (light.ts's cap, removed in Unit 12) [design: the texel is the resolution].
- **Crowding.** In each texel the trees, tallest first, take their crowns' shares; one whose own share with those of all taller passes the texel is thinned, the smallest first, as Reineke's maximum density has it. A tree with none taller stands whatever its crown. Bushes stand as a Boolean cover and are not crowded [design].
- **Growth.** A tree's q = M^(1/4) gains c/4 a year times its place's net gain over the reference ground's (sec. 9), the net gain from the cell's seasons drawn between their middles, the kind's fit at the cell's centre [design] and the stem's light. A bush's q changes by the plant rule's own relative rate a quarter of the mass's, never past its mass as laid [design: a grown shrub's growth is a gap; its size stays as laid].
- **Death.** A stem whose mass falls to half the most it has weighed dies, as the young trees' rule has it [design, sec. 1]. A stem the GPU kills goes from the world; it does not stand dead or fall [gap: deadwood is Unit 9's].
- **Seed.** Each stem's year's crop, set daily for the year it is in: pine and ash per tree in their good and mast years, oak by its crown's share, drawn per kind and year from the counter generator; recorded for Unit 8, which sheds it.
- **Fixed point.** Heights in mm, q in 2^-20 kg^(1/4), light and shares in Q16, coefficients integers worked out on the CPU from the cell's seasons; every kernel integer, sums order-free, so the GPU's words are the same on every adapter and equal the TypeScript oracle's (src/gpu/stems.test.ts).
- **The CPU.** One copy of every stem's height (two to a word) comes back with the landing of the tick the law ran; lookups everywhere answer from it with the CPU's own changes laid over, and stocked tiles' trees and bushes take their new heights or go (space.ts grownOn).

### 11d. Checks (seed 1, 2026-10-15)

Stems laid: pine 389,334, oak 500,812, ash 209,628, aspen 539,094, hazel 5,282,875, bramble 3,154,337: 10,076,080, against 1.36 million trees and bushes before. Trees hold 12,191 ha of tree cover, 134 stems a ha on the whole of it.

| Kind | Stems a ha of the ground its crowns close | Quadratic mean diameter, cm | Mean height, m | Measured |
|---|---|---|---|---|
| pine | 730 | 28.8 | 27.2 | 802 a ha at dq 28.4 (R650); about 800 in unthinned Danish and Swedish stands |
| oak | 325 | 45.5 | 28.4 | 823 at dq 26.4 (R650) |
| aspen | 459 | 23.8 | 20.6 | [gap] |
| ash | 47 | 77.1 | 25.5 | [gap] |
| bramble | 2,140 a ha of the shrub cover | - | 0.6 | 434 to 4,085 a ha in fenced Dutch pine stands (R475) |

- An open-grown stem reaches the calibrated law's heights at 10 and 30 years and its calibration point within 2 cm (stems.test.ts); a closed oak stand holds Reineke's count within one stem as it grows; a stem in deep shade loses mass daily and dies the day it falls to half its peak.
- No two trees in a texel hold more than it after a day; 338 of 10,076,080 stems died the first day (crowns rounded past the texel's edge, and the starving).

Gaps the checks show:
- Oak stands at 40% of del Río's density: the generator's oaks stand at 28 m on average (fit as site index puts most stands near the top of the measured span) and BAAD's oaks (American and Japanese) are fat for their height, so at the same height Reineke's count is low [gap: oak's own height to diameter; stand age].
- Ash at 47 a ha: its diameters come from iLand's crowded bound (fire-constants sec. 19, the only ash source), 77 cm at 25 m, and Hemery's crown widths at those diameters are 17 m. Hemery's widths are those of free-growing crowns: for oak they pack a closed stand at 0.55 of its Reineke count, so ash and aspen packed by them likely stand that far below their real maximum [gap: SDImax for ash and aspen].
- Hazel at 5.3 million: the bush sizes are the old spread [design], so the Boolean count follows sizes nobody measured [gap: hazel's crown sizes and stems a ha].
- The year's crop of aspen and the bushes, and a stem's crop by its size or light, are not known [gap].
- Leafless broadleaves let through what they do in leaf [gap].

## 12. Deadwood and clasts (the GPU plan's Unit 9; the rule audit's substrate 11f)

Every log, snag, stick, boulder, stone and pebble on the island is a piece with its own identity on the GPU (src/gpu/deadwood.ts, src/gpu/wgsl/deadwood.ts), and the CPU makes a Thing of one only where a lookup asks for it (src/sim/space.ts). The generator no longer lays any of them (src/terrain/flora.ts).

### 12a. What replaced what

| Old rule | Now |
|---|---|
| Sticks `floor(tree 0.7 + edge 0.15 + 0.01 + r)` a quad, 0.4 to 1.6 m, about 20 a ha | Fine woody debris at Nordén et al.'s 12.2 m3 a ha (R750) as metre sticks, 17,000 a ha of closed canopy, rotting at 0.2 a year (R452), a stick a whole piece that goes at that rate; the world begins with each cell's steady pool, and new sticks fall from the crowns every BIN_DAYS days at input = rate x pool, by the cover the crowns kept over the cell |
| A taken stick came back where it lay at the turnover rate (ecology.ts STICK_TURNOVER, the taken-tick rule) | A taken stick is listed gone and never comes back; new ones come only from litterfall |
| Fallen logs `floor(tree 0.12 + r)` a quad, 2 to 9 m, about 3.4 a ha (0.6 m3) | Every tree the stems' law starves or crowds out is born a snag where it stood (its kind, height and diameter), falls at a snag's fall rate and rots at its kind's; the world begins with the reserves' pool, 94 m3 a ha of logs and 39 of snags (R752), each piece a copy of a tree of its stand |
| Boulders `floor(bare 1.6 + slope 1.5 + 0.8 r)` a quad, 0.5 + r^3 5 m; stones and pebbles by cover and slope | Boulders of 2 dm and up at SLU's surface counts for the cell's drift (R756), stones (1 to 2 dm) and pebbles (2 cm to 1 dm) as many times that as till's N(> d) ~ d^-2.9 has them (R757), each piece's size drawn from the same law; nothing stored until one is moved |

### 12b. Constants

| Quantity | Value | Units | Source |
|---|---|---|---|
| Fine woody debris (1 to 10 cm), southern Swedish oak woods | 12.2 | m3/ha | R750 [abs] |
| Sticks a ha, metre pieces | 17,000, each 3.02 cm thick | /ha | [derived] from R750; the spread of their sizes [gap] |
| Fine woody debris's rate of loss | 0.2 (0.17 to 0.25) | /yr | R452 |
| Rate of loss of logs | pine 0.032, aspen 0.066; oak 0.032 and ash 0.054 [gap: pine's and beech's stand in] | /yr | R753, R754 [abs] |
| Wood loss in canopy gaps against under the canopy | about 10% more | - | R751 [abs]; as a rate [derived] |
| Snags half fallen, 40 cm | pine 16 (lodgepole), broadleaves 28 (deciduous) | yr | R755 Table 2.2 [proxies: western North America] |
| Snag persistence by diameter | half-life ~ diameter^0.60 (0.41 to 0.83) | - | R755 sec. 2.1 |
| Unmanaged reserves' deadwood, European mean | logs 94, snags 39 (Danish reserves 48 to 154 of logs) | m3/ha | R752 Table 1 |
| Danish forests, deadwood of 10 cm and up | 4.6 (34% lying); Hovedstaden 7.6, 3.5 lying | m3/ha | R758 Tables 4.11, 4.14 |
| Surface boulders of 2 dm and up, in a 314 m2 plot | count classes 1 to 5, 6 to 10, 11 to 20, 21 to 30, 31 to 50, 51 to 100, over 100 | /plot | R756 |
| Boulders a ha by drift | bare rock 1,289 (31 to 50), sandy till 493 (11 to 20), clay till 95 (1 to 5), meltwater sand and peat none | /ha | R756 classes, the pick [design] |
| Clast number by size | N(> d) ~ d^-2.9 | - | R757 [abs]: a till's grains; for boulders and for surface counts an extrapolation [UNVERIFIED] |
| Widest boulder | 5.5 | m | [gap] (the old generator's) |
| Litterfall bins | every 10 game days (a quarter of a game year) | - | [design: memory, 12d] |
| Rot units | 128 an hour under a closed canopy | - | [design: the canopy effect's resolution] |

### 12c. The laws

- **Rot.** Each hour every cell records its rot, 128 (1 + 0.1 open) units with open the share of the cell no tree crown covers (the stems' crown raster, refiled each day), as a recorded driver channel (tiers/drivers.ts). A piece's rot is the exact integral of its cell's channel since its birth, from its anchor; temperature and moisture don't drive it yet [gap: Unit 12's per-piece moisture].
- **Rotting away.** A piece of rate k has Lambda = rot k / 128 game years (40 days) and lies on while the top 16 bits of its own uniform word stay below e^-Lambda (qexp, Q16.16): each piece lasts an exponential time at its class's rate and goes whole, so a pool fed I holds I / k [derived]. Snags rot at their kind's log rate [gap: snags rot slower].
- **Falling.** A snag stands while the top 16 bits of its fall word stay below e^-(age fr), fr its kind's 40 cm rate times (40 cm / diameter)^0.60 [derived: R755's half-lives as constant rates; the synthesis finds rates rising with age for long-standing kinds].
- **Litterfall.** Every 10 game days each cell's bin of sticks is born, Poisson(k 17,000 a ha x the cell's area x its cover-days / 40); the world's first bin is the steady pool, Poisson(17,000 a ha x area x cover / (1 + 0.1 open)). Member k of a bin is drawn from (seed, cell, born, k): its place in the cell, then its word.
- **Clasts.** A cell's count of each class is split in half eight times, x then y, by exact Bin(n, 1/2) draws (rand.ts binhalf), so member k lies in one of 16 x 16 squares and the members of a square are a run of k (the CPU reads only the squares a lookup touches); its place in the square and its diameter (d = lo (1 - U (1 - (lo / hi)^2.9))^(-1 / 2.9)) from its own stream.
- **Touching.** A piece a person, an animal or a fire changes goes active (a stick or clast at its place, a log as a logup with the state it had) and the dormant member is gone; one taken is stored nowhere and never returns. Active pieces don't rot further yet [gap: their law is the dormant one stepped; Unit 12].
- **Fuel.** A stick or log Thing carries its own thickness (girth), which fuel.ts pieceOf gives the pieces gathered from it.
- **Fixed point.** Every kernel is integer arithmetic, sums order-free; the dormant answer equals the same stick stepped hourly bit for bit on both adapters (src/gpu/deadwood.test.ts).

### 12d. Checks (seed 1, 2026-10-15)

| Quantity | Seed 1 | Cited |
|---|---|---|
| Crown cover of the cells (the raster's) | 7,102 ha | 12,191 ha of tree cover (sec. 11d, the generator's quads) |
| Sticks | 114,625,461; 16,139 a ha of crown cover, 11.6 m3/ha | 17,000 a ha, 12.2 m3/ha (R750) under a closed canopy; open cells hold less by (1 + 0.1 open) |
| Logs | 306,943; 101.8 m3/ha of crown cover | 94 (R752); Danish reserves 48 to 154 |
| Snags | 127,287; 42.1 m3/ha | 39 (R752) |
| Logs and snags by kind | aspen 256,068, oak 63,185, pine 57,637, ash 57,340 | - |
| Boulders, stones, pebbles | 9,756,334; 63,065,700; 7,678,412,118 | SLU classes x the power law (12b) |
| GPU memory of the deadwood and clasts | 194 MB (room for 726,074 logs and 4,454,833 bins) | 1.5 GB a world [design], the stems 0.78 GB |

- A closed stand fed at a steady rate holds input / rate by piece class, counted the same hour each day just after the day's pulse (I / (1 - e^-k)): sticks 616,602 against 618,140, dead trees 8,201 against 8,202, snags among them 3,465 against 3,462 (a law sped up a hundred-fold so the test reaches steady state; deadwood.test.ts).
- A stand's pool of some 28,000 sticks under a canopy closing from a fifth to whole over a game year, each stick also stepped hourly as an active object: every stick's state equal, and the GPU's count of the bins equal to both, bit for bit on the AMD and Intel adapters.
- A picked stick never returns over three litterfalls; every new stick is of a bin born since.
- A dead tree's state (gone, snag, log) on the GPU equals the twin's at every day, and its fall rate the twin's.
- A cell's clasts on the GPU equal the twin's member for member, and their sizes follow the truncated power law.

Gaps the checks show:
- Logs stand 8% above the reserves' mean: the pool is laid by each tree's crown share of its texel, and crowns overfill some texels (lone trees, rounding), so the pool per ha of capped cover runs over [derived; not retuned].
- The crowns' cover (7,102 ha) is under the generator's tree cover (12,191 ha), so the island holds sticks and logs on less ground than the quads' cover says (sec. 11d's gaps on crown sizes carry over).
- The island holds reserve levels of deadwood, twenty times Denmark's managed forests (R758): right for a never-logged island, as the generator notes chose.
- A bush that dies leaves no piece; snags are not yet things people see; the renderer draws pieces only once they are Things (Unit 14).
- Bins every 10 game days keep the deadwood at 194 MB, room for the bins' steady state included (each bin lasts until its last stick rots); bins ten times as often (a game day each, a tenth as big) would take about 6.6 times the bins' 142 MB, as H(48) / H(478) x 10 [derived].

## 13. Seeds and seedlings (the GPU plan's Unit 8)

Every seed a live parent stem sheds is evaluated on its own on the GPU (src/gpu/seedlings.ts, src/gpu/wgsl/seedlings.ts; constants and drivers src/sim/seeds.ts), and those that live to come up become seedlings. src/sim/recruits.ts is gone; its cohort rule (sec. 9) is the test oracle in src/gpu/seedlings.test.ts.

### 13a. Representations

- **Seeds, streamed.** Seed k of the stem in slot i in year y lives to come up when word k mod 4 of the Philox block (i, k / 4) under (seed ^ generation, SURV + y) falls below its kind's chance; one that lives draws its distance and one of 1,024 bearings from its own stream (i, k). Landing off the island or on water it is gone; else it joins its 18.75 m texel's count of seed in the soil until its kind's day. A day's blocks are shed over the day's first 32 ticks [design: cost], the sums the same however they are split. Only live parents shed, so a parent that dies stops shedding.
- **Seedlings, lumped.** The crops cited make some 10^9 ash seedlings after a mast and 6 x 10^7 pine on seed 1, past what 4 GB holds as active objects (36 GB for ash alone at 24 bytes). Every input of the seedlings' law is shared within a texel (the crowns over it, its cell's coefficients, its 600 m block's deer and rabbits), so the members of a kind come up on one day in one texel share one state: a bin (store kind "seedling", 2^22 bins). A day's fates are drawn exactly for the bin (the binomial, keyed by the bin and day); a member is (bin, rank in the bin's seeded Feistel permutation), losses taking the highest ranks.
- **Standing up.** A bin as tall as its cell's own stand (flora.ts treeHeight at the cell's fit, its spread's middle), or of brambles in their second summer at a bush's mass, is marked; the next day each member stands up as a stem of kind plant, at a place in the texel drawn from its identity, and the stems' law (sec. 11) has it from then on. Trees people raise (ecology.ts matured, a seedling come up) are plant objects too (flora.ts make): the GPU grows, crowds and starves them, and their Things follow.

### 13b. Constants

| Quantity | Value | Source |
|---|---|---|
| Pine: seed living to come up | 0.6 viable (50 to 70%) x 0.067 standing on unprepared ground | R455 Table 2.2, R457 [derived] |
| Ash: fruit living to come up | sqrt(0.011 x 0.245), 5.2% | R458 [derived] |
| Oak: acorns living to come up | 0.02 cached and lost x 0.685 coming up | R461, R462 [derived] |
| Pine kernel | exponential, mean the tree's height / ln 5 (80% within its height) | R455 Table 2.6 [derived] |
| Ash kernel | exponential-power, mean 39.1 m, shape 2.085 | R459 |
| Oak kernel | lognormal, median 25.9 m, 95th percentile 116 m | R460 [derived] |
| Bramble seed, daughters, aspen suckers | birds' exponential 95% within 100 m; 3.3 m; within 40 m, 75,000 a ha | R468, R466, R463, R464 [derived] |
| Pine comes up only where the crowns leave | 60% of full light | R455 Table 4.1 (pines and larches; the table's layout read as 50 to 60%) |
| Shed and coming up (island days) | pine sheds April 1 to mid May, up mid May [design: R455 Table 2.5's April to July held to one coming up]; oak sheds mid September to late October, up June 1; ash sheds October to December [UNVERIFIED], up early May after two winters; brambles April 20 and October 1 | R454, R455, R458, R460, R466 |
| Browsing | as sec. 9 (R471 to R474), by the day's deer and rabbits in each 600 m block [design: the block] | |
| Thinning | the larger bins of a texel first (ties by slot), each member's crown its share of a closed stand (flora.ts crownShare); the largest keeps one whatever its crown | [derived], as the stems |

### 13c. Checks (seed 1, 2026-10-15)

- The kernels: a 20 m pine's 12,000 seeds land 79.9% within 20 m (cited 80%); an ash's 140,000 fruits at a mean of 39.10 m (cited 39.1).
- Streamed against active: two pines' year of 24,000 seeds, every seed also stepped day by day as an object of its own, give the same survivors texel by texel (950, 3.96% against the law's 4.02%); and so with a parent killed on the shed's third day (183 of its 475).
- A law day (sheds, suckers, coming up, growth, browsing, thinning) equals the TypeScript oracle bit for bit over 15 days, on the AMD and the Intel adapter; the census equals the bins. A shore pine's seed: 134 lived but fell on the water and none came up there; pines' seed blown under a closed oak stand came up in no texel the crowns shade past 40%; ash fruit under crowns letting through under 10% came up two springs on. Pine bins as tall as their stand stood up as 381 stems at the places their identities give.
- Seed 1 over four island years (the island's own mast draws: pine masted in years 1 and 3, oak and ash in none of years 0 to 3; oak first masts in year 5, ash in year 4): pine within 50 m of a pine on open ground 6,778 a ha at the end of year 2 (0.7 years after coming up), 4,604 at the end of year 3, 9,733 at the end of year 4 (two cohorts), against R455's under 5,000 a ha two years on on untreated ground: over it [gap]; under crowns 96 to 361 a ha. Oak in old fields (open ground within 100 m of an oak): none, as no oak masted in the run; R800's 147 to 287 a ha not yet compared [gap: a run to year 7].
- Memory: bins 144 MB, seed in the soil, drivers and parent lists about 60 MB, store scratch 118 MB; the stems' room for the young (sec. 11) 38 MB more; with the stems' 0.78 GB and the deadwood's 194 MB about 1.2 GB, under the 1.5 GB budget.
- Cost (AMD, other jobs running): a law day with the stems about 200 to 450 ms p50; a pine mast's shed day 1 to 3.5 s before the shed was split over the day's first 32 ticks.

Gaps: pine seedlings over R455's count; the 6.7% establishment already holds early deaths the seedlings' own starvation and browsing count again (as sec. 9); oak's and ash's own light thresholds; what the deer and rabbits eat of the young doesn't feed them; stems the young stand up as aren't Things for people yet (the renderer draws them from the buffer); a world read from its JSON alone, without its store, keeps people's raised trees as Things off the GPU; aspen's seed, hazel's and heather's spread; bins past 2^22 and stems past the room are not born; the shed's slices are not yet timed on the play page.

## 14. Grass tillers, reed shoots and fine litter (the GPU plan's Unit 12b)

Lumped kinds on tiers/lumped.ts (src/gpu/smalls.ts; laws src/gpu/wgsl/smalls.ts; constants, tables, drivers and the laws' TypeScript twins src/sim/smalls.ts; research note docs/research/generator/2026-10-16-lumped.md, R950 to R967, R997 to R999). Each kind merges its bins after every step: one bin a (75 m cell, state), stayers first (tiers/lumped.ts header). The animals graze the tillers and the standing dead blades through the Ground link (animal-constants sec. 12, sec. 14).

### 14a. Tillers

| Quantity | Value | Source |
|---|---|---|
| Daughters a vegetative tiller a real day | kN Fs LA, kN 0.25; Poisson a game day, 3 and more counted as 3 [design] | R950 eqns 2a to 2g; kN [INFERENCE on R955] |
| Leaf appearance | 0.14 clamp((T - c) / (d - c)), c, d 0, 16 C 1 March to 10 June, 10, 18 C after | R950 eqn 2d |
| Site filling | 0.867 - 0.183 LAI, after a bite 0.335 - 0.067 LAI, clamped to [0, ln 2]; a bitten tiller at the bite's for 0.473 of the day | R950 eqn 2c; [derived] |
| Deaths a real day | 0.003 May to October, 0.0015 November to April, plus 0.09 (LAI - 6) / 4 above LAI 6 | [INFERENCE on R955, R954]; R950 eqns 2e, 2f |
| Lamina classes | 0.25 mg x 2^k above the grazing height, k 1 to 7, none in class 0 (a tiller grazed to its sheaths, or a daughter whose first leaf has only its tip out of the sheath); a day ends in the class below the tiller's lamina or the one above, at the chance that keeps the expected lamina | [design]; R997 (a leaf and a tiller scored at the tip) [INFERENCE]; [derived] |
| Lamina growth a tiller | a full leaf's lamina for each leaf it makes: 32 / 3 mg (the top class over three live leaves) each 94.3 degree-days over 0 C, or the layer's growth (the forage rule's) shared equally over its tillers where that is less; carbon past the top class lost | R953 (LL = LER / LAR; live leaves = LAR x leaf life), R997, R950 eqn 1c; Meuriot et al. 2018 (R1100: reserves carry a defoliated ryegrass's leaf growth about its first 3 days) [derived; INFERENCE: shared by tiller] |
| Senescence | s = degree-days over 4 C / 460 of the lamina a day; over an island day m0 exp(-s) + R (1 - exp(-s)) / s from m0, R the day's growth | R392 (the forage rule's); [derived] |
| A bite | half a tiller's lamina above the grazing height; the sheaths and meristems stay and regrow it, the tiller lives; an elongating tiller's apex goes with the bite and it dies; chance target / (0.5 B) | R953 (50%; apex decapitation in reproductive tillers), R950 eqn 4c; [derived] |
| Field layer | the canopy's leaf area -ln(light) / 0.8 added to the sward's | [INFERENCE], note sec. 1.2 |
| Calendar | vernalised 1 March, elongating 8 May to 10 June, flowering to the end of June, dying once seeded in July | R950 eqns 2b, 2g; [design] |
| Start | open sward 5,000 a m2 at 32 mg, field layer 3,000 at 16 mg | R951; note sec. 1.4 [design] |
| Reed | one cohort from real day 80 to 140 at 600 a m2 (300 under standing dead), thinned to 125 by the end of June, frost under -6 C kills emerging shoots, dead October to December, culms break at 1 / (2.5 x 365) a day, 15 leaves a shoot | Granéli 1989, Hara et al. 1993, R959 [INFERENCE] |

### 14b. Fine litter

| Quantity | Value | Source |
|---|---|---|
| Foliar fall under a closed stand, g/m2 a year | pine 200, oak, ash and aspen 280 (broadleaf crowns split 39.1 : 16.4 : 42.1) | R960, R962 [INFERENCE]; note sec. 0 [derived] |
| Piece mass | pine needle 15 mg [UNVERIFIED], oak 143 mg, ash 92 mg, aspen 96 mg [gap: hazel's], grass blade 4 mg [design], reed leaf 0.17 g [INFERENCE], reed stem 7.4 g [derived] | R967 |
| Falling | the year's leaves born on their plants on their year's first day (broadleaves 5 May, pine 1 January, reed leaves as their shoots die), falling each day at the day's share over the shares left | note sec. 2.1 [INFERENCE: monthly shares] |
| Decay | mass classes 0.8^j, moving at 5 k_j a year; pine 0.359, 0.30, 0.24, 0.171 to humus after 7 classes; oak 0.226 and aspen [gap: oak's] after 5; ash 1.98, grass lying 0.9, standing blades 1.46 (falling at 1 a year), reed leaves 1.28, reed stems 0.95 after a lag left at 2 a year, gone from the last class at k | R961, R963, R964, R965, R966, R395 [derived; INFERENCE; design] |
| Half-year multipliers, macrofauna | ash 0.57 / 1.43, oak 1.17 / 0.83; whole pieces taken at 0.87 a year on base-rich soil (pH 5.45 and over) | R961 [derived]; R962 [INFERENCE] |

A day's chances are the chain's transient probabilities over the island day (uniformization in float64, sent as dyadic boundaries), exact for any step but for standing blades, which pass at most 3 classes a day [design: the rest, under 10^-4 of them, folded in]. The tillers' dead lamina (what senesces of each tiller's over the day, and dead tillers') becomes standing blades, the carry under a whole blade kept by the cell. Fire's grass reads its cured share from the census: the cell's standing dead blades against them and its green lamina (src/sim/spread.ts grass, fire-constants sec. 12); every litter piece's water is the moisture law's blade class at its texel (wgsl/moisture.ts, sec. 35), which already held one water for each class.

### 14c. Checks (2026-10-16)

- One cell of open sward under steady drivers (15 C on the after-10-June branch, 18 MJ/m2 a day [design], fertility 0.5, summer deaths all year, no calendar), 400 island days (src/gpu/smalls.test.ts): the GPU's bins equal the twin's step by step on the AMD adapter, and the first 60 days on the Intel one. It settles at LAI 3.978 against van Loo's LAI* 3.988, 4,959 tillers a m2 of 30.4 mg lamina, on the constant-LAI line, log10 of 4,959 / 5,000 = -0.004 against R951's band of 0.17 about the lax anchor: within it (2026-10-16, after the regrowth law below; the first law settled at LAI 3.52 and 11,946 tillers of 11.2 mg, its daughters starving back from class 0).
- A grazed cell, a tenth of its green eaten each day for 40 days: 3,331,165 g eaten, 3,331,020 g bitten off, 145 g owed: intake equals what the bins lost but for the credit carried (the first law's cell, grazed down to 66 g/m2 of lamina, gave 1,483,421 g; the regrowing sward holds about 145 g/m2 under the same tenth a day).

Gaps: the defoliated run toward R951's close-grazed anchor (20,000 at 13 mg) and the slope against R951's -1.5 and R952's -2.3 to -2.5 were not run; forbs, clover and ferns are not tillers yet (no ramet law but R999's buttercup); field-layer light by texel; hazel and heather litter; twigs under 1 cm; ground litter as a bed fire burns (fire-constants sec. 30a still leaves it out); the litter run against R963's 72% after a year and the sec. 2.3 pools; aestivation and pH of earthworms (animal-constants sec. 14).

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
- R457 Lariviere D., Djupström L., Nilsson O. (2025), Impact of varying retention proportions on Scots pine establishment across planting, direct seeding, and natural regeneration, Silva Fennica 59(3):25007 (6.7% of seed sown on unprepared ground standing as seedlings at the last inventory, 47.3% on prepared). https://www.silvafennica.fi/article/25007 (read 2026-10-14)
- R458 Thomas P.A. (2016), Biological Flora of the British Isles: Fraxinus excelsior, J Ecol 104:1158-1209 (up to 140,000 seeds a tree; masts every 2 to 5 years; two winters' dormancy, germinating mid April to the end of May; seedlings 1.1 to 24.5% of fruit production two years before, Tapper 1992). https://besjournals.onlinelibrary.wiley.com/doi/full/10.1111/1365-2745.12566 (read via archive, 2026-10-14)
- R459 Semizer-Cuming D., Kjær E.D., Finkeldey R. (2017), Gene flow of common ash in a fragmented landscape, PLoS ONE 12:e0186757 (seed kernel mean 39.1 m, shape 2.085). https://pmc.ncbi.nlm.nih.gov/articles/PMC5650178/ (read 2026-10-14)
- R460 Gerzabek G., Oddou-Muratorio S., Hampe A. (2020), Recruitment of a genotyped Quercus robur seedling cohort in an expanding oak forest stand, Ann For Sci 77:78 (open areas: median 25.9 m, 95th percentile 116.0 m); seedlings emerge in May and June (Bossema 1979). https://doi.org/10.1007/s13595-020-00979-5 (read 2026-10-14)
- R461 Bogdziewicz M., Crone E.E., Zwolak R. (2020), Do benefits of seed dispersal and caching by scatterhoarders outweigh the costs of predation?, J Ecol 108:1009-1018 (2% of Q. petraea acorns cached and never retrieved). http://rzwolak.home.amu.edu.pl/userfiles/file/publikacje/2020%20Bogdziewicz%20Crone%20Zwolak.pdf (read 2026-10-14)
- R462 Zwolak R. et al. (2024), Scatterhoarder abundance and advantages of seed burial drive dynamics of a tree-rodent interaction, J Ecol (71% and 66% of buried acorns producing seedlings; acorns usually 1 to 6 g). http://www.rzwolak.home.amu.edu.pl/userfiles/file/2024%20Zwolak%20et%20al%20J%20Ecol.pdf (read 2026-10-14)
- R463 Jobling J. (1990), Poplars for Wood Production and Amenity, Forestry Commission Bulletin 92 (aspen suckers some 40 m from the parent on open ground; felling and disturbance stimulate them). https://cdn.forestresearch.gov.uk/1990/03/fcbu092.pdf (read 2026-10-14)
- R464 Rytter R.-M., Rytter L. (2018), iForest 11:619-627 (hybrid aspen 50,000 to 100,000 root suckers a ha after clear-cutting); USDA FEIS Populus tremuloides (50,000 to 100,000 stems a ha after clearcutting) [proxies]. https://iforest.sisef.org/contents?id=ifor2853-011
- R465 Johansson T., Lundh J.-E. (1988), Sucker production from root cuttings of Populus tremula, Scand J For Res 3:75-82 (sucker biomass 4,200 mg at 4 cm depth and 25 C). https://doi.org/10.1080/02827588809382497 (abstract)
- R466 Amor R.L. (1972-1974) via Hoshovsky M.C., Cal-IPC IPCW Plant Report: Rubus discolor (canes reaching 3.3 m, 96% with daughter plants at their tips; under 0.4 seedlings a m2 near thickets); Agriculture Victoria, Blackberry (canes fruit in their second year; daughter plants in autumn). https://www.cal-ipc.org/resources/library/publications/ipcw/report71/ (read 2026-10-14)
- R468 Williams P.A. (2006), The role of blackbirds in weed invasion in New Zealand, NZ J Ecol 30:285-291 (most seed deposited within 50 m, nearly all within 100 m, after Debussche, Théry and Jordano). https://newzealandecology.org/nzje/2325/pdf (read 2026-10-14)
- R469 Niklas K.J., Enquist B.J. (2001), Invariant scaling relationships for interspecific plant biomass production rates and body size, PNAS 98:2922-2927 (G as M^(3/4); height as M^(1/4)). https://doi.org/10.1073/pnas.041590298 (abstract via Crossref)
- R470 Bradley R.T., Christie J.M., Johnston D.R. (1966), Forest Management Tables, Forestry Commission Booklet 16, Tables 55 and 67 (Scots pine YC 100 top height 7.5 m at 20 years; oak YC 60 7.8 m; ages from planting, 2 to 4 years after seed); Wellock M.L. et al. (2014), J Plant Ecol 7:429-438 (ash 11.4 m at 20 years); Johansson T. (1996), Site index curves for European aspen, Silva Fennica 30:437-458 (SI 20: 11.41 m at 20 years). https://cdn.forestresearch.gov.uk/1966/03/fcbk016.pdf (read via the SaplingGrowth research, 2026-10-14)
- R471 Hodge S., Pepper H. (1998), The Prevention of Mammal Damage to Trees in Woodland, Forestry Commission Practice Note 3 (red deer browse to 1.8 m; rabbits to 0.54 m). https://cdn.forestresearch.gov.uk/1998/01/fcpn3.pdf (read 2026-10-14)
- R472 Palmer S.C.F., Truscott A.-M. (2003), Browsing by deer on naturally regenerating Scots pine, For Ecol Manage 182:31-47, as cited by Spracklen D.V. et al. (2025), Ecol Sol Evid 6:e70016 (under 15% of saplings browsed below 2 deer a km2, 30% at 10, 80% at 20). https://eprints.whiterose.ac.uk/223472/ (secondary)
- R473 Brooker R.W., Scott D., Palmer S.C.F., Swaine E. (2006), Transient facilitative effects of heather on Scots pine along a grazing disturbance gradient, J Ecol 94:637-645 (browsed saplings 70% and 50% dead by the final harvest, unbrowsed 20% and 15%). https://doi.org/10.1111/j.1365-2745.2006.01129.x (read 2026-10-14)
- R474 Bakker E.S. et al. (2004), Ecological anachronisms in the recruitment of temperate light-demanding tree species in wooded pastures, J Appl Ecol 41:571-582 (11.7 rabbits a ha; oak transplant survival 26% grazed against 85% fenced). https://doi.org/10.1111/j.0021-8901.2004.00908.x (read 2026-10-14)
- R475 Kuiters A.T., Slim P.A. (2002), Regeneration of mixed deciduous forest in a Dutch forest-heathland, following a reduction of ungulate densities, Biol Conserv 105:65-74, Table 2 (bramble in fenced Scots pine stands 434 to 4,085 shrubs a ha, 1988 to 1998; unfenced 258 to 60). https://edepot.wur.nl/26430 (read 2026-10-14)
- R650 del Río M., Pretzsch H. et al. (2020), Eur J For Res 139:349-367, Table 1 (Scots pine SDImax 890, 395 to 1,354; oak 733, 393 to 1,113; mean heights at about 72 years pine 22.7 m, 10.8 to 31.2, oak 21.7 m, 9.1 to 32.3; dq 28.4 and 26.4 cm at 802 and 823 stems a ha). https://link.springer.com/article/10.1007/s10342-019-01233-y/tables/1 (read for the generator notes, docs/research/generator/2026-10-14-flora.md)
- R651 Pretzsch H., Biber P. (2005), A re-evaluation of Reineke's rule and stand density index, For Sci 51:304-320 (Reineke exponents: pine 1.593, oak 1.424) [abs]. https://portal.fis.tum.de/en/publications/a-re-evaluation-of-reinekes-rule-and-stand-density-index/
- R652 Hemery G.E., Savill P.S., Pryor S.N. (2005), For Ecol Manage 215:285-294, Table 1 (crown width K = a + b d: oak 1.717 + 15.616 d, ash 0.758 + 20.357 d, poplar 0.801 + 18.950 d). https://benfieldgroup.uk/wp-content/uploads/2021/09/Hemery_et_al_2005_kd_paper.pdf
- R653 Siipilehto J., Mehtätalo L. (2013), Silva Fennica article 1057 (Weibull shape about 2 to 3.6 in normal to dense stands) [abs]. https://www.silvafennica.fi/article/1057
- R750 Nordén B., Götmark F., Tönnberg M., Ryberg M. (2004), Dead wood in semi-natural temperate broadleaved woodland: contribution of coarse and fine dead wood, attached dead wood and stumps, For Ecol Manage 194:235-248 (fine woody debris 12.2 m3/ha) [abs]. doi:10.1016/j.foreco.2004.02.043 (via the generator notes, docs/research/generator/2026-10-14-flora.md)
- R751 Forrester J.A., Fraver S., Mladenoff D.J., Gower S.T., D'Amato A.W., Lindner D.L. (2023), Experimental evidence that forest structure controls detrital decomposition, Ecosystems 26:1396-1410 (about 10% greater mass loss in gaps than under the canopy, across litter, stakes and logs) [abs]. https://research.fs.usda.gov/treesearch/69412 (read 2026-10-15)
- R752 Christensen M. et al. (2005), Dead wood in European beech (Fagus sylvatica) forest reserves, For Ecol Manage 210:267-282, Table 1 (European mean 94 m3/ha of logs and 39 of snags; Danish reserves 48 to 154 of logs). https://erdorezervatum.hu/sites/default/files/Christensen_etal_2005.pdf (via the generator notes)
- R753 Herrmann S., Kahl T., Bauhus J. (2015), Decomposition dynamics of coarse woody debris of three important central European tree species, Forest Ecosystems 2:27 (pine 0.032, beech 0.054 a year) [abs]. https://www.sciopen.com/article/10.1186/s40663-015-0052-5 (via the generator notes)
- R754 Shorohova E., Kapitsa E. (2014), Influence of the substrate and ecosystem attributes on the decomposition rates of coarse woody debris in European boreal forests, For Ecol Manage 315:173-184 (aspen 0.066, pine 0.014 a year) [abs]. https://www.sciencedirect.com/science/article/abs/pii/S037811271300827X (via the generator notes)
- R755 Huggard D., Kremsater L. (2007), Quantitative synthesis of rates for projecting deadwood in BC forests, Forest Science Program S084000, Table 2.2 and sec. 2.1 (years until half of 40 cm snags have fallen: lodgepole pine 16, southern pines 11, deciduous 28; half-life ~ DBH^0.60, 0.41 to 0.83). http://www.for.gov.bc.ca/hfd/library/FIA/2008/FSP_S084000a.pdf (read 2026-10-15)
- R756 SLU MarkInfo, Ytblockighet (surface boulders of 2 dm and up counted in a 314 m2 plot: classes none, 1 to 5, 6 to 10, 11 to 20, 21 to 30, 31 to 50, 51 to 100, over 100). https://www.slu.se/om-slu/organisation/institutioner/mark-miljo/miljoanalys/markinfo/markprofil/ytblockighet/ (read 2026-10-15)
- R757 Hooke R.LeB., Iverson N.R. (1995), Grain-size distribution in deforming subglacial tills: role of grain fracture, Geology 23:57-60 (N(> d) ~ d^-2.9) [abs]. (via the generator notes)
- R758 Nord-Larsen T. et al. (2016), Skove og plantager 2016, sec. 4.5, Tables 4.11 and 4.14 (Danish forests 4.6 m3/ha of deadwood of 10 cm and up, 34% lying; Hovedstaden 7.6, 3.5 lying). https://sgavmst.dk/media/00zj5xe5/2016_skove_og_plantager.pdf (via the generator notes)
- R800 Broughton R.K. et al. (2021), Long-term woodland restoration on lowland farmland through passive rewilding, PLoS ONE 16:e0252466 (old fields beside Monks Wood: 147 oak seedlings a ha two years after abandonment, 287 young oaks a ha after six; 132 and 390 live trees a ha after 24 and 59 years). https://journals.plos.org/plosone/article?id=10.1371/journal.pone.0252466 (read 2026-10-15)
- R950 van Loo E.N. (1993), On the relation between tillering, leaf area dynamics and growth of perennial ryegrass (Lolium perenne L.), PhD thesis, Wageningen Agricultural University (ch. 7 with E.A. Lantinga), doi:10.18174/201747. https://edepot.wur.nl/201747 ([read] OCR of the scanned thesis, model equations on p. 131)
- R951 Matthew C., Hernandez-Garay A., Hodgson J. (1995), Making sense of the link between tiller density and pasture production, Proceedings of the New Zealand Grassland Association 57:83-87, doi:10.33584/jnzg.1995.57.2190. https://www.nzgajournal.org.nz/index.php/ProNZGA/article/download/2190/1818/3583 ([read], Table 1)
- R952 Hernández Garay A., Matthew C., Hodgson J. (1999), Tiller size/density compensation in perennial ryegrass miniature swards subject to differing defoliation heights and a proposed productivity index, Grass and Forage Science 54:347-356, doi:10.1046/j.1365-2494.1999.00187.x. https://doi.org/10.1046/j.1365-2494.1999.00187.x ([abstract])
- R953 Gastal F., Lemaire G. (2015), Defoliation, shoot plasticity, sward structure and herbage utilization in pasture: review of the underlying ecophysiological processes, Agriculture 5:1146-1171, doi:10.3390/agriculture5041146. https://www.mdpi.com/2077-0472/5/4/1146 ([read])
- R954 Matthew C., Sackville Hamilton N.R. (2011), Analysing persistence of grass swards in terms of tiller birth and death, Grassland Research and Practice Series 15:63-68, doi:10.33584/rps.15.2011.3225. https://www.nzgajournal.org.nz/index.php/rps/article/download/3225/2849/4724 ([read])
- R955 Jónsdóttir G.Á. (1991), Effects of density and weather on tiller dynamics in Agrostis stolonifera, Festuca rubra and Poa irrigata, Acta Botanica Neerlandica 40:311-318, doi:10.1111/j.1438-8677.1991.tb01561.x. https://natuurtijdschriften.nl/pub/540839/ABN1991040004006.pdf ([read] OCR, Tables 1 and 3)
- R956 Kays S., Harper J.L. (1974), The regulation of plant and tiller density in a grass sward, Journal of Ecology 62:97-105, doi:10.2307/2258882. https://doi.org/10.2307/2258882 ([search excerpt])
- R957 Grant S.A., Barthram G.T., Torvell L., King J., Smith H.K. (1983), Sward management, lamina turnover and tiller population density in continuously stocked Lolium perenne-dominated swards, Grass and Forage Science 38:333-344, doi:10.1111/j.1365-2494.1983.tb01657.x. https://doi.org/10.1111/j.1365-2494.1983.tb01657.x ([abstract])
- R958 Davies D.A., Fothergill M. (1993), Comparative performance of white clover under cutting and continuous stocking by sheep, in Frame J. (compiler), White clover in Europe: state of the art, FAO REUR Technical Series 29. https://www.fao.org/4/v2350e/v2350e0h.htm ([read])
- R959 Granéli W. (1990), Standing crop and mineral content of reed, Phragmites australis (Cav.) Trin. ex Steudel, in Sweden: management of reed stands to maximize harvestable biomass, Folia Geobotanica et Phytotaxonomica 25:291-302, doi:10.1007/BF02913030. https://link.springer.com/article/10.1007/BF02913030 ([abstract])
- R960 Neumann M., Ukonmaanaho L., Johnson J., Benham S., Vesterdal L., Novotny R., Verstraeten A., Lundin L., Thimonier A., Michopoulos P., Hasenauer H. (2018), Quantifying carbon and nutrient input from litterfall in European forests using field observations and modeling, Global Biogeochemical Cycles 32:784-798, doi:10.1029/2017GB005825. https://www.dora.lib4ri.ch/wsl/dload/wsl:18403/PDF/view ([read]; equation operators partly lost in extraction)
- R961 Rawlik K., Nowiński M., Jagodziński A.M. (2021), Short life, fast death: decomposition rates of woody plants leaf- and herb-litter, Annals of Forest Science 78:6, doi:10.1007/s13595-020-01019-y. https://d-nb.info/1233267736/34 ([read], Tables 1, 2, 7)
- R962 Dahlsjö C.A.L., Atkins T., Malhi Y. (2024), Large invertebrate decomposers contribute to faster leaf litter decomposition in Fraxinus excelsior-dominated habitats: implications of ash dieback, Heliyon 10(5):e27228, doi:10.1016/j.heliyon.2024.e27228. https://pmc.ncbi.nlm.nih.gov/articles/PMC10943353 ([read], Table 2)
- R963 Ge J., Berg B., Dong L., Sun T. (2026), Climate dominance gives way to litter chemistry during long-term Scots pine needle decomposition along a boreal-to-temperate climate gradient, BMC Plant Biology 26:903, doi:10.1186/s12870-026-08711-7. https://www.ebi.ac.uk/europepmc/webservices/rest/PMC13196078/fullTextXML ([read]; class B and C means only in a figure)
- R964 Berg B., Gundersen P., Akselsson C., Johansson M.-B., Nilsson A., Vesterdal L. (2007), Carbon sequestration rates in Swedish forest soils: a comparison of three approaches, Silva Fennica 41(3):541-558, doi:10.14214/sf.288. https://silvafennica.fi/pdf/288 ([read])
- R965 Van Ryckegem G., Gessner M.O., Verbeken A. (2007), Fungi on leaf blades of Phragmites australis in a brackish tidal marsh: diversity, succession, and leaf decomposition, Microbial Ecology 53:600-611, doi:10.1007/s00248-006-9132-y. https://doi.org/10.1007/s00248-006-9132-y ([abstract])
- R966 Van Ryckegem G., Van Driessche G., Van Beeumen J.J., Verbeken A. (2006), The estimated impact of fungi on nutrient dynamics during decomposition of Phragmites australis leaf sheaths and stems, Microbial Ecology 52:564-574, doi:10.1007/s00248-006-9003-6. https://pubmed.ncbi.nlm.nih.gov/17006744/ ([abstract])
- R967 Niinemets Ü., Kull K. (2003), Leaf structure vs. nutrient relationships vary with soil conditions in temperate shrubs and trees, Acta Oecologica 24:209-219, doi:10.1016/S1146-609X(03)00094-8. http://www.zbi.ee/~kalevi/NiinKull2003.pdf ([read], Table 2; rows matched to species by order)
- R997 Fustec J., Guilleux J., Le Corff J., Maitre J.P. (2005), Comparison of early development of three grasses: Lolium perenne, Agrostis stolonifera and Poa pratensis, Annals of Botany 96:269-278, doi:10.1093/aob/mci175. https://pmc.ncbi.nlm.nih.gov/articles/PMC4246875/ ([read] by the tiller pass)
- R998 Bullock J.M., Clear Hill B., Silvertown J. (1994), Tiller dynamics of two grasses: responses to grazing, density and weather, Journal of Ecology 82:331-340, doi:10.2307/2261301. https://doi.org/10.2307/2261301 ([abstract])
- R999 Lovett Doust L. (1981), Population dynamics and local specialization in a clonal perennial (Ranunculus repens). I. The dynamics of ramets in contrasting habitats, Journal of Ecology 69:743-755, doi:10.2307/2259633 [UNVERIFIED DOI]. https://www.jstor.org/stable/2259633 ([search excerpt])
- R1100 Meuriot F., Morvan-Bertrand A., Noiraud-Romy N., Decau M.-L., Escobar-Gutiérrez A.J., Gastal F., Prud'homme M.-P. (2018), Short-term effects of defoliation intensity on sugar remobilization and N fluxes in ryegrass, Journal of Experimental Botany 69:3975-3986. https://pmc.ncbi.nlm.nih.gov/articles/PMC6054246/ ([read]: before the third day of regrowth a defoliated Lolium perenne's leaf growth runs mostly on reserves, then on current assimilate; sheaths hold up to 70% of the vegetative fructans; reserves are drawn on only past about 65% of the leaf area removed)
- Further sources (Unit 12b, no R-number): Matthew C., Lemaire G., Sackville Hamilton N.R., Hernandez-Garay A. (1995), A modified self-thinning equation to describe size/density relationships for defoliated swards, Annals of Botany 76:579-587, doi:10.1006/anbo.1995.1135 (not read; via R951 to R953); Ong C.K. (1978), The physiology of tiller death in grasses 1, Grass and Forage Science 33:197-203, doi:10.1111/j.1365-2494.1978.tb00820.x ([abstract]); Granéli W. (1989), Influence of standing litter on shoot production in reed, Aquatic Botany 35:99-109, doi:10.1016/0304-3770(89)90070-3 ([search excerpt]); Hara T., van der Toorn J., Mook J.H. (1993), Growth dynamics and size structure of shoots of Phragmites australis, a clonal plant, Journal of Ecology 81:47-60, doi:10.2307/2261223 ([abstract]); Tyler-Walters H., Phragmites australis swamp and reed beds, MarLIN, https://www.marlin.ac.uk/habitats/detail/304/phragmites_australis_swamp_and_reed_beds ([read], summarising Haslam 1972, J Ecol 60:585-610).
