# The window: the game's ground refined from the planet (plan Unit 8)

Chain: `docs/plans/2026-10-19-001-feat-globe-generator-plan.md` Unit 8, on the planet of the grid, tectonics, erosion, atmosphere and ice notes. Code: `src/gpu/globe/window.ts` (the planet's fields by stage, the landings, the remap, the window's parameters and `windowOf`), the island stages made able to run under a window's parameters (`src/gpu/terrain/{upstream,rain,climate,water,island}.ts`, `src/gpu/wgsl/terrain-{upstream,water,climate}.ts`), `src/sim/sky.ts` (`skyAt`), `src/sim/world.ts` (`windowIslandOf`), tested by `src/gpu/globe/window.test.ts` (one case at a time: `bun test ./src/gpu/globe/window.test.ts -t "<name>" --timeout 280000`), run with `scripts/globe-window.ts`. R-numbers R1700 to R1749 (R1714 to R1749 free).

## What was built

1. **The planet** (`planetOf(gpu, seed, store)`, `buildStage`, `readPlanet`). Four stages, each kept in a `PlanetStore` (the script's is a directory a seed, keyed by a hash of the globe's sources, so a planet made by other code is not read as this code's): `chain` (the erosion unit's `runChain`: 200 My of tectonics with four 0.5 My substeps of erosion after each step, the atmosphere's rain at 0 and 100 My, 50 My of erosion alone: 146 s on the M3 Pro), `climate0` (the atmosphere on the chain's planet, the ice's input: 48 s), `ice` (20 kyr at no offset, one 100 kyr cycle of the orbit's forcing scaled to the cited glacial cooling, 20 kyr at no offset for the sea's return; resumable in parts: 163 to 171 s, one part), `climate1` (the atmosphere on the bed the ice left, at the sea it left: 33 s). What a window reads: the bed the ice left above the present sea, the five rock pools, the chain's receivers, each season's sea-level air, rain, snow, runoff, vector-mean wind and sea surface, the ice at the cycle's greatest volume and now, the rock it cut and the sediment it laid, and the lowest and present sea.
2. **The landings** (`landingsOf`): R1705 below. `bun scripts/globe-window.ts --seed 1 --landings 10` prints them with how many land cells each measure let through.
3. **The window** (`windowOf(gpu, planet, latDeg, lonDeg)`): the coarse fields carried to the 256 by 256 cells of 75 m by a conservative remap (R1700), the window's parameters made from the planet (the table below), the island's erosion run under them to the planet's mean height (R1702, R1706, R1707), then the island's rain, climate, water and ground stages under the window's place. About 7 s a window on the M3 Pro. It returns the Island every reader of one expects, the window's sky (`skyAt(latDeg)`), its parameters and the coarse means it was held to.
4. **The page's way to it later** (not wired): `world.ts windowIslandOf(seed, latDeg, lonDeg, planet)` makes the Ground (scenery and dry tiles, as islandOf does, now through one `groundFrom`) and registers it under the seed, so `groundOf(seed)` reads it. The sim's own sky and weather stay the island's (gap 9).
5. **The Bornholm path is unchanged**: every widened kernel is generated from one source with a format argument, and the island's format gives the WGSL text it had, byte for byte (checked against a snapshot of `UPSTREAM_WGSL`, `WATER_WGSL`, the climate's seven sources and the rain's parameter words taken before the change); the stage tests' goldens pass (below).

## The remap (R1700)

Each window cell's centre and a margin of half a coarse cell round the window are located on tier 0 (`locateVec`): that piecewise-constant field is the coarse cells weighted by their areas of overlap with the window at 75 m. It is smoothed by a moving box one coarse cell wide (the side of the local cell's area in window cells, odd: 163 at a face's middle) along x and then y, which carries a piecewise-constant field to the bilinear interpolation between cell centres where the coarse cells are aligned with the window [derived; the cube's cells are turned against east and north by up to 45 degrees near a face's corners, where it is a smooth mean-preserving field and not bilinear: design], and shifted by one constant so that the window's mean is the overlap-weighted mean of the coarse cells. Tested: the mean of a random field is kept to 1e-3 of its range (float32 rounding), a constant comes back as itself to 1e-4.

The window's plane: x east, y north at the centre, mapped to the sphere by the gnomonic map (the stretch over 19.2 km on 2,000 km is under 6e-6) [derived]; the island's grid has y south, so a window cell (ix, iy) is at x = (ix + 0.5 - 128) 75 m, y = -(iy + 0.5 - 128) 75 m.

## Every Bornholm input the island stages read, and the window's

| island input (where) | what it is on Bornholm | the window's | tag |
|---|---|---|---|
| `SUMMIT_M`, `U0` (terrain/island.ts) | uplift inverted from Rytterknaegten's 163.5 m | uplift inverted from the planet's mean height (R1702) | [derived] |
| `CRYSTALLINE`, `DIP`, `STACK`, `STACK_TOP`, the hinge and the faults (island.ts, kernels `shape`, `hinge`, `rocks`) | the horst and its Palaeozoic and Mesozoic cover | the planet's five pools by depth below its surface (R1701) | [analogue] classes |
| `SHORE`, `OFF_GRANITE`, `OFF_SEDIMENT` (kernel `seafl`) | 24 measured profiles off Bornholm | the planet's sea floor (the remap) | [derived] |
| the oval coast and its noise (kernel `shape`) | a warped oval [design] | the planet's coast (the remap's zero) | [gap: no headland or bay under 12 km] |
| `DYKES`, `DYKE_LEN` | 250 dolerite dykes in 400 km2 | none | [gap: no dyke swarm on the planet] |
| `JOINTS`, `JOINT_GAP`, `JOINT_REACH`, `VALLEY_LEN`, `VALLEY_GAP`, `SILL` | the basement's fracture zones | Bornholm's, kept | [gap] |
| `SCOUR` | 50 m of areal scour (R531) | 50 m where the planet's ice stood at the glacial maximum, none where it did not | [gap: the planet's cut is a 12 km budget the joints do not read] |
| `ADVERSE` (ice 300 km from its margin) | Nye's profile at Bornholm's distance | Bornholm's, kept | [gap] |
| `TILL_MAX` | 6 m (R530) | the planet's ice-laid sediment where its ice stood (at most 30 m, R1703); Bornholm's 6 m where it never did | [gap: an unglaciated place's regolith is not modelled] |
| `WATER_TABLE` (a hollow's lake threshold) | 3 m (R522) | kept | [gap] |
| `SEASONS` t (terrain/climate.ts) | Ronne's air | the planet's sea-level air, the window's mean of each season | [derived] |
| `SEASONS` sea | Tejn harbour | the planet's sea surface over the window's sea cells (its air where it has none) | [derived] |
| `SEASONS` wet, `P_BG` | 634 mm a year by season | the planet's rain of each season, its remap, the window's mean | [derived] |
| `SEASONS` cloud, beam, glow, humid0, rains, rainWind, rainHumid | Hammer Odde, Greifswald and Leba | kept | [gap: the planet has no cloud, humidity or wet-hour field] |
| `ICE_SHARE` (gpu/terrain/rain.ts) | the soundings' freezing level | e^(-z_f / H_w), z_f the season's sea-level air over the lapse rate (R1704) | [derived] |
| `ROSE`, `WET_ROSE` | Hammer Odde's and the 850 hPa wet rose | their shapes kept, turned to the planet's wind: the year's vector mean for the rose, each season's for the wet rose, by the island's own offset between the two | [gap: the shapes] |
| the prevailing wind's draw (`climateGpu` rand) | a seeded draw | the planet's year's vector-mean wind | [derived] |
| `SEA_WIND` | Hammer Odde's 6.26 m/s at 10 m | kept | [gap: the planet gives the vector mean, not the speed] |
| `POOL_C`, `FOG_Z`, `FOG`, `SNOW_HALF`, `SNOW_SPREAD`, `DAY_SPREAD`, `DAY_KEEPS` | Bornholm's | kept | [gap] |
| sky.ts `LAT` 55.1 | Bornholm | the window's latitude (`skyAt`), in the climate's sun tables and on the Window | [derived] |
| `HEAD_C` (terrain/water.ts) | 25 m, inverted from Bornholm's drainage density | kept | [gap] |
| `BANKFULL` | Bornholm's floods over its mean runoff | kept | [gap] |
| `ROCKS`, `DRIFTS`, `CREEP`, `SY_*`, `BUCKET`, the ground's laws | properties of the classes and cited laws | kept | as cited |

## How the window's erosion is held to the planet

- **R1701 the rock.** The planet's classes (tectonics LITH) as the island's rocks: basalt and volcanic rock as dolerite [analogue: the island's one mafic rock; the planet's volcanic K is a hundred times granite's, the dolerite's is granite's: gap], sediment as sandstone (the planet's erosion takes it so, R1561), metasediment and granitoid as granite and gneiss [analogue]. Each cell's rock is the layer of its column (remapped thicknesses, from the top as the erosion unit removes them: sediment, volcanic, metasediment, granitoid, basalt) at the depth the steady state cuts below the planet's smooth surface: the first run's rock is the top layer's, the rest the depth the first run's steady state, scaled to the uplift found, reaches.
- **R1706 the sea and the edge.** The erosion runs at the lowstand's sea (the heights raised by the present sea over the lowstand, 5.6 m on seed 1), so valleys cut to it are drowned when a kernel lowers the heights to the present sea before the hollows. Water leaves the window only into its sea and at its outlets: where the chain's receivers first leave the window from a coarse cell whose centre is inside it (R1707), or, a window with neither, its lowest edge cell [design]. Outlets are held at the planet's surface (no uplift, no erosion: the flood starts from them and they drain nowhere); the rest of the edge is relaxed and eroded as the inside is, with no flow across it. [design: a closed boundary with outlets, the common choice of landscape models; see gap 3.]
- **R1702 the uplift.** At steady state the island's law (implicit stream power, n = 1, and linear creep) makes the height of a cell its base level's (the sea's 0 or its outlet's height) plus the uplift times a field that only the rock and the network set, so the mean over the land is linear in the uplift. A first run at 1e-6 m a year (`PROBE_UPLIFT`; its relief stays inside the words) gives the field; the uplift that makes the land's mean the planet's is solved, the rock laid by depth from the predicted surface, and the uplift corrected by further runs until the land's mean is within 0.5% (`MEAN_TOLERANCE`, at most four more runs, `MEAN_RUNS`) [derived, as U0 was inverted from Bornholm's relief; the tolerance and the runs: design]. Seed 1's landings: 0.079, 0.072 and 0.058 mm a year; the runs' land means 16.9, 2800, 1891, 1931 against 1929 m (landing 1).
- **R1707 rivers in.** A coarse cell outside the window whose receiver's segment crosses the window's square (Liang and Barsky's clipping) brings in its basin: the present climate's runoff of each season summed down the chain's receivers (`upstreamOf`) as the river's flow, and, for the erosion, whose discharge goes with drainage area at one rain, the area that would shed the basin's year of rain at the window's rain [derived]. It enters at the edge cell its segment crosses: its area is added there in the erosion's area gather (the `dep` word, which a window does not use) and its water in the hydrology's gathers (64-bit words, R1709).
- **R1708 the rain.** The planet's rain at the place already holds the orographic rain of its 12 km relief, so the island's orographic theory (Smith and Barstad, R487) is run on the window's relief below the planet's own surface (the land's height less the remap's), with the planet's mean rain of the season as its background; each season's rain is then the planet's remapped field times the theory's field over its mean, rescaled to the planet's mean (conservative to float32). The theory is linear in the heights and the background, so a relief whose total passes the transform's words is reckoned at a power of two of it with its background [derived]. The theory filters out scales under its cloud delays times the wind (12 to 32 km), so at 75 m the window's rain is the planet's gradient with little of its own relief in it: seen in every rain map.
- **R1709 the words a window needs.** The island's stages were sized to Bornholm: heights under 340 m in the upstream's blur and under 1,024 m in the hydrology, flows under 4.3 m3/s, a rain transform for a mean height of 490 m, snow years for 3,000 mm a year. A window's kernels are generated from the same sources in wider formats [design]: the upstream's heights Q16 m (blur offset 8 km, so a sea floor to 8 km deep and heights to 20 km); the hydrology's heights Q15.17 m (under 8,192 m) and flows Q16.16 m3/s (bankfull under 65,536, the mean under 4,369), every shift and constant that followed from the island's Q12.20 and Q6.26 derived from the format, and the square root of a flow Q20 in place of Q28; the snow years' sums of rain shifted down by the bits a wetter place needs (their ratio is the snow's share); the rain as R1708.
- **R1703 the till's cap.** The hydrology's transmissivity word (four faces of 2^32 / 2^13) holds meltwater sand to about 40 m over granite; a window's till is capped at 30 m [design: a format's bound].
- **R1704 the cloud delays** from each season's freezing level, z_f = the sea-level air's warmth over the lapse rate, in the theory's weight e^(-z_f / H_w) (R1320 eq. 10), where the island took the soundings' [derived].
- **R1710 the frame**, **R1711 the planet's stages** (the chain's and the ice cycle's settings, above), **R1712 the uplift's iteration** (R1702's tolerance), **R1713 the sky** (`skyAt`: the island's formula at another latitude; Earth's tilt 23.44 against the planet's 23.4: gap).
- **R1705 the landings.** A land cell of tier 0 off the poles whose window (the coarse cells within half the window and half a cell of it along both axes) holds the sea, ground over 1,000 m, a river whose mean flow now is at least 5 m3/s and a mean year of rain over its land of at least 500 mm, and no ice now (the island's stages have no glacier); ranked by the highest ground in the window, no two within 5 cells [design: the operator's picture of mountains, valleys and rivers grading to a coast, put as measures, not a biome]. Seed 1 (the planet of the sources at 2026-10-19 17:10): 109,830 land cells; with the sea 7,931; and over 1 km 1,946; and a river 734; and the rain 672; and no ice 508.

## What was checked

`window.test.ts`, each case alone:

| case | what it states | measured |
|---|---|---|
| the remap keeps the coarse mean | a random field's window mean is its overlap-weighted coarse mean; a constant is itself; the box is a coarse cell wide | to 1e-3 of a 1,000 m range; to 1e-4 |
| a coastal landing's window | on a staged planet (a coast, a 2 km ridge 25 km inland), the first landing's window has over a tenth of its cells sea and over a tenth land; its mean height is the coarse mean within 2% of the land's mean times its share; each season's rain mean is the coarse mean to 1e-4 | 454.13 against 451.91 m; runs' land means 15.3, 1847, 1247, 1264 against 1265 m |
| rivers from the coarse network come in at the edge | at least one inflow, on an edge cell of land, whose cell's mean flow holds the river's | (35, 255): 125 km2, 4.3 m3/s, the cell 4.3 |
| the latitude moves the sun | skyAt(55.1) is sunAt word for word; the noon sun of midsummer stands 90 degrees less the latitude plus the declination to 1e-9; 70 N's day is over 4 hours longer than 20 N's; the climate stage's winter light at 60 N is under half the equator's; the island's place gives the island's words | 9.81 and 0.69 MJ/m2 a day |
| a staged window is the same bytes twice, pinned | two windows of one place have one Bun.hash of `windowBytes`, which is pinned | 64d8306f54100bd |
| seed 1's window at its first landing | the same twice, and pinned with its planet's hash (skipped, saying so, where the store has no planet made by the sources as they are) | planet 59280bbfdd111472, window a706caeaf5b5f4a7 |

The island's goldens (the Bornholm path), each file alone: `upstream.test.ts` 4 pass, `rain.test.ts` 9, `climate.test.ts` 5, `water.test.ts` 3, `ground.test.ts` 4, `scenery.test.ts` 7, `terrain/island.test.ts` 2, `sim/world.test.ts` 1. The second adapter was not available (Apple M3 Pro).

## The windows of seed 1 (`bun scripts/globe-window.ts --seed 1 --windows 3`, maps in `/tmp/globe-window/1/landing-{1,2,3}/`)

| | landing 1 | landing 2 | landing 3 |
|---|---|---|---|
| place | 42.37 N 72.25 W | 16.26 S 6.15 W | 33.57 N 89.47 E |
| coarse: summit, river, rain, air | 4,134 m, 39.8 m3/s, 2,761 mm, 9.5 C | 3,745 m, 33.2 m3/s, 1,497 mm, 25.1 C | 3,676 m, 90.3 m3/s, 9,326 mm, 18.2 C; iced at the maximum |
| mean height, window against coarse | 1,665 against 1,658 m | 1,831 against 1,832 m | 1,559 against 1,539 m |
| land, highest | 90%, 7,313 m | 98%, 6,017 m | 97%, 5,740 m |
| slope, median / 90th percentile | 49 / 73 degrees | 50 / 73 | 41 / 70 |
| lakes; cells of river over 0.5 m3/s; biggest flow | 29; 761; 51 m3/s | 34; 926; 43 m3/s | 37; 1,204; 96 m3/s |
| channel share of the dry land; marsh; bare; tree | 97%; 69%; 30%; 1.4% | 96%; 54%; 32%; 12% | 94%; 74%; 23%; 2.5% |

What they look like, plainly: **mountains and valleys, yes; rivers and lakes grading to a coast, partly; a landscape the operator would call beautiful, no.** Each window is a range cut by long parallel valleys running down to the sea in its corner, with rivers in them, lakes strung along them where the valleys are closed, and a drowned shore; the rock shows granite in the valley floors under a sandstone cover on the ridges. What is wrong:

- the relief is far too much and too smooth: peaks of 5.7 to 7.3 km on coarse cells of 3.7 to 4.1 km, median slopes of 41 to 50 degrees, broad rounded ridges 1 to 3 km apart (gap 1);
- a ridge stands along the window's edge, where the closed boundary makes a divide (gap 3);
- nearly every cell is a channel and the water table stands at the ground in all of them, so the cover reads as marsh with trees only along the rivers (gap 2);
- the rain is the planet's smooth gradient across the window (R1708);
- the coast is the remap's smooth contour, with no bay or headland under 12 km (the table).

## Gaps (open)

1. **No law limits the slope.** The island's erosion is stream power with n = 1 and linear creep; at the uplift that holds a coastal window to a planet's mean of 1.5 to 1.9 km (the outlets and the sea holding its base at 0), granite's K (7.1e-8) gives slopes of U / (K sqrt(A)): over 80 degrees in a headwater cell. Real ranges are held near 30 to 40 degrees by landsliding at a threshold slope, and the planet's own relief law (Montgomery and Brandon, R1689) says a 10 km window holds at most 1.5 km of relief. A threshold hillslope law (nonlinear creep to a critical slope) in the island's erosion is the fix; it is a law the island did not need (its relief was 160 m) and was not added. The run time of three response times (2.6e8 years on granite) lets creep round the ridges over 2 to 3 km.
2. **Every channel holds the water table.** The channel head law (a S^2 = C, C = 25 m, Bornholm's inversion) starts a channel in nearly every cell of a slope over about 30 degrees, and the hydrology fixes the head of every channel at its stage, a dry one at its bed: the water table is at the ground in 97% of the land (measured: the median depth is 0 in channel cells and 15 m elsewhere on landing 1), so the ground reads marsh. A channel should hold the head only where groundwater comes out into it (a drain, MODFLOW's DRN, not a fixed head): a change of the island's hydrology law, not made here. Soil is a median 6 m thick on these slopes (the till's 6 m, gap 6).
3. **The edge is a divide.** Water crosses the window's edge only at the outlets the coarse network gives; the rest is a closed boundary, so a ridge forms along it. The window does not know its neighbours' valleys under 12 km; a boundary from a neighbouring window's own steady state would be the fix.
4. **The windows are not where a player would land first:** the planet's own gaps carry in (the atmosphere's dry interiors and 9,000 mm windward coasts: 21 of seed 1's 109,830 land cells were landings by the measures before the river was the present climate's).
5. **The chain's receivers are the pre-ice bed's**, the river's flow the present climate's runoff down them [gap: the routing is not redone on the bed the ice left].
6. **Bornholm's numbers kept** for the cloud, humidity, wet hours, wind's speed, roses' shapes, fog, cold pools, day-to-day weather, joints, scour, the ice's adverse slope, the lake threshold, the channel head, the bankfull ratio and the till of an unglaciated place (the table).
7. **The planet's present ice** keeps windows off it (the island's stages have no glacier); a window cannot be on a glacier.
8. **The sky's tilt** is Earth's 23.44 degrees, the planet's 23.4.
9. **The play page is not changed**: `windowIslandOf` makes a Ground under a seed, but the sim's sky (`sky.ts` at 55.1 N), its weather calendar (climate.ts SEASONS' storm shares), `SEA_WIND` and the renderer's copy of the sun (`live.js`) are the island's; the world does not store its place.
10. **The pinned hashes are one engine's and one planet's**: the staged one stands alone; seed 1's follows the planet store, rebuilt whenever the globe's sources change (the store's key).

## Progress log (for a resume)

- 2026-10-19 17:00: read the plan, the globe notes, the handoff rules and the napkin; found the island stages' word ranges a window breaks (above). Wrote the planet part and the script's stages; built seed 1's planet (chain 146 s, climate0 48 s, ice 171 s with the present ice kept, climate1 33 s).
- 17:30 to 18:15: the upstream, hydrology, climate (snow shift, place), rain (seasons) and sky made format- and place-aware, the Bornholm WGSL text checked unchanged against the snapshot; `generateWindow`; `windowOf` with the remap, the outlets, the inflow, the uplift's inversion and iteration, the rock by depth, the rain's scaling; the landings; `world.ts windowIslandOf`; the tests (six cases, each run alone and passing); the island's stage tests run file by file and passing; maps of seed 1's top three landings. A first try held the whole map edge at the planet's surface: rims of walls and plateaus at the outlets' heights, replaced by the outlets (R1706).
- Then: seed 1's planet rebuilt on the committed tectonics and erosion (the store's key changed), landings and windows rerun, seed 1's pin re-recorded (see the end of this log).
