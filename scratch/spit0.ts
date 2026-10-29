import { readFileSync } from "node:fs";
const a = new Float32Array(new Uint8Array(readFileSync((process.env.RAW_DIR ?? process.env.HOME + "/.cache/nomads-scratch/t7/raw") + "/" + (process.env.FILE ?? "height.f32"))).buffer);
const fn = 256, f = Number(process.argv[2] ?? 4), X0 = Number(process.argv[3]), Y0 = Number(process.argv[4]), W = Number(process.argv[5] ?? 24), H = Number(process.argv[6] ?? 24);
for (let Y = Y0; Y < Y0 + H; Y++) {
  let s = "";
  for (let X = X0; X < X0 + W; X++) {
    const v = a[(f * fn + Y) * fn + X];
    const t = Math.abs(v) < 100 ? v.toFixed(0) : (v / 1000).toFixed(1) + "k";
    s += t.padStart(6);
  }
  console.log(String(Y).padStart(3), s);
}
