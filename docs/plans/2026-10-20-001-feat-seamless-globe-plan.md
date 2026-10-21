---
title: "feat: one seamless view from the whole planet down to the game's ground, in the island's art"
type: feat
status: active
date: 2026-10-20
amends: docs/plans/2026-10-19-002-feat-globe-viewer-plan.md
---

# feat: one seamless view from the whole planet down to the game's ground

## Overview

The operator (2026-10-20), on the globe viewer: the planet is cool, but its art is not the island's. The island's art
(the isopixel look: one fixed palette, ramps, dithered sea and shallows, hillshade in palette steps, the ladder's fixed
bearing) should carry through to the planet's scale. And the globe and the game should not be two modes: zoom from the
whole planet all the way into the play area and back out without a cut, and pan at any zoom, endlessly, with the whole
planet there at once and only the play area's worth of it shown in full detail at a time.

Today they are two pages: `/play/?globe` (a lit sphere, a photographic look, 12 km cells smoothed) and a click that
navigates to `?at=lat,lon`, builds one window in about 23 s, and starts the game there.

## Requirements

- R1. One art. The planet at every zoom is drawn with the island's palette (`demo/styles/isopixel/pal.js`) and its ways of
  drawing: colours are palette indices, light is the ramp steps the ground painter uses, sea by depth with the island's
  dithered shallows, snow, rock and cover as the island shows them. Set side by side, the planet seen from afar and the
  island at its `island` level read as one picture.
- R2. One view. No mode switch, no page load and no cut between the planet and the play area. Altitude is continuous from
  the whole planet to the ladder's `close` level; the projection goes from the sphere to the ladder's fixed isometric
  bearing as it comes down; each finer picture fades in over the coarser one where they agree (the window's mean is the
  planet's, by the remap).
- R3. Endless pan. At any zoom the camera moves anywhere on the planet. Windows (the 19.2 km, 75 m refinement) sit on a
  fixed lattice of the cube-sphere, are made on demand under the camera, kept by (seed, sources key, lattice cell) and
  made again identically in any visit order; neighbours meet without a visible seam.
- R4. The sim runs in one window, the one the people are in. Elsewhere the ground and what grew on it are drawn, with no
  people or animals moving. Coming back shows them as they are.
- R5. The house rules hold: integer GPU kernels, counter-based randomness, byte-identical runs, every constant cited or
  tagged, a failing check written down as a gap and never retuned, nothing run over 5 minutes, the island path's goldens
  unchanged until the cutover.

## Scope boundaries

- The play area stays 19.2 km (`SIZE`). The operator said 75 km; the window has always been 19.2 km, so that is
  [INFERENCE] a slip. A larger play area is a separate decision.
- People do not travel between windows (the 2026-10-19 decision stands); the camera does.
- No new physics in the planet. Detail between the planet's 12 km cells and the window's 75 m comes from the window and
  from a cheap tier (Unit 4), not from rerunning the planet.

## Key decisions

- **The globe's look is the ground painter's, not a second palette.** The planet's fields (height, rock, rain, warmth,
  ice, sea depth) are mapped to the same cover classes and ramps the island painter uses (`ground.wgsl.js`,
  `pal.js` `P` and `RGB`), rendered at the ladder's art-pixel size and upscaled by whole pixels, nearest.
- **The window lattice is the cube-sphere's own.** Each face is cut into squares of 19.2 km in its equiangular
  coordinates, so every point has one window and its neighbours are known across face edges; `windowOf` is called at a
  lattice cell's centre. Seams: each window keeps a margin it shares with its neighbours, blended across, and rivers
  enter and leave at the coarse planet's crossings (already how `windowOf` takes its inflow).
- **One renderer.** The globe pass becomes the base layer under the ladder's levels inside the render worker, not a
  separate page; `?globe`, the GLOBE button, G and `?at` go at the cutover.

## Implementation units

- [x] **Unit 1: The planet in the island's art.** `demo/styles/isopixel/wgsl/globe.js`, `demo/styles/play/globe.js`.
  Palette indices, the painter's cover classes and light steps, dithered sea and shallows, art pixels upscaled by whole
  pixels. Check: screenshots of the planet whole, at 500 km and at 50 km, beside the island at its `island` level.
  Done 2026-10-20: every pixel is a pal.js index (cover mixed as g_rgb does and put in by dqBuild's dithered pair, soil,
  sand, rock and ice ramps, the w ramp for the sea with the surf line and dithered shallows, TONE rows for the light), drawn
  at a 2 px art pixel and shown by whole pixels; rivers are Bresenham lines of art pixels on the w ramp. Cover comes from
  Holdridge's PET and Koppen-Geiger's BW rule on the planet's year-mean air and rain. Shots in /tmp/globe-art/final-*.png.
  Still off: below 12 km the picture is noise on the cells, not terrain (Unit 4); the planet's rain is 0 on three quarters
  of the land, so most of it reads as desert and bare ground; the hillshade below the 12 km cells is invented relief
  scaled by the cell's own ruggedness.
- [x] **Unit 2: The window lattice and streaming.** `src/gpu/globe` (a lattice module beside `window.ts`), worker-side
  making and keeping. Lattice cells on the cube-sphere, `windowOf` at a cell, neighbours across face edges, the shared
  margin and its blend, a cache by (seed, key, cell), the time per window measured and the order windows are made in
  under a moving camera. Check: two neighbouring windows' shared edge (height difference along it, rivers that cross it),
  any-order identity, timings.
  Done 2026-10-20 (`docs/research/globe/2026-10-20-lattice-impl.md`): `lattice.ts` has 222 by 222 cells a face with a pitch
  of 10 to 14.2 km, not 19.2 km squares (windows must overlap to blend, and the cells shear to 60 degrees at the cube's
  corners); `windows.ts` has `windowAtCell`, the window's bytes, the `Windows` cache and queue and `wanted`; `windowOf` takes
  a frame (the window's axes are the cell's, its sun and wind turned) and a window of a cell is the same bytes in any visit
  order. A window went from 17 to 45 s to 7 to 16 s (every erosion run was made twice: the island's 192 flood rounds never
  settle a window, 384 do; same bytes). Seams measured on four pairs, two across a face edge: 63 to 809 m rms along the
  shared edge, rivers 1.4 to 11.5 km apart where they cross, written as gaps and not tuned. Open: no window poleward of 64.1
  degrees or at a river over 4,369 m3/s, and the remap's per-window shift (3 to 65 m of the seam).
- [ ] **Unit 3: One camera from orbit to close.** After 1 and 2. The page's camera (`demo/styles/play/camera.js`,
  `main.js`, `live.js`, `worker.js`): altitude continuous; the sphere's projection eases into the ladder's isometric
  bearing below the `island` level's altitude; the planet drawn under the window tiles while they are made, each fading
  in; panning across lattice edges streams the next window; the sim stays in its window. Cutover: `?globe`, `?at`, the
  GLOBE button and G removed. Check: a recorded zoom from the whole planet to `close` and a long pan at `valley`, no page
  error, frame times within the ladder's budget.
- [ ] **Unit 4: A regional tier that the windows agree on.** Two problems with one cause: between the planet's 12 km
  cells and a window the view is the planet's B-spline (blurred at a few hundred km across, with Unit 1's invented
  sub-cell hillshade on it), and neighbouring windows erode independently, so their shared edges differ by 63 to 809 m
  rms and their rivers cross 1.4 to 11.5 km apart. A tier between them (a quadtree tier of about 1.5 km cells over the
  whole planet, so it has no patch seams of its own, baked by stages like the planet and made from it by a remap that
  depends only on the ground point) fixes the drainage network and the mean
  surface once; every window then refines under it with its rivers pinned where the tier's cross its edges, so
  neighbours agree by construction. The tier is also what the view draws between 12 km and 75 m, and Unit 1's invented
  hillshade is deleted. Check: the seam residual on Unit 2's four pairs before and after, rivers' crossing distance, the
  island path's goldens unchanged.

## Risks

| Risk | Mitigation |
|------|------------|
| A window takes about 23 s to make, too slow for a pan | The planet in the island's art is shown first and the window fades in; Unit 2 measures and orders the work; neighbours are made ahead of the camera |
| Erosion is not local, so neighbouring windows will not match at the edge | The shared margin's blend and the coarse river crossings; the residual is measured and written as a gap |
| The sphere's perspective and the isometric bearing do not blend cleanly | Below the `island` level's altitude the curvature over the view is tiny (19.2 km on 2,000 km), so the projection change is done where it is invisible |
| Two agents in one tree | Disjoint files per unit; at most two agents at once |
