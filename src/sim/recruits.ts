// How the island's plants spread on their own (docs/research/plant-constants.md sec. 9): each kind sheds its year's seed,
// or sends up suckers or roots its canes, as it does, and what comes up grows on by the plant rule until it stands as
// tall as the smallest tree the ground lays down, or as a bush. Until then the young are counts, not things: so many of
// a kind and an age on each tile, in the open or under the crowns, each as heavy as the rest, thinned as they crowd
// one another. Only ground being looked at keeps them (space.ts): put back as it grew, it holds them as the generator
// already does.
import { DAY, H, TILE_M, W, YEAR_DAYS, dryAt, type Thing, type World } from "./world";
import { TALL } from "../terrain/flora";
import { keptOf, madeOf, through } from "../terrain/growth";
import { SEEDLINGS, YEARS_PACE, fitIn, seasonsHere } from "./plants";
import { seasonAt } from "./sky";
import { onTile, stockedTile } from "./space";
import { branchKg, stemKg, trunkOf } from "./mechanics";
import { crownRadius } from "./light";
import { onDay } from "./herds";

// So many young of a kind (sp, the niche they grow by) on a tile, in the open or under the crowns, each m g of dry matter
// and at most peak, come up on day born.
export type Cohort = { sp: string; n: number; m: number; peak: number; open: boolean; born: number };

// ---------- how big a young plant is ----------
// A young tree's mass at a height: Repola's stem and branches (mechanics.ts) on the stem the game's trees have at that
// height (fuel.ts), kg dry; and its height at a mass, read back off that.
const TREE_KINDS = ["pine", "oak", "ash", "aspen"] as const;
const treeKg = (sp: string, h: number) => { const d = trunkOf({ kind: "tree", species: sp, size: h }) * 100; return stemKg(d, h) + branchKg(d, h); };
const HEIGHTS = Array.from({ length: 400 }, (_, k) => 0.05 + k * 0.1);
const MASSES: Record<string, number[]> = Object.fromEntries(TREE_KINDS.map((sp) => [sp, HEIGHTS.map((h) => treeKg(sp, h) * 1000)]));
const heightOf = (sp: string, m: number) => {
  const ms = MASSES[sp];
  if (!ms) return BUSH_H;
  if (m <= ms[0]) return HEIGHTS[0] * (m / ms[0]) ** 0.25;
  let k = 1;
  while (k < ms.length - 1 && ms[k] < m) k++;
  return HEIGHTS[k - 1] + ((HEIGHTS[k] - HEIGHTS[k - 1]) * (m - ms[k - 1])) / (ms[k] - ms[k - 1]);
};
// A bramble crown as a bush stands (ecology.ts matured), m.
const BUSH_H = 0.9;
const crownArea = (sp: string, m: number) => Math.PI * crownRadius({ species: sp, size: heightOf(sp, m) }) ** 2;
// A young tree past a seedling's size grows as its mass to the 3/4 (Niklas and Enquist, R469), dM/dt = c M^(3/4): c for
// each kind is what takes one from a seedling come up (plants.ts SEEDLINGS) to its height in British yield tables at
// 20 years from planting, 2 to 4 years after the seed (R470), with three added: Scots pine 7.5 m (yield class 100) and
// oak 7.8 m (yield class 60, Bradley et al.), ash 11.4 m planted on grassland in Ireland (Wellock et al.); aspen's
// suckers 11.4 m at 20 years old in Sweden (site index 20, Johansson) [derived]. That's in the open on ground that
// suits it; elsewhere it grows as the plant rule's net gain there stands to that on the island's typical open ground at a
// perfect fit (reference), which shade or a poor fit can take below nothing, starving it.
// The open, best-fitting ground c holds for: the island's own land in its typical year, the net gain of a gram of each
// kind there day by day over a year, averaged over the land (a sample of every 61st land tile) [derived].
const refs = new WeakMap<World, Record<string, number>>();
const netOn = (sp: string, here: ReturnType<typeof seasonsHere>, fit: number, light: number, t: number) => {
  const { s, f } = seasonAt(t), mix = (a: number[]) => a[s] * (1 - f) + a[(s + 1) % 4] * f, k = SEEDLINGS[sp];
  return fit * madeOf(k.sla, mix(here.sun) * light, mix(here.temp), mix(here.water)) - keptOf(mix(here.temp));
};
function reference(w: World, sp: string) {
  let got = refs.get(w);
  if (!got) refs.set(w, (got = {}));
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
const AT: Record<string, [number, number]> = { pine: [7.5, 23], oak: [7.8, 23], ash: [11.4, 23], aspen: [11.41, 20] };
const C: Record<string, number> = Object.fromEntries(TREE_KINDS.map((sp) => { const [h, yr] = AT[sp]; return [sp, (4 * (treeKg(sp, h) ** 0.25 - (SEEDLINGS[sp].up / 1000) ** 0.25)) / (yr - 1)]; }));
// Young trees stand up as trees once as tall as the ground's own of their kind there, as the generator lays them down
// (flora.ts: TALL by the spot's fit, its spread's middle) [derived]; brambles as bushes in their second summer, when
// their canes first fruit (Agriculture Victoria, R466), once come up.
const standHeight = (sp: string, fit: number) => TALL[sp as keyof typeof TALL] * Math.max(0.45, Math.min(1.2, 0.45 + 0.75 * fit)) * 0.975;
const BRAMBLE_YEARS = 2;

// ---------- browsing ----------
// Red deer browse to 1.8 m and rabbits to 0.54 m (Forestry Commission, R471). The share of Scots pine saplings browsed a
// year: under 15% below 2 deer a km2, 30% at 10 and 80% at 20 (Palmer and Truscott, R472), along those points; of the
// browsed, 50 to 70% died, of the unbrowsed 15 to 20% (Brooker et al., R473), so a browsing kills (60 - 17.5) / 82.5
// [derived]. Rabbits at 11.7 a ha left 26% of oak transplants alive in a year where 85% lived fenced (Bakker et al.,
// R474): a kill of 1 - 26/85 at that density, growing as 1 - e^(-R / R0) [derived]. What they eat feeds them [gap].
const DEER_REACH = 1.8, RABBIT_REACH = 0.54, BROWSE_KILL = (0.6 - 0.175) / 0.825, RABBIT_R0 = 11.7 / Math.log(85 / 26);
const browsed = (d: number) => (d <= 2 ? 0.15 * (d / 2) : d <= 10 ? 0.15 + (0.15 * (d - 2)) / 8 : Math.min(1, 0.3 + (0.5 * (d - 10)) / 10));

// ---------- what each kind puts out ----------
// Real days after the spring equinox at the year's pace (herds.ts onDay); emerging: the days they come up.
// Scots pine: 12,000 seeds a tree in a good year at 50 to 70% viable, good years 13 of 19 (Nixon and Worrell, R455); of
// seed sown on unprepared ground 6.5% stood as seedlings over the next seasons (Lariviere et al., R457); shed April to
// July and coming up within two weeks above 10 C (R455), so mid May [derived]; 80% within 20 m of a 20 m tree, falling
// off exponentially (R455), as far as the tree is tall [derived].
const PINE_EACH = 12000 * (13 / 19) * 0.6 * 0.065, PINE_DAY = onDay(57), PINE_REACH = 20 / Math.log(5) / 20;
// Ash: up to 140,000 fruits a tree in a mast year, masts every 2 to 5 years (Thomas, R458); seedlings 1.1 to 24.5% of the
// fruit two years before (Tapper, R458), their geometric middle; coming up mid April to the end of May in their second
// spring (R458), so early May [derived]; where its seedlings stood from their mothers by parentage, an exponential-power
// kernel of mean 39.1 m and shape 2.085 (Semizer-Cuming et al., R459).
const ASH_EACH = (140000 / 3.5) * Math.sqrt(0.011 * 0.245), ASH_DAY = onDay(49), ASH_MEAN = 39.1, ASH_SHAPE = 2.085;
// Oak: of the acorns lying at the end of the fall (ecology.ts acornCrop), mice cache 2% that no one finds again (sessile
// oak, Bogdziewicz et al., R461) and 66 to 71% of those buried come up (Zwolak et al., R462), an acorn weighing 1 to 6 g
// (R462), 3.5; in May and June (R460), so June 1 [derived]; seedlings from their mothers in the open, a median 25.9 m and
// a 95th percentile 116 m (Gerzabek et al., R460), as a lognormal [derived]. What the jays cache and leave [gap].
const OAK_SHARE = 0.02 * 0.685, ACORN_KG = 0.0035, OAK_DAY = onDay(73), OAK_MU = Math.log(25.9), OAK_SIGMA = (Math.log(116) - Math.log(25.9)) / 1.645;
// Bramble: daughters rooted at the tips of arching canes 3.3 m out on average, in autumn (Amor, R466), so October 1; as
// many a year as fenced thickets grew in Dutch pine stands with no deer, 4,085 a ha from 434 in ten years (Kuiters and
// Slim, R475), 25% a year [derived]; and under 0.4 seedlings a m2 near thickets (R466), here a m2 of its crown, in
// spring, so April 20 [derived], birds dropping the seed most within 50 m and nearly all within 100 m (R468), an
// exponential [derived].
const CANES = 0.25, CANE_REACH = 3.3, DAUGHTER_DAY = onDay(195), BRAMBLE_SEEDLINGS = 0.4, BRAMBLE_DAY = onDay(31), BIRD_MEAN = 100 / Math.log(20);
// Aspen: felled or burned, it sends up suckers from its surface roots as far as 40 m out (Jobling, R463), 50,000 to
// 100,000 a ha after a clear-cut in hybrid and quaking aspen (R464), the middle; each some 4.2 g weeks in (Johansson and
// Lundh, R465). Its seed seldom comes up at all [gap].
const SUCKER_REACH = 40, SUCKERS_HA = 75000, SUCKER_G = 4.2;

// ---------- chance ----------
const gauss = () => Math.sqrt(-2 * Math.log(1 - Math.random())) * Math.cos(2 * Math.PI * Math.random());
const poisson = (mean: number) => {
  if (mean <= 0) return 0;
  if (mean > 30) return Math.max(0, Math.round(mean + Math.sqrt(mean) * gauss()));
  let k = 0, p = Math.exp(-mean), s = p;
  const u = Math.random();
  while (u > s) { k++; p *= mean / k; s += p; }
  return k;
};
// A gamma variate (Marsaglia and Tsang), for the exponential-power kernel.
function gamma(a: number): number {
  if (a < 1) return gamma(a + 1) * Math.random() ** (1 / a);
  const d = a - 1 / 3, c = 1 / Math.sqrt(9 * d);
  for (;;) {
    const x = gauss(), v = (1 + c * x) ** 3;
    if (v > 0 && Math.log(1 - Math.random()) < 0.5 * x * x + d - d * v + d * Math.log(v)) return d * v;
  }
}
const lnGamma = (z: number): number => {
  const g = [676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  if (z < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * z)) - lnGamma(1 - z);
  z -= 1;
  let x = 0.99999999999980993;
  g.forEach((c, i) => (x += c / (z + i + 1)));
  const t = z + g.length - 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
};
// The exponential-power kernel's scale for its mean distance (a 2D kernel's mean is a G(3/b)/G(2/b)).
const ASH_SCALE = ASH_MEAN * Math.exp(lnGamma(2 / ASH_SHAPE) - lnGamma(3 / ASH_SHAPE));

// ---------- the ground ----------
const AREA = TILE_M * TILE_M, TILE_KM2 = AREA / 1e6, TILE_HA = AREA / 1e4;
const centre = (i: number) => ({ px: (i % W) + 0.5, py: Math.floor(i / W) + 0.5 });
// The share of a tile under the crowns of the trees standing on it.
const coverOf = (w: World, i: number) => { let a = 0; for (const t of onTile(w, i, "tree")) a += Math.PI * crownRadius(t) ** 2; return Math.min(1, a / AREA); };
// Whether a point stands under a crown, by the trees on its tile and those round it.
function shaded(w: World, px: number, py: number) {
  const x0 = Math.floor(px), y0 = Math.floor(py);
  for (let y = y0 - 1; y <= y0 + 1; y++) for (let x = x0 - 1; x <= x0 + 1; x++) {
    if (x < 0 || y < 0 || x >= W || y >= H) continue;
    for (const t of onTile(w, y * W + x, "tree")) if (Math.hypot(t.px - px, t.py - py) * TILE_M < crownRadius(t)) return true;
  }
  return false;
}
// The light a young plant gets: all of it in the open, what one crown lets through under them, as the field layer has it
// (growth.ts through).
const LIGHT = { open: 1, under: through(1) };

// ---------- putting them down ----------
// n young of a kind scattered from a point, each dist meters off in any direction, each m g; those landing on ground no
// one's looking at, or in water, are no more (the ground as it grew already holds its own young), the rest joining their
// tile's cohort of that kind, place and day, in the open or under the crowns as they fall.
function scatter(w: World, from: { px: number; py: number }, sp: string, n: number, dist: () => number, m: number) {
  const bins = new Map<string, number>(), covers = new Map<number, number>();
  for (let k = 0; k < n; k++) {
    const a = Math.random() * 2 * Math.PI, d = dist() / TILE_M, px = from.px + Math.cos(a) * d, py = from.py + Math.sin(a) * d;
    if (px < 0 || py < 0 || px >= W || py >= H) continue;
    const i = Math.floor(py) * W + Math.floor(px);
    if (!stockedTile(w, i) || !dryAt(w, px, py)) continue;
    let c = covers.get(i);
    if (c === undefined) covers.set(i, (c = coverOf(w, i)));
    const key = `${i}|${Math.random() >= c ? 1 : 0}`;
    bins.set(key, (bins.get(key) ?? 0) + 1);
  }
  const all = (w.recruits ??= {});
  for (const [key, count] of bins) {
    const [i, open] = key.split("|").map(Number), list = (all[i] ??= []);
    const same = list.find((c) => c.sp === sp && c.open === !!open && c.born === w.t && c.m === m);
    if (same) same.n += count; else list.push({ sp, n: count, m, peak: m, open: !!open, born: w.t });
  }
}
// A felled or burned aspen's suckers, round its stump.
export function suckers(w: World, stump: Thing) {
  scatter(w, stump, "aspen", poisson((SUCKERS_HA * Math.PI * SUCKER_REACH ** 2) / 1e4), () => SUCKER_REACH * Math.sqrt(Math.random()), SUCKER_G);
}

// ---------- the year ----------
const crossed = (from: number, to: number, at: number) => (from <= to ? from < at && at <= to : from < at || at <= to);
const dayOf = (t: number) => (((t / DAY) % YEAR_DAYS) + YEAR_DAYS) % YEAR_DAYS;
// Once a day: the parents on ground being looked at put out their young on their kinds' days; every young plant grows a
// day as the plant rule has it in its place's light, dies once it has burned down to half the most it weighed, and is
// thinned, the smallest first, until all their crowns fit their place; and those grown tall enough stand up as things
// (make: a tree of a kind or a bramble bush, as ecology.ts makes them, if there's room at the spot).
export function recruit(w: World, acorns: (t: Thing) => number, make: (sp: string, px: number, py: number, h: number) => boolean) {
  const all = (w.recruits ??= {}), today = dayOf(w.t), yesterday = dayOf(w.t - DAY);
  for (const k of Object.keys(all)) if (!stockedTile(w, Number(k))) delete all[Number(k)];
  const due = (at: number) => crossed(yesterday, today, at);
  if (due(PINE_DAY) || due(ASH_DAY) || due(OAK_DAY) || due(BRAMBLE_DAY) || due(DAUGHTER_DAY))
    for (const t of [...w.things]) {
      if (!stockedTile(w, t.y * W + t.x) || t.bed) continue;
      if (t.kind === "tree" && t.species === "pine" && due(PINE_DAY)) {
        const reach = PINE_REACH * t.size;
        scatter(w, t, "pine", poisson(PINE_EACH), () => -reach * Math.log(1 - Math.random()), SEEDLINGS.pine.seed);
      } else if (t.kind === "tree" && t.species === "ash" && due(ASH_DAY)) {
        scatter(w, t, "ash", poisson(ASH_EACH), () => ASH_SCALE * gamma(2 / ASH_SHAPE) ** (1 / ASH_SHAPE), SEEDLINGS.ash.seed);
      } else if (t.kind === "tree" && t.species === "oak" && due(OAK_DAY)) {
        scatter(w, t, "oak", poisson(((acorns(t) * 0.05) / ACORN_KG) * OAK_SHARE), () => Math.exp(OAK_MU + OAK_SIGMA * gauss()), SEEDLINGS.oak.seed);
      } else if (t.kind === "bush" && t.species === "berry") {
        if (due(BRAMBLE_DAY)) scatter(w, t, "berry", poisson(BRAMBLE_SEEDLINGS * Math.PI * (t.size / 2) ** 2), () => -BIRD_MEAN * Math.log(1 - Math.random()), SEEDLINGS.berry.seed);
        if (due(DAUGHTER_DAY)) scatter(w, t, "berry", poisson(CANES), () => CANE_REACH, SEEDLINGS.berry.up);
      }
    }
  const { s, f } = seasonAt(w.t), mix = (a: number[]) => a[s] * (1 - f) + a[(s + 1) % 4] * f;
  for (const k of Object.keys(all)) {
    const i = Number(k), list = all[i], { px, py } = centre(i), here = seasonsHere(w, px, py);
    const sun = mix(here.sun), temp = mix(here.temp), water = mix(here.water), fits = new Map<string, number>();
    // a day's growth (or loss) of each: a seedling's by the plant rule, a young tree's as its mass to the 3/4 by how its
    // place does against the open on the best ground; and what the deer and rabbits on the tile take of those in reach
    const deer = w.herds ? w.herds.deer.n[i] / TILE_KM2 : 0, rabbits = w.herds ? w.herds.rabbit.n[i] / TILE_HA : 0;
    const killDeer = BROWSE_KILL * browsed(deer), killRabbits = 1 - Math.exp(-rabbits / RABBIT_R0), part = YEARS_PACE / 365.25;
    for (const c of list) {
      const light = c.open ? LIGHT.open : LIGHT.under, key = `${c.sp}|${c.open}`, k2 = SEEDLINGS[c.sp];
      let fit = fits.get(key);
      if (fit === undefined) fits.set(key, (fit = fitIn(w, c.sp, px, py, light)));
      const net = fit * madeOf(k2.sla, sun * light, temp, water) - keptOf(temp);
      if (c.m < k2.up || !C[c.sp]) c.m = Math.max(0, Math.min(C[c.sp] ? Infinity : k2.up, c.m + c.m * net * YEARS_PACE));
      else {
        // where the island's typical ground grows none of a kind, it only keeps or loses what it has
        const ref = reference(w, c.sp), vs = ref > 0 ? net / ref : net < 0 ? -1 : 0;
        c.m = Math.max(0, c.m + C[c.sp] * (c.m / 1000) ** 0.75 * 1000 * vs * part);
      }
      c.peak = Math.max(c.peak, c.m);
      const h = heightOf(c.sp, c.m), kill = 1 - (1 - (h < DEER_REACH ? killDeer : 0)) * (1 - (h < RABBIT_REACH ? killRabbits : 0));
      if (kill > 0) c.n *= (1 - kill) ** part;
    }
    // those starved to half their best die, and the crowded are thinned, the smallest first, to their place's room
    const cover = coverOf(w, i);
    for (const open of [true, false]) {
      const room = AREA * (open ? 1 - cover : cover), here2 = list.filter((c) => c.open === open && c.m > c.peak / 2).sort((a, b) => b.m - a.m);
      let used = 0;
      for (const c of here2) {
        const each = crownArea(c.sp, c.m), fits2 = Math.max(0, Math.floor((room - used) / each));
        if (c.n > fits2) c.n = fits2;
        used += c.n * each;
      }
    }
    // the grown stand up as things where there's room for them in their place; the rest find none
    for (const c of list) {
      if (c.n < 1 || c.m <= c.peak / 2) continue;
      const h = heightOf(c.sp, c.m);
      if (C[c.sp] ? h < standHeight(c.sp, fitIn(w, c.sp, px, py, 1)) : c.m < SEEDLINGS[c.sp].up || w.t - c.born < BRAMBLE_YEARS * YEAR_DAYS * DAY) continue;
      for (let k = 0, placed = 0; placed < c.n && k < c.n * 20; k++) {
        const qx = Math.floor(i % W) + Math.random(), qy = Math.floor(i / W) + Math.random();
        if (!dryAt(w, qx, qy) || shaded(w, qx, qy) === c.open) continue;
        if (make(c.sp, qx, qy, h)) placed++;
      }
      c.n = 0;
    }
    all[i] = list.filter((c) => c.n >= 1 && c.m > c.peak / 2);
    if (!all[i].length) delete all[i];
  }
}
