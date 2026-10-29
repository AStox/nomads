import { at, readWin } from "./places";
import { tierGrid } from "../src/gpu/globe/grid";
const T3 = process.env.HOME + "/.cache/nomads-scratch/t5/bakeA2/1-b4c6e7d1b819/t3-height.i32";
const p = at("spit", tierGrid(3));
console.log(p);
const W = 40; const h = readWin(T3, 2048, p.face, p.X - W / 2, p.Y - W / 2, W);
for (let y = W - 1; y >= 0; y -= 1) console.log(Array.from({ length: W }, (_, x) => { const v = h[y * W + x] / 256; return v <= 0 ? (v < -99 ? "  ##" : v.toFixed(0).padStart(4)) : v.toFixed(0).padStart(4); }).join(""));
