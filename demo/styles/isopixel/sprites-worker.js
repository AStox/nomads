// Makes sprites for the atlas off the render worker: a list of [family key, size index] in, each sprite's pixels out.
import * as SP from "./sprites.js";
import { makeSprite, flat } from "./atlas.js";

const TH = await import("./things.js").catch((e) => (console.warn(`things.js not loaded: ${e.message}`), {}));
onmessage = (e) => {
  const { id, jobs } = e.data, out = [], moved = [];
  for (const [key, idx, slot] of jobs) {
    const s = flat(makeSprite(key, idx, SP, TH));
    out.push([slot, s]);
    if (s) moved.push(s.p.buffer);
  }
  postMessage({ id, out }, moved);
};
postMessage({ ready: true });
