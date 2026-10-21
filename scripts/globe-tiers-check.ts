// What the finer tiers made (scripts/globe-tiers.ts) holds: one drainage network over the whole last tier, and the hashes of its fields (for identity across two bakes).
//   bun scripts/globe-tiers-check.ts --seed 1 --key 4c2a2cb36ba6 --tier 4
import { createHash } from "node:crypto";
import { drainage } from "../src/gpu/globe/tiers";
import { PLANET_RADIUS_M, PLANET_TIER } from "../src/gpu/globe/grid";
import { bakeDir } from "./globe-tiers";
import { sourceKey } from "./globe-window";

const arg = (name: string, d: string) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : d; };
const seed = Number(arg("seed", "1")), key = arg("key", "") || sourceKey(undefined, PLANET_RADIUS_M), tier = Number(arg("tier", String(PLANET_TIER))), dir = bakeDir(seed, key);
const sha = (a: ArrayBufferView) => createHash("sha256").update(new Uint8Array(a.buffer, a.byteOffset, a.byteLength)).digest("hex").slice(0, 16);
const height = dir.i32(`t${tier}-height`), to = dir.u32(`t${tier}-to`), flooded = dir.i32(`t${tier}-flooded`);
const t0 = performance.now(), d = drainage(tier, height, to, flooded);
console.log(JSON.stringify({ tier, ...d, seconds: Math.round((performance.now() - t0) / 100) / 10 }));
console.log(JSON.stringify({ height: sha(height), to: sha(to), acc: sha(dir.u32(`t${tier}-acc`)), flooded: sha(flooded) }));
