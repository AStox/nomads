# Isopixel renderer map (scout report)

## 1. Pipeline in main.js (main() L1864-1920)

The first four stages set up the camera and data. Stages 5-15 draw.

| # | Stage | Where | What it loops over | Cost (estimated, not measured) |
|---|---|---|---|---|
| 0 | `grow(SEED)` | L1869 → world.js L29 | See §4 | about 1-1.5 s |
| 1 | `makeView` | L59 | Picks the target (L170: argmax scans over 128² cells, lake flood fill, coast 7×7 windows), `campShot` (L227, up to about 16k `fine` samples), then `fitIsland` or `fitLocal`, then `frameTiles` | See below |
| 1a | `fitIsland` | L93 | Pushes every land cell (about 8k) into a list, then tries tileM from 400 down to 62 in steps of 2, re-projecting the whole list each time (about 170 × 8k) | Moderate |
| 1b | `fitLocal` | L141 | 25² height samples, then a 33²×4 slope sample, sort, then `frameCamp` (L241: 936 candidate offsets × trees within 110 m) | Small |
| 2 | `buildMap` | L283-477, see below | Tiles and vertices of the window | about 0.1-0.3 s |
| 3 | `shadowTest` | L480, installed L1883 | Returns a per-query sun-ray march: up to 80 steps of 0.3 tile, each calling `M.ground`, which allocates a subarray and an object (L467-474) | Paid per pixel in stage 6 |
| 4 | `mistField` | L1812, installed L1884 | Returns a per-pixel closure: about 7 `heightAt`/`fine` calls plus up to 4 noise calls; lakes use `sy/V.AH` (L1822) | Paid per pixel in stage 6 |
| 5 | `collectObjects` | L904-1152 | See below | about 0.2-0.5 s |
| 6 | `drawTerrain` | L762-889 | See below | about 1-2 s, the largest share |
| 7 | `rings` | L1779 | Sea-stack foam arcs | Tiny |
| 8 | `drawObjects` | L1661 | Sort O. Shadows: `castShadow` writes 2 px per opaque sprite px, `meshShadow` for tents. Then `blit` or `drawMesh` for each object. Then a full-frame tent-outline scan (230k px) | Tens of ms |
| 9 | `spray` | L1797 | Waterfall foot | Tiny |
| 10 | `mist` | L1842 | Full frame, 3 hashes per pixel | about 10-20 ms |
| 11 | `fireGlow` | L1685 | Small ellipse, GLOW LUT, only on id==0 pixels | Tiny |
| 12 | `drawSmoke` | L1707 | A few puff discs | Tiny |
| 13 | `clouds` | L1738 | Island view with adventure theme only; blob tests per pixel in a few boxes | Small |
| 14 | `haze` | L1854 | Top 42% of rows, bayer, HAZE LUT | Small |
| 15 | Output | L1905-1909 | `Buf.toImage` (px.js, new ImageData each call, 230k px), then one nearest-neighbour `drawImage` scaled by S | Small |

The peak view calls `buildMap` a second time (L1874-1881).

`buildMap` (L283-477):
- Vertex levels: VL = round(hsample/levelM) (L286).
- Per-tile classification: 5 sample points per tile, or 9 on the island view (L304). Each point takes wet + 6 covers + moist + exposure samples, so 45-81 samples per tile (L305-333).
- Two BFS passes: `toSea` capped at 10 (L349) and `toRock` capped at 3 (L360). The coast view adds a headland pass (L353).
- Water floor clamp.
- Per-vertex `keep` decision: 4 `hsample` calls per vertex plus `tileAt` probes (L378-387).
- `settle` slope limiter: up to 6×2 passes over the vertices × 4 neighbours (L388-402).
- Rivers rasterised into one-tile channels along `w.rivers` (L405-432).
- Corner clamps and triangle-diagonal choice (L433-449).
- Shore BFS (L453-465).
- `M.ground`, which interpolates the rendered triangles (L467-475).

Output arrays per tile: kind, wlev, surf, cls, C[4] (corner levels), diag, hc, moist, heath, snow, cov[6], toSea, toRock, head, shore.

`collectObjects` (L904-1152):
- Island view (L907-980): all 211k trees are binned into per-tile counts, then up to 5 mini sprites per tile; HILL rocks and scrub thickets are added per tile.
- Other views:
  - `trodden()` (L983 → L1426) installs `V.trodden`, and its nearest-wood search loops over all trees.
  - Trees (L1006), shrubs (L1018) and rocks (L1053, or the clumped bins at L1027-1052) each do a full array pass with `inView` (a toUV allocation) and `clear`, and only in-view items get `place` + `cached(SP.*)`.
  - `giants` makes one more full pass over the trees (L1005).
  - Camp-only extras: understory (L1062), stumps (L1089), `w.nearby` grass and flowers (L1122).
  - Reeds per tile (L1110).
  - `clumps` (L1156, dense=2).
  - `landmarks` (L1256), `wildlife` (L1359) and `campObjects` (L1465). These use `tilesInView` + `spaced()`, which is O(candidates × picks).

`drawTerrain` (L762-889):
- Per-vertex light (L766-777). The peak view adds a blurred normal and curvature (L781-802).
- Tiles are drawn back to front by diagonal s=i+j (L807). There is no z test on terrain; each tile simply overwrites what is behind it.
- Per tile: build the K object (L813-829), up to 2 cliff `strip`s (L831-858), then 2 `tri`s (L859-887).
- Per pixel, inside the tri callback (L868-886):
  - `V.toW`, which allocates an array.
  - Biome blend: 2 fbm (L873-877).
  - `texTop` → `texLand` or `texWater`: about 4-10 noise calls.
  - `V.trodden` in valley/camp: every path segment plus an fbm, per pixel (L580-586, L1451).
  - `V.mist` (L880).
  - The `V.shaded` march (L884).
- Walls call `texWall` per pixel.
- Overdraw from hidden back tiles is about 1.2-2x [INFERENCE].

## 2. Inputs and the view system

Fields read from the `grow()` result:
- Grid and noise: isle.{height, water, exposure, snow, bare, wind}, N, CELL, SIZE, START, STEP, at, bilinear, fine, heightAt, riverAt, dry.
- Fine fields: cover.{tree, shrub, grass, marsh, bare, sand}, wet, moist, sky, river, rivers.
- Scatter: trees{x,y,z,tall,kind,yaw,tint}, shrubs{…,heath}, rocks{…,size}.
- Camp: {at, from, fire, tents[{at,yaw,size}], people[{at,yaw}], woodpile}, plus nearby(center, r, density).
- Also imported: fbm, noise, smooth.

CFG (L27-34), per view:
- S: screen px per art px.
- W: tile width in art px; the tile diamond is W×W/2.
- lp: art px per height level.
- tileM: meters per tile, i.e. the zoom.
- exag: maximum vertical exaggeration.
- cliff: rise/run above which a drop is kept as a cliff.
- relief: target relief in px, used for the exag fit.
- detail, foam, deep, sparkle, grid, gain, cell: texture knobs.
- focus: [fx, fy], the screen fraction where the target lands.
- treeK, campK, campOff: sprite scale and camp spread.
- tsun: overridden to SUN·0.75 when LOWSUN, which includes the default adventure theme.

Camera definition:
- Origin (ox, oz) and bearing `from` → basis eu, ev (L66-67).
- `V.scale(tileM)` gives k = W/(tileM·√2) art px per meter and levelM = lp/(k·0.866·exag) (L68).
- Projection: sx = X0+(u−v)·H, sy = Y0+(u+v)·H/2 − lev·lp, cz = 1.5·H·(u+v) + lev·lp (L71-73).
- X0/Y0 come from `focus` (L162-163).
- `frameTiles` (L131) sets i0..i1, j0..j1 and the `visible`/`objVisible` culls from AW, AH, X0, Y0 and the level range.

Can it render an arbitrary window? Not as written:
- The math would allow any (origin, phi, tileM, X0, Y0), but there is no API for it. `target()` is keyed by VIEW.
- exag is re-fitted from local relief and slope statistics (L149-156).
- The map M exists only for the window, and `settle`, the BFS passes and the level quantization are window-dependent. Panning would rebuild M and change heights and cliffs.
- About 60 `VIEW`/`FAR`/`LOCAL`/`THEME` branches change behaviour per view.
- Screen-relative terms: water sun gradient `x/V.AW + y/V.AH` (L542), lake mist `sy/V.AH` (L1822), giant pick `onScreen`/`at.sy > 0.35·AH` (L1004), island fit `AW·0.86` (L117), haze by screen row.
- Every hash and dither is keyed on buffer pixel x, y (h2, bayer, stone, noise(x0/6…)), so a shifted origin makes the texture swim.

Output size: not a fixed 640x360.
- AW = ceil(innerWidth/S), AH = ceil(innerHeight/S) (L1866-1868). canvas#view is resized to the window.
- The default px=2 on a 1280×720 viewport gives 640×360, scaled 2x.
- px=1 gives 1280×720 at 1x; px=3 gives 427×240 at 3x. `scaled()` (L1731) rescales W, lp, foam and cell, and Z=2/PX rescales art-pixel constants.

## 3. Static vs animated

FRAME (L21) and PH = FRAME/8·2π are used in:
- `texWater`: foam lap (L531), ripple-dash life (L543), sparkle (L546). This is every water pixel, inside the terrain raster.
- `texWall` FALL streaks (L732-736).
- Eagles (L1264).
- Flock (L1293-1299) and island gulls (L1338).
- Fish (L1402, shown in 4 of 8 frames).
- Sea gulls (L1407-1411) and butterflies (L1414-1419).
- Flames: `cached('flames'+FRAME)` (L1536).
- `drawSmoke` puff phase (L1711).
- `rings` (L1781-1790), `spray` (L1807), `clouds` drift (L1746).

Static: all land texture, lighting, terrain shadows, mist, haze, trees, shrubs, rocks, reeds, deer, rabbits, herons, tents, woodpile and people (poses are fixed).

Composition: a full redraw on every page load, with no animation loop. The only caches are the in-memory sprite `cache` Map (L892), `w.summit` (L1348) and the per-tile `K.alt` blend Map. Animating the water today means re-running the whole terrain raster.

## 4. Where time goes

None of this is measured; `?debug=1` (L1904) only logs view parameters, not timings. To get real numbers, wrap `performance.now()` around L1869, L1872, L1888, L1889 and L1891.

grow() (world.js):
- `generateIsland`, from the source: 50 erosion steps (priority flood, receivers, accumulate) plus up to 600 water-table iterations on 16k cells. Roughly 0.2-0.5 s; the game's own comment says 'a good fraction of a second'.
- River mask: thousands of canvas stroke segments, then `getImageData` of 2048² (16 MB). In headless Chrome this may be a GPU readback through SwiftShader.
- Fine grid: 259k vertices × (bicubic + 8 bilinear + 17 noise calls) ≈ 4.4M noise calls.
- Sky view factor: 259k × 8 directions × 8 reaches = 16.6M `heightAt` calls. This is probably the largest item in grow.
- Scatter: 258k quads producing 211k trees, 49k shrubs and 59k rocks, each with `dry`/`slopeAt`/`heightAt` checks.

Terrain raster: 230k px × about 3-5 µs × overdraw. The main per-pixel costs are:
- The shadow march, up to 80 `M.ground` allocations per pixel.
- `V.trodden`: every path segment (up to about 200) plus an fbm, per pixel, in valley and camp.
- Mist: 7 samples plus 4 noise calls.
- 4-10 noise calls of texture.
- Per-pixel `toW` and array destructuring allocations.

The rest:
- The four full passes over the scatter arrays (trees ×3, shrubs, rocks) cost about 700k `toUV` allocations.
- Sprite painting is cheap because sprites are cached by quantized key.
- Tree drawing is culled to the view: only in-view trees are placed and blitted, about 2-3k in the valley view [INFERENCE]. The island view draws minis per tile, not per tree.

## 5. Sprite API

Sprite object: `Spr(w, h, ax, ay)` (px.js). `p` is a Uint8Array of palette indices with 255 as transparent. (ax, ay) is the ground-contact pixel.
- `blit(B, s, bx, by, cz, id, mirror, bias)`: depth of row y = cz + (ay−y) + bias, z-tested; it writes c, z and id.
- `castShadow(B, s, bx, by, V.shx, V.shy, mirror)` flattens the silhouette along the sun and darkens only terrain pixels (id 0), once each.
- `add()` (L906) defaults bias to H/2+2. Birds use `sky()` with z=1e9 (L1229).
- Tents are real triangle meshes (`tentMesh` L1555, `drawMesh` L1594) with z-test, lit by L3, with a projected `meshShadow` (L1651).

sprites.js exports:
- R (ramps).
- `pine(hpx, seed, snow=false, dim=0)`, `broad(hpx, kind, seed, tint, dim=0)`.
- `bush(size, seed, heath, berries)`, `rock(size, seed, moss)`, `tuft(hpx, seed, dry)`, `flower(hpx, hue, seed)`, `reeds(hpx, seed)`, `pebble(size, seed)`.
- `mini(kind, rp)`, `miniRock(big, snow)`, `miniTent(scale)`.
- `person(hpx, cloth, facing 'front'|'side'|'back', pose 'stand'|'sit', seed, side)`: tiny under 9 px, small 9-16, big above.
- `fern(size, seed)`, `rod(len, side)`, `stump(r, hpx, seed)`, `log(len, r, dir, seed, pale)`, `woodpile(r, seed)`, `flames(hpx, seed)`.

life.js exports:
- `deer(hpx, pose, facing, seed)`, `rabbit(hpx, pose, seed)`, `heron(hpx, pose, seed)`.
- `bird(span, frame 0..3, kind 'gull'|'crow'|'eagle', seed)`, anchored at the body centre.
- `fish(frame, seed, len)`, `canoe(len, dir 0..3, seed)`.
- `seastack(hpx, seed)`, anchored at the water line.
- `giant(hpx, 'oak'|'pine', seed)`, `cairn(hpx, seed)`, `mushrooms(size, seed)`, `butterfly(frame, seed)`.

main.js reaches life.js through `life(name, key, ...args)`, which uses the sprite cache (L896).

People and camp:
- They come from world.js's synthetic camp (world.js L208-210): 5 people on a 2.6 m ring around the fire at fixed angles offset from `from`, 3 tents on 9-11 m rings, and a woodpile.
- `campObjects` (L1465) spreads them by campOff/`around` (6.5 in far views) and scales by campK.
- Roles are hard-coded by index: k=2 carries wood, k=4 fishes at the found waterline with a rod, k=1 and k=3 sit, the others stand. Colours are P['c'+k] from the game's COLORS.
- It also adds a canoe, fire ring, embers, flames, glow and smoke.
- The island view shows 3 miniTents plus smoke (L971-979).
- None of this comes from the game's agents or camps.

## 6. Coupling and reuse blockers

- Module-level `location.search` (L9, unguarded) sets VIEW, SEED, PX/Z, DENSE, UI, FRAME/PH and `debug`. pal.js reads `?pal=` at import into THEME, RGB and the LUTs.
- main.js mutates pal.js's exported SHADOW LUT at import (L53). This changes px.js `shadowPx` for every importer.
- Importing main.js has side effects: it runs `main()` immediately (L1925) and registers window error and unhandledrejection handlers that set `body.dataset.error` and add the `failed` class (L1922-1924). main.js exports nothing.
- DOM assumptions: `#view` canvas, `window.innerWidth/innerHeight`, `document.createElement('canvas')` in main and in world.js grow (so grow cannot run in a Worker without OffscreenCanvas), and adding `body.ready`.
- There is no top-level await. life.js is loaded with `await import()` inside main (L1870); until then `life()` returns null.
- Per-render mutable state lives on V: marks, falls, rings, drifts, fireAt, smokes, trodden, fringe, woodsAt, waterAt, shaded, mist, crease. There is also a global sprite cache (unbounded, but keys are quantized) and `LIFE`.
- Order dependency: `collectObjects` must run before `drawTerrain`, because `V.trodden` is read in `texLand`.
- world.js imports `./island.js`, which exists only in the built site (scripts/demo.ts bundles demo/island.ts).
- Latent bug: `V.base` is never set, so island-view map-edge section walls (L847-850) get NaN heights and never draw.

## 7. Map size and scale

The island is N=128 cells × CELL=75 m, i.e. 9.6 km square. World x, z run from −4800 to +4800 m. START = −4762.5 is the first cell centre. The fine grid is 509² at 18.75 m. A game tile is 150 m (64×64). To map a game tile (tx, ty) to world meters: x = −4800 + 150·(tx+0.5), z = −4800 + 150·(ty+0.5); game y corresponds to world.js z.

Per-view tile scale and window (window sizes are my arithmetic from `frameTiles` at 640×360):

| View | tileM | Tile px (W×H) | lp | k (art px/m) | Screen width | Window (tiles) |
|---|---|---|---|---|---|---|
| island | fitted, about 85-130 m (search 400 → 62) | 12×6 | 2 | ≈0.085 | ≈7.5 km | about 130×130 (≈17k in rect, ≈8k visible) |
| valley / peak / coast | 18 m | 32×16 | 4 | 1.26 | ≈510 m | about 55×55 (≈3k) |
| lake | clamp(span·2.4/22, 14, 36) m | 32×16 | 4 | varies | varies | similar to valley |
| camp | 4-9 m | 58×29 | 7 | ≈10 (at 4 m) | ≈62 m | about 33×33 |

The whole island at valley scale would be 533² tiles, about 17k×8.5k art px (145 Mpx, roughly 1.4 GB of Buf). One buffer is not feasible, so it would have to be chunked.

## Smallest refactors for a live pan/zoom camera

1. **Make it a library.** Move the URL parsing (L9-21), `main()` and the autorun (L1864-1925) into a page shim. Export `makeView`/`buildMap`/`collectObjects`/`drawTerrain`/`drawObjects`/post passes. Turn VIEW/FAR/LOCAL/Z/DENSE into fields on V, and pass FRAME/PH as an argument only to the animated functions listed in §3. Keep THEME global per session.
2. **Fixed camera constructor.** Add one that skips `target`/`fitIsland`/`fitLocal`/`frameCamp`. Use phi = π/4 so eu=(1,0) and ev=(0,1), which makes u = x/tileM and v = z/tileM, aligned with the game's x/y. Compute exag and levelM once per zoom level from island-wide stats (reuse the L149-156 formulas), so heights never re-fit on pan.
3. **Build M once per zoom level over a large area.**
   - Island level (about 100² tiles) and valley level (533² ≈ 284k tiles, roughly 20 MB and about 0.5-1 s [INFERENCE]) can each be built over the whole island.
   - The camp level (4 m) needs local pages with margins of at least 10 tiles (BFS cap) to avoid `settle` seams.
   - `buildMap` already works off i0/j0/NI/NJ, so this is mostly parameterization.
4. **Chunked bake in global art-pixel coordinates.** Render into, say, 256² Bufs by offsetting X0/Y0 per chunk. Pass global pixel coordinates into every h2/bayer/dith/stone/noise(x, y) call so there are no seams or swimming. Replace the screen-relative terms (L542, L1822, L1004) with world-anchored ones, and replace `frameTiles`/`visible` with the chunk rect plus a sprite-height margin. Keep c (Uint8) and z (Float32) per chunk.
5. **Spatial bins for scatter.** Bin trees, shrubs and rocks once, for example by 150 m cell, so a chunk touches only nearby items instead of four full array passes. Make view-picked singletons (giants, herds, stacks, flocks via `spaced`/`tilesInView`) island-global picks so they don't change per chunk.
6. **Split static from animated.** Bake everything static. For water, either store per-water-pixel inputs (shore distance d, base v, near, x, y) and re-run only the FRAME terms of `texWater` per frame, or bake 8 water variants (1 B/px × 8, water pixels only). Redraw falls, flames, smoke, birds, fish, rings and spray per frame.
7. **Per-frame compose.**
   - Copy the visible chunk rows (c + z) into a viewport Buf.
   - Blit live game entities (agents, animals, fires from S) with the existing z-tested `blit`, so trees occlude people. Use `place()` with the tile → world mapping above.
   - Run the overlays, `haze`, then `toImage` with a reused ImageData and a Uint32 palette LUT, then `drawImage` at integer S.
   - Zoom = pick a baked level (tileM 100 / 18 / 4) × S ∈ {1..4}.
   - Estimated about 5-15 ms at 640×360 [INFERENCE].
8. **Hot-path fixes to make baking tolerable.** Precompute terrain shadow once per M (for example one sweep along the sun direction per vertex) instead of the per-pixel `M.ground` march (L480-495, L467-474). Replace `V.trodden` (L1451) with the game's S.paths or a precomputed grid. Drop the synthetic camp (`trodden`, `campObjects`, world.js camp) in favour of game state.
9. **Data wiring.**
   - The client needs the world seed, which the init message does not send (server.ts L121), plus the same generator build.
   - world.js `grow(seed)` is `generateIsland(rng(seed))`, identical to the game's `newWorld` (src/sim/world.ts L323). It must be the same code version that the live world was generated with; island-3d and web-v1 may differ.
   - grow takes about 1 s and needs a DOM canvas (OffscreenCanvas if moved to a Worker).
   - The live client's pattern to replace is `buildLayer`/`paint(rect)` plus the camera `drawImage` in public/app.js L134-236.