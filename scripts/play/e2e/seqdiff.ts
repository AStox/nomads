// seqdiff.ts dir log: mean absolute grey difference (0..255) between consecutive wheelmark shots, with the zooms they were taken at
import { sharp } from "./lib.ts";
import { readdirSync, readFileSync } from "node:fs";
const [dir, log] = process.argv.slice(2);
const zs = readFileSync(log, "utf8").split("\n").filter((l) => l.startsWith("{")).map((l) => JSON.parse(l).z);
const fs = readdirSync(dir).filter((f) => f.endsWith(".jpg")).sort();
let prev: Buffer | null = null; const out: string[] = [];
for (let i = 0; i < fs.length; i++) {
  const b = await sharp(`${dir}/${fs[i]}`).resize(160, 100).greyscale().raw().toBuffer();
  if (prev) { let d = 0; for (let j = 0; j < b.length; j++) d += Math.abs(b[j] - prev[j]); out.push(`${zs[i - 1]}-${zs[i]}:${(d / b.length).toFixed(1)}`); }
  prev = b;
}
console.log(out.join(" "));
