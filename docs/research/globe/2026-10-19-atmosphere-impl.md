# The atmosphere on the sphere: what was built (plan Unit 4, with the minimum of Unit 5)

Working document, 2026-10-19. Code: `src/gpu/globe/atmosphere.ts` (host: laws, tables, geometry, twins, driver), `src/gpu/wgsl/globe-atmosphere.ts` (kernels), `src/gpu/globe/synthetic.ts` (test planets), `src/gpu/globe/atmosphere.test.ts` (run it by groups of cases: `bun test ./src/gpu/globe/atmosphere.test.ts -t "<name>" --timeout 280000`; the whole file takes about 5 minutes since the planets with land make three marches), `scripts/globe-climate-maps.ts` (the viewer). Laws chosen in `2026-10-19-atmosphere.md` (R1430 to R1449) and `2026-10-19-ocean.md` (R1450 to R1459); the grid is `2026-10-19-grid.md` (R1400 to R1404), reused and not edited. This note's own references are **R1530 to R1559**, listed in section 8: each is a law or a decision of the implementation with its source and tag. Tags as before: [cited] [derived] [design] [gap] [UNVERIFIED] [INFERENCE] [analogue]. No source was read for this unit beyond the notes above; where a number is a source's it is cited by the note's R-number.

**Fixes of the same day (references R1600 to R1629, section 11):** the rain, the poles and the land's evaporation were reworked after the first build. Sections 4 and 9 below carry the rows and gaps as they stand now; sections 5 to 7 and the numbers in them (D 2.07, the 12 K contrast, the 0.70 mm/day, the dry belt of exactly zero) describe the first build and are kept as its record; section 11 gives each fix, its source, the numbers before and after, and what is still open.

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
| temperature at sea level | Budyko-Sellers: C dT/dt = Q (1 - alpha) - (A + B T) + D d/dx[(1 - x^2) dT/dx], A 203.3, B 2.09, ice line -10 C, heat capacities 0.16 B and 4.7 B years; the co-albedo is Earth's observed a(x) = 0.681 - 0.202 P2(x) with the ice taken out, falling by a step of 0.32 (equator) to 0.15 (ice line) where the column's temperature crosses -10 C; D from the radius law, 1.13 W/m2/K at 2,000 km | cited (R1437, R1432: R1605, R1606); the two columns per band, the ramp of the ice line (4 K wide), the step's linear fall in x and the lag of the albedo by a step are [design]; the radius law's exponent is read off a figure [UNVERIFIED digitization] |
| temperature with height | 6.5 K/km (R494) | cited; tested to -6.50 K/km across a plateau |
| temperature of a coast and an interior | the air adjusts to the ground below in rho c_p H / h = 0.93 days, carried by the wind | [INFERENCE] (the ocean note: h, H and the form are not from a read source) |
| zonal circulation's cells | Held-Hou equal-area edge, the eddy limit scaled as (Omega a)^(-1/2), the smaller of the two | Held-Hou derived from R1433 (tested: 28.8 degrees for Earth, 59.4 for the planet, the note's numbers); the eddy scaling [INFERENCE] |
| the polar front | half the arc from the Hadley edge to the pole | [design], [gap] |
| the wind | lobes of sin over each band, the torque law fixing the trades' from the westerlies' with the polar easterlies at half the trades', the whole pattern shifted by the season's latitude of greatest heat; scalar peak 12.7 m/s; vector mean by the wrapped normal's resultant length | torque law cited in words (R1431), integral derived; the rest [design]; 12.7 m/s is Earth's 0.25 Pa stress (R1440) at C_D 1.3e-3 [analogue, UNVERIFIED C_D] |
| the meridional wind | Ekman turning v = r f u / (f^2 + f_min^2), r = C_D |u| / 1 km | derived (R1451's balance used in the air); f_min at 5 degrees [design] |
| blocking | the upslope part of the wind is turned along the contour by 1 - Fr, Fr = U / (N_m z), z the rise over four cells | [design] (Smith's regimes named, not read); N_m 0.005 cited (R1320) |
| saturation | Tetens e_s = 0.6108 exp(17.27 T / (T + 237.3)) kPa; column = 5,417 e_s / T mm (e_s H_w / R_v T) | cited (R221, R1436), the column derived; 7.3% per K at 0 C, 6.3% at 20 C, tested |
| rain | the moist layer's vapour above saturation condenses into cloud water, delayed by the rain stage's two linear reservoirs (cold 1,000 s, warm 2,700 s, fall 1,000 s, snow 2,500 s, by the ice share exp(-z_f / H_w)); vapour above 0.7 of saturation relaxes to it with a time scale of 2 h and falls out at once | the delays cited (R1320 to R1323); the adjustment is the simplified Betts-Miller scheme (R1600: Frierson 2007, read; Betts and Miller 1986, named); the budget scheme [design]; not Smith and Barstad, see section 5 |
| evaporation, sea | C_E U (q_sat - q) / H_w with U the zonal table's scalar wind (floor 2 m/s), C_E 1.2e-3 | the bulk law's form; the mean of the speed and not the speed of the mean (R1601) [derived]; C_E [UNVERIFIED] |
| evaporation, land | alpha Delta / (Delta + gamma) Rn / lambda (alpha 1.26) times the soil's efficiency from a bucket of 150 mm full to 0.75 and overflowing; Rn from FAO-56's shortwave, albedo 0.23 and long wave with 0.58 of the day's sun | Priestley and Taylor (R1602, the 1.26 as quoted), FAO-56 (R1603, R221), Manabe's bucket (R1604, constants from the AMIP model records); the sun share [analogue, UNVERIFIED]; the bucket is solved on the host by rounds [design] |
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
| R1600 to R1606 | the fixes of section 11: the convective adjustment, the scalar wind of the bulk law, Priestley and Taylor, FAO-56's net radiation, Manabe's bucket, the co-albedo law, D by the radius; R1607 to R1629 free |

## 9. Gaps: what looks wrong and why (a failing check is a gap, not a retune)

1. **Rain is 59% of its target and the water stays in the air twice as long as on Earth.** After the adjustment (section 11) the ocean planet rains 1.66 mm/day against a target of 2.83 (Earth's 2.69 scaled to the planet's 17.6 C), the layer holds 28.7 mm (Earth 24.6) and the residence is 17.3 days (Earth 8, and 45 before). Cause: the evaporation that feeds the rain is bulk, proportional to the surface wind, and the circulation's lobes give an area mean scalar wind of 3.5 m/s (floor 2 m/s) where Earth's ocean mean is about 7 [the Earth value recalled, not read]: the amplitude of the lobes is the torque law's with the planet's wide Hadley cell and 0.25 Pa at its peak, a [design] choice of the first build; C_E 1.2e-3 is [UNVERIFIED]. Left as it is.
2. **The dry belt is a strip, and the tropical peak is a little under the storm track's.** The zonal rain by 2 degrees now has its minimum of 0.27 mm/day at 40 to 42 degrees and a strip of exactly 0.00 at 56 to 60 (the Hadley edge, 53.6, where the mean surface wind diverges by 4e-6 /s, more than the evaporation can supply: a subsidence strip 4 degrees wide; Earth's is filled by transients, not modelled); the ITCZ is 3.55 mm/day at 5 degrees against 6.2 at the polar front (Earth 6.1 and 3.2, validation F1). The ascent at the equator is the Ekman layer's convergence plus the adjustment; deep convection's trigger (a lifted parcel's instability, which a one-box layer cannot give) is not modelled: the adjustment acts at any temperature.
3. **The poles are cooler but not frozen.** With the co-albedo's latitude and temperature law (R1605) and D from the radius law (R1606, 1.13 W/m2/K) the ocean planet's equator-to-pole contrast is 26.5 K between the 10 degree bands (Earth about 40; the cited scaling gives 28.8 K between the second mode's ends), the poles are 0.3 C on the annual mean (9.2 before), the coldest polar season -2.1 C, sea ice forms (thickest cell 0.25 m, 2% of the sea poleward of 46 degrees in spring and autumn) and snow is 10% of the polar precipitation; with 30% land the polar winter is -11.7 C. No permanent ice at sea level (the ice line is -10 C): mountain glaciers need the lapse (a 2 km crest at 70 degrees is at the ice line), and an ice sheet needs a dimmer sun (the feedback is on: a 10% dimmer sun cools the planet 13.9 K against 11.5 K without it, and at 0.8 of the solar constant the global mean is -23 C). The radius law is read from one figure of a GCM study at Earth's rotation and with gravity changing with the radius, ours does not [gap]; this planet is 2.2 K warmer than Earth at the same latitudes because North's A and B were fitted with Q 335 W/m2 and the planet takes S0 1366 [gap, the earlier build's choice].
4. **Land gives back a quarter to a third of its rain, against 65% (the rivers' 35%) on Earth.** On the earth-like planet (28.2% land) the land's rain is 1.60 mm/day, evaporation 0.52 (32%), runoff 1.05 (66%); the potential is 2.95. The tropics return 40 to 46%, the dry mid-latitude and subtropical land 16 to 28%, the interiors in summer nothing: a soil the air never rains on has no water to give (rain 0 and evaporation 0 where the summer air over 30 C land holds 0.3 of saturation, under the adjustment's 0.7, and no wind lifts it), so continental summers are dry and the year's rain is the winter's and the coast's. The recycling ratio proper (the share of land rain that was land evaporation, about 40% on Earth by the brief) needs a tracer and is not computed; the evaporation share is not that number and is below the brief's 40% as well. Causes [INFERENCE]: the weak winds, the zonal-mean flow that brings marine air only along latitude circles, and a bucket that overflows in a wet season (150 mm against a monsoon's rain).
5. **Mid-latitude air upwind of a coast** sits at 0.7 of saturation where the adjustment acts (the raining column's median is 0.703), no longer 0.4; the strip of subsidence at the Hadley edge (gap 2) is what is left of the first build's dry belt, and a ridge standing in it (the ridge planet's, 56 to 64 degrees) has no rain upwind of it. The cause the first build did not separate is the surface divergence of the prescribed wind at the cell's edge [derived: v turns from equatorward to poleward there].
6. **Ocean: no gyres or western boundary current, no Ekman upwelling** (the ocean note's gap 4 and 5: validation F7's cold west-coast deserts will fail), no sea-ice insulation or latent heat (the ice's surface temperature runs below freezing in the column), no overturning. The coastal effect is the air's adjustment only.
7. **The wind is the zonal mean plus blocking.** No stationary waves, no monsoon, no sea-breeze; the surface wind's divergence is prescribed, not found. The wind pattern is shifted off the equator by the season's heat maximum (the research note's choice, [gap]: the lag of the surface) and clamped to 34 degrees.
8. **The polar front's latitude** is half the arc to the pole (no source read gives it).
9. **Latent heat does not warm the air**, and the moist lapse rate is the dry environment's 6.5 K/km (the note's 5.3 to 6.7 K/km range): a lifted parcel does not warm by what it rains out.
10. **No snowpack**: each season's precipitation, snow included, goes to the soil at once (the bucket holds the winter's water to spring, the only memory between seasons now); spring melt is not delayed and glaciers are not stored (Unit 6).
11. **The cube's face edges.** With the first edge winds (the mean of two cells' winds, Q10) the rain maps showed faint lines along the equatorial faces' edges, the grid's own first-order strip (grid note, gap 1). The edge winds of the zonal table at each edge's midpoint (R1546) and Q16 winds removed them; a faint ripple remains on the polar fronts' edges, where cells' latitudes differ from a parallel by up to half a cell. The polar face's rain is a clean circle.
12. **Tier 0 only.** The slope comes from the grid's whole-tier tables (grid note, gap 2); the geometry and kernels are tier-agnostic (the height must have 6 * fn * fn cells), but a deeper tier needs the tables of Unit 8.
13. **The pinned hash is one engine's.** The tables are float64 rounded to integers (the margins: the least distance of a latitude fraction, a cell's or a link's midpoint's, from a rounding tie is 1.7e-5 of a word, so a last-place difference in `Math.atan2` or `Math.asin` would not flip one); the integer exponential builds the saturation table.

## 10. Using it, and looking at it

```
bun scripts/globe-climate-maps.ts --planet ridge --out /tmp/globe-climate/ridge       # a synthetic planet
bun scripts/globe-climate-maps.ts --height heights.f32 --sea 0 --out /tmp/globe-climate/real   # raw float32, cell-id order
```

writes `height`, and for each season `temperature`, `rain`, `snow`, `wind` (arrows, 4 px a m/s), `insolation`, `sst` (sea ice white), `vapour`, plus `rain-annual`, `temperature-annual`, `evaporation-annual`, `runoff-annual`, `potential-annual` and `evaporation-share-annual` as 720 by 360 equirectangular PNGs, and prints the zonal means, the circulation's numbers, the energy balance's convergence, the global water budget, the poles' contrast, ice and snow and the land's water (`--planet earth` is the four-continent planet; `--soil-rounds` and `--solar` are options). Maps of the synthetic planets are under `/tmp/globe-climate/{ocean,ridge,continents,west,earth}`.

For the real terrain (Unit 2 and 3) call `climateGpu(await theGpu(), tierGrid(0), height, { seaLevel })` with the height in metres in cell-id order; a sea level of an ice age is `seaLevel`. A march of the four seasons is about 12 s on this Mac (30 days of spin-up each; `opts.spinDays` and `opts.windowDays` change it), and a planet with land makes three of them (`opts.soilRounds`, section 11): about 35 s; the geometry (0.6 s) and the grid's tables (4 s, for the slope) are built once a process.

## 11. The fixes of the first build's gaps (R1600 to R1606)

Code: the same files, plus `solveSoil` and `landTables` in `atmosphere.ts`, the `EP` and `BETA` fields and the land tables in the kernels, `earthlikePlanet` in `synthetic.ts`. Tests: the cases named "convective adjustment", "Priestley and Taylor", "soil bucket", "land evaporation", "soil rounds", "earth-like planet", "water cycle", "poles", "albedo" and the two new "energy balance" cases (the whole file takes about 5 minutes: run it by groups with `-t`). Sources read this time: Frierson (2007, J. Atmos. Sci. 64: 1959, secs. 2 and 3, from the NYU copy); Kaspi and Showman (2015, ApJ 804: 60, the whole text and figures 8 and 20 as images); North, Cahalan and Coakley (1981, R1437, from the NTNU copy: eqs. 13 to 19, the albedo parameterization section and the symbol list); the GFDL, CSU and SUNYA model records of the AMIP documentation for Manabe's bucket. Not read: Betts and Miller (1986), Priestley and Taylor (1972), Manabe (1969), Budyko (1974), Sundqvist (1989; only its conference record was found, not read), Held and Soden (2006) beyond R1436's passage.

### The rain (R1600, R1601)

The first build condensed only what passed saturation, so an unsaturated mean state never rained. Frierson's study finds that the same large-scale condensation alone "leaves much of the tropics and subtropics without precipitation at any given instant" and fixes it with the simplified Betts-Miller scheme: the humidity relaxes toward 70% of saturation with a time scale of 2 h wherever convection acts. Kaspi and Showman run the same two numbers. Here the layer's vapour above 0.7 of its saturation relaxes to it by dt / 7,200 s a step and falls out at once (the rain of the step); the saturation condensation and the rain stage's delays stay for the orographic rain. The scheme acts at any temperature (a one-box layer has no lifted parcel to test) [gap]. The evaporation now reads the zonal table's scalar wind, not the prevailing wind (the vector mean, 0.78, 0.53 and 0.29 of the scalar in the trades, westerlies and polar easterlies): the bulk law is a mean of a speed.

**The target.** The global mean is set by the atmosphere's energy budget, L P equal to its net radiative cooling (78 W/m2 for Earth's 2.69 mm/day), not by the planet's size: the planet has Earth's solar constant and the same A + B T, so it keeps Earth's 2.69 mm/day, scaled by the energy constraint's 2% a kelvin of its own mean temperature (the part of Clausius-Clapeyron's 7% that the budget allows, the 2% recalled from Held and Soden's paper, R1436 read only for the 7% [UNVERIFIED]): 2.69 (1 + 0.02 (T - 14.97)) is 2.83 mm/day at the planet's 17.6 C. The test prints it.

**Result.** Ocean planet, annual global means: rain 1.66 mm/day (0.70 before; 59% of the target), layer 28.7 mm (31.6), residence 17.3 days (45.4; Earth 8). A raining column holds 0.703 of saturation at the median (6th percentile 0.701, 94th 0.719), the excess over 0.7 being what 2 h rains out. By 2 degrees from the equator, mm/day: 2.25 3.09 3.55 (ITCZ peak at 5 degrees) 3.52 3.30 3.07 2.84 2.61 2.36 2.09 1.83 1.57 1.34 1.12 0.93 0.77 0.64 0.54 0.45 0.38 0.31 0.27 (minimum, 40 to 42) 0.28 0.34 0.42 0.47 0.35 0.09 0.00 0.00 (56 to 60, the strip at the Hadley edge) 0.49 2.99 5.83 6.19 (storm track, 68 to 70) 4.47 1.74 0.41 and 0.2 to 0.4 to the pole. The shortfall is the wind (gap 1): E is bulk and the area mean scalar wind is 3.5 m/s.

### The poles (R1605, R1606)

**The albedo.** The first build's co-albedo was 0.70 or 0.38 and nothing else. R1437 gives the observed annual zonal co-albedo, a(x) = 0.681 - 0.202 P2(x) (eq. 18), which with D 0.649 and the observed temperature closes the budget (H2 = -0.500, T2 = -28.0; the test reproduces T0 15.08 against 14.97 and T2 -27.63 against -28.0 for Earth's radius and Q 335). That co-albedo carries the ice Earth has, so the ice is taken out of it (the observed temperature's ice share, 0.15 more co-albedo at the poles) and put back by the column's own temperature: the co-albedo falls by a step where the surface passes the -10 C ice line, 0.32 where the sun is high (Budyko's albedos, North's co-albedos 0.70 and 0.38) and 0.15 at the ice line (Coakley 1979 as R1437 quotes it: the ice-free surface reflects more at a large zenith angle, so the step is smaller at high latitude, Lian and Cess 1977), at x_s 0.95 now; the fall between them is linear in x [design]. Earth's observed temperature gives back Earth's observed co-albedo exactly (tested), so the surface term is fitted to Earth and the feedback is what the planet's own temperature does with it. The feedback has the right sign and size: a 10% dimmer sun cools the planet 13.9 K with it and 11.5 K held at the ice-free albedo; global mean temperature rises monotonically with the solar constant, from -23.1 C at 0.80 to 28.8 C at 1.10 (tested).

**D.** The first build scaled D with the radius (2.07 W/m2/K, a gap). T2 = H2 / (B + 6 D) makes D a measure of the contrast, and Kaspi and Showman's figure 20b gives the equator-to-pole surface temperature difference of a rocky planet at Earth's density and rotation against its radius: 22.5, 28.0, 33.0, 39.3, 46.0, 49.2 K at 1,000, 2,000, 3,000, 5,000, 8,000 and 10,000 km as I read the points from the figure image (22.5 K (a / 1,000 km)^0.34 to within 1 K; 42.7 K at Earth's radius: [UNVERIFIED digitization]). The contrast over Earth's is (a / a_Earth)^0.34, 0.674 at 2,000 km, so (B + 6 D) = (B + 6 D_Earth) / 0.674 and D = 1.13 W/m2/K (tested: T2's ratio 0.674). Their planets' gravity changes with the radius, this one's does not [gap].

| D (W/m2/K) | equator | 80 to 90 | contrast | coldest pole season |
|---|---|---|---|---|
| 0.649 (Earth's, with the new albedo) | 31.2 C | -8.5 C | 39.7 K | -11.2 C |
| 1.13 (the radius law) | 26.8 | 0.2 | 26.6 | -2.5 |
| 2.07 (the first build, flat albedo) | 23.2 | 6.9 | 16.3 | 4.4 |

(annual means of the energy balance alone, no land; the maps' 26.5 K is the same with the GPU's integer tables.) Earth's D with the cited albedo gives Earth's contrast, 39.7 K against "about 40", which is the check that the albedo law is the right one; the planet's own is 26.5 K. Sea ice forms where the ocean column passes -1.8 C (Stefan's law: thickest cell 0.25 m, covering 2% of the sea poleward of 46 degrees in spring and autumn) and snow is 10% of the precipitation at 70 to 90 degrees; there is no permanent ice at sea level. With 30% land the polar winter is -11.7 C and the land's winter air is below the ice line, so the polar snow (4 to 10% of the precipitation at 70 to 90 degrees on the three maps) makes an ice sheet only if the sun dims (the feedback test) or the land rises (the lapse): this matters to the ice-age unit, which should expect glaciers on ranges and not caps, and test the response to a dimmer sun or a longer winter first.

### The land's evaporation (R1602 to R1604)

**The potential rate.** Priestley and Taylor: E_p = 1.26 Delta / (Delta + gamma) Rn / lambda, with FAO-56's Delta (4098 e_s / (T + 237.3)^2: 0.145 kPa/K at 20 C, tested), gamma 0.0674 kPa/K, lambda 2.45 MJ/kg and net radiation: Rs = (0.25 + 0.5 n/N) Ra (Angstrom's), Rns = (1 - 0.23) Rs, Rnl = sigma T^4 (0.34 - 0.14 sqrt(e_a)) (1.35 Rs / Rso - 0.35) with Rso = 0.75 Ra; Ra is the cell's daily mean insolation, e_a is 0.7 of saturation (the adjustment holds the air there) and n/N is 0.58, which makes Rs 0.54 of Ra as Earth's global mean surface downward shortwave is of its insolation (184 of 341 W/m2, Trenberth et al. 2009, recalled [analogue, UNVERIFIED]; no cloud field). A cell at 25 C under 400 W/m2 has 4.25 mm/day (the formula in floats 4.25, tested); polar night and a frozen surface have none.

**The bucket.** Manabe's bucket: field capacity 0.15 m, evaporation at the potential rate times beta = W / (0.75 W_c) under three quarters full and 1 above, overflow as runoff, precipitation and snowmelt filling it (the constants as the GFDL, CSU and SUNYA model records in the AMIP documentation state them; the paper not read). A 32 day march cannot fill or empty 150 mm, so the bucket is solved on the host over the year (92 steps a season, to the periodic state), its seasons' efficiencies are handed to the kernel in `BETA`, and the four seasons are marched again with the new rain: the first march has dry soil, `climateGpu` makes three rounds (`soilRounds`), and the last march's evaporation is within 3.4 to 6.3% of the bucket's (2.7% after five rounds on the earth-like planet; the land's E / P moves by 0.01 to 0.03). The bucket gives each season its runoff (the overflow, never negative) and storage (so that rain = evaporation + runoff + storage; the year's storage is nil to 0.01 mm). Winter rain is kept for summer: with all the rain in winter and a hot dry summer, evaporation is 133, 16, 0 and 45 mm by season (tested). A run with land is three times a run of the sea alone (about 35 s against 12 s); `AtmosphereGpu.season` alone has dry soil unless `setSoil` is called.

**Result, the earth-like planet** (four continents, 28.2% land; `earthlikePlanet`): the land's rain 1.60 mm/day, evaporation 0.52 (32% of the rain; 0 before), runoff 66% (all of it before), potential 2.95. By latitude (mm a year, P / E / Ep / R, E over P): 80 to 60 S 353 / 95 / 541 / 258, 0.27; 60 to 40 S 467 / 84 / 777 / 381, 0.18; 40 to 20 S 523 / 84 / 1,122 / 438, 0.16; 20 S to 0 1,186 / 507 / 1,536 / 665, 0.43; 0 to 20 N 1,023 / 469 / 1,546 / 535, 0.46; 20 to 40 N 437 / 121 / 1,220 / 315, 0.28; 40 to 60 N 229 / 47 / 808 / 180, 0.21; 60 to 80 N 340 / 103 / 548 / 237, 0.30 (five rounds). The share is low because the interiors are dry in summer (gap 4).

### Zonal means before and after

Ocean planet (no land; annual, the two hemispheres' bands of the same latitude averaged; first build then now):

| latitude | rain mm/day | evaporation mm/day | temperature C |
|---|---|---|---|
| 80 to 90 | 0.00 -> 0.21 | 0.14 -> 0.25 | 9.2 -> 0.3 |
| 70 to 80 | 1.21 -> 0.71 | 0.02 -> 0.36 | 10.0 -> 1.6 |
| 60 to 70 | 3.00 -> 3.84 | 1.57 -> 2.00 | 11.6 -> 4.7 |
| 50 to 60 | 0.00 -> 0.20 | 1.66 -> 1.72 | 13.3 -> 8.3 |
| 40 to 50 | 0.00 -> 0.32 | 0.58 -> 0.78 | 15.3 -> 12.8 |
| 30 to 40 | 0.00 -> 0.56 | 0.95 -> 1.61 | 17.2 -> 17.5 |
| 20 to 30 | 0.07 -> 1.37 | 0.85 -> 2.29 | 18.9 -> 21.7 |
| 10 to 20 | 0.66 -> 2.60 | 0.37 -> 2.09 | 20.1 -> 24.9 |
| 0 to 10 | 1.72 -> 3.14 | 0.14 -> 1.59 | 20.8 -> 26.8 |

Global: rain 0.70 -> 1.66 mm/day, evaporation 0.71 -> 1.66, layer 31.6 -> 28.7 mm, residence 45.4 -> 17.3 days, equator-to-pole 11.6 -> 26.5 K, poles 9.2 -> 0.3 C.

Earth-like planet (the first build's land evaporation was 0 to 3% of the land's rain; the new one 32%):

| latitude | rain mm/day | evaporation mm/day | temperature C |
|---|---|---|---|
| 80 to 90 | 0.25 -> 0.19 | 0.19 -> 0.19 | 5.7 -> -1.6 |
| 70 to 80 | 1.25 -> 1.58 | 0.58 -> 0.38 | 6.1 -> -0.6 |
| 60 to 70 | 0.09 -> 1.74 | 0.54 -> 1.50 | 7.5 -> 2.4 |
| 50 to 60 | 1.42 -> 1.17 | 0.49 -> 1.71 | 9.6 -> 6.5 |
| 40 to 50 | 1.80 -> 0.32 | 1.48 -> 0.92 | 11.9 -> 10.8 |
| 30 to 40 | 0.69 -> 0.77 | 1.55 -> 1.38 | 13.9 -> 15.7 |
| 20 to 30 | 0.28 -> 1.29 | 0.59 -> 1.73 | 15.6 -> 20.1 |
| 10 to 20 | 0.05 -> 1.53 | 1.16 -> 1.91 | 17.0 -> 23.5 |
| 0 to 10 | 2.78 -> 3.65 | 1.45 -> 2.01 | 17.7 -> 25.3 |

Global: rain 1.06 -> 1.56 mm/day, evaporation 1.06 -> 1.55, layer 22.5 -> 24.7 mm, residence 21.2 -> 15.8 days.

### What the maps show

`/tmp/globe-climate/after/{ocean,earth,continents}` (the PNGs the script writes, new `potential-annual` and `evaporation-share-annual` among them). The rain map of the earth-like planet is zonal: a thin ITCZ line of heavy rain at the equator, drying toward 40 to 55 degrees, a wet band at 60 to 75, and the only longitudinal structure is the continents and the 3 km range on the northern one's west side (a plume of heavy rain behind it on the windward slope, a shadow east of it). The continents' interiors are pale in rain, evaporation and runoff maps: the dryness of the interior is the finding of gap 4. The temperature map is smooth, warm at the equator (25 C), near zero at both poles, cooler over the polar continents and the southern one's interior; land and sea differ by a few kelvin, with a cold wake downwind of each continent. The wrong things: no longitudinal wet or dry belts beyond what land makes (a zonal-mean wind), the interior deserts, a 4 degree dry strip at the Hadley edge, and a polar region that is cool rather than frozen.

### Open

The rain and the recycling are held down by the wind's amplitude (a circulation matter, not the rain's), the interiors by a flow with no ascent and no transients; the polar cold depends on one digitized figure; the recycling ratio is not computed (it needs a tracer); the bucket has no snowpack and no spatial memory (a basin's rivers are the erosion unit's); n/N is a constant, not a cloud field; the convective trigger is absent; the moist lapse rate and latent heating of the air (gap 9) are untouched, since the cited 6.5 K/km already contains the moisture's average effect and the test of it pins that.
