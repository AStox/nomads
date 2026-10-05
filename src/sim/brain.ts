// Every Jev call lives here: pick a goal, choose what to try, answer another agent, judge an unknown result, name a thing, answer for a camp.
import {
  BONDS, BOND_FADE, DAY, LABELS, OPINIONS, RESPONSES, YEAR_DAYS, ageOf, clock, dayOfYear, level, meters, stageOf,
  type Agent, type BondKind, type Label, type Relationship, type Response, type World,
} from "./world";
import { around, thingById } from "./space";
import { fireHours, shelterName } from "./physics";
import { TRAITS } from "./traits";
import { DARK, canSee, lightOn, lightWords } from "./light";
import { airOn, airWords } from "./air";
import { ripening } from "./cues";
import { PROPS, THING_MATERIAL, type Kind, type Props } from "./materials";
import { apart, beliefText, testOf } from "./beliefs";
import { campTag, campView } from "./groups";
import { jevLog } from "./trace";
import LEXICON from "./lexicon.json";
import PLACES from "./places.json";

const ENDPOINT = "https://api.typesafe.ai/v1/systemone";
// NOMADS_BRAIN=random answers every question with random numbers, for fast offline runs of the physics (and for tests).
// Where the answers come from: the random brain; Jev itself, with TYPESAFE_API_KEY (the server); or a relay that holds
// the key for a page that must not see it (scripts/play/serve.ts /jev), reached with the relay's token.
export type Brain = { kind: "random" } | { kind: "jev" } | { kind: "relay"; url: string; token: string };
let brain: Brain = process.env.NOMADS_BRAIN === "random" ? { kind: "random" } : { kind: "jev" };
export const useBrain = (b: Brain) => { brain = b; };
export const brainKind = () => brain.kind;
// Jev calls not yet answered: a headless run can wait for them each tick, so the world moves as if Jev answered at once.
let inflight = 0;
export const asking = () => inflight;

type Answer = { type: string; choice?: string; probabilities?: Record<string, number>; confidence?: number; noul?: number; score?: number };
type Question = { type: "choice" | "noul" | "score"; instructions: unknown; criteria?: unknown };

// How an offline answer leans, per question: weights for a choice's options; for a yes or no question its likely answer
// (p) or a cap (cap); for a score the level it centres on (at).
export type Lean = Record<string, number>;
function randomAnswer(q: Question, lean?: Lean): Answer {
  if (q.type === "noul") return { type: "noul", noul: lean?.p !== undefined ? clamp(lean.p + (Math.random() - 0.5) * 0.4, 0, 1) : Math.random() * (lean?.cap ?? 1) };
  if (q.type === "score") {
    const top = (q.criteria as unknown[]).length - 1;
    return { type: "score", score: lean?.at !== undefined ? clamp(lean.at + (Math.random() - 0.5) * 1.5, 0, top) : Math.random() * top, confidence: 0.5 };
  }
  const keys = Object.keys(q.criteria as object);
  const raw = keys.map((k) => Math.random() * (lean?.[k] ?? 1));
  const total = raw.reduce((a, b) => a + b, 0) || 1;
  const probabilities = Object.fromEntries(keys.map((k, i) => [k, raw[i] / total]));
  const choice = keys[raw.indexOf(Math.max(...raw))];
  // as sure of its pick as Jev is of a middling one, so choices that need some conviction (a new label for a
  // relationship) still happen offline
  return { type: "choice", choice, probabilities, confidence: 0.5 };
}

// leans: how each question would lean offline, by question id; Jev never sees them and judges for itself.
async function ask(w: World, purpose: string, agent: string | undefined, state: unknown, questions: Record<string, Question>, leans: Record<string, Lean> = {}) {
  const t0 = performance.now();
  if (brain.kind === "random") {
    const answers = Object.fromEntries(Object.entries(questions).map(([k, q]) => [k, randomAnswer(q, leans[k])]));
    jevLog({ agent, purpose, ms: 0, tokens: 0, state, questions, answers });
    return answers;
  }
  inflight++;
  try {
    const relay = brain.kind === "relay" ? brain : null;
    const res = await fetch(relay ? relay.url : ENDPOINT, {
      method: "POST",
      headers: relay ? { "X-Nomads-Token": relay.token, "Content-Type": "application/json" } : { Authorization: `Bearer ${process.env.TYPESAFE_API_KEY}`, "Content-Type": "application/json" },
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
  } finally {
    inflight--;
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
  const m = (b: { px: number; py: number }) => Math.round(meters(a, b));
  around(w, a.px, a.py, 60, null, (t, d) => {
    if (t.kind === "pebble" || t.kind === "grass" || (t.kind === "bush" && t.species === "berry" && !t.n) || !canSee(w, a, t, 60)) return;
    let kind = t.kind === "item" ? `${w.kinds[t.item ?? ""]?.name ?? "something"} on the ground` : t.kind === "structure" ? (shelterName(w, t) === "fire ring" ? "ring of stones round a fire" : ["pile of stuff", "lean-to", "hut", "cabin"][t.shelter?.tier ?? 0]) : t.kind === "bush" ? `${t.species ?? "berry"} bush` : t.kind.replaceAll("_", " ");
    if (t.burning) kind = `burning ${kind}`;
    if (t.kind === "fire") kind = t.covered ? "fire heaped over with stone" : t.contained && (t.charcoal ?? 0) > 0 ? "ringed fire glowing white-hot with charcoal" : t.contained ? "ringed fire" : "fire";
    // how long it will last, as anyone sitting by it can judge from what's burning
    if (t.kind === "fire") { const h = fireHours(t); kind = `${kind}, ${h < 1 ? "almost out" : `wood enough for about ${Math.round(h)} hours`}`; }
    if ((t.resin ?? 0) > 0) kind = `${kind} beaded with resin`;
    if (t.kind === "boulder" && t.inside?.flint) kind = "boulder studded with dark nodules";
    if (t.shared) kind = `${kind} kept as the camp's store`;
    const label = t.owner && t.kind !== "fire" && t.kind !== "sapling" ? (t.owner === a.id ? `your ${kind}` : `${w.agents.find((x) => x.id === t.owner)?.name}'s ${kind}`) : kind;
    const e = (near[label] ??= { count: 0, nearest: Math.round(d) });
    e.count++;
    e.nearest = Math.min(e.nearest, Math.round(d));
  });
  const nearby = Object.fromEntries(Object.entries(near).map(([k, e]) => [k, `${e.count} (nearest ${e.nearest} m)`]));
  const animals = w.animals.filter((x) => canSee(w, a, x, 300)).map((x) => `${x.species} ${m(x)} m away (${x.state})`);
  const home = thingById(w, a.home);
  const people = w.agents
    .filter((b) => b.id !== a.id && (a.rel[b.id] || canSee(w, a, b, 300)))
    .map((b) => ({
      name: b.name,
      distance: `${m(b)} m`,
      doing: canSee(w, a, b, 300) ? b.status : "out of sight",
      carrying: canSee(w, a, b, 30) ? inventoryText(w, b) : undefined,
      camp: campTag(w, a, b),
      home: (() => { const h = thingById(w, b.home); return h ? `${m(h)} m from you${home ? `, ${Math.round(meters(home, h))} m from your home` : ""}` : undefined; })(),
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
    light: lightWords(lightOn(w, a)),
    weather: `${wx.season}, ${wx.sky}, ${airWords(airOn(w, a))}${wx.drought ? ", drought" : ""}${w.ice.length ? ", the water is frozen" : ""}`,
    days_until_winter: wx.season === "winter" ? "it is winter now" : toWinter,
    kept_at_home: Object.keys(stored).length ? stored : undefined,
    needs: Object.fromEntries(Object.entries(a.needs).map(([k, v]) => [k, needWord(v)])),
    sick: a.sickness ? "yes, feeling ill" : undefined,
    skills: Object.fromEntries(Object.entries(a.skills).filter(([, xp]) => xp > 0).map(([s, xp]) => [s, `level ${level(xp)}`])),
    carrying: inventoryText(w, a),
    wearing: a.wearing ? w.kinds[a.wearing.k]?.name : undefined,
    what_they_know_works: Object.values(a.beliefs).sort((x, y) => y.t - x.t).slice(0, 12).map((b) => beliefText(w, b)),
    // what they've done that hasn't shown what comes of it yet: a seed in the ground, a young plant watered
    waiting_to_see: a.waiting?.map((e) => `${a.beliefs[e.key]?.fields.verb === "pour" ? "watered a young plant" : `pushed ${w.kinds[a.beliefs[e.key]?.fields.inputs[0] ?? ""]?.name ?? "something"} into the ground`} ${Math.max(1, Math.round((w.t - e.t) / DAY))} days ago`),
    what_they_have_seen: Object.values(a.facts).slice(-6),
    home: home ? `a ${["pile", "lean-to", "hut", "cabin"][home.shelter?.tier ?? 0]} ${m(home)} m away` : "no home yet",
    current_goal: a.goal?.type ?? "none",
    ...campView(w, a),
    nearby,
    animals,
    people,
    recent_memory: a.memory.slice(-8),
  };
}

// In random mode, lean toward whatever need is most urgent so offline runs don't starve instantly.
function needBias(w: World, a: Agent, options: Record<string, string>) {
  const b: Record<string, number> = {};
  for (const k of Object.keys(options)) {
    if ((k === "eat" || k === "forage") && a.needs.food < 45) b[k] = 8;
    if (k === "rest" && a.needs.energy < 30) b[k] = 8;
    if ((k === "rest" || k === "warm_up") && lightOn(w, a).bright < DARK) b[k] = Math.max(b[k] ?? 0, 4);
    // A fire for the night: light and warmth, and the wolves keep off.
    if (k === "make_fire" && (lightOn(w, a).bright < DARK || a.needs.warmth < 60)) b[k] = 4;
    if (k === "tend_fire") b[k] = lightOn(w, a).bright < DARK || a.needs.warmth < 60 ? 5 : 2;
    // the colder, the more nothing else matters
    if ((k === "warm_up" || k === "make_fire" || k === "build_shelter") && a.needs.warmth < 40) b[k] = 6 + (40 - a.needs.warmth) / 2;
    // Cold with no fire or roof they know how to make, or a roof that isn't enough: try for one, or keep close to
    // someone who has one.
    if ((k === "experiment:fire" || k === "experiment:shelter" || k === "experiment:home" || k === "share_fire" || k === "stay_close") && a.needs.warmth < 40) b[k] = 4 + (40 - a.needs.warmth) / 4;
    if (k === "tinker") b[k] = 3;
    // nothing they've tried works, and someone is near: ask
    if (k === "ask_help") b[k] = 6;
    if (k === "move_in") b[k] = 2;
    if (k === "experiment:fireside") b[k] = 3;
    // a wilting seedling of theirs, or a fire to keep through the night that they've seen burn down for want of wood
    if (k === "tend_plants" || k === "lay_by_wood") b[k] = 3;
    // a theory they could put to the test here: the less it rests on (the tries in the condition, by how much worse it
    // has done there, like for like), the likelier, and likelier for the curious, the doubting and the clever
    if (k.startsWith("test:")) {
      const [c, key] = testOf(k), x = a.beliefs[key], d = x && apart(x, c);
      const rests = d ? d.tries * Math.max(0, d.diff) : 0;
      b[k] = (3 * (1 + (a.traits.curious ?? 0) + (a.traits.skeptical ?? 0) + (a.traits.clever ?? 0))) / (1 + 2 * rests);
    }
    if (k.startsWith("make:") || k === "build_shelter" || k.startsWith("hunt:")) b[k] = Math.max(b[k] ?? 0, 2);
    // as the days draw in and things ripen, lay food by
    if (k === "stock_up" && ripening(w.t)) b[k] = 3;
  }
  return b;
}

// Offline, people act on the character and the ties Jev would weigh: the traits that pull toward each social act and,
// for acts against someone, a grudge to act on. Nobody turns on people they like for no reason.
const PULL: Partial<Record<string, string[]>> = {
  avoid: ["loner", "shy", "anxious", "suspicious", "cowardly"],
  steal: ["greedy", "deceitful", "ruthless"], take: ["greedy", "domineering", "ruthless"], raid: ["greedy", "ruthless", "vengeful"],
  insult: ["abrasive", "hot-tempered", "cruel", "arrogant", "jealous"], attack: ["hot-tempered", "cruel", "vengeful", "ruthless"],
  talk: ["gregarious", "cheerful", "charismatic", "gossip", "flirtatious"], gossip: ["gossip", "jealous"],
  give: ["generous", "selfless"], share_meal: ["generous", "gregarious"], share_fire: ["generous", "gregarious", "protective"],
  help: ["selfless", "loyal", "protective", "hardworking"], teach: ["patient", "generous", "wise"], trade: ["thrifty", "practical", "greedy"],
};
const AGAINST = ["avoid", "steal", "take", "raid", "insult", "attack"];
// What someone holds against another: how much they dislike them, and the wrongs they remember, the less the fonder
// they are of them (a brush-off counts for little).
const WRONGS: Partial<Record<BondKind, number>> = { stole_from_me: 1, lied_to_me: 1, humiliated_me: 1, destroyed_my_home: 1, rival: 0.7, refused_me: 0.25 };
export function grudge(a: Agent, id: string) {
  const r = a.rel[id];
  if (!r) return 0;
  return Math.max(0, -r.affinity) + (1 - Math.max(0, r.affinity)) * r.bonds.reduce((t, b) => t + b.weight * (WRONGS[b.kind] ?? 0), 0);
}
const fondness = (a: Agent, id: string) => { const r = a.rel[id]; return r ? Math.max(0, r.affinity) + (r.label === "kin" ? 0.5 : 0) : 0; };

export async function decide(w: World, a: Agent, options: Record<string, string>, towards: string[], against: string[]) {
  const q: Record<string, Question> = {
    goal: { type: "choice", instructions: `Given who ${a.name} is, what they need, what they know how to do, and who is around, what will ${a.name} most likely do next?`, criteria: options },
  };
  // Resolve names now: someone can die while Jev is thinking.
  const idOf = new Map([...towards, ...against].map((id) => [w.people[id]?.name ?? id, id]));
  const names = (ids: string[]) => Object.fromEntries(ids.map((id) => [w.people[id]?.name ?? id, null]));
  if (towards.length) q.towards = { type: "choice", instructions: `If ${a.name} sought someone out to be friendly, ask for something, or work together, who would it be?`, criteria: names(towards) };
  if (against.length) q.against = { type: "choice", instructions: `If ${a.name} acted against someone or wanted to keep away from them, who would it be?`, criteria: names(against) };
  const goal = needBias(w, a, options), worst = Math.max(0, ...against.map((id) => grudge(a, id)));
  for (const k of Object.keys(options)) {
    const pull = PULL[k];
    // a passing slight is shrugged off; it takes a real grudge to act on
    if (pull) goal[k] = (goal[k] ?? 1) * (1 + pull.reduce((t, x) => t + (a.traits[x] ?? 0), 0)) * (AGAINST.includes(k) ? 0.1 + Math.max(0, worst - 0.25) : 1);
  }
  const by = (ids: string[], f: (id: string) => number) => Object.fromEntries(ids.map((id) => [w.people[id]?.name ?? id, f(id)]));
  const ans = await ask(w, "decide", a.id, view(w, a), q, { goal, towards: by(towards, (id) => 0.5 + 2 * fondness(a, id)), against: by(against, (id) => 0.1 + 3 * grudge(a, id)) });
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

// Something that has worked for them before just didn't. What do they make of it: something about the conditions
// they were in (present: the ones they could see, each in words), or just bad luck? Offline the guess leans toward the
// condition it has gone worst in (lean).
export async function theorize(w: World, a: Agent, what: string, happened: string, present: Record<string, string>, lean: Lean) {
  const ans = await ask(w, "theory", a.id, { ...view(w, a), tried: what, what_happened: happened }, {
    why: {
      type: "choice",
      instructions: `${a.name} has done this before and it worked: ${what} This time it didn't: ${happened} What does ${a.name} make of it?`,
      criteria: { ...present, luck: "Just bad luck; it will work next time", unsure: "No idea what was different" },
    },
  }, { why: { luck: 1.5, unsure: 1, ...lean } });
  const pick = ans.why.choice!;
  return pick in present && (ans.why.confidence ?? 0) >= 0.3 ? pick : null;
}

// Offline, a reply leans the way the one answering is inclined: warmly toward those they like and as their nature
// runs, coldly toward those they hold something against.
const WARM = ["welcome", "accept", "join", "give", "believe", "let_it_go", "shrug", "share_fire", "take_in", "show", "welcome_in", "huddle", "forage_with"];
const COLD = ["brush_off", "refuse", "decline", "doubt", "confront", "insult_back", "walk_away"];
const REPLY_PULL: Partial<Record<string, string[]>> = {
  welcome: ["gregarious", "cheerful", "charismatic"], accept: ["trusting", "cheerful"], join: ["gregarious", "cheerful"], give: ["generous", "selfless", "merciful"],
  believe: ["trusting", "gossip"], let_it_go: ["forgiving", "calm", "deferential"], shrug: ["calm", "stoic"],
  share_fire: ["generous", "protective", "selfless"], take_in: ["generous", "protective", "selfless", "loyal"], show: ["patient", "generous", "wise"], welcome_in: ["generous", "loyal", "gregarious"],
  huddle: ["protective", "gregarious", "selfless"], forage_with: ["hardworking", "loyal", "selfless"],
  brush_off: ["shy", "loner", "abrasive", "arrogant"], refuse: ["greedy", "suspicious", "proud"], decline: ["shy", "loner"], doubt: ["suspicious", "skeptical"],
  confront: ["hot-tempered", "just", "vengeful", "brave"], insult_back: ["hot-tempered", "abrasive"], walk_away: ["shy", "melancholy"],
  fight_back: ["brave", "hot-tempered"], flee: ["cowardly", "anxious"], submit: ["deferential", "calm"],
};
export async function respond(w: World, me: Agent, them: Agent, situation: string, options: Record<string, string>) {
  const tie = (k: string) => (WARM.includes(k) ? 1 + 2 * fondness(me, them.id) : COLD.includes(k) ? 0.6 + 2 * grudge(me, them.id) : 1);
  const lean = Object.fromEntries(Object.keys(options).map((k) => [k, tie(k) * (1 + (REPLY_PULL[k] ?? []).reduce((t, x) => t + (me.traits[x] ?? 0), 0))]));
  const ans = await ask(w, "respond", me.id, { ...view(w, me), what_is_happening: situation }, {
    reply: { type: "choice", instructions: `${situation} How does ${me.name} respond?`, criteria: options },
  }, { reply: lean });
  return sample(ans.reply.probabilities!);
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

// After something happens between two people, `me` decides what it meant for how they see `them`. lean says how it
// would land offline: how it feels (-2 much worse .. 2 much better) and the mark it would leave; Jev reads the event.
export type Felt = { feel?: number; bond?: BondKind };
export async function reflect(w: World, me: Agent, them: Agent, happened: string, lean: Felt = {}) {
  const r = (me.rel[them.id] ??= newRel(w.t));
  const shift = ["much worse", "a bit worse", "no change", "a bit better", "much better"];
  const q: Record<string, Question> = {
    bond: { type: "choice", instructions: `What lasting mark, if any, does this leave on how ${me.name} sees ${them.name}?`, criteria: BONDS },
    feeling: { type: "score", instructions: `How does this change how much ${me.name} likes ${them.name}?`, criteria: shift },
    trust: { type: "score", instructions: `How does this change how much ${me.name} trusts ${them.name}?`, criteria: shift },
    label: { type: "choice", instructions: `After this, what best describes how ${me.name} sees their relationship with ${them.name}?`, criteria: LABELS },
  };
  for (const b of OPINIONS) q[`believes_${b}`] = { type: "noul", instructions: `From everything ${me.name} has seen and heard, is ${them.name} ${b}?` };
  const feel = lean.feel ?? 0, aff = r.affinity + feel * 0.1, romantic = (me.traits.flirtatious ?? 0) + (me.traits.romantic ?? 0);
  const leans: Record<string, Lean> = {
    bond: Object.fromEntries(Object.keys(BONDS).map((k) => [k, k === lean.bond ? 6 : k === "none" ? 3 : k === "kindred_spirit" && feel > 0 && aff > 0.4 ? 0.5 : k === "sweetheart" && feel > 0 && aff > 0.45 ? 0.2 + romantic : 0.03])),
    feeling: { at: 2 + feel },
    trust: { at: 2 + Math.sign(feel) * 0.5 },
    label: {
      stranger: r.history.length < 3 ? 2 : 0, acquaintance: 2, friend: aff > 0.3 ? 3 : 0, confidant: aff > 0.6 ? 1 : 0, rival: aff < 0 ? 1 : 0.05, enemy: aff < -0.5 ? 2 : 0,
      sweetheart: aff > 0.45 ? 0.3 + romantic : 0, mentor: lean.bond === "taught_me" ? 3 : 0.05, apprentice: 0.05, kin: 0,
    },
  };
  for (const b of OPINIONS) leans[`believes_${b}`] = { p: clamp((r.beliefs[b] ?? 0.5) + feel * (b === "dangerous" ? -0.08 : 0.06), 0, 1) };
  const ans = await ask(w, "reflect", me.id, {
    who: { name: me.name, bio: me.bio, traits: Object.keys(me.traits) },
    them: { name: them.name, ...describeRel(w, me, them) },
    what_just_happened: happened,
  }, q, leans);
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
  // Offline, nothing the rules don't cover comes of an attempt: random answers would write nonsense into the world's laws.
  const ans = await ask(w, "rule", a.id, {
    attempt,
    materials: parts.map((k) => ({ name: k.name, properties: Object.fromEntries(Object.entries(k.props).filter(([, v]) => (v ?? 0) >= 0.1)) })),
  }, q, { useful: { cap: 0.5 } });
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
// Things people carry are never dwellings; homes are built, not made in the hand.
const LEX = Object.fromEntries(Object.entries(LEXICON as Lexicon).filter(([c]) => c !== "shelter")) as Lexicon;
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

// Offline runs lean toward the milder answers, the way most camps do, and leave a kindness be.
const MILD: Partial<Record<Response, number>> = { let_go: 3, scold: 2, repay: 1.5, shun: 1, drive_out: 0.4 };
const KIND: Partial<Record<Response, number>> = { let_go: 30, scold: 0.5, repay: 0.2, shun: 0.1, drive_out: 0.02 };
// Someone decides how the camp answers what another person did (harm: whether it hurt anyone). The same call asks
// whether the doer would make amends if told to.
export async function judge(w: World, me: Agent, doer: string, state: object, harm: boolean) {
  const ans = await ask(w, "judge", me.id, state, {
    response: {
      type: "choice", criteria: RESPONSES,
      instructions: `${me.name} decides how the camp answers what ${doer} did. Given who ${me.name} is, what happened, and how this camp has handled cases like it before, what does ${me.name} decide?`,
    },
    comply: { type: "noul", instructions: `If the camp told ${doer} to give it back or make up for it, would ${doer} actually do it?` },
  }, { response: harm ? MILD : KIND });
  const odds = ans.response.probabilities!;
  return { response: sample(odds, 1) as Response, odds, comply: ans.comply.noul ?? 0.5 };
}
