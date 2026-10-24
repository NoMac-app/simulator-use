/**
 * A NoMac phone's tunnel relay (NoMac Simulator plan 10.7 E6), run by the host as the phone's own user: it listens on
 * a free loopback port of the user's (SIMULATOR_USE_PORTS; the host's firewall lets only this user's apps reach it,
 * and lets only this user's listener take them) and carries each connection the phone's apps make over its stdio,
 * where the client on the developer's machine dials their backend for it. It ends when its stdio does.
 */

import { createServer, type Server, type Socket } from "node:net";
import type { Readable, Writable } from "node:stream";

import { CLOSE, DATA, dataFrames, frame, FrameReader, HELLO, MAX_CONNECTIONS, OPEN } from "./tunnel-frames.ts";

/** The ports to try, highest first: the session server's own (Metro and the like) take the lowest. */
export function relayPorts(range: string | undefined): number[] {
  const m = /^(\d+)-(\d+)$/.exec(range ?? "");
  if (!m) throw new Error("SIMULATOR_USE_PORTS is not a range");
  const [first, last] = [Number(m[1]), Number(m[2])];
  if (!(first > 1024 && first <= last && last < 65536)) throw new Error("SIMULATOR_USE_PORTS is not a range of user ports");
  const ports: number[] = [];
  for (let port = last; port >= first; port--) ports.push(port);
  return ports;
}

const listen = (server: Server, port: number, host: string) =>
  new Promise<boolean>((resolve) => {
    const failed = () => resolve(false);
    server.once("error", failed);
    server.listen({ port, host, exclusive: true }, () => {
      server.off("error", failed);
      resolve(true);
    });
  });

/** Runs the relay on these streams until input ends. Answers the port it listened on. */
export async function relay(input: Readable, output: Writable, ports: number[]): Promise<number> {
  const sockets = new Map<number, Socket>();
  let next = 0;
  const send = (bytes: Buffer, socket?: Socket) => {
    if (!output.write(bytes) && socket) {
      socket.pause();
      output.once("drain", () => socket.resume());
    }
  };
  const accept = (socket: Socket) => {
    if (sockets.size >= MAX_CONNECTIONS) {
      socket.destroy();
      return;
    }
    const conn = (next = (next % 0xffffffff) + 1);
    sockets.set(conn, socket);
    send(frame(OPEN, conn));
    socket.on("data", (chunk: Buffer) => {
      for (const f of dataFrames(conn, chunk)) send(f, socket);
    });
    const gone = () => {
      if (sockets.get(conn) !== socket) return;
      sockets.delete(conn);
      send(frame(CLOSE, conn));
    };
    socket.on("close", gone);
    socket.on("error", () => socket.destroy());
  };
  // IPv4 and IPv6 loopback on the same port: an app may ask for 127.0.0.1 or localhost.
  const servers: Server[] = [];
  let port = 0;
  for (const candidate of ports) {
    const v4 = createServer(accept);
    if (!(await listen(v4, candidate, "127.0.0.1"))) continue;
    servers.push(v4);
    const v6 = createServer(accept);
    if (await listen(v6, candidate, "::1")) servers.push(v6);
    port = candidate;
    break;
  }
  if (!port) throw new Error("no free port for the tunnel");
  send(frame(HELLO, 0, Buffer.from(JSON.stringify({ port }))));
  const reader = new FrameReader();
  await new Promise<void>((resolve) => {
    input.on("data", (chunk: Buffer) => {
      let frames;
      try {
        frames = reader.push(chunk);
      } catch {
        input.destroy();
        return;
      }
      for (const f of frames) {
        const socket = sockets.get(f.conn);
        if (!socket) continue;
        if (f.type === DATA) {
          if (!socket.write(f.payload)) {
            input.pause();
            socket.once("drain", () => input.resume());
          }
        } else if (f.type === CLOSE) {
          sockets.delete(f.conn);
          socket.destroy();
        }
      }
    });
    input.on("end", resolve);
    input.on("close", resolve);
    input.on("error", resolve);
  });
  for (const socket of sockets.values()) socket.destroy();
  for (const server of servers) server.close();
  return port;
}
