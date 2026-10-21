# The `ground` tile stage and the scatter (Unit 5): the island's soil, cover and objects on the whole 75 m tier

Owner: GroundStage. Code: `src/gpu/globe/ground.ts` (the stage, export `groundStage`), `ground.test.ts`; the island's kernels widened by a format (`src/gpu/wgsl/terrain-ground.ts` `GroundFormat`, `src/gpu/terrain/ground.ts` `groundWords`). R-numbers: R1860 (the reach of the nearest channel's power), R1861 and R1890 to R1899 for the scatter (below). Each test case alone: `lockf /tmp/nomads-gpu.lock bun test ./src/gpu/globe/ground.test.ts -t "<name>" --timeout 280000`.

## 1. The ground stage

### What was generalised, and how the island's goldens were kept
- `wgsl/terrain-ground.ts`: `groundWgsl(fmt)` with `GroundFormat {n, patch, reach}`. `ISLAND_GROUND` (n = 256, patch false) gives the island's text: the hash of the whole text (44,385 characters) is the same before and after (`de1c42fa0ed5a0fa`, `/tmp/planet-75m/ground-scratch/snap.ts`). A patch (`patch` true) is any side n; its `near` entry point (the nearest channel's power, two raster sweeps run one anti-diagonal at a time in one workgroup) takes every 256th column to a thread, and the sweep carries a channel's power no further than `reach` cells (`r <= reach` in `nearStep`).
- `terrain/ground.ts`: `groundWords(g, words, fmt)` is what `groundAndLeaf` ran, for either format; `pack` is exported.
- The island's goldens, one case at a time: ground on islands 1, 2, 3 (`8f1c7a4b7b625a7b`, `4d2b1ed687c1121a`, `de04b717fff3d82b`) pass. (The rearranged-rock case was run once, see the report.)
- Test of the widening on the island's own site (`ground.test.ts` "a patch of the island's size"): the patch format at n = 256 with a reach of 100,000 gives the island's words, all 27 outputs, hash for hash; with the stage's reach (64) no cell differs; with a reach of 8, 560 to 583 of island 1's 2,931 valley cells lose their alluvium, so the cap does act.

### Inputs (all per cell, read from the tier's files, mapped)
Heights `t4-height.i32`; open water = `t4-water.u16 > 0` or height <= 0 (the water stage's own rule); `t4-rock.u8`, `t4-drift.u8`, `t4-dd.u16` (terrain); `t4-chn.u8`, `t4-valley.u8`, `t4-pwr.u16` (x 4096 to Q16 W/m2), `t4-stb0..3.u16` and `t4-dry.u16` (1/256 m: the water stage stored them at 1/64 until this stage measured that 1/64 moves tree cover by more than 2/255 in 2,447 of 44,000 land cells of island 1 and by more than 20/255 in 475; at 1/256 999 and 10; no other input's quantisation moved a cover: heights, rain, evaporation, sun, temperature, humidity: 0 cells); `t4-pr/pe/sun/tmp/hum0..3` (air). `TABLE_UNIT` is the one constant that reads the tables' scale. A cube-corner patch cell (a repeat of the nearest cell) has no channel.

### Outputs (23 bytes a cell, 2.3 GB; table at the top of `ground.ts`)
`t4-tree.u8 t4-shr.u8 t4-grs.u8 t4-mar.u8 t4-bare.u8` (1/255 of the share; the beach's sand is none of the five), `t4-soil.u16` (1/1024 m), `t4-sflag.u8` (bit 0 silt, 1 sand, 2 peat), `t4-sandy.u8 t4-clayey.u8` (1/255), `t4-fert.u8`, `t4-moist.u8`, `t4-sw0..3.u8` (1/255), `t4-ph.u8` (1/30), `t4-org.u8` (organic %, 1/2.55), `t4-carb.u16` (t/ha, 1/16), `t4-nit.u16` (kg/ha/yr, 1/64). Not stored (the play area makes them again from the same inputs): the field layer's share and light, the leaf display. The pyramid's `tree shrub grass marsh bare` are the five covers, `soil` is `t4-soil.u16` /25.6 (u8 at 0.025 m); the scatter reads the covers, `sand`/`silt` flags, `clayey`, `soil`, `ph`, `moist`, `sw0..3`.

### The halo
A cell reads its four neighbours (the creep fluxes, the coast) and the nearest channel's power within `reach`. `GROUND_HALO` = 64 [design R1860: valley cells on islands 1, 2, 3 lie at most 24, 32 and 48 cells from a channel (measured, `reach.ts` in the scratch)]. A valley cell with no channel within 64 cells gets no alluvium [gap]. With the reach equal to the halo a cell 64 or more from the patch's edge depends on nothing outside it.

### Measured
- Tile independence (`ground.test.ts` "two patches half a tile apart"): patches of the same tile shifted by 128 cells, 32,768 shared cells, all 19 output files: **0 words differ**, tiles 458 (face 1, a 5.4 km range) and 223 (face 0 east edge). The sweep's tie order and the patches' orientation do not enter.
- One place from two faces ("one place seen from the two faces of a cube's edge"): 16,384 cells of face 0's east edge seen from a patch of face 0 and a patch of face 1 (axes flipped and turned, the cells 64 to 127 from the far patch's edge): **0 words differ**.
- Identity: the six tiles made twice (and resumed in two calls through `runTiles`) are the same bytes. Per tile (458, 1, 14, 1500, 937, 0): 0.08 to 0.11 s (mapped files hot in the page cache, the GPU shared): the planet is about 3 minutes of GPU and about as much of reading.
- Pinned (stand-in water, below): tile 458 `cd6f5602733af733`.

### Stand-in water
The water stage's files did not exist when this was written. The tests use a stand-in (`synthetic` in the test: channels where 20,000 cells drain, a floodplain within 24 cells on ground under 800 m, a table by the drainage area, standing water where the flood stands over the ground). The stage reads the water stage's files by their names and scales, which were confirmed by its author; the pin and the silt and peat counts are the stand-in's and must be re-recorded on the water stage's own files.

## 2. Gaps (not retuned)
1. The island's constants are Bornholm's: the species (pine, oak, ash, aspen, berry, hazel, heather), the leaf season's daylight ramp (the game's 55.1 N sky: 10 to 11 h; at the equator it keeps deciduous leaves off through the winter season of the year, which changes their carbon and, through the soil's organic matter, the second round's cover a little, not the compensation points that set the cover), the day's temperature range by season (Rønne's), the clay's pedotransfer and Clymo's bog. `similarityOf` has nothing to map: no constant here is a length along the surface set by a wind or a time of the atmosphere; the creep law is per metre of the real cell (CELL is 75 m, the tier's cells 63 to 75 m: gap shared with the water and air stages).
2. The ice's going (AGE = 18,500 years) is one value for every cell, as on the island.
3. A cube corner's patch repeats the nearest cell; the cells within one of a corner differ from what three faces' own would give (one ring).
4. The beach's sand (RUNUP 1.6 m above the sea) uses height 0 as still water; the tier has no tide or surge.
5. The stored covers are u8 (1/255): the scatter reads shares at 0.4%.
6. The mapped files are read by tile: `TileStage.inputs` is empty (`globalField` would hold 7 GB of them), `prepare` checks that the files exist.
