# Rule audit: the findings by file (2026-10-11)

Ten read-only readers went through every line of src/sim and src/terrain against the standard of docs/research/fire-constants.md. Their reports follow as written, by file. Line numbers are as of commit 0db366d. The summary, grouped by what each rule stands in for, is docs/research/rule-audit.md.


## src/sim/physics.ts lines 1 to 800, src/sim/materials.ts

## Audit: src/sim/physics.ts:1-800, src/sim/materials.ts (full)

Standard applied: outcomes follow from physical formulas whose constants are measured and cited (the `docs/research/fire-constants.md` model, where every value carries an R-number or is marked `[design]`/`[gap]`/`[derived]`). I verified that `docs/research/` contains only `fire-constants.md`, `learning-round5.md`, `README.md`, `briefs/`, `generator/`, `artbook/`, `learning-round3/`: **there is no research doc for any mechanical property** (hardness, toughness, fracture, wear, cordage, food spoilage, load carriage). So every mechanical constant below is uncited by construction, not merely uncommented.

Note on dice: there are **no `Math.random()` rolls deciding physical outcomes** in this range. The single use is `physics.ts:190` (`e.heading ?? Math.random() * Math.PI * 2`) choosing which side of a headingless thing to place something: cosmetic, not flagged. The violation pattern here is category switches, hp pools, fixed tick timers, and uncited ramps.

---

### PHYSICS findings

#### P1: `THING_MATERIAL`: a name-keyed hp/toughness/breaks table for every thing in the world
`src/sim/materials.ts:66-82`; consumed at `src/sim/physics.ts:493, 498-501, 528-529`
```ts
export const THING_MATERIAL: Record<string, { toughness: number; hp: number; flammable: number; breaks: Record<string, number> }> = {
  tree: { toughness: 0.55, hp: 100, flammable: 0.5, breaks: { log: 2, stick: 2 } },
  boulder: { toughness: 0.85, hp: 120, flammable: 0, breaks: { stone: 3 } },
  ...
```
**Why it's a high-level rule.** The thing's *name* selects its strength, its total "health", and exactly what it turns into. A tree is not strong because it is wood of some diameter; it is strong because the string `"tree"` maps to `0.55`. Every tree in the world has 100 hp and yields 2 logs + 2 sticks regardless of its diameter, species, age, or whether `t.size` says it is a sapling or a giant: even though `gathered()` (physics.ts:362) and `pieceOf()` already derive real piece dimensions and moisture from the standing thing. `flammable` here is a second, parallel fire model that the rebuilt combustion path does not use.
**Replacement physics.** Felling is fracture: the cumulative work a blow series must deliver equals the specific work of fracture of the material times the area severed, `W = G_c · A`, with `A` from the trunk's own cross-section (diameter is already known): so "hp" becomes an energy in joules that scales as `d²` for free. Toughness becomes measured fracture toughness / work of fracture (wood ~ 20-120 kJ/m² across and along grain; granite ~ 0.1 kJ/m²). Yield becomes mass conservation: trunk + branch biomass from the species allometry `fire-constants.md` sec. 19 already carries (branch and foliage mass vs DBH from iLand), divided by the piece masses `fuel.ts` already defines.
**Sources.** USDA Wood Handbook FPL-GTR-190 (strength, toughness, density by species); rock fracture-mechanics tables for K_Ic; the existing sec. 19 allometry for yields.
**Impact: high** (felling, gathering, the whole wood economy). **Effort: large.**

#### P2: Butchery yields are fixed per animal name
`src/sim/materials.ts:75-82`; consumed at `src/sim/physics.ts:528-533`
```ts
  deer: { toughness: 0.1, hp: 30, flammable: 0, breaks: { meat: 3, hide: 1, bone: 2, fat: 1 } },
  rabbit: { toughness: 0.05, hp: 6, flammable: 0, breaks: { meat: 1, hide: 1 } },
```
**Why.** Every deer yields exactly 3 meat / 1 hide / 2 bone / 1 fat and dies to 30 points of damage, whatever its mass, age, or season. `fat: 1` in particular is a calorie faucet that doesn't vary with the animal's condition, though fat is the main overwinter energy store.
**Replacement physics.** Carcass mass partition: live mass → dressing percentage → lean/fat/bone/hide fractions, each a measured fraction of body mass, with the fat fraction a seasonal state variable the animal carries (energy balance over the year). Lethality is tissue damage from the blow's energy against the struck region, not a shared pool.
**Sources.** Wildlife-biology carcass-composition tables (cervid dressing % ~ 55-60%; hide ~ 7-8% of live mass; seasonal body-fat series for deer).
**Impact: high** (food supply drives hunger, which drives everything). **Effort: medium.**

#### P3: `BASE`: every raw material is unit-free 0..1 props, uncited
`src/sim/materials.ts:34-64` (all 30 entries), with the prop vocabulary at `6-9` and the clamp/quantise at `99-100`
```ts
  stone: { name: "stone", props: { hard: 0.9, heavy: 0.6, toughness: 0.7 }, grain: "shatter", breaks: { sharp_stone: 1 } },
  meat: { name: "meat", props: { edible: 0.3, toxic: 0.3, toughness: 0.1 }, shelf: 1 },
```
**Why.** These numbers are the input to every mechanical formula in physics.ts, and not one has a unit, a source, or a derivation. They are also a *duplicate* substrate: `fuel.ts` already holds `rho, c, k, mmax, d, mass` in SI for the same kinds, cited in `fire-constants.md` sec. 23 and the table at ~1130 (`stone | 2630 | 0.775 | 2.79 ...`). `round()` at materials.ts:99-100 then quantises to 2 dp and clamps to [0,1], so the world's material state is a lattice of hand-chosen hundredths. Several props are also semantically overloaded: `toughness` serves as damage resistance (physics.ts:390), fracture resistance (383-385) and tool durability (407) with three different uncited coefficients (0.3, 0.8/0.5, 0.6).
**Replacement physics.** One measured quantity per prop, in units: `hard` → indentation hardness (HV/MPa) or Mohs; `sharp` → edge radius (µm) and included angle; `heavy` → mass (kg): already in `Phys.mass`; `long` → length (m): already in `Phys`/`Stack.size`; `toughness` → fracture toughness K_Ic (MPa·m^½) or work of fracture (kJ/m²); `insulating` → thermal conductivity k: already in `Phys.k`; `flexible` → Young's modulus E (GPa); `fibrous` → fibre tensile strength (MPa); `edible` → metabolisable energy (MJ/kg); `toxic` → a dose-response (mg/kg vs body mass); `binding` → adhesive/tensile strength of the bond (MPa).
**Sources.** Wood Handbook; CES/Ashby material property tables; USDA FoodData Central for food energy; leather and cordage trade data (sec. 24 of fire-constants already carries leather density/thickness with R135/R136).
**Impact: high** (it is the substrate for every finding below). **Effort: large.**

#### P4: `shelf`: food spoils on a fixed day counter
`src/sim/materials.ts:20` (field), values at `35-43, 59, 64` (berry 3, nut 25, mushroom 1.5, herb 3, fish 1, meat 1, fat 4, grain 40); derived at `src/sim/physics.ts:648`
```ts
  shelf?: number; // days before food spoils
```
**Why.** "Spoils in 3 days" is the canonical fixed timer. Meat left in a January snowbank spoils as fast as meat in August sun; meat smoked bone-dry spoils as fast as fresh; a sealed vessel changes nothing. The world already knows the two variables that actually govern spoilage: `air.ts` gives the thing's temperature and `wetness.ts` gives its water content and `mmax`.
**Replacement physics.** Microbial growth as a rate, not a deadline: a square-root (Ratkowsky) or Arrhenius growth-rate law in temperature, gated on water activity (no growth below a_w ≈ 0.91 for bacteria, ≈ 0.60 for moulds: which is exactly why dried grain keeps and fresh fish does not), integrated as accumulated spoilage; plus lipid oxidation for fat, a separate temperature- and oxygen-driven rate. Smoking and salting then work for the right reason (water activity, antimicrobial phenols), not as new special cases.
**Sources.** Ratkowsky et al. square-root model; ICMSF / predictive-microbiology a_w growth limits; USDA FSIS time-temperature tables.
**Impact: high** (food storage and winter survival). **Effort: medium.**

#### P5: `fuel` ticks and `burns` multiplier: a dead parallel fire model still being written
`src/sim/materials.ts:22-23` (fields), values at `48, 50, 53-57, 59-60`; still assigned by made kinds at `src/sim/physics.ts:661, 737-738, 885`
```ts
  fuel?: number; // ticks of fire it feeds
  burns?: number; // how much hotter than wood it burns
  ...
  charcoal: { ..., fuel: 150, burns: 1.54 },
```
**Why.** "A log feeds 150 ticks of fire" is a fixed, unit-free burn duration: exactly the rule the combustion rebuild replaced with mass, heat of combustion and burn rate. The fields survive and new kinds keep inheriting them (`fuel: soft.fuel` at 661, `fuel: 10`/`fuel: 20` at 737-738), so the obsolete rule is still reproducing.
**Replacement physics.** Already built: `Phys.mass × heat of combustion`, burn rate from `combustion.ts`. `burns: 1.54` for charcoal is already superseded by the cited char yield / density derivation in fire-constants ~1137.
**Impact: medium** (dead-ish, but anything still reading it gets a non-physical answer). **Effort: small** (delete the fields and the assignments; verify no reader is left).

#### P6: `cools`: a hot thing returns to cold on a tick counter
`src/sim/materials.ts:24`; branched on at `src/sim/physics.ts:395`
```ts
  cools?: number; // ticks before a hot thing goes back to what it was
```
**Why.** A fixed timer for cooling, and at physics.ts:395 the *presence* of the field is a category test (`tk.cools && p(tk,"plastic") >= 0.5` ⇒ forgeable). A thin blade and a thick ingot cool alike; ambient temperature and wind don't enter. This sits one line away from `redHot()` (called at 433), which does real core-temperature physics: so the inconsistency is internal.
**Replacement physics.** Lumped-capacitance Newton cooling with a Biot-number check: `τ = ρ c V / (h A)`, with `ρ, c, d` already in `Phys` and `h` from free-convection plus radiation correlations against the ambient `air.ts` gives. Thickness then governs cooling, as it should for forging.
**Sources.** Standard convection correlations (Churchill-Chu); copper ρ/c/k already cited in fire-constants ~866.
**Impact: medium** (gates all metalwork timing). **Effort: small.**

#### P7: `force()`: blow strength as an uncited linear ramp over unit-free props
`src/sim/physics.ts:374-376`
```ts
export function force(tool: Kind, a?: Agent) {
  const skill = a ? level(a.skills.toolwork ?? 0) * 0.04 : 0;
  return (0.25 + p(tool, "heavy") * 0.8 + p(tool, "long") * 0.35) * (1 + skill) * (a && young(a) ? 0.5 : 1);
}
```
**Why.** Five uncited numbers (0.25, 0.8, 0.35, 0.04, 0.5) and a bare-hands floor, producing a dimensionless "force" that is then compared against a dimensionless "toughness". `young(a) ? 0.5` is a binary child/adult switch (`young` = under one year, physics.ts:233) rather than a body-mass curve.
**Replacement physics.** A blow delivers kinetic energy: `E = ½ m v²`, with `m` the tool mass (`Phys.mass`, already in SI) and `v` the head speed from the swinger's arm angular velocity times the lever arm (the tool's own length, already in `Stack.size.len`): so a long heavy tool hits harder for the right reason and a child hits softer by body-mass/strength allometry, continuously. An adult axe blow is ~50-150 J; that is the anchor to calibrate against.
**Sources.** Biomechanics of striking tasks (axe/hammer impact energy measurements); strength-vs-body-mass allometry.
**Impact: high** (feeds every strike outcome). **Effort: medium.**

#### P8: `focus()`: edge concentration as `0.3 + sharp*1.2`
`src/sim/physics.ts:378`
```ts
export const focus = (tool: Kind) => 0.3 + p(tool, "sharp") * 1.2;
```
**Why.** An uncited two-constant line standing in for contact mechanics; it can exceed 1 with no meaning attached.
**Replacement physics.** Stress, not a multiplier: `σ = F / A_contact`, with `A_contact` from the edge radius and included angle; the material fails where σ exceeds its yield or fracture stress. A blunt tool fails to cut because the contact area is large, not because a number is small.
**Sources.** Contact mechanics (Hertz / wedge indentation); measured edge radii for knapped stone (~0.1-1 µm fresh flake) and ground bone/wood points.
**Impact: high.** **Effort: medium.**

#### P9: `strikeDamage()` and the hp pool
`src/sim/physics.ts:390`; applied at `498-501`, read at `524-526`
```ts
export const strikeDamage = (tool: Kind, toughness: number, a?: Agent) => 5 * Math.max(0, force(tool, a) * focus(tool) - toughness * 0.3);
```
**Why.** A game damage formula: an arbitrary `5` scale, an uncited `0.3` resistance coefficient, and a subtractive threshold draining a named-table hp pool. Nothing physical is conserved.
**Replacement physics.** Energy accounting against fracture: each blow's energy (P7) drives crack growth; the target severs when cumulative delivered energy exceeds `G_c · A` (P1). Blows that don't exceed the fracture-initiation threshold do zero *permanent* work: which is what "barely left a mark" (physics.ts:525) should mean, rather than `dmg <= 0.01 && st.progress >= 5`.
**Impact: high.** **Effort: large** (removes the hp system together with P1).

#### P10: `Kind.grain` and `splitDamage()`: anisotropy as a two-value label
`src/sim/materials.ts:19` (`grain?: "split" | "shatter"`), tags at `46, 48, 52-53, 57`; `src/sim/physics.ts:383-385` and the completion threshold at `482`
```ts
  return tk.grain === "split" && eff > p(tk, "toughness") * 0.8 ? 5 * (eff - p(tk, "toughness") * 0.5) : 0;
  ...
  if (st.progress < 20) return { done: false, broke: broke ?? undefined, damage: dmg };
```
**Why.** `grain === "split"` is the textbook category switch: wood splits because it is labelled splittable, not because its strength across the grain is a twentieth of its strength along it. Then three more uncited numbers (0.8, 0.5, 5) and a bare "20 progress = done" finish line.
**Replacement physics.** Orthotropic strength: measured tension-perpendicular-to-grain (~2-5 MPa for most woods) versus parallel (~40-100 MPa) makes splitting easy and cross-cutting hard with no label; a wedge amplifies the splitting force by `1/tan(half-angle)`, so the tool's geometry: not a `grain` tag: decides whether a split propagates. Stone's conchoidal failure falls out of its near-zero tensile strength and isotropic brittleness.
**Sources.** Wood Handbook orthotropic strength tables; mode-I fracture energy for wood (~0.2-0.5 kJ/m² radial).
**Impact: high** (splitting is the main wood-processing route). **Effort: medium.**

#### P11: `heldStrike()`: a five-way outcome-mode switch
`src/sim/physics.ts:394-395`; dispatched at `426-482`
```ts
export const heldStrike = (tk: Kind, over: boolean) =>
  over ? "sparks" : tk.cools && p(tk, "plastic") >= 0.5 ? "forge" : p(tk, "metal") >= 0.8 ? "dent" : tk.grain === "shatter" && tk.breaks ? "knap" : "split";
```
**Why.** One expression picks between five qualitatively different physical processes by testing field presence (`tk.cools`, `tk.breaks`), a category label (`grain === "shatter"`) and three uncited cut-offs (0.5, 0.8). It is better than a name switch, but it is still a rule table deciding what *kind* of physics happens.
**Replacement physics.** A single failure criterion evaluated per blow: compute the contact stress (P8) and compare against the material's yield stress and fracture toughness at its current temperature. Stress above yield with no cleavage path ⇒ plastic flow (forging if hot, denting if cold: the same branch, differing only by homologous temperature T/T_melt). Brittle, isotropic, low K_Ic ⇒ conchoidal flaking. Anisotropic tensile failure ⇒ splitting. The modes stop being enumerated and become regimes of one calculation.
**Impact: medium-high** (it is the dispatcher, so it constrains P9-P14). **Effort: large.**

#### P12: `knapPer()`: flaking as a hardness polynomial with a 10-blow give-up
`src/sim/physics.ts:381`, used at `460-471`; yields from `Kind.breaks` (`materials.ts:45, 52, 57`)
```ts
export const knapPer = (tool: Kind, tk: Kind, skill = 0) => p(tool, "hard") ** 2 * p(tk, "hard") * 0.4 * (1 + level(skill) * 0.08);
  ...
  if (st.progress >= 10) return { done: true, ... `Grit, and nothing broke off.` ... }
```
**Why.** `hard² × hard × 0.4` has no physical reading (hardness squared times hardness?), the `0.08` skill ramp is uncited, the "never within ten" cap is arbitrary, and the flake produced is a fixed table entry (`flint ⇒ 1 flint_blade`) regardless of how the stone was struck. Knapping is the best-measured prehistoric process in the archaeological record and none of it is used.
**Replacement physics.** Hertzian cone initiation plus conchoidal propagation: a flake detaches when the indentation stress field at the platform exceeds the stone's K_Ic; flake mass is a measured function of platform depth (thickness) and exterior platform angle, with blow energy setting how far the fracture runs. That gives variable flake size and a real reason why a soft hammer can't flake flint, instead of a hardness product.
**Sources.** Experimental lithics: Dibble & Rezek (flake mass vs platform depth/exterior angle, controlled-indenter experiments); Cotterell & Kamminga on conchoidal fracture mechanics; Mohs/K_Ic for flint and granite (flint K_Ic ≈ 0.5-1 MPa·m^½).
**Impact: high** (tool-making is the first tech gate). **Effort: medium.**

#### P13: Forging: an exponential sharpness ramp with named output buckets
`src/sim/physics.ts:388, 434-451`
```ts
export const forgeGain = (tool: Kind) => 0.2 * p(tool, "heavy") * p(tool, "hard");
  ...
  const sharp = 1 - (1 - p(cold, "sharp")) * (1 - g) ** st.progress;
  if (g < 0.02) return st.progress < 6 ? ... 
  if (sharp < 0.95 && st.progress < 30) return { done: false, ... };
  name: sharp >= 0.8 ? "metal blade" : sharp >= 0.5 ? "rough metal blade" : "hammered metal",
  props: { ..., heavy: p(cold, "heavy") * 0.7, toughness: 1 - (1 - p(cold, "toughness")) * (1 - g) ** st.progress },
```
**Why.** Eight uncited numbers (0.2, 0.02, 6, 0.95, 30, 0.8, 0.5, 0.7) plus a geometric-decay "sharpness" with no referent, and the product's identity picked from thresholds on that invented number. `heavy * 0.7` silently destroys 30% of the metal's mass: forging conserves mass.
**Replacement physics.** Plastic working: each blow's energy drives plastic strain against the metal's flow stress at the current temperature (copper's flow stress falls by roughly an order of magnitude from cold to red heat), thinning the stock geometrically; the "edge" is the resulting taper, so sharpness is an edge radius that follows from thickness reduction. Work hardening raises flow stress with accumulated strain and is relieved above the recrystallisation temperature: which is exactly why the `redHot` gate at 433 exists and should be the only gate. Mass is conserved; only shape changes.
**Sources.** Hot/cold flow-stress data for copper (Johnson-Cook or hot-working curves); copper recrystallisation temperature; copper ρ/c/k already cited in fire-constants ~866 (R1 for red heat).
**Impact: high** (metallurgy is a major tech gate). **Effort: large.**

#### P14: `dent`: four blows, by fiat
`src/sim/physics.ts:452-455`
```ts
      if (++st.progress < 4) return { done: false, broke: broke ?? undefined, damage: 0 };
```
**Why.** A fixed blow count to reach a fixed cosmetic result.
**Replacement physics.** Plastic indentation depth per blow from the material's indentation hardness (`depth ∝ E_blow / (H · A)`); "only dented" needs no branch at all: it is what happens when the fracture criterion is never met (P11).
**Impact: low.** **Effort: small** (falls out of P11).

#### P15: `wear()`: tool decay and bare-hand injury as uncited per-blow decrements
`src/sim/physics.ts:398-412`
```ts
    a.needs.health = Math.max(0, a.needs.health - hardness * 0.35);
  ...
  s.hp -= (0.004 + hardness * 0.012) * (1.5 - binding * 0.6) * (1.1 - p(t, "toughness") * 0.6);
  if (s.hp > 0) return null;
  ...
  const parts = (t.parts ?? []).filter((id) => p(kind(w, id), "binding") < 0.6);
```
**Why.** Six uncited coefficients (0.35, 0.004, 0.012, 1.5/0.6, 1.1/0.6) draining an abstract tool `hp`, with failure at exactly zero and the surviving parts chosen by a `binding < 0.6` cut-off. "hp -1 per use" in continuous clothing. Bare-hand injury scales off the target's unit-free hardness.
**Replacement physics.** Two distinct processes: (a) edge dulling is abrasive wear: Archard's law, `V = K · F · s / H`, so removed volume (and hence growing edge radius) follows from load, sliding distance and hardness, all available; (b) catastrophic failure is fatigue or overload: the lashing parts when the blow's impulse exceeds the cordage tensile strength times turns (capstan friction), and a haft breaks by bending stress exceeding modulus of rupture, with repeated sub-critical loading accumulated by a Miner's-rule / S-N count. Bare-hand injury is contact pressure against skin and bone tolerance, i.e. the same stress calculation as P8 pointed at tissue.
**Sources.** Archard wear coefficients; Wood Handbook modulus of rupture; cordage/natural-fibre tensile strength data; hand impact-injury tolerance literature.
**Impact: medium-high** (tool economy and the pressure to re-make tools). **Effort: medium.**

#### P16: Bark peeling: a per-blow ramp and a hard cap of 3
`src/sim/physics.ts:505-514`
```ts
    const peel = 0.08 * p(tool, "sharp"), blow = st.progress + 1;
    if (p(tool, "sharp") >= 0.4 && (target.bark ?? 0) < 3 && Math.floor(blow * peel) > Math.floor((blow - 1) * peel)) {
```
**Why.** `0.08`, the `0.4` sharpness gate and the `< 3` cap are all invented; a mature tree and a sapling give the same three sheets forever. (The moisture of the bark that drops *is* cited: sec. 27f: so the surrounding line is fine.)
**Replacement physics.** Area: bark removed per stroke = blade width × stroke length; total available bark = trunk circumference × bark-bearing height ÷ sheet area, so the cap is geometry and scales with the tree. Whether it peels in strips at all is the bark-to-cambium shear/adhesion strength, which is strongly seasonal (bark slips during spring sap flow and resists when dormant): a real seasonal effect replacing a fixed number.
**Sources.** Forestry bark-adhesion / peeling-season literature; bark thickness as a fraction of DBH by species.
**Impact: medium.** **Effort: small-medium.**

#### P17: The felled tree becomes a stump with four magic numbers and a 6-day expiry
`src/sim/physics.ts:535`
```ts
  if (t.kind === "tree") { setKind(w, t, "stump"); t.hp = 40; t.maxHp = 40; t.size = 0.6; t.until = w.t + DAY * 6; mark(w, t); enrich(w, t.px, t.py, -0.02); }
```
**Why.** Four hardcoded outcomes from one named-kind branch: every stump is the same size and strength whatever tree stood there, vanishes after exactly 6 days (a stump persists for decades), and debits the soil a flat `-0.02` regardless of how much biomass left the site.
**Replacement physics.** Stump diameter and mass are the trunk's own base dimensions, already known; its fracture resistance is the same `G_c · A` as P1. Persistence is decomposition kinetics: coarse woody debris loses mass at a first-order rate `k` per year that is itself temperature- and moisture-driven (both already modelled), giving decades not days. The soil debit is the nutrient actually exported: nutrient concentration (% N, P, K of wood and bark) times the mass carried off, so felling a big tree costs the site more than felling a sapling.
**Sources.** Coarse-woody-debris decay-constant literature (`k` ≈ 0.01-0.1 /yr by species and climate); foliar/wood nutrient-concentration tables.
**Impact: medium** (soil, regrowth, landscape memory). **Effort: medium.**

#### P18: `sparksPer()` / `throwsSparks()`: spark production from hardness, when the real variable is chemistry
`src/sim/physics.ts:549-550`, used at `562-568`
```ts
export const throwsSparks = (tool: Kind, tk: Kind) => p(tool, "hard") >= 0.8 && p(tk, "hard") >= 0.8 && tk.grain === "shatter";
export const sparksPer = (tool: Kind, tk: Kind) => 0.12 * (1 + Math.max(0, Math.max(p(tool, "hard"), p(tk, "hard")) - 0.9) * 40);
```
**Why.** Three uncited numbers (0.12, 0.9, 40: a 40× ramp off a 0.9 knee) plus a hardness-and-label gate, and a separate 4-blow "threw no sparks" cut-off at 562-564. Physically this is the wrong variable: hardness does not make sparks. Flint on flint: two very hard `shatter` stones, which this function rewards most: throws essentially nothing usable. Sparks come from detaching a particle that *oxidises exothermically*: iron pyrite/marcasite, or steel. The catching side of this act is properly cited (`sparkCatches`, sec. 10), which makes the production side's lack of grounding stand out.
**Replacement physics.** Two stages. (1) Particle detachment: abrasion of the pyrite/steel member by the harder, sharper member, giving particle mass from the wear law (P15). (2) Ignition power: the particle self-heats by oxidation (iron/iron-sulfide oxidation enthalpy against the particle's own `ρ c` and surface losses), reaching a temperature and lifetime that `combustion.ts` can already consume as a hot-particle ignition source against the cited tinder limit. The gate becomes "does either member oxidise exothermically when divided": a composition property: not "are both hard".
**Sources.** Babrauskas, *Ignition Handbook* (hot-particle and friction-spark ignition); experimental archaeology on pyrite/marcasite strike-a-lights; iron sulfide oxidation enthalpies.
**Impact: high** (fire-making is the keystone tech, and this is the one uncited link in an otherwise cited chain). **Effort: medium.**

#### P19: `GALE = 8` (acknowledged gap)
`src/sim/physics.ts:551-554`
```ts
export const GALE = 8;
export const sparkCatches = (m: number, wind: number) => m <= DAMP && wind <= GALE;
```
**Why.** A hard wind cut-off that switches spark fire-making off. **Partially excused**: `fire-constants.md` sec. 10 explicitly states "The gale that carries sparks off has no cited value; keep the sim's current one and mark it a gap." So it meets the *disclosure* standard but not the physics standard, and the code comment points at `sim.ts CONDITIONS` rather than at the gap note. Also reused as a perception threshold at `physics.ts:591`.
**Replacement physics.** Particle transport: a spark of known mass and diameter falls at its terminal velocity over the strike height; wind displaces it laterally by `v_wind × t_fall`, and it misses if that exceeds the lay's radius. All inputs come from P18's particle and the lay's geometry, so the hard cut-off becomes a continuous probability of landing in the tinder.
**Impact: medium** (switches a whole technique on/off by weather). **Effort: small.**

#### P20: `frictionPer()`: friction fire as a per-tick heat accumulator with a bow boolean
`src/sim/physics.ts:596`, used at `671-694`
```ts
export const frictionPer = (bow: boolean, skill: number) => (bow ? 0.11 : 0.05) * (1 + level(skill) * 0.1) - 0.015;
  ...
    if (st.progress >= 60 || st.heat >= 1) { ... `made them hot.` ... }
```
**Why.** `0.11` vs `0.05` as a bow/no-bow switch, a `0.1` skill ramp, a `0.015` flat loss term, an abstract `heat >= 1` ignition point and a 60-tick give-up. None of the inputs are physical, yet this is a heat-transfer problem the project already has every constant for.
**Replacement physics.** Frictional heating: `P = µ · F_n · v` at the drill tip, against conduction into both woods (`k, ρ, c` for each species already in `Phys`, cited sec. 23/1130) and convective loss to `air.ts`; the socket ignites when the dust in it reaches the pyrolysis/char temperature (~300 °C, and sec. 29c already carries the charring condition). A bow stops being a boolean and becomes higher `v` and steadier `F_n` than hand-spinning; wood-pair choice matters because `k` and `ρ` differ by species; a damp spindle fails because `wetness.ts` moisture raises the energy needed, as `fire-constants` Eq. 7 already does for lighting.
**Sources.** Friction coefficients for wood-on-wood; wood pyrolysis/char onset temperature (already cited); the existing `Phys` thermal table.
**Impact: high** (the main fire-starting route). **Effort: medium.**

#### P21: `rubbing()`: a mode cascade with fixed tick durations
`src/sim/physics.ts:609-619`
```ts
  if (fat && hide && fat !== hide) return { does: "leather", fat, hide, ticks: 10 };
  if (p(soft, "seed") >= 0.5 && p(soft, "hard") >= 0.25 && p(soft, "edible") > 0 && p(soft, "long") < 0.3 && p(harder, "hard") >= 0.8 && soft !== harder) return { does: "grind", soft, harder, ticks: 12 };
  if (p(harder, "hard") - p(soft, "hard") >= 0.35 && p(soft, "long") >= 0.5 && p(soft, "sharp") < 0.5 && soft.verb !== "rub") return { does: "point", soft, harder, ticks: 10 };
  ...
  return { does: "nothing", ticks: 6 };
```
**Why.** Eleven property cut-offs, none derived, select which of four processes occurs, and each carries a flat duration (10/12/10/6 ticks) with no physical basis: grinding a handful of grain and grinding a bushel take the same time. `soft.verb !== "rub"` is worse than a property test: it is a *provenance* test, excluding things by how they were made so an already-pointed stick can't be re-pointed.
**Replacement physics.** All three "rub" processes are material removal or transport, so duration comes from a rate, not a constant: grinding and pointing from the abrasive wear law (`V = K F s / H`, P15): the act ends when the removed volume equals the volume that must go (the cone for a point, the comminution work for meal), which also makes "already pointed" fall out naturally with no provenance check. Hide softening is fat penetration plus mechanical fibre separation: a diffusion/uptake time scaling with hide thickness (cowhide ~5 mm, deerskin ~1-1.4 mm: already cited, R136) and fat viscosity.
**Sources.** Archard wear coefficients; comminution energy (Bond/Rittinger) for grain milling; existing leather thickness data (R135/R136).
**Impact: medium-high.** **Effort: medium.**

#### P22: Grinding adds 40% nutrition and halves shelf life
`src/sim/physics.ts:648`
```ts
      name: `ground ${soft.name}`, props: { edible: clamp01(p(soft, "edible") * 1.4), toughness: 0.01 }, parts: [soft.id], verb: "rub", shelf: Math.round((soft.shelf ?? 10) / 2),
```
**Why.** Grinding creates energy out of nothing (`× 1.4`) and halves spoilage by fiat (`/ 2`). Also silently drops every other prop the grain had.
**Replacement physics.** Milling doesn't change the energy content; it changes the *digestible fraction*: measured digestibility of whole versus milled grain is the right quantity, and it rises for a real reason (endosperm accessibility, faster starch gelatinisation when cooked). Faster spoilage follows from the surface-area increase: oxidation and microbial rates scale with exposed area, so a finer meal spoils faster inside P4's rate model rather than by a divided constant.
**Sources.** Food-science digestibility of whole vs milled cereals; lipid-oxidation rate vs particle surface area (why wholemeal flour goes rancid).
**Impact: medium** (nutrition economy). **Effort: small** (given P4).

#### P23: Pointing adds a flat +0.4 sharpness, -5% length
`src/sim/physics.ts:661`
```ts
      name: `pointed ${soft.name}`, props: { ...soft.props, sharp: clamp01(p(soft, "sharp") + 0.4), long: p(soft, "long") * 0.95 }, parts: [soft.id], verb: "rub", fuel: soft.fuel,
```
**Why.** A fixed sharpness bonus and a fixed length tax, independent of the abrasive, the time spent, or the stock's size. Combined with the `soft.verb !== "rub"` guard (P21), sharpness is a one-shot step, not a continuum.
**Replacement physics.** Sharpening removes a cone of material: the resulting edge/tip radius follows from the included angle achieved and the abrasive's grit size (finer grit ⇒ smaller radius ⇒ `focus` in P8 rises for a real reason); the length lost is exactly the removed cone's height, so mass is conserved. Re-pointing a blunted tip is then the same calculation applied again.
**Sources.** Abrasive grit-size vs achievable edge radius data; Archard again for the removal rate.
**Impact: medium.** **Effort: small.**

#### P24: `joining()`: a recipe cascade that invents the product's properties by arithmetic
`src/sim/physics.ts:707-790`: recipe gates at `712-717` (lamp), `715-716, 727` (sealed basket), `734-738` (cord vs mat by part count), `745-748` (sheet/head/handle roles); hand-written props at `719-721, 728-729, 737-738, 754, 760-764, 767-777`
```ts
      ? { name: `twisted ... cord`, props: { binding: 0.85, flexible: 0.9, fibrous: 0.6, long: 0.5, flammable: 0.7, toughness: 0.3 }, ... fuel: 10 }
      : { name: `woven ${parts[0].name} mat`, props: { container: 0.5, insulating: 0.6, fibrous: 0.8, ... }, ... fuel: 20 } };
  ...
        props: { container: clamp01(0.45 + p(sheet, "flexible") * 0.3), ... toughness: Math.min(p(sheet, "toughness") + 0.1, p(binder, "binding")) },
  ...
          insulating: clamp01(Math.max(...sheets.map((x) => p(x, "insulating"))) + 0.08 * sheets.length), ...
  ...
        heavy: clamp01(rest.reduce((t, x) => t + p(x, "heavy"), 0) * 0.9),
        flammable: parts.reduce((t, x) => t + p(x, "flammable"), 0) / parts.length,
        toughness: Math.min(p(headK, "toughness"), p(handle, "toughness") + 0.2, p(binder, "binding")),
```
**Why.** This is the crafting tree, and it is entirely a recipe table: part *configurations* are recognised by property gates (`container >= 0.6 && hard >= 0.5` ⇒ lamp body; `binding >= 0.9 && fibrous < 0.3` ⇒ sealant; 2 fibrous things ⇒ cord, 3+ ⇒ mat) and each branch then *asserts* what the result is like with roughly twenty uncited numbers. Several are physically wrong in kind, not just in value: mass is multiplied by `0.9` (joining destroys 10% of the matter); layered insulation grows by a flat `+0.08` per sheet rather than by additive thermal resistance; flammability is an unweighted mean of a unit-free number rather than a mass-weighted composition: and `fuel.ts mix()` (used by `ensure()` at `materials.ts:111-113`) already does mass-weighted composition correctly for `phys`, so the right machinery exists one function away and the props path ignores it.
**Replacement physics.** A joint is a mechanical connection with a computable strength: the lashing holds while the moment the head exerts on the haft stays below the cord's tensile strength times the number of turns and the capstan friction factor; that single calculation decides whether a hafted tool exists, how hard it can be swung, and when it fails (feeding P15). The product's other properties follow by conservation and composition: mass additive exactly; thermal resistance of layers additive as `Σ(t_i / k_i)` (so two hides really are warmer than one, by R-value, and a thick hide beats two thin ones); container volume from the sheet's area by folding geometry; strength of the assembly as the weakest load path, computed, not `Math.min(a, b + 0.2, c)`.
**Sources.** Natural-fibre cordage tensile strength (flax/nettle/sinew, MPa); capstan equation; Wood Handbook for haft bending; ASHRAE/measured R-values and `k` for hide and fibre batting (hide `k` already in fire-constants sec. 24).
**Impact: high** (every tool, container and garment in the game). **Effort: large.**

#### P25: The `depth >= 2` join cap, with text that asserts the cause
`src/sim/physics.ts:731-733` (and `depth()` at `materials.ts:126-127`)
```ts
  } else if (parts.some((x) => depth(w.kinds, x) >= 2)) {
    // ponytail: two levels of tying (fiber > cord > tool) covers every tool so far; lift when a real need shows up.
    return decided({ text: `Nothing more would stay tied onto the ${parts.find((x) => depth(w.kinds, x) >= 2)!.name}.`, fields });
```
**Why.** A combinatorial-depth counter caps technology, and the player-facing text *states a physical cause* ("nothing more would stay tied") that no physics produced: the exact failure mode the fire rebuild avoided (sec. 32: "Neither text names a cause"). To its credit the shortcut is labelled in-code.
**Replacement physics.** Delete the counter; whether another part stays on is P24's joint-strength calculation. Complex assemblies then fail when they are actually too weak or too heavy, and the text can describe the observed failure (the lashing slipped) instead of asserting a rule.
**Impact: medium** (caps the tech tree). **Effort: medium** (falls out of P24).

#### P26: Property-threshold classifiers with uncited cut-offs, plus one id-string test
`src/sim/physics.ts:19-22` (`greasy`, `airy`, `skin`, `sticky`), `104-105` (`isFlame`, `isLamp`), `585` (`isBow`), `745` (`soft`), `712-716` (lamp/sealant roles), `261` (`food`)
```ts
export const greasy = (k?: Kind) => !!k && p(k, "edible") >= 0.1 && p(k, "flammable") >= 0.7;
export const airy = (k?: Kind) => !!k && p(k, "flexible") >= 0.5 && p(k, "container") >= 0.5; // can pump or fan air
const skin = (k?: Kind) => !!k && !k.parts?.length && p(k, "flexible") >= 0.5 && p(k, "insulating") >= 0.5 && p(k, "fibrous") < 0.6;
...
export const isFlame = (k?: Kind) => !!k?.id.startsWith("burning:");
export const isBow = (k?: Kind) => !!k && p(k, "flexible") >= 0.8 && p(k, "long") >= 0.5 && p(k, "binding") >= 0.5;
```
**Why.** These are the project's better pattern: behaviour keyed to properties, not names: and the file header says as much (line 18). But every cut-off (0.1, 0.5, 0.6, 0.7, 0.8, 0.9) is a hand-picked number on a unit-free axis, and `skin` additionally tests `!k.parts?.length`, i.e. *how the thing was made*. `isFlame` is a genuine name check: it matches on an id string prefix.
**Replacement physics.** Each classifier should dissolve into the physical condition it stands for: a wick works when capillary rise in the fibre supplies fuel at least as fast as it burns (Washburn equation against the already-cited 8 g/h, sec. 22b); something is a bellows when its volume change per stroke delivers the air flow the fire needs; a bow is usable when its stored elastic energy at a safe draw (from `E` and section modulus) suffices to drive the spindle; "burning" should be a state flag on the stack, not an id prefix.
**Impact: medium** (gates several techs). **Effort: medium.**

#### P27: `carryOf` / `CARRY`: carrying capacity in item slots
`src/sim/physics.ts:204, 233, 236-237`
```ts
export const CARRY = 16;
const young = (a: Agent) => clock.t - a.born < YEAR;
export const carryOf = (w: World, a: Agent) =>
  (young(a) ? 8 : CARRY) + Math.max(0, ...a.inv.map((s) => { const k = w.kinds[s.k]; return p(k, "container") >= 0.6 && p(k, "flexible") >= 0.4 ? Math.round(p(k, "container") * 10) : 0; }));
```
**Why.** A slot count: sixteen logs weigh the same as sixteen berries, a child carries exactly half, and a bag adds `round(container * 10)` slots from a unit-free number. `Phys.mass` is available for every stack, so real load is already computable.
**Replacement physics.** Two independent limits, both measured: mass (sustainable human load is a fraction of body mass: roughly 30-45% for extended carriage, with speed and energy cost rising as the fraction grows, which also couples carrying to the existing energy need) and volume (bag capacity in litres against the pieces' own volumes from `Phys.d`/`size`). A child's limit follows from body mass, not a branch.
**Sources.** Load-carriage literature (Pandolf/Soldier-load energy-cost equations; ILO/ergonomic load limits).
**Impact: medium** (gathering throughput and travel). **Effort: medium-large** (touches inventory call sites broadly).

#### P28: `DURATION`: fixed tick counts for whole classes of act
`src/sim/physics.ts:217-218`
```ts
export const DURATION: Record<string, number> = { join: 8, heat: 8, wet: 10, shape: 6, place: 3, plant: 3, pour: 2, wear: 2 };
```
**Why.** Eight uncited constants keyed by verb name; lashing a tiny point and lashing a log take the same eight ticks, heating a berry and heating a 10 cm stone the same eight. The comment itself admits strike/rub/throw/dig already "go blow by blow until done": so the physical pattern exists and these verbs simply weren't converted.
**Replacement physics.** Each act ends when its own process completes: `heat` from the thermal model already in place (the thing reaches its target core temperature: the sec. 29g targets are cited right below, at line 797-800); `pour` from efflux through the vessel mouth (Torricelli, `v = √(2gh)`, times aperture area); `shape` from material removal rate (P21); `join` from the number of turns the lashing needs for P24's required strength; `place`/`plant`/`wear` from measured human task times.
**Impact: medium** (planning look-ahead and time economy). **Effort: medium.**

#### P29: `MADE_OF`: a name→material table duplicating composition
`src/sim/materials.ts:84-88`
```ts
export const MADE_OF: Record<string, string> = {
  tree: "log", stump: "log", burnt_stump: "charcoal", bush: "stick", ... boulder: "stone", ... grass: "fiber", clay: "clay",
```
**Why.** Eighteen named world things mapped by string to a material kind. Mostly used to answer "what is this like", but it is a second source of truth beside `Phys`, and it encodes outcomes (`burnt_stump: "charcoal"` asserts a combustion result that `combustion.ts` should produce).
**Replacement physics.** A thing's material is its composition, which `fuel.ts`/`Phys` already models and `mix()` already combines by mass; derive the answer from that and delete the table.
**Impact: low-medium.** **Effort: small.**

#### Smaller items in range (grouped)
- **`physics.ts:495-497`: reach as a binary and an altitude cut-off.** `const long = p(tool, "long") >= 0.6 ? 1 : 0;` and `target.alt > 2`. A tool either grants exactly one extra metre of reach or none; a flying animal is unreachable past a fixed altitude. Replace with actual tool length (`Stack.size.len`, in metres) plus arm reach, compared continuously against the target's distance and height. *Impact: low-medium. Effort: small.*
- **`physics.ts:49-52`: `usual()` lay with hardcoded moistures.** `{ phys: PHYS.fiber, n: 1, m: 0.06 }, { ... m: 0.12 }` and `sticks = 5, logs = 2`. As the reference lay for the `tooThick`/`breeze` derivations this is legitimately `[design]` and documented (sec. 32). But `fireOf()` (line 52) uses the same fixed moistures to create **real fires in the world**, bypassing `wetness.ts`. Scenario/seed fires should take the moisture of the pieces where they actually stand. *Impact: medium. Effort: small.*
- **`physics.ts:361`: `LYING: { stick: true, fallen_log: true }`.** A name table deciding which gathered things dried on the ground. Should follow from the thing's own geometry/position (is it in ground contact?), which `wetness.ts` already distinguishes. *Impact: low. Effort: small.*
- **`physics.ts:190-195`: `beside()` fixed turn list.** `[0, 0.8, -0.8, 1.6, ...]` plus a random heading fallback. Placement search, effectively plumbing; noted only for completeness. *Impact: low. Effort: small.*
- **Skill as a flat multiplier on physical outcomes**: `physics.ts:375, 381, 460, 596, 671` (`level(skill) * 0.04 / 0.08 / 0.1`, with `level` = `min(10, floor(sqrt(xp/10)))` at `world.ts:395`). Practice legitimately changes outcomes, but it should act through the physical variable it actually changes (blow placement, angle, velocity, consistency), not as a percentage bonus on a dimensionless result. *Impact: medium. Effort: medium.*
- **`materials.ts:99-100`: `round()` clamps and quantises every prop to [0,1] at 2 dp, dropping anything ≤ 0.01.** A symptom of P3 rather than a separate rule: real physical quantities span orders of magnitude and cannot live on this lattice. *Impact: low alone. Effort: small (subsumed by P3).*
- **`materials.ts:123`: unreachable code.** `return name.split(" ").at(-1)!;` after the `return` on line 122. Not a rule; dead line, worth deleting. *Impact: none. Effort: trivial.*

---

### BEHAVIOUR bucket (agent/social; listed briefly per the contract)
- `physics.ts:258-271` `makeRoom()`: what an agent sheds when its hands are full: `food = edible >= 0.1`, "keep one of each", tool-ness ordering, hungry-hand priority. Inventory policy, not world physics.
- `physics.ts:587-592` `WEATHER_NOW`: the condition *words* agents use (`cold` = `feels < 0`, `wind > GALE`, `dark` = `bright < DARK`). These label perceptions for beliefs; they don't decide outcomes. `cold`'s 0 °C and the `GALE` reuse are still arbitrary perception thresholds.
- `physics.ts:148-158` `firstHeld` / `Chooser`: which held item an agent picks for a lay; explicitly delegated to theories in sim.ts.
- `physics.ts:171-175` `hoursToDawn`: a 0.5-hour-step look-ahead loop used for planning.
- `physics.ts:206-215` `Outcome.ruled` ("decided by a Jev ruling, not the physics rules") and `joining() → "ask"` (`741`): the explicit escape hatch to an LLM ruling when the rules can't decide. Worth noting: every `"ask"` is a place where no physics exists yet.
- `physics.ts:214` `later` field: deferred results (a planted seed); scheduling, not a rule.

---

### ALREADY PHYSICAL (in these ranges, meeting the standard)
- **Bed air**: `physics.ts:33-36` `bedAir()`: composes `air.ts` temp/wind, `rain.ts` rain, canopy and the sec. 14a vegetation height. Cited.
- **Fire output and duration**: `physics.ts:39-41` `fireOutput`/`fireHours`/`ablaze`: delegate wholly to `combustion.ts`; no local constants.
- **`STILL` reference air**: `physics.ts:60`: the island's median 10 °C and sec. 14a veg, cited to sec. 25/32.
- **`tooThick()`**: `physics.ts:77-86`: derived by *running* the combustion model (does a piece catch before the reference lay's flame is spent) instead of tabulating a thickness. Exemplary.
- **`breeze()`**: `physics.ts:90-100`: derived by bisecting the wind at which the bed's radiation falls below `LEAST`. Exemplary.
- **Carried flame**: `physics.ts:101-102, 123-147`: `HELD` 1 m, `LAMP_FLAME` 0.042 m (R10, sec. 14b), `WICK` 8 g/h (sec. 22b), and `carry()` burning a brand down through `combustion.advance`, leaving the piece as far as it burnt (sec. 27e).
- **`laidOf()` / `brandOf()`**: `physics.ts:63-74, 116-119`: real `Phys`, moisture and burnt-down mass per piece, cited to sec. 27e.
- **`madeOf()` water inheritance**: `physics.ts:339-350`: mass-weighted water, capped at `mmax`, charcoal dry out of a smothered fire (sec. 27e/27f).
- **`gathered()`**: `physics.ts:359-371`: green water by species, dead-fuel moisture by thickness and lying/standing, `LIVE_HERB` for reeds (R30): all cited to sec. 27f, 25c. (Its `LYING` name table is the one flaw, noted above.)
- **`splitWater` use at `physics.ts:485`**: split pieces take the heart's water on cut faces (sec. 27 skin/heart model).
- **`sparkCatches` / `emberCatches` moisture limits**: `physics.ts:554, 597` via `wetness.ts:22`: 10% and 13% MC, derived from NFDRS P(I) with full reasoning in sec. 10. The `GALE` term is the sole gap, and it is declared.
- **`redHot` gate at `physics.ts:433`** and the sec. 29g target-temperature block beginning at `797-800` (water boils R36, food cooks R50, resin runs sec. 24, clay fires R55, copper at red heat R1, copper reduces R48): fully cited, immediately below the audited range.

---

### Cross-cutting observation
The single highest-leverage fix is not any one finding: it is that `materials.ts` `Props` is a **unit-free duplicate** of data `fuel.ts` `Phys` already holds in SI with citations. `Phys` carries `rho, c, k, mmax, d, mass` per kind, sourced in `fire-constants.md` sec. 23 and the table at ~1130; `Props` re-states `heavy`, `long`, `insulating` as 0..1 numbers, and every mechanical formula in physics.ts reads the unit-free copy. Adding the *missing* mechanical quantities to `Phys` (hardness, yield stress, fracture toughness/work of fracture, orthotropic strength ratio, elastic modulus, metabolisable energy) and routing `force`/`focus`/`strikeDamage`/`splitDamage`/`knapPer`/`wear`/`joining` through it would collapse P1, P3, P7-P15, P21-P24 into one substrate migration, and would need one new research doc on the model of `fire-constants.md`: call it `mechanics-constants.md`: covering hardness, fracture, wear, cordage and the wood strength tables.

## src/sim/physics.ts lines 800 to end

## Audit: src/sim/physics.ts lines 800-1593

Read in full (800-1593). Findings below are world physics; agent/social heuristics are in the behaviour bucket; the cited-physics parts are listed last.

---

### PHYSICS FINDINGS

#### P1. Food shelf life is an integer timer attached at creation: lines 846, 872, 879, 989
```ts
846:  parts: fields.inputs, verb: "heat", shelf: 3, phys: mix(...)            // stew
872:  parts: [x.id], verb: "heat", shelf: (x.shelf ?? 1) * 8 + 6,             // smoked
879:  parts: [x.id], verb: "heat", shelf: dough ? 5 : (x.shelf ?? 1) * 2 + 1, // cooked / bread
989:  name: "dough", props: {...}, parts: [x.id], verb: "wet", shelf: 1,
```
**Why it's a rule:** "spoils in N days" with hand-picked arithmetic (`*8+6`, `*2+1`, flat 3, flat 5, flat 1). Smoking's eight-fold keep is a designer's guess, not a measured effect, and the base `shelf` values it multiplies (materials.ts:35-40: berry 3, nut 25, fish 1, meat 1) are themselves uncited.
**Replacement physics:** spoilage as a rate, not a date. Microbial growth rate µ(T, a_w, pH): Gompertz/Baranyi growth with a Ratkowsky square-root temperature term: integrated against the item's own stored temperature/moisture history (the wetness/air systems already carry both). Smoking and cooking act through the same model: drying lowers water activity a_w (drop below ~0.90 stops most spoilage bacteria), heat sterilises by log-reduction kinetics (D/z values), and smoke deposits phenols/formaldehyde that extend lag phase. Source kind: food-microbiology predictive models (ComBase / IFT thermal-process tables) and a_w vs. shelf-life tables for dried and smoked meat/fish.
**Impact:** high (gates the entire food economy and whether preservation is worth doing). **Effort:** medium (needs a per-stack a_w/temperature state, but moisture already exists via `moistureOf`).

#### P2. Nutrition and toxicity change by multiplier when cooked: lines 845, 871, 878
```ts
845: props: { edible: clamp01(foods.reduce((t, x) => t + p(x, "edible"), 0) * 1.4), toxic: Math.min(...) * 0.1, medicinal: Math.max(...) }
871: props: { ...x.props, edible: clamp01(p(x, "edible") * 1.3 + 0.03), toxic: p(x, "toxic") * 0.1, seed: 0 }
878: props: { ...x.props, edible: clamp01(p(x, "edible") * 1.6 + 0.05), toxic: p(x, "toxic") * 0.15, seed: 0, ... }
```
**Why it's a rule:** cooking multiplies food value by 1.3/1.4/1.6 and divides toxicity by 10/6.7, with additive fudges (+0.03, +0.05). Energy is also created from nothing: a stew's `edible` is the *sum* of its inputs times 1.4, so cooking two berries in water yields more food than the berries contained.
**Replacement physics:** conserve energy and mass. Metabolisable energy (kJ) is a property of the ingredients; cooking changes *availability*, not quantity: starch gelatinisation and protein denaturation raise true digestibility by a measurable few-tens of percent, and water added to a stew adds mass without energy. Toxicity falls by thermal inactivation kinetics (first-order log-reduction at the achieved core temperature × hold time: the code already computes core T and s). Source kind: food-composition tables (kJ/100 g) plus in-vitro digestibility studies and D/z-value thermal-death data for the relevant toxins/parasites.
**Impact:** high (cooking is the main food multiplier and it violates conservation). **Effort:** medium.

#### P3. Hot metal cools on a fixed countdown: line 898
```ts
898: return done({ id: `hot:${x.id}`, make: () => ({ name: `glowing ${x.name}`, props: { ...x.props, plastic: 0.7 }, parts: [x.id], verb: "heat", cools: 36 }) },
```
**Why it's a rule:** `cools: 36` is a tick timer. A thin blade and a thick ingot lose workability at the same moment, independent of mass, surface area, air temperature, wind or whether it's buried in coals. `plastic: 0.7` is likewise a flat workability number rather than a temperature-dependent flow stress.
**Replacement physics:** Newtonian/lumped-capacitance cooling, dT/dt = -(hA + εσA(T⁴-T_∞⁴))·(T-T_∞)/(ρVc_p), using the density/thickness the item already carries (`phys.d`, COPPER) and the ambient air the fire code already supplies; workability follows from T relative to the hot-working range (copper ~500-800 °C), which `RED` already encodes. combustion.ts already exports `radiation`, so the governing terms exist.
**Impact:** medium (forging window, carrying embers/hot stock). **Effort:** small.

#### P4. Transformation products get hand-written property sheets: lines 885, 892, 903, 952, 997, 1201
```ts
885: props: { binding: 0.95, flammable: p(x, "flammable"), plastic: 0.3, toughness: 0.1 }          // melted resin
892: props: { ...x.props, plastic: 0, binding: 0, hard: 0.75, toughness: 0.45 }                     // fired clay
903: props: { hard: 0.8, heavy: 0.85, metal: 1, toughness: clamp01(p(x, "toughness") + 0.15) }      // smelted lump
952: props: { insulating: +0.05, flexible: +0.25, fibrous: *0.6, toughness: +0.3, flammable: *0.6 } // leather
997: props: { ...x.props, heavy: Math.min(1, p(x, "heavy") + 0.3) }                                 // vessel of water
1201: props: bowl ? { ...x.props, container: 0.8, binding: 0, heavy: 0.35 } : { ...x.props, binding: 0.1, heavy: 0.6, hard: 0.2 }
```
**Why it's a rule:** these are the *outputs* of physical processes, and each is a table of hand-chosen deltas: tanning adds exactly +0.3 toughness; firing lands on hard 0.75; a full vessel is +0.3 heavy regardless of its volume. Note the asymmetry: the same code paths attach *cited* thermal records (`remade(FIRED_CLAY, …)`, `LEATHER`, `COPPER`, `POT_WALL`), so the fire-facing half is physical and the mechanical/mass half is not.
**Replacement physics:** derive props from measured material constants in the same style as fuel.ts: density ρ → `heavy` (and a vessel of water = ρ_water·V, V from wall thickness and bowl geometry, so `POT_WALL` already gives it); compressive strength / modulus → `hard`; fracture toughness or work-of-fracture → `toughness`; tanning's collagen cross-linking raises tensile strength and wet-stability by a measured factor. Source kind: materials handbooks for earthenware, copper, rosin, vegetable-tanned leather (ρ, UCS, K_IC, tensile strength).
**Impact:** medium (everything made then feeds strike/throw/shelter maths). **Effort:** medium.

#### P5. Heating branches on property *categories* to pick a chemistry: lines 855, 866, 882, 888, 896, 901, 907, 909, 917, 927
```ts
855: if (skin(x)) { ... }
866: if (p(x, "edible") > 0) { ... }
882: if (sticky(x)) { ... }
888: if (p(x, "plastic") >= 0.6) { ... }
896: if (p(x, "metal") >= 0.8) { ... }
901: if (p(x, "metal") >= 0.3) { ... if (warm >= MELTS) ... smelt }
909: const woody = p(x, "flammable") >= 0.5 && p(x, "hard") >= 0.3 && x.verb !== "join";
917: const lamp = p(x, "container") >= 0.5 && p(x, "hard") >= 0.4, ...
927: if (p(x, "hard") >= 0.5) return decided({ text: `The ${x.name} got hot, then cooled. Nothing changed.` ... })
```
**Why it's a rule:** a priority-ordered chain of category tests, each with a cliff-edge threshold, decides which single transformation happens. Two consequences: a thing is only ever one category (an edible resinous nut cooks and can never melt), and `metal >= 0.3` + `T >= MELTS` is treated as smelting when ore reduction is a *chemistry* problem, not a temperature one: melting copper metal (1084.6 °C) is not the same event as reducing an oxide/carbonate ore, which needs a reducing CO atmosphere from charcoal and a flux to slag off gangue, and runs below copper's melting point. `x.verb !== "join"` at 909 is a provenance test (don't char the thing someone built) doing duty as a physical one. The clay branch reuses `RED` (600 °C) as the firing point; the real irreversible step is kaolinite dehydroxylation (~550-600 °C, so defensible) followed by sintering/vitrification (~950-1050 °C for earthenware) which is what actually sets hardness: worth splitting and citing rather than borrowing the metal constant.
**Replacement physics:** per-material transformation thresholds keyed on measured transition points carried in the `phys` record (dehydroxylation, sintering, solidus/liquidus, collagen shrinkage temperature, pyrolysis onset), evaluated *all* against the achieved core temperature rather than in a first-match chain; smelting additionally gated on bed atmosphere (combustion.ts already tracks air starvation for the charcoal path, which is the same oxygen-deficit state). Source kind: ceramic-engineering firing schedules, extractive-metallurgy (Cu-O Ellingham/reduction) data, collagen hydrothermal-stability measurements.
**Impact:** medium-high (craft tech tree). **Effort:** large.

#### P6. Hide curing and cooking only see one temperature point: lines 841, 856-857, 865
```ts
841: const T = Math.min(setIn(bed, air, POT_WALL), BOILS), raw = items.findIndex(... core(i, T) < COOKS);
856: const T = ta + plumeRise(bed, air, HUNG);
857: if (T > CURES) { ... scorched }
```
**Why it's a rule (soft flag):** the temperatures and the 1.5 m hang height are cited (sec. 29g, sec. 24) and `plumeRise`/`setIn`/`heats` are real: this is nearly compliant. What's still a rule is the binary: above CURES the hide is *scorched*, below it is cured if smoke is present, with no dependence on how long it hangs or on smoke-component deposition. Curing is a mass-transfer process (water out, phenolics/aldehydes in) with a time constant.
**Replacement physics:** smoke deposition flux × exposure time against a required loading, with denaturation (collagen shrinkage ~60-65 °C wet) as a competing rate. Source kind: smoke-curing literature (phenol deposition rates, hide collagen T_s).
**Impact:** low-medium. **Effort:** small.

#### P7. Fishing reach is a name-keyed lookup table: lines 963, 967, 1018-1019
```ts
963: export const FISH_REACH: Record<"basket" | "line", number> = { basket: 15, line: 40 };
```
**Why it's a rule:** gear *name* → radius in metres. A tiny scoop and a wide net sweep the same 15 m; a short cord and a long line both reach 40 m. The 40 m "a fish swims to it from farther off" conflates attraction with reach.
**Replacement physics:** swept volume for a dipped/dragged container (mouth area × path length × submerged depth) and, for a line, the length of line actually deployed plus a fish detection radius from water clarity and bait plume diffusion. Both are computable from `p(k,"long")`/container volume and the stream/lake state already modelled. Source kind: fisheries catch-per-unit-effort methodology (swept-area estimators), bait-plume detection studies.
**Impact:** medium. **Effort:** small.

#### P8. Catching a fish is a die roll and a presence check: lines 1004, 1010-1012, 1022
```ts
1004: const n = c.fish.basket >= 2 && c.draw() < 0.4 + c.skill * 0.05 ? 2 : 1;
1010: if (!c.fish.line) return { ok: false, text: `They dangled the ${x.name} in the water, and nothing bit.` ... }
1012: return { ok: true, text: `...something bit. A fish!`, gives: { fish: 1 }, ... };
1022: skill: level(a.skills.fishing ?? 0), draw: () => Math.random(),
```
**Why it's a rule:** dice decide a physical outcome, and worse, presence alone guarantees success: a basket swept where any fish exists within 15 m *always* lands one, and a line with a fish within 40 m *always* gets a bite, first try, every try. The only stochastic part is the 1-vs-2 bonus (`0.4 + skill*0.05`, uncited).
**Replacement physics:** capture as an encounter-and-escape process: expected catch = fish density × swept volume × capture efficiency, where efficiency falls out of net closing speed vs. fish burst swim speed (≈10 body-lengths/s) and mesh/aperture selectivity; line fishing as a Poisson bite process with rate from fish density, hunger state and bait attractiveness, sampled over the act's duration. Randomness then expresses a *rate*, not a verdict. Source kind: fisheries gear-selectivity and CPUE literature; fish burst-speed measurements.
**Impact:** high (primary protein source). **Effort:** medium.

#### P9. Gear wears a flat amount per use: line 1025
```ts
1025: a.inv.find((q) => q.k === act.items[0])!.hp -= 0.03;
```
**Why it's a rule:** "-hp per use". 33 dips destroy any basket or line, whether it's bark cord or sealed hide, and nothing else about the water matters.
**Replacement physics:** damage accumulation: abrasive/fatigue wear proportional to work done against the material (load × sliding distance / hardness, i.e. Archard wear), plus hygrothermal degradation of wet natural cordage (wet-strength loss and microbial rotting rate for cellulose fibres). The material's own `toughness`/`fibrous`/density are the inputs. Source kind: tribology (Archard coefficient) and natural-fibre wet-strength/retting data.
**Impact:** medium (tool economy; the same pattern recurs at line 400 and in `wear()` outside this range). **Effort:** small.

#### P10. Watering adds a fixed 0.5 of "water": line 1049
```ts
1049: t.water = Math.min(1, (t.water ?? 0) + 0.5);
```
**Why it's a rule:** a vessel of water: any vessel, any size: raises a plant's water state by exactly half, capped at 1. Two pours saturate anything; the soil underneath is irrelevant.
**Replacement physics:** volume poured (vessel capacity, which bowl geometry gives) distributed over the wetted root-zone area → an increment in volumetric soil water content, bounded by field capacity and drained by evapotranspiration; soil type sets available water capacity (mm/m). The terrain already exposes `soilAt` depth. Source kind: soil-physics/irrigation tables (field capacity and AWC by texture; FAO-56 for ET).
**Impact:** medium (farming feedback). **Effort:** small.

#### P11. Ballistics is a two-case lookup: bow or arm: lines 1073, 1075
```ts
1073: export const throwReach = (w, a, act) => (shooting(w, a, act) ? 40 : 20);
1075: export const throwDamage = (k, toughness, shot) => 5 * Math.max(0, (0.25 + p(k, "heavy") * 0.8) * (0.3 + p(k, "sharp") * 1.2) * (shot ? 5.5 : 2.2) - toughness * 0.3);
```
**Why it's a rule:** range and lethality are selected by a boolean (`shot`), with eight uncited coefficients. Bow draw weight, limb stiffness, arrow mass, thrower strength and projectile aerodynamics have no influence; a willow switch shot from any bow carries exactly 40 m, and "a bow carries twice as far as an arm" is asserted in the comment rather than derived.
**Replacement physics:** launch energy then terminal ballistics. Bow: stored energy = ∫F·dx over the draw (draw weight × draw length × an efficiency ~0.7-0.8), v = √(2E_eff/m_arrow); hand throw: release speed from limb kinematics (~20-25 m/s for a light javelin, falling with projectile mass). Range from projectile motion with drag; wounding from kinetic energy density at the point (E/A, i.e. sectional density × velocity²) against tissue penetration resistance. Source kind: archery ballistics measurements (draw-force curves, arrow efficiency), sports-biomechanics throwing-velocity studies, terminal-ballistics penetration thresholds.
**Impact:** high (hunting is the meat/hide/bone supply and the bow is the tech payoff). **Effort:** medium.

#### P12. A hit is "within range", a miss is "out of range": line 1089 (with 1093, 1109-1111)
```ts
1089: const hit = d <= throwReach(w, a, act);
1093: const fall = hit ? 0 : (1 + Math.random() * 3) / TILE_M, ...
```
**Why it's a rule:** a step function, so 39 m is a certain hit and 41 m a certain miss; the animal's size, motion, and the thrower's skill never enter. The miss location is then a die roll (`1 + random*3` metres short) instead of where the projectile would land.
**Replacement physics:** hit probability from angular dispersion (σ in mrad, measured for archers and for thrown weapons) projected onto the target's silhouette area at range d, with the target's displacement during flight time (flight time = d/v) as an additional miss term; a miss lands where the perturbed trajectory intersects the ground. Source kind: archery/throwing accuracy-vs-distance studies; ethology flight-initiation-distance for the reaction term.
**Impact:** high. **Effort:** medium.

#### P13. Prey physiology and butchery yield come from a name-keyed table: lines 1090, 1095-1096, 1101-1104 (table at materials.ts:66-82)
```ts
1090: const mat = THING_MATERIAL[prey.species];
1095: const dmg = hit ? throwDamage(k, mat.toughness, shot) : 0;
1096: prey.hp -= dmg;
1101: if (prey.hp <= 0) { ... const gives = { ...mat.breaks };  // e.g. tree: { log: 2, stick: 2 }
```
**Why it's a rule:** species name → `{ toughness, hp, breaks }`. Death is an hp pool draining to zero; a carcass yields a fixed integer bill of materials regardless of the animal's size (`prey` has no mass here), condition or season, and `toughness` stands in for hide thickness, bone and body mass at once.
**Replacement physics:** body mass M (which animals already have via size/species growth) drives everything: carcass yield by measured dressing percentage (~50-58 % live weight for cervids) split into muscle/hide/bone/fat fractions, giving fractional kg rather than item counts; incapacitation from physiological trauma (haemorrhage rate from wound cross-section and vessel involvement, or CNS/organ hit) rather than a damage accumulator; penetration resistance from measured hide thickness and tissue penetration force. Source kind: wildlife-management carcass-yield tables, veterinary/ballistic wound-physiology data.
**Impact:** high (defines the value of hunting and the whole hide/bone supply). **Effort:** large (touches animals.ts:53, formulas.ts:98/170, plan.ts:64/149, sim.ts:1148).

#### P14. Animal reaction is a species name switch: line 1097
```ts
1097: if (prey.species === "deer") prey.state = "flee";
1098: else prey.target = a.id;
```
**Why it's a rule:** textbook hardcoded category switch: the species *name* decides fight or flight, so anything not literally `"deer"` (a rabbit, a fish) turns and charges its attacker.
**Replacement physics/ethology:** response from physical state: predator/prey role from body-mass ratio and dentition/diet traits, modulated by injury severity, distance, and escape-route availability; flight-initiation distance is a measured quantity per species-mass class. (Lives on the boundary of cognition, but it is currently decided by a name, not by anything the animal is.)
**Impact:** medium (hunting risk/safety). **Effort:** small.

#### P15. Footprints come from a name table: lines 1140-1142
```ts
1140: const SOLID = ["tree", "stump", "burnt_stump", "bush", "dead_bush", "sapling", "boulder", "fallen_log", "structure", "fire", "pit", "trap", "well", "grave"];
1141: const FOOT: Record<string, number> = { tree: 0.5, stump: 0.4, burnt_stump: 0.4, sapling: 0.15, fallen_log: 0.5, fire: 0.8, pit: 0.8, trap: 0.8, well: 0.8 };
1142: export const occupied = (w, px, py) => !!anyAround(w, px, py, 6, SOLID, (t) => meters({ px, py }, t) < (FOOT[t.kind] ?? t.size / 2));
```
**Why it's a rule:** kind name → obstruction radius, which overrides the thing's own dimensions. A 20 m oak and a seedling-sized tree both occupy 0.5 m; a fallen log's footprint ignores its length entirely; the `?? t.size / 2` fallback shows the physical version already exists and is being bypassed.
**Replacement physics:** footprint from the object's own geometry: trunk diameter from height via a measured allometric taper relation (DBH-height curves), log footprint from length × diameter and orientation, fire footprint from bed diameter (combustion already tracks it), pit footprint from excavated volume. Source kind: forest-mensuration allometry.
**Impact:** medium (controls where anything can be planted or built, i.e. settlement density). **Effort:** small.

#### P16. Digging is 12 abstract work units from an invented power formula: lines 1162, 1164, 1175, 1178
```ts
1162: export const PIT_SOIL = 0.2, SEED_SOIL = 0.03;
1164: export const digPower = (tool: Kind) => 0.15 + p(tool, "hard") * 0.4 + p(tool, "sharp") * 0.3 + p(tool, "long") * 0.3;
1175: st.progress += power * (1 + level(a.skills.digging ?? 0) * 0.1);
1178: if (st.progress < 12) return { done: false };
```
**Why it's a rule:** `12` is a dimensionless finish line and the four coefficients (0.15/0.4/0.3/0.3) are hand-tuned with no stated basis; `SEED_SOIL = 0.03` has no citation (`PIT_SOIL`'s "spade's depth" at least gestures at one). Soil type never matters: a pit in sand and in stiff clay take identical effort.
**Replacement physics:** excavation energy = target volume × specific energy of excavation for that soil (kJ/m³, strongly texture- and moisture-dependent), supplied at the digger's sustainable metabolic power (a few hundred W of useful mechanical work), with the tool setting the cutting-edge efficiency (blade area, penetration resistance ~ cone index/soil shear strength). `soilAt` already gives depth; the terrain already knows texture. Sowing depth is an agronomic measurement (~1-5 cm by seed size). Source kind: soil-mechanics/earthmoving specific-energy tables, work-physiology sustainable power output, agronomy sowing-depth guidance.
**Impact:** medium (pits/traps/wells pacing). **Effort:** medium.

#### P17. Bare-handed work costs a flat health tax: line 1176
```ts
1176: if (!act.tool) a.needs.health = Math.max(0, a.needs.health - 0.05);
```
**Why it's a rule:** fixed injury per tick for toolless digging (mirrors line 400's `hardness * 0.35`). Health is a scalar being debited, not an injury being sustained.
**Replacement physiology:** contact mechanics: pressure = applied force / contact area against skin abrasion/blister thresholds, accumulating with sliding work and relieved by callus adaptation; soil abrasiveness (sand vs. loam) scales it. Source kind: hand-tool ergonomics and skin-friction/blister-formation studies.
**Impact:** medium (it's a real survival pressure that currently has no physical shape). **Effort:** small.

#### P18. Shaping is a plasticity cliff with invented product props: lines 1192, 1201
```ts
1192: if (p(x, "plastic") < 0.6) return decided({ text: `The ${x.name} wouldn't take a shape.`, fields });
1201: props: bowl ? { ...x.props, container: 0.8, binding: 0, heavy: 0.35 } : { ...x.props, binding: 0.1, heavy: 0.6, hard: 0.2 }
```
**Why it's a rule:** a single `plastic >= 0.6` gate decides formability, and the resulting bowl's capacity (0.8) and mass (0.35) are constants: a bowl pressed from a huge lump and a small one are identical. (The thermal half is physical: `phys: { ...phys, d: POT_WALL }`.)
**Replacement physics:** workability from water content relative to the Atterberg plastic and liquid limits (measured per clay), which also sets drying shrinkage and crack risk; capacity from geometry (hemisphere volume from lump volume and wall thickness POT_WALL), mass from ρ × material volume. Source kind: soil/ceramic Atterberg-limit and drying-shrinkage measurements.
**Impact:** medium. **Effort:** medium.

#### P19. Build style is a kind-id/base lookup: lines 1211-1214, 1235
```ts
1211: const STYLE: [string, (k: Kind) => boolean][] = [
1212:   ["brick", (k) => k.id.startsWith("fired:shape:block")], ["planks", (k) => k.base === "plank"], ["logs", (k) => k.base === "log"],
1213:   ["stone", (k) => k.base === "stone"], ["hide", (k) => k.base === "hide"], ...
```
**Why it's a rule:** a priority-ordered name table (`k.id.startsWith(...)`, `k.base === ...`). It only produces a descriptive word, so it's the mildest case: but it's the exact forbidden shape, and it will mislabel any new material.
**Replacement:** pick the style word from the dominant member's *properties* (already available: fibrous/plastic/long/heavy/hard), or drop the concept and name the structure from its most massive component. No physics needed: this is naming.
**Impact:** low (cosmetic/naming only). **Effort:** small.

#### P20. The whole shelter model is a hand-weighted score plus a tier ladder: lines 1219-1220, 1228-1234, 1238-1246
```ts
1219: const framing = (k: Kind) => p(k, "long") >= 0.5 && p(k, "hard") >= 0.25;
1220: const walling = (k: Kind) => p(k, "heavy") >= 0.4 && p(k, "hard") >= 0.5;
1228:    const block = walling(k) ? 0.5 : 0;
1231:    cover += c * (p(k, "long") * 0.55 + p(k, "fibrous") * 0.3 + p(k, "insulating") * 0.4 + block);
1232:    insul += c * (p(k, "insulating") + p(k, "fibrous") * 0.4 + p(k, "heavy") * 0.4);
1233:    sturdy += c * p(k, "hard") * (0.5 + p(k, "toughness"));
1238: const coverS = clamp01(cover / 6), insulS = n ? clamp01(insul / n) : 0, sturdyS = n ? clamp01(sturdy / n) : 0;
1239: const stands = frame >= 3 || walls >= 10;
1240: const tier = coverS < 0.25 || !stands ? 0
1241:   : coverS >= 0.95 && sturdyS >= 0.45 && n >= 16 && frame >= 6 && walls >= 12 ? 3
1242:     : coverS >= 0.7 && sturdyS >= 0.3 && (frame >= 6 || walls >= 12) ? 2 : 1;
1246: const room = tier === 0 ? 0 : tier === 1 ? Math.min(2, 1 + Math.floor(n / 10)) : tier === 2 ? Math.min(4, 2 + Math.floor(Math.max(0, n - 12) / 8)) : 3 + Math.floor(Math.max(0, n - 16) / 8);
```
**Why it's a rule:** the densest concentration of hardcoded rules in the range. Piece *counts* (3, 6, 10, 12, 16) and uncited weights (0.55/0.3/0.4/0.5, ÷6, ÷n) produce three unitless scores, which a nested ternary converts into a four-step tier, which then decides warmth, rain protection, capacity and size. None of it has a dimension: `insul` is a per-piece average of prop values, not an R-value; `cover` is a sum over pieces divided by 6, not a roof area; `room` is a piece-count staircase, not floor area. A hut is a hut because someone counted six long sticks.
**Replacement physics:** two independent real models. (1) Thermal: envelope U-value from each assembly layer's thickness ÷ thermal conductivity (R = d/k, measured k for thatch, hide, log, sod, stone) plus an infiltration term, giving heat loss in W/K that the existing warmth/air code can consume directly: this is the same style as the fire rebuild. (2) Structural/geometric: roof area and floor area from member length (a 2 m pole spans ~2 m; that *is* the hut's size), load capacity from member bending strength and joint type against wind and snow loads, rain interception as the fraction of plan area actually covered. Occupancy follows from floor area at a measured ~1.5-2.5 m²/sleeper. Tier then becomes a *description* of the computed envelope, not an input to it. Source kind: building-physics conductivity tables for vernacular materials (thatch, log, sod, hide), timber-engineering span/strength tables, ethnographic floor-area-per-person surveys.
**Impact:** high (shelter is cold-survival, and the tier number propagates everywhere). **Effort:** large.

#### P21. Shelter footprint is indexed by tier: lines 1252, 1446
```ts
1252: const WIDTH = [1.2, 2.2, 3, 4.5]; // meters across, by tier
1446: export const sizeOf = (sh: Shelter) => WIDTH[sh.tier] + (sh.tier === 3 ? 1.6 * Math.max(0, sh.room - 3) : 0);
```
**Why it's a rule:** physical size read out of a 4-element array by category index, extended by `1.6 m` per extra sleeper only for tier 3. The materials' actual lengths are discarded.
**Replacement physics:** footprint from member geometry: span ≈ pole length (minus overlap at the apex) for a conical/A-frame, wall length from the number of courses and stone/log dimensions; the area so obtained is the same area the thermal model needs, so the two stay consistent. Source kind: timber span geometry; the materials' own length props.
**Impact:** medium (collision, camp layout, visuals). **Effort:** medium (falls out of P20).

#### P22. "Forge" is declared from a fuel-count test, not a temperature: lines 1315-1319
```ts
1315: const coal = fuels.filter((k) => (k.burns ?? 1) > 1.2).reduce((t, k) => t + (k.fuel ?? 20), 0);
1316: const forge = coal > 0 && !!fire!.contained, ...
1319: const text = ... forge ? `The ${list(w, uses)} caught inside the ring and glowed white-hot.` : ...
```
**Why it's a rule:** `burns > 1.2` is a magic cutoff standing in for "this is charcoal", `?? 20` invents a fuel value, and the resulting label asserts "glowed white-hot": a temperature claim: from a boolean, not from the bed. The function one screen above (`redHot`, line 805) already computes achievable temperature properly, which makes this an avoidable regression.
**Replacement physics:** classify the fire by what it can actually do: compute bed temperature with the current fuel and air supply (combustion's `setIn`/`fluxIn` with containment affecting draught) and call it a forge when it sustains the working temperature of the metal present. Charcoal's advantage then comes from its measured calorific value and near-zero volatiles, already in fuel.ts BURNS. Source kind: already available in fire-constants.md; only the classification needs rewiring.
**Impact:** medium (metal working gate). **Effort:** medium.

#### P23. Containment and cover are piece-count thresholds: line 1327 (with 1322, 1328)
```ts
1322: if (fire && parts.every((k) => (p(k, "hard") >= 0.5 && p(k, "flammable") < 0.2) || p(k, "plastic") >= 0.6)) {
1327:   const contained = walls >= 3, covered = was.covered || (was.contained && (walls >= 6 || parts.some((k) => p(k, "plastic") >= 0.6)));
1328:   const ring = { tall: Math.max(fire.walls?.tall ?? 0, ...laid), width: (fire.walls?.width ?? 0) + laid.reduce((t, d) => t + d, 0) };
```
**Why it's a rule:** three stones make a hearth and six (or any clay) make a kiln, by count. These two booleans are the switches that select the fire's entire air regime downstream (`fire.contained`, `fire.covered` drive the charcoal/kiln path at 910 and the smoulder behaviour in combustion), so a counting rule is gating the one subsystem that *was* rebuilt physically. The code even computes real geometry on the very next line (`ring.tall`, `ring.width` from each piece's thickness) and then doesn't use it for the decision.
**Replacement physics:** oxygen supply from geometry: open aperture area = fire-bed perimeter × unblocked height, which the already-computed `ring.tall`/`ring.width` plus bed diameter give directly; draught from stack effect (ΔP = gΔρh) through that aperture, and "covered" as the fraction of plan area sealed, producing a continuous air-mass-flow number that combustion.ts consumes instead of two booleans. Source kind: fire-constants.md's own air/draught sections plus traditional-kiln airflow measurements.
**Impact:** high (controls flame vs. smoulder, charcoal, kiln and forge). **Effort:** medium.

#### P24. A trap is two sticks over a hole: line 1336
```ts
1336: if (c.pit && cover.length >= 2 && cover.length === parts.length) {
```
**Why it's a rule:** a count (2) and a membership test decide that a pit is now a concealed trap; the pit's mouth area, the pieces' span and strength, and the mass they must appear to support never enter.
**Replacement physics:** covering as area closure: total projected area of the laid pieces vs. pit mouth area sets concealment; the cover's collapse load (member bending strength over the span) vs. the animal's body weight decides whether it gives way, which is exactly the trap's mechanism. Source kind: timber bending-strength/span tables; animal body-mass data already needed by P13.
**Impact:** medium. **Effort:** small-medium.

#### P25. Structures have hit-point pools topped up by building: lines 1400, 1422, 1428
```ts
1400: const f = fire!, r = ring ?? addThing(w, "structure", f.px, f.py, { owner: a.id, parts: {}, hp: 100, maxHp: 100, born: w.t, size: 1.6 });
1422: const s = own ?? addThing(w, "structure", ...beside(w, a, 1.5), { owner: a.id, parts: {}, hp: 100, maxHp: 100, born: w.t });
1428: s.hp = Math.min(s.maxHp!, (s.hp ?? 100) + 20);
```
**Why it's a rule:** an empty structure starts at 100 hp regardless of what it's made of, and each armful of anything repairs exactly 20. `size: 1.6` for a stone ring is likewise a constant rather than the ring's measured circumference (which line 1328 computes).
**Replacement physics:** condition as material state, not a pool: load capacity from member sections and joints (P20) against wind/snow/fire loads, degradation by measured decay processes (wood rot rate vs. moisture and temperature, cordage UV/wet strength loss), repair as replacement of the degraded members. Ring size from Σ piece widths / π. Source kind: timber-decay rate studies, wind-load engineering.
**Impact:** medium. **Effort:** medium.

#### P26. Sickness is a step function with dice severity and day-counted timers: lines 1520, 1527, 1531, 1541-1548
```ts
1520: const RANK = 0.25;
1527: if (p(x, "medicinal") >= 0.5 && c.sick) { ... effect: "cure" }
1531: if (p(x, "toxic") >= RANK) { ... `made them sick` }
1541: a.needs.food = Math.min(100, a.needs.food + p(x, "edible") * 100);
1543:   a.sickness.until -= DAY;
1544:   a.needs.health = Math.min(100, a.needs.health + 8);
1547: const sev = clamp01(p(x, "toxic") + 0.1 + Math.random() * 0.2);
1548: a.sickness = { until: w.t + Math.round(DAY * (0.5 + sev * 1.5)), severity: Math.max(sev, a.sickness?.severity ?? 0) };
```
**Why it's a rule:** the comment states the rule outright: "makes whoever eats it sick, every time; food milder than that never does". A threshold at 0.25 flips a binary, dose is ignored (one berry = ten berries), severity is `Math.random()`, recovery is a wall-clock countdown of 0.5-2 days, one herb subtracts exactly one day and adds exactly 8 health, and `edible * 100` makes nutrition a fraction of an abstract 0-100 belly rather than energy.
**Replacement physiology:** dose-response. Ingested dose = mass eaten × toxin concentration ÷ body mass, compared against measured thresholds (NOAEL/LD50-scaled) to give a probability and magnitude of effect; for spoilage illness, the pathogen load from P1's growth model gives an infective dose with an incubation period and immune-clearance recovery curve. Medicinals act by a pharmacological mechanism (antiemetic/antimicrobial) with a dose, not a flat day. Nutrition should be kJ metabolisable energy against basal metabolic rate plus activity (so hunger is an energy balance, not a 0-100 bar). Source kind: toxicology dose-response data, infectious-dose literature, human energy-requirement tables (BMR/PAL).
**Impact:** high (illness and starvation are the main death causes). **Effort:** medium (the needs 0-100 scale is cross-cutting).

#### P27. Wearing is a two-threshold test and the text asserts the benefit: line 1558
```ts
1558: if (p(x, "insulating") < 0.5 || p(x, "flexible") < 0.4) return decided({ text: `The ${x.name} wouldn't stay on.`, fields });
1560: return decided({ ok: true, text: `They wrapped the ${x.name} around themselves. It kept the cold out.`, ... });
```
**Why it's a rule:** two uncited cutoffs decide wearability, and the success text claims a thermal outcome ("It kept the cold out") that no computation produced: a leaf mat and a thick fur read the same.
**Replacement physics:** insulation value in clo (or m²K/W) from garment thickness × material conductivity × body-surface coverage fraction, fed into the existing heat-balance code so the sentence can report what actually happened; wearability from whether the piece's area/length can wrap the body's girth (a geometric test). Source kind: clothing-physics clo tables for fur/hide/woven fibre, and ISO 9920-style garment insulation data.
**Impact:** medium (cold survival). **Effort:** small-medium.

#### P28. Jev rulings mint matter with model-chosen properties and no physics: lines 1573-1584
```ts
1573: // A Jev ruling, once made, is a law: apply it the same way every time.
1574: export type Ruling = { useful: boolean; name: string; props: Props };
1584: const [k, isNew] = ensure(w.kinds, `law:${key}`, () => ({ name, props: r.props, parts: fields.inputs, verb: act.verb }));
```
**Why it's a rule:** this is the explicit escape hatch: when the physics can't decide, a judgement supplies `useful` and a whole `props` sheet, cached as a permanent "law". The resulting kind carries no `phys` record, so it has no density, no burn behaviour and no measured anything, yet it flows into strike, throw, shelter and fire maths as if it did. Every `"ask"` return in this file (lines 833/889-adjacent, 928, and the join path) routes here.
**Replacement physics:** derive the product's properties from its inputs by conserved quantities: mass and volume add, density follows, and mechanical props come from a mixture/composite rule (rule of mixtures for stiffness/strength, weakest-link for toughness, series/parallel for conductivity) over the parts' measured constants; `phys` must always be synthesised via the existing `mix`/`remade` helpers so a ruled object is still a physical object. The judgement should then be limited to naming and to whether the combination is *mechanically* plausible, never to assigning magnitudes.
**Impact:** medium-high (unbounded: any uncited property can enter the world here). **Effort:** medium.

---

### BEHAVIOUR (agent/social; listed only, not world physics)

- **1431** `s.stale = work.better || (work.roomier && residentsOf(...).length >= roomBefore) ? 0 : (s.stale ?? 0) + 1;`: a learning/boredom counter for "building this up stopped helping".
- **1435-1438** `const far = home && meters(home, s) > ((home.shelter?.tier ?? 0) <= 1 ? 60 : 150);`: hardcoded 60 m/150 m re-homing distances by tier; a residence decision.
- **1459-1466** `stash(w, a, keepFood = 3, …)` with `if (p(k, "edible") >= 0.1 && food++ < keepFood) continue;`: inventory policy (keep three foods on hand).
- **1485** `isToolish = (k) => k.verb === "join" || k.verb === "rub" || p(k, "sharp") >= 0.5 || p(k, "container") >= 0.6;`: provenance-based "is this a tool" test used for stashing/dropping priority.
- **1342-1344** storing food/containers inside a home rather than building with them: an intent disambiguation rule, not physics.
- **1084/1108** `++st.progress % 3` and `st.tries >= 6`: act cadence and give-up count; pacing/decision rather than ballistics (the physical halves are P11/P12).

---

### ALREADY PHYSICAL (in this range)

- **801-803** `BOILS/COOKS/RUNS/RED/MELTS/CHARS/CURES`, `HUNG = 1.5`, `LIFTED = 10`: each cited to fire-constants.md sections (24, 29c, 29g) with units.
- **805** `redHot`: asks combustion whether the bed sustains red heat at the metal's actual thickness; the model for how P22 should work.
- **819-827, 841, 856, 865** core heating: `setUp`/`BLOWN`, `DURATION.heat * TICK_S`, `heats(phys, m, T, s, ta)`, `setIn(bed, air, phys.d)`, `plumeRise(bed, air, HUNG)`, `POT_WALL` for pot walls: real conduction/transient heating with moisture.
- **869, 911** `smokes(bed, air)` and `CHARS` for charring under cover: combustion-derived smoulder state.
- **917-922** ignition and carry: `lightsIn(group(...), fluxIn(bed, air, d), air)` and `advance(...)` over `LIFTED` seconds decide catching and whether a brand survives being lifted.
- **1300-1316** lighting/feeding a fire: `lightsIn(..., inFlame(d, LAMP_FLAME), air)`, `lighting(pieces, air, brand)`, `feeding(burns, pieces, air, after)`; `LAMP_FLAME = 0.042`/`WICK = 0.008/3600` cited (R10, sec. 14b/22b).
- **1119, 1125-1133, 1153-1158** `soilAt`, `groundWord`, `spotNear`: read the generator's regolith/terrain fields with real metre distances; only the thresholds they're compared against (P16) are uncited.
- **1056-1062** `openWater`: samples actual wetness, ice and stream flow at metre offsets.
- **1202** bowl `phys: { ...phys, d: POT_WALL }` and **893/903/953** `remade(FIRED_CLAY, …)`, `COPPER`, `remade(LEATHER, …)`: the thermal records of transformed materials stay in the cited fuel.ts layer (their `props` siblings do not; see P4).

## src/sim/sim.ts lines 1 to 800

## Audit: src/sim/sim.ts lines 1-800 (read in full)

Standard applied: outcomes should follow from a physical process with measured, cited constants (docs/research/fire-constants.md model). Flags below are world physics unless listed under behaviour.

### physics

#### P1: Locomotion speed is a fixed m/tick with a life-stage switch and a path step-function
- **Lines 36, 226-227** (and the constants it feeds: 35 VISION, 37 SEARCH)
```ts
const WALK = 2, RUN = 6; // meters a tick for an adult
const speedOf = (w, a, run) =>
  (run ? RUN : WALK) * (stageOf(w, a) === "child" ? 0.6 : 1) * (w.paths[a.y * W + a.x] >= 5 ? 1.4 : 1) * moveRate(lightOn(w, a).bright);
```
- **Why it is a high-level rule:** walking speed is a hardcoded pair of numbers; `stageOf(...) === "child"` is a category switch picking a 0.6 multiplier instead of reading body size/leg length; `w.paths[...] >= 5` is a threshold that makes the 6th tread instantly 40% faster. Terrain slope, surface, load carried and body mass do not enter at all (walk.ts handles pathing, not speed). No citation anywhere; docs/research/README.md only restates "walking is about 2 m per tick" as a fact of the build.
- **Low-level physics that replaces it:** self-selected walking speed from the metabolic cost of locomotion: Tobler's hiking function or the Minetti/Ardigò cost-of-walking curves give v(slope); surface factor from terrain-coefficient work; leg-length scaling via the Froude number (v ≈ √(g·L_leg)·Fr, so a child is slower because L_leg is shorter, no branch needed); load penalty from Pandolf's equation (load mass / body mass). Path speed-up becomes a continuous terrain coefficient as vegetation is trampled (ecology trample already tracks wear).
- **Likely sources:** Tobler 1993 hiking function; Minetti et al. 2002 (J Appl Physiol) energy cost of walking/running on gradients; Pandolf, Givoni & Goldman 1977 load-carriage metabolic cost; Soule & Goldman terrain coefficients; Alexander on Froude-number gait scaling.
- **Impact:** high (travel time governs foraging range, energy spend, exposure, everything in ctxFor's distance costs). **Effort:** medium.
- **Note:** `moveRate`/`workRate`/`restRate` in light.ts:166-171 are uncited fitted ramps too; they are the upstream dependency of this finding and of P4.

#### P2: Act duration is a fixed per-verb tick count, sped up 10% per skill level
- **Line 757**, table at src/sim/physics.ts:218
```ts
if ((s.progress += 1 + level(a.skills[SKILL[act.verb](act, w)] ?? 0) * 0.1) < (DURATION[act.verb] ?? 4)) return "wait";
// physics.ts: DURATION = { join: 8, heat: 8, wet: 10, shape: 6, place: 3, plant: 3, pour: 2, wear: 2 }
```
- **Why:** how long it takes to bind, heat, soak, mould or build is a lookup keyed by verb name, with a fallback of 4, and the only modifier is a linear 10%-per-level skill bonus. Nothing about the amount of material, its mass, the water it must absorb, or the heat it must take in affects the time. "Heat" taking 8 ticks regardless of piece thickness contradicts the thermal model the fire rebuild already has.
- **Low-level physics:** time = required work or energy ÷ deliverable power. For heating: transient conduction to the target temperature (Fourier number, Biot number, thermal diffusivity of the piece: the same τ the combustion rebuild uses for ignition delay). For wetting: capillary/diffusive water uptake (√t sorption law, measured diffusivity). For shaping/joining/building: human mechanical power output (sustained ~75-100 W) against the deformation work or the number of binding turns; strength and practice enter as deliverable power and efficiency, not a flat +10%/level.
- **Likely sources:** Incropera-style transient-conduction charts for Fourier/Biot; wood moisture-diffusion coefficients (Siau, Wood-Water Relations); human sustained power output literature (Wilkie 1960); grip/force-production ergonomics tables.
- **Impact:** high (every non-blow act's cost in time, hence exposure and competing needs). **Effort:** medium.

#### P3: Named skill taxonomy chosen by target names and property cutoffs
- **Lines 630-640** (consumed at 757 and 644-649 `gain`)
```ts
strike: (act, w) => act.target?.kind?.startsWith("hot:") || p(w.kinds[...], "metal") >= 0.8 ? "smithing"
  : act.target?.kind === "tree" || act.target?.kind === "stump" ? "woodcutting" : act.target?.kind === "deer" || act.target?.kind === "wolf" ? "hunting" : ["stone", "bone", "boulder", "flint"].includes(...) ? "stonework" : "toolwork",
...
wet: () => "fishing", shape: () => "pottery", place: () => "building", plant: () => "farming",
```
- **Why:** a kind-name switch assigns one of a fixed list of trade names, and that name is the bucket practice accumulates in, which then feeds back into work speed (757). Striking a stump is "woodcutting" but striking a fallen_log falls through to "toolwork"; dipping anything in water trains "fishing". The categories are human job titles, not physical quantities.
- **Low-level physics:** practice should improve the parameters of the motion actually performed: accuracy of blow placement, fraction of swing energy transferred, force consistency: stored against the act's physical signature (impulse delivered, tool mass/edge, target material). Motor-learning power law (performance ∝ trials^-b) gives the curve; transfer between acts follows similarity in the physical parameters rather than a shared name.
- **Likely sources:** Newell's power law of practice / Heathcote et al. 2000 exponential-vs-power reanalysis; motor-learning transfer literature; experimental-archaeology measurements of knapping and chopping efficiency vs practice hours.
- **Impact:** medium-high (work speed, breakage and hunting success all read from it). **Effort:** large.

#### P4: Poor-light work loss is a per-tick coin flip, with a category exemption for fights
- **Lines 652-659**
```ts
function fumbles(w, a) {
  if (a.goal?.type === "fight" || a.goal?.type === "defend") return false;
  const b = lightOn(w, a).bright;
  if (Math.random() < workRate(b)) return false;
```
- **Why:** dice decide whether a tick of physical work happened; and a named goal type (`fight`/`defend`) switches the physics off entirely, justified by prose ("quick and close"), not geometry. `workRate` itself (light.ts:168, `0.15 + 1.1b` clamped) is an uncited fit.
- **Low-level physics:** visual performance vs luminance: contrast sensitivity and acuity fall continuously with adaptation luminance, so task time rises smoothly (a slowdown factor on progress, not a Bernoulli trial), and error rate rises with the required visual angle of the task. Close-range work (a fight at arm's length, or a hand-held act) is less affected because the target subtends a large angle and proprioception substitutes: that falls out of visual angle automatically, no goal-type branch.
- **Likely sources:** CIE / IESNA relative visual performance (RVP) model (Rea & Ouellette 1991); Weston's visual-performance curves for task size and contrast; dark-adaptation and mesopic acuity data (Blackwell).
- **Impact:** medium (night-time productivity across all acts). **Effort:** small-medium.

#### P5: Fire "kinds" (hearth/kiln/forge) decided by boolean flags, not by what the fire achieves
- **Lines 135-137**, used by `fireKind`/`pstate` (line 279) and FIRES (144)
```ts
hearth: { kinds: ["fire"], ok: (t) => !!t.contained },
kiln: { kinds: ["fire"], ok: (t) => !!t.contained && !!t.covered },
forge: { kinds: ["fire"], ok: (t) => !!t.contained && (t.charcoal ?? 0) > 0,
```
- **Why:** three named installation types gated on flags (`contained`, `covered`, `charcoal > 0`). Whether pottery can be fired or metal worked is decided by a boolean, not by the temperature and atmosphere the enclosure actually reaches. A ring of stones with a huge charcoal bed and a bellows is not a "forge" unless the flag is set; a covered fire is a "kiln" even if it only reaches 400 C.
- **Low-level physics:** achieved temperature from an energy balance on the fire bed: heat release rate (already modelled in combustion.ts) minus radiative and convective losses through the enclosure (its view factor, emissivity and conductance): plus the oxygen supply (natural draught from stack height and buoyancy, or forced air from fanning). Then "can fire clay" is simply T ≥ the clay's sintering/vitrification range, and "can work metal" is T ≥ the metal's forging range in a reducing atmosphere (charcoal bed depth sets the CO/CO2 ratio).
- **Likely sources:** fire-constants.md already has flame temperatures (R12: 650-1030 C crib flames) and forced-ventilation factors (R19: blown air up to 6x burning rate): the missing side is enclosure heat loss and draught: Kuhn/Rice on pottery firing temperatures (650-900 C open firing, 900-1100 C kiln), archaeometallurgy measurements of bloomery/forge temperatures and the Boudouard equilibrium for charcoal atmosphere.
- **Impact:** high (gates whole craft branches: pottery, charcoal, smithing). **Effort:** large.

#### P6: Shelter quality as hp/maxHp, tier integer and room count
- **Lines 163, 416-417, 500, 502** (type at world.ts:33)
```ts
if (!home || meters(a, home) > HOME_NEAR || (home.hp ?? 100) < (home.maxHp ?? 100) * 0.7) return true;
return residentsOf(w, home).length > (home.shelter?.room ?? 1) || (home.stale ?? 0) < 2;
if ((mine?.shelter?.tier ?? 0) >= 2) return null;
add("store_food", ... (home.shelter?.tier ?? 0) >= 1 ...)
```
- **Why:** a dwelling's condition is an hp bar with a 0.7 "needs mending" threshold; its adequacy is a 0-3 `tier`; its capacity is an integer `room`; whether food can be stored there at all is `tier >= 1`. All four are high-level labels. `stale < 2` makes two no-op build loads the test of "I'm done building".
- **Low-level physics:** heat balance of the enclosure: UA (insulation thickness × conductivity, air-change rate from gaps) against metabolic heat of the occupants, so "room" falls out of floor area and the warmth the occupants actually keep; structural condition from member decay and weather loading (moisture-driven rot rate, wind/snow load vs member strength) rather than hp; food storage from the microclimate it provides (temperature, humidity, exclusion of animals), not a tier.
- **Likely sources:** ASHRAE handbook U-values and air-change rates for primitive/vernacular envelopes; ethnographic measurements of indoor temperature in tents/wickiups; wood-decay rate data (Scheffer climate index); basic structural timber capacities.
- **Impact:** high (shelter is the warmth and sickness pathway). **Effort:** large.

#### P7: Plant and grass condition as hp thresholds
- **Lines 126, 127, 482**
```ts
grain: { kinds: ["grass"], when: (w) => ripening(w.t), ok: (t) => (t.hp ?? 3) > 1 },
bush: { kinds: ["bush"], ok: (t) => (t.n ?? 0) > 0 && !ablaze(t) },
const wilting = nearestThing(w, a.px, a.py, ["sapling"], (t) => t.owner === a.id && (t.hp ?? 5) < (t.maxHp ?? 5) * 0.8, 100);
```
- **Why:** whether grass still bears seed is `hp > 1` with a default of 3; whether a sapling is "wilting" is `hp < 0.8 maxHp`. Plant stress is an integer health pool with magic defaults and an uncited 0.8 cutoff.
- **Low-level physics:** plant water status: soil water potential (soil.ts already has `soilWaterAt`) vs the plant's wilting point, with transpiration demand from the evaporative environment (Penman-Monteith reference ET scaled by canopy conductance); visible wilting is loss of turgor below a measured leaf water potential. Seed availability follows from phenology driven by accumulated growing-degree-days and the grain fill already tracked, not an hp counter.
- **Likely sources:** FAO-56 (Penman-Monteith ET, crop coefficients, readily available water fraction); standard soil field-capacity/permanent-wilting-point values by texture; growing-degree-day phenology tables for wild grasses.
- **Impact:** medium (foraging yield, farming feedback). **Effort:** medium.

#### P8: Food spoilage as a per-kind shelf-life in days
- **Line 346** (field defined at materials.ts:20, values 35-62)
```ts
const keeps = Object.values(w.kinds).filter((k) => !k.made && p(k, "edible") >= 0.1 && (k.shelf ?? 0) >= 10);
// materials.ts: shelf?: number; // days before food spoils: berry 3, nut 25, mushroom 1.5, fish 1, meat 1, grain 40
```
- **Why:** a fixed day count per item name decides what keeps, and the planner's "food that keeps" test is an uncited `>= 10` on that number. Spoilage is temperature- and moisture-independent: meat lasts one day in a snowstorm and one day in summer; smoking or drying cannot change it except by becoming a different named kind.
- **Low-level physics:** microbial growth and lipid oxidation: spoilage time ≈ time for the microbial population to cross a sensory threshold, with rate from the Ratkowsky square-root/Arrhenius temperature model and water activity (a_w) gating growth; drying and smoking act by lowering a_w and adding phenolic inhibitors, so they change the rate, not the category.
- **Likely sources:** Ratkowsky et al. 1982 square-root growth model; Labuza water-activity stability maps; USDA/FSIS and ComBase predictive-microbiology datasets; Q10 values (~2-3) for spoilage in the chill-to-ambient range.
- **Impact:** high (storage, stock_up, winter survival). **Effort:** medium.

#### P9: Animal response to being struck decided by species name
- **Lines 704-705** (plus 684-686, 698-700, 729-733 distance/attempt rules in P11)
```ts
if (prey.species === "deer") prey.state = "flee";
if (prey.species === "wolf") prey.target = a.id;
```
- **Why:** a name switch picks "flee" or "retaliate". The world's reaction to a blow comes from a table of species names in the act driver rather than from the animal's state.
- **Low-level physics/ethology:** response from per-animal continuous traits already physical in nature: body mass ratio to the threat, injury severity from the impulse delivered, hunger/condition, group size: resolved by an economic escape rule: flee when the expected cost of fighting exceeds that of fleeing. Flight-initiation distance is itself a measured quantity scaling with body mass and approach speed.
- **Likely sources:** Ydenberg & Dill 1986 economics of fleeing; Blumstein's flight-initiation-distance datasets (FID vs body mass); predator-prey mass-ratio literature for when prey counter-attack.
- **Impact:** medium (hunting risk and wolf attacks). **Effort:** small (move to a trait + threshold on state).

#### P10: Encumbrance and storage as item counts, not mass or volume
- **Lines 297 (`armful = ... 4 : 2`), 347 (`count(a, k) + 6`), 456 (`count(a, k) < 6`), 507-508 (`count(a, k) >= (isTool(kind) ? 1 : 4)`), 499-504 (`foodHeld > 3`, `a.inv.length > 12`, `a.inv.length > 10`, `(home.store?.length ?? 0) < 24`)**
```ts
for (const [type, k] of Object.entries(COLLECT)) add(type, !dark && count(a, k) < 6 && ...)
add("stock_up", ... (home.store?.length ?? 0) < 24 && can("stock_up"));
```
- **Why:** how much a person gathers or a home holds is counted in items: six of anything, an armful of four, a store of 24 slots: so a boulder and a berry occupy the same room. physics.ts:236 `carryOf` is likewise a slot count (`CARRY`, `young(a) ? 8`), modified by a container's property, not its volume.
- **Low-level physics:** load limit from carried mass as a fraction of body mass (and the metabolic penalty of P1's Pandolf term), plus bulk limited by container volume; store capacity from the enclosed volume and the bulk density of what's in it. Items already have mass-like properties (`heavy`) and world.ts has per-kind sizes to derive from.
- **Likely sources:** Pandolf load-carriage equation and military/ethnographic head- and back-load data (commonly 20-40% of body mass sustainable); bulk-density tables for grain, nuts, firewood.
- **Impact:** medium (foraging throughput, travel cost, hoarding). **Effort:** medium.

#### P11: Pursuit resolved by fixed distances and attempt counters
- **Lines 684-686, 691, 698-700, 729-733, 745-749**
```ts
if (!prey || meters(a, prey) > 250) return `the ${kind} got away`;
if ((s.tries = (s.tries ?? 0) + 1) > 40) return `couldn't get to the ${nm(w, t.kind)}`;
if ((s.tries = (s.tries ?? 0) + 1) > 60 || prey.alt > 2) return `the ${prey.species} got away`;
if ((s.tries = (s.tries ?? 0) + 1) > 80) return `the ${prey.species} got away`;
```
- **Why:** a chase ends because a tick counter hit 40, 60 or 80, or the animal crossed a 250 m line; `prey.alt > 2` is an opaque threshold on an altitude-like field. Nothing about relative speed, stamina or terrain decides the outcome, and the event text asserts "got away" as a cause.
- **Low-level physics:** pursuit as a kinematic race: closing speed from both speeds (P1 for the human, a mass-scaled sprint speed for the animal) and endurance from anaerobic capacity and heat load; a chase ends when the gap stops closing or the pursuer's sustainable power drops below the required speed (the physiological basis of persistence hunting). Vision/scent loss of contact comes from light.ts's existing `canSee` rather than a radius constant.
- **Likely sources:** Hill's and Wilson's work on sprint speed vs body mass; Carrier 1984 / Liebenberg 2006 on human endurance running and persistence hunting; thermoregulatory limits to sustained running (heat storage).
- **Impact:** medium (hunting success rate). **Effort:** medium.

#### P12: Crafting outcome declared useless by an LLM-ruling quota and a kind-depth cap
- **Lines 763, 771** (and the naming heuristics at 773-784)
```ts
if (act.items.some((k) => depth(w.kinds, w.kinds[k]) >= 2)) return applyRuling(w, a, act, rulingKey(act), { useful: false, name: "", props: {} });
if (hourly >= 6) return applyRuling(w, a, act, key, { useful: false, name: "", props: {} });
```
- **Why:** a physical outcome (what binding or heating these materials produces) is decided by a budget: more than six rulings in an hour of sim time, or inputs more than two derivations deep, and the world rules the act produced nothing. That is a harness constraint masquerading as physics, and it silently makes deep craft chains impossible.
- **Low-level physics:** the result of joining or heating should follow from the materials: joining succeeds when the binder's tensile strength and friction can carry the assembly's load (a mechanical fastening/lashing model over measured fibre strengths); heating changes the piece according to its thermal history (water loss, pyrolysis fraction, case hardening depth from the transient temperature profile: the same model P2 and P5 need). The LLM then names and describes the outcome instead of deciding whether there is one; with no budget left, fall back to a derived outcome, never to "useless".
- **Likely sources:** cordage and bast-fibre tensile strength measurements (experimental archaeology); fire-hardening studies on wooden points (Hardwood char-depth and hardness measurements); wood pyrolysis kinetics already cited in fire-constants.md.
- **Impact:** high (what exists in the world's material tree). **Effort:** medium.

#### P13: Tool reach as a binary 1 m bonus from a property threshold
- **Lines 683, 702** (also `range * 0.8` stalk distance at 734)
```ts
const long = p(w.kinds[act.tool ?? ""], "long") >= 0.6 ? 1 : 0;
... meters(a, prey) > REACH + 0.5 + long ...
```
- **Why:** a tool either adds exactly one metre of reach or none, on a `long >= 0.6` cutoff. Reach is a geometric quantity (arm + haft length) and is already needed for the strike's moment arm and impact energy.
- **Low-level physics:** reach = arm length + tool length (a real length in metres on the kind); the same length sets the swing's tip speed and hence impact energy (rotational kinematics), which strikeTick already wants.
- **Likely sources:** anthropometric arm-length data (ANSUR); hafted-tool length measurements from the archaeological record.
- **Impact:** low-medium. **Effort:** small.

#### P14: Name-keyed material and breakage tables used to decide what things yield
- **Lines 148, 505-506** (tables at materials.ts:21, 85-88)
```ts
const STRIKEABLE = Object.keys(THING_MATERIAL).filter((k) => !(k in FAUNA));
...Object.keys(THING_MATERIAL[b.fields.target]?.breaks ?? {})...
if (Object.keys(FAUNA).some((s) => THING_MATERIAL[s]?.breaks[k])) continue;
```
- **Why:** what a struck object turns into comes from a `breaks: { stick: 2 }`-style table keyed by thing name, and the filters are set membership in name maps (`FAUNA`, `THING_MATERIAL`). Fragment counts and products are authored, not fractured.
- **Low-level physics:** fragmentation from the material's fracture mechanics: toughness and grain direction against the delivered impulse, giving fragment size distribution (energy-based comminution laws) and whether the piece splits, shatters or merely dents. Flesh/bone yields follow the animal's body composition fractions, not a `breaks` map.
- **Likely sources:** wood cleavage and fracture-toughness data (Wood Handbook); lithic fracture-mechanics studies (conchoidal fracture, Hertzian cone); carcass-yield fractions from butchery/zooarchaeology.
- **Impact:** medium-high (the whole material supply chain). **Effort:** large.

#### P15: Fire-tending need expressed with a hardcoded "four hours of night" and a DAY/6 lookahead
- **Lines 487-488**
```ts
const tonight = 4 + hoursToDawn(w.t + DAY / 6);
add("lay_by_wood", ... fireHours(w, fire.thing) < tonight && count(a, fuel) < 3 ...)
```
- **Why:** `4` hours and the `DAY / 6` offset are unexplained magic (the comment restates them without basis), and `count(a, fuel) < 3` is a three-sticks rule. The physical parts (`fireHours`, `hoursToDawn`) are sound, so this is a thin layer of arbitrary arithmetic on good physics.
- **Low-level physics:** fuel needed = energy to keep the fire's heat output above the comfort/warmth requirement until dawn ÷ the fuel's heat of combustion (both already available from fuel.ts PHYS and combustion output); the lookahead is just the walk time to the fuel source and back from P1.
- **Likely sources:** already covered by fire-constants.md (heats of combustion, burning rates); no new source needed. **Impact:** low-medium. **Effort:** small.

### behaviour (agent cognition / social: listed briefly)
- **Need-number gates everywhere in `feasible`** (439-444, 452-456, 460, 472, 483, 488, 495-504, 537-546): `a.needs.food < 70`, `energy < 75` / `< 95` in the dark, `warmth < 75`, `warmth < 50`, `food >= 25 && warmth >= 40 && health >= 40 && energy >= 15` for experimenting, `needs.food < 45` to beg, `affinity < -0.3 && b.needs.health > 30` to attack. Uncited thresholds on an abstract 0-100 needs scale deciding what gets considered. (The needs scale itself is a physiology abstraction: its depletion lives outside this range, in life.ts/needs; worth auditing there as world physics.)
- **Rule switches:** line 472 `RULES.learning === "seen"` gates whether theories can be formed at all; line 552 `hooks.options?.(w, a, opts)` lets a probe rewrite the option set. Explicit experiment switches (rules.ts), not physics.
- **Cooldown timers:** 336/337 (`w.t + 60`, `nextDecide = w.t + 2`), 403-404 (`w.t + 30`), `hostile:`/`social:` per-person cooldowns (537-539), 40-tick feasibility cache (433). Arbitrary retry suppression.
- **Struggle counters:** 395-401: `>= 2` failed goals while `needs[n] < 40` defines "struggling", which unlocks `ask_help`.
- **Homesite social geometry:** 163-172: affinity `> 0.4` (or `0.15` with no home), 600 m search, 60 m minimum separation, rings `[6, 9, 12, 15]`, 3 m clearance.
- **Distance heuristics:** 251 `STEP_M = 15`, 253 `HOME_NEAR = 150` (comment claims "half a day's walk", which at 2 m/tick is ~75 ticks: the stated physical justification does not hold), 283 `FIRESIDE = 60`, 35 `VISION = 300`, 37 `SEARCH = 800`, plus 442 (`> 15` m from fire), 460 (`> 60`), 492 (`<= 100`), 500/504 (`<= 300`, `<= 400`), 544 (`> 150`, `<= 500`).
- **Exploration dice:** 287 `Math.random() * Math.PI * 2`, `m = 80 + Math.random() * 320`, 40 attempts: random wander target.
- **Item valuation and tool-ness:** 116 `p(k, "sharp") >= 0.5 || p(k, "container") >= 0.6`; 118 `0.45 / 0.15 + edible*0.5 / 0.1`: hand-set social value of loss.
- **Name lists driving choice:** 44-95 `GOALS` text table (UI), 98 `HOSTILE`, 99-103 `NEED_FIX` (`["eat", "forage", "share_meal"]`), 143 `KNOWN` (what is remembered in the dark), 144 `FIRES`, 456 `k === "stone" || k === "stick"` ("about everywhere" abundance assumption keyed by name), 517-520 child exclusions (`["attack", "teach", "raid", "steal", "take"]`).
- **Skill-level work bonus** is listed under P2 for the physics half; its cognitive half (practice bookkeeping, `gain`/`level` log at 644-650) is behaviour.

### physical_already
- **Fire state reads** (463-465): `fireOutput(w, kept).flaming <= 0`, `fireHours(w, kept) < hoursToDawn(w.t)`, `ablaze(t)`: dying fire is judged by actual heat output and remaining fuel hours, from the rebuilt combustion model.
- **Ablaze exclusions in place lookup** (127, 129, 133, 688): a burning bush/tree/log is not a gatherable because it is physically on fire, not because of a flag.
- **Resin availability** (139): `(t.resin ?? 0) > 0` with `changed: true`: reads the accumulated exudate that ecology produces over time.
- **Light-driven perception and pace** (227, 255, 427, 655): brightness from `lightOn`/`canSee`/`skyShare` feeds speed, visibility and work; the brightness field itself is physical (the ramps consuming it are not: see P1/P4).
- **Ground suitability for work** (211-217): `dryAt`, `groundWord`, `diggable`, `reachable` read terrain and moisture fields rather than named zones.
- **Ripening phenology hook** (126 `when: ripening(w.t)`) delegates seasonal availability to cues.ts rather than a `season === "autumn"` branch: the gate is time-based, but the `hp > 1` half of the same line is flagged in P7.
- **Act delegation** (710-756): every physical resolution (`strikeTick`, `rubTick`, `digTick`, `throwTick`, `join`, `heat`, `wet`, `shape`, `place`, `plant`, `pour`, `wearIt`, `fan`, `throwReach`) is handed to physics.ts/combustion rather than resolved here: the seam is clean, so fixing the constants above is mostly a matter of what this file passes down.

## src/sim/sim.ts lines 800 to 1600

## sim.ts 800-1600: world-physics audit

Read in full as four raw slices (800-900, 900-1000, 1000-1200, 1200-1400, 1400-1600). Line numbers verified by counting the raw blocks and cross-checked against grep hits (1147, 1148, 1235-1240, 1263, 1264, 1267).

### physics (world physics, incl. body physiology)

#### P1: `THING_MATERIAL[...].breaks` decides what a struck thing becomes · sim.ts 1148-1151 (table: materials.ts 66-82) · impact high · effort large
```ts
if (out.ok && act.verb === "strike" && act.target?.kind && THING_MATERIAL[act.target.kind]) {
  const breaks = THING_MATERIAL[act.target.kind].breaks;
  see(w, a, `breaks:${act.target.kind}`, `A ${act.target.kind} breaks down into ...`);
```
A lookup keyed by the *name* of a thing (`tree → {log:2, stick:2}`, `boulder → {stone:3}`, `deer → {meat:3, hide:1, bone:2, fat:1}`) decides the products of destroying it, and sim.ts then asserts that fact to the agent as a world law. Nothing about the tree's actual trunk diameter, height or wood density enters it: a seedling-thin tree and a 15 m oak both yield exactly 2 logs and 2 sticks.

**Physics that replaces it:** fragmentation of a body by the work done on it. Products should fall out of (i) the thing's geometry and mass already tracked (`t.size`, fuel.ts `piece`/`woodOf` give density and diameter), (ii) where the fracture runs: wood splits along grain into billets of bounded diameter, rock conchoidally into flakes of its grain size, a carcass into anatomical fractions. Governing quantities: specific fracture energy / work of fracture (J/m², wood ≈ 5-20 kJ/m² across grain; rock from fracture toughness K_IC, MPa·m^0.5), and mass-conserving partition: kg of trunk in ⇒ kg of logs+sticks+chips out. Carcass yield is a measured dressing percentage (deer carcass ≈ 50-58 % of live mass; meat/bone/fat/hide fractions are tabulated in wildlife and butchery literature). **Likely sources:** wood-mechanics handbooks (Forest Products Laboratory *Wood Handbook*, fracture-toughness tables), rock-mechanics K_IC tables, and wildlife carcass-yield studies for deer/rabbit/fowl.

#### P2: membership in `THING_MATERIAL` is used as a category switch for "is this a strikeable/huntable object" · sim.ts 1236, 1237, 1264, 1267 (also 148, 675 outside range) · impact high · effort medium
```ts
fire: (act) => ... || (act.verb === "strike" && !THING_MATERIAL[act.target?.kind ?? ""]) || ...
tool: (act) => ... || (act.verb === "strike" && !THING_MATERIAL[act.target?.kind ?? ""]),
const animalsNear = w.animals.filter((m) => meters(a, m) <= 60 && m.alt < 2 && THING_MATERIAL[m.species]) ...
for (const sp of new Set(w.animals.filter((m) => meters(a, m) <= 120 && m.alt < 2 && THING_MATERIAL[m.species]) ...
```
Presence in a hand-written dictionary: not any physical property: decides whether an animal can be hunted or an object attacked, and whether a strike counts as fire-making or tool-making. A species absent from the table is physically invulnerable; one present is attackable regardless of its size relative to the attacker.

**Physics that replaces it:** every body in the world has mass, dimensions and material strength; whether a blow damages it follows from momentum/energy delivered (physics.ts already has `strikeDamage`) against the body's yield strength and areal toughness, and whether the strike produces sparks follows from the two materials' hardness and the thermite/pyrite spark physics already in physics.ts `rubbing`/`sparkCatches`. The "can I hunt it" question is predator-prey energetics: prey mass vs weapon-delivered energy vs the penetration energy needed to reach a vital (measured in ballistics/archery penetration studies, J for a given broadhead/mass). **Likely sources:** material yield-strength/hardness tables; archery and hand-weapon penetration energy measurements.

#### P3: nursing a collapsed person heals, warms and feeds by fixed per-tick increments, and revives at fixed bar thresholds · sim.ts 1441-1445 · impact high · effort medium
```ts
b.needs.warmth = Math.min(100, b.needs.warmth + 0.6);
b.needs.health = Math.min(100, b.needs.health + 0.3);
const f = bestFood(w, a);
if (f && b.needs.food < 40 && s.progress % 10 === 1) { takeItems(a, f); b.needs.food = Math.min(100, b.needs.food + p(w.kinds[f], "edible") * 100); }
if (b.needs.health > 50 && b.needs.food > 25 && b.needs.warmth > 25) b.down = w.t;
```
Four unsourced numbers decide whether a person lives: 0.6 warmth/tick from a body beside them, 0.3 health/tick, a feed every 10th tick, and consciousness returning exactly when three abstract bars pass 50/25/25. Nothing here knows the carer's body temperature, the patient's injury, or the food's energy content.

**Physics that replaces it:** (i) *warming*: conductive/radiative heat transfer between two bodies in contact: Q̇ = hA(T_carer - T_patient), skin contact h ≈ 20-100 W/m²K over the contact area, driving the patient's core temperature through their thermal mass (≈ 3.5 kJ/kg·K × body mass). This is exactly the heat balance `warming(w, a)` already computes for fires, so the mechanism exists. (ii) *feeding*: metabolizable energy, kJ per gram of the food, against basal metabolic rate (Harris-Benedict / Mifflin-St Jeor, ≈ 6-7 MJ/day for an adult at rest). (iii) *revival*: regaining consciousness is a physiological threshold on core temperature (severe hypothermia: unconscious below ≈ 30 °C, rousable above ≈ 32 °C) and on blood glucose, not on an arbitrary bar value. **Likely sources:** human thermal-physiology literature (Pennes/two-node models, hypothermia staging: Swiss staging system), food-composition tables (USDA FoodData Central) for kJ/g.

#### P4: food value is the abstract `edible` property × 100, so any food fills the same bar the same way · sim.ts 1332, 1444 (and bestFood's ranking) · impact high · effort medium
```ts
.filter((k) => ok.has(k)).sort((x, y) => p(w.kinds[y], "edible") - p(w.kinds[x], "edible"))[0]
... b.needs.food + p(w.kinds[f], "edible") * 100
```
A berry and a haunch of meat differ only by a 0..1 design-set `edible` number, multiplied by the magic 100 of a bar. Mass and portion size do not enter: one "item" of anything is one feeding.

**Physics that replaces it:** energy and macronutrient content per unit mass (kJ/g; fat ≈ 37 kJ/g, protein/carbohydrate ≈ 17 kJ/g) times the actual mass of the portion (the world already tracks `size`/mass per stack), accumulated against metabolic expenditure (BMR + activity, kJ/day) with a gut-fill rate ceiling (stomach volume and gastric-emptying rate, g/min) so that one cannot eat a deer in a tick. **Likely sources:** USDA FoodData Central / McCance & Widdowson food composition; gastric-emptying physiology.

#### P5: sleep recovers 0.7 energy/tick, multiplied by an integer shelter **tier** · sim.ts 1469-1479 · impact high · effort medium
```ts
const kind = home ? ["pile", "lean-to", "hut", "cabin"][home.shelter?.tier ?? 0] : null;
const here = lightOn(w, a).bright, target = isNight(w.t) ? 98 : 85;
...
a.needs.energy = Math.min(100, a.needs.energy + 0.7 * (1 + (home?.shelter?.tier ?? 0) * 0.35) * restRate(here));
return a.needs.energy >= target;
```
Three hardcoded high-level rules in four lines: a shelter is a **tier index** (0-3) that both names the building and multiplies sleep quality by `1 + 0.35·tier`; the restoration rate is a flat 0.7/tick; and "slept enough" is 98 at night, 85 by day. A tier is a category, not a physical property: a well-built lean-to and a draughty cabin cannot differ.

**Physics that replaces it:** sleep restoration is a function of *thermal comfort and disturbance*, both derivable. The shelter's effect is its measured insulation and shelter from wind: U-value (W/m²K) and air-change rate from the actual materials and geometry already stored on the thing (thatch ≈ 0.05 W/mK conductivity, turf, hide), feeding the same body heat balance as P3: a person who stays thermoneutral sleeps; one losing heat wakes. Restoration itself follows two-process sleep regulation (homeostatic sleep pressure S decaying exponentially during sleep with a time constant of hours, plus the circadian process C), which also removes the need for the 98/85 targets: they become "sleep pressure discharged". **Likely sources:** building-physics conductivity/U-value tables for vernacular materials; Borbély two-process sleep model and sleep-deprivation recovery studies.

#### P6: the whole body is four 0..100 bars mutated by additive constants · sim.ts 1441, 1442, 1444, 1478, 1486, 1378 (systemic; this range is where most of the mutation happens) · impact high · effort large
Every physiological update in this range is `needs.X = Math.min(100, needs.X + k)` with a hand-picked k, and every physiological decision is `needs.X </> threshold` (health < 20 stops a fight at 1378, warmth < 95 keeps warming at 1486, food < 40 triggers feeding at 1444). The bars have no units, so no constant in them can be cited.

**Physics that replaces it:** state variables with units: body core/skin temperature (°C) from a heat balance (metabolic heat production W, radiative/convective/conductive/evaporative loss W, clothing insulation in clo), energy stores (kJ of glycogen and fat) against metabolic rate, hydration (kg water vs sweat/respiratory loss), and injury as tissue damage with a healing time course. Once the body is in J, W and °C, the thresholds become measured physiology (shivering onset ≈ 36 °C core, hypoglycaemic impairment, fatigue at glycogen depletion) rather than bar values. **Likely sources:** human thermoregulation models (Fiala, Gagge two-node), exercise-physiology substrate-utilization data. *This is the umbrella finding for P3/P4/P5/P9; fixing those individually without units will just re-tune the same bars.*

#### P7: harvest yield is a fixed count plus a skill ramp · sim.ts 1587, 1589 (table: plan.ts 37-46) · impact high · effort large
```ts
let n = g.n;                                  // berries 2, reeds 2, clay 2, grain 3, stick 1 ...
if (t.kind === "bush") {
  n = Math.min(t.n!, 2 + Math.floor(level(a.skills.foraging ?? 0) / 4));
```
How much a bush gives per picking is a constant 2 plus one per four skill levels, and the branch is selected by `t.kind === "bush"` / `"reeds"` / `"clay"`: a name switch deciding physical outcome. Berry size, ripeness and how laden the bush is (all modelled elsewhere in plants/cues) do not change the yield.

**Physics that replaces it:** harvest is mass removed per unit of handling time. Yield per visit = (pick rate, items/min, set by the fruit's size, density on the plant and reach) × time spent; the ripe fruit mass available comes from the plant's own fruiting biomass. Skill enters as a motor-learning multiplier on pick rate, not as extra matter appearing. **Likely sources:** forager time-and-motion / optimal-foraging field studies that publish return rates in kcal·h⁻¹ and items·min⁻¹ for berries, tubers and grass seed (e.g. Hadza/!Kung return-rate datasets); agronomic fruit-yield-per-bush measurements.

#### P8: plants lose fixed hp per harvest; clay deposits vanish on a dice roll · sim.ts 1591, 1594, 1597, 1600, 1602-1603 (1601-1603 just past the range, same block) · impact high · effort medium
```ts
t.hp = (t.hp ?? 20) - 3;                      // bush, per picking
t.hp = (t.hp ?? 6) - 3;                       // reeds
t.resin = Math.max(0, (t.resin ?? 1) - 1);    // resin
if (Math.random() < 0.25) removeThing(w, t);  // clay pit
t.hp = (t.hp ?? 3) - 1;                       // grain tuft
```
Four name-keyed branches assign damage in units of an abstract hp, and a clay pit's exhaustion is a 25 % coin flip per dig: pure dice standing in for a physical process (an agent digging a large deposit can exhaust it in one dig, or never).

**Physics that replaces it:** damage to a plant is biomass removed relative to its standing biomass, with recovery governed by its growth rate: breaking stems removes leaf area, and the plant's survival follows from the remaining photosynthetic area versus respiration demand (plants.ts/niche.ts already model growth from light/water/fertility). A clay deposit is a *volume*: each dig removes litres of clay (spade volume × digs) and the pit is gone when the deposit's volume is gone: deterministic, with the deposit volume set at worldgen from the alluvial layer thickness. Resin likewise: tapping yields g per wound, limited by the tree's resin flux (g/day per wound, measured in naval-stores tapping literature). **Likely sources:** plant defoliation/herbivory tolerance studies (% leaf-area removal vs mortality); resin tapping yield data; soil/clay deposit thickness from sedimentology.

#### P9: the work quantum for all gathering is 2.5 ticks, with a 10 %-per-level skill ramp · sim.ts 1584 · impact medium · effort medium
```ts
if ((s.progress += (1 + level(a.skills.foraging ?? 0) * 0.1) * workRate(b)) < 2.5) return false;
```
Picking a mushroom, pulling reeds and digging clay all take exactly the same 2.5 units of progress; the 0.1-per-level ramp and the 2.5 threshold have no derivation. (`workRate(b)` at least couples it to light: but light.ts 168 is itself an uncited [design] curve.)

**Physics that replaces it:** per-task handling time measured in seconds (dig a litre of clay ≈ the volume divided by a measured digging rate in L/min for a given tool and soil; pull a reed stem = the force to break it ÷ applied power), so that different tasks take different, derived times. Skill becomes a power-law learning curve on task time (T_n = T_1·n^-b, Crossman/Newell-Rosenbloom, b ≈ 0.2-0.5 measured across manual tasks). **Likely sources:** industrial time-and-motion standards; the motor-learning power-law literature.

#### P10: carrying capacity and handling rate are item counts, not mass · sim.ts 1398, 1415, 1502 · impact medium · effort small
```ts
const n = unstash(w, a, home, s.arg!, 3);
for (let i = 0; i < 3 && home.store.length && a.inv.length < 16; i++) { ... }
const n = Math.min(t.n ?? 1, 3);
```
Three items per tick and sixteen stacks total, whatever they are: a person can carry 16 logs as easily as 16 berries, and the "their hands were full" message at 1505 asserts a cause that is really an array-length check.

**Physics that replaces it:** load carriage limited by mass and bulk: total carried mass against body mass (ethnographic and military load-carriage data put sustainable loads near 20-35 % of body mass, with measured metabolic cost rising per kg: Pandolf's load-carriage equation gives W as a function of mass, grade and speed), and volume against the container. Pick-up rate becomes mass·s⁻¹ from the handling-time model in P9. **Likely sources:** Pandolf/Givoni load-carriage energetics; ethnographic burden-weight measurements.

#### P11: helping someone advances their work by exactly +1 per tick · sim.ts 1515 · impact medium · effort small
```ts
if (stepToward(w, a, b.px, b.py, 3) === "arrived" && theirs && (theirs.op === "act" || GATHER[theirs.op])) theirs.progress += 1;
```
A second pair of hands doubles the work rate by fiat, regardless of what the task is, who the helper is or whether the task admits parallel effort.

**Physics that replaces it:** work is additive power on the task: each participant contributes their own power output (W, from body mass and skill) to the same job, so the time to finish is the task's required work divided by total power, bounded by how many people can physically reach the workpiece (tasks with a single working face don't parallelize; carrying a log does). This is the same `progress += rate` machinery, just with each worker's physically derived rate summed. **Likely sources:** human power-output measurements for sustained manual work (≈ 75-100 W sustained); team-task parallelism (Brooks-style serial fractions are design, but the reach constraint is geometric and derivable).

#### P12: the gather dictionary itself: place name ⇒ item name · plan.ts 37-46, consumed at sim.ts 1580, 1585-1587 · impact medium · effort large
```ts
export const GATHER: Record<string, { place: string; item: string; n: number; keep?: boolean }> = {
  pick_berries: { place: "bush", item: "berry", n: 2, keep: true }, ...
```
What a bush gives is written down as "berry", what reeds give as "fiber". A bush that is not a berry bush cannot be stripped for its real parts; a plant with no GATHER entry yields nothing at all.

**Physics that replaces it:** a plant is a body with parts (fruit, stem, leaf, root) each with mass, and gathering removes a part: which part you get follows from the action (pluck, strip, pull, dig) and the plant's anatomy from its species niche/morphology, not from an op-name table. Products inherit the part's material properties (fibre tensile strength for stems, sugar/energy for fruit). **Likely sources:** plant functional-trait databases (TRY: leaf/stem/fruit mass fractions, fibre tensile strength of bast fibres in MPa).

#### P13: nutrient export per item is a flat 0.004 · sim.ts 1609 (just past 1600; same block begun at 1588) · impact medium · effort small
```ts
if (t.kind === "bush" || ...) enrich(w, t.px, t.py, -0.004 * n);
```
The mechanism is right (carrying biomass off a place impoverishes its soil) but the coefficient is an uncited magic number applied equally to a berry and a bundle of reeds, and the branch is a name list.

**Physics that replaces it:** nutrient export = removed biomass mass × its nutrient concentration (N, P, K as % of dry mass, tabulated per plant part), divided by the soil's nutrient pool per unit area (kg/ha) that soil.ts tracks. **Likely sources:** plant tissue nutrient-concentration tables; nutrient-budget / nutrient-export agronomy studies in kg·ha⁻¹.

#### P14: weapons are ranked against an imaginary toughness of 0.15 · sim.ts 1334-1336 · impact medium · effort small
```ts
const bestWeapon = (w, a) =>
  [...].filter((k) => p(k, "edible") < 0.1 && (p(k, "sharp") > 0 || p(k, "heavy") > 0.4))
    .sort((x, y) => strikeDamage(y, 0.15) - strikeDamage(x, 0.15))[0] ?? null;
```
`strikeDamage` is physical, but it is evaluated against a hardcoded stand-in toughness of 0.15 (and the candidate filter uses `sharp > 0 || heavy > 0.4` design thresholds), so weapon choice: which decides hunt and wolf-fight outcomes: is decided against a fictional target rather than the animal actually in front of them.

**Physics that replaces it:** evaluate `strikeDamage` against the real target's material (its hide/bone resistance, from the same property set), so a flint point wins against a deer and a maul against rock: the physics is already in physics.ts, only the argument is fabricated. **Likely sources:** none needed beyond passing the actual target (derivation, not measurement).

#### P15: a sickness fact is asserted with a fixed confidence 50 · sim.ts 1495 · impact low · effort small
```ts
if (out.effect === "sick") see(w, a, `sick:${k}`, `${cap(nm(w, k))} can make you sick.`, 50);
```
Text asserting a cause ("X can make you sick") plus a magic weight 50, from a single episode. The sickness itself is decided in `eat` (physics.ts, outside this range), but this line fixes how strongly one bout implies a general rule.

**Physics that replaces it:** the *state* should carry it: a dose of the toxin ingested (mg/kg body mass) against a measured toxic threshold produces the illness, and the agent's confidence should come from their own tally (the beliefs machinery already does exactly this for every other outcome) rather than a constant. **Likely sources:** toxicology LD50/NOAEL values for the relevant plant toxins.

#### P16: fixed reach/attention radii decide physical interactions · sim.ts 1368 (`meters(a, wolf) < 40`), 1377 (`meters(m, a) <= 20`), 1417 (`canSee(w, b, a, 30)`), 1475 (`nearFire(w, a, 12)`), 1483 (`within(w, a, "fire", 1)`), 1263 (`around(..., 20, STRIKEABLE, ...)`), 1264 (`<= 60`), 1267 (`<= 120`) · impact medium · effort medium
Eight unrelated distances, none derived, several inconsistent with each other and with the world's own `VISION`/`FIRESIDE` constants (witnesses to a raid see 30 m while every other witness check uses `VISION`).

**Physics that replaces it:** fire proximity is already answerable from radiant flux: `heatAt`/`radiation` give kW/m² at a distance, so "near the fire" is "where the flux is worth sitting in" and "warming" is where the balance is positive (as 1486 already does). Visibility is `canSee` with the light model's range (light.ts already derives this). Threat distance is closing speed × reaction time. Strike reach is arm + tool length, which physics.ts already computes (`long` bonus at 1340-region and 674). **Likely sources:** the project's own radiative/visibility models; human reaction-time data for the flee radius.

#### P17: care/fight/flee episode lengths are tick budgets · sim.ts 1429 (`s.progress++ > 60`), 1369 (`> 20`), 1378 (`> 40`), 1450 (`> 40`), 1476 (`>= 12`), 1487 (`< 12`), 1512 (`> 30`), 1444 (`% 10 === 1`) · impact low-medium · effort small
Fixed timers with no physical basis decide how long a body can be tended, how long someone runs, and how long they sit by a fire. The 60-tick tending cap in particular can end life support while the patient is still unconscious.

**Physics that replaces it:** these should all be *state exits*, not timers: run until the threat flux/distance is below harm (already available from `heatAt`/`BEARABLE`), tend until the patient's core temperature and energy stores cross the physiological revival threshold (P3), sit by the fire while the heat balance is favourable (as 1486 already does), feed as fast as gastric emptying allows (P4). Most of this range's timers disappear once the body has units.

#### P18: act durations are a per-verb lookup used as the physics lookahead horizon · sim.ts 869 (`after = (DURATION[verb ?? ""] ?? 0) * TICK_S`), table at physics.ts 218 · impact medium · effort medium
```ts
export const DURATION: Record<string, number> = { join: 8, heat: 8, wet: 10, shape: 6, place: 3, plant: 3, pour: 2, wear: 2 };
```
A verb-name table says how long an act takes, and this range then advances the fire physics by exactly that long to judge the act's conditions: so an uncited integer per verb shapes whether a fire act is seen as succeeding. (Striking/rubbing/throwing/digging are already blow-by-blow and physical; the listed verbs are not.)

**Physics that replaces it:** task time from the work required ÷ power applied (P9/P11): tying a lashing is handling time per wrap × wraps; heating something is the time for its core to reach temperature, which is a conduction/heat-capacity calculation the fire model can already supply (mass × c_p × ΔT ÷ absorbed flux). **Likely sources:** material heat capacities and conductivities; manual-task time standards.

### behaviour (agent cognition / social: listed briefly, not world physics)

- **1225-1230** `AIM_STUFF` / **1233-1240** `AIM`: what an agent thinks to gather or try, by property thresholds (`flammable >= 0.5`, `heavy >= 0.4 && hard >= 0.5`) and a species name list (`["deer","wolf","rabbit","bush"].includes(...)`). Decision heuristics, not outcomes.
- **1248** `(a.tried[sig] ?? 0) < 2`: gives up on an experiment after two attempts. **1319** `shuffle(...).slice(0, 100)` with the `// ponytail: random cap to stay under Jev's 255 options` comment: an explicit prompt-size hack that silently truncates what agents can consider.
- **1256, 1260, 1269, 1279, 1280, 1288, 1289, 1295**: option-generation property cuts (`fibrous >= 0.5`, `hard >= 0.2`, `sharp >= 0.4`, `plastic >= 0.6`, `flexible >= 0.4`) and **1296, 1308** `Array(Math.min(c[x], 6))` / `(c[x], 5)` / `(c[y], 3)` lay sizes.
- **941-1021 `judged`, 1033-1061 `surprised`**: Jev prior weights `1 + 3 * odds(b, null)`, `1 + 10 * d.diff * Math.min(1, d.tries / 2)`, `1 + 10 * o.agree * Math.min(1, s.fails / 2)`, and `differed(...).slice(0, 3)`: hand-tuned inference leanings.
- **1086** `b.later = Math.round(b.later! * 0.7 + took * 0.3)`: exponential smoothing of a learned duration (0.7/0.3 chosen). **1095** `took < DAY * 1.5 ? "a day" : ...`: wording.
- **1105-1110 `giveUpWaiting`**: `w.t - e.t < DAY * 30`: thirty days of patience, a memory horizon.
- **1113-1121 `onFireOut`**: inserts a verbatim fact (`"A fire burns down to nothing unless there's X at hand"`) when a fire dies within `FIRESIDE` of an idle agent: a hardcoded lesson asserting a cause, bypassing the belief machinery.
- **1133-1138 `finishAct`**: auto-records the `fed_fire` belief for every burnable laid with tinder: a scripted inference (though it is at least anchored on `stackPhys(...).burn`).
- **1146-1147**: `gain(w, a, SKILL[act.verb](act, w), tinkering ? 3 : 5)` and `gain(w, a, "toolwork", 1)`: XP constants 3/5/1, with `SKILL` (sim.ts 630-632) choosing *which* skill by target name (`"tree"|"stump" → woodcutting`, `["stone","bone","boulder","flint"] → stonework`). Borderline: skill feeds back into P9/P7 yields and P14 damage, so if the operator wants it physical it belongs with motor-learning power laws (see P9).
- **1152-1154**: `last_deer` incident at `meters(m, a) <= 500` with `value: 0.6`: social valuation and an arbitrary radius.
- **1175-1193 naming / 1196-1219 `usePhrase`+`noteUse`**: `kind.count >= 3` before naming, `.slice(0, 6)` use samples, and a name-keyed phrase table (`{ tree: "felling trees", boulder: "breaking rock", ... }`). Labels and language, not world outcomes.
- **1358, 1361** `meters(a, b) >= 100`, `dangerous > 0.7`; **1433-1434** `value: 0.5`, `{ feel: 2, bond: "saved_my_life" }`; **1567** `meters(a, b) > 2.5`: social thresholds.

### physical_already (systems in this range that meet the standard)

- **CONDITIONS fire cuts, 839-848**: `breeze()` (computed from a real kindling run, physics.ts 88), `DAMP`/`SOAKED` (wetness.ts 22, cited sec. 10), `tooThick`/`drowned`, `radiation(...) < LEAST` (combustion.ts 52, cited sec. 1 kW/m²), `output(...).flaming <= 0`. Conditions read the combustion/wetness formulas at the point where they actually turn.
- **CONDITIONS place cuts, 850-860**: derived from the berry niche curves in terrain/niche.ts 40 (ph 4.5/7.5, fert 0.1, wet 0.4, wind 0.45, salt 0.3, soil 0.2 all match the curve knees). Minor gap: `dry: water < 0.5` sits between the berry water knees 0.4/0.6, `deep: light < 0.2` is near but not equal to the 0.15 knee, and `crowded: share < 0.8` has no niche basis: low impact, small effort to pin to the exact knees.
- **`firing` 884-906 and `ahead`/`advance` 909-917**: the fire an act will be laid on is the real bed advanced by the combustion integrator to the act's end; no rule decides whether it will light.
- **`choose` 921-940**: lays are picked by measured piece diameter and moisture, not by kind name.
- **flee's fire danger, 1367**: `heatAt(...).q >= BEARABLE`, with BEARABLE/PAIN/THIRD cited "sec. 7" at sim.ts 2009-2010; a real radiant-flux pain threshold.
- **warm_up's continuation test, 1486**: `warming(w, a).change > 0` asks the actual heat balance whether the place still warms them (the `< 95` gate in front of it is the unphysical part, P6).
- **gathered(), 1606**: "a stick picked up off the ground is as thick as a stem of its length, a berry as wet as it grew": the gathered item's physical state is inherited from the plant.
- **`enrich` mechanism, 1609**: nutrient export on harvest exists as a real coupling; only its coefficient is uncited (P13).
- **`workRate`/`restRate`/`DARK` coupling, 1474/1478/1583/1584**: work, rest and foraging genuinely depend on the light model rather than on a day/night switch; the curves themselves (light.ts 166-171) are uncited [design] and belong to whoever audits light.ts.


## src/sim/sim.ts lines 1600 to end

## Audit: src/sim/sim.ts:1600-2302

Read in full (1550-2302, overlapping the slice boundary for context). Findings are ordered physics-first; near-duplicates merged.

---

### PHYSICS (world + body)

#### P1. The body's needs are a unitless points economy with uncited drain rates: **high / large**
`2038-2040`:
```ts
n.food = Math.max(0, n.food - 0.12 - (a.sickness ? 0.05 : 0));
n.energy = Math.max(0, n.energy - (isNight(w.t) ? 0.16 : 0.1));
n.social = Math.max(0, n.social - 0.05);
```
Four 0-100 pools with hand-tuned per-tick decrements and no units, no mass, no energy. 0.12/tick sets the entire hunger clock of the world (how often anyone forages, who starves, how much food an island must supply); nothing cites it, and nothing couples it to body mass, work done, or what was actually eaten. The sickness term is a flat +0.05 drain with no fever, no pathogen load, no immune response.

**Physics that replaces it:** an energy and mass balance per body. Resting metabolic rate from body mass (Schofield / Harris-Benedict, ~1.1 W/kg basal; 2000-3000 kcal/day for an active forager), plus the activity cost of what they are actually doing; drawn against glycogen then fat then lean tissue. `food` becomes stored energy in kJ, not a percentage. `energy` becomes sleep pressure from a two-process homeostat (Borbély), not a clock switch. **Sources:** Schofield 1985 BMR equations; FAO/WHO/UNU energy requirement reports; Ainsworth Compendium of Physical Activities (MET values); Borbély two-process sleep model.

#### P2. Energy drains faster at night because it is night: **medium / medium**
`2039`: `n.energy - (isNight(w.t) ? 0.16 : 0.1)`

A switch on the world clock decides tiredness. A person asleep in a shelter at night and one hauling logs at night pay the same; a person hauling logs at noon pays less than one idling at midnight. Exertion is what costs energy, and the sim already knows the exertion (`workRate`, walk/run speed, `carry` load).

**Replacement:** metabolic cost of the current activity (MET × mass × time) for the depletion, and circadian/homeostatic sleep pressure as a separate variable that `rest` discharges. **Sources:** Ainsworth MET compendium; Pandolf load-carriage energy-cost equation (useful because `carry()` already tracks load).

#### P3. Starving and freezing cost a flat health tax; healing is threshold-gated: **high / medium**
`2043-2044`:
```ts
if (n.food <= 0 || n.warmth <= 0) n.health -= 0.4;
else if (n.food > 40 && n.warmth > 40 && !a.sickness) n.health = Math.min(100, n.health + 0.1);
```
Three magic numbers and two category thresholds. Health only erodes once a pool hits exactly zero: so there is no physiological cost to being chronically half-starved, then a cliff. Healing is a constant 0.1/tick that doesn't care what the wound was, how much protein is available, or whether the person is cold.

**Replacement:** harm follows the physiological state continuously. Starvation: once glycogen is gone, lean-tissue catabolism at a measured rate, with death at the fat-free-mass / body-mass-loss bound (~35-40% loss). Cold: stage by core temperature, not a pool at zero (mild 35-32 °C, moderate 32-28 °C, severe below 28 °C). Healing: wound closure rate modulated by protein/energy balance. **Sources:** Minnesota Starvation Experiment (Keys 1950) for the decline curve; Wilderness Medical Society practice guidelines for hypothermia staging; Elia's work on protein-energy wasting.

#### P4. Collapse, free top-up, and "a second collapse soon after the first is fatal": **high / medium**
`2131-2139`:
```ts
if (w.t - (a.cooldowns.collapsed ?? -Infinity) < DAY * 1.5) { die(w, a, cause); return; }
a.cooldowns.collapsed = w.t;
n.health = 25; n.food = Math.max(n.food, 15); n.warmth = Math.max(n.warmth, 20);
a.down = w.t + 60;
```
The single most unphysical rule in the range. A person at zero health is handed back 25 health, has their hunger and warmth topped up out of nowhere, and is immune to death for 1.5 days: then dies on the next collapse regardless of circumstances. Food and warmth materialise from a comment, not from the world: someone who collapses in a blizzard with an empty stomach wakes up warmer and fed. The 1.5-day window, the 60-tick unconsciousness, and the 25/15/20 are a lives-and-continues game rule.

**Replacement:** two separate physical bounds, each read from state. Unconsciousness when a variable crosses its syncope bound (core temp ≈30 °C, blood glucose below ~2.5 mmol/L, blood-volume loss ~30%). Death when it crosses the lethal bound (core temp ~24-28 °C, exhaustion of fat-free mass, loss above ~40%). Recovery only if the environment actually reverses the state: rewarming at the 1-2 °C/h a fire or shelter supports, refeeding only if someone feeds them (the `tend` path already exists). No timers, no free resources, no two-strike counter. **Sources:** WMS hypothermia guidelines (rewarming rates and temperature bands); ATLS hemorrhagic shock classes; clinical hypoglycaemia thresholds.

#### P5. The cause of death is asserted by a priority switch: **medium / small**
`2132`: `const cause = attacked.has(a.id) ? "their wounds" : a.sickness ? "sickness" : n.food <= 0 ? "hunger" : "cold";`

The text picks a cause by a fixed order of preference rather than reporting which variable actually killed them. Anyone who was ever bothered by a wolf dies of "their wounds"; anyone merely sick dies of "sickness" even if they froze; "cold" is the fall-through default, reported even when nothing about them was cold (health lost to burns at 2047-2050 is reported as cold).

**Replacement:** the lethal bound that was crossed names the cause: the same state machine as P4 emits it. Small change, and it removes an outright false statement from the chronicle.

#### P6. Clothing insulation is `(1 - worn * 0.6)` on a props scalar: **medium / medium**
`2015`: `worn = a.wearing ? p(w.kinds[a.wearing.k], "insulating") : 0`; `2025`: `... * (1 - worn * 0.6)`

A 0-1 "insulating" property times a magic 0.6 ceiling. The best possible garment can only ever cut heat loss by 60%, regardless of thickness, layering, coverage, or material; a hide cloak and a grass cape differ only by a tag value. The wetness multiplier beside it, `(1 + 0.3 * soaked)`, is at least marked `[design]` in fire-constants sec. 27 (line 1185).

**Replacement:** clothing as thermal resistance in clo / m²K/W, from the garment's material conductivity, thickness and body coverage, entering the same heat balance as `h_r` and `h_c` already do; wet insulation collapses toward the water-filled value. **Sources:** ISO 9920 (clothing insulation tables, incl. fur and skins); ASHRAE 55 clo values; published measurements of insulation loss in wet clothing.

#### P7. Shelter warmth is tier-and-insul points: **medium / medium**
`2028`: `if (roof) heat += 0.2 + (roof.shelter?.insul ?? 0) * 0.8 + (roof.shelter?.tier ?? 0) * 0.1;`

A flat 0.2 for having any roof, plus two uncited coefficients, one of them multiplying a discrete "tier" category. Being indoors is worth a fixed bonus instead of changing the heat balance. fire-constants sec. 31 (line 1511) names this explicitly as a term left alone: "Shelter, huddling and the sun keep their own terms."

**Replacement:** the enclosure as a thermal envelope: wall/roof U-value from built material and thickness, air-exchange rate from the openings, interior air temperature solving the balance of occupant metabolic heat plus any fire against fabric and ventilation loss. `airOn(w, a, inside)` already carries a sheltered flag, so the plumbing exists. **Sources:** ASHRAE Fundamentals (U-values, infiltration); measurements of vernacular/tent microclimates.

#### P8. Huddling is 0.25 a body, capped at two bodies, only at night, only within 2 m: **medium / small**
`2029`: `if (night) heat += Math.min(2, w.agents.filter((b) => b !== a && meters(a, b) <= 2).length) * 0.25;`

Four hardcoded decisions: the flat per-body bonus, the arbitrary cap of two, the night-only switch, and the 2 m radius. Huddling at dawn in freezing fog does nothing. The sim's own `reflex` (2113-2121) sends freezing people to huddle, so this term is load-bearing for survival, and it is pure invention.

**Replacement:** huddling reduces the body-surface area exposed to the environment and raises the local air temperature in the gap: a reduction in the effective radiating/convecting area in the same balance, scaling with how many sides are covered (which naturally saturates, no cap needed) and applying whenever bodies touch. **Sources:** animal-huddling thermoregulation measurements (penguin huddles, rodent groups) for the area/loss reduction; Fanger's clothing/body area factors.

#### P9. Sunlight on a body is a flat 0.05 scaled by lux: **medium / small**
`2030-2031`:
```ts
// Out in the sun a body soaks up warmth: a clear midday sun (some 60,000 lux) all but makes up for a cool breeze.
else if (!inside) heat += 0.05 * Math.min(1, lightOn(w, a).lux / 60000);
```
Solar gain as a capped fraction of a magic ceiling, in points, bolted on with an `else if` so that a person standing in the sun at night-time logic ordering gets nothing: and anyone under a roof gets nothing even on a hot day. The research doc already flags this: sec. 31 line 1694 lists "the sun's warmth on a body is a flat term, not its flux" among gaps left as found.

**Replacement:** the law is already written down in the repo. fire-constants sec. 18 / the recommended constant set (line 1640): "The sun by the same law, with absorptivity ratio 0.7 / 0.95": i.e. Δt_o = f_p · α · q_sun / (h_r + h_c), with the same f_p = 0.35, h_r = 6, h_c = max(3.4, 10.4 V^0.56) already in the file at 2007. Needs solar irradiance (W/m²) from the sky model instead of lux, which `light.ts` can supply. **Low effort, cited constants already in hand**: this is the cheapest physics win in the range.

#### P10. The cold/mild terms are a points scale with a 12 °C switch: **medium / medium**
`2025-2026`:
```ts
const cold = Math.max(0, (12 - air.feels - rise) / 110) * (night ? 1.2 : 1) * (1 + 0.3 * soaked) * (1 - worn * 0.6);
const mild = Math.max(0, (air.temp + rise - 12) / 60);
```
The /110 and /60 divisors and the 12 °C pivot are `[design]` in sec. 31 (line 1511), which is honest, but they still convert a real temperature into an invented pool rate: and the `(night ? 1.2 : 1)` factor is uncited and double-counts: `air.feels` already carries wind chill and `air.temp` already drops at night, so night is penalised twice. Note also the asymmetry: `cold` uses `air.feels` (wind-chilled) while `mild` uses `air.temp`: defensible, but undocumented.

**Replacement:** drop the pool. Once `warmth` is core temperature (P1), the balance is already the cited one: metabolic heat in, radiative/convective/evaporative/conductive out, with `rise` from fires entering exactly as sec. 31 has it. The night factor disappears because the air and sky already supply night.

#### P11. Melee damage: fists as a fake Kind, a body's toughness as `0.1`, and a `* 2`: **high / medium**
`1930` and `1935` (identical rule, both directions):
```ts
const dmg = strikeDamage(weapon ?? { id: "hands", name: "fists", props: { hard: 0.2, heavy: 0.1 } }, 0.1, a) * 2;
b.needs.health = Math.max(0, b.needs.health - dmg);
```
Four unphysical decisions in one line: a human body's resistance to being hit is the literal `0.1` (compare `bestWeapon` at 1336, which uses `0.15` for the same notion: the same quantity has two different magic values); bare hands are an inline synthetic `Kind` with invented `hard`/`heavy` props that exist nowhere in the materials system; the `* 2` is unexplained; and the damage lands as a scalar on a single health pool, with no hit location, no clothing or hide in the way, no bleeding over time, and no distinction between a club and a sharp stone beyond `focus(tool)`. `deed.value = dmg / 40` (1938) then converts the injury into social weight by another magic divisor. Violence is a real cause of death here (2132 reports "their wounds"), so this drives world outcomes.

**Replacement:** the blow's kinetic energy and momentum (mass, swing speed and reach: `force()` at physics.ts:374 is already most of this) delivered over the contact area of the striking surface, compared against tissue and bone tolerance; sharp edges penetrate instead, with depth from energy per unit edge length. Injury becomes a located wound with a blood-loss rate feeding the same state machine as P4, mitigated by whatever is worn. **Sources:** blunt-impact injury tolerance (Viano & Lau blunt criterion; rib-fracture force thresholds ~2-3 kN); ballistic/stab penetration energy-density thresholds for skin and bone; ATLS classes for the blood loss consequence.

#### P12. Violence is rationed by fixed timers: **medium / small**
`1937`: `a.cooldowns.attack = w.t + DAY;`  `1975`: `if (HOSTILE.includes(kind)) a.cooldowns[\`hostile:${b.id}\`] = w.t + DAY / 2;`

One attack per person per day, by fiat. Nothing physical stops a second blow; the limit exists to keep the sim calm. It also means a lethal fight can never happen, since death needs more than one exchange.

**Replacement:** exhaustion and injury limit fighting (the energy balance of P1 plus the wound state of P11), and the memory of the last fight's outcome limits starting another: a consequence of state, not a lockout. The `hostile:` cooldown is half social and is cross-listed in the behaviour bucket.

#### P13. Eating is `edible * 100` straight into the pool, bypassing physics.ts `eat()`: **medium-high / small**
`1727` and `1729` (and the identical rule at `1444`, in `tend`, just outside this slice):
```ts
b.needs.food = Math.min(100, b.needs.food + p(w.kinds[f], "edible") * 100);
```
A 0-1 tag times 100 is the entire nutrition model on this path. Portion size is one stack regardless of mass; nothing distinguishes a berry from a haunch of meat beyond the tag; and `physics.ts eating()/eat()` (1522/1537): which handles sickness from rank food and the real consumption path: is skipped entirely, so shared meals can't make anyone ill and don't respect any of its rules. Two code paths for the same physical process.

**Replacement:** energy content (kJ/kg, from food composition data) times the mass actually eaten, bounded by stomach capacity and digestion rate, added to stored energy. Route every eating event through the one physics function. **Sources:** USDA FoodData Central / Atwater factors for the energy densities; fire-constants sec. 22 already carries heats of combustion for fats and resins, the same kind of quantity.

#### P14. Gift size keyed by an item's name: **low / small**
`1695`: `const n = Math.min(count(a, item), item === "berry" ? 2 : 1);`

A name test decides how much of a thing changes hands. Berries are special-cased because they are small; nothing else is.

**Replacement:** a handful is a volume and a mass: how many of a thing fit in a hand follows from the item's size, which `gathered()`/stack sizing already tracks (see the inventory text at 2243 printing real diameters and lengths).

#### P15. A clay deposit disappears on a 25% dice roll: **medium / small**
`1600`: `if (Math.random() < 0.25) removeThing(w, t);`

Whether a material deposit still exists is a coin flip per dig. There is no quantity of clay anywhere: a pit is either there or gone.

**Replacement:** a finite mass per deposit (footprint × workable depth × bulk density ≈ 1.6-2.0 t/m³ for clay), decremented by the mass dug out, exhausted when empty; depth limited by the water table the soil/hydrology module can supply. **Sources:** standard soil bulk-density tables; the `enrich`/`w.fert` soil grid in soil.ts is the natural home for a per-cell mass pool.

#### P16. Harvested plants are hp counters: **medium / medium**
`1603`: `t.hp = (t.hp ?? 3) - 1;` (grain tuft). Same rule family immediately above the slice boundary: `1591-1598` (`t.hp = (t.hp ?? 20) - 3` bush, `(t.hp ?? 6) - 3` reeds, `t.resin - 1`), plus the yield counts `n` in the `GATHER` table (plan.ts:37-46) and `2 + Math.floor(level/4)` berries per pick.

A stand of grass has 3 hit points. Nothing here is a quantity of plant: not biomass, not seed mass, not how much a hand can strip in five minutes, and regrowth has no photosynthetic basis.

**Replacement:** standing biomass in kg per plant (fire-constants sec. 19 already carries shrub-stem and twig allometry for exactly this kind of estimate), reduced by the mass removed, regrown by a relative growth rate that depends on light, water and the soil nutrients the next finding draws down. **Sources:** fire-constants sec. 19 (allometry, already in-repo); published RGR / NPP values for grasses and shrubs. Lines below 1600 belong to the adjacent slice: flagged here so the two aren't fixed differently.

#### P17. Soil is drawn down by a flat -0.004 per item, gated on a list of four kinds: **medium / small**
`1609`: `if (t.kind === "bush" || t.kind === "mushroom" || t.kind === "herb" || t.kind === "reeds") enrich(w, t.px, t.py, -0.004 * n);`

Both halves are high-level rules: a name list decides whether harvesting depletes soil at all (grain, which is stripped for seed two lines above, is exempt), and the amount is a constant per item irrespective of what the item weighs.

**Replacement:** the nutrient mass actually carried off: harvested dry mass × tissue nutrient concentration (N, P, K): subtracted from a soil nutrient pool, for any plant, with return on decay. **Sources:** plant tissue nutrient-concentration tables; nutrient-removal-by-harvest figures from agronomy/forest-nutrition literature.

#### P18. Noticing a theft is trait arithmetic and a dice roll: **medium / medium**
`1948-1949`, and the bystander variant at `1957-1958`:
```ts
const eyes = (x: Agent) => 0.35 + trait(x, "observant") * 0.4 + trait(x, "suspicious") * 0.2 - level(a.skills.pickpocketing ?? 0) * 0.05;
const noticed = !hidden || Math.random() < eyes(b);
...
const saw = bystanders().filter((c) => Math.random() < eyes(c) * 0.6);
```
Five magic coefficients and a flat 0.35 base decide what a person perceives. Seeing is physical and the sim already models it: a theft at midnight in a storm is as visible as one at noon, and the `bystanders()` helper (1660) uses a fixed 30 m radius while `canSee` is given 300 m elsewhere.

**Replacement:** detection from illuminance at the scene, the angular size of the act at the observer's distance, contrast, and occlusion: `lightOn` and `canSee` already supply the inputs, and `light.ts DARK` is already the threshold concept. Traits can bias attention, but should not substitute for the optics. **Sources:** Blackwell's visual-detection threshold data (the standard basis for the kind of luminance/contrast/size model `light.ts` is already reaching for).

#### P19. Whether a victim gets their property back is a 60% roll: **low / small**
`1966`: `const back = r === "confront" && Math.random() < 0.6;`

A physical tug-of-war resolved by a constant. Body mass, strength and injury are all known.

**Replacement:** a grip/force contest through the same `force()` path as P11; the stronger, un-injured, unencumbered party keeps the object.

#### P20. Seeing another person is a flat 300 m with a 150-tick memory: **medium / medium**
`2055-2057`:
```ts
if (b === a || !canSee(w, a, b, VISION)) continue;
if (meters(a, b) <= 30) a.near[b.id] = (a.near[b.id] ?? 0) + 1;
if (!a.seen[b.id] || w.t - a.seen[b.id] > 150) {
```
(`VISION = 300` at line 35; also used at `2140` for who witnesses a collapse.) A hard radius for perceiving a person, a second hard radius of 30 m for "near", and a fixed 150-tick forgetting timer. Same physics gap as P18: whether you can make out a person at 300 m depends on light, weather, terrain and whether they are moving, not on a constant.

**Replacement:** one visibility function (illuminance, contrast against background, angular size, occlusion/canopy, atmospheric clarity) serving people, things and threats alike: the fire system already demonstrates the pattern with `heatAt`/`lightOn`. **Sources:** as P18, plus standard meteorological-visibility (Koschmieder) extinction for fog/rain.

#### P21. A freezing person searches 400 m for a body to huddle with, on a 30-tick cooldown: **low / small**
`2116-2117`:
```ts
if (b && meters(a, b) < 400) {
  a.cooldowns.huddle = w.t + 30;
```
Two invented constants, and the 400 m exceeds the 300 m they can actually see (P20): so a freezing person walks to someone they have no physical way of knowing is there. The reach should fall out of what they can perceive or remember, and the retry out of whether the attempt changed their state.

#### P22. Cross-boundary note: wolf attacks
`2066-2085` reads an `attacked` map and sets fight/flee, but the attack itself: damage, prey selection: happens outside this range (and `life.ts` holds birth/old-age dice: `Math.random() < (age - 6.5) * 0.06` at life.ts:131, a pure mortality die). Recorded so the melee physics of P11 and the mortality bounds of P4 are designed once for both people and animals.

---

### BEHAVIOUR (agent decisions / social: listed briefly)

- `1616-1623` `canMoveIn`: affinity > 0.4, label tests (`kin`/`sweetheart`), shelter-tier comparison.
- `1624-1636` `WRONG_WORDS` phrase table keyed by bond kind; `grudge > 0.3`; trait fallbacks.
- `1637-1642` `answers()`: `needs.warmth < 50` / `needs.food < 50` thresholds and the `WARMS = ["fire","hearth","shelter","worn"]` name list deciding whether knowledge is relevant.
- `1643-1646` `gifts`/`pickGift`/`most`: gift choice by edibility sort; trade choice by largest stack.
- `1684` facts copy at `Math.random() < 0.5` per fact while talking.
- Social-need steps, all flat: `+20` talk (1680-1681), `+25` meal (1730-1731), `+15` fire (1760), `-10` insult (1920), all capped at 100.
- Ledger `±1` per favour (1699, 1732, 1769, 1786…); `deed.value` scalars `0.2`/`0.3`/`0.4`/`0.5` for sharing, teaching, taking in.
- `felt` magnitudes `±0.5…±2` and the bond labels chosen per branch (throughout `interact`), incl. `saved_my_life` for being taken in (1853).
- `1807-1810` refusal weight `(50 - needs.food)/50`, `(40 - needs[need])/40`.
- `1869-1884` gossip: lie chance = `deceitful` trait, belief blend `0.5 * trust`, affinity shift `±0.3 * weight * 0.5`, history capped at 10.
- `1838`, `1869` teach/lesson sampling weights `(1 + Math.min(10, wins)) * (answers ? 4 : 1)`.
- `1975-1976` social cooldowns: `DAY/2` hostile, `40` ticks per pair.
- `2060` any sighting of a stranger drops a goal older than 5 ticks.
- `2069-2070` wolf response: `health > 30 && Math.random() < 0.2 + bold * 0.5`.
- `2076-2077` bystander rescue: `Math.random() < care * 0.6`, 60 m radius.
- `2092` `see(w, a, "fire_spreads", "Fire spreads to anything dry and wooden nearby.")`: a general law handed to an agent as a belief rather than inferred from what they watched; worth noting as an asserted cause even though the trigger (heat from a non-fire source) is physical.
- `2099-2102` reflex thresholds `food < 15`, `warmth < 15`, `energy < 8` (these read the unphysical pools of P1).
- `2146-2151` critical-need interrupt at `< 20` with a 40-tick lockout.
- `2154` dark abandonment: uses `lightOn().bright < DARK` and `nearFire(w, a, 12)`; physical inputs, uncited 12 m fire radius and `DARK = 0.3`.
- `2159` goal deadlines `DAY` / `DAY * 3` keyed by goal-name prefixes.
- `2175` `stages < 20` project cap; `2186` `fails > 2` abandonment.
- `2203-2204` `fadeBonds` daily, `shelve`/`giveUpWaiting` at mid-day.

---

### ALREADY PHYSICAL (this range)

- `2004-2007, 2021` Fire warmth: `rise = (F_P * fire.q * 1000) / (H_R + max(H_STILL, 10.4 * air.wind ** 0.56))`: F_P 0.35, H_R 6, H_STILL 3.4, cited to fire-constants secs. 18 and 31 in the comment above it.
- `2008-2010, 2045-2050` Burns: Purser dose `q^(4/3)` per minute past the 2.5 kW/m² tenability limit, pain at 1.33, third-degree at 16.67: cited sec. 7, with the collapsed-vs-mobile distinction reasoned in sec. 31.
- `2088-2092` Fleeing radiant heat at the same cited BEARABLE threshold, with the "heat from something that isn't a fire" inference.
- `2024` Wetness via `moistureOf / mmax` against the garment's real maximum moisture (wetness.ts; `[design]` in sec. 27 line 1185).
- `2020` Air through `airOn(w, a, inside)`: temp/feels/wind from the air model, not a season switch.
- `2021` `heatAt`: inverse-square from every live source (sec. 31, derived disc/point reconciliation).
- `1606-1607` Gathered items carry real size and moisture (`gathered()` in physics.ts): "a stick … as thick as a stem of its length, a berry as wet as it grew".
- `1593`, `2154` Work and planning rate through `workRate(bright)` / `lightOn` rather than a day/night flag.
- Plumbing, correctly not flagged: `tick()` ordering and `timed`/`bump` instrumentation (2196-2210); `summary`/`agentDetail` (2212-2250); the `ACTIVITY`/`MEETING`/`STEP` icon tables and `activity()`/`heading()` (2252-2302): these map state to UI labels (incl. the `["tree","stump","fallen_log","dead_bush"]` kind list at 2287, which only picks an icon) and decide nothing about the world.

---

### Cheapest high-value fixes in this range

1. **P9 (sun as flux)**: the law and the absorptivity are already written down in fire-constants sec. 18/line 1640; needs irradiance instead of lux.
2. **P5 (cause of death)**: removes a false statement from the chronicle; falls out of P4.
3. **P13 (one eating path)**: delete the duplicate nutrition maths at 1727/1729/1444 and route through `physics.ts eat()`.
4. **P4 + P1 (core temperature and stored energy)**: the big one: the collapse rule, the health tax, the drain rates and most of `warming()`'s leftover flat terms all collapse into one heat-and-energy balance, which the fire side of the same function already half implements.

## ecology.ts, animals.ts, fauna.ts, life.ts, traits.ts

## Audit: ecology.ts, animals.ts, fauna.ts, life.ts, traits.ts

All five files read in full. Citation search (`R\d+|sec\. \d+|\[design\]|\[gap\]|\[derived\]`) across the batch returns exactly three hits, all in ecology.ts: lines 47-48 (sky chain, fire-constants sec. 25b), 246 (fire look interval, sec. 28), 479 (red-heat forge gate, sec. 29g). `docs/research/` contains only `fire-constants.md`, `learning-round5.md`, `README.md`: so no other constant in these files has anywhere to point.

---

### physics

#### Cross-cutting pattern (applies to G1 sites below)

**G1. One random thing island-wide per tick, standing in for a per-object rate.**
`ecology.ts:110` `const t = anyOf(w, "tree")` (lightning), `:372` (nut fall), `:377` (berry dispersal), `:381` (tree dispersal), `:385` (uniform random point for litter), `:444` (butterfly hatch site), `animals.ts:433`/`:438` (random mother).
Each is a global Bernoulli trial that then picks a uniformly random participant, so outcome frequency is independent of how many trees/bushes/animals exist and independent of where they stand. Physically every one of these is a per-object rate integrated over the population: strike attachment per object per unit flash density, seed crop per tree per unit assimilate, fruiting per plant. Replacing the global dice with per-object rates is the single change that makes all seven sites physical at once. **Impact: high. Effort: medium.**

#### Weather, seasons, calendar

**P1. Named season categories and a hardcoded 40-day year.** `ecology.ts:76-82`
```ts
const season = seasonOf(w.t);
if (season !== wx.season) { wx.season = season; log(w, "season", ..., `${...} arrived.`); }
wx.year = Math.floor(w.t / DAY / 40) + 1;
```
`seasonOf` (world.ts:626) is `["spring","summer","autumn","winter"][Math.floor(dayOfYear(t)/10)]`: a quarter-index switch; the `40` here duplicates `YEAR` instead of reading it. The season *name* is then read back by `stormShare` (`:37`) to pick rainfall. Physics: solar declination and the resulting daylight/insolation already exist (`sky.ts daylight/sunAt`, used by cues.ts); a season label should be a presentation projection of declination, never an input. Source kind: orbital geometry (no citation needed, derivable) + the station rainfall climatology behind `SEASONS`. **Impact: medium. Effort: small.**

**P2. Thunderstorm frequency as a linear function of a plant-growth helper.** `ecology.ts:50`
```ts
const storms = 0.02 + 0.06 * warmRate(temp);
```
`warmRate` is cues.ts's 0-1 plant growth curve (nothing at 4 °C, full at 14 °C) being reused as convective potential. Physics: deep convection initiation from CAPE/CIN, with flash rate scaling on cloud-top height or updraft volume. Source kind: lightning climatology (flash density vs surface temperature/dewpoint), e.g. WWLLN/NLDN regressions. **Impact: medium. Effort: medium.**

**P3. Sky-chain residence constants (partly derived, partly tuned).** `ecology.ts:51,53,56-57`
```ts
if (sky === "clear") return r < 0.25 ? "cloudy" : "clear";
const c = 0.4 - 1.1 * stormShare(t), W = 4 * stormShare(t) * wet, p = ((4 * c + 1) * W) / (4 * (1 + storms / 0.35) * (1 - W));
if (sky === "rain") return r < 0.25 ? "cloudy" : r < 0.25 + storms ? "storm" : "rain";
return r < 0.35 ? "rain" : "storm";
```
`p` is solved analytically and cited (sec. 25b): genuinely good. But `0.25` (clear→cloudy), `c = 0.4 - 1.1*stormShare`, `0.25` (rain→cloudy), `0.35` (storm→rain) and the `4×` wet-hour factor are hand-tuned and uncited; they set every spell duration in the world. Physics: mean cloud-spell and rain-spell duration are directly measurable (Markov transition probabilities fitted to hourly station records). Source kind: hourly synoptic observation series for a comparable maritime climate. **Impact: medium. Effort: medium.** (Note: half-physical already.)

**P4. Wind as an uncited relaxation plus uniform jitter.** `ecology.ts:60`
```ts
export const nextSpeed = (speed, sky, r) => Math.max(0.5, speed + (WIND[sky] - speed) * 0.25 + (r - 0.5) * 2);
```
Also `:87` the direction pull `0.02` / `±0.15`. Physics: this is an Ornstein-Uhlenbeck process; the relaxation rate is 1/τ with τ the measured Lagrangian autocorrelation time of surface wind (hours), and the noise amplitude follows from the measured gust variance, not a ±1 m/s uniform. `WIND[sky]` is itself a sky-category lookup. Source kind: surface wind spectra / gust factor measurements. **Impact: low-medium. Effort: small.**

**P5. Drought as a dry-tick counter plus a temperature threshold.** `ecology.ts:106`
```ts
const drought = wx.dryTicks > DAY * 4 && baseTemp(w.t) > 14;
```
A boolean named condition ("4 days without rain and warm") that other systems read as a world state. Physics: cumulative soil-moisture deficit: the world already computes PET (`penman` in terrain/climate.ts), soil water (`soil.ts soilWaterAt`) and runoff, so drought is `deficit = Σ(PET - precip)` crossing a measured threshold, or directly the Keetch-Byram Drought Index used by the fire literature already cited. Source kind: KBDI definition (Keetch & Byram 1968): likely already an R-number in fire-constants.md. **Impact: high** (feeds dryness/fire). **Effort: small**: the inputs already exist.

**P6. Lightning as a storm-gated dice on a uniformly random tree.** `ecology.ts:109-110`
```ts
if (wx.sky === "storm" && Math.random() < 1 / 150) {
  const t = anyOf(w, "tree");
```
No strike point, no attachment: a tree is chosen without regard to height, isolation, exposure, trunk wetness or terrain. Only the *ignition* of the chosen tree is physical (`struck` in spread.ts). Physics: ground flash density (flashes km⁻² per storm-hour) × island area gives the strike count; attachment point from the electrogeometric/rolling-sphere model (striking distance r ≈ 10·I^0.65), which naturally favours tall exposed objects and hilltops: the terrain already knows heights and `t.size` exists. Source kind: lightning location network flash densities; IEC 62305-1 attachment model. **Impact: high** (sole natural ignition source). **Effort: medium.**

#### Ice

**P7. Ice as a temperature switch with a per-tile dice, and total instant melt.** `ecology.ts:131,139,143`
```ts
if (t < -2) { ... if (edge && Math.random() < 0.25) { w.ice.push(i); grew = true; } }
else if (t > 1 && w.ice.length) { ... w.ice = []; }
```
Three magic thresholds (-2 forms, +1 melts, 0.25 spread per tile per hour), no thickness, and salt water is categorically exempt (`salt[i]` from `sea(w)`) rather than freezing at a depressed point. Physics: Stefan ice growth h = √(2 k ΔT t /(ρ L)) driven by freezing-degree-days, freezing-point depression ΔT_f ≈ -0.054 °C per psu salinity, melt from the net surface energy balance (shortwave already available via light.ts, plus turbulent flux). Thickness then decides whether ice bears a body's weight. Source kind: sea/lake ice growth literature (Stefan/Zubov coefficients), seawater freezing point tables. **Impact: medium. Effort: medium.**

**P8. Fixed fall-through injury.** `ecology.ts:146-147`
```ts
a.needs.health = Math.max(0, a.needs.health - 25);
a.needs.warmth = Math.max(0, a.needs.warmth - 50);
```
Physics: cold-water immersion: core cooling rate from water temperature, immersion duration and the (wetted) insulation of clothing, i.e. the same heat-loss equation the body physiology already uses; wet clothing's insulation collapse is a measured factor. Source kind: cold-water immersion physiology (Golden & Tipton). **Impact: medium. Effort: small.**

**P9. Every ground animal on water dies instantly at thaw, by category flag.** `ecology.ts:154`
```ts
for (const an of w.animals) if (FAUNA[an.species].ground && wetAt(w, an.px, an.py)) an.hp = 0;
```
`ground` is a boolean in a name-keyed table (fauna.ts), and death is instantaneous and total: a deer and a rabbit drown identically, and nothing can swim. Physics: body density/buoyancy and limb power decide whether a body swims; drowning is hypoxia over tens of seconds, with a cold-water survival time. Deer are in fact strong swimmers: the world asserts the opposite via a flag. Source kind: animal swimming speed/endurance measurements. **Impact: medium. Effort: small-medium.**

#### Pits, traps, wells

**P10. Pit becomes a well by proximity and a one-day timer.** `ecology.ts:164`
```ts
if (t.kind === "pit" && nearWater(w, t.x, t.y, 2) && w.t - (t.born ?? w.t) > DAY) { setKind(w, t, "well"); ... }
```
A named-kind transition gated on "within 2 tiles of water": a pit on a hilltop 2 tiles from a lake fills; one in a damp hollow 3 tiles away never does. Physics: the pit intersects the phreatic surface or it doesn't; inflow by Darcy's law q = -K·∇h with hydraulic conductivity from the soil texture (soil.ts already models soil water, streams.ts the water table's surface expression). Source kind: hydraulic conductivity tables by soil class. **Impact: medium. Effort: medium.**

**P11. Trapped animal escapes on a fixed half-day timer.** `ecology.ts:169`
```ts
if (t.kind === "trap" && t.caught && w.t - (t.until ?? w.t) > DAY / 2) { ... an.state = "wander"; setKind(w, t, "pit"); }
```
Same escape time for a rabbit and a wolf, and the trap always degrades to a pit. Physics: escape is a contest between the animal's jump height / climbing reach (both allometric in body mass) and the pit's depth and wall shear strength, bounded by exhaustion. Source kind: body-size allometry of jump height. **Impact: low. Effort: small.**

**P12. Fixed fall injury into a pit.** `ecology.ts:183` (`a.needs.health - 10`); animal analog `animals.ts:390-392` (no injury at all).
Physics: impact energy mgh over the stopping distance vs tissue tolerance; pit depth is a known dimension. Source kind: fall-injury biomechanics (impact force thresholds). **Impact: low. Effort: small.**

#### Crowding and disease

**P13. Crowding sickness: a once-a-day 12% dice with a named condition.** `ecology.ts:191-199`
```ts
if (w.t % DAY !== Math.round(DAY / 2)) return;
const crowd = w.agents.filter((b) => b !== a && meters(a, b) <= 30).length;
if (crowd < 3 || anyAround(w, a.px, a.py, 300, ["well"])) continue;
if (Math.random() > 0.12) continue;
a.sickness = { until: w.t + DAY, severity: 0.4 };
log(..., `${a.name} fell sick. Too many people, and no clean water.`);
```
Every element is a rule: the midday-only schedule, the 30 m / 3-person crowd definition, a *well within 300 m* as a categorical immunity token, a flat 12%, a fixed severity 0.4 and a fixed one-day duration. The log text also asserts the cause (see P14/A17). Physics: faecal-oral pathogen transmission: contamination load from population density and latrine/refuse distance, pathogen transport and die-off in soil and surface water (already modelled: soil water, runoff, streams), ingested dose from the water actually drunk, and infection probability from a dose-response model (exponential or beta-Poisson, with measured r / α,N50 per pathogen). Source kind: quantitative microbial risk assessment (QMRA) dose-response parameters; pathogen die-off rates in soil/water. **Impact: high. Effort: large.**

**P14. Disease course and transmission as flat per-tick dice.** `ecology.ts:534-543`
```ts
a.needs.health = Math.max(0, a.needs.health - 0.06 * s.severity);
a.needs.energy = Math.max(0, a.needs.energy - 0.05 * s.severity);
...
if (b === a || b.sickness || meters(a, b) > 10 || Math.random() > 0.003 * s.severity) continue;
b.sickness = { until: w.t + Math.round(DAY * (0.5 + s.severity)), severity: s.severity * 0.8 };
```
A single scalar `severity`, a 10 m hard cutoff, a fixed contagion probability, a duration formula and a 0.8 attenuation per generation (so outbreaks always die out by construction). Physics: within-host pathogen load growing against immune clearance (latent/infectious/recovered phases emerge from it), and transmission from exposure = pathogen concentration × contact time, concentration falling with distance (roughly 1/r² for droplets, modulated by ventilation: indoor vs outdoor matters and is knowable from shelter state). Immunity after recovery follows from antibody persistence. Source kind: epidemiological within-host models; measured generation times and R0 per disease class; aerosol dispersion measurements. **Impact: high. Effort: medium-large.**

#### Fire aftermath (fire itself is already physical)

**P15. Burnt stump as fixed numbers plus a 10-day regrowth timer.** `ecology.ts:208`
```ts
if (t.kind === "tree") { setKind(w, t, "burnt_stump"); t.hp = 30; t.maxHp = 30; t.size = 0.6; t.until = w.t + DAY * 10; ...; enrich(w, t.px, t.py, 0.25); return; }
```
The tree's own size and the heat dose it took are both known, yet the residue is constant. Physics: surviving stem/root mass from the burned fraction (heat dose vs bark thickness and cambium kill temperature ~60 °C), ash nutrient yield as a mass fraction of the fuel consumed (wood ash ≈ 0.3-1% of dry mass, with measured K/Ca/P content), and resprouting driven by root carbohydrate reserves and surviving bud bank. Source kind: fire-effects literature (cambium kill thresholds); wood ash composition tables. **Impact: medium. Effort: medium.**

**P16. Ash deposit chosen by kind name and magic sizes; soil enrichment as three magic numbers.** `ecology.ts:218-222`, `:226`
```ts
if (t.kind !== "item" && t.kind !== "stick" && t.size >= 0.4) {
  mark(w, addThing(w, "ash", t.px, t.py, { born: w.t, until: w.t + DAY * 2, size: Math.min(3, t.kind === "bush" ? t.size : 1.2) }));
  enrich(w, t.px, t.py, 0.1);
}
// and: enrich(w, t.px, t.py, 0.03) for a dead campfire, 0.25 for a burnt tree (:208)
```
Kind-name exclusions (`"item"`, `"stick"`), a `size >= 0.4` cutoff, a `kind === "bush"` branch, and enrichment values 0.25/0.1/0.03 with no units. Physics: ash mass = fuel consumed × ash fraction; nutrient addition = ash mass × elemental content per unit soil volume. The combustion model already knows exactly how much fuel burned. Source kind: ash content and ash chemistry of wood/foliage. **Impact: medium. Effort: small** (the mass is already computed upstream).

**P17. Ash disappears on a fixed 2-day timer.** `ecology.ts:368`
```ts
} else if (t.kind === "ash" && t.until! <= w.t) removeThing(w, t);
```
Physics: ash is removed by rain (dissolution and splash/overland transport: rainfall depth and runoff already exist) and by wind entrainment above a threshold friction velocity. Ash should survive a dry calm week and vanish in one storm. Source kind: post-fire ash erosion studies. **Impact: low. Effort: small.**

#### Plants

**P18. Resin as a dice with a hard cap of 2.** `ecology.ts:344-346`
```ts
if (t.scarred && (t.kind === "tree" || t.kind === "stump") && (t.resin ?? 0) < 2 && w.t - t.scarred > DAY && Math.random() < 1 / (DAY * 1.5)) {
  t.resin = (t.resin ?? 0) + 1;
```
Kind-name gate, a one-day delay, a 1/(1.5 days) dice, and an arbitrary ceiling. Physics: oleoresin exudation from a wound: flow rate from resin pressure and viscosity (strongly temperature-dependent, Arrhenius), total yield bounded by resin canal density and wound area, declining as the wound closes with callus. Species matters as a *measured* canal density, not a name branch (conifers vs oak). Source kind: naval-stores/resin-tapping yield measurements (g per wound per day vs temperature). **Impact: medium** (resin feeds firelighting and adhesives). **Effort: small.**

**P19. Berry yield as a capped dice; bush vigour as hp with flat regeneration.** `ecology.ts:339,349-351`
```ts
const BERRY_HP = 20;
if (t.species === "berry" && (t.n ?? 0) < 4 && Math.random() < 1 / 70 && Math.random() < growth(w, t.px, t.py)) { t.n = (t.n ?? 0) + 1; ... }
if ((t.hp ?? BERRY_HP) < (t.maxHp ?? BERRY_HP)) t.hp = Math.min(..., (t.hp ?? BERRY_HP) + 0.02);
if ((t.hp ?? BERRY_HP) <= 0) { setKind(w, t, "dead_bush"); ... log(..., "A berry bush was picked to death."); }
```
Half-physical: `growth()` is the real assimilation term, but it is multiplied by an arbitrary 1/70 and capped at 4 fruit. `hp` is a stand-in for living biomass with a flat +0.02/hour recovery independent of light, water or season. Physics: fruit set = assimilate allocated to reproduction ÷ mass per berry; plant condition = living biomass / leaf area, recovering at the net assimilation rate (so a picked bush recovers fast in summer and not at all in winter: currently identical). Source kind: measured shrub fruit yields (kg ha⁻¹) and reproductive allocation fractions. **Impact: high** (primary food source). **Effort: medium.**

**P20. Dead bushes return to life on a 1/4000 dice.** `ecology.ts:352-353`
```ts
} else if (t.kind === "dead_bush" && Math.random() < 1 / 4000 && Math.random() < growth(w, t.px, t.py)) {
  setKind(w, t, "bush"); t.species = "berry"; t.n = 0; t.hp = BERRY_HP; ...
```
A dead thing becomes a live thing by name switch. Physics: either the root crown survived and resprouts from stored reserves (a measurable carbohydrate budget), or it is genuinely dead and the site is recolonised through the seed bank: which the existing (physical) `seedNear`/seedling path already models. **Impact: medium. Effort: small**: delete and route through recruitment.

**P21. Stump regrowth: fixed timer, warmth gate, magic stem.** `ecology.ts:365-367`
```ts
} else if ((t.kind === "stump" || t.kind === "burnt_stump") && t.until! <= w.t && warm > 0.3) {
  setKind(w, t, "tree"); t.size = 5; t.hp = 53; t.maxHp = 53; ...
```
A 10-day countdown (set at `:208`) plus `warmRate > 0.3`, then a 5 m tree appears instantly. Physics: coppice shoot growth from root reserves, with height accumulating via the same `growthOf` assimilation the saplings use (degree-days, light, soil water, nutrients: all already available at that point). Source kind: coppice regrowth rates by species (m yr⁻¹). **Impact: medium. Effort: medium** (reuse the seedling path).

**P22. Nut fall as a global 30% dice dropping exactly one nut.** `ecology.ts:371-373`
```ts
if (ripening(w.t) && Math.random() < 0.3) {
  const t = anyOf(w, "tree");
  if (t && !ablaze(t)) { const a = Math.random() * Math.PI * 2, d = (1 + Math.random() * 3) / TILE_M; dropPile(..., "nut", 1); }
```
One nut per tick island-wide regardless of how many oaks exist (G1); the phenological gate `ripening` is photoperiod-based (good shape, uncited thresholds: see cues.ts note). Physics: per-tree seed crop as the assimilate allocated to reproduction (with mast-year dynamics emerging from multi-year reserve accumulation), abscission at maturity, and dispersal distance from drop height with wind drift (ballistic + terminal velocity). Source kind: acorn production per tree measurements; mast-seeding literature. **Impact: medium** (nuts are the storable winter food). **Effort: medium.**

**P23. Seed dispersal as two global dice with fixed annuli.** `ecology.ts:376-383`
```ts
if (Math.random() < warm / 100) { const b = anyOf(w, "bush"); if (b?.species === "berry") seedNear(w, b, "berry", 5, 45); }
if (Math.random() < warm / 60) { const t = anyOf(w, "tree"); if (t?.species && !ablaze(t)) seedNear(w, t, t.species, 4, 30); }
```
Forest and shrub expansion for the whole island is two Bernoulli trials per tick, with dispersal as a uniform ring 4-30 m / 5-45 m: a tree 45 m tall in a gale disperses exactly as far as one in still air. Physics: seed production per plant × a dispersal kernel. Wind dispersal: Wald/log-normal kernel parameterised by release height, seed terminal velocity and wind speed/turbulence (all available: `WIND`, `wx.speed`, `t.size`). Endozoochory for berries: frugivore gut passage time × bird movement: crows and gulls are already simulated animals that could actually carry them. Source kind: seed terminal velocity measurements; mechanistic dispersal kernel papers (WALD model). **Impact: high** (determines whether the island forests over). **Effort: medium.**

**P24. A threshold lookup table decides what the world grows.** `ecology.ts:384-396`
```ts
if (Math.random() < 1 / 60 + (1 / 18 - 1 / 60) * warm) {
  const x = Math.floor(Math.random() * W), y = ..., r = Math.random();
  if (r > 0.94 && Math.random() < 2 * fine.fine(fine.cover.bare, mx, mz) * rockAt(isle, mx, mz).ore) { dropPile(w, px, py, "ore", 1); return; }
  const wooded = fine.fine(fine.cover.tree, mx, mz) > 0.45;
[…121ln elided…]

**A4. Metabolism as per-species hand-tuned drains, and starvation as a flat damage rate.** `animals.ts:88`, `:115`, `:329`, `:449`
```ts
d.hunger -= 0.05 + 0.05 * cold;      // deer
wf.hunger -= 0.035 + 0.02 * cold;    // wolf
e.hunger = Math.max(0, e.hunger - 0.04);  // eagle
for (const an of w.animals) if (an.hunger <= 0) an.hp -= 0.05;
```
Three different uncited burn rates with two different cold coefficients, and a universal starvation damage constant: a butterfly and a deer starve at the same rate. The `cold` term (`coldBite`, cues.ts) has the right shape but uncited breakpoints (0 above 6 °C, 1 at -6 °C). Physics: field metabolic rate = BMR × activity multiplier, BMR from Kleiber's law (3.4·M^0.75 W), plus cold thermogenesis from Scholander's thermoneutral model: heat loss = C·(T_body - T_air) with C the measured whole-body conductance (which depends on pelage insulation and body size, so a rabbit suffers far more than a deer at the same temperature). Starvation when fat reserves reach zero, with survival time scaling as M^0.44. Source kind: Kleiber 1932; Scholander et al. 1950; fasting endurance allometry. **Impact: high**: this is the rate that drives every animal population. **Effort: medium.**

**A5. Feeding gains as magic increments.** `animals.ts:98`, `:128`, `:346`
```ts
if (grass) { d.hunger = Math.min(100, d.hunger + 0.35 * Math.min(1, food * 1.6) * (0.35 + 0.65 * warmRate(w.weather.temp))); nibble(w, d); }
meat.n = (meat.n ?? 1) - 1; wf.hunger = Math.min(100, wf.hunger + 30);
e.hunger = 100;   // eagle, after one kill
```
Intake is unrelated to the mass of food consumed; one unit of meat is worth exactly 30 hunger; an eagle's hunger goes to full on any kill. The `warmRate` multiplier on grazing intake is also a category error: plant growth rate standing in for digestibility. Physics: intake = bite mass × bite rate × digestible energy density (MJ/kg), bounded by gut capacity (∝ M^1.0) and passage rate; forage quality varies seasonally as measured digestibility, not as a growth curve. Source kind: functional response / intake rate measurements; feed energy tables. **Impact: high. Effort: medium.**

**A6. Grazing depletion as a dice, -1 hp, ×0.8 size.** `animals.ts:59-62`
```ts
if (Math.random() > 0.02) return;
const t = nearestThing(w, an.px, an.py, ["grass"], (g) => (g.hp ?? 0) > 1, 2);
t.hp = (t.hp ?? 3) - 1; t.size = Math.round(t.size * 80) / 100;
```
A 2% chance per tick removes a fixed amount from one tuft, with a geometric size shrink and a floor at hp 1 that makes grass un-overgrazable. Physics: biomass removed equals the biomass eaten (ties to A5); the tuft's regrowth follows assimilation from remaining leaf area: which is what makes overgrazing possible and self-correcting. **Impact: medium. Effort: small.**

**A7. Forage availability from uncited cover weights and snow factors.** `animals.ts:68-70`
```ts
const browse = fine.fine(fine.cover.shrub, x, z) * 0.6 + fine.fine(fine.cover.tree, x, z) * 0.3;
return Math.min(1, fine.fine(fine.cover.grass, x, z) * (1 - 0.7 * snow) + browse * (1 - 0.3 * snow));
```
Right instinct (reads real cover and snow) but the weights 0.6/0.3 and burial factors 0.7/0.3 are invented, and the result is a 0-1 abstraction rather than a biomass. Physics: available forage = standing biomass per cover type (kg DM m⁻², measured) minus what snow buries, where burial follows from snow *depth* against plant height: `snowAt` already returns depth, and `t.size` gives height, so the 0.7/0.3 constants are replaceable by geometry. Source kind: standing crop measurements by vegetation type; snow-depth forage availability studies. **Impact: medium. Effort: small.**

**A8. Detection and panic as magic radii and hp fractions.** `animals.ts:89,90,101,116,117,134,142,177,353,355`
```ts
const threat = closest(d, n.wolves, 60) ?? closest(d, n.awake, 30);
if (threat || d.hp < d.maxHp * 0.6) { ... }                        // deer
const fire = closest(wf, n.fires, 40), crowd = ...meters(a, wf) <= 15...; if (fire || crowd || wf.hp < wf.maxHp * 0.4)
const scent = ... closest(wf, n.deer, 3000) ?? closest(wf, n.rabbits, 1500)
const threat = closest(r, n.awake, 15) ?? closest(r, n.wolves, 40) ?? diving
```
14 distinct hardcoded sensing radii (15/30/40/60/150/200/400/1500/3000 m), none dependent on terrain, light, wind or cover, plus panic thresholds as fractions of an abstract hp. A wolf smells a deer at exactly 3000 m upwind or down. Physics: visual detection from angular size vs acuity and contrast against background (light.ts already models illumination: and `lightOn(w, a).bright < DARK` at `:139` shows the hook exists); olfactory detection from a downwind concentration plume (Gaussian plume with the existing wind field), which makes scenting directional; audibility from source level minus geometric and atmospheric attenuation. Source kind: animal visual acuity measurements; olfactory detection threshold studies; Gaussian plume dispersion. **Impact: medium. Effort: large.**

**A9. Attack damage as flat decrements.** `animals.ts:160`, `:167`
```ts
target.hp -= 6;                                                 // wolf on deer or rabbit
target.needs.health = Math.max(0, target.needs.health - 5);     // wolf on a person
```
Same bite on a rabbit and a deer; a person loses 5 health per tick indefinitely with no wound. Physics: bite force (allometric in skull size) and tooth geometry vs tissue strength give a wound; outcome follows from blood loss rate, which structure was severed, and subsequent infection. Source kind: bite force measurements (BFQ); wound ballistics/trauma severity scales. **Impact: medium. Effort: medium.**

**A10. Hard population ceilings standing in for carrying capacity.** `animals.ts:104`, `:427`, `:432`, `:437`, `:443`
```ts
if (breeding(w.t) && mate && meters(d, mate) <= 10 && d.hunger > 55 && n.deer.length < 18 && Math.random() < 1 / 400) { ... "A fawn was born." }
if (breeding(w.t) && wolves.length >= 2 && wolves.length < 6 && Math.random() < 1 / 4000) { ... }
if (breeding(w.t) && rabbits.length >= 2 && rabbits.length < 120 && Math.random() < rabbits.length / 2500) { ... }
if (fishes.length && fishes.length < 200 && Math.random() < fishes.length / 6000) { ... }
if (breeding(w.t) && warm && Math.random() < 0.05 && ...butterfly...length < 90) { ... }
```
Five hardcoded ceilings (18 deer, 6 wolves, 120 rabbits, 200 fish, 90 butterflies) and five uncited birth rates. Reproduction is a dice on proximity rather than a physiological event, and litter size is always 1. These caps are *why* the ecology appears stable: remove them and nothing bounds the populations, because the energetics in A4/A5 are not real. Physics: per-species gestation and litter/clutch size (measured constants), conception conditional on maternal body condition (fat reserve threshold), and population bounded endogenously by the forage energy balance and predation. Carrying capacity should be an outcome, never a parameter. Source kind: life-history tables per species (litter size, gestation, age at first reproduction). **Impact: high. Effort: medium** once A4/A5 exist.

**A11. Immigration as a restocking rule, with the log asserting the cause.** `animals.ts:425-426`
```ts
if (deerNow < 4 && Math.random() < 1 / 1500) ashore("deer", 2, "A pair of deer swam ashore.");
if (deerNow >= 8 && !wolves.length && Math.random() < 1 / 4000) ashore("wolf", 2, "Wolves came across the water, following the deer.");
```
Population counts trigger arrivals, and the text asserts a causal link ("following the deer") that exists nowhere in state: the wolves spawn because a counter reached 8. Physics: either a mainland source population with a crossing model (swim distance vs the species' swimming endurance and water temperature), or no immigration at all with the island population standing on its own. Source kind: animal swimming endurance/island colonisation records. **Impact: medium. Effort: medium.**

**A12. Butterflies annihilated by a temperature threshold; life cycle absent.** `animals.ts:442-443`
```ts
if (w.weather.temp < 2 && w.animals.some((a) => a.species === "butterfly")) w.animals = w.animals.filter((a) => a.species !== "butterfly");
```
Every butterfly on the island vanishes the instant air temperature drops below 2 °C, and new adults appear directly among flowers. Physics: insect cold hardiness: supercooling point and chill-injury accumulation (measured LT50 for the species), and a real life cycle (egg → larva → pupa → adult) advanced by degree-days, with overwintering as a diapausing stage. Source kind: insect cold tolerance measurements; degree-day development models. **Impact: low. Effort: small.**

**A13. Eagle kill as a position test, with prey deleted and hunger filled.** `animals.ts:345-347`
```ts
if (e.alt < 2 && d < 3) { w.animals = w.animals.filter((x) => x !== prey); e.hunger = 100; ... }
```
Also `:333` roost selection by a magic `t.size > 12` tree. Physics: strike success as a probability from closing speed and the prey's escape reaction time; prey retrieval limited by lift capacity (raptors carry roughly a quarter to half their body mass), so a large fish cannot simply vanish. Source kind: raptor hunting success rates; load-carrying capacity measurements. **Impact: medium. Effort: small.**

**A14. Perchability as a kind-name table with a tier-indexed array.** `animals.ts:276-281`
```ts
const PERCH: Record<string, (t: Thing) => number> = {
  tree: (t) => t.size, stump: (t) => t.size, burnt_stump: (t) => t.size, boulder: (t) => t.size * 0.8, fallen_log: () => 0.5,
  structure: (t) => [0.5, 1.8, 2.5, 3.2][t.shelter?.tier ?? 0],
};
```
Whether a bird can land is decided by a kind name, and a shelter's height by its tier index. Physics: perchability from geometry: a roughly horizontal element whose diameter falls within the bird's grip range, at its actual height above ground; a shelter's height is a dimension of the built thing. **Impact: low. Effort: small.**

**A15. Death text asserts a cause the state does not support.** `animals.ts:450`
```ts
log(w, "death", [], an, an.hunger <= 0 ? `A ${an.species} starved.` : `A ${an.species} went through the ice and drowned.`);
```
Any animal that reaches hp ≤ 0 with food in its belly is reported as having drowned: including a rabbit a wolf wounded, or a fish an eagle missed. Fix: record the cause at the point the state changed (the codebase already does this for agents via `die(w, a, cause)`). **Impact: low** (narrative truth, but the chronicle feeds agent beliefs). **Effort: small.**

**A16. Founding populations as hardcoded counts and distance bands.** `fauna.ts:87-118`, `:51`
```ts
for (let herd = 0; herd < 2; herd++) { ... for (let i = 0; i < 4; i++) addAnimal(w, "deer", ...scatter(c, 12), { home: c }); }
const den = nearPeople(5, 10, (t) => w.tiles[t] !== Tile.Water);
for (let i = 0; i < 3; i++) addAnimal(w, "wolf", ...scatter(den, 8), { home: den });
for (let k = 0; k < 20; k++) { ... for (let i = 0; i < 4; i++) addAnimal(w, "rabbit", ...); }
for (let i = 0; i < 160 && waters.length; i++) { ... addAnimal(w, "fish", ...) }
// 12 herons, 6×6 gulls, 10×3 crows, 4 eagles, 30×3 butterflies
p.high = heights.sort((a, b) => b[1] - a[1]).slice(0, 24).map(([t]) => t);   // :51 "high ground" = top 24 tiles
```
Every count is a literal, placement is keyed to `Tile.Grass`/`Tile.Water` categories, the wolf den is placed 5-10 tiles from the people for gameplay reasons, and "high ground" is the top 24 tiles by height rather than an elevation. Physics: initial abundance = habitat area × measured density per habitat type (deer km⁻², wolf territory size km², breeding seabird density per km of coast), which the terrain model can already supply. Source kind: wildlife density surveys. **Impact: medium** (sets the starting ecology). **Effort: medium.**

**A17. Habitat medium chosen by species name.** `animals.ts:28-32`
```ts
const passOf = (sp: AnimalSpecies) => (FAUNA[sp].ground ? ground : air);
const pointOf = (sp: AnimalSpecies) => (sp === "fish" ? wetAt : FAUNA[sp].ground ? dryAt : air);
```
Also `animals.ts:34` steers with `an.species === "deer" || an.species === "wolf"` as a flag. Physics: the medium a body can occupy follows from its own properties: gas exchange (gill/lung), density relative to water, wing loading vs the power available. **Impact: low-medium. Effort: small.**

#### Human life course

**L1. A hard population ceiling on births.** `life.ts:10`, `:114`
```ts
const MAX_PEOPLE = 12;
if (w.t % DAY === Math.round(DAY * 0.88) && w.agents.length < MAX_PEOPLE) {
```
The human population is bounded by a constant, not by food, shelter or mortality. Physics: fertility from maternal energy balance: conception suppressed below a body-fat threshold, and lactational amenorrhoea spacing births (both measured in natural-fertility populations); mortality from the physiology already simulated. Population is then an outcome. Source kind: demographic/reproductive ecology of natural-fertility populations. **Impact: high. Effort: medium.**

**L2. Conception as a scheduled evening dice behind a shelter-tier gate.** `life.ts:114-124`
```ts
if (w.t % DAY === Math.round(DAY * 0.88) && ...)
const adults = w.agents.filter((a) => stageOf(w, a) === "adult" && ... && a.needs.food > 40 && a.needs.health > 50);
const home = [...liveThings(w)].some((t) => t.kind === "structure" && ... && (t.shelter?.tier ?? 0) >= 1 && meters(t, a) <= 40);
if (!home || Math.random() > 0.3) continue;
```
Checked once per day at 88% of the day, requires an `adult` age category, food > 40, health > 50, and a tier ≥ 1 structure within 40 m: a building-tier category gating human reproduction: then a flat 30%. Physics: an ovulatory cycle with a per-cycle conception probability (measured fecundability ≈ 0.2-0.25 per cycle, declining with maternal age), modulated by nutritional status; shelter matters only through its real effects (warmth, which is already modelled). Source kind: fecundability studies; maternal nutrition and fertility literature. **Impact: high. Effort: medium.**

**L3. Fixed gestation, unscaled to the world's year.** `life.ts:124`
```ts
mother.pregnant = { father: father.id, due: w.t + DAY * 10 };
```
10 days against a 40-day year is a quarter of a year; human gestation is three quarters. Physics: gestation is a physiological constant in real time; the world needs an explicit day→real-time mapping and should derive the tick count from it. **Impact: medium. Effort: small.**

**L4. Death from old age as a linear-ramp dice with no bodily cause.** `life.ts:130-131`
```ts
const age = ageOf(w, a);
if (age > 6.5 && Math.random() < (age - 6.5) * 0.06) die(w, a, "old age");
```
People are immortal until 6.5 years old, then die by coin flip regardless of nutrition, injury, sickness or cold: the entire body physiology is bypassed. Physics: senescence as accumulating somatic damage that lowers physiological reserve, so the existing stressors (cold, hunger, disease, injury) become lethal with age; the aggregate is the Gompertz-Makeham hazard µ(t) = A + B·e^(c·t) with a measured mortality-rate doubling time (~8 years in humans). Source kind: Gompertz mortality parameters from life tables. **Impact: high** (sole cause of generational turnover). **Effort: medium.**

**L5. Age-category switch gating reproduction and capability.** `world.ts:387`, consumed at `life.ts:115`
```ts
export const stageOf = (w, a) => { const y = ageOf(w, a); return y < 1 ? "child" : y < 5 ? "adult" : "elder"; };
```
Three named stages with step boundaries; an agent is a child one tick and a full adult the next. Physics: a continuous growth curve (mass and stature vs age), with maturation at attained body state and capability (carrying, strength, metabolic needs) scaling off actual body mass. Source kind: human growth reference curves. **Impact: medium. Effort: small.** *(Owner file is world.ts: flagged here because life.ts is the consumer.)*

**L6. Newcomers as a restocking dice.** `life.ts:100`, `:91`
```ts
if (w.agents.length < 3 && Math.random() < 1 / 1500) newcomer(w);
a.born = w.t - Math.round(YEAR * (1.5 + Math.random()));
```
A population count summons a stranger from the sea, with an age drawn 1.5-2.5 years. There is no physical process here at all; at minimum it should be marked `[design]` with its reasoning, or replaced by a mainland population and a crossing model (as with A11). **Impact: medium. Effort: small.**

**L7. Newborns begin with an adult's body state.** `life.ts:66`
```ts
needs: { food: 90, energy: 90, warmth: 90, health: 100, social: 90 },
```
A newborn is created with a near-full energy reserve and adult warmth, so infancy carries no physiological reality: no birth mass, no milk dependency, no elevated surface-area-to-volume heat loss (the single biggest physical fact about infants, and the warmth model could express it). Physics: birth mass as a species constant, nutrition via lactation (maternal energy transfer, a measured kcal/day cost), and heat loss from the infant's actual surface-area-to-mass ratio. Source kind: neonatal thermoregulation and lactation energetics. **Impact: medium. Effort: medium.**

---

### behaviour

- `animals.ts:137-140` wolf predation decision rules: `wf.hunger < 12` takes anyone alone, `< 25` only in darkness or hard frost. The *gates* are cognition; note that `lightOn(w, a).bright < DARK` already reads real light, which is the right pattern.
- `animals.ts:179,183,188,244,246,255,260,268-269,330,348` bird and prey state timers and dice (`inState <= 3`, `> 6`, `> 12`, `> 20`, `> 40`; `Math.random() < 0.002/0.003/0.01/0.02/0.05/0.2`) plus altitude quirks (`10 + quirk(g, 20)`, `60 + quirk(e, 60)`): activity scheduling, not world physics, though they do set energetic costs via A4.
- `animals.ts:44-50` `roam` wander kinematics (0.02 re-aim chance, 0.35 default move odds).
- `life.ts:81-85` `paired()` affinity/trust thresholds (0.45/0.7, bond weight 0.3) deciding who counts as a couple.
- `life.ts:29` grief as `social - 35` with closeness thresholds (`affinity > 0.35`); `life.ts:45-60` trait inheritance (`Math.random() < 0.5`, top-up to exactly 4 traits at `0.4 + rand*0.6`), bio text, and `nameAfter`/ROMAN numeral naming.
- `traits.ts:1-104` the whole file: 97 trait names mapped to prose. No numbers, no world physics; effects live in brain.ts. Nothing to flag here beyond noting that the trait set is a fixed design list.

---

### physical_already

- **Fire burning and spread**: `ecology.ts:244-335`: beds advanced by combustion.ts on a 10 s step cited to fire-constants sec. 28; radiant flux, brand landing, NFDRS ignition odds and tinder selection all delegated to spread.ts.
- **Rain onset in the sky chain**: `ecology.ts:40-57`: the cloud→rain probability `p` is solved analytically from the island's measured wet-hour share, cited to fire-constants sec. 25b (only the surrounding residence constants remain uncited: P3).
- **Wetness, rain wetting and runoff**: `ecology.ts:93-104`: `wetness(w)`, `wetHour`, `runoffHour` are the rebuilt physical path; `wx.temp` from `islandTemp`.
- **Sapling growth and survival**: `ecology.ts:354-364`: niche fit, competitive share, soil water, light and nutrient rate via seedling.ts / plants.ts `growthOf` / light.ts `growRate` / soil.ts `feedRate`; the section comment correctly claims "nothing here asks the season or what a tile is called".
- **Forge reheat gate**: `ecology.ts:479-481`: the red-heat condition is cited (fire-constants sec. 29g) and reads real physical data via `physOf` (the cooling *duration* is not: P32).
- **Trail wear geometry**: `ecology.ts:561-586` (`tread`, `trails`): per-cell rasterisation of actual footfall; plumbing/rendering, correctly outside the rules.
- **Phenology via photoperiod**: `cues.ts` (dependency, not in batch): `breeding`/`ripening`/`lengthening` read real daylight from sky.ts and `warmRate`/`coldBite` read temperature, explicitly avoiding season names. Right *shape*, but every threshold (11 h, 13.5/8.5 h, 4-14 °C, 6/-6 °C) is uncited: this file is the cheapest next candidate for a research doc.
- **Ore exposure partial**: `ecology.ts:389`: reads bare-ground cover and the bedrock's actual ore content; only the `r > 0.94` gate and `2 ×` factor are invented (part of P24).


[Showing lines 1-197 and 319-505 of 505; 121 middle lines (13.1KB) elided. Read artifact://2365 for full output]

## fuel, combustion, spread, wetness, rain, air, light, sky, soil, streams, seedling, plants, cues

## Residual hand-set rules in the 13 assigned files

Method: every line of all 13 files read; every constant and named condition checked against docs/research/fire-constants.md (32 sections, R1-R224) and against the rest of docs/. Nothing in docs/ cites SWING, WIND, COVER, the SUN lux table, DARK, growRate, feedRate, warmRate, coldBite, breeding, ripening, or any part of the seedling hour; where the document mentions one (e.g. "15 m/s, the storm sky's target in air.ts WIND", "DARK's brightness 0.3 is 0.63 lux") it is *recording the sim's existing value*, not sourcing it.

---

### PHYSICS (world outcomes)

#### P1. The sky is a four-value enum, and four hand-set tables read its name  **[impact high, effort large]**
`air.ts:24`, `air.ts:32`, `air.ts:35`, `sky.ts:68`
```ts
const SWING: Record<Sky, number> = { clear: 6, cloudy: 3, rain: 2, storm: 2 };
export const islandTemp = (t, sky) => baseTemp(t) + swing(t, sky) - (sky === "rain" || sky === "storm" ? 2 : 0);
export const WIND: Record<Sky, number> = { clear: 4, cloudy: 6, rain: 8, storm: 15 };   // air.ts
export const COVER = { clear: 0, cloudy: 0.7, rain: 0.88, storm: 0.95 } as const;        // sky.ts
```
Why it is a high-level rule: the weather's name picks the diurnal range, the wind speed, the cloud cover and a flat 2 C penalty. Nothing physical connects "rain" to 8 m/s or to -2 C. Two of the four tables are uncited (SWING, WIND); COVER is uncited *and* contradicts air.ts's `CLOUD = {0.05, 0.7, 0.95, 0.95}`, which **is** cited (sec. 11, NFDRS state-of-weather). So the island currently runs two different cloud covers for the same hour: one for light, one for fuel drying.

Low-level replacement: one continuous state (cloud fraction, or vapour + lifting condensation level) and a surface energy balance. Diurnal range follows from net longwave loss against the surface's heat capacity -- `soil.ts glowAway` already implements FAO-56 eq. 39 (R221) and would give the cloudy-night damping for free, instead of SWING. Rain's cooling is already physical elsewhere (`RAIN = 0.72 kW/m2` per mm/h, sec. 5), so the -2 C becomes wet-bulb depression plus the latent load. Wind needs a momentum source (a prescribed geostrophic/synoptic forcing with Monin-Obukhov surface coupling), not a per-sky target; the doc already measures what it should produce (sec. 25: land wind p50 4.2 m/s, p99 ~10 m/s). Likely sources: FAO-56 (already cited R221); Bristow-Campbell diurnal temperature range vs atmospheric transmittance; Kasten-Czeplak cloud transmittance; any boundary-layer text for the stability correction.

#### P2. The diurnal swing's shape  **[medium, medium]**
`air.ts:26-28`
```ts
return SWING[sky] * (0.4 + (0.6 * noon) / HIGH) * Math.cos((2 * Math.PI * (hourOf(t) - NOON - 2)) / 24);
```
A cosine, peaking a fixed two hours after solar noon, with amplitude floored at 0.4 of the sky's table value and scaling linearly with the midsummer-noon sine. Every number hand-set.

Replacement: the surface energy balance's own phase lag, or the standard Parton-Logan truncated-sine-plus-exponential-night-decay form whose parameters are fitted to measured station data. Source kind: agricultural-meteorology literature (Parton & Logan 1981), or derive the lag from the surface heat capacity the generator already carries.

#### P3. `headWind`'s 0.65 canopy cut -- a cited replacement exists and is unused  **[high, small]**
`air.ts:66-67`
```ts
speed * leeAt(w, px, py, way) * (1 - 0.65 * Math.min(1, canopyAt(w, px, py)));
```
A flat 35% floor under any density of trees, saturating at one crown's worth of cover. sec. 14a records this exact value as the sim's *existing* behaviour ("under trees the sim's head-height wind is already cut by canopy (air.ts: 0.65 x canopy)") and flags the near-floor layer as a gap -- it is not a source. This one number feeds fuel drying, fire spread, flame blow-off, crown drying, brand flight and wind chill, so it is the single widest-reaching uncited constant in the batch.

Replacement: Albini & Baughman's sheltered wind adjustment factor, already tabled in sec. 14a from R81: `WAF = 0.555 / (sqrt(f H) ln((20 + 0.36 H)/(0.13 H)))`, with `f` the crown fill fraction (canopy cover / 3 x crown ratio) -- and `canopyAt`, `CROWN` (0.5, R98) and tree height are all already available. Source: R81 (Albini & Baughman 1979), already in the bibliography.

#### P4. `placeTemp`'s cold pool: five degrees, by fiat  **[medium, medium]**
`air.ts:83-85`
```ts
const night = Math.max(0, -Math.cos((2 * Math.PI * (hourOf(t) - NOON - 2)) / 24));
const calm = Math.max(0, 1 - speed / 6), clear = sky === "clear" ? 1 : sky === "cloudy" ? 0.3 : 0;
return off - pool * 5 * calm * clear * night;
```
Four hand-set factors and a sky-name switch: a hollow is up to 5 C colder, suppressed linearly to nothing at 6 m/s, and cloud is worth exactly 0.3 then 0.

Replacement: nocturnal cold-air drainage as a budget -- the radiative cooling rate (net longwave, `glowAway`, already cited) acting on the shallow stable layer's heat capacity, minus turbulent mixing gated by a Richardson number or a critical wind speed derived from the terrain's slope and the layer depth. Source kind: cold-air-pooling field studies (Whiteman, Gustavsson) for the depth and the observed inversion strength; the mixing cut-off is derivable from the stability criterion rather than set.

#### P5. Snow cover from a 3-to-30 mm ramp  **[medium, small]**
`air.ts:98-101`
```ts
x = Math.max(0, Math.min(1, (pack - 3) / 27));  return x * x * (3 - 2 * x);
```
"Thin from a few millimetres of water and whole by thirty" -- a smoothstep with no basis. It decides whether tinder is buried (`wetness.ts:308`) and whether grazers find grass.

Replacement: snow depth from SWE and a snow density (measured, seasonal), then fractional cover from a depletion curve against the ground's roughness length -- the standard land-surface parameterisation, and the roughness is already in the model (z0 0.005 bare, 0.013 short grass, sec. 14a). Source: snow-hydrology literature (areal depletion curves).

#### P6. `STORMY` is measured from the sim's own old sky model  **[medium, medium]**
`air.ts:118`, `air.ts:132`
```ts
const STORMY = [0.113, 0.242, 0.099, 0.024];
```
The comment is honest ("the sky model's own (sec. 25), which this leaves as it was") -- it is self-referential, a property of the former transition table rather than of the climate. The wet-hour share round it (`LONDON`/`IRELAND`, `air.ts:117`, `131`) **is** cited (R211-R213) and is a good model of what to do instead.

Replacement: the convective share from a thermodynamic index. sec. 13 already cites the relation and doesn't use it: R79, "the convective share grows about 41% per C from 7 to 22 C", stratiform dominating near dew point 5 C and convective near 18 C. The sim has temperature and vapour at every point. (The consumer, `ecology.ts nextSpeed`/`nextSky`, is outside the assigned files, but it reads only `WIND`/`STORMY`/`warmRate` from them -- so fixing these tables fixes it.)

#### P7. The `SUN` lux table: a second, uncited model of a sun the code already computes physically  **[medium, medium]**
`sky.ts:53`
```ts
const SUN: [number, number][] = [[-18,-3],[-12,-1.2],[-6,0.6],[-3,1.6],[0,2.7],[3,3.3],[10,4.0],[20,4.5],[40,4.9],[90,5.1]];
```
Ten hand-set breakpoints of log10 lux against solar elevation. Meanwhile `air.ts sunOn` computes the same sun's irradiance from the cited clear-sky beam (`1381.6 * 0.745^(1/sin el)`, sec. 11, R70). Two independent suns.

Replacement: illuminance = the cited irradiance times the luminous efficacy of daylight (measured, ~105-120 lm/W global, higher for diffuse), plus a scattering model for the twilight tail below the horizon. Source: CIE daylight illuminance data / luminous-efficacy measurements; twilight from a single-scattering atmosphere.

#### P8. Moon and star lux  **[low, small]**
`sky.ts:62-64`
```ts
const MOON_LUX = 0.25;  export const STAR_LUX = 0.0015;
export const moonLux = (m) => MOON_LUX * m.lit * Math.max(0, Math.sin(m.el)) ** 0.8;
```
0.25 lx for a full moon and 0.0015 for starlight are real textbook figures but uncited here, and `^0.8` is a fitted air-mass stand-in. With `DARK` (P11) these decide what people can do at night.

Replacement: lunar illuminance from the phase angle with the measured opposition surge (the moon is not linear in illuminated fraction -- a full moon is ~10x a half moon, which `m.lit` cannot produce), times atmospheric extinction by air mass. Source: lunar photometry (Krisciunas-Schaefer model, or the standard lunar phase curve).

#### P9. Cloud transmittance and the beam/diffuse split  **[medium, small]**
`sky.ts:69`, `sky.ts:72`
```ts
export const through = (cover: number) => 1 - 0.9 * cover;
export const beam = (el, cover) => 0.8 * Math.sqrt(Math.max(0, Math.min(1, el / (20 * DEG)))) * (1 - cover);
```
Linear in cover, with the beam share ramping as a square root to 0.8 at 20 degrees of elevation. No source.

Replacement: Kasten-Czeplak, `G = G0 (1 - 0.75 (N/8)^3.4)` (strongly non-linear, which `1 - 0.9 cover` is not), and a beam/diffuse split by clearness index (Erbs or Reindl correlation). Source: solar-resource literature; both are standard cited correlations.

#### P10. The canopy's geometry comes from sprite widths  **[high, medium]**
`light.ts:18-25`
```ts
const SHARE: Record<string, number> = { oak: 0.35, ash: 0.29, pine: 0.18 };
const CORE = 0.55, EDGE = 1.2;
const r = (SHARE[t.species ?? ""] ?? 0.22) * t.size;
return d > r * EDGE ? 0 : d <= r * CORE ? 1 : 1 - smooth(CORE, EDGE, d / r);
```
The comment says outright where these come from: "the width sprites.js draws it at". A species lookup keyed on a name, scaled by an art asset, with a hand-set hard core and a hand-set smoothstep edge -- and `crownCover` is the input to rain interception (`rain.ts rainThere`), wind (`air.ts headWind`), fuel drying, light, and plant growth.

Replacement: crown radius from allometry and cover from LAI. sec. 19 already holds stand-grown crown allometry for these same four species (iLand R97, BAAD R98 -- the latter is already used for `CROWN = 0.5`), and sec. 11 cites Beer-law light transmission through crowns (R70, J 0.10-0.20 per ft). A cited replacement for both the radius and the profile is therefore already in the document and unused.

#### P11. Two-crown extinction cap and hand-set optical depth  **[high, medium]**
`light.ts:47-48`, `light.ts:53`, `light.ts:142-143`
```ts
const LEAVES = 2.6;
const sieve = (cover: number) => LEAVES * Math.min(cover, 2);
export const skyShare = (w, px, py) => Math.exp(-0.8 * sieve(canopyAt(w, px, py)));
const glow = Math.exp(-0.8 * tau), shaft = Math.exp(-tau / Math.max(0.2, Math.sin(s.el)));
```
The `Math.min(cover, 2)` is a hard rule: past two overlapping crowns no further light is lost, whatever stands there. 2.6 optical depths per crown and the 0.8 diffuse coefficient are hand-set. The `1/sin(el)` path lengthening is right in form (and the 0.2 floor keeps it finite), but nothing cites the coefficients.

Replacement: Beer-Lambert over the summed LAI along the actual path, with a measured extinction coefficient per species and a separate diffuse coefficient from the sky's radiance distribution -- no cap, since optical depth is additive. Source: R70's J values (already cited), or canopy-radiation measurements (LAI-2000-class literature).

#### P12. `growRate`: a quarter speed in the deepest shade  **[high, medium]**
`light.ts:51`
```ts
export const growRate = (w, px, py) => 0.25 + 0.75 * skyShare(w, px, py);
```
A linear map from light transmission to growth rate with a hand-set floor. Every seedling, berry bush and grass patch reads it.

Replacement: the light-response curve of photosynthesis -- a non-rectangular hyperbola (or Thornley/Farquhar form) saturating at a measured PPFD, with dark respiration setting a compensation point *below which net growth is negative*, not 0.25. That is the physically important difference: today deep shade merely slows a plant; it should be able to kill it. Source: plant-physiology light-response measurements per functional type (shade-tolerant vs intolerant), which would also replace the species lookup in P10 with a real trait.

#### P13. The brightness scale and `DARK`  **[high, small]**
`light.ts:151`, `light.ts:166`
```ts
bright: clamp((Math.log10(Math.max(lux, 1e-6)) + 2) / 6, 0, 1)
export const DARK = 0.3;
```
A hand-set log mapping ("a hundredth of a lux is black, ten thousand is full day") and a threshold on it. sec. 31 only records the consequence ("DARK's brightness 0.3 is 0.63 lux"); it is not sourced. `DARK` gates foraging, exploring, hunting, wolf predation of a lone person, and the replan trigger.

Replacement: visual performance as a function of luminance -- the mesopic/scotopic transition, where acuity and contrast sensitivity collapse between roughly 0.1 and 1 lx, from measured contrast-threshold curves. If `canSee` (below) carried that one law, `DARK` would fall out as a consequence rather than a constant. Source: vision science (Blackwell contrast thresholds; CIE mesopic photometry).

#### P14. `feedRate`: fertility to growth by fiat  **[high, large]**
`soil.ts:77`
```ts
export const feedRate = (w, px, py) => 0.75 + 0.5 * smooth(0, 0.5, fertilityAt(w, px, py));
```
Barren ground grows at 0.75 and the richest silt at 1.25, on a dimensionless 0..1 fertility index. No source, and the range is narrow enough that soil nourishment barely matters -- which is itself an outcome set by hand.

Replacement: nutrient limitation on a real pool -- available N (and P) in kg/ha, with a Mitscherlich/Liebig or Michaelis-Menten uptake response, and a growth rate limited by the scarcest resource. This requires `fertility` to become a measured nutrient mass rather than an index, which is why effort is large. Source: soil-fertility response curves (classical agronomy), N mineralisation rates.

#### P15. The fertility ledger: dung, ash and washout all hand-set  **[medium, medium]**
`soil.ts:14`, `soil.ts:80-96`
```ts
export const FERT_CELL = 25;
const v = clamp((w.fert[k] ?? 0) + amount, -0.5, 0.5);
for (const an of w.animals) if (FAUNA[an.species].ground) enrich(w, an.px, an.py, 0.008);
for (const a of w.agents) enrich(w, a.px, a.py, 0.01);
const v = w.fert[k] * 0.97;   // "three percent a day ... half gone in some three weeks"
```
This is the "decays 3% a day" pattern exactly: an index with hand-set deposits, a hand-set +/-0.5 ceiling, a hand-set exponential washout and a 25 m cell. A species boolean (`FAUNA[...].ground`) decides who dungs at all.

Replacement: a nutrient mass balance. Excretion is measured per animal per day and scales with body mass and intake (both already in the model); ash yield and its N/P/K content follow from the fuel mass burnt and its composition, which `combustion.ts` already tracks exactly (char yield, mass lost); loss is leaching driven by drainage, which `soil.ts wetHour` already computes, plus plant uptake as the sink. Then nothing needs a decay rate. Source: animal-nutrition excretion tables; wood-ash composition analyses; leaching coefficients from soil science.

#### P16. `growthOf`'s soil-water ramp ignores the cited stress coefficient in the same repo  **[high, medium]**
`plants.ts:27-29`
```ts
const dry = Math.max(0, Math.min(1, (water - 0.05) / 0.3));
return warmRate(temp) * dry * dry * (3 - 2 * dry) * light * feed;
```
Growth is zero below 5% of the root-zone bucket and full at 35%, smoothstepped. Both cuts are arbitrary, and `water` is a dimensionless 0..1 fill, so the rule cannot know a sand from a clay.

Replacement: water stress from matric potential, between field capacity and the wilting point (-1.5 MPa), via van Genuchten or Brooks-Corey on the soil texture the generator already carries (`isle.sandy`, `isle.clayey`, `isle.humus` are read at `soil.ts:71`). Simpler and already cited in-repo: FAO-56's water stress coefficient `Ks = (TAW - Dr)/((1 - p) TAW)` -- R221, the same source `soil.ts` already uses for evaporation. The irony is worth naming: soil.ts imports R221's evaporation side and plants.ts ignores R221's stress side.

#### P17. `warmRate`: a second, divergent temperature ramp beside the cited one  **[high, small-medium]**
`cues.ts:14`
```ts
export const warmRate = (temp) => { const x = clamp((temp - 4) / 10, 0, 1); return x * x * (3 - 2 * x); };
```
Zero at 4 C, full at 14 C. Uncited -- and `wetness.ts:231` (`dayOf`) already runs a *cited* temperature ramp for the same purpose, R72's GSI minimum-temperature ramp from -2 C to 5 C. Two temperature responses for plant growth, one cited and one not. `warmRate` is also what sets the storm probability in `ecology.ts nextSky` (`0.02 + 0.06 * warmRate(temp)`), so a plant-growth curve is doubling as a convective index.

Replacement: a cardinal-temperature response -- base, optimum and maximum temperatures measured per functional type (the beta function or Yan-Hunt form), with Tbase near 0-5 C for temperate grasses and distinct values for trees. Source: crop/plant physiology cardinal-temperature compilations. The storm use should move to P6's thermodynamic index.

#### P18. `coldBite`: an animal's heat budget as a straight line  **[medium, small]**
`cues.ts:16`
```ts
export const coldBite = (temp) => Math.max(0, Math.min(1.2, (6 - temp) / 12));
```
Zero above 6 C, 1 at -6 C, capped at 1.2. Body physiology, so in scope. No source, no species dependence: a mouse and a deer feel the same cold.

Replacement: the Scholander-Irving thermoneutral-zone model -- metabolic rate is flat down to the lower critical temperature, then rises linearly with slope = thermal conductance, both measured per species and scaling with body mass (Kleiber) and insulation. `air.ts chill` already supplies the right driving temperature. Source: comparative-physiology measurements of LCT and conductance.

#### P19. Photoperiod cuts for breeding and ripening  **[medium, medium]**
`cues.ts:10`, `cues.ts:12`
```ts
export const breeding = (t) => lengthening(t) && daylight(day(t)) > 11;
export const ripening = (t) => !lengthening(t) && daylight(day(t)) < 13.5 && daylight(day(t)) > 8.5;
```
The *form* is good -- these read day length, not a season name, which is what the file's header promises. But 11 h, 13.5 h and 8.5 h are set by hand, and one pair of cuts covers every tree, bush and animal.

Replacement: critical photoperiod is a measured species trait (and differs between a pine and a bramble, a deer and a wolf); fruit ripening is better as accumulated thermal time from flowering (degree-days above a base temperature) than as a daylength window. Source: phenology literature per species; degree-day requirements from horticulture.

#### P20. The seedling's drink curve  **[high, medium]**
`seedling.ts:38`
```ts
const drink = smooth(0.35, 0.75, (soil + (s.water ?? 0)) * share);
```
A smoothstep between two hand-set cuts on a dimensionless bucket fill, multiplied by a crowding share. The operator named this one; it is the clearest case in the batch. Note also that the seedling reads the *root-zone* bucket (`soilWater`) although the file's own comment says "its shallow roots want the soil moister than a grown plant does" -- the shallow store it should read (`Weather.wet` over `TEW`, the top 10 cm) already exists and is cited (sec. 25d).

Replacement: uptake against matric potential, as P16 -- FAO-56's `Ks` on the *top-soil* depletion, with the seedling's own rooting depth setting which store it draws from. Source: R221 (already cited) plus the soil retention curve.

#### P21. The stage rate: five hand-set factors  **[high, large]**
`seedling.ts:39`
```ts
s.stage = (s.stage ?? 0) + (12 / (3 * DAY)) * (tree ? 0.25 : 1) * grows * (0.4 + 0.6 * drink) * (0.5 + 0.5 * fit) * share;
```
Three sim-days to come up; a tree four times slower because it is a tree; a floor of 0.4 on water; a floor of 0.5 on niche fit; crowding linear. Every one of the five is a fixed rate with no physical basis, and `tree ? 0.25 : 1` is a category switch picking a growth rate from a kind.

Replacement: biomass accumulation to a threshold mass -- intercepted light (already computable from `crownCover`/`skyShare` once P10-P11 are physical) times a measured radiation use efficiency, minus maintenance respiration, against the dry mass a seedling must reach to be established. The tree-versus-bush difference then falls out of seed reserve mass and species RUE rather than a multiplier; the water and fit floors fall out because a plant below its compensation point loses mass rather than gaining it slowly. Source: RUE measurements per functional type; seed-mass and establishment-mass data.

#### P22. The 5-point health bar  **[high, medium]**
`seedling.ts:40`
```ts
s.hp = Math.min(s.maxHp ?? 5, (s.hp ?? 5) + 0.25 * (fit * drink * share - 0.25));
```
This is the "hp -1 per use / heals 5 a tick" pattern in plant form: a 5-point bar, healing or losing 0.25 an hour, with the break-even set at a product of three dimensionless indices crossing 0.25. Death (`s.hp <= 0`) is a counter running out.

Replacement: a carbon balance -- the seedling dies when its reserves are exhausted, i.e. when cumulative gross assimilation stays below maintenance respiration long enough to consume its stored mass. Or hydraulically: death when soil potential stays below the species' wilting point past a measured cavitation-time curve. Either gives a real mortality mechanism with measurable constants. Source: seedling mortality experiments (drought-survival time vs potential); respiration rates per unit biomass.

#### P23. Poured water decays 3% an hour  **[medium, small]**
`seedling.ts:41`
```ts
if (s.water && (s.water *= 0.97) < 0.02) delete s.water;
```
A fixed exponential decay of a separate water pool, deleted below a hand-set floor.

Replacement: water poured on the ground is infiltration into the top-soil store, then drainage and evaporation -- all three already modelled and cited (`soil.ts wetHour`, FAO-56). Done properly, `s.water` ceases to be state at all: the seedling reads the soil, and the soil already knows how to lose water.

#### P24. `shareAt`: competition as a 2 m radius and three weights  **[high, medium]**
`seedling.ts:30-32`
```ts
around(w, px, py, 2, ["tree", "bush", "dead_bush", "sapling"], (o, d) => {
  ... take += Math.max(0, 1 - d / 2) * (o.kind === "tree" ? 1.5 : o.kind === "sapling" ? 0.3 : 1); });
return 1 / (1 + take);
```
A hard 2 m cut-off, a linear falloff, and three weights picked by kind name. A 20 m oak and a 1 m bush differ by a factor of 1.5, and a tree 2.1 m away counts for nothing.

Replacement: split the two resources the share currently conflates. Light competition is already computable from the crowns (`crownCover` at the seedling's point) once P10-P11 are physical -- it needs no radius. Water competition is root-zone overlap: root lateral spread scales with crown radius or stem diameter (measured), and the share follows from root length density at the point. Source: root-system allometry (root spread vs DBH); competition-index literature for the density weighting.

#### P25. `nicheOf`: an item-name lookup decides what a seed becomes  **[low, small]**
`seedling.ts:22`, `seedling.ts:25`
```ts
export const treeOf = (t) => TREES.includes(t.species ?? "") || t.item === "nut";
export const nicheOf = (t) => (treeOf(t) ? (t.species && t.species !== "berry" ? t.species : "oak") : t.item === "grain" ? "grass" : "berry");
```
A nut becomes an oak, grain becomes grass, anything else becomes a berry bush, by name. The seed should carry its own species (the data model already supports `species`), and planting should read it.

#### P26. `tinder()`: two hand-set property cuts standing in for a smouldering criterion  **[medium, medium]**
`wetness.ts:31`
```ts
export const tinder = (k?: Kind) => !!k && !k.parts?.length && p(k, "fibrous") >= 0.6 && p(k, "flammable") >= 0.7;
```
Better shaped than most (it reads material properties, not names), but the two cuts are set by hand and the result is a boolean where the physics is continuous. sec. 10 already names the gap honestly: "the physical record says sparks need charred or fungal tinder, which the sim does not have; the 10% limit stands in for 'tinder fine and dry enough to hold a glow'".

Replacement: whether a glowing point sustains and spreads in a fuel follows from the fuel's own thickness, packing and char-forming tendency -- all present in `fuel.ts` (`d`, `charYield`, `rho`) -- against a smouldering-propagation criterion. The cited anchors exist: R47 (single 19-25 mm dowels never sustain smouldering, touching ones can) and R197 (minimum self-sustaining surface 350 +/- 20 C), both already in the bibliography.

#### P27. Two different radiant-flux laws for the same fire  **[medium, small]**
`wetness.ts:52-57`
```ts
const f = nearestThing(w, at.px, at.py, ["fire"], (t) => !!t.bed, 3);
...
return (CHI_R * (o.flaming + o.glowing)) / (4 * Math.PI * Math.max(0.5, meters(at, f)) ** 2);
```
`CHI_R = 0.3` is cited (sec. 7), but the rest is hand-set and contradicts the cited form next door: only the single nearest fire counts, only within 3 m, and distance is floored at 0.5 m -- whereas `light.ts:103-109` sums *every* source with the cited finite-disc law `I / (d^2 + r^2)` (sec. 31: "Every source counts at every distance; the old cut at 80 m goes").

Replacement: call `light.ts heatAt`, which is already the cited law. This is a one-line cutover and removes a divergent model.

#### P28. `sheltered()`: an absolute roof within 4 m  **[medium, medium]**
`wetness.ts:27-28`
```ts
return !!anyAround(w, a.px, a.py, 4, ["structure"], (t) => (t.shelter?.tier ?? 0) >= 1);
```
A binary: within 4 m of any tier-1 shelter, no rain falls on you at all, in any wind. sec. 25c records this as a gap ("huts and fallen logs cast no rain shadow (a roof within 4 m keeps the rain off altogether)").

Replacement: a roof is an obstruction like a crown or a boulder -- `rain.ts` already computes drop drift and tests whether a slanting drop's path passes through a solid (`rainThere`'s boulder loop). Giving a shelter its footprint and height makes it a shadow-caster in the existing cited model, and rain blows in under an eave in a gale as it should.

#### P29. Ground tinder: a name map, a snow cut, an arm's reach  **[low, small]**
`wetness.ts:300`, `wetness.ts:308-310`
```ts
const GROUND_TINDER: Record<string, string> = { grass: "...", fern: "...", dead_bush: "..." };
const buried = snowAt(w, a.px, a.py) > 0.5;
const t = nearestThing(w, a.px, a.py, buried ? ["dead_bush"] : Object.keys(GROUND_TINDER), () => true, 2);
```
The kind-to-thickness choice (`dead_bush` read at `REF[1]`, grass and fern at `REF[0]`) is sound and cited. The snow burial cut (0.5 cover, from P5's uncited ramp) and the 2 m reach are hand-set; the phrase table is UI text and not itself a finding.

Replacement: burial follows from snow depth against the plant's height -- both already available (`t.size`, and a real depth from P5) -- not from a cover fraction crossing a half.

#### P30-P34. Documented design readings (flagged, but already marked in the research doc)
- `combustion.ts:146-160` `lies()` -- the lay's shells, `touches`, and "two pieces of a kind lie against each other". sec. 28 marks it: "the lay's shells are a design reading of how fires are laid, not measured". **[medium, large]** A real replacement is a packing/contact model over piece geometry.
- `combustion.ts:63` `STEP = 10, TENTH = 0.1`, and `DAY = 86400` as the projection horizon -- numerical tolerances, marked [design] in sec. 28 ("the plan's deferred tolerance"). Not world rules; listed for completeness.
- `combustion.ts:395` `buried` (coals cover a thing as the square of heap breadth over thickness) -- marked [design] in sec. 29g, in the code comment too.
- `spread.ts:128-145` `partsOf`/`halfOf` kind dispatch -- marked [design] in sec. 30a ("Grass, bushes and shelters spread half their width either side of where they stand; anything else is taken at its middle"). The dispatch assembles cited physical parts, so it is structure, not a behaviour switch.
- `wetness.ts:275-276` bare skin as a 1 mm piece, kept above 0.005 -- marked [design] in sec. 27f.

---

### BEHAVIOUR (agent/social; listed briefly per the brief)

- `light.ts:168-169` `workRate = clamp(0.15 + 1.1 b, 0.2, 1)`, `moveRate = clamp(0.55 + 0.7 b, 0.55, 1)` -- hand-set performance curves against brightness.
- `light.ts:171` `restRate = 0.55 + 0.45 (1 - clamp((b - 0.25)/0.55, 0, 1))` -- sleep quality against light, three hand-set numbers.
- `light.ts:176-181` `canSee` -- range scaled by `clamp((b - 0.05)/0.6, 0.1, 1)`, a 0.7 penalty for a viewer in glare more than 0.2 brighter. Worth noting that this is the natural home for P13's physics: if detection came from a measured contrast-threshold law, `DARK` and these ramps would be consequences.
- `light.ts:184-188` `lightWords`, `air.ts:180-183` `airWords` -- phrase thresholds. UI text; not flagged.
- `soil.ts:91` people enrich 0.01 a day -- a body output rather than a decision, counted in P15.

---

### ALREADY PHYSICAL (standard met)

- **`fuel.ts`** -- every property of every kind from sec. 27a-27e, each row carrying its source or an explicit [analogue]/[design]/[gap]; `fuel.test.ts` holds the code to the document. The kind-keyed tables hold *measured properties*, not outcomes, which is the pattern the rest should follow.
- **`combustion.ts`** -- ignition (R4 Eq. 7, R2 kρc, sec. 1), burning (Heskestad crib, Anderson large-fuel, sec. 3), extinction (3.5 g/m2s), blow-off (sec. 14b's Froude-times-flux form), air supply (sec. 15), convection (Churchill-Bernstein), rings/covers/blown air/smoulder/coals (sec. 29). Every constant carries a section number.
- **`spread.ts`** -- tree allometry (sec. 19, iLand/BAAD), crown dead share, grass load (Anderson fuel model 3, R32), brands (Albini D44, R27-R29), NFDRS ignition odds (R30), Heskestad flame height and Thomas tilt (sec. 4).
- **`wetness.ts`** (the wetting model) -- Simard EMC (R30), Byram-Jemison fuel temperature and humidity (R70, sec. 11), the d^2 timelag anchored on Nelson's 10-h stick, green-wood τ (sec. 20), the exactly-solved skin/heart pair (sec. 27g), the NFDRS v4 GSI with green-up 0.2 and the 1978 curing transfer (R72, sec. 12), the 120-hour weather window with its [design] justification.
- **`rain.ts`** -- Marshall-Palmer drop spread and Atlas fall speed (R218, R219), log-profile drift, Rutter's bucket with cited `p` and `S` per species (R214-R217), Gash stemflow 0.029, FAO-56 wet-canopy Penman-Monteith (R221), Sharon's slope model (R222). Its three soft readings (boulder dome, 0.88 absorption, wind at 2h) are each marked in sec. 25c.
- **`soil.ts`** (the water half) -- `glowAway` (FAO-56 eq. 39), `referenceEt` (eq. 53), `REW`/`TEW` 9/19 mm as Table 19's loam midpoints, `KC_MAX` 1.2, `topKr` (stage-2 reduction), `wetHour`, `soilWater` -- all R221 via sec. 25d, with the root-zone coupling marked [design].
- **`streams.ts`** -- runoff as a linear store keeping 0.55 a day, the middle of surface runoff's cited 0.3-0.8 (R224); `quickNow` derived from it with its reasoning stated.
- **`air.ts`** (the rain, humidity, sun and chill half) -- wet-hour share interpolated between two cited stations (R211-R213), storm-to-rain K = 5 (sec. 13), a wet hour raining as a real one (sec. 25b), `CLOUD` from the NFDRS state-of-weather table (sec. 11), `sunOn` as the cited clear-sky beam, `chill` as Environment Canada's index, `vapourAt`/`leeAt`/`slopeAt`/`placeTemp`'s season offsets read straight from the generator's fields.
- **`sky.ts`** (the astronomy) -- declination, hour angle and `bodyAt` are exact spherical geometry; `LAT` 52 N, `TILT` 23.44, `LUNAR` 29.53 are real; `YEAR_DAYS` 40 and `NOON` 13 are declared world design, not disguised physics.
- **`plants.ts`** (`fitHere`, `envHere`, `pickHere`) -- plumbing over the generator's niche model; it reads conditions and draws by fit, deciding nothing itself.

---

### Ranking, if the next pass takes them in order

1. **P3** headWind's 0.65 -- small, and the cited replacement (R81 WAF) is already in the document.
2. **P27** wetness.ts fireFlux -> light.ts heatAt -- one-line cutover, removes a divergent law.
3. **P1/P9** the sky enum and its four tables -- largest blast radius; everything downstream inherits it.
4. **P20-P24** the seedling hour -- the densest cluster of uncited rules in the batch, and the one the operator named.
5. **P10-P12** the canopy: crown geometry from sprites, the two-crown cap, growRate.
6. **P16/P17** growthOf's water ramp and warmRate -- both have cited counterparts already in-repo (R221's Ks, R72's Tmin ramp) that the code ignores.
7. **P14/P15** the fertility ledger.
8. **P7/P8/P13** photometry and DARK.

## world, space, walk, plan, formulas, rules, journeys, inspect

## Audit: hardcoded high-level world rules

Scope: `src/sim/{world,space,walk,plan,formulas,rules,journeys,inspect}.ts`, read in full. Standard applied: an outcome must follow from a physical process with measured constants, cited as in `docs/research/fire-constants.md`. Grep of that document for `walk|reach|metabolic` returns only fire-side hits (its sec. 31 cites `world.ts reachOf` as "2 m, where people stand to tend a fire"), so **none** of the constants below have any citation in the repo.

### PHYSICS (world outcomes)

#### P1. Walking has no terrain cost at all: `walk.ts:76-107`, `walk.ts:12-37`
```ts
let budget = speed / TILE_M, moved = false;            // 80
const step = Math.min(budget, d), a = clear(...)        // 98
const STEPS = [[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]]; // 12
```
A mover covers `speed` meters a tick in whatever direction it faces. Slope, ground cover, snow, mud, wading depth and load are absent, and `firstStep` is a **uniform-cost** BFS: the chosen route is the fewest tiles, not the least effort, so nobody ever walks round a hill or along a valley. The data for the real law is already in the world (`World.heights`, `terrain`, `groundClass(...).slope`, `isle.snowCover`, `fine.moist`) and unused here.
*Low-level replacement*: cost of locomotion per unit distance as a function of gradient and substrate: Minetti et al. (2002) metabolic cost of gradient walking/running (J/kg/m vs slope, -0.45..+0.45), Tobler's hiking function as the speed form, Pandolf/Santee terrain coefficients for ground type (snow depth, sand, marsh) and load. Route choice then becomes least-time Dijkstra/A* over that per-tile cost.
*Impact*: **high** (travel time gates every goal, forage radius, camp spacing, fire response). *Effort*: **medium**.

#### P2. Walking speed is a product of hand-picked factors: `sim.ts:226-227` (cross-file, same subsystem)
```ts
(run ? RUN : WALK) * (stageOf(w, a) === "child" ? 0.6 : 1) * (w.paths[a.y * W + a.x] >= 5 ? 1.4 : 1) * moveRate(lightOn(w, a).bright)
```
Two category switches: a child is a flat 0.6, and a trail gives a step-function 1.4 once wear crosses 5 of 9. Wear itself is dice in `ecology.ts:554` (`Math.random() < 0.06 * (walked / 40)`) and decays by `Math.random() < 0.3` daily (`ecology.ts:558`).
*Replacement*: speed from stature/leg length and metabolic power (child speed follows from stride length and VO2, e.g. preferred walking speed ∝ √(g·L)); trail effect from the substrate's terrain coefficient changing as vegetation is crushed and soil compacts (trampling literature: passes-to-bare-ground, bulk density vs passes), so wear is accumulated passes, not a coin flip.
*Impact*: medium-high. *Effort*: medium (belongs with P1).

#### P3. Obstacle size by kind: `walk.ts:111-113`
```ts
const SOLID: Record<string, (t: Thing) => number> = {
  tree: () => 0.35, stump: () => 0.3, burnt_stump: () => 0.3, boulder: (t) => t.size / 2,
  structure: (t) => t.size / 2, well: () => 0.75, fire: () => 0.45,
};
```
A 30 m pine and a 3 m sapling-grown tree block the same 0.35 m. A fire's 0.45 m is fixed although combustion already computes the heap radius (`fireOutput(...).radius`, used in `inspect.ts:50-55`).
*Replacement*: trunk radius from a species DBH-height allometry (Chave/Jucker-style H-D relations, or the generator's own species table), fire footprint from the bed's own geometry, structure footprint from its pieces' volume.
*Impact*: medium (blocks movement and `onPath` sight/fire checks). *Effort*: small.

#### P4. What a thing can take, by kind: `world.ts:531-534`, applied at `world.ts:538`
```ts
const HP: Record<string, (size: number) => number> = {
  tree: (s) => Math.round(30 + s * 4.5), bush: () => 20, boulder: (s) => Math.round(60 + s * 40), stone: () => 40, ...
```
Durability is a per-kind formula over the single `size` number; bush, stone, stick, mushroom, clay, grass ignore size entirely, and species, moisture and the material are all absent. Consumed by `strikeDamage`/`throwDamage` budgets in `formulas.ts:101,172`.
*Replacement*: work-to-failure = specific fracture energy × fractured cross-section. Wood: Wood Handbook (FPL-GTR-190) mechanical properties by species and moisture (MOR, work-to-maximum-load kJ/m³, cleavage/fracture toughness); stone: uniaxial compressive strength / specific comminution energy per rock type (already have `rockAt`); green vs dry from `wetness.ts` `m`.
*Impact*: **high** (felling, quarrying, hunting, all tool value). *Effort*: medium (large if merged with P5).

#### P5. Breakage recipes keyed by kind: `materials.ts:66-...`, consumed at `formulas.ts:101,171-173`, `plan.ts:81,149-152`, `inspect.ts:218,247`
```ts
tree: { toughness: 0.55, hp: 100, flammable: 0.5, breaks: { log: 2, stick: 2 } },
bush: { toughness: 0.15, hp: 20, flammable: 0.6, breaks: { stick: 1 } },
```
A tree yields exactly 2 logs and 2 sticks whether it is 3 m or 30 m; the animal rows do the same for carcasses. `plan.ts:149` plans hunts off this table, so an agent's expectations are the table's.
*Replacement*: conservation of mass and volume: the standing thing's own volume (height × taper × density, the `Size {d, len, mass}` type already exists and `fuel.ts physOf` already carries piece physics) partitioned by how it was cut. Sources: species density and bole-volume allometries; for carcasses, dressing-percentage/edible-yield tables (e.g. USDA/FAO carcass yields, game-dressing fractions).
*Impact*: **high** (resource economy). *Effort*: **large**.

#### P6. Default made-thing size by kind: `world.ts:611-614`, used `world.ts:619`
```ts
const MADE_SIZE: Partial<Record<ThingKind, number>> = { fire: 1, structure: 2, item: 0.3, ash: 1.2, pit: 1.5, trap: 1.5, well: 1.5, grave: 2, ... };
// size: MADE_SIZE[kind] ?? 0.5
```
`size` then feeds reach (`reachOf`), obstacle radius (`SOLID`), rain interception and fire spread. A fire is 1 m whatever is laid in it; a shelter 2 m whatever it is built from; anything unlisted 0.5 m.
*Replacement*: geometry from content: a fire's radius from its bed (combustion already yields it), a pit from the volume dug (`digPower` × time ÷ soil bulk density), a structure from the volume/length of its pieces, an ash patch from the fuel mass consumed and ash bulk density.
*Impact*: medium. *Effort*: medium.

#### P7. Reach as a constant plus a kind branch: `world.ts:18`, `world.ts:393`
```ts
export const REACH = 1.5; // meters: close enough to touch, pick up, strike or tend
export const reachOf = (t) => REACH + (t.kind === "tree" || "stump" || "burnt_stump" || "sapling" ? 0.3 : Math.min(3, t.size / 2));
```
The kind branch encodes "trunks are narrow", which the thing's own geometry would say; `min(3, size/2)` caps a wide thing's edge arbitrarily. `fire-constants.md` sec. 31 then builds the warming checks on "2 m, where people stand to tend a fire, world.ts reachOf", so an uncited design number is load-bearing for a cited model.
*Replacement*: anthropometric functional reach (ANSUR II / NASA-STD-3000: ~0.70-0.80 m thumb-tip reach, plus a step) added to the target's own radius from its geometry.
*Impact*: medium (what is workable, and the fire-warming distance). *Effort*: small.

#### P8. Berry load is the number 4: `world.ts:541`, `space.ts:23,25`
```ts
if (kind === "bush" && species === "berry") t.n = 4;   // world.ts:541
export const BERRIES = 4; // the most a berry bush carries  // space.ts:23
```
A species-name switch sets a fixed fruit count regardless of bush size, light, water, soil or season, and `settled()` uses the same 4 as "full".
*Replacement*: fruit mass from canopy volume/leaf area × a measured yield per m² for the shrub type, modulated by the season's light and water (`light.ts`, `soil.ts`, `seedling.ts` all already present) and ripening by growing-degree-days. Sources: horticultural yield per bush (Vaccinium/Rubus kg per plant), wild-berry productivity surveys (g/m² per year).
*Impact*: medium-high (food supply is the main survival loop). *Effort*: medium.

#### P9. Mineral occurrence by dice: `world.ts:544-548`
```ts
const q = ((seed >>> 8) & 0xffff) / 65536, rock = rockAt(...);
if (q < 0.6 * rock.flint) t.inside = { flint: q < 0.2 * rock.flint ? 2 : 1 };
else if (q > 1 - 0.35 * rock.ore) t.inside = { ore: 1 };
```
The 0.6/0.2/0.35 ramps are invented, and the yield is 1 or 2 units irrespective of boulder volume.
*Replacement*: nodule/ore abundance per unit rock volume from the lithology (`rockAt` already returns a rock type): chert nodule frequency in chalk/limestone beds (nodules per m³, nodule mass distribution), iron-formation grade as a mass fraction; expected pieces = boulder volume × abundance.
*Impact*: medium (gates the whole flint/metal branch). *Effort*: small-medium.

#### P10. What a pick yields, and whether the source survives it: `plan.ts:37-47`, applied `plan.ts:129-130`
```ts
pick_berries: { place: "bush", item: "berry", n: 2, keep: true },
pull_reeds:   { place: "reeds", item: "fiber", n: 2 },
strip_grain:  { place: "grain", item: "grain", n: 3 },
dig_clay:     { place: "clay", item: "clay", n: 2, keep: true },
```
This is the clearest "action → fixed yield" table in my files: fixed counts per act, and a `keep` flag that decides by name whether the source persists rather than by whether anything is left in it. Costs are a flat `1.5` for every gather.
*Replacement*: harvest = min(standing stock at the spot, handling rate × time). Handling rates are measurable: ethnographic foraging return rates (kcal/h and g/min for berries, seeds, tubers: Hawkes & O'Connell, Kelly's *Foraging Spectrum* tables), reed/fibre cutting rates, clay dug per minute by volume. The stock then falls by what was taken and regrows by the plant model.
*Impact*: **high**. *Effort*: medium.

#### P11. Carrying capacity is 24 of each kind: `plan.ts:22`
```ts
const add = (s, k, d) => ({ ...s, inv: { ...s.inv, [k]: Math.max(0, Math.min(24, n(s, k) + d)) } });
```
24 logs weigh as little as 24 berries. No mass, volume or container term, although `Size.mass` and `container` properties exist.
*Replacement*: load limit by mass and bulk: sustainable carried load as a fraction of body mass (military load-carriage literature: ~30-45% body mass; head-load and ethnographic porter studies), and container volume for loose items. Speed then falls with load (Pandolf equation), tying back to P1.
*Impact*: medium-high (trip planning, hoarding, build feasibility). *Effort*: medium.

#### P12. Act duration by verb name: `formulas.ts:63` and `physics.ts:218`
```ts
const ticks = DURATION[f.verb] ?? 4;                                     // formulas.ts:63
export const DURATION = { join: 8, heat: 8, wet: 10, shape: 6, place: 3, plant: 3, pour: 2, wear: 2 }; // physics.ts:218
```
Every join takes 40 minutes, every heat 40, every dip 50, whatever is being joined or heated. `fire-constants.md` sec. 29/31 already treats `DURATION.place = 900 s` as a given, so the cited fire model inherits an uncited duration.
*Replacement*: time = work required ÷ power delivered. Cordage: measured twisting rates (m of cord per hour); pottery forming: ethnographic time-allocation studies; heating: the time `combustion.ts` already computes for the piece's core to reach the target temperature (it computes exactly this for clay at 600 °C and food at 62.8 °C); dipping: container volume ÷ fill rate.
*Impact*: **high** (durations are the planner's currency and the fire model's step size). *Effort*: medium.

#### P13. Craft branches gated on blow and throw counts: `formulas.ts:101,122,128,132,155,173`
```ts
return dmg > 0.01 ? out(true, Math.ceil(mat.hp / dmg), ...) : out(false, 5);      // 101 "barely a mark after five"
while (sharp < 0.95 && n < 30) ...                                               // 122
return blows <= 10 ? out(true, blows, ...) : out(false, 10);                      // 128 knapping
return dmg > 0 && tk.breaks ? out(true, Math.ceil(20 / dmg), ...) : out(false, 6);// 132 split: hp 20 from nowhere
return spot ? out(true, Math.ceil(12 / digPower(tool)), ...) : out(false, 1);     // 155 dig: 12 from nowhere
return throws <= 6 ? out(true, 3 * throws, ...) : out(false, 18);                 // 173 throw every 3 ticks = 15 min
```
`ok: false` means agents never plan the act, so these integers decide what is *possible*, not just how long it takes. Two are plain magic masses of work (`20` for splitting, `12` for digging), the sharpness cap `0.95` and iteration bound `30` shape forging's ceiling, and `3 * throws` puts fifteen minutes between spear throws.
*Replacement*: an energy budget: work per blow (tool mass × swing speed² / 2, measurable: axe head 1-2 kg at 10-20 m/s) against the piece's fracture energy (P4/P5 sources); the act fails when required work exceeds what a person can deliver in a plausible session (metabolic power ~300-500 W sustained, chopping-rate field studies). Throw cadence from projectile handling time (~2-4 s), not ticks. Forging from the work-hardening/drawing-out rate per blow at the measured hot-working temperature.
*Impact*: **high** (reachability of the whole tech tree). *Effort*: **large** (must land with `physics.ts`).

#### P14. Prediction staging constants: `formulas.ts:43,53,78,165`
```ts
const RING = 3, LIT = 600;                       // 43  three stones is a hearth; 10 min is "lit"
const LEAN_TO: Record<string, number> = { stick: 4 }; // 53  the canonical shelter is 4 sticks
fish: { basket: fish, line: fish },              // 78  a basket and a line catch the same
seedlingFate(..., f.verb === "pour" ? 0.5 : 0)   // 165 watering is a flat 0.5
```
`RING = 3` is the definition of "hearth" by stone count; the fish term makes gear irrelevant to catch; `0.5` is a dimensionless watering bonus where `soil.ts` could take litres against the root-zone deficit.
*Replacement*: hearth containment from the stone wall's actual height/width versus the bed (combustion already takes `walls: {tall, width}`); catch from fish density × gear capture area × soak time (CPUE studies, trap/net selectivity); watering as volume poured ÷ root-zone water deficit (FAO-56 field capacity/TEW, already used by `soil.ts`).
*Impact*: medium (prediction drives learning and the answer key, so a wrong prediction mis-teaches). *Effort*: small each.

#### P15. Age is three named stages with 1- and 5-"year" cutoffs: `world.ts:387`, spawn ages `world.ts:596`
```ts
export const stageOf = (w, a) => { const y = ageOf(w, a); return y < 1 ? "child" : y < 5 ? "adult" : "elder"; };
born: -Math.round(YEAR * (1.2 + rand() * 0.8)),
```
A category that gates physical capability (`sim.ts:227` child speed 0.6, and every other consumer of `stageOf`). Crossing a tick-count flips capability discontinuously.
*Replacement*: continuous body state: stature/mass growth curve (WHO/CDC growth references) driving stride length, basal metabolic rate (Schofield/Henry BMR equations) and maximal force (age-strength curves peaking in the 20s, declining ~1%/yr after 50); "child/elder" becomes a label, as `isNight`/`clock` already do for the sun.
*Impact*: medium-high. *Effort*: medium.

#### P16. Skill level as a capped square root: `world.ts:395`
```ts
export const level = (xp: number) => Math.min(10, Math.floor(Math.sqrt(xp / 10)));
```
Ten integer levels, a hard ceiling, an invented 10-xp scale; consumed wherever skill multiplies an outcome.
*Replacement*: the power law of practice (Newell & Rosenbloom; Crossman's cigar-rolling data) on *time per act*: T = T₁·n^(-α) asymptoting to a physical floor set by the tool and material, so skill shortens work rather than granting an integer tier.
*Impact*: medium. *Effort*: medium.

#### P17. Season from a day index, and a 10-day season: `world.ts:626`, `world.ts:625`
```ts
export const seasonOf = (t) => (["spring","summer","autumn","winter"] as const)[Math.floor(dayOfYear(t) / 10)];
```
`Weather.season` is a four-value category that downstream systems branch on, produced by integer division of a day counter. The sun's real state is already available (`sky.ts sunAt`, `isle.seasons`, and `wetness.ts` has a growing-season index).
*Replacement*: delete the driver and keep the word as a label: solar declination/daylength plus the running temperature and the GSI already computed decide anything that currently branches on the name (leaf-out, snow, dormancy). Phenology sources: growing-degree-day and GSI formulations (Jolly et al. 2005, already referenced by the wetness work).
*Impact*: **high** if other systems switch on it (they do). *Effort*: medium: the cost is the caller cutover, not the law.

#### P18. Opening weather is literals: `world.ts:562`
```ts
weather: { season: "spring", dayOfYear: 0, year: 1, sky: "clear", temp: 8, wind: {...terrain.wind/2}, speed: 4, wet: 0.2, ... }
```
8 °C, 4 m/s, soil wetness 0.2, clear, spring day 0: none read from the island the world was just grown on, which carries `isle.temp`, `isle.seasons[].temp`, `isle.breeze`, `fine.moist`.
*Replacement*: evaluate the generator's own climatology at t=0 (mean temperature for that day of year at sea level, the terrain's wind speed distribution, the soil's seasonal bucket).
*Impact*: low-medium (first hours only, but fire/wetness tests start there). *Effort*: small.

#### P19. Spawn geometry and starting bodies: `world.ts:569-596`
```ts
const a = rand() * Math.PI * 2, d = (60 + rand() * 120) / TILE_M;      // 576
if (open(px, py) && w.agents.every((b) => meters(b, { px, py }) >= 50)) break; // 578
needs: { food: 55 + rand() * 30, energy: 60 + rand() * 30, warmth: 70 + rand() * 20, health: 100, social: 40 + rand() * 40 }, // 594
```
Grass-tile-only spawning, 50 m minimum separation, 60-180 m cluster, uniform-random needs. Initial-condition design rather than an ongoing law, but the needs numbers are the physiology state vector's origin.
*Replacement*: state the initial condition in physical units (body energy stores in kJ, core/skin temperature, hydration) so the physiology model starts from a measurable body, and spawn by habitability (water distance, forage density) rather than tile class.
*Impact*: low-medium. *Effort*: small.

#### P20. `landing()` and `anyOf()` use unseeded `Math.random`: `world.ts:363-371`, `space.ts:~259`
```ts
const main = mainland(w), a = Math.random() * Math.PI * 2;   // world.ts:364
export function anyOf(w, kind, rand = Math.random)            // space.ts
```
Not a physics law, but a world outcome (where newcomers arrive, which thing an event picks) decided by an unseeded draw outside the seeded streams the rest of generation is careful about (`rng(seed ^ 0x5f3759df)`, see the comment at `world.ts:555`).
*Replacement*: arrival point from the coast's actual landability (shelter from the prevailing wind/swell, beach slope from `fine.heightAt`), drawn from the world's seeded stream.
*Impact*: low (medium for reproducibility). *Effort*: small.

#### P21. Collect/forage target amounts: `plan.ts:179,186`
```ts
const want = Math.max(0.6, food(start) + 0.4) - 1e-6;                              // 179
const want = k === "resin" || k === "ore" ? 1 : k === "bark" ? 2 : 3;               // 186
```
How much is "enough" is a dimensionless 0.6/0.4 of edibility, and collect targets are an item-name switch. Borderline cognition, but they set how much material leaves the world per trip.
*Replacement*: the energy deficit in kJ against food energy density (`p(kind,"edible")` becomes kJ/kg), and a collect target equal to what the next act consumes or what can be carried (P11).
*Impact*: medium. *Effort*: small.

### BEHAVIOUR (listed only, per the brief)

- `plan.ts:95,127,151,157-165`: planner costs in arbitrary units mixing distance and time (`1 + b.ticks/8/wr`, `1 + d/4`, hunt 12, rest 4, gather 1.5, social 1); one currency (expected time) would make them comparable.
- `plan.ts:70` `BUILD_NEAR = 10`: comment says "half a day's walk", the value is 10 × 15 m = 150 m; comment and value disagree.
- `plan.ts:26,67` `WITHIN` / `PLACE_OF`: name aliasing (a kiln "is" a fire) rather than a property of the place.
- `plan.ts:22,140,145,254,258`: inventory abstraction cap, take-3-at-a-time, 3000-node/14-step search caps (the last two self-labelled `ponytail:` plumbing).
- `plan.ts:29-34` `SOCIAL` verb list and `SOCIAL_ITEM_NEEDS`.
- `world.ts:129` `BOND_FADE` 0.97-0.98 per day; `world.ts:117-127` `BONDS`, `131-141` `LABELS`, `143` `OPINIONS`, `206-213` `RESPONSES`: social vocabulary and decay rates.
- `world.ts:397-425` names, colours, desires, trait opposites; `world.ts:581-592` trait draw (5-8 traits, 0.4-1.0, no clashing pairs).
- `world.ts:629` `QUIET` event-kind list and `world.ts:631-642` memory window of 12: narrative plumbing.
- `rules.ts:6-13` `RULES.learning` ("seen"/"off"/"known") and `RULES.truth`: an explicit rule switch, but confined to `scripts/evals.ts`/`scripts/probes.ts` and documented as never touching the live world; `rules.ts:17-20` `hooks` likewise.

### ALREADY PHYSICAL (in these files)

- `world.ts:647-656` `isNight`/`clock`: darkness and the parts of the day read off the real solar elevation (`sunAt(...).el < NIGHT_EL`), not a clock table. This is the pattern P17 should follow.
- `world.ts:386,390-391` `ageOf`/`meters` and `world.ts:452` `tileOf`: plain unit conversions.
- `world.ts:311-371` `wetAt`/`dryAt`/`dryNear`/`mainland`/`sea`: read the generator's water field and connectivity; no rules.
- `world.ts:470-490` `groundOf`, `shoreOf`, `shoreByTile`, `ringOf`, `nearestShore`: geometry over generated ground.
- `formulas.ts` as a whole delegates verb outcomes to `physics.ts`/`combustion.ts`/`wetness.ts`/`seedling.ts` (`lighting`, `sparkCatches`, `emberCatches`, `setIn`/`RED`, `seedlingFate`, `bedAt`), i.e. the rebuilt, cited fire/wetness/seedling stack; its own residue is P13/P14.
- `formulas.ts:45-52` `staged()` builds its reference fire by actually kindling and advancing a bed (`kindle`, `advance`, `feed`) rather than asserting a fire's properties: only `RING`/`LIT` are uncited.
- `space.ts` in full: spatial index, lazy stocking/shelving, ring search; pure plumbing with no behavioural rule.
- `journeys.ts` in full: polyline recording; `STRIDE`/`BEND` are geometric simplification tolerances.
- `inspect.ts` in full: read-side projection; decides nothing. `lookOf` (76-100) derives an item's appearance from its measured properties instead of a name table, and `texture` (354) uses the USDA texture-triangle breakpoints. It does *surface* rules owned elsewhere: `keeps N days` (111, 129) and `burns N ticks` (112, 128) from `materials.ts` shelf/fuel, `grows back in N days` (165) from the regrowth timer, `wilting` at 0.8 hp (174), and `THING_MATERIAL` as "breaks into" (218) / "butchers into" (247): fix the owners and these lines become honest.

## src/terrain

## src/terrain audit: world physics vs. hardcoded high-level rules

Scope: every line of `climate.ts`, `geology.ts`, `grid.ts`, `ground.ts`, `water.ts`, `flora.ts`, `niche.ts`, `island.ts`, `land.ts`. Checked against `docs/research/fire-constants.md` (the citation standard) and `docs/research/generator/index.html` (prose write-up, carries **no constants and no sources**). `grep` across `docs/` for `SEASONS|ROCKS|climate.ts|ground.ts|geology|uplift|erode` finds only *uses* of terrain outputs by the fire work: **not one terrain constant is sourced anywhere in the repo.**

A structural note before the findings: `grid.ts`'s `ramp(v, lo, hi)` smoothstep is the signature of the problem. Nearly every rule below is `ramp(<physical quantity>, <hand-picked lo>, <hand-picked hi>)`. The shape is fine; the bounds are the uncited rule. A second structural tell: several constants are *per-cell* or *per-step* fractions (climate.ts rain-out 0.15 per cell, `STEP = 1.5` cells, water.ts fetch e-folding lengths, island.ts `dt = 120/steps`), so the world's physics changes if `CELL` or `steps` changes. Dimensional constants (per second, per metre, per year) would be invariant.

---

### physics

#### climate.ts

**P1. The SEASONS table: the master season switch.** `climate.ts:13-20`
```ts
export const SEASONS = [
  { t: 12, sea: 9, wet: 0.22, cloud: 0.6 },   // + three more rows
```
Four hand-written rows indexed by season number. Every downstream field reads them: temperature (`:116`), rainfall share (`:94`), cloud (`:242`), fog weighting (`:178`), the saturation ceiling of the incoming air (`:140`), snow (`:281`), PET, plant fits, and (per `fire-constants.md:931,951`) the sky model's rain probability. It is the single largest high-level rule in the generator: the season decides the weather by lookup instead of the weather following from the sun the island receives.

*Low-level replacement.* The sim already has `sky.ts sunAt` and `climate.ts sunlight`, i.e. top-of-atmosphere and surface insolation for any day. Sea-level air temperature is then the surface energy balance's annual harmonic; the sea's lag and amplitude damping come from a mixed-layer ocean heat budget (ρ c_p h dT/dt = Q_net), which with h ≈ 50-70 m gives the observed ~6-8 week lag directly rather than by a hand-set `sea` column. Cloud fraction and each season's share of the year's precipitation belong to the storm-track climatology for the island's latitude.
*Likely sources.* ERA5 / station climate normals for a maritime temperate (Köppen Cfb) island: the same class of source `fire-constants.md` uses for weather (R70, R71, R96); mixed-layer depth and SST phase lag from an ocean-climatology paper.
*Impact: high. Effort: large.*

**P2. `POOL_C`: cold-air pooling, per season, in °C.** `climate.ts:23`, used at `:116`
```ts
export const POOL_C = [1.2, 0.8, 1.5, 2];
```
A literal degree offset keyed by season index. The season is the switch; nothing physical selects 2 °C over 1.2.
*Replacement.* Nocturnal cold-air drainage is a radiative-loss problem: the pool's depth scales with the clear-sky net longwave loss over the night (σT⁴ × emissivity deficit × sky-view share: `shape.sky` is already computed at `:216`) against the sensible flux the night's wind supplies. All three inputs exist per cell and per season, so the pooling becomes an output, not a table.
*Sources.* Measured valley cold-pool intensities (Whiteman's Colorado/Utah basin studies; Gustavsson's Swedish valley-frost work).
*Impact: medium-high (sets frost, hence treeline, snow and winter plant fits). Effort: medium.*

**P3. Hand-set warmth assembly.** `climate.ts:116`
```ts
T[i] = ... : t + 0.6 * a.marine[i] * (sea - t) - LAPSE * z[i] + 0.25 * (sun[i] - flat[si]) - POOL_C[si] * pool[i];
```
Two uncited magic coefficients: `0.6` (how far sea air tempers inland air) and `0.25` °C per MJ/m²/day of excess slope insolation. `LAPSE = 0.0065` (`:9`) is the standard atmosphere value but carries no citation marker.
*Replacement.* The slope warming is exactly the Byram-Jemison surface heat balance the repo **already cites**: `fire-constants.md:338` gives `T_surface - T_air = I / (32.7 + 42.2 U)` in SI, derived from R70. Converting the cell's excess net radiation (W/m², which `sunlight` has before it integrates to MJ/day) through that loss coefficient yields the warming with no free parameter, and it correctly makes windy slopes warm less. The marine blend should be an advective relaxation: the `0.6` collapses into the fetch e-folding at `:165` plus an air-sea sensible heat transfer coefficient.
*Sources.* In-repo: R70 via `fire-constants.md` sec. 11. Air-sea bulk transfer coefficient from a standard flux parameterisation (COARE).
*Impact: high (temperature feeds PET, snow, every niche curve, and the fire model). Effort: medium: the source is already in the repo.*

**P4. The island's rainfall is drawn, then the physics is rescaled to match it.** `climate.ts:77` and `:88-95`
```ts
const prevailing = rand() * Math.PI * 2, wetness = 700 + rand() * 700;
...
const scale = (wetness * SEASONS[s].wet) / Math.max(1e-9, sum / Math.max(1, land));
for (let i = 0; i < LEN; i++) { r[i] *= scale; precip[i] += r[i]; }
```
The orographic column at `:171-189` does real work: vapour, saturation, condensation, fallout, rain shadow: and then its output is **multiplied by a scale factor so the land mean hits a number drawn from a hand-set 700-1400 mm range.** Only the *pattern* survives; the *amount* is a die roll. Any physical change to the condensation model is erased by the rescale.
*Replacement.* Annual precipitation is the moisture flux convergence over the island: incoming vapour flux (q_sat at the sea surface temperature × wind speed × upwind cross-section) times the fraction condensed and dropped. With a correct sea-surface q and a measured fallout timescale, the total is an output. The Smith & Barstad linear orographic precipitation model gives both timescales (cloud conversion τ_c and hydrometeor fallout τ_f, order 200-2000 s) as measured quantities, which is also the fix for P5.
*Sources.* Smith & Barstad (2004) linear orographic precipitation model; ERA5 moisture-flux climatology for the chosen latitude.
*Impact: high (precipitation sets soil water, peat, cover, streams, lakes, and fire). Effort: medium.*

**P5. Per-cell air-column fractions with no timescale.** `climate.ts:25, 162-168, 179-188`
```ts
const STEP = 1.5;                                        // :25  upwind look, in cells
shelter[i] = Math.max(was * 0.93, up - z[i]);             // :161
const clear = clamp(1 - shelter[i] / 60, 0, 1);           // :162
exposure[i] += f * clear * (0.35 + 0.65 * clamp(z[i] / 700, 0, 1));   // :163
salt[i]   += f * Math.exp(-shore[i] / 250);               // :164
marine[i] += f * Math.exp(-shore[i] / 4000);              // :165
const v = open[i] ? 1 : (0.35 + 0.65 * clear) * (0.72 + 0.28 * Math.exp(-shore[i] / 800)) * (1 + 0.6 * clamp(z[i] / 600, 0, 1)) * (1 + 0.4 * ramp(z[i] - around[i], 5, 60));  // :168
const back = Math.min(w, (most - vap) * 0.3);             // :179  re-evaporation share
const fall = w * 0.15 + vap * 0.0015;                     // :181  fallout per cell + drizzle
w *= 0.85; vap *= 0.9985;                                 // :182
if (open[i] && vap < moist[si]) vap += (moist[si] - vap) * 0.08;  // :183  sea re-moistening
humidBy[si][i] += f * Math.min(1, (0.82 * vap) / ground[i * S + si]);  // :188
```
Sixteen uncited coefficients. Every one is a *fraction per 1.5 cells* (112.5 m), so halving `CELL` changes the rain shadow, the salt gradient and the wind field. Merged as one finding since they are all the same rule: a hand-tuned advection sweep.
*Replacement.* (a) Fallout and re-evaporation: `τ_f`, `τ_c` in seconds, converted to a per-cell fraction by `1 - exp(-Δx / (U τ))`, so the result is grid-independent (Smith & Barstad). (b) Wind speed-up over terrain: the Jackson-Hunt / ESDU fractional speed-up `Δs ≈ 2 H/L` for a hill of height H and half-length L: measured, dimensionally correct, and it removes the `z/600`, `z/700` and `ramp(z - around, 5, 60)` knobs. (c) Shelter decay and the `/60` normaliser: the recirculation/wake length behind an obstacle is measured at ~10-20 H. (d) Salt: marine aerosol deposition decays with inland fetch at a measured rate. (e) The `0.82` humidity factor is a diurnal-mean correction that should be the actual dawn-to-afternoon temperature swing, which the sim has.
*Sources.* Smith & Barstad (2004); ESDU 91043 / Jackson & Hunt (1975) terrain speed-up; a coastal salt-deposition measurement paper.
*Impact: high. Effort: large.*

**P6. `SEA_WIND = 6` m/s.** `climate.ts:73`, used at `:170`. A single uncited number scaling every wind in the world (and, through `lee`, the fire model's spread). Replacement: the annual-mean 10 m marine wind at the island's latitude from a scatterometer/reanalysis climatology, corrected to head height by the log law: the repo already has the log-law profile cited at `fire-constants.md:434` (R81, R83). *Impact: high. Effort: small.*

**P7. Wind rose shape.** `climate.ts:79`
```ts
const rose = Array.from({ length: DIRS }, (_, k) => 0.25 + Math.exp(1.4 * Math.cos((k / DIRS) * Math.PI * 2 - prevailing)));
```
A von Mises concentration with hand-set κ = 1.4 and an 0.25 isotropic floor. Replacement: κ fitted to a measured directional wind-frequency rose for the chosen climate. *Impact: medium (sets the rain shadow's sharpness and which coast gets salt). Effort: small.*

**P8. Overcast transmittance and fog coupling.** `climate.ts:257-258`
```ts
const c = Math.min(0.95, c0 + 0.5 * fog[i]), mine = b + glow * sky[i];
out[i] = (mine * (1 - c) + 0.25 * c * level * sky[i]) * MJ;
```
`0.25` (an overcast sky passes a quarter of the clear day's light), `0.5` (fog adds half its share to cloud cover) and the `0.95` cap are uncited. *Replacement:* measured cloud transmittance by cloud type/optical depth; the repo already cites NFDRS's `transmittance = 1 - cover` and the clear-sky beam `I0 p^M sin A` with p = 0.745 at `fire-constants.md:341,355` (R70). *Impact: medium (light drives plant fit via `lightFit`, and warmth via P3). Effort: small: source in repo.*

**P9. Snow: thresholds, a degree-day melt factor, and a cover cutoff.** `climate.ts:280, 287-290, 295`
```ts
if (mean - Math.hypot(a1, b1) - Math.abs(a2) > 6) continue;  // :280 never cold enough
if (T > 6 && pack === 0) continue;                           // :287
const flakes = p / (1 + Math.exp((T - 1) / 1.5));            // :288 rain/snow partition
const melt = (T > 4 ? 3 * T : 1.8 * Math.log1p(Math.exp(T / 0.6))) + R[si] * ramp(T, -3, 1);  // :290
if (pack > 10) snowCover[i] += 1 / 365;                      // :295
```
The logistic rain/snow partition centred at 1 °C with a 1.5 °C spread, and the degree-day factor of 3 mm/°C/day, are both *real measured quantities* used without citation; the `T > 4` branch switch, the softplus below it, the `-3..1` radiation ramp and the 10 mm cover threshold are invented. `R[si] = 0.25 * sun` at `:281` is suspiciously close to the correct 1/L_f conversion (1 MJ/m² ÷ 334 kJ/kg = 3.0 mm, so 0.25 mm per 0.083 MJ: i.e. roughly albedo-corrected melt), but nothing says so.
*Replacement.* A snowpack energy balance: melt = (net shortwave × (1 - albedo 0.8 fresh / 0.5 old) + net longwave + sensible + latent) / 334 kJ/kg. Every term is already computed per cell and season. Rain/snow partition from a dual-threshold wet-bulb scheme.
*Sources.* Hock (2003) degree-day review for the factor; Dai (2008) for rain/snow thresholds; latent heat of fusion is a constant.
*Impact: medium-high (snow cover feeds winter warmth, PET suppression, and plant survival). Effort: medium.*

**P10. PET suppressed under snow by a ramp.** `climate.ts:314`
```ts
E[i] = day * SEASON_DAYS * (1 - 0.8 * ramp(snowpack[i], 5, 40));
```
The Penman-Monteith above it is cited FAO-56; this tail multiplier is not. *Replacement:* evaporation over snow is sublimation at the snow surface's albedo (~0.8) and its 0 °C surface temperature: recompute Penman with those two substitutions instead of damping the grass-reference value. *Impact: low-medium. Effort: small.*

#### geology.ts

**P11. The ROCKS table: 45 uncited numbers.** `geology.ts:18-24`
```ts
{ name: "mudstone", perm: 0.05, base: 0.5, sand: 0.15, clay: 0.55, feed: 0.65, flint: 0.15, ore: 0.35, incise: 1.25, creep: 1.3 },
```
The architecture is right and worth preserving: the comment at `:1-5` states the rule ("Soil, groundwater, springs and what can be found lying about all answer to these properties, never to the rock's name") and the code honours it. But every one of the 45 entries is a dimensionless 0-1 guess standing for a quantity that is measured in real units:
- `perm` → saturated hydraulic conductivity, m/s (granite 1e-11..1e-9, karst limestone 1e-4..1e-2: six orders of magnitude, not a 0.08-to-0.85 range)
- `base` → base saturation / CaCO₃ content, %
- `sand`, `clay` → the grain-size distribution of the weathering residue, measurable per lithology
- `feed` → nutrient release rate from weathering, mol/m²/yr
- `flint`, `ore` → nodule/mineral abundance, % by volume
- `incise` → stream-power erodibility K, in m^(1-2m)/yr
- `creep` → hillslope diffusivity D, m²/yr (measured 0.001-0.01)
*Sources.* Freeze & Cherry *Groundwater* conductivity table; Harel, Mudd & Attal (2016) compilation of measured K; Fernandes & Dietrich (1997) / Richardson et al. for D; a soil-survey handbook for weathering residues; White & Brantley for mineral weathering rates.
*Impact: high (drives erosion pattern, groundwater, soil texture, pH, fertility, and flint/ore availability: i.e. whether toolmaking is possible). Effort: medium: the table shape is already correct, each cell just needs a real unit and a reference.*

**P12. `rockOf`: a named-category threshold switch.** `geology.ts:27-30`
```ts
if (hard < 0.4) return 0;
if (hard < 0.62) return chem > 0.55 ? 2 : 1;
return chem > 0.6 ? 4 : 3;
```
The one place in the generator where a *rock identity* is picked by thresholds on two synthetic noise fields (`island.ts:34-35`, themselves just `0.5 + fbm * 0.9`). Everything downstream then reads the row's properties: so the switch is a needless indirection: the properties could be sampled directly.
*Replacement.* Sample correlated composition/texture fields (quartz vs. carbonate fraction, cementation, porosity) and compute the nine properties from them by petrophysical relations (Kozeny-Carman for permeability from porosity and grain size; mineralogy for base release). The rock's *name* becomes a display label looked up from the properties, never an input.
*Impact: medium. Effort: medium.*

#### island.ts

**P13. The erosion scheme is dimensionless: so relief cannot emerge.** `island.ts:55-57, 62, 70`
```ts
cut[i]   = (1.3 - hard[i]) * r.incise;      // :55
slide[i] = (1.3 - hard[i]) * r.creep;       // :56
shed[i]  = Math.max(0.1, 0.9 - 0.8 * r.perm);  // :57
const dt = 120 / steps, K = 0.25 * dt, CREEP = 0.04 * dt, RISE = 0.01 * dt;  // :62
water[i] = runoff[i] * (1 + 0.5 * clamp(h[i] / top, 0, 1));  // :70
```
The *scheme* is cited (Braun & Willett 2013 implicit stream power, comment `:40-45`): that part is exemplary. But there is no length, no time and no erodibility in real units: `K`, `CREEP`, `RISE`, the `1.3 -` hardness offset, the `0.9 - 0.8*perm` runoff rule and the `0.5` elevation-rain bonus are all free. The comment at `:45` admits the consequence: *"Heights come out in arbitrary units for the caller to scale."* Note also that the `0.5` orographic bonus at `:70` is a second, different, elevation-only orography that disagrees with `climate.ts`'s wind-direction-aware one: so the landform has no rain shadow.
*Replacement.* Dimensional stream power `E = K A^m S^n` with measured K (1e-6..1e-4 /yr), m ≈ 0.5, n = 1; hillslope diffusion `∂z/∂t = D ∇²z` with D ≈ 0.003 m²/yr; uplift U in m/yr (0.1-5 mm/yr measured); integrate real years to approach steady state. Steady-state relief then *follows* from U/K, which is the whole point: and makes P14 unnecessary.
*Sources.* Whipple & Tucker (1999); Stock & Montgomery (1999); Harel et al. (2016) for K; Fernandes & Dietrich (1997) for D; any thermochronology/geodesy compilation for U.
*Impact: high. Effort: large.*

**P14. Relief is a die roll.** `island.ts:112, 119`
```ts
const peak = (250 + rand() * 200) * Math.sqrt((N * CELL) / 9600);
...
height[i] = raw[i] > 0 ? (raw[i] / top) * peak : Math.max(-60, raw[i] * 1200);
```
The island's maximum elevation is drawn from a hand-set 250-450 m range and the whole eroded field is linearly stretched to it; the `sqrt(size)` scaling has no derivation. Everything temperature- and moisture-dependent (lapse cooling, snow, treeline, rain shadow strength, stream gradients) is therefore set by this draw rather than by the uplift/erosion balance. The offshore `raw * 1200` floored at -60 m is a separate invented bathymetry with no shelf process.
*Replacement.* Delete the normalisation; take the heights P13 produces in metres. If a target relief is wanted, choose U and K whose ratio gives it, and cite both.
*Impact: high. Effort: small once P13 lands (it is the same change).*

**P15. Uplift is hand-shaped noise.** `island.ts:16, 30-35`
```ts
const tilt = rand() * Math.PI, stretch = 0.8 + rand() * 0.35;
mask[i] = clamp((0.98 - d) / 0.3, 0, 1) * edge;
const range = ridged(..., 3, 2, 0.45);
const lowland = clamp(0.55 + simplex2d.sample(basins, u * 1.4, v * 1.4) * 0.9, 0.15, 1);
lift[i] = mask[i] ** 2 * (0.3 + 0.7 * range * range) * lowland;
hard[i] = clamp(0.5 + fbm(...) * 0.9, 0, 1);
chem[i] = clamp(0.5 + fbm(...) * 0.9, 0, 1);
```
The shape of the island and of its bedrock bands is nine uncited constants on noise. This is arguably a legitimate *design* input (the generator has to start somewhere), but it is not marked as such, and the constants do decide coastline sharpness (`0.98 / 0.3`), range prominence (`0.3 + 0.7`) and basin depth (`0.55 ± 0.9`).
*Replacement/minimum fix.* Mark as `[design]` with reasoning, and express `lift` in m/yr so P13's law has real dimensions. A fuller version derives band geometry from a prescribed fold/fault geometry.
*Impact: medium. Effort: small for the marking, medium for the dimensional version.*

**P16. Glacial troughs: 200 m of incision from a drainage-area ramp.** `island.ts:126, 131`
```ts
if (height[i] > 2) line[i] = 5 * 40 * ramp(Math.log10(drained[i]), 2.3, 3.6) * clamp(1.15 - 1.4 * hard[i], 0, 1);
...
height[i] = Math.max(1, height[i] - trough[i] + 3 * floor * fbm(..., 2, 2, 0.5));
```
`5 * 40` m of carving keyed to a log-drainage-area smoothstep, erodibility linear in `hard`, moraine as `3 m × fbm`, trough width set by `blur(line, 2)`. The island's lakes come out of these numbers (comment `:120-123`), so lake count and placement are a hand-set outcome. No ice, no climate: the carving does not know whether the island was ever cold enough to hold a glacier.
*Replacement.* Glacial erosion `E = K_g u_s^l` with sliding velocity from a shallow-ice or plastic ice-sheet profile driven by the climate's own equilibrium-line altitude, so troughs appear only where ice was thick and warm-based: and absent on a warm island. Overdeepening and sills then follow from the ice flux and the bed's erodibility.
*Sources.* Herman et al. (2015) / Koppes et al. for K_g and the sliding exponent; a standard shallow-ice formulation for the profile.
*Impact: medium-high (valley form, and all the lakes). Effort: large.*

**P17. `open` / `basin` depth thresholds.** `island.ts:138-139`
```ts
open[i]  = filled[i] < 0 || filled[i] - height[i] > 1 ? 1 : 0;
basin[i] = filled[i] >= 0 && filled[i] - height[i] > 0.3 ? 1 : 0;
```
1 m and 0.3 m of fill depth decide "this is water" and "this could hold a lake" *before* `hydrology()` does the real inflow-vs-evaporation water balance. The 1 m `open` mask is then fed to `climate()` as the moisture source, so a hand threshold decides how much of the island evaporates. *Replacement:* let every closed depression be a lake candidate and let the water balance decide; take `open` from `hydrology`'s own result (the code already re-derives it at `island.ts:155`). *Impact: low-medium. Effort: small.*

#### water.ts

[…102ln elided…]

**P30. `holds()`: available water capacity by hand.** `ground.ts:113-114`
```ts
return 10 + soil * (170 - 110 * sandy - 80 * Math.max(0, clayey - 0.4) + 60 * humus);
```
The comment reasons from a real number ("a meter of loam some 170 mm") which is about right, but nothing cites it, and the sand/clay/humus adjustments are guesses. *Replacement:* a published pedotransfer function for field capacity and wilting point from texture and organic matter. **FAO-56 Table 19 is already reference R221 in the repo** (`fire-constants.md:1010` reads REW/TEW from it). *Sources:* Saxton & Rawls (2006); FAO-56 Table 19 (R221, in repo). *Impact: medium. Effort: small: source already present.*

**P31. The five cover rules: a hand-written habitat key that duplicates niche.ts.** `ground.ts:93-107`
```ts
const harsh = clamp(ramp(s.exposure[i], 0.45, 0.85) + ramp(s.salt[i], 0.3, 0.7), 0, 1);
const pTree  = ramp(summer, 11, 15) * ramp(soil[i], 0.3, 0.9) * ramp(moist[i], 0.72, 0.92) * (1 - peat[i]) ** 2 * (1 - harsh) ** 2 * (1 - sand[i]) * (0.8 + 0.2 * ramp(fertility[i], 0.05, 0.3));
const moor   = Math.max(ramp(s.precip[i] - s.pet[i], 300, 900), ramp(s.exposure[i], 0.35, 0.7), 0.6 * ramp(5.2 - ph[i], 0, 1));
const pShrub = ramp(soil[i], 0.05, 0.25) * ramp(moist[i], 0.6, 0.85) * moor * (1 - 0.6 * ramp(soil[i], 0.8, 2)) * (1 - 0.3 * harsh) * (1 - 0.8 * sand[i]);
const pMarsh = peat[i] * ramp(soil[i], 0.02, 0.15);
const pGrass = ramp(soil[i], 0.02, 0.12) * ramp(moist[i], 0.15, 0.4) * (1 - 0.6 * sand[i]) * (1 - 0.5 * peat[i]) * (0.7 + 0.3 * ramp(fertility[i], 0.05, 0.4));
tree[i] = pTree; shrub[i] = pShrub * (1 - tree[i]); marsh[i] = ...; grass[i] = ...;
```
The comment at `:94-96` states the rule outright ("Trees want deep, moist, sheltered ground... Heath takes thin soil where it's always wet, wind-scoured or sour, the way moorland does"). ~24 uncited thresholds. This is the island's biome map, and it is a **second, independent habitat model** that disagrees with `niche.ts`'s per-species curves: which are the physically-shaped version of the same thing. The shading cascade `shrub = pShrub * (1 - tree)` is a fixed hierarchy rather than light competition.
*Replacement.* Compute cover shares from the same per-species fits `niche.ts` already provides, resolved by competition for light (Beer-Lambert extinction through cumulative LAI) and for water (the seasonal balance already at `:83-91`). One law instead of two; the "moor" and "harsh" constructs vanish because exposure, pH and waterlogging are already axes in the niche curves. The treeline ramp `summer 11..15 °C` should be the *measured* treeline isotherm.
*Sources.* Körner & Paulsen (2004) global treeline isotherm (growing-season mean soil 6.4 ± 0.7 °C); Beer-Lambert light extinction with measured k ≈ 0.4-0.6 per unit LAI.
*Impact: high: this is the biome map. Effort: medium, and it removes code rather than adding it.*

#### niche.ts

**P32. The NICHE table: ~700 uncited numbers.** `niche.ts:35-59`
```ts
pine: { warm: [8, 12, 22, 28], cold: [-25, -15, 6, 10], water: [0.15, 0.35, 1, 1.1], wet: [-1, 0, 0.3, 0.7], ph: [3.4, 4, 6.5, 8], fert: [-1, 0, 0.5, 1.2], light: [0.3, 0.7, 1, 1.1], wind: [-1, 0, 0.6, 0.95], salt: [-1, 0, 0.4, 0.7], soil: [0.1, 0.3, 9, 10], tall: 17, evergreen: true, vigor: 0.45 },
```
23 species × up to 10 four-point curves. The **architecture is the model of the standard** and should be kept verbatim: the header comment says it exactly: *"Nothing says where a plant grows. It grows wherever it fits, and loses to those that fit better and stand taller."* The problem is purely that every bound is invented.
*Replacement.* These axes map one-to-one onto measured indicator systems: light (L), moisture (F), reaction/pH (R), nitrogen/fertility (N), salt (S) and continentality are literally Ellenberg indicator values, published per species for the entire European flora; `warm`/`cold` bounds are species climate envelopes from occurrence databases; `soil` is rooting-depth requirement from silvicultural handbooks.
*Sources.* Ellenberg indicator values (Ellenberg et al. 1991; Hill et al. 1999 for the British flora); EU-Forest / Chorological Maps occurrence envelopes; a silvics handbook per species.
*Impact: high (this table decides every plant's distribution, hence food, firewood, flint-free resources). Effort: medium: 23 rows × one citation each.*

**P33. `vigor`: a knob with no physical counterpart.** `niche.ts:32-34, 78, 81`
```ts
// vigor: how hard it competes where others fit as well...
sum += fits[k] * fits[k] * (NICHE[names[k]]?.vigor ?? 1);
```
Also note the fits are **squared** at `:78` and `:81` with no stated reason. *Replacement:* competitive outcome should fall out of measured shade tolerance (which the `light` curve already represents) plus growth rate and maximum height: all measured. *Sources:* Niinemets & Valladares (2006) shade-tolerance scores; species height/growth curves. *Impact: medium. Effort: small.*

**P34. Waterlogging proxy.** `niche.ts:97`
```ts
wet: Math.max(Math.exp(-b(isle.table) / 0.5), b(isle.peat)),
```
A 0.5 m e-folding converts water-table depth into a 0-1 "waterlogged". *Replacement:* the share of the growing season the root zone is anoxic, from the table's seasonal position against the species' rooting depth (both available). *Impact: medium. Effort: small.*

#### flora.ts

**P35. Every object density is `cover × magic + dice`.** `flora.ts:223, 229, 245, 251-252, 258, 265-266, 270, 274, 278, 292-295, 297, 302`
```ts
for (let c = Math.floor(marsh * 1.1 + edge * (0.5 - sand * 0.4) + r()); ...)          // :223 reeds
for (let c = Math.floor(Math.max(silt, 1.5 * ramp01(clayey - 0.2)) * (0.08 + 0.5 * edge) + r()); ...)  // :229 clay
for (let c = Math.floor(tree * 3.6 + r()); ...)                                       // :245 trees
const edge = tree * (1 - tree) * 4;                                                   // :251 edge effect
for (let c = Math.floor((shrub * 5 + edge * 1.2) * 0.6 + r()); ...)                   // :252 bushes
for (let c = Math.floor(bare * 1.6 + slope * 1.5 + r() * 0.8); ...)                    // :258 boulders
const patch = clamp(0.35 + 1.3 * noise(x0 / 45, z0 / 45, 91), 0, 1.7);                 // :265
for (let c = Math.floor(bare * 1.2 + sand * 0.3 + rv * 1.5 + slope * 0.6 + 0.1 + r()); ...)  // :266 stones
for (let c = Math.floor(bare * 1.2 + sand * 1.0 + rv * 2 + 0.08 + r()); ...)           // :270 pebbles
for (let c = Math.floor(tree * 0.7 + edge * 0.15 + 0.01 + r()); ...)                   // :274 sticks
for (let c = Math.floor(tree * 0.12 + r()); ...)                                        // :278 fallen logs
low(FUNGI, tree * m * 0.25 + grass * 0.03, ...)                                         // :292
low(HERBS, (grass * m * 0.25 + shrub * 0.06) * 3.5 * patch, ...)                        // :293
low(FERNS, (tree * 0.5 + shrub * 0.15 + edge * 0.3) * m * (0.5 + patch), ...)           // :294
low(FLOWERS, (grass * (0.3 + m * 0.2) * (1 - tree) + marsh * 0.15 + edge * 0.1) * 3.5 * patch, ...)  // :295
for (let c = Math.floor((grass * (1 - tree) * 20 + edge * 3.75) * patch + r()); ...)     // :297 tussocks
for (let c = Math.floor(bare * 0.04 * rockAt(isle, x0, z0).ore + r()); ...)              // :302 ore
```
Merged: ~30 uncited multipliers, one rule. These counts **are the resource economy**: how much firewood, how much stone, how much flint-bearing rock, how much food.
*Replacement.* (a) Stems: the stand's carrying capacity from the self-thinning line `N ∝ D^-1.605` (Reineke 1933) / the -3/2 power law, at the canopy closure the site's LAI supports: so tree count follows from site productivity and tree size instead of `tree * 3.6`. (b) Deadwood (sticks, logs): coarse woody debris is a pool at steady state between mortality/litterfall input and decay, both measured (temperate forest CWD 10-100 m³/ha, decay k ≈ 0.01-0.1 /yr). (c) Boulders and stones: surface clast density is the regolith's clast fraction (a P11 property) weathering out against the rate soil production buries it: the same soil-production function as P24. (d) Ore and flint: nodule abundance per m³ of rock (P11) × the volume exhumed, not `bare * 0.04`.
*Sources.* Reineke (1933) / Yoda's -3/2 law; a CWD inventory study (e.g. Harmon et al. 1986) for the deadwood pool; block-size-distribution literature for clasts.
*Impact: high. Effort: medium-large.*

**P36. Every object size is `a + random*b`: uniform, where nature is log-normal.** `flora.ts:150, 153, 225, 231, 249, 256, 260, 268, 272, 276, 280, 292-299, 304`
```ts
export const TALL = { pine: 17, oak: 15, ash: 16, aspen: 13 } as const;               // :150
export const TALLEST = Math.max(...Object.values(TALL)) * 1.2 * 1.25, BOULDER = 0.5 + 5;  // :153
put(F.tree, S[sp], x, z, TALL[sp] * clamp(0.45 + 0.75 * treeF[...], 0.45, 1.2) * (0.7 + r() * 0.55));  // :249
put(F.boulder, 0, x, z, 0.5 + r() ** 3 * (BOULDER - 0.5));                             // :260
put(F.stick, 0, x, z, 0.4 + r() * 1.2);                                                // :276
put(F.fallen_log, ..., 2 + r() * 7);                                                   // :280
```
The uniform distributions are the tell: natural size distributions are log-normal (stems, boulders) or power-law (fragment sizes), never uniform. `TALL` duplicates `niche.ts`'s `tall` field: two sources of truth. `TALLEST = TALL × 1.2 × 1.25` is a magic-number product.
*Replacement.* Tree height is site index: the asymptote of a growth curve set by the site's water, nutrients and season length (Chapman-Richards/Weibull with measured parameters per species), with a within-stand diameter distribution that is log-normal/Weibull. Log length follows from the stems that produced it. Boulder size follows the parent rock's joint spacing: measured block-size distributions are log-normal or power-law.
*Sources.* Species site-index curves from forest mensuration tables; a rock-mass block-size-distribution study.
*Impact: medium-high. Effort: medium.*

**P37. Sub-cell relief and biome-edge jitter.** `flora.ts:104-105, 111`
```ts
const swell = 2.6 * fbm(x / 240, z / 240, 7, 3) + 0.8 * fbm(x / 60, z / 60, 8, 2);
h[i] = base + smooth(-2, 6, base) * (1 - wf) * swell - rv * 1.8;
share[n] = Math.max(0, bilinear(src[n], cx, cy) * (1 + 0.85 * fbm(x / 150, z / 150, 40 + n, 2)));
```
Sub-cell relief invented as noise (legitimately `[design]`, but unmarked), and the river bed cut by a flat **1.8 m**: contradicting `water.ts depthOf`, which gives 0.1-1 m for the actual flows. The `0.85` cover jitter is a hand-set edge wander. *Replacement:* carve the bed at `depthOf(q)` for the stream actually there (`streamAt` already returns `q`); mark the swell `[design]` with its amplitude tied to the measured roughness spectrum of hillslopes. *Impact: medium (bed depth governs crossing, drinking, and the river mask). Effort: small.*

**P38. `dry()` and the elevation/wetness cutoffs that gate everything.** `flora.ts:123, 225, 231, 234`
```ts
const dry = (x, z) => fine(wet, x, z) < 0.15 && riverAt(x, z) < 0.25 && heightAt(x, z) > 0.8;  // :123
if (fine(wet, x, z) < 0.6 && heightAt(x, z) > 0.2) put(F.reeds, ...)                            // :225
if (fine(wet, x, z) < 0.4 && heightAt(x, z) > 0.4) put(F.clay, ...)                             // :231
if (wet[i] > 0.3 || h[i] < 0.8) continue;                                                        // :234
```
Hand thresholds on a 0-1 wetness proxy and on absolute elevation (0.2, 0.4, 0.8 m) decide where anything can stand. *Replacement:* a point is dry if its ground is above the local water surface: `waterAt` already computes that level, in metres. *Impact: low-medium. Effort: small.*

**P39. `groundClass`: a hand-set classification ladder with name comparisons.** `flora.ts:362, 414-418`
```ts
const COV = [...] , WEIGHT = [1.0, 1.05, 1.2, 1.5, 1.3, 1.6];                              // :362
const base  = best === ROCK && cover[4] < 0.6 ? HILL : best;                                // :414
const bare  = base === ROCK && slope < 0.32 && exposure < 0.36 ? HILL : base;               // :415
const cls   = slope > 0.7 && bare !== SAND ? ROCK : slope > 0.5 && (bare === MEADOW || bare === SCRUB) ? HILL : bare;  // :417
const rocky = cls === ROCK || (cls === HILL && fbm(x / 45, z / 45, 26, 2) + cover[4] * 0.8 + (slope - 0.5) * 2 - 0.8 > 0);  // :418
```
`WEIGHT` is a pure category tiebreak: six hand-set numbers deciding which cover "wins" a point, with no physical meaning at all. Then four chained `category === NAME` tests. The slope numbers are partly grounded by the comment at `:416` (35° repose, 27° outcrops) but the `0.32 / 0.36 / 0.6 / 0.8` set is not. *Replacement:* the classes are display labels; derive them from the cover shares (largest share wins, no weights) plus one physical criterion for rock: soil depth below what the slope can retain, i.e. the same repose criterion already in `ground.ts:62`. *Impact: medium (`cls` is read by the map, the inspector, and anything branching on ground type). Effort: small-medium.*

#### land.ts

**P40. Four-way tile classification by threshold.** `land.ts:53-54`
```ts
if (wet[t] >= (R * R) / 2) { tiles[t] = Tile.Water; level[t] /= wet[t]; }
else tiles[t] = tile.bare[t] - tile.sand[t] >= 0.5 ? Tile.Rock : tile.tree[t] >= 0.45 ? Tile.Forest : Tile.Grass;
```
`0.5` and `0.45` collapse continuous cover into four named tile types: a **fourth** cover classifier, disagreeing with `ground.ts:93-107`, `niche.ts` and `flora.ts:414-418`. `Tile` is consumed by the sim, not only the renderer, so the thresholds have behavioural weight. *Replacement:* read the continuous shares (`lay` already ships them in `tile`); if a discrete label is needed, take it from the one shared rule P31/P39 establish. *Impact: medium. Effort: small-medium.*

**Not flagged in land.ts:** `mean()`, the base64 packing, `Math.max(-100, h)` and the 255-quarter-metre water cap (`:84-90`) are serialization limits, and the corner-height averaging (`:67-81`) is interpolation. Plumbing.

#### grid.ts

Nothing to flag. `N = 256`, `CELL = 75`, `TILE_CELLS = 2` (`:4-6`) are resolution choices, legitimately so. Worth recording, though, that they are *not* neutral: because P5, P13 and P22 express rates as per-cell and per-step fractions, the world's physics changes with the grid. That is the strongest practical argument for the dimensional rewrite.

---

### behaviour

Nothing in `src/terrain` is agent cognition, belief, group or planning code. The two nearest things are world physics and are flagged above, not here:
- `niche.ts:78,81` `vigor` + squared fits: plant competition weighting (see P33).
- `flora.ts:362` `WEIGHT`: cover tiebreak for display classes (see P39).

Not flagged as rules: the seeded per-quad RNG (`flora.ts:166-172, 211`), `hash`/`noise`/`fbm` and the gradient tables (`flora.ts:17-33`), `streamAt`'s bin cache and `worldSlope`'s grid cache (`flora.ts:331-358, 386-404`): all plumbing.

---

### physical_already

These follow the standard or are correct plumbing. Where a comment names a source I've noted it; none carry an R-number, so the cheapest compliance win in these files is to add R-numbers to the ones already named.

1. `climate.ts:28-30`: `qsat`/`esat`: Magnus saturation vapour pressure, named in the comment and cross-referenced from `fire-constants.md:340,354` ("the Magnus es climate.ts uses"). The one terrain constant the repo effectively cites.
2. `climate.ts:241-252`: clear-sky insolation: Kasten & Young air mass, Meinel's beam `S0 · 0.7^(am^0.678)`, Liu & Jordan's diffuse share, `S0 = 1361` W/m². All three named in the comment at `:235-237`; the same formulation is cited as R70 in `fire-constants.md:341`.
3. `climate.ts:196-219`: `horizons`: per-bearing horizon raycast and the `1/(1 + tan²)` = cos² sky-view integral. Correct geometry, no free parameters.
4. `climate.ts:301-317`: `penman`: FAO-56 Penman-Monteith reference ET, named in the comment, and the paper's own coefficients (0.408, 0.34, 900, 4.903e-9, 0.77, 0.000665, the 5.26 pressure exponent). Reference R221 in `fire-constants.md:1920`. (The snow tail at `:314` is P10.)
5. `climate.ts:279`: the four-season-mean → annual harmonic reconstruction (`mean`, `a1`, `b1`, `a2`): correct Fourier algebra, derived not fitted.
6. `climate.ts:32-42` + `:144-191`: `downwind` counting sort and the upwind-ordered advection sweep, with the slice width argued from the read stencil (`:33-34`). Correct scheme (its coefficients are P5).
7. `water.ts:46-78`: `aquifer`: steady Dupuit groundwater with harmonic-mean interface transmissivity, over-relaxation, and a seepage-face condition (`head` never above ground). A real governing law, named in the comment. Coefficients are P20.
8. `grid.ts:70-91`: `flood`: priority-flood, **Barnes et al. 2014 cited by name and year**: the only full citation in `src/terrain`.
9. `grid.ts:94-108, 111-121, 124-139`: `receivers` (D8 steepest descent), `accumulate` (topologically ordered flow accumulation), `distance` (two-pass chamfer). Standard, correct.
10. `water.ts:150-159`: lake existence by inflow against surface evaporation, solved over the depth-sorted cells. The right process (a water balance), and the right shape (a lake shrinks until its area's evaporation matches its inflow). Coefficients are P22.
11. `water.ts:219-225`: floodplains by height above nearest drainage, **Rennó named** in the comment. Structure right; bounds are P22.
12. `island.ts:40-98`: `erode`: stream power with **Braun & Willett 2013 named**, implicit at n = 1, plus linear hillslope diffusion, with the scheme's stability and step-count equivalence argued at `:61`. The right two laws; the dimensionless constants are P13.
13. `niche.ts:24-28, 61-72, 86-99`: `curve`, `fit`, `lightFit`, `envAt`: fit = product of per-axis smooth response curves over physical quantities, NaN axes skipped, no biome labels anywhere. This is the architecture the operator's standard asks for, stated in the header comment. Only the numbers (P32) are missing sources.
14. `ground.ts:83-91`: the seasonal root-zone water balance: supply, demand, capacity, two years for convergence, deficit-over-demand as drought, with groundwater access as a floor. A real process; `fire-constants.md:1018` already builds on it ("the generator's seasonal bucket"). Capacity is P30, and the rival `BUCKET` in `water.ts:16` is P17.

**Plumbing, not audited as rules:** `grid.ts` in full (sample/ramp/blur/Heap), `land.ts` packing and encoding, `flora.ts` noise/hash/bin caches and the `Scatter` tile-bucketing, `water.ts` solver tolerances, `island.ts`'s `Stage`/`Watch` instrumentation.

---

### Cross-cutting notes

- **Four rival cover models.** `ground.ts:93-107` (cell cover shares), `niche.ts:35-59` (per-species curves), `flora.ts:414-418` (`groundClass`) and `land.ts:53-54` (`Tile`) each decide independently what the ground is, with four unrelated sets of thresholds. Collapsing to one: niche fits resolved by light and water competition, with labels derived afterwards: is simultaneously the biggest physics win and a net deletion of code.
- **Two rival soil-water models.** `water.ts:16` `BUCKET = 100` mm island-wide vs. `ground.ts:113` `holds()` per cell. They disagree, and the runoff that feeds every stream uses the cruder one.
- **Two rival orographies.** `climate.ts`'s wind-direction-aware condensation vs. `island.ts:70`'s elevation-only `1 + 0.5·h/top`. The landform is carved by rain that has no rain shadow.
- **Two rival channel depths.** `water.ts:21` `depthOf(q)` (0.1-1 m) vs. `flora.ts:105`'s flat `rv * 1.8` m bed cut.
- **Cheapest compliance wins (source already in-repo):** P3 (Byram-Jemison loss coefficient, `fire-constants.md:338`, R70), P8 (cloud transmittance, R70), P30 (FAO-56 Table 19, R221), P22's `1.1` open-water Kc (R221). Four findings closed by citing references the repo already holds.
- **Highest leverage overall:** P13 + P14 together (dimensional erosion, so relief emerges instead of being drawn), P1 + P4 (seasons and rainfall from the sun and the moisture flux instead of two tables and a die), and P31 + P32 (one cited niche model instead of a hand-written habitat key plus an uncited curve table).

[Showing lines 1-193 and 296-467 of 467; 102 middle lines (11.2KB) elided. Read artifact://2366 for full output]

## brain.ts, beliefs.ts, groups.ts

## Audit: brain.ts, beliefs.ts, groups.ts

All three files read in full (brain.ts 1-515, beliefs.ts 1-499, groups.ts 1-582). Cross-checked physics.ts (Outcome/Decision/Make, hand/stash/unstash/nearFire/leaveHome/reaches, the ruled-outcome path at 1578-1590) and rules.ts (RULES.learning / RULES.truth) to confirm which of these rules actually reach the world.

---

### physics: rules that decide a WORLD outcome

#### P1. An LLM's 0-4 scores become a material's permanent physical properties, then get clamped by uncited magic factors: brain.ts:423-453

```ts
for (const prop of relevant) q[prop] = { type: "score", instructions: `If it did make something, how ${prop} would the result be?`, criteria: LEVELS };
...
const v = ans[prop].score! / (LEVELS.length - 1);
if (v >= 0.15) props[prop] = Math.round(v * 100) / 100;
props.toughness = Math.min(...parts.map((k) => k.props.toughness ?? 0.2));
props.edible = Math.min(props.edible ?? 0, least("edible") * 1.3);
props.toxic  = Math.max(props.toxic ?? 0, most("toxic") * 0.5);
props.seed   = Math.min(props.seed ?? 0, most("seed") * 0.5);
props.binding = Math.min(props.binding ?? 0, Math.max(most("binding"), most("plastic") * 0.6, most("fibrous") * 0.5));
props.sharp  = Math.min(props.sharp ?? 0, most("sharp") + 0.2);
const novel = relevant.some((prop) => (props[prop] ?? 0) > Math.max(...parts.map((k) => k.props[prop] ?? 0)) + 0.15);
return { useful: ans.useful.noul! >= 0.6 && novel, name: templateName, props };
```

Why it is a high-level rule: this is the one place in the batch where a *language model* authors physics. The returned `props` are frozen into a permanent `Kind` (`law:${key}`, physics.ts:1578-1590, called from sim.ts:780) and from then on every physical computation in the game: nutrition, burning, cutting, binding, poisoning: reads those numbers. The conservation layer that tries to keep it honest is itself a stack of uncited multipliers: why is a mixture allowed to be 1.3x as edible as its least-edible part? Why is toxicity halved, seed viability halved, plastic 0.6 of binding, sharp +0.2, novelty 0.15, usefulness 0.6? `props.toughness = min(parts)` is a hardcoded weakest-link law, and the `?? 0.2` default toughness is a bare magic number. `relevant = PROPS.filter(prop !== "metal")` is also a category switch ("metal can't be made by mixing") standing in for the real reason: reduction of an oxide needs a reducing atmosphere above a threshold temperature.

Low-level physics that replaces it: composite/mixture laws over the measured properties of the parts, by volume or mass fraction.
- stiffness/strength of a joined thing: Voigt (iso-strain) and Reuss (iso-stress) bounds on the constituents, with the weaker bound for randomly oriented fibre; failure at the lower of constituent fracture stress and interface shear strength.
- adhesion/binding: adhesive lap-shear strength (MPa) times bonded area vs the load the joint must carry.
- edibility: mass-weighted metabolisable energy and macronutrient content of the parts, no bonus possible (first law); zero if an indigestible fraction dominates.
- toxicity: concentration after mixing (mass fraction) against a dose-response threshold (LD50/NOAEL per kg body mass): dilution lowers dose linearly, it is not "halved".
- seed viability: viability is a property of the embryo, destroyed by crushing/heating above the lethal temperature, not scaled by 0.5.
- sharpness: edge radius and included angle of the formed edge against the yield strength of the material being cut.
Likely sources: Ashby, *Materials Selection in Mechanical Design* (property charts, mixture bounds); Callister for composite rule-of-mixtures; adhesive handbook lap-shear data; USDA FoodData Central for food composition; a toxicology reference (e.g. ECHA/Gosselin) for LD50; seed-physiology literature for thermal death kinetics.

Impact: **high** (it writes world law and compounds: every later use of the invented kind inherits it). Effort: **large** (needs a real property model for composites plus a measured property table; it also removes the need for an LLM ruling at all, which is the point).

#### P2. What an agent can perceive is decided by kind/species/prop-name switches: brain.ts:119-122, 143-152

```ts
const words = Object.entries(k.props).filter(([p, v]) => p !== "toughness" && (p !== "metal" || (v ?? 0) >= 0.9) && (v ?? 0) >= 0.45)...
...
if (t.kind === "pebble" || t.kind === "grass" || (t.kind === "bush" && t.species === "berry" && !t.n) || !canSee(w, a, t, 60)) return;
if (t.kind === "boulder" && t.inside?.flint) kind = "boulder studded with dark nodules";
```

Why it is a high-level rule: visibility is decided by a thing's name, not by its optics. Pebbles and grass are invisible *because they are pebbles and grass*; a berry bush vanishes entirely when `!t.n` rather than becoming a bush without fruit; flint inside a boulder is perceivable because of a category test (`kind === "boulder" && inside?.flint`), with the counterpart rule that metal is hidden until `prop >= 0.9` and any property under 0.45 is simply not perceived. These thresholds pick what agents act on, so they decide world outcomes downstream (which stone gets struck, which bush gets harvested). Note also brain.ts:145, `["pile of stuff", "lean-to", "hut", "cabin"][t.shelter?.tier ?? 0]`: a structure's identity read off an integer tier rather than its enclosed volume, wall area and leak rate.

Low-level physics that replaces it: detection as a contrast/acuity threshold. A thing is seen when its angular size exceeds visual acuity at that distance (≈1 arcmin for a resolved detail, with a lower limit for a detected point) **and** its luminance contrast against the background exceeds the threshold for the ambient adaptation level: the data `light.ts` already produces (`lightOn`, `canSee`). Flint nodules then show because their reflectance differs from the host rock over a patch of a given angular size; berries show when their red-vs-green contrast and summed subtended area clear the threshold; grass is "seen" as ground cover rather than as items because each blade is below acuity.
Likely sources: Blackwell's contrast-threshold data / CIE 19 (visual performance), Barten's contrast-sensitivity model; spectral reflectance tables for minerals and foliage.

Impact: **medium** (shapes every action choice). Effort: **medium** (one acuity+contrast function, plus reflectance/size per material: most of the inputs exist already).

#### P3. Hardcoded perception, witness, learning and hearing radii: brain.ts:143, 158, 161, 165, 166; beliefs.ts:446, 493; groups.ts:468, 475, 510, and takeShared's witness filter

```ts
around(w, a.px, a.py, 60, null, (t, d) => { ... !canSee(w, a, t, 60) ...
w.animals.filter((x) => canSee(w, a, x, 300))
canSee(w, a, b, 300) ? b.status : "out of sight"
carrying: canSee(w, a, b, 30) ? inventoryText(w, b) : undefined
// beliefs.ts
if (b === doer || b.down > w.t || !canSee(w, b, doer, 25)) continue;   // learning by watching
export function see(w, center, key, text, radius = 70)                 // facts about the world
// groups.ts
const speakers = members.filter((a) => (nearFire(w, a, 4) && company(a, 30) >= 1) || company(a, 25) >= 2);
for (const b of w.agents) if (meters(b, s) <= 40) b.customs[c.id] = w.t;   // hearing a custom spoken
seenBy: w.agents.filter((b) => canSee(w, b, a, 30))
```

Why it is a high-level rule: nine different distances, each a round number with no derivation, decide what is perceived, who witnesses a deed (and therefore whether it is judged at all: groups.ts:168-172 drops unwitnessed incidents), who learns a technique, who hears a custom. 60 vs 300 vs 30 vs 25 vs 70 vs 40 vs 4 encode "detail", "silhouette", "what's in a hand", "close enough to copy", "earshot": real distinctions with real physics behind them, approximated by constants.

Low-level physics that replaces it: one visual-detection function (as P2: angular size vs acuity, contrast vs ambient luminance: detail tasks like "what is in their hand" fall out automatically because a held object subtends less than a person), and one acoustic function for speech: sound pressure falling as 1/r² (-6 dB per doubling) plus air absorption, against the ambient noise floor (wind, rain, fire), with speech intelligibility above the articulation-index threshold. "By the fire" should be the fire's own radiant/illuminance footprint from `fireOutput`, not 4 m.
Likely sources: ISO 9613-2 (outdoor sound propagation), ANSI S3.5 speech-intelligibility index, typical conversational SPL at 1 m (≈60 dB); Blackwell/CIE for the visual side.

Impact: **medium** (gates learning, judging and social contagion). Effort: **medium**.

#### P4. A drive state is docked by a fixed amount per named verdict: groups.ts:259, 271, 304

```ts
if (doer) { doer.needs.social = Math.max(0, doer.needs.social - 10); p.open = w.t + WATCH; }   // scold
... doer.needs.social = Math.max(0, doer.needs.social - 15); ...                                // shun
doer.needs.social = Math.max(0, doer.needs.social - 25);                                        // exile
```

Why it is a high-level rule: `needs.social` is state in the same struct as food and warmth, and here it is edited instantaneously by 10/15/25 chosen to rank three verdict *names*. Nothing physical happens at the moment of the verdict; what actually changes is who will be near whom over the following days.

Low-level process that replaces it: let the need follow from company. The ingredients exist: `a.near[id]` accumulates time spent near someone (brain.ts:418-419) and `company()` counts neighbours within a radius. Social need should integrate over time: recovery proportional to time in company (weighted by relationship), decay toward deficit when alone, a first-order process with a measured time constant. Then a scolding costs nothing directly, a shunning costs exactly the company the shunned person loses, and exile costs more because it also moved their home. Shunning/exile already set `camp.shunned`/`camp.exiled`, which the rest of the code honours, so the deficit emerges.
Likely sources: loneliness/social-isolation literature for the time constant (days, not ticks); this one is partly `[design]`: the honest form is a documented first-order deficit model with a cited time constant, not three magic subtractions.

Impact: **medium** (drives behaviour and, through it, survival). Effort: **small**.

#### P5. Fixed item counts in transfers, and a name-keyed choice of what gets handed over: groups.ts:290-293, 502, 510, 517

```ts
for (const k of inc.items ?? []) moved += hand(w, from, dest, k, 2);          // "twice over"
const k = [...new Set(from.inv.map((s) => s.k))].sort((x, y) => p(w.kinds[y], "edible") - p(w.kinds[x], "edible"))[0];
const n = stash(w, a, 2, at);                                                 // keep 2 food back
incident(w, { ... value: Math.min(1, n / 8), ... });
const got = unstash(w, a, store, k, 3);                                       // take 3
```

Why it is a high-level rule: how much matter moves is set by literals (2, 2, 3) and the "value" of a deed by `n / 8`. The substitute-compensation rule picks whatever item has the highest `edible` property: an item-property lookup standing in for "something worth as much as what was taken". `unstash` is at least bounded by `carryOf` inside physics.ts:1477, which is the right shape; the callers' literals are not.

Low-level physics that replaces it: transfers bounded by load: total mass and bulk against carrying capacity (a fraction of body mass, measured: soldiers/porters carry ~20-35% of body mass sustainably), and the number taken bounded by what the taker can actually carry and what the store holds. "Value" of a deed should be the metabolisable energy (kJ) or the replacement work (person-hours of foraging/knapping) of what moved, relative to the holder's daily requirement. Compensation should then be matched in those units, not by sorting on an `edible` score.
Likely sources: load-carriage physiology (Pandolf/Givoni energy-cost equations, Soule & Goldman carriage limits); FoodData Central for energy density; ethnographic foraging-return-rate tables (Kelly, *The Lifeways of Hunter-Gatherers*) for the work-equivalent.

Impact: **low-medium**. Effort: **small**.

#### P6. Customs appear only between clock hours 18 and 22, and then on a coin flip: groups.ts:459-465, 468

```ts
const h = ((w.t % DAY) / DAY) * 24;
if (h < 18 || h >= 22) return;
...
if (!pat || Math.random() > 0.5) continue;
const speakers = members.filter((a) => (nearFire(w, a, 4) && company(a, 30) >= 1) || company(a, 25) >= 2);
```

Why it is a high-level rule: "evening" is a pair of clock numbers rather than a light level, so it does not move with season or latitude, and the world already computes illuminance (`light.ts lightOn`, used elsewhere in brain.ts:219-222). The dice gate (`Math.random() > 0.5`) decides whether an event happens at all, with no rate behind it. `nearFire(w, a, 4)` hardcodes the gathering radius instead of using the fire's own output.

Low-level physics that replaces it: the condition is "people are gathered, idle and lit": i.e. ambient daylight below the threshold at which outdoor work stops (civil-twilight illuminance, order 3-10 lx) with firelight above the threshold for seeing faces, and the gathering radius taken from the fire's illuminance/irradiance falling off as 1/r² from `fireOutput` (the same curve `warmth` already uses). Replace the coin flip with a hazard rate per gathered person-hour so the chance follows from how long and how many sat together.
Likely sources: CIE twilight illuminance values; fire-constants.md's existing flame output and radiant-fraction sections for the 1/r² footprint.

Impact: **low-medium** (decides when norms crystallise). Effort: **small**.

#### P7. A season switch adds a magic constant to scarcity: groups.ts:161

```ts
const scarcity = (w: World) => (w.agents.reduce((t, a) => t + Math.max(0, 1 - a.needs.food / 70), 0) / Math.max(1, w.agents.length)) + (w.weather.season === "winter" ? 0.15 : 0);
```

Why it is a high-level rule: the first term is measured (mean food deficit, though `/70` is itself a magic normaliser); the `+0.15 if winter` is exactly the pattern the standard forbids: a named category deciding a physical quantity. Scarcity feeds the judge's context and `times_are` (groups.ts:239), so it shapes verdicts and hence world state.

Low-level physics that replaces it: measured availability: standing edible biomass within foraging range plus stored food, divided by the camp's aggregate daily energy requirement (BMR via Mifflin-St Jeor plus activity factor x population). Winter then reads as scarce because the plants actually hold no fruit, which ecology.ts/plants.ts already track.
Likely sources: net primary productivity / phenology data for the biome; FAO energy-requirement tables for human requirement.

Impact: **low**. Effort: **small**.

#### P8. A place's character from magic tile counts in a fixed window: groups.ts:115-124

```ts
for (let dy = -6; dy <= 6; dy++) for (let dx = -6; dx <= 6; dx++) { ... water++ / rock++ / wood++ }
return water > 25 ? "by the lake" : water > 0 ? "by the water" : rock > 12 ? "under the crags" : wood > 40 ? "in the woods" : wood > 10 ? "at the wood's edge" : "on the open meadow";
```

Why it is a high-level rule: six uncited thresholds over a 13x13 window (169 tiles) decide what the land *is*, and the result becomes the camp's name and part of the naming prompt. The window size and every cut point are hand-tuned; `water > 0` means a single water tile 6 tiles away makes a camp "by the water".

Low-level physics that replaces it: the visible terrain fraction within sight distance: solid angle (or horizon-weighted area) occupied by each cover type as seen from the camp centre, using the same acuity/sight model as P2-P3, with "by the lake" meaning open water dominates the view and "at the wood's edge" meaning the canopy boundary crosses the near field. Canopy closure is already a quantity the crown/light rebuild produces.
Likely sources: viewshed/solid-angle geometry; the existing canopy-closure definition in light.ts / crown work.

Impact: **low** (naming only). Effort: **small**.

#### P9. Narration asserts the cause instead of reporting the computed effect: beliefs.ts:303-371 (and 373-377)

```ts
const THING_WORD: Record<string, string> = { sapling: "young plant" };
const fireWord = ({ hearth: "a ringed fire", kiln: "a ringed fire heaped over with stone", forge: "a ringed charcoal fire" } as Record<string, string>)[f.at ?? ""] ?? "a fire";
case "eat": if (f.effect === "sick") return `Eating ${ins[0]} can make you sick.`;
            if (f.effect === "cure") return `Eating ${ins[0]} helps when you're sick.`;
case "wear": return `Wearing ${ins[0]} keeps the cold out.`;
case "pour": return later ? `Pouring ${an(ins[0])} over ${onto} helps it grow.` : ...
const useful = (o: Outcome) => o.ok || !!o.effect || !!o.fields.gives.length || (!!o.fields.builds && o.fields.builds !== "pile" && o.fields.builds !== "ring");
const BUILT: Record<string, string> = { bush: "planting", worn: "clothing", cured: "a cure", pile: "", ring: "", stored: "", fed_fire: "" };
```

Why it is a high-level rule: the text is a `switch` on verb plus an effect *name*, so it asserts a causal claim ("keeps the cold out", "helps it grow", "can make you sick") independent of magnitude. A fur with negligible insulation and a thick hide produce the same sentence; water poured on a plant already saturated still "helps it grow". Because this text is what the LLM reads back as `what_they_know_works`, an assertion that outruns the physics steers decisions. The `useful`/`BUILT` tables are name-keyed category switches deciding whether an outcome is worth remembering at all (`builds !== "pile" && builds !== "ring"`), and `fireWord` identifies a fire installation by the string `hearth`/`kiln`/`forge` rather than by its enclosure and temperature.

Low-level physics that replaces it: generate the sentence from the quantities the outcome already carries: clothing from the computed clo/thermal resistance and the resulting change in heat loss (W) at the current air temperature; watering from the change in soil water potential relative to the plant's wilting point; sickness from the ingested dose against the dose-response threshold; a "kiln" from the measured enclosure and peak temperature reached. The belief then says what was observed, with a magnitude, and can be wrong only in the way observation can be wrong.
Likely sources: ISO 9920 (clothing thermal insulation), ASHRAE comfort/heat-balance; soil water-potential and wilting-point data; dose-response toxicology.

Impact: **low-medium** (it is the channel through which physics reaches the decision-maker). Effort: **medium**.

#### P10. The world's "laws" are a per-combination lookup keyed by action signature, and admit LLM-authored entries: beliefs.ts:379-381

```ts
const law = (w.laws[key] = { id: `L${...}`, key, text: sentence(w, f, ticks, later), verb: f.verb,
  source: ruled ? "jev" : "physics", by: a.id, t: w.t, result: { gives: f.gives, builds: f.builds, effect: f.effect, target: f.target } });
```

Why it is a high-level rule: `key` is `verb|inputs|tool|target|at|shape` (beliefs.ts:331-332), so a "law of the world" is one row per concrete combination of named items. Nothing generalises: striking flint with one hammerstone and with another are two laws. `source: "jev"` is the admission that some rows were authored by the model (the P1 path). Note the discovery registry itself is legitimate as a *record of what has been observed*: the problem is that it is the only statement of law there is, so adding a new item means adding rows rather than the new item having properties.

Low-level physics that replaces it: laws stated over properties, not names: a single relation per process (impact fracture when the delivered energy exceeds the toughness-area product; ignition when the hot-spot energy exceeds tinder's ignition energy; and so on), with the per-combination rows demoted to what they honestly are: each agent's log of observed instances. Then an unseen combination is computed, never ruled on.
Likely sources: the same process references as P1, plus whatever fire-constants.md already cites for ignition.

Impact: **medium** (it is the structural reason P1 exists). Effort: **large**, and largely the same work as P1.

---

### behaviour: agent cognition and social machinery (brief)

- **Offline goal leans**: brain.ts:212-247 `needBias`: thresholds (food<45, energy<30, warmth<60/40), weights 8/6/5/4/3/2, ramps `6 + (40 - warmth)/2`. Only used with `NOMADS_BRAIN=random`; shapes which goal an offline agent picks.
- **Trait→act tables**: brain.ts:250-258 `PULL`, `AGAINST`; brain.ts:334-348 `WARM`/`COLD`/`REPLY_PULL`. Hand-authored mappings from trait names to acts.
- **Grudge and fondness arithmetic**: brain.ts:261-266: `WRONGS` weights (1 / 0.7 / 0.25), `fondness` kin bonus +0.5; brain.ts:244 `0.1 + max(0, worst - 0.25)` as the gate on hostile acts.
- **Relationship updates**: brain.ts:388-389 asymmetric deltas (0.08 down, 0.12 up), trust 0.1; 393-399 `fits` label thresholds (-0.5/0.1/0.3/0.6/0.45, history<3); 405-419 `fadeBonds` (keep 0.96 ±0.04/0.03, `BOND_FADE ?? 0.85`, 0.99 drift, trust→0.3 at 3%, familiarity `min(0.06, together/3000)` past 40 ticks).
- **LLM sampling and gates**: brain.ts:86 `sample` sharpness 0.8 (1.6 for tinkering, 1 for verdicts); confidence floors 0.3 in `theorize`/`wonder`/`reflect`; `rule`'s offline `cap: 0.5`; `pickWord` 0.15 plausibility, top-3, 240-item chunks; `MILD`/`KIND` verdict leans (brain.ts:501-502).
- **Superstition**: beliefs.ts:427-432: `Math.random() > s * 0.5` attaches a spurious charm; drop condition `skeptical + observant > 0.3` (beliefs.ts:450).
- **Learning by watching**: beliefs.ts:459-462: rate `0.6 * (1 + observant + clever/2 + curious/2) * (child ? 2 : 1)`, threshold 1.0; teaching copies with `wins: Math.min(1, b.wins)` (487).
- **Epistemic statistics**: beliefs.ts:137-299: `THIN = 4`, optimism `+0.3/sqrt(tries+1)`, `fades` at tries≥2.5 / wins≥0.5 / diff≤0.1, `differed` agreement ≥0.75, `worseIn` at diff>se. Thresholds are tuning, but the machinery is principled (see below).
- **Learning-mode switch**: beliefs.ts:407, 454: `RULES.learning === "known" | "seen"` with `RULES.truth[key]`. Confirmed in rules.ts:9-11 that `truth` is empty by default and filled by `scripts/truth.ts` as a benchmark answer key: measurement scaffold, not world law, so it is a legitimate rule switch rather than a hidden rule. Worth keeping labelled as such.
- **Camp formation**: groups.ts:13-15, 40, 45: `LINK = 200 m`, affinity > 0.1 both ways, components of ≥3, `WATCH = 3 days`, `EXILE = 10 days`; eviction of a home within `LINK + 30` (303). The distance test itself uses real `meters()`; the cut-offs and timers are social constants.
- **Act category tables**: groups.ts:16-17 `HARM`/`HOSTILE`; 405-430 `ACTS`/`VICTIM`/`DONE` phrase tables; `patternKey` buckets need at ≥0.5; `COST` bucket `round(value*4)` (220).
- **Precedent, pattern, custom machinery**: groups.ts:440-446 `similar` scores (4/2/1/1/0.5, tolerance 0.25); 448-456 `customsAfter` fade at `broken ≥ 2 && broken > held`; `speak` requires `n ≥ 3` identical responses.
- **Standing and leadership**: groups.ts:360-366 `score = followed²/n`; 367-381 thresholds score≥2, share≥0.6/0.4/0.25, `settled` within 5 days, challenger needs `score > now*2 + 1`.
- **Compliance dice**: groups.ts:264 `Math.random() < r.comply && repay(...)`: a coin flip against an LLM probability decides whether restitution actually happens (it does move items; the physical half is P5).
- **Jev budget caps**: groups.ts:179 (400 incidents), 193 (24-tick duplicate window), 195 (4 verdicts/hour, 2 pending per camp), 253 (80 precedents). Plumbing/cost control, not world rules.

---

### physical_already: parts of these files that meet the standard

- **brain.ts:133-137 `blazeWords`**: flame height, flaming/glowing state and burn time read from `fireOutput`/`fireHours`, with the comment citing *fire-constants sec. 31*; thresholds are reporting cut-offs on a computed quantity, not rules.
- **brain.ts:184-189 weather/light/air wording**: delegates wholly to `lightOn`/`lightWords` (light.ts) and `airOn`/`airWords` (air.ts); no local thresholds.
- **beliefs.ts:143-299 inference machinery**: `apart` pools per-stratum differences with Mantel-Haenszel-style weights, `told` returns a pooled standard error, `odds` uses Laplace smoothing, `worseIn` tests against that standard error. Derived statistics with reasoning written out in the comments; the right shape, in a different domain.
- **beliefs.ts:410-419 belief bookkeeping**: fields and timing updated from observed outcomes (`b.ticks` as a decaying mean of actual durations, `b.rate` straight from `out.numbers.rate`), not asserted.
- **groups.ts transfers delegate to physics**: `hand`, `stash`, `unstash`, `leaveHome`, `reaches`, `nearFire` all live in physics.ts, and `unstash` is bounded by `carryOf` (physics.ts:1477); only the caller-side counts are magic (P5).
- **groups.ts:155-178 incident features**: `needOf`, `scarcity`'s first term, `value`, `repeat`, `seenBy` are computed from world state rather than asserted, so the judge reasons over measurements (the `/45`, `/70` normalisers and the winter term are the exception, P7).
- **groups.ts:29-45 `cluster`**: neighbourliness tested with real `meters()` between actual home positions via union-find; the threshold is social, the geometry is physical.