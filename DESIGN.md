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
