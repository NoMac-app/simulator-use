/**
 * What a session server asks of NoMac Simulator's host (SIMULATOR_USE_HOSTED), as MCP's requests from a server to its
 * client: only what the host offered at initialize (capabilities.experimental, names under nomac/). The host knows
 * which pool user this server runs as and answers for that user alone, so no request names one.
 */

import { setting } from "./settings.ts";

type Waiting = { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout };

let write: ((line: string) => void) | undefined;
let offered = new Set<string>();
const waiting = new Map<string, Waiting>();
let next = 0;

/** Where requests go: the server's output, while it serves. */
export function setHostOutput(fn: ((line: string) => void) | undefined): void {
  write = fn;
  if (fn) return;
  for (const [id, w] of waiting) {
    clearTimeout(w.timer);
    w.reject(new Error("the host is gone"));
    waiting.delete(id);
  }
}

/** What the host offers, from its initialize's capabilities. */
export function setHostOffers(capabilities: unknown): void {
  const experimental = capabilities && typeof capabilities === "object" ? (capabilities as { experimental?: unknown }).experimental : undefined;
  offered = new Set(experimental && typeof experimental === "object" ? Object.keys(experimental).filter((name) => name.startsWith("nomac/")) : []);
}

/** Whether the host answers method. */
export const hostOffers = (method: string): boolean => Boolean(write) && Boolean(setting("HOSTED")) && offered.has(method);

/** Asks the host, which answers within timeoutMs or the request fails. */
export function askHost(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
  const send = write;
  if (!send || !hostOffers(method)) return Promise.reject(new Error(`the host does not answer ${method}`));
  const id = `host-${++next}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      waiting.delete(id);
      reject(new Error(`the host did not answer within ${Math.round(timeoutMs / 1000)} s`));
    }, timeoutMs);
    waiting.set(id, { resolve, reject, timer });
    send(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
}

/** Takes the host's answer to one of these requests (true), or leaves any other message to the server (false). */
export function hostAnswer(message: unknown): boolean {
  if (!setting("HOSTED") || !message || typeof message !== "object" || Array.isArray(message)) return false;
  const m = message as { id?: unknown; method?: unknown; result?: unknown; error?: unknown };
  if (typeof m.id !== "string" || !m.id.startsWith("host-") || m.method !== undefined) return false;
  const w = waiting.get(m.id);
  // An answer after its time ran out is dropped.
  if (!w) return true;
  waiting.delete(m.id);
  clearTimeout(w.timer);
  if (m.error !== undefined) {
    const said = m.error && typeof m.error === "object" ? (m.error as { message?: unknown }).message : undefined;
    w.reject(new Error(typeof said === "string" ? said.slice(0, 200) : "the host refused"));
  } else {
    w.resolve(m.result);
  }
  return true;
}
