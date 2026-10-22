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
  -1.5 to about 1, with a dithered blue halo from its deep sea; the planet's sun is the island's held 25 degrees up; the island level
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
- [ ] **Unit 5b: The 75 m tier as one solve, and landforms that read as eroded.** Rain and the water table as global
  solves (sweeps with halo exchange between tiles until converged, so a cell's answer does not depend on the tiling); no
  cap on rain concentration without a citation; tier-4 erosion run to its response time, so valleys dissect the ranges and
  rivers bend with the ground rather than running straight down planar faces. Check: two tilings give the same bytes; a
  tile PNG of a range and a coast judged against the island's look; then the full rebake on Unit 4c's planet.
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
- [ ] **Unit 7b: Solves that stream from disk.** Tiers 1 to 5 and the fine stages as global solves over tiles kept on
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
  (seen at 13.3 N 44.8 E at zoom 5): that is the bake's flow, not the window. `ground-parity.ts` not re-run (the painter is unchanged: only
  `packGround`'s inputs are the window's).
  Open: the thinning leaves a window at a half to a quarter of the island's tree density (`top`, 8.4 million slots, 235 MB); the page thread works out the
  camera's heights again (0.1 to 0.3 s) at each window switch; the quick runoff constants in the painter stay the island's; no people or animals away from
  the island by design.

## Risks

| Risk | Mitigation |
|------|------------|
| A global 75 m bake is slow (100 million cells; the flood's rounds grow with the distance water travels) | Coarse to fine, each tier starting from the one above; staged calls under 5 minutes; Unit 4 measures before Unit 5 builds; the 2,048 fallback |
| The page cannot hold the planet | It never holds it: the pyramid is streamed by the tiles under the camera at the zoom's tier |
| Similarity scaling breaks a law whose number does not scale | Each scaled constant names its dimensionless number; where none applies the constant stays and the miss is a gap |
| The sphere's perspective and the isometric bearing do not blend cleanly | Below the `island` level's altitude the curvature over the view is small, so the projection change is done there |
| Two agents in one tree | Disjoint files per unit; at most two agents at once |
