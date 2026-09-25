// Build src/sim/lexicon.json from Princeton WordNet: everyday words for made things, grouped the way Jev picks them.
//   curl -sL https://wordnetcode.princeton.edu/wn3.1.dict.tar.gz | tar xz -C /tmp/wn && bun scripts/build-lexicon.ts /tmp/wn/dict
const dir = process.argv[2] ?? "/tmp/wn/dict";
type Syn = { id: string; words: string[]; hyper: string[]; gloss: string };
const syns = new Map<string, Syn>();
for (const line of (await Bun.file(`${dir}/data.noun`).text()).split("\n")) {
  if (!line || line.startsWith(" ")) continue;
  const [head, gloss = ""] = line.split(" | ");
  const f = head.split(" ");
  const n = parseInt(f[3], 16);
  const words = Array.from({ length: n }, (_, i) => f[4 + i * 2].replace(/\(.*\)$/, "").replaceAll("_", " "));
  let i = 4 + n * 2;
  const pc = Number(f[i++]);
  const hyper: string[] = [];
  for (let k = 0; k < pc; k++, i += 4) if (f[i] === "@" || f[i] === "@i") hyper.push(f[i + 1]);
  syns.set(f[0], { id: f[0], words, hyper, gloss: gloss.split(";")[0].trim() });
}
// How often each word is used in this sense in tagged text, so "hero" the sandwich doesn't outrank "stew".
const freq = new Map<string, number>();
for (const line of (await Bun.file(`${dir}/index.sense`).text()).split("\n")) {
  const [key, offset, , n] = line.split(" ");
  if (!key?.includes("%1:")) continue;
  freq.set(`${key.split("%")[0].replaceAll("_", " ")}|${offset}`, Number(n));
}
// Categories: [id, description shown to Jev, WordNet synset offsets that root it].
// Specific kinds first, so a word like "bowl" lands under vessel and not under the catch-all container.
const CATS: [string, string, string[]][] = [
  ["cutting_tool", "A tool with an edge or point, for chopping, cutting, scraping, or piercing", ["03159112", "03269943"]],
  ["weapon", "Something made for hunting or fighting", ["04572661"]],
  ["vessel", "A pot, bowl, jar, or cup for cooking, storing, or drinking", ["04538393", "03211629"]],
  ["utensil", "A utensil for preparing or eating food", ["04523967", "03626258"]],
  ["light", "Something that gives light or carries a flame", ["03670692"]],
  ["trap", "A trap or snare for catching animals", ["04481701"]],
  ["fishing_gear", "Gear for catching fish", ["03356280"]],
  ["rope", "Rope, cord, line, or string", ["04115362"]],
  ["fastener", "Something that fastens or binds things together", ["03328648"]],
  ["clothing", "Something worn on the body", ["03055525"]],
  ["shelter", "A shelter or a dwelling", ["04198638", "03264208"]],
  ["building_material", "Material for building: bricks, planks, thatch, mortar", ["14810638"]],
  ["dish", "Prepared food: a dish, a meal, a stew, a bread", ["07572999"]],
  ["hand_tool", "A hand tool for pounding, digging, prying, or shaping", ["04459089"]],
  ["container", "Something that holds or carries things: a basket, a bag, a box", ["03099154"]],
  ["covering", "Something that covers or protects: a mat, a lid, a roof, a blanket", ["03127399"]],
  ["implement", "Some other kind of tool or device", ["03569147"]],
];
const BANNED = /match|electr|engine|motor|gasoline|petrol|plastic|nylon|steel|iron|gun|firearm|rifle|pistol|cannon|bomb|missile|computer|radio|telephon|battery|automobile|vehicle|machine|rocket|laser|nuclear|chemical|rubber|glass|aluminum|copper|brass|bronze|silver|gold|tin |zinc|canned|carton|cellophane|paper|cardboard|photograph|camera|television|film|tape|refriger|microwave|oven|stove|kitchen appliance|dental|surgical|medical|laboratory|scientific|mechanical|hydraulic|pneumatic|clock|watch|compass|telescope|lens|sewing machine|typewriter|printing|golf|tennis|baseball|basketball|football|hockey|cricket|billiard|toy|game|coin|money|banknote/i;
const seen = new Set<string>();
const out: Record<string, { description: string; words: { w: string; gloss: string }[] }> = {};
const kids = new Map<string, string[]>();
for (const s of syns.values()) for (const h of s.hyper) (kids.get(h) ?? kids.set(h, []).get(h)!).push(s.id);
for (const [id, description, roots] of CATS) {
  const stack = [...roots], words: { w: string; gloss: string; f: number }[] = [];
  const mine = new Set<string>();
  const visited = new Set<string>();
  while (stack.length) {
    const cur = syns.get(stack.pop()!)!;
    if (visited.has(cur.id)) continue;
    visited.add(cur.id);
    if (BANNED.test(cur.gloss)) continue;
    for (const k of kids.get(cur.id) ?? []) stack.push(k);
    for (const w of cur.words) {
      if (seen.has(w) || mine.has(w) || w.split(" ").length > 2 || /[^a-z ]/.test(w) || BANNED.test(w) || w.length < 3) continue;
      mine.add(w);
      words.push({ w, gloss: cur.gloss.slice(0, 90), f: freq.get(`${w.toLowerCase()}|${cur.id}`) ?? 0 });
    }
  }
  // Most familiar first; naming splits long lists across several Jev questions, so nothing is cut.
  const top = words.sort((a, b) => b.f - a.f);
  for (const x of top) seen.add(x.w);
  out[id] = { description, words: top.map(({ w, gloss }) => ({ w, gloss })) };
  console.log(id, words.length, "->", top.length, top.slice(0, 12).map((x) => x.w).join(", "));
}
await Bun.write(`${import.meta.dir}/../src/sim/lexicon.json`, JSON.stringify(out));
console.log("words:", Object.values(out).reduce((t, c) => t + c.words.length, 0));
