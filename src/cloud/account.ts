/**
 * Cloud mode's account and phone: the NoMac account it signs in to (NOMAC_API_KEY, else the NoMac CLI's
 * ~/.nomac/credentials.json, else NoMac's device sign-in, whose key is saved there for both tools), and the phone
 * it uses, kept in simulator-use's state folder so every CLI call reaches the same one.
 */

import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { join } from "node:path";

import { stateDir } from "../engine/state.ts";
import { CloudApi } from "./api.ts";

export const DEFAULT_API = "https://nomac.app";
const credentialsFile = () => join(homedir(), ".nomac", "credentials.json");

type Credentials = { api_key?: string; api_url?: string };

async function readCredentials(): Promise<Credentials> {
  try {
    return JSON.parse(await readFile(credentialsFile(), "utf8")) as Credentials;
  } catch {
    return {};
  }
}

/** The signed-in account's API, or nothing when there is no key yet. */
export async function account(): Promise<CloudApi | undefined> {
  const stored = await readCredentials();
  const key = process.env.NOMAC_API_KEY || stored.api_key;
  if (!key) return undefined;
  return new CloudApi(process.env.NOMAC_API_URL || stored.api_url || DEFAULT_API, key);
}

/** The key from a device sign-in, kept for simulator-use and the NoMac CLI alike (mode 0600), other fields kept. */
async function saveKey(key: string, base: string): Promise<void> {
  const stored = await readCredentials();
  await mkdir(join(homedir(), ".nomac"), { recursive: true, mode: 0o700 });
  await writeFile(credentialsFile(), `${JSON.stringify({ ...stored, api_key: key, ...(base !== DEFAULT_API ? { api_url: base } : {}) }, null, 2)}\n`, { mode: 0o600 });
  await chmod(credentialsFile(), 0o600);
}

// ---- The phone in use -------------------------------------------------------------------------------------

export type CloudState = { on: boolean; session?: string; signIn?: { device_code: string; user_code: string; url: string; expires_at: number; base: string } };
const stateFile = () => join(stateDir(), "cloud.json");

export async function cloudState(): Promise<CloudState> {
  try {
    return JSON.parse(await readFile(stateFile(), "utf8")) as CloudState;
  } catch {
    return { on: false };
  }
}

export async function setCloudState(state: CloudState): Promise<void> {
  await mkdir(stateDir(), { recursive: true });
  await writeFile(stateFile(), JSON.stringify(state), { mode: 0o600 });
}

// ---- Device sign-in ---------------------------------------------------------------------------------------

/** How long one call waits for the person to approve before answering with the link again. */
const SIGN_IN_WAIT_MS = 25_000;

/**
 * Signs in through NoMac's device page: the first call answers the link to open (the agent shows it to its
 * person); later calls wait up to 25 s for the approval, then save the key. Answers the account once signed in.
 */
export async function signIn(): Promise<{ api: CloudApi } | { link: string; code: string }> {
  const ready = await account();
  if (ready) return { api: ready };
  // In CI nobody can open a sign-in link: no key is a missing secret (a fork's pull request gets none).
  if (process.env.CI) throw new Error("No NOMAC_API_KEY: in CI, set it from a secret (a pull request from a fork gets no secrets).");
  const state = await cloudState();
  const base = (process.env.NOMAC_API_URL || DEFAULT_API).replace(/\/+$/, "");
  let pending = state.signIn && state.signIn.expires_at > Date.now() && state.signIn.base === base ? state.signIn : undefined;
  if (!pending) {
    const started = await post(base, "/api/v1/device/start", { client_name: `simulator-use on ${hostname()}`.slice(0, 100) });
    pending = {
      device_code: String(started.device_code),
      user_code: String(started.user_code),
      url: withSource(String(started.verification_uri_complete ?? started.verification_uri)),
      expires_at: Date.now() + Number(started.expires_in ?? 900) * 1000,
      base,
    };
    await setCloudState({ ...state, signIn: pending });
    return { link: pending.url, code: pending.user_code };
  }
  for (const deadline = Date.now() + SIGN_IN_WAIT_MS; Date.now() < deadline; ) {
    const answer = await post(base, "/api/v1/device/token", { device_code: pending.device_code });
    if (answer.status === "approved" && typeof answer.api_key === "string") {
      await saveKey(answer.api_key, base);
      await setCloudState({ ...(await cloudState()), signIn: undefined });
      return { api: new CloudApi(base, answer.api_key) };
    }
    if (answer.status === "denied" || answer.status === "expired" || answer.status === "claimed") {
      await setCloudState({ ...(await cloudState()), signIn: undefined });
      throw new Error(answer.status === "denied" ? "The sign-in was denied on NoMac's page." : "The sign-in link expired. Call cloud start again for a new one.");
    }
    await new Promise((resolve) => setTimeout(resolve, answer.status === "slow_down" ? 10_000 : 5_000));
  }
  return { link: pending.url, code: pending.user_code };
}

/** The sign-in link with simulator-use as its source, so a signup through the tool says where it came from. */
export function withSource(link: string): string {
  try {
    const url = new URL(link);
    url.searchParams.set("utm_source", "simulator-use");
    return url.toString();
  } catch {
    return link;
  }
}

async function post(base: string, path: string, body: unknown): Promise<Record<string, unknown>> {
  const response = await fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  // 429 is the token route's slow_down: a pending sign-in, polled less often.
  if (!response.ok && response.status !== 429) {
    const error = (payload.error ?? {}) as { message?: string };
    throw new Error(`NoMac's sign-in answered ${response.status}${error.message ? `: ${error.message}` : ""}.`);
  }
  return payload;
}
