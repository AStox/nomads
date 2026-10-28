// The terrain gates as measures, one JSON line per measure ({"measure": "<kind>.<name>", "tier", "run", "value"}); definitions and citations are in each module's header
// (scripts/gates/planet.ts whole planet, region.ts a region, spectrum.ts lock and ridge spacing, rivers.ts rivers). CPU only; reads the planet's store for tier 0 (NOMADS_STORE).
//   bun scripts/globe-gates.ts planet --tier 0 --key K [--seed 1] [--run v14] [--jsonl out.jsonl]
//   bun scripts/globe-gates.ts planet --tier 3 --t3dir DIR --key K            # DIR/<seed>-<key>/t3-height.i32 (1/256 m), cells stride 4 for the relief windows
//   bun scripts/globe-gates.ts region --name R1-t5 --land-dir DIR --tier 5 --face 0 --tx 23 --ty 17 --tiles 8 --key K [--state path]
//   bun scripts/globe-gates.ts map --t3dir DIR --key K --out planet.png [--vex 4]   # 4096 x 2048 equirectangular of tier 3, hillshaded
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PLANET_RADIUS_M, fromLatLon, locateVec, makeGrid } from "../src/gpu/globe/grid";
import { readPlanet } from "../src/gpu/globe/window";
import { STORE } from "./globe-planet";
import { diskStore } from "./globe-window";
import { heightColor, png } from "./globe-maps";
import { planetMeasures } from "./gates/planet";
import { regionMeasures } from "./gates/region";

const arg = (name: string, d: string) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : d; };
const cmd = process.argv[2], seed = Number(arg("seed", "1")), key = arg("key", ""), runName = arg("run", ""), jsonl = arg("jsonl", "");

function emit(kind: string, tier: number, rec: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  for (const [name, value] of Object.entries(rec)) {
    const line = JSON.stringify({ measure: `${kind}.${name}`, tier, run: runName, ...extra, value });
    console.log(line);
    if (jsonl) appendFileSync(jsonl, line + "\n");
  }
}
function i32(path: string) { const b = readFileSync(path); return new Int32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)); }
const t3 = () => i32(join(arg("t3dir", ""), `${seed}-${key}`, "t3-height.i32"));
const log = (s: string) => console.error(`  ${s} (${(process.uptime()).toFixed(0)} s)`);

if (import.meta.main) {
  if (cmd === "planet") {
    const tier = Number(arg("tier", "0"));
    if (tier === 0) {
      const p = await readPlanet(seed, diskStore(STORE, key));
      emit("planet", 0, planetMeasures({ fn: 256, h: p.height, radius: p.radius }, { coast: true, log }));
    } else if (tier === 3) {
      const raw = t3(), h = new Float32Array(raw.length);
      for (let i = 0; i < raw.length; i++) h[i] = raw[i] / 256;
      emit("planet", 3, planetMeasures({ fn: 2048, h, radius: PLANET_RADIUS_M }, { stride: 4, log }));
    } else throw new Error(`planet --tier ${tier}: only tiers 0 and 3`);
  } else if (cmd === "region") {
    const tier = Number(arg("tier", "5")), tiles = Number(arg("tiles", "8")), down = 2 ** (5 - tier), size = (tiles * 256) / down;
    const face = Number(arg("face", "0")), tx = Number(arg("tx", "0")), ty = Number(arg("ty", "0")), name = arg("name", "");
    const state = arg("state", join(arg("land-dir", ""), name, "state.i32")), h = i32(state);
    if (h.length !== size * size) throw new Error(`${state}: ${h.length} cells, wanted ${size} x ${size}`);
    const p = await readPlanet(seed, diskStore(STORE, key));
    emit("region", tier, regionMeasures({ h, size, tier, face, x0: (tx * 256) / down, y0: (ty * 256) / down, planet0: p.height }, log), { name, face, tx, ty });
  } else if (cmd === "map") {
    const raw = t3(), g = makeGrid(2048, PLANET_RADIUS_M), W = 4096, Hh = 2048, vex = Number(arg("vex", "4")), z = new Float32Array(W * Hh);
    for (let j = 0; j < Hh; j++) for (let i = 0; i < W; i++) {
      let s = 0;
      for (let a = 0; a < 2; a++) for (let b = 0; b < 2; b++) {
        const lat = Math.PI / 2 - ((j + (a + 0.5) / 2) * Math.PI) / Hh, lon = ((i + (b + 0.5) / 2) * 2 * Math.PI) / W - Math.PI, c = locateVec(g, fromLatLon(lat, lon));
        s += raw[(c.face * 2048 + c.Y) * 2048 + c.X] / 256;
      }
      z[j * W + i] = s / 4;
    }
    const rgb = new Uint8Array(W * Hh * 3), az = (315 * Math.PI) / 180, alt = Math.PI / 4, L = [Math.sin(az) * Math.cos(alt), Math.cos(az) * Math.cos(alt), Math.sin(alt)];
    for (let j = 0; j < Hh; j++) {
      const lat = Math.PI / 2 - ((j + 0.5) * Math.PI) / Hh, dx = PLANET_RADIUS_M * Math.max(0.05, Math.cos(lat)) * ((2 * Math.PI) / W), dy = PLANET_RADIUS_M * (Math.PI / Hh);
      for (let i = 0; i < W; i++) {
        const k = j * W + i, e = z[j * W + ((i + 1) % W)], w = z[j * W + ((i + W - 1) % W)], n = z[Math.max(0, j - 1) * W + i], s = z[Math.min(Hh - 1, j + 1) * W + i];
        const gx = (e - w) / (2 * dx) * vex, gy = (n - s) / (2 * dy) * vex, nl = Math.hypot(gx, gy, 1), shade = Math.max(0, (-gx * L[0] - gy * L[1] + L[2]) / nl) / L[2] / Math.SQRT2 * 1.0;
        const col = heightColor(z[k]), f = z[k] > 0 ? 0.35 + 0.75 * shade : 0.8 + 0.2 * shade;
        for (let c = 0; c < 3; c++) rgb[k * 3 + c] = Math.max(0, Math.min(255, col[c] * f));
      }
    }
    writeFileSync(arg("out", "planet.png"), png(W, Hh, rgb));
    console.log(`map ${arg("out", "planet.png")}`);
  } else console.error("usage: globe-gates.ts planet|region|map (see the header)");
}
