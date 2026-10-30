#!/usr/bin/env node
// A stand-in engine whose screenshots are FAKE_FRAMES (comma-separated), one per request, the last repeating; BUSY answers busy.
import { createInterface } from "node:readline";
const frames = (process.env.FAKE_FRAMES ?? "a").split(",");
let shown = 0;
process.stdout.write(JSON.stringify({ ready: true }) + "\n");
for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  const frame = frames[Math.min(shown++, frames.length - 1)];
  const answer = request.op !== "screenshot" ? { ok: true } : frame === "BUSY" ? { busy: true } : { ok: true, jpeg_base64: Buffer.from(frame).toString("base64") };
  process.stdout.write(JSON.stringify(answer) + "\n");
}
