import { execFile } from "node:child_process";
import { setting } from "../settings.ts";

export type Output = { stdout: string; stderr: string };

/** Runs a program without a shell. Rejects with its stderr when it fails or runs past the timeout. */
export function run(file: string, args: string[], options: { timeoutMs?: number; maxBytes?: number; env?: NodeJS.ProcessEnv } = {}): Promise<Output> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: options.timeoutMs ?? 30_000, maxBuffer: options.maxBytes ?? 64 * 1024 * 1024, encoding: "utf8", ...(options.env ? { env: options.env } : {}) }, (error, stdout, stderr) => {
      // SIMULATOR_USE_DEBUG=1 prints every program run and how long it took, to find where time goes.
      if (setting("DEBUG")) process.stderr.write(`simulator-use:   ${file.split("/").pop()} ${args.slice(0, 2).join(" ")} ${Date.now() - started} ms${error ? " (failed)" : ""}\n`);
      if (!error) return resolve({ stdout, stderr });
      const code = (error as NodeJS.ErrnoException).code;
      const reason =
        code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
          ? "printed more output than can be read"
          : error.killed
            ? `timed out after ${Math.round((options.timeoutMs ?? 30_000) / 1000)} s`
            : (stderr || error.message).trim();
      reject(Object.assign(new Error(`${file.split("/").pop()} ${args[0] ?? ""}: ${reason}`), { stderr, code: error.code }));
    });
  });
}

/**
 * Whether a pid still belongs to the process we started: a pid file can outlive its process (the Simulator shut
 * down, the Mac restarted), and the number may by then belong to something else that must not be signalled.
 */
export async function isOurs(pid: number, pattern: RegExp): Promise<boolean> {
  if (!pid) return false;
  try {
    const { stdout } = await run("ps", ["-o", "command=", "-p", String(pid)], { timeoutMs: 5_000 });
    return pattern.test(stdout);
  } catch {
    return false;
  }
}
