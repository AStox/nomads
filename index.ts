import { World, Rectangle } from "./src/World";
import { Player } from "./src/Player";
import Renderer from "./src/Renderer";
import { CombinedState } from "./src/goap/GOAPPlanner";

const width: number = 30;
const world = new World(width, width);
world.populateThingsFromConfig("src/configs/objects.json");

// const player = new Player(0, 0);
let players = [new Player(0, 0)];
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
    const combinedState: CombinedState = { ...world.state, ...player.playerState };
    player.makeDecision(combinedState);
    console.log("---------------------------------------------------------------");
  }
  turn++;
  // renderer.render();
}, 1000); // Re-renders every second
