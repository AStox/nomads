// Look-dev viewer: the island in one look, from one of the stage's views, drawn as a still and redrawn when the camera
// moves. ?look=real|story|board&view=island|valley|camp&time=day|evening&seed=1, plus &lite for software renderers.
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { makeStage } from "./stage.js";

const q = new URLSearchParams(location.search);
const LOOKS = ["real", "story", "board"];
const name = LOOKS.includes(q.get("look")) ? q.get("look") : "real", viewName = ["island", "valley", "camp"].includes(q.get("view")) ? q.get("view") : "valley";
const evening = q.get("time") === "evening", seed = Math.max(1, Number(q.get("seed")) || 1);
document.body.classList.toggle("clean", q.has("clean"));
document.querySelectorAll("[data-look]").forEach((a) => a.classList.toggle("on", a.dataset.look === name));
document.querySelectorAll("[data-view]").forEach((a) => a.classList.toggle("on", a.dataset.view === viewName));
document.querySelectorAll("[data-time]").forEach((a) => a.classList.toggle("on", a.dataset.time === (evening ? "evening" : "day")));
document.querySelectorAll("a[data-look], a[data-view], a[data-time]").forEach((a) => {
  const next = new URLSearchParams(q);
  for (const key of ["look", "view", "time"]) if (a.dataset[key]) next.set(key, a.dataset[key]);
  a.href = `?${next}`;
});

// Let the loading note paint before the generator takes the thread.
await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 30)));
const stage = makeStage(seed, q.has("lite") ? { shadow: 2048, samples: 2 } : {});
document.body.prepend(stage.renderer.domElement);
const view = stage.views[viewName];
stage.resize(innerWidth, innerHeight);
stage.aim(view);
const look = await import(`./${name}.js`);
const { sunDir } = await look.dress(stage, { evening, view: viewName });
const controls = new OrbitControls(stage.camera, stage.renderer.domElement);
controls.target.copy(view.target);
controls.update();
function draw() {
  stage.frame({ ...view, eye: stage.camera.position.clone(), target: controls.target.clone() }, sunDir);
  stage.render();
}
let queued = false;
const redraw = () => { if (!queued) { queued = true; requestAnimationFrame(() => { queued = false; draw(); }); } };
controls.addEventListener("change", redraw);
addEventListener("resize", () => { stage.resize(innerWidth, innerHeight); redraw(); });
draw();
document.querySelector("#loading").hidden = true;
document.body.classList.add("ready");
