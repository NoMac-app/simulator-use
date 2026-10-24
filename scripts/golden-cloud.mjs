#!/usr/bin/env node
// The golden tasks on a NoMac cloud phone, measured: for each task, whether it passed, how long it took as the agent
// waits for it, and the tokens of the answer the agent reads (characters / 4). The scoreboard's numbers (NoMac
// Simulator plan, LIM-18) come from this script, so anyone with a NoMac key can run it again.
// Usage: NOMAC_API_KEY=nmk_... node scripts/golden-cloud.mjs [--out results.json]
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";

const BASE = (process.env.NOMAC_API_URL ?? "https://nomac.app").replace(/\/+$/, "");
const KEY = process.env.NOMAC_API_KEY;
if (!KEY) {
  console.error("Set NOMAC_API_KEY (a NoMac account's key).");
  process.exit(2);
}
const outFile = process.argv.includes("--out") ? process.argv[process.argv.indexOf("--out") + 1] : undefined;
const REPO = "https://github.com/NoMac-app/simulator-use";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tokens = (text) => Math.ceil(text.length / 4);

async function api(method, path, body, key) {
  const headers = { authorization: `Bearer ${KEY}`, ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(key ? { "idempotency-key": key } : {}) };
  const r = await fetch(`${BASE}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(120_000) });
  const json = await r.json().catch(() => ({}));
  if (!r.ok && !(r.status === 202)) throw new Error(`${method} ${path}: ${r.status} ${json.error?.code ?? ""} ${json.error?.message ?? ""}`.trim());
  return json;
}

let phone;
const tool = async (name, args) => {
  let answer = await api("POST", `/api/v1/simulator/sessions/${phone}/tools/${name}`, args, `golden-${name}-${randomBytes(6).toString("hex")}`);
  while (answer.state === "running" && answer.id) {
    await sleep(500);
    answer = await api("GET", `/api/v1/simulator/sessions/${phone}/calls/${answer.id}`);
  }
  let text = (answer.result?.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
  // A long build answers with a job: follow it, as an agent does.
  for (let i = 0; i < 60 && /Next: job_status/.test(text); i++) text = await tool("job_status", {}).then((r) => r.text);
  return { text, isError: Boolean(answer.result?.isError) };
};

const results = [];
async function task(name, pattern, run) {
  const started = Date.now();
  let text = "", passed = false, error;
  try {
    const out = await run();
    text = out.text;
    passed = new RegExp(pattern).test(text);
  } catch (e) {
    error = e.message;
  }
  const row = { task: name, passed, seconds: Number(((Date.now() - started) / 1000).toFixed(2)), tokens: tokens(text), ...(error ? { error } : {}) };
  results.push(row);
  console.log(`${passed ? "PASS" : "FAIL"} ${name}: ${row.seconds} s, ${row.tokens} tokens${error ? ` (${error})` : ""}`);
}

try {
  const startedAt = Date.now();
  const started = await api("POST", "/api/v1/simulator/sessions", {}, `golden-start-${randomBytes(6).toString("hex")}`);
  phone = started.session.id;
  let state = started.session.state;
  while (!["ready", "failed", "stopped"].includes(state)) {
    await sleep(500);
    state = (await api("GET", `/api/v1/simulator/sessions/${phone}`)).session.state;
  }
  results.push({ task: "a phone, ready", passed: state === "ready", seconds: Number(((Date.now() - startedAt) / 1000).toFixed(2)), tokens: 0 });
  console.log(`${state === "ready" ? "PASS" : "FAIL"} a phone, ready: ${results[0].seconds} s`);
  if (state !== "ready") throw new Error(`the phone did not start: ${state}`);
  let root = "";
  await task("the project from git", "^/", async () => {
    let r = await api("POST", `/api/v1/simulator/sessions/${phone}/sync/git`, { url: REPO }, "golden-git");
    while (r.state === "running") r = await api("POST", `/api/v1/simulator/sessions/${phone}/sync/git`, { url: REPO }, "golden-git");
    root = `${r.root}/examples/swiftui-demo`;
    return { text: r.root ?? "" };
  });
  await task("build, install and launch in one call", "#signIn @", () => tool("app_run", { path: root }));
  await task("read the screen", '#email', () => tool("ui_look", {}));
  await task("sign in", "Welcome, gary@example\\.com", () => tool("ui_act", { steps: ["fill #email gary@example.com", "fill #password secret1", "tap #signIn", 'wait "Welcome"'] }));
  await task("toggle a switch", '#remember "Remember me" on', () => tool("ui_act", { steps: ["tap #remember"] }));
  await task("open an item", "Details for Item 3", () => tool("ui_act", { steps: ["tap Items", 'tap "Item 3"'] }));
  await task("back and scroll", "scroll: \\d+ pages?, at \\d+%", () => tool("ui_act", { steps: ["back", "scroll down"] }));
  await task("the app's print output", "Sign In tapped, ok: true", () => tool("app_logs", {}));
  await task("find a crash", "App\\.swift:\\d+: Fatal error", async () => {
    await tool("ui_act", { steps: ["tap #crash"] });
    return tool("app_logs", { crashes: true });
  });
  await task("the tests pass", "Tests passed: 3 passed, 0 failed", () => tool("tests_run", { path: root }));
  await task("a wrong password fails loudly", "did not appear", async () => {
    await tool("app_control", { action: "launch", app: "dev.simtap.demo" });
    return tool("ui_act", { steps: ["fill #email bad", "tap #signIn", 'wait "Welcome" 2'] });
  });
} catch (error) {
  console.error(`stopped: ${error.message}`);
} finally {
  if (phone) {
    const stopped = await api("DELETE", `/api/v1/simulator/sessions/${phone}`).catch(() => undefined);
    console.log(`phone stopped${stopped?.session ? `, ${stopped.session.state}` : ""}`);
  }
}

const passed = results.filter((r) => r.passed).length;
const table = ["| Task | Passed | Seconds | Tokens read |", "| --- | --- | --- | --- |", ...results.map((r) => `| ${r.task} | ${r.passed ? "yes" : "no"} | ${r.seconds} | ${r.tokens} |`)].join("\n");
console.log(`\n${passed} of ${results.length} passed, ${results.reduce((n, r) => n + r.tokens, 0)} tokens in all.\n\n${table}`);
if (outFile) writeFileSync(outFile, JSON.stringify({ at: new Date().toISOString(), base: BASE, results }, null, 2));
process.exit(passed === results.length ? 0 : 1);
