// How a green plant grows, the one rule the generator lays the island's plants down by and the game grows them by
// (docs/research/plant-constants.md). Its leaves take in the sun that reaches them and make dry matter of it at
// Monteith's efficiency while it is warm enough and the soil holds water enough; it pays a share of that to build, and
// burns a share of itself each day to stay alive. Where that comes out ahead it grows; where it can't, nothing of its
// kind lasts.
import { clamp } from "math";

// Warm enough to grow: the NFDRS growing season index's minimum-temperature ramp, nothing at -2 C and all of it from 5 C
// (fire-constants R72).
// The growing season index past which living plants come green and the broadleaves leaf out: the NFDRS's green-up
// threshold (fire-constants sec. 12, R72; wetness.ts).
export const GREEN_UP = 0.2;
export const warmEnough = (temp: number) => clamp((temp + 2) / 7, 0, 1);
// Water enough: FAO-56's stress coefficient Ks (R221 eq. 84) for a root zone holding this share of what it can, with the
// share p of it taken before stress begins: 0.5 for most plants (R221 ch. 8), and by FAO-56 Table 22's nearest rows
// (R221) conifers 0.70, grazing pasture (the sward and the herbs) 0.60, berry bushes (the shrubs) 0.50; the broadleaf
// trees take the apple, cherry and pear row's 0.50 [analogue: the table's only broadleaf trees]; reeds 0.5 [gap]. The
// table's adjustment for the day's demand (p + 0.04 (5 - ETc)) is left out [gap].
export const P_STRESS = 0.5;
const P_OF: Record<string, number> = { pine: 0.7, oak: 0.5, ash: 0.5, aspen: 0.5, berry: 0.5, hazel: 0.5, heather: 0.5, reeds: 0.5 };
export const pOf = (name: string) => P_OF[name] ?? 0.6;
export const watered = (share: number, p = P_STRESS) => clamp(share / (1 - p), 0, 1);
// The root zone every plant here draws on, m: 1.0, the depth inside every one of FAO-56 Table 22's ranges for the
// nearest rows (conifers 1.0 to 1.5, apple, cherry and pear 1.0 to 2.0, berry bushes 0.6 to 1.2, grazing pasture 0.5 to
// 1.5; R221) [derived], so one soil bucket serves them all.
export const ROOTS = 1.0;

// Monteith's 1.4 g of dry matter for each MJ of the sun's radiation leaves intercept (R335); half a young plant's mass in
// leaf (Poorter, R337); McCree's growth respiration, a quarter of what's made, and maintenance, 1.5% of the plant a day at
// 20 C, doubling with every 10 degrees (R336).
export const RUE = 1.4, LMF = 0.5, GROWTH_RESP = 0.25, MAINT = 0.015, Q10 = 2;

// The leaf area each gram of a plant's leaves spreads, m2: FloraVeg.EU's mean over its trait datasets (R344), for the
// berry the dewberry (Rubus caesius, fire-constants sec. 19's bramble analogue being missing there) and for grass the
// mean of five common grasses (red fescue, common bent, Yorkshire fog, cock's-foot, sweet vernal grass) [derived].
export const SLA: Record<string, number> = {
  pine: 5.89e-3, oak: 13.32e-3, ash: 12.68e-3, aspen: 17.62e-3,
  berry: 18.29e-3, hazel: 23.63e-3, heather: 9.71e-3,
  yarrow: 17.68e-3, sorrel: 23.76e-3, mint: 30.02e-3, bracken: 18.45e-3, lady_fern: 12.1e-3,
  buttercup: 21.24e-3, daisy: 32.32e-3, clover: 32.07e-3, harebell: 25.45e-3, poppy: 23.89e-3,
  reeds: 11.07e-3, grass: 26.39e-3,
};

// What a gram of a plant of leaf area sla makes in a day in this much of the sun, MJ/m2, its growth respiration paid,
// warm and watered as it is (p: the share of its water it takes before it goes short), g; and what a gram burns in a day
// at this warmth, g.
export const madeOf = (sla: number, sun: number, temp: number, water: number, p = P_STRESS) => (1 - GROWTH_RESP) * RUE * sun * sla * LMF * warmEnough(temp) * watered(water, p);
export const keptOf = (temp: number) => MAINT * Q10 ** ((temp - 20) / 10);

// Crowns: under one, an eighth of the sky's glow gets through; where two overlap, a sixty-fourth, and no more is lost past
// that (light.ts, Beer-Lambert through a crown's leaves).
export const LEAVES = 2.6;
export const sieve = (cover: number) => LEAVES * Math.min(cover, 2);
export const through = (cover: number) => Math.exp(-0.8 * sieve(cover));

// How well a plant does in a share (light) of the open sky's sun, against how it does in all of it: nothing at or below
// the share it needs to make what it burns (its compensation point, comp), all of it in the open. comp 1 or more: it
// can't keep itself even in the open.
export const thrive = (light: number, comp: number) => (comp >= 1 ? 0 : clamp((light - comp) / (1 - comp), 0, 1));
// A plant's compensation point over a year at a place: the seasons' sun (MJ/m2 a day), warmth and soil water there, and
// how well the ground suits it otherwise (fit, which scales what it makes, as the game's seedlings have it); p as
// madeOf's.
export function yearComp(sla: number, sun: ArrayLike<number>, temp: ArrayLike<number>, water: ArrayLike<number>, fit: number, p = P_STRESS) {
  let made = 0, kept = 0;
  for (let s = 0; s < sun.length; s++) { made += madeOf(sla, sun[s], temp[s], water[s], p); kept += keptOf(temp[s]); }
  return made * fit > 0 ? kept / (made * fit) : Infinity;
}
// The share of the ground a stand of plants that need this share of the open sky's sun (comp) covers: its crowns fill
// in until the light under them falls to what its own leaves need, the light under crowns being growth.ts through()
// (Monsi and Saeki's canopy, R614) [derived]. All of it where even a full crown leaves them enough; none where the open
// sky doesn't.
export const closes = (comp: number) => (comp >= 1 ? 0 : clamp(-Math.log(comp) / (0.8 * LEAVES), 0, 1));
