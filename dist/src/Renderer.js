"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const SocketServer_1 = require("./server/SocketServer");
class Renderer {
    constructor() {
        this.socketServer = new SocketServer_1.SocketServer();
        this.socketServer.start(8080); // You can choose another port if 8080 is already in use
    }
    toGrid(state) {
        const gridSize = state.quadtree.boundary.w * 2;
        const grid = Array.from({ length: gridSize }, () => Array(gridSize).fill(". "));
        const items = state.quadtree.queryAll();
        for (const item of items) {
            const x = Math.floor(item.x + gridSize / 2);
            const y = Math.floor(item.y + gridSize / 2);
            if (x >= 0 && x < gridSize && y >= 0 && y < gridSize) {
                grid[y][x] = item.symbol;
            }
        }
        return grid;
    }
    render(state) {
        var _a;
        const grid = this.toGrid(state);
        const gridString = grid.map((row) => row.join("")).join("\n");
        const statusString = `HP: ${state.player.HP}/${state.player.maxHP}\nHunger: ${state.player.hunger}/${state.player.maxHunger}\nInventory: ${state.player.inventory.map((item) => `${item.name}${item.symbol}`).join(", ") || []}\nPlan: ${state.player.currentPlan && state.player.currentPlan.length > 0
            ? (_a = state.player.currentPlan) === null || _a === void 0 ? void 0 : _a.map((action) => `${action.name}(${action.target.name}${action.target.symbol})`).join(" -> ")
            : state.player.GOAPStatus}`;
        this.socketServer.send(gridString + "\n" + statusString);
    }
}
exports.default = Renderer;
//# sourceMappingURL=Renderer.js.map