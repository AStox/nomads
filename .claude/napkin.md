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
   The init handler awaits the Google web font before it builds the map, and that fetch is slow from headless Chromium on this box.
   Do instead: `goto` with `waitUntil: "commit"` and wait up to 90 s for `body.ready`. Profile with CDP before blaming the renderer.

## Domain Behavior Guardrails
1. **[2026-09-26] No slope may face away from the isometric camera**
   The map draws all terrain first and glyphs on top. That is only correct because ground never rises toward the camera (+x, +y) faster than it drops on screen.
   Do instead: keep the lift limiter in isoView (public/art.js) when changing heights: it scales the island so 99.5% of tiles pass and clamps the rest.
2. **[2026-09-26] The island is 46% sea, and its land is 38% grass, 48% forest, 14% rock**
   Measured over 40 seeds. stock() sets thing densities per land tile, so they don't depend on how much of the map is sea.
   Do instead: re-measure over ~40 seeds after touching the generator, and keep stock() odds per land tile.
3. **[2026-09-26] Water tiles are both sea and lakes**
   Only lakes freeze, and islets offshore or in lakes are cut off from the rest of the land.
   Do instead: use `sea(w)` to tell salt water from lakes, and `mainland(w)` or `landing(w)` to place anyone new.
4. **[2026-09-26] src/terrain and src/sim/world.ts import each other**
   Reading W or H at module top level in src/terrain throws "Cannot access 'W' before initialization".
   Do instead: read W and H only inside functions there.
5. **[2026-09-26] math/noise seeds keep only 16 bits**
   `simplex2d.create(seed)` uses `seed & 0xffff`.
   Do instead: derive sub-seeds with `Math.floor(rand() * 65536)` from the world rng.
