import { luma, box, sub, ncc } from "./img.ts";
const cases: [string, number, number][] = [["mo-A-z-4.5-1600x1000", -35, 11], ["mo-A-z-3-1600x1000", -39, -5], ["mo-A-z0-1600x1000", -60, 0], ["mo-C-z-1-1600x1000", 50, -29]];
for (const [tag, dx, dy] of cases) {
  const A = await luma(`${tag}-A.png`), B = await luma(`${tag}-B.png`); const hpA = sub(A, box(A, 3)), hpB = sub(B, box(B, 3));
  const reg: [number, number, number, number] = [150, 150, 1450, 800];
  // sea only: blue-dominant pixels of A
  console.log(tag, "whole frame hp corr at zero", ncc(hpA, hpB, reg, 0, 0).toFixed(3), "at ground shift", ncc(hpA, hpB, reg, dx, dy).toFixed(3));
}
