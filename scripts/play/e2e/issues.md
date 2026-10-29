# Globe e2e tester issues (round 31 (branch lead3-surf vs published 525a55e))

Round 31 (branch lead3-surf on :8472 against the published :8197, 525a55e, alternated). Item 27 is fixed on the branch (glide 0 px; published 500 to 940 px at B). Branch: 4 sessions (seeds 320 to 323, 3 sizes, about 9000 frames each, no stall, no crash, no errors), 12 edge drags (max step 1.4 px), 18 wheel bursts (0 to 0.5 px), 12 arrivals, 24 orbit drags, tree ladder (max gap 17 ms), 40 drag releases. Nothing new found on the branch. Round 30 header: baseline on the published site, items 27 and 28 new; item 28 is planet content (lead 3 checked). Items 21 to 26 are the candidate planet 6f5e only and not re-tested.

## 1. Dragging lurches the picture by up to a whole screen between two frames
- Severity: visibly broken
- Seen: Round 17: not seen. Round 30 (525a55e): 12 edge drags at zoom -2, 1.5, 3: biggest step 1.4 px, final error 0 to 1.4 px; about 55 slow held drags (5 px per 25 ms, 1280x800, 1920x1080) at B, A, R, home, M, E2, D: the grabbed place stays under the mouse, biggest frame step 4 to 6 px. The one big jump in 4 sessions (camera-snap, seed 311, 1920x1080, B zoom -0.92) is the release glide of item 27, not a lurch.
- Status: fixed on 6581570 for orbit as well: slow drags at zoom -5 to -5.7 from the pole (89.96 N 4.5 E), 42 N 19.9 W, 65 N, 83 S, the equator and 75 N at 1280x800 and 800x1000: the grabbed place stays under the mouse (0 to 0.3 px) in 40 of 48 drags, and 6 to 20 px off only in slow east drags at the pole and 65 N when the mouse nears the planet's edge; largest step 11 px; no 150 to 466 px jumps in 48 drags or in the 4 sessions (seeds 84 to 87). Fast drags that leave the planet disc leave the grab behind, as expected
- Matches fixlist: new (near fixlist 3.1 and 4.5, but not the same: zoom -2.5 to 2.4, no window change)
- Repro: seed 9, 1280x800, 76.0 s: left drag west at y 405 at zoom -2.5, bearing 0, near 0N 65E; lat -0.94 to 11.08 in two frames. seed 2, 1280x800, 93.8 s: zoom 0.49, bearing 1.0, lon 40.54 to 37.12 in one frame (HUD shows both). seed 7, 1920x1080, 113 to 126 s: jitter drags at zoom -0.1, ground 100 to 693 px per 100 ms for 3 to 8 px of mouse. Round 6: seed 42, 800x1000, frames k663 (pivot moved 251 px in one frame) and k793 (ground moved 94 px in 100 ms for 2 px of mouse), zoom -5.7, lat 86 to 89.7, after escapePole. ROUND 7, where each one starts. (1) Window switch: seed 47, 1280x800, 58.78 s, zoom 2.76, 15.77 N 7.44 W, midWalk drag: the pivot's screen place goes from y 1004 to y 29 in one frame (975 px) for 9 px of mouse, exactly when the window id changes 0:3328:5376 to 0:3264:5440 (both 64 cell steps); the picture there is open sea so the jump is not visible, the API pivot jumps. (2) Face switch: seed 46, 800x1000, 93.6 s, zoom 2.0 to 2.46, 25.15 N 29.98 E: pivot moved 363 px in one frame when the window id goes 0:6720:6528 to 1:1152:5824 (window of face 0 to a window of face 1; the face edge is at 45 E, the window of face 1 is made 15 degrees before it). (3) Cube corner at zoom 3: dragedge.ts CO (35.26 N 45 E), window mode, mouse step 34 of 40, mouse at 760,520, view 35.387 N 44.861 E (0.15 degrees from the corner): the grabbed ground jumps 432.6 px in one frame and stays 432.6 px off the mouse for the rest of the drag. (4) Cube corner at zoom -2, 0, 1.5: CS (35.26 S 135 E), mouse steps 1 to 20 are 1:1 or off by up to 19 px a step, from mouse step 21 (the first step after the reversal, view crossing 35.2 S 135.0 E) the ground stays 18 px off every step, then one frame of 321 px at zoom -2 (step 26, view 39.02 S 125.07 E), 210 px at zoom 0 (step 30, view 35.79 S 133.70 E), 217 px at zoom 1.5 (step 30); the mouse ends 196 to 265 px from the grabbed ground after going out and back. CO at zoom -2 to 1.5: off by 8 to 15 px for 8 to 16 steps from step 3 and 145 to 215 px at the end. (5) Pole edge at zoom -2, 0, 1.5: PE (45 N 0 E, the edge of the north pole face): from step 21, when the view crosses 45.0 N going north, the ground does not move for 11 mouse steps (about 22 px a step too little), then follows again; the mouse ends 169 to 209 px off. (6) Poles at orbit and mid zoom: seed 45, 1920x1080, 114.5 s zoom -5.26 at 83 S: ground moved 376 px in 100 ms for 40 px of mouse; 114.9 s at 89.7 S 236 px for 30 px; 119.2 s zoom -2.55 at 88.6 S 176 px for 21 px; seed 44 12.3 s 379 px at 78 N and seed 47 33.9 s 386 px at 54 N zoom -5.68. Clean: the lon 45 edge (EQ 13.27 N 45 E): max step error 6.1, 4.4, 3.0 px at zoom -2, 0, 1.5, and 0 px at zoom 3 and 4.5 (window mode), and at the PE, CS corners at zoom 3 and 4.5 (0 px). The pivot in dragedge is the pick at the cursor on mouse down; geo is not given by groundUnder in window mode (zoom 3 and up), the window x,z is. Round 15: seed 78, 800x1000, frames k162, k225, k277, k321, k344 (14 to 30 s), zoom -5.7, goPlace steps starting near the pole.
- Expected: 
- Evidence: evid/limb-jump-strip-s9.jpg, evid/drag-lurch-s2.jpg, evid/lurch-s32.jpg, evid/drag-lurch-pole-s42.jpg, evid/lurch-window-switch-s47.jpg, evid/lurch-face-switch-s46.jpg, evid/pole-spin-s45.jpg, evid/orbit-pole-jump-s78.jpg, evid/orbit-jump-s77.jpg, evid/orbit-roll-n42-r17.jpg

## 2. The ground under the cursor does not stay under it while wheeling below zoom 2
- Severity: visibly broken
- Seen: every single tick measured at zoom -2 to 1.9 (15 of 15), at all five test places. At zoom 3.2 and above it was exact (0 px) in 27 of 30 ticks, 3 were flat ground where the tracker could not tell. Round 7, wheel bursts with the cursor held: ground under the cursor drifted 107 px (seed 44, zoom 2.15 to -0.33), 99 px (seed 47, 5.47 to -0.99), 77 px (seed 45, 2.12 to 6.55), 61 px (seed 44, 3.43 to 1.79). The API check read 616 px (seed 44, zoom 4.0) and 195 px (seed 46, zoom -5.7). Round 8: wheel bursts drifted less: 53, 48, 44, 33, 30 px (round 7: up to 107). Round 9: bursts 99 px (seed 55, zoom -0.7 to 3.25), 36, 34, 30 px. Round 10 bursts: 101 px (seed 59, zoom 8.49 to -0.8), 82 px (seed 59, 0.22 to 2.72), 78 px (seed 59, 4.91 to 5.27, at 12.4 N 83.8 E in forest, so the tracker may be wrong), 50 px (seed 57), 37 px, 25 px. API check outliers: 44.8 px (seed 57), 35.7 px (seed 59). Round 11 bursts: 327 px (seed 60, 55.3 s, zoom -0.57 to 3.88, a new worst), 48 px (seed 61), 38 px, 31 px, 29 px, 28 px. Round 13 bursts: 99, 97, 96, 78, 57, 56 px (seeds 68 to 70), 47, 30 px (seed 71). Single ticks A exact 0 to 1 px, B zoom -2 32 px, B zoom 0 2 px. Round 14 bursts: 98, 60, 36 px (seeds 73, 75); single ticks exact at A, B zoom -2 32 px. Round 15 bursts: 140 px (seed 76, 78.5 s, zoom 2.68 to 2.3, a burst of only 0.4 zoom), 111 px (seed 77), 73 px, 49 px; B zoom -2 single tick 30 px. Round 16 bursts: 87, 85, 51, 48, 43 px; B zoom -2 single tick 32 px. Round 17: burst test 0 to 4.3 px; sessions 49 px at most. Round 18 (same site files, 4 more sessions seeds 88 to 91): image-tracked bursts that cross zoom 0 to -1 drift 77 px (seed 88, 27.2 s, zoom 4.67 to -0.15) and 41 px (seed 91, 0.54 to -0.3); the burst test inside zoom -0.6 to 5 stays under 4.3 px, so the remaining drift is in bursts that run through the zoom -1 to 0 hand-over (the tracker may be misled there). Round 20: image drift worst 46 px (seed 96, burst across zoom -0.93 to -0.22); A and B single ticks as before (A 0 to 1 px, B zoom -2 35 px by image, 0.5 by API). Round 22 bursts: 315 px (seed 104, 88.1 s, zoom -0.92 to 1.01), 73 px, 46 px, 44 px. Round 23: burst test 0 to 1.8 px; sessions worst 63 px. Round 24: A and B single ticks as before (A 0 to 1 px, B zoom -2 64 px by image, 0.5 by API); sessions' worst bursts 148 px (seed 114, zoom 0.46 to 7.6), 51 px, 45 px. Round 25: sessions' wheel bursts worst 127 px (seed 117, 50 s, zoom -0.68 to 0.0), 82 px (seed 119), 61, 51, 41 px. Round 26: controlled bursts 0 to 0.6 px (18 bursts through zoom 0 to -1 at B, A, R, home, M, E2). Random-session bursts below zoom 2.9 (API pick): worst 52 px (seed 202 at orbit zoom -5.2 to -5.7), 44 px (seed 203, zoom -1.1 to 0.1), 31 px (seeds 204, 205). Above zoom 3 my API check is invalid after a window swap (window x,z move), so those numbers are not used. Round 30: 18 controlled bursts at 8 places: drift 0 to 0.6 px, one 1.9 px (E2 up, 120 ms ticks). The 6 anchor-drift hits in 6 sessions are 45, 65, 106, 117, 150 and 170 px: five of them end at zoom -5.2 to -5.7 (orbit, the limb case); the 117 px one (seed 314, 1280x800, 8.42 N 40.49 W, burst from zoom -2.93 to 1.87) goes IN from orbit, not into the limb: not explained yet. Round 31 (branch :8472, 4 sessions, seeds 320 to 323): bursts 0 to 0.5 px (same as published); anchor-drift hits from low orbit going in: 140 px (seed 322, 800x1000, zoom -1.01 to 2.59), 38 px (seed 323, zoom -2.05 to 0.75), the limb cases 93, 104, 111 px (end at zoom -5.2 to -5.7); not different from the published sessions.
- Status: fixed for wheel bursts at a held cursor from a settled camera (controlled bursts 0 to 0.6 px, rounds 17 to 27). The 27 to 52 px drifts of random sessions are explained: (1) orbit, cursor near the limb: the planet shrinks under the cursor and the grabbed point ends 53 px left of it with the cursor off the planet (zoom -5.18 to -5.7, 936,410; reproduces at every tick gap: not a bug); (2) the burst starts within 0.5 s of an arrival or of a fast drag release: the camera is still gliding or settling, the pick is taken in the moving view, and the point drifts with it (8 px at 100 ms after a jump, 5 to 6 px; after a fast drag release at once 5 to 53 px, 1.5 px after 150 ms, 0.1 after 1.2 s; the B case: pick already 66 px from the cursor at the release, drift 93 px at tick 1 and 38 px at the end, evid/burst-glide-*.jpg)
- Matches fixlist: new (related to 4.5, relief picks)
- Repro: anchortest.ts: places A, B, M, R, E2, zoom start -2, 0, 1.5, one wheel tick of -100 at cursor 640,400 / 900,300 / 330,600; results in /tmp/globe-e2e/anchor/results-*.json (A z0 -> 88 px, B z0 -> 96 px, B z1.5 -> 95 px) Round 7: seed 44 at 8.7 s, seed 47 at 27.8 s, seed 45 at 48.5 s (a burst of several wheel ticks at a held cursor). Round 11: seed 60, 1280x800, 55.3 s, burst from zoom -0.57 to 3.88 at a held cursor.
- Expected: 
- Evidence: evid/anchor-snap-s7.jpg, evid/burst-glide-before-r27.jpg, evid/burst-glide-tick6-r27.jpg

## 3. The north pole and everything above about 75 N is empty at every zoom
- Severity: visibly broken
- Seen: every session that dragged toward the pole, about half of them (seeds 1, 3, 4, 5, 7, 10 and more). At 13:00. Round 24: not retested.
- Status: open, unchanged in round 11 (89.6 N 10 E zoom 4: flat navy at 02:00, 06:15, 08:00)
- Matches fixlist: fixlist 4.1 (north pole dark), worse: the picture is blank, not dark
- Repro: look.ts 89.6,10 at zoom 8;4;0, and 60..85,10 at zoom 3. seed 10, 1280x800, 39 to 46 s: from lat 40 to 89.99 by drags and wheel out.
- Expected: 
- Evidence: evid/look-pole.jpg, evid/look-lat.jpg, evid/look3.jpg, evid/night-pole-0200.jpg, evid/pole-r10.jpg

## 4. A straight seam where the ground detail changes
- Severity: visibly broken
- Seen: Confirmed by eye twice: seed 8 (round 5) and seed 44, 1280x800, 85.0 to 86.3 s, zoom 2.78, near 10.8 N 59.9 E (a straight vertical line at 582 of 640 px for 14 frames; the strip to the right of it has other orange line directions). The detector fired 12, 1, 2, 0 times in the four round 7 sessions (round 6: 40, 11, 7), mostly unjudged. Round 12 (0e9b52a): a perfectly straight horizontal line across the whole screen where the detail changes, seed 67, 1280x800, 78 to 96 s, 1.9 S 64.9 E, zoom 0.58 to 0.82 (frames k927 to k1137, still there at 96 s as a vertical line at 436 of 640), confirmed by eye: forest with light patches above, smooth green below. Another at 5.7 S 66.5 E zoom 0.6 (126 to 129 s). Round 13: 23, 8, 82 (seed 70 800x1000), 3 hits; the hits I looked at (49.5 N 35.3 E zoom 2.09, 48.4 N 34.7 E zoom 1.92) are natural soil and forest bands, not straight seams; at the previous seam places 1.9 S 64.9 E zoom 0.7 and 5.7 S 66.5 E zoom 0.6 the new planet shows no straight line (stills evid/np-seam-places.jpg). Round 16: 6, 66, 0, 27 hits, none seen by eye (seed 81 zoom 0.44 coast). Round 30: the straight line where the ridge pattern changes is on the river at R 12.02 N 83.89 E zoom -1 (see item 16): ridges run diagonally above the river and vertically below it, with the river as a ruled line between them (evid/R-river-z-1-r30.jpg).
- Status: not seen on the new planet at the old repro places (1.9 S 64.9 E, 5.7 S 66.5 E zoom 0.6 to 0.82); the seam-detector hits in 4 sessions were natural bands. Not counted as fixed (the data changed, the cause may remain)
- Matches fixlist: new (R6, one level of detail across the screen)
- Repro: seed 8, 800x1000, step at about 41 s: drag at zoom 0.16, bearing 0, near 2.9 S 66.7 E, frames k413 to k416 Round 7: seed 44, 1280x800, frames k1003 to k1007 (85 s), zoom 2.78. Round 12: seed 67, 1280x800, frames k1067 to k1071 (about 90 s), zoom 0.82, near 1.9 S 64.9 E.
- Expected: 
- Evidence: evid/seam-s8.jpg, evid/seam-s44.jpg, evid/seam-h-s67.jpg

## 5. Sea is a flat, very dark colour at close zoom and its dot lattice stays fixed to the screen
- Severity: polish
- Seen: sea filled the whole screen for 1017 of 1693 frames in seed 15 and 516 of 1524 in seed 17; the lattice was flagged in seed 17 (50 of 50 blocks do not follow the ground). Round 6: concentric moire rings across open sea at zoom 0 and -2 (25 N 15 E, also -15 S -60 W at zoom 0); one whole-screen blank navy run of 17 s in seed 41 (Bay of Biscay at 44 N 2.9 W, 13:00, zoom 3.8 to 7.6, 146 flagged frames). Round 7: flat navy sea filled 1366 of 1798 frames in seed 47 (115 s at 15.6 N 7.4 W, zoom 2.2 to 8.5, a person cannot tell where they are or whether anything moves) and 404 of 2160 in seed 45. Round 8: flat navy sea frames 77 of 1860 (seed 49) and 185 of 1808 (seed 51), far fewer than round 7. Round 9: 304 flat frames (seed 52); seed 53 sat on the night side of the planet (38 N 158 W at 13:00 UTC): 1648 of 2048 frames were flat navy sea, luma 17, std 0.3, at zoom 7.6 and above (evid/night-sea-s53.jpg). Round 10: flat navy frames 217 of 2027 (seed 59), night dark 582 (seed 57) and 334 (seed 59). Sea at 25 N 15 E zoom 0 and -2 has no moire (evid/sea-r10.jpg). Round 12: stuck-texture 50 of 50 blocks at -0.64 S 4.64 W zoom 9.09 (sea, seed 66, 75.5 s): the sea's dot texture does not follow the ground. Round 21: see status. Round 22: pan test again follows the ground (correlation 0.94 at zoom 8.27 and 0.95 at zoom 5, 0.0 screen-fixed). Daylight sea at zoom 3 at 15.02 N 71.76 W is a fine regular facet grain (evid/sea-low-r22.jpg), 25 N 15 E zoom 0 and 2 (sun 17:55) smooth blue gradient, no waves. Round 24: also the new sea at zoom -1 and 0 (25 N 15 E) is a fine horizontal streak texture, like brushed metal, 1 to 2 px tall, not like waves (evid/waves-25N15E-low-r24.jpg first and second stills); at zoom 1 it is fine diagonal ripples; zoom 2 and 3 large soft crests.
- Status: improved: on 837e168 the brushed metal and fine ripples are gone. 25 N 15 E (sun 10:20): zoom -1 near smooth with faint diagonal streaks, zoom 0 and 1 a soft fine diagonal grain, zoom 2 and 3 soft elongated pale crests (cloud-like) on dark blue; 15.02 N 71.76 W (sun 12:08): zoom 1 to 3 crests lined up roughly horizontally and in bands, zoom 5 and 8.27 large soft crests; 0.64 S 4.64 W zoom 9 a dark finely rippled surface. The direction differs between the two places (diagonal at 25 N 15 E, horizontal at 15 N 71 W) but is one direction within a frame, and crests are similar in size within a frame, so it is a little uniform. Pan tests: the pattern follows the ground (corr 0.74 at zoom 0, 0.92 at zoom 2 at 25 N 15 E; 0.98 at zoom 3 and 0.61 at zoom 0 at 15 N 71 W at the drag shift, 0.0 screen-fixed)
- Matches fixlist: lattice: fixlist 2.1 (known). Flat and dark colour: new
- Repro: look.ts 15.02,-71.76 zoom 8.27;3;0. seed 17, 1280x800, 21 to 53 s, zoom 3 to 6.7; frame k327 Round 6: look.ts 25,15 zoom 0;-2, seed 41, 1920x1080, 52 to 69 s, zoom 6.06.
- Expected: 
- Evidence: evid/look-sea.jpg, evid/sea-flat-s17.jpg, evid/sea-lattice-s17.jpg, evid/sea-lattice-s24.jpg, evid/sea-moire-rings.jpg, evid/night-sea-s53.jpg, evid/sea-r10.jpg, evid/sea-noon-r21.jpg, evid/sea-z9-r21.jpg, evid/sea-flat-day-s103-r21.jpg, evid/sea-low-r22.jpg, evid/waves-25N15E-r24.jpg, evid/waves-15N71W-r24.jpg, evid/waves-25N15E-low-r24.jpg, evid/sea-25N15E-z-1-0-1-r27.jpg, evid/sea-25N15E-z2-3-r27.jpg, evid/sea-15N71W-z1-3-r27.jpg, evid/sea-15N71W-z5-9-r27.jpg

## 6. Orange parallel lines (dry beds) lie over slopes, forest and sand, up to the whole screen
- Severity: noticeable
- Seen: Round 6: whole screen covered, seed 40, 1280x800, about 55 s at 47.86 N 37.77 E, zoom 3.2 to 3.5 (vertical lines over the whole picture, a diagonal band, lines also over the sand). Earlier: seed 2 and a direct look at 47.49 N 38.13 E showed it on a river strip. Round 7 (build 6749586): still on most land at zoom 2.7 to 5, seed 44 frames k1005 and k1273, 1280x800. Round 14: parallel orange diagonal lines about 150 px apart across the whole screen at B zoom 6 (dry beds of the washboard). Round 16: B zoom 6 lines remain (the lead says new bake data). Round 26: B zoom 6 diagonal orange lines still there on the restored planet (evid/restored-B-r26.jpg fourth still). Round 30: B 35.9 S 43.59 E zoom 6: the parallel orange diagonal lines, evenly spaced about 150 px, still cross the whole screen (evid/B-z6-z3-r30.jpg). Zoom 3 at B has none.
- Status: mostly improved, but a regression at zoom 6: parallel orange lines, evenly spaced, run diagonally across the whole screen at B 35.9 S 43.59 E zoom 6 (e59df3f, evid/B-z6-orange-r14.jpg). They were not there at zoom 3 to 5 at B
- Matches fixlist: new (plan note 'orange lines on slopes', measured but not fixed)
- Repro: look.ts 47.49,38.13 zoom 4;5.7;7 at hour 13. seed 2 frames k176 to k178 (about 20 s) Round 6: seed 40, 1280x800, frames k523 to k525 (about 55 s), zoom 3.25 to 3.5, near 47.86 N 37.77 E, just before the forest fills the screen.
- Expected: 
- Evidence: evid/look-plain.jpg, evid/grey-plain-s2.jpg, evid/orange-lines-s40.jpg, evid/orange-r10.jpg, evid/streams-r11.jpg, evid/B-z6-orange-r14.jpg, evid/restored-B-r26.jpg

## 7. Narrow windows: the WebGPU badge covers the hour slider
- Severity: polish
- Seen: every 800x1000 session (4 of 4)
- Status: fixed on bba983e (proof: still at 800x1000, the HUD bar now sits under the badge)
- Matches fixlist: new (HUD, near 4.6)
- Repro: any run at 800x1000 or resize to 800 wide; seed 4 frame k13
- Expected: 
- Evidence: evid/hud-overlap.jpg, evid/hud-overlap-3.jpg

## 8. Night side is pitch black and the planet disappears into space
- Severity: noticeable
- Seen: every session that set the hour to 20:00 to 04:00 (about a third) Round 9: night sea close up is one flat navy (seed 53, zoom 7.6, luma 17 std 0.3), no moonlit swell or lattice. Round 13: seed 71 sat at 6.4 S 66.6 W at 13:00 UTC (HUD sun time about 09:00): 1484 of 2018 frames flat luma 13.5 to 13.8 sea at zoom 6.7 to 9.3. At 02:00 the home island zoom 5.3 is readable (trunks and crowns visible), the pole 89.6 N zoom 4 is flat navy luma about 20. Round 30: 5 of 6 sessions flag 61 to 171 night-dark frames each (luma 12 to 20, zoom 1 to 7); in seed 314 at 8.42 N 40.49 W zoom 1.87 the hour slider sweeps the same place from orange sunset (sun 17:39) to near-black at sun 20:35, 05:36 (evid/hours-8N40W-r30.jpg): the night picture is a flat navy with only the forest as a faint dark patch.
- Status: open, changed on 6de93f9 and 96c5cf1 (night floors removed, twilight from 07:30). Home island 47.78 N 38.63 E zoom 5.3 mean luma: 02:00 19.7, 06:15 12.8, 07:30 19.3, 08:00 28.1. 06:15 is the darkest (the lead says that is the law: moon set, sun 12 degrees below until 07:30); the pole is 21.6 at 02:00 and 17.8 at 06:15 and flat
- Matches fixlist: fixlist 4.1 (known)
- Repro: set the hour to 02:00 and zoom out; seed 3 frame k260 Round 8: look.ts 47.78,38.63 zoom 5.3 at hour 2, 4, 5, 6.25, 7, 8: mean luma 21.0, 16.2, 15.1, 15.1, 15.1, 23.9. Seed 49, hour set at 85 s.
- Expected: 
- Evidence: evid/night-orbit-s3.jpg, evid/night-new.jpg, evid/night-home-0615-0200.jpg, evid/night-A-0200.jpg, evid/dawn-r10.jpg

## 9. Terrain washboard and stepped coasts
- Severity: noticeable
- Seen: in most sessions at zoom -3 to 2 Round 8: horizontal orange and grey bands at -51.3 S -31.4 W, zoom 1.5 to 2 (seed 51, 86 to 126 s). Round 11: E2 13.27 N 45 E, zoom 4 to 6: no seam at the cube edge now, but the ground there is flat brown bare soil, and at zoom 6 the whole screen is one brown plane with faint stripes (evid/e2-r12.jpg). B and A look right: the blue patch at B zoom 3 to 3.5 is now a pond, and the fingerprint lines at A zoom 2 to 2.5 are gone.
- Status: open, unchanged in round 5
- Matches fixlist: fixlist 6.2 and 6.3 (known)
- Repro: seed 2 frame k507 (zoom -2.7), seed 16 frame k731 (zoom 0.2)
- Expected: 
- Evidence: evid/washboard-coast-s2.jpg, evid/hatching-s16.jpg, evid/bands-s51.jpg, evid/e2-r12.jpg

## 10. favicon.ico gives a 404
- Severity: polish
- Seen: every load
- Status: fixed (favicon answers 204, no http error in sessions s32 and s34)
- Matches fixlist: new
- Repro: load /play/
- Expected: 
- Evidence: evid/hud-overlap.jpg

## 11. Thin dotted straight lines across the ground at zoom 1.8 to 2.6
- Severity: polish
- Seen: once, seed 22 at 57.1 N 40.3 E, 800x1000, 22 to 30 s on 0caf7ae Round 10: rows of vertical dotted lines on the beach at 0 N 30 W zoom 3 (look.ts hour 13).
- Status: open, unchanged in round 5
- Matches fixlist: new
- Repro: seed 22, 800x1000, about 29.5 s, wheel in through zoom 1.9 to 2.6; frames k299 to k303
- Expected: 
- Evidence: evid/dotted-lines-s22.jpg

## 12. A cube corner at 35.26 S 135 W: the coast is a straight diagonal cut with a lit cliff edge, zoom 3 and 4.5
- Severity: visibly broken
- Seen: Still at 35.26 S 135 W at zoom 3 and 4.5 on 6749586 (look.ts, hour 13). At zoom 6.5 the same coast is natural. The other seven corners show no wedge or cut at zoom 3 and 4.5. Round 26 (restored planet): 35.26 S 135 W is still deep sea at zoom 3 and 4.5 (evid/restored-C-r26.jpg).
- Status: fixed by the new planet: 35.26 S 135 W is now deep sea at zoom 3 and 4.5, no cut; all 8 cube corners at zoom 3, 4.5, 6.5 show no wedge, no straight cut, no streaks (evid/np-S135W-deepsea.jpg, evid/np-corner-35N45E.jpg)
- Matches fixlist: V3's corner finding (island ending in a straight diagonal cut), not fixed at this corner
- Repro: look.ts '-35.26,-135,3;4.5;6.5' at hour 13, 1280x800
- Expected: 
- Evidence: evid/corner-cut-S135W-z3.jpg, evid/corner-r10.jpg, evid/np-S135W-deepsea.jpg, evid/np-corner-35N45E.jpg, evid/restored-C-r26.jpg

## 13. Frame stalls of 120 to 216 ms on the home island at zoom 1.3 to 4.4
- Severity: polish
- Seen: Round 20: not seen. Round 28: sessions 210 to 213: frame gaps 83 ms (seed 211 at 99.3 s, 12.11 N 83.91 E zoom 4.81) and 50 ms (seed 213 at 37.6 s, B zoom -1.45), the rest 33 ms: one mild stall. Round 30: 6 sessions (about 9000 frames each): no frame gap over 100 ms; tree ladder at A 4.6 to 3.5: max gap 17 ms.
- Status: fixed on 1c4111b: arrival test at 10 far places and 2 zooms, 20 arrivals: 0 frame gaps over 60 ms; 4 sessions: no stall hit (before: 120 to 216 ms in rounds 9 and 15)
- Matches fixlist: new (near fixlist perf items)
- Repro: seed 55, 1280x800, frames k595 to k606 (51.3 to 52.9 s) midWalk at zoom 4.4 to 2.9; seed 50 k305 to k325
- Expected: 
- Evidence: evid/stall-s55.jpg

## 14. Streams smaller than a pixel are drawn as hairlines: a 1 px blue and white line with straight horizontal and vertical runs
- Severity: noticeable
- Seen: Seed 60, 1280x800, about 80 s, 11.32 S 57.46 E, zoom 4.7 to 5.6 (frames k925 to k929); the HUD there shows 'sun 13:12'. The line crosses bare soil and trees, with right-angled runs. Round 13: at 12.23 N 83.85 E zoom 3.9 the stream is a staircase of right-angled steps (about 10 px per step, evid/np-misc.jpg first still); at R 12.02 N 83.89 E zoom 2.5 the thin streams are a grey hairline. 1.9 S 64.9 E zoom 0.7: a thin blue stream drawn as one straight vertical line with a kink. Round 14 (e59df3f): streams at R 12.23 N 83.85 E zoom 3 to 6 are one staircase of right-angled steps about 10 px a step, seen as thin grey at zoom 3, steps at zoom 4 and 5, a thick blue river with orange banks at zoom 6 (evid/stream-stairs-r14.jpg). At A 4.35 N 39.38 W zoom 3 and 4 a stream is a single dead-straight vertical line, screen tall, with one small jog (evid/A-z4-r14.jpg). Round 26: A zoom 3 and 4 still has the screen-tall straight vertical stream.
- Status: improved on 7a96f20: the staircase is gone, streams at R 12.23 N 83.85 E zoom 3, 4, 5, 6 and R 12.02 N 83.89 E zoom 2.5 to 3 are smooth curves (evid/streams-smooth-r16.jpg); a dead-straight screen-tall vertical stream remains at A 4.35 N 39.38 W zoom 3 and 4 and a straight vertical hairline at 1.9 S 64.9 E zoom 0.7 (the lead says new bake data)
- Matches fixlist: new (V6's bankfull streams)
- Repro: seed 60, 1280x800, frames k925 to k929 (80 s), zoom 4.7 to 5.6 near 11.32 S 57.46 E
- Expected: 
- Evidence: evid/hairline-stream-s60.jpg, evid/np-misc.jpg, evid/stream-stairs-r14.jpg, evid/A-z4-r14.jpg, evid/streams-smooth-r16.jpg, evid/restored-A-r26.jpg

## 15. Small luma dips and steps at the level boundaries when zooming through a forest (zoom 7.5, 6.6, 5.6, 4.6, 3.6)
- Severity: polish
- Seen: Wheel ladder in 0.1 steps at the home island forest 47.78 N 38.63 E (tree2): mean luma dips about 3 (7 percent) at zoom 7.5 (40.6 against 43.5), 6.7 to 6.6, 5.7 to 5.6 and 4.6 (59.0 against 62), and steps up 4.4 from zoom 5.6 to 5.5 and 4.9 from 3.6 to 3.5. At the forest 12.23 N 83.85 E (tree1) the curve is smooth within 2.5. Trees shrink smoothly and no ghost trees were seen in stills at 5.8, 5.5, 5.2, 4.9, 4.6, 4.3. No frame gap above 34 ms. Round 14: A ladder is monotone from 4.5 (151.7) to 3.4 (123.6) in steps of 0.5 to 4.9 (largest 4.9 between 3.8 and 3.7, 3.4 between 4.8 and 4.7). Round 24: A ladder zoom 4.6 to 3.5 in 0.1 steps: luma 151 to 127, monotone, no step above 3.3, longest frame gap 33 ms (zoom 3.9 and 4.2 are 138.5 and 147.5).
- Status: improved on e59df3f: hand-over ladders zoom 4.8 to 3.4 (0.1 steps) at A (luma 157 to 124), home (89 to 95) and B (69 to 80): no step above 3.4 luma, no frame gap above 33 ms; at the home island a 3 luma dip at 4.6; the sweeps' 5 marginal steps at A are under my 3.5 step threshold
- Matches fixlist: lead's tree commits (luma dip at the fade) partly fixed
- Repro: treetest.ts tree2 47.78 38.63 8.5 3 (one wheel tick of 25 per step, 112 steps), results /tmp/globe-e2e/tree2/res.json
- Expected: 
- Evidence: evid/tree-4.9-4.6-4.3.jpg

## 16. Rivers are straight lines (and evenly spaced stripes carry the streams)
- Severity: visibly broken
- Seen: Operator observation, recorded at: R 12.02 N 83.89 E, zoom -1 and 1, the river is one dead straight east-west line across the whole screen (2 km wide at zoom -1), with its lakes strung on the same line; at zoom 2.5 the same river is a few long straight runs joined at sharp 45 degree angles (banks orange, water blue). Evenly spaced parallel ridges, each with a forest strip, at A 4.35 N 39.38 W zoom -1 to 1, home island 47.78 N 38.63 E zoom -1 and E2 13.27 N 45 E zoom -1. On builds up to 94342c5 the streams were evenly spaced parallel orange lines (seed 44 frame k1273, zoom 5.07). Hairline streams with right-angled runs at 11.32 S 57.46 E zoom 4.7 to 5.6 (issue 14). Round 13: R 12.02 N 83.89 E on the new planet: still one straight east-west river at zoom -1 and 1, and at zoom 2.5 thin streams are curved (a change). Home island, A, E2 at zoom -1 are still evenly spaced ridges. Round 14: the stream at A zoom 3 and 4 is one straight vertical line the whole screen high; the R streams are staircases (issue 14). Round 16: river drags at R 12.23 N 83.85 E zoom 4 (east and south), R 12.02 N 83.89 E zoom 3 (west) and A zoom 4 (diagonal), 60 steps each over window swaps: every step 1:1 (pick jump 0 px), the stills along the drags show no seam and no popping stream. Round 26: R 8.32 N 88.30 E zoom -1 and 1 and 12.02 N 83.89 E zoom -1: the river is still dead straight with lakes on the line; at zoom 3 it is a smooth wide river with orange banks. Round 30: R 12.02 N 83.89 E zoom -1 still one dead-straight east-west river with its lakes strung on the line; the ridge pattern changes direction across it (evid/R-river-z-1-r30.jpg). R2 8.32 N 88.30 E zoom 3 is a wide smooth river (fine).
- Status: open, partly improved on 7a96f20: streams at zoom 2.5 to 6 are smooth curves now. The R river at zoom -1 and 1 is still one dead-straight east-west line (evid/R-straight-r16.jpg) and at zoom 1 a slight wobble only; the ridges at zoom -1 are still evenly spaced
- Matches fixlist: fixlist washboard (the furrows each carry a stream), new for the river line
- Repro: look.ts 12.02,83.89 zoom -1;1;2.5 at hour 13 (1280x800)
- Expected: 
- Evidence: evid/straight-river-R.jpg, evid/even-ridges-A.jpg, evid/np-R-river.jpg, evid/R-straight-r16.jpg, evid/restored-R-r26.jpg, evid/restored-R2-r26.jpg

## 17. Forest edges are straight lines instead of fading out
- Severity: visibly broken
- Seen: Operator observation, recorded at: seed 67 at 5.7 S 66.5 E, zoom 0.6 (126 to 129 s): the brown soil shapes are cut flat along one horizontal line near the top; 1.9 S 64.9 E zoom 0.58 to 0.82 (78 to 96 s): one straight horizontal line cuts the forest across the screen (issue 4); B -35.9 S 43.59 E zoom 1 to 2.5: the forest edge along the shore is one long straight diagonal; 35.26 S 135 W zoom 3 and 4.5: the whole coast and forest end in one straight diagonal (issue 12). Round 14: A and home improved (see status); seams 1 to 40 detector hits in 4 sessions and none seen by eye (seed 73 zoom 1.0 and 4.07). Round 30: A 4.35 N 39.38 W zoom 6: the dense tree patch ends in one nearly vertical straight line against bare ground on the right (evid/A-z3-z6-r30.jpg second still); at zoom 3 the stream there is a straight vertical line (item 14).
- Status: improved on e59df3f: forest edges at A (4.35 N 39.38 W) and the home island (47.78 N 38.63 E) at zoom 3 to 6 now wander with outlying clumps and a thin fringe, no straight line (evid/edge-A-r14.jpg, edge-H-r14.jpg); still straight: coast and shore edges at B 35.9 S 43.59 E zoom 3 to 5 (one smooth curve with a dark rim, hydrology) and the stream banks at R
- Matches fixlist: overlaps issue 4 and 12 (tile and corner edges), plus the shape of the forest cover
- Repro: seed 67, 1280x800, frames k1521 to k1523 (128 s), zoom 0.6; look.ts -35.9,43.59 zoom 1;2.5
- Expected: 
- Evidence: evid/forest-edge-flat-s67.jpg, evid/edge-coast-B.jpg, evid/edge-A-r14.jpg, evid/edge-H-r14.jpg

## 18. After an orbit drag the planet rolls and glides back (check)
- Severity: polish
- Seen: Round 23: see status. Not visually confirmed at 42 N (the pair of stills is hard to read, the night side). Round 26: orbit roll numbers identical to round 23 (east drags at 0.5 R: 13, 36, 55, 89 deg at 20, 42, 58 N and the pole; south drags 0 at 20 and 42 N). Round 30 (orbitroll, 24 drags): identical to round 23 and 26: east drags roll 13, 36, 55, 89 deg at 20, 42, 58 N and the pole (press at 0.5 of the radius); south 0, 0.6, 32, 180; north 0 to 5. Nothing glides back (still-move 0.0 to 0.08 px). Round 31 (branch :8472): orbit roll identical to published (east 13, 36, 55, 89 deg; south 0, 0.6, 32, 180).
- Status: open: roll is not zero on 745cd2a by my measure (the screen angle of the south direction at the view centre, before against after a 30 step, 150 px drag): east drags 13 deg at 20 N, 36 at 42 N, 55 at 58 N, 68 at 75 N, 90 at the pole with the press at 0.5 of the radius; at 0.9 of the radius 8, 19, 32, 51, 90; south drags 0 to 0.7 at 20 and 42 N but 33 deg at 58 N (press 0.5), 76 at 58 N (press 0.9), 157 at 75 N, 180 at the pole; north drags 0 to 2 (0.5) and 2 to 36 (0.9). The picture does not move when the mouse is held still (0.0 to 0.07 px, 0 to 0.3 deg in 0.7 s), nothing glides back after release (the roll stays), and the grabbed place stays under the mouse (5 to 14 px off, 122 px off only for east presses at 0.9 of the radius where the mouse moves out over the limb). The measure and the lead's measure may differ (mine reads a rotation of the globe's north direction at the centre, which a hand-turned sphere also has when you drag along a parallel at high latitude)
- Matches fixlist: new (camera set 6581570)
- Repro: orbitdrag.ts at 42 N -19.9 diagNW and POLE diagNW, shots orbit1/*-held.jpg and *-after.jpg
- Expected: 
- Evidence: evid/orbit-roll-n42-r17.jpg, evid/orbit-roll-pole-r17.jpg, evid/roll42-r23.jpg

## 19. Sea glints: hundreds of tiny bright specks evenly spread over the water, day and night
- Severity: noticeable
- Seen: 15.02 N 71.76 W at zoom 5 and 8.27: at local noon (hour 20.5, sun 12:08) about 1400 to 1800 bright pixels in a 1280x800 frame, 2 px wide specks spread evenly like confetti, over the wave crests (evid/sea-noon-r21.jpg); at 02:00 (sun 17:31) fainter orange and grey-white specks of the same even spread (evid/sea-night-glints-r21.jpg); also 0.64 S 4.64 W zoom 9 at hour 13 (evid/sea-z9-r21.jpg). None at zoom 3 and below, none at 25 N 15 E zoom 2 or at night at 20:00 25 N 15 E zoom 0.
- Status: fixed on 7534e5d: the evenly spread white and orange confetti is gone by day and by night at zoom 5, 8.27 and 9 (15.02 N 71.76 W, 30 N 100 E, 0.64 S 4.64 W); no orange specks counted at any hour tested; what remains are pale blue wave crests (1400 to 2000 bright blue pixels at noon zoom 5 and 8.27, evid/sea-day-r22.jpg) and faint blue facets at night (evid/sea-night-r22.jpg), which look like waves, not confetti
- Matches fixlist: new (sea glints)
- Repro: look.ts 15.02,-71.76 zoom 5;8.27 with Q=hour=20.5&warm=0 (day) and Q=hour=2&warm=0 (night)
- Expected: 
- Evidence: evid/sea-noon-r21.jpg, evid/sea-night-glints-r21.jpg, evid/sea-day-r22.jpg, evid/sea-night-r22.jpg

## 20. After arriving at a place, the picture is a blurry other picture for 1 to 3.5 seconds, then pops to the final one
- Severity: noticeable
- Seen: Right after look.ts reaches 25 N 15 E zoom 2 (page idle reports done) the picture is uncorrelated with the final one (corr 0.00 to 0.05 for the first 0.5 s, 0.47 at 1.1 s, 0.86 at 2 s, 0.99 at 3 s, 1.0 after 3.5 s). At 15.02 N 71.76 W zoom 3 the first frame is 0.91 like the last, so it is steady at once there. A wheel tick in and out at zoom 2 settles in 0.7 s. At zoom 5 and above the sea is steady. Round 26 (arrsettle): same as round 25. Sea arrivals right from the first frame (0.84 to 0.94, final by 0.1 to 1.5 s); land arrivals uncorrelated for 1.4 to 3.3 s then pop: A zoom 2 3.3 s, A 3 2.5 s, M 3 2.9 s, B 3 2.2 s, home 3 2.0 s, R 4 1.4 s, E2 2 1.5 s; A zoom 4 at once. Round 28: see status. Round 30 (arrsettle, one run each, t90 in ms): A z2 1215, A z3 2183, A z4 106, B z3 1792, home z3 1525, R z4 1744, E2 z2 1164, M z3 1531; sea 25 N 15 E z2 1154, z3 1175, 15 N 71 W z2 955, z4 1128 (first frame already 0.71 to 0.86 like the final). Land z2 and z3 arrivals are uncorrelated (0.00) for 0.5 to 1.6 s, then pop to the final picture: same as round 28 within noise. Round 31 (branch :8472, one run): A z2 1167, A z3 2014, A z4 87, B z3 1813, home z3 1529, R z4 1749, E2 z2 1198, M z3 1495, sea 944 to 1305: same as published within noise.
- Status: improved on 525a55e (arrsettle t90, correlation 0.9 with the final picture, two runs each; before in brackets, ms): A z2 1156 and 1185 (3306), A z3 2405 and 2365 (2464), A z4 90 (240), B z3 2017 and 2082 (2152), home z3 1786 and 1710 (1963), M z3 1767 and 1741 (2936), E2 z2 1145 and 1188 (1494), R z4 1970 and 2013 (1443, slower), sea 25 N 15 E z2 1147 (1465), z3 1119 (555, slower), 15 N 71 W z2 952 (929), z4 1343 (69, slower). Frames (evid/arrival-A3-r29.jpg, A2, B3): at 60 ms a smooth blurred ground of the right colours, from 400 ms the right shapes (forest, sand, shadows) in softer detail and a darker green, at 1.5 s the fine detail and bright green arrive in one step (a visible pop of colour and detail, smaller than before), and at A zoom 3 the stream and trees come with it. No hole, no slide and no popping trees seen; the 0.5 s ladder fade is not visible as a separate step. The first frame correlation to the final one is 0 on land at zoom 2 to 3 (the first picture is smooth), 0.71 to 0.86 on sea
- Matches fixlist: new (waves at every zoom)
- Repro: settle2.ts 25 15 2 13 (screenshots every 200 ms after the jump)
- Expected: 
- Evidence: evid/arrival-A-z3-r25.jpg, evid/arrival-A3-r29.jpg, evid/arrival-A2-r29.jpg, evid/arrival-B3-r29.jpg

## 21. [planet 6f5e] Coasts are drawn as sawtooth or stair steps
- Severity: visibly broken
- Seen: R mouth -10.48 90.29 zoom -1 and 1: the shore is a regular zig-zag of triangles (evid/np6f5e-M.jpg, third and fourth still). K3 -20.56 69.90 zoom -2: the sea edge of the land is a staircase of vertical columns (evid/np6f5e-C.jpg last still). Spit place 55.13 31.15 and shelf 53.84 27.26 at zoom -2: land plate with blocky edges against the sea (evid/np6f5e-K.jpg, np6f5e-S.jpg). The old planet's coasts were smooth curves.
- Status: open, new on the candidate planet (:8500)
- Matches fixlist: new planet generator (not the renderer)
- Repro: look.ts with SITE=http://127.0.0.1:8500: -10.48,90.29 zoom -1;1; -20.56,69.90 zoom -2
- Expected: 
- Evidence: evid/np6f5e-M.jpg, evid/np6f5e-C.jpg, evid/np6f5e-K.jpg

## 22. [planet 6f5e] Irregular cyan water patches lie over the land near coasts
- Severity: visibly broken
- Seen: R mouth -10.48 90.29 zoom 3, K3 -20.56 69.90 zoom 3, spit place 55.13 31.15 zoom 1 and 3, shelf 53.84 27.26 zoom 3: a mottled light-blue and brown mosaic where land meets the sea (evid/np6f5e-R.jpg first still, np6f5e-K.jpg second, np6f5e-S.jpg). The patches are pale cyan, flat, with blotchy edges like a threshold of a noise field; the old planet had none.
- Status: open, new on the candidate planet (:8500)
- Matches fixlist: new planet generator (not the renderer)
- Repro: look.ts SITE=:8500 -10.48,90.29,3; -20.56,69.90,3; 53.84,27.26,3
- Expected: 
- Evidence: evid/np6f5e-R.jpg, evid/np6f5e-K.jpg, evid/np6f5e-S.jpg

## 23. [planet 6f5e] Lakes are a flat bright-cyan disc inside a dark ring with a hard circular edge
- Severity: noticeable
- Seen: E2 17.35 N 45.00 E zoom 1, 3, 5 (evid/np6f5e-E2.jpg): a lake whose inner part is a flat pale blue disc and whose rim is a wide dark-blue band; the disc edge is a sharp circle. Valley lakes at zoom -1 (12.13 90.05) look ordinary, so it is the close view.
- Status: open, new on the candidate planet (:8500)
- Matches fixlist: new planet generator (not the renderer)
- Repro: look.ts SITE=:8500 17.35,45,1;3;5
- Expected: 
- Evidence: evid/np6f5e-E2.jpg

## 24. [planet 6f5e] A large flat featureless brown plain
- Severity: noticeable
- Seen: B -17.14 49.33 zoom 1 and 3 (evid/np6f5e-B.jpg): the whole screen is one grainy brown tone with a single tiny tree strip; no relief, no vegetation, no stream. Zoom -2 shows the same land is mostly bare.
- Status: open, new on the candidate planet (:8500)
- Matches fixlist: new planet generator (not the renderer)
- Repro: look.ts SITE=:8500 -17.14,49.33,1;3
- Expected: 
- Evidence: evid/np6f5e-B.jpg

## 25. [planet 6f5e] Evenly spaced parallel ridges are still on the planet
- Severity: noticeable
- Seen: Ridges 45.4 N 39.2 E zoom -1 and 1 (evid/np6f5e-V.jpg first and second stills): about 12 parallel north-south ridges spaced evenly across the screen, each with a forest strip (the washboard of issue 9). Home 46.43 N 45.76 E zoom -2 shows the same ripple on the slopes.
- Status: open, new on the candidate planet (:8500)
- Matches fixlist: new planet generator (not the renderer)
- Repro: look.ts SITE=:8500 45.4,39.2,-1;1
- Expected: 
- Evidence: evid/np6f5e-V.jpg, evid/np6f5e-home.jpg

## 26. [planet 6f5e] Place notes: the lake places 12.13 90.05 and 7.7 84.6 are open sea at zoom 2 and 4; D, A, M are dark at hour 13
- Severity: polish
- Seen: 12.13 N 90.05 E and 7.7 N 84.6 E at zoom 2 to 4 show only open sea (islands and a coast only at zoom -1; evid/np6f5e-W.jpg). D -10.26 -102.88, A -36.04 -103.82 and M -62.12 -89.88 are at local night at the usual hour=13 (sun 02:05), so I re-shot them at hour 19: D summit zoom 1 to 5 is a smooth sand-coloured ridge with soft shadows and a few patches of forest (evid/np6f5e-D.jpg), A is rolling forest with a thin straight-ish track at zoom 3 and trees at zoom 5 (evid/np6f5e-A.jpg), M orange dunes with long dark shadows (evid/np6f5e-M.jpg first stills).
- Status: open, new on the candidate planet (:8500)
- Matches fixlist: new planet generator (not the renderer)
- Repro: look.ts SITE=:8500 12.13,90.05,2;4 7.7,84.6,2;4; Q=hour=19 for D, A, M
- Expected: 
- Evidence: evid/np6f5e-W.jpg, evid/np6f5e-D.jpg, evid/np6f5e-A.jpg

## 27. After letting go of a slow drag at B, the whole picture glides a screen or more
- Severity: visibly broken
- Seen: B 35.9 S 43.59 E, 1280x800, zoom 0: drag the ground north 200 px slowly (5 px per 25 ms), hold the mouse still 300 ms, let go: the picture then slides 742 px in 0.7 s (run 2: 850 px). Northeast 532 px. At zoom 1, 1920x1080, a quick north drag (15 px per 25 ms, 300 px): 1460 px; northeast 1578 px. East, west and south at B: 2 to 88 px. The same drag at A, M, E2, R, home gives 0.3 to 12 px, D south 59 px. In seed 311 (1920x1080, 4 camera-snap hits) the person dragged at B zoom -0.92 and after the release the view moved 1.2 degrees of longitude per frame for 20 frames (35.9 S 43.6 E to 40.8 S 33.1 E, about 1100 km). The view centre reported by the page does not change during the glide (still 36.106 S 46.582 E in all four stills) while the picture moves, so what moves is not what the HUD shows. Round 31: the published site also glides 11 to 43 px at A and the home island after a north drag, and 2 to 7 px at R.
- Status: fixed on branch lead3-surf (:8472, not published): glide after release 0 px in 40 of 40 drags (slow held 5 px per 25 ms at B zoom 0 and 1 north, northeast, east, south; flicks of 15 px per 25 ms released at once at B, A, home, R, zoom 0 and 1.8; 1280x800); the same runs on the published :8197 (525a55e, alternated): B slow north 742 and 764 px, northeast 959 and 512, flicks north 936 and 700 px; A and home north 11 to 43 px, R 2 to 7 px. Nothing snaps and nothing coasts on the branch: the grabbed point is at the mouse until release and stays there (0.0 to 0.1 px for 0.7 s). Stills at B zoom 1.8 after release: geo and picture identical at 0, 150, 450 and 1150 ms. Still open on the published site.
- Matches fixlist: new (near item 18 and fixlist 3.1: motion after release)
- Repro: VP=1280x800 PLACES=B ZS=0 DIRS=N lockf /tmp/nomads-gpu.lock bun dragscan.ts out.json (column glidePx); stills: bun dragshot.ts -35.9 43.59 0 0 -5 40 ds/B0N. Session: seed 311, 1920x1080, camera-snap hits at 66572 to 66740 ms (log.json rows 3799 to 3817).
- Expected: After a held-still release the picture stays where it is.
- Evidence: evid/glide-B-z0-N-r30.jpg, evid/glide-B18-published-r31.jpg, evid/glide-B18-branch-r31.jpg

## 28. Close ground at D reads as one grainy grey-brown tone at noon (planet content: smooth dunes, no small-scale detail)
- Severity: polish
- Seen: D 25.71 S 40.51 W at local noon (hour 17.3, sun 11:02): zoom 3 and 5 show a smooth grey-brown surface covered by fine pink and white speckle, with a few soft dark blobs and one dotted dark line (zoom 3, top left); no trees, no stones, no texture at 50 m scale. Zoom 1 and -2 show real dunes and coast, so it is the close view of a large sand area.
- Status: planet content, not a renderer bug (lead 3 checked, 2026-10-29): the relief is there as smooth sand dunes; at noon the slope shading is low contrast (low-frequency luma 13.5 against 35 at zoom 0 to 1), at low sun (08:42, 14:43) the relief is obvious at zoom 3 to 5. No rock or texture detail at 50 m scale is the planet data (T4)
- Matches fixlist: planet data (T4), not the renderer
- Repro: Q="hour=17.3&warm=0" look.ts st "-25.71,-40.51,1;3;5"
- Expected: 
- Evidence: evid/plain-D-z3-z5-r30.jpg
