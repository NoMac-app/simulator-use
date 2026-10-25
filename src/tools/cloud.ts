import { createWriteStream, existsSync } from "node:fs";
import { unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import { account, cloudState, setCloudState, signIn } from "../cloud/account.ts";
import { type CloudApi, CloudError } from "../cloud/api.ts";
import { forward } from "../cloud/forward.ts";
import { describeRequest, Tunnel } from "../cloud/tunnel.ts";
import { randomKey } from "../cloud/sync.ts";
import { onSignalExit } from "../engine/jobs.ts";
import { ToolError } from "../errors.ts";
import { setting } from "../settings.ts";
import type { CallContext, Tool, ToolResult } from "./types.ts";

/** How long start waits for the phone before answering that it is still starting (an MCP call has about a minute). */
const READY_WAIT_MS = 40_000;
const ACTIONS = ["start", "status", "stop", "run", "tunnel"];

type Phone = { id: string; state: string; device?: string; message?: string; ready_at?: string | null; failure_code?: string | null; cost?: { accrued_microunits?: string; billable_seconds?: number }; cleanup_confirmed?: boolean };
/** A phone answer's links: view and control while it runs, its replay always. */
type Links = { view?: string; control?: string; replay?: string };

const dollars = (micro: string | undefined) => `$${(Number(micro ?? 0) / 1e6).toFixed(2)}`;
const readPhone = async (api: CloudApi, id: string) => {
  const read = await api.json("GET", `/api/v1/simulator/sessions/${id}`);
  return { phone: read.session as Phone, links: (read.links ?? {}) as Links };
};
const phoneOf = async (api: CloudApi, id: string) => (await readPhone(api, id)).phone;
const gone = (error: unknown) => error instanceof CloudError && (error.status === 404 || error.code === "session_not_found");
const watchLine = (links: Links) => (links.view && links.control ? `\nA person can watch it at ${links.view} or use it at ${links.control}.` : "");

/** Waits for a phone to be ready, up to the time given. Answers it as it last read. */
async function untilReady(api: CloudApi, id: string, waitMs: number): Promise<Phone> {
  let phone = await phoneOf(api, id);
  for (const deadline = Date.now() + waitMs; !["ready", "failed", "stopped", "stopping"].includes(phone.state) && Date.now() < deadline; ) {
    await new Promise((r) => setTimeout(r, 500));
    phone = await phoneOf(api, id);
  }
  return phone;
}

const DEVICE_NAMES: Record<string, string> = { iphone: "iPhone", ipad: "iPad" };

async function start(args: Record<string, unknown>, context: CallContext): Promise<ToolResult> {
  const device = typeof args.device === "string" ? args.device : undefined;
  const signed = await signIn();
  if ("link" in signed) {
    return { text: `Sign in to NoMac for a cloud phone: open ${signed.link} and approve code ${signed.code}.\nNext: cloud start again once it is approved (headless: set NOMAC_API_KEY instead).` };
  }
  const { api } = signed;
  const state = await cloudState();
  if (state.session) {
    // A phone NoMac no longer has is gone; any other failure (the network) is NoMac's answer, never a second phone.
    const read = await readPhone(api, state.session).catch((error: unknown) => {
      if (gone(error)) return undefined;
      throw error;
    });
    const phone = read?.phone;
    if (phone && (phone.state === "ready" || phone.state === "queued" || phone.state === "provisioning")) {
      if (device && phone.device && phone.device !== device) {
        throw new ToolError(`Cloud already has phone ${phone.id}, an ${DEVICE_NAMES[phone.device] ?? phone.device}.`, `cloud stop, then cloud start with device ${device}.`);
      }
      await setCloudState({ ...state, on: true });
      return { text: `Cloud is on: phone ${phone.id} is ${phone.state}, ${dollars(phone.cost?.accrued_microunits)} so far. Every tool runs there; cloud stop ends it.${watchLine(read.links)}` };
    }
  }
  const started = Date.now();
  const created = await api.json("POST", "/api/v1/simulator/sessions", device ? { device } : {}, `cli-start-${randomKey()}`);
  const id = String((created.session as Phone).id);
  await setCloudState({ on: true, session: id });
  const phone = await untilReady(api, id, context.waitForJobs ? 5 * 60_000 : READY_WAIT_MS);
  if (phone.state !== "ready") {
    if (["failed", "stopped", "stopping"].includes(phone.state)) {
      await setCloudState({ on: false });
      throw new ToolError(`The cloud phone did not start: ${phone.failure_code ?? phone.state}.`, "Call cloud start again; report_issue on NoMac's MCP if it keeps failing.");
    }
    // Waiting for a free phone, NoMac says how many there are and its place.
    const why = phone.state === "queued" && phone.message ? ` ${phone.message}` : "";
    return { text: `The cloud phone ${id} is still starting after ${((Date.now() - started) / 1000).toFixed(0)} s.${why}\nNext: cloud status, or any tool: it waits for the phone.` };
  }
  const watch = watchLine((created.links ?? {}) as Links);
  return { text: `Cloud phone ready in ${((Date.now() - started) / 1000).toFixed(1)} s: an ${DEVICE_NAMES[device ?? "iphone"]} Simulator on a NoMac Mac, $0.80 an hour by the minute.\nEvery tool now runs there; app_run and tests_run send the project first. cloud stop ends it.${watch}` };
}

/** The phone's tunnel to a backend on this machine, while this process runs (one at a time). */
let tunnel: Tunnel | undefined;

/** The tunnel's notice (its port changed), once: said after the next answer from the phone. */
export function tunnelNotice(): string | undefined {
  const notice = tunnel?.notice;
  if (tunnel) tunnel.notice = undefined;
  return notice;
}

const tunnelLine = (t: Tunnel) =>
  t.state === "closed" ? `The tunnel closed${t.error ? `: ${t.error}` : ""}.` : `The phone reaches ${t.localHost}:${t.localPort} on this machine at http://127.0.0.1:${t.phonePort}${t.state === "connecting" ? " (reconnecting)" : ""}.`;

/**
 * tunnel with port: the phone's apps reach that port on this machine (a local backend) at http://127.0.0.1:<its port>
 * on the phone; without port: what it carried; port 0: closes it. On the command line it runs until Ctrl-C, printing
 * each request.
 */
async function openTunnel(args: Record<string, unknown>, context: CallContext): Promise<ToolResult> {
  const state = await cloudState();
  const api = await account();
  if (args.port === 0) {
    const had = tunnel;
    tunnel?.stop();
    tunnel = undefined;
    return { text: had ? "Closed the phone's tunnel." : "No tunnel is open." };
  }
  const port = typeof args.port === "number" ? args.port : typeof args.path === "string" && /^\d+$/.test(args.path) ? Number(args.path) : undefined;
  if (port === undefined) {
    if (!tunnel) return { text: "No tunnel is open.\nNext: cloud tunnel with port, your backend's port on this machine." };
    const recent = tunnel.requests.slice(-20).map((r) => describeRequest(r));
    const notice = tunnelNotice();
    return { text: `${tunnelLine(tunnel)} ${tunnel.requests.length} requests so far${recent.length ? `, the last:\n${recent.join("\n")}` : "."}${tunnel.error && tunnel.state !== "closed" ? `\nLast problem: ${tunnel.error}.` : ""}${notice ? `\n${notice}` : ""}` };
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new ToolError(`${port} is not a port.`, "Pass port: your backend's port on this machine, like 8080.");
  if (!api || !state.on || !state.session) throw new ToolError("Cloud has no phone.", "Call cloud start first.");
  if (tunnel && (tunnel.session !== state.session || tunnel.localPort !== port || tunnel.state === "closed")) {
    tunnel.stop();
    tunnel = undefined;
  }
  if (!tunnel) {
    const opened = new Tunnel(api, state.session, port, "127.0.0.1", context.waitForJobs ? (r) => console.log(describeRequest(r, false)) : undefined, context.waitForJobs ? (n) => console.log(n) : undefined);
    await opened.start();
    tunnel = opened;
  }
  const url = `http://127.0.0.1:${tunnel.phonePort}`;
  const text = `${tunnelLine(tunnel)}\nPoint the app's backend there: app_run env "API_URL=${url}" for an app that reads it from ProcessInfo, or its Debug configuration. It works while the phone runs; cloud tunnel shows the requests it carried, cloud tunnel with port 0 closes it.`;
  if (!context.waitForJobs) return { text };
  // The command line keeps it open, printing each request, until Ctrl-C.
  console.log(`${text}\nRequests as they pass (Ctrl-C closes it):`);
  await new Promise<void>((resolve) => {
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
  });
  const carried = tunnel.requests.length;
  tunnel.stop();
  tunnel = undefined;
  return { text: `Closed the tunnel after ${carried} request${carried === 1 ? "" : "s"}.` };
}

async function status(): Promise<ToolResult> {
  const state = await cloudState();
  if (!state.on) return { text: "Cloud is off: the tools run on this machine. cloud start runs them on a NoMac phone." };
  const api = await account();
  if (!api || !state.session) return { text: "Cloud is on but has no phone yet. cloud start starts one." };
  const { phone, links } = await readPhone(api, state.session);
  const minutes = Math.ceil((phone.cost?.billable_seconds ?? 0) / 60);
  if (phone.state === "queued") return { text: `Cloud is on: phone ${phone.id} is waiting.${phone.message ? ` ${phone.message}` : ""}` };
  return { text: `Cloud is on: phone ${phone.id} is ${phone.state}; ${minutes} min so far, ${dollars(phone.cost?.accrued_microunits)} at $0.80 an hour.${tunnel ? `\n${tunnelLine(tunnel)}` : ""}${phone.state === "ready" ? watchLine(links) : ""}` };
}

async function stop(): Promise<ToolResult> {
  tunnel?.stop();
  tunnel = undefined;
  const state = await cloudState();
  const api = await account();
  if (!state.session || !api) {
    await setCloudState({ on: false });
    return { text: "Cloud is off: the tools run on this machine." };
  }
  // The phone is forgotten only once NoMac took the stop: a stop that did not reach it leaves the phone billing.
  let stopped: Record<string, unknown> | undefined;
  try {
    stopped = await api.json("DELETE", `/api/v1/simulator/sessions/${state.session}`);
  } catch (error) {
    if (!gone(error)) {
      return { text: `Could not stop the cloud phone ${state.session}: ${(error as Error).message.replace(/\.$/, "")}. It runs, and bills, until its idle stop.\nNext: cloud stop again.`, isError: true };
    }
  }
  await setCloudState({ on: false });
  let phone = await phoneOf(api, state.session).catch(() => undefined);
  for (let i = 0; phone && !phone.cleanup_confirmed && i < 15; i++) {
    await new Promise((r) => setTimeout(r, 2_000));
    phone = await phoneOf(api, state.session).catch(() => undefined);
  }
  const cost = phone ? `after ${Math.ceil((phone.cost?.billable_seconds ?? 0) / 60)} min, ${dollars(phone.cost?.accrued_microunits)}` : "(its cost is on NoMac's dashboard)";
  const replay = ((stopped?.links ?? {}) as Links).replay;
  return { text: `Stopped the cloud phone ${cost}. The tools run on this machine again. A file link from its answers works now only if it was opened before this stop.${replay ? `\nIts replay, the screen and every call, opens at ${replay} in a minute (kept 7 days).` : ""}` };
}

/** A phone stopped at once, as the process ends (a signal): no waiting for its cleanup. */
async function stopNow(session: string): Promise<void> {
  const api = await account();
  await api?.json("DELETE", `/api/v1/simulator/sessions/${session}`).catch(() => undefined);
  await setCloudState({ on: false });
}

/**
 * The phone an MCP server started, stopped as the server ends (its client closed it, or a signal): it was that
 * agent's alone, and would otherwise bill until its idle stop. A CLI command keeps its phone for the next one.
 */
export async function stopServerPhone(): Promise<void> {
  tunnel?.stop();
  tunnel = undefined;
  const { session } = await cloudState();
  if (session) await stopNow(session);
}

/** A file link in a phone's answer: <base>/api/v1/simulator/files/<payload>.<signature>, never the sentence's period. */
const FILE_LINK = /https?:\/\/[^\s"'<>]+?\/api\/v1\/simulator\/files\/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g;
const KEEP_FILES = 10;
const KEEP_BYTES = 200 * 1024 * 1024;

/** The file's name as the link carries it (its payload's n), made safe for a folder. */
function linkName(link: string): string | undefined {
  try {
    const payload = /\/files\/([A-Za-z0-9_-]+)\./.exec(link)?.[1];
    const name = payload ? (JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { n?: unknown }).n : undefined;
    const safe = typeof name === "string" ? basename(name).replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "") : "";
    return safe || undefined;
  } catch {
    return undefined;
  }
}

/**
 * The files a run's answers link to (a failed build's full log), kept in out before the phone stops: a link that
 * was never opened ends with its phone. At most 10 files and 200 MB; each link in lines becomes its file's path.
 */
async function keepFiles(lines: string[], out: string): Promise<void> {
  const links = [...new Set(lines.join("\n").match(FILE_LINK) ?? [])].slice(0, KEEP_FILES);
  let total = 0;
  for (const [i, link] of links.entries()) {
    const name = linkName(link) ?? `simulator-use-file-${i + 1}`;
    const file = join(out, existsSync(join(out, name)) ? `${i + 1}-${name}` : name);
    try {
      const response = await fetch(link, { signal: AbortSignal.timeout(120_000) });
      if (!response.ok || !response.body || total + Number(response.headers.get("content-length") ?? 0) > KEEP_BYTES) continue;
      let size = 0;
      const capped = Readable.fromWeb(response.body as never).map((chunk: Buffer) => {
        size += chunk.length;
        if (total + size > KEEP_BYTES) throw new Error("over the run's file budget");
        return chunk;
      });
      await pipeline(capped, createWriteStream(file));
      total += size;
      for (let j = 0; j < lines.length; j++) lines[j] = lines[j]!.split(link).join(file);
    } catch {
      // The link stays in the text; a file cut short is not kept.
      await unlink(file).catch(() => undefined);
    }
  }
}

/**
 * CI in one call: a phone, the project built and run, its tests with tests: true, a screenshot of its screen, and
 * the phone stopped (unless cloud was already on). Fails when the build or a test fails.
 */
async function runOnce(args: Record<string, unknown>, context: CallContext): Promise<ToolResult> {
  // A run waits for a phone, the build and the tests, which takes minutes, past what an MCP call waits for; and its
  // steps are tools an agent already has.
  if (!context.waitForJobs) {
    throw new ToolError("cloud run is for the command line and CI: it takes minutes, longer than a tool call waits. Nothing ran.", "cloud start, then app_run (tests_run for the tests), then cloud stop.");
  }
  const before = await cloudState();
  const lines: string[] = [];
  let failed = false;
  let image: ToolResult["image"];
  // The phone this run started: stopped at its end, and before the process ends on a signal (Ctrl-C, a cancelled
  // CI job), so a run never leaves a phone billing.
  let created: string | undefined;
  let signingIn = false;
  const startedHere = async () => {
    const now = await cloudState().catch(() => undefined);
    if (now?.session && now.session !== before.session) created = now.session;
    return created;
  };
  const release = onSignalExit(async () => {
    const session = (await startedHere()) ?? (before.on ? undefined : (await cloudState()).session);
    if (session) await stopNow(session);
  });
  try {
    const ensure = await start(args, { waitForJobs: true });
    // Not signed in yet: nothing started, and the pending sign-in is kept for the next call.
    if (/^Sign in to NoMac/.test(ensure.text)) {
      signingIn = true;
      return { text: ensure.text, isError: true };
    }
    const path = typeof args.path === "string" ? args.path : ".";
    const scheme = typeof args.scheme === "string" && args.scheme ? { scheme: args.scheme } : {};
    // A video of the whole run for the person reviewing it (the phone records up to its own limit).
    const recording = await forward("screen_record", { action: "start" }, context);
    const ran = await forward("app_run", { path, ...scheme }, { waitForJobs: true });
    lines.push(ran.text);
    failed ||= Boolean(ran.isError);
    if (!ran.isError && args.tests === true) {
      const tested = await forward("tests_run", { path, ...scheme }, { waitForJobs: true });
      lines.push(tested.text);
      failed ||= Boolean(tested.isError);
    }
    const out = typeof args.out === "string" ? args.out : tmpdir();
    if (!ran.isError) {
      const look = await forward("ui_look", { screenshot: true }, context);
      image = look.image;
      if (image && context.waitForJobs) {
        const file = join(out, `simulator-use-cloud-${Date.now()}.${image.mimeType === "image/png" ? "png" : "jpg"}`);
        await writeFile(file, image.data);
        lines.push(`Screenshot: ${file}`);
      }
    }
    if (!recording.isError) {
      const stopped = await forward("screen_record", { action: "stop" }, context);
      const link = /https?:\/\/\S+\/api\/v1\/simulator\/files\/[A-Za-z0-9_.-]+/.exec(stopped.text)?.[0];
      if (link && context.waitForJobs) {
        const response = await fetch(link);
        if (response.ok) {
          const file = join(out, `simulator-use-cloud-${Date.now()}.mp4`);
          await writeFile(file, Buffer.from(await response.arrayBuffer()));
          lines.push(`Recording: ${file}`);
        } else {
          lines.push(`Recording: ${link}`);
        }
      } else if (link) {
        lines.push(`Recording: ${link}`);
      }
    }
    await keepFiles(lines, out);
  } finally {
    release();
    if (!signingIn && ((await startedHere()) || !before.on)) lines.push((await stop()).text);
  }
  // The command line saved the screenshot above; an MCP client gets the picture itself.
  return { text: lines.join("\n\n"), ...(image && !context.waitForJobs ? { image } : {}), ...(failed ? { isError: true } : {}) };
}

export const cloud: Tool = {
  name: "cloud",
  title: "Cloud phone",
  command: "cloud",
  positional: ["action", "path"],
  description:
    "A NoMac cloud iPhone or iPad Simulator, $0.80 an hour by the minute, for Linux, Windows, cloud agents, CI. start signs in (a link; NOMAC_API_KEY headless) and starts one: until stop every tool runs there, app_run and tests_run send the project. status: phone, cost. stop: ends it. run (CLI, CI): start, build and run path, tests with tests, screenshot, recording, stop. tunnel: the phone reaches port here.",
  inputSchema: {
    type: "object",
    properties: {
      action: { type: "string", enum: ACTIONS, description: "what to do" },
      device: { type: "string", enum: ["iphone", "ipad"], description: "start, run: default iphone" },
      port: { type: "number", description: "tunnel: a local port; 0 closes it" },
      path: { type: "string", description: "run: project folder" },
      tests: { type: "boolean", description: "run: tests too" },
      scheme: { type: "string", description: "run: scheme" },
      out: { type: "string", description: "run: output folder" },
    },
    required: ["action"],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  async run(args, context) {
    if (setting("HOSTED")) throw new ToolError("This is a NoMac phone already.", "Call the other tools directly.");
    try {
      switch (args.action) {
        case "start":
          return await start(args, context);
        case "status":
          return await status();
        case "stop":
          return await stop();
        case "run":
          return await runOnce(args, context);
        case "tunnel":
          return await openTunnel(args, context);
      }
      throw new ToolError(`Unknown action "${String(args.action)}".`, `Actions: ${ACTIONS.join(", ")}.`);
    } catch (error) {
      if (error instanceof CloudError) throw new ToolError(`NoMac: ${error.message}`, error.code === "insufficient_credit" ? "Add credit at https://nomac.app/dashboard, then cloud start again." : "Call cloud status, or try again in a minute.");
      throw error;
    }
  },
};
