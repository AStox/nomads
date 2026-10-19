---
title: "refactor: a Region is data, and Bornholm and the Pacific Northwest are two of them"
type: refactor
status: active
date: 2026-10-18
---

# refactor: a Region is data, and Bornholm and the Pacific Northwest are two of them

## Overview

Every number that makes the island Bornholm (its seasons, wind roses, rain background, rock stack, summit, sea-floor profile, ice geometry, plants) is a module constant read at load, and the generator's kernels bake some into their WGSL text. The operator wants beautiful mountains, lush valleys, rivers and lakes grading to coast, a mix of Squamish (Coast Mountains granite, fjord) and west Vancouver Island (very wet open coast), and wants nothing hardcoded: the system should allow both climates. So a `Region` becomes one typed value, `islandOf(seed, region)` takes it, and `BORNHOLM` and `PNW` are two entries in a registry. The default stays Bornholm so nothing existing changes.

## Requirements Trace

- R1. One `Region` type holds every place-specific number, each with its citation or tag; no generator, kernel or reader imports a Bornholm constant directly.
- R2. `islandOf(seed, region = BORNHOLM)` and `generateIsland(rand, gpu, region)` produce the island of that region; the world saves its region name and `VERSION` covers it.
- R3. Bornholm islands are byte-identical to today's (the pinned goldens hold) after the refactor, before any PNW data goes in.
- R4. The kernels take region numbers as data (a table buffer, or WGSL generated per region and cached by source), never as a literal edited per region.
- R5. Kernel limits that the PNW would break (the 1,024 m hydrology ceiling, the 1,900 m upstream blur, fixed-point scales chosen from Bornholm's ranges) are lifted or derived from the region, and tested at 2,000 m.
- R6. The PNW region's numbers are cited (ECCC and WSC normals for Squamish and Tofino, geology of the Coast Plutonic Complex and Wrangellia, rain-transect literature) or tagged; a failing check is a model gap, never a retune.
- R7. The PNW coast-to-mountain gradient comes out of the cited orographic law, not a drawn zone.

## Scope Boundaries

- Phase 1 is land and climate. The forest (niches in `niche.ts`, species tables in `plants.ts`/`flora.ts`) and the animals and food are Phases 2 and 3, each also a region field, and are not started here.
- No new generator laws unless a PNW process needs one (glacial valley cutting at 2,000 m scale, a snowline); any such law is cited first.

## Key Technical Decisions

- **`Region` lives in `src/terrain/region.ts`** as a plain object type with sub-objects: `relief` (summit, uplift derivation, crystalline share, dip, rock stack, sea-floor profiles, dykes), `ice` (joint sets, valley layout, shear stress, margin distance), `climate` (seasons, wind roses, background rain, stability, fog, snow spreads, pool, sea wind), `hydrology` and `ground` overrides only where a constant is place-specific (water table threshold, rock conductivities).
- **WGSL is generated per region** where constants are baked in (the existing `fireBeds()`-style string functions take the region); pipelines are already cached by source text, so two regions cost two compiles, not new code.
- **The sim reads the region from the world** (`w.region`), replacing `air.ts` and `wetness.ts` imports of `SEASONS`, `POOL_C`, `ROSE`.
- **Rock tables**: `ROCKS` and `DRIFTS` become region-supplied lists with a shared schema; the PNW adds granodiorite, volcanic and metasedimentary entries with cited conductivities and erodibilities.

## Implementation Units

- [ ] **Unit 1: The `Region` type and `BORNHOLM`, with no behaviour change.** Move every constant named in the survey (climate.ts exports, island.ts exports, geology.ts tables, the kernels' baked literals) into `BORNHOLM`; readers take the region. Gate: all stage goldens and the 24-seed gap table are unchanged.
- [ ] **Unit 2: Region through the pipeline.** `islandOf(seed, region)`, `generateIsland(..., region)`, `world.region`, save and `VERSION`; kernels generated per region; sim readers (`air.ts`, `wetness.ts`, `rain.ts`) read `w.region`.
- [ ] **Unit 3: Lift the height and scale limits** (hydrology 1,024 m, upstream blur, rain and climate fixed-point scales, ground scales) by deriving them from the region's summit; tests at 2,000 m.
- [ ] **Unit 4: PNW data, researched.** Squamish and west Vancouver Island normals (season temperature, rain, rain-hour wind and humidity from radiosondes at Quillayute and Port Hardy, wind roses), rock stack and erodibility, fjord and valley geometry, summit, sea-floor profile; each cited with an R-number from R1400.
- [ ] **Unit 5: Measure and report** the PNW island with `island-gaps` generalised to a region's own targets (rain by band, lake area, rivers, snowline, relief), seeds 1 to 24, gaps written as gaps.
- [ ] **Unit 6 (Phase 2): forest niches per region.** **Unit 7 (Phase 3): fauna and food per region.**

## Risks

| Risk | Mitigation |
|------|------------|
| Refactor shifts Bornholm's islands | Unit 1 is gated on unchanged goldens and gap table before any new data |
| Kernels' fixed-point scales fail at 2,000 m or 3,500 mm | Derived from the region and tested at the extremes (Unit 3) before PNW data goes in |
| The rain theory overshoots (+413 mm at 800 m already) | The PNW's contrast is large and real; judged against cited transects, a gap if it misses |
| Plants and animals stay Bornholm's in Phase 1 (oak and deer on a cedar coast) | Stated; Phase 2 and 3 are region fields too |
