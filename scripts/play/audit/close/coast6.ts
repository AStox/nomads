import { readFileSync, existsSync } from "fs"; import { gunzipSync } from "zlib";
import { locateVec, makeGrid } from "/Users/adamstockermans/Developer/nomads/src/gpu/globe/grid";
const dir = process.env.HOME + "/.cache/nomads-play/planets/link-1-7f6ff6c82cdd/pyramid", T = 5, fn = 256 * (1 << T), G = makeGrid(fn);
const tiles = new Map<string, any>();
const load = (f: number, tx: number, ty: number) => { const k = `${f},${tx},${ty}`; if (tiles.has(k)) return tiles.get(k); const p = `${dir}/t${T}/f${f}/${ty}-${tx}.tile.gz`; let r: any = null; if (existsSync(p)) { const raw = gunzipSync(readFileSync(p)), hl = raw.readUInt32LE(0), meta = JSON.parse(raw.subarray(4, 4 + hl).toString()); let at = 4 + hl; const pl: any = {}; for (const fld of meta.fields) { const sz = { i8: 1, u8: 1, i16: 2, u16: 2, i32: 4, u32: 4, f32: 4 }[fld.type as string]!; pl[fld.name] = { b: raw.subarray(at, at + 65536 * sz), t: fld.type }; at += 65536 * sz; } r = pl; } tiles.set(k, r); return r; };
const hAt = (lat: number, lon: number) => { const v: any = [Math.cos(lat * Math.PI / 180) * Math.cos(lon * Math.PI / 180), Math.cos(lat * Math.PI / 180) * Math.sin(lon * Math.PI / 180), Math.sin(lat * Math.PI / 180)]; const l: any = locateVec(G, v); const f = l.face ?? l.f, X = Math.floor(l.X ?? l.x), Y = Math.floor(l.Y ?? l.y); const t = load(f, X >> 8, Y >> 8); if (!t) return NaN; return t.height.b.readInt16LE(((Y & 255) * 256 + (X & 255)) * 2) * 0.25; };
const [lat0, lon0, lon1] = process.argv.slice(2).map(Number);
let prev = NaN, out: string[] = [];
for (let lon = lon0; lon <= lon1; lon += 0.0015) { const h = hAt(lat0, lon); if (!isNaN(prev) && (prev > 0) !== (h > 0)) out.push(`lon ${lon.toFixed(4)} ${prev.toFixed(1)} -> ${h.toFixed(1)}`); prev = h; }
console.log(out.join("\n"));
