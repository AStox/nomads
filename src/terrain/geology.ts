// The island's bedrock: what kind of rock lies under each cell, and what that rock is like. The kinds come from two
// fields the uplift lays down together, hardness (which the rivers and slopes erode against, so the hard rock stands as
// the ranges) and chemistry (whether a rock weathers to bases, as limestone and basalt do, or to acid sand, as granite and
// sandstone do). Soil, groundwater, springs and what can be found lying about all answer to these properties, never to
// the rock's name.
export type Rock = {
  name: string;
  perm: number; // 0..1 how readily water sinks into the rock and moves through it: joints, pores, solution channels
  base: number; // 0..1 the bases it weathers to (lime, magnesia), which keep a soil sweet against the rain's leaching
  sand: number; // share of sand in the soil it weathers to
  clay: number; // share of clay in that soil
  feed: number; // 0..1 the mineral nourishment it releases to roots
  flint: number; // 0..1 how often a stone of it holds flint, or the chert, quartz or chalcedony that knaps and sparks like it
  ore: number; // 0..1 how often iron ore weathers out of it
};
export const ROCKS: Rock[] = [
  { name: "mudstone", perm: 0.05, base: 0.5, sand: 0.15, clay: 0.55, feed: 0.65, flint: 0.15, ore: 0.35 },
  { name: "sandstone", perm: 0.55, base: 0.15, sand: 0.75, clay: 0.08, feed: 0.25, flint: 0.25, ore: 0.15 },
  { name: "limestone", perm: 0.85, base: 1, sand: 0.05, clay: 0.25, feed: 0.5, flint: 0.9, ore: 0.02 },
  { name: "granite", perm: 0.08, base: 0.1, sand: 0.6, clay: 0.15, feed: 0.3, flint: 0.08, ore: 0.25 },
  { name: "basalt", perm: 0.3, base: 0.75, sand: 0.15, clay: 0.45, feed: 0.95, flint: 0.12, ore: 0.5 },
];
// Soft rock is mudstone; middling rock limestone where it is rich in bases and sandstone where it is not; hard rock basalt
// or granite the same way.
export function rockOf(hard: number, chem: number) {
  if (hard < 0.4) return 0;
  if (hard < 0.62) return chem > 0.55 ? 2 : 1;
  return chem > 0.6 ? 4 : 3;
}
