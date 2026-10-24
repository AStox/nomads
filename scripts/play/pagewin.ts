// A window built from pages (groundwin.js build: ensurePages) against the window's own ground (demo/tile.ts windowGround) on the same cells: the camera's heights the page
// assembles from its pages' own must be the window's, vertex for vertex, and a window made after one that overlaps it makes only the pages it does not share.
//   lockf /tmp/nomads-gpu.lock bun scripts/play/pagewin.ts [lat lon] [--key 7f6ff6c82cdd] [--dx 80 --dy 0]
import { holdGpu, exit } from "../seeded";
import { theGpu } from "../../src/gpu/device";
import { CELL } from "../../src/terrain/grid";
import * as G from "../../demo/globe";
import * as T from "../../demo/tile";

const root = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
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
const lat = nums[0] ?? 4.35, lon = nums[1] ?? -39.38, key = at("--key", "7f6ff6c82cdd"), TIER = 5, dx = Number(at("--dx", "80")), dy = Number(at("--dy", "0"));
await holdGpu();
const gpu = await theGpu(), radiusM = ((256 << TIER) * CELL * 2) / Math.PI;
const wins = createWindows({ G, T, gpu, base: `file:///tmp/planet-75m/1-${key}`, tier: TIER, seed: 1, radiusM, quick: [0, 0, 0, 0], keep: 6 });
const D2R = Math.PI / 180, cellsDeg = CELL / radiusM / D2R;

const w0 = await wins.build(lat, lon);
console.log(`window ${w0.id}: ${w0.stats.made} pages made, ${w0.stats.ms.fine.toFixed(0)} ms for the ground (tiles ${w0.stats.ms.tiles.toFixed(0)}, pack ${w0.stats.ms.pack.toFixed(0)})`);
const wg = await T.windowGround(gpu, w0.src, w0.face, w0.x0, w0.y0);
let bad = 0, worst = 0;
for (let i = 0; i < wg.h.length; i++) { const d = Math.abs(wg.h[i] - w0.fields.h[i]); if (d > worst) worst = d; if (d > 1e-3) bad++; }
console.log(`${bad ? "FAIL" : "ok  "} heights: ${bad} of ${wg.h.length} differ by over 1 mm, the most ${worst.toExponential(2)} m`);
const lat1 = lat - dy * cellsDeg, lon1 = lon + (dx * cellsDeg) / Math.cos(lat * D2R);
const w1 = await wins.build(lat1, lon1);
const shared = w1.pageList.filter((p: { key: string }) => w0.pageList.some((q: { key: string }) => q.key === p.key)).length;
console.log(`window ${w1.id} after ${w0.id}: ${shared} pages shared, ${w1.stats.made} made (expected ${16 - shared}), ${w1.stats.ms.fine.toFixed(0)} ms`);
const same = w1.stats.made === 16 - shared;
console.log(`${same ? "ok  " : "FAIL"} only the pages not held are made`);
await exit(bad || !same ? 1 : 0);
