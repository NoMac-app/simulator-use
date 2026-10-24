/**
 * NoMac Simulator's sync, from cloud mode: a project folder sent to the phone's workspace with only what the
 * workspace lacks. The manifest (each file's path, size, mtime and SHA-256) goes in pages; the host answers the
 * paths it lacks; those go as one gzip tar, in 256 KiB chunks up to 8 MiB, else to an upload link; place writes
 * them and every mtime (new mtimes alone make Xcode compile again), and removes what the folder no longer has.
 * Build output and dependencies are left out, and left alone on the host.
 */

import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";

import { run } from "../engine/exec.ts";
import type { CloudApi } from "./api.ts";

export type Entry = { path: string; size: number; mtime_ms: number; sha256: string; kind: "file" | "executable" | "symlink" };

/** Folders a build makes or a package manager fills: never sent, never removed on the host. */
export const SKIP_DIRS = new Set([".git", ".hg", ".svn", "DerivedData", "build", ".build", "node_modules", "Pods", "xcuserdata", ".swiftpm", ".expo", ".gradle"]);
const SKIP_FILES = (name: string) => name === ".DS_Store" || name.endsWith(".xcuserstate");
// The protocol's limits (NoMac's mac-protocol, simManifestEntrySchema and the sim route's body).
const PAGE_ENTRIES = 1000;
const PAGE_BYTES = 192 * 1024;
const CHUNK = 256 * 1024;
const INLINE_MAX = 8 * 1024 * 1024;
const ARCHIVE_MAX = 2 * 1024 ** 3;

/**
 * The project's files as the host is to have them: build output, dependencies and editor state left out. With
 * only (a .app beside others in its folder), that one alone and all of it: a bundle's own folders (an app's
 * node_modules or build) are part of the app.
 */
export function listProject(folder: string, only?: string): Entry[] {
  const out: Entry[] = [];
  const walk = (dir: string, whole: boolean) => {
    for (const name of readdirSync(dir).sort()) {
      if (SKIP_FILES(name)) continue;
      const path = join(dir, name);
      const st = lstatSync(path);
      if (st.isDirectory()) {
        if (whole || !SKIP_DIRS.has(name)) walk(path, whole);
        continue;
      }
      const rel = relative(folder, path).split(sep).join("/");
      if (st.isSymbolicLink()) {
        const target = readlinkSync(path);
        out.push({ path: rel, size: Buffer.byteLength(target), mtime_ms: Math.floor(st.mtimeMs), sha256: sha256(target), kind: "symlink" });
      } else if (st.isFile()) {
        out.push({ path: rel, size: st.size, mtime_ms: Math.floor(st.mtimeMs), sha256: sha256(readFileSync(path)), kind: st.mode & 0o111 ? "executable" : "file" });
      }
    }
  };
  if (only) {
    const top = join(folder, only);
    if (lstatSync(top, { throwIfNoEntry: false })?.isDirectory()) walk(top, true);
  } else walk(folder, false);
  return out;
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
  const entries = listProject(folder, only);
  if (!entries.length) throw new Error(`${folder} has no files to send.`);
  const project = options.project ?? (await projectId(folder));
  const sync = `cli-${randomKey()}`;
  const book = pages(entries);
  if (book.length > 256) throw new Error(`${folder} has ${entries.length} files: more than NoMac's sync takes (256 pages).`);
  onStep?.(`listing ${entries.length} files`);
  const missing: string[] = [];
  for (let page = 0; page < book.length; page++) {
    const answer = await api.json("POST", `/api/v1/simulator/sessions/${session}/sync`, { op: "manifest", sync, project, page, pages: book.length, entries: book[page] });
    missing.push(...((answer.missing as string[] | undefined) ?? []));
  }
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
