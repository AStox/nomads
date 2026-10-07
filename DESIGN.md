# Nomads design notes

## Relationships with lore

Jev can't write text. It can only pick, rate, and answer yes or no. So the lore comes from three things: code records what happened, Jev decides what it meant, and templates turn that back into words.

1. **Event log.** Every interaction becomes a structured event, like `{ day: 3, actor: "mara", kind: "gave_food", item: "berry", qty: 2, context: "i_was_starving" }`. A template renders it as "Day 3: Mara gave me 2 berries when I was starving." Those lines are the relationship's history, and they go into Jev's state on later calls.
2. **Bonds.** After an event, one Jev choice picks which bond it creates, if any. The options come from a closed list: saved my life, stole from me, shared a fire, owes me, I owe them, broke a promise, taught me, rival for the same thing, blood feud, sworn friend, lover, kin, humiliated me, defended me. Bonds carry a weight and fade at different speeds (a theft is remembered longer than a shared meal). A relationship reads like "Mara: saved my life (day 3), shared fire x4, owes me 2 berries."
3. **Relationship label.** Every so often, one Jev choice over the history and bonds picks a label: stranger, acquaintance, friend, confidant, rival, enemy, lover, mentor, apprentice, kin, or leader. This is the type of relationship, separate from how warm it is.
4. **Perceptions.** Each agent keeps its own belief about the other's traits, like "I think Mara is generous and lazy." Each belief is a Jev noul ("Given these events, is Mara generous?") and can be wrong.
5. **Gossip.** When A talks to B about C, B's beliefs about C move toward A's, weighted by how much B trusts A. That's how reputation spreads, and it's how lies, feuds, and a town's opinion of its leader can show up.
6. **Ledger.** Code tracks favors given and received. Reciprocity, debt, and resentment fall out of it without any Jev call.

Optional later: an LLM reads the event log once per in-game week and writes a short chronicle for the player to read. The simulation never depends on it.

```ts
type Relationship = {
  affinity: number;                    // -1 to 1
  trust: number;                       // 0 to 1
  label: RelationshipLabel;
  bonds: { kind: BondKind; day: number; weight: number }[];
  perceivedTraits: Partial<Record<Trait, number>>; // noul, what I believe about them
  ledger: number;                      // favors they did me minus favors I did them
  history: string[];                   // rendered event lines, last 10
};
```

## Discovery and knowledge

Agents start knowing almost nothing: how to walk, pick things up, eat, sleep, and talk. Everything else is know-how they have to discover, watch, or be taught.

### The hidden recipe book

The world has a fixed recipe book in code that the agents can't see. Each recipe lists its inputs (items in hand), where it has to happen (next to a tree, a fire, water, clay), what it makes (an item, a structure, or a new ability), and which craft it belongs to. Adding content means adding rows, not writing code.

Example chain:
- two stones → a sharp stone (knapping)
- sharp stone + stick + plant fiber → a stone axe
- stone axe, next to a tree → logs
- logs + fiber → a log shelter
- dry wood + stick + fiber → a bow drill; bow drill + dry wood → fire
- logs + axe + wedge, next to a flat stone → planks (milling)
- planks + pegs → a plank cabin, a table, a door
- clay next to fire → pottery; clay + straw next to fire → bricks

### Tinkering: Jev is the intuition, code is the physics

Tinkering is a goal like any other. When an agent tinkers, Jev picks which combination they'd think to try from what they're holding and what's nearby: "Mara is holding two stones and a stick, standing by a dry bush. What would she try?" Jev knows how the real world works, so it'll favor combinations that make sense (striking stones together, lashing a stone to a stick). Discoveries come out in a believable order without anyone scripting it.

Code then checks the recipe book:
- **Match:** a success roll based on how clever or curious they are and related craft skill. On success, they learn it.
- **Near miss** (shares inputs with a recipe they don't know): they get a clue on that recipe, and each clue makes the next try more likely to work. "Mara noticed sparks when the stones struck."
- **Nothing:** time and sometimes materials are lost. This matters, because tinkering competes with eating and staying warm, so curious agents with a full belly do most of the inventing.

Every tinker attempt is logged. The first person in the world to discover something gets an **invention** entry in the chronicle, marked as a major event. Anyone who works it out independently later gets a rediscovery entry.

### Spreading knowledge

- **Watching:** when someone uses a recipe within sight of an agent who doesn't know it, the watcher gets progress on it. Enough progress and they learn it, faster if they're observant or clever.
- **Teaching:** a social action. The teacher offers, the learner accepts or refuses (a Jev choice), and learning is fast. It creates a "taught me" bond.
- **Secrets:** a greedy or suspicious agent can decline to teach, or avoid working where others can see. Know-how becomes something to trade, hoard, or steal by watching.

Knowledge flows along relationships, so friends end up sharing a toolkit and rivals don't. That's where specialization and eventually professions come from.

### Skills grow out of know-how

There is no fixed skill list at the start. A craft (stonework, woodworking, firemaking, pottery) appears on an agent's page the first time they learn a recipe in it, and it levels up as they use that craft. Higher levels mean better success rates when tinkering nearby in the same craft, faster work, and better results. The 111 skills below become the eventual list of crafts, filled in as the recipe book grows.

### State

```ts
type Recipe = {
  id: string;                          // "knap_sharp_stone"
  craft: string;                       // "stonework"
  inputs: Partial<Record<Item, number>>;
  tools?: Item[];                      // needed but not used up
  near?: ThingKind;                    // "fire", "tree", "water"
  makes: { item?: Item; thing?: ThingKind; ability?: string };
  difficulty: number;                  // base failure rate for a first try
};
type Knowledge = {
  known: Record<string, { how: "discovered" | "watched" | "taught"; t: number; from?: string }>;
  clues: Record<string, number>;       // recipe id -> progress toward discovering or learning it
};
```

## Emergence

The recipe book only produces what we wrote. To get outcomes nobody planned, the world has to run on general rules that combine, and those rules have to collide with each other. This section replaces the fixed recipe book with a material system and adds world systems that push on the agents.

### 1. Materials are bags of properties

Every item and thing carries a set of properties with strengths from 0 to 1, instead of being a named type the code special-cases.

| Property | Meaning | Examples |
| --- | --- | --- |
| hard | resists force, can strike | stone 0.9, log 0.6, clay 0.1 |
| sharp | cuts and pierces | sharp stone 0.7, bone shard 0.6 |
| heavy | carries force, slow to carry | stone 0.7, log 0.8 |
| long | reaches, levers | stick 0.8, log 0.9 |
| flexible | bends and springs back | fresh stick 0.6, cord 0.9 |
| fibrous | can be split, twisted, woven | reeds 0.9, bark 0.7 |
| binding | holds things together | cord 0.9, resin 0.8, wet clay 0.5 |
| flammable | catches fire | dry grass 0.9, wood 0.7 |
| dry / wet | state, changes with weather and fire | |
| hot | state, fades over time | ember, fired pot |
| edible | food value, with nutrition and risk | berry, fish, raw meat |
| toxic | makes you sick | some mushrooms, rotten meat |
| plastic | can be shaped | wet clay 0.9 |
| container | holds liquid or small things | pot, hollow gourd, bark bowl |
| insulating | keeps heat in | hide, fur, thatch |

An item is `{ base: "stone", props: {...}, made?: { from, by, t } }`. Two stones are the same item until one gets chipped, and then it's a different one.

Things in the world are made of materials too. A tree is a standing mass of wood with `integrity` (how much damage it can take) and `breaks_into` (what's left when integrity hits zero: logs, branches, bark). A boulder breaks into stones, a stone breaks into a sharp fragment and grit, and a dead deer breaks into meat, hide, and bone. Every material also has a `toughness` (how hard it is to damage) and a `grain` (whether it splits cleanly along one direction, like wood, or shatters, like flint).

### 2. Verbs and material responses

There are no tool actions like chop, mine, or butcher. Agents have a handful of basic verbs, and what happens depends only on the materials involved.

Verbs:
- **strike** a target with something held (or with bare hands)
- **press / rub** one thing against another (grind, sharpen, start friction heat)
- **join** things (bind with something binding, stack, lean, pack)
- **heat / wet** by putting something in fire or water
- **shape** something plastic
- **move** (carry, drop, throw, dig, place)
- **consume** (eat, drink, wear)

The physics is a few response rules over properties, written once:

- **Damage from a strike** = force x focus - target toughness. Force comes from the held thing's weight and length (leverage) plus the agent's strength. Focus comes from sharpness, so a sharp edge concentrates force and a blunt one spreads it. Damage lowers the target's integrity. At zero, the target turns into its `breaks_into` products.
- **Recoil:** force the target doesn't absorb comes back. Hitting a tree with your fist hurts you. A weak binding snaps. A brittle tool chips and loses sharpness.
- **Friction:** rubbing builds heat in proportion to pressure and speed, and dissipates it over time. Enough heat on something flammable and dry makes an ember.
- **Heat:** past a material's threshold it changes state: wet becomes dry, raw becomes cooked, wet clay becomes fired, resin melts, flammable things burn.
- **Joining:** a joined item's properties are its parts' properties, weighted by where they sit (the head gives sharpness, the handle gives length). It's only as strong as its weakest joint.

Chopping isn't in this list, and it doesn't need to be. An agent who wants the tree down strikes it with whatever they have:

| Held | What happens |
| --- | --- |
| nothing | almost no damage, their hand hurts, they give up |
| a stone | slow, the tree takes most of a day, the stone may split |
| a sharp stone | faster, but it's short, so there's little force |
| sharp stone bound to a stick | fast, most of the force is focused; the binding may loosen |
| a heavy sharp thing we never designed | also works, by the same rule |

The same rule covers splitting logs (wood grain splits cleanly under a focused strike), knapping (stone struck at an angle breaks off a sharp fragment), butchering, breaking ice, and fighting. When two agents fight, a spear is simply a long, sharp thing, and it does what those properties do.

**No luck in whether it comes off** (October 6). Whether a try comes off follows from what anyone trying could notice: what they hold and what it's made of, what they set out to do, the weather and the spot, a fish in reach, how far off the prey is. Dice decide only how much or how good: how many fish a basket brings up, how bad a sickness is, where a throw that falls short lands. Striking stone on stone over tinder held under the blow throws sparks, and the tinder catches once enough have fallen into it (plain stone takes nine blows, flint three), unless it isn't fine and dry or the rain is on it; striking with nothing under the blow is knapping, and a flake comes off once the blows add up. A sharp edge peels a strip of bark every so many blows. Fishing catches whenever a fish is in reach and never otherwise, which anyone fishing can see, so it's a condition of its own (no fish close by), noted only for fishing. A throw within reach hits. Food rank enough makes anyone who eats it sick, every time, and milder food never does. Fire spreads to what's beside it once the heat has added up. Before, a spark caught or the stone chipped by a roll each blow, so two tries in three over tinder failed with nothing anyone could see to blame, and people learned from luck. Now every failure has a reason someone could find.

### 2a. Planning without hard-coded effects

GOAP needs to predict what a verb will do. It can't use the physics rules directly, because agents don't know the physics. It uses each agent's **beliefs**: the outcomes they've seen, stored as "strike tree with sharp stone on a stick: tree fell, took about 10 minutes." Goals are world states ("the tree is logs", "I have something that cuts meat"), and the planner picks verbs and objects the agent believes will get there.

- An agent who has never seen a tree fall doesn't know striking works, so "get logs" isn't a goal they can plan for. They can still tinker, and a Jev choice picks what they try.
- Beliefs come from doing, watching, and being told. They can be wrong or out of date, like thinking a blunt stone works when it only worked because the tree was already half cut.
- A tool's "purpose" is also a belief: "the bound stone is good for felling trees." Nobody labels it an axe; the use is what the agents remember.

What stays hard-coded is the physics rules and the material values. That's intentional: it's the one layer that has to be consistent for the world to make sense. Everything above it (tools, techniques, what's worth making) comes out of agents finding out what those rules do.

### 3. Jev judges the edges, and its answers become law

Rules can't cover every pair. When an agent tries something the rules don't cover (bind a mushroom to a fish, heat reeds in water), Jev answers a few typed questions about the physical result with world state as context: "Would this realistically hold together?", "Does the result stay sharp?", "Is this edible now?" The answers set the result's properties.

Every Jev ruling is cached as a **world law** keyed by the operation and the rounded properties of the inputs. The next time anyone tries the same thing, the law applies without a Jev call. So the world stays consistent, the physics grows as agents explore it, and the list of laws is itself a record of what this world has learned. Laws are world facts; knowing them is per agent, the same way recipes work today.

### 4. Naming things without writing text

Jev can't invent a word, so a made thing starts with a working name that says what it physically is: "sharp stone lashed to a stick," "twisted fiber cord," "stick wrapped in fiber." As people use it, its most common use is added: "sharp stone lashed to a stick for felling trees," "stick wrapped in fiber for making fire." After it has been made three times, people settle on a common word, chosen by Jev from about 3,000 real object nouns taken from WordNet (`src/sim/lexicon.json`, rebuilt by `scripts/build-lexicon.ts`), grouped into 17 kinds of thing (cutting tool, weapon, vessel, rope, clothing, shelter, light, trap, dish, and so on).

1. Jev is shown the working name, what people have actually done with the thing (from everyone's beliefs), what it's like, and what it's made of.
2. Jev picks what kind of thing it is. Every kind with at least a 15% chance goes forward, up to three.
3. All the words in those kinds are split into lists of 240, Jev picks favorites from each list in one call, and then the final word from the top three of each list. "None of these" keeps the descriptive name.
4. If another made thing already has that word, the new one gets its material in front ("bone knife").

### 5. World systems that collide

Each system is simple on its own. The interesting part is where they meet.

- **Fire:** fires spread to adjacent flammable, dry things, faster in wind and slower after rain. A campfire left burning next to a lean-to can burn it down. A forest fire clears land (good for planting later) and drives off animals.
- **Weather and seasons:** a year of 40 days, four seasons of ten. The sun's path swings with it, as at 52° north: a midsummer noon stands 61° up and the day lasts 16.5 hours, a midwinter one 15° and 7.5 hours, and the dark follows. Rain wets things, which puts out fires and stops fire-starting. Summer drought makes everything flammable.
- **Air:** every point of the island has its own air now, as it has light. The weather is the island's (the day's mean air at sea level inland, drawn smoothly between the seasons', a swing over the day that follows the sun and is widest under a clear sky, and a wind over the open sea that rises with cloud and storm); a place takes it through what the generator found there. It is colder with height, milder by a coast the sea air blows in over (the sea is warmer than the land in winter and cooler in summer), warmer on slopes the sun favours, and on still, clear nights the cold slides off the slopes into the hollows. Its wind is the sea's, broken by the ground upwind and the trees overhead, stronger on knolls and summits. People lose warmth by the wind chill (the air and the wind together), not the air alone, except inside walls. Frost freezes the lakes whatever the season, and a thaw breaks them up.
- **Climate:** the generator sums a year of weather: rain by season as the air rises over the hills and dries behind them; sunlight on every slope through each season's cloud, with the hills' shadows and the sky each place sees; each season's mean warmth from all of the above; snow, which lies where the days stay cold enough through the winter (inland and up high, not on the mild coasts) and shows on the map; and evaporation by Penman-Monteith from sun, warmth, wind and damp air. Soil water, peat and plant cover follow from those, never from a drawn zone.
- **Rock and soil:** the bedrock comes from two fields laid down with the uplift, hardness (which the rivers erode against, so hard rock stands as the ranges) and chemistry: mudstone, sandstone, limestone, granite and basalt, each with its permeability, the bases it weathers to, the sand and clay of its soil, the nourishment it releases, and how often its stones hold flint (or chert, quartz) and iron. The soil is that weathering, with river silt on the valley floors and sand on the shores; rain the year does not evaporate leaches it sour unless the rock keeps it sweet, cool wet ground keeps humus, and its fertility is the rock's or the silt's nourishment as far as acidity, depth and waterlogging allow. Heath takes the sour soils, grass thrives on the rich ones, and the soil's texture sets how much water it holds through a dry summer. Flint lies where the rock holds it (most in limestone), ore weathers out of bare ground over iron-bearing rock, clay where the ground is clayey. A burn's ash and the dung of animals and people feed the soil, and taking what grows draws it down; those changes fade over weeks, and plants grow faster on richer ground.
- **Land and water:** the island is uplift against erosion: streams cut in proportion to the water they carry, which is the rain that runs off rather than soaking in (more on the rainier heights, less off permeable rock), and slopes creep, each at the pace of its rock (hardness, and each kind's own erodibility and creep), so limestone and sandstone keep broad dry uplands and the contacts between rocks stand as scarps. Ice then scoured the big valleys into troughs over soft rock and left hard rock as sills, and moraine hummocks on their floors; the island's lakes lie behind the sills. The water the year leaves after the plants have drunk soaks into the rock as far as the rock lets it and the rest runs off; the groundwater moves through the rock at its own pace and comes out in springs, seeps and stream beds, which keeps some streams running all summer while those the rain alone feeds run dry. Streams meander across their floodplains, fan into deltas on flat coasts, run as wide and deep as their flow, and rise after rain. Running water can be drunk from; a dry bed cannot.
- **Plants:** every plant has a niche, a curve over each thing it answers to (summer warmth, winter cold, the soil's water through the season, waterlogging, acidity, fertility, light, wind, salt, soil depth); its fit at a place is the product of its curves, and the generator draws each plant by fit and vigour (the shade-casting broadleaves outcompete the light-hungry pioneers where both fit), trees in the open sky, shrubs in what the crowns leave, the low plants in the light that reaches the floor from spring into summer, more under bare spring branches than under pine. Nothing says where a plant grows. At runtime plants grow by the air's warmth, the soil's water now, the light and the soil's nourishment where they stand; berries regrow, trees shed seed and berries are carried by birds, and what lands where it fits may take root, so clearings fill in again. Trees ripen their nuts as the days draw in. Seeds are items: a planted berry may become a bush, a planted nut an oak, which is how farming can be discovered instead of scripted.
- **Animals:** a few species with simple needs (graze, drink, flee, breed). They go by the air and the day, not a calendar: grazers find food where grass grows and the snow leaves it, the cold burns what they have eaten, and young are born as the days draw out past eleven hours. Deer flee people; wolves hunt deer and, in hard cold or snow, people. Overhunting crashes a population; wolves follow deer; people follow both. Animals leave bones, hide, and meat, which spoil.
- **Decay:** food spoils in days unless it's dried, smoked, or salted. Tools wear out with use. Buildings weaken in weather and need repair. Things left on the ground rot or get carried off. Decay is what makes storage, preservation, and upkeep worth inventing.
- **Terrain change:** digging makes pits (traps, wells, clay), chopping makes clearings, paths form where agents walk often and make walking faster. Over time the map records where people live.
- **Disease:** eating toxic or rotten food, or living crowded with no clean water, can make people sick. Sickness spreads to people nearby. This makes wells, cooking, and herbal remedies matter, and it gives settlements a reason to have a healer.
- **Light:** every point of the island has a light level, as it has moisture: the sun's beam and the sky's glow, the moon and the stars (the same sky the play page draws), less cloud, less hills that hide the beam, less the crowns of the trees overhead, plus what fires and lit lamps throw (a campfire gives 60 lux at a meter; a lamp 12, about five for whoever holds it, enough to keep them out of the dark). Nothing is stored, so felling a wood or lighting a fire changes it at once. How bright a place looks (the log of its lux) sets what people do there. In the dark they see a fraction as far, walk and work slower and fumble at it, watch and witness only what they can see, and plan only around what they can see (their home, the water and any fire excepted), so nobody sets out to forage, explore, hunt or fetch materials; whoever is out after something when the dark falls gives it up where they stand, unless they are starving or freezing or a fire is near. They sleep deeper, wait out the night by the fire once rested, and a hungry wolf stalks a lone person who is out in the dark. A thick wood goes dark an hour before open ground does; seedlings and berry bushes in its shade do worse. Night is the sun more than six degrees under the horizon.

### 6. Consequences flow into the social layer

World events feed the same memory, bonds, and gossip the agents already have, so physical accidents become social stories.

- If someone's fire burns another person's hut, the owner gets a "destroyed my home" bond with whoever lit it, and gossip spreads it.
- A winter where one agent stored food and others didn't creates debts, begging, theft, or a first shared storehouse.
- A wolf attack that someone fought off creates "saved my life" and makes huddling together safer than living alone. That's the pressure that forms camps.
- Scarcity in one area pushes agents to migrate, which brings strangers into each other's territory.

### 7. Knowledge is observation, not labels

An agent learns laws by seeing them happen, not only by doing them. Watching lightning set a tree on fire teaches "hot plus flammable burns." Seeing a bush grow where berries rotted teaches that seeds grow. Many discoveries start as an accident someone noticed, the way many real ones did. Each agent keeps the laws they've seen, and the ones they believe but got wrong (a superstitious agent may decide the berries grew because they prayed). Wrong beliefs spread by gossip like true ones.

### 8. Guardrails

- **Budget:** at most a few Jev rulings per in-game hour. Most attempts hit a rule function or a cached law.
- **Stability:** every law is consistent once made, and property values stay within 0 to 1, so nothing snowballs into infinite food or infinitely sharp stone.
- **Replay:** the world seed, the law cache, and the event log are saved, so a run can be inspected afterward to see why something happened.
- **Watchability:** every new law, a new named compound, a fire that destroys something, a population crash, and a first illness are all major chronicle events, so the surprises show up where you'll see them.

### Generations and the land

- **Lifespans:** a year is 40 days. People are children under 1, adults to 5, then elders; old age starts killing after 6.5. A second collapse within a day and a half of the first is fatal.
- **Families:** sweethearts who both like each other, eat well, and share a home can conceive in the evening. Ten days later a child is born with a mix of their parents' traits plus a new one. Children walk at half speed, hit half as hard, carry less, and learn by watching twice as fast, so what a family knows passes down only if the young stay close.
- **Death:** a grave marks the spot, belongings fall to the ground, and homes are left empty for anyone to claim. Close friends and kin grieve. Knowledge that was never taught is gone. When the land is nearly empty, strangers wander in knowing nothing, and find the tools and homes of the dead.
- **Throwing and digging:** a heavy or sharp thing can be thrown at an animal from a distance, and it can miss. Digging makes a pit; a pit near water fills into a well; a pit covered with sticks or reeds is a hidden trap that catches animals, and people who don't know it's there.
- **Homes as stores:** food set down inside a home is kept there, where it still spoils. Others can sneak in and take it, and anyone who sees remembers.
- **Seasons that bite:** nothing grows in the cold, so bushes stop fruiting when the air does, trees drop long-keeping nuts as the days draw in, hard frost freezes the shallows so people and animals can walk on the ice, and a thaw drops whoever is standing on it into the water. Crowds with no well nearby get sick.
- **Fire without knowing how:** anything burning, like a tree struck by lightning, is a fire you can warm up by or take a flame from. Two very hard stones struck over dry tinder can throw a catching spark.
- **Drives and care:** a starving or freezing person skips deliberation and goes for food or warmth, or huddles against the nearest body. Anyone can choose to tend someone who has collapsed, warming and feeding them back to their feet, which tends to leave a lasting bond.
- **Aimed experiments:** besides open tinkering, people can set out to find a way to make shelter, fire, a better tool, or food. They still don't know how; the aim only narrows what they think to try.
- **Grudges cool:** once a day, dislike fades (slower for the vengeful, faster for the forgiving), and time spent near someone slowly breeds familiarity.

### Groups and norms

The step from a handful of people to a village. Nobody is assigned to a group, and nobody writes the rules. Groups are noticed from who lives near whom, and customs build up from what the group actually did the last time something like this happened, the same way Jev's rulings on combinations become the world's physics.

**Camps form on their own.** Once a day, code looks at who lives near whom. People whose homes are within 8 tiles of each other and who don't dislike each other (mutual affinity above 0.1) are linked, and each connected cluster of three or more is a camp. A camp keeps its identity from day to day by matching members, so it can grow, lose people, split when a feud cuts it in two, or merge with a neighbor. A new camp is a gold chronicle event. It starts with a place name from its founder and the nearest landmark ("Mara's camp by the lake"); after a season Jev picks a lasting name from the lexicon's place and landmark words, the same way things get named.

**Incidents.** Anything one person does that lands on another, seen by at least one member, is an incident: the actions people already have (take, steal, raid a home, attack, insult, lie, refuse food or help, give, share, tend, teach), plus side effects from the world (a fire someone lit burning a home, a hidden pit catching someone, a hunter taking the last deer). Code records its features, not a verdict:

```ts
type Incident = {
  id: string; t: number; act: string;            // "raid", "steal", "burned_home", "refused_food", "tended"...
  by: string; against?: string;
  features: {
    against_member: boolean; against_kin: boolean; against_child: boolean;
    value: number;          // how much it cost them: items taken, health lost, a home
    need: number;           // how desperate the doer was (hunger, cold)
    season: string; scarcity: number; // how hard times were for everyone
    repeat: number;         // how many times the doer has done this kind of thing before
    seenBy: string[];
  };
};
```

**Reactions become precedents.** After an incident, the camp reacts. The person hurt, or the leader if there is one, chooses a response with a Jev choice from the few things a group can do: let it go, scold, demand it back (the item or double), shun (no trade, sharing, or talk for a few days), or drive them out (they lose their place in the camp and can't keep a home inside it). Jev sees the incident, the people involved and their standing, and the camp's precedents for similar cases. The chosen response runs through existing mechanics, and the pair becomes a precedent:

```ts
type Precedent = {
  id: string; group: string; incident: Incident;
  response: "let_go" | "scold" | "repay" | "shun" | "drive_out";
  decidedBy: string; followed: string[]; defied: string[]; // who went along with it and who didn't
};
```

Similar cases lean on earlier ones: when Jev judges a new incident, its state includes the most similar precedents from this camp (same act, same kind of victim, similar need and value), so a camp that shunned the last hungry thief will probably shun the next one. Nothing forces that; a sympathetic leader or an unusual case can break from it, and that break is a new precedent.

**Customs are just patterns in precedents.** Code summarizes each camp's precedents by act and feature: "Taking from a neighbor's store: shunned 3 times, let go once." Those summaries go into each member's Jev state as "what happens around here," so people weigh a theft against how the camp has actually treated thieves. When a pattern is strong enough (the same response to the same kind of act at least three times with no exceptions), a member may put it into words at an evening fire. The sentence is built from the pattern ("Here, anyone who raids a neighbor's home is driven out"), and it becomes the camp's spoken custom, a gold event. Spoken customs travel through gossip and teaching, so newcomers learn them faster, and they can be contradicted by later precedents until they fade.

Different camps end up with different customs from different histories: one tolerates stealing from outsiders and exiles for stealing from kin; another lets the starving take food in winter and shuns hoarders instead.

**Leaders are whoever gets followed.** Everyone who reacts to a response either goes along with it (shuns when told to, returns the item) or defies it. Each person's standing is the share of their decisions that others followed, weighted by how many people were involved. Whoever's decisions keep getting followed ends up deciding more incidents, because people bring their grievances to them. That's a leader, with no title and no vote. A leader whose rulings start getting defied loses standing, and someone else's takes over. Their rise and fall are gold events.

**Shared store:** a member can set food or goods into a structure and treat it as the camp's (a new "share" action on place). Taking from it is fine; what counts as taking too much is up to the camp's precedents.

**Outsiders:** incidents against non-members are recorded too, and camps react to them or not. Whether a camp protects strangers is just another pattern in its precedents.

**UI:** a Groups tab (members with seals, whose decisions get followed, spoken customs, the precedent log with each incident and response, and the per-act patterns); a faint ink outline of each camp's area on the map; membership and standing in each person's ledger. Gold events for founding, spoken customs, being driven out, and changes in who leads. Debug: `api/groups`, trace system "group" for every clustering, incident, judgment, and follow or defy.

**What's still fixed in code:** the actions people can take and the five ways a group can respond. Which acts matter, how harshly they're treated, and who decides all come from what happens.

**Cost:** one Jev call per incident that someone saw, plus the reflections that already happen. Customs cost nothing; they're summaries.

### More materials

New raw materials, found in specific places so that where you live shapes what you can make, plus two physics rules (fire heat and hot working) that open a long path from stone to metal. Still no recipes: every step is a property meeting a rule.

| Material | Where | Properties | Why it matters |
| --- | --- | --- | --- |
| bark | strips off when a tree is struck with something sharp but not felled | fibrous, flexible, flammable, a little insulating and binding | cord without reeds, containers, roofing |
| resin | beads on stumps and damaged trees over a few days | flammable, sticky; melts into a strong binder when heated | glue for hafting; waterproofing baskets |
| flint | nodules inside boulders on rocky ground; comes out when a boulder is broken | very hard, shatters | knaps into a much sharper blade; sparks far better than plain stone |
| fat | part of every carcass | edible, very flammable, softens hide | lamps, leather, better fuel |
| charcoal | what wood becomes when it burns in a fire that's closed in and starved of air | light, very hot fuel | the only fuel hot enough for metal |
| ore | rare reddish stones on rocky ground, some inside boulders | heavy, hard, hidden metal content | metal |

**Fire has a heat level.** An open fire is 1.0. A fire ringed with stone is 1.3. A ringed fire burning charcoal is 2.0, and 2.5 with air blown in (a hide bag squeezed at it, which is its own thing to discover: something flexible and hollow). Heat changes happen only above a threshold:

- cook food: 0.8
- melt resin: 0.8
- fire clay: 1.2, so pots need at least a ringed hearth, not a campfire
- wood to charcoal: a log heated in a ringed fire that's also covered (placing more stones or clay over it) turns to charcoal instead of burning up
- smelt ore into a metal lump: 2.2
- soften metal for working: 1.5

**Hot working.** Anything hot and plastic can be shaped by striking it with something heavy and hard. Each blow at the fire raises the result's sharpness toward 1 and its toughness, by how heavy and hard the striker is. A metal lump hammered at a charcoal fire becomes a metal blade: sharper than flint and far tougher, so tools last much longer. Hammering cold metal only dents it.

**Other new rules:**
- melted resin counts as a binder of 0.95, better than cord, so glued tools wear more slowly
- a basket or bark container coated with melted resin becomes watertight (a container that holds water)
- rubbing fat into a hide, or holding a hide over a smoking fire, makes leather: tougher, more flexible, better clothing and bags
- fat in a hollow container with fiber in it burns slowly as a lamp: steady light and a little warmth, and a way to carry fire
- flint struck against a hard stone sparks three times as often as plain stone

**Why this adds emergence:** flint and ore only exist on rocky ground, and resin only near trees, so camps near different land end up with different tools, which gives trade and territory something to be about. The metal chain is five or six discoveries deep (ring a fire, cover it for charcoal, find ore, smelt, hot-hammer), so it only happens where knowledge is passed down across people and generations.

**UI:** glyphs for flint nodules, ore stones, resin on stumps, and the new items; fires tinted by heat (orange, yellow, white); a glowing hearth when charcoal is burning.

### Build order for these

1. Camps: clustering, identity across days, names, the Groups tab and map outline.
2. Incidents and judged responses, recorded as precedents.
3. Precedent summaries in Jev's state, similar-case lookup, spoken customs.
4. Following and defying, standing, leaders.
5. New materials and where they spawn: bark, resin, flint, fat, ore.
6. Fire heat levels and thresholds, charcoal.
7. Hot working and metal; resin glue, waterproofing, leather, lamps.

### Where the build differs from the plan above

- **Refusing food** needed a request to refuse, so there is a new social action: a hungry person can ask someone carrying food to share. Giving is a "give" incident, refusing is "refused_food". Asking for help (below) is the wider version, and turning someone away is "refused_help".
- **Who decides:** when a camp has a leader, the leader answers every incident they didn't commit. Without one it's the person hurt (a parent for a child), and otherwise the witness whose rulings have been followed most. Kindnesses are judged too, but a kindness that's let go stays out of the chronicle.
- **Following and defying are watched, not asked**, for three days after a ruling: under a shun or a driving out, anyone in the camp who is friendly with that person defies it and anyone who turns them away follows it, and at the end everyone who was around them and kept away counts as following. A scolded person who does the same thing again defies; after "let it go", a victim who takes revenge defies. For "make it right", the same Jev call that picks the response also answers whether the doer would comply. Standing counts each person's last 12 rulings; a leader needs at least 2 "followed squared over reactions" and 60% followed, keeps the role until they fall under 50% or someone clearly outdoes them.
- **Speaking a custom** needs an evening fire with another member nearby, or three members gathered together, so a camp without a fire can still put its ways into words. A spoken custom fades once it has been broken at least twice and more often than it has held.
- **Air** only adds heat through a ringed fire, and it comes from heating something while holding anything soft and hollow as a fan or bellows (a hide bag, but also a woven mat). A covered fire keeps a ringed fire's heat of 1.3; it only changes what wood does in it, and its smoke is what cures a hide into leather.
- **Hot working** runs up to 30 blows or until the edge reaches 0.95 sharpness; each blow closes the gap to 1 by 0.2 times the striker's weight times its hardness.
- **Tying depth** now counts only layers of binding, so a fired pot, smelted metal, or leather counts as a plain material and can be hafted or tied.
- **Deferred:** a resin-sealed basket is watertight (container 0.9) but nothing carries water yet.

### Grain, keeping food, bows and fiber crafts

Added after headless tech runs (scripts/tech.ts) showed worlds stalling at fire and shelter. Still no recipes: each step is a property meeting a rule.

| Material | Where | Properties | Why it matters |
| --- | --- | --- | --- |
| grain | stripped from grass while it ripens (the ripening cue), three at a time, leaving the tuft | hard little seeds, barely edible raw, keeps 40 days | winter food; sown, it comes up as grass |

- Grinding a small hard seed on something harder (a stone) crushes it to a meal; the meal dipped in water becomes dough; dough held over a fire bakes firm into bread, which keeps five days.
- Food held in the smoke of a covered fire (the kiln) dries into smoked food that keeps about eight times as long.
- A long, light, pointed shaft (a pointed stick) shot from a bow (a stick strung with cord) flies twice as far as a throw and hits far harder: deer become huntable without closing to arm's reach.
- Any soft sheet tied with cord closes into a bag, and that now includes a mat woven of reeds: a woven basket. Carrying a bag or basket lets someone carry more (ten times its container value on top of sixteen). A woven basket, loose enough to let water through, swept through water where fish swim scoops up one or two.
- Two or more soft sheets laced together with cord make a wrap warmer than any one of them (two hides: insulating 0.96).
- A home's store keeps food half as long again with a pot, a basket or a bag in it.

Behaviour that came out of the same runs, kept to what people learn and choose rather than rules that act for them:
- **Keeping a fire.** Nobody tends a fire by instinct. A fire close by that is burning low (less than about four hours left) offers "keep the fire from going out": anyone who has seen wood laid on a fire plans to lay more on; anyone who hasn't tries what they're holding on it, which is how feeding (and ringing a fire with stones) gets found out. Jev sees each fire as burning low, burning, or blazing.
- **Theories of failure.** Every time someone does what they believe works, the attempt is noted all told, against each condition they could see (rain, dark, freezing cold, a strong wind, no fish swimming close by for what's dipped in the water, and for what's done to the ground (planting, digging, watering) the spot itself: the ground, the shade of trees over it, dry ground, bushes and trees crowded round), and against the mix of all of them it was done in (dark and raining, dark and dry; in the shade on dry grassland in the rain). Every try stays in the record however long ago (beliefs.ts noteTry): a failure isn't forgotten because the thing has since worked, nor a success because it has since failed, and what changes their mind is the whole of what they've seen. (Until October 6 each try counted for a little less with every try after it, 0.95 of what it was, so a record was mostly the last twenty tries and what a way used to do was forgotten once it did otherwise. The operator's call was that people never forget a try, and learn instead that what they thought impossible isn't.) How long a way takes them still leans on their latest twenty or so tries, so one try that dragged on doesn't make it look slow for good (a 0.7/0.3 running average did: one slow try made the faster of two ways look slower for good, and people drifted off it). When something that has worked for them fails, a condition they were in is a suspect once it has failed them there more than once and done worse there than without it by more than chance would make it (a standard error of the difference, by their own counts: a few berries lost in the dark among many plantings aren't that), or when the failure itself points at it (the tinder too damp to catch) and it has done no better there; not one that a theory of theirs holding there already names (to someone who thinks it won't work in the rain unless the wind is up, a spark dying in the calm rain is the rain's). For the weather that's judged like for like (beliefs.ts apart): each mix of the weather with the condition in it against the same mix without it, pooled by how much each can tell (Mantel and Haenszel's weights), whatever the spot; a mix without it that's thin or has never come is made up from their record without the condition all told, as if it held four tries of that, so a condition never seen apart from another is suspected along with it until tries apart tell them which; and tries where a theory of theirs about something else holds are set aside (to someone who blames the rain, a spark dying in the rain at night says nothing about the dark). They settle on one, or on bad luck, or on no idea: Jev is shown their record in and out of each, and for the weather the like-for-like count ("in the dark it has worked 5 of 18 times for them like that, and 12 of 22 otherwise; when it was dark and dry it has worked 5 of 8 times, and 12 of 20 when it was light and dry"), and offline the guess leans on the same record, harder the worse and the more often, toward what the failure itself shows (damp wood), and toward bad luck for what usually works. Nothing tells them the cause: a seedling just withers. What they settle on is a theory ("they think it won't work in the rain", "in the shade of trees"), which what they see later can narrow to several conditions together or give an exception ("in the rain, unless a strong wind is blowing"), shown with the belief and the record it rests on, taught with it, and respected by the planner however badly they need it: freezing in the rain, someone who thinks fire won't light in it asks for help rather than rubbing wet sticks until they drop. (Letting the desperate try anyway was tried: a whole camp froze rubbing sticks in a winter rain.)
- **Theories get tested and revised.** Only a try where a theory holds can tell against it, never the record it was formed on. When it works where they thought it wouldn't, by their own hand or before their eyes, the theory goes only if it has worked there at least as often as it failed, counting this time (one they were told, with no failures of their own behind it, goes at once). Otherwise the failures it rests on aren't forgotten: it isn't impossible there after all, and they wonder what was different this time (beliefs.ts differed, brain.ts wonder): something that held now and never with those failures ("A strong wind was blowing this time, and never when it failed there"), or held with all of them and not now ("Not this time: every time it failed there, it was dark"). What they settle on narrows the theory to just where it fails ("it won't work in the rain, unless a strong wind is blowing"); if nothing, they know only that it works there now and then, and keep clear of it there as before unless they set out to find out more. A narrowed theory that then fails where its exception held as often as it has worked there goes back to what it was (beliefs.ts refuted). A theory also goes when over a few tries where it holds it has come to do about as well as where it doesn't, like for like, having worked there at least once ("came to think it makes no difference whether it's done in the dark"; a spark that has never once caught in the rain keeps the theory however rarely it catches anywhere). With nothing forgotten, a long record of sparks dying in the rain gives way, if the rain ever stopped mattering, only as the sparks that catch there come to outweigh it; giving a theory up leaves the record as it was. A plan made before the weather turned doesn't carry them into what they think won't work in it: they stop before starting, or partway once it comes on. When they aren't in trouble (not starving, freezing, hurt or spent), someone standing where a theory of theirs holds, and no other they hold about the weather, can set out to try it anyway, to see whether it really won't work (a spark that dies in the rain at night says nothing about the dark to someone who blames the rain): likelier the less the theory rests on (its tries where it holds by how much worse it has done there, over ten, so one resting on twenty failures is still tested now and then and one resting on a hundred isn't out of mind), twice as likely where it has worked before (it isn't impossible there, and they'd like to know when it does), and likelier the more curious, doubting or clever they are. A test is one try, and counts as one only while the theory holds: if the weather has passed by the time they strike, it's an ordinary try. Between ways of doing the same thing, the planner takes the cheapest it finds, weighing each by how long it takes over its odds: its record all told (or on that ground), marked down to its record in a condition they're in only where it has done worse there than chance would make it (beliefs.ts chance: a few unlucky tries in the dark don't make one way look worse than another), with some hope besides for what they've hardly tried, which is what gets it tried; a failure that only shows days later (a seed that never comes up) weighs as much as a long walk. So mistakes are made, and corrected, and what people do drifts toward what works best where and when they do it. scripts/theories.ts runs worlds and logs every attempt, theory and test; scripts/theory-report.ts scores them over time against the answer key scripts/truth.ts finds by trying every way on the island (see Testing that people learn; a theory of several parts is judged by what it names it won't work in): rain hurts lighting a fire by rubbing or striking; crowding, shade and rocky ground hurt planting and rocky ground digging; the dark and the wind hurt none of them.
- **Results that show later.** Some things only show what they did days on: a seed pushed into the ground. Done, it counts as tried and nothing more; they're waiting to see (the inspector lists it, and Jev sees it), and it counts as having worked, under the conditions it was done in, when it comes up, or against them if it withers. The first one that comes up teaches them it takes days ("A berry pushed into the ground grows into a bush, about 3 days later"), the law is found then, and from then on planting is something they can plan. It used to be scored the moment the seed went in, as a failure because no bush appeared, and people blamed the rain or the dark for it.
- **Plants live on water, light and ground, not spacing.** A seed, sown by hand or by birds and trees, goes into any soil nothing stands on (a trunk, a bush's stems, a stone, a wall), right beside a bush or under a tree. A seedling then lives on its spot: its niche (the light the crowns leave it, the soil and its nourishment, the same that decides where seed takes root), water, its shallow roots wanting the soil moister than a grown plant does, and its share of both, grown plants within a couple of meters taking theirs, the closer and the bigger the more. Short of them it wilts and dies, and its planter only sees that it withered. Berries planted in summer came up 28 of 30 on grassland, 23 on scrub, 20 on the forest floor, 14 in marsh, 11 on sand, 8 on grass with outcrops and none on bare rock; planted in winter they lie dormant until spring where the ground suits them.
- **Knowing ground.** Planting, digging and watering are noted against the spot they were done on (where the seed went in, not where they stood), so people come to think berries won't come up on sand or in the shade, or that a pit can't be dug on bare rock (digging is stopped by thin soil, roots, water or something standing there, and says which). To the planner every kind of ground within a hundred meters is a way of its own, weighed by how it has gone for them there, untried ground as hopeful as anything little tried: someone whose berries come up only now and then on the forest floor tries the grassland over the rise, and goes back if it does worse. They walk to the nearest spot of it clear of anything else about a spot they've come to blame (shade, dry ground, crowding), put the seed where none of that holds if any spot within reach will do, and plant nowhere they think it won't grow, unless they're out to test just that.
- **Watering.** A vessel that holds water (a woven basket doesn't) comes up full when dipped, and the water can be poured over a young plant or out on the ground. The ground round a watered seedling stays wet for a day or two, which keeps it alive and growing in dry spells; whoever watered it learns that when it comes up ("Pouring a clay bowl of water over a young plant helps it grow"). A seedling of theirs wilting nearby offers "see to the young plants": water it if they know how, or go over and try what they're holding.
- **Laying wood by.** Someone who knows wood feeds a fire and sits by one as it burns down to nothing, with no wood at hand, resolves to have wood by them before night; from then on, late in the day with a fire close by, they can set out to gather wood to keep it going through the night.
- **Asking for help.** A need someone keeps failing to meet (two goals for it in a row that come to nothing, or no way at all to warm up) offers "ask someone for help". The one asked can give food, bring them to a fire, take them in to live, or show them how they manage it themselves; turning them away is an incident the camp judges.
- **Shelters that grow and house many.** A shelter sleeps a number of people that grows with what goes into it: a lean-to two at most, a round hut four, and a framed, walled lodge as many as it is drawn out for (three, and one more for every eight pieces past sixteen); past six it's a longhouse. Its footprint grows with it, and the map draws it longer, with a door for every eight meters or so. Several people can call one shelter home: someone fond of another (or kin, or sweet on them) can ask to move in where there's room, and someone asked for help can take them in. Everyone living there can add to it and store food in it, and a couple sharing a home can start a family there. Building stops when it no longer pays: two loads in a row that made it neither better (a higher kind of shelter, or clearly sturdier, warmer or better at keeping the rain off) nor room for someone who needed it, unless it's crowded or needs mending.
- **Better shelters are found, not given.** Sticks and grass lean into a lean-to that sleeps two and is down after a few days of rain or one storm; no amount more of them makes a hut. Weather tells on a flimsy shelter far more than a sturdy one (wear goes with the square of how far it falls short of solid), so walls of stone or logs stand for a season. Someone cold in the shelter they have can set out to make it warmer or sturdier: they gather an armful of whatever seems fit to build with (long things, soft cover, warm skins, and solid heavy things to wall in), go home, and try it on the shelter there. Stones stacked into a lean-to make it sturdier, and a dozen of them with its frame make it a walled lodge, so what they learn there carries them toward a hut, a lodge and a longhouse.
- **The offline brain** is a stand-in for Jev's judgment, and now weighs what Jev would: traits pull toward social acts (a loner keeps to themselves, the greedy steal, the hot-tempered pick fights), acts against someone need a grudge (dislike, and remembered wrongs tempered by fondness), replies lean on how the one answering feels about the asker, and reflections follow what happened (a gift leaves "gave me food", a theft "stole from me"). Before this, offline people kept away from their own sweethearts at random, and ran while doing it; now they walk away from someone they dislike or fear, and the status says why. Cold, the ways to get warm outweigh everything else more the colder they get (offline people used to go rabbit hunting, trading and quarrelling while they froze).
- Walls and a roof keep the cold and the rain off whoever is inside them, not only their owner.
- Tinder can be dry grass, fern or a dead bush's twigs at your feet; rain soaks any rubbing within the hour.
- A home more than half a day's walk away (150 m) doesn't count for sleeping or warming up; a new shelter beyond that becomes home.
- Someone setting out to find a way to make something first gathers a couple of whatever plain stuff lies about, not knowing yet what will serve.
- New goals: try things by a fire (hold them in it, set them in and around it), and lay by food that keeps (grain, nuts) at home. Teaching favours what has worked most for the teacher and what the learner is short of (fire and roofs for the cold, food for the hungry).

### Seeing inside the world

Everything the simulation decides is recorded, so any surprise can be traced back to its cause.

- **Trace log:** every plan, interrupt, physics result (with the force, focus, damage, chance, and heat numbers), belief change, fire spread, weather change, and animal attack goes into an in-memory ring buffer and `data/logs/trace.jsonl`.
- **Jev log:** every Jev call, with its full state, questions, answers, latency, and token count, goes into a ring buffer and `data/logs/jev.jsonl`.
- **Debug API:** `api/debug/stats` (populations, weather, per-system tick cost, counters, Jev cost), `api/debug/jev`, `api/debug/trace` (filter by system, agent, kind), `api/debug/laws` (each law and who believes it, including mistaken versions), `api/debug/kinds`, `api/debug/rulings`, `api/debug/state` (the whole world).
- **Debug page:** `debug.html` shows all of the above in the browser.
- **History page:** `history.html` (linked from the Chronicle) charts every day of the world in rows: technology, survival, social, conflict, camps, life, and the wild. Bars show how much happened, seals mark milestones (events logged with a short `tag`), and tapping a day lists everything from it. Data comes from `api/history`.
- **CLI:** `bun scripts/inspect.ts stats|agent ID|jev|trace SYS AGENT|laws|kinds|events` reads the live server; `NOMADS_BRAIN=random bun scripts/run.ts --ticks N --seed S` runs a whole world offline without Jev and prints every law, invention, and belief.

### Testing that people learn

Whether people come to what's true, and how fast, is tested rather than read off a run, and every change to the sim is held to the last good build. It all runs offline unless asked.

- **Runs replay.** Headless runs replace `Math.random` with one stream seeded from the island (scripts/seeded.ts), so with the offline brain a seed runs the same world every time: a strange run can be looked at again, and a build and its baseline on the same seed share their draws. Jev's answers are the one thing left to chance. Whole worlds didn't replay until October 7: two lists people pick from at random (what to gather for an aimed experiment, and the hundred things tried when tinkering) were put in order by sorting with a random comparator, and how many times the engine's sort compares, and which pairs, changes once the JIT has optimized a sort that runs often, which rides on background compiling; about one run in four of island 2 parted ways from the rest on day 38. They're shuffled with world.ts shuffle now, one draw a place.
- **The world writes the answer key.** scripts/truth.ts tries every way of doing things that people used in a set of runs on the island itself, through a year of its weather, ice and soil: a stand-in does it again and again at random spots and hours, with the rain and the wind set at random, and the key records how often it works and how long it takes in each condition and out of it, and whether the condition truly hurts. Dark and cold, which come together at night and in winter, are each judged where the other doesn't hold. Planting is tried the same way and left to come up or wither. Nothing about what hurts what is written down, so a change to the physics changes the key.
- **One currency.** scripts/theory-report.ts scores runs against the key: tries made where they can't work (tests aside), true and false theories held, theories formed again after being dropped (churn), and choices in expected time, a try's ticks over its odds, which is what the planner weighs: the ticks lost to a slower way someone knew (choice regret) and to a faster way the world allows (discovery regret). A way that would take more than a day of trying counts as a day, or one choice of a way that never works there swamps the rest.
- **Probes.** scripts/probes.ts stages small worlds where the truth is set, so the best anyone could do is known: six people on open ground in summer, wanting a fire and holding stones and tinder, every fire cleared away as it catches, the weather set by the hour, and only lighting a fire, resting, putting a theory to the test (and in one, teaching and talking) to weigh. *choose*: two ways to a fire, one truly faster. *blame*: sparks die in one kind of weather. *confounded*: the rain falls mostly at night and only one of the two kills sparks, which the failure doesn't say. *recover*: what kills sparks changes halfway. *spread*: some know the true cause, some were told a false one, and some don't know how to make a fire. Each also runs flipped (plain stone sparks better than flint; the wind or the dark kills sparks instead of the rain; the change the other way round), through src/sim/rules.ts, the one place the physics can be set otherwise and which the live world never touches. A learner with the answer written in passes one and fails the other. The second round added five: *superstition*: nothing in the weather matters, but sparks die now and then by bad luck; *two*: rain and wind both kill sparks; *weak*: the rain only halves the sparks that catch, and the world doesn't say so (RULES.leak); *rare*: what kills sparks comes one hour in twelve; and *seed*, the first planting probe: each person on a plot of their own with an oak's shade over part of it and a bush crowding another, a berry every four hours (or once a day, *sparse*, nearer the one to a dozen outcomes a planter in a whole world sees in sixty days, and *poor*, once a day where only four in ten come up elsewhere), seedlings that never come up in the shade (or among bushes) and seven in ten elsewhere, shown two days later and silently (hooks.seedling), and each planter turning a new way with each berry so seed goes in all round them; it runs ten days. The third round added *hearsay* (two planters start out blaming the spot seedlings never come up in, the other four know how to plant but not that, they may talk and teach, and seed comes once a day: does it pass among them?) and *unlearn* (every planter starts out sure seedlings won't come up in the rain, which is false, while shade withers them: is the false theory ever let go? densely, and *sparse*, once a day). Every probe of a cause also reports what the evidence would support: *evident*, the share of people whose own tries (all they saw the outcome of, since the cause last changed) show the true cause doing worse than its absence beyond chance, as a statistician holding every one of their tries would judge it (two proportions, one-sided at 95%; not judged, since it moves with where people choose to try); and *caught*, of those, the share who came to blame it, with a claim that more than three in four do. So a probe can say whether a cause nobody blames could have been learned from what they saw. The fourth round (probes 3) took the luck out of the world (physics.ts: nothing anyone tries fails by chance), so a try fails just where the probe's cause holds: *superstition* went with the luck, and *weak* became *except*, sparks dying in the rain unless the wind is up (flipped, the other way round), which to anyone who doesn't see the exception only halves them; RULES.quench entries now join conditions with "+" and mark a lack with "!", and RULES.leak is gone. Seedlings come up wherever the cause doesn't hold, so *poor* became *two*, the shade and crowding both withering them. Confounded, rare, recover and except run ten days, the planting probes twenty. Every probe of a cause also holds what people's theories would have them do against the truth, over the probe's own hours (and, planting, every spot of each plot in them), each as often as it came: *acc*, the share where they'd do it just where it would work; *needless*, where they'd hold back though it would work; *blind*, where they'd go ahead though it can't; at the midpoint (*accMid*, *needlessMid*) and the end, with claims that theories tend toward the truth (acc no worse at the end than the midpoint, above nine in ten by the end, needless no higher at the end). Right, wrong, *exact*, caught and formed are read the same way, through beliefs.ts ruledOut, so a theory is judged by where it holds, whatever its shape. *recover* asks that those who blamed the old cause try it there again and see it work (*retried*), no longer that they let it go.
- **The gate.** `bun scripts/evals.ts probes` runs every probe on ten seeds and compares each number with the baseline seed by seed. One worse by more than its tolerance, with the whole 99% interval of the change on the worse side, fails the build, and so does losing a claim the baseline met (what learning should show, such as "most come to blame the true cause", held over the seeds with a 95% interval). A passing build that improves something becomes the baseline, so the bar only rises. Each tier run is a file in evals/, committed with the code it judged; `bun scripts/evals.ts trend` charts them.
- **Whole worlds, between a floor and a ceiling.** `bun scripts/evals.ts worlds` runs whole worlds with learning as it is, with it off (nobody ever forms a theory) and known from the start (everyone holds just the key's true theories for each way they learn; rules.ts RULES.learning), and reports how much of the gap from off to known the real people close, wherever the two differ by more than a number's tolerance. Builds are compared on one answer key per island (tier 4): the key is worked out once from both builds' runs, every way either build's people used tried on each island, and both are scored on it, the baseline's kept runs rescored and its known-from-the-start runs rerun with it; without the baseline's runs on the machine it says so loudly and falls back to the ledger's numbers. Plantings and waterings into a condition that truly hurts count as wasted, judged when they went in; true theories count, for the real people and for the ceiling alike, only about a way someone on the island did in that condition at least twice (the old count is kept as rightAll, unjudged); the key judges what's in a spot like for like, so crowding takes no blame for shade; and a theory nobody dropped ends when its holder dies. A harder world moves the floor and the ceiling with it, so this tells a worse learner from a harder world. It takes about 35 minutes for six islands of 60 days on the operator's Mac. scripts/nightly.sh runs it and `bun scripts/evals.ts live` (the live world's own trace, scored the same way) as a nightly job for the host, from a checkout of its own: pulling in the live service's checkout would change the live world.
- **Speed, with nothing else changed.** scripts/bench.ts times making an island, a fire probe, a planting probe and 20 days of a whole world, each ending in a checksum of what came of it; a change made only for speed leaves every checksum as it was, and then the gate's numbers the same run for run. The first pass (October 7) found the planting probes spending over a quarter of their time working out the length of the day with trig for every blade of grass a forager looked over, and about as much again searching 800 m of grass for grain out of season, the trees for resin none beaded and the whole coast for the nearest water; and whole worlds walking the island's 1,400 loose ore stones four times a tick and working out the canopy over every seedling afresh, twice a tick. Each search still looks at the same tiles in the same order (looking is what makes a tile's things, and the order of what's made moves every later draw); it only skips the things on them that can't be what it's after. A planting probe now takes 19 s instead of 91, a fire probe 2.5 instead of 15, and 60 days of a whole world 43 s instead of 96. Growing an island takes 9 s, more than many a probe's own ticks now, so the gate runs the probes on one island a few to a process (scripts/probes.ts --batch), every run starting from the world's rules and what a module keeps about a world kept per world (world.ts perWorld); the gate on twenty seeds took 36 minutes instead of about two hours.
- **The cheap brain against the real one.** Every gate runs on the offline brain. `bun scripts/evals.ts probes --brain jev` runs the probes with Jev instead: a probe asks Jev about 90 times per person per day, about 180,000 tokens, so a full tier of ten probes is millions of tokens even at two seeds, three people and a day; it runs on demand, never on a schedule. `bun scripts/evals.ts proxy` sets the two side by side for a build run both ways, and says whether they moved the same way between two such builds.
- **What the first probes found** (the offline brain, ten seeds of five days with six people). People came to blame what truly kills their sparks within a third of a day and wasted half as many tries for it, as well in the flipped world as in this one; a false cause some were told died out, the true one spread to everyone, and those who didn't know how learned it. Three things they did badly. Where the rain falls mostly at night and the failure doesn't say why, everyone came to blame the true cause, but 38 to 53% also blamed the one that comes with it and kept blaming it, since all told it does worse too. When what kills sparks changed, 42 to 48% still blamed the old cause at the end and only 57 to 67% found the new one: a record of failures there outweighed the few tries that showed it no longer mattered. And between two ways to a fire, once each person kept both in hand (probes 2), only 71% of late tries took the faster way (81% flipped): one try that dragged on had made it look slow for good. At 3bda10e, 15 of the 24 claims held.
- **What the first whole worlds found** (six islands, 60 days, the offline brain, before the fixes). In the last third of their days people held about 0.18 true theories a person-day, where knowing from the start would give them 4.7: they found about 3% of what the island could teach them, nearly all of it about rain and fire, planting and digging. No false theories lasted, the answer key could judge 98% of what they did, and the share of tries going to waste didn't fall from the first third to the last. The worlds are small and few people are left trying things late, so these numbers move a lot from island to island; the nightly trend is what will say whether a change helps.
- **The learning fixes, and the bar they were held to.** The bar was set before any fix: every claim of every probe, as it is and flipped, holds over ten seeds with a 95% interval, nothing is worse than the baseline by more than its tolerance, and whole worlds show no regression. The claims were raised to meet it (late tries take the faster way more than 85% of the time and more often than in their first five; where the rain falls mostly at night more than 85% blame the true cause and fewer than one in four the one that comes with it; when the cause changes, fewer than three in ten still blame the old one and at least two in three find the new one). The fixes (records where the latest tries count most, blame judged like for like, one theory tested at a time, a way marked down only where it has truly done worse) took it to 24 of 24 at 8272cc8 with nothing worse: late tries take the faster way 100% of the time (99% flipped) and the time lost per try to the slower way fell from about 1.2 ticks to 0.15; where the rain falls mostly at night 98% blame the true cause (93% flipped) and 8% the one that comes with it (7%); when the cause changes, 3 to 5% keep the old one and everyone finds the new one. The gate caught the first try at it: strictly like for like, people who had barely seen the rain apart from the dark had too little to blame either, and the claim that nearly everyone blames the true cause fell to 90 and 92%, until a thin mix borrowed from the record all told. Whole worlds passed too, but their numbers said little either way (see what the second round found): the fall in tries made where they can't work, 9% to 1% of the last third, is one island whose people had all died by day 31 before; the ticks lost per try to a slower way, 0.32 to 0.12, comes from each build working out its own answer key, and scored under one key it didn't change; and true theories held a person-day fell from 0.18 to 0.06, all of it that same island, now alive to day 60 and holding none.
- **The gate catches what matters.** A bug planted on purpose, offering tests only where a theory doesn't apply, failed it: in the flipped blame probe people came to blame causes that don't matter (none before, 15% with it), and recovering lost its claim that most find the new cause. A change planted the same way, letting a theory fade by its record only after 30 tries there instead of 3, passed: the probes' people let theories go by seeing them work, not by their record, and it helped the flipped recover probe (57% to 73% found the new cause), likely because an old record of the rain doing no harm was making the true new theory fade as soon as it formed.
- **The first look at Jev** (one seed, two days, three people, about 12 million tokens): Jev's people blamed the bystander in the confounded probe none of the time, where the offline brain's did a third of the time. One seed is too few to say more than that the offline brain may make people look worse at telling causes apart than Jev does. A second look just before the fixes (two days, three people, until TypeSafe's credits ran out on the second seed) found Jev's people drifting off the faster way too, 41% of late tries against 80% of their first five (51% against 87% flipped), so that fault looks like the rules', not the offline brain's; the look after the fixes waits on credits.
- **What the second round found** (October 5: the five new probes on ten seeds, blame, confounded, recover, superstition and two over fifteen days, every probe with three people instead of six, whole-world records replayed through the rules before and after the fixes, and a code review). What holds: two true causes are both blamed by everyone; a cause that comes one hour in twelve, by 98%; explaining away never kept anyone from the second true cause; over fifteen days blame, confounded, recover and two keep every claim; and no number in the rules goes wrong (NaN or infinity) in 3,000 fuzzed histories. What the first fixes broke: they fit what the fire probes test (a try every few minutes, causes that kill every spark) and hurt what they don't. In whole worlds 97.6% of what an island can teach is about the spot where something is planted or dug, where a planter sees one to a dozen outcomes in sixty days, days late, and a withered seedling says nothing of why. There (1) a spot's record fades with every try of the way (beliefs.ts noteTry), so a rare spot is almost never blamed (shade in 1 planting in 20 at a 30% base rate: suspected in 12 of 200 simulated histories, against all 200 under the old rules), a blamed one goes on one lucky seedling after 20 to 40 plantings elsewhere, and ground given up on regains full hope after 60 to 90; (2) one catch in a mix of weather barely tried (sim.ts judged, likeNow), or watching anyone succeed there (beliefs.ts watchers, which has no 'as often as not' guard at all), drops a true theory about a cause that only lowers the odds, and rethink then erases the record, so the rain that halves the sparks is blamed by 7% (the wind, 23%), its theory formed 31 times and dropped 29 by watching in one run; (3) on the same evidence the weather is blamed more readily than the ground: a rounding error lets one faded failure pass as more than one (1.0000000000000002 > 1 in worseIn), and four tries borrowed at a one-of-one rate make one success look like five (THIN in apart, with unsmoothed rates), so whole worlds formed theories like 'berries won't come up in the rain' (3.8 expected on the same records, against 0.7 under the old rules), and such a theory seals itself, since nobody plants in weather they blame and a planting can't be watched coming up. Also: dropping a theory about the dark erases the record the rain theory rests on (rethink); an old save loses its weather record on its first try after loading, as the first noteTry starts b.mix from nothing; a taught way looks certain (chance 1.0) until first tried; and a theory about weather that only ever comes with another blamed one can never be tested. Learning leans on watching others: with three people instead of six, 25% still blame a cause that stopped mattering (8% flipped) and 17 to 25% blame something when nothing matters. And superstition grows with time: over fifteen days 36% come to blame something that doesn't matter (13% over five), much of it new weather, like the first frosts, blamed when it first comes. The planting probe shows the same split: with a berry every four hours everyone comes to blame the shade (or the bushes) in about three days; with one a day, 67% within eight; with one a day where only four in ten come up elsewhere, 28%, while 35% blame something else, 23% the weather, so there the claim that more blame the true cause than anything else is open, as are the weak probe's.
- **What the tests got wrong** (fixed in tier 4, above, except the test filter, which the napkin warns of). Each build worked out its own answer key, so the whole-world tier compared builds on different keys: island 5 ran exactly the same before and after the fixes, and its regret went from 0.71 to 0.11 (and on one key, it scores the same in both). Plantings into conditions that hurt (51 of 112, against 19 of 127 knowing from the start) never counted as wasted, so the biggest waste in whole worlds was invisible. Nearly half the ceiling (46% of the gap) was theories nobody on the island had the evidence for (a way never done there, or never in that condition); counting only what someone could have seen, the ceiling falls from 4.66 true theories a person-day to 1.74. The key's 'crowding hurts planting' was largely the shade, since truth.ts judged spots all told and put half its ground tries beside a tree or bush; judged like for like, crowding no longer hurts grain, is unclear for berries on island 3, and still hurts them, less, on island 5. A theory's life in a report ran past its holder's death (theory-report.ts). And a bare test filter (bun test garden.test.ts) also runs the copies of it in data/evals/snap.
- **The third round** (October 6). Its bar, set before any change: no regression and no lost claim against the last good build; every probe's caught claim (of the people whose own tries show the cause worse beyond chance, more than three in four come to blame it); weak's and seed/poor's 'only', and seed/poor's weather and waste claims; 'most' wherever the evidence's own 95% lower bound is above a half; superstition under one in four over fifteen days; recover's people letting go with three people instead of six; a unit test for each fix that fails without it; and whole worlds no worse on one shared key. First the tests got sharper: the evidence metrics (*evident*, *caught*), the whole-world tier 4, and the hearsay and unlearn probes, which showed the weak probe's trouble was the rules (more than half its people had the evidence, 13% and 26% of them blamed the cause) and seed/poor's was thin evidence (12%). What landed (b888d6e, e1f2312), and passed the gate with nothing worse, in the probes and in whole worlds on one shared key against 7b8698c (true theories a person-day 0.00 to 0.10, within chance): worseIn's tolerance; rethink keeping the record of a mix that holds weather still blamed; an old save's mixes seeded from its counts where they hold some weather; a taught way looking untried until tried; a hint still counting when the failed try is set aside; and tests offered to the theory resting on least among those that can be acted on. What didn't: five designs over four attempts, none meeting the bar. The best (D2) lets a condition's record fade only with tries in it, against a record without it kept the same way, holds about fifty tries instead of twenty, lets a theory go on its record only after a try there comes off, counts tries watched as one's own, detects a change by a running likelihood ratio (log 20) that forgets the old record, and sets a stricter bar to form a theory again once given up, easing as the record renews (docs/research/learning-round3 keeps it, D2b and the design before it, D1c, as patches against e1f2312). It took weak's caught from 0.16 to 0.70 and its right from 0.08 to 0.47, kept recover's let-go with three people, and kept false theories near the baseline, but regressed four lines (seed/flipped's weather blame, seed/sparse's caught on one seed, unlearn/flipped's kept 0 to 0.20), left weak's caught short of 0.75, and let 15-day superstition reach 0.25; a stricter re-forming bar (D2b) holds 15-day superstition (0.11 and 0.14) and drops weak's caught to 0.46 and 0.64. Why: on a record of about fifty tries, a cause that halves the odds at a one-in-four base rate shows about 1.4 standard errors, while noise looked at after every try crosses one often, and a theory that is all or nothing can't hold both; any stricter bar on the first theory costs a day of 'formed' (first theories form on two or three failures) and starves sparse planting. The next step is in the representation, theories of how much worse rather than never, not another threshold. Found on the way: a false theory about weather that never comes while one plants can never be tested (unlearn/flipped seed 8); a planter's few chances can all go to bad luck (seed/sparse seed 4, three people with the evidence forming nothing); theories don't pass among people who already know the way (hearsay: 20% and 10%); frost doesn't change a strike's odds (106 of 300 in frost against 110 of 300 in mild air), so cold blamed in long runs is superstition; and Jev still has no credits (402).
- **The fourth round** (October 6 and 7). The operator's calls: no luck in whether a try comes off; people never forget a try; a success where they thought it impossible tells them it isn't, and they may look for why or keep clear; and people curious enough to keep trying what they don't fully understand, so that theories tend toward the truth over time. Its bar, set first: no dice decide success (a test per converted verb) and the tech chain still climbs; on every probe of a cause, acc no worse at the end than at the midpoint, above nine in ten by the end, and needless no higher; records whole and old saves loading, a theory that has worked once where it held kept with its record, and in except most ruling it out just where it fails; in recover nearly all who blamed the old cause trying it there again, and theory tests carried out in whole worlds; and nothing worse on the probes, in whole worlds or in the unit tests. Physics without luck alone, with the old learning rules (the probes 3 baseline, b5a5be1), already brought every fire probe but except, and every planting probe but seed/two and hearsay, to everyone right and acc 1.00: with nothing but the cause to fail on, blaming it is easy. A strike now takes the same blows every time, so every probe try ran across the hour's turn of the weather and was decided in other weather than it ended in; a theory that rules out the weather now stops a try partway, as it stops one starting. Then three steps, each through the full gate in its own worktree against that baseline. Never forgetting alone changed almost nothing (the old rules still dropped a theory on a success like for like, and watching still wiped it). A success where they thought it impossible (theories of several conditions and exceptions; beliefs.ts differed and refuted, brain.ts wonder) passed, taking except from right 0.48 and 0.45, exact 0 and acc 0.83 and 0.81 to right 1.00 and 0.95, exact 1.00 and 0.95, acc 1.00, acc already 0.99 at the midpoint. Curiosity's first form also ended a test whose weather had passed, which took away the only fires anyone lit at night in two/flipped (stale tests had been lighting them), so nobody found that the dark kills sparks (right 1.00 to 0.63); such a test now carries on as an ordinary try. The final rules, on twenty seeds: except right and exact 1.00 and 0.99, acc 1.00 both ways at the end (0.98 and 1.00 at the midpoint); seed/two exact 0.77 to 0.93 and acc 0.93 to 0.98; recover's people nearly all try the old cause again and see it work (retried 1.00 and 0.99) and find the new one as fast, but keep the old one as a theory that it works there only now and then (kept 0.79 and 0.71, acc 0.83 and 0.85, neither judged: that is what never forgetting means); everything else as it was. At ten seeds hearsay lost two claims, each on one person (caught 0.92 against 1.00; acc above nine in ten flipped, 0.92 both); at twenty seeds the build before curiosity and the final one hold the same claims there, and the final build passes the gate on twenty seeds (nothing worse, no claim lost) and is the new baseline. The tech chain still climbs (21, 20 and 25 milestones on seeds 1 to 3, against 21, 20 and 19 with the physics alone). Whole worlds on one shared key, twelve islands of sixty days: no number worse beyond its 99% interval, but every one leaning worse (worked 0.97 against 0.98; wasted in the last third 0.12 against 0.09; true theories 0.21 a person-day against 0.29, of a ceiling of 1.36), and the claim that waste falls from the first third to the last no longer holds, so the bar's no-worse-in-whole-worlds is not met. Part of that waste is curiosity: a planting made as a test counts as waste in whole worlds, since by the time it comes up nobody's test is on (5 such plantings against 2). Also not met: hearsay/real's acc above nine in ten (0.81 before and after: its planters wander off their plots to talk, nobody there plants in the shade, and talk doesn't carry theories), and tests carried out in whole worlds (chosen 17 times on six islands against 10, carried out while the theory held about 4: most rain tests lose the rain while they fetch tinder).

### Build order

1. Materials with properties, toughness, integrity, and what they break into, plus the basic verbs and the physics rules (strike damage, recoil, friction, heat, joining). Swap GOAP's fixed effects for per-agent beliefs about outcomes. Check that the current 19 recipes still come out as things agents can figure out, without being written down anywhere.
2. Jev rulings for combinations the rules don't cover, with the law cache and template names.
3. Fire spread, weather, and seasons.
4. Spoilage and tool wear.
5. Plants spreading by seed, then animals with a simple predator and prey loop.
6. Observation learning and wrong beliefs.
7. Disease.

## Skills (111)

Each skill is XP with a level from 0 to 10. A higher level means faster actions, better yields, and access to new recipes. Skills unlock in order, so you can't learn weaponsmithing before smithing.

### Survival
- Foraging: find edible plants, nuts, berries
- Hunting: kill game for meat and hides
- Trapping: set snares for small game
- Fishing: catch fish with lines, spears, nets
- Tracking: follow animal or human trails
- Firemaking: start and keep fires going
- Shelter building: lean-tos, huts, tents
- Navigation: find your way by landmark and star
- Swimming: cross rivers, escape floods
- Climbing: cliffs, trees, walls

### Gathering and raw materials
- Woodcutting: fell trees for logs
- Mining: dig ore and gems
- Quarrying: cut building stone
- Charcoal burning: make fuel for forges
- Skinning: take hides from carcasses
- Herb gathering: collect medicinal plants
- Clay digging: gather clay for pottery and brick
- Salt making: evaporate brine for preservation
- Resin tapping: pitch for waterproofing and glue
- Flax processing: turn plants into fiber

### Farming and animals
- Farming: plant, tend, harvest crops
- Animal husbandry: raise and breed livestock
- Shepherding: herd and guard flocks
- Beekeeping: honey and wax
- Orcharding: fruit trees and grafting
- Milling: grind grain into flour
- Butchery: break carcasses into cuts
- Dairying: milk, butter, cheese
- Horse handling: break, train, and care for horses
- Beast taming: tame wild or magical creatures

### Crafting
- Carpentry: furniture, frames, tools
- Blacksmithing: iron tools and fittings
- Weaponsmithing: swords, axes, spearheads
- Armorsmithing: mail, plate, helms
- Fletching: arrows and bolts
- Bowyery: bows and crossbows
- Leatherworking: straps, armor, bags
- Tailoring: clothing and cloaks
- Weaving: cloth from thread
- Spinning: thread from fiber
- Dyeing: colored cloth for status and trade
- Pottery: jars, bowls, storage
- Cooperage: barrels and casks
- Wheelwrighting: carts and wagons
- Glassblowing: vessels and windows
- Jewelcrafting: rings, amulets, cut gems
- Cobbling: shoes and boots
- Ropemaking: rope and nets
- Candlemaking: light from tallow and wax
- Tinkering: locks, gears, small mechanisms

### Building
- Masonry: stone walls and foundations
- Bricklaying: fired brick buildings
- Thatching: roofs from reed and straw
- Architecture: plan large or multi-part buildings
- Well digging: reliable water
- Bridge building: cross rivers and ravines
- Road building: faster travel between settlements
- Fortification: palisades, walls, towers
- Shipwrighting: boats and ships
- Engineering: mills, cranes, siege engines

### Food and drink
- Cooking: meals that feed more and heal
- Baking: bread and pies
- Brewing: ale and mead
- Winemaking: wine from grapes and fruit
- Preserving: smoke, salt, and dry food for winter

### Healing
- First aid: bandage wounds, set bones
- Herbalism: poultices and remedies
- Surgery: treat deep wounds, amputate
- Midwifery: safe births
- Alchemy: potions and reagents
- Poisoncraft: brew and detect poisons

### Combat
- Swordsmanship: blades
- Archery: bows
- Spear fighting: spears and polearms
- Axe fighting: war axes
- Shield work: block and shield wall
- Brawling: unarmed fighting
- Mounted combat: fight from horseback
- Tactics: lead small groups in a fight
- Stealth: move unseen and unheard

### Social
- Persuasion: change minds honestly
- Bargaining: better prices in trade
- Leadership: get others to follow and work together
- Oratory: move crowds
- Deception: lie convincingly
- Intimidation: get your way through fear
- Diplomacy: settle disputes between groups
- Teaching: raise others' skill faster
- Storytelling: spread tales and build reputation
- Music: lift morale, earn coin
- Etiquette: deal with nobles and elders
- Charm: win affection

### Knowledge and governance
- Literacy: read and write records and laws
- Arithmetic: count stores, plan harvests
- Law: judge disputes, write rules
- Lore: history, legends, old places
- Theology: lead worship, found a faith
- Astronomy: calendars and seasons
- Cartography: draw maps
- Stewardship: run stores, taxes, and labor for a settlement

### Crime
- Pickpocketing: lift items unseen
- Lockpicking: open locked doors and chests
- Smuggling: move goods past guards and tolls
- Forgery: fake seals, deeds, coins
- Fencing: sell stolen goods

### Arcane
- Runecraft: carve runes that hold power
- Enchanting: put magic into items
- Divination: glimpse likely futures
- Warding: protect places from harm and spirits
- Elementalism: bend fire, water, earth, air
- Spirit speaking: bargain with spirits of the land

## Traits (100)

Each agent gets 5 to 8 traits, each with a strength from 0 to 1. The five core personality numbers from the agent schema sit underneath. Traits are the words Jev reads.

### Temperament
- Calm: slow to anger or panic
- Hot-tempered: quick to anger and fight
- Anxious: sees danger everywhere, avoids risk
- Brave: faces danger head on
- Cowardly: flees or hides from danger
- Melancholy: often low, needs company or purpose
- Cheerful: lifts people around them
- Moody: swings between highs and lows
- Patient: happy with long, slow work
- Impulsive: acts first, thinks later
- Stoic: bears hardship without complaint
- Excitable: easily thrilled and distracted

### Social
- Gregarious: seeks crowds and company
- Loner: prefers to live and work alone
- Shy: slow to approach strangers
- Charismatic: others are drawn to them
- Abrasive: rubs people the wrong way
- Loyal: sticks with friends through trouble
- Fickle: changes allegiances easily
- Trusting: believes others by default
- Suspicious: assumes others want something
- Protective: guards the weak and their own
- Jealous: resents others' bonds and success
- Forgiving: lets grudges go
- Vengeful: never forgets a wrong
- Flirtatious: seeks romance
- Gossip: trades in rumors
- Discreet: keeps secrets
- Peacemaker: defuses fights between others
- Domineering: needs to be in charge
- Deferential: follows stronger personalities
- Clannish: favors kin and close friends over outsiders

### Morals
- Honest: rarely lies
- Deceitful: lies when it helps
- Generous: shares freely
- Greedy: hoards and wants more
- Just: cares about fairness and rules
- Ruthless: does whatever works
- Merciful: spares enemies
- Cruel: enjoys others' pain
- Pious: devout, follows a faith
- Cynical: believes in nothing and no one
- Honorable: keeps promises at a cost
- Opportunist: takes any advantage
- Humble: plays down their own worth
- Arrogant: thinks they're better than others
- Lawful: respects authority
- Rebellious: resists authority
- Selfless: puts others' needs first
- Selfish: puts their own needs first

### Drive
- Ambitious: wants power, wealth, or status
- Content: happy with what they have
- Industrious: always working
- Lazy: avoids effort when they can
- Curious: explores and experiments
- Cautious: sticks to the known
- Competitive: must win and be best
- Perfectionist: slow but excellent work
- Restless: can't stay in one place
- Homebody: attached to their home
- Adventurous: seeks danger and new places
- Visionary: dreams of what could be built
- Pragmatic: does what's needed now
- Stubborn: won't change course
- Adaptable: changes plans easily

### Mind
- Clever: learns and solves problems fast
- Dim: slow to learn
- Wise: good judgment about people and life
- Naive: easily fooled
- Scholarly: loves books and learning
- Practical: learns by doing
- Creative: invents and makes art
- Traditional: does things the old way
- Superstitious: sees omens and curses
- Skeptical: needs proof
- Absent-minded: forgets tasks and items
- Observant: notices details and lies
- Strategic: plans many steps ahead
- Dreamer: head in the clouds

### Habits and appetites
- Glutton: eats more than needed
- Ascetic: needs little food or comfort
- Drunkard: drawn to ale and wine
- Hoarder: keeps everything
- Tidy: keeps things in order
- Slovenly: lets things fall apart
- Early riser: up at dawn, sleeps early
- Night owl: active after dark
- Thrifty: saves for the future
- Spendthrift: spends as soon as they have
- Vain: cares about looks and status goods
- Animal lover: drawn to beasts, good with them
- Nature lover: prefers wild places to towns
- Craftsperson at heart: loves making things

### Body and fate
- Hardy: rarely sick, tough in cold
- Frail: tires and sickens easily
- Strong: carries more, hits harder
- Nimble: quick and agile
- Keen-eyed: sees far
- Touched by magic: arcane skills come easily
- Cursed: bad luck follows them

## Actions

Actions are the steps GOAP chains together. Jev never picks an action directly. It picks a goal, like "give Mara food" or "build shelter," and GOAP works out the steps, like walk to the berry bush, pick berries, walk to Mara, give. Every action has preconditions, effects, a time cost, and the skill it trains.

### How social actions work

A social action has two sides. The actor starts it, then the target answers with one Jev choice, using the target's own traits, needs, and relationship to the actor. For example, "Mara offers you 2 berries. Accept, refuse, or ask for more?" Code applies the result, logs the event, and a second Jev choice picks the bond it creates, if any. Nothing social happens without the other agent getting a say, and that's where the drama comes from.

Hidden actions (steal, lie, sabotage, poison) roll against the target's Observant trait and skills to see if they get noticed. If nobody notices, only the actor knows the truth. If someone does, a bond forms (stole from me, betrayed me) and gossip spreads it.

### Movement and body
- Walk to: move toward a place, thing, or agent
- Wander: move somewhere unexplored
- Flee: move away from a threat
- Follow: stay near an agent
- Rest: regain energy, faster in a shelter
- Sleep: long rest, dreams can surface desires
- Warm up: stand by a fire to regain warmth
- Hide: stay out of sight (Stealth)

### Gathering
- Pick up: take a loose item from the ground
- Drop: leave an item on the ground
- Forage: gather berries, mushrooms, nuts (Foraging)
- Chop: fell a tree into logs (Woodcutting)
- Mine: break rock for stone or ore (Mining)
- Fish: catch fish at water (Fishing)
- Hunt: kill an animal for meat and hide (Hunting)
- Set trap: place a snare, check it later (Trapping)
- Draw water: fill a container at a river or well

### Making and building
- Craft: follow a recipe, like an axe from a stick and a stone (Crafting and related skills)
- Cook: turn raw food into a better meal at a fire (Cooking)
- Start fire: turn wood into a campfire (Firemaking)
- Build: place a structure like a shelter, wall, or workshop (Building)
- Repair: restore a worn tool or damaged building
- Store: put items in a chest or storehouse
- Retrieve: take items back out of storage
- Plant: sow seeds (Farming)
- Harvest: collect grown crops (Farming)

### Needs
- Eat: consume food to lower hunger
- Drink: consume water or ale
- Heal: use a poultice or bandage on yourself (First aid)

### Social, friendly
- Talk: small talk, raises social need and familiarity (Charm)
- Greet: first meeting, forms an acquaintance
- Give: hand over items freely
- Trade: offer items for items, the target can counter (Bargaining)
- Share meal: eat together, strong bonding
- Share fire: sit at the same fire, bonding plus warmth
- Help: join another agent's current task, both finish faster
- Heal other: treat someone else's wounds (First aid, Herbalism)
- Teach: give another agent XP in a skill you're better at (Teaching)
- Learn from: ask someone to teach you
- Comfort: lift the mood of a sad or scared agent
- Compliment: small boost to affinity
- Gossip: tell one agent your opinion of another (spreads perceptions)
- Tell story: share an event from your memory, spreads lore and reputation (Storytelling)
- Promise: commit to a future action, broken promises become bonds
- Ask for help: request food, protection, or labor
- Invite: ask someone to share your shelter or camp
- Court: romantic approach, can lead to a lover bond (Charm)
- Apologize: try to repair a damaged relationship
- Forgive: drop a grudge, clears a negative bond
- Defend: step between an agent and a threat

### Social, hostile
- Insult: lower affinity, can start a fight
- Threaten: demand something under threat of force (Intimidation)
- Take: grab an item openly from someone, they see it
- Steal: take an item secretly (Pickpocketing)
- Lie: tell someone something false, like a fake story or bad gossip (Deception)
- Refuse: turn down a request, which is its own event
- Shun: ignore an agent, lowers their social need and affinity
- Fight: attack an agent (combat skills)
- Sabotage: secretly damage someone's tool, crop, or building
- Banish: once there's a group, vote or force someone out

### Group (unlocks once agents live near each other)
- Found camp: claim an area as a shared settlement
- Join camp: move into an existing settlement
- Propose rule: suggest a rule for the group, like "no stealing from the storehouse" (Law)
- Vote: back or oppose a proposal or leader
- Claim role: take on a profession like woodcutter, cook, or guard
- Assign task: a leader asks a member to do something (Leadership)
- Contribute: put items into a shared store
- Judge: settle a dispute between two members (Law)
- Punish: act against a rule breaker
- Hold feast: share food with the whole group, big reputation boost

v1 builds walk to, wander, rest, warm up, pick up, drop, forage, chop, craft, cook, start fire, build, eat, talk, greet, give, trade, share meal, share fire, help, gossip, take, steal, insult, and refuse. The rest come later.
