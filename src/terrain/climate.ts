// Climate from weather and the sun: air blows in off the sea from every direction, as often as the island's wind rose
// says, in every season. Where the ground lifts it, it cools and rains out its excess; where it sinks, it dries. The sun
// crosses the sky of each season as src/sim/sky.ts has it, and the hills shade one another from it. Summing all of that
// gives rain, snow, sunlight, warmth, wind, damp air and evaporation without drawing a single zone by hand.
import { clamp } from "math";
import { YEAR_DAYS, sunAt } from "../sim/sky";
import { CELL, LEN, N, blur, ramp, sample } from "./grid";

const LAPSE = 0.0065; // °C lost per meter climbed
// The game's own seasons, each a quarter of a year of weather: t, the mean air at sea level away from the coast; sea,
// the sea's own warmth, which lags the air by weeks; wet, the season's share of the year's storms; cloud, how much of
// its sky is overcast.
export const SEASONS = [
  { t: 12, sea: 9, wet: 0.22, cloud: 0.6 },
  { t: 24, sea: 16, wet: 0.16, cloud: 0.45 },
  { t: 10, sea: 14, wet: 0.32, cloud: 0.65 },
  { t: -4, sea: 7, wet: 0.3, cloud: 0.7 },
];
const SEASON_DAYS = 365.25 / 4; // real days of weather in each
// the game day in the middle of season s, the clock counting days from 1
export const midSeason = (s: number) => 1 + (YEAR_DAYS * (2 * s + 1)) / 8;
// How much colder, on a season's mean, the cold pooling on still, clear nights leaves the hollows where it lies deepest.
export const POOL_C = [1.2, 0.8, 1.5, 2];
export const DIRS = 16; // wind directions and horizon bearings: k points the way (cos, sin) of 2πk/DIRS, x east, y south
const STEP = 1.5; // how far upwind each cell looks, in cells

// Water vapor air can hold at a temperature, g/kg (Magnus).
const qsat = (t: number) => 3.8 * Math.exp((17.67 * t) / (t + 243.5));
// Its pressure, kPa.
const esat = (t: number) => 0.6108 * Math.exp((17.27 * t) / (t + 237.3));

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

export type Season = {
  precip: Float32Array; // mm over the season
  pet: Float32Array; // evaporative demand, mm over the season (FAO-56 reference evapotranspiration)
  sun: Float32Array; // sunlight reaching the ground, MJ/m² a day: on its own slope, in its hills' shadows, through cloud
  temp: Float32Array; // mean air, °C
  humid: Float32Array; // mean relative humidity, 0..1
  snowpack: Float32Array; // water lying as snow, mm, the season's mean
};
export type Climate = {
  wind: [number, number]; // the way the prevailing wind blows
  precip: Float32Array; // mm a year
  seasons: Season[]; // the same and more for each of the game's seasons
  snow: Float32Array; // share of the year's precipitation that falls as snow
  snowCover: Float32Array; // share of the year that snow lies on the ground
  fog: Float32Array; // share of wet weather spent inside cloud
  temp: Float32Array; // annual mean, °C
  pet: Float32Array; // evaporative demand, mm a year
  sun: Float32Array; // the year's sunlight on the ground against open level ground's
  sky: Float32Array; // share of the sky's dome open overhead, 0..1
  pool: Float32Array; // 0..1 how much cold air settles there on still, clear nights
  marine: Float32Array; // 0..1 how much the sea's air tempers the place
  breeze: Float32Array; // mean wind at head height on open ground, m/s
  lee: Uint8Array; // DIRS per cell: the wind there, blowing toward bearing k, as hundredths of the wind over open sea
  exposure: Float32Array; // 0 sheltered .. 1 open to the prevailing gales
  salt: Float32Array; // 0 .. 1 salt spray off windward shores
};

// The wind at head height over open sea, m/s, as an average over the year's weather.
export const SEA_WIND = 6;

// h: ground in meters. open: 1 over the sea and lakes, which give the air its moisture back.
export function climate(h: Float32Array, open: Uint8Array, rand: () => number): Climate {
  const prevailing = rand() * Math.PI * 2, wetness = 700 + rand() * 700;
  // A wind rose: mostly from one quarter, sometimes from anywhere.
  const rose = Array.from({ length: DIRS }, (_, k) => 0.25 + Math.exp(1.4 * Math.cos((k / DIRS) * Math.PI * 2 - prevailing)));
  const roseSum = rose.reduce((a, b) => a + b, 0);
  const z = new Float32Array(LEN);
  for (let i = 0; i < LEN; i++) z[i] = Math.max(0, h[i]);
  // How far a place stands above or below the ground around it, some 600 m out: knolls and ridges catch the wind, and
  // hollows and valley floors gather the cold air that slides off the slopes on still nights.
  const around = blur(z, 8);
  const a = airflow(z, open, around, rose.map((r) => r / roseSum));
  // Each season brings its share of the year's storms over the land; where they rain is the air's doing.
  const precip = new Float32Array(LEN);
  for (const [s, r] of a.rainBy.entries()) {
    let land = 0, sum = 0;
    for (let i = 0; i < LEN; i++) if (!open[i]) { land++; sum += r[i]; }
    const scale = (wetness * SEASONS[s].wet) / Math.max(1e-9, sum / Math.max(1, land));
    for (let i = 0; i < LEN; i++) { r[i] *= scale; precip[i] += r[i]; }
  }
  const lit = new Uint8Array(LEN);
  for (let i = 0; i < LEN; i++) lit[i] = h[i] > -2 ? 1 : 0;
  const shape = horizons(z, lit);
  const seasons: Season[] = SEASONS.map((_, si) => ({ precip: a.rainBy[si], pet: new Float32Array(LEN), sun: new Float32Array(LEN), temp: new Float32Array(LEN), humid: a.humidBy[si], snowpack: new Float32Array(LEN) }));
  const clearBy = SEASONS.map(() => new Float32Array(LEN)), flat = SEASONS.map((_, si) => sunlight(si, shape, lit, a.fog, seasons[si].sun, clearBy[si]));

  // ---------- warmth ----------
  // Cold air drains off the slopes on still, clear nights and lies in the hollows and on the valley floors.
  const pool = new Float32Array(LEN);
  for (let i = 0; i < LEN; i++) {
    if (open[i]) continue;
    const slope = Math.hypot(shape.nx[i], shape.ny[i]) / shape.nz[i];
    pool[i] = ramp(around[i] - z[i], 3, 40) * (1 - ramp(slope, 0.06, 0.25)) * (1 - 0.7 * a.exposure[i]);
  }
  // A season's mean air: the inland air at sea level, tempered toward the sea's own warmth by the sea air blowing in,
  // cooled with height, warmed on slopes that get more sun than open level ground (a quarter of a degree for each MJ),
  // and chilled where the night's cold pools.
  const temp = new Float32Array(LEN);
  for (let si = 0; si < SEASONS.length; si++) {
    const { t, sea } = SEASONS[si], T = seasons[si].temp, sun = seasons[si].sun;
    for (let i = 0; i < LEN; i++) {
      T[i] = h[i] < 0 && open[i] ? sea : t + 0.6 * a.marine[i] * (sea - t) - LAPSE * z[i] + 0.25 * (sun[i] - flat[si]) - POOL_C[si] * pool[i];
      temp[i] += T[i] / SEASONS.length;
    }
  }
  const { snow, snowCover } = snowYear(open, seasons);
  const pet = new Float32Array(LEN);
  for (let si = 0; si < SEASONS.length; si++) penman(seasons[si], clearBy[si], z, a.breeze, pet);
  const sun = new Float32Array(LEN), flatYear = flat.reduce((x, y) => x + y, 0);
  for (let i = 0; i < LEN; i++) { for (const s of seasons) sun[i] += s.sun[i]; sun[i] /= flatYear; }
  const { fog, exposure, salt, marine, breeze, lee } = a;
  return { wind: [Math.cos(prevailing), Math.sin(prevailing)], precip, seasons, snow, snowCover, fog, temp, pet, sun, sky: shape.sky, pool, marine, breeze, lee, exposure, salt };
}

// The air blowing across the island from each direction in turn, weighted by the wind rose (share): what it rains and
// how damp it is in each season, where it lifts into cloud, how hard it blows, and how far it has come from the sea.
function airflow(z: Float32Array, open: Uint8Array, around: Float32Array, share: number[]) {
  const S = SEASONS.length;
  // Air flows over the hills' broad shape, not every gully, and takes a while to rain out what it condenses.
  const lifted = blur(z, 3);
  const rainBy = SEASONS.map(() => new Float32Array(LEN)), humidBy = SEASONS.map(() => new Float32Array(LEN));
  const fog = new Float32Array(LEN), exposure = new Float32Array(LEN), salt = new Float32Array(LEN), marine = new Float32Array(LEN);
  const breeze = new Float32Array(LEN), lee = new Uint8Array(LEN * DIRS);
  // The air arriving at each cell: vapor and cloud water for each season, how sheltered, how far it has come over land.
  const q = new Float32Array(LEN * S), cloud = new Float32Array(LEN * S), shelter = new Float32Array(LEN), shore = new Float32Array(LEN);
  const moist = SEASONS.map(({ t }) => 0.99 * qsat(t)), wets = SEASONS.map((s) => s.wet);
  // What air can hold over each cell doesn't depend on the wind's direction; nor does what it could hold at the ground.
  const cap = new Float32Array(LEN * S), ground = new Float32Array(LEN * S);
  for (let i = 0; i < LEN; i++)
    for (let si = 0; si < S; si++) {
      cap[i * S + si] = qsat(SEASONS[si].t - LAPSE * lifted[i]);
      ground[i * S + si] = qsat(SEASONS[si].t - LAPSE * z[i]);
    }
  const order = new Int32Array(LEN);
  for (let k = 0; k < DIRS; k++) {
    const a = (k / DIRS) * Math.PI * 2, c = Math.cos(a), s = Math.sin(a), f = share[k];
    downwind(order, c, s);
    for (let n = 0; n < LEN; n++) {
      const i = order[n], x = i % N, y = (i - x) / N, ux = x - c * STEP, uy = y - s * STEP;
      const off = ux < 0 || uy < 0 || ux > N - 1 || uy > N - 1;
      let j = 0, fx = 0, fy = 0;
      if (!off) { const x0 = Math.min(N - 2, ux | 0), y0 = Math.min(N - 2, uy | 0); fx = ux - x0; fy = uy - y0; j = y0 * N + x0; }
      const w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy), w01 = (1 - fx) * fy, w11 = fx * fy;
      const up = off ? 0 : z[j] * w00 + z[j + 1] * w10 + z[j + N] * w01 + z[j + N + 1] * w11;
      const was = off ? 0 : shelter[j] * w00 + shelter[j + 1] * w10 + shelter[j + N] * w01 + shelter[j + N + 1] * w11;
      shelter[i] = Math.max(was * 0.93, up - z[i]);
      shore[i] = open[i] || off ? 0 : shore[j] * w00 + shore[j + 1] * w10 + shore[j + N] * w01 + shore[j + N + 1] * w11 + STEP * CELL;
      const clear = clamp(1 - shelter[i] / 60, 0, 1);
      exposure[i] += f * clear * (0.35 + 0.65 * clamp(z[i] / 700, 0, 1));
      salt[i] += f * Math.exp(-shore[i] / 250);
      marine[i] += f * Math.exp(-shore[i] / 4000);
      // The wind at head height: slowed by the land's roughness the further it has come over it and by the ground upwind
      // standing above, quickened with height and over knolls and ridges.
      const v = open[i] ? 1 : (0.35 + 0.65 * clear) * (0.72 + 0.28 * Math.exp(-shore[i] / 800)) * (1 + 0.6 * clamp(z[i] / 600, 0, 1)) * (1 + 0.4 * ramp(z[i] - around[i], 5, 60));
      lee[i * DIRS + k] = Math.min(255, Math.round(v * 100));
      breeze[i] += f * SEA_WIND * v;
      for (let si = 0; si < S; si++) {
        const a0 = j * S + si, a1 = a0 + S, a2 = a0 + N * S, a3 = a2 + S;
        let vap = off ? moist[si] : q[a0] * w00 + q[a1] * w10 + q[a2] * w01 + q[a3] * w11;
        let w = off ? 0 : cloud[a0] * w00 + cloud[a1] * w10 + cloud[a2] * w01 + cloud[a3] * w11;
        const most = cap[i * S + si], wet = wets[si];
        // Air forced up a slope cools past saturation and the excess condenses into cloud. Sinking air warms and the
        // cloud evaporates again, which is what leaves a rain shadow behind the hills.
        if (vap > most) { w += vap - most; vap = most; fog[i] += f * wet; }
        else { const back = Math.min(w, (most - vap) * 0.3); w -= back; vap += back; }
        // Cloud rains out over the next several cells; fronts drizzle a little everywhere.
        const fall = w * 0.15 + vap * 0.0015;
        w *= 0.85; vap *= 0.9985;
        if (open[i] && vap < moist[si]) vap += (moist[si] - vap) * 0.08;
        q[i * S + si] = vap; cloud[i * S + si] = w;
        rainBy[si][i] += f * wet * fall;
        // the day's mean humidity: the air's vapor against what it could hold at the ground, over a day that is warmer
        // than the dawn it saturates at
        humidBy[si][i] += f * Math.min(1, (0.82 * vap) / ground[i * S + si]);
      }
    }
  }
  return { rainBy, humidBy, fog, exposure, salt, marine, breeze, lee };
}

type Shape = { nx: Float32Array; ny: Float32Array; nz: Float32Array; hz: Float32Array; sky: Float32Array };
// Which way each cell faces (its unit normal: x east, y south, z up), and its horizon along each bearing, out to 8 km, as
// the tangent of the angle it stands at; sky, the share of the dome it leaves open.
function horizons(z: Float32Array, lit: Uint8Array): Shape {
  const at = (x: number, y: number) => z[clamp(y, 0, N - 1) * N + clamp(x, 0, N - 1)];
  const nx = new Float32Array(LEN), ny = new Float32Array(LEN), nz = new Float32Array(LEN), sky = new Float32Array(LEN).fill(1);
  const hz = new Float32Array(LEN * DIRS), reach: number[] = [];
  for (let d = 1; d < 110; d *= 1.2) reach.push(d);
  const cs = Array.from({ length: DIRS }, (_, k) => Math.cos((k / DIRS) * Math.PI * 2)), sn = Array.from({ length: DIRS }, (_, k) => Math.sin((k / DIRS) * Math.PI * 2));
  let peak = 0;
  for (let i = 0; i < LEN; i++) peak = Math.max(peak, z[i]);
  for (let i = 0; i < LEN; i++) {
    const x = i % N, y = (i - x) / N;
    const gx = (at(x + 1, y) - at(x - 1, y)) / (2 * CELL), gy = (at(x, y + 1) - at(x, y - 1)) / (2 * CELL), g = Math.hypot(gx, gy, 1);
    nx[i] = -gx / g; ny[i] = -gy / g; nz[i] = 1 / g;
    if (!lit[i]) continue;
    let open2 = 0;
    for (let k = 0; k < DIRS; k++) {
      const c = cs[k], s = sn[k];
      let top = 0;
      for (let r = 0; r < reach.length; r++) {
        const d = reach[r], px = x + c * d, py = y + s * d;
        // nothing further out could stand higher in the sky than what already does
        if (px < 0 || py < 0 || px > N - 1 || py > N - 1 || peak - z[i] <= top * d * CELL) break;
        top = Math.max(top, (sample(z, px, py) - z[i]) / (d * CELL));
      }
      hz[i * DIRS + k] = top;
      open2 += 1 / (1 + top * top); // cos² of the horizon's angle
    }
    sky[i] = open2 / DIRS;
  }
  return { nx, ny, nz, hz, sky };
}

// Season si's middle day through the hours a quarter at a time: the sun's beam at normal incidence and the clear sky's glow
// on level ground, W/m², by the air mass the light crosses (Kasten and Young; Meinel's beam; Liu and Jordan's diffuse
// share). On each cell: the beam where the hills leave the sun in sight, by how squarely the slope faces it, and the glow
// of the share of sky it sees. An overcast sky lets through a quarter of a clear day's light, all of it glow; hill fog
// adds its own. Fills out (MJ/m² a day through the season's cloud) and clear (the same under a clear sky); returns the
// same for open level ground.
function sunlight(si: number, shape: Shape, lit: Uint8Array, fog: Float32Array, out: Float32Array, clear: Float32Array) {
  const S0 = 1361, DT = 900, c0 = SEASONS[si].cloud, { nx, ny, nz, hz, sky } = shape;
  const sx: number[] = [], sy: number[] = [], sz: number[] = [], kf: number[] = [], tan: number[] = [], beam: number[] = [];
  let glow = 0, level = 0;
  for (let hour = 0; hour < 24; hour += DT / 3600) {
    const b = sunAt(midSeason(si), hour), sinEl = Math.sin(b.el);
    if (sinEl <= 0.005) continue;
    const am = 1 / (sinEl + 0.50572 * (b.el / (Math.PI / 180) + 6.07995) ** -1.6364), bn = S0 * 0.7 ** (am ** 0.678), cosEl = Math.cos(b.el);
    sx.push(cosEl * b.dir[0]); sy.push(cosEl * b.dir[1]); sz.push(sinEl); tan.push(b.tan); beam.push(bn);
    kf.push((((Math.atan2(b.dir[1], b.dir[0]) / (Math.PI * 2)) * DIRS) % DIRS + DIRS) % DIRS);
    const g = S0 * sinEl * Math.max(0.05, 0.271 - (0.294 * bn) / S0);
    glow += g; level += bn * sinEl + g;
  }
  const MJ = DT / 1e6, n = sz.length;
  for (let i = 0; i < LEN; i++) {
    if (!lit[i]) { out[i] = level * (1 - 0.75 * c0) * MJ; clear[i] = level * MJ; continue; }
    let b = 0;
    for (let p = 0; p < n; p++) {
      const k0 = Math.floor(kf[p]), k1 = (k0 + 1) % DIRS, t = kf[p] - k0;
      const face = nx[i] * sx[p] + ny[i] * sy[p] + nz[i] * sz[p];
      if (face > 0 && tan[p] > hz[i * DIRS + k0] * (1 - t) + hz[i * DIRS + k1] * t) b += beam[p] * face;
    }
    const c = Math.min(0.95, c0 + 0.5 * fog[i]), mine = b + glow * sky[i];
    out[i] = (mine * (1 - c) + 0.25 * c * level * sky[i]) * MJ;
    clear[i] = mine * MJ;
  }
  return level * (1 - 0.75 * c0) * MJ;
}

// A year of days through the seasons, twice over so the second starts from the first's end: the day's mean air drawn
// smoothly through the four seasons' means, snow falling for rain the colder the day, and lying until days above
// freezing (taken with their spread of warmer afternoons) and the sun melt it. The second year is what is kept: each
// season's mean snowpack, the share of the year it lies, and the share of the year's precipitation that fell as snow.
function snowYear(open: Uint8Array, seasons: Season[]) {
  const snow = new Float32Array(LEN), snowCover = new Float32Array(LEN);
  const C1 = new Float32Array(365), S1 = new Float32Array(365), C2 = new Float32Array(365), SI = new Uint8Array(365);
  for (let d = 0; d < 365; d++) {
    const th = 2 * Math.PI * (d / 365 - 1 / 8);
    C1[d] = Math.cos(th); S1[d] = Math.sin(th); C2[d] = Math.cos(2 * th); SI[d] = Math.min(3, Math.floor(d / SEASON_DAYS));
  }
  const P = new Float32Array(4), R = new Float32Array(4);
  for (let i = 0; i < LEN; i++) {
    if (open[i]) continue;
    const Tsp = seasons[0].temp[i], Tsu = seasons[1].temp[i], Tau = seasons[2].temp[i], Twi = seasons[3].temp[i];
    const mean = (Tsp + Tsu + Tau + Twi) / 4, a1 = (Tsp - Tau) / 2, b1 = (Tsu - Twi) / 2, a2 = (Tsp - Tsu + Tau - Twi) / 4;
    if (mean - Math.hypot(a1, b1) - Math.abs(a2) > 6) continue; // never cold enough for snow to lie
    for (let s = 0; s < 4; s++) { P[s] = seasons[s].precip[i] / SEASON_DAYS; R[s] = 0.25 * seasons[s].sun[i]; }
    let pack = 0, fell = 0, wet = 0;
    for (let d = 0; d < 730; d++) {
      const year = d % 365, si = SI[year], T = mean + a1 * C1[year] + b1 * S1[year] + a2 * C2[year], p = P[si];
      if (d >= 365) wet += p;
      // a day too warm for snow to fall or lie
      if (T > 6 && pack === 0) continue;
      const flakes = p / (1 + Math.exp((T - 1) / 1.5));
      // melt by the day's warmth above freezing, its colder and warmer days taken together, and by the sun
      const melt = (T > 4 ? 3 * T : 1.8 * Math.log1p(Math.exp(T / 0.6))) + R[si] * ramp(T, -3, 1);
      pack = Math.max(0, pack + flakes - melt);
      if (d < 365) continue;
      fell += flakes;
      seasons[si].snowpack[i] += pack / SEASON_DAYS;
      if (pack > 10) snowCover[i] += 1 / 365;
    }
    snow[i] = wet > 0 ? fell / wet : 0;
  }
  return { snow, snowCover };
}

// FAO-56's reference evapotranspiration (Penman-Monteith over short grass) for a season, into its pet and added to the
// year's: the sun's net warmth less the ground's own glow to the sky, and the wind carrying off damp air for dry; little
// of it while snow lies.
function penman(s: Season, clear: Float32Array, z: Float32Array, breeze: Float32Array, year: Float32Array) {
  const { temp: T, humid, sun, snowpack, pet: E } = s;
  for (let i = 0; i < LEN; i++) {
    const t = T[i], es = esat(t), ea = es * humid[i], d = (4098 * es) / (t + 237.3) ** 2, u = Math.max(0.5, breeze[i]);
    const gamma = 0.000665 * 101.3 * ((293 - LAPSE * z[i]) / 293) ** 5.26;
    const rnl = 4.903e-9 * (t + 273.16) ** 4 * (0.34 - 0.14 * Math.sqrt(ea)) * (1.35 * Math.min(1, sun[i] / Math.max(0.1, clear[i])) - 0.35);
    const rn = 0.77 * sun[i] - rnl;
    const day = Math.max(0, (0.408 * d * rn + ((gamma * 900) / (t + 273)) * u * (es - ea)) / (d + gamma * (1 + 0.34 * u)));
    E[i] = day * SEASON_DAYS * (1 - 0.8 * ramp(snowpack[i], 5, 40));
    year[i] += E[i];
  }
}
