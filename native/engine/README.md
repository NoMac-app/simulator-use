# simulator-use engine (prototype)

One long-lived process per booted Simulator. It loads CoreSimulator's private frameworks, the HID connection,
the accessibility translator and the framebuffer once, then answers JSON requests, one per line on stdin, with
one JSON answer per line on stdout. Built on the FBSimulatorControl frameworks AXe ships (MIT; AXe by Cameron
Cooke, FBSimulatorControl from Meta's idb), AXe 2.0.4's since November 16, 2026 (1.8.0's before).
`TextToHIDEvents.swift` and `KeyCode.swift` are AXe's, unchanged (identical in 1.8.0 and 2.0.4). Requests are read
from stdin on a thread of their own and run one at a time on the main actor, which never blocks between them:
FBSimulatorControl 2's actors and the signal handlers need it free. The ready line names the read path (`reads`:
`session`, `axe`, or `per-call` when the bootstrap hook could not be installed) and the HID transport (`hid`); every
answer counts the accessibility loads (`bootstraps`) and automation sessions opened (`sessions`).

Ops: `describe` (whole screen, AXe's JSON), `point` {x,y}, `tap` {x,y}, `swipe`, `type` {text}, `home`,
`screenshot` {width,height,quality,path|inline; png_path: the full-size PNG, alpha removed}, `settle` {quiet_ms,first_change_ms}, `tap_settle_describe`,
`tap_trace`, `stream` {codec h264|hevc, transport annexb|fmp4|mpegts, fps, scale, bitrate, seconds, path or fd}. With `fd`,
the video goes to a descriptor the parent holds (a live view starts a `--no-bootstrap` engine and reads its stdout after
the ready line); `seconds: 0` streams until the reader goes, and the engine then ends.

Measured October 21, 2026 on an Apple M6 Mac mini (iOS 27.0 runtime), against AXe 1.8.0 with one process per call:

| | AXe per call | engine |
|---|---|---|
| tap | 2.1 to 3.2 s | about 1 ms to send |
| whole-screen read | 1.6 to 1.8 s | 250 to 300 ms |
| read at a point | 0.45 to 0.5 s | 4 to 5 ms |
| screenshot (JPEG at points) | about 250 ms | 60 to 115 ms |
| tap, wait until the screen is still, read | 3.6 to 7.2 s (simulator-use act) | 1.2 s p50 (0.75 s of it is iOS's own animation) |

What makes that possible:
- **One automation session per phone, kept open.** iOS 27 Simulators read accessibility only after an XCTest
  "remote automation session" has loaded it. FBSimulatorControl, unless told otherwise, opens a session, loads
  accessibility and closes the session before every request (AXe 1.8 paid about 1 to 2 s for that per call); in a
  long-lived process new sessions soon time out. The engine opens one session, keeps it, and reloads accessibility
  on it when the frontmost app reads empty (`forceBootstrap`). It closes the session when its input ends and waits
  0.8 s for that to reach the phone: without the wait, the next process could not open a session at all. A new
  engine's first read takes 0.5 to 1.25 s; after that a point read takes 3 to 15 ms and a whole screen 80 to 300 ms.
  `scripts/engine-check.mjs` (run by `scripts/lab.sh`) fails when reads pay a session each.
- **Kept over AXe 2.0's own way, on numbers** (`bench/results/2026-11-16-axe-2`). AXe 2.0 reads with no session
  (`bootstrap: false`) and loads accessibility through a short-lived session (0.42 s) only when a read comes back
  empty. That is faster on a screen already read (through simulator-use, 0.13 against 0.18 s a read and 0.54 against
  0.63 s a tap; at the engine, about 70 against 90 ms), but without a kept session every app launched since the last
  load reads empty: its first read took about 2 s against 0.6 s, and the sign-in flows 19 and 46% longer (4.26 and
  4.46 s against 3.58 and 3.06 s). `SIMULATOR_USE_ENGINE_READS=axe` (or `--reads axe`) still reads AXe 2.0's
  way, its short-lived sessions under the same lock and gap as the kept one.
- **Input through `connectToHID`** (FBSimulatorControl's Indigo transport, the same as before): a tap's call returns
  at once and the screen first changes about 13 ms later. AXe 2.0's `FBSimulatorHIDSession` (one screen bound, the
  target checked before input: what a foldable needs) took 430 to 460 ms a tap on an iPhone 17 Pro.
- **Never restart CoreSimulatorService under booted phones:** their automation sessions then time out until each
  phone is rebooted. A host also needs `automationmodetool enable-automationmode-without-authentication` once.
- **"Settled" is read from the screen buffer**, not from repeated tree reads: the IOSurface seed changes on every
  write. After an input the engine waits up to 500 ms for the first change, then for 150 ms without one.
- **One engine per phone, for its life.** A second engine process on a phone booted a few minutes earlier cannot
  open an automation session (12 of 12 failed on the M6), so a slow request must never end the engine:
  simulator-use gives the caller a busy answer and the engine finishes (its late answer is read and dropped).
- **Web pages are read point by point.** A WKWebView's or Safari's page is drawn by its own web process: the app's
  tree holds only an empty scroll area there, and FBSimulatorControl's remote-content phase skips it (the area's
  own frame counts as covered). Every read sweeps such an area with point reads (five columns, jumping past each
  element found; 2.5 s budget, `web_budget_ms`, `web: false` to skip) and adds the page's elements under it,
  reused while the IOSurface seed is unchanged. A page's text comes in `AXValue`. Safari's first read of a page
  takes 15 to 30 s; part of a Safari page can stay hidden behind a full-screen group (best effort).

Video: `stream` uses the Mac's hardware encoder (H.264 or HEVC, Annex B, fragmented MP4 or MPEG-TS): about
1.1 to 1.4 Mbit/s at 30 fps and half resolution, first data after 39 to 245 ms, 7% of one core.

`bench/` holds the scripts behind every number (T7 density, T13 clone start, T14 volumes, the act and stream tests).
