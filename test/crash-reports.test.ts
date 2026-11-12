import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";

import { crashReports, HOST_CRASH_REPORTS, hostCrashReports } from "../src/engine/logs.ts";
import { serve } from "../src/mcp.ts";

const here = "5E55E550-0000-4000-8000-000000000001";
const report = (symbol: string, udid = here) =>
  `${JSON.stringify({ app_name: "Demo", bundleID: "dev.simtap.demo", bug_type: "309" })}\n${JSON.stringify({
    userID: 504, captureTime: "2026-11-11 19:14:02.6292 -0800", procPath: "/Volumes/VOLUME/*/Demo.app/Demo",
    coalitionName: `com.apple.CoreSimulator.SimDevice.${udid}`, exception: { type: "EXC_BREAKPOINT", signal: "SIGTRAP" }, faultingThread: 0,
    threads: [{ triggered: true, frames: [{ imageIndex: 0, symbol }] }], usedImages: [{ name: "Demo" }] })}`;

test("a crash report macOS has moved into Retired is read too, and one in both folders once", async () => {
  const dir = mkdtempSync(join(tmpdir(), "su-retired-"));
  mkdirSync(join(dir, "Retired"));
  writeFileSync(join(dir, "Retired", "Demo-2026-11-11-191404.ips"), report("only in Retired"));
  writeFileSync(join(dir, "Retired", "Demo-2026-11-11-191500.ips"), report("moved while read"));
  writeFileSync(join(dir, "Demo-2026-11-11-191500.ips"), report("moved while read"));
  const crashes = await crashReports("Demo", 0, { bundleId: "dev.simtap.demo", udid: here, dir });
  assert.deepEqual(crashes.map((c) => c.file.slice(dir.length + 1)).sort(), ["Demo-2026-11-11-191500.ips", "Retired/Demo-2026-11-11-191404.ips"].sort());
  assert.ok(crashes.some((c) => c.summary.some((l) => l.includes("only in Retired"))));
});

/** A hosted server on a pipe, with the host's side: what the server writes, line by line, and a way to answer. */
function hostedServer(capabilities: Record<string, unknown>) {
  const input = new PassThrough();
  const output = new PassThrough();
  const lines: Record<string, unknown>[] = [];
  let pending = "";
  output.on("data", (chunk: Buffer) => {
    pending += chunk.toString("utf8");
    const parts = pending.split("\n");
    pending = parts.pop() ?? "";
    for (const line of parts) if (line.trim()) lines.push(JSON.parse(line) as Record<string, unknown>);
  });
  const done = serve(input, output);
  input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities } })}\n`);
  const next = async (method: string) => {
    for (let i = 0; i < 200; i++) {
      const found = lines.find((l) => l.method === method);
      if (found) {
        lines.splice(lines.indexOf(found), 1);
        return found;
      }
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`no ${method}`);
  };
  return { input, lines, next, end: async () => (input.end(), await done) };
}

async function withHosted<T>(work: (state: string) => Promise<T>): Promise<T> {
  const saved = { hosted: process.env.SIMULATOR_USE_HOSTED, state: process.env.SIMULATOR_USE_STATE_DIR };
  const state = mkdtempSync(join(tmpdir(), "su-host-state-"));
  process.env.SIMULATOR_USE_HOSTED = "1";
  process.env.SIMULATOR_USE_STATE_DIR = state;
  try {
    return await work(state);
  } finally {
    for (const [key, value] of [["SIMULATOR_USE_HOSTED", saved.hosted], ["SIMULATOR_USE_STATE_DIR", saved.state]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("on NoMac's phone host the phone's crash reports come from the host, as macOS wrote them, into simulator-use's own folder", async () => {
  await withHosted(async (state) => {
    const server = hostedServer({ experimental: { [HOST_CRASH_REPORTS]: {} } });
    await new Promise((r) => setTimeout(r, 20));
    const asked = hostCrashReports();
    const request = await server.next(HOST_CRASH_REPORTS);
    assert.equal(typeof request.id, "string", "a string id, never one of the host's own numbers");
    assert.deepEqual(request.params, {});
    const at = Date.parse("2026-11-12T03:14:44Z");
    server.input.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { reports: [
      { name: "Demo-2026-11-11-191404.ips", modified_ms: at, text: report("from the host") },
      // Names that would leave the folder or hide in it are never written.
      { name: "../Demo-2026-11-11-191405.ips", modified_ms: at, text: report("escaped") },
      { name: ".Demo-2026-11-11-191406.ips", modified_ms: at, text: report("hidden") },
      { name: "Demo-2026-11-11-191407.ips", modified_ms: at, text: 5 },
    ] } })}\n`);
    const dir = await asked;
    assert.equal(dir, join(state, "crash-reports"));
    assert.deepEqual(readdirSync(dir!), ["Demo-2026-11-11-191404.ips"]);
    assert.deepEqual(readdirSync(state).sort(), ["crash-reports"]);
    assert.equal(statSync(join(dir!, "Demo-2026-11-11-191404.ips")).mtimeMs, at);
    assert.equal(statSync(join(dir!, "Demo-2026-11-11-191404.ips")).mode & 0o777, 0o600);
    const crashes = await crashReports("Demo", at - 1000, { bundleId: "dev.simtap.demo", udid: here, dir: [dir!, join(state, "home-reports")] });
    assert.equal(crashes.length, 1);
    assert.ok(crashes[0]!.summary.some((l) => l.includes("from the host")));
    // The next read starts afresh: what the host no longer hands over is gone.
    const again = hostCrashReports();
    const second = await server.next(HOST_CRASH_REPORTS);
    server.input.write(`${JSON.stringify({ jsonrpc: "2.0", id: second.id, result: { reports: [] } })}\n`);
    assert.deepEqual(readdirSync((await again)!), []);
    // A host that refuses says so.
    const refused = hostCrashReports();
    const third = await server.next(HOST_CRASH_REPORTS);
    server.input.write(`${JSON.stringify({ jsonrpc: "2.0", id: third.id, error: { code: -32000, message: "crash_reports_unavailable" } })}\n`);
    await assert.rejects(refused, /crash_reports_unavailable/);
    // Answers to the server's own requests are never taken for requests to answer.
    assert.equal(server.lines.filter((l) => l.error).length, 0, JSON.stringify(server.lines));
    await server.end();
  });
});

test("a host that offers no crash reports is never asked, and a developer's Mac reads only its home", async () => {
  await withHosted(async () => {
    const server = hostedServer({});
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(await hostCrashReports(), undefined);
    await server.end();
    assert.equal(server.lines.filter((l) => l.method).length, 0);
  });
  assert.equal(await hostCrashReports(), undefined);
});
