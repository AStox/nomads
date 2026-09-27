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
7. **[2026-09-26] Headless WebGL needs SwiftShader flags and is very slow**
   The 3D demos (demo/3d and the demo/looks mocks, built by `bun scripts/demo.ts <3d|looks> --out /root/goldclaw/www/nomads-<3d|looks>`) are black or throw without them. With shadows on, one mid-range frame over woods can take minutes, and Playwright clicks can time out waiting for a stable frame.
   Do instead: launch with `--use-angle=swiftshader --enable-unsafe-swiftshader --ignore-gpu-blocklist` and click through `page.evaluate` when a click stalls. For stills, read `canvas.toDataURL()` in the page (the looks renderer keeps its drawing buffer); `page.screenshot` can sit past 600 s behind queued GPU work.
8. **[2026-09-26] An instanced mesh over the whole island can't be culled**
   The island grows about 180k trees and 90k shrubs, and EZ-Tree presets run 5k to 24k triangles. One InstancedMesh per shape made every view, and the shadow pass, draw all of them; the first looks still never finished.
   Do instead: scatter through demo/looks/stage.js `scatter` (tiles the renderer can cull) and split by `stage.levels` so costly shapes go only to the nearest few hundred things in view.

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
