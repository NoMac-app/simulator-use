/**
 * NoMac's REST API as cloud mode calls it: the account's key on every request, JSON in and out, a retry for what
 * passes (a lost connection, NoMac or the phone busy for a moment), and NoMac's own words when it refuses.
 */

import { VERSION } from "../registry.ts";

export class CloudError extends Error {
  readonly code: string;
  readonly status: number;
  /** The rest of NoMac's error: starting (a phone not ready yet), retry_after_seconds, next_action ... */
  readonly details: Record<string, unknown>;

  constructor(code: string, message: string, status: number, details: Record<string, unknown> = {}) {
    super(message);
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

const PASSING = new Set([429, 502, 503, 504]);

export class CloudApi {
  readonly base: string;
  private readonly key: string;

  constructor(base: string, key: string) {
    this.base = base.replace(/\/+$/, "");
    this.key = key;
  }

  /** One request: an object goes as JSON, bytes as a chunk. The idempotency key makes a retry the same request. */
  async json(method: string, path: string, body?: unknown, idempotencyKey?: string): Promise<Record<string, unknown>> {
    const headers: Record<string, string> = { authorization: `Bearer ${this.key}`, "user-agent": `simulator-use/${VERSION}` };
    if (idempotencyKey) headers["idempotency-key"] = idempotencyKey;
    const raw = body instanceof Uint8Array;
    if (body !== undefined) headers["content-type"] = raw ? "application/octet-stream" : "application/json";
    for (let attempt = 1; ; attempt++) {
      let response: Response;
      try {
        response = await fetch(`${this.base}${path}`, { method, headers, body: body === undefined ? undefined : raw ? (body as Uint8Array<ArrayBuffer>) : JSON.stringify(body), signal: AbortSignal.timeout(90_000) });
      } catch (error) {
        if (attempt < 4) {
          await pause(attempt);
          continue;
        }
        throw new CloudError("unreachable", `NoMac did not answer (${(error as Error).message}).`, 0);
      }
      const text = await response.text();
      let payload: Record<string, unknown> = {};
      try {
        payload = text ? (JSON.parse(text) as Record<string, unknown>) : {};
      } catch {
        payload = {};
      }
      if (response.ok) return payload;
      const error = (payload.error ?? {}) as { code?: string; message?: string } & Record<string, unknown>;
      if (PASSING.has(response.status) && attempt < 4) {
        await pause(attempt, Number(response.headers.get("retry-after")));
        continue;
      }
      const { code: _code, message: _message, ...details } = error;
      throw new CloudError(error.code ?? `http_${response.status}`, error.message ?? `NoMac answered ${response.status}.`, response.status, details);
    }
  }
}

const pause = (attempt: number, retryAfter?: number) => new Promise((resolve) => setTimeout(resolve, Number.isFinite(retryAfter) && retryAfter! > 0 ? Math.min(retryAfter!, 30) * 1000 : attempt * 2000));
