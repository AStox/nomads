const DAY = 288;
const POLL_MS = 3000;
const TABS = ["stats", "jev", "trace", "laws", "kinds"];
const SYS_COLOR = {
  physics: "#8a5a2b", plan: "#3f6a8a", brain: "#7a3f7a", belief: "#a8321f", ecology: "#5a7a3a",
  weather: "#4f7f86", fire: "#c0621a", animal: "#7a6a3a", social: "#a0476a", world: "#33251a",
};
const STATS_KNOWN = new Set(["t", "clock", "weather", "population", "things", "fires", "structures", "laws", "kinds", "jev", "tickMs", "counters"]);

const $ = (s) => document.querySelector(s);
const enc = encodeURIComponent;
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const pad2 = (n) => String(n).padStart(2, "0");
const hhmm = (t) => {
  const mins = Math.floor((((t % DAY) + DAY) % DAY) / DAY * 24 * 60);
  return `${pad2(Math.floor(mins / 60))}:${pad2(mins % 60)}`;
};
const when = (t) => (Number.isFinite(t) ? `Day ${Math.floor(t / DAY) + 1} ${hhmm(t)}` : t == null ? "" : String(t));
const fmtNum = (n) => (Number.isInteger(n) ? n.toLocaleString("en-US") : n.toLocaleString("en-US", { maximumFractionDigits: 3 }));
const label = (k) => {
  const s = String(k).replace(/([a-z])([A-Z])/g, "$1 $2").replace(/_/g, " ").toLowerCase();
  return s.charAt(0).toUpperCase() + s.slice(1);
};
const muted = (text) => `<p class="muted">${esc(text)}</p>`;
const nil = (text = "none") => `<span class="nil">${esc(text)}</span>`;
const pretty = (v) => (typeof v === "string" ? v : JSON.stringify(v, null, 2) ?? String(v));
const oneLine = (v) => {
  const s = typeof v === "string" ? v : JSON.stringify(v) ?? "";
  return s.length > 240 ? `${s.slice(0, 240)}...` : s;
};

function fmtVal(v) {
  if (v == null) return nil();
  if (typeof v === "number") return esc(fmtNum(v));
  if (typeof v === "boolean") return v ? "yes" : "no";
  if (typeof v === "string") return esc(v);
  return `<code class="j">${esc(JSON.stringify(v))}</code>`;
}

const kvTable = (rows) =>
  rows.length
    ? `<table class="kvt"><tbody>${rows.map(([k, v]) => `<tr><th>${esc(k)}</th><td>${fmtVal(v)}</td></tr>`).join("")}</tbody></table>`
    : muted("Nothing here.");
const card = (title, inner, cls = "") => `<section class="box ${cls}"><h3>${esc(title)}</h3>${inner}</section>`;
const extras = (obj, known) => Object.entries(obj).filter(([k]) => !known.includes(k)).map(([k, v]) => [label(k), v]);

function records(x, key) {
  if (Array.isArray(x)) return { list: x, rest: null };
  if (!isObj(x)) return { list: [], rest: x == null ? null : { value: x } };
  if (Array.isArray(x[key])) {
    const { [key]: list, ...rest } = x;
    return { list, rest: Object.keys(rest).length ? rest : null };
  }
  const entries = Object.entries(x);
  if (entries.every(([, v]) => isObj(v))) return { list: entries.map(([id, v]) => ({ id, ...v })), rest: null };
  return { list: [], rest: x };
}
const restCard = (rest) => (rest ? `<div class="grid" style="margin-top:14px">${card("Other fields", kvTable(Object.entries(rest)), "wide")}</div>` : "");

const S = {
  tab: "stats",
  auto: true,
  paused: false,
  timer: 0,
  gen: 0,
  updated: "",
  data: {},
  open: { jev: new Set(), trace: new Set(), laws: new Set() },
  seen: { jevAgent: new Set(), jevPurpose: new Set(), trAgent: new Set(), trKind: new Set() },
};

const PATHS = { stats: "api/debug/stats", jev: "api/debug/jev", trace: "api/debug/trace", laws: "api/debug/laws", kinds: "api/debug/kinds" };
const URLS = {
  stats: () => PATHS.stats,
  jev: () => `${PATHS.jev}?limit=200&agent=${enc($("#jev-agent").value)}`,
  trace: () =>
    `${PATHS.trace}?sys=${enc($("#tr-sys").value)}&agent=${enc($("#tr-agent").value)}&kind=${enc($("#tr-kind").value)}&limit=${enc($("#tr-limit").value)}`,
  laws: () => PATHS.laws,
  kinds: () => PATHS.kinds,
};

const resOf = (tab) => document.querySelector(`#${tab} .res`);

function paint(el, html) {
  const y = window.scrollY;
  const keep = new Map();
  for (const n of el.querySelectorAll("[data-k]")) keep.set(n.dataset.k, [n.scrollTop, n.scrollLeft]);
  const focused = el.contains(document.activeElement) ? document.activeElement.dataset.id : undefined;
  el.innerHTML = html;
  for (const n of el.querySelectorAll("[data-k]")) {
    const s = keep.get(n.dataset.k);
    if (s) [n.scrollTop, n.scrollLeft] = s;
  }
  if (focused !== undefined) {
    const f = [...el.querySelectorAll("[data-id]")].find((n) => n.dataset.id === focused && n.tabIndex >= 0);
    f?.focus({ preventScroll: true });
  }
  if (window.scrollY !== y) window.scrollTo(0, y);
}

function syncSelect(sel, set, allLabel) {
  const vals = [...set].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const cur = sel.value;
  if (cur && !set.has(cur)) vals.push(cur);
  const sig = vals.join("\u0000");
  if (sel.dataset.sig === sig) return;
  sel.dataset.sig = sig;
  sel.innerHTML = `<option value="">${esc(allLabel)}</option>${vals.map((v) => `<option value="${esc(v)}">${esc(v)}</option>`).join("")}`;
  sel.value = cur;
}

function note(tab, bad) {
  const el = document.querySelector(`#${tab} .note`);
  el.hidden = !bad;
  if (bad) el.textContent = `Could not reach ${PATHS[tab]}; ${S.auto ? "retrying" : "press refresh to try again"}.`;
  if (bad && S.data[tab] === undefined) {
    paint(resOf(tab), muted("Nothing to show yet."));
    if (tab === "stats") paint($("#counters"), muted("Nothing to show yet."));
  }
}

function stamp() {
  const pause = S.paused ? "<b>Paused</b> " : "";
  const upd = S.updated ? `<span class="lbl">updated </span>${esc(S.updated)}` : "";
  $("#stamp").innerHTML = pause + upd;
}

async function refresh(user = false) {
  clearTimeout(S.timer);
  const tab = S.tab;
  const my = ++S.gen;
  let data;
  let ok = true;
  try {
    const r = await fetch(URLS[tab](), { cache: "no-store" });
    if (!r.ok) throw new Error(String(r.status));
    data = JSON.parse(await r.text());
  } catch {
    ok = false;
  }
  if (my !== S.gen) return;
  if (!ok) note(tab, true);
  else if (user || !S.paused) {
    S.data[tab] = data;
    note(tab, false);
    RENDER[tab]();
    const d = new Date();
    S.updated = `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
    stamp();
  }
  schedule();
}

function schedule() {
  clearTimeout(S.timer);
  if (S.auto) S.timer = setTimeout(() => refresh(false), POLL_MS);
}

function windText(w) {
  if (!isObj(w) || !Number.isFinite(w.dx) || !Number.isFinite(w.dy)) return w;
  const s = Math.hypot(w.dx, w.dy);
  if (s < 0.05) return `calm (${s.toFixed(2)})`;
  const deg = (Math.atan2(w.dx, -w.dy) * 180 / Math.PI + 360) % 360;
  const dir = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"][Math.round(deg / 45) % 8];
  return `${s.toFixed(2)} toward ${dir} (dx ${w.dx.toFixed(2)}, dy ${w.dy.toFixed(2)})`;
}

function renderStats() {
  const d = S.data.stats;
  if (d === undefined) return;
  renderCounters();
  if (!isObj(d)) {
    paint(resOf("stats"), `${muted("Unexpected response shape.")}<pre>${esc(pretty(d))}</pre>`);
    return;
  }
  const cards = [];
  const other = [];

  const ov = [["Time", when(d.t)], ["Tick", d.t]];
  if (d.clock != null) ov.push(["Clock", d.clock]);
  const later = [];
  for (const k of ["fires", "structures", "laws", "kinds"]) {
    if (!(k in d)) continue;
    if (d[k] !== null && typeof d[k] === "object") later.push(card(label(k), kvTable(Object.entries(d[k]))));
    else ov.push([label(k), d[k]]);
  }
  cards.push(card("Overview", kvTable(ov)));

  const w = d.weather;
  if (isObj(w)) {
    const rows = [
      ["Season", w.season],
      ["Year", w.year],
      ["Day of year", w.dayOfYear],
      ["Sky", w.sky],
      ["Temp", Number.isFinite(w.temp) ? `${w.temp.toFixed(1)} \u00b0C` : w.temp],
      ["Wind", windText(w.wind)],
      ["Drought", w.drought],
    ];
    cards.push(card("Weather", kvTable([...rows, ...extras(w, ["season", "year", "dayOfYear", "sky", "temp", "wind", "drought"])])));
  } else if ("weather" in d) other.push(["Weather", w]);

  const p = d.population;
  if (isObj(p)) {
    cards.push(card("Population", kvTable([["Deer", p.deer], ["Wolf", p.wolf], ["Agents", p.agents], ...extras(p, ["deer", "wolf", "agents"])])));
  } else if ("population" in d) other.push(["Population", p]);

  if (isObj(d.things)) {
    const rows = Object.entries(d.things).sort((a, b) => (Number(b[1]) || 0) - (Number(a[1]) || 0));
    const total = rows.reduce((s, [, v]) => s + (Number.isFinite(v) ? v : 0), 0);
    cards.push(card("Things", `${kvTable(rows)}<table class="kvt"><tbody><tr class="total"><th>Total</th><td>${esc(fmtNum(total))}</td></tr></tbody></table>`));
  } else if ("things" in d) other.push(["Things", d.things]);

  const j = d.jev;
  if (isObj(j)) {
    const cost = Number.isFinite(j.cost) ? `$${j.cost.toFixed(j.cost < 1 ? 4 : 2)}` : j.cost;
    cards.push(card("Jev", kvTable([["Calls", j.calls], ["Tokens", j.tokens], ["Cost", cost], ["Rulings", j.rulings], ...extras(j, ["calls", "tokens", "cost", "rulings"])])));
  } else if ("jev" in d) other.push(["Jev", j]);

  if (isObj(d.tickMs)) {
    const all = Object.entries(d.tickMs);
    const nums = all.filter(([, v]) => Number.isFinite(v)).sort((a, b) => b[1] - a[1]);
    const max = nums[0]?.[1] || 1;
    const sum = nums.reduce((s, [, v]) => s + v, 0);
    const rows = nums
      .map(([k, v]) => `<tr><th>${esc(k)}</th><td class="barc"><i class="bar"><b style="width:${Math.max(0, (v / max) * 100).toFixed(1)}%"></b></i></td><td>${v.toFixed(2)}</td></tr>`)
      .concat(all.filter(([, v]) => !Number.isFinite(v)).map(([k, v]) => `<tr><th>${esc(k)}</th><td class="barc"></td><td>${fmtVal(v)}</td></tr>`))
      .join("");
    const body = all.length
      ? `<table class="kvt"><tbody>${rows}<tr class="total"><th>Total</th><td class="barc"></td><td>${sum.toFixed(2)}</td></tr></tbody></table>`
      : muted("No systems reported.");
    cards.push(card("Tick ms (rolling avg)", body));
  } else if ("tickMs" in d) other.push(["Tick ms", d.tickMs]);

  cards.push(...later);
  for (const [k, v] of Object.entries(d)) if (!STATS_KNOWN.has(k)) other.push([k, v]);
  if (other.length) cards.push(card("Other fields", kvTable(other), "wide"));
  paint(resOf("stats"), `<div class="grid">${cards.join("")}</div>`);
}

function renderCounters() {
  const c = S.data.stats?.counters;
  const el = $("#counters");
  if (!isObj(c)) {
    paint(el, muted("No counters in this response."));
    return;
  }
  const q = $("#ctr-q").value.trim().toLowerCase();
  const all = Object.entries(c).sort((a, b) => a[0].localeCompare(b[0]));
  const rows = q ? all.filter(([k]) => k.toLowerCase().includes(q)) : all;
  const body = rows.length
    ? `<div class="ctr">${rows.map(([k, v]) => `<div><span>${esc(k)}</span><b>${fmtVal(v)}</b></div>`).join("")}</div>`
    : muted(q ? "No counters match." : "No counters yet.");
  paint(el, `<p class="count">${rows.length} of ${all.length} counters</p>${body}`);
}

const rowId = (r) => (r.id != null ? String(r.id) : `${r.t}|${r.agent ?? ""}|${r.purpose ?? r.kind ?? ""}|${r.ms ?? r.sys ?? ""}`);
const block = (title, v, key) =>
  `<h4>${esc(title)}</h4>${v === undefined ? `<p class="muted small">${esc("not present")}</p>` : `<pre data-k="${esc(key)}">${esc(pretty(v))}</pre>`}`;

function renderJev() {
  const raw = S.data.jev;
  if (raw === undefined) return;
  const { list, rest } = records(raw, "calls");
  for (const r of list) {
    if (r?.agent != null) S.seen.jevAgent.add(String(r.agent));
    if (r?.purpose != null) S.seen.jevPurpose.add(String(r.purpose));
  }
  syncSelect($("#jev-agent"), S.seen.jevAgent, "All agents");
  syncSelect($("#jev-purpose"), S.seen.jevPurpose, "All purposes");
  const pf = $("#jev-purpose").value;
  const rows = list.filter((r) => isObj(r) && (!pf || String(r.purpose) === pf)).reverse();
  const errs = rows.filter((r) => r.error).length;
  const tokens = rows.reduce((s, r) => s + (Number.isFinite(r.tokens) ? r.tokens : 0), 0);
  const body = rows
    .map((r) => {
      const id = rowId(r);
      const open = S.open.jev.has(id);
      const tr = `<tr class="row${open ? " open" : ""}${r.error ? " err" : ""}" data-id="${esc(id)}" tabindex="0" aria-expanded="${open}">
        <td class="nw">${esc(when(r.t))}</td><td>${r.agent != null ? esc(r.agent) : nil()}</td><td>${fmtVal(r.purpose)}</td>
        <td class="num">${Number.isFinite(r.ms) ? esc(fmtNum(Math.round(r.ms))) : fmtVal(r.ms)}</td><td class="num">${fmtVal(r.tokens)}</td>
        <td>${r.error ? `<span class="badge">error</span>` : ""}</td></tr>`;
      if (!open) return tr;
      const det = `<tr class="det"><td colspan="6"><p class="sub">id ${esc(r.id ?? "none")}, tick ${esc(r.t)}</p>
        ${block("State", r.state, `j-${id}-s`)}${block("Questions", r.questions, `j-${id}-q`)}${block("Answers", r.answers, `j-${id}-a`)}
        ${r.error != null ? block("Error", r.error, `j-${id}-e`) : ""}</td></tr>`;
      return tr + det;
    })
    .join("");
  const count = `<p class="count">Showing ${rows.length} of ${list.length} calls, ${errs} with errors, ${fmtNum(tokens)} tokens</p>`;
  const table = rows.length
    ? `<div class="tw" data-k="jev-tw"><table class="dt"><thead><tr><th>Time</th><th>Agent</th><th>Purpose</th><th class="num">ms</th><th class="num">Tokens</th><th>Error</th></tr></thead><tbody>${body}</tbody></table></div>`
    : muted("No calls match.");
  paint(resOf("jev"), count + table + restCard(rest));
}

function renderTrace() {
  const raw = S.data.trace;
  if (raw === undefined) return;
  const { list, rest } = records(raw, "trace");
  for (const r of list) {
    if (r?.agent != null) S.seen.trAgent.add(String(r.agent));
    if (r?.kind != null) S.seen.trKind.add(String(r.kind));
  }
  syncSelect($("#tr-agent"), S.seen.trAgent, "All agents");
  syncSelect($("#tr-kind"), S.seen.trKind, "All kinds");
  const q = $("#tr-q").value.trim().toLowerCase();
  const rows = list
    .filter((r) => isObj(r) && (!q || `${r.sys ?? ""} ${r.kind ?? ""} ${r.agent ?? ""} ${JSON.stringify(r.data) ?? ""}`.toLowerCase().includes(q)))
    .reverse();
  const body = rows
    .map((r) => {
      const id = rowId(r);
      const open = S.open.trace.has(id);
      const color = SYS_COLOR[r.sys] ?? "var(--ink-faint)";
      const tr = `<tr class="row${open ? " open" : ""}" data-id="${esc(id)}" tabindex="0" aria-expanded="${open}">
        <td class="nw">${esc(when(r.t))}</td><td><span class="chip" style="--c:${color}">${esc(r.sys ?? "?")}</span></td>
        <td>${fmtVal(r.kind)}</td><td>${r.agent != null ? esc(r.agent) : nil()}</td><td class="pv"><code>${esc(oneLine(r.data))}</code></td></tr>`;
      if (!open) return tr;
      return `${tr}<tr class="det"><td colspan="5"><p class="sub">id ${esc(r.id ?? "none")}, tick ${esc(r.t)}</p>${block("Data", r.data, `t-${id}`)}</td></tr>`;
    })
    .join("");
  const count = `<p class="count">Showing ${rows.length} of ${list.length} entries</p>`;
  const table = rows.length
    ? `<div class="tw" data-k="tr-tw"><table class="dt"><thead><tr><th>Time</th><th>System</th><th>Kind</th><th>Agent</th><th>Data</th></tr></thead><tbody>${body}</tbody></table></div>`
    : muted("No entries match.");
  paint(resOf("trace"), count + table + restCard(rest));
}

const LAW_KNOWN = ["id", "text", "verb", "source", "by", "t"];

function renderLaws() {
  const raw = S.data.laws;
  if (raw === undefined) return;
  const { list, rest } = records(raw, "laws");
  const laws = list.filter(isObj).sort((a, b) => (Number.isFinite(b.t) ? b.t : -Infinity) - (Number.isFinite(a.t) ? a.t : -Infinity));
  const jevCount = laws.filter((l) => l.source === "jev").length;
  const body = laws
    .map((l, i) => {
      const id = String(l.id ?? `#${i}`);
      const more = Object.fromEntries(Object.entries(l).filter(([k]) => !LAW_KNOWN.includes(k)));
      const jev = l.source === "jev";
      const meta = [
        `<code>${esc(l.id ?? "no id")}</code>`,
        l.verb != null ? `<span>verb ${esc(l.verb)}</span>` : "",
        l.source != null ? `<span class="src">${jev ? "\u2726 " : ""}${esc(l.source)}</span>` : "",
        l.by != null ? `<span>by ${esc(l.by)}</span>` : "",
        l.t != null ? `<span>${esc(when(l.t))}</span>` : "",
      ].join("");
      const det = Object.keys(more).length
        ? `<details data-id="${esc(id)}"${S.open.laws.has(id) ? " open" : ""}><summary>${Object.keys(more).length} more fields</summary><pre data-k="l-${esc(id)}">${esc(JSON.stringify(more, null, 2))}</pre></details>`
        : "";
      return `<article class="law${jev ? " jev" : ""}"><p class="law-text">${l.text != null ? esc(l.text) : nil("no text")}</p><p class="meta">${meta}</p>${det}</article>`;
    })
    .join("");
  const count = `<p class="count">${laws.length} laws, ${jevCount} ruled by Jev</p>`;
  paint(resOf("laws"), count + (laws.length ? `<div class="laws">${body}</div>` : muted("No laws yet.")) + restCard(rest));
}

function renderKinds() {
  const raw = S.data.kinds;
  if (raw === undefined) return;
  const { list, rest } = records(raw, "kinds");
  const kinds = list.filter(isObj);
  const names = new Map(kinds.map((k) => [String(k.id), k.name ?? k.id]));
  const q = $("#k-q").value.trim().toLowerCase();
  const madeOnly = $("#k-made").getAttribute("aria-pressed") === "true";
  const rows = kinds
    .filter((k) => (!madeOnly || k.made) && (!q || [k.name, k.id, ...Object.keys(isObj(k.props) ? k.props : {})].some((s) => String(s ?? "").toLowerCase().includes(q))))
    .sort((a, b) => {
      const am = a.made ? 0 : 1;
      const bm = b.made ? 0 : 1;
      if (am !== bm) return am - bm;
      if (am === 0) return (Number(a.made.t) || 0) - (Number(b.made.t) || 0);
      return String(a.name ?? a.id).localeCompare(String(b.name ?? b.id));
    });
  const madeCount = kinds.filter((k) => k.made).length;
  const body = rows
    .map((k) => {
      const parts = Array.isArray(k.parts)
        ? [...k.parts.reduce((m, p) => m.set(String(p), (m.get(String(p)) ?? 0) + 1), new Map())]
            .map(([p, n]) => `${esc(names.get(p) ?? p)}${n > 1 ? ` \u00d7${n}` : ""}`)
            .join(", ")
        : "";
      const props = isObj(k.props)
        ? Object.entries(k.props)
            .filter(([, v]) => Number.isFinite(v))
            .sort((a, b) => b[1] - a[1])
            .map(([p, v]) => `<span class="pc" style="--s:${Math.min(1, Math.max(0, v)).toFixed(2)}">${esc(p)}<b>${Number(v.toFixed(2))}</b></span>`)
            .join("")
        : "";
      const made = isObj(k.made) ? `${k.made.by != null ? esc(k.made.by) : nil("unknown")} <span class="sub">${esc(when(k.made.t))}</span>` : nil("natural");
      return `<tr${k.made ? ` class="made"` : ""}><td><span class="kname">${esc(k.name ?? k.id)}</span></td><td><code>${esc(k.id)}</code></td>
        <td>${k.base != null ? esc(k.base) : ""}</td><td>${k.verb != null ? esc(k.verb) : ""}</td><td class="nw">${made}</td>
        <td>${parts}</td><td>${props}</td></tr>`;
    })
    .join("");
  const count = `<p class="count">Showing ${rows.length} of ${kinds.length} kinds, ${madeCount} made</p>`;
  const table = rows.length
    ? `<div class="tw" data-k="k-tw"><table class="dt"><thead><tr><th>Name</th><th>Id</th><th>Base</th><th>Verb</th><th>Made</th><th>Parts</th><th>Props</th></tr></thead><tbody>${body}</tbody></table></div>`
    : muted("No kinds match.");
  paint(resOf("kinds"), count + table + restCard(rest));
}

const RENDER = { stats: renderStats, jev: renderJev, trace: renderTrace, laws: renderLaws, kinds: renderKinds };

function setTab(tab) {
  if (!TABS.includes(tab)) tab = "stats";
  S.tab = tab;
  for (const b of document.querySelectorAll("#tabs button[data-tab]")) b.setAttribute("aria-selected", String(b.dataset.tab === tab));
  for (const t of TABS) document.getElementById(t).hidden = t !== tab;
  if (location.hash.slice(1) !== tab) history.replaceState(null, "", `#${tab}`);
  RENDER[tab]();
  refresh(true);
}

function toggleRow(tab, e) {
  const tr = e.target.closest("tr.row[data-id]");
  if (!tr) return;
  const set = S.open[tab];
  const id = tr.dataset.id;
  if (set.has(id)) set.delete(id);
  else set.add(id);
  RENDER[tab]();
}

function debounce(fn, ms) {
  let h = 0;
  return () => {
    clearTimeout(h);
    h = setTimeout(fn, ms);
  };
}

function syncButtons() {
  const auto = $("#auto");
  auto.setAttribute("aria-pressed", String(S.auto));
  auto.textContent = S.auto ? "Auto 3s" : "Auto off";
  const pause = $("#pause");
  pause.setAttribute("aria-pressed", String(S.paused));
  pause.textContent = S.paused ? "Resume" : "Pause";
  stamp();
}

$("#tabs").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-tab]");
  if (b && b.dataset.tab !== S.tab) setTab(b.dataset.tab);
});
window.addEventListener("hashchange", () => {
  const tab = location.hash.slice(1);
  if (tab !== S.tab) setTab(tab);
});

$("#auto").addEventListener("click", () => {
  S.auto = !S.auto;
  syncButtons();
  if (S.auto) refresh(false);
  else clearTimeout(S.timer);
});
$("#pause").addEventListener("click", () => {
  S.paused = !S.paused;
  syncButtons();
  if (!S.paused) refresh(false);
});
$("#refresh").addEventListener("click", () => refresh(true));

for (const tab of ["jev", "trace"]) {
  const res = resOf(tab);
  res.addEventListener("click", (e) => toggleRow(tab, e));
  res.addEventListener("keydown", (e) => {
    if ((e.key === "Enter" || e.key === " ") && e.target.matches("tr.row")) {
      e.preventDefault();
      toggleRow(tab, e);
    }
  });
}
resOf("laws").addEventListener(
  "toggle",
  (e) => {
    const d = e.target;
    if (!d.matches?.("details[data-id]")) return;
    if (d.open) S.open.laws.add(d.dataset.id);
    else S.open.laws.delete(d.dataset.id);
  },
  true,
);

$("#ctr-q").addEventListener("input", debounce(renderCounters, 120));
$("#jev-agent").addEventListener("change", () => refresh(true));
$("#jev-purpose").addEventListener("change", renderJev);
for (const id of ["#tr-sys", "#tr-agent", "#tr-kind", "#tr-limit"]) $(id).addEventListener("change", () => refresh(true));
$("#tr-q").addEventListener("input", debounce(renderTrace, 150));
$("#k-q").addEventListener("input", debounce(renderKinds, 120));
$("#k-made").addEventListener("click", (e) => {
  const b = e.currentTarget;
  b.setAttribute("aria-pressed", String(b.getAttribute("aria-pressed") !== "true"));
  renderKinds();
});

syncButtons();
setTab(location.hash.slice(1));
