# Time constants

Substrate 3 of `rule-audit.md`: processes that ran on day counts and dice. Each now runs on its own physics, hour by hour or tick by tick, from the warmth and water where it happens. Every number below is cited, [derived], [design], [gap] or [UNVERIFIED]. References continue from `plant-constants.md` (R345 on).

Code: `src/sim/spoil.ts` and `ecology.ts` decay (food), `combustion.ts` cooling and `ecology.ts` cool (hot metal), `ecology.ts` ice, weather (lightning), holes (wells), plants (resprouting).

## 1. Food spoiling

| Old rule | Now |
|---|---|
| Kind.shelf days counted from when it was made or picked, at any warmth | Stack.rot (Thing.rot for food lying about) gains, each hour, the share of the way to spoiled that food goes in an hour at the air's warmth where it is |

| Food | How it spoils | Keeps at 0 C | Source |
|---|---|---|---|
| Fish (trout) | Ratkowsky square root, Tmin -10 C: rate ((T + 10) / 10)^2 | 11.8 days (salmon in ice) | R345, R346 Table 6.1 [read] |
| Meat | as fish | about a week, in air | R347 [ex] |
| Fat (raw) | as meat | as meat | [UNVERIFIED analogue] |
| Berry (bramble) | respiration: blackberry 19, 36, 62, 75, 115 mg CO2/kg h at 0, 4.5, 10, 15.5, 20 C | 8 days (2 to 14) | R348 Blackberry [read] |
| Mushroom | respiration 36, 70, 97, 264 at 0, 5, 10, 20 C | 8 days (7 to 9) | R348 Mushroom [read] |
| Herb | respiration of watercress, 22, 50, 110, 175, 322, 377 at 0 to 25 C | 17.5 days (mint, 2 to 3 weeks) | R348 Perennial culinary herbs, Watercress [read] |
| Nut | flat to 10 C, doubling every 10 C above | 730 days (hazelnut dried in shell, up to 10 C) | R348 Hazelnut [read]; Q10 2 [UNVERIFIED] |
| Grain | Fraser and Muir: log10 days = 6.234 - 0.2118 M - 0.0527 T, M the water as % of its mass (13% for wild grain as found, fuel.ts) | - | R351 [ex] |
| Cooked, stew, bread, dough | flesh's square root | 7.3 days, from 3 to 4 at 4.4 C | R349 [read]; dough and bread as cooked [UNVERIFIED] |
| Smoked | flesh's square root | 29 days, from 14 at 4.4 C | R350 [UNVERIFIED: the chart not read] |
| Ground | its own food's law | half its food's [design] | |
| Rotten | flesh's square root | 3 days, then gone [design] | |

- Between the respiration table's warmths, a straight line; past them the nearest segment, never below nothing [derived]. Spoiling goes as breathing [derived: the handbook's own reading of respiration as the pace of deterioration].
- The square root's Tmin -10 C is the seafood model's (R345); for meat it is checked against CSIRO's "growth at 0 to 1 C about half that at 5 C" (R347), which the square root gives at Tmin -10.4 C [derived].
- Food in with a pot, a basket or a bag keeps half as long again [design, unchanged].
- The warmth is the air where it is (air.ts airOn): on someone, lying about, or in a shelter's store (sheltered air).

Checks [derived] (days kept at 0, 10, 20 C): berry 8, 2.5, 1.3; mushroom 8, 3.0, 1.1; herb 17.5, 3.5, 1.2; fish 11.8, 3.0, 1.3; meat 7, 1.8, 0.8; nut 730, 730, 365; grain 2960, 880, 262. The handbook: "as little as 1 day at room temperature can stimulate growth of gray mold" on blackberries.

## 2. Hot metal cooling

| Old rule | Now |
|---|---|
| A glowing piece went back to cold 36 ticks (3 hours) after leaving a fire | It is hot only while at least Kind.hotAbove (red heat, 600 C, the warmth copper works soft at, fire-constants sec. 29g): at a fire that holds it there it takes the fire's warmth (combustion.ts setIn); elsewhere it cools by its own glow (emissivity 0.9, EPS_ITEM) and Churchill and Bernstein's convection in the wind on it (sec. 15), lumped through, five-second steps (combustion.ts cooling) |

Checks [derived]: a 1 cm copper piece of 0.1 kg falls from 800 to 600 C in 25 s in a 1 m/s wind, and is at 119 C a tick (5 min) after 800 C; a 3 cm piece of 1 kg takes 85 s and is at 371 C after a tick. Copper's Biot number (k 401 W/mK) is far under a tenth, so lumped is fair.

## 3. Ice

| Old rule | Now |
|---|---|
| Under -2 C each fresh water tile beside land or ice froze on a 25% roll each hour; over 1 C all of it melted at once | One thickness h for all the island's fresh still water, grown each hour by Stefan's law, h^2 += a^2 (-T) dt, and melted above 0 C at the degree-day rate, dh = -k T dt (dt in days). People walk on it from 10 cm; when it thins under that, anyone on it goes through |

| Quantity | Value | Source |
|---|---|---|
| Stefan coefficient a | 3.3 cm per (C day)^0.5 | R352 [ex] |
| Melt degree-day coefficient k | 0.43 cm per C day | R353 [read: abstract and text] |
| Ice to walk on | 4 in (10 cm) of new clear ice | R354 [ex] |

Checks [derived]: 5 days at -5 C give 16.5 cm, enough to walk on after about 1.9 days; 10 cm then melts in 2.3 days at 10 C.

Gaps: a lake's depth and stored heat (shallows freeze first), snow on the ice (which slows Stefan's growth, a about 2 to 2.4 cm), and sea ice at -1.9 C.

## 4. Lightning

| Old rule | Now |
|---|---|
| In a storm, each tick a 1-in-150 roll struck a random tree | Flashes come down over the island's land at its ground flash density, spread over its storm hours (a Poisson number each tick); each lands at a random point on land and goes to the tallest tree standing within three of its own heights of the point (a structure's attractive radius, IEC 62305-2's collection area); where none does it strikes the ground |

| Quantity | Value | Source |
|---|---|---|
| Ground flash density | Ng = 0.04 Td^1.25 a km2 a year, Td thunderstorm days a year | R355 [ex] |
| Attractive radius | 3 H | R356 [ex] |

The island's Td and storm hours come from twenty years of its own sky (ecology.ts nextSky) drawn from its seed [derived]. Seed 5: Td 6.65 a year (Britain's lowlands see some 5 to 15 [UNVERIFIED]), 22.9 storm hours a year, 228 km2 of land, Ng 0.43, about 97 flashes a year, 4.3 an hour of storm. Before, about 1.8 trees were struck a year.

## 5. Wells

| Old rule | Now |
|---|---|
| A pit within two tiles of water became a well after a day | A pit becomes a well where the water table (the generator's depth to it, water.ts) lies above its floor |

- PIT_DEPTH 1.5 m, as deep as someone stands in it [design]; digging itself is still work units (substrate 7).
- How long the water takes to seep in [gap: Darcy flow through the pit's walls by the rock's permeability].

## 6. Resprouting

| Old rule | Now |
|---|---|
| Every stump became a 5 m tree 6 days after felling (10 after burning) if warm; a dead bush came back on a 1-in-4000 roll | Oak, ash and hazel stumps coppice and aspen suckers, and a bramble regrows from its crown: once the growing season index shows green-up (wetness.ts growing, GREEN_UP 0.2) the stump or dead bush becomes a seedling of its kind, which grows by the carbon rule (plant-constants). A cut Scots pine's stump dies |

Sources: R357 (conifers mostly can't coppice), R358 (Scots pine cannot resprout), R359 (hazel coppice from dormant buds), R360 (aspen root suckers) [ex].

Gap: a sprout draws on its roots' stores and grows far faster than a seedling; here it starts from a seed's mass. A pine stump never goes, as stumps don't rot.

## 7. Still on the old rules

- Nut fall (a 30% roll a tick for one nut on one random tree as the days draw in), seed dispersal (two island-wide rolls into fixed rings), and the litter, fungi, herbs, sticks, stones, reeds and clay that appear by a threshold table: they need the trees' measured crops and dispersal kernels, and a world that holds that many things [gap].
- Resin beading on a dice capped at two [gap: no measured wound exudation found].
- Ash lying two days; a trapped animal breaking out after half a day [gap].
- Bushes' hit points regrowing at a flat rate (the picking substrate, 7).

## References

- R345 Ratkowsky D.A., Olley J., McMeekin T.A., Ball A. (1982), Relation between temperature and growth rate of bacterial cultures, J Bacteriol 149:1-5; the square-root RRS model for temperate seafood, Tmin -10 C, DTU Food Spoilage and Safety Predictor. http://fssp.food.dtu.dk/Help/RRS/RRS-cold/RRS-cold.htm (read 2026-10-12)
- R346 Huss H.H. (1995), Quality and quality changes in fresh fish, FAO Fisheries Technical Paper 348, ch. 6, Table 6.1 (salmon 11.8 days at 0 C, Cann et al. 1984). https://www.fao.org/4/v7180e/v7180e07.htm (read 2026-10-12)
- R347 CSIRO Meat Industry Services, Vacuum-packed meat: storage life and spoilage ("growth rates at 0 to 1 C are only about half those at 5 C"). https://meatupdate.csiro.au/VPmeat-spoilage-storage.pdf (search excerpt); and Pennacchia C., Ercolini D., Villani F. (2011), Microbial deterioration of vacuum-packaged chilled beef cuts, Braz J Microbiol (meat in oxygen-permeable film keeps about a week). https://pmc.ncbi.nlm.nih.gov/articles/PMC3768908/ (search excerpt)
- R348 Gross K.C., Wang C.Y., Saltveit M., eds. (2016), The Commercial Storage of Fruits, Vegetables, and Florist and Nursery Stocks, USDA ARS Agriculture Handbook 66: Blackberry; Mushroom; Watercress; Perennial Culinary Herbs; Hazelnut. https://www.ars.usda.gov/ARSUserFiles/oc/np/CommercialStorage/CommercialStorage.pdf (read 2026-10-12)
- R349 USDA FSIS, Beef from Farm to Table (cooked, 3 to 4 days at 40 F). https://www.fsis.usda.gov/food-safety/safe-food-handling-and-preparation/meat-catfish/beef-farm-table (search excerpt)
- R350 FDA / foodsafety.gov, Cold food storage chart (smoked fish, 14 days refrigerated) [UNVERIFIED: not read]. https://www.foodsafety.gov/food-safety-charts/cold-food-storage-charts
- R351 Fraser B.M., Muir W.E. (1981), Airflow requirements predicted for drying grain with ambient and solar-heated air in Canada, Trans ASAE 24:208-210, as quoted in Criteria of determination of safe grain storage time, IntechOpen 39944. https://www.intechopen.com/chapters/39944 (search excerpt)
- R352 Leppäranta M. (1993), A review of analytical models of sea-ice growth, Atmosphere-Ocean 31:123-138. https://www.tandfonline.com/doi/pdf/10.1080/07055900.1993.9649465 (search excerpt)
- R353 Leppäranta M. et al. (2023), A field study on ice melting and breakup in a boreal lake, Pääjärvi, in Finland, The Cryosphere 17:2045. https://tc.copernicus.org/articles/17/2045/2023/ (search excerpt)
- R354 Minnesota DNR, Ice thickness guidelines (4 inches of new clear ice on foot). https://www.dnr.state.mn.us/safety/ice/check-ice-thickness.html (search excerpt)
- R355 Chisholm W.A. (2000), as used in Bentzen J.S. et al., Lightning web appendix (FD = 0.04 TD^1.25). https://web2.econ.ku.dk/bentzen/Lightning%20Web%20Appendix%20May%202012.pdf (search excerpt)
- R356 IEC 62305-2 Annex A, equivalent collection area of a structure, a 1:3 slope from its top (3 H). As quoted at https://spds.global/blogs/lightning-protection-system-design (search excerpt)
- R357 EuroSilvics, 46. Coppice (most conifers cannot coppice). https://eurosilvics.eu/silviculture/46-coppice (search excerpt)
- R358 bplant, Scots pine (cannot resprout). https://bplant.org/plant/157 (search excerpt)
- R359 Forest Research (2004), Restoration of neglected hazel coppice, Information Note FCIN056. https://cdn.forestresearch.gov.uk/2004/01/fcin056.pdf (search excerpt)
- R360 Aspen root sucker formation and apical dominance, Forest Science 8 (Aspen Bibliography). https://digitalcommons.usu.edu/aspen_bib/6092 (search excerpt)
