import { sharp } from "./lib.ts";
import { readdirSync } from "node:fs";
const [a, b] = process.argv.slice(2);
for (const f of readdirSync(a).filter((x) => x.endsWith(".png")).sort()) {
  try {
    const A = await sharp(`${a}/${f}`).removeAlpha().raw().toBuffer(), B = await sharp(`${b}/${f}`).removeAlpha().raw().toBuffer();
    let d = 0, n = 0; for (let i = 0; i < A.length; i += 3) { d += Math.abs(A[i] - B[i]) + Math.abs(A[i + 1] - B[i + 1]) + Math.abs(A[i + 2] - B[i + 2]); n++; }
    console.log(f, (d / n / 3).toFixed(2));
  } catch (e) { console.log(f, "missing"); }
}
