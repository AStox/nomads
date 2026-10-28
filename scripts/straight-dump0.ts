// Dump a planet store's tier-0 chain (height f32, receivers u32, acc u32, face-major (face*256+y)*256+x) as raw files for the straight-feature renderer (no GPU).
//   bun scripts/straight-dump0.ts <store dir> <key> <out dir>
import { mkdirSync, writeFileSync } from "node:fs";
import { diskStore } from "./globe-window";
import { readPlanet } from "../src/gpu/globe/window";
const [store, key, out] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const p = await readPlanet(1, diskStore(store, key));
const w = (n: string, a: ArrayBufferView) => writeFileSync(`${out}/${n}`, new Uint8Array(a.buffer, a.byteOffset, a.byteLength));
w("height.f32", p.height); w("to.u32", p.to); w("acc.u32", p.acc);
console.log(p.n, p.height.length, p.height.slice(0, 4));
