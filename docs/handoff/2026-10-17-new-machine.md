# Handoff: carrying the nomads work to a new machine (2026-10-17)

You are picking up a long-running build of the game in this repo from an agent on the operator's old Intel MacBook Pro (Radeon Pro 5500M with 4 GB, plus Intel UHD 630). That machine's GPU hung under this work, so it moved here. Read this whole file, then `.claude/napkin.md`, before doing anything.

## 1. Set up

1. Clone or pull: `git@github.com:AStox/nomads.git`, branch `main`. The last commit from the old machine is `5949021` ("Work as energy over power, cited animal gaits and flight distances, burning beds on the GPU, a midnight without a stall"). Run `git fetch && git checkout main && git pull` first; work only on `main` (no feature branches), commit and `git push -q origin main` after each piece.
2. Bun 1.4.2 at `~/.bun/bin` (`export PATH="$HOME/.bun/bin:$PATH"` in every shell). `bun install`. `webgpu@0.6.2` (Dawn) is in `trustedDependencies` and ships a `darwin-universal` binary, so Apple Silicon works.
3. `.env` is gitignored and must be copied over from the old machine by the operator (never print or commit it). It holds `TYPESAFE_API_KEY` (the operator's personal Jev key), `NOMADS_RELAY_TOKEN` (the play page's relay token) and `SUBQ_API_KEY`. `.env.test` is in git and sets `NOMADS_BRAIN=random` for tests.
4. `data/` (eval run caches) and `node_modules/` are gitignored and not needed.
5. Typecheck: `node_modules/.bin/tsc --noEmit` must be clean.
6. Scripts that import sim modules import `src/sim/world` first (import cycles).

## 2. Hard rules from the operator (all still in force)

- **Nothing you run may take longer than 5 minutes.** Every command gets a 300 s timeout (`bun test --timeout 300000`, shell timeouts). Run only the test cases that cover a change (`-t`); a test that can't finish in 5 minutes is not run and is reported as unrun. Benches are one 12 s run per bench. The smoke run `NOMADS_BRAIN=random bun scripts/run.ts --hours 6 --seed 1` (about 50 to 80 s) is fine. No full suites.
- **Gates and probes are suspended**: don't run `bun scripts/evals.ts probes` or `worlds` until the operator says so.
- **Deploy every change**: after each commit, rebuild the play site (`bun scripts/demo.ts styles --out ~/.cache/nomads-play`), load it to `body.ready` with no page errors, then carry on without waiting. Tests and smoke don't cover the page's own wiring; a build that passed every test once never started.
- **Be careful with the GPU**: one GPU job at a time. After any headless Chrome page check, kill the Chrome processes you started (closing the tab leaves the page and its GPU work running).
- **Physics, no rules**: every constant is cited (an R-number in `docs/research/*-constants.md`) or tagged `[derived]`, `[design]`, `[gap]`, `[UNVERIFIED]`, `[INFERENCE]` or `[analogue]`. A failing check is a model gap written into the doc's gap list; never retune a constant to pass. A test that pins wording or incidental behaviour is restaged on what it means to test, or deleted.
- **GPU determinism**: gate-relevant GPU arithmetic is integer only (no float between a buffer read and a buffer write, no float atomics); each kernel has a TypeScript twin and must match it bit for bit; WGSL `select` evaluates both arms, so never put a random draw in it; WGSL lives in TS/JS string modules under `src/gpu/wgsl/` and `demo/styles/isopixel/wgsl/`; randomness is counter-based Philox keyed by object identity. The old machine checked every kernel on two adapters (AMD and Intel via `NOMADS_GPU=low-power`). An Apple Silicon Mac has one GPU, so here the check is GPU against twin; note in reports that the second adapter wasn't available.
- Never open or restart the live server on port 8095 or goldclaw.duckdns.org/nomads.
- Writing style everywhere (code comments, docs, commits, chat): plain sentences, no em or en dashes, no ticket IDs in code. Chat replies to the operator are short (one to four sentences), answer first, no recaps or trailing offers. Times in ET.

## 3. The play site

- Serve: from the repo root, `bun scripts/play/serve.ts ~/.cache/nomads-play 8197` (serves the built pages and relays the page's Jev calls with the key from `.env`). Page at `http://localhost:8197/play/`.
- Public link: `cloudflared tunnel --no-autoupdate --url http://localhost:8197` prints a new `https://<words>.trycloudflare.com` URL each start; give the operator `<url>/play/`. On the old machine both ran as persistent services, plus `caffeinate -dimsu` to keep the Mac awake.
- Page checks: headless Chrome with WebGPU (`--headless=new --enable-unsafe-webgpu --window-size=1600,1143`), wait for `document.body.classList.contains('ready')`, check page errors. `bun scripts/play/objects.ts --url <url>` launches its own Chrome and checks drawn positions, far lists, cross-fades and kills (it can exceed 5 minutes; run sections or skip).
- Benches: `?bench=zoom,orbit,turn,pan` on one load; figures in `demo/styles/isopixel/reference/bench-*.json` (latest `bench-r9e.json`, baseline `bench-sim-worker.json`).
- `?warm` is in sim days (default 1, about 46 s on the old machine), `?speed` in sim seconds per wall second (default 600).

## 4. Where things stand

The operator's goals: (1) the rule audit (`docs/research/rule-audit.md`): every hard-coded rule replaced by cited physics, then a "person behaviour pass"; (2) the GPU object world (`docs/plans/2026-10-14-001-refactor-gpu-object-world-plan.md`): every thing simulated as an individual on the GPU, deterministic, WebGPU required with no fallback, and the game running better than before (R9: no stutter on zoom, pan or rotate); (3) the real-time tick (`docs/plans/2026-10-16-001-refactor-real-time-tick-plan.md`): a 1 s tick, chosen by the operator over keeping a slowed pace.

Done and on main:
- Rule audit substrates 1 to 12 all marked done in `rule-audit.md` (11: the generator on a Bornholm analogue; 6, 7, 8, 9, 12: walking, work, shelters, hunting, senses in `docs/research/people-constants.md`).
- GPU plan Units 1 to 15 and 12b: stems, seedlings, deadwood and clasts, animals, fish, crowns, per-object moisture, fire receivers and burning beds, grass tillers, litter, invertebrates, soil fauna and sand as lumped individuals; the renderer draws every object from the GPU buffers in a worker that also runs the sim. Seed 1 holds about 1.47 GB of GPU memory (budget 1.5 GB).
- Tick plan Units 1 to 10: `src/sim/ticks.ts` (TICK_S = 1), `src/sim/lanes.ts` (fast 1 s, fire 10 s, senses 10 s, body 60 s, GPU landing 60 s), brains on events with a Jev meter, acts as energy over power (`src/sim/work.ts`), animals at cited speeds with flight initiation distances. World `VERSION` is 31.

## 5. What to do next, in order

1. **Check the page starts at `5949021` and deploy it.** It was never loaded: the old GPU hung during the check. Build, serve on your own port, load to `body.ready`, let the one-day warm run to the end, watch for stalls. Earlier figures on the old machine: `body.ready` about 60 to 70 s, first tick 25 to 35 s. If the page or GPU hangs, the prime suspect is the lumped tier's split sent as one whole dispatch during the animals' spin-up (`src/gpu/tiers/lumped.ts` `step(t)` uses `Infinity` bins; `src/gpu/smalls.ts` `day()` and `spin()`): send it in `SPLIT_BINS` slices again, keeping the spin-up unpaced. The bed kernel (`src/gpu/wgsl/beds.ts`) took 24 to 38 s to compile cold and now compiles off the critical path with the TS twin standing in.
2. **Re-measure on this machine** (it is faster, so old figures don't carry over): the four benches after the default warm against `bench-sim-worker.json`, the midnight rAF gap, first view and warm time, the daily GPU step (budget 50 ms), and seed-1 GPU memory. Write `bench-r9f.json`.
3. **Tick plan Unit 11, skip quiet seconds**: not done; its outcome note in the plan explains why (landings dominate the warm; result identity needs proof that no per-tick process draws randomness in skipped seconds).
4. **The open gaps below**, each a model problem to fix with citations, never a retune. Ask the operator which matter most if unsure.
5. Then the operator's "person behaviour pass" (not yet scoped; ask).

## 6. Open gaps (recorded in the docs named)

- Ecology on the Bornholm island (`terrain-constants.md` secs. 9 to 13): orographic rain overshoots (inland minus coast about +200 mm against DMI's +67); lakes 1.6 to 1.8% of land against 0.45%; water table shallower than "a few metres"; open land about 50% (mostly reed marsh) against pollen-based pre-farming 8 to 19%; peat 23 to 30% against 0.3%; soil carbon about 2.5 times Denmark's.
- Animals (`animal-constants.md` secs. 12 to 15): deer fall under the field band by year 3; wolves are carried by rabbits above Fuller's line; with grazers on tillers (Unit 12b) the three-year herds test was never rerun after the regrowth fix; fox flight distances and several speeds are gaps.
- Plants (`plant-constants.md` secs. 11 to 14): pine seedlings above the cited density, oak seedlings not yet compared; oak at 40% of del Rio's stem density; bush sizes and crops.
- Fish (`animal-constants.md` sec. 13): biomass above field values.
- Fire (`fire-constants.md` secs. 35 to 37): people read a bed as it stood at the last landing (up to a minute old); GPU stems, deadwood and seedlings out of sight don't burn as beds; first compile of the bed kernel.
- Renderer: zoom still had a few frames over 20 ms; island-view parity with the WebGL2 reference frames (mean about 6) unexplained.
- Gates: suspended; the last ledgers (`evals/`) are from `5e7b452` and fail on the new island. The evals `VERSION` map was bumped for the tick and work changes, so baselines are stale.

## 7. Bookkeeping

- R-numbers used up to R1201 (people R1000 to R1062, shelters R1101 to R1103, plants R1100, animals R1104 to R1115, work R1150 to R1154, fire R1200 to R1201; earlier ranges R1 to R999 across the other docs). Start new citations at R1250.
- `.claude/napkin.md` is the repo's runbook (gotchas and what works); read it at the start and add to it as you go.
- Research briefs for the generator are in `docs/research/generator/`; the lumped kinds' design note is `docs/research/generator/2026-10-16-lumped.md`.
