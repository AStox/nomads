---
title: "feat: a globe to turn and zoom, and a landing that makes the game's ground where it is clicked"
type: feat
status: active
date: 2026-10-19
---

# feat: the globe viewer and the landing

The operator: a globe to turn, coarse detail far out and more as it comes near; nearer still the cursor shows the game's
square, and a click makes that square the game screen; back on the globe another click makes another.

## Design

- **Data.** `scripts/globe-bake.ts` runs a seed's planet by stages (the window's `buildStage` into the planet store of
  `scripts/globe-window.ts`, each call under five minutes) and exports two files from the kept planet
  (`src/gpu/globe/bake.ts`): `view-<seed>-<key>.bin`, the viewer's quantised fields (scales in bake.ts), and
  `planet-<seed>-<key>.bin`, the Planet fields `windowOf` reads at float32, so the page's window is the one Bun makes at
  the same place. `<key>` is the store's key (a hash of the globe's sources), so a browser's cached copy is never stale.
  The export is kept in `~/.cache/nomads-globe/` and `scripts/demo.ts` copies the newest one into `<out>/planets/` with
  `<seed>.json` (the file names, the key and the ranked landings).
- **Globe view.** `/play/?globe` (a mode of the play page; a GLOBE button and the G key reach it from the game). WebGPU,
  one full-screen pass: each pixel's ray meets the sphere, the hit is put on its cube face and the tier-0 fields are read
  there (height by a cubic B-spline, so the hillshade's normal is smooth; the rest bilinear), so every zoom is per pixel
  and needs no mesh. A 2D canvas above draws the rivers, the landings, the cursor's square and the readout.
- **Landing.** A click navigates to `/play/?seed=<s>&at=<lat>,<lon>`: the render worker loads the planet file (kept in
  the Cache API by name), builds the Ground with world.ts `windowIslandOf`, and the game starts on it. GLOBE or G goes
  back to `?globe`, whose camera is kept in sessionStorage. The old place's game state is discarded.
- **Zoomed detail is tier 0 smoothed** (12 km cells under a cubic B-spline); a tier 1 to 3 refinement of the visible
  patch would add more.

## Progress log

- 2026-10-19: design above; coordinating with the window work (signature `windowOf(gpu, planet, lat, lon)`, world.ts
  `windowIslandOf(seed, lat, lon, planet)` added there).
- 2026-10-19: built. `src/gpu/globe/bake.ts` (the two records), `scripts/globe-bake.ts` (stages, export, `copyGlobes`),
  `demo/globe.ts` (the viewer's bundle, `<out>/globe.js`), `demo/styles/play/globe.js` and
  `demo/styles/isopixel/wgsl/globe.js` (the view), `?at` through main.js, live.js and worker.js `landAt`, the GLOBE
  button. Seed 1 is baked from the planet store's key 32ce99aec2ef (the current sources' key had no planet built):
  view 1.1 MB, planet 20.9 MB gzipped. Checked in headless Chrome, no page errors: the globe is ready 0.4 to 0.6 s
  after navigation; a click to the game's first frame took 52 s the first time (the planet's download into the Cache
  API and the kernels' first compile) and 23 s after; back to the globe 0.17 s with the camera kept. Screenshots in
  /tmp/globe-view/.
- To rebake after the globe's sources change: `bun scripts/globe-bake.ts --seed 1` until it says baked (each call
  under five minutes, about three calls), then rebuild the site. `?lat=&lon=&alt=` (degrees, m) open the globe there.
