// Run a world headless and print what happened.
//   NOMADS_BRAIN=random bun scripts/run.ts --ticks 20000 --seed 7     (no Jev, fast)
//   bun scripts/run.ts --ticks 2000                                    (real Jev, needs TYPESAFE_API_KEY)
import { newWorld, clock } from "../src/sim/world";
import { tick } from "../src/sim/sim";
import { changed, newKinds, removed } from "../src/sim/physics";
import { beliefText } from "../src/sim/beliefs";
import { counters, logTo, flush, tickMs } from "../src/sim/trace";
import { patterns, patternText, standing } from "../src/sim/groups";

const arg = (name: string, d: string) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : d; };
const ticks = Number(arg("ticks", "5000")), seed = Number(arg("seed", String(Math.floor(Math.random() * 1e9))));
const logs = arg("logs", "");
if (logs) logTo(logs);
const w = newWorld(seed);
const t0 = performance.now();
for (let i = 0; i < ticks; i++) {
  tick(w);
  changed.clear(); removed.clear(); newKinds.clear();
  if (logs) flush();
  await Bun.sleep(process.env.NOMADS_BRAIN === "random" ? 0 : 20);
}
const kinds: Record<string, number> = {};
for (const e of w.events) kinds[e.kind] = (kinds[e.kind] ?? 0) + 1;
console.log(`seed ${seed}, ${ticks} ticks, ${clock(w.t)}, ${Math.round(performance.now() - t0)}ms`);
console.log("events", JSON.stringify(kinds));
console.log("\nLAWS");
for (const l of Object.values(w.laws)) console.log(`  ${l.id} [${l.source}] ${clock(l.t)} by ${l.by}: ${l.text}`);
console.log("\nMADE");
for (const k of Object.values(w.kinds).filter((k) => k.made)) console.log(`  ${k.name}${k.plain ? ` (${k.plain})` : ""} x${k.count ?? 1}, first by ${k.made!.by} ${clock(k.made!.t)}: ${JSON.stringify(k.props)}`);
console.log("\nNOTABLE");
for (const e of w.events.filter((e) => ["invent", "law", "first", "burned", "mistaken", "learn", "teach", "attack", "hunt", "lightning", "collapse", "sick", "build", "fire", "camp", "custom", "leader", "driven_out", "judged", "camp_named"].includes(e.kind)).slice(-80)) console.log(`  ${clock(e.t)} ${e.kind}: ${e.text}`);
console.log("\nCAMPS");
for (const c of w.camps) {
  console.log(`  ${c.id} ${c.name}${c.gone ? ` (gone ${clock(c.gone)}${c.mergedInto ? `, into ${c.mergedInto}` : ""})` : ""}: ${c.members.join(", ")}; leader ${c.leader ?? "none"}; ${c.precedents.length} precedents`);
  for (const x of patterns(c).slice(0, 6)) console.log(`    ~ ${patternText(x)}`);
  for (const k of c.customs) console.log(`    * ${k.text} (${k.held} held, ${k.broken} broken${k.faded ? ", faded" : ""})`);
  for (const id of new Set(c.precedents.map((p) => p.decidedBy))) { const s = standing(c, id); console.log(`    ${id}: followed ${s.followed}, defied ${s.defied}`); }
}
console.log(`incidents ${w.incidents.length}: ${JSON.stringify(w.incidents.reduce<Record<string, number>>((m, i) => ((m[i.act] = (m[i.act] ?? 0) + 1), m), {}))}`);
console.log("\nAGENTS");
for (const a of w.agents) {
  console.log(`  ${a.name}: ${a.status} | needs ${Object.entries(a.needs).map(([k, v]) => `${k} ${Math.round(v)}`).join(" ")} | carrying ${a.inv.map((s) => w.kinds[s.k]?.name).join(", ")}`);
  for (const b of Object.values(a.beliefs)) console.log(`    - ${beliefText(w, b)} [${b.how}, ${b.wins}/${b.tries}]`);
}
console.log(`\nanimals: deer ${w.animals.filter((a) => a.species === "deer").length}, wolves ${w.animals.filter((a) => a.species === "wolf").length}; structures ${w.things.filter((t) => t.kind === "structure").length}; fires ${w.things.filter((t) => t.kind === "fire").length}`);
console.log("tickMs", JSON.stringify(Object.fromEntries(Object.entries(tickMs).map(([k, v]) => [k, Math.round(v * 100) / 100]))));
console.log("jev", JSON.stringify(w.jev), "counters", JSON.stringify(Object.fromEntries(Object.entries(counters).filter(([k]) => !k.startsWith("belief")))));
process.exit(0);
