const { World, Rectangle } = require("./src/World");
const Renderer = require("./src/Renderer");

const width = 30;
const world = new World(width, width);
world.populateItemsFromConfig("src/configs/objects.json");
const renderer = new Renderer(world);

// setInterval(() => {
renderer.render();
// }, 1000); // Re-renders every second
