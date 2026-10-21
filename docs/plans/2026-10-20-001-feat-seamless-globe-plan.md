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
- The planet's physics is unchanged; only its radius changes. A small planet with Earth's physics has compressed
  climate belts and room for few ranges; that is accepted and written as gaps, not tuned away.

## Key decisions

- **The planet's size is set by the grid.** 4,096 cells of 75 m along a cube face's edge (16 of the 256-cell tiles the
  kernels run on), so the radius is 4,096 x 75 m x 2 / pi = 195.6 km [derived], 6 x 4,096^2 = 100.7 million cells.
  Tier 0 stays 256 cells a face (1.2 km cells); the 75 m tier is tier 4. If the bake or the page cannot hold that, the
  fallback is 2,048 a face (97.8 km, 25 million cells), decided by Unit 4's measurements, not by taste.
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
- [ ] **Unit 4: The planet at 195.6 km.** The generator's coarse tiers at the new radius: tectonics, atmosphere, ice and
  sea level rerun, the planet store and bake keyed by it. Measure what it makes (land share, ranges, rain belts, ice) and
  write the gaps the small radius opens. Measure the cost of the 75 m tier before building it: cells, bytes per field,
  GPU time per global erosion step at tier 4, the number of staged calls, disk, and what the page must stream; decide
  4,096 or 2,048 a face from those numbers.
- [ ] **Unit 5: The 75 m tier over the whole planet.** The island's fine stages (erosion, hydrology, rain, climate, soil,
  ground) run as global solves at tier 4, coarse to fine, across tile and face edges, baked by stages into the tile
  pyramid. The scatter as a pure function of a tile's fields. Check: one drainage network (every river reaches the sea or
  a closed basin across tile and face edges), identity across two bakes, the island's stage invariants where they apply,
  pinned hashes.
- [ ] **Unit 6: Cutover.** The page streams the pyramid at every zoom and the play area's Ground is cut from the planet's
  tiles (no `windowOf`, no `islandOf` generation); the lattice, windows, `windowOf` and Unit 1's sub-cell decoration are
  deleted; the island's Bornholm path goes with them, every caller migrated. VERSION bumped.

## Risks

| Risk | Mitigation |
|------|------------|
| A global 75 m bake is slow (100 million cells; the flood's rounds grow with the distance water travels) | Coarse to fine, each tier starting from the one above; staged calls under 5 minutes; Unit 4 measures before Unit 5 builds; the 2,048 fallback |
| The page cannot hold the planet | It never holds it: the pyramid is streamed by the tiles under the camera at the zoom's tier |
| A small planet with Earth's physics looks like one island with one range | Accepted by the operator; measured in Unit 4 and written as gaps |
| The sphere's perspective and the isometric bearing do not blend cleanly | Below the `island` level's altitude the curvature over the view is small, so the projection change is done there |
| Two agents in one tree | Disjoint files per unit; at most two agents at once |
