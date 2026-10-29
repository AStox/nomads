// pooled straight gates of out/pg-<label>.jsonl (rows of scripts/gates/straight.ts): coast axis share at 16 and 32 cells, reversals per 100 km, squared share of pits and of lakes
//   bun scratch/sh/shoresum.ts A2 y30 y100 [--places rA,rR]
import { readFileSync } from "node:fs";
const args = process.argv.slice(2), pi = args.indexOf("--places"), keep = pi >= 0 ? args[pi + 1].split(",") : null, labels = pi >= 0 ? args.filter((_, i) => i !== pi && i !== pi + 1) : args;
for (const v of labels) {
  const rows = readFileSync(`${process.env.HOME}/.cache/nomads-scratch/t7/out/pg-${v}.jsonl`, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  let cells = 0, ax = 0, ax16 = 0, rev = 0, km = 0, pn = 0, ps = 0, ln = 0, ls = 0; const per: string[] = [];
  for (const r of rows) {
    const place = r.name.split("-").pop();
    if (keep && !keep.includes(place)) continue;
    if (r.measure === "straight.coast") { cells += r.value.cells; ax += r.value.cells * r.value.axis.L32; ax16 += r.value.cells * r.value.axis.L16; per.push(`${place} ax32 ${r.value.axis.L32.toFixed(2)}`); }
    if (r.measure === "straight.teeth") { rev += r.value.reversals; km += r.value.km; per.push(`${place} rev/100km ${(r.value.reversalsPerKm * 100).toFixed(1)}`); }
    if (r.measure === "straight.patches") { pn += r.value.pits.n; ps += r.value.pits.n * r.value.pits.corners.squared; ln += r.value.lakes.n; ls += r.value.lakes.n * r.value.lakes.corners.squared; }
  }
  console.log(v, "coast cells", cells, "axis32", (ax / cells).toFixed(3), "axis16", (ax16 / cells).toFixed(3), "reversals/100km", (100 * rev / km).toFixed(2), "pits", pn, "squared", pn ? (ps / pn).toFixed(3) : "-", "lakes", ln, "squared", ln ? (ls / ln).toFixed(3) : "-", "|", per.join("; "));
}
