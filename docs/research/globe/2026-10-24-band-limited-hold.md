# The band-limited hold: what it can and cannot do (2026-10-24)

Question: the fine tiers' uplift holds the box mean of every tier-0 cell. The audit found a washboard of ridges two tier-0 cells apart, locked to the lattice axes. Can the hold be replaced by one on the part of the field the tier-0 lattice can represent, with no tuning, so that the relief cannot drift and nothing locks to cell boundaries?

## The operator (region path, src/gpu/wgsl/globe-regional.ts `tally`, `psolve`, `lift`, `pcarry`)

- Reconstruction R: the rise of a land cell is the quadratic B-spline interpolation of coefficients m on the tier-0 cells (the limit of the 3/4, 1/4 carry-down stencil: Chaikin's limit curve). Its space V is the one the planet's tier-0 field is carried into.
- Analysis A = R^T: the conserved quantity at tier-0 centre q is c_q = sum over land cells k of W_kq h_k, W_kq the B-spline weight of cell k on q (nine weights, sum 1, exact over 8 B^2 per axis, held as Q12 integers summing to 4096). A is the L2 projection onto V (the Galerkin moment).
- Gram system: each step solves (R^T D R) m = R^T D ER + carry, D the land mask, ER the height the cells lost. R^T D R is non-negative, symmetric, positive semi-definite, local (5 by 5 tier-0 cells); it is built from the same integer weights (45 pair sums a tier-0 cell, Q16). The rise R m is the L2 best fit of the loss on the land by V. What V cannot carry stays lowered.
- Exactness: the weighted loss, the weighted realized rises (after rounding and the hold at one unit) and the 64-bit carry are kept in integers, so c_q + carry_q is conserved exactly (the carry pays what rounding, an unconverged mode or the one-unit floor leaves). Cells held at one unit are counted (`clamped`, `dropped`); that height is owed, not dropped.
- Solve: Jacobi sweeps scaled by the row sum. The matrix is non-negative, so the sweep factor is 1 minus an eigenvalue of (row sum)^-1 M in (0, 1]: no overshoot. For a land that fills the lattice the Gram of the quadratic B-spline translates is 11/20, 13/60, 1/120 per axis, so eigenvalues run from 1 (smooth) to 0.133 (Nyquist on one axis) and 0.0178 (both): 128 sweeps leave 1e-8 and 0.1 of the error. [derived]
- Second kernel (`UPLIFT_SPAN=2`, env BAND_SPAN=2): the same operator on B-splines of knot spacing 2a (V_2 inside V_1: the quadratic B-spline is refinable). A quadratic B-spline of knot spacing 2a has a triple zero at k = pi / a, the tier-0 lattice's Nyquist, so the hold is blind to wavelengths of two tier-0 cells (4.8 km) and sees nothing finer. This is the only choice with a zero at Nyquist that keeps the carry-down kernel's family; the span is the integer 2 because the lattices must nest.

## Why one exact hold cannot do both (derived, then measured)

A hold fixes one number per lattice site. For lattice mode q the equation is sum_n A(q + 2 pi n / a) (loss - rise)(q + 2 pi n / a) = 0, and the solution m = G^-1 A L is consistent for every mode where A has any response, however small (G and the right side carry the same factor). So an exact hold pays every lattice mode it can see, including the cos-phase of a wave at the lattice Nyquist; the sin-phase (zero at the tier-0 centres) is orthogonal to V and survives, and the law grows it: the lattice lock. Composing A with any lattice filter (binomial, 2F - F^2) changes nothing when the solve is exact. The lock goes only when the lattice is coarser than the ridge scale (span 2), and then the band between span 2's cutoff (9.6 km) and the tier-0 Nyquist (4.8 km), unconstrained, drifts: the law's valleys at 5 to 10 km lower the mean and the ridges are not lifted.

## Measurements (8 by 8 tile regions; tiers 1 to 3 remade by each chain; tier 4 28 steps, tier 5 6 steps)

Region 1 face 0 tx 23 ty 17 (range), region 3 face 3 tx 13 ty 13 (range, 107 ramp windows in the baseline), region 2 face 0 tx 20 ty 8 (coast, 15% land: no ridge windows, used for the coast and the drift). Baseline b5/c5/d5 is the box hold. Margin 12 tier-0 cells for the drift columns.

| | axis windows | peak ratio / wavelength km | slope50 | land p99 m | box err p50 / p99 | 3x3 p99 | 5x5 p99 | A err p99 |
|---|---|---|---|---|---|---|---|---|
| R1 baseline | 12 of 24 | 4.22 / 4.52 | 0.289 | 4883 | 0.01 / 0.13 | 0.03 | 0.02 | 57 (K1 weights) |
| R1 span 1 | 13 of 24 | 3.97 / 4.27 | 0.284 | 4868 | 12 / 94 | 18 | 11 | 1.37 |
| R1 span 2 | 5 of 24 | 4.40 / 5.12 | 0.359 | 5292 | 67 / 852 | 195 | 149 | 1.59 |
| R1 S1 (earlier) | 1 of 23 | 4.33 / 5.12 | 0.416 | 5718 | 156 / 1340 | | | |
| R3 baseline | 35 of 107 | 4.10 / 4.52 | 0.318 | 4859 | 0.01 / 0.16 | 0.03 | 0.02 | 50 |
| R3 span 1 | 37 of 103 | 4.32 / 4.27 | 0.313 | 4856 | 13 / 100 | 18 | 9 | 2.42 |
| R3 span 2 | 12 of 102 | 3.97 / 5.49 | 0.395 | 5285 | 101 / 825 | 207 | 138 | 1.84 |
| R2 baseline | | | 0.243 | 2019 | 0.01 / 0.02 | 0.01 | 0.01 | 49 |
| R2 span 1 | | | 0.251 | 2032 | 16 / 94 | 13 | 9 | 0.64 |
| R2 span 2 | | | 0.336 | 2051 | 36 / 259 | 47 | 26 | 0.55 |

Uniform expectation of the axis count is 4 to 5 of 24 and 18 of 102. Coast box dimension and straight shares did not move (R2 D 0.991, 0.989, 0.987; run16 0.324, 0.323, 0.273; R1 D 1.019, 1.010, 1.016).

Ideal brick wall (host FFT, rise = the loss low-passed at the tier-0 lattice's square Brillouin zone; region 1 from the baseline tier 3): axis 6 of 23, slope50 0.297, land p99 4894, peak ratio 4.47, wavelength 4.52 km, box err p99 226, 3x3 p99 48, 5x5 p99 21 (the zero padding leaks at the region edge and the coast).

## Gate

Fails for every hold. Span 1 keeps the slope and the height but the lock stays (13 of 24, 37 of 103) and the box, 3x3 and 5x5 means are 94, 18 and 11 m off. Span 2 and the ideal brick wall remove the lock but drift (box p99 850 and 230 m, 3x3 p99 195 and 48 m; slope 0.36 for span 2, 0.30 for the ideal) and the ridge peak ratio does not fall (4.4, 4.5). The box mean and the B-spline moment disagree by tens of metres (the baseline's moment is 50 to 57 m off, span 1's box mean 94 to 100 m off), so not both can be held to 1 m.

The remaining source of the periodicity once the lock is gone is the law itself: planar threshold facets between valleys 3.5 to 5 km apart (the ridge peak ratio stays 4.0 to 4.5 against 1.6 to 2.5 for the scale-free surface, and the spacing was already 3.8 km from a tier 0 smoothed six times).

Not done: the streamed chain (regional-patch.ts, tiers-stream.ts still call the removed `pstencil`), tiers.test.ts and regional.test.ts for the new words; no rebake plan since the region does not pass.
