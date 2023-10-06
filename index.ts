import { World, Rectangle, Thing } from "./src/World";
import { Player } from "./src/Player";
import Renderer from "./src/Renderer";
import { CombinedState } from "./src/goap/GOAPPlanner";
import { WalkTo } from "./src/goap/Actions/WalkTo";
import { PickUp } from "./src/goap/Actions/PickUp";
import { ThingType } from "./src/Things";

const width: number = 30;
const world = new World(width, width);
// world.populateThingsFromConfig("src/configs/objects.json");
const things: Thing[] = [
  // { name: ThingType.TREE, type: ThingType.TREE, x: 0, y: 0, symbol: "🌲", actions: [WalkTo] },
  // { name: ThingType.TREE, type: ThingType.TREE, x: 10, y: 10, symbol: "🌲", actions: [WalkTo] },
  {
    name: ThingType.AXE,
    type: ThingType.AXE,
    x: 10,
    y: 10,
    symbol: "🪓",
    actions: [WalkTo, PickUp],
  },
];

for (const thing of things) {
  world.addThing(thing);
}

// const player = new Player(0, 0);
let players = [new Player(ThingType.PLAYER, 0, 10, "🧍", [WalkTo])];
for (const player of players) {
  world.addThing(player);
}

const renderer = new Renderer(world);

let turn = 1;
// setInterval(() => {
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
// }, 1000); // Re-renders every second
