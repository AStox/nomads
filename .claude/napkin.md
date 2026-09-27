# Napkin Runbook

## Curation Rules
- Re-prioritize on every read.
- Keep recurring, high-value notes only.
- Max 10 items per category.
- Each item includes date + "Do instead".

## Execution & Validation (Highest Priority)
1. **[2026-09-26] Other agents work in this checkout too**
   A second Paseo agent may have uncommitted edits here and a paid Jev run going on the live world.
   Do instead: before merging or restarting, check `git status` here and `list_agents` for a running nomads agent. If either is busy, leave your work on a branch and ask.
2. **[2026-09-26] The live service serves this checkout**
   nomads.service runs `bun server.ts` here (branch web-v1, port 8095). public/ is read from disk on every request, so client edits go live at once; server edits go live on restart.
   Do instead: work in a git worktree, test it as an offline copy on another port, then fast-forward web-v1, `bun install`, and `systemctl restart nomads`.
3. **[2026-09-26] Watching the live world costs money**
   The world only ticks while a client is connected, and the live brain bills Jev.
   Do instead: never open :8095 or goldclaw.duckdns.org/nomads to test. Run `PORT=8196 NOMADS_DATA=/tmp/<dir> NOMADS_BRAIN=random bun server.ts` and check the live server only through `/api/debug/*`.
4. **[2026-09-26] A VERSION bump starts a new world**
   load() renames an old-version save to `world.json.v<N>.bak` and generates a fresh world.
   Do instead: bump VERSION in src/sim/world.ts for any World shape or generator change, and check the live world's age with `curl -s 127.0.0.1:8095/api/debug/stats | jq .t` before restarting.
5. **[2026-09-26] The harness browser can fail to launch here**
   Do instead: drive checks with a /root/tools/pw Playwright script that closes in `finally`, then confirm `pgrep -f headless_shell | wc -l` is 0. Other sessions' chrome under ~/.omp is not yours to kill.
6. **[2026-09-26] Headless page loads here take 5 to 50 seconds**
   Google Fonts crawls from headless Chromium on this box. The 2D map awaits its font before building, a render-blocking font stylesheet holds back module scripts, and screenshots wait on fonts.
   Do instead: `goto` with `waitUntil: "commit"`, wait up to 90 s for `body.ready`, and in throwaway tests `page.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort())`. Profile with CDP before blaming the renderer.
7. **[2026-09-27] Headless WebGL needs SwiftShader flags and is very slow**
   The 3D demos (demo/3d, and the style mocks in demo/styles built by `bun scripts/demo.ts styles --out /root/goldclaw/www/nomads-styles`) are black or throw without them. With shadows on, one mid-range frame over woods can take minutes, and Playwright clicks can time out waiting for a stable frame.
   Do instead: launch with `--use-angle=swiftshader --enable-unsafe-swiftshader --ignore-gpu-blocklist`, keep `preserveDrawingBuffer`, wait for `body.ready`, and read `canvas.toDataURL()` in the page; `page.screenshot` can sit past 600 s behind queued GPU work. When several agents render, serialize browsers with `flock` and cap each under `systemd-run --scope -p MemoryMax=1800M -p MemorySwapMax=0`: two parallel renders once OOM-killed the kind cluster.
8. **[2026-09-27] The island is 211k trees, 49k shrubs and 59k rocks**
   Drawing them all with real geometry, or in one instanced mesh the renderer can't cull, never finishes a frame, and the shadow pass pays twice.
   Do instead: cull to the view and use levels of detail (tiles of instances, cheap far shapes, costly models only for the nearest few hundred things in view).
9. **[2026-09-27] Renderer prototypes run the real sim in the browser, not the server**
   demo/sim.ts is bundled to sim.js (node:fs stubbed, brain forced to random) and demo/styles/play/sim.js runs it, so there is no server, no Jev bill, and the island matches the renderer's grow(seed) because both run in one engine. Warm ticks must each get their own task, or every agent stays `thinking` and nothing gets built.
   Do instead: prototype at /nomads-styles/play/ (window.play = { sim, live, view }). The same seed gives different people in Chromium and Bun (world.ts shuffles with a comparator sort), so never compare people across engines.

## Domain Behavior Guardrails
1. **[2026-09-26] No slope may face away from the isometric camera**
   The map draws all terrain first and glyphs on top. That is only correct because ground never rises toward the camera (+x, +y) faster than it drops on screen.
   Do instead: keep the lift limiter in isoView (public/art.js) when changing heights: it scales the island so 99.5% of tiles pass and clamps the rest.
2. **[2026-09-26] The island is 47% sea, and its land is 37% grass, 52% forest, 11% rock**
   Measured over 24 seeds after the relief came down to 250-450 m peaks (median slope 6.5°). Crags now come mostly from hard bedrock bands rather than steepness. stock() sets thing densities per land tile, so they don't depend on how much of the map is sea.
   Do instead: re-measure over ~24 seeds after touching the generator (rock share drives ore and flint), and keep stock() odds per land tile.
3. **[2026-09-26] Water tiles are both sea and lakes**
   Only lakes freeze, and islets offshore or in lakes are cut off from the rest of the land.
   Do instead: use `sea(w)` to tell salt water from lakes, and `mainland(w)` or `landing(w)` to place anyone new.
4. **[2026-09-26] src/terrain and src/sim/world.ts import each other**
   Reading W or H at module top level in src/terrain throws "Cannot access 'W' before initialization".
   Do instead: read W and H only inside functions there.
5. **[2026-09-26] math/noise seeds keep only 16 bits**
   `simplex2d.create(seed)` uses `seed & 0xffff`.
   Do instead: derive sub-seeds with `Math.floor(rand() * 65536)` from the world rng.
6. **[2026-09-26] The 3D demo renders into a half-float frame**
   Blending there doesn't clamp, so a shader alpha over 1 subtracts whatever is behind (it showed the map's square through the sea). And three caches the cube it builds from an equirectangular `scene.background`, so repainting that canvas never shows.
   Do instead: clamp alpha in any shader drawn into the frame, and draw a sky that changes as a dome mesh, as demo/3d/look.js does.
7. **[2026-09-27] Art-style mocks that only recolor get rejected**
   Two rounds of looks dressed on one shared heightfield with blob trees read to the operator as the same picture recolored.
   Do instead: vary the representation itself per mock (terrain as tiers, voxels, hexes, paper, glyphs or paint; models as sprites, cubes or toy pieces; 2D vs 3D; camera and renderer). Share only demo/styles/world.js, the island as plain data.
8. **[2026-09-27] Stepped, blocky terrain is the look the operator rejects**
   In the isopixel style, terraced cliffs, per-tile rock cubes and tile-column shading all read as "too cliffy" or blocks, and raw data rocks drawn one by one read as confetti.
   Do instead: slope tiles lit per vertex, real cliffs only on sea headlands, rock shaded in a few tones from a normal smoothed over about 3 tiles plus sparse hand texture, and nearby data rocks merged into outcrops at far zooms. Check each pass in grayscale and a heavy blur.
9. **[2026-09-27] One sim step is 150 m and 5 in-game minutes**
   At 1x that is 600x time compression, so at the play page's close zoom (6.25 m tiles) a walker covers two screens per tick, and things placed anywhere in their 150 m tile scatter one camp across screens. Bake workers cost about 220 MB each.
   Do instead: treat the close zoom as a hop-and-settle view until the sim moves in sub-tile steps, and budget browser memory by worker count (3 workers is about 1.3 GB).
