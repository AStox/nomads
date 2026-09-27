// Nomads as a cross-stitch sampler: the island charted square by square onto aida cloth and photographed in its
// hoop. The picture is built in render.js; this page just grows the world and shows the photograph.
import { grow } from "../world.js";
import { COLORS } from "../island.js";
import { render } from "./render.js";

const fail = (e) => { document.body.dataset.error = String((e && e.stack) || e); document.body.classList.add("failed"); };
addEventListener("error", (e) => fail(e.error || e.message));
addEventListener("unhandledrejection", (e) => fail(e.reason));

function main() {
  const q = new URLSearchParams(location.search), view = ["island", "valley", "camp"].includes(q.get("view")) ? q.get("view") : "valley";
  const w = grow(Number(q.get("seed")) || 1);
  const r = render(w, view, COLORS);
  const canvas = document.getElementById("view");
  canvas.width = r.width; canvas.height = r.height;
  canvas.getContext("2d").putImageData(new ImageData(r.data, r.width, r.height), 0, 0);
  console.info("stitch", view, "ms", r.times.join(" "));
}

try { main(); document.body.classList.add("ready"); } catch (e) { fail(e); }
