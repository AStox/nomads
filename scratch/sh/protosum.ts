// pooled coast gates of out/pg-<label>.jsonl: bun sh/protosum.ts A2 s10 s30 s02
import { readFileSync } from "node:fs";
for (const v of process.argv.slice(2)) {
  const rows = readFileSync(`${process.env.HOME}/.cache/nomads-scratch/t7/out/pg-${v}.jsonl`, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  let cells = 0, ax = 0, rev = 0, km = 0, ax16 = 0; const per: string[] = [];
  for (const r of rows) {
    if (r.measure === "straight.coast") { cells += r.value.cells; ax += r.value.cells * r.value.axis.L32; ax16 += r.value.cells * r.value.axis.L16; per.push(r.name.split("-")[1] + " ax32 " + r.value.axis.L32.toFixed(2)); }
    if (r.measure === "straight.teeth") { rev += r.value.reversals; km += r.value.km; per.push(r.name.split("-")[1] + " rev/100km " + (r.value.reversalsPerKm * 100).toFixed(1)); }
  }
  console.log(v, "coast cells", cells, "axis32", (ax / cells).toFixed(3), "axis16", (ax16 / cells).toFixed(3), "reversals/100km", (100 * rev / km).toFixed(2), "|", per.join("; "));
}
