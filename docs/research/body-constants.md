# Physical body constants, with sources

Research for the physical body: src/sim/body.ts and the code that feeds it and reads it (sim.ts surroundings, needs, metOf and shelterAir; fuel.ts FOOD_KJ and the portions; materials.ts carcass; plan.ts GATHER; world.ts cropOf; ecology.ts's crop accrual; air.ts headWind; wetness.ts fireFlux). A body here is two heat nodes, a core and a skin, with stores of glycogen, fat and lean tissue, a stomach and a want of sleep, living in the air, sky, sun, fire, clothing and shelter the rest of the sim already models. Every constant it uses comes from the tables below, fixed before the checks in section 11 were run; a check that fails with these values is a gap in the model, not something to retune. Collected 2026-10-11. Section numbers are the ones the code's comments cite ("body-constants sec. N").

How each value was obtained:
- [read]: I read it in the primary or full-text source.
- [sec]: I read it in a secondary source that cites the original.
- [ex]: I saw it only in a search excerpt or abstract. The value is real, but I didn't see its context.
- [derived]: my arithmetic on cited inputs.
- [UNVERIFIED]: I couldn't confirm it.
- [design]: a reading of the sim's own, with its basis stated, where no source gives a number.

Ref keys continue docs/research/fire-constants.md's: R1 to R224 are that document's, and are cited here by number where this one leans on it (R70, R81, R90, R92). This document's own begin at R225 and are listed at the end with title and URL or DOI.

## 1. Body size

| Quantity | Value | Units | Conditions | Source |
|---|---|---|---|---|
| Median mass, boys, at 0, 0.5, 1, 2, 3, 5, 8, 10, 12, 15, 18 y | 3.530, 7.897, 10.310, 12.671, 14.330, 18.393, 25.639, 31.936, 40.471, 56.281, 67.198 | kg | CDC 2000 growth charts, P50 column; the files tabulate half-month midpoints, so whole ages between rows are interpolated | R225, R226 [read at birth and 24 months; derived by interpolation elsewhere] |
| Median mass, girls, same ages | 3.399, 7.211, 9.516, 12.055, 13.865, 17.930, 25.628, 32.891, 41.646, 52.042, 56.185 | kg | as above | R225, R226 [read at birth and 24 months; derived elsewhere] |
| Median mass, mean of boys and girls | 3.465, 7.554, 9.913, 12.363, 14.098, 18.162, 25.634, 32.414, 41.059, 54.162, 61.692 | kg | The two CDC files agree at 3 y to 0.001 kg | [derived] |
| Median stature, boys, same ages | 0.4999, 0.6699, 0.7552, 0.8645, 0.9496, 1.0890, 1.2788, 1.3862, 1.4905, 1.6994, 1.7616 | m | Recumbent length to 1 y, standing stature from 2 y (length = stature + 0.008 m in the CDC files) | R227, R228 [read at birth and 24 months; derived elsewhere] |
| Median stature, girls, same ages | 0.4929, 0.6526, 0.7379, 0.8498, 0.9392, 1.0766, 1.2759, 1.3799, 1.5119, 1.6186, 1.6312 | m | as above | R227, R228 [read at birth and 24 months; derived elsewhere] |
| Median stature, mean of boys and girls | 0.4964, 0.6613, 0.7466, 0.8571, 0.9444, 1.0828, 1.2773, 1.383, 1.5012, 1.659, 1.6964 | m | | [derived] |
| WHO standard, boys, for comparison | 3.346, 7.934, 9.648, 12.152, 14.343, 18.337 kg at 0, 0.5, 1, 2, 3, 5 y | kg | Breastfed children under good conditions; CDC is 5% heavier at birth, 6.9% at 12 months, 4.3% at 24 months, within 0.5% from 3 y | R229 [read] |
| Measured adults 20 to 39 y (US, 2015 to 2018) | men 89.9 kg, 1.760 m; women 77.1 kg, 1.627 m (BMI about 29) | kg, m | Mean of the two decade means | R230 [read]; means [derived] |
| DuBois surface area | A_D = 0.007184 W^0.425 H^0.725 | m2; kg, cm | Fitted to 9 subjects | R231 [sec] |
| Same with H in metres | A_D = 0.202 W^0.425 H^0.725 | m2; kg, m | The form Fanger's PMV and EnergyPlus use | R232 [read] |
| Reference man | 1.8 m2 at 70 kg, 1.73 m; both forms give 1.83 | m2 | Fanger 1967 | R232 [read]; check [derived] |
| Body fat of lean young men | 14.0% mean, range 6.4 to 26% | % of mass | 32 men of 20 to 33 y, BMI 21.7, underwater weighing, before the Minnesota semistarvation | R233 [read] |
| Essential body fat | 3 to 5% men, 8 to 12% women | % of mass | The least compatible with life and reproduction | R234 [ex], R235 [ex] |
| Least recommended total fat | 12 to 15% young men, 25 to 28% young women | % of mass | Lohman 1993 | R234 [ex] |

Checks [derived]:
- A grown body at the 18 y means (61.692 kg, 1.6964 m) has BMI 21.4 and a DuBois area of 1.71 m2; a newborn (3.465 kg, 0.4964 m) 0.21 m2.
- The measured US adults are not the body a forager has (BMI 29). The CDC 18 y medians are lean (BMI 21.4), close to the Minnesota men before starvation (BMI 21.7), so the grown body holds there rather than being drawn on to the adult survey.

Disagreement: CDC 2000 is a reference (how US children did grow, many formula-fed), WHO a standard (how healthy breastfed children grow); they cross between birth and 2 y, by up to 6.9% at 12 months, and agree from 3 y.

**Pick.**
- GROWN, the body's size by age: the CDC 2000 medians as the mean of boys and girls at 0, 0.5, 1, 2, 3, 5, 8, 10, 12, 15 and 18 y (the third and sixth rows of the table), linear between rows and held at the 18 y row after it. People here have no sex, so the mean of the two is the one body. CDC is used from birth for one source throughout [design]; WHO would make the 0 to 2 y rows up to 7% lighter.
- Surface area A = 0.202 W^0.425 H^0.725 (m2, kg, m), on the mass and stature of the moment.
- The sim's ages to human years [design]: island years 0 to 1 (a child) map to human 0 to 18; island years 1 to 5 (an adult) to human 18 to 60, 10.5 human years each; past 5 (an elder) 10.5 human years each again. The age bands of sec. 8's basal rate read these human years.
- FAT0 0.14, the share of a grown body that is fat before any hunger: the Minnesota men's 14.0% (R233). ESSENTIAL 0.07, the least: the mean of the midpoints of 3 to 5% (men) and 8 to 12% (women) [derived], fat no store can draw below (sec. 8).
- Lean tissue is the grown mass times (1 - FAT0), less whatever lean has been burnt (sec. 8).

## 2. Heat held: two nodes

| Quantity | Value | Units | Conditions | Source |
|---|---|---|---|---|
| Model | Gagge's two-node model of temperature regulation: a core and a skin shell, each storing heat, joined by tissue conduction and skin blood flow | | As implemented in pythermalcomfort two_nodes_gagge, after Gagge, Fobelets and Berglund 1986 | R236 [read], R237 [sec] |
| Neutral core, skin | 36.8, 33.7 | C | Set points of the control signals | R236 [read] |
| Skin blood flow | 6.3 neutral; at most 90, at least 0.5 | L/m2h | Flow = (6.3 + c_dil x core warm signal) / (1 + c_str x skin cold signal) | R236 [read] |
| Vasodilation, vasoconstriction coefficients | c_dil 120; c_str 0.5 | per K | The code notes ASHRAE gives 50 for c_dil | R236 [read] |
| Regulatory sweat | 170 x body warm signal x exp(skin warm signal / 10.7); at most 500 | g/m2h | c_sw 170 | R236 [read] |
| Core to skin conductance | 5.28 + 1.163 x skin blood flow | W/m2K | 5.28 the tissue's own; 1.163 Wh/LK the heat capacity of blood | R236 [read] |
| Skin share of body mass | alfa = 0.0417737 + 0.7451833 / (flow + 0.585417) | - | 0.1 at neutral flow | R236 [read] |
| Body temperature signal | 0.1 skin + 0.9 core, against 0.1 x 33.7 + 0.9 x 36.8 = 36.49 C neutral | C | Drives sweating | R236 [read]; 36.49 [derived] |
| Heat of evaporating sweat | 0.68 | W per g/m2h | = 2448 J/g | R236 [read]; J/g [derived] |
| Latent heat of sweat | 2426 | J/g | Partitional calorimetry | R249 [read] |
| Skin wettedness | 0.06 + 0.94 x regulatory sweat heat / greatest evaporation | - | 0.06 is diffusion through dry skin | R236 [read]; resting 0.06 also R240 [read] |
| Time step | 60 steps of 1 minute | min | Gagge's own integration | R236 [read] |
| Gagge's body specific heat | 0.97 | Wh/kgK (3.49 kJ/kgK) | 70 kg body | R236 [read] |
| Whole-body specific heat, from measured tissues | 2.98 (2.44 to 3.34 by tissue extremes; four bodies 2.954 to 3.028) | kJ/kgK | Tissue masses from four MRI body models, tissue c_p from the IT'IS database | R238 [read] |
| Traditional value | 3.47 | kJ/kgK | Never measured: Burton took the body as half fat, half blood | R239 [sec, via R238] |
| Tissue insulation, for comparison | 0.124 at full vasoconstriction, 0.031 at full vasodilation | m2K/W | Resting man, 4 mm subcutaneous fat (Veicsteinas 1982) | R240 [read] |

Checks [derived]:
- Gagge's conductance gives 1/(5.28 + 1.163 x 0.5) = 0.171 m2K/W at the least flow, 0.079 at neutral flow and 0.009 at the most. The cold end is above Kingma's 0.124 for full vasoconstriction, so the two-node body holds its core slightly better in the cold than Kingma's figure implies.
- Gagge's 0.68 W per g/m2h is 2448 J/g, within 1% of the latent heat of sweat, 2426 J/g (R249).
- At 2.98 kJ/kgK the grown body (61.7 kg) holds 184 kJ/K: 51 W for an hour moves the whole body 1 K.

Disagreement: Gagge's 3.49 kJ/kgK against Xu's 2.98. 3.47 to 3.49 is the traditional half-fat, half-blood figure, never measured; 2.98 is weighted from measured tissues and imaged masses, with under 2% spread between bodies. The 15% difference scales every thermal time of the body.

**Pick.**
- The body's heat is Gagge's two-node model as pythermalcomfort codes it (R236), every regulation constant above as tabled: neutral core 36.8 C and skin 33.7 C; skin blood flow 6.3 L/m2h neutral, at most 90, at least 0.5; c_dil 120, c_str 0.5; c_sw 170 g/m2h, sweat at most 500; tissue conductance 5.28 W/m2K plus blood's 1.163 Wh/LK times the flow; the skin's share of mass alfa = 0.0417737 + 0.7451833/(flow + 0.585417); the body signal against 0.1 skin + 0.9 core at neutral; sweat evaporating at 0.68 W per g/m2h; wettedness 0.06 + 0.94 x sweat over the most the air will take.
- Specific heat 2.98 kJ/kgK (R238) in place of Gagge's 0.97 Wh/kgK.
- Integrated in 1-minute steps over the sim's 5-minute tick, as Gagge integrates.
- Gagge's own shivering term (19.4 x skin cold x core cold signal, W/m2) is replaced by sec. 3; his exchange with the surroundings by sec. 4.

## 3. Shivering

| Quantity | Value | Units | Conditions | Source |
|---|---|---|---|---|
| Tikuisis and Giesbrecht shivering | M_shiv = [155.5 (37 - Tc) + 47.0 (33 - Ts) - 1.57 (33 - Ts)^2] / sqrt(%BF) | W/m2; C; % body fat | Set points core 37, skin 33; rates of change not used | R241 [read, abstract] |
| Sign of the fat exponent | %BF^(-0.5): fat attenuates shivering | - | The abstract renders "(%BF)0.5", a lost minus sign; multiplying gives about 2050 W/m2 | R241 [ex, two restatements] |
| Calibration | 14 men, 28 y, 77.7 kg, 18.4% fat; 3343 observations; water as cold as 8 C for up to 1 h; core down to 33.25 C | | | R241 [read] |
| Why the skin term is quadratic | skin thermosensitivity peaks near 20 C | | Benzinger 1969 | R241 [read] |
| Peak shivering | 4.9 (SD 0.8) x resting metabolic rate, 41.7% of VO2max | - | Measured peak | R242 [ex] |
| Core at the peak | about 35 C; ceiling about 5 x RMR, reason unknown | C | Review | R243 [ex] |
| Greatest cold-induced heat, absolute | 372 W (200 W/m2 for 1.86 m2) | W | Shivering plus non-shivering, used as a model cap | R240 [read] |
| Shivering stops | core 30 to 32 C | C | Clinical | R244 [ex] |
| Same, from staging | HT I (35 to 32 C) shivering; HT II (below 32 to 28 C) not shivering | C | Swiss staging | R245 [read] |
| Shivering endurance | submaximal shivering 16 h or more unfed; models that stop it at 4 h on glycogen are wrong | h | Human studies | R247 [read] |
| Exercise and shivering | exercise metabolism replaces shivering at higher intensities: shivering falls as work's heat rises, and total metabolism is no more than the larger of the two | | Fig. 7-6 | R246 [read] |
| Resting in cold wind | VO2 600 to 700 ml/min (226 W at 650 ml/min) | ml/min | Young men resting in 5 C air, 1 m/s wind (Young et al. 1986) | R246 [sec]; W [derived] |
| Nude in severe cold | VO2 about 1500 ml/min (about 522 W) | ml/min | Nude at -18 C, 4.5 m/s wind (Iampietro 1960) | R246 [sec]; W [derived] |

Checks [derived]:
- The equation at its own dataset's means (core 35.9, skin 23.4, 18.4% fat): (171 + 451 - 145)/4.29 = 111 W/m2, about twice resting. With the minus sign restored it is the right size.
- VO2 to watts at 20.9 kJ per litre of oxygen (RQ about 0.85): 650 ml/min is 226 W, 1500 ml/min 522 W.

Disagreement: Tikuisis and Giesbrecht's equation has no ceiling; Eyolfson measured 4.9 x RMR; Kingma caps all cold-induced heat at 372 W. Shivering's end is given as 30 to 32 C clinically and as the HT I to HT II boundary at 32 C by staging; these are one observation.

**Pick.**
- Shivering, W/m2: Tikuisis and Giesbrecht's equation divided by sqrt(%BF), the body's own fat share, floored at 0 (and %BF taken as no less than 1) [design: the floor keeps a body with no fat finite].
- Capped so resting plus shivering is at most 4.9 x the basal rate (R242), the measured peak, since no model explains the ceiling.
- The cap fades linearly to 0 between core 32 and 30 C (R244, R245): shivering fails at 32 C and is gone by 30 C.
- Shivering is metabolic heat in the core and is paid from the energy stores (sec. 8) like any other [derived].
- Work stands in for shivering: someone working makes total metabolism = max(work's, resting + shivering), not their sum [derived from R246 Fig. 7-6].

## 4. Exchange with surroundings

| Quantity | Value | Units | Conditions | Source |
|---|---|---|---|---|
| Convection, standing, moving air | h_c = 10.4 V^0.56 | W/m2K; m/s | Nude manikin, de Dear | R92 [read] (fire-constants sec. 18) |
| Convection, still air | 3.4 standing, 3.3 seated | W/m2K | Below 0.10 m/s | R248 [read] |
| de Dear's recommended general equation | h_c = 10.3 v^0.6 | W/m2K | Either posture, data to 5 m/s | R248 [read] |
| Other forced convection laws | 8.3 v^0.5 (Kerslake), 8.6 v^0.5 (Gagge, walking), 12.1 v^0.5 (Fanger), 14.8 v^0.69 (Seppanen) | W/m2K | | R248 [read] |
| Radiation coefficient | h_r = 4 eps sigma (A_r/A_D) ((t_surface + t_r)/2 + 273.15)^3 | W/m2K | sigma 5.67e-8 | R248 [read], R249 [read], R236 [read] |
| Emissivity | 0.95 (clothed and general); 0.98 bare skin | - | | R249 [read]; 0.95 R248 [read] |
| Radiating share of the body, A_r/A_D | 0.73 standing, 0.70 sitting | - | Nude, Fanger | R248 [read]; 0.725 standing in R90 [read] |
| Linear radiation coefficients | 4.7 (ASHRAE); 4.5 measured; 6 in ASHRAE 55's solar code | W/m2K | Near room temperature | R248 [read], R90 [read] |
| Clear sky temperature (Swinbank) | T_sky = 0.0552 T_air^1.5 | K | Clear sky, humidity averaged out | R250 [ex]; original R = 5.31e-14 T^6 mW/cm2, r 0.99 [read, abstract] |
| Overcast sky | T_sky = T_air | K | Full cloud | R251 [ex] |
| Cloud in between | corrections to clear-sky emissivity, no single accepted coefficient | | Building simulation | R252 [ex] |
| Cloud cover of the sim's skies | clear 5%, cloudy 70% (broken), rain and storm 95% (overcast) | % | NFDRS state of weather | R70 [read] (fire-constants sec. 12) |
| View of a standing person | 0.5 sky, 0.5 ground | - | Open flat site; underestimates at low sun in towns and in deep valleys | R253 [read] |
| Absorptivity, long-wave | 0.95 skin and clothing | - | | R90 [read] |
| Absorptivity, short-wave | 0.7 default (0.57 to 0.84 by skin colour) | - | | R90 [read] |
| Projected area factor f_p, standing, sun in front | 0.35 at 0 and 15 deg, 0.314 at 30, 0.258 at 45, 0.206 at 60, 0.144 at 75, 0.082 at 90 | - | Fanger | R90 [read] |
| A fire as a beam on the body | absorbed per m2 of skin = alpha_LW f_p (A_r/A_D) q | W/m2 | Same algebra as the direct beam; flame absorptivity ratio 1 | R90 [read]; fire-constants sec. 18 [derived] |
| Respiratory loss, ASHRAE SI | C_res + E_res = 0.0014 M (34 - t_a) + 0.0173 M (5.87 - p_a) | W/m2; M W/m2, p_a kPa | ASHRAE Fundamentals 1997 quoted verbatim | R254 [ex] |
| Same, Fanger's Torr form | 0.0023 M (44 - P_a) + 0.0014 M (34 - T_a) | W/m2; P_a Torr | PMV code | R232 [read], R236 [read] |
| Lewis relation | LR = 16.5 | K/kPa | Sea level | R248 [read], R249 [read]; Gagge's 2.2 K/Torr R236 [read] |
| Clothing's vapour permeation | i_cl 0.45 | - | Clothed; 1 bare | R236 [read] |
| Air layer and clothing evaporative resistance | R_ea = 1/(LR f_cl h_c); R_ecl = R_cl/(LR i_cl) | m2kPa/W | | R236 [read] |
| Skin after a fall into ice water | mean skin 5 C after 10 min | C | 0 C water | R255 [ex] |
| Core in the first minutes | rose for the first 10 to 20 min of cold immersion, then fell | | Hayward's subjects, lightly clothed | R256 [ex] |
| Core cooling in ice water, once set | 6.02 (rectal), 5.40 (tympanic) | C/h | After the first 10 min, no exercise | R255 [ex] |
| Wind under crowns | sheltered wind adjustment 0.555/(sqrt(f H) ln((20 + 0.36 H)/(0.13 H))) of the 20-ft open wind | - | H crowns' height in ft; f crown fill | R81 [read] (fire-constants sec. 14a) |

Checks [derived]:
- 10.4 V^0.56 and 10.3 v^0.6 agree within 1% at 1 m/s, 4% at 3 m/s and 6% at 5 m/s. The Gagge form's 8.6 v^0.5 is 17% lower at 1 m/s.
- Pythermalcomfort's LR of 2.2 K/Torr is 16.5 K/kPa. The two respiration forms are the same equation: 44 Torr is 5.866 kPa and 0.0023 per Torr is 0.0173 per kPa.
- Respiration at rest (58 W/m2) in -10 C air at 0.20 kPa: 3.6 + 5.7 = 9.3 W/m2, 16% of the metabolism, the same share when shivering at 200 W/m2 (32 W/m2).
- Swinbank's sky is 16 K under 20 C air, 24 K under 0 C air, 27 K under -10 C air. At 0 C under a clear sky a standing person half facing it loses about 46 W/m2 more than with surroundings at air temperature.
- A fire's 0.83 kW/m2 at 2 m from the standard lay (fire-constants sec. 31) is 0.95 x 0.35 x 0.73 x 830 = 201 W on each m2 of skin. A 1000 W/m2 beam at 60 deg elevation is 0.7 x 0.206 x 0.73 x 1000 = 105 W/m2.

Disagreements: forced convection laws for a person differ by nearly two at 1 m/s (8.3 to 14.8). de Dear's 10.3 v^0.6 is HeatBody's pick; fire-constants sec. 18 already uses de Dear's standing fit 10.4 V^0.56, and the two agree within 6% to 5 m/s, so the body takes the one the fires' warmth uses. ASHRAE 55's h_r 6, used in fire-constants sec. 18, is a lumped value; out of doors under a cold sky the radiant and air temperatures differ, and the fourth-power form is needed.

**Pick.**
- Convection: fire-constants sec. 18's h_c = max(3.4, 10.4 V^0.56), V the head-height wind where they are (none inside walls), one law with the fires' warmth.
- Radiation: h_r = 4 eps sigma (A_r/A_D) ((t_surface + t_r)/2 + 273.15)^3, eps 0.95, A_r/A_D 0.73 standing (R248; Gagge's own form in R236). It replaces sec. 18's h_r 6 for the body.
- Sky: Swinbank's T_sky = 0.0552 T_air^1.5 (K) under a clear sky, the air's own temperature under full cloud, linear between in the sky's cloud share, taken as air.ts CLOUD: clear 0.05, cloudy 0.7, rain and storm 0.95 [design: the beam share NFDRS gives each sky stands for cloud cover].
- Mean radiant temperature in the open: half sky and half ground for someone standing (R253), the ground at air temperature [design], and the crowns overhead hiding their share of the sky at air temperature [design]. Inside a shelter the walls are at the shelter's air temperature [design].
- Fire: absorbed per m2 of skin = alpha_LW 0.95 x f_p 0.35 x A_r/A_D 0.73 x q, q the radiant flux on them (fire-constants sec. 18's SolarCal algebra, R90; the flame absorptivity ratio of 1 stays a gap). It replaces sec. 31's Delta t_o = f_p q/(h_r + h_c), which it reproduces in form.
- Sun: alpha_SW 0.7 x f_p(elevation) from Fanger's standing table, sun in front (R90) x 0.73 x the beam across itself (air.ts sunOn over sin(elevation)) x the share of the beam reaching them past hills and crowns (light.ts Light.beam). Diffuse sky light on the body is left out [gap].
- Respiration: the ASHRAE SI form, 0.0014 M (34 - t_a) + 0.0173 M (5.87 - p_a) W/m2, p_a in kPa (identical to Fanger's Torr form).
- Evaporation: Lewis relation 16.5 K/kPa; the air layer's R_ea = 1/(LR f_cl h_c); clothing's R_ecl = R_cl/(LR i_cl), i_cl 0.45 (R236). Wet bare skin (wetness.ts a.skin) evaporates as fully wet over its wet share; a wet garment dries off its outside at LR h_c (p_sat(t_cl) - p_a) over its wet share [derived].
- Falling through ice: skin to 5 C at once (R255: mean skin 5 C after 10 min in ice water), everything they wear and their skin soaked, core unchanged (R256: core rises over the first 10 to 20 min). The old flat -25 health and -50 warmth go.
- Wind under crowns (air.ts headWind): Albini and Baughman's sheltered wind adjustment (fire-constants sec. 14a, R81). The 20-ft open wind is the head-height wind carried up the open class's log profile (z0 0.03 m), times 0.555/(sqrt(f H) ln((20 + 0.36 H)/(0.13 H))), H the crowns' height in feet and f = min(1, cover) x crown ratio / 3, the crown ratio 2 x the crown's radius share of the tree's height (light.ts SHARE: a crown as deep as it is wide) [derived]; used where f > 0.05. The flat 0.65 canopy cut goes.
- A fire's flux on wet things (wetness.ts fireFlux) is light.ts heatAt, the same flux people feel, in place of its own nearest-fire point source within 3 tiles [design: one flux for both].

## 5. Clothing and shelter

| Quantity | Value | Units | Conditions | Source |
|---|---|---|---|---|
| clo | 1 clo = 0.155 | m2K/W | | R249 [read], R240 [read] |
| Insulation per thickness, clothing | 4 clo per inch = 1.57 clo/cm | | Uncompressed; clothing plus its air layers | R257 [ex] |
| Still air, same units | about 7 clo per inch | | | R257 [ex] |
| Conductivity these imply | 0.041 W/mK at 4 clo/inch; 0.023 at 7 (still air 0.026) | W/mK | | [derived] |
| Fur, measured | mouse fur 1.55 (SD 0.46) clo/cm | clo/cm | Mus musculus pelt | R258 [ex] |
| Fur, across mammals | insulation linear in fur depth up to an arctic fox's; flat from fox to moose | | 16 arctic and 16 tropical mammals, raw skins | R259 [sec] |
| Coat conductivity, arctic mammals | 35 to 95 | mW/mK | Scholander 1950 | R259 [sec] |
| Woven rabbit-fur robe | k 0.031 (wool blanket control 0.035); 4 cm thick, so 1.29 m2K/W (8.3 clo) | W/mK | Hotplate test; a lofted robe, an upper bound for a pelt | R260 [read]; clo [derived] |
| Wet insulation | polyester batting keeps 35%, down 23%, at 50% water content | % of dry | Insulating materials | R261 [ex] |
| Wet garments in wear | -15% at rest; -30 to -40% walking | % | Wool and nylon | R262 [ex] |
| Wet immersion suit | 0.5 to 1 L of water lowers insulation 30 to 40% | % | Laboratory immersion | R247 [read] |
| Clothing area factor | f_cl = 1 + 0.3 clo (= 1 + 2 R_cl, SI) | - | Ensemble approximation | R248 [read], R249 [read] |
| Same, pythermalcomfort | 1 + 0.15 clo | - | | R236 [read] |
| Red deer winter coat | guard hairs about 60 mm over an undercoat of about 20 mm | mm | Double coat, three hair types | R263 [ex] |
| Same, independent | guard hairs about 6 cm over about 2 cm of underwool | cm | Kay, as reported | R264 [sec] |
| Deer leather, finished | 1.5 to 1.9 | mm | Farmed New Zealand red deer | R265 [sec] |
| Hide as a kind | 3 mm, 441 kg/m3 dry, k 0.47 W/mK, a 2 kg deer hide | | fire-constants sec. 27c | [design] (fire-constants sec. 27c) |
| Still air film inside walls | h_c 3.4 | W/m2K | | R248 [read] |

Checks [derived]:
- A 2 kg deer hide is 2/(441 x 0.003) = 1.51 m2 of skin: 0.87 of a 1.73 m2 adult.
- With 2 cm of hair it stands 2.3 cm proud: 2.3 x 1.57 = 3.6 clo, 0.56 m2K/W dry. The undercoat alone by Scholander's coat conductivity (2 cm at 35 to 95 mW/mK) is 0.21 to 0.57 m2K/W, about 2 clo at the middle; by the 1.57 clo/cm rule it is 3.1 clo. The rule sits at the top of Scholander's range.
- The rabbit robe's 8.3 clo for 4 cm is 2.1 clo/cm, above the rule, as a lofted robe should be.
- Wet: at 0.5 kg of water per kg dry a garment keeps 35%; at 0.25 kg, 67.5%.

Disagreements: 4 clo per inch is the practical figure for clothing and its air; 7 is still air's limit, which only very light lofty insulation reaches. The clothing area factor is 1 + 0.3 clo in de Dear and Cramer and Jay and 1 + 0.15 clo in pythermalcomfort; the measured sources are followed.

**Pick.**
- 1 clo = 0.155 m2K/W; insulation 1.57 clo for each cm of garment or fur depth (R257; mouse fur 1.55 clo/cm, R258) for clothing and hides alike.
- Wet: insulation falls linearly with water to 35% kept at 0.5 kg of water per kg dry (polyester batting at 50% water content, R261), and no further past that [derived]. A hide's own wet insulation was not measured [gap].
- Clothing area factor f_cl = 1 + 0.3 clo (R248, R249).
- A garment covers the share of the body its own area reaches, its dry mass over its thickness times its density, over the DuBois area; the rest is bare, and the two parts lose heat as parallel paths [derived].
- Hide: 3 mm of skin (fire-constants sec. 27c) plus 2 cm of hair, the red deer winter coat's undercoat depth (R263, R264; guard hairs to 6 cm) [derived]. A 2 kg deer hide covers 1.51 m2, 0.87 of a 1.73 m2 adult, and insulates 0.56 m2K/W (3.6 clo) dry. Leather, cured hide, keeps no hair [design].
- Shelter: the air inside a lean-to or anything better is the outside air plus what the skins of those in it give off (their dry heat, from the tick before) over the walls' conductance [derived]. The walls are a dome as wide as the shelter (physics.ts WIDTH by tier), of envelope area 2 pi r^2. Their resistance is, in series, still air's film inside, 1/(3.4 + h_r); the wind's outside, 1/(h_c(V) + h_r); and the solid of its parts spread over the dome at each part's own conductivity (fuel.ts PHYS k, fire-constants sec. 23 and 27c). Air leaking through gaps is left out [gap: it overstates the warmth]. Inside there is no wind and no sun, and the walls are at the inside air.

## 6. Contact

| Quantity | Value | Units | Conditions | Source |
|---|---|---|---|---|
| Human huddling | HUDDLE and HELP recommended; no heat-transfer numbers; the assumed loss from groin and armpit was later found exaggerated | | Cold-water immersion (Hayward, Eckerson and Collis 1975, reviewed) | R247 [read] |
| Arms against the torso | can insulate it when not used for work; qualitative | | Immersed | R247 [read] |
| Conduction in body heat balance | normally neglected; may matter in long contact with things hotter or colder than skin | | | R249 [read] |
| Huddling voles | resting metabolism 35.7% and 37.2% lower than apart; wet conductance 39% lower in the cold | % | Brandt's voles | R266 [ex] |
| Huddling endotherms | individual energy use 6 to 53% lower, by group size and species | % | Review | R267 [ex] |

Check [derived]: two adults touching over 10% of their skin, with h of 10 W/m2K and 20 K from skin to air, each save about 0.1 x 1.8 x 10 x 20 = 36 W, the order of the animal savings once a vole's far larger surface for its mass is allowed for.

**Pick.** There are no measured human whole-body contact data [gap]. Two bodies in contact are taken to stop exchanging heat over the contact share: skin against skin at about the same temperature passes almost nothing, so the saving is the loss to the surroundings avoided there [derived]. Each other body lying within reach (1.5 m), or tending them, covers 0.1 of the skin, up to two [design].

## 7. Collapse and death

| Quantity | Value | Units | Conditions | Source |
|---|---|---|---|---|
| HT I | conscious, shivering | 35 to 32 C core | Swiss staging; clinical signs first, temperature confirms | R245 [read] |
| HT II | impaired consciousness, not shivering | below 32 to 28 C | | R245 [read] |
| HT III | unconscious, vital signs present | below 28 to 24 C | | R245 [read] |
| HT IV | no vital signs | below 24 C | | R245 [read] |
| Cardiac arrest risk | rises below 32 C, sharply below 28 C | C | | R245 [read] |
| Lowest accidental core with full recovery | 13.7 | C | One case, rewarmed in hospital | R245 [read] |
| "Lethal" core used in survival models | 24 to 26 C; incapacitation taken at 30 to 34 C by different models | C | No single lethal temperature exists | R247 [read] |
| Heat stroke | core above 40 C with hot dry skin and CNS dysfunction (delirium, convulsions, coma) | C | The usual clinical definition (Bouchama and Knochel 2002) | R268 [ex] |
| Exertional heat stroke | above 40.5 C with end-organ dysfunction | C | Prehospital consensus | R269 [ex] |
| Near-certain death from heat | 43 | C core | Survivability modelling | R270 [ex] |
| Lower limit of survival in starvation | mean BMI 12 (James et al. 1988); lethal BMI about 13 men, about 11 women (Henry 1990) | kg/m2 | Famines and hunger strikes | R271 [ex] |
| Survival below BMI 10 | possible with specialised care | kg/m2 | Somalia 1992 to 1993 | R272 [ex] |

**Pick.**
- Down, unable to act, while the core is below 32 C (HT II, impaired consciousness, R245) or above 40 C (heat stroke's CNS dysfunction, R268).
- Death at a core of 24 C or below (HT IV, no vital signs, R245) or 43 C or above (R270).
- Death of hunger at BMI 12 (R271).
- Wounds: health is wounds' alone (attacks, traps, burns, sickness), and death comes at 0. It heals 0.1 a tick while they are not sick, their core is 35 C or above and they have glycogen left [design: no cited rate].
- The cause of a death is whichever line was crossed: cold, heat, hunger, or what last hurt them (a.hurt: burns, sickness, their wounds). The rule that a second collapse within 1.5 days is fatal, the collapse top-up and the cause priority switch go.

## 8. Energy

| Quantity | Value | Units | Conditions | Source |
|---|---|---|---|---|
| Basal rate under 3 y | men 0.249W - 0.127; women 0.244W - 0.130 | MJ/day; W in kg | Schofield 1985, re-adopted 2004; supine, awake, fasted, thermoneutral | R273 [read] |
| 3 to 10 y | 0.095W + 2.110; 0.085W + 2.033 | MJ/day | as above | R273 [read] |
| 10 to 18 y | 0.074W + 2.754; 0.056W + 2.898 | MJ/day | | R273 [read] |
| 18 to 30 y | 0.063W + 2.896; 0.062W + 2.036 | MJ/day | | R273 [read] |
| 30 to 60 y | 0.048W + 3.653; 0.034W + 3.538 | MJ/day | | R273 [read] |
| 60 y and over | 0.049W + 2.459; 0.038W + 2.755 | MJ/day | Small samples (50 men, 38 women) | R273 [read] |
| Schofield's bias | +5 to +13% over measured BMR in several Asian and tropical groups; 6 to 12% over preschoolers in Latin America and China | % | Henry and Rees 1988 compilation | R274 [read] |
| Activity as a multiple of basal (PAR) | sleeping 1.0; eating 1.4 to 1.5; cooking 2.1; walking, no load, 3.2; planting, weeding, gathering 4.1; collecting water or wood 4.4 | x BMR | FAO factorial method | R273 [read] |
| Compendium METs (codes) | sleeping 1.0 (07030); sitting quietly 1.3 (07021); standing quietly 1.3 (07040); standing, miscellaneous 2.5 (09071); running 5 mph 8.3 (12030); hunting deer, elk, large game 6.0 (04080); carrying, loading or stacking wood, light to moderate 3.3 (08009); arts and crafts, carving, weaving, seated, moderate 3.0 (09080); axe chopping, 35 blows/min, vigorous 8.0 (11262); construction, outside, new structures 4.0 (11120); digging, spading, general 5.0 (08050); building a fire inside 2.5 (05149); picking fruit or vegetables, moderate 3.5 (08246); walking 2.8 to 3.2 mph, moderate pace 3.5 (17190) | MET | 2011 Compendium | R275 [read] |
| 2024 changes | load carriage lowered (25 to 49 lb 5.0 to 4.0); forestry raised (8.0 to 8.5); code and label alignment checked | MET | 2024 Adult Compendium | R276 [read] |
| The MET's resting anchor | 3.5 ml O2/kg/min overstates measured resting rates by 20 to 35% | | 642 adults | R277 [ex] |
| Muscle glycogen | about 500 g (80% of the body's) | g | Young men | R278 [read] |
| Liver glycogen | about 100 g | g | Liver about 1.5 kg (Taylor 1996) | R278 [read; sec to Taylor] |
| Liver glycogen in a 24 h fast | -65% (Magnusson 1992) | % | | R278 [sec] |
| Liver glycogen, measured | 396 mmol/L at 4 h after a meal to 251 at 15 h, near-linear over 22 h; gluconeogenesis 64%, 82%, 96% of glucose output over 22, 36, 54 h | | 13C NMR, 68 h fast | R279 [ex] |
| Glycogen's energy | 17.2 kJ/g (4.1 kcal/g) | kJ/g | The usual heat of glycogen | [UNVERIFIED: standard figure, no source read] |
| Energy density of fat, of lean | 39.5; 7.6 | MJ/kg | Body composition dynamics; fat as lipid, lean as tissue with its water | R280 [ex] |
| Storing a surplus | 90 to 95% for fat overfeeding; 75 to 85% for carbohydrate | % | Human chamber studies | R281 [ex] |
| Gastric emptying | 69% retained at 60 min, 24% at 120 min, 1.2% at 240 min (medians) | % | 123 volunteers, low-fat meal, scintigraphy | R282 [read, abstract] |
| Gastric half-emptying | 94 +/- 21 min full solid meal | min | Scintigraphy | R283 [ex] |
| Stomach capacity | about 1.1 L in normal-weight women | L | Water-filled balloon to greatest tolerated volume | R284 [read abstract; 1.1 L ex] |
| Total fast, survival | 10 young men on water: one died at 45 days, nine at 57 to 73 (mean 61.6 +/- 2.5); death as fat ran out | days | 1981 hunger strike | R285 [ex] |
| Minnesota semistarvation | 69.4 to 52.6 kg in 24 weeks; fat 9.84 to 3.04 kg; BMI 21.7 to 16.4; REE 1608 to 994 kcal/day; no deaths | | | R233 [read] |
| Brain glucose use | 5.6 mg per 100 g per min, about 113 g/day | | Resting awake adult | R286 [read]; g/day [derived] |

Checks [derived]:
- The mean equations: under 3 y 0.2465W - 0.1285; 3 to 10 y 0.090W + 2.0715; 10 to 18 y 0.065W + 2.826; 18 to 30 y 0.0625W + 2.466; 30 to 60 y 0.041W + 3.5955; 60 and over 0.0435W + 2.607 MJ/day.
- Glycogen: (500 + 100) g x 17.2 kJ/g = 10.3 MJ for a young man of about 60 kg lean.
- The code's check (/tmp/bodycheck.ts), run on a 62.5 kg, 1.715 m adult (the CDC 18 y means at the time; now 61.7 kg, 1.696 m): basal 73.8 W. A total fast at 22 C and 1.5 MET: glycogen gone within a day, fat 8.7 to 2.6 kg by day 30, death at BMI 12 on day 60, against Leiter and Marliss's 45 to 73 days (mean 61.6).
- Liver glycogen falls 65% in 24 h (R278); the model's whole store e-folds in about 1.3 days, slower, since the muscle's glycogen, which a fast barely touches, is in the same store.
- Exponential emptying with a 90 min half-time keeps 63% at 60 min, 40% at 120 and 16% at 240, against Tougas's medians of 69, 24 and 1.2%: about right early, slow late.

Disagreements: the Compendium MET (about 81 W at 70 kg) and ASHRAE's met (58.2 W/m2, about 105 W) differ by 30%; taking METs as multiples of each body's own basal rate, as FAO's factorial method does, avoids both fixed bodies. No Compendium entry exists for foraging, knapping or building a shelter (sec. 12). Storage efficiency differs by fuel (fat 0.95, carbohydrate 0.80); a forager's mixed diet is taken at one value.

**Pick.**
- BMR: Schofield's equations (FAO/WHO/UNU 2004 Table 5.2, R273), the mean of the men's and women's per band, MJ/day, W in kg: under 3 y 0.2465W - 0.1285; 3 to 10 y 0.090W + 2.0715; 10 to 18 y 0.065W + 2.826; 18 to 30 y 0.0625W + 2.466; 30 to 60 y 0.041W + 3.5955; 60 and over 0.0435W + 2.607 [derived]. People here have no sex.
- Activity: the Compendium MET as a multiple of the body's own basal rate (FAO's factorial method; R273, R275). Sleeping and out cold 1.0 (07030); talking, giving, quarrelling, thinking, warming by a fire, tending, sick and standing 1.3 (07021, 07040); stealing 2.5 (09071); eating 1.5 (FAO PAR); fleeing 8.3 (12030, running 5 mph); fighting 6.0 and hunting 6.0 (04080); storing 3.3 and collecting 3.3 (08009); tinkering 3.0 and crafting 3.0 (09080); chopping 8.0 (11262, the sustained felling pick; the 17.5 MET of 51 blows a minute is a burst); building 4.0 (11120); planting 4.1 (FAO PAR, gathering and planting); digging 5.0 (08050); fire-making 2.5 (05149); foraging 3.5 (08246); exploring, helping and walking 3.5 (17190).
- Glycogen: 500 g in muscle plus 100 g in the liver (R278) at 17.2 kJ/g, 10.3 MJ for a young man's 60 kg or so of lean, scaled by lean mass [derived].
- Stores: fat 39.5 MJ/kg and lean 7.6 MJ/kg (R280); a surplus is kept at 0.85, a mixed diet's (R281) [derived].
- A deficit draws on glycogen in proportion to how full the store is, the rest from fat down to ESSENTIAL (sec. 1), then from lean [design].
- Gastric emptying: exponential, half-time 90 min (R282; scintigraphy half-time 94 +/- 21 min, R283).
- Stomach capacity 1.1 kg (R284: about 1.1 L in normal women, at about 1 kg/L) [ex]; eating stops past it.

## 9. Sleep

| Quantity | Value | Units | Conditions | Source |
|---|---|---|---|---|
| Process S awake | H rises toward mu_w: H(t) = mu_w + (H(t_off) - mu_w) exp(-(t - t_off)/chi_w) | | | R287 [read] |
| Process S asleep | H falls toward mu_s: H(t) = mu_s + (H(t_on) - mu_s) exp(-(t - t_on)/chi_s) | | | R287 [read] |
| chi_w, rise awake | 18.2 | h | Daan, Beersma and Borbely 1984 fit to slow-wave activity | R287 [read], R289 [sec] |
| chi_s, fall asleep | 4.2 | h | as above | R287 [read], R289 [sec] |
| Upper threshold mean H0+ | 0.67 | - | Non-dimensional: mu_s 0, mu_w = mu = 1 | R287 [read] |
| Lower threshold mean H0- | 0.17 | - | | R287 [read] |
| Circadian amplitude a | 0.12 | - | | R287 [read] |
| Thresholds | H+(t) = H0+ + a C(t); H-(t) = H0- + a C(t); sleep begins at H+, ends at H- | | | R287 [read] |
| C(t) | simplest form cos(2 pi t/24); Daan et al. used a skewed sinusoid | | | R287 [read], R288 [read]; its harmonics [UNVERIFIED] |
| Circadian low | about 04:00 in the model re-plot; physiological minimum about 06:00 in young adults | clock time | | R287 [read] |
| The upper threshold | labile: light, stimulants, motivation; sleep deprivation is modelled by shifting it | | | R287 [read] |
| What the 1984 model reproduced | sleep after deprivation; internal desynchrony; bedrest fragmentation; shift workers' sleep | | | R288 [read] |

Check [derived]: without the circadian term the published set sleeps 4.2 ln(0.67/0.17) = 5.76 h and wakes 18.2 ln(0.83/0.33) = 16.79 h, a natural period of 22.6 h, a little short of 24 h, which lets the daily cycle entrain one consolidated sleep a day.

Disagreement: the physiological Phillips and Robinson model needs a homeostatic time of about 45 h for the same sleep timing (R287); 18.2 and 4.2 h are the published two-process set.

**Pick.**
- Borbely's two-process model with Daan, Beersma and Borbely's 1984 parameters as stated in Skeldon and Dijk 2025: chi_w 18.2 h, chi_s 4.2 h, H0+ 0.67, H0- 0.17, a 0.12, mu 1; C(t) = -cos(2 pi (h - 4)/24), h the hour, its low at 04:00 (S&D2025's re-plot) [design phase].
- Asleep, S falls at the light's rest rate (light.ts restRate, unchanged [design]) over chi_s. Sleep begins in a rest only once S reaches H+(t), and ends at H-(t). Awake and not sleepy, a rest lasts an hour (12 ticks) [design].
- The old rest rate of 0.7 a tick and the shelter tier's 35% go.
- Sickness adds 0.0005 x its severity to S a tick (the old 0.05 energy a tick, rescaled) [design].

## 10. Food

| Quantity | Value | Units | Conditions | Source |
|---|---|---|---|---|
| Blackberries, raw (fdcId 173946) | 43 kcal/100 g, 88.2 g water: 3640 kcal/kg DM | | | R290 [read]; DM [derived] |
| Acorns, raw (170157) | 387 kcal, 27.9 g water: 5370 kcal/kg DM (dried 5360, flour 5330) | | Kernel, not leached | R290 [read]; DM [derived] |
| Wild rice, raw (169726) | 357 kcal, 7.76 g water: 3870 kcal/kg DM; cooked (168897) also 3870 | | Only wild grass seed in SR Legacy | R290 [read]; DM [derived] |
| Chanterelle, raw (168422) | 32 kcal, 89.8 g water: 3140 kcal/kg DM | | | R290 [read]; DM [derived] |
| Dandelion greens, raw (169226) | 45 kcal, 85.6 g water: 3130 kcal/kg DM | | | R290 [read]; DM [derived] |
| Deer, raw (173855) | 120 kcal, 73.6 g water: 4550 kcal/kg DM; roasted (175085) 4540 | | Lean venison | R290 [read]; DM [derived] |
| Trout, rainbow, wild, raw (175154) | 119 kcal, 71.9 g water: 4240 kcal/kg DM; cooked (175155) 5080 | | Fillet | R290 [read]; DM [derived] |
| Lard (171401), tallow (171400) | 902 kcal, 0 g water: 9020 kcal/kg | | Rendered | R290 [read] |
| Whole round fish, refuse | 50 | % of mass as bought | Fat-rich round fish incl. trout; fillet 0% | R291 [read] |
| Blackberry picking | 2.5 flats/h x 4.5 lb = 5.1 | kg/h per picker | Season average, piece-rate costing | R292 [ex] |
| Wild einkorn harvest | 2.05 to 2.45 kg of heads/h; 46% clean grain, so about 1 kg/h | kg/h | Karacadag, Harlan's own trial | R293 [ex] |
| Bramble crop, field | 0.45 to 0.90 | kg/m2 | Managed planting | R294 [ex] |
| Bramble crop, wild bush | 3 to 5 | kg per 3 m x 3 m bush | Unmanaged | R295 [ex] |
| Wild cereal stand | 50 to 100 | g/m2 a year | Dense natural stands (Araus 2007) | R296 [ex] |
| Red deer dressing | 51 to 65 | % of live mass | | R297 [ex] |
| Rabbit dressing | 49.1 to 55.7, mean 55.5 | % of live mass | Several trials | R298 [ex], R299 [ex] |
| Deer carcass bone | 21.5 to 22.1 | % of carcass | Fallow deer bucks, full dissection | R300 [ex] |
| Rabbit meat to bone | 6 to 8, so bone 12 to 14% of the reference carcass | ratio | | R301 [ex]; % [derived] |
| Rabbit carcass dissectible fat | 3.1 to 3.8 | % | Two breeds | R302 [ex] |
| Deer carcass dissectible fat | 6.55 winter, 3.79 summer | % of carcass | Wild fallow does, 2 y, Poland | R303 [read] |
| Gut and kidney fat | mesenteric and omental 2.75% winter, 1.02% summer of bled mass; kidney fat 0.75 kg winter, 0.26 kg summer (of about 40.5 kg) | | Same animals | R303 [read] |
| Red deer live mass | stag 90 to 190, hind 63 to 120 | kg | Britain | R304 [read] |
| Wolf live mass | 43.6 (SE 0.64) male, 39.3 (SE 0.70) female | kg | Poland | R305 [ex] |
| Rabbit live mass | 1.2 to 2.0 | kg | Adults | R306 [ex] |
| Grey heron | 1.5 | kg | Biometrics from Cramp and Perrins 1994 | R307 [sec] |
| Herring gull | 970.6 +/- 152.3 (N 974) | g | Live adults, BTO Ringing Scheme | R308 [read] |
| Carrion crow | 508.7 +/- 65.3 (N 51) | g | Live adults, BTO Ringing Scheme | R309 [read] |
| Golden eagle | 3572 male (n 15), 5194 female (n 19) | g | European nominate subspecies | R310 [ex] |
| Acorn kernel | 5.0 g of a 6.3 g acorn: 0.79 | - | Quercus ilex, fresh | R311 [ex]; share [derived] |

Checks [derived]:
- kcal to kJ at 4.184: blackberry 15,230; acorn 22,470; wild rice 16,190; chanterelle 13,140; dandelion 13,100; deer 19,040; trout 17,740; fat 37,740 kJ/kg dry.
- Raw and cooked wild rice and venison agree within 0.3% per kg of dry matter, so cooking changes only water. Trout's cooked record (5080) is the outlier: its retention factors and fat value differ.
- A gathering's 12.5 min at 5.1 kg/h is 1.06 kg of berries, four 0.25 kg portions; at 1 kg/h of grain, 0.21 kg, four 0.05 kg handfuls.
- Bramble at 0.5 kg/m2: a 3 m by 3 m bush gives 4.5 kg, inside the wild bush's 3 to 5.
- Fat as a share of live mass: carcass 0.55 x 0.0517 = 0.028, plus gut and kidney fat 0.0314. The gut and kidney figure is the mean of the seasons' omental and mesenteric 1.885% and kidney 1.25% of bled mass.
- The code counts 89 cuts of meat and 14 lumps of fat from a red deer of 116 kg, and one cut from a rabbit of 1.6 kg (0.88 kg dressed, 0.74 kg of it meat).

Disagreements: "Blackberries, wild, raw (Alaska Native)" carries the common name crowberries, so the cultivated raw record is used. Deer dressing runs 51 to 65% and rabbit 47.6 to 57%; the middle is taken. A deer's edible share by "first-class lean" (14 to 17% of live mass) is prime cuts only; all the meat off the bone is used here.

**Pick.**
- kJ per kg of dry matter (USDA SR Legacy energy over dry matter, x 4.184, R290): berry = blackberries raw, 3640 kcal, 15,230 kJ; nut = acorns raw, 5370, 22,470; grain = wild rice raw, 3870, 16,190; mushroom = chanterelle, 3140, 13,140; herb and flower = dandelion greens raw, 3130, 13,100; meat = deer raw, 4550, 19,040; fish = wild rainbow trout raw, 4240, 17,740, x 0.5 for a whole round fish's 50% refuse (R291) = 8,870; fat = lard or tallow, 9020, 37,740. Cooking changes only water; made foods carry their parts' energy by mass (fuel.ts mix).
- Portions [design]: berries 0.25 kg as picked (both hands); grain and nuts 0.05 kg (a handful, the old grain row); meat a 0.5 kg cut, fish a 0.3 kg fish, a mushroom 50 g, fat a 0.5 kg lump (fire-constants sec. 27c's rows, unchanged).
- Picking: blackberries 5.1 kg/h (R292); wild grass seed 1 kg/h of clean grain (Harlan, R293: 2.05 to 2.45 kg of heads an hour, 46% grain). A gathering is 2.5 ticks (12.5 min) of work: 4 portions of berries or 4 handfuls of grain.
- Crops: bramble 0.5 kg/m2 of thicket a year [derived, FoodValues's pick from R294 and R295], a thicket taken as wide as it is tall [design: no crown area found]; the crop sets over half a year of the best growth (plants.ts growth) [design]. A wild cereal stand 75 g/m2 (R296, the middle of 50 to 100), half to each of a tuft's two strippings, over the tuft's width.
- Butchery: dressed 0.55 of live mass (red deer 51 to 65%, R297; rabbit 55.5%, R298, R299). Meat is the dressed mass less bone (deer carcass 0.22, fallow deer dissection, R300; rabbit 0.13, R301) and less carcass fat. Fat is carcass fat (deer 0.0517, the mean of 6.55% winter and 3.79% summer, R303; rabbit 0.035, R302) plus gut and kidney fat, 0.0314 of live mass (R303, the means of the seasons).
- Live masses: red deer 116 kg (the mean of the midpoints of stag 90 to 190 and hind 63 to 120, R304); wolf 41.5 (the mean of 43.6 and 39.3, R305); rabbit 1.6 (1.2 to 2.0, R306); heron 1.5 [sec] (R307); herring gull 0.97 (R308); carrion crow 0.51 (R309); golden eagle 4.38 (the mean of 3.57 and 5.19, R310). The wolf and the birds take a deer's shares [design]. A deer gives 89 cuts and 14 lumps of fat; a rabbit one cut.
- Nut fall stays the old roll [gap: not the trees' measured crop]. The acorn kernel fraction 0.79 (Q. ilex, R311 [ex]) is not applied, since a nut portion is taken as kernels [design].

## 11. Checks

The model's own outputs, run on the code as it stands with the picks above and nothing retuned. All [derived].

- **Resting in cold wind** (Young et al. 1986, R246): naked, at rest, 5 C air, 1 m/s wind, walls at air temperature, 90 min. The model's metabolism is 246 W, 3.4 x the grown body's basal 73 W, against 226 W from Young et al.'s 650 ml/min: within 9%.
- **Nude in severe cold** (Iampietro 1960, R246): -18 C, 4.5 m/s, 60 min. The model's shivering is capped at 4.9 x basal (sec. 3) and fails as the core passes 32 C, giving 308 W and a core of 31.6 C, against Iampietro's about 522 W. The model's peak is the conservative one, Eyolfson's 4.9 x RMR (R242); a body that can make more heat would stay warm longer.
- **A clear still night at 8 C**, naked, 8 h: core 36.86 C, skin 20.1 C.
- The same in a 3 m/s wind: core 36.08 C, skin 12.2 C.
- The same in a hide (3 mm plus 2 cm of hair, covering 0.89 of the body): core 36.83 C, skin 31.9 C.
- **By a fire:** the standard lay's 0.83 kW/m2 at 2 m (fire-constants sec. 31) in 2 C air, naked: skin 31.6 C, warm.
- **Soaked naked skin**, 2 m/s wind, 5 C, 3 h: core 34.9 C, hypothermia beginning.
- **A total fast** at 22 C, 1.5 MET: death of hunger (BMI 12) on day 60, against Leiter and Marliss's 45 to 73 days, mean 61.6 (R285).
- **On the island** (world seed 2, random brain, the first 3 days): naked people spend 22 to 28 MJ a day against 2 to 10 MJ eaten, mostly on shivering, because they start without clothes, fire or shelter. The cold the island's people met before this body was a needs() rate; with real heat loss, the first days' energy budget is the cold's.

## 12. Gaps

From the picks:
- Air leaking through a shelter's walls is left out; the inside air is overstated.
- Lying on cold ground: no conduction to the ground.
- Diffuse sky light on the body is left out; only the beam warms.
- A hide's own wet insulation is not measured; it takes polyester batting's.
- Growth's own energy cost in children is not charged.
- Metabolic adaptation in starvation: REE fell 25 to 32% beyond what the mass lost explains in Minnesota (R233); the model's basal rate follows mass only, which shortens survival on part rations.
- Fever: sickness raises no set point.
- No floor for the brain's glucose (about 113 g/day fed, falling to about 30 g/day once ketones take over; R286 and [ex] secondary figures).
- Afterdrop on rewarming is not modelled (3 to 4 C in popular sources, not seen with oesophageal measurement and modern rewarming, R245).
- The island's year is 40 days, so a child is grown in 40 days of real metabolism.
- Shivering does not depend on glycogen (R247 says shivering lasts 16 h or more unfed, against glycogen-limited models).
- Contact areas between bodies are a design value (sec. 6).
- Exercise stripping muscle insulation is not modelled: work above about 150 W raises limb blood flow and strips the muscle's insulation (R247), about 80% of the variable part above 150 W/m2 (Veicsteinas 1982 as quoted in a 2015 paper [ex]).
- Wind made by walking is not added to the air's.

Inherited from the sources:
- Tikuisis and Giesbrecht 1999 was read in abstract only; the sign of the fat exponent rests on two restatements [ex]; the fit's error and behaviour below a 34 C core are unknown.
- Eyolfson's 4.9 x RMR is [ex].
- Veicsteinas, Ferretti and Rennie 1982 was not read; Kingma's use of it was.
- Scholander 1950's per-species insulation table was not reached (HTTP 403); the linear fur law is [sec].
- No measured clo for any deer winter coat; the hide's insulation is derived from hair depth.
- Roe deer winter pelage depth: no number found.
- Raw deer hide thickness with the hair off: only finished leather (1.5 to 1.9 mm) and generic dermis (1 to 2 mm).
- No quantitative human huddling data; contact conductance between adults unmeasured.
- Swinbank's coefficient is [ex]; the cloud interpolation is a convention, not a measurement; Swinbank under-reads night sky emission by a roughly constant amount.
- ASHRAE Fundamentals itself was not read; the SI respiration equation is [ex], cross-checked against the Fanger form, which was read.
- All heat stroke and heat death thresholds are [ex].
- Absorptivity of skin for flame radiation: ratio 1 assumed (fire-constants sec. 18).
- No Compendium entry for foraging (3.5 to 4.5 MET by fruit picking; FAO's 4.1), flintknapping (2 to 3 MET by carving) or building a shelter (2.5 to 7.0 by carpentry and construction).
- Daan, Beersma and Borbely 1984 is paywalled: every parameter is quoted from Skeldon and Dijk 2025, and the harmonics of the skewed sinusoidal C(t) are [UNVERIFIED].
- Liver glycogen in grams is [sec] (Jensen citing Taylor 1996), though Rothman's concentrations give the same 96 g.
- Essential fat percentages are textbook [ex]; Henry's lethal BMIs are [ex] via ENN.
- Gastric emptying of a fat-rich meal is unmeasured here; the reference meal is low fat, so 90 min is a floor.
- Hall's fat and lean energy densities are [ex].
- Schofield overstates basal rates by 5 to 13% in several non-European groups (R274).
- Kernel fractions: the acorn's 0.79 is single-source (Q. ilex) [ex]; the hazel's 0.50 is dry basis.
- No USDA record for bilberry, raw nettle or a European wild grass seed: wild rice stands in, and hulled wild wheats carry up to 40% husk it doesn't.
- Harlan 1967 is not readable online; his rates are quoted consistently by secondary sources [ex].
- USDA energies are Atwater-calculated, not combustion; fat as lamp fuel uses fire-constants sec. 22b's flame heat, not this.
- Deer fat in kilograms is scaled from 40 kg fallow does; a prime autumn red deer likely carries more.
- No crown area found for a wild bramble or hazel bush.
- The grey heron's mass traces to a handbook compilation with no n.
- Geliebter and Hashim's group means are in paywalled tables; the 1.1 L is secondary.
- No European measured adult survey as a second check on NHANES.

## References

- R225 CDC (2000), Weight-for-age charts, birth to 36 months, LMS parameters and selected smoothed percentiles, wtageinf.csv. https://www.cdc.gov/growthcharts/data/zscore/wtageinf.csv (read 2026-10-11)
- R226 CDC (2000), Weight-for-age charts, 2 to 20 years, LMS parameters and selected smoothed percentiles, wtage.csv. https://www.cdc.gov/growthcharts/data/zscore/wtage.csv (read 2026-10-11)
- R227 CDC (2000), Length-for-age charts, birth to 36 months, LMS parameters, lenageinf.csv. https://www.cdc.gov/growthcharts/data/zscore/lenageinf.csv (read 2026-10-11)
- R228 CDC (2000), Stature-for-age charts, 2 to 20 years, LMS parameters, statage.csv. https://www.cdc.gov/growthcharts/data/zscore/statage.csv (read 2026-10-11)
- R229 WHO Multicentre Growth Reference Study Group, WHO Child Growth Standards: weight-for-age, boys, birth to 5 years (z-scores). https://cdn.who.int/media/docs/default-source/child-growth/child-growth-standards/indicators/weight-for-age/wfa-boys-0-5-zscores.pdf (read 2026-10-11)
- R230 Fryar C.D., Carroll M.D., Gu Q., Afful J., Ogden C.L. (2021), Anthropometric reference data for children and adults: United States, 2015 to 2018, Vital Health Stat 3(46), NCHS. https://www.cdc.gov/nchs/data/series/sr_03/sr03-046-508.pdf (read 2026-10-11)
- R231 Du Bois D., Du Bois E.F. (1916), A formula to estimate the approximate surface area if height and weight be known, Arch Intern Med 17:863-871, as given at https://www.gigacalculator.com/calculators/bsa-calculator.php
- R232 EnergyPlus 8.3 Engineering Reference, Occupant Thermal Comfort (Fanger model, DuBois area, respiration). https://bigladdersoftware.com/epx/docs/8-3/engineering-reference/occupant-thermal-comfort.html (read 2026-10-11)
- R233 Hargrove J.L., Heinz G., Heinz O. (2008), Modeling transitions in body composition: the approach to steady state for anthropometric measures and physiological functions in the Minnesota human starvation study, Dyn Med 7:16 (data from Keys A. et al. 1950, The Biology of Human Starvation). https://pmc.ncbi.nlm.nih.gov/articles/PMC2596786/ (read 2026-10-11)
- R234 Lohman T.G., Normal ranges of body weight and body fat, Human Kinetics excerpt. https://us.humankinetics.com/blogs/excerpt/normal-ranges-of-body-weight-and-body-fat (search excerpt)
- R235 ACSM body composition table. https://mymission.lamission.edu/userdata/ruyssc/docs/ACSM%20Body%20Composition.pdf (search excerpt)
- R236 Tartarini F., Schiavon S. (2020), pythermalcomfort: a Python package for thermal comfort research, SoftwareX 12:100578; two_nodes_gagge.py. https://github.com/CenterForTheBuiltEnvironment/pythermalcomfort/blob/master/pythermalcomfort/models/two_nodes_gagge.py (read 2026-10-11)
- R237 Gagge A.P., Fobelets A.P., Berglund L.G. (1986), A standard predictive index of human response to the thermal environment, ASHRAE Transactions 92(2B):709-731 (not read; as implemented in R236)
- R238 Xu X., Rioux T.P., Castellani M.P. (2023), The specific heat of the human body is lower than previously believed, Temperature. https://pmc.ncbi.nlm.nih.gov/articles/PMC10274559/ (read 2026-10-11)
- R239 Burton A.C. (1935), Human calorimetry: the average temperature of the tissues of the body, J Nutr 9:261-280, as analysed in R238
- R240 Kingma B.R.M., Frijns A.J.H., Schellen L., van Marken Lichtenbelt W.D. (2014), Beyond the classic thermoneutral zone, Temperature 1(2):142-149. https://pmc.ncbi.nlm.nih.gov/articles/PMC4977175/ (read 2026-10-11)
- R241 Tikuisis P., Giesbrecht G.G. (1999), Prediction of shivering heat production from core and mean skin temperatures, Eur J Appl Physiol 79:221-229. https://link.springer.com/article/10.1007/s004210050499 (abstract read); exponent sign from https://aups.org.au/Proceedings/32(2)Suppl.1/41P/ and https://www.researchgate.net/publication/13240945 (search excerpts)
- R242 Eyolfson D.A., Tikuisis P., Xu X., Weseen G., Giesbrecht G.G. (2001), Measurement and prediction of peak shivering intensity in humans, Eur J Appl Physiol 84:100-106. https://link.springer.com/article/10.1007/s004210000329 (search excerpt)
- R243 Haman F., Blondin D.P. (2017), Shivering thermogenesis in humans: origin, contribution and metabolic requirement, Temperature 4(3). https://pmc.ncbi.nlm.nih.gov/articles/PMC5605160/ (search excerpt)
- R244 StatPearls, Hypothermia. https://www.ncbi.nlm.nih.gov/sites/books/NBK545239/ (search excerpt)
- R245 Brown D.J.A., Brugger H., Boyd J., Paal P. (2012), Accidental hypothermia, N Engl J Med 367:1930-1938. https://emcrit.org/wp-content/uploads/2012/02/nejmra1114208.pdf (read 2026-10-11)
- R246 Young A.J., Sawka M.N., Pandolf K.B. (1996), Physiology of cold exposure, ch. 7 in Institute of Medicine, Nutritional Needs in Cold and High-Altitude Environments, National Academies Press, doi:10.17226/5197 (Fig. 7-6; citing Young et al. 1986 and Iampietro et al. 1960). https://www.nationalacademies.org/read/5197/chapter/12 (read 2026-10-11)
- R247 Golden F., Tipton M., Essentials of Sea Survival, ch. 7, Survival time in cold water. https://www.nanaimoflyingclub.org/wp-content/uploads/2018/12/Chapter-7-Survival-Time-in-Cold-Water.pdf (read 2026-10-11)
- R248 de Dear R.J., Arens E., Zhang H., Oguro M. (1997), Convective and radiative heat transfer coefficients for individual human body segments, Int J Biometeorol 40:141-156. https://escholarship.org/content/qt9hn3s947/qt9hn3s947.pdf (read 2026-10-11)
- R249 Cramer M.N., Jay O. (2019), Partitional calorimetry, J Appl Physiol 126:267-277. https://pmc.ncbi.nlm.nih.gov/articles/PMC6397408/ (read 2026-10-11)
- R250 Swinbank W.C. (1963), Long-wave radiation from clear skies, Q J R Meteorol Soc 89:339-348, doi:10.1002/qj.49708938105. https://rmets.onlinelibrary.wiley.com/doi/10.1002/qj.49708938105 (abstract read; coefficient via https://www.researchgate.net/publication/282972927, search excerpt)
- R251 Sky effective temperature correlations as applied in https://arxiv.org/pdf/1312.1295 (search excerpt)
- R252 IBPSA Building Simulation 2017, paper BS2017_569 (cloud correction of sky emissivity). https://publications.ibpsa.org/proceedings/bs/2017/papers/BS2017_569.pdf (search excerpt)
- R253 Di Napoli C., Hogan R.J., Pappenberger F. (2020), Mean radiant temperature from global-scale numerical weather prediction models, Int J Biometeorol 64:1233-1245. https://pmc.ncbi.nlm.nih.gov/articles/PMC7295834/ (read 2026-10-11)
- R254 New energy-efficient building concepts affecting human thermal comfort, Proc. Building Simulation 2009, eq. 4 (quoting ASHRAE Fundamentals 1997). https://publications.ibpsa.org/proceedings/bs/2009/papers/bs2009_1468_1475.pdf (search excerpt)
- R255 Hayward J.S., Eckerson J.D. (1984), Physiological responses and survival time prediction for humans in ice-water, Aviat Space Environ Med 55:206-212. https://pubmed.ncbi.nlm.nih.gov/6721816/ (abstract)
- R256 Leclerc C., Giesbrecht G.G. (2023), One cool guy: scientific contributions of John Hayward, cold water pioneer, Wilderness Environ Med. https://www.sciencedirect.com/science/article/pii/S1080603223000522 (search excerpt)
- R257 Burton A.C., Edholm O.G. (1955), Man in a Cold Environment, Arnold, via https://en.wikipedia.org/wiki/Clothing_physiology and DTIC ADA031488 https://apps.dtic.mil/sti/pdfs/ADA031488.pdf (search excerpts)
- R258 The insulative value of mouse fur (1967), Q J Exp Physiol 52:168-173, doi:10.1113/expphysiol.1967.sp001899 (search excerpt)
- R259 Scholander P.F., Walters V., Hock R., Irving L. (1950), Body insulation of some arctic and tropical mammals and birds, Biol Bull 99:225-236, as summarised in Prestrud P. (1991), Adaptations by the arctic fox to the polar winter, Arctic, https://journalhosting.ucalgary.ca/index.php/arctic/article/download/64583/48497/183974 , and as quoted by Hofmeyr M.D., Thermal properties of the pelages of selected African ungulates, https://www.ajol.info/index.php/az/article/download/152914/142506/0
- R260 Yoder D., Blood J., Mason R. (2005), How warm were they? Thermal properties of rabbit skin robes and blankets, J California and Great Basin Anthropology 25(1):55-68. https://escholarship.org/content/qt1jk440gg/qt1jk440gg.pdf (read 2026-10-11)
- R261 Heat loss through wet clothing insulation. https://www.researchgate.net/publication/235169542 (search excerpt)
- R262 Holmer I. (1985), Heat exchange and thermal insulation compared in woollen and nylon garments during wear trials, Textile Res J 55:511. https://journals.sagepub.com/doi/10.1177/004051758505500901 (search excerpt)
- R263 Seasonal coat changes in grazing red deer (Cervus elaphus), and Structure and seasonal change in the coat of red deer. https://www.researchgate.net/publication/229771119 ; https://www.researchgate.net/publication/230187663 (search excerpts)
- R264 Wildlife Online, Red deer appearance (citing Kay). https://www.wildlifeonline.me.uk/animals/article/red-deer-appearance
- R265 NZ Luxury Group, New Zealand deer leather, red (thickness specification). https://www.nzluxurygroup.com/product-page/new-zealand-deer-red
- R266 Huddling in Brandt's voles (metabolic rate and thermal conductance). https://www.ncbi.nlm.nih.gov/pmc/articles/PMC5968109/ (search excerpt)
- R267 One for all and all for one: the energetic benefits of huddling in endotherms. https://www.researchgate.net/publication/40811695 (search excerpt)
- R268 Bouchama A., Knochel J.P. (2002), Heat stroke, N Engl J Med 346:1978-1988, as stated in https://www.ncbi.nlm.nih.gov/pmc/articles/PMC5964884/ (search excerpt)
- R269 NAEMSP (2022), Consensus statement: prehospital care of exertional heat stroke. https://naemsp.org/2022-7-13-article-bites-41-consensus-statement-prehospital-care-of-exertional-heat-stroke/ (search excerpt)
- R270 Vanos J. et al. (2023), A physiological approach for assessing human survivability and liveability to heat in a changing climate. https://pmc.ncbi.nlm.nih.gov/articles/PMC10687011/ (search excerpt)
- R271 Henry C.J.K. (1990), Body mass index and the limits of human survival, Eur J Clin Nutr 44:329-335, and James W.P.T. et al. (1988), as reported in ENN Field Exchange 15, The limits of human starvation. https://www.ennonline.net/fex/15/en/limits-human-starvation (search excerpt)
- R272 Collins S. (1995), The limit of human adaptation to starvation, Nat Med 1:810-814. https://www.nature.com/articles/nm0895-810 (search excerpt)
- R273 FAO/WHO/UNU (2004), Human energy requirements: report of a joint FAO/WHO/UNU expert consultation, ch. 5 (Table 5.1 PARs, Table 5.2 Schofield). https://www.fao.org/4/y5686e/y5686e07.htm (read 2026-10-11)
- R274 Torun B. et al., Energy requirements and dietary energy recommendations for children and adolescents, UNU Press (Tables 8 to 10). https://archive.unu.edu/unupress/food2/UID01E/UID01E0K.HTM (read 2026-10-11)
- R275 Ainsworth B.E. et al. (2011), 2011 Compendium of Physical Activities: a second update of codes and MET values, Med Sci Sports Exerc 43:1575-1581, supplement table. https://cdn-links.lww.com/permalink/mss/a/mss_43_8_2011_06_13_ainsworth_202093_sdc1.pdf (read 2026-10-11)
- R276 Herrmann S.D., Ainsworth B.E. et al., 2024 Adult Compendium of Physical Activities, Occupation category. https://pacompendium.com/occupation/ (read 2026-10-11)
- R277 Byrne N.M. et al. (2005), Metabolic equivalent: one size does not fit all, J Appl Physiol 99:1112-1119. https://journals.physiology.org/doi/full/10.1152/japplphysiol.00023.2004 (search excerpt)
- R278 Jensen J. et al. (2011), The role of skeletal muscle glycogen breakdown for regulation of insulin sensitivity by exercise, Front Physiol 2:112. https://pmc.ncbi.nlm.nih.gov/articles/PMC3248697/ (read 2026-10-11)
- R279 Rothman D.L., Magnusson I., Katz L.D., Shulman R.G., Shulman G.I. (1991), Quantitation of hepatic glycogenolysis and gluconeogenesis in fasting humans with 13C NMR, Science 254:573-576. https://www.science.org/doi/10.1126/science.1948033 (search excerpt; numbers via https://www.endocrine.org/~/media/endosociety/files/ep/rphr/56/rphr_vol_56_ch_11_nuclear_magnetic_resonance_studies.pdf)
- R280 Hall K.D. (2008), What is the required energy deficit per unit weight loss?, Int J Obes 32:573-576. https://www.nature.com/articles/0803720 (search excerpt)
- R281 Horton T.J. et al. (1995), Fat and carbohydrate overfeeding in humans: different effects on energy storage, Am J Clin Nutr 62:19-29. https://www.researchgate.net/publication/15601204_Fat_and_carbohydrate_overfeeding_in_humans_Different_effects_on_energy_storage (search excerpt)
- R282 Tougas G. et al. (2000), Assessment of gastric emptying using a low fat meal: establishment of international control values, Am J Gastroenterol 95:1456-1462. https://pubmed.ncbi.nlm.nih.gov/10894578/ (abstract read)
- R283 Normal gastric emptying scintigraphy values for limited meal ingestion (2025), Dig Dis Sci. https://link.springer.com/article/10.1007/s10620-025-08883-6 (search excerpt)
- R284 Geliebter A., Hashim S.A. (2001), Gastric capacity in normal, obese, and bulimic women, Physiol Behav 74:743-746, doi:10.1016/s0031-9384(01)00619-9 (abstract read via Europe PMC; the 1.1 L figure from secondary literature)
- R285 Leiter L.A., Marliss E.B. (1982), Survival during fasting may depend on fat as well as protein stores, JAMA 248:2306-2307. https://jamanetwork.com/journals/jama/fullarticle/379609 (search excerpt; durations via https://go.gale.com/ps/i.do?id=GALE%7CA132748256)
- R286 Mergenthaler P., Lindauer U., Dienel G.A., Meisel A. (2013), Sugar for the brain: the role of glucose in physiological and pathological brain function, Trends Neurosci 36:587-597. https://pmc.ncbi.nlm.nih.gov/articles/PMC3900881/ (read 2026-10-11)
- R287 Skeldon A.C., Dijk D.-J. (2025), The complexity and commonness of the two-process model of sleep regulation from a mathematical perspective, npj Biol Timing Sleep 2:24. https://www.nature.com/articles/s44323-025-00039-z (read 2026-10-11)
- R288 Borbely A.A., Daan S., Wirz-Justice A., Deboer T. (2016), The two-process model of sleep regulation: a reappraisal, J Sleep Res 25:131-143. https://www.chronobiology.ch/wp-content/uploads/2019/05/Borb%C3%A9lyJSR2016.pdf (read 2026-10-11)
- R289 Daan S., Beersma D.G.M., Borbely A.A. (1984), Timing of human sleep: recovery process gated by a circadian pacemaker, Am J Physiol 246:R161-R178. https://pubmed.ncbi.nlm.nih.gov/6696142/ (not read, paywalled; parameters via R287)
- R290 USDA ARS (2019), FoodData Central, SR Legacy records 173946, 170157, 170565, 170566, 169726, 168897, 168422, 169226, 173855, 175085, 175154, 175155, 171401, 171400 (nutrients 208 energy and 255 water). https://api.nal.usda.gov/fdc/v1/food/173946 and the like (read 2026-10-11)
- R291 FAO, Food composition table, refuse in A.P. (as purchased). https://www.fao.org/4/x5557E/x5557e0o.htm (read 2026-10-11)
- R292 UC Cooperative Extension (2008), Sample costs to establish and produce blackberries, Central Coast, BK-CC-08. https://coststudyfiles.ucdavis.edu/uploads/cs_public/92/59/92598f68-3c4e-4da3-88eb-cb9ba3108d18/blackberrycc_2008.pdf (search excerpt)
- R293 Harlan J.R. (1967), A wild wheat harvest in Turkey, Archaeology 20:197-201 (record https://core.tdar.org/document/415588/a-wild-wheat-harvest-in-turkey; figures as quoted at https://www.hurriyetdailynews.com/opinion/aylin-oney-tan/wandering-wheat--115026) (search excerpt)
- R294 Southern Region Small Fruit Consortium, Commercial bramble culture. https://smallfruits.org/files/2019/06/commercial-bramble-culture.pdf (search excerpt)
- R295 Balkan Ecology Project, Rubus fruticosus cv. plant profile. https://www.balkep.org/rubus-fruticosus-cv.html (search excerpt)
- R296 Ohlrau R. et al., Productivity of pre-modern agriculture in the Cucuteni-Trypillia area, arXiv:1505.05121 (citing Araus et al. 2007). https://arxiv.org/pdf/1505.05121 (search excerpt)
- R297 FAO, Deer farming manual, Deer products (dressing-out percentages). https://www.fao.org/4/x6529e/X6529E08.htm (search excerpt)
- R298 Comparing Saudi synthetic lines of rabbits with the founder breeds for carcass, lean composition and meat quality traits, Livest Res Rural Dev 20(5). https://www.lrrd.org/lrrd20/5/saef20065.htm (search excerpt)
- R299 Pla M. et al. (1997), Carcass characteristics and meat quality of rabbit lines selected for different objectives: I. Between lines comparison, Livest Prod Sci. https://www.sciencedirect.com/science/article/abs/pii/S0301622697001796 (search excerpt)
- R300 Carcass characteristics of farmed fallow deer bucks (2015), Ann Anim Sci. https://reference-global.com/2/v2/download/pdf/10.1515/aoas-2015-0045 (search excerpt)
- R301 Dalle Zotte A. (2002), as cited in Growth, carcass and meat quality traits of straightbred and crossbred Botucatu rabbits. https://www.researchgate.net/publication/50841087 (search excerpt)
- R302 Carcass composition and meat characteristics of two rabbit breeds of different degrees of maturity (1996), Meat Sci. https://www.sciencedirect.com/science/article/abs/pii/S0309174096000794 (search excerpt)
- R303 Ludwiczak A. et al. (2023), Seasonal variation in the body composition, carcass composition, and offal quality in the wild fallow deer, Animals 13:1082. https://pmc.ncbi.nlm.nih.gov/articles/PMC10044600/ (read 2026-10-11)
- R304 British Deer Society, Red deer. https://bds.org.uk/information-advice/about-deer/deer-species/red-deer/ (read 2026-10-11)
- R305 Nowak S., Myslajek R.W., Jedrzejewska B. et al., Prey choice and diet of wolves related to ungulate communities and wolf subpopulations in Poland. https://www.researchgate.net/publication/234054156 (search excerpt)
- R306 Mammal Society, European rabbit. https://mammal.org.uk/british-mammals/european-rabbit (search excerpt)
- R307 BTO BirdFacts, Grey heron (biometrics from Cramp and Perrins 1994). https://www.bto.org/learn/about-birds/birdfacts/grey-heron (read 2026-10-11)
- R308 BTO BirdFacts, Herring gull, biometrics from the BTO Ringing Scheme. https://www.bto.org/learn/about-birds/birdfacts/herring-gull (read 2026-10-11)
- R309 BTO BirdFacts, Carrion crow, biometrics from the BTO Ringing Scheme. https://www.bto.org/learn/about-birds/birdfacts/carrion-crow (read 2026-10-11)
- R310 Birds of the World, Cornell Lab of Ornithology, Golden eagle: plumages, molts and structure. https://birdsoftheworld.org/bow/species/goleag/cur/appearance (search excerpt)
- R311 Rodriguez-Estevez V. et al. (2009), Intrinsic factors of acorns that influence the efficiency of their consumption by Iberian pigs, Livest Sci. https://www.sciencedirect.com/science/article/abs/pii/S1871141308003028 (search excerpt)
