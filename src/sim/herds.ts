// Deer, rabbits and wolves as populations over the island's tiles (docs/research/animal-constants.md): how many there are
// on each tile and the fat each carries on average, run on energy. The ground grows forage by the plant rule; grazers eat
// it and burn their field metabolic rate; wolves kill deer by their functional response; the young come in their
// seasons by condition, and as many starve as a shortfall is worth in full reserves. The animals people see are the
// tiles' own, stood on the ground within sight of them (reveal): one killed or eaten is one fewer on its tile.
import { DAY, H, TILE_M, Tile, W, groundOf, tileAt, dryAt, type Animal, type AnimalSpecies, type World } from "./world";
import { CELL } from "../terrain/grid";
import { SIZE, START } from "../terrain/flora";
import { RUE, through, warmEnough, watered } from "../terrain/growth";
import { YEAR_DAYS, seasonAt } from "./sky";
// a herd's day is the year's 365.25 / YEAR_DAYS days of eating and burning, as a plant's is of growing (plants.ts YEARS_PACE)
const YEARS_PACE = 365.25 / YEAR_DAYS;
import { FOOD_KJ, PHYS } from "./fuel";
import { THING_MATERIAL } from "./materials";

export const HERDED = ["deer", "rabbit", "wolf"] as const;
export type Herded = (typeof HERDED)[number];
export const herded = (sp: AnimalSpecies): sp is Herded => (HERDED as readonly string[]).includes(sp);
// Per tile: the animals there and the mean fat reserve each carries, kJ; a deer tile's hinds pregnant since the rut.
export type Herd = { n: number[]; e: number[] };
// forage: the ground layer's standing dry matter a m2 of it, g, the open grass and the field layer under crowns; browse:
// the woody shoots' a m2 of theirs.
export type Herds = { forage: number[]; browse: number[]; deer: Herd & { preg: number[] }; rabbit: Herd; wolf: Herd; day: number };

// ---------- bodies (sec. 2) ----------
// Nagy's field metabolic rate for mammals, kJ a day, M in g.
const fmr = (kg: number) => 4.82 * (kg * 1000) ** 0.734;
const FAT_KJ = FOOD_KJ.fat;
// A carcass's meat and fat as butchered (materials.ts), kJ.
export const edible = (sp: Herded) => {
  const b = THING_MATERIAL[sp].breaks;
  return (b.meat ?? 0) * PHYS.meat.mass * PHYS.meat.kj! + (b.fat ?? 0) * PHYS.fat.mass * PHYS.fat.kj!;
};
type Spec = { kg: number; fmr: number; full: number; maxDM: number; move: number; die: number; reveal: number };
// Full reserves: the winter carcass fat and the gut and kidney fat (body-constants sec. 10), the wolf's as a deer's
// shares [design]. Most dry matter a day: a deer's (R363), a rabbit's 65 to 80 g a kg of it (R373). move: the share of a
// tile's animals that moves on in a day [design]. die: deaths a year besides hunger and wolves (R369, [UNVERIFIED]).
// reveal: how far off people see them standing, m [design].
export const SPEC: Record<Herded, Spec> = {
  deer: { kg: 116, fmr: fmr(116), full: (0.55 * 0.0655 + 0.0314) * 116 * FAT_KJ, maxDM: 3.4, move: 0.5, die: 1 / 12, reveal: 300 },
  rabbit: { kg: 1.6, fmr: fmr(1.6), full: (0.555 * 0.035 + 0.0314) * 1.6 * FAT_KJ, maxDM: 0.0725 * 1.6, move: 0.02, die: 1 / 2, reveal: 50 },
  wolf: { kg: 41.5, fmr: fmr(41.5), full: (0.55 * 0.0655 + 0.0314) * 41.5 * FAT_KJ, maxDM: 0, move: 1, die: 1 / 5, reveal: 300 },
};
// Forage's metabolisable energy, kJ/g DM (R362); what a sward intercepts of the sun [UNVERIFIED]; the most it stands at,
// g/m2 (R364); the share of shrubs' and trees' cover within a deer's reach, as browse, which a rabbit's is not [design].
const ME = 11, INTERCEPT = 0.8, MOST = 300, BROWSE = { shrub: 0.3, tree: 0.1 };
// The forage at which a grazer eats at half its most, g DM/m2: Mulder and Hendriks' grazing mammals, 4.9e4 m^0.20 kg/km2
// of wet vegetation over the ground, m in kg (R374), a quarter of it dry [UNVERIFIED].
const half = (kg: number) => 49 * kg ** 0.2 * 0.25;
// Messier: kills a wolf a day at most, and the density for half of that, moose-equivalents a km2, by biomass (sec. 6).
const KILL_MAX = 3.36 / 100, KILL_HALF = 0.46, MOOSE = 400, REACH = 3;
// Births (sec. 5): the island days (counted from 0) of the rut, calving and whelping, and of the rabbits' season: the
// real dates' days after the spring equinox, 20 March, at the year's pace, from the island's equinox in the middle of
// its spring (sky.ts).
const onDay = (realDays: number) => (YEAR_DAYS / 8 + realDays / YEARS_PACE) % YEAR_DAYS;
const RUT = onDay(219), CALVING = onDay(77), WHELPING = onDay(36), KITS_FROM = onDay(287), KITS_TO = onDay(164);
const LITTER = 5, LITTER_DAYS = 30, PUPS = 5.5, PACK = 4;
// The share of kits alive at a year old, which join the grown at birth (R375).
const KIT_YEAR = 0.083;
const TILE_KM2 = (TILE_M * TILE_M) / 1e6;

// ---------- the ground (sec. 3) ----------
// grass: the ground layer's share of a tile; lit: the share of the open sun its growth gets, the field layer's under a
// crown (growth.ts through); woody: browse's share.
// nb: each land tile's land neighbours, eight a tile, -1 where none; reach: the tiles in a wolf's reach round each.
type Ground = { land: number[]; grass: Float32Array; lit: Float32Array; woody: Float32Array; fed: Float32Array; sun: Float32Array[]; temp: Float32Array[]; water: Float32Array[]; nb: Int32Array; reach: Float64Array };
// The sums over the (2 REACH + 1)^2 tiles round each tile, clipped at the map's edge, by a summed-area table.
let table: Float64Array;
function box(src: ArrayLike<number>, out: Float64Array) {
  table ??= new Float64Array((W + 1) * (H + 1));
  for (let y = 0; y < H; y++) {
    let row = 0;
    for (let x = 0; x < W; x++) { row += src[y * W + x]; table[(y + 1) * (W + 1) + x + 1] = table[y * (W + 1) + x + 1] + row; }
  }
  for (let y = 0; y < H; y++) {
    const y0 = Math.max(0, y - REACH), y1 = Math.min(H, y + REACH + 1);
    for (let x = 0; x < W; x++) {
      const x0 = Math.max(0, x - REACH), x1 = Math.min(W, x + REACH + 1);
      out[y * W + x] = table[y1 * (W + 1) + x1] - table[y0 * (W + 1) + x1] - table[y1 * (W + 1) + x0] + table[y0 * (W + 1) + x0];
    }
  }
  return out;
}
const grounds = new WeakMap<World, Ground>();
function groundFor(w: World): Ground {
  let g = grounds.get(w);
  if (g) return g;
  const { isle, fine } = groundOf(w.seed), land: number[] = [];
  const grass = new Float32Array(W * H), lit = new Float32Array(W * H), woody = new Float32Array(W * H), fed = new Float32Array(W * H), sun = isle.seasons.map(() => new Float32Array(W * H)), temp = isle.seasons.map(() => new Float32Array(W * H)), water = isle.seasons.map(() => new Float32Array(W * H));
  for (let i = 0; i < W * H; i++) {
    if (tileAt(w, i % W, Math.floor(i / W)) === Tile.Water) continue;
    land.push(i);
    const mx = (i % W) * TILE_M + TILE_M / 2 - SIZE / 2, mz = Math.floor(i / W) * TILE_M + TILE_M / 2 - SIZE / 2;
    const open = fine.fine(fine.cover.grass, mx, mz), tree = fine.fine(fine.cover.tree, mx, mz), shrub = fine.fine(fine.cover.shrub, mx, mz);
    grass[i] = Math.min(1, open + tree + shrub);
    lit[i] = grass[i] > 0 ? (open + (tree + shrub) * through(1)) / grass[i] : 0;
    woody[i] = Math.min(1, BROWSE.shrub * shrub + BROWSE.tree * tree);
    const cx = (mx - START) / CELL, cy = (mz - START) / CELL;
    fed[i] = fine.bilinear(isle.fertility, cx, cy);
    isle.seasons.forEach((s, k) => { sun[k][i] = fine.bilinear(s.sun, cx, cy); temp[k][i] = fine.bilinear(s.temp, cx, cy); water[k][i] = fine.bilinear(isle.soilWater[k], cx, cy); });
  }
  const nb = new Int32Array(land.length * 8).fill(-1);
  land.forEach((i, k) => {
    let m = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const x = (i % W) + dx, y = Math.floor(i / W) + dy;
      if ((dx || dy) && x >= 0 && y >= 0 && x < W && y < H && tileAt(w, x, y) !== Tile.Water) nb[k * 8 + m++] = y * W + x;
    }
  });
  g = { land, grass, lit, woody, fed, sun, temp, water, nb, reach: box(new Float64Array(W * H).fill(1), new Float64Array(W * H)) };
  grounds.set(w, g);
  return g;
}

// ---------- a step ----------
// Working arrays, zeroed for each use.
const scratches: Float64Array[] = [];
const scratch = (k: number) => (scratches[k] ??= new Float64Array(W * H)).fill(0);
const crossed = (from: number, to: number, at: number) => (from <= to ? from < at && at <= to : from < at || at <= to);
// dt island days of the herds' lives, ending at tick t; skip: tiles whose wolves people can see, who kill as individuals.
export function stepHerds(w: World, hs: Herds, dt: number, t: number, skip?: Set<number>) {
  const g = groundFor(w), { s, f } = seasonAt(t), days = dt * YEARS_PACE, area = TILE_M * TILE_M;
  const s1 = (s + 1) % 4, sun0 = g.sun[s], sun1 = g.sun[s1], temp0 = g.temp[s], temp1 = g.temp[s1], water0 = g.water[s], water1 = g.water[s1];
  const D = SPEC.deer, R = SPEC.rabbit, deerHalf = half(D.kg), rabbitHalf = half(R.kg), deerMost = D.maxDM * 1000 * days, rabbitMost = R.maxDM * 1000 * days;
  const { deer, rabbit } = hs;
  for (const i of g.land) {
    // the grass and the browse grow, and the grazers eat them: rabbits the grass, deer both as they stand
    const sun = sun0[i] * (1 - f) + sun1[i] * f, temp = temp0[i] * (1 - f) + temp1[i] * f, water = water0[i] * (1 - f) + water1[i] * f;
    const grown = RUE * sun * INTERCEPT * warmEnough(temp) * watered(water) * g.fed[i] * days;
    hs.forage[i] = Math.min(MOST, hs.forage[i] + grown * g.lit[i] * (1 - hs.forage[i] / MOST));
    hs.browse[i] = Math.min(MOST, hs.browse[i] + grown * (1 - hs.browse[i] / MOST));
    const gs = hs.forage[i] * g.grass[i], bs = hs.browse[i] * g.woody[i], both = gs + bs;
    const deerAsk = deer.n[i] > 0 ? Math.max(0, Math.min(deerMost, (D.full - deer.e[i] + D.fmr * days) / ME)) * (both / (both + deerHalf)) : 0;
    const rabbitAsk = rabbit.n[i] > 0 ? Math.max(0, Math.min(rabbitMost, (R.full - rabbit.e[i] + R.fmr * days) / ME)) * (gs / (gs + rabbitHalf)) : 0;
    const deerGrass = both > 0 ? deerAsk * (gs / both) : 0, deerBrowse = deerAsk - deerGrass;
    const onGrass = deerGrass * hs.deer.n[i] + rabbitAsk * hs.rabbit.n[i], onBrowse = deerBrowse * hs.deer.n[i];
    const gScale = onGrass > gs * area ? (gs * area) / onGrass : 1, bScale = onBrowse > bs * area ? (bs * area) / onBrowse : 1;
    if (hs.deer.n[i] > 0) hs.deer.e[i] += (deerGrass * gScale + deerBrowse * bScale) * ME - SPEC.deer.fmr * days;
    if (hs.rabbit.n[i] > 0) hs.rabbit.e[i] += rabbitAsk * gScale * ME - SPEC.rabbit.fmr * days;
    if (g.grass[i] > 0) hs.forage[i] = Math.max(0, hs.forage[i] - (onGrass * gScale) / (area * g.grass[i]));
    if (g.woody[i] > 0) hs.browse[i] = Math.max(0, hs.browse[i] - (onBrowse * bScale) / (area * g.woody[i]));
  }
  // wolves kill deer in their reach, every tile's wolves at once: each takes its kills as a share of the deer round it,
  // and each tile's deer lose the shares of all the wolves that reach them
  const deerKj = edible("deer"), round = box(hs.deer.n, scratch(0)), rate = scratch(1);
  for (const i of g.land) {
    const wn = hs.wolf.n[i], deer = round[i];
    if (wn <= 0) continue;
    if (!skip?.has(i) && deer > 0) {
      const X = (deer * SPEC.deer.kg) / (g.reach[i] * TILE_KM2) / MOOSE, kills = Math.min(deer, (wn * KILL_MAX * X) / (KILL_HALF + X) * (MOOSE / SPEC.deer.kg) * days);
      rate[i] = kills / deer;
      hs.wolf.e[i] += (kills * deerKj) / wn;
    }
    hs.wolf.e[i] -= SPEC.wolf.fmr * days;
  }
  const taken = box(rate, scratch(2));
  for (const i of g.land) if (taken[i] > 0) hs.deer.n[i] *= Math.max(0, 1 - taken[i]);
  // hunger, the year's other deaths, and the young
  const before = hs.day, now = ((t / DAY) % YEAR_DAYS + YEAR_DAYS) % YEAR_DAYS;
  const rut = crossed(before, now, RUT), calving = crossed(before, now, CALVING), whelping = crossed(before, now, WHELPING);
  const kits = KITS_FROM > KITS_TO ? now >= KITS_FROM || now < KITS_TO : now >= KITS_FROM && now < KITS_TO;
  for (const sp of HERDED) {
    const h = hs[sp], k = SPEC[sp], keep = Math.exp(-(k.die * days) / 365.25);
    for (const i of g.land) {
      // too few to be worth the arithmetic (and below where doubles slow to a crawl) count as none
      if (h.n[i] <= 1e-9) { h.n[i] = 0; continue; }
      if (h.e[i] < 0) { h.n[i] = Math.max(0, h.n[i] * (1 + h.e[i] / k.full)); h.e[i] = 0; }
      h.e[i] = Math.min(k.full, h.e[i]);
      h.n[i] *= keep;
      const fit = h.e[i] / k.full;
      if (sp === "deer") {
        if (rut) hs.deer.preg[i] = (h.n[i] / 2) * Math.min(0.9, 0.25 + 0.65 * fit);
        if (calving) { h.n[i] += Math.min(hs.deer.preg[i], h.n[i] / 2); hs.deer.preg[i] = 0; }
      } else if (sp === "rabbit" && kits && fit > 0.5) h.n[i] += (h.n[i] / 2) * (LITTER / LITTER_DAYS) * KIT_YEAR * days;
      else if (sp === "wolf" && whelping) h.n[i] += (h.n[i] / PACK) * PUPS * fit;
    }
  }
  hs.day = now;
  // moving on to better ground: grazers to more forage a head (a deer eating as many rabbits' worth as its fill is to
  // theirs), wolves to more deer
  const deerEats = SPEC.deer.maxDM / SPEC.rabbit.maxDM;
  for (const sp of HERDED) {
    const h = hs[sp], share = Math.min(0.5, SPEC[sp].move * days), out = scratch(0), inn = scratch(1), kj = scratch(2), carried = scratch(3), pull = scratch(4);
    for (const j of g.land) pull[j] = sp === "wolf" ? hs.deer.n[j] : (hs.forage[j] * g.grass[j] + (sp === "deer" ? hs.browse[j] * g.woody[j] : 0)) / (1 + hs.deer.n[j] * deerEats + hs.rabbit.n[j]);
    for (let k = 0; k < g.land.length; k++) {
      const i = g.land[k];
      if (h.n[i] <= 0) continue;
      let best = -1, bv = pull[i];
      for (let m = k * 8; m < k * 8 + 8; m++) { const j = g.nb[m]; if (j < 0) break; if (pull[j] > bv) { bv = pull[j]; best = j; } }
      if (best < 0) continue;
      const m = h.n[i] * share;
      out[i] += m; inn[best] += m; kj[best] += m * h.e[i];
      // hinds carry their calves with them
      if (sp === "deer" && hs.deer.preg[i] > 0) { const p = hs.deer.preg[i] * share; hs.deer.preg[i] -= p; carried[best] += p; }
    }
    if (sp === "deer") for (const i of g.land) hs.deer.preg[i] += carried[i];
    for (const i of g.land) {
      if (!out[i] && !inn[i]) continue;
      const stay = Math.max(0, h.n[i] - out[i]);
      h.e[i] = stay + inn[i] > 0 ? (stay * h.e[i] + kj[i]) / (stay + inn[i]) : h.e[i];
      h.n[i] = stay + inn[i];
    }
  }
}

// ---------- the start (sec. 8) ----------
const blank = () => new Array<number>(W * H).fill(0);
export function startHerds(w: World, den: [number, number]): Herds {
  const g = groundFor(w), hs: Herds = { forage: blank(), browse: blank(), deer: { n: blank(), e: blank(), preg: blank() }, rabbit: { n: blank(), e: blank() }, wolf: { n: blank(), e: blank() }, day: 0 };
  for (const i of g.land) {
    hs.forage[i] = hs.browse[i] = MOST / 2;
    hs.deer.n[i] = 2 * TILE_KM2 * Math.min(1, g.grass[i] + g.woody[i]); hs.deer.e[i] = SPEC.deer.full / 2;
    hs.rabbit.n[i] = TILE_KM2 * 100 * g.grass[i]; hs.rabbit.e[i] = SPEC.rabbit.full / 2;
  }
  const d = Math.floor(den[1]) * W + Math.floor(den[0]);
  hs.wolf.n[d] = 3; hs.wolf.e[d] = SPEC.wolf.full / 2;
  // a day at a time, which the step's rates and shares hold to [derived: forage's logistic growth stays under half its
  // room a step]
  const STEP = 1, years = 20;
  // the same days of the year as the twenty before now, counted on from now so the clock never runs below nothing
  hs.day = ((w.t / DAY) % YEAR_DAYS + YEAR_DAYS) % YEAR_DAYS;
  for (let k = 1; k <= (years * YEAR_DAYS) / STEP; k++) stepHerds(w, hs, STEP, w.t + k * STEP * DAY);
  hs.day = ((w.t / DAY) % YEAR_DAYS + YEAR_DAYS) % YEAR_DAYS;
  for (const sp of HERDED) for (const i of g.land) hs[sp].n[i] = Math.round(hs[sp].n[i] * 1000) / 1000;
  return hs;
}

// ---------- showing them (sec. 8) ----------
const tileOf = (a: { px: number; py: number }) => Math.min(H - 1, Math.max(0, Math.floor(a.py))) * W + Math.min(W - 1, Math.max(0, Math.floor(a.px)));
// One of a tile's animals no longer about: killed, eaten, starved where it stood.
export function gone(w: World, an: Animal) {
  w.animals = w.animals.filter((x) => x !== an);
  if (herded(an.species) && w.herds) { const h = w.herds[an.species], i = tileOf(an); h.n[i] = Math.max(0, h.n[i] - 1); }
}
// An individual that walked onto another tile takes one of the count with it.
export function moved(w: World, an: Animal, x0: number, y0: number) {
  if (!herded(an.species) || !w.herds) return;
  const from = tileOf({ px: x0, py: y0 }), to = tileOf(an);
  if (from === to) return;
  const h = w.herds[an.species], m = Math.min(1, h.n[from]);
  h.n[from] -= m; h.e[to] = (h.e[to] * h.n[to] + h.e[from] * m) / Math.max(1e-9, h.n[to] + m); h.n[to] += m;
}
// How many of a kind stand within m metres of a place, counting the tiles' herds whether anyone sees them or not.
export function herdNear(w: World, sp: Herded, at: { px: number; py: number }, m: number) {
  if (!w.herds) return w.animals.filter((x) => x.species === sp && Math.hypot(x.px - at.px, x.py - at.py) * TILE_M <= m).length;
  const r = m / TILE_M, h = w.herds[sp];
  let n = 0;
  for (let y = Math.max(0, Math.floor(at.py - r)); y <= Math.min(H - 1, Math.floor(at.py + r)); y++)
    for (let x = Math.max(0, Math.floor(at.px - r)); x <= Math.min(W - 1, Math.floor(at.px + r)); x++) if (Math.hypot(x + 0.5 - at.px, y + 0.5 - at.py) <= r) n += h.n[y * W + x];
  return n;
}
// How many of each kind are alive: the herds' whole counts, whether anyone sees them or not, and the rest one by one.
export function census(w: World) {
  const count: Record<string, number> = {};
  for (const a of w.animals) if (a.hp > 0 && !(w.herds && herded(a.species))) count[a.species] = (count[a.species] ?? 0) + 1;
  if (w.herds) for (const sp of HERDED) count[sp] = Math.round(w.herds[sp].n.reduce((s, x) => s + x, 0));
  return count;
}
// Hunger as the people's side of the world reads it: a tile's reserve as a share of a full one, 0..100.
export const hungerOf = (w: World, an: Animal) => (herded(an.species) && w.herds ? (100 * w.herds[an.species].e[tileOf(an)]) / SPEC[an.species].full : an.hunger);
// Stand each tile's animals on the ground within sight of anyone awake, as whole animals, and take them back off it
// once no one sees them; spawn: how one is put down there. A tile shows the share of its count that stands on the part
// of it in sight (judged at K x K points over it).
const K = 4;
export function reveal(w: World, spawn: (sp: Herded, px: number, py: number) => Animal, rand = Math.random) {
  const hs = w.herds;
  if (!hs) return;
  const awake = w.agents.filter((a) => a.down <= w.t);
  for (const sp of HERDED) {
    const r = SPEC[sp].reveal / TILE_M, near = (x: number, y: number) => awake.some((a) => (a.px - x) ** 2 + (a.py - y) ** 2 <= r * r);
    // gone back to being their tile's count where no one sees them
    const out = new Set(w.animals.filter((an) => an.species === sp && an.state !== "trapped" && !near(an.px, an.py)));
    if (out.size) w.animals = w.animals.filter((x) => !out.has(x));
    const here = new Map<number, Animal[]>(), seen = new Set<number>();
    for (const an of w.animals) if (an.species === sp) { const i = tileOf(an), l = here.get(i); if (l) l.push(an); else here.set(i, [an]); }
    for (const a of awake) for (let y = Math.floor(a.py - r); y <= Math.floor(a.py + r); y++) for (let x = Math.floor(a.px - r); x <= Math.floor(a.px + r); x++) if (x >= 0 && y >= 0 && x < W && y < H) seen.add(y * W + x);
    for (const i of seen) {
      const pts: [number, number][] = [];
      for (let u = 0; u < K; u++) for (let v = 0; v < K; v++) { const px = (i % W) + (u + 0.5) / K, py = Math.floor(i / W) + (v + 0.5) / K; if (near(px, py) && dryAt(w, px, py)) pts.push([px, py]); }
      if (!pts.length) continue;
      const n = hs[sp].n[i], show = (n * pts.length) / (K * K), ans = here.get(i) ?? [];
      let have = ans.length;
      for (const an of ans) an.hunger = (100 * hs[sp].e[i]) / SPEC[sp].full;
      if (have > Math.ceil(n)) { const gone = new Set(ans.filter((an) => an.state !== "trapped").slice(0, have - Math.ceil(n))); w.animals = w.animals.filter((x) => !gone.has(x)); have -= gone.size; }
      const want = Math.floor(show) + (!ans.length && rand() < show - Math.floor(show) ? 1 : 0);
      for (let k = 0; have < want && k < 30; k++) {
        const [cx, cy] = pts[Math.floor(rand() * pts.length)], px = cx + (rand() - 0.5) / K, py = cy + (rand() - 0.5) / K;
        if (!dryAt(w, px, py) || !near(px, py)) continue;
        const an = spawn(sp, px, py);
        an.hunger = (100 * hs[sp].e[i]) / SPEC[sp].full;
        have++;
      }
    }
  }
}
