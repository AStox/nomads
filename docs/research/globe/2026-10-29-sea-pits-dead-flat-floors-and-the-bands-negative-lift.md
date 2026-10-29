# Sea pits, dead flat floors and bowls: the carry's corner stencil and the band hold's negative lift (2026-10-29)

Chain: `2026-10-29-coast-artifacts-whole-metre-heights-and-the-box-limiter.md` (its open items 1 to 3), `2026-10-24-band-limited-hold.md`. Candidate A2 = `globe-t5-a` at its head: the A candidate (tiers 1 to 3 carry only) plus the two fixes below. Pictures and scripts: scratch `~/.cache/nomads-scratch/t5/out` and `wt/scratch`.

## What was asked

The squircle lake at K3 (a rounded square, the same in A and B), the featureless flat plains with blob-shaped orange patches (inland sea pits) at the river, spit and shelf windows, lake outline roundness against the old planet, nine places, the rebase.

## Cause 1: the orange blobs are the carry's ringing beside a tier-0 column, let through by the nine-parent stencil

- Not tier-0 data. Lone below-sea cells inside land: the new chain has 3 enclosed sea components of 4 cells in all, the old chain 27 of 405 cells (`scratch/pits0.ts`). The old planet's windows hold 58 enclosed sea components (7,483 cells) against 140 (10,823 cells) of the rejected planet: pits are not new, there were more of them.
- Measured in the carry alone (tiers 0 to 5, `scratch/pits5.ts`): 9 to 15 enclosed sea components of about 700 tier-5 cells in each 640 by 640 window of the river, spit, K3, B and lake places. At K3 the pit is 0.8 by 1.5 tier-0 cells, down to -2.5 m, beside a column of 13 to 14 m (tier-0 cells (66,68) and (66,69)) on a plain of 0.8 m, with a sea cell at (66,67), its diagonal. The mean-restoring passes ring at such a cliff (an undershoot on both sides of the column).
- Why `limitSea` let it through: its stencil was the nine parents ("all nine land or all nine sea"), so a sea parent at a corner of the 3 by 3 freed every child of the cell.
- Fix (regional.ts `limitSea`, refineSmooth and the streamed refineBlock): the stencil is the parent and the two parents that share an edge with each child (its x side and its y side): a child of a land parent whose two are land is held one unit above the sea (Zhang and Shu scaling as before), a child of a sea parent whose two are sea one unit below. A sea cell touching the parent's corner frees no child. The nine-parent rule is a special case. Tests: `regional.test.ts` "sea-level limiter" (invariant stated on the edge stencil, plus a corner-touch case), `tiers-stream.test.ts` "refineBlock" (word for word equal to refineSmooth), both pass.
- Numbers: carry alone, enclosed sea components 65 (12,123 cells) to 2 (10 cells) over the five windows; streamed tier 3 of the real chain (`bakeA2/1-b4c6e7d1b819/t3-height.i32`, 384 windows at the places): spit 15 to 0, river 28 to 0, lake 21 to 1, shelf 16 to 2, K3 17 to 0, B 7 to 0, home 4 to 1, ridges 6 to 2, E2 6 to 1. After tiers 4 and 5 (the region harness): 136 to 1 components over the five windows (`scratch/lakecmp.ts`, `pits5.ts`).

## Cause 2: the band hold's lift is negative where its fit undershoots; the cell sinks to the one-unit floor

- The squircle is not in the data or the carry. Tier 0 has no depression there (the priority flood of tier 0 marks none at (69.6, 68.8)); the carry has no lake there; the profile through its column (`scratch/k3prof.ts`) is a smooth 0.5 to 2.2 m plain. Stepwise tier 4 of the K3 region (`sh/k3steps2.sh`, states after steps 1, 2, 4, 8, 16, 28, `scratch/k3steps.ts`): the valley floor falls from 0.69 m to the exact one-unit floor by step 8 and stays; the ridge beside it rises from 1.76 m to 3.04 m (+1.3 m); between steps 16 and 28 the floor row stays at 0.004 while its two walls fall 0.05 to 0.09 m and the ridge rises 0.24 m. The floor is about 4.9 km across (the lake is 65 by 66 tier-5 cells, two tier-0 cells a side) with a rim 0.3 to 0.9 m above it: the squircle.
- It is a dry hollow in the baked world: the water stage (`water.ts` basinOf) makes a lake only where a hollow's deepest point is over WATER_TABLE (3 m), and this one is 0.4 m deep. In every variant the K3 window has no lake by that rule. The picture's lake is the priority flood of the heights at any depth.
- Cause: the loss is concentrated in the valleys; the band hold's rise is the L2 fit of that loss by smooth functions of span 2, a signed field whose negative lobes lie beside the valleys, and `blift` applied them (a cell is only held at one unit where the fall would take it to the sea). Each step the plain beside a valley sank a little and ended on the floor: 7.9% of the K3 window's land at exactly one unit, 6.9% dead flat. Variants run at tier 4 of K3 (28 steps, `scratch/st4.ts`): strict fall above the receiver (`nh = max(hj + x, hj + 1)`, the flood's own epsilon) changed nothing (floor 7.89%, so the incision's floor was not the source); the lift never lowering a cell: floor 0.03%, dead flat 0.00%, hollow area 11.7% to 0.16% of land, land mean 10.12 to 10.17 m.
- Fix (`wgsl/globe-band-hold.ts` blift): the rise is not negative (rock uplift U >= 0 in dh/dt = U - K A^m S^n, Whipple and Tucker 1999, J. Geophys. Res. 104: 17661). What the fit asked and was withheld is counted (`clamped`, `dropped`) and stays in the carry, which the next steps' fit pays back from the rises elsewhere; the moment bookkeeping is unchanged (the carry takes whatever is not realized). Tests: `tiers-stream.test.ts` band hold of span 2 (streamed equal to in-memory, 26 expects) and `tiers.test.ts` band hold tier 1 pass.
- Mountains are unchanged: the home window (tier 4, 4 tiles, 28 steps) land mean 1233.35 m against 1233.44 m, `meanErrM` p50 / p90 / p99 46.1 / 128 / 280 against 43.0 / 131 / 284, `d2` edge ratio 1.04 against 1.03, diagonal to axis power 2.09 against 2.05, lattice axis share .50 against .49 (`dbg/home.log`).

## The six windows, A against A2 (region harness, tiers 4 and 5, four tiles; `scratch/flat.ts`)

| window | dead flat A | dead flat A2 | under 0.1 m A | under 0.1 m A2 |
|---|---|---|---|---|
| river | 28.29% | 0.04% | 33.0% | 0.9% |
| spit / shelf | 7.00% | 0.13% | 8.0% | 0.6% |
| K3 | 4.03% | 0.02% | 4.8% | 0.3% |
| B | 1.29% | 0.01% | 1.5% | 0.1% |
| lake | 2.02% | 0.00% | 2.5% | 0.0% |
| home | 0.00% | 0.00% | 0.0% | 0.0% |

Old planet: at most 0.02% dead flat in any of the windows. Straight gates, T4's six windows pooled (`sh/placegates.sh A2`, `t4/out/coastfix/sum.ts`): coast reversals per 100 km A 11.7, A2 5.0, B 19.0, old planet 10.1; coast km 1,162 to 639 (the pits' outlines are gone); squared pits .167 to none; axis share at 32 cells .257 to .330 (the tier-0 lattice-column coast is untouched: open item below); lake patches at any depth 36 to 64 with box fill .733 to .559 (smaller, branching hollows; fewer squared ones).

## Lakes: amounts, depth, roundness

- The plains are in the data: tier-0 closed depressions (priority flood of the 256-cell faces): new chain 1,062 (2.68% of land cells; 506 under 0.5 m, 450 of 1 m or more), old chain 74 (0.54%, all 1 m or more) (`scratch/dep0.ts`, `dep0b.ts`); the whole-metre heights of the rejected chain hid the shallow ones (636). A monotone carry (no mean-restoring pass) holds 4.2% of the windows' land in closed depressions, the four-pass carry 10.9% (the ringing adds 6.7 points), erosion brings it back to 4.9% (A) and 4.4% (A2) (`scratch/lakeparts.ts`, `micro.ts`).
- Lakes by the water stage's rule (`scratch/hollows.ts`: hollow = four-neighbour component of cells the flood raised by 1 cm or more, lake = deepest point over 3 m), five windows pooled: lakes over 3 m deep, share of land / count: old planet 0.04% / 5, rejected 2.25% / 7, A 2.45% / 9, A2 2.59% / 7, B 2.11% / 8. Earth: lakes cover 3.7% of non-glaciated land (Verpoorter et al. 2014, Geophys. Res. Lett. 41: 6396) [remembered, source not re-read]; the old planet's 0.04% is the outlier, not the new planets.
- Roundness P^2 / (4 pi A) (1 = disc, square 1.273; perimeter by marching squares at edge midpoints; `scratch/round.ts`, `hollows.ts`; patches of 64 cells or more not touching the window, pooled over the windows): lakes over 3 m deep: old 1.19 (p90 1.35, n 5), rejected 1.38 (2.46, 7), A 1.40 (2.21, 9), A2 1.39 (1.81, 7), B 1.37 (1.48, 8). Priority-flood lakes of any depth (same rule for every source): old 1.35 (n 20), rejected 1.28 (39), A 1.39 (43), A2 1.87 (73, box fill median .53), B 1.26 (45); for patches of 1,000 cells or more: old 1.24 (n 1), rejected 1.28 (30), A 1.29 (27), A2 1.74 (30), B 1.26 (28). The squircle itself measures 1.1 to 1.2: roundness does not separate it from natural lakes; what separated it was that it was one of 9 hollows of 11% of the window, closed by a rim the lift had raised.

## Pictures: nine places

`out/t5-<place>-384-AA2.png`: rows old planet, rejected planet, A, A2 (hillshade left, flat classes right; orange = enclosed sea, light blue = priority-flood lake of any depth) for K3, river, spit, shelf, lake, home, ridges, B. The squircle, the orange blobs and the flat plain floors are gone in the bottom row; the river window's plain keeps a speckle of 1 to 2 unit puddles (684 patches under 16 cells in the window, 0.7% of its land: dry hollows by the 3 m rule, no water in the world). E2 stands on a face edge and the region harness refuses it (`regionBlock4`: the carry's rings need the face; the ring carry across an edge is what `refineBlock` does for the streamed tiers, so a region at an edge needs a block carry through `around3`, not a change of one line): `out/t5-E2-t3-A-A2.png` is the streamed tier 3 (300 m cells) of A and A2 there. B at tx 0: the region `rB` begins at tile 1 and holds B.

## Open

1. Tier-0 lattice-column straight coasts (spit and shelf windows, the 27 km west coast at 53.8 N 27.3 E) are in the data and in A2.
2. The river plain's 1 to 2 unit puddles are the integer ramp; they are dry hollows in the water stage, but a ground painter that reads `t5-flooded` directly would draw them.
3. The straight gates' axis share at 32 cells rose (.257 to .330) with the pits' outlines gone; the remaining straight coast is tier 0.
4. The rebase of `globe-t5-a`: 44 of its 49 commits replayed onto main 0d4ee77 (5 were already in main), `-X theirs` on the path conflicts of `scripts/globe-land-region.ts`, whose final version is the branch's own; the rebased tree reproduces tier 4 and 5 of the K3 region byte for byte (cmp of `state.i32`).
