// Applies the stochastic-claim patch (STOCH_CLAIM) to the kernels in place; revert with `git checkout src`. Edits are exact string swaps and fail loudly.
import { readFileSync, writeFileSync } from "node:fs";
const swap = (path: string, from: string, to: string) => { const s = readFileSync(path, "utf8"); if (s.split(from).length !== 2) throw new Error(`${path}: ${JSON.stringify(from.slice(0, 50))} matches ${s.split(from).length - 1} times`); writeFileSync(path, s.replace(from, () => to)); };
const W = "src/gpu/wgsl/globe-tectonics.ts", T = "src/gpu/globe/tectonics.ts";
swap(W, "export const ACCF = { COV: 0, KR: 1, KC: 2, COVW: 3, W: 4, L: 11, COUNT: 18 } as const;", "export const ACCF = { COV: 0, KR: 1, KC: 2, COVW: 3, W: 4, L: 11, PC: 18, COUNT: 28 } as const;");
swap(W, "const ACC_COUNT = ${ACCF.COUNT}u;", "const ACC_COUNT = ${ACCF.COUNT}u; const ACC_PC = ${ACCF.PC}u;");
swap(W, "    atomicAdd(&A[wordOf(ACC_COV, d)], cv);\n", "    atomicAdd(&A[wordOf(ACC_COV, d)], cv);\n    atomicAdd(&A[wordOf(ACC_PC + p, d)], cv);\n");
swap(W, `fn winnerOf(d: Src, ad: u32, cov: u32) -> u32 {
  let over = cov * 16u > ad * \${PHYS.OVER_NUM}u;
  let key = select(atomicLoad(&A[wordOf(ACC_KC, d)]), atomicLoad(&A[wordOf(ACC_KR, d)]), over);
  return select(NONE, key & 255u, key != 0u);
}`, `fn winnerOf(d: Src, ad: u32, cov: u32) -> u32 {
  let over = cov * 16u > ad * \${PHYS.OVER_NUM}u;
  let key = select(atomicLoad(&A[wordOf(ACC_KC, d)]), atomicLoad(&A[wordOf(ACC_KR, d)]), over);
  if (over || key == 0u || cov == 0u) { return select(NONE, key & 255u, key != 0u); }
  // Not an overlap: the cell goes to a plate with the probability of that plate's coverage of it (the draw keyed by the cell and the step), so that a boundary moves by the mean of the sub-cell displacement.
  var h = (d.face * FN * FN + d.y * FN + d.x) * 2654435761u + P[21] * 40503u + 12345u;
  h = (h ^ (h >> 15u)) * 2246822519u; h = (h ^ (h >> 13u)) * 3266489917u; h = h ^ (h >> 16u);
  var r = h % cov;
  for (var q = 0u; q < NP; q++) {
    let cq = atomicLoad(&A[wordOf(ACC_PC + q, d)]);
    if (r < cq) { return q; }
    r = r - cq;
  }
  return key & 255u;
}`);
swap(T, `    this.rec("claim", { 22: regionalField(sw.regional) }, n);
    this.rec("deposit", {}, n);
    this.rec("resolve", {}, n);`, `    this.rec("claim", { 22: regionalField(sw.regional), 21: this.stepNo }, n);
    this.rec("deposit", { 21: this.stepNo }, n);
    this.rec("resolve", { 21: this.stepNo }, n);`);
console.log("applied");
