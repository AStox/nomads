// How fast food goes bad where it is (docs/research/time-constants.md sec. 1): as fast as what spoils it grows or it
// breathes at the warmth it is kept at, against how long it keeps at 0 C. Flesh spoils as the cold-loving bacteria that
// spoil chilled fish and meat grow, by Ratkowsky's square root (nothing below -10 C); fruit, mushrooms and leaves as fast
// as they breathe, by the handbook's measured respiration at each warmth; dried nuts hardly at all below 10 C; grain by
// Fraser and Muir's storage time for its warmth and water.
import type { Kind, Registry } from "./materials";
import { physOf, type Phys } from "./fuel";

// The ways things spoil: by the bacteria of chilled flesh, by the breath of a berry, a mushroom or a leaf, as a dried
// nut does, or as stored grain does.
export type Spoils = "chill" | "berry" | "mushroom" | "leaf" | "nut" | "grain";
// Respiration, mg CO2 a kg an hour, at each warmth, C (USDA Agriculture Handbook 66, the middles of its ranges): the
// blackberry's for the berry, the mushroom's, and watercress's for a leaf.
const BREATH: Record<"berry" | "mushroom" | "leaf", [number, number][]> = {
  berry: [[0, 19], [4.5, 36], [10, 62], [15.5, 75], [20, 115]],
  mushroom: [[0, 36], [5, 70], [10, 97], [20, 264]],
  leaf: [[0, 22], [5, 50], [10, 110], [15, 175], [20, 322], [25, 377]],
};
// Between the measured warmths, a straight line; past them, the nearest two's line, and never below nothing.
function breath(at: [number, number][], T: number) {
  let i = 0;
  while (i < at.length - 2 && T > at[i + 1][0]) i++;
  const [[t0, r0], [t1, r1]] = [at[i], at[i + 1]];
  return Math.max(0, r0 + ((r1 - r0) * (T - t0)) / (t1 - t0));
}
// How much faster something spoiling this way spoils at T, C, than at 0 C.
export function spoilRate(how: Spoils, T: number) {
  if (how === "chill") return T <= -10 ? 0 : ((T + 10) / 10) ** 2;
  if (how === "nut") return 2 ** (Math.max(0, T - 10) / 10);
  if (how === "grain") return 1;
  return breath(BREATH[how], T) / BREATH[how][0][1];
}
// Fraser and Muir's days stored grain keeps at T, C, holding this share of water to its whole mass.
export const grainDays = (T: number, water: number) => 10 ** (6.234 - 0.2118 * 100 * water - 0.0527 * T);
// How much of the way to spoiled food of a kind goes in an hour at T, C (0 for what doesn't spoil).
export function rotPerHour(kinds: Registry, k: Kind | undefined, T: number) {
  if (!k?.spoils) return 0;
  if (k.spoils === "grain") {
    const phys: Phys | undefined = physOf(kinds, k), green = phys?.green ?? 0;
    return 1 / (24 * grainDays(T, green / (1 + green)));
  }
  return k.shelf ? spoilRate(k.spoils, T) / (24 * k.shelf) : 0;
}
// How many days food of a kind keeps at T, C.
export const keepsFor = (kinds: Registry, k: Kind | undefined, T: number) => { const r = rotPerHour(kinds, k, T); return r > 0 ? 1 / (24 * r) : Infinity; };
