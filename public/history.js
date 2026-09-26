// The whole history of the world, one row per kind of happening.
const $ = (s) => document.querySelector(s);
const DAY = 288;
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const hhmm = (t) => {
  const mins = Math.floor(((t % DAY) / DAY) * 24 * 60);
  return `${String(Math.floor(mins / 60)).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}`;
};
const SEASONS = ["Spring", "Summer", "Autumn", "Winter"];
const CATS = [
  { id: "tech", label: "Technology", color: "#a8812a", kinds: ["law", "invent", "discover", "named", "mistaken", "learn", "teach", "level", "tinker"] },
  { id: "survival", label: "Survival", color: "#8a5a2b", kinds: ["gather", "eat", "hunt", "craft", "build", "fire", "store", "claim", "trap", "dig", "spoil", "break", "ruin", "fire_out"] },
  { id: "social", label: "Social", color: "#2f4a6d", kinds: ["talk", "give", "trade", "share_meal", "share_fire", "help", "gossip", "bond", "beg", "tend", "notice"] },
  { id: "conflict", label: "Conflict", color: "#9e3b2f", kinds: ["insult", "lie", "take", "steal", "raid", "attack"] },
  { id: "camps", label: "Camps", color: "#6b3f5e", kinds: ["camp", "camp_named", "camp_change", "custom", "custom_faded", "leader", "judged", "driven_out", "shared_store"] },
  { id: "life", label: "Life", color: "#4e6b3a", kinds: ["born", "pregnant", "died", "grief", "arrive", "collapse", "sick", "recover"] },
  { id: "wild", label: "The wild", color: "#3d6b6b", kinds: ["wolf", "defend", "hazard", "lightning", "burned", "fire_spread", "birth", "death", "grow"] },
];
// Decisions, weather and plans that fizzled are noise at this scale. Anything else new lands in Other until it gets a row.
const SKIP = new Set(["goal", "weather", "season", "wake", "fail", "stuck"]);
const OTHER = { id: "other", label: "Other", color: "#8a7a66", kinds: [] };
const CAT_OF = Object.fromEntries(CATS.flatMap((c) => c.kinds.map((k) => [k, c])));
const catOf = (k) => CAT_OF[k] ?? (SKIP.has(k) ? null : OTHER);
// When two milestone labels would collide, the higher one keeps its label.
const RANK = { died: 9, born: 9, arrive: 8, camp: 8, camp_named: 7, leader: 7, custom: 6, driven_out: 6, burned: 6, named: 5, invent: 4, law: 3 };
// Routine things that only arrive as counts.
const ALSO = {
  gather: ["thing gathered", "things gathered"], eat: ["meal", "meals"], craft: ["thing made", "things made"], tinker: ["experiment", "experiments"],
  goal: ["decision", "decisions"], level: ["skill improved", "skills improved"], spoil: ["thing spoiled", "things spoiled"], grow: ["plant grew", "plants grew"],
  fire_out: ["fire went out", "fires went out"], fire_spread: ["fire spread", "fires spread"], stuck: ["plan stalled", "plans stalled"],
};

let data = null, mode = "milestones", sel = 0, geo = null;
const lanes = () => {
  OTHER.kinds = Object.keys(data.counts).filter((k) => catOf(k) === OTHER);
  return OTHER.kinds.length ? [...CATS, OTHER] : CATS;
};
const seasonOf = (d) => SEASONS[Math.floor((d % data.yearDays) / (data.yearDays / 4))];
const range = (a, b, step) => { const r = []; for (let n = a; n <= b; n += step) r.push(n); return r; };
const mctx = document.createElement("canvas").getContext("2d");
const textW = (s) => { mctx.font = 'italic 12px "IM Fell English"'; return mctx.measureText(s).width; };
const short = (s) => (s.length > 24 ? `${s.slice(0, 23).trimEnd()}…` : s);

async function load() {
  try {
    const r = await fetch("api/history", { cache: "no-store" });
    if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
    const d = await r.json();
    if (data && d.t === data.t) return;
    // Follow the present unless someone went back to an older day.
    const atEnd = !data || sel === data.days - 1;
    data = d;
    if (atEnd) sel = data.days - 1;
    render();
  } catch (e) {
    if (!data) $("#list").innerHTML = `<li class="muted empty">Couldn't load the history: ${esc(e.message)}</li>`;
  }
}

function render() {
  $("#stamp").innerHTML = `<b>Day ${data.days}</b>`;
  $("#trimmed").hidden = data.since < DAY;
  $("#day").max = String(data.days);
  syncDay();
  drawChart();
  renderList();
}
function syncDay() {
  $("#day").value = String(sel + 1);
  $("#day-out").value = String(sel + 1);
  const [m, d] = $("#modes").children;
  m.setAttribute("aria-pressed", String(mode === "milestones"));
  d.setAttribute("aria-pressed", String(mode === "day"));
  d.textContent = `Day ${sel + 1}`;
}

function drawChart() {
  const box = $("#chart"), rows = lanes();
  const W = box.clientWidth, phone = W < 520;
  const LG = phone ? 82 : 116, TA = 20, LH = phone ? 46 : 52, BA = 22;
  // Mid-resize the box can measure narrower than the row labels; the next resize redraws it.
  if (W < LG + 40) return;
  const days = data.days, pxd = (W - LG - 4) / days;
  // ponytail: bars merge into multi-day bins once a day gets thinner than 3px; add zoom if long histories need day detail.
  const bin = Math.max(1, Math.ceil(3 / pxd)), bw = bin * pxd, nb = Math.ceil(days / bin);
  const X = (d) => LG + d * pxd, bot = TA + rows.length * LH;
  geo = { LG, pxd, days };
  let s = "";
  const sd = data.yearDays / 4;
  for (let d = 0; d < days;) {
    const end = Math.min(days, d - (d % sd) + sd), x0 = X(d), x1 = X(end);
    s += `<rect class="s${SEASONS.indexOf(seasonOf(d))}" x="${x0}" y="${TA}" width="${x1 - x0}" height="${bot - TA}"/>`;
    if (x1 - x0 >= 50) s += `<text class="season" x="${(x0 + x1) / 2}" y="${TA - 6}">${seasonOf(d)}</text>`;
    d = end;
  }
  if (mode === "day") s += `<rect class="sel" x="${X(Math.floor(sel / bin) * bin)}" y="${TA}" width="${Math.max(2, bw)}" height="${bot - TA}"/>`;
  rows.forEach((c, i) => {
    const top = TA + i * LH, base = top + LH - 4, room = LH - 28;
    const vals = new Array(nb).fill(0);
    for (const k of c.kinds) data.counts[k]?.forEach((n, d) => { vals[Math.floor(d / bin)] += n; });
    const max = Math.max(1, ...vals), total = vals.reduce((a, b) => a + b, 0);
    s += `<line class="rule" x1="0" x2="${W}" y1="${top + LH + 0.5}" y2="${top + LH + 0.5}"/>`;
    s += `<text class="lane" x="0" y="${top + LH / 2 + 2}">${esc(c.label)}</text><text class="lane-n" x="0" y="${top + LH / 2 + 16}">${total.toLocaleString("en-US")}</text>`;
    s += `<g fill="${c.color}" fill-opacity=".8">`;
    vals.forEach((v, b) => {
      if (!v) return;
      const h = Math.max(1.5, Math.sqrt(v / max) * room), gap = bw > 4 ? 1 : 0;
      const when = bin === 1 ? `Day ${b + 1}` : `Days ${b * bin + 1} to ${Math.min(days, (b + 1) * bin)}`;
      s += `<rect x="${X(b * bin) + gap / 2}" y="${base - h}" width="${Math.max(1, bw - gap)}" height="${h}"><title>${when}: ${v}</title></rect>`;
    });
    s += `</g>`;
    const marks = data.events.filter((e) => e.tag && catOf(e.kind) === c);
    const taken = [];
    for (const e of [...marks].sort((a, b) => (RANK[b.kind] ?? 0) - (RANK[a.kind] ?? 0) || a.t - b.t)) {
      const text = short(e.tag), w = textW(text), x0 = Math.min(Math.max(X(e.t / DAY) - w / 2, LG), W - w);
      if (taken.some(([a, b]) => x0 < b + 10 && x0 + w > a - 10)) continue;
      taken.push([x0, x0 + w]);
      s += `<text class="mark" x="${x0}" y="${top + 12}">${esc(text)}</text>`;
    }
    for (const e of marks) s += `<circle class="seal" cx="${X(e.t / DAY)}" cy="${top + 19}" r="3.6" fill="${c.color}"><title>Day ${Math.floor(e.t / DAY) + 1}: ${esc(e.tag)}</title></circle>`;
  });
  const step = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000].find((k) => k * pxd >= (phone ? 34 : 46)) ?? 2000;
  for (const n of step >= 5 ? [1, ...range(step, days, step)] : range(1, days, step))
    s += `<text class="tick" x="${X(n - 0.5)}" y="${bot + 15}">${n === 1 ? "Day 1" : n}</text>`;
  box.innerHTML = `<svg width="${W}" height="${bot + BA}" viewBox="0 0 ${W} ${bot + BA}" aria-hidden="true">${s}</svg>`;
  box.setAttribute("aria-label", `How much happened each day over ${days} days, in ${rows.length} rows: ${rows.map((c) => c.label).join(", ")}`);
}

const evLi = (e) => {
  const c = catOf(e.kind) ?? OTHER;
  return `<li class="ev${e.tag ? " big" : ""}" style="--c:${c.color}"><div class="row"><time><i></i>${hhmm(e.t)}</time><span>${esc(e.text)}</span></div></li>`;
};
const dayHead = (d, extra = "") => `<li class="day"><span>Day ${d + 1}${extra}</span></li>`;
function renderList() {
  const list = $("#list");
  if (mode === "milestones") {
    const ms = data.events.filter((e) => e.tag);
    let out = "", day = null;
    for (const e of [...ms].reverse()) {
      const d = Math.floor(e.t / DAY);
      if (d !== day) { day = d; out += dayHead(d); }
      out += evLi(e);
    }
    list.innerHTML = out || `<li class="muted empty">No big moments yet.</li>`;
    return;
  }
  const evs = data.events.filter((e) => Math.floor(e.t / DAY) === sel && catOf(e.kind));
  let out = dayHead(sel, `, ${seasonOf(sel).toLowerCase()}`);
  for (const c of lanes()) {
    const mine = evs.filter((e) => catOf(e.kind) === c);
    if (mine.length) out += `<li class="cat" style="--c:${c.color}"><i></i><span>${esc(c.label)}</span><b>${mine.length}</b></li>${mine.map(evLi).join("")}`;
  }
  const also = Object.entries(ALSO).map(([k, [one, many]]) => [data.counts[k]?.[sel] ?? 0, one, many]).filter(([n]) => n).map(([n, one, many]) => `${n} ${n === 1 ? one : many}`);
  if (also.length) out += `<li class="muted also">Also that day: ${also.join(", ")}.</li>`;
  else if (!evs.length) out += `<li class="muted empty">Nothing much happened.</li>`;
  list.innerHTML = out;
}

function choose(d) {
  if (d === sel && mode === "day") return;
  sel = d; mode = "day";
  syncDay();
  drawChart();
  renderList();
}
let dragging = false;
function pickAt(e) {
  if (!geo) return;
  const d = Math.floor((e.clientX - $("#chart").getBoundingClientRect().left - geo.LG) / geo.pxd);
  if (d >= 0 && d < geo.days) choose(d);
}
$("#chart").addEventListener("pointerdown", (e) => { dragging = true; pickAt(e); });
$("#chart").addEventListener("pointermove", (e) => { if (dragging) pickAt(e); });
addEventListener("pointerup", () => (dragging = false));
addEventListener("pointercancel", () => (dragging = false));
$("#day").addEventListener("input", (e) => choose(+e.target.value - 1));
$("#modes").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-mode]");
  if (!b || !data || b.dataset.mode === mode) return;
  mode = b.dataset.mode;
  syncDay();
  drawChart();
  renderList();
});
addEventListener("resize", () => data && drawChart());
document.fonts?.ready.then(() => data && drawChart());

load();
setInterval(() => { if (!document.hidden) load(); }, 15000);
