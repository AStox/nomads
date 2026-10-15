// What grows where, now, and how fast (docs/research/plant-constants.md). A plant's fit at a point is its niche
// (src/terrain/niche.ts) over the island's lasting conditions there, in the light the crowns overhead leave it and on the
// soil as it has been fed or drawn down since. It grows by the sun its leaves take in, made into dry matter at Monteith's
// efficiency while it is warm enough and the soil holds water enough (FAO-56's stress coefficient), less what it burns to
// keep alive (McCree): a seedling a gram at a time, a grown plant as the share of its best it grows at now.
import { TREE_MAX, draw, envAt, fit } from "../terrain/niche";
import { FLORA, SIZE, SPECIES, START, crownShare, dbhOf } from "../terrain/flora";
import { SLA, keptOf, madeOf, pOf, warmEnough, watered } from "../terrain/growth";
import { CELL, N } from "../terrain/grid";
import { airAt } from "./air";
import { skyShare } from "./light";
import { feedRate, soilWaterAt } from "./soil";
import { DAY, H, TILE_M, W, YEAR_DAYS, dryAt, groundOf, type World } from "./world";
import { seasonAt } from "./sky";
import { branchKg, stemKg } from "./mechanics";
import { PHYS } from "./fuel";
import { rinit, next32 } from "../gpu/rand";
import type { StemDriver } from "../gpu/flora";
import { HC, HQ, LAID, MAP, QSTEP, QTOP, ROWS, ROW_WORDS, RW, SSTEP, TEXEL_MM, TREE_ROWS } from "../gpu/wgsl/stems";

export function fitHere(w: World, name: string, px: number, py: number) {
  return fitIn(w, name, px, py, skyShare(w, px, py));
}
// The same in a given share of the open sky's light.
export function fitIn(w: World, name: string, px: number, py: number, light: number) {
  return fit(name, { ...envHere(w, px, py), light });
}
// The island's lasting conditions at a point, as the niches read them (niche.ts Env): the light left out, which fitHere
// takes as it is now.
export function envHere(w: World, px: number, py: number) {
  const { isle, fine } = groundOf(w.seed);
  return envAt(isle, fine.bilinear, px * TILE_M - SIZE / 2, py * TILE_M - SIZE / 2, NaN, START);
}
// Of the names, the one that takes root at a point, drawn by fit as the ground's own were (r: 0..1).
export const pickHere = <T extends string>(w: World, names: readonly T[], px: number, py: number, r: number) => draw(names, names.map((n) => fitHere(w, n, px, py)), r);

// ---------- what limits growth (secs. 2 and 3; terrain/growth.ts) ----------
// How fast a grown plant at a point grows now, against its best: warm and watered enough, in the light the crowns leave
// it, on the soil's nourishment (soil.ts feedRate) [gap: fertility's own physics].
export const growth = (w: World, px: number, py: number) => growthOf(airAt(w, px, py).temp, soilWaterAt(w, px, py), skyShare(w, px, py), feedRate(w, px, py));
export function growthOf(temp: number, water: number, light: number, feed: number) {
  return warmEnough(temp) * watered(water) * light * feed;
}

// ---------- a seedling's carbon (sec. 4; terrain/growth.ts) ----------
// The island's year is YEAR_DAYS days, and what plants do in a year they do in it (fire-constants sec. 12, body-constants
// sec. 10): a seedling's day is the year's 365.25 / YEAR_DAYS days of growing [design].
export const YEARS_PACE = 365.25 / YEAR_DAYS;
// What each kind of seedling is: its seed's mass, g (FloraVeg.EU, R344; the berry's R342, FloraVeg's Rubus seed being
// the whole fruitlet; grass the mean of the five grasses SLA takes), the leaf area each gram of its leaves spreads
// (growth.ts SLA), and the mass at which it stands as what the island calls a bush, a young tree or a tuft of grass, g
// [design].
export type Seedling = { seed: number; sla: number; up: number };
export const SEEDLINGS: Record<string, Seedling> = {
  berry: { seed: 0.0025, sla: SLA.berry, up: 5 },
  grass: { seed: 0.0006, sla: SLA.grass, up: 0.5 },
  oak: { seed: 3.12, sla: SLA.oak, up: 10 },
  ash: { seed: 0.0623, sla: SLA.ash, up: 10 },
  pine: { seed: 0.00658, sla: SLA.pine, up: 10 },
  aspen: { seed: 0.00011, sla: SLA.aspen, up: 10 },
};
// The dry matter a seedling of this kind and mass makes in an hour, g: what its leaves catch of the sun on the open
// ground (W/m2) in the share of it that reaches them, made while warm and watered enough and as the ground suits it
// (fit, the niche's), less what it burns to stay alive at the air's warmth; at the year's pace.
export function seedlingGain(k: Seedling, mass: number, sun: number, light: number, temp: number, water: number, fit: number) {
  return ((madeOf(k.sla, (sun * light * 3600) / 1e6, temp, water) * fit - keptOf(temp) / 24) * mass) * YEARS_PACE;
}
// The island's seasons at a point, as the generator laid its plants down by (growth.ts yearComp): each season's sun on
// the ground there (MJ/m2 a day), its mean warmth, and how full the soil's water stands.
export type Seasons = { sun: number[]; temp: number[]; water: number[] };
export function seasonsHere(w: World, px: number, py: number): Seasons {
  const { isle, fine } = groundOf(w.seed), cx = (px * TILE_M - SIZE / 2 - START) / CELL, cy = (py * TILE_M - SIZE / 2 - START) / CELL;
  const at = (f: Float32Array) => fine.bilinear(f, cx, cy);
  return { sun: isle.seasons.map((s) => at(s.sun)), temp: isle.seasons.map((s) => at(s.temp)), water: isle.soilWater.map(at) };
}

// ---------- grown stems (sec. 11) ----------
// A tree's dry mass at a height, kg: Repola's stem and branches (mechanics.ts) on the stem the game's trees have at that
// height (flora.ts dbhOf).
export const treeKg = (sp: string, h: number) => { const d = dbhOf(sp, h); return stemKg(d, h) + branchKg(d, h); };
// A young or grown tree grows as its mass to the 3/4 (Niklas and Enquist, R469), dM/dt = c M^(3/4), c for each kind
// what takes one from a seedling come up (SEEDLINGS up) to its height in British yield tables at 20 years from planting,
// 2 to 4 years after the seed (R470), with three added: Scots pine 7.5 m (yield class 100) and oak 7.8 m (yield class
// 60, Bradley et al.), ash 11.4 m planted on grassland in Ireland (Wellock et al.); aspen's suckers 11.4 m at 20 years
// old in Sweden (site index 20, Johansson) [derived]: kg^(1/4) a year. That's in the open on the island's typical
// ground at a perfect fit (openNet); elsewhere it grows as the plant rule's net gain there stands to that, which shade
// or a poor fit can take below nothing, starving it.
export const TREE_KINDS = ["pine", "oak", "ash", "aspen"] as const;
const CALIBRATED: Record<string, [h: number, years: number]> = { pine: [7.5, 23], oak: [7.8, 23], ash: [11.4, 23], aspen: [11.41, 20] };
export const GROWTH_C: Record<string, number> = Object.fromEntries(TREE_KINDS.map((sp) => {
  const [h, yr] = CALIBRATED[sp];
  return [sp, (4 * (treeKg(sp, h) ** 0.25 - (SEEDLINGS[sp].up / 1000) ** 0.25)) / (yr - 1)];
}));
// The calibrated law's own heights: a tree come up at year 1, grown in the open on the reference ground, at so many
// years old, m (the tree's mass read back to its height).
export function calibratedHeight(sp: string, years: number) {
  const m = ((SEEDLINGS[sp].up / 1000) ** 0.25 + (GROWTH_C[sp] / 4) * (years - 1)) ** 4;
  let lo = 0, hi = 100;
  for (let i = 0; i < 60; i++) { const mid = (lo + hi) / 2; if (treeKg(sp, mid) < m) lo = mid; else hi = mid; }
  return lo;
}
// The net gain of a gram of a plant in a share of the open sky's light, at a place's seasons at tick t, as well as the
// ground suits it, g a day.
function netOn(sp: string, here: Seasons, fitness: number, light: number, t: number) {
  const { s, f } = seasonAt(t), mix = (a: number[]) => a[s] * (1 - f) + a[(s + 1) % 4] * f;
  return fitness * madeOf(SLA[sp], mix(here.sun) * light, mix(here.temp), mix(here.water), pOf(sp)) - keptOf(mix(here.temp));
}
// The open, best-fitting ground c holds for: the island's own land in its typical year, the net gain of a gram of each
// kind there day by day over a year, averaged over the land (a sample of every 61st land tile) [derived].
const opens = new WeakMap<World, Record<string, number>>();
export function openNet(w: World, sp: string) {
  let got = opens.get(w);
  if (!got) opens.set(w, (got = {}));
  if (got[sp] !== undefined) return got[sp];
  let sum = 0, n = 0;
  for (let i = 0; i < W * H; i += 61) {
    if (!dryAt(w, (i % W) + 0.5, Math.floor(i / W) + 0.5)) continue;
    const here = seasonsHere(w, (i % W) + 0.5, Math.floor(i / W) + 0.5);
    for (let d = 0; d < YEAR_DAYS; d++) sum += netOn(sp, here, 1, 1, d * DAY);
    n += YEAR_DAYS;
  }
  return (got[sp] = n ? sum / n : 0);
}

// The stems' kinds as the GPU's tables have them (wgsl/stems.ts rows): the trees first.
const STEM_ROWS = [...TREE_KINDS, "berry", "hazel", "heather"] as const;
// Each kind's year's seed a stem, in its good or mast years (wgsl/stems.ts crop), and how often those come:
// - Scots pine, 12,000 seeds a tree in good years, 13 years of 19 (Nixon and Worrell, R455);
// - ash, up to 140,000 fruits a tree in a mast year, masting every 2 to 5 years (Thomas, R458), so a year in 3.5;
// - oak, the acorns of 0.196 kg fresh a m2 of crown in the 13 years of 27 that had a crop (R454), each a nut's mass;
// - aspen, whose seed seldom comes up, and the bushes, whose seed or nuts a stem sheds were not read: none [gap].
export const ACORN_KG = 0.196, ACORN_YEARS = 13 / 27;
const CROP: Record<string, { each: number; m2: number; often: number }> = {
  pine: { each: 12000, m2: 0, often: 13 / 19 },
  ash: { each: 140000, m2: 0, often: 1 / 3.5 },
  oak: { each: 0, m2: ACORN_KG / (PHYS.nut.mass * (1 + (PHYS.nut.green ?? 0))), often: ACORN_YEARS },
};
// The counter stream the mast years draw from (gpu/rand.ts): one draw a kind a year.
const MAST_STREAM = 0x6d617374;
const TEXEL_M2 = (TEXEL_MM / 1000) ** 2;
// The tables the GPU's stems read (wgsl/stems.ts): every SPECIES index's row, each row's form, most q and crop; a tree
// row's height in mm at every step of q, by the tree's mass read back to its height; and every row's crown's Q16 share
// of a texel at every step of height (flora.ts crownShare).
export function stemTables() {
  const rows = new Uint32Array(MAP + ROWS * ROW_WORDS), tables = new Uint32Array(TREE_ROWS * HQ + ROWS * HC);
  rows.fill(ROWS - 1, 0, MAP);
  STEM_ROWS.forEach((sp, r) => {
    rows[SPECIES.indexOf(sp)] = r;
    const tree = r < TREE_ROWS, at = MAP + r * ROW_WORDS, crop = CROP[sp];
    rows[at + RW.tree] = tree ? 1 : 0;
    rows[at + RW.qmax] = tree ? Math.min(QTOP - 1, Math.floor(treeKg(sp, TREE_MAX[sp]) ** 0.25 * 2 ** 20)) : LAID;
    rows[at + RW.each] = crop?.each ?? 0;
    rows[at + RW.area] = Math.round((crop?.m2 ?? 0) * TEXEL_M2);
    if (tree) {
      let h = 0;
      for (let i = 0; i < HQ; i++) {
        const m = ((i << QSTEP) / 2 ** 20) ** 4;
        let hi = 200;
        for (let k = 0; k < 50; k++) { const mid = (h + hi) / 2; if (treeKg(sp, mid) < m) h = mid; else hi = mid; }
        tables[r * HQ + i] = Math.round(h * 1000);
      }
    }
    for (let i = 0; i < HC; i++) tables[TREE_ROWS * HQ + r * HC + i] = Math.round((crownShare(sp, (i << SSTEP) / 1000) / TEXEL_M2) * 65536);
  });
  return { rows, tables };
}
// The stems' law (src/gpu/flora.ts), once a day at midnight: each day's coefficients for every cell and kind, from the
// cell's seasons drawn between their middles (as the young trees have them) and how well the ground suits each kind
// there, at the cell's centre [design: a stem's fit is its 75 m cell's].
// - A tree: c/4 times its place's net gain over the reference open ground's (openNet), at the year's pace, its q's
//   gain a day being alpha L - beta: alpha = c/4 fit made / ref, beta = c/4 kept / ref, in q's units (2^-20).
// - A bush: the plant rule's relative rate a day at the year's pace, a quarter of it for q: alpha = fit made YP / 4,
//   beta = kept YP / 4, in Q16.
// Both held under 2^16 (wgsl/stems.ts), which no day on the island reaches.
export function stemDriver(w: World): StemDriver {
  const g = groundOf(w.seed), { isle, fine } = g, NR = STEM_ROWS.length;
  // the cells holding stems, the only ones the law reads, each stem filed by its place in mm as the GPU files it
  // (gpu/flora.ts fieldsOf)
  const holds = new Uint8Array(N * N), f = g.flora, mm = (p: number) => Math.round(p * 1e4) * ((TILE_M * 1000) / 1e4), C = CELL * 1000;
  for (let k = 0; k < f.n; k++) {
    if (FLORA[f.kind[k]] !== "tree" && FLORA[f.kind[k]] !== "bush") continue;
    holds[Math.min(N - 1, Math.floor(mm(f.py[k]) / C)) * N + Math.min(N - 1, Math.floor(mm(f.px[k]) / C))] = 1;
  }
  const cells: number[] = [];
  holds.forEach((v, i) => { if (v) cells.push(i); });
  const fits = new Float32Array(N * N * NR);
  for (const i of cells) {
    const e = envAt(isle, fine.bilinear, START + (i % N) * CELL, START + Math.floor(i / N) * CELL, NaN, START);
    for (let r = 0; r < NR; r++) fits[i * NR + r] = fit(STEM_ROWS[r], e);
  }
  const part = YEARS_PACE / 365.25, coef = new Int32Array(N * N * ROWS * 2), most = 0xffff;
  // per row: alpha for a gram's making in full light at a perfect fit, made per unit of leaf area (so per FAO-56 p),
  // and beta for a gram's keeping; a tree kind the typical ground grows none of only loses (plant-constants sec. 9)
  const lost = STEM_ROWS.map((sp, r) => r < TREE_ROWS && openNet(w, sp) <= 0);
  const scale = STEM_ROWS.map((sp, r) => (r < TREE_ROWS ? ((GROWTH_C[sp] / 4) * part * 2 ** 20) / openNet(w, sp) : (YEARS_PACE / 4) * 65536));
  const ps = [...new Set(STEM_ROWS.map((sp) => pOf(sp)))], pAt = STEM_ROWS.map((sp) => ps.indexOf(pOf(sp)));
  const alphaK = STEM_ROWS.map((sp, r) => (lost[r] ? 0 : scale[r] * SLA[sp])), betaK = STEM_ROWS.map((_, r) => (lost[r] ? 0 : scale[r]));
  const betaLost = STEM_ROWS.map((sp, r) => (lost[r] ? Math.min(most, Math.round((GROWTH_C[sp] / 4) * part * 2 ** 20)) : 0));
  const perSla = new Float64Array(ps.length);
  return {
    due: (t) => t % DAY === 0,
    tables: stemTables,
    day(t) {
      const { s, f: x } = seasonAt(t), s2 = (s + 1) % 4, a = isle.seasons[s], b = isle.seasons[s2], wa = isle.soilWater[s], wb = isle.soilWater[s2];
      for (const i of cells) {
        const sun = a.sun[i] * (1 - x) + b.sun[i] * x, temp = a.temp[i] * (1 - x) + b.temp[i] * x, water = wa[i] * (1 - x) + wb[i] * x, kept = keptOf(temp);
        // what a gram makes is in proportion to its leaf area: worked out once for each share of water drawn first
        for (let p = 0; p < ps.length; p++) perSla[p] = madeOf(1, sun, temp, water, ps[p]);
        for (let r = 0; r < NR; r++) {
          coef[(i * ROWS + r) * 2] = Math.min(most, Math.round(alphaK[r] * fits[i * NR + r] * perSla[pAt[r]]));
          coef[(i * ROWS + r) * 2 + 1] = lost[r] ? betaLost[r] : Math.min(most, Math.round(betaK[r] * kept));
        }
      }
      const year = Math.floor(t / (DAY * YEAR_DAYS)), mast = STEM_ROWS.map((sp, r) => {
        rinit(w.seed, MAST_STREAM, r, year);
        return next32() < (CROP[sp]?.often ?? 0) * 2 ** 32 ? 1 : 0;
      });
      return { coef, mast };
    },
  };
}
