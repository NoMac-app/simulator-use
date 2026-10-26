# simulator-use

**The fastest, most token-efficient way for an AI agent to use the iOS Simulator.** simulator-use gives Claude Code, Codex, Cursor and any other MCP client a phone: it builds and runs your Xcode project, reads the screen as a few lines of text, taps and types by label, and runs your tests case by case. Its own native engine talks to the Simulator directly, so reading the whole screen takes about 250 ms and a tap goes out in under a millisecond, where tools that start a helper for every call take 1.5 to 3 seconds. Free and open source (MIT), on any Mac with Xcode, and from Linux, Windows or a Mac without Xcode through a cloud iPhone.

- **Fast:** a whole-screen read in about 250 ms, a tap sent in under 1 ms, a screenshot in about 60 ms (measured on an M6 Mac mini, October 2026).
- **Token-efficient:** one line per element the agent can use, nothing else; a dozen tools with short descriptions.
- **Complete:** build, install, launch, XCTest and XCUITest per case, logs and crashes, video, permission prompts, iPhone and iPad.
- **Continuously improved:** weekly releases driven by thousands of daily sessions.
- **Anywhere:** `npx simulator-use cloud start` gives a cloud iPhone with Xcode to any machine.

It builds, runs and tests Xcode projects, reads and uses the screen of any app (SwiftUI, UIKit, React Native), answers iOS's permission prompts, reads the app's logs and crashes, and records video.


## What the agent sees

```
Demo · Sign In · iPhone 17 Pro (iOS 27.0)
textfield "Email" #email @201,194
securefield "Password" #password @201,246
switch "Remember me" #remember off @341,298
button "Sign In" #signIn @201,350
text "Not signed in" #status @201,402
tabs: Login (selected) @158,822, Items @244,822
```

- One line per element: kind, label, `#id` (the app's accessibility identifier), state and `@x,y`, the center in points.
- Groups, icons inside buttons, scroll bars, the status bar and the keyboard's keys are folded away. The tab bar, scrolling and the keyboard are one line each.
- Only what can be tapped is listed. An alert, a sheet, a menu or a full-screen view in front hides the screen behind it, and iOS's own permission prompts read as alerts over the app. Rows under the navigation bar, the tab bar or the keyboard are counted as hidden (above, below, to the left or right), not listed.
- A web view in UIKit (Capacitor, React Native's WebView, a sign-in page inside most apps) is read point by point, and its headings, texts, fields, checkboxes, buttons and links are listed like the rest. Web views hosted by SwiftUI, Safari's own pages, in-app browsers, maps, games and iOS's out-of-process pickers have nothing for accessibility to read. They come back as one `unreadable` line with their place, so the agent knows to take a screenshot and tap by point.
- A screenshot, when asked for, is sized to points, so a point in the picture is a point to tap. `screenshot_file` saves the screen at full resolution as a PNG for a person, a report or the App Store; in cloud mode it is saved on your machine too.
- The sign-in screen above is about 70 tokens. The full accessibility tree it comes from is about 40,000.

## Using the screen

`ui_act` takes steps in the same words `ui_look` prints, runs them in order, and answers with what changed:

```
ui_act steps: ["fill #email gary@example.com", "fill #password secret1", "tap #signIn", "wait \"Welcome\""]

4 steps done in 4.5 s
changed: #email "gary@example.com" · #password "•••••••" · #status "Welcome, gary@example.com"
```

Steps:

| Step | Does |
|---|---|
| `tap #id`, `tap "label"`, `tap button "label"`, `tap @x,y` | Taps; a switch gets a real touch |
| `fill #id text` | Focuses the field, clears it, types, and reads the text back |
| `type text` | Types into the field that has focus |
| `scroll down`, `scroll right @201,402` | Scrolls the screen, or one carousel |
| `swipe left`, `swipe left "Row 3"` | Swipes the screen, or one row (to reveal Delete) |
| `hold "Row 5" [seconds]` | Long press, for context menus |
| `set #volume 75` | Sets a slider to a percent |
| `back`, `home`, `key return` | The back button (or edge swipe), the home button, a key |
| `wait "Welcome" [seconds]`, `gone "Loading"` | Waits for something to appear or go |

Every step is checked, so nothing succeeds silently:
- Typed text is read back from the field. When iOS's autocorrect or smart punctuation changes it (`--` to `—`, `'` to `’`), the text is pasted instead, which iOS takes as is. A field that still shows something else stops the call and says what it shows.
- Text in any language (Café, 日本語, emoji) can be typed: what a US keyboard lacks goes through the Simulator's clipboard.
- `fill` refuses anything that isn't a text field, so keys never land in whichever field still has focus.
- A tap that changes nothing is reported, after waiting 2.5 s for late answers such as a permission prompt. A tap inside an area that can't be read says it can't be checked.
- A target that isn't on screen yet gets two seconds to appear, then fails with the next step: "2 elements are below: scroll down", or, when an alert came up in front, "Answer it first: tap "Cancel" or "Open"".
- The first failing step stops the rest and returns the screen as it is now.
- A new screen comes back whole; otherwise only what changed.

## Tools

| Tool | CLI | Does |
|---|---|---|
| `app_run` | `simulator-use run` | Builds the Xcode project here, installs and launches it, answers with the first screen; errors as `file:line`; `--xcode 26.6` builds with another installed Xcode |
| `devices` | `simulator-use devices` | Lists the Simulators on this Mac with their runtime, UDID and state, and its Xcodes |
| `device_use` | `simulator-use use "iPhone 17 Pro"` | Chooses the Simulator the other tools use, booting it (one boot at a time); dark mode, a clean status bar |
| `app_control` | `simulator-use app launch dev.example.app` | `install`, `launch` (answers with the first screen), `terminate`, `uninstall`, `open_url`; `grant`, `revoke` and `reset_permissions`; `location`; `push`; the phone's `appearance`, `locale`, `timezone`, `text_size` and a clean `status_bar` |
| `ui_look` | `simulator-use look` | Reads the screen; `find` keeps matching lines, `screenshot` adds a picture, `screenshot_file` saves a full-resolution PNG, `full` saves the whole tree |
| `ui_act` | `simulator-use act "tap #signIn" ...` | Does steps in order and answers with what changed |
| `app_logs` | `simulator-use logs` | The app's print output and its own system log lines; `grep`, `wait_for`, `crashes` |
| `tests_run` | `simulator-use test` | Runs the unit and UI tests; each case as it finishes, counts, each failure as `file:line` and the slowest; "0 tests ran" is an error |
| `screen_record` | `simulator-use record start` | Starts or stops a video of the screen; stop answers with the MP4 |
| `job_status` | `simulator-use job` | Waits up to 40 s for a long build and answers with its result, or its progress |
| `job_cancel` | `simulator-use cancel` | Stops a job |
| `cloud` | `simulator-use cloud start` | `start`, `status`, `stop` a NoMac cloud phone that every tool then runs on; `run` builds, tests and stops in one call (see Cloud) |

The MCP server and the CLI are built from one list, so they always match. The tool list and instructions stay under 4,000 tokens; a test enforces it.

## Build and run

`app_run` does the whole loop in one call: it finds the project (a workspace first, then a project, an XcodeGen spec, or `ios/`), picks the scheme, builds for the Simulator, installs, launches, and answers with the first screen.

The app's permissions are granted when it is installed and its first launch's prompts (notifications too) are answered, so no prompt stops the agent; `permissions: "ask"` keeps iOS's prompts, to test them. `open_url` answers iOS's "Open in …?" for a link that opens another app.

```
Built Demo in 4.2 s, installed dev.simtap.demo.
Launched Demo in 3.9 s.
Demo · Sign In · iPhone 17 Pro (iOS 27.0)
textfield "Email" #email @201,194
...
```

- A failed build answers with the errors only, as `Sources/App.swift:49:37: error: ...`, and the path to the full log.
- Each folder (each git worktree) builds into its own DerivedData, so rebuilds are incremental and worktrees never share products. `SIMULATOR_USE_CACHE_DIR` puts it on a disk you keep, so the next machine's build is incremental too.
- An XcodeGen project is regenerated from `project.yml` before each build (skipped when nothing changed), so new files are always in it.
- The next call in the same folder needs no arguments.
- `env: "API_URL=http://127.0.0.1:8080 MODE=test"` gives the app those variables (it reads them from `ProcessInfo`), as an Xcode scheme does; they stay for its later launches, and `env: ""` clears them.
- An MCP call answers within 40 s; a longer build answers with a job, and `job_status` waits for it. From the CLI, `simulator-use run` simply waits.
- Two builds of one project never run at once, also from two processes: the second says which process is building it.
- Expo, React Native, Flutter and Capacitor builds are not done yet; build them with their own tools, then `app_control install`.

## Tests

`tests_run` runs the scheme's tests and reads the answer from Xcode's result bundle, not from the scrolling output:

```
Tests failed: 1 passed, 2 failed (3 in 35.3 s). Result bundle: .../tests-1792370825323.xcresult
DemoTests/SignInTests/testRejectsAShortPassword(): Tests/SignInTests.swift:12: XCTAssertEqual failed: ("Welcome, gary@example.com") is not equal to ("Invalid email or password")
DemoTests/rejectsAnEmailWithoutAt(): Tests/SignInTests.swift:18: Expectation failed: ...
```

- XCTest and Swift Testing both.
- Each failing test is named the way `only` takes it, to rerun just that one.
- "0 tests ran" (no test target, or a filter that matched nothing) is an error, never a pass.

## Logs and crashes

`app_logs` shows what the app itself said, not the thousands of lines Apple's frameworks log from inside it:
- Its `print()` output, kept from the moment `app_control` launches it.
- Its own system log lines (its subsystem, or logged by its own code), streamed from launch. macOS keeps info lines only in memory and drops them within seconds when the Simulator is busy, so reading the log store afterwards misses them.
- `grep` also searches Apple's lines, for things like a missing image or a layout warning.
- `wait_for` waits up to 25 seconds for a line, for example after a tap that starts a network call.
- `crashes` lists crash reports with the crashing thread down to your code (`ItemsView.body.getter (App.swift:64)`), next to the app's last output, which holds Swift's own message (`App.swift:64: Fatal error: ...`). macOS can take up to a minute to write a report.

## Several agents, one Mac

- Each agent runs its own MCP server and holds its own Simulator through `device_use`, and its own cloud phone: one agent's `cloud start` never moves another's tools, its `cloud stop` never ends another's phone, and the phone stops when the agent's server ends. A `cloud start` typed in a terminal is the command line's own.
- Boots never overlap, across every simulator-use process on the Mac: two Simulators booting at once on an 8 GB Mac pushed it into swap for minutes.
- `SIMULATOR_USE_MAX_BOOTED` caps how many run at once; asking for another shuts down the others first.
- Steps on one Simulator run one at a time, across every simulator-use process on the Mac, so two agents' or two commands' taps never interleave.

## One command at a time

Agents that run simulator-use through a shell, a command per call, get the same tools:
- `simulator-use use` is remembered: the next command uses that Simulator, also with several booted. `SIMULATOR_USE_STATE_DIR` moves simulator-use's files (default: simulator-use in the temporary folder).
- Each command waits for its own work, so there is no job to follow.
- `simulator-use call <tool> '<json>'` calls a tool by its MCP name and prints one line of MCP content, `{"content":[...],"isError":true}` on failure, images as base64:

```
$ simulator-use call ui_look '{"find":"Sign In"}'
{"content":[{"type":"text","text":"Demo · Sign In · iPhone 17 Pro (iOS 27.0)\nbutton \"Sign In\" #signIn @201,350"}]}
```

## What it can't do yet

- Read web views hosted by SwiftUI, Safari's pages, in-app browsers, Flutter or game canvases: it says so, and a screenshot plus tap by point works.
- Real devices, Android, rotating to landscape, pinch and multi-touch.
- Reading text an app hides from accessibility: some React Native apps set a test id as the label, and the read says when labels look like that.

## Install

Needs macOS with Xcode and a Simulator runtime, and Node 20 or newer.

**No Mac?** If your agent works on Linux, Windows or in a cloud sandbox, [NoMac](https://nomac.app) gives it a real Mac in the cloud, with Xcode and the iOS Simulator, billed by the minute.

```sh
# Claude Code
claude mcp add simulator-use -- npx -y simulator-use mcp

# Codex
codex mcp add simulator-use -- npx -y simulator-use mcp
```

Claude Code also takes it as a plugin: `/plugin install simulator-use --marketplace NoMac-app/simulator-use`.

Cursor, Windsurf, VS Code and other clients that take a JSON config:

```json
{
  "mcpServers": {
    "simulator-use": { "command": "npx", "args": ["-y", "simulator-use", "mcp"] }
  }
}
```

Any other client: run `npx -y simulator-use mcp` as a stdio server. It speaks MCP 2024-11-05 through 2026-07-28.

Agents that work from a shell can use the CLI instead; `skill/SKILL.md` in the package teaches it in under 2 KB.

From a shell: `npx simulator-use look`.

## Cloud

Where this machine can't run the Simulator (Linux, Windows, a cloud agent), or for CI, the same tools run on a cloud iPhone Simulator on [NoMac](https://nomac.app/?utm_source=simulator-use), a Mac with Xcode, $0.80 an hour by the minute:

```
simulator-use cloud start      # signs in through a link the first time (or NOMAC_API_KEY), starts a phone (--device ipad for an iPad)
simulator-use run              # every tool now runs there; run and test send the project first
simulator-use cloud extend 30  # 30 minutes more (an hour by default), up to 8 hours in all
simulator-use cloud stop       # ends it; the tools run on this machine again
simulator-use cloud run . --tests   # CI in one line: start, build, run, test, a screenshot and a recording, stop
```

Only the files the phone lacks are sent (a one-file change sends one file), into the account's own encrypted workspace, kept between sessions so builds stay incremental; build output and dependencies stay behind. Only files changed since the last send are read again (an index in simulator-use's state folder; `SIMULATOR_USE_SYNC_INDEX=0` reads every file). A CocoaPods project builds there too: `pod install` runs on the phone's host before the build when the pods are not the ones `Podfile` and `Podfile.lock` name, keeping the lock's versions, and the next build skips it. The `cloud` tool does the same over MCP.

`cloud start` answers a link for a person to watch the phone in a browser and one to use it. `cloud stop` answers the session's replay: the screen as a video beside every call (typed text left out), kept for 7 days.

An app that talks to a backend on your machine reaches it through a tunnel (Node 22 or later):

```
simulator-use cloud tunnel 8080    # until Ctrl-C: the phone reaches localhost:8080 here, each request printed
```

The answer says the address the phone's apps use, such as `http://127.0.0.1:20199`; point the app there, for example with `run --env "API_URL=http://127.0.0.1:20199"`. Each request that passes is listed with its status and time (`cloud tunnel` without a port shows them over MCP). It lasts while the phone runs and comes back by itself after a dropped connection; `cloud tunnel` with port 0 closes it. While it is open, anything on the phone reaches that port: its apps, pages in its Safari and your project's build; nothing outside the phone does.

On GitHub, from any runner, with the result posted on each pull request and the screenshot and recording kept as artifacts:

```yaml
permissions:
  pull-requests: write
steps:
  - uses: actions/checkout@v5
  - uses: NoMac-app/simulator-use@v0.12
    with:
      api-key: ${{ secrets.NOMAC_API_KEY }}
```

It runs the simulator-use of its own tag (`@v0.12` runs what that tag holds; `version` picks another). `path` is the project's folder, `scheme` the scheme when the project has several, and `tests: false` skips the tests (a project without a test target fails otherwise: zero tests is not a pass). A cancelled run stops its phone, and a pull request from a fork, which gets no secrets, fails with that reason. A job's log and its pull request comment can be public, so in CI (`CI` or `GITHUB_ACTIONS` set) `cloud run` prints no link that opens without signing in: files it links are kept in the run's artifacts, and the replay's link is read with the account's key (`GET https://nomac.app/api/v1/simulator/sessions/{id}`, `links.replay`).

## Privacy

simulator-use sends nothing unless cloud mode is on. There is no telemetry and no network access at runtime: it runs `xcrun simctl`, the bundled AXe binary and `sips`, all on your Mac. With cloud on, it sends the project being run or tested, and the tools' calls, to NoMac, which keeps the session's replay for 7 days. The project is the git repository it is in, as the files git tracks or would track (what `.gitignore` leaves out stays on your machine), or its folder when it is in none; either way never build output, dependencies, editor state or key and credential files (`.env` files but their examples, `.p8`, `.p12`, `.pfx`, `.pem`, `.key`, provisioning profiles, keystores, SSH keys, `.netrc`), even when git tracks them.

## How it works

simulator-use reads the Simulator through a small native engine (`native/engine`), one process per Simulator, built on the frameworks of [AXe](https://github.com/cameroncooke/AXe) (MIT), which is bundled at a pinned version with its checksum checked at packaging, and through `xcrun simctl`. The engine keeps the Simulator's input, its accessibility session and its screen buffer open, so a tap takes a millisecond, a whole screen a few hundred, and a step waits until the pixels stop changing instead of a fixed time. It reads web views point by point. When the engine can't run, AXe does the same work one process per call. There is no test runner to build, so the first call is as fast as the rest.

## Develop

```sh
npm install
npm run axe        # fetch the pinned AXe into vendor/axe
npm run native     # build the engine and the clipboard helper into vendor/axe (IDB_HEADERS: idb's PrivateHeaders)
npm test           # node --test, no build needed
npm run build      # dist/ for the npm package
node bin/simulator-use.js look
```

The engine builds only with the Swift that built AXe's frameworks: for AXe 1.8.0, Swift 6.3.2, which is Xcode 26.5 (build 17F42), the Xcode releases are built with. `npm run native` checks the compiler first; with another Xcode selected, set `DEVELOPER_DIR` to Xcode 26.5's `Contents/Developer`. The build is reproducible: from a fresh clone of a release tag, in any folder, with Xcode 26.5, both binaries match the published package byte for byte, signature included. sha256, checked October 26, 2026:

| Release | `simulator-use-engine` | `simulator-use-pbset` |
|---|---|---|
| 0.12.0, 0.12.1 | `2bc4891ec8a2a92b26bd970066df46d55553ff1fdd682f3637a7645a1d9184ea` | `903d589b5d9b1a7763447472bc60a0f2dc971384a0ded6cd77782896d2da3f22` |
| 0.11.0 | `f65ccd92d5eadcfa9dc9065c66c0f71e9acd3f22282f94be5f977a7c919c7cc0` | `903d589b5d9b1a7763447472bc60a0f2dc971384a0ded6cd77782896d2da3f22` |

`examples/swiftui-demo` is the sample app the tests' screens come from. `scripts/golden.sh` builds it, runs it on a Simulator and checks 19 golden tasks: build and launch in one call, sign in, toggle, open an item, back and scroll, the app's logs, a crash, a build error and a failing test as `file:line`, a video, and a wrong password that must fail loudly.

`examples/edge-lab` is an app with every awkward screen: segments, steppers, sliders, menus, alerts, sheets, full-screen covers, permission prompts, text in any language, autocorrect, late content, toasts, swipe-to-delete, long press, a web view, UIKit and a deep link. `scripts/lab.sh` builds it and runs 26 checks on it.

`SIMULATOR_USE_DEBUG=1` prints every step and every program run with its time.

## Made at NoMac

simulator-use is built at [NoMac](https://nomac.app), where AI agents rent real Macs in the cloud to build, run and test Apple apps. It comes from thousands of agent runs on those Macs: where agents get stuck, what they misread on screen, and what they need to be told to keep going.

When simulator-use can't run where it is (no Mac, no Xcode, no Simulator runtime), its error names NoMac as a place to get one. It never shows when simulator-use works, and `SIMULATOR_USE_NO_CLOUD_HINT=1` hides it.

## License

MIT. AXe and the IDB frameworks it includes are MIT too; see `THIRD_PARTY_LICENSES`.
