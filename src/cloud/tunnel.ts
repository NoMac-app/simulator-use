/**
 * A NoMac phone's tunnel to a backend on this machine (NoMac Simulator plan 10.7 E6): the phone's apps reach
 * http://127.0.0.1:<port> on the phone, and each connection they make is carried here and dialed to the local port.
 * The requests that pass are kept (method, path, status, time, size), as a capture of what the app asked the backend.
 * The tunnel comes back by itself after a dropped connection while the phone runs.
 */

import { connect, type Socket } from "node:net";

import { ToolError } from "../errors.ts";
import { CLOSE, DATA, dataFrames, frame, FrameReader, HELLO, MAX_CONNECTIONS, OPEN } from "../tunnel-frames.ts";
import type { CloudApi } from "./api.ts";

export type Captured = { method: string; path: string; status?: number; ms?: number; bytes: number; at: string };
type Pending = { entry: Captured; started: number };
// pending: a request waiting for its answer; answered: the last one answered, counting its answer's bytes.
type Conn = { socket: Socket; pending?: Pending; answered?: Captured };

const KEEP = 200;
const REQUEST = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS) (\S{1,2048}) HTTP\/1\.[01]\r\n/;
const RESPONSE = /^HTTP\/1\.[01] (\d{3})/;
// The WebSocket may hold this much unsent before a local connection waits for it.
const SEND_BUFFER = 4 * 1024 * 1024;

export class Tunnel {
  readonly session: string;
  readonly localPort: number;
  readonly localHost: string;
  phonePort?: number;
  state: "connecting" | "open" | "closed" = "connecting";
  error?: string;
  requests: Captured[] = [];
  connections = 0;
  private readonly api: CloudApi;
  private readonly onRequest?: (request: Captured) => void;
  private ws?: WebSocket;
  private conns = new Map<number, Conn>();
  private stopped = false;
  private drops = 0;

  constructor(api: CloudApi, session: string, localPort: number, localHost = "127.0.0.1", onRequest?: (request: Captured) => void) {
    this.api = api;
    this.session = session;
    this.localPort = localPort;
    this.localHost = localHost;
    this.onRequest = onRequest;
  }

  /** Opens the tunnel; answers the port the phone's apps reach once the phone's relay listens. */
  async start(): Promise<number> {
    if (typeof globalThis.WebSocket !== "function") throw new ToolError("cloud tunnel needs Node 22 or later (for its WebSocket).", "Update Node, then call cloud tunnel again.");
    return this.open();
  }

  stop() {
    this.stopped = true;
    this.state = "closed";
    this.ws?.close();
    for (const conn of this.conns.values()) conn.socket.destroy();
    this.conns.clear();
  }

  private async open(): Promise<number> {
    const access = await this.api.json("POST", `/api/v1/simulator/sessions/${this.session}/tunnel`, {});
    const url = String(access.url), token = String(access.token);
    return new Promise<number>((resolve, reject) => {
      const ws = new WebSocket(url, [String(access.protocol ?? "nomac.tunnel"), `nomac.token.${token}`]);
      ws.binaryType = "arraybuffer";
      this.ws = ws;
      const reader = new FrameReader();
      let opened = 0;
      let answered = false;
      ws.onmessage = (event) => {
        let frames;
        try {
          frames = reader.push(Buffer.from(event.data as ArrayBuffer));
        } catch {
          ws.close();
          return;
        }
        for (const f of frames) {
          if (f.type === HELLO) {
            this.phonePort = Number((JSON.parse(f.payload.toString("utf8")) as { port?: unknown }).port);
            this.state = "open";
            opened = Date.now();
            if (!answered) {
              answered = true;
              resolve(this.phonePort);
            }
          } else if (f.type === OPEN) this.dial(f.conn);
          else if (f.type === DATA) this.toLocal(f.conn, f.payload);
          else if (f.type === CLOSE) this.drop(f.conn);
        }
      };
      ws.onclose = () => {
        for (const conn of this.conns.values()) conn.socket.destroy();
        this.conns.clear();
        if (this.ws !== ws || this.stopped) return;
        if (!answered) {
          answered = true;
          this.state = "closed";
          reject(new ToolError("The phone's tunnel did not open.", "The phone must be ready; call cloud status, then cloud tunnel again."));
          return;
        }
        // Back after a dropped connection (a NoMac deploy, the network), while the phone runs: a connection that
        // lasted a minute starts the count again.
        this.drops = Date.now() - opened > 60_000 ? 1 : this.drops + 1;
        this.state = "connecting";
        if (this.drops > 8) {
          this.state = "closed";
          this.error = "the tunnel kept dropping";
          return;
        }
        setTimeout(() => {
          if (!this.stopped) this.open().catch((error: unknown) => {
            this.state = "closed";
            this.error = (error as Error).message;
          });
        }, Math.min(30_000, 1000 * 2 ** (this.drops - 1)));
      };
    });
  }

  private send(bytes: Buffer, socket?: Socket) {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(bytes);
    if (socket && ws.bufferedAmount > SEND_BUFFER) {
      socket.pause();
      const wait = setInterval(() => {
        if (ws.readyState !== WebSocket.OPEN || ws.bufferedAmount < SEND_BUFFER / 2) {
          clearInterval(wait);
          socket.resume();
        }
      }, 20);
    }
  }

  private dial(id: number) {
    if (this.conns.size >= MAX_CONNECTIONS) {
      this.send(frame(CLOSE, id));
      return;
    }
    const socket = connect({ port: this.localPort, host: this.localHost });
    const conn: Conn = { socket };
    this.conns.set(id, conn);
    this.connections++;
    socket.on("data", (chunk: Buffer) => {
      this.noteResponse(conn, chunk);
      for (const f of dataFrames(id, chunk)) this.send(f, socket);
    });
    socket.on("close", () => {
      if (this.conns.get(id) !== conn) return;
      this.conns.delete(id);
      this.finish(conn);
      this.send(frame(CLOSE, id));
    });
    socket.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ECONNREFUSED") this.error = `nothing listens on ${this.localHost}:${this.localPort} on this machine`;
      socket.destroy();
    });
  }

  private toLocal(id: number, bytes: Buffer) {
    const conn = this.conns.get(id);
    if (!conn) return;
    this.noteRequest(conn, bytes);
    conn.socket.write(bytes);
  }

  private drop(id: number) {
    const conn = this.conns.get(id);
    if (!conn) return;
    this.conns.delete(id);
    this.finish(conn);
    conn.socket.destroy();
  }

  // The capture: a request line at the start of what the app sends, the status line of what comes back.
  private noteRequest(conn: Conn, bytes: Buffer) {
    if (conn.pending) {
      conn.pending.entry.bytes += bytes.length;
      return;
    }
    const m = REQUEST.exec(bytes.subarray(0, 2100).toString("latin1"));
    if (!m) return;
    conn.answered = undefined;
    conn.pending = { entry: { method: m[1]!, path: m[2]!, bytes: bytes.length, at: new Date().toISOString() }, started: Date.now() };
  }

  private noteResponse(conn: Conn, bytes: Buffer) {
    const pending = conn.pending;
    if (!pending) {
      if (conn.answered) conn.answered.bytes += bytes.length;
      return;
    }
    pending.entry.bytes += bytes.length;
    const m = RESPONSE.exec(bytes.subarray(0, 32).toString("latin1"));
    if (!m) return;
    pending.entry.status = Number(m[1]);
    pending.entry.ms = Date.now() - pending.started;
    this.keep(pending.entry);
    // The rest of the answer counts here; the next request on this connection (keep-alive) starts a new entry.
    conn.answered = pending.entry;
    conn.pending = undefined;
  }

  private finish(conn: Conn) {
    if (conn.pending && conn.pending.entry.status === undefined) this.keep({ ...conn.pending.entry, ms: Date.now() - conn.pending.started });
    conn.pending = undefined;
  }

  private keep(entry: Captured) {
    this.requests.push(entry);
    if (this.requests.length > KEEP) this.requests.splice(0, this.requests.length - KEEP);
    this.onRequest?.(entry);
  }
}

/** A request as a line: "GET /api/items → 200 in 34 ms (1.2 KB)"; as it is answered, without its size (still coming). */
export function describeRequest(r: Captured, withSize = true): string {
  const size = r.bytes >= 1024 ? `${(r.bytes / 1024).toFixed(1)} KB` : `${r.bytes} B`;
  return `${r.method} ${r.path} → ${r.status ?? "no answer"}${r.ms !== undefined ? ` in ${r.ms} ms` : ""}${withSize ? ` (${size})` : ""}`;
}
