// A small MCP client over stdio (newline-delimited JSON-RPC), the way agents run these servers.
// Each tool call is timed from the moment its request is written to the moment its answer is parsed.
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";

export class McpClient {
  constructor({ command, args = [], env = {}, cwd, stderrFile, name = command }) {
    this.name = name;
    this.proc = spawn(command, args, { cwd, env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"], detached: true });
    this.nextId = 1;
    this.pending = new Map();
    this.notifications = [];
    this.strayStdout = [];
    this.exited = null;
    this.buffer = "";
    if (stderrFile) {
      const log = createWriteStream(stderrFile);
      this.proc.stderr.pipe(log);
    } else this.proc.stderr.resume();
    this.proc.stdout.setEncoding("utf8");
    this.proc.stdout.on("data", (chunk) => this.#onData(chunk));
    this.proc.on("exit", (code, signal) => {
      this.exited = { code, signal };
      for (const { reject } of this.pending.values()) reject(new Error(`${this.name} exited (${code ?? signal}) before answering`));
      this.pending.clear();
    });
    this.proc.on("error", (error) => {
      this.exited = { error: error.message };
      for (const { reject } of this.pending.values()) reject(error);
      this.pending.clear();
    });
  }

  #onData(chunk) {
    this.buffer += chunk;
    let i;
    while ((i = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, i).trim();
      this.buffer = this.buffer.slice(i + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { this.strayStdout.push(line.slice(0, 500)); continue; }
      const at = process.hrtime.bigint();
      if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined) && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        p.resolve({ msg, at });
      } else if (msg.method && msg.id !== undefined) {
        // A request from the server (ping, roots/list, elicitation...): answer it plainly.
        const reply = msg.method === "ping" ? { result: {} } : msg.method === "roots/list" ? { result: { roots: [] } } : { error: { code: -32601, message: "not supported by the benchmark client" } };
        this.#write({ jsonrpc: "2.0", id: msg.id, ...reply });
      } else if (msg.method) {
        this.notifications.push(msg.method);
      }
    }
  }

  #write(obj) { this.proc.stdin.write(JSON.stringify(obj) + "\n"); }

  /** Sends a request; resolves with { result, error, ms } where ms is request written -> answer parsed. */
  request(method, params, timeoutMs = 120_000) {
    const id = this.nextId++;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ error: { code: "timeout", message: `no answer to ${method} within ${timeoutMs} ms` }, ms: timeoutMs, timedOut: true });
      }, timeoutMs);
      const started = process.hrtime.bigint();
      this.pending.set(id, {
        resolve: ({ msg, at }) => { clearTimeout(timer); resolve({ result: msg.result, error: msg.error, ms: Number(at - started) / 1e6 }); },
        reject: (e) => { clearTimeout(timer); resolve({ error: { code: "exited", message: e.message }, ms: Number(process.hrtime.bigint() - started) / 1e6 }); },
      });
      if (this.exited) { this.pending.get(id)?.reject(new Error(`${this.name} is not running`)); return; }
      this.#write({ jsonrpc: "2.0", id, method, ...(params !== undefined ? { params } : {}) });
    });
  }

  notify(method, params) { this.#write({ jsonrpc: "2.0", method, ...(params !== undefined ? { params } : {}) }); }

  async initialize(timeoutMs = 120_000) {
    const r = await this.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "simulator-use-bench", version: "1.0.0" } }, timeoutMs);
    if (!r.error) this.notify("notifications/initialized");
    return r;
  }

  async listTools(timeoutMs = 120_000) {
    const tools = [];
    let cursor, ms = 0;
    for (let page = 0; page < 50; page++) {
      const r = await this.request("tools/list", cursor ? { cursor } : {}, timeoutMs);
      ms += r.ms;
      if (r.error) return { error: r.error, tools, ms };
      tools.push(...(r.result?.tools ?? []));
      cursor = r.result?.nextCursor;
      if (!cursor) break;
    }
    return { tools, ms };
  }

  /** Calls a tool: { ms, isError, content, structured, error }. */
  async call(name, args = {}, timeoutMs = 120_000) {
    const r = await this.request("tools/call", { name, arguments: args }, timeoutMs);
    return {
      ms: r.ms,
      timedOut: Boolean(r.timedOut),
      error: r.error ?? null,
      isError: Boolean(r.result?.isError) || Boolean(r.error),
      content: r.result?.content ?? [],
      structured: r.result?.structuredContent ?? null,
    };
  }

  async close(graceMs = 3000) {
    if (this.exited) return;
    try { this.proc.stdin.end(); } catch {}
    const done = new Promise((r) => this.proc.once("exit", r));
    const t = setTimeout(() => { try { process.kill(-this.proc.pid, "SIGTERM"); } catch {} }, graceMs);
    const k = setTimeout(() => { try { process.kill(-this.proc.pid, "SIGKILL"); } catch {} }, graceMs + 3000);
    await Promise.race([done, new Promise((r) => setTimeout(r, graceMs + 4000))]);
    clearTimeout(t); clearTimeout(k);
  }
}
