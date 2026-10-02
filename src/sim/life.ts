// Generations: people grow up, pair off, have children, grow old, and die. What they knew lives on only if they passed it on.
import { TRAITS } from "./traits";
import { COLORS, DAY, DESIRES, NAMES, YEAR, addThing, ageOf, clash, landing, log, meters, stageOf, type Agent, type World } from "./world";
import { dropPile, mark } from "./physics";
import { liveThings } from "./space";
import { newRel } from "./brain";
import { see } from "./beliefs";
import { trace } from "./trace";

const MAX_PEOPLE = 12;

export function die(w: World, a: Agent, cause: string) {
  w.agents = w.agents.filter((x) => x !== a);
  w.people[a.id] = { ...(w.people[a.id] ?? { id: a.id, name: a.name, color: a.color }), alive: false, died: w.t, cause };
  mark(w, addThing(w, "grave", a.px, a.py, { name: a.name, person: a.id, died: w.t, cause, born: w.t }));
  const c: Record<string, number> = {};
  for (const s of [...a.inv, ...(a.wearing ? [a.wearing] : [])]) c[s.k] = (c[s.k] ?? 0) + 1;
  for (const [k, n] of Object.entries(c)) dropPile(w, a.px, a.py, k, n);
  for (const t of liveThings(w)) if (t.owner === a.id && t.kind === "structure") { delete t.owner; mark(w, t); }
  log(w, "died", [a.id], a, `${a.name} died of ${cause}, aged ${Math.floor(ageOf(w, a))}.${Object.keys(a.beliefs).length ? ` What they knew went with them, unless they taught it.` : ""}`, `${a.name} died`);
  trace("world", "died", { id: a.id, cause, age: ageOf(w, a), beliefs: Object.keys(a.beliefs).length });
  see(w, a, "death", "People can die, and what they know dies with them unless they pass it on.", 300);
  for (const b of w.agents) {
    if (b.engaged === a.id) b.engaged = null;
    if (b.goal?.target === a.id) { b.goal = null; b.plan = []; }
    const r = b.rel[a.id];
    if (!r) continue;
    const close = r.label === "kin" || r.label === "sweetheart" || r.affinity > 0.35;
    if (!close) continue;
    b.needs.social = Math.max(0, b.needs.social - 35);
    log(w, "grief", [b.id], b, `${b.name} grieved for ${a.name}.`);
  }
}

const ROMAN = ["", "", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X"];
// Once every name is taken, children are named after someone long dead, the way families reuse a grandparent's name.
function nameAfter(w: World, all: string[]) {
  const living = new Set(w.agents.map((a) => a.name.split(" ")[0]));
  const free = NAMES.filter((n) => !living.has(n));
  const base = free[Math.floor(Math.random() * free.length)];
  const n = all.filter((x) => x.split(" ")[0] === base).length + 1;
  return `${base} ${ROMAN[n] ?? n}`;
}

function childOf(w: World, mother: Agent, father: Agent | undefined): Agent {
  const all = Object.values(w.people).map((p) => p.name), used = new Set(all);
  const name = NAMES.find((n) => !used.has(n)) ?? nameAfter(w, all);
  const id = w.people[name.toLowerCase()] ? `${name.toLowerCase().replaceAll(" ", "_")}${w.t}` : name.toLowerCase();
  const pool = { ...(father?.traits ?? {}), ...mother.traits };
  const traits: Record<string, number> = {};
  for (const [t, s] of Object.entries(pool)) if (Math.random() < 0.5 && !Object.keys(traits).some((o) => clash(o, t))) traits[t] = s;
  const names = Object.keys(TRAITS);
  while (Object.keys(traits).length < 4) {
    const t = names[Math.floor(Math.random() * names.length)];
    if (!traits[t] && !Object.keys(traits).some((o) => clash(o, t))) traits[t] = Math.round((0.4 + Math.random() * 0.6) * 100) / 100;
  }
  const colors = COLORS.filter((c) => !w.agents.some((x) => x.color === c));
  const desires = [mother.desires[Math.floor(Math.random() * mother.desires.length)], DESIRES[Math.floor(Math.random() * DESIRES.length)]].filter((d, i, arr) => arr.indexOf(d) === i);
  const top = Object.entries(traits).sort((x, y) => y[1] - x[1]).slice(0, 3).map(([t]) => t);
  const kid: Agent = {
    id, name, color: colors[0] ?? COLORS[w.agents.length % COLORS.length], x: mother.x, y: mother.y, px: mother.px, py: mother.py, heading: mother.heading,
    bio: `${name} is ${top.slice(0, -1).join(", ")} and ${top.at(-1)}, the child of ${mother.name}${father ? ` and ${father.name}` : ""}. ${name} wants to ${desires.join(" and to ")}.`,
    traits, desires, needs: { food: 90, energy: 90, warmth: 90, health: 100, social: 90 },
    skills: {}, inv: [], wearing: null, beliefs: {}, facts: {}, tried: {}, watching: {}, sickness: null, home: mother.home,
    born: w.t, parents: [mother.id, ...(father ? [father.id] : [])], children: [], pregnant: null,
    rel: {}, memory: [], goal: null, plan: [], status: "Just born", lastDecision: null,
    thinking: false, engaged: null, down: 0, nextDecide: w.t + 5, cooldowns: {}, seen: {}, near: {}, customs: {},
  };
  for (const parent of [mother, father].filter(Boolean) as Agent[]) {
    parent.children.push(kid.id);
    kid.rel[parent.id] = { ...newRel(w.t), affinity: 0.7, trust: 0.9, label: "kin" };
    parent.rel[kid.id] = { ...newRel(w.t), affinity: 0.8, trust: 0.8, label: "kin" };
  }
  return kid;
}

const paired = (a: Agent, b: Agent) => {
  const r = a.rel[b.id], s = b.rel[a.id];
  const sweet = (x?: typeof r) => !!x && (x.label === "sweetheart" || x.bonds.some((bd) => bd.kind === "sweetheart" && bd.weight > 0.3));
  return !!r && !!s && r.affinity > 0.45 && s.affinity > 0.45 && (sweet(r) || sweet(s) || (r.affinity > 0.7 && s.affinity > 0.7));
};

// When the land is nearly empty, strangers come ashore. They know nothing of what came before, except what they find.
function newcomer(w: World) {
  const spot = landing(w);
  if (!spot) return;
  const { x, y, px, py } = spot;
  // A pretend parent with nothing to pass on, so the stranger gets fresh traits.
  const stub = { id: "stranger", name: "a stranger", traits: {}, desires: [DESIRES[Math.floor(Math.random() * DESIRES.length)]], x, y, px, py, heading: 0, home: null, children: [], rel: {} } as unknown as Agent;
  const a = childOf(w, stub, undefined);
  a.parents = []; a.rel = {}; a.home = null;
  a.born = w.t - Math.round(YEAR * (1.5 + Math.random()));
  a.bio = a.bio.replace(/, the child of [^.]*\./, ".");
  a.status = "Arriving";
  w.agents.push(a);
  w.people[a.id] = { id: a.id, name: a.name, color: a.color, alive: true };
  log(w, "arrive", [a.id], a, `A stranger named ${a.name} came ashore from the sea.`, `${a.name} arrived`);
}

export function life(w: World) {
  if (w.agents.length < 3 && Math.random() < 1 / 1500) newcomer(w);
  for (const a of [...w.agents]) {
    if (a.pregnant && w.t >= a.pregnant.due) {
      const father = w.agents.find((x) => x.id === a.pregnant!.father);
      a.pregnant = null;
      const kid = childOf(w, a, father);
      w.agents.push(kid);
      w.people[kid.id] = { id: kid.id, name: kid.name, color: kid.color, alive: true };
      log(w, "born", [kid.id, a.id, ...(father ? [father.id] : [])], a, `${a.name}${father ? ` and ${father.name}` : ""} had a child: ${kid.name}.`, `${kid.name} born`);
      see(w, a, "birth", "Couples who live together and eat well have children.", 300);
      trace("world", "born", { id: kid.id, parents: kid.parents, traits: kid.traits });
    }
  }
  // Late evening: couples who share a home and a full belly may start a family.
  if (w.t % DAY === Math.round(DAY * 0.88) && w.agents.length < MAX_PEOPLE) {
    const adults = w.agents.filter((a) => stageOf(w, a) === "adult" && !a.pregnant && a.down <= w.t && a.needs.food > 40 && a.needs.health > 50);
    for (let i = 0; i < adults.length; i++)
      for (let j = i + 1; j < adults.length; j++) {
        const [a, b] = [adults[i], adults[j]];
        if (meters(a, b) > 30 || !paired(a, b) || a.pregnant || b.pregnant) continue;
        const home = [...liveThings(w)].some((t) => t.kind === "structure" && (t.owner === a.id || t.owner === b.id) && (t.shelter?.tier ?? 0) >= 1 && meters(t, a) <= 40);
        if (!home || Math.random() > 0.3) continue;
        const mother = Math.random() < 0.5 ? a : b, father = mother === a ? b : a;
        mother.pregnant = { father: father.id, due: w.t + DAY * 10 };
        log(w, "pregnant", [mother.id, father.id], mother, `${mother.name} and ${father.name} are expecting a child.`);
      }
  }
  if (w.t % DAY === 0) {
    for (const a of [...w.agents]) {
      const age = ageOf(w, a);
      if (age > 6.5 && Math.random() < (age - 6.5) * 0.06) die(w, a, "old age");
    }
  }
}

export const lifeSummary = (w: World, a: Agent) => ({ age: Math.round(ageOf(w, a) * 10) / 10, stage: stageOf(w, a), parents: a.parents, pregnant: !!a.pregnant });
