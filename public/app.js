import {
  T, buildBase, readTerrain, isoView, eachTile, drawTile, drawSlab, drawMarks, drawThing, drawFire, drawFlames, drawSmoke, drawToken, drawLabel,
  drawThinking, drawSleep, drawAnimal, drawTrapped, drawIce, drawPaths, drawRain, drawSnow, drawBolt, thingSpot, hash, flameRgb,
} from "./art.js";

const $ = (s) => document.querySelector(s);
const DAY = 288;
const NEEDS = ["food", "energy", "warmth", "social", "health"];
const GOLD = new Set(["invent", "law", "burned", "named", "arrive", "born", "died", "camp", "custom", "leader", "driven_out"]);
const NOTABLE = new Set(["discover", "learn", "teach", "attack", "wolf", "defend", "hazard", "ruin", "hunt", "sick", "collapse", "build", "bond", "steal", "lie", "take", "insult", "break", "lightning", "death", "mistaken", "pregnant", "trap", "claim", "throw", "grief", "dig", "judged", "camp_change", "camp_named", "custom_faded", "shared_store", "beg"]);
const ROUTINE = new Set(["gather", "eat", "goal", "stuck", "fail", "tinker", "craft", "fire_out", "fire_spread", "wake", "level", "spoil", "grow", "birth", "weather", "season", "recover", "notice", "store"]);

const S = {
  W: 0, H: 0, tiles: "", heights: null, land: null, things: new Map(), byTile: new Map(), hot: new Set(), graves: new Set(), caught: new Set(),
  agents: new Map(), animals: new Map(), people: new Map(),
  kinds: {}, weather: null, paths: null, ice: null, t: 0, jev: null, control: { paused: false, speed: 1 }, groups: [],
};
const cam = { x: 32, y: 32, s: 10 };
// picked: a non-person the focus card is showing, { type: "animal" | "grave", id }.
let selected = null, picked = null, hoverGrave = null, follow = false, filter = null, tickMs = 500, lastTickAt = performance.now(), flash = null;
const calm = matchMedia("(prefers-reduced-motion: reduce)");
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const human = (s) => (s ?? "").replaceAll("_", " ");
const cap = (t) => (t ? t[0].toUpperCase() + t.slice(1) : "");
const personOf = (id) => S.agents.get(id) ?? S.people.get(id) ?? null;
const nameOf = (id) => personOf(id)?.name ?? id;
const kindName = (id) => S.kinds[id]?.name ?? human(id);
const dayOf = (t) => Math.floor(t / DAY) + 1;
const hhmm = (t) => {
  const mins = Math.floor(((t % DAY) / DAY) * 24 * 60);
  return `${String(Math.floor(mins / 60)).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}`;
};
const clockText = (t) => `Day ${dayOf(t)}, ${hhmm(t)}`;
const nightAmount = (t) => {
  const h = ((t % DAY) / DAY) * 24;
  if (h >= 21 || h < 4) return 1;
  if (h >= 19) return (h - 19) / 2;
  if (h < 6) return 1 - (h - 4) / 2;
  return 0;
};
const seal = (a, size = "") => `<span class="seal ${size}${a.alive === false ? " dead" : ""}" style="--c:${a.color}" aria-hidden="true">${esc(a.name[0])}</span>`;
const sealOf = (id, size) => { const p = personOf(id); return p ? seal(p, size) : ""; };
const isDead = (id) => !S.agents.has(id) && S.people.get(id)?.alive === false;
let peopleLoading = false, peopleAgain = false;
// Everyone who ever lived, for names and seals of the dead. Refetched when the living roster changes.
function loadPeople() {
  if (peopleLoading) { peopleAgain = true; return; }
  peopleLoading = true;
  fetch("api/people").then((r) => r.json()).then((list) => {
    S.people = new Map((Array.isArray(list) ? list : []).map((p) => [p.id, p]));
    renderFilters(); renderFocus();
    if (sheetOpen() && !$("#inspect").hidden) renderInspector();
  }).catch(() => {}).finally(() => {
    peopleLoading = false;
    if (peopleAgain) { peopleAgain = false; loadPeople(); }
  });
}
const ageText = (a) => [a.age != null ? `Age ${Math.floor(a.age)}` : "", a.stage ?? ""].filter(Boolean).join(", ");
const X_ICON = `<svg viewBox="0 0 24 24" width="18" height="18"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>`;
const SICK = `<span class="sick" role="img" aria-label="Sick" title="Sick"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 13.6V5a2 2 0 0 1 4 0v8.6a4 4 0 1 1-4 0z"/><path d="M12 9v7.5"/></svg></span>`;

// ---------- world things ----------
const isHome = (th) => th.kind === "structure" && !!th.owner && (th.shelter?.tier ?? 0) >= 1;
// drawn live every frame: fires, lit or out, and anything alight (its blaze, inspect.ts Blaze)
const isHot = (th) => th.kind === "fire" || !!th.blaze;
const TIER = ["pile", "lean-to", "hut", "cabin"], TENT = ["pile", "lean-to", "tent", "lodge"];
const STYLE_WORD = { sticks: "stick", reeds: "reed", logs: "log", planks: "plank", stone: "stone", brick: "brick", hide: "hide", clay: "clay" };
const shelterName = (sh) => [STYLE_WORD[sh?.style], (sh?.style === "hide" ? TENT : TIER)[sh?.tier ?? 1] ?? "shelter"].filter(Boolean).join(" ");
function homeOf(id) {
  let best = null;
  for (const th of S.things.values()) if (isHome(th) && th.owner === id && (!best || th.shelter.tier > best.shelter.tier)) best = th;
  return best;
}
const prop = (k, p) => k?.props?.[p] ?? 0;
const CATEGORIES = ["Tools", "Food", "Containers", "Materials"];
function category(k) {
  if (prop(k, "edible") >= 0.3) return "Food";
  if (prop(k, "container") >= 0.3) return "Containers";
  if (prop(k, "binding") >= 0.3) return "Materials";
  if (prop(k, "sharp") >= 0.3 || prop(k, "long") >= 0.4 || prop(k, "hard") >= 0.6) return "Tools";
  return "Materials";
}

// ---------- map layer ----------
// base: the painted top-down ground. ground: base with ice and trampled paths on it. layer: ground laid over the
// isometric terrain, then every glyph standing on it, back to front.
let base = null, iceLow = null, marks = [], view = null;
const ground = document.createElement("canvas"), gctx = ground.getContext("2d");
const layer = document.createElement("canvas"), lctx = layer.getContext("2d");
function indexThing(th, add) {
  const k = `${th.x},${th.y}`;
  if (!S.byTile.has(k)) S.byTile.set(k, new Set());
  if (add) S.byTile.get(k).add(th.id); else S.byTile.get(k).delete(th.id);
}
function putThing(th) {
  const old = S.things.get(th.id);
  if (old) indexThing(old, false);
  S.things.set(th.id, th); indexThing(th, true);
  if (isHot(th)) S.hot.add(th.id); else S.hot.delete(th.id);
  if (th.kind === "grave") S.graves.add(th.id); else S.graves.delete(th.id);
  if (th.kind === "trap" && th.caught) S.caught.add(th.id); else S.caught.delete(th.id);
}
function dropThing(id) {
  const th = S.things.get(id);
  if (!th) return null;
  indexThing(th, false); S.things.delete(id); S.hot.delete(id); S.graves.delete(id); S.caught.delete(id);
  return th;
}
function paintGround(x0, y0, x1, y1) {
  x0 = Math.max(0, x0); y0 = Math.max(0, y0); x1 = Math.min(S.W - 1, x1); y1 = Math.min(S.H - 1, y1);
  const px = x0 * T, py = y0 * T, w = (x1 - x0 + 1) * T, h = (y1 - y0 + 1) * T;
  gctx.save();
  gctx.beginPath(); gctx.rect(px, py, w, h); gctx.clip();
  gctx.drawImage(base, px, py, w, h, px, py, w, h);
  drawIce(gctx, iceLow, S.ice, S.tiles, S.W, S.H, x0, y0, x1, y1);
  drawPaths(gctx, S.paths, S.W, S.H, x0, y0, x1, y1);
  gctx.restore();
}
// Layer pixels the ground of a block of tiles covers.
function tileRect(x0, y0, x1, y1) {
  const r = [Infinity, Infinity, -Infinity, -Infinity];
  for (let y = Math.max(0, y0); y <= Math.min(S.H, y1 + 1); y++)
    for (let x = Math.max(0, x0); x <= Math.min(S.W, x1 + 1); x++) {
      const [px, py] = view.at(x, y);
      r[0] = Math.min(r[0], px); r[1] = Math.min(r[1], py); r[2] = Math.max(r[2], px); r[3] = Math.max(r[3], py);
    }
  return r;
}
// Glyphs spill over their tile, so repaint everywhere a glyph on tile (x, y) can reach.
function glyphRect(x, y) {
  const [px, py] = view.at(x + 0.5, y + 0.5);
  return [px - T * 1.2, py - T * 1.8, px + T * 1.2, py + T];
}
// Repaint a rect of the layer: terrain, the cut edge, grass and rock marks, then every glyph reaching into it.
function paint(r) {
  const x0 = Math.floor(r[0]), y0 = Math.floor(r[1]), w = Math.ceil(r[2]) - x0, h = Math.ceil(r[3]) - y0;
  lctx.save();
  lctx.beginPath(); lctx.rect(x0, y0, w, h); lctx.clip();
  lctx.clearRect(x0, y0, w, h);
  eachTile(view, r, 2, (x, y) => drawTile(lctx, ground, view, x, y));
  drawSlab(lctx, view, S.tiles);
  drawMarks(lctx, marks, view, r, S.paths);
  const list = [];
  eachTile(view, r, T * 2, (x, y) => {
    for (const id of S.byTile.get(`${x},${y}`) ?? []) {
      const th = S.things.get(id);
      if (th && th.kind !== "fire") list.push([...thingSpot(th), th]);
    }
  });
  list.sort((a, b) => a[0] + a[1] - b[0] - b[1] || a[0] - b[0]);
  for (const [u, v, th] of list) {
    const [px, py] = view.at(u, v);
    lctx.save();
    lctx.translate(px - u * T, py - v * T);
    drawThing(lctx, th, isHome(th) || th.kind === "trap" ? personOf(th.owner)?.color : null, S.kinds);
    lctx.restore();
  }
  lctx.restore();
}
function buildLayer() {
  view = isoView(S.heights, S.W, S.H);
  ({ base, ice: iceLow, marks } = buildBase(view, S.land));
  ground.width = S.W * T; ground.height = S.H * T;
  paintGround(0, 0, S.W - 1, S.H - 1);
  layer.width = view.width; layer.height = view.height;
  paint([0, 0, layer.width, layer.height]);
}
function parsePaths(str, n) {
  const a = new Uint8Array(n);
  if (str) for (let i = 0; i < n; i++) a[i] = Math.max(0, Math.min(9, (str.charCodeAt(i) || 48) - 48));
  return a;
}
function parseIce(str, n) {
  const a = new Uint8Array(n);
  if (str) for (let i = 0; i < n; i++) a[i] = str[i] === "1" ? 1 : 0;
  return a;
}
// Tick sends the full frozen list; repaint only tiles that changed, or everything on a big thaw or freeze.
function setIce(list) {
  const next = new Uint8Array(S.W * S.H);
  for (const i of list) if (i >= 0 && i < next.length) next[i] = 1;
  const changed = [];
  for (let i = 0; i < next.length; i++) if (next[i] !== S.ice?.[i]) changed.push(i);
  S.ice = next;
  if (changed.length > 300) { paintGround(0, 0, S.W - 1, S.H - 1); return paint([0, 0, layer.width, layer.height]); }
  for (const i of changed) {
    const x = i % S.W, y = Math.floor(i / S.W);
    paintGround(x, y, x, y); paint(tileRect(x, y, x, y));
  }
}

// ---------- rendering ----------
const canvas = $("#map");
const ctx = canvas.getContext("2d");
let dpr = 1, cw = 0, ch = 0;
function resize() {
  dpr = window.devicePixelRatio || 1;
  cw = canvas.clientWidth; ch = canvas.clientHeight;
  canvas.width = cw * dpr; canvas.height = ch * dpr;
}
// The camera looks at a point of the layer measured in T pixels, and cam.s is screen pixels per T.
const toPlane = (u, v, z) => { const [lx, ly] = view.at(u, v, z); return [lx / T, ly / T]; };
// Screen position of a ground point given in tiles, standing on the terrain unless a height is given.
const toScreen = (u, v, z) => { const [x, y] = toPlane(u, v, z); return [(x - cam.x) * cam.s + cw / 2, (y - cam.y) * cam.s + ch / 2]; };
const screenToPlane = (px, py) => [(px - cw / 2) / cam.s + cam.x, (py - ch / 2) / cam.s + cam.y];
function lerpPos(a) {
  const k = Math.min(1, (performance.now() - lastTickAt) / tickMs);
  return [a.px + (a.x - a.px) * k + 0.5, a.py + (a.y - a.py) * k + 0.5];
}

function frame(now) {
  if (selected && follow) {
    const a = S.agents.get(selected);
    if (a) {
      const [x, y] = toPlane(...lerpPos(a));
      cam.x += (x + rightCover() / 2 / cam.s - cam.x) * 0.2;
      cam.y += (y + bottomCover() / 2 / cam.s - cam.y) * 0.2;
      clampCam();
    }
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = "#1d1610";
  ctx.fillRect(0, 0, cw, ch);
  if (base) {
    const k = cam.s / T, ox = cw / 2 - cam.x * cam.s, oy = ch / 2 - cam.y * cam.s;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(layer, ox, oy, layer.width * k, layer.height * k);
    const night = nightAmount(S.t);
    tint(ox, oy, k, night);
    drawCamps();
    drawHot(now, night);
    drawAnimals(now);
    drawAgents(now);
    drawGraveLabel();
    drawWeather(now);
  }
  requestAnimationFrame(frame);
}

// Season, sky and night washes over the land, in that order, then an ink line around the map.
function tint(ox, oy, k, night) {
  const wx = S.weather;
  ctx.save();
  ctx.setTransform(dpr * k, 0, 0, dpr * k, dpr * ox, dpr * oy);
  ctx.save();
  ctx.clip(view.outline);
  const wash = (op, col) => { ctx.globalCompositeOperation = op; ctx.fillStyle = col; ctx.fillRect(0, 0, layer.width, layer.height); };
  if (wx?.season === "winter") wash("source-over", "rgba(238, 243, 251, .26)");
  else if (wx?.season === "autumn") wash("multiply", "rgba(255, 206, 150, .32)");
  if (wx?.drought) wash("multiply", "rgba(255, 232, 170, .25)");
  const sky = { cloudy: "rgba(190, 192, 202, .28)", rain: "rgba(150, 160, 178, .42)", storm: "rgba(100, 108, 132, .62)" }[wx?.sky];
  if (sky) wash("multiply", sky);
  if (night > 0) wash("multiply", `rgba(70, 82, 140, ${0.75 * night})`);
  ctx.restore();
  ctx.strokeStyle = "rgba(58, 42, 26, .9)"; ctx.lineWidth = 2 / k; ctx.stroke(view.outline);
  ctx.restore();
}

// ---------- camps on the map ----------
// A faint inked boundary around each camp's homes: the edge of a smooth blob around them, traced once per layout.
const campShapes = new Map();
function campShape(camp) {
  const key = camp.homes.map((h) => h.join(",")).join(";");
  const hit = campShapes.get(camp.id);
  if (hit?.key === key) return hit;
  const R = 3.4, G = 0.5, xs = camp.homes.map((h) => h[0] + 0.5), ys = camp.homes.map((h) => h[1] + 0.5);
  const x0 = Math.min(...xs) - R - 1, y0 = Math.min(...ys) - R - 1;
  const nx = Math.ceil((Math.max(...xs) + R + 1 - x0) / G), ny = Math.ceil((Math.max(...ys) + R + 1 - y0) / G);
  const v = new Float32Array((nx + 1) * (ny + 1));
  for (let j = 0; j <= ny; j++)
    for (let i = 0; i <= nx; i++) {
      let f = 0;
      for (let k = 0; k < xs.length; k++) f += (R * R) / ((x0 + i * G - xs[k]) ** 2 + (y0 + j * G - ys[k]) ** 2 + 0.01);
      v[j * (nx + 1) + i] = f - 1;
    }
  // Marching squares, then chain the little segments into lines so the dashes run on.
  const at = (i, j) => v[j * (nx + 1) + i], cut = (a, b) => a / (a - b), segs = [];
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++) {
      const a = at(i, j), b = at(i + 1, j), c = at(i + 1, j + 1), d = at(i, j + 1), p = [];
      if (a > 0 !== b > 0) p.push([i + cut(a, b), j]);
      if (b > 0 !== c > 0) p.push([i + 1, j + cut(b, c)]);
      if (c > 0 !== d > 0) p.push([i + 1 - cut(c, d), j + 1]);
      if (d > 0 !== a > 0) p.push([i, j + 1 - cut(d, a)]);
      for (let k = 0; k + 1 < p.length; k += 2) segs.push([p[k], p[k + 1]]);
    }
  const id = (q) => `${q[0].toFixed(2)},${q[1].toFixed(2)}`, ends = new Map();
  segs.forEach((s, n) => { for (const q of s) { const k = id(q); if (!ends.has(k)) ends.set(k, []); ends.get(k).push(n); } });
  const used = new Uint8Array(segs.length), lines = [];
  for (let n = 0; n < segs.length; n++) {
    if (used[n]) continue;
    used[n] = 1;
    const line = [...segs[n]];
    for (let next; (next = (ends.get(id(line.at(-1))) ?? []).find((m) => !used[m])) !== undefined; ) {
      used[next] = 1;
      const [p, q] = segs[next];
      line.push(id(p) === id(line.at(-1)) ? q : p);
    }
    lines.push(line.map(([i, j]) => [x0 + i * G, y0 + j * G]));
  }
  const shape = { key, lines };
  campShapes.set(camp.id, shape);
  return shape;
}
function drawCamps() {
  for (const camp of S.groups) {
    if (!camp.homes?.length) continue;
    const shape = campShape(camp);
    // The name sits just inside the outline's highest point on screen.
    let lx = 0, ly = Infinity;
    ctx.beginPath();
    for (const line of shape.lines)
      line.forEach(([x, y], i) => {
        const [sx, sy] = toScreen(x, y);
        if (sy < ly) { lx = sx; ly = sy; }
        if (i) ctx.lineTo(sx, sy); else ctx.moveTo(sx, sy);
      });
    ctx.fillStyle = "rgba(122, 64, 30, .07)";
    ctx.fill("evenodd");
    ctx.setLineDash([Math.max(3, cam.s * 0.32), Math.max(2, cam.s * 0.2)]);
    ctx.lineCap = "round";
    ctx.strokeStyle = "rgba(96, 48, 26, .6)"; ctx.lineWidth = Math.max(1, cam.s * 0.07);
    ctx.stroke();
    ctx.setLineDash([]);
    if (cam.s < 7) continue;
    ly += Math.max(10, cam.s * 0.4);
    ctx.font = `italic ${Math.round(Math.max(12, Math.min(20, cam.s * 0.7)))}px "IM Fell English", serif`;
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.lineWidth = 3.5; ctx.strokeStyle = "rgba(241, 230, 204, .85)"; ctx.strokeText(camp.name, lx, ly);
    ctx.fillStyle = "rgba(92, 44, 22, .9)"; ctx.fillText(camp.name, lx, ly);
  }
}

// [width, height, base offset] in tiles for flames on things that catch fire: the glyph's, which a flame as tall as the
// thing's own meters would fill.
const FLAME = { tree: [0.55, 1.15, 0.1], bush: [0.5, 0.6, 0.15], dead_bush: [0.5, 0.55, 0.15], reeds: [0.45, 0.55, 0.15], sapling: [0.3, 0.45, 0.15], structure: [0.9, 0.9, 0.2] };
function ringFor(th) {
  if (!th.contained) return "loose";
  for (let y = th.y - 1; y <= th.y + 1; y++)
    for (let x = th.x - 1; x <= th.x + 1; x++)
      for (const id of S.byTile.get(`${x},${y}`) ?? []) {
        const style = S.things.get(id)?.shelter?.style;
        if (style === "brick" || style === "clay") return "brick";
      }
  return "stone";
}
// A blaze's halo grows with the root of its whole output against a KW kW campfire's.
const KW = 100;
function drawHot(now, night) {
  for (const id of S.hot) {
    const th = S.things.get(id);
    if (!th) continue;
    const fire = th.kind === "fire", b = th.blaze;
    const [fx, fy] = toScreen(...(fire ? [th.x + 0.5, th.y + 0.5] : thingSpot(th)));
    if (fx < -200 || fy < -200 || fx > cw + 200 || fy > ch + 200) continue;
    const seed = hash(th.x, th.y), out = b ? Math.min(3, Math.sqrt((b.kw + b.glow) / KW)) : 0;
    if (b) {
      const R = cam.s * (1.5 + out * 1.5 + night * 2), glow = ctx.createRadialGradient(fx, fy, 0, fx, fy, R);
      const flick = 0.85 + Math.sin(now / 90 + th.x) * 0.08;
      const [gr, gg, gb] = flameRgb(b.hot)[1];
      glow.addColorStop(0, `rgba(${gr}, ${gg}, ${gb}, ${Math.min(1, (0.25 + night * 0.4) * flick * (0.5 + 0.5 * Math.min(1, out)))})`);
      glow.addColorStop(1, `rgba(${gr}, ${gg}, ${gb}, 0)`);
      ctx.globalCompositeOperation = "screen";
      ctx.fillStyle = glow;
      ctx.fillRect(fx - R, fy - R, R * 2, R * 2);
      ctx.globalCompositeOperation = "source-over";
    }
    if (fire) {
      drawFire(ctx, fx, fy + cam.s * 0.1, cam.s * 0.9, now, seed, ringFor(th), b, { covered: th.covered });
      if (th.covered && b) drawSmoke(ctx, fx, fy - cam.s * 0.3, cam.s, now, seed, 0.8, S.weather?.wind);
    } else {
      const [w, h, dy] = FLAME[th.kind] ?? [0.5, 0.6, 0.15];
      const wide = th.kind === "structure" ? 0.6 + (th.shelter?.tier ?? 0) * 0.3 : w, tall = h * Math.min(1.5, Math.max(0.2, b.flame / (th.size || 1)));
      // a thing smoldering with no flame over it glows and smokes
      if (b.flame > 0) drawFlames(ctx, fx, fy + dy * cam.s, wide * cam.s, tall * cam.s, now, seed, b.kw / (b.kw + b.glow), b.hot);
      drawSmoke(ctx, fx, fy - tall * cam.s * 0.8, cam.s, now, seed, Math.min(1, out), S.weather?.wind);
    }
  }
}

function trapAt(x, y) {
  for (const id of S.byTile.get(`${x},${y}`) ?? []) if (S.things.get(id)?.kind === "trap") return S.things.get(id);
  return null;
}
function drawAnimals(now) {
  const shake = !calm.matches, used = new Set();
  const list = [...S.animals.values()].map((an) => [an, lerpPos(an)]).sort((p, q) => p[1][0] + p[1][1] - q[1][0] - q[1][1]);
  for (const [an, pos] of list) {
    const trap = an.state === "trapped" && trapAt(an.x, an.y);
    const [x, y] = toScreen(...(trap ? thingSpot(trap) : pos));
    if (x < -40 || y < -40 || x > cw + 40 || y > ch + 40) continue;
    const mine = picked?.type === "animal" && picked.id === an.id;
    if (trap) { used.add(trap.id); drawTrapped(ctx, an, x, y, cam.s, now, an.dir, shake, mine); continue; }
    const s = Math.max(14, Math.min(60, cam.s * (an.species === "wolf" ? 0.95 : 1.05)));
    drawAnimal(ctx, an, x, y, s, now, an.dir, an.px !== an.x || an.py !== an.y, mine);
  }
  // A trap reporting a catch whose animal isn't in the list still shows it.
  for (const tid of S.caught) {
    const th = S.things.get(tid);
    if (!th || used.has(th.id)) continue;
    const [x, y] = toScreen(...thingSpot(th));
    if (x < -40 || y < -40 || x > cw + 40 || y > ch + 40) continue;
    drawTrapped(ctx, { id: th.id, species: th.caught, state: "trapped" }, x, y, cam.s, now, hash(th.x, th.y, 5) < 0.5 ? -1 : 1, shake, false);
  }
}
function drawGraveLabel() {
  const th = S.things.get(hoverGrave ?? (picked?.type === "grave" ? picked.id : null));
  if (!th?.name) return;
  const [x, y] = toScreen(...thingSpot(th));
  drawLabel(ctx, th.name, x, y - Math.max(14, cam.s * 0.5) - 18);
}

function drawAgents(now) {
  const R = Math.max(8, Math.min(20, cam.s * 0.42));
  const sel = selected && S.agents.get(selected);
  if (sel?.target && S.agents.get(sel.target)) {
    const [ax, ay] = toScreen(...lerpPos(sel)), [bx, by] = toScreen(...lerpPos(S.agents.get(sel.target)));
    ctx.setLineDash([2, 6]); ctx.lineCap = "round"; ctx.strokeStyle = "rgba(168, 50, 31, .85)"; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke(); ctx.setLineDash([]);
  }
  const list = [...S.agents.values()].map((a) => [a, lerpPos(a)]).sort((p, q) => p[1][0] + p[1][1] - q[1][0] - q[1][1]).map(([a]) => a);
  const labels = [];
  for (const a of list) {
    let [x, y] = toScreen(...lerpPos(a));
    if (x < -60 || y < -60 || x > cw + 60 || y > ch + 60) continue;
    const walking = a.px !== a.x || a.py !== a.y;
    const r = a.stage === "child" ? R * 0.7 : R;
    if (walking) y -= Math.abs(Math.sin(now / 110)) * r * 0.25;
    drawToken(ctx, a, x, y, r, now, a.id === selected);
    if (a.down) drawSleep(ctx, x + r * 0.7, y - r * 0.9, now);
    else if (a.thinking) drawThinking(ctx, x + r * 0.9, y - r - 6, now);
    if (cam.s >= 12 || a.id === selected) labels.push({ a, x, y: y + r + 5 });
  }
  // Selected name first, then skip any label that would overlap one already drawn.
  labels.sort((p, q) => (q.a.id === selected) - (p.a.id === selected));
  const drawn = [];
  for (const l of labels) {
    if (drawn.some((d) => Math.abs(d.x - l.x) < 60 && Math.abs(d.y - l.y) < 20)) continue;
    drawLabel(ctx, l.a.name, l.x, l.y);
    drawn.push(l);
  }
}

const snowFalls = (wx) => wx.season === "winter" || wx.temp <= 0;
function drawWeather(now) {
  const wx = S.weather;
  if (!wx || calm.matches) return;
  const wet = wx.sky === "rain" || wx.sky === "storm", wind = wx.wind?.dx ?? 0;
  if (wx.season === "winter" || (wet && snowFalls(wx))) drawSnow(ctx, cw, ch, now, { clear: 0.6, cloudy: 1, rain: 2.2, storm: 3.4 }[wx.sky] ?? 1, wind);
  else if (wet) drawRain(ctx, cw, ch, now, wx.sky === "storm", wind);
  if (!flash) return;
  const dt = now - flash.at;
  if (dt < 0 || dt > 700) { flash = null; return; }
  if (dt < 260) drawBolt(ctx, ...toScreen(flash.x + 0.5, flash.y + 0.5), flash.seed);
  const a = dt < 80 ? 0.7 : dt < 150 ? 0.12 : dt < 230 ? 0.45 : 0.45 * (1 - (dt - 230) / 470);
  ctx.fillStyle = `rgba(255, 255, 248, ${a.toFixed(3)})`;
  ctx.fillRect(0, 0, cw, ch);
}

// ---------- camera input ----------
// Keep the visible area inside the layer; the HUD and sheet count as margin you can scroll under.
const clampCam = () => {
  const lw = layer.width / T, lh = layer.height / T;
  const min = Math.min(cw / lw, ch / lh) * 0.7;
  cam.s = Math.max(min, Math.min(90, cam.s));
  const axis = (c, size, span, extra) => {
    const half = span / 2 / cam.s, pad = extra / cam.s;
    return size + pad > 2 * half ? Math.max(half, Math.min(size - half + pad, c)) : size / 2 + pad / 2;
  };
  cam.x = axis(cam.x, lw, cw, rightCover());
  cam.y = axis(cam.y, lh, ch, bottomCover());
};
function zoomAt(px, py, f) {
  const [wx, wy] = screenToPlane(px, py);
  cam.s *= f; clampCam();
  const [nx, ny] = screenToPlane(px, py);
  cam.x += wx - nx; cam.y += wy - ny; clampCam();
}
const panel = $("#panel");
const phone = () => window.innerWidth < 820;
const sheetOpen = () => panel.dataset.open === "true";
// Pixels of map hidden under the HUD or the sheet, so the camera can frame what's still visible.
const bottomCover = () => (phone() && sheetOpen() ? panel.offsetHeight : $("#hud").offsetHeight);
const rightCover = () => (!phone() && sheetOpen() ? panel.offsetWidth : 0);
function fit() {
  const b = bottomCover(), r = rightCover(), lw = layer.width / T, lh = layer.height / T;
  cam.s = Math.min((cw - r) / lw, (ch - b) / lh) * 0.96;
  cam.x = lw / 2 + r / 2 / cam.s; cam.y = lh / 2 + b / 2 / cam.s;
  setFollow(false);
}
const pointers = new Map();
let gesture = null;
canvas.addEventListener("pointerdown", (e) => {
  canvas.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, { x: e.offsetX, y: e.offsetY });
  gesture = { moved: false, start: { x: e.offsetX, y: e.offsetY }, dist: null };
});
// Mouse hover names a grave; touch gets the same through a tap.
function graveNear(px, py) {
  let best = null, bd = Math.max(18, cam.s * 0.5);
  for (const id of S.graves) {
    const th = S.things.get(id), [x, y] = toScreen(...thingSpot(th));
    const d = Math.hypot(x - px, y - py);
    if (d < bd) { best = th; bd = d; }
  }
  return best;
}
canvas.addEventListener("pointermove", (e) => {
  const p = pointers.get(e.pointerId);
  if (!p) {
    if (e.pointerType !== "mouse") return;
    const g = graveNear(e.offsetX, e.offsetY)?.id ?? null;
    if (g !== hoverGrave) { hoverGrave = g; canvas.style.cursor = g ? "pointer" : ""; }
    return;
  }
  const dx = e.offsetX - p.x, dy = e.offsetY - p.y;
  p.x = e.offsetX; p.y = e.offsetY;
  if (pointers.size === 1) {
    if (Math.hypot(e.offsetX - gesture.start.x, e.offsetY - gesture.start.y) > 6) gesture.moved = true;
    if (gesture.moved) { cam.x -= dx / cam.s; cam.y -= dy / cam.s; clampCam(); setFollow(false); }
  } else if (pointers.size === 2) {
    gesture.moved = true;
    const [a, b] = [...pointers.values()];
    const d = Math.hypot(a.x - b.x, a.y - b.y);
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    if (gesture.dist) {
      zoomAt(mx, my, d / gesture.dist);
      if (gesture.mid) { cam.x -= (mx - gesture.mid.x) / cam.s; cam.y -= (my - gesture.mid.y) / cam.s; clampCam(); }
    }
    gesture.dist = d; gesture.mid = { x: mx, y: my };
  }
});
canvas.addEventListener("pointerup", (e) => {
  if (pointers.size === 1 && gesture && !gesture.moved) tap(e.offsetX, e.offsetY);
  pointers.delete(e.pointerId);
  if (gesture) { gesture.dist = null; gesture.mid = null; }
});
canvas.addEventListener("pointercancel", (e) => pointers.delete(e.pointerId));
canvas.addEventListener("wheel", (e) => { e.preventDefault(); zoomAt(e.offsetX, e.offsetY, Math.exp(-e.deltaY * 0.0015)); }, { passive: false });
canvas.addEventListener("dblclick", (e) => zoomAt(e.offsetX, e.offsetY, 2));
function tap(px, py) {
  const nearest = (items) => {
    let best = null, bd = Math.max(24, cam.s * 0.7);
    for (const a of items) {
      const [x, y] = toScreen(...lerpPos(a));
      const d = Math.hypot(x - px, y - py);
      if (d < bd) { best = a; bd = d; }
    }
    return best;
  };
  const a = nearest(S.agents.values());
  if (a) return select(a.id);
  const an = nearest(S.animals.values());
  if (an) return pick("animal", an.id);
  const g = graveNear(px, py);
  if (g) return pick("grave", g.id);
  if (selected) select(null);
  if (picked) pick(null);
}

// ---------- sheet ----------
function openSheet(tab) {
  panel.dataset.open = "true";
  clampCam();
  showTab(tab);
  if (tab === "inspect") loadInspector();
}
function closeSheet() { panel.dataset.open = "false"; clampCam(); }
function showTab(tab) {
  for (const b of $("#tabs").querySelectorAll("button[data-tab]")) b.setAttribute("aria-selected", String(b.dataset.tab === tab));
  for (const id of ["chronicle", "inspect", "book", "groups"]) $(`#${id}`).hidden = id !== tab;
  if (tab === "book") loadBook();
  if (tab === "groups") loadGroups();
}
$("#tabs").addEventListener("click", (e) => { const t = e.target.closest("button[data-tab]")?.dataset.tab; if (t) openSheet(t); });
$("#close").onclick = closeSheet;
$("#open-chronicle").onclick = () => (sheetOpen() && !$("#chronicle").hidden ? closeSheet() : openSheet("chronicle"));

// ---------- selection, focus card, dock ----------
function select(id) {
  selected = id;
  follow = !!id;
  if (id) { picked = null; cam.s = Math.max(cam.s, 24); }
  renderDock(); renderFocus();
  if (id && sheetOpen() && !$("#inspect").hidden) loadInspector();
  if (id) $(`#dock [data-id="${id}"]`)?.scrollIntoView({ inline: "nearest", block: "nearest", behavior: "smooth" });
}
function pick(type, id) {
  picked = type ? { type, id } : null;
  if (type && selected) select(null);
  else renderFocus();
}
const NEED_ICON = {
  food: `<path d="M12 7c-3.5-2-7 0-7 4.5S8 20 12 18.5c4 1.5 7-2.5 7-7S15.5 5 12 7zM12 7c0-2 1-3.5 3-4" />`,
  energy: `<path d="M13 3L6 13h5l-1 8 7-10h-5z" />`,
  warmth: `<path d="M12 21c-3.5 0-6-2.4-6-5.8 0-3.6 3-5.2 3.5-9.2 2 1.2 3 3 3 4.8 1-.8 1.6-2 1.8-3.2 2 1.8 3.7 4.4 3.7 7.6 0 3.4-2.5 5.8-6 5.8z" />`,
  social: `<circle cx="8.5" cy="9" r="3"/><circle cx="16" cy="10" r="2.5"/><path d="M3.5 19c.6-3 2.6-4.6 5-4.6s4.4 1.6 5 4.6M14 15.3c.6-.4 1.3-.6 2-.6 2 0 3.6 1.4 4 4.3" />`,
  health: `<path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z" />`,
};
const icon = (k) => `<svg viewBox="0 0 24 24" aria-hidden="true">${NEED_ICON[k]}</svg>`;
function needBars(needs, big) {
  return `<div class="needs ${big ? "big" : ""}">${NEEDS.map((k) => {
    const v = Math.round(needs[k]);
    return `<span class="need ${v < 30 ? "low" : ""}" title="${k} ${v}">${icon(k)}${big ? `<span class="nl"><span class="nk">${k}</span><em>${v}</em></span>` : ""}<i><b style="width:${v}%"></b></i></span>`;
  }).join("")}</div>`;
}
const doing = (a) => (a.down ? "Unconscious" : a.status);
const wornName = (w) => (typeof w === "string" ? w : w ? kindName(w.k) : null);
function kitLine(a) {
  const hold = a.holding, wear = wornName(a.wearing);
  if (hold && wear) return `Holding ${hold}, wearing ${wear}`;
  return hold ? `Holding ${hold}` : wear ? `Wearing ${wear}` : "";
}
function goalLine(text, target) {
  const who = target && nameOf(target);
  return `${text}${who && !text.includes(who) ? ` with ${who}` : ""}`;
}
function renderDock() {
  $("#dock").innerHTML = [...S.agents.values()].map((a) => `
    <button type="button" class="card ${a.id === selected ? "on" : ""}" data-id="${a.id}" aria-pressed="${a.id === selected}">
      <span class="card-top">${seal(a, "sm")}<span class="card-name">${esc(a.name)}</span>${a.sick ? SICK : ""}</span>
      <span class="card-status ${a.thinking ? "thinking" : ""}">${esc(doing(a))}</span>
      ${needBars(a.needs)}
    </button>`).join("");
}
$("#dock").addEventListener("click", (e) => { const id = e.target.closest(".card")?.dataset.id; if (id) select(id === selected ? null : id); });
const STATE_WORD = { graze: "grazing", wander: "wandering", flee: "fleeing", hunt: "hunting", attack: "attacking", rest: "resting", eat: "eating", trapped: "stuck in a trap" };
const TRACK = {
  deer: `<path d="M8.2 4.5c-2.3 3.2-2.8 8.4-1.2 12.3.9 2.1 3.6 1.7 4-.9V6.3c0-1.8-1.8-2.9-2.8-1.8zM15.8 4.5c2.3 3.2 2.8 8.4 1.2 12.3-.9 2.1-3.6 1.7-4-.9V6.3c0-1.8 1.8-2.9 2.8-1.8z"/>`,
  wolf: `<ellipse cx="12" cy="16" rx="4.4" ry="3.6"/><circle cx="6.4" cy="10.6" r="1.9"/><circle cx="10" cy="6.8" r="1.9"/><circle cx="14" cy="6.8" r="1.9"/><circle cx="17.6" cy="10.6" r="1.9"/>`,
};
const CAIRN = `<ellipse cx="12" cy="19" rx="7.5" ry="2.6"/><ellipse cx="8.4" cy="15.6" rx="3.2" ry="2.3"/><ellipse cx="15.4" cy="15.8" rx="3" ry="2.2"/><ellipse cx="11.8" cy="11.4" rx="3" ry="2.2"/><ellipse cx="12" cy="7.2" rx="2.1" ry="1.6"/>`;
function renderFocus() {
  const box = $("#focus");
  const a = selected && S.agents.get(selected);
  const an = !a && picked?.type === "animal" && S.animals.get(picked.id);
  const grave = !a && picked?.type === "grave" && S.things.get(picked.id);
  box.hidden = !a && !an && !grave;
  box.classList.toggle("mini", !!(an || grave));
  if (an || grave) {
    const who = grave && [...S.people.values()].find((p) => p.name === grave.name && (grave.died == null || p.died === grave.died));
    const line = an
      ? `<span class="track ${esc(an.species)}" aria-hidden="true"><svg viewBox="0 0 24 24">${TRACK[an.species] ?? TRACK.wolf}</svg></span>
        <p><b>${esc(cap(an.species))}</b>, ${esc(STATE_WORD[an.state] ?? human(an.state))}${an.maxHp ? `, ${Math.round(an.hp)} of ${Math.round(an.maxHp)} hp` : ""}</p>`
      : `${who ? seal(who, "sm") : `<span class="track" aria-hidden="true"><svg viewBox="0 0 24 24">${CAIRN}</svg></span>`}
        <p><b>${esc(grave.name ?? "Someone")}</b> lies here${grave.died != null ? `. Died Day ${dayOf(grave.died)}` : ""}${grave.cause ? ` (${esc(grave.cause)})` : ""}</p>`;
    box.innerHTML = `<div class="focus-line">${line}<button type="button" class="icon-btn" id="focus-close" aria-label="Close">${X_ICON}</button></div>`;
    $("#focus-close").onclick = () => pick(null);
    return;
  }
  if (!a) return;
  const goal = a.goalText ?? (a.goal ? human(a.goal) : null);
  const kit = [[ageText(a), a.pregnant ? "expecting" : ""].filter(Boolean).join(", "), kitLine(a)].filter(Boolean).join(". ");
  box.innerHTML = `
    <div class="focus-head">${seal(a)}<div class="focus-title"><h2>${esc(a.name)}${a.sick ? SICK : ""}</h2>
      <p class="focus-status ${a.thinking ? "thinking" : ""}">${esc(doing(a))}</p></div>
      <button type="button" class="ghost" id="focus-ledger">Ledger</button>
      <button type="button" class="icon-btn" id="focus-close" aria-label="Deselect">${X_ICON}</button></div>
    ${goal ? `<p class="focus-goal">Goal: ${esc(goalLine(goal, a.target))}</p>` : ""}
    ${kit ? `<p class="focus-kit">${esc(kit)}</p>` : ""}
    ${needBars(a.needs, true)}`;
  $("#focus-ledger").onclick = () => openSheet("inspect");
  $("#focus-close").onclick = () => select(null);
}

// ---------- chronicle ----------
const tone = (k) => (GOLD.has(k) ? "invention" : NOTABLE.has(k) ? "notable" : ROUTINE.has(k) ? "routine" : "social");
function eventLi(e, fresh) {
  return `<li class="ev ${tone(e.kind)}${fresh ? " new" : ""}" data-day="${dayOf(e.t)}"><button type="button" data-x="${e.x}" data-y="${e.y}"><time>${hhmm(e.t)}</time><span>${esc(e.text)}</span></button></li>`;
}
const dayHead = (d) => `<li class="day" data-day="${d}"><span>Day ${d}</span></li>`;
// Newest first, with a heading at the top of each day.
function eventList(events) {
  let out = "", day = null;
  for (const e of [...events].reverse()) {
    if (dayOf(e.t) !== day) { day = dayOf(e.t); out += dayHead(day); }
    out += eventLi(e);
  }
  return out;
}
function prependEvents(list, events) {
  list.querySelector(":scope > li.muted")?.remove();
  for (const e of events) {
    const d = dayOf(e.t), head = list.firstElementChild;
    if (head?.classList.contains("day") && +head.dataset.day === d) head.insertAdjacentHTML("afterend", eventLi(e, true));
    else list.insertAdjacentHTML("afterbegin", dayHead(d) + eventLi(e, true));
  }
}
const feed = [];
const TIMELINE = `<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M4 19h16M6.5 16v-5M10.5 16V7M14.5 16v-3M18.5 16V9" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>`;
function renderFilters() {
  const inFeed = new Set(feed.flatMap((e) => e.who));
  const gone = [...S.people.values()].filter((p) => !S.agents.has(p.id) && (inFeed.has(p.id) || p.id === filter));
  const chip = (p) => `<button type="button" aria-pressed="${filter === p.id}" data-f="${p.id}"${S.agents.has(p.id) ? "" : ` class="gone"`}>${seal(p, "xs")}${esc(p.name)}</button>`;
  $("#filters").innerHTML = `<a class="to-history" href="history.html">${TIMELINE}Timeline</a><button type="button" aria-pressed="${!filter}" data-f="">Everyone</button>` +
    [...S.agents.values()].map(chip).join("") + gone.map(chip).join("");
}
function renderFeed() {
  $("#feed").innerHTML = eventList(feed.filter((e) => !filter || e.who.includes(filter)).slice(-300));
}
$("#filters").addEventListener("click", (e) => { const b = e.target.closest("button"); if (!b) return; filter = b.dataset.f || null; renderFilters(); renderFeed(); });
function jumpTo(e) {
  const b = e.target.closest("li.ev button");
  if (!b) return;
  cam.s = Math.max(cam.s, 28);
  const [x, y] = toPlane(+b.dataset.x + 0.5, +b.dataset.y + 0.5);
  cam.x = x + rightCover() / 2 / cam.s; cam.y = y + bottomCover() / 2 / cam.s;
  setFollow(false);
}
$("#feed").addEventListener("click", jumpTo);

// ---------- inspector ----------
let insData = null, insHistory = [], insTimer = null;
function setFollow(v) {
  if (follow === v) return;
  follow = v;
  const b = $("#ins-head .follow");
  if (b) { b.setAttribute("aria-pressed", String(v)); b.lastElementChild.textContent = v ? "Following" : "Follow"; }
}
async function loadInspector() {
  const id = selected;
  insData = null; insHistory = [];
  if (!id) { $("#inspect").innerHTML = `<p class="muted pad">Tap someone on the map to open their ledger.</p>`; return; }
  const a = S.agents.get(id);
  $("#inspect").innerHTML = `
    <header class="ins-head" id="ins-head">
      ${seal(a, "lg")}
      <div class="ins-title"><h2>${esc(a.name)}</h2><p id="ins-sub"></p></div>
      <button type="button" class="follow" aria-pressed="true"><svg viewBox="0 0 24 24" width="18" height="18"><circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg><span>Following</span></button>
    </header>
    <div id="ins-body"><p class="muted pad">Opening the ledger…</p></div>
    <section class="sec"><h3>History</h3><ol class="feed" id="ins-history"></ol><button type="button" class="more" id="ins-more" hidden>Load older entries</button></section>`;
  $("#ins-head .follow").onclick = () => setFollow(!follow);
  $("#ins-history").addEventListener("click", jumpTo);
  $("#ins-more").onclick = loadOlder;
  const [agent, events] = await Promise.all([fetch(`api/agent/${id}`).then((r) => r.json()), fetch(`api/events?agent=${id}`).then((r) => r.json())]);
  if (selected !== id) return;
  insData = agent; insHistory = events;
  renderInspector();
  $("#ins-history").innerHTML = eventList(insHistory) || `<li class="muted">Nothing yet.</li>`;
  $("#ins-more").hidden = events.length < 200;
  clearInterval(insTimer);
  insTimer = setInterval(async () => {
    if (selected !== id) return clearInterval(insTimer);
    const a = await fetch(`api/agent/${id}`).then((r) => r.json());
    if (selected === id) { insData = a; renderInspector(); }
  }, 1500);
}
async function loadOlder() {
  const id = selected;
  const older = await fetch(`api/events?agent=${id}&before=${insHistory[0]?.id ?? 0}`).then((r) => r.json());
  if (selected !== id) return;
  insHistory = [...older, ...insHistory];
  $("#ins-history").innerHTML = eventList(insHistory);
  $("#ins-more").hidden = older.length < 200;
}
function oddsRows(probs, picked, label = human) {
  return Object.entries(probs ?? {}).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, p]) => `
    <li class="${k === picked ? "picked" : ""}"><span>${esc(label(k))}</span><i><b style="width:${Math.max(1, Math.round(p * 100))}%"></b></i><span>${Math.round(p * 100)}%</span></li>`).join("");
}
function meter(label, v, centered) {
  const style = centered
    ? v >= 0 ? `left:50%;width:${v * 50}%` : `right:50%;width:${-v * 50}%`
    : `left:0;width:${v * 100}%`;
  return `<div class="meter ${centered ? (v >= 0 ? "pos" : "neg") : ""}"><span>${label}</span><i>${centered ? "<u></u>" : ""}<b style="${style}"></b></i></div>`;
}
const lvl = (xp) => Math.min(10, Math.floor(Math.sqrt(xp / 10)));
function wearBar(v) {
  const p = Math.round(Math.max(0, Math.min(1, v)) * 100);
  return `<i class="wear ${p < 25 ? "low" : ""}" title="${p}% left" aria-label="${p}% left"><b style="width:${p}%"></b></i>`;
}
function howText(b) {
  const who = b.from ? nameOf(b.from) : "someone";
  return { discovered: "Worked it out", watched: `Watched ${who}`, taught: `Taught by ${who}`, seen: "Saw it happen" }[b.how] ?? cap(human(b.how));
}
const sevWord = (v) => (v >= 0.67 ? "Very sick" : v >= 0.34 ? "Sick" : "A little sick");
function carrying(a) {
  const groups = new Map();
  for (const it of Array.isArray(a.inv) ? a.inv : []) {
    const g = groups.get(it.k) ?? { k: it.k, n: 0, hp: 0 };
    g.n++; g.hp += it.hp ?? 1;
    groups.set(it.k, g);
  }
  const rows = [...groups.values()].map((g) => ({ ...g, name: kindName(g.k) })).sort((p, q) => p.name.localeCompare(q.name));
  const worn = a.wearing && typeof a.wearing === "object" ? a.wearing : null;
  return `${a.holding ? `<p class="muted small">In hand: ${esc(a.holding)}</p>` : ""}
    ${rows.length ? `<dl class="kv inv">${rows.map((g) => {
      const kind = S.kinds[g.k], tool = kind && ["Tools", "Containers"].includes(category(kind)) && !kind.base;
      return `<dt>${esc(g.name)}</dt><dd>${tool ? wearBar(g.hp / g.n) : ""}${g.n}</dd>`;
    }).join("")}</dl>` : `<p class="muted">Nothing</p>`}
    ${worn ? `<p class="muted small gap wearing">Wearing ${esc(kindName(worn.k))}${worn.hp != null ? wearBar(worn.hp) : ""}</p>` : ""}`;
}
function beliefLi(b) {
  return `<li class="${b.spurious ? "wrong" : ""}">
    <span>${esc(cap(b.text))}${b.spurious ? ` <span class="spur" title="This part is wrong"><s>thinks they need ${esc(b.spurious)}</s></span>` : ""}${b.law ? ` <i class="law-mark" title="A law of this world">✦</i>` : ""}</span>
    <small>${esc(howText(b))}, Day ${dayOf(b.t)}${b.tries ? `, worked ${b.wins ?? 0} of ${b.tries} tries` : ""}</small></li>`;
}
function renderInspector() {
  const a = insData;
  if (!a || !$("#ins-body")) return;
  const d = a.lastDecision;
  const plan = a.plan ?? [];
  const rels = Object.entries(a.rel ?? {}).sort((x, y) => Math.abs(y[1].affinity) - Math.abs(x[1].affinity));
  const trained = Object.entries(a.skills ?? {}).filter(([, xp]) => xp > 0).sort((x, y) => y[1] - x[1]);
  const beliefs = Object.values(a.beliefs ?? {}).sort((x, y) => x.t - y.t);
  const facts = Object.values(a.facts ?? {});
  const home = a.home && typeof a.home === "object" ? a.home : homeOf(a.id);
  const goal = a.goalText ?? (a.goal?.type ? human(a.goal.type) : null);
  $("#ins-sub").textContent = [ageText(a), home?.shelter ? `Lives in a ${shelterName(home.shelter)}` : "Wandering, no home"].filter(Boolean).join(". ");
  const scroll = $("#inspect").scrollTop;
  $("#ins-body").innerHTML = `
    <section class="sec"><p class="bio">${esc(a.bio)}</p></section>
    <section class="sec"><h3>Right now</h3>
      <p class="now">${a.down ? "Unconscious" : esc(a.status)}</p>
      ${a.sickness ? `<p class="sick-line">${SICK}${sevWord(a.sickness.severity)} until ${clockText(a.sickness.until)}</p>` : a.sick ? `<p class="sick-line">${SICK}Sick</p>` : ""}
      ${goal ? `<p class="muted">Goal: ${esc(goalLine(goal, a.goal?.target ?? a.target))}</p>` : ""}
      ${plan.length ? `<ol class="plan">${plan.map((s, i) => `<li class="${i === 0 ? "cur" : ""}">${esc(cap(s.label ?? human(s.op)))}</li>`).join("")}</ol>` : ""}
    </section>
    ${d ? `<section class="sec"><h3>Last choice</h3><p class="muted">At ${clockText(d.t)}, Jev gave these odds for what ${esc(a.name)} would do next.</p>
      <ol class="odds">${oddsRows(d.goal, d.chosen, (k) => d.labels?.[k] ?? human(k))}</ol>
      ${d.who ? `<p class="muted gap">And who with:</p><ol class="odds">${oddsRows(d.who, d.target, nameOf)}</ol>` : ""}</section>` : ""}
    <section class="sec"><h3>Needs</h3>${needBars(a.needs, true)}</section>
    <section class="sec"><h3>Nature</h3>
      <ul class="tags">${Object.entries(a.traits ?? {}).sort((x, y) => y[1] - x[1]).map(([t, s]) => `<li style="--s:${s}">${esc(t)}</li>`).join("")}</ul>
      ${a.desires?.length ? `<p class="muted gap">Wants to ${a.desires.map(esc).join(", and to ")}.</p>` : ""}</section>
    ${familyHtml(a)}
    ${campLedger(a)}
    <section class="sec two">
      <div><h3>Carrying</h3>${carrying(a)}${home ? `<p class="muted small gap store">Kept at home: ${esc(storeText(home.store))}</p>` : ""}</div>
      <div><h3>Skills</h3>${trained.length ? `<dl class="kv">${trained.map(([s, xp]) => `<dt>${esc(human(s))}</dt><dd>Level ${lvl(xp)} <small>${Math.round(xp)} xp</small></dd>`).join("")}</dl>` : `<p class="muted">None yet</p>`}</div>
    </section>
    <section class="sec"><h3>Beliefs</h3>${beliefs.length ? `<ul class="blf">${beliefs.map(beliefLi).join("")}</ul>` : `<p class="muted">Hasn't worked out how anything works yet.</p>`}</section>
    <section class="sec"><h3>Knows about the world</h3>${facts.length ? `<ul class="facts">${facts.map((f) => `<li>${esc(cap(f))}</li>`).join("")}</ul>` : `<p class="muted">Nothing much yet.</p>`}</section>
    <section class="sec"><h3>Relationships</h3>${rels.length ? rels.map(([id, r]) => {
      const other = personOf(id);
      const beliefs = Object.entries(r.beliefs ?? {}).filter(([, v]) => v > 0.65 || v < 0.35).map(([k, v]) => (v > 0.65 ? k : `not ${k}`));
      return `<article class="rel">
        <header>${other ? seal(other, "sm") : ""}<span class="rn">${esc(nameOf(id))}</span>${isDead(id) ? `<small class="gone">${esc(diedText(id))}</small>` : ""}<span class="label">${human(r.label)}</span></header>
        ${meter("feeling", r.affinity, true)}${meter("trust", r.trust)}
        ${r.bonds?.length ? `<ul class="bonds">${[...r.bonds].sort((x, y) => y.weight - x.weight).map((b) => `<li style="opacity:${(0.5 + b.weight * 0.5).toFixed(2)}">${human(b.kind)}<small>${clockText(b.t)}</small></li>`).join("")}</ul>` : ""}
        ${beliefs.length ? `<p class="beliefs">Believes ${esc(nameOf(id))} is ${beliefs.join(", ")}.</p>` : ""}
        ${r.ledger ? `<p class="beliefs">${r.ledger > 0 ? `Owes ${esc(nameOf(id))} ${r.ledger} favor${r.ledger > 1 ? "s" : ""}.` : `${esc(nameOf(id))} owes ${-r.ledger} favor${r.ledger < -1 ? "s" : ""}.`}</p>` : ""}
        ${r.history?.length ? `<ul class="hist">${r.history.slice(-4).reverse().map((h) => `<li>${esc(h)}</li>`).join("")}</ul>` : ""}
      </article>`;
    }).join("") : `<p class="muted">Hasn't met anyone yet.</p>`}</section>`;
  $("#inspect").scrollTop = scroll;
}
const diedText = (id) => { const p = S.people.get(id); return p?.died != null ? `died Day ${dayOf(p.died)}` : "died"; };
function storeText(store) {
  const rows = Object.entries(store ?? {}).filter(([, n]) => n > 0).map(([k, n]) => [kindName(k), n]).sort((p, q) => q[1] - p[1]);
  return rows.length ? rows.map(([name, n]) => `${n} ${name}`).join(", ") : "nothing yet";
}
function campLedger(a) {
  const c = a.camp, s = c?.standing, n = s ? s.followed + s.defied : 0;
  const out = (a.outcast ?? []).map((o) => `<p class="camp-bans">${o.how === "shunned" ? "Shunned by" : "Driven out of"} ${esc(o.camp)} until Day ${dayOf(o.until)}</p>`).join("");
  const known = a.customsKnown ?? [];
  if (!c && !out && !known.length) return `<section class="sec"><h3>Camp</h3><p class="muted">Not part of any camp.</p></section>`;
  return `<section class="sec"><h3>Camp</h3>
    ${c ? `<p class="camp-line">Lives in <b>${esc(c.name)}</b>${c.leader === a.id ? ", and people bring their grievances to them" : c.leader ? `, where ${esc(nameOf(c.leader))} leads` : ""}.</p>
      <p class="muted">${n ? `Their rulings: ${s.followed} of ${n} followed${s.defied ? `, ${s.defied} defied` : ""}.` : s?.decided ? "Nobody has reacted to their rulings yet." : "Hasn't had to rule on anything yet."}</p>` : `<p class="muted">Not part of any camp.</p>`}
    ${out}
    ${known.length ? `<p class="muted gap">Customs they know:</p><ul class="customs">${known.map((k) => `<li><q>${esc(k)}</q></li>`).join("")}</ul>` : ""}
  </section>`;
}
function familyHtml(a) {
  const kin = (ids) => `<ul class="kin">${ids.map((id) => `<li>${sealOf(id, "xs")}<span>${esc(nameOf(id))}</span>${isDead(id) ? `<small>${esc(diedText(id))}${S.people.get(id)?.cause ? `, ${esc(S.people.get(id).cause)}` : ""}</small>` : ""}</li>`).join("")}</ul>`;
  const sweet = Object.entries(a.rel ?? {}).filter(([, r]) => r.label === "sweetheart").map(([id]) => id);
  const rows = [["Parents", a.parents ?? []], ["Children", a.children ?? []], [sweet.length > 1 ? "Sweethearts" : "Sweetheart", sweet]].filter(([, ids]) => ids.length);
  const p = a.pregnant && typeof a.pregnant === "object" ? a.pregnant : null;
  const expecting = p ? `Expecting a child${p.father ? ` with ${esc(nameOf(p.father))}` : ""}, due Day ${dayOf(p.due)}` : a.pregnant ? "Expecting a child" : "";
  if (!rows.length && !expecting) return `<section class="sec"><h3>Family</h3><p class="muted">No family yet.</p></section>`;
  return `<section class="sec"><h3>Family</h3>
    ${expecting ? `<p class="expecting">${expecting}</p>` : ""}
    ${rows.length ? `<dl class="fam">${rows.map(([k, ids]) => `<dt>${k}</dt><dd>${kin(ids)}</dd>`).join("")}</dl>` : ""}</section>`;
}

// ---------- discoveries ----------
let bookTimer = null;
const MADE_BY = { strike: "Struck from", rub: "Rubbed from", join: "Joined from", heat: "Heated from", wet: "Wetted from", shape: "Shaped from" };
const plural = (n, word) => `<b>${n}</b> ${word}${n === 1 ? "" : "s"}`;
// Agents holding a belief that passes test; wrong when every such belief of theirs is spurious.
function holders(k, test) {
  return (k.agents ?? []).flatMap((ag) => {
    const bs = Object.values(ag.beliefs ?? {}).filter(test);
    return bs.length ? [{ id: ag.id, bs, wrong: bs.every((b) => b.spurious) }] : [];
  });
}
function holderSeals(list) {
  return list.map((h) => {
    const a = personOf(h.id);
    if (!a) return "";
    const b = h.wrong ? h.bs[0] : h.bs.find((x) => !x.spurious);
    const how = howText(b), title = `${a.name}: ${how[0].toLowerCase()}${how.slice(1)}${h.wrong ? `, but thinks they need ${b.spurious}` : ""}`;
    return `<span class="held ${h.wrong ? "wrong" : ""}" role="img" aria-label="${esc(title)}" title="${esc(title)}">${seal(a, "xs")}</span>`;
  }).join("");
}
function bookHtml(k) {
  const kinds = { ...S.kinds, ...(k.kinds ?? {}) };
  const laws = [...(k.laws ?? [])].sort((a, b) => a.t - b.t);
  const made = Object.entries(kinds).filter(([, x]) => x.made).map(([id, x]) => ({ ...x, id: x.id ?? id })).sort((a, b) => a.made.t - b.made.t);
  const lawCard = (l) => `<article class="rc">
    <p class="rc-name">${esc(cap(l.text))}${l.source === "jev" ? ` <span class="jev-mark" title="Jev ruled on this when it first happened">✦</span>` : ""}</p>
    <div class="rc-who"><span class="rc-first">First found by ${esc(nameOf(l.by))}, Day ${dayOf(l.t)}</span>
      <span class="rc-seals">${holderSeals(holders(k, (b) => b.law === l.id))}</span></div>
  </article>`;
  const madeCard = (x) => {
    const chips = Object.entries(x.props ?? {}).filter(([, v]) => v > 0).sort((p, q) => q[1] - p[1]).slice(0, 4);
    const parts = (x.parts ?? []).map((p) => kinds[p]?.name ?? human(p));
    return `<article class="rc">
      <p class="rc-name">${esc(cap(x.name))}</p>
      ${chips.length ? `<ul class="tags chips">${chips.map(([p, v]) => `<li style="--s:${Math.min(1, v).toFixed(2)}">${esc(p)}</li>`).join("")}</ul>` : ""}
      ${parts.length ? `<p class="rc-how">${esc(MADE_BY[x.verb] ?? "Made from")} ${esc(parts.join(" + "))}</p>` : ""}
      <div class="rc-who"><span class="rc-first">First made by ${esc(nameOf(x.made.by))}, Day ${dayOf(x.made.t)}</span>
        <span class="rc-seals">${holderSeals(holders(k, (b) => b.gives?.includes(x.id)))}</span></div>
    </article>`;
  };
  const groups = CATEGORIES.map((c) => [c, made.filter((x) => category(x) === c)]).filter(([, xs]) => xs.length);
  return `<p class="book-count">${plural(laws.length, "law")} found, ${plural(made.length, "thing")} made</p>
    <section class="sec"><h3>Laws of this world</h3>${laws.length ? laws.map(lawCard).join("") : `<p class="muted">No one has worked out a law yet.</p>`}</section>
    ${groups.length ? groups.map(([c, xs]) => `<section class="sec"><h3>${c}</h3>${xs.map(madeCard).join("")}</section>`).join("")
      : `<section class="sec"><h3>Things made</h3><p class="muted">Nobody has made anything yet.</p></section>`}
    <p class="book-foot"><a href="debug.html">Open the debug view</a></p>`;
}
async function loadBook() {
  clearInterval(bookTimer);
  const draw = async () => {
    if ($("#book").hidden || !sheetOpen()) return clearInterval(bookTimer);
    const k = await fetch("api/knowledge").then((r) => r.json()).catch(() => null);
    if (!k || $("#book").hidden) return;
    const scroll = $("#book").scrollTop;
    $("#book").innerHTML = bookHtml(k);
    $("#book").scrollTop = scroll;
  };
  await draw();
  bookTimer = setInterval(draw, 3000);
}

// ---------- groups ----------
let groupsTimer = null;
const VERDICT = { let_go: "Let go", scold: "Scolded", repay: "Made to repay", shun: "Shunned", drive_out: "Driven out" };
const sealRow = (ids, cls = "") => ids.map((id) => `<span class="held ${cls}" role="img" aria-label="${esc(nameOf(id))}" title="${esc(nameOf(id))}">${sealOf(id, "xs")}</span>`).join("");
function standingText(s) {
  const n = s.followed + s.defied;
  return n ? `${s.followed} of ${n} followed` : s.decided ? "no one has reacted yet" : "";
}
function campHtml(c) {
  const members = [...c.members].sort((a, b) => (c.standing[b]?.score ?? 0) - (c.standing[a]?.score ?? 0));
  const lead = c.leader && c.standing[c.leader];
  const live = (m) => Object.entries(m ?? {}).filter(([, b]) => b.until > S.t);
  const bans = [...live(c.shunned).map(([id, b]) => [id, b, "Shunned"]), ...live(c.exiled).map(([id, b]) => [id, b, "Driven out"])];
  const customs = [...c.customs].sort((a, b) => !!a.faded - !!b.faded || b.t - a.t);
  const store = c.store && Object.entries(c.store.items).map(([k, n]) => `${n} ${kindName(k)}`).join(", ");
  return `<section class="sec camp">
    <h3>${esc(c.name)}</h3>
    <p class="camp-meta">Settled Day ${dayOf(c.founded)}${c.from ? ", after a split" : ""}. ${c.members.length} people live here.</p>
    <ul class="camp-members">${members.map((id) => {
      const s = c.standing[id], share = s && s.followed + s.defied ? s.followed / (s.followed + s.defied) : null;
      return `<li>${sealOf(id, "sm")}<span class="cm-name">${esc(nameOf(id))}${id === c.leader ? ` <em class="cm-lead">leads</em>` : ""}</span>
        <span class="cm-stand">${share == null ? "" : `<i class="standing" title="${esc(standingText(s))}"><b style="width:${Math.round(share * 100)}%"></b></i>`}<small>${esc(standingText(s ?? { followed: 0, defied: 0, decided: 0 }))}</small></span></li>`;
    }).join("")}</ul>
    <p class="camp-lead">${lead ? `People bring their grievances to <b>${esc(nameOf(c.leader))}</b>, whose word has been followed ${lead.followed} times out of ${lead.followed + lead.defied}.` : "No one leads. Whoever was wronged answers for it, and the camp goes along or doesn't."}</p>
    ${bans.length ? `<ul class="camp-bans">${bans.map(([id, b, how]) => `<li>${sealOf(id, "xs")}${esc(nameOf(id))}: ${how.toLowerCase()} until Day ${dayOf(b.until)}</li>`).join("")}</ul>` : ""}
    <h4>Spoken customs</h4>
    ${customs.length ? `<ul class="customs">${customs.map((k) => `<li class="${k.faded ? "faded" : ""}"><q>${esc(k.text)}</q>
      <small>${sealOf(k.spokenBy, "xs")}Said by ${esc(nameOf(k.spokenBy))}, Day ${dayOf(k.t)}. Held ${k.held} time${k.held === 1 ? "" : "s"}${k.broken ? `, broken ${k.broken}` : ""}${k.faded ? `. Faded Day ${dayOf(k.faded)}` : ""}.</small></li>`).join("")}</ul>`
      : `<p class="muted">None spoken yet. A custom is put into words once the camp has answered the same kind of thing the same way three times running.</p>`}
    <h4>What happens here</h4>
    ${c.patterns.length ? `<ul class="patterns">${c.patterns.slice(0, 8).map((x) => `<li>${esc(x.text)}</li>`).join("")}</ul>` : `<p class="muted">Nothing has been judged yet.</p>`}
    ${store ? `<h4>Shared store</h4><p class="muted">At ${esc(nameOf(c.store.owner))}'s home: ${esc(store)}.</p>` : ""}
    <h4>Precedents</h4>
    ${c.precedents.length ? `<ol class="precedents">${[...c.precedents].reverse().slice(0, 30).map((p) => `<li>
      <time>Day ${dayOf(p.t)}</time><p>${esc(p.incident.text)}</p>
      <p class="verdict"><span class="resp ${p.response}">${VERDICT[p.response]}</span><span>by ${sealOf(p.decidedBy, "xs")}${esc(nameOf(p.decidedBy))}</span>
        ${p.followed.length ? `<span class="went">${sealRow(p.followed)} went along</span>` : ""}${p.defied.length ? `<span class="went">${sealRow(p.defied, "wrong")} didn't</span>` : ""}${p.open > S.t ? `<span class="watch">still watching</span>` : ""}</p>
    </li>`).join("")}</ol>` : `<p class="muted">No precedents yet.</p>`}
  </section>`;
}
function groupsHtml(g) {
  const live = g.camps.filter((c) => !c.gone), gone = g.camps.filter((c) => c.gone);
  const byId = new Map(g.camps.map((c) => [c.id, c]));
  return `${live.length ? live.map(campHtml).join("") : `<section class="sec"><h3>Camps</h3><p class="muted">No camps yet. When three or more people who get along keep homes within a short walk of each other, they become a camp.</p></section>`}
    ${gone.length ? `<section class="sec"><h3>Former camps</h3><ul class="gone-camps">${gone.map((c) => `<li><span>${esc(c.name)}</span><small>Day ${dayOf(c.founded)} to Day ${dayOf(c.gone)}${c.mergedInto ? `, grew into ${esc(byId.get(c.mergedInto)?.name ?? "another camp")}` : ", broke up"}. ${c.precedents.length} precedents.</small></li>`).join("")}</ul></section>` : ""}
    <p class="book-foot"><a href="api/groups">Raw group data</a></p>`;
}
async function loadGroups() {
  clearInterval(groupsTimer);
  const draw = async () => {
    if ($("#groups").hidden || !sheetOpen()) return clearInterval(groupsTimer);
    const g = await fetch("api/groups").then((r) => r.json()).catch(() => null);
    if (!g || $("#groups").hidden) return;
    const scroll = $("#groups").scrollTop;
    $("#groups").innerHTML = groupsHtml(g);
    $("#groups").scrollTop = scroll;
  };
  await draw();
  groupsTimer = setInterval(draw, 3000);
}

// ---------- controls ----------
const svg = (body) => `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
const CLOUD = `<path d="M7 14h10a3.6 3.6 0 0 0 .5-7.15A5 5 0 0 0 7.9 5.8 3.7 3.7 0 0 0 7 14z"/>`;
const ICON = {
  pause: `<svg viewBox="0 0 24 24" width="20" height="20"><path d="M9 6v12M15 6v12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`,
  play: `<svg viewBox="0 0 24 24" width="20" height="20"><path d="M8.5 6.2v11.6a.6.6 0 0 0 .9.5l9-5.8a.6.6 0 0 0 0-1l-9-5.8a.6.6 0 0 0-.9.5z" fill="currentColor"/></svg>`,
  sun: svg(`<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2.5M12 19v2.5M2.5 12H5M19 12h2.5M5.3 5.3l1.8 1.8M16.9 16.9l1.8 1.8M5.3 18.7l1.8-1.8M16.9 7.1l1.8-1.8"/>`),
  moon: svg(`<path d="M19 14.5A7.5 7.5 0 0 1 9.5 5a7.5 7.5 0 1 0 9.5 9.5z"/>`),
  cloud: svg(`<path d="M7 18h10a4 4 0 0 0 .6-7.95A5.5 5.5 0 0 0 7.1 9.6 4.2 4.2 0 0 0 7 18z"/>`),
  rain: svg(`${CLOUD}<path d="M8.5 17l-1 2.5M12.5 17l-1 2.5M16.5 17l-1 2.5"/>`),
  storm: svg(`${CLOUD}<path d="M12.5 15.5l-2.5 3h3l-2 3.5"/>`),
  snow: svg(`<path d="M12 3v18M4.2 7.5l15.6 9M4.2 16.5l15.6-9M9.5 4.5L12 6l2.5-1.5M9.5 19.5L12 18l2.5 1.5"/>`),
};
async function control(body) {
  const r = await fetch("api/control", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  applyControl(await r.json());
}
function applyControl(c) {
  S.control = c; tickMs = 500 / c.speed;
  $("#play").innerHTML = c.paused ? ICON.play : ICON.pause;
  $("#play").setAttribute("aria-label", c.paused ? "Play" : "Pause");
  $("#speed").textContent = `${c.speed}×`;
}
$("#play").onclick = () => control({ paused: !S.control.paused });
$("#speed").onclick = () => control({ speed: { 1: 2, 2: 4, 4: 8, 8: 1 }[S.control.speed] });
$("#fit").onclick = fit;

const COMPASS = ["east", "southeast", "south", "southwest", "west", "northwest", "north", "northeast"];
function skyIcon(wx, night) {
  if (!wx || wx.sky === "clear") return night ? "moon" : "sun";
  if (wx.sky === "cloudy") return "cloud";
  return snowFalls(wx) ? "snow" : wx.sky === "storm" ? "storm" : "rain";
}
function skyText(wx) {
  const snow = snowFalls(wx);
  const word = { clear: "Clear", cloudy: "Cloudy", rain: snow ? "Snow" : "Rain", storm: snow ? "Blizzard" : "Storm" }[wx.sky] ?? cap(wx.sky);
  const temp = `${Math.round(wx.temp)}°C`, dx = wx.wind?.dx ?? 0, dy = wx.wind?.dy ?? 0, wind = Math.hypot(dx, dy);
  const from = COMPASS[(((Math.round(Math.atan2(-dy, -dx) / (Math.PI / 4))) % 8) + 8) % 8];
  const title = [
    `${cap(wx.season)}, day ${(wx.dayOfYear % 10) + 1} of 10, year ${wx.year}`,
    `${word}, ${temp}`,
    wind > 0.15 ? `${wind < 0.4 ? "Light" : wind < 0.75 ? "Steady" : "Strong"} wind from the ${from}` : "Calm",
    wx.drought ? "Drought" : "",
  ].filter(Boolean).join(". ");
  return { season: cap(wx.season), word: wx.drought ? `${word}, dry` : word, temp, title };
}
let lastPhase = null, lastSky = null;
function renderStatus() {
  const phase = skyIcon(S.weather, nightAmount(S.t) > 0.5);
  if (phase !== lastPhase) { $("#phase").innerHTML = ICON[phase]; lastPhase = phase; }
  $("#day").textContent = `Day ${dayOf(S.t)}`;
  $("#time").textContent = hhmm(S.t);
  const sky = S.weather && skyText(S.weather), key = sky ? sky.title : "";
  if (key !== lastSky) {
    lastSky = key;
    $("#sky").hidden = !sky;
    if (sky) {
      $("#sky").innerHTML = `<span class="sky-season">${esc(sky.season)}</span><span class="sky-wx"><span class="sky-word">${esc(sky.word)}, </span>${esc(sky.temp)}</span>`;
      $("#sky").title = sky.title;
    }
  }
  if (S.jev) $("#jev").textContent = `${S.jev.calls.toLocaleString()} Jev calls, $${((S.jev.tokens * 0.042) / 1e6).toFixed(4)}`;
}

// ---------- stream ----------
// The living roster: people who died drop out, newborns join. Returns whether anyone came or went.
function setAgents(list, init) {
  const seen = new Set();
  let changed = false;
  for (const a of list) {
    const prev = S.agents.get(a.id);
    if (!prev) changed = true;
    seen.add(a.id);
    S.agents.set(a.id, { ...a, px: init || !prev ? a.x : prev.x, py: init || !prev ? a.y : prev.y });
  }
  for (const id of [...S.agents.keys()]) if (!seen.has(id)) { S.agents.delete(id); changed = true; }
  if (selected && !S.agents.has(selected)) {
    select(null);
    if (sheetOpen() && !$("#inspect").hidden) loadInspector();
  }
  return changed;
}
// Animals arrive as a full list each tick; keep last position to interpolate and the way they face.
function setAnimals(list, init) {
  const next = new Map();
  for (const an of list) {
    const prev = !init && S.animals.get(an.id);
    const px = prev ? prev.x : an.x, py = prev ? prev.y : an.y, dx = an.x - px;
    next.set(an.id, { ...an, px, py, dir: dx > 0 ? 1 : dx < 0 ? -1 : prev ? prev.dir : hash(an.x, an.y, 5) < 0.5 ? -1 : 1 });
  }
  S.animals = next;
  if (picked?.type === "animal" && !next.has(picked.id)) picked = null;
}
function connect() {
  const src = new EventSource("api/stream");
  src.onopen = () => { $("#banner").hidden = true; };
  src.onerror = () => { $("#banner").textContent = "Reconnecting…"; $("#banner").hidden = false; };
  src.onmessage = async (m) => {
    const msg = JSON.parse(m.data);
    if (msg.type === "init") {
      S.W = Math.round(Math.sqrt(msg.tiles.length)); S.H = msg.tiles.length / S.W; S.tiles = msg.tiles; S.heights = msg.heights; S.land = readTerrain(msg.terrain); S.t = msg.t; S.jev = msg.jev;
      S.kinds = { ...(msg.kinds ?? {}) }; S.weather = msg.weather ?? null; S.groups = msg.groups ?? [];
      S.paths = parsePaths(msg.paths, S.W * S.H);
      S.ice = parseIce(msg.ice, S.W * S.H);
      S.things.clear(); S.byTile.clear(); S.hot.clear(); S.graves.clear(); S.caught.clear();
      for (const th of msg.things) putThing(th);
      S.agents.clear(); setAgents(msg.agents, true);
      setAnimals(msg.animals ?? [], true);
      loadPeople();
      feed.length = 0; feed.push(...msg.events);
      await document.fonts.load('20px "IM Fell English"').catch(() => {});
      buildLayer(); applyControl(msg.control);
      if (!cam.init) { cam.init = true; resize(); fit(); }
      renderDock(); renderFocus(); renderFilters(); renderFeed(); renderStatus();
      document.body.classList.add("ready");
      return;
    }
    if (msg.type === "control") return applyControl(msg.control);
    if (!base) return;
    lastTickAt = performance.now();
    S.t = msg.t; S.jev = msg.jev;
    if (msg.weather) S.weather = msg.weather;
    if (msg.kinds) Object.assign(S.kinds, msg.kinds);
    if (msg.groups) S.groups = msg.groups;
    if (setAgents(msg.agents)) { renderFilters(); loadPeople(); }
    if (msg.animals) setAnimals(msg.animals);
    const touched = [];
    for (const id of msg.removed ?? []) {
      const th = dropThing(id);
      if (th) touched.push(th);
    }
    for (const th of msg.things ?? []) {
      const old = S.things.get(th.id);
      if (old && (old.x !== th.x || old.y !== th.y)) touched.push(old);
      putThing(th); touched.push(th);
    }
    for (const th of touched) paint(glyphRect(th.x, th.y));
    for (const p of msg.paths ?? []) {
      if (!S.paths || S.paths[p.i] === p.v) continue;
      S.paths[p.i] = p.v;
      const x = p.i % S.W, y = Math.floor(p.i / S.W);
      paintGround(x - 1, y - 1, x + 1, y + 1); paint(tileRect(x - 1, y - 1, x + 1, y + 1));
    }
    if (msg.ice) setIce(msg.ice);
    const events = msg.events ?? [];
    if (events.length) {
      feed.push(...events);
      if (feed.length > 2000) feed.splice(0, feed.length - 2000);
      prependEvents($("#feed"), events.filter((e) => !filter || e.who.includes(filter)));
      const mine = events.filter((e) => selected && e.who.includes(selected));
      if (mine.length && $("#ins-history")) { insHistory.push(...mine); prependEvents($("#ins-history"), mine); }
      const bolt = events.filter((e) => e.kind === "lightning").pop();
      if (bolt) flash = { at: performance.now(), x: bolt.x, y: bolt.y, seed: Math.floor(Math.random() * 1e4) };
    }
    renderDock(); renderFocus();
    renderStatus();
  };
}

window.addEventListener("resize", () => { resize(); clampCam(); });
resize();
connect();
requestAnimationFrame(frame);
