// Every Jev call lives here: pick a goal, choose what to try, answer another agent, judge an unknown result, name a thing, answer for a camp.
import {
  BONDS, BOND_FADE, DAY, LABELS, OPINIONS, RESPONSES, YEAR_DAYS, ageOf, clock, dayOfYear, dist, level, stageOf,
  type Agent, type BondKind, type Label, type Relationship, type Response, type World,
} from "./world";
import { TRAITS } from "./traits";
import { PROPS, THING_MATERIAL, type Kind, type Props } from "./materials";
import { beliefText } from "./beliefs";
import { campTag, campView } from "./groups";
import { jevLog } from "./trace";
import LEXICON from "./lexicon.json";
import PLACES from "./places.json";

const ENDPOINT = "https://api.typesafe.ai/v1/systemone";
// NOMADS_BRAIN=random answers every question with random numbers, for fast offline runs of the physics (and for tests).

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
  if (process.env.NOMADS_BRAIN === "random") {
    const answers = Object.fromEntries(Object.entries(questions).map(([k, q]) => [k, randomAnswer(q, bias)]));
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
export function sample(probs: Record<string, number>, sharpness = 0.8): string {
  const keys = Object.keys(probs);
  const weights = keys.map((k) => Math.pow(probs[k], sharpness));
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

export function describeRel(w: World, a: Agent, b: Agent) {
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
  // Metal hidden in a stone isn't something anyone can see until it's smelted out.
  const words = Object.entries(k.props).filter(([p, v]) => p !== "toughness" && (p !== "metal" || (v ?? 0) >= 0.9) && (v ?? 0) >= 0.45).sort((x, y) => y[1]! - x[1]!).slice(0, 4).map(([p]) => p);
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
    if (t.kind === "fire") kind = t.covered ? "fire heaped over with stone" : t.contained && (t.charcoal ?? 0) > 0 ? "ringed fire glowing white-hot with charcoal" : t.contained ? "ringed fire" : "fire";
    if ((t.resin ?? 0) > 0) kind = `${kind} beaded with resin`;
    if (t.kind === "boulder" && t.inside?.flint) kind = "boulder studded with dark nodules";
    if (t.shared) kind = `${kind} kept as the camp's store`;
    const label = t.owner && t.kind !== "fire" && t.kind !== "sapling" ? (t.owner === a.id ? `your ${kind}` : `${w.agents.find((x) => x.id === t.owner)?.name}'s ${kind}`) : kind;
    const e = (near[label] ??= { count: 0, nearest: d });
    e.count++;
    e.nearest = Math.min(e.nearest, d);
  }
  const nearby = Object.fromEntries(Object.entries(near).map(([k, e]) => [k, `${e.count} (nearest ${e.nearest} steps)`]));
  const animals = w.animals.filter((x) => dist(a, x) <= 12).map((x) => `${x.species} ${dist(a, x)} steps away (${x.state})`);
  const home = a.home ? w.things.find((t) => t.id === a.home) : null;
  const people = w.agents
    .filter((b) => b.id !== a.id && (a.rel[b.id] || dist(a, b) <= 8))
    .map((b) => ({
      name: b.name,
      distance: `${dist(a, b)} steps`,
      doing: dist(a, b) <= 12 ? b.status : "out of sight",
      carrying: dist(a, b) <= 6 ? inventoryText(w, b) : undefined,
      camp: campTag(w, a, b),
      home: (() => { const h = b.home && w.things.find((t) => t.id === b.home); return h ? `${dist(a, h)} steps from you${home ? `, ${dist(home, h)} steps from your home` : ""}` : undefined; })(),
      ...describeRel(w, a, b),
    }));
  const wx = w.weather;
  const stored: Record<string, number> = {};
  for (const s of home?.store ?? []) stored[w.kinds[s.k]?.name ?? s.k] = (stored[w.kinds[s.k]?.name ?? s.k] ?? 0) + 1;
  const toWinter = (30 - dayOfYear(w.t) + YEAR_DAYS) % YEAR_DAYS;
  const name = (id: string) => w.people[id]?.name ?? id;
  return {
    you: a.name,
    bio: a.bio,
    traits: Object.entries(a.traits).map(([t, s]) => `${t} (${s > 0.75 ? "strongly" : s > 0.55 ? "fairly" : "slightly"}): ${TRAITS[t]}`),
    desires: a.desires,
    age: `${Math.floor(ageOf(w, a))} years old (${stageOf(w, a)})`,
    family: [
      ...a.parents.map((id) => `parent: ${name(id)}${w.people[id]?.alive === false ? " (dead)" : ""}`),
      ...a.children.map((id) => `child: ${name(id)}${w.people[id]?.alive === false ? " (dead)" : ""}`),
    ],
    expecting_a_child: a.pregnant ? `yes, in ${Math.ceil((a.pregnant.due - w.t) / DAY)} days` : undefined,
    time: clock(w.t),
    weather: `${wx.season}, ${wx.sky}, ${Math.round(wx.temp)}C${wx.drought ? ", drought" : ""}${w.ice.length ? ", the water is frozen" : ""}`,
    days_until_winter: wx.season === "winter" ? "it is winter now" : toWinter,
    kept_at_home: Object.keys(stored).length ? stored : undefined,
    needs: Object.fromEntries(Object.entries(a.needs).map(([k, v]) => [k, needWord(v)])),
    sick: a.sickness ? "yes, feeling ill" : undefined,
    skills: Object.fromEntries(Object.entries(a.skills).filter(([, xp]) => xp > 0).map(([s, xp]) => [s, `level ${level(xp)}`])),
    carrying: inventoryText(w, a),
    wearing: a.wearing ? w.kinds[a.wearing.k]?.name : undefined,
    what_they_know_works: Object.values(a.beliefs).sort((x, y) => y.t - x.t).slice(0, 12).map((b) => beliefText(w, b)),
    what_they_have_seen: Object.values(a.facts).slice(-6),
    home: home ? `a ${["pile", "lean-to", "hut", "cabin"][home.shelter?.tier ?? 0]} ${dist(a, home)} steps away` : "no home yet",
    current_goal: a.goal?.type ?? "none",
    ...campView(w, a),
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
  // Resolve names now: someone can die while Jev is thinking.
  const idOf = new Map([...towards, ...against].map((id) => [w.people[id]?.name ?? id, id]));
  const names = (ids: string[]) => Object.fromEntries(ids.map((id) => [w.people[id]?.name ?? id, null]));
  if (towards.length) q.towards = { type: "choice", instructions: `If ${a.name} sought someone out to be friendly, ask for something, or work together, who would it be?`, criteria: names(towards) };
  if (against.length) q.against = { type: "choice", instructions: `If ${a.name} acted against someone or wanted to keep away from them, who would it be?`, criteria: names(against) };
  const ans = await ask(w, "decide", a.id, view(w, a), q, needBias(a, options));
  const byName = (p?: Record<string, number>) => p && Object.fromEntries(Object.entries(p).filter(([n]) => idOf.has(n)).map(([n, v]) => [idOf.get(n)!, v]));
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
  // Over a long list of options, the long tail would win too often; lean harder on Jev's favorites.
  return sample(ans.attempt.probabilities!, 1.6);
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
  // Slights sting a little less than kindness warms, so one bad day doesn't sour everything.
  const delta = ans.feeling.score! - 2;
  r.affinity = clamp(r.affinity + delta * (delta < 0 ? 0.08 : 0.12), -1, 1);
  r.trust = clamp(r.trust + (ans.trust.score! - 2) * 0.1, 0, 1);
  const bond = ans.bond.choice as BondKind;
  if (bond !== "none") r.bonds.push({ kind: bond, t: w.t, weight: ans.bond.probabilities![bond] });
  // A label has to fit how they actually feel: one brush-off doesn't make an enemy.
  const fits: Partial<Record<Label, boolean>> = {
    enemy: r.affinity < -0.5, rival: r.affinity < 0.1, friend: r.affinity > 0.3, confidant: r.affinity > 0.6 && r.trust > 0.6,
    sweetheart: r.affinity > 0.45, stranger: r.history.length < 3, kin: r.label === "kin",
  };
  const pick = ans.label.choice as Label;
  if (r.label !== "kin" && ans.label.confidence! > 0.3 && (fits[pick] ?? true)) r.label = pick;
  for (const b of OPINIONS) r.beliefs[b] = ans[`believes_${b}`].noul;
  r.history = [...r.history, `${clock(w.t)}: ${happened}`].slice(-10);
  return { bond, label: r.label };
}

// Once a day: grudges and warmth both cool, faster for the forgiving; time spent near someone breeds familiarity.
export function fadeBonds(a: Agent) {
  const keep = 0.96 - (a.traits.forgiving ?? 0) * 0.04 + (a.traits.vengeful ?? 0) * 0.03;
  for (const [id, r] of Object.entries(a.rel)) {
    for (const b of r.bonds) b.weight *= BOND_FADE[b.kind] ?? 0.85;
    r.bonds = r.bonds.filter((b) => b.weight > 0.05);
    if (r.affinity < 0) r.affinity *= keep;
    // A label that no longer matches how they feel wears off.
    if ((r.label === "enemy" && r.affinity > -0.3) || (["friend", "confidant", "sweetheart"].includes(r.label) && r.affinity < 0.15)) r.label = "acquaintance";
    else if (r.label !== "kin") r.affinity *= 0.99;
    r.trust += (0.3 - r.trust) * 0.03;
    const together = a.near[id] ?? 0;
    if (together > 40) r.affinity = Math.min(1, r.affinity + Math.min(0.06, together / 3000));
  }
  a.near = {};
}

// The rules don't cover this combination. Ask what would realistically come of it; the answer becomes law.
const LEVELS = ["not at all", "a little", "somewhat", "quite", "very"];
export async function rule(w: World, a: Agent, attempt: string, parts: Kind[], templateName: string) {
  // Metal can't be made by mixing things; it only comes out of ore in a hot enough fire.
  const relevant = PROPS.filter((prop) => prop !== "toughness" && prop !== "metal");
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
  // A mix that can't do anything its parts couldn't already do is just a lump.
  const novel = relevant.some((prop) => (props[prop] ?? 0) > Math.max(...parts.map((k) => k.props[prop] ?? 0)) + 0.15);
  return { useful: ans.useful.noul! >= 0.6 && novel, name: templateName, props };
}

// When something has been made a few times, people settle on a word for it: first what kind of thing it is, then which word.
type Lexicon = Record<string, { description: string; words: { w: string; gloss: string }[] }>;
const LEX = LEXICON as Lexicon;
export async function nameIt(w: World, a: Agent, k: Kind, uses: string[]): Promise<string | null> {
  const state = {
    what_people_have_done_with_it: uses.length ? uses : ["nothing yet beyond making it"],
    thing: { called_for_now: k.name, is: describeKind(k).replace(/^[^(]*\(?/, "").replace(/\)$/, ""), made_from: (k.parts ?? []).map((id) => w.kinds[id]?.name ?? id) },
  };
  return pickWord(w, a, "name", LEX, state,
    { instructions: "People keep making and using this thing. What kind of thing would they think of it as?", none: "Not really a kind of thing anyone would have a word for" },
    "People name tools after what they do with them. Given mainly what_people_have_done_with_it, which of these words would they most naturally come to call it?", RESERVED);
}
// A camp's lasting name comes from the land around it and what happened there.
export async function nameCamp(w: World, a: Agent, state: object): Promise<string | null> {
  return pickWord(w, a, "name_camp", PLACES as Lexicon, state,
    { instructions: "People have lived together here for a season. What sort of place would they name it after?", none: "Nothing about the place stands out enough to name it for" },
    "Given the land around it and what happened there, which of these words would the people who live here most naturally come to call their place?");
}
// Words that already mean something in the world: a carried thing called "shelter" would be read as a building.
const RESERVED = new Set(["shelter", "pile", "lean-to", "hut", "cabin", "home", "fire", "campfire", "hearth", "kiln", "forge", "pit", "trap", "well", "camp", "grave", ...Object.keys(THING_MATERIAL).map((k) => k.replaceAll("_", " "))]);
async function pickWord(w: World, a: Agent, purpose: string, lex: Lexicon, state: object, cat: { instructions: string; none: string }, instructions: string, skip = new Set<string>()): Promise<string | null> {
  const kinds = Object.fromEntries(Object.entries(lex).map(([id, c]) => [id, c.description]));
  const first = await ask(w, purpose, a.id, state, { category: { type: "choice", instructions: cat.instructions, criteria: { ...kinds, none: cat.none } } });
  // Keep every kind Jev thinks is plausible, not just the top one, and let the words compete.
  const cats = Object.entries(first.category.probabilities!).filter(([c, pr]) => c !== "none" && lex[c] && pr >= 0.15).sort((x, y) => y[1] - x[1]).slice(0, 3).map(([c]) => c);
  if (!cats.length) return null;
  // Every word in those kinds gets a look: split into Jev-sized lists, take each list's favorites, then pick among them.
  const all = cats.flatMap((c) => lex[c].words).filter((x) => !skip.has(x.w));
  const chunks: typeof all[] = [];
  for (let i = 0; i < all.length; i += 240) chunks.push(all.slice(i, i + 240));
  const ctx = { ...state, kind_of_thing: cats.map((c) => lex[c].description) };
  const heats = await ask(w, purpose, a.id, ctx, Object.fromEntries(chunks.map((ch, i) => [`list${i}`, {
    type: "choice" as const, instructions, criteria: Object.fromEntries(ch.map((x) => [x.w, x.gloss])),
  }])));
  const finalists = Object.values(heats).flatMap((ans) => Object.entries(ans.probabilities!).sort((x, y) => y[1] - x[1]).slice(0, 3).map(([word]) => word));
  const gloss = new Map(all.map((x) => [x.w, x.gloss]));
  const second = await ask(w, purpose, a.id, ctx, {
    word: { type: "choice", instructions, criteria: { ...Object.fromEntries(finalists.map((x) => [x, gloss.get(x) ?? null])), "none of these": "No word here fits it well" } },
  });
  const word = second.word.choice!;
  return word === "none of these" ? null : word;
}

// Offline runs lean toward the milder answers, the way most camps do.
const MILD: Partial<Record<Response, number>> = { let_go: 3, scold: 2, repay: 1.5, shun: 1, drive_out: 0.4 };
// Someone decides how the camp answers what another person did. The same call asks whether the doer would make amends if told to.
export async function judge(w: World, me: Agent, doer: string, state: object) {
  const ans = await ask(w, "judge", me.id, state, {
    response: {
      type: "choice", criteria: RESPONSES,
      instructions: `${me.name} decides how the camp answers what ${doer} did. Given who ${me.name} is, what happened, and how this camp has handled cases like it before, what does ${me.name} decide?`,
    },
    comply: { type: "noul", instructions: `If the camp told ${doer} to give it back or make up for it, would ${doer} actually do it?` },
  }, MILD);
  const odds = ans.response.probabilities!;
  return { response: sample(odds, 1) as Response, odds, comply: ans.comply.noul ?? 0.5 };
}
