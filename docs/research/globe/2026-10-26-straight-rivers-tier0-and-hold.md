# Straight rivers and evenly spaced ridges: the cause is tier 0 plus the exact hold; Rho8, nucleation, tier-0 draw and area smoothing do not move it (measured, not adopted)

Chain: `2026-10-24-fine-relief-design.md`, `2026-10-25-rock-creep-and-routing.md`, `2026-10-25-corner-rebake.md`. Branches (local, not pushed): `globe-t2` ee3eff4 (tier-0 draw), 17d3f68 (tier-0 erodibility field); `globe-t2-rho8` (Rho8, nucleation, area smoothing, 34bfea0). Scratch notes: `/tmp/globe-fix-t2/{T2Diag,rho8}/notes.md`. Regions as before (R1 face 0 tx 23 ty 17, R2 face 0 tx 20 ty 8, R3 face 3 tx 13 ty 13, 8 by 8 tiles), plus the R block (face 1 tiles 9 to 16 by 16 to 23), the home block (face 4 tile 23,21) and A (face 0 tile 1,14).

## Cause of the river R (12.02 N 83.89 E, face 1, tier 5 X 3539 Y 5196)

R is a lattice diagonal, heading 47.5 degrees (the isometric view shows it as horizontal). Tier 0 (2.4 km cells) routes by steepest of eight (`globe-erosion.ts` recv). A planar ramp whose fall line (48.4 degrees, 25 m a cell over 17 cells) lies inside the 22.5 to 67.5 degree wedge sends water along (1,1) for 14 or more cells and cuts a V valley (walls 300 to 700 m within 3 cells) on the diagonal. The rock is one uniform granitoid pool, so no tectonic or lithologic line is involved. Tiers 1 to 5 hold every tier-0 cell mean exactly (error 0.5 m), so the valley floor stays within 0.00 to 0.13 tier-0 cells of the tier-0 diagonal at every tier (0.03 at tier 5). Stem: 332 cells within 8 cells of the chord (33 km), sinuosity 1.085 over the traced 207-cell reach, three lakes on x minus y = -1568.3, -1567.6, -1566.1. Ruled out: cube edge (225 km away), tile halos (no heading change at the two tile edges), lake fill (the lakes sit on the valley floor), tectonics. Generality: 43 of 80 lake blobs of 100+ cells in a 6 by 6 tile block lie within 4 cells of a tier-0 diagonal (25 percent expected); 300-cell straight stretches within 8 cells of a lattice chord: R block 15, home 14, E2 3, R1 2, A 1, R2 0, R3 0.

## Where the washboard is born

Ridge wavelength (km, cells) tier 0 / 1 / 2 / 3 / 5: R1 4.8 (2) / 5.1 (4.3) / 4.8 (8) / 4.5 (15) / 4.8 (64); home 5.9 (2.5) / 4.3 (3.6) / 4.0 (6.7) / 3.8 (12.8) / 3.7 (49); A 5.9 (2.5) / 5.9 (4.9) / 5.1 (8.5) / 5.5 (18) / 5.1 (68). The same kilometres from tier 1 to tier 5, 2 to 3 cells at tier 0. On the home block tier 0 is smooth and tier 1 grows an orthogonal 2 to 3 cell lattice (1.2 km cells). Tier 1 erosion rebuilds it at its Nyquist spacing; tiers 2, 3 and 5 keep it (peak ratio rises 10 to 20 percent at tiers 2 and 3) because every tier's mean is held to the tier above. Perron et al. 2009 (Nature 460, 502-505) give valley spacing 6.4 to 12.7 Lc with Lc = (D/K)^(1/(2m+1)) = 237 m here, so 1.5 to 3.0 km: 0.6 to 1.25 cells at tier 0, 1.25 to 2.5 at tier 1, unresolved at both. Kargère et al. 2024 (EGUsphere preprint, not peer reviewed): channel heads form at A = r squared, r proportional to sqrt(D/K); when the cell is wider than r the landscape is all channel, which is the grid-limited valley spacing seen here (r over cell about 0.13, 0.26, 0.51, 1.0, 2.1, 4.1 for tiers 0 to 5, an inference from their Gabilan Mesa coefficient).

## What was tried

| variant | result on the lock |
|---|---|
| Rho8 at tiers 4 and 5 (Lindsay's WhiteboxTools form of Fairfield and Leymarie 1991, diagonal fall over 2 minus r, integer Philox of global cell id and step, byte identical, overlap of 143,360 cells equal; the 1991 paper text was not reachable) | R1 slope .289 to .302, peak 4.19 to 4.12, windows 12 to 13 of 24, axial-8 300+ .415 to .470, straight30 .754 to .790, spacing 2.1 to 2.1 km: no change |
| Nucleation: zero-sum Haar detail per parent, amplitude = last resolved octave over sqrt 2 (k^-2, Huang and Turcotte 1989; 11.8 m at tier 4, 2.3 m at tier 5), tier-0 means exact | R1 peak 3.90, windows 10 of 24, slope .280, straight30 .761, spacing 2.17: inside noise |
| Rho8, nucleation or both also at tiers 1 to 3 | windows 11 to 16 of 24, peaks 3.4 to 4.5, no pattern |
| Perron 2009 SI 1.2 drainage-area smoothing for incision, 3 by 3 / 5 by 5 | removes the tier-1 lattice, it returns at tier 2; with tiers 2 and 3 smoothed too the ridges are straighter (home axis-locked windows 23 of 59 to 35 of 62, R3 35 to 42 of 104); 5 by 5 at tier 1 only gave home 15 of 59, not seen elsewhere |
| Tier-0 receiver draw (slope-proportional Philox in the chain; control reproduces the live chain, 0 of 393,216 receivers differ) | tier-0 straight runs of 9+ cells 385 to 32, R trunk keeps a 14-cell diagonal 3 cells away; R stem within 8 cells of chord 323 to 404 cells; lattice-straight 300-cell stretches in the R block 15 to 8; R1 to R3 peak ratio 4.1 to 4.4 unchanged, axis windows same or higher; moves 2.2 percent of the planet between land and sea, relief minus 11 percent, slope minus 15 percent, the highest range |
| Tier-0 erodibility field (log K = log K_class + 1.506 g, g six octaves of 3D plane waves at 9.4 to 300 km, k^-2 [design], 1.506 = ln(sandstone over granite)) | at tier 0 alone: 6.3 percent of the planet flips; R's place changes; other long straight rivers remain (331 and 386 cells); at tiers 1 to 5 only: R stem 272 cells (baseline 323) and more lattice-straight stretches (22 against 14) |
| Field plus draw at tier 0 | most lattice-straight rivers go (R block 14 to 1) but on a different landscape (R window slope .05 against .119, R2 has 3.6 times the land), washboard ridges persist, a long diagonal trunk survives |

Gate: no variant passes. Lock windows, ridge peak ratio (3.4 to 5.7 against target 2 to 3), first stream spacing (2 to 2.6 km against 30 to 321 m real) and straight share did not move toward the target in any variant that kept the same land.

## Natural sinuosity (for the R check)

Straight under 1.05, sinuous 1.05 to 1.25, meandering over 1.25 (Washington DNR guide, via search results, not read in the original). Leopold and Wolman 1957 (USGS PP 282-B): reaches straight for more than 10 channel widths are rare (search snippet). R's 33 to 40 km stem at 100 to 200 m width (hydraulic geometry, inference) is over 100 widths at sinuosity 1.03 to 1.05.

## Gaps

- The hold itself was never switched off at tier 0 to 1: whether the valley locks by the exact mean hold alone (or by the V valley walls) is untested. The earlier band-limited hold (4350a26) kept the lock.
- Hergarten 2020 (Earth Surf. Dynam. 8, 367-377, read sections 1 to 3): effective K at river sites E = A_e K A^m S^n with A_e = 1.360 A_c^0.465, A_c the channel head threshold in cells, so effective K scales about as cell width to the minus 0.93 at a fixed physical threshold. Not built. Pelletier 2010 (Geomorphology 122, 91-98) is abstract only.
- A resolution-aware tier 0 and tier 1 law (sub-grid hillslope and valley relief, not an all-channel cell) is the remaining physically motivated change; it moves the whole planet and needs the full rebake.
- Streamed implementation of the area smoothing and of the tier-0 field were not built. Ice stage was not rerun for the drawn and field chains (a stand-in bed changed R's window by exactly 0).
- Lake blobs on tier-0 diagonals and 300-cell straight stretches are a property of the data now published; any page-side smoothing of the drawn streams does not touch them.
