# The atmosphere on the sphere: what was built (plan Unit 4, with the minimum of Unit 5)

Working document, 2026-10-19. Code: `src/gpu/globe/atmosphere.ts` (host: laws, tables, geometry, twins, driver), `src/gpu/wgsl/globe-atmosphere.ts` (kernels), `src/gpu/globe/synthetic.ts` (test planets), `src/gpu/globe/atmosphere.test.ts` (run one case at a time: `bun test ./src/gpu/globe/atmosphere.test.ts -t "<name>" --timeout 280000`; the whole file takes about 70 s), `scripts/globe-climate-maps.ts` (the viewer). Laws chosen in `2026-10-19-atmosphere.md` (R1430 to R1449) and `2026-10-19-ocean.md` (R1450 to R1459); the grid is `2026-10-19-grid.md` (R1400 to R1404), reused and not edited. This note's own references are **R1530 to R1559**, listed in section 8: each is a law or a decision of the implementation with its source and tag. Tags as before: [cited] [derived] [design] [gap] [UNVERIFIED] [INFERENCE] [analogue]. No source was read for this unit beyond the notes above; where a number is a source's it is cited by the note's R-number.

## 1. What goes in and what comes out

`climateGpu(gpu, tierGrid(0), height, planet, opts)` takes a height field in metres in cell-id order (`(face * 256 + Y) * 256 + X`, the grid's faces and axes), a planet (`radius`, `tiltDeg` 23.4, `dayS` 86,400, `solar` 1366, `seaLevel` 0, `gravity` 9.81 [design: decisions of 2026-10-19], and an optional `diffusion` override), and returns four seasons (the game's: spring, summer, autumn, winter, each a quarter of the year centred on an equinox or a solstice, so on the sun's declination averaged over the quarter) of float32 fields per cell:

| field | unit | what it is |
|---|---|---|
| `insolation` | W/m2 | daily mean at the cell's latitude, averaged over the season's orbit [cited law, R1438; derived integral] |
| `temperature` | C | the air near the surface: the air's sea-level temperature less the lapse rate times the height above the sea |
| `seaLevelTemperature` | C | the same before the lapse |
| `windE`, `windN` | m/s | prevailing surface wind (the vector mean), east and north |
| `sst`, `ice` | C, m | the sea surface (the ocean column held at freezing) and the sea ice's thickness (0 on land: `sst` reads 0) |
| `rain`, `snow` | mm of water over the season | `snow` is the part that fell below the rain-snow range; `rain` is all precipitation (snow included) |
| `evaporation`, `runoff` | mm over the season | sea and land evaporation; the land's rain less what it gave back (nothing is stored) |
| `column` | mm | the vapour in the moist layer at the end |

and a `budget` per season (evaporated, rained, held at the window's two ends, in m3 over the planet), the energy balance (`ebm`: zonal land and sea columns and the zonal mean by season, the circulation's centre by season), the circulation (`circulation`: edges and wind lobes), the land mask and the grid geometry. `AtmosphereGpu` is the same thing with the entry points exposed; the test drives them one by one against their twins.

Land is a cell whose height is over `seaLevel`; the height above the sea of a land cell is what the lapse and the slope read; every cell under the sea level is ocean (lakes and drowned basins are sea here).

## 2. The pipeline, per season

1. **Host tables (float64, rounded to the kernels' integers; the tie margin is checked, `geo.margin`).**
   - Insolation by latitude and orbit longitude (R1530).
   - The energy balance on 180 latitude bands with a land and a sea column in each (R1531): the periodic seasonal state (200 years of 96 steps, backward Euler, the diffusion solved implicitly by a tridiagonal elimination) gives each band's land and sea temperature at sea level and the zonal mean, per season.
   - The circulation (R1532 to R1535): the Hadley edge, the polar front, the lobes of the surface wind with the torque law, the Ekman turning, the shift of the whole pattern off the equator by the season's latitude of greatest heat.
   - The column's saturation at every 1/16 K from -120 to 90 C (R1538), from the world's integer exponential.
   - The grid's geometry (R1546): neighbours, each link's length over the cell's area and its normal, each cell's and each link's latitude node.
   - The height's slope (R1537) from the grid's own halo kernel and least-squares gradient (`GlobeGpu`), then to m/m.
2. **`prep` kernel** (one thread a cell): the table winds at the cell's latitude with the blocking taken out, the ground's temperature (the land column's or the sea column's), the sea surface and ice, the lapse term, the evaporation rate, the cloud's two delays, the first state of the run.
3. **`edges` kernel**: the wind through each of a cell's four edges (R1546), as a rate in 1/s.
4. **`step` kernel**, marched at the largest step that keeps a cell's four link fractions under 0.8 in all and under half the shortest cloud delay (500 s, the cap that binds here), for 30 days (spin-up) and then a 2 day window over which rain, evaporation and runoff are summed. One step: upwind advection of vapour, cloud water and falling hydrometeors by the edge winds (R1539), the same for the air's sea-level temperature in its advective form with a relaxation to the ground below (R1543), sea evaporation to the sea surface's saturation and land evaporation to what the previous step's rain left (R1540, R1541), condensation of what passes saturation into cloud water, conversion to hydrometeors and fall (R1542).
5. **`finish` kernel**: the near-surface temperature and the snow share (R1545).

Every entry point has a TypeScript twin and the test compares the kernel's words with the twin's on about 80,000 cells (every 13th and every land cell) for `prep`, `edges`, three consecutive steps (the third with the accumulators) and `finish`: all equal bit for bit. Only integers sit between a buffer read and a buffer write; a product of two words goes through a 64-bit intermediate (`mulShr`, which has an exact BigInt twin).

## 3. Units and scales of the kernels (all [design], sized by the ranges [derived])

| quantity | format | range it holds |
|---|---|---|
| height above the sea | Q6 m | 33,000 km |
| slope | Q16 m/m | |
| temperature | Q16 C | +-32,768 |
| wind (cell, table, edge) | Q16 m/s | 32 m/s in the edge arithmetic |
| insolation | Q8 W/m2 | |
| vapour, cloud water, hydrometeors, a step's rain, the accumulators | Q20 mm | 2,047 mm (the host checks the window's accumulators; the column at 90 C is 1,044 mm) |
| every rate (link, evaporation, conversion, fall, air adjustment) | Q30 1/s | a rate times the step's seconds is the step's fraction, exactly |
| link length over area | Q28 1/m | |
| link normal | Q14 | |
| latitude node fraction | Q16 | nodes every 0.05 degrees (1.7 km) |
| sea ice thickness | Q16 m | |

The winds were Q10 at first and the divergence of a smooth wind (1e-6 /s over a cell) was drowned by the rounding (6e-8 /s); Q16 brought it to 2e-9 to 2e-8 /s.

## 4. Which outputs are cited laws and which are [design]

| output | law | status |
|---|---|---|
| insolation | S0/pi (h0 sin phi sin delta + cos phi cos delta sin h0) with S0 1366 | cited (R1438), integral derived; the annual mean's P2 coefficient is -0.477 as cited (R1437), tested |
| temperature at sea level | Budyko-Sellers: C dT/dt = Q (1 - alpha) - (A + B T) + D d/dx[(1 - x^2) dT/dx], A 203.3, B 2.09, co-albedos 0.70 and 0.38, ice line -10 C, heat capacities 0.16 B and 4.7 B years | cited (R1437); the two columns per band, the ramp of the ice line (4 K wide) and the lag of the albedo by a step are [design]; D scaled with the radius [design, gap] |
| temperature with height | 6.5 K/km (R494) | cited; tested to -6.50 K/km across a plateau |
| temperature of a coast and an interior | the air adjusts to the ground below in rho c_p H / h = 0.93 days, carried by the wind | [INFERENCE] (the ocean note: h, H and the form are not from a read source) |
| zonal circulation's cells | Held-Hou equal-area edge, the eddy limit scaled as (Omega a)^(-1/2), the smaller of the two | Held-Hou derived from R1433 (tested: 28.8 degrees for Earth, 59.4 for the planet, the note's numbers); the eddy scaling [INFERENCE] |
| the polar front | half the arc from the Hadley edge to the pole | [design], [gap] |
| the wind | lobes of sin over each band, the torque law fixing the trades' from the westerlies' with the polar easterlies at half the trades', the whole pattern shifted by the season's latitude of greatest heat; scalar peak 12.7 m/s; vector mean by the wrapped normal's resultant length | torque law cited in words (R1431), integral derived; the rest [design]; 12.7 m/s is Earth's 0.25 Pa stress (R1440) at C_D 1.3e-3 [analogue, UNVERIFIED C_D] |
| the meridional wind | Ekman turning v = r f u / (f^2 + f_min^2), r = C_D |u| / 1 km | derived (R1451's balance used in the air); f_min at 5 degrees [design] |
| blocking | the upslope part of the wind is turned along the contour by 1 - Fr, Fr = U / (N_m z), z the rise over four cells | [design] (Smith's regimes named, not read); N_m 0.005 cited (R1320) |
| saturation | Tetens e_s = 0.6108 exp(17.27 T / (T + 237.3)) kPa; column = 5,417 e_s / T mm (e_s H_w / R_v T) | cited (R221, R1436), the column derived; 7.3% per K at 0 C, 6.3% at 20 C, tested |
| rain | what the moist layer holds above saturation condenses; two linear reservoirs delay it by the rain stage's cloud delays, cold 1,000 s, warm 2,700 s, fall 1,000 s, snow 2,500 s, by the ice share exp(-z_f / H_w) | the delays cited (R1320 to R1323, reused from `terrain/rain.ts`); the budget scheme [design] (the note's recommendation); not Smith and Barstad, see section 5 |
| evaporation | C_E |U| (q_sat - q) / H_w, C_E 1.2e-3 over the sea, the same over land | the form after the bulk law; C_E [UNVERIFIED] |
| land water | evaporation limited by the rain of the step before, nothing stored | [design], after the idea of a bucket at equilibrium [analogue, Manabe's bucket not read] |
| sea ice | h^2 = 2 k (T_f - T) t / (rho L), k 2, rho 1000, L 320 kJ/kg, t the season; T_f -1.8 C | cited (R1411 exercise 4.37), T_f [UNVERIFIED]; the ice has grown the whole season at the mean [design] |
| snow | the share of precipitation that falls as snow ramps from 1 at -1 C to 0 at +1 C of the ground's temperature | [design] |

## 5. What the planet's smallness changes

- **The belts move poleward, not together.** R = g z* Delta_h / (Omega^2 a^2 T0) is 1.88 against Earth's 0.185; the equal-area edge is 59.4 degrees and the eddy-limited edge 53.6, so the cell is 53.6 degrees wide (Earth 30). The polar front, by half the remaining arc, is at 71.8.
- **A degree of latitude is 35 km, so the circulation's structure is a third of the distance and its convergence and divergence three times Earth's** for the same winds. The westerly lobe's first 9 degrees are 320 km. This is why the air in the westerlies upwind of a ridge sits at 40% of saturation (the surface wind diverges from the Hadley edge), and a 2 km ridge at 60 degrees made no rain in a development run (crest temperature -1.9 C, column 9.8 mm against a layer holding 28.6) while a 3 km ridge does.
- **The Rhines scaling is unusable.** The research note suggests the Ferrel cell is 1.22 of Earth's Rhines lengths wide; at this radius that is 65 degrees of latitude, more than the arc there is. It is not used (R1534).
- **The eddy diffusivity scaled with the radius** gives D = 2.07 W/m2/K (Earth 0.649), a pole-to-equator contrast of 12 K on the annual mean in the ocean-planet run. With Earth's D the same code gives 26.4 C at the equator and -2.3 C at 85 degrees, with D = 0.2 -42.9 C there; the choice sets whether the planet has ice (R1531).
- **Continents are not far from the sea.** The air adjusts to the ground below in 560 km at 7 m/s; the box continent in the westerlies is 3,100 km across, so its west coast and its east are different climates and its middle in between (winter 8.5, 2.7 and 0.0 C), but a planet's land is rarely more than 2,500 km from the sea.
- **Time scales are the same as Earth's, distances a third.** A latitude circle at 60 degrees is 6,300 km, 13 days of wind at 5.7 m/s, against a moisture residence of 8 days on Earth; the spin-up of 30 days carries air once and more round the planet.
- **Cells of 12 km against cloud delays of 2,000 to 4,000 s:** a delay at 6 m/s is 12 to 24 km, one or two cells; the lee shadow is resolved to about three cells.
- **Gravity stays 9.81** (the plan's decision): the lapse rate and every law the game holds stay true and the atmosphere is unphysical for a body of 2,000 km.

## 6. Smith and Barstad is not used

The rain stage's transfer needs 64 by 64 cell windows of 12 km (790 km) with a halo from neighbouring faces, a flat-earth approximation (40 km of sagitta over 400 km on R = 2,000 km, small against 100 km hills) and hills over 20 km, which is two cells here. What the research note recommends in its place is used: the budget of the moist layer on the sphere grid, with condensation by the layer passing saturation as the surface rises (which is the upslope law: the rain rate is the wind times the fall of the column's saturation along the path, 100 mm/day for a 3 km rise in 100 km at 6 m/s), the rain stage's cloud delays as two linear reservoirs in space (the note's "alternative in space"), and the ice share from the model's own temperature in place of the Bornholm soundings. The stage's constants `N_m`, `H_w`, `TAU_C_ICE`, `TAU_C_WARM`, `TAU_F_RAIN`, `V_SNOW` and `LAPSE` are imported, not copied. What this gives up: the stratified wave attenuation on small hills, and the delays' effect on a fine scale.

## 7. Measured, on the synthetic planets (the test file prints these)

**Ocean planet** (no land; tilt 23.4; annual mean). Circulation: Hadley edge 53.6, polar front 71.8 degrees; wind peaks 3.8 m/s trades and 12.7 westerlies (scalar); zonal means by 10 degrees: u -2.8 m/s at 20 to 30 degrees, +5.1 at 60 to 70, -0.5 at 80 to 90; v -0.2 at 20 to 30 and +0.55 at 60 to 70: the winds reverse across the Hadley edge (tested, east-west and north-south) and across the front. Rain, mm/day by 2 degrees from the equator: 2.15 2.20 (the **ITCZ peak, 2.2 at 2 to 4 degrees**) 1.95 1.17 1.13 1.08 0.91 0.61 0.36 0.30 0.24 0.10, then **0.00 from 24 to 62 degrees** (the dry belt: it contains the 53.6 degree edge but runs 30 degrees equatorward of it and 8 poleward), then 1.72 2.58 5.82 **6.11 (the storm track's peak, at 68 to 70 degrees)** 3.91 0.93, and 0.00 poleward of 74. The dry belt's rain is under 0.35 of the ITCZ peak (it is 0) and the two hemispheres agree to 5%. Temperature, annual mean: 20.8 C at the equator, 17.2 at 30 to 40, 11.6 at 60 to 70, 9.2 at 80 to 90, falling poleward in every 5 degree band; in each season it falls poleward from 25 degrees (the warmest band follows the sun by a few degrees); the seasonal range at 80 to 90 is 5.4 K on the sea. Global means: rain 0.70 mm/day, evaporation 0.71, vapour in the layer 31.6 mm, residence 45 days.

**Ridge** (north-south, 56 to 64 N, longitude 90, 3,000 m, 300 km wide, in the westerly lobe; summer). Rain mm over the season at 60 N: upwind 0, windward slope (150 to 50 km west of the crest) 365, crest 1,576, lee (50 to 150 km east) 18, far lee 0: **shadow ratio lee over windward 0.050**. The wind is slowed on the windward flank (5.0 against 5.7 m/s in a development run at 50 km out); a 6 km ridge, tested separately, leaves 16% of the wind at its steepest cell. Water over the 2 day window: evaporated 6.802e10 m3, rained 6.655e10, held 1.5989e12 then 1.6003e12: the difference closes to 0.2% of the evaporation. From an unsettled start (1 day of spin-up) 5.9e10 of 6.8e10 is carried on and the budget still closes to half a percent. The column exceeds saturation by at most 4e-5 mm (the temperature's change in one step), and no cell rains more than what arrives and evaporates there. In winter the crest is at -13.4 C and all 2,366 mm of its precipitation is snow; at sea level it is 12.9 C and none is.

**Two continents.** Across the equatorial plateau (200 to 3,000 m, 2,626 cells) the near-surface temperature falls at **-6.50 K/km**, the lapse rate. The polar continent's annual mean is 8.4 C at 74 to 80 degrees and 7.9 at 82 to 90 (the ocean planet's 9.7 and 9.2: the 200 m of land is 1.3 K). Its seasonal swing at 82 to 90 is 8.5 K against the sea's 5.4: **a ratio of 1.6** where a column's cited ratio before any transport is 21.

**West coast** (box continent, 52 to 72 N, longitude 40 to 100; 62 N, 100 km in from each coast): winter 8.5 C west, 2.7 in the middle, 0.0 east; seasonal range 4.6, 16.2 and 21.8 K; rain 2,351, 931 and 550 mm a year. Against the validation note's F3 bands: the winter contrast is 8.5 K (over 8), the range ratio west to east 0.21 (under 0.5), the rain ratio 4.3 (over 2): all three hold; none was tuned for. A cold wake of the ridge or the box extends downwind for the adjustment length (visible in `temperature-winter.png`).

**Tilt.** At tilt 0 the four seasons are the same to the last bit (temperature and rain). At tilt 90 on a planet of land the north pole reads -11.1, 90.4, 32.7, -32.2 C over spring to winter and the south pole 32.7, -32.2, -11.1, 90.4: each pole's year is the other's two seasons on, to 1e-3 K, and the pole is warmer in its summer than the equator. On a planet of sea the mixed layer's lag puts each pole's warmest season after its summer (23.1 in summer, 28.7 in autumn). Tilt 90 is outside the circulation's range (the shift is clamped to 34 degrees) and is a check of the energy balance only.

**Sea.** The sea surface equals the energy balance's ocean column held at -1.8 C to 1.5e-5 K, and the ice follows Stefan's law within rounding (71,000 iced and 36,000 open samples on a planet with a dimmer sun, 1,000 W/m2); on the default planet there is no ice anywhere.

**Land water.** Where nothing is stored, rain on land equals evaporation plus runoff to 1% (tested); evaporation is 0.1 to 2.8% of the rain (see the gaps).

## 8. R-numbers and constants (R1530 to R1559)

Each number below is a law or a decision of this implementation and carries the source and tag of its row in section 4; the tagged constants are in the code beside their use.

| R | what |
|---|---|
| R1530 | daily-mean insolation, circular orbit, seasons centred on an equinox or a solstice, S0 1366 [cited R1438, derived] |
| R1531 | the energy balance's constants A, B, D, co-albedos, ice line, heat capacities [cited R1437]; two columns per band (North and Coakley 1979, [analogue], not read); D = D_Earth R_Earth / a [design, gap]; the ice ramp [design] |
| R1532 | Held-Hou edge by bisection of the equal-area integral; the group R with g, z* 15 km, Delta_h/T0 80/295 [derived from R1433, R1430] |
| R1533 | the eddy-limited edge, 30 degrees (Omega a / (Omega_E a_E))^(-1/2) [INFERENCE] |
| R1534 | the polar front by half the arc to the pole [design, gap]; the Rhines scaling and why it fails here |
| R1535 | wind lobes, torque balance, scalar peak 12.7 m/s, polar share 0.5, resultant lengths 0.78, 0.53, 0.29 from spreads 40, 65, 90 degrees [derived, design, analogue] |
| R1536 | the Ekman turning of the surface wind, C_D 1.3e-3 [UNVERIFIED], depth 1 km [design], f_min at 5 degrees [design] |
| R1537 | terrain blocking by 1 - Fr over a rise of four cells [design] |
| R1538 | the saturation column table, Tetens (R221), 5,417 e_s / T [cited, derived]; held at its running maximum [design] |
| R1539 | the moist layer's budget on the sphere grid: upwind fluxes, saturation condensation, first-order explicit steps [design] |
| R1540 | bulk evaporation, C_E 1.2e-3 [UNVERIFIED], least wind 2 m/s [design] |
| R1541 | land water with nothing stored [design] |
| R1542 | the rain stage's cloud delays and ice share reused, as two linear reservoirs [cited R1320 to R1323] |
| R1543 | the air's adjustment to the ground below, 0.93 days [INFERENCE] |
| R1544 | the sea surface held at -1.8 C [UNVERIFIED]; sea ice by Stefan's law (R1411) |
| R1545 | the snow ramp, -1 to +1 C [design] |
| R1546 | edge winds at the edge's midpoint from the zonal table, and the cells' departures from it averaged [derived: the cells' mean wind across the grid's kinked lines is first order] |
| R1547 | the fixed-point formats of section 3 [design] |
| R1548 | the march's step: link fractions under 0.8, under half the shortest delay [derived] |
| R1549 to R1559 | free |

## 9. Gaps: what looks wrong and why (a failing check is a gap, not a retune)

1. **Rain is a quarter of Earth's and the water stays in the air too long.** Global rain 0.70 mm/day against 2.69, a layer of 31.6 mm against 24.6 and a residence of 45 days against 8 (validation F9 fails). Rain forms only where the layer passes saturation, so a column sitting saturated with no ascent never rains, and the unsaturated mean state never rains at all. A critical relative humidity under 1 (large-scale condensation beginning at 0.7 to 0.8 of saturation, as global models do) or a sub-grid convective term would close it; the assignment's rule (rain where the column exceeds saturation) was kept.
2. **The dry belt is exactly dry, and the ITCZ is weaker than the storm track.** The zonal minimum is 0.00 mm/day across 24 to 62 degrees (Earth's minimum is 0.28 of its ITCZ peak, not 0), and the ITCZ peak is 2.2 mm/day against 6.1 at the polar front (Earth 6.1 at the ITCZ and 3.2 in mid-latitudes, validation F1). The ascent at the equator is the Ekman layer's convergence only (v is about 0.2 m/s toward the equator on each side); deep convection is not modelled.
3. **The planet is warm at the poles.** Annual 9.2 C at 80 to 90 degrees against 20.8 at the equator: no ice and no snow at sea level anywhere on the default planet. Cause: D scaled with the radius (a gap in the research note), and the co-albedo has no latitude dependence (the note gives only the ice-free and ice-covered values; the cited paper's own albedo is remembered to have a latitude term [UNVERIFIED], which this does not). With D = 0.649 the poles are at -2.3 C and with D = 0.2 at -42.9 C; the planet's ice ages (Unit 6) will want this settled.
4. **Land gives back almost nothing.** Land evaporation is the bulk humidity-deficit term only, which vanishes in saturated rain-bearing air, so only 0.1 to 2.8% of land rain returns (runoff 97 to 99.9%); a radiation term (Penman or Priestley-Taylor, the window's `pet` kernel is Penman) is missing, and recycling and river discharge (validation F6, F9) are therefore too low.
5. **Mid-latitude air upwind of a coast is at 40% of saturation** (section 5), so a west coast at 55 to 65 degrees is wet where there is relief. The flat box continent still gets 550 to 2,351 mm a year at 62 degrees; the cause (the air cooling toward colder ground, the front's convergence at the continent's north edge) was not separated [INFERENCE].
6. **Ocean: no gyres or western boundary current, no Ekman upwelling** (the ocean note's gap 4 and 5: validation F7's cold west-coast deserts will fail), no sea-ice insulation or latent heat (the ice's surface temperature runs below freezing in the column), no overturning. The coastal effect is the air's adjustment only.
7. **The wind is the zonal mean plus blocking.** No stationary waves, no monsoon, no sea-breeze; the surface wind's divergence is prescribed, not found. The wind pattern is shifted off the equator by the season's heat maximum (the research note's choice, [gap]: the lag of the surface) and clamped to 34 degrees.
8. **The polar front's latitude** is half the arc to the pole (no source read gives it).
9. **Latent heat does not warm the air**, and the moist lapse rate is the dry environment's 6.5 K/km (the note's 5.3 to 6.7 K/km range): a lifted parcel does not warm by what it rains out.
10. **No soil store or snowpack**: each season is a steady state; spring melt and the autumn rain's storage are not carried.
11. **The cube's face edges.** With the first edge winds (the mean of two cells' winds, Q10) the rain maps showed faint lines along the equatorial faces' edges, the grid's own first-order strip (grid note, gap 1). The edge winds of the zonal table at each edge's midpoint (R1546) and Q16 winds removed them; a faint ripple remains on the polar fronts' edges, where cells' latitudes differ from a parallel by up to half a cell. The polar face's rain is a clean circle.
12. **Tier 0 only.** The slope comes from the grid's whole-tier tables (grid note, gap 2); the geometry and kernels are tier-agnostic (the height must have 6 * fn * fn cells), but a deeper tier needs the tables of Unit 8.
13. **The pinned hash is one engine's.** The tables are float64 rounded to integers (the margins: the least distance of a latitude fraction, a cell's or a link's midpoint's, from a rounding tie is 1.7e-5 of a word, so a last-place difference in `Math.atan2` or `Math.asin` would not flip one); the integer exponential builds the saturation table.

## 10. Using it, and looking at it

```
bun scripts/globe-climate-maps.ts --planet ridge --out /tmp/globe-climate/ridge       # a synthetic planet
bun scripts/globe-climate-maps.ts --height heights.f32 --sea 0 --out /tmp/globe-climate/real   # raw float32, cell-id order
```

writes `height`, and for each season `temperature`, `rain`, `snow`, `wind` (arrows, 4 px a m/s), `insolation`, `sst` (sea ice white), `vapour`, plus `rain-annual`, `temperature-annual`, `evaporation-annual` and `runoff-annual` as 720 by 360 equirectangular PNGs, and prints the zonal means, the circulation's numbers, the energy balance's convergence and the global water budget. Maps of the four synthetic planets are under `/tmp/globe-climate/{ocean,ridge,continents,west}`.

For the real terrain (Unit 2 and 3) call `climateGpu(await theGpu(), tierGrid(0), height, { seaLevel })` with the height in metres in cell-id order; a sea level of an ice age is `seaLevel`. A run is about 12 s on this Mac (four seasons, 30 days of spin-up each; `opts.spinDays` and `opts.windowDays` change it; no timing was taken while the other agent used the GPU, this is read off the tests' own durations); the geometry (0.6 s) and the grid's tables (4 s, for the slope) are built once a process.
