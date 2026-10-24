import { sharp } from "./lib";
const names = ["3","3_5","4","5","6","8","10","14","20"];
let prev: Buffer | null = null;
for (const n of names) {
  const b: Buffer = await sharp(`shots/load-${n}.jpg`).resize(200, 125).removeAlpha().raw().toBuffer();
  if (prev) { let d = 0; for (let i = 0; i < b.length; i++) d += Math.abs(b[i] - prev[i]); console.log(n, (d / b.length).toFixed(2)); }
  prev = b;
}
