# Coarse-tier variants for straight rivers: checkpoint (2026-10-27, no variant passes the gate yet)

Chain: `2026-10-26-resolution-aware-coarse-tiers-design.md`, `2026-10-26-straight-rivers-tier0-and-hold.md`. Code: branch `globe-t3` (local, fd762c9; knobs `NOMADS_T0_RHO8`, `NOMADS_DEFF_TIERS`, `NOMADS_HOLD_OFF_TIERS`, `NOMADS_BAND_SPAN`, `NOMADS_SKIP_TIERS`, all off by default, default chain byte-identical: tier-0 control 0 of 393,216 receivers differ). Scratch notes with every table: `/tmp/globe-fix-t3/impl/notes.md`, cited targets `/tmp/globe-fix-t3/refs/targets.md`. Regions R1 (face 0 tx 23 ty 17), R2, R3, home (face 4 23,21), A (face 0 1,14), R block (face 1), 8 by 8 tiles, tiers 4 and 5 28 + 6 steps.

## Results (against V0 = the live chain)

| variant | what | lock windows (R1 / home; uniform 5 / 11) | ridge peak ratio R1 | R stem sinuosity; lattice-straight 300 stretches | tier-0 drift |
|---|---|---|---|---|---|
| V0 | live | 11 of 28 / 25 of 60 | 4.14 | 1.307; 14 | 0 |
| V2 | Rho8 at tier 0 | 13 of 31 / 28 of 59 | 4.1 | 1.142; 1 | 0 |
| V3 | scale-aware diffusion D_t, tiers 0 to 2 | 32 of 89 (R3) | 4.56 (R3) | 1.191; 29 | 0 |
| V4 | D_t and Rho8 | 35 of 95 (R3) | 4.0 (R3) | 1.275; 14 | 0 |
| V1 | band hold span 2 at tier 1 | 3 of 28 / 4 of 61 | 5.0 | 1.371; 7 | box err p99 700 to 840 m |
| V6, V7 | hold off at tier 1 (live, Rho8) | 0 | none | 1.115, 1.105; 0 | land mean 1,300 m low, land share 5 to 8 points down: unusable |
| V8 | band span 2 at tier 1 and Rho8 | 8 of 31 / 3 of 60 | 5.1 | 1.225; 5 | box err p99 700 to 840 m, slope50 .24 to .42, land p99 +4 to 10% |
| V9, V10 | no erosion at tier 1 or tiers 1, 2 (box hold) | 8 of 27 / 19 of 59 | 4.3, 4.5 | 1.291, 1.174; 14, 8 | nil |

## Findings

- Scale-aware diffusion (RA1) makes the washboard more perfect (home: ridges dead parallel for 1,000 cells); dropped.
- Rho8 at tier 0 removes R's 45 degree trunk but leaves long axial runs; ridges unchanged.
- The 4.2 to 4.8 km ridge wavelength is born in whichever tier first erodes under the box hold of tier-0 means (tier 1 in V0, tier 2 in V9, tier 3 in V10), the same kilometres at 1200, 600 and 300 m cells: it is not a cell-count lattice, and tier 0's own 2-cell peak is weak (1.2 to 1.7). The tier-0 carry is a clean 7.7 km pattern. The exact box hold carries it.
- Only band span 2 at tier 1 with Rho8 (V8) looks natural in pictures (rivers arc, confluences oblique, ridges fork), at the cost of an exact tier-0 mean (700 to 840 m error p99) and a taller, steeper land.
- Gate correction: our model's own Perron spacing is 6.4 to 12.7 Lc with Lc = (D/K)^(1/2) = 237 m, so 1.5 to 3 km, resolvable at tiers 3 to 5; the cited 30 to 320 m (Perron et al. 2009 Table 1) are field sites with their own Lc and are not the target here.
- Hergarten 2020 effective erodibility not built (channel-head threshold 0.02 of a tier-0 cell, outside its fitted range 15 to 10,000 pixels).

## Next

Band span 2 at every tier (1 to 3 and the region path) with Rho8 (V11), to see whether the 7 km carry goes; then, if a variant passes by picture and numbers, the whole-planet tiers 0 to 3 and the rebake plan. No rebake plan until a gate passes.
