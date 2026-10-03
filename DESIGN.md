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
- **Theories of failure.** Every time someone does what they believe works, the attempt is noted all told and against each condition they could see: rain, dark, freezing cold, a strong wind, and for what's done to the ground (planting, digging, watering) the spot itself: the ground, the shade of trees over it, dry ground, bushes and trees crowded round. When something that has worked for them fails, a condition they were in is a suspect once it has failed them there more than once and done worse there than out of it, or when the failure itself points at it (the tinder too damp to catch), and they settle on one, or on bad luck, or on no idea: Jev is shown their record in and out of each ("in the rain it has worked 0 of 2 times for them, and 4 of 5 otherwise"), and offline the guess leans on the same record, harder the worse and the more often, toward what the failure itself shows (damp wood), and toward bad luck for what usually works. Nothing tells them the cause: a seedling just withers. What they settle on is a theory ("they think it won't work in the rain", "in the shade of trees"), shown with the belief and the record it rests on, taught with it, and respected by the planner however badly they need it: freezing in the rain, someone who thinks fire won't light in it asks for help rather than rubbing wet sticks until they drop. (Letting the desperate try anyway was tried: a whole camp froze rubbing sticks in a winter rain.)
- **Theories get tested and revised.** A theory goes when what they see tells against it: it works for them in the very condition they blamed and has there at least as often as not (one seedling that comes up in the shade is luck), they watch someone else do it there, or their record comes to show it doing about as well in that condition as out of it over a few tries ("came to think it makes no difference whether it's done in the dark"). A plan made before the weather turned doesn't carry them into what they think won't work in it: they stop before starting, and think again. When they aren't in trouble (not starving, freezing, hurt or spent), someone standing in a condition they blame can set out to try it anyway, to see whether it really won't work, the likelier the less the theory rests on and the more curious, doubting or clever they are; a test is one try, and one that fails is one more failure the theory rests on, so tests of it grow rarer. Between ways of doing the same thing, the planner takes the cheapest it finds, weighing each by its odds in the conditions they're in (the worst of its record all told and in each condition it's been tried in), with some hope besides for what they've hardly tried, which is what gets it tried; a failure that only shows days later (a seed that never comes up) weighs as much as a long walk. So mistakes are made, and corrected, and what people do drifts toward what works best where and when they do it. scripts/theories.ts runs worlds and logs every attempt, theory and test; scripts/theory-report.ts scores them over time against the truth: what the world's rules say hurts what (rain hurts lighting a fire by rubbing or striking; dark and wind hurt nothing), and for planting a controlled experiment, scripts/plant-truth.ts (berries in random spots all year: crowding, shade and rocky ground hurt; the weather doesn't).
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
