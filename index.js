const { World, Rectangle } = require("./src/World");
const { Player } = require("./src/Player");
const Renderer = require("./src/Renderer");

const width = 30;
const world = new World(width, width);
world.populateItemsFromConfig("src/configs/objects.json");

const player = new Player(0, 0);
world.addItem(player);

const renderer = new Renderer(world);

// setInterval(() => {
player.makeDecision();
// renderer.render();
// }, 1000); // Re-renders every second
