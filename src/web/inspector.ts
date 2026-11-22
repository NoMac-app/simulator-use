/**
 * The Simulator's Web Inspector, as a client: which web pages its apps show, and a script run in one of them.
 *
 * Every Simulator runs webinspectord, the daemon Safari's Develop menu talks to, on a socket of its own
 * (RWI_LISTEN_SOCKET in the Simulator's environment). It lists the pages of Safari, of in-app browsers and of every
 * web view an app lets be inspected, and carries WebKit's inspector protocol to each. simulator-use reads a page's
 * content through it (page.ts): the page itself says what it shows and where, in one call, where accessibility on
 * iOS 27 gives a web page only point by point (Safari's Hacker News front page read as 7 fragments of 228 links,
 * November 22, 2026) or not at all (a web view hosted by SwiftUI).
 *
 * The wire: messages are binary property lists, each after its length in four bytes, of the shape
 * {__selector, __argument}. A page's inspector messages (JSON) travel inside them, and on current WebKit inside
 * Target.sendMessageToTarget and Target.dispatchMessageFromTarget, since a page's process may change as it navigates.
 */
import { randomUUID } from "node:crypto";
import { connect, type Socket } from "node:net";

import { run } from "../engine/exec.ts";
import { setting } from "../settings.ts";
import { decodePlist, encodePlist, type Plist } from "./bplist.ts";

export type WebPage = { app: string; page: number; title: string; url: string };

type Dict = { [key: string]: Plist };
type App = { id: string; pid: number; bundleId: string; host?: string; proxy: boolean };
type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout };
type Session = {
  key: string;
  app: string;
  page: number;
  sender: string;
  /** The page's target, once WebKit named it; undefined on a WebKit that has none (messages then go as they are). */
  target?: string;
  targeted: Promise<void>;
  nextId: number;
  pending: Map<number, Pending>;
  /** A long message comes in pieces. */
  chunks: Buffer[];
  idle?: NodeJS.Timeout;
};

/** A session with a page is closed after this long without a call: Safari's own Web Inspector can then attach. */
const SESSION_IDLE_MS = 20_000;
/** How long the daemon gets to say which apps and pages it has, after the connection opens. */
const LISTING_MS = 400;
/** A frame longer than this is not a message of the inspector's: the connection is dropped. */
const MAX_FRAME = 64 * 1024 * 1024;

const dict = (value: Plist | undefined): Dict => (value !== null && typeof value === "object" && !Array.isArray(value) && !Buffer.isBuffer(value) && !(value instanceof Date) ? value : {});
const str = (value: Plist | undefined): string => (typeof value === "string" ? value : "");
const debug = (line: string) => {
  if (setting("DEBUG")) process.stderr.write(`simulator-use:   web inspector: ${line}\n`);
};

export class WebInspector {
  readonly udid: string;
  private socket: Socket | undefined;
  private readonly connection = randomUUID().toUpperCase();
  private buffer: Buffer = Buffer.alloc(0);
  readonly apps = new Map<string, App>();
  readonly listings = new Map<string, WebPage[]>();
  private readonly sessions = new Map<string, Session>();
  private closed = false;
  /** Resolves once the first listings are in (or the time for them is up). */
  private listed: Promise<void> = Promise.resolve();
  private lastMessage = 0;

  constructor(udid: string) {
    this.udid = udid;
  }

  get open(): boolean {
    return Boolean(this.socket) && !this.closed;
  }

  /** Connects to the Simulator's webinspectord; rejects when it has none to connect to. */
  async start(socketPath: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const socket = connect(socketPath);
      const failed = (error: Error) => reject(error);
      socket.once("error", failed);
      socket.once("connect", () => {
        socket.off("error", failed);
        this.socket = socket;
        socket.on("data", (chunk) => this.receive(chunk));
        socket.on("error", () => this.end());
        socket.on("close", () => this.end());
        resolve();
      });
    });
    this.send("_rpc_reportIdentifier:", {});
    this.send("_rpc_getConnectedApplications:", {});
    // The daemon answers with its apps and each one's pages over the next moments: wait until they stop coming.
    this.listed = new Promise<void>((resolve) => {
      const began = Date.now();
      this.lastMessage = began;
      const tick = setInterval(() => {
        const now = Date.now();
        if (this.closed || now - began > LISTING_MS || (this.apps.size > 0 && now - this.lastMessage > 60)) {
          clearInterval(tick);
          resolve();
        }
      }, 10);
    });
    await this.listed;
    // From here the connection is kept open without keeping the process alive: a command that is done exits, and
    // a call that waits on a page holds it (waiting, below).
    this.socket?.unref();
  }

  /** Sessions whose WebKit names targets (every current one): theirs is waited for when it changes. */
  private readonly targeted = new Set<string>();
  /** Calls in flight: while there are any, the process waits for the socket. */
  private waiting = 0;
  private hold(): void {
    if (this.waiting++ === 0) this.socket?.ref();
  }
  private letGo(): void {
    if (--this.waiting === 0) this.socket?.unref();
  }

  close(): void {
    for (const session of this.sessions.values()) this.release(session);
    this.end();
    this.socket?.destroy();
  }

  private end(): void {
    if (this.closed) return;
    this.closed = true;
    for (const session of this.sessions.values()) {
      clearTimeout(session.idle);
      for (const pending of session.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error("the Web Inspector's connection closed"));
      }
    }
    this.sessions.clear();
  }

  private send(selector: string, argument: Dict): void {
    if (!this.socket || this.closed) return;
    const body = encodePlist({ __selector: selector, __argument: { WIRConnectionIdentifierKey: this.connection, ...argument } });
    const length = Buffer.alloc(4);
    length.writeUInt32BE(body.length);
    this.socket.write(Buffer.concat([length, body]));
  }

  private receive(chunk: Buffer): void {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32BE(0);
      if (length > MAX_FRAME) return this.close();
      if (this.buffer.length < 4 + length) return;
      const frame = this.buffer.subarray(4, 4 + length);
      this.buffer = this.buffer.subarray(4 + length);
      try {
        const message = dict(decodePlist(frame));
        this.lastMessage = Date.now();
        this.handle(str(message.__selector), dict(message.__argument));
      } catch (error) {
        debug(`a message that could not be read: ${(error as Error).message}`);
      }
    }
  }

  private addApp(info: Dict): void {
    const id = str(info.WIRApplicationIdentifierKey);
    if (!id) return;
    const known = this.apps.has(id);
    this.apps.set(id, {
      id,
      pid: Number(/^PID:(\d+)$/.exec(id)?.[1] ?? 0),
      bundleId: str(info.WIRApplicationBundleIdentifierKey),
      ...(str(info.WIRHostApplicationIdentifierKey) ? { host: str(info.WIRHostApplicationIdentifierKey) } : {}),
      proxy: info.WIRIsApplicationProxyKey === true,
    });
    if (!known) this.send("_rpc_forwardGetListing:", { WIRApplicationIdentifierKey: id });
  }

  private handle(selector: string, argument: Dict): void {
    switch (selector) {
      case "_rpc_reportConnectedApplicationList:":
        for (const info of Object.values(dict(argument.WIRApplicationDictionaryKey))) this.addApp(dict(info));
        return;
      case "_rpc_applicationConnected:":
      case "_rpc_applicationUpdated:":
        this.addApp(argument);
        return;
      case "_rpc_applicationDisconnected:": {
        const id = str(argument.WIRApplicationIdentifierKey);
        this.apps.delete(id);
        this.listings.delete(id);
        for (const session of [...this.sessions.values()]) if (session.app === id) this.drop(session, "its app is gone");
        return;
      }
      case "_rpc_applicationSentListing:": {
        const app = str(argument.WIRApplicationIdentifierKey);
        const pages: WebPage[] = [];
        for (const entry of Object.values(dict(argument.WIRListingKey))) {
          const info = dict(entry);
          // Pages only: an app's JavaScript contexts and service workers are not what a screen shows.
          if (str(info.WIRTypeKey) !== "WIRTypeWebPage" && str(info.WIRTypeKey) !== "WIRTypeWeb" && str(info.WIRTypeKey) !== "") continue;
          const page = Number(info.WIRPageIdentifierKey);
          if (Number.isInteger(page)) pages.push({ app, page, title: str(info.WIRTitleKey), url: str(info.WIRURLKey) });
        }
        this.listings.set(app, pages);
        for (const session of [...this.sessions.values()]) if (session.app === app && !pages.some((p) => p.page === session.page)) this.drop(session, "its page is gone");
        return;
      }
      case "_rpc_applicationSentData:": {
        const session = [...this.sessions.values()].find((s) => s.sender === str(argument.WIRDestinationKey));
        const data = argument.WIRMessageDataKey;
        if (!session || !Buffer.isBuffer(data)) return;
        // A long message comes as chunks, the last one marked final.
        const type = str(argument.WIRMessageDataTypeKey);
        if (type === "WIRMessageDataTypeChunk") {
          session.chunks.push(data);
          return;
        }
        const whole = session.chunks.length ? Buffer.concat([...session.chunks, data]) : data;
        session.chunks = [];
        try {
          this.message(session, JSON.parse(whole.toString("utf8")) as Record<string, unknown>);
        } catch (error) {
          debug(`a page's message that could not be read: ${(error as Error).message}`);
        }
        return;
      }
      default:
        return;
    }
  }

  /** One inspector message from a page: its target's coming and going, or an answer (bare, or from its target). */
  private message(session: Session, message: Record<string, unknown>, fromTarget = false): void {
    const params = (message.params ?? {}) as Record<string, unknown>;
    if (message.method === "Target.targetCreated") {
      const info = (params.targetInfo ?? {}) as Record<string, unknown>;
      // The page itself; its frames and workers are targets too. A provisional one is a navigation not yet made.
      if (info.type === "page" && info.isProvisional !== true) {
        session.target = String(info.targetId);
        this.targeted.add(session.key);
      }
      return;
    }
    if (message.method === "Target.didCommitProvisionalTarget") {
      session.target = String(params.newTargetId);
      return;
    }
    if (message.method === "Target.targetDestroyed") {
      // The page went to another process (a navigation to another site): the next call waits for its new target.
      if (session.target === String(params.targetId)) session.target = undefined;
      return;
    }
    if (message.method === "Target.dispatchMessageFromTarget") {
      try {
        this.message(session, JSON.parse(String(params.message)) as Record<string, unknown>, true);
      } catch {
        // Not JSON: nothing to answer.
      }
      return;
    }
    if (typeof message.id !== "number") return;
    const pending = session.pending.get(message.id);
    // With a target, a bare message of the same id is only the ack of Target.sendMessageToTarget (an error there is
    // the call's): the answer comes from the target after it.
    if (!pending || (session.target && !fromTarget && !message.error)) return;
    session.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error) pending.reject(new Error(String((message.error as { message?: unknown }).message ?? "the page refused the call")));
    else pending.resolve(message.result);
  }

  private drop(session: Session, why: string): void {
    this.sessions.delete(session.key);
    clearTimeout(session.idle);
    for (const pending of session.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(`the page's inspector session ended: ${why}`));
    }
  }

  private release(session: Session): void {
    this.send("_rpc_forwardDidClose:", { WIRApplicationIdentifierKey: session.app, WIRPageIdentifierKey: session.page, WIRSenderKey: session.sender });
    this.drop(session, "closed");
  }

  /**
   * The pages of the app with this process id: its own, or, when it lists none itself, those of the web processes
   * that work for it.
   */
  async pagesOf(pid: number): Promise<WebPage[]> {
    await this.listed;
    const own = this.listings.get(`PID:${pid}`) ?? [];
    if (own.length) return own;
    const out: WebPage[] = [];
    for (const app of this.apps.values()) if (app.host === `PID:${pid}`) out.push(...(this.listings.get(app.id) ?? []));
    return out;
  }

  /** Whether any app has a page at all, as last heard (a cheap look before anything is asked of a page). */
  hasPages(): boolean {
    for (const pages of this.listings.values()) if (pages.length) return true;
    return false;
  }

  private async session(page: WebPage): Promise<Session> {
    const key = `${page.app}/${page.page}`;
    const existing = this.sessions.get(key);
    if (existing) return existing;
    const sender = randomUUID().toUpperCase();
    let named: () => void = () => undefined;
    const session: Session = { key, app: page.app, page: page.page, sender, targeted: new Promise<void>((resolve) => (named = resolve)), nextId: 1, pending: new Map(), chunks: [] };
    this.sessions.set(key, session);
    this.send("_rpc_forwardSocketSetup:", { WIRApplicationIdentifierKey: page.app, WIRPageIdentifierKey: page.page, WIRSenderKey: sender, WIRAutomaticallyPause: false });
    // WebKit names the page's target right after the setup (2 to 40 ms measured); one that names none in 0.4 s has none.
    const began = Date.now();
    const tick = setInterval(() => {
      if (session.target || Date.now() - began > 400 || !this.sessions.has(key)) {
        clearInterval(tick);
        named();
      }
    }, 5);
    return session;
  }

  /**
   * Runs an expression in the page and answers its value (returned by value: JSON types only). A page that has just
   * gone to another process answers for a moment that its target is missing: the session is opened again, once.
   */
  async evaluate(page: WebPage, expression: string, timeoutMs = 3_000): Promise<unknown> {
    try {
      return await this.evaluateOnce(page, expression, timeoutMs);
    } catch (error) {
      if (!/target/i.test((error as Error).message) || !this.open) throw error;
      const stale = this.sessions.get(`${page.app}/${page.page}`);
      if (stale) this.release(stale);
      await new Promise((r) => setTimeout(r, 120));
      return this.evaluateOnce(page, expression, timeoutMs);
    }
  }

  private async evaluateOnce(page: WebPage, expression: string, timeoutMs: number): Promise<unknown> {
    if (!this.open) throw new Error("the Web Inspector's connection is closed");
    const session = await this.session(page);
    await session.targeted;
    // Its target went (a navigation) and the new one is not named yet: a moment for it.
    for (let waited = 0; this.targeted.has(session.key) && !session.target && waited < 600; waited += 20) await new Promise((r) => setTimeout(r, 20));
    clearTimeout(session.idle);
    session.idle = setTimeout(() => this.release(session), SESSION_IDLE_MS);
    session.idle.unref();
    const id = session.nextId++;
    const inner = { id, method: "Runtime.evaluate", params: { expression, returnByValue: true, includeCommandLineAPI: false, doNotPauseOnExceptionsAndMuteConsole: true } };
    const outer = session.target ? { id, method: "Target.sendMessageToTarget", params: { targetId: session.target, message: JSON.stringify(inner) } } : inner;
    this.hold();
    const result = await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        session.pending.delete(id);
        reject(new Error(`the page did not answer within ${timeoutMs} ms`));
      }, timeoutMs);
      session.pending.set(id, { resolve, reject, timer });
      this.send("_rpc_forwardSocketData:", { WIRApplicationIdentifierKey: page.app, WIRPageIdentifierKey: page.page, WIRSenderKey: session.sender, WIRSocketDataKey: Buffer.from(JSON.stringify(outer)) });
    }).finally(() => this.letGo());
    const answer = (result ?? {}) as { result?: { value?: unknown; description?: string }; wasThrown?: boolean };
    if (answer.wasThrown) throw new Error(`the page's script threw: ${answer.result?.description ?? "an error"}`);
    return answer.result?.value;
  }
}

const inspectors = new Map<string, WebInspector>();
/** A Simulator without a Web Inspector to connect to is not asked again for this long. */
const RETRY_MS = 30_000;
const refused = new Map<string, number>();

/** The socket webinspectord listens on in this Simulator, from the Simulator's own environment. */
export async function inspectorSocket(udid: string): Promise<string | undefined> {
  try {
    const { stdout } = await run("xcrun", ["simctl", "getenv", udid, "RWI_LISTEN_SOCKET"], { timeoutMs: 5_000 });
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * This Simulator's Web Inspector, connected (and kept while this process runs), or undefined when it has none:
 * SIMULATOR_USE_WEB=off, a Simulator that is not booted, a daemon that does not answer.
 */
export async function webInspector(udid: string): Promise<WebInspector | undefined> {
  if (setting("WEB") === "off") return undefined;
  const existing = inspectors.get(udid);
  if (existing?.open) return existing;
  inspectors.delete(udid);
  if (Date.now() - (refused.get(udid) ?? 0) < RETRY_MS) return undefined;
  const path = await inspectorSocket(udid);
  if (!path) {
    refused.set(udid, Date.now());
    return undefined;
  }
  const inspector = new WebInspector(udid);
  try {
    await inspector.start(path);
  } catch (error) {
    debug(`no connection: ${(error as Error).message}`);
    refused.set(udid, Date.now());
    return undefined;
  }
  inspectors.set(udid, inspector);
  refused.delete(udid);
  return inspector;
}

const connecting = new Map<string, Promise<WebInspector | undefined>>();

/**
 * This Simulator's Web Inspector if it is connected already, without waiting for it. A server that stays (the MCP
 * server: warm) starts the connection now, for the reads after this one; a command that runs once does not, since
 * most screens have no web page and the connection would only be made to be dropped.
 */
export function webInspectorIfReady(udid: string, warm: boolean): WebInspector | undefined {
  const existing = inspectors.get(udid);
  if (existing?.open) return existing;
  if (warm && setting("WEB") !== "off" && !connecting.has(udid)) {
    const attempt = webInspector(udid).finally(() => connecting.delete(udid));
    connecting.set(udid, attempt);
    attempt.catch(() => undefined);
  }
  return undefined;
}

/** Closes every connection (the server is ending). */
export function closeWebInspectors(): void {
  for (const inspector of inspectors.values()) inspector.close();
  inspectors.clear();
}
