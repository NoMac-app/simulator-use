import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream, existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve } from "node:path";

import { ToolError } from "../errors.ts";
import { run } from "./exec.ts";
import { stateDir } from "./state.ts";
import type { Xcode } from "./xcodes.ts";
import { setting } from "../settings.ts";

export type Project = { kind: "workspace" | "project"; path: string; name: string; dir: string; generated?: boolean; note?: string };

/**
 * The Xcode project in a folder: a workspace first (CocoaPods and multi-project setups need it), then a
 * project; an XcodeGen spec is generated first, and again before every build. Other kinds say what is coming.
 */
export async function findProject(where: string): Promise<Project> {
  const path = resolve(where);
  if (!existsSync(path)) throw new ToolError(`${path} does not exist.`, "Pass path: the folder with the Xcode project.");
  const ext = extname(path);
  if (ext === ".xcworkspace") return { kind: "workspace", path, name: basename(path, ext), dir: dirname(path) };
  if (ext === ".xcodeproj") {
    const dir = dirname(path);
    const note = existsSync(join(dir, "project.yml")) ? await xcodegen(dir, true) : undefined;
    return { kind: "project", path, name: basename(path, ext), dir, note };
  }
  const entries = readdirSync(path);
  // A workspace is left as it is: regenerating its project would undo what CocoaPods added to it.
  const workspace = entries.find((e) => e.endsWith(".xcworkspace"));
  if (workspace) return { kind: "workspace", path: join(path, workspace), name: basename(workspace, ".xcworkspace"), dir: path };
  const project = entries.find((e) => e.endsWith(".xcodeproj"));
  if (entries.includes("project.yml")) {
    const note = await xcodegen(path, Boolean(project));
    const made = readdirSync(path).find((e) => e.endsWith(".xcodeproj"));
    if (made) return { kind: "project", path: join(path, made), name: basename(made, ".xcodeproj"), dir: path, generated: !project, note };
  }
  if (project) return { kind: "project", path: join(path, project), name: basename(project, ".xcodeproj"), dir: path };
  const ios = join(path, "ios");
  const hasIos = entries.includes("ios") && existsSync(ios);
  if (entries.includes("pubspec.yaml")) {
    throw new ToolError("A Flutter project: Flutter builds it, not app_run.", "Run flutter build ios --simulator, then app_control {action: \"install\", app: \"build/ios/iphonesimulator/Runner.app\"}.");
  }
  if (entries.some((e) => e.startsWith("capacitor.config"))) {
    throw new ToolError("A Capacitor project: its web build is copied into the iOS project first.", `Run npx cap sync ios, then app_run {path: "${join(path, "ios", "App")}"}.`);
  }
  if (entries.includes("app.json")) {
    const expo = isExpo(join(path, "app.json"));
    if (!hasIos) {
      throw new ToolError(expo ? "An Expo project with no ios/ folder yet." : "A React Native project with no ios/ folder.",
        expo ? "Run npx expo prebuild --platform ios to make one, then app_run again; or open the project in Expo Go." : "app_run builds the Xcode project in ios/.");
    }
    if (!readdirSync(ios).some((e) => e.endsWith(".xcworkspace")) && existsSync(join(ios, "Podfile"))) {
      throw new ToolError("ios/ has a Podfile but no workspace yet.", `Run pod install in ${ios}, then app_run again.`);
    }
    const found = await findProject(ios);
    // A Debug build loads its JavaScript from Metro; Release puts it in the app.
    return { ...found, note: [found.note, "A React Native app: a Debug build loads its JavaScript from Metro (start it first: npx react-native start, or npx expo start), and configuration Release puts it in the app."].filter(Boolean).join(" ") };
  }
  if (hasIos) return findProject(ios);
  throw new ToolError(`No Xcode project in ${path}.`, "Pass path: the folder with the .xcodeproj or .xcworkspace.");
}

/** An app.json with an "expo" key is Expo's; a React Native CLI project's has only its name. */
function isExpo(file: string): boolean {
  try {
    return "expo" in (JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>);
  } catch {
    return false;
  }
}

/**
 * XcodeGen makes the project from project.yml, and a spec edit or a new, moved or deleted source file needs a new
 * project, or the build misses it. So the project is regenerated before every build; --use-cache skips the work when
 * neither the spec nor the files changed. Answers a note when an existing project had to be built as it was.
 */
async function xcodegen(dir: string, hasProject: boolean): Promise<string | undefined> {
  try {
    await run("xcodegen", ["generate", "--quiet", "--use-cache", "--spec", join(dir, "project.yml")], { timeoutMs: 60_000 });
    return undefined;
  } catch (error) {
    const why = ((error as Error).message.split("\n")[0] ?? "").slice(0, 200);
    if (!hasProject) throw new ToolError(`This folder has an XcodeGen spec (project.yml) but no project, and xcodegen failed: ${why}`, "Install XcodeGen (brew install xcodegen), or generate the project yourself.");
    return `XcodeGen could not regenerate the project from project.yml (${why}), so the existing project was built; spec edits and new files are not in it.`;
  }
}

/** The scheme to build: the one asked for, the only one, or the one named like the project. */
export async function pickScheme(project: Project, wanted?: string): Promise<string> {
  const { stdout } = await run("xcodebuild", ["-list", "-json", project.kind === "workspace" ? "-workspace" : "-project", project.path], { timeoutMs: 60_000 });
  const list = JSON.parse(stdout) as { project?: { schemes?: string[] }; workspace?: { schemes?: string[] } };
  const schemes = list.workspace?.schemes ?? list.project?.schemes ?? [];
  if (wanted) {
    if (!schemes.includes(wanted)) throw new ToolError(`No scheme "${wanted}" in ${basename(project.path)}. Schemes: ${schemes.join(", ") || "none"}.`);
    return wanted;
  }
  const own = schemes.filter((s) => !/^Pods-|Tests$|UITests$/.test(s));
  if (own.length === 1) return own[0]!;
  const named = own.find((s) => s === project.name);
  if (named) return named;
  if (!schemes.length) throw new ToolError(`${basename(project.path)} has no shared schemes.`, "Open it in Xcode once, or share a scheme (Product > Scheme > Manage Schemes).");
  throw new ToolError(`${basename(project.path)} has several schemes: ${own.join(", ")}.`, "Pass scheme.");
}

export type Issue = { file?: string; line?: number; column?: number; severity: "error" | "warning"; message: string };

/**
 * A failed build whose cause has a known fix, said with the fix: the errors alone read like a code problem. A
 * project that keeps its xcconfig out of git as a template (IceCubesApp does) fails at once from a fresh clone; a
 * full disk fails deep in the linker (errno 28); packages Xcode could not fetch fail before any compile.
 */
export function knownFix(errors: Issue[], tail: string[]): string | undefined {
  const text = [...errors.map((e) => e.message), ...tail].join("\n");
  const xcconfig = /Unable to open base configuration reference file '([^']+\.xcconfig)'/.exec(text)?.[1];
  if (xcconfig) {
    const name = basename(xcconfig);
    return existsSync(`${xcconfig}.template`)
      ? `the project keeps ${name} as a template: copy ${name}.template to ${name} (fill in its values if it has any), then build again.`
      : `the project expects ${name}, which is not in its folder (often kept out of git): create it, then build again.`;
  }
  if (/No space left on device|errno=28/.test(text)) return "the disk is full: free space, or build with clean: true to clear this project's build cache.";
  if (/Could not resolve package dependencies|Failed to clone repository|package resolution failed/i.test(text)) {
    return "Xcode could not fetch the project's Swift packages: check the network, and that a private package's repository can be reached from this Mac.";
  }
  return undefined;
}

const LOCATED = /^(\/[^:]+):(\d+):(?:(\d+):)? (error|warning|fatal error): (.+)$/;
const BARE = /^(?:xcodebuild: |clang: |ld: |\s*)?(error|fatal error): (.+)$/;

/** One line of xcodebuild output as an error or warning, or nothing. */
export function parseIssue(line: string): Issue | undefined {
  const located = LOCATED.exec(line);
  if (located) {
    const [, file, row, col, severity, message] = located;
    return { file, line: Number(row), column: col ? Number(col) : undefined, severity: severity === "warning" ? "warning" : "error", message: message!.trim() };
  }
  const bare = BARE.exec(line);
  if (bare) return { severity: "error", message: bare[2]!.trim() };
  if (/^ld: /.test(line) || /^Undefined symbols? for architecture/.test(line)) return { severity: "error", message: line.trim() };
  return undefined;
}

/** `Sources/App.swift:49:37`, relative to the project when the file is inside it, else absolute. */
export function place(file: string, line: number | undefined, column: number | undefined, base: string): string {
  const real = (p: string) => {
    try {
      return realpathSync(p);
    } catch {
      return p;
    }
  };
  // /tmp and /private/tmp are the same folder; compare real paths so the file reads relative.
  const rel = relative(real(base), real(file));
  return `${rel && !rel.startsWith("..") ? rel : file}:${line ?? "?"}${column ? `:${column}` : ""}`;
}

/** `Sources/App.swift:49:37: error: ...`. */
export function formatIssue(issue: Issue, base: string): string {
  return `${issue.file ? `${place(issue.file, issue.line, issue.column, base)}: ` : ""}${issue.severity}: ${issue.message}`;
}

/**
 * Where builds keep their products: SIMULATOR_USE_CACHE_DIR when set (a disk kept between machines, such as
 * NoMac's ~/drive, makes the next machine's build incremental), else simulator-use's own folder.
 */
export const cacheDir = () => setting("CACHE_DIR") || stateDir();

/**
 * Each worktree builds into its own DerivedData, so builds stay incremental and never share products; an Xcode other
 * than the default has its own beside it, since two Xcodes' products and module caches do not mix.
 */
export function derivedDataFor(project: Project, xcode?: Xcode): string {
  const key = createHash("sha1").update(project.path).digest("hex").slice(0, 12);
  return join(cacheDir(), "DerivedData", `${project.name}-${key}${xcode && !xcode.default ? `-xcode${xcode.version}${xcode.beta ? "b" : ""}` : ""}`);
}

/** The environment a build with this Xcode runs in: its DEVELOPER_DIR, unless it is the default. */
export const xcodeEnv = (xcode?: Xcode): NodeJS.ProcessEnv => (xcode && !xcode.default ? { ...process.env, DEVELOPER_DIR: xcode.developer } : process.env);

/** An Xcode older than the phone's iOS cannot name the phone as a destination: it builds for any Simulator instead. */
export const noDestination = (result: { tail: string[] }) => result.tail.some((line) => /Unable to find a destination matching/i.test(line));

export type BuildResult = { ok: boolean; errors: Issue[]; warnings: number; log: string; ms: number; tail: string[] };

/**
 * xcodebuild, or xcodebuild under taskpolicy's clamp when SIMULATOR_USE_BUILD_CLAMP is utility or background:
 * on a shared host the phones stay quick while builds run (NoMac Simulator), and what a build starts inherits
 * the clamp and cannot lift it.
 */
export function buildCommand(args: string[]): [string, string[]] {
  const clamp = setting("BUILD_CLAMP");
  if (clamp === "utility" || clamp === "background") return ["/usr/sbin/taskpolicy", ["-c", clamp, "xcodebuild", ...args]];
  return ["xcodebuild", args];
}

/**
 * Leaves the newest keep entries of a folder whose names match (each named with its time), deleting the older:
 * every build adds a log and every test run a result bundle, and a host's workspace must not fill with them.
 */
export async function keepNewest(dir: string, pattern: RegExp, keep: number): Promise<void> {
  const time = (name: string) => Number(/(\d+)\.\w+$/.exec(name)?.[1] ?? 0);
  const names = readdirSync(dir).filter((name) => pattern.test(name)).sort((a, b) => time(b) - time(a));
  for (const name of names.slice(keep)) await rm(join(dir, name), { recursive: true, force: true }).catch(() => undefined);
}

export async function build(
  project: Project,
  scheme: string,
  udid: string,
  options: { configuration?: string; clean?: boolean; action?: "build" | "test"; extra?: string[]; xcode?: Xcode; destination?: string; onLine?: (line: string) => void; onCancel?: (cancel: () => void) => void },
): Promise<BuildResult> {
  const derived = derivedDataFor(project, options.xcode);
  await mkdir(derived, { recursive: true });
  await keepNewest(derived, /^(build|test)-\d+\.log$/, 9);
  const log = join(derived, `${options.action ?? "build"}-${Date.now()}.log`);
  const args = [
    project.kind === "workspace" ? "-workspace" : "-project",
    project.path,
    "-scheme",
    scheme,
    "-configuration",
    options.configuration ?? "Debug",
    "-destination",
    options.destination ?? `id=${udid}`,
    "-derivedDataPath",
    derived,
    ...(options.extra ?? []),
    ...(options.clean ? ["clean"] : []),
    options.action ?? "build",
  ];
  const started = Date.now();
  const out = createWriteStream(log);
  // Its own process group, so a cancel stops the compilers it started too.
  const [command, commandArgs] = buildCommand(args);
  const child = spawn(command, commandArgs, { cwd: project.dir, detached: true, stdio: ["ignore", "pipe", "pipe"], env: xcodeEnv(options.xcode) });
  options.onCancel?.(() => {
    try {
      process.kill(-child.pid!, "SIGTERM");
    } catch {
      // Already finished.
    }
  });
  const seen = new Set<string>();
  const errors: Issue[] = [];
  let warnings = 0;
  let pending = "";
  const tail: string[] = [];
  const take = (chunk: Buffer) => {
    out.write(chunk);
    pending += chunk.toString("utf8");
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) {
      options.onLine?.(line);
      if (line.trim()) {
        tail.push(line.length > 200 ? `${line.slice(0, 199)}…` : line);
        if (tail.length > 8) tail.shift();
      }
      const issue = parseIssue(line);
      if (!issue) continue;
      // The same diagnostic repeats (once per architecture or compile batch).
      const key = `${issue.file}:${issue.line}:${issue.severity}:${issue.message}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (issue.severity === "warning") warnings++;
      else errors.push(issue);
    }
  };
  child.stdout.on("data", take);
  child.stderr.on("data", take);
  const code = await new Promise<number | null>((resolveCode) => child.on("close", resolveCode));
  out.end();
  return { ok: code === 0, errors, warnings, log, ms: Date.now() - started, tail };
}

/** The .app a Simulator build made: the scheme's own, never a test runner. */
export function builtApp(project: Project, scheme: string, configuration = "Debug", xcode?: Xcode): string | undefined {
  const products = join(derivedDataFor(project, xcode), "Build", "Products", `${configuration}-iphonesimulator`);
  if (!existsSync(products)) return undefined;
  const apps = readdirSync(products).filter((e) => e.endsWith(".app") && !e.endsWith("-Runner.app"));
  const named = apps.find((a) => a === `${scheme}.app`);
  return named || apps.length === 1 ? join(products, named ?? apps[0]!) : undefined;
}

/** What app_run remembers per folder, so the next call needs no arguments. */
/** What a folder's last app_run or tests_run used; xcode: the version asked for then, kept for later calls. */
export type Remembered = { project: string; scheme: string; bundleId?: string; xcode?: string };

const memoryFile = async (dir: string) => {
  const folder = join(stateDir(), "projects");
  await mkdir(folder, { recursive: true });
  return join(folder, `${createHash("sha1").update(resolve(dir)).digest("hex").slice(0, 16)}.json`);
};

export async function remembered(dir: string): Promise<Remembered | undefined> {
  try {
    return JSON.parse(await readFile(await memoryFile(dir), "utf8")) as Remembered;
  } catch {
    return undefined;
  }
}

export async function remember(dir: string, value: Remembered): Promise<void> {
  await writeFile(await memoryFile(dir), JSON.stringify(value));
}

/** The project the last app_run or tests_run used, for calls that name none from a folder without one. */
export async function lastProject(): Promise<string | undefined> {
  try {
    return (JSON.parse(await readFile(join(stateDir(), "last-project.json"), "utf8")) as { project: string }).project;
  } catch {
    return undefined;
  }
}

export async function setLastProject(project: string): Promise<void> {
  await mkdir(stateDir(), { recursive: true });
  await writeFile(join(stateDir(), "last-project.json"), JSON.stringify({ project }));
}

/**
 * Which project a call means: the path given; else the current folder's (or what app_run remembered for it);
 * else the one the last call used, so an agent that named a path once can drop it.
 */
export async function projectFor(path: string | undefined, scheme: string | undefined): Promise<{ project: Project; scheme: string; dir: string; note: string; xcode?: string }> {
  const dir = path ?? process.cwd();
  const memory = await remembered(dir);
  let project: Project;
  let note = "";
  try {
    project = await findProject(memory && !path ? memory.project : dir);
  } catch (error) {
    const last = path ? undefined : await lastProject();
    if (!last || !existsSync(last)) throw error;
    project = await findProject(last);
    note = `No project in ${dir}; using ${project.name} from the last call (${project.dir}).\n`;
  }
  if (project.note) note += `${project.note}\n`;
  const known = memory?.project === project.path ? memory : await remembered(project.dir);
  const chosen = await pickScheme(project, scheme ?? known?.scheme);
  await setLastProject(project.path);
  return { project, scheme: chosen, dir: path ? dir : project.dir, note, ...(known?.xcode ? { xcode: known.xcode } : {}) };
}
