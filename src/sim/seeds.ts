// How the island's plants spread on their own (docs/research/plant-constants.md sec. 13; the GPU plan's Unit 8): the
// constants and the daily drivers of the seeds' and seedlings' law, which runs on the GPU (src/gpu/seedlings.ts, its
// kernels src/gpu/wgsl/seedlings.ts). Every seed a live parent stem sheds is evaluated on its own there, keyed by its
// parent, year and number; those that live to come up are held in their 18.75 m texel until their day, and come up as
// seedlings held by (texel, kind, day come up): every one of a group shares every input of the law, so each day's
// fates are drawn exactly for the group, each member keeping its own identity.
import { DAY, YEAR_DAYS, groundOf, wetAt, type World } from "./world";
import { onDay, seasonAt } from "./sky";
import { GROWTH_C, SEEDLINGS, TREE_KINDS, YEARS_PACE, openNet } from "./plants";
import { envAt, fit } from "../terrain/niche";
import { FLORA, SPECIES, START, TILE_M, lnGamma, treeHeight } from "../terrain/flora";
import { SLA, keptOf, madeOf, pOf } from "../terrain/growth";
import { CELL, N } from "../terrain/grid";
import { BLOCK_CELLS, LAYER, ROW_OF, SEED_ROWS, YOUNG_WORDS, type SeedDriver, type SeedLaw } from "../gpu/seedlings";
import { TEXELS, TEXELS_SIDE, TEXEL_MM } from "../gpu/wgsl/stems";

const Q16 = (x: number) => Math.round(x * 65536);
const Q32 = (p: number) => Math.min(0xffffffff, Math.round(p * 2 ** 32));
// A mass in g as the stems' q, its fourth root in kg^(1/4) x 2^20 (wgsl/stems.ts).
const qOf = (g: number) => Math.round((g / 1000) ** 0.25 * 2 ** 20);
// The first whole island day at or after a time of year given in real days after the spring equinox (sky.ts onDay).
const dayOn = (realDays: number) => Math.ceil(onDay(realDays)) % YEAR_DAYS;

// ---------- each seed's life ----------
// Scots pine: 50 to 70% of its seed viable (Nixon and Worrell, R455, Table 2.2), and of seed sown on unprepared ground
// 6.7% stood as seedlings at the last count (Lariviere et al., R457): a seed lives to come up at 0.6 x 0.067 [derived].
// Ash: seedlings 1.1 to 24.5% of the fruit two years before (Tapper, R458), their geometric middle. Oak: of the acorns
// lying at the end of the fall, mice cache 2% that no one finds again (R461) and 66 to 71% of those buried come up
// (R462), the middle; what the jays cache and leave [gap].
const SURVIVE: Record<string, number> = { pine: 0.6 * 0.067, ash: Math.sqrt(0.011 * 0.245), oak: 0.02 * 0.685 };
// Where it lands, from its parent's foot, in a direction of its own:
// - pine, an exponential with 80% within the tree's height (80% within 20 m of a 20 m tree, R455 Table 2.6), so a
//   mean of the height over ln 5 [derived];
// - ash, an exponential-power kernel of mean 39.1 m and shape 2.085 (Semizer-Cuming et al., R459): a distance a G^(1/b)
//   with G a gamma variate of shape 2/b, a = mean G(2/b) / G(3/b) [derived: the 2D kernel's mean];
// - oak, seedlings from their mothers in the open, median 25.9 m and 95th percentile 116 m (Gerzabek et al., R460), as a
//   lognormal [derived];
// - bramble seed, carried by birds that leave most within 50 m and nearly all within 100 m (R468), an exponential with
//   95% within 100 m [derived]; daughters at the tips of arching canes 3.3 m out (Amor, R466);
// - aspen suckers up from the surface roots as far as 40 m from the stump (Jobling, R463), evenly over that disc.
const ASH_MEAN = 39.1, ASH_SHAPE = 2.085, OAK_MEDIAN = 25.9, OAK_P95 = 116, BIRD_MEAN = 100 / Math.log(20), CANE = 3.3, SUCKER_REACH = 40;
// What comes up where it lands: nothing on water; Scots pine, which wants at least 60% of full light to establish
// (R455 Table 4.1, the pines and larches), not where the crowns over its texel leave it less; ash and oak whatever the
// light, their growth in it then deciding [gap: their own thresholds].
const PINE_LIGHT = 0.6;
// Bramble: under 0.4 seedlings a m2 near thickets (R466), here a m2 of a bush's crown, a year; daughters rooted at the
// tips of its canes by 25% of the bushes a year, as fenced thickets grew in Dutch pine stands with no deer, 434 to
// 4,085 a ha in ten years (Kuiters and Slim, R475) [derived]. Aspen: felled or burned, its suckers come at 50,000 to
// 100,000 a ha over its roots after a clear-cut (R464), the middle, each some 4.2 g weeks in (R465).
const BRAMBLE_M2 = 0.4, DAUGHTERS = 0.25, SUCKERS_HA = 75000, SUCKER_G = 4.2;

// ---------- when ----------
// Real days after the spring equinox. Scots pine sheds April to July and comes up within two weeks above 10 C (R455
// Table 2.5); the island's pine sheds from April 1 and all of the year's comes up together in mid May, as the old
// rule had it [design: one coming up a year, the shed held to April and early May]. Oak's acorns fall from mid
// September to the last week of October (R454, ecology.ts ACORNS_FROM and ACORNS_TO) and come up in May and June
// (R460), so June 1. Ash's fruit falls through autumn and winter [UNVERIFIED: October to December here] and, after two
// winters' dormancy, comes up mid April to the end of May (R458), so early May two springs on. Bramble seedlings come
// up in spring, April 20; daughters root in autumn, October 1 (R466). Suckers come up the day the stump resprouts.
const WHEN = {
  pine: { from: dayOn(12), to: dayOn(57), up: dayOn(57), lag: 0 },
  oak: { from: dayOn(179), to: dayOn(218), up: dayOn(73), lag: 1 },
  ash: { from: dayOn(195), to: dayOn(286), up: dayOn(49), lag: 2 },
  berry: { from: dayOn(31), to: dayOn(31) + 1, up: dayOn(31), lag: 0 },
  daughter: { from: dayOn(195), to: dayOn(195) + 1, up: dayOn(195), lag: 0 },
};

// ---------- browsing (R471 to R474, as the old cohorts had it) ----------
// Red deer browse to 1.8 m and rabbits to 0.54 m (R471). The share of Scots pine saplings browsed a year: under 15%
// below 2 deer a km2, 30% at 10 and 80% at 20 (Palmer and Truscott, R472), along those points; of the browsed, 50 to 70%
// died, of the unbrowsed 15 to 20% (Brooker et al., R473), so a browsing kills (60 - 17.5) / 82.5 [derived]. Rabbits at
// 11.7 a ha left 26% of oak transplants alive in a year where 85% lived fenced (Bakker et al., R474): a yearly kill of
// 1 - e^(-R / R0), R0 = 11.7 / ln(85 / 26) [derived]. Densities are each 600 m block's deer and rabbits that day, the
// animals' own objects [design: the block]. What they eat of the young doesn't feed them [gap].
const DEER_REACH = 1.8, RABBIT_REACH = 0.54, BROWSE_KILL = (0.6 - 0.175) / 0.825, RABBIT_R0 = 11.7 / Math.log(85 / 26);
const browsed = (d: number) => (d <= 2 ? 0.15 * (d / 2) : d <= 10 ? 0.15 + (0.15 * (d - 2)) / 8 : Math.min(1, 0.3 + (0.5 * (d - 10)) / 10));
// A bramble seedling stands as a bush (0.9 m, ecology.ts matured) in its second summer, once grown to a bush's mass,
// when its canes first fruit (Agriculture Victoria, R466).
const BUSH_H = 0.9, BRAMBLE_YEARS = 2;

// The constants of the law, as the GPU takes them.
export function seedLaw(seed: number): SeedLaw {
  const part = YEARS_PACE / 365.25, blockM = BLOCK_CELLS * CELL, blockKm2 = (blockM / 1000) ** 2, blockHa = (blockM / 100) ** 2;
  const browse = new Uint32Array(2048);
  for (let n = 0; n < 1024; n++) {
    const d = n / blockKm2, r = n / blockHa;
    browse[n] = Math.min(65535, Q16(1 - (1 - BROWSE_KILL * browsed(d)) ** part));
    browse[1024 + n] = Math.min(65535, Q16(1 - Math.exp((-r / RABBIT_R0) * part)));
  }
  const ashScale = ASH_MEAN * Math.exp(lnGamma(2 / ASH_SHAPE) - lnGamma(3 / ASH_SHAPE));
  const row = (sp: string) => ROW_OF[sp as keyof typeof ROW_OF];
  const L = (sp: string, q0g: number, w: { from: number; to: number; up: number; lag: number }, parity = -1) => ({ row: row(sp), q0: qOf(q0g), ...w, parity });
  const layers = [] as SeedLaw["layers"][number][];
  layers[LAYER.pine] = L("pine", SEEDLINGS.pine.seed, WHEN.pine);
  layers[LAYER.oak] = L("oak", SEEDLINGS.oak.seed, WHEN.oak);
  layers[LAYER.ash0] = L("ash", SEEDLINGS.ash.seed, WHEN.ash, 0);
  layers[LAYER.ash1] = L("ash", SEEDLINGS.ash.seed, WHEN.ash, 1);
  layers[LAYER.berry] = L("berry", SEEDLINGS.berry.seed, WHEN.berry);
  layers[LAYER.daughter] = L("berry", SEEDLINGS.berry.up, WHEN.daughter);
  layers[LAYER.sucker] = L("aspen", SUCKER_G, { from: -1, to: -1, up: -1, lag: 0 });
  return {
    seed: seed >>> 0, dayTicks: DAY, yearDays: YEAR_DAYS,
    survive: SEED_ROWS.map((sp) => Q32(SURVIVE[sp] ?? 0)),
    pineMean: Q16(1 / Math.log(5)), ashScale: Math.round(ashScale * 1000), ashShape: Q16(2 / ASH_SHAPE), ashPow: Q16(1 / ASH_SHAPE),
    oakMu: Q16(Math.log(OAK_MEDIAN)), oakSigma: Q16((Math.log(OAK_P95) - Math.log(OAK_MEDIAN)) / 1.6448536),
    birdMean: Math.round(BIRD_MEAN * 1000), cane: Math.round(CANE * 1000), berryArea: Q16(BRAMBLE_M2), daughter: Q32(DAUGHTERS),
    suckerReach: SUCKER_REACH * 1000, suckerLam: Q16((SUCKERS_HA * Math.PI * SUCKER_REACH ** 2) / 1e4 / 4), pineLight: Q16(PINE_LIGHT),
    layers, qup: SEED_ROWS.map((sp) => qOf(SEEDLINGS[sp].up)),
    deerReach: Math.round(DEER_REACH * 1000), rabbitReach: Math.round(RABBIT_REACH * 1000),
    bushMm: Math.round(BUSH_H * 1000), bramDays: BRAMBLE_YEARS * YEAR_DAYS, browse,
    species: SEED_ROWS.map((sp) => SPECIES.indexOf(sp as (typeof SPECIES)[number])), tree: FLORA.indexOf("tree"), bush: FLORA.indexOf("bush"),
  };
}

// The law's drivers on an island: its water by texel, each cell's height at which its young trees stand up as stems,
// and each day's growth coefficients for every land cell.
// - Water: a texel whose centre lies under water [design: the texel is the resolution].
// - Standing up: young trees stand up as stems once as tall as the ground's own of their kind there, as the generator
//   lays them down (flora.ts treeHeight by the cell's fit, its spread's middle), as the old cohorts did [derived].
// - Growth, by cell and kind, at the cell's centre and its seasons drawn between their middles, as the stems' law has
//   it (plants.ts stemDriver), for every land cell: below its kind's coming-up mass (plants.ts SEEDLINGS up) a seedling
//   grows by the plant rule's own relative rate, a quarter of it for q (alpha, beta in Q16 a day at the year's pace);
//   past it a young tree's q grows as the stems' do, c/4 times its place's net gain over the reference open ground's
//   (alpha, beta in q's units); both held under 2^16.
export function seedDriver(w: World): SeedDriver {
  const g = groundOf(w.seed), { isle, fine } = g, law = seedLaw(w.seed);
  const cells: number[] = [];
  for (let i = 0; i < N * N; i++) if (!wetAt(w, ((i % N) + 0.5) * (CELL / TILE_M), (Math.floor(i / N) + 0.5) * (CELL / TILE_M))) cells.push(i);
  const NR = SEED_ROWS.length, fits = new Float32Array(N * N * NR);
  for (const i of cells) {
    const e = envAt(isle, fine.bilinear, START + (i % N) * CELL, START + Math.floor(i / N) * CELL, NaN, START);
    for (let r = 0; r < NR; r++) fits[i * NR + r] = fit(SEED_ROWS[r], e);
  }
  const part = YEARS_PACE / 365.25, most = 0xffff, rel = (YEARS_PACE / 4) * 65536;
  const lost = SEED_ROWS.map((sp) => TREE_KINDS.includes(sp as never) && openNet(w, sp) <= 0);
  const treeScale = SEED_ROWS.map((sp) => (GROWTH_C[sp] ? ((GROWTH_C[sp] / 4) * part * 2 ** 20) / openNet(w, sp) : 0));
  const ps = [...new Set(SEED_ROWS.map((sp) => pOf(sp)))], pAt = SEED_ROWS.map((sp) => ps.indexOf(pOf(sp)));
  const perSla = new Float64Array(ps.length), young = new Int32Array(N * N * YOUNG_WORDS);
  let memo = -1, done = 0;
  // The day whose coefficients young holds, for its first `done` cells of `cells`.
  const work = (t: number, upTo: number) => {
    if (memo !== t) { memo = t; done = 0; }
    const { s, f: x } = seasonAt(t), s2 = (s + 1) % 4, a = isle.seasons[s], b = isle.seasons[s2], wa = isle.soilWater[s], wb = isle.soilWater[s2];
    for (let c = done; c < upTo; c++) {
      const i = cells[c];
      const sun = a.sun[i] * (1 - x) + b.sun[i] * x, temp = a.temp[i] * (1 - x) + b.temp[i] * x, water = wa[i] * (1 - x) + wb[i] * x, kept = keptOf(temp);
      for (let p = 0; p < ps.length; p++) perSla[p] = madeOf(1, sun, temp, water, ps[p]);
      for (let r = 0; r < NR; r++) {
        const sp = SEED_ROWS[r], made = SLA[sp] * fits[i * NR + r] * perSla[pAt[r]], at = i * YOUNG_WORDS + r * 4;
        young[at] = Math.min(most, Math.round(rel * made));
        young[at + 1] = Math.min(most, Math.round(rel * kept));
        if (r < 4) {
          young[at + 2] = lost[r] ? 0 : Math.min(most, Math.round(treeScale[r] * made));
          young[at + 3] = lost[r] ? Math.min(most, Math.round((GROWTH_C[sp] / 4) * part * 2 ** 20)) : Math.min(most, Math.round(treeScale[r] * kept));
        }
      }
    }
    done = Math.max(done, upTo);
  };
  return {
    law,
    dry() {
      const out = new Uint32Array(TEXELS / 32), m = TEXEL_MM / 1000 / TILE_M;
      for (let t = 0; t < TEXELS; t++) if (!wetAt(w, ((t % TEXELS_SIDE) + 0.5) * m, (Math.floor(t / TEXELS_SIDE) + 0.5) * m)) out[t >>> 5] |= 1 << (t & 31);
      return out;
    },
    stand() {
      const out = new Uint32Array(N * N * 4);
      for (const i of cells) for (let r = 0; r < 4; r++) out[i * 4 + r] = Math.round(treeHeight(SEED_ROWS[r], fits[i * NR + r], 0.5) * 1000);
      return out;
    },
    young(t) {
      work(t, cells.length);
      return young;
    },
    // The next day's after tick t, an even share of those left for each hour left before it (they depend on nothing but
    // the day, so they are the same worked out whenever).
    ahead(t) {
      const next = (Math.floor(t / DAY) + 1) * DAY, from = memo === next ? done : 0;
      if (from < cells.length) work(next, Math.min(cells.length, from + Math.ceil((cells.length - from) / Math.max(1, Math.ceil((next - t) / (DAY / 24))))));
    },
  };
}
