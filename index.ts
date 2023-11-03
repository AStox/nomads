import { World, Thing } from "./src/World";
import { Player } from "./src/Player";
import Renderer from "./src/Renderer";
import { CombinedState } from "./src/goap/GOAPPlanner";
import { WalkTo } from "./src/goap/Actions/WalkTo";
import { ThingType, createThing } from "./src/Thing";

const width: number = 30;
const world = World.newWorld(width, width);
// world.populateThingsFromConfig("src/configs/objects.json");
const things: Thing[] = [
  createThing(ThingType.TREE, { x: 10, y: 2 }),
  createThing(ThingType.BERRY, { x: 1, y: 1 }),
  createThing(ThingType.BERRY, { x: 1, y: -1 }),
  createThing(ThingType.BERRY, { x: -2, y: 1 }),
  createThing(ThingType.MUSHROOM, { x: -5, y: 10 }),
  createThing(ThingType.POULTICE, { x: 3, y: 7 }),
];

for (const thing of things) {
  world.state.quadtree.insert(thing);
}

let players = [new Player("1", "John Plant", 0, 0, "🧍", [WalkTo])];
for (const player of players) {
  world.state.quadtree.insert(player);
}

const renderer = new Renderer();

let turn = 1; // Keep track of the current turn outside processTurn to maintain state

function processTurn(): void {
  console.log(`-------------------- Turn ${turn} --------------------`);

  for (const player of players) {
    const state: CombinedState = { ...world.state, player: player };
    console.log(
      `Player ${player.name} at position (${
        state.quadtree.queryAll().filter((t) => t.id === player.id)[0].x
      }, ${state.quadtree.queryAll().filter((t) => t.id === player.id)[0].y})`
    );
    player.makeDecision(state); // Assuming makeDecision is synchronous
    console.log("---------------------------------------------------------------");
    renderer.render(state); // Assuming render is synchronous
  }

  console.log(`-------------------- End of Turn ${turn} --------------------\n\n`);
  turn++;

  // Schedule the next turn after a 1-second delay, ensuring the previous turn has fully completed
  setTimeout(processTurn, 1000);
}

processTurn();
