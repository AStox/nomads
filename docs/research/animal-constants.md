# Animal constants

Substrate 5 of `rule-audit.md`: deer, rabbits and wolves. Each species is a population over the island's tiles (src/sim/herds.ts), how many there are on a tile and the fat each carries, run on energy: what the ground grows for them to eat, what they burn, what they bear and what eats them. Individual animals stand on the ground only within sight of people, and are the tile's own: one killed, trapped or eaten is one fewer on its tile. Every number below is cited, [derived], [design], [gap] or [UNVERIFIED]. References continue from `time-constants.md` (R361 on).

## 1. What replaced what

| Old rule | Now |
|---|---|
| A few founding animals placed near people; caps of 18 deer, 6 wolves, 120 rabbits | Densities on every land tile from twenty years of the island's own herd dynamics before anyone wakes (sec. 8); no caps |
| hunger 0 to 100 drained by a hand-set rate, raised by grazing at a hand-set rate, death at 0 | Each tile's animals carry a mean fat reserve, kJ: they burn their field metabolic rate, eat forage or prey, and as many die as the shortfall's worth of a full reserve when it runs out; hunger is the reserve as a share of a full one |
| Births by a 1-in-400 roll near a mate when the days lengthen past 11 h; rabbits by a roll on their count; wolves 1-in-4000 | Deer conceive at the rut by condition and calve in early June; rabbits litter monthly from January to August while in condition; a wolf pack whelps once a year (sec. 5) |
| Wolves bite a deer for 6 hp until it drops | Away from people, wolves kill deer by Messier's functional response; within sight of people, as they did, one carcass at a time |
| Deer and wolves swim ashore when the island empties | Gone |

## 2. Bodies

| Quantity | Deer | Rabbit | Wolf | Source |
|---|---|---|---|---|
| Live mass, kg | 116 | 1.6 | 41.5 | body-constants R304 to R306 |
| Field metabolic rate, kJ/day | 25,100 | 1,080 | 11,800 | Nagy: FMR = 4.82 M^0.734, M in g (R361) [derived] |
| Full fat reserve | (0.55 x 0.0655 + 0.0314) x 116 = 7.8 kg | (0.555 x 0.035 + 0.0314) x 1.6 = 0.081 kg | as deer's shares, 2.8 kg | body-constants sec. 10 (winter carcass fat, gut and kidney fat) [derived]; wolf [design] |
| Fat's energy | 37.74 MJ/kg | | | fuel.ts FOOD_KJ.fat |
| Most dry matter eaten a day | 3.4 kg | 0.08 kg | - | deer: R363 (older hinds, 2.2 to 4.2) [ex]; rabbit 65 to 80 g a kg of its mass (72.5) R373 [ex] |
| Forage's metabolisable energy | 11 MJ/kg DM | | | R362 (rough upland grazing, 11.0 to 11.1) [ex] |
| A deer's edible energy to a wolf | its meat and fat as butchered (materials.ts carcass), at fuel.ts's energies | | | [derived] |

## 3. Forage

Two pools a tile, each standing dry matter in g per m2 of its own share of the tile, from the generator's cover there:

- The ground layer: the open grass and the field layer under the trees' and shrubs' crowns. Both deer and rabbits eat it.
- Browse: the woody shoots within a deer's reach, a share of the shrubs' cover and a smaller of the trees' [design: 0.3, 0.1]. Only deer eat it.

Both grow by the plant rule (terrain/growth.ts): 1.4 g per MJ of the season's sun there (climate.ts seasons, MJ/m2 a day), the share a sward intercepts [UNVERIFIED 0.8], warm and watered enough as the seasons there are, scaled by the ground's fertility (isle.fertility), at the year's pace (plants.ts YEARS_PACE), slowing as a pool nears what a sward stands at. The field layer grows in the eighth of the sun under a crown (growth.ts through(1), light.ts's Beer-Lambert) [derived].

- Most a pool stands at: 300 g/m2 (unproductive grassland, 200 to 300) R364 [ex].
- A grazer takes forage as a Holling type II over the forage it can reach a m2 of ground, half its fill at Mulder and Hendriks' half-saturation for grazing mammals, 4.9e4 m^0.20 kg/km2 of wet vegetation, m in kg (R374) [ex: Table 1], a quarter of it dry [UNVERIFIED]: 31.7 g DM/m2 for a deer, 13.5 for a rabbit [derived].
- Where the grazers want more than a pool stands, each gets its share of what there is; a deer's ask splits between the pools as they stand.

## 4. Energy

Each step of dt island days, at the year's pace (a herd's day is YEARS_PACE days of eating and burning, as a plant's day is of growing):

- A grazer eats what brings its reserve to full and pays its day, no more than its most a day, scaled by forage's half-saturation, out of what the tile stands.
- Its reserve gains what it ate at forage's energy and loses its field metabolic rate.
- Below nothing, as many die as the shortfall is in full reserves [design], and the rest stand at nothing.
- Wolves' reserves gain their kills' edible energy.

## 5. Births and deaths

| Quantity | Value | Source |
|---|---|---|
| Deer: conception | 75% within three weeks at the end of October | R365 [ex] |
| Deer: share of hinds pregnant | 25% in poor condition to 90% in good | R365 (yearlings 25 to 67% at low food, 90% in deer parks) [ex]; as the reserve's share of full [design] |
| Deer: calving | early June, one calf | [UNVERIFIED: about 8 months' gestation] |
| Rabbit: breeding | January to August, litters of 3 to 7 (5) about monthly | R366 [ex] |
| Rabbit: breeding condition | over half a full reserve [design] | |
| Rabbit: kits alive at a year old | 8.3% (8.6% in an Australian population) | R375 [ex]; they join the grown at birth [gap: age classes] |
| Wolf: litter | one a year, 4 to 6 pups (5.5) | R367 [ex] |
| Wolf: pack | 4 | R368 [ex] |
| Wolf: whelping | late April [UNVERIFIED] | |
| Deaths besides hunger and wolves, a year | rabbit 1/2 (wild rabbits live 1 to 3 years, R369 [ex]); deer 1/12, wolf 1/5 [UNVERIFIED] | |

The young join the tile's count at once, as the adults' size [gap: age classes].

## 6. Wolves killing deer

Kills per wolf a day = 0.0336 X / (0.46 + X) moose-equivalents, X the moose-equivalent density in a wolf's reach (km2), Messier's functional response for wolves on moose (R370) [read: abstract], taken by biomass: a moose 400 kg [UNVERIFIED], a deer 116, so X = deer kg/km2 / 400 and kills of deer = kills x 400 / 116 [derived assumption: wolves' killing saturates on prey biomass]. A wolf's reach: the 7 x 7 tiles round it, about 1 km across [design]. Every tile's wolves hunt at once: each takes its kills as a share of the deer in its reach, and each tile's deer lose the sum of the shares of the wolves that reach them, which kills exactly what the wolves ate unless they would take more than are there [derived]. Wolves within sight of people kill as individuals instead, and their tile's predation then waits on them.

## 7. Moving

Each step a share of a tile's animals moves to whichever neighbouring tile offers more forage per grazer (wolves: more deer), a share set by how far they range [design]: deer half a day (hinds range 2 to 4 km2, R371), wolves all of it, rabbits a fiftieth (home ranges of 0.3 to 0.7 ha, R372, a tile being 2.25 ha).

## 8. Starting and showing

- The island starts from 2 deer a km2 on grassy ground, a rabbit a hectare, and a pack of three wolves near where people wake, run for twenty island years a day at a time before anyone wakes [design].
- Individuals stand on tiles within sight of someone awake: deer and wolves to 300 m (sim.ts VISION), rabbits, which keep to cover, to 50 m [design]. On those tiles the count stands as whole animals; an individual crossing to another tile takes one of the count with it; one gone is one fewer.

## 9. Checks

Seed 5 (228 km2 of land, mostly wooded), ten island years on from the twenty-year start, a quarter-year apart:

| Check | Model | Field | Verdict |
|---|---|---|---|
| Red deer a km2 | 2 to 3 (400 to 710 on the island), rising slowly after a wolf boom | Scotland's open hill 9.35 in winter 2018/19, Deer Management Areas 1.7 to 31.4 (R376) | passes, at the low end of the range for an island mostly under trees |
| Rabbits a ha | 20 to 31 (443k to 715k), cycling with the season | 25 to 100 where they run high (R377), 46.65 on South Walney's dunes in 2023 (R378) | passes, for an island with no foxes, stoats or disease |
| Start (newWorld, twenty years a day at a time) | seed 5: 881 deer, 390k rabbits, 0.4 wolves; seed 10: 1,041 deer, 279k rabbits, 0.4 wolves | | |
| Wolves | a pack grows to about 10, kills the deer round it down, and falls to a fraction of one | none for a 228 km2 island | fails: on an island this small the deer they reach run out before they recover; no rabbits in their diet away from people (sec. 10) |

Runs before the field layer and the kits' first-year loss, kept as the record of what each gap did: with one grazeable pool of grass and a fixed half-fill, 20,000 to 28,000 deer and 12,000 to 27,000 rabbits; with Mulder's scaling and no browse apart, rabbits grazed every sward below a deer's half-fill and the deer died out; with browse apart but every kit joining the grown, 2 million rabbits boomed and crashed each year and 60 deer lived on browse alone; with the kits' loss but no field layer, 55,000 rabbits and 65 deer.

## 10. Gaps

- Age and sex classes; calves and kits as adults at once.
- Winter's poorer forage; browse as a fixed share of shrubs and trees; the field layer as grass in an eighth of the sun, whatever grows there.
- Wolves on rabbits and eagles on rabbits away from people; foxes, stoats and disease, whose share of the kits' first-year loss (R375) is taken as it was measured, with them.
- Rabbits keeping to cover: they graze any of a tile's ground layer, not only within reach of their warrens.
- Running and walking speeds (substrate 6), wounds (the hp pools).
- Fish, birds and butterflies stay individuals with their old caps.

## References

- R361 Nagy K.A., Girard I.A., Brown T.K. (1999), Energetics of free-ranging mammals, reptiles, and birds, Annu Rev Nutr 19:247-277; as summarised in Nagy K.A. (2005), Field metabolic rate and body size, J Exp Biol 208:1621 (mammals: FMR = 4.82 M^0.734). https://journals.biologists.com/jeb/article/208/9/1621/9364/Field-metabolic-rate-and-body-size (search excerpt)
- R362 Farmers Weekly (2016), Rough grazing offers more nutrient value than expected (ME 11.1 and 11.0 MJ/kg). https://www.fwi.co.uk/livestock/rough-grazing-offers-more-nutrient-value-than-expected (search excerpt)
- R363 Deer Farmers' Handbook, ch. 9 Nutrition, Table 6: guide maximum dry matter intake (kg DM/head/day). https://www.deerfarming.com.au/wp-content/uploads/2016/11/DFH09-Nutrition.pdf (search excerpt)
- R364 Frontiers in Environmental Science (2021), rainfall manipulation on grassland ("200 to 300 g m-2", unproductive upland calcareous grassland). https://www.frontiersin.org/journals/environmental-science/articles/10.3389/fenvs.2021.686668/full (search excerpt)
- R365 Wildlife Online, Red deer breeding biology (conception timing; pregnancy rates by food; Clutton-Brock on Rum). https://www.wildlifeonline.me.uk/animals/article/red-deer-breeding-biology (search excerpt)
- R366 Mammal Society, European rabbit (breeding January to August, several litters of 3 to 7 about monthly). https://mammal.org.uk/british-mammals/european-rabbit (search excerpt)
- R367 Living with Wolves, wolves have one litter a year (4 to 6). https://www.livingwithwolves.org/did-you-know-pups/ (search excerpt)
- R368 Hynes et al. (2026), Born to die: wolf pup survival and recruitment in the Greater Voyageurs Ecosystem, Wildlife Biology (mean pack 4.0). https://nsojournals.onlinelibrary.wiley.com/doi/full/10.1002/wlb3.01562 (search excerpt)
- R369 Wildlife Online, European rabbit (longevity and mortality). https://www.wildlifeonline.me.uk/animals/species/european-rabbit (search excerpt)
- R370 Messier F. (1994), Ungulate population models with predation: a case study with the North American moose, Ecology 75:478-488. https://esajournals.onlinelibrary.wiley.com/doi/10.2307/1939551 (abstract)
- R371 Wildlife Online, Red deer territory and home range (hinds on Rum 200 to 400 ha). https://www.wildlifeonline.me.uk/animals/article/red-deer-territory-home-range (search excerpt)
- R372 Wildlife Online, European rabbit (home range 0.3 to 0.7 ha). https://www.wildlifeonline.me.uk/animals/species/european-rabbit (search excerpt)
- R373 Nutritional requirements of rabbits ("a high feed intake, 65 to 80 g/kg body weight"). https://www.researchgate.net/profile/Rana-Al-Difaie/post/What-the-nutrient-requirement-for-rabbit-during-pregnancy/attachment/59d64eb079197b80779a7fc8/AS:493952089899008@1494778763533/download/nutritional-requirements-of-rabbits.pdf (search excerpt)
- R374 Mulder C., Hendriks A.J. (2014), Half-saturation constants in functional responses, Global Ecology and Conservation 2:161-169, Table 1 (grazing mammals on vegetation, kg/km2: 11 studies, mean 8.6e4, Km = 4.9e4 m^0.20, r2 0.41). https://arxiv.org/abs/1305.5533 (read)
- R375 Cowan D.P., Roman (1985), 8.3% of free-living rabbits in southern England past 12 months; 8.6% in a South Australian population, as cited in Longevity record for a wild European rabbit from South Australia. https://www.researchgate.net/publication/242174224 (search excerpt)
- R376 NatureScot, Deer management in Scotland, FAQs (open-hill mean 9.35 a km2 in 2018/19; Deer Management Areas 1.7 to 31.4). https://www.nature.scot/doc/deer-management-scotland-frequently-asked-questions-faqs (search excerpt)
- R377 Wildlife Online, Seasonal update May 2023 ("anywhere between 25 and 100 rabbits per hectare"). https://www.wildlifeonline.me.uk/blog/post/seasonal-update-may-2023 (search excerpt)
- R378 Dynamic Dunescapes (2023), A survey of rabbit populations on sand dunes at South Walney and Drigg Dunes (46.65 a ha). https://dynamicdunescapes.co.uk/wp-content/uploads/2023/11/Rabbit-Populations-Cumbria-Report-23-v1.pdf (search excerpt)
