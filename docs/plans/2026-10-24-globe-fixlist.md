---
title: "Globe renderer fix list (rebuilt 2026-10-28 after /tmp was wiped)"
type: status
date: 2026-10-28
parent: docs/plans/2026-10-20-001-feat-seamless-globe-plan.md
---

# Globe renderer fix list

The auditors' lists lived in /tmp (`/tmp/globe-audit/fixlist.md`, `/tmp/globe-e2e/issues.md`) and were lost with it. This is rebuilt from the plan's Unit 9 entries and the leads' notes. Gates: `scripts/play/audit/README.md`. Per-item detail: the plan's Unit 9 handovers.

## Published (main, newest first)
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
| Far jump over land: picture is a coarse tier for 1.4 to 3.3 s, then pops (sea fine) | agent working | branch lead3-arrive2 |
| Wheel tick at B zoom 1.5 / -2 and a cursor on the near side: picture drifts 64 to 96 px, API 0 to 13 | cause not found; the camera's number is right | open |
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
