#!/usr/bin/env node
// A stand-in engine for an iPhone Duo's tests: its ready line and every answer name the screen in use and the posture
// (FAKE_POSTURE, default open: the inner screen; closed: the outer); requests are logged to FAKE_LOG.
//   hinge: FAKE_HINGE ok (the posture asked becomes the phone's) or a typed error code (busy, timeout, boot_changed,
//          unsupported).
//   settle_read and steps: FAKE_INPUT ok, or screen_changed (refused after part of it went out), screen_changing or
//          screen_unknown (refused before any of it did).
import { appendFileSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";

const tree = JSON.parse(readFileSync(new URL("login.json", import.meta.url), "utf8"));
const log = (request) => process.env.FAKE_LOG && appendFileSync(process.env.FAKE_LOG, `${JSON.stringify(request)}\n`);
const screens = {
  closed: { id: 1, role: "outer", width: 1398, height: 2034, scale: 3, orientation: "portrait" },
  book: { id: 3, role: "inner", width: 2853, height: 2007, scale: 3, orientation: "landscape" },
  open: { id: 3, role: "inner", width: 2007, height: 2853, scale: 3, orientation: "portrait" },
};
const degrees = { closed: 0, book: 94.6, open: 180 };
let posture = process.env.FAKE_POSTURE ?? "open";
const fields = () => ({ screen: screens[posture], posture, hinge_degrees: degrees[posture] });
process.stdout.write(JSON.stringify({ ready: true, input: ["points", "normalized"], foldable: true, ...fields() }) + "\n");
for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  log(request);
  const input = process.env.FAKE_INPUT ?? "ok";
  let answer = { ok: true };
  if (request.op === "hinge") {
    const mode = process.env.FAKE_HINGE ?? "ok";
    if (mode === "ok") {
      const already = posture === request.posture;
      const via = posture === "closed" && request.posture === "book" ? { via: "open" } : {};
      posture = request.posture;
      answer = { ok: true, already, ms: already ? 300 : 16_400, hinge_ms: 700, switch_ms: 15_900, ...via };
    } else answer = { ok: false, code: mode, error: `the engine said ${mode}`, input_sent: false };
  } else if (request.op === "describe") answer = { ok: true, tree };
  else if ((request.op === "settle_read" && request.input) || request.op === "steps" || request.op === "swipe" || request.op === "home") {
    if (input === "screen_changed") answer = { ok: false, code: "screen_changed", error: "The screen in use changed", input_sent: true };
    else if (input === "screen_changing" || input === "screen_unknown") answer = { ok: false, code: input, error: `the engine said ${input}`, input_sent: false };
    else answer = { ok: true, tree, settled: true, changed: true, reads: 1, dropped: 0, read_ms: [5], first_change_ms: 10 };
  } else if (request.op === "settle_read") answer = { ok: true, tree, settled: true, changed: false, reads: 1, dropped: 0, read_ms: [5], first_change_ms: -1 };
  process.stdout.write(JSON.stringify({ id: request.id, ...answer, ...fields() }) + "\n");
}
