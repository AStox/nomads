---
title: "feat: one whole planet at the game's 75 m, made once and kept, seen in one view from orbit to the ground"
type: feat
status: active
date: 2026-10-20
amends: docs/plans/2026-10-19-002-feat-globe-viewer-plan.md
---

# feat: one whole planet at 75 m, made once, one view from orbit to the ground

## Overview

The operator (2026-10-20), on the globe viewer: the planet is cool, but its art is not the island's. The island's art
(the isopixel look: one fixed palette, ramps, dithered sea and shallows, hillshade in palette steps, the ladder's fixed
bearing) should carry through to the planet's scale. The globe and the game should not be two modes: zoom from the whole
planet all the way into the play area and back out without a cut, and pan at any zoom, endlessly.

Then, on windows made one by one and matched at their edges: "We just want a whole planet model that is cohesive and
consistent. We don't want to break it up into chunks and then try to match where the rivers are. We should be generating
this whole planet and then we just stick with it." A 2,000 km planet at 75 m is about 9 billion cells, so the operator
chose a smaller planet with 75 m everywhere over a coarser planet with derived detail or an offline bake of the big one.

## Requirements

- R1. One art. The planet at every zoom is drawn with the island's palette (`demo/styles/isopixel/pal.js`) and its ways of
  drawing. Set side by side, the planet seen from afar and the island at its `island` level read as one picture.
- R2. One view. No mode switch, no page load and no cut between the planet and the play area. Altitude is continuous from
  the whole planet to the ladder's `close` level; the projection goes from the sphere to the ladder's fixed isometric
  bearing as it comes down.
- R3. One model. The whole planet is generated once, at 75 m everywhere, by global solves (every process sees its
  neighbours across tile and face edges, as the grid's halo exchange does), and saved. Nothing is generated per place,
  so nothing is matched at an edge. Tiles exist only for storage and streaming. What grew (the scatter) is a pure
  function of a cell's fields and its counter-based draws, so it can be made for any tile on demand and is the same
  every time.
- R4. The sim runs in one play area (19.2 km, `SIZE`), the one the people are in, cut from the planet. Elsewhere the
  ground and what grew on it are drawn, with no people or animals. Coming back shows them as they are.
- R5. The house rules hold: integer GPU kernels, counter-based randomness, byte-identical runs, every constant cited or
  tagged, a failing check written down as a gap and never retuned, nothing run over 5 minutes (a bake is many staged
  calls), the island path's goldens unchanged until the cutover.

## Scope boundaries

- The play area stays 19.2 km. People do not travel out of it (the 2026-10-19 decision stands); the camera does.
- The planet's laws are Earth's, scaled by dynamic similarity (operator, 2026-10-20, after Unit 4 measured a calm, dry
  planet: mean wind under 0.1 m/s, 94% of land under 250 mm a year, ranges ten times too narrow). The dimensionless
  numbers that set Earth's circulation are kept, not the dimensional constants: the spin is set by Earth's thermal
  Rossby number (about a 44 minute rotation at 195.6 km) [derived]. Amended 2026-10-21 after the 75 m bake: only a
  constant whose number holds the planet's radius or spin scales (the circulation, the ocean, plate count against the
  sphere). Lithosphere, rock, hillslope, river and glacier lengths (orogen and wedge widths, flexure, arcs, hot spot
  footprints, creep, sediment reach, shelf slope) are set by rock and gravity, not by the planet's size, so they stay
  Earth's: Unit 4b scaled them by 0.03 and made 6 km ranges 3 km wide, ridges of planar faces with straight rivers. The
  game keeps its own 24 hour day and sky (sky.ts); the planet's spin is a climate parameter, not the people's day [design].

## Key decisions

- **The planet's size is set by the grid.** 8,192 cells of 75 m along a cube face's edge (32 of the 256-cell tiles the
  kernels run on), so the radius is 8,192 x 75 m x 2 / pi = 391.1 km [derived], 6 x 8,192^2 = 402.7 million cells.
  Tier 0 stays 256 cells a face (2.4 km cells); the 75 m tier is tier 5. Chosen by the operator 2026-10-21 over the
  195.6 km planet (4,096 a face, built in Units 4 to 5), whose continents were as small as one orogen and came out as
  5 km plateaus once rock lengths were Earth's (Unit 4c). The cost accepted: about an 8 hour bake in staged calls, about
  65 GB of stage files, and solves that stream tiles from disk, since a whole tier no longer fits in 18 GB of memory.
- **Coarse to fine, globally.** Tectonics, the atmosphere and ice run on the coarse tiers as now; each finer tier starts
  from the one above and is solved over the whole planet (erosion's flood and receivers, hydrology, soils and the rest of
  the island's stages), so rivers are one network and every cell's ground is one answer.
- **Stored as a tile pyramid.** The bake writes each tier's fields in tiles under the planet store's key; the page streams
  the tiles under the camera at the tier its zoom needs. Storage tiles are not generation chunks.
- **The globe's look is the ground painter's, not a second palette.** As Unit 1 built it.
- **One renderer.** The globe pass becomes the base layer under the ladder's levels inside the render worker; `?globe`,
  the GLOBE button, G and `?at` go at the cutover.

## Implementation units

- [x] **Unit 1: The planet in the island's art.** `demo/styles/isopixel/wgsl/globe.js`, `demo/styles/play/globe.js`.
  Done 2026-10-20 (d575a2c): every pixel is a pal.js index (cover mixed as g_rgb does and put in by dqBuild's dithered
  pair, soil, sand, rock and ice ramps, the w ramp for the sea with the surf line and dithered shallows, TONE rows for the
  light), drawn at a 2 px art pixel and shown by whole pixels; rivers are Bresenham lines of art pixels on the w ramp.
  Cover comes from Holdridge's PET and Koppen-Geiger's BW rule on the planet's year-mean air and rain. Still off: below
  the planet's cells the picture is noise and a hillshade scaled by the cell's ruggedness, decoration the planet does not
  hold, deleted once the 75 m tier is drawn (Unit 6); rain is 0 on three quarters of the land.
- [x] **Unit 2: The window lattice and streaming. Superseded 2026-10-20** by R3: windows made one by one cannot agree at
  their edges (measured: 63 to 809 m rms along a shared edge, rivers crossing 1.4 to 11.5 km apart). Built in 25e3493
  (`lattice.ts`, `windows.ts`, `staged.ts`, docs/research/globe/2026-10-20-lattice-impl.md); what carries over is the
  erosion's carried flood rounds (7 to 16 s a window where it was 17 to 45). `lattice.ts`, `windows.ts`, `windowOf` and
  their tests are deleted at Unit 6's cutover.
- [ ] **Unit 3: One camera from orbit to close.** The page's camera (`demo/styles/play/camera.js`, `main.js`, `live.js`,
  `worker.js`): altitude continuous; the sphere's projection eases into the ladder's isometric bearing below the `island`
  level's altitude; the close ground read through one interface (the ground's fields at a place) so its source can become
  the baked planet's tiles; the sim stays in its play area. Cutover: `?globe`, `?at`, the GLOBE button and G removed.
  Check: a recorded zoom from the whole planet to `close` and a long pan, no page error, frame times within the ladder's
  budget.
  Built 2026-10-20 (frame times, worker GPU ms a frame by zoom band, mean: 0.9 to 2 for the planet alone, 9 to 17 with the ladder
  against 7 to 24 for the island alone in the same sitting, on a GPU another agent's jobs shared and twice timed out, so the
  ladder's own budget is neither shown met nor missed): one zoom runs from the whole planet (zoom -7.2 at 2,000 km, from
  the radius in `place`) to `close`. The planet (`isopixel/planet.js`, camera `planet-cam.js`) is drawn in the render worker under
  the ladder's views (`webgpu.js` frame `under`); its camera eases from straight down with a 45 degree field to the ladder's look
  (60 degrees off vertical, the bearing turns it, a 3 degree field so the sphere reads as the ladder's parallel projection)
  between the whole planet and zoom -1.5, and agrees with the ladder's screen mapping to 0.2 to 0.7% there; the ladder fades in over
  zoom -1.5 to -0.5 and the play area's ground fades into the planet over 1.2 km at its edge (shade alpha). The camera holds
  `view.x, z` (the play area's metres) and `view.geo` (lat, lon) equal, whichever moved last; pans and zoom anchors under the cursor
  work in both (a cursor's ground stays put through the regime change). Close ground: `isopixel/ground-at.js` `closeGround` is the
  one interface (the island the generator makes, set down at the first ranked landing, north up); the pyramid's tiles replace the
  island there and nowhere else. Away from the play area a zoom in stops at the island level (no close ground there). Cutover done:
  `?globe`, `?at`, the GLOBE button, G, `play/globe.js` and the landing flow are gone; `?planet=0` draws the island alone for the
  renderer's own checks. Loaded to `body.ready` with no page error (default, `?planet=0`, `?sim=0`, `?seed=2`); a scripted zoom
  from the whole planet to close and back and a 15 s pan at `valley` recorded in `/tmp/globe-seamless/`. Still seams: the island is
  not the planet's land at its place (another coast and relief), so the play area shows as a diamond stamp over the planet from zoom
  -1.5 to about 1, with a dithered blue halo from its deep sea; the planet's sun is the island's (fixed later, see Unit 6); the island level
  at zoom -1 to 0 draws a larger art buffer than at 0 and costs more.
- [x] **Unit 4: The planet at 195.6 km.** The generator's coarse tiers at the new radius: tectonics, atmosphere, ice and
  sea level rerun, the planet store and bake keyed by it. Measure what it makes (land share, ranges, rain belts, ice) and
  write the gaps the small radius opens. Measure the cost of the 75 m tier before building it: cells, bytes per field,
  GPU time per global erosion step at tier 4, the number of staged calls, disk, and what the page must stream; decide
  4,096 or 2,048 a face from those numbers.
  Done 2026-10-20 (`docs/research/globe/2026-10-20-small-planet-impl.md`): the radius is a parameter through the planet's
  stages (`SMALL_RADIUS_M` 195,569.6 m; the 2,000 km pins hold), plate speeds and hot spots scale by similarity, the chain
  runs in resumable parts and the atmosphere marches 10 days (its step is 52 s on 1.2 km cells: 249 s a call at 30 days).
  Seeds 1 to 3: land 21 to 28%, highest 5.8 to 6.0 km, continents up to 71,000 km2, longest river 179 to 339 km, ice only
  on ranges; the atmosphere makes no wind (0.07 m/s) and so no rain belts (land 151 to 212 mm a year, 93 to 94% under 250
  mm) and a 12 K equator to pole contrast (gaps, not retuned). The global finer tier (`regional.ts`) was timed at tier 4 on
  the real planet: 100.7 million cells, 5.6 GB of solver buffers, one global flood 16 s in 1,280 rounds (1,664 on the
  planet with the longest rivers), one erosion step 19.9 s (24.5 s), deepest flow path 3,854 of 16,382 cells; tier 3 is 4.2
  s. Recommendation: **4,096 a face**; open for Unit 5: the island's other fine stages at 100 million cells and the disk a
  bake needs between stages are not measured.
- [x] **Unit 4b: Earth's similarity on the small planet.** Every dimensional constant in the coarse tiers that depends on
  planet scale (rotation, Coriolis, the circulation's widths, plate and orogen widths, flexural lengths, hot spot spacing,
  ice sheet lengths) is re-derived from the dimensionless number it carries on Earth, each cited and tagged; nothing tuned
  to a picture. Check on seeds 1 to 3: trade winds and westerlies, dry belts and wet belts, rain shadows, a wet mild west
  coast at mid latitude, polar ice, ranges as wide as Earth's in proportion; the misses written as gaps.
  Done 2026-10-21 (`docs/research/globe/2026-10-20-small-planet-impl.md`, R1768 to R1782, `src/gpu/globe/similarity.ts`):
  s = radius / Earth's = 0.0307; the spin is Earth's thermal Rossby number's (44.2 minutes), hot spots, the arc band, the
  wedge's sweeps, the channel's viscosity, creep, the shelf, the isostatic relaxation, the air's adjustment, the convective
  and cloud delays, the boundary layer and the vapour column each rederived from the number they carry on Earth; the
  2,000 km planet is the reference and scaled by nothing (every pin holds). Seeds 1 to 3: trades -4 to -5 and westerlies
  +6 m/s, Hadley edge 28.9 degrees, dry belt at 30 (395 mm against 4,000 at the equator and 1,000 at mid latitudes), rain
  shadows 0.68 to 0.72, wet mild west coasts, a 40 K equator to pole contrast. Misses written as gaps: polar ice (4 to 18%
  of polar land), range widths read over plateaus, tropics twice Earth's and dry interiors, aspect ratio, gravity.
- [x] **Unit 5: The 75 m tier over the whole planet.** The island's fine stages (erosion, hydrology, rain, climate, soil,
  ground) run as global solves at tier 4, coarse to fine, across tile and face edges, baked by stages into the tile
  pyramid. The scatter as a pure function of a tile's fields. Check: one drainage network (every river reaches the sea or
  a closed basin across tile and face edges), identity across two bakes, the island's stage invariants where they apply,
  pinned hashes.
  Done 2026-10-21 (`docs/research/globe/2026-10-21-planet-75m-impl.md`, sub-notes `-air`, `-water`, `-ground`): seed 1 on
  the planet of key 883a8d9387df baked whole in about 31 calls and 1 hour 55 minutes of GPU: tiers 1 to 4 each from the one
  above (the uplift a smooth field that keeps every tier-0 cell's mean; the first version, a constant to a block, left
  steps of 3 to 4 times the slope at every block's edge), tier 4 of 100.7 million cells (21.7 million land) one drainage
  network (bad 0; 8,939 receivers cross a face's edge, 127,126 a tile's); the island's terrain, air (1.1 s a tile), water
  (the exact global discharge, lakes decided once over the tier, 0.1 to 7 s a tile) and ground (0.1 s) stages run as tile
  stages on patches, the kernels widened by a format with the island's goldens unchanged; the scatter a pure function of a
  tile (8.8 to 14.5 million objects in 0.1 to 0.2 s). Pyramid 2,046 tiles, 338 MB; ground tiles 994 MB; stage files 16 GB.
  Tile independence: word for word for terrain and ground; not for the rain (lee waves reach past any halo: rms 6.7 mm of a
  849 mm p99), the deep water table near a patch's edge, and the sun across a face's edge (12% in the low-sun season): gaps.
  Still open: part-full lakes, meltwater valleys, river meanders, Unit 4b's rain budget.
- [x] **Unit 4c: Earth's lengths for rock and rivers.** Undo Unit 4b's scaling of every lithosphere, hillslope, river and
  glacier length (the amended scope above), keeping the atmosphere's. Find and remove the tier-0 structure that leaks
  into the fine tiers as 16-cell grid lines. Check on seeds 1 to 3: range widths and relief against Earth's ranges in km,
  the Earth-like facts table, land share; maps.
  Done 2026-10-21 (`docs/research/globe/2026-10-20-small-planet-impl.md`, Unit 4c; planet key `5905ad0148e6`): `similarityOf` keeps
  only `s` (spin, atmosphere, vapour, eddies, plate angular rate, hot spot count by area) and `cells`; hot spot footprint and flux,
  channel viscosity, wedge and flexure widths (5,648 and 3,346 sweeps), arc band, creep, shelf, sediment reach (980 rings), bed
  relaxation and the start's margins are Earth's. Ranges 2 to 8 times wider (15 to 119 km by the 2 km contour, Earth's 170 to 240)
  but the continents became plateaus (half the land over 2 km at 4.6 to 5 km, mean 2.3 km): the planet's rivers drain 5,700 to
  7,600 km2 at most, so Earth's incision law removes crust 30 times too slowly; rain shadow, rain belts and land rain fail
  (gaps in the note). Grid lines: the leaks are in regional.ts (Unit 5's files).
- [x] **Unit 5b: The 75 m tier as one solve, and landforms that read as eroded.** Rain and the water table as global
  solves (sweeps with halo exchange between tiles until converged, so a cell's answer does not depend on the tiling); no
  cap on rain concentration without a citation; tier-4 erosion run to its response time, so valleys dissect the ranges and
  rivers bend with the ground rather than running straight down planar faces. Check: two tilings give the same bytes; a
  tile PNG of a range and a coast judged against the island's look; then the full rebake on Unit 4c's planet.
  Built 2026-10-22/23: rain is a finite-support integer convolution with no cap, equal bytes under any tiling on real
  tiles (gaps: truncation 3 to 10% of the waves, block means not exact, face-edge rain and breeze the same law on two
  grids); the water table is a tier-3 global cascade plus 48-sweep patches seeded from it (not one solve: up to 26 m off
  on unanchored plateaus; the V-cycle does not converge); landforms are the island's own erosion law at tiers 1 to 5
  (response-time runs smear the planet to a peneplain, so falling steps of 26 to 1.6 My; one rain; drawn 8-neighbour
  receivers; B-spline uplift; 16-neighbour slides), judged on the 75 m PNGs, dendritic and without squares or rays; at
  the page's close zoom the ground is smooth (no detail finer than 75 m, a Unit 6 question). Note
  docs/research/globe/2026-10-22-planet-island-law.md and the impl log.
- [x] **Unit 7a: The planet at 391.1 km.** The coarse tiers rerun at the new radius under Unit 4c's rule (only radius and
  spin numbers scale); seeds 1 to 3 measured against the Earth-like facts; the plateau's cause checked (the founder trim
  that may throw crust away, rivers too small to incise) and fixed where it is a bug, written as a gap where it is the
  planet's size.
  Done 2026-10-21 (`docs/research/globe/2026-10-20-small-planet-impl.md`, Unit 7a; planet key `5a2d733bdf9d`): `PLANET_RADIUS_M`,
  `PLANET_TIER` and `PLANET_FN` in grid.ts, every globe script takes them; seeds 1 to 3 through every stage. Atmosphere: step 10 s,
  a call 95 to 98 s, settled (spin doubled: land mean 598.8 and 598.3 mm), budget 2e-5. Seeds: land 0.36 to 0.41, mean land height
  2.2 to 2.5 km, 17 to 21% of the planet over 2 km, longest ranges 145 to 257 km wide (Earth's 172 to 240) with 4.6 to 5.6 km summits,
  largest basins 24,000 to 81,000 km2. The plateau is not a bug: the founder trim (cited law) cuts 89% of the stacked crust (55% on the
  2,000 km planet), the notes already call the ranges flat tables at the limit, and incision is real metres but starved by basins 9 to
  16 times short in sqrt(area): gaps. Facts: winds and west coast pass; rain belts, rain shadow, polar ice and range summits fail.
  Amended 2026-10-21 (plateaus' missing process; key `7f6ff6c82cdd`): the channel flow run at 100% of its law (7,700 explicit sweeps)
  changes nothing (mean land height 3,120 and 3,118 m), so no implicit solve was built; the cause was the arcs' flux per km, 16 times
  Earth's per area on this planet, now times s (R1786): mean land height 2.2 to 2.5 km down to 1.3 to 2.1 km, over 2 km 17 to 21% down
  to 5 to 8%, land rain at 0 mm 36 to 40% down to 17 to 28%. What still holds the tables up: the founder limit (gap).
- [x] **Unit 7b: Solves that stream from disk.** Tiers 1 to 5 and the fine stages as global solves over tiles kept on
  disk, with halo exchange each sweep, inside 18 GB of memory and the GPU's buffer limits; the bake as resumable calls
  under 5 minutes each, driven in order; Unit 5b's one-solve rain and water table and response-time erosion carried over.
  Check: the same bytes as the in-memory solve on the 195.6 km planet's tier 4, then the full bake of seed 1 on Unit 7a's
  key, with time, memory and disk measured.
- [ ] **Unit 6: Cutover.** The page streams the pyramid at every zoom and the play area's Ground is cut from the planet's
  tiles (no `windowOf`, no `islandOf` generation); the lattice, windows, `windowOf` and Unit 1's sub-cell decoration are
  deleted; the island's Bornholm path goes with them, every caller migrated. VERSION bumped.
  Page half, part 1 built 2026-10-21 (dry-run pyramid, face 1 of key c418e5fe9b5e): the page streams the pyramid
  (`isopixel/pyramid.js`: tiles under the camera fetched, inflated and held in two GPU atlases, fields 16 B a cell and heights
  with a halo of 2, a page table per tile of every tier, tier 0 held whole, the finer tier replacing the coarser as it arrives,
  LRU of 192 layers) and the planet layer reads it at every zoom (`wgsl/globe.js` rewritten: the tier whose cells are about an
  art pixel, the cells' B-spline, cover, soil, rock, drift, rain, air, lakes and rivers from the tile; the sub-cell noise, the
  invented hillshade, the sea's swell, the climate's wander and the river line pass are deleted). `scripts/demo.ts` copies the
  newest pyramid under `/tmp/planet-75m` (`NOMADS_BAKES`) into the site and writes `planets/<seed>.json`; the radius is the
  cells' own (256 << (tiers - 1) cells of 75 m round four edges), the people's place is the tier-0 land cell with the most trees
  below 60 degrees. The camera is free anywhere at any zoom and stands above the ground under its target. Measured: a whole
  orbit to ground descent and a 40 km pan at valley fetched 86 tiles, 17 MB, so about 4 tiles (0.7 MB) a screen at the finest
  tier; worker GPU ms a frame 3.3 mean, 7.7 p95 on the pan (load average 4). Open: the ladder's close levels and the scatter
  need the per-tile ground files the pyramid does not hold (scatter.ts reads 49 B a cell of stage files; the painter reads
  windShare, pet, table, peat, silt, fog, snow, wet, moist and the river lines), asked of Unit 5; the play area is still the
  island generator's, so it is a stamp (another coast, relief and cover) with a 1.2 km faded edge over the planet; snow is the
  year's air under -6 C (the pyramid has no seasonal snowpack). Fixed 2026-10-21: the height halo (2 cells) and a new field halo
  (1 cell) are the neighbouring tiles' cells across a tile's and a cube face's edge by the grid's own rule (`cellAcross`), refreshed as
  neighbours arrive, checked on a synthetic field over every tile of tier 1 (24,768 halo cells, all the field's value at the cell that
  stands there); the camera is geodesic: the planet camera does the pan hold wherever the play area's plane (true to a part in a
  hundred) cannot be needed (farther from the place than the play area and the canvas's reach, or from zoom -1.5 out), on the sphere
  raised to the ground under the target as the worker drew it, so a drag moves the target by the pixel distance's ground distance
  (0.98 to 1.0 of it at zoom 6, 20 and 60 degrees from the place) and the held point stays under the cursor.
  **Superseded 2026-10-23 by Unit 8: the window below (Page half, part 2, and the window's costs) is kept as the record of what was built and measured; it is retired at Unit 8 step 5.**
  Page half, part 2 (2026-10-21 and 22; key 883a8d9387df, face 1 and an edge visited in Chrome, then code only while the bake ran): the ladder's
  levels draw anywhere from the planet's ground tiles. `isopixel/groundwin.js` makes a WINDOW of 256 by 256 cells at the camera from up to 4 interior
  and a few halo ground tiles (`groundtiles/f<face>/<ty>-<tx>.gt.gz`, streamed like the pyramid; across a cube's edge the face across's cells laid
  flat by `cellAcross`, receivers turned), runs the scatter's fine kernel on its cells (`demo/tile.ts` -> `tile.js`, `windowFine`: the same vertex
  whichever window holds it) and the painter's `packGround` on them (rows turned so z runs south), and the scatter of each interior tile cut to
  the window; the worker (`groundWant`, `applyGround`) switches the renderer's ground (`webgpu.js setGround`) and object source in the frame that first
  names the new ground (`gid`), and the page (`live.js`) puts its view in the window's frame (`FRM`: the place's plane re-anchored to the camera, the sky
  turned by the frame's rotation) so the plane is always about the camera's ground; the sim stays in the island's frame and there are no people or animals
  away from it. First window made in 4.5 to 7.7 s (tiles 0.1 to 0.5, fine 0.3, painter packing 0.9, scatter 2.7 to 6.2), 4 tiles, 5 MB;
  6 to 8 million objects; trees on the planet's own cover looked right at two places (a window 4 degrees east of the island, and one across the cube
  edge of faces 0 and 1; a third place and the stills for the report wait for the GPU).
  Memory audit (reading and a CPU test, `winobjects.js`): the leak was mine: `cut()` kept `subarray`s of arrays sized to the whole tile (26 bytes
  an object of a tile's 17.7 million, over 4 tiles about 1.8 GB held to the end of the build). A tile is now cut to exact-size arrays the moment it is made
  and let go, thinned by halves of its seeds' hash past `top` objects (the device's binding limit over 28 bytes a slot, at most 8.4 million; a thinning only
  drops objects), 20 bytes an object kept; measured on the CPU for 4 tiles of 17.7 million: 4.4 million kept at share 1/4, the body 224 MB, and the
  collector's own memory about 90 MB over the synthetic scatter's 300 MB. In the renderer a gone source's far lists, front lists and cell caches were
  never released (`forgetSource`, from `setSources`). The window was asked for at every step of a pan at a zoom where the view is wider than a window
  (island level), each a few seconds of GPU work: no window is asked for there now (the planet layer alone draws it). Ground tiles held: 8 (6 MB each);
  the scatter of a tile is never held. The scatter makes only the cells of each interior tile the window touches (`scatterTile`'s `window`, 8299f72; for a
  tile of another face the bounding box of the window's corners turned into its cells, inverse checked on the CPU to 6e-14 cells; a tile the window does not
  reach is not run at all).
  Verified in Chrome on the 195.6 km planet (2026-10-22, stills in /tmp/globe-seamless/): trees and shrubs of the planet's own cover at a forest on face 0
  (27.8 N 27.6 E, mixed conifer and broadleaf), at the cube edge of faces 0 and 1 (13.27 N 45.0 E, the edge down the middle of the window: trees run across
  with no gap), and a plateau on face 3 (28.0 N 63.5 W); a 14 km pan east re-anchored twice (one 78 ms frame at each switch, 0.1 ms otherwise), and
  the island came back in 1.5 s at its own place with its sim; no console errors or warnings. A window: 4.5 to 8.1 s (scatter 3.6 to 7.5 s on a GPU the bake
  shared), 5.8 to 6.4 MB of ground tiles, 6 to 8.3 million objects (share 1/2 or 1/4 of what the window holds: 8.3 million at share 1/2 is up to 16 million
  in the window), GPU 1 to 4.5 ms a frame at zooms 5 to 8.3 (an upper bound: the bake ran on the same GPU). Straight diagonal channels in the planet's
  data (a D8 stream down a plain: a river of 1 cell wide in a line for kilometres) draw as straight rills and, where a stream is wide, as a straight blue band
  (seen at 13.3 N 44.8 E at zoom 5): that is the bake's flow, not the window.
  Open: the thinning leaves a window at a half to a quarter of the island's tree density (`top`, 8.4 million slots, 235 MB); the page thread works out the
  camera's heights again (0.1 to 0.3 s) at each window switch; no people or animals away from the island by design.
  What the play area draws below its 75 m cells (2026-10-23, read and measured): the fine field (`fineGroundGpu`, `fineKernel` in
  `src/gpu/wgsl/terrain-scenery.ts`: a Catmull-Rom cubic through the 75 m heights at quarter steps (18.75 m), a ground swell of 2.6 m at 960 m and 0.8 m at
  240 m, the stream bed cut by the mask's coverage, the covers wandering at their edges, the wet cells), the stream mask (the raster of the streams'
  segments, 4.7 m texels), the scatter (`sceneryGpu`: trees, shrubs, clasts, sticks, mushrooms, herbs, ore), and the painter's 3 m ground
  (`ground.wgsl.js` over those and the 75 m fields). A window ran all of it already by the same code: `windowFine` runs `fineKernel` on the window's tiles'
  fields (the kernel's inputs are the 26 ground tile planes the tiles hold; none is missing from `GROUNDTILE_FIELDS`), the scatter is the tile's own, and the
  painter is `packGround`'s. Measured on the GPU (island seed 1 against windows of the second rebake): sub-75 m relief, the rms of the fine height over its
  75 m box, 0.95 m on the island, 1.26 m at range 574, 1.40 m at coast 1253, 0.52 m on a lowland; mean |second difference| at 18.75 m 0.18, 0.20, 0.16, 0.13 m. So the
  smooth look of a steep window is the 75 m field's (30 m of height a cell at range 574, the fine stage's metre-scale swell is under it), not a missing stage.
  Two inputs the tiles hold were not read, and now are: each stream's groundwater share and the flow its valley carries under its bed (`base`, `under`;
  the painter draws a stream dry where its flow is no more than the latter), and the water stage's runoff by season (`meta.quick`, per tile: weighted over the
  window's cells). The painter held the island's runoff as four literals in its shader text (every pipeline recompiled for a new value): it is now the two
  entries after the gradient table in `gGradT` (`g_quick`), filled by `packGround` from `isle.quick`, so the shader text no longer depends on the place;
  `ground-parity.ts` against main.js after the change: heightAt, waterAt, surfAt, bankColour 0 off, paintGround 0.002% off (3 of 150,000, each a threshold within a
  millimetre). The close stills of range 574 and coast 1253 are the same before and after (`/tmp/globe-seamless/before-*.png`, `after-*.png`): the streams
  there carry little under-bed flow.
  The camera snap-back (the first far visit after a load went back to the island): reproduced; the page opens following a person (`select(openingPerson)`),
  and a script's `view.geo` (or x and z) is not a gesture, so `followStep` cut the camera back to them after 3 s, and asked for a window about the camera
  every 5 s meanwhile. A view moved between frames by something other than the camera now lets the follow go (`placed` in play/main.js); a drag, pinch or
  wheel zoom behave as before (following still tracks a walker: checked on a fresh load). Also fixed: the page asks again every 5 s until the ground arrives and
  the worker made each ask's window (two builds for a 4 s one under load); a window already made for the same place is not made again (`built` in worker.js).
  Window costs now (the GPU free): ground tiles 0.04 to 0.24 s, fine ground 0.2 s, painter packing 0.5 s, scatter 0.5 to 3 s (the lowland, 6.5 million objects),
  1.3 to 4.2 s in all; about 6 MB of tiles.
  The planet's sun (2026-10-23; it was the play area's sun held 25 degrees up, so the globe was bright at any hour and dark once zoomed in): one sun and one moon for
  the whole planet, each a point of the sky fixed by its direction over the play area (the sim's bearing and elevation from sky.ts, whose island lies at its own
  latitude and whose clock is the game's 24 hour day), so the sim's light is exact over the play area and every other place sees that sky point from where it
  stands (`skyVec`, `bodyOver` in live.js). Reconciling the planet's spin with the game's day: the planet's own spin (44 minutes, a climate parameter) does not
  light anything; the game's clock moves the sun, once round the planet in a game day, rising and setting over the year's tilt as sky.ts has it, so the globe
  has a day side, a night side and a terminator that turn with the clock, and a place's light on the globe is its light at the close levels at that
  clock. A window (`mode "win"`) lights its own place with the same sun (`lightOf(..., at)`, `planetSky`: the body's bearing and elevation over the window's
  frame), replacing the old turning of the home sky by the frame's rotation. The globe is drawn through the ladder's own light tables (`lutT`, the shade
  pass's LUT: the palette at the key light's share on flat ground there, the moon's once the sun is down), times the sky's ambient light there against the camera's
  (`ambOf`, live.js `ambientOf`), so its dusk and night are the close levels' with no palette of its own; the HUD still reads the sim's sun. Stills in
  `/tmp/globe-seamless/`: `globe-sun-times-v2.png` (08:00, 13:00, 19:00, a night side from a day place, the subsolar side), `zoom-sequence-13h.png` and
  `zoom-sequence-19h.png`. Open: the moon's light on the globe is the home sky's single key row (no per-place moon phase or rise), the sun's low-elevation glow
  band is not drawn, and the window's sun is fixed at its centre while the camera moves inside it.
  Rotating the globe (`/tmp/globe-seamless/rotation-sequence-by-drag.png`): a pan held the target by its plane coordinates about the play area, which say nothing
  of a place more than a quarter of the planet from it, so a drag there did nothing or went back; it holds the target's planet place (`panBy` in camera.js). A
  drag toward a pole, which folded the answer back down the far side (north is up at every planet zoom), stops at the pole now (both poles at 90 degrees are
  reached; a full turn of longitude takes four drags of 450 px).

- [ ] **Unit 8: One quadtree, tiles produced on demand, the window retired.** Operator, 2026-10-23: "I don't like these set chunks that we load in. ... some kind of data
  streaming that works at any level for any space." Research: `docs/research/globe/2026-10-23-planet-streaming.md` (how Cesium, Far Cry 5, Flight Simulator, Proland,
  Outerra and others do it; the fit to this code). One tree of tiles at every level chosen by screen-space error; the pyramid's tiers 0 to 5 stay; tiers 6 and 7
  (37.5 m and 18.75 m cells, 256 cells a tile, a tier-7 tile is 4.8 km) are produced on the GPU by the fine kernel (`fineKernel`, Proland's procedural residual producer); the
  painter and the object culler read tiles through a page table; each tile's ground and objects are produced on demand under a per-frame budget and a hard-capped
  cache; a parent is drawn until its child is ready; no fixed window. Baseline (2026-10-23, GPU shared): a window built in 7.0 s the first time (scatter 6.3 s), 3.9 s and 2.5 s after;
  ground on screen 9.3 s after the start of a 2.3 s dive; frame gaps to 1.5 s. Gates at every step: the same pixels (`scripts/play/ground-parity.ts` and stills against the window),
  the same objects by id once a tile's objects have arrived, painter GPU ms within the ladder's budget (9 to 17 ms a frame with the ladder, Unit 3), and the operator-visible result.
  Fallback if the painter's page-table reads cost too much: a toroidal fill of the painter's inputs from the tiles (Losasso and Hoppe), leaving its reads as they are.
  Steps: 0 compile every kernel the producers use at load with `pipelineSoon`; 1 fine tiles (tiers 6 and 7) written into an atlas on the GPU with no readback, the painter
  reading them through the page table; 2 ground from tiles the moment they exist, one scheduler (priority, per-frame budget, parent fallback, prediction from the zoom goal and
  pan); 3 object tiles on the GPU, nothing read back, density nested by level with the seed-hash share, fading in nearest first; 4 wide levels (share by level, ground colour
  where a tree is under about 2 art pixels); 5 cutover: the play area's Ground cut from the planet's tiles, the window, `gid` and the 5 s re-ask deleted, an OPFS cache of tiles.
  Progress: Measurements 2026-10-23 (GPU free; `scripts/play/tilecost.ts` headless, and the live page by a dive harness): (1) a tier-5 ground tile's scatter on the GPU is cheap, warm 150 ms for 9.5 M objects (table 14, count 16 to 35, write 22 to 44, readback 34, host conversion 60), a 64 by 64 cell rectangle of it 50 to 70 ms of which the whole-tile table and count are 30; the window's fine ground 50 ms warm in Bun; on the page the same window costs fine 190 to 260, scatter 850 to 1,570 (4 tiles), JS cut 755 to 1,450, pack 460 to 520, and the first window pays 1.2 s more in the fine kernels and 2.6 s more in the scatter than the second. (2) painter at close zoom in a window: worker GPU 2.7 to 3.2 ms a frame mean, 3.6 p95 (baseline for the gate; Metal timestamps are unreliable). (3) a window's fine ground is 1,025 by 1,025 vertices; a tier-7 tile is 257 by 257, 1/16 of it: about 3 to 4 ms of GPU in Bun. (4) objects per 4.8 km rectangle of a forest tile: 1.8 to 2.0 M (56 MB at 28 B), 0 over sea; a tile's table and count are 30 ms and can be kept; the write pass of a rectangle 6 to 22 ms. (5) ids: the window source is the only source in window mode (`worker.js sources()`), has no pick, and the sim has no object there, so ids matter only for the equal-objects gate. Step 0 built: the window's kernels (`warmScatter`) and the window source's renderer passes in each cap (`warmSpec`, `passesOf`) are compiled at load; cold first window 9.8 s to 7.0 s after the dive start (fine 1,391 to 187 ms, apply 1,283 to 894 ms, scatter 4.8 to 2.9 s), warm windows unchanged; the remaining first-use cost (apply 0.7 s, scatter 1.4 s) is memory and first dispatches, not compiles [I].
  Step 1 built 2026-10-23 as GPU-resident producers (the lead agreed the order: producers first, per tile where the kernel allows, then ground-first and the early ask, then the addressing change). Ground: `windowGround` (`demo/tile.ts`, `src/gpu/wgsl/terrain-window.ts`) makes the ten fine layers as floats with the lattice cropped and turned, the stream mask with its rows turned and the 12.5 m light grid (heights, folds, slope, gradient) on the GPU from the fine kernel's integer lattice and hands them to `setGround` as buffers it copies into its textures; only the heights come back (`scripts/play/groundgpu.ts`: the fine layers equal bit for bit, the mask byte for byte, the light grid within 3.5e-4 m, the folds, slope and gradient within 1e-5, 39 ms against the CPU's 428); `dqBuild` is memoised (it was made for every window). Objects: the scatter's write kernel's arrays are put in the window's frame in whole 15 mm units (a turn by a quarter and a shift), kept by the share (`unitHash(seed)` under 2^-k, so the entries kept at a half are kept at a whole), appended to a staging list and binned by cell on the GPU straight into the renderer's source body (`src/gpu/wgsl/terrain-place.ts`, `src/gpu/globe/windowobjects.ts`, `objectsGpu` and `objectsWrite` split out of `objectsOn`); the share is the largest 2^-k whose estimate (the draws' counts over the rectangle) fits the slots, raised if the staged total comes out over. Gates: `scripts/play/winobjects.ts` against the CPU collector on a real tile: the same 8,601,853 objects at share 1 and the same 537,647 under 2^20 slots (same share), the same what, seed and cell, places within 1 mm, sizes within 1.2e-7 relative; on the page the same object counts and shares in the three windows (7,167,068 at 1/4, 5,806,557 at 1/4, 6,427,233 at 1/2); stills against the commit before at three places and three zooms, and across the cube edge of faces 0 and 1 (turned tiles), differ in 0.001 to 0.14% of pixels (largest channel difference 234 on a few), `ground-parity.ts` unchanged (paintGround 0.003% off, 3 of 100,000, each a threshold within a millimetre), `scenery.test.ts` goldens pass; painter GPU ms at close zoom 2.2 to 3.4 mean (2.7 to 3.2 before). Measured on the page: a window builds in 0.9, 1.0 and 0.8 s (7.0, 3.9 and 2.5 s before; pack 460 to 520 down to 22 to 32 ms, objects 1.7 to 6.3 s down to 0.5 to 0.64 s); ground on screen from the start of the dive 3.4 s cold (9.8), 2.7 s (5.7), 1.9 s (3.6); frame gaps over 25 ms 17 to 21 a dive (20 to 24), longest 1,349 ms cold (1,277; the cold apply, `setSources` and the survey, 1.3 s), 662 and 267 ms (782, 554). `winobjects.js` (the CPU collector) stays as the gate's reference until the window is deleted.
  Step 2 built 2026-10-23: the window's ground is given to the page the moment it exists and its objects follow (`build` returns the window with `startObjects`, started after the ground message; `windowObjects` posts the count and share); until they arrive the drawn source is an empty one of 2^20 slots, then `attachObjects` swaps in the real body, canopy, far lists and survey. A window made is kept (the last three, with their GPU ground and objects; `winCache`, `destroyWindow`, `setGround` no longer destroys a kept pack's buffers) and found again by place within 600 m, so a pan back or a zoom out and in shows the ground in 187 ms with its trees. The ask is early: `live.prefetch` (called every frame with a zoom's goal view, whose `goalView` now carries the goal's planet place) asks the worker for a speculative window at the goal's place when a window will be wanted there (`wantGround(view, now, true)`), the worker builds it and keeps it, the page's own ask then finds it; a speculative ask never displaces a real one. The window's ladder fades in over half a second from the planet layer when it replaces no window (`winFade` in `plan`). Measured, from the start of the dive to close ground on screen, ramp dive of 2.3 s: first place after load 2.57 s (the landing; 9.8 s at the start of this unit), second 2.28 s (before the landing; 5.7), flick of the wheel (the camera lands in 0.5 s): ground 0.66 s and its trees 0.97 s after the flick at a third place, 1.2 s at a fourth; the window's ground message takes 250 to 350 ms of the worker, objects 0.3 s more. Stills as step 1 (0.001 to 0.14% of pixels, the fade done), objects and counts unchanged. Still a wait: the first window after a load stalls the frames in 1.3 s steps (pre-existing, on the commit before this unit too: front lists and the first uses of the renderer's passes; not the window's kernels), and a place nobody asked ahead for takes the build time.
  Step 2, the pan (2026-10-23): the target's drift is carried 3 s on (`panAhead`) and the window wanted there is asked for speculatively; the worker answers an ask from any window it kept that covers the view (the page's own cover test, the ask names the view's half extent), so a pan asks for a window once, not at every step. Long pan east at 1,000 m/s for 20 s at zoom 6.5 over the first window of a load: before this unit 531 frames and 38 gaps over 25 ms, window switches at 11.9, 16.0 and 20.0 s each applied in 0.73 to 1.25 s; now 856 frames, 25 gaps (17 over 50 ms, the first 5 s of the session carry the pre-existing 1.3 s steps), switches at 10.9 and 18.9 s applied in 252 and 64 ms, no frame over 180 ms after the first 5 s but three. Dive numbers on the final build: ramp dive first place 2.56 s (the landing), second 2.28 s, third 1.57 s (landing 2.47 s); wheel flick to a place whose window is kept 0.17 and 0.14 s, with its trees.

## Risks

| Risk | Mitigation |
|------|------------|
| A global 75 m bake is slow (100 million cells; the flood's rounds grow with the distance water travels) | Coarse to fine, each tier starting from the one above; staged calls under 5 minutes; Unit 4 measures before Unit 5 builds; the 2,048 fallback |
| The page cannot hold the planet | It never holds it: the pyramid is streamed by the tiles under the camera at the zoom's tier |
| Similarity scaling breaks a law whose number does not scale | Each scaled constant names its dimensionless number; where none applies the constant stays and the miss is a gap |
| The sphere's perspective and the isometric bearing do not blend cleanly | Below the `island` level's altitude the curvature over the view is small, so the projection change is done there |
| Two agents in one tree | Disjoint files per unit; at most two agents at once |
