// What the ground is made of and what grows on it, from the physics of each spot: how its soil formed since the ice
// left, how wet it stays, how sour it is, what its organic matter feeds, and which plants keep themselves there and
// shade out the rest. There are no biomes here, only plants that cope or don't; forest, heath, meadow and bog are where
// they win. Every number is in docs/research/terrain-constants.md secs. 12 and 13.
import type { Season } from "./climate";
import { ROOTS } from "./growth";

export type Ground = {
  soil: Float32Array; // regolith depth, m: the drift and what has weathered from the rock under it
  silt: Float32Array; // 0..1 fine alluvium: floodplains of streams too slow to carry sand
  sand: Float32Array; // 0..1 beach sand
  peat: Float32Array; // peat depth, m
  sandy: Float32Array; // share of sand in the root zone, by mass
  clayey: Float32Array; // share of clay
  carbon: Float32Array; // organic carbon in the topsoil (0 to 23 cm), t a ha
  organic: Float32Array; // organic matter in the topsoil, % by mass
  nitrogen: Float32Array; // nitrogen its organic matter releases to roots, kg a ha a year
  ph: Float32Array; // topsoil pH (water)
  fertility: Float32Array; // 0..1 that nitrogen against what the year's growth there takes up
  moist: Float32Array; // 0..1 water available to roots through the growing season
  soilWater: Float32Array[]; // 0..1 how full the root zone is at the end of each season
  tree: Float32Array; shrub: Float32Array; grass: Float32Array; marsh: Float32Array; bare: Float32Array; // cover shares, with sand summing to 1
  field: Float32Array; // 0..1 the share of the ground where grass and herbs grow in shade: under the canopy and in its gaps
  fieldLight: Float32Array; // the share of the open sky's light that shaded field layer gets
};

export type Site = {
  height: Float32Array; open: Uint8Array; seasonTable: Float32Array[]; winterTable: Float32Array; dryTable: Float32Array; valley: Float32Array; channel: Uint8Array; power: Float32Array;
  driftDepth: Float32Array; drift: Uint8Array; rock: Uint8Array;
  precip: Float32Array; pet: Float32Array; temp: Float32Array; windShare: Float32Array; salt: Float32Array;
  seasons: Season[];
};

// ---------- soil depth ----------
// Soil grows from the rock under it at (rock density over soil density) W e^(-h / h*) a year and creep carries it off
// as fast as the ground's slope flux diverges, E (Heimsath et al., R590): h* 0.5 m; W, the rate at bare rock, the middle
// on a log scale of the 0.026 to 0.096 mm a year measured on UK sandstone (R591), for every rock as granite's is not known
// beyond being slower [gap]; the density ratio 2 [UNVERIFIED]. Creep runs at geology.ts CREEP and steepens toward the
// critical slope 1.25 (Roering et al.'s nonlinear flux, R592). The ice left the island 18 to 19 ka ago on the newer
// production rate (Anjar et al., R593): 18,500 years.
export const H_STAR = 0.5, W0 = Math.sqrt(0.026e-3 * 0.096e-3), DENSITY = 2, AGE = 18500;
export const SC = 1.25;

// ---------- peat ----------
// Peat grows where the water table stays within the acrotelm through the growing season (water.ts dryTable), 0.3 m, the
// top of the 0.25 to 0.30 m measured in Baltic raised bogs, and as Clymo's bog does: (p / a)(1 - e^(-a t)) of dry mass,
// p 50 g a m2 a year, a 1e-4 a year (R594), from the ice's going [design], at 0.1 g a cm3 [UNVERIFIED]. Blanket peat
// wants 1,000 mm of rain a year or more on 160 wet days or more (R595); the wet days are not known here, so it is left out
// [gap] (Bornholm's 550 to 650 mm fails it, the ground notes).
export const ACROTELM = 0.3, PEAT_P = 50, PEAT_A = 1e-4, PEAT_RHO = 100;

// ---------- beach sand ----------
// Storm waves run up 1.6 m above the still water: Stockdon's R2 (R604) for storm waves of 4 m (Arkona's storm maxima,
// R601) and 8 s on a 0.08 beach [derived; the period and beach slope UNVERIFIED]; storm surge [gap]. Sand lies on the
// shore below that where the coast is sediment rather than the crystalline basement, as Bornholm's sand shores are in
// the south-west and its granite shores in the north-east (R613) [design: the sand's supply].
export const RUNUP = 1.6;

// ---------- texture ----------
// What each drift is is geology.ts DRIFTS; beach sand is JB1 to 2 (R524), as meltwater sand. Floodplain alluvium is fine
// where the stream's bankfull power is under 10 W/m2 and sand and gravel above (Nanson and Croke, R562); the fine
// alluvium's texture is not known (0.2 sand, 0.3 clay stand in) [gap]. The root zone (growth.ts ROOTS) takes the drift's
// texture over as much of it as the drift fills and the rock's below [design]. Danish texture classes count silt from 2
// to 20 µm, Saxton and Rawls from 2 to 50, and the 20 to 50 µm share is not known: the Danish sand stands in [gap].
export const COHESIVE = 10, SILT_SAND = 0.2, SILT_CLAY = 0.3;

// ---------- pH ----------
// Topsoil pH by what the soil formed in, at the middle of each buffer range (Ulrich, R599; SLU, R600): carbonate 7.8 to
// 8.8, so 8.3; base-rich silicate (dolerite, mudstone, the Baltic clay till) the silicate range 5.0 to 6.2, so 5.6;
// base-poor sand, sandstone and granite in the exchanger range, 5.2 to 5.4 in mineral soil, so 5.3, and about 4 under the
// mor that pine and heather lay down (R600). Danish forest soils agree: about 5.0 to 5.5 in CaCl2 (some 0.5 above in
// water) on loamy till under beech, about 3 in the top of sandy soils under spruce and pine (R620). Peat here grows only
// where groundwater stands at the surface, a fen, so it takes the pH of the ground the water comes through [derived];
// whether a fen has grown up into a rain-fed bog, sourer, is a [gap].
export const CARBONATE = 8.3, SILICATE = 5.6, EXCHANGER = 5.3, MOR = 4;

// ---------- organic matter (RothC-26.3, R596) ----------
// Decomposition rates a year of the decomposable and resistant plant matter, the microbial biomass and humus; the share of
// each loss kept as biomass and humus by clay (x), split 46:54; the input's decomposable to resistant ratio, deciduous
// woodland 0.25 and unimproved grassland and scrub 0.67; inert matter 0.049 TOC^1.139; the topsoil 23 cm. Monthly in
// RothC, by the game's four seasons here [design].
export const K_DPM = 10, K_RPM = 0.3, K_BIO = 0.66, K_HUM = 0.02, TOPSOIL = 0.23, DPM_RPM = { tree: 0.25, open: 0.67 };
// The plants' carbon: dry matter at Monteith's 1.4 g a MJ the leaves intercept (growth.ts RUE), a stand intercepting what
// a closed canopy stops (growth.ts UNDER_CROWN) of the light it stands in, 0.47 of it carbon (IPCC, R617). Organic
// matter twice the carbon (Pribyl, R602).
export const CARBON = 0.47, OM_C = 2;
// The nitrogen it releases: what the biomass and humus give back as they turn over, at the microbial biomass's C:N, 60:7
// by atoms, and the soil's, 186:13 (Cleveland and Liptzin, R615), so 7.3 and 12.3 by mass [derived; the ground notes'
// rule, which leaves out what litter releases before it becomes biomass or humus, gap]; against what the year's growth
// takes up, at the 2.4% nitrogen of unfertilised Irish grass swards (185 kg of N in 7,682 kg of dry matter a ha, R616)
// [derived].
export const CN_BIO = (60 * 12) / (7 * 14), CN_HUM = (186 * 12) / (13 * 14), N_PLANT = 185 / 7682;

export const DAYS = 365.25 / 4;
// The grazed field layer: the sward and the herbs and flowers flora.ts lays under and between the woody plants.
export const FIELD = ["grass", "yarrow", "sorrel", "mint", "buttercup", "daisy", "clover", "harebell", "poppy"];
// The natural forest's gaps: 11.75% of its ground, the median of the gap fractions measured in primeval and old-growth
// beech forests, gaps whose regrowth stands under half to two thirds of the canopy (Drössler and von Lüpke 16 and 14.6%,
// Feldmann et al. 13.6 and 8.2%, Rugani et al. 3.9 and 9.9% over their periods; R635, R636, R637) [derived]; Drössler's
// 0.387 to 0.529% of the forest opened a year over the some 35 years a fallen canopy tree takes to rot gives 14 to 19%.
// Light in them, about 10% of the open sky's, as in the gaps of the Danish near-natural wood at Suserup (R633).
export const GAP = (9.9 + 13.6) / 2 / 100, GAP_LIGHT = 0.1;

// What the root zone holds for plants, mm: field capacity less wilting point by Saxton and Rawls (R597 eqs. 1, 2), sand
// and clay shares by mass, organic matter %, over the root zone or the soil if it is shallower (FAO-56 eq. 82, R221).
export function holds(soil: number, sand: number, clay: number, organic: number) {
  const om = Math.min(organic, 8);
  const wp = -0.024 * sand + 0.487 * clay + 0.006 * om + 0.005 * sand * om - 0.013 * clay * om + 0.068 * sand * clay + 0.031;
  const fc = -0.251 * sand + 0.195 * clay + 0.011 * om + 0.006 * sand * om - 0.027 * clay * om + 0.452 * sand * clay + 0.299;
  const theta1500 = wp + 0.14 * wp - 0.02, theta33 = fc + 1.283 * fc * fc - 0.374 * fc - 0.015;
  return 1000 * Math.max(0, theta33 - theta1500) * Math.min(soil, ROOTS);
}

// The label a patch of ground goes by, as an index into flora.ts GROUND, from its cover shares in COVER's order: the
// largest share (no weights, P39). Ground past the critical slope (R592) is bare rock, and so is bare ground with less
// than 25 cm of soil over the rock, a Leptosol (R618); grass or scrub on such soil is grass with outcrops. The map, the
// inspector and the game's tiles all read this one rule.
export const COVER = ["grass", "tree", "shrub", "marsh", "bare", "sand"] as const;
export const LEPTOSOL = 0.25, OUTCROPS = 6, BARE_ROCK = 7;
export function coverClass(share: ArrayLike<number>, soil: number, slope: number) {
  let best = 0;
  for (let k = 1; k < COVER.length; k++) if (share[k] > share[best]) best = k;
  if (slope >= SC) return BARE_ROCK;
  if (soil >= LEPTOSOL) return best;
  return best === 4 ? BARE_ROCK : best === 0 || best === 2 ? OUTCROPS : best;
}
