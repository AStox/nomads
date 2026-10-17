# Matter: mechanical constants, with sources

Research for the mechanics of matter: src/sim/mechanics.ts and the code that calls it (physics.ts strikeTick, sparkTick, rubTick and wear; formulas.ts predict; materials.ts THING_MATERIAL; fuel.ts PHYS; world.ts boulders). It replaces the unit-free 0 to 1 props that decided striking, splitting, knapping, sparks, friction fire, forging and tool wear, and the name-keyed hit points and yields of world things, with blows of measured energy against materials of measured strength. Every constant comes from the tables below, fixed before the checks in section 11 were run; a check that fails with these values is a gap in the model, not something to retune. Collected 2026-10-11.

How each value was obtained, as in docs/research/fire-constants.md and body-constants.md:
- [read]: read in the primary or full-text source.
- [sec]: read in a secondary source that cites the original.
- [ex]: seen only in a search excerpt or abstract.
- [derived]: arithmetic on cited inputs.
- [UNVERIFIED]: not confirmed.
- [design]: a reading of the sim's own, with its basis stated, where no source gives a number.

Ref keys continue body-constants.md's: R1 to R224 are fire-constants.md's and R225 to R311 body-constants.md's. This document's begin at R312.

Props (materials.ts PROPS) stay, as what people see of a thing: what they think to try, how they name it and what Jev is told. No outcome in this document reads them.

## 1. A blow

| Quantity | Value | Units | Conditions | Source |
|---|---|---|---|---|
| Axe chopping, vigorous | 8.0 MET at 35 blows a minute | MET; /min | Compendium code 11262 | R275 [read] (body-constants sec. 8) |
| Net mechanical efficiency, arm cranking | 10 to 17% | | Submaximal arm cranking and handcycling | R312 [ex] |
| Net efficiency, cycling | 9.8 to 24.1%; delta 18.3 to 25.6% | | Gaesser and Brooks 1975 | R313 [ex] |
| Swing speed against swing weight | V = C / I^n, n = 0.27 for I > 0.03 kg m2 (one arm, standing); softball bats 0.25, golf clubs 0.26 | | Maximum effort, four men 76 to 85 kg; I about the handle's end | R314 [read] |
| Hand in a swing | 0.53 kg, the last 10 cm of the handle | kg | 0.65% of a male body's mass | R314 [read] |
| Wood bat tip speed | 35.2 m/s (metal 37.2) | m/s | 17 hitters, 83 kg, high-speed video | R315 [ex] |
| Wood bat swing weight | 11,500 oz in2 = 0.209 kg m2 about a pivot 6 in (0.152 m) from the knob | kg m2 | A typical 34 in (0.864 m) wood bat | R316 [ex]; SI [derived] |

**Pick.**
- A blow's energy is the least of what the body can keep up and what the swing can reach. Kept up: the body's net mechanical power at chopping, NET_EFF x (8.0 - 1) x its basal rate (body.ts basal), spread over 35 blows a minute. NET_EFF = 0.135, the middle of arm cranking's 10 to 17% [derived]. For the 61.7 kg grown body (basal 73.8 W) that is 69.7 W, 119 J a blow [derived].
- The swing's reach: E = I w^2 / 2, w = w_ref (I / I_ref)^-0.27, with the bat's I_ref = 0.209 kg m2 and w_ref = 35.2 / (0.864 - 0.152) = 49.4 rad/s [derived]. A swing's ceiling grows with the body's lean mass over the grown body's [design: muscle force scales with its mass].
- I of what is swung, about the grip: a hafted head of mass m at the end of a handle of length l and mass h, m l^2 + h l^2 / 3, and the hand 0.53 kg x 0.1^2; something held in the fist alone, (m + 0.53) x 0.1^2 [derived from R314's hand]. A hafted head reaches 49 rad/s and more, a stone in the fist 80 rad/s or so at 8 m/s.
- Bare hands strike with the hand's own mass and are soft: they knap and cut nothing (sec. 5) [design: soft tissue cannot carry a flaking or cutting contact].

## 2. Wood

| Quantity | Green softwood | Green hardwood | 12% softwood | 12% hardwood | Units | Source |
|---|---|---|---|---|---|---|
| Modulus of elasticity | 16,100 G^0.76 | 13,900 G^0.72 | 20,500 G^0.84 | 16,500 G^0.70 | MPa | R317 Table 5-11a [read] |
| Modulus of rupture | 109,600 G^1.01 | 118,700 G^1.16 | 170,700 G^1.01 | 171,300 G^1.13 | kPa | R317 [read] |
| Compression parallel (max crushing) | 49,700 G^0.94 | 49,000 G^1.11 | 93,700 G^0.97 | 76,000 G^0.89 | kPa | R317 [read] |
| Compression perpendicular (proportional limit) | 8,800 G^1.53 | 18,500 G^2.48 | 16,500 G^1.57 | 21,600 G^2.09 | kPa | R317 [read] |
| Shear parallel | 11,000 G^0.73 | 17,800 G^1.24 | 16,600 G^0.85 | 21,900 G^1.13 | kPa | R317 [read] |
| Side hardness | 6,230 G^1.41 | 16,550 G^2.31 | 8,590 G^1.49 | 15,300 G^2.09 | N | R317 [read] |

| Quantity | Value | Units | Conditions | Source |
|---|---|---|---|---|
| Mode I fracture toughness, splitting | TL 250 to 517; RL 260 to 500 | kPa m^1/2 | Douglas-fir 320 TL, 360 RL; Scots pine 440, 500; northern red oak 410 TL; sugar maple 480 TL | R317 Table 5-10 [read] |
| Work of fracture across the grain | 50,000 to 100,000 | J/m2 | 50 to 100 times that along it | R318 [sec] |
| Work of fracture along the grain | 200 to 2,000; radial 20 to 50% above tangential | J/m2 | | R318 [sec] |
| Hazel coppice, radial, pulled apart | 376 +- 92 (502 +- 123 all told) | J/m2 | Green, 10 to 15 mm | R318 [read] |
| Splitting with a wedge | 1,400 to 4,200 | J/m2 of split | Green hazel; wedges of 7 to 40 deg; narrow wedges cost most, friction dominating | R318 [read] |
| Kinetic friction, dry wood on wood | 0.17 to 0.48, most 0.2 to 0.3; oak on oak across grains 0.32 | | | R319 [read] |

**Pick.**
- A piece's wood is its species' (fuel.ts WOODS: G, softwood or hardwood by its burn row; wood of no species the generic softwood). Its properties at its water: green above 25% water, at 12% below 12%, and between them P = P12 (P12 / Pg)^((12 - M) / (25 - 12)) [design: the Wood Handbook's log-linear form; its fibre saturation point of about 25% is UNVERIFIED].
- GF_CROSS = 75,000 J/m2, the middle of 50,000 to 100,000 [design].
- Splitting with a blade costs SPLIT_WIDE = 1,400 J/m2 for blades of 30 deg and wider and SPLIT_NARROW = 4,200 J/m2 at 7 deg, linear between [design: Ennos's range, with his finding that the narrowest wedge cost most].
- MU_WOOD = 0.25, friction of anything sliding on wood [design: wood on wood's commonest 0.2 to 0.3, taken for stone, bone and metal faces too; UNVERIFIED for them].

## 3. Cutting across the grain: felling and chopping

**Model [derived].** A blade of included angle 2b, edge radius r and edge length L driven x into wood across its fibres crushes the fibres ahead of its edge and wedges them apart along its faces. The work: new surface across the grain, L x GF; the crushing ahead of the rounded edge, L 2r sigma x; and the faces, which press the wood with its crushing strength parallel to the grain sigma, against friction mu, L sigma (tan b + mu) x^2. So

  E_cut = L (GF x + 2 r sigma x + sigma (tan b + mu) x^2), solved for x.

A blow's energy reaches the cut only as far as the stem takes it: struck, a stem moves with the blade, and a perfectly plastic impact leaves E m_s / (m_s + m_h) to do work, with m_s the stem's effective mass at the blow and m_h the swung mass's [derived, momentum]. A stem's effective mass is a tip-loaded cantilever's, 33/140 of its mass [derived, Rayleigh], green wood and its water; a trunk's is so large the whole blow goes in.

Blows alternate level and at 45 deg, each pair taking out a chip of L x^2 / 2 [design]. Felling cuts a 90 deg notch to the centre from either side, D^3 / 3 of wood for a trunk D across [derived: two V notches of depth D/2 in a cylinder]. So felling takes 4 D^3 / (3 L x^2) blows, with L the least of the blade's edge and D [derived], fewer by exp(-0.10) for each step of practice (R320's experience term, one step of skill taken as one of its experience scale [design]). Blows come at 35 a minute, 175 to a five-minute tick. What would take more than a day's work, eight hours of blows (16,800), is given up after a tick as barely marked [design]. A blade cut into a trunk takes off the bark over its notch, about D^2 of it [derived], in strips of fuel.ts PHYS.bark's 0.109 m2.

| Quantity | Value | Units | Conditions | Source |
|---|---|---|---|---|
| Stone axe heads | 0.4 and 0.6 kg chert, 16.9 and 17.5 cm long, on 68 to 70 cm hafts | | | R320 [read] |
| Steel axe | 4 kg, 71 cm, 9 cm edge | | | R320 [read] |
| Felling strokes model | ln N = 2.77 + 0.12 DBH(cm) + 2.09 stone - 0.10 experience - 1.29 tensioned | | 3.5 to 5.6 cm laurel oak; Poisson GLMM | R320 [read] |
| Experienced feller, stone axe, 5 cm | about 150 more strokes and 4.25 more minutes than steel | | | R320 [read] |
| Best feller, stone, 4.6 cm | 107 blows in 1.28 min | | | R320 [read] |
| Stone axe edge | resharpened after 3 to 4 trees; no head broke | | | R320 [read] |

The checks are in sec. 11.

## 4. Splitting along the grain

A piece split into n along its grain opens n - 1 faces through its middle, each as wide as it is thick and as long as it is long [derived]. Each costs its area times the blade's splitting energy (sec. 2), paid blow by blow out of the blow's energy; only a blade drives a split (an edge narrower than 90 deg) [design].

## 5. Flaking stone and breaking rock

| Quantity | Value | Units | Conditions | Source |
|---|---|---|---|---|
| Specific fracture energy, particle beds under drop weights | 74.0 average | J/m2 | Impact crushing, energy in over new surface | R321 [read] |
| Same, quartz under drop weights | 75 to 82 | J/m2 | Johnson et al. 1949 | R321 [read] |
| Rock under uniaxial compression, tension, shear | 26.6, 13.9, 25.7 | J/m2 | Regular specimens, no notch | R321 [read] |
| Granite, Bond work index | 15.13 (14.37 elsewhere) | kWh/t | | R322 [ex] |
| Limestone; quartzite; quartz | 12.74; 9.58; 13.57 | kWh/t | | R322 [ex] |
| Bond's law | W = 10 Wi (1/sqrt(P) - 1/sqrt(F)) | kWh/t; P, F in um | 80% passing sizes | R322 [ex] |
| Chert | E 77 GPa; KIc 2.4 MPa m^1/2; hardness over 10 GPa | | Indentation, few indents | R323 [read] |
| Obsidian; soda-lime glass | E 65.35, 52.87 GPa; KIc 1.06, 0.97 MPa m^1/2 | | Pulse echo; SEVNB | R324 [read] |
| Antler | E 7 GPa; KJc 4 to 5 longitudinal, about 20 transverse | MPa m^1/2 | Elk antler | R325 [read] |
| Plate glass flaked by steel balls | 28 g, 9.5 mm radius, at 4.81 m/s (0.32 J) | | Drop tower, angle of blow 20 deg | R326 [read] |

**Pick.**
- A flake comes off a stone struck by anything solid when the blow carries W_F = 74 J/m2 for the flake's two new faces (one on the flake, one on the core), each the flake's volume over its thickness [design: R321's impact value for rock, taken for flint, granite and bone alike]. The flake is the sharp kind the stone gives (materials.ts BASE breaks) at its size (fuel.ts PHYS). A stone smaller than its flake gives none.
- A boulder struck breaks into hand stones by Bond's law, from its own size to a hand stone's (fuel.ts PHYS.stone, 0.1 m), at granite's Wi = 15.13 kWh/t: a 1 m boulder 1.17 kJ a kg, 1.6 MJ in all; one of 0.5 m 0.94 kJ a kg, 162 kJ [derived]. Stones come off one by one as the blows add up to each one's share; what lies inside comes out once half of it is broken [design].
- Bare hands carry no flaking contact (sec. 1).

## 6. Edges and wear

| Quantity | Value | Units | Conditions | Source |
|---|---|---|---|---|
| Stone axe edge life | 3 to 4 trees of 3.5 to 5.6 cm laurel oak between sharpenings | | 0.4 to 0.6 kg chert heads | R320 [read] |
| Archard's law | worn volume = k F s / H | | | R327 [sec] |

**Pick.**
- Edges [design, UNVERIFIED for every row; the shapes knappers and smiths make]: a flint or chert flake 35 deg and 1 um across its edge, 4 cm long; a granite spall 70 deg and 1 mm (its grains), 4 cm; a bone shard 40 deg and 20 um, 3 cm; hammered copper to its drawn thickness (sec. 9), 5 cm. A stone, a stick or a log has no edge: struck end on, it is as blunt as it is round, its radius half its thickness and 180 deg.
- A hafted tool's edge is its head's (the part with the finest edge), its swing the head's mass at the end of its longest part as handle.
- Edge life by Archard's law, scaled from the stone axe: an edge cutting wood lasts EDGE_LIFE = 3.5 trees x 168 strokes = 590 blows of the stone axe's energy on laurel oak, longer in proportion to its own hardness and shorter to the wood's crushing strength and the blow's energy [derived: R320's life, R327's proportions; chert's hardness 10 GPa]. Nothing else wears a tool [design: hammerstones last; their wear is a gap].

## 7. Sparks

| Quantity | Value | Units | Conditions | Source |
|---|---|---|---|---|
| Strike-a-lights | flint struck on pyrite; Upper Palaeolithic rounded-end flints | | | R328 [ex], R329 [read] |
| Spark capture, untreated tinders | 8.92 ignitions per 100 spark-producing strokes (1 moss to 27.67 Fomes); first at 11.29 sets of 5, about 55 sparks | | Flint blade scraped on pyrite, indoors | R330 [read] |
| Typha (cattail) | first ignition at 11 sets, about 55 sparks; 7.0 ignitions per 100 | | | R330 [read]; 7.0 [derived from 19.33 / 2.76] |
| Fomes (tinder fungus) | first at 7.33 sets, about 37 sparks | | | R330 [read] |
| Pyrite | density 5.0 g/cm3, Mohs 6 to 6.5 | | | R331 [UNVERIFIED] |
| Flint, chert, quartz | Mohs 7 | | | R331 [UNVERIFIED] |

**Pick.**
- Sparks come of pyrite struck by a stone harder than it, Mohs over 6.25: flint, chert or granite's quartz [design: the pyrite is shaved off and burns; R329, R330]. Two flints, two stones, a stone and anything else throw none that catch [design: the operator's ruling 2026-10-11 that sparks follow their chemistry].
- Plant tinder catches at the 55th spark, Typha's first ignition [read], one spark a stroke [design].
- Damp tinder (wetness.ts DAMP) and a gale (GALE) still stop them, as before.
- Pyrite lies in the rock as nodules, in chalky limestone with flint and in mudstone, little in sandstone, granite or basalt [design: geology.ts ROCKS pyrite, UNVERIFIED shares].

## 8. Friction fire

| Quantity | Value | Units | Conditions | Source |
|---|---|---|---|---|
| Frictional power | P = (2/3) mu F_N SM V_B for a bow drill; about 21 W | W | Duncan's model | R319 [read] |
| Bow drill | F_N 60 N; bow speed 1.86 m/s (35 strokes of 0.56 m each way in 21 s); spindle radius 12.7 mm; divot 4.2 mm deep | | Slippery elm | R319 [read] |
| Char dust ignition | about 700 F (371 C), 650 to 800 F | | | R319 [read] |
| Time to an ember | 23 to 24 s, model 23.27 s | s | Notch filled with dust | R319 [read] |

**Pick.** The rubbed face is heated by the friction's power, half into each piece, over the contact pi (R^2 + h^2); its face comes to the dust's ignition as a thick piece's does under a flux (combustion.ts needs: (pi/4) k rho c (1 + 8.1 m) dT^2 / q^2), with the wood's own k rho c (fuel.ts Burn krc) and water [derived from R319 and fire-constants sec. 27g]. A bow drill: R319's force and speed, mu 0.25, a 4.2 mm divot, the spindle the drilled stick's own radius. Two sticks spun or sawn by hand: F_N 30 N and 0.5 m/s [design, UNVERIFIED: half the bow's force, the palms' slower stroke], the spindle the stick's own radius too. Dust ignites at T_DUST = 371 C.

## 9. Copper

| Quantity | Value | Units | Conditions | Source |
|---|---|---|---|---|
| Hollomon flow curve, annealed copper | sigma = K eps^n; K 320 MPa (46,400 psi), n 0.54 | | | R332 [sec]; K 300 n 0.50 elsewhere [ex] |
| Annealed hardness after post-annealing | 54 to 57 HV | | ETP copper | R333 [read] |

**Pick.** Hammering copper thins it: a blow's energy does plastic work sigma(eps) d eps over the worked volume, the edge's last 2 cm of the piece's width [design], at the flow stress of its strain so far, and the edge comes to the thickness its strain leaves, d e^-eps. Cold, it hardens by Hollomon's law and splits past a true strain of 1.5 [design, UNVERIFIED]; red hot (combustion.ts setIn at RED), each blow is worked annealed, at the flow stress of a strain of 0.002 [design]. A blade is drawn when its edge is thinner than 0.5 mm [design].

## 10. What things break into

| Quantity | Value | Units | Conditions | Source |
|---|---|---|---|---|
| Scots pine stem wood | ln y = -3.721 + 8.103 dS/(dS + 14) + 5.066 h/(h + 12) | kg dry | dS = 2 + 1.25 d (cm), h m; 626 trees | R334 [read] |
| Living branches | ln y = -6.162 + 15.075 dS/(dS + 12) - 2.618 h/(h + 12) | kg | 892 trees | R334 [read] |
| Dead branches | ln y = -5.201 + 10.574 dS/(dS + 16), times 0.911 | kg | 847 trees | R334 [read] |
| Log-normal corrections | var(u) + var(e): stem 0.002 + 0.009; living 0.041 + 0.089; dead 0.253 + 0.362 | | Retransformation exp(s^2/2) | R334 [read] |

**Pick.** A felled tree gives its stem in logs (fuel.ts LOG_LEN pieces of its trunk) and its branches in sticks (fuel.ts pieces), as many as the stem's and branches' dry mass hold, by Repola's pine equations for every species [design: one species' allometry for all], at the tree's height and its trunk's diameter (fuel.ts TRUNK). A fallen log gives its length in logs and its dead branches in sticks; a bush, a dead bush and a stump their one stem as now; reeds the fibre they gave [gap: the plants' pass]. Animals keep their carcasses (materials.ts carcass) and their hit points [gap: the wounds' pass].

## 11. Checks

Worked out with src/sim/mechanics.ts on the constants above (2026-10-11), for the grown body (basal 73.2 W, lean 53.1 kg), 119 J a blow:

- **Felling with a stone axe (R320).** A 0.5 kg chert head on a 0.7 m haft (60 deg, 50 um [design]) against a 5 cm laurel oak 6 m tall, green (G 0.56 [UNVERIFIED], water 0.7): 74 blows, the stem taking 62% of each; R320's experienced fellers 150 (the GLMM at 5 cm, experience 4.5). Half the measured: **fails by a factor of 2.**
- **Felling with a steel axe (R320).** 3 kg of head and 1 kg of haft [design], 25 deg, 9 cm: 169 blows, the light stem taking only 24% of the heavy head's blow; measured 18.5. **Fails by a factor of 9.** Against a rooted trunk (the whole blow into the cut) the same axe takes 26. The sapling's give is the model's largest loss and its weakest part: a plastic impact with a stem's static effective mass overstates how much a heavy head wastes on a light stem.
- **Bow drill (R319).** A 25 mm spindle at 12% water, 15 C: 66 s, against Duncan's model's 23.27 s and his 23 to 24 s with the notch already full of dust. **Slow by a factor of 2.8**; the face is taken as wood's kρc, not the char dust's, and the dust's own heating is not modelled.
- **Pyrite (R330).** Plant fibre catches at the 55th stroke, by construction (the value is the measured one).
- Hand drilling: 349 s with a 25 mm stick, 56 s with a 4 mm twig as the spindle; no measured value to set it against.

## 12. Gaps

- Every edge angle and radius (sec. 6) is [design].
- A felled tree gives little bark: the notch's D^2 is less than one strip below about 33 cm across, where the old rule gave a strip every few blows. People who want bark would peel it, which no rule here does yet.
- Wear is only an edge's into wood; hammerstones, and edges struck on stone or bone, don't wear.
- The chopping model's chip geometry and notch (sec. 3) are [design]; no measured specific energy for chopping was found (Coe et al. 2022 give it only in a figure).
- Hand drilling's force and speed are [UNVERIFIED].
- Pyrite's shares by rock are [design]; its properties and every Mohs value are [UNVERIFIED].
- Cold copper's cracking strain and the worked volume are [design].
- Wounds: animals, and people fighting, still lose hit points by the old rule (physics.ts throwDamage, sim.ts fights); they belong with people's wounds.
- Digging and the work durations, untouched here, became work over a power in substrate 7 (people-constants sec. 7).
- Joining still writes its products' props by arithmetic; they are only what people see of them, and no outcome reads them. Jev's rulings likewise.

## References

- R312 Muscular efficiency of arm cranking and handcycling, 10 to 17% at submaximal level, as quoted in Bressel et al. via https://www.researchgate.net/publication/6440929 (search excerpt)
- R313 Gaesser G.A., Brooks G.A. (1975), Muscular efficiency during steady-rate exercise: effects of speed and work rate, J Appl Physiol 38:1132-1139, doi:10.1152/jappl.1975.38.6.1132 (search excerpt)
- R314 Cross R., Bower R. (2006), Effects of swing-weight on swing speed and racket power, J Sports Sci 24:23-30, doi:10.1080/02640410500127876. https://www.physics.usyd.edu.au/~cross/PUBLICATIONS/33.%20SwingSpeedvsSW.pdf (read 2026-10-11)
- R315 Fleisig G.S., Zheng N., Stodden D.F., Andrews J.R. (2002), Relationship between bat mass properties and bat velocity, Sports Eng 5:1-8 (search excerpt)
- R316 Russell D.A., Explaining the BESR test for baseball bats, Penn State Acoustics. https://www.acs.psu.edu/drussell/bats/besr.html (search excerpt)
- R317 Kretschmann D.E. (2010), Mechanical properties of wood, ch. 5 of Wood Handbook, FPL-GTR-190, Tables 5-10 and 5-11a. https://www.precisebits.com/PDF/USFS_mechanical_properties_of_wood.pdf (read 2026-10-11)
- R318 Ennos A.R., Oliveira J.A.V. (2017), The mechanics of splitting wood and the design of Neolithic woodworking tools, EXARC Journal 2017/4. https://exarc.net/issue-2017-4/ea/mechanics-splitting-wood-and-design-neolithic-woodworking-tools (read 2026-10-11)
- R319 Duncan B.D. (2021), The physics of fire by friction, University of Dayton ECE Faculty Publications 418. https://ecommons.udayton.edu/ece_fac_pub/418/ (read 2026-10-11)
- R320 Putz F.E., Fletcher T., Magee L. (2023), Tree felling with stone axes: pre-bending matters but feller sex does not, Forests 14:202, doi:10.3390/f14020202 (read 2026-10-11)
- R321 Zhang Z.-X., Ouchterlony F. (2022), Energy requirement for rock breakage in laboratory experiments and engineering operations: a review, Rock Mech Rock Eng, doi:10.1007/s00603-021-02687-6. https://d-nb.info/1249043859/34 (read 2026-10-11)
- R322 Bond work index table (granite 15.13, limestone 12.74, quartzite 9.58, quartz 13.57 kWh/t) and Bond's equation, ScienceDirect Topics, Bond Work Index. https://www.sciencedirect.com/topics/engineering/bond-work-index (search excerpt)
- R323 Namen A., Iovita R., Nickel K.G., Varis A., Taimagambetov Z., Schmidt P. (2022), Mechanical properties of lithic raw materials from Kazakhstan: comparing chert, shale, and porphyry, PLoS ONE 17(4):e0265640 (read 2026-10-11)
- R324 Husien A. (2004), Fracture behavior and mechanical characterization of obsidian: naturally occurring glass. https://www.deschutesmeridian.com/IAOS/pdf/husien_2004.pdf (read 2026-10-11)
- R325 Launey M.E., Chen P.-Y., McKittrick J., Ritchie R.O. (2010), Mechanistic aspects of the fracture toughness of elk antler bone, Acta Biomater 6:1505-1514 (read 2026-10-11)
- R326 Li L., McPherron S.P. (2025), Reconstructing hammerstone size flake by flake: an experimental approach, J R Soc Interface, doi:10.1098/rsif.2024.0879. https://pmc.ncbi.nlm.nih.gov/articles/PMC12074805/ (read 2026-10-11)
- R327 Archard J.F. (1953), Contact and rubbing of flat surfaces, J Appl Phys 24:981-988 (the law as commonly stated; not read)
- R328 Stapert D., Johansen L. (1999), Flint and pyrite: making fire in the Stone Age, Antiquity 73:765-777 (abstract)
- R329 Sorensen A.C., Claud E., Soressi M. (2018), Neandertal fire-making technology inferred from microwear analysis, Sci Rep 8:10065. https://pmc.ncbi.nlm.nih.gov/articles/PMC6053370/ (read 2026-10-11)
- R330 Sorensen A.C. (2024), Lucky strike: testing the utility of manganese dioxide powder in Neandertal percussive fire making, Archaeol Anthropol Sci 16:134, doi:10.1007/s12520-024-02047-9 (read 2026-10-11)
- R331 Mineral data for pyrite, quartz and chalcedony (Mohs and density) as commonly tabulated (not read)
- R332 Total Materia, True stress true strain curve, part 4: strain-hardening parameters (copper, annealed, n 0.54, K 46,400 psi). https://www.totalmateria.com/en-us/articles/true-stress-true-strain-curve-4/ (search excerpt)
- R333 Post-annealed ETP copper, PMC11254610. https://pmc.ncbi.nlm.nih.gov/articles/PMC11254610/ (read 2026-10-11)
- R334 Repola J. (2009), Biomass equations for Scots pine and Norway spruce in Finland, Silva Fennica 43(4):625-647. https://silvafennica.fi/pdf/184 (read 2026-10-11)
