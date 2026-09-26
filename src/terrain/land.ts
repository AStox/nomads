// The simulated island as the game sees it: tiles of water, rock, forest or grass, corner heights for the map, the
// things lying about on each tile, and a compact copy of the ground for the renderer. All of it is read off the
// physics; nothing is rolled per tile type.
import { H, Tile, W } from "../sim/world";
import { CELL, LEN, N } from "./grid";
import type { Island } from "./island";

// W and H come from the world module, which imports this one, so they're only read once it has loaded.
const QMIN = 0.02; // m³/s, as in the generator: a lasting stream

// What the renderer and anything else needs of the ground, packed small.
export type Terrain = {
  n: number; // cells per side
  tile: number; // meters per tile, which is also one unit of height on the map
  ground: string; // base64 Uint16 per cell: (elevation m + 100) * 10
  water: string; // base64 Uint8 per cell: depth of standing water in quarter meters, capped
  cover: Record<"tree" | "shrub" | "grass" | "marsh" | "bare" | "sand" | "moist", string>; // base64 Uint8 per tile, 0..255
  rivers: [number, number, number][][]; // [x, y, discharge m³/s] in tile units, source to mouth
  wind: [number, number]; // the way the prevailing wind blows
  rain: number; // mean mm a year over the land
};

export type Lay = {
  tiles: Tile[];
  heights: number[]; // (W + 1) * (H + 1) corners, in tile widths; water lies flat at its surface
  tile: Record<"tree" | "shrub" | "grass" | "marsh" | "bare" | "sand" | "silt" | "moist", Float32Array>; // tile means
  stream: Uint8Array; // tile holds a stream channel
  shore: Uint8Array; // tile touches open water
  terrain: Terrain;
};

export function lay(isle: Island): Lay {
  const T = W * H, R = N / W, TILE_M = CELL * R; // cells per tile side; meters per tile, also one unit of map height
  const mean = (g: Float32Array) => {
    const out = new Float32Array(T);
    for (let i = 0; i < LEN; i++) { const x = i % N, y = (i - x) / N; out[Math.floor(y / R) * W + Math.floor(x / R)] += g[i] / (R * R); }
    return out;
  };
  const tile = {
    tree: mean(isle.tree), shrub: mean(isle.shrub), grass: mean(isle.grass), marsh: mean(isle.marsh),
    bare: mean(isle.bare), sand: mean(isle.sand), silt: mean(isle.silt), moist: mean(isle.moist),
  };
  const wet = new Float32Array(T), level = new Float32Array(T), stream = new Uint8Array(T);
  for (let i = 0; i < LEN; i++) {
    const x = i % N, y = (i - x) / N, t = Math.floor(y / R) * W + Math.floor(x / R);
    if (isle.water[i] > 0) { wet[t]++; level[t] += Math.max(0, isle.height[i] + isle.water[i]); }
    else if (isle.flow[i] >= QMIN) stream[t] = 1;
  }
  const tiles = new Array<Tile>(T);
  for (let t = 0; t < T; t++) {
    // Rock where the ground is mostly bare stone rather than sand, forest where trees hold most of it.
    if (wet[t] >= (R * R) / 2) { tiles[t] = Tile.Water; level[t] /= wet[t]; }
    else tiles[t] = tile.bare[t] - tile.sand[t] >= 0.5 ? Tile.Rock : tile.tree[t] >= 0.45 ? Tile.Forest : Tile.Grass;
  }
  const shore = new Uint8Array(T);
  for (let t = 0; t < T; t++) {
    const x = t % W, y = (t - x) / W;
    if (tiles[t] === Tile.Water) continue;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const nx = x + dx, ny = y + dy;
      if (nx >= 0 && ny >= 0 && nx < W && ny < H && tiles[ny * W + nx] === Tile.Water) shore[t] = 1;
    }
  }
  // Corners: the average surface of the four cells around them, except that water tiles lie flat at their level.
  const heights = new Array<number>((W + 1) * (H + 1));
  for (let ty = 0; ty <= H; ty++)
    for (let tx = 0; tx <= W; tx++) {
      let sum = 0, flat = Infinity;
      for (const [cx, cy] of [[tx * R - 1, ty * R - 1], [tx * R, ty * R - 1], [tx * R - 1, ty * R], [tx * R, ty * R]]) {
        const i = Math.min(N - 1, Math.max(0, cy)) * N + Math.min(N - 1, Math.max(0, cx));
        sum += Math.max(0, isle.height[i] + isle.water[i]);
      }
      for (const [x, y] of [[tx - 1, ty - 1], [tx, ty - 1], [tx - 1, ty], [tx, ty]])
        if (x >= 0 && y >= 0 && x < W && y < H && tiles[y * W + x] === Tile.Water) flat = Math.min(flat, level[y * W + x]);
      heights[ty * (W + 1) + tx] = Math.round((Math.min(sum / 4, flat) / TILE_M) * 100) / 100;
    }
  const bytes = (a: Uint8Array | Uint16Array) => Buffer.from(a.buffer, a.byteOffset, a.byteLength).toString("base64");
  const u8 = (g: Float32Array) => bytes(Uint8Array.from(g, (v) => Math.round(Math.max(0, Math.min(1, v)) * 255)));
  let land = 0, rain = 0;
  for (let i = 0; i < LEN; i++) if (isle.water[i] <= 0) { land++; rain += isle.precip[i]; }
  const terrain: Terrain = {
    n: N,
    tile: TILE_M,
    ground: bytes(Uint16Array.from(isle.height, (h) => Math.round((Math.max(-100, h) + 100) * 10))),
    water: bytes(Uint8Array.from(isle.water, (d) => Math.min(255, Math.round(d * 4)))),
    cover: { tree: u8(tile.tree), shrub: u8(tile.shrub), grass: u8(tile.grass), marsh: u8(tile.marsh), bare: u8(tile.bare), sand: u8(tile.sand), moist: u8(tile.moist) },
    rivers: isle.rivers.map((line) => line.map(([x, y, q]) => [(x + 0.5) / R, (y + 0.5) / R, Math.round(q * 1000) / 1000] as [number, number, number])),
    wind: [Math.round(isle.wind[0] * 100) / 100, Math.round(isle.wind[1] * 100) / 100],
    rain: Math.round(rain / Math.max(1, land)),
  };
  return { tiles, heights, tile, stream, shore, terrain };
}

export type Placed = { kind: "tree" | "stick" | "mushroom" | "herb" | "bush" | "reeds" | "clay" | "stone" | "boulder" | "ore"; x: number; y: number };

// What each tile starts with, at most one thing, in proportion to what its ground grows or sheds: trees and fallen
// wood under canopy, mushrooms where it's shaded and damp, berries in the open, reeds and clay by still or running
// water, stones and boulders where rock breaks through.
export function stock(land: Lay, rand: () => number): Placed[] {
  const out: Placed[] = [];
  const { tile: c } = land;
  for (let t = 0; t < W * H; t++) {
    if (land.tiles[t] === Tile.Water) continue;
    const wetEdge = land.stream[t] || land.shore[t] ? 1 : 0;
    const odds: [Placed["kind"], number][] = [
      ["tree", 0.3 * c.tree[t] ** 1.4],
      ["stick", 0.03 * c.tree[t] + 0.006],
      ["mushroom", 0.025 * c.tree[t] * c.moist[t]],
      ["herb", 0.02 * c.grass[t] * c.moist[t] + 0.008 * c.shrub[t]],
      ["bush", 0.04 * (c.grass[t] + c.shrub[t]) * (1 - c.tree[t]) * c.moist[t]],
      ["reeds", 0.06 * c.marsh[t] + 0.02 * wetEdge * (1 - c.sand[t])],
      ["clay", 0.4 * c.silt[t] * (0.3 + 0.7 * wetEdge)],
      ["stone", 0.1 * c.bare[t] + 0.012 * land.stream[t] + 0.03 * c.sand[t]],
      ["boulder", 0.05 * c.bare[t]],
      ["ore", 0.014 * c.bare[t]],
    ];
    let r = rand();
    for (const [kind, p] of odds) {
      if (r < p) { out.push({ kind, x: t % W, y: Math.floor(t / W) }); break; }
      r -= p;
    }
  }
  return out;
}
