// Materials are bags of properties. Items are kinds in a registry that grows as people make new things.
export const PROPS = [
  "hard", "sharp", "heavy", "long", "flexible", "fibrous", "binding", "flammable",
  "edible", "toxic", "plastic", "container", "insulating", "medicinal", "seed", "toughness",
] as const;
export type Prop = (typeof PROPS)[number];
export type Props = Partial<Record<Prop, number>>;

export type Kind = {
  id: string;
  name: string;
  base?: string;
  props: Props;
  parts?: string[];
  made?: { by: string; t: number };
  verb?: string;
  grain?: "split" | "shatter";
  shelf?: number; // days before food spoils
  breaks?: Record<string, number>; // what it turns into when it fails
  fuel?: number; // ticks of fire it feeds
  count?: number; // times anyone has made it
  named?: boolean; // people settled on a common name
  plain?: string; // the descriptive name before that
  desc?: string; // what it physically is, e.g. "sharp stone lashed to a stick"
  uses?: Record<string, number>; // what people have done with it, e.g. "felling trees" -> 4
};

// Raw materials. Everything else is made from these.
export const BASE: Record<string, Omit<Kind, "id">> = {
  berry: { name: "berry", props: { edible: 0.2, seed: 0.6, toughness: 0.02 }, shelf: 2 },
  nut: { name: "nut", props: { edible: 0.14, hard: 0.3, seed: 0.4, toughness: 0.2 }, shelf: 25 },
  mushroom: { name: "mushroom", props: { edible: 0.18, toxic: 0.12, toughness: 0.03 }, shelf: 1.5 },
  herb: { name: "herb", props: { edible: 0.04, medicinal: 0.8, fibrous: 0.3, toughness: 0.03 }, shelf: 3 },
  fish: { name: "fish", props: { edible: 0.18, toxic: 0.2, toughness: 0.05 }, shelf: 1 },
  meat: { name: "meat", props: { edible: 0.3, toxic: 0.3, toughness: 0.1 }, shelf: 1 },
  hide: { name: "hide", props: { insulating: 0.8, flexible: 0.6, fibrous: 0.3, toughness: 0.3, flammable: 0.3 } },
  bone: { name: "bone", props: { hard: 0.6, sharp: 0.15, long: 0.35, heavy: 0.2, toughness: 0.45 }, grain: "shatter", breaks: { bone_shard: 1 } },
  bone_shard: { name: "bone shard", props: { hard: 0.6, sharp: 0.6, heavy: 0.05, toughness: 0.35 } },
  stick: { name: "stick", props: { long: 0.7, hard: 0.3, heavy: 0.15, flexible: 0.3, flammable: 0.7, toughness: 0.2 }, grain: "split", fuel: 40 },
  stone: { name: "stone", props: { hard: 0.9, heavy: 0.6, toughness: 0.7 }, grain: "shatter", breaks: { sharp_stone: 1 } },
  sharp_stone: { name: "sharp stone", props: { hard: 0.85, sharp: 0.7, heavy: 0.3, toughness: 0.5 } },
  fiber: { name: "fiber", props: { fibrous: 0.9, flammable: 0.9, flexible: 0.8, toughness: 0.05 }, fuel: 10 },
  clay: { name: "wet clay", props: { plastic: 0.9, heavy: 0.5, binding: 0.4, toughness: 0.1 } },
  log: { name: "log", props: { heavy: 0.8, long: 0.8, hard: 0.5, flammable: 0.6, toughness: 0.6 }, grain: "split", breaks: { plank: 2 }, fuel: 150 },
  plank: { name: "plank", props: { long: 0.7, hard: 0.5, heavy: 0.4, flammable: 0.6, toughness: 0.4 }, fuel: 80 },
};

// World things are made of materials too.
export const THING_MATERIAL: Record<string, { toughness: number; hp: number; flammable: number; breaks: Record<string, number> }> = {
  tree: { toughness: 0.55, hp: 100, flammable: 0.5, breaks: { log: 2, stick: 2 } },
  bush: { toughness: 0.15, hp: 20, flammable: 0.6, breaks: { stick: 1 } },
  dead_bush: { toughness: 0.1, hp: 8, flammable: 0.9, breaks: { stick: 2 } },
  reeds: { toughness: 0.05, hp: 6, flammable: 0.8, breaks: { fiber: 2 } },
  boulder: { toughness: 0.85, hp: 120, flammable: 0, breaks: { stone: 3 } },
  stump: { toughness: 0.5, hp: 40, flammable: 0.4, breaks: { stick: 1 } },
  deer: { toughness: 0.1, hp: 30, flammable: 0, breaks: { meat: 3, hide: 1, bone: 2 } },
  wolf: { toughness: 0.15, hp: 35, flammable: 0, breaks: { meat: 2, hide: 1, bone: 1 } },
};

export type Registry = Record<string, Kind>;
export function baseRegistry(): Registry {
  return Object.fromEntries(Object.entries(BASE).map(([id, k]) => [id, { id, base: id, ...k }]));
}

export const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
export const p = (k: Kind | undefined, prop: Prop) => k?.props[prop] ?? 0;
const round = (props: Props): Props =>
  Object.fromEntries(Object.entries(props).filter(([, v]) => (v ?? 0) > 0.01).map(([k, v]) => [k, Math.round(clamp01(v!) * 100) / 100]));

// Register a made kind once; later makers reuse it. Returns [kind, isNew].
export function ensure(reg: Registry, id: string, make: () => Omit<Kind, "id">): [Kind, boolean] {
  if (reg[id]) return [reg[id], false];
  const k = { id, ...make() };
  k.props = round(k.props);
  reg[id] = k;
  return [k, true];
}

// The words people would use, from what a thing is made of. Jev later picks a short common name.
// The noun a made thing goes by when it's part of something bigger: "cord", not "twisted fiber cord".
export function noun(k: Kind) {
  const name = k.name.includes("'s ") ? k.name.split("'s ").at(-1)! : k.name;
  if (name.includes("-headed ")) return name.split("-headed ")[1].split(" ").at(-1)!;
  const bare = name.split(" for ")[0];
  for (const sep of [" lashed to ", " packed onto ", " wrapped in ", " pressed into ", " wedged into ", " strung with ", " packed in "]) if (bare.includes(sep)) return bare.split(sep)[0].split(" ").at(-1)!;
  if (bare.startsWith("bound ") || bare.startsWith("bundle of ") || bare.endsWith(" tied together")) return "bundle";
  return bare.split(" ").at(-1)!;
  return name.split(" ").at(-1)!;
}
export const depth = (reg: Registry, k?: Kind): number => (k?.parts?.length ? 1 + Math.max(...k.parts.map((id) => depth(reg, reg[id]))) : 0);
export function compoundName(reg: Registry, parts: Kind[]): string {
  const short = (k: Kind) => (k.parts ? (k.named ? k.name : noun(k)) : k.name);
  const binder = parts.find((x) => p(x, "binding") >= 0.6);
  const rest = parts.filter((x) => x !== binder);
  const how = binder && p(binder, "plastic") >= 0.5 ? "packed onto" : "lashed to";
  if (rest.length === 1 && binder) return `${short(rest[0])} strung with ${short(binder)}`;
  const top = [...rest].sort((a, b) => p(b, "sharp") + p(b, "heavy") * 0.5 - p(a, "sharp") - p(a, "heavy") * 0.5)[0];
  const handle = rest.filter((x) => x !== top).sort((a, b) => p(b, "long") - p(a, "long"))[0];
  if (top && handle && p(handle, "long") >= 0.5) return `${short(top)} ${how} a ${short(handle)}`;
  return `${[...new Set(rest.map(short))].join(" and ")} tied together`;
}

