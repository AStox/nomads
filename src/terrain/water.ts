// Water on and under the island (docs/research/terrain-constants.md sec. 11). What the rain leaves after the plants
// have drunk all soaks into the ground, and the rock carries it off as groundwater, faster through limestone and
// sandstone than through mudstone or granite. Where the rock cannot carry what soaks in, the water table stands at the
// ground and the rest comes straight back out and runs off in the same season. The groundwater comes out again where the
// water table meets the ground: in springs, in seeps along the valley sides, and through the beds of the streams, which
// keeps them running through a dry summer. A stream keeps a channel where its catchment and slope together are enough to
// cut one, as wide and deep as its bankfull flood makes it; it floods the low ground beside it where it is not too
// powerful to keep one, and meanders across that ground where it is powerful enough to move its banks. Hollows hold
// lakes where their inflow and the rain on them outlast their evaporation.
import { CELL, N, ramp } from "./grid";
import { DOLERITE, GRANITE, LIMESTONE, MELTWATER, MUDSTONE, PEAT, SANDSTONE, TILL_CLAY, TILL_SAND } from "./geology";

export const YEAR_S = 31_557_600, SEASON_S = YEAR_S / 4;
// The share of its volume a deposit gives up as the water table falls through it (specific yield): Johnson's fine sand
// 0.21 for the meltwater sand, Morris and Johnson's sandy till 0.16 and silty till 0.06 for the two tills, and hemic peat
// 0.15 to 0.42 (Boelter), so 0.285, for a fen's decomposed peat [derived]; where the rock is bare, its own: siltstone
// 0.12 for mudstone, fine sandstone 0.21, limestone 0.14, and the 0 of hard rock for granite and dolerite (R629, R630,
// R631). GEUS's national model takes 0.15 to 0.25 for its open aquifers (R632).
export const SY_DRIFT: Record<number, number> = { [TILL_CLAY]: 0.06, [TILL_SAND]: 0.16, [MELTWATER]: 0.21, [PEAT]: 0.285 };
export const SY_ROCK: Record<number, number> = { [MUDSTONE]: 0.12, [SANDSTONE]: 0.21, [LIMESTONE]: 0.14, [GRANITE]: 0, [DOLERITE]: 0 };
// mm of rain the soil holds for plants to drink between rains [gap]: FAO-56's TAW from ground.ts's texture (R221) would
// replace it, but the soil is made after the water
export const BUCKET = 100;
export const RHO = 1000, G = 9.81; // water's density, kg/m3, and gravity, m/s2
// A channel begins where the drainage area per metre of contour a and the slope S reach a S^2 = C (Montgomery and
// Dietrich, R555), C 25 to 200 m in the field. Inverted from Bornholm's 0.71 km of designated stream to the km2 (R534)
// over seeds 1 to 3 it is 24 m (26.2, 20.9, 25.5), just under the field's range, so the range's floor (sec. 11)
// [derived, inverted from Bornholm's drainage density].
export const HEAD_C = 25;
// Bankfull discharge against the mean: Bornholm's median annual maximum, 0.10 to 0.14 m3/s a km2 (R558), the bankfull
// flood's 1 to 2 years (R557), over its mean runoff, 7.9 l/s a km2 (R558), so 15.0 times the mean [derived].
export const BANKFULL = Math.sqrt(0.1 * 0.14) / 0.0079;
// Bankfull width w = alpha Qbf^0.5, alpha 2.48 where trees or shrubs hold 5% or more of the banks, 3.75 under grass
// (Soar and Thorne, R556).
export const WIDE_WOOD = 2.48, WIDE_GRASS = 3.75;
export const WOODED = 0.05;
// Bankfull depth d = 0.201 Qbf^0.336 D50^-0.025 S^-0.060 (Lee and Julien, R557), with the bed's grain the largest the
// bankfull flow moves, D50 = d S / (1.65 tau*), tau* 0.03 to 0.058 (Andrews, R557), its middle on a log scale [derived].
export const SHIELDS = Math.sqrt(0.03 * 0.058), SUBMERGED = 1.65;
// How a stream's width and depth follow its flow at one place: w ~ Q^0.26, d ~ Q^0.40 (Leopold and Maddock, R557).
export const AT_W = 0.26, AT_D = 0.4;
// Open water's crop coefficient: 1.05 under 2 m deep; over 5 m, 0.65 while the water stores heat (spring and summer)
// and 1.25 while it gives it back (autumn and winter) (FAO-56 Table 12, R559); linear between [design].
export const KC_SHALLOW = 1.05, KC_DEEP = [0.65, 0.65, 1.25, 1.25];
// Transmissivity of a valley's fill, m2/s: Bornholm's fault-valley wells, 6e-5 to 2e-3, the middle on a log scale
// (R522) [derived]. A stream whose flow falls below what this carries under its bed runs dry.
export const T_FILL = Math.sqrt(6e-5 * 2e-3);
// Bankfull specific stream power, W/m2: over 300 a stream is confined and keeps no floodplain; 10 to 300 it moves its
// banks and meanders; under 10 its banks stand still (Nanson and Croke, R562).
export const CONFINED = 300, STABLE = 10;
// The flood that sets the floodplain against the bankfull one [gap]: Bornholm's T-year floods (R558's Bilag 8) were not
// read, and twice the bankfull flow stands in.
export const FLOOD = 2;
// Meanders: wavelength 11.0 w^1.01 (Leopold and Wolman, R560) and belt 3.7 w^1.12 in feet (Williams, R561), so
// 4.27 w^1.12 in meters, w the bankfull width.
const WAVE = 11, BELT = 3.7 * 0.3048 ** -0.12;
// The priority flood's step, m (island.ts): the least fall from one cell to the next.
export const FALL = 1e-4;

// A stream's bankfull width, m, at bankfull discharge qbf, m3/s, with trees or shrubs on its banks or not.
export const bankWidth = (qbf: number, wooded: boolean) => (wooded ? WIDE_WOOD : WIDE_GRASS) * Math.sqrt(qbf);
// Its bankfull depth, m, on slope s, m/m, solved with the grain its bed keeps: d^1.025 = 0.201 Q^0.336 S^-0.085 (1.65 tau*)^0.025.
export const bankDepth = (qbf: number, s: number) => (0.201 * qbf ** 0.336 * s ** -0.085 * (SUBMERGED * SHIELDS) ** 0.025) ** (1 / 1.025);
// The width and depth of its water, m, at discharge q, from its bankfull width or depth at qbf.
export const widthOf = (q: number, qbf: number, wbf: number) => (qbf > 0 ? wbf * Math.max(0, q / qbf) ** AT_W : 0);
export const depthOf = (q: number, qbf: number, dbf: number) => (qbf > 0 ? dbf * Math.max(0, q / qbf) ** AT_D : 0);
// A stream's flow now, from its mean (q), the share of it that comes out of the ground (base), which runs all year, and
// how its runoff stands against its mean now (quick: the season's, raised by recent rain).
export const flowNow = (q: number, base: number, quick: number) => q * (base + (1 - base) * quick);
// A point on a stream: x, y in cells (fractional where it meanders), mean discharge m3/s, the share of it from
// groundwater, bankfull discharge m3/s, slope m/m, and the flow its valley's fill carries under its bed, m3/s.
export type River = [number, number, number, number, number, number, number];
export type Hydro = {
  water: Float32Array; // depth of standing water over the ground, m: the sea and lakes
  flow: Float32Array; // mean discharge through each cell, m³ a second
  seasonFlow: Float32Array[]; // the same in each of the game's seasons
  table: Float32Array; // depth of the year's mean water table below the ground, m; 0 under open water
  seasonTable: Float32Array[]; // its depth in the middle of each of the game's seasons, m; 0 under open water
  winterTable: Float32Array; // winter's (seasonTable's last), the one the forestry site classification reads
  dryTable: Float32Array; // the deepest it falls in the year, m: the acrotelm's floor; 0 under open water
  spring: Float32Array; // groundwater coming out at the surface in each cell, m³ a second: seeps, springs, stream beds
  base: Float32Array; // share of the flow through each cell that came out of the ground rather than off it
  valley: Float32Array; // 1 on floodplain: ground no higher above the stream it drains to than that stream's flood stands, 0 elsewhere
  channel: Uint8Array; // 1 where a stream keeps a channel
  qbf: Float32Array; // bankfull discharge, m³ a second
  slope: Float32Array; // the ground's fall to the cell it drains to, m/m
  power: Float32Array; // bankfull specific stream power on channel cells, W/m2 (wooded banks), 0 elsewhere
  quick: number[]; // the island's runoff in each season against its mean, which a stream's quick share follows
  rivers: River[][]; // channels, source to mouth
  springs: [number, number, number][]; // [x, y, m³/s] where groundwater comes out in a spring
  lakes: number; // how many lakes hold water
};

const chaikin = (p: River[]): River[] => [p[0], ...p.slice(0, -1).flatMap((a, i) => [a.map((v, k) => v * 0.75 + p[i + 1][k] * 0.25) as River, a.map((v, k) => v * 0.25 + p[i + 1][k] * 0.75) as River]), p.at(-1)!];
// The streams as they lie on the ground: rounded off the cell grid, wandering a few meters either way everywhere
// (4.5 m at a 127 m wavelength [design]), and in meanders where the bankfull flood moves the banks (R562), each with the
// wavelength and belt of its bankfull width (R560, R561), wooded banks taken as the island's commonest. A meander
// shorter than four steps of the line cannot be drawn, and its swing is evened out over a cell [design]. A line joins
// the one it flows into exactly where that one now lies.
export function shape(lines: River[][]): River[][] {
  const STEP = 0.08, ROUND = Math.round(1 / STEP), placed = new Map<number, [number, number]>(), out: River[][] = [];
  for (const [n, raw] of lines.entries()) {
    const end = raw.at(-1)!, endKey = Math.round(end[1]) * N + Math.round(end[0]), joins = placed.get(endKey);
    const smooth = chaikin(chaikin(raw));
    // every STEP cells along the smoothed line
    const pts: River[] = [smooth[0]];
    let carry = 0;
    for (let k = 1; k < smooth.length; k++) {
      const a = smooth[k - 1], b = smooth[k], len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      for (let s = STEP - carry; s <= len; s += STEP) { const t = s / len; pts.push(a.map((v, c) => v + (b[c] - v) * t) as River); }
      carry = (carry + len) % STEP;
    }
    if (pts.length < 2 || Math.hypot(pts.at(-1)![0] - end[0], pts.at(-1)![1] - end[1]) > 1e-3) pts.push(end);
    const total = (pts.length - 1) * STEP, phase = ((n * 2654435761) >>> 0) / 4294967296 * Math.PI * 2;
    // each point's meander: its swing either way and its wavelength, in cells
    const swing = new Float32Array(pts.length), wave = new Float32Array(pts.length);
    for (const [k, p] of pts.entries()) {
      const w = bankWidth(p[4], true), power = w > 0 ? (RHO * G * p[4] * p[5]) / w : 0;
      wave[k] = (WAVE * w ** 1.01) / CELL;
      if (power >= STABLE && power <= CONFINED && wave[k] >= 4 * STEP) swing[k] = (BELT * w ** 1.12 - w) / 2 / CELL;
    }
    const even = swing.map((_, k) => { let sum = 0, c = 0; for (let j = Math.max(0, k - ROUND); j <= Math.min(pts.length - 1, k + ROUND); j++) { sum += swing[j]; c++; } return sum / c; });
    let turn = phase;
    const moved = pts.map((p, k): River => {
      const a = pts[Math.max(0, k - 4)], b = pts[Math.min(pts.length - 1, k + 4)], dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy) || 1, s = k * STEP;
      turn += (2 * Math.PI * STEP) / Math.max(STEP, wave[k]);
      const ends = ramp(s, 0, 1) * ramp(total - s, 0, 1);
      const off = (even[k] * Math.sin(turn) + 0.06 * Math.sin((2 * Math.PI * s) / 1.7 + 2 * phase)) * ends;
      return [p[0] - (dy / l) * off, p[1] + (dx / l) * off, p[2], p[3], p[4], p[5], p[6]];
    });
    // the end lies on the line it joins, where that line now runs, and the last cell bends over to meet it
    if (joins) {
      const last = moved.at(-1)!, sx = joins[0] - last[0], sy = joins[1] - last[1];
      for (let k = 0; k < moved.length; k++) { const t = ramp(k * STEP, total - 1, total); moved[k][0] += sx * t; moved[k][1] += sy * t; }
    }
    for (let k = 0; k < raw.length - 1; k++) {
      const key = Math.round(raw[k][1]) * N + Math.round(raw[k][0]);
      if (placed.has(key)) continue;
      // the moved point nearest the cell's center
      let best = moved[0], bd = Infinity;
      for (let j = Math.max(0, Math.floor((k * 0.9) / STEP) - 12); j < Math.min(moved.length, Math.ceil((k * 1.5) / STEP) + 12); j++) { const d = Math.hypot(pts[j][0] - raw[k][0], pts[j][1] - raw[k][1]); if (d < bd) { bd = d; best = moved[j]; } }
      placed.set(key, [best[0], best[1]]);
    }
    out.push(moved);
  }
  return out;
}
