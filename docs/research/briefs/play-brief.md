# Nomads: the isopixel style in a real, running world

## Goal
The operator picked the isopixel style ("Expedition Morning", art book at https://goldclaw.duckdns.org/nomads-styles/artbook/) and now wants to see it drive the real game: the real simulation running live, a camera you can pan and zoom, people and animals moving, trees felled, fires lit, shelters built. The point is to learn how the style handles a live world: frame rate, bake cost, readability at each zoom, and where the sim and the art disagree (scale, placement, missing sprites). Deliver a page at https://goldclaw.duckdns.org/nomads-styles/play/ plus honest numbers.

Background reports (read them first, they save hours):
- local://gamemap.md: the game (sim, wire shapes, World fields, the current client's camera and input).
- local://isomap.md: the isopixel renderer (pipeline, costs, coupling, and a refactor list for a live camera).

## Decisions already made (do not revisit)
- The sim runs in the browser page, on the main thread, with the random brain. There is no server. Never start, open or curl port 8095, goldclaw.duckdns.org/nomads, or server.ts. No network calls to Jev, ever.
- Seed: `?seed=` (default 1). The sim (newWorld(seed)) and the renderer (grow(seed)) both run in the same browser, so the island matches.
- Coordinates: sim tile (tx, ty) covers world.js meters x in [-4800+150*tx, -4650+150*tx], z likewise from ty (sim y maps to world z). Tile centre: x = -4725+150*tx, z = -4725+150*ty.
- Everything lives under demo/styles/ so `bun scripts/demo.ts styles --out /root/goldclaw/www/nomads-styles` publishes it (island.js and the new sim.js bundles land at the styles root; the page is demo/styles/play/).
- The look is the art book's: pal=adventure, px=2 art pixels, dense=2, morning light by default. No menu bars. Only a tiny fading controls hint, in-world name labels for the selected person, and a `?stats=1` overlay.

## Ownership (one owner per file; do not edit files you do not own)
- **Playsim**: demo/sim.ts (new), scripts/demo.ts (add the sim bundle), demo/styles/play/sim.js (new).
- **Isolife**: demo/styles/isopixel/things.js (new), plus additions to sheet.js/sheet.html so the sheet shows the new sprites.
- **Isopixel** (integration owner): demo/styles/isopixel/live.js (new) and any refactor of main.js/px.js/pal.js/sprites.js it needs (the six still views must keep working), plus demo/styles/play/index.html and demo/styles/play/main.js.
- Main (me) reviews and commits. Nobody else runs git writes.

## Contract A: sim runner (Playsim), demo/styles/play/sim.js
```js
import { createSim } from "./sim.js";
const sim = createSim({ seed, warm });   // synchronous: newWorld(seed), then `warm` ticks run at once
sim.w            // the live World object; renderers read it and never mutate it
sim.update(now)  // call every animation frame with performance.now(); runs the ticks that are due for speed/pause
                 // returns null, or { things: Thing[] (new or changed), removed: string[], paths: number[] (tile indexes whose wear changed), ice: boolean, groups: boolean, events: Event[] }
sim.alpha        // 0..1, progress from the last tick toward the next, for interpolation
sim.pos(id)      // { x, y, px, py }: current and previous integer tiles of an agent or animal (lerp with alpha)
sim.speed        // 0.25, 0.5, 1, 2, 4, 8 (1 = one tick per 500 ms, like the server)
sim.paused       // boolean
sim.tickMs       // rolling average ms per tick
sim.clock()      // { hour (0..24 float), day, season, night (0..1 like app.js nightAmount) }
```
Change tracking must match what server.ts builds for its `tick` message (physics.changed/removed/newKinds, ecology pathChanges/iceChanged, groups.groupsChanged), and it must clear those sets the same way.

## Contract B: sprites (Isolife), demo/styles/isopixel/things.js
Same conventions as life.js: each export returns a px.js `Spr` of pal.js indices, 255 transparent, anchored at the ground-contact point, outlined like the rest, deterministic per seed. Reuse sprites.js/life.js where something already fits (stump, log, rock, bush, reeds, mushrooms, flames, person, deer, woodpile) and only add what is missing:
- `wolf(hpx, pose 'stand'|'walk'|'run'|'eat'|'rest', frame 0..3, seed)`, drawn facing right (callers mirror).
- `walker(hpx, cloth, facing 'front'|'side'|'back', frame 0..3, carry 'none'|'wood'|'stone'|'food', stage 'child'|'adult'|'elder', seed)`: a walking person matching sprites.js person().
- `lying(hpx, cloth, seed)`: a person down, asleep or unconscious.
- `shelter(tier 0..3, style 'sticks'|'reeds'|'logs'|'planks'|'stone'|'brick'|'hide'|'clay', hpx, seed)`: 0 material pile, 1 lean-to, 2 hut or tent, 3 cabin or lodge, with the style as the material.
- `firering(r, seed)` (unlit stone ring), `ash(r, seed)`, `burnt(hpx, seed)` (burnt stump), `pit(r, stage, seed)`, `trap(hpx, sprung, seed)`, `well(hpx, seed)`, `grave(hpx, seed)`, `pile(hpx, what 'wood'|'stone'|'food'|'hide'|'misc', seed)`, `sapling(hpx, seed)`, `herb(hpx, seed)`, `clay(r, seed)`, `deadbush(size, seed)`, `stick(len, seed)`.
- `icon(name 'think'|'sleep'|'sick'|'fight')`: a tiny 5 to 7 px marker drawn above a person.
Sizes: SimCity exaggeration. At the valley zoom a person is about 8 px tall, a hut 12 to 18 px, a wolf about as long as the valley deer.

## Contract C: live renderer (Isopixel), demo/styles/isopixel/live.js
```js
import { createLive } from "../isopixel/live.js";
const live = await createLive({ seed, canvas, onProgress });  // grows the island, starts bake workers
live.zooms                 // the zoom ladder, e.g. [{ name: "island" }, { name: "region" }, { name: "valley" }, { name: "close" }]
live.frame(view, sim)      // draw one frame. view = { x, z (camera centre in world meters), zoom (index into live.zooms) }
live.changed(changes)      // pass sim.update()'s result; rebake chunks whose landscape changed (felled or burnt trees, paths, ice)
live.pick(sx, sy, view)    // canvas CSS px to { kind: 'agent'|'animal'|'thing', id } or null
live.toWorld(sx, sy, view) // canvas CSS px to { x, z } world meters
live.stats                 // { fps, composeMs, bakeQueue, bakedChunks, bakeMsAvg, memMB }
```

## Shared rules
- Skip formatters, linters and the project test suite. Write only your own files. No git writes.
- Browser checks: Playwright only (`require("/root/tools/pw/node_modules/playwright")`), one browser at a time via `flock /tmp/nomads-play/render.lock`, each under `systemd-run --scope -p MemoryMax=1800M -p MemorySwapMax=0` with `echo 1000 > /proc/self/oom_score_adj`, closed in `finally`. Afterwards `pgrep -f headless_shell | wc -l` must be 0. Scratch files go in /tmp/nomads-play/ only.
- Comments state only a non-obvious why, one line, no ticket ids. No em or en dashes anywhere.
- Report results in a short plain summary with measured numbers.
