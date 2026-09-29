# Nomads art-style mocks: shared brief

## Why
Nomads is a survival and colony game on one procedurally generated island (about 9.6 km across). The operator rejected two rounds of mocks because they all looked like the same thing: a smooth green heightfield with round blob trees under a tilt-shift lens, only recolored. This round, every mock starts from scratch and changes everything: how the terrain is represented, what the models are (sprites, voxels, tiles, paper, glyphs, paint), 2D vs 2.5D vs 3D, projection and camera, rendering technique, palette and light. Each mock must look like a finished, striking screenshot from a real game made in that style, not a tech demo. Dense and rich: lots of trees, grass and objects.

## Round four notes
- The operator LIKED: `hd2d` (HD-2D), `papercraft`, `isopixel` (isometric pixel), `ascii`, `watercolor`. You may READ their code in the sibling folders for ideas; never edit them unless the folder is yours.
- The operator DISLIKED and deleted: a 1-bit dithered Obra Dinn look, a voxel cube slab, and a Dorfromantik hex board. Do not drift toward those.
- Pixel-art styles should save lossless stills: name the job `<name>-<view>.png=<url>` and shoot.sh writes a PNG; the gallery will link `mocks/<name>-<view>.png`.

FORBIDDEN (already rejected): a smooth green heightfield with blob trees and a tilt-shift, recolored. If your mock could be mistaken for that, it failed.

## Your folder and page contract
- Repo worktree: `/root/repos/nomads-island` (branch `island-3d`). You own ONLY `demo/styles/<name>/`. Never edit anything else (not `demo/styles/world.js`, not `demo/island.ts`, not `scripts/`, not `demo/looks/`, not other styles).
- Plain browser ES modules, no build step, no npm installs. `index.html` + `main.js` (+ more modules if you like).
- three.js if you need WebGL, via importmap exactly:
  `"three": "https://cdn.jsdelivr.net/npm/three@0.186.1/build/three.module.min.js"`, `"three/addons/": "https://cdn.jsdelivr.net/npm/three@0.186.1/examples/jsm/"`.
  Other network sources allowed: jsdelivr (npm/gh), Poly Haven (`dl.polyhaven.org`, CC0). NO Google Fonts (they are blocked in capture). Prefer procedural textures drawn in canvas.
- World data: `import { grow } from "../world.js";` and, for people's clothing colors, `import { COLORS } from "../island.js";` (12 hex strings).
- URL params: `?view=island|valley|camp` (default `valley`), `&seed=N` (default 1).
  - `island`: the whole island in frame, an establishing shot.
  - `valley`: a few hundred meters around the camp with woods, water and rising ground: the main play zoom.
  - `camp`: close on the camp (3 tents, fire, 5 people, woodpile) with the grass, flowers, pebbles around it: where characters would be seen.
  Choose your own camera or projection per view; it should suit the style.
- Draw ONE still into ONE `<canvas id="view">` filling the viewport (capture viewport is 1280x720). The whole picture must be in that canvas. For WebGL: `new THREE.WebGLRenderer({ canvas, preserveDrawingBuffer: true })`. No animation loop needed.
- When the final frame is completely drawn (all fonts/textures loaded, last render done), `document.body.classList.add("ready")`. On any error: `document.body.dataset.error = String(e.stack || e)` and add class `failed` (use try/catch around main plus window `error`/`unhandledrejection` handlers).
- Performance: capture runs Chromium with SwiftShader (CPU WebGL, slow). Keep a frame under about 60 s. Never draw all 211k trees with real geometry: cull to the view, use levels of detail, merge or instance. Shadows are expensive; one shadow map, sized sensibly.

## World API (`grow(seed)`, about 2.2 s)
Coordinates are meters, y up, x east, z south, island centered on 0. Returns:
- `isle`: raw generator fields, each `Float32Array` of N*N (N=128, CELL=75 m), index `k = y*N + x`, world `x = START + x*CELL`, `z = START + y*CELL` (START = -4762.5, SIZE = 9600): `height` (m, <0 is sea floor), `water` (standing water depth: sea and lakes), `flow`, `tree`/`shrub`/`grass`/`marsh`/`bare` (cover shares, sum to 1), `sand`, `soil`, `silt`, `peat`, `moist`, `temp`, `precip`, `snow`, `exposure`, `salt`, `fog`, plus `rivers` (cell coords `[x, y, discharge]` lists), `wind`.
- Fine grid (M=509 per side, STEP=18.75 m): `h` (height), `cover.{tree,shrub,grass,marsh,bare,sand}` (smoothed, wobbly-edged shares), `wet` (0..1 standing water), `river` (0..1 stream mask), `moist`, `sky` (0..1 how much sky a point sees, good for AO).
- Samplers: `heightAt(x,z)`, `slopeAt(x,z)`, `fine(field,x,z)` (bilinear on a fine field), `dry(x,z)`, `riverAt(x,z)`, `bilinear(field,cx,cy)`/`bicubic` on coarse fields in cell coords, `at(field,i,j)`.
- `rivers`: smoothed streams in world meters, points `[x, z, discharge]`; `riverWidth(q)` in m.
- `trees` (211k): `{x,y,z,tall,kind:"pine"|"oak"|"ash"|"aspen",yaw,tint}`; `shrubs` (49k): `{x,y,z,tall,heath(0..1),yaw,tint}`; `rocks` (59k): `{x,y,z,size,yaw,tint}`. Placed from the cover fields; the ground around the camp is cleared.
- `camp`: `{ at:{x,y,z}, tents:[{at,yaw,size}] x3, people:[{at,yaw}] x5, woodpile:{x,y,z}, fire:{x,y,z}, uphill (angle the ground rises toward), from (the open side to view the camp from) }`. Angles: direction `(cos a, sin a)` in (x, z). Seed 1 camp is at about (-2738, 6.9, -1838) on the northwest coast by the sea.
- `nearby(center, radius, density=3)` -> `{grass, flowers, pebbles, logs}` scattered around a point (cost grows with radius^2 * density; use for the camp view).
- `rand()`: seeded random.
Everything you draw must come from this data (biomes emerge from the fields). Only the camp is placed by hand, and world.js already did that.

## Publish and render
- Publish your folder: `cp -r /root/repos/nomads-island/demo/styles/<name> /root/goldclaw/www/nomads-styles/` (served at `https://goldclaw.duckdns.org/nomads-styles/<name>/`). The root already has `world.js` and `island.js`; do not rebuild it.
- Render stills ONLY through the shared script (it serializes browsers across all builders and caps memory; it may wait for others):
  `/tmp/nomads-styles/shoot.sh /root/goldclaw/www/nomads-styles/mocks "<name>-island=https://goldclaw.duckdns.org/nomads-styles/<name>/?view=island" "<name>-valley=https://goldclaw.duckdns.org/nomads-styles/<name>/?view=valley" "<name>-camp=https://goldclaw.duckdns.org/nomads-styles/<name>/?view=camp"`
  It prints console errors and timings, and writes `mocks/<name>-<view>.jpg`. Look at every still with the read tool. For quick experiments, render to `/tmp/nomads-styles/<name>/` instead.
- Iterate: render, look hard at all three stills, fix the weakest thing, repeat. At least three review rounds. Before finishing, the three final stills must be in `/root/goldclaw/www/nomads-styles/mocks/`.

## Rules
- Never launch a browser any other way; never kill processes you did not start; after rendering, `pgrep -f headless_shell | wc -l` should drop back once your render finishes.
- Never open port 8095 or `goldclaw.duckdns.org/nomads` (the live game, it bills money).
- No git commands that write (no add/commit/stash/checkout). No formatters, linters or test suites.
- Code comments: only non-obvious reasoning, one line where possible, no ticket IDs. Never use em dashes or en dashes anywhere (code, comments, report).
- Scratch files only under `/tmp/nomads-styles/<name>/`; delete that folder when done.
- Final report (short): two sentences on what you built and how the style works, the three still paths, and honest known weaknesses.
