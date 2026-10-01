// Grows an island with the game's own generator, posting each stage as it is made (src/terrain/island.ts Watch).
import { generateIsland, rng } from "../island.js";

onmessage = (e) => {
  const t0 = performance.now();
  generateIsland(rng(e.data.seed), (s) => postMessage(s));
  postMessage({ stage: "done", ms: performance.now() - t0 });
};
