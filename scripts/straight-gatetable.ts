// The gate table of the limited carry: reads the JSON-lines files of scripts/straight-rungates.sh (lim/gates/<old|unlimited|limited>-<region>-t<tier>.jsonl) and prints one table a region and tier,
// old planet | new unlimited | new limited, the terrain gates and the straight-feature measures (scripts/gates/straight.ts of branch globe-t4-straight).
//   bun scripts/straight-gatetable.ts [tier=5]
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";

const G = `${homedir()}/.cache/nomads-scratch/t4/lim/gates`, tier = process.argv[2] ?? "5", runs = ["old", "unlimited", "limited"];
const load = (run: string, region: string) => {
  const p = `${G}/${run}-${region}-t${tier}.jsonl`, m = new Map<string, unknown>();
  if (!existsSync(p)) return m;
  for (const l of readFileSync(p, "utf8").split("\n")) if (l) { const d = JSON.parse(l); m.set(d.measure, d.value); }
  return m;
};
const at = (v: unknown, path: string) => path.split(".").reduce<unknown>((a, k) => (a == null ? a : (a as Record<string, unknown>)[k]), v);
const ROWS: [string, string, string][] = [
  ["land cells", "region.landCells", ""], ["land p99 m", "region.landP99", ""], ["slope p50", "region.slope", "p50"], ["slope p99", "region.slope", "p99"],
  ["hold error box p99 m", "region.holdError", "box.p99"], ["lock windows", "region.lock", "locked"], ["ridge wavelength km", "region.ridge", "wavelengthKm"],
  ["river straight30", "region.rivers", "straight30"], ["river lattice-straight300", "region.rivers", "latticeStraight300"], ["stem sinuosity", "region.rivers", "stem.sinuosity"],
  ["relief >1000 m", "region.relief10", "above1000"], ["relief >1500 m", "region.relief10", "above1500"],
  ["coast cells", "straight.coast", "cells"], ["coast axis run share L32", "straight.coast", "axis.L32"], ["coast axis run share L64", "straight.coast", "axis.L64"],
  ["coast axis over rotated L32", "straight.rot", "coast.axisOverRotated.L32"], ["coast longest axis run km", "straight.coast", "longestKm.axis"],
  ["exact lattice-line coast share L32", "straight.exact", "coast.share.L32"], ["exact lattice-line coast share L64", "straight.exact", "coast.share.L64"], ["exact longest km", "straight.exact", "coast.longestKm"],
  ["coast edges on 32-cell lines (x)", "straight.phase", "coast.x.4"], ["thin land cells (spits)", "straight.spits", "thinCells"], ["spit strips (n)", "straight.spits", "strips.n"],
  ["thin sea cells (inlets)", "straight.inlets", "thinCells"], ["sea strips (n)", "straight.inlets", "strips.n"], ["lakes (n, 16+ cells)", "straight.lakes", "n"], ["lake strips (moment, n)", "straight.lakes", "strips.moment.n"],
];
const fmt = (v: unknown) => (v == null ? "-" : typeof v === "number" ? (Math.abs(v) >= 100 ? String(Math.round(v)) : String(+v.toPrecision(3))) : String(v));
for (const region of ["home", "Rblk", "R1", "A"]) {
  const data = runs.map((r) => load(r, region));
  console.log(`\n${region} tier ${tier}`);
  console.log(`| measure | ${runs.join(" | ")} |\n|---|---|---|---|`);
  for (const [label, m, path] of ROWS) console.log(`| ${label} | ${data.map((d) => fmt(path ? at(d.get(m), path) : d.get(m))).join(" | ")} |`);
}
