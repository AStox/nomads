// The water in everything lying out on the island, resident on the GPU and stepped every hour (law: wgsl/moisture.ts;
// plan docs/plans/2026-10-14-001-refactor-gpu-object-world-plan.md, Unit 12; docs/research/fire-constants.md secs. 5,
// 11, 20, 27f, 27g and 35). Each piece holds its own water, skin and heart (sec. 27g), drawing toward what the air
// where it lies would leave in dead stuff of its thickness, or soaking in the rain that reaches it:
// - a fallen log or a snag (deadwood.ts, kinds log and logup) holds its own, stepped by its own thickness and wood, and
//   lying or standing as its fall word says; one touched carries the water its dormant self held;
// - the sticks of the litterfall bins, the litter of leaves, needles and cured grass blades, and the 1-hour twigs lie in
//   every texel (18.75 m) the same for every member, as every one of them lies in the same air, rain and shade and is
//   as thick as the others of its class: so each texel holds one water for each class, which is each member's own
//   exactly (CLASSES); and standing dead stuff (dead twigs among the branches, dead stems and sticks clear of the
//   ground) the same, standing.
// The air: each cell's from the island's hour (its season's fields drawn between the seasons, the cold that pools in
// its hollows, the rain its season brings, slanting onto its slopes, the wind its ground upwind leaves), the crowns
// over each texel (gpu/crowns.ts) shading the sun and the wind and holding back the rain.
// All of it integer (fixed.ts's Q16 and the water in Q24, kg to the kg times 2^24), so every GPU gives the same words;
// this module's twin is the law's TypeScript single-step oracle, and the island's reference dead stuff (wetness.ts
// deadHour) is the twin stepped in the island's own air.
import { PHYS, WOODS, woodOf } from "../sim/fuel";
import { SPECIES } from "../terrain/flora";
import { N } from "../terrain/grid";
import { DIRS } from "../terrain/climate";
import { STICK_DIA, type Deadwood } from "./deadwood";
import { cover, readback, storage } from "./kernel";
import { mul64, qdiv, qexp, qmul, qsqrt } from "./fixed";
import { type Rider, type Store, genOfId, kindOfId, reload, savedArray, savedNumber, slotOfId } from "./store";
import type { Crowns } from "./crowns";
import { layered, layeredBy, SIDE, TEXELS, TEXEL_MM } from "./wgsl/crowns";
import { moistureCells, moistureGather, moistureLogs, moistureTexels, type MoistureLayout } from "./wgsl/moisture";
import { DAY, HOUR } from "../sim/ticks";

// ---------- the law's constants ----------
// How long a piece takes to come 63% of the way to new surroundings, hours (sec. 5, 20, 27f): as the square of its
// thickness from the 10-hour stick; green wood above fibre saturation as its thickness to the 1.5; herbaceous stuff
// drying as R34's weathered fine fuel does (2.2 h), though rain soaks it by the square law. Its skin answers the air in
// SKIN of its time and its heart the skin in HEART of it (sec. 27g).
export const tau = (d: number) => 10 * (d / 0.0127) ** 2;
export const tauGreen = (d: number) => 500 * (d / 0.025) ** 1.5;
export const TAU_HERB = 2.2, SKIN = 0.211, HEART = 0.782;
// Wood holds no free water below this (sec. 5).
export const FSP = 0.3;
// The wind at the tops of short grass against the wind at head height (sec. 14): what reaches dead stuff on the ground.
export const GROUND = Math.log(0.36 / 0.13) / Math.log((2 - 0.064) / 0.013);
// A crown's dead twigs: as thick as the brands burning trees shed, which are their twigs, 3 to 4 mm (sec. 6, R27; 30a).
export const CROWN_TWIG = 0.0035;
// The classes each texel holds the water of: a grass blade (the NFDRS herbaceous class's 0.61 mm: litter's leaves and
// needles, cured grass), a 1-hour twig (6.35 mm, sec. 5, 22e) and a stick (the litterfall's, deadwood.ts STICK_DIA) lying
// on the ground; a crown's dead twig and a stick standing clear of it.
export const CLASSES = [
  { name: "blade", d: 0.00061, lying: true, herb: true },
  { name: "twig", d: 0.00635, lying: true, herb: false },
  { name: "stick", d: STICK_DIA, lying: true, herb: false },
  { name: "crowntwig", d: CROWN_TWIG, lying: false, herb: false },
  { name: "standing", d: STICK_DIA, lying: false, herb: false },
] as const;
export const NC = CLASSES.length, TEXEL_WORDS = 2 * NC;

// Q16 and Q24.
const Q = (x: number) => Math.round(x * 65536);
const W24 = 1 << 24;
export const toW = (x: number) => Math.round(x * W24);
export const fromW = (w: number) => w / W24;

// The exact hour of the skin and heart's exchange (wetness.ts toward), as four Q16 coefficients: the skin's and heart's
// departures from the water they draw toward, s and c, become P s + Q c and R s + S c.
export function exchange(t: number): [number, number, number, number] {
  const a = 1 / (SKIN * t), b = 1 / (HEART * t);
  const tr = -(a + 2 * b), disc = Math.sqrt(tr * tr - 4 * a * b), l1 = (tr + disc) / 2, l2 = (tr - disc) / 2;
  const e1 = Math.exp(l1), e2 = Math.exp(l2), f = (l1 * e2 - l2 * e1) / (l1 - l2), g = (e1 - e2) / (l1 - l2);
  return [Q(f - g * (a + b)), Q(g * b), Q(g * b), Q(f - g * b)];
}
// A class's law: its most water (Q24), the face it turns to the rain for each kg (m2, Q16), and its exchange when
// soaking and when drying.
export type ClassLaw = { mmax: number; face: number; wet: number[]; dry: number[] };
function lawOf(rho: number, mmax: number, d: number, dryTau: number): ClassLaw {
  return { mmax: toW(mmax), face: Q(4 / (Math.PI * rho * d)), wet: exchange(tau(d)), dry: exchange(dryTau) };
}
export const CLASS_LAWS: ClassLaw[] = CLASSES.map((c) => {
  const x = c.herb ? PHYS.fiber : woodOf("generic", c.d, 1);
  return lawOf(x.rho, x.mmax, c.d, c.herb ? TAU_HERB : tau(c.d));
});
// Logs by their wood: a row a species (SPECIES order; generic wood for none), its most water (Q24), its face per mm of
// its diameter (Q16 m2 for each kg, divided by the diameter in mm) and the water of a tree just dead (its sapwood's and
// heartwood's mean, fuel.ts greenOf), Q24; and the exchange by diameter, LOG_STEP mm a row, dry and green.
export const LOG_ROWS = 32, LOG_STEP = 4, LOG_DIAS = 512;
export function logTables() {
  const rows = new Int32Array(LOG_ROWS * 4), ex = new Int32Array(LOG_DIAS * 8);
  for (let r = 0; r < LOG_ROWS; r++) {
    const sp = SPECIES[r], w = sp && sp in WOODS ? WOODS[sp as keyof typeof WOODS] : WOODS.generic, x = woodOf(sp && sp in WOODS ? (sp as keyof typeof WOODS) : "generic", 0.1, 1);
    rows[r * 4] = toW(x.mmax);
    rows[r * 4 + 1] = Math.round((4 / (Math.PI * x.rho)) * 1000 * 65536);
    rows[r * 4 + 2] = toW(w.green === undefined ? FSP : w.heart === undefined ? w.green : (w.green + w.heart) / 2);
  }
  for (let j = 0; j < LOG_DIAS; j++) {
    const d = ((j + 0.5) * LOG_STEP) / 1000;
    ex.set(exchange(tau(d)), j * 8);
    ex.set(exchange(tauGreen(d)), j * 8 + 4);
  }
  return { rows, ex };
}

// ---------- the twin ----------
export type Water = { m: number; skin: number }; // Q24
// The pair an hour on toward water `to` by an exchange.
export function toward(x: Water, to: number, k: readonly number[]): Water {
  const s0 = x.skin - to, c0 = 2 * x.m - x.skin - to;
  const s = qmul(s0, k[0]) + qmul(c0, k[1]), c = qmul(s0, k[2]) + qmul(c0, k[3]);
  return { m: to + ((s + c) >> 1), skin: to + s };
}
// An hour on for a piece of a class (or a log's law): in rain on it (Q16 mm an hour) soaking toward all it holds, no
// faster than the rain on its face brings water; otherwise drawing toward the equilibrium eq (Q24), its own most at
// most. green: the exchange while it is green wood above fibre saturation, for a log just dead.
export function step(x: Water, L: { mmax: number; face: number; wet: readonly number[]; dry: readonly number[] }, rain: number, eq: number): Water {
  if (rain > 0) {
    const next = toward(x, L.mmax, L.wet), gain = next.m - x.m, most = Math.min(qmul(rain, L.face), 0x7fffff) << 8;
    if (gain <= most) return next;
    return { m: x.m + most, skin: x.skin + qmul(next.skin - x.skin, qdiv(most, gain)) };
  }
  const to = Math.min(L.mmax, eq), next = toward(x, to, L.dry), m = Math.max(Math.min(to, x.m), next.m);
  return { m, skin: Math.min(2 * m, Math.max(Math.min(to, x.skin), next.skin)) };
}

// Simard's equilibrium water of dead stuff at rh (Q16, 0 to 1) and temp (Q16 C), Q24 (R30; wetness.ts emc).
const k24 = (a: number, k: number) => {
  // a times k / 2^24, toward zero (wgsl/moisture.ts k24)
  const p = mul64(Math.abs(a) >>> 0, k >>> 0), r = ((p[0] >>> 24) | (p[1] << 8)) | 0;
  return a < 0 ? -r : r;
};
const K = (x: number) => Math.round(x * W24);
export function emcQ(rh: number, temp: number): number {
  const RH = Math.max(0, Math.min(100 * 65536, rh * 100)), T = qmul(temp, Q(1.8)) + Q(32);
  let pct: number;
  if (RH < Q(10)) pct = Q(0.03229) + k24(RH, K(0.281073)) - k24(qmul(T, RH), K(0.000578));
  else if (RH < Q(50)) pct = Q(2.22749) + k24(RH, K(0.160107)) - k24(T, K(0.014784));
  else pct = Q(21.0606) + k24(qmul(RH, RH), K(0.005565)) - k24(qmul(RH, T), K(0.00035)) - k24(RH, K(0.483199));
  return Math.floor((Math.max(0, pct) * 256) / 100);
}
// The water air at temp (Q16 C) can hold, kPa Q16 (FAO-56's, climate.ts esat), and how much of it air holding vapour has.
export const esatQ = (temp: number) => qmul(Q(0.6108), qexp(qdiv(qmul(Q(17.27), temp), temp + Q(237.3))));
export const humidQ = (vapour: number, temp: number) => Math.min(65536, Math.max(0, qdiv(vapour, esatQ(temp))));
// Byram and Jemison's equilibrium of something warmed by what shines on it (W/m2 Q16) in a wind (m/s Q16) (sec. 11).
export function equilibriumQ(temp: number, vapour: number, shine: number, wind: number) {
  const own = temp + qdiv(shine, Q(32.7) + qmul(Q(42.2), wind));
  return emcQ(humidQ(vapour, own), own);
}
// What dead stuff lying on the ground draws toward: half its face against the air and half against the ground, whose
// air is as near saturated as the top soil's stage-2 reduction kr (Q16) leaves it (wetness.ts lying).
export function lyingQ(air: number, temp: number, vapour: number, kr: number) {
  const rh = humidQ(vapour, temp);
  return (air + emcQ(rh + qmul(65536 - rh, kr), temp)) >> 1;
}

// What a texel's dead stuff lies in this hour: the rain reaching the ground (Q16 mm an hour), and what it draws toward
// lying and standing (Q24), from its cell's air (temp, vapour Q16; rain and head-height wind on open ground there, Q16),
// the crowns over it (Q16 layers of pine and broadleaf, the crowns' height over its cell in dm) and the hour's sun
// (W/m2 Q16), the top soil's kr, and the share of the rain a layer of pine and of broadleaf crowns lets through (Q16).
export type Hour = {
  hour: number; s: number; f: number; temp: number; pooled: number; wet: number; speed: number; k: number; ux: number; uy: number;
  v: number; sun: number; kr: number; tp: number; tb: number;
};
export const HOUR_FIELDS = ["hour", "s", "f", "temp", "pooled", "wet", "speed", "k", "ux", "uy", "v", "sun", "kr", "tp", "tb"] as const;
export type Air = { temp: number; vapour: number; rain: number; head: number };
export type Shelter = { A: Int32Array; B: Int32Array }; // by kind (0 pine, 1 broadleaf) and height, SHELTER_H rows each
export const SHELTER_H = 512;
// The head-height wind under the crowns (air.ts headWind, Albini and Baughman, R81): the open's, or where the crowns
// fill more than 5% of the space under them (cover times ratio over 3, B), the open's times A over the square root of
// the cover, never more than the open's.
export function shelterQ(open: number, cov: number, h: number, kind: number, S: Shelter) {
  const c = Math.min(65536, cov), j = kind * SHELTER_H + Math.min(h, SHELTER_H - 1);
  if (h <= 0 || qmul(c, S.B[j]) <= Q(0.05)) return open;
  return Math.min(open, qdiv(qmul(open, S.A[j]), qsqrt(c)));
}
export type Env = { rain: number; lying: number; aloft: number };
export function envQ(a: Air, pine: number, broad: number, h: number, H: Hour, S: Shelter): Env {
  const head = shelterQ(a.head, pine + broad, h, pine > broad ? 0 : 1, S), shine = qmul(H.sun, layered(pine + broad));
  const rain = qmul(qmul(a.rain, layeredBy(pine, H.tp)), layeredBy(broad, H.tb));
  const aloft = equilibriumQ(a.temp, a.vapour, shine, head);
  const lying = lyingQ(equilibriumQ(a.temp, a.vapour, shine, qmul(head, Q(GROUND))), a.temp, a.vapour, H.kr);
  return { rain, lying, aloft };
}
// A texel's classes an hour on.
export function texelHour(x: Water[], e: Env): Water[] {
  return x.map((w, i) => step(w, CLASS_LAWS[i], e.rain, CLASSES[i].lying ? e.lying : e.aloft));
}
// A cell's air this hour from its season fields (CELL_WORDS i32: warmth against the island's for each season, the
// air's water for each, a rain hour's rain for each, the pooling, the slope east and south, land) and the wind its
// ground upwind leaves blowing the hour's way (hundredths): the season's drawn between its two, the island's air with
// the place's own warmth less the cold pooled there, the rain of a wet hour (wet: 1 for rain, 5 for a storm, 0 dry)
// slanting onto the slope as Sharon has it (rain.ts rainThere) at the island rain's fall speed, and the head-height wind
// on open ground. null at sea.
export function cellAir(cells: Int32Array, lee: Uint8Array, c: number, H: Hour): Air | null {
  const base = c * CELL_WORDS;
  if (!cells[base + 15]) return null;
  const blend = (i: number) => { const a = cells[base + i + H.s], b = cells[base + i + ((H.s + 1) % 4)]; return a + qmul(b - a, H.f); };
  const temp = H.temp + blend(0) - qmul(cells[base + 12], H.pooled), vapour = blend(4);
  const head = qmul(H.speed, Math.floor((lee[c * DIRS + H.k] * 65536) / 100));
  let rain = 0;
  if (H.wet > 0) {
    rain = blend(8) * H.wet;
    if (H.v > 0) rain = qmul(rain, Math.max(0, 65536 + qmul(qdiv(head, H.v), qmul(cells[base + 13], H.ux) + qmul(cells[base + 14], H.uy))));
  }
  return { temp, vapour, rain, head };
}
// A log's law: its wood's row (LOG_ROWS x 4: most water, face per mm, a just-dead tree's water) and its diameter's
// exchange (LOG_DIAS x 8: soaking and drying, then green), green while it is green wood above fibre saturation.
export function logLaw(rows: Int32Array, ex: Int32Array, what: number, dia: number, green: boolean) {
  const r = Math.min(what, LOG_ROWS - 1), j = Math.min(Math.floor(dia / LOG_STEP), LOG_DIAS - 1) * 8;
  const wet = Array.from(ex.subarray(j, j + 4));
  return { mmax: rows[r * 4], face: Math.trunc(rows[r * 4 + 1] / Math.max(dia, 1)), wet, dry: green ? Array.from(ex.subarray(j + 4, j + 8)) : wet, fresh: rows[r * 4 + 2] };
}

// ---------- the driver ----------
// What the law reads from the sim (src/sim/wetness.ts moistureDriver): each cell's season fields (CELL_WORDS i32 a
// cell: the season's warmth against the island's air for each season, Q16 C; the air's water for each, Q16 kPa; the
// rain of a rain hour for each, Q16 mm; how deep the cold pools there, Q16; the slope east and south, Q16; 1 for land),
// the wind its ground upwind leaves by bearing (DIRS bytes a cell, hundredths), the crowns' shelter tables, and the
// island's reference dead stuff in the open now (Q24 by class), which the texels start from.
export const CELL_WORDS = 16;
export type MoistureDriver = { cells(): Int32Array; lee(): Uint8Array; shelter(): Shelter; start(): Water[] };

export class Moisture implements Rider {
  readonly name = "moisture";
  store: Store | null = null;
  states: GPUBuffer | null = null;
  private bufs: { cells: GPUBuffer; lee: GPUBuffer; shelter: GPUBuffer; logs: GPUBuffer; hour: GPUBuffer; air: GPUBuffer; env: GPUBuffer } | null = null;
  private crowns: Crowns | null = null;
  private layout: MoistureLayout | null = null;
  private src: Record<string, string> = {};
  private queued: Hour | null = null;
  private first = 0; // the hour the world's water started: logs born by then are seasoned, later ones just dead
  private shelterTab: Shelter | null = null;
  // what the CPU asked for and holds: cells (their texels' classes) and logs (by GPU id), the tick each was last asked,
  // and what the last landing brought
  private askedCells = new Map<number, number>();
  private askedLogs = new Map<number, number>();
  private heldCells = new Map<number, Int32Array>();
  private heldLogs = new Map<number, Int32Array>();
  private gather: { idx: Uint32Array; cells: number[]; logs: number[] } | null = null;
  private dirty = true; // an hour stepped or a new ask since the last gather
  hours = 0; // hours stepped on the GPU

  attach(store: Store, crowns: Crowns, dead: Deadwood, driver: MoistureDriver) {
    if (this.store) throw new Error("the moisture already lives on a store");
    this.store = store; this.crowns = crowns;
    const g = store.g, log = store.kind("log"), up = store.kind("logup");
    this.layout = { logCap: log.capacity, upCap: up.capacity, log: fieldsAt(log), up: { ...fieldsAt(up), oslot: (1 + up.field.oslot) * up.capacity, ogen: (1 + up.field.ogen) * up.capacity } };
    const words = TEXELS * TEXEL_WORDS + 3 * (log.capacity + up.capacity), t = logTables();
    this.shelterTab = driver.shelter();
    const lee = driver.lee(), shel = new Int32Array(4 * SHELTER_H);
    shel.set(this.shelterTab.A, 0); shel.set(this.shelterTab.B, 2 * SHELTER_H);
    this.bufs = {
      cells: storage(g, driver.cells()), lee: storage(g, new Uint8Array(lee.buffer, lee.byteOffset, lee.byteLength)), shelter: storage(g, shel),
      logs: storage(g, concat(t.rows, t.ex)), hour: storage(g, HOUR_FIELDS.length * 4 + 16), air: storage(g, N * N * 4 * 4), env: storage(g, TEXELS * 3 * 4),
    };
    this.states = storage(g, words * 4);
    const L = this.layout;
    this.src = { cells: moistureCells(), texels: moistureTexels(), logs: moistureLogs(L, dead.law), gather: moistureGather() };
    let restored = false;
    this.restoreHook = () => { restored = true; };
    store.ride(this);
    this.restoreHook = null;
    if (!restored) {
      // every texel starts as the island's reference dead stuff in the open; the logs as each is first stepped
      const start = driver.start(), one = new Int32Array(TEXEL_WORDS);
      start.forEach((w, i) => { one[2 * i] = w.m; one[2 * i + 1] = w.skin; });
      const all = new Int32Array(TEXELS * TEXEL_WORDS);
      for (let t2 = 0; t2 < TEXELS; t2++) all.set(one, t2 * TEXEL_WORDS);
      for (let c = 0; c < all.byteLength; c += 64 << 20) g.device.queue.writeBuffer(this.states, c, all.buffer, all.byteOffset + c, Math.min(64 << 20, all.byteLength - c));
      this.first = Math.floor(store.t / HOUR);
    }
    store.law({ name: "moisture", due: () => this.queued !== null, run: () => this.law() });
  }
  private restoreHook: (() => void) | null = null;

  // The island's hour (wetness.ts), stepped on the GPU at the next tick's laws.
  queue(h: Hour) { this.queued = h; }
  kernelSources(): string[] { return Object.values(this.src); }
  private law() {
    const s = this.store!, g = s.g, b = this.bufs!, h = this.queued!, crowns = this.crowns!.buf!;
    this.queued = null;
    g.device.queue.writeBuffer(b.hour, 0, Int32Array.from(HOUR_FIELDS.map((k) => h[k] | 0)));
    s.run(this.src.cells, [b.cells, b.lee, b.hour, b.air], cover(g, N * N));
    s.run(this.src.texels, [b.air, crowns, b.shelter, b.hour, b.env, this.states!], cover(g, TEXELS));
    const log = s.kind("log"), up = s.kind("logup");
    s.run(this.src.logs, [log.body, up.body, b.env, b.logs, b.hour, this.states!], cover(g, log.capacity + up.capacity), [this.first, 0, 0, 0]);
    this.hours++;
    this.dirty = true;
  }

  // ---------- reading ----------
  // The classes of the texel at a place in mm as the last landing brought them (Q24 pairs by class), or undefined until
  // its cell has come back; asking brings it back from the next landing on.
  texelAt(x: number, y: number, t: number): Int32Array | undefined {
    const tx = Math.min(Math.floor(x / TEXEL_MM), SIDE - 1), ty = Math.min(Math.floor(y / TEXEL_MM), SIDE - 1), cell = (ty >> 2) * N + (tx >> 2);
    if (!this.askedCells.has(cell)) this.dirty = true;
    this.askedCells.set(cell, t);
    const held = this.heldCells.get(cell);
    return held?.subarray(((ty & 3) * 4 + (tx & 3)) * TEXEL_WORDS, ((ty & 3) * 4 + (tx & 3) + 1) * TEXEL_WORDS);
  }
  // A log's water (Q24 m, skin) by its GPU id (kind log or logup), or undefined until it has come back.
  logAt(id: number, t: number): Water | undefined {
    if (!this.askedLogs.has(id)) this.dirty = true;
    this.askedLogs.set(id, t);
    const v = this.heldLogs.get(id);
    return v && ((v[2] & 0x7fffffff) >>> 1) === genOfId(id) ? { m: v[0], skin: v[1] } : undefined;
  }
  // The cells round people, asked every tick: a 3 x 3 block of 75 m cells round each person, whose water comes back
  // every hour [design: a person's reach for tinder and pieces], and cells asked of by any lookup, kept for a day (DAY
  // ticks) after the last ask.
  watch(people: readonly { px: number; py: number }[], tileMm: number, t: number) {
    for (const p of people) {
      const cx = Math.floor((p.px * tileMm) / (TEXEL_MM * 4)), cy = Math.floor((p.py * tileMm) / (TEXEL_MM * 4));
      const cells: number[] = [];
      for (let y = Math.max(0, cy - 1); y <= Math.min(N - 1, cy + 1); y++)
        for (let x = Math.max(0, cx - 1); x <= Math.min(N - 1, cx + 1); x++) cells.push(y * N + x);
      this.ask(cells, t);
    }
    for (const [c, at] of this.askedCells) if (t - at > DAY) { this.askedCells.delete(c); this.heldCells.delete(c); }
    for (const [id, at] of this.askedLogs) if (t - at > DAY) { this.askedLogs.delete(id); this.heldLogs.delete(id); }
  }
  // Cells (75 m, as the mirror's) asked of at tick t: their texels' water comes back from the next landing on, and the ask
  // is kept for a day (what a burning bed keeps asking of the cells round it).
  ask(cells: Iterable<number>, t: number) {
    for (const c of cells) {
      if (!this.askedCells.has(c)) this.dirty = true;
      this.askedCells.set(c, t);
    }
  }
  // Every texel and log set to the same water (a test's fixed weather: fire.test.ts's dry afternoons); each log takes
  // its class's most at most.
  async fill(ms: readonly Water[], logs: Water) {
    const s = this.store!, L = this.layout!, one = new Int32Array(TEXEL_WORDS);
    ms.forEach((w, i) => { one[2 * i] = w.m; one[2 * i + 1] = w.skin; });
    if (s.arriving) await s.arriving;
    const all = new Int32Array(TEXELS * TEXEL_WORDS + 3 * (L.logCap + L.upCap));
    for (let t = 0; t < TEXELS; t++) all.set(one, t * TEXEL_WORDS);
    // the logs keep their tags, so each holds the water given as the object it is
    const old = new Int32Array(await readback(s.g, this.states!));
    for (let i = TEXELS * TEXEL_WORDS; i < all.length; i += 3) { all[i] = logs.m; all[i + 1] = logs.skin; all[i + 2] = old[i + 2]; }
    for (let c = 0; c < all.byteLength; c += 64 << 20) s.g.device.queue.writeBuffer(this.states!, c, all.buffer, all.byteOffset + c, Math.min(64 << 20, all.byteLength - c));
    this.heldCells.clear(); this.heldLogs.clear();
    this.dirty = true;
  }

  // ---------- riding the store ----------
  words(): number {
    if (!this.dirty) { this.gather = null; return 0; }
    const L = this.layout!, cells = [...this.askedCells.keys()], logs = [...this.askedLogs.keys()];
    const idx = new Uint32Array(cells.length * 16 * TEXEL_WORDS + logs.length * 3);
    let n = 0;
    for (const c of cells) {
      const cx = c % N, cy = Math.floor(c / N);
      for (let j = 0; j < 16; j++) {
        const t = (cy * 4 + (j >> 2)) * SIDE + cx * 4 + (j & 3);
        for (let w = 0; w < TEXEL_WORDS; w++) idx[n++] = t * TEXEL_WORDS + w;
      }
    }
    for (const id of logs) {
      const up = kindOfId(id) === this.store!.kind("logup").n, slot = slotOfId(id), at = TEXELS * TEXEL_WORDS + 3 * (up ? L.logCap + slot : slot);
      for (let w = 0; w < 3; w++) idx[n++] = at + w;
    }
    this.gather = { idx, cells, logs };
    return idx.length;
  }
  record(out: GPUBuffer, at: number) {
    const gt = this.gather;
    if (!gt || !gt.idx.length) return;
    const s = this.store!, buf = s.scratch("moistidx", gt.idx.length);
    s.g.device.queue.writeBuffer(buf, 0, gt.idx);
    s.run(this.src.gather, [this.states!, buf, out], cover(s.g, gt.idx.length), [gt.idx.length, at, 0, 0]);
  }
  land(o: Uint32Array, at: number) {
    const gt = this.gather;
    if (!gt) return;
    this.gather = null;
    this.dirty = false;
    const v = new Int32Array(o.buffer, o.byteOffset + at * 4, gt.idx.length);
    let n = 0;
    for (const c of gt.cells) { this.heldCells.set(c, v.slice(n, n + 16 * TEXEL_WORDS)); n += 16 * TEXEL_WORDS; }
    for (const id of gt.logs) { this.heldLogs.set(id, v.slice(n, n + 3)); n += 3; }
  }
  buffers(): [string, GPUBuffer][] { return this.states ? [["states", this.states]] : []; }
  save() { return { first: this.first, hours: this.hours, queued: this.queued ? HOUR_FIELDS.map((k) => this.queued![k]) : [] }; }
  restore(state: unknown, data: Record<string, Uint8Array>) {
    this.first = savedNumber(state, "first", "moisture");
    this.hours = savedNumber(state, "hours", "moisture");
    const q = savedArray(state, "queued", "moisture") as number[];
    this.queued = q.length ? (Object.fromEntries(HOUR_FIELDS.map((k, i) => [k, q[i]])) as Hour) : null;
    reload(this.store!.g, this.states!, data.states, "moisture states");
    this.restoreHook?.();
  }
  destroy() {
    for (const b of Object.values(this.bufs ?? {})) b.destroy();
    this.states?.destroy();
    this.bufs = null; this.states = null;
  }
}
function fieldsAt(k: { capacity: number; field: Record<string, number> }) {
  const at = (f: string) => (1 + k.field[f]) * k.capacity;
  return { x: at("x"), y: at("y"), born: at("born"), what: at("what"), dia: at("dia"), uf: at("uf"), fr: at("fr") };
}
function concat(a: Int32Array, b: Int32Array) {
  const out = new Int32Array(a.length + b.length);
  out.set(a); out.set(b, a.length);
  return out;
}
