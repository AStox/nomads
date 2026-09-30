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
Object.defineProperty(exports, "__esModule", { value: true });
const net = __importStar(require("net"));
class SocketServerClient {
    constructor() {
        this.port = 8080;
        this.connect();
    }
    connect() {
        this.client = net.createConnection({ port: this.port }, () => {
            // logger.log("Connected to server");
        });
        this.client.on("data", (data) => {
            process.stdout.write("\x1Bc"); // Clear terminal
            process.stdout.write(data.toString());
        });
        this.client.on("end", () => {
            // logger.log("Disconnected from server");
        });
        this.client.on("error", (error) => {
            // logger.log(`Connection error: ${error.message}`);
            setTimeout(() => this.connect(), 2000); // Retry connection every 2 seconds
        });
    }
}
new SocketServerClient();
//# sourceMappingURL=SocketServerClient.js.map