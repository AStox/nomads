"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const readline = __importStar(require("readline"));
const World_1 = require("./src/World");
const Player_1 = require("./src/Player");
const Renderer_1 = __importDefault(require("./src/Renderer"));
const WalkTo_1 = require("./src/goap/Actions/WalkTo");
const Thing_1 = require("./src/Thing");
const Logger_1 = __importDefault(require("./src/utils/Logger"));
const width = 80;
const world = World_1.World.newWorld(width, width);
// world.populateThingsFromConfig("src/configs/objects.json");
const things = [];
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
    Logger_1.default.log(`TreeRng: ${treeRNGx}, ${treeRNGy}`);
    things.push((0, Thing_1.createThing)(Thing_1.ThingType.TREE, {
        x: treeRNGx * width - width / 2,
        y: treeRNGy * width - width / 2,
    }));
}
for (let i = 0; i < numBerries; i++) {
    const berryRNGx = Math.random();
    const berryRNGy = Math.random();
    Logger_1.default.log(`BerryRng: ${berryRNGx}, ${berryRNGy}`);
    things.push((0, Thing_1.createThing)(Thing_1.ThingType.BERRY, {
        x: berryRNGx * width - width / 2,
        y: berryRNGy * width - width / 2,
    }));
}
for (let i = 0; i < numMushrooms; i++) {
    const mushroomRNGx = Math.random();
    const mushroomRNGy = Math.random();
    Logger_1.default.log(`MushroomRng: ${mushroomRNGx}, ${mushroomRNGy}`);
    things.push((0, Thing_1.createThing)(Thing_1.ThingType.MUSHROOM, {
        x: mushroomRNGx * width - width / 2,
        y: mushroomRNGy * width - width / 2,
    }));
}
for (const thing of things) {
    world.state.quadtree.insert(thing);
}
let players = [new Player_1.Player("1", "John Plant", 0, 0, "🧍", [WalkTo_1.WalkTo])];
for (const player of players) {
    world.state.quadtree.insert(player);
}
const renderer = new Renderer_1.default();
let turn = 1;
let running = false;
function processTick() {
    if (!running)
        return;
    tick();
}
function tick() {
    Logger_1.default.log(`-------------------- Turn ${turn} --------------------`);
    for (const player of players) {
        player.hunger -= 1;
        const state = Object.assign(Object.assign({}, world.state), { player: player });
        Logger_1.default.log(`Player ${player.name} at position (${state.quadtree.queryAll().filter((t) => t.id === player.id)[0].x}, ${state.quadtree.queryAll().filter((t) => t.id === player.id)[0].y})`);
        player.makeDecision(state);
        Logger_1.default.log("---------------------------------------------------------------");
        renderer.render(state);
    }
    Logger_1.default.log(`-------------------- End of Turn ${turn} --------------------\n\n`);
    turn++;
    setTimeout(processTick, 1000);
}
readline.emitKeypressEvents(process.stdin);
process.stdin.setRawMode(true);
process.stdin.on("keypress", (str, key) => {
    if (key.ctrl && key.name === "c") {
        process.exit(); // Exit on CTRL+C
    }
    else if (key.name === "space") {
        running = !running; // Toggle running state
        console.log(running ? "Resuming simulation..." : "Simulation paused.");
        if (running)
            processTick(); // If resuming, immediately process next tick
    }
    else if (key.name === "right" && !running) {
        console.log("Stepping...");
        tick(); // Execute a single tick
    }
});
console.log("Press SPACE to pause/resume the simulation, RIGHT arrow to step through while paused.");
processTick(); // Start the simulation
//# sourceMappingURL=index.js.map