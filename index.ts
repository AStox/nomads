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
    const state: CombinedState = { ...world.state, player: player };
    player.makeDecision(state);
    console.log("---------------------------------------------------------------");
    renderer.render(state);
  }
  turn++;
}, 1000);
