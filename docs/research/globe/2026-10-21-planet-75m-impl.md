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
