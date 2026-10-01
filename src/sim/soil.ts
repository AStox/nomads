// The soil's nourishment wherever something grows: the generator's fertility (src/terrain/ground.ts: the rock it weathered
// from, its silt, acidity, humus and depth), and what has happened to it since. Ash from a burn and the dung of animals
// and people feed it; taking what grows on it draws it down. Those changes are kept only where they happened, on cells of
// FERT_CELL meters, and fade as the rain washes them out and the ground settles back to what it was.
import { CELL } from "../terrain/grid";
import { clamp, smooth } from "../terrain/flora";
import { FAUNA } from "./fauna";
import { DAY, TILE_M, W, groundOf, type World } from "./world";

export const FERT_CELL = 25;
const across = () => Math.round((W * TILE_M) / FERT_CELL);
const cellOf = (px: number, py: number) => {
  const n = across(), x = clamp(Math.floor((px * TILE_M) / FERT_CELL), 0, n - 1), y = clamp(Math.floor((py * TILE_M) / FERT_CELL), 0, n - 1);
  return y * n + x;
};

// 0 for barren ground to about 1 for the richest silt, and past that where it has been fed.
export function fertilityAt(w: World, px: number, py: number) {
  const { isle, fine } = groundOf(w.seed);
  return Math.max(0, fine.bilinear(isle.fertility, (px * TILE_M) / CELL - 0.5, (py * TILE_M) / CELL - 0.5) + (w.fert[cellOf(px, py)] ?? 0));
}
// How well a plant grows on the soil at a point: three quarters as fast on barren ground as on good soil, a quarter faster
// again on the richest.
export const feedRate = (w: World, px: number, py: number) => 0.75 + 0.5 * smooth(0, 0.5, fertilityAt(w, px, py));

// Feed the soil at a point (amount > 0) or draw it down (< 0), within half a unit either way of what it was.
export function enrich(w: World, px: number, py: number, amount: number) {
  const k = cellOf(px, py), v = clamp((w.fert[k] ?? 0) + amount, -0.5, 0.5);
  if (Math.abs(v) < 0.004) delete w.fert[k];
  else w.fert[k] = Math.round(v * 1e4) / 1e4;
}

// Once a day: every animal that walks the ground and every person leaves its dung where it is, and every change washes
// a little further out, three percent a day, so a burn's ash is half gone in some three weeks.
export function settle(w: World) {
  if (w.t % DAY !== DAY / 4) return;
  for (const an of w.animals) if (FAUNA[an.species].ground) enrich(w, an.px, an.py, 0.008);
  for (const a of w.agents) enrich(w, a.px, a.py, 0.01);
  for (const key of Object.keys(w.fert)) {
    const k = Number(key), v = w.fert[k] * 0.97;
    if (Math.abs(v) < 0.004) delete w.fert[k];
    else w.fert[k] = Math.round(v * 1e4) / 1e4;
  }
}
