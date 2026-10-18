// Grows an island with the game's own generator, posting each stage as it is made (src/terrain/island.ts Watch).
import { generateIsland, rng, theGpu } from "../island.js";

onmessage = async (e) => {
  const t0 = performance.now();
  await generateIsland(rng(e.data.seed), await theGpu(), (s) => postMessage(s));
  postMessage({ stage: "done", ms: performance.now() - t0 });
};
