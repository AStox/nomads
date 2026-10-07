# Fire physics constants, with sources

Research for docs/brainstorms/2026-10-07-fire-physics-requirements.md and its plan. Every constant the fire model uses comes from this table, fixed before the success criteria are checked; a criterion that fails with these values is a gap in the model, not something to retune. Collected 2026-10-07.

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
- Char yield 0.25.
- Regression β = 0.028 q (mm/min, q kW/m2 net to the surface), capped near 1.6 mm/min in a bed. This gives 0.65 mm/min at about 23 kW/m2, which matches the furnace value.
- A piece keeps flaming only while m'' = (q_in - q_loss)/L stays at or above about 3.5 g/m2s, with L = 6.8 kJ/g (R2's lower value), using the CLT and review midpoint.

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

## Recommended R2 constant set (with section refs)

**Wood, side grain**
- ρ: per species; Wood Handbook relations for k(G, MC) and c(T, MC) (sec. 1).
- kρc_apparent: 1.8 x ambient, about 0.22 (kW/m2K)^2 s (sec. 1).
- Tig: 350 C (softwood), 305 C (hardwood).
- q_cr: 11 kW/m2 in formula; 12 as a threshold.
- Δh flaming: 13 MJ/kg of volatiles.
- Char yield: 0.25.
- β: 0.028 q mm/min.
- Extinction: m'' about 3.5 g/m2s.
- L: 6.8 kJ/g (R2's lower value; 12.5 is R2's across-grain fit, and 1.82 kJ/g from R14 disagrees, see sec. 3).

**Char / charcoal**
- Δh: 30 MJ/kg.
- Emissivity: 0.95.
- Glow: 600 C still air, 830 C in 2.5 m/s wind.
- Burns in proportion to air supply (Albini K law; up to 6 times with blown air).

**Fine dead fuel**
- Particle density: 32 lb/ft3 (513 kg/m3), the NFDRS constant (R30 [read]).
- Heat content: 8000 Btu/lb (18.6 MJ/kg), from the NFDRS fuel model row (R30 [read]).
- Thin-body ignition in flame contact at about 100 kW/m2.
- Mx 0.30.
- Timelag scales as d^2 from the 10-h anchor.

**Water**
- 2.6 MJ/kg to boil off from ambient.
- kρc factor (1 + 8.1 m) for thick pieces; (1 + 5 m) for thin.

**Flames**
- Heskestad height; κ 0.8; χr 0.3; tilt by Thomas.

## Gaps reported, not filled by retuning

- Wind blow-off correlation for small wood flames.
- Luminous efficacy of wood flames.
- Banked-coal and kiln temperatures as measured values.
- Exact F22 spotting-distance coefficients (in R28; not transcribed).
- Wood Handbook ch. 18 text (the FPL server returned 502).
- The moist heat-capacity leading term.
- Mindykowski's own moisture coefficient.

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
