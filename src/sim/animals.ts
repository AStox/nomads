// The island's animals. Every deer, rabbit, wolf, fox, heron, eagle, gull and crow is one object on the GPU
// (src/gpu/animals.ts, its law in src/gpu/wgsl/animals.ts), living on energy: it burns its field metabolic rate, grazes
// the sward and browse or kills and scavenges, breeds in its season and dies of hunger or the year's other deaths
// (docs/research/animal-constants.md sec. 12). This module states the law's constants with their sources, lays out
// what the law reads of the ground, and is the CPU's side of the animals: those people can see are views of their
// objects (sync), moved here each tick the way people move, and what happens to them here (killed, fed, trapped) goes
// to their objects. The fish are objects of their own (waters.ts) and the butterflies still each tile's count (Unit 12b).
//
// What the animals do each tick within sight: graze, wander, flee, hunt, swim, fly, perch and feed. Speeds are meters a
// tick of five minutes' game time, the way a person's are; what each kind is like is in fauna.ts.
import { carcassOf, fatOf } from "./hunt";
import {
  DAY, H, TILE_M, Tile, W, YEAR, dryAt, groundOf, heldStore, isNight, log, meters, sea, shoreByTile, shoreOf, tileAt, walkable, wetAt,
  type Agent, type Animal, type AnimalSpecies, type Thing, type World,
} from "./world";
import { SIZE, START } from "../terrain/flora";
import { CELL, N } from "../terrain/grid";
import { GREEN_UP, RUE, warmEnough, watered } from "../terrain/growth";
import { SHRUBS, TREES, envAt, fit } from "../terrain/niche";
import { INTERCEPT_SNOW, SNOW_DOY, SNOW_REACH, snowAt, snowDepth } from "./air";
import { coldBite, warmRate } from "./cues";
import { floraOf, liveThings, nearestThing, onPath, put, smallsOf, thingById } from "./space";
import { steer } from "./walk";
import { dropPile, mark, removeThing } from "./physics";
import { see } from "./beliefs";
import { animalSize } from "./senses";
import { trace } from "./trace";
import { FAUNA, revealed, spawn } from "./fauna";
import { fishCount, fishDriver, fishKg, fishOf, showFish } from "./waters";
import { reveal, startPools, tileOf, type Pools } from "./pools";
import { FOOD_KJ, PHYS } from "./fuel";
import { DARK, lightOn } from "./light";
import { YEAR_DAYS, daylight, onDay, seasonAt } from "./sky";
import { SPECIES } from "../terrain/flora";
import { PLANT } from "../gpu/flora";
import { ANIMAL, Animals, type AnimalDriver } from "../gpu/animals";
import { CLS, DR, DRIVERS, DT, DTAB, FLAG, G, GK, K, KW, NSP, PO, SP, STATIC_RUNS, STREAM, T, TILE_MM, W_, WTAB, WTN } from "../gpu/wgsl/animals";
import { TEXELS_SIDE } from "../gpu/wgsl/stems";
import { next32, rinit, unif } from "../gpu/rand";

// A herd animal's day is the year's 365.25 / YEAR_DAYS days of eating and burning, as a plant's is of growing
// (plants.ts YEARS_PACE).
const YEARS_PACE = 365.25 / YEAR_DAYS;
const TILE_KM2 = (TILE_M * TILE_M) / 1e6, TILE_HA = (TILE_M * TILE_M) / 1e4;

export const HERDED = ["deer", "rabbit", "wolf", "fox", "heron", "eagle", "gull", "crow"] as const;
export type Herded = (typeof HERDED)[number];
export const herded = (sp: AnimalSpecies): sp is Herded => (HERDED as readonly string[]).includes(sp);

// ---------- bodies (sec. 2) ----------
// Nagy's field metabolic rate for mammals, kJ a day, M in g (R361); for birds 10.5 M^0.681.
const fmr = (kg: number) => 4.82 * (kg * 1000) ** 0.734;
const fmrBird = (kg: number) => 10.5 * (kg * 1000) ** 0.681;
const FAT_KJ = FOOD_KJ.fat;
// What a predator takes from a kill it eats, kJ a g of the prey's live mass: a rabbit's 21.9 kJ a g of dry matter
// (R385) at its 17.8% dry matter (R386), of which a carnivore keeps 79%, as weasels fed rabbit do (R387); every prey
// taken as made like a rabbit [derived].
const PREY_KJ_G = 21.9 * 0.178 * 0.79;
export const mealOf = (kg: number) => kg * 1000 * PREY_KJ_G;
// kg: live mass; fmr, kJ a day; full: the full fat reserve, kJ, the winter carcass fat and the gut and kidney fat
// (body-constants sec. 10), the others' as a deer's shares [design]; die: deaths a year besides hunger and what eats
// them; reveal: how far off people see them, m [design]; grown: the age, years, at which the field counts the young
// as grown (sec. 5), from when they breed and leave home.
type Spec = { kg: number; fmr: number; full: number; die: number; reveal: number; grown: number };
// Of Britain's 425,000 fox deaths a year, 100,000 on the roads and 80,000 shot (R384): the rest's share, by which the
// deaths measured among people's foxes are taken down to an island's with neither [derived].
const FOX_WILD = 1 - 180 / 425;
// a: the dressed share of live mass, b: carcass fat a kg of carcass, c: gut and kidney fat a kg of live mass (the
// seasons' mean of R303's fallow does, body-constants sec. 10).
const reserve = (kg: number, a = 0.55, b = 0.0655, c = 0.0314) => (a * b + c) * kg * FAT_KJ;
// A red deer's year (sec. 12). What it burns: free-living red deer hinds burned 25 MJ a day in summer by doubly
// labelled water, 757 kJ a kg^0.75 (Haggarty et al., R711), Nagy's 25.1 MJ for its 116 kg being that summer's and not
// a year's; its heart rate, an index of its metabolism, rose steeply from late March to 65 to 70 beats a minute in May,
// stood at 50 to 60 through summer and autumn and fell in late November to about 40 over the winter, 30% under the
// summer's even with food to spare (Turbill et al., R712; Arnold et al.'s 60% fall, R707): so it burns its summer's
// rate times its heart rate over the summer's 55, read between the points below by day of the year [derived]. What it
// eats at most: red deer offered lucerne chaff without limit ate 59 g of dry matter a kg^0.75 a day in winter against
// 89 in summer, the forage's digestibility and the rumen's volume unchanged (Freudenberger et al., R713), and their
// intake runs lowest in late winter and early spring, at its plateau June to October and falling in late autumn
// (Arnold et al., R714): the most green it eats (R363's, an appetite's most) taken down to 59/89 over winter, between
// the points below, and the rumen's fibre room, its volume on a forage diet, kept [derived]. Taken down too (the
// rumen's room as the appetite), every deer on seed 1 was dead by the first autumn, as the appetite here already falls
// with the burn: a deer eats what refills its reserve and pays its day. Its full reserve is the fat it goes into winter
// with, laid down over summer and autumn (a red deer hind's kidney fat 78% more in January and February than in July,
// R714): R303's winter carcass, gut and kidney fat (2.75% and 0.75 kg of 40.5 kg bled), not the seasons' mean
// [derived].
const DEER_HEART: [doy: number, bpm: number][] = [[85, 40], [135, 67.5], [166, 55], [319, 55], [335, 40]];
const DEER_INTAKE: [doy: number, share: number][] = [[85, 59 / 89], [152, 1], [304, 1], [335, 59 / 89]];
const DEER_SUMMER_HEART = 55;
// A yearly curve through its points (days of the year, in order), straight between them and round the year's turn.
function yearly(points: [number, number][], doy: number) {
  const d = ((doy % 365.25) + 365.25) % 365.25, n = points.length;
  for (let k = 0; k + 1 < n; k++) {
    const [a, va] = points[k], [b, vb] = points[k + 1];
    if (d >= a && d < b) return va + ((vb - va) * (d - a)) / (b - a);
  }
  const [a, va] = points[n - 1], [b, vb] = points[0], dd = d < b ? d + 365.25 : d;
  return va + ((vb - va) * (dd - a)) / (b + 365.25 - a);
}
// An island day's middle as a day of the year, 20 March the 79th (sky.ts onDay) [derived].
const doyOf = (day: number) => 79 + (day + 0.5 - YEAR_DAYS / 8) * YEARS_PACE;
export const deerBurn = (day: number) => yearly(DEER_HEART, doyOf(day)) / DEER_SUMMER_HEART;
export const deerIntake = (day: number) => yearly(DEER_INTAKE, doyOf(day));
export const SPEC: Record<Herded, Spec> = {
  // red deer, 116 kg (body-constants R304), burning its summer's rate (R711; the year's, deerBurn); deaths 1/12 a year
  // [UNVERIFIED]; hinds conceive as yearlings (R365)
  deer: { kg: 116, fmr: 757 * 116 ** 0.75, full: reserve(116, 0.55, 0.0655, 0.0275 + 0.75 / 40.5), die: 1 / 12, reveal: 300, grown: 1 },
  // rabbits live 1 to 3 years (R369); grown at three months [UNVERIFIED]
  rabbit: { kg: 1.6, fmr: fmr(1.6), full: reserve(1.6, 0.555, 0.035), die: 1 / 2, reveal: 50, grown: 0.25 },
  // a wolf's deaths 1/5 a year [UNVERIFIED], taken down by strife among packs as they crowd (wolfSurvival); pups
  // counted grown at a year (R368)
  wolf: { kg: 41.5, fmr: fmr(41.5), full: reserve(41.5), die: 1 / 5, reveal: 300, grown: 1 },
  // a red fox: Britain's dog and vixen, 6.5 and 5.5 kg (R382); Bristol's grown foxes' deaths, half of them in a year,
  // at the share of Britain's fox deaths that are neither cars' nor guns' (FOX_WILD); grown at six months [UNVERIFIED]
  fox: { kg: 6, fmr: fmr(6), full: reserve(6), die: Math.LN2 * FOX_WILD, reveal: 150, grown: 0.5 },
  // a grey heron, 1.5 kg (materials.ts), its grown birds living 73.2% of years and breeding at two (BTO, R422); a
  // white-tailed eagle, 4.38 kg, 90% (R423); seen from 300 m and, soaring, a kilometre [design]
  heron: { kg: 1.5, fmr: fmrBird(1.5), full: reserve(1.5), die: -Math.log(0.732), reveal: 300, grown: 2 },
  eagle: { kg: 4.38, fmr: fmrBird(4.38), full: reserve(4.38), die: -Math.log(0.9), reveal: 1000, grown: 1 },
  // a herring gull, 0.97 kg, its grown birds living 88% of years, breeding at four (BTO, R429); a carrion crow, 0.51 kg
  // (BTO, R430), living 75% of years once grown: the BTO's typical four years at breeding age, 1 - 1/4 [derived]; gulls
  // seen from 400 m on the wing, crows from 200 [design]
  gull: { kg: 0.97, fmr: fmrBird(0.97), full: reserve(0.97), die: -Math.log(0.88), reveal: 400, grown: 4 },
  crow: { kg: 0.51, fmr: fmrBird(0.51), full: reserve(0.51), die: -Math.log(0.75), reveal: 200, grown: 1 },
};
export const meal = (sp: Herded) => mealOf(SPEC[sp].kg);

// ---------- forage (sec. 3) ----------
// Forage's metabolisable energy, kJ/g DM (R362); what a sward intercepts of the sun [UNVERIFIED]; the most it stands at,
// g/m2 (R364); the share of shrubs' and trees' cover within a deer's reach, as browse [design].
const ME = 11, INTERCEPT = 0.8, MOST = 300, BROWSE = { shrub: 0.3, tree: 0.1 };
// A grazed temperate sward's leaves live 400 to 520 degree-days over 4 C (R392); dead ones are under 45% digestible,
// where green is over 65% (R393), each point of digestibility 0.16 MJ/kg of metabolisable energy (R394): dead's 7.2 kJ/g
// against green's 11; litter loses 0.33 to 0.5% of its mass a day (R395) [UNVERIFIED: a tropical grass's litter].
const LEAF_DD = 460, LEAF_BASE = 4, ME_DEAD = 0.16 * 45, DECAY = 0.004;
// A ruminant's rumen holds a day's fibre (NDF) of 1.2% of its weight (Mertens, R399): grazed green grass is 30 to 40%
// NDF (R400), mature grass over 65% and straw up to 80% (R401), dead standing stuff taken at 70% [derived] (the kernel's
// 4 and 7 tenths). A deer's most dry matter a day is 3.4 kg (R363); a rabbit's 65 to 80 g a kg of it (R373), and it
// passes fibre through fast and eats to its own most [derived].
const RUMEN = 0.012, RABBIT_DM = 0.0725 * 1.6;
// Rabbits graze from their warrens, the grazing heaviest within 50 m of them (R405) and most of it within 10 m of a
// refuge (R406), so a tile's rabbits reach only the share of its ground a warren can be dug in: soil over the water
// table and the bedrock deep enough for the tunnels, which lie 0.3 to 0.75 m down in heavy soils (R407) with nearly all
// the chambers within 0.55 m (R408), from none at 0.3 m to all of it at 0.55 [derived].
const WARREN = [0.3, 0.55];
// What a gram of each woody plant's green browse is worth, kJ, in the growing season and out of it, at 0.16 MJ/kg a point
// of digestibility (R394): deciduous leaves as green grass's, and any still green after leaf fall as dead stuff (R396);
// heather's shoots 55.9% digestible in July and 41.9% in March (R397); pine's 56%, low in every season (R396); bramble's
// evergreen leaves as green grass's, unchanging through the year (R396; 70.3% digestible in January, R702). Evergreens
// keep their leaves through the winter; the rest drop them. Classes as the browse kernel numbers them: 1 deciduous, 2
// pine, 3 bramble, 4 heather.
const BROWSE_CLASS: Record<string, number> = { oak: 1, ash: 1, aspen: 1, hazel: 1, pine: 2, berry: 3, heather: 4 };
const CLASS_ME = [[0, 0], [ME, ME_DEAD], [0.16 * 56, 0.16 * 56], [ME, ME], [0.16 * 55.9, 0.16 * 41.9]];
// The broadleaves' current-year twigs, which a deer browses through the leafless season (sec. 12): moose browse in
// willow scrub in the Biebrza valley held 40.2, 63.8 and 71.1 g of dry matter a m2 of ground in its 0.5 to 1, 1 to 1.5
// and 1.5 to 2 m height classes (R701), those within a red deer's 1.8 m reach (R471), taken at their mean over every
// m2 of broadleaf crown within reach [derived: willow for oak, ash, aspen and hazel, whose own were not found]. Mature
// twigs of twenty browse species in winter: 61.9% NDF and 40.4% digestible (R702), so 0.16 x 40.4 kJ/g (R394). Their
// growth is done by early summer and they stay so until the next year's growth (R702): standing from leaf fall, eaten
// down and not regrown through the winter, last year's wood from leaf-out (R703).
const TWIG = (40.2 + 63.8 + 71.1) / 3, TWIG_ME = 0.16 * 40.4, TWIG_NDF = 0.619;
// The forage at which a grazer eats at half its most, g DM/m2 of the ground it grazes: Mulder and Hendriks' grazing
// mammals, 4.9e4 m^0.20 kg/km2 of wet vegetation over the ground, m in kg (R374), a quarter of it dry [UNVERIFIED].
// Grazers pick their patches (1 m2 to 1 ha) every 1 to 30 minutes and their feeding sites (1 to 10 ha) within a grazing
// bout of 1 to 4 hours, and spend their time where the forage is (Senft et al.'s matching, as Bailey and Provenza give it,
// R640). A tile, 2.25 ha, is a feeding site, its ground layer and browse its patches: each animal eats at its response to
// the forage standing on the patches it grazes, and an hour's step is a grazing bout, after which a deer takes its next
// feeding site from its tile and the eight round it with the chance each would feed it, as matching has it [derived].
const half = (kg: number) => 49 * kg ** 0.2 * 0.25;

// ---------- predators (secs. 6, 11) ----------
// Messier: kills a wolf a day at most, and the density for half of that, moose-equivalents a km2, taken on all the prey's
// biomass, deer and rabbits alike (sec. 6). His response is kills a wolf a day over whole winters, the days a pack spends
// on a kill and full after it among them: as Holling's, its most is one over the time a kill takes and its searching
// rate a = most / half a moose a km2. Here a pack eats its kill down from its larder and hunts only once hungry with
// the larder short (wgsl/animals.ts), the time a kill takes being its own, so a searching wolf kills at a X [derived];
// at the curve's average it counted that time twice and the packs, hunting only when hungry, starved.
const KILL_MAX = 3.36 / 100, KILL_HALF = 0.46, MOOSE = 400;
// A wolf runs down a rabbit a chase at a time, no more of them a day than coyotes kill snowshoe hares at most, 2.3
// (O'Donoghue et al., R404) [derived: a canid on a lagomorph of a rabbit's size].
const RABBIT_CHASES = 2.3;
// Mulder and Hendriks' predators' half-saturation, birds and carnivorous mammals on their prey, 15 m^0.57 kg a km2, m the
// predator's kg (R374) [ex: Table 1].
const preyHalf = (kg: number) => 15 * kg ** 0.57;
// A pack loses a share of each deer it kills to ravens before it has eaten it: a pair 37%, a pack of six 17% (R398),
// between them for four (R368) [derived].
const RAVENS = 0.37 + ((0.17 - 0.37) * (4 - 2)) / (6 - 2);
// How far each hunts from its home, tiles either side: a square as big as a pack's territory, Bialowieza's 201 km2 on
// average (R402); a rural fox's, 200 to 600 ha (R403), 4 km2 [derived]; a grey heron's winter foraging flights, 2.8 km
// on average (R425); a white-tailed eagle's territory, 30 to 70 km2 (R423), 50 here; a herring gull's longest trips from
// an island colony, 4.2 km (R432); a carrion crow's farmland territory, 37.7 ha (Richner, R433).
const square = (km2: number) => Math.round((Math.sqrt(km2 / TILE_KM2) - 1) / 2);
const REACH: Record<Herded, number> = {
  deer: 0, rabbit: 0, wolf: square(201), fox: square(4), heron: Math.round(2800 / TILE_M), eagle: square(50), gull: Math.round(4200 / TILE_M), crow: square(0.377),
};
// Pech et al.'s foxes on rabbits, as Pech and Hood fitted it: a fox eats at most 100.01 kg of rabbit a quarter of a
// year, on a Type III response with its inflection at 1.32 rabbits a ha (R383).
const FOX_MOST = 100.01 / (365.25 / 4), FOX_INFLECT = 1.32;
// A grown wolf's chance of living the year at a density of d wolves a 1000 km2, by strife among packs: Cubaynes et al.'s
// Northern Range survival, 0.55 to 0.92 over 20 to 99 wolves, below 0.7 above 65 (R381), as a line [derived]; no
// better than the year's other deaths allow where wolves are few.
const wolfSurvival = (d: number) => Math.max(0.01, Math.min(Math.exp(-SPEC.wolf.die), 1.018 - 0.00489 * d));
// A heron wades to 0.4 m [UNVERIFIED: great blue herons to 0.6 m, R424, a grey heron's legs shorter], so it fishes a
// strip of shallows as wide as that depth over the bottom's slope, the shore's fall carried on under the water [derived],
// to a tile's width at most; at the fish standing in that water, kg a ha, by Mulder's half-saturation over a hundred.
const WADE = 0.4;
// The shore's animals, as the Dutch Wadden Sea's tidal flats hold them: 27 g of ash-free dry weight a m2 (Beukema,
// R440), regrowing toward that at a Baltic clam's production, 0.44 of its biomass a year (R444), on what's missing: they
// settle as larvae from the open sea [derived]; 23 kJ a g of it (Brey et al., R443), of which a bird keeps what a
// carnivore keeps of flesh [derived].
const SHORE_MOST = 27, SHORE_PB = 0.44, SHORE_KJ = 23 * 0.79;
// Earthworms in a permanent pasture, 71 to 100 g a m2 fresh (R437), taken as 85 under the open ground layer and none
// where the ground is frozen or the snow lies too deep to dig [derived]: the crows' worms where the world has no
// lumped kinds (wgsl/animals.ts G.lumped), which else hold the island's own.
const WORMS = 85;
// The dead rot as the air is warm: a carcass on the ground is down to bone in 2,440 degree-days over 0 C (R436).
const ROT_ADD = 2440;

// ---------- births (sec. 5) ----------
// The island days of the rut, calving and whelping, and of the rabbits' season (sky.ts onDay).
const RUT = onDay(219), CALVING = onDay(77), WHELPING = onDay(36), CUBBING = onDay(-5), KITS_FROM = onDay(287), KITS_TO = onDay(164);
// Rabbits litter about monthly, about five a litter (R366); a pack of four (R368) whelps 4 to 6 pups (5.5, R367) once a
// year; a vixen about five, born in March (R382). Deer conceive at the rut, 25% in poor condition to 90% in good (R365),
// as the reserve's share of full [design], and calve one.
const LITTER = 5, LITTER_DAYS = 30, PUPS = 5, CUBS = 5;
// The young are born with the share that the field's survival to grown gives over what the grown would have lived as long,
// since from birth they die as the grown do here [derived]: else they die twice.
const joined = (share: number, years: number, keepYear: number) => share / keepYear ** years;
// The share of kits that live to be grown with no predators about, the predators here taking theirs themselves: 18% of
// those that came above ground where predators were kept down (R388), of the 71% of litters not drowned in the burrow
// (R389) [derived].
const KIT_GROWN = 0.18 * (1 - 0.29);
// The share of wolf pups alive at a year old, in Voyageurs, where wolves live on deer (R368).
const PUP_YEAR = 0.29;
// The share of cubs that live to be grown, Bristol's 39% (R384) with only the wild share of the deaths [derived].
const CUB_GROWN = Math.exp(Math.log(0.39) * FOX_WILD);
// A heron pair fledges 2.31 young, 26% of them living to two (BTO, R422), off the nest in June [UNVERIFIED]. A white-tailed
// eagle pair holding a territory fledges 0.76 (R423), three in four living their first year (R423), in mid-July
// [UNVERIFIED]. A herring gull pair fledges 0.52 (R431), 63% living to breed at four (R429), off the nest in mid-July: laying
// in early May, 29 days sitting and 35 to 40 to fledge (R429) [derived]. A carrion crow pair fledges 1.64 [UNVERIFIED: an
// American crow's, R433], 49% living their first year (BTO, R430), off the nest at the end of May: its first eggs about 7
// April, 18.5 days sitting and 29 to fledge (R430) [derived]. Only pairs holding a territory breed, the rest float: a
// heron's feeding territory, about 20 ha of the shore's land (Cornell, R427), an eagle's 50 km2, a crow's 37.7 ha.
const HERON_FLEDGE = onDay(73), EAGLE_FLEDGE = onDay(117), GULL_FLEDGE = onDay(115), CROW_FLEDGE = onDay(69);
const BROOD = 4; // the most young a nest is drawn for, each with its share of the pair's mean [design]
const YOUNG: Record<Herded, number> = {
  deer: 1, rabbit: joined(KIT_GROWN, 0.25, Math.exp(-SPEC.rabbit.die)), wolf: 0, fox: joined(CUB_GROWN, 0.5, Math.exp(-SPEC.fox.die)),
  heron: (2.31 * joined(0.26, 2, Math.exp(-SPEC.heron.die))) / BROOD, eagle: (0.76 * joined(0.75, 1, Math.exp(-SPEC.eagle.die))) / BROOD,
  gull: (0.52 * joined(0.63, 4, Math.exp(-SPEC.gull.die))) / BROOD, crow: (1.64 * joined(0.49, 1, Math.exp(-SPEC.crow.die))) / BROOD,
};
// Leaving home once grown: of 316 radio-collared wolves in north-eastern Minnesota 75 dispersed, most as yearlings, the
// mean distance 77 km (Gese and Mech, R700), past any island's width, so a disperser founds its pack anywhere on the
// island [derived]. The rest leave home when grown, a fox within twice its range, a heron, gull or crow within its
// range, an eagle anywhere [design]; rabbits move their warrens to better ground a fiftieth of them a day (sec. 7)
// [design].
const DISPERSE: Record<Herded, [share: number, tiles: number]> = {
  deer: [0, 0], rabbit: [0, 0], wolf: [75 / 316, 0], fox: [1, 2 * REACH.fox], heron: [1, REACH.heron], eagle: [1, 0], gull: [1, REACH.gull], crow: [1, 2 * REACH.crow],
};
const RABBIT_MOVE = 0.02;

// ---------- the law's integers ----------
const q16 = (x: number) => Math.round(x * 65536);
const q32 = (p: number) => (p >= 1 ? 0xffffffff : Math.max(0, Math.round(p * 2 ** 32)) >>> 0);
// The constants buffer (wgsl/animals.ts K, G) for so many steps an island day, on an island of so much land and shore.
export function lawConsts(per: number, island: { landKm2: number; shoreHa: number }): Uint32Array {
  const out = new Uint32Array(PO), days = YEARS_PACE / per;
  HERDED.forEach((sp, s) => {
    const k = SPEC[sp], at = s * KW, set = (w: number, v: number) => { out[at + w] = Math.round(v) >>> 0; };
    set(K.kg, k.kg * 1000);
    set(K.full, k.full * 1000);
    set(K.fmr, k.fmr * days * 1000);
    out[at + K.die] = q32(1 - Math.exp((-k.die * days) / 365.25));
    set(K.mature, k.grown * YEAR);
    set(K.reach, REACH[sp]);
    set(K.newe, (k.full * 1000) / 2);
    set(K.young, q16(YOUNG[sp]));
    out[at + K.disp] = q32(DISPERSE[sp][0]);
    set(K.dreach, DISPERSE[sp][1]);
    set(K.prey, k.kg * 100);
    if (sp === "deer") { const fill = RUMEN * k.kg * 1000 * days * 1000; set(K.capf, fill); out[at + K.capg] = Math.floor((Math.round(fill) * 10) / 4); set(K.half, q16(half(k.kg))); }
    if (sp === "rabbit") { set(K.capf, RABBIT_DM * 1000 * days * 1000); set(K.capg, RABBIT_DM * 1000 * days * 1000); set(K.half, q16(half(k.kg))); set(K.litter, LITTER); out[at + K.move] = q32(1 - Math.exp(-RABBIT_MOVE * days)); }
    if (sp === "wolf") { set(K.rate, KILL_MAX * MOOSE * 1000 * days); set(K.half, KILL_HALF * MOOSE * TILE_KM2 * 100); out[at + K.chase] = q32(RABBIT_CHASES * days); set(K.litter, PUPS); }
    if (sp === "fox") { set(K.rate, FOX_MOST * 1000 * days); set(K.half, TILE_HA * FOX_INFLECT * 100); set(K.half2, preyHalf(k.kg) * TILE_KM2 * 100); set(K.litter, CUBS); }
    if (sp === "eagle" || sp === "gull" || sp === "crow") set(K.half, preyHalf(k.kg) * TILE_KM2 * 100);
    if (sp === "heron" || sp === "eagle" || sp === "gull" || sp === "crow") set(K.litter, BROOD);
  });
  out[SP.heron * KW + K.terr] = Math.round(island.shoreHa / 20 / 2);
  out[SP.eagle * KW + K.terr] = Math.round(island.landKm2 / 50);
  out[SP.crow * KW + K.terr] = Math.round(island.landKm2 / 0.377);
  const g = (w: number, v: number) => { out[GK + w] = Math.round(v) >>> 0; };
  g(G.me, ME * 1000); g(G.med, ME_DEAD * 1000); g(G.rots, q16(Math.exp(-DECAY * days))); g(G.shrate, q16((SHORE_PB * days) / 365.25)); g(G.shmost, q16(SHORE_MOST));
  g(G.daysq, q16(days)); g(G.rotdd, ROT_ADD); g(G.flesh, PREY_KJ_G * 1000); g(G.shorej, SHORE_KJ * 1000); g(G.ravens, q16(RAVENS)); g(G.worms, WORMS);
  g(G.m2, TILE_M * TILE_M); g(G.hhalf, q16((preyHalf(SPEC.heron.kg) / 100) * 0.1)); out[GK + G.kitp] = q32(days / LITTER_DAYS);
  g(G.rutlo, q16(0.25)); g(G.rutsl, q16(0.65)); g(G.rutmax, q16(0.9)); g(G.kitfit, q16(0.5)); g(G.most, MOST);
  g(G.twig, q16(TWIG)); g(G.twme, TWIG_ME * 1000); g(G.twndf, TWIG_NDF * 1000);
  SPECIES.forEach((name, i) => { out[CLS + i] = BROWSE_CLASS[name] ?? 0; });
  CLASS_ME.forEach(([su, wi], c) => { out[CLS + 32 + 2 * c] = Math.round(su * 1000); out[CLS + 33 + 2 * c] = Math.round(wi * 1000); });
  // the wolves' tables by how many are alive: a step's chance of dying, and a pup's chance of being kept
  for (let n = 0; n < WTN; n++) {
    const S = wolfSurvival((1000 * n) / island.landKm2);
    out[WTAB + n] = q32(1 - S ** (days / 365.25));
    out[WTAB + WTN + n] = q16(Math.min(1, joined(PUP_YEAR, 1, S)));
  }
  // the deer's year, day by day: what it burns and the most it eats, each a share of its summer's
  if (YEAR_DAYS > DT) throw new Error("the deer's day tables hold DT days");
  for (let d = 0; d < YEAR_DAYS; d++) { out[DTAB + d] = q16(deerBurn(d)); out[DTAB + DT + d] = q16(deerIntake(d)); }
  return out;
}

// ---------- the ground (sec. 3) ----------
// Each tile as the law reads it: the static runs (land, the ground layer's share, the light it grows in, the share a
// warren reaches, mg a g/m2 of the ground layer, still water, the water beside and the share of it a heron wades), the
// pools as they start, every day's drivers, and what sets the start (the browse by the generator's cover, for the deer
// the island starts with; shore tiles).
type Ground = { tiles: Uint32Array; drivers: Uint32Array; woody: Float32Array; shore: Uint8Array; land: number[]; shoreHa: number };
const grounds = new WeakMap<World, Ground>();
function groundFor(w: World): Ground {
  let gr = grounds.get(w);
  if (gr) return gr;
  const { isle, fine } = groundOf(w.seed), tiles = new Uint32Array(STATIC_RUNS * T), land: number[] = [];
  const run = (r: number, i: number, v: number) => { tiles[r * T + i] = Math.round(v) >>> 0; };
  const seasons = isle.seasons.length, sun = new Float32Array(seasons * T), temp = new Float32Array(seasons * T), water = new Float32Array(seasons * T), snow = new Float32Array(seasons * T);
  const fed = new Float32Array(T), woody = new Float32Array(T), shore = new Uint8Array(T);
  for (let i = 0; i < T; i++) {
    const mx = (i % W) * TILE_M + TILE_M / 2 - SIZE / 2, mz = Math.floor(i / W) * TILE_M + TILE_M / 2 - SIZE / 2;
    const cx = (mx - START) / CELL, cy = (mz - START) / CELL;
    for (let k = 0; k < seasons; k++) temp[k * T + i] = fine.bilinear(isle.seasons[k].temp, cx, cy);
    if (tileAt(w, i % W, Math.floor(i / W)) === Tile.Water) continue;
    land.push(i);
    const open = fine.fine(fine.cover.grass, mx, mz), tree = fine.fine(fine.cover.tree, mx, mz), shrub = fine.fine(fine.cover.shrub, mx, mz);
    const under = fine.bilinear(isle.field, cx, cy), grass = Math.min(1, open + under), gq = q16(grass);
    run(W_.land, i, 1); run(W_.grass, i, gq);
    run(W_.lit, i, q16(grass > 0 ? (open + under * fine.bilinear(isle.fieldLight, cx, cy)) / grass : 0));
    const dig = Math.min(fine.bilinear(isle.soil, cx, cy), fine.bilinear(isle.table, cx, cy));
    run(W_.warren, i, q16(Math.max(0, Math.min(1, (dig - WARREN[0]) / (WARREN[1] - WARREN[0])))));
    run(W_.garea, i, (gq * TILE_M * TILE_M * 1000) / 65536);
    woody[i] = Math.min(1, BROWSE.shrub * shrub + BROWSE.tree * tree);
    fed[i] = fine.bilinear(isle.fertility, cx, cy);
    for (let k = 0; k < seasons; k++) {
      sun[k * T + i] = fine.bilinear(isle.seasons[k].sun, cx, cy); water[k * T + i] = fine.bilinear(isle.soilWater[k], cx, cy);
      snow[k * T + i] = snowDepth(fine.bilinear(isle.seasons[k].snowpack, cx, cy), SNOW_DOY[k]) * (1 - INTERCEPT_SNOW * Math.min(1, tree));
    }
  }
  const salt = sea(w), isLand = (x: number, y: number) => tiles[W_.land * T + y * W + x] === 1;
  const hAt = (x: number, y: number) => (TILE_M * (w.heights[y * (W + 1) + x] + w.heights[y * (W + 1) + x + 1] + w.heights[(y + 1) * (W + 1) + x] + w.heights[(y + 1) * (W + 1) + x + 1])) / 4;
  for (let i = 0; i < T; i++) { for (let m = 0; m < 4; m++) tiles[(W_.sw + m) * T + i] = 0xffffffff; if (!tiles[W_.land * T + i] && !salt[i]) run(W_.lake, i, 1); }
  let shoreHa = 0;
  for (const i of land) {
    const x = i % W, y = Math.floor(i / W), slope = Math.max(0.005, hAt(x, y) / (TILE_M / 2));
    let m = 0;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const xx = x + dx, yy = y + dy;
      if (xx < 0 || yy < 0 || xx >= W || yy >= H || isLand(xx, yy)) continue;
      tiles[(W_.sw + m) * T + i] = yy * W + xx; run(W_.sa + m, i, q16(Math.min(TILE_M, WADE / slope) / TILE_M)); m++;
    }
    if (m) { shoreHa += TILE_HA; shore[i] = 1; }
  }
  // every day of the year at its middle: the season's sun, warmth, water and snow between their means, and the light
  const drivers = new Uint32Array(YEAR_DAYS * DRIVERS * T);
  for (let d = 0; d < YEAR_DAYS; d++) {
    const { s, f } = seasonAt(d * DAY + DAY / 2), s1 = (s + 1) % seasons, at = d * DRIVERS * T, light = Math.max(0, Math.min(1, daylight(d) - 10));
    for (let i = 0; i < T; i++) {
      const tc = temp[s * T + i] * (1 - f) + temp[s1 * T + i] * f;
      drivers[at + DR.temp * T + i] = q16(tc) >>> 0;
      if (!tiles[W_.land * T + i]) continue;
      const su = sun[s * T + i] * (1 - f) + sun[s1 * T + i] * f, wa = water[s * T + i] * (1 - f) + water[s1 * T + i] * f, deep = snow[s * T + i] * (1 - f) + snow[s1 * T + i] * f;
      drivers[at + DR.grow * T + i] = q16(RUE * su * INTERCEPT * warmEnough(tc) * watered(wa) * fed[i] * YEARS_PACE);
      drivers[at + DR.leafk * T + i] = q16((Math.max(0, tc - LEAF_BASE) * YEARS_PACE) / LEAF_DD);
      drivers[at + DR.open * T + i] = q16(1 - Math.max(0, Math.min(1, (deep - SNOW_REACH[0]) / (SNOW_REACH[1] - SNOW_REACH[0]))));
      drivers[at + DR.bare * T + i] = warmEnough(tc) * light < GREEN_UP ? 1 : 0;
    }
  }
  gr = { tiles, drivers, woody, shore, land, shoreHa };
  grounds.set(w, gr);
  return gr;
}

// ---------- the butterflies ----------
// Meadow browns, the island's butterflies: over a season 750 to 1,250 a ha came out on the Isles of Scilly's grassland
// (R435), 1,000 a ha of open ground layer here; they come out from 125 to 594 degree-days over 10 C since midwinter, the
// UK's mid June to the end of August (R438) at its months' mean warmth (R439) [derived], spread evenly over that, and
// live 5 to 12 days (R434), 8.5 on average.
const BUTTERFLIES = 1000, GDD_BASE = 10, GDD_FROM = 125, GDD_TO = 594, BUTTERFLY_LIFE = 8.5, MIDWINTER = onDay(-89);
const crossed = (from: number, to: number, at: number) => (from <= to ? from < at && at <= to : from < at || at <= to);
const dayOf = (t: number) => ((t / DAY) % YEAR_DAYS + YEAR_DAYS) % YEAR_DAYS;
// An hour of the butterflies: they come out as the warmth adds up past their time and die off at their lives' length,
// the count starting over at midwinter.
function butterflies(w: World, p: Pools) {
  const gr = groundFor(w), days = YEARS_PACE / 24, now = dayOf(w.t), keep = Math.exp(-days / BUTTERFLY_LIFE);
  const at = Math.floor(now) * DRIVERS * T, winterTurns = crossed(p.day, now, MIDWINTER);
  for (const i of gr.land) {
    const temp = (gr.drivers[at + DR.temp * T + i] | 0) / 65536;
    if (winterTurns) p.gdd[i] = 0;
    const was = p.gdd[i];
    p.gdd[i] += Math.max(0, Math.min(30, temp) - GDD_BASE) * days;
    const came = Math.max(0, Math.min(p.gdd[i], GDD_TO) - Math.max(was, GDD_FROM)) / (GDD_TO - GDD_FROM);
    p.butterfly[i] = p.butterfly[i] * keep + BUTTERFLIES * TILE_HA * (gr.tiles[W_.grass * T + i] / 65536) * came;
  }
  p.day = now;
}

// ---------- the animals on the GPU ----------
const hosts = new WeakMap<World, Animals>();
export const animalsOf = (w: World) => { let a = hosts.get(w); if (!a) hosts.set(w, (a = new Animals())); return a; };
const SPECIES_OF = HERDED;
// The first tick a world runs: its fish and then its animals take up residence on its store (sim.ts tick), after the
// flora, whose stems are the deer's browse, and after the lumped kinds, whose ground layer and invertebrates they eat
// when they are resident. A new island's animals are laid down at their starting densities and run through twenty
// island years before anyone wakes (sec. 8), the birds taking the fish's own; then any put down by hand before now
// (fauna.ts addAnimal) get objects.
export async function residentAnimals(w: World) {
  const host = animalsOf(w), store = heldStore(w);
  if (host.store || !store) return;
  const flora = floraOf(w), fish = fishOf(w), smalls = smallsOf(w);
  if (!fish.store) await fish.attach(store, fishDriver(w));
  await host.attach(store, animalDriver(w), {
    raster: (s) => { const r = flora.raster(), k = s.kind(PLANT); return { ...r, body: k.body, cap: k.capacity, what: k.field.what, side: TEXELS_SIDE }; },
    filed: (t) => t % DAY === 0,
  }, fish, smalls.store ? smalls : null);
  for (const an of w.animals) if (herded(an.species) && an.obj === undefined) backed(w, an);
}
// The island days run before anyone wakes, for the animals' reserves and places to settle from where they're laid
// [design].
const SPIN_DAYS = 10;
export function animalDriver(w: World): AnimalDriver {
  const gr = groundFor(w), p = (w.pools ??= startPools(w, [W / 2, H / 2])), island = { landKm2: gr.land.length * TILE_KM2, shoreHa: gr.shoreHa };
  return {
    seed: w.seed, days: SPIN_DAYS, t0: w.t,
    tiles: () => gr.tiles,
    pools: () => {
      const out = new Uint32Array((W_.wasbare - W_.fg + 1) * T);
      for (const i of gr.land) {
        out[(W_.fg - W_.fg) * T + i] = q16(MOST / 2); out[(W_.bg - W_.fg) * T + i] = q16(MOST / 2);
        if (gr.shore[i]) out[(W_.shore - W_.fg) * T + i] = q16(SHORE_MOST);
      }
      return out;
    },
    drivers: () => gr.drivers,
    consts: (per) => lawConsts(per, island),
    start: () => startAnimals(w, gr, p.den, w.t - SPIN_DAYS * DAY),
    step(t, per) {
      const now = dayOf(t), before = dayOf(t - DAY / per), on = (at: number) => crossed(before, now, at);
      const kits = KITS_FROM > KITS_TO ? now >= KITS_FROM || now < KITS_TO : now >= KITS_FROM && now < KITS_TO;
      const flags = (on(RUT) ? FLAG.rut : 0) | (on(CALVING) ? FLAG.calve : 0) | (on(WHELPING) ? FLAG.whelp : 0) | (on(CUBBING) ? FLAG.cub : 0) | (kits ? FLAG.kits : 0)
        | (on(HERON_FLEDGE) ? FLAG.heron : 0) | (on(EAGLE_FLEDGE) ? FLAG.eagle : 0) | (on(GULL_FLEDGE) ? FLAG.gull : 0) | (on(CROW_FLEDGE) ? FLAG.crow : 0);
      return { day: Math.floor(now), flags };
    },
  };
}
// The island's first animals, as many as the herds settled at over the ten years of their checks on seed 1 (sec. 9): 4.6
// deer a km2, 1.9 rabbits a ha, 1.04 foxes a km2, 75 wolves a 1000 km2, 0.77 herons, 0.11 eagles, 5.8 gulls and 9.4 crows
// a km2 [design]; each kind spread over the island as it lives, deer by their ground layer and browse, rabbits by the
// ground their warrens reach, herons and gulls along the shore, the rest over the land, the wolves in packs of four
// (R368), the first denning some way from where people will wake; each at a point of its tile drawn from its own
// stream, of an age up to two years, half of them female, at half a full reserve.
const START_DENSITY: Record<Herded, number> = { deer: 4.6, rabbit: 190, wolf: 0.075, fox: 1.04, heron: 0.77, eagle: 0.11, gull: 5.8, crow: 9.4 };
const PACK = 4;
function startAnimals(w: World, gr: Ground, den: [number, number], tStart: number) {
  const cols: Record<string, number[]> = { x: [], y: [], sp: [], e: [], born: [], grp: [], hx: [], hy: [] };
  const lay = (sp: Herded, tile: number, grp = 0) => {
    const s = SP[sp], x = (tile % W) * TILE_MM + unif(TILE_MM), y = Math.floor(tile / W) * TILE_MM + unif(TILE_MM);
    cols.x.push(x); cols.y.push(y); cols.hx.push(x); cols.hy.push(y);
    cols.sp.push(s | (next32() < 0x80000000 ? 16 : 0));
    cols.e.push(Math.round((SPEC[sp].full * 1000) / 2) >>> 0);
    cols.born.push((tStart - unif(2 * YEAR)) >>> 0);
    cols.grp.push(grp);
  };
  const grass = (i: number) => gr.tiles[W_.grass * T + i] / 65536;
  const weight: Record<Herded, (i: number) => number> = {
    deer: (i) => Math.min(1, grass(i) + gr.woody[i]), rabbit: (i) => grass(i) * (gr.tiles[W_.warren * T + i] / 65536),
    wolf: () => 0, fox: () => 1, heron: (i) => gr.shore[i], gull: (i) => gr.shore[i], crow: () => 1, eagle: () => 1,
  };
  const landKm2 = gr.land.length * TILE_KM2;
  HERDED.forEach((sp, s) => {
    if (sp === "wolf") return;
    let all = 0;
    for (const i of gr.land) all += weight[sp](i);
    if (all <= 0) return;
    const each = (START_DENSITY[sp] * landKm2) / all;
    for (const i of gr.land) {
      rinit(w.seed, STREAM.start, i, s);
      const m = weight[sp](i) * each, n = Math.floor(m) + (next32() < q32(m - Math.floor(m)) ? 1 : 0);
      for (let k = 0; k < n; k++) lay(sp, i);
    }
  });
  const packs = Math.max(1, Math.round((START_DENSITY.wolf * landKm2) / PACK));
  for (let p = 0; p < packs; p++) {
    rinit(w.seed, STREAM.start, T + p, SP.wolf);
    const d = p === 0 ? Math.min(H - 1, Math.floor(den[1])) * W + Math.min(W - 1, Math.floor(den[0])) : gr.land[unif(gr.land.length)], first = cols.x.length;
    for (let k = 0; k < PACK; k++) lay("wolf", d, first + 1);
  }
  const n = cols.x.length, out: Record<string, Uint32Array> = {};
  for (const [name, v] of Object.entries(cols)) out[name] = Uint32Array.from(v);
  return { n, cols: out };
}

// ---------- the animals people see: views of their objects ----------
const CELL_MM = CELL * 1000, SEEN = Math.max(...HERDED.map((sp) => SPEC[sp].reveal));
const toMm = (p: number) => Math.max(0, Math.min(W * TILE_MM - 1, Math.round(p * TILE_MM)));
// An animal of the CPU's that has no object yet (put down by hand, fauna.ts) gets one, held where it stands; before the
// animals live on the GPU it waits, and gets it when they do (residentAnimals).
export function backed(w: World, an: Animal) {
  const s = animalsOf(w).store;
  if (!s || !herded(an.species)) return;
  const x = toMm(an.px), y = toMm(an.py), k = SPEC[an.species];
  an.obj = s.spawn(ANIMAL, {
    x, y, hx: x, hy: y, sp: SP[an.species] | 16, held: an.state === "trapped" ? 2 : 1, born: (an.born ?? w.t) >>> 0,
    e: Math.round((Math.max(0, Math.min(100, an.hunger)) / 100) * k.full * 1000),
  }).id;
}
// Each tick: the animals within sight of anyone awake stand on the ground as views of their objects, the CPU moving
// them while they're seen; those no one sees any longer go back to the GPU's moving; those the GPU found dead (starved,
// killed, or the year's other deaths) are gone. A view's id is its object's, so one seen again is the same animal.
function sync(w: World) {
  const s = animalsOf(w).store;
  if (!s) return;
  const m = s.mirror, awake = w.agents.filter((a) => a.down <= w.t), byObj = new Map<number, Animal>();
  for (const an of w.animals) {
    // one put down by hand since the last tick gets its object here
    if (an.obj === undefined) { backed(w, an); if (an.obj === undefined) continue; }
    if (an.obj < 0) { const o = m.spawned(an.obj); if (o && o.id >= 0) an.obj = o.id; }
    byObj.set(an.obj, an);
  }
  const seen = new Set<number>(), cells = new Set<number>(), r = Math.ceil(SEEN / CELL);
  for (const a of awake) {
    const cx = Math.floor((a.px * TILE_M) / CELL), cy = Math.floor((a.py * TILE_M) / CELL);
    for (let y = Math.max(0, cy - r); y <= Math.min(N - 1, cy + r); y++) for (let x = Math.max(0, cx - r); x <= Math.min(N - 1, cx + r); x++) cells.add(y * N + x);
  }
  for (const c of cells) {
    const objs = m.landed(ANIMAL, c % N, Math.floor(c / N));
    if (!objs) continue;
    for (const o of objs) {
      const sp = SPECIES_OF[o.v.sp & 15], px = o.v.x / TILE_MM, py = o.v.y / TILE_MM, rr = SPEC[sp].reveal / TILE_M;
      if (!awake.some((a) => (a.px - px) ** 2 + (a.py - py) ** 2 <= rr * rr)) continue;
      seen.add(o.id);
      let an = byObj.get(o.id);
      if (!an) {
        an = spawn(w, sp, px, py, { ...revealed(sp, px, py), id: `a${o.id}`, obj: o.id, born: o.v.born | 0 });
        byObj.set(o.id, an);
      }
      an.hunger = Math.max(0, Math.min(100, (100 * (o.v.e | 0)) / (SPEC[sp].full * 1000)));
      if (o.v.held === 0) s.set(o.id, "held", 1);
    }
  }
  const keep: Animal[] = [];
  for (const an of w.animals) {
    if (an.obj === undefined || an.obj < 0) { keep.push(an); continue; }
    const o = m.get(an.obj);
    // dead on the GPU: gone, but one in a pit stays for the pit to find (ecology.ts holes)
    if (o === null && an.state !== "trapped") continue;
    if (an.state === "trapped" || seen.has(an.obj) || o === null) { keep.push(an); continue; }
    if (typeof o === "object" && o.v.held === 1) s.set(an.obj, "held", 0);
  }
  if (keep.length !== w.animals.length) w.animals = keep;
}
// True once an animal's object has died on the GPU (starved in a pit, say).
export const perished = (w: World, an: Animal) => an.obj !== undefined && an.obj >= 0 && animalsOf(w).store?.mirror.get(an.obj) === null;
// One no longer about: killed, eaten, starved where it stood. Its object dies with it.
export function gone(w: World, an: Animal) {
  w.animals = w.animals.filter((x) => x !== an);
  if (an.species === "butterfly" && w.pools) { const i = tileOf(an); w.pools.butterfly[i] = Math.max(0, w.pools.butterfly[i] - 1); }
  const s = animalsOf(w).store;
  if (an.obj !== undefined && s && !perished(w, an)) s.kill(an.obj);
}
// What one ate goes to its own reserve, kJ.
function fed(w: World, an: Animal, kj: number) {
  const s = animalsOf(w).store;
  if (!herded(an.species) || an.obj === undefined || !s) return;
  const o = s.mirror.get(an.obj);
  if (!o || typeof o !== "object") return;
  s.set(an.obj, "fed", (o.v.fed + Math.round(kj * 1000)) >>> 0);
}
// One the CPU moved: its object stands where it does.
function moved(w: World, an: Animal, x0: number, y0: number) {
  if (an.species === "butterfly" && w.pools) {
    const from = tileOf({ px: x0, py: y0 }), to = tileOf(an);
    if (from !== to) { const n = w.pools.butterfly, m = Math.min(1, n[from]); n[from] -= m; n[to] += m; }
    return;
  }
  const s = animalsOf(w).store;
  if (an.obj === undefined || !s || (an.px === x0 && an.py === y0)) return;
  s.set(an.obj, "x", toMm(an.px));
  s.set(an.obj, "y", toMm(an.py));
}
// Every animal of a kind gone from the island (a probe's world with no wolves): the CPU's views now, their objects at
// the GPU's next submit (or once the animals live on the GPU).
export function cull(w: World, sp: Herded) {
  w.animals = w.animals.filter((m) => m.species !== sp);
  animalsOf(w).cull(SP[sp]);
}
// The animals of a kind standing in a 75 m cell as the last landing brought it, and the CPU's own of that kind there.
function inCell(w: World, sp: Herded, cx: number, cy: number) {
  const s = animalsOf(w).store, objs = s?.mirror.landed(ANIMAL, cx, cy);
  return objs ? objs.filter((o) => (o.v.sp & 15) === SP[sp]) : [];
}
// How many of a kind stand within m metres of a place: every one whose object the landings round people hold, and any
// the CPU has with no object yet.
export function herdNear(w: World, sp: Herded, at: { px: number; py: number }, m: number) {
  const r = m / TILE_M, x0 = Math.floor(((at.px - r) * TILE_M) / CELL), x1 = Math.floor(((at.px + r) * TILE_M) / CELL);
  const y0 = Math.floor(((at.py - r) * TILE_M) / CELL), y1 = Math.floor(((at.py + r) * TILE_M) / CELL);
  let n = w.animals.filter((x) => x.species === sp && x.obj === undefined && Math.hypot(x.px - at.px, x.py - at.py) <= r).length;
  for (let y = Math.max(0, y0); y <= Math.min(N - 1, y1); y++) for (let x = Math.max(0, x0); x <= Math.min(N - 1, x1); x++)
    for (const o of inCell(w, sp, x, y)) if (Math.hypot(o.v.x / TILE_MM - at.px, o.v.y / TILE_MM - at.py) <= r) n++;
  return n;
}
// How many of a kind are on a tile (one the people's landings hold).
export function onTile(w: World, sp: Herded, tile: number) {
  const tx = tile % W, ty = Math.floor(tile / W);
  let n = w.animals.filter((x) => x.species === sp && x.obj === undefined && tileOf(x) === tile).length;
  for (let q = 0; q < 4; q++) n += inCell(w, sp, 2 * tx + (q & 1), 2 * ty + (q >> 1)).length;
  return n;
}
// How many of each kind are alive: the GPU's censuses, the butterflies' counts, and the rest one by one.
export function census(w: World) {
  const count: Record<string, number> = {}, host = animalsOf(w);
  for (const a of w.animals) if (a.hp > 0 && a.obj === undefined && a.species !== "butterfly") count[a.species] = (count[a.species] ?? 0) + 1;
  if (host.store) HERDED.forEach((sp, s) => { count[sp] = host.census[s]; });
  if (fishOf(w).store) count.fish = fishCount(w);
  if (w.pools) count.butterfly = Math.round(w.pools.butterfly.reduce((s, x) => s + x, 0));
  return count;
}
// A cut of meat lying about, to a wolf that eats it, kJ (fuel.ts).
const MEAT_KJ = PHYS.meat.mass * PHYS.meat.kj!;

// ---------- what they do within sight ----------
// Agents being attacked this tick, agent id -> wolf id.
export const attacked = new Map<string, string>();

type Near = { awake: Agent[]; fires: Thing[]; wolves: Animal[]; foxes: Animal[]; deer: Animal[]; rabbits: Animal[]; eagles: Animal[]; fish: Animal[] };
function closest<T extends { px: number; py: number }>(from: { px: number; py: number }, list: readonly T[], r: number, ok: (t: T) => boolean = () => true) {
  let best: T | null = null, bd = r;
  for (const o of list) { const d = meters(from, o); if (d <= bd && o !== (from as unknown) && ok(o)) { bd = d; best = o; } }
  return best;
}
const ground = (w: World, x: number, y: number) => walkable(w, x, y);
const air = () => true;
const passOf = (sp: AnimalSpecies) => (FAUNA[sp].ground ? ground : air);
// Where each kind can be at a point: fish in standing water, anything that walks on dry ground or ice, birds anywhere.
const pointOf = (sp: AnimalSpecies) => (sp === "fish" ? wetAt : FAUNA[sp].ground ? dryAt : air);
function face(an: Animal) { an.dx = Math.round(Math.cos(an.heading)); an.dy = Math.round(Math.sin(an.heading)); }
function setState(w: World, an: Animal, s: string) { if (an.state !== s) { an.state = s; an.since = w.t; } }
const inState = (w: World, an: Animal) => w.t - (an.since ?? w.t);
// A fixed per-animal number below n, so a flock doesn't fly at one height or wake all at once.
const quirk = (an: Animal, n: number) => (Math.imul(Number(an.id.slice(1)) || 1, 2654435761) >>> 0) % n;
function goTo(w: World, an: Animal, tx: number, ty: number, speed: number) { steer(w, an, tx, ty, speed, passOf(an.species), pointOf(an.species), an.species === "deer" || an.species === "wolf"); face(an); }
function away(w: World, an: Animal, from: { px: number; py: number }, speed: number) {
  const d = Math.hypot(an.px - from.px, an.py - from.py) || 1e-6;
  goTo(w, an, an.px + ((an.px - from.px) / d) * 0.2, an.py + ((an.py - from.py) / d) * 0.2, speed);
}
// A point pulled back inside the map, so nothing heads for somewhere it can never reach.
const onMap = (x: number, y: number): [number, number] => [Math.max(0.05, Math.min(W - 0.05, x)), Math.max(0.05, Math.min(W - 0.05, y))];
// Amble about near home, keeping one heading for a while.
function roam(w: World, an: Animal, r: number, speed: number, odds = 0.35) {
  const home = an.home ?? [an.px, an.py];
  if (!an.aim || Math.hypot(an.aim[0] - an.px, an.aim[1] - an.py) * TILE_M < 1 || Math.random() < 0.02) {
    const a = Math.random() * Math.PI * 2, d = (Math.random() * r) / TILE_M;
    an.aim = onMap(home[0] + Math.cos(a) * d, home[1] + Math.sin(a) * d);
  }
  if (Math.random() < odds) goTo(w, an, an.aim[0], an.aim[1], speed);
}
function carcass(w: World, an: Animal) {
  gone(w, an);
  for (const [k, n] of Object.entries(herded(an.species) ? carcassOf(an.species, fatOf(an.species, an.hunger)) : {})) dropPile(w, an.px, an.py, k, n);
}
const lift = (an: Animal, to: number, rate: number) => { an.alt = Math.round((an.alt + Math.max(-rate, Math.min(rate, to - an.alt))) * 10) / 10; };

// Grazing crops the grass tufts close by, down to a stub that grows back in its own time.
function nibble(w: World, an: Animal) {
  if (Math.random() > 0.02) return;
  const t = nearestThing(w, an.px, an.py, ["grass"], (g) => (g.hp ?? 0) > 1, 2);
  if (!t) return;
  t.hp = (t.hp ?? 3) - 1; t.size = Math.round(t.size * 80) / 100; mark(w, t);
}

// How much a grazer finds to eat at a point, 0..1 (the generator's cover): the grass the snow leaves to get at, and the
// twigs, buds and bark of shrubs and young trees, which stand above it.
function grassAt(w: World, px: number, py: number) {
  const { fine } = groundOf(w.seed), x = px * TILE_M - SIZE / 2, z = py * TILE_M - SIZE / 2, snow = snowAt(w, px, py);
  const browse = fine.fine(fine.cover.shrub, x, z) * 0.6 + fine.fine(fine.cover.tree, x, z) * 0.3;
  return Math.min(1, fine.fine(fine.cover.grass, x, z) * (1 - 0.7 * snow) + browse * (1 - 0.3 * snow));
}
const forage = (w: World, an: Animal) => grassAt(w, an.px, an.py);
// Better grazing than here, if there is any: the best of a few dry points out to r meters.
function pasture(w: World, an: Animal, r: number): [number, number] | null {
  let best: [number, number] | null = null, bv = forage(w, an) + 0.1;
  for (let k = 0; k < 8; k++) {
    const a = Math.random() * Math.PI * 2, d = ((0.3 + Math.random() * 0.7) * r) / TILE_M, [x, y] = onMap(an.px + Math.cos(a) * d, an.py + Math.sin(a) * d);
    if (!dryAt(w, x, y)) continue;
    const v = grassAt(w, x, y);
    if (v > bv) { bv = v; best = [x, y]; }
  }
  return best;
}

// What a deer, a rabbit or a wolf eats and burns, and the young they bear, are its object's (src/gpu/animals.ts): here,
// only what each one standing in sight of people does.
function deer(w: World, d: Animal, n: Near) {
  const threat = closest(d, n.wolves, 60) ?? closest(d, n.awake, 30);
  if (threat || d.hp < d.maxHp * 0.6) {
    setState(w, d, "flee");
    // A deer bolts only a few ticks before it has to slow to a trot.
    if (threat) away(w, d, threat, inState(w, d) > 4 ? 2 : FAUNA.deer.run);
    else roam(w, d, 40, FAUNA.deer.walk);
  } else {
    const food = d.hunger < 90 ? forage(w, d) : 0, grass = food > 0.25;
    setState(w, d, grass ? "graze" : "wander");
    if (grass) nibble(w, d);
    // Where the grass is poor, a hungry deer moves on to better and keeps to it.
    if (!grass && d.hunger < 85 && Math.random() < 0.05) { const better = pasture(w, d, 400); if (better) { d.home = better; d.aim = better; } }
    const mate = closest(d, n.deer, 200);
    if (mate && meters(d, mate) > 25 && Math.random() < 0.3) goTo(w, d, mate.px, mate.py, FAUNA.deer.walk);
    else if (!grass || Math.random() < 0.15) roam(w, d, 60, FAUNA.deer.walk);
  }
}

// A wolf eats its fill at a kill and goes days before it needs another; a pack takes a deer every few days.
function wolf(w: World, wf: Animal, n: Near) {
  const cold = coldBite(w.weather.temp);
  const fire = closest(wf, n.fires, 40), crowd = n.awake.filter((a) => meters(a, wf) <= 15).length >= 2;
  if (fire || crowd || wf.hp < wf.maxHp * 0.4) {
    setState(w, wf, "flee");
    const from = fire ?? closest(wf, n.awake, 30);
    if (from) away(w, wf, from, FAUNA.wolf.run);
    wf.target = undefined;
    return;
  }
  const meat = wf.hunger < 70 ? nearestThing(w, wf.px, wf.py, ["item"], (t) => t.item === "meat" || !!t.item?.startsWith("rotten:meat"), 80) : null;
  if (meat) {
    setState(w, wf, "eat");
    if (meters(wf, meat) <= 1.5) {
      meat.n = (meat.n ?? 1) - 1; fed(w, wf, MEAT_KJ); mark(w, meat);
      if (meat.n <= 0) removeThing(w, meat);
    } else goTo(w, wf, meat.px, meat.py, FAUNA.wolf.walk * 2);
    return;
  }
  // whichever is nearer of a deer in sight or a rabbit close by
  const deerNear = wf.hunger < 50 ? closest(wf, n.deer, 400) : null, rabbitNear = wf.hunger < 50 ? closest(wf, n.rabbits, 200) : null;
  const prey = deerNear && rabbitNear ? (meters(wf, deerNear) < meters(wf, rabbitNear) ? deerNear : rabbitNear) : deerNear ?? rabbitNear;
  const lone = (a: Agent) => n.awake.every((b) => b === a || meters(a, b) > 30) && !closest(a, n.fires, 40);
  // A starving wolf takes anyone alone; a hungry one only someone out alone in the dark, or in a hard frost.
  const stalks = (a: Agent) => wf.hunger < 12 || (wf.hunger < 25 && (cold > 0.8 || lightOn(w, a).bright < DARK));
  const person = !prey && wf.hunger < 30 ? closest(wf, n.awake, 150, (a) => lone(a) && stalks(a)) : null;
  const target: Animal | Agent | null = person ?? prey;
  // Nothing in sight: a hungry pack follows the scent of the nearest herd, or of rabbits, and settles where it hunts.
  const scent = !target && wf.hunger < 50 ? closest(wf, n.deer, 3000) ?? closest(wf, n.rabbits, 1500) : null;
  if (scent) {
    setState(w, wf, "hunt"); wf.target = undefined;
    wf.home = [scent.px, scent.py];
    goTo(w, wf, scent.px, scent.py, FAUNA.wolf.walk * 2);
    return;
  }
  if (!target) {
    setState(w, wf, "wander"); wf.target = undefined;
    const pack = closest(wf, n.wolves, 300);
    if (pack && meters(wf, pack) > 30 && Math.random() < 0.3) goTo(w, wf, pack.px, pack.py, FAUNA.wolf.walk);
    else roam(w, wf, 150, FAUNA.wolf.walk);
    return;
  }
  setState(w, wf, "hunt");
  if (meters(wf, target) > 2) { goTo(w, wf, target.px, target.py, FAUNA.wolf.run); return; }
  setState(w, wf, "attack");
  if ("species" in target) {
    target.hp -= 6;
    if (target.hp <= 0) {
      carcass(w, target);
      fed(w, wf, meal(target.species as "deer" | "rabbit"));
      log(w, "death", [], target, `Wolves brought down a ${target.species}.`);
      if (target.species === "deer") see(w, target, "breaks:deer", "A deer can be killed. It's all meat, hide, and bone inside.", animalSize(SPEC.deer.kg));
    }
  } else {
    target.needs.health = Math.max(0, target.needs.health - 5);
    if (wf.target !== target.id) log(w, "wolf", [target.id], target, `A wolf attacked ${target.name}!`);
    wf.target = target.id;
    attacked.set(target.id, wf.id);
    trace("animal", "attack", { wolf: wf.id, victim: target.id, health: target.needs.health }, target.id);
  }
}

// A fox keeps clear of people and wolves, and when hungry runs down the nearest rabbit and eats it where it falls.
function fox(w: World, f: Animal, n: Near) {
  const threat = closest(f, n.awake, 40) ?? closest(f, n.wolves, 80);
  if (threat) { setState(w, f, "flee"); away(w, f, threat, FAUNA.fox.run); return; }
  const prey = f.hunger < 70 ? closest(f, n.rabbits, 100) : null;
  if (!prey) { setState(w, f, "wander"); roam(w, f, 150, FAUNA.fox.walk); return; }
  setState(w, f, "hunt");
  if (meters(f, prey) > 1.5) { goTo(w, f, prey.px, prey.py, FAUNA.fox.run); return; }
  setState(w, f, "eat");
  gone(w, prey);
  fed(w, f, meal("rabbit"));
  log(w, "death", [], prey, "A fox caught a rabbit.");
}

function rabbit(w: World, r: Animal, n: Near) {
  const diving = n.eagles.find((e) => e.state === "dive" && meters(e, r) < 30);
  const threat = closest(r, n.awake, 15) ?? closest(r, n.wolves, 40) ?? closest(r, n.foxes, 30) ?? diving ?? null;
  // A rabbit bolts a few ticks, then freezes flat and hopes not to be seen.
  if (threat) { setState(w, r, "flee"); if (inState(w, r) <= 3) away(w, r, threat, FAUNA.rabbit.run); return; }
  setState(w, r, forage(w, r) > 0.25 ? "graze" : "wander");
  if (r.state === "graze") nibble(w, r);
  // Grazing rabbits sit still, then hop a couple of meters.
  roam(w, r, 25, 2, 0.12);
}

// A fish seen swims where its object is (waters.ts showFish); the GPU moves it once a day.
function fish(w: World, f: Animal) {
  setState(w, f, "swim");
}

// A random point along the water's edge within r meters of a place.
function shoreNear(w: World, from: [number, number], r: number): [number, number] | null {
  const s = shoreOf(w);
  for (let tries = 0; tries < 60 && s.length; tries++) {
    const c = s[Math.floor(Math.random() * s.length)];
    if (Math.hypot(c.px - from[0], c.py - from[1]) * TILE_M <= r) return [c.px, c.py];
  }
  return edgeNear(w, { px: from[0], py: from[1] }, r);
}
// Up and away to aim, landing on arrival; returns true while still in the air.
function flight(w: World, an: Animal, cruise: number, land = 0) {
  if (!an.aim) return false;
  const d = Math.hypot(an.aim[0] - an.px, an.aim[1] - an.py) * TILE_M;
  if (d > 30) lift(an, cruise, 4);
  else lift(an, land, 3);
  if (d > 0.5) goTo(w, an, an.aim[0], an.aim[1], FAUNA[an.species].fly! * (an.alt > 2 ? 1 : 0.3));
  return d > 0.5 || Math.abs(an.alt - land) > 0.05;
}

// At the water's edge: standing water within a meter of the point, the shallows a heron wades.
const atEdge = (w: World, x: number, y: number) =>
  wetAt(w, x, y) || [0, 1, 2, 3, 4, 5, 6, 7].some((k) => wetAt(w, x + Math.cos((k * Math.PI) / 4) / TILE_M, y + Math.sin((k * Math.PI) / 4) / TILE_M));
// The nearest point along the water's edge within r meters, from the island's shore points: only the tiles within r
// are looked at, and among equally near points the first in shoreOf's order wins, as a scan of the whole coast would.
function edgeNear(w: World, from: { px: number; py: number }, r: number): [number, number] | null {
  const s = shoreOf(w), g = shoreByTile(w), reach = Math.ceil(r / TILE_M), x0 = Math.floor(from.px), y0 = Math.floor(from.py);
  let best = -1, bd = r;
  for (let y = Math.max(0, y0 - reach); y <= Math.min(H - 1, y0 + reach); y++)
    for (let x = Math.max(0, x0 - reach); x <= Math.min(W - 1, x0 + reach); x++)
      for (const i of g[y * W + x]) { const d = meters(from, s[i]); if (d < bd || (d === bd && i < best)) { bd = d; best = i; } }
  return best >= 0 ? [s[best].px, s[best].py] : null;
}
function heron(w: World, h: Animal, n: Near) {
  if (h.state === "fly") {
    if (!flight(w, h, 15)) { h.alt = 0; setState(w, h, atEdge(w, h.px, h.py) ? "wade" : "wander"); }
    return;
  }
  if (closest(h, n.awake, 30)) {
    h.aim = shoreNear(w, h.home ?? [h.px, h.py], 500) ?? h.aim;
    setState(w, h, "fly");
    return;
  }
  if (isNight(w.t)) { setState(w, h, "rest"); return; }
  // Off the edge: walk back to it if it's close, fly to the nearest stretch of shore if not.
  if (!atEdge(w, h.px, h.py)) {
    const edge = edgeNear(w, h, 600);
    if (!edge) { setState(w, h, "wander"); return; }
    if (meters(h, { px: edge[0], py: edge[1] }) > 15) { h.aim = edge; setState(w, h, "fly"); return; }
    setState(w, h, "wander");
    steer(w, h, edge[0], edge[1], FAUNA.heron.walk * 2, () => true, dryAt);
    return;
  }
  if (h.state === "feed" && inState(w, h) < 6) return;
  setState(w, h, Math.random() < 0.02 ? "feed" : "wade");
  // Stalking along the shallows, one slow step at a time, never leaving the edge.
  if (Math.random() < 0.2) {
    const a = h.heading + (Math.random() - 0.5) * 1.5;
    if (!steer(w, h, h.px + Math.cos(a) / TILE_M, h.py + Math.sin(a) / TILE_M, FAUNA.heron.walk, () => true, atEdge)) h.heading += Math.PI;
  }
}

function gull(w: World, g: Animal) {
  const home = g.home ?? [g.px, g.py];
  if (g.state === "rest") {
    if ((!isNight(w.t) && inState(w, g) > 40) || Math.random() < 0.002) setState(w, g, "fly");
    return;
  }
  if (g.state === "land") {
    // Settle wherever it is if the shore it wanted takes too long to reach: on the water or the beach alike.
    if (!flight(w, g, 12) || inState(w, g) > 40) { g.alt = 0; setState(w, g, "rest"); }
    return;
  }
  if (g.state === "feed") {
    lift(g, 0.5, 4);
    if (inState(w, g) > 5) setState(w, g, "fly");
    return;
  }
  if (isNight(w.t) || Math.random() < 0.003) { g.aim = shoreNear(w, home, 400) ?? onMap(g.px, g.py); setState(w, g, "land"); return; }
  if (Math.random() < 0.01 && wetAt(w, g.px, g.py)) { setState(w, g, "feed"); return; }
  setState(w, g, "fly");
  lift(g, 10 + quirk(g, 20), 2);
  roam(w, g, 400, FAUNA.gull.fly!, 1);
}

// What a bird can sit on, and how high its top is in meters.
const PERCH: Record<string, (t: Thing) => number> = {
  tree: (t) => t.size, stump: (t) => t.size, burnt_stump: (t) => t.size, boulder: (t) => t.size * 0.8, fallen_log: () => 0.5,
  structure: (t) => [0.5, 1.8, 2.5, 3.2][t.shelter?.tier ?? 0],
};
const perchHeight = (t?: Thing) => (t && PERCH[t.kind] ? Math.round(PERCH[t.kind](t) * 10) / 10 : 0);
// A perched bird sits on its perch's top, or on the ground if it has none; if the perch was cut, burned or taken away it
// takes off again.
function holdPerch(w: World, an: Animal) {
  const t = thingById(w, an.target);
  if (an.target && (!t || !PERCH[t.kind] || meters(an, t) > 1.5)) {
    an.target = undefined; an.aim = [an.px, an.py];
    setState(w, an, an.species === "eagle" ? "soar" : "fly");
    return false;
  }
  an.alt = perchHeight(t);
  return true;
}

function crow(w: World, c: Animal, n: Near) {
  const home = c.home ?? [c.px, c.py];
  const perch = () => {
    const tree = nearestThing(w, c.px, c.py, ["tree"], (t) => meters(c, t) > 15, 120);
    if (!tree) return false;
    c.aim = [tree.px, tree.py]; c.target = tree.id;
    setState(w, c, "fly");
    return true;
  };
  if (c.state === "fly") {
    const tree = thingById(w, c.target), perchable = !!tree && !!PERCH[tree.kind];
    if (!flight(w, c, 12, perchable ? perchHeight(tree) : 0)) { if (!perchable) c.target = undefined; setState(w, c, perchable ? "perch" : "feed"); }
    return;
  }
  if (c.state === "perch") {
    if (!holdPerch(w, c)) return;
    if (!isNight(w.t) && (inState(w, c) > 30 + quirk(c, 70) || Math.random() < 0.005)) {
      const a = Math.random() * Math.PI * 2, d = (Math.random() * 60) / TILE_M;
      c.aim = [home[0] + Math.cos(a) * d, home[1] + Math.sin(a) * d]; c.target = undefined;
      if (walkable(w, Math.floor(c.aim[0]), Math.floor(c.aim[1]))) setState(w, c, "fly");
    }
    return;
  }
  if (closest(c, n.awake, 15) || isNight(w.t)) { if (!perch()) roam(w, c, 30, FAUNA.crow.run); return; }
  // Crows pick at anything dead that's left lying about.
  const meat = nearestThing(w, c.px, c.py, ["item"], (t) => t.item === "meat" || !!t.item?.startsWith("rotten:"), 60);
  if (meat && meters(c, meat) > 1) { c.aim = [meat.px, meat.py]; c.target = undefined; setState(w, c, "fly"); return; }
  setState(w, c, "feed");
  // and eats while it has room for it
  if (meat && c.hunger < 100) { meat.n = (meat.n ?? 1) - 1; mark(w, meat); if (meat.n <= 0) removeThing(w, meat); fed(w, c, MEAT_KJ); }
  if (Math.random() < 0.004) { perch(); return; }
  roam(w, c, 40, FAUNA.crow.walk, 0.3);
}

function eagle(w: World, e: Animal, n: Near) {
  const home = e.home ?? [e.px, e.py];
  if (e.state === "feed") { lift(e, 0, 5); if (inState(w, e) > 20) setState(w, e, "soar"); return; }
  if (e.state === "perch") { if (holdPerch(w, e) && !isNight(w.t)) { e.target = undefined; setState(w, e, "soar"); } return; }
  if (isNight(w.t)) {
    const tree = nearestThing(w, home[0], home[1], ["tree"], (t) => t.size > 12, 300);
    e.aim = tree ? [tree.px, tree.py] : home;
    if (!flight(w, e, 60, perchHeight(tree ?? undefined))) { e.target = tree?.id; setState(w, e, "perch"); }
    return;
  }
  if (e.state === "dive") {
    const prey = w.animals.find((r) => r.id === e.target);
    if (!prey) { e.target = undefined; setState(w, e, "soar"); return; }
    const d = meters(e, prey);
    lift(e, 0, 15);
    goTo(w, e, prey.px, prey.py, FAUNA.eagle.fly!);
    if (e.alt < 2 && d < 3) {
      const kj = prey.species === "fish" ? mealOf(fishKg(w, prey)) : meal(prey.species as "rabbit");
      gone(w, prey);
      fed(w, e, kj);
      e.target = undefined;
      setState(w, e, "feed");
    } else if (inState(w, e) > 12) { e.target = undefined; setState(w, e, "soar"); }
    return;
  }
  setState(w, e, "soar");
  // A hungry eagle stoops on a rabbit in the open or a fish near the surface; hungrier, it quarters the island for one.
  const prey = e.hunger < 50 ? closest(e, n.rabbits, 400, (r) => r.state !== "flee") ?? closest(e, n.fish, 400) : null;
  if (prey) { e.target = prey.id; setState(w, e, "dive"); return; }
  const far = e.hunger < 50 ? closest(e, [...n.rabbits, ...n.fish], Infinity) : null;
  if (far) { lift(e, 60, 3); goTo(w, e, far.px, far.py, FAUNA.eagle.fly!); return; }
  // Soaring: wide circles over home, drifting higher and lower on the air.
  lift(e, 60 + quirk(e, 60), 3);
  e.heading += 0.12;
  const r = 200 / TILE_M, ax = home[0] + Math.cos(e.heading) * r, ay = home[1] + Math.sin(e.heading) * r;
  goTo(w, e, ax, ay, FAUNA.eagle.fly!);
}

function butterfly(w: World, b: Animal, warm: boolean) {
  if (!warm || isNight(w.t)) { setState(w, b, "rest"); lift(b, 0.2, 0.5); return; }
  if (b.state === "feed") { if (inState(w, b) > 5 + quirk(b, 15)) setState(w, b, "flutter"); return; }
  const flower = thingById(w, b.target);
  if (flower) {
    goTo(w, b, flower.px, flower.py, FAUNA.butterfly.fly!);
    lift(b, flower.size * 0.6, 0.5);
    if (meters(b, flower) < 0.3) { b.target = undefined; setState(w, b, "feed"); }
    return;
  }
  b.target = undefined;
  if (Math.random() < 0.03) { b.target = nearestThing(w, b.px, b.py, ["flowers"], () => true, 8)?.id; if (b.target) return; }
  setState(w, b, "flutter");
  lift(b, 0.4 + Math.random() * 1.6, 0.6);
  roam(w, b, 30, FAUNA.butterfly.fly! * (0.4 + Math.random() * 0.6), 0.9);
}

// An animal that walks over a hidden pit falls in and stays there.
function caught(w: World, an: Animal, x0: number, y0: number) {
  const trap = onPath(w, x0, y0, an.px, an.py, 1, ["trap"], (t) => !t.caught);
  if (!trap) return;
  an.state = "trapped"; put(w, an, trap.px, trap.py); trap.caught = an.species; trap.until = w.t; mark(w, trap);
  const s = animalsOf(w).store;
  if (an.obj !== undefined && s) s.set(an.obj, "held", 2);
  const owner = w.agents.find((a) => a.id === trap.owner);
  log(w, "trap", owner ? [owner.id] : [], trap, `A ${an.species} fell into ${owner ? `${owner.name}'s` : "a"} hidden pit and couldn't get out.`);
  see(w, trap, "trap_works", "An animal that walks over a hidden pit falls in and is stuck.", trap.size);
}

export function animals(w: World) {
  sync(w);
  const awake = w.agents.filter((a) => a.down <= w.t);
  const of = (s: AnimalSpecies) => w.animals.filter((a) => a.species === s);
  const fires = [...liveThings(w)].filter((t) => t.kind === "fire");
  const n: Near = { awake, fires, wolves: of("wolf"), foxes: of("fox"), deer: of("deer"), rabbits: of("rabbit"), eagles: of("eagle"), fish: of("fish") };
  const warm = warmRate(w.weather.temp) > 0.3;
  // Whether an animal is still about. One that goes takes the list with it (it is replaced, never cut down in place), so
  // the set of those about is made again only then.
  let list = w.animals, about = new Set(list);
  const still = (an: Animal) => { if (w.animals !== list) { list = w.animals; about = new Set(list); } return about.has(an); };
  for (const an of [...w.animals]) {
    if (an.state === "trapped" || !still(an)) continue;
    const x0 = an.px, y0 = an.py;
    switch (an.species) {
      case "deer": deer(w, an, n); break;
      case "wolf": wolf(w, an, n); break;
      case "fox": fox(w, an, n); break;
      case "rabbit": rabbit(w, an, n); break;
      case "fish": fish(w, an); break;
      case "heron": heron(w, an, n); break;
      case "gull": gull(w, an); break;
      case "crow": crow(w, an, n); break;
      case "eagle": eagle(w, an, n); break;
      case "butterfly": butterfly(w, an, warm); break;
    }
    if (FAUNA[an.species].ground && still(an)) caught(w, an, x0, y0);
    if (still(an)) moved(w, an, x0, y0);
  }
  // Anything else left without food weakens and dies (the GPU's animals starve as their objects do).
  for (const an of w.animals) if (!herded(an.species) && an.hunger <= 0) an.hp -= 0.05;
  for (const an of w.animals.filter((a) => a.hp <= 0)) { gone(w, an); log(w, "death", [], an, an.hunger <= 0 ? `A ${an.species} starved.` : `A ${an.species} went through the ice and drowned.`); }
  // An hour of the butterflies, and the butterflies and fish stood within people's sight.
  if (w.t % 12 === 0) {
    if (w.pools) { butterflies(w, w.pools); reveal(w, (sp, px, py) => spawn(w, sp, px, py, revealed(sp, px, py))); }
    showFish(w, (px, py, id) => spawn(w, "fish", px, py, { ...revealed("fish", px, py), id: `a${id}`, obj: id }));
  }
}
