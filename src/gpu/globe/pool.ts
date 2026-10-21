// The coarse tiers' climate and terrain, pooled from the finest tier's: a tile of tier `to` is made from the 2^(from - to) by 2^(from - to) children of each of its cells in the
// stage files of tier `from` (the planet's tier-5 air and terrain pooled to tier 3, where the water's coarse global solve reads them: a single tier-3 tile of the 391 km planet spans too many
// bands of latitude for the island's climate kernels, which stay as they are). CPU, streamed over the mapped finest-tier files (a tile reads its own 1,024 by 1,024 children of each), a tile
// at a time with the progress in `t<to>-pool-done.u8` (written to a part and renamed), so a call stops at its budget and any split gives the same bytes. Exact integer arithmetic, no random draw.
//
// What is pooled (the files `t<to>-<stem>` are the names the coarse water reads), and how:
//   rock.u8, drift.u8       the class the most children hold, the least class code among ties [design: a class has no mean]
//   dd.u16                  the mean of the words, rounded half up (the drift's thickness, 1/1024 m)
//   pe0..3.u16              the mean of the words, rounded half up (0.1 mm: a rounding of at most 0.05 mm)
//   pr0..3.u16              the words are the square root of the mm times 360 (air.ts PR_K): the mean rain is the mean of the squares, so the word is round(sqrt(mean of the words squared)), a rounding of at
//                           most half a word, 1/720 of the square root of the mm (the sum of the squares of 16 words is below 2^36, exact in a double)
import { tierFile, type BakeDir } from "./bakedir";
import { doneFileOf, FieldFile, globalField, KINDS, typeOf, type Field } from "./stages";
import { renameSync } from "node:fs";
import { tileAt } from "./patch";

export type PoolKind = "mean" | "companded" | "mode";
export interface PoolField { file: string; kind: PoolKind }
const seasons = (stem: string, type: string, kind: PoolKind): PoolField[] => [0, 1, 2, 3].map((s) => ({ file: `${stem}${s}.${type}`, kind }));
export const POOL: PoolField[] = [
  { file: "rock.u8", kind: "mode" }, { file: "drift.u8", kind: "mode" }, { file: "dd.u16", kind: "mean" },
  ...seasons("pr", "u16", "companded"), ...seasons("pe", "u16", "mean"),
];

export interface PoolProgress { done: boolean; tiles: number; of: number; seconds: number; tileS: number[] }
// Make the tiles of tier `to` not yet made from tier `from`'s files in `dir`, within `budgetS` seconds (a tile's time is taken as the slowest so far); `only` limits the call to some tiles.
export function poolTier(dir: BakeDir, from: number, to: number, budgetS: number, log: (s: string) => void = () => {}, fields: PoolField[] = POOL, only?: number[]): PoolProgress {
  if (from <= to) throw new Error(`pool: tier ${to} is not coarser than tier ${from}`);
  const t0 = performance.now(), spent = () => (performance.now() - t0) / 1000, B = 2 ** (from - to), BB = B * B, n = 256 << to, N = 256 << from, T = n / 256, of = 6 * T * T, cells = 6 * n * n;
  const marker = doneFileOf(to, "pool"), done = new Uint8Array(of);
  if (dir.has(marker)) done.set(new Uint8Array(dir.raw(marker)).subarray(0, of));
  const missing = fields.map((f) => tierFile(from, f.file)).filter((f) => !dir.has(f));
  if (missing.length) throw new Error(`pool: ${missing.join(", ")} not in ${dir.dir} (the terrain and air stages of tier ${from} come first)`);
  const src: Field[] = fields.map((f) => globalField({ dir }, tierFile(from, f.file)));
  const outs = fields.map((f) => new FieldFile(dir.path(tierFile(to, f.file)), typeOf(f.file), cells));
  const tileS: number[] = [], vals = new Float64Array(BB);
  let worst = 0;
  try {
    for (const k of only ?? Array.from({ length: of }, (_, i) => i)) {
      if (done[k]) continue;
      if (spent() + worst * 1.3 > budgetS) break;
      const s0 = performance.now(), { face, tx, ty } = tileAt(to, k);
      fields.forEach((f, m) => {
        const K = KINDS[typeOf(f.file)], tile = new K(256 * 256), s = src[m];
        for (let y = 0; y < 256; y++) {
          for (let x = 0; x < 256; x++) {
            let at = (face * N + (ty * 256 + y) * B) * N + (tx * 256 + x) * B, c = 0;
            for (let j = 0; j < B; j++, at += N) for (let i = 0; i < B; i++) vals[c++] = s[at + i];
            let r: number;
            if (f.kind === "mode") {
              let best = -1, bestN = 0;
              for (let a = 0; a < BB; a++) {
                let cnt = 0;
                for (let b = 0; b < BB; b++) if (vals[b] === vals[a]) cnt++;
                if (cnt > bestN || (cnt === bestN && vals[a] < best)) { bestN = cnt; best = vals[a]; }
              }
              r = best;
            } else {
              let sum = 0;
              if (f.kind === "mean") { for (let b = 0; b < BB; b++) sum += vals[b]; r = Math.floor((sum + (BB >> 1)) / BB); }
              else { for (let b = 0; b < BB; b++) sum += vals[b] * vals[b]; r = Math.round(Math.sqrt(sum / BB)); }
            }
            tile[y * 256 + x] = r;
          }
          outs[m].writeRow((face * n + ty * 256 + y) * n + tx * 256, tile.subarray(y * 256, y * 256 + 256) as Field);
        }
      });
      done[k] = 1;
      dir.write(`${marker}.part`, done);
      renameSync(dir.path(`${marker}.part`), dir.path(marker));
      const dt = (performance.now() - s0) / 1000;
      tileS.push(dt); worst = Math.max(worst, dt);
      log(`pool tier ${from} to ${to}: tile ${k} (face ${face}, ${tx}, ${ty}) ${dt.toFixed(1)} s`);
    }
  } finally { for (const o of outs) o.close(); }
  const total = done.reduce((a, b) => a + b, 0);
  return { done: only ? only.every((k) => done[k]) : total === of, tiles: total, of, seconds: spent(), tileS };
}
