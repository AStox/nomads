import * as readline from "readline";
import { World, Thing } from "./src/World";
import { Player } from "./src/Player";
import Renderer from "./src/Renderer";
import { CombinedState } from "./src/goap/GOAPPlanner";
import { WalkTo } from "./src/goap/Actions/WalkTo";
import { ThingType, createThing } from "./src/Thing";
import logger from "./src/utils/Logger";

const width: number = 80;
const world = World.newWorld(width, width);
// world.populateThingsFromConfig("src/configs/objects.json");
const things: Thing[] = [];
// createThing(ThingType.TREE, { x: 10, y: 2 })];
//   createThing(ThingType.TREE, { x: -10, y: -2 }),
//   createThing(ThingType.TREE, { x: -4, y: 10 }),
//   createThing(ThingType.TREE, { x: 3, y: -9 }),
//   createThing(ThingType.BERRY, { x: 1, y: 1 }),
//   createThing(ThingType.BERRY, { x: 1, y: -1 }),
//   createThing(ThingType.BERRY, { x: -5, y: 1 }),
//   createThing(ThingType.BERRY, { x: -5, y: 3 }),
//   createThing(ThingType.BERRY, { x: -8, y: 2 }),
//   createThing(ThingType.BERRY, { x: -2, y: 1 }),
//   createThing(ThingType.MUSHROOM, { x: -5, y: 10 }),
//   createThing(ThingType.POULTICE, { x: 3, y: 7 }),
// ];

// generate random things
const numTrees = 10;
const numBerries = 10;
const numMushrooms = 10;

for (let i = 0; i < numTrees; i++) {
  const treeRNGx = Math.random();
  const treeRNGy = Math.random();
  logger.log(`TreeRng: ${treeRNGx}, ${treeRNGy}`);
  things.push(
    createThing(ThingType.TREE, {
      x: treeRNGx * width - width / 2,
      y: treeRNGy * width - width / 2,
    })
  );
}
for (let i = 0; i < numBerries; i++) {
  const berryRNGx = Math.random();
  const berryRNGy = Math.random();
  logger.log(`BerryRng: ${berryRNGx}, ${berryRNGy}`);
  things.push(
    createThing(ThingType.BERRY, {
      x: berryRNGx * width - width / 2,
      y: berryRNGy * width - width / 2,
    })
  );
}
for (let i = 0; i < numMushrooms; i++) {
  const mushroomRNGx = Math.random();
  const mushroomRNGy = Math.random();
  logger.log(`MushroomRng: ${mushroomRNGx}, ${mushroomRNGy}`);
  things.push(
    createThing(ThingType.MUSHROOM, {
      x: mushroomRNGx * width - width / 2,
      y: mushroomRNGy * width - width / 2,
    })
  );
}

for (const thing of things) {
  world.state.quadtree.insert(thing);
}

let players = [new Player("1", "John Plant", 0, 0, "🧍", [WalkTo])];
for (const player of players) {
  world.state.quadtree.insert(player);
}

const renderer = new Renderer();

let turn = 1;
let running = false;

function processTick(): void {
  if (!running) return;
  tick();
}

function tick(): void {
  logger.log(`-------------------- Turn ${turn} --------------------`);

  for (const player of players) {
    player.hunger -= 1;
    const state: CombinedState = { ...world.state, player: player };
    logger.log(
      `Player ${player.name} at position (${
        state.quadtree.queryAll().filter((t) => t.id === player.id)[0].x
      }, ${state.quadtree.queryAll().filter((t) => t.id === player.id)[0].y})`
    );
    player.makeDecision(state);
    logger.log("---------------------------------------------------------------");
    renderer.render(state);
  }

  logger.log(`-------------------- End of Turn ${turn} --------------------\n\n`);
  turn++;

  setTimeout(processTick, 1000);
}

readline.emitKeypressEvents(process.stdin);
process.stdin.setRawMode(true);
process.stdin.on("keypress", (str, key) => {
  if (key.ctrl && key.name === "c") {
    process.exit(); // Exit on CTRL+C
  } else if (key.name === "space") {
    running = !running; // Toggle running state
    console.log(running ? "Resuming simulation..." : "Simulation paused.");
    if (running) processTick(); // If resuming, immediately process next tick
  } else if (key.name === "right" && !running) {
    console.log("Stepping...");
    tick(); // Execute a single tick
  }
});

console.log(
  "Press SPACE to pause/resume the simulation, RIGHT arrow to step through while paused."
);
processTick(); // Start the simulation
