// The gate table: the JSON lines of scripts/globe-gates.ts (planet and region measures) laid against the cited targets, as JSON and markdown. A gate is never tuned to; each row names its
// target and the rule that turns it into pass or fail (the rule is ours where the citation gives a range, and is written in the row).
//   bun scripts/gates/table.ts <out.json> <out.md> <planet-and-region.jsonl>...
import { readFileSync, writeFileSync } from "node:fs";
import type { CoastRuns, Relief10 } from "./planet";
import type { RegionResult } from "./region";

interface Line { measure: string; tier: number; run: string; name?: string; value: unknown }
export interface Row { scope: string; gate: string; value: string; target: string; rule: string; pass: boolean | null }

const fmt = (n: number, d = 3) => (Number.isFinite(n) ? String(+n.toFixed(d)) : "n/a");
const lines: Line[] = process.argv.slice(4).flatMap((f) => readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Line));
const get = <T>(scope: (l: Line) => boolean, measure: string): T | undefined => lines.filter((l) => l.measure === measure && scope(l)).pop()?.value as T | undefined;

const rows: Row[] = [];
const add = (scope: string, gate: string, value: string, target: string, rule: string, pass: boolean | null) => rows.push({ scope, gate, value, target, rule, pass });

for (const tier of [0, 3]) {
  const on = (l: Line) => l.tier === tier && l.measure.startsWith("planet.");
  const scope = `planet tier ${tier}`;
  const share = get<number>(on, "planet.landShare"), h = get<{ mean: number; p50: number; p90: number; p99: number; max: number }>(on, "planet.landHeight");
  const rel = get<Relief10>(on, "planet.relief10"), comp = get<{ count: number; top5PlanetShare: number[] }>(on, "planet.components"), coast = get<CoastRuns>(on, "planet.coastRuns"), top = get<{ heightM: number; latDeg: number; lonDeg: number }>(on, "planet.summit");
  if (share === undefined || !h || !rel) continue;
  add(scope, "land share", fmt(share), "0.29 (Earth)", "within 0.03", Math.abs(share - 0.29) <= 0.03);
  add(scope, "land median (m)", fmt(h.p50, 0), "408 (Earth)", "within 20 %", Math.abs(h.p50 - 408) <= 0.2 * 408);
  add(scope, "land mean (m)", fmt(h.mean, 0), "673 to 840 (Earth)", "inside the range", h.mean >= 673 && h.mean <= 840);
  add(scope, "land p90 / p99 / max (m)", `${fmt(h.p90, 0)} / ${fmt(h.p99, 0)} / ${fmt(h.max, 0)}`, "none cited", "report", null);
  add(scope, "10 km relief > 1000 m (inland windows)", fmt(rel.inland.above1000), "< 0.05 of land (Montgomery and Brandon 2002)", "below", rel.inland.above1000 < 0.05);
  add(scope, "10 km relief > 1500 m (inland windows)", fmt(rel.inland.above1500), "< 0.02", "below", rel.inland.above1500 < 0.02);
  add(scope, "10 km relief > 2000 m (inland windows)", fmt(rel.inland.above2000), "none cited", "report", null);
  add(scope, "10 km relief > 1000 / 1500 / 2000 (windows centred on land)", `${fmt(rel.centred.above1000)} / ${fmt(rel.centred.above1500)} / ${fmt(rel.centred.above2000)}`, "none cited", "report", null);
  if (comp) add(scope, "land components: count, largest five (share of planet)", `${comp.count}: ${comp.top5PlanetShare.map((s) => fmt(s, 4)).join(", ")}`, "none cited", "report", null);
  if (top) add(scope, "tallest summit", `${fmt(top.heightM, 0)} m at ${fmt(top.latDeg, 1)}, ${fmt(top.lonDeg, 1)}`, "none cited", "report", null);
  if (coast) add(scope, "coast straight runs >= 40, 100, 150 km (count; share of coast)", ["40km", "100km", "150km"].map((k) => `${coast.runs[k].count}; ${fmt(coast.runs[k].coastShare, 3)}`).join("  ,  "), "none cited", `runs within ${coast.tolKm} km of a great circle; longest ${coast.longestRunKm} km, coast ${coast.coastKm} km`, null);
}

const regions = [...new Set(lines.filter((l) => l.measure.startsWith("region.")).map((l) => `${l.name}|${l.tier}`))];
for (const key of regions) {
  const [name, tierText] = key.split("|"), on = (l: Line) => l.name === name && String(l.tier) === tierText && l.measure.startsWith("region.");
  const r: Partial<RegionResult> = {};
  for (const l of lines.filter(on)) (r as Record<string, unknown>)[l.measure.slice(7)] = l.value;
  const scope = `region ${name} (tier ${tierText})`;
  if (r.lock) {
    const p = 32 / 180, n = r.lock.allLand, limit = n * p + 2 * Math.sqrt(n * p * (1 - p));
    add(scope, "lock windows (all-land windows within 8 degrees of an axis)", `${r.lock.locked} of ${n} (ridged ${r.lock.ridged}; uniform ${fmt(r.lock.uniformAll, 1)})`, "uniform 32/180 of the windows", `at most uniform + 2 sigma = ${fmt(limit, 1)}`, r.lock.locked <= limit);
  }
  if (r.ridge) add(scope, "ridge spacing: wavelength (km) of the largest excess over the power-law fit, ratio", `${fmt(r.ridge.wavelengthKm)} km, x${fmt(r.ridge.ratio, 2)}`, "1.5 to 3 km (Perron 2009 range, Lc 237 m)", "wavelength inside", r.ridge.insidePerron);
  if (r.rivers) {
    add(scope, "straight30 / straight300 (share of river cells in straight runs)", `${fmt(r.rivers.straight30)} / ${fmt(r.rivers.straight300)}`, "none cited", "report", null);
    add(scope, "lattice-straight 300-cell stretches", String(r.rivers.latticeStraight300), "0", "none", r.rivers.latticeStraight300 === 0);
    const st = r.rivers.stem;
    if (st) add(scope, "largest river stem sinuosity (length km)", `${fmt(st.sinuosity)} ${st.class} (${st.lengthKm} km); 200-cell reaches median ${fmt(st.reachMedian)} (${st.reachClass})`, "> 1.05 (Leopold and Wolman 1957: under 1.05 straight)", "not straight", st.sinuosity >= 1.05);
  }
  if (r.slopeByRelief) {
    const pop = r.slopeByRelief.filter((c) => c.n >= 1000 && c.meanRzM >= 250);
    if (pop.length) add(scope, "slope / S(Rz) per relief class (S = 4 + 0.014 Rz deg; n >= 1000 cells, Rz >= 250 m)", pop.map((c) => `${c.class}: ${fmt(c.slopeDeg, 1)} deg vs ${fmt(c.citedDeg, 1)} (${fmt(c.ratio, 2)}, n ${c.n})`).join("; "), "ratio 1 (Montgomery and Brandon 2002)", "every class within 0.8 to 1.25", pop.every((c) => c.ratio >= 0.8 && c.ratio <= 1.25));
  }
  if (r.relief10) {
    add(scope, "10 km relief > 1000 / 1500 m", `${fmt(r.relief10.above1000)} / ${fmt(r.relief10.above1500)}`, "< 0.05 / < 0.02", "both below", r.relief10.above1000 < 0.05 && r.relief10.above1500 < 0.02);
  }
  if (r.slope50 !== undefined) add(scope, "slope50 (share of land cells steeper than 50 %), land p99 (m)", `${fmt(r.slope50)}, ${fmt(r.landP99 ?? NaN, 0)}`, "none cited", "report", null);
  if (r.holdError) add(scope, "hold error: box mean p50 / p99 / max (m); 3x3 p99 (m)", `${fmt(r.holdError.box.p50, 1)} / ${fmt(r.holdError.box.p99, 1)} / ${fmt(r.holdError.box.max, 1)}; ${fmt(r.holdError.box3x3.p99, 1)}`, "none cited (exact box hold 0.00 to 0.03 m)", "report", null);
}

writeFileSync(process.argv[2], JSON.stringify(rows, null, 1));
const md = ["| scope | gate | value | target | rule | |", "|---|---|---|---|---|---|", ...rows.map((r) => `| ${r.scope} | ${r.gate} | ${r.value} | ${r.target} | ${r.rule} | ${r.pass === null ? "-" : r.pass ? "pass" : "FAIL"} |`)];
writeFileSync(process.argv[3], md.join("\n") + "\n");
console.log(`${rows.length} rows, ${rows.filter((r) => r.pass === false).length} fail, ${rows.filter((r) => r.pass === true).length} pass`);
