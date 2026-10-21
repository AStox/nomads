# The 75 m tier over the whole planet (plan Unit 5 of the seamless globe)

Chain: `docs/plans/2026-10-20-001-feat-seamless-globe-plan.md` Unit 5, on the small-planet note (`2026-10-20-small-planet-impl.md`: the regional tier's kernels and the cost of tier 4), the grid note and the window note. This is the running log: what is built, what was measured, what is open, so that a stop can be resumed. Sub-notes by stage: `2026-10-21-planet-75m-air.md` (rain and climate), `-water.md` (the global gather and the hydrology).

## The design

The planet is 195.6 km in radius; the 75 m tier is tier 4 (4,096 cells along a face, 100,663,296 cells, 403 MB a 4-byte field). Nothing is made per place.

1. **Coarse to fine, globally** (`src/gpu/globe/tiers.ts`, `scripts/globe-tiers.ts`). Tier 1 starts from the planet's tier 0 (regional.ts `remapHeights`), each later tier from the one above (`refineInts`/`remapInts`: a child is the bilinear value between its parent's and its neighbours' centres, moved by one whole-unit constant so that the children of a cell sum to 4 times the parent's height exactly, to 1/256 m). Each tier is then eroded over the whole planet by regional.ts (flood and receivers across tile and face edges, the implicit stream power step, threshold hillslopes by rock, every tier-0 cell's total height held), 40 steps at tiers 1 to 3 and 12 at tier 4 [design: R1763's 40 where a step costs 0.1 to 4 s; tier 4 starts from tier 3's settled network and a step costs 23 s]. A tier's bytes do not depend on where the calls that make it were split (a state is the heights and the carries, `regional.test.ts` pins one step's hash and checks 2 steps then 1 resumed).
2. **Pyramid tiers 0 to 3 are views of tier 4** (box means of it), not separate solves: the planet is one 75 m model and its coarser tiles are what a viewer needs [design]. Tiers 1 to 3 are made only as stepping stones for the erosion.
3. **The fine stages are tile stages on patches** (`patch.ts`, `stages.ts`): a tile (256 x 256 cells) and a halo of cells all round it laid flat across the face's edges is the square grid the island's kernels run on, so those kernels are generalised to any side by a format argument, with the island path byte-identical. A stage's answer for a cell is a function of the global fields within its halo, so the same whichever tile holds it; `patchAt` makes a patch at any face position and each stage is tested for tile independence by running two patches that overlap by half a tile. Planet fields (tier 0) are read per cell by `sample.ts` `sampleCoarse` (bilinear across edges), never as a window's constant, and quantities the island scaled to a window's mean are scaled per tier-0 block (the 16 x 16 children of a tier-0 cell), so the planet's own totals are kept.
4. **What is global and what is local.** Global: the flood, receivers, discharge area (regional.ts), the discharge of every season (`discharge.ts`, the water agent's exact gather). Local with a halo: the drift (`terrain.ts`), rain and climate (`air.ts`), the aquifer and channels (`water.ts`), the ground and the scatter.

## What is built and measured

### Tiers 1 to 4 (seed 1 of the planet in `/tmp/planet-small/store`, key 4c2a2cb36ba6)

Pinned to that key: another agent edits the globe's coarse sources (Unit 4b) and the store's key hashes them; the tiers are rerun on its planet when it lands.

| | tier 1 | tier 2 | tier 3 | tier 4 |
|---|---|---|---|---|
| cells | 1.57 M | 6.29 M | 25.2 M | 100.7 M |
| steps; a step | 40; 0.1 s | 40; 0.5 s | 40; 4.5 s | 12; 23.2 s |
| flood rounds; slides rounds | 384; 32 | 384 to 512; 32 | 768 to 896; 64 | 1,408; 128 |

Calls (each under 5 minutes, run as `lockf /tmp/nomads-gpu.lock bun scripts/globe-tiers.ts --seed 1 --last 4 --key 4c2a2cb36ba6`): the first call makes tiers 1 to 3 (215 s) and tier 4's inputs, a second makes 8 of tier 4's 12 steps (188 s), a third finishes it and the settled flow (119 s): 3 calls and 9.3 minutes of GPU on a machine with load average 3 to 5. A call's remap was 189 s until `refineInts` replaced the general remap at tier 4 (25 million parents in JavaScript through `eachParent`): now 4 s.

**One drainage network** (`scripts/globe-tiers-check.ts`, `tiers.ts drainage`): tier 4 has 28,246,719 land cells and 72,416,577 sea cells; every land cell drains to a neighbour whose flooded surface is strictly lower and every sea cell to itself, so no chain loops and every river ends at the sea (the flood fills every depression to its spill, so there are no closed basins: a lake is a hollow the flood raised). 12,304 receivers cross a face's edge and 164,498 a tile's. The first bake found 2 land cells with no receiver, both children of the tier-0 cells at a cube's corner: the tier table's inverse distance to the diagonal neighbour that does not exist at tier 0 was 0, and the children of such a cell do have one; `tierTable` now takes the diagonal of the two edges beside it [derived]. regional.test.ts's pinned hash holds (its ridge's corner is not at a cube's corner).

Hashes of seed 1's tier 4 (sha256, 16 hex): height 792e27573f5eb71c, to 06221edc45fff223, acc 3d76bbe6f3abffa1, flooded 40ccb82a577c60a5.

### The uplift was a block constant: found by looking, fixed (commit 70b83e9)

The first tier-4 maps showed a grid of 16 by 16 squares. regional.ts lifted every land cell of a tier-0 cell by that cell's mean loss (R1762): a constant to a block, so neighbouring blocks stepped. Measured as the mean height step across a tier-0 block's edge against inside it, at tiers 2, 3 and 4: 197 against 87 m, 220 against 50 m and 67 against 22 m (3 to 4 times). The lift is now the bilinear interpolation of the mean loss of the four tier-0 cells round each land cell (the remap's weights; cells with no land left out), a second pass returns what the interpolation did not (the cell's loss less the rises), then an even share, and the rest is carried (a deficit is never taken from a cell). Total height plus carry of every tier-0 cell is exact (regional.test.ts), and the edge step is now 1.14 to 1.23 times the step inside a block (tiers 2 to 4; the test asserts under 1.34 on the staged ridge). The pinned hash of the step test moved (`5d66e2532e436644`).

### Seed 1 on the planet Unit 4b landed (key c418e5fe9b5e), tiers 1 to 4

Tier 4: 21,385,110 land cells and 79,278,186 sea; every land cell drains to a lower flooded neighbour and every sea cell to itself (bad 0); 8,722 receivers cross a face's edge and 120,313 a tile's. A step is 16.4 s (flood 896 rounds, landslides 128). Hashes: height 33aab65cf71b62c3, to 9c5378ddb2f05004, acc 51a0ff2b88b10b4c, flooded 78c299e3e947e6f5. 2 calls for tiers 1 to 4 on the rebake (195 s tiers 1 to 3 plus tier 4's first step, then 11 steps and the settled flow in 199 s). What 75 m looks like on the maps (`/tmp/planet-75m/maps/`): ranges are planar faces at the rocks' threshold slopes (30 to 36 degrees) and the D8 routing draws straight rivers down them: a consequence of 6 km of relief over a 195 km planet, not of the tile seams; the rivers across a face's edge run on without a break.

### Stages made so far

- `terrain` (`terrain.ts`, `wgsl/globe-terrain.ts`): rock at depth (the planet's pools read down to the depth the cell lies under the planet's own surface), the ice's till by the island's blur and law (six passes of nine-cell box means then the thickness by how far the bed lies under the ground round it). Halo 16. All 1,536 tiles in 40 s (0.03 s a tile). Tests: the kernel equals a plain-integer twin word for word on a staged trench-and-ridge patch, clay till is the ice's thickness, the sea has none, two patches overlapping by half a tile agree over the shared 128 x 256 cells, two runs are equal (`terrain.test.ts`, 2 cases). Gap: the island's joint valleys (ice scour, drawn by a window's key) are not made: no meltwater sand.
- Pyramid (`pyramid.ts`, format in `bake.ts PYRAMID_FIELDS`): built from the stage outputs by `buildPyramid`, 2 by 2 pooling for tiers 3 to 0; `pyramid.test.ts` (1 case).

### Second rework of the uplift: the leftover of the smooth rises is applied, not carried

With the smooth rises the leftover (the tier-0 cell's loss less what the interpolated rises returned) was carried, unbounded when the rises over-lifted. The tier-4 means of the tier-0 cells then drifted from the planet's (|mean child - planet height|: p90 95 m, p99 330 m, max 1.9 km). The leftover is now shared evenly up or down over the cell's land (no cell under one unit; what that holds back is carried): p50 0.00 m, p90 0.01 m, p99 1.9 m, max 59 m (cells held at one unit). Edge step across a tier-0 block edge against inside: 1.17, 1.28, 1.29 at tiers 4, 3, 2 on the final planet. `tiers.test.ts` (chain on a staged planet: one drainage network across face and tile edges; the same bytes twice and made in calls of one step; each tier-0 mean within 0.25 m) and `regional.test.ts`.

## The full bake of seed 1 on the planet of key 883a8d9387df (Unit 4b's rain fix)

Calls are the tool's 5 minutes; times are wall time on the M3 Pro with the GPU shared with the other agents' jobs (load average 4 to 5), so upper bounds. Disk is /tmp/planet-75m/1-883a8d9387df.

| stage | per tile (1,536) | what a call made | calls | total | peak process memory |
|---|---|---|---|---|---|
| tiers 1 to 4 (global erosion, 40, 40, 40, 12 steps) | tier 4 step 15.9 s (768 flood rounds, 128 slides), tier 3 3.9 s, tier 2 0.5 s | tiers 1 to 3 and 6 of 12 steps; the rest of tier 4; settled flow | 3 | 7 min | GPU 5.6 GB of solver buffers; 9.5 GB process (Unit 4's measure) |
| terrain | 0.025 s | all | 1 | 39 s | |
| air | 1.1 s (patch 512 x 512, halo 128) | 166 to 224 tiles | 8 | 29 min | 1.9 GB |
| surplus, discharge (exact 64-bit sums of 5 weight fields), basin (lakes decided over the tier) | 0.02 s; 10 s whole; 15 s whole | all | 2 | 1 min | discharge: the sort and gathers on the GPU, 5.6 GB |
| water | a call's mean 0.65 to 4.4 s (sea tiles under 1 s, mountain tiles up to 7 s at the 12,000 sweep cap) | 50 to 334 tiles | 11 | 39 min | files mapped, not held |
| ground | 0.10 s | 1,122 then 414 | 2 | 2.7 min | 0.4 GB |
| ground tiles (the page's per-tile files, halo 8, 39 planes) | 0.05 s | all | 1 | 69 s | |
| pyramid (2,046 tiles of 14 fields) | 0.04 s | all | 1 | 90 s | 0.14 GB |

About 31 calls and 1 hour 55 minutes of wall time. Disk: stage files 16 GB after deleting what is spent (the tiers 1 to 3 heights and the surplus weights); at most 18 GB between stages; pyramid 338 MB (tier 4 241 MB, tiers 3 to 0 97 MB); ground tiles 994 MB (20.9 bytes a cell gzipped, 1,536 files); the whole directory under /tmp/planet-75m is 20 GB with maps and the old key's leftovers. Tier 4: 21,728,076 land cells and 78,935,220 sea; every land cell drains to a lower flooded neighbour and every sea cell to itself (bad 0); 8,939 receivers cross a face's edge and 127,126 a tile's; 5,497 lakes and 1,437 dry hollows decided once over the tier.

### What each stage answers for a cell: tile independence measured

Two patches half a tile apart, the cells in both interiors (details in the sub-notes): terrain, ground (19 outputs) and the two faces' view of one place: word for word. Air: sun, sky, pool, fog, humidity, temperature equal; rain not (rms 6.7 mm against a spring p99 of 849 mm on tile 458: the orographic lee waves are a function of relief far beyond any halo; the block means are within 1.9% of the planet's, not exact: a wet neighbour's rain leaks into a dry block through the bilinear background); wake and salt differ by less. Across a face's edge the low-sun season's sun differs by rms 12% (the lattice is skewed up to 30 degrees at a cube's corners and the horizons read it as square; a gap). Water: flow, channels, floodplains equal; the shallow table (within 5 m of the ground, what the ground reads) equal; the deep table differs near a patch's edge (up to 84 m on tile 458): about 1 tile in 3 of the mountain tiles stop at the 12,000 sweep cap with a head error of 7 to 250 m deep in the ground (reported per tile by `scripts/globe-water.ts`).

### Open (gaps, named)

- The air stage's rain concentration is capped at 4 times a tier-0 cell's rain [design, R1327 gauges and the theory's gain]; the block-mean error above.
- The water stage's lakes are full or dry (no part-full level); the inflow is the surplus, not the island's final weights (recharge, groundwater return, lake evaporation): flow over the global discharge 0.8 to 1.2 on the tiles measured.
- The planet has no meltwater valleys (the island's joint valleys are drawn by a window's key); drift is till only.
- Rivers are 75 m steps of the receivers, with no meanders (the island's `shape` needs a whole river's line); the scatter's noise steps at a cube's edge (keyed per face).
- Ranges are planar faces at the rocks' threshold slopes, with D8 rivers straight down them: the consequence of 6 km of relief on a 195 km planet.
- Species, densities, the leaf season, bog and day range are Bornholm's.
- Unit 4b's gaps (the climate's humidity budget, the missing cloud physics) pass through unchanged.

## Napkin note (for the repo's runbook, not edited here)

**[2026-10-21] A constant to a block is a step at its edge, so look at the 75 m picture before trusting an invariant.** A per-tier-0-cell uplift and a per-cell rain background each made 16 by 16 squares; the tests (parent totals kept, block means kept) passed. Do instead: after any change that keeps a coarse total, measure the step across a coarse cell's edge against the step inside it (mean |d| ratio, `tiers.test.ts`, `regional.test.ts`), and view a tile PNG (`scripts/globe-maps75.ts`). The planet is made by tile stages on patches (`stages.ts`, halo per stage, `patchAt` for a tile independence test: two patches half a tile apart); the island's kernels run on a tile by a format argument, never by a copy. `rm -rf` and `find -delete` are blocked for agents: delete a bake's files by name with `rm -f`; the bake dir /tmp/planet-75m is keyed by the planet's store key.
