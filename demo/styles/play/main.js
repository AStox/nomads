// The live page: the game's sim running in this tab, drawn by the isopixel renderer with a pan, zoom and orbit camera.
import { createLive, loadingScreen } from "../isopixel/live.js";
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
const seed = Math.trunc(num("seed", 1)), warm = Math.trunc(num("warm", 2016, 0, 40000)), withSim = Q.get("sim") !== "0";
const benchKind = ["zoom", "orbit", "turn", "pan"].includes(Q.get("bench")) ? Q.get("bench") : null;
const canvas = document.getElementById("view"), hint = document.getElementById("hint"), statsEl = document.getElementById("stats"), pace = document.getElementById("pace"), renderEl = document.getElementById("render"), clockEl = document.getElementById("clock");
const SPEEDS = [0.25, 0.5, 1, 2, 4, 8], DBL_MS = 300;
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
  // one line of progress in the game's own font until the opening view is complete
  const steps = { renderer: ["growing the island", 0], sim: ["warming the world", 0] };
  const say = () => { const r = steps.renderer, w = steps.sim; loadingScreen(canvas, `${r[0]}  ${w[1] < 1 && withSim ? "/ " + w[0] : ""}`.trim(), (r[1] + (withSim ? w[1] : 1)) / 2); };
  say();
  // the sim and the renderer's workers grow the same island at the same time
  // ?jev=<token> lets the people think with Jev through this server's relay, and is remembered on this browser;
  // ?jev=off forgets it
  const jevQ = Q.get("jev");
  if (jevQ === "off") localStorage.removeItem("nomads-jev"); else if (jevQ) localStorage.setItem("nomads-jev", jevQ);
  const jev = jevQ === "off" ? null : localStorage.getItem("nomads-jev");
  // the token is kept, not shown: a copied link doesn't carry it
  if (jevQ) { Q.delete("jev"); history.replaceState(null, "", `${location.pathname}${Q.size ? `?${Q}` : ""}`); }
  const simP = withSim ? import("./sim.js").then(({ createSim }) => createSim({ seed, warm, jev, onProgress: (d, n) => { steps.sim = ["warming the world", d / n]; say(); } })) : Promise.resolve(null);
  const live = await createLive({ seed, canvas, workers: Math.trunc(num("workers", 0, 0, 8)) || undefined, adjacent: Q.get("adj") !== "0", check: Q.get("check") === "1", onProgress: (d, n, what) => { steps.renderer = [what, 0.5 * (what === "baking the island" ? 1 : 0) + (0.5 * d) / n]; say(); } });
  const sim = await simP;
  if (sim?.brain === "relay") { document.title = "Nomads: live, thinking with Jev"; hint.textContent += " · thinking with Jev"; }
  // ?hour= pins the hour the island is drawn at, its light and sun, while the sim runs on
  if (sim) sim.hour = num("hour", null, 0, 24);
  const ready = performance.now() - t0;
  // ?zoom= takes a name, the old 0..3 index, or a number of zoom steps; ?bearing= one of the 8 whole bearings
  const zq = Q.get("zoom"), names = ["island", "region", "valley", "close"];
  const zoom0 = zq == null ? live.named.close : Object.hasOwn(live.named, zq) ? live.named[zq] : /^[0-3]$/.test(zq) ? live.named[names[+zq]] : num("zoom", live.named.close, 0, live.zmax);
  const view = { x: -2738, z: -1838, zoom: zoom0, bearing: norm8(Math.round(num("bearing", 0))), up: 0, selected: null, turnTo: null };
  const metrics = { readyMs: Math.round(ready), revealMs: 0, tabs: [], turns: [] };
  const camera = createCamera({ live, view, canvas, onTurn: (t) => metrics.turns.push({ startMs: Math.round(t.start), totalMs: Math.round(t.total) }) });
  let follow = null, openingPerson = null, opening = null, farSince = 0, farDest = null;
  // Open on the person nearest the densest cluster of shelters, fires and stumps, and follow them; with nothing built
  // yet, on whoever has the most going on around them.
  if (sim?.w.agents.length) {
    const W = sim.w, weight = (t) => (t.contained || t.inside ? 0 : t.kind === "structure" ? 2 + (t.shelter?.tier ?? 0) * 2 : t.kind === "fire" ? 4 : t.kind === "well" ? 2 : ["stump", "burnt_stump", "pit", "ash", "grave"].includes(t.kind) ? 1 : 0);
    const built = W.things.filter((t) => weight(t) > 0);
    let best = null, bs = 0;
    for (const t of built) {
      const sc = built.reduce((a, o) => a + (Math.abs(o.x - t.x) <= 2 && Math.abs(o.y - t.y) <= 2 ? weight(o) : 0), 0);
      if (sc > bs) { bs = sc; best = t; }
    }
    const busy = (a) => W.things.filter((t) => !t.contained && t.kind !== "tree" && Math.abs(t.x - a.x) <= 2 && Math.abs(t.y - a.y) <= 2).length + W.agents.filter((b) => Math.abs(b.x - a.x) <= 2 && Math.abs(b.y - a.y) <= 2).length * 4;
    const person = best ? [...W.agents].sort((p, q) => Math.hypot(p.x - best.x, p.y - best.y) - Math.hypot(q.x - best.x, q.y - best.y))[0] : [...W.agents].sort((p, q) => busy(q) - busy(p))[0];
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
    follow = typeof sel === "string" && (movers(sel) || ((how === "link" || how === "back") && sim?.pos(sel))) ? sel : null;
    if (watch && follow) tabWatch = { t0: performance.now(), hole: 0, cutAt: 0, last: performance.now() };
    if (how !== "keep") ui.tab = null;
    ui.open.clear(); ui.scroll = 0;
    inspect();
  };

  // ---------- inspector: the selection's real data in tabs, redrawn every tick; rows open, names go to whoever they
  // name, and a back button returns along the way that came ----------
  const insp = document.getElementById("inspector"), IW = 212, back = [];
  let IH = 300;
  const fitInsp = () => { IH = clamp(Math.floor((window.innerHeight - 24) / 2), 160, 320); };
  fitInsp();
  const CB = { y: 4, s: 9 }, cbx = () => IW - 15, BK = { x: 5, y: 4, s: 9 };
  const ui = { tab: null, open: new Set(), scroll: 0, max: 0, hover: null, hits: [] };
  let inspData = null;
  function inspect() {
    const sel = view.selected;
    inspData = sel && sim ? (typeof sel === "object" ? sim.inspectGround(sel.px, sel.py) : sim.inspect(sel)) : null;
    if (sel && !inspData) { view.selected = null; follow = null; }
    if (!inspData) { insp.hidden = true; return; }
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
  }
  // a pointer event on one of the art windows, in its art px
  const artAt = (cv, e) => { const r = cv.getBoundingClientRect(); return { x: ((e.clientX - r.left) / r.width) * cv.width, y: ((e.clientY - r.top) / r.height) * cv.height }; };
  const onBox = (p, x, y, s) => p.x >= x - 1 && p.x <= x + s && p.y >= y - 1 && p.y <= y + s;
  const hitAt = (hits, p) => hits.find((h) => p.x >= h.x0 && p.x <= h.x1 && p.y >= h.y0 && p.y <= h.y1) ?? null;
  // go to what a window names: a person, an animal or a thing
  const go = (id) => { if (sim?.inspect(id)) select(id, true, "link"); };
  insp.addEventListener("wheel", (e) => { e.preventDefault(); ui.scroll = clamp(ui.scroll + e.deltaY / 2, 0, ui.max); if (inspData) paintInspector(); }, { passive: false });
  insp.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    const p = artAt(insp, e);
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
    const p = artAt(insp, e), was = hitAt(ui.hits, ui.hover ?? { x: -1, y: -1 }), now = hitAt(ui.hits, p);
    ui.hover = p;
    insp.style.cursor = now || onBox(p, cbx(), CB.y, CB.s) || (back.length && onBox(p, BK.x, BK.y, BK.s)) ? "pointer" : "";
    if (was !== now && inspData) paintInspector();
  });
  insp.addEventListener("pointerleave", () => { ui.hover = null; if (inspData) paintInspector(); });

  // ---------- the world window: everyone and everything, by kind, to click and go to; population over time; the key
  // to the markers. Closed it is just its tabs; a tab opens it, the open tab closes it. ----------
  const worldEl = document.getElementById("world"), WW = 212, TABS = ["people", "animals", "things", "graphs", "key"];
  const wui = { open: false, tab: "people", fold: new Set(), scroll: 0, max: 0, hover: null, hits: [] };
  const words = (x) => String(x).replaceAll("_", " ");
  const SPECIES_C = { deer: P.d3, wolf: P.r2, rabbit: P.k1, fish: P.w4, heron: P.w6, gull: P.r4, crow: P.ink, eagle: P.d1, butterfly: P.violet };
  const far = (px, py) => { const m = Math.hypot(toM(px) - view.x, toM(py) - view.z); return m < 1000 ? `${Math.round(m)} M` : `${(m / 1000).toFixed(1)} KM`; };
  const near = (list) => list.map((e) => [e, (toM(e.px) - view.x) ** 2 + (toM(e.py) - view.z) ** 2]).sort((a, b) => a[1] - b[1]).map(([e]) => e);
  function worldData() {
    const W = sim.w, out = [];
    const tab = wui.tab;
    if (tab === "people") {
      out.push({ tab: "people", title: `people (${W.agents.length})`, rows: W.agents.map((a) => ({ label: a.name, value: a.status, icon: sim.activity(a.id) ? `act:${sim.activity(a.id)}` : `agent:${a.color}`, link: a.id, hot: a.id === view.selected })), none: "no one is left" });
      const camps = W.camps.filter((c) => !c.gone);
      if (camps.length) out.push({ tab: "people", title: "camps", rows: camps.map((c) => ({ label: c.name, value: `${c.members.length} people`, more: c.members.map((id) => ({ text: W.people[id]?.name ?? id, link: id })) })) });
    } else if (tab === "animals") {
      const by = {};
      for (const a of W.animals) if (a.hp > 0) (by[a.species] ??= []).push(a);
      for (const [sp, list] of Object.entries(by).sort((a, b) => b[1].length - a[1].length))
        out.push({ tab: "animals", title: `${sp} (${list.length})`, key: `animals|${sp}`, fold: true, rows: wui.fold.has(`animals|${sp}`) ? near(list).slice(0, 200).map((a) => ({ label: words(a.state), value: far(a.px, a.py), icon: `animal:${sp}`, link: a.id, hot: a.id === view.selected })) : [] });
      if (!out.length) out.push({ tab: "animals", none: "no animals" });
    } else if (tab === "things") {
      const by = {};
      for (const t of W.things) if (!t.contained) (by[t.kind] ??= []).push(t);
      for (const [k, list] of Object.entries(by).sort((a, b) => a[0].localeCompare(b[0]))) {
        const title = `${words(k)} (${list.length})`;
        out.push({ tab: "things", title, key: `things|${k}`, fold: true, rows: wui.fold.has(`things|${k}`) ? near(list).slice(0, 150).map((t) => ({ label: t.kind === "structure" ? ["pile", "lean-to", "hut", "cabin"][t.shelter?.tier ?? 0] : t.kind === "item" ? W.kinds[t.item]?.name ?? words(t.item ?? "item") : words(t.species ?? t.kind), value: far(t.px, t.py), link: t.id, hot: t.id === view.selected })) : [] });
      }
    } else if (tab === "graphs") {
      const h = sim.history(), span = h.t.length > 1 ? (h.t.at(-1) - h.t[0]) / 288 : 0;
      out.push({ tab: "graphs", title: `people, last ${span.toFixed(1)} days`, rows: [{ label: "people", spark: h.people, h: 44, color: P.f1 }] });
      out.push({ tab: "graphs", title: "animals", rows: Object.entries(h.animals).sort((a, b) => (b[1].at(-1) ?? 0) - (a[1].at(-1) ?? 0)).map(([sp, xs]) => ({ label: sp, spark: xs, h: 26, color: SPECIES_C[sp] ?? P.w3, link: `@animals|${sp}` })) });
    } else {
      out.push({ tab: "key", title: "over their heads", rows: Object.entries(sim.activities).map(([k, v]) => ({ label: v, icon: `act:${k}` })) });
      out.push({ tab: "key", title: "on the ground", rows: [{ label: "gold line: where they have been" }, { label: "flags: what happened there" }, { label: "dots: where they are going" }, { label: "H hides or shows the lines" }] });
    }
    // every tab is there to click, its sections only the open one's
    return { sections: [...TABS.filter((t) => t !== tab).map((t) => ({ tab: t })), ...out].sort((a, b) => TABS.indexOf(a.tab) - TABS.indexOf(b.tab)) };
  }
  function paintWorld() {
    if (!sim) { worldEl.hidden = true; return; }
    const H = wui.open ? clamp(window.innerHeight / 2 - 40, 120, 340) | 0 : 21, B = new Buf(WW, H);
    B.c.fill(P.ink);
    for (let x = 1; x < WW - 1; x++) for (let y = 1; y < H - 1; y++) B.c[y * WW + x] = P.r4;
    const p = drawPanel(B, 3, 3, WW - 4, H - 4, worldData(), { tab: wui.open ? wui.tab : false, open: wui.fold, scroll: wui.scroll, hover: wui.hover });
    wui.scroll = p.scroll; wui.max = p.scrollMax; wui.hits = p.hits;
    paintBuf(worldEl, B);
    worldEl.hidden = false;
  }
  worldEl.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    const h = hitAt(wui.hits, artAt(worldEl, e));
    if (!h) return;
    if (h.tab != null) { if (wui.open && wui.tab === h.tab) wui.open = false; else { wui.open = true; wui.tab = h.tab; wui.scroll = 0; } }
    else if (h.toggle) { if (wui.fold.has(h.toggle)) wui.fold.delete(h.toggle); else wui.fold.add(h.toggle); }
    else if (h.link?.startsWith("@")) {
      // a graph's species: its list, unfolded
      const [tab, sp] = h.link.slice(1).split("|");
      wui.tab = tab; wui.scroll = 0; wui.fold.add(`animals|${sp}`);
    } else if (h.link) go(h.link);
    paintWorld();
  });
  worldEl.addEventListener("pointermove", (e) => {
    const p = artAt(worldEl, e), was = hitAt(wui.hits, wui.hover ?? { x: -1, y: -1 }), now = hitAt(wui.hits, p);
    wui.hover = p; worldEl.style.cursor = now ? "pointer" : "";
    if (was !== now) paintWorld();
  });
  worldEl.addEventListener("pointerleave", () => { wui.hover = null; paintWorld(); });
  worldEl.addEventListener("wheel", (e) => { e.preventDefault(); wui.scroll = clamp(wui.scroll + e.deltaY / 2, 0, wui.max); paintWorld(); }, { passive: false });

  // ---------- a tooltip in the game's font: what a person or animal under the pointer is at, or the event a path's flag
  // stands for ----------
  const tipEl = document.getElementById("tip");
  const when = (t) => { const h = ((t % 288) / 288) * 24; return `DAY ${Math.floor(t / 288) + 1} ${String(Math.floor(h)).padStart(2, "0")}:${String(Math.floor((h % 1) * 60)).padStart(2, "0")}`; };
  let tipAt = 0, tipKey = "";
  function tip(sx, sy) {
    let lines = null;
    const pin = live.pins().find((q) => Math.abs(q.x - sx) <= 8 && Math.abs(q.y - sy) <= 10);
    if (pin) lines = [when(pin.t), pin.text];
    else {
      const hit = live.pick(sx, sy, view);
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
  window.addEventListener("resize", () => { fitInsp(); if (inspData) paintInspector(); paintWorld(); });

  // ---------- pause and speed: a small marker in the corner while either is off the usual ----------
  let paceKey = "";
  function paintPace() {
    const key = !sim ? "" : sim.paused ? "PAUSED" : sim.speed !== 1 ? `X${sim.speed}` : "";
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

  // ---------- what draws the frames: WebGL2 on the GPU, and which, or the CPU and why, always in the corner ----------
  // a renderer's name in the 5x7 font: the device out of ANGLE's "(vendor, device, driver)", no trademarks
  const gpuName = (s) => {
    if (/swiftshader|llvmpipe|softpipe|software|basic render/i.test(s)) return "SOFTWARE, NO GPU: SLOW";
    const m = /^ANGLE \((.*)\)$/.exec(s), t = m ? (m[1].split(", ")[1] ?? m[1]) : s;
    return t.replace(/ANGLE \w+ Renderer: /i, "").replace(/\((R|TM)\)/gi, "").replace(/\s+/g, " ").trim().toUpperCase().replace(/[^A-Z0-9 .,:/-]/g, "").slice(0, 30);
  };
  let renderKey = "";
  function paintRender() {
    const r = live.renderer();
    const key = r.gpu ? `WEBGL2 ON - ${gpuName(r.name) || "GPU"}` : r.cause === "none" ? "NO WEBGL2 - CPU DRAWS, NO TURNING" : r.cause === "lost" ? "WEBGL2 LOST - CPU DRAWS" : "WEBGL2 FAILED - CPU DRAWS";
    if (key === renderKey) return;
    renderKey = key;
    const B = new Buf(key.length * 6 + 7, 13), [bg, lit] = r.gpu ? [P.g1, P.g3] : [P.f0, P.f1];
    B.c.fill(bg);
    for (let i = 0; i < B.w; i++) { B.c[i] = lit; B.c[(B.h - 1) * B.w + i] = P.ink; }
    text(B, key, 4, 3, P.snow);
    paintBuf(renderEl, B);
    renderEl.title = r.gpu ? `Drawn on the GPU through WebGL2: ${r.name}` : `Drawn on the CPU: ${r.why}`;
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
    if (pointers.size === 1) drag = { x0: e.clientX, y0: e.clientY, moved: 0, on: false };
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      camera.pinchStart((a.x + b.x) / 2, (a.y + b.y) / 2, Math.hypot(a.x - b.x, a.y - b.y), Math.atan2(b.y - a.y, b.x - a.x));
      pinching = true; drag = null; follow = null;
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
    if (!drag.on && drag.moved > 5) { drag.on = true; canvas.classList.add("dragging"); follow = null; camera.panBy(e.clientX - drag.x0, e.clientY - drag.y0); }
    else if (drag.on) camera.panBy(dx, dy);
  });
  const up = (e) => {
    if (orbit) { orbit = null; camera.settle(); return; }
    pointers.delete(e.pointerId);
    canvas.classList.remove("dragging");
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
    c.timer = setTimeout(() => { c.done = true; choose(hit, sx, sy); }, DBL_MS);
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
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") select(null);
    else if (e.key === "Tab" && sim?.w.agents.length) {
      e.preventDefault();
      const list = sim.w.agents, k = list.findIndex((a) => a.id === view.selected), n = list.length;
      select(list[((k < 0 ? (e.shiftKey ? 0 : -1) : k) + (e.shiftKey ? -1 : 1) + n) % n].id, true, "keep");
    }
    else if (e.key === " " && sim) { sim.paused = !sim.paused; e.preventDefault(); }
    else if ((e.key === "[" || e.key === "]") && sim) { const k = SPEEDS.indexOf(sim.speed); sim.speed = SPEEDS[clamp((k < 0 ? 2 : k) + (e.key === "]" ? 1 : -1), 0, SPEEDS.length - 1)]; }
    else if (e.key === "+" || e.key === "=" || e.key === "-") {
      const mid = follow ? [null, null] : [canvas.width / 2, canvas.height / 2];
      camera.zoomTo(Math.round(camera.goal) + (e.key === "-" ? -1 : 1), ...mid);
    }
    else if (e.key === "h" || e.key === "H") view.path = view.path === false;
    else if (e.key === "q" || e.key === "Q") camera.turnBy(-1);
    else if (e.key === "e" || e.key === "E") camera.turnBy(1);
  });
  setTimeout(() => hint.classList.add("gone"), 8000);
  globalThis.play = globalThis.nomads = { live, sim, view, camera, select, metrics, zoomTo: (g, sx, sy) => camera.zoomTo(g, sx, sy), turnBy: (d) => camera.turnBy(d), inspected: () => inspData, inspector: ui, world: wui, paintWorld };

  // Near targets are eased toward. A far one (a Tab to someone across the island) is baked first while the camera
  // holds, then cut to, so the close level never sits on a fallback.
  function followStep(now, dt) {
    const p = live.where(follow, sim, view);
    if (!p) { select(null); live.prefetch(null); return; }
    const upOf = (q) => q.y - live.camH(q.x, q.z), ahead = p.dx || p.dz ? [{ ...view, x: p.x + p.dx, z: p.z + p.dz, up: upOf(p), later: true }] : [];
    if (camera.offCentre(p) <= canvas.width * 0.35) {
      const iv = sim.paused || sim.alpha >= 1 ? Infinity : 500 / sim.speed;
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
  const bench = benchKind ? benchRunner(benchKind, live, view) : null;
  let revealed = false;
  function loop(now) {
    const dt = Math.min(100, now - lastNow);
    lastNow = now;
    // the world waits behind the loading line until the opening view is baked, so nothing is missed
    if (sim && revealed) {
      const ch = sim.update(now);
      if (ch) { live.changed(ch); if (view.selected) inspect(); if (wui.open) paintWorld(); }
    }
    if (revealed && bench) bench.step(now);
    camera.step(dt, now);
    if (follow && sim) followStep(now, dt);
    else live.prefetch(null);
    // the ground under the opening shot is only exact once its chunks are in, so keep it centred until then
    if (!revealed && opening) camera.lookAt(live.where(opening, sim, view));
    camera.guard();
    // a zoom's destination bakes first, so a quick zoom across several levels lands on baked ground
    live.goal = camera.goalView();
    const r = live.frame(view, sim, { show: revealed });
    if (!revealed) {
      // every bearing of the opening view, so the first turns land on baked ground; the load can take its time. With
      // ?adj=0 nothing bakes the other bearings, so only this one.
      const rd = { done: 0, all: 0 };
      for (const b of Q.get("adj") === "0" ? [view.bearing] : [0, 1, 2, 3, 4, 5, 6, 7]) { const q = live.readiness(view, b); rd.done += q.done; rd.all += q.all; }
      rd.ready = rd.done === rd.all;
      if (rd.ready && !r.holes) {
        revealed = true;
        metrics.revealMs = Math.round(performance.now() - t0);
        paintWorld();
        // follow the settlement's person only if they are in this frame
        if (openingPerson && !bench && live.picks().some((p) => p.id === openingPerson)) select(openingPerson, false);
      } else loadingScreen(canvas, `baking the view from every side ${rd.done}/${rd.all}`, rd.done / rd.all);
    }
    if (tabWatch) {
      const dt2 = now - tabWatch.last;
      tabWatch.last = now;
      if (r.holes) tabWatch.hole += dt2;
      if (now - tabWatch.t0 > 6000) { metrics.tabs.push({ holeMs: Math.round(tabWatch.hole), cutMs: Math.round(tabWatch.cutAt) }); tabWatch = null; }
    }
    if (revealed) { paintPace(); paintClock(); }
    paintRender();
    if (!readyMarked && revealed && !bench) { readyMarked = true; document.body.dataset.firstFrame = String(Math.round(performance.now() - t0)); document.body.classList.add("ready"); }
    if (showStats && now - lastStats > 250) {
      lastStats = now;
      const s = live.stats, c = sim?.clock(), lf = live.level;
      statsEl.textContent = [
        `fps ${s.fps.toFixed(0)}  frame ${s.composeMs.toFixed(1)} ms  slots ${s.slots}`,
        `bake queue ${s.bakeQueue}  baked ${s.bakedChunks}  avg ${s.bakeMsAvg.toFixed(0)} ms`,
        `heap ${s.memMB} MB  chunks ${s.cacheMB ?? 0} MB  workers ${s.workers}`,
        `zoom ${view.zoom.toFixed(2)} ${live.levels[lf?.L ?? 0].name} x${(lf?.s ?? 0).toFixed(2)}  bearing ${view.bearing.toFixed(2)}`,
        sim ? `day ${c.day} ${String(Math.floor(c.hour)).padStart(2, "0")}:${String(Math.floor((c.hour % 1) * 60)).padStart(2, "0")}  x${sim.speed}${sim.paused ? " paused" : ""}  tick ${sim.tickMs.toFixed(1)} ms` : "no sim",
      ].join("\n");
    }
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);

  // ?bench=zoom | orbit | turn | pan: drive the camera and record frame rate and frame cost, for the report.
  function benchRunner(kind, live, view) {
    const secs = num("benchs", 12, 1, 600), out = { kind, samples: [] };
    let start = 0, done = false, base = null, lastT = 0, k = 0;
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
      delete out.samples;
      document.body.dataset.bench = JSON.stringify(out);
      document.body.classList.add("ready");
      done = true;
    };
    return {
      step(now) {
        if (done) return;
        if (!start) { start = now; base = { x: view.x, z: view.z, bearing: view.bearing }; lastT = now; }
        const t = (now - start) / 1000, f = Math.min(1, t / secs);
        if (lastT !== now) out.samples.push({ dt: now - lastT, ms: live.lastMs, holes: live.lastHoles, slots: live.stats.slots, z: +view.zoom.toFixed(2), parts: live.lastParts });
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

main().catch(fail);
