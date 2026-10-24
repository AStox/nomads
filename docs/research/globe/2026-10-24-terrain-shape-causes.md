# Terrain shape defects of the 391.1 km bake: causes measured (key 7f6ff6c82cdd)

Source: the visual audit's section 6 (far entries 15 and 16, close entry 8). Region runs: face 0, 8 by 8 tiles at 75 m, tiers 1 to 3 remade, tier 4 for 28 steps, tier 5 for 6 (`scripts/globe-land-region.ts`). Statistics read the baked `t5-*` files and the pyramid. Only 6.1 is fixed; 6.2 and 6.3 are recorded as gaps.

## 6.1 Lakes (fixed in the pyramid)

The baked 75 m lakes are fine: 1,556 lakes in `t5-basin.u8`, smooth ovals and leaf shapes, 0.5% share a mask and 1.8% are boxy (area over bounding box above 0.85). The rounded rectangles come from the pyramid. `PYRAMID_FIELDS.water` is a depth pooled by max, and the page wets a cell where the bilinear `water` is at least 0.25, so one lake child makes the whole coarse cell wet at the lake's greatest depth D. The contour then sits 1 - 0.25/D of a cell past the cell's centre: a lake smaller than a cell draws about 1.8 cells wide, an n-cell lake n + 0.8. The cream rim is the page's shore foam band (`fillWater`, shore = depth / 0.05) painted over that inflated footprint, not cover or rock.

Fix: pyramid format 2 adds a `lake` plane, the share of the cell's area under a lake, from the flooded surface minus the ground (a lake cell holds flooded minus ground, a land cell beside a lake holds that lake's level minus its ground, bilinear between cell centres, 4 by 4 samples a cell), box-mean pooled. The page reads it bilinear and wets it at 0.5. The store key is unchanged (it hashes grid, tectonics, erosion, atmosphere and ice sources only); only the pyramid stage reruns (about 8 minutes of CPU).

Over 1,156 lakes on faces 3 and 4 (tiers 4, 3, 2): drawn over true area, median 1.78, 2.97, 6.18 before and 0.96, 0.90, 0.81 after; boxy lakes 17, 28, 44% before and 3.0, 3.6, 0.7% after; lakes sharing a mask 5.5, 12, 16% before (one 15 by 15 mask 24 times at tier 2) and 0, 0, 1.1% after; IoU after 0.987, 0.974, 0.938. Gap: lakes under half a cell vanish at far tiers (76, 268, 527 of 1,156 at tiers 4, 3, 2). `river` is pooled by max the same way.

## 6.2 Washboard ridges (not fixed)

The washboard is in the baked t5 heights: planar facets with straight crests and no gullies at 75 m, surface spectrum P about k^-4.7 between 7 and 256 cells (natural terrain k^-2 to k^-3). Valley spacing is 3.5 to 4.8 km at tiers 1, 2 and 3 alike and survives erodibility times 4 and 0.25, creep times 10 and 0.1, slides off, the planet's rain, steepest-descent receivers and 330 steps. Ridge peak ratio 3.8 to 4.5 against 1.6 to 2.5 for a scale-free surface. Over 266 strong ramp windows the dominant ridge wavevector lies within 8 degrees of a lattice axis in 110 and of the diagonal in 69 (a uniform spread gives 47 each); its length is two tier-0 cells (4.8 km axial, 3.4 km diagonal).

The lock is held by the exact per-tier-0-cell mean-holding lift (`lift`, `pstencil`, `psolve` in `wgsl/globe-regional.ts`). Variants on the region (baseline, A1 filtered start by one 3 by 3 binomial pass with exact hold against the filtered target, A2 3 by 3 box mean likewise, B1 unfiltered start with each cell's loss shared conservatively over its 3 by 3 neighbours):

| | baseline | A1 | A2 | B1 |
|---|---|---|---|---|
| ridge windows near an axis | 12 of 24 | 12 of 23 | 20 of 24 | 5 of 27 |
| peak ratio / wavelength | 4.2 / 4.5 km | 4.9 / 3.8 | 4.7 / 3.8 | 4.2 / 5.1 |
| tier-0 mean error p99 | 0.13 m | 0.07 m | 0.06 m | 1,953 m |
| median slope | 0.289 | 0.281 | 0.283 | 0.466 |
| land height p99 | 4,883 m | 4,871 | 4,898 | 5,815 |
| coast box dimension | 1.019 | 1.038 | 1.035 | 1.008 |
| river axial runs of 8+ (300+ cells) | 0.415 | 0.399 | 0.432 | 0.306 |

Filtering the start does not remove the lock (the box mean strengthens it). Relaxing the hold removes it (5 of 27 is a uniform spread) but the escarpments keep losing 20 to 30 m a My while their uplift is shared with plateau that does not erode, so relief grows until erosion matches the shared uplift: slope 0.29 to 0.47, tier-0 means off by 288 m at the median. Books close (rise over loss 0.99999 to 1.0 a step), so it is physics of the contract, not accounting. The exact hold is what bounds relief; it is the "coarse relief taken as given" choice already written as the implied-uplift gap. The tier-0 field before any erosion shows only weak lock (9 of 28 windows against 5 expected). The source of the periodicity itself (peak ratio 4.2 to 4.9 in every variant) was not found. Ridges narrower than 3 tier-0 cells are rare on the planet (about 1% of cells above 1,000 m), so a tier-0 low-pass would cost little in range width but does not fix the lock.

Gate for any later attempt: axis-locked ridge windows under 8 of 24, tier-0 mean error p99 under 1 m, median slope 0.29 plus or minus 0.02. No variant passes both. Options: accept as a gap; test a partial relaxation of the hold (a tuning of the mean-hold contract); a cited fine-relief process (threshold or stochastic stream power) the generator lacks. Any adopted change alters the store key and reruns tiers 1 to 5 (about 1.3 h of GPU) and every later stage (about 5.7 h wall, 49 GB).

## 6.3 Straight coasts, channels, shore bands (not fixed)

Coast: marching squares on the sea-level contour of baked t5 over 187 windows give a box dimension median 1.027 (p90 1.106; natural coasts 1.1 to 1.25). 39% of coast length lies in runs of 16 or more cells within one cell of a chord, 14.5% at 32 or more, 5.1% at 64 or more. At the audit's K3 place the dimension is 1.002 at tier 2, 1.029 at tier 3 and 1.034 at tier 5: the straightness is the carried tier-0 coast, and the fine tiers add little roughness because there is almost no fine relief at the shore (the spectrum above, and land is floored 1/256 m above sea in the incision step so valleys never open below sea level). None of the variants above changed it (dimension 1.008 to 1.038, 32-cell runs 10 to 15%).

Shore bands: across the K3 shore the heights are smooth (land about 8 m a cell, sea 19 to 24 m a cell, reaching -3,400 m in about 14 km, one 21 m kink at the shore). The data has no depth steps, so the stacked teal bands in the audit still come from the page's palette on a steep ramp (page side, not tested).

Channels: `t5-to` has no forward runs of 8 or more on diagonal receivers, and axial runs of 8 or more cover 17 to 26% of river cells of 30 or more cells' drainage; the region's steepest-descent routing gives 75% straight. Channel straightness follows the parallel valleys of 6.2 plus 8-direction quantisation; only B1 reduces it.
