// Watch an island being made: the game's own generator runs in a worker and posts each stage as it makes it (bedrock,
// fifty steps of uplift against erosion, the ice, rain, warmth and snow, water, soil and what grows), and this page plays
// them back at a pace a person can follow. ?seed= picks the island, ?speed= the pace (1 is the default).
import { N, CELL } from "../island.js";

const Q = new URLSearchParams(location.search);
let seed = Math.trunc(Number(Q.get("seed") ?? 1)) || 1;
const SPEED = Math.max(0.1, Number(Q.get("speed") ?? 1) || 1);
const canvas = document.getElementById("map"), ctx = canvas.getContext("2d");
const $ = (id) => document.getElementById(id);
const S = canvas.width / N; // screen px per cell
const off = new OffscreenCanvas(N, N), octx = off.getContext("2d"), img = octx.createImageData(N, N);

// ---------- colour ----------
const lerp = (a, b, t) => a + (b - a) * t;
const mix = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
function ramp(stops, v) {
  if (v <= stops[0][0]) return stops[0][1];
  for (let k = 1; k < stops.length; k++) if (v <= stops[k][0]) return mix(stops[k - 1][1], stops[k][1], (v - stops[k - 1][0]) / (stops[k][0] - stops[k - 1][0]));
  return stops.at(-1)[1];
}
const LAND = [[0, [86, 120, 64]], [60, [110, 138, 74]], [180, [146, 140, 96]], [350, [160, 150, 140]], [560, [226, 226, 222]]];
const SEA = [[0, [52, 104, 150]], [8, [34, 76, 128]], [40, [22, 46, 92]], [80, [16, 30, 66]]];
const ROCK = [[118, 104, 92], [176, 140, 96], [204, 196, 176], [170, 142, 138], [80, 78, 76]];
const ROCK_NAMES = ["mudstone", "sandstone", "limestone", "granite", "basalt"];
const COVER = { tree: [38, 68, 44], shrub: [118, 84, 104], grass: [112, 142, 66], marsh: [80, 98, 60], bare: [150, 140, 120], sand: [222, 204, 152] };

// Light from the north-west over the ground's slope, in meters.
function shadeOf(h, i) {
  const x = i % N, y = (i - x) / N, at = (a, b) => Math.max(0, h[clamp(b, 0, N - 1) * N + clamp(a, 0, N - 1)]);
  const gx = (at(x + 1, y) - at(x - 1, y)) / (2 * CELL), gy = (at(x, y + 1) - at(x, y - 1)) / (2 * CELL);
  const l = (0.6 * gx + 0.6 * gy + 0.53) / Math.hypot(gx, gy, 1);
  return clamp(0.35 + 1.2 * l, 0.35, 1.35);
}
// Paint the map: land coloured by colour(i, h) (default: by height) and shaded, the sea and lakes by depth.
function paint(h, { wet, colour, plain } = {}) {
  const d = img.data;
  for (let i = 0; i < N * N; i++) {
    const depth = wet ? wet[i] : Math.max(0, -h[i]);
    let c;
    if (depth > 0 || h[i] <= 0) c = ramp(SEA, h[i] <= 0 ? -h[i] : depth + 2);
    else {
      c = colour ? colour(i, h[i]) : ramp(LAND, h[i]);
      if (!plain) { const s = shadeOf(h, i); c = [c[0] * s, c[1] * s, c[2] * s]; }
    }
    d[i * 4] = c[0]; d[i * 4 + 1] = c[1]; d[i * 4 + 2] = c[2]; d[i * 4 + 3] = 255;
  }
  octx.putImageData(img, 0, 0);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(off, 0, 0, canvas.width, canvas.height);
}
const at = (x, y) => [(x + 0.5) * S, (y + 0.5) * S];
function rivers(list, quick) {
  const low = Math.min(...quick);
  ctx.lineCap = "round";
  for (const line of list)
    for (let k = 1; k < line.length; k++) {
      const p = line[k], q = p[2] * (p[3] + (1 - p[3]) * low);
      ctx.strokeStyle = q >= 0.004 ? "rgb(70,150,235)" : "rgba(230,214,140,0.9)";
      ctx.lineWidth = Math.max(1, Math.min(4, 1 + Math.sqrt(p[4]) * 2.2));
      ctx.beginPath(); ctx.moveTo(...at(line[k - 1][0], line[k - 1][1])); ctx.lineTo(...at(p[0], p[1])); ctx.stroke();
    }
}
function springs(list) {
  for (const [x, y] of list) { ctx.fillStyle = "#ff5a4a"; ctx.beginPath(); ctx.arc(...at(x, y), 3, 0, Math.PI * 2); ctx.fill(); ctx.strokeStyle = "#2a0a08"; ctx.lineWidth = 1; ctx.stroke(); }
}
function windArrow(wind) {
  const cx = canvas.width - 70, cy = 70, L = 40, [dx, dy] = wind;
  ctx.strokeStyle = "#eef2f6"; ctx.fillStyle = "#eef2f6"; ctx.lineWidth = 3;
  ctx.beginPath(); ctx.moveTo(cx - dx * L, cy - dy * L); ctx.lineTo(cx + dx * L, cy + dy * L); ctx.stroke();
  const a = Math.atan2(dy, dx);
  ctx.beginPath(); ctx.moveTo(cx + dx * L, cy + dy * L); ctx.lineTo(cx + dx * L - 12 * Math.cos(a - 0.5), cy + dy * L - 12 * Math.sin(a - 0.5)); ctx.lineTo(cx + dx * L - 12 * Math.cos(a + 0.5), cy + dy * L - 12 * Math.sin(a + 0.5)); ctx.fill();
  ctx.font = "12px ui-monospace, monospace"; ctx.fillText("prevailing wind", cx - 52, cy + 58);
}
function legend(items) {
  ctx.font = "12px ui-monospace, monospace";
  items.forEach(([name, c], k) => { ctx.fillStyle = `rgb(${c.map(Math.round).join(",")})`; ctx.fillRect(12, 50 + k * 18, 12, 12); ctx.fillStyle = "#eef2f6"; ctx.fillText(name, 30, 60 + k * 18); });
}

// ---------- the shots ----------
// Each stage the worker posts becomes one or more shots: what to draw, a title and caption, and how long to hold it.
let shots = [], peak = 0, rawTop = 1, erosion = [];
const STAGES = ["bedrock", "erosion", "ice", "rain", "warmth", "snow", "water", "soil", "fertility", "plants"];
function take(s) {
  if (s.stage === "rock") {
    shots.push({ group: "bedrock", hold: 3500, title: "Bedrock", caption: "Two fields laid down together under the island: how hard the rock is, and whether it weathers to bases. Soft mudstone, sandstone, limestone, hard granite and basalt. The brighter, the harder the island will be pushed up there.", draw: () => {
      paint(s.lift, { plain: true, wet: Float32Array.from(s.lift, (v) => (v > 0.002 ? 0 : 1)), colour: (i) => mix([20, 18, 28], ROCK[s.rock[i]], clamp(0.35 + s.lift[i] * 2.2, 0, 1)) });
      legend(ROCK_NAMES.map((n, k) => [n, ROCK[k]]));
    } });
  } else if (s.stage === "erode") erosion.push(s);
  else if (s.stage === "ice") {
    for (const h of s.height) peak = Math.max(peak, h);
    rawTop = Math.max(...erosion.at(-1).height);
    for (const e of erosion) {
      const metres = Float32Array.from(e.height, (v) => (v > 0 ? (v / rawTop) * peak : Math.max(-60, v * 1200)));
      shots.push({ group: "erosion", hold: 140, title: `Uplift against erosion, step ${e.step + 1} of ${e.steps}`, caption: "The land rises a little each step. Streams cut down by the water they carry (the rain that runs off, more on the heights and less off rock that soaks it in), and slopes creep smooth, each rock at its own pace: hard rock is left standing as the ranges.", draw: () => {
        paint(metres);
        const lim = 40 + (e.step / e.steps) * 80;
        ctx.fillStyle = "rgba(90,170,240,0.85)";
        for (let i = 0; i < N * N; i++) if (e.flow[i] > lim && metres[i] > 0) { const x = i % N, y = (i - x) / N; ctx.fillRect(x * S, y * S, S, S); }
      } });
    }
    shots.at(-1).hold = 1600;
    shots.push({ group: "ice", hold: 3500, title: "Ice", caption: "The last cold age's glaciers scoured the big valleys into troughs, deep over soft rock and hardly at all over hard, which they left standing as sills across the valley floors. The pale blue is how deep they cut.", draw: () => {
      paint(s.height, { colour: (i, h) => mix(ramp(LAND, h), [200, 228, 245], clamp(s.trough[i] / 30, 0, 0.85)) });
    } });
  } else if (s.stage === "climate") {
    // each map spans its own island's range over the land, from the 5th to the 95th percentile, its middle at the median
    const span = (f) => { const v = []; for (let i = 0; i < N * N; i++) if (s.height[i] > 0) v.push(f[i]); v.sort((a, b) => a - b); return [v[Math.floor(v.length * 0.05)], v[Math.floor(v.length * 0.95)], v[Math.floor(v.length / 2)]]; };
    const [p0, p1, pm] = span(s.precip), [t0, t1] = span(s.temp), mm = (v) => Math.round(v / 10) * 10;
    shots.push({ group: "rain", hold: 3500, title: "Rain", caption: `Air off the sea from every direction, most from the prevailing one, rises over the hills, cools and rains out; behind them it sinks and dries. Pale is the driest ground, ${mm(p0)} mm a year; deep blue the wettest, ${mm(p1)} mm; most of it gets about ${mm(pm)}.`, draw: () => {
      paint(s.height, { colour: (i) => ramp([[p0, [214, 196, 140]], [pm, [150, 180, 150]], [p1, [40, 90, 170]]], s.precip[i]) });
      windArrow(s.wind);
    } });
    shots.push({ group: "warmth", hold: 3000, title: "Warmth", caption: `The year's mean air: colder with height, milder by the coast where the sea air blows in, warmer on slopes that face the sun, and colder in hollows where the night's cold air pools. Blue is ${t0.toFixed(1)} C, orange ${t1.toFixed(1)} C.`, draw: () => {
      paint(s.height, { colour: (i) => ramp([[t0, [90, 120, 210]], [t0 + (t1 - t0) * 0.45, [140, 190, 170]], [t0 + (t1 - t0) * 0.75, [230, 210, 120]], [t1, [230, 130, 70]]], s.temp[i]) });
    } });
    shots.push({ group: "snow", hold: 3000, title: "Snow", caption: "A year of days through the seasons: snow lies where the winter stays cold enough, inland and up high, and never on the mild coasts. The whiter, the longer it lies.", draw: () => {
      paint(s.height, { colour: (i, h) => mix(ramp(LAND, h), [250, 252, 255], clamp(s.snow[i] * 4, 0, 1)) });
    } });
  } else if (s.stage === "water") {
    shots.push({ group: "water", hold: 5000, title: "Water", caption: "The rain the plants leave soaks into the rock as far as the rock lets it and runs off for the rest. Groundwater comes out in springs (red) and through stream beds, which keeps those streams running all summer (blue); the others run only in the wet seasons (yellow). Lakes lie behind the ice's sills. Teal ground is where the water table reaches the surface.", draw: () => {
      paint(s.height, { wet: s.water, colour: (i, h) => mix(ramp(LAND, h), [60, 140, 130], s.table[i] < 0.3 ? 0.55 : 0) });
      rivers(s.rivers, s.quick); springs(s.springs);
    } });
    shots.water = s;
  } else if (s.stage === "soil") {
    const w = shots.water;
    shots.push({ group: "soil", hold: 3500, title: "Soil: acidity", caption: "The soil is the rock's weathering, with silt on the valley floors. Rain the year doesn't evaporate leaches it sour (orange) unless the rock keeps replacing its bases, as limestone and basalt do (teal).", draw: () => {
      paint(s.height, { wet: s.water, colour: (i) => ramp([[4, [214, 110, 60]], [5.5, [214, 190, 110]], [6.5, [150, 180, 120]], [7.8, [60, 160, 160]]], s.ph[i]) });
      if (w) rivers(w.rivers, w.quick);
    } });
    shots.push({ group: "fertility", hold: 3000, title: "Soil: fertility", caption: "What roots can take from it: the rock's nourishment, or the silt's, as far as acidity, humus, depth and waterlogging allow.", draw: () => {
      paint(s.height, { wet: s.water, colour: (i) => ramp([[0, [150, 120, 90]], [0.15, [170, 160, 100]], [0.4, [90, 150, 70]], [0.7, [40, 110, 50]]], s.fertility[i]) });
      if (w) rivers(w.rivers, w.quick);
    } });
  } else if (s.stage === "cover") {
    const w = shots.water;
    shots.push({ group: "plants", hold: 6000, title: "What grows", caption: "Every plant where it fits: woods where it is warm, moist and deep enough, heath (purple) on thin, sour or wind-scoured ground, grass where it is too dry or thin for trees, marsh where the ground never drains. Nothing is drawn by hand.", draw: () => {
      paint(s.height, { wet: s.water, colour: (i) => {
        let c = [0, 0, 0], sum = 0;
        for (const k of ["tree", "shrub", "grass", "marsh", "bare"]) { const v = s[k][i]; sum += v; c = [c[0] + COVER[k][0] * v, c[1] + COVER[k][1] * v, c[2] + COVER[k][2] * v]; }
        c = sum > 0 ? c.map((v) => v / sum) : COVER.bare;
        return mix(c, COVER.sand, s.sand[i]);
      } });
      if (w) rivers(w.rivers, w.quick);
      legend([["woods", COVER.tree], ["heath", COVER.shrub], ["grass", COVER.grass], ["marsh", COVER.marsh], ["bare", COVER.bare], ["sand", COVER.sand]]);
    } });
  }
  buttons();
}

// ---------- playback ----------
let at0 = 0, k = 0, paused = false, timer = 0, made = 0;
function show(n) {
  k = n;
  const s = shots[k];
  if (!s) return;
  s.draw();
  $("title").textContent = s.title;
  $("caption").textContent = s.caption;
  buttons();
}
function tick() {
  clearTimeout(timer);
  if (paused) return;
  if (k < shots.length - 1) { show(k + 1); timer = setTimeout(tick, shots[k].hold / SPEED); $("bar").style.width = `${(100 * (k + 1)) / Math.max(shots.length, 1)}%`; }
  else if (!done) timer = setTimeout(tick, 200);
  else { $("bar").style.width = "100%"; $("pause").textContent = "pause"; }
}
function buttons() {
  const box = $("stages"), cur = shots[k]?.group;
  box.replaceChildren(...STAGES.map((g) => {
    const b = document.createElement("button"), first = shots.findIndex((s) => s.group === g);
    b.textContent = g; b.disabled = first < 0; b.className = g === cur ? "on" : "";
    b.onclick = () => { show(first); clearTimeout(timer); if (!paused) timer = setTimeout(tick, shots[first].hold / SPEED); };
    return b;
  }));
}
let done = false, worker = null;
function grow() {
  worker?.terminate();
  shots = []; erosion = []; peak = 0; k = -1; done = false; made = performance.now();
  $("seed").textContent = `island ${seed}`;
  $("title").textContent = "growing the island…"; $("caption").textContent = ""; $("bar").style.width = "0";
  history.replaceState(null, "", `?seed=${seed}${SPEED !== 1 ? `&speed=${SPEED}` : ""}`);
  worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
  worker.onmessage = (e) => {
    if (e.data.stage === "done") { done = true; window.genesis.ms = Math.round(e.data.ms); return; }
    const first = shots.length === 0;
    take(e.data);
    if (first && shots.length) { k = -1; tick(); }
  };
  worker.postMessage({ seed });
}
$("pause").onclick = () => { paused = !paused; $("pause").textContent = paused ? "play" : "pause"; if (!paused) tick(); };
$("replay").onclick = () => { paused = false; $("pause").textContent = "pause"; k = -1; tick(); };
$("next").onclick = () => { seed = Math.floor(Math.random() * 1e6); paused = false; grow(); };
addEventListener("keydown", (e) => { if (e.key === " ") $("pause").click(); else if (e.key === "ArrowRight") show(Math.min(shots.length - 1, k + 1)); else if (e.key === "ArrowLeft") show(Math.max(0, k - 1)); });
window.genesis = { get shot() { return shots[k]?.title; }, get shots() { return shots.length; }, get done() { return done; }, ms: 0 };
grow();
