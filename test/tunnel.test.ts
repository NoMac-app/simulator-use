import assert from "node:assert/strict";
import { createServer, get, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { PassThrough } from "node:stream";
import { test } from "node:test";

import type { CloudApi } from "../src/cloud/api.ts";
import { describeRequest, Tunnel } from "../src/cloud/tunnel.ts";
import { CLOSE, DATA, frame, FrameReader, HELLO, MAX_PAYLOAD, OPEN } from "../src/tunnel-frames.ts";
import { relay, relayPorts } from "../src/tunnel-relay.ts";

const listening = (server: Server) => new Promise<number>((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)));
const freePort = async () => {
  const s = createServer();
  const port = await listening(s);
  await new Promise((r) => s.close(r));
  return port;
};

test("frames survive any chunking, and one over 64 KiB ends the tunnel", () => {
  const bytes = Buffer.concat([frame(HELLO, 0, Buffer.from('{"port":20199}')), frame(OPEN, 7), frame(DATA, 7, Buffer.from("GET / HTTP/1.1\r\n")), frame(CLOSE, 7)]);
  const reader = new FrameReader();
  const frames = [];
  for (let i = 0; i < bytes.length; i += 3) frames.push(...reader.push(bytes.subarray(i, i + 3)));
  assert.deepEqual(frames.map((f) => [f.type, f.conn, f.payload.toString()]), [[HELLO, 0, '{"port":20199}'], [OPEN, 7, ""], [DATA, 7, "GET / HTTP/1.1\r\n"], [CLOSE, 7, ""]]);
  const big = Buffer.alloc(9);
  big.writeUInt8(DATA, 0);
  big.writeUInt32BE(1, 1);
  big.writeUInt32BE(MAX_PAYLOAD + 1, 5);
  assert.throws(() => new FrameReader().push(big), /over 64 KiB/);
});

test("the relay's ports: the user's range, highest first; anything else refused", () => {
  assert.deepEqual(relayPorts("20197-20199"), [20199, 20198, 20197]);
  for (const bad of [undefined, "", "80-90", "20199-20100", "1-2-3", "20100"]) assert.throws(() => relayPorts(bad), Error, String(bad));
});

test("the relay takes the highest free port of its range and carries each connection", async () => {
  const taken = await freePort();
  const squatter = createServer();
  await new Promise<void>((r) => squatter.listen(taken, "127.0.0.1", () => r()));
  const input = new PassThrough(), output = new PassThrough();
  const done = relay(input, output, [taken, taken - 1]);
  const reader = new FrameReader();
  const frames: ReturnType<FrameReader["push"]> = [];
  output.on("data", (chunk: Buffer) => frames.push(...reader.push(chunk)));
  const until = async (n: number) => {
    for (let i = 0; i < 200 && frames.length < n; i++) await new Promise((r) => setTimeout(r, 10));
  };
  await until(1);
  // A tenant's own server on the highest port: the relay takes the next one.
  assert.deepEqual(JSON.parse(frames[0]!.payload.toString()), { port: taken - 1 });
  squatter.close();
  input.end();
  await done;
});

test("an app on the phone reaches the developer's backend through the tunnel, and the request is captured", async () => {
  // The developer's backend on this machine.
  const backend = createServer((req, res) => {
    res.writeHead(req.url === "/items" ? 200 : 404, { "content-type": "application/json" });
    res.end(JSON.stringify({ path: req.url, from: "backend" }));
  });
  const backendPort = await listening(backend);
  // The relay as the host runs it, its stdio joined to the client's WebSocket.
  const toRelay = new PassThrough(), fromRelay = new PassThrough();
  const relayPort = await freePort();
  const relayDone = relay(toRelay, fromRelay, [relayPort]);
  class FakeSocket {
    static OPEN = 1;
    readyState = 1;
    bufferedAmount = 0;
    binaryType = "arraybuffer";
    onmessage?: (event: { data: ArrayBuffer }) => void;
    onclose?: () => void;
    protocols: string[];
    constructor(_url: string, protocols: string[]) {
      this.protocols = protocols;
      fromRelay.on("data", (chunk: Buffer) => this.onmessage?.({ data: chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength) as ArrayBuffer }));
      fromRelay.on("end", () => this.onclose?.());
    }
    send(bytes: Buffer) {
      toRelay.write(bytes);
    }
    close() {
      this.readyState = 3;
      toRelay.end();
    }
  }
  const saved = globalThis.WebSocket;
  (globalThis as { WebSocket: unknown }).WebSocket = FakeSocket;
  const asked: string[] = [];
  const api = { json: async (method: string, path: string) => (asked.push(`${method} ${path}`), { url: "wss://gw.test/api/v1/mac/sessions/ses_x/tunnel", token: "t0k3n", protocol: "nomac.tunnel" }) } as unknown as CloudApi;
  const seen: string[] = [];
  const tunnel = new Tunnel(api, "ses_x", backendPort, "127.0.0.1", (r) => seen.push(describeRequest(r, false)));
  try {
    assert.equal(await tunnel.start(), relayPort);
    assert.deepEqual(asked, ["POST /api/v1/simulator/sessions/ses_x/tunnel"]);
    // The phone's app asks http://127.0.0.1:<the relay's port>.
    const fetchOnPhone = (path: string) =>
      new Promise<{ status: number; body: string }>((resolve, reject) => {
        get({ host: "127.0.0.1", port: relayPort, path, agent: false }, (res) => {
          let body = "";
          res.on("data", (d: Buffer) => (body += d.toString()));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
        }).on("error", reject);
      });
    const ok = await fetchOnPhone("/items");
    assert.equal(ok.status, 200);
    assert.deepEqual(JSON.parse(ok.body), { path: "/items", from: "backend" });
    const missing = await fetchOnPhone("/nope");
    assert.equal(missing.status, 404);
    for (let i = 0; i < 100 && tunnel.requests.length < 2; i++) await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(tunnel.requests.map((r) => [r.method, r.path, r.status]), [["GET", "/items", 200], ["GET", "/nope", 404]]);
    assert.match(seen[0]!, /^GET \/items → 200 in \d+ ms$/);
    assert.ok(tunnel.requests[0]!.bytes > ok.body.length, "the request and its whole answer are counted");
  } finally {
    tunnel.stop();
    (globalThis as { WebSocket: unknown }).WebSocket = saved;
    await relayDone;
    backend.close();
  }
});

test("a tunnel back on another port of the phone says so once, with the port to use", async () => {
  // The phone's side: the first connection says port 20199 and drops; the next says 20198.
  const ports = [20199, 20198];
  const sockets: { close: () => void }[] = [];
  class FakeSocket {
    static OPEN = 1;
    readyState = 1;
    bufferedAmount = 0;
    binaryType = "arraybuffer";
    onmessage?: (event: { data: ArrayBuffer }) => void;
    onclose?: () => void;
    constructor() {
      const port = ports.shift()!;
      sockets.push(this);
      setTimeout(() => {
        const hello = frame(HELLO, 0, Buffer.from(JSON.stringify({ port })));
        this.onmessage?.({ data: hello.buffer.slice(hello.byteOffset, hello.byteOffset + hello.byteLength) as ArrayBuffer });
      }, 5);
    }
    send() {}
    close() {
      this.readyState = 3;
      this.onclose?.();
    }
  }
  const saved = globalThis.WebSocket;
  (globalThis as { WebSocket: unknown }).WebSocket = FakeSocket;
  const api = { json: async () => ({ url: "wss://gw.test/t", token: "t", protocol: "nomac.tunnel" }) } as unknown as CloudApi;
  const told: string[] = [];
  const tunnel = new Tunnel(api, "ses_x", 8080, "127.0.0.1", undefined, (n) => told.push(n));
  try {
    assert.equal(await tunnel.start(), 20199);
    assert.equal(tunnel.notice, undefined);
    sockets[0]!.close();
    for (let i = 0; i < 300 && tunnel.phonePort !== 20198; i++) await new Promise((r) => setTimeout(r, 10));
    assert.equal(tunnel.phonePort, 20198);
    assert.equal(tunnel.notice, 'The tunnel came back on another port of the phone, 20198 (it was 20199): app_run again with env "API_URL=http://127.0.0.1:20198" for an app that used the old one.');
    assert.deepEqual(told, [tunnel.notice]);
  } finally {
    tunnel.stop();
    (globalThis as { WebSocket: unknown }).WebSocket = saved;
  }
});
