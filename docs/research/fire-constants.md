# Fire physics constants, with sources

Research for docs/brainstorms/2026-10-07-fire-physics-requirements.md and its plan. Every constant the fire model uses comes from this table, fixed before the success criteria are checked; a criterion that fails with these values is a gap in the model, not something to retune. Collected 2026-10-07. Sections 10 to 26 were added for Unit 1 of docs/plans/2026-10-07-001-feat-fire-heat-physics-plan.md: the constants its later units name, and a check of the picks against a year of the sim's own weather.

How each value was obtained:
- [read]: I read it in the primary or full-text source.
- [sec]: I read it in a secondary source that cites the original.
- [ex]: I saw it only in a search excerpt or abstract. The value is real, but I didn't see its context.
- [derived]: my arithmetic on cited inputs.
- [UNVERIFIED]: I couldn't confirm it.

Ref keys (R#) are listed at the end with title and URL or DOI.

## 1. Piloted ignition of wood

| Quantity | Value | Units | Conditions | Source |
|---|---|---|---|---|
| Tig, direct flaming (medium flux) | 300 to 365 overall; hardwoods 300 to 311, softwoods 349 to 364 (Janssens, oven-dry) | C | Radiant, piloted, side-grain (see the naming flag below) | R1 [read] |
| Tig at minimum flux (glowing first) | about 250 | C | Barely enough heating; glowing then flaming | R1 [read] |
| Tig rise with moisture | +2 C per 1% MC | C/% | Medium flux, piloted (Janssens) | R1 [read] |
| Tig unchanged by moisture | constant, dry vs moist spruce | - | Cone heater | R7 [ex] |
| Tig, kρc, q_crit by species, across grain (Spearpoint data) | Redwood 375 C / 0.22 / 15; Douglas-fir 384 / 0.25 / 16; red oak 305 / 1.0 / 11; maple 354 / 0.67 / 14 | C; (kW/m2K)^2 s; kW/m2 | 50 mm thick, MC 5 to 10%; q_crit derived from fit (measured 12 to 13) | R2 Table 7.3 [read] |
| Same, along grain | Tig 150 to 275, kρc 1.4 to 11, q_crit 4 to 9 | as above | Fit artifacts; do not use | R2 [read] |
| Apparent kρc vs ambient kρc | apparent is 1.6 to 2.0 times ambient (pick 1.8) | - | 4 species, OSU apparatus, h_ig about 31 W/m2K | R5 [read] |
| Critical heat flux, piloted | 11.0 (fit); 12.5 (McGuire, design); 10 to 13 (review); 12 +/- 2 | kW/m2 | Test durations 10 to 60 min | R1, R14 [read] |
| CHF, end grain | 7.5 (maple) | kW/m2 | Spearpoint | R1 [read] |
| CHF, very long exposure | 4.3 (plywood, over 5 h) | kW/m2 | Single study | R1 [read] |
| CHF, autoignition | 25 to 33; about 20 short-term | kW/m2 | Unpiloted | R1, R14 [read] |
| Empirical ignition time, all woods | t_ig = 130 ρ^0.73 / (q_e - 11.0)^1.82 | s, kg/m3, kW/m2 | Cone, horizontal or vertical, 0% or room MC; RMS error 64% | R1 [read] |
| Ignition time with an impinging flame face | t_ig = 41.3 ρ^0.94 q_e^-1.82 (no critical flux) | s, kg/m3, kW/m2 | Ebeling & Welker; flame on the whole face | R1 [read] |
| Impinging pilot flame minimum flux | 5 | kW/m2 | Western red cedar, Douglas-fir | R1 [read] |
| Thermally thick | t = (π/4) kρc (Tig - T0)^2 / (q_e - χ q_cr)^2; χ = 1.0 recommended (Delichatsios used 0.64) | s | Constant flux | R4 [read] |
| Thermally thin | t = ρ c d (Tig - T0) / (q_e - χ q_cr) | s | d = thickness heated (one side) | R4 [read]; same form in R63 [ex] |
| Thin vs thick criterion | τ_th = 4 ρ c d^2 / (π k); thin if t_ig > τ_th, thick if t_ig < τ_th; blended form: t = [(x/τ_th^(1/2))^4 + (x)^8]^(-1/4)-type interpolation (Eq. 7) | s | Exponents 1/4, 4, 8 fit an exact solution | R4 [read] |
| Thin criterion (Biot) | Bi = hL/k < 0.1 | - | Wildland particles of any shape | R62 [ex] |
| Thick ignition with moisture | kρc = k0ρ0c0 (1 + 5m)(1 + 2.1m)(1 + m), about k0ρ0c0 (1 + 8.1 m) | - | m = fractional MC; from Simms & Law | R4 [read] |
| Thin ignition with moisture | t_wet = t_dry (1 + γ m); γ = [c_w (T_b - T0) + L_w] / [c (Tig - T0)]; measured 5.0, predicted 5.14 | - | Corrugated board, MC 4 to 12.5% | R4 [read] |
| Mikkola moisture correlation | t_wet = t_dry (1 + 4 MC)^2 | - | Thick wood | R7 [ex] |
| Moghtaderi moisture correlation | predicts about 2.4 times longer than Mindykowski's | - | Coefficient not seen | R7 [ex] |
| Ambient thermal conductivity, across grain | k = G (0.1941 + 0.004064 x) + 0.01864 | W/mK | x = MC %, x < 25%; along grain 1.5 to 2.8 times (avg 1.8) | R6 [read] |
| Dry heat capacity | c_p0 = 0.1031 + 0.003867 T | kJ/kgK, T in K | | R6 [read] |
| Moist heat capacity | c = (c_p0 + 0.01 x c_w)/(1 + 0.01 x) + A_c; A_c = x(b1 + b2 T + b3 x), b1 = -0.06191, b2 = 2.36e-4, b3 = -1.33e-4 | kJ/kgK | Below fiber saturation; free water above FSP by mixture rule | R6 [read; leading term truncated in extraction, UNVERIFIED] |
| Thermal diffusivity | about 1.6e-7 | m2/s | Typical wood | R6 [read] |

Checks I ran [derived]:
- Douglas-fir, G 0.5, 12% MC: k = 0.140, c about 1.66, so ambient kρc is about 0.116 (kW/m2K)^2 s. Times 1.8 (R5) gives 0.21, which matches R2's across-grain 0.22 to 0.25. The sources hang together.
- Thick formula with kρc 0.22, Tig 350 C, q_cr 11, χ = 1: 96 s at 25 kW/m2 and 12 s at 50.
- Babrauskas correlation at ρ 500 kg/m3: 99 s and 15 s. These are the brainstorm's "100 s / 15 s". Agreement is good.
- R2's Douglas-fir set (0.25, 384 C, q_cr 16) gives 320 s at 25 kW/m2 and 22 s at 50. Its derived q_cr is high, so it disagrees at low flux.
- Thin example: 0.5 mm shaving, ρ 450, c 1.6. τ_th is about 1.9 s; t_ig at 100 kW/m2 is about 1.2 s, so it sits between thin and thick (use R4's Eq. 7). For a cylinder heated all round, use d = r/2, the volume-to-surface ratio. [derived]

Disagreements:
- Grain-direction naming. Babrauskas's "along-grain" (the usual test, CHF 12.5) is the side face. Quintiere/Spearpoint call that same exposure "across" (heat flow across the fibers) and use "along" for end-grain-like heating. Use R2's across-grain row for the side of a stick or log.
- Tig: 250 C (minimum flux) vs 350 C (flaming). Glowing at low flux is real, and R8 uses 523 K as the minimum for fine fuels.

Picks:
- Tig 350 C softwood, 305 C hardwood. Apparent kρc 0.22 (kW/m2K)^2 s, scaled by (1 + 8.1 m) for moisture.
- q_cr 11 kW/m2 inside the formula, and no ignition below 12 kW/m2.
- χ = 1, with R4's Eq. 7 for the thin-to-thick transition.
- Reason: this set reproduces Babrauskas's empirical correlation (64% RMS over 2.5 to 4200 s) within about 20%.

## 2. Fine fuels, flame contact, flame radiation

| Quantity | Value | Units | Conditions | Source |
|---|---|---|---|---|
| Heat flux in and above a candle flame | 145 at the flame tip; 105 and 90 at 18 and 38 mm above the tip; about 10 at 260 mm above the base | kW/m2 | Paraffin taper, HRR 77 +/- 9 W, flame height 42 mm, water-cooled gauge | R10 [read] |
| Candle maximum flame temperature | 1400 | C | Literature value in Table 1 | R10 [read] |
| Radiation-only ignition of fine fuels | Particles under 0.7 mm diameter are unlikely to ignite by radiation alone. In still air (buoyant cooling only), about 50 kW/m2 irradiance reaches 523 K. Even 1 m/s wind cools a particle by more than 200 K at over 100 kW/m2. An optically thick flame would need about 900 K. | - | Excelsior 0.44 and 1.29 mm, ponderosa pine needles 0.70 mm; model plus experiment | R8 [read] |
| Peak irradiance in wildland fires | surface fires 100; shrub 132; crown 200 and 300; convective heating from 15% of radiative to more than radiative | kW/m2 | 13 field fires | R11 [ex] |
| Crown fire heat flux | average peak 200, maximum 290 | kW/m2 | Butler et al. 2004, as cited | R8 [sec] |
| Mechanism | Fine fuels ignite by intermittent flame contact driven by buoyant vortices; radiation alone is insufficient | - | Lab and field | R9 [ex], R8 [read] |
| Radiation share of the heat needed for spread | at most 40% | - | Anderson 1969 | R21 [sec] |
| Forced-convection h vs size | 24.5 W/m2K (12.7 mm) vs 34.8 W/m2K (6.4 mm cylinder), both at 0.7 m/s; scales about as d^-1/2 | W/m2K | Churchill-Bernstein | R19 [read] |
| Flame emissivity | ε = 1 - exp(-κ L) | - | L = flame thickness | R12 [read] |
| κ, wood cribs (Hägglund & Persson 1976) | 0.8 | 1/m | 16 tests, flame thickness 0.15 to 2 m, flame temperature 650 to 1030 C, ε 0.12 to 0.94 | R12 [read] |
| κ, wood cribs (Beyreis 1971) | 0.51 | 1/m | | R12 [read] |
| κ, oak-leaf bed fire (Telisin 1974) | 0.16 | 1/m | MC 12 to 34% | R12 [read] |
| Typical fire gas temperatures | 900 to 1100 | C | Drysdale, as cited | R14 [sec] |
| Char vs wood emissivity | about 0.95 vs 0.7 | - | Kashiwagi, as cited | R14 [sec] |

Checks [derived]: at κ 0.8 and a 1173 K flame, σT^4 is about 107 kW/m2. A 0.1 m flame then emits about 8 kW/m2, a 0.5 m flame 35, a 1 m flame 59, a 2 m flame 85.

Disagreements:
- κ ranges 0.16 to 0.8, and R12's own forest-fuel tests showed emissivity rising faster with thickness than any of the literature curves.
- Contact flux does not follow from radiation for small flames. A candle gives 90 to 145 kW/m2 by convection at 77 W, while the radiation-only estimate for a thin flame is under 10.

Picks:
- κ 0.8 1/m for wood flames; it comes from wood cribs, the closest analogue to a campfire bed.
- Contact heating of fine fuel: about 100 kW/m2 in any visible flame. This is anchored on the candle (R10) and the 100 kW/m2 surface-fire peak (R11). It is roughly independent of flame size, because the convective coefficient depends on particle size (d^-1/2), not flame size.
- Radiation-only ignition: thick fuel needs q above 12 kW/m2; fine fuel needs about 50 kW/m2 and still air (R8). A campfire never reaches that at a distance, so it lights only what it touches.

## 3. Burning

| Quantity | Value | Units | Conditions | Source |
|---|---|---|---|---|
| Char rate, standard furnace | β0 0.65 (softwood and beech, solid or glulam, ρk ≥ 290); hardwood 0.50 to 0.55 (dense oak 0.5) | mm/min | ISO 834 exposure; EN 1995-1-2 Table 3.1 | R16 [sec] |
| Char rate, furnace meta-analysis | horizontal 0.70 +/- 0.14, vertical 0.63 +/- 0.11 | mm/min | Standard time-temperature curve | R14 [read] |
| Char rate vs moisture | about 0.6 at 9% MC to 0.37 at 20% MC | mm/min | Njankouo, furnace | R14 [read] |
| Char rate vs heat flux, spruce | 0.24, 0.48, 0.59, 0.69 at 10, 15, 20, 25 kW/m2 | mm/min | 1800 s exposure, IR heater | R17 [read] |
| Butler 1971 linear law | 0.28 at 10 kW/m2 and 0.42 at 15, so β ≈ 0.028 q | mm/min | Coefficient back-calculated from R17's reported values | R17 [read]; coefficient [derived] |
| Heavy timber in real room fires | 0.5 to 0.8 | mm/min | Babrauskas 2005, as cited | R58 [sec] |
| Flaming residence time of a particle in a burning bed | t_r = 8 d (d in inches), i.e. t_r = 384/σ (σ in 1/ft) | min | Uniform fuel arrays, spreading fire (Anderson 1969) | R21 [sec] |
| Implied regression in a bed | about 1.6 mm/min of radius (25 mm stick, 8 min) | mm/min | | [derived] |
| Effective heat of combustion, flaming | 12 to 15 MJ/kg (cone, 65 kW/m2); volatiles average 13.8 (10.6 to 15.5, Parker & LeVan); 12.5 (sugar-pine cribs, FM) | MJ/kg of mass lost | Flaming period only | R13 [read] |
| Effective heat of combustion by species | Douglas-fir 13; redwood 12; red oak 12; maple 13 | kJ/g | | R2 [read] |
| Effective heat of combustion vs moisture | Δh_eff = 16.52 - 0.057 MC | MJ/kg, MC % | Whole Douglas-fir trees, foliar MC 2 to 154% | R13 [read] |
| Char (glowing) heat of combustion | about 30 (cone); pure carbon 32.8; beech charcoal 34.31 gross, 33.98 net | MJ/kg | | R13 [read] |
| Bomb (complete) heat of combustion | conifers 19.2 to 21.8 gross, 17.8 to 20.4 net; Douglas-fir 19.7 gross, 18.3 net; review 17.5 +/- 2.5 | MJ/kg | | R13, R14 [read] |
| Effective as a fraction of bomb value | about 65% | - | Wood Handbook ch. 18 | R59 [ex] |
| Char yield | Douglas-fir 0.25 +/- 0.07 (along) and 0.45 +/- 0.15 (across) | kg char per kg wood | Cone | R2 [read] |
| Char density | about 20% of virgin wood | - | Friquin, as cited | R14 [sec] |
| Heat of gasification L | Douglas-fir 12.5 across, 6.8 along; redwood 9.4; red oak 9.4; maple 4.7 | kJ/g | From peak m'' vs flux | R2 [read] |
| Heat of gasification, other value | 1.82 | kJ/g | Tewarson & Pion, as cited | R14 [sec] |
| Burning mass flux | m'' = (q_e + q_f - q_loss) / L | g/m2s | | R14 [read] |
| Critical mass flux to keep flaming | 2.5 to 5 (review); 2.5 (Bamford 1946); 4 to 5 (B-number estimate) | g/m2s | | R14 [read] |
| Extinction thresholds, timber | m''_cr 2.7 to 8.3 g/m2s; external flux 24 to 57 kW/m2 by species | | Emberley 2017, 6 timbers | R15 [ex] |
| Extinction thresholds, CLT | 3.5 g/m2s, 31 kW/m2 | | Bartlett 2017 | R15 [ex] |
| Flux to sustain flame over 10 min | 31.5 | kW/m2 | Hottel 1942, 25 mm spruce | R53 [sec] |
| Thick wood after irradiation stops | 50 mm oak or pine at 30 kW/m2 or less goes out in 2 to 7 min (char 4 to 8 mm); at 50 kW/m2 it burns on | - | Bamford | R53 [sec] |
| Panel heated one side | no self-sustained flaming if over 3 mm thick | - | Bamford | R53 [sec] |
| Two facing panels | flaming stops if the gap is over 51 mm (229 mm panels) or over 127 mm (914 x 381 mm); view factor about 0.65 | - | Bamford | R53 [sec] |
| Single stick lit at the base | self-sustains only to about 19 mm thick (vertical); 12 mm is too thick horizontally | - | Bryan | R1 [read] |
| Upward flame spread on a plate | self-extinguishes above about 7.5 mm thick with no irradiation; no self-extinction above 15 kW/m2 irradiation | - | Plates 1 to 30 mm | R54 [ex] |
| Large-fuel crib (sticks 5 cm or thicker) | flaming not sustained when edge-to-edge gap exceeds 3 times thickness (Albini's burnout model uses 2.23) | - | | R20 [read] |
| Large-fuel crib burning flux | max 7.8 g/m2s at porosity about 0.22; steady surface-controlled 6.2 g/m2s | g/m2s of exposed surface | | R20 [read] |
| Smoldering, single vs adjacent pieces | single 19.1 or 25.4 mm dowels never sustain smoldering; two or three touching dowels can | - | Wind 0.2 to 1.5 m/s | R47 [read] |
| Heskestad crib correlation | 10^3 R / (A_s b^-1/2) = 1 - exp(-50 φ); φ = s^1/2 b^1/2 A_v/A_s | R g/s, lengths cm | Loose regime gives R/A_s = 1.0e-3 b^-1/2 g/cm2s (fitted constant 1.08); overpredicts 1.6 mm sticks by 44% | R18, R19 [read] |
| Block loose-regime law | R/A_s = C b^-1/2 | | | R18 [read] |
| Thomas form | 100 R / (A_s ρ0 (g h)^0.5) = 0.85 W^0.97 (refit); W = 4 s h / s^2-type shaft ratio | | | R18 [read] |
| Wildland crib with a ground gap | R = R_pred [1 - 0.277 ln(l/b) exp(-0.565 d)] | d in cm | | R18 [read; form partly garbled] |
| Moisture effect on burning rate | 10% MC change gives 20 to 30% change | - | | R5 [read] |

Check on stick size [derived]: Heskestad's loose-regime flux is 10 b^-1/2 g/m2s with b in cm.
- 1 cm sticks: 10 g/m2s. At ρ 450 that is about 1.3 mm/min of regression.
- 4 cm: 5 g/m2s.
- 10 cm: 3.2 g/m2s, which is at the 2.5 to 5 g/m2s extinction threshold.

So flux per unit area falls as thickness grows, and only feedback from neighbours keeps a log above extinction. That is the lone-log result arising from published correlations alone.

Disagreements:
- Burning rate 0.24 to about 1.6 mm/min, depending on the flux the piece receives. Use the β = f(q) law rather than one constant.
- Heat of combustion: 12 to 15 MJ/kg flaming vs 17 to 20 bomb. The brainstorm's "15 to 18 MJ/kg" mixes the two.
- L: 1.8 vs 6.8 to 12.5 kJ/g. Quintiere's value is an effective one that includes char losses.
- Extinction flux: 24 to 57 kW/m2 vs 31 kW/m2.

Picks:
- Flaming gives 13 MJ per kg of volatiles; char gives 30 MJ/kg.
- Char yield 0.25. Superseded by section 16: 0.45, the across row.
- Regression β = 0.028 q (mm/min, q kW/m2 net to the surface), capped near 1.6 mm/min in a bed. This gives 0.65 mm/min at about 23 kW/m2, which matches the furnace value. Superseded by section 16: β is derived from m'' and the char yield, about 0.019 q.
- A piece keeps flaming only while m'' = (q_in - q_loss)/L stays at or above about 3.5 g/m2s, using the CLT and review midpoint. L was 6.8 kJ/g (R2's lower value); section 16 replaces it with the across row, 12.5 softwood and 9.4 hardwood.

## 4. Flames: height, tilt, blow-off

| Quantity | Value | Units | Conditions | Source |
|---|---|---|---|---|
| Mean flame height (Heskestad) | L = 0.235 Q^(2/5) - 1.02 D | m, kW, m | Mostly pool and gas data; also used for cribs | R22 [sec] |
| Flame tilt (Thomas, wood cribs) | cos θ = 0.7 u*^-0.49; u* = u / (g m'' D / ρa)^(1/3) | - | Thomas 1963/1965 | R23 [ex] |
| Flame tilt (AGA) | cos θ = 1 if u* ≤ 1, else u*^-1/2 | - | Large gas pool fires | R23 [ex] |
| Wind drags the flame base | maximum drag at Fr = u / (g D)^1/2 = 2.5 | - | Large pool fires | R61 [ex] |
| Blow-off of small flames | 2 m/s (flame spreading on thin wire); 3 m/s (thin paper, or a wake flame behind plastic). Bigger flames need more wind. Critical Damköhler number about 1. | m/s | As cited by Xiong et al. | R24 [ex] |
| Envelope flame on small wood brands | blown off at 0.5 to 1.0 m/s airflow (25 and 50 mm disks), leaving a glowing brand | m/s | | R26 [read] |
| Stagnation strain rate on a cylinder | a = 2U/R, so at a fixed extinction strain, U_ext scales with R | 1/s | Tsuji burner | R25 [ex] |
| Wind on crib burning | 1.27 cm sticks: rate up 6.5 to 61.5%, in proportion to wind (0 to 0.7 m/s). 0.64 cm sticks: rate down 36.7 to 60.6%. | - | | R19 [read] |
| Air blown into a burning bed | up to 6 times the still-air burning rate (Grumer & Strasser) | - | Wood cubes 2 to 9 cm | R19 [read] |
| Forced ventilation on cribs (Harmathy) | 1.3 to 1.5 times the naturally ventilated rate | - | | R19 [read] |

Gap: I found no validated wind blow-off correlation for small wood flames. Fitting u_bo = Fr_c (g L_f)^1/2 to a 4 cm candle at 2 to 3 m/s gives Fr_c about 4 [derived]. That predicts a 0.5 m campfire flame survives about 9 m/s. It overpredicts the brand data, 0.5 to 1 m/s for flames about 5 to 10 cm long [UNVERIFIED flame length]. Blow-off therefore also depends on how fast the fuel feeds gas: heat-starved pieces have weak flames.

Pick: a Damköhler-style limit, u_bo ∝ (flame size) x (pyrolysis flux / reference), anchored at 0.5 to 1 m/s for a lone small piece and 2 to 3 m/s for a candle. Flag it as a model gap for the success criterion "a small flame goes out in wind". Also give thin fuel a wind cooling term (R19's 0.64 cm crib result). Note too that wind cools fine fuel before ignition, adding more than 200 K of loss at 1 m/s (R8).

## 5. Water and moisture

| Quantity | Value | Units | Conditions | Source |
|---|---|---|---|---|
| Latent heat at 1 atm | h_v 2675 to 2676 and h_l 418 to 421 at about 100 C, so 2257 | kJ/kg | | R36 [read]; difference [derived] |
| Heat to boil off water starting at 20 C | 2675 - 84 = 2591, i.e. 2.6 | MJ/kg | | R36 [read] + [derived] |
| Rothermel heat of preignition | Q_ig = 250 + 1116 Mf (Btu/lb) = 581 + 2594 Mf (kJ/kg) | | Mf as a fraction | R31 [sec] |
| Rain cooling | 1 mm/h is 1 kg/m2/h, i.e. 0.72 kW/m2 if all the water is boiled off | kW/m2 per mm/h | | [derived] from R36 |
| Drying near a fire | evaporation = q_net / 2.6 MJ/kg; e.g. 2.5 kW/m2 gives about 1 g/m2s (3.5 kg/m2/h) | | Surface water, net absorbed flux | [derived] |
| Moisture of extinction | 0.30 in the Rothermel model; 12% (short grass) to 40% (southern rough) across the 13 fuel models | fraction / % | Dead fuel | R31 [sec], R32 [read] |
| Ember P(I) bounds | 100 at 1-h MC 1.5%, 0 at 25% | % | NFDRS scaling | R30 [read] |
| EMC (Simard 1968), RH < 10 | 0.03229 + 0.281073 RH - 0.000578 T RH | % MC | T in F, RH in % | R30 [read] |
| EMC, 10 ≤ RH < 50 | 2.22749 + 0.160107 RH - 0.014784 T | % MC | | R30 [read] |
| EMC, RH ≥ 50 | 21.0606 + 0.005565 RH^2 - 0.00035 RH T - 0.483199 RH | % MC | | R30 [read] |
| Timelag classes | under 1/4 in: 1 h; 1/4 to 1 in: 10 h; 1 to 3 in: 100 h; over 3 in: 1000 h | inches, h | Timelag is 63% of the way to equilibrium | R32 [read] |
| Diffusion scaling | response time / r^2 nearly constant for a species, so τ ∝ d^2 | | Below fiber saturation; drying not purely exponential | R33 [ex] |
| Fine-fuel response times | 0.2 to 37 h recently dead, 0.5 to 10 h weathered. Diffusivity: foliage and grass 1e-10 to 1e-8 cm2/s; woody 1.5e-7 to 3e-5 cm2/s. | | | R34 [ex] |
| 10-h stick model | 4 ponderosa pine dowels, 1.27 cm, about 100 g; heat and moisture diffusion driven by T, RH, solar and rain | | Nelson 2000 | R35 [ex] |
| Fiber saturation | about 30% MC | % | Assumed in Wood Handbook tables | R6 [read] |
| Maximum MC | MC_max = 100 (1.54 - G)/(1.54 G) | % | G = basic specific gravity | R6 [read; reconstructed from extraction] |
| Green wood MC, heartwood / sapwood | Douglas-fir (coast) 37/115; balsam fir 88/173; yellow cedar 32/166; aspen 95/113; basswood 81/133; beech 55/72; paper birch 89/72 | % dry basis | Wood Handbook Table 4-1 | R6 [read] |
| Green wood MC, more species | ponderosa pine 40/148; northern red oak 80/69; white oak 64/78 | % dry basis | Wood Handbook Table 4-1 | R6 [ex, via a copy] |
| Foliar MC range of cut trees | 2 to 154 | % | Douglas-fir Christmas trees | R13 [read] |
| Herbaceous fuel states | cured at 30% or less; moves between the 1-h and herbaceous classes from 30 to 120% | % | NFDRS | R30 [read] |

Check [derived]: for a cylinder's first diffusion mode, τ ≈ r^2 / (5.78 D). That eigenvalue is standard math I didn't cite.

Disagreement: the nominal timelag classes rise 10 times per class, while d^2 of the class midpoints rises about 10 to 25 times. They agree to order of magnitude only.

Pick:
- Per-item moisture relaxes toward the Simard EMC with τ = τ_ref (d/d_ref)^2.
- Anchor on Nelson's 10-h stick: d_ref 12.7 mm, τ_ref 10 h.
- Each kg of water costs 2.6 MJ before ignition (Rothermel's 2594 kJ/kg).
- Dead fine fuel above 30% MC carries no flame.

## 6. Embers and spotting

| Quantity | Value | Units | Conditions | Source |
|---|---|---|---|---|
| Firebrands from burning trees | Cylindrical. Mean 3 mm x 40 mm (2.6 m trees) and 4 mm x 53 mm (5.2 m trees). Most weigh under 0.3 g; up to 3.5 to 3.7 g. | | Douglas-fir, varied MC | R27 [ex] |
| Maximum lofting height above a steady flame | 12.2 x flame height | m | Piles, jackpots | R29 [read] |
| Brand burnout law | ρ_s dD/dt ≈ -K ρ_a U, K = 0.0064 (mass loss proportional to air supply) | | Limbwood with bark, wind tunnel | R28 [read] |
| Maximum height a brand can fall and still burn | z_max = 0.39e5 D | same units | Albini eq. D44 | R29 [read] |
| Spot distance | flat-terrain formula (F22) with log wind profile; power-law profile over grass or water | | | R28, R29 [read; exact F22 coefficients not transcribed, UNVERIFIED] |
| Ignition by single brands | Glowing 25 or 50 mm brands (0.5 or 1.5 g) never lit pine needles at 0 or 11% MC (0.5 to 1 m/s). Flaming brands (1 to 2.9 g) always did. Four glowing 50 mm brands (6 g) at 1 m/s gave smoldering, then flaming. | - | | R26 [read] |
| Ellis (as reported) | Flaming brands lit all needle beds at MC ≤ 9%. Glowing brands reached 50% probability only at MC ≤ 3% with 1 m/s wind. | | Read as ≤; OCR shows "59%" and "53%" | R26 [read; inequality inferred] |
| Hot particles on wood | red-hot 5 mm brands ignite with no wind; 2.5 mm in 8 m/s wind; needs RH about 20% | | Hamada | R1 [read] |
| NFDRS probability of ignition | QIGN = 144.5 - 0.266 T - 0.00058 T^2 - 0.01 T M + 18.54 (1 - e^(-0.151 M)) + 6.4 M; CHI = (344 - QIGN)/10; P(I) = (CHI^3.6 x 1.85e-5 - 0.00232) x 100 / 0.99767, clipped to 0 to 100 | QIGN cal/g; T = fuel-level C; M = 1-h MC % | | R30 [read] |

Check [derived]: P(I) depends strongly on fuel-level temperature. Reaching 100 at M = 1.5% needs T about 60 C.

Picks:
- Embers ignite dead fine fuel with probability P(I)(M, T).
- Count only flaming or multiple glowing brands as able to light a needle or grass bed (R26).
- Loft to 12.2 x flame height (R29) and burn out by K = 0.0064 (R28).
- Whether a given landing lights can only be given as odds, not a yes/no. The ember outcome stays probabilistic, as the requirements' open question expected.

## 7. Radiant heat on a person

| Quantity | Value | Units | Conditions | Source |
|---|---|---|---|---|
| Tenability limit for skin | 2.5; tolerated for at least several minutes below it, more than 5 min | kW/m2 | Naked skin | R37 [read] |
| Tolerance time | under 2.5: more than 5 min; at 2.5: 30 s; at 10: 4 s | | | R37 [read] |
| Time to incapacitation | t = 1.33 q^-1.33 (dose r / q^(4/3)) | min, kW/m2 | Pain dose 1.33 to 1.67; second-degree 4 to 12.17; third-degree 16.67 (kW/m2)^(4/3) min | R37 [read; OCR shows "133", decimal fixed by the table] |
| Pain trigger | skin at 0.1 mm depth reaches 44.8 C | C | Buettner | R37 [read] |
| Buettner data | 23.5, 10.5, 2.5 kW/m2 give pain in 1.6, 5, 40 s | | | R37 [read] |
| Simms & Hinkley data | 1.26 kW/m2: unbearable pain at 600 s; 2.52: 30 to 60 s | | | R37 [read] |
| No pain regardless of time | below 1.7 | kW/m2 | Consultant slides | [ex, weak source] |
| Clothed field test | 5.0 kW/m2 for 30 s, no pain | | Raj 2008 | R38 [read] |
| Point source model | q = χr Q / (4π R^2); within 5% when distance/D > 2.5 | | Modak 1977 | R40 [sec] |
| Radiant fraction | 0.30 to 0.40 for fires up to about 4 m; candle 0.17 +/- 0.01; pine wood vegetation fire 0.207 | - | | R39 [ex], R10 [read], R41 [ex] |
| Reference warm sun | 1000 | W/m2 | AM1.5 global | R57 [ex] |

Checks [derived], χr 0.3:
- A 10 kW fire gives 0.24 kW/m2 at 1 m.
- Pain (2.5 kW/m2) at 1 m needs Q of about 105 kW.
- A 38 kW fire has L_f about 0.5 m at D 0.5 m (Heskestad), roughly campfire size.

Disagreement: no pain below 1.7 kW/m2 (weak source) vs unbearable at 1.26 after 10 min (Simms & Hinkley).

Pick: χr 0.3; pain onset by Purser's dose model; tenability 2.5 kW/m2. Comfortable warmth lies well below that, at a few hundred W/m2 to 1 kW/m2 (sun). The only cited comfort-heater figures are a manufacturer's 100 to 400 W/m2 [ex, weak].

## 8. Temperatures reached and needed

| Quantity | Value | Units | Conditions | Source |
|---|---|---|---|---|
| Open fire, maximum above ground | 855 and 892 | C | Bennett 1999, experimental fires | R42 [ex] |
| Bonfire pottery firing, maximum | 600 to 900, averaging 750 to 800, regardless of fuel | C | Gosselain 1992 | R43 [ex] |
| Bonfire, time to peak | 800 to 900 C in 7 to 22 min | | | R43 [ex] |
| Wood crib flames | 650 to 1030 | C | Hägglund & Persson | R12 [read] |
| Glowing char surface | 600 in still air; 830 at 2.5 m/s, where smoldering turns to flaming | C | Wood | R46 [ex] |
| Low-temperature smoldering zone | 300 to 500 | C | | R46 [ex] |
| Minimum surface for self-sustained wood smoldering | 350 +/- 20 | C | Ohlemiller, as cited | R52 [ex] |
| Glowing spot | over 600 (red heat) | C | | R1 [read] |
| Charcoal with bellows (copper smelt) | 1000 to 1200 held for 2 h; peaks over 1300; average about 1180 | C | Timberlake 2007 | R44 [ex] |
| Bag-bellows furnace | over 1200 easily | C | | R44 [ex] |
| Bloomery profile | 500 at the top to 1300 at the tuyere; tuyere over 1350 within 30 min | C | | R45 [ex] |
| Copper melts | 1084.62 | C | ITS-90 fixed point, 1357.77 K | R48 [read] |
| Tin bronze (90/10) melting range | liquidus 999, solidus 831 | C | C90700 | R49 [ex] |
| Copper annealing | about 375 to 650; recrystallization 180 to 325 depending on purity and cold work | C | | R56 [ex] |
| Clay becomes ceramic (kaolinite dehydroxylation) | starts about 450, mostly done by 600 to 650; no hydrated clay minerals above about 500 | C | | R55 [ex] |
| Mullite forms | above 1100 | C | | R55 [ex] |
| Water boils | 373.17 K (100 C) | | 1 atm | R36 [read] |
| Safe cooking, internal | 145 F (62.8 C) plus 3 min rest for whole cuts; 160 F (71.1 C) ground meat; 165 F (73.9 C) poultry; 145 F fin fish | | USDA FSIS | R50 [ex] |
| Glowing coal emission | σT^4 is about 33 kW/m2 at 600 C and about 84 kW/m2 at 830 C (ε about 0.95) | kW/m2 | Radiant flux at contact | [derived] from R46 and R14 |

I found no direct measurement of banked coals or a covered kiln. Pick: banked coals emit as glowing char at about 600 C in still air (R46). A covered kiln sits between bonfire (600 to 900 C) and bellows charcoal (1100 to 1300 C), set by the bed's energy balance.

## 9. Light from flames

| Quantity | Value | Units | Conditions | Source |
|---|---|---|---|---|
| Candle heat release | 77 +/- 9 | W | 0.105 g/min, 43.8 kJ/g | R10 [read] |
| Candle light | very roughly 1 cd at roughly 80 W | | | R51 [ex] |
| Historical candlepower unit | spermaceti candle burning 7.8 g/h; 1 cp = 0.981 cd | | | R51 [read] |
| Candle luminous efficacy (quoted) | 0.3 | lm/W | Patent text, no primary source | [ex, weak] |
| Candle luminous efficacy (computed) | 1 cd x 4π sr is about 12.6 lm, over 77 W: about 0.16 | lm/W | Assumes isotropic emission | [derived] |

I found no primary measurement for wood fires (forum figures of 0.1 to 1 lm/W rejected). Pick: 0.16 lm/W of heat release, applied to the flaming HRR only, since sooty diffusion flames are similar; glowing coals give much less. Flag it as unverified for wood.

## 10. Catching: a struck spark and a friction ember

| Quantity | Value | Units | Conditions | Source |
|---|---|---|---|---|
| NFDRS P(I) scaling | PNORM1 0.00232, PNORM2 0.99767, PNORM3 0.0000185 make P(I) 100 at MC1 1.5% and 0 at MC1 25% | - | "probability that a firebrand will produce a successful fire start in dead, fine fuels"; QIGN uses TMPPRM, the fuel-level temperature in C | R30 [read] |
| NFDRS 1-h moisture while it rains | MC1 = 35 | % | Rain at the observation time | R30 [read] |
| P(I) inverted: moisture at which P(I) equals p | p 50%: 3.8, 4.2, 4.6; p 25%: 7.7, 8.3, 8.8; p 18%: 9.5, 10.0, 10.6; p 10%: 12.2, 12.9, 13.5; p 1%: 19.7, 20.4, 21.2 | % MC at fuel temperature 10, 20, 30 C | Bisection on R30's QIGN, CHI, P(I) | [derived] |
| P(I) at fixed moisture, 20 C fuel | M 4%: 52; 7%: 31; 10%: 18; 13%: 9.7; 15%: 6.0; 19.3%: 1.6; 21%: 0.7 | % | | [derived] from R30 |
| P(I) temperature sensitivity | the moisture at a fixed P(I) rises about 0.3 to 0.7 points of MC per 10 C of fuel temperature; P(I) reaches 100 at 1.5% only near 62 C | | | [derived] from R30 |
| Glowing firebrands, Ellis | 0.2 g glowing E. globulus bark (50 x 15 x 2 mm, glows 2.5 min in wind) on dry eucalypt litter, 2 m/s at the fuel: ignition only at MC about 10% or less; 50% at MC below about 4%. With no wind, ignition unlikely. | % MC (oven-dry basis) | Wind tunnel, 0, 1, 2 m/s, MC 4 to 21% | R64 [sec: CSIRO PyroPage summary of Ellis's own paper]; R64 abstract [ex] |
| Flaming firebrands, Ellis | 3 mm bamboo, 0.6 to 0.9 g, flames 9 s: no wind, ignition at MC about 14% or less, 50% below about 9%. With wind, critical MC about 21%, 50% below about 13%. Below about 7% ignition essentially certain either way. | % MC | as above | R64 [sec] |
| Single glowing brands, Manzello | 25 or 50 mm glowing brands never lit pine needles at 0 or 11% MC (0.5 to 1 m/s); four glowing 50 mm brands at 1 m/s smouldered then flamed | | | R26 [read] |
| Match on slash pine litter, Blackmarr | 50% ignition at 19.3% MC (miniature match). Range from near 100% to near 0: 16 to 25% (miniature match), 18 to 30% (kitchen match), 24 to 40% (three kitchen matches) | % MC | Matches dropped on conditioned litter | R65 [sec, via R66] for 19.3%; ranges [ex, search excerpt of R65's abstract] |
| Cigarettes on grass, Countryman | Fine fuel ignites readily up to 13% MC, marginally to 14 to 15%, never above. Coarse fuel not ignitable even at 1.9%. Cigarette resting on stalks above the litter rarely ignites. | % MC | Grass fuels | R66 [sec] citing Countryman 1982, 1983 |
| Cigarettes, wind | probability near 100% for various targets at about 3 m/s (Hoffheins); no ignition at all without wind at 4.5 to 6.5% MC (Markalas); cigarette must touch fine fuel over at least 1/3 of its perimeter (Ford) | | | R66 [sec] |
| Small burning coal particles | 5 mg (about 2 mm) burning coal particles always lit cotton wool; glowing brands of tens of mg can start smouldering in very receptive fuel | | McGuire, Law, Miller 1956; Albini pers. comm. | R66 [sec] |
| Hot steel sphere on pine needles, Wang | critical particle temperature T_crt = 1800 (1 + 4 FMC)/d + 500 | C; d in mm; FMC as a fraction | d 6 to 14 mm, 600 to 1100 C, FMC 6 to 32%, wind 0 to 4 m/s; particle heating efficiency about 10% | R67 [ex, abstract] |
| Wang's limit applied to a struck spark | at d 0.2 to 0.5 mm, T_crt is 4100 to 9500 C even for bone-dry fuel, far above any spark | C | Extrapolation 10 to 70 times below the tested size | [derived] from R67 |
| Flint-and-steel sparks need receptive tinder | Sparks are steel shavings oxidising in air; they are caught on char cloth or tinder fungus (amadou, Fomes fomentarius), then the glowing patch is put in a grass or bark bundle and blown to flame; practitioners say sparks do not light a dry grass bundle directly | | Practitioner and encyclopedic sources only | R68 [ex, weak] |
| Spark temperature | reported 800 F and 2498 F for flint-and-steel sparks | | Unsourced secondary claims; they disagree by a factor of 3 | R68 [UNVERIFIED] |
| Friction ember | fine charred wood dust starts to glow near 700 F (370 C), coarser dust near 800 F (430 C); a damp spindle and hearth smoke but give no ember until dried by light drilling; damp tinder must be dried first (body warmth, hours) | | Practitioner experiments | R69 [read] |
| Gale that carries sparks off | No cited data. Evidence runs the other way for glowing sources: wind of 1 to 3 m/s raises glowing-brand and cigarette ignition (R64, R66), and hot 2.5 mm particles lit wood in 8 m/s wind (Hamada, R1). An old USFS claim that dropped matches fail above 1.8 m/s has no data behind it (R66). | | | gap |

Findings:
- Measured limits fall into two groups. Glowing sources (glowing brands, cigarettes, coal particles) need wind or blowing to catch and need dry fuel: about 10% MC is the most any glowing brand managed (Ellis, 2 m/s), and 13 to 15% is the most a cigarette managed in fine grass. Flaming sources (matches, flaming brands) reach 14 to 25% MC.
- A struck spark is the weakest source of all, milligrams or less. By Wang's correlation, and by every practitioner source found, it cannot light dry grass or plant fibre directly. It catches only in charred or fungal tinder, whose glow is then blown to flame inside a grass bundle. So a struck spark is, in practice, a glowing source of the smallest kind.
- A friction ember is a coal of charred dust, similar in mass and temperature to a cigarette's coal. Set into a bundle that wraps it, and blown, it is the cigarette-in-fine-grass case with wind, which is the best-measured glowing case.
- NFDRS P(I) reproduces these limits at plausible levels: 10% MC is P(I) 18% at 20 C, 13% MC is P(I) 10%, 4% MC is P(I) 52%.

Disagreements:
- Ellis's glowing brands lit litter up to about 10% MC at 2 m/s, while Manzello's single glowing brands lit pine needles at no moisture, even 0%, at 0.5 to 1 m/s. The difference is wind and bed type; both say a lone glowing source in weak air rarely catches.
- Whether to use the 50% point or the point where ignition stops. For a strike, the 50% point (about 4%) is reached in the sim only in calm, clear, high-sun hours of the drier afternoons: with section 11's Byram and Jemison pick, fuel-level EMC falls to 3.7 to 5.5% at sun 60 degrees and 0.3 m/s fuel-level wind (RH 0.52 to 0.85), but stays 5 to 10% at 1 m/s; with the NFDRS table it never goes below about 7%. The point where ignition stops (about 10%) is reached in most sunny hours.

**Pick.** Catching is deterministic: a spark or ember catches if the tinder's moisture is at or below a limit, and the limit is the moisture at which NFDRS P(I) at a fuel temperature of 20 C equals a set level.
- (a) Struck spark on dry grass or plant fibre: P(I) 18% at 20 C, which gives M_spark = 10% MC (dry basis). Reasoning: a strike act throws dozens of sparks into the same tinder, so the act succeeds wherever any one spark can, and the moisture above which no glowing source was ever seen to catch (Ellis, 2 m/s) is the right edge, not the 50% point. A spark is weaker than Ellis's 0.2 g brand, so 10% is an upper bound; the strict alternative, P(I) 50% (4.2% MC), would confine spark fire-making to calm, sunny, high-sun hours (or to tinder dried against the body, section 18). Flag: the physical record says sparks need charred or fungal tinder, which the sim does not have; the 10% limit stands in for "tinder fine and dry enough to hold a glow".
- (b) Friction ember blown into a tinder bundle: P(I) 10% at 20 C, which gives M_ember = 12.9%, rounded to 13% MC. Reasoning: matches Countryman's readily-ignites limit for a glowing coal touching fine grass (13%) and Ellis's 50% point for flaming brands in wind (13%), the flame the ember becomes when blown. Countryman's marginal 14 to 15% is the sensitivity range.
- Fuel temperature 20 C is a fixed reference, so the limits are constants. Using the tinder's own fuel-level temperature (section 11) instead would move both limits by about 0.6 points per 10 C, inside the data's own scatter.
- The gale that carries sparks off has no cited value; keep the sim's current one and mark it a gap.

## 11. Tinder in the sun: fuel-level temperature and humidity

| Quantity | Value | Units | Conditions | Source |
|---|---|---|---|---|
| NFDRS fuel-level correction by state of weather (SOW) | SOW 0 clear: +25 F (+13.9 C), RH x 0.75. SOW 1 scattered: +19 F (+10.6 C), x 0.83. SOW 2 broken: +12 F (+6.7 C), x 0.92. SOW 3 overcast: +5 F (+2.8 C), x 1.00 | temperature added; RH multiplied | Applied to shelter values at 4.5 ft; based on Byram and Jemison 1943; time of year, sun height and wind ignored | R30 [read; the SOW 2 multiplier reads 0.92 in the scan, other copies are said to give 0.91, UNVERIFIED] |
| NFDRS 1-h fuel moisture | MC1 = 1.03 EMCPRM (no fuel sticks); MC1 = 35 when raining at observation; MC10 = 1.28 EMCPRM | % | EMCPRM is Simard's EMC at TMPPRM, RHPRM | R30 [read] |
| SOW as cloud cover | 0: 5%; 1: 30% (10 to 50); 2: 70% (50 to 90); 3: 95% (90 to 100) | % cover | | R70 [read] |
| Byram and Jemison fuel temperature | T_f - T_a = I / (0.015 U + 0.026) | F; I in cal/cm2/min (1 cal/cm2/min = 697.8 W/m2); U in mi/h at fuel level | Hardwood leaf litter under an artificial sun; authors warn other fuels and soils need other constants | R70 [read], quoting Byram and Jemison 1943 |
| Same, in SI | T_f - T_a = I / (32.7 + 42.2 U) | C; I in W/m2 on the fuel; U in m/s at fuel level | The denominator acts as a combined loss coefficient, 33 W/m2K in still air | [derived] by unit conversion of R70 |
| Byram and Jemison humidity at the fuel | H_f = H_a exp(-0.033 (T_f - T_a)) | T in F | Vapour pressure of the air is taken as unchanged at the fuel | R70 [read] |
| Check of that humidity rule | holding vapour pressure fixed, H_f = H_a es(T_a)/es(T_f) gives the same multiplier within 0.01 over 10 to 30 C (e.g. 0.50 vs 0.51 at +8.5 C) | | Magnus es as climate.ts uses | [derived] |
| Sun on the fuel | I = I0 p^M sin A x T_n; I0 = 1.98 cal/cm2/min; p = 0.745 (0.8 exceptionally clear, 0.75 average clear, 0.7 blue haze, 0.6 dense haze); M = exp(-0.0000448 E) / sin A (E in ft); T_n = cloud transmittance times tree transmittance; cloud transmittance taken as 1 - cover | | A = sun altitude; I = 0 when A < 0; csc A law poor below 10 degrees | R70 [read; the cloud transmittance equation is lost in the scan, its form 1 - Sc/100 is inferred from the surviving text] |
| Tree shade | Beer law through crowns, exp(-J x path), J 0.10 to 0.20 1/ft by shade tolerance; shaded fraction 1 - exp(-n N1) for n trees | | | R70 [read] |
| Worked example, air 15 C, RH 0.85, clear | sun 60 degrees (852 W/m2): fuel wind 0.3, 1, 2 m/s gives +18.8, +11.4, +7.3 C and fuel RH 0.28, 0.42, 0.54, so 1-h EMC 5.4, 8.0, 10.1%. Sun 30 degrees (383 W/m2): +8.5, +5.1, +3.3 C; RH 0.50, 0.62, 0.69; EMC 9.8, 11.3, 13.0%. NFDRS clear row at the same air: 11.3% | | Simard EMC x 1.03 | [derived] from R70, R30 |
| Field test in a humid island climate | NFDRS's simple 1-h model (SOW correction, EMC x 1.03) underestimated measured fine-fuel moisture on all six Hawaiian fuels, mean error -5.8 to -18.6 points; worst for standing grass (Holcus lanatus). A fitted hourly model, m_t = 0.07 EMC + 0.93 m_(t-1), fit best, so these "1-h" fuels responded over about 14 h | % MC | Litter, grass, fern; 2 to 60% MC observed | R71 [read] |
| Validation of the sun-corrected model | consistently a better predictor than the operational (FBO, NFDRS-based) procedures in Texas, Arizona, Idaho, Alaska | | | R70 [read, abstract and summary] |
| Night | no radiative-cooling or dew correction in either model; fuel cools below air on clear nights | | | R70 [read]; gap |

Disagreement:
- The NFDRS multipliers are much weaker than the physics they rest on. At NFDRS's own clear-sky +25 F, holding vapour pressure fixed (Byram and Jemison's rule) gives RH x 0.44, not x 0.75. At 15 C and RH 0.85 the two give 11.3% (NFDRS) against about 8% (Byram and Jemison at 60 degrees sun and 1 m/s).
- In a humid climate both corrections risk making fine fuel too dry: Hawaii's measurements sat 6 to 19 points above NFDRS's simple prediction. The sim's island is humid (RH median 0.85), so this bias would make tinder catch more often than it should.

**Pick.** Sun-exposed tinder and fine fuel:
- Fuel temperature T_f = T_a + I / (32.7 + 42.2 U), with I the sun on the fuel in W/m2 (clear-sky beam I0 p^M sin A with p 0.745, times 1 - cloud cover, times 1 - canopy) and U the wind at the fuel's height (section 14).
- Humidity at the fuel RH_f = RH_a es(T_a)/es(T_f), with the Magnus es climate.ts already uses. Equilibrium moisture is Simard's EMC at (RH_f, T_f).
- Cloud cover for the sim's skies from the NFDRS table: clear 5%; cloudy 70% (broken) as the midpoint of the cloudy codes; rain and storm 95% (overcast), and in rain the wetting term governs anyway (NFDRS fixes MC1 at 35%).
- At night and in shade I = 0, so T_f = T_a and RH_f = RH_a.
- Reasoning: Byram and Jemison is the physical model under both NFDRS and BEHAVE, it uses the sun height and fuel-level wind the sim already has, and its humidity rule is plain vapour-pressure physics. The NFDRS SOW table is kept as a cross-check: it matches Byram and Jemison's temperature rise at about 0.7 m/s fuel-level wind and high sun, but understates the humidity drop. Use the EMC itself as the relaxation target, not 1.03 EMC (the 1.03 is NFDRS's allowance for afternoon lag, which the sim's own time constant already handles). Flag that the humid-climate field test found fine fuel wetter than this kind of model predicts.

## 12. Grass: herbaceous moisture and curing

| Quantity | Value | Units | Conditions | Source |
|---|---|---|---|---|
| NFDRS herbaceous stages | pregreen (MCHERB 30% or less), greenup, green (over 120%), transition (30 to 120%), cured or frozen (30% or less); MCHERB never above 250% | % dry basis | NFDRS 1978 | R30 [read] |
| Cured share of the grass load | FCTCUR = 1.33 - 0.0111 MCHERB, clipped to 0 to 1; that share of the herbaceous load moves to the 1-h dead class and takes 1-h moisture | - | Used in greenup, transition and curing | R30 [read] |
| Cured share, worked | MCHERB 120%: 0; 75%: 0.50; 30%: 1.00 | - | | [derived] |
| Greenup length | 7 x climate class days (1 to 4 weeks); MCHERB phased linearly from its start value (at least 30%) to the potential value | days | | R30 [read] |
| Green-stage moisture | MCHERB = HERBGA + HERBGB X1000; (HERBGA, HERBGB) = (-70, 12.8), (-100, 14.0), (-137.5, 15.5), (-185, 17.4) for climate class 1 to 4 | % | | R30 [read] |
| Transition moisture | annuals: ANNTA + ANNTB X1000 = (-150.5, 18.4), (-187.7, 19.6), (-245.2, 22.0), (-305.2, 24.3), never rising day to day; perennials: PERTA + PERTB X1000 = (11.2, 7.4), (-10.3, 8.3), (-42.7, 9.8), (-93.5, 12.2), held within 30 to 150 | % | class 1 to 4 | R30 [read] |
| Cured stage | annuals: MCHERB = MC1 (dead), and stay cured until the next greenup; perennials: held at 30% or more and may re-green if moisture returns, unless a killing frost is declared | | | R30 [read] |
| Drought driver X1000 | X1000 follows the daily change in 1000-h moisture, damped by KWET (1.0 if MC1000 over 25%; 0.0333 MC1000 + 0.1675 from 10 to 25%; 0.5 below 10%; 1.0 whenever MC1000 rises) and KTMP (0.6 if the day's mean of max and min is 50 F or less, else 1.0) | | | R30 [read] |
| Killing frost | first day with Tmin 25 F (-3.9 C) or lower, or the fifth day with Tmin 26 to 32 F (-3.3 to 0 C), cures the herbaceous fuel | | FIREFAMILY rule | R30 [read] |
| Climate classes | 1 and 2 are dry areas with showery fire-season rain; 3 and 4 are wetter areas with lighter, more continuous rain | | | R30 [read, from the WETRAT text]; that the classes are Thornthwaite arid, semiarid, subhumid, humid is [UNVERIFIED] |
| NFDRS v4 growing season index (GSI) | product of four ramps: daily Tmin from -2 C (0) to 5 C (1); daily max VPD from 900 Pa (1) to 4100 Pa (0); daylength from 10 h (0) to 11 h (1); 28-day rain total from 0 (0) to 10 mm (1). Daily product averaged over 28 days, then divided by the site's historical maximum GSI | - | Jolly et al. 2005, extended by Daham et al. 2019 for rain | R72 [read] |
| NFDRS v4 herbaceous moisture | 30% if GSI' is below the green-up threshold GU, else linear from 30% at GU to 250% at GSI' = 1; GU 0.2 | % | Woody: 60 to 200%, GU 0.2 | R72 [read] |
| Green-up threshold, other value | 0.5 | - | NFDRS2016 training text | R73 [read] |
| GSI skill | modelled vs measured live fuel moisture r2 0.63 with defaults, 0.69 when tuned | - | Six US species | R72 [read] |
| Temperate humid curing pattern | UK fires burn semi-natural grassland and heath in early spring while vegetation is still dormant; in the high-greenness phase (late spring, summer) fire activity drops 5 to 6 times despite better fire weather; the barrier fails in severe drought | | UK 2012 to 2023 | R74 [read, abstract] |
| Spring peak | Molinia (purple moor-grass) fires peak around April, when dead matter is abundant and dries fast; 404 of 514 Scottish incidents fell in March and April | | | R75 [ex] |
| Curing and spread | grass under about 50% cured rarely carries fire; 75 to 90% cured marks a steep rise in spread | % cured | Grassland reviews (Cheney and Sullivan lineage) | R76 [ex] |

Findings:
- The 1978 rule needs a climate class, a declared green-up date and the 1000-h moisture as a drought proxy. The 2024 rule (v4) needs only the daily weather the sim already makes (minimum temperature, humidity, rain) plus daylength.
- On the sim's own climate (section 25), the GSI is set almost entirely by minimum temperature: winter minima near -4 C give a zero temperature ramp, summer minima near 12 to 15 C give 1, the island's summer maximum VPD is about 1.1 kPa (ramp about 0.93), and rain far exceeds 10 mm in any 28-day window. So grass would be green from spring into autumn and cured in winter, which matches the UK pattern of dormant, flammable grass in late winter and early spring [derived].
- Both rules' windows are in real days (28-day GSI and rain windows; 7 to 28-day greenup). The sim's year is 40 days.

Disagreement: the green-up threshold is 0.2 in the v4 paper and 0.5 in the NFDRS2016 training text. The paper is the later, peer-reviewed source.

**Pick.**
- Grass moisture from the NFDRS v4 GSI: MCHERB = 30% while GSI' < 0.2, else 30 + 220 (GSI' - 0.2)/0.8, with the Tmin, VPD and rain ramps as tabled. Daylength ramp from the sim's sun if it has day length; otherwise leave it out (ramp 1) and flag it.
- Cured share from the 1978 transfer, FCTCUR = clip(1.33 - 0.0111 MCHERB, 0, 1). The cured share sits at dead-fuel moisture, the rest at MCHERB.
- Treat the sim's grass as perennial (the common European pasture and moor grasses are perennial [UNVERIFIED as a general claim]), so it re-greens when the GSI recovers.
- Scale every real-day window by the sim's year: 28 real days is 28 x 40 / 365.25 = 3.1 game days. Reasoning: the GSI windows smooth weather over a fraction of a season, and a 28-day window over a 40-day year would erase the seasons.
- Reasoning: v4 is the current NFDRS rule, is driven by the weather the sim has, needs no declared dates or climate class, and is tested against measured live fuel moisture; the 1978 transfer function is still the defined link from herbaceous moisture to cured share.

## 13. Rain intensity

| Quantity | Value | Units | Conditions | Source |
|---|---|---|---|---|
| Met Office rain classes (not showers) | slight under 0.5; moderate 0.5 to 4; heavy over 4 | mm/h | UK observing practice | R77 [ex: Met Office statement] |
| Met Office shower classes | slight 0 to 2; moderate 2 to 10; heavy 10 to 50; violent over 50 | mm/h | | R77 [ex: secondary listing, UNVERIFIED against the Met Office handbook] |
| AMS rain classes | light trace to 2.5; moderate 2.6 to 7.6; heavy over 7.6 | mm/h | | R96 [read] |
| NFDRS typical rainfall rate | 0.25 in/h (6.35 mm/h) where fire-season rain comes as moderately intense showers (climate classes 1, 2); 0.05 in/h (1.27 mm/h) where rain is lighter and more or less continuous (classes 3, 4); ratio 5 | mm/h | Used to turn rain amount into duration, capped at 8 h | R30 [read] |
| Convective and stratiform mean rates | convective 7.3, stratiform 1.8; ratio 4.1 | mm/h | TRMM radar, tropics, Schumacher and Houze 2003 | R78 [ex] |
| Convective and stratiform extremes, Germany | 99th percentile 10-min intensity of stratiform rain about 8 times below convective at the same dew point; stratiform rain dominates near Td 5 C, convective near 18 C, and the convective share grows about 41% per C from 7 to 22 C | - | 514 DWD stations, 2005 to 2020, lightning-classified | R79 [read] |
| UK hourly extremes | record 1-h fall 92 mm; Boscastle 2004 about 50 mm/h; fewer than 60 hours of 30 mm/h or more in about 380 gauges over 20 years, most in summer | mm/h | 1992 to 2011 | R80 [read] |
| Rain cooling | 1 mm/h = 0.72 kW/m2 if all boiled off | | | section 5 |
| Sim rates for storm-to-rain ratio K (game-time base) | K 4: rain 1.70, storm 6.8. K 5: rain 1.56, storm 7.8 (spring 1.57/7.9, summer 0.79/4.0, autumn 1.85/9.2, winter 2.40/12.0). K 8: rain 1.26, storm 10.1 | mm/h | I_rain = P / (H (r + K st)), section 25's season means, H 240 h per season | [derived] from section 25 |

Findings:
- Hour-averaged steady (stratiform, frontal) rain in a temperate maritime climate sits around 1 to 2 mm/h (Met Office moderate class, NFDRS's wet-climate rate 1.3 mm/h, stratiform mean 1.8 mm/h). Showers and thunderstorm hours sit around 5 to 10 mm/h (NFDRS's shower rate 6.4 mm/h, convective mean 7.3 mm/h, Met Office moderate shower class), with cores of 10 to 50 mm/h for minutes.
- The ratio of shower to steady rain is 4 (TRMM means), 5 (NFDRS rates), 3 to 5 (Met Office class midpoints) and about 8 for extremes at 10-min scale (Germany).

Disagreement: mean-rate ratios (4 to 5) and extreme-rate ratios (8) differ because the sim's storm hour is an hour-mean, not a peak. Use the mean ratio.

**Pick.** Storm-to-rain ratio K = 5 (NFDRS's two typical rates, between the TRMM mean ratio 4.1 and the extreme ratio 8). With section 25's game-time base this gives rain about 1.6 mm/h and storm about 7.8 mm/h over the year, by season as tabled (summer rain 0.8, winter storm 12). Both land where the cited classes put steady rain (moderate, 0.5 to 4) and a thundery shower hour (moderate to heavy, 2 to 10 and above). Reasoning: the sim's storm sky is an hour-long state, so an hour-mean ratio is the right one; the year's rain total stays the climate's, as section 25 argued for the game-time base.

## 14. Wind at bed height, and blow-off

### 14a. Wind profile

| Quantity | Value | Units | Conditions | Source |
|---|---|---|---|---|
| Log wind profile | U(z) = (U*/K) ln((z - D0)/z0), K = 0.4 | | Neutral, above the vegetation | R81 [read] |
| Vegetation roughness and displacement | z0 = 0.13 H, D0 = 0.64 H for vegetation height H, short grass to tall trees | m | Albini and Baughman 1979 | R81 [read] |
| Wind inside vegetation | below the canopy top the wind is taken as roughly constant with height (sheltered model); unsheltered midflame wind = average from H to 2H | | | R81 [read] |
| Unsheltered wind adjustment factor | WAF = 1.83 / ln((20 + 0.36 H)/(0.13 H)), H fuel depth in ft, relative to 20 ft above the fuel; 0.30, 0.36, 0.40, 0.47 for H 0.1, 0.3, 0.5, 1.0 m | - | | R81 [read]; values [derived] |
| Sheltered wind adjustment factor | WAF = 0.555 / (sqrt(f H) ln((20 + 0.36 H)/(0.13 H))), H canopy height ft, f = crown fill fraction (canopy cover / 3 x crown ratio); used when f over 5% | - | | R81 [read] |
| Typical WAF range | 0.5 for exposed fuel to 0.1 under dense canopy (relative to 10-m wind) | - | | R82 [ex] |
| Davenport-Wieringa z0 classes | sea 0.0002; smooth (featureless land, ice) 0.005; open (flat grass, very low vegetation; WMO lists heather, moor, tundra here) 0.03; roughly open (low crops) 0.10; rough 0.25; very rough (bushes, young dense forest) 0.5; closed (mature forest) 1.0; chaotic over 2 | m | Wieringa 1993 review of 1970s and 80s experiments | R83 [ex: search excerpts of the table and the WMO registry] |
| Bare sand | 0.0003 | m | Common textbook value | [UNVERIFIED, not read] |
| Ratio U(z)/U(2 m), bed heights 0.1, 0.2, 0.3, 0.5 m | sand (z0 0.0003): 0.66, 0.74, 0.78, 0.84. Bare ground or rock (0.005): 0.50, 0.62, 0.68, 0.77. Open class (0.03): 0.29, 0.45, 0.55, 0.67. Short grass H 0.1 m (z0 0.013, D0 0.064): 0.20, 0.47, 0.58, 0.70. Tall grass or heather H 0.5 m (z0 0.065, D0 0.32), bed inside it: 0.31 at all four. Gorse or scrub H 1.5 m (z0 0.195, D0 0.96), bed inside it: 0.61 | - | Log law; inside vegetation the wind at the canopy top is used, per R81 | [derived] from R81, R83 |
| Forest floor | under trees the sim's head-height wind is already cut by canopy (air.ts: 0.65 x canopy); Albini and Baughman take the sub-canopy wind as constant with height, so bed wind = that head-height wind | | | R81 [read]; near-floor log layer over litter is a gap |

**Pick (profile).** Wind at a bed of height z_b: U(z_b) = U_head x ln((max(z_b, H) - 0.64 H)/(0.13 H)) / ln((2 - 0.64 H)/(0.13 H)) over vegetation of height H below 2 m; over bare ground use ln(z_b/z0)/ln(2/z0) with z0 0.005 (rock, bare soil) or 0.0003 (sand, UNVERIFIED); under tree canopy use U_head itself. Vegetation heights: short grass 0.1 m, tall grass 0.5 m, heather 0.3 to 0.5 m, gorse or scrub 1 to 2 m (from the sim's own plant sizes when present). Reasoning: Albini and Baughman's z0 and D0 tie roughness to the plant height the sim already knows, they are the fire community's standard, and they agree with the Davenport classes (z0 0.013 to 0.065 for grass and heather, against 0.03 for the open class). Bed height z_b: the bed's mid-height, at least 0.05 m.

### 14b. Blow-off of small flames

| Quantity | Value | Units | Conditions | Source |
|---|---|---|---|---|
| Existing anchors | small wood brands lose their envelope flame at 0.5 to 1.0 m/s; flames on thin wire 2 m/s; thin paper or a candle-sized wake flame 3 m/s | m/s | | R26 [read], R24 [ex] |
| Candle | mass loss 0.105 g/min, heat release 77 W, flame height 42 mm, flat braided wick about 1 x 2 mm | | 21 mm taper, steady after 15 min | R10 [read] |
| Dowel array in wind | 3.2 mm pine dowels, 0.75 to 1.25 cm apart: one continuous flame from 1.0 to 2.5 m/s; discrete flames on each dowel from about 3.3 m/s; at 1.0 cm spacing propagation stops and the array blows off above 3.87 m/s; diameter Reynolds number at the limit about 700 (1.25 cm spacing) to 900 (0.75 cm), i.e. about 3.4 to 4.4 m/s | m/s | Bench wind tunnel, uniform flow | R84 [read]; m/s from Re [derived, nu 1.55e-5 m2/s] |
| Critical mass flux rises with air speed | dry poplar at 30 kW/m2: 1.46, 1.53, 2.22, 2.88 g/m2s at 0.8, 1.0, 1.2, 1.3 m/s; at 1 m/s it also rises with irradiance, 1.29 to 2.19 g/m2s from 20 to 50 kW/m2. Little change below about 1 m/s because buoyancy induces a flow of that order. Reason given: more oxidizer per area needs more fuel to reach the same mixture | g/m2s | Piloted ignition, 9 x 9 cm samples | R85 [read] |
| Exponent of that rise | m''_cr proportional to u^2.3 over 1.0 to 1.3 m/s | - | Log fit to R85's three points at and above 1 m/s | [derived] |
| Proposed form | flame blown off when u^2 / (g L_f) > m'' / m''_ext, i.e. u_bo = sqrt(g L_f m'' / m''_ext), with m''_ext = 3.5 g/m2s (the existing extinction flux), L_f the flame length, m'' the piece's own gas flux | m/s | No fitted constant | [derived] |
| Checks of the form | glowing-edge brand (L_f 3 to 5 cm, m'' 3.5 to 4): 0.54 to 0.75 m/s (anchor 0.5 to 1). Candle (L_f 4.2 cm, m'' about 29 g/m2s on the wick, wick area assumed 60 mm2): 1.85 m/s (anchor 2 to 3). Single 3.2 mm stick in a bed (m'' 17.7 by Heskestad, L_f 5 to 10 cm): 1.6 to 2.2 m/s (dowel array with neighbours 3.4 to 4.4). Campfire (L_f 0.5 m, m'' 7 to 14 with wind's air supply): 3.1 to 4.4 m/s at bed height, i.e. about 7 to 9 m/s head-height wind over short grass | m/s | | [derived]; candle wick area [UNVERIFIED] |

Findings:
- No validated blow-off correlation for small wood flames was found; the gap stands. But two measured facts constrain the form: blow-off depends on the fuel's gas supply (heat-starved brands go out at 0.5 to 1 m/s while well-fed thin sticks hold to 3 to 4 m/s), and the gas flux a flame needs rises about as u^2 above about 1 m/s (R85).
- A Froude limit scaled by the flux ratio, Fr = u^2/(g L_f) < m''/m''_ext, carries both facts, needs no new constant, and puts all four anchors within a factor of about 2 (low for sticks backed by neighbours, as expected since it ignores their help).

Disagreement: section 4's pure Froude fit (Fr_c about 4 on a candle) predicts 2.8 m/s for a brand, where brands lose flame at 0.5 to 1 m/s; the flux factor fixes this.

**Pick (blow-off).** A group's flame is blown off when the wind at its height, from 14a, exceeds u_bo = sqrt(g L_f m'' / m''_ext), m''_ext = 3.5 g/m2s, L_f the flame length of the group (or of the bed for pieces inside its flame), m'' the group's gas flux including the air-supply term of section 15. R85 found the critical flux flat below about 1 m/s, where buoyancy sets the flow; the form has no such floor, and the brand anchor (0.5 to 1 m/s) says small flames need none. Flag: model gap remains; the form is fitted to no blow-off data of its own, and the exponent is from three points over 1.0 to 1.3 m/s.

## 15. Air supply: wind and blown air on a burning bed

| Quantity | Value | Units | Conditions | Source |
|---|---|---|---|---|
| Cribs of 1.27 cm sticks in wind | burning rate up in proportion to wind; at 0.7 m/s: +13.3% (crib 1, Heskestad porosity 0.12 cm), +61.5% (crib 2, dense, 0.0039 cm), +6.5% (crib 3, 0.039 cm), +23.6% (crib 4, 0.12 cm) | - | Ponderosa pine, MC about 1%, wind 0 to 0.7 m/s, open wind tunnel | R19 [read] |
| Cribs of 0.64 cm sticks in wind | burning rate down 36.7 to 60.6%, roughly the same at 0.24, 0.37 and 0.7 m/s; crib centres failed to burn; authors propose more convective loss on thin sticks, unproven | - | | R19 [read] |
| Ideal reduced burning rate | 10^3 R / (A_s b^-1/2) = 1.47 (b 1.27 cm) and 1.04 (b 0.64 cm) g/(s cm^1.5) (Tewarson and Pion, Douglas-fir); crib 4 reached it at 0.7 m/s | | | R19 [read] |
| Convective coefficient on a stick | 24.5 W/m2K (1.27 cm) and 34.8 W/m2K (0.64 cm) at 0.7 m/s (Churchill and Bernstein) | W/m2K | | R19 [read]; formula reproduced to 0.1 W/m2K here [derived] |
| Air blown into a bed | burning rate of a bed of 2 to 9 cm wood cubes rose to more than 6 times the still-air rate when air was blown into the bed; air blown into the plume changed nothing | - | Grumer and Strasser 1965 | R19 [sec]; R86 [sec] |
| Forced ventilation, cribs in tunnels | burning rate 1.3 to 1.5 times natural; rises quickly as ventilation starts, then levels off | - | Ingason and Lönnermark | R19 [sec] |
| Forced ventilation, Harmathy | only charring fuels (wood) burn faster; taller cribs gain more; past some flow the rate falls (losses or Damköhler) | - | 1.8 to 3.2 cm elements | R19 [sec] |
| Heavy vehicles in tunnels | up to 10 times natural heat release at 10 m/s (Bayesian estimate with expert opinion) | - | Carvel et al. 2001 | R19 [sec] |
| Char burning in air flow | brand mass loss proportional to air supply, rho_s dD/dt = -K rho_a U, K 0.0064 | | | R28 [read] |
| Fit of the 1.27 cm data | k = (R(0.7)/R(0) - 1)/0.7 per m/s: 0.19, 0.88, 0.09, 0.34 for cribs 1 to 4; against Heskestad's ventilation factor F = 1 - exp(-50 phi) (1.00, 0.18, 0.86, 1.00), k = 0.2 + 0.85 (1 - F) gives 0.20, 0.90, 0.32, 0.20 | 1/(m/s) | | [derived] from R19 |
| Convective loss check for thin sticks | Churchill and Bernstein h at 0.7 m/s is 34.6 W/m2K for 0.64 cm (13.7 at 0.1 m/s); at a 330 K surface excess this is about 11 kW/m2 of loss, 30 to 50% of a 20 to 40 kW/m2 in-bed flux, the size of the measured fall | | | [derived] |

Findings:
- Wind feeds thick-stick beds and starves thin-stick beds over the same 0 to 0.7 m/s. For 1.27 cm sticks the gain is linear in wind and largest where the bed is air-starved (dense packing). Blown air into the bed can reach 6 times; ventilated cribs in tunnels level off at 1.3 to 1.5 times.
- The thin-stick loss is about the size of the extra convective loss a 0.64 cm stick takes in that wind, so the sim's convective cooling term, applied to burning pieces too, can carry it.

Disagreement: the gains span 1.3 to 1.5 times (tunnel cribs, level off) to over 6 times (air blown into a heap of cubes) to 10 times (vehicles at 10 m/s). They differ by how the air is delivered: into the bed (large) or past it (small).

**Pick.** A flaming bed's burning rate (gas flux of every burning group, and char glow) is multiplied by M(u) = min(6, 1 + k u), with k = 0.2 + 0.85 (1 - F) per m/s and F = 1 - exp(-50 phi), phi the bed's Heskestad porosity in cm (section 17); u is the wind at the bed's height (section 14a) or, for blown air (breath, bellows), the air speed delivered into the bed. In the same step every piece, burning or not, carries a convective loss h(u, d) (T_s - T_a) with Churchill and Bernstein's h; this, not a separate rule, makes thin-stick beds burn slower in wind. Char glow keeps Albini's proportionality to air supply (section 6). Reasoning: M is the only form fitted to measured crib burning rates in wind, its ventilation term is the existing Heskestad factor, and the cap is the largest measured gain for air blown into a bed. Flags: k is fitted to four cribs at one stick size and at most 0.7 m/s; nothing measured between 0.7 m/s and Grumer's blown air; the multiplier and the convective loss may double count for 1.27 cm sticks (the measured gain is net of their extra cooling). Resolved for the plan: both terms apply to every burning group and every piece, so there is one law; the possible double count for 1.27 cm sticks stays a recorded model gap, since a size cut between the two terms would be a rule switch.

## 16. Grain row for a stick or log heated on its side

| Quantity | Value | Units | Conditions | Source |
|---|---|---|---|---|
| Quintiere's definition of the rows | "along the grain" heating: heat flows parallel to the fibres, volatiles escape easily along them, conductivity parallel to the grain is about twice that across; the Table 9.1 footnote marks the bracketed L values as "heat transfer parallel to the wood grain" | | Fundamentals of Fire Phenomena, sec. 7.6 and Table 9.1 (Figure 7.10 defines the terms) | R2 [read] |
| Spearpoint and Quintiere's sample naming | samples "with the grain parallel to the incident heat flux (i.e. cut across the grain)" and "perpendicular to the incident heat flux (i.e. cut along the grain)"; across-grain samples given 2.1 times the along-grain thermal diffusivity | | Cone tests of 4 species, 25 to 75 kW/m2 | R3 [ex: quoted in a search excerpt]; this labels samples by the cut, the opposite sense to the book |
| Ignition rows (Table 7.3) | across: Tig 375 (redwood), 384 (Douglas-fir), 305 (red oak), 354 (maple) C; kρc 0.22, 0.25, 1.0, 0.67. Along: Tig 204, 258, 275, 150 C; kρc 2.1, 1.4, 1.9, 11.0 (kW/m2K)^2 s. Measured critical flux across 13, 12, -, 12; along 9, 9, -, 8 kW/m2 | | 50 mm samples, MC 5 to 10% | R2 [read] |
| Burning rows (Table 9.1, text) | L across: Douglas-fir 12.5, redwood 9.4, red oak 9.4, maple 4.7 kJ/g; along (parallel): 6.8, 4.6, 7.9, 6.3 kJ/g. From the slope of peak mass flux vs flux | kJ/g mass lost | | R2 [read] |
| Char yield, Douglas-fir | 0.25 +/- 0.07 along; 0.45 +/- 0.15 across; L per original mass 6.8 x 0.75 = 5.1 (along) and 12.5 x 0.55 = 6.9 kJ/g (across) | | | R2 [read] |
| Quintiere's own extinction calculation | uses L about 6.8 kJ/g for Douglas-fir and finds it needs about 18 kW/m2 of external flux to burn in air | | Flame radiation zero, h 9 W/m2K, flame 1300 C at extinction | R2 [read, Table 9.4 and Fig. 9.26] |
| Tran and White orientation | heat flux perpendicular to the grain (side grain), grain horizontal; burning rate linear in flux over 15 to 55 kW/m2; apparent kρc 1.6 to 2.0 times the ambient value (1.8 used) | | Redwood, southern pine, red oak, basswood, 8 to 9% MC | R5 [read]; their tabled mass-loss slopes did not survive text extraction (gap) |
| Bartlett et al. heat of gasification | typically 1.82 kJ/g for wood (Tewarson and Pion, Douglas-fir), used with explicit flame and loss fluxes; CLT extinction 3.5 g/m2s at 31 kW/m2 | | Review | R14 [ex, search excerpt], R15 [ex] |
| Babrauskas energy check | with flaming 13 MJ/kg of volatiles and char 30 MJ/kg (R13), char fraction X_c = (net bomb - 13)/(30 - 13): 0.28 at 17.8, 0.31 at Douglas-fir's 18.3, 0.44 at 20.4 MJ/kg | - | | [derived] from R13 |
| Side-grain charring check | spruce char rate 0.24 to 0.69 mm/min over 10 to 25 kW/m2 (R17) gives L = 5.9 (X_c 0.25) or 8.1 (X_c 0.45) kJ/g at density 450; Butler's beta = 0.028 q matches L (1 - X_c) of about 4.8 kJ/g | kJ/g | | [derived] from R17, R16 |
| Implied regression of each row | across (12.5, 0.45): beta = 0.019 q mm/min; along (6.8, 0.25): 0.026 q; Butler 0.028 q | mm/min, q in kW/m2 net | density 450 | [derived] |
| Net flux to hold 3.5 g/m2s | L 12.5 (across, DF): 43.8; L 9.4 (across, redwood or red oak): 32.9; L 6.8 (along, DF): 23.8; L 1.82 (Tewarson and Pion): 6.4 | kW/m2 net to the surface | m'' x L | [derived] |

Findings:
- A stick or log heated on its side takes heat across its fibres. In Quintiere's book naming that is the "across" row. The row is identified by its properties, not only its label: the across row carries Tig 375 to 384 C and kρc 0.22 to 0.25, which match the side-grain ignition values the constants document already picked (Tig 350 C, kρc 0.22 from Tran and White's side-grain tests). The along row's kρc of 1.4 to 2.1 fits end grain, where heat runs down the fibres.
- Spearpoint and Quintiere's papers name samples by how they were cut, so their "along the grain" sample may be the book's "across" heating. Read their rows through the book's definitions or through the property match above, never by the bare label.
- The across row's burning values (L 12.5, X_c 0.45 for Douglas-fir) sit at the high end of every cross-check: the Babrauskas energy balance prefers X_c about 0.3 (0.45 is at the top of the bomb range); side-grain charring rates imply L 6 to 8; Quintiere himself used 6.8 for Douglas-fir extinction. Per original mass the two rows differ less (6.9 vs 5.1 kJ/g).

Disagreements:
- The constants document today mixes rows: ignition from the across row (Tig, kρc) and burning from the along row (L 6.8, X_c 0.25).
- L ranges from 1.82 (pure pyrolysis heat, used with explicit losses) through 6.8 to 12.5 kJ/g, so the net flux to keep 3.5 g/m2s ranges from 6 to 44 kW/m2.

**Pick.** The side of a stick or log follows the across row (heat perpendicular to the grain), for ignition and burning alike: Douglas-fir L = 12.5 kJ/g of mass lost and char yield 0.45 for softwood; for hardwood the across L of red oak, 9.4 kJ/g (maple 4.7 is the outlier), with char yield 0.45 for lack of a hardwood value [gap]. Holding 3.5 g/m2s then needs 44 kW/m2 net on softwood and 33 kW/m2 on hardwood. Reasoning: the plan takes L and char yield from the same row as ignition, and only the across row's ignition properties match the side-grain data already in the document. Resolved for the plan: the regression is derived from the same row, beta = m'' / (rho (1 - X_c)), so mass loss and char depth follow one law (0.019 q mm/min at density 450 for softwood); Butler's measured 0.028 q stays as a disagreement. The charring-consistent L (1 - X_c) of about 4.8 kJ/g per original mass is recorded as that disagreement, not held in reserve: if a criterion fails with these values, it is a model gap to report, not a reason to switch rows.

## 17. Bed geometry: packing, footprint, in-flame share, view factor

| Quantity | Value | Units | Conditions | Source |
|---|---|---|---|---|
| Packing ratio of piled woody debris | wood volume / gross pile volume: 0.06 to 0.26 over 17 sampled piles; ponderosa-dominated piles, large pieces under 10 in: mean 0.10; short-needled conifer piles 0.15 to 0.20; compacted clean log piles up to 0.25 | - | Destructive sampling | R87 [read] |
| Hand piles | 0.10 recommended (Hardy, CONSUME); 0.15 better for conifer hand piles, worse for shrub and hardwood piles | - | | R88 [ex] |
| Pile shapes | half-sphere (width twice height), half-paraboloid (round, tall, flat), half-cylinder, half-frustum, half-ellipsoid, irregular; gross volume from shape, net wood = gross x packing ratio | | | R87 [read] |
| Crib packing ratio | layers touching, horizontal gap s between sticks of thickness b: beta = b/(b + s) = 1/(1 + s/b): 0.67, 0.5, 0.31, 0.25 at s/b 0.5, 1, 2.23, 3 | - | | [derived] |
| Anderson's crib limits | flaming not sustained in cribs of 5 cm or thicker sticks when edge-to-edge gap exceeds 3 thicknesses; burning rate per exposed area peaks near porosity sqrt(A_v/A_s) = 0.21; flame length falls sharply above porosity 0.3 or spacing 2.23:1; crib depth 20.3 cm for the 5.08 cm sticks | | Ponderosa pine, Douglas-fir, lodgepole, spruce-fir, 6% MC | R20 [read] |
| Burning pattern of cribs | well-ventilated cribs burn uniformly, the whole crib in flame at once; densely packed cribs, or cribs short of air underneath, burn from the outside edges inward | | | R19 [read] |
| Mean free path of radiation in a fuel bed | delta = 4 / (sigma beta), sigma the surface-to-volume ratio; for round pieces of diameter d, sigma = 4/d so delta = d / beta | m | de Mestre et al. 1989 | R89 [ex] |
| View factor between two parallel cylinders | F = [sqrt(X^2 - 1) + asin(1/X) - X] / pi, X = 1 + gap/d: 0.18 touching; 0.11, 0.081, 0.054, 0.050, 0.040, 0.027 at gap/d 0.5, 1, 2, 2.23, 3, 5 | - | Infinite parallel cylinders, crossed-string method; the touching value (pi - 2)/(2 pi) was checked by hand | [derived] |
| Bamford's facing panels | flaming stops beyond a 51 mm gap for 229 mm panels, 127 mm for 914 x 381 mm panels, view factor about 0.65 at those gaps (infinite-strip values would be 0.80 and 0.72) | - | | R53 [sec]; strip values [derived] |
| Check of the panels against L | 0.65 sigma T^4 from a facing surface at 700, 800, 900 C: 33, 49, 70 kW/m2; with L 12.5 kJ/g and about 30 kW/m2 of surface loss this gives m'' of 0.2 to 3.2 g/m2s plus the panel's own flame, i.e. near the 3.5 g/m2s limit at the critical gap, as observed | | | [derived] |
| Beer form at Anderson's limit | for a crib with beta 0.25, d 5.08 cm, half-depth 10.15 cm: F = 1 - exp(-beta l/d) = 0.39; at beta 0.10, 0.20, 0.33, 0.50: 0.18, 0.33, 0.48, 0.63 | - | | [derived] |
| Heap example | 12.6 litres of solid wood (ten 3 x 50 cm sticks, three 8 x 60 cm logs) as a half-sphere: radius 0.39, 0.34, 0.31, 0.29 m at packing 0.10, 0.15, 0.20, 0.25 | m | | [derived] |
| Volume share of a half-sphere below height x H | (3x - x^3)/2: 0.37, 0.69, 0.91, 1.00 at x 0.25, 0.5, 0.75, 1 | - | | [derived] |

Findings:
- Measured packing of real heaps (0.06 to 0.26, typically 0.10 for hand-built piles) sits below a crib at Anderson's limit (0.25), so thick pieces in loosely heaped fires sit near or beyond the spacing at which they stop flaming, which matches the common sight of unburnt log ends in hand piles.
- Two anchors give two numbers that must not be confused: one neighbour at Anderson's 3-thickness gap is only F = 0.04 (a crib piece has many neighbours plus flames in the gaps), while Bamford's lone pair needs F about 0.65. A Beer-law packing form, with the mean free path d/beta, puts a piece at Anderson's limit at about 0.4 of its view filled by burning neighbours, between the two.
- The panel check shows the existing extinction flux (3.5 g/m2s) and the across-row L (12.5 kJ/g) reproduce Bamford's critical gap if facing surfaces glow at 800 to 900 C.

**Pick.**
- Packing ratio of a person-built heap: 0.10 (Hardy's value for hand piles); a stacked or log-cabin lay is a crib, beta = 1/(1 + s/b), with the lay's own spacing (defaulting to touching layers and s = b, beta 0.5, if the act gives no spacing).
- Heap footprint: half-sphere of volume V_solid / beta, radius R = (3 V / (2 pi))^(1/3), height R, footprint pi R^2 and fire diameter 2R for Heskestad. Reasoning: Hardy's first shape; a lit heap slumps toward it.
- In-flame share of a group: the bed's flame rises from the base, so the share of the heap's surface inside the flame is the half-sphere's volume share below the flame height, s = (3x - x^3)/2 with x = min(1, L_f / R), L_f from Heskestad with the footprint diameter. Groups are spread through the heap in proportion to volume, so every group gets the same share.
- Packing view factor (share of a piece's view filled by burning neighbours): F = 1 - exp(-beta l / d), with l the mean distance to the heap surface, taken as R/2 for a half-sphere, and d the piece thickness. Anchors: 0.39 at Anderson's limit; a lone pair at Bamford's gap is a separate geometry (0.65) used only as the check above. Flags: the Beer form treats the heap as random; cribs with straight vents see out further than this; no measured packing view factor for heaps was found [gap].

## 18. Warmth: radiant flux to operative temperature, and carried tinder

| Quantity | Value | Units | Conditions | Source |
|---|---|---|---|---|
| Effective radiant field | ERF = f_eff h_r (t_r - t_a); f_eff 0.696 seated, 0.725 standing | W/m2 of body surface | | R90 [read], R91 [read] |
| Absorptivities | long-wave 0.95 (skin and clothing); short-wave 0.7 default, 0.57 to 0.84 by skin and clothing colour (white clothing 0.2, khaki 0.57, black 0.88; white skin 0.57, brown 0.65, black 0.84) | - | | R90 [read], R91 [read] |
| Direct beam | E_dir = f_p f_eff f_bes T_sol I_dir; alpha_LW ERF_solar = alpha_SW E_solar; t_rsw = ERF_solar / (h_r f_eff) | | f_bes the unshaded share of the body | R90 [read] |
| h_r in the standard's code | 6 | W/m2K | ASHRAE 55 Normative Appendix C reference implementation | R90 [read] |
| Projected area factor f_p (Fanger) | standing, sun in front: 0.35 at altitude 0 and 15 degrees, 0.314 at 30, 0.258 at 45, 0.206 at 60, 0.144 at 75, 0.082 at 90; sun from behind 0.347 at 0. Seated, in front: 0.29, 0.324, 0.305, 0.303, 0.262, 0.224, 0.177 | - | Tabled every 15 degrees of altitude and of azimuth | R90 [read] |
| Clear-sky beam | 210, 390, 620, 740, 810, 860, 890, 910, 920, 925 W/m2 at altitude 5, 10, 20 to 90 degrees | W/m2 | Below 900 m elevation | R90 [read] |
| Validation | heat lamps 200, 400, 600 W/m2 on seated subjects (0.7 clo, 1.2 met, 23 to 24 C air): measured Delta MRT 14.3, 18.4, 20.0 K vs SolarCal 7.7, 15.4, 23.1 K; about one PMV unit per 200 W/m2; SolarCal sensation error under 0.1 PMV on average. An ambient change of 1.5 C equals 0.5 PMV | | Hodder and Parsons test | R91 [read] |
| Whole-body radiative coefficient | 4.5 seated and standing | W/m2K | Nude manikin, still air | R92 [read], de Dear et al. 1997 |
| Whole-body convective coefficient | still air 3.3 seated, 3.4 standing; moving air 10.4 V^0.56 standing and 10.1 V^0.61 seated (de Dear); 9.41 V^0.61 and 9.43 V^0.63 (Oguro) | W/m2K | V in m/s | R92 [read] |
| Operative temperature | t_o = (h_r t_r + h_c t_a) / (h_r + h_c) | C | | R93 [ex] |
| Fire as a beam on the body | with q = chi_r Q / (4 pi R^2) the flux normal to the line of sight, Delta t_r = f_p q (alpha_fire/alpha_LW) / h_r and Delta t_o = f_p q (alpha_fire/alpha_LW) / (h_r + h_c) | K | Same algebra as the direct-beam term | [derived] from R90 |
| Worked values | 10 kW fire at 1 m (q 240 W/m2), standing, facing it (f_p 0.35), alpha ratio 1: Delta MRT 14 K, Delta t_o 8.9 K in still air, 3.9 K in 2 m/s wind. Sun 1000 W/m2 at 60 degrees altitude (f_p 0.206, alpha ratio 0.7/0.95): Delta MRT 25 K, Delta t_o 16 K still, 7.1 K at 2 m/s | K | h_r 6 | [derived] |
| Absorptivity for flame radiation | flame radiation is mostly infrared; no measured skin or clothing absorptivity for wood-flame spectra was found | - | | gap; ratio 1 assumed [UNVERIFIED] |
| Clothing microclimate | under freely chosen comfortable clothing (0.78 to 2.10 clo) at 14, 23, 25, 29 C air: chest microclimate 31.6 to 33.5 C, interscapular 32.2 to 33.4 C, innermost clothing layer 28.6 to 32.0 C; all rise with air temperature | C | 20 subjects, 45% RH, 0.14 m/s | R94 [read, abstract] |
| Microclimate humidity | microclimate temperatures similar across suits, but RH and vapour pressure in the microclimate much higher than ambient | | 8 mm from the skin | R95 [ex] |
| Bed microclimate | people under blankets make a microclimate of about 34 C; nude comfort when awake needs 28 to 30 C air | C | Muzet et al. 1984, as cited | R92 [sec] |
| Mean skin temperature | about 33 to 34 C in comfort at rest (Fanger's comfort equation t_sk = 35.7 - 0.0275 (M - W) gives 34.1 C at 58 W/m2) | C | Not read in a primary source | [UNVERIFIED]; cool-air nude and clothed values: gap |
| Body-warm drying, practitioner | damp tinder wrapped loosely in a bandanna next to the stomach "may take over three hours to dry" | h | | R69 [read] |
| EMC of a pocketed item | microclimate 32 C. Holding ambient vapour pressure (10 C, RH 0.85, 1.04 kPa): RH 0.22, EMC 4.4%. Adding 0.5 or 1.0 kPa of skin moisture: RH 0.32 or 0.43, EMC 6.1 or 7.8%. At 18 C air: 6.8 to 9.9%. At 0 C: 2.7 to 6.1% | % MC | Simard EMC | [derived] |

Findings:
- The ASHRAE/SolarCal path gives a clean conversion. For a beam from one direction, the person's mean radiant temperature rises by f_p q alpha / h_r and the operative temperature by f_p q alpha / (h_r + h_c). Wind does not change the radiant gain but dilutes it in operative temperature through h_c.
- Checked against sunlight: 1000 W/m2 of high sun raises operative temperature about 16 K in still air and 7 K in a 2 m/s breeze; the heat-lamp test found about one sensation unit (3 K of air) per 200 W/m2, the same order.
- Tinder carried against the body sits in air at about 29 to 33 C. Even if the microclimate holds 1 kPa more vapour than the outside air, its equilibrium moisture is 4 to 10%, below both catching limits of section 10, so carried tinder dries by body warmth over hours (Baugh: over three hours).

Disagreement: SolarCal underpredicts the heat-lamp test at 200 W/m2 (7.7 vs 14.3 K) and overpredicts it at 600 (23.1 vs 20.0); h_r is 6 in the standard's code but 4.5 on a manikin, a 25% difference in Delta MRT.

**Pick.**
- Warmth from a fire: Delta t_o = f_p q / (h_r + h_c), with q = chi_r Q / (4 pi R^2), f_p 0.35 for a person facing a fire near ground level (standing, low altitude; 0.29 seated), h_r 6 W/m2K (ASHRAE 55's own value, so the sunlight check and the fire use one number), h_c = 3.4 W/m2K in still air or 10.4 V^0.56 in wind V at body height, and an absorptivity ratio of 1 for flame infrared [gap flagged]. Apply the same with alpha ratio 0.7/0.95 and f_p from the table for the sun, so fire and sun warm people by one law.
- Carried tinder: an item in a pocket or pouch against the body relaxes toward the EMC of air at 32 C carrying the outside vapour pressure plus 0.5 kPa (a mid value, since the microclimate is measured as more humid than ambient but no number was read), giving about 5 to 8% in the sim's climate; its time constant is the item's own (thickness squared law), not shortened by sun or wind. Reasoning: measured microclimate temperatures are tightly 31.6 to 33.5 C across seasons; the vapour addition is the uncertain term [flagged].

## 19. Allometry: trunks, branches, twigs, shrub stems

Units: D is diameter at breast height (1.3 m) over bark in cm, H is total height in m, masses are dry kg. "Stand-grown" means trees measured inside forest stands; "open-grown" means lone trees. The sim's trees run 4 to 20 m and its shrubs 0.5 to 3.5 m.

### 19a. Trunk diameter from height

Two independent sources. (1) R98, BAAD, the Biomass And Allometry Database: raw per-tree height and D of harvested trees; I fitted ln D = ln a + b ln H by least squares to the rows for each species or nearest analogue (my fits, so [derived] from [read] data). (2) R97, the iLand species database (Thom et al. 2024), which gives each species a height-to-diameter ratio HD = H / (D/100) as a function of D, with a lower bound for open-grown trees (HDlow) and an upper bound for trees under heavy competition (HDhigh). iLand interpolates between the two by the light a tree gets. Every iLand bound has the form HD = c D^-k, which inverts exactly to D = (100 H / c)^(1/(1-k)). Below 4 m iLand uses a fixed sapling ratio sapHD, so D = 100 H / sapHD.

| Quantity | Value | Units | Conditions | Source |
|---|---|---|---|---|
| Scots pine, stand-grown | D = 1.721 H^0.842; D at H 4, 8, 12, 15, 20 m: 5.5, 9.9, 13.9, 16.8, 21.4 | cm, m | n 316 trees, H 2.1 to 32.4 m, D 1.1 to 41.9 cm; managed stands in central Sweden (Albrektson 1984, n 192), Finland (Vanninen 2005, n 117), Spain (Santa Regina 1999, n 7); residual SD of ln D 0.34 | R98 data [read]; fit [derived] |
| Scots pine, per study | Albrektson: D = 2.025 H^0.808; Vanninen: D = 0.877 H^1.045 (at 15 m: 18.0 and 14.8 cm) | cm, m | as above | R98 [read]; fits [derived] |
| Oak (deciduous Quercus analogue) | D = 0.489 H^1.334; at H 4, 8, 12, 15, 20: 3.1, 7.8, 13.4, 18.1, 26.5 | cm, m | n 242, H 2.5 to 31.9 m, D 1.1 to 63 cm; Q. alba, rubra, prinus, coccinea (Coweeta, USA), Q. crispula, serrata, acutissima, variabilis (Japan), Q. pyrenaica (Spain). BAAD holds no Q. robur or Q. petraea. | R98 [read]; fit [derived] |
| Aspen (Populus tremuloides analogue) | D = 0.343 H^1.371; at H 4, 8, 12, 15, 20: 2.3, 5.9, 10.4, 14.1, 20.9 | cm, m | n 100, H 1.5 to 26.1 m; Manitoba and British Columbia stands. BAAD holds no P. tremula; P. tremuloides is its North American sister species. | R98 [read]; fit [derived] |
| Silver birch (check only) | D = 0.372 H^1.273; at 15 m 11.7 cm | cm, m | n 30, Finland | R98 [read]; fit [derived] |
| Ash | no adult height and D pairs in BAAD (Petritan 2009 rows are shade saplings without D) | | | gap in R98 |
| iLand HD bounds, pine (temperate) | HDlow = 46.53 D^-0.129; HDhigh = 243.6 D^-0.58; sapHD 105 | H/(D/100) | Open-grown D at H 4, 8, 12, 15, 20: 11.8, 26.2, 41.7, 53.9, 75.0 cm; crowded: 3.3, 17.0, 44.5, 75.8, 150 cm | R97 [read]; inversions [derived] |
| iLand HD bounds, oak (Q. robur and Q. petraea share one set) | HDlow = 65.45 D^-0.357; HDhigh = 162.46 D^-0.3244; sapHD 112 | as above | Open: 16.7, 49.1, 92.2, 130, 204 cm; crowded: 3.8, 10.6, 19.3, 26.8, 41.1 cm (H 4, 8, 12, 15, 20) | R97 [read]; [derived] |
| iLand HD bounds, ash | HDlow = 69.32 D^-0.3236; HDhigh = 290.0 D^-0.4839; sapHD 133 | as above | Open: 13.3, 37.2, 67.7, 94.2, 144 cm; crowded: 1.9, 7.1, 15.7, 24.1, 42.2 cm | R97 [read]; [derived] |
| iLand HD bounds, aspen | HDlow = 61.12 D^-0.2427; HDhigh = 167.31 D^-0.3326; sapHD 142 | as above | Open: 12.0, 29.8, 51.0, 68.5, 100 cm; crowded: 3.7, 10.4, 19.1, 26.7, 41.2 cm | R97 [read]; [derived] |
| iLand HD bounds, hazel | HDlow = 76.39 D^-0.2427; HDhigh = 204.66 D^-0.3676; sapHD 119; maximumHeight 10 m | as above | At H 2 and 4 m: open 3.6 and 8.9 cm, crowded 1.0 and 2.9 cm, sapling ratio 1.7 and 3.4 cm | R97 [read]; [derived] |
| iLand wood density used for volume | pine 490, oak 650, ash 650, aspen 420, hazel 680 | kg/m3 | Model parameter, basis not stated | R97 [read] |
| iLand bark thickness factor | bark thickness (cm) = 0.065 x D for all five species | cm | Generic default | R97 [read] |

Checks and disagreements [derived]:
- For broadleaves the two sources agree in magnitude: at H 15 m, stand data give oak 18 cm and aspen 14 cm, iLand's crowded bound gives 27 cm for both and ash 24 cm; iLand's open-grown bound gives 69 to 130 cm. Lone trees are two to five times fatter than forest trees of the same height.
- iLand's pine bounds are unusable above about 10 m: HDhigh crosses HDlow at H about 11 m, and at 15 m both give 54 to 76 cm, against 17 cm in the Swedish and Finnish stand data. I flag R97's pine HD functions as unreliable and do not use them.
- The stand-data fits are pooled across sites and stand densities; one tree can sit a factor e^0.34 (1.4) either side of the line.

### 19b. Crown fuel: totals and size classes

| Quantity | Value | Units | Conditions | Source |
|---|---|---|---|---|
| Branch dry mass, iLand | pine 0.011057 D^2.4796; oak 0.1349 D^1.8113; ash 0.022 D^2.3; aspen 0.042851 D^1.8733; hazel 0.022 D^2.3 | kg, D in cm | At D 10 / 20 / 40 cm: pine 3.3 / 18.6 / 104; oak 8.7 / 30.7 / 108; ash 4.4 / 21.6 / 107; aspen 3.2 / 11.7 / 43 | R97 [read]; evaluations [derived] |
| Foliage dry mass, iLand | pine 0.012504 D^2.1826; oak 0.02493 D^1.7; ash 0.048475 D^1.43; aspen 0.03 D^1.4816; hazel 0.029085 D^1.7 | kg | At D 20 cm: pine 8.6, oak 4.1, ash 3.5, aspen 2.5, hazel 4.7 | R97 [read]; [derived] |
| Stem wood dry mass, iLand | pine 0.061544 D^2.4051; oak 0.180585 D^2.20123; ash and hazel 0.22225 D^2.2504; aspen 0.035707 D^2.7398 | kg | At D 20 cm: pine 83, oak 132, ash 188, aspen 131 | R97 [read]; [derived] |
| Size classes used by fire science | foliage; 0 to 0.24 in (0 to 0.63 cm); 0.25 to 0.99 in (0.64 to 2.53 cm); 1.00 to 2.99 in (2.54 to 7.61 cm); 3 in and over. The three woody classes under 3 in match the 1-, 10- and 100-h timelag classes. | | | R99 [read] |
| Cumulative crown fractions, ponderosa pine, intermediate crown class, live crowns, D over 1 in | P1 (foliage) = 0.650 e^(-0.154 d); P2 (P1 plus 0 to 0.63 cm) = 0.844 e^(-0.166 d); P3 (P2 plus 0.64 to 2.53 cm) = 1.086 e^(-0.0833 d), P3 = 1 if d is 1 in or less; d = D in inches | fraction of live crown mass | Evaluated at D 10 / 25 / 51 cm: foliage 0.35 / 0.14 / 0.03; twigs under 0.63 cm 0.08 / 0.02 / 0.00; 0.64 to 2.53 cm 0.34 / 0.31 / 0.18; over 2.54 cm 0.22 / 0.53 / 0.80 | R99 Appendix III [read from a scanned OCR; the dominant-tree rows for the other 10 species could not be matched to species in the OCR] |
| Whole trees under 15 ft (4.6 m), 11 Rocky Mountain conifers | cumulative foliage fraction 0.15 to 0.51; foliage plus twigs under 0.63 cm 0.23 to 0.72 of whole-tree crown mass, falling with height class | fraction | Fractions for individual species within 20% of their group average | R99 Appendix III [read; table partly garbled, ranges only] |
| Japanese red pine (Pinus densiflora), nearest 2-needle Eurasian analogue of Scots pine | needles about 22% and branches about 78% of crown fuel; fuel up to 1.0 cm (needles plus branchlets) about 45% of crown fuel | fraction | 67 felled trees, 7 regions of South Korea | R100 [ex] |
| Crown bulk density, live crowns | 0.04 to 0.14 lb/ft3 (0.6 to 2.2 kg/m3) foliage plus branchwood, about twice that of foliage alone; higher in upper crowns | kg/m3 | 11 Rocky Mountain conifers | R99 [read] |
| Dead share of crown, intermediates | ponderosa pine 18.3%, Douglas-fir 11.8%, western redcedar 6.0%, grand fir 2.6% | % of crown mass | Intermediate crown class | R99 [read] |
| Branching rule | area preserving (Leonardo's rule): sum of daughter branch cross-sections equals the parent's, so a branch of diameter D_b ends in about (D_b / d_twig)^2 twigs | - | Exponent commonly reported near 2 | [UNVERIFIED], no source read in this session |
| Terminal twig diameter | gap: no measured value read for the sim species. NFDRS's 1-h class (under 6.35 mm) bounds it from above. | mm | | gap |

Checks [derived]:
- Branch mass rises with D faster than foliage; at D 20 cm, branches are 18 to 31 kg and foliage 2.5 to 8.6 kg per tree in iLand. Pine carries about twice the foliage of the broadleaves at the same D.
- The ponderosa pine fine-twig fraction (2% of crown at D 25 cm) is low against Pinus densiflora's 23% of crown in branchlets up to 1 cm (45% minus 22% needles). Ponderosa pine has unusually thick shoots; Scots pine shoots are thinner, so the densiflora split is the better analogue for the sim's pine.

### 19c. Shrub stems

| Quantity | Value | Units | Conditions | Source |
|---|---|---|---|---|
| Hazel (Corylus avellana) | per-stem D = 100 H / 119 (iLand sapling ratio), so 0.4 cm at 0.5 m, 1.3 cm at 1.5 m, 2.9 cm at 3.5 m; crowded-tree bound 2.3 cm at 3.5 m; open-grown bound 7.5 cm at 3.5 m | cm | iLand treats hazel as a small tree with maximum height 10 m | R97 [read]; [derived] |
| Gorse (Ulex europaeus), growth | stem diameter grows about 5 mm a year while height grows about 20 cm a year; maximum height 7 m, maximum stem diameter 21.7 cm | mm/yr, cm/yr | New Zealand stand (Lee et al. 1986 as cited) | R101 [sec] |
| Gorse, mature stand | 60 000 stems/ha with basal area 51 m2/ha at 15 years | | same | R101 [sec] |
| Gorse, mean stem diameter | quadratic mean diameter = sqrt(4 x 51 / (π x 60 000)) = 3.3 cm | cm | from the row above | [derived] |
| Gorse, ratio of diameter to height growth | 0.5 cm per 20 cm, so D grows about 2.5 cm per m of height | cm/m | from the growth row; the maxima give 3.1 cm/m | [derived] |
| Gorse, aboveground biomass and fuel | ln(AGB) = 1.44 + 0.872 ln(OsHt) + ln(1.02); ln(fuel load) = 0.848 + 0.552 ln(OsHt) + ln(1.04), OsHt = overall shrub height; fuel load = foliage plus fine branches under 6 mm | units not seen (likely kg/m2 and m) | Pearce et al. 2010, New Zealand gorse shrublands | R102 [sec; units UNVERIFIED] |
| Gorse, structure | in dense stands a single main stem, on open sites several stems; much dead material in the centre; new green branches at the top, woody branches lower down, dry branches and spines throughout | | | R101 [sec] |
| Heather (Calluna vulgaris), fuel classes | foliage; live stems under 2 mm; live stems 2 to 5 mm; thicker stems; dead stems sorted the same way. Fine fuel = foliage plus stems under 2 mm. | mm | Scottish moorland fire experiments | R103 [ex] |
| Heather, dead share | live material 80 to 85% of fuel; up to 30% dead in some building-phase plots, mostly 2 to 5 mm stems left from the last fire | % | same | R103 [ex] |
| Heather, stem diameter by height | gap: no relation read. Heather diameter growth is very slow and stem thickness relates poorly to height. | | | R104 [ex] |
| Berry shrub analogue | Bramble (Rubus fruticosus agg.) picked over elder (Sambucus nigra): bramble is a berry shrub of about 1 to 2 m that forms thickets in the same NW European open woods and heaths; elder grows into a small tree to about 10 m, outside the sim's 1.5 m berry bush. | | | choice; no source |
| Bramble cane diameter | gap: no measured value read | | | gap |

**Pick (19a, trunks).** Forest-grown trees (canopy present): D = a H^b with pine (1.721, 0.842), oak (0.489, 1.334), aspen (0.343, 1.371) from the BAAD fits, and ash from iLand's crowded bound D = (100 H / 290.0)^1.938 (no ash data in BAAD; the bound sits within the broadleaf stand data, about 24 cm at 15 m against oak 18 and aspen 14). Lone trees: iLand's HDlow for the three broadleaves; for pine there is no usable open-grown curve, so take the stand-grown fit times the broadleaf ratio of open to crowded diameter at the same height (about 2.5 to 4.9 at 8 to 15 m) only if the sim needs lone pines, and record it as a gap. If the sim wants one curve per species, use the forest-grown one: the sim's trees stand in a canopy field. Reasoning: BAAD is measured trees; iLand's bounds are model parameters, and its pine bounds fail a basic check.

**Pick (19b, crown).** Crown dry mass from iLand's branch and foliage equations at the tree's D. Split branchwood by the Pinus densiflora shares for pine (needles 0.22 of crown, branchwood up to 1 cm 0.23, the rest 0.55) and, for broadleaves, by the ponderosa pine cumulative fractions without the foliage term (renormalised to branchwood) until a broadleaf source is found [gap]. Twig counts from the area-preserving rule [UNVERIFIED]. Disagreement flagged: the two conifer sources differ fourfold to tenfold in the fine-twig share.

**Pick (19c, shrubs).** Hazel: per-stem D = 100 H / 119 cm. Gorse: D = 2.5 H cm (H in m), so 1.25 cm at 0.5 m and 8.8 cm at 3.5 m, capped by the 3.3 cm stand mean for stems in a thicket [derived]. Heather and bramble: gaps; until filled, heather stems take the 2 to 5 mm class (R103) and bramble canes take hazel's ratio [UNVERIFIED].

## 20. Green wood seasoning

The check asked for: does a time constant τ = 10 h x (d / 12.7 mm)^2 (Nelson's 10-h stick as anchor) give published open-air drying times for freshly cut wood? MC here is dry basis; sources that quote wet basis (w) are converted by MC = w / (1 - w). "To 20%" means to 20% MC. For a slab of thickness L the first diffusion mode decays 2.34 times slower than a cylinder of diameter L (slab τ = L^2 / (π^2 D), cylinder τ = d^2 / (23.1 D)) [derived, standard diffusion eigenvalues, not cited], so a 25.4 mm board behaves like a 39 mm round.

| Quantity | Value | Units | Conditions | Source |
|---|---|---|---|---|
| Green 25 mm lumber to 20%, by species (US yards) | ash (white, black, green) 60 to 200; aspen (quaking, bigtooth) 50 to 150; northern red oak 70 to 200; northern white oak 80 to 250; beech 70 to 200; paper birch 40 to 200; eastern white pine 60 to 200; red pine 40 to 200; ponderosa and lodgepole pine 15 to 150 | days | Stickered hand-built piles; minimum for southern locations stacked in spring or early summer, maximum for northern locations stacked in autumn or early winter | R105 Table 7 [read] |
| Green 25 and 50 mm eastern hardwood lumber to about 20%, by region | ash: 25 mm 45 to 80 (South to Central), 60 to 165 (Mid-North); 50 mm 180 to 230. Oaks: 25 mm 50 to 120; 50 mm 190 to 360 | days | Four US regions | R105 Table 8 [read; species labels matched to rows by order in the OCR, oak rows inferred] |
| Northern red oak 25 mm, good season | about 60 days to 20% when yarded in June or July in southern Wisconsin; 120 days or more if piled in late autumn or winter | days | | R105 [read] |
| Thickness rule | drying time rises about as thickness^1.5; 50 mm takes about 3 times as long as 25 mm | - | Rule of thumb for lumber | R105 [read] |
| Debarked small logs, ponderosa pine, to 20% | 4 to 8 in (102 to 203 mm) logs from 75 to 187% MC: 9 to 25 days stacked 18 July; 16 to 39 days stacked 13 May; 21 to 51 days stacked 25 February; stacked 25 October, still at 20 to 51% after 129 to 134 days | days | Hayfork, California; covered stacks (plywood roof, no rain or direct sun); mean initial MC 120%, mean D 150 mm | R106 Table 2 [read] |
| Same, Douglas-fir | from 26 to 96% MC: 5 to 12 days (July), 10 to 23 (May), 24 to 40 (February), 126 to 135 (October) | days | same | R106 Table 3 [read] |
| Daily drying-rate model, ponderosa pine logs | ΔM = 0.00117 M^1.38 T^1.69 H^-0.558 D^-1.30; R^2 0.786 | %/day; M in %, T daily mean in F, H daily mean RH in %, D log diameter in inches | Debarked, covered; fitted over D 4 to 8 in | R106 Table 1 [read] |
| Same, Douglas-fir | ΔM = -2.67 + 0.156 M + 0.0262 T - 0.0189 H - 0.0885 D; R^2 0.723 | same | same | R106 Table 1 [read] |
| Late-season stall | logs stacked in late summer or autumn rarely dry much below about 25% before spring | | | R106 [read] |
| Pine logwood pile, bark on, open air | MC 50.1% to 32.2% in 14 months; read as wet basis (the European bioenergy convention; not stated in the abstract), i.e. dry basis 100% to 47.5% | | Austria, mean 7.3 C, RH 81%, 777 mm rain over the period; rain over 30 mm/day raised MC for 2 to 3 days only; RH the strongest driver | R107 [ex, abstract; log size not seen; basis assumed] |
| Logging residue (branches, tops) in small piles in the stand | MC (w) 46 and 41.6% to 19.3 and 20.8% in 6 weeks, i.e. dry basis 85 and 71% to 24 and 26% | | Finnish summer, constant-weight monitoring | R108 [ex] |
| Fresh logging residue | MC (w) 50 to 55% fresh; 2 to 3 weeks uncovered in early summer gives a large drop | | | R108 [ex] |
| Split vs unsplit firewood | unsplit 16 to 18 in rounds of live-cut hickory, uncovered: over 30% (meter reading) after one year; split pieces about 20% in 6 months | | Maryland, cut April | R109 [read] |
| Split firewood, four hardwoods, uncovered | from 25 to 33% (meter) to 20 to 26% after 6.5 months; hickory about 24% after a year | | Maryland, part shade, rain falling on the stacks; pin meter readings, which read low above fibre saturation | R109 [read] |

Checks [derived]:
- Simpson and Wang's model with Hayfork July weather (about 75 F, 40% RH) gives 11, 19, 27 days for 4, 6, 8 in logs from 120% to 20%, matching their measured 9 to 25 days. With the sim's own inland means (section 25) it gives, for 2, 4, 6, 8 in (51 to 203 mm) debarked covered logs: summer (18.4 C, RH 0.82) 8, 21, 36, 53 days; year mean (9.3 C, 0.85) 14, 35, 60, 88 days; winter (-0.4 C, 0.87) 31, 77, 130, 190 days. Caveat: the model has no equilibrium term, and at RH 0.85 and 10 C the Simard EMC is about 18.7% R30, so "to 20%" is near equilibrium and real times would be longer.
- The d^2 rule with the 10-h anchor gives τ (and the time from 100% to 20% at an EMC of 15%, which is 2.83 τ): 12.7 mm stick τ 10 h (1.2 days); 25 mm board 94 h (11 days); 50 mm board 374 h (44 days); 102 mm log 640 h (76 days); 152 mm log 1440 h (170 days); 203 mm log 2555 h (302 days).
- Against the data:
  - boards: the rule is 4 to 15 times too fast (11 days against 45 to 200 for 25 mm; 44 against 170 to 360 for 50 mm);
  - green branches: the Finnish residue went 85% to 25% in 42 days, so τ about 21 days (520 h) for branches of order 1 to 3 cm; the rule gives about 25 h for 2 cm, 20 times too fast;
  - logs: the rule's 170 days for 152 mm lies between debarked covered logs in dry summer heat (12 to 25 days, i.e. τ 5 to 10 days) and bark-on logs piled in the open in a climate like the sim's (Erber: τ about 420 days fitted to 100% to 47.5% in 14 months toward an EMC of 18%).
- Size exponent: green wood seasoning scales with thickness to the 1.3 (log model, D^-1.30 in the daily loss), 1.5 (lumber rule) and 1.8 (25 to 50 mm hardwood, times 3.5 to 4) power, not 2.
- Why the 10-h anchor fails for green wood: the 10-h stick measures the response of weathered dead wood to humidity changes below fibre saturation. Fresh wood starts far above fibre saturation (Wood Handbook green MC 40 to 170%, R6, and bark, stacking and rain slow it further.

Disagreement flagged: no single τ(d) fits every source. Treatment (bark on or off, covered or not, piled or not) and weather change seasoning time by 10 to 40 times at a fixed size; size changes it as about d^1.5.

**Pick.** Keep the plan's τ = 10 h x (d / 12.7 mm)^2 for dead fuel exchanging moisture with the air below fibre saturation (its cited use). For wood cut green, record as a model gap that seasoning above fibre saturation is slower and scales more weakly with size. If the sim wants a cited green-wood constant, use τ_green = 500 h x (d / 25 mm)^1.5 for exposed bark-on green wood in the sim's mild humid weather [derived]. It is anchored on 25 mm boards to 20% in about 60 days in good weather (2.83 τ = 60 days gives τ about 500 h), takes the lumber rule's 1.5 exponent, and checks against:
- 2 cm residue branches: 360 h predicted against 520 h fitted;
- 15 cm bark-on logs: 7350 h (306 days) predicted against Erber's τ of about 420 days.
Against the 40-day year (960 h): with the d^2 rule a 15 cm log needs τ = 1.5 game years; with τ_green, 7.7 game years. Either way, logs felled green do not season within a game year. Twigs under 6 mm season within days, and 2 cm branches within one game year. Fallen dead wood, already seasoned, is what a year's fires can burn. This is the "seasoning time of the logs the allometry gives" result the plan asks to report.

Resolved for the plan: wood cut from a living plant holds free water through its cells and dries with τ_green until it first reaches fibre saturation (30%); from then on, and for dead wood rewetted by rain, it follows the d^2 rule. The two laws meet at fibre saturation, where free water gives way to bound water. Section 26 sets both against the sim's trees.

## 21. The eight sim species

Basic specific gravity G = oven-dry mass / green volume (basic density in t/m3 equals G). Maximum moisture from section 5's relation MC_max = 100 (1.54 - G) / (1.54 G) (R6) [derived]. Green MC is dry basis.

| Quantity | Value | Units | Conditions | Source |
|---|---|---|---|---|
| Basic density, Pinus sylvestris | 0.42 | t/m3 | Default for inventories | R110 Table 4.14 (Dietz 1975) [read] |
| Basic density, Quercus spp. | 0.58 | t/m3 | same | R110 [read] |
| Basic density, Fraxinus spp. | 0.57 | t/m3 | same | R110 [read] |
| Basic density, Populus spp. | 0.35 | t/m3 | same | R110 [read] |
| Basic density, Betula spp. (hazel's family, check) | 0.51 | t/m3 | same | R110 [read] |
| Density, Corylus avellana | 0.53 to 0.63 g/cm3 (moisture basis not stated, likely air-dry); oven-dry density 0.67 g/cm3 in a particleboard study | g/cm3 | | R111 [ex]; R112 [ex] |
| Wood density, Ulex europaeus | mean 0.718, range 0.599 to 0.879 (n 5) | g/cm3 | Invasive stands, Colombian Andes; highest of 86 woody species measured; shrubs there averaged 0.552 | R113 Table 2 [read] |
| Wood density, Calluna vulgaris | gap: no value found | | | gap |
| Wood density, bramble (Rubus fruticosus agg.) | gap: no value found | | | gap |
| iLand model densities (check) | pine 490, oak 650, ash 650, aspen 420, hazel 680 | kg/m3 | Basis not stated; higher than R110, probably not basic | R97 [read] |
| Green MC, Scots pine | heartwood 30 to 34% (trees 71 to 146 years) and 34 to 41% (37 to 70 years); sapwood 113% in summer to 130% in winter | % | Latvian or Baltic stands (paper title: Scots pine stem wood and bark moisture and density influencing factors) | R114 [ex] |
| Green MC, red pine (Pinus resinosa, 2-needle hard pine analogue) | heartwood 32, sapwood 134 | % | Wood Handbook-type table | R105 Table 1 [read] |
| Green MC, ponderosa pine | heartwood 40, sapwood 148 (Wood Handbook); debarked 4 to 8 in logs averaged 120% (SD 40) | % | | R105 Table 1 [read]; R106 [read] |
| Green MC, oak analogues | northern white oak (Q. alba, white-oak group like Q. robur and Q. petraea) heartwood 64, sapwood 78; northern red oak 80 and 69 | % | | R105 Table 1 [read] |
| Green MC, ash analogues | white ash (F. americana) heartwood 46, sapwood 44; green ash sapwood 58; black ash heartwood 95 | % | | R105 Table 1 [read] |
| Green MC, aspen analogue | quaking aspen (P. tremuloides) heartwood 95, sapwood 113 | % | | R105 Table 1 [read] |
| Green MC, hazel analogue | birches (Betulaceae, hazel's family): paper birch heartwood 89, sapwood 72; yellow birch 74 and 72; sweet birch 75 and 70 | % | No Corylus data found | R105 Table 1 [read]; analogue choice mine |
| Live heather (Calluna), whole shoots and stems | usual spring value about 80%; fell below 45% in the hard winter of 2002 to 2003; upper live canopy rises by over 50 percentage points from April to June; dead Calluna about 5% (May) to 30% (March) | % | UK peatland and moorland | R115 [read] |
| Heather ignition limits | lower canopy above about 70%: spot and line ignitions failed; below about 60%: fires developed rapidly | % | Scottish field tests | R103 [ex], restated in R115 [read] |
| Live gorse | live material 59.7% (SE 1.6); dead 16.5% (SE 1.1) | % | Fire experiments on gorse | R116 [ex] |
| Gorse moisture range | live 4 to 120% and dead 3 to 14% across conditioned and field samples; size classes 0 to 3, 3 to 6, 6 to 10 mm | % | Cone calorimeter study | R117 [ex] |
| Gorse stems | moisture must fall below about 40% for a burn that clears the stand | % | Management guidance | R101 [sec] |
| Pine needle moisture (lodgepole pine analogue) | new needles 202% in early June falling to 122%; old needles 93% rising to 112% early in the season | % | Rocky Mountains | R118 [ex] |
| Live woody fuel, NFDRS | dormant 50% (climate class 1) to 80% (class 4); peak green about 200%; green-up up to 250% at best | % | Shrub and tree foliage and twigs | R119 [ex] |
| Softwood or hardwood row (section 1: Tig 350 C softwood, 305 C hardwood) | pine: softwood. Oak, ash, aspen, hazel, heather, gorse, bramble: hardwood (angiosperm wood) | - | | classification [derived] |

Derived per species [derived]:
- Maximum MC from G: pine 173%, oak 107%, ash 110%, aspen 221%, hazel 130% (G 0.50, assumed from the birch value and the hazel range), gorse 74% (G 0.718).
- Whole-stem green MC (weighted toward sapwood in small stems and branches): pine sapwood 113 to 134%, so a 5 cm pine stick, almost all sapwood, starts near 120%; oak 64 to 78%; ash 44 to 46%; aspen 95 to 113%; hazel about 72 to 89% (birch analogue).
- Note that green aspen sapwood (113%) and pine sapwood (120 to 130%) lie below their maxima (221%, 173%), while white oak sapwood (78%) is close to its maximum (107%); a felled oak branch is nearly as wet as wood can get.

Disagreement: heather and gorse live MC both sit near or below the 60 to 70% heather ignition limit in parts of the year (heather winter under 45%, gorse live mean 59.7%). These shrubs can burn alive; the trees' leaves (100 to 200%) cannot.

**Pick.**

| Species | G | Green MC heartwood / sapwood (whole stem for shrubs) | Live foliage MC | Row |
|---|---|---|---|---|
| Pine (P. sylvestris) | 0.42 | 35 / 120 | 120 (old needles about 100, new up to 200 in early summer) | softwood |
| Oak (Q. robur, petraea) | 0.58 | 64 / 78 (white oak) | gap; take NFDRS woody peak about 200 in leaf, dormant 50 to 80 for twigs | hardwood |
| Ash (F. excelsior) | 0.57 | 46 / 44 (white ash) | gap; same NFDRS rule | hardwood |
| Aspen (P. tremula) | 0.35 | 95 / 113 (quaking aspen) | gap; same NFDRS rule | hardwood |
| Hazel (C. avellana) | 0.50 [UNVERIFIED, from 0.51 birch and 0.53 to 0.63 air-dry hazel] | 80 whole stem (birch analogue) | gap; same NFDRS rule | hardwood |
| Heather (C. vulgaris) | gap (take the 0.55 shrub mean of R113 [UNVERIFIED for heather]) | 80 whole live shoot in spring, 45 after a hard winter, up to about 130 in early summer; dead 5 to 30 | included in the shoot value | hardwood |
| Gorse (U. europaeus) | 0.72 | 60 whole live material; dead 16 | included | hardwood |
| Berry (bramble analogue) | gap (shrub mean 0.55 [UNVERIFIED]) | gap; take NFDRS woody dormant 50 to 80 for canes | gap | hardwood |

Reasoning: densities from one consistent inventory table (R110) where it covers the genus; green MC from the Wood Handbook table for the nearest North American species of the same genus or group, which section 5 already uses (R6); shrub moisture from field studies of the actual species. The foliage gaps for the broadleaves matter only for leaves on a burning tree.

## 22. Fuels other than wood

"Gross" is the bomb (higher) heat of combustion; "net" subtracts the latent heat of the water formed; "effective" is what a flame releases per kg of mass lost (section 3: about 65% of gross for cellulosic fuels, R13, R59). For fats and resins, which burn almost completely through a wick or as a melt, effective is taken as net [derived assumption, flagged].

### 22a. Resin (pine resin, rosin)

| Quantity | Value | Units | Conditions | Source |
|---|---|---|---|---|
| Density, gum rosin | specific gravity 1.06 to 1.09 | - | Solid | R120 [ex, two SDSs] |
| Rosin oil (liquid distillate of rosin) | specific gravity 0.96 to 1.02 at 15 C; flash point 255 to 390 F (124 to 199 C) closed cup; autoignition 648 F (342 C); boiling 300 to 400 C; heat of combustion (est.) 18 000 Btu/lb = 42 MJ/kg; liquid heat capacity 0.46 to 0.49 Btu/lb F (1.93 to 2.03 kJ/kgK); liquid conductivity 0.92 Btu in/h ft2 F (0.13 W/mK) | | US Coast Guard CHRIS sheet ORN; the heat of combustion is a rounded generic estimate | R121 [read] |
| Flash point, gum rosin | 187 C closed cup, 205 C open cup (one SDS); 180 C (another) | C | Solid rosin | R120 [ex] |
| Autoignition, gum rosin | over 400 C (one SDS); another quotes 180 to 188 C, which equals its flash point and is likely an error | C | | R120 [ex] |
| Gross heat of combustion, rosin, estimate | Dulong's formula on abietic acid (C20H30O2: C 79.4%, H 10.0%, O 10.6% by mass) gives 39.4 MJ/kg; Dulong overestimates beef tallow by about 7% (41.9 against measured 38.9 to 39.3), so rosin about 37 to 39 | MJ/kg | | [derived] |
| Net heat, rosin | gross minus 0.90 kg water per kg x 2.44 MJ/kg = gross minus 2.2 | MJ/kg | H 10.0% | [derived] |
| Burning behaviour | pine resin in a fat lamp burns with a sudden brighter, smoky flame and is consumed quickly; "unlike resin, fat alone does not produce a flame but only through the wick" | - | Experimental Palaeolithic lamps | R122 [read] |
| Maximum moisture | resin is hydrophobic and insoluble; take 0 | - | Rosin oil insoluble in water (CHRIS) | R121 [read]; value [derived] |
| Natural piece thickness | gap: no measurement found; resin lumps from pine wounds are commonly a few mm to a few cm [UNVERIFIED] | mm | | gap |
| Ignition temperature or critical flux | gap beyond the flash and autoignition values above | | | gap |

### 22b. Animal fat (tallow) and the fat lamp

| Quantity | Value | Units | Conditions | Source |
|---|---|---|---|---|
| Gross heat of combustion, beef tallow | 38.9 (bomb calorimeter, ASTM D-2015); gross energy 39.3 (range 38.4 to 39.5) | MJ/kg | | R123 [ex]; R124 [ex] |
| Tallow, CHRIS sheet | solid at 15 C; flash point 509 F (265 C) closed cup; autoignition not available; liquid density 53.06 lb/ft3 (850 kg/m3) at 175 to 240 F and specific gravity 0.87 at 80 C; liquid heat capacity 0.478 Btu/lb F (2.0 kJ/kgK); liquid conductivity 1.04 Btu in/h ft2 F (0.15 W/mK); heat of combustion (est.) 42 MJ/kg | | | R125 [read] |
| Melting range | mixed animal fats melt at 36 to 45 C | C | | R126 [sec] |
| Net heat, tallow | 39 gross minus about 1.1 kg water per kg (H about 12%) x 2.44 MJ/kg, so about 36 | MJ/kg | | [derived] |
| Fat lamp, experimental, lamb fat | 80 g of lamb fat gave light for 5 hours with a single wick, i.e. 16 g/h | g/h | Newcomer, as cited | R122 [sec] |
| Fat lamp, experimental, bone marrow | sandstone replica of the La Mouthe lamp, about 150 cm3 bowl, 23 g of bovine marrow, three juniper wicks; burned for over an hour; full output only after about 20 min once the fat had melted; flame temperature barely over 250 C; marrow plus resin lamp: 3.71 lux at 40 cm, 0.59 cd | | Isuntza 1 cave | R122 [read] |
| Candle references | paraffin taper 0.105 g/min (6.3 g/h), 77 W; spermaceti standard candle 7.8 g/h | g/h | | R10, R51 |
| Maximum moisture | fat is hydrophobic; take 0 | - | Tallow insoluble in water (CHRIS) | R125 [read]; value [derived] |
| Natural piece thickness | gap; a lump of kidney fat or a filled lamp, not a sheet | | | gap |

Check [derived]: 8 g/h of tallow at 36 MJ/kg is 80 W, the same as the 77 W paraffin candle.

### 22c. Bark (strips)

| Quantity | Value | Units | Conditions | Source |
|---|---|---|---|---|
| Gross heat, Scots pine bark | 19.70 to 19.94 MJ/kg; pine bark in general 21.0 gross, 19.7 net (dry) | MJ/kg | | R127 [ex] |
| Gross heat, bark range | 18.6 to 22.7 MJ/kg across species (wood 18.6 to 23.6) | MJ/kg | | R127 [ex] |
| Gross heat, birch and aspen bark | birch bark 21.0, aspen bark 19.4; birch outer bark over 30 (suberin and betulin; betulin 20 to 30% of outer bark mass) | MJ/kg | Pellet studies | R128 [ex] |
| Density, bark | native pine bark 0.46 g/cm3, larch 0.51; birch bark 0.78 (thick pieces) to 0.83 (thin pieces); oak bark 0.61 to 0.71; air-dry oak bark 480 kg/m3, aspen bark 590 kg/m3, Scots pine bark 370 kg/m3 | g/cm3 | Two studies | R129 [ex]; R130 [ex] |
| Bark thickness on the trunk | iLand default: 0.065 x D (cm), so 1.3 cm at D 20 cm | cm | Generic | R97 [read] |
| Strip thickness | gap: no measured thickness of peeled strips found. Birch outer bark peels in sheets of order 1 mm [UNVERIFIED]. | mm | | gap |
| Effective heat | 0.65 x 20 = 13 MJ/kg, as for wood | MJ/kg | | [derived] from R13/R59 ratio |
| Ignition | take the wood rows (section 1) by species; gap for bark-specific values | | | gap |
| Maximum moisture | gap; use the wood relation with bark density (pine bark G about 0.40 gives about 185%) [derived, UNVERIFIED for bark] | % | | gap |

### 22d. Hide and leather

| Quantity | Value | Units | Conditions | Source |
|---|---|---|---|---|
| Heat of combustion, leather | net about 21 MJ/kg (tabulated value in a fire-load note); finished leather waste about 16 MJ/kg | MJ/kg | Tanned leather | R131 [ex]; R132 [ex] |
| Density, collagen | dry 1.34 g/cm3, hydrated 1.19 g/cm3 | g/cm3 | | R133 [ex] |
| Density, raw bovine hide | bull 1.53 +/- 0.10 (12 to 15 mm thick); calf 1.32 +/- 0.12 (3 to 5 mm); cow 1.58 +/- 0.11 (5 to 10 mm) | g/cm3 | Collagen extraction study; values above collagen's 1.34 suggest a measurement basis I could not check | R134 [ex; flagged] |
| Apparent density, leather | 0.60 to 0.90 | g/cm3 | | R135 [ex] |
| Thickness | cowhide about 5 mm before splitting; deerskin 1 to 1.4 mm (garment), about 0.8 mm (light) | mm | Trade data | R136 [ex] |
| Water in fresh hide; maximum moisture | gap; fresh hide is commonly quoted near 60 to 65% water by wet mass, i.e. 150 to 185% dry basis [UNVERIFIED] | % | | gap |
| Ignition temperature, critical flux | gap | | | gap |
| Effective heat | gap; take 0.65 x 21 = 14 MJ/kg if needed [derived, UNVERIFIED for leather] | MJ/kg | | |

### 22e. Fern fronds (bracken) and herbaceous stems or flowers

| Quantity | Value | Units | Conditions | Source |
|---|---|---|---|---|
| Gross heat, bracken | 21 GJ/t (21 MJ/kg) against 19 for straw (Callaghan et al. 1981, as cited) | MJ/kg | Dry | R137 [sec] |
| Bracken silage | HHV 20.3, LHV 12.3 MJ/kg | MJ/kg | Wet silage feedstock | R138 [ex] |
| Green frond moisture | 76.87% wet basis, i.e. 333% dry basis | % | | R139 [ex] |
| Dead fronds | die back each winter and dry to a flammable litter by late spring; upper flammability limit of most dead fuels about 25 to 30% | % | | R119 [ex] (NWCG) |
| Bracken biomass | up to 32 fronds/m2, up to 81 g per frond, above-ground peaks to 6.8 kg/m2 | | | R140 [ex] |
| Herbaceous fuel states | cured at 30% MC or less; between the 1-h and herbaceous classes from 30 to 120% | % | NFDRS | R30 |
| Fine dead fuel defaults | particle density 513 kg/m3; heat content 18.6 MJ/kg | | NFDRS | R30 |
| Thickness of a frond pinna, a grass blade, a flower stem | no species measurement read | mm | | gap |
| Fine fuel surface-to-volume ratio, NFDRS fuel models | herbaceous 1500 to 3000 (perennial grasses L 2000, annual grasses A 3000); 1-h dead 700 to 3000, mostly 1500 to 2000; 10-h 109; 100-h 30; 1000-h 8 | 1/ft | 1978 fuel model table | R30 [read] |
| Equivalent round thickness, d = 4/σ | herbaceous 2000: 0.61 mm; 3000: 0.41 mm; 10-h 109: 11 mm; 100-h 30: 41 mm; 1000-h 8: 152 mm | mm | A flat blade of the same σ is half as thick | [derived] |

**Pick (section 22).**

| Kind | Density kg/m3 | Gross / net / effective MJ/kg | Ignition | Max MC | Natural thickness |
|---|---|---|---|---|---|
| Resin | 1080 | 38 / 36 / 36 [derived] | flash 187 C, autoignition over 400 C (gum rosin SDS; rosin oil 342 C) | 0 | gap (a few mm lump [UNVERIFIED]) |
| Fat (tallow) | 900 solid [UNVERIFIED], 850 to 870 melted | 39 / 36 / 36 | flash 265 C; no flame without a wick | 0 | gap |
| Fat lamp wick | | burn rate 8 g/h per small wick (range 6 to 16), about 80 W | | | |
| Bark | pine 460, birch 800, oak 650, aspen 590 | 20 (birch 21) / about 19 / 13 | wood rows by species | 185 (pine bark, UNVERIFIED) | gap |
| Hide | raw 1100 to 1300 [between collagen hydrated and dry; R134 values flagged], leather 600 to 900 | 21 net leather / 14 effective [UNVERIFIED] | gap | 150 to 185 [UNVERIFIED] | deer 1 to 1.4 mm, cattle 5 mm |
| Fern (bracken) | 513 (NFDRS fine-fuel default) | 21 / about 19.5 / 13.7 | NFDRS fine fuel | green 333; dead to the dead-fuel equilibrium | 0.61 mm (NFDRS herbaceous class, R30) |
| Herb stems, flowers, grass and plant fiber | 513 | 18.6 / 17 / 12 | NFDRS fine fuel | herbaceous rule (cured at 30 or less, up to 120 live) | 0.61 mm (NFDRS herbaceous class, R30) |

Reasoning: measured gross values where read; net and effective by the same conversions section 3 uses. Gaps are left as gaps; the largest are natural piece thicknesses, which the sim may need to fix as design choices.

Resolved for the plan: grass, fiber, fern and flower pieces take the NFDRS herbaceous class's 0.61 mm. Where no thickness was found, Unit 3 uses design values, marked as such: a resin lump 10 mm, a lump of fat 20 mm, a peeled strip of bark 2 mm (whole bark on a trunk is 0.065 D, R97), and hide as in section 22d.

## 23. Unsized kinds the sim heats or wets

| Quantity | Value | Units | Conditions | Source |
|---|---|---|---|---|
| Copper | cp 0.385 kJ/kgK; ρ 8930 kg/m3; k 401 W/mK | | 300 K | R141 Table A-19 [read] |
| Granite | cp 0.775; ρ 2630; k 2.79 | kJ/kgK, kg/m3, W/mK | 300 K | R141 [read] |
| Limestone (check) | cp 0.810; ρ 2320; k 2.15 | same | 300 K | R141 [read] |
| Brick, common (fired clay analogue for a pot wall) | cp 0.835; ρ 1920; k 0.72 | same | 300 K | R141 [read] |
| Soil (moist clay-ground analogue) | cp 1.840; ρ 2050; k 0.52 | same | 300 K | R141 [read] |
| Sand (dry) | cp 0.800; ρ 1520; k 0.27 | same | 300 K | R141 [read] |
| Quartz (flint and chert are microcrystalline quartz) | ρ 2650 kg/m3; cp 0.741 kJ/kgK; k quoted as 3 W/mK by one property site; Britannica's rock table lists quartz 20.0 and quartzite 15.0 at 20 C (9.0 at 200 C) in units I could not confirm (if 10^-3 cal/cm s C, that is 8.4 and 6.3 W/mK) | | | R142 [ex]; R143 [ex; units UNVERIFIED] |
| Malachite (copper carbonate ore) | density 3.6 to 4.05 g/cm3 measured, 4.0 calculated | g/cm3 | | R144 [ex] |
| Ore heat capacity and conductivity | gap; no value read for malachite or chalcopyrite | | | gap |
| Clay water content, plastic | porcelain about 20%, stoneware 22 to 24%, coarse clays workable at 18 to 20%, modelling stiffness 19.5 to 22.5% (wet basis, potters' convention) | % | | R145 [ex] |
| Clay plastic and liquid limits, kaolinite | plastic limit 36 to 40%, liquid limit 58 to 72% (geotechnical, dry basis) | % | | R146 [sec] |
| Clay shrinkage | total wet to fired 8 to 16% (often 11 to 15%); firing alone: earthenware 3 to 4% or less, stoneware 5 to 6%, porcelain over 10% | % linear | | R145 [ex] |
| Raw meat, lean beef | water 74 to 79%; k 0.40 to 0.51 W/mK (parallel and across fibres, 3 to 20 C); beef kidney density 1.02 g/cm3, brain 1.04, ground beef 0.93 to 0.98; melted beef fat k 0.19, density 0.81 | | | R147 thermal conductivity table [read] |
| Unfrozen food heat capacity (Chen model in ASHRAE) | c_u = 4.19 - 2.30 x_s - 0.628 x_s^3 kJ/kgK, x_s = solids mass fraction | kJ/kgK | Above the initial freezing point | R147 [read; reconstructed from its worked example (beef carcass, x_s 0.4179)] |
| Berries | blueberries water 84.61%, specific heat above freezing 3.83 kJ/kgK, below freezing 2.06, latent heat 283 kJ/kg; raspberries water 86.57%, blackberries 85.64% | | | R147 Table 3 [read for composition; blueberry heat values ex] |
| Frozen berries in bulk (check) | black currants k 0.310 W/mK at bulk density 0.64 g/cm3; gooseberries 0.276 at 0.58 | | Frozen, packed | R147 [read] |
| Grain (wheat) | gap: k, density and heat capacity of grain not read; Chen model with 13% water gives c_u about 1.78 kJ/kgK | | | [derived] from R147; rest gap |
| Hide | see section 22d (collagen 1.19 hydrated, 1.34 dry g/cm3); heat capacity and conductivity gap | | | |

Derived [derived]:
- Chen model: lean meat (water 0.75) 3.61 kJ/kgK; berries (water 0.85) 3.84 (matches the tabled 3.83 for blueberries); grain at 13% water 1.78.
- Thermal diffusivity α = k / (ρ c): copper 1.17e-4 m2/s; granite 1.37e-6; brick 4.5e-7; meat (k 0.47, ρ 1050, c 3.61) 1.24e-7.
- Heating time of a held piece scales as L^2 / α: a 1 cm copper piece equalises in about a second, a 5 cm granite stone in about half an hour (L^2/α with L the half thickness 2.5 cm: 460 s, times a few), a 3 cm piece of meat in about 30 min to the centre.

**Pick (section 23).**

| Kind | ρ kg/m3 | c kJ/kgK | k W/mK | Max water uptake | Characteristic thickness held |
|---|---|---|---|---|---|
| Clay, raw (plastic) | 2050 (soil row) [analogue] | 1.84 moist (soil row); dry clay solids about 0.8 [UNVERIFIED] | 0.52 | plastic at 25 to 30% dry basis (20 to 24% wet); liquid limit 58 to 72% (kaolinite) | lump 5 cm [design choice, UNVERIFIED] |
| Clay pot wall (fired) | 1920 (common brick) | 0.835 | 0.72 | gap (fired earthenware is porous; water absorption not read) | 7 mm [design choice, UNVERIFIED] |
| Copper ore rock (malachite) | 3800 | gap (take 0.8 as for silicate rock [UNVERIFIED]) | gap (take granite's 2.8 [UNVERIFIED]) | 0 | 5 cm lump [design choice] |
| Copper metal | 8930 | 0.385 | 401 | 0 | 1 cm [design choice] |
| Stone, flint | 2650 | 0.74 | 3 to 8 [range, flagged] | 0 | flake 1 cm, nodule 8 cm [design choice] |
| Stone, granite | 2630 | 0.775 | 2.79 | 0 (absorption small, not read) | 10 cm hearth or boiling stone [design choice] |
| Raw meat | 1050 | 3.6 (Chen at 75% water) | 0.47 | already 300% dry basis (75% water); takes no more | 3 cm [design choice] |
| Berries | 1000 [UNVERIFIED] | 3.84 | gap (about water's 0.57 times 0.9 [UNVERIFIED]) | 85% water (570% dry basis) | 1.2 cm berry [design choice] |
| Grain | gap (kernel about 1300 [UNVERIFIED]) | 1.78 at 13% water | gap | gap | 4 mm kernel [design choice] |
| Hide | 1190 hydrated collagen to 1340 dry | gap | gap | 150 to 185% [UNVERIFIED] | 1 to 5 mm (section 22d) |

Reasoning: one engineering table (R141) for metals, rocks and fired clay; ASHRAE for foods. Thicknesses people hold are not physical constants; they are marked as design choices to accept or change.

Resolved for the plan: the held thicknesses in the table are design values, marked as such. They decide only how long a held piece takes to come up to the temperature where it sits (L^2 / α above), never whether a process can happen.

## 24. Process temperatures: resin, smoking food, smoke-curing hide

| Quantity | Value | Units | Conditions | Source |
|---|---|---|---|---|
| Gum rosin softening point (ring and ball) | WW grade 75 to 80; Honduran WG/WW 66 to 72; rosin-containing materials in general 40 to 170 | C | Ring and ball: ball drops through a softened disc in a bath heated at 5 C/min | R148 [ex]; R120 [ex] |
| Pine pitch glue strength vs temperature | strongest at 0 C, weakest at 38 C | C | Laboratory strength tests of pine and birch-bark adhesives | R149 [ex] |
| Rosin full melt or flow | gap: no measured melting point read; rosin is amorphous and only softens progressively above its softening point | C | | gap |
| Rosin oil flash, autoignition; gum rosin flash | see section 22a (rosin oil flash 124 to 199 C, autoignition 342 C; gum rosin flash 180 to 187 C closed cup) | C | | R121, R120 |
| Birch tar use | lumps were heated to soften, then applied; strong bond on cooling | - | Archaeology | R150 [ex] |
| Cold smoking, fish | 28 to 32 C typical; a maximum of 30 C (86 F) for 3 to 6 h after 1 to 6 h drying at 20 to 28 C | C | FDA processing parameters for cold-smoked fish | R151 [ex]; R152 [ex] |
| Hot smoking, fish | 70 to 80 C typical; the fish must reach an internal 62.8 C (145 F) and hold it for at least 30 min | C | | R152 [sec]; R153 [ex] |
| Smoking, meat | cold smoking at most 30 C; hot smoking 65 to 100 C; smoke-drying 45 to 85 C | C | | R154 [ex] |
| Safe internal temperatures | 62.8 C whole cuts plus 3 min rest; 71.1 C ground meat; 73.9 C poultry | C | USDA FSIS | R50 |
| Collagen shrinkage, raw hide | raw hides or skins shrink very easily at about 65 C; mammalian collagen shrinkage temperature about 62 C irrespective of source; fish-skin collagen 35 to 57 C | C | Wet hide | R155 [ex]; R156 [ex] |
| Hide denaturation vs water content | about 180 C at 3.7% water falling to about 60 C at 44% water | C | Bovine hide | R157 [ex] |
| Aldehyde (smoke-type) tanning effect | glutaraldehyde tanning gives shrinkage temperature 65 to 70 C (one patent), above 85 C (trade source); liquid smoke crosslinks collagen much as glutaraldehyde or formaldehyde do; tanning liquor held at 10 to 50 C | C | | R158 [ex] |
| Brain tanning | brain phospholipids lubricate the fibres to give soft buckskin; no shrinkage-temperature gain reported | - | | R159 [ex] |
| Smoke-curing temperature of hide, measured | gap: no measured temperature for traditional hide smoking found | | | gap |

**Pick (section 24).**
- Resin softens at 70 C (ring-and-ball range 66 to 80 C) and is workable as glue well above that; take "runs" at about 100 C as a design value [UNVERIFIED]. Its vapours flash at about 185 C and it autoignites above about 340 to 400 C.
- Cold smoking: surface of the food at most 30 C, in smoke, for hours. Hot smoking: air 70 to 80 C, done when the centre holds 62.8 C for 30 min (fish) or meets the USDA internal temperatures (meat). Smoke-drying spans 45 to 85 C.
- Smoke-curing hide: keep the damp hide below its shrinkage temperature, which is about 60 C at 44% water; take an upper limit of 50 C in smoke [derived margin, UNVERIFIED], with smouldering (not flaming) fuel, as the bed's smoulder state in the plan intends. The cure itself comes from aldehydes in smoke, which can raise the shrinkage temperature to 65 to 85 C once taken up.

## 25. The island's weather, from the sim itself

Numbers measured from the sim's own code at commit 958d736, not from literature, so every value here is [derived]. Seeds 1, 2 and 3 with NOMADS_BRAIN=random; one 40-day year of spin-up, then one year measured.
- **Cells.** A typical inland open cell per seed: among the quarter of land cells with the least sea air (`marine`), the one whose height is nearest the inland median, with no canopy and little cold pooling. Seed 1 (168, 67) at 68 m, seed 2 (127, 94) at 47 m, seed 3 (112, 55) at 53 m.
- **Weather.** ecology.ts's weather lines re-run tick by tick with its own draws in its own order; `airAt` at the cell every hour.
- **Humidity.** From the climate's season humidity and temperature fields at the cell: the vapour pressure is drawn between season middles as air.ts draws temperature, and RH = e / es(T_air) with climate.ts's Magnus es. The climate's mean humidity at these cells is 0.73 to 0.74 in every season.
- **Wind.** Head-height wind at 300 random land cells per seed, with their own lee and canopy.
- **Rain rates.** The land mean of each season's precipitation spread over the season's rain and storm hours, a storm hour falling K times as fast as a rain hour.

Means of the three seeds:

| Quantity | Spring | Summer | Autumn | Winter | Year |
|---|---|---|---|---|---|
| Clear / cloudy / rain / storm, share of hours | 0.25 / 0.34 / 0.37 / 0.05 | 0.21 / 0.35 / 0.34 / 0.11 | 0.11 / 0.36 / 0.48 / 0.05 | 0.11 / 0.40 / 0.48 / 0.01 | 0.17 / 0.36 / 0.42 / 0.06 |
| Rain or storm, share of hours | 0.42 | 0.44 | 0.53 | 0.49 | 0.47 |
| Land mean precipitation, mm | 228 | 166 | 331 | 310 | 1035 |
| Air temperature p10 / p50 / p90, C | 4.0 / 9.9 / 16.2 | 14.5 / 18.4 / 23.2 | 3.5 / 9.1 / 14.7 | -3.6 / -0.5 / 3.1 | -1.1 / 9.5 / 19.5 |
| Mean daily range, C | 7.3 | 8.1 | 5.8 | 5.4 | 6.7 |
| RH p10 / p50 / p90 | 0.65 / 0.84 / 0.98 | 0.65 / 0.82 / 0.98 | 0.68 / 0.85 / 0.98 | 0.71 / 0.87 / 0.99 | 0.67 / 0.85 / 0.99 |
| RH below 0.6 / below 0.7, share of hours | 0.05 / 0.18 | 0.05 / 0.19 | 0.02 / 0.13 | 0.003 / 0.07 | 0.03 / 0.14 |
| Land wind p10 / p50 / p90, m/s | 1.7 / 3.9 / 6.5 | 1.8 / 4.2 / 7.5 | 1.9 / 4.5 / 7.2 | 1.8 / 4.3 / 6.5 | 1.8 / 4.2 / 6.9 |
| Sea wind p10 / p50 / p90, m/s | 4.2 / 6.4 / 8.7 | 4.5 / 6.7 / 10.5 | 5.3 / 7.2 / 9.4 | 5.2 / 6.8 / 8.5 | 4.7 / 6.8 / 9.2 |
| Today's litter drier than DAMP / SOAKED, share of time | 0.37 / 0.51 | 0.39 / 0.52 | 0.21 / 0.36 | 0.13 / 0.31 | 0.27 / 0.42 |

Extremes: RH never fell below 0.52; air temperature ran from -5.9 to 27.8 C; land wind's 99th percentile is about 10 m/s and its maximum about 20 m/s on exposed ground, where the lee factor exceeds 1 (the sea wind's maximum is 15 m/s). Without canopy the land wind is 2.8 / 4.6 / 7.1 m/s.

Rain per rain hour, year mean: 2.3 mm on the game-time base (each game season receives its real season's precipitation) and 0.25 mm on the real-time base (climate.ts SEASON_DAYS, 91.31 real days of weather a season), a factor of 9.13 apart.

Findings:
- The sky rains in 47% of hours (45 to 48% by seed) and is clear in 17%. This follows from nextSky's transition table, not from the climate: cloudy turns to rain with probability 1.1 times the season's share of the year's precipitation (climate.ts SEASONS wet, 0.16 to 0.32, so 0.18 to 0.35 an hour), and rain leaves for cloudy with probability 0.25 an hour. [UNVERIFIED] Lowland NW European climates with about 1000 mm a year record measurable rain in roughly a tenth of hours. The sky is far wetter in duration than the climate it carries. This is a property of the sky model, recorded here and not tuned.
- Only clear afternoons take RH below 0.6, and clear skies are 17% of hours.
- On the real-time base a storm would fall more lightly than real light rain (0.76 mm/h) and a 40-day year would receive about 113 mm. On the game-time base rain sits in the cited light-to-moderate class and storms in the moderate-to-heavy class.

**Pick.**
- Rain rates on the game-time base, so a game year receives the island's annual precipitation. With section 13's K = 5: rain about 1.6 mm/h and storm about 7.8 mm/h over the year, by season as in section 13.
- Inland hourly RH median 0.85 and 10th percentile 0.67; head-height land wind median 4.2 m/s (open ground 4.6). The gale case is the land 99th percentile, about 10 m/s, with 15 m/s, the storm sky's target in air.ts WIND, as the extreme.

## 26. The island's weather against these limits (Unit 1 check)

A throwaway check (in /tmp, not kept) ran a year of the sim's own weather and set the picks above against it. Every number here is [derived] from the sim code at commit 958d736 and the picks of sections 10, 11, 14, 18 and 19 to 21.

**Method.**
- Seeds 1, 2, 3, NOMADS_BRAIN=random, `seedRandom(seed)` then `newWorld(seed)` with no people. ecology.ts's weather lines re-run tick by tick with its own draws in its own order (sky, the two wind draws and the sea wind each hour; the storm tick's lightning draw), `islandTemp` and `wetness` every tick. One 40-day year of spin-up, then one year measured hourly, at the inland open cells of section 25. It reproduces section 25's weather: rain or storm in 47.1% of hours, today's litter drier than DAMP in 28.3% of hours and drier than SOAKED in 42.5%.
- Air at the cell from `airAt`; humidity from the climate's season fields, with the vapour pressure drawn between season middles (section 25).
- Fuel-level temperature and humidity by section 11's pick: sun from sky.ts's sun height, clear-sky beam with p 0.745 at the cell's height, times 1 minus the sky's cloud cover (clear 0.05, cloudy 0.7, rain and storm 0.95); the fuel's wind from section 14's profile inside short grass (H 0.1 m, 0.20 of head height) or tall grass (H 0.5 m, 0.31); RH at the fuel from the air's vapour pressure.
- Equilibrium moisture by Simard (R30); 35% in any rain hour (R30's MC1 while raining). "Equilibrium" takes the EMC each dry hour, as tinder finer than about 4 mm does by the d^2 rule (section 5: τ under an hour). The 1-hour and 14-hour lags are sensitivities; 14 hours is the humid-climate field fit of section 11 (R71).
- Carried tinder by section 18's pick: air at 32 C holding the outside vapour pressure plus 0.5 kPa, out of the rain.
- Limits from section 10: a spark catches at 10% MC or less, an ember at 13% or less.

**Tinder.** Share of hours (and of daylight hours) at or below each limit, mean of the three seeds.

| Tinder | Season | Spark, % of hours | Ember, % of hours | Spark, % of daylight | Ember, % of daylight | Mean EMC % |
|---|---|---|---|---|---|---|
| Today: litter drier than DAMP (spark) and SOAKED (ember) | spring / summer / autumn / winter | 37.8 / 39.7 / 22.2 / 13.6 | 50.4 / 51.9 / 36.4 / 31.3 | 42.7 / 44.0 / 24.3 / 13.6 | 51.7 / 53.6 / 38.4 / 30.3 | |
| Today | year | 28.3 | 42.5 | 33.8 | 45.5 | |
| Open ground in short grass, equilibrium | spring / summer / autumn / winter | 10.1 / 16.1 / 3.2 / 0.0 | 21.7 / 26.3 / 16.1 / 6.1 | 20.6 / 24.8 / 6.5 / 0.0 | 42.9 / 40.4 / 31.4 / 18.0 | 17.8 / 16.7 / 18.5 / 20.1 |
| Open ground in short grass, equilibrium | year | 7.4 | 17.5 | 15.1 | 35.1 | 18.3 |
| Open ground in tall grass, equilibrium | year | 6.3 | 16.7 | 13.0 | 33.5 | 18.4 |
| Shade, equilibrium | year | 1.0 | 13.2 | 2.1 | 26.1 | 18.9 |
| Open ground in short grass, 1-hour lag | year | 6.1 | 12.2 | 12.5 | 24.1 | 18.3 |
| Open ground in short grass, 14-hour lag | year | 0.0 | 0.0 | 0.0 | 0.0 | 18.3 |
| Kept out of rain, at the air's temperature | year | 0.5 | 10.8 | 1.1 | 21.1 | 18.9 |
| Kept out of rain, warmed to 25 C | year | 89.9 (summer 59.4, other seasons 100) | 100 | 86.1 | 100 | 6.5 |
| Carried against the body (section 18) | spring / summer / autumn / winter | 100 in every season | 100 | 100 | 100 | 6.1 / 8.5 / 5.9 / 4.3 |

**Seasoning.** Time for wood cut green to dry to 30% MC (fine fuel's moisture of extinction, section 5) and to 25%, toward an EMC of 18.7% (the shade mean above, out of the rain), in 40-day game years. Trunk diameters from section 19's forest-grown allometry at the sim's tree heights (flora.ts TALL, at half, once and 1.4 times); green moisture from section 21 (pine 120, oak 71, ash 45, aspen 104). The resolved law of section 20 (τ_green = 500 h (d / 25 mm)^1.5 down to fibre saturation, then the d^2 rule), beside the d^2 rule alone (τ = 10 h (d / 12.7 mm)^2).

| Species | Height m | Trunk D mm | Section 20: to 30% | Section 20: to 25% | d^2 alone: to 30% | d^2 alone: to 25% |
|---|---|---|---|---|---|---|
| Pine | 8.5 / 17 / 23.8 | 104 / 187 / 248 | 9.7 / 23.4 / 35.7 | 10.1 / 24.7 / 38.1 | 1.5 / 5.0 / 8.7 | 2.0 / 6.3 / 11.1 |
| Oak | 7.5 / 15 / 21 | 72 / 181 / 284 | 3.9 / 15.6 / 30.5 | 4.1 / 16.8 / 33.6 | 0.5 / 3.2 / 8.0 | 0.7 / 4.5 / 11.0 |
| Ash | 8 / 16 / 22.4 | 71 / 274 / 526 | 2.1 / 15.9 / 42.4 | 2.3 / 18.8 / 52.8 | 0.3 / 4.1 / 15.1 | 0.5 / 6.9 / 25.5 |
| Aspen | 6.5 / 13 / 18.2 | 45 / 115 / 183 | 2.5 / 10.5 / 20.9 | 2.6 / 11.0 / 22.1 | 0.3 / 1.7 / 4.4 | 0.3 / 2.2 / 5.6 |

Branches and split wood from 100% to 30% at the same EMC, in game days, by section 20 (d^2 alone in brackets): 6 mm 4.8 (0.2); 12.7 mm 15 (0.8); 25 mm 41 (3.2); 50 mm 116 (13); 76 mm 218 (29); 100 mm 329 (51).

**Findings.**
- Tinder lying in the open is at or below the spark limit in 7.4% of hours (15% of daylight hours), a quarter of today's 28.3%, and never in winter. It is at or below the ember limit in 17.5% of hours (35% of daylight), against today's 42.5%.
- The cause is the island's air, not the limits: the mean equilibrium moisture of fine fuel is 18 to 19%, above both limits, because inland humidity has a median of 0.85 and never falls below 0.52 (section 25), and the sky rains in 47% of hours. Only clear, sunny afternoons heat fuel enough to bring it below 10%.
- Tinder kept out of the rain at the air's temperature is no better than tinder in the shade: 0.5% of hours for a spark, 10.8% for an ember. Keeping it dry is not enough; it must be warmed.
- Tinder carried against the body sits at 4 to 9% and is below both limits in every hour of every season; so is tinder warmed to 30 C by a fire. Drying damp tinder by body warmth is the practitioners' method (R69), over about three hours.
- If fine fuel answers the air as slowly as the humid-climate field fit says (14 hours), open tinder never reaches either limit.
- Wood cut green does not season within a game year unless it is twig-thin: a 12.7 mm stick takes 15 game days to reach 30%, a 25 mm branch a game year, and a full-grown trunk 10 to 24 game years. Dead wood lying about is already near equilibrium and is what a year's fires can burn.

**Result.** On this island's weather, tinder picked up from the ground or kept at the air's temperature mostly stops catching, a spark in 7% of hours against today's 28% and never in winter. Tinder carried against the body, or dried by a fire, catches in every hour. Fire-making carries on for people who carry their tinder on them and mostly stops for those who rely on what lies about.

## 27. One physical record per kind (Unit 2)

What src/sim/fuel.ts holds for each kind: the picks above set down per kind, with analogues and design values marked. src/sim/fuel.test.ts reads these tables and fails if fuel.ts differs from them.

- Moisture is kg of water per kg dry.
- ρ is the dry mass per volume of the piece as it is. For foods, clay and hide it is the cited density of the moist piece divided by 1 plus the water it holds as found [derived].
- c is the dry heat capacity. Water adds its own 4.19 kJ/kgK per kg (the water term of Chen's model, sec. 23).
- k is the dry conductivity across the grain for wood, bark, fine fuel and charcoal, by R6's relation at the kind's density; R6 adds G (0.4064) W/mK per unit of moisture below fibre saturation. For everything else it is the cited conductivity of the piece as found, which no moisture law read here changes [gap].
- d is the thickness of one, which sets how fast heat and water reach its middle; mass is the dry mass of one. For kinds whose pieces vary in size these are design values (Unit 3 gives each piece its own), marked [design].
- Plant matter's dry c is R6's c_p0 at 20 C, 0.1031 + 0.003867 x 293.15 = 1.237 kJ/kgK; its dry k is G x 0.1941 + 0.01864 W/mK; its mmax is (1.54 - G) / (1.54 G) (R6) [derived].

### 27a. The rows things burn by

| Row | Tig C | q_cr kW/m2 | kρc (kW/m2K)^2 s | Δh flame MJ/kg | Δh char MJ/kg | Char yield | L kJ/g | Source |
|---|---|---|---|---|---|---|---|---|
| softwood | 350 | 11 | 0.22 | 13 | 30 | 0.45 | 12.5 | sec. 1, 3, 16 |
| hardwood | 305 | 11 | 0.22 | 13 | 30 | 0.45 | 9.4 | sec. 1, 3, 16 |
| fine | 250 | 11 | 0.22 | 12 | 30 | 0.45 | 12.5 | Tig R8's 523 K for fine fuel (sec. 1); Δh flame 0.65 x 18.6 (sec. 22e); the rest the softwood row [analogue] |
| fern | 250 | 11 | 0.22 | 13.7 | 30 | 0.45 | 12.5 | the fine row; Δh flame 0.65 x 21 (sec. 22e) |
| bark | 350 | 11 | 0.22 | 13 | 30 | 0.45 | 12.5 | the softwood row; Δh flame 13 (sec. 22c) |
| hide | 305 | 11 | 0.22 | 14 | 30 | 0.45 | 9.4 | Δh flame 0.65 x 21 (sec. 22d) [UNVERIFIED]; the rest the hardwood row [analogue, gap] |
| fat | 265 | 11 | 0.27 | 36 | 30 | 0 | 1.82 | Tig the tallow flash point (sec. 22b); kρc from the record's k, ρ and c [derived]; q_cr the wood value and L R14's 1.82 [analogue, gap] |
| resin | 187 | 11 | 0.28 | 36 | 30 | 0 | 1.82 | Tig the gum rosin flash point (sec. 22a); kρc [derived]; q_cr and L as fat [analogue, gap] |
| char | 350 | 11 | 0.22 | 0 | 30 | 1 | 12.5 | Δh char (sec. 3); all of it char; Tig, q_cr, kρc and L the softwood row [analogue, gap] |

### 27b. Wood by species

| Species | G | Green, sapwood or whole stem | Green, heartwood | Row | Source |
|---|---|---|---|---|---|
| pine | 0.42 | 1.20 | 0.35 | softwood | sec. 21 |
| oak | 0.58 | 0.78 | 0.64 | hardwood | sec. 21 |
| ash | 0.57 | 0.44 | 0.46 | hardwood | sec. 21 |
| aspen | 0.35 | 1.13 | 0.95 | hardwood | sec. 21 |
| hazel | 0.50 | 0.80 | | hardwood | sec. 21 (G and green UNVERIFIED, the birch analogue) |
| heather | 0.55 | 0.80 | | hardwood | sec. 21 (G the shrub mean, UNVERIFIED) |
| gorse | 0.72 | 0.60 | | hardwood | sec. 21 |
| berry | 0.55 | 0.65 | | hardwood | sec. 21: bramble; G the shrub mean and green the NFDRS woody dormant midpoint [gap] |
| generic | 0.45 | | | softwood | the density the checks of sec. 3 and 16 use, and the Douglas-fir across row, for wood of no known species |

ρ is 1000 G, and c, k and mmax follow from G as above.

### 27c. Kinds

| Kind | ρ kg/m3 | c kJ/kgK | k W/mK | mmax | Green | d m | Mass kg | Burns as | Source |
|---|---|---|---|---|---|---|---|---|---|
| stick | 450 | 1.237 | 0.106 | 1.573 | | 0.025 | 0.22 | softwood | generic wood; 25 mm by 1 m [design] |
| log | 450 | 1.237 | 0.106 | 1.573 | | 0.17 | 10 | softwood | generic wood; a 1 m length of the trunk sec. 19 gives at typical height [design] |
| plank | 450 | 1.237 | 0.106 | 1.573 | | 0.085 | 5 | softwood | generic wood; half a log [design] |
| bark | 460 | 1.237 | 0.108 | 1.85 | | 0.002 | 0.1 | bark | sec. 22c: ρ pine bark, mmax [UNVERIFIED]; c and k by R6 at its density [analogue]; a 2 mm strip [design] |
| fiber | 513 | 1.237 | 0.118 | 1.30 | | 0.00061 | 0.02 | fine | NFDRS fine fuel (R30) and the herbaceous class's thickness (sec. 22e); c, k and mmax by R6 at its density [analogue]; a handful [design] |
| fern | 513 | 1.237 | 0.118 | 1.30 | 3.33 | 0.00061 | 0.05 | fern | sec. 22e: green fronds; as fiber otherwise; a bundle of fronds [design] |
| flower | 513 | 1.237 | 0.118 | 1.30 | 2.5 | 0.00061 | 0.005 | fine | sec. 22e; green the NFDRS herbaceous cap (R30); as fiber otherwise [design] |
| herb | 513 | 1.237 | 0.118 | 1.30 | 2.5 | 0.00061 | 0.01 | fine | as flower |
| hide | 441 | 1.262 | 0.47 | 1.7 | 1.7 | 0.003 | 2 | hide | sec. 22d and 23: ρ 1190 (hydrated collagen) over 2.7; c Chen's model at all solids, 4.19 - 2.30 - 0.628 [derived]; k the meat row [analogue, gap]; mmax and green 150 to 185% [UNVERIFIED]; 3 mm; a deer's hide [design] |
| bone | 1920 | 0.835 | 0.72 | 0.1 | 0.1 | 0.02 | 0.3 | | the fired clay row (sec. 23) as the nearest porous mineral [analogue, gap]; water [design, gap]; [design] |
| bone_shard | 1920 | 0.835 | 0.72 | 0.1 | 0.1 | 0.005 | 0.02 | | as bone |
| stone | 2630 | 0.775 | 2.79 | 0 | | 0.1 | 2.6 | | granite (sec. 23); a 10 cm stone [design] |
| sharp_stone | 2630 | 0.775 | 2.79 | 0 | | 0.01 | 0.066 | | granite; a 1 cm flake 5 cm across [design] |
| pebble | 2630 | 0.775 | 2.79 | 0 | | 0.02 | 0.021 | | granite; 2 cm [design] |
| flint | 2650 | 0.74 | 3 | 0 | | 0.08 | 1.36 | | sec. 23, k the one value whose units were read; an 8 cm nodule [design] |
| flint_blade | 2650 | 0.74 | 3 | 0 | | 0.01 | 0.066 | | as flint; a 1 cm flake [design] |
| ore | 3800 | 0.8 | 2.8 | 0 | | 0.05 | 0.475 | | sec. 23, c and k [UNVERIFIED analogues]; a 5 cm lump [design] |
| clay | 1608 | 0.8 | 0.52 | 0.65 | 0.275 | 0.05 | 0.2 | | sec. 23: ρ 2050 over 1.275; c the dry solids [UNVERIFIED]; k the soil row as found; mmax the kaolinite liquid limit's midpoint; green the plastic water; a 5 cm lump [design] |
| charcoal | 90 | 1.237 | 0.106 | 1.573 | | 0.025 | 0.05 | char | ρ 20% of the generic wood (sec. 3, R14); c, k and mmax the generic wood's [analogue, gap]; a lump [design]. A char yield of 0.45 at a fifth of the density would swell the wood, a disagreement between R2 and R14 |
| fat | 900 | 2 | 0.15 | 0 | | 0.02 | 0.5 | fat | sec. 22b: ρ solid [UNVERIFIED], c and k of the melt; a lump [design] |
| resin | 1080 | 1.98 | 0.13 | 0 | | 0.01 | 0.05 | resin | sec. 22a: c and k of rosin oil; a 10 mm lump, 50 g gathered [design] |
| meat | 263 | 1.262 | 0.47 | 3 | 3 | 0.03 | 0.13 | | sec. 23: ρ 1050 over 4 (75% water); c Chen's at all solids [derived]; k as found; 3 cm and a 0.5 kg cut [design] |
| fish | 263 | 1.262 | 0.47 | 3 | 3 | 0.03 | 0.075 | | the meat row [analogue]; a 0.3 kg fish [design] |
| berry | 150 | 1.262 | 0.51 | 5.67 | 5.67 | 0.012 | 0.00014 | | sec. 23: ρ 1000 [UNVERIFIED] over 6.67 (85% water); k [UNVERIFIED]; a 1.2 cm berry [design] |
| mushroom | 150 | 1.262 | 0.51 | 5.67 | 5.67 | 0.03 | 0.0075 | | the berry row [analogue, gap]; 3 cm and 50 g [design] |
| grain | 1131 | 1.262 | 0.15 | 0.15 | 0.15 | 0.004 | 0.044 | | sec. 23: ρ 1300 [UNVERIFIED] over 1.149 (13% water); k [design, gap]; a 4 mm kernel, a 50 g handful [design] |
| nut | 1131 | 1.262 | 0.15 | 0.15 | 0.15 | 0.015 | 0.002 | | the grain row [analogue, gap]; a 1.5 cm nut [design] |

### 27d. Matter made from other matter

Made kinds take their parts' records by mass: mass adds; volume adds (so ρ is the total mass over the summed volumes); c, k and mmax are mass-weighted; d is the thickest part's; a burning record is mass-weighted over the parts that burn, with the share of the mass that burns. A Jev ruling's kind is made from its inputs the same way. Making changes the matter itself only here:

| Made | ρ kg/m3 | c kJ/kgK | k W/mK | mmax | d m | Mass kg | Burns as | Source |
|---|---|---|---|---|---|---|---|---|
| fired clay | 1920 | 0.835 | 0.72 | 0.1 | as made from | as made from | | common brick (sec. 23); mmax: fired earthenware's absorption was not read [design, gap] |
| copper | 8930 | 0.385 | 401 | 0 | 0.01 | 0.1 | | sec. 23; a lump smelted from a lump of ore [design] |
| leather | 750 | 1.262 | 0.47 | 1.7 | as made from | as made from | hide | sec. 22d: ρ 600 to 900; the rest as hide |
| a pot | as made from | | | | 0.007 | as made from | | the pot wall (sec. 23) [design], when clay is pressed into a bowl |

A stew is the foods in it, not the pot it cooked in.

### 27e. Pieces of wood (Unit 3)

Each piece of wood keeps its own thickness, length, dry mass and the species it grew as, from what it came off:

| Piece | Thickness | Length | Source |
|---|---|---|---|
| A log off a felled tree or a fallen log | the forest-grown trunk diameter at the tree's height (sec. 19a); a fallen log is taken as a trunk as tall as it is long [design] | 1 m [design] | sec. 19a |
| A branch off a felled tree or a fallen log | a young stem of its length, by the species' height-to-diameter ratio sapHD: pine 105, oak 112, ash 133, aspen 142 (iLand, sec. 19a), a branch being a stem as long as it is [analogue] | a fifth of the tree's height or the log's length [design] | sec. 19a |
| A stem off a bush or a stump | hazel by its sapHD, 119 (sec. 19c); berry canes by hazel's ratio (sec. 19c [UNVERIFIED]); gorse 0.025 times its length, at most 0.033 m (sec. 19c); heather 0.0035 m (sec. 19c) | the bush's height; a stump's 1 m [design] | sec. 19c |
| A stick lying on the ground | a stem of its length by the four trees' mean ratio, 123 [derived], its species being unknown | its own length | sec. 19a |
| Split pieces | a share of the thickness each (two planks are each half as thick) | as long | [derived] |
| Charcoal smothered from a piece | as thick as the wood: no shrinkage was read [gap] | the wood's length shared among the lumps | the row's char yield of the wood's mass, shared [analogue] |

A piece's dry mass is π/4 d^2 times its length times 1000 G of its species (the generic wood's 0.45 when the species is unknown). A brand lit from a piece, a pointed stick ground from one, and a stick drawn back out of a brand are that piece still.

## Recommended R2 constant set (with section refs)

**Wood, side grain**
- ρ: per species; Wood Handbook relations for k(G, MC) and c(T, MC) (sec. 1).
- kρc_apparent: 1.8 x ambient, about 0.22 (kW/m2K)^2 s (sec. 1).
- Tig: 350 C (softwood), 305 C (hardwood).
- q_cr: 11 kW/m2 in formula; 12 as a threshold.
- Δh flaming: 13 MJ/kg of volatiles.
- Char yield: 0.45, the across row (sec. 16).
- β: derived, m'' / (ρ (1 - X_c)), about 0.019 q mm/min at density 450 (sec. 16; Butler's 0.028 q is the disagreement).
- Extinction: m'' about 3.5 g/m2s.
- L: 12.5 kJ/g softwood, 9.4 hardwood, R2's across row, the row whose ignition values the Tig and kρc above match (sec. 16). 6.8 (along) and 1.82 (R14) disagree.

**Char / charcoal**
- Δh: 30 MJ/kg.
- Emissivity: 0.95.
- Glow: 600 C still air, 830 C in 2.5 m/s wind.
- Burns in proportion to air supply (Albini K law; up to 6 times with blown air).

**Fine dead fuel**
- Particle density: 32 lb/ft3 (513 kg/m3), the NFDRS constant (R30 [read]).
- Heat content: 8000 Btu/lb (18.6 MJ/kg), from the NFDRS fuel model row (R30 [read]).
- Thin-body ignition in flame contact at about 100 kW/m2.
- Tig 250 C, R8's 523 K for fine fuel (sec. 1, 27a).
- Mx 0.30.
- Timelag scales as d^2 from the 10-h anchor.

**Water**
- 2.6 MJ/kg to boil off from ambient.
- kρc factor (1 + 8.1 m) for thick pieces; (1 + 5 m) for thin.

**Flames**
- Heskestad height; κ 0.8; χr 0.3; tilt by Thomas.

**Catching (sec. 10)**
- A struck spark catches in tinder at 10% MC or drier; a friction ember blown in a bundle at 13% or drier.
- The gale that carries sparks off keeps the sim's current value, a gap.

**Tinder in the sun (sec. 11)**
- T_f = T_a + I / (32.7 + 42.2 U); RH_f = RH_a es(T_a) / es(T_f); EMC by Simard at the fuel.
- Cloud cover: clear 0.05, cloudy 0.7, rain and storm 0.95. Fine fuel sits at 35% in rain.

**Grass (sec. 12)**
- Herbaceous MC from the NFDRS v4 GSI: 30% below GSI' 0.2, then linear to 250% at 1. Cured share clip(1.33 - 0.0111 MCHERB, 0, 1). Grasses are perennial. Windows of 28 real days are 3.1 game days.

**Rain (secs. 13 and 25)**
- Game-time base, a storm hour 5 times a rain hour: rain about 1.6 mm/h and storm about 7.8 mm/h over the year, by season as tabled.

**Wind and blow-off (sec. 14)**
- Bed wind U(z_b) = U_head ln((max(z_b, H) - 0.64 H) / (0.13 H)) / ln((2 - 0.64 H) / (0.13 H)) over vegetation of height H; over bare ground ln(z_b / z0) / ln(2 / z0) with z0 0.005; under canopy the head-height wind.
- A flame blows off when the wind at its height exceeds sqrt(g L_f m'' / 3.5 g/m2s).

**Air supply (sec. 15)**
- Burning rate times min(6, 1 + k u), k = 0.2 + 0.85 (1 - F), u the bed-height wind or the blown air's speed; a Churchill and Bernstein convective loss on every piece.

**Heaps (sec. 17)**
- Packing 0.10 for a heap, 1 / (1 + s/b) for a crib. A half-sphere of volume V_solid / β. In-flame share (3x - x^3) / 2 with x = min(1, L_f / R). Packing view factor 1 - exp(-β (R/2) / d).

**People (sec. 18)**
- Δt_o = f_p q / (h_r + h_c): f_p 0.35 standing and facing the fire (0.29 seated), h_r 6, h_c 3.4 W/m2K in still air or 10.4 V^0.56. The sun by the same law, with absorptivity ratio 0.7 / 0.95.
- Tinder carried against the body relaxes toward the EMC of 32 C air holding the outside vapour pressure plus 0.5 kPa.

**Trees, shrubs and species (secs. 19 and 21)**
- Trunk D (cm) = a H^b: pine 1.721, 0.842; oak 0.489, 1.334; aspen 0.343, 1.371; ash (100 H / 290)^1.938. Hazel stems 100 H / 119; gorse 2.5 H, 3.3 cm in a thicket; heather stems 2 to 5 mm.
- Crown branch and foliage mass from iLand's equations; pine's fine share from Pinus densiflora.
- G and green MC per species as in section 21's table. Pine takes the softwood row; the rest take the hardwood row.

**Seasoning (sec. 20)**
- Wood cut green dries with τ_green = 500 h (d / 25 mm)^1.5 until it first reaches fibre saturation (30%); after that, and dead wood always, τ = 10 h (d / 12.7 mm)^2.

**Other fuels (sec. 22)**
- Resin 1080 kg/m3, 36 MJ/kg effective, no water. Fat 36 MJ/kg effective, no water, a wick burns 8 g/h (about 80 W). Bark, hide, fern and herbs as tabled. Grass, fiber, fern and flower pieces 0.61 mm thick.

**Unsized kinds (sec. 23)**
- Density, heat capacity and conductivity as tabled; held thicknesses are design values.

**Process temperatures (sec. 24)**
- Resin softens at 70 C and runs at about 100 C (design value). Cold smoking at most 30 C at the food; hot smoking 70 to 80 C, done when the centre holds 62.8 C for 30 min. Smoke-curing hide in smoulder at 50 C or less.

**The island (secs. 25 and 26)**
- Inland RH median 0.85; rain or storm in 47% of hours, a property of the sky model. Open tinder is spark-dry in 7% of hours, tinder carried against the body in all of them. Wood cut green does not season within a game year unless twig-thin.

## Gaps reported, not filled by retuning

- Wind blow-off correlation for small wood flames (section 14's form is derived, not fitted).
- Luminous efficacy of wood flames.
- Banked-coal and kiln temperatures as measured values.
- Exact F22 spotting-distance coefficients (in R28; not transcribed).
- Wood Handbook ch. 18 text (the FPL server returned 502).
- The moist heat-capacity leading term.
- Mindykowski's own moisture coefficient.
- The gale that carries sparks off.
- Night radiative cooling and dew at fuel level.
- Tran and White's mass-loss slopes (lost in text extraction).
- A hardwood char yield for the across row.
- A measured packing view factor for heaps.
- Wind near the floor under canopy.
- Absorptivity of skin and clothing for flame infrared.
- Mean skin temperature in cool air, clothed and nude; the vapour excess of the clothing microclimate (0.5 kPa assumed).
- Bare-sand roughness (0.0003 m, unverified).
- Possible double count of air supply and convective loss on 1.27 cm sticks.
- Green-wood seasoning fits no single τ(d); treatment and weather move it 10 to 40 times.
- The humid-climate field fit (fine fuel answering over about 14 hours) against the d^2 rule.
- Pine's open-grown trunk curve; ash in BAAD (iLand's crowded bound used).
- Terminal twig diameter and broadleaf twig shares; the two conifer sources differ about tenfold.
- Heather stem diameter by height, bramble cane diameter, and both shrubs' wood density.
- Broadleaf foliage moisture.
- Natural thickness of resin lumps, fat and bark strips (design values in Unit 3).
- Ignition of hide; bark-specific ignition; resin's critical flux.
- Ore heat capacity and conductivity; grain properties; berry conductivity.
- Rosin's full melt; a measured temperature for smoke-curing hide.
- The sky rains in 47% of hours against about a tenth in real climates of the same rainfall: a property of the sky model, not a fire constant.

## References

- R1 Babrauskas V. (2001), Ignition of wood: a review of the state of the art, Interflam 2001 pp 71-88 (journal version J Fire Prot Eng 12:163-189, doi:10.1177/10423910260620482). https://www.xylenepower.com/Ignition%20of%20Wood%20State%20of%20the%20Art_Vitto.pdf
- R2 Quintiere J.G. (2006), Fundamentals of Fire Phenomena, Wiley, doi:10.1002/0470091150 (Tables 7.3 and 9.1; read via mirror https://pdfcoffee.com/fundamentals-of-fire-phenomena-pdf-free.html)
- R3 Spearpoint M., Quintiere J. (2001), Predicting the piloted ignition of wood in the cone calorimeter using an integral model, Fire Safety J 36:391-415. https://www.sciencedirect.com/science/article/abs/pii/S0379711200000552
- R4 Khan M.M., de Ris J.L., Ogden S.D. (2008), Effect of moisture on ignition time of cellulosic materials, Fire Safety Science 9:167-178, doi:10.3801/IAFSS.FSS.9-167. https://publications.iafss.org/publications/fss/9/167/view/fss_9-167.pdf
- R5 Tran H.C., White R.H. (1992), Burning rate of solid wood measured in a heat release rate calorimeter, Fire and Materials 16:197-206. https://research.fs.usda.gov/download/treesearch/5952.pdf
- R6 USDA Forest Products Laboratory (2021), Wood Handbook FPL-GTR-282, ch. 4 Moisture relations and physical properties of wood. https://research.fs.usda.gov/download/treesearch/62243.pdf
- R7 Mindykowski P., Jørgensen M., Svensson S., Jomaas G. (2019), A simple correlation for monitoring the ignition propensity of wet Nordic spruce wood, Fire Safety J 107. https://www.sciencedirect.com/science/article/abs/pii/S0379711218303357
- R8 Frankman D., Webb B.W., Butler B.W., Latham D.J. (2010), Fine fuel heating by radiant flux, Combust Sci Tech 182:215-230, doi:10.1080/00102200903341538. https://research.fs.usda.gov/download/treesearch/34711.pdf
- R9 Finney M.A. et al. (2015), Role of buoyant flame dynamics in wildfire spread, PNAS 112(32):9833-9838, doi:10.1073/pnas.1504498112
- R10 Hamins A., Bundy M., Dillon S.E. (2005), Characterization of candle flames, J Fire Prot Eng 15:265-285. https://tsapps.nist.gov/publication/get_pdf.cfm?pub_id=101159
- R11 Frankman D. et al. (2013), Measurements of convective and radiative heating in wildland fires, Int J Wildland Fire 22:157-167. https://www.frames.gov/catalog/51628
- R12 Experimental methodology for characterizing flame emissivity of small scale forest fires using infrared thermography techniques (2002), in Forest Fire Research and Wildland Fire Safety, Viegas (ed.), Millpress (UPC group; authors not captured). https://upcommons.upc.edu/bitstreams/38e74684-6870-42ae-ad66-18d9bfeed740/download
- R13 Babrauskas V. (2006), Effective heat of combustion for flaming combustion of conifers, Can J For Res 36:659-663, doi:10.1139/X05-253. http://www.orww.org/Wildfires/References/Forest_Fuels/Babrauskas_2006.pdf
- R14 Bartlett A.I., Hadden R.M., Bisby L.A. (2019), A review of factors affecting the burning behaviour of wood for application to tall timber construction, Fire Technology 55:1-49, doi:10.1007/s10694-018-0787-y
- R15 Emberley R. et al. (2017), Critical heat flux and mass loss rate for extinction of flaming combustion of timber, Fire Safety J 91 (https://www.sciencedirect.com/science/article/abs/pii/S037971121730187X); Bartlett A.I. et al. (2017), Auto-extinction of engineered timber, Fire Safety J 91
- R16 CEN (2004), EN 1995-1-2 Eurocode 5 Table 3.1, as tabulated in https://publications.iafss.org/publications/fss/9/1279/view/fss_9-1279.pdf
- R17 The influence of the heat flux of the infrared heater on the charring rate of spruce wood (2024), Polymers 16:2657, doi:10.3390/polym16182657. https://pmc.ncbi.nlm.nih.gov/articles/PMC11435462/
- R18 McAllister S., Finney M. (2016), Burning rates of wood cribs with implications for wildland fires, Fire Technology, doi:10.1007/s10694-015-0543-5. https://fs.usda.gov/rm/pubs_journals/2015/rmrs_2015_mcallister_s002.pdf
- R19 McAllister S., Finney M. (2016), The effect of wind on burning rate of wood cribs, Fire Technology 52:1035ff, doi:10.1007/s10694-015-0536-4. https://www.fs.usda.gov/rm/pubs_journals/2015/rmrs_2015_mcallister_s001.pdf
- R20 Anderson H.E. (1990), Relationship of fuel size and spacing to combustion characteristics of laboratory fuel cribs, USDA FS Res. Pap. INT-424. https://www.fs.usda.gov/rm/pubs_int/int_rp424.pdf
- R21 Andrews P.L. (2018), The Rothermel surface fire spread model and associated developments, RMRS-GTR-371 (cites Anderson 1969 INT-69). https://www.fs.usda.gov/rm/pubs_series/rmrs/gtr/rmrs_gtr371.pdf
- R22 Heskestad G., Fire plumes, flame height and air entrainment, SFPE Handbook; equation as given in FSRI, Examination of fire dynamics analysis techniques. https://fireinvestigation.fsri.org/docs/Assessment_of_Predictive_Fire_Algorithms_and_Models.pdf
- R23 Thomas and AGA tilt correlations as quoted in Experimental study on the mass burning rate and flame tilt angle of annular pool fires under cross air flow, Fuel (2023). https://www.sciencedirect.com/science/article/abs/pii/S0016236123025991
- R24 Xiong C., Wang Z., Huang X. (2024), Blow-off of diffusion flame by moving air vortex ring, Exp Therm Fluid Sci 151:111059. https://www.sciencedirect.com/science/article/abs/pii/S0894177723002157
- R25 Tsuji H., Yamaoka I. (1967), 11th Symp (Int) Combustion; strain a = 2V/R as stated in https://www.researchgate.net/publication/322164934_On_extinction_Strain_rate_of_Counterflow_diffusion_flames
- R26 Manzello S.L., Cleary T.G., Shields J.R., Yang J.C. (2006), On the ignition of fuel beds by firebrands, Fire and Materials 30:77-87. https://tsapps.nist.gov/publication/get_pdf.cfm?pub_id=101167
- R27 Manzello S.L., Maranghides A., Mell W.E. (2007), Firebrand generation from burning vegetation, Int J Wildland Fire 16:458-462. https://www.frames.gov/catalog/8729
- R28 Albini F.A. (1979), Spot fire distance from burning trees: a predictive model, GTR INT-56. https://www.frames.gov/documents/behaveplus/publications/Albini_1979_INT-GTR-056_ocr.pdf
- R29 Albini F.A. (1981), Spot fire distance from isolated sources: extensions of a predictive model, Res. Note INT-309. https://www.frames.gov/documents/behaveplus/publications/Albini_1981_INT-RN-309_ocr.pdf
- R30 Cohen J.D., Deeming J.E. (1985), The National Fire-Danger Rating System: basic equations, PSW-GTR-82. https://www.fs.usda.gov/psw/publications/documents/psw_gtr082/psw_gtr082.pdf
- R31 Rothermel R.C. (1972), A mathematical model for predicting fire spread in wildland fuels, INT-115 (https://research.fs.usda.gov/download/treesearch/32533.pdf), via R21; SI form from Wilson R. (1980) INT-RN-292 (https://www.fs.usda.gov/rm/pubs_int/int_rn292.pdf)
- R32 Anderson H.E. (1982), Aids to determining fuel models for estimating fire behavior, GTR INT-122. https://gacc.nifc.gov/oncc/docs/13_Aids%20to%20Determining%20Fuel%20Models.pdf
- R33 Fosberg M.A. (1970), Drying rates of heartwood below fiber saturation, Forest Science 16:57. https://academic.oup.com/forestscience/article-abstract/16/1/57/4709820
- R34 Anderson H.E. (1990), Moisture diffusivity and response time in fine forest fuels, Can J For Res 20:315-325, doi:10.1139/x90-046
- R35 Nelson R.M. Jr. (2000), Prediction of diurnal change in 10-h fuel stick moisture content, Can J For Res 30:1071-1087, doi:10.1139/x00-032
- R36 NIST Chemistry WebBook SRD 69, Water saturation properties. https://webbook.nist.gov/cgi/cbook.cgi?ID=C7732185&Mask=4
- R37 Purser D.A. (2002), Toxicity assessment of combustion products, SFPE Handbook 3rd ed., pp 2-125 to 2-127 (CEC docket copy). https://efiling.energy.ca.gov/GetDocument.aspx?tn=65949
- R38 Engineers Australia (2024), Practice note for tenability criteria in building fires (cites Raj 2008, J Hazard Mater 157). https://www.engineersaustralia.org.au/sites/default/files/2024-01/tenability-criteria-practice-note_0.pdf
- R39 McGrattan K.B. et al. (2000), Thermal radiation from large pool fires, NISTIR 6546. https://www.govinfo.gov/content/pkg/GOVPUB-C13-fa5a24c9e669a385816318793faac823/pdf/GOVPUB-C13-fa5a24c9e669a385816318793faac823.pdf
- R40 Modak (1977) via NUREG-1805 ch. 5 / PDH M312. https://pdhonline.com/courses/m312/Radiant%20Flux.pdf
- R41 Radiant, convective and heat release characterization of vegetation fire (2013), Int J Therm Sci. https://www.sciencedirect.com/science/article/abs/pii/S1290072913000550
- R42 Bennett J.L. (1999), J Archaeol Sci 26:1-8 (via The Effects of Fire on Archaeological Soils and Sediments). https://www.researchgate.net/publication/276372040
- R43 Gosselain O.P. (1992), Bonfire of the enquiries, J Archaeol Sci 19:243-259. https://os.pennds.org/archaeobib_filestore/pdf_articles/ANTH501/1992_Gosselain.pdf ; Temperature evolution inside a pot during experimental surface (bonfire) firing, https://www.sciencedirect.com/science/article/abs/pii/S016913171000308X
- R44 Timberlake S. (2007), The use of experimental archaeology/archaeometallurgy for understanding and reconstructing early Bronze Age mining and smelting, in Metals and Mines (La Niece, Hook, Craddock eds.) 27-36. https://www.researchgate.net/publication/283996810 ; Mitt. Österr. Miner. Ges. 156 (2010), https://www.uibk.ac.at/media/filer_public/9e/09/9e0963b8-3c5e-49b7-9ff5-3adfbe266cf7/156_115-128.pdf
- R45 Historical Metallurgy Society Datasheet 301. https://historicalmetallurgy.org/media/l5dh3df0/hmsdatasheet301.pdf ; By the hand of the smelter (2022), doi:10.1007/s12520-022-01516-3
- R46 Zhang Z., Ding P., Wang S., Huang X. (2023), Smouldering-to-flaming transition on wood induced by glowing char cracks and cross wind, Fuel 352:129091. https://www.sciencedirect.com/science/article/abs/pii/S0016236123017052
- R47 Carmignani L. et al. (2024), Smoldering of wood: effects of wind and fuel geometry, Fire Technology, doi:10.1007/s10694-024-01542-8. https://www.fs.usda.gov/rm/pubs_journals/2024/rmrs_2024_carmignani_l001.pdf
- R48 ITS-90. https://en.wikipedia.org/wiki/International_Temperature_Scale_of_1990
- R49 Wieland Concast, C90700 tin bronze data sheet. https://www.concast.com/c90700.php
- R50 USDA FSIS, Safe minimum internal temperature chart. https://www.fsis.usda.gov/food-safety/safe-food-handling-and-preparation/food-safety-basics/safe-temperature-chart
- R51 Wikipedia, Candlepower (https://en.wikipedia.org/wiki/Candlepower) and Luminous intensity (https://en.wikipedia.org/wiki/Luminous_intensity)
- R52 Ohlemiller T.J. (1991), Smoldering combustion propagation on solid wood, Fire Safety Science 3, as cited in R46. https://publications.iafss.org/publications/fss/3/565/view/fss_3-565.pdf
- R53 Bamford C., Crank J., Malan D. (1946) and Hottel H.C. (1942), as reviewed in R14
- R54 Self-extinction of wood plate: effect of fuel thickness and flame spread orientation (2025), Fire Safety J. https://www.sciencedirect.com/science/article/abs/pii/S0379711225001018
- R55 Digitalfire, Dehydroxylation (https://digitalfire.com/temperature/38); Kankara kaolin firing (https://pmc.ncbi.nlm.nih.gov/articles/PMC7215478/)
- R56 Recrystallization temperature overview (https://www.sciencedirect.com/topics/engineering/recrystallization-temperature); 375 to 650 C annealing from a search excerpt, source not confirmed
- R57 PVEducation, Standard solar spectra (ASTM G173). https://www.pveducation.org/pvcdrom/appendices/standard-solar-spectra
- R58 Babrauskas V. (2005), Charring rate of wood as a tool for fire investigations, Fire Safety J 40:528-554, doi:10.1016/j.firesaf.2005.05.006 (via R17)
- R59 USDA FPL (2021), Wood Handbook ch. 18 Fire safety of wood construction (excerpt only; server 502). https://www.fpl.fs.usda.gov/documnts/fplgtr/fplgtr282/chapter_18_fpl_gtr282.pdf
- R61 A computational examination of large-scale pool fires (2022), Flow (Cambridge), quoting Fr = 2.5. https://www.cambridge.org/core/journals/flow/article/computational-examination-of-largescale-pool-fires-variations-in-crosswind-velocity-and-pool-shape/E9A7FF517322D98E9ECBB01169C8F710
- R62 An investigation of the influence of heating modes on ignition and pyrolysis of woody wildland fuel (Bi < 0.1). https://www.researchgate.net/publication/273960293
- R63 Fire behavior of thermally thin materials in cone calorimeter (2021). https://pmc.ncbi.nlm.nih.gov/articles/PMC8071363/
- R64 Ellis P.F.M. (2015), The likelihood of ignition of dry-eucalypt forest litter by firebrands, Int J Wildland Fire 24:225-235, doi:10.1071/WF14048. Abstract: https://www.frames.gov/catalog/53591 . Numbers from CSIRO PyroPage No. 2 (Aug 2015), Predicting spotfire ignition in dry eucalypt litter, https://research.csiro.au/pyropage/wp-content/uploads/sites/17/2015/08/CSIRO-PyroPage-Issue-2-Spotfires.pdf
- R65 Blackmarr W.H. (1972), Moisture content influences ignitability of slash pine litter, USDA FS Res. Note SE-173. https://research.fs.usda.gov/treesearch/4635
- R66 Babrauskas V. (undated, after 2003), Risk of ignition of forest fires from black powder or muzzle-loading firearms, study for USFS San Dimas T&D Center (reviews Blackmarr, Countryman 1982 and 1983, Hoffheins 1933, Markalas 1985, Ford 1995, McGuire et al. 1956, Parrott and Donald 1970). https://doctorfire.com/pages/Black_powder.pdf
- R67 Wang S.P., Huang X.Y., Chen H.X., Liu N.A. (2017), Interaction between flaming and smouldering in hot-particle ignition of forest fuels and effects of moisture and wind, Int J Wildland Fire 26:71-81, doi:10.1071/WF16096. https://www.frames.gov/catalog/55540
- R68 Weak sources on flint and steel: Sensible Survival (2011), Starting fire with flint and steel, https://sensiblesurvival.org/2011/08/11/starting-fire-with-flint-and-steel-how-it-works-and-why-its-not-really-a-good-survival-plan/ ; Wikipedia, Amadou, https://en.wikipedia.org/wiki/Amadou ; spark temperatures from https://ruralsportsman.com/from-spark-to-flame/ and https://www.frostburg.edu/faculty/rkauffman/_files/images_preppers_chapters/ch05-fireheat.pdf
- R69 Baugh R.A. (1999), Fire-by-friction with damp materials, Bulletin of Primitive Technology 17. https://www.primitiveways.com/fire_damp_materials.html
- R70 Rothermel R.C., Wilson R.A. Jr., Morris G.A., Sackett S.S. (1986), Modeling moisture content of fine dead wildland fuels: input to the BEHAVE fire prediction system, USDA FS Res. Pap. INT-359 (quotes Byram G.M., Jemison G.M. (1943), Solar radiation and forest fuel moisture, J Agric Res 67:149-176). https://www.fs.usda.gov/rm/pubs_int/int_rp359.pdf
- R71 Weise D.R., Fujioka F.M., Nelson R.M. Jr. (conference paper, about 2003), A comparison of 3 models of 1-hr time lag fuel moisture in Hawaii, AMS Fire and Forest Meteorology symposium, paper J11.6 (journal version: Agric For Meteorol 2005, https://www.sciencedirect.com/science/article/abs/pii/S0168192305001814). https://ams.confex.com/ams/pdfpapers/65639.pdf
- R72 Jolly W.M., Freeborn P.H., Bradshaw L.S., Wallace J., Brittain S. (2024), Modernizing the US National Fire Danger Rating System (version 4): simplified fuel models and improved live and dead fuel moisture calculations, Environmental Modelling and Software 181:106181, doi:10.1016/j.envsoft.2024.106181. https://www.fs.usda.gov/rm/pubs_journals/2024/rmrs_2024_jolly_m001.pdf
- R73 NWCG (2020), NFDRS2016 live fuel moisture changes, NFDRS lesson 4-3. https://wildfireweb-prod-media-bucket.s3.us-gov-west-1.amazonaws.com/s3fs-public/2025-09/fds-nfdrs-lesson-04-3.pdf
- R74 Nikonovas T., Santín C., Belcher C.M., Clay G.D., Kettridge N., Smith T.E.L., Doerr S.H. (2024), Vegetation phenology as a key driver for fire occurrence in the UK and comparable humid temperate regions, Int J Wildland Fire, doi:10.1071/WF23205
- R75 Lees et al. (2026), Wildfire size, severity and timing vary with dominant vegetation in open landscapes in England and Wales, Ecological Solutions and Evidence, doi:10.1002/2688-8319.70254 (search excerpt); James Hutton Institute (2023), Fire danger assessment of Scottish habitat types, deliverable D2.3b, https://www.hutton.ac.uk/wp-content/uploads/2024/03/Deliverable-D2_3b-Fire-Danger-Fuels-Final-6-3-23.pdf (search excerpt)
- R76 Modeling moisture factors in grassland fire danger index for prescribed fire management in the Great Plains (2025), Fire 8:469, doi:10.3390/fire8120469 (search excerpt)
- R77 Met Office (2018), statement on rain intensity classes, https://x.com/metoffice/status/1048551642277335041 ; shower classes as listed at https://cumulus.hosiene.co.uk/viewtopic.php?t=3474 (weak)
- R78 Schumacher C., Houze R.A. Jr. (2003), Stratiform rain in the tropics as seen by the TRMM precipitation radar, J Climate 16:1739-1756. https://journals.ametsoc.org/view/journals/clim/16/11/1520-0442_2003_016_1739_sritta_2.0.co_2.xml (search excerpt)
- R79 (authors not captured from the page read) (2025), Super-Clausius-Clapeyron scaling of extreme precipitation explained by shift from stratiform to convective rain type, Nature Geoscience, doi:10.1038/s41561-025-01686-4. https://pmc.ncbi.nlm.nih.gov/articles/PMC12074990/
- R80 Blenkinsop S. et al. (2017), Quality-control of an hourly rainfall dataset and climatology of extremes for the UK, Int J Climatol 37:722-740, doi:10.1002/joc.4735. https://pmc.ncbi.nlm.nih.gov/articles/PMC5300158/
- R81 Andrews P.L. (2012), Modeling wind adjustment factor and midflame wind speed for Rothermel's surface fire spread model, USDA FS RMRS-GTR-266 (Albini F.A., Baughman R.G. (1979), Estimating windspeeds for predicting wildland fire behavior, INT-221; Baughman and Albini 1980). https://gacc.nifc.gov/nwcc/content/products/fwx/publications/rmrs_gtr266.pdf
- R82 Sensitivity to the representation of wind for wildfire rate of spread (2025), Fire 8:135, doi:10.3390/fire8040135 (search excerpt)
- R83 Wieringa J. (1993), Representative roughness parameters for homogeneous terrain, Boundary-Layer Meteorol 63:323-363 (not read; table via search excerpts of https://www.researchgate.net/figure/1-The-Davenport-Wieringa-roughness-length-z-0-classification-Table-presented-in-Stull_tbl1_341709759 and WMO registry https://codes.wmo.int/wmdr/SurfaceRoughnessDavenport/open)
- R84 Di Cristina G., Skowronski N.S., Simeoni A., Rangwala A.S., Im S. (2021), Flame spread predictions over linear discrete fuel arrays using an empirical B-number model and stagnation point flow, Combust Flame 234:111644. https://research.fs.usda.gov/download/treesearch/63042.pdf
- R85 McAllister S., Finney M., Cohen J. (2010), Critical mass flux for flaming ignition of dead, dry wood as a function of external radiant heat flux and oxidizer flow velocity, VI Int Conf Forest Fire Research (Viegas ed.). https://www.fs.usda.gov/rm/pubs_other/rmrs_2010_mcallister_s003.pdf
- R86 Finney M.A., McAllister S.S. (2011), A review of fire interactions and mass fires, J Combustion 2011:548328, doi:10.1155/2011/548328 (reports Grumer and Strasser's trends with solid beds). https://research.fs.usda.gov/treesearch/download/40149.pdf ; primary not read: Grumer J., Strasser A. (1965), Uncontrolled fires: specific burning rates and induced air velocities, Fire Technol 1:256-268, doi:10.1007/BF02588468
- R87 Hardy C.C. (1996), Guidelines for estimating volume, biomass, and smoke production for piled slash, USDA FS PNW-GTR-364. https://www.fs.usda.gov/pnw/pubs/pnw_gtr364.pdf
- R88 Joint Fire Science Program brief, A new online tool and estimates for hand-pile biomass and consumption (Wright et al.), https://digitalcommons.unl.edu/cgi/viewcontent.cgi?article=1139&context=jfspbriefs (search excerpt)
- R89 de Mestre N.J., Catchpole E.A., Anderson D.H., Rothermel R.C. (1989), Uniform propagation of a planar fire front without wind, Combustion Science and Technology (volume and pages not checked), as quoted in USDA FS Proceedings RMRS-P-73 (2015), https://research.fs.usda.gov/download/treesearch/49458.pdf (search excerpt)
- R90 ASHRAE (2016), ANSI/ASHRAE Addendum g to Standard 55-2013, Normative Appendix C, Procedure for calculating comfort impact of solar gain on occupants (with reference code, h_r = 6, Fanger's f_p tables). https://www.ashrae.org/File%20Library/Technical%20Resources/Standards%20and%20Guidelines/Standards%20Addenda/55_2013_g_20160920.pdf
- R91 Arens E., Hoyt T., Zhou X., Huang L., Zhang H., Schiavon S. (2015), Modeling the comfort effects of short-wave solar radiation indoors, Building and Environment 88:3-9, doi:10.1016/j.buildenv.2014.09.004. https://escholarship.org/uc/item/89m1h2dg
- R92 Arens E.A., Zhang H. (2006), The skin's role in human thermoregulation and comfort, in Thermal and Moisture Transport in Fibrous Materials (Pan and Gibson eds.), Woodhead, chapter 16 from p. 560 (cites de Dear R.J., Arens E., Zhang H., Oguro M. (1997), Convective and radiative heat transfer coefficients for individual human body segments, Int J Biometeorol 40(3):141-156). https://escholarship.org/uc/item/3f4599hx
- R93 Operative temperature definition as given in ASHRAE 55 and summarised at https://www.simscale.com/docs/simwiki/cfd-computational-fluid-dynamics/mean-radiant-temperature-operative-temperature-cfd/ (search excerpt)
- R94 Kwon J., Choi J. (2013), Clothing insulation and temperature, layer and mass of clothing under comfortable environmental conditions, J Physiol Anthropol 32:11, doi:10.1186/1880-6805-32-11. https://link.springer.com/article/10.1186/1880-6805-32-11
- R95 Temperature and humidity within the clothing microenvironment (1992), PubMed 1567319. https://pubmed.ncbi.nlm.nih.gov/1567319 (search excerpt)
- R96 American Meteorological Society, Glossary of Meteorology, Rain. https://glossary.ametsoc.org/wiki/Rain
- R97 Thom D., Rammer W., Albrich K. et al. (2024), Parameters of 150 temperate and boreal tree species and provenances for an individual-based forest landscape and disturbance model, Data in Brief 55: 110662, doi:10.1016/j.dib.2024.110662. Database: iLand Species Parameters, Mendeley Data doi:10.17632/58xdbwskp8.1 (all_species_database.sqlite, tables species and wind, read directly).
- R98 Falster D.S., Duursma R.A., Ishihara M.I. et al. (2015), BAAD: a Biomass And Allometry Database for woody plants, Ecology 96: 1445, doi:10.1890/14-1889.1. Data release v1.0.1, https://github.com/dfalster/baad/releases (baad_data.csv read directly). Original studies used: Albrektson 1984, Vanninen 2005, Santa Regina 1999 (pine); Bond-Lamberty 2002, Wang 1995 (P. tremuloides); 22 studies for deciduous Quercus (Coweeta, Japanese forests, Salamanca).
- R99 Brown J.K. (1978), Weight and density of crowns of Rocky Mountain conifers, USDA Forest Service Research Paper INT-197. https://www.govinfo.gov/content/pkg/GOVPUB-A13-PURL-gpo37176/pdf/GOVPUB-A13-PURL-gpo37176.pdf
- R100 Song J., Jang M., Lee B. et al. (2026), Allometric equations for estimating crown fuel biomass of Pinus densiflora in South Korea, Forests 17(5): 549, doi:10.3390/f17050549 (abstract).
- R101 USDA Forest Service Fire Effects Information System, Ulex europaeus species review. https://www.fs.usda.gov/database/feis/plants/shrub/uleeur/all.html
- R102 Pearce H.G. et al. (2010), as cited in: Biomass and bioethanol production of the shrub Ulex europaeus estimated with remote sensor imagery in the Andean paramos, Revista de Biología Tropical 72(1): e56364. https://www.scielo.sa.cr/pdf/rbt/v72n1/0034-7744-rbt-72-01-e56364.pdf
- R103 Davies G.M., Legg C.J. (2011), Fuel moisture thresholds in the flammability of Calluna vulgaris, Fire Technology, doi:10.1007/s10694-010-0162-0; and Davies G.M. et al. (2009), Rate of spread of fires in Calluna vulgaris-dominated moorlands, J. Applied Ecology, doi:10.1111/j.1365-2664.2009.01681.x (excerpts).
- R104 Growth pattern and distribution of biomass of Calluna vulgaris on an ombrotrophic peat bog (excerpt via ResearchGate 230127776).
- R105 Forest Products Laboratory (1999), Air drying of lumber, Gen. Tech. Rep. FPL-GTR-117, USDA Forest Service (revision by Simpson W.T., Tschernitz J.L., Fuller J.J. of Rietz and Page 1971). Read via https://eri.nau.edu/wp-content/uploads/2021/12/Air-Drying-of-Lumber.pdf ; original https://www.fpl.fs.usda.gov/documnts/fplgtr/fplgtr117.pdf
- R106 Simpson W.T., Wang X. (2003), Estimating air drying times of small-diameter ponderosa pine and Douglas-fir logs, Res. Pap. FPL-RP-613, USDA Forest Service Forest Products Laboratory. https://research.fs.usda.gov/download/treesearch/6350.pdf
- R107 Erber G., Kanzian C., Stampfer K. (2012), Predicting moisture content in a pine logwood pile for energy purposes, Silva Fennica 46(4): 910, doi:10.14214/sf.910 (abstract).
- R108 Precision measurement of forest harvesting residue moisture change and dry matter losses by constant weight monitoring (ResearchGate 276868491; excerpt), and Nurmi and Hillebrand as cited in IEA Bioenergy (2020), Dry matter losses during biomass storage, https://www.ieabioenergy.com/wp-content/uploads/2020/01/EIA-Dry-Matter-Loss_Final.pdf (excerpt).
- R109 Kays J. (2018), Measuring wood moisture and drying time for hardwood tree species, University of Maryland Extension FS-1074. https://extension.umd.edu/sites/extension.umd.edu/files/publications/MeasuringWoodMoisture_FS-1074.pdf
- R110 IPCC (2006), 2006 IPCC Guidelines for National Greenhouse Gas Inventories, Vol. 4, Ch. 4 Forest Land, Table 4.14 Basic wood density of selected temperate and boreal tree taxa (values from Dietz 1975). https://www.ipcc-nggip.iges.or.jp/public/2006gl/pdf/4_Volume4/V4_04_Ch4_Forest_Land.pdf
- R111 DELTA Intkey, Commercial timbers: Corylus avellana. https://www.delta-intkey.com/wood/en/www/betcoave.htm (excerpt).
- R112 Core.ac.uk document 81384842 (hazel wood oven-dry density 0.67 g/cm3; excerpt only, author not seen). https://core.ac.uk/download/pdf/81384842.pdf
- R113 Wood density is related to aboveground biomass and productivity along a successional gradient in upper Andean tropical forests, Frontiers in Plant Science (2023), doi:10.3389/fpls.2023.1276424 (Table 2 read).
- R114 Scots pine (Pinus sylvestris L.) stem wood and bark moisture and density influencing factors (ResearchGate 288569886; excerpt, authors not seen).
- R115 Lewis C.H.M., Little K., Graham L.J., Kettridge N. et al. (2024), Diurnal fuel moisture content variations of live and dead Calluna vegetation in a temperate peatland, Scientific Reports, doi:10.1038/s41598-024-55322-z.
- R116 Flame temperatures saturate with increasing dead material in Ulex europaeus, but flame duration, fuel consumption and overall flammability continue to increase, Fire 2(1): 6 (2019), doi:10.3390/fire2010006 (excerpt).
- R117 Effect of live/dead condition, moisture content and particle size on flammability of gorse (Ulex europaeus) measured with a cone calorimeter, International Journal of Wildland Fire 33(7): WF23167 (2024) (excerpt).
- R118 Qi Y. et al. (2014), Spectroscopic analysis of seasonal changes in live fuel moisture content and leaf dry mass, USDA Forest Service RMRS. https://www.fs.usda.gov/rm/pubs_other/rmrs_2014_qi_y001.pdf (excerpt).
- R119 National Wildfire Coordinating Group, PMS 437 Fuel moisture: live fuel moisture content. https://www.nwcg.gov/publications/pms437/fuel-moisture/live-fuel-moisture-content (excerpt).
- R120 Gum rosin safety data sheets: Chemical Store Inc., Rosin powder natural (https://sds.chemicalstore.com/rosinp100.pdf); Santa Cruz Biotechnology sc-215118 (https://datasheets.scbt.com/sc-215118.pdf); gum-rosin.net MSDS (https://www.gum-rosin.net/files/2023/02/Gum-Rosin-MSDS.pdf); Fisher Scientific rosin SDS (excerpts).
- R121 US Coast Guard / NOAA CAMEO Chemicals, CHRIS sheet ORN, Oils, miscellaneous: rosin (June 1999). https://cameochemicals.noaa.gov/chris/ORN.pdf
- R122 Medina-Alcaide M.Á. et al. (2021), The conquest of the dark spaces: an experimental approach to lighting systems in Paleolithic caves, PLoS ONE, doi:10.1371/journal.pone.0250497 (Newcomer's lamb-fat figure cited there).
- R123 Chemical Engineering Transactions vol. 38 (2014), paper 030, fat and oil properties table (beef tallow HHV). https://www.aidic.it/cet/14/38/030.pdf (excerpt).
- R124 Feedtables (INRA-CIRAD-AFZ), Tallow. https://www.feedtables.com/content/tallow (excerpt).
- R125 US Coast Guard / NOAA CAMEO Chemicals, CHRIS sheet TLO, Tallow (June 1999). https://cameochemicals.noaa.gov/chris/TLO.pdf
- R126 Wikipedia, Animal fat (melting range of mixed animal fats). https://en.wikipedia.org/wiki/Animal_fat (excerpt).
- R127 Evaluation of the gross and net calorific value of the selected wood species (ResearchGate 286759699), and cfnielsen.com, What is the calorific value of wood (excerpts).
- R128 Renewable pellets obtained from aspen and birch bark, BioResources; and Methods of betulin extraction from birch bark, Molecules 27(11): 3621 (2022) (excerpts).
- R129 Adhesives free bark panels: an alternative application for a waste material, PLoS ONE (2023), doi:10.1371/journal.pone.0280721 (excerpt).
- R130 The utilization of tree bark, BioResources (review) (excerpt).
- R131 CATAS, Heat of combustion, fire load and other "strange" terms. https://catas.com/uploads/media/catas-carico-incendio-eng.pdf (excerpt).
- R132 Combustion characteristics and kinetic analysis of finished leather waste using TG-DSC, Biomass Conversion and Biorefinery (2023), doi:10.1007/s13399-023-03974-8 (excerpt).
- R133 Hierarchical nanomechanics of collagen microfibrils (Buehler group), Nature Precedings npre.2010.4995.2 (excerpt).
- R134 Collagen extraction from various waste bovine hide sources (ResearchGate 336991447), Table 2 (excerpt).
- R135 Collagen sponge density (ResearchGate figure 304667355) (excerpt).
- R136 Trade data: fursource.com, Facts about cowhide; Tandy Leather, Selection North American deerskin (excerpts).
- R137 Donnelly E. et al., Potential and historical uses for bracken (Pteridium aquilinum (L.) Kuhn) in organic agriculture, citing Callaghan et al. (1981). https://orgprints.org/id/eprint/8312/1/Donnelly_Potential_historical_bracken.pdf (excerpt).
- R138 Expanding the biomass resource: sustainable oil production via fast pyrolysis of low input high diversity biomass, PMC5070406 (excerpt).
- R139 Rumicha et al. (2025), Nutritional, anti-nutritional and mineral contents of selected wild edible plants in Ethiopia, Food Science and Nutrition (excerpt).
- R140 Bracken frond biomass figures, excerpt from search results citing bracken stand studies (source not opened) [weak].
- R141 Moran M.J., Shapiro H.N. et al., Fundamentals of Engineering Thermodynamics, 9th ed., Table A-19 Properties of selected solids and liquids (Purdue ME 300 copy). https://engineering.purdue.edu/ME300/Spring%202020/ME%20300%20Property%20Table%209ed.pdf
- R142 material-properties.org, Quartz: density, heat capacity, thermal conductivity (excerpt).
- R143 Encyclopaedia Britannica, Rock: thermal properties (excerpt).
- R144 mindat.org, Malachite (excerpt).
- R145 Digitalfire, LDW and CLWC tests and Firing shrinkage glossary; Ceramic Arts Daily community; ceramics shrinkage guides (excerpts; trade sources).
- R146 Wikipedia, Clay (citing Moreno-Maroto and Alonso-Azcárate 2018) (excerpt).
- R147 ASHRAE Handbook, Refrigeration, Chapter 8 Thermal properties of foods (copy at https://consultancyengineering.com/wp-content/uploads/2023/12/CH-08-Thermal-Properties-of-Foods.pdf).
- R148 Midhills, Gum rosin specification (WW grade), https://midhills.com/gum-rosin/ ; Chemical Store, Gum rosin lumps, Honduran, grade WG/WW, https://us.chemicalstore.com/gum-rosin-lumps-honduran-grade-wgww (excerpts; supplier specifications).
- R149 Laboratory strength testing of pine wood and birch bark adhesives: a first study of the material properties of pitch, Journal of Archaeological Science: Reports (2017) (ResearchGate 315516862; excerpt).
- R150 Swiss National Museum blog (2022), Birch pitch: humankind's first glue; Adhesive strength and rupture behaviour of birch tars made with different Stone Age methods, Journal of Paleolithic Archaeology, doi:10.1007/s41982-023-00135-1 (excerpts).
- R151 US FDA, Processing parameters needed to control pathogens in cold-smoked fish. https://www.fda.gov/files/food/published/Processing-Parameters-Needed-to-Control-Pathogens-in-Cold-Smoked-Fish.pdf (excerpt).
- R152 Wikipedia, Smoked fish (excerpt).
- R153 Food Safety Magazine (2024), Understanding hot and cold smoked fish processing and safety (excerpt).
- R154 International Journal of Engineering and Technology, smoking-kiln paper (sciencepubco.com article 32419) (excerpt).
- R155 SATRA, Determining leather shrinkage temperature. https://www.satra.com/bulletin/article.php?id=1422 (excerpt).
- R156 Hydroxyproline and the shrinkage temperature of collagen, Nature 187: 150 (1960) (excerpt).
- R157 Factors affecting thermal stability of collagen from the aspects of extraction, processing and modification, Journal of Leather Science and Engineering (2020), doi:10.1186/s42825-020-00033-0 (excerpt).
- R158 US patent 8481169 (Leather; glutaraldehyde shrinkage temperature); US patent 9938592B1 (Liquid smoke tanning method); Lost Dutchman Leather, The chemistry of tanning (excerpts).
- R159 AIC Conservation Wiki, Leather and skin. https://conservation-wiki.com/wiki/Leather_and_Skin (excerpt).
