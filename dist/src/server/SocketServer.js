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
exports.SocketServer = void 0;
const net = __importStar(require("net"));
const Logger_1 = __importDefault(require("../utils/Logger"));
class SocketServer {
    constructor() {
        this.clients = [];
        this.server = net.createServer((socket) => {
            this.clients.push(socket);
            socket.on("close", () => {
                this.clients = this.clients.filter((client) => client !== socket);
            });
        });
    }
    start(port) {
        this.server.listen(port, () => {
            Logger_1.default.log(`Server listening on port ${port}`);
        });
    }
    send(data) {
        for (const client of this.clients) {
            client.write(data);
        }
    }
    stop() {
        for (const client of this.clients) {
            client.destroy();
        }
        this.server.close();
    }
}
exports.SocketServer = SocketServer;
//# sourceMappingURL=SocketServer.js.map