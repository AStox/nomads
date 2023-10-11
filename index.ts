import { World, Rectangle, Thing } from "./src/World";
import { Player } from "./src/Player";
import Renderer from "./src/Renderer";
import { CombinedState } from "./src/goap/GOAPPlanner";
import { WalkTo } from "./src/goap/Actions/WalkTo";
import { PickUp } from "./src/goap/Actions/PickUp";
import { Chop } from "./src/goap/Actions/Chop";
import { ThingType } from "./src/Things";
import { StartFire } from "./src/goap/Actions/StartFire";

const width: number = 30;
const world = World.newWorld(width, width);
// world.populateThingsFromConfig("src/configs/objects.json");
const things: Thing[] = [
  {
    id: "tree2",
    name: ThingType.TREE,
    type: ThingType.TREE,
    x: 0,
    y: 0,
    symbol: "🌲",
    actions: [WalkTo, Chop],
  },
  {
    id: "wood3",
    name: ThingType.WOOD,
    type: ThingType.WOOD,
    x: 10,
    y: 10,
    symbol: "🪵",
    actions: [WalkTo, PickUp, StartFire],
  },
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
