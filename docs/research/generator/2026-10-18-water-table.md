# The water table: groundwater evapotranspiration in the steady aquifer (gaps 1c, 1d, 1e)

Chain: terrain-constants.md sec. 12g gap 1 and sec. 11 gap 1 (the steady aquifer carries no groundwater evaporation, so the year's mean and dry-season tables stay near the ground; the winter table under 0.2 m makes trees unsuitable and the reeds take the land; the dry-season table within 0.3 m makes peat). Code: `src/gpu/wgsl/terrain-water.ts` (the sink, `gw_et`, in the `aqw`, `aquifer` and `outflux` kernels, and the same law in `seasons`), tested by `src/gpu/terrain/water.test.ts`. The CPU stage `src/terrain/water.ts` is unchanged: it is the unfixed reference until the cutover. References R1250 to R1256 are this file's; the parent merges pointers into terrain-constants.md.

## Finding

1. **The bucket already pays the reference evaporation from rain, so only two terms are groundwater's.** The stage's soil bucket (100 mm, water.ts 211 to 218) takes the whole potential evaporation (PET) from rain wherever the rain and the store suffice. Adding "PET at full rate" as a sink would count that evaporation twice. What the bucket leaves is the shortfall U = PET less what it gave (seed 1, 850 mm of rain: U above nothing on 50% of land, 15.7 mm a year on average, 49 mm at the 95th percentile). That is what plants with roots in the water table draw from it, and it is the term the seasons stage already drew (`drawn`, water.ts 355) but left out of the steady solve ("the plants' drawing leaves the year's mean where the steady solve put it [gap]", water.ts 346 to 348). The second term is the wet ground's own evaporation above the reference grass the bucket stands for (reed swamp Kc 1.2 in mid season, R1252).
2. **Taking U out of the aquifer is right in sign and size.** Where U is not met from the table the model's surplus is too big by U (the bucket's store was left empty and the autumn rain refilled it); the sink restores P less PET as the net recharge. Over seeds 1 to 3 the sink draws 117 to 140 l/s from the aquifer on 17,000 to 20,500 cells: 44 to 56 l/s of the 117 to 183 l/s the bucket leaves unmet (the rest lies where the table is below the extinction depth) and 73 to 87 l/s the wet ground's own.
3. **It closes part of the chain, not all of it.** Over 24 seeds the table at the ground falls from 20.5% of the land to 7.8%, the winter table under 0.2 m from 34.0% to 19.0%, marsh from 30.1% to 18.5%, peat from 26.5% to 10.2% and the trees rise from 50.1% to 61.3% (Bornholm before farming: 81 to 92% trees, 0.3% bog). The runoff to the sea falls 3.8% (11.46 to 11.03 l/s a km2 on seed 1; Bornholm 7.9, the rest of the excess being the rain's), the summer runoff 1.9 to 1.6 l/s a km2 (Bornholm's median minimum 0.1), the springs 435 to 376, the groundwater share at the mouths 0.131 to 0.116. Streams (the channel heads follow drainage area and slope, not the groundwater) and lakes (155 lakes, 28 of 5 ha or more, 1.68% of ground: the sink moves the groundwater a lake bed takes in too little to flip one) are unchanged.

## Sources read

- **R1250** Harbaugh A.W. (2005), MODFLOW-2005, the U.S. Geological Survey modular ground-water model, the Ground-Water Flow Process, USGS Techniques and Methods 6-A16. The EVT package as the USGS online guides to MODFLOW-2005 and MODFLOW-2000 and the ModelMuse help state it (read 2026-10-18): a head-dependent flux out of the aquifer, the maximum ET rate (EVTR) when the head is at or above the ET surface (SURF), none when it is below SURF less the extinction depth (EXDP), linear between. The manual's chapter 6 text was downloaded but its extraction did not reach the package's section; the form above is the guides'. What I used: the structure of the sink, a flux out of the cell that falls with the head to nothing at an extinction depth.
- **R1251** Shah N., Nachabe M., Ross M. (2007), Extinction depth and evapotranspiration from ground water under selected land covers, Ground Water 45(3): 329 to 338 (abstract read at PubMed), and Shah N. (2007), Vadose zone processes affecting water fluctuations: conceptualization and modeling considerations, PhD dissertation, University of South Florida, ch. 3 (read: text, table 3.1 extinction depths, table 3.2 and 3.3 parameters, eq. 3.16). Variably saturated flow (Richards) under drying soil for twelve USDA textures and three covers: for a water table within 0.5 m nearly all ET comes from groundwater; the decoupling of ground water and the vadose zone begins at 30 to 100 cm; the decline of groundwater ET with depth is better fitted by an exponential than by the linear MODFLOW form; fine soils extinguish deeper than coarse (grass: sand 145 cm to clay 715 cm); extinction depth rises with rooting depth by about the rooting depth. Used: the grassland column (roots 100 cm, which is `ROOTS` = 1.0 m in growth.ts) of tables 3.3 (d'', b) and 3.1 (extinction depth) for all twelve classes (`SHAH_GRASS`). The equation for the groundwater share (eq. 3.17) was lost in the PDF's text extraction.
- **R1252** Allen R.G., Pereira L.S., Raes D., Smith M. (1998), Crop evapotranspiration, FAO Irrigation and Drainage Paper 56, ch. 6 Table 12 (the same table as R559, whose open water rows the model uses; the wetland rows read 2026-10-18): temperate wetlands, reed swamp with standing water Kc 1.00, 1.20, 1.00 and with moist soil 0.90, 1.20, 0.70 for the start, middle and end of the season; cattails and bulrushes 0.30, 1.20, 0.30 with killing frost. Used: Kc 1.2 for the middle of the season.
- **R1253** Houston Durrant T., de Rigo D., Caudullo G. (2016), Alnus glutinosa in Europe: distribution, habitat, usage and threats, in San-Miguel-Ayanz J. et al. (eds), European Atlas of Forest Tree Species, Publications Office of the EU: alder grows on marshy waterlogged sites, riverside and lake shores, and survives flooding better than most forest trees; under 1% of forest cover in most countries, up to 5% in central Europe. Used: only for the next gap below.
- **R1254** Yeh P.J.-F., Eltahir E.A.B. (2005), Representation of water table dynamics in a land surface scheme, Part II: subgrid variability, Journal of Climate 18: 1861 to 1880 (read the text): in the Illinois simulation (a model result, not a measurement) subgrids with a table shallower than 1 m give water to the roots all year, up to about 100 mm a month in summer, and tables to 3 m do in summer. Used as a check on sign and order [analogue]; this model's draw is smaller because the bucket already meets the reference demand from rain.
- **R1255** Soylu M.E., Istanbulluoglu E., Lenters J.D., Wang T. (2011), Quantifying the impact of groundwater depth on evapotranspiration in a semi-arid grassland region, Hydrology and Earth System Sciences 15: 787 to 806 (abstract read only): the depth and thickness of the zone where the water table governs ET differ by up to a factor of two with the soil parameter set, so the extinction parameters here carry that uncertainty.
- **R1256** Nielsen A.B. (2008), Pollen based reconstruction of Atlantic forest landscapes (Terra Nostra 2008/2: 205 to 206): only the title page was read, nothing used.

Named by the operator and **not read**: Zhang et al. 1999, Lowry and Loheide 2010 (Water Resources Research; only a search snippet), Gribovszki et al. 2010 (a review of diurnal groundwater fluctuations; the search reached only a 2008 paper of the same group, which does not give extinction depths). The Soil Survey Manual's texture triangle (ch. 3, fig. 3-7) was downloaded but its text did not reach the figure.

## The law

For a cell whose head h stands d = z - h below the ground z (d = 0 at the ground), per year, in metres of water:

E(d) = sum over the four seasons s of min(U_s, f(d) PET_s) + 0.2 PET_summer r(d)

- **U_s** the soil bucket's shortfall in season s, **PET_s** the climate stage's potential evaporation. [derived from the bucket, water.ts 211 to 218]
- **f(d)** the share of the potential evaporation the ground lifts to the roots: f = 1 for d up to d'', and beyond it f = (e^(-b (d - d'')) - e0) / (1 - e0), e0 = e^(-b (d_ext - d'')), so it reaches 0 at the extinction depth. d'', b and d_ext by USDA texture class are Shah's grassland column (R1251). [R1251; the form is an inference, below; the rescaling [design]]
- **r(d)** the reeds' niche fit: 1 to d = 0.2 m and falling linearly to 0 at 0.4 m (niche.ts `NICHE.reeds.table`, the ESC regimes very wet and wet, R606), so the wet ground's extra applies where the niche puts only reeds. [R606 via niche.ts; the coupling [design]]
- **0.2 PET_summer** the reed swamp's Kc 1.2 over the reference's 1.0 (R1252) in the game's summer, which stands for the mid season; the other seasons stand for the start and end, whose Kc do not pass 1.0. [R1252; the season mapping [design]: the 92 day season against the table's stages of 10, 30, 80 and 20 days for temperate wetlands]

The sink is taken out of each cell's balance in the steady solve (both solves, the first of 150 sweeps and the second of at most 1500; the 1.6 over-relaxation and the 2 mm stop are the CPU's rules), and the cell's out flux (what comes out of the ground: seeps, springs, streams' beds, rejected recharge) is net of it. The seasons stage draws the same terms each season at the year's mean table, in place of "the whole shortfall less the springs' water" (the CPU's rule).

**Solving it (integer, deterministic).** E falls as the head falls, so the cell equation is nonlinear. Each sweep takes the sink at the head the cell held last, and holds in the cell's weights a share of its own head, k_d / (C + k_d), with k_d = A b (U + PET e0 / (1 - e0)) + A (Kc - 1) PET_summer / 0.2 m the bound on how fast E rises with the head (a lagged diagonal: the fixed point is exactly C h = S + R A - A E(h), and the step is a majorising one for a convex problem, so it converges for any steepness). The weights are made once per solve in `aqw`, so the sweep has no division; the exponential is 2^-x from a 257 entry table with linear interpolation. Cells with no sink (stream, lake and sea cells, whose heads are fixed) have k_d = 0 and the sweep is the old one bit for bit.

**What converges.** Both solves stop by the CPU's rule. Sweeps in the second solve: 363, 188 and 505 on seeds 1 to 3 (150 at most in the first). Every cell below the ground closes its balance (the four faces, its recharge, less the sink) to within 1.7 mm of head at worst; the 8,900 cells that stood at the ground on seed 1 before the sink are now 2,600, and on seeds 1 to 3 all but 0 to 3 of the cells at the ground seep water out.

## Constants

| What | Value | Source |
|---|---|---|
| d'', b, d_ext by texture, grassland | sand 27 cm, 0.036, 145 cm; loamy sand 29, 0.031, 170; sandy loam 35, 0.022, 230; sandy clay loam 31, 0.020, 300; sandy clay 35, 0.028, 310; loam 39, 0.015, 370; silty clay 78, 0.020, 430; clay loam 35, 0.014, 505; silt loam 40, 0.011, 515; silt 49, 0.021, 530; silty clay loam 49, 0.017, 550; clay 70, 0.017, 715 | R1251 tables 3.3 and 3.1 |
| The form of the groundwater share beyond d'' | y0 + e^(-b (d - d'')) (Shah's y0 offset) | [INFERENCE]: eq. 3.17 was not recoverable; it gives 258 cm for sand (table 3.1: 250), 232 for sandy loam (230), 370 for loam (370), but 568 for silt loam (515) and 321 for sandy clay loam (300) |
| The rescaled form used | (e^(-b (d - d'')) - e0) / (1 - e0), zero at table 3.1's extinction depth | [design]: continuous, and reaches 0 where table 3.1 says (Shah's offset never does for the clays) |
| The grass column for every cover | roots 1.0 m = `ROOTS` | [derived] (Shah's grassland roots are 100 cm); the cover is made after the water, so the forest column (roots 2.0 m, extinction 2.5 to 8.2 m) is [gap] |
| The soil's texture class | the drift's over as much of the roots' metre as it fills, the rock's below (parameters blended linearly) | [design], as ground.ts takes texture; class from sand and clay shares by the USDA triangle [UNVERIFIED at its edges]: clay till and mudstone sandy clay loam, sandy till sandy loam, meltwater sand sand, sandstone and granite loamy sand, limestone silt loam, dolerite silty clay |
| Peat's class | silt (sand and clay both 0) | [gap]: no organic soil in R1251; never met by the water stage, whose drift is not yet peat |
| Wet ground Kc, mid season | 1.2 | R1252 |
| Where the wet ground's extra applies | table under 0.2 m full, nothing at 0.4 m | niche.ts reeds (R606) [design: the cover stood in by the niche's own rule] |
| Sweeps, over-relaxation, stop | the CPU's | water.ts 102 to 125 |

## Before and after, 24 seeds (`bun scripts/island-gaps.ts --seeds 24`)

"Before" is the committed kernel, re-measured with the ground stage as it stood that day (the carbon agent was editing it, so the tree and carbon rows differ from the handoff's baseline of 50.7% trees and 164 t/ha; the water rows are the same). "Unmet only" is the first term alone, "after" both. Medians, then min to max.

| | Before | Unmet demand only | After (both terms) | Bornholm |
|---|---|---|---|---|
| Land mean rain, mm | 850 (826 to 876) | the same | the same | 672 |
| Lakes of 5 ha or more | 28 (14 to 42) | 28 | 28 | 18 assessed |
| Lake area, % of ground | 1.68 (1.28 to 2.08) | 1.68 | 1.68 | 0.45 |
| Median water table depth, m | 1.44 (0.88 to 2.10) | 1.65 (1.38 to 2.26) | 1.70 (1.41 to 2.30) | a few metres in the basement |
| Table under 1 cm, % of land | 20.5 (17.8 to 26.2) | 15.3 (12.9 to 18.2) | 7.8 (6.4 to 8.9) | |
| Winter table under 0.2 m, % of land | 34.0 (29.1 to 39.3) | 27.0 (24.2 to 31.0) | 19.0 (16.6 to 20.9) | |
| Tree, % of land | 50.1 (46.0 to 54.2) | 56.0 (52.6 to 57.7) | 61.3 (59.7 to 63.4) | 81 to 92 before farming |
| Open (all but trees), % | 49.9 (45.8 to 54.0) | 44.0 (42.3 to 47.4) | 38.8 (36.6 to 40.3) | 8.4 to 19.4 |
| Marsh, % of land | 30.1 (25.6 to 34.8) | 23.6 (21.1 to 27.0) | 18.5 (16.1 to 20.0) | 1.3 now |
| Bare, % of land | 12.2 (11.9 to 12.6) | 12.0 | 11.7 | |
| Peat over 0.5 m, % of land | 26.5 (20.6 to 32.2) | 21.3 (18.2 to 24.9) | 10.2 (8.6 to 11.3) | bog 0.3 |
| Organic carbon off peat, t/ha | 69.8 (67.5 to 87.5) | 67.8 | 78.8 (68.5 to 99.7) | 72 (the carbon agent's chain; moves with the off-peat set) |

Seeds 1, 2, 3 (`bun scripts/water-gaps.ts`), before, unmet only, after:

| | Seed 1 | Seed 2 | Seed 3 | Bornholm |
|---|---|---|---|---|
| Streams, km (lines) | 188 (1024); 188; 187 | 171 (784); 171; 171 | 188 (877); 188; 188 | 416 km designated, 0.71 km/km2 |
| Springs | 435; 408; 376 | 523; 485; 445 | 489; 473; 442 | |
| Lakes (5 ha or more), % of ground | 144 (28), 1.75; the same; the same | 118 (14), 1.28 | 134 (23), 1.53 | 18 assessed, 0.45 |
| Runoff to the sea, l/s a km2 | 11.46; 11.31; 11.03 | 10.94; 10.75; 10.42 | 10.49; 10.30; 10.01 | 7.9 |
| Runoff by season, l/s a km2, after | 9.3, 1.6, 8.9, 24.3 (before 9.7, 1.9, 9.2, 25.1) | 8.7, 1.4, 7.9, 23.7 | 8.4, 1.5, 8.3, 21.9 | median minimum 0.1 |
| Groundwater share at the mouths | 0.131; 0.125; 0.116 | 0.134; 0.126; 0.116 | 0.146; 0.135; 0.124 | 0.05 to 0.35 (R534) |
| Median table, m; under 1 cm, %; winter under 0.2 m, %; dry within 0.3 m, % | 1.44, 20.5, 33.8, 26.2; 1.65, 15.9, 27.9, 21.3; 1.69, 7.8, 19.9, 10.2 | 0.99, 24.9, 36.7, 30.4; 1.41, 18.2, 29.0, 23.7; 1.45, 7.9, 19.3, 10.8 | 1.44, 20.1, 33.7, 23.2; 1.70, 14.9, 26.6, 20.7; 1.73, 7.7, 19.4, 10.1 | |

Stream density, springs and lakes are not made unreasonable: streams and lakes are untouched, springs fall by 10 to 15%, the groundwater share stays inside R534's 5 to 35%.

## What is closed, partly closed, open

- **Closed:** the named gap (no groundwater evaporation in the steady solve). The year's table is deeper (median 1.44 to 1.70 m), the seepage faces smaller, the summer draw consistent with the mean.
- **Partly closed:** open land (49.9% to 38.8%, target 8.4 to 19.4%), marsh (30.1% to 18.5%, target 1.3%), peat (26.5% to 10.2%, target 0.3%). About two thirds of the open land's excess is still there.
- **Unchanged:** lakes, streams (not in this chain).

## The next gaps (diagnostics, one seed, not model changes)

Measured on seed 1 with a float64 copy of the CPU hydrology carrying the same law (a scratch file, since deleted), which matched the GPU kernel on the table rows to 0.1 point.

1. **How the tree dies at 0.2 m.** By the winter table the land splits as: under 0.2 m 27.9% of land (with the first term only), tree 0%, marsh 82%, bare 18%; 0.2 to 0.4 m 4.8%, tree 56%; deeper than 0.4 m trees 77 to 85%. So the open land follows the winter table one for one: the ESC regime's cut in niche.ts (pine, oak, ash and aspen unsuitable under 0.2 m) leaves nothing but reeds on very wet ground. Bornholm's wet woodland is alder (R1253), which the island's flora does not have; but alder is under 1% of forest in most countries and up to 5% in central Europe, so adding it would not close more than a few points of the 38.8%. The table has to move.
2. **The aquifer's transmissivity.** The cells at the ground are on granite and sandy till slopes about 375 m from a stream (seed 1 before the sink: granite 38% of its land with the winter table under 0.2 m, mudstone 52%, sandstone 6%): the cited recharge cap of 100 mm a year (GSI, R569) is more than the rock's cited T (the DK-model's K times 100 m, R522: 441 to 820 m2 a year for the basement) carries over a 375 m slope, so the rest stands at the ground and runs off. With K four times higher (not a cited value) the median table is 6.0 m (R522's "a few metres in the basement" is met), the table at the ground 5.0% and the winter table under 0.2 m 14.0%, with both terms; ten times changes little more (5.8% and 14.6% with the unmet term only). The floor is the seepage faces of valley floors and hollows. A source for the near-surface hydraulic conductivity of Bornholm's weathered and fractured basement, or for the ditches and drains of the unfarmed island, was not found; permeability that falls with depth in crystalline rock (Manning and Ingebritsen 1999) and the hard-rock weathering profile (Wyns, Maréchal and others) are the unread leads [UNVERIFIED].
3. **The rain.** The sink follows the model's own rain: at 850 mm it meets U above nothing on 50% of the land, 15.7 mm; with the rain at Bornholm's 672 mm (the same fields times 0.79, a scratch trial for the climate chain's gap) U is 38.4 mm on 75% of the land and the table at the ground 6.3%, the winter table under 0.2 m 12.8%, trees 64% (wet ground term included). The sink is the only mechanism here that gets stronger as the rain gap closes.
4. **The seasons' amplitude.** 19.0% of land has the winter table under 0.2 m but only 7.8% has the mean table at the ground: the other 11 points are the seasons stage's rise (the season's net water over the specific yield, 0.06 for clay till to 0.21). It is the next law to look at (Sy of the till against the water table's depth and the seasons' recharge shape).
5. **The peat rule** (ground stage, not changed): the deepest table within 0.3 m gives peat on 10.2% of land against bog 0.3%, 2.4 points more than the mean table at the ground. The rule asks for nothing but the water table (no acidity, no rain's share, R595 is left out).
6. **Kc of the wet ground** is a stand-in for the cover: the water stage knows no cover. Reed swamp's 1.2 applies where the niche allows only reeds; forest on wetter soil (alder, willow) and the forest column of Shah's table (roots 2.0 m) would draw more [gap].

## Tests

`bun test src/gpu/terrain/water.test.ts -t "water seed N"` for N = 1, 2, 3, one at a time: pass. The test (1) takes each island's inputs with the rain raised to the potential evaporation and summer's potential evaporation set to nothing, so that the law does nothing, and requires every output field within the old tolerances of the CPU stage (it does: heads to 1.2e-4 m, flows to 2e-6, rivers cell for cell; the spring list is compared above 0.2 l/s, as raised rain makes every flow a spring); (2) on the island itself, requires the slope (the one field the law cannot reach) within tolerance and the changed fields to obey the law: each cell's balance closes to 0.1 m of head (1.7 mm at worst), cells at the ground do not take water in, the sink is 0 or more and at most the unmet demand and the wet ground's extra, the kernel's cell budget equals the law's to 0.015 mm of head, the table is deeper in the median and the table at the ground less than the CPU's, the flow to the sea falls by about the water the sink takes (seeds 1 to 3: 0.106, 0.131, 0.122 m3/s against 0.117, 0.140, 0.133), and the season tables stay in bounds; (3) requires the same words on a second run. Not checked: a second adapter (this Mac has one). The GPU was shared with the carbon agent's runs throughout, so no timing here is reliable; the hydrology stage took 0.5 to 1.0 s an island against 0.16 to 0.24 s before (the sweeps cost more per step where cells carry the sink).
