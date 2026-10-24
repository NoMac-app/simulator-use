import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { cloudState, setCloudState } from "../src/cloud/account.ts";
import { listProject } from "../src/cloud/sync.ts";
import { callTool } from "../src/registry.ts";

// A stand-in for NoMac's API, scripted per test: each route answers from the queue given, the last answer repeating.
let server: Server;
const seen: { method: string; path: string; body: unknown }[] = [];
let script: Record<string, unknown[]> = {};
const read = (req: IncomingMessage) => new Promise<Buffer>((resolve) => { const parts: Buffer[] = []; req.on("data", (d: Buffer) => parts.push(d)); req.on("end", () => resolve(Buffer.concat(parts))); });
const done = (text: string, isError = false) => ({ status: 200, body: { state: "done", result: { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) } } });

before(async () => {
  server = createServer(async (req, res) => {
    const raw = await read(req);
    const path = req.url ?? "";
    seen.push({ method: req.method ?? "", path, body: raw.length && req.headers["content-type"] === "application/json" ? JSON.parse(raw.toString()) : undefined });
    const queue = script[`${req.method} ${path}`];
    const answer = (queue && (queue.length > 1 ? queue.shift() : queue[0])) as { status: number; body: unknown } | undefined;
    res.writeHead(answer?.status ?? 404, { "content-type": "application/json" });
    res.end(JSON.stringify(answer?.body ?? { error: { code: "not_found", message: path } }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  process.env.NOMAC_API_URL = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  process.env.NOMAC_API_KEY = "nmk_test";
  process.env.SIMULATOR_USE_STATE_DIR = mkdtempSync(join(tmpdir(), "su-calls-state-"));
});
after(() => { server.close(); delete process.env.NOMAC_API_URL; delete process.env.NOMAC_API_KEY; delete process.env.SIMULATOR_USE_STATE_DIR; });

const PHONE = "/api/v1/simulator/sessions/ses_p";
const onPhone = async () => { seen.length = 0; await setCloudState({ on: true, session: "ses_p" }); };

test("a phone still starting is waited for and the call goes through, never taken for ended", async () => {
  await onPhone();
  script = {
    [`POST ${PHONE}/tools/ui_look`]: [
      { status: 409, body: { error: { code: "session_not_ready", message: "The phone is still starting.", state: "queued", starting: true, retry_after_seconds: 15 } } },
      done("Demo · Sign In"),
    ],
    [`GET ${PHONE}`]: [{ status: 200, body: { session: { id: "ses_p", state: "queued" } } }, { status: 200, body: { session: { id: "ses_p", state: "ready" } } }],
  };
  const answer = await callTool("ui_look", {}, { waitForJobs: true });
  assert.equal(answer.isError, undefined, answer.text);
  assert.equal(answer.text, "Demo · Sign In");
  assert.equal((await cloudState()).session, "ses_p", "the phone is kept");
});

test("a phone that stays queued past the wait says so and is kept for the next call", async () => {
  await onPhone();
  script = {
    [`POST ${PHONE}/tools/ui_look`]: [{ status: 409, body: { error: { code: "session_not_ready", message: "The phone is still starting.", starting: true } } }],
    [`GET ${PHONE}`]: [{ status: 200, body: { session: { id: "ses_p", state: "queued", message: "Every phone is in use: it is next." } } }],
  };
  const answer = await callTool("ui_look", {});
  assert.equal(answer.isError, true);
  assert.match(answer.text, /^The cloud phone ses_p is still starting: Every phone is in use: it is next\.\nNext: ui_look again in a moment \(nothing ran\)/);
  assert.equal((await cloudState()).session, "ses_p");
});

test("a job still running after a job_status is read again until it ends (a test run past 80 s)", async () => {
  await onPhone();
  const running = done("Tests: testing, 1 min 20 s so far (job_2).\nNext: job_status again, or job_cancel.");
  script = {
    [`POST ${PHONE}/tools/job_status`]: [running, running, done("Tests passed: 3 passed, 0 failed (3 in 95 s).")],
    [`POST ${PHONE}/tools/screen_record`]: [done('Tests is still building after 40 s: job job_2.\nNext: job_status {job_id: "job_2"}; it waits up to 40 s for the result.')],
  };
  // Any tool that hands back a job is followed the same way; screen_record needs no project to send.
  const answer = await callTool("screen_record", { action: "start" }, { waitForJobs: true });
  assert.equal(answer.text, "Tests passed: 3 passed, 0 failed (3 in 95 s).");
  assert.deepEqual(seen.filter((r) => r.path.endsWith("/tools/job_status")).map((r) => r.body), [{ job_id: "job_2" }, { job_id: "job_2" }, { job_id: "job_2" }]);
});

test("another build's job named in a busy error is not followed", async () => {
  await onPhone();
  script = { [`POST ${PHONE}/tools/screen_record`]: [done('Build is already running for Demo; two builds of one project would clash.\nNext: job_status {job_id: "job_9"} to follow it, or job_cancel it first.', true)] };
  const answer = await callTool("screen_record", { action: "start" }, { waitForJobs: true });
  assert.equal(answer.isError, true);
  assert.equal(seen.filter((r) => r.path.endsWith("/tools/job_status")).length, 0);
});

test("a stop that did not reach NoMac keeps the phone, says it still bills, and can be sent again", async () => {
  await onPhone();
  script = { [`DELETE ${PHONE}`]: [{ status: 500, body: { error: { code: "compute_temporarily_unavailable", message: "The request could not be confirmed." } } }] };
  const answer = await callTool("cloud", { action: "stop" });
  assert.equal(answer.isError, true);
  assert.match(answer.text, /^Could not stop the cloud phone ses_p: The request could not be confirmed\. It runs, and bills, until its idle stop\.\nNext: cloud stop again\./);
  assert.deepEqual(await cloudState(), { on: true, session: "ses_p" });
});

test("an app is sent whole, its own folders too, and nothing beside it is read", () => {
  const dir = mkdtempSync(join(tmpdir(), "su-app-"));
  mkdirSync(join(dir, "My.app/assets/node_modules/pkg"), { recursive: true });
  mkdirSync(join(dir, "My.app/build"), { recursive: true });
  writeFileSync(join(dir, "My.app/My"), "binary");
  writeFileSync(join(dir, "My.app/assets/node_modules/pkg/index.js"), "x");
  writeFileSync(join(dir, "My.app/build/main.js"), "x");
  writeFileSync(join(dir, "elsewhere.zip"), "not read");
  assert.deepEqual(listProject(dir, "My.app").map((e) => e.path), ["My.app/My", "My.app/assets/node_modules/pkg/index.js", "My.app/build/main.js"]);
});
