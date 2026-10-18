// The ground on the GPU against src/terrain/ground.ts: each field within a stated tolerance of the float stage on the
// Site islands 1 to 3 give it, the same words on a second run, and one island's time. One case a seed (the island takes
// some 10 s to make), plus one on seed 1 with its rock rearranged so the beaches, limestone and mudstone pH classes and
// the sand coast all occur, which the Bornholm islands' crystalline coasts do not give.
import { afterAll, expect, test } from "bun:test";
import { rng } from "../../sim/world";
import { LEN } from "../../terrain/grid";
import { generateIsland } from "../../terrain/island";
import { ground, type Ground, type Site } from "../../terrain/ground";
import { LIMESTONE, MUDSTONE, SANDSTONE } from "../../terrain/geology";
import { releaseGpu, theGpu } from "../device";
import { groundGpu } from "./ground";

afterAll(releaseGpu);

// Each field's tolerance (max abs error) and the reason it is enough. Every input is rounded to 2^-16, which moves a
// fit that rises steeply from nothing (a tree on a water table of 0.24 m) by some 3e-4 of itself, and so the shares of
// the few cells on such a rise by up to 5e-4; carbon and nitrogen follow their cover by 1e-4 of themselves.
const TOL: Record<string, number> = {
  soil: 1e-4, silt: 0, sand: 0, peat: 1e-4, sandy: 1e-4, clayey: 1e-4, carbon: 0.05, organic: 0.02, nitrogen: 0.05, ph: 1e-4, fertility: 1e-4, moist: 1e-4,
  soilWater: 5e-4, tree: 1e-3, shrub: 1e-3, grass: 1e-3, marsh: 1e-3, bare: 1e-3, field: 1e-3, fieldLight: 1e-6,
};

function island(seed: number): Site {
  const isle = generateIsland(rng(seed));
  return { ...isle, open: Uint8Array.from(isle.water, (w) => (w > 0 ? 1 : 0)) };
}

const stats = (a: Float32Array, b: Float32Array, weight?: Float32Array) => {
  let max = 0, sum = 0;
  for (let i = 0; i < LEN; i++) { const d = Math.abs(a[i] - b[i]) * (weight ? weight[i] : 1); sum += d; if (d > max) max = d; }
  return { max, mean: sum / LEN };
};

async function check(label: string, site: Site) {
  const g = await theGpu();
  const cpu = ground(site);
  await groundGpu(g, site); // the pipelines compile on first use
  const t0 = performance.now();
  const a = await groundGpu(g, site);
  const ms = performance.now() - t0;
  const b = await groundGpu(g, site);
  const all = (x: Ground) => Object.entries(x).flatMap(([k, v]) => (Array.isArray(v) ? v.map((f, s) => [`${k}${s}`, f] as const) : [[k, v] as const]));
  const bs = new Map(all(b));
  for (const [name, f] of all(a)) expect(Buffer.from(f.buffer).equals(Buffer.from(bs.get(name)!.buffer)), `${label} ${name} run to run`).toBe(true);
  const lines: string[] = [];
  for (const [name, f] of all(a)) {
    const ref = (cpu as unknown as Record<string, Float32Array | Float32Array[]>)[name.replace(/\d$/, "")];
    const r = Array.isArray(ref) ? ref[Number(name.at(-1))] : (ref as Float32Array);
    // a cell's light matters as much as its field does
    const { max, mean } = stats(f, r, name === "fieldLight" ? cpu.field : undefined);
    lines.push(`${name} max ${max.toExponential(2)} mean ${mean.toExponential(2)}`);
    expect(max, `${label} ${name}`).toBeLessThanOrEqual(TOL[name.replace(/\d$/, "")]);
  }
  console.log(`${label}: ${ms.toFixed(1)} ms\n  ${lines.join("\n  ")}`);
}

for (const seed of [1, 2, 3]) test(`ground on island ${seed}`, async () => { await check(`island ${seed}`, island(seed)); }, 300_000);

test("ground with sand coasts and limestone", async () => {
  const site = island(1);
  const rock = site.rock.slice();
  for (let i = 0; i < LEN; i++) rock[i] = [SANDSTONE, LIMESTONE, MUDSTONE][(Math.floor((i % 256) / 40) + Math.floor(i / 256 / 40)) % 3];
  await check("rearranged rock", { ...site, rock });
}, 300_000);
