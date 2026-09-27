// Draws the frame at 427x240 and blows it up 3x with hard pixel edges into the 1280x720 canvas.
import { grow } from "../world.js";
import { COLORS } from "../island.js";
import { render, toRGBA, WIDTH, HEIGHT } from "./render.js";

const fail = (e) => {
  document.body.dataset.error = String(e?.stack || e);
  document.body.classList.add("failed");
};
addEventListener("error", (e) => fail(e.error || e.message));
addEventListener("unhandledrejection", (e) => fail(e.reason));

try {
  const q = new URLSearchParams(location.search);
  const view = ["island", "valley", "camp"].includes(q.get("view")) ? q.get("view") : "valley";
  const seed = Number(q.get("seed")) || 1;
  const frame = render(grow(seed), view, COLORS, seed);
  const low = Object.assign(document.createElement("canvas"), { width: WIDTH, height: HEIGHT });
  low.getContext("2d").putImageData(new ImageData(toRGBA(frame), WIDTH, HEIGHT), 0, 0);
  const canvas = document.getElementById("view"), g = canvas.getContext("2d");
  g.imageSmoothingEnabled = false;
  g.drawImage(low, 0, 0, WIDTH * 3, HEIGHT * 3);
  document.body.classList.add("ready");
} catch (e) {
  fail(e);
}
