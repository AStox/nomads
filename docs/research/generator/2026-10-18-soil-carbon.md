# Soil carbon on the GPU ground kernel: a leafless season, daylight, and what of a tree's carbon reaches the soil (2026-10-18)

Gap 1f of the island generator's six gaps against Bornholm: organic carbon off the peat, 0 to 23 cm, a median of 164 t/ha over 24 seeds against Denmark's 72 t/ha in 0 to 30 cm (R598). `terrain-constants.md` sec. 12g gap 5 named the cause: the plants' carbon input has no leafless season and no daylight term. This note is the finding, the two laws that went into `src/gpu/wgsl/terrain-ground.ts`, the sources, the numbers over 24 seeds before and after, and what is still open. The CPU `ground()` in `src/terrain/ground.ts` is untouched and stays the unfixed reference.

## 1. The finding

The input to RothC's steady state was `npp = sum over the four seasons of DAYS x RUE x sun x warmEnough(temp) x watered`, times each form's share, the light it stands in, `(1 - UNDER_CROWN)`, 0.47 and fertility, and all of it went into the soil. Two things in that are a crop's, not a forest's:

1. The plants are in leaf all year: `warmEnough` is the mean air's ramp from -2 C to 5 C, so winter's 3.8 C (the sea-level mean, `climate.ts SEASONS`) grows at 0.83 and spring's 4.2 C at 0.89, and no daylight enters. On the game's sky (55.1 N) no day from 4 November to 3 February reaches 10 hours.
2. All of the year's dry matter reaches the mineral soil. In a forest only the foliage and the roots do; the wood stays standing and then lies on the floor, outside the 23 cm of mineral topsoil RothC counts.

Law 1 alone takes the median off-peat carbon from 164 to 134 t/ha (baseline tree, section 6a); it takes 7.5% off a closed canopy's input (section 6c), more where the sun is low or the air cold. Law 2 takes the median to 70. The leafless season was therefore the smaller part of the gap and the wood's share the larger. Section 7 says why the median, which now sits at Denmark's mean, is not the number to read.

## 2. Sources read

| R | Source | What was used |
|---|---|---|
| R1280 | Jolly W.M., Nemani R., Running S.W. (2005), A generalized, bioclimatic index to predict foliar phenology in response to climate, Global Change Biology 11:619-632, doi:10.1111/j.1365-2486.2005.00930.x | **Abstract only** (the full text was not reachable: the publisher's and two repository copies refused). The Growing Season Index is the product of three indices of minimum temperature, vapour pressure deficit and daylength, each from 0 (inactive) to 1 (unconstrained) between threshold limits; 10-day GSI against NDVI r > 0.8 at nine ecosystems; mean absolute error 3 days for leaf flush and 2 for colouring at a temperate deciduous forest. The limits themselves are R72's (below) [UNVERIFIED against this paper's own table] |
| R72 | Jolly W.M. et al. (2024), NFDRS version 4, Environ. Modelling & Software 181:106181 (read for `fire-constants.md` sec. 12) | The limits: coldest air of the day -2 C to 5 C; largest vapour pressure deficit 4100 Pa down to 900 Pa; daylight 10 h to 11 h. `sim/wetness.ts` already reads leaf-out and grass green-up from the same index (green-up threshold 0.2), so the game and the generator now take their leaf season from one source |
| R1281 | Luyssaert S. et al. (2007), CO2 balance of boreal, temperate, and tropical forests derived from a global database, Global Change Biology 13:2509-2537, Table 3 (read from the PDF) | Net primary production components in g C/m2 a year for **temperate humid deciduous** forests: NPP 738 (SD 55), foliage 235, wood 329, roots (coarse and fine) 207. The column is read from the table's header alignment [INFERENCE: the extracted table loses its column rules; the five-column reading is checked by the components summing to 771 against NPP 738] |
| R598 | Adhikari K. et al. (2014), PLOS ONE 9:e105519, **Table 8** (read as an image) | Danish land use classes, 0 to 30 cm: forest and semi-natural areas 5,547.1 km2 and 38.9 Tg C, which is 70 t/ha [derived]; agricultural areas 32,942.3 km2 and 266.4 Tg, 81 t/ha [derived]; the whole country 72 t/ha. 0 to 100 cm: forest and semi-natural 66.7 Tg, 120 t/ha |
| R1282 | Grüneberg E., Ziche D., Wellbrock N. (2014), Organic carbon stocks and sequestration rates of forest soils in Germany, Global Change Biology 20:2644-2662 (read from the PDF) | German forest mineral soil, 0 to 30 cm: 61.8 (SE 3.7) t C/ha at the 2006 to 2008 inventory, 55.6 at the first; by soil group from 43.7 to 104.5, most 49 to 79; the organic layer (the forest floor) 18.8 t C/ha on top of that |
| R221, R479, R596 | FAO-56 eq. 11 (Tetens); Rønne's and Hammer Odde's records as summed in `fire-constants.md` sec. 33; RothC-26.3 | The saturation vapour pressure; the day's range and the sky's hours; the steady state and its linearity in the input |

Leads not read: Callesen I. et al. (2003), Soil carbon stores in Nordic well-drained forest soils, Global Change Biology 9:358-370 (Nordic forest soil stores by climate and texture; the abstract was not reachable); Vesterdal L. et al. (2008), Forest Ecology and Management 255:35-48 (carbon under six tree species at six Danish sites; abstract only, no numbers taken). They are where a Danish forest target and a Danish litter flux would come from.

## 3. The laws

**Law 1: the leaf display of the plants that lose their leaves** (`src/gpu/wgsl/terrain-phenology.ts`). On each day,

g = ramp(Tmin, -2, 5) x ramp(daylight, 10 h, 11 h) x (1 - ramp(VPDmax, 900 Pa, 4100 Pa)),

and a season's display is the mean of g over its days, each day weighted by its share of the season's clear-sky light, so the weights sum to one and the season's own sun, as the climate stage found it, is unchanged. The plant's dry matter in a season is `DAYS x RUE x sun x display x watered` where the old law had `warmEnough` in place of the display. The days, built from the climate stage's four seasons:

- The day's mean air and vapour pressure are drawn straight between the middles of two seasons, as `sim/sky.ts seasonAt` draws the sim's days. The vapour pressure is the season's relative humidity times saturation at the season's mean air (`climate.ts` humid), constant over the day, so the day's highest air holds the lowest humidity [derived; R221 eq. 11].
- The coldest and warmest air are the mean less and plus half the day's range at Rønne: clear, overcast and rainy days' ranges (7.49 / 8.72 / 7.48 / 4.29, 3.21 / 3.44 / 3.36 / 2.41, 3.44 / 4.94 / 3.99 / 2.92 C by season; `sim/air.ts RANGE`, R479 [derived]) weighted by the season's share of rain hours (`climate.ts SEASONS rains`) and, for the dry rest, Hammer Odde's 32 clear to 55 overcast hours [derived; the days' own shares were not tabulated: gap]. Half ranges 2.31, 2.67, 2.39 and 1.53 C.
- The daylight is `sim/sky.ts daylight` at the day's phase (the game's 55.1 N sky). The sun weights are the climate stage's clear-sky daily light (`climate.ts sunlight`'s `level`) on each day over the season's days.
- 91 days to each of the 4 seasons (91.3125 real days each, a step of 1.0034 days). The tables are built on the host (`DAYS_OF_YEAR`); the kernel holds them as integers and loops the 364 days per cell, with Tetens' saturation pressure in fixed point.

The plants that keep their leaves, Scots pine and heather (`EVERGREEN`), keep the old warmth ramp [design; their winter photosynthesis is a gap]. On these islands pine never wins the tree form: a probe over the 31,897 off-peat land cells of seed 1, taking each cell's pH class from the Ground's pH, finds the aspen the best tree on 28,535 of them, the ash on 7, and none on 3,355, so the evergreen branch changes nothing in the figures below. The grass, herbs, reeds, shrubs and the broadleaf trees take the display. The cover's compensation point (`yearComp`, which decides which plant keeps itself and how much ground it closes) is **not** changed: it still reads the warmth ramp over the whole year, so the cover moves only through the organic matter (section 7).

**Law 2: the foliage and the roots reach the soil, the wood does not** (`SOIL_SHARE` in the kernel). Of a tree's or shrub's carbon only (235 + 207) / (235 + 329 + 207) = 0.573 enters the soil [derived from R1281; analogue: one temperate humid deciduous forest class for every tree and shrub]. The herbaceous plants (reeds, grass, the field layer) hold no wood and all of theirs turns over. The wood is outside RothC's mineral 23 cm [design], as the German forest floor's 18.8 t C/ha is outside its mineral 62 (R1282). The same input feeds the nitrogen the soil releases (it is the biomass and humus turning over), so `nitrogen` falls with it; fertility, which cancels the input, does not move. Peat keeps its constant carbon.

RothC's steady state is linear in the input for its active pools (R596); the inert pool 0.049 TOC^1.139 is 10% of the total, and the test checks that carbon less its inert part over the nitrogen equals the float stage's (section 5).

## 4. Constants

| Constant | Value | Tag |
|---|---|---|
| Tmin ramp, VPD ramp, daylight ramp | -2 to 5 C; 4100 to 900 Pa; 10 to 11 h | R72 (read), R1280 [abstract; limits UNVERIFIED against it] |
| Half range of the day's air by season | 2.31, 2.67, 2.39, 1.53 C | R479 [derived]; the sky shares [derived]; one range for the whole island [gap] |
| Sun weights over a season's days | clear-sky daily light, summing to one | `climate.ts sunlight` [derived] |
| Evergreens | pine, heather | [design] |
| Steps in a season | 91 | [design: resolution] |
| Soil share of a woody plant's carbon | 0.573 = (235 + 207) / 771 | R1281 [derived; analogue] |
| Herbaceous soil share | 1 | [design] |
| Tetens | 0.6108 e^(17.27 t / (t + 237.3)) | R221 |
| Fixed point | inputs Q16 (humidity added, 0 to 1), the days' tables Q24, the leaf display Q24, the day sum under one | [design] |

No constant was chosen to bring a figure to a target.

## 5. Tests (`src/gpu/terrain/ground.test.ts`)

Run one case at a time, `bun test src/gpu/terrain/ground.test.ts -t "<name>" --timeout 280000`: islands 1, 2, 3 and the rearranged-rock case all pass (about 3 s each). The GPU against the float stage, and what it means now that the stages differ:

- Compared with the float stage as before (the old tolerances): soil, silt, sand, peat, texture and fertility on all land, which the carbon cannot reach; and **every field but the nitrogen on peat**, where carbon is constant and organic matter 100% so the cover chain is identical.
- The cover and the soil's water move on the rest by what the organic matter's change does to the water the soil holds: their mean differences from the float stage are bounded, not their cells (cover shares under 0.02 on average, measured 0.0002 to 0.006; moisture 0.012; soil water under 0.05, measured 0.025 in summer and autumn and 0 in spring and winter, whose buckets are always full or the same).
- The leaf display against the float law (`leafFactors`): max error 1.5e-6 on every land cell; nothing in winter (exactly 0); never over 1.
- A broadleaf canopy (tree share at least 0.85 in both stages, 3,000 to 4,100 cells): the GPU's nitrogen over the float stage's equals `SOIL_SHARE x (sun x display x watered) / (sun x warmth ramp x watered)` to a median of 0.7% and a 90th percentile of 0.7% (the field layer under the canopy, which is not scaled, is the 0.7%); its carbon and organic matter are lower on every one of those cells.
- RothC's linearity: carbon less its inert part over nitrogen, GPU against float stage, on the 20,000 to 24,000 cells where the cover agrees to 1e-3: median 2.5e-6, 99th percentile 1.5e-5.
- The same words on a second run for every field and the leaf display.

Not run: the second adapter (an Apple Silicon Mac has one GPU, so the check is GPU against the float law); the other agent shares the GPU, and nothing here is timed.

## 6. Before and after

### 6a. In the baseline tree (before the water-table work touched the table fields), 24 seeds, median (min to max)

| | Before | Law 1 only | Laws 1 and 2 | Bornholm |
|---|---|---|---|---|
| Organic carbon off peat, 0 to 23 cm, t/ha | 164.4 (151.3 to 175.3) | 134.3 (117.4 to 145.4) | 69.8 (67.5 to 87.5) | Denmark 72 in 0 to 30 cm (R598); forest and semi-natural 70 (R598 Table 8); German forest 62 (R1282) |
| Tree, % of land | 50.7 | 50.4 | 50.1 | 81 to 92 before farming (R621) |
| Open land, % of land | 49.5 | 49.7 | 49.9 | 8.4 to 19.4 before farming |
| Marsh, bare, % of land | 30.1, 12.1 | 30.1, 12.2 | 30.1, 12.2 | 1.3 meadow and bog now |

Rain (850 mm, coast minus inland +193), lakes (28 of 5 ha or more, 1.68% of ground), the water table (median 1.44 m, 20.5% under 1 cm, 34.0% of land with the winter table under 0.2 m) and peat (26.5% over 0.5 m) are the same to the printed digit in all three columns.

### 6b. In the tree as the water-table agent's work stood when I finished (the same state for both columns: I swapped my kernel's original in and back), 24 seeds

| | Original kernel | Laws 1 and 2 |
|---|---|---|
| Organic carbon off peat, 0 to 23 cm, t/ha | 155.7 (150.9 to 171.9) | 67.8 (67.3 to 76.2) |
| Tree, open, marsh, bare, % of land | 56.6, 43.5, 23.6, 11.9 | 56.0, 44.0, 23.6, 12.0 |

The six gaps' other numbers in this state are the water-table agent's (table median 1.65 m, peat 21.3%, winter table under 0.2 m on 27.0%), identical in both columns.

### 6c. Where the carbon is (seeds 1 to 6, the same tree state as 6b), t/ha off peat, by tree share

| | p10 | p25 | p50 | p75 | p90 |
|---|---|---|---|---|---|
| Original kernel | 108.5 | 133.9 | 156.7 | 237.7 | 272.6 |
| Laws 1 and 2 | 48.9 | 53.0 | 68.1 | 124.6 | 151.1 |

| Tree share | Original: median, cells | Laws 1 and 2: median, cells |
|---|---|---|
| under 0.5 | 146.4, 19,870 | 130.5, 19,870 |
| 0.5 to 0.8 | 148.8, 109,722 | 62.5, 121,671 |
| over 0.8 (a closed canopy) | 244.6, 81,150 | 129.9, 69,201 |

A closed canopy's soil input: 10.4 t C/ha a year in the original (the whole year's dry matter, organic matter 19.1%), 5.5 after the two laws (organic matter 10.1%). Its net primary production, the soil input over 0.573, is 9.6 t C/ha a year against R1281's 7.4 (SD 0.55) for temperate humid deciduous forests, 1.3 times, where the original was 1.4 times; its foliage and root litter, 5.5, against R1281's 4.4, 1.25 times.

## 7. What is closed, what is not

**Partly closed.** The island's median off-peat carbon, 164 (156 in the later tree) to 68 to 70 t/ha, is now at Denmark's national mean of 72 (0 to 30 cm) and at its forest and semi-natural land's 70 (R598 Table 8, derived), a little above a German forest's 62 (R1282). Two reasons it must not be read as closed:

1. **The median is a plateau of partial-cover cells.** 58% of the land has a tree share of 0.5 to 0.8 and carbon 62; the cells with a closed canopy (tree over 0.8, 33% of the land) hold a median 130 t/ha, **1.9 to 2.1 times** the forest figures above (R598 Table 8's 70, R1282's 62), and the marsh cells (reeds, whose whole production reaches the soil) 130. The median reaches 72 because two thirds of the land is not a closed canopy, which is the open-land gap (gap 1d), not forest soil. The six-gap script (`scripts/island-gaps.ts`) should report the closed-canopy median beside it.
2. **The depth.** The model's 23 cm against the inventories' 30 cm: the same-depth target is lower than 62 to 70 by the carbon of the 23 to 30 cm layer [INFERENCE: some tenth to a fifth, from carbon falling with depth in Adhikari's 0 to 100 cm of 120 t/ha against 72 in 0 to 30; not computed], so the model is further above it than the table says.

**Still open, with the direction each would move the closed canopy's carbon:**

- **The input is still 1.3 times a forest's net primary production.** RUE 1.4 g/MJ (R335) is a crop's (Monteith's C3 crops); a forest's efficiency is lower. Not touched: replacing it needs a cited forest value, and a retune is forbidden. Down.
- **The smooth index starts the leaves early.** On a sea-level cell the 21-day index passes 0.2 on 9 March and falls below it on 26 October (the day's own index: 28 February and 13 October), against beech and aspen leaf-out in late April or early May, a threshold event [INFERENCE: not checked against Danish records, none were found]. If leaves were out only from 1 May the year's leaf display would fall by 16% more (36.1 to 30.4, the mean-year sensitivity on a sea-level cell). Down.
- **The index leaves out the 21-day running mean and the days' weather**, which the paper's index has: on a sea-level cell the mean over 400 simulated years with Rønne's day-to-day spread (R479) takes the year's display from 36.08 to 35.30 (-2.2%), the 21-day mean to 35.60 (-1.3%), both to 34.77 (-3.6%). Down by a few percent; not in the kernel.
- **The index is read as the leaves' share of full cover, not through Beer's law**, so a quarter display makes a quarter of the light and not more. Up, by an amount the model has no leaf area for.
- **The cover's compensation point is still the crop's year**, so the deciduous trees' competitiveness against the others is overstated and cover moves only through organic matter (trees 56.6 to 56.0% of land in 6b). A leafless season in `yearComp` would lower deciduous cover and is entangled with the open-land gap.
- **Foliage litter partly decays on the forest floor before it enters the mineral soil**, and some of the 'roots' are coarse (wood-like); R1282's organic layer, 18.8 t C/ha, is that floor. Neither is modelled: down.
- One wood share for every tree and shrub, from flux-tower forest classes (R1281) rather than Danish aspen and hazel stands; RothC's own rates and its cover factor 0.6 under forest are the crop's [UNVERIFIED for forest]. The Danish forest figures to judge by (Callesen 2003, Vesterdal 2008) were not read.
- The day's range is the station's everywhere (no sea breeze, no cold pool), the sky shares are hours not days, and the season's own sun is the equinox or solstice day's (`climate.ts sunlight`): the season's mean clear-sky light is 12% (autumn) and 39% (winter) above that day's and 5% below it in spring and summer, which neither law repairs.
- Evergreens keep the warmth ramp, the winter photosynthesis of Scots pine is a gap, and no pine wins here.
- `nitrogen` (kg N/ha a year, read by the inspector only) falls by about half for the same reason as the carbon.

## 8. For the cutover

- The CPU `ground()` needs the same two laws: `terrain-phenology.ts` `leafFactors` is the float law and can be imported; the day tables sit beside it. `HALF_RANGE` and `RANGE` there repeat `sim/air.ts RANGE` (importing `air.ts` would pull the sim's world into the terrain stage): recompute them whenever it changes.
- `sim/soil.ts` and `sim/inspect.ts` read `organic`, `carbon` and `nitrogen`; they fall by about half. The world's `VERSION` is the parent's call at the cutover.
- The GPU kernel gained inputs (the four seasons' relative humidity) and outputs (the four seasons' leaf display, which `groundAndLeaf` returns for the test; `groundGpu` returns the `Ground` as before).
