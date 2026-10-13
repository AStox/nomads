// Fish as a population over the island's inshore sea and lakes (docs/research/animal-constants.md sec. 11): each water
// tile's standing stock, kg a ha, which grows by Downing and Plante's production as far as the water's own production
// feeds it and dies at Pauly's natural rate, less whatever is caught or eaten. The fish people see are the water's own,
// stood in the shallows within reach of them: one caught or eaten is one fewer there.
import { H, TILE_M, Tile, W, groundOf, tileAt, wetAt, type Animal, type World } from "./world";
import { CELL } from "../terrain/grid";
import { SIZE, START } from "../terrain/flora";
import { PHYS } from "./fuel";

// A fish as the game has one, kg wet: its dry flesh and the water in it (fuel.ts).
export const FISH_KG = PHYS.fish.mass * (1 + (PHYS.fish.green ?? 0));
// Brown trout, the island's fish: a lake stock's von Bertalanffy L-infinity 45 cm and K 0.27 a year (R416), and the most
// one weighs, at a salmonid's condition of 1, L^3 / 100 g [UNVERIFIED], 0.91 kg.
const LINF = 45, K_GROWTH = 0.27, W_MAX = LINF ** 3 / 100;
// Pauly's natural mortality, a year, at a mean water temperature T, C (R417): log M = -0.0066 - 0.279 log Linf + 0.6543 log K
// + 0.4634 log T. The lake stock's 0.40 at 8.9 C (R416) checks it.
const pauly = (T: number) => 10 ** (-0.0066 - 0.279 * Math.log10(LINF) + 0.6543 * Math.log10(K_GROWTH) + 0.4634 * Math.log10(T));
// Downing and Plante's production of a fish stock, kg a ha a year, from its standing stock B, kg a ha, and the most one
// weighs, g (R418): log P = 0.32 + 0.94 log B - 0.17 log W.
const produced = (B: number) => 10 ** (0.32 - 0.17 * Math.log10(W_MAX)) * B ** 0.94;
// What the water makes, mg of carbon a m2 a day: oligotrophic lakes 50 to 100, eutrophic 600 to 8,000 (R419), between
// their middles (75 and the geometric middle of the eutrophic, 2,190) by the fertility of the shores that drain into it
// [derived]; of that a fish stock gets two steps of the food chain's 10% each (Pauly and Christensen, R420), as wet fish at
// 12.5% carbon (R421).
const PP_POOR = 75, PP_RICH = Math.sqrt(600 * 8000), CHAIN = 0.1 * 0.1, FISH_C = 0.125;
// Water no more than a kilometre from land, inshore, holds the island's fish; past that is open sea [derived].
const INSHORE = Math.round(1000 / TILE_M);
// The share of a year in an island day (sky.ts YEAR_DAYS), as herds.ts counts it.
const HA = (TILE_M * TILE_M) / 1e4;
// A sea trout's home range over a month, 0.43 km2 (R426): over a month a tile's fish spread evenly over the water within
// a square that big, tiles either side, so a step carries its days' share of them there [derived].
const RANGE = Math.max(1, Math.round((Math.sqrt(0.43e6) / TILE_M - 1) / 2)), MONTH = 30;

// tiles: the water that holds fish; wet: the same as a mask; near: how many of them lie within a fish's range of each;
// stock: which body of water each is in, its fish one stock, of stocks in all; dead, ate, out: working arrays.
type Waters = { tiles: number[]; wet: Uint8Array; near: Uint16Array; stock: Int32Array; stocks: number; feed: Float32Array; sun: Float32Array[]; sunMean: Float32Array; M: Float32Array; dead?: Float64Array; ate?: Float64Array; out?: Float64Array };
const waters = new WeakMap<World, Waters>();
function watersOf(w: World): Waters {
  let v = waters.get(w);
  if (v) return v;
  const { isle, fine } = groundOf(w.seed), land = new Uint8Array(W * H), fert = new Float32Array(W * H);
  const at = (i: number) => [((i % W) * TILE_M + TILE_M / 2 - SIZE / 2 - START) / CELL, (Math.floor(i / W) * TILE_M + TILE_M / 2 - SIZE / 2 - START) / CELL] as const;
  for (let i = 0; i < W * H; i++) if (tileAt(w, i % W, Math.floor(i / W)) !== Tile.Water) { land[i] = 1; const [cx, cy] = at(i); fert[i] = fine.bilinear(isle.fertility, cx, cy); }
  const tiles: number[] = [], feed = new Float32Array(W * H), sun = isle.seasons.map(() => new Float32Array(W * H)), sunMean = new Float32Array(W * H), M = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) {
    if (land[i]) continue;
    const x0 = i % W, y0 = Math.floor(i / W);
    let n = 0, f = 0;
    for (let y = Math.max(0, y0 - INSHORE); y <= Math.min(H - 1, y0 + INSHORE); y++) for (let x = Math.max(0, x0 - INSHORE); x <= Math.min(W - 1, x0 + INSHORE); x++) if (land[y * W + x]) { n++; f += fert[y * W + x]; }
    if (!n) continue;
    tiles.push(i);
    const fed = Math.max(0, Math.min(1, f / n)), [cx, cy] = at(i);
    feed[i] = PP_POOR * (PP_RICH / PP_POOR) ** fed;
    let T = 0;
    isle.seasons.forEach((s, k) => { sun[k][i] = fine.bilinear(s.sun, cx, cy); sunMean[i] += sun[k][i] / isle.seasons.length; T += fine.bilinear(s.temp, cx, cy) / isle.seasons.length; });
    // open water never runs much below 4 C under its ice [derived]
    M[i] = pauly(Math.max(4, T));
  }
  const wet = new Uint8Array(W * H), near = new Uint16Array(W * H);
  for (const i of tiles) wet[i] = 1;
  for (const i of tiles) { const x0 = i % W, y0 = Math.floor(i / W); for (let y = Math.max(0, y0 - RANGE); y <= Math.min(H - 1, y0 + RANGE); y++) for (let x = Math.max(0, x0 - RANGE); x <= Math.min(W - 1, x0 + RANGE); x++) near[i] += wet[y * W + x]; }
  // the bodies of water, each its own stock: tiles joined side to side or corner to corner
  const stock = new Int32Array(W * H).fill(-1);
  let stocks = 0;
  for (const s of tiles) {
    if (stock[s] >= 0) continue;
    const todo = [s];
    stock[s] = stocks;
    while (todo.length) {
      const i = todo.pop()!, x0 = i % W, y0 = Math.floor(i / W);
      for (let y = Math.max(0, y0 - 1); y <= Math.min(H - 1, y0 + 1); y++) for (let x = Math.max(0, x0 - 1); x <= Math.min(W - 1, x0 + 1); x++) { const j = y * W + x; if (wet[j] && stock[j] < 0) { stock[j] = stocks; todo.push(j); } }
    }
    stocks++;
  }
  v = { tiles, wet, near, stock, stocks, feed, sun, sunMean, M };
  waters.set(w, v);
  return v;
}

// days of the fish's lives, at the year's pace; s, f: the season and how far through it (sky.ts seasonAt); eaten: what
// the animals ate of each tile's fish since the last step, which Pauly's rate counts among the deaths (his is all of a
// stock's natural deaths, predators' too), so only the rest of the stock's die otherwise, each tile's share as its own
// would be [derived]: the fish range over their water, and what's eaten by one shore is a death the stock doesn't then
// die elsewhere. It's spent.
export function stepFish(w: World, B: number[], eaten: number[], days: number, s: number, f: number) {
  const v = watersOf(w), s1 = (s + 1) % v.sun.length, out = (v.out ??= new Float64Array(W * H)).fill(0);
  const dead = (v.dead ??= new Float64Array(v.stocks)).fill(0), ate = (v.ate ??= new Float64Array(v.stocks)).fill(0);
  for (const i of v.tiles) { dead[v.stock[i]] += (v.M[i] / 365.25) * B[i] * days; ate[v.stock[i]] += eaten[i]; eaten[i] = 0; }
  for (const i of v.tiles) {
    const sun = v.sun[s][i] * (1 - f) + v.sun[s1][i] * f, light = v.sunMean[i] > 0 ? sun / v.sunMean[i] : 0, k = v.stock[i];
    // what the water feeds, kg of wet fish a ha a day, against what the stock would make of it
    const food = ((v.feed[i] * light) / 1000) * (CHAIN / FISH_C) * 10, made = produced(Math.max(B[i], 0.01)) / 365.25;
    const otherwise = dead[k] > 0 ? Math.max(0, dead[k] - ate[k]) / dead[k] : 0;
    B[i] = Math.max(0, B[i] + Math.min(made, food) * days - (v.M[i] / 365.25) * B[i] * days * otherwise);
  }
  // the fish wander their range: a step's share of a month's ranging spreads evenly over the water within it
  const share = Math.min(1, days / MONTH);
  for (const i of v.tiles) {
    const go = B[i] * share, x0 = i % W, y0 = Math.floor(i / W);
    if (go <= 0) continue;
    out[i] -= go;
    const each = go / v.near[i];
    for (let y = Math.max(0, y0 - RANGE); y <= Math.min(H - 1, y0 + RANGE); y++) for (let x = Math.max(0, x0 - RANGE); x <= Math.min(W - 1, x0 + RANGE); x++) if (v.wet[y * W + x]) out[y * W + x] += each;
  }
  for (const i of v.tiles) B[i] = Math.max(0, B[i] + out[i]);
}
// Where the fish start: as much as the water would hold were nothing taking them, what it feeds over Pauly's rate.
export function startFish(w: World, B: number[]) {
  const v = watersOf(w);
  for (const i of v.tiles) B[i] = ((v.feed[i] / 1000) * (CHAIN / FISH_C) * 10 * 365.25) / v.M[i];
}

// How many fish swim within m metres of a place: the water there, judged at K x K points a tile, at its stock.
const K = 6;
export function fishNear(w: World, B: number[] | undefined, at: { px: number; py: number }, m: number) {
  if (!B) return 0;
  const r = m / TILE_M, cell = 1 / (K * K);
  let n = 0;
  for (let y = Math.max(0, Math.floor(at.py - r)); y <= Math.min(H - 1, Math.floor(at.py + r)); y++)
    for (let x = Math.max(0, Math.floor(at.px - r)); x <= Math.min(W - 1, Math.floor(at.px + r)); x++) {
      const b = B[y * W + x];
      if (!(b > 0)) continue;
      for (let u = 0; u < K; u++) for (let v = 0; v < K; v++) {
        const px = x + (u + 0.5) / K, py = y + (v + 0.5) / K;
        if ((px - at.px) ** 2 + (py - at.py) ** 2 <= r * r && wetAt(w, px, py)) n += (b * HA * cell) / FISH_KG;
      }
    }
  return n;
}
// n fish taken out of the water nearest a place.
export function takeFish(w: World, B: number[] | undefined, at: { px: number; py: number }, n: number) {
  if (!B || n <= 0) return;
  let best = -1, bd = Infinity;
  for (let y = Math.max(0, Math.floor(at.py) - 2); y <= Math.min(H - 1, Math.floor(at.py) + 2); y++)
    for (let x = Math.max(0, Math.floor(at.px) - 2); x <= Math.min(W - 1, Math.floor(at.px) + 2); x++) {
      const i = y * W + x, d = (x + 0.5 - at.px) ** 2 + (y + 0.5 - at.py) ** 2;
      if (B[i] > 0 && d < bd) { bd = d; best = i; }
    }
  if (best >= 0) B[best] = Math.max(0, B[best] - (n * FISH_KG) / HA);
}

// Stand the fish within a basket's reach of anyone awake in the water as whole fish, and take them back off where no one
// is; spawn: how one is put down.
export function revealFish(w: World, B: number[] | undefined, reach: number, spawn: (px: number, py: number) => Animal, rand = Math.random) {
  if (!B) return;
  const awake = w.agents.filter((a) => a.down <= w.t), r = reach / TILE_M;
  const near = (x: number, y: number) => awake.some((a) => (a.px - x) ** 2 + (a.py - y) ** 2 <= r * r);
  const out = new Set(w.animals.filter((an) => an.species === "fish" && !near(an.px, an.py)));
  if (out.size) w.animals = w.animals.filter((x) => !out.has(x));
  for (const a of awake) {
    const want = fishNear(w, B, a, reach), have = w.animals.filter((an) => an.species === "fish" && (an.px - a.px) ** 2 + (an.py - a.py) ** 2 <= r * r).length;
    for (let k = 0, need = Math.floor(want) + (rand() < want - Math.floor(want) ? 1 : 0) - have; need > 0 && k < 60; k++) {
      const ang = rand() * Math.PI * 2, d = Math.sqrt(rand()) * r, px = a.px + Math.cos(ang) * d, py = a.py + Math.sin(ang) * d;
      if (!wetAt(w, px, py)) continue;
      spawn(px, py);
      need--;
    }
  }
}
// The fish in all the island's water together.
export const fishCount = (B: number[] | undefined) => (B ? B.reduce((s, b) => s + (b > 0 ? (b * HA) / FISH_KG : 0), 0) : 0);
