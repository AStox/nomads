import { readFileSync, existsSync } from "fs"; import { gunzipSync } from "zlib";
import { pointOf, latLon, makeGrid } from "/Users/adamstockermans/Developer/nomads/src/gpu/globe/grid";
const dir = process.env.HOME + "/.cache/nomads-play/planets/link-1-7f6ff6c82cdd/pyramid", T = 5, n = 1 << T, fn = 256 * n;
const cands: [string, number, number, number, number, number][] = [["C1", 0, 3, 3, 0, 0]];
// tier-3 hits: [face, lat, lon]; find the tier-5 tile by lat/lon via the same grid
import { locateVec } from "/Users/adamstockermans/Developer/nomads/src/gpu/globe/grid";
const hits: [string, number, number][] = [["C1", 7.58, -37.266], ["K", 21.017, 65.742], ["L", -18.428, -75.586], ["E2", 13.27, 45.0], ["M", 15.083, 41.133]];
const load = (f: number, tx: number, ty: number) => { const p = `${dir}/t${T}/f${f}/${ty}-${tx}.tile.gz`; if (!existsSync(p)) return null; const raw = gunzipSync(readFileSync(p)), hl = raw.readUInt32LE(0), meta = JSON.parse(raw.subarray(4, 4 + hl).toString()); let at = 4 + hl; const pl: any = {}; for (const fld of meta.fields) { const sz = { i8: 1, u8: 1, i16: 2, u16: 2, i32: 4, u32: 4, f32: 4 }[fld.type as string]!; pl[fld.name] = { b: raw.subarray(at, at + 65536 * sz), t: fld.type }; at += 65536 * sz; } return pl; };
const g = (pl: any, name: string, i: number) => { const { b, t } = pl[name]; return t === "i16" ? b.readInt16LE(i * 2) * 0.25 : t === "u8" ? b[i] : t === "u16" ? b.readUInt16LE(i * 2) : 0; };
const G = makeGrid(fn);
for (const [name, lat, lon] of hits) {
  const v: any = [Math.cos(lat * Math.PI / 180) * Math.cos(lon * Math.PI / 180), Math.cos(lat * Math.PI / 180) * Math.sin(lon * Math.PI / 180), Math.sin(lat * Math.PI / 180)];
  const loc: any = locateVec(G, v); const f = loc.face ?? loc.f, X0 = Math.floor(loc.X ?? loc.x), Y0 = Math.floor(loc.Y ?? loc.y);
  // scan a 600 cell square round it for coast cells: land (>2 m) beside sea (< -2 m) within 2 cells
  const out: any[] = []; const tiles = new Map<string, any>();
  const H = (X: number, Y: number) => { const tx = X >> 8, ty = Y >> 8, k = f + "," + tx + "," + ty; if (!tiles.has(k)) tiles.set(k, load(f, tx, ty)); const t = tiles.get(k); if (!t) return NaN; return g(t, "height", (Y & 255) * 256 + (X & 255)); };
  for (let Y = Y0 - 300; Y < Y0 + 300; Y += 3) for (let X = X0 - 300; X < X0 + 300; X += 3) { const h = H(X, Y); if (!(h > 1 && h < 25)) continue; if ([H(X + 2, Y), H(X - 2, Y), H(X, Y + 2), H(X, Y - 2)].some((v) => v < -1)) { const q = latLon(pointOf(f, Math.tan((X / fn - 0.5) * (Math.PI / 2)), Math.tan((Y / fn - 0.5) * (Math.PI / 2)))); out.push([+(q.lat * 180 / Math.PI).toFixed(4), +(q.lon * 180 / Math.PI).toFixed(4), h]); } }
  console.log(name, "face", f, "X", X0, "Y", Y0, "coast cells", out.length, JSON.stringify(out.filter((_, i) => i % Math.max(1, Math.floor(out.length / 4)) === 0).slice(0, 5)));
}
