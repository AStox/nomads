# geology.ts + island.ts: constants checked against sources (Bornholm analogue)

Tags: [cited] = I read the value at the URL given. [derived] = worked out from cited values. [design] = a free modelling choice. [gap] = no source found. UNVERIFIED = only seen second-hand.

## Changes to the generator's structure (read these first)
1. **Soil parent material should be the glacial drift, not the bedrock.** Most of Bornholm is covered by a thin layer of glacial deposits, "mainly clayey till and meltwater sand and gravel". Over parts of the basement there is none (Trap Danmark, https://trap.lex.dk/Bornholms_geologi). The central upland has only a "thin cover of till sand", which has developed into podzol (Trap 5, https://trap5.lex.dk/amt/bornholms-amt/). This needs a new `drift` field (till clay / till sand / meltwater sand / bare rock / peat, plus a thickness). ground.ts should take `sand`, `clay` and `base` from `drift`. ROCKS `sand`/`clay` would then apply only where there is bare rock or grus.
2. **`ore` belongs to wetlands, not rock.** Danish bog iron ore (myremalm, 35–45 wt% Fe) forms after the ice age in bogs and meadows, from iron-bearing minerals in the till. It lies in benches 30–50 cm thick, starting about a spade's depth down (Buchwald, Lex, https://lex.dk/myremalm) [cited]. Derive it from the water table and marsh fields. Drop `ore` from ROCKS.
3. **`flint` comes from glacial erratics, not local limestone.** "Bornholm flint occurs only as small, round nodules" (Trap 5) [cited]. The Palaeozoic limestones (Komstad on Bornholm, Silurian on Gotland) are not flint-bearing. The current `flint: 0.9` on limestone is wrong for this analogue. Model flint as a constant fraction of clasts in the till [gap: fine-gravel counts for Bornholm till].
4. **`perm` (0–1) should become log10 of saturated hydraulic conductivity K_sat (m/s).** water.ts line 90 (`T = 2000 + 60000·perm²`) has to change to `T = K·b`, where b is the aquifer thickness.
5. **`hard` counts rock strength twice.** It appears as `(1.3−hard)` multiplied by `incise`/`creep`. Replace both with one measured K and one D per lithology.
6. **Erosion must run in real units.** Drainage area A = `carried`·CELL² (m²). Flow distance = `far`·CELL (m). The Laplacian must be divided by CELL². `dt` in years. Both blurs need radii in metres.
7. **Rain during erosion should come from climate.ts.** The current rule (line 70) ignores wind. This means running climate before or inside the erosion loop.
8. **Swap the alpine trough model for areal scour guided by joints.** This needs a new field: fracture or joint-zone density.
9. **Swap `basalt` for `dolerite`.** On Bornholm it occurs only as dykes: more than 250 of them, mostly NNE–SSW (Gravesen et al. 2014). Basalt as a land surface does not occur there.

## Analogue facts used below [cited]
- **Bornholm:** 587.55 km², of which water is 2.65 km² (0.45%). Highest point Rytterknægten 165 m (Trap 5; Wikipedia gives 162 m). The landform is a "flat, domed shield", with large areas above 80 m on about 400 km² of basement. The basement surface dips south under the sediments (Trap 5).
- **Gotland:** 2,994 km², highest point Lojsta Hed 82 m, mean height 29 m. **Rügen:** 926 km², highest point Piekberg 161 m (Wikipedia API extracts).
- **Ice:** the last-glacial-maximum (MIS 2) readvance "overrode the horst of Bornholm" (Lüthgens, Hardt & Böse 2020, E&G Quaternary Sci. J. 69:201, https://egqsj.copernicus.org/articles/69/201/2020/). Ice came from the NE: the smooth, ice-worn faces of the rock knolls point NE (Trap 5). Deglaciation was about 16.3 ka (Houmark-Nielsen et al. 2012; UNVERIFIED, seen only as an abstract snippet).

## geology.ts

| line | now | replacement | source | tag |
|---|---|---|---|---|
| 20–24 `perm` | 0.05–0.85 | K_sat (m/s, read off the chart). Shale 1e-13–1e-9. Sandstone 1e-10–1e-6. Limestone/dolomite 1e-9–1e-5. Karst limestone 1e-6–1e-2. Unfractured igneous 1e-14–1e-10. Fractured igneous/metamorphic 1e-8–1e-4. Permeable basalt 1e-7–1e-2. Glacial till 1e-12–1e-6. | Freeze & Cherry 1979, *Groundwater*, Table 2.2, https://fc79.gw-project.org/english/chapter-2/ (SVG table) | [cited] |
| (granite, Bornholm) | 0.08 | Fractures carry water to at least 90 m depth; water table a few m below the surface; clayey till up to 6 m thick on top. Boreholes have specific capacity 0.05–0.22 m³/h (taken as per m of drawdown). That gives T ≈ 1.7–7.5e-5 m²/s and K ≈ 2–8e-7 m/s over 90 m. | Gravesen, Nilsson, Rasmussen & Schack Pedersen 2014, GEUS Bull. 31:15–18, https://geusbulletin.org/index.php/geusb/article/download/4637/10293/30580 | facts [cited]; T and K [derived] (Logan T≈1.22 Q/s is UNVERIFIED) |
| `base` | 0.1–1 | Carbonate content (wt% CaCO₃) of the parent material (till or rock). This buffers pH. | — | [gap]. Danish JB classes cap CaCO₃ at ≤10% for mineral soils (Harbo et al. 2021, below); the CaCO₃ of Bornholm till is unknown. |
| `sand`,`clay` | e.g. 0.15/0.55 | Use Danish JB texture classes (Den danske Jordklassificering; wt%, sand 20–2000 µm). JB1–2: clay 0–5, sand 75–100. JB3–4: clay 5–10, sand 65–95. JB5–6: clay 10–15, sand 55–90. JB7: clay 15–25, sand 40–85. JB1–7 cover about 99% of Danish farmland. Mapping for Bornholm: clayey till ("fed moræneler") → JB5–7; till sand and granite grus (Årsdale grus) → JB1–4; shale → JB7+; Nexø sandstone → JB1–3. | Harbo, Elsgaard & Olesen 2021, *Vand & Jord* 28(4):155–158, Table 1, http://vand-og-jord.dk/wp-content/uploads/2022/12/VJ-4_21_Landbrugsjord_s155-158.pdf; Trap 5 | class values [cited]; rock→class mapping [derived/INFERENCE] |
| `feed` | 0.25–0.95 | Rock P content, median ppm. Granite 436. Mudstone 1,135. Siltstone 698. Sandstone 500. Andesite 1,000. Alkali basalt >3,000. Normalise by mudstone, or drive a P release rate directly. | Porder & Ramachandran 2013, *Plant Soil* 367:41–55, abstract, https://link.springer.com/article/10.1007/s11104-012-1490-2 | [cited]; limestone and dolerite [gap] |
| `flint` | 0.08–0.9 | See structural change 3: flint is a till-clast property. The Arnager Limestone is siliceous because it formed from sponge banks (Trap Bornholms geologi), which might give chert. | Trap 5; Trap | [cited] qualitative; amounts [gap] |
| `pyrite` | 0.03–0.4, marked [design] | The Alum Shale is a "pyrite-rich mudstone" with 5–25% TOC; limestone concretions make up 5–10% of its thickness in Denmark. The granite is low in pyrite. Keep mudstone highest. | Nielsen & Schovsbo 2013, GEUS Rapport 2013/7, Summary, https://data.geus.dk/pure-pdf/29526_GEUS-R_2013_7_opt.pdf | ranking [cited]; percentages [gap] |
| `ore` | 0.02–0.5 | See structural change 2. | Buchwald, Lex | [cited] |
| `incise` | 0.6–1.25 | Stream-power K (yr⁻¹, m=0.5, n=1). Stock & Montgomery give, at m=0.4: granite/metamorphic 1e-7–1e-6, volcaniclastic 1e-5–1e-4, mudstone 1e-4–1e-2 m^0.2/yr. Converted to m=0.5 by multiplying by A^-0.1 (≈0.2–0.25 for A = 1e6–1e7 m²): **granite 2e-8–2.5e-7; volcanic 2e-6–2.5e-5; mudstone 2e-5–2.5e-3**. Sandstone, limestone and till [gap]: Harel, Mudd & Attal 2016 only say K is lower on igneous than sedimentary rock and that n is generally >1. Common modelling range is 1e-8–1e-5. | Stock & Montgomery 1999, JGR 104(B3):4983–4993, https://agupubs.onlinelibrary.wiley.com/doi/10.1029/98JB02139 (the abstract was cut off on the page; the K sentence comes from the search engine's extract of the same page). Harel et al. 2016, Geomorphology 268:184–196, abstract, https://www.research.ed.ac.uk/en/publications/global-analysis-of-the-stream-power-law-parameters-based-on-world/. Litwin, Malatesta & Sklar 2025, ESurf 13:277, https://esurf.copernicus.org/articles/13/277/2025/ | [cited] + [derived] |
| `creep` | 0.6–1.3 | One hillslope diffusivity, D = 4.4e-4–3.6e-2 m²/yr; it depends on climate and biota more than on rock. Set D = 0 on bare rock. | Fernandes & Dietrich 1997, as cited by Litwin et al. 2025 | [cited, secondary] |
| 28–30 `rockOf` 0.4/0.62/0.55/0.6 | thresholds | [design] lithology map. Tune so the areal shares match Bornholm: roughly 2/3 crystalline (about 400 of 588 km²), the rest Palaeozoic and Mesozoic sediments (Trap 5). Better: a south-dipping layer-cake on a faulted horst, so the rock follows the structure. | Trap 5 | [design] + [cited] shares |

## island.ts

| line | now | replacement | source | tag |
|---|---|---|---|---|
| 16 tilt, stretch 0.8–1.15 | random | Outline and aspect. | — | [design] |
| 25–26 warp 1.3/0.22; 29 coast fbm 3/4/0.12 | noise | Outline. | — | [design] |
| 30 edge /7 cells | | Keeps the island off the map edge; this is plumbing. | — | [design] |
| 31 mask (0.98−d)/0.3 | coast ramp | The 0.3 width sets the nearshore slope, which is a physical claim. The bathymetry needs a source (e.g. EMODnet). | — | [gap] |
| 32 ridged 1.8/3/0.45; 33 lowland 0.55±0.9, clamp 0.15–1; 34 `0.3+0.7·range²`, `mask²` | uplift pattern | This is a physical claim, and the wrong one for this analogue. Bornholm's relief comes from a tilted horst: basement high in the N and centre, dipping S under the sediments, cut into fault blocks. Use U(x) in m/yr = U₀·structural pattern, with the fault geometry as [design]. | Trap; Trap 5; Graversen 2009 (not read) | [design] geometry; [cited] style |
| 35–36 hard/chem `0.5+0.9·fbm`, freq 2.4/1.8 | | Lithology layout. | — | [design] (see `rockOf`) |
| 51 h₀ = 0.02·mask / −0.05 | initial state | Initial condition. | — | [design] |
| 55–56 `(1.3−hard)·incise/creep` | | K and D from ROCKS as above. | as above | [cited] |
| 57 `max(0.1, 0.9−0.8·perm)` | runoff | Runoff fraction from the water balance (P − ET − recharge), with recharge limited by the K_sat of the till or rock. | Freeze & Cherry Table 2.2 | [derived] |
| 59 blur r=1 cell | contact easing | Give the radius in metres. | — | [design] |
| 62 `dt=120/steps; K=0.25dt; CREEP=0.04dt; RISE=0.01dt` | dimensionless | Real years, K (yr⁻¹), D (m²/yr), U₀ (m/yr). See the relief check below. | — | [derived] |
| 66, 118, 136 flood eps 1e-6 / 1e-4 | | Numerical tolerance. | — | [design] |
| 70 `1+0.5·h/top` | orographic rain | Use climate.ts precipitation. Trap 5 confirms the centre of Bornholm is wetter because air cools as it rises. | Trap 5 | [cited] qualitative |
| 72–75 mean-normalise | | Delete once precipitation is in mm. | — | — |
| 81 `K·K0·√carried/far` | m=0.5, n=1 implicit | Keep, in units of A (m²) and distance (m). | Braun & Willett 2013 (named in the code, not read) | UNVERIFIED |
| 84 Laplacian, no /CELL² | | Divide by CELL². | — | [derived] |
| 112 `peak=(250+200r)·√(N·CELL/9600)` | 353–636 m at N·CELL = 19.2 km | **Delete.** The analogues reach 82 m (Gotland), 161 m (Rügen) and 162–165 m (Bornholm). The current range is 2–4 times too high. | Trap 5; Wikipedia | [cited] |
| 119 sea `max(−60, raw·1200)` | | Invented bathymetry. | — | [gap] |
| 126 `5·40·ramp(log10 drained, 2.3, 3.6)·clamp(1.15−1.4·hard)` | 200 m troughs on catchments of 1.1–22 km² | **Wrong process for this analogue.** Under an ice sheet the erosion is *areal scour*: "glacial plucking and abrasion guided by patterns of bedrock jointing and fracture", giving "streamlined bedrock, stoss-lee forms, and rock basins, all with typically <100 m of relief". Total scour is <50 m to 100–150 m, at ~1 to >100 mm/kyr. On Bornholm: joint valleys "from narrow gullies a few m wide up to Ekkodalen, whose floor is 60 m wide", with steep, often vertical walls. They were "formed in the last ice age as glaciers cleared out the crushed rock of the fracture zones". Long joint valleys have a sill in the middle acting as a watershed. The trough's "400 m wide" comment is wrong for this analogue. | Jansen, Knudsen, Andersen, Heyman & Egholm 2019, QSR 207:37–48, abstract and §2, https://jakob.heyman.info/publications/Jansen-et-al-2019-Erosion-rates-in-Fennoscandia-during-the-past-million-years.pdf; Trap 5 | [cited] |
| (erosion law) | none | E = K_g·u_s^l with K_g = 2.7e-7 m^(1−l) yr^(l−1) and l = 2.02. The older linear form uses l = 1, K_g = 1e-4. At u_s = 100 m/yr this gives E ≈ 3 mm/yr. The basal sliding speed u_s for the Baltic ice is [gap], and the law was fitted on a temperate alpine glacier. | Herman et al. 2015, Science 350:193–195, Fig. 3, https://web.gps.caltech.edu/~avouac/publications/Science-2015-Herman-193-5.pdf | [cited]; u_s [gap] |
| (gate) | none | Gate on ice-sheet cover, not on a local ELA (equilibrium-line altitude). The island lay inside the LGM limit, so the ice came from the regional sheet and had no local accumulation area. This is a scenario input. | Lüthgens et al. 2020 | [cited] |
| 127 blur r=2 | trough width | Joint-zone width, a few m to 60 m: below one 75 m cell. | Trap 5 | [cited] |
| 131 floor `ramp(log10 drained, 1.8, 3)`, hummocks 3 m, freq x/6 | moraine | Till ≤6 m thick on the basement (Gravesen 2014), thickest in the joint valleys (Trap). The hummock wavelength is [gap]. | as cited | [cited]/[gap] |
| 126/129 gates `>2`, `max(1,…)` | | Plumbing. | — | [design] |
| 138 `open`: depth >1 m | | Use hydrology's water mask (the audit's fix). | — | [derived] |
| 139 `basin`: depth >0.3 m | | Any closed depression whose floor is below the water table. Bornholm's lakes are joint-valley lakes "where the floor lies below the groundwater table", plus flat ice-scoured basins in weaker granite (Bastemose 109 m; Vættesmose 126 m), most now overgrown to bog. Target lake area ≈0.45% of the land. | Trap 5; Gravesen 2014 (water table a few m down) | [cited] |

## Dimensional relief check (P13/P14) [derived]
At steady state with n=1, channel relief R = (U/K)·χ, where χ = ∫A^-0.5 dx.

I took Hack's law, L = 1.4·A^0.6 in mi/mi² (UNVERIFIED, not read). For a 7 km river from a channel head 150 m below the divide, χ ≈ 4.8 (dimensionless). Rivers of 5 and 9 km give 4.3 and 5.2. The response time is τ = χ/K.

| rock | K (yr⁻¹) | U for R = 160 m | R at U = 5 m/Myr | τ |
|---|---|---|---|---|
| granite | 2.5e-7 | 8 m/Myr | 100 m | 19 Myr |
| granite | 2e-8 | 0.7 m/Myr | 1,200 m | 240 Myr |
| volcanic | 2e-6 | 67 m/Myr | 12 m | 2.4 Myr |
| mudstone | 2e-5 | 0.67 mm/yr | 1 m | 0.24 Myr |

Fennoscandian tors erode at 0.8–7.7 mm/kyr, i.e. 0.8–7.7 m/Myr (Jansen et al. 2019) [cited]. With U₀ ≈ 5e-6 m/yr and K_granite ≈ 2.5e-7 yr⁻¹:
- Granite highs come out at about 100–200 m and sedimentary ground at a few m. That matches Bornholm, with its high basement in the N and centre and low sedimentary S.
- τ ≈ 20 Myr, so run at least 3τ (≈60 Myr). The implicit scheme allows this in a few long steps.

Hillslope relief over a 75 m cell is U·L²/(2D) ≈ 3 m (D = 5e-3 m²/yr).

After the ice left (~16 ka), creep moves material over about √(D·t) ≈ 9 m, which is less than one cell. So the postglacial surface is the glacial surface plus till. Trap 5 agrees: "since the glaciers scraped the granite surface, weathering has not substantially changed the landforms".

Real Bornholm relief is inherited, not a steady state: there was Late Cretaceous uplift and erosion along the Sorgenfrei–Tornquist Zone (Trap). The steady-state run is a defensible [design] that reproduces the observed relief.

Order of stages:
1. Fluvial/tectonic steady state (U, K, D).
2. Ice-sheet areal scour on the joint zones (Herman's law, or an [design] depth ≤ tens of m from Jansen et al.).
3. Till blanket ≤6 m.
4. Water balance decides the lakes.

## Checks for Main
- Sources I could not open: Harel 2016 full text (403), Roering 1999 (scanned PDF), the Hack 1957 constants and Braun & Willett 2013 (not read).
- The `perm`→K change breaks water.ts:90. The `drift`, `ore` and `flint` changes touch ground.ts, flora.ts:314 and world.ts:571–574.
