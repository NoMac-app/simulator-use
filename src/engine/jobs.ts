import { randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

import type { ToolResult } from "../tools/types.ts";
import { tryLock } from "./lock.ts";
import { setting } from "../settings.ts";

/**
 * Long work (a build) answers within 40 s with a job, and keeps going in this MCP server's process.
 * job_status follows it; job_cancel stops it. Jobs live as long as the server does.
 */
export type Job = {
  id: string;
  title: string;
  started: number;
  /** What it is doing now, for job_status: "building", "installing", ... */
  step: string;
  /** The last lines of output, for job_status while it runs. */
  tail: string[];
  log?: string;
  result?: ToolResult;
  cancelled?: boolean;
  cancel?: () => void;
  done: Promise<ToolResult>;
};

const jobs = new Map<string, Job>();
let latest: string | undefined;

/** Stops every running job: the server is going away, and a build nobody can follow should not keep compiling. */
export function cancelAllJobs(): void {
  for (const job of jobs.values()) if (!job.result) job.cancel?.();
}
/** Work that must end before a signal ends the process (a cloud phone to stop, a tunnel to close). */
const beforeExit = new Set<() => Promise<unknown>>();
/** Runs work when a signal ends the process, up to 15 s in all; answers how to take it back. */
export function onSignalExit(work: () => Promise<unknown>): () => void {
  beforeExit.add(work);
  return () => beforeExit.delete(work);
}
// Node runs no exit handler when a signal ends the process, so the signals stop the jobs themselves. A second
// signal while that work runs ends the process at once (the handler is gone by then).
process.on("exit", cancelAllJobs);
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
  process.once(signal, () => {
    cancelAllJobs();
    const code = 128 + ({ SIGHUP: 1, SIGINT: 2, SIGTERM: 15 } as const)[signal];
    if (!beforeExit.size) process.exit(code);
    const work = [...beforeExit].map((w) => w().catch(() => undefined));
    void Promise.race([Promise.all(work), delay(15_000, undefined, { ref: false })]).finally(() => process.exit(code));
  });
}

/** A job's handle for the work to report progress through. */
export type Progress = { step: (step: string) => void; line: (line: string) => void; setCancel: (cancel: (() => void) | undefined) => void; setLog: (file: string) => void };

export function startJob(title: string, work: (progress: Progress) => Promise<ToolResult>): Job {
  const id = `job_${randomBytes(4).toString("hex")}`;
  const job = { id, title, started: Date.now(), step: "starting", tail: [] as string[] } as Job;
  const progress: Progress = {
    step: (step) => {
      job.step = step;
    },
    line: (line) => {
      job.tail.push(line);
      if (job.tail.length > 20) job.tail.shift();
    },
    // Cleared once the part that can be stopped (the build) is over, so a late cancel doesn't claim it stopped.
    setCancel: (cancel) => {
      job.cancel = cancel
        ? () => {
            job.cancelled = true;
            cancel();
          }
        : undefined;
    },
    setLog: (file) => {
      job.log = file;
    },
  };
  job.done = work(progress)
    .catch((error: Error & { toText?: () => string }) => ({ text: error.toText?.() ?? `${title} failed: ${error.message}`, isError: true }))
    .then((result) => {
      // Whatever the stopped work reported (a build "fails" when killed), the truth is it was stopped.
      if (job.cancelled) result = { text: `${title} was stopped by job_cancel after ${elapsed(job)}.`, isError: true };
      job.result = result;
      job.cancel = undefined;
      return result;
    });
  jobs.set(id, job);
  latest = id;
  return job;
}

export const getJob = (id?: string) => jobs.get(id ?? latest ?? "");

/** Waits for a job up to `ms`, so a caller can answer with the result when it comes soon, or with progress. */
export async function waitFor(job: Job, ms: number): Promise<ToolResult | undefined> {
  if (job.result) return job.result;
  return Promise.race([job.done, delay(ms, undefined, { ref: false })]);
}

export const elapsed = (job: Job) => {
  const s = Math.round((Date.now() - job.started) / 1000);
  return s >= 60 ? `${Math.floor(s / 60)} min ${s % 60} s` : `${s} s`;
};

/** A call answers within this (40 s); longer work goes on as a job. */
export const ANSWER_WITHIN_MS = (Number(setting("JOB_AFTER_S")) || 40) * 1000;

/** The result if it comes within 40 s, else the job to follow; the CLI just waits. */
export async function answer(job: Job, waitForJobs: boolean): Promise<ToolResult> {
  if (waitForJobs) return job.done;
  const done = await waitFor(job, ANSWER_WITHIN_MS);
  if (done) return done;
  return { text: `${job.title} is still ${job.step} after ${elapsed(job)}: job ${job.id}.\nNext: job_status {job_id: "${job.id}"}; it waits up to 40 s for the result.` };
}

/** Which running job holds a project: xcodebuild runs in that project's DerivedData, which only one may use. */
const projects = new Map<string, Job>();

/**
 * Claims a project for a job, or names what already builds it: a job of this process, or the pid of another
 * simulator-use process (each CLI call is its own). Released when the job ends.
 */
export async function claimProject(projectPath: string, job: Job): Promise<Job | number | undefined> {
  const holder = projects.get(projectPath);
  if (holder && !holder.result && holder !== job) return holder;
  // Claimed here first, so a second call of this process waiting on the lock below names this job.
  projects.set(projectPath, job);
  const taken = await tryLock(`project-${projectPath}`);
  if ("holder" in taken) {
    if (projects.get(projectPath) === job) projects.delete(projectPath);
    return taken.holder;
  }
  void job.done.finally(() => {
    if (projects.get(projectPath) === job) projects.delete(projectPath);
    void taken.release();
  });
  return undefined;
}

/** The job this one is: for work that runs inside it and needs to claim things in its name. */
export const currentJob = (id: string) => jobs.get(id);
