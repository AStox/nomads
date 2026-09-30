"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Rectangle = exports.World = void 0;
const QuadTree_1 = require("./utils/QuadTree");
Object.defineProperty(exports, "Rectangle", { enumerable: true, get: function () { return QuadTree_1.Rectangle; } });
class World {
    constructor(width, height) {
        this.state = {
            quadtree: new QuadTree_1.QuadTree(new QuadTree_1.Rectangle(0, 0, width / 2, height / 2), 4),
        };
    }
    static newWorld(width, height) {
        if (World.instance) {
            return World.instance;
        }
        World.instance = new World(width, height);
        return World.instance;
    }
    static getInstance() {
        if (!World.instance) {
            World.instance = new World(100, 100);
        }
        return World.instance;
    }
}
exports.World = World;
//# sourceMappingURL=World.js.map