/**
 * What NoMac Simulator's host asks of a phone's session server besides tool calls (SIMULATOR_USE_HOSTED). The
 * server runs as the phone's pool user, the only user that may touch the account's workspace, so the sync's file
 * work happens here: hostd checks every request's shape first (mac-protocol's sim operation) and passes it on.
 */

import { type ChildProcess, execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, statSync } from "node:fs";
import { chmod, lstat, lutimes, mkdir, mkdtemp, readdir, readFile, readlink, rename, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, sep } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import { run } from "./engine/exec.ts";
import { closeEngines, engineCall } from "./engine/native.ts";
import { cancelAllJobs } from "./engine/jobs.ts";
import { listDevices, pickDevice } from "./engine/simctl.ts";
import { heldDevice, stateDir } from "./engine/state.ts";
import { normalizeRemote, SKIP_DIRS } from "./cloud/sync.ts";
import { callTool } from "./registry.ts";
import { fetchState, uploadState } from "./state-archive.ts";

type Kind = "file" | "executable" | "symlink";
type Entry = { path: string; size: number; mtime_ms: number; sha256: string; kind?: Kind };
type Indexed = { size: number; mtime_ms: number; sha256: string; kind: Kind };
type Placed = { state: "running" | "done" | "failed"; root?: string; written?: number; removed?: number; error?: string };
type Sync = { project: string; pages: Map<number, Entry[]>; total: number; missing: Set<string>; place?: Placed };

const PROJECT = /^prj_[a-f0-9]{32}$/;
const SYNC = /^sync_[a-f0-9]{40}$/;
const SHA = /^[a-f0-9]{64}$/;
// A sync's pages wait here until its place; only the latest few are kept.
const KEEP_SYNCS = 8;
// place answers within this, or that it runs (hostd asks again).
let ANSWER_WITHIN_MS = 8_000;
export const setAnswerWithin = (ms: number) => (ANSWER_WITHIN_MS = ms);

let workspace: string | undefined;
const syncs = new Map<string, Sync>();

const invalid = (message: string) => Object.assign(new Error(message), { code: -32602 });
const absolute = (value: unknown): value is string =>
  typeof value === "string" && value.startsWith("/") && !value.includes("\0") && !value.split("/").includes("..") && value.length <= 1024;
const safePath = (path: unknown): path is string =>
  typeof path === "string" && path.length > 0 && !path.includes("\0") && !path.includes("\\") && path.split("/").every((part) => part !== "" && part !== "." && part !== "..");

/** The host tells a warm server, at hand-over, the account's build cache and workspace. */
export function configure(params: Record<string, unknown>): Record<string, never> {
  for (const key of ["cache_dir", "workspace"]) if (params[key] !== undefined && !absolute(params[key])) throw invalid(`${key} must be an absolute path`);
  if (params.cache_dir !== undefined) process.env.SIMULATOR_USE_CACHE_DIR = params.cache_dir as string;
  if (params.workspace !== undefined) workspace = params.workspace as string;
  return {};
}

const srcRoot = () => {
  if (!workspace) throw Object.assign(new Error("no_workspace"), { code: -32000 });
  return join(workspace, "src");
};
const indexFile = (project: string) => join(srcRoot(), ".nomac-sync", `${project}.json`);

async function readIndex(project: string): Promise<Record<string, Indexed>> {
  try {
    return JSON.parse(await readFile(indexFile(project), "utf8")) as Record<string, Indexed>;
  } catch {
    return {};
  }
}

/**
 * One page of the client's file list: answers the paths whose content this workspace lacks (new, changed, or
 * gone from the folder since the last sync).
 */
async function manifest(params: Record<string, unknown>): Promise<{ missing: string[] }> {
  const { id, project, page, pages, entries } = params as { id: unknown; project: unknown; page: unknown; pages: unknown; entries: unknown };
  if (typeof id !== "string" || !SYNC.test(id) || typeof project !== "string" || !PROJECT.test(project)) throw invalid("sync id or project");
  if (!Number.isInteger(page) || !Number.isInteger(pages) || (page as number) < 0 || (page as number) >= (pages as number) || !Array.isArray(entries)) throw invalid("page");
  for (const e of entries as Entry[]) if (!e || !safePath(e.path) || !SHA.test(e.sha256) || !Number.isInteger(e.size) || !Number.isInteger(e.mtime_ms)) throw invalid("entry");
  let sync = syncs.get(id);
  if (!sync) {
    sync = { project, pages: new Map(), total: pages as number, missing: new Set() };
    syncs.set(id, sync);
    while (syncs.size > KEEP_SYNCS) syncs.delete(syncs.keys().next().value!);
  }
  if (sync.project !== project || sync.total !== pages) throw invalid("the sync's project or page count changed");
  sync.pages.set(page as number, entries as Entry[]);
  const index = await readIndex(project);
  const root = join(srcRoot(), project);
  const missing: string[] = [];
  for (const e of entries as Entry[]) {
    const known = index[e.path];
    let present = false;
    if (known && known.sha256 === e.sha256 && known.kind === (e.kind ?? "file")) {
      present = await lstat(join(root, e.path)).then((st) => (known.kind === "symlink" ? st.isSymbolicLink() : st.isFile() && st.size === e.size), () => false);
    }
    if (!present) {
      missing.push(e.path);
      sync.missing.add(e.path);
    }
  }
  return { missing };
}

/**
 * Writes a sync into the workspace once all its pages arrived: the archive of the missing files (a gzip tar, given
 * inline or as a link), every file's mtime from the manifest (new mtimes alone make Xcode compile again), and the
 * removal of files the last sync had and this one does not. Nothing else in the folder is touched (dependencies
 * installed on the host, build output). Answers within a few seconds, or that it runs.
 */
async function place(params: Record<string, unknown>): Promise<Placed> {
  const id = params.id;
  const sync = typeof id === "string" ? syncs.get(id) : undefined;
  if (!sync) throw invalid("unknown sync: send its manifest first");
  if (sync.pages.size !== sync.total) throw invalid(`the manifest has ${sync.pages.size} of ${sync.total} pages`);
  if (!sync.place) {
    sync.place = { state: "running" };
    const placed = sync.place;
    write(sync, params.archive as Record<string, unknown> | undefined).then(
      (result) => Object.assign(placed, { state: "done" }, result),
      (error: Error) => Object.assign(placed, { state: "failed", error: error.message.slice(0, 300) }),
    );
  }
  const deadline = Date.now() + ANSWER_WITHIN_MS;
  while (sync.place.state === "running" && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  return { ...sync.place };
}

/** An archive holds the files the manifest asked for and the folders they are in, nothing else. */
async function onlyAskedFor(file: string, missing: Set<string>): Promise<void> {
  const { stdout } = await run("/usr/bin/tar", ["-tzf", file], { timeoutMs: 5 * 60_000 });
  for (const line of stdout.split("\n")) {
    const member = line.replace(/^\.\//, "").replace(/\/+$/, "");
    if (member === "" || member === "." || missing.has(member)) continue;
    if (![...missing].some((path) => path.startsWith(`${member}/`))) throw new Error(`archive_unexpected: ${member.slice(0, 200)} was not asked for`);
  }
}

/**
 * Every file the manifest asked for is in the folder with the kind, size and content it announced. A sync whose
 * archive lacked one (a client that split a large sync, or a broken archive) fails here, before the index says
 * the workspace has it, so the next manifest asks for it again.
 */
async function asAnnounced(root: string, entries: Entry[], missing: Set<string>): Promise<void> {
  const byPath = new Map(entries.map((e) => [e.path, e]));
  const wrong: string[] = [];
  for (const path of missing) {
    const e = byPath.get(path);
    if (!e) continue;
    const at = join(root, path);
    const st = await lstat(at).catch(() => undefined);
    let why: string | undefined;
    if (!st) why = "not in the archive";
    else if ((e.kind ?? "file") === "symlink") {
      if (!st.isSymbolicLink()) why = "not a symbolic link";
      else if (createHash("sha256").update(await readlink(at)).digest("hex") !== e.sha256) why = "a different link";
    } else if (!st.isFile()) why = "not a file";
    else if (st.size !== e.size) why = `${st.size} bytes, not ${e.size}`;
    else {
      const hash = createHash("sha256");
      await pipeline(createReadStream(at), hash);
      if (hash.digest("hex") !== e.sha256) why = "different content";
    }
    if (why) wrong.push(`${path.slice(0, 200)} (${why})`);
  }
  if (wrong.length) throw new Error(`archive_incomplete: ${wrong.length} of the ${missing.size} files asked for are not as the manifest said: ${wrong.slice(0, 3).join("; ")}`);
}

async function write(sync: Sync, archive: Record<string, unknown> | undefined): Promise<{ root: string; written: number; removed: number }> {
  const root = join(srcRoot(), sync.project);
  const work = join(srcRoot(), ".nomac-sync");
  await mkdir(root, { recursive: true });
  await mkdir(work, { recursive: true });
  const entries = [...sync.pages.values()].flat();
  if (archive) {
    const file = join(work, `archive-${process.pid}-${Date.now()}.tar.gz`);
    try {
      if (typeof archive.base64 === "string") {
        await writeFile(file, Buffer.from(archive.base64, "base64"));
      } else if (typeof archive.url === "string" && archive.url.startsWith("https://")) {
        const response = await fetch(archive.url);
        if (!response.ok || !response.body) throw new Error(`archive_download_failed: ${response.status}`);
        await pipeline(Readable.fromWeb(response.body as never), createWriteStream(file));
      } else {
        throw new Error("archive_invalid");
      }
      if (typeof archive.sha256 === "string") {
        const hash = createHash("sha256");
        await pipeline(createReadStream(file), hash);
        if (hash.digest("hex") !== archive.sha256) throw new Error("archive_checksum_mismatch");
      }
      await onlyAskedFor(file, sync.missing);
      // bsdtar keeps every entry inside root: it strips a leading / and refuses .. without -P.
      await run("/usr/bin/tar", ["-xzf", file, "-C", root], { timeoutMs: 10 * 60_000 });
    } finally {
      await unlink(file).catch(() => {});
    }
  }
  // The index records only what is really here: every file the manifest asked for, as it announced it.
  await asAnnounced(root, entries, sync.missing);
  // Modes and mtimes are written only where they differ: reading is cheap, and a sync then costs what changed,
  // not every file of the project (a host busy preparing a phone made 758 writes take 7 s, October 23).
  for (const e of entries) {
    const path = join(root, e.path);
    const kind = e.kind ?? "file";
    const st = await lstat(path).catch(() => undefined);
    if (!st) continue;
    const mode = kind === "executable" ? 0o755 : 0o644;
    if (kind !== "symlink" && (st.mode & 0o777) !== mode) await chmod(path, mode).catch(() => {});
    if (Math.floor(st.mtimeMs) !== e.mtime_ms) {
      const when = new Date(e.mtime_ms);
      await lutimes(path, when, when).catch(() => {});
    }
  }
  const before = await readIndex(sync.project);
  const now = new Set(entries.map((e) => e.path));
  let removed = 0;
  for (const path of Object.keys(before)) {
    if (now.has(path) || !safePath(path)) continue;
    await rm(join(root, path), { force: true });
    removed++;
  }
  const index: Record<string, Indexed> = {};
  for (const e of entries) index[e.path] = { size: e.size, mtime_ms: e.mtime_ms, sha256: e.sha256, kind: e.kind ?? "file" };
  const tmp = `${indexFile(sync.project)}.tmp`;
  await mkdir(dirname(tmp), { recursive: true });
  await writeFile(tmp, JSON.stringify(index));
  await rename(tmp, indexFile(sync.project));
  return { root, written: sync.missing.size, removed };
}

/** A hosted method; anything else is not one. */
// ---- Answers and files ------------------------------------------------------------------------------------

const FILE = /^file_[a-f0-9]{40}$/;
const GET = /^get_[a-f0-9]{40}$/;
// The latest files named in answers, by id; older ones are forgotten.
const KEEP_FILES = 500;
const files = new Map<string, string>();

/** The folders whose files an answer may name: the workspace, the build cache and simulator-use's own. */
function fileRoots(): string[] {
  return [workspace, process.env.SIMULATOR_USE_CACHE_DIR, stateDir()].filter((r): r is string => typeof r === "string" && r.startsWith("/"));
}

function fileId(path: string): string {
  const id = `file_${createHash("sha1").update(path).digest("hex")}`;
  files.delete(id);
  files.set(id, path);
  while (files.size > KEEP_FILES) files.delete(files.keys().next().value!);
  return id;
}

/** One answer text as NoMac's customer reads it (see hostedAnswer). */
export function hostedText(text: string): string {
  let out = text;
  if (workspace) {
    const src = `${workspace}/src/`;
    // A path in a synced project reads relative to that project, as on the customer's own machine.
    out = out.replace(new RegExp(`${escapeRegExp(src)}prj_[a-f0-9]{32}(/|\\b)`, "g"), (_m, slash: string) => (slash === "/" ? "" : "."));
  }
  const roots = fileRoots();
  // Any other file of this host (a build log, a recording, saved logs) becomes an id NoMac turns into a link.
  return out.replace(/\/[^\s'"`()<>,;]+/g, (candidate) => {
    const path = candidate.replace(/[.:]+$/, "");
    const trailing = candidate.slice(path.length);
    if (!roots.some((root) => path === root || path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`))) return candidate;
    try {
      if (!existsSync(path) || !statSync(path).isFile()) return candidate;
    } catch {
      return candidate;
    }
    // The name after the id, so the download keeps it: file_<id>/build-1792758883520.log.
    return `${fileId(path)}/${basename(path)}${trailing}`;
  });
}

/**
 * A tool's answer as a NoMac Simulator customer reads it (SIMULATOR_USE_HOSTED): paths in a synced project
 * relative to it, and this host's other files as file ids, which NoMac's API turns into download links
 * (simulator-use/get). The customer never reads a path of the host.
 */
export function hostedAnswer<T extends { content: unknown[] }>(result: T): T {
  return { ...result, content: result.content.map((c) => (c && typeof c === "object" && (c as { type?: unknown }).type === "text" ? { ...c, text: hostedText(String((c as { text?: unknown }).text ?? "")) } : c)) };
}

type Got = { state: "running" | "done" | "failed"; size?: number; error?: string };
// The latest uploads by id, so a repeated get answers its state; older ones are forgotten.
const KEEP_GETS = 100;
const gets = new Map<string, Got>();

/**
 * Uploads a file an answer named to a link NoMac signed (a presigned PUT), for its download link. Answers within
 * a few seconds, or that it runs (a recording takes longer): the same id answers its state, and starts nothing new.
 */
async function get(params: Record<string, unknown>): Promise<Got> {
  const { id, file, url } = params as { id: unknown; file: unknown; url: unknown };
  if (typeof id !== "string" || !GET.test(id) || typeof file !== "string" || !FILE.test(file) || typeof url !== "string" || !url.startsWith("https://")) throw invalid("get id, file or url");
  let got = gets.get(id);
  if (!got) {
    const path = files.get(file);
    if (!path || !existsSync(path)) throw Object.assign(new Error("file_not_found"), { code: -32000 });
    const started: Got = { state: "running" };
    gets.set(id, started);
    while (gets.size > KEEP_GETS) gets.delete(gets.keys().next().value!);
    upload(path, url).then(
      (size) => Object.assign(started, { state: "done", size }),
      (error: Error) => Object.assign(started, { state: "failed", error: error.message.slice(0, 300) }),
    );
    got = started;
  }
  const deadline = Date.now() + ANSWER_WITHIN_MS;
  while (got.state === "running" && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  return { ...got };
}

/** Streams the file to the link, never whole in memory: as many bytes as it had when the upload began. */
async function upload(path: string, url: string): Promise<number> {
  const { size } = statSync(path);
  const body = size === 0 ? new Uint8Array() : (Readable.toWeb(createReadStream(path, { start: 0, end: size - 1 })) as ReadableStream<Uint8Array>);
  const response = await fetch(url, { method: "PUT", body, headers: { "content-length": String(size) }, duplex: "half" } as RequestInit);
  await response.body?.cancel();
  if (!response.ok) throw new Error(`upload_failed: storage answered ${response.status}`);
  return size;
}

// ---- A project from a git link ----------------------------------------------------------------------------

const CLONE = /^clone_[a-f0-9]{40}$/;
const REF = /^(?!-)[A-Za-z0-9._/-]{1,200}$/;
type Cloned = { state: "running" | "done" | "failed"; root?: string; commit?: string; error?: string };
// The latest fetches by id, so a repeated clone answers its state; older ones are forgotten.
const KEEP_CLONES = 50;
const clones = new Map<string, Cloned>();

/**
 * A repository into the workspace (NoMac's hosted MCP: app_run from a git link): fetched shallow at a branch, tag
 * or commit into src/git_<hash of the remote>, so the same repository builds incrementally the next time (only
 * changed files are rewritten). A token for a private repository goes to git through its environment, never in an
 * argument another user could read, and is not kept. Answers within a few seconds, or that it runs.
 */
async function clone(params: Record<string, unknown>): Promise<Cloned> {
  const { id, url, ref, token } = params as { id: unknown; url: unknown; ref: unknown; token: unknown };
  if (typeof id !== "string" || !CLONE.test(id)) throw invalid("clone id");
  let job = clones.get(id);
  if (!job) {
    if (typeof url !== "string" || !gitUrl(url)) throw invalid("url: an https link to a git repository, without a user or password in it");
    if (ref !== undefined && (typeof ref !== "string" || !REF.test(ref))) throw invalid("ref: a branch, tag or commit");
    if (token !== undefined && (typeof token !== "string" || !/^[\x21-\x7e]{1,4096}$/.test(token))) throw invalid("token");
    srcRoot();
    const started: Cloned = { state: "running" };
    clones.set(id, started);
    while (clones.size > KEEP_CLONES) clones.delete(clones.keys().next().value!);
    fetchRepository(url, ref as string | undefined, token as string | undefined).then(
      (result) => Object.assign(started, { state: "done" }, result),
      (error: Error) => Object.assign(started, { state: "failed", error: error.message.slice(0, 300) }),
    );
    job = started;
  }
  const deadline = Date.now() + ANSWER_WITHIN_MS;
  while (job.state === "running" && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  return { ...job };
}

/** https only, with a host and a path, no user or password (a token goes in token), nothing a shell would read. */
export function gitUrl(url: string): boolean {
  if (url.length > 2048 || /\s/.test(url)) return false;
  try {
    const u = new URL(url);
    return u.protocol === "https:" && Boolean(u.hostname) && u.pathname.length > 1 && !u.username && !u.password && !u.search && !u.hash;
  } catch {
    return false;
  }
}

async function fetchRepository(url: string, ref: string | undefined, token: string | undefined): Promise<{ root: string; commit: string }> {
  const root = join(srcRoot(), `git_${createHash("sha256").update(normalizeRemote(url)).digest("hex").slice(0, 32)}`);
  const git = (args: string[], timeoutMs = 60_000) => gitRun(args, gitEnv(url, token), timeoutMs, token);
  if (!existsSync(join(root, ".git"))) {
    await mkdir(root, { recursive: true });
    await git(["init", "-q", root]);
    await git(["-C", root, "remote", "add", "origin", url]);
  } else {
    await git(["-C", root, "remote", "set-url", "origin", url]);
  }
  await git(["-C", root, "fetch", "--depth", "1", "--no-tags", "origin", ref ?? "HEAD"], 10 * 60_000);
  await git(["-C", root, "checkout", "--quiet", "--force", "--detach", "FETCH_HEAD"]);
  if (existsSync(join(root, ".gitmodules"))) await git(["-C", root, "submodule", "update", "--init", "--recursive", "--depth", "1"], 10 * 60_000);
  const commit = (await git(["-C", root, "rev-parse", "--short=12", "HEAD"])).trim();
  return { root, commit };
}

/** git never asks, and a token goes as an HTTP header set from the environment (GIT_CONFIG_*), for this host only. */
export function gitEnv(url: string, token: string | undefined): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "/usr/bin/false" };
  if (token) {
    const { hostname } = new URL(url);
    const user = hostname === "gitlab.com" ? "oauth2" : hostname === "bitbucket.org" ? "x-token-auth" : "x-access-token";
    Object.assign(env, { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: `http.https://${hostname}/.extraHeader`, GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`${user}:${token}`).toString("base64")}` });
  }
  return env;
}

function gitRun(args: string[], env: NodeJS.ProcessEnv, timeoutMs: number, token: string | undefined): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { env, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, encoding: "utf8" }, (error, stdout, stderr) => {
      if (!error) return resolve(stdout);
      // git's own words, without the token if it ever printed it.
      const said = (stderr || error.message).trim().split(token || "\0").join("***");
      reject(new Error(`git ${args.find((a) => !a.startsWith("-") && a !== "-C" && !a.startsWith("/")) ?? ""}: ${error.killed ? "timed out" : said.split("\n").slice(-3).join(" ")}`));
    });
  });
}

// ---- A project or an app from an upload ---------------------------------------------------------------------

const FETCH = /^fetch_[a-f0-9]{40}$/;
const UPLOAD_NAME = /^[A-Za-z0-9._-]{1,80}$/;
type Fetched = { state: "running" | "done" | "failed"; root?: string; app?: string; written?: number; removed?: number; error?: string };
// The latest fetches by id, so a repeated fetch answers its state; older ones are forgotten.
const KEEP_FETCHES = 50;
const fetches = new Map<string, Fetched>();

/**
 * An archive uploaded to NoMac (a project without a git remote, or a .app built elsewhere), into the workspace at
 * src/upload_<hash of its name>: downloaded from the link NoMac signed, its checksum checked, unpacked aside and
 * copied in where it differs, so an unchanged file keeps its mtime and the next build stays incremental. A .tar.gz
 * or a .zip. Answers within a few seconds, or that it runs.
 */
async function fetchUpload(params: Record<string, unknown>): Promise<Fetched> {
  const { id, url, sha256, name } = params as { id: unknown; url: unknown; sha256: unknown; name: unknown };
  if (typeof id !== "string" || !FETCH.test(id)) throw invalid("fetch id");
  let job = fetches.get(id);
  if (!job) {
    if (typeof url !== "string" || !url.startsWith("https://")) throw invalid("url");
    if (typeof sha256 !== "string" || !/^[a-f0-9]{64}$/.test(sha256)) throw invalid("sha256");
    if (name !== undefined && (typeof name !== "string" || !UPLOAD_NAME.test(name))) throw invalid("name: letters, digits, dot, dash and underscore");
    srcRoot();
    const started: Fetched = { state: "running" };
    fetches.set(id, started);
    while (fetches.size > KEEP_FETCHES) fetches.delete(fetches.keys().next().value!);
    unpackUpload(url, sha256, (name as string | undefined) ?? "upload").then(
      (result) => Object.assign(started, { state: "done" }, result),
      (error: Error) => Object.assign(started, { state: "failed", error: error.message.slice(0, 300) }),
    );
    job = started;
  }
  const deadline = Date.now() + ANSWER_WITHIN_MS;
  while (job.state === "running" && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  return { ...job };
}

async function unpackUpload(url: string, sha256: string, name: string): Promise<{ root: string; app?: string; written: number; removed: number }> {
  const root = join(srcRoot(), `upload_${createHash("sha256").update(name).digest("hex").slice(0, 32)}`);
  // Beside the workspace's projects, on the same volume, so a changed file is moved in, not copied.
  await mkdir(srcRoot(), { recursive: true });
  const work = await mkdtemp(join(srcRoot(), ".nomac-upload-"));
  try {
    const file = join(work, "archive");
    const response = await fetch(url);
    if (!response.ok || !response.body) throw new Error(`upload_download_failed: ${response.status}`);
    await pipeline(Readable.fromWeb(response.body as never), createWriteStream(file));
    const hash = createHash("sha256");
    await pipeline(createReadStream(file), hash);
    if (hash.digest("hex") !== sha256) throw new Error("upload_checksum_mismatch: the file is not the one its sha256 names");
    const out = join(work, "out");
    await mkdir(out);
    const head = (await readFile(file)).subarray(0, 4);
    if (head[0] === 0x50 && head[1] === 0x4b) await run("/usr/bin/ditto", ["-x", "-k", file, out], { timeoutMs: 10 * 60_000 });
    // bsdtar keeps every entry inside out: it strips a leading / and refuses .. without -P.
    else if (head[0] === 0x1f && head[1] === 0x8b) await run("/usr/bin/tar", ["-xzf", file, "-C", out], { timeoutMs: 10 * 60_000 });
    else throw new Error("upload_unreadable: send a .tar.gz or a .zip");
    await mkdir(root, { recursive: true });
    const { written, removed } = await mirror(out, root);
    const app = await appIn(root);
    return { root, ...(app ? { app } : {}), written, removed };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

/**
 * Makes to hold what from holds: a file whose content differs is moved in, the rest keep theirs and their mtimes;
 * what to has beyond from goes, but build output and dependencies stay (they were made here).
 */
async function mirror(from: string, to: string): Promise<{ written: number; removed: number }> {
  const files = new Set<string>();
  let written = 0;
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      const rel = path.slice(from.length + 1);
      if (entry.isDirectory()) {
        await walk(path);
        continue;
      }
      files.add(rel);
      const target = join(to, rel);
      if (await sameContent(path, target, entry.isSymbolicLink())) continue;
      await mkdir(dirname(target), { recursive: true });
      await rm(target, { recursive: true, force: true });
      await rename(path, target);
      written++;
    }
  };
  await walk(from);
  let removed = 0;
  const prune = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) await prune(path);
        continue;
      }
      if (!files.has(path.slice(to.length + 1))) {
        await unlink(path);
        removed++;
      }
    }
  };
  await prune(to);
  return { written, removed };
}

async function sameContent(a: string, b: string, link: boolean): Promise<boolean> {
  try {
    const [sa, sb] = await Promise.all([lstat(a), lstat(b)]);
    if (link || sa.isSymbolicLink() || sb.isSymbolicLink()) return sa.isSymbolicLink() && sb.isSymbolicLink() && (await readlink(a)) === (await readlink(b));
    if (sa.size !== sb.size || (sa.mode & 0o111) !== (sb.mode & 0o111)) return false;
    const [ha, hb] = await Promise.all([a, b].map(async (p) => createHash("sha256").update(await readFile(p)).digest("hex")));
    return ha === hb;
  } catch {
    return false;
  }
}

/** The .app at the upload's top, or in its one top folder: what app_control install takes. */
async function appIn(root: string): Promise<string | undefined> {
  const top = await readdir(root, { withFileTypes: true });
  const app = top.find((e) => e.isDirectory() && e.name.endsWith(".app"));
  if (app) return join(root, app.name);
  const folders = top.filter((e) => e.isDirectory() && !e.name.startsWith("."));
  if (folders.length !== 1) return undefined;
  const inner = (await readdir(join(root, folders[0]!.name), { withFileTypes: true })).find((e) => e.isDirectory() && e.name.endsWith(".app"));
  return inner ? join(root, folders[0]!.name, inner.name) : undefined;
}

// ---- The replay -------------------------------------------------------------------------------------------

/** One tool call of the session, as the replay lists it: never what was typed. */
type Logged = { at_ms: number; tool: string; what: string; ms: number; ok: boolean; said: string };
// The replay's own recorder, the file it records and the calls so far.
let replay: { recorder: ChildProcess; file: string; started: number; log: Logged[] } | undefined;
const REPLAY_CALLS = 2000;

/**
 * What a call did, for the replay: the tool and its main argument, with typed text masked (fill #password …).
 */
export function callSummary(tool: string, args: Record<string, unknown>): string {
  if (tool === "ui_act" && Array.isArray(args.steps)) return args.steps.map((step) => String(step).replace(/^((?:fill|type)\b(?:\s+(?:#\S+|"[^"]*"|\S+))?)\s.*$/i, (_m, head: string) => (/^type/i.test(head) ? "type …" : `${head} …`))).join(" · ").slice(0, 200);
  if (tool === "app_control") return [args.action, args.action === "open_url" ? "(a link)" : args.app].filter(Boolean).join(" ").slice(0, 120);
  if (tool === "app_run" || tool === "tests_run") return tool;
  return Object.keys(args).length ? `${tool} ${Object.keys(args).join(", ")}` : tool;
}

/** Notes a call for the replay, while one records. */
export function noteCall(tool: string, args: Record<string, unknown>, started: number, result: { content: unknown[]; isError?: boolean }) {
  if (!replay || replay.log.length >= REPLAY_CALLS) return;
  const text = result.content.map((c) => (c && typeof c === "object" && (c as { type?: unknown }).type === "text" ? String((c as { text?: unknown }).text ?? "") : "")).join("\n");
  // ui_act's answer can repeat what was typed ("fill #password \"…\" failed"): its quoted parts never reach the list.
  const first = hostedText(text.split("\n")[0] ?? "");
  const said = tool === "ui_act" ? first.replace(/"[^"]*"|“[^”]*”/g, "…") : first;
  replay.log.push({ at_ms: started - replay.started, tool, what: callSummary(tool, args), ms: Date.now() - started, ok: !result.isError, said: said.slice(0, 200) });
}

// simctl's recorder, as screen_record's but its own process: the agent's recordings go on beside it, and the video
// keeps the wall clock, so the list's times are its times. Tests replace it.
let recordScreen = async (file: string): Promise<ChildProcess> => {
  const device = pickDevice(await listDevices(true), undefined, await heldDevice());
  return spawn("xcrun", ["simctl", "io", device.udid, "recordVideo", "--codec=h264", "--force", file], { stdio: "ignore" });
};
export function setReplayRecorder(record: (file: string) => Promise<ChildProcess>) {
  recordScreen = record;
}

/** Where stop leaves the replay (video.mp4 and log.json) for NoMac to take once the session has ended. */
export const replayDir = () => join(stateDir(), "replay");

/**
 * The session's replay (NoMac Simulator, plan 10.7 C3): start records the phone's screen and lists every tool
 * call; stop ends both and leaves the video and the list in replayDir(). NoMac uploads them after the session's
 * end, so the upload is never the customer's time.
 */
async function replayOp(params: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (params.op === "start") {
    if (replay) return { recording: true };
    const file = join(stateDir(), `replay-${Date.now()}.mp4`);
    replay = { recorder: await recordScreen(file), file, started: Date.now(), log: [] };
    return { recording: true };
  }
  if (params.op !== "stop") throw invalid("op is start or stop");
  const ending = replay;
  replay = undefined;
  if (!ending) return { recording: false };
  // SIGINT makes simctl write the video's index and close it; a recorder that hangs is killed after 8 s.
  await new Promise<void>((resolve) => {
    if (ending.recorder.exitCode !== null) return resolve();
    const timer = setTimeout(() => { ending.recorder.kill("SIGKILL"); resolve(); }, 8_000);
    ending.recorder.once("exit", () => { clearTimeout(timer); resolve(); });
    ending.recorder.kill("SIGINT");
  });
  const seconds = Math.round((Date.now() - ending.started) / 1000);
  const dir = replayDir();
  await mkdir(dir, { recursive: true });
  const video = existsSync(ending.file);
  if (video) await rename(ending.file, join(dir, "video.mp4"));
  await writeFile(join(dir, "log.json"), JSON.stringify({ started_at: new Date(ending.started).toISOString(), seconds, video, calls: ending.log }));
  return { recording: false, calls: ending.log.length, seconds, video };
}

// ---- The pool's first read ----------------------------------------------------------------------------------

type Read = (timeoutMs: number) => Promise<Record<string, unknown> & { ok?: boolean; error?: string } | undefined>;
/** Tests replace the phone's engine read. */
let readForTests: Read | undefined;
export function setFirstRead(read: Read | undefined) {
  readForTests = read;
}

/**
 * The pool's first read of a phone just booted: the engine only, again until it reads, never AXe (whose own
 * automation session beside a young engine's wedges the phone). Right after a boot the engine's first read fails
 * after about 20 s and the next one works (research, section 13), so the pool reads at once instead of waiting 30 s.
 */
async function readable(params: Record<string, unknown>): Promise<Record<string, unknown>> {
  const within = Math.min(Math.max(Number(params.within_ms) || 120_000, 1_000), 300_000);
  const started = Date.now();
  let read = readForTests;
  if (!read) {
    const device = pickDevice(await listDevices(true), undefined, await heldDevice());
    read = (timeoutMs) => engineCall(device.udid, { op: "describe" }, timeoutMs);
  }
  let tries = 0, error = "";
  while (Date.now() - started < within) {
    tries++;
    const answer = await read(Math.max(1_000, within - (Date.now() - started)));
    if (answer?.ok) return { readable: true, ms: Date.now() - started, tries };
    error = answer?.error ?? "no engine";
    // No engine yet (it would not start): it is tried again after a while; a read that failed, at once.
    await new Promise((resolve) => setTimeout(resolve, answer ? 300 : 2_000));
  }
  return { readable: false, ms: Date.now() - started, tries, error: error.slice(0, 200) };
}

// ---- Saved phone states ------------------------------------------------------------------------------------

const STATE_ID = /^state_[a-f0-9]{40}$/;
const STATE_NAME = /^[A-Za-z0-9._-]{1,64}$/;
const KEEP_STATE_JOBS = 20;
/** What iOS rebuilds by itself: left out of a saved state. */
const REBUILT = ["Library/Caches", "Library/Logs", "tmp"];
/**
 * The system's own assets (Siri voices, ML models: 1.8 GB of a 3.7 GB phone), the same on every phone of a model and
 * iOS: left out of a saved state, and a restore keeps the phone's own.
 */
const SYSTEM_ASSETS = "private/var/MobileAsset";

/**
 * Copies from into to with ditto (which keeps what iOS's files carry: extended attributes, permissions), leaving out
 * the paths in skip (relative to from) without copying them first.
 */
export async function copyExcept(from: string, to: string, skip: string[]): Promise<void> {
  await mkdir(to, { recursive: true });
  for (const name of await readdir(from)) {
    if (skip.includes(name)) continue;
    const inside = skip.filter((p) => p.startsWith(`${name}/`)).map((p) => p.slice(name.length + 1));
    if (inside.length) await copyExcept(join(from, name), join(to, name), inside);
    else await run("/usr/bin/ditto", [join(from, name), join(to, name)], { timeoutMs: 10 * 60_000 });
  }
}

/**
 * LaunchServices' databases name each app by its absolute path on the phone it was installed on: another pool user's
 * phone, for a state saved there, so the app would not launch. A restore removes them (the .csstore files only) and
 * iOS rebuilds them at boot from the apps installed.
 */
export async function forgetAppPaths(data: string): Promise<void> {
  const dir = join(data, "var", "db", "lsd");
  for (const name of await readdir(dir).catch(() => [] as string[])) if (name.endsWith(".csstore")) await rm(join(dir, name), { force: true });
}

/** Removes everything under root except keep (a path inside it) and the folders that lead to it. */
export async function removeExcept(root: string, keep: string): Promise<void> {
  const [first, ...rest] = keep.split("/");
  for (const name of await readdir(root).catch(() => [] as string[])) {
    if (name !== first) await rm(join(root, name), { recursive: true, force: true });
    else if (rest.length) await removeExcept(join(root, name), rest.join("/"));
  }
}
type SavedState = { name: string; bytes: number; saved_at: string; device: string; runtime: string };
type StateJob = { state: "running" | "done" | "failed"; error?: string; bytes?: number; ms?: number; states?: SavedState[]; device?: string; saved_at?: string; uploaded?: boolean; fetched?: boolean };
/** A state's way to and from NoMac's storage (October 25, 2026): a link NoMac signed, and the state's own key. */
type StateTransfer = { url: string; key: string };
const stateJobs = new Map<string, StateJob>();
const statesDir = () => {
  if (!workspace) throw Object.assign(new Error("no_workspace"), { code: -32000 });
  return join(workspace, "phone-states");
};

/** Where a phone keeps its apps, their data, its keychain and permissions. */
async function dataPathOf(udid: string): Promise<string> {
  const { stdout } = await run("xcrun", ["simctl", "list", "-j", "devices"], { timeoutMs: 30_000 });
  const devices = Object.values((JSON.parse(stdout) as { devices: Record<string, Array<{ udid: string; dataPath?: string }>> }).devices).flat();
  const path = devices.find((d) => d.udid === udid)?.dataPath;
  if (!path || !absolute(path)) throw new Error("the phone's data folder was not found");
  return path;
}

/** The phone off, and its engine with it: a saved state is copied from (or to) a phone at rest. */
async function shutDown(udid: string) {
  closeEngines(udid);
  await run("xcrun", ["simctl", "shutdown", udid], { timeoutMs: 60_000 }).catch((error: Error) => {
    if (!/current state: Shutdown|Unable to shutdown device in current state/i.test(error.message)) throw error;
  });
}

/** The phone booted again and readable by the engine (its first read after a boot fails for a while). */
async function bootAgain(udid: string) {
  await run("xcrun", ["simctl", "boot", udid], { timeoutMs: 60_000 }).catch((error: Error) => {
    if (!/current state: Booted/i.test(error.message)) throw error;
  });
  await run("xcrun", ["simctl", "bootstatus", udid, "-b"], { timeoutMs: 180_000 });
  await readable({ within_ms: 120_000 });
}

const listStates = async (): Promise<SavedState[]> => {
  const names = (await readdir(statesDir()).catch(() => [] as string[])).filter((n) => STATE_NAME.test(n) && !n.endsWith(".saving"));
  const states: SavedState[] = [];
  for (const name of names) {
    try {
      states.push(JSON.parse(await readFile(join(statesDir(), name, "state.json"), "utf8")) as SavedState);
    } catch {
      // A state being written, or not one of ours.
    }
  }
  return states.sort((a, b) => b.saved_at.localeCompare(a.saved_at));
};

async function saveState(name: string, upload?: StateTransfer): Promise<StateJob> {
  const device = pickDevice(await listDevices(true), undefined, await heldDevice());
  const data = await dataPathOf(device.udid);
  const dir = join(statesDir(), name), saving = `${dir}.saving`;
  await shutDown(device.udid);
  let uploading: Promise<number> | undefined, result: StateJob;
  try {
    await rm(saving, { recursive: true, force: true });
    await mkdir(saving, { recursive: true });
    await copyExcept(data, join(saving, "data"), [...REBUILT, SYSTEM_ASSETS]);
    const bytes = Number((await run("/usr/bin/du", ["-sk", saving], { timeoutMs: 60_000 })).stdout.split(/\s/)[0]) * 1024;
    const meta: SavedState = { name, bytes, saved_at: new Date().toISOString(), device: device.name, runtime: device.runtime };
    await writeFile(join(saving, "state.json"), JSON.stringify(meta));
    await rm(dir, { recursive: true, force: true });
    await rename(saving, dir);
    // Kept in NoMac's storage too, so it restores on any phone: it uploads while the phone boots again.
    uploading = upload ? uploadState(statesDir(), name, upload.url, upload.key, tmpdir()) : undefined;
    uploading?.catch(() => {});
    result = { state: "done", bytes, device: `${device.name} (${device.runtime})`, saved_at: meta.saved_at };
  } finally {
    await rm(saving, { recursive: true, force: true });
    await bootAgain(device.udid);
  }
  if (uploading) {
    await uploading.catch((error: Error) => { throw new Error(`saved on this phone, but not kept for other phones: ${error.message}`); });
    result.uploaded = true;
  }
  return result;
}

async function restoreState(name: string, fetch?: StateTransfer & { savedAt: string }): Promise<StateJob> {
  const dir = join(statesDir(), name);
  const local = async () => JSON.parse(await readFile(join(dir, "state.json"), "utf8")) as SavedState;
  let meta = await local().catch(() => undefined);
  // A copy here is the state only if it is the same save; otherwise the account's copy in NoMac's storage comes down.
  let fetched = false;
  if (fetch && meta?.saved_at !== fetch.savedAt) {
    await fetchState(statesDir(), name, fetch.url, fetch.key);
    meta = await local();
    if (meta.saved_at !== fetch.savedAt) throw new Error(`the stored ${name} is not the save asked for`);
    fetched = true;
  }
  if (!meta) throw new Error(`no saved state named ${name}`);
  const device = pickDevice(await listDevices(true), undefined, await heldDevice());
  // A state goes back onto the phone it came from: the same model and iOS.
  if (meta.device !== device.name || meta.runtime !== device.runtime) throw new Error(`${name} was saved on ${meta.device} (${meta.runtime}); this phone is ${device.name} (${device.runtime})`);
  const data = await dataPathOf(device.udid);
  await shutDown(device.udid);
  try {
    await removeExcept(data, SYSTEM_ASSETS);
    await run("/usr/bin/ditto", [join(dir, "data"), data], { timeoutMs: 10 * 60_000 });
    await forgetAppPaths(data);
    return { state: "done", bytes: meta.bytes, device: `${device.name} (${device.runtime})`, ...(fetch ? { fetched } : {}) };
  } finally {
    await bootAgain(device.udid);
  }
}

/**
 * The phone's state by name, in the account's workspace (NoMac Simulator plan 10.7 E4): save copies the phone's apps,
 * their data, its keychain and permissions (the phone restarts); restore puts a saved state back onto a phone of the
 * same model and iOS; list and delete manage them. save and restore answer within a while, or that they run; the same
 * id reads their state.
 */
async function phoneState(params: Record<string, unknown>): Promise<StateJob> {
  const { id, action, name, url, data_key: key, saved_at: savedAt } = params as { id: unknown; action: unknown; name: unknown; url: unknown; data_key: unknown; saved_at: unknown };
  // A save given a link and a key keeps the state in NoMac's storage too; a restore given them fetches it when this
  // workspace has no copy of that save (saved_at).
  const transfer = url === undefined && key === undefined ? undefined : typeof url === "string" && url.startsWith("https://") && typeof key === "string" && /^[A-Za-z0-9_-]{43}$/.test(key) ? { url, key } : null;
  if (transfer === null) throw invalid("a state's url (https) and data_key");
  if (transfer && action === "restore" && (typeof savedAt !== "string" || savedAt.length > 64)) throw invalid("a restore's saved_at");
  if (typeof id !== "string" || !STATE_ID.test(id)) throw invalid("state id");
  if (action === "list") return { state: "done", states: await listStates() };
  if (typeof name !== "string" || !STATE_NAME.test(name)) throw invalid("name: letters, digits, dots, dashes and underscores, up to 64");
  if (action === "delete") {
    await rm(join(statesDir(), name), { recursive: true, force: true });
    return { state: "done", states: await listStates() };
  }
  if (action !== "save" && action !== "restore") throw invalid("action is save, restore, list or delete");
  let job = stateJobs.get(id);
  if (!job) {
    statesDir();
    const started: StateJob = { state: "running" };
    stateJobs.set(id, started);
    while (stateJobs.size > KEEP_STATE_JOBS) stateJobs.delete(stateJobs.keys().next().value!);
    const began = Date.now();
    (action === "save" ? saveState(name, transfer) : restoreState(name, transfer ? { ...transfer, savedAt: savedAt as string } : undefined)).then(
      // The whole of it: the copy and the phone booted and readable again.
      (result) => Object.assign(started, result, { ms: Date.now() - began }),
      (error: Error) => Object.assign(started, { state: "failed", error: error.message.slice(0, 300) }),
    );
    job = started;
  }
  const deadline = Date.now() + ANSWER_WITHIN_MS;
  while (job.state === "running" && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  return { ...job };
}

// ---- The pool's warm-up -----------------------------------------------------------------------------------

const WARM_BUNDLE = "app.nomac.prewarm";
const WARM_FILES: Record<string, string> = {
  "project.yml": [
    "name: Warm",
    "options:",
    "  deploymentTarget:",
    '    iOS: "18.0"',
    "targets:",
    "  Warm:",
    "    type: application",
    "    platform: iOS",
    "    sources: [Sources]",
    "    settings:",
    "      base:",
    `        PRODUCT_BUNDLE_IDENTIFIER: ${WARM_BUNDLE}`,
    "        GENERATE_INFOPLIST_FILE: YES",
    "        INFOPLIST_KEY_UILaunchScreen_Generation: YES",
    "        CODE_SIGNING_ALLOWED: NO",
    '        SWIFT_VERSION: "6.0"',
    "",
  ].join("\n"),
  "Sources/App.swift": ['import SwiftUI', "", "@main", "struct WarmApp: App {", '  var body: some Scene { WindowGroup { Text("Ready") } }', "}", ""].join("\n"),
};
let warming: Promise<{ ok: boolean; ms: number; error?: string }> | undefined;

/**
 * Before NoMac hands this phone out (plan section 8b, item 22): a one-screen app built for the phone, installed,
 * launched and removed through app_run, as a customer's would be, so the customer's first build and install do
 * not pay for Xcode and the phone's installer starting in a wiped home (measured on the M6: the first build 13 s
 * instead of 22, the first install 1.4 s instead of 5). Nothing of it stays: the app is removed, its folder
 * deleted. { stop: true } ends a warm-up that runs (a customer now waits on this phone).
 */
async function warm(params: Record<string, unknown>): Promise<{ ok: boolean; ms: number; error?: string; stopped?: boolean }> {
  if (params.stop === true) {
    if (!warming) return { ok: true, ms: 0, stopped: false };
    cancelAllJobs();
    return { ...(await warming), stopped: true };
  }
  if (workspace) throw invalid("the warm-up runs before the hand-over");
  warming ??= (async () => {
    const started = Date.now();
    const dir = await mkdtemp(join(tmpdir(), "simulator-use-warm-"));
    try {
      for (const [name, text] of Object.entries(WARM_FILES)) {
        await mkdir(dirname(join(dir, name)), { recursive: true });
        await writeFile(join(dir, name), text);
      }
      const ran = await callTool("app_run", { path: dir }, { waitForJobs: true });
      const removed = await callTool("app_control", { action: "uninstall", app: WARM_BUNDLE });
      const failed = ran.isError ? ran : removed.isError && !/not installed|No app/i.test(removed.text) ? removed : undefined;
      return failed ? { ok: false, ms: Date.now() - started, error: failed.text.slice(0, 300) } : { ok: true, ms: Date.now() - started };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  })().finally(() => (warming = undefined));
  return warming;
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export async function hosted(method: string, params: Record<string, unknown>): Promise<unknown> {
  switch (method) {
    case "simulator-use/configure":
      return configure(params);
    case "simulator-use/get":
      return get(params);
    case "simulator-use/warm":
      return warm(params);
    case "simulator-use/readable":
      return readable(params);
    case "simulator-use/state":
      return phoneState(params);
    case "simulator-use/clone":
      return clone(params);
    case "simulator-use/fetch":
      return fetchUpload(params);
    case "simulator-use/replay":
      return replayOp(params);
    case "simulator-use/sync":
      if (params.op === "manifest") return manifest(params);
      if (params.op === "place") return place(params);
      throw invalid("op is manifest or place");
  }
  throw Object.assign(new Error(`Method not found: ${method}`), { code: -32601 });
}
