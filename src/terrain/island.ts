// An island built from physics rather than painted on, in metres and years: a block of the crust raised against the
// rivers and slope creep that wear it down until the two balance, then overridden by the last ice sheet, which scoured
// its joints and left its till, then rained on by its own climate. Lakes, rivers, groundwater, soil and plants all
// follow from that. The island stands for Bornholm; every number is in docs/research/terrain-constants.md. The
// crust, its erosion, the ice and the hollows are made by the kernels of src/gpu/wgsl/terrain-upstream.ts out of the
// constants and types here, the climate, water and ground by the other stages' (src/gpu/terrain).
import { SANDSTONE, GRANITE, LIMESTONE, MUDSTONE, ROCKS } from "./geology";
import type { Climate } from "./climate";
import type { Ground } from "./ground";
import type { Hydro } from "./water";

export const DEG = Math.PI / 180;
// How fast the horst rises, m/yr, inverted from Bornholm's relief, which is inherited rather than a steady state, so the
// steady state is made to reproduce it: its highest summit stands (U / K) chi above the sea, with granite's K
// (geology.ts) and this generator's chi to its highest summit, 12.2 (seeds 1 to 3 give 12.6, 12.1 and 11.4 on the GPU's
// islands, and gave 12.7, 12.1 and 11.8 on the CPU's they replaced, run at U / K = 35 m), so Rytterknægten's 162 to 165 m
// (R528) gives 0.95 m a million years, inside the 0.8 to 7.7 m that Fennoscandian granite surfaces are measured to lower
// by (R531) [derived, inverted from Bornholm's relief].
export const U0 = (163.5 * ROCKS[GRANITE].erode) / 12.2;
// The share of the land on the crystalline horst: Bornholm's basement is about 400 of its 588 km2 (R528).
export const CRYSTALLINE = 400 / 588;
// How steeply the basement dips south under the sediments (R528, R529 for the dip) [design].
export const DIP = 0.05;
// The sediments from the basement up, m: their order is Bornholm's (R529); the Rabekke clay's and Robbedale sand's
// 40 m are cited there and the Arnager limestone's 20 m in R522; the rest are [design]. Above them all, greensand.
export const STACK: [number, number][] = [
  [SANDSTONE, 100], // Nexø and Hardeberga sandstone
  [MUDSTONE, 50], // Alum Shale
  [LIMESTONE, 10], // Komstad limestone
  [MUDSTONE, 100], // the graptolite shales
  [MUDSTONE, 40], // the Jurassic and Rabekke clays
  [SANDSTONE, 40], // Robbedale sand
  [MUDSTONE, 20], // Jydegård clay
  [SANDSTONE, 20], // Arnager greensand
  [LIMESTONE, 20], // Arnager limestone
];
export const STACK_TOP = STACK.reduce((t, [, m]) => t + m, 0);
// The sea floor's depth, m, at distances from the shore, m: Bornholm's, the median of 12 measured profiles off its
// granite coasts and of 12 off its sediments (R520).
export const SHORE = [0, 250, 500, 1000, 2000, 3000, 5000, 7500, 10000];
export const OFF_GRANITE = [0, 13.8, 18.3, 25.0, 37.9, 46.2, 59.2, 63.5, 65.2];
export const OFF_SEDIMENT = [0, 5.0, 9.8, 12.3, 15.8, 23.5, 34.8, 40.0, 42.2];
// The dolerite dykes: more than 250 in about 400 km2 of basement, mostly running NNE (R530). How long each is is a
// [gap] (1 km stands in); each is drawn one cell wide, the grid's floor, where the real ones are metres across.
export const DYKES = 250 / 400e6, DYKE_LEN = 1000;
// Fracture zones, each one cell wide (the real ones are a few metres to Ekkodalen's 60 m, R528): one set along the
// dykes (NNE) and one across them [design], about 1.5 km apart and 2 to 5 km long [design]. The ice cleared out their
// crushed rock to as much as 50 m (areal scour's shallower class, R531; each valley's depth drawn in that range
// [design]), leaving a sill at the middle of each long valley, its watershed (R528), 15% of its length to either side
// [design]. Each half then drains out of its end (R528: the streams of the basement follow these valleys, and a valley
// system crossing the granite holds two streams flowing the two ways from the sill), so a valley's floor falls to its
// ends and rises toward one only as far as the ice itself can have scoured an adverse slope: at most 1.5 times the
// ice sheet's surface slope (R1351). That slope is Nye's plastic profile's at Bornholm's distance from the margin,
// sqrt(tau / (2 rho g x)) (R1352): a basal shear stress of 90 kPa (R1352), ice at 917 kg/m3 [UNVERIFIED: the textbook
// value, not read], and the margin 300 km away, the 2.7 degrees of latitude from Bornholm to the Oder lobe's maximum
// Weichselian limit at Frankfurt (R532) [UNVERIFIED: the limit's place is from memory, the distance [derived]].
export const JOINTS = [20 * DEG, 110 * DEG], JOINT_GAP = 1500, SCOUR = 50, SILL = 0.15;
// Each set's lines run out to three quarters of the map's width either side of its middle; a valley is 2000 m plus up
// to 3000 m long, and the next begins 500 m plus up to 1500 m past its end [design].
export const JOINT_REACH = 0.75, VALLEY_LEN = [2000, 3000], VALLEY_GAP = [500, 1500];
// The step the priority flood raises a pit by above its spill height, m, so every cell drains: a hair in the erosion's
// many floods, a hundred times that over the finished ground, where the hollows are measured [design].
export const FLOOD_EPS = { erode: 1e-6, island: 1e-4 };
// The erosion's sixty implicit steps (the scheme is stable at any step, and its steady state does not depend on it
// [design]), run for three times the response time; creep's explicit substeps stay under 0.2 of the diffusion's
// stability limit [design]; and the gentle rise inland to start from, a metre a kilometre [design], so no ground starts flat.
export const ERODE = { steps: 60, times: 3, stable: 0.2, rise: 1e-3 };
const ICE_SHEAR = 90e3, ICE_DENSITY = 917, GRAVITY = 9.81, ICE_MARGIN = 300e3;
export const ADVERSE = 1.5 * Math.sqrt(ICE_SHEAR / (2 * ICE_DENSITY * GRAVITY * ICE_MARGIN));
// The water table lies a few metres below the ground in the basement (R522, R530): 3 m.
export const WATER_TABLE = 3;

export type Island = Climate & Ground & Hydro & {
  height: Float32Array; // ground elevation, m; the sea floor is below zero
  rock: Uint8Array; // the bedrock, an index into geology.ts ROCKS
  drift: Uint8Array; // what lies on the bedrock, an index into geology.ts DRIFTS
  driftDepth: Float32Array; // how thick it lies, m
};

// What the generator has made so far, for anyone who wants to watch it work: each stage's fields as they stand. They are
// the generator's own arrays, valid during the call: copy what you keep.
export type Stage =
  | { stage: "rock"; rock: Uint8Array; lift: Float32Array } // lift: the uplift as a share of the horst's
  | { stage: "erode"; step: number; steps: number; height: Float32Array; flow: Float32Array } // flow: drainage area, cells
  | { stage: "ice"; height: Float32Array; scour: Float32Array } // scour: how deep the ice cleared the joints, m
  | { stage: "climate"; height: Float32Array; precip: Float32Array; temp: Float32Array; snow: Float32Array; wind: [number, number] }
  | { stage: "water"; height: Float32Array; water: Float32Array; table: Float32Array; rivers: Hydro["rivers"]; springs: Hydro["springs"]; quick: number[] }
  | { stage: "soil"; height: Float32Array; water: Float32Array; rock: Uint8Array; ph: Float32Array; fertility: Float32Array }
  | { stage: "cover"; height: Float32Array; water: Float32Array; tree: Float32Array; shrub: Float32Array; grass: Float32Array; marsh: Float32Array; bare: Float32Array; sand: Float32Array };
export type Watch = (s: Stage) => void;

// Everything before the climate: the crust, its erosion, the ice's scour and till, and the hollows that may hold lakes.
export type Upstream = {
  land: Uint8Array; rock: Uint8Array; height: Float32Array; drift: Uint8Array; driftDepth: Float32Array;
  filled: Float32Array; // the height with every pit raised to its spill height plus FLOOD_EPS.island, m; below zero over the sea
  order: Int32Array; // every cell once, each after the cell it drains into, so a sum up the rivers can run in this order
  to: Int32Array; // the cell each drains to by steepest descent on the filled surface, itself where nothing lies lower
  basin: Uint8Array; hollow: Int32Array;
  open: Uint8Array; // 1 over the sea and the hollows deep enough to hold a lake
};
