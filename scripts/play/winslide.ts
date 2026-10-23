// A window's ground moved from the window before it (demo/tile.ts windowGround `from`: the lattice shifted, only the strips it uncovers made) against the same window made whole:
// the fine layers, the light grid and the stream mask must be the same bytes.
//   bun scripts/play/winslide.ts [lat lon] [--key 7f6ff6c82cdd] [--dx 40 --dy -25]
import { holdGpu, exit } from "../seeded";
import { theGpu } from "../../src/gpu/device";
import { readback } from "../../src/gpu/kernel";
import { CELL } from "../../src/terrain/grid";
import * as G from "../../demo/globe";
import * as T from "../../demo/tile";

const root = `${import.meta.dir}/../..`;
// the page modules import the generator from the built site's island.js; here it is demo/island.ts itself
Bun.plugin({
  name: "demo-island",
  setup(b) {
    b.onResolve({ filter: /(^|\/)island\.js$/ }, (a) => (a.importer.includes("/demo/styles/") ? { path: `${root}/demo/island.ts` } : undefined));
  },
});
const G0 = globalThis as Record<string, unknown>;
G0.ISO_LIB = true;
G0.document ??= { createElement: () => ({}) };
// loaded after the plugin above is in place, which a static import would not wait for
const { createWindows } = await import(`${root}/demo/styles/isopixel/groundwin.js`);

const args = process.argv.slice(2), at = (n: string, d: string) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const nums = args.filter((a) => /^-?\d/.test(a) && args[args.indexOf(a) - 1]?.startsWith("--") !== true).map(Number);
const lat = nums[0] ?? 4.35, lon = nums[1] ?? -39.38, key = at("--key", "7f6ff6c82cdd"), TIER = 5, dx = Number(at("--dx", "40")), dy = Number(at("--dy", "-25"));
await holdGpu();
const gpu = await theGpu(), radiusM = ((256 << TIER) * CELL * 2) / Math.PI;
const wins = createWindows({ G, T, gpu, base: `file:///tmp/planet-75m/1-${key}`, tier: TIER, seed: 1, radiusM, quick: [0, 0, 0, 0], keep: 6 });
const D2R = Math.PI / 180, cellsDeg = (CELL / radiusM) / D2R;
// the place dx, dy cells from (lat, lon): near the equator a cell is the same arc either way
const lat1 = lat - dy * cellsDeg, lon1 = lon + (dx * cellsDeg) / Math.cos(lat * D2R);

const w0 = await wins.build(lat, lon);
const whole = await wins.build(lat1, lon1);
const slid = await wins.build(lat1, lon1, w0);
console.log(`windows ${w0.id} then ${slid.id} (${slid.slid ? "slid" : "NOT slid"}), whole ${whole.id}; ground ms: whole ${whole.stats.ms.fine.toFixed(0)} slid ${slid.stats.ms.fine.toFixed(0)}`);
if (!slid.slid || whole.id !== slid.id) { console.log("FAIL the windows are not the same place"); await exit(1); }

const same = async (name: string, a: GPUBuffer, b: GPUBuffer) => {
  const A = new Uint32Array(await readback(gpu, a)), B = new Uint32Array(await readback(gpu, b));
  let bad = 0, first = -1;
  for (let i = 0; i < A.length; i++) if (A[i] !== B[i]) { bad++; if (first < 0) first = i; }
  console.log(`${bad ? "FAIL" : "ok  "} ${name.padEnd(6)} ${bad} of ${A.length} words differ${bad ? ` (first at ${first})` : ""}`);
  return bad ? 1 : 0;
};
let bad = 0;
bad += await same("fine", whole.pack.fine.gpu, slid.pack.fine.gpu);
bad += await same("grid", whole.pack.grid.gpu, slid.pack.grid.gpu);
bad += await same("mask", whole.pack.river.gpu, slid.pack.river.gpu);
let hd = 0;
for (let i = 0; i < whole.fields.h.length; i++) if (whole.fields.h[i] !== slid.fields.h[i]) hd++;
console.log(`${hd ? "FAIL" : "ok  "} heights ${hd} differ`);
await exit(bad || hd ? 1 : 0);
