---
title: "Globe renderer fix list (rebuilt 2026-10-28 after /tmp was wiped)"
type: status
date: 2026-10-28
parent: docs/plans/2026-10-20-001-feat-seamless-globe-plan.md
---

# Globe renderer fix list

The auditors' lists lived in /tmp (`/tmp/globe-audit/fixlist.md`, `/tmp/globe-e2e/issues.md`) and were lost with it. This is rebuilt from the plan's Unit 9 entries and the leads' notes. Gates: `scripts/play/audit/README.md`. Per-item detail: the plan's Unit 9 handovers.

## Published (main, newest first)
- Arrival at zoom 3 and 4 over land (0f4ac71): the window's ground is posted held while its objects are made, kernel slices a sixteenth of a kernel, a window's tile runs overlapped; settle A z3 2.05 to 1.38 s, B z3 1.73 to 1.35 s, A z4 2.11 to 1.37 s.
- The lift after a zoom that is set (c5f533e): a set zoom is a new picture and the lift takes the worker's first answer for it (D z1 was 1473 m off the pyr for good after fa2f2b3).
- Camera follows motion, not the clock (fa2f2b3): nothing moves after a drag is let go (release glide 500 to 1580 px at B to 0.0 to 0.6 px).
- Far jump over land: the picture is at the finest tier 40 to 110 ms after the jump in one 0.4 s cross-fade (was a 1.7 s ramp of levels, 4 frames a second, then a slide of the camera's lift), the block of fine pages 0.5 s after (was 1.1), zoom 2 at 0.9 correlation with the final picture in 1.1 s (was 3.5), the window's ladder fades in over 0.5 s after a jump and keeps its objects (branch lead3-arrive2).
- The sea at zoom -1 to 3 has no pixel grain (waves fade by the pixel's longest side on the ground, swell bands with their own directions, 837e168); waves at every zoom from a wind spectrum, glint only from the facet term (10e3775); no lattice, no confetti.
- Window arrivals do not stall the picture (1c4111b); the lattice snaps at once after a far jump and the pick is the ray's own (14f4382).
- Orbit drag: the grab is held under the cursor through a pole and at the limb; roll only where north-up cannot hold the grab (745cd2a).
- Planet pass: no palette-white sea sparkles (7534e5d); the ladder no longer paints its own deep sea (2b17c20).
- Streams drawn as smooth curves through the cell nodes (7a96f20); forest edges are an ecotone in the window's fine field (e59df3f).
- The corner-fix planet (key 1121d207f3b8): tectonics near cube corners by overlap shares (0b94088).
- Camera: drag grab, lattice glide, wheel hold by the sent lift, orbit drag (1353707 and before).
- Cube-corner wedge cells blended, V4's march skip, night law with twilight, stream/dither fades by scale, the crown-share race, fine pages across cube edges, HUD solar time, sliced scatter, continuous tree size with one-level cross-fade (see Unit 9).

## Open
| Item | State | Owner / branch |
|---|---|---|
| Ground crown colour vs sprites; E2 crown apron | the derived version (branch lead3-cd d8f27e0: shade from the sprites' own rho and the Boolean model, no fitted constants) does not meet the gate: A in 3.3 3.4 to 5.6, out 2.9 4.4 to 5.7, B out 3.5 4.6 to 5.9, in 3.9 6.3 to 7.2, far steps under zoom 2 +0.3 to +1.3 (the crown is 4 to 11 luma brighter), A hand-over steps lower (3.9 to 4.8 run 10.8/9.4/7.6/7.7 to 9.9/8.4/5.5/5.8), apron share 12.5% to 13.0% at 45.3 E (absolute pixels halved, crown area halved); parked | branch lead3-cd (d8f27e0), earlier lead3-crownshadow (ea136c3) |
| Far jump over land: colour step at 0.9 to 1.4 s (mean luma 82 at A z3 to 108). Split by lead4-crown: about 10 of it was the planet pass lit by the sky of the frame the camera left (fixed: the sky takes the cells' lattice at the target), about 16 is the ladder's sprites over the planet pass's crowns at rest (95.4 planet pass alone, 111.2 with the sprites at A z3: the parked crown-colour item above, steady state, not a transient). The largest 120 ms step left at A z3 (9 to 11 at 0.41 s) is the planet pass's own 0.4 s level fade from tier 0 (the only tier held at the target) to tier 5, 18 luma by the data | lead4-crown | fixed in part, rest parked |
| Wheel tick at B zoom 1.5: the picture drifts 57 to 130 px from the pick at B (cube edge between faces 0 and 5: the target crosses it in a tick and the exact lattice turns 119 degrees, the camera lattice took it in 100 ms); branch lead4-bz15 (5ee7396) steps the lattice by nothing within a window's reach in a wheel zoom, which defers the turn to window entry at zoom 3 (88 to 185 px) | not published, to be judged by tester 3 | open |
| North pole empty / navy above 75 N | not a bug: open deep ocean, polar night on day 1 (sun 14.6 degrees down at 89.6 N); with day 16 it draws like every sea | none |
| Orbit roll past cos(latitude) of the radius is forced; early roll 10 to 18 degrees from the hop-limited walk | accepted (the operator prefers gentle roll to jumps) | none |
| Straight D8 rivers, evenly spaced ridges, straight coasts, B zoom 6 orange dry beds (bake data) | tier 0 and 1 redesign for natural rivers, then a full rebake | terrain agent, branches globe-t3, globe-t4* |
| Straight A stream, hairline streams | bake data | same |
| Night: moonless is starlight only, the pole is flat at night, 06:15 darker than 02:00 | by the night law (night.js) | none |
| Wheel bursts crossing zoom 0 to -1 | not reproduced after the lift fix | none |
| Sea at zoom -1.5 and out is a gradient | physical at that scale | none |

## Next planet (held for the operator's swap)
T4's generator (branch globe-v13r-v14r-final adb2585, key 6f5e2898ad43, carry limiter, no beds/creep) is baking into ~/.cache/nomads-bakes-next (tier 4 and 5 checks passed: land mean 527 m, 0 cells over 6 km; straight-coast runs of 64+ cells lower in 3 of 4 regions, higher at home). When done: build a test site on its own port, pictures at the new D, R, A, home, the tester's round, then the swap decision. demo.ts links the newest pyramid in its bake root: keep the next bake in a separate root.

## Operations
- Bakes and the coarse store live in `~/.cache/nomads-bakes` (`NOMADS_BAKE`), scratch in `~/.cache/nomads-scratch/<agent>`: a restart wipes /tmp.
- Publish: push to main from a worktree, `git pull --rebase` in the main checkout, `bun scripts/demo.ts styles --out ~/.cache/nomads-play`, then dive, loadsame, lostcheck, the zoom sweeps A, B, C (step 0.3, deterministic) and the item's own gate.
- Test places move with each planet: after a rebake re-check A (forest), B (cube-edge slope), C (coast), D (highest range), E2 (cube edge), K3 (shoreline), M, R (biggest river), the opening view.
