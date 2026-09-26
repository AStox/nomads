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
   Do instead: drive checks with a /root/tools/pw Playwright script that closes in `finally`, then confirm `pgrep -x chrome | wc -l` is 0.

## Domain Behavior Guardrails
1. **[2026-09-26] No slope may face away from the isometric camera**
   The map draws all terrain first and glyphs on top. That is only correct because ground never rises toward the camera (+x, +y) faster than it drops on screen.
   Do instead: keep the MAX_RISE limiter in cornerHeights when changing LIFT or the noise.
2. **[2026-09-26] The tile mix is tuned for sim balance**
   The generator reproduces the old mix: about 44% grass, 33% forest, 8% water, 15% rock.
   Do instead: re-measure the mix over ~40 seeds after touching elevation, ROCK, or WOODS.
3. **[2026-09-26] math/noise seeds keep only 16 bits**
   `simplex2d.create(seed)` uses `seed & 0xffff`.
   Do instead: derive sub-seeds with `Math.floor(rand() * 65536)` from the world rng.
