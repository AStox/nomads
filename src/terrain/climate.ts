// Climate from weather: air blows in off the sea from every direction, as often as the island's wind rose says, in every
// season. Where the ground lifts it, it cools and rains out its excess; where it sinks, it dries. Summing all of that
// gives rain, snow, fog, wind exposure and salt spray without drawing a single zone by hand.
import { clamp } from "math";
import { CELL, LEN, N, blur } from "./grid";

const LAPSE = 0.0065; // °C lost per meter climbed
// The game's own seasons: mean sea-level temperature, and each season's share of the year's storms.
export const SEASONS = [{ t: 12, wet: 0.22 }, { t: 24, wet: 0.16 }, { t: 10, wet: 0.32 }, { t: -4, wet: 0.3 }];
const MEAN_T = SEASONS.reduce((s, x) => s + x.t, 0) / 4;
const DIRS = 16, STEP = 1.5; // wind directions, and how far upwind each cell looks, in cells

// Water vapor air can hold at a temperature, g/kg (Magnus).
const qsat = (t: number) => 3.8 * Math.exp((17.67 * t) / (t + 243.5));

// Cells in downwind order, by counting sort on their position along the wind. The slices are thinner than the gap
// between a cell and the upwind corners it reads (at least 1.5 - √2 cells), so every read is already settled.
function downwind(order: Int32Array, c: number, s: number) {
  const SLICE = 0.05, lo = Math.min(0, (N - 1) * c) + Math.min(0, (N - 1) * s);
  const key = new Int32Array(LEN), count = new Int32Array(Math.ceil((N * 2) / SLICE) + 2);
  for (let i = 0; i < LEN; i++) {
    key[i] = Math.floor(((i % N) * c + Math.floor(i / N) * s - lo) / SLICE);
    count[key[i] + 1]++;
  }
  for (let k = 1; k < count.length; k++) count[k] += count[k - 1];
  for (let i = 0; i < LEN; i++) order[count[key[i]]++] = i;
}

export type Climate = {
  wind: [number, number]; // the way the prevailing wind blows
  precip: Float32Array; // mm a year
  seasons: { precip: Float32Array; pet: Float32Array }[]; // the same, and evaporative demand, for each of the game's seasons
  snow: Float32Array; // share of the year's precipitation that falls as snow
  fog: Float32Array; // share of wet weather spent inside cloud
  temp: Float32Array; // annual mean, °C
  pet: Float32Array; // potential evapotranspiration, mm a year
  exposure: Float32Array; // 0 sheltered .. 1 open to the prevailing gales
  salt: Float32Array; // 0 .. 1 salt spray off windward shores
};

// h: ground in meters. open: 1 over the sea and lakes, which give the air its moisture back.
export function climate(h: Float32Array, open: Uint8Array, rand: () => number): Climate {
  const prevailing = rand() * Math.PI * 2, wetness = 700 + rand() * 700;
  // A wind rose: mostly from one quarter, sometimes from anywhere.
  const rose = Array.from({ length: DIRS }, (_, k) => 0.25 + Math.exp(1.4 * Math.cos((k / DIRS) * Math.PI * 2 - prevailing)));
  const roseSum = rose.reduce((a, b) => a + b, 0);
  const z = new Float32Array(LEN);
  for (let i = 0; i < LEN; i++) z[i] = Math.max(0, h[i]);
  // Air flows over the hills' broad shape, not every gully, and takes a while to rain out what it condenses.
  const lifted = blur(z, 3);
  const S = SEASONS.length;
  const rainBy = SEASONS.map(() => new Float32Array(LEN)), snow = new Float32Array(LEN), fog = new Float32Array(LEN);
  const exposure = new Float32Array(LEN), salt = new Float32Array(LEN);
  // The air arriving at each cell: vapor and cloud water for each season, how sheltered, how far from open water.
  const q = new Float32Array(LEN * S), cloud = new Float32Array(LEN * S), shelter = new Float32Array(LEN), shore = new Float32Array(LEN);
  const moist = SEASONS.map(({ t }) => 0.95 * qsat(t));
  // What air can hold over each cell, and whether what falls there is snow, don't depend on the wind's direction.
  const cap = new Float32Array(LEN * S), frozen = new Uint8Array(LEN * S);
  for (let i = 0; i < LEN; i++)
    for (let si = 0; si < S; si++) {
      cap[i * S + si] = qsat(SEASONS[si].t - LAPSE * lifted[i]);
      frozen[i * S + si] = SEASONS[si].t - LAPSE * z[i] < 1 ? 1 : 0;
    }
  const order = new Int32Array(LEN);
  for (let k = 0; k < DIRS; k++) {
    const a = (k / DIRS) * Math.PI * 2, c = Math.cos(a), s = Math.sin(a), f = rose[k] / roseSum;
    downwind(order, c, s);
    for (const i of order) {
      const x = i % N, y = (i - x) / N, ux = x - c * STEP, uy = y - s * STEP;
      const off = ux < 0 || uy < 0 || ux > N - 1 || uy > N - 1;
      let j = 0, fx = 0, fy = 0;
      if (!off) { const x0 = Math.min(N - 2, ux | 0), y0 = Math.min(N - 2, uy | 0); fx = ux - x0; fy = uy - y0; j = y0 * N + x0; }
      const w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy), w01 = (1 - fx) * fy, w11 = fx * fy;
      const up = off ? 0 : z[j] * w00 + z[j + 1] * w10 + z[j + N] * w01 + z[j + N + 1] * w11;
      const was = off ? 0 : shelter[j] * w00 + shelter[j + 1] * w10 + shelter[j + N] * w01 + shelter[j + N + 1] * w11;
      shelter[i] = Math.max(was * 0.93, up - z[i]);
      shore[i] = open[i] || off ? 0 : shore[j] * w00 + shore[j + 1] * w10 + shore[j + N] * w01 + shore[j + N + 1] * w11 + STEP * CELL;
      exposure[i] += f * clamp(1 - shelter[i] / 60, 0, 1) * (0.35 + 0.65 * clamp(z[i] / 700, 0, 1));
      salt[i] += f * Math.exp(-shore[i] / 250);
      for (let si = 0; si < S; si++) {
        const a0 = j * S + si, a1 = a0 + S, a2 = a0 + N * S, a3 = a2 + S;
        let v = off ? moist[si] : q[a0] * w00 + q[a1] * w10 + q[a2] * w01 + q[a3] * w11;
        let w = off ? 0 : cloud[a0] * w00 + cloud[a1] * w10 + cloud[a2] * w01 + cloud[a3] * w11;
        const most = cap[i * S + si], wet = SEASONS[si].wet;
        // Air forced up a slope cools past saturation and the excess condenses into cloud. Sinking air warms and the
        // cloud evaporates again, which is what leaves a rain shadow behind the hills.
        if (v > most) { w += v - most; v = most; fog[i] += f * wet; }
        else { const back = Math.min(w, (most - v) * 0.3); w -= back; v += back; }
        // Cloud rains out over the next several cells; fronts drizzle a little everywhere.
        const fall = w * 0.15 + v * 0.0015;
        w *= 0.85; v *= 0.9985;
        if (open[i] && v < moist[si]) v += (moist[si] - v) * 0.08;
        q[i * S + si] = v; cloud[i * S + si] = w;
        const amount = f * wet * fall;
        rainBy[si][i] += amount;
        if (frozen[i * S + si]) snow[i] += amount;
      }
    }
  }
  let land = 0, sum = 0;
  for (let i = 0; i < LEN; i++) if (!open[i]) { land++; for (const r of rainBy) sum += r[i]; }
  const scale = wetness / (sum / Math.max(1, land));
  const precip = new Float32Array(LEN), temp = new Float32Array(LEN), pet = new Float32Array(LEN);
  const seasons = SEASONS.map((_, si) => ({ precip: rainBy[si], pet: new Float32Array(LEN) }));
  // The sun stands in the south (+y); slopes facing it dry out faster.
  const sun = [0, Math.cos(0.7), Math.sin(0.7)];
  const at = (x: number, y: number) => z[clamp(y, 0, N - 1) * N + clamp(x, 0, N - 1)];
  for (let i = 0; i < LEN; i++) {
    const x = i % N, y = (i - x) / N;
    let total = 0;
    for (const r of rainBy) { r[i] *= scale; total += r[i]; }
    precip[i] = total;
    snow[i] = total > 0 ? (snow[i] * scale) / total : 0;
    temp[i] = MEAN_T - LAPSE * z[i];
    const gx = (at(x + 1, y) - at(x - 1, y)) / (2 * CELL), gy = (at(x, y + 1) - at(x, y - 1)) / (2 * CELL);
    const lit = Math.max(0, -gx * sun[0] - gy * sun[1] + sun[2]) / Math.hypot(gx, gy, 1) / sun[2];
    const demand = 16.5 * lit * (1 + 0.25 * exposure[i]) * (1 - 0.3 * clamp(fog[i] * 3, 0, 1));
    for (const [si, { t }] of SEASONS.entries()) {
      seasons[si].pet[i] = demand * Math.max(0, t - LAPSE * z[i]);
      pet[i] += seasons[si].pet[i];
    }
  }
  return { wind: [Math.cos(prevailing), Math.sin(prevailing)], precip, seasons, snow, fog, temp, pet, exposure, salt };
}
