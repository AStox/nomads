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

## Update: V11, V12 and the whole-planet tiers 0 to 3 (2026-10-27, later)

Code: `globe-t3` 7f20964 (band hold on the patch path and region harness; `NOMADS_HOLD_OFF_TIERS=1,2,3` with `NOMADS_BAND_SPAN=2`). The streamed tier path (tiers-stream.ts, the real bake's tiers 4 and 5) has no band kernels yet.

- V11r (Rho8 tier 0, band span 2 at tiers 1 to 5): R1 lock windows 4 of 31 (uniform 5; V0 11 of 28), home 4 of 59 (uniform 11; V0 25 of 60), straight300 R1 .590 to .521, R stem sinuosity 1.31 to 1.18, lattice-straight 300-cell stretches 14 to 4. Regional pictures: arcs, oblique confluences, forked ridges, no 45 degree trunk. Tier-0 mean error p99 580 to 830 m at every tier (signed within 4 m, land share within .01).
- V12 (V11r plus channel nucleation at tiers 1 to 5): no change (peak ratio 4.98 to 4.51, wavelength 6.6 km at every tier). Nucleated detail does not grow in 266 My under a band hold either.
- Ridge wavelength: 4.8 km under box holds, 6 to 7 km under band span 2, both 2 to 3 tier-0 cells; the model's own Perron range (Lc 237 m, 6.4 to 12.7 Lc) is 1.5 to 3 km and no variant is inside it. The 7.7 km pattern is already in the tier-0 chain's carry.
- Slope: at equal 10 km relief the variants are no steeper than V0 (1000 to 1500 m relief: 13.6 to 14.6 degrees against 0.24 tan live; Montgomery and Brandon 2002 S = 4 + 0.014 Rz scaled to a 90 m DEM: 0.28 to 0.39). slope50 rose because more land sits in high-relief windows.
- Relief (open gap): share of land 10 km windows above 1000/1500/2000 m is .149/.096/.064 at the live tier 0 (real land: under .05 above 1000 m, under .02 above 1500 m), .246/.156/.108 at tier 1, flat after; the band hold adds 3 to 5 points in the tier-0 cell means (V11r .181 against V2 .135 at tier 3 averaged). Rho8 is not the cause. The chain's land mean is 1363 m against Earth's 840.
- Pyramid: every level is pooled from tier 5 (pyramid.ts 147 to 154); no bake tier below 5 is read.
- Whole planet, V0 against V11r (tier 3): land share .2553 / .2584, land mean 1354 / 1270 m, p99 4711 / 4867 m, max 5519 / 6458 m; land and sea flip over 2.6% of the planet's area. Test spots: home and E2 keep their place; A becomes a 292 m lowland on a smaller island; the highest range D and the mountain M are gone from their places (nearest summit 181 km away); K3 stays coast; the biggest river is 85 km away.
- Honest read of the whole-planet maps (`/tmp/globe-fix-t3/impl/png/final-planet-*.png`): V11r removes the diagonal and axial river runs in the regional views, but at planet scale both planets still show a corduroy of ridges about 6 km apart around every massif and along coasts, and V11r adds a bundle of three parallel straight rivers across a plain. It does not pass.

Stage costs (GPU s, live bake): tier-0 chain 343; tiers 1 to 3 in memory 164 to 169; streamed tier 1 30, tier 2 101, tier 3 365, tier 4 1,910, tier 5 2,187; air 10,107 (18.9 GB), water 1,236 (12.1 GB), ground 775 (8.9 GB), groundtiles 384 (3.5 GB), pyramid 455 (0.95 GB), terrain 152 (1.6 GB); about 5 h and 50 GB in all.

## Update: the tier-0 relief window, V13r and V14r (2026-10-27, night); handover

Code: `globe-t3` 9043d28 (`NOMADS_T0_RELIEF_WINDOW=1`; bundle at /tmp/globe-fix-t3/globe-t3.bundle is older), notes `/tmp/globe-fix-t3/impl/notes.md` section RA8, tables `logs/table-v13.md`.

Cause found for the over-high relief and for the 6 to 7 km ridge pattern: the tier-0 relief law (Montgomery and Brandon 2002, E = E0 + K R / (1 - (R/Rc)^2), R the relief within a 10 km diameter circle) was fed the height over the lowest axis neighbour, a 2.4 km reach, a fifth of the cited window, so tier 0 under-denuded. `NOMADS_T0_RELIEF_WINDOW=1` takes max minus min over the 21 cells within 5 km (5 by 5 less corners; 2.26 cells at the mean cell width 2,211 m; unflooded heights; Rc, cap, E0, K untouched; kernel equals twin, default unchanged).

- Tier 0 (V13r = Rho8 plus the window; 333 s GPU): land mean 550 m, p50 404 m (Earth 408), land share .2367, 10 km relief shares above 1000 / 1500 m .036 / .014 (real: under .05 / .02), tallest summit 4.6 km (was 5.1). Everything moves: 4.6 to 5.3% of the planet flips land/sea, components 36 to 143.
- Planet-wide tiers 1 to 3 still add relief (above 1000 / 1500 m: box .149 / .052, band .164 / .065, V14r no erosion at tiers 1 to 3 .073 / .026; real under .05 / .02); R1 tier 5 above 1500 m is inside the real bound (.020 box, .003 band).
- Ridge spacing at tier 5, spectrum peak: 2.6 to 3.0 km in every V13r variant (V0 4.8, V11r 6 to 7), the upper edge of the model's own Perron range 1.5 to 3 km (Lc 237 m). V14r (no erosion at tiers 1 to 3, band span 2 at tiers 4 and 5, region path) grows 2.5 to 3.0 km ridges at tiers 4 and 5 in 266 My, so valleys do form where they can be resolved.
- Tier-0 mean error p99: box 0.00 to 0.03 m; band span 2 at tiers 1 to 5 345 to 413 m; V14r 147 to 267 m in the regions.
- Slope per relief class is 45 to 55% (R1) and 70 to 90% (home) of Montgomery and Brandon's S = 4 + 0.014 R (scaled for 90 m cells it is the lower edge): the terrain is gentler than the cited law; slope50 fell to .06 to .09.
- Pictures (png/final-v13-*.png, final-planet-V13rb.png): the washboard becomes a branching, dendritic ridge network with side valleys; the three-parallel-rivers bundle and the 45 degree trunk are gone; rivers wander. Remaining: stepped parallelogram coast on one island, coast stripes, uniformly gentle slopes, few high mountains.
- Test spots on V13rb: A sea (9 km from its island's coast), B land, C sea (as live; nearest land 33 km), home land 913 m (live 2165 m) same continent 1 km, D gone (nearest 0.7 x peak 317 km away), R sea, E2 not reported here; the biggest river is 33,449 km2 at -50.65, -57.91 (live 85,157 km2).

## Handover for the next owner (T4)

State: the candidate is V13r chain (Rho8 plus relief window at tier 0) with either V13rb (band span 2 at tiers 1 to 5) or V14r (no erosion at tiers 1 to 3, band at 4 and 5). Open before a rebake plan: (1) the streamed tiers 4 and 5 (tiers-stream.ts) have no band kernels and no skip knob; only the in-memory and region paths do, so the real bake path must be built and byte-tested (band hold, skip tiers); (2) the hold at tiers 4 and 5 must be shown to keep near and far views consistent (pyramid pools tier 5 only, so it does); (3) planet-wide relief at tiers 1 to 3 is 1.3 to 3 times the cited shares, every eroding tier adds it (tier 1 most): a cited law is missing there (relief limits per tier), or choose V14r; (4) gentle slopes against Montgomery and Brandon; (5) test spots move: pick them by meaning on the new planet; (6) rebake: store key changes (every source hash), about 5 h and 50 GB (tier 4 1,910 s, tier 5 2,187 s, air 10,107 s), the old 51 GB bake must be deleted first; V14r saves the tier 1 to 3 steps (about 500 s) only. Scratch: /tmp/globe-fix-t3 (about 1 GB), worktree /tmp/globe-fix-t3/wt.
