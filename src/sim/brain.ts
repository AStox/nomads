// Every Jev call lives here: pick a goal, choose what to try, answer another agent, judge an unknown result, name a thing.
import {
  BONDS, BOND_FADE, LABELS, OPINIONS, clock, dist, level, type Agent, type BondKind, type Label, type Relationship, type World,
} from "./world";
import { TRAITS } from "./traits";
import { PROPS, type Kind, type Props } from "./materials";
import { beliefText } from "./beliefs";
import { jevLog } from "./trace";

const ENDPOINT = "https://api.typesafe.ai/v1/systemone";
// NOMADS_BRAIN=random answers every question with random numbers, for fast offline runs of the physics.
const RANDOM = process.env.NOMADS_BRAIN === "random";

type Answer = { type: string; choice?: string; probabilities?: Record<string, number>; confidence?: number; noul?: number; score?: number };
type Question = { type: "choice" | "noul" | "score"; instructions: unknown; criteria?: unknown };

function randomAnswer(q: Question, bias?: Record<string, number>): Answer {
  if (q.type === "noul") return { type: "noul", noul: Math.random() };
  if (q.type === "score") {
    const levels = (q.criteria as unknown[]).length;
    return { type: "score", score: Math.random() * (levels - 1), confidence: 0.5 };
  }
  const keys = Object.keys(q.criteria as object);
  const raw = keys.map((k) => Math.random() * (bias?.[k] ?? 1));
  const total = raw.reduce((a, b) => a + b, 0) || 1;
  const probabilities = Object.fromEntries(keys.map((k, i) => [k, raw[i] / total]));
  const choice = keys[raw.indexOf(Math.max(...raw))];
  return { type: "choice", choice, probabilities, confidence: 0.3 };
}

async function ask(w: World, purpose: string, agent: string | undefined, state: unknown, questions: Record<string, Question>, bias?: Record<string, number>) {
  const t0 = performance.now();
  if (RANDOM) {
    const answers = Object.fromEntries(Object.entries(questions).map(([k, q]) => [k, randomAnswer(q, k === "goal" ? bias : undefined)]));
    jevLog({ agent, purpose, ms: 0, tokens: 0, state, questions, answers });
    return answers;
  }
  try {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.TYPESAFE_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "jev-latest", state, questions }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`jev ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const body = (await res.json()) as { answers: Record<string, Answer>; usage?: { input_tokens: number } };
    const tokens = body.usage?.input_tokens ?? 0;
    w.jev.calls++;
    w.jev.tokens += tokens;
    jevLog({ agent, purpose, ms: Math.round(performance.now() - t0), tokens, state, questions, answers: body.answers });
    return body.answers;
  } catch (e) {
    jevLog({ agent, purpose, ms: Math.round(performance.now() - t0), tokens: 0, state, questions, error: String(e) });
    throw e;
  }
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

// What a held thing is like, in words Jev can reason with.
export function describeKind(k?: Kind) {
  if (!k) return "";
  const words = Object.entries(k.props).filter(([p, v]) => p !== "toughness" && (v ?? 0) >= 0.45).sort((x, y) => y[1]! - x[1]!).slice(0, 4).map(([p]) => p);
  return words.length ? `${k.name} (${words.join(", ")})` : k.name;
}
export function inventoryText(w: World, a: Agent) {
  const c: Record<string, number> = {};
  for (const s of a.inv) c[s.k] = (c[s.k] ?? 0) + 1;
  return Object.entries(c).map(([k, n]) => `${n} ${describeKind(w.kinds[k])}`).join(", ") || "nothing";
}

export function view(w: World, a: Agent) {
  const near: Record<string, { count: number; nearest: number }> = {};
  for (const t of w.things) {
    const d = dist(a, t);
    if (d > 10 || (t.kind === "bush" && !t.n)) continue;
    let kind = t.kind === "item" ? `${w.kinds[t.item ?? ""]?.name ?? "something"} on the ground` : t.kind === "structure" ? ["pile of stuff", "lean-to", "hut", "cabin"][t.shelter?.tier ?? 0] : t.kind.replaceAll("_", " ");
    if (t.burning) kind = `burning ${kind}`;
    if (t.kind === "fire" && t.contained) kind = "ringed fire";
    const label = t.owner && t.kind !== "fire" && t.kind !== "sapling" ? (t.owner === a.id ? `your ${kind}` : `${w.agents.find((x) => x.id === t.owner)?.name}'s ${kind}`) : kind;
    const e = (near[label] ??= { count: 0, nearest: d });
    e.count++;
    e.nearest = Math.min(e.nearest, d);
  }
  const nearby = Object.fromEntries(Object.entries(near).map(([k, e]) => [k, `${e.count} (nearest ${e.nearest} steps)`]));
  const animals = w.animals.filter((x) => dist(a, x) <= 12).map((x) => `${x.species} ${dist(a, x)} steps away (${x.state})`);
  const people = w.agents
    .filter((b) => b.id !== a.id && (a.rel[b.id] || dist(a, b) <= 8))
    .map((b) => ({
      name: b.name,
      distance: `${dist(a, b)} steps`,
      doing: dist(a, b) <= 12 ? b.status : "out of sight",
      carrying: dist(a, b) <= 6 ? inventoryText(w, b) : undefined,
      ...describeRel(w, a, b),
    }));
  const home = a.home ? w.things.find((t) => t.id === a.home) : null;
  const wx = w.weather;
  return {
    you: a.name,
    bio: a.bio,
    traits: Object.entries(a.traits).map(([t, s]) => `${t} (${s > 0.75 ? "strongly" : s > 0.55 ? "fairly" : "slightly"}): ${TRAITS[t]}`),
    desires: a.desires,
    time: clock(w.t),
    weather: `${wx.season}, ${wx.sky}, ${Math.round(wx.temp)}C${wx.drought ? ", drought" : ""}`,
    needs: Object.fromEntries(Object.entries(a.needs).map(([k, v]) => [k, needWord(v)])),
    sick: a.sickness ? "yes, feeling ill" : undefined,
    skills: Object.fromEntries(Object.entries(a.skills).filter(([, xp]) => xp > 0).map(([s, xp]) => [s, `level ${level(xp)}`])),
    carrying: inventoryText(w, a),
    wearing: a.wearing ? w.kinds[a.wearing.k]?.name : undefined,
    what_they_know_works: Object.values(a.beliefs).sort((x, y) => y.t - x.t).slice(0, 12).map((b) => beliefText(w, b)),
    what_they_have_seen: Object.values(a.facts).slice(-6),
    home: home ? `a ${["pile", "lean-to", "hut", "cabin"][home.shelter?.tier ?? 0]} ${dist(a, home)} steps away` : "no home yet",
    current_goal: a.goal?.type ?? "none",
    nearby,
    animals,
    people,
    recent_memory: a.memory.slice(-8),
  };
}

// In random mode, lean toward whatever need is most urgent so offline runs don't starve instantly.
function needBias(a: Agent, options: Record<string, string>) {
  const b: Record<string, number> = {};
  for (const k of Object.keys(options)) {
    if ((k === "eat" || k === "forage") && a.needs.food < 45) b[k] = 8;
    if (k === "rest" && a.needs.energy < 30) b[k] = 8;
    if ((k === "warm_up" || k === "make_fire" || k === "build_shelter") && a.needs.warmth < 40) b[k] = 6;
    if (k === "tinker") b[k] = 3;
    if (k.startsWith("make:") || k === "build_shelter" || k.startsWith("hunt:")) b[k] = Math.max(b[k] ?? 0, 2);
  }
  return b;
}

export async function decide(w: World, a: Agent, options: Record<string, string>, towards: string[], against: string[]) {
  const q: Record<string, Question> = {
    goal: { type: "choice", instructions: `Given who ${a.name} is, what they need, what they know how to do, and who is around, what will ${a.name} most likely do next?`, criteria: options },
  };
  const names = (ids: string[]) => Object.fromEntries(ids.map((id) => [w.agents.find((b) => b.id === id)!.name, null]));
  if (towards.length) q.towards = { type: "choice", instructions: `If ${a.name} sought someone out to be friendly, ask for something, or work together, who would it be?`, criteria: names(towards) };
  if (against.length) q.against = { type: "choice", instructions: `If ${a.name} acted against someone or wanted to keep away from them, who would it be?`, criteria: names(against) };
  const ans = await ask(w, "decide", a.id, view(w, a), q, needBias(a, options));
  const byName = (p?: Record<string, number>) =>
    p && Object.fromEntries(Object.entries(p).map(([n, v]) => [w.agents.find((b) => b.name === n)!.id, v]));
  return { goal: ans.goal.probabilities!, towards: byName(ans.towards?.probabilities), against: byName(ans.against?.probabilities) };
}

export async function chooseTinker(w: World, a: Agent, options: string[]) {
  const failed = Object.entries(a.tried).sort((x, y) => y[1] - x[1]).slice(0, 10).map(([k]) => k);
  const ans = await ask(w, "tinker", a.id, { ...view(w, a), already_tried_with_no_luck: failed }, {
    attempt: {
      type: "choice",
      instructions: `${a.name} is experimenting with what they're holding and what's around them, to find out what can be done with it. Which of these would ${a.name} most likely try?`,
      criteria: Object.fromEntries(options.map((o) => [o, null])),
    },
  });
  return sample(ans.attempt.probabilities!);
}

export async function respond(w: World, me: Agent, them: Agent, situation: string, options: Record<string, string>) {
  const ans = await ask(w, "respond", me.id, { ...view(w, me), what_is_happening: situation }, {
    reply: { type: "choice", instructions: `${situation} How does ${me.name} respond?`, criteria: options },
  });
  return sample(ans.reply.probabilities!);
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

// After something happens between two people, `me` decides what it meant for how they see `them`.
export async function reflect(w: World, me: Agent, them: Agent, happened: string) {
  const r = (me.rel[them.id] ??= newRel(w.t));
  const shift = ["much worse", "a bit worse", "no change", "a bit better", "much better"];
  const q: Record<string, Question> = {
    bond: { type: "choice", instructions: `What lasting mark, if any, does this leave on how ${me.name} sees ${them.name}?`, criteria: BONDS },
    feeling: { type: "score", instructions: `How does this change how much ${me.name} likes ${them.name}?`, criteria: shift },
    trust: { type: "score", instructions: `How does this change how much ${me.name} trusts ${them.name}?`, criteria: shift },
    label: { type: "choice", instructions: `After this, what best describes how ${me.name} sees their relationship with ${them.name}?`, criteria: LABELS },
  };
  for (const b of OPINIONS) q[`believes_${b}`] = { type: "noul", instructions: `From everything ${me.name} has seen and heard, is ${them.name} ${b}?` };
  const ans = await ask(w, "reflect", me.id, {
    who: { name: me.name, bio: me.bio, traits: Object.keys(me.traits) },
    them: { name: them.name, ...describeRel(w, me, them) },
    what_just_happened: happened,
  }, q);
  r.affinity = clamp(r.affinity + (ans.feeling.score! - 2) * 0.12, -1, 1);
  r.trust = clamp(r.trust + (ans.trust.score! - 2) * 0.1, 0, 1);
  const bond = ans.bond.choice as BondKind;
  if (bond !== "none") r.bonds.push({ kind: bond, t: w.t, weight: ans.bond.probabilities![bond] });
  if (ans.label.confidence! > 0.3) r.label = ans.label.choice as Label;
  for (const b of OPINIONS) r.beliefs[b] = ans[`believes_${b}`].noul;
  r.history = [...r.history, `${clock(w.t)}: ${happened}`].slice(-10);
  return { bond, label: r.label };
}

export function fadeBonds(a: Agent) {
  for (const r of Object.values(a.rel)) {
    for (const b of r.bonds) b.weight *= BOND_FADE[b.kind] ?? 0.85;
    r.bonds = r.bonds.filter((b) => b.weight > 0.05);
  }
}

// The rules don't cover this combination. Ask what would realistically come of it; the answer becomes law.
const LEVELS = ["not at all", "a little", "somewhat", "quite", "very"];
export async function rule(w: World, a: Agent, attempt: string, parts: Kind[], templateName: string) {
  const relevant = PROPS.filter((prop) => prop !== "toughness");
  const q: Record<string, Question> = {
    useful: { type: "noul", instructions: `Realistically, would a person doing this end up with a new object that holds together and could be used for something?`, criteria: { true: "A usable new object comes out of it", false: "It falls apart, does nothing, or just wastes the materials" } },
  };
  for (const prop of relevant) q[prop] = { type: "score", instructions: `If it did make something, how ${prop} would the result be?`, criteria: LEVELS };
  const ans = await ask(w, "rule", a.id, {
    attempt,
    materials: parts.map((k) => ({ name: k.name, properties: Object.fromEntries(Object.entries(k.props).filter(([, v]) => (v ?? 0) >= 0.1)) })),
  }, q);
  w.jev.rulings++;
  const props: Props = {};
  for (const prop of relevant) {
    const v = ans[prop].score! / (LEVELS.length - 1);
    if (v >= 0.15) props[prop] = Math.round(v * 100) / 100;
  }
  props.toughness = Math.min(...parts.map((k) => k.props.toughness ?? 0.2));
  // Conservation: a mix is only food if every part is food, and can't be more medicinal or less toxic than its parts.
  const most = (prop: keyof Props) => Math.max(...parts.map((k) => k.props[prop] ?? 0));
  const least = (prop: keyof Props) => Math.min(...parts.map((k) => k.props[prop] ?? 0));
  props.edible = Math.min(props.edible ?? 0, least("edible") * 1.3);
  props.medicinal = Math.min(props.medicinal ?? 0, most("medicinal"));
  props.toxic = Math.max(props.toxic ?? 0, most("toxic") * 0.5);
  props.seed = Math.min(props.seed ?? 0, most("seed") * 0.5);
  props.binding = Math.min(props.binding ?? 0, Math.max(most("binding"), most("plastic") * 0.6, most("fibrous") * 0.5));
  props.sharp = Math.min(props.sharp ?? 0, most("sharp") + 0.2);
  return { useful: ans.useful.noul! >= 0.5, name: templateName, props };
}

// When something has been made a few times, people settle on a word for it.
export async function nameIt(w: World, a: Agent, k: Kind, candidates: string[]) {
  const ans = await ask(w, "name", a.id, { thing: { name: k.name, properties: k.props, made_from: (k.parts ?? []).map((id) => w.kinds[id]?.name ?? id) }, maker: a.name }, {
    name: { type: "choice", instructions: `People keep making this thing. What would they most naturally come to call it?`, criteria: Object.fromEntries(candidates.map((c) => [c, null])) },
  });
  return ans.name.choice!;
}
