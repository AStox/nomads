# Plant constants

Substrate 4 of `rule-audit.md`: how plants grow. Seedlings are now a carbon balance in grams of dry matter; grown plants keep a relative rate built from the same limits. Every number below is cited, [derived], [design], [gap] or [UNVERIFIED]. References continue from `matter-constants.md` (R335 on).

Code: `src/sim/plants.ts` (growthOf, seedlingGain, compensation, SEEDLINGS), `src/sim/seedling.ts` (seedlingHour, seedlingFate, bedAt), `src/sim/ecology.ts` (plants), `src/sim/sim.ts` CONDITIONS `deep`.

## 1. What replaced what

| Old rule | Now |
|---|---|
| `light.ts growRate`: 0.25 + 0.75 of the sky's share, a quarter speed in the deepest shade [design] | Removed. Light enters as the sun's W/m2 times the share the crowns let through (light.ts skyShare), into the seedling's leaves |
| Seedling `stage` 0..1 climbing by a ramp product, `hp` falling by a drink curve (rule-audit-findings P20) | `dry` grams: gain each hour by sec. 4; `stage` and `hp` are views of the mass |
| Comes up at stage 1 | Comes up once dry reaches the kind's `up` mass [design] |
| Withers at hp 0 | Withers once dry has burnt down to half its peak [design] |
| `seedlingFate(bed, tree, ...)` with a tree flag | `seedlingFate(bed, ...)`; the bed names its niche |
| CONDITIONS `deep`: light < 0.2 [design] | light below the seedling's own compensation point (sec. 5) |

## 2. Warm enough

| Quantity | Value | Units | Source |
|---|---|---|---|
| Growing-season index, minimum temperature ramp | 0 at -2 C, 1 at 5 C | - | R72 (fire-constants) [read] |

Pick: `warmEnough(T) = clamp((T + 2) / 7)`, taken for the hour's air at the point.

## 3. Watered enough

| Quantity | Value | Units | Source |
|---|---|---|---|
| FAO-56 water stress coefficient Ks | (TAW - Dr) / ((1 - p) TAW) | - | R221 eq. 84 [read] |
| Depletion before stress, p | 0.5 | - | R221 Table 22, the common value [read] |

Pick: `watered(share) = clamp(share / (1 - 0.5))`, share being the root zone's water against what it can hold (soil.ts).

Grown plants: `growthOf = warmEnough x watered x light x feed`, a 0..1 rate against their best. `feed` (soil.ts feedRate) stays [gap: fertility's own physics].

## 4. A seedling's carbon

| Quantity | Value | Units | Source |
|---|---|---|---|
| Radiation use efficiency | 1.4 | g dry matter per MJ of solar radiation intercepted | R335 [ex] |
| Growth respiration coefficient k | 0.25 (Y_G 0.75) | g C respired per g C made | R336 [read] |
| Maintenance respiration c | 0.015 | per day, of the plant's dry mass, at 20 C | R336 [read] |
| Q10 of maintenance | 2 | - | R336 [read] |
| Leaf mass fraction of seedlings | about 0.5 | - | R337 [ex] |

Pick: an hour's gain, g:

    made = RUE x (sun x light x 3600 / 1e6) x (SLA x LMF x dry) x warmEnough x watered x fit
    kept = (c / 24) x Q10^((T - 20) / 10) x dry
    gain = ((1 - k) x made - kept) x YEARS_PACE

- sun: the open ground's W/m2 this hour (air.ts sunOn); light: the share the crowns pass (light.ts skyShare).
- Leaf area intercepts all the light falling on it [design: a seedling's leaves do not shade one another].
- fit: the niche's fit at the spot (plants.ts fitHere) [design: the island's lasting suitability scales what is made].
- YEARS_PACE = 365.25 / 40: the island's 40-day year does a real year's growing [design, as fire-constants sec. 12].
- Comes up at `up` [design]; withers at half its peak [design].

### Seedlings

| Kind | Seed mass, g | Source | SLA, m2/g | Source | Comes up at, g |
|---|---|---|---|---|---|
| berry (bramble) | 0.0025 | R342: European Rubus 1.3 to 3.0 mg [ex] | 0.020 | [UNVERIFIED] | 5 [design] |
| grass | 0.001 | [UNVERIFIED] | 0.025 | [UNVERIFIED] | 0.5 [design] |
| oak (Q. robur) | 3.5 | R338: 1000 acorns 1767 to 4702 g dry [ex] | 0.015 | R343: 14.77 m2/kg at 50% sun, 13.24 open, 15.52 at 40% [ex] | 10 [design] |
| ash (F. excelsior) | 0.07 | R339: about 70 g per 1000 [ex] | 0.0253 | [UNVERIFIED: read in an earlier search, source not kept] | 10 [design] |
| pine (P. sylvestris) | 0.006 | R340: 5.35 g per 1000, range 3.05 to 6.99 [ex] | 0.0147 | [UNVERIFIED: as ash] | 10 [design] |
| aspen (P. tremula) | 0.0005 | R341: 0.5 g per 1000 [ex] | 0.015 | [UNVERIFIED] | 10 [design] |

## 5. Compensation point

The share of the open sky's sun at which a seedling makes no more than it burns, on the island's midsummer day (day 16) under a broken sky at 15 C, watered, on ground that suits it [derived; the reference day is design]. It does not depend on the seedling's mass, since both terms scale with it.

    compensation = c x Q10^(-0.5) / sum over the day's hours of ((1 - k) x RUE x sun x 3600 / 1e6 x SLA x LMF)

| Kind | Compensation, share of open sun |
|---|---|
| berry | 0.125 |
| grass | 0.100 |
| oak | 0.167 |
| ash | 0.099 |
| pine | 0.170 |
| aspen | 0.167 |

CONDITIONS `deep` ("It was in deep shade under the trees") now reads this: a spot is deep shade for a seed when its light is below the seed's compensation point.

## 6. Checks

Run with `scripts/tmp-seed.ts` (removed after), each seedling at fit 1, share 1, soil 0.8, 15 C, under a repeating sky of clear, cloudy, cloudy, rain, rain, five hours each, 20 island days:

- Open ground, day 6 and 16 (spring and summer): berry up in 10.5 to 12.6 island days, grass 8.4, oak 2.7 to 4.5, ash 6.5 to 7.4, pine 12.6 on day 6, aspen 16.8 on day 6; planted on day 16, pine and aspen do not come up in 20 days. Day 26 (autumn into winter): none comes up in 20 days.
- 40% light: oak and ash come up in spring; berry reaches stage 0.60 by day 20; aspen and pine 0.26 to 0.39.
- 12.5% light (one crown, exp(-0.8 x 2.6) = 0.1249 [derived from light.ts]): berry holds near its seed mass in summer (compensation 0.1252) and withers in autumn; oak and pine wither by day 17.
- 1.6% light: all wither in 7 to 8 days.
- Berry in the open at midsummer: from 2.5 mg to 5 g in about 11 island days, 100 real days of growing, a relative growth rate of ln(2000) / 100 = 0.076 per day [derived].
- Oak's leaf area ratio, SLA x LMF = 0.0075 m2/g, against R343's 43 cm2/g = 0.0043 in full daylight: the model gives oak 1.7 times the leaf a measured seedling carries.

Gaps the checks show:
- Compensation points of 10 to 17% of open sun are high for tree seedlings, whose whole-plant compensation is commonly put at a few percent [UNVERIFIED]. Maintenance at McCree's crop value and no shade acclimation (R343: SLA rises 17% from open to 40% sun) are the likely causes [gap].
- Aspen's tiny seed takes 17 island days in spring, and does not make it before winter if sown at midsummer. Real aspen seedlings grow far faster in their first months [UNVERIFIED]; the single SLA and LMF for every kind are the likely cause [gap].
- Oak's leaf area ratio runs 1.7 times measured: an acorn seedling puts much of its mass in root and the acorn [gap: LMF per kind].
- The planting probes (scripts/probes.ts seed, hearsay, unlearn) fail at 155adec. A berry needs about 11 island days to come up in the open, and the probes plant from day 5 for 20 days, so most plantings cannot show before the run ends or run into autumn. In seed/real seed 1 the formula fails 75% of cases, and holding the staged causes (deep or crowded) gets only 52% of them right (accCeil): what withers them is no longer mostly what the probe stages. The probes need restaging (when and how long they sow), not the plants retuning [gap].

## 7. Still open

- `shareAt` (seedling.ts): how much light and water grown plants close by take [gap].
- A pour's own physics (seedling.ts) [gap].
- Fertility (soil.ts feedRate) [gap].
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
