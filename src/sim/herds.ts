// Deer, rabbits, wolves and foxes as populations over the island's tiles (docs/research/animal-constants.md): how many there are
// on each tile and the fat each carries on average, run on energy. The ground grows forage by the plant rule; grazers eat
// it and burn their field metabolic rate; wolves kill deer and rabbits, and foxes rabbits, by their functional responses; the young come in their
// seasons by condition, and as many starve as a shortfall is worth in full reserves. The animals people see are the
// tiles' own, stood on the ground within sight of them (reveal): one killed or eaten is one fewer on its tile.
import { DAY, H, TILE_M, Tile, W, groundOf, tileAt, dryAt, type Animal, type AnimalSpecies, type World } from "./world";
import { CELL } from "../terrain/grid";
import { SIZE, START } from "../terrain/flora";
import { GREEN_UP, RUE, through, warmEnough, watered } from "../terrain/growth";
import { NICHE, envAt, fit } from "../terrain/niche";
import { YEAR_DAYS, daylight, seasonAt } from "./sky";
// a herd's day is the year's 365.25 / YEAR_DAYS days of eating and burning, as a plant's is of growing (plants.ts YEARS_PACE)
const YEARS_PACE = 365.25 / YEAR_DAYS;
import { FOOD_KJ } from "./fuel";

export const HERDED = ["deer", "rabbit", "wolf", "fox"] as const;
export type Herded = (typeof HERDED)[number];
export const herded = (sp: AnimalSpecies): sp is Herded => (HERDED as readonly string[]).includes(sp);
// Per tile: the animals there and the mean fat reserve each carries, kJ; a deer tile's hinds pregnant since the rut.
export type Herd = { n: number[]; e: number[] };
// forage: the ground layer's green standing dry matter a m2 of it, g, the open grass and the field layer under crowns;
// browse: the woody shoots' green a m2 of theirs; forageDead, browseDead: what has died and still stands.
export type Herds = { forage: number[]; browse: number[]; forageDead: number[]; browseDead: number[]; deer: Herd & { preg: number[] }; rabbit: Herd; wolf: Herd; fox: Herd; day: number };

// ---------- bodies (sec. 2) ----------
// Nagy's field metabolic rate for mammals, kJ a day, M in g.
const fmr = (kg: number) => 4.82 * (kg * 1000) ** 0.734;
const FAT_KJ = FOOD_KJ.fat;
// What a predator takes from a kill it eats, kJ: the whole carcass's gross energy, a rabbit's 21.9 kJ a g of dry matter
// (R385) at its 17.8% dry matter (R386), of which a carnivore keeps 79%, as weasels fed rabbit do (R387); every prey
// taken as made like a rabbit [derived].
const PREY_KJ_G = 21.9 * 0.178 * 0.79;
export const meal = (sp: Herded) => SPEC[sp].kg * 1000 * PREY_KJ_G;
type Spec = { kg: number; fmr: number; full: number; maxDM: number; move: number; die: number; reveal: number };
// Full reserves: the winter carcass fat and the gut and kidney fat (body-constants sec. 10), the wolf's as a deer's
// shares [design]. Most dry matter a day: a deer's (R363), a rabbit's 65 to 80 g a kg of it (R373). move: the share of a
// tile's animals that moves on in a day [design]. die: deaths a year besides hunger and wolves (R369, [UNVERIFIED]).
// reveal: how far off people see them standing, m [design].
// Of Britain's 425,000 fox deaths a year, 100,000 on the roads and 80,000 shot (R384): the rest's share, by which the
// deaths measured among people's foxes are taken down to an island's with neither [derived].
const FOX_WILD = 1 - 180 / 425;
export const SPEC: Record<Herded, Spec> = {
  deer: { kg: 116, fmr: fmr(116), full: (0.55 * 0.0655 + 0.0314) * 116 * FAT_KJ, maxDM: 3.4, move: 0.5, die: 1 / 12, reveal: 300 },
  rabbit: { kg: 1.6, fmr: fmr(1.6), full: (0.555 * 0.035 + 0.0314) * 1.6 * FAT_KJ, maxDM: 0.0725 * 1.6, move: 0.02, die: 1 / 2, reveal: 50 },
  wolf: { kg: 41.5, fmr: fmr(41.5), full: (0.55 * 0.0655 + 0.0314) * 41.5 * FAT_KJ, maxDM: 0, move: 1, die: 1 / 5, reveal: 300 },
  // a red fox: Britain's dog and vixen, 6.5 and 5.5 kg (R382); Bristol's grown foxes' deaths, half of them in a year,
  // at the share of Britain's fox deaths that are neither cars' nor guns' (FOX_WILD)
  fox: { kg: 6, fmr: fmr(6), full: (0.55 * 0.0655 + 0.0314) * 6 * FAT_KJ, maxDM: 0, move: 1, die: Math.LN2 * FOX_WILD, reveal: 150 },
};
// Forage's metabolisable energy, kJ/g DM (R362); what a sward intercepts of the sun [UNVERIFIED]; the most it stands at,
// g/m2 (R364); the share of shrubs' and trees' cover within a deer's reach, as browse, which a rabbit's is not [design].
const ME = 11, INTERCEPT = 0.8, MOST = 300, BROWSE = { shrub: 0.3, tree: 0.1 };
// A grazed temperate sward's leaves live 400 to 520 degree-days over 4 C (R392); dead ones are under 45% digestible,
// where green is over 65% (R393), each point of digestibility 0.16 MJ/kg of metabolisable energy (R394): dead's 7.2 kJ/g
// against green's 11; litter loses 0.33 to 0.5% of its mass a day (R395) [UNVERIFIED: a tropical grass's litter].
const LEAF_DD = 460, LEAF_BASE = 4, ME_DEAD = 0.16 * 45, DECAY = 0.004;
// A ruminant's rumen holds a day's fibre (NDF) of 1.2% of its weight (Mertens, R399): grazed green grass is 30 to 40%
// NDF (R400), mature grass over 65% and straw up to 80% (R401), dead standing stuff taken at 70% [derived]. So a deer
// eats 3.5 kg a day of green, its measured most (R363), and 2 kg of dead. A rabbit passes fibre through fast and eats
// to its own most [derived].
const RUMEN = 0.012, NDF_GREEN = 0.4, NDF_DEAD = 0.7;
// Rabbits graze from their warrens, the grazing heaviest within 50 m of them (R405) and most of it within 10 m of a
// refuge (R406), so a tile's rabbits reach only the share of its ground a warren can be dug in: soil over the water table
// and the bedrock deep enough for the tunnels, which lie 0.3 to 0.75 m down in heavy soils (R407) with nearly all the
// chambers within 0.55 m (R408), from none at 0.3 m to all of it at 0.55 [derived].
const WARREN = [0.3, 0.55];
// Snow: a season's snowpack (climate.ts, mm of water) stands as deep as Sturm et al.'s maritime snow is dense on the
// season's middle day of the year, (0.5979 - 0.2578)(1 - e^(-0.0010 h - 0.0038 doy)) + 0.2578 g/cm3, h in cm and doy from
// 1 January (R409); summer's at its most. Red deer herds start to leave once it lies 20 to 30 cm deep (R410), and 60 to
// 70 cm stops them (R413): the ground layer under it goes out of reach of deer and rabbits alike from 25 cm to 65
// [derived]; the browse stands above it.
const SNOW_DOY = [105, NaN, -77, 15], SNOW_REACH = [0.25, 0.65];
// The crowns hold up to 60% of the snow off the ground under a forest (R412), as the tile's trees cover it [derived].
const INTERCEPT_SNOW = 0.6;
function snowDepth(swe: number, doy: number) {
  if (swe <= 0) return 0;
  let h = swe / 10 / 0.3;
  for (let k = 0; k < 6; k++) { const rho = Number.isNaN(doy) ? 0.5979 : (0.5979 - 0.2578) * (1 - Math.exp(-0.001 * h - 0.0038 * doy)) + 0.2578; h = swe / 10 / rho; }
  return h / 100;
}
// How far a deer walks a day, 3.2 to 9.7 km (R411), the least of it taken as how far a herd shifts its ground [derived];
// it looks along eight bearings out to that far for where it would feed best.
const DEER_WALK = 3200;
const BEARINGS = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];
// What a gram of each woody plant's green browse is worth, kJ, in the growing season and out of it, at 0.16 MJ/kg a point
// of digestibility (R394): deciduous leaves as green grass's, their twigs after leaf fall as dead stuff (R396); heather's
// shoots 55.9% digestible in July and 41.9% in March (R397); gorse taken as heather [UNVERIFIED]; pine's 56%, low in
// every season (R396); bramble's evergreen leaves as green grass's, unchanging through the year (R396). Evergreens keep
// their leaves through the winter; the rest drop them.
const BROWSE_ME: Record<string, { summer: number; winter: number; evergreen: boolean }> = {
  oak: { summer: ME, winter: ME_DEAD, evergreen: false }, ash: { summer: ME, winter: ME_DEAD, evergreen: false }, aspen: { summer: ME, winter: ME_DEAD, evergreen: false },
  hazel: { summer: ME, winter: ME_DEAD, evergreen: false }, pine: { summer: 0.16 * 56, winter: 0.16 * 56, evergreen: true },
  berry: { summer: ME, winter: ME, evergreen: true }, heather: { summer: 0.16 * 55.9, winter: 0.16 * 41.9, evergreen: true },
  gorse: { summer: 0.16 * 55.9, winter: 0.16 * 41.9, evergreen: true },
};
const TREES = ["pine", "oak", "ash", "aspen"], SHRUBS = ["berry", "hazel", "heather", "gorse"];
// A pack of four loses a share of each deer it kills to ravens before it has eaten it: a pair 37%, a pack of six 17%
// (R398), between them for four [derived]; a rabbit is eaten whole at once.
const RAVENS = 0.37 + ((0.17 - 0.37) * (4 - 2)) / (6 - 2);
// The broadleaves' browse stands bare, its leaves fallen and only twigs left, while the growing season index is under
// green-up, as the game's broadleaves do (wetness.ts leafless): its cold ramp, which warmEnough is, and its daylight
// ramp from 10 h to 11 h; the rain and the dry air left out, the soil's water standing for them in the growth [derived].
// The forage at which a grazer eats at half its most, g DM/m2: Mulder and Hendriks' grazing mammals, 4.9e4 m^0.20 kg/km2
// of wet vegetation over the ground, m in kg (R374), a quarter of it dry [UNVERIFIED].
const half = (kg: number) => 49 * kg ** 0.2 * 0.25;
// Messier: kills a wolf a day at most, and the density for half of that, moose-equivalents a km2, taken on all the prey's
// biomass, deer and rabbits alike (sec. 6).
const KILL_MAX = 3.36 / 100, KILL_HALF = 0.46, MOOSE = 400;
// A wolf runs down a rabbit a chase at a time, no more of them a day than coyotes kill snowshoe hares at most, 2.3
// (O'Donoghue et al., R404) [derived: a canid on a lagomorph of a rabbit's size].
const RABBIT_CHASES = 2.3;
// How far a predator hunts from where it is, tiles either side: a square as big as a pack's territory, Bialowieza's
// 201 km2 on average (R402), and a rural fox's, 200 to 600 ha (R403), 4 km2 [derived].
const WOLF_REACH = Math.round((Math.sqrt(201 / ((TILE_M * TILE_M) / 1e6)) - 1) / 2), FOX_REACH = Math.round((Math.sqrt(4 / ((TILE_M * TILE_M) / 1e6)) - 1) / 2);
// Pech et al.'s foxes on rabbits, as Pech and Hood fitted it: a fox eats at most 100.01 kg of rabbit a quarter of a
// year, on a Type III response with its inflection at 1.32 rabbits a ha (R383).
const FOX_MOST = 100.01 / (365.25 / 4), FOX_INFLECT = 1.32, TILE_HA = (TILE_M * TILE_M) / 1e4;
// A grown wolf's chance of living the year at a density of d wolves a 1000 km2, by strife among packs: Cubaynes et al.'s
// Northern Range survival, 0.55 to 0.92 over 20 to 99 wolves, below 0.7 above 65 (R381), as a line [derived]; no
// better than the year's other deaths allow where wolves are few.
const wolfSurvival = (d: number) => Math.max(0.01, Math.min(Math.exp(-SPEC.wolf.die), 1.018 - 0.00489 * d));
// Births (sec. 5): the island days (counted from 0) of the rut, calving and whelping, and of the rabbits' season: the
// real dates' days after the spring equinox, 20 March, at the year's pace, from the island's equinox in the middle of
// its spring (sky.ts).
const onDay = (realDays: number) => (YEAR_DAYS / 8 + realDays / YEARS_PACE) % YEAR_DAYS;
const RUT = onDay(219), CALVING = onDay(77), WHELPING = onDay(36), CUBBING = onDay(-5), KITS_FROM = onDay(287), KITS_TO = onDay(164);
const LITTER = 5, LITTER_DAYS = 30, PUPS = 5.5, PACK = 4;
// The share of kits that live to be grown with no predators about, the predators here taking theirs themselves: 18% of
// those that came above ground where predators were kept down (R388), of the 71% of litters not drowned in the burrow
// (R389) [derived]. They join the grown at birth.
const KIT_YEAR = 0.18 * (1 - 0.29);
// The share of wolf pups alive at a year old, in Voyageurs, where wolves live on deer (R368), joining the grown at birth.
const PUP_YEAR = 0.29;
// A vixen's litter, about five, born in March (R382); the share of cubs that live to be grown, Bristol's 39% (R384) with
// only the wild share of the deaths (FOX_WILD) [derived].
const CUBS = 5, CUB_YEAR = Math.exp(Math.log(0.39) * FOX_WILD);
const TILE_KM2 = (TILE_M * TILE_M) / 1e6;

// ---------- the ground (sec. 3) ----------
// grass: the ground layer's share of a tile; lit: the share of the open sun its growth gets, the field layer's under a
// crown (growth.ts through); woody: browse's share.
// nb: each land tile's land neighbours, eight a tile, -1 where none; wolfLand, foxLand: the land tiles in a wolf's and a
// fox's reach round each.
// ever: the evergreens' share of a tile's browse; summer, winter: what a gram of its green browse is worth then, kJ;
// bare: whether its broadleaves stand bare now; warren: the share of its ground rabbits can dig and graze from; snow: each
// season's snow depth there, m; open: the share of its ground layer the snow leaves in reach now; isLand.
type Ground = { open: Float32Array; isLand: Uint8Array; snow: Float32Array[]; warren: Float32Array; ever: Float32Array; summer: Float32Array; winter: Float32Array; bare: Uint8Array; land: number[]; grass: Float32Array; lit: Float32Array; woody: Float32Array; fed: Float32Array; sun: Float32Array[]; temp: Float32Array[]; water: Float32Array[]; nb: Int32Array; wolfLand: Float64Array; foxLand: Float64Array };
// The sums over the (2 r + 1)^2 tiles round each tile, clipped at the map's edge, by a summed-area table.
let table: Float64Array;
function box(src: ArrayLike<number>, out: Float64Array, r: number) {
  table ??= new Float64Array((W + 1) * (H + 1));
  for (let y = 0; y < H; y++) {
    let row = 0;
    for (let x = 0; x < W; x++) { row += src[y * W + x]; table[(y + 1) * (W + 1) + x + 1] = table[y * (W + 1) + x + 1] + row; }
  }
  for (let y = 0; y < H; y++) {
    const y0 = Math.max(0, y - r), y1 = Math.min(H, y + r + 1);
    for (let x = 0; x < W; x++) {
      const x0 = Math.max(0, x - r), x1 = Math.min(W, x + r + 1);
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
  const snow = isle.seasons.map(() => new Float32Array(W * H)), warren = new Float32Array(W * H), ever = new Float32Array(W * H), summer = new Float32Array(W * H), winter = new Float32Array(W * H), grass = new Float32Array(W * H), lit = new Float32Array(W * H), woody = new Float32Array(W * H), fed = new Float32Array(W * H), sun = isle.seasons.map(() => new Float32Array(W * H)), temp = isle.seasons.map(() => new Float32Array(W * H)), water = isle.seasons.map(() => new Float32Array(W * H));
  for (let i = 0; i < W * H; i++) {
    if (tileAt(w, i % W, Math.floor(i / W)) === Tile.Water) continue;
    land.push(i);
    const mx = (i % W) * TILE_M + TILE_M / 2 - SIZE / 2, mz = Math.floor(i / W) * TILE_M + TILE_M / 2 - SIZE / 2;
    const open = fine.fine(fine.cover.grass, mx, mz), tree = fine.fine(fine.cover.tree, mx, mz), shrub = fine.fine(fine.cover.shrub, mx, mz);
    grass[i] = Math.min(1, open + tree + shrub);
    lit[i] = grass[i] > 0 ? (open + (tree + shrub) * through(1)) / grass[i] : 0;
    woody[i] = Math.min(1, BROWSE.shrub * shrub + BROWSE.tree * tree);
    // the browse's kinds as the generator draws them, each by its fit and vigour there (flora.ts), within its form
    const env = envAt(isle, fine.bilinear, mx, mz, NaN, START);
    let ev = 0, su = 0, wi = 0, all = 0;
    for (const [kinds, form] of [[TREES, BROWSE.tree * tree], [SHRUBS, BROWSE.shrub * shrub]] as const) {
      const wts = kinds.map((k) => fit(k, env) * (NICHE[k].vigor ?? 1)), sum = wts.reduce((s, x) => s + x, 0);
      if (sum <= 0 || form <= 0) continue;
      kinds.forEach((k, j) => { const m = (form * wts[j]) / sum, q = BROWSE_ME[k]; all += m; su += m * q.summer; if (q.evergreen) { ev += m; wi += m * q.winter; } });
    }
    ever[i] = all > 0 ? ev / all : 0; summer[i] = all > 0 ? su / all : ME; winter[i] = ev > 0 ? wi / ev : ME_DEAD;
    const cx = (mx - START) / CELL, cy = (mz - START) / CELL;
    fed[i] = fine.bilinear(isle.fertility, cx, cy);
    isle.seasons.forEach((se, k) => { snow[k][i] = snowDepth(fine.bilinear(se.snowpack, cx, cy), SNOW_DOY[k]) * (1 - INTERCEPT_SNOW * Math.min(1, tree)); });
    const dig = Math.min(fine.bilinear(isle.soil, cx, cy), fine.bilinear(isle.table, cx, cy));
    warren[i] = Math.max(0, Math.min(1, (dig - WARREN[0]) / (WARREN[1] - WARREN[0])));
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
  g = { open: new Float32Array(W * H).fill(1), isLand: new Uint8Array(W * H), snow, warren, ever, summer, winter, bare: new Uint8Array(W * H), land, grass, lit, woody, fed, sun, temp, water, nb, wolfLand: new Float64Array(W * H), foxLand: new Float64Array(W * H) };
  const isLand = new Float64Array(W * H);
  for (const i of land) { isLand[i] = 1; g.isLand[i] = 1; }
  box(isLand, g.wolfLand, WOLF_REACH); box(isLand, g.foxLand, FOX_REACH);
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
  let askG = 0, askD = 0;
  const ask = (n: number, e: number, k: Spec, most: number, half: number, green: number, dead: number, rumen: boolean) => {
    askG = 0; askD = 0;
    if (n <= 0) return;
    const fill = RUMEN * k.kg * 1000 * days, need = Math.max(0, k.full - e + k.fmr * days);
    const g1 = Math.min(rumen ? fill / NDF_GREEN : most, need / ME) * (green / (green + half));
    const room = rumen ? (fill - g1 * NDF_GREEN) / NDF_DEAD : most - g1;
    const d1 = Math.min(room, Math.max(0, need - g1 * ME) / ME_DEAD) * (dead / (dead + half));
    askG = g1; askD = Math.max(0, d1);
  };
  const share = (want: number, has: number) => (want > has && want > 0 ? has / want : 1);
  const light = Math.max(0, Math.min(1, daylight(Math.floor(t / DAY)) - 10));
  for (const i of g.land) {
    // the grass and the browse grow, and the grazers eat them: rabbits the grass, deer both as they stand
    const sun = sun0[i] * (1 - f) + sun1[i] * f, temp = temp0[i] * (1 - f) + temp1[i] * f, water = water0[i] * (1 - f) + water1[i] * f;
    // green grows as the whole stand leaves it room, dies after its leaves' lifespan, and the dead slowly rot away
    const grown = RUE * sun * INTERCEPT * warmEnough(temp) * watered(water) * g.fed[i] * days, dies = 1 - Math.exp(-(Math.max(0, temp - LEAF_BASE) * days) / LEAF_DD), rots = Math.exp(-DECAY * days);
    const fNew = hs.forage[i] + grown * g.lit[i] * (1 - (hs.forage[i] + hs.forageDead[i]) / MOST), bNew = hs.browse[i] + grown * (1 - (hs.browse[i] + hs.browseDead[i]) / MOST);
    hs.forage[i] = Math.max(0, fNew * (1 - dies)); hs.forageDead[i] = (hs.forageDead[i] + Math.max(0, fNew) * dies) * rots;
    // the broadleaves drop their leaves as they go bare, the evergreens keeping theirs
    const bare = warmEnough(temp) * light < GREEN_UP, fall = bare && !g.bare[i] ? 1 - (1 - dies) * g.ever[i] : dies;
    g.bare[i] = bare ? 1 : 0;
    hs.browse[i] = Math.max(0, bNew * (1 - fall)); hs.browseDead[i] = (hs.browseDead[i] + Math.max(0, bNew) * fall) * rots;
    // A grazer crops the green as its response to the green standing allows (a rabbit's bite takes a short sward a
    // deer's can't), and makes up what that leaves short of its need from the dead, as its response to the dead allows
    // [derived]; deer reach the browse and the ground layer both, each in the share it stands. Where they all ask more
    // of a pool's green or dead than stands, each gets its share of what there is.
    const deep = g.snow[s][i] * (1 - f) + g.snow[s1][i] * f, open = 1 - Math.max(0, Math.min(1, (deep - SNOW_REACH[0]) / (SNOW_REACH[1] - SNOW_REACH[0])));
    g.open[i] = open;
    const gG = hs.forage[i] * g.grass[i] * g.open[i], gD = hs.forageDead[i] * g.grass[i] * g.open[i], bG = hs.browse[i] * g.woody[i], bD = hs.browseDead[i] * g.woody[i], bQ = bare ? g.winter[i] : g.summer[i];
    ask(deer.n[i], deer.e[i], D, deerMost, deerHalf, gG + bG, gD + bD, true);
    const dG = askG, dD = askD;
    ask(rabbit.n[i], rabbit.e[i], R, rabbitMost, rabbitHalf, gG, gD, false);
    const rG = askG, rD = askD;
    // the deer's green and dead split between the ground layer and the browse as each stands
    const dGg = gG + bG > 0 ? dG * (gG / (gG + bG)) : 0, dDg = gD + bD > 0 ? dD * (gD / (gD + bD)) : 0;
    // the rabbits crop what lies round their warrens, and the deer take what's left of the ground layer and the browse
    const rGG = rG * rabbit.n[i], rGD = rD * rabbit.n[i], sRG = share(rGG / area, gG * g.warren[i]), sRD = share(rGD / area, gD * g.warren[i]);
    const dOnGG = dGg * deer.n[i], dOnGD = dDg * deer.n[i], onBG = (dG - dGg) * deer.n[i], onBD = (dD - dDg) * deer.n[i];
    const sGG = share(dOnGG / area, gG - (rGG * sRG) / area), sGD = share(dOnGD / area, gD - (rGD * sRD) / area), sBG = share(onBG / area, bG), sBD = share(onBD / area, bD);
    const onGG = dOnGG * sGG + rGG * sRG, onGD = dOnGD * sGD + rGD * sRD;
    if (deer.n[i] > 0) deer.e[i] += dGg * sGG * ME + (dG - dGg) * sBG * bQ + (dDg * sGD + (dD - dDg) * sBD) * ME_DEAD - D.fmr * days;
    if (rabbit.n[i] > 0) rabbit.e[i] += rG * sRG * ME + rD * sRD * ME_DEAD - R.fmr * days;
    if (g.grass[i] > 0) { hs.forage[i] = Math.max(0, hs.forage[i] - onGG / (area * g.grass[i])); hs.forageDead[i] = Math.max(0, hs.forageDead[i] - onGD / (area * g.grass[i])); }
    if (g.woody[i] > 0) { hs.browse[i] = Math.max(0, hs.browse[i] - (onBG * sBG) / (area * g.woody[i])); hs.browseDead[i] = Math.max(0, hs.browseDead[i] - (onBD * sBD) / (area * g.woody[i])); }
  }
  // wolves kill deer and rabbits over their territory by the prey's whole biomass there, each kind as its share of it,
  // every tile's wolves at once: each takes its kills as a share of each kind round it, and each tile's deer and rabbits
  // lose the shares of all the wolves whose territories take them in; foxes the same with rabbits over theirs
  const Dk = D.kg, Rk = SPEC.rabbit.kg, deerKj = meal("deer") * (1 - RAVENS), rabbitKj = meal("rabbit");
  const deerW = box(hs.deer.n, scratch(0), WOLF_REACH), rabbitW = box(hs.rabbit.n, scratch(1), WOLF_REACH), rabbitF = box(hs.rabbit.n, scratch(2), FOX_REACH);
  const wolfDeer = scratch(3), wolfRabbit = scratch(4), foxRabbit = scratch(5);
  for (const i of g.land) {
    const wn = hs.wolf.n[i], mass = deerW[i] * Dk + rabbitW[i] * Rk;
    if (wn <= 0) continue;
    if (!skip?.has(i) && mass > 0) {
      // as fast as the prey allow, but no more than fills them: a pack gorged on rabbits leaves the deer be
      const X = mass / (g.wolfLand[i] * TILE_KM2) / MOOSE, most = Math.min(mass, (wn * KILL_MAX * X) / (KILL_HALF + X) * MOOSE * days);
      const kjPerKg = (deerW[i] * deerKj + rabbitW[i] * rabbitKj) / mass, want = Math.max(0, (SPEC.wolf.full - hs.wolf.e[i] + SPEC.wolf.fmr * days) * wn);
      const kg = Math.min(most, want / kjPerKg);
      // each kind as its share of the prey, the rabbits no more than the chases allow and the deer taking up the rest
      const rabbitKills = Math.min((kg * (rabbitW[i] * Rk)) / mass / Rk, wn * RABBIT_CHASES * days), rabbitKg = rabbitKills * Rk;
      const deerKills = deerW[i] > 0 ? Math.min(deerW[i], Math.max(0, (kg * kjPerKg - rabbitKg * (rabbitKj / Rk)) / deerKj)) : 0;
      if (deerW[i] > 0) wolfDeer[i] = deerKills / deerW[i];
      if (rabbitW[i] > 0) wolfRabbit[i] = rabbitKills / rabbitW[i];
      hs.wolf.e[i] += (deerKills * deerKj + rabbitKills * rabbitKj) / wn;
    }
    hs.wolf.e[i] -= SPEC.wolf.fmr * days;
  }
  for (const i of g.land) {
    const fn = hs.fox.n[i], rabbits = rabbitF[i];
    if (fn <= 0) continue;
    if (rabbits > 0) {
      const N = rabbits / (g.foxLand[i] * TILE_HA), most = Math.min(rabbits * Rk, (fn * FOX_MOST * N * N) / (N * N + FOX_INFLECT * FOX_INFLECT) * days);
      const want = Math.max(0, (SPEC.fox.full - hs.fox.e[i] + SPEC.fox.fmr * days) * fn), kg = Math.min(most, want / (rabbitKj / Rk)), kills = kg / Rk;
      foxRabbit[i] = kills / rabbits;
      hs.fox.e[i] += (kills * rabbitKj) / fn;
    }
    hs.fox.e[i] -= SPEC.fox.fmr * days;
  }
  const deerTaken = box(wolfDeer, scratch(6), WOLF_REACH), rabbitTaken = box(wolfRabbit, scratch(7), WOLF_REACH), foxTaken = box(foxRabbit, scratch(8), FOX_REACH);
  for (const i of g.land) {
    if (deerTaken[i] > 0) hs.deer.n[i] *= Math.max(0, 1 - deerTaken[i]);
    if (rabbitTaken[i] + foxTaken[i] > 0) hs.rabbit.n[i] *= Math.max(0, 1 - rabbitTaken[i] - foxTaken[i]);
  }
  // hunger, the year's other deaths, and the young
  const before = hs.day, now = ((t / DAY) % YEAR_DAYS + YEAR_DAYS) % YEAR_DAYS;
  const rut = crossed(before, now, RUT), calving = crossed(before, now, CALVING), whelping = crossed(before, now, WHELPING), cubbing = crossed(before, now, CUBBING);
  const kits = KITS_FROM > KITS_TO ? now >= KITS_FROM || now < KITS_TO : now >= KITS_FROM && now < KITS_TO;
  let wolves = 0;
  for (const i of g.land) wolves += hs.wolf.n[i];
  const density = (1000 * wolves) / (g.land.length * TILE_KM2);
  for (const sp of HERDED) {
    const h = hs[sp], k = SPEC[sp], keep = sp === "wolf" ? wolfSurvival(density) ** (days / 365.25) : Math.exp(-(k.die * days) / 365.25);
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
      else if (sp === "wolf" && whelping) h.n[i] += (h.n[i] / PACK) * PUPS * PUP_YEAR * fit;
      else if (sp === "fox" && cubbing) h.n[i] += (h.n[i] / 2) * CUBS * CUB_YEAR * fit;
    }
  }
  hs.day = now;
  // moving on to better ground: grazers to where they would eat faster, by their response to the forage there (which
  // falls as those already there graze it down), wolves to more prey by its biomass, foxes to more rabbits
  const rate = (green: number, q: number, dead: number, half: number) => { const gr = green / (green + half); return gr * q + (1 - gr) * (dead / (dead + half)) * ME_DEAD; };
  const far = Math.round((DEER_WALK * days) / TILE_M);
  for (const sp of HERDED) {
    const h = hs[sp], share = Math.min(0.5, SPEC[sp].move * days), out = scratch(0), inn = scratch(1), kj = scratch(2), carried = scratch(3), pull = scratch(4);
    for (const j of g.land) {
      // the energy they'd take in there: their response to the forage standing, at what it's worth
      const fG = hs.forage[j] * g.grass[j] * g.open[j], fD = hs.forageDead[j] * g.grass[j] * g.open[j], bG = hs.browse[j] * g.woody[j], bD = hs.browseDead[j] * g.woody[j];
      const deerQ = fG + bG > 0 ? (fG * ME + bG * (g.bare[j] ? g.winter[j] : g.summer[j])) / (fG + bG) : ME;
      pull[j] = sp === "wolf" ? hs.deer.n[j] * SPEC.deer.kg + hs.rabbit.n[j] * SPEC.rabbit.kg : sp === "fox" ? hs.rabbit.n[j] : sp === "deer" ? rate(fG + bG, deerQ, fD + bD, deerHalf) : g.warren[j] * rate(fG, ME, fD, rabbitHalf);
    }
    for (let k = 0; k < g.land.length; k++) {
      const i = g.land[k];
      if (h.n[i] <= 0) continue;
      let best = -1, bv = pull[i];
      for (let m = k * 8; m < k * 8 + 8; m++) { const j = g.nb[m]; if (j < 0) break; if (pull[j] > bv) { bv = pull[j]; best = j; } }
      // deer look further, along eight bearings out to a step's walk, at doubling distances
      if (sp === "deer") {
        const x0 = i % W, y0 = Math.floor(i / W);
        for (const [dx, dy] of BEARINGS) for (let d = 2; d <= far; d *= 2) {
          const x = x0 + dx * d, y = y0 + dy * d;
          if (x < 0 || y < 0 || x >= W || y >= H) break;
          const j = y * W + x;
          if (g.isLand[j] && pull[j] > bv) { bv = pull[j]; best = j; }
        }
      }
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
  const g = groundFor(w), hs: Herds = { forage: blank(), browse: blank(), forageDead: blank(), browseDead: blank(), deer: { n: blank(), e: blank(), preg: blank() }, rabbit: { n: blank(), e: blank() }, wolf: { n: blank(), e: blank() }, fox: { n: blank(), e: blank() }, day: 0 };
  for (const i of g.land) {
    hs.forage[i] = hs.browse[i] = MOST / 2;
    hs.deer.n[i] = 2 * TILE_KM2 * Math.min(1, g.grass[i] + g.woody[i]); hs.deer.e[i] = SPEC.deer.full / 2;
    hs.rabbit.n[i] = TILE_KM2 * 400 * g.grass[i] * g.warren[i]; hs.rabbit.e[i] = SPEC.rabbit.full / 2;
    hs.fox.n[i] = TILE_KM2; hs.fox.e[i] = SPEC.fox.full / 2;
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
