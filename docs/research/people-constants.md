# The people's constants: walking and carrying, work, shelters, throwing and hunting, perception (2026-10-16)

Research for the rule audit's substrates 6, 7, 8, 9 and 12 (docs/research/rule-audit.md). R-numbers R1000 to R1029 are walking and carrying's, R1150 to R1199 work's, R1101 to R1149 shelters', R1030 to R1059 throwing, hunting and fishing's, R1060 to R1099 perception's. References cited from the other research pages keep their numbers there (R90, R221, R273, R317, R451 and R479 here).

## 6. Walking and carrying (R1000-R1029)

Code: src/sim/gait.ts (new), walk.ts (routes, strides, obstacles), sim.ts stepToward and metOf, physics.ts giveStack, stow, unstash, occupied and strikeTick's reach, plan.ts add, sky.ts TICK_S. Every speed is m/s and every cost W; ticks come in only through sky.ts TICK_S (86400 / DAY s).

### 6a. The body's size and reach

| Quantity | Value | Units | Conditions | Source |
|---|---|---|---|---|
| Segments as shares of stature | upper arm 0.186, forearm 0.146, hand 0.108 (shoulder to fingertip 0.440); shoulder breadth 0.259; shoulder height 0.818 | - | adults | R1062 (sec. 12's) [ex] |
| Dynamic similarity | walkers geometrically alike move alike at equal Froude number v^2 / gL | - | legs a fixed share of stature | R1002 [ex] |

**Pick.**
- Reach from where someone stands: half their shoulders and an arm, 0.5695 of stature [derived]; a grown body (body.ts, 1.6964 m) reaches 0.97 m (was REACH, 1.5 m for everyone), a five-year-old 0.62 m. Overhead: shoulder height and an arm, 1.258 of stature (was a flat 2 m for anything flying).
- To work on a thing they stand an arm from its edge: a tree's or sapling's trunk half its breast-height diameter by its height (mechanics.ts trunkOf), a stump its girth, a fire its heap (combustion.ts radius), anything else half its width (was 1.5 m plus 0.3 for anything with a trunk and min(3, size / 2) for the rest).
- A strike reaches an arm and the length of what's swung beyond the grip (physics.ts holdOf, the lever mechanics.ts swings), was 1 m for anything "long" over 0.6. An animal is struck within half a metre of its middle beyond that [design].

### 6b. Walking speed: slope and size

| Quantity | Value | Units | Conditions | Source |
|---|---|---|---|---|
| Tobler's hiking function | v = 6 exp(-3.5 abs(S + 0.05)) | km/h | S rise over run; 5.04 km/h level, 6 at S = -0.05; from Imhof's walking data | R1000 [read] |

**Pick.** A grown walker goes at Tobler's speed on the slope under each stride (the generator's fine heights at the stride's ends, flora.ts heightAt); someone of stature m at sqrt(m / 1.6964) of it, dynamic similarity with legs a fixed share of stature [derived] (was a child at 0.6 of a grown body).

### 6c. The ground: terrain coefficients and trodden paths

| Quantity | Value | Units | Conditions | Source |
|---|---|---|---|---|
| Soule and Goldman's terrain coefficients for Pandolf's equation | blacktop 1.0, dirt road 1.1, light brush 1.2, heavy brush 1.5, swamp 1.8, loose sand 2.1 | - | level ground, 0.66 to 1.55 m/s, 0.8 to 30 kg | R1003 [read], its Table 1 |
| Lejeune et al.'s optimal speed on sand | 1.1 | m/s | against a firm 1.3 to 1.4 | R1003 [read, as reviewed] |

**Pick.**
- Each ground class of the generator (flora.ts GROUND) takes the nearest: grassland, grass with outcrops and the forest floor as light brush (1.2), scrub as heavy brush (1.5), marsh as swamp (1.8), bare ground as a dirt road (1.1), sand as loose sand (2.1), bare rock as blacktop (1.0) [analogue]; a stream's bed and ice as bare ground [analogue].
- How fast someone goes on ground of coefficient eta carrying L kg: the speed that costs least per metre by Pandolf's equation, sqrt((1.5 W + 2 (W + L)(L/W)^2) / (1.5 eta (W + L))), against the same unladen on blacktop [derived]. Sand gives 0.69 of a walker's speed where Lejeune et al. measured 0.79. The standing load term makes the slowing by load small and not monotonic: 0.95 of the unladen speed at 10 to 20 kg, 0.98 at 45% of body mass; preferred speed is known to change little with load.
- A trodden path is its tile's ground worn toward a dirt road's 1.1, as far as its wear (world.ts paths, 0 to 9) has gone [gap: how many passes beat a cover bare is not wired to the wear count, which ecology.ts trample still draws by dice] (was 1.4 times the speed once trodden five times).

### 6d. Snow

| Quantity | Value | Units | Conditions | Source |
|---|---|---|---|---|
| Sinkage | z = h (1 - rho / 1.186) | cm | snow h cm deep of density rho g/cm3 | R1004 [read, abstract] |
| Terrain coefficient on snow | eta = 0.0005 z^3 + 0.0001 z^2 + 0.1072 z + 1.2604 | - | for Pandolf's equation | R1004 [read, abstract] |

**Pick.** The snow lying at a point is the season's snowpack as deep as air.ts snowDepth has it (Sturm et al.'s density), less what crowns hold off, the forage rule's (animal-constants); where it covers only a share of the ground (air.ts snowAt), the ground's own coefficient on the rest [derived]. 10 cm of 0.3 g/cm3 snow gives eta 2.28 and a grown walker 0.93 m/s; 30 cm, 9.3 and 0.46 m/s.

### 6e. Wading

| Quantity | Value | Units | Conditions | Source |
|---|---|---|---|---|
| Self-chosen speed in water to the knee, hip, navel and breastbone (28, 48, 63, 73% of stature) | 0.62, 0.54, 0.49, 0.43 | m/s | nine men, 1.78 m, 31 C water | R1006 [read] |
| Net cost of transport at those speeds | 3.4, 4.1, 5.9, 6.7 | J/kg/m | the same | R1006 [read] |

**Pick.** Where a stream runs at a point (streams.ts, its depth now), someone wades: at the share of their stature it reaches, the measured speed scaled by the Froude number to their stature and the measured cost [derived]; between dry ground and the knee, straight from their dry walk [derived]; deeper than the breastbone, as there [gap: swimming]. A runner wades too.

### 6f. What walking costs

| Quantity | Value | Units | Conditions | Source |
|---|---|---|---|---|
| Pandolf, Givoni and Goldman | M = 1.5 W + 2.0 (W + L)(L/W)^2 + eta (W + L)(1.5 V^2 + 0.35 V G) | W | W body kg, L load kg, V m/s, G grade % | R1005 [read, as R1003 restates it] |
| Santee et al.'s downhill correction | CF = eta [G (W + L) V / 3.5 - (W + L)(G + 6)^2 / W + (25 - V^2)], M = eq. - CF for G below 0 | W | 0.89 to 1.34 m/s, 0 to -10% | R1007 [read, as R1003 restates it] |

**Pick.** Each stride walked costs Pandolf's watts at the speed, grade, ground and load it was walked at, never less than standing with the load [derived]; the energy and seconds walked in a tick go to the body (body.ts) the tick after, the rest of the tick at the act's MET (sim.ts metOf) (was a flat 3.5 MET whenever their plan was to go somewhere). A grown body walking the level at Tobler's speed on light brush spends 274 W, 3.9 times its 71 W basal rate. What they carry and wear is L.

### 6g. Running

| Quantity | Value | Units | Conditions | Source |
|---|---|---|---|---|
| Minetti et al.'s net cost of running | Cr = 155.4 i^5 - 30.4 i^4 - 43.3 i^3 + 46.3 i^2 + 19.5 i + 3.6 | J/kg/m | i from -0.45 to 0.45; independent of speed; 20.9 J/ml O2 | R1008 [read] |
| Maximum aerobic running speed | v = E / Cr | m/s | E net metabolic power, W/kg | R1008 [read] |
| Median VO2max, men and women | 48.0 and 37.6 in their twenties, falling 9.2 and 10.3% a decade to 24.4 and 18.3 in their seventies | ml/kg/min | FRIEND registry, treadmill, 7783 tests | R1009 [read] |
| One MET | 3.5 | ml/kg/min | resting | R1010 [ex] |

**Pick.** Someone fleeing or chasing runs as fast as their VO2max less resting carries them and their load at Minetti's cost times the ground's coefficient [derived], no faster downhill than on the level (Minetti's downhill racers ran a third as fast as their aerobic power allowed) [design], and spends their VO2max's power; VO2max is the men's and women's mean, 42.8 ml/kg/min to 25 years and 9.75% less each decade after [derived]; anyone younger than twenty is held at it [gap: no children's data]. A grown body runs 3.2 m/s on light brush, 1.9 m/s up 10%; at 70, 1.9 m/s (was 6 m a tick, three times walking).

### 6h. Walking in the dark

| Quantity | Value | Units | Conditions | Source |
|---|---|---|---|---|
| Walking time in near darkness against ordinary light | +14.3 | % | healthy people of 70 to 90, 5 against 1000 lumens | R1011 [read] |

**Pick.** Speed falls by the log of the light from 1000 lux to 1 / 1.143 at 5 lux [derived], and no further darker [gap: darker conditions untested] (was light.ts moveRate, 0.55 + 0.7 times the brightness).

### 6i. Carrying

| Quantity | Value | Units | Conditions | Source |
|---|---|---|---|---|
| FM 21-18's loads | fighting load 30%, approach march load 45% of body mass | - | soldiers | R1012 [read, abstract and as quoted] |
| Random close packing | 0.64 | - | equal spheres | R1013 [ex] |

**Pick.**
- A stack's mass is its dry mass and its water (fuel.ts stackPhys, wetness.ts); its bulk its dry stuff at its own density and its water at water's.
- Anyone carries, with what they wear, up to 45% of their body's mass (body.ts frame): a grown body 27.8 kg, a five-year-old 8.2 kg (was 16 stacks for anyone a year old or more, 8 for a child).
- Bulk: an armful, a bundle as round as both arms and the shoulders' width close round it (girth 1.139 of stature) and as long as the shoulders are wide [derived], 0.13 m3 for a grown body; and whatever hollow thing they hold holds the most a wall of its own area closes round, a sphere's, its area its mass over its wall's density and thickness [derived]; everything at 0.64 packing [analogue]. Whether a thing is hollow is still its kind's container prop [gap: a made thing's shape is not kept]. A bag sewn from a 2 kg hide holds 0.18 m3, a basket woven of three bundles of fibre 8 l.
- Too full for something more, they set down what they can spare for it, as before (physics.ts makeRoom), as many times as it takes; what they could never hold goes down beside them.
- The planner (plan.ts) weighs what a plan would put in their hands by mass against what they can carry (was 24 of each kind).
- Their hands count as full for laying food by or sharing it at 12 and 10 sixteenths of what they can carry by mass or bulk (was 12 and 10 stacks) [design: the old shares].

### 6j. Routes and obstacles

**Pick.**
- The way across tiles is the least time a grown, unladen walker takes (A*, each leg from tile middle to tile middle at Tobler's speed on the slope between them and the slowing of the two tiles' mean coefficient, worn by their paths and under the day's snow) (was the fewest tiles). A tile's ground is the mean of its four cells' classes. Within a tile they walk straight, at their own speed, looked at every 2 m [design] for what's solid in the way.
- What no one walks through stands at its own size (gait.ts radiusOf, as reach has it): trees by their trunks (was 0.35 m), stumps by their girth (0.3), boulders and buildings by their width, a well or pit by its mouth (0.75), a fire by its heap (0.45). What's in the way is looked up within 20 m and again every 12 m walked [design].
- What stands on a spot for digging and planting (physics.ts occupied) is the same footprint (was a table: tree 0.5 m, stump 0.4, sapling 0.15, fallen log 0.5, fire, pit, trap and well 0.8); a fallen log the round it could lie across [gap: which way a log lies is not kept].

### 6k. Checks

| | Value |
|---|---|
| Grown walker, level, blacktop | 1.40 m/s (Tobler) |
| Three- and eight-year-olds, level | 1.04 and 1.21 m/s |
| Grown walker up 10%, down 5%, up 30% | 0.99, 1.67, 0.49 m/s |
| On light brush, heavy brush, swamp, sand | 1.28, 1.14, 1.04, 0.97 m/s |
| Walking cost level at 1.34 m/s, 70 kg, treadmill | 293.5 W (Pandolf) |

### 6l. Pending the tick cutover

Speeds are real now and a tick still lasts 300 s, so a grown walker goes some 400 m a tick (was 2) and runs some 950 m, while fauna.ts's animals still move their old metres a tick: people outrun deer and wolves many times over and any errand within a few hundred metres is done in a tick. The operator's cutover to a short tick (Main, 2026-10-16) is what brings the two together; nothing here is tuned against it.

### 6m. Gaps

- The path wear count is ecology.ts's dice; how many passes turn a cover to a dirt road's coefficient is not wired.
- Terrain coefficients are applied to running as to walking (Lejeune et al.'s sand costs running 1.6 times, walking 2.1 to 2.7).
- No VO2max under twenty; infants walk as their stature has it (nobody carries them).
- Deeper than the breastbone people wade on rather than swim; darker than near darkness they walk no slower.
- Bulk ignores that loose things spill from arms; a made thing's shape (and so whether and how much it holds) is a prop's.
- A fallen log's lie; the half metre beyond an animal's middle within which it is struck [design].
- The planner weighs mass only, not bulk; kinds of no known matter weigh nothing to it.

### References

- R1000 Tobler W. (1993), Three presentations on geographical analysis and modeling: non-isotropic geographic modeling, NCGIA Technical Report 93-1. https://escholarship.org/content/qt05r820mz/qt05r820mz_noSplash_8f1f13a718ba4a0db0079773ffa4a7af.pdf (read 2026-10-16)
- R1002 Alexander R.McN., Jayes A.S. (1983), A dynamic similarity hypothesis for the gaits of quadrupedal mammals, J. Zool. 201:135-152; as Kramer P.A., Sylvester A.D. (2013), Humans, geometric similarity and the Froude number, Biol. Open 2:111-120, use it. https://pmc.ncbi.nlm.nih.gov/articles/PMC3575646 (read 2026-10-16)
- R1003 Richmond P.W., Potter A.W., Santee W.R. (2015), Terrain factors for predicting walking and load carriage energy costs: review and refinement, J. Sport Hum. Perf. 3(3):1-26 (Soule R.G., Goldman R.F. 1972, Terrain coefficients for energy cost prediction, J. Appl. Physiol. 32:706-708; Lejeune et al. 1998). https://jhp-ojs-tamucc.tdl.org/jhp/article/download/67/pdf_17 (read 2026-10-16)
- R1004 Richmond P.W., Potter A.W., Looney D.P., Santee W.R. (2019), Terrain coefficients for predicting energy costs of walking over snow, Appl. Ergon. 74:48-54. https://erdc-library.erdc.dren.mil/items/81737b24-aaa1-44e4-a454-5e6115653526 (abstract read 2026-10-16)
- R1005 Pandolf K.B., Givoni B., Goldman R.F. (1977), Predicting energy expenditure with loads while standing or walking very slowly, J. Appl. Physiol. 43:577-581.
- R1006 Ivaniski-Mello A., Minetti A.E., Martinez F.G., Peyré-Tartaruga L.A. et al. (2025), An in-depth look at shallow-water walking, Pflügers Arch., doi:10.1007/s00424-025-03130-3. https://pmc.ncbi.nlm.nih.gov/articles/PMC12698785 (read 2026-10-16)
- R1007 Santee W.R., Allison W.F., Blanchard L.A., Small M.G. (2001), A proposed model for load carriage on sloped terrain, Aviat. Space Environ. Med. 72:562-566; the correction factor as R1003 eq. 7 gives it.
- R1008 Minetti A.E., Moia C., Roi G.S., Susta D., Ferretti G. (2002), Energy cost of walking and running at extreme uphill and downhill slopes, J. Appl. Physiol. 93:1039-1046. http://runscribe.com/wp-content/uploads/power/Minetti2002.pdf (read 2026-10-16)
- R1009 Kaminsky L.A., Arena R., Myers J. (2015), Reference standards for cardiorespiratory fitness measured with cardiopulmonary exercise testing: data from FRIEND, Mayo Clin. Proc. 90:1515-1523. https://pmc.ncbi.nlm.nih.gov/articles/PMC4919021 (read 2026-10-16)
- R1010 Jetté M., Sidney K., Blümchen G. (1990), Metabolic equivalents (METs) in exercise testing, prescription, and evaluation of functional capacity, Clin. Cardiol. 13:555-565 [ex].
- R1011 Kesler A., Leibovich G., Herman T., Gruendlinger L., Giladi N., Hausdorff J.M. (2005), Shedding light on walking in the dark, J. NeuroEng. Rehabil. 2:27. https://pmc.ncbi.nlm.nih.gov/articles/PMC1236955 (read 2026-10-16)
- R1012 Knapik J.J., Reynolds K.L., Harman E. (2004), Soldier load carriage: historical, physiological, biomechanical, and medical aspects, Mil. Med. 169:45-56 (FM 21-18, 1990). https://pubmed.ncbi.nlm.nih.gov/14964502 (abstract read 2026-10-16; the 30 and 45% as the load literature quotes FM 21-18)
- R1013 Scott G.D., Kilgour D.M. (1969), The density of random close packing of spheres, J. Phys. D 2:863-866 [ex].

## 7. Work (R1150-R1199)

Code: src/sim/work.ts (new: the reference power, practice, the acts with no measured work, digging), body.ts workWatts and awake (vo2max, REST_O2 and O2_J moved there from gait.ts), sim.ts doAct, lit, stroke, labour, lend, run's gathering and assist, metOf and finishAct, physics.ts rubbing's work and rubTick, pitWork, digShare and digTick, strikeTick's old reckoning (RECKONED_S, MARK_S), heating's, dipping's and placing's seconds, plan.ts GATHER and the planner's costs (STEP_M), gait.ts LEVEL_WALK, formulas.ts Prediction.secs, beliefs.ts Belief.secs, world.ts Step's work, got, want and dim and VERSION 31, and scripts/truth.ts, answer-key.ts, theory-report.ts, probes.ts and evals.ts in seconds (evals' VERSION probes 9, worlds 8, live 8). Every act with a duration is work, J, delivered at a power, W; its time is its work over its power. Ticks come in only as the seconds a tick holds (ticks.ts TICK_S).

### 7a. Constants

| Quantity | Value | Units | Conditions | Source |
|---|---|---|---|---|
| Acceptable energy expenditure through an eight-hour shift | 33% of VO2max | - | Bonjer; still accepted by work physiologists | R1150 [read, as quoted] |
| Physical performance after sleep loss | -7.56% (95% CI -11.9 to -3.13); about -0.4% for each hour awake before the task | - | 227 outcomes in 69 publications, deprivation and late restriction | R1151 [read, abstract] |
| The learning curve | each doubling of the units done takes 80% of the time (slope -0.322); assembling 75%, welding 85%, machining 95% | - | | R1152 [read, as tabulated] |
| Excavation by hand, recommended | soft 5.0, medium 3.5, hard 3.0, very hard 2.0, rock 0.8 (country medians 5.0, 3.5, 2.75, 2.0, 0.75) | m3 in place a worker-day | an eight-hour day, the right hand tools, well organised; blunt or worn tools up to 25% less, poor tools half | R1153 Tables 10, 20 [read] |
| ILO's soil classes | soft, medium, hard, very hard: BS 5930's soft, firm, stiff and very stiff cohesive soils | - | | R1153 Table 2 [read] |
| Undrained shear strength by consistency | very soft under 20, soft 20 to 40, firm 40 to 75, stiff 75 to 150, very stiff over 150 (hard over 300) | kPa | BS 5930:1999 | R1154 [read, as charted] |
| VO2max, one MET, oxygen | FRIEND's 42.8 ml/kg/min falling 9.75% a decade; 3.5 ml/kg/min; 20.9 J/ml | | | R1009, R1010, R1008 (sec. 6) |
| The arms' net efficiency | 13.5% (arm cranking's 10 to 17%) | - | | matter-constants sec. 1 (mechanics.ts NET_EFF) |
| Picking rates as picked | blackberries by hand 5.1; wild grass seed stripped by hand and cleaned 1 | kg/h | | body-constants sec. 10 |

### 7b. Power

**Pick.** What a body keeps up through a working day is Bonjer's 33% of its VO2max less resting, for its mass: (0.33 VO2max(age) - 3.5) ml/kg/min at 20.9 J/ml, W of metabolism above resting [derived], less 0.4% for every hour they have been awake (R1151), the hours read off Borbely's pressure S as the waking it takes S to climb from the lower threshold, 0.17, to where it stands [derived] (body.ts workWatts, awake). What goes into the work is that at the arms' net efficiency, 13.5% [analogue: arm cranking for all handwork] (work.ts powerOf). A rested grown body (18, 61.7 kg) spends 228 W above resting at it, 4.1 MET over Schofield's 73 W, and puts 30.8 W into the work: the reference power every act's work is reckoned against (work.ts REF_W). At 30 a body puts in 0.93 of that, at 45 0.75, at 60 0.60, at 70 0.51; a child of seven 0.38, of three 0.23 (VO2max held at the twenties', sec. 6g [gap]); after 16.8 hours awake (S at 0.67) 0.93. The rule audit's uncited 75 to 100 W is not used.

### 7c. Practice

**Pick.** Wright's 80% curve (R1152): a practised hand puts (n + 1)^0.322 of a first try's power into the work, n the times they have done it before, counted as the 5 xp a success brings (sim.ts gain) up to a skill's top level, 1000 xp [design] (work.ts practised): 1.25 after one, 2.16 after ten, 3.55 after fifty, 5.51 at the top (was a tenth faster a level, twice as fast at level 10). Cutting keeps Putz's tenth fewer blows a level (matter-constants sec. 3) and a blow's force its own 0.04 a level (physics.ts force).

### 7d. Light

**Pick.** Work goes at light.ts workRate's share of its pace in poor light (0.15 + 1.1 of the brightness, between 0.2 and 1) [design: the old odds of not fumbling, as a share]: an act that is work gets that share of their power, and an act that goes stroke by stroke (striking, rubbing, throwing) gets a tick's strokes each time the shares carried from tick to tick come to one (sim.ts lit, stroke) (was: a tick's work lost on a coin flip). A fight is quick and close and eating needs no light. Walking keeps darkPace (sec. 6h).

### 7e. What each act takes

**Pick.**
- Digging: a m3 of ground of shear strength tau takes a working day at the reference power over what ILO's norm has a worker dig of it in a day, the norms set at the middles of BS 5930's classes ILO names its soils by (30, 57.5, 112.5 and 225 kPa) and a straight line between them [derived], and its weight raised from its mean depth, at clay's 1608 kg/m3 [analogue] [derived] (work.ts digWork). The island's ground is firm, 57.5 kPa [gap: no shear strength by spot]: 254 kJ a m3. A pit 1.5 m across and 2 m deep (sec. 8g), 3.53 m3 lifted from 1 m, takes 952 kJ, 8.6 hours of a rested grown novice with a proper tool (physics.ts pitWork) (was 3600 s at the tool's power, about an hour). The share of their power a tool puts into the ground is the old digging power, at most 1 [design] (physics.ts digShare): bare hands 0.15, 57 hours.
- Clay: a lump as dug (0.2 kg dry with its 27.5% water, 0.18 l) is that much firm ground lifted from half a spade's depth, 0.1 m: 46 J, 1.5 s. A deposit holds the lumps a disc as wide as it is and a spade's depth deep holds (physics.ts PIT_SOIL, 0.2 m) [design: how deep a deposit goes], 875 in a deposit a metre across, and is gone when they are (was two lumps a gathering and a deposit gone on a 25% roll).
- Gathering: food with a measured picking rate takes the reference power over the rate for each one as found [derived]: a portion of berries 176 s, a handful of grass seed 180 s, four of each set out for in a gathering (PICK, 750 s at the rate [design]). Anything with no measured rate takes 750 s of work at the reference power a gathering [derived; gap]: a mushroom, a herb, a handful of acorns, a stick, a stone or a bead of resin each 750 s, a handful of reeds' fibre 375 s of two. What comes away is what is there: as many as the gathering set out to pick, or as many as the bush's ripe portions, the acorns under an oak, a grass tuft's stripping, the beads of resin, the reed bed's hit points (1.5 a handful [design: the old 3 for two]) or the deposit's lumps if fewer, one each time its work is put in (was a fixed 2.5-tick quantum and fixed yields).
- Joining, heating, wetting, shaping, placing, planting, pouring and wearing; fat rubbed into a hide, grinding, rubbing to a point and rubbing to nothing; and any other act: what each took a novice in full light at five minutes a tick, at the reference power [derived; gap: each act's own physics]: join and heat 74 kJ (2400 s), wet 92.5 kJ, shape 55.5 kJ, place and plant 27.7 kJ, pour and wear 18.5 kJ, leather and a point 92.5 kJ, grinding 111 kJ, nothing 55.5 kJ, anything else 37 kJ (work.ts ACT_WORK, OTHER_WORK, physics.ts rubbing).
- Reeds struck, which go by the old reckoning of hit points, lose a strike's damage for each 300 s of work put in at the reference power [derived; gap] (physics.ts RECKONED_S).
- Cutting, splitting, flaking, breaking boulders, drawing copper out, striking sparks, throwing and friction fire go blow by blow and stroke by stroke at their cadence and their energies (matter-constants), as before; a blow's energy is already what the body keeps up at chopping (mechanics.ts blowEnergy).

### 7f. Helpers and the body

**Pick.** A helper's power goes into whatever the other is at that is work, a novice's in the light they have [design: a helper's own practice at what another does is not known] (sim.ts lend): two finish in half the time (was one tick's progress a tick). What an act's work costs, its joules over the arms' efficiency, goes into the body on top of resting for the seconds they work, as walking's does (sim.ts labour, metOf); the rest of the body's run goes at the activity's MET.

### 7g. Time

**Pick.**
- The planner's costs are seconds (plan.ts): a trip its 15 m steps at a grown walker's 1.28 m/s on level grass (gait.ts LEVEL_WALK); a way they know, what it has taken them (Belief.secs) over its odds; a gathering its work at the reference power; and what has no time of its own (putting away, taking out, eating, resting, warming up, meeting someone, hunting, and each op's start) in units of four steps' walk, 47 s, as it was weighed against walking [design: the old costs] (was a join's time the unit of an act's cost, against 60 m of walking).
- The look-ahead to an act's end (sim.ts conditionsNow), the answer key (formulas.ts Prediction.secs, scripts/truth.ts, with poor light as its share of pace) and the seconds a fire's heat, a dip and a feed are reckoned over (physics.ts) take an act's work over the reference power.
- A belief keeps the seconds a way has taken them (Belief.secs, was ticks); world.ts VERSION 31 starts a new world.

### 7h. Checks

| | Value |
|---|---|
| Reference power, rested grown body | 30.8 W of work, 228 W above resting, 4.1 MET |
| A join, a rested grown novice in full light | 2400 s; after fifty tries 3.55 times the power |
| A pit, the same with a proper tool | 30,890 s (8.6 h); ILO's medium 3.5 m3 a day gives 8.1 h for its 3.53 m3, the lift 6% on top |
| Two lumps of clay | 3 s |
| Four portions of berries, four handfuls of seed | 706 s, 720 s |
| plan.test.ts | a join takes its work over the doer's power, a practised hand's by Wright's curve, a child's longer, a helper's added; a pit its ILO work over the digger's power at the tool's share |
| formulas.test.ts | the answer key's seconds for planting and digging are the work the act needs over the reference power |

### 7i. Gaps

- The acts with no measured work are their old durations at the reference power; sewing, scraping, joining and fire-hardening have no mechanics of their own, and acorns, mushrooms, herbs, sticks, stones, reeds and resin no measured collecting rate.
- No shear strength by spot: all ground is firm, at clay's density; the lift is added on top of ILO's norms, which include throwing the spoil out; a clay deposit's depth is a design.
- A bush loses 3 hit points a picking and a grass tuft 1 a stripping [design]: what a plant loses should be the biomass taken off it.
- Fatigue is the hours awake only, not the work done since waking or glycogen spent; children's VO2max is the twenties'.
- Practice counts a try as 5 xp, so a gathering's 2 xp is two fifths of one; a helper adds a novice's power, and strikes and throws are not helped.
- The heat of a fire held in, a dip and a feed are reckoned over the act's reference seconds, not the time this doer takes.

### References

- R1150 Bonjer F.H. (1962), Actual energy expenditure in relation to the physical working capacity, Ergonomics 5:29-31; the 33% for an eight-hour shift as Bagherifard F., Daneshmandi H., Ziaei M. et al. (2022), Comparison of physical workload and physical work capacity among municipality cleaners in Shiraz, BMC Sports Sci. Med. Rehabil. 14:85, give it. https://link.springer.com/article/10.1186/s13102-022-00476-4 (read 2026-10-17)
- R1151 Craven J., McCartney D., Desbrow B., Sabapathy S., Bellinger P., Roberts L., Irwin C. (2022), Effects of acute sleep loss on physical performance: a systematic and meta-analytical review, Sports Med. 52:2669-2690. https://pubmed.ncbi.nlm.nih.gov/35708888 (abstract read 2026-10-17)
- R1152 Wright T.P. (1936), Factors affecting the cost of airplanes, J. Aeronaut. Sci. 3:122-128; the curve's slopes by kind of work as Kender's lecture on learning curves (Wright State University, HFE 307) tabulates them. http://cecs.wright.edu/~dkender/hfe307/lect9d.pdf (read 2026-10-17)
- R1153 Stiedl D. (1998), Productivity norms for labour-based construction, ILO ASIST Technical Brief No. 2, Tables 2, 9, 10 and 20 and sec. 4.3. https://www.ilo.org/sites/default/files/wcmsp5/groups/public/@ed_emp/@emp_policy/@invest/documents/instructionalmaterial/wcms_asist_6655.pdf (read 2026-10-17)
- R1154 BS 5930:1999, Code of practice for site investigations, the strength of clays as Groundforce's soils description chart gives it. https://www.vpgroundforce.com/Groundforce/media/Groundforce/Files/GF-Soil-Description-Chart.pdf (read 2026-10-17)

## 8. Shelters (R1100-R1149)

R1100 is plant-constants' (Meuriot 2018), so this section's own run from R1101. Code: src/sim/shelter.ts (new: what a shelter's pieces make of it, the air inside it, a fire's ring and lid, a pit's cover and depth, the leaps), physics.ts shelterOf, placing's ring, heap, feeding, trap and build branches, place, fireKind, gainOf; wetness.ts sheltered and rainUnder; sim.ts shelterAir, goIn, shelterWork, rest and warm_up, THING_PLACES forge; ecology.ts trapped and the structures' weather; animals.ts caught and PERCH; migrate.ts shelters; formulas.ts staged; inspect.ts, brain.ts and beliefs.ts words; light.ts CHI_R exported; world.ts Shelter, Thing.lid and Thing.holds.

### 8a. Constants

| Quantity | Value | Units | Conditions | Source |
|---|---|---|---|---|
| Thatch's least pitch | 45 (standard 50 to 55) | deg | reed thatch | R1101 [read] |
| Thatch as laid | 150 | kg/m3 | in the coat, ventilated | R1101 [read] |
| Thatch's conductivity | 0.07 (dry 0.04, wet 0.1) | W/mK | reed board of 250 kg/m3, at its average damp | R1101 [read] |
| Thatch deep enough to keep the rain out | 0.30 | m | the West's standard coat, 28 to 30 cm (Irbis lays 35) | R1101 [read] |
| Rafters apart under thatch | 1 at most | m | thatch of 45 to 75 kg/m2 | R1101 [read] |
| Wood's modulus of rupture, green | 109,600 G^1.01 softwood, 118,700 G^1.16 hardwood | kPa | | R317 (matter-constants sec. 2) [read] |
| Drag | sphere 0.47, disk 1.17 | - | subcritical | R1034 (sec. 9) [sec] |
| Friction, wood on wood | 0.25 | - | | matter-constants MU_WOOD [analogue] |
| A heap's solid share | 0.1 | - | a fire's heap | fire-constants sec. 17 [analogue] |
| A sleeper's floor | stature x 0.259 stature: 0.745 for the grown 1.696 m | m2 | lying on their back | R1062 shares (sec. 12) [derived] |
| Covered living space | 3.5, 4.5 in cold climates | m2 a person | humanitarian minimum to live in | R1103 [read, search excerpt]; not used, see 8b |
| The least fence a kind clears | red deer 1.8 to 2.0, fallow 1.5, roe 1.2 to 1.5, rabbit 0.9 | m | the Forestry Commission's minimum heights | R1102 Table 4 [read] |
| Trapping pits | up to about 2 m deep, 4 to 7 m across, narrowing to a slot | m | elk, reindeer and wolves | R451 (time-constants sec. 7) [read] |
| Films on a wall | hc(u) = max(3.4, 10.4 u^0.56) and 4 x 0.95 sigma T^3 | W/m2K | still air inside, the wind outside | body-constants sec. 5 |
| A fire's radiant share | 0.3 | - | | fire-constants sec. 7 (light.ts CHI_R) |
| A pole, a sheet | at least 10, at least 100 times as long as thick | - | | [design: where a piece stops leaning as a rafter, or lies flat over one] |
| A pit's mouth | 1.5 | m | | [design] |

### 8b. What the pieces make

Each piece laid into a shelter is a pole (wood at least ten times as long as it is thick), a sheet (anything else at least a hundred times as long, as a round piece of its mass would be, as it is thick: hide, leather, bark), thatch (fine plant stuff: fibre, fern, grass) or a solid (stone, logs, clay, blocks). The poles lean together at thatch's least pitch, 45 degrees, into a cone whose slant L is the third longest pole: three set it up and the rest lean on them. Its floor is a circle of radius L cos 45, its roof a cone of area pi r L. The solids stand as a wall round its foot, as high as their volume over the ring's length and their mean thickness, if that closes at least one course round it. The sheets cover their own area of the roof, the thatch its volume over 0.30 m, but only where rafters stand within a metre of each other at the eaves (R1101). The share of the roof they close is its cover.

How many it sleeps is the floor under that cover over a sleeper's floor, the body's own footprint lying down; Sphere's 3.5 to 4.5 m2 a person is what people live in, not what one sleeps on. With three poles that carry the cover over at least one sleeper's floor it is a lean-to (the cover closes part of the roof), a hut (all of it) or a cabin (all of it, on walls); short of that it is a heap, as wide as a half sphere holding its solid at a heap's packing.

### 8c. Heat

The air inside (insideAir) comes to the outside air's plus the heat given off inside over what the roof and walls lose for each degree: the closed share of the roof through still air's film inside, its layers (each piece's volume spread over the closed roof, over its conductivity; thatch at 0.07 W/mK and its laid volume) and the wind's film outside; the open share through the two films only; the walls through their thickness over their stone's or wood's conductivity. The heat given off inside is what the skins of the people on its floor gave off the tick before (body.ts dry) and the radiant share of what any fire on its floor gives off, the rest taken to go up through the smoke hole [design]. body.ts takes that air as the air and the radiant temperature of whoever is on the floor. Someone at home goes in onto the floor to rest or warm up, each of the household at their own place halfway out from its middle [design].

### 8d. Rain and who is under the roof

Under a roof is on its floor, within r of its middle (sheltered): no wind there and no sun. The rain on a point (rainUnder) is what reaches the ground there (rain.ts) less what roofs keep off: a drop's slanting path traced back up into the wind (rain.ts drift, at the drop's fall speed) that passes through a roof's cone or its walls brings only the share of the rain the roof's cover leaves open. So the lee of a hut is dry in a wind and the floor of a half-covered lean-to gets half the rain.

### 8e. Strength

A rafter breaks under 8 MOR S / L spread along it, S = pi d^3 / 32, MOR the Wood Handbook's green modulus of rupture for its wood's density. A shelter's rafters together carry its cover's weight across them (its weight times cos 45); what they carry beyond that against the wind's push on its profile (1/2 rho u^2 x 0.47 x r times its rise, and 2r times its walls' height), and its whole weight about its downwind foot against that push tipping it at the height it acts at, set the wind it stands up to: the less of the two. A heap holds until the wind slides its stoutest piece broadside along the ground (disk drag on d x L against 0.25 of its weight). A structure falls apart in a wind at its point (air.ts headWind) stronger than that; nothing tops it up and it keeps no hit points.

### 8f. Fire setups

Stone laid round a fire stands side by side as wide as each piece (fire-constants sec. 29g); the ring holds the fire in, a hearth, once its stone reaches round the bed's rim (2 pi times combustion.ts radius), the wind then reaching what lies below its top only as its lee lets it (sec. 29a). Stone or clay laid on a ringed fire lies over its mouth, a stone as a disc its thickness across, clay as a layer its own thickness deep [design]; once that covers the ring's mouth (its width squared over 4 pi) the fire is closed in, a kiln, and smoulders (sec. 29e). A ringed fire, fed or not, is a forge when it holds 1 cm of copper at red heat where it sits (redHot, setIn), whatever burns in it; feeding it is judged by the bed it comes to.

### 8g. Pits and traps

A pit is dug 2 m deep, as the trapping pits were (R451); its mouth is 1.5 m across [design]. Wood laid across it at least as long as its mouth spans it: each piece breaks at its middle under 4 MOR S / mouth, and the cover holds their sum (coverHolds); anything else laid on it carries nothing, and wood too short to reach across covers nothing. An animal or a person heavier than that falls through. An animal that can leap the pit's depth (LEAP: the least fence that keeps its kind in, R1102) leaps out and leaves the pit open; anything that can't stays there (time-constants sec. 7).

### 8h. Checks

- Three one-metre sticks and two hides (3.0 m2 of hide over a 2.2 m2 cone): a hut 1.4 m across that sleeps two.
- Six 2.5 m poles and three hides: a lean-to 3.5 m across, its roof a third closed, sleeping four, standing to 19 m/s; one sleeper's 80 W warms its air 1.5 K on a still night at freezing, the open share losing almost all of it. Thirty pieces of bark close a quarter of the same roof.
- Ten sticks and six handfuls of fibre, the old 2.2 m lean-to: a heap 0.6 m across. Six handfuls of fibre at 150 kg/m3 and 0.30 m deep close 27 cm2; three hundred fronds of fern close 1.7% of a 3 m cone's roof.
- Six logs walled round the three-stick hut: a course 0.18 m high, a cabin, harder for the wind to tip.
- Three 2 m sticks of generic wood (G 0.45, 25 mm) across a 1.5 m pit: each breaks under 200 N at its middle, 600 N in all; a red deer's 1,138 N falls through and its 1.8 m leap does not clear 2 m; a rabbit's 16 N does not break them.

### 8i. What replaced what

- shelterOf's hand-weighted cover, insulation and sturdiness scores, the tier ladder over piece counts (3, 6, 10, 12, 16) and rooms by tier: the cone, walls and cover the pieces make, its form read off them, and the sleepers its covered floor holds.
- WIDTH's 1.2, 2.2, 3 and 4.5 m by tier and 1.6 m more a sleeper for a lodge: the floor's own width; a fire ring as wide as its stone is laid round.
- Hit points of 100 topped up 20 a load, worn down by a pile rate and a weather rate by sturdiness: the wind each structure stands up to.
- A roof sheltering anyone within 4 m of a lean-to or better: the floor under the roof, and the roof's rain shadow along the rain's slant.
- The dome as wide as the tier's width with every part's solid spread over it: the cone's roof and walls, closed and open, with thatch at its laid density and conductivity, and fires on the floor.
- A hearth at 3 stones and a kiln at 6 or any clay: a ring that reaches round the bed and a heap that covers its mouth.
- A forge as a ringed fire fed anything burning above 1.2 (fuel ?? 20), counted as charcoal: a ringed fire that holds copper at red heat.
- A trap as two or more long or fibrous things over a pit: wood that spans it, holding what it breaks under; the pit's 1.5 m depth (design) is 2 m (R451); what falls in stays if it can't leap out.
- A trap catching any person not in the know: anyone heavier than the cover holds.
- A home's mending at 70% of its hit points: its roof still letting the rain in. The gain words "sturdier", "warmer" and "better at keeping the rain off" by a 0.03 score: standing a gale now (GALE), or a degree warmer for one resting in it at freezing [design], the roof's closing told by its form and its room.
- Perches on a structure at 0.5, 1.8, 2.5 or 3.2 m by tier: its own top.

### 8j. Gaps

- Every shelter is a cone at the least pitch; a ridge lean-to's geometry, and which way its open side faces, are not kept: the floor of a part-covered one is taken out of the wind like a closed one's.
- Air leaking through the cover and loss through the floor are left out; wet thatch's 0.1 W/mK and weight, rain held in the cover, and snow on a roof are not followed.
- Members do not rot, so a shelter stands until a wind beats it; pegs and lashings are not modelled, only the weight holds a hut down; what blows off a heap is not taken from it.
- The low edge of a cone counts as floor.
- Fibre, fern and grass thatch need 45 kg of it to each m2 of roof (R1101): a hand-gathered roof of them is out of reach, and hides and bark are what closes one. The planner still reaches for what people learnt worked before.
- Wolves and foxes take the red deer's 1.8 m leap (no fence height for them was found); a fence's height is what an animal clears with a run, more than it could from a pit's floor. A pit's narrowing slot is not modelled; rabbits and foxes could dig out (time-constants sec. 7).
- How stone and clay lie on a ring's mouth [design]; a hearth is judged against the bed as it is when the stone goes down.
- The fall into a pit still costs a person 10 health (substrate 1); digging one is work (sec. 7).
- What a shelter looks built of, the renderer's style, is still read off props [design]; moving home still compares forms and the 60 m and 150 m distances.

### References (8)

- R1101 Irbis Thatching, Thatch: design guidelines for architects (thermal conductivity of reed thatch, the coat's density and depth, pitch, rafter spacing and weight). http://thatching.pl/information/for-architect.html (read 2026-10-16)
- R1102 Trout R.C., Pepper H.W. (2006), Forest fencing, Forestry Commission Technical Guide FCTG002, Table 4 (minimum fence heights) and Figure 13. https://cdn.forestresearch.gov.uk/2006/03/fctg002.pdf (read 2026-10-16)
- R1103 The Sphere standards' covered living area, 3.5 m2 a person in hot climates and 4.5 in cold, as UNHCR's Shelter and Sustainability overview (2021) gives it. https://emergency.unhcr.org/sites/default/files/2024-01/UNHCR%20shelter%20and%20sustainability%20overview%20April%202021.pdf (search excerpt read 2026-10-16)

## 9. Throwing, hunting and fishing (R1030-R1059)

Code: src/sim/hunt.ts (new: the body aimed at, the carcass, the missile, the launch, the flight, the aim, the wound, the encounter of fish), physics.ts throwTick, throwReach, launchOf, strikeTick's animal branch, butcher, wetting and wet, waters.ts meeting and takeFish, formulas.ts's strike, throw and wet predictions, materials.ts THING_MATERIAL (animal rows gone), animals.ts carcass, plan.ts hunt, inspect.ts, sim.ts doAct throw and nofish.

### 9.1 The launch

| Quantity | Value | Units | Conditions | Source |
|---|---|---|---|---|
| Overarm throw, kinetic energy of the thrown mass | KE = A m / (m + B); A 94, 179, 99, 149, 121 J; 3B 0.90, 2.13, 1.53, 1.50, 1.74 kg | J, kg | five men of 62 to 82 kg, masses 0.057 to 3.4 kg | R1030 [read] |
| Throw speed, 3.4 kg brick and tennis ball | 8.5 and 19.5 m/s | m/s | Cross's David | R1030 [read] |
| Straight-ended self bow ('Klopsteg') | q 0.407 (stored energy over weight x draw), eta 0.765 (to the arrow) | - | Kooi's model, equal weight, draw and limb mass | R1032 [read] |
| Weight x draw over the mass of one limb | flatbow 180, Mary Rose longbow 230 | N m/kg | Hickman's flatbow, the Mary Rose replica | R1032 [read] |
| Heaviest bow drawn | 465 N at 0.746 m | N | Mary Rose longbow | R1032 [read] |
| Standard draw | 0.7112 m (28 in) | m | Kooi's table 3 | R1032 [read] |
| Shoulder (acromion) height | 0.818 of stature | - | Drillis and Contini | R1062 [ex] |
| Aimed shooting pace | 10 to 12 aimed arrows a minute | min^-1 | longbow | R1046 [UNVERIFIED] |

**Pick.** By hand KE = 128.4 m / (m + 0.52) J (the means of Cross's five throwers), by the thrower's lean mass against a grown body's, as mechanics.ts's blow [derived]. From a bow, eta q W D with W D = min(205 J/kg x half the bow's wood, 465 N x lean share x 0.7112 m x stature share) [derived]. Released at 0.818 of stature. One aimed throw every 60/11 s, a throw at the pace of a shot [design].

Checks [derived]: a tennis ball 21 m/s, a 0.8 kg Schöningen-like spear 13.9 m/s (Milks's javelin throwers released at 11.8 to 20.1, mean 15.9, R1031), the game's stone (2.6 kg granite) 9.1 m/s and 107 J, a sharp flake 21 m/s and 14.5 J, a stick hafted with a flint blade (0.29 kg) 17.8 m/s and 46 J. A bow strung on the game's stick (0.22 kg of wood) stores 22 J and gives 7 J: a stick is not a stave.

### 9.2 The flight

| Quantity | Value | Units | Conditions | Source |
|---|---|---|---|---|
| Fletched arrow drag | Cd 2.65 on the cross-section (turbulent; laminar 1.5 to 1.6) | - | A/C/E arrow 625 mm by 5.25 mm, 14.3 g, Re 2e4, 58 m/s from an archer | R1033 [read] |
| Sphere, flat disk | Cd 0.47, 1.17 | - | subcritical Re | R1034 [sec] |
| Air | 1.2 kg/m3, g 9.81 | | | fire-constants sec. 6 |

**Pick.** A shaft of wood at least 0.3 m long with an edge on it flies point first [design: physics.ts holdOf's long], its Cd 2.65 x (L/d) / (625/5.25) on its cross-section, its drag being skin friction [derived]; anything else tumbles as a sphere of its volume, Cd 0.47. The flight is integrated in 2 ms steps under gravity and quadratic drag; the throw taken is the flattest that reaches the chest at that distance, found by scanning elevation in half degrees from -45 and bisecting [derived]. A throw's reach is the farthest distance it still gets there. Checks: the stone reaches a deer's chest out to 8 m, the flake 39 m, the pebble 39 m, the hafted spear 32 m; Milks's spears lost no measurable speed over 5 to 25 m and the model's spear arrives at 17.9 from 17.8 m/s at 7.5 m, the release height above the chest giving back what drag takes.

### 9.3 The aim

| Quantity | Value | Units | Conditions | Source |
|---|---|---|---|---|
| Hits on a hay bale 105 x 50 cm lying on the ground | 58%, 25%, 25%, 17%, 0% at 5, 10, 15, 20, 25 m | - | six javelin throwers, 102 aimed throws of a 760 to 800 g spear | R1031 [read] |
| Hand-thrown spears' effective distance | 5 to 10 m (ethnographic review), 15 to 20 m skilled | m | | R1031 [read] |

**Pick.** The aim scatters as a normal spread of angle, the same across and up, 0.048 rad: the maximum-likelihood fit to Milks's hits (fitted 68, 29, 15, 9, 6%) [derived]. An animal on the run (state flee) moves across the line at Hirt's top speed for the flight's time. People stalk to the throw's reach before throwing (sim.ts doAct); the answer key takes a throw from 7.5 m, the middle of the ethnographic range, or the reach if less.

### 9.4 The body aimed at

| Quantity | Value | Units | Conditions | Source |
|---|---|---|---|---|
| Penetration to kill | about the middle of the chest cavity; 20 to 25 cm for large ungulates | m | after Friis-Hansen 1990 | R1035 [read] |
| Red deer | 116 kg (mean of stags and hinds), 1.07 to 1.37 m at the shoulder | | Britain | R304 [read] |
| Lungs, heart | total lung capacity 53.5 M^1.06 mL; heart 0.0058 M^0.98 kg | M kg | mammals | R1038 [UNVERIFIED] |
| Top running speed | 26 M^0.26 (1 - e^(-22 M^-0.6)) km/h | M kg | running animals, 474 species | R1039 [read]; h = 22 [UNVERIFIED: supplementary table 4] |

**Pick.** Every body is a red deer's scaled by mass to the third [derived: geometric similarity]: the depth to the chest's middle 0.225 m at 116 kg, the trunk a cylinder twice that across and as long as its mass at water's density makes it [design], the chest at the shoulder (1.22 m at 116 kg) less that depth. The vital zone is one sphere of the lungs' and heart's volume, aimed at in the middle of the silhouette [design]. The silhouette is the trunk as it stands to the thrower: broadside its length, end on its width. An animal's mass is its kind's at a full reserve less the fat it lacks (its object's reserve as its hunger reads it) [derived].

| Kind | kg | trunk across, long, m | vital zone, m | chest's middle, m | chest high, m | top speed, m/s |
|---|---|---|---|---|---|---|
| red deer | 116 | 0.45, 0.73 | 0.257 | 0.225 | 1.00 | 17.9 |
| wolf | 41.5 | 0.32, 0.52 | 0.179 | 0.160 | 0.71 | 17.2 |
| fox | 6 | 0.17, 0.27 | 0.091 | 0.084 | 0.37 | 11.5 |
| rabbit | 1.6 | 0.11, 0.18 | 0.057 | 0.054 | 0.24 | 8.2 |

The deer's vital zone of 26 cm stands beside the hunter's rule of thumb of 8 to 10 inches (not read).

### 9.5 The wound, a point

| Quantity | Value | Units | Conditions | Source |
|---|---|---|---|---|
| Fourteen chert points, 35.6 J each, into potter's clay | depth 14.4 to 22.8 cm against tip cross-sectional perimeter 41 to 100 mm | | compound bow at 1.8 m; clay compared with meat by Key et al. | R1035 [read] |
| Tip perimeter | TCSP = 4 sqrt((w/2)^2 + (t/2)^2) | mm | Hughes 1998 | R1035 [read] |

**Pick.** Depth = E / (110.8 + 1.475 TCSP) m, E in J, TCSP in mm: the least-squares line through Sitton's fourteen points' energy over depth [derived]. The point's width is its edge's length and its thickness the thickness of the part it is on (fuel.ts PHYS edge and d). A cutting point kills when it strikes the vital zone and reaches the chest's middle; otherwise it wounds. The hide's own cutting work (a few J against tens) is left out [derived].

Check: the hafted flint blade (TCSP 82.5 mm) drives 0.196 m on its 46 J: short of a red deer's 0.225, past a wolf's 0.160.

### 9.6 The wound, blunt

| Quantity | Value | Units | Conditions | Source |
|---|---|---|---|---|
| Blunt criterion | BC = ln(E / (W^(1/3) T D)), T = 0.7 W^(1/3) cm (men; 0.6 women) | E J, W kg, D cm | thoracic impacts, fitted on animal and cadaver tests | R1036 [ex] |
| BC to injury | AIS = 1.33 BC + 0.6 | | Bir and Viano | R1036 [ex] |
| Death by injury | AIS 3: 10%; AIS 4: up to 50% | | | R1037 [read] |

**Pick.** The blunt criterion with W the animal's mass, D the missile's (its volume's sphere tumbling, its blunt end in the hand); death at 0 below AIS 3, 0.1 at 3, 0.5 at 4, certain from 5 (AIS 5 is critical) [derived], straight between. A blow short of AIS 1 does nothing. Checks: the stone on a rabbit, AIS 3.5, 31% death; on a deer, AIS below 0. A deer is not brought down by stones; a rabbit is, one hit in three.

### 9.7 Blows in the hand

A blow at an animal within reach (strikeTick) lands where it is aimed, on the chest's middle [design], with mechanics.ts's blow energy for what is swung, through the tool's point or blunt end, by 9.5 and 9.6; a tick holds BLOWS of them. A hurt animal is the weaker for it: half itself [design], which makes a deer flee (animals.ts flees below 0.6).

### 9.8 What a carcass gives

**Pick.** By body-constants sec. 10's shares (R297 to R303) on the animal's kind's mass: meat the dressed carcass less bone and carcass fat, in cuts; bone the dressed carcass's bone share, in bones (fuel.ts PHYS.bone, 0.33 kg as found); fat the fat the animal carries now, its reserve, in lumps; and its skin as one hide of its own size: Meeh's area 0.1 M^(2/3) m2 (R1042 [sec]) at the deer hide's 3 mm (fire-constants sec. 27c) scaled by mass to the third [derived]. A deer at a full reserve: 89 cuts, 19 lumps of fat, 43 bones and a hide of 2.4 m2 and 3.1 kg dry; a wolf 32, 6, 15; a fox 5, 1, 2; a rabbit 1 cut and a hide of 43 g. The deer's and rabbit's shares are measured; the other kinds take a deer's [design]. (THING_MATERIAL's hand-written hides and bones, one or two a kind, are gone.)

### 9.9 Fishing

| Quantity | Value | Units | Conditions | Source |
|---|---|---|---|---|
| Encounter rate | 2 R s / A in the plane (Gerritsen and Strickler's gas model, in two dimensions) | s^-1 | | R1045 [sec] |
| Cruising speed | about 1 body length a second | | | R1043 [UNVERIFIED] |
| Reaction distance to a bait | about 2 body lengths | | drift-feeding grayling | R1044 [UNVERIFIED] |

**Pick.** The fish a gear can meet are the fish of the cell of water it is dipped in, which range over that cell's water in a day (the GPU moves them once a day) [derived]; the cell's water now is waters.ts's area. Each fish meets a line at 2 x (2 L) x L / A, L its length, and a basket at 2 r sqrt(u^2 + (L/s)^2) / A [derived], over the dip's seconds, a wetting's work over the reference power (sec. 7); its chance is 1 - e^(-rate t). A line brings up the first fish to bite, if any; a basket every fish it meets [design: none escape; a fish that meets the bait takes it]. A basket is a hemisphere of its own wall (mass over density and thickness), swept by the arms at chopping's kept power (mechanics.ts) against water's drag on its mouth, a disk's Cd 1.17 [derived]. Reach no longer comes from a table by gear: within the 75 m cell a line's length and an arm's reach decide nothing; the gear's physics decides its meeting radius and speed.

Checks [derived]: a basket of fibre is 0.10 m across the mouth, swept at 1.5 m/s; in a 75 m sea cell over 50 minutes a 20 cm perch comes to it 15% of the time, to a line 8%, a 40 cm one 16% and 29%.

### 9.10 What replaced what

- throwReach's 40 m bow or 20 m arm, a hit being anything within it: the flight of the missile from its launch to the animal's chest and the spread of the aim on the animal's own silhouette where it stands.
- throwDamage's eight coefficients and the animals' hp and toughness: a cutting point's depth against the chest's middle, a blunt blow by the blunt criterion.
- The miss landing a random 1 to 4 m short: where the flight comes down, short, past or wide.
- Throwing every third tick, six throws at most: one aimed throw every 5.5 s while the animal stands and they have something to throw.
- The struck deer fleeing and every other kind turning on the thrower by name: any struck animal bolts, and a hurt one is half itself (its own kind's flight then follows from animals.ts).
- THING_MATERIAL's carcass rows: the animal's mass by body-constants sec. 10's shares, its fat from its own reserve, its skin by its area.
- FISH_REACH's 15 m basket and 40 m line, a catch whenever a fish was within it, and a basket's second fish on a 0.4 + 0.05 x skill roll: each fish of the cell's encounter rate with the gear.

### 9.11 Gaps

- No measured spread of aim for a bow; it takes the thrown spear's. Skill does not narrow the spread.
- The bow's efficiency is Kooi's for his standard arrow; it does not fall for lighter arrows as it should (the limbs' virtual mass is not found).
- Clay stands in for flesh (Sitton): the hafted spear stops 3 cm short of a red deer's chest middle, so thrown spears of the game's stick never kill a deer; Milks's 0.8 kg spear at 107 J would reach 0.46 m.
- A point that misses the vital zone only wounds: bleeding to death from the gut or a leg is not modelled; wounds do not add up, and a wounded animal does not die of them later.
- The blunt criterion was fitted on human thoraces and their surrogates, here carried to every animal by its mass; head strikes are not told apart.
- Every body is a deer's scaled by mass, birds included; wading or perched birds are not deer-shaped.
- A wooden point ground on a harder stone ("pointed" kinds) carries no edge record (substrate 2), so it strikes blunt.
- A fish lifted out is one fish item whatever it weighs; the hook-up and landing of a bite, the fish's hunger and the water's clarity are not modelled; fish cannot be speared or thrown at.
- The lean body at a full reserve is taken as the kind's measured mass; young animals are full grown.
- The flight-time displacement is only across the line; an animal's motion along the line is left out.
- At today's five-minute tick a person throws up to 55 times in a tick at an animal that does not move between throws; pending the tick cutover.
- Gear still wears 0.03 a dip (substrate 2's wear).

### References (9)

- R1030 Cross R. (2004), Physics of overarm throwing, Am. J. Phys. 72:305-312, tables I to III, fig. 2. https://www.physics.sydney.edu.au/~cross/PUBLICATIONS/25.%20Throwing.pdf (read 2026-10-16)
- R1031 Milks A., Parker D., Pope M. (2019), External ballistics of Pleistocene hand-thrown spears: experimental performance data and implications for human evolution, Sci. Rep. 9:820, tables 1 and 2. https://pmc.ncbi.nlm.nih.gov/articles/PMC6347593/ (read 2026-10-16)
- R1032 Kooi B.W., Bergman C.A. (1997), An approach to the study of ancient archery using mathematical modelling, Antiquity 71:124-134, tables 1 and 3. http://www.bio.vu.nl/thb/users/kooi/kobe97.pdf (read 2026-10-16)
- R1033 Miyazaki T. et al. (2013), Aerodynamic properties of an archery arrow, Sports Eng. 16:43-54. https://archerycoachesguildblog2.wordpress.com/wp-content/uploads/2015/06/tl_arfd2.pdf (read 2026-10-16)
- R1034 Hoerner S.F. (1965), Fluid-Dynamic Drag: a sphere's 0.47 and a disk's 1.17 at subcritical Reynolds numbers, as the engineering tables give them [sec].
- R1035 Sitton J. et al. (2020), Tip cross-sectional geometry predicts the penetration depth of stone-tipped projectiles, Sci. Rep. 10:13289, table 1 and introduction. https://pmc.ncbi.nlm.nih.gov/articles/PMC7414020/ (read 2026-10-16)
- R1036 Sturdivan L.M., Viano D.C., Champion H.R. (2004), Analysis of injury criteria to assess chest and abdominal injury risks in blunt and ballistic impacts, J. Trauma 56:651-663; Bir C., Viano D.C. (2004), Design and injury assessment criteria for blunt ballistic impacts, J. Trauma 57:1218; both as la Cour-Harbo 2017 eqs. 1 and 8 give them [ex]. https://vbn.aau.dk/ws/files/270854922/1756829317691991.pdf
- R1037 la Cour-Harbo A. (2017), Mass threshold for 'harmless' drones, Int. J. Micro Air Vehicles 9:77-92 (AIS 3 and 4 fatality). https://vbn.aau.dk/ws/files/270854922/1756829317691991.pdf (read 2026-10-16)
- R1038 Stahl W.R. (1967), Scaling of respiratory variables in mammals, J. Appl. Physiol. 22:453-460 (lung capacity; heart mass) [UNVERIFIED: from memory, not read].
- R1039 Hirt M.R., Jetz W., Rall B.C., Brose U. (2017), A general scaling law reveals why the largest animals are not the fastest, Nat. Ecol. Evol. 1:1116-1122. https://pdodds.w3.uvm.edu/research/papers/others/2017/hirt2017a.pdf (read 2026-10-16; a 26, b 0.26, i -0.6 read; h from the supplement not reached)
- R1042 Meeh K. (1879), surface area 0.1 M^(2/3) m2 for mammals, as veterinary body-surface tables carry it [sec].
- R1043 Videler J.J. (1993), Fish Swimming, Chapman and Hall: cruising near a body length a second [UNVERIFIED].
- R1044 Hughes N.F., Dill L.M. (1990), The relationship between foraging mode and the reactive distance of drift-feeding Arctic grayling, Can. J. Fish. Aquat. Sci. 47:2039-2048 [UNVERIFIED: the two body lengths not read].
- R1045 Gerritsen J., Strickler J.R. (1977), Encounter probabilities and community structure in zooplankton: a mathematical model, J. Fish. Res. Board Can. 34:73-82 [sec].
- R1046 The aimed rate of a longbowman, ten to twelve a minute, as archery histories (Hardy, Longbow, 1992) give it [UNVERIFIED].


## 12. What touches the world from the mind (R1060-R1099)

Code: src/sim/senses.ts (new), brain.ts view, beliefs.ts watchers, see and sentence, groups.ts ruled, repay, speak, share and takeShared, physics.ts dayNeed, enough and stash, sim.ts's witnesses and its people loop, world.ts landing, space.ts anyOf.

### 12a. Sight

A thing is made out when a detail of it stands out from the ground round it by more than the eye's threshold for that detail's solid angle at the light the eye is adapted to. Which detail is asked about follows from the task: Johnson's criteria count the cycles across the thing's critical dimension one must resolve to notice it, to recognise it and to identify it.

| Quantity | Value | Units | Conditions | Source |
|---|---|---|---|---|
| Contrast threshold of a disc, Blackwell's table 8 | C = ((R/A)^q + C_inf^q)^(1/q); R = (sqrt(a1 B^-1/2 + a2 B^-1/4 + a3) + a4 B^-1/4 + a5)^2, a = 5.949e-8, -2.389e-7, 2.459e-7, 4.120e-4, -4.225e-4; C_inf = sqrt(b1 B^-1/2 + b2 B^-1/4 + b3) + b4 B^-1/4 + b5, b = 9.606e-6, -4.112e-5, 5.019e-5, 4.837e-3, -4.884e-3; q = 1.146 - 0.0885 log B above 3.40 cd/m2, 0.8861 + 0.4 log B from 0.193, 0.6 below | A sr, B cd/m2 | 50% forced-choice detection, 7 observers, 2850 K light; the whole range of B in one form (Crumey's hyperbolae); below 1e-5 cd/m2 the field counts as black | R1060 [read] |
| From the laboratory to plain seeing | x 2.4 | - | Blackwell and Blackwell 1971's "common-sense seeing"; 1.62 gives 90% forced-choice | R1060 [read, as Crumey quotes it] |
| Johnson's criteria | notice 1.0, recognise 4.0, identify 6.4 cycles across the critical dimension | cycles | 50% of observers; a cycle is two resolved details | R1061 [ex] |
| A standing person's projected area | f_p 0.35 of the radiating 0.73 of DuBois's skin area | - | Fanger, standing, low source | R90 [read], body-constants sec. 1 |
| Hand length | 0.108 of stature | - | Drillis and Contini's segment proportions | R1062 [ex] |
| Ground albedo | 0.23 | - | FAO-56 grass reference, the whole sun's spectrum | R221 [read] |
| Skin's short-wave absorptivity | 0.7 (reflects 0.3) | - | the whole sun's spectrum | R90 [read] |
| Air's extinction of contrast, Koschmieder 3.912 / V averaged over the hours | clear 0.2217, cloudy 0.3442, rain 0.7062, storm 0.7615 | per km | Hammer Odde 2015 to 2024 by the game's sky states; medians of V 27, 21, 9 and 6 km | R479 [derived], docs/research/isd/bornholm.py vis |
| Berry and flint nodule | 0.012 m, 0.08 m | m | fuel.ts PHYS's own sizes | body-constants sec. 10, matter-constants |

**Pick.**
- sees(eye, at, detail): the detail's contrast is STANDS_OUT = (0.3 - 0.23) / 0.23 = 0.30 of the ground's luminance there, 0.23 E / pi, thinned by exp(-sigma d) with sigma the sky's extinction; it is seen when that is at least 2.4 times Blackwell's threshold for a disc the detail's width across at distance d, times the luminance the eye is adapted to, the brighter of the ground round what it looks at and round itself [design], so one standing in firelight sees less into the dark [derived].
- Critical dimensions: a person the square root of their projected area (0.67 m for a grown 1.75 m, 64 kg person); what they hold a hand's length, 0.108 of stature; a thing its size (world.ts Thing.size); an animal the cube root of its mass over water's density [design: geometric similarity]; a butterfly its wings, 55 mm [gap: a peacock's span, general knowledge]. The detail asked about is the critical dimension over twice Johnson's cycles.
- Tasks: someone is noticed (people listed, the stranger spotted, the fallen, the collapsed); what they are doing is recognised (their status in view, witnesses of deeds: trapped, the last deer, tending, a burned home, bystanders to a meeting); what they hold is recognised in their hands (what they carry in view, taking from a home or the camp's store, sharing into it); a way of working is identified in their hands (learning by watching, beliefs.ts watchers); a thing is recognised at its size (what lies about in view, where to go in the dark, sim.ts ctxFor); berries on a bush and flint in a boulder are noticed at their own sizes. Facts seen about the world (beliefs.ts see) go to whoever awake recognises what showed it at its size: the tree struck, the person who fell through ice, the pit, the plant that came up, the person who fell sick, died or was born, the strip of bark at the stem's width, the burning thing.
- What a prompt calls nearby stays within 60 m [design: a person's surroundings as a prompt holds them; what of it they make out is sight's].

**Checks** [derived], open ground, clear sky, eye adapted to the ground's light, a person 0.69 m across (1.85 m2 of skin) and a hand 0.19 m (the farthest each is made out, m; senses.ts sightRange):

| Lux on the ground | person noticed | recognised | hand recognised | identified | 10 m tree recognised | pebble 3 cm recognised | berry noticed |
|---|---|---|---|---|---|---|---|
| 10,000 (day) | 904 | 244 | 68 | 43 | 2,676 | 11 | 17 |
| 1,000 | 745 | 198 | 55 | 35 | 2,274 | 9 | 14 |
| 100 | 565 | 148 | 41 | 26 | 1,788 | 7 | 11 |
| 3 (civil twilight's end) | 278 | 71 | 20 | 12 | 927 | 3 | 5 |
| 0.1 (full moon) | 60 | 15 | 4 | 3 | 214 | 1 | 1 |
| 0.001 (starlight) | 6 | 1 | 0 | 0 | 22 | 0 | 0 |

The radii they replace: 300 m to notice a person and see what they did (VISION and canSee 300), 30 m for what is in their hands and for witnessing a deed, 25 m to learn by watching, 60 m for things, 70 to 1,000 m for facts seen. By day the old ones sit between recognising and noticing; by night they shrank to a tenth, the physics to under a tenth.

### 12b. Hearing

| Quantity | Value | Units | Conditions | Source |
|---|---|---|---|---|
| Speech at 1 m, overall | normal 62.35, raised 68.34, loud 74.85, shout 82.30 | dB SPL | ANSI S3.5-1997's standard speech spectra | R1063 [read] |
| Band audibility | (E - N + 15) / 30, clipped to 0..1 | - | speech's 30 dB dynamic range about its long-term level | R1063 [ex] |
| Air's absorption | ISO 9613-1's alpha(f, T, h) from the relaxation frequencies of oxygen and nitrogen | dB/m | sea level; checked 4.98 dB/km at 1 kHz, 20 C, 70% (the standard's 4.98) and 3.66 at 10 C (3.7) | R1064 [read] |
| Dense foliage, 1 kHz octave | 1 dB over 10 to 20 m of it; 0.06 dB/m over 20 to 200 m | dB | foliage dense enough to block the view | R1065 [read, excerpt] |

**Pick.**
- speechAt(from, to): VOICE - 20 log10 d - alpha(1 kHz, the air's warmth and water where the speaker stands) d - foliage, the foliage's path the crowns' cover sampled every 10 m along the line, no more than one layer counted [design], 200 m's attenuation past 200 m.
- Speech is followed where (E - N + 15) / 30 is at least one half, that is where it stands at least at the noise [design: half its range heard]; N is a quiet land's 30 dB [gap: natural quiet runs 20 to 30 dB(A) by general knowledge, nothing read; wind in leaves, rain and fire add to it and are left out; the ground's effect is left out]. Speech carries at 1 kHz, where its weight in intelligibility lies [design].
- Normal speech is followed to 41 m in open still air (raised to 83 m): the custom spoken (was 40 m), the gathering a custom is spoken in (was 25 and 30 m, and 4 m of a fire), and time spent in someone's company (was 30 m).

### 12c. Narration

beliefs.ts sentence states what was seen to happen, not what a verb is taken to cause: striking a stone over a lay "threw a spark that lit a fire" (was "can throw"), eating "they fell sick" or "it fed them" (was "can make you sick", "is good to eat"), a sick person eating a cure "their sickness eased" (was "helps when you're sick"), water poured on a young plant "it came up, about n days later" (was "helps it grow"), a fire ringed "kept within the ring" (was "keeps it contained and burning steady"), heaped over "smoldered under it" (was "closes it in to smolder"), charcoal fed to a ringed fire "glowed in it as coals" (was "makes it burn white-hot"), and wearing something says how thick it stood off the skin, the depth body.ts insulates by (was "keeps the cold out"). A ringed fire with charcoal in it is seen as "a ringed fire of charcoal" (was "glowing white-hot"), the forge's outcome "glowed" (was "glowed white-hot"). A belief's hours come from its ticks through sky.ts TICK_S, not 5 minutes.

### 12d. Groups

| Quantity | Value | Units | Conditions | Source |
|---|---|---|---|---|
| Physical activity level, active or moderately active lifestyles | 1.70 to 1.99 | x BMR | FAO/WHO/UNU 2004 | R273 [ex] |

**Pick.**
- A ruling is words. Scolding, shunning and driving out no longer take 10, 15 and 25 off the social need: what they cost is the company and the goods that follow (the shunned and the driven out lose company as the camp keeps away, the driven out their home) [derived].
- Making it right gives back what was taken, as many as were (was twice over), out of what the doer carries; failing that, food of theirs until it has fed as much as what was taken would have (physics.ts meal's kJ). What isn't food has no measure of worth here and nothing stands in for it [gap] (was the most edible thing they held).
- A day's need, kJ: Schofield's basal rate (body-constants sec. 8) times 1.85, the middle of FAO's active lifestyles [derived].
- Setting things into the camp's store keeps back food that covers a day's need (was 2 pieces), and stash at home does the same (was 3); taking from the store or from home takes what covers a day's need of that food, as they can carry (was 3), one piece of what isn't food [design].
- What a deed was worth: sharing, the food energy set in over a day of the giver's need (was n / 8); taking from the store, the share of the store's food energy taken, or of its pieces where it held no food [gap] (was a share of pieces).
- Scarcity is the people's food need alone (the winter's +0.15 is gone; winter shows as the food it leaves them).
- A custom is spoken when the sky's own light at the speaker is under civil twilight's end (light.ts DARK, R483), someone of the camp awake can follow them, and they carry the most weight among those who could speak; the first such evening after the pattern settles [design] (was 18:00 to 22:00 on the clock, then a coin flip each hour). Everyone awake who can follow the speaker learns it. "By the fire" when most of the light on the speaker is the fire's (light.ts lightWords).
- The social need drains 14.4 a day [design: the old 0.05 a five-minute tick], expressed through TICK_S.

### 12e. Randomness

- world.ts landing draws the bearing a newcomer lands on from the world's counter stream (gpu/rand.ts philox keyed by the seed and stream "land", counting from the tick), so a seed's run lands the same newcomer in the same place whatever else drew before.
- space.ts anyOf takes its draws from the caller's stream and has no Math.random default.

### 12f. Gaps

- The contrast everything stands out by comes from two whole-spectrum albedos, not from what the eye sees of each material; nothing carries a visible reflectance, so a dark flint nodule and a pale pebble stand out alike, and birds against the sky are seen as against the ground.
- Nothing blocks a line of sight: hills, trunks and crowns hide nothing from sight (crowns only darken where they stand). Hearing does take the crowns along its path.
- By starlight a person is noticed at 6 m: the contrast of 0.30 is low for a figure against snow or the sky.
- The noise floor is a fixed 30 dB; wind, rain, fire and the ground's effect on speech are left out; every speaker uses a normal voice.
- Animals are seen at the cube root of their mass, butterflies at a span from general knowledge.
- animals.ts SPEC.reveal and pools.ts BUTTERFLY_SEEN, the windows the GPU's animals are shown to the CPU within, are still [design] radii; sim.ts's 600 m bound on whom someone thinks of, SEARCH's 800 m and the 60 m a prompt calls nearby are [design].
- The social need's drain is [design]; sim.ts's flat +20, +25, +15 and -10 for a talk, a meal, a fire and an insult and life.ts's -35 for grief stay, listed with the agents' own decision rules in rule-audit-findings.md.
- The compliance roll on a ruling (Math.random against Jev's comply), the customs' patterns and leaders' standing are the agents' own rules and stay.
- A camp's name still comes from tile counts round it (rule-audit-findings P8).
- describeKind still hides metal below 0.9 and props below 0.45: props are substrate 2's.
- A structure is still named by its tier (substrate 8); fireWord names a fire by where it was done (hearth, kiln, forge), the arrangement people see.
- The facts seen (beliefs.ts see) still say what they generalise to ("Lightning can set a tree on fire").
- A raid on a home still takes 3 pieces (sim.ts raid).

### References

- R1060 Crumey A. (2014), Human contrast threshold and astronomical visibility, Mon. Not. R. Astron. Soc. 442:2600-2619, secs. 1.2, 2.2 and 2.3, eqs. 25, 28, 39 to 44 (Blackwell 1946's table 8 fitted; Blackwell and Blackwell 1971's factor 2.4). https://arxiv.org/html/1405.4209v1 (read 2026-10-16)
- R1061 Johnson J. (1958), Analysis of image forming systems, Image Intensifier Symposium, Fort Belvoir; as told in Sjaardema T.A., Smith C.S., Birch G.C. (2015), History and evolution of the Johnson criteria, SAND2015-6368. https://www.osti.gov/servlets/purl/1222446 (abstract read 2026-10-16; the cycle counts as the field quotes them [ex])
- R1062 Drillis R., Contini R. (1966), Body segment parameters, Technical Report 1166-03, New York University; the segment lengths as fractions of stature as Winter D.A., Biomechanics and Motor Control of Human Movement, fig. 4.1, gives them [ex].
- R1063 ANSI/ASA S3.5-1997 (R2024), Methods for calculation of the speech intelligibility index: overall speech levels by vocal effort from the tables as the R package SII carries them (vignette, read 2026-10-16); band audibility (E - N + 15) / 30 [ex]. http://cran.stat.auckland.ac.nz/web/packages/SII/vignettes/SII.pdf
- R1064 ISO 9613-1:1993, Acoustics, Attenuation of sound during propagation outdoors, Part 1: Calculation of the absorption of sound by the atmosphere, the relaxation frequencies and the attenuation coefficient as python-acoustics implements them. https://python-acoustics.github.io/python-acoustics/atmosphere.html (read 2026-10-16)
- R1065 ISO 9613-2:1996, Acoustics, Attenuation of sound during propagation outdoors, Part 2: General method of calculation, Annex A Table A.1 (foliage). https://puc.sd.gov/commission/dockets/electric/2019/el19-003/KMExhibit9.pdf (search excerpt read 2026-10-16)
