import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { outOption, parseArgs, usage } from "../src/cli.ts";
import { launch, launchWords, shellWord } from "../src/engine/apps.ts";
import { TOOLS } from "../src/registry.ts";
import { appControl, launchValue } from "../src/tools/app-control.ts";

test("launch arguments split into words as a shell would, nothing expanded", () => {
  assert.deepEqual(launchWords("-Step 3 -DemoMode YES"), ["-Step", "3", "-DemoMode", "YES"]);
  assert.deepEqual(launchWords('  -AutoAsk "How do I politely say no?"  '), ["-AutoAsk", "How do I politely say no?"]);
  assert.deepEqual(launchWords(`-Name 'O'\\''Brien' -Quote "a \\"b\\" c" -Empty ""`), ["-Name", "O'Brien", "-Quote", 'a "b" c', "-Empty", ""]);
  assert.deepEqual(launchWords("-Path $HOME/x -Glob *.swift -Escaped two\\ words"), ["-Path", "$HOME/x", "-Glob", "*.swift", "-Escaped", "two words"]);
  assert.deepEqual(launchWords(""), []);
  assert.throws(() => launchWords('-AutoAsk "never closed'), /double quote that is never closed/);
  assert.throws(() => launchWords("-A 'x"), /single quote that is never closed/);
  assert.throws(() => launchWords(Array.from({ length: 101 }, () => "-x").join(" ")), /up to 100/);
  assert.throws(() => launchWords("-A x\0y"), /NUL/);
  // Only a shell's separators split: a no-break space stays in its word. In double quotes \$ is a $, as in a shell.
  assert.deepEqual(launchWords("-Greeting Bonjour\u00a0! -Price \"\\$5\""), ["-Greeting", "Bonjour\u00a0!", "-Price", "$5"]);
});

test("a word quoted for the shell reads back as it was", () => {
  const words = ["-Step", "3", "How do I?", "O'Brien", 'say "hi"', "", "back\\slash", "tab\there", "line\nbreak", "naïve ✓", "$HOME", "--uitesting"];
  assert.deepEqual(launchWords(words.map(shellWord).join(" ")), words);
});

test("launch's value: the app's arguments, after its bundle id when app is not given", () => {
  assert.deepEqual(launchValue("-Step 3", undefined), { app: undefined, args: ["-Step", "3"] });
  assert.deepEqual(launchValue("dev.example.app -Step 3", undefined), { app: "dev.example.app", args: ["-Step", "3"] });
  assert.deepEqual(launchValue("dev.example.app", undefined), { app: "dev.example.app", args: [] });
  assert.deepEqual(launchValue("-Step 3", "dev.example.app"), { app: "dev.example.app", args: ["-Step", "3"] });
  assert.deepEqual(launchValue("plain -Step 3", "dev.example.app"), { app: "dev.example.app", args: ["plain", "-Step", "3"] });
  assert.deepEqual(launchValue(undefined, undefined), { app: undefined, args: [] });
  assert.deepEqual(launchValue(undefined, "dev.example.app"), { app: "dev.example.app", args: [] });
  // Named in both, as a launch's value always was before 0.14: the app, not an argument.
  assert.deepEqual(launchValue("dev.example.app", "dev.example.app"), { app: "dev.example.app", args: [] });
  assert.deepEqual(launchValue("dev.example.app -Step 3", "dev.example.app"), { app: "dev.example.app", args: ["-Step", "3"] });
});

test("the CLI takes a launch's arguments as the words after the app", () => {
  assert.deepEqual(parseArgs(appControl, ["launch", "dev.example.app"]), { action: "launch", value: "dev.example.app" });
  assert.deepEqual(parseArgs(appControl, ["launch", "dev.example.app", "-Step", "3", "-AutoAsk", "How do I?"]), { action: "launch", value: "dev.example.app -Step 3 -AutoAsk 'How do I?'" });
  assert.deepEqual(parseArgs(appControl, ["launch", "-Step", "3"]), { action: "launch", value: "-Step 3" });
  // Each word the shell gives is one argument, the first one too.
  assert.deepEqual(parseArgs(appControl, ["launch", "-Step 3 -Demo YES"]), { action: "launch", value: "'-Step 3 -Demo YES'" });
  assert.deepEqual(launchValue(String((parseArgs(appControl, ["launch", "--app", "dev.x", "Hello there"]) as Record<string, unknown>).value), "dev.x"), { app: "dev.x", args: ["Hello there"] });
  assert.deepEqual(launchValue(String((parseArgs(appControl, ["launch", "-Name=O'Brien", "C:\\temp"]) as Record<string, unknown>).value), undefined), { app: undefined, args: ["-Name=O'Brien", "C:\\temp"] });
  assert.deepEqual(parseArgs(appControl, ["launch", "dev.example.app", "--", "--uitesting"]), { action: "launch", value: "dev.example.app --uitesting" });
  assert.deepEqual(parseArgs(appControl, ["launch", "-Step", "3", "--app", "dev.example.app"]), { action: "launch", value: "-Step 3", app: "dev.example.app" });
  // Only a launch takes more words: anything else still says which word it did not expect.
  assert.match(String(parseArgs(appControl, ["push", "hi", "extra"])), /Unexpected "extra"/);
  const typed = parseArgs(appControl, ["launch", "dev.example.app", "-AutoAsk", `It's "fine"`]) as Record<string, unknown>;
  assert.deepEqual(launchValue(typed.value as string, undefined), { app: "dev.example.app", args: ["-AutoAsk", `It's "fine"`] });
});

test("a launch hands its arguments to the app after the bundle id, each one word, never through a shell", async () => {
  const bin = mkdtempSync(join(tmpdir(), "su-launch-"));
  const record = join(bin, "calls");
  writeFileSync(join(bin, "xcrun"), `#!/bin/sh\nfor a in "$@"; do printf '[%s]\\n' "$a" >> "${record}"; done\nexit 0\n`, { mode: 0o755 });
  const saved = { PATH: process.env.PATH, STATE: process.env.SIMULATOR_USE_STATE_DIR };
  process.env.PATH = `${bin}:${saved.PATH}`;
  process.env.SIMULATOR_USE_STATE_DIR = mkdtempSync(join(tmpdir(), "su-launch-state-"));
  try {
    // launch() lets the launcher run on after 2 s, so the record is waited for, not read at once.
    const recorded = async (lines: string[]) => {
      const want = lines.map((a) => `[${a}]\n`).join("");
      for (let i = 0; i < 100 && (existsSync(record) ? readFileSync(record, "utf8") : "") !== want; i++) await new Promise((r) => setTimeout(r, 100));
      assert.equal(existsSync(record) ? readFileSync(record, "utf8") : "", want);
      unlinkSync(record);
    };
    await launch("UDID-LAUNCH-1", "dev.example.app", ["-AutoAsk", "How do I say no?", "-Cmd", "$(touch /tmp/x)"]);
    await recorded(["simctl", "launch", "--console-pty", "--terminate-running-process", "UDID-LAUNCH-1", "dev.example.app", "-AutoAsk", "How do I say no?", "-Cmd", "$(touch /tmp/x)"]);
    await launch("UDID-LAUNCH-1", "dev.example.app");
    await recorded(["simctl", "launch", "--console-pty", "--terminate-running-process", "UDID-LAUNCH-1", "dev.example.app"]);
  } finally {
    process.env.PATH = saved.PATH;
    if (saved.STATE === undefined) delete process.env.SIMULATOR_USE_STATE_DIR;
    else process.env.SIMULATOR_USE_STATE_DIR = saved.STATE;
  }
});

test("look --out: a .jpg sized to points or a .png at full resolution, taken out before the tool's own options", () => {
  const look = TOOLS.find((t) => t.name === "ui_look")!;
  assert.deepEqual(outOption(look, ["--find", "Save", "--out", "shots/a.jpg"]), { argv: ["--find", "Save"], out: "shots/a.jpg" });
  assert.deepEqual(outOption(look, ["--out=store/1.PNG"]), { argv: [], out: "store/1.PNG" });
  assert.deepEqual(outOption(look, ["--out", "a.jpeg", "--", "--out"]), { argv: ["--", "--out"], out: "a.jpeg" });
  assert.match(String(outOption(look, ["--out", "a.gif"])), /takes a \.jpg .* or a \.png/);
  assert.match(String(outOption(look, ["--out"])), /needs a file/);
  // Another command has no --out: its own parser refuses it.
  assert.deepEqual(outOption(appControl, ["--out", "x.jpg"]), { argv: ["--out", "x.jpg"] });
  assert.match(String(parseArgs(appControl, ["--out", "x.jpg"])), /Unknown option --out/);
  assert.match(usage(look), /\[--out <file>\]/);
});

test("a screenshot waits for the screen to hold still: two frames alike, the last one after 2 s, or the one in hand", async () => {
  const { closeEngines } = await import("../src/engine/native.ts");
  const { stillScreen } = await import("../src/tools/ui-look.ts");
  const points = { x: 0, y: 0, width: 402, height: 874 };
  process.env.SIMULATOR_USE_ENGINE = new URL("fixtures/fake-engine-frames.mjs", import.meta.url).pathname;
  try {
    process.env.FAKE_FRAMES = "sliding-1,sliding-2,done";
    assert.deepEqual(await stillScreen("FAKE-STILL-1", points), { jpeg: Buffer.from("done"), moving: false });
    process.env.FAKE_FRAMES = Array.from({ length: 40 }, (_, i) => `spinner-${i}`).join(",");
    const started = Date.now();
    const spinner = await stillScreen("FAKE-STILL-2", points);
    assert.equal(spinner.moving, true);
    assert.match(spinner.jpeg.toString(), /^spinner-\d+$/);
    assert.ok(Date.now() - started >= 2_000 && Date.now() - started < 6_000, `${Date.now() - started} ms`);
    // A busy engine on a later frame: the frame in hand, not a failed look.
    process.env.FAKE_FRAMES = "first,BUSY";
    assert.deepEqual(await stillScreen("FAKE-STILL-3", points), { jpeg: Buffer.from("first"), moving: false });
  } finally {
    closeEngines();
    delete process.env.SIMULATOR_USE_ENGINE;
    delete process.env.FAKE_FRAMES;
  }
});
