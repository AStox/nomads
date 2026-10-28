// The contact sheet: one row per feature, columns NEW T5 harness | NEW T4 streamed (T3 carry in the lowland row) | OLD T5 harness | OLD T5 live, 400 x 400 tier-5 cells each at 1 px a cell.
//   bun scripts/straight-contact.ts [out.png]
import { writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { sources } from "./straight-pictures";
import { panel, sheet } from "./straight-lib";

const out = process.argv[2] ?? `${homedir()}/.cache/nomads-scratch/t4/out/straight/contact.png`;
const rows: { title: string; region: string; face: number; x: number; y: number; cols: string[]; vex: number }[] = [
  { title: "F1 F2 SPIT AND LAKE STRIP (HOME)", region: "home", face: 4, x: 6780, y: 5880, cols: ["newt5h", "newt4", "oldt5h", "old5"], vex: 3 },
  { title: "F3 COAST CORNER (HOME)", region: "home", face: 4, x: 6850, y: 5650, cols: ["newt5h", "newt4", "oldt5h", "old5"], vex: 3 },
  { title: "F4 PARALLEL RIDGES (HOME)", region: "home", face: 4, x: 7300, y: 6900, cols: ["newt5h", "newt4", "oldt5h", "old5"], vex: 2 },
  { title: "RBLK STRIPS", region: "Rblk", face: 1, x: 3980, y: 4300, cols: ["newt5h", "newt4", "oldt5h", "old5"], vex: 3 },
  { title: "LOWLAND COAST AND LAKES (FACE 3, OLD WINDOW A): NEW T3 AND T4, OLD", region: "oldA", face: 3, x: 6000, y: 2100, cols: ["newt3", "newt4", "oldt5h", "old5"], vex: 3 },
];
const panels: { label: string; rgb: Uint8Array }[] = [];
for (const r of rows) {
  const s = sources(r.region), win = { face: r.face, x: r.x, y: r.y, w: 400, h: 400 };
  for (const c of r.cols) panels.push({ label: `${r.title.split(" ")[0]} ${s[c].label}`, rgb: panel(s[c], win, { vex: r.vex, lattice: true }) });
}
writeFileSync(out, sheet(panels, 400, 400, 4, "CONTACT SHEET 1 PX = 1 T5 CELL (75 M), RED LINES EVERY 32 CELLS = TIER-0 CELL EDGES"));
console.log(out);
