import { World, Rectangle, Thing } from "./src/World";
import { Player } from "./src/Player";
import Renderer from "./src/Renderer";
import { CombinedState } from "./src/goap/GOAPPlanner";
import { WalkTo } from "./src/goap/Actions/WalkTo";
import { PickUp } from "./src/goap/Actions/PickUp";
import { Chop } from "./src/goap/Actions/Chop";
import { ThingType, createThing } from "./src/Thing";
import { StartFire } from "./src/goap/Actions/StartFire";

const width: number = 30;
const world = World.newWorld(width, width);
// world.populateThingsFromConfig("src/configs/objects.json");
const things: Thing[] = [
  createThing(ThingType.TREE, { x: 0, y: 5 }),
  // createThing(ThingType.TREE, { x: 1, y: 1 }),
  createThing(ThingType.WOOD, { x: 1, y: 2 }),
  createThing(ThingType.BERRY, { x: 1, y: 3 }),
  createThing(ThingType.BERRY, { x: 1, y: 4 }),
];

for (const thing of things) {
  world.addThing(thing);
}

// const player = new Player(0, 0);
let players = [new Player("1", "John Plant", 0, 10, "🧍", [WalkTo])];
for (const player of players) {
  world.addThing(player);
}

const renderer = new Renderer(world);

let turn = 1;
setInterval(() => {
  for (const player of players) {
    console.log(
      "-------------------- Player " +
        player.x +
        ", " +
        player.y +
        " -- Turn " +
        turn +
        " --------------------"
    );
    const combinedState: CombinedState = { ...world.state, player: player };
    player.makeDecision(combinedState);
    console.log("---------------------------------------------------------------");
  }
  turn++;
  // renderer.render();
}, 1000); // Re-renders every second
