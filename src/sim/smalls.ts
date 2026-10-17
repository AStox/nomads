// The smallest things (the GPU plan's Unit 12b; research note docs/research/generator/2026-10-16-lumped.md; constants
// in docs/research/plant-constants.md sec. 14 and animal-constants.md sec. 14): grass tillers and reed shoots, fine
// litter, invertebrates and soil fauna, and moved sand, each a lumped kind on the GPU (src/gpu/smalls.ts, its laws
// src/gpu/wgsl/smalls.ts). This file holds the laws' constants, the tables they read, each cell's static words, the
// day's drivers, the island's first members, and the laws' TypeScript twins, which give the same splits bit for bit.
import { DAY, YEAR_DAYS, groundOf, Tile, tileAt, type World } from "./world";
import { onDay, seasonAt } from "./sky";
import { INTERCEPT_SNOW, SNOW_DOY, SNOW_REACH, snowDepth } from "./air";
import { CELL, N } from "../terrain/grid";
import { RUE, warmEnough, watered } from "../terrain/growth";
import { divw, mul64, mulhi, qdiv, qexp, qln, qmul } from "../gpu/fixed";
import { DEATH, FATE, type Split } from "../gpu/tiers/lumped";
import type { SmallsDriver } from "../gpu/smalls";
import {
  ATTACHED, BASE, CELLS, CELL_M2, CW, DAYW, FALL, FALL_CLASSES, FT, FT_STRIDE, F_, LC, LT, LT_N, LT_STRIDE, PRED, SPC, STATIC_WORDS, TS, X,
  faunaState, litterState, tillerState, type SmallsConsts, type Win,
} from "../gpu/wgsl/smalls";

const Q16 = (x: number) => Math.round(x * 65536);
const Q32 = (p: number) => (p >= 1 ? 0xffffffff : Math.max(0, Math.round(p * 2 ** 32)) >>> 0);
// Real days of the island's biology in an island day (plants.ts YEARS_PACE).
export const PACE = 365.25 / YEAR_DAYS;
// A real day of the year (1 January = 0) as the island day whose middle it falls in, and an island day's middle as a
// real day of the year: the spring equinox, 20 March, is day 79 (sky.ts onDay).
const EQUINOX = 79;
const realOf = (d: number) => (((EQUINOX + (d + 0.5 - YEAR_DAYS / 8) * PACE) % 365.25) + 365.25) % 365.25;
const dayOfReal = (doy: number) => ((Math.floor(onDay(doy - EQUINOX)) % YEAR_DAYS) + YEAR_DAYS) % YEAR_DAYS;
// The island days whose middles fall in a window of real days of the year [from, to), as [first, last + 1).
function win(from: number, to: number): Win {
  const inside = (r: number) => (from <= to ? r >= from && r < to : r >= from || r < to);
  const days = Array.from({ length: YEAR_DAYS }, (_, d) => inside(realOf(d)));
  let first = days.findIndex((x, d) => x && !days[(d + YEAR_DAYS - 1) % YEAR_DAYS]);
  if (first < 0) first = days.indexOf(true);
  if (first < 0) { const d = dayOfReal(from); return [d, (d + 1) % YEAR_DAYS]; }
  let last = first;
  while (days[(last + 1) % YEAR_DAYS] && (last + 1) % YEAR_DAYS !== first) last = (last + 1) % YEAR_DAYS;
  return [first, (last + 1) % YEAR_DAYS];
}
const inWin = (d: number, w: Win) => (w[0] <= w[1] ? d >= w[0] && d < w[1] : d >= w[0] || d < w[1]);
// Real days of the year of the first of each month.
const MONTH = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334, 365];
const doy = (month: number, day = 1) => MONTH[month - 1] + day - 1;

// ---------- grass tillers (R950 to R958, R997, R998) ----------
// Daughters a vegetative tiller a real day: kN Fs LA (van Loo and Lantinga, R950 eqns 2a to 2g). kN 0.25 for the
// never-fertilised island, so summer births match the unfertilised Baltic Festuca rubra meadow at Tullgarn (R955 Table
// 3) [INFERENCE]. Leaf appearance 0.14 a day times (T - c) / (d - c) clamped to [0, 1], c, d = 0, 16 C from 1 March to
// 10 June and 10, 18 C from 10 June to 1 March (R950 eqn 2d). Site filling 0.867 - 0.183 LAI, in the week after a bite
// 0.335 - 0.067 LAI, each clamped to [0, ln 2] (R950 eqn 2c). A tiller bitten at an even moment of the day has the
// first week's site filling for up to 7 of the island day's 9.13 real days, on average 0.473 of it [derived].
const KN = 0.25, LA_MAX = 0.14, FS = [0.867, 0.183, Math.LN2] as const, FSB = [0.335, 0.067] as const, BITTEN_WEEK = 0.473;
// Deaths a vegetative tiller a real day: 0.003 May to October and 0.0015 November to April [INFERENCE on R955 and R954],
// plus shading deaths 0.09 (LAI - 6) / 4 above a leaf area index of 6 (R950 eqns 2e, 2f).
const MU_SUMMER = 0.003, MU_WINTER = 0.0015, SHADE = 0.09 / 4, SHADE_FROM = 6;
// Lamina classes: 0.25 mg times 2^k of lamina above the grazing height, k 1 to 7, and none in class 0 [design: the top
// class, 32 mg, from R951's lax sward on the -3/2 line, 5,000 tillers a m2 at a leaf area index of 4 and the sward's
// specific leaf area, 4 / (0.02639 x 5,000) = 30 mg]. Class 0 is a tiller grazed to its sheaths, or a daughter whose
// first leaf has only its tip out of the sheath it emerges from (R997 scored a leaf and a tiller at that tip)
// [INFERENCE: no lamina above the grazing height].
// A bite takes half a tiller's lamina above the grazing height (R953: "relatively constant and averages 50%") and
// leaves its sheaths and meristems: a vegetative tiller, its apex low in the sheath tube, lives and regrows the leaf,
// and an elongating tiller loses its apex with the bite and dies (R950 eqn 4c; R953: apex decapitation rises with the
// apex's height in reproductive tillers). Bites kill nothing else; deaths are R950's and R955's rates below.
// A tiller's lamina grows as its intercalary meristems extend leaves. A leaf's length is its elongation rate over its
// appearance rate (R953: LL = LER / LAR, the elongation lasting in proportion to the appearance interval), so the
// lamina a tiller extends a day is a full leaf's times the leaves it makes a day [derived]: leaves appear one each 94.3
// degree-days over 0 C (ryegrass's phyllochron, R997), and a full leaf is the top class over the three live leaves a
// tiller keeps (R950 eqn 1c; R953: the live leaves are the appearance rate times the leaf's life), 32 / 3 mg [derived].
// Where the layer's growth (the forage rule's, below) shared over its tillers is less, each grows that share: a tiller
// grazed to its sheaths regrows on the reserves there and then on what its new leaf makes (R953; R1100: reserves
// carry a defoliated ryegrass's leaf growth for about its first 3 days), carried here as the cell's growth
// shared by tiller, whatever each holds [INFERENCE]. Its lamina senesces meanwhile at s of itself a day (460
// degree-days over 4 C, R392, the forage rule's): over an island day m0 exp(-s) + R (1 - exp(-s)) / s from m0, R the
// day's growth, at most the top class (carbon past it is lost) [derived]. It ends the day in the class below that
// lamina or the one above, with the chance that keeps the expected lamina [derived].
export const LAMINA_MG = 0.25, SLA_GRASS = 26.39, BITE_SHARE = 0.5, PHYLLOCHRON = 94.3, LIVE_LEAVES = 3;
export const lamina = (k: number) => (k > 0 ? LAMINA_MG * 2 ** k : 0);
// The forage rule's growth (animal-constants sec. 3): 1.4 g a MJ of the season's sun (R362 via growth.ts RUE), the
// sward intercepting 0.8 [UNVERIFIED], warm, watered and as fertile as the ground; leaves living 460 degree-days over 4
// C (R392).
const INTERCEPT = 0.8, LEAF_DD = 460, LEAF_BASE = 4;
// The field layer's leaf area under the canopy counts as the crowns' leaf area over it, -ln(light) / 0.8, 0.8 the
// extinction plant-constants sec. 4 gives crowns [INFERENCE: one law for sun and shade, note sec. 1.2].
const EXTINCTION = 0.8;
// The calendar (R950 eqns 2b, 2g): every vegetative tiller alive on 1 March is vernalised; vernalised tillers elongate
// between 8 May and 10 June; elongating ones flower by the end of June and die once they have seeded, through July
// [design: R950 says only that a flowering tiller dies after seeding].
// The swards the island starts with: open sward at R951's lax anchor, 5,000 tillers a m2 of 32 mg lamina (a leaf area
// index of 4.2, the law's own equilibrium), and the shaded field layer at 3,000 of 16 mg (note sec. 1.4, 42 g/m2 of
// lamina where shade stops births) [design: the generator lays no tillers].
const START_OPEN = 5000, START_FIELD = 3000;

// ---------- reed (R959; Granéli 1989, Hara et al. 1993) ----------
// One cohort a year, coming up from late March to May (real days 80 to 140) at 600 shoots a m2 where no standing litter
// lies and 300 under it (Granéli 1989); surplus shoots die by the end of June toward 125 a m2 (100 to 150); frost under
// -6 C kills emerging shoots; live shoots go dead October to December; dead culms break at 1 / (2.5 x 365) a day (dead
// stems stand 2 to 3 years, Haslam via MarLIN) [INFERENCE from the note's sources]. A shoot keeps about 15 leaves
// [INFERENCE: 260 g/m2 of leaf over 100 shoots at 0.17 g a leaf]. The island starts with 300 dead culms a m2 of marsh,
// a third each of one, two and three winters standing, and 100 live shoots in their summer.
const REED_EMERGE = 600, REED_UNDER = 300, REED_FINAL = 125, REED_FROST = -6, REED_STAND_DAYS = 2.5 * 365, REED_LEAVES = 15;

// ---------- litter (R960 to R967) ----------
// Foliar litterfall, g/m2 a year under a closed stand: Scots pine 200 [INFERENCE between R960's north European 177 and
// central 234]; oak, ash and aspen 280 (R960 central broadleaves 296, R962 mixed 278.7). The crowns' broadleaves split
// by the island's area of oak, ash and aspen (seed 1's stems, note sec. 0: 39.1, 16.4, 42.1 km2) [derived, crude].
// Piece masses: oak 0.143 g, ash leaflet 0.092 g (R967 Table 2); aspen [gap: hazel's 0.096 g, R967]; Scots pine needle
// 15 mg [UNVERIFIED]; reed leaf 0.17 g [INFERENCE note sec. 2.3]; a grass blade 4 mg [design: the lamina of a mid-class
// tiller; blade mass a gap]; a fallen reed stem 7.4 g [derived: 10 g a shoot, 74% of it stem, R959].
const FOLIAR = { pine: 200, broad: 280 }, BROAD_SPLIT = { oak: 39.1, ash: 16.4, aspen: 42.1 };
const PIECE_MG: Record<number, number> = { [LC.pine]: 15, [LC.oak]: 143, [LC.ash]: 92, [LC.aspen]: 96, [LC.standing]: 4, [LC.lying]: 4, [LC.reedLeaf]: 170, [LC.reedStem]: 7400 };
// Decay: a piece of class c in mass class j weighs m_c 0.8^j and moves to j + 1 at 5 k_j a year, so a pool's mass
// follows Olson's exp(-k t) (R961) [derived]. Pine k by stage 0.359, 0.30, 0.24, 0.171 a year [INFERENCE between R963's
// classes A and D], leaving to humus after 7 classes (1 - 0.8^7 = 79.0% lost against Berg's 80.8%, R963, and 78%,
// R964); oak 0.226 (R961, first year), leaving after 5 (67.2% against R964's 64% for deciduous litter); aspen [gap: oak's
// rate and limit]; ash 1.98 (R961); grass blades lying 0.9 [INFERENCE on R961's slow herbs]; standing dead blades the
// forage rule's 0.4% a day (R395) and falling at 1 a year [design]; reed leaves 1.28 (R965); reed stems 0.95 after a lag
// left at 2 a year (R966) [INFERENCE: a mean lag of half a year]. Ash, grass and reed have no limit value: the last class
// goes at k. Half-year multipliers, November to April and May to October: ash 0.57 and 1.43, oak 1.17 and 0.83 (R961)
// [derived]. Macrofauna take whole oak, ash and aspen pieces at 0.87 a year on base-rich soil (R962's 66.5% in a year)
// [INFERENCE: tuned by the litter pass], none on base-poor.
type Decay = { k: number[]; limit: number; mult: [number, number]; fauna: number; fall?: number; to?: number };
const STEPS = 8;
const DECAY: Record<number, Decay> = {
  [LC.pine]: { k: [0.359, 0.359, 0.3, 0.3, 0.24, 0.24, 0.171, 0.171], limit: 7, mult: [1, 1], fauna: 0 },
  [LC.oak]: { k: Array(STEPS).fill(0.226), limit: 5, mult: [1.17, 0.83], fauna: 0.87 },
  [LC.ash]: { k: Array(STEPS).fill(1.98), limit: 0, mult: [0.57, 1.43], fauna: 0.87 },
  [LC.aspen]: { k: Array(STEPS).fill(0.226), limit: 5, mult: [1, 1], fauna: 0.87 },
  [LC.standing]: { k: Array(STEPS).fill(0.004 * 365.25), limit: 0, mult: [1, 1], fauna: 0, fall: 1, to: LC.lying },
  [LC.lying]: { k: Array(STEPS).fill(0.9), limit: 0, mult: [1, 1], fauna: 0 },
  [LC.reedLeaf]: { k: Array(STEPS).fill(1.28), limit: 0, mult: [1, 1], fauna: 0 },
  [LC.reedStem]: { k: Array(STEPS).fill(0.95), limit: 0, mult: [1, 1], fauna: 0 },
};
const REED_LAG = 2;
// Base-rich soil: topsoil pH 5.45 or more (terrain-constants sec. 12a, 12b: 5.3 base-poor, 5.6 base-rich) [design].
const RICH_PH = 5.45;
// The fall from the plants, monthly shares (note sec. 2.1) [INFERENCE: no numeric source]: broadleaves 0.01 a month
// April to August, 0.05 September, 0.40 October, 0.45 November, 0.05 December, their year from leaf-out on 5 May
// [design]; pine needles 0.10 August, 0.35 September and October, 0.10 November, 0.0125 the other months, their year
// from 1 January; reed leaves 0.15 October, 0.35 November, 0.30 December, 0.15 January, 0.05 February, from 1 October.
const SHARES: Record<string, { start: number; months: number[] }> = {
  pine: { start: doy(1), months: [0.0125, 0.0125, 0.0125, 0.0125, 0.0125, 0.0125, 0.0125, 0.1, 0.35, 0.35, 0.1, 0.0125] },
  broad: { start: doy(5, 5), months: [0, 0, 0, 0.01, 0.01, 0.01, 0.01, 0.01, 0.05, 0.4, 0.45, 0.05] },
  reed: { start: doy(10), months: [0.15, 0.05, 0, 0, 0, 0, 0, 0, 0, 0.15, 0.35, 0.3] },
};

// ---------- invertebrates and soil fauna (R968 to R989) ----------
// Each taxon a chain of stages: each a game day dies at its hazard (scaled by the taxon's density against the cited
// one where its stage is the counted one: deaths mu0 (N / K), note sec. 3.2's logistic form with mu0 0), moves on in its
// calendar window (evenly over the days left of it) or at its hazard, and bears into its first stage in its bearing
// window, Poisson batches at a rate set so a cohort replaces itself at the base chances [derived by the expectation of
// the chain over the years, smalls.ts bearing]. Densities K a m2 by habitat; members' masses for the predators.
type Stage = {
  death: number; // a real day
  next?: number; adv?: number; win?: [number, number]; terminal?: boolean; warm?: boolean;
  bears?: boolean; bwin?: [number, number]; batch?: number;
  prey?: number; mode?: 0 | 1; mg?: number; counted?: boolean; dry?: number;
};
type Habitat = { open: number; field: number; pine: number; broad: number; heath: number; marsh: number; sand: number; clay: number };
type Taxon = { name: string; stages: Stage[]; K: (h: Habitat) => number; start: (d: number) => number; logistic?: number };
const CROW = 1 << PRED.crow, GULL = 1 << PRED.gull, FOX = 1 << PRED.fox;
// Earthworms by habitat, R984's weighted model of more than 100 UK studies, worms a m2: grassland on sandy till 208, on
// clay till 255 (matching the sim's 85 g/m2, R984 eq. 2) [INFERENCE], broadleaved woodland 362, conifer 129, moorland
// 58, wetland 121; bare and sand none [INFERENCE]. Split anecic, endogeic, epigeic 0.25, 0.6, 0.15 [design: group
// shares a gap]. A. caliginosa (R982): incubation 62 days, 0.14% dying a day, maturity at 0.5 g from 0.015 g at a growth
// constant of 0.049 a day (ln(0.5 / 0.015) / 0.049 = 72 days over three juvenile classes [derived]), rates by Arrhenius
// with 0.25 eV about 15 C; aestivation below -25 kPa [gap: not modelled]. Masses: juveniles 30, 100, 300 mg, adults 1 g
// fresh [design].
const WORMS = (h: Habitat) => (208 + (255 - 208) * h.clay) * (h.open + h.field) + 362 * h.broad + 129 * h.pine + 58 * h.heath + 121 * h.marsh;
const WORM_SHARE = [0.25, 0.6, 0.15];
const worm = (share: number): Taxon => ({
  name: "earthworm", K: (h) => WORMS(h) * share, start: () => 4,
  stages: [
    { death: 0.0014, next: 1, adv: 1 / 62, warm: true },
    { death: 0.0014, next: 2, adv: 3 / 72, warm: true, counted: true, mg: 30 },
    { death: 0.0014, next: 3, adv: 3 / 72, warm: true, counted: true, mg: 100, prey: CROW, mode: 1 },
    { death: 0.0014, next: 4, adv: 3 / 72, warm: true, counted: true, mg: 300, prey: CROW, mode: 1 },
    { death: 0.0014, bears: true, batch: 1, counted: true, mg: 1000, prey: CROW | FOX, mode: 1 },
  ],
});
// One-stage soil animals, logistic toward the habitat's density, births and deaths at b a day [design: generation times
// a gap; b the note's design], Collembola halved by summer drought (R988): enchytraeids 48,972 a m2 (47,600 in pine
// mor, R985) (R987); Collembola 15,934 on sandy ground, heath and pine (R988), 37,336 on clay and under broadleaves
// (R987), 20,249 on fen; Acari 134,977 (R987); Diptera larvae 1,632 (R987); bare ground none [gap].
const VEG = (h: Habitat) => h.open + h.field + h.pine + h.broad + h.heath + h.marsh;
const oneStage = (name: string, K: (h: Habitat) => number, b: number, dry = 0): Taxon => ({
  name, K, start: () => 0, logistic: b, stages: [{ death: b, bears: true, batch: 1, counted: true, dry }],
});
export const TAXA: Taxon[] = [
  // 0 leatherjackets, Tipula paludosa (R968): adults August to September; eggs and L1 September to October; L2 October to
  // November; L3 December to January; L4 February to April and on, pupating in July [INFERENCE]; 100 larvae a m2 of open
  // damp sward September to April, none under closed canopy; eggs and L1 die of desiccation in a dry autumn [design:
  // 0.02 a day more]; crows and gulls take the larvae; a grown larva 50 mg [gap: design]; background deaths 0.002 a day
  // [design].
  {
    name: "leatherjacket", K: (h) => 100 * h.open, start: (d) => (inWin(d, win(doy(12), doy(2))) ? 3 : inWin(d, win(doy(2), doy(7))) ? 4 : 1),
    stages: [
      { death: 0.002, next: 1, win: [doy(9), doy(11)], dry: 0.02 },
      { death: 0.002, next: 2, win: [doy(10), doy(12)], dry: 0.02, counted: true },
      { death: 0.002, next: 3, win: [doy(11), doy(2)], counted: true, mg: 20, prey: CROW | GULL },
      { death: 0.002, next: 4, win: [doy(12), doy(4)], counted: true, mg: 40, prey: CROW | GULL },
      { death: 0.002, next: 5, win: [doy(6, 15), doy(8)], counted: true, mg: 50, prey: CROW | GULL },
      { death: 0.002, next: 6, win: [doy(8), doy(9, 15)] },
      { death: 0.002, terminal: true, win: [doy(8, 15), doy(10)], bears: true, bwin: [doy(8), doy(10)], batch: 10 },
    ],
  },
  // 1 winter moth (R969, R970): eggs hatch with budburst in April; larvae feed six weeks and drop to pupate; adults November
  // to January; 60 larvae falling a m2 of oak crown a year [INFERENCE on R969's 10 to 150]; the mismatch survival of
  // R970 is not modelled (the sim's budburst is the cell's) [gap].
  {
    name: "winter moth", K: (h) => 60 * h.broad * (BROAD_SPLIT.oak / (BROAD_SPLIT.oak + BROAD_SPLIT.ash + BROAD_SPLIT.aspen)), start: () => 0,
    stages: [
      { death: 0.002, next: 1, win: [doy(4, 10), doy(5)] },
      { death: 0.01, next: 2, win: [doy(5, 20), doy(6, 10)], counted: true },
      { death: 0.002, next: 3, win: [doy(11), doy(12, 15)] },
      { death: 0.02, terminal: true, win: [doy(11, 15), doy(1, 31)], bears: true, bwin: [doy(11, 15), doy(1, 31)], batch: 10 },
    ],
  },
  // 2 green oak tortrix (R969): feeds six weeks from budburst, pupates three weeks in leaf rolls, lays in July, eggs
  // overwinter; 50 larvae a m2 of oak crown a year [INFERENCE on R969's later 20 to 120].
  {
    name: "oak tortrix", K: (h) => 50 * h.broad * (BROAD_SPLIT.oak / (BROAD_SPLIT.oak + BROAD_SPLIT.ash + BROAD_SPLIT.aspen)), start: () => 0,
    stages: [
      { death: 0.002, next: 1, win: [doy(4, 15), doy(5, 5)] },
      { death: 0.01, next: 2, win: [doy(5, 25), doy(6, 15)], counted: true },
      { death: 0.005, next: 3, win: [doy(6, 15), doy(7, 5)] },
      { death: 0.05, terminal: true, win: [doy(7, 5), doy(7, 31)], bears: true, bwin: [doy(7), doy(7, 31)], batch: 10 },
    ],
  },
  // 3 meadow brown, Maniola jurtina: adults mid June to September, living 5 to 12 days (R434), 1,000 a ha of open ground
  // layer a season (R435); larvae surviving hatch to prepupa 0.686 over 309 days watered and 0.485 under drought (R975),
  // so 0.00122 and 0.00234 a day [derived].
  {
    name: "meadow brown", K: (h) => 0.1 * (h.open + h.field), start: (d) => (inWin(d, win(doy(6, 15), doy(9))) ? 3 : 1),
    stages: [
      { death: 0.002, next: 1, win: [doy(7, 10), doy(9, 10)] },
      { death: 0.00122, next: 2, win: [doy(5, 10), doy(6, 20)], dry: 0.00112 },
      { death: 0.002, next: 3, win: [doy(6, 15), doy(8, 31)] },
      { death: 1 / 8.5, counted: true, bears: true, bwin: [doy(6, 15), doy(9, 15)], batch: 1 },
    ],
  },
  // 4 grasshoppers (R974): one generation, eggs overwinter in the soil; adults in July and August at 2.0 a m2 of open
  // sward, 0.52 of field layer, 0.85 of heath, 0.65 of marsh; nymphs hatch in May and June; adults gone by the end of
  // October [INFERENCE]; foxes and crows in summer [gap: shares]; an adult 200 mg [gap: design].
  {
    name: "grasshopper", K: (h) => 2 * h.open + 0.52 * h.field + 0.85 * h.heath + 0.65 * h.marsh, start: (d) => (inWin(d, win(doy(7), doy(10, 31))) ? 2 : 0),
    stages: [
      { death: 0.002, next: 1, win: [doy(5), doy(7)] },
      { death: 0.01, next: 2, win: [doy(7), doy(8)], mg: 100, prey: CROW | FOX },
      { death: 0.01, terminal: true, win: [doy(9, 15), doy(10, 31)], counted: true, bears: true, bwin: [doy(8), doy(10)], batch: 10, mg: 200, prey: CROW | FOX },
    ],
  },
  // 5 carabid and rove beetles: soil Coleoptera, adults and larvae, 289 a m2 at 13.95 mg dry weight each as a
  // cross-study mean (R987), here on vegetated ground; adults active April to October and overwintering [INFERENCE];
  // larvae through summer; foxes in summer and crows take the adults, 42 mg fresh [derived: dry weight a third of fresh
  // (design)].
  {
    name: "carabid", K: (h) => 289 * VEG(h), start: () => 3,
    stages: [
      { death: 0.005, next: 1, win: [doy(5), doy(6, 15)] },
      { death: 0.003, next: 2, win: [doy(7), doy(8, 15)], counted: true },
      { death: 0.003, next: 3, win: [doy(8, 10), doy(9, 10)] },
      { death: 1 / 365, counted: true, bears: true, bwin: [doy(4, 15), doy(6, 15)], batch: 5, mg: 42, prey: CROW | FOX },
    ],
  },
  // 6 red wood ants, workers (R976, R977): 225 workers a m2 of old pine (15 nests a ha, 150,000 workers a nest), here of
  // all pine crown [gap: stand age]; workers turning over at 0.01 a day [design].
  oneStage("wood ant", (h) => 225 * h.pine, 0.01),
  // 7 chironomids (R996): from temporarily flooded wet meadows and swamps 1,917 emerging a m2 a year, May to mid
  // September, here as the larvae standing in marsh [design]; adults living three days [design].
  {
    name: "chironomid", K: (h) => 1917 * h.marsh, start: () => 0,
    stages: [
      { death: 0.002, next: 1, win: [doy(5), doy(9, 15)], counted: true },
      { death: 1 / 3, bears: true, bwin: [doy(5), doy(9, 15)], batch: 10 },
    ],
  },
  // 8 Talitrus saltator and wrack fauna (R979): 45 a m2 of sandy beach, none on the generator's island (no sand); gulls
  // and crows; 30 mg [gap: design].
  { name: "talitrus", K: (h) => 45 * h.sand, start: () => 0, logistic: 0.02, stages: [{ death: 0.02, bears: true, batch: 1, counted: true, mg: 30, prey: GULL | CROW }] },
  // 9 to 11 earthworms: anecic, endogeic, epigeic.
  worm(WORM_SHARE[0]), worm(WORM_SHARE[1]), worm(WORM_SHARE[2]),
  oneStage("enchytraeid", (h) => 48972 * (VEG(h) - h.pine) + 47600 * h.pine, 0.01),
  oneStage("collembola", (h) => 15934 * ((1 - h.clay) * (h.open + h.field) + h.heath + h.pine) + 37336 * (h.clay * (h.open + h.field) + h.broad) + 20249 * h.marsh, 0.02, 0.02),
  oneStage("acari", (h) => 134977 * VEG(h), 0.01),
  oneStage("diptera larva", (h) => 1632 * VEG(h), 0.01),
];
// Foxes take invertebrates in summer only: in north-east Poland from September to March they made about 2% of a fox's
// diet (R980) [derived], so May to August here [INFERENCE].
const FOX_SUMMER = [doy(5), doy(9)] as const;
// Under a quarter full, the root zone is dry for the fauna's drought deaths [design].
const DRY = 0.25;

// ---------- sand (R990 to R995) ----------
// Size classes half a phi wide from 1.0 to 3.5, a coarse and a fine tail (note sec. 5); Bagnold's fluid threshold
// u*_ft = 0.10 sqrt(((2650 - 1.2) / 1.2) 9.81 D) (R993) for each class's middle size. The generator lays no sand (note
// sec. 5): the kind is built and idle.
const SAND_PHI = [0.5, 1.25, 1.75, 2.25, 2.75, 3.25, 3.75];
const thresholdOf = (phi: number) => 0.1 * Math.sqrt(((2650 - 1.2) / 1.2) * 9.81 * (2 ** -phi / 1000));

// ---------- the laws' constants ----------
export function smallsLaw(): SmallsConsts {
  const w = (from: number, to: number) => win(from, to);
  return {
    dayTicks: DAY, pace: Q16(PACE),
    kn: Q16(KN), muS: Q16(MU_SUMMER), muW: Q16(MU_WINTER), summer: w(doy(5), doy(11)), shadeK: Q16(SHADE), shadeFrom: Q16(SHADE_FROM),
    laMax: Q16(LA_MAX), springBranch: w(doy(3), doy(6, 10)), spring: [Q16(0), Q16(16)], later: [Q16(10), Q16(18)], fs: [Q16(FS[0]), Q16(FS[1]), Q16(FS[2])], fsb: [Q16(FSB[0]), Q16(FSB[1])], bitW: Q16(BITTEN_WEEK),
    vern: dayOfReal(doy(3)), elong: w(doy(5, 8), doy(6, 10)), flower: w(doy(6, 10), doy(7)), seed: w(doy(7), doy(8)),
    slaQ: Q16(SLA_GRASS / 1000), sb: Q16(BITE_SHARE), rtK: Q16((lamina(7) / LIVE_LEAVES / PHYLLOCHRON) * PACE),
    reedEmerge: w(80, 140), reedThinTo: w(80, doy(7))[1], reedFrost: Q16(REED_FROST), reedSenesce: w(doy(10), doy(12, 31)), reedBreak: Q32(1 - Math.exp(-PACE / REED_STAND_DAYS)), newYear: dayOfReal(doy(1)), reedK: REED_FINAL * CELL_M2,
    lagQ: Q32(1 - Math.exp(-(REED_LAG * PACE) / 365.25)), halfSummer: w(doy(5), doy(11)),
    dry: Q16(DRY), arrE: Q16(0.25 / 8.617e-5 / 288.15),
    sandThreshold: SAND_PHI.map((p) => Q16(thresholdOf(p))),
  };
}

// ---------- the tables ----------
// Litter's chances over an island day for a piece in mass class j of class c, by half year and soil: the chain's
// transient probabilities (uniformization of exp(Q dt), float64) as dyadic boundaries; at most 3 classes passed in a day
// for standing blades, which can also fall [design: the rest folded into the third, a share under 10^-4].
function transient(c: number, half: number, rich: number, j: number): { p: number[]; s: number[] } {
  const d = DECAY[c];
  if (!d) return { p: [], s: [litterState(j, c, 0)] };
  const m = d.mult[half], dt = PACE / 365.25, fauna = rich ? d.fauna : 0;
  // states: (family class, mass class) and gone (DEATH)
  const classes = d.fall ? [c, d.to!] : [c];
  const states: number[] = [];
  for (const cl of classes) for (let k = 0; k < STEPS; k++) states.push(litterState(k, cl, 0));
  const n = states.length + 1, gone = n - 1, Q = Array.from({ length: n }, () => new Float64Array(n));
  const at = (cl: number, k: number) => classes.indexOf(cl) * STEPS + k;
  for (const cl of classes) {
    const dc = DECAY[cl], mm = dc.mult[half];
    for (let k = 0; k < STEPS; k++) {
      const i = at(cl, k), move = (dc.limit ? 5 : k === STEPS - 1 ? 1 : 5) * dc.k[k] * mm * dt;
      const to = dc.limit ? (k + 1 >= dc.limit ? gone : at(cl, k + 1)) : k === STEPS - 1 ? gone : at(cl, k + 1);
      Q[i][to] += move;
      Q[i][gone] += (rich ? dc.fauna : 0) * dt;
      if (dc.fall && cl === c) Q[i][at(dc.to!, k)] += dc.fall * dt;
    }
  }
  void m; void fauna;
  for (let i = 0; i < n; i++) Q[i][i] = -Q[i].reduce((a, x, k) => (k === i ? a : a + x), 0);
  const L = Math.max(...Q.map((r, i) => -r[i])) + 1e-12;
  let v = new Float64Array(n); v[at(c, j)] = 1;
  const p = new Float64Array(n);
  let w = Math.exp(-L);
  for (let k = 0; k < 400; k++) {
    for (let i = 0; i < n; i++) p[i] += w * v[i];
    const nv = new Float64Array(n);
    for (let i = 0; i < n; i++) { if (!v[i]) continue; for (let q = 0; q < n; q++) nv[q] += v[i] * ((q === i ? 1 : 0) + Q[i][q] / L); }
    v = nv; w *= L / (k + 1);
    if (w < 1e-18 && k > L) break;
  }
  // outcomes: every other state reachable, then gone, then staying last (the remainder); standing blades at most 3 on
  const here = at(c, j), outs: { s: number; p: number }[] = [];
  for (let i = 0; i < n - 1; i++) {
    if (i === here || p[i] <= 0) continue;
    const cl = classes[Math.floor(i / STEPS)], k = i % STEPS;
    if (d.fall && k > j + 3) { const cap = at(cl, j + 3), o = outs.find((x) => x.s === states[cap]); if (o) o.p += p[i]; else outs.push({ s: states[cap], p: p[i] }); continue; }
    outs.push({ s: states[i], p: p[i] });
  }
  if (p[gone] > 0) outs.push({ s: DEATH, p: p[gone] });
  if (outs.length > 14) throw new Error(`litter class ${c}: ${outs.length + 1} outcomes`);
  return { p: outs.map((o) => o.p), s: [...outs.map((o) => o.s), states[here]] };
}
// The tables up to BASE: litter's chances, the fall schedule, the fauna's stages.
export function smallsTables(): Uint32Array {
  const out = new Uint32Array(BASE);
  for (let c = 0; c < 16; c++) for (let half = 0; half < 2; half++) for (let rich = 0; rich < 2; rich++) for (let j = 0; j < 8; j++) {
    const e = LT + (((c * 2 + half) * 2 + rich) * 8 + j) * LT_STRIDE, { p, s } = transient(c, half, rich, j);
    out[e] = s.length;
    let cum = 0;
    p.forEach((x, o) => { cum += x; out[e + 1 + o] = Q32(Math.min(cum, 1)); });
    s.forEach((x, o) => { out[e + s.length + o] = x >>> 0; });
  }
  if (LT + LT_N * LT_STRIDE !== FALL) throw new Error("litter table layout");
  const fall = fallSchedule();
  fall.forEach((row, c) => row.forEach((q, d) => { out[FALL + c * YEAR_DAYS + d] = q; }));
  faunaTable().forEach((row, i) => out.set(row, FT + i * FT_STRIDE));
  return out;
}
// Each attached class's chance a day of falling: the day's share of its year over the shares left of it (note sec. 2.1
// law of falling, exact for the schedule); the last day of its year all that is left.
function fallSchedule(): number[][] {
  const kinds = ["pine", "broad", "broad", "broad", "reed"];
  if (kinds.length !== FALL_CLASSES) throw new Error("fall classes");
  return kinds.map((k) => {
    const sh = SHARES[k], dayShare = Array.from({ length: YEAR_DAYS }, (_, d) => {
      const r0 = realOf(d) - PACE / 2;
      let s = 0;
      for (let x = 0; x < PACE; x += 0.25) {
        const r = (((r0 + x) % 365) + 365) % 365, m = MONTH.findIndex((v, i) => r >= v && r < MONTH[i + 1]);
        s += (sh.months[m] * 0.25) / (MONTH[m + 1] - MONTH[m]);
      }
      return s;
    });
    const start = dayOfReal(sh.start), out = new Array(YEAR_DAYS).fill(0);
    let left = dayShare.reduce((a, x) => a + x, 0);
    for (let i = 0; i < YEAR_DAYS; i++) {
      const d = (start + i) % YEAR_DAYS;
      out[d] = i === YEAR_DAYS - 1 ? 0xffffffff : Q32(left > 0 ? dayShare[d] / left : 0);
      left -= dayShare[d];
    }
    return out;
  });
}
// A real day's hazard over an island day, Q16; a window of real days as island days.
const perDay = (h: number) => Q16(h * PACE);
function faunaTable(): Uint32Array[] {
  const rows: Uint32Array[] = [];
  TAXA.forEach((tx, t) => {
    const bear = bearing(t);
    for (let g = 0; g < 8; g++) {
      const r = new Uint32Array(FT_STRIDE), s = tx.stages[g];
      if (!s) { r[F_.next] = 0xffffffff; r[F_.from] = 0xffffffff; r[F_.bfrom] = 0xffffffff; rows[t * 8 + g] = r; continue; }
      const sw = s.win ? win(s.win[0], s.win[1]) : null, bw = s.bwin ? win(s.bwin[0], s.bwin[1]) : null;
      r[F_.death] = perDay(s.death);
      r[F_.next] = s.next ?? 0xffffffff;
      r[F_.adv] = s.adv ? perDay(s.adv) : 0;
      r[F_.from] = sw ? sw[0] : 0xffffffff; r[F_.to] = sw ? sw[1] : 0;
      r[F_.bear] = s.bears ? bear : 0;
      r[F_.bfrom] = bw ? bw[0] : 0xffffffff; r[F_.bto] = bw ? bw[1] : 0;
      r[F_.batch] = s.batch ?? 1;
      r[F_.prey] = s.prey ?? 0; r[F_.mode] = s.mode ?? 0; r[F_.mass] = s.mg ?? 0;
      r[F_.terminal] = s.terminal ? 1 : 0; r[F_.reg] = s.counted ? 1 : 0; r[F_.dry] = perDay(s.dry ?? 0); r[F_.warm] = s.warm ? 1 : 0;
      rows[t * 8 + g] = r;
    }
  });
  return rows;
}
// The Poisson batches a bearer bears a game day, Q16, so a newborn's expected offspring are one at the base chances
// (the taxon's density at its cited one, no predators, warmth at 15 C, wet ground) [derived]: the expectation of the
// chain followed day by day over twenty island years from a newborn on each day of the year, the mean taken. A
// one-stage taxon bears at its death rate (logistic births).
function bearing(t: number): number {
  const tx = TAXA[t];
  if (tx.logistic !== undefined) return perDay(tx.logistic);
  const ch = (h: number) => 1 - Math.exp(-h * PACE);
  let total = 0;
  for (let d0 = 0; d0 < YEAR_DAYS; d0++) {
    let v = tx.stages.map(() => 0);
    v[0] = 1;
    let bearDays = 0;
    for (let k = 0; k < 20 * YEAR_DAYS; k++) {
      const d = (d0 + k) % YEAR_DAYS, nv = v.map(() => 0);
      tx.stages.forEach((s, g) => {
        if (!v[g]) return;
        const sw = s.win ? win(s.win[0], s.win[1]) : null, bw = s.bwin ? win(s.bwin[0], s.bwin[1]) : null;
        if (s.bears && (!bw || inWin(d, bw))) bearDays += v[g] * (s.batch ?? 1);
        let wc = 0;
        if (sw && inWin(d, sw)) { const left = ((sw[1] + YEAR_DAYS - 1 - d) % YEAR_DAYS) + 1; wc = left === 1 ? 1 : 1 / left; }
        const ha = !sw && s.next !== undefined ? (s.adv ?? 0) : 0, h = s.death + ha, pe = ch(h) * (1 - wc);
        const pa = h > 0 ? (pe * ha) / h : 0;
        const moved = wc + pa;
        if (s.next !== undefined && !s.terminal) nv[s.next] += v[g] * moved;
        nv[g] += v[g] * (1 - wc - pe);
      });
      v = nv;
    }
    total += bearDays;
  }
  const per = total / YEAR_DAYS;
  return per > 0 ? Q16(1 / per) : 0;
}

// ---------- each cell ----------
export function smallsDriver(w: World): SmallsDriver {
  const { isle } = groundOf(w.seed), land = new Uint8Array(CELLS);
  for (let c = 0; c < CELLS; c++) land[c] = tileAt(w, (c % N) >> 1, Math.floor(c / N) >> 1) === Tile.Water ? 0 : 1;
  const law = smallsLaw(), tables = smallsTables();
  const cellOk = (c: number) => land[c] === 1;
  const leaf = [
    { cls: LC.onPine, start: dayOfReal(SHARES.pine.start), input: Math.round((CELL_M2 * FOLIAR.pine) / (PIECE_MG[LC.pine] / 1000)) },
    ...(["oak", "ash", "aspen"] as const).map((k, i) => {
      const share = BROAD_SPLIT[k] / (BROAD_SPLIT.oak + BROAD_SPLIT.ash + BROAD_SPLIT.aspen);
      return { cls: LC.onOak + i, start: dayOfReal(SHARES.broad.start), input: Math.round((CELL_M2 * FOLIAR.broad * share) / (PIECE_MG[LC.oak + i] / 1000)) };
    }),
  ];
  const habitat = (c: number, pine: number, broad: number): Habitat => {
    const tree = isle.tree[c], trees = pine + broad, ps = trees > 0 ? pine / trees : 0;
    return { open: isle.grass[c], field: isle.field[c], pine: tree * ps, broad: tree * (1 - ps), heath: isle.shrub[c], marsh: isle.marsh[c], sand: isle.sand[c], clay: isle.clayey[c] > isle.sandy[c] ? 1 : 0 };
  };
  return {
    seed: w.seed, law, tables, leaf,
    twins: { tiller: tillerTwin(law), litter: litterTwin(law), fauna: faunaTwin(law), sand: sandTwin(law) },
    pieceUg: PIECE_UG, bladeUnits: BLADE_UNITS, reedLeaves: REED_LEAVES, reedEmerge: Math.round(REED_EMERGE * CELL_M2), reedUnder: Math.round(REED_UNDER * CELL_M2), foxSummer: foxSummer(),
    statics() {
      const out = new Uint32Array(CELLS * STATIC_WORDS);
      for (let c = 0; c < CELLS; c++) {
        if (!cellOk(c)) continue;
        const o = c * STATIC_WORDS, f = Math.max(isle.fieldLight[c], 1e-4);
        out[o + X.open] = Q16(isle.grass[c]); out[o + X.field] = Q16(isle.field[c]); out[o + X.lc] = isle.field[c] > 0 ? Q16(-Math.log(f) / EXTINCTION) : 0;
        out[o + X.marsh] = Q16(isle.marsh[c]); out[o + X.rich] = isle.ph[c] >= RICH_PH ? 1 : 0; out[o + X.flight] = Q16(isle.fieldLight[c]);
      }
      return out;
    },
    K(pine, broad) {
      const out = new Uint32Array(CELLS * 16);
      for (let c = 0; c < CELLS; c++) {
        if (!cellOk(c)) continue;
        const h = habitat(c, pine[c], broad[c]);
        TAXA.forEach((tx, t) => { out[c * 16 + t] = Math.min(0xffffffff, Math.round(tx.K(h) * CELL_M2)); });
      }
      return out;
    },
    day(d) {
      const out = new Uint32Array(CELLS * DAYW), { s, f } = seasonAt(d * DAY + DAY / 2), s1 = (s + 1) % 4;
      const lerp = (a: Float32Array[], c: number) => a[s][c] * (1 - f) + a[s1][c] * f;
      const temp = isle.seasons.map((x) => x.temp), sun = isle.seasons.map((x) => x.sun), snow = isle.seasons.map((x, k) => x.snowpack.map((v) => snowDepth(v, SNOW_DOY[k])));
      for (let c = 0; c < CELLS; c++) {
        if (!cellOk(c)) continue;
        const tc = lerp(temp, c), su = lerp(sun, c), wa = lerp(isle.soilWater, c), deep = lerp(snow, c) * (1 - INTERCEPT_SNOW * Math.min(1, isle.tree[c])), o = c * DAYW;
        out[o] = Q16(tc) >>> 0;
        out[o + 1] = Q16(RUE * su * INTERCEPT * warmEnough(tc) * watered(wa) * isle.fertility[c] * PACE);
        out[o + 2] = Q16((Math.max(0, tc - LEAF_BASE) * PACE) / LEAF_DD);
        out[o + 3] = Q16(Math.max(0, Math.min(1, wa)));
        out[o + 4] = Q16(1 - Math.max(0, Math.min(1, (deep - SNOW_REACH[0]) / (SNOW_REACH[1] - SNOW_REACH[0]))));
      }
      return out;
    },
    start(d, pine, broad) {
      const tiller: number[] = [], litter: number[] = [], fauna: number[] = [];
      const summer = inWin(d, win(doy(5, 20), doy(10)));
      for (let c = 0; c < CELLS; c++) {
        if (!cellOk(c)) continue;
        const open = Math.round(isle.grass[c] * CELL_M2 * START_OPEN), field = Math.round(isle.field[c] * CELL_M2 * START_FIELD), marsh = isle.marsh[c] * CELL_M2;
        if (open) tiller.push(c, tillerState(7, TS.veg, SPC.grass, 0), open);
        if (field) tiller.push(c, tillerState(6, TS.veg, SPC.grass, 1), field);
        if (marsh > 0) {
          for (const st of [TS.dead0, TS.dead1, TS.dead2]) tiller.push(c, tillerState(0, st, SPC.reed, 0), Math.round((marsh * REED_UNDER) / 3));
          if (summer) tiller.push(c, tillerState(0, TS.live, SPC.reed, 0), Math.round(marsh * 100));
        }
        // a year's fall lying, the generator laying no litter [design]
        const h = habitat(c, pine[c], broad[c]);
        if (h.pine > 0) litter.push(c, litterState(0, LC.pine, 0), Math.round(h.pine * leaf[0].input));
        for (let i = 0; i < 3; i++) if (h.broad > 0) litter.push(c, litterState(0, LC.oak + i, 0), Math.round(h.broad * leaf[1 + i].input));
        TAXA.forEach((tx, t) => {
          const k = Math.round(tx.K(h) * CELL_M2);
          if (k > 0) fauna.push(c, faunaState(0, tx.start(d), t), k);
        });
      }
      return { tiller, litter, fauna };
    },
  };
}

// ---------- the laws' twins ----------
// The same integers as the WGSL (wgsl/smalls.ts cst): a Split built outcome by outcome, the rest last.
class Build {
  t: number[] = []; s: number[] = []; cum = 0; b?: Split["b"];
  put(p: number, s: number) { this.cum = (this.cum + p) >>> 0; this.t.push(this.cum); this.s.push(s >>> 0); }
  rest(s: number): Split { this.s.push(s >>> 0); return { t: this.t, s: this.s, ...(this.b ? { b: this.b } : {}) }; }
}
const tday = (tick: number, c: SmallsConsts) => Math.floor(tick / c.dayTicks) % YEAR_DAYS;
const inwin = (d: number, from: number, to: number) => (from <= to ? d >= from && d < to : d >= from || d < to);
const leftin = (d: number, to: number) => ((to + YEAR_DAYS - 1 - d) % YEAR_DAYS) + 1;
function pq(h: number): number {
  if (h === 0) return 0;
  const e = qexp(-Math.min(h, 0x7fffffff));
  if (e <= 0) return 0xffffffff;
  if (e >= 65536) return 0;
  return ((65536 - e) << 16) >>> 0;
}
function part(p: number, a: number, h: number): number {
  if (h === 0 || a === 0) return 0;
  const x = mul64(p, a);
  return divw(x[1], x[0], h)[0];
}
const scale = (x: number, q: number) => (q === 0 ? x : mulhi(x, (-q) >>> 0));
const q32of = (x: number) => (x >= 65536 ? 0xffffffff : (x << 16) >>> 0);
const satadd = (a: number, b: number) => (a > 0xffffffff - b ? 0xffffffff : a + b);
function poisson3(lam: number, bk: number): Split["b"] | undefined {
  if (lam === 0) return undefined;
  const l = Math.min(lam, 0x7fffffff), p0 = qexp(-l), p1 = qmul(l, p0), p2 = qmul(Math.trunc(qmul(l, l) / 2), p0);
  const t0 = q32of(p0 >>> 0), t1 = satadd(t0, q32of(p1 >>> 0)), t2 = satadd(t1, q32of(p2 >>> 0));
  return { t: [t0, t1, t2], k: bk, mask: 0, state: 0 };
}
const xw = (inp: Uint32Array, cell: number, k: number) => inp[BASE + cell * CW + k];
const tenc = (k: number, st: number, spc: number, lay: number) => (k | (st << 3) | (spc << 6) | (lay << 10)) >>> 0;
const i32 = (x: number) => x | 0;
// A tiller's lamina above the grazing height (Q16 mg) and its day, as wgsl/smalls.ts has them: class k's lamina, the
// lamina at the day's end, senescence's exp(-s) and (1 - exp(-s)) / s, the class below a lamina with the chance of the
// class above, and a branch's five outcomes (dead; keeping the stage, low and high; taking the window's, low and high).
const WMAX = 1 << 21;
const wq = (k: number) => (k > 0 ? 1 << (k + 14) : 0);
const lamEnd = (m0: number, R: number, e: number, phi: number) => Math.min(WMAX, (qmul(m0, e) >>> 0) + (qmul(Math.min(R, 0x7fffffff), phi) >>> 0));
function senPhi(sen: number): [number, number] {
  const s = Math.min(sen, 0x7fffffff), e = qexp(-s);
  return s === 0 ? [65536, 65536] : [e, qdiv(65536 - e, s)];
}
function place(m: number): [number, number] {
  if (m >= WMAX) return [7, 0];
  if (m < 32768) return [0, (m << 17) >>> 0];
  const j = 31 - Math.clz32(m) - 14;
  return [j, ((m - (1 << (j + 14))) << (18 - j)) >>> 0];
}
function branch(b: Build, P: number, pm: number, wc: number, wall: boolean, m: number, keep: number, wto: number, last: boolean): Split | undefined {
  const [lo, p] = place(m), hi = Math.min(lo + 1, 7), to = (k: number) => ((keep & ~7) | k) >>> 0;
  const dead = pm === 0xffffffff ? P : mulhi(P, pm), live = (P - dead) >>> 0;
  const moving = wall ? live : wc > 0 ? mulhi(live, wc) : 0, stay = (live - moving) >>> 0, sHi = mulhi(stay, p), mHi = mulhi(moving, p);
  const wlo = wto === DEATH ? DEATH : ((wto & ~7) | lo) >>> 0, whi = wto === DEATH ? DEATH : ((wto & ~7) | hi) >>> 0;
  b.put(dead, DEATH);
  b.put((stay - sHi) >>> 0, to(lo));
  if (!last) b.put(sHi, to(hi));
  b.put((moving - mHi) >>> 0, wlo);
  b.put(mHi, whi);
  return last ? b.rest(to(hi)) : undefined;
}

export function tillerTwin(c: SmallsConsts) {
  const reed = (cell: number, state: number, d: number, inp: Uint32Array): Split => {
    const b = new Build(), st = (state >> 3) & 7;
    if (st === TS.live) {
      if (inwin(d, c.reedEmerge[0], c.reedEmerge[1]) && i32(xw(inp, cell, X.temp)) < c.reedFrost) return b.rest(DEATH);
      if (inwin(d, c.reedEmerge[0], c.reedThinTo)) {
        const r = xw(inp, cell, X.reedk);
        if (r < 65536) {
          const left = leftin(d, c.reedThinTo), s = qexp(Math.trunc(qln(Math.max(r, 1)) / left));
          b.put(q32of(65536 - Math.min(Math.max(s, 0), 65536)), DEATH);
        }
      }
      if (inwin(d, c.reedSenesce[0], c.reedSenesce[1])) {
        const left = leftin(d, c.reedSenesce[1]);
        if (left === 1) return b.rest(tenc(0, TS.dead0, SPC.reed, 0));
        b.put(scale(Math.floor(0xffffffff / left), b.cum), tenc(0, TS.dead0, SPC.reed, 0));
      }
      return b.rest(state);
    }
    let to = state;
    if (d === c.newYear && st < TS.dead2) to = tenc(0, st + 1, SPC.reed, 0);
    b.put(c.reedBreak, DEATH);
    return b.rest(to);
  };
  return (cell: number, state: number, tick: number, inp: Uint32Array): Split => {
    const k = state & 7, st = (state >> 3) & 7, spc = (state >> 6) & 15, lay = (state >> 10) & 1, d = tday(tick, c);
    if (spc === SPC.reed) return reed(cell, state, d, inp);
    const b = new Build();
    const lai = xw(inp, cell, X.lai0 + lay), R = xw(inp, cell, X.rt0 + lay), qb = xw(inp, cell, X.bite0 + lay), sen = xw(inp, cell, X.sen);
    const ts = st === TS.veg && d === c.vern ? TS.vern : st;
    let wc = 0, wall = false, wto = DEATH, isWin = false, wend = 0;
    if (st === TS.vern && inwin(d, c.elong[0], c.elong[1])) { isWin = true; wend = c.elong[1]; wto = tenc(0, TS.elong, spc, lay); }
    if (st === TS.elong && inwin(d, c.flower[0], c.flower[1])) { isWin = true; wend = c.flower[1]; wto = tenc(0, TS.flower, spc, lay); }
    if (st === TS.flower && inwin(d, c.seed[0], c.seed[1])) { isWin = true; wend = c.seed[1]; wto = DEATH; }
    if (isWin) { const left = leftin(d, wend); if (left === 1) wall = true; else wc = Math.floor(0xffffffff / left); }
    const mu = inwin(d, c.summer[0], c.summer[1]) ? c.muS : c.muW;
    const shade = lai > c.shadeFrom ? qmul(c.shadeK, i32(lai - c.shadeFrom)) >>> 0 : 0;
    const pm = pq(qmul(i32(mu + shade), i32(c.pace)) >>> 0);
    const [e, phi] = senPhi(sen), w0 = wq(k), keep = tenc(0, ts, spc, lay);
    branch(b, qb, st === TS.elong ? 0xffffffff : pm, wc, wall, lamEnd(w0 >>> 1, R, e, phi), keep, wto, false);
    const sp = branch(b, (0xffffffff - qb) >>> 0, pm, wc, wall, lamEnd(w0, R, e, phi), keep, wto, true)!;
    if (st === TS.veg || st === TS.vern) {
      const temp = i32(xw(inp, cell, X.temp)), cd = inwin(d, c.springBranch[0], c.springBranch[1]) ? c.spring : c.later;
      const la = qmul(c.laMax, Math.min(Math.max(qdiv(temp - cd[0], cd[1] - cd[0]), 0), 65536));
      const fs = Math.min(Math.max(c.fs[0] - qmul(c.fs[1], i32(lai)), 0), c.fs[2]), fsb = Math.min(Math.max(c.fsb[0] - qmul(c.fsb[1], i32(lai)), 0), c.fs[2]);
      const fe = fs + qmul(qmul(qb >>> 16, c.bitW), fsb - fs);
      const lam = qmul(qmul(qmul(c.kn, Math.max(fe, 0)), la), i32(c.pace));
      const born = poisson3(Math.max(lam, 0) >>> 0, 1);
      if (born) {
        let mask = 0;
        sp.s.forEach((s, j) => { const ss = (s >>> 3) & 7; if (s < FATE && (ss === TS.veg || ss === TS.vern)) mask |= 1 << j; });
        sp.b = { ...born, mask: mask >>> 0, state: tenc(0, TS.veg, SPC.grass, lay) };
      }
    }
    return sp;
  };
}

export function litterTwin(c: SmallsConsts) {
  return (cell: number, state: number, tick: number, inp: Uint32Array): Split => {
    const b = new Build(), j = state & 7, cl = (state >> 3) & 15, lag = (state >> 7) & 1, d = tday(tick, c);
    if (cl >= ATTACHED) {
      const to = cl === LC.onReed ? LC.reedLeaf : cl - ATTACHED;
      b.put(inp[FALL + (cl - ATTACHED) * 40 + d], to << 3);
      return b.rest(state);
    }
    if (lag === 1) { b.put(c.lagQ, j | (cl << 3)); return b.rest(state); }
    let qd = 0;
    if (cl === LC.standing) { qd = xw(inp, cell, X.dead); if (qd > 0) b.put(qd, (FATE + PRED.grazer) >>> 0); }
    const half = inwin(d, c.halfSummer[0], c.halfSummer[1]) ? 1 : 0;
    const e = LT + (((cl * 2 + half) * 2 + Math.min(xw(inp, cell, X.rich), 1)) * 8 + j) * LT_STRIDE, n = inp[e];
    let prev = 0;
    for (let o = 0; o + 1 < n; o++) { const t = inp[e + 1 + o]; b.put(scale((t - prev) >>> 0, qd), inp[e + n + o]); prev = t; }
    return b.rest(inp[e + n + n - 1]);
  };
}

export function faunaTwin(c: SmallsConsts) {
  return (cell: number, state: number, tick: number, inp: Uint32Array): Split => {
    const b = new Build(), stg = (state >> 3) & 7, tax = (state >> 6) & 15, row = FT + (tax * 8 + stg) * FT_STRIDE, d = tday(tick, c);
    const f = (k: keyof typeof F_) => inp[row + F_[k]];
    const avail = f("mode") === 1 ? xw(inp, cell, X.ga) : 65536;
    let taken = 0;
    for (let p = 0; p < 3; p++) {
      if (((f("prey") >>> p) & 1) === 0) continue;
      b.put(scale(mulhi(xw(inp, cell, X.eat + p), q32of(avail)), taken), (FATE + p) >>> 0);
      taken = b.cum;
    }
    let h = f("death");
    if (f("reg") === 1) h = qmul(i32(h), i32(xw(inp, cell, X.nk + tax))) >>> 0;
    if (xw(inp, cell, X.water) < c.dry) h = (h + f("dry")) >>> 0;
    const next = f("next"), from = f("from"), to = f("to");
    let ha = 0, wc = 0, wall = false;
    const nto = next !== 0xffffffff && f("terminal") === 0 ? ((state & 0xffc7) | (next << 3)) >>> 0 : DEATH;
    if (from !== 0xffffffff) {
      if (inwin(d, from, to)) { const left = leftin(d, to); if (left === 1) wall = true; else wc = Math.floor(0xffffffff / left); }
    } else if (next !== 0xffffffff) {
      ha = f("adv");
      if (f("warm") === 1) ha = qmul(i32(ha), i32(xw(inp, cell, X.arr))) >>> 0;
    }
    if (wall) return b.rest(nto);
    if (wc > 0) b.put(scale(wc, b.cum), nto);
    const hh = (h + ha) >>> 0, pe = scale(pq(hh), b.cum), pa = part(pe, ha, hh);
    b.put(pa, nto);
    b.put((pe - pa) >>> 0, DEATH);
    const sp = b.rest(state);
    const bf = f("bfrom");
    if (f("bear") > 0 && (bf === 0xffffffff || inwin(d, bf, f("bto")))) {
      const born = poisson3(f("bear"), f("batch"));
      if (born) {
        let mask = 0;
        sp.s.forEach((s, j) => { if (s < FATE) mask |= 1 << j; });
        sp.b = { ...born, mask: mask >>> 0, state: (tax << 6) >>> 0 };
      }
    }
    return sp;
  };
}

export function sandTwin(c: SmallsConsts) {
  return (cell: number, state: number, _tick: number, inp: Uint32Array): Split => {
    const b = new Build(), cls = state & 15, mode = (state >> 4) & 3;
    if (mode === 0) {
      let th = c.sandThreshold[cls] ?? 0xffffffff;
      if (xw(inp, cell, X.wet) > 0) th = 0xffffffff;
      if (xw(inp, cell, X.ustar) > th) return b.rest(cls | (1 << 4));
      if (xw(inp, cell, X.swash) > 0) return b.rest(cls | (2 << 4));
      return b.rest(state);
    }
    if (mode === 2 && xw(inp, cell, X.swash) > 0) return b.rest(state);
    return b.rest(cls);
  };
}

// Litter pieces' masses, ug, by (class, mass class) (for the census), and blades' (for what grazers take); the fauna's
// prey masses come with the table.
export const PIECE_UG = Array.from({ length: 128 }, (_, i) => {
  const cl = i >> 3, j = i & 7, m = PIECE_MG[cl >= ATTACHED ? (cl === LC.onReed ? LC.reedLeaf : cl - ATTACHED) : cl] ?? 0;
  return Math.round(m * 1000 * 0.8 ** j);
});
export const BLADE_UNITS = Math.round((PIECE_MG[LC.standing] * 8));
export { FOX_SUMMER, REED_EMERGE, REED_UNDER, REED_LEAVES, CELL };
export const foxSummer = () => win(FOX_SUMMER[0], FOX_SUMMER[1]);
