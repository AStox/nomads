// File: src/server/SocketServerClient.ts
import * as net from "net";

class SocketServerClient {
  private client!: net.Socket;
  private readonly port: number = 8080;

  constructor() {
    this.connect();
  }

  private connect(): void {
    this.client = net.createConnection({ port: this.port }, () => {
      console.log("Connected to server");
    });

    this.client.on("data", (data: Buffer) => {
      process.stdout.write("\x1Bc"); // Clear terminal
      process.stdout.write(data.toString());
    });

    this.client.on("end", () => {
      console.log("Disconnected from server");
    });

    this.client.on("error", (error: Error) => {
      console.error("Connection error:", error.message);
      setTimeout(() => this.connect(), 2000); // Retry connection every 2 seconds
    });
  }
}

new SocketServerClient();
