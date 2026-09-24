// Every Jev call lives here: pick a goal, answer another agent, and decide what an event meant.
import {
  BELIEFS, BONDS, BOND_FADE, LABELS, clock, dist, level, type Agent, type BondKind, type Label, type Relationship, type World,
} from "./world";
import { TRAITS } from "./traits";
import { RECIPE } from "./recipes";

// Clues turn into hunches the agent can act on: the more clues, the more of the recipe they can see.
function hunches(a: Agent) {
  return Object.entries(a.clues).filter(([id, c]) => c >= 0.7 && !a.know[id]).sort((x, y) => y[1] - x[1]).slice(0, 3).map(([id, c]) => {
    const r = RECIPE[id];
    const parts = [...Object.keys(r.inputs), ...(r.tools ?? [])].map((i) => i.replaceAll("_", " "));
    const shown = c >= 1.5 ? parts : parts.slice(0, Math.max(1, parts.length - 1));
    const rest = shown.length < parts.length ? " and something else" : "";
    return `a hunch that ${shown.join(" and ")}${rest}${r.near ? ` near a ${r.near}` : ""} could make something useful`;
  });
}

const ENDPOINT = "https://api.typesafe.ai/v1/systemone";

type Answer = { type: string; choice?: string; probabilities?: Record<string, number>; confidence?: number; noul?: number; score?: number };

async function ask(w: World, state: unknown, questions: Record<string, unknown>): Promise<Record<string, Answer>> {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.TYPESAFE_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "jev-latest", state, questions }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`jev ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const body = (await res.json()) as { answers: Record<string, Answer>; usage?: { input_tokens: number } };
  w.jev.calls++;
  w.jev.tokens += body.usage?.input_tokens ?? 0;
  return body.answers;
}

// Flatten Jev's odds a little so a 30% option still happens sometimes; options Jev gives ~0% never do.
export function sample(probs: Record<string, number>): string {
  const keys = Object.keys(probs);
  const weights = keys.map((k) => Math.pow(probs[k], 0.8));
  let r = Math.random() * weights.reduce((a, b) => a + b, 0);
  for (let i = 0; i < keys.length; i++) if ((r -= weights[i]) <= 0) return keys[i];
  return keys.at(-1)!;
}

const needWord = (v: number) => `${Math.round(v)}/100 (${v < 15 ? "desperate" : v < 35 ? "low" : v < 65 ? "okay" : "good"})`;
const feeling = (x: number) => (x < -0.6 ? "hates" : x < -0.2 ? "dislikes" : x < 0.2 ? "feels neutral about" : x < 0.6 ? "likes" : "loves");
const trusting = (x: number) => (x < 0.2 ? "does not trust" : x < 0.5 ? "somewhat trusts" : x < 0.8 ? "trusts" : "completely trusts");

export function newRel(t: number): Relationship {
  return { affinity: 0, trust: 0.3, label: "stranger", bonds: [], beliefs: {}, ledger: 0, history: [], met: t };
}

function describeRel(w: World, a: Agent, b: Agent) {
  const r = a.rel[b.id];
  if (!r) return { relationship: "never met" };
  return {
    relationship: `${LABELS[r.label]} (${r.label})`,
    feeling: `${a.name} ${feeling(r.affinity)} ${b.name}`,
    trust: `${a.name} ${trusting(r.trust)} ${b.name}`,
    bonds: [...r.bonds].sort((x, y) => y.weight - x.weight).slice(0, 4).map((x) => `${BONDS[x.kind]} (${clock(x.t)})`),
    beliefs: Object.entries(r.beliefs).map(([k, v]) =>
      v! > 0.65 ? `thinks ${b.name} is ${k}` : v! < 0.35 ? `thinks ${b.name} is not ${k}` : `unsure if ${b.name} is ${k}`,
    ),
    favors: r.ledger > 0 ? `${b.name} has done ${a.name} ${r.ledger} more favors than the reverse` : r.ledger < 0 ? `${a.name} has done ${b.name} ${-r.ledger} more favors than the reverse` : undefined,
    history: r.history.slice(-4),
  };
}

export function view(w: World, a: Agent) {
  const near: Record<string, { count: number; nearest: number }> = {};
  for (const t of w.things) {
    const d = dist(a, t);
    if (d > 10 || (t.kind === "bush" && !t.n)) continue;
    const kind = t.kind.replaceAll("_", " ");
    const label = t.owner && t.kind !== "fire" ? (t.owner === a.id ? `your ${kind}` : `${w.agents.find((x) => x.id === t.owner)?.name}'s ${kind}`) : kind;
    const e = (near[label] ??= { count: 0, nearest: d });
    e.count++;
    e.nearest = Math.min(e.nearest, d);
  }
  const nearby = Object.fromEntries(Object.entries(near).map(([k, e]) => [k, `${e.count} (nearest ${e.nearest} steps)`]));
  const people = w.agents
    .filter((b) => b.id !== a.id && (a.rel[b.id] || dist(a, b) <= 8))
    .map((b) => ({
      name: b.name,
      distance: `${dist(a, b)} steps`,
      doing: dist(a, b) <= 12 ? b.status : "out of sight",
      carrying: dist(a, b) <= 6 ? inventoryText(b) : undefined,
      ...describeRel(w, a, b),
    }));
  return {
    you: a.name,
    bio: a.bio,
    traits: Object.entries(a.traits).map(([t, s]) => `${t} (${s > 0.75 ? "strongly" : s > 0.55 ? "fairly" : "slightly"}): ${TRAITS[t]}`),
    desires: a.desires,
    time: clock(w.t),
    needs: Object.fromEntries(Object.entries(a.needs).map(([k, v]) => [k, needWord(v)])),
    skills: Object.fromEntries(Object.entries(a.skills).filter(([, xp]) => xp > 0).map(([s, xp]) => [s, `level ${level(xp)}`])),
    carrying: inventoryText(a),
    knows_how_to: Object.keys(a.know).map((id) => RECIPE[id].label),
    hunches: hunches(a),
    home: a.home ? `a shelter ${dist(a, a.home)} steps away` : "no home yet",
    current_goal: a.goal?.type ?? "none",
    nearby,
    people,
    recent_memory: a.memory.slice(-8),
  };
}

export const inventoryText = (a: Agent) =>
  Object.entries(a.inv).filter(([, n]) => n).map(([i, n]) => `${n} ${i}`).join(", ") || "nothing";

export async function decide(w: World, a: Agent, options: Record<string, string>, towards: string[], against: string[]) {
  const q: Record<string, unknown> = {
    goal: { type: "choice", instructions: `Given who ${a.name} is, what they need, and who is around, what will ${a.name} most likely do next?`, criteria: options },
  };
  const names = (ids: string[]) => Object.fromEntries(ids.map((id) => [w.agents.find((b) => b.id === id)!.name, null]));
  if (towards.length) q.towards = { type: "choice", instructions: `If ${a.name} sought someone out to be friendly, ask for something, or work together, who would it be?`, criteria: names(towards) };
  if (against.length) q.against = { type: "choice", instructions: `If ${a.name} acted against someone or wanted to keep away from them, who would it be?`, criteria: names(against) };
  const ans = await ask(w, view(w, a), q);
  const byName = (p?: Record<string, number>) =>
    p && Object.fromEntries(Object.entries(p).map(([n, v]) => [w.agents.find((b) => b.name === n)!.id, v]));
  return { goal: ans.goal.probabilities!, towards: byName(ans.towards?.probabilities), against: byName(ans.against?.probabilities) };
}

export async function chooseTinker(w: World, a: Agent, options: string[]) {
  const failed = Object.entries(a.tried).sort((x, y) => y[1] - x[1]).slice(0, 10).map(([k]) => k);
  const ans = await ask(w, { ...view(w, a), already_tried_with_no_luck: failed }, {
    attempt: {
      type: "choice",
      instructions: `${a.name} is tinkering, trying to make something new and useful from what they're holding and what's around them. Which of these would ${a.name} most likely try?`,
      criteria: Object.fromEntries(options.map((o) => [o, null])),
    },
  });
  return sample(ans.attempt.probabilities!);
}

export async function respond(w: World, me: Agent, them: Agent, situation: string, options: Record<string, string>) {
  const ans = await ask(w, { ...view(w, me), what_is_happening: situation }, {
    reply: { type: "choice", instructions: `${situation} How does ${me.name} respond?`, criteria: options },
  });
  return sample(ans.reply.probabilities!);
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

// After an interaction, `me` decides what it meant for how they see `them`.
export async function reflect(w: World, me: Agent, them: Agent, happened: string) {
  const r = (me.rel[them.id] ??= newRel(w.t));
  const shift = ["much worse", "a bit worse", "no change", "a bit better", "much better"];
  const q: Record<string, unknown> = {
    bond: { type: "choice", instructions: `What lasting mark, if any, does this leave on how ${me.name} sees ${them.name}?`, criteria: BONDS },
    feeling: { type: "score", instructions: `How does this change how much ${me.name} likes ${them.name}?`, criteria: shift },
    trust: { type: "score", instructions: `How does this change how much ${me.name} trusts ${them.name}?`, criteria: shift },
    label: { type: "choice", instructions: `After this, what best describes how ${me.name} sees their relationship with ${them.name}?`, criteria: LABELS },
  };
  for (const b of BELIEFS) q[`believes_${b}`] = { type: "noul", instructions: `From everything ${me.name} has seen and heard, is ${them.name} ${b}?` };
  const ans = await ask(w, {
    who: { name: me.name, bio: me.bio, traits: Object.keys(me.traits) },
    them: { name: them.name, ...describeRel(w, me, them) },
    what_just_happened: happened,
  }, q);
  r.affinity = clamp(r.affinity + (ans.feeling.score! - 2) * 0.12, -1, 1);
  r.trust = clamp(r.trust + (ans.trust.score! - 2) * 0.1, 0, 1);
  const bond = ans.bond.choice as BondKind;
  if (bond !== "none") r.bonds.push({ kind: bond, t: w.t, weight: ans.bond.probabilities![bond] });
  if (ans.label.confidence! > 0.3) r.label = ans.label.choice as Label;
  for (const b of BELIEFS) r.beliefs[b] = ans[`believes_${b}`].noul;
  r.history = [...r.history, `${clock(w.t)}: ${happened}`].slice(-10);
  return { bond, label: r.label };
}

export function fadeBonds(a: Agent) {
  for (const r of Object.values(a.rel)) {
    for (const b of r.bonds) b.weight *= BOND_FADE[b.kind] ?? 0.85;
    r.bonds = r.bonds.filter((b) => b.weight > 0.05);
  }
}
