// The live page: the game's sim running in the render worker beside the isopixel renderer (play/remote.js), drawn with a
// pan, zoom and orbit camera; this thread keeps the camera, the input and the windows.
import { createLive, hasWebGPU, loadingScreen } from "../isopixel/live.js";
import { PACE, connectSim } from "./remote.js";
import { drawInspector, drawPanel } from "../isopixel/inspect.js";
import { RGB, P } from "../isopixel/pal.js";
import { Buf } from "../isopixel/px.js";
import { text } from "../isopixel/ui.js";
import { createCamera, norm8 } from "./camera.js";
import { SIZE, TILE_M } from "../island.js";

const Q = new URLSearchParams(location.search);
// every URL parameter is checked, so a bad one falls back to its default instead of stopping the page
const num = (k, def, lo = -Infinity, hi = Infinity) => {
  const s = Q.get(k), v = s == null || s.trim() === "" ? NaN : Number(s);
  return Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : def;
};
// ?warm: sim days the world runs before it is live [design: one, a day and a night, so everyone has woken, worked and
// slept once and every daily law has run once before the world is live; the week it was before ticks were seconds took
// about 9 minutes on the dev machine (real-time tick plan, Unit 11 outcome); at most 140 days, about the 40,000 ticks of
// 300 s it has always been held to]
const seed = Math.trunc(num("seed", 1)), warm = num("warm", 1, 0, 140), withSim = Q.get("sim") === "1"; // the world alone by default (plan: the operator's scope, 2026-10-23); ?sim=1 runs the game on it
// ?planet=0: the island the generator made instead of the seed's planet (for the renderer's own checks, which stand on it)
const planet = Q.get("planet") !== "0";
// ?bench=zoom, or several in turn on one load (?bench=zoom,orbit,turn,pan), each from the view the first began at
const benchKinds = (Q.get("bench") ?? "").split(",").filter((k) => ["zoom", "orbit", "turn", "pan"].includes(k));
const canvas = document.getElementById("view"), hint = document.getElementById("hint"), statsEl = document.getElementById("stats"), pace = document.getElementById("pace"), renderEl = document.getElementById("render"), clockEl = document.getElementById("clock");
// a touch screen: buttons stand in for the keys, and the hint speaks of fingers (?pad=1 or 0 to choose)
const pad = document.getElementById("pad"), touchy = Q.get("pad") === "1" || (Q.get("pad") !== "0" && matchMedia("(pointer: coarse)").matches);
if (touchy) hint.textContent = "drag to pan · pinch to zoom · twist two fingers to turn · tap anyone or anything to inspect it, people and animals to follow · tap it again to let go · the tabs at the top list everyone and everything";
// the speeds the page steps through, in sim seconds a wall second: a quarter of the usual pace to eight times it
const SPEEDS = [0.25, 0.5, 1, 2, 4, 8].map((k) => k * PACE), DBL_MS = 300;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const toM = (t) => t * TILE_M - SIZE / 2;

const fail = (e) => { document.body.dataset.error = String((e && e.stack) || e); document.body.classList.add("failed"); loadingScreen(canvas, `failed: ${e?.message ?? e}`.slice(0, 90), 0); };
window.addEventListener("error", (e) => fail(e.error || e.message));
window.addEventListener("unhandledrejection", (e) => fail(e.reason));

function fit() { canvas.width = window.innerWidth; canvas.height = window.innerHeight; }
fit();
window.addEventListener("resize", fit);

// an indexed art buffer onto a small canvas, shown at twice its size like the rest of the art
function paintBuf(cv, B) {
  if (cv.width !== B.w || cv.height !== B.h) { cv.width = B.w; cv.height = B.h; cv.style.width = `${B.w * 2}px`; cv.style.height = `${B.h * 2}px`; }
  const img = new ImageData(B.w, B.h), o = new Uint32Array(img.data.buffer);
  for (let p = 0; p < B.c.length; p++) { const c = RGB[B.c[p]]; o[p] = 0xff000000 | (c[2] << 16) | (c[1] << 8) | c[0]; }
  cv.getContext("2d").putImageData(img, 0, 0);
}

async function main() {
  const t0 = performance.now();
  // one line of progress in the game's own font until the opening view is complete (the world warms after it)
  let step = ["growing the island", 0];
  const say = () => loadingScreen(canvas, step[0], step[1]);
  say();
  // the renderer's worker grows the island, then warms the world on the same GPU
  // ?jev=<token> lets the people think with Jev through this server's relay, and is remembered on this browser;
  // ?jev=off forgets it
  const jevQ = Q.get("jev");
  if (jevQ === "off") localStorage.removeItem("nomads-jev"); else if (jevQ) localStorage.setItem("nomads-jev", jevQ);
  const jev = jevQ === "off" ? null : localStorage.getItem("nomads-jev");
  // the token is kept, not shown: a copied link doesn't carry it
  if (jevQ) { Q.delete("jev"); history.replaceState(null, "", `${location.pathname}${Q.size ? `?${Q}` : ""}`); }
  const live = await createLive({ seed, canvas, planet, sim: withSim ? { warm, jev } : null, onProgress: (d, n, what) => { step = [what, 0.5 * (what === "drawing the sprites" ? 1 : 0) + (0.5 * d) / n]; say(); } });
  const sim = withSim ? await connectSim(live) : null;
  // ?hour= pins the hour the island is drawn at, its light and sun, while the sim runs on; ?speed= starts it faster, in
  // sim seconds a wall second (600 the usual pace, 19200 runs a day in about four and a half seconds), for timelapses
  if (sim) { sim.hour = num("hour", null, 0, 24); sim.speed = num("speed", PACE, PACE / 4, 32 * PACE); } else live.setClock({ hour: num("hour", 13, 0, 24) });
  // with no sim the hint names only what works: the camera's controls and the hour, which sets the light and nothing else
  if (!sim) hint.textContent = touchy ? "drag to pan \u00b7 pinch to zoom, out to the whole planet \u00b7 twist two fingers to turn \u00b7 the slider sets the hour (the light only)" : "drag to pan \u00b7 scroll or double-click to zoom, out to the whole planet \u00b7 Q/E or right-drag to turn \u00b7 [ and ] or the slider set the hour (the light only)";
  const ready = performance.now() - t0;
  // ?zoom= takes a name, the old 0..3 index, or a number of zoom steps; ?bearing= one of the 8 whole bearings
  const zq = Q.get("zoom"), names = ["island", "region", "valley", "close"];
  const zoom0 = zq == null ? live.named.close : Object.hasOwn(live.named, zq) ? live.named[zq] : /^[0-3]$/.test(zq) ? live.named[names[+zq]] : num("zoom", live.named.close, 0, live.zmax);
  const view = { x: -2738, z: -1838, zoom: zoom0, bearing: norm8(Math.round(num("bearing", 0))), up: 0, selected: null, turnTo: null };
  const metrics = { readyMs: Math.round(ready), revealMs: 0, tabs: [], turns: [] };
  const camera = createCamera({ live, view, canvas, onTurn: (t) => metrics.turns.push({ startMs: Math.round(t.start), totalMs: Math.round(t.total) }) });
  // away from the island the ground is the planet's and has no people on it: what was selected or followed is let go (a gesture holds a planet place, which a new window names as well as the old)
  live.onGround((m) => { camera.regrab(); if (m === "win") select(null); });
  let follow = null, openingPerson = null, opening = null, farSince = 0, farDest = null;
  // Open on the person nearest the densest cluster of shelters, fires and stumps, and follow them; with nothing built
  // yet, on whoever has the most going on around them.
  if (sim?.opening) {
    const person = sim.opening;
    opening = view.zoom < 1 ? { kind: "ground", px: 32, py: 32 } : { kind: "ground", px: person.px, py: person.py };
    camera.lookAt(live.where(opening, sim, view));
    openingPerson = person.id;
  }
  let tabWatch = null;
  // anything can be selected: a person, animal or thing by id, or a point of ground; people and animals are followed.
  // how: "link" (from a window: remember where we were for the back button, and bring it into view), "keep" (Tab: the
  // same tab of the inspector, to compare), else a fresh look
  const movers = (id) => !!sim && (sim.w.agents.some((a) => a.id === id) || sim.w.animals.some((a) => a.id === id));
  const select = (sel, watch = true, how = null) => {
    if (how === "link" && view.selected != null && view.selected !== sel) back.push(view.selected);
    else if (how !== "link" && how !== "back") back.length = 0;
    view.selected = sel; farSince = 0;
    // the worker answers for the selection from now on (play/remote.js want); a thing gone by then is let go
    sim?.want({ sel });
    follow = typeof sel === "string" && (movers(sel) || ((how === "link" || how === "back") && sel.startsWith("t"))) ? sel : null;
    if (watch && follow) tabWatch = { t0: performance.now(), hole: 0, cutAt: 0, last: performance.now() };
    if (how !== "keep") ui.tab = null;
    ui.open.clear(); ui.scroll = 0;
    inspect();
  };

  // ---------- inspector: the selection's real data in tabs, redrawn every tick; rows open, names go to whoever they
  // name, and a back button returns along the way that came ----------
  // On a phone or a narrow window the windows take the width less a margin, the inspector a bottom sheet under half the
  // height, and buttons stand in for the keys (index.html body.narrow, #pad).
  const insp = document.getElementById("inspector"), back = [], narrow = () => window.innerWidth < 640;
  let IW = 212, IH = 300;
  const fitInsp = () => {
    document.body.classList.toggle("narrow", narrow());
    IW = narrow() ? clamp(Math.floor((window.innerWidth - 16) / 2), 150, 212) : clamp(Math.floor((window.innerWidth - 36) / 4), 150, 212);
    IH = narrow() ? clamp(Math.floor((window.innerHeight * 0.42) / 2), 120, 320) : clamp(Math.floor((window.innerHeight - 24) / 2), 160, 320);
  };
  fitInsp();
  // the buttons sit at the bottom, above the inspector when it is a bottom sheet
  function placePad() {
    if (pad.hidden) return;
    const up = narrow() && !insp.hidden ? insp.getBoundingClientRect().height + 12 : 8;
    pad.style.bottom = `calc(${Math.round(up)}px + env(safe-area-inset-bottom))`;
  }
  const CB = { y: 4, s: 9 }, cbx = () => IW - 15, BK = { x: 5, y: 4, s: 9 };
  const ui = { tab: null, open: new Set(), scroll: 0, max: 0, hover: null, hits: [] };
  // a link followed, until the worker says whether what it names is still there
  let inspData = null, linkTo = null;
  function inspect() {
    const sel = view.selected;
    if (!sel || !sim) { inspData = null; insp.hidden = true; placePad(); return; }
    const d = typeof sel === "object" ? sim.inspectGround(sel.px, sel.py) : sim.inspect(sel);
    // undefined while the worker is asked: the window keeps what it showed until the answer comes
    if (d === undefined) return;
    inspData = d;
    if (!d) {
      // a link to one gone leads back where it came from
      if (sel === linkTo && back.length) { linkTo = null; select(back.pop(), true, "back"); return; }
      view.selected = null; follow = null; insp.hidden = true; placePad();
      return;
    }
    if (sel === linkTo) linkTo = null;
    paintInspector();
  }
  // a raised square button in a title bar with a glyph drawn by fn(put, x, y)
  function button(B, x, y, s, fn) {
    const put = (i, j, c) => { B.c[j * B.w + i] = c; };
    for (let j = y; j < y + s; j++) for (let i = x - 1; i < x + s; i++) put(i, j, P.w2);
    for (let k = 0; k < s; k++) { put(x + k, y, P.w4); put(x, y + k, P.w4); put(x + k, y + s - 1, P.ink); put(x + s - 1, y + k, P.ink); }
    fn(put, x, y);
  }
  const cross = (put, x, y) => { for (let k = 0; k < 5; k++) { put(x + 2 + k, y + 2 + k, P.snow); put(x + 6 - k, y + 2 + k, P.snow); } };
  function paintInspector() {
    const B = drawInspector(inspData, { w: IW, h: IH, tab: ui.tab, open: ui.open, scroll: ui.scroll, hover: ui.hover, back: back.length > 0 });
    ui.tab = B.tab; ui.scroll = B.scroll; ui.max = B.scrollMax; ui.hits = B.hits;
    button(B, cbx(), CB.y, CB.s, cross);
    if (back.length) button(B, BK.x, BK.y, BK.s, (put, x, y) => { for (let k = 0; k < 4; k++) { put(x + 2 + k, y + 4 - k, P.snow); put(x + 2 + k, y + 4 + k, P.snow); } });
    paintBuf(insp, B);
    insp.hidden = false;
    placePad();
  }
  // a pointer event on one of the art windows, in its art px
  const artAt = (cv, e) => { const r = cv.getBoundingClientRect(); return { x: ((e.clientX - r.left) / r.width) * cv.width, y: ((e.clientY - r.top) / r.height) * cv.height }; };
  const onBox = (p, x, y, s) => p.x >= x - 1 && p.x <= x + s && p.y >= y - 1 && p.y <= y + s;
  const hitAt = (hits, p) => hits.find((h) => p.x >= h.x0 && p.x <= h.x1 && p.y >= h.y0 && p.y <= h.y1) ?? null;
  // go to what a window names: a person, an animal or a thing
  const go = (id) => { if (!sim) return; linkTo = id; select(id, true, "link"); };
  // A window scrolls by the wheel or by dragging a finger (or the mouse) up and down it; a press that hardly moves is a
  // tap, acted on as it lifts.
  function scrollable(cv, get, set, tap) {
    let press = null;
    cv.addEventListener("wheel", (e) => { e.preventDefault(); set(get() + e.deltaY / 2); }, { passive: false });
    cv.addEventListener("pointerdown", (e) => { e.preventDefault(); cv.setPointerCapture(e.pointerId); press = { id: e.pointerId, y: e.clientY, from: get(), moved: false }; });
    cv.addEventListener("pointermove", (e) => {
      if (!press || press.id !== e.pointerId) return;
      const dy = e.clientY - press.y;
      if (Math.abs(dy) > 6) press.moved = true;
      if (press.moved) set(press.from - (dy * cv.height) / cv.getBoundingClientRect().height);
    });
    const lift = (e) => { if (press && press.id === e.pointerId && !press.moved && e.type === "pointerup") tap(artAt(cv, e)); press = null; };
    cv.addEventListener("pointerup", lift);
    cv.addEventListener("pointercancel", lift);
  }
  scrollable(insp, () => ui.scroll, (v) => { ui.scroll = clamp(v, 0, ui.max); if (inspData) paintInspector(); }, (p) => {
    if (onBox(p, cbx(), CB.y, CB.s)) { select(null); return; }
    if (back.length && onBox(p, BK.x, BK.y, BK.s)) { select(back.pop(), true, "back"); return; }
    const h = hitAt(ui.hits, p);
    if (!h) return;
    if (h.tab != null) { ui.tab = h.tab; ui.scroll = 0; }
    else if (h.toggle) { if (ui.open.has(h.toggle)) ui.open.delete(h.toggle); else ui.open.add(h.toggle); }
    else if (h.link) { go(h.link); return; }
    paintInspector();
  });
  insp.addEventListener("pointermove", (e) => {
    if (e.pointerType !== "mouse") return;
    const p = artAt(insp, e), was = hitAt(ui.hits, ui.hover ?? { x: -1, y: -1 }), now = hitAt(ui.hits, p);
    ui.hover = p;
    insp.style.cursor = now || onBox(p, cbx(), CB.y, CB.s) || (back.length && onBox(p, BK.x, BK.y, BK.s)) ? "pointer" : "";
    if (was !== now && inspData) paintInspector();
  });
  insp.addEventListener("pointerleave", () => { ui.hover = null; if (inspData) paintInspector(); });

  // ---------- the world window: everyone and everything, by kind, to click and go to; population over time; the key
  // to the markers. Closed it is just its tabs; a tab opens it, the open tab closes it. ----------
  const worldEl = document.getElementById("world"), TABS = ["people", "animals", "things", "graphs", "key"], WW = () => IW;
  const wui = { open: false, tab: "people", fold: new Set(), scroll: 0, max: 0, hover: null, hits: [] };
  const words = (x) => String(x).replaceAll("_", " ");
  const SPECIES_C = { deer: P.d3, wolf: P.r2, fox: P.d4, rabbit: P.k1, fish: P.w4, heron: P.w6, gull: P.r4, crow: P.ink, eagle: P.d1, butterfly: P.violet };
  const far = (px, py) => { const m = Math.hypot(toM(px) - view.x, toM(py) - view.z); return m < 1000 ? `${Math.round(m)} M` : `${(m / 1000).toFixed(1)} KM`; };
  const near = (list) => list.map((e) => [e, (toM(e.px) - view.x) ** 2 + (toM(e.py) - view.z) ** 2]).sort((a, b) => a[1] - b[1]).map(([e]) => e);
  function worldData() {
    const W = sim.w, out = [];
    const tab = wui.tab;
    if (tab === "people") {
      out.push({ tab: "people", title: `people (${W.agents.length})`, rows: W.agents.map((a) => ({ label: a.name, value: a.status, icon: sim.activity(a.id) ? `act:${sim.activity(a.id)}` : `agent:${a.color}`, link: a.id, hot: a.id === view.selected })), none: "no one is left" });
      if (W.camps.length) out.push({ tab: "people", title: "camps", rows: W.camps.map((c) => ({ label: c.name, value: `${c.members.length} people`, more: c.members.map((m) => ({ text: m.name, link: m.id })) })) });
    } else if (tab === "animals") {
      const by = {};
      for (const a of W.animals) if (a.hp > 0) (by[a.species] ??= []).push(a);
      for (const [sp, list] of Object.entries(by).sort((a, b) => b[1].length - a[1].length))
        out.push({ tab: "animals", title: `${sp} (${list.length})`, key: `animals|${sp}`, fold: true, rows: wui.fold.has(`animals|${sp}`) ? near(list).slice(0, 200).map((a) => ({ label: words(a.state), value: far(a.px, a.py), icon: `animal:${sp}`, link: a.id, hot: a.id === view.selected })) : [] });
      if (!out.length) out.push({ tab: "animals", none: "no animals" });
    } else if (tab === "things") {
      // the worker counts them by kind and lists the nearest of each kind unfolded (wantWorld)
      for (const [k, g] of Object.entries(sim.things() ?? {}).sort((a, b) => a[0].localeCompare(b[0])))
        out.push({ tab: "things", title: `${words(k)} (${g.n})`, key: `things|${k}`, fold: true, rows: wui.fold.has(`things|${k}`) ? g.rows.map((t) => ({ label: t.label, value: far(t.px, t.py), link: t.id, hot: t.id === view.selected })) : [] });
    } else if (tab === "graphs") {
      const h = sim.history();
      if (!h) out.push({ tab: "graphs", none: "counting" });
      else {
        const span = h.t.length > 1 ? (h.t.at(-1) - h.t[0]) / sim.day : 0;
        out.push({ tab: "graphs", title: `people, last ${span.toFixed(1)} days`, rows: [{ label: "people", spark: h.people, h: 44, color: P.f1 }] });
        out.push({ tab: "graphs", title: "animals", rows: Object.entries(h.animals).sort((a, b) => (b[1].at(-1) ?? 0) - (a[1].at(-1) ?? 0)).map(([sp, xs]) => ({ label: sp, spark: xs, h: 26, color: SPECIES_C[sp] ?? P.w3, link: `@animals|${sp}` })) });
      }
    } else {
      out.push({ tab: "key", title: "over their heads", rows: Object.entries(sim.activities).map(([k, v]) => ({ label: v, icon: `act:${k}` })) });
      out.push({ tab: "key", title: "on the ground", rows: [{ label: "gold line: where they have been" }, { label: "flags: what happened there" }, { label: "dots: where they are going" }, { label: `${touchy ? "PATH" : "H"} hides or shows the lines` }] });
    }
    // every tab is there to click, its sections only the open one's
    return { sections: [...TABS.filter((t) => t !== tab).map((t) => ({ tab: t })), ...out].sort((a, b) => TABS.indexOf(a.tab) - TABS.indexOf(b.tab)) };
  }
  // what the open window needs of the worker: the things by kind, the nearest of each unfolded kind to the view's tile,
  // or the population's history; asked again after each tick, so the nearest follow the view
  const wantWorld = () => sim?.want({
    things: wui.open && wui.tab === "things" ? { open: [...wui.fold].filter((f) => f.startsWith("things|")).map((f) => f.slice(7)).sort(), px: Math.round((view.x + SIZE / 2) / TILE_M), py: Math.round((view.z + SIZE / 2) / TILE_M) } : null,
    history: wui.open && wui.tab === "graphs",
  });
  function paintWorld() {
    if (!sim) { worldEl.hidden = true; return; }
    const w = WW(), H = wui.open ? clamp(narrow() ? (window.innerHeight * 0.36) / 2 : window.innerHeight / 2 - 40, 100, 340) | 0 : 21, B = new Buf(w, H);
    B.c.fill(P.ink);
    for (let x = 1; x < w - 1; x++) for (let y = 1; y < H - 1; y++) B.c[y * w + x] = P.r4;
    const p = drawPanel(B, 3, 3, w - 4, H - 4, worldData(), { tab: wui.open ? wui.tab : false, open: wui.fold, scroll: wui.scroll, hover: wui.hover });
    wui.scroll = p.scroll; wui.max = p.scrollMax; wui.hits = p.hits;
    paintBuf(worldEl, B);
    worldEl.hidden = false;
  }
  scrollable(worldEl, () => wui.scroll, (v) => { wui.scroll = clamp(v, 0, wui.max); paintWorld(); }, (p) => {
    const h = hitAt(wui.hits, p);
    if (!h) return;
    if (h.tab != null) { if (wui.open && wui.tab === h.tab) wui.open = false; else { wui.open = true; wui.tab = h.tab; wui.scroll = 0; } }
    else if (h.toggle) { if (wui.fold.has(h.toggle)) wui.fold.delete(h.toggle); else wui.fold.add(h.toggle); }
    else if (h.link?.startsWith("@")) {
      // a graph's species: its list, unfolded
      const [tab, sp] = h.link.slice(1).split("|");
      wui.tab = tab; wui.scroll = 0; wui.fold.add(`animals|${sp}`);
    } else if (h.link) go(h.link);
    wantWorld();
    paintWorld();
  });
  worldEl.addEventListener("pointermove", (e) => {
    if (e.pointerType !== "mouse") return;
    const p = artAt(worldEl, e), was = hitAt(wui.hits, wui.hover ?? { x: -1, y: -1 }), now = hitAt(wui.hits, p);
    wui.hover = p; worldEl.style.cursor = now ? "pointer" : "";
    if (was !== now) paintWorld();
  });
  worldEl.addEventListener("pointerleave", () => { wui.hover = null; paintWorld(); });

  // ---------- a tooltip in the game's font: what a person or animal under the pointer is at, or the event a path's flag
  // stands for ----------
  const tipEl = document.getElementById("tip");
  const when = (t) => { const D = sim.day, h = ((t % D) / D) * 24; return `DAY ${Math.floor(t / D) + 1} ${String(Math.floor(h)).padStart(2, "0")}:${String(Math.floor((h % 1) * 60)).padStart(2, "0")}`; };
  let tipAt = 0, tipKey = "";
  async function tip(sx, sy) {
    let lines = null;
    const pin = live.pins().find((q) => Math.abs(q.x - sx) <= 8 && Math.abs(q.y - sy) <= 10);
    if (pin) lines = [when(pin.t), pin.text];
    else {
      const hit = await live.pick(sx, sy, view);
      if (hit?.kind === "agent") { const a = sim.w.agents.find((x) => x.id === hit.id), act = sim.activity(hit.id); if (a) lines = [a.name, a.status, ...(act ? [sim.activities[act]] : [])]; }
      else if (hit?.kind === "animal") { const a = sim.w.animals.find((x) => x.id === hit.id); if (a) lines = [a.species, words(a.state)]; }
    }
    const key = lines ? lines.join("|") : "";
    if (key !== tipKey) {
      tipKey = key;
      if (!lines) { tipEl.hidden = true; return; }
      const rows = lines.flatMap((l) => { const out = []; let cur = ""; for (const wd of String(l).toUpperCase().split(" ")) { if ((cur + " " + wd).trim().length > 34) { out.push(cur); cur = wd; } else cur = (cur + " " + wd).trim(); } out.push(cur); return out; }).slice(0, 8);
      const B = new Buf(Math.max(...rows.map((r) => r.length)) * 6 + 7, rows.length * 9 + 5);
      B.c.fill(P.s3);
      for (let i = 0; i < B.w; i++) { B.c[i] = P.ink; B.c[(B.h - 1) * B.w + i] = P.ink; }
      for (let j = 0; j < B.h; j++) { B.c[j * B.w] = P.ink; B.c[j * B.w + B.w - 1] = P.ink; }
      rows.forEach((r, i) => text(B, r, 4, 3 + i * 9, i ? P.d1 : P.ink));
      paintBuf(tipEl, B);
    }
    tipEl.style.left = `${Math.min(window.innerWidth - tipEl.width * 2 - 4, sx + 14)}px`;
    tipEl.style.top = `${Math.min(window.innerHeight - tipEl.height * 2 - 4, sy + 14)}px`;
    tipEl.hidden = false;
  }
  canvas.addEventListener("pointermove", (e) => {
    if (drag?.on || orbit || pinching || !sim) { tipEl.hidden = true; return; }
    const now = performance.now();
    if (now - tipAt < 90) return;
    tipAt = now;
    tip(e.clientX, e.clientY);
  });
  canvas.addEventListener("pointerleave", () => { tipEl.hidden = true; tipKey = ""; });
  window.addEventListener("resize", () => { fitInsp(); if (inspData) paintInspector(); paintWorld(); placePad(); });

  // ---------- pause and speed: a small marker in the corner while either is off the usual ----------
  let paceKey = "";
  // paused, warming up (the world's first days run at once after the first view: ticks done of all), or the speed
  function paintPace() {
    const key = !sim ? "" : sim.paused ? "PAUSED" : sim.warming ? `WARMING UP ${sim.warmTicks - sim.warming}/${sim.warmTicks}` : sim.speed !== PACE ? `X${sim.speed / PACE}` : "";
    if (key === paceKey) return;
    paceKey = key;
    pace.hidden = !key;
    if (!key) return;
    const B = new Buf(key.length * 6 + 7, 13);
    B.c.fill(P.w2);
    for (let i = 0; i < B.w; i++) { B.c[i] = P.w4; B.c[(B.h - 1) * B.w + i] = P.w1; }
    text(B, key, 4, 3, P.snow);
    paintBuf(pace, B);
  }

  // ---------- the clock: the hour, the light the sky should be giving it, and where that light comes from ----------
  // A sundial drawn as the view sees the ground (a 2:1 disc at its bearing, a stick at its centre) shows which way the
  // light comes and the shadows fall, with the sun or moon at its height over that side of the disc.
  const COMPASS = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"], DEG = 180 / Math.PI;
  // a direction across the ground (x east, z south) as a point of the compass
  const compass = (d) => COMPASS[Math.round(((Math.atan2(d[0], -d[1]) * DEG + 360) % 360) / 22.5) % 16];
  const MOONS = [[0.03, "NEW MOON"], [0.22, "WAXING CRESCENT"], [0.28, "FIRST QUARTER"], [0.47, "WAXING GIBBOUS"], [0.53, "FULL MOON"], [0.72, "WANING GIBBOUS"], [0.78, "LAST QUARTER"], [0.97, "WANING CRESCENT"], [1.01, "NEW MOON"]];
  // the light an hour should show, by the sun's height in degrees, as live.js lightOf gives it: short shadows above 45,
  // the golden hour below 12 (lightOf's LOW, where the sun's light has gone gold), the rose afterglow to 3 below, the
  // blue hour to 8 below, dusk to 12 below, then the moon's light or the stars'
  function effectOf(sky, morning) {
    const e = sky.e;
    if (e >= 12) return [e >= 45 ? "MIDDAY" : morning ? "MORNING" : "AFTERNOON", P.snow];
    if (e >= 0.8) return ["GOLDEN HOUR", P.f3];
    if (e >= -0.8) return [morning ? "SUNRISE" : "SUNSET", P.f2];
    if (e >= -3) return [morning ? "DAWN GLOW" : "AFTERGLOW", P.k0];
    if (e >= -8) return ["BLUE HOUR", P.w5];
    if (e >= -12) return [morning ? "DAWN" : "DUSK", P.w5];
    return sky.moon.el > 0 && sky.moon.lit > 0.3 ? ["MOONLIGHT", P.w6] : ["STARLIGHT", P.w5];
  }
  function sourceOf(sky) {
    const sun = sky.sun, moon = sky.moon, phase = MOONS.find(([t]) => moon.phase < t)[1];
    if (sky.e > -0.8) return `SUN ${Math.max(0, Math.round(sky.e))}° ${compass(sun.dir)}`;
    if (sky.e > -12) return `SUN ${Math.round(-sky.e)}° BELOW ${compass(sun.dir)}`;
    return moon.el > 0 ? `MOON ${Math.round(moon.el * DEG)}° ${compass(moon.dir)}, ${phase}` : `MOON DOWN, ${phase}`;
  }
  const line = (B, x0, y0, x1, y1, c) => { const n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 1); for (let k = 0; k <= n; k++) { const x = Math.round(x0 + ((x1 - x0) * k) / n), y = Math.round(y0 + ((y1 - y0) * k) / n); if (x >= 0 && y >= 0 && x < B.w && y < B.h) B.c[y * B.w + x] = c; } };
  let clockKey = "";
  function paintClock() {
    const sky = live.sky();
    if (!sim || !sky) { clockEl.hidden = true; return; }
    const c = sim.clock(), mins = Math.floor(c.hour * 60) % 1440, morning = c.hour < 13, weather = sim.w.weather?.sky ?? "clear";
    const [effect, tint] = effectOf(sky, morning), time = `${String(Math.floor(mins / 60)).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}  DAY ${c.day}`;
    const say = weather === "clear" ? effect : `${effect}, ${weather.toUpperCase()}`, from = sourceOf(sky);
    const key = `${time}|${say}|${from}|${Math.round(view.bearing * 32)}`;
    if (key === clockKey) return;
    clockKey = key;
    const DX = 38, B = new Buf(DX + Math.max(time.length, say.length, from.length) * 6 + 3, 33);
    B.c.fill(P.r0);
    for (let i = 0; i < B.w; i++) { B.c[i] = P.r2; B.c[(B.h - 1) * B.w + i] = P.ink; }
    // the dial: ground across the view's axes, so a direction d lands on the disc's rim at (u - v, (u + v) / 2)
    const a = (view.bearing * Math.PI) / 4, cx = 18, cy = 21, rx = 14, ry = 7;
    const rim = (d) => { const u = d[0] * Math.cos(a) + d[1] * Math.sin(a), v = -d[0] * Math.sin(a) + d[1] * Math.cos(a); return [(u - v) / Math.SQRT2, (u + v) / Math.SQRT2]; };
    const night = sky.e < -6, [ground, edge] = night ? [P.p1, P.p0] : sky.e < 0 ? [P.t2, P.t1] : [P.g3, P.g2];
    for (let y = cy - ry; y <= cy + ry; y++)
      for (let x = cx - rx; x <= cx + rx; x++) { const q = ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2; if (q <= 1) B.c[y * B.w + x] = q > 0.72 ? edge : ground; }
    // the stick's shadow, away from what casts, as long as its elevation makes it, to the rim at most
    if (sky.cast) {
      const [sx, sy] = rim(sky.cast.dir), k = Math.min(1, 0.55 / Math.max(sky.cast.tan, 1e-3));
      line(B, cx, cy, cx - Math.round(sx * rx * k), cy - Math.round(sy * ry * k), P.ink);
    }
    line(B, cx, cy, cx, cy - 7, P.d3);
    B.c[(cy - 8) * B.w + cx] = P.d5;
    // the sun over its side of the disc at its height, a glow on the rim while it lights the sky from below, else the moon
    const body = (d, el, c0, c1) => { const [px, py] = rim(d), x = Math.round(cx + px * rx), y = Math.round(cy + py * ry - Math.max(0, Math.sin(el)) * 14); for (const [i, j] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]]) if (x + i >= 0 && y + j >= 0 && x + i < B.w && y + j < B.h) B.c[(y + j) * B.w + x + i] = i || j ? c1 : c0; };
    if (sky.e > -0.8) body(sky.sun.dir, sky.sun.el, P.f4, sky.e < 12 ? P.f2 : P.f3);
    else if (sky.e > -12) body(sky.sun.dir, 0, P.k1, P.k2);
    if (sky.e <= -0.8 && sky.moon.el > 0) body(sky.moon.dir, sky.moon.el, P.snow, P.haze);
    text(B, time, DX, 4, P.snow);
    text(B, say, DX, 13, tint);
    text(B, from, DX, 22, P.haze);
    paintBuf(clockEl, B);
    clockEl.hidden = false;
  }

  // ---------- what draws the frames: WebGPU, and on which GPU, always in the corner ----------
  // a renderer's name in the 5x7 font: the device out of ANGLE's "(vendor, device, driver)", no trademarks
  const gpuName = (s) => {
    if (/swiftshader|llvmpipe|softpipe|software|basic render/i.test(s)) return "SOFTWARE, NO GPU: SLOW";
    const m = /^ANGLE \((.*)\)$/.exec(s), t = m ? (m[1].split(", ")[1] ?? m[1]) : s;
    return t.replace(/ANGLE \w+ Renderer: /i, "").replace(/\((R|TM)\)/gi, "").replace(/\s+/g, " ").trim().toUpperCase().replace(/[^A-Z0-9 .,:/-]/g, "").slice(0, 30);
  };
  let renderKey = "";
  function paintRender() {
    const r = live.renderer();
    const key = r.gpu ? `WEBGPU ON - ${gpuName(r.name) || "GPU"}` : "WEBGPU LOST";
    if (key === renderKey) return;
    renderKey = key;
    const B = new Buf(key.length * 6 + 7, 13), [bg, lit] = r.gpu ? [P.g1, P.g3] : [P.f0, P.f1];
    B.c.fill(bg);
    for (let i = 0; i < B.w; i++) { B.c[i] = lit; B.c[(B.h - 1) * B.w + i] = P.ink; }
    text(B, key, 4, 3, P.snow);
    paintBuf(renderEl, B);
    renderEl.title = r.gpu ? `Drawn on the GPU through WebGPU: ${r.name}` : `WebGPU stopped: ${r.why}`;
    renderEl.hidden = false;
  }

  // ---------- input ----------
  const pointers = new Map();
  let drag = null, orbit = null, pinching = false, lastClick = null;
  canvas.addEventListener("contextmenu", (e) => e.preventDefault());
  canvas.addEventListener("pointerdown", (e) => {
    canvas.setPointerCapture(e.pointerId);
    if (e.button === 2) { orbit = { x: e.clientX }; camera.stopTurn(); return; }
    if (e.button !== 0) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 1) { drag = { x0: e.clientX, y0: e.clientY, moved: 0, on: false }; camera.grabStart(e.clientX, e.clientY); }
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      camera.pinchStart((a.x + b.x) / 2, (a.y + b.y) / 2, Math.hypot(a.x - b.x, a.y - b.y), Math.atan2(b.y - a.y, b.x - a.x));
      pinching = true; drag = null; follow = null; camera.grabEnd();
    }
  });
  canvas.addEventListener("pointermove", (e) => {
    if (orbit) { camera.orbitBy((orbit.x - e.clientX) / 180); orbit.x = e.clientX; return; }
    const p = pointers.get(e.pointerId);
    if (!p) return;
    const dx = e.clientX - p.x, dy = e.clientY - p.y;
    p.x = e.clientX; p.y = e.clientY;
    if (pinching && pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      camera.pinchMove((a.x + b.x) / 2, (a.y + b.y) / 2, Math.hypot(a.x - b.x, a.y - b.y), Math.atan2(b.y - a.y, b.x - a.x));
      return;
    }
    if (!drag) return;
    drag.moved += Math.abs(dx) + Math.abs(dy);
    // past the click threshold the world jumps to the cursor, then moves with it exactly
    if (!drag.on && drag.moved > 5) { drag.on = true; canvas.classList.add("dragging"); follow = null; }
    if (drag.on) camera.grabMove(e.clientX, e.clientY);
  });
  const up = (e) => {
    if (orbit) { orbit = null; camera.settle(); return; }
    pointers.delete(e.pointerId);
    canvas.classList.remove("dragging");
    camera.grabEnd();
    if (pinching) { if (pointers.size < 2) { pinching = false; camera.pinchEnd(); } drag = null; return; }
    if (drag && !drag.on && e.type === "pointerup") click(e.clientX, e.clientY);
    drag = null;
  };
  canvas.addEventListener("pointerup", up);
  canvas.addEventListener("pointercancel", up);
  // a click waits out the double-click window; a double-click only zooms, undoing a first click that landed
  function click(sx, sy) {
    const now = performance.now(), prev = lastClick;
    if (prev && now - prev.t < DBL_MS + 200 && Math.hypot(sx - prev.x, sy - prev.y) < 10) {
      clearTimeout(prev.timer);
      if (prev.done) select(prev.before, false);
      lastClick = null;
      camera.zoomTo(camera.goal + 1, follow ? null : sx, follow ? null : sy);
      return;
    }
    const hit = live.pick(sx, sy, view), c = { t: now, x: sx, y: sy, before: view.selected, done: false };
    c.timer = setTimeout(async () => { c.done = true; choose(await hit, sx, sy); }, DBL_MS);
    lastClick = c;
  }
  // a second click on what is already selected lets it go
  function choose(hit, sx, sy) {
    if (!hit) { select(null); return; }
    const sel = hit.kind === "ground" ? hit : hit.id, cur = view.selected;
    let again = sel === cur;
    if (!again && typeof sel === "object" && cur && typeof cur === "object") {
      const g = live.where(cur, sim, view), s = g && live.screenOf(view, g.x, g.z, g.y);
      again = !!s && Math.hypot(s[0] - sx, s[1] - sy) < 8;
    }
    select(again ? null : sel);
  }
  canvas.addEventListener("wheel", (e) => {
    e.preventDefault();
    camera.zoomTo(camera.goal - clamp(e.deltaY, -200, 200) * 0.004, follow ? null : e.clientX, follow ? null : e.clientY);
  }, { passive: false });
  // what the keys do, and the touch buttons with them
  const next = (backward = false) => {
    if (!sim?.w.agents.length) return;
    const list = sim.w.agents, k = list.findIndex((a) => a.id === view.selected), n = list.length;
    select(list[((k < 0 ? (backward ? 0 : -1) : k) + (backward ? -1 : 1) + n) % n].id, true, "keep");
  };
  const speedBy = (d) => { if (!sim) return; const k = SPEEDS.indexOf(sim.speed); sim.speed = SPEEDS[clamp((k < 0 ? 2 : k) + d, 0, SPEEDS.length - 1)]; };
  const zoomBy = (d) => { const mid = follow ? [null, null] : [canvas.width / 2, canvas.height / 2]; camera.zoomTo(Math.round(camera.goal) + d, ...mid); };
  const ACT = {
    left: () => camera.turnBy(-1), right: () => camera.turnBy(1), out: () => zoomBy(-1), in: () => zoomBy(1),
    pause: () => { if (sim) sim.paused = !sim.paused; }, slower: () => speedBy(-1), faster: () => speedBy(1),
    next: () => next(), paths: () => { view.path = view.path === false; },
  };
  // ---------- the readout: where the camera is, how far in, how big the ground is, which way north lies, and the hour (with no sim it sets the light only) ----------
  const hud = document.getElementById("hud"), hudOf = (s) => hud.querySelector(s), hourIn = hudOf("input"), hourV = hudOf(".hour-v"), northEl = hudOf(".north span"), scaleEl = hudOf("i.scale"), scaleLabel = hudOf(".scale-label");
  let hour = num("hour", 13, 0, 24), hudKey = "";
  const hourText = (h) => `${String(Math.floor(h) % 24).padStart(2, "0")}:${String(Math.floor((h % 1) * 60)).padStart(2, "0")}`;
  const setHour = (h) => { hour = ((h % 24) + 24) % 24; if (!sim) live.setClock({ hour }); };
  const hourBy = (d) => setHour(Math.round(hour) + d);
  hudOf(".hour").hidden = !!sim;
  hourIn.addEventListener("input", () => setHour(+hourIn.value));
  hourIn.addEventListener("change", () => hourIn.blur());
  const niceM = (m) => { const p = 10 ** Math.floor(Math.log10(m)), f = m / p; return p * (f >= 5 ? 5 : f >= 2 ? 2 : 1); };
  function paintHud() {
    const g = view.geo, mpp = live.mPerPx(view);
    if (!g || !mpp) { hud.hidden = true; return; }
    const m = niceM(mpp * 100), px = Math.round(m / mpp), north = live.northAngle(view);
    const pos = `${Math.abs(g.lat).toFixed(2)}\u00b0 ${g.lat < 0 ? "S" : "N"}  ${Math.abs(g.lon).toFixed(2)}\u00b0 ${g.lon < 0 ? "W" : "E"}`, zoom = `zoom ${view.zoom.toFixed(2)}`, label = m >= 1000 ? `${m / 1000} km` : `${m} m`;
    hud.hidden = false;
    const key = `${pos}|${zoom}|${label}|${px}|${Math.round(north)}|${Math.round(hour * 4)}`;
    if (key === hudKey) return;
    hudKey = key;
    hudOf(".pos").textContent = pos; hudOf(".zoom").textContent = zoom;
    scaleEl.style.width = `${px}px`; scaleLabel.textContent = label;
    northEl.style.display = "inline-block"; northEl.style.transform = `rotate(${north.toFixed(1)}deg)`;
    if (!sim) { hourIn.value = String(hour); hourV.textContent = hourText(hour); }
  }
  for (const b of pad.querySelectorAll("button")) if (!sim && ["pause", "slower", "faster", "next", "paths"].includes(b.dataset.act)) b.hidden = true;
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") select(null);
    else if (e.key === "Tab" && sim?.w.agents.length) { e.preventDefault(); next(e.shiftKey); }
    else if (e.key === " " && sim) { ACT.pause(); e.preventDefault(); }
    else if (e.key === "[" || e.key === "]") { if (sim) speedBy(e.key === "]" ? 1 : -1); else hourBy(e.key === "]" ? 1 : -1); }
    else if (e.key === "+" || e.key === "=" || e.key === "-") zoomBy(e.key === "-" ? -1 : 1);
    else if (e.key === "h" || e.key === "H") ACT.paths();
    else if (e.key === "q" || e.key === "Q") ACT.left();
    else if (e.key === "e" || e.key === "E") ACT.right();
  });
  for (const b of pad.querySelectorAll("button")) b.addEventListener("click", () => { ACT[b.dataset.act]?.(); paintPad(); });
  // the buttons light for what they hold: paused, a speed off the usual, paths hidden
  let padKey = "";
  function paintPad() {
    if (pad.hidden) return;
    const on = { pause: !!sim?.paused, slower: !!sim && sim.speed < PACE, faster: !!sim && sim.speed > PACE, paths: view.path === false };
    const key = JSON.stringify(on);
    if (key === padKey) return;
    padKey = key;
    for (const b of pad.querySelectorAll("button")) b.classList.toggle("on", !!on[b.dataset.act]);
    pad.querySelector('[data-act="pause"]').textContent = sim?.paused ? "\u25B6" : "II";
  }
  pad.hidden = !touchy;
  placePad();
  setTimeout(() => hint.classList.add("gone"), 8000);
  globalThis.play = globalThis.nomads = { live, sim, view, camera, select, metrics, zoomTo: (g, sx, sy) => camera.zoomTo(g, sx, sy), turnBy: (d) => camera.turnBy(d), inspected: () => inspData, inspector: ui, world: wui, paintWorld };
  // an answer from the worker between ticks (a new selection, a window opened) is shown as it comes
  if (sim) sim.onAnswer = () => { if (view.selected) inspect(); if (wui.open) paintWorld(); };

  // Near targets are eased toward. A far one (a Tab to someone across the island) is baked first while the camera
  // holds, then cut to, so the close level never sits on a fallback.
  function followStep(now, dt) {
    const p = live.where(follow, sim, view);
    // a thing linked to stands where the worker says, once it has answered; gone, it is let go
    if (!p) { if (sim.inspect(follow) !== undefined) select(null); live.prefetch(null); return; }
    const upOf = (q) => q.y - live.camH(q.x, q.z), ahead = p.dx || p.dz ? [{ ...view, x: p.x + p.dx, z: p.z + p.dz, up: upOf(p), later: true }] : [];
    if (camera.offCentre(p) <= canvas.width * 0.35) {
      const iv = sim.paused || sim.alpha >= 1 ? Infinity : sim.stepMs;
      camera.follow(p, dt, (p.dx || 0) / iv, (p.dz || 0) / iv);
      farSince = 0;
      live.prefetch(ahead);
      return;
    }
    // lock the destination when the jump starts: a walker keeps moving, and chasing each step would never finish
    if (!farSince) { farSince = now; farDest = { ...view, x: p.x, z: p.z, up: upOf(p) }; }
    live.prefetch([farDest, ...ahead]);
    if (live.readiness(farDest).ready || now - farSince > 3000) {
      camera.lookAt({ x: farDest.x, z: farDest.z, y: farDest.up + live.camH(farDest.x, farDest.z) });
      farSince = 0;
      if (tabWatch && !tabWatch.cutAt) tabWatch.cutAt = now - tabWatch.t0;
    }
  }

  // ---------- loop ----------
  const showStats = Q.get("stats") === "1";
  statsEl.hidden = !showStats;
  let lastStats = 0, readyMarked = false, lastNow = performance.now();
  const bench = benchKinds.length ? benchSeq(benchKinds) : null;
  let revealed = false, relayShown = false, placed = null;
  function loop(now) {
    const dt = Math.min(100, now - lastNow);
    lastNow = now;
    // the world waits behind the loading line until the opening view is baked, so nothing is missed
    if (sim && revealed) {
      const ch = sim.update(now);
      if (ch) { wantWorld(); if (view.selected) inspect(); if (wui.open) paintWorld(); }
      if (sim.brain === "relay" && !relayShown) { relayShown = true; document.title = "Nomads: live, thinking with Jev"; hint.textContent += " · thinking with Jev"; }
    }
    // a bench runs once the world has warmed, or during the warm with ?benchwarm
    if (revealed && bench && (!sim?.warming || Q.has("benchwarm"))) bench.step(now);
    // a view put somewhere between frames by something other than the camera (a script setting view.geo or x and z) is not what the followed one is: let it go,
    // or the camera is cut back to them (across a planet's width of ground a window of it was being made for every cut)
    if (follow && placed && (view.x !== placed.x || view.z !== placed.z || view.geo?.lat !== placed.lat || view.geo?.lon !== placed.lon)) { follow = null; farSince = 0; }
    camera.step(dt, now);
    if (follow && sim) followStep(now, dt);
    // a zoom's destination, or a bench's first view, has its level's lists built first
    else { const goal = camera.goalView(); live.prefetch(bench?.ahead() ?? (goal ? [goal] : null)); }
    // the ground under the opening shot is only exact once its chunks are in, so keep it centred until then
    if (!revealed && opening) camera.lookAt(live.where(opening, sim, view));
    camera.guard();
    const r = live.frame(view, sim, { show: revealed });
    placed = { x: view.x, z: view.z, lat: view.geo?.lat, lon: view.geo?.lon };
    if (!revealed) {
      // every bearing of the opening view, so the first turns land on baked ground; the load can take its time. With
      // ?adj=0 nothing bakes the other bearings, so only this one.
      const rd = { done: 0, all: 0 };
      for (const b of Q.get("adj") === "0" ? [view.bearing] : [0, 1, 2, 3, 4, 5, 6, 7]) { const q = live.readiness(view, b); rd.done += q.done; rd.all += q.all; }
      rd.ready = rd.done === rd.all;
      if (rd.ready && !r.holes && live.pictureReady()) {
        revealed = true;
        metrics.revealMs = Math.round(performance.now() - t0);
        paintWorld();
        // follow the settlement's person only if they are in this frame
        if (openingPerson && !bench && live.picks().some((p) => p.id === openingPerson)) select(openingPerson, false);
      } else loadingScreen(canvas, rd.ready && !r.holes ? "drawing the planet" : `baking the view from every side ${rd.done}/${rd.all}`, rd.ready ? 1 : rd.done / rd.all);
    }
    if (tabWatch) {
      const dt2 = now - tabWatch.last;
      tabWatch.last = now;
      if (r.holes) tabWatch.hole += dt2;
      if (now - tabWatch.t0 > 6000) { metrics.tabs.push({ holeMs: Math.round(tabWatch.hole), cutMs: Math.round(tabWatch.cutAt) }); tabWatch = null; }
    }
    if (revealed) { paintPace(); paintClock(); paintPad(); paintHud(); }
    paintRender();
    if (!readyMarked && revealed && !bench) {
      readyMarked = true; document.body.dataset.firstFrame = String(Math.round(performance.now() - t0)); document.body.classList.add("ready");
    }
    if (showStats && now - lastStats > 250) {
      lastStats = now;
      const s = live.stats, c = sim?.clock(), lf = live.level;
      statsEl.textContent = [
        `fps ${s.fps.toFixed(0)}  frame ${s.composeMs.toFixed(1)} ms  slots ${s.slots}`,
        `gpu ${(s.gpuMs ?? 0).toFixed(1)} ms  worker ${(s.workerMs ?? 0).toFixed(1)} ms  sprites ${s.counts?.sprites ?? 0}  specks ${s.counts?.points ?? 0}`,
        `heap ${s.memMB} MB  objects ${s.objects?.n ?? 0}  atlas ${s.objects?.sprites ?? 0} sprites`,
        `zoom ${view.zoom.toFixed(2)} ${live.levels[lf?.L ?? 0].name} x${(lf?.s ?? 0).toFixed(2)}  bearing ${view.bearing.toFixed(2)}`,
        sim ? `day ${c.day} ${String(Math.floor(c.hour)).padStart(2, "0")}:${String(Math.floor((c.hour % 1) * 60)).padStart(2, "0")}  x${sim.speed / PACE}${sim.paused ? " paused" : ""}  tick ${sim.tickMs.toFixed(1)} ms` : "no sim",
      ].join("\n");
    }
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);

  // ?bench=zoom | orbit | turn | pan: drive the camera and record frame rate and frame cost, for the report. Several run
  // in turn, each from the view the first began at, after a settling pause of SETTLE_MS [design]; their results are
  // kept by kind. Each begins once the lists its first view draws from are built (live.listsReady: a zoom's first frame
  // is the whole island), as a camera that goes there by any other way finds them, or after LISTS_MS [design: the
  // island levels' front lists of one bearing take about a second each to build].
  function benchSeq(kinds) {
    const SETTLE_MS = 2000, LISTS_MS = 20000, results = {};
    let i = 0, cur = null, home = null, wait = 0, waited = 0;
    const done = (out) => {
      results[out.kind] = { ...out, listsWaitMs: waited };
      cur = null;
      if (++i < kinds.length) { wait = 0; return; }
      document.body.dataset.bench = JSON.stringify(kinds.length > 1 ? results : results[out.kind]);
      document.body.classList.add("ready");
    };
    // the view a kind's first frame shows (benchRunner)
    const first = (kind) => ({ ...home, zoom: kind === "zoom" ? 0 : kind === "pan" ? live.named[names[0]] : home.zoom });
    return {
      step(now) {
        if (i >= kinds.length) return;
        if (!home) home = { x: view.x, z: view.z, bearing: view.bearing, zoom: view.zoom };
        if (!cur) {
          if (!wait) { wait = now; if (i) { camera.setZoom(home.zoom); Object.assign(view, { x: home.x, z: home.z, bearing: home.bearing }); } }
          if (i && now - wait < SETTLE_MS) return;
          if (!live.listsReady(first(kinds[i])) && now - wait < LISTS_MS) return;
          waited = Math.round(now - wait);
          cur = benchRunner(kinds[i], live, view, done);
        }
        cur.step(now);
      },
      // the view the next kind begins at, while it waits to begin
      ahead: () => (home && !cur && i < kinds.length ? [first(kinds[i])] : null),
    };
  }
  function benchRunner(kind, live, view, onDone) {
    const secs = num("benchs", 12, 1, 600), out = { kind, samples: [] }, gpu = [];
    let start = 0, done = false, base = null, lastT = 0, k = 0, warmingAt = false;
    // the page thread's long tasks (over 50 ms) while the bench runs, in ms
    const long = [], watch = new PerformanceObserver((l) => { if (start && !done) for (const e of l.getEntries()) long.push(Math.round(e.duration)); });
    watch.observe({ type: "longtask" });
    const finish = () => {
      const ms = out.samples.map((s) => s.ms).sort((a, b) => a - b), dts = out.samples.map((s) => s.dt).filter((d) => d > 0);
      out.fps = +(1000 / (dts.reduce((a, b) => a + b, 0) / dts.length)).toFixed(1);
      out.frameMs = +(ms.reduce((a, b) => a + b, 0) / ms.length).toFixed(2);
      out.frameP95 = +ms[Math.floor(ms.length * 0.95)].toFixed(2);
      out.holeFrames = out.samples.filter((s) => s.holes).length;
      out.frames = ms.length;
      out.twoSlotFrames = out.samples.filter((s) => s.slots > 1).length;
      out.heapMB = Math.round((performance.memory?.usedJSHeapSize ?? 0) / 1e6); out.cacheMB = live.stats.cacheMB; out.turns = metrics.turns;
      out.reveal = metrics.revealMs;
      out.slow = [...out.samples].sort((a, b) => b.ms - a.ms).slice(0, 12).map((s) => [+s.ms.toFixed(1), s.z, s.slots, s.holes ? 1 : 0, ...(s.parts || [])]);
      out.slowGaps = [...out.samples].sort((a, b) => b.dt - a.dt).slice(0, 6).map((s) => [Math.round(s.dt), +s.ms.toFixed(1), s.z]);
      // the render worker's frames: the GPU's own time for each (timestamps), the worker's time to record it, the time
      // from the page sending a frame to the GPU finishing it, and the time between two finished frames (what is seen)
      const st = (xs) => { const v = [...xs].sort((a, b) => a - b); return v.length ? { mean: +(v.reduce((a, b) => a + b, 0) / v.length).toFixed(2), p95: +v[Math.floor(v.length * 0.95)].toFixed(2), max: +v.at(-1).toFixed(2), over16: v.filter((x) => x > 16.7).length } : null; };
      out.worker = { frames: gpu.length, gpuMs: st(gpu.map((f) => f.gpu)), cpuMs: st(gpu.map((f) => f.cpu)), latencyMs: st(gpu.map((f) => f.latency)), gapMs: st(gpu.slice(1).map((f, j) => f.at - gpu[j].at)) };
      // the worker's dearest frames: GPU ms, the zoom and views when the page heard of it, and each pass's GPU ms
      out.worker.slow = [...gpu].sort((a, b) => b.gpu - a.gpu).slice(0, 12).map((f) => [+(f.gpu ?? 0).toFixed(2), f.z, f.slots, f.passes]);
      out.warming = warmingAt;
      out.dtMs = st(out.samples.map((s) => s.dt));
      for (const e of watch.takeRecords()) long.push(Math.round(e.duration));
      watch.disconnect();
      out.longTasks = long.sort((a, b) => b - a);
      delete out.samples;
      done = true;
      onDone(out);
    };
    return {
      step(now) {
        if (done) return;
        if (!start) { start = now; base = { x: view.x, z: view.z, bearing: view.bearing }; lastT = now; live.frameTimes(); warmingAt = !!sim?.warming; }
        const t = (now - start) / 1000, f = Math.min(1, t / secs);
        if (lastT !== now) out.samples.push({ dt: now - lastT, ms: live.lastMs, holes: live.lastHoles, slots: live.stats.slots, z: +view.zoom.toFixed(2), parts: live.lastParts });
        for (const f of live.frameTimes()) gpu.push({ ...f, z: +view.zoom.toFixed(2), slots: live.stats.slots });
        lastT = now;
        if (kind === "zoom") camera.setZoom(live.zmax * (f < 0.5 ? f * 2 : 2 - f * 2));
        else if (kind === "orbit") view.bearing = norm8(base.bearing + 8 * f);
        else if (kind === "turn") {
          // three turns, each to a bearing nothing has prefetched, a few seconds apart
          if (!camera.turning && k < 3 && t > k * 4) { camera.turnBy(1); k++; }
          if (k === 3 && !camera.turning && t > 12) { finish(); return; }
          return;
        } else if (kind === "pan") {
          const zi = Math.min(3, Math.floor(f * 4)), pxm = live.ppm(view.zoom), tri = Math.abs(((t / 3) % 1) * 2 - 1) * 2 - 1;
          camera.setZoom(live.named[names[zi]]);
          view.x = base.x + (tri * Math.min(600 / pxm, 2500)); view.z = base.z + tri * Math.min(240 / pxm, 1000);
        }
        if (f >= 1) finish();
      },
    };
  }
}

// The page draws with WebGPU only: where the browser offers none, a plain notice says so and nothing else runs.
if (hasWebGPU()) main().catch(fail);
else {
  const note = document.createElement("p");
  note.textContent = "This page draws the island with WebGPU, which this browser does not offer. Open it in Chrome or Edge 113 or later, or Safari 26.";
  Object.assign(note.style, { position: "fixed", inset: "0", margin: "auto", height: "fit-content", maxWidth: "36em", padding: "1em", font: "15px/1.5 ui-monospace, Menlo, Consolas, monospace", color: "#eef2f6", textAlign: "center" });
  canvas.hidden = true; hint.hidden = true;
  document.body.append(note);
  document.body.classList.add("failed", "nogpu");
}
