---
title: "refactor: the island generator on the GPU, and the Bornholm ecology gaps fixed there"
type: refactor
status: active
date: 2026-10-17
---

# refactor: the island generator on the GPU, and the Bornholm ecology gaps fixed there

## Overview

The operator asked for the ecology to be fixed and "all on the GPU", and chose to port the generator first and fix the gaps on the GPU afterwards. Every quantity in the handoff's ecology gaps (rain, lakes, water table, open land, peat, soil carbon) is made once an island by the CPU generator in `src/terrain` (about 2,700 lines of TypeScript, about 10 s an island, run again in the browser render worker). No per-tick law touches them. So "ecology on the GPU" here means the generator's stages run as GPU kernels, in fixed point so every adapter makes the same island, and the six gaps are fixed in those kernels, each as a cited model fix and never a retune.

This reverses the scope line of `2026-10-14-001-refactor-gpu-object-world-plan.md` ("the terrain generator stays on the CPU") and of `2026-10-16-001-refactor-real-time-tick-plan.md`, by the operator's decision of 2026-10-17.

## Problem Frame

- The generator is float64 TypeScript: `generateIsland` (`island.ts`) runs structure, erosion, ice scour and till, flood and receivers, `climate` (orographic rain by FFT, airflow, horizons, sunlight, snow, Penman), `hydrology` (bucket surplus, recharge, steady aquifer SOR, lakes, seasonal tables, rivers), `ground` (soil, peat, cover by compensation point, RothC carbon), then `fineGround` and `scatter` (`flora.ts`) build the 3 m field and the objects.
- Bun and the browser worker both run it and must make the same island, which float code does today and a GPU's floats would not across adapters. The napkin's rule (gate-relevant GPU arithmetic is integer, each field a documented fixed-point unit and scale, `src/gpu/fixed.ts` for exp, log, pow) therefore applies to the generator too.
- The gaps form one chain [INFERENCE from `terrain-constants.md` secs. 9 to 13 and the code, read 2026-10-17]: rain too high and PET too low (`climate.ts` `orographic`, the per-direction clip at line 209; Penman at 0.75 of DMI's Makkink) inflate the water surplus; `aquifer()` has no groundwater evaporation, so the table stays near the ground; a winter table under 0.2 m makes trees unsuitable (`niche.ts`), so reeds take the open land (`ground.ts` cover); a dry-season table under 0.3 m makes peat (`ground.ts` 191-192). Soil carbon is separate: `growth.ts` `warmEnough` and the plant carbon input have no leafless season. Lakes come from closed hollows in the joint valleys (`island.ts` 198-244).

## Requirements Trace

- R1. Each generator stage runs as GPU kernels in integer arithmetic; a field's unit and scale is written where it is declared; no float between a buffer read and a buffer write; randomness counter-based (Philox keyed by cell or object), never `Math.random`.
- R2. The same seed makes the same island run to run, and on the Bun server and the browser worker (one adapter is available here, so cross-adapter identity is argued by the integer rule and recorded as unverified).
- R3. During the port the CPU float stage is the test reference (a stage's GPU output within a recorded tolerance of it, on seeds 1 to 3); at cutover it is deleted and golden hashes of the fields replace it.
- R4. `islandOf(seed)` is async and fills the ground cache; `groundOf(seed)` stays synchronous and reads the cache (throws if the island was not made), so the 43 callers of `groundOf` and the 39 of `newWorld` change only by awaiting `islandOf` once in their setup.
- R5. Each of the six gaps is closed by a model fix with a citation or marked [gap]/[design]/[derived], checked over 24 seeds with the `scripts/island.ts` tables, and written into `terrain-constants.md`'s gap list as closed or still open; nothing is retuned to pass.
- R6. The island takes under 5 s on this Mac in Bun and the page's first view is no later than today's 21 s.
- R7. No step of the work runs over 5 minutes; GPU jobs run one at a time.

## Scope Boundaries

- `fineGround` and `scatter` (`flora.ts`) port after the fields they read (Unit 7).
- The per-tick `src/sim/ecology.ts` processes are not part of this plan; no gap needs them.
- No new dynamic water-table, marsh or peat laws (a transient groundwater step with specific yield would be new modelling; `terrain-constants.md` sec. 11 gap 3 asks for it; later and separately).

## Key Technical Decisions

- **Fixed point, GPU definition.** The GPU kernels define the island; the float stage is a reference only while the port runs. Tolerances are per field and recorded in the stage's test.
- **Stages in pipeline order, downstream first to be parallel.** Climate, water and ground take the previous stage's fields as inputs, so each can be ported against the CPU stage's output at once (Units 1 to 3); Unit 4 wires them to one another and to the async cache; the fixes follow in the chain's order (Unit 5); the sequential upstream stages (flood and receivers, flow accumulation, implicit erosion, joint scour) need parallel algorithms and go after (Unit 6).
- **One shared helper module.** `src/gpu/terrain/` holds each stage's host file and `src/gpu/wgsl/terrain-*.ts` its WGSL; `src/gpu/fixed.ts` is read, not edited, by the stage units (a stage that needs a new helper puts it in its own file and says so).

## Implementation Units

- [ ] **Unit 1a: Orographic rain on the GPU** (`climate.ts` `orographic`, `fft2`, `fft`, the wet rose, `SEASONS` rain terms). Kernels: a coarse-grid transform (FFT or the direct convolution the theory allows), the Smith-Barstad transfer per wind direction and season, the inverse, the sum. Output `precip` per season. Tolerance and the rounding of the fixed-point transform recorded.
- [ ] **Unit 1b: The rest of the climate** (`airflow`, `downwind`, `horizons`, `sunlight`, `snowYear`, `penman`, temperature, wind). Per-cell and per-day parallel; `snowYear`'s daily loop is a sequential scan per cell over days.
- [ ] **Unit 2: Hydrology on the GPU** (`water.ts`: bucket surplus and recharge, `aquifer` as red-black SOR over the 256 by 256 grid, lake balance per hollow, `seasonTable` and `dryTable`, rivers). Flow accumulation and river routing are sequential graph work; the unit chooses a parallel method (pointer jumping over the receivers, or a levelled sweep) and records it, or keeps `route` on the CPU and says why.
- [ ] **Unit 3: Ground on the GPU** (`ground.ts`, `niche.ts`, `growth.ts`, `geology.ts` tables: soil texture and depth, peat by Clymo, the seasonal bucket, cover by compensation point, NPP, RothC steady state, pH, fertility). Per-cell and embarrassingly parallel; the cover's per-form competition is a fixed number of passes.
- [ ] **Unit 4: Wiring and the async cache.** `islandOf(seed)` runs Units 1 to 3 on the GPU after the CPU upstream stages, fills `grounds`, and `groundOf` reads it; the browser worker and `play/sim.js` await it; tests, scripts and `server.ts` await it in setup; `VERSION` bumps. CPU climate, water and ground code is deleted once their tests pass on the GPU stage (golden field hashes replace the float reference).
- [ ] **Unit 5: The six gaps, fixed on the GPU** in the chain's order, each with its citation and a 24-seed table before and after: (a) rain (the per-direction clip, moisture depletion, the wind the theory takes; read Smith and Barstad 2004, marked "not read" in `fire-constants.md`) and PET; (b) lakes (valley geometry open to the sea at their ends, scour depth scaled by R531); (c) water table (a groundwater evapotranspiration term in the aquifer, MODFLOW's EVT, `terrain-constants.md` sec. 12g gap 1); (d) open land and (e) peat, which should follow (c) and are then measured against R621/R639 and R613; (f) soil carbon (a leafless season and day length in the plant carbon input). A gap that does not close is written back as a gap.
- [ ] **Unit 6: The upstream stages** (priority flood, receivers, accumulate, implicit erosion, joint scour, structure) as parallel kernels. Priority flood and implicit erosion are the order-dependent ones; each unit-level choice (parallel priority-flood, pointer jumping, red-black or multigrid for the implicit step) is recorded with its cost.
- [ ] **Unit 7: `fineGround` and `scatter`** on the GPU; the objects' buffers are written by the generator kernels directly (no CPU copy of 1.36 million stems).
- [ ] **Unit 8: Cutover.** The CPU generator and its float reference are deleted; golden hashes of every field for seeds 1 to 3 are the tests; first view, island time and memory recorded in a new `bench-r9g.json`.

## Risks

| Risk | Mitigation |
|------|------------|
| Fixed point loses the FFT or SOR's accuracy | Per-field scales chosen from the CPU field's range; 64-bit helpers from `fixed.ts`; the tolerance is recorded and the first unit that cannot meet it stops and reports |
| Priority flood and implicit erosion do not parallelise cleanly | They go last (Unit 6); until then they run on the CPU and feed the GPU stages as inputs |
| Every island changes at the port and at each fix | `VERSION` bumps; gates are suspended and their baselines already stale |
| One adapter here, so cross-adapter identity cannot be run | The integer rule, run-to-run identity, and an explicit "unverified" in the record |
| The 5-minute rule against a 10 s generator and 24-seed tables | Seeds run one at a time in parallel-safe batches of under 300 s; no full suites |
