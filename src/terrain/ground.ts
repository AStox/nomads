// What the ground is made of and what grows on it, from the physics of each spot: how its soil formed since the ice
// left, how wet it stays, how sour it is, what its organic matter feeds, and which plants keep themselves there and
// shade out the rest. There are no biomes here, only plants that cope or don't; forest, heath, meadow and bog are where
// they win. Every number is in docs/research/terrain-constants.md secs. 12 and 13.
import { clamp } from "math";
import { CELL, LEN, N, distance } from "./grid";
import { DRIFTS, LIMESTONE, MUDSTONE, DOLERITE, MELTWATER, PEAT, ROCKS, TILL_CLAY, CREEP, crystalline } from "./geology";
import type { Season } from "./climate";
import { ROOTS, RUE, SLA, UNDER_CROWN, closes, pOf, warmEnough, watered, yearComp } from "./growth";
import { NICHE, SHRUBS, TREES, fit, type Env } from "./niche";

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
// Bulk density of the soil, g/cm3, by Saxton and Rawls (R597 eqs. 3, 5, 6).
function density(sand: number, clay: number, organic: number) {
  const om = Math.min(organic, 8);
  const fc = -0.251 * sand + 0.195 * clay + 0.011 * om + 0.006 * sand * om - 0.027 * clay * om + 0.452 * sand * clay + 0.299;
  const s33t = 0.278 * sand + 0.034 * clay + 0.022 * om - 0.018 * sand * om - 0.027 * clay * om - 0.584 * sand * clay + 0.078;
  const sat = fc + 1.283 * fc * fc - 0.374 * fc - 0.015 + s33t + 0.636 * s33t - 0.107 - 0.097 * sand + 0.043;
  return (1 - sat) * 2.65;
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

export function ground(s: Site): Ground {
  const h = s.height;
  const soil = new Float32Array(LEN), silt = new Float32Array(LEN), sand = new Float32Array(LEN), peat = new Float32Array(LEN), moist = new Float32Array(LEN);
  const soilWater = [0, 1, 2, 3].map(() => new Float32Array(LEN));
  const sandy = new Float32Array(LEN), clayey = new Float32Array(LEN), carbon = new Float32Array(LEN), organic = new Float32Array(LEN), nitrogen = new Float32Array(LEN);
  const ph = new Float32Array(LEN), fertility = new Float32Array(LEN);
  const tree = new Float32Array(LEN), shrub = new Float32Array(LEN), grass = new Float32Array(LEN), marsh = new Float32Array(LEN), bare = new Float32Array(LEN), field = new Float32Array(LEN), fieldLight = new Float32Array(LEN);

  // How fast creep lowers each cell, m a year: the divergence of the slope flux D S / (1 - (S / Sc)^2) across its four
  // faces, with the sea level as the ground's floor at the coast.
  const z = (i: number) => Math.max(0, h[i]);
  const flux = (a: number, b: number) => { const S = (z(b) - z(a)) / CELL, r = Math.min(0.99, Math.abs(S) / SC); return (-CREEP * S) / (1 - r * r); };
  const lowers = new Float32Array(LEN);
  for (let i = 0; i < LEN; i++) {
    const x = i % N, y = (i - x) / N;
    let out = 0;
    if (x < N - 1) out += flux(i, i + 1); if (x > 0) out += flux(i, i - 1);
    if (y < N - 1) out += flux(i, i + N); if (y > 0) out += flux(i, i - N);
    lowers[i] = out / CELL;
  }
  // Where the sea lies, for the beaches, and the power of the stream nearest each cell, for its floodplain's alluvium:
  // carried out from the channels in two sweeps, as grid.ts distance carries distance.
  const sea = new Uint8Array(LEN);
  for (let i = 0; i < LEN; i++) sea[i] = s.open[i] && h[i] < 0 ? 1 : 0;
  const toSea = distance(sea);
  const near = new Float32Array(LEN).fill(Infinity), reach = new Float32Array(LEN).fill(Infinity);
  for (let i = 0; i < LEN; i++) if (s.channel[i]) { near[i] = s.power[i]; reach[i] = 0; }
  for (const [from, to, step] of [[0, LEN, 1], [LEN - 1, -1, -1]]) {
    for (let i = from; i !== to; i += step) {
      const x = i % N, y = (i - x) / N;
      for (const j of [x > 0 ? i - 1 : -1, x < N - 1 ? i + 1 : -1, y > 0 ? i - N : -1, y < N - 1 ? i + N : -1])
        if (j >= 0 && reach[j] + 1 < reach[i]) { reach[i] = reach[j] + 1; near[i] = near[j]; }
    }
  }

  const sun = new Float32Array(4), temp = new Float32Array(4), water = new Float32Array(4);
  const a0 = DENSITY * W0;
  for (let i = 0; i < LEN; i++) {
    if (s.open[i]) { bare[i] = 1; for (const sw of soilWater) sw[i] = 1; continue; }
    const d0 = s.driftDepth[i], E = lowers[i], R = ROCKS[s.rock[i]], kind = s.drift[i];
    // The soil since the ice: dh/dt = a0 e^(-h/h*) - E integrates in u = e^(h/h*), which follows du/dt = (a0 - E u) / h*,
    // from the drift the ice left. Where creep takes more than the rock can make, the soil wears down to bare rock.
    const u0 = Math.exp(d0 / H_STAR);
    const u = Math.abs(E) < 1e-12 ? u0 + (a0 * AGE) / H_STAR : a0 / E + (u0 - a0 / E) * Math.exp((-E * AGE) / H_STAR);
    soil[i] = u > 1 ? H_STAR * Math.log(u) : 0;
    // Beach sand on sediment coasts, below the storm waves' reach.
    sand[i] = toSea[i] <= CELL && h[i] <= RUNUP && !crystalline(s.rock[i]) ? 1 : 0;
    // Fine alluvium on floodplains whose stream is too weak to carry sand.
    const flood = s.valley[i] > 0 && near[i] < Infinity;
    silt[i] = flood && near[i] < COHESIVE ? 1 : 0;
    // Peat where the water table stays in the acrotelm the year round: its deepest within 0.3 m.
    const wet = s.dryTable[i] <= ACROTELM;
    peat[i] = wet && !sand[i] ? (PEAT_P / PEAT_A) * (1 - Math.exp(-PEAT_A * AGE)) / 1000 / PEAT_RHO : 0;
    // Texture: beach sand, alluvium, or the drift over the rock in the root zone.
    const inDrift = Math.min(1, d0 / ROOTS), D = DRIFTS[kind];
    let sa = D.sand * inDrift + R.sand * (1 - inDrift), cl = D.clay * inDrift + R.clay * (1 - inDrift);
    if (flood) { const fine = silt[i]; sa = fine ? SILT_SAND : DRIFTS[MELTWATER].sand; cl = fine ? SILT_CLAY : DRIFTS[MELTWATER].clay; }
    if (sand[i]) { sa = DRIFTS[MELTWATER].sand; cl = DRIFTS[MELTWATER].clay; }
    sandy[i] = sa; clayey[i] = cl;
    // pH of the mineral soil by what it formed in: the drift where it fills most of the root zone, else the rock (and the
    // rock under a fen's peat).
    const parent = inDrift >= 0.5 && kind !== PEAT ? kind : -1;
    const carbonate = parent < 0 && s.rock[i] === LIMESTONE;
    const rich = flood || parent === TILL_CLAY || (parent < 0 && (s.rock[i] === MUDSTONE || s.rock[i] === DOLERITE));
    const mineral = carbonate ? CARBONATE : rich ? SILICATE : EXCHANGER;
    ph[i] = mineral;
    // The niches read the winter table, the one the forestry site classification's moisture regimes are defined on.
    const env: Env = { ph: mineral, table: s.winterTable[i], light: NaN, wind: s.windShare[i], salt: s.salt[i], soil: soil[i] };
    for (let k = 0; k < 4; k++) { sun[k] = s.seasons[k].sun[i]; temp[k] = s.seasons[k].temp[i]; }

    // Two passes [design]: the cover's organic matter changes what the soil holds, and so the cover.
    let om = 0, veg = 0, npp = 0, morShare = 0, wTree = 0, wOpen = 0;
    for (let pass = 0; pass < 2; pass++) {
      // A soil bucket through the seasons: spring rain tops it up and summer drinks it down; two years for it to settle.
      // Roots that reach the season's water table don't go short that season, and it fills the root zone back up from
      // below (FAO-56's root zone, R221; the capillary fringe above it [gap]).
      const cap = holds(soil[i], sa, cl, om);
      let store = cap, short = 0, want = 0;
      for (let year = 0; year < 2; year++)
        for (let k = 0; k < 4; k++) {
          const { precip, pet } = s.seasons[k], fed = s.seasonTable[k][i] <= ROOTS, have = store + precip[i], used = fed ? pet[i] : Math.min(pet[i], have);
          store = fed ? cap : Math.min(cap, have - used);
          if (year) { short += pet[i] - used; want += pet[i]; water[k] = cap > 0 ? store / cap : fed ? 1 : 0; }
        }
      moist[i] = want > 0 ? 1 - short / want : 1;
      // Each form's best kind: the one that keeps itself on the least of the open sky's sun over the year (growth.ts),
      // as the ground suits it (niche.ts). Where trees keep themselves they close a canopy (growth.ts closes), but for the
      // gaps their fallen trees leave; under the canopy and in its gaps only what keeps itself on the light there grows,
      // in the gaps the young trees first. On the open ground the taller forms take the light first, each lower one in
      // what the higher leave. Grass and herbs in shade are the field layer, which only the herds see; the sward is the
      // open ground's. Nothing grows on the beach sand.
      const best = (names: readonly string[]) => {
        let comp = Infinity, name = names[0];
        for (const n of names) { const c = yearComp(SLA[n], sun, temp, water, fit(n, env), pOf(n)); if (c < comp) { comp = c; name = n; } }
        return { comp, name };
      };
      const T = best(TREES), Sh = best(SHRUBS), Re = best(["reeds"]), G = best(["grass"]), F = best(FIELD);
      const ground = 1 - sand[i], forest = ground * closes(T.comp), canopy = forest * (1 - GAP), gap = forest * GAP;
      const young = gap * closes(T.comp / GAP_LIGHT);
      tree[i] = canopy + young;
      // shrubs and reeds take the open ground and the gaps' floor by height, then the sward the open ground
      const [hi, lo] = (NICHE[Sh.name].tall ?? 0) >= (NICHE.reeds.tall ?? 0) ? [Sh, Re] : [Re, Sh];
      const layers = (room: number, light: number) => { const a = room * closes(hi.comp / light), b = (room - a) * closes(lo.comp / light); return hi === Sh ? [a, b] : [b, a]; };
      const [oSh, oRe] = layers(ground - forest, 1), [gSh, gRe] = layers(gap - young, GAP_LIGHT);
      shrub[i] = oSh + gSh; marsh[i] = oRe + gRe;
      grass[i] = (ground - forest - oSh - oRe) * closes(G.comp);
      const fieldGap = (gap - young - gSh - gRe) * closes(F.comp / GAP_LIGHT), fieldUnder = canopy * closes(F.comp / UNDER_CROWN);
      field[i] = fieldGap + fieldUnder;
      fieldLight[i] = field[i] > 0 ? (fieldGap * GAP_LIGHT + fieldUnder * UNDER_CROWN) / field[i] : 0;
      bare[i] = Math.max(0, 1 - tree[i] - shrub[i] - marsh[i] - grass[i] - sand[i]);
      veg = tree[i] + shrub[i] + marsh[i] + grass[i];
      morShare = (T.name === "pine" ? tree[i] : 0) + (Sh.name === "heather" ? shrub[i] : 0);
      wTree = tree[i]; wOpen = veg - tree[i];
      // Nitrogen: the biomass and humus turning over pass e / (1 - e) of the plants' input through them at steady state
      // (x, e by clay below), against what growth takes up of that input's dry matter; the input cancels, so fertility
      // is the ground's own, even where nothing grows yet.
      const clay = cl * 100, x = 1.67 * (1.85 + 1.6 * Math.exp(-0.0786 * clay)), e = 1 / (1 + x);
      const turnover = (e / (1 - e)) * (0.46 / CN_BIO + 0.54 / CN_HUM);
      fertility[i] = clamp((turnover * CARBON) / N_PLANT, 0, 1);
      // The year's carbon from the plants, t a ha: each form's at its own drought tolerance in the light it stands in,
      // what it stops of that light being what a closed canopy stops, as far as that nitrogen lets it grow (as herds.ts
      // grows its grass) [derived].
      npp = 0;
      for (const [share, light, name] of [[tree[i], 1, T.name], [oSh, 1, Sh.name], [oRe, 1, "reeds"], [grass[i], 1, "grass"], [gSh, GAP_LIGHT, Sh.name], [gRe, GAP_LIGHT, "reeds"], [field[i], fieldLight[i], F.name]] as const) {
        if (share <= 0) continue;
        let dm = 0;
        for (let k = 0; k < 4; k++) dm += DAYS * RUE * sun[k] * warmEnough(temp[k]) * watered(water[k], pOf(name));
        npp += share * light * (1 - UNDER_CROWN) * dm;
      }
      npp *= (CARBON / 100) * fertility[i];
      nitrogen[i] = 1000 * npp * turnover;
      // RothC's steady state. Decomposition answers to warmth (a), the topsoil's dryness (b, its deficit reaching the
      // most a soil of this clay holds back, 20 + 1.3 clay% - 0.01 clay%^2 mm over 23 cm, then slowing) and cover (c,
      // 0.6 under plants, 1 bare).
      const most = -(20 + 1.3 * clay - 0.01 * clay * clay);
      let deficit = 0, m = 0;
      for (let year = 0; year < 2; year++)
        for (let k = 0; k < 4; k++) {
          const { precip, pet } = s.seasons[k];
          deficit = clamp(deficit + precip[i] - pet[i], most, 0);
          if (!year) continue;
          const warmth = 47.91 / (1 + Math.exp(106.06 / (temp[k] + 18.27)));
          const b = deficit > 0.444 * most ? 1 : 0.2 + (0.8 * (most - deficit)) / (most - 0.444 * most);
          m += (warmth * b * (0.6 * veg + (1 - veg))) / 4;
        }
      const ratio = veg > 0 ? (wTree * DPM_RPM.tree + wOpen * DPM_RPM.open) / veg : DPM_RPM.open, f = ratio / (1 + ratio);
      // Peat is all organic, its top 23 cm at the bog's density [design]; RothC is not for waterlogged ground (R596).
      if (peat[i] > 0) { carbon[i] = (PEAT_RHO * Math.min(TOPSOIL, peat[i]) * 10 * CARBON); om = 100; continue; }
      const active = m > 0 ? npp * (f / (K_DPM * m) + (1 - f) / (K_RPM * m) + (e / (1 - e)) * (0.46 / K_BIO + 0.54 / K_HUM) / m) : 0;
      let toc = active;
      for (let n = 0; n < 20; n++) toc = active + 0.049 * toc ** 1.139;
      carbon[i] = toc;
      // Organic matter as a share of the topsoil's mass, its density by Saxton and Rawls (settled in a few steps).
      const depth = Math.min(TOPSOIL, soil[i]);
      for (let n = 0; n < 4; n++) om = depth > 0 ? Math.min(100, (100 * OM_C * toc) / (density(sa, cl, om) * depth * 1e4)) : 0;
    }
    organic[i] = om;
    for (let k = 0; k < 4; k++) soilWater[k][i] = water[k];
    // The mor pine and heather lay down sours base-poor ground.
    if (mineral === EXCHANGER && veg > 0) ph[i] = mineral + (MOR - mineral) * (morShare / veg);
  }
  return { soil, silt, sand, peat, sandy, clayey, carbon, organic, nitrogen, ph, fertility, moist, soilWater, tree, shrub, grass, marsh, bare, field, fieldLight };
}
