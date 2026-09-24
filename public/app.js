const $ = (s) => document.querySelector(s);
const TILE = 32; // pixels per tile in the prerendered map layer
const DAY = 288;
const TERRAIN = ["#9dbb62", "#5b8a3f", "#4c7fa8", "#a39c8b"];
const EMOJI = { tree: "🌲", stump: "🪵", mushroom: "🍄", stone: "🪨", fire: "🔥", shelter: "⛺" };
const NEEDS = ["food", "energy", "warmth", "social", "health"];

const S = { W: 0, H: 0, tiles: "", things: new Map(), byTile: new Map(), agents: new Map(), t: 0, jev: null, control: { paused: false, speed: 1 } };
const cam = { x: 32, y: 32, s: 10 };
let selected = null, follow = false, filter = null, tickMs = 500, lastTickAt = performance.now();
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const human = (s) => (s ?? "").replaceAll("_", " ");
const nameOf = (id) => S.agents.get(id)?.name ?? id;

function clockText(t) {
  const day = Math.floor(t / DAY) + 1;
  const mins = Math.floor(((t % DAY) / DAY) * 24 * 60);
  const h = Math.floor(mins / 60), m = mins % 60;
  return `Day ${day} · ${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}
const nightAmount = (t) => {
  const h = ((t % DAY) / DAY) * 24;
  if (h >= 21 || h < 4) return 1;
  if (h >= 19) return (h - 19) / 2;
  if (h < 6) return 1 - (h - 4) / 2;
  return 0;
};

// ---------- map layer ----------
const layer = document.createElement("canvas");
const lctx = layer.getContext("2d");
function hash(x, y) { let h = x * 374761393 + y * 668265263; h = (h ^ (h >> 13)) * 1274126177; return ((h ^ (h >> 16)) >>> 0) / 4294967296; }
function shade(hex, k) {
  const n = parseInt(hex.slice(1), 16);
  const f = (c) => Math.max(0, Math.min(255, Math.round(c * k)));
  return `rgb(${f(n >> 16)},${f((n >> 8) & 255)},${f(n & 255)})`;
}
function drawTile(x, y) {
  const t = +S.tiles[y * S.W + x];
  lctx.fillStyle = shade(TERRAIN[t], 0.93 + hash(x, y) * 0.14);
  lctx.fillRect(x * TILE, y * TILE, TILE, TILE);
  for (const id of S.byTile.get(`${x},${y}`) ?? []) {
    const th = S.things.get(id);
    if (!th) continue;
    const cx = x * TILE + TILE / 2, cy = y * TILE + TILE / 2;
    if (th.kind === "stick") {
      lctx.strokeStyle = "#6b4a2b"; lctx.lineWidth = 3; lctx.lineCap = "round";
      lctx.beginPath(); lctx.moveTo(cx - 8, cy + 6); lctx.lineTo(cx + 8, cy - 5); lctx.stroke();
      continue;
    }
    const e = th.kind === "bush" ? (th.n ? "🫐" : "🌿") : EMOJI[th.kind];
    const size = { tree: 26, shelter: 28, fire: 24 }[th.kind] ?? 18;
    lctx.font = `${size}px serif`;
    lctx.textAlign = "center"; lctx.textBaseline = "middle";
    lctx.fillText(e, cx, cy + 1);
  }
}
function indexThing(th, add) {
  const k = `${th.x},${th.y}`;
  if (!S.byTile.has(k)) S.byTile.set(k, new Set());
  if (add) S.byTile.get(k).add(th.id); else S.byTile.get(k).delete(th.id);
}
function buildLayer() {
  layer.width = S.W * TILE; layer.height = S.H * TILE;
  for (let y = 0; y < S.H; y++) for (let x = 0; x < S.W; x++) drawTile(x, y);
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

function frame() {
  if (selected && follow) {
    const a = S.agents.get(selected);
    if (a) {
      const [x, y] = agentPos(a);
      cam.x = x; cam.y = y + sheetCover() / 2 / cam.s;
    }
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = "#3b6a8f";
  ctx.fillRect(0, 0, cw, ch);
  if (S.W) {
    const [ox, oy] = toScreen(0, 0);
    ctx.imageSmoothingEnabled = cam.s < TILE;
    ctx.drawImage(layer, ox, oy, S.W * cam.s, S.H * cam.s);
    const night = nightAmount(S.t);
    if (night > 0) {
      ctx.fillStyle = `rgba(18, 24, 58, ${0.45 * night})`;
      ctx.fillRect(0, 0, cw, ch);
      for (const th of S.things.values()) {
        if (th.kind !== "fire") continue;
        const [fx, fy] = toScreen(th.x + 0.5, th.y + 0.5);
        const g = ctx.createRadialGradient(fx, fy, 0, fx, fy, cam.s * 3.5);
        g.addColorStop(0, `rgba(255, 170, 70, ${0.45 * night})`);
        g.addColorStop(1, "rgba(255, 170, 70, 0)");
        ctx.fillStyle = g;
        ctx.fillRect(fx - cam.s * 4, fy - cam.s * 4, cam.s * 8, cam.s * 8);
      }
    }
    drawAgents();
  }
  requestAnimationFrame(frame);
}

function drawAgents() {
  const r = Math.max(11, cam.s * 0.5);
  const sel = selected && S.agents.get(selected);
  if (sel?.target && S.agents.get(sel.target)) {
    const [ax, ay] = toScreen(...agentPos(sel)), [bx, by] = toScreen(...agentPos(S.agents.get(sel.target)));
    ctx.setLineDash([6, 6]); ctx.strokeStyle = "#c4541d"; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke(); ctx.setLineDash([]);
  }
  for (const a of S.agents.values()) {
    const [x, y] = toScreen(...agentPos(a));
    if (x < -50 || y < -50 || x > cw + 50 || y > ch + 50) continue;
    if (a.id === selected) {
      ctx.beginPath(); ctx.arc(x, y, r + 6 + Math.sin(performance.now() / 250) * 2, 0, Math.PI * 2);
      ctx.strokeStyle = "rgba(196, 84, 29, .8)"; ctx.lineWidth = 3; ctx.stroke();
    }
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = "#f3ead6"; ctx.fill();
    ctx.lineWidth = 3; ctx.strokeStyle = a.color; ctx.stroke();
    ctx.font = `${Math.round(r * 1.2)}px serif`; ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText(a.emoji, x, y + 1);
    const badge = a.down ? "💤" : a.thinking ? "💭" : null;
    if (badge) { ctx.font = `${Math.round(r)}px serif`; ctx.fillText(badge, x + r, y - r); }
    if (cam.s >= 9 || a.id === selected) {
      ctx.font = "700 13px 'Alegreya Sans', sans-serif";
      const w = ctx.measureText(a.name).width + 10;
      ctx.fillStyle = "rgba(43, 36, 24, .82)";
      ctx.beginPath(); ctx.roundRect(x - w / 2, y + r + 3, w, 18, 9); ctx.fill();
      ctx.fillStyle = "#f3ead6"; ctx.fillText(a.name, x, y + r + 12.5);
    }
  }
}

// ---------- camera input ----------
const clampCam = () => {
  const min = Math.min(cw / S.W, ch / S.H) * 0.7;
  cam.s = Math.max(min, Math.min(80, cam.s));
  cam.x = Math.max(0, Math.min(S.W, cam.x));
  cam.y = Math.max(0, Math.min(S.H, cam.y));
};
function zoomAt(px, py, f) {
  const [wx, wy] = toWorld(px, py);
  cam.s *= f; clampCam();
  const [nx, ny] = toWorld(px, py);
  cam.x += wx - nx; cam.y += wy - ny; clampCam();
}
// Pixels of the map hidden under the bottom sheet on phones.
const sheetCover = () => (window.innerWidth < 820 && panel.dataset.open === "true" ? panel.offsetHeight : 0);
function fit() {
  const cover = sheetCover();
  cam.s = Math.min(cw / S.W, (ch - cover) / S.H);
  cam.x = S.W / 2; cam.y = S.H / 2 + cover / 2 / cam.s;
  follow = false; renderInspectorHead();
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
    if (gesture.moved) { cam.x -= dx / cam.s; cam.y -= dy / cam.s; clampCam(); if (follow) { follow = false; renderInspectorHead(); } }
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
const endPointer = (e) => {
  if (pointers.size === 1 && gesture && !gesture.moved) tap(e.offsetX, e.offsetY);
  pointers.delete(e.pointerId);
  if (gesture) { gesture.dist = null; gesture.mid = null; }
};
canvas.addEventListener("pointerup", endPointer);
canvas.addEventListener("pointercancel", (e) => pointers.delete(e.pointerId));
canvas.addEventListener("wheel", (e) => { e.preventDefault(); zoomAt(e.offsetX, e.offsetY, Math.exp(-e.deltaY * 0.0015)); }, { passive: false });
canvas.addEventListener("dblclick", (e) => zoomAt(e.offsetX, e.offsetY, 2));

function tap(px, py) {
  let best = null, bd = Math.max(22, cam.s * 0.7);
  for (const a of S.agents.values()) {
    const [x, y] = toScreen(...agentPos(a));
    const d = Math.hypot(x - px, y - py);
    if (d < bd) { best = a; bd = d; }
  }
  if (best) inspect(best.id, true);
}

// ---------- panel ----------
const panel = $("#panel");
$("#grip").onclick = () => { panel.dataset.open = panel.dataset.open === "true" ? "false" : "true"; };
function showTab(tab) {
  for (const b of $("#tabs").querySelectorAll("button")) b.setAttribute("aria-selected", String(b.dataset.tab === tab));
  for (const id of ["people", "chronicle", "inspect"]) $(`#${id}`).hidden = id !== tab;
  if (tab !== "inspect") { selected = null; follow = false; }
}
$("#tabs").addEventListener("click", (e) => { const t = e.target.closest("button")?.dataset.tab; if (t) showTab(t); });

function needBars(needs) {
  return `<div class="needs">${NEEDS.map((k) => {
    const v = Math.round(needs[k]);
    return `<span class="need ${v < 30 ? "low" : ""}" title="${k} ${v}">${k}<i><b style="width:${v}%"></b></i></span>`;
  }).join("")}</div>`;
}
function renderPeople() {
  $("#people").innerHTML = [...S.agents.values()].map((a) => `
    <button type="button" class="person" data-id="${a.id}">
      <span class="avatar" style="--c:${a.color}">${a.emoji}</span>
      <span class="name">${esc(a.name)} <span class="goal-chip">${a.goal ? human(a.goal) + (a.target ? ` · ${esc(nameOf(a.target))}` : "") : ""}</span></span>
      <span class="status ${a.thinking ? "thinking" : ""}">${esc(a.status)}</span>
      ${needBars(a.needs)}
    </button>`).join("");
}
$("#people").addEventListener("click", (e) => { const id = e.target.closest(".person")?.dataset.id; if (id) inspect(id, true); });

// ---------- chronicle ----------
function eventLi(e, fresh) {
  return `<li class="k-${e.kind}${fresh ? " new" : ""}"><button type="button" data-x="${e.x}" data-y="${e.y}" data-who="${e.who[0] ?? ""}"><time>${clockText(e.t)}</time>${esc(e.text)}</button></li>`;
}
const feed = [];
function renderFilters() {
  $("#filters").innerHTML = `<button type="button" aria-pressed="${!filter}" data-f="">Everyone</button>` +
    [...S.agents.values()].map((a) => `<button type="button" aria-pressed="${filter === a.id}" data-f="${a.id}">${a.emoji} ${esc(a.name)}</button>`).join("");
}
function renderFeed() {
  const list = feed.filter((e) => !filter || e.who.includes(filter));
  $("#feed").innerHTML = list.slice(-300).reverse().map((e) => eventLi(e)).join("");
}
$("#filters").addEventListener("click", (e) => { const b = e.target.closest("button"); if (!b) return; filter = b.dataset.f || null; renderFilters(); renderFeed(); });
function jumpTo(e) {
  const b = e.target.closest("li button");
  if (!b) return;
  cam.x = +b.dataset.x + 0.5; cam.y = +b.dataset.y + 0.5; cam.s = Math.max(cam.s, 26); follow = false;
  if (window.innerWidth < 820) panel.dataset.open = "false";
}
$("#feed").addEventListener("click", jumpTo);

// ---------- inspector ----------
let insData = null, insHistory = [], insTimer = null;
async function inspect(id, openPanel) {
  showTab("inspect");
  selected = id; follow = true; insData = null; insHistory = [];
  cam.s = Math.max(cam.s, 24);
  if (openPanel) panel.dataset.open = "true";
  $("#inspect").innerHTML = `<div class="ins-head" id="ins-head"></div><div id="ins-body"><p class="muted sec">Loading…</p></div>
    <div class="sec"><h3>History</h3><ol class="feed" id="ins-history"></ol><button type="button" class="more" id="ins-more" hidden>Load older</button></div>`;
  renderInspectorHead();
  $("#ins-history").addEventListener("click", jumpTo);
  $("#ins-more").onclick = loadOlder;
  const [agent, events] = await Promise.all([fetch(`api/agent/${id}`).then((r) => r.json()), fetch(`api/events?agent=${id}`).then((r) => r.json())]);
  if (selected !== id) return;
  insData = agent; insHistory = events;
  renderInspector();
  $("#ins-history").innerHTML = [...insHistory].reverse().map((e) => eventLi(e)).join("") || `<li class="muted">Nothing yet.</li>`;
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
  $("#ins-history").insertAdjacentHTML("beforeend", [...older].reverse().map((e) => eventLi(e)).join(""));
  $("#ins-more").hidden = older.length < 200;
}
function renderInspectorHead() {
  const head = $("#ins-head");
  const a = S.agents.get(selected);
  if (!head || !a) return;
  head.innerHTML = `<button type="button" class="back" aria-label="Back to people">‹</button>
    <span class="avatar" style="--c:${a.color};width:36px;height:36px;font-size:20px">${a.emoji}</span>
    <h2>${esc(a.name)}</h2><button type="button" class="follow" aria-pressed="${follow}">${follow ? "Following" : "Follow"}</button>`;
  head.querySelector(".back").onclick = () => showTab("people");
  head.querySelector(".follow").onclick = () => { follow = !follow; renderInspectorHead(); };
}
function oddsRows(probs, picked, label = human) {
  return Object.entries(probs ?? {}).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, p]) => `
    <span class="${k === picked ? "picked" : ""}">${esc(label(k))}</span><span class="bar ${k === picked ? "picked" : ""}"><b style="width:${Math.round(p * 100)}%"></b></span><span>${Math.round(p * 100)}%</span>`).join("");
}
function meter(label, v, centered) {
  const style = centered
    ? v >= 0 ? `left:50%;width:${v * 50}%;background:var(--good)` : `right:50%;width:${-v * 50}%;background:var(--bad)`
    : `left:0;width:${v * 100}%;background:var(--ink-soft)`;
  return `<div class="meter"><span>${label}</span><i><b style="${style}"></b></i></div>`;
}
function renderInspector() {
  const a = insData;
  if (!a || !$("#ins-body")) return;
  const d = a.lastDecision;
  const lvl = (xp) => Math.min(10, Math.floor(Math.sqrt(xp / 10)));
  const plan = a.plan ?? [];
  const inv = Object.entries(a.inv).filter(([, n]) => n);
  const rels = Object.entries(a.rel).sort((x, y) => Math.abs(y[1].affinity) - Math.abs(x[1].affinity));
  $("#ins-body").innerHTML = `
    <div class="sec"><p class="bio">${esc(a.bio)}</p></div>
    <div class="sec"><h3>Right now</h3>
      <p class="bio"><b>${esc(a.status)}</b>${a.goal ? ` · goal: ${human(a.goal.type)}${a.goal.target ? ` (${esc(nameOf(a.goal.target))})` : ""}` : ""}</p>
      ${plan.length ? `<ol class="plan">${plan.map((s, i) => `<li class="${i === 0 ? "cur" : ""}">${human(s.op)}${s.arg && s.op !== "wander" ? ` ${human(s.arg === "agent" ? nameOf(a.goal?.target) : s.arg)}` : ""}</li>`).join("")}</ol>` : ""}
      ${d ? `<p class="muted" style="margin-top:10px">Last decision, ${clockText(d.t)}. Jev's odds:</p><div class="odds">${oddsRows(d.goal, d.chosen)}</div>
        ${d.who ? `<p class="muted" style="margin-top:8px">Who:</p><div class="odds">${oddsRows(d.who, d.target, nameOf)}</div>` : ""}` : ""}
    </div>
    <div class="sec"><h3>Needs</h3>${needBars(a.needs)}</div>
    <div class="sec"><h3>Traits</h3><div class="chips">${Object.entries(a.traits).sort((x, y) => y[1] - x[1]).map(([t, s]) => `<span class="chip" style="--s:${(s * 0.35).toFixed(2)}" title="strength ${s}">${esc(t)}</span>`).join("")}</div>
      <h3 style="margin-top:12px">Desires</h3><div class="chips">${a.desires.map((x) => `<span class="chip" style="--s:0">${esc(x)}</span>`).join("")}</div></div>
    <div class="sec"><h3>Carrying</h3>${inv.length ? `<div class="kv">${inv.map(([i, n]) => `<span>${i}</span><span>${n}</span>`).join("")}</div>` : `<p class="muted">Nothing</p>`}
      <p class="muted" style="margin-top:6px">${a.home ? `Home: shelter at ${a.home.x}, ${a.home.y}` : "No home yet"}</p></div>
    <div class="sec"><h3>Skills</h3><div class="kv">${Object.entries(a.skills).sort((x, y) => y[1] - x[1]).map(([s, xp]) => `<span>${s}</span><span>level ${lvl(xp)} · ${Math.round(xp)} xp</span>`).join("")}</div></div>
    <div class="sec"><h3>Relationships</h3>${rels.length ? rels.map(([id, r]) => {
      const beliefs = Object.entries(r.beliefs).map(([k, v]) => `${k} ${Math.round(v * 100)}%`).join(", ");
      return `<div class="rel"><header><span>${esc(nameOf(id))}</span><small>${human(r.label)}</small></header>
        ${meter("feeling", r.affinity, true)}${meter("trust", r.trust)}
        ${r.bonds.length ? `<ul>${[...r.bonds].sort((x, y) => y.weight - x.weight).map((b) => `<li style="opacity:${0.45 + b.weight * 0.55}">${human(b.kind)} <span class="muted">(${clockText(b.t)})</span></li>`).join("")}</ul>` : ""}
        ${beliefs ? `<p class="beliefs">Thinks ${esc(nameOf(id))} is: ${beliefs}</p>` : ""}
        ${r.ledger ? `<p class="beliefs">${r.ledger > 0 ? `${esc(nameOf(id))} has done ${r.ledger} more favors` : `Has done ${esc(nameOf(id))} ${-r.ledger} more favors`}</p>` : ""}
        ${r.history.length ? `<ul>${r.history.slice(-5).reverse().map((h) => `<li>${esc(h)}</li>`).join("")}</ul>` : ""}
      </div>`;
    }).join("") : `<p class="muted">Hasn't met anyone yet.</p>`}</div>`;
}

// ---------- controls ----------
async function control(body) {
  const r = await fetch("api/control", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  applyControl(await r.json());
}
function applyControl(c) {
  S.control = c; tickMs = 500 / c.speed;
  $("#play").textContent = c.paused ? "▶" : "❚❚";
  $("#play").setAttribute("aria-label", c.paused ? "Play" : "Pause");
  $("#speed").textContent = `${c.speed}×`;
}
$("#play").onclick = () => control({ paused: !S.control.paused });
$("#speed").onclick = () => control({ speed: { 1: 2, 2: 4, 4: 8, 8: 1 }[S.control.speed] });
$("#fit").onclick = fit;

function renderStatus() {
  $("#clock").textContent = clockText(S.t);
  if (S.jev) $("#jev").textContent = `${S.jev.calls.toLocaleString()} Jev calls · $${((S.jev.tokens * 0.042) / 1e6).toFixed(4)}`;
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
  src.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.type === "init") {
      S.W = 64; S.H = msg.tiles.length / 64; S.tiles = msg.tiles; S.t = msg.t; S.jev = msg.jev;
      S.things.clear(); S.byTile.clear();
      for (const th of msg.things) { S.things.set(th.id, th); indexThing(th, true); }
      S.agents.clear(); setAgents(msg.agents, true);
      feed.length = 0; feed.push(...msg.events);
      buildLayer(); applyControl(msg.control);
      if (!cam.init) { cam.init = true; resize(); fit(); }
      renderPeople(); renderFilters(); renderFeed(); renderStatus();
      return;
    }
    if (msg.type === "control") return applyControl(msg.control);
    lastTickAt = performance.now();
    S.t = msg.t; S.jev = msg.jev;
    setAgents(msg.agents);
    const redraw = new Set();
    for (const id of msg.removed) {
      const th = S.things.get(id);
      if (th) { indexThing(th, false); S.things.delete(id); redraw.add(`${th.x},${th.y}`); }
    }
    for (const th of msg.things) {
      const old = S.things.get(th.id);
      if (old) indexThing(old, false);
      S.things.set(th.id, th); indexThing(th, true);
      redraw.add(`${th.x},${th.y}`);
    }
    for (const k of redraw) { const [x, y] = k.split(",").map(Number); drawTile(x, y); }
    if (msg.events.length) {
      feed.push(...msg.events);
      if (feed.length > 2000) feed.splice(0, feed.length - 2000);
      const shown = msg.events.filter((e) => !filter || e.who.includes(filter));
      if (shown.length) $("#feed").insertAdjacentHTML("afterbegin", [...shown].reverse().map((e) => eventLi(e, true)).join(""));
      const mine = msg.events.filter((e) => selected && e.who.includes(selected));
      if (mine.length && $("#ins-history")) {
        insHistory.push(...mine);
        $("#ins-history").insertAdjacentHTML("afterbegin", [...mine].reverse().map((e) => eventLi(e, true)).join(""));
      }
    }
    if (!$("#people").hidden) renderPeople();
    renderStatus();
  };
}

window.addEventListener("resize", () => { resize(); clampCam(); });
resize();
connect();
requestAnimationFrame(frame);
