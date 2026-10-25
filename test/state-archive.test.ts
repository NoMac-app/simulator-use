import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { buffer } from "node:stream/consumers";
import { test } from "node:test";
import { fetchState, opener, sealer, stateKey, uploadState } from "../src/state-archive.ts";

const key = randomBytes(32);
const seal = async (plain: Buffer, k = key) => buffer(Readable.from([plain]).pipe(sealer(k)));
const open = async (sealed: Buffer, k = key) => buffer(Readable.from([sealed]).pipe(opener(k)));

test("a sealed state opens to the same bytes, in one frame or many, and empty", async () => {
  for (const size of [0, 10, 4 * 1024 * 1024, 4 * 1024 * 1024 + 1, 9 * 1024 * 1024 + 7]) {
    const plain = randomBytes(size);
    assert.ok((await open(await seal(plain))).equals(plain), `size ${size}`);
  }
});

test("a state changed, cut short, reordered, under another key or not ours is refused", async () => {
  const plain = randomBytes(9 * 1024 * 1024);
  const sealed = await seal(plain);
  const frame = 4 + 12 + 4 * 1024 * 1024 + 16;
  const changed = Buffer.from(sealed); changed[100] = changed[100]! ^ 1;
  await assert.rejects(open(changed), /does not open/);
  // Without its last frame, it ends as if whole frames were all there is: refused as cut short.
  await assert.rejects(open(sealed.subarray(0, 4 + 2 * frame)), /cut short/);
  // Two frames swapped: each is sealed with its place.
  const swapped = Buffer.concat([sealed.subarray(0, 4), sealed.subarray(4 + frame, 4 + 2 * frame), sealed.subarray(4, 4 + frame), sealed.subarray(4 + 2 * frame)]);
  await assert.rejects(open(swapped), /does not open/);
  await assert.rejects(open(sealed, randomBytes(32)), /does not open/);
  await assert.rejects(open(Buffer.from("PK\u0003\u0004 a zip")), /not a NoMac phone state/);
  // Data after the last frame.
  await assert.rejects(open(Buffer.concat([sealed, (await seal(Buffer.from("more"))).subarray(4)])), /after the last frame|does not open/);
  assert.throws(() => stateKey("short"), /invalid_state_key/);
});

test("a state goes to its link sealed and comes back from it into place, a bad one leaving the old copy as it was", async () => {
  let stored = Buffer.alloc(0);
  const server = createServer(async (req, res) => {
    if (req.method === "PUT") { stored = await buffer(req); res.writeHead(200).end(); return; }
    if (req.url === "/state") { res.writeHead(200).end(stored); return; }
    if (req.url === "/changed") { const bad = Buffer.from(stored); bad[bad.length - 5] = bad[bad.length - 5]! ^ 1; res.writeHead(200).end(bad); return; }
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const from = mkdtempSync(join(tmpdir(), "su-states-"));
    mkdirSync(join(from, "signed-in", "data", "Library"), { recursive: true });
    writeFileSync(join(from, "signed-in", "state.json"), JSON.stringify({ name: "signed-in", saved_at: "2026-10-25T10:00:00.000Z" }));
    writeFileSync(join(from, "signed-in", "data", "Library", "app.db"), randomBytes(5 * 1024 * 1024));
    const k = randomBytes(32).toString("base64url");
    const sent = await uploadState(from, "signed-in", `${base}/state`, k, mkdtempSync(join(tmpdir(), "su-tmp-")));
    assert.equal(sent, stored.length);
    assert.ok(!stored.includes(Buffer.from("signed-in")), "nothing of the state is readable in storage");
    // Another phone's workspace, with an older copy of the same name.
    const to = mkdtempSync(join(tmpdir(), "su-states-"));
    mkdirSync(join(to, "signed-in"), { recursive: true });
    writeFileSync(join(to, "signed-in", "state.json"), "older");
    await assert.rejects(fetchState(to, "signed-in", `${base}/changed`, k), /does not open/);
    assert.equal(readFileSync(join(to, "signed-in", "state.json"), "utf8"), "older", "a state that did not open leaves the old copy");
    await fetchState(to, "signed-in", `${base}/state`, k);
    assert.ok(readFileSync(join(to, "signed-in", "data", "Library", "app.db")).equals(readFileSync(join(from, "signed-in", "data", "Library", "app.db"))));
    assert.match(readFileSync(join(to, "signed-in", "state.json"), "utf8"), /2026-10-25T10:00:00/);
    assert.deepEqual(existsSync(join(to, ".signed-in.fetching")), false);
    await assert.rejects(fetchState(to, "signed-in", `${base}/missing`, k), /answered 404/);
  } finally {
    server.close();
  }
});
