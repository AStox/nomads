# Animal constants

Substrate 5 of `rule-audit.md`: deer, rabbits, wolves and red foxes. Each species is a population over the island's tiles (src/sim/herds.ts), how many there are on a tile and the fat each carries, run on energy: what the ground grows for them to eat, what they burn, what they bear and what eats them. Individual animals stand on the ground only within sight of people, and are the tile's own: one killed, trapped or eaten is one fewer on its tile. Every number below is cited, [derived], [design], [gap] or [UNVERIFIED]. References continue from `time-constants.md` (R361 on).

## 1. What replaced what

| Old rule | Now |
|---|---|
| A few founding animals placed near people; caps of 18 deer, 6 wolves, 120 rabbits | Densities on every land tile from twenty years of the island's own herd dynamics before anyone wakes (sec. 8); no caps |
| Nothing but wolves and an eagle or two hunting rabbits | Red foxes, a population like the rest, killing rabbits by Pech's measured response (sec. 6) |
| hunger 0 to 100 drained by a hand-set rate, raised by grazing at a hand-set rate, death at 0 | Each tile's animals carry a mean fat reserve, kJ: they burn their field metabolic rate, eat forage or prey, and as many die as the shortfall's worth of a full reserve when it runs out; hunger is the reserve as a share of a full one |
| Births by a 1-in-400 roll near a mate when the days lengthen past 11 h; rabbits by a roll on their count; wolves 1-in-4000 | Deer conceive at the rut by condition and calve in early June; rabbits litter monthly from January to August while in condition; a wolf pack whelps once a year (sec. 5) |
| Wolves bite a deer for 6 hp until it drops | Away from people, wolves kill deer and rabbits by Messier's functional response on their biomass, no more than fills them, and strife among packs thins them as they crowd; within sight of people, as they did, one carcass at a time |
| Deer and wolves swim ashore when the island empties | Gone |

## 2. Bodies

| Quantity | Deer | Rabbit | Wolf | Fox | Source |
|---|---|---|---|---|---|
| Live mass, kg | 116 | 1.6 | 41.5 | 6 | body-constants R304 to R306; fox: Britain's dog and vixen, 6.5 and 5.5 kg (R382) |
| Field metabolic rate, kJ/day | 25,100 | 1,080 | 11,800 | 2,860 | Nagy: FMR = 4.82 M^0.734, M in g (R361) [derived] |
| Full fat reserve | (0.55 x 0.0655 + 0.0314) x 116 = 7.8 kg | (0.555 x 0.035 + 0.0314) x 1.6 = 0.081 kg | as deer's shares, 2.8 kg | as deer's shares, 0.4 kg | body-constants sec. 10 (winter carcass fat, gut and kidney fat) [derived]; wolf and fox [design] |
| Fat's energy | 37.74 MJ/kg | | | fuel.ts FOOD_KJ.fat |
| Most dry matter eaten a day | 3.4 kg | 0.08 kg | - | deer: R363 (older hinds, 2.2 to 4.2) [ex]; rabbit 65 to 80 g a kg of its mass (72.5) R373 [ex] |
| Forage's metabolisable energy | 11 MJ/kg DM | | | R362 (rough upland grazing, 11.0 to 11.1) [ex] |
| What a predator takes from a kill | 3.08 kJ a g of the prey's live mass: a rabbit's gross energy, 21.9 kJ a g of dry matter (R385), at 17.8% dry matter (R386), of which a carnivore keeps 79% (weasels fed rabbit, R387) | | | | [derived]; deer taken as made like a rabbit [gap]. The butchered cuts people get (materials.ts) are whole pieces, a rabbit's one cut of meat half of what a fox gets from eating all of it |

## 3. Forage

Two pools a tile, each split into what is green and what has died and still stands, in g per m2 of its own share of the tile, from the generator's cover there:

- The ground layer: the open grass and the field layer under the trees' and shrubs' crowns. Both deer and rabbits eat it.
- Browse: the woody shoots within a deer's reach, a share of the shrubs' cover and a smaller of the trees' [design: 0.3, 0.1]. Only deer eat it.

Green grows by the plant rule (terrain/growth.ts): 1.4 g per MJ of the season's sun there (climate.ts seasons, MJ/m2 a day), the share a sward intercepts [UNVERIFIED 0.8], warm and watered enough as the seasons there are, scaled by the ground's fertility (isle.fertility), at the year's pace (plants.ts YEARS_PACE), slowing as green and dead together near what a sward stands at. The field layer grows in the eighth of the sun under a crown (growth.ts through(1), light.ts's Beer-Lambert) [derived].

| Quantity | Value | Source |
|---|---|---|
| Most a pool stands at | 300 g/m2 (unproductive grassland, 200 to 300) | R364 [ex] |
| A green leaf's life | 460 degree-days over 4 C (a grazed temperate sward's 400 to 520), so about 40 days in summer and the most of a cool winter | R392 [ex] |
| Dead standing stuff rotting away | 0.4% a day (litter losing 0.33 to 0.5% a day) | R395 [UNVERIFIED: a tropical grass's litter] |
| What a gram is worth, kJ | 0.16 MJ/kg a point of digestibility (R394): green grass and broadleaf leaves 11 (R362; green over 65% digestible, R393); anything dead, and broadleaf twigs after leaf fall, 7.2 (under 45%, R393, R396) | [derived] |
| Evergreen browse | heather and gorse 8.9 in the growing season, 6.7 out of it (heather 55.9% digestible in July, 41.9% in March, R397; gorse taken as heather [UNVERIFIED]); pine 9.0 all year (56%, low in every season, R396); bramble 11 all year (evergreen leaves unchanging, R396) | [ex] |
| A tile's browse | its kinds as the generator draws them, each by its niche fit and vigour there within its form (flora.ts), so heath ground browses as heather and gorse and oakwood as oak and hazel | [derived] |
| Leaf fall | the broadleaves' green browse drops to dead when the growing season index goes under green-up (the cold ramp, which warmEnough is, times the daylight ramp from 10 h to 11 h), as the game's broadleaves go bare (wetness.ts leafless); the evergreens keep theirs | [derived] |

- A grazer crops the green as its Holling type II over the green it can reach a m2 of ground allows, half its fill at Mulder and Hendriks' half-saturation for grazing mammals, 4.9e4 m^0.20 kg/km2 of wet vegetation, m in kg (R374) [ex: Table 1], a quarter of it dry [UNVERIFIED]: 31.7 g DM/m2 for a deer, 13.5 for a rabbit [derived]. What that leaves short of its need it makes up from the dead, as its response to the dead allows [derived: grazers pick the green leaf].
- A deer is a ruminant: its rumen holds a day's fibre (NDF) of 1.2% of its weight (Mertens, R399). Green is 40% NDF (grazed grass 30 to 40%, R400), dead 70% (mature grass over 65%, straw to 80%, R401) [derived]. So a deer eats at most 3.5 kg of green a day, its measured most (R363), and 2 kg of dead, which at 7.2 kJ/g is 14 MJ against its 25: dead forage alone starves a deer. A rabbit passes fibre through fast and eats to its own most [derived].
- Where the grazers want more of a pool's green or dead than stands, each gets its share of what there is; a deer's asks split between the pools as they stand.

## 4. Energy

Each step of dt island days, at the year's pace (a herd's day is YEARS_PACE days of eating and burning, as a plant's day is of growing):

- A grazer eats what brings its reserve to full and pays its day, within its rumen or its most, as sec. 3 has it, out of what the tile stands.
- Its reserve gains what it ate at what each gram was worth and loses its field metabolic rate.
- Below nothing, as many die as the shortfall is in full reserves [design], and the rest stand at nothing.
- Wolves' and foxes' reserves gain what they take from their kills (sec. 2), a wolf's deer less what the ravens take (sec. 6).

## 5. Births and deaths

| Quantity | Value | Source |
|---|---|---|
| Deer: conception | 75% within three weeks at the end of October | R365 [ex] |
| Deer: share of hinds pregnant | 25% in poor condition to 90% in good | R365 (yearlings 25 to 67% at low food, 90% in deer parks) [ex]; as the reserve's share of full [design] |
| Deer: calving | early June, one calf | [UNVERIFIED: about 8 months' gestation] |
| Rabbit: breeding | January to August, litters of 3 to 7 (5) about monthly | R366 [ex] |
| Rabbit: breeding condition | over half a full reserve [design] | |
| Rabbit: kits that live to be grown, with no predators about | 12.8%: 18% of those that came above ground where predators were kept down (R388), of the 71% of litters not drowned in the burrow (R389) | [derived]; the foxes and wolves here take their share themselves. With them, 8.3% live a year (R375). They join the grown at birth [gap: age classes] |
| Wolf: litter | one a year, 4 to 6 pups (5.5) | R367 [ex] |
| Wolf: pups alive at a year old | 29% in Voyageurs, where wolves live on deer (68% in Yellowstone, on elk) | R368 [ex]; they join the grown at birth [gap: age classes] |
| Wolf: pack | 4 | R368 [ex] |
| Wolf: whelping | late April [UNVERIFIED] | |
| Fox: litter | one a year, about 5, born in March | R382 [ex] |
| Fox: deaths with neither cars nor guns | Bristol's 50% of the grown a year and 61% of cubs before they are grown (R384), at the 58% of Britain's 425,000 fox deaths a year that are neither the roads' 100,000 nor the guns' 80,000 (R384): 0.40 a year for the grown, 58% of cubs living to be grown | [derived] |
| Deaths besides hunger and predators, a year | rabbit 1/2 (wild rabbits live 1 to 3 years, R369 [ex]); deer 1/12, wolf 1/5 [UNVERIFIED] | |
| Wolf: a grown wolf's chance of living the year at d wolves a 1000 km2 | 1.018 - 0.00489 d, no more than the 1/5 deaths' 0.82 | Cubaynes et al.'s Northern Range survival, 0.55 to 0.92 over 20 to 99 wolves, below 0.7 above 65 (R381), as a line through those [derived]; d over the whole island's land, as their densities are the whole range's |

The young join the tile's count at once, as the adults' size [gap: age classes].

## 6. Wolves killing deer and rabbits

Kills per wolf a day = 0.0336 X / (0.46 + X) moose-equivalents, X the moose-equivalent density of prey in a wolf's reach (km2), Messier's functional response for wolves on moose (R370) [read: abstract], taken by biomass: a moose 400 kg [UNVERIFIED], so X = the deer's and rabbits' kg a km2 there / 400, and the kills come out in kg [derived assumption: wolves' killing saturates on prey biomass, whatever the prey]. Each kind is killed as its share of that biomass [derived assumption: no preference]. Wolves eat lagomorphs as buffer prey when ungulates are short (R379, R380). A pack kills no more than brings its reserves to full and pays its day [derived: kills are what wolves eat, as a grazer eats], so wolves fed on rabbits leave deer be. Ravens take their share of each deer before the pack has eaten it: a pair loses 37% of a moose, a pack of six 17% (R398), a pack of four 27% between them [derived], so a pack kills that much more; a rabbit is eaten whole at once. A wolf hunts over its pack's territory: a square of land as big as Bialowieza's mean 201 km2 (R402), 95 tiles across, its prey's density taken over the land in it [derived]. Hunting over the 7 x 7 tiles round it (about 1 km), packs set down where the deer were few starved before they found any, at a tile a step. Every tile's wolves hunt at once: each takes its kills as a share of each kind in its territory, and each tile's deer and rabbits lose the sum of the shares of the wolves whose territories take them in, which kills exactly what the wolves ate unless they would take more than are there [derived]. Wolves within sight of people kill as individuals instead, and their tile's predation then waits on them.

### Foxes killing rabbits

A fox kills rabbits by Pech et al.'s measured response at Yathong, as Pech and Hood fitted it: at most 100.01 kg of rabbit a quarter of a year, on a Type III curve with its inflection at 1.32 rabbits a ha (R383), N the rabbits a ha over its home range, a rural fox's 200 to 600 ha (R403), taken as 4 km2, 13 tiles across [derived]. It kills no more than brings its reserve to full and pays its day. Its share of the rabbits round it is added to the wolves', and every tile's foxes hunt at once as the wolves do. Within sight of people foxes are individuals: they keep 40 m from people and 80 m from wolves, and a hungry one runs down the nearest rabbit within 100 m and eats it [design].

## 7. Moving

Each step a share of a tile's animals moves to whichever neighbouring tile would feed them faster: grazers to where their response to the green and the dead there, at what each is worth, gives the most energy (which falls as those already there graze it down), wolves to more prey by its biomass, foxes to more rabbits; the share set by how far they range [design]: deer half a day (hinds range 2 to 4 km2, R371), wolves and foxes all of it, rabbits a fiftieth (home ranges of 0.3 to 0.7 ha, R372, a tile being 2.25 ha).

## 8. Starting and showing

- The island starts from 2 deer a km2 on grassy ground, 4 rabbits a ha of its ground layer, a fox a km2 and a pack of three wolves near where people wake, near what the island comes to, run for twenty island years a day at a time before anyone wakes [design]. Started from a rabbit a ha, the foxes starved to a handful on rabbits below their response's inflection and took twenty years to come back.
- Individuals stand on tiles within sight of someone awake: deer and wolves to 300 m (sim.ts VISION), foxes to 150 m, rabbits, which keep to cover, to 50 m [design]. On those tiles the count stands as whole animals; an individual crossing to another tile takes one of the count with it; one gone is one fewer.

## 9. Checks

Ten island years on from the twenty-year start, every fourth day, on seeds 1 (220 km2 of land, the play page's), 5 (228), 10 (214) and 22 (226); medians, then the 10th to 90th percentile:

| Check | Model | Field | Verdict |
|---|---|---|---|
| Red deer a km2 | seed 1 1.1 (0.9 to 1.3), 5 0.9 (0.8 to 1.0), 10 1.2 (1.0 to 1.5), 22 0.12 (0.10 to 0.18) | Scotland's open hill 9.35 in winter 2018/19, Deer Management Areas 1.7 to 31.4 (R376), all of it culled | fails low: food-limited by winter and by the rabbits, which at 4 to 7 a ha eat some eight times the grass the deer do; on seed 22, mostly heath, the deer barely hold on |
| Rabbits a ha | 6.9 (4.6 to 9.0), 3.7 (2.7 to 5.7), 2.2 (1.5 to 3.0), 5.8 (4.1 to 8.6) | 25 to 100 where they run high (R377), 46.65 on South Walney's dunes in 2023 (R378) | passes, well under where they run high |
| Foxes a km2 | 0.95 (0.5 to 1.5), 0.39 (0.25 to 0.62), 0.18 (0.09 to 0.30), 1.1 (0.6 to 1.8) | rural Britain 0.21 to 2.23 by landscape, England 1.45 and Wales 1.78 before breeding; France 1.92 (R390) | passes |
| Wolves a 1000 km2 | 2.9 (2.0 to 4.0), 61 (50 to 70), 0.25 (0.18 to 0.42), 2.6 (1.5 to 3.8) | Yellowstone's Interior 2 to 11 and Northern Range 20 to 99 (R381); Cariappa et al.'s bound of 69 (R380) | passes on 1, 5 and 22; on 10 a twentieth of a wolf, none in all but the sums |
| What wolves eat | 71 to 98% rabbit by biomass, as the prey stand | lagomorphs 1.3 to 7.7% of European wolves' food biomass, hare and beaver 14.5% in one range (R379) | fails: rabbits outweigh the deer two to forty times over where Europe's hares stand at a few a km2 |

Every population is bounded and none runs away, each held where it is by what it eats and what eats it, swinging with the seasons and from year to year; the deer are the one well under the field.

Earlier runs, kept as the record of what each gap did. The fox pass's numbers above this one (deer 8 to 14 a km2 on seeds 5 and 10, 0.4 on seed 1) stood on a fault: grazers moved to the most forage a head, so herds drifted onto sparse ground with nobody else on it and starved there. Moving them to where they would eat fastest, they rose to 60 to 90 a km2 (Oostvaardersplassen's unculled red deer stood near 25 to 60 [UNVERIFIED]) and grazed the rabbits, then the foxes, out; green and dead forage with leaf fall and heather's winter worth held them about as high; only the rumen's hold on dead forage brought them down, and with it the rabbits and foxes back. Packs hunting over a 1 km reach starved where they woke; over a territory, fed on rabbits at Messier's rate by biomass, they held the strife cap and kept the deer at 0.1 to 1.4 a km2; with a canid's 2.3 chases a day, the numbers above. Foxes with Bristol's deaths, which include the roads', only held their own however much they ate and were gone after the start; with a rabbit worth only its butchered cuts, every fox starved, Pech's most a day being less than its needs; with the kits' measured first-year loss, which already holds what foxes take, foxes boomed to 1,850, ate the rabbits down to 52,000 and fell to about ten. Before the foxes: wolves on deer alone grew to about 10, killed the deer round them down and fell to a fraction of one (the first version of this pass); wolves on rabbits too, killing at Messier's most whether hungry or not and with no strife, grew to 110 and killed the deer down to 1 to 5 on the island; with their kills held to what fills them and strife among packs, 20 to 41 wolves, whose pups all lived; with the pups' first-year loss, the numbers above. Runs before the field layer and the kits' first-year loss, kept as the record of what each gap did: with one grazeable pool of grass and a fixed half-fill, 20,000 to 28,000 deer and 12,000 to 27,000 rabbits; with Mulder's scaling and no browse apart, rabbits grazed every sward below a deer's half-fill and the deer died out; with browse apart but every kit joining the grown, 2 million rabbits boomed and crashed each year and 60 deer lived on browse alone; with the kits' loss but no field layer, 55,000 rabbits and 65 deer.

### The probe gate (aec50e9, against a8bf4da)

Fails, nine regressions: blame/real's fewer wasted tries late than early; seed/real's and seed/two's caught claim (nearly all whose own tries show the true cause beyond chance rule it out where it holds); seed/sparse accMid 0.95 to 0.85; unlearn/real wrong 0.77 to 0.92 and its caught and accuracy claims; unlearn/sparse caught 0.87 to 0.69 and its accuracy claim. The time pass (36eb189) had already lost unlearn/real's caught claim. The same build with no herd animal ever stood on the ground (reveal off) keeps blame/real's claim and every number, and still loses seed/real's, seed/two's and unlearn/real's caught claims and unlearn/real's accuracy: those four don't come of the animals people see, but of the rest of the change (the founding deer, wolves and rabbits gone from populate, which shifts what the world's draws and ids fall on). The other five come with the herds' animals standing about the probes' people (about twenty rabbits within 50 m at these densities, where 80 were scattered over the island before). Not retuned: the probes stage people among whatever animals the island holds.

### The worlds tier (aec50e9, against 155adec, one answer key)

Fails one number: discovery regret 1.90 to 13.3 (+11.4 [1.47, 21.8]); worked, wasted, right and wrong within their intervals. The time pass (36eb189) passed. The key now holds striking rabbits, which stand about people at the herds' densities: with a stone 400 tries take 5,100 ticks, bare-handed 13,500, and people who take to killing rabbits do it bare-handed long before a stone, so the ticks a faster way would have saved are new regret. Not retuned.

### The gates after wolves took rabbits (7e48707)

Probes, against a8bf4da: fails five, down from nine. seed/real caught 0.93 to 0.78 and its caught claim, seed/two's caught claim (both lost in the same build with no herd animal on the ground, above), and the accuracy claims of hearsay/real and unlearn/real. Better: two/real's early waste 0.33 to 0.20, seed/sparse's theories formed 25.9 to 23.7 and caught 0.56 to 0.75; blame/real and unlearn/sparse hold every claim again. Worlds, against 155adec: fails one number, discovery regret 1.87 to 8.06 (+6.19 [0.38, 13.0]), down from 13.3, rabbits' striking still in the key; fewer tries go to waste late than early now holds. Not retuned.

### The gates after the foxes and the forage (4257b28)

Probes, against a8bf4da: fails one, unlearn/real's claim that what they'd do matches whether it would work nine tenths of the way to the true theory by the end, lost since the first animals pass; better, seed/real's theories formed 18.9 to 17.6; every other claim the baseline met holds. Worlds, against 155adec: passes; discovery regret 2.32 to 5.54 within its interval (+3.22 [-6.22, 10.6]), and fewer tries go to waste late than early now holds. Not retuned.

## 10. Gaps

- Age and sex classes; calves and kits as adults at once.
- Winter's poorer forage; browse as a fixed share of shrubs and trees; the field layer as grass in an eighth of the sun, whatever grows there.
- Eagles on rabbits away from people; stoats, raptors and disease, whose share of the kits' loss is taken from where predators were kept down (R388), which held them back too, but not wholly.
- Foxes' other food (voles, birds, beetles, fruit), which in Spain they turn to as rabbits fall (R391); wolves killing foxes; foxes' own spacing.
- A deer's body taken as made like a rabbit, for what a wolf gets of it.
- Wolves taking each prey as its share of the biomass up to a coyote's chases, with no preference for deer; strife among packs judged over the whole island, not pack by pack.
- Rabbits grazing all of a tile's ground layer rather than near their warrens and cover, so they outeat the deer everywhere; no culling, and no thermoregulation or lactation in a deer's winter costs.
- Gorse's worth taken as heather's; deer's browse quality and fibre the same for every plant's green; marsh, rushes and sedges uneaten.
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
- R368 Hynes et al. (2026), Born to die: wolf pup survival and recruitment in the Greater Voyageurs Ecosystem, Wildlife Biology (mean pack 4.0; 71% of pups dead within their first year; Yellowstone 1996 to 2010 mean 0.68, range 0.29 to 0.85, in its table). https://nsojournals.onlinelibrary.wiley.com/doi/full/10.1002/wlb3.01562 (search excerpt)
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
- R379 Low contribution of livestock in the grey wolf diet in the area with high availability of free-ranging cattle and horses (2025), European Journal of Wildlife Research (hare 7.7% of food biomass; hare and beaver 14.5%; Poland 1.3%; citing Zlatanova et al. 2014 and Newsome et al. 2016 on wolves' preference for wild ungulates). https://link.springer.com/article/10.1007/s10344-025-01926-3 (search excerpt)
- R380 Cariappa C.A., Oakleaf J.K., Ballard W.B., Breck S.W. (2011), A reappraisal of the evidence for regulation of wolf populations, J Wildl Manage 75:726-730 (an upper bound of 69 wolves a 1000 km2; contested by McRoberts and Mech 2014). https://www.researchgate.net/publication/227738209 (search excerpt); also Feeding ecology of the wolf in a near-natural ecosystem in Mongolia (lagomorphs as buffer prey), https://d-nb.info/1226061435/34 (search excerpt)
- R381 Cubaynes S. et al. (2014), Density-dependent intraspecific aggression regulates survival in northern Yellowstone wolves, J Anim Ecol 83:1344-1356 (adult survival 0.55 to 0.92 in the Northern Range at 20 to 99 wolves a 1000 km2; below 0.7 above 65). https://wolfwatcher.org/wp-content/uploads/2016/07/Cubaynes-et-al-2014.pdf (read)
- R382 Wildlife Online, Red fox (dogs about 6.5 kg, vixens 5.5 kg); Animal Diversity Web, Vulpes vulpes (litters average 5); a vixen raises one litter of four to five a year, usually born in March. https://www.wildlifeonline.me.uk/animals/species/red-fox (search excerpt)
- R383 Pech R.P., Sinclair A.R.E., Newsome A.E., Catling P.C. (1992), Limits to predator regulation of rabbits in Australia, Oecologia 89:102-112, as fitted in Pech R.P., Hood G.M. (1998), J Appl Ecol 35:434-453, and tabulated in arXiv 2203.15184, Table S2 (k 100.01 kg a quarter, D_III 1.32 rabbits a ha, rabbits eaten 0.78 kg). https://arxiv.org/abs/2203.15184 (read)
- R384 Wildlife Online, Red fox mortality and disability (Bristol: of 1,000 cubs 390 live to be grown; annual mortality of the grown 50% in Bristol; Britain's 425,000 deaths a year, 100,000 on the roads; about 80,000 shot, Harris and Baker 2005). https://www.wildlifeonline.me.uk/animals/article/red-fox-mortality-disability (read)
- R385 VanDomelen, Energy utilization of natural prey items by southeastern bobcats (rabbit gross energy 5.24 kcal a g of dry matter). https://seafwa.org/sites/default/files/journal-articles/VANDOMELEN-16-28.pdf (search excerpt)
- R386 The uneven weight distribution between predators and prey: comparing gut fill between terrestrial herbivores and carnivores (2020), Comp Biochem Physiol A (rabbit 17.8% dry matter, Elsden et al. 1946). https://www.sciencedirect.com/science/article/pii/S1095643320300350 (search excerpt)
- R387 Moors P.J. (1977), Studies of the metabolism, food consumption and assimilation efficiency of a small carnivore, the weasel, Oecologia 27:185-202 (78.2% and 79.8%). https://link.springer.com/article/10.1007/BF00347466 (search excerpt)
- R388 Reddiex B., Hickling G.J., Norbury G.L., Frampton C.M. (2002), Effects of predation and rabbit haemorrhagic disease on population dynamics of rabbits in North Canterbury, New Zealand, Wildlife Research 29:627 (all post-emergent radio-collared rabbits died where predators were not controlled; 18% lived to maturity where they were). https://www.researchgate.net/publication/248883394 (search excerpt)
- R389 Natural mortality of juvenile rabbits in North Canterbury, New Zealand, Wildlife Research 20:815 (of 126 litters, 38% preyed upon, 29% drowned, 20% either). https://connectsci.au/wr/article-abstract/20/6/815/39979 (search excerpt)
- R390 Webbon C.C., Baker P.J., Harris S. (2004), Faecal density counts for monitoring changes in red fox numbers in rural Britain, J Appl Ecol 41:768 (0.21 to 2.23 foxes a km2 by landscape); rural densities before breeding, England 1.45, Wales 1.78, France 1.92. https://besjournals.onlinelibrary.wiley.com/doi/abs/10.1111/j.0021-8901.2004.00930.x (search excerpt)
- R391 Delibes-Mateos M. et al. (2008), Feeding responses of the red fox to different wild rabbit densities: a regional approach, Eur J Wildl Res 54:71 (a facultative predator, its diet widening as rabbits fall). https://www.originalwisdom.com/wp-content/uploads/bsk-pdf-manager/2019/04/Delibes-Mateos-et-al_2008_Feeding-responses-of-the-red-fox-to-different-wild-rabbit-densities.pdf (read)
- R392 Common leaf life span of co-dominant species in a continuously grazed temperate pasture (2012), Basic and Applied Ecology (400 to 520 degree-days over 4 C); grass leaves live 60 to 80 days, J Range Manage. https://www.sciencedirect.com/science/article/pii/S143917911200148X (search excerpt)
- R393 J Range Manage, grazing and forage quality (spring green leaf over 65% digestible; dead leaf usually under 45%). https://journals.uair.arizona.edu/index.php/jrm/article/viewFile/7289/6901 (search excerpt)
- R394 Germinal Ireland, Nutritional value of grass (one point of D-value is 0.16 MJ/kg DM of ME). https://germinal.ie/knowledge-hub/grass-nutritional-value/ (search excerpt)
- R395 Litter decomposition, signal grass and forage peanut (k 0.00329 g/g/d; 0.0038 to 0.0050 over 32 days). https://doi.org/10.3390/su17167562 ; https://pmc.ncbi.nlm.nih.gov/articles/PMC6285063/ (search excerpt)
- R396 Short H.L., Blair R.M., Epps E.A. (1975), Composition and digestibility of deer browse in southern forests, USDA FS Res Pap SO-111 (twigs low in digestibility outside spring; evergreen leaves unchanging through the year; deciduous leaves poorer after leaf fall; spring twigs 56% for pine to 86% for blackberry). https://research.fs.usda.gov/treesearch/613 (search excerpt)
- R397 The effects of season and age of stand on the nutritive value of heather to sheep, J Agric Sci (55.9% in July to 41.9% in March); red deer digest heather slightly better than sheep, Br J Nutr (1978). https://www.cambridge.org/core/journals/journal-of-agricultural-science/article/abs/effects-of-season-and-age-of-stand-on-the-nutritive-value-of-heather-calluna-vulgaris-l-hull-to-sheep/9547ABFB22E41AA97F23AAF52A3BA4C4 (search excerpt)
- R398 Vucetich J.A., Peterson R.O., Waite T.A. (2004), Raven scavenging favours group foraging in wolves, Anim Behav 67:1117 (a pair loses about 37% of a moose to ravens, a pack of six 17%). https://www.gi.alaska.edu/alaska-science-forum/are-ravens-responsible-wolf-packs-0 (search excerpt)
- R399 Mertens D.R. (1987), as used in Prediction of dry matter intake based on ruminal degradation (rumen capacity 1.2% of live weight in NDF). https://uknowledge.uky.edu/cgi/viewcontent.cgi?article=4367&context=igc (search excerpt)
- R400 Germinal GB, What's the nutritional value of grass (grazed grass 30 to 40% NDF). https://germinal.com/knowledge-hub/grass-nutritional-value-guide/ (search excerpt)
- R401 The basics of forage quality, TSCRA (NDF to 80% in grass straw); mature grass hay over 65% NDF. https://tscra.org/the-basics-of-forage-quality/ (search excerpt)
- R402 Jedrzejewski W. et al. (2007), Territory size of wolves: linking local (Bialowieza Primeval Forest) and Holarctic-scale patterns, Ecography 30:66 (201 km2, range 116 to 310). https://www.researchgate.net/publication/227610306 (search excerpt)
- R403 Wildlife Online, Red fox (rural territories 200 to 600 ha). https://www.wildlifeonline.me.uk/animals/species/red-fox (search excerpt)
- R404 O'Donoghue M. et al. (1998), Functional responses of coyotes and lynx to the snowshoe hare cycle, Ecology 79:1193 (coyotes killed 0.3 to 2.3 hares a day, lynx 0.3 to 1.2). https://bibliotecadigital.exactas.uba.ar/collection/paper/document/paper_00129658_v79_n4_p1193_ODonoghue (search excerpt)
