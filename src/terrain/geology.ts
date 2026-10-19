// The island's bedrock and the glacial drift over it, and what each is like, in measured units where there are any
// (docs/research/terrain-constants.md sec. 1). The island stands for Bornholm: a horst of granite and gneiss, cut by
// dolerite dykes, dipping south under Palaeozoic and Mesozoic sandstone, shale and limestone, the whole overridden by
// the last ice sheet, which left a thin till over most of it. Soil, groundwater, springs, erosion and what can be found
// lying about all answer to these properties, never to the rock's name.
export type Rock = {
  name: string;
  ksat: number; // saturated hydraulic conductivity of the rock mass, m/s (R521, R522)
  thick: number; // thickness of it that carries groundwater, m (R522)
  cap: number; // the most recharge it takes as an aquifer, mm a year: GSI caps poor aquifers at 100 (R569); none on the rest
  erode: number; // stream-power erodibility, 1/yr for drainage area in m2 and m = 0.5, n = 1 (R523)
  base: number; // 0..1 the bases it weathers to, which keep a soil sweet against the rain's leaching [gap]: ranking only (R529)
  sand: number; // share of sand (20 to 2000 µm) in what it weathers to, by mass (R524)
  clay: number; // share of clay in it
  phos: number; // phosphorus in the rock, ppm (R525)
  feed: number; // 0..1 the mineral nourishment it releases to roots: its phosphorus against mudstone's [derived]
  pyrite: number; // 0..1 how often a stone of it holds a nodule of pyrite, which flint shaves into sparks: ranking (R526), values [gap]
};

// The middle of a range on a log scale, for a rate whose source gives only its bounds.
const mid = (lo: number, hi: number) => Math.sqrt(lo * hi);
// Mudstone's phosphorus, which every rock's nourishment is measured against.
const MUD_P = 1135;
const rock = (r: Omit<Rock, "feed">): Rock => ({ ...r, feed: Math.min(1, r.phos / MUD_P) });
// GSI's aquifer classes for the rocks [INFERENCE]: the fractured basement and the mudstone poor (Pl, Pu), the sandstone and
// limestone that Bornholm's wells draw on productive.
export const ROCKS: Rock[] = [
  // Alum Shale, the graptolite shales and the Mesozoic clays: the rock that wears away fastest and holds the most pyrite
  rock({ name: "mudstone", ksat: 1.4e-7, thick: 100, cap: 100, erode: mid(2e-5, 2.5e-3), base: 0.5, sand: 0.625, clay: 0.2, phos: 1135, pyrite: 0.4 }),
  // Nexø and Hardeberga sandstone, the Mesozoic sands and greensands
  rock({ name: "sandstone", ksat: 1.5e-5, thick: 100, cap: Infinity, erode: mid(1e-8, 1e-5), base: 0.15, sand: 0.825, clay: 0.05, phos: 500, pyrite: 0.05 }),
  // Komstad and Arnager limestone; its erodibility, texture and phosphorus are gaps (sandstone's stand in)
  rock({ name: "limestone", ksat: 1e-4, thick: 20, cap: Infinity, erode: mid(1e-8, 1e-5), base: 1, sand: 0.05, clay: 0.25, phos: 500, pyrite: 0.3 }),
  // Bornholm gneiss and the granites, weathering to grus
  rock({ name: "granite", ksat: 2.6e-7, thick: 100, cap: 100, erode: mid(2e-8, 2.5e-7), base: 0.1, sand: 0.825, clay: 0.05, phos: 436, pyrite: 0.03 }),
  // the dykes: part of the fractured basement aquifer, cut as the granite is; texture and phosphorus are gaps
  rock({ name: "dolerite", ksat: 2.6e-7, thick: 100, cap: 100, erode: mid(2e-8, 2.5e-7), base: 0.75, sand: 0.15, clay: 0.45, phos: 1000, pyrite: 0.05 }),
];
export const MUDSTONE = 0, SANDSTONE = 1, LIMESTONE = 2, GRANITE = 3, DOLERITE = 4;
// The crystalline basement, which the ice scoured along its joints and the sea drops away from steeply.
export const crystalline = (r: number) => r === GRANITE || r === DOLERITE;

// Hillslope creep's diffusivity, m2/yr: one for the whole island, as it answers to climate and the burrowing of life
// more than to the rock (R527).
export const CREEP = mid(4.4e-4, 3.6e-2);

// The threshold angle each rock's hillslopes stand at where rivers cut faster than creep can follow, degrees: landsliding
// then keeps the slopes there, and a faster incision brings more landslides, not steeper slopes (Burbank et al. 1996, as
// Montgomery 2001 and Binnie et al. 2007 give it). Granitic basins at the threshold average 36 degrees (30.7 to 38.0;
// Binnie et al. 2007, San Bernardino Mountains, 10 m DEM), taken for the crystalline rocks; the Olympic Mountains' core,
// sandstone and mudstone [INFERENCE: the lithology], holds 28 to 32 degrees whatever its erodibility (Montgomery 2001), the
// middle taken for sandstone; mudstone and limestone take sandstone's [gap] (R1714). The island's relief never reaches them; a
// window's does (gpu/globe/window.ts).
export const THRESHOLD_DEG = [30, 30, 30, 36, 36];

// What lies on the bedrock: what the ice and its meltwater left, or nothing where it scraped the rock bare. Till is
// clayey over the soft sediments and sandy over the basement; meltwater sand fills the joint valleys; peat stands for
// whatever 11d grows in the wet hollows (a placeholder until it does). The sim reads flint here: the island's own
// limestones hold none (R528), so a flint is a clast the ice brought.
export type Drift = {
  name: string;
  sand: number; // share of sand in it, by mass (R524, R529)
  clay: number; // share of clay
  ksat: number; // saturated hydraulic conductivity, m/s, as it lies near the surface (R521, R567, R568)
  // the share of the surplus rain that reaches the aquifer through it where it lies under 3 m, 3 to 5 m and over 5 m
  // thick: GSI's recharge coefficients (R569) for its permeability class (R570), the rest running off and through the
  // soil to the streams
  recharge: [number, number, number];
  flint: number; // 0..1 how often a boulder lying in it holds flint [gap]: no clast count for Bornholm's till was found
};
export const BARE = 0, TILL_CLAY = 1, TILL_SAND = 2, MELTWATER = 3, PEAT = 4;
const FLINT = 0.25;
export const DRIFTS: Drift[] = [
  // rock at the surface: 85%
  { name: "bare rock", sand: 0, clay: 0, ksat: 0, recharge: [0.85, 0.85, 0.85], flint: 0 },
  // the fractured, burrowed top 4 m of a Danish clay till, measured in the field (R567); the unbroken till's 1e-12 to
  // 1e-6 (R521) is the matrix between the cracks. A low-permeability subsoil (R570): under 3 m till under a gley, 22%;
  // 3 to 5 m, 25%; 5 to 10 m, 15%
  { name: "clay till", sand: 0.625, clay: 0.25, ksat: 8e-6, recharge: [0.22, 0.25, 0.15], flint: FLINT },
  // silty sand's 1e-7 to 1e-3, the middle on a log scale (R521) [derived: the texture of a sandy till]. A moderate
  // permeability subsoil, free draining (R570): 60% at every thickness
  { name: "sandy till", sand: 0.725, clay: 0.125, ksat: mid(1e-7, 1e-3), recharge: [0.6, 0.6, 0.6], flint: FLINT },
  // clean sand's 1e-6 to 1e-2, the middle on a log scale (R521) [derived]. Sand and gravel under a well drained soil: 85%
  { name: "meltwater sand", sand: 0.875, clay: 0.025, ksat: mid(1e-6, 1e-2), recharge: [0.85, 0.85, 0.85], flint: FLINT },
  // undrained and lightly degraded peat, 1 to over 100 cm an hour (R568), from 1 to 100 cm an hour, the middle on a log
  // scale [derived]. Fen peat 4%, peat 3 to 5 m deep 10%
  { name: "peat", sand: 0, clay: 0, ksat: mid(1, 100) / 360_000, recharge: [0.04, 0.1, 0.04], flint: FLINT },
];
// The till's greatest thickness on the basement, m (R530).
export const TILL_MAX = 6;
