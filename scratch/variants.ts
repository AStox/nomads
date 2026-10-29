// Variants table of raw chain dumps. Per dump: RAW_DIR=<dir> bun scratch/variants.ts (after coasttab.ts has run on it) writes vstats.json there.
// Then TABLE=1 bun scratch/variants.ts prints the comparison of the baseline, raw-sea0 and raw-sea01 dumps.
import { readFileSync, writeFileSync } from "node:fs";
import { raw, DIR } from "./labload";
import { FLD, neighbours } from "../src/gpu/globe/tectonics";
import { cellId, FACES, wordAt } from "../src/gpu/globe/grid";

const ROOT = "/Users/adamstockermans/.cache/nomads-scratch/t7/", BASE = ROOT + "raw/", NAMES = ["baseline", "sea0", "sea01"], DIRS = [BASE, ROOT + "raw-sea0/", ROOT + "raw-sea01/"];
const q = (a: number[], p: number) => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
if (!process.env.TABLE) {
  const r = raw(), N = r.n, nb = neighbours(r.grid), k = r.meta.kmPerUnit as number, g = r.grid, fw = r.meta.fw as number;
  const bb = readFileSync(BASE + "height.f32"), bh = new Float32Array(bb.buffer.slice(bb.byteOffset, bb.byteOffset + bb.byteLength));
  const land = new Uint8Array(N); let nl = 0, both = 0, either = 0, hmax = -Infinity, hsum = 0;
  for (let i = 0; i < N; i++) { const l = r.height[i] > 0; if (l) { land[i] = 1; nl++; hsum += r.height[i]; hmax = Math.max(hmax, r.height[i]); } const bl = bh[i] > 0; if (l && bl) both++; if (l || bl) either++; }
  const dist = new Int16Array(N).fill(-1), qu: number[] = [];
  for (let i = 0; i < N; i++) if (land[i]) { dist[i] = 0; qu.push(i); }
  for (let h = 0; h < qu.length; h++) { const c = qu[h]; if (dist[c] >= 10) continue; for (let d = 0; d < 4; d++) { const j = nb[4 * c + d]; if (dist[j] < 0) { dist[j] = dist[c] + 1; qu.push(j); } } }
  let sedAll = 0, sedNear = 0;
  for (let f = 0; f < FACES; f++) for (let Y = 0; Y < g.fn; Y++) for (let X = 0; X < g.fn; X++) {
    const i = cellId(g, f, X, Y); if (land[i]) continue;
    const v = (r.S[(FLD.VB + 1) * fw + wordAt(g, f, X, Y)] >>> 0) * k; sedAll += v; if (dist[i] >= 1 && dist[i] <= 10) sedNear += v;
  }
  const sedQ = [1, 3, 10].map((d) => { const a: number[] = []; for (let i = 0; i < N; i++) if (dist[i] === d) a.push(r.sediment[i]); return [0.25, 0.5, 0.75].map((p) => q(a, p)); });
  const L = r.meta.ledger, km = (x: string) => Number(x) * k;
  writeFileSync(DIR + "vstats.json", JSON.stringify({ landShare: nl / N, both, either, sedAll, sedNear, sedQ, hmax, hmean: hsum / nl, removed: km(L.removed), deposited: km(L.deposited), dissolved: km(L.dissolved), carry: km(r.meta.carry) }));
  console.log("wrote " + DIR + "vstats.json");
} else {
  const V = DIRS.map((d) => ({ ...JSON.parse(readFileSync(d + "vstats.json", "utf8")), ...JSON.parse(readFileSync(d + "coaststats.json", "utf8")) }));
  const f = (x: number, n = 0) => x.toFixed(n), row = (label: string, fn: (v: any) => string) => console.log(label.padEnd(44) + V.map((v) => fn(v).padStart(26)).join(""));
  console.log("".padEnd(44) + NAMES.map((n) => n.padStart(26)).join(""));
  row("land share (cells)", (v) => f(v.landShare, 4));
  row("land overlap with baseline both/either", (v) => `${v.both}/${v.either}=${f(v.both / v.either, 3)}`);
  row("coast length km", (v) => f(v.coastKm));
  row("coast land cells", (v) => String(v.coastCells));
  ["<1", "<10", "<30", "<100", "<300", "<1000"].forEach((t, i) => row(`% coast cells, deepest sea nbr ${t} m`, (v) => f(v.cum[i], 1)));
  for (const c of ["PASSIVE", "ACTIVE"]) [1, 3, 6, 12].forEach((t, i) => row(`${c} median depth m at ${t} cells (n)`, (v) => `${f(v[c].med[i][0])} (${v[c].med[i][1]})`));
  row("sea sediment km3, all sea cells", (v) => f(v.sedAll));
  row("sea sediment km3, within 10 cells of land", (v) => f(v.sedNear));
  row("ledger removed km3", (v) => f(v.removed)); row("ledger deposited km3", (v) => f(v.deposited)); row("ledger dissolved km3", (v) => f(v.dissolved)); row("carry km3", (v) => f(v.carry));
  row("land height max m", (v) => f(v.hmax)); row("land height mean m", (v) => f(v.hmean));
  [1, 3, 10].forEach((d, i) => row(`sea sediment m q25/q50/q75 at ${d} cells`, (v) => v.sedQ[i].map((x: number) => f(x, 1)).join("/")));
  [50, 100, 200].forEach((t, i) => row(`PASSIVE shelf width cells >${t} m q25/50/75 (n,open,blk)`, (v) => `${v.PASSIVE.widths[i].q.join("/")} (${v.PASSIVE.widths[i].n},${v.PASSIVE.widths[i].open},${v.PASSIVE.widths[i].blocked})`));
}
