# Rock-and-climate creep, lithology and multiple-flow routing on the regional tiers (measured, not adopted)

Chain: `2026-10-24-terrain-shape-causes.md`, `2026-10-24-band-limited-hold.md`, `2026-10-24-fine-relief-design.md` (lithology V1 and the fracture zones). Branches (not pushed): `globe-fine-relief` e51afd0 (lithology, fracture zones), `globe-rock-creep-d` db61daf (V1 plus rock-and-climate D, the multiple-flow prototype and scratch knobs `NOMADS_LITH`, `NOMADS_FLATD`, `NOMADS_MFD`). Regions: R1 face 0 tx 23 ty 17, R2 coast face 0 tx 20 ty 8, R3 face 3 tx 13 ty 13, 8 by 8 tiles at 75 m, tiers 1 to 3 remade by the variant, tier 4 for 28 steps, tier 5 for 6. The streamed chain, its tests and typecheck were not run: no variant passes the gates.

## Creep diffusivity as a property of rock and rain

Source: Hurst et al. 2013 (JGR Earth Surf. 118), Table 1, 37 site means (16 soil-mantled bedrock, 21 loose substrates), transcribed by hand. ln D fitted to rock class plus ln(rain / 1000 mm) with one exponent. D at 1000 mm in m2 per ka: crystalline 12.07, sediment 10.67, metasediment 5.10, volcanic 1.65, loose 3.16. Rain exponent 0.37 plus or minus 0.27, R2 0.34, residual sd of ln D 1.37. The paper reports no trend of D with lithology or temperature, so this is weak evidence (a gap); the pooled fit was used, rain-modulated from the tier-0 cell's four seasons, clamped to 32 to 3,316 mm, thickness weighted over the top 500 m like K. Planet land median D 4.3 m2 per ka (the old constant 3.98), p5 to p95 1.4 to 18. The creep link coefficient is the link geometry times the mean of the two cells' D (conservative). With flat D and no lithology the new code reproduces the baseline (slope .159 against .160).

Renewal check (R1): relief median 648 m over uplift 25 m per My gives a renewal time of 26 My; sqrt(D x 266 My) is 952 m against sqrt(D x tau) 297 m. Measured instead of argued: R1 rerun with 128 My more and with the same 266 My in steps of at most 3.25 My agrees with the schedule within noise (slope .249, .263, .265; 1D band slope -5.70 in all; lock windows 9, 9, 10). The final state is an attractor of the law; no age or step fix was applied.

## Statistics (baseline / lithology V1 / V1 with rock-and-climate D)

| | R1 | R2 coast | R3 |
|---|---|---|---|
| median slope | .289 / .233 / .249 | .243 / .158 / .119 | .318 / .303 / .301 |
| land p99 (m) | 4887 / 4761 / 4785 | 2019 / 1963 / 1949 | 4867 / 4775 / 4757 |
| tier-0 box error p99 (m) | .13 / .18 / .18 | .02 / .03 / .02 | .17 / .21 / .19 |
| axis-locked windows (uniform 4 in R1, 18 in R3) | 12 of 24 / 8 of 20 / 8 of 21 | none | 35 of 104 / 25 of 109 / 26 of 103 |
| ridge peak ratio | 4.19 / 3.45 / 3.69 | none | 3.72 / 3.37 / 3.40 |
| coast box dimension | 1.019 / 1.091 / 1.081 | .991 / 1.024 / .990 | 1.085 / 1.121 / 1.106 |
| river straight share, 30+ cells | .754 / .790 / .762 | .628 / .712 / .875 | .772 / .755 / .687 |
| 1D slope 150 m to 2 km | -9.16 / -8.80 / -5.70 | -8.0 / -6.55 / -7.18 | -8.2 / -8.5 / -3.59 |
| 1D slope 2 to 19 km | -3.55 / -4.13 / -3.85 | -1.83 / -1.60 / -1.86 | -2.86 / -2.78 / -2.64 |
| stream cells per km2 | 82.2 / 74.6 / 75.8 | 69.7 / 43.4 / 38.7 | 83.8 / 79.9 / 78.9 |
| first parallel-stream spacing (km) | 2.1 / 4.6 / 3.1 | 2.5 / 5.7 / 2.7 | 3.1 / 2.8 / 3.3 |

D alone on R1 (lithology off at tiers 4 and 5): slope .302, peak ratio 3.73, 10 of 22 windows, 1D band slope -5.36. The band's spectral gain comes from the varying D; the beds are what cost slope. Natural profile spectra are about k^-2 (Huang and Turcotte 1989; Perron et al. 2008): R1 and R3 get much closer, R2 does not.

Gate (lock under 8 of 24 or at uniform, tier-0 box error under 1 m, median slope 0.29 plus or minus 0.02, land p99 within 5%, peak ratio toward 2 to 3, coast dimension toward 1.1 to 1.25, straight channels down): passes box error and land p99 everywhere and the slope on R3; fails slope on R1 (beds) and R2 (weak, high-D coastal plains flatten), lock on R1 and R3, the peak ratio (3.4 to 3.7), coast dimension on R1 and R2, straight channels on R2 and R1.

## Stream mask against real valley spacing and drainage density

Rule (`terrain-water.ts` `begins`, `water-global.ts` `chnOf`): a cell begins a channel where cells times fall squared is at least WINDOW_HEAD_C / cell, WINDOW_HEAD_C = 70.7 m; every cell downstream of a head is channel. The mask covers 24 to 47% of land cells: 6.3 to 7.3 km per km2 in the baseline, against first-order valley spacings of 30 to 321 m at five sites on slopes of 0.2 to 0.4 (Perron et al. 2009, Table 1), which imply roughly 3 to 33 km per km2. The density is in range only because the mask is a large share of the land; the parallel-stream spacing of 2 to 5 km is 10 to 100 times the measured valley spacing. The repo's granite length Lc (set by D over K) is 237 m against 4 to 46 m at those sites, and a higher D makes that worse; the lever is K at first-order scale (a gap, not touched).

At 47.86 N 37.77 E (face 4, region tx 23 ty 21): live tile 3 by 3 around tile 28, 26: 82.8 stream cells per km2, 7.56 km per km2, 47% of land. Region baseline 62.3, 5.51, 35%. With rock-and-climate D 29.0, 2.50, 16%, median slope .221 to .118 and relief 560 to 366 m: D there is high and flattens the ground. The page's orange dry beds there were not rendered against it.

## Diagonal creases

The share of cells whose strongest second-difference direction is exactly diagonal is 0.24 to 0.25 everywhere (isotropic expectation), including the live crease tile at 1.57 N 62.96 E (0.21): the creases are sparse single lines (the strongest is 4.3 times the median across the line). Ablation on the crease region (face 1 tx 2 ty 12): 5.4% of x-y lines over twice the median (1.1% of x+y); four-neighbour routing gives 2.6% and 0.6% but axial 8-runs of 300+ cell rivers rise from .35 to .86, so straight runs are made of whichever lattice directions the receivers allow. Lithology plus D leaves them (top over median 2.4 on R1, 3.0 on R3).

## Multiple flow direction (Tarboton 1997)

An env-gated kernel in the in-memory region path splits each cell's discharge in integers between the cardinal and diagonal neighbour of the steepest facet (a neighbour only if its tree depth is smaller, so the depth order stays valid; the tree receiver still drives flood and incision). Control against variant on the crease region: x-y lines over twice the median 5.1% against 8.9%, river straight share .691 against .646, stream cells 48.6 to 36.1 per km2, first spacing 2.9 to 3.45 km, median slope .159 to .116 (down 27%). It does not remove the lines. It cannot be streamed as is: the stream stages gather per tile through single-receiver exits (`area1`, `skel`, `todexit`, `inject`), and two receivers need two exits per boundary cell, so the exact global discharge and streamed equality would break.

## Pictures

In `/tmp/globe-fix-t/TRelief2/`: `B1-close.png` against `RD5-close.png` (R1, 3 px a cell): the baseline has planar parallel ridges about 6 km apart and long near-straight east-west rivers at the ridge feet; with D and beds there are more side tributaries and sub-ridges and rivers wander more, but the ridge scale is unchanged and some horizontal river runs persist. `B2-coast.png` against `RDc5-coast.png` (R2): regular parallel diagonal ridges with straight rills to the sea become a smooth plateau with rounded basins, with some axis-locked slot rivers left and the slope down to .119.

## Where this leaves 6.2 and 6.3

Open (gaps): the tier-0 lattice's Nyquist structure survives every hold and routing variant tried; lithology breaks the lock partly (a physical, cited, non-uniform law) but costs slope and leaves the peak ratio at 3.4 to 3.7; rock-and-climate D restores relief in the 150 m to 2 km band but the evidence for its rock and rain dependence is weak (Hurst et al. 2013 find no lithology trend) and it flattens coastal plains; first-order valley spacing is 10 to 100 times the measured 30 to 321 m because K at first-order scale and the channel-head rule are Earth's at coarse scale; fracture zones with a cited curved, segmented geometry were not built. Any adopted change alters the store key and reruns tiers 1 to 5 and every later stage (about 5.5 to 5.7 h wall, 49 to 51 GB).
