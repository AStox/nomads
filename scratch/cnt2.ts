import { readFileSync } from "node:fs";
const b = readFileSync(process.argv[2]); const a = new Int32Array(b.buffer, b.byteOffset, b.length / 4); const n = 1024; const g = new Array(8).fill(0).map(() => new Array(8).fill(0));
for (let i = 0; i < a.length; i++) if (a[i] > 0) g[Math.floor(Math.floor(i / n) / 128)][Math.floor((i % n) / 128)]++;
console.log(g.map((r) => r.map((v) => String(v).padStart(6)).join("")).join("\n"));
