/**
 * NoMac Simulator's sync, from cloud mode: a project folder sent to the phone's workspace with only what the
 * workspace lacks. The manifest (each file's path, size, mtime and SHA-256) goes in pages; the host answers the
 * paths it lacks; those go as one gzip tar, in 256 KiB chunks up to 8 MiB, else to an upload link; place writes
 * them and every mtime (new mtimes alone make Xcode compile again), and removes what the folder no longer has.
 * Build output and dependencies are left out, and left alone on the host. A file's hash is kept in an index on
 * this machine, so only files that changed since the last sync are read again.
 */

import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createReadStream, lstatSync, readdirSync, realpathSync, type Stats } from "node:fs";
import { mkdir, mkdtemp, readFile, readlink, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";

import { run } from "../engine/exec.ts";
import { stateDir } from "../engine/state.ts";
import { setting } from "../settings.ts";
import type { CloudApi } from "./api.ts";

export type Entry = { path: string; size: number; mtime_ms: number; sha256: string; kind: "file" | "executable" | "symlink" };

/** Folders a build makes or a package manager fills: never sent, never removed on the host. */
export const SKIP_DIRS = new Set([".git", ".hg", ".svn", "DerivedData", "build", ".build", "node_modules", "Pods", "xcuserdata", ".swiftpm", ".expo", ".gradle"]);
const SKIP_FILES = (name: string) => name === ".DS_Store" || name.endsWith(".xcuserstate") || secretFile(name);
/**
 * Key and credential files, never sent even when git tracks them: environment files (but their examples), signing
 * keys and certificates, provisioning profiles, keystores, SSH keys and .netrc. A Simulator build needs none of them.
 */
export const secretFile = (name: string) =>
  (/^\.env(\..+)?$/.test(name) && !/\.(example|sample|template)$/.test(name)) ||
  /\.(p8|p12|pfx|pem|key|mobileprovision|provisionprofile|keystore|jks)$/i.test(name) ||
  /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/.test(name) ||
  name === ".netrc";
// The protocol's limits (NoMac's mac-protocol, simManifestEntrySchema and the sim route's body).
const PAGE_ENTRIES = 1000;
const PAGE_BYTES = 192 * 1024;
const CHUNK = 256 * 1024;
const INLINE_MAX = 8 * 1024 * 1024;
const ARCHIVE_MAX = 2 * 1024 ** 3;

/**
 * The project's files as the host is to have them: in a git repository, the files git tracks or would track
 * (.gitignore's rules kept), else the folder's; build output, dependencies, editor state and key or credential files
 * left out either way. With only (a .app beside others in its folder), that one alone and all of it: a bundle's own
 * folders (an app's node_modules or build) are part of the app. Files are hashed a few at a time, never blocking the process (a
 * cloud tunnel runs in it), and a file whose size, mtime, ctime and inode match the index is not read again.
 */
export async function listProject(folder: string, only?: string): Promise<Entry[]> {
  const found: { rel: string; path: string; st: Stats }[] = [];
  const walk = (dir: string, whole: boolean) => {
    for (const name of readdirSync(dir).sort()) {
      if (SKIP_FILES(name)) continue;
      const path = join(dir, name);
      const st = lstatSync(path);
      if (st.isDirectory()) {
        if (whole || !SKIP_DIRS.has(name)) walk(path, whole);
        continue;
      }
      if (st.isSymbolicLink() || st.isFile()) found.push({ rel: relative(folder, path).split(sep).join("/"), path, st });
    }
  };
  if (only) {
    const top = join(folder, only);
    if (lstatSync(top, { throwIfNoEntry: false })?.isDirectory()) walk(top, true);
  } else {
    const tracked = await filesInGit(folder);
    if (!tracked) walk(folder, false);
    else {
      for (const rel of tracked.sort()) {
        const parts = rel.split("/");
        if (SKIP_FILES(parts.at(-1)!) || parts.slice(0, -1).some((part) => SKIP_DIRS.has(part))) continue;
        const path = join(folder, ...parts);
        const st = lstatSync(path, { throwIfNoEntry: false });
        if (st && (st.isSymbolicLink() || st.isFile())) found.push({ rel, path, st });
      }
    }
  }

  // Windows keeps no executable bit: git's index has it for the files it tracks (a build phase's script).
  const gitExecutable = process.platform === "win32" ? await executablesInGit(folder) : undefined;
  const indexed = setting("SYNC_INDEX") !== "0";
  const file = indexFile(folder, only);
  const last = indexed ? await readIndex(file) : undefined;
  const scanned = Date.now();
  const next: Record<string, Indexed> = {};
  const out: Entry[] = new Array(found.length);
  await eachLimit(found, HASHING, async ({ rel, path, st }, i) => {
    if (st.isSymbolicLink()) {
      const target = await readlink(path);
      out[i] = { path: rel, size: Buffer.byteLength(target), mtime_ms: Math.floor(st.mtimeMs), sha256: sha256(target), kind: "symlink" };
      return;
    }
    const known = last?.files[rel];
    // Git's rule for a racy entry: a file changed within RACY_MS of the last scan may have changed again since,
    // with the same mtime, so it is read again.
    const same = known && known.size === st.size && known.mtime_ms === st.mtimeMs && known.ctime_ms === st.ctimeMs && known.ino === st.ino && st.mtimeMs < last!.scanned_ms - RACY_MS;
    const hash = same ? known.sha256 : await hashFile(path, st.size);
    next[rel] = { size: st.size, mtime_ms: st.mtimeMs, ctime_ms: st.ctimeMs, ino: st.ino, sha256: hash };
    const executable = gitExecutable ? gitExecutable.has(rel) : Boolean(st.mode & 0o111);
    out[i] = { path: rel, size: st.size, mtime_ms: Math.floor(st.mtimeMs), sha256: hash, kind: executable ? "executable" : "file" };
  });
  if (indexed) await writeIndex(file, { scanned_ms: scanned, files: next }).catch(() => undefined);
  return out;
}

/** The files git tracks as executable (mode 100755) under folder, by their path from it; none outside a repository. */
/**
 * The files git tracks in folder, or would (untracked but not ignored), from the folder, a submodule's too; undefined
 * when folder is not a repository's top (or git is not there).
 */
export async function filesInGit(folder: string): Promise<string[] | undefined> {
  try {
    const top = (await run("git", ["-C", folder, "rev-parse", "--show-toplevel"], { timeoutMs: 5_000 })).stdout.trim();
    if (realpathSync(top) !== realpathSync(folder)) return undefined;
  } catch {
    return undefined;
  }
  const list = async (dir: string, prefix: string, depth: number): Promise<string[]> => {
    const listed = (await run("git", ["-C", dir, "ls-files", "-co", "--exclude-standard", "-z"], { timeoutMs: 60_000 })).stdout.split("\0").filter(Boolean);
    const out: string[] = [];
    for (const rel of listed.map((path) => path.replace(/\/+$/, ""))) {
      // A submodule (or a repository inside) is listed as its folder: its own files, by its own rules.
      if (depth < 4 && lstatSync(join(dir, rel), { throwIfNoEntry: false })?.isDirectory()) out.push(...(await list(join(dir, rel), `${prefix}${rel}/`, depth + 1).catch(() => [])));
      else out.push(`${prefix}${rel}`);
    }
    return out;
  };
  try {
    return await list(folder, "", 0);
  } catch {
    return undefined;
  }
}

export async function executablesInGit(folder: string): Promise<Set<string>> {
  try {
    const listed = (await run("git", ["-C", folder, "ls-files", "-s", "-z"], { timeoutMs: 30_000 })).stdout;
    // Each entry: <mode> <object> <stage>\t<path>, NUL-separated; the paths are from the folder.
    return new Set(listed.split("\0").filter((e) => e.startsWith("100755 ")).map((e) => e.slice(e.indexOf("\t") + 1)));
  } catch {
    return new Set();
  }
}

// ---- The hash index: per folder on this machine, never sent --------------------------------------------------

type Indexed = { size: number; mtime_ms: number; ctime_ms: number; ino: number; sha256: string };
type SyncIndex = { scanned_ms: number; files: Record<string, Indexed> };

/** Files hashed at once. */
const HASHING = 8;
/** A file changed within this long of a scan is read again at the next one (coarse mtimes on some file systems). */
const RACY_MS = 2_000;

const indexFile = (folder: string, only?: string) => join(stateDir(), "sync-index", `${sha256(`${realpathSync(folder)}\0${only ?? ""}`).slice(0, 32)}.json`);

async function readIndex(file: string): Promise<SyncIndex | undefined> {
  try {
    const index = JSON.parse(await readFile(file, "utf8")) as SyncIndex;
    return typeof index.scanned_ms === "number" && index.files && typeof index.files === "object" ? index : undefined;
  } catch {
    return undefined;
  }
}

async function writeIndex(file: string, index: SyncIndex): Promise<void> {
  await mkdir(join(stateDir(), "sync-index"), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(index), { mode: 0o600 });
  await rename(tmp, file);
}

/** A file's SHA-256: small files read at once, larger ones streamed. */
async function hashFile(path: string, size: number): Promise<string> {
  if (size < 1024 * 1024) return sha256(await readFile(path));
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

/** Runs work on each item, at most limit at a time. */
async function eachLimit<T>(items: T[], limit: number, work: (item: T, index: number) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      await work(items[i]!, i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");

/** Pages of at most 1000 entries and about 192 KiB each, in the manifest's order. */
export function pages(entries: Entry[]): Entry[][] {
  const out: Entry[][] = [[]];
  let bytes = 0;
  for (const entry of entries) {
    const size = JSON.stringify(entry).length + 1;
    if (out.at(-1)!.length >= PAGE_ENTRIES || (bytes + size > PAGE_BYTES && out.at(-1)!.length)) {
      out.push([]);
      bytes = 0;
    }
    out.at(-1)!.push(entry);
    bytes += size;
  }
  return out;
}

/**
 * The project's id on NoMac: the hash of its git remote (and its folder inside the repository), or of the folder's
 * path where it has none, so the same project lands in the same place in the account's workspace from any clone.
 */
export async function projectId(folder: string): Promise<string> {
  let key = realpathSync(folder);
  try {
    const remote = (await run("git", ["-C", folder, "config", "--get", "remote.origin.url"], { timeoutMs: 5_000 })).stdout.trim();
    const top = (await run("git", ["-C", folder, "rev-parse", "--show-toplevel"], { timeoutMs: 5_000 })).stdout.trim();
    if (remote && top) key = `${normalizeRemote(remote)}#${relative(realpathSync(top), key).split(sep).join("/")}`;
  } catch {
    // Not a git repository, or no remote: the folder's own path.
  }
  return `prj_${sha256(key).slice(0, 32)}`;
}

/** git@github.com:a/b.git, https://user:token@github.com/a/b and https://github.com/a/b/ are one remote. */
export function normalizeRemote(remote: string): string {
  const scp = /^[\w.-]+@([^:/]+):(.+)$/.exec(remote);
  const url = scp ? `ssh://${scp[1]}/${scp[2]}` : remote;
  try {
    const u = new URL(url);
    return `${u.hostname.toLowerCase()}/${u.pathname.replace(/^\/+|\/+$/g, "").replace(/\.git$/, "")}`;
  } catch {
    return remote.replace(/\.git$/, "");
  }
}

/** A gzip tar of these paths, without macOS's metadata files, paths read NUL-separated from a list. */
async function pack(folder: string, paths: string[], file: string): Promise<void> {
  const list = `${file}.list`;
  await writeFile(list, `${paths.join("\0")}\0`);
  const args = [...(process.platform === "darwin" ? ["--no-mac-metadata"] : []), "--null", "-czf", file, "-C", folder, "-T", list];
  await new Promise<void>((resolve, reject) => {
    const child = spawn("tar", args, { env: { ...process.env, COPYFILE_DISABLE: "1" }, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`tar: ${stderr.trim().slice(0, 300) || `exit ${code}`}`))));
  });
}

export type Synced = { root: string; files: number; sent: number; bytes: number; ms: number };

export type SyncOptions = {
  /** Only this entry of the folder and what is in it (a .app sent for app_control install). */
  only?: string;
  /** The project's id, when it is not the folder's own. */
  project?: string;
  onStep?: (step: string) => void;
};

/** Sends a folder to the phone's workspace. Answers where it is on the host: the path app_run and tests_run take. */
export async function syncFolder(api: CloudApi, session: string, folder: string, options: SyncOptions = {}): Promise<Synced> {
  const { only, onStep } = options;
  const started = Date.now();
  const entries = await listProject(folder, only);
  if (!entries.length) throw new Error(`${folder} has no files to send.`);
  const project = options.project ?? (await projectId(folder));
  const sync = `cli-${randomKey()}`;
  const book = pages(entries);
  if (book.length > 256) throw new Error(`${folder} has ${entries.length} files: more than NoMac's sync takes (256 pages).`);
  onStep?.(`listing ${entries.length} files`);
  // Pages go 4 at a time: the host keeps each by its number, and places once it has them all.
  const answered: string[][] = new Array(book.length);
  await eachLimit(book, 4, async (entriesOfPage, page) => {
    const answer = await api.json("POST", `/api/v1/simulator/sessions/${session}/sync`, { op: "manifest", sync, project, page, pages: book.length, entries: entriesOfPage });
    // Only paths this page listed are packed: an answer naming any other file of the folder sends nothing more.
    const listed = new Set(entriesOfPage.map((e) => e.path));
    answered[page] = ((answer.missing as unknown[] | undefined) ?? []).filter((path): path is string => typeof path === "string" && listed.has(path));
  });
  const missing = answered.flat();
  let archive: Record<string, unknown> | undefined;
  let bytes = 0;
  if (missing.length) {
    onStep?.(`sending ${missing.length} file${missing.length > 1 ? "s" : ""}`);
    const dir = await mkdtemp(join(tmpdir(), "simulator-use-sync-"));
    try {
      const file = join(dir, "archive.tgz");
      await pack(folder, missing, file);
      const data = await readFile(file);
      bytes = data.length;
      if (bytes > ARCHIVE_MAX) throw new Error(`The changed files pack to ${Math.round(bytes / 1024 ** 2)} MB: more than the 2 GB a sync takes.`);
      const sum = sha256(data);
      if (bytes <= INLINE_MAX) {
        for (let offset = 0; offset < bytes || offset === 0; offset += CHUNK) {
          await api.json("PUT", `/api/v1/simulator/sessions/${session}/sync/blobs/${sum}?size=${bytes}&offset=${offset}`, data.subarray(offset, Math.min(offset + CHUNK, bytes)));
          if (bytes === 0) break;
        }
        archive = { blob: sum };
      } else {
        // Larger archives go straight to storage, and the host fetches them from there.
        const link = await api.json("POST", `/api/v1/simulator/sessions/${session}/sync/upload`, { size: bytes, sha256: sum });
        const put = await fetch(String(link.upload_url), { method: "PUT", body: data, headers: { "content-length": String(bytes) } });
        if (!put.ok) throw new Error(`The upload to NoMac's storage failed: ${put.status}.`);
        archive = link.archive as Record<string, unknown>;
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
  onStep?.("placing");
  for (const deadline = Date.now() + 10 * 60_000; ; ) {
    const placed = await api.json("POST", `/api/v1/simulator/sessions/${session}/sync`, { op: "place", sync, ...(archive ? { archive } : {}) });
    if (placed.state === "done") return { root: String(placed.root), files: entries.length, sent: missing.length, bytes, ms: Date.now() - started };
    if (placed.state !== "running") throw new Error(`The sync failed on the phone: ${String(placed.error ?? placed.state)}.`);
    if (Date.now() > deadline) throw new Error("The sync was still being written after 10 minutes.");
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
}

export const randomKey = () => randomBytes(16).toString("hex");
