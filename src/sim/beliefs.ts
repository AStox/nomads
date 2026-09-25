// What each agent thinks happens when they do something, and the laws of the world those beliefs come from.
import type { Fields, Outcome } from "./physics";
import { dist, log, stageOf, type Agent, type World } from "./world";
import { trace } from "./trace";

export type Belief = {
  key: string;
  fields: Fields;
  uses: Record<string, number>; // what it used up
  out: Record<string, number>; // what it produced
  ticks: number; // how long it tends to take
  rate?: number; // damage per blow, for strikes
  tries: number;
  wins: number;
  how: "discovered" | "watched" | "taught" | "seen";
  from?: string;
  t: number;
  spurious?: string; // a kind they wrongly think they need to hold
  law?: string;
};

export const beliefKey = (f: Fields) =>
  [f.verb, f.inputs.join("+"), f.tool ?? "-", f.target ?? "-", f.at ?? "-", f.shape ?? "-"].join("|");

const nm = (w: World, id: string) => w.kinds[id]?.name ?? id.replaceAll("_", " ");
const an = (s: string) => (s.includes("'s ") ? s : /^[aeiou]/.test(s) ? `an ${s}` : `a ${s}`);
const with_ = (w: World, tool?: string | null) => (tool ? `with ${an(nm(w, tool))}` : "with bare hands");
const gives = (w: World, f: Fields) => f.gives.map((k) => nm(w, k)).join(" and ");

export function sentence(w: World, f: Fields, ticks?: number): string {
  const time = ticks && ticks > 12 ? ` (about ${Math.max(1, Math.round((ticks * 5) / 60))} hours)` : "";
  const ins = f.inputs.map((k) => nm(w, k));
  const fireWord = ({ hearth: "a ringed fire", kiln: "a ringed fire heaped over with stone", forge: "a ringed charcoal fire" } as Record<string, string>)[f.at ?? ""] ?? "a fire";
  switch (f.verb) {
    case "strike":
      if (f.builds === "fire") return `Striking ${an(nm(w, f.target ?? "stone"))} ${with_(w, f.tool)} over dry tinder can throw a spark that lights a fire.`;
      if (f.effect === "dented") return `Hammering cold ${ins[0]} only dents it.`;
      if (f.at === "forge" && f.gives.length) return `Hammering ${an(ins[0])} ${with_(w, f.tool)} at ${fireWord} draws it out into ${an(gives(w, f))}.`;
      if (f.target && !f.inputs.length)
        return f.gives.length ? `Striking ${an(f.target)} ${with_(w, f.tool)} breaks it into ${gives(w, f)}${time}.` : `Striking ${an(f.target)} ${with_(w, f.tool)} barely marks it.`;
      return f.gives.length ? `Striking ${an(ins[0])} ${with_(w, f.tool)} can break off ${gives(w, f)}.` : `Striking ${an(ins[0])} ${with_(w, f.tool)} does nothing much.`;
    case "rub":
      if (f.builds === "fire") return `Rubbing ${ins.filter((x, i) => i < 2).map(an).join(" against ")} gets hot enough to light ${ins[2] ? `the ${ins[2]}` : "tinder"}. Fire.`;
      if (f.effect === "heat") return `Rubbing ${an(ins[0])} against ${an(ins[1] ?? ins[0])} makes them hot.`;
      return f.gives.length ? `Rubbing ${an(ins[0])} on ${an(ins[1] ?? ins[0])} makes ${an(gives(w, f))}.` : `Rubbing ${ins.join(" on ")} does nothing much.`;
    case "join":
      return f.gives.length ? `Binding ${ins.join(", ")} together makes ${an(gives(w, f))}.` : `${ins.join(" and ")} won't hold together.`;
    case "heat":
      if (f.effect === "burned") return `${ins[0][0].toUpperCase() + ins[0].slice(1)} burns away in a fire.`;
      if (f.effect === "too_cool") return `${fireWord[0].toUpperCase() + fireWord.slice(1)} isn't hot enough to change ${ins.join(" or ")}.`;
      if (f.effect === "scorched") return `An open fire only scorches ${ins[0]}.`;
      return f.gives.length ? `Holding ${ins.join(" and ")} in ${fireWord}${f.tool ? `, blowing air at it with ${an(nm(w, f.tool))},` : ""} makes ${an(gives(w, f))}.` : `Fire doesn't change ${ins.join(" or ")}.`;
    case "wet":
      if (f.effect === "nibble") return `Something in the water tugs at ${an(ins[0])} dangled in it.`;
      return f.gives.length ? `Dipping ${an(ins[0])} in the water ${f.gives.includes("fish") ? "can catch a fish" : `gives ${gives(w, f)}`}.` : `Water does nothing to ${ins[0]}.`;
    case "shape":
      return `Pressing ${ins[0]} into a ${f.shape} makes ${an(gives(w, f))}.`;
    case "place":
      if (f.builds === "fire") return `Setting ${an(ins.find((x) => x.startsWith("burning")) ?? ins[0])} into ${ins.filter((x) => !x.startsWith("burning")).join(" and ") || "a fire"} starts a campfire.`;
      if (f.builds === "fed_fire") return `Feeding ${ins.join(" and ")} to a fire keeps it going.`;
      if (f.builds === "hearth") return `Ringing a fire with ${ins.join(" and ")} keeps it contained and burning steady.`;
      if (f.builds === "kiln") return `Heaping ${ins.join(" and ")} over a ringed fire closes it in to smolder.`;
      if (f.builds === "forge") return `Feeding ${ins.join(" and ")} to a ringed fire makes it burn white-hot.`;
      if (f.builds === "shelter") return `Leaning and stacking ${ins.join(", ")} makes a shelter.`;
      return `Stacking ${ins.join(", ")} makes a pile.`;
    case "plant":
      return f.builds === "bush" ? `${an(ins[0])[0].toUpperCase() + an(ins[0]).slice(1)} pushed into the ground grows into a bush.` : `They pushed ${an(ins[0])} into the ground.`;
    case "eat":
      if (f.effect === "sick") return `Eating ${ins[0]} can make you sick.`;
      if (f.effect === "cure") return `Eating ${ins[0]} helps when you're sick.`;
      return `${ins[0]} is good to eat.`;
    case "wear":
      return `Wearing ${ins[0]} keeps the cold out.`;
    case "dig":
      return `Digging ${with_(w, f.tool)} makes a deep pit.`;
    case "throw":
      return f.gives.length ? `Throwing ${an(ins[0])} at ${an(f.target ?? "animal")} can bring it down.` : `Throwing ${an(ins[0])} at ${an(f.target ?? "animal")} can wound it.`;
  }
  return `${f.verb} ${ins.join(", ")}`;
}
export const beliefText = (w: World, b: Belief) =>
  sentence(w, b.fields, b.ticks) + (b.spurious ? ` They're convinced it only works if they hold ${an(nm(w, b.spurious))}.` : "");

// Useful enough to remember: it made something, built something, or had a clear effect.
const useful = (o: Outcome) => o.ok || !!o.effect || !!o.fields.gives.length || (!!o.fields.builds && o.fields.builds !== "pile" && o.fields.builds !== "ring");

export function record(w: World, a: Agent, out: Outcome, ticks: number, how: Belief["how"] = "discovered", from?: Agent) {
  const f = out.fields;
  const key = beliefKey(f);
  if (!useful(out)) {
    a.tried[key] = (a.tried[key] ?? 0) + 1;
    trace("belief", "nothing", { key, text: out.text }, a.id);
    return null;
  }
  for (const k of out.newKinds) log(w, "invent", [a.id], a, `${a.name} made the first ${nm(w, k)} anyone has ever made.`);
  let law = w.laws[key];
  if (!law && out.ok) {
    law = w.laws[key] = { id: `L${Object.keys(w.laws).length + 1}`, key, text: sentence(w, f, ticks), verb: f.verb, source: out.ruled ? "jev" : "physics", by: a.id, t: w.t };
    log(w, "law", [a.id], a, `${a.name} found out something new about the world: ${law.text}`);
  }
  let b = a.beliefs[key];
  const isNew = !b;
  b ??= a.beliefs[key] = { key, fields: f, uses: out.uses, out: out.gives, ticks, tries: 0, wins: 0, how, from: from?.id, t: w.t };
  b.fields = { ...f, gives: f.gives.length ? f.gives : b.fields.gives };
  if (Object.keys(out.gives).length) b.out = out.gives;
  if (out.ok) b.uses = out.uses;
  b.tries++;
  if (out.ok) b.wins++;
  b.ticks = b.tries === 1 ? ticks : b.ticks * 0.7 + ticks * 0.3;
  if (out.numbers?.rate) b.rate = out.numbers.rate;
  if (law) b.law = law.id;
  if (isNew && how === "discovered" && law && law.by !== a.id) log(w, "discover", [a.id], a, `${a.name} worked out on their own: ${sentence(w, f, ticks)}`);
  if (isNew) superstition(w, a, b);
  trace("belief", isNew ? "learned" : "reinforced", { key, how, tries: b.tries, wins: b.wins, spurious: b.spurious }, a.id);
  return b;
}

// Superstitious minds tie a success to whatever else was in their hands.
function superstition(w: World, a: Agent, b: Belief) {
  const s = a.traits.superstitious ?? 0;
  if (!s || Math.random() > s * 0.5) return;
  const used = new Set([...b.fields.inputs, b.fields.tool ?? ""]);
  const other = a.inv.find((x) => !used.has(x.k));
  if (!other) return;
  b.spurious = other.k;
  log(w, "mistaken", [a.id], a, `${a.name} is convinced it only worked because they were holding ${an(nm(w, other.k))}.`);
}

// Everyone nearby sees what happened and slowly picks it up.
export function watchers(w: World, doer: Agent, out: Outcome, ticks: number) {
  if (!useful(out)) return;
  const key = beliefKey(out.fields);
  for (const b of w.agents) {
    if (b === doer || b.down > w.t || dist(doer, b) > 6) continue;
    const mine = b.beliefs[key];
    if (mine) {
      // A skeptic who sees it work without the charm drops the charm.
      if (mine.spurious && !doer.inv.some((s) => s.k === mine.spurious) && (b.traits.skeptical ?? 0) + (b.traits.observant ?? 0) > 0.3) {
        log(w, "learn", [b.id], b, `${b.name} watched ${doer.name} do it without ${an(nm(w, mine.spurious))} and realized it was never needed.`);
        delete mine.spurious;
      }
      continue;
    }
    // Children soak up what the grown-ups around them do.
    const k = 0.6 * (1 + (b.traits.observant ?? 0) + (b.traits.clever ?? 0) * 0.5 + (b.traits.curious ?? 0) * 0.5) * (stageOf(w, b) === "child" ? 2 : 1);
    b.watching[key] = (b.watching[key] ?? 0) + k;
    trace("belief", "watching", { key, progress: b.watching[key], doer: doer.id }, b.id);
    if (b.watching[key] < 1) continue;
    delete b.watching[key];
    const got = record(w, b, out, ticks, "watched", doer);
    if (got) log(w, "learn", [b.id, doer.id], b, `${b.name} learned by watching ${doer.name}: ${sentence(w, out.fields, ticks)}`);
  }
}

export function teach(w: World, teacher: Agent, learner: Agent, key: string) {
  const b = teacher.beliefs[key];
  if (!b) return;
  learner.beliefs[key] = { ...b, fields: { ...b.fields }, how: "taught", from: teacher.id, t: w.t, tries: 0, wins: Math.min(1, b.wins) };
  trace("belief", "taught", { key, from: teacher.id, spurious: b.spurious }, learner.id);
}

// Things seen about the world that aren't someone's action: what trees break into, which berries grow.
export function see(w: World, center: { x: number; y: number }, key: string, text: string, radius = 7) {
  for (const a of w.agents) {
    if (a.down > w.t || dist(a, center) > radius || a.facts[key]) continue;
    a.facts[key] = text;
    trace("belief", "saw", { key, text }, a.id);
  }
}
