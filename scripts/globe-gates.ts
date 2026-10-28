// The terrain gates as measures, one JSON line per measure ({"measure": "<kind>.<name>", "tier", "run", "value"}); definitions and citations are in each module's header
// (scripts/gates/planet.ts whole planet, region.ts a region, spectrum.ts lock and ridge spacing, rivers.ts rivers). CPU only; reads the planet's store for tier 0 (NOMADS_STORE).
//   bun scripts/globe-gates.ts planet --tier 0 --key K [--seed 1] [--run v14] [--jsonl out.jsonl] [--chain <store>/chain.bin]
//   bun scripts/globe-gates.ts planet --tier 3 --t3dir DIR --key K            # DIR/<seed>-<key>/t3-height.i32 (1/256 m), cells stride 2 for the relief windows
//   bun scripts/globe-gates.ts region --name R1-t5 --land-dir DIR --tier 5 --face 0 --tx 23 --ty 17 --tiles 8 --key K [--state path]
//   bun scripts/globe-gates.ts window --file t5-height.i32 [--flooded t5-flooded.i32] --tier 5 [--down 2] --face 1 --x0 2304 --y0 4096 --size 2048 --name old-Rblk   # straight gates on a window of ANY whole-tier file (--down k: its k x k box means)
//   bun scripts/globe-gates.ts pick --file t5-height.i32 --tier 5 --size 2048 --min-land 0.3 [--step 1024]   # windows of the file holding at least that share of land (sampled every 8th cell)
//   (region takes --only straight: the straight-coast / lake / spit gates alone; both print straight.coast, straight.lakes, straight.lakesFile, straight.spits, straight.rot)
//   bun scripts/globe-gates.ts map --t3dir DIR --key K --out planet.png [--vex 4]   # 4096 x 2048 equirectangular of tier 3, hillshaded
import { appendFileSync, closeSync, openSync, readFileSync, readSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PLANET_RADIUS_M, fromLatLon, locateVec, makeGrid } from "../src/gpu/globe/grid";
import { readPlanet, unpackRecord } from "../src/gpu/globe/window";
import { STORE } from "./globe-planet";
import { diskStore } from "./globe-window";
import { heightColor, png } from "./globe-maps";
import { planetMeasures } from "./gates/planet";
import { regionMeasures } from "./gates/region";
import { straightMeasures, type StraightResult } from "./gates/straight";

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
// the cells of a size x size window at (face, x0, y0) of a whole-tier i32 file (face-major cells (face * fn + Y) * fn + X; fn = 2048 at tier 3, doubling per tier)
function readWindow(path: string, fn: number, face: number, x0: number, y0: number, size: number): Int32Array {
  const fd = openSync(path, "r"), out = new Int32Array(size * size);
  try {
    for (let y = 0; y < size; y++) {
      const row = new Uint8Array(out.buffer, y * size * 4, size * 4);
      if (readSync(fd, row, 0, size * 4, ((face * fn + y0 + y) * fn + x0) * 4) !== size * 4) throw new Error(`${path}: short read at face ${face} row ${y0 + y}`);
    }
  } finally { closeSync(fd); }
  return out;
}
const straightEmit = (name: string, tier: number, face: number, x0: number, y0: number, r: StraightResult) => emit("straight", tier, r as unknown as Record<string, unknown>, { name, face, x0, y0 });
const log = (s: string) => console.error(`  ${s} (${(process.uptime()).toFixed(0)} s)`);

if (import.meta.main) {
  if (cmd === "planet") {
    const tier = Number(arg("tier", "0"));
    if (tier === 0) {
      // --chain <chain.bin>: the chain's own heights (before the ice's cut), when the later stages are not there yet
      const chain = arg("chain", "");
      let h: Float32Array, radius: number;
      if (chain) { const b = readFileSync(chain), r = unpackRecord(new Uint8Array(b.buffer, b.byteOffset, b.byteLength)); h = r.arrays.height as Float32Array; radius = Number(r.meta.radius); }
      else { const p = await readPlanet(seed, diskStore(STORE, key)); h = p.height; radius = p.radius; }
      emit("planet", 0, planetMeasures({ fn: 256, h, radius }, { coast: true, log }));
    } else if (tier === 3) {
      const raw = t3(), h = new Float32Array(raw.length);
      for (let i = 0; i < raw.length; i++) h[i] = raw[i] / 256;
      emit("planet", 3, planetMeasures({ fn: 2048, h, radius: PLANET_RADIUS_M }, { stride: 2, log }));
    } else throw new Error(`planet --tier ${tier}: only tiers 0 and 3`);
  } else if (cmd === "region") {
    const tier = Number(arg("tier", "5")), tiles = Number(arg("tiles", "8")), down = 2 ** (5 - tier), size = (tiles * 256) / down;
    const face = Number(arg("face", "0")), tx = Number(arg("tx", "0")), ty = Number(arg("ty", "0")), name = arg("name", "");
    const state = arg("state", join(arg("land-dir", ""), name, "state.i32")), h = i32(state);
    if (h.length !== size * size) throw new Error(`${state}: ${h.length} cells, wanted ${size} x ${size}`);
    const cellM = 75 * down, margin = Math.floor(64 / down);
    if (arg("only", "") !== "straight") {
      const p = await readPlanet(seed, diskStore(STORE, key));
      emit("region", tier, regionMeasures({ h, size, tier, face, x0: (tx * 256) / down, y0: (ty * 256) / down, planet0: p.height }, log) as unknown as Record<string, unknown>, { name, face, tx, ty });
    }
    straightEmit(name, tier, face, (tx * 256) / down, (ty * 256) / down, straightMeasures({ h, size, cellM, margin, ox: (tx * 256) / down, oy: (ty * 256) / down }, log));
  } else if (cmd === "window") {
    // --down k: the window's k x k box means (a coarser tier made of the file's own cells: the old planet's box hold makes its tier 3 the 4 x 4 means of its tier 5); size, margin in output cells
    const ftier = Number(arg("tier", "5")), down = Number(arg("down", "1")), tier = ftier - Math.log2(down), fn = 2048 * 2 ** (ftier - 3), size = Number(arg("size", "2048")), face = Number(arg("face", "0")), x0 = Number(arg("x0", "0")), y0 = Number(arg("y0", "0"));
    const margin = Number(arg("margin", String(Math.floor(64 / 2 ** (5 - tier))))), flooded = arg("flooded", "");
    const read = (f: string) => {
      const raw = readWindow(f, fn, face, x0, y0, size * down);
      if (down === 1) return raw;
      const out = new Int32Array(size * size);
      for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) { let t = 0; for (let b = 0; b < down; b++) for (let a = 0; a < down; a++) t += raw[(y * down + b) * size * down + x * down + a]; out[y * size + x] = Math.round(t / (down * down)); }
      return out;
    };
    straightEmit(arg("name", ""), tier, face, x0, y0, straightMeasures({ h: read(arg("file", "")), size, cellM: 75 * 2 ** (5 - tier), margin, flooded: flooded ? read(flooded) : undefined, ox: x0 / down, oy: y0 / down }, log));
  } else if (cmd === "pick") {
    const tier = Number(arg("tier", "5")), fn = 2048 * 2 ** (tier - 3), size = Number(arg("size", "2048")), step = Number(arg("step", String(size / 2))), min = Number(arg("min-land", "0.3")), sample = 8;
    const fd = openSync(arg("file", ""), "r"), per = fn / sample, grid = new Uint8Array(6 * per * per), row = new Int32Array(fn);
    for (let face = 0; face < 6; face++) for (let j = 0; j < per; j++) {
      readSync(fd, new Uint8Array(row.buffer), 0, fn * 4, ((face * fn + j * sample) * fn) * 4);
      for (let i = 0; i < per; i++) grid[(face * per + j) * per + i] = row[i * sample] > 0 ? 1 : 0;
    }
    closeSync(fd);
    const w = size / sample;
    for (let face = 0; face < 6; face++) for (let y0 = 0; y0 + size <= fn; y0 += step) for (let x0 = 0; x0 + size <= fn; x0 += step) {
      let land = 0;
      for (let j = 0; j < w; j++) for (let i = 0; i < w; i++) land += grid[(face * per + y0 / sample + j) * per + x0 / sample + i];
      if (land / (w * w) >= min) console.log(JSON.stringify({ face, x0, y0, size, land: +(land / (w * w)).toFixed(3) }));
    }
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
