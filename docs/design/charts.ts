// Draws the learning charts in docs/design/index.html from the eval ledger (evals/*.json): the latest probes run on
// five or more seeds with the offline brain, beside the baseline before it (the last build of its kind that became the
// baseline, on another commit), so what a change did shows; and the latest whole-worlds run on its own. A whole-worlds
// run scores its build and the one it was held against on an answer key of their own (scripts/evals.ts, tier 4), and the
// ledger keeps only its build's numbers, so another run's islands, on another key, can't stand beside them. Each chart
// replaces what sits between its markers, <!-- chart:NAME --> and <!-- /chart:NAME -->, so the page keeps working from
// disk with no script.
//   bun docs/design/charts.ts
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

type Numbers = Record<string, number | null>;
type Entry = {
  at: string; tier: string; brain: string; days: number; people?: number; commit: string; version: number; seeds: number[];
  runs: Record<string, Record<string, Numbers>>; claims: Record<string, Record<string, boolean | null>>; verdict: string; baseline: boolean;
};

const ROOT = join(import.meta.dir, "../.."), PAGE = join(import.meta.dir, "index.html");
const ledger: Entry[] = readdirSync(join(ROOT, "evals")).filter((f) => f.endsWith(".json")).sort()
  .map((f) => JSON.parse(readFileSync(join(ROOT, "evals", f), "utf8")));
const probes = ledger.filter((e) => e.tier === "probes" && e.brain === "random" && e.seeds.length >= 5).at(-1);
const worlds = ledger.filter((e) => e.tier === "worlds").at(-1);
// where things stood before: the last baseline of its kind before it, on another commit, that gave other numbers for
// something both measured (a build that only adds probes leaves the rest as they were, so the chart looks past it)
const same = (a: Entry, b: Entry) => Object.keys(a.runs).every((v) => !b.runs[v] || JSON.stringify(a.runs[v]) === JSON.stringify(b.runs[v]));
const before = (e: Entry) => ledger.filter((x) => x.tier === e.tier && x.brain === e.brain && x.version === e.version && x.days === e.days
  && x.people === e.people && x.at < e.at && x.baseline && x.commit !== e.commit && !same(e, x)).at(-1);

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const pct = (v: number) => `${Math.round(v * 100)}%`;
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const valuesOf = (e: Entry, run: string, m: string) =>
  e.seeds.map((s) => e.runs[run]?.[String(s)]?.[m]).filter((x): x is number => typeof x === "number");
const source = (e: Entry) => `evals/${e.at.replace(/:/g, "-").replace(".", "-")}-${e.tier}-${e.brain}-${e.commit}.json`;

// ---------- probes: one row per number, a dot per seed, the world as it is and flipped ----------
// only: a variant drawn on its own line, as the world is drawn, for a probe with a third way of staging it
const ROWS: { probe: string; metric: string; label: string; good: "high" | "low"; only?: string }[] = [
  { probe: "choose", metric: "first", label: "First five tries made the faster way", good: "high" },
  { probe: "choose", metric: "best", label: "Late tries made the faster way", good: "high" },
  { probe: "blame", metric: "right", label: "Blame what truly kills sparks", good: "high" },
  { probe: "blame", metric: "wrong", label: "Blame something that doesn't", good: "low" },
  { probe: "blame", metric: "acc", label: "Theories call it right, at the end", good: "high" },
  { probe: "confounded", metric: "right", label: "Blame the true cause", good: "high" },
  { probe: "confounded", metric: "bystander", label: "Also blame the one that comes with it", good: "low" },
  { probe: "recover", metric: "right", label: "Blame the new cause by the end", good: "high" },
  { probe: "recover", metric: "retried", label: "Try the old cause again and see it work", good: "high" },
  { probe: "spread", metric: "right", label: "Blame the true cause by the end", good: "high" },
  { probe: "spread", metric: "wrong", label: "Keep the false cause they were told", good: "low" },
  { probe: "two", metric: "right", label: "Blame both", good: "high" },
  { probe: "except", metric: "exact", label: "Rule it out just where it fails", good: "high" },
  { probe: "except", metric: "acc", label: "Theories call it right, at the end", good: "high" },
  { probe: "rare", metric: "right", label: "Blame it", good: "high" },
  { probe: "seed", metric: "right", label: "Blame what withers seedlings", good: "high" },
  { probe: "seed", metric: "right", label: "The same, one planting a day", good: "high", only: "sparse" },
  { probe: "seed", metric: "right", label: "The same, shade and crowding both", good: "high", only: "two" },
  { probe: "seed", metric: "weather", label: "Blame the weather for it", good: "low" },
  { probe: "seed", metric: "acc", label: "Theories call it right, at the end", good: "high" },
  { probe: "hearsay", metric: "heard", label: "Pick it up from the two who know", good: "high" },
  { probe: "unlearn", metric: "kept", label: "Keep the false theory they began with", good: "low" },
  { probe: "unlearn", metric: "kept", label: "The same, one planting a day", good: "low", only: "sparse" },
];
const PROBE_TEXT: Record<string, string> = {
  choose: "Choose: two ways to a fire, one truly faster",
  blame: "Blame: sparks die in one kind of weather",
  confounded: "Confounded: night rain, one of two kills sparks",
  recover: "Recover: the cause changes halfway",
  spread: "Spread: some know, some were told wrong",
  two: "Two: rain and wind both kill sparks",
  except: "Except: sparks die in the rain unless the wind is up",
  rare: "Rare: what kills sparks comes one hour in twelve",
  seed: "Seed: shade withers seedlings, days later",
  hearsay: "Hearsay: two planters know, four don't",
  unlearn: "Unlearn: planters start out wrong about the rain",
};

function probesChart(e: Entry, was?: Entry) {
  const W = 760, L = 300, R = 24, plot = W - L - R, rowH = 34, headH = 30, top = 40;
  const x = (v: number) => L + v * plot;
  let y = top, body = "";
  // gridlines and the scale
  const ticks = [0, 0.25, 0.5, 0.75, 1];
  let last = "";
  const rows: string[] = [];
  for (const r of ROWS) {
    if (r.probe !== last) {
      y += last ? 10 : 0;
      rows.push(`<text class="c-group" x="0" y="${y + 20}">${esc(PROBE_TEXT[r.probe])}</text>`);
      y += headH; last = r.probe;
    }
    const cy = y + rowH / 2;
    rows.push(`<text class="c-label" x="12" y="${cy + 5}">${esc(r.label)}</text>`);
    rows.push(`<line class="c-row" x1="${L}" x2="${L + plot}" y1="${cy}" y2="${cy}"/>`);
    const lines: [string, number, string][] = r.only ? [[r.only, 0, "c-real"]] : [["real", -6, "c-real"], ["flipped", 6, "c-flip"]];
    for (const [variant, dy, cls] of lines) {
      const xs = valuesOf(e, `${r.probe}/${variant}`, r.metric);
      if (!xs.length) continue;
      const m = mean(xs), old = was && valuesOf(was, `${r.probe}/${variant}`, r.metric);
      // where the baseline before it stood, and the way it moved from there
      if (old?.length) {
        const o = mean(old);
        rows.push(`<line class="c-shift" x1="${x(o).toFixed(1)}" x2="${x(m).toFixed(1)}" y1="${cy + dy}" y2="${cy + dy}"/>`);
        rows.push(`<line class="c-before" x1="${x(o).toFixed(1)}" x2="${x(o).toFixed(1)}" y1="${cy + dy - 7}" y2="${cy + dy + 7}"><title>${variant}, before: ${pct(o)}</title></line>`);
      }
      // seeds that land on the same value line up beside it, toward the middle of the scale, so each one shows
      const seen = new Map<number, number>();
      for (const v of xs) {
        const k = Math.round(v * 200), n = seen.get(k) ?? 0;
        seen.set(k, n + 1);
        rows.push(`<circle class="${cls}" cx="${(x(v) + (v >= 0.5 ? -1 : 1) * n * 3.4).toFixed(1)}" cy="${cy + dy}" r="3.6"><title>${variant}: ${pct(v)}</title></circle>`);
      }
      rows.push(`<line class="${cls}-mean" x1="${x(m).toFixed(1)}" x2="${x(m).toFixed(1)}" y1="${cy + dy - 8}" y2="${cy + dy + 8}"/>`);
    }
    y += rowH;
  }
  const H = y + 34;
  for (const t of ticks) {
    body += `<line class="c-grid" x1="${x(t)}" x2="${x(t)}" y1="${top - 6}" y2="${H - 28}"/>`;
    body += `<text class="c-tick" x="${x(t)}" y="${H - 10}" text-anchor="middle">${pct(t)}</text>`;
  }
  const legend = `<g transform="translate(${L - 290},14)"><circle class="c-real" cx="0" cy="0" r="5"/><text class="c-tick" x="10" y="4">the world as it is</text>`
    + `<circle class="c-flip" cx="150" cy="0" r="5"/><text class="c-tick" x="160" y="4">flipped physics</text>`
    + `<line class="c-real-mean" x1="290" x2="290" y1="-8" y2="8"/><text class="c-tick" x="298" y="4">mean of ${e.seeds.length} seeds</text>`
    + (was ? `<line class="c-before" x1="440" x2="440" y1="-7" y2="7"/><text class="c-tick" x="448" y="4">mean before, at ${esc(was.commit.slice(0, 7))}</text>` : "") + `</g>`;
  const svg = `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-labelledby="probes-title probes-desc">`
    + `<title id="probes-title">Probe results by seed</title>`
    + `<desc id="probes-desc">For each probe, the share of people who end up holding each belief, one dot per seed, for the world as it is and with the physics flipped${was ? ", with a grey tick where the mean stood at the baseline before" : ""}. Read the table below the chart for every number.</desc>`
    + legend + body + rows.join("") + `</svg>`;
  const cell = (x: Entry | undefined, run: string, m: string) => { const v = x ? valuesOf(x, run, m) : []; return v.length ? pct(mean(v)) : "none"; };
  const head = was ? `<th scope="col">As it is</th><th scope="col">Flipped</th><th scope="col">Before, as it is</th><th scope="col">Before, flipped</th>` : `<th scope="col">As it is</th><th scope="col">Flipped</th>`;
  const table = `<details class="numbers"><summary>The numbers</summary><table><thead><tr><th scope="col">Probe</th><th scope="col">Share of people who</th>${head}</tr></thead><tbody>`
    + ROWS.map((r) => {
      const real = `${r.probe}/${r.only ?? "real"}`, flipped = r.only ? "" : `${r.probe}/flipped`;
      return `<tr><td>${r.probe}</td><td>${esc(r.label.toLowerCase())}</td><td>${cell(e, real, r.metric)}</td><td>${cell(e, flipped, r.metric)}</td>`
        + (was ? `<td>${cell(was, real, r.metric)}</td><td>${cell(was, flipped, r.metric)}</td>` : "") + `</tr>`;
    }).join("") + `</tbody></table></details>`;
  const claims = Object.entries(e.claims).flatMap(([variant, cs]) => Object.entries(cs).map(([id, ok]) => ({ variant, id, ok })));
  const held = claims.filter((c) => c.ok === true).length;
  const count = (x: Entry) => { const cs = Object.values(x.claims).flatMap((c) => Object.values(c)); return `${cs.filter((c) => c === true).length} of ${cs.length}`; };
  const note = `<p class="chart-source">From <code>${esc(source(e))}</code>: ${e.seeds.length} seeds of ${e.days} days with ${e.people ?? 6} people, the offline brain, commit ${e.commit}, ${e.at.slice(0, 10)}. ${held} of ${claims.length} claims hold${was ? ` (${count(was)} at ${esc(was.commit)})` : ""}; open: ${claims.filter((c) => c.ok === false).map((c) => `${c.variant} ${c.id}`).join(", ") || "none"}.</p>`;
  return `<figure class="chart-fig wide">${svg}<figcaption><span class="fig-n">Chart 1</span> What the probes found. Each dot is one seed; the tick is the mean${was ? ", and the grey tick where the mean stood before" : ""}. The physics is set otherwise in the flipped runs (plain stone sparks better than flint, the wind or the dark kills sparks instead of the rain), so a learner with the answer written in passes one and fails the other.</figcaption>${note}${table}</figure>`;
}

// ---------- worlds: true theories per person-day, never learning, as it is, knowing from the start ----------
function worldsChart(e: Entry, was?: Entry) {
  const W = 760, L = 140, R = 30, plot = W - L - R, rowH = 40, top = 46;
  // a log scale from 0.01 to 10, with "none" to the left of it
  const lo = Math.log10(0.01), hi = Math.log10(10), none = L - 34;
  const x = (v: number) => (v <= 0 ? none : L + ((Math.log10(Math.max(v, 0.01)) - lo) / (hi - lo)) * plot);
  let out = "";
  const H = top + e.seeds.length * rowH + 40;
  for (const t of [0.01, 0.1, 1, 10]) {
    out += `<line class="c-grid" x1="${x(t)}" x2="${x(t)}" y1="${top - 10}" y2="${H - 32}"/><text class="c-tick" x="${x(t)}" y="${H - 12}" text-anchor="middle">${t}</text>`;
  }
  out += `<text class="c-tick" x="${none}" y="${H - 12}" text-anchor="middle">none</text>`;
  e.seeds.forEach((s, i) => {
    const cy = top + i * rowH + rowH / 2;
    out += `<text class="c-label" x="0" y="${cy + 5}">Island ${s}</text><line class="c-row" x1="${none}" x2="${L + plot}" y1="${cy}" y2="${cy}"/>`;
    const v = (run: string, x = e) => x.runs[run]?.[String(s)]?.right;
    const off = v("off"), seen = v("seen"), known = v("known"), old = was && v("seen", was);
    if (typeof seen === "number" && typeof known === "number") out += `<line class="c-span" x1="${x(seen)}" x2="${x(known)}" y1="${cy}" y2="${cy}"/>`;
    // the floor sits just left of "none" when it is none, so a dot there doesn't hide it
    if (typeof off === "number") out += `<rect class="c-off" x="${x(off) - (off <= 0 ? 19 : 5)}" y="${cy - 5}" width="10" height="10"><title>learning off: ${off}</title></rect>`;
    if (typeof known === "number") out += `<path class="c-known" d="M${x(known)} ${cy - 7}l7 7l-7 7l-7-7z"><title>known from the start: ${known.toFixed(2)}</title></path>`;
    if (typeof old === "number") out += `<circle class="c-was" cx="${x(old)}" cy="${cy}" r="6"><title>as it was before: ${old.toFixed(2)}</title></circle>`;
    if (typeof seen === "number") out += `<circle class="c-real" cx="${x(seen)}" cy="${cy}" r="6"><title>as it is: ${seen.toFixed(2)}</title></circle>`;
  });
  const legend = `<g transform="translate(${L - 130},16)"><rect class="c-off" x="-5" y="-5" width="10" height="10"/><text class="c-tick" x="10" y="4">learning off (the floor)</text>`
    + `<circle class="c-real" cx="190" cy="0" r="6"/><text class="c-tick" x="202" y="4">as it is</text>`
    + (was ? `<circle class="c-was" cx="290" cy="0" r="6"/><text class="c-tick" x="302" y="4">before, at ${esc(was.commit.slice(0, 7))}</text>` : "")
    + `<path class="c-known" d="M${was ? 440 : 290} -7l7 7l-7 7l-7-7z"/><text class="c-tick" x="${was ? 454 : 304}" y="4">known from the start (the ceiling)</text></g>`;
  const svg = `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-labelledby="worlds-title worlds-desc"><title id="worlds-title">True theories held per person-day, by island</title>`
    + `<desc id="worlds-desc">For each island, true theories held per person-day in the last third of the run, on a log scale: with learning off, as it is, and with the true theories known from the start.</desc>${legend}${out}</svg>`;
  const rows = e.seeds.map((s) => {
    const r = (run: string, m: string, x = e) => { const v = x.runs[run]?.[String(s)]?.[m]; return typeof v === "number" ? (m === "right" ? v.toFixed(2) : pct(v)) : "none"; };
    return `<tr><td>${s}</td><td>${r("off", "right")}</td><td>${r("seen", "right")}</td>${was ? `<td>${r("seen", "right", was)}</td>` : ""}<td>${r("known", "right")}</td><td>${r("seen", "wasted")}</td><td>${r("seen", "coverage")}</td></tr>`;
  }).join("");
  const table = `<details class="numbers"><summary>The numbers</summary><table><thead><tr><th scope="col">Island</th><th scope="col">Off</th><th scope="col">As it is</th>${was ? `<th scope="col">Before</th>` : ""}<th scope="col">Known</th><th scope="col">Tries wasted, as it is</th><th scope="col">Tries the key could judge</th></tr></thead><tbody>${rows}</tbody></table></details>`;
  const note = `<p class="chart-source">From <code>${esc(source(e))}</code>: ${e.seeds.length} islands of ${e.days} days, the offline brain, commit ${e.commit}, ${e.at.slice(0, 10)}; the last third of each run${was ? `; before is ${esc(was.commit)}` : ""}.</p>`;
  return `<figure class="chart-fig wide">${svg}<figcaption><span class="fig-n">Chart 2</span> Whole worlds between a floor and a ceiling: true theories held per person-day, on a log scale${was ? ", with a hollow dot where the island stood before" : ""}. Where the dot sits far left of the diamond, the island had much more to teach than its people learned.</figcaption>${note}${table}</figure>`;
}

let page = readFileSync(PAGE, "utf8");
const put = (name: string, html: string) => {
  const re = new RegExp(`(<!-- chart:${name} -->)[\\s\\S]*?(<!-- /chart:${name} -->)`);
  if (!re.test(page)) throw new Error(`no markers for chart ${name} in ${PAGE}`);
  page = page.replace(re, `$1\n${html}\n$2`);
};
if (probes) put("probes", probesChart(probes, before(probes)));
if (worlds) put("worlds", worldsChart(worlds));
writeFileSync(PAGE, page);
console.log(`charts from ${probes ? source(probes) : "no probes run"} and ${worlds ? source(worlds) : "no worlds run"}`);
