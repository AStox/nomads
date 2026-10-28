// The in-memory carry of tier 0 to tier 3 (refineSmooth, with the limiter) against a streamed tier-3 file, word for word.
//   bun scripts/straight-carrycheck.ts <chain height.f32 (scripts/straight-dump0.ts)> <t3-height.i32>
import { readFileSync } from "node:fs";
import { refineSmooth } from "../src/gpu/globe/regional";
const [chain, t3file] = process.argv.slice(2), rd = (p: string) => { const b = readFileSync(p); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };
let cur: ArrayLike<number> = Float32Array.from(new Float32Array(rd(chain)), (v) => v * 256);
for (let t = 0; t < 3; t++) cur = refineSmooth(cur, t);
const mem = cur as Int32Array, got = new Int32Array(rd(t3file));
let differ = 0;
for (let i = 0; i < mem.length; i++) if (mem[i] !== got[i]) differ++;
console.log(`${mem.length} cells, ${got.length} streamed, ${differ} differ`);
