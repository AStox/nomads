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
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
class Logger {
    constructor() {
        const timestamp = new Date().toISOString().replace(/[:.]/g, "-"); // Replace characters not allowed in file names
        this.logFile = path.join(path.resolve("logs"), `log-${timestamp}.log`); // Create a new log file with timestamp
    }
    log(message, logToConsole = true, logToFile = true) {
        const timestamp = new Date().toISOString();
        const logMessage = `${timestamp}: ${message}\n`;
        if (logToFile) {
            try {
                fs.appendFileSync(this.logFile, logMessage);
            }
            catch (err) {
                console.error("Failed to write to log file:", err);
            }
        }
        if (logToConsole)
            console.log(message); // Optionally, also log to console
    }
}
const logger = new Logger();
exports.default = logger;
//# sourceMappingURL=Logger.js.map