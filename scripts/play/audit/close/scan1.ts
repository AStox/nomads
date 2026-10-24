import { readFileSync, existsSync } from "fs"; import { gunzipSync } from "zlib";
import { pointOf, latLon } from "/Users/adamstockermans/Developer/nomads/src/gpu/globe/grid";
const dir = process.env.HOME + "/.cache/nomads-play/planets/link-1-7f6ff6c82cdd/pyramid", T = 3, n = 1 << T, fn = 256 * n;
const coast: any[] = [], lake: any[] = [], mount: any[] = [], edgeLand: any[] = [], forest: any[] = [];
for (let f = 0; f < 6; f++) for (let ty = 0; ty < n; ty++) for (let tx = 0; tx < n; tx++) {
  const p = `${dir}/t${T}/f${f}/${ty}-${tx}.tile.gz`; if (!existsSync(p)) continue;
  const raw = gunzipSync(readFileSync(p)), hl = raw.readUInt32LE(0), meta = JSON.parse(raw.subarray(4, 4 + hl).toString()); let at = 4 + hl; const pl: any = {};
  for (const fld of meta.fields) { const sz = { i8: 1, u8: 1, i16: 2, u16: 2, i32: 4, u32: 4, f32: 4 }[fld.type as string]!; const b = raw.subarray(at, at + 65536 * sz); pl[fld.name] = { b, t: fld.type }; at += 65536 * sz; }
  const g = (name: string, i: number) => { const { b, t } = pl[name]; return t === "i16" ? b.readInt16LE(i * 2) * 0.25 : t === "u8" ? b[i] : t === "u16" ? b.readUInt16LE(i * 2) : 0; };
  const ll = (X: number, Y: number) => { const q = latLon(pointOf(f, Math.tan(((tx * 256 + X) / fn - 0.5) * (Math.PI / 2)), Math.tan(((ty * 256 + Y) / fn - 0.5) * (Math.PI / 2)))); return [+(q.lat * 180 / Math.PI).toFixed(3), +(q.lon * 180 / Math.PI).toFixed(3)]; };
  for (let Y = 8; Y < 248; Y += 8) for (let X = 8; X < 248; X += 8) {
    const i = Y * 256 + X, h = g("height", i), w = g("water", i);
    const hn = [g("height", i + 6), g("height", i - 6), g("height", i + 6 * 256), g("height", i - 6 * 256)];
    if (h > 3 && h < 60 && hn.some((v) => v < -3)) coast.push({ f, tx, ty, X, Y, ll: ll(X, Y), h });
    if (h > 8 && w >= 2) lake.push({ f, tx, ty, X, Y, ll: ll(X, Y), h, w });
    if (h > 1500) mount.push({ f, ll: ll(X, Y), h });
    const e = Math.min(tx * 256 + X, fn - 1 - (tx * 256 + X), ty * 256 + Y, fn - 1 - (ty * 256 + Y));
    if (e < 60 && h > 20) edgeLand.push({ f, ll: ll(X, Y), h, e, tree: g("tree", i) });
  }
}
const pick = (a: any[], k = 6) => a.filter((_, i) => i % Math.max(1, Math.floor(a.length / k)) === 0).slice(0, k);
console.log("coast", coast.length, JSON.stringify(pick(coast, 8).map((o) => [o.f, ...o.ll, o.h])));
console.log("lake", lake.length, JSON.stringify(pick(lake, 8).map((o) => [o.f, ...o.ll, o.h, o.w])));
console.log("mount", mount.length, JSON.stringify(pick(mount, 8).map((o) => [o.f, ...o.ll, o.h])));
console.log("edgeLand", edgeLand.length, JSON.stringify(pick(edgeLand, 10).map((o) => [o.f, ...o.ll, o.h, o.e, o.tree])));
