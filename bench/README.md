# iOS Simulator tools for agents: the benchmark

The harness behind [simulator-use.dev/benchmarks](https://simulator-use.dev/benchmarks). It drives every tool the way an
agent does, through the tool's own MCP server over stdio (AXe, which has none, through its command line), on one
booted iPhone 17 Pro Simulator and one app, and saves every call it made as JSON.

## What it measures

On the sign-in screen of `examples/swiftui-demo` (Email, Password, Remember me, Sign In, a status text):

| Step | How | Runs |
|---|---|---|
| Read the screen | the tool's own read (its screen-as-text tool), the screen unchanged | 20 |
| Tap a button | fresh app, the tool reads the screen (untimed), then taps Sign In with empty fields | 20 |
| Type into a field | fresh app, read (untimed), then the tool's way to type into Email: its fill call, or a tap on the field and a type call | 10 |
| Sign in | fresh app, then timed as one: read, type the email, type the password, tap Sign In, read to see "Welcome" | 10 |
| Sign in, batched | the same with the three actions in the tool's own batch or sequence call, where it has one | 10 |
| Tool list | the size of what `tools/list` and the server's instructions put in the agent's context | 1 |

- **Time** is from the request written to the server's stdin to its answer parsed (for AXe, from spawn to exit), summed
  over the calls of a step. Medians are the middle value (the mean of the two middle values for an even count); p90 is
  the nearest-rank 90th percentile.
- **Tokens** are what the agent reads back: the text of each answer, any image in it, and any file the answer points
  to that the agent must open to see the screen (Xcode's hierarchy file). Text is counted with Anthropic's token
  counting API when `ANTHROPIC_API_KEY` is set, else as characters / 4 (the page says which). An image is
  width * height / 750 tokens after the scaling Anthropic applies (2576 px on the long edge, about 4784 tokens at
  most). Tool definitions are counted as `{name, description, input_schema}`, the way a client sends them.
- **Checks** that use no accessibility, so they never compete with the tool for the Simulator: a tap and a sign-in
  are confirmed by the app's own log lines (`sign-in rejected`, `signed in`), streamed with `simctl spawn log stream`.
  A typed field is confirmed by the tool's own next read. A step that errors, or whose check fails, counts as failed,
  with its error kept; nothing is retried.
- **Fairness:** one tool at a time, with every other tool's processes killed; the Simulator is shut down and booted
  again before each tool, so none inherits another's automation session; a warm-up read after the tool's setup is
  timed separately (the first call after a boot); every tool gets the same app resets (`simctl terminate` and
  `launch`) and the same untimed read before an action. Each tool is used as its docs say: its own read, refs or
  selectors by id where it has them, coordinates where that is its way, its own settle and verify options, its own
  setup advice (see each file in `tools/`).

## Run it

On a Mac with Xcode and an iOS Simulator runtime (the published run: a NoMac Mac, `nomac start`):

```sh
bash bench/setup.sh                 # pinned tools into ~/bench-tools; AXe, Java and idb-companion from Homebrew, fb-idb from uv; the demo app; one iPhone 17 Pro
source ~/bench-tools/env.sh
bash bench/run-all.sh bench/results/$(date -u +%F)            # every run, one after another (about two hours)
node bench/run.mjs --tool agent-device --udid $UDID --probe   # one of each step for one tool, printed
node bench/summarize.mjs bench/results/2026-11-06             # summary.json, summary.md
node bench/page.mjs bench/results/2026-11-06 site/benchmarks.html   # the page's tables, from summary.json
node bench/vs.mjs bench/results/2026-11-06 site/vs                  # the /vs pages and site/llms.txt, from summary.json and vs-facts.mjs
```

`setup.sh` pins every version it installs and needs `sudo` once, for `xcrun mcp-server enable` (Xcode's headless MCP
server). To count tokens with Anthropic's API, `npm install @anthropic-ai/sdk` in `bench/` and set
`ANTHROPIC_API_KEY` before `summarize.mjs`; the counts are cached in the results folder.

## Files

- `run.mjs`: one tool, every step, raw results in `results/<date>/<tool>.json` (every call: tool, arguments, time,
  answer text, image sizes), its `tools/list` in `<tool>.tools.json`, its log in `<tool>.log`.
- `tools/<tool>.mjs`: how each tool is driven, with the reason for each choice in its comments.
- `lib/`: the MCP client, the token and statistics rules, the Simulator helpers.
- `summarize.mjs`: the numbers the page shows.
- `vs.mjs` and `vs-facts.mjs`: the one-on-one pages (simulator-use.dev/vs). Every number comes from a run's
  `summary.json` and raw results (the calls in "Switching" are the ones each tool made); every other claim lives in
  `vs-facts.mjs` with the sources it was read from. A measured difference is claimed only when it holds against both of
  simulator-use's runs by at least 5%.
- `debug/`: the scripts used to find how a tool works (Xcode's command grammar, agent-device's snapshots) and to
  check a failure (`axe-taps.mjs`, `ism-reads.mjs`: ios-simulator-mcp's reads after a boot and after a fresh app
  start); not part of a run.
- `lib/dedup.mjs`: stores each long answer text of a results file once (AXe's 220 KB screen read repeats). AXe's
  file is still about 20 MB, so it is kept as `axe.json.gz`; `summarize.mjs` reads both forms.

## The November 6, 2026 run

`results/2026-11-06/` holds the published run, the first with ios-simulator-mcp: every tool at its latest release on
November 6 (simulator-use 0.15.1, ios-simulator-mcp 2.2.0 on idb-companion 1.7.8 and fb-idb 1.7.7, mobile-mcp 1.0.16,
agent-device 0.21.36, Argent 0.32.0, Maestro 2.12.1, MobileBuildMCP 2.7.1, AXe 1.8.0, Xcode 27.0), on one NoMac Mac
(M4 virtual Mac, 6 cores, 8 GB, macOS 26.6.2, Xcode 27.0, iOS 27.0), from 12:56 to 14:48 UTC, in the order of
`run-all.sh`'s default list, then mobile-mcp twice more. In mobile-mcp's first two tries its setup's first read failed
starting its on-device agent ("timed out waiting for WebDriverAgent to be ready", after 37 s and 23 s), so the app was
never opened and its reads of the unchanged screen read the Home Screen; those files were renamed after the run to
`mobile-mcp.first.*` and `mobile-mcp.second.*`, with the label set in each. Its setup now reads once more after that
error, and the third try (`mobile-mcp.*`) is the ranked one. Some first reads timed out creating the Simulator's
remote automation session: AXe's first four in its ranked run and first three with Device Hub open, MobileBuildMCP's
first with Device Hub open and first three in its control run. With Device Hub open, no tap of AXe or MobileBuildMCP
reached the app. The page says so under "Not ranked here".

## The November 1, 2026 run

`results/2026-11-01/` held the published run until November 6: simulator-use 0.15.0, every other tool at the version it had on
October 31, on one NoMac Mac (M5 Pro virtual Mac, 6 cores, 8 GB, macOS 26.6.2, Xcode 27.0, iOS 27.0), in the order
of `run-all.sh`'s default list but for two runs. Maestro MCP and AXe's Device Hub closed run (`axe.control.*`) first
stopped before any call, with the Simulator found shut down after its reboot; each came after a run that left
Device Hub open (`conditionAtEnd` in `argent.json` and `mobilebuildmcp.devicehub.json`). Both ran again at the
end, after `mobilebuildmcp.control`, and those are the files here. In `mobilebuildmcp.json`,
`mobilebuildmcp.devicehub.json` and `axe.control.json.gz` the first read timed out creating the Simulator's remote
automation session; the calls after it worked, faster than in the runs that made the session, and AXe's reads were
longer (55,106 tokens against 44,869). The page says so under "Not ranked here".

## The October 31, 2026 run

`results/2026-10-31/` holds the first published run, with simulator-use 0.14.0: every tool on one NoMac Mac
(M5 Pro virtual Mac, 6 cores, 8 GB, macOS 26.6.2, Xcode 27.0, iOS 27.0), one after the other, in the order of
`run-all.sh`'s default list: simulator-use first, the other seven, simulator-use again (`simulator-use.last.*`), then AXe and MobileBuildMCP again with Device Hub open (`*.devicehub.*`), because AXe's README says "Xcode 27
simulator automation uses Device Hub", and once more with Device Hub closed (`*.control.*`), to tell Device Hub from
the time in the session. Every run but the Device Hub ones had Device Hub closed; each results file records it under
`condition`. AXe's three files are gzipped (`axe*.json.gz`, about 20 MB each unpacked).

`debug/axe-taps.mjs` is a smaller check of AXe's taps: after a fresh boot, read the screen N times, then tap Sign In
three times and look for each tap in the app's log.
