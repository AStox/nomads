// Side-by-side pictures of one window at every stage of the new generator (V13r with V14r) and of the old planet (scripts/straight-lib.ts):
//   bun scripts/straight-pictures.ts --name F1 --face 4 --x 6780 --y 5650 --w 420 --h 700 [--cols 3] [--lattice] [--coast] [--vex 3] [--panels new0,newt3,newt4,newt4h,newt5h,old...]
// Sources (T = ~/.cache/nomads-scratch/t4): new0 tier-0 chain, newt3 the tier-3 carry (bake/dbg), newt4 the streamed whole-planet tier 4 (bake/t4full), newt4h / newt5h the harness regions of
// the region (land2 and land), old0 / old3 / old5 the old planet's chain, tier 3 and live tier 5 (~/.cache/nomads-bakes/1-1121d207f3b8), oldt4h / oldt5h the old law's harness regions (old/land).
import { existsSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { chainSource, panel, regionState, sheet, tierFile, type Source, type Win } from "./straight-lib";

const arg = (n: string, d: string) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };
const flag = (n: string) => process.argv.includes(`--${n}`);
const T = `${homedir()}/.cache/nomads-scratch/t4`, OLD = `${T}/old`, OUT = `${T}/out/straight`;
// harness regions: face, tile x, tile y (8 x 8 tiles of 256 tier-5 cells); dirs of the new final-law tier 4 (land2), the new tier 5 (land) and the old law's (old/land)
export const REG: Record<string, { face: number; tx: number; ty: number; new4: string; new5: string; old4: string; old5: string; lim4?: string; lim5?: string }> = {
  home: { face: 4, tx: 23, ty: 21, new4: "land2/h4", new5: "land/home-t5", old4: "old/land/home4", old5: "old/land/home5", lim4: "lim/land/home4", lim5: "lim/land/home5" },
  Rblk: { face: 1, tx: 9, ty: 16, new4: "land2/b4", new5: "land/Rblk-t5", old4: "old/land/Rblk4", old5: "old/land/Rblk5", lim4: "lim/land/Rblk4", lim5: "lim/land/Rblk5" },
  R1: { face: 0, tx: 23, ty: 17, new4: "land2/r1t4", new5: "land/R1-t5", old4: "old/land/R14", old5: "old/land/R15", lim4: "lim/land/R14", lim5: "lim/land/R15" },
  A: { face: 0, tx: 1, ty: 14, new4: "land2/a4", new5: "land/A-t5", old4: "old/land/A4", old5: "old/land/A5", lim4: "lim/land/A4", lim5: "lim/land/A5" },
  oldA: { face: 3, tx: 20, ty: 4, new4: "-", new5: "-", old4: "old/land/oldA4", old5: "old/land/oldA5" },
  oldB: { face: 3, tx: 16, ty: 8, new4: "-", new5: "-", old4: "old/land/oldB4", old5: "old/land/oldB5" },
};
export function sources(region: string): Record<string, Source> {
  const r = REG[region] ?? (JSON.parse(region) as (typeof REG)[string]), s: Record<string, Source> = {};
  s.new0 = chainSource("NEW T0 CHAIN", `${T}/causes/new0/height.f32`);
  s.newt3 = tierFile("NEW T3 CARRY UNLIMITED", `${T}/bake/dbg/1-b82ccfaeb552/t3-height.i32`, 3);
  s.newt4 = tierFile("NEW T4 STREAMED", `${T}/bake/t4full/1-b82ccfaeb552/t4-height.i32`, 4);
  s.lim3 = tierFile("NEW T3 LIMITED CARRY", `${T}/lim/1-b82ccfaeb552/t3-height.i32`, 3);
  s.old0 = chainSource("OLD T0 CHAIN", `${T}/causes/old0/height.f32`);
  s.old3 = tierFile("OLD T3 (T5 4X4 MEANS)", `${OLD}/land/1-7f6ff6c82cdd/t3-height.i32`, 3);
  s.old5 = tierFile("OLD T5 LIVE", `${OLD}/t5-height.i32`, 5);
  const rs = (key: string, label: string, rel: string, tier: number) => { const p = `${T}/${rel}/state.i32`; if (existsSync(p)) s[key] = regionState(label, p, tier, r.face, (r.tx * 256) >> (5 - tier), (r.ty * 256) >> (5 - tier), 2048 >> (5 - tier)); };
  rs("newt4h", "NEW T4 HARNESS UNLIMITED", r.new4, 4); rs("newt5h", "NEW T5 HARNESS UNLIMITED", r.new5, 5); if (r.lim4) rs("limt4h", "NEW T4 HARNESS LIMITED", r.lim4, 4);
  if (r.lim5) rs("limt5h", "NEW T5 HARNESS LIMITED", r.lim5, 5);
  rs("oldt4h", "OLD T4 HARNESS", r.old4, 4); rs("oldt5h", "OLD T5 HARNESS", r.old5, 5);
  return s;
}
if (import.meta.main) {
  const name = arg("name", "view"), region = arg("region", "home"), win: Win = { face: Number(arg("face", "4")), x: Number(arg("x", "6780")), y: Number(arg("y", "5650")), w: Number(arg("w", "420")), h: Number(arg("h", "700")) };
  const src = sources(region), want = arg("panels", "newt5h,newt4h,newt4,newt3,new0").split(",");
  const look = { vex: Number(arg("vex", "3")), lattice: flag("lattice"), coast: flag("coast") };
  const panels = want.filter((k) => src[k]).map((k) => ({ label: src[k].label, rgb: panel(src[k], win, look) }));
  const out = `${arg("out", OUT)}/${name}.png`;
  writeFileSync(out, sheet(panels, win.w, win.h, Number(arg("cols", "3")), `${name} FACE ${win.face} X ${win.x}-${win.x + win.w - 1} Y ${win.y}-${win.y + win.h - 1} 1 PX = 1 T5 CELL (75 M)`));
  console.log(out, panels.length, "panels");
}
