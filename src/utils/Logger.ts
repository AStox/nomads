import * as fs from "fs";
import * as path from "path";

class Logger {
  private logFile: string;

  constructor() {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-"); // Replace characters not allowed in file names
    this.logFile = path.join(path.resolve("logs"), `log-${timestamp}.log`); // Create a new log file with timestamp
  }

  log(message: string, logToConsole = true, logToFile = true): void {
    const timestamp = new Date().toISOString();
    const logMessage = `${timestamp}: ${message}\n`;
    if (logToFile) {
      try {
        fs.appendFileSync(this.logFile, logMessage);
      } catch (err) {
        console.error("Failed to write to log file:", err);
      }
    }
    if (logToConsole) console.log(message); // Optionally, also log to console
  }
}

const logger = new Logger();
export default logger;
