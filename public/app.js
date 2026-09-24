import { T, buildBase, drawThing, drawFire, drawToken, drawLabel, drawThinking, drawSleep, hash } from "./art.js";

const $ = (s) => document.querySelector(s);
const DAY = 288;
const NEEDS = ["food", "energy", "warmth", "social", "health"];
const ROUTINE = new Set(["gather", "eat", "goal", "stuck", "fail", "fire_out", "wake", "level", "craft", "tinker", "hint"]);
const NOTABLE = new Set(["bond", "steal", "lie", "take", "insult", "build", "collapse", "discover", "learn", "teach"]);
const HOME_KINDS = new Set(["lean_to", "log_hut", "cabin"]);
let RECIPES = {}; // id -> recipe, loaded once from the server

const S = { W: 0, H: 0, tiles: "", things: new Map(), byTile: new Map(), agents: new Map(), t: 0, jev: null, control: { paused: false, speed: 1 } };
const cam = { x: 32, y: 32, s: 10 };
let selected = null, follow = false, filter = null, tickMs = 500, lastTickAt = performance.now();
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const human = (s) => (s ?? "").replaceAll("_", " ");
const nameOf = (id) => S.agents.get(id)?.name ?? id;
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
const seal = (a, size = "") => `<span class="seal ${size}" style="--c:${a.color}" aria-hidden="true">${esc(a.name[0])}</span>`;

// ---------- map layer ----------
let base = null;
const layer = document.createElement("canvas");
const lctx = layer.getContext("2d");
function indexThing(th, add) {
  const k = `${th.x},${th.y}`;
  if (!S.byTile.has(k)) S.byTile.set(k, new Set());
  if (add) S.byTile.get(k).add(th.id); else S.byTile.get(k).delete(th.id);
}
// Glyphs spill over their tile, so repaint a small block and every thing that can reach into it.
function paint(x0, y0, x1, y1) {
  const px = x0 * T, py = y0 * T, w = (x1 - x0 + 1) * T, h = (y1 - y0 + 1) * T;
  lctx.save();
  lctx.beginPath(); lctx.rect(px, py, w, h); lctx.clip();
  lctx.drawImage(base, px, py, w, h, px, py, w, h);
  const list = [];
  for (let y = y0 - 2; y <= y1 + 2; y++)
    for (let x = x0 - 2; x <= x1 + 2; x++)
      for (const id of S.byTile.get(`${x},${y}`) ?? []) {
        const th = S.things.get(id);
        if (th && th.kind !== "fire") list.push(th);
      }
  list.sort((a, b) => a.y - b.y || a.x - b.x);
  for (const th of list) drawThing(lctx, th, HOME_KINDS.has(th.kind) ? S.agents.get(th.owner)?.color : null);
  lctx.restore();
}
function buildLayer() {
  base = buildBase(S.tiles, S.W, S.H);
  layer.width = S.W * T; layer.height = S.H * T;
  paint(0, 0, S.W - 1, S.H - 1);
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
const toScreen = (x, y) => [(x - cam.x) * cam.s + cw / 2, (y - cam.y) * cam.s + ch / 2];
const toWorld = (px, py) => [(px - cw / 2) / cam.s + cam.x, (py - ch / 2) / cam.s + cam.y];
function agentPos(a) {
  const k = Math.min(1, (performance.now() - lastTickAt) / tickMs);
  return [a.px + (a.x - a.px) * k + 0.5, a.py + (a.y - a.py) * k + 0.5];
}

function frame(now) {
  if (selected && follow) {
    const a = S.agents.get(selected);
    if (a) {
      const [x, y] = agentPos(a);
      cam.x += (x + rightCover() / 2 / cam.s - cam.x) * 0.2;
      cam.y += (y + bottomCover() / 2 / cam.s - cam.y) * 0.2;
      clampCam();
    }
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = "#1d1610";
  ctx.fillRect(0, 0, cw, ch);
  if (base) {
    const [ox, oy] = toScreen(0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(layer, ox, oy, S.W * cam.s, S.H * cam.s);
    ctx.strokeStyle = "rgba(58, 42, 26, .9)"; ctx.lineWidth = 2;
    ctx.strokeRect(ox - 1, oy - 1, S.W * cam.s + 2, S.H * cam.s + 2);
    const night = nightAmount(S.t);
    if (night > 0) {
      ctx.globalCompositeOperation = "multiply";
      ctx.fillStyle = `rgba(70, 82, 140, ${0.75 * night})`;
      ctx.fillRect(ox, oy, S.W * cam.s, S.H * cam.s);
      ctx.globalCompositeOperation = "source-over";
    }
    for (const th of S.things.values()) {
      if (th.kind !== "fire" && th.kind !== "hearth") continue;
      const [fx, fy] = toScreen(th.x + 0.5, th.y + 0.5);
      if (fx < -200 || fy < -200 || fx > cw + 200 || fy > ch + 200) continue;
      const glow = ctx.createRadialGradient(fx, fy, 0, fx, fy, cam.s * (2.5 + night * 2));
      const flick = 0.85 + Math.sin(now / 90 + th.x) * 0.08;
      glow.addColorStop(0, `rgba(255, 176, 90, ${(0.25 + night * 0.4) * flick})`);
      glow.addColorStop(1, "rgba(255, 176, 90, 0)");
      ctx.globalCompositeOperation = "screen";
      ctx.fillStyle = glow;
      ctx.fillRect(fx - cam.s * 5, fy - cam.s * 5, cam.s * 10, cam.s * 10);
      ctx.globalCompositeOperation = "source-over";
      if (th.kind === "fire") drawFire(ctx, fx, fy + cam.s * 0.1, cam.s * 0.9, now, hash(th.x, th.y));
      else drawFire(ctx, fx, fy - cam.s * 0.02, cam.s * 0.45, now, hash(th.x, th.y), true);
    }
    drawAgents(now);
  }
  requestAnimationFrame(frame);
}

function drawAgents(now) {
  const r = Math.max(8, Math.min(20, cam.s * 0.42));
  const sel = selected && S.agents.get(selected);
  if (sel?.target && S.agents.get(sel.target)) {
    const [ax, ay] = toScreen(...agentPos(sel)), [bx, by] = toScreen(...agentPos(S.agents.get(sel.target)));
    ctx.setLineDash([2, 6]); ctx.lineCap = "round"; ctx.strokeStyle = "rgba(168, 50, 31, .85)"; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke(); ctx.setLineDash([]);
  }
  const list = [...S.agents.values()].sort((a, b) => agentPos(a)[1] - agentPos(b)[1]);
  const labels = [];
  for (const a of list) {
    let [x, y] = toScreen(...agentPos(a));
    if (x < -60 || y < -60 || x > cw + 60 || y > ch + 60) continue;
    const walking = a.px !== a.x || a.py !== a.y;
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

// ---------- camera input ----------
// Keep the visible area inside the map; the HUD and sheet count as margin you can scroll under.
const clampCam = () => {
  const min = Math.min(cw / S.W, ch / S.H) * 0.7;
  cam.s = Math.max(min, Math.min(90, cam.s));
  const axis = (c, size, view, extra) => {
    const half = view / 2 / cam.s, pad = extra / cam.s;
    return size + pad > 2 * half ? Math.max(half, Math.min(size - half + pad, c)) : size / 2 + pad / 2;
  };
  cam.x = axis(cam.x, S.W, cw, rightCover());
  cam.y = axis(cam.y, S.H, ch, bottomCover());
};
function zoomAt(px, py, f) {
  const [wx, wy] = toWorld(px, py);
  cam.s *= f; clampCam();
  const [nx, ny] = toWorld(px, py);
  cam.x += wx - nx; cam.y += wy - ny; clampCam();
}
const panel = $("#panel");
const phone = () => window.innerWidth < 820;
const sheetOpen = () => panel.dataset.open === "true";
// Pixels of map hidden under the HUD or the sheet, so the camera can frame what's still visible.
const bottomCover = () => (phone() && sheetOpen() ? panel.offsetHeight : $("#hud").offsetHeight);
const rightCover = () => (!phone() && sheetOpen() ? panel.offsetWidth : 0);
function fit() {
  const b = bottomCover(), r = rightCover();
  cam.s = Math.min((cw - r) / S.W, (ch - b) / S.H) * 0.96;
  cam.x = S.W / 2 + r / 2 / cam.s; cam.y = S.H / 2 + b / 2 / cam.s;
  setFollow(false);
}
const pointers = new Map();
let gesture = null;
canvas.addEventListener("pointerdown", (e) => {
  canvas.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, { x: e.offsetX, y: e.offsetY });
  gesture = { moved: false, start: { x: e.offsetX, y: e.offsetY }, dist: null };
});
canvas.addEventListener("pointermove", (e) => {
  const p = pointers.get(e.pointerId);
  if (!p) return;
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
  let best = null, bd = Math.max(24, cam.s * 0.7);
  for (const a of S.agents.values()) {
    const [x, y] = toScreen(...agentPos(a));
    const d = Math.hypot(x - px, y - py);
    if (d < bd) { best = a; bd = d; }
  }
  if (best) select(best.id);
  else if (selected) select(null);
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
  for (const id of ["chronicle", "inspect", "book"]) $(`#${id}`).hidden = id !== tab;
  if (tab === "book") loadBook();
}
$("#tabs").addEventListener("click", (e) => { const t = e.target.closest("button[data-tab]")?.dataset.tab; if (t) openSheet(t); });
$("#close").onclick = closeSheet;
$("#open-chronicle").onclick = () => (sheetOpen() && !$("#chronicle").hidden ? closeSheet() : openSheet("chronicle"));

// ---------- selection, focus card, dock ----------
function select(id) {
  selected = id;
  follow = !!id;
  if (id) cam.s = Math.max(cam.s, 24);
  renderDock(); renderFocus();
  if (id && sheetOpen() && !$("#inspect").hidden) loadInspector();
  if (id) $(`#dock [data-id="${id}"]`)?.scrollIntoView({ inline: "nearest", block: "nearest", behavior: "smooth" });
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
function renderDock() {
  $("#dock").innerHTML = [...S.agents.values()].map((a) => `
    <button type="button" class="card ${a.id === selected ? "on" : ""}" data-id="${a.id}" aria-pressed="${a.id === selected}">
      <span class="card-top">${seal(a, "sm")}<span class="card-name">${esc(a.name)}</span></span>
      <span class="card-status ${a.thinking ? "thinking" : ""}">${esc(doing(a))}</span>
      ${needBars(a.needs)}
    </button>`).join("");
}
$("#dock").addEventListener("click", (e) => { const id = e.target.closest(".card")?.dataset.id; if (id) select(id === selected ? null : id); });
function renderFocus() {
  const a = selected && S.agents.get(selected);
  $("#focus").hidden = !a;
  if (!a) return;
  $("#focus").innerHTML = `
    <div class="focus-head">${seal(a)}<div class="focus-title"><h2>${esc(a.name)}</h2>
      <p class="focus-status ${a.thinking ? "thinking" : ""}">${esc(doing(a))}</p></div>
      <button type="button" class="ghost" id="focus-ledger">Ledger</button>
      <button type="button" class="icon-btn" id="focus-close" aria-label="Deselect"><svg viewBox="0 0 24 24" width="18" height="18"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg></button></div>
    ${a.goal ? `<p class="focus-goal">Goal: ${human(a.goal)}${a.target ? ` with ${esc(nameOf(a.target))}` : ""}</p>` : ""}
    ${needBars(a.needs, true)}`;
  $("#focus-ledger").onclick = () => openSheet("inspect");
  $("#focus-close").onclick = () => select(null);
}

// ---------- chronicle ----------
const tone = (k) => (k === "invent" ? "invention" : NOTABLE.has(k) ? "notable" : ROUTINE.has(k) ? "routine" : "social");
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
function renderFilters() {
  $("#filters").innerHTML = `<button type="button" aria-pressed="${!filter}" data-f="">Everyone</button>` +
    [...S.agents.values()].map((a) => `<button type="button" aria-pressed="${filter === a.id}" data-f="${a.id}">${seal(a, "xs")}${esc(a.name)}</button>`).join("");
}
function renderFeed() {
  $("#feed").innerHTML = eventList(feed.filter((e) => !filter || e.who.includes(filter)).slice(-300));
}
$("#filters").addEventListener("click", (e) => { const b = e.target.closest("button"); if (!b) return; filter = b.dataset.f || null; renderFilters(); renderFeed(); });
function jumpTo(e) {
  const b = e.target.closest("li.ev button");
  if (!b) return;
  cam.s = Math.max(cam.s, 28);
  cam.x = +b.dataset.x + 0.5 + rightCover() / 2 / cam.s; cam.y = +b.dataset.y + 0.5 + bottomCover() / 2 / cam.s;
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
const cap = (t) => t[0].toUpperCase() + t.slice(1);
function stepText(s, a) {
  if (s.op === "craft") return cap(RECIPES[s.arg]?.label ?? s.arg);
  if (s.op === "goto") return `Go to ${s.arg === "agent" ? nameOf(a.goal?.target) : human(s.arg)}`;
  if (s.op === "social") return `${cap(human(s.arg))} with ${nameOf(a.goal?.target)}`;
  if (s.op === "tinker") return s.arg ? `Try ${s.arg.split("|")[0]}` : "Tinker";
  if (s.op === "wander") return "Explore";
  return cap(human(s.op));
}

// ---------- discoveries ----------
let bookTimer = null;
const itemText = (inv) => Object.entries(inv ?? {}).map(([i, n]) => `${n} ${human(i)}`).join(", ");
async function loadBook() {
  clearInterval(bookTimer);
  const draw = async () => {
    if ($("#book").hidden || !sheetOpen()) return clearInterval(bookTimer);
    const k = await fetch("api/knowledge").then((r) => r.json());
    RECIPES = Object.fromEntries(k.recipes.map((r) => [r.id, r]));
    const crafts = [...new Set(k.recipes.map((r) => r.craft))];
    const found = Object.keys(k.inventions).length;
    const scroll = $("#book").scrollTop;
    $("#book").innerHTML = `<p class="book-count"><b>${found}</b> of ${k.recipes.length} discovered</p>` + crafts.map((craft) => `
      <section class="sec"><h3>${esc(cap(craft))}</h3>${k.recipes.filter((r) => r.craft === craft).map((r) => {
        const inv = k.inventions[r.id];
        const knowers = k.agents.filter((x) => x.know[r.id]);
        const close = k.agents.filter((x) => !x.know[r.id] && x.clues[r.id] > 0);
        const needs = [itemText(r.inputs), r.tools?.length ? `using ${r.tools.map(human).join(" and ")}` : "", r.near ? `at the ${human(r.near)}` : ""].filter(Boolean).join(", ");
        const makes = r.makes.item ? `${r.makes.n ?? 1} ${human(r.makes.item)}` : human(r.makes.thing);
        return `<article class="rc ${inv ? "found" : ""}">
          <div class="rc-top"><span class="rc-name">${esc(cap(r.label))}</span><span class="rc-makes">${esc(makes)}</span></div>
          <p class="rc-needs">${esc(needs)}</p>
          <div class="rc-who">
            ${inv ? `<span class="rc-first">First by ${esc(nameOf(inv.by))}, ${clockText(inv.t)}</span>` : `<span class="rc-first none">Not yet discovered</span>`}
            <span class="rc-seals">${knowers.map((x) => {
              const a = S.agents.get(x.id), how = x.know[r.id];
              return a ? `<span title="${esc(a.name)}: ${how.how}${how.from ? ` from ${esc(nameOf(how.from))}` : ""}">${seal(a, "xs")}</span>` : "";
            }).join("")}${close.map((x) => {
              const a = S.agents.get(x.id);
              return a ? `<span class="trying" style="--p:${Math.min(1, x.clues[r.id] / 2.5)}" title="${esc(a.name)} is getting closer">${seal(a, "xs")}</span>` : "";
            }).join("")}</span>
          </div>
        </article>`;
      }).join("")}</section>`).join("");
    $("#book").scrollTop = scroll;
  };
  await draw();
  bookTimer = setInterval(draw, 3000);
}
function renderInspector() {
  const a = insData;
  if (!a || !$("#ins-body")) return;
  const d = a.lastDecision;
  const plan = a.plan ?? [];
  const inv = Object.entries(a.inv).filter(([, n]) => n);
  const rels = Object.entries(a.rel).sort((x, y) => Math.abs(y[1].affinity) - Math.abs(x[1].affinity));
  const trained = Object.entries(a.skills).filter(([, xp]) => xp > 0).sort((x, y) => y[1] - x[1]);
  const known = Object.entries(a.know).sort((x, y) => x[1].t - y[1].t);
  $("#ins-sub").textContent = a.home ? "Has a shelter" : "Wandering, no home";
  const scroll = $("#inspect").scrollTop;
  $("#ins-body").innerHTML = `
    <section class="sec"><p class="bio">${esc(a.bio)}</p></section>
    <section class="sec"><h3>Right now</h3>
      <p class="now">${a.down ? "Unconscious" : esc(a.status)}</p>
      ${a.goal ? `<p class="muted">Goal: ${human(a.goal.type)}${a.goal.target ? `, with ${esc(nameOf(a.goal.target))}` : ""}</p>` : ""}
      ${plan.length ? `<ol class="plan">${plan.map((s, i) => `<li class="${i === 0 ? "cur" : ""}">${esc(stepText(s, a))}</li>`).join("")}</ol>` : ""}
    </section>
    ${d ? `<section class="sec"><h3>Last choice</h3><p class="muted">At ${clockText(d.t)}, Jev gave these odds for what ${esc(a.name)} would do next.</p>
      <ol class="odds">${oddsRows(d.goal, d.chosen)}</ol>
      ${d.who ? `<p class="muted gap">And who with:</p><ol class="odds">${oddsRows(d.who, d.target, nameOf)}</ol>` : ""}</section>` : ""}
    <section class="sec"><h3>Needs</h3>${needBars(a.needs, true)}</section>
    <section class="sec"><h3>Nature</h3>
      <ul class="tags">${Object.entries(a.traits).sort((x, y) => y[1] - x[1]).map(([t, s]) => `<li style="--s:${s}">${esc(t)}</li>`).join("")}</ul>
      <p class="muted gap">Wants to ${a.desires.map(esc).join(", and to ")}.</p></section>
    <section class="sec two">
      <div><h3>Carrying</h3>${inv.length ? `<dl class="kv">${inv.map(([i, n]) => `<dt>${i}</dt><dd>${n}</dd>`).join("")}</dl>` : `<p class="muted">Nothing</p>`}</div>
      <div><h3>Skills</h3>${trained.length ? `<dl class="kv">${trained.map(([s, xp]) => `<dt>${s}</dt><dd>Level ${lvl(xp)} <small>${Math.round(xp)} xp</small></dd>`).join("")}</dl>` : `<p class="muted">None yet</p>`}</div>
    </section>
    <section class="sec"><h3>Know-how</h3>${known.length ? `<ul class="knowhow">${known.map(([id, k]) => `<li><span>${esc(cap(RECIPES[id]?.label ?? id))}</span><small>${k.how === "discovered" ? "worked it out" : k.how === "watched" ? `watched ${esc(nameOf(k.from))}` : `taught by ${esc(nameOf(k.from))}`}, ${clockText(k.t)}</small></li>`).join("")}</ul>` : `<p class="muted">Doesn't know how to make anything yet.</p>`}</section>
    <section class="sec"><h3>Relationships</h3>${rels.length ? rels.map(([id, r]) => {
      const other = S.agents.get(id);
      const beliefs = Object.entries(r.beliefs).filter(([, v]) => v > 0.65 || v < 0.35).map(([k, v]) => (v > 0.65 ? k : `not ${k}`));
      return `<article class="rel">
        <header>${other ? seal(other, "sm") : ""}<span class="rn">${esc(nameOf(id))}</span><span class="label">${human(r.label)}</span></header>
        ${meter("feeling", r.affinity, true)}${meter("trust", r.trust)}
        ${r.bonds.length ? `<ul class="bonds">${[...r.bonds].sort((x, y) => y.weight - x.weight).map((b) => `<li style="opacity:${(0.5 + b.weight * 0.5).toFixed(2)}">${human(b.kind)}<small>${clockText(b.t)}</small></li>`).join("")}</ul>` : ""}
        ${beliefs.length ? `<p class="beliefs">Believes ${esc(nameOf(id))} is ${beliefs.join(", ")}.</p>` : ""}
        ${r.ledger ? `<p class="beliefs">${r.ledger > 0 ? `Owes ${esc(nameOf(id))} ${r.ledger} favor${r.ledger > 1 ? "s" : ""}.` : `${esc(nameOf(id))} owes ${-r.ledger} favor${r.ledger < -1 ? "s" : ""}.`}</p>` : ""}
        ${r.history.length ? `<ul class="hist">${r.history.slice(-4).reverse().map((h) => `<li>${esc(h)}</li>`).join("")}</ul>` : ""}
      </article>`;
    }).join("") : `<p class="muted">Hasn't met anyone yet.</p>`}</section>`;
  $("#inspect").scrollTop = scroll;
}

// ---------- controls ----------
const ICON = {
  pause: `<svg viewBox="0 0 24 24" width="20" height="20"><path d="M9 6v12M15 6v12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`,
  play: `<svg viewBox="0 0 24 24" width="20" height="20"><path d="M8.5 6.2v11.6a.6.6 0 0 0 .9.5l9-5.8a.6.6 0 0 0 0-1l-9-5.8a.6.6 0 0 0-.9.5z" fill="currentColor"/></svg>`,
  sun: `<svg viewBox="0 0 24 24" width="18" height="18"><circle cx="12" cy="12" r="4" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M12 2.5v2.5M12 19v2.5M2.5 12H5M19 12h2.5M5.3 5.3l1.8 1.8M16.9 16.9l1.8 1.8M5.3 18.7l1.8-1.8M16.9 7.1l1.8-1.8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>`,
  moon: `<svg viewBox="0 0 24 24" width="18" height="18"><path d="M19 14.5A7.5 7.5 0 0 1 9.5 5a7.5 7.5 0 1 0 9.5 9.5z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>`,
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

let lastPhase = null;
function renderStatus() {
  const phase = nightAmount(S.t) > 0.5 ? "moon" : "sun";
  if (phase !== lastPhase) { $("#phase").innerHTML = ICON[phase]; lastPhase = phase; }
  $("#day").textContent = `Day ${dayOf(S.t)}`;
  $("#time").textContent = hhmm(S.t);
  if (S.jev) $("#jev").textContent = `${S.jev.calls.toLocaleString()} Jev calls, $${((S.jev.tokens * 0.042) / 1e6).toFixed(4)}`;
}

// ---------- stream ----------
function setAgents(list, init) {
  for (const a of list) {
    const prev = S.agents.get(a.id);
    S.agents.set(a.id, { ...a, px: init || !prev ? a.x : prev.x, py: init || !prev ? a.y : prev.y });
  }
}
function connect() {
  const src = new EventSource("api/stream");
  src.onopen = () => { $("#banner").hidden = true; };
  src.onerror = () => { $("#banner").textContent = "Reconnecting…"; $("#banner").hidden = false; };
  src.onmessage = async (m) => {
    const msg = JSON.parse(m.data);
    if (msg.type === "init") {
      S.W = 64; S.H = msg.tiles.length / 64; S.tiles = msg.tiles; S.t = msg.t; S.jev = msg.jev;
      S.things.clear(); S.byTile.clear();
      for (const th of msg.things) { S.things.set(th.id, th); indexThing(th, true); }
      S.agents.clear(); setAgents(msg.agents, true);
      feed.length = 0; feed.push(...msg.events);
      await document.fonts.load('20px "IM Fell English"').catch(() => {});
      buildLayer(); applyControl(msg.control);
      if (!cam.init) { cam.init = true; resize(); fit(); }
      renderDock(); renderFilters(); renderFeed(); renderStatus();
      fetch("api/knowledge").then((r) => r.json()).then((k) => { RECIPES = Object.fromEntries(k.recipes.map((r) => [r.id, r])); });
      document.body.classList.add("ready");
      return;
    }
    if (msg.type === "control") return applyControl(msg.control);
    if (!base) return;
    lastTickAt = performance.now();
    S.t = msg.t; S.jev = msg.jev;
    setAgents(msg.agents);
    const touched = [];
    for (const id of msg.removed) {
      const th = S.things.get(id);
      if (th) { indexThing(th, false); S.things.delete(id); touched.push(th); }
    }
    for (const th of msg.things) {
      const old = S.things.get(th.id);
      if (old) indexThing(old, false);
      S.things.set(th.id, th); indexThing(th, true);
      touched.push(th);
    }
    for (const th of touched) paint(Math.max(0, th.x - 1), Math.max(0, th.y - 2), Math.min(S.W - 1, th.x + 1), Math.min(S.H - 1, th.y + 1));
    if (msg.events.length) {
      feed.push(...msg.events);
      if (feed.length > 2000) feed.splice(0, feed.length - 2000);
      prependEvents($("#feed"), msg.events.filter((e) => !filter || e.who.includes(filter)));
      const mine = msg.events.filter((e) => selected && e.who.includes(selected));
      if (mine.length && $("#ins-history")) { insHistory.push(...mine); prependEvents($("#ins-history"), mine); }
    }
    renderDock(); renderFocus();
    renderStatus();
  };
}

window.addEventListener("resize", () => { resize(); clampCam(); });
resize();
connect();
requestAnimationFrame(frame);
