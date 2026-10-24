import { hp, shiftSearch, OUT } from "./lib.ts";
const [place, z, tag = "t5", offs = "0,0;1000,0;2000,0;0,1500;-2500,0;0,-2500"] = process.argv.slice(2);
for (const o of offs.split(";")) {
  const [ox, oz] = o.split(",");
  const A = await hp(`${OUT}/${tag}-${place}-${z}-pg0-${ox}_${oz}.png`, 6), B = await hp(`${OUT}/${tag}-${place}-${z}-pg1-${ox}_${oz}.png`, 6);
  const row: string[] = [];
  for (let by = 0; by < 3; by++) for (let bx = 0; bx < 3; bx++) { const r = shiftSearch(A, B, 160 + bx * 400, 100 + by * 300, 320, 220, 60, undefined, 2); row.push(`(${r.best[0]},${r.best[1]})${r.cost}/${r.zero}`); }
  console.log(`offset ${o}:`, row.join("  "));
}
