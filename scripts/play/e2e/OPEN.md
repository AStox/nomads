# Open list (not fixed), round 25 on 14f4382

2. [visibly broken] The ground under the cursor does not stay under it while wheeling below zoom 2 -- improved: bursts hold in the burst test (round 23). Single ticks: A within 1 px at every cursor; R lower left within 2 px. B (35.9 S 43.6 E) at the lo
3. [visibly broken] The north pole and everything above about 75 N is empty at every zoom -- open, unchanged in round 11 (89.6 N 10 E zoom 4: flat navy at 02:00, 06:15, 08:00)
4. [visibly broken] A straight seam where the ground detail changes -- not seen on the new planet at the old repro places (1.9 S 64.9 E, 5.7 S 66.5 E zoom 0.6 to 0.82); the seam-detector hits in 4 sessions were natural ba
5. [polish] Sea is a flat, very dark colour at close zoom and its dot lattice stays fixed to the screen -- improved: waves now show at every zoom from -1 up (25 N 15 E zoom 0 to 3 and 15.02 N 71.76 W zoom 0 to 8.27, sun 10:20 and 12:08): soft elongated clou
6. [noticeable] Orange parallel lines (dry beds) lie over slopes, forest and sand, up to the whole screen -- mostly improved, but a regression at zoom 6: parallel orange lines, evenly spaced, run diagonally across the whole screen at B 35.9 S 43.59 E zoom 6 (
8. [noticeable] Night side is pitch black and the planet disappears into space -- open, changed on 6de93f9 and 96c5cf1 (night floors removed, twilight from 07:30). Home island 47.78 N 38.63 E zoom 5.3 mean luma: 02:00 19.7, 06:15 12
9. [noticeable] Terrain washboard and stepped coasts -- open, unchanged in round 5
11. [polish] Thin dotted straight lines across the ground at zoom 1.8 to 2.6 -- open, unchanged in round 5
14. [noticeable] Streams smaller than a pixel are drawn as hairlines: a 1 px blue and white line with straight horizontal and vertical runs -- improved on 7a96f20: the staircase is gone, streams at R 12.23 N 83.85 E zoom 3, 4, 5, 6 and R 12.02 N 83.89 E zoom 2.5 to 3 are smooth curves (evid/s
15. [polish] Small luma dips and steps at the level boundaries when zooming through a forest (zoom 7.5, 6.6, 5.6, 4.6, 3.6) -- improved on e59df3f: hand-over ladders zoom 4.8 to 3.4 (0.1 steps) at A (luma 157 to 124), home (89 to 95) and B (69 to 80): no step above 3.4 luma, n
16. [visibly broken] Rivers are straight lines (and evenly spaced stripes carry the streams) -- open, partly improved on 7a96f20: streams at zoom 2.5 to 6 are smooth curves now. The R river at zoom -1 and 1 is still one dead-straight east-west li
17. [visibly broken] Forest edges are straight lines instead of fading out -- improved on e59df3f: forest edges at A (4.35 N 39.38 W) and the home island (47.78 N 38.63 E) at zoom 3 to 6 now wander with outlying clumps and a thi
18. [polish] After an orbit drag the planet rolls and glides back (check) -- open: roll is not zero on 745cd2a by my measure (the screen angle of the south direction at the view centre, before against after a 30 step, 150 px dr
20. [noticeable] After arriving at a place, the picture is a blurry other picture for 1 to 3.5 seconds, then pops to the final one -- improved for the sea on 14f4382: 25 N 15 E zoom 2 and 15.02 N 71.76 W zoom 2 are 0.88 like the final from the first frame and are settled in 1 to 2 s 
