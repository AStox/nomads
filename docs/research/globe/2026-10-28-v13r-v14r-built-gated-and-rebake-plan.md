# V13r with V14r: built, gated, and the rebake plan (2026-10-28)

Chain: `2026-10-27-coarse-tier-variants-checkpoint.md` (the variants and the handover), `2026-10-26-resolution-aware-coarse-tiers-design.md`, `2026-10-26-straight-rivers-tier0-and-hold.md`. Code: branch `globe-v13r-v14r` (local, not pushed until the rebake is approved), head `1f6ba45`, made of: `globe-t4` (streamed band hold), `globe-t4-cut2` (the knobs cut over to the law), main at 943418a, the gate tools (`globe-t4-gates`) and the spots script (`globe-t4-spots`). A reboot wiped /tmp on 2026-10-28 (all scratch, stores, both bakes), so this note keeps the numbers that were in the lost notes.

## What the generator is now (no env knobs left)

- Tier 0: Rho8 receivers (Fairfield and Leymarie 1991, Lindsay's form) and the relief law's window (Montgomery and Brandon 2002: R is max minus min within 10 km, the 21 cells within 5 km). Both are in the kernel and its twin.
- Tiers 1 to 3 do no erosion: each is the smooth carry (`refineSmooth`) of the tier above, so tier 3 is tier 0 carried down. Tiers 4 and 5 erode (the island's law: eight neighbours, drawn receivers, slides of 16, one rain, 28 and 6 steps) and hold their tier-0 cell means by the band-limited hold of span 2 (wgsl/globe-band-hold.ts).
- Deleted: land diffusivity per tier, channel nucleation, drainage-area smoothing, the erodibility field, Rho8 at tiers 1 to 5, box-hold-off, every NOMADS_* knob for these. The region harness (scripts/globe-land-region.ts) takes its law from `TIER_LAWS`.
- Tier-0 chain of the new defaults is byte-identical to the knob build's (height, receivers, acc, pools 0 to 4: 0 of 393,216 differ).
- New source key (`scripts/globe-window.ts` sourceKey): `9d012c74b873`; the planet's store and bake directory key (`sourceKey(undefined, PLANET_RADIUS_M)`) is `6f5e2898ad43`. It moves with any edit of grid, tectonics, erosion, atmosphere, ice or their wgsl, so the branch must be frozen before the bake. The tier laws (tiers.ts, regional*.ts, the band kernels) are not in the key: a later edit of them would mix laws inside one bake directory.

## Job 1: the streamed tiers 4 and 5 (built, one real bug found and fixed)

- Streamed band hold (tiers-stream.ts): kernels `btallyc` (Gram counts, once at the step's end) and `btallyl` (loss, after each visit), band-wide parent tables saved between calls, a carry-overflow flag, clamped and dropped counters in progress.json, `streamTier` writes the carry for a tier of 0 steps.
- Proof against the in-memory solve (tests, one case at a time): span 2 with Rho8 over 3 steps, word for word (heights, carries, receivers, area, flooded), in blocks of 1, 2, 4 tiles, reverse and shuffled order and 0.6 s resumed calls (and different from the box hold); span 1; streamed chain with tier 1 skipped. Whole planet (25 M cells at tier 3, V13r chain, band span 2 at tiers 1 to 3): streamed against in-memory, t1 and t2 and t3 height and t3 receivers, area and flooded surface byte-identical (`cmp`).
- The bug: at tier 4 a streamed step blew up (one step: land mean 1,364 m against the carry's 549, 83% of land under 1 m, 2.4 M cells over 6 km; tier 4 span 1 half as bad; the box hold was fine). Cause: the band hold keeps the loss moment as four digit sums of 6-bit digits in 32-bit words, built for one total loss per cell. The streamed tier tallies the loss after every visit (incision, slides, 45 creep substeps at tier 4, block revisits), so the digit sums passed 2^31 (counted: 23,000 of 28,600 parents at the end of the step). Fix: a kernel `bpnorm` folds the four sums into the same 64-bit moment (low 18 bits plus the rest in the top sum) after every tally; the moment is a linear sum, so the in-memory and region paths (one tally) are unchanged. Test: 200 tallies of a loss with every digit at 63 keep the exact moment where unfolded sums pass 2^31.
- After the fix, tier 4 of the whole planet (13 calls, 1,740 s of GPU, 3 GB scratch): land mean 549 m (carry 549), p99 3,352 m, max 5,325 m, 3.9% of land under 1 m (carry 3.3%). Gate measures of the streamed tier 4 and of the region harness's tier 4 agree on R1, home, A and the R block (land p99 1,651 / 1,653 m, slope p50 .066 / .065, hold error box p99 266 / 248 m and 3x3 p99 41 / 39 m at R1, ridge wavelength 3.23 km both, lock windows 0 of 2 both, straight300 0 both, same land cell counts).
- Not proven cell for cell: the streamed tier and the region harness are NOT equal on land (R1 1,387 of 523,868 land cells equal, A 1,752 of 125,931, home 31,250 of 696,978), and this is not the band hold: with the box hold, after one step on island A, 57,023 of 125,931 land cells are equal and the rest differ by up to 239 m. The region keeps its halo at the carried heights and has no inflow from outside, so a region cannot be the oracle; the in-memory solve is (tiers 2 and 3 above). The starts are identical (0 cells differ before step 1).
- Tier 5: a whole-planet tier 5 is 402 M cells and about 15 GB of planes, so it cannot be compared with anything but itself; one streamed tier-5 step (band span 2, blocks of 4 tiles, 4 calls, about 340 s of GPU for the start and the step, 10 GB of scratch) from the streamed tier 4 gives land mean 548.9 m (tier 4: 549.2), 3.6% of land under 1 m (3.9%), no cell over 6 km, max 5,375 m. The digit sums fit 32 bits after the fold at span 2 (a tally adds at most 63 x 4096 x 4096 = 1.06e9 to one sum). The rebake's own t5-height.i32 is checked again about 1 h in (see the plan).

## Job 2: the stepped parallelogram coast (a model gap, not fixed)

Cause: it is in the planet's starting state (`startingState`, tectonics.ts): a continent takes the highest-field cells at least `START.boundaryGap` x 5.11 = 30.7 cells (74 km) from any plate edge, until 39% of the planet; only 52.9% of the planet is eligible, so the cut falls at field -0.063 and a continent is its plate's great-circle Voronoi polygon shrunk inward. The top-right island (lon 108 to 180, lat 20 to 49, on the cube corner (-x, +y, +z)) is plate 6's continent: 95% of its 10,012 tier-0 cells are plate-6 start cells; 7 coast runs of 51 to 83 km (35% of the perimeter) are polygon edges; the steps are the 4-neighbour BFS metric (74 km on lattice axes, 52 km on diagonals), with 5 to 12 km jumps where an edge crosses a start-frame cube edge. Not a cube-face edge (60 km off), not tiers 1 to 3, the live chain has the same island. No cited law covers it (boundaryGap is [design]; rifting and passive margins are listed gaps).

The proposed fix (drop boundaryGap and the BFS, top-field 39%, each connected continent to the plate that holds most of its area) was built and measured (branch globe-t4-cont 002df94) and rejected: the start state goes from 20 continents to 8 with one supercontinent of .234 (60% of continental area on one plate); the "ranges rise" test fails (cells over 2 km after 12 My: seed 1 2,413 to 223, seed 4 2,585 to 0, seed 8 1,833 to 0) because continents that collided are one plate; with Rho8 and the window the chain's land share is .2699 against .2367, land p50 267 m against 404 m, p99 1,540 m against 3,316 m, and straight coasts of 155 and 208 km remain. Fall back to V13r with V14r; the coast stays a gap.

## Job 3: gates on V13r with V14r (tools in scripts/globe-gates.ts and scripts/gates/, 17 CPU tests; no tuning, open gaps reported)

Store key at the time `b82ccfaeb552` (knob build, same bytes). Tier 0 is `planet.height` (the chain after the ice's cut: 4,789 cells at exactly 0 become land at +3 cm, which is why land share reads .249 here and .2367 on the chain's own `h > 0`).

| gate | tier 0 | tier 3 | target | result |
|---|---|---|---|---|
| land share | .249 | .237 | .29 | fail |
| land median | 351 m | 397 m | 408 m | pass |
| land mean | 524 m | 552 m | 673 to 840 m | fail |
| land p90 / p99 / max | 1154 / 3323 / 4604 m | 1199 / 3358 / 4942 m | | |
| relief above 1000 / 1500 m (inland windows) | .044 / .016 | .086 / .030 | under .05 / .02 | tier 0 pass, tier 3 fail |
| land components, largest five | 46: .145 .056 .024 .017 .003 | 139: .140 .053 .022 .015 .003 | | |
| tier-0 coast runs 40 / 100 / 150 km or more | 55 / 0 / 0 | | | |

Regions at tier 5 (R1 face 0 tx 23 ty 17, home face 4 tx 23 ty 21, A face 0 tx 1 ty 14, R block face 1 tx 9 ty 16; tier 4 within a few percent):

| | R1 | home | A | R block | target |
|---|---|---|---|---|---|
| lock windows (uniform expectation) | 0 of 20 (3.6) | 0 of 19 (3.4) | no all-land window | 0 of 4 (0.7) | at most uniform + 2 sigma: pass |
| ridge spacing km (excess over fit) | 2.87 (x11) | 3.62 (x38) | none | 3.62 (x21) | 1.5 to 3: R1 pass, home and R block fail |
| straight30 / straight300 | .097 / 0 | .075 / 0 | .112 / 0 | .057 / 0 | |
| lattice-straight 300-cell stretches | 0 | 0 | 0 | 0 | 0: pass |
| largest stem sinuosity (200-cell reach median) | 1.84 (1.22) | 1.22 (1.06) | 1.22 (1.24) | 1.58 (1.17) | over 1.05: pass |
| slope p50 / p90 / p99 (tan) | .062 / .18 / .35 | .089 / .29 / .59 | .067 / .22 / .59 | .087 / .26 / .50 | |
| slope over Montgomery and Brandon S(Rz), classes 250 to 1500 m | .38 to .52 | .35 to .72 | .22 to .52 | .36 to .60 | 0.8 to 1.25: fail (gap, not tuned) |
| relief above 1000 / 1500 m | .095 / .014 | .159 / .039 | .196 / .157 | .178 / .019 | under .05 / .02: fail except R1 at 1500 m (gap) |
| hold error, box p50 / p99, 3x3 p99 | 19 / 246 m, 39 | 14 / 246 m, 35 | 11 / 132 m, 22 | 17 / 232 m, 34 | |

Reading: the lock, the straight 300-cell runs and the 45 degree trunk are gone; rivers wander (sinuosity over 1.05 in every region); the ridge spacing is at the top of or just over our own Perron range (1.5 to 3 km, Lc 237 m) in R1 and 3.6 km at home and the R block; land share, mean and relief are open gaps (tiers 1 to 3 carry tier 0, so tier 3's relief shares are the carry's, .086 / .030 of inland windows; the cited law for relief limits per tier is missing), and the terrain is gentler than the cited S(R). Pictures: scratch `out/png/` (R1, home, A, R block at tiers 4 and 5, 1 px a cell; a 4096 x 2048 hillshade of tier 3), lost with any wipe: regenerate with `scripts/globe-gates.ts map` and the region harness.

## Test spots by meaning (scripts/globe-spots.ts; run on the new planet, tier-3 carry of key b82ccfaeb552; the places are the same on the final build because the chain's bytes are)

| spot | rule | lat, lon | face, tier-5 tile, cell |
|---|---|---|---|
| D highest range | the highest tier-3 summit (4,942 m) | -6.33, -98.02 | 3; 13,13; 38,186 |
| M a mountain | highest summit at least 300 km from D with 500 m or more rise over its 20 km disc (4,600 m, 377 km from D) | -61.24, -89.16 | 5; 16,26; 42,57 |
| R biggest river | largest mean discharge at a mouth (a land cell whose receiver is at or under 0 m): 200 m3/s, catchment 2,682 km2, stem 90 km; R half is the stem point where discharge first falls under half of the mouth's (29 km up) | mouth -3.45, 74.64; half -0.10, 72.62 | 1; 10,14; 138,186 and 1; 9,15; 210,246 |
| E2 cube edge | a land point on a cube-face edge, 40 km or more inland and 100 km from a corner, nearest to home | 6.63, 45.00 | 0; 31,19; 255,82 |
| A forest | rain over 1000 mm a year and 8 to 26 C (Holdridge precipitation axis, not verified from a source), 100 to 800 m high, 20 km inland, the deepest cell of the largest region holding a 19.2 km window | -36.04, -103.82 | 3; 11,2; 22,230 |
| B | land of another landmass than A and home, 300 to 1500 m | -11.67, 62.07 | 1; 6,11; 18,82 |
| C | open sea 100 km or more from land | -24.65, 92.61 | 1; 16,7; 238,58 |
| K3 | coast cell of home's landmass nearest to A | -15.50, 57.41 | 1; 4,9; 106,134 |
| home | the page starts at the tier-0 land cell with the most tree cover under 60 degrees of latitude (`playPlace`, demo/styles/isopixel/ground-at.js): needs the 75 m ground tiles, so `--home lat,lon` after the bake; a stand-in from the landing finder is -15.47, 57.83 (only one cell of 99,538 has ground over 1 km on this planet) | | 1; 4,9; 144,144 |

Validation on the old planet (store key 1121d207f3b8 in the restore bake): D 0.4 km, E2 0.0 km, R 10 km from the old coordinates (same features); the old A, B, C, home and M coordinates do not match this planet (A is at 3,948 m and 4.7 C there, not a forest: they came from the lost page planet 7f6ff6c82cdd).

## The rebake plan

Inputs: the branch `globe-v13r-v14r` frozen at its head (any edit of grid, tectonics, erosion, atmosphere, ice or their wgsl moves the key), `NOMADS_BAKE` left at the default `~/.cache/nomads-bakes` (bakedir.ts). Store and bake directory key `6f5e2898ad43`.

1. Coarse stages (GPU, about 10 min, 6 calls of 110 to 240 s): `bun scripts/globe-planet.ts --seed 1 --stage chain` (354 s, 3 calls), `climate0` (93 s), `ice` (66 s), `climate1` (93 s) into `<bake>/small/store/1-6f5e2898ad43`. The chain must equal the knob build's: 0 differences in height, receivers, acc and pools.
2. The driver: `bun scripts/globe-bake-driver.ts --seed 1 --key 6f5e2898ad43 --budget 200 --min-free-gb 15 --max-gb 140` (the default hard stop of 100 GB counts the whole bake root, which holds the live bake's 50 GB too). `--dry-run` was checked.
3. Stages and GPU time (live bake's measured seconds; tiers re-measured): tiers 1 to 3 carry about 60 s, tier 4 1,740 s, tier 5 about 2,200 s (live 2,187 s) so `tiers` is about 4,000 s against 4,588 s; terrain 152; air 10,107; tier-3 flow, pool, surplus, discharge, basin 281; coarse water 499; surplus 136; discharge 133 (CPU); basin 30; water 1,236; ground 775; groundtiles 384 (CPU); pyramid 455 (CPU); maps 6. About 18,200 s: 5.0 h of GPU plus the 10 min of coarse stages, 5.5 h of wall time with lock waits.
4. Disk: the live bake ends at 47.9 GB (final files); the peak while a stage and its inputs coexist is about 52 GB. Needs 52 GB plus the 15 GB floor free besides the restore bake's 50 GB (152 GB free on 2026-10-28 with the restore running). No old bake has to be deleted any more (the /tmp one was wiped).
5. Checks while it runs: after the tiers stage's tier 4 file exists, tier-4 land mean must be 549 m and the share under 1 m about 4% (a blown-up band hold shows as a mean over 1,000 m); about 1 h in, when t5-height.i32 exists: land mean about 549 m and 0 cells over 6 km (the first sign of the digit-sum bug was 2.4 M cells over 6 km); then the gate measures on R1 and home with `scripts/globe-gates.ts region` and the overlap script (scripts/globe-overlap.ts) against the region harness (statistics, not cells: see Job 1). Stop the bake if tier 5 fails.
6. The viewer: `scripts/demo.ts` copies the NEWEST `<seed>-<key>/pyramid` of the bake root, so a finished new bake replaces the restored planet in the site at the next demo build: build the new planet's site deliberately.
7. After: run `scripts/globe-spots.ts` with `--home <lat,lon>` of the page's start place from the ground tiles, and the table above gives the test spots (E2, D, M, R need only the tier-3 files; A needs the climate).

## Open gaps (reported, not tuned)

Land share .237 to .249 against .29; land mean 524 to 552 m against 673 to 840 m; slope 22 to 72% of S(R) (the terrain is too gentle); 10 km relief above 1000 / 1500 m is 1.7 and 1.5 times the cited share at tier 3 (and .095 to .196 above 1000 m in the regions); ridge spacing 3.6 km at home and the R block against our 1.5 to 3 km; the straight coasts of tier 0 (55 runs of 40 km or more, none of 100 km) and the stepped parallelogram coast (start state, above); no relief limit per tier in the cited laws.
