import { expect, test } from "bun:test";
import { DAY, TILE_M, addThing, newWorld, type Agent, type Incident, type Precedent, type World } from "./world";
import { homeOf } from "./physics";
import { put } from "./space";
import { newRel } from "./brain";
import { cluster, friendly, groups, incident, patterns, patternText, snubbed, standing } from "./groups";
import { jevCalls } from "./trace";

process.env.NOMADS_BRAIN = "random";

// Four neighbors who like each other, homes twenty meters apart in a row, the first built earliest.
function village(seed = 11): [World, Agent[]] {
  const w = newWorld(seed);
  w.agents = w.agents.slice(0, 4);
  const [x, y] = [30.5, 30.5];
  w.agents.forEach((a, i) => {
    put(w, a, x + (i * 20) / TILE_M, y);
    a.home = addThing(w, "structure", a.px, a.py, { owner: a.id, parts: { stick: 6 }, shelter: { tier: 1, style: "sticks", cover: 0.5, insul: 0.3, sturdy: 0.3, flam: 0.5, room: 1 }, hp: 100, maxHp: 100, born: i }).id;
  });
  for (const a of w.agents) for (const b of w.agents) if (a !== b) a.rel[b.id] = { ...newRel(0), affinity: 0.5 };
  return [w, w.agents];
}
const steal = (w: World, by: Agent, from: Agent): Incident => ({
  id: `I${w.nextId++}`, t: w.t, act: "steal", by: by.id, against: from.id, x: from.x, y: from.y, text: `${by.name} stole a berry from ${from.name}.`,
  features: { against_member: true, against_kin: false, against_child: false, value: 0.2, need: 0, season: "spring", scarcity: 0, repeat: 0, seenBy: [from.id] },
});

test("people living close who like each other become a camp, which keeps its identity as people drift off, until too few are left", () => {
  const [w, [a, b, c, d]] = village();
  cluster(w);
  expect(w.camps).toHaveLength(1);
  const camp = w.camps[0];
  expect([...camp.members].sort()).toEqual([a, b, c, d].map((x) => x.id).sort());
  expect(camp.name.startsWith(`${a.name}'s camp`)).toBe(true);
  // A falling out cuts d loose, but it's still the same camp.
  for (const x of [a, b, c]) d.rel[x.id].affinity = -0.5;
  cluster(w);
  expect(w.camps).toHaveLength(1);
  expect(camp.gone).toBeUndefined();
  expect([...camp.members].sort()).toEqual([a, b, c].map((x) => x.id).sort());
  // Two households aren't a camp.
  const far = homeOf(w, c)!;
  put(w, far, far.px + 5, far.py);
  cluster(w);
  expect(camp.gone).toBe(w.t);
});

test("each judged incident becomes a precedent, and the next judgment sees the similar cases and how they went", async () => {
  const [w, [a, b, c]] = village();
  cluster(w);
  const camp = w.camps[0];
  for (let i = 0; i < 3; i++) {
    w.t += 40;
    incident(w, { act: "steal", by: b, against: a, at: a, text: `${b.name} stole a berry from ${a.name}.`, value: 0.2, seenBy: [a, c], items: ["berry"] });
    await Bun.sleep(0); // flushes the random brain's already-resolved judgment chain; no real waiting
  }
  expect(camp.precedents).toHaveLength(3);
  expect(camp.precedents.every((p) => p.decidedBy !== b.id && camp.members.includes(p.decidedBy))).toBe(true);
  const pat = patterns(camp)[0];
  expect(pat.n).toBe(3);
  expect(patternText(pat)).toMatch(/^Stealing from a neighbor: /);
  const last = jevCalls({ purpose: "judge" }).at(-1)!.state as { similar_cases_here: string[]; what_happens_around_here: string[] };
  expect(last.similar_cases_here).toHaveLength(2);
  expect(last.what_happens_around_here[0]).toMatch(/^Stealing from a neighbor: /);
});

test("the same answer three times over becomes a spoken custom at an evening gathering", () => {
  const [w, [a, b, c]] = village();
  cluster(w);
  const camp = w.camps[0];
  for (let i = 0; i < 3; i++) camp.precedents.push({ id: `P${i}`, group: camp.id, incident: steal(w, b, a), response: "shun", decidedBy: a.id, t: w.t, followed: [], defied: [] });
  for (let day = 0; day < 10 && !camp.customs.length; day++)
    for (let h = 18; h < 22; h++) { w.t = (40 + day) * DAY + (h * DAY) / 24; groups(w); }
  expect(camp.customs[0]?.text).toBe("Here, anyone who steals from a neighbor is shunned.");
  expect(c.customs[camp.customs[0].id]).toBeDefined();
});

test("whoever's rulings get followed ends up leading; when people go against them, they lose it", () => {
  const [w, [a, b, c, d]] = village();
  cluster(w);
  const camp = w.camps[0];
  const p: Precedent = { id: "P1", group: camp.id, incident: steal(w, b, a), response: "shun", decidedBy: a.id, t: w.t, followed: [], defied: [], open: w.t + DAY };
  camp.precedents.push(p);
  camp.shunned[b.id] = { until: w.t + DAY, precedent: p.id };
  snubbed(w, c, b);
  snubbed(w, d, b);
  expect(p.followed).toEqual([c.id, d.id]);
  expect(standing(camp, a.id).share).toBe(1);
  expect(camp.leader).toBe(a.id);
  friendly(w, c, b);
  friendly(w, d, b);
  expect(p.defied).toEqual([c.id, d.id]);
  expect(standing(camp, a.id).share).toBe(0);
  expect(camp.leader).toBeNull();
  expect(w.events.filter((e) => e.kind === "leader")).toHaveLength(2);
});
