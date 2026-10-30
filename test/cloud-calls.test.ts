import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { promisify } from "node:util";

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
    const answer = (queue && (queue.length > 1 ? queue.shift() : queue[0])) as { status: number; body: unknown; file?: Buffer } | undefined;
    if (answer?.file) { res.writeHead(answer.status, { "content-type": "application/octet-stream" }); res.end(answer.file); return; }
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

test("an app is sent whole, its own folders too, and nothing beside it is read", async () => {
  const dir = mkdtempSync(join(tmpdir(), "su-app-"));
  mkdirSync(join(dir, "My.app/assets/node_modules/pkg"), { recursive: true });
  mkdirSync(join(dir, "My.app/build"), { recursive: true });
  writeFileSync(join(dir, "My.app/My"), "binary");
  writeFileSync(join(dir, "My.app/assets/node_modules/pkg/index.js"), "x");
  writeFileSync(join(dir, "My.app/build/main.js"), "x");
  writeFileSync(join(dir, "elsewhere.zip"), "not read");
  assert.deepEqual((await listProject(dir, "My.app")).map((e) => e.path), ["My.app/My", "My.app/assets/node_modules/pkg/index.js", "My.app/build/main.js"]);
});

test("a screenshot file ui_look saves on the phone is saved on this machine, its path in the answer as the local tool's", async () => {
  await onPhone();
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
  const token = `${Buffer.from(JSON.stringify({ s: "ses_p", f: `file_${"a".repeat(40)}`, n: "screen-B618F794-1792.png" })).toString("base64url")}.sig`;
  const link = `${process.env.NOMAC_API_URL}/api/v1/simulator/files/${token}`;
  script = { [`POST ${PHONE}/tools/ui_look`]: [done(`Demo · Sign In\nscreenshot file: ${link}`)], [`GET /api/v1/simulator/files/${token}`]: [{ status: 200, body: null, file: png }] };
  const file = join(process.env.SIMULATOR_USE_STATE_DIR!, "screen-B618F794-1792.png");
  assert.equal((await callTool("ui_look", { screenshot_file: true })).text, `Demo · Sign In\nscreenshot file: ${file}`);
  assert.deepEqual(readFileSync(file), png);
  assert.deepEqual(seen.find((r) => r.path === `${PHONE}/tools/ui_look`)?.body, { screenshot_file: true });
  // A link that cannot be saved stays a link; any other answer's links are left alone.
  script = { [`POST ${PHONE}/tools/ui_look`]: [done(`Demo · Sign In\nscreenshot file: ${link}`)], [`GET /api/v1/simulator/files/${token}`]: [{ status: 410, body: { error: { code: "file_gone" } } }] };
  assert.equal((await callTool("ui_look", { screenshot_file: true })).text, `Demo · Sign In\nscreenshot file: ${link}`);
  script = { [`POST ${PHONE}/tools/app_logs`]: [done(`Saved: ${link}`)] };
  assert.equal((await callTool("app_logs", {})).text, `Saved: ${link}`);
});

test("a phone's stop notice is said after the answer, in cloud mode's own way on", async () => {
  await onPhone();
  const limit = { minutes_left: 9, reason: "time_limit", next_action: "save_state", message: "This phone stops in about 9 minutes (21:40 UTC): it reaches its time limit, which a running phone cannot raise." };
  const credit = { minutes_left: 9, reason: "credit", next_action: "buy_credit", message: "This phone stops in about 9 minutes (21:40 UTC): the account's credit runs out." };
  script = { [`POST ${PHONE}/tools/ui_look`]: [{ status: 200, body: { state: "done", stop_notice: limit, result: { content: [{ type: "text", text: "Demo · Sign In" }] } } }] };
  assert.equal((await callTool("ui_look", {})).text, "Demo · Sign In\nThe cloud phone stops in about 9 minutes, at its time limit: cloud extend keeps it running an hour longer. Once it stops, its apps and data go with it; the project's build stays, so the next cloud start builds incrementally.");
  script = { [`POST ${PHONE}/tools/ui_look`]: [{ status: 200, body: { state: "done", stop_notice: credit, result: { content: [{ type: "text", text: "Demo · Sign In" }] } } }] };
  assert.equal((await callTool("ui_look", {})).text, `Demo · Sign In\n${credit.message}`);
  script = { [`POST ${PHONE}/tools/ui_look`]: [done("Demo · Sign In")] };
  assert.equal((await callTool("ui_look", {})).text, "Demo · Sign In");
});

test("cloud run over MCP answers at once with the steps to take instead, and starts nothing", async () => {
  seen.length = 0;
  await setCloudState({ on: false });
  const answer = await callTool("cloud", { action: "run", path: "." });
  assert.equal(answer.isError, true);
  assert.equal(answer.text, "cloud run is for the command line and CI: it takes minutes, longer than a tool call waits. Nothing ran.\nNext: cloud start, then app_run (tests_run for the tests), then cloud stop.");
  assert.deepEqual(seen, []);
});

const ROOT = new URL("..", import.meta.url).pathname;
const CLI = join(ROOT, "test/fixtures/cli-main.ts");

test("an MCP server's cloud phone is its own: another process on the machine does not see it", async () => {
  await setCloudState({ on: true, session: "ses_mine" });
  const other = await promisify(execFile)(process.execPath, ["--input-type=module", "-e",
    `const m = await import(${JSON.stringify(join(ROOT, "src/cloud/account.ts"))}); console.log(JSON.stringify(await m.cloudState()));`]);
  assert.deepEqual(JSON.parse(other.stdout), { on: false });
  assert.deepEqual(await cloudState(), { on: true, session: "ses_mine" });
  await setCloudState({ on: false });
});

test("the CLI's look --out saves the screen where asked, and app launch sends its arguments as one value", async () => {
  seen.length = 0;
  const state = mkdtempSync(join(tmpdir(), "su-cli-out-"));
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "su-cli-out-cwd-")));
  writeFileSync(join(state, "cloud.json"), JSON.stringify({ on: true, session: "ses_out" }));
  const cli = (...args: string[]) => promisify(execFile)(process.execPath, [CLI, ...args], { cwd, env: { ...process.env, SIMULATOR_USE_STATE_DIR: state } });
  const tools = "/api/v1/simulator/sessions/ses_out/tools";
  // A .png is the phone's full-resolution file, fetched and moved to the name given (folders made as needed).
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 4, 5, 6]);
  const token = `${Buffer.from(JSON.stringify({ s: "ses_out", f: `file_${"b".repeat(40)}`, n: "screen-0UT-1.png" })).toString("base64url")}.sig`;
  script = { [`POST ${tools}/ui_look`]: [done(`Demo · Sign In\nscreenshot file: ${process.env.NOMAC_API_URL}/api/v1/simulator/files/${token}`)], [`GET /api/v1/simulator/files/${token}`]: [{ status: 200, body: null, file: png }] };
  const full = await cli("look", "--out", "store/onb-1.png");
  assert.equal(full.stdout.trim(), `Demo · Sign In\nscreenshot file: ${join(cwd, "store/onb-1.png")}`);
  assert.deepEqual(readFileSync(join(cwd, "store/onb-1.png")), png);
  assert.deepEqual(seen.find((r) => r.path === `${tools}/ui_look`)?.body, { screenshot_file: true });
  // A .jpg is the picture sized to points, as the agent's screenshot.
  const jpeg = Buffer.from("jpeg-bytes");
  script = { [`POST ${tools}/ui_look`]: [{ status: 200, body: { state: "done", result: { content: [{ type: "text", text: "Demo · Home" }, { type: "image", data: jpeg.toString("base64"), mimeType: "image/jpeg" }] } } }] };
  seen.length = 0;
  const small = await cli("look", "--find", "Home", "--out=shots/home.jpg");
  assert.equal(small.stdout.trim(), `Demo · Home\nscreenshot: ${join(cwd, "shots/home.jpg")}`);
  assert.deepEqual(readFileSync(join(cwd, "shots/home.jpg")), jpeg);
  assert.deepEqual(seen.find((r) => r.path === `${tools}/ui_look`)?.body, { find: "Home", screenshot: true });
  // A file that could not be fetched is an error that says so, the link kept.
  script = { [`POST ${tools}/ui_look`]: [done(`Demo · Sign In\nscreenshot file: ${process.env.NOMAC_API_URL}/api/v1/simulator/files/${token}`)], [`GET /api/v1/simulator/files/${token}`]: [{ status: 410, body: { error: { code: "file_gone" } } }] };
  await assert.rejects(cli("look", "--out", "store/onb-2.png"), (error: { code: number; stderr: string }) => error.code === 1 && /could not be saved to .*onb-2\.png/.test(error.stderr));
  await assert.rejects(cli("look", "--out", "a.gif"), (error: { code: number; stderr: string }) => error.code === 2 && /--out takes a \.jpg/.test(error.stderr));
  // The phone gets a launch's arguments as the value, quoted so it splits them back as typed.
  script = { [`POST ${tools}/app_control`]: [done("Launched Demo with 4 arguments in 1.2 s.")] };
  seen.length = 0;
  await cli("app", "launch", "dev.example.app", "-Step", "3", "-AutoAsk", "How do I say no?");
  assert.deepEqual(seen.find((r) => r.path === `${tools}/app_control`)?.body, { action: "launch", value: "dev.example.app -Step 3 -AutoAsk 'How do I say no?'" });
  // After "--", -h is the app's argument, not a request for help.
  seen.length = 0;
  const launched = await cli("app", "launch", "dev.example.app", "--", "-h");
  assert.match(launched.stdout, /^Launched Demo/);
  assert.deepEqual(seen.find((r) => r.path === `${tools}/app_control`)?.body, { action: "launch", value: "dev.example.app -h" });
  // A file that cannot be written (a folder by that name) is a plain error, not a crash.
  mkdirSync(join(cwd, "taken.jpg"));
  script = { [`POST ${tools}/ui_look`]: [{ status: 200, body: { state: "done", result: { content: [{ type: "text", text: "Demo · Home" }, { type: "image", data: jpeg.toString("base64"), mimeType: "image/jpeg" }] } } }] };
  await assert.rejects(cli("look", "--out", "taken.jpg"), (error: { code: number; stderr: string }) => error.code === 1 && /The screenshot could not be saved to .*taken\.jpg: EISDIR/.test(error.stderr) && !/\n\s+at /.test(error.stderr));
});

test("the CLI keeps cloud mode between its commands", async () => {
  seen.length = 0;
  const state = mkdtempSync(join(tmpdir(), "su-cli-cloud-"));
  writeFileSync(join(state, "cloud.json"), JSON.stringify({ on: true, session: "ses_cli" }));
  script = { "GET /api/v1/simulator/sessions/ses_cli": [{ status: 200, body: { session: { id: "ses_cli", state: "ready", cost: { accrued_microunits: "40000", billable_seconds: 180 } } } }] };
  const status = await promisify(execFile)(process.execPath, [CLI, "cloud", "status"], { env: { ...process.env, SIMULATOR_USE_STATE_DIR: state } });
  assert.match(status.stdout, /^Cloud is on: phone ses_cli is ready; 3 min so far, \$0\.04/);
  // A phone that says when it is ready and its limit says when it stops, and how to keep it.
  script = { "GET /api/v1/simulator/sessions/ses_cli": [{ status: 200, body: { session: { id: "ses_cli", state: "ready", ready_at: "2026-10-25T10:00:00.000Z", limits: { max_duration_seconds: 7200 }, cost: { accrued_microunits: "40000", billable_seconds: 180 } } } }] };
  const timed = await promisify(execFile)(process.execPath, [CLI, "cloud", "status"], { env: { ...process.env, SIMULATOR_USE_STATE_DIR: state } });
  assert.match(timed.stdout, /It stops by 12:00 UTC at the latest; cloud extend keeps it longer\./);
});

test("an MCP server stops the cloud phone it started when its client closes it", async () => {
  seen.length = 0;
  script = {
    "POST /api/v1/simulator/sessions": [{ status: 201, body: { session: { id: "ses_srv", state: "queued" }, links: {} } }],
    "GET /api/v1/simulator/sessions/ses_srv": [{ status: 200, body: { session: { id: "ses_srv", state: "ready" } } }],
    "DELETE /api/v1/simulator/sessions/ses_srv": [{ status: 202, body: { session: { id: "ses_srv", state: "stopping" } } }],
  };
  const server = spawn(process.execPath, [CLI, "mcp"], { env: { ...process.env, SIMULATOR_USE_STATE_DIR: mkdtempSync(join(tmpdir(), "su-mcp-cloud-")) }, stdio: ["pipe", "pipe", "inherit"] });
  const answered = new Promise<string>((resolve) => server.stdout.once("data", (d: Buffer) => resolve(d.toString())));
  server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "cloud", arguments: { action: "start" } } })}\n`);
  assert.match(await answered, /Cloud phone ready/);
  const exited = new Promise<number | null>((resolve) => server.once("exit", resolve));
  server.stdin.end();
  assert.equal(await exited, 0);
  assert.ok(seen.some((r) => r.method === "DELETE" && r.path === "/api/v1/simulator/sessions/ses_srv"), JSON.stringify(seen.map((r) => `${r.method} ${r.path}`)));
});

test("cloud start takes a device: an iPad is asked for, and one asked for while an iPhone runs says so", async () => {
  seen.length = 0;
  await setCloudState({ on: false });
  script = {
    "POST /api/v1/simulator/sessions": [{ status: 202, body: { session: { id: "ses_pad", state: "queued" }, links: {} } }],
    "GET /api/v1/simulator/sessions/ses_pad": [{ status: 200, body: { session: { id: "ses_pad", state: "ready", device: "ipad" } } }],
  };
  const started = await callTool("cloud", { action: "start", device: "ipad" });
  assert.match(started.text, /^Cloud phone ready in [\d.]+ s: an iPad Simulator on a NoMac Mac/);
  assert.deepEqual(seen.find((r) => r.method === "POST")!.body, { device: "ipad" });
  script = { "GET /api/v1/simulator/sessions/ses_pad": [{ status: 200, body: { session: { id: "ses_pad", state: "ready", device: "ipad" } } }] };
  const other = await callTool("cloud", { action: "start", device: "iphone" });
  assert.equal(other.isError, true);
  assert.equal(other.text, "Cloud already has phone ses_pad, an iPad.\nNext: cloud stop, then cloud start with device iphone.");
  await setCloudState({ on: false });
  // The 6.9-inch iPhone, for App Store screenshots, is asked for the same way.
  seen.length = 0;
  script = {
    "POST /api/v1/simulator/sessions": [{ status: 202, body: { session: { id: "ses_max", state: "queued" }, links: {} } }],
    "GET /api/v1/simulator/sessions/ses_max": [{ status: 200, body: { session: { id: "ses_max", state: "ready", device: "iphone-pro-max" } } }],
  };
  const max = await callTool("cloud", { action: "start", device: "iphone-pro-max" });
  assert.match(max.text, /^Cloud phone ready in [\d.]+ s: an iPhone Pro Max Simulator on a NoMac Mac/);
  assert.deepEqual(seen.find((r) => r.method === "POST")!.body, { device: "iphone-pro-max" });
  await setCloudState({ on: false });
});

test("cloud extend keeps the phone an hour longer, or the minutes the command line names; at its longest it says what then", async () => {
  await onPhone();
  const extended = { status: 200, body: { session: { id: "ses_p", state: "ready", ready_at: "2026-10-25T10:00:00.000Z", limits: { max_duration_seconds: 10_800 } }, links: {} } };
  script = { [`POST ${PHONE}/extend`]: [extended] };
  const answer = await callTool("cloud", { action: "extend" });
  assert.equal(answer.isError, undefined, answer.text);
  assert.equal(answer.text, "The cloud phone ses_p runs until 13:00 UTC at the latest, if the account's credit lasts. cloud extend again near then, up to 8 hours in all.");
  assert.deepEqual(seen.at(-1)!.body, { minutes: 60 });
  await callTool("cloud", { action: "extend", path: "30" }, { waitForJobs: true });
  assert.deepEqual(seen.at(-1)!.body, { minutes: 30 });
  script = { [`POST ${PHONE}/extend`]: [{ status: 409, body: { error: { code: "session_at_longest", message: "This phone already runs to the longest a session can, 8 hours." } } }] };
  const longest = await callTool("cloud", { action: "extend" });
  assert.equal(longest.isError, true);
  assert.equal(longest.text, "NoMac: This phone already runs to the longest a session can, 8 hours.\nNext: When it stops, cloud start: the next build is incremental.");
});
