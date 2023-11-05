// File: src/SocketServer.ts
import * as net from "net";
import logger from "../utils/Logger";

export class SocketServer {
  private server: net.Server;
  private clients: net.Socket[] = [];

  constructor() {
    this.server = net.createServer((socket) => {
      this.clients.push(socket);
      socket.on("close", () => {
        this.clients = this.clients.filter((client) => client !== socket);
      });
    });
  }

  start(port: number): void {
    this.server.listen(port, () => {
      logger.log(`Server listening on port ${port}`);
    });
  }

  send(data: string): void {
    for (const client of this.clients) {
      client.write(data);
    }
  }

  stop(): void {
    for (const client of this.clients) {
      client.destroy();
    }
    this.server.close();
  }
}
