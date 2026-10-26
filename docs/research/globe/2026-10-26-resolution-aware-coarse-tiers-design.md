# Resolution-aware coarse tiers: design (2026-10-26, before any result)

Chain: `2026-10-26-straight-rivers-tier0-and-hold.md` (cause), `2026-10-24-band-limited-hold.md`, `2026-10-25-rock-creep-and-routing.md`. Branch `globe-t3` (not pushed). Nothing below is measured yet; results go in a later note.

## What the cause says

Tier 0 cells are 2.4 km. The model's own Lc = (D/K)^(1/(2m+1)) = 212 to 237 m (D 3.2e-3 m2/yr, K 7.1e-8 per yr, m = 1/2), so Perron, Kirchner and Dietrich 2009 (Nature 460, 502-505) give a valley spacing of 6.4 to 12.7 Lc, 1.5 to 3 km: 0.6 to 1.25 tier-0 cells, 1.25 to 2.5 at tier 1. A grid cannot hold a valley and a ridge in less than two cells, so every cell acts as a channel and the grid picks its own Nyquist lattice (ridges two to three cells apart, 4.8 km). Steepest-of-eight routing then locks every river on a ramp to the nearest of eight directions, and the valley that forms on the first substeps is a self-reinforcing V (walls 300 to 700 m in three cells). The exact mean hold carries both to 75 m.

## Laws

1. **RA1, the dissection a coarse cell cannot hold is a diffusion.** A tier resolves a valley spacing only if it spans at least 4 cells [design: Nyquist is 2, 4 leaves one ridge and one valley cell on each side]. With the low end of Perron's range, the Lc a tier resolves is Lc_t = 4 dx_t / 6.4 = 0.625 dx_t. Dissection below that scale is carried as hillslope diffusion D_t = max(D_creep, K Lc_t^(2m+1)), K of granite [design: a rock-dependent D is the next refinement]. This is the standard way a coarse model stands for sub-grid valleys: D_t is the diffusivity at which the model's own Perron spacing equals the resolved one. Tier 0 (2,400 m): about 0.16 m2/yr; tier 1: 0.04; tier 2: 0.010; tier 3 (300 m) and finer: the physical D, since Lc_t is then below the model's own.
2. **RA2, flow direction is uncertain by what the cell cannot hold.** Tier-0 receivers by Rho8 (Fairfield and Leymarie 1991; the diagonal fall divided by a random factor, in Lindsay's WhiteboxTools form), redrawn every substep from an integer Philox of cell id and substep: the expected direction follows the true fall line instead of one of eight, so a ramp's rivers are no longer all on one lattice diagonal. Earlier tests put Rho8 at tiers 1 to 5 (no change) and a slope-proportional draw at tier 0 (straight runs of 9+ cells 385 to 32, the main trunk kept a 14-cell diagonal); Rho8 at tier 0 has not been tried.
3. **RA3, no exact hold at the coarse tiers.** The hold was never switched off at tier 1 with the tier-0 chain left as it is; the band-limited hold was tested only for the fine tiers. A tier 1 that is held only to the smooth carry of tier 0 can move a river inside the tier-0 valley; tier 2 is still held to tier 1.

## Considered, not built

- Hergarten 2020 (Earth Surf. Dynam. 8, 367-377) effective erodibility A_e = 1.360 A_c^0.465: needs the channel-head threshold in cells. Kargere and others 2025 (Earth Surf. Dynam. 13, 403-415; the preprint says channel heads form at A = r^2, independent of grid, and that grid width plays the role of channel width) put it near 1e5 m2 here, 0.02 of a tier-0 cell, outside any fit; unbuilt.
- Perron 2010 stochastic perturbation of the surface for routing (abstract only read): same family as RA2.

## Gates (never tuned to)

Lock windows, ridge peak ratio (target 2 to 3), slope and drift, coast box dimension, straight-run share of rivers and coasts, river stem sinuosity against Leopold and Wolman 1957 classes, first stream spacing and drainage density against the cited ranges (Perron 2009), lattice-straight 300-cell stretches, diagonal crease share; and land share 0.29, hypsometry and relief for an Earth-like planet. Region tests (R1, R2, R3, the R block, home, A) first, then the planet's tiers 0 to 3.

## Open

D_t and Rho8 change the tier-0 chain, so continents, the highest range and every named place move. Whether RA1 alone, or only with RA2, removes the lock is the experiment.
