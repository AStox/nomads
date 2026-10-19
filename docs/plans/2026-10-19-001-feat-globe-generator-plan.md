---
title: "feat: a planet whose landscapes come from processes, and an island window refined from it"
type: feat
status: active
date: 2026-10-19
supersedes: docs/plans/2026-10-18-001-refactor-regions-plan.md
---

# feat: a planet whose landscapes come from processes, and an island window refined from it

## Overview

The operator wants beautiful mountains, lush valleys, rivers and lakes grading to coast (the Pacific Northwest, Squamish with west Vancouver Island, as the picture in mind), built from natural processes and not from biomes rolled onto a noise map, with nothing hardcoded per place. A 19 km island cannot do that: its catchments are tiny, it has no room for a range, a fjord or a rain shadow, and its wind, ocean and rock are inputs. So the generator becomes a small planet. Plate motion makes continents and ranges, erosion wears them, circulation and the ocean make wind, rain and warmth, an ice age cuts fjords while the sea is low and the sea then rises, and soil and plants follow from rock, climate and age. The game's 75 m, 19 km window is refined from that planet at a place the player chooses; the sim, renderer and every existing kernel keep working on the window. Squamish and Tofino stop being two places defined by data: they are two spots on one west-facing subduction coast.

Decisions taken with the operator (2026-10-19): the globe is the generator, not a travelled world (people stay in one window; travelling is a later, separate decision); a planet smaller than Earth is acceptable (about 4,000 km across), at the cost of compressed climate belts.

## Requirements Trace

- R1. No place is an input: no wind rose, season table, rock table per place, summit, biome map or `Region` object. Inputs are the planet (radius, axial tilt, rotation, solar constant, a seed) and the initial plate layout drawn from that seed.
- R2. Every process is a cited law (or tagged [derived] [design] [gap] [UNVERIFIED] [INFERENCE] [analogue]); a failing check is a model gap written down, never a retune.
- R3. Integer GPU kernels, counter-based randomness keyed by cell, byte-identical run to run, as the island generator is.
- R4. A sphere grid (cube-sphere: six faces of square tiles, quadtree refinement) so the existing 256 by 256 per-tile kernels can be reused with neighbour exchange across tile and face edges.
- R5. The window (75 m cells, 19 km) at any (latitude, longitude) is produced from the coarse tiers deterministically (same seed and place give the same ground, any visit order).
- R6. Validated against Earth-like facts the planet was not tuned to: dry belts near 30 degrees latitude, rain shadows behind ranges, a mild wet west coast at mid latitude, fjords where ice met the sea, big rivers on big continents, snowlines falling poleward.
- R7. The current island generator and everything built on it stay working until the window path replaces `islandOf`.

## Scope Boundaries

- Plants (niches), animals and food are fed by the window's climate and soil as now; swapping them to a planet's species is a later phase (niches already read the fields, so they follow climate; species lists per biogeographic region are not in this plan).
- No travelling across the globe in play; no save format change beyond the window's place.
- Not Earth: radius, tilt and rotation are parameters; the planet is not tuned to reproduce Earth's continents.

## Key Technical Decisions

- **Cube-sphere tiles.** Tier 0 is six faces of 256 by 256 cells (about 12 km on a 4,000 km planet, 393k cells); tier 1 and up are quadtree children down to the 75 m window. A per-tile kernel reads a one-cell halo filled from neighbouring tiles and faces.
- **Time steps in millions of years** for tectonics and erosion, thousands for ice, hours to days for weather (the weather is run as a climatology: the mean state of an atmosphere model, not a forecast).
- **Tectonics simplified but physical.** Plates from a seeded Voronoi partition with velocities; boundary types from relative motion (convergent subduction or collision, divergent, transform); crust thickness and isostasy set elevation; terranes accrete at subduction margins; volcanic arcs and batholiths follow the boundary. The only random input is the starting layout.
- **Climate from circulation.** Insolation from latitude, tilt and season; a zonal-mean circulation (Hadley, Ferrel, polar cells) gives prevailing winds and the dry and wet belts; moisture advected with depletion over land and ocean (the missing physics behind the island's rain overshoot); orographic lift from the actual terrain; sea-surface temperature from latitude, wind-driven gyres and coasts; the lapse rate gives temperature with height.
- **Ice by mass balance.** An equilibrium-line altitude from temperature and precipitation, ice flux by a shallow-ice scheme, glacial erosion by a sliding-law (Herman et al. 2015, with the sliding speed now derived from the modelled ice), sea level lowered and raised with the ice volume.
- **The window is refined, not generated afresh:** coarse height, rock, rain, temperature and river inflow are the boundary and the mean; the existing window kernels (the island generator's stages) add the 75 m detail under those constraints.

## Implementation Units

- [x] **Unit 1: The sphere grid.** Outcome (2026-10-19): equiangular cube-sphere (Ronchi, Iacono and Paolucci), cell area ratio max/min 1.41 (the plain gnomonic map is 5.16), tier-0 cells 12.27 km on a 2,000 km radius, halo exchange across tile and face edges, gradient and conservative diffusion, all integer on the GPU and bit-for-bit with their twins (`src/gpu/globe`); open: a bounded non-converging diffusion error in the one-cell strip along face edges (a two-cell halo would fix it), tables are whole-tier only, and the 75 m window is not a whole tier (tier 7 is 95.9 m, tier 8 47.9 m), so Unit 8 resamples. Cube-sphere tiles, halo exchange across tile and face edges, cell areas and metric, a conservation test (a tracer diffused across a face edge and a cube corner conserves its total; a uniform field stays uniform; areas sum to 4 pi R squared).
- [x] **Unit 2: Plate tectonics.** Done 2026-10-19 (d615183); open: ranges are flat tables at the 70 km cut, 11 to 18% over 2 km. Seeded plates, velocities, boundary classes, crust thickness, isostatic elevation, terrane accretion, volcanic arcs, rock type by origin; run over about 200 Myr in coarse steps; output height and a lithology field. Check: ranges at convergent margins, rifts and ocean basins at divergent ones, continental shelves and a believable land fraction.
- [x] **Unit 3: Erosion on the sphere.** Done 2026-10-19 (a9465f2); open: cannot dissect the ranges while tectonics re-cuts them. Flow routing across tile and face edges (priority flood on a sphere), stream power and hillslope creep, sediment to the shelf; sea level as a parameter.
- [x] **Unit 4: Atmosphere.** Done 2026-10-19 (00aa4d5, e43a6e8); open: rain 59% of target, no permanent polar ice. Insolation and seasons, zonal circulation and prevailing winds, moisture advection with depletion, orographic rain from the terrain, temperature with latitude and height, continentality.
- [ ] **Unit 5: Ocean.** Wind-driven gyres, sea-surface temperature, the mild-west-coast effect; sea ice.
- [ ] **Unit 6: Ice ages and sea level.** Orbital forcing, ELA and ice flux, glacial erosion, lowstand carving and the sea's rise (fjords, drowned valleys, islands).
- [ ] **Unit 7: Validation against Earth-like facts** (R6), as a script with measured statistics over many seeds, and the gap list.
- [ ] **Unit 8: The window.** Built 2026-10-19, uncommitted (`src/gpu/globe/window.ts`, `docs/research/globe/2026-10-19-window-impl.md`): the planet by stages in a store, ranked landings, `windowOf(gpu, planet, lat, lon)` beside `islandOf` (the island's stages under the planet's parameters, in wider formats, the Bornholm path's WGSL and goldens unchanged), `sky.ts skyAt`, `world.ts windowIslandOf` (not wired to the page). 2026-10-19 evening: threshold hillslopes, channels as drains, the window's own channel head, the open edge and the step (R1714 to R1718): median slopes 31 to 32 degrees, peaks 3.5 to 4.5 km, marsh 6 to 19%, no wall at the open edge; open: threshold facets with no valley floors (no debris-flow or deposition law), the aquifer has no saturated thickness, the closed edges take no water from beyond, the world does not store its place. `landingAt(seed, lat, lon)` refines the coarse tiers to the 75 m window and feeds the existing stages; `islandOf` becomes `windowOf`; the world stores its place; `sky.ts` takes the latitude.
- [ ] **Unit 9: Soil and plants from the planet** (the window's niches read the refined climate; confirm they respond sensibly across climates).

## Risks

| Risk | Mitigation |
|------|------------|
| Plate tectonics is a research problem | Simplified, cited (Cortial et al. 2019, isostasy), validated on facts not tuned to; a gap list |
| Climate from first principles looks wrong | Validation facts fixed in advance (R6); misses are written as gaps |
| Refinement from coarse to 75 m contradicts the coarse | Coarse fields are constraints; the window's stages run under them; a test that the window's mean equals the tile's |
| Scope | Each unit is a viewable result and stops cleanly; the island generator keeps working throughout |
| Sub-agent rate limits | At most two agents at once, notes kept, verify each before the next |

## Resume point (2026-10-19, session stopped for a harness restart)

Two agents were stopped mid-work and their output is UNVERIFIED and uncommitted, left in the working tree and also saved in ~/nomads-wip (ranges-tracked.patch, ice-ranges-untracked.tgz):
- Range fix (the flat-table problem): edits to tectonics.ts, erosion.ts, their kernels and tests, docs/research/globe/2026-10-19-ranges-impl.md, scripts/globe-ranges.ts. Read the impl note for how far it got; run tectonics and erosion tests in groups under 5 minutes before committing.
- Unit 6 ice ages and sea level: src/gpu/globe/ice.ts, wgsl/globe-ice.ts, ice.test.ts, scripts/globe-ice-maps.ts, docs/research/globe/2026-10-19-ice-impl.md; scripts/_scratch-ice.ts is scratch to delete.
Remaining after those: Unit 5 ocean (partly inside the atmosphere), Unit 7 validation script, Unit 8 the window (`windowOf`), Unit 9 soil and plants.
