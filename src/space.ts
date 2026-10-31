import { randomBytes } from "node:crypto";
import { lstat, mkdir, readdir, readFile, rename, rm, statfs, unlink, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

/**
 * The room in a phone's workspace (NoMac Simulator, October 31, 2026). An account's workspace is an APFS volume with a
 * fixed quota, kept between its phones, and macOS 27's diskutil cannot change a volume's quota once it is made. On
 * October 30 and 31 one reached 9.8 of its 10 GB, mostly the phone's copies of saved states, and a 179 MB app's upload
 * failed on four phones with "No space left on device".
 *
 * What fills a workspace besides the account's own files is ours to bring back: a copy of a saved state that NoMac
 * keeps in its storage (a restore fetches it again, in about a minute), and build caches (DerivedData, CocoaPods'
 * downloads; the next build is slower). So when the workspace is mounted for a phone, and before a write that needs
 * room (an upload's unpack, a sync's archive, a clone, a state's save or restore, a build), its free space is checked
 * against a floor (floorOf), and below it those go, least recently used first: state copies first, then build caches.
 * Never the account's projects, clones or uploads, a state copy not known to be in NoMac's storage (one saved before
 * states went there, or whose upload failed), the state being saved or restored, the newest build cache or one a
 * build uses. A write that still runs out of room clears all that may go and runs once more; failing again, it says so
 * plainly, with what the agent can do (fullText), never "No space left on device".
 *
 * What was cleared is told to the host as sizes only (setNotifier), never a name.
 */

const GIB = 1024 ** 3;

/**
 * The free space a workspace keeps: the larger of 2 GiB and a fifth of its quota. 2 GiB holds the largest write a
 * phone makes often, a saved state (about 1 to 1.5 GB once the system's assets are left out, October 25), a cold
 * build of a mid-sized app, or a 500 MB upload with its unpacked copy; a fifth scales it for a larger quota (3.7 GiB
 * of a 20 GB one), leaving four fifths for the account's projects and the caches that make its builds incremental.
 */
export const floorOf = (total: number) => Math.max(2 * GIB, Math.floor(total / 5));

/** A state copy's mark, beside its state.json: that save is in NoMac's storage, and when the copy was last used. */
export const STORED = ".nomac-stored.json";
/** Where what is cleared goes first (a rename, so nothing is half there), on the workspace's own volume. */
const TRASH = ".nomac-trash";
const STATE_NAME = /^[A-Za-z0-9._-]{1,64}$/;

let root: string | undefined;
let cache: string | undefined;
/** What is in use now: a state saved or restored ("state:<name>"), a cache a build uses ("cache:<path>"). */
const busy = new Map<string, number>();
/** One clearing at a time, and an operation that is about to read what a clearing could take waits for it (exclusive). */
let queue: Promise<unknown> = Promise.resolve();

export type Usage = { free: number; total: number };
let measure = async (dir: string): Promise<Usage> => {
  const s = await statfs(dir);
  return { free: s.bavail * s.bsize, total: s.blocks * s.bsize };
};
/** Tests measure a folder as a small volume of their own. */
export function setMeasure(fn: (dir: string) => Promise<Usage>) {
  measure = fn;
}

export type Report = {
  reason: string;
  free_before: number;
  free_after: number;
  total: number;
  states: number;
  state_bytes: number;
  caches: number;
  cache_bytes: number;
  leftovers: number;
  leftover_bytes: number;
  full?: boolean;
};
let notifier: ((report: Report) => void) | undefined;
/** Who hears what was cleared (the MCP server's host, as a notification): sizes and counts only. */
export function setNotifier(fn: ((report: Report) => void) | undefined) {
  notifier = fn;
}

function exclusive<T>(work: () => Promise<T>): Promise<T> {
  const run = queue.then(work, work);
  queue = run.catch(() => undefined);
  return run;
}

/** Waits for a clearing under way (tests, and an operation about to read a state copy). */
export const settled = () => exclusive(async () => undefined);

/**
 * The account's workspace, at its mount (configure): leftovers of earlier phones' work go at once (nothing of this
 * phone runs yet), and so do copies and caches when it is short of room. In the background: the mount answers at once,
 * and the first operation that needs the workspace waits for it.
 */
export function setWorkspace(workspace: string, cacheDir?: string): void {
  root = resolve(workspace);
  cache = cacheDir ? resolve(cacheDir) : undefined;
  void exclusive(() => clear("mount", { mount: true })).catch(() => undefined);
}

/** Whether a workspace is set: on NoMac Simulator's host only. */
export const active = () => root !== undefined;

export async function usage(): Promise<Usage | undefined> {
  if (!root) return undefined;
  return measure(root).catch(() => undefined);
}

/** Marks something in use until the answer is called. */
export function hold(kind: "state" | "cache", key: string): () => void {
  const id = `${kind}:${kind === "cache" ? resolve(key) : key}`;
  busy.set(id, (busy.get(id) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const left = (busy.get(id) ?? 1) - 1;
    if (left > 0) busy.set(id, left);
    else busy.delete(id);
  };
}
const inUse = (kind: "state" | "cache", key: string) => busy.has(`${kind}:${key}`);

// ---- The marks ---------------------------------------------------------------------------------------------

/** The state copy in dir is the save NoMac keeps (saved_at): it uploaded there, or a restore NoMac sent named it. */
export async function markStored(dir: string, savedAt: string): Promise<void> {
  await writeFile(join(dir, STORED), JSON.stringify({ saved_at: savedAt, used_at: new Date().toISOString() })).catch(() => undefined);
}

/** A state copy used again (restored): it is cleared after those used less recently. */
export async function markUsed(dir: string): Promise<void> {
  const mark = await readJson(join(dir, STORED));
  if (typeof mark?.saved_at === "string") await markStored(dir, mark.saved_at);
}

// ---- What may go -------------------------------------------------------------------------------------------

type Candidate = { kind: "state" | "cache" | "leftover"; path: string; key: string; at: number };

async function readJson(path: string): Promise<Record<string, unknown> | undefined> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** A folder itself, not a link to one. */
async function realDir(path: string): Promise<boolean> {
  const st = await lstat(path).catch(() => undefined);
  return Boolean(st?.isDirectory());
}

/** Every folder from the workspace down to path is a real folder: nothing is cleared through a link code left there. */
async function realWay(path: string): Promise<boolean> {
  if (!root || (path !== root && !path.startsWith(`${root}${sep}`))) return false;
  let at = root;
  if (!(await realDir(at))) return false;
  for (const part of path.slice(root.length + 1).split(sep).filter(Boolean)) {
    at = join(at, part);
    if (!(await realDir(at))) return false;
  }
  return true;
}

async function entries(dir: string): Promise<string[]> {
  if (!(await realWay(dir))) return [];
  return readdir(dir).catch(() => [] as string[]);
}

/** The state copies in NoMac's storage: a state's own folder whose mark names the save its state.json is. */
async function stateCopies(): Promise<Candidate[]> {
  const dir = join(root!, "phone-states");
  const found: Candidate[] = [];
  for (const name of await entries(dir)) {
    const at = join(dir, name);
    if (!STATE_NAME.test(name) || !(await realDir(at))) continue;
    const meta = await readJson(join(at, "state.json"));
    if (meta?.name !== name || typeof meta.saved_at !== "string") continue;
    const mark = await readJson(join(at, STORED));
    if (mark?.saved_at !== meta.saved_at) continue;
    const used = Date.parse(String(mark.used_at)) || Date.parse(meta.saved_at) || 0;
    found.push({ kind: "state", path: at, key: name, at: used });
  }
  return found.sort((a, b) => a.at - b.at);
}

/** Build caches but the newest DerivedData (the project used last): least recently used first. */
async function buildCaches(): Promise<Candidate[]> {
  if (!cache || !(await realWay(cache))) return [];
  const derived = join(cache, "DerivedData");
  const found: Candidate[] = [];
  for (const name of await entries(derived)) {
    const at = join(derived, name);
    const st = await lstat(at).catch(() => undefined);
    if (st?.isDirectory()) found.push({ kind: "cache", path: at, key: at, at: st.mtimeMs });
  }
  found.sort((a, b) => b.at - a.at).shift();
  // CocoaPods' downloads (pods installed in a project stay with it): their last use is the last pod install's.
  const pods = join(cache, "cocoapods", "cache");
  if (await realWay(pods)) {
    const times = await Promise.all([pods, join(cache, "cocoapods", "config.yaml")].map((p) => lstat(p).then((s) => s.mtimeMs, () => 0)));
    found.push({ kind: "cache", path: pods, key: pods, at: Math.max(...times) });
  }
  return found.sort((a, b) => a.at - b.at);
}

/**
 * What earlier phones' work left half done, by the names simulator-use gives it: a save cut short (<name>.saving), a
 * restore's fetch (.<name>.fetching-XXXXXX), an upload's unpack (src/.nomac-upload-XXXXXX), a sync's archive
 * (src/.nomac-sync/archive-<pid>-<ms>.tar.gz) and what a clearing cut short left in the trash. A folder by those names
 * that is a state's own (its state.json names it) is a state, never a leftover.
 */
async function leftovers(): Promise<Candidate[]> {
  const found: Candidate[] = [];
  const add = (path: string) => found.push({ kind: "leftover", path, key: path, at: 0 });
  const states = join(root!, "phone-states");
  for (const name of await entries(states)) {
    if (!/\.saving$/.test(name) && !/^\..+\.fetching-[A-Za-z0-9]{6}$/.test(name)) continue;
    const at = join(states, name);
    if (!(await realDir(at)) || (await readJson(join(at, "state.json")))?.name === name) continue;
    add(at);
  }
  const src = join(root!, "src");
  for (const name of await entries(src)) if (/^\.nomac-upload-[A-Za-z0-9]{6}$/.test(name) && (await realDir(join(src, name)))) add(join(src, name));
  const sync = join(src, ".nomac-sync");
  for (const name of await entries(sync)) if (/^archive-\d+-\d+\.tar\.gz$/.test(name)) add(join(sync, name));
  for (const name of await entries(join(root!, TRASH))) add(join(root!, TRASH, name));
  return found;
}

/** Moved into the trash at once (whole or not at all), then deleted. */
async function remove(path: string): Promise<boolean> {
  const trash = join(root!, TRASH);
  if (path.startsWith(`${trash}${sep}`)) {
    await rm(path, { recursive: true, force: true }).catch(() => undefined);
    return true;
  }
  const st = await lstat(trash).catch(() => undefined);
  if (st && !st.isDirectory()) await unlink(trash).catch(() => undefined);
  if (!st || !st.isDirectory()) await mkdir(trash, { mode: 0o700 }).catch(() => undefined);
  const to = join(trash, `${Date.now()}-${randomBytes(4).toString("hex")}`);
  try {
    await rename(path, to);
  } catch {
    return false;
  }
  await rm(to, { recursive: true, force: true }).catch(() => undefined);
  return true;
}

/**
 * Clears what may go until free reaches target (all of it with all), leftovers first at a mount. Runs inside
 * exclusive. Each candidate is checked again right before it goes: a state saved or restored, or a cache a build took,
 * since the list was made stays.
 */
async function clear(reason: string, options: { target?: number; mount?: boolean; all?: boolean }): Promise<Report | undefined> {
  if (!root) return undefined;
  const before = await usage();
  if (!before) return undefined;
  const target = options.target ?? floorOf(before.total);
  const report: Report = { reason, free_before: before.free, free_after: before.free, total: before.total, states: 0, state_bytes: 0, caches: 0, cache_bytes: 0, leftovers: 0, leftover_bytes: 0 };
  let free = before.free;
  const take = async (c: Candidate) => {
    if ((c.kind === "state" && inUse("state", c.key)) || (c.kind === "cache" && inUse("cache", c.key))) return;
    if (!(await remove(c.path))) return;
    const now = await usage();
    const freed = now ? Math.max(0, now.free - free) : 0;
    if (now) free = now.free;
    if (c.kind === "state") {
      report.states++;
      report.state_bytes += freed;
    } else if (c.kind === "cache") {
      report.caches++;
      report.cache_bytes += freed;
    } else {
      report.leftovers++;
      report.leftover_bytes += freed;
    }
  };
  if (options.mount) for (const c of await leftovers()) await take(c);
  for (const list of [stateCopies, buildCaches]) {
    if (!options.all && free >= target) break;
    for (const c of await list()) {
      if (!options.all && free >= target) break;
      await take(c);
    }
  }
  report.free_after = free;
  if (report.states + report.caches + report.leftovers > 0) notifier?.(report);
  return report;
}

const cleared = (r: Report | undefined) => Boolean(r && r.states + r.caches + r.leftovers > 0);

// ---- Before a write ----------------------------------------------------------------------------------------

/**
 * Room for a write: copies and caches cleared until the workspace has its floor free, or want if that is more. A
 * write that cannot happen at all without must bytes (an upload of that size) fails here, plainly, when they cannot be
 * made. Waits for a clearing under way, so nothing it takes is read meanwhile.
 */
export async function ensureRoom(reason: string, want = 0, must = 0): Promise<void> {
  if (!root) return;
  const now = await exclusive(async () => {
    const before = await usage();
    if (!before) return undefined;
    if (before.free >= Math.max(floorOf(before.total), want)) return before;
    await clear(reason, { target: Math.max(floorOf(before.total), want) });
    return usage();
  });
  if (must > 0 && now && now.free < must) throw await full(reason, now);
}

/**
 * Runs a write; one that runs out of room clears all that may go and runs once more. Out of room again, or with
 * nothing to clear, it fails with fullText. The write must start over cleanly (its own half-written files first).
 */
export async function retryWithRoom<T>(reason: string, work: () => Promise<T>): Promise<T> {
  if (!root) return work();
  try {
    return await work();
  } catch (error) {
    if (!noSpace(error)) throw error;
    if (!cleared(await clearForNoSpace(reason))) throw await full(reason);
    try {
      return await work();
    } catch (again) {
      throw noSpace(again) ? await full(reason) : again;
    }
  }
}

/** ensureRoom, then the write with retryWithRoom. */
export async function withRoom<T>(reason: string, work: () => Promise<T>, want = 0): Promise<T> {
  await ensureRoom(reason, want);
  return retryWithRoom(reason, work);
}

/** After a write ran out of room: all that may go (the newest cache and what is in use stay). */
export const clearForNoSpace = (reason: string) => exclusive(() => clear(reason, { all: true }));

/** clearForNoSpace, answering whether it cleared anything, so the write is worth running again. */
export const roomAfterNoSpace = async (reason: string) => cleared(await clearForNoSpace(reason));

/** Whether an error, or a program's output, says the disk or its quota is full. */
export function noSpace(error: unknown): boolean {
  const code = (error as { code?: unknown } | undefined)?.code;
  if (code === "ENOSPC" || code === "EDQUOT") return true;
  const text = error instanceof Error ? `${error.message}\n${String((error as { stderr?: unknown }).stderr ?? "")}` : String(error ?? "");
  return noSpaceText(text);
}

export const noSpaceText = (text: string) => /ENOSPC|EDQUOT|No space left on device|Dis[ck] quota exceeded|errno[ =]28\b/i.test(text);

const gb = (bytes: number) => (bytes / 1e9).toFixed(1);

/** What the agent reads when its workspace is full: what fills it, and what it can do. No path, no name. */
export function fullMessage(now?: Usage): { message: string; next: string } {
  const used = now ? ` (${gb(now.total - now.free)} of its ${gb(now.total)} GB in use)` : "";
  return {
    message: `This account's phone workspace is full${used}, even after NoMac cleared what it can bring back by itself (copies of saved states kept in NoMac's storage, older build caches). What is left is the account's own: its projects, uploads and saved states.`,
    next: "delete saved states you no longer need with the phone tool's delete_state action (states lists them), then try again.",
  };
}

export function fullText(now?: Usage): string {
  const { message, next } = fullMessage(now);
  return `${message}\nNext: ${next}`;
}

async function full(reason: string, now?: Usage): Promise<Error> {
  const at = now ?? (await usage());
  if (at) notifier?.({ reason, free_before: at.free, free_after: at.free, total: at.total, states: 0, state_bytes: 0, caches: 0, cache_bytes: 0, leftovers: 0, leftover_bytes: 0, full: true });
  return Object.assign(new Error(`workspace_full: ${fullText(at)}`), { code: "workspace_full" });
}
