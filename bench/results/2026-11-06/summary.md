Tokens: characters / 4 (no ANTHROPIC_API_KEY was set). Images: width * height / 750 after scaling to at most 2576 px on the long edge and about 4784 tokens.

| Tool | Mac | Sign-in flow (median) | Flow tokens | Flow ok | Read median | Read p90 | Read tokens | Tap median | Tap p90 | Tap reports change | Type median | Tool list tokens |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| ios-simulator-mcp 2.2.0 |  | 2.08 s | 5,248 | 10/10 | 230 ms | 594 ms | 891 | 205 ms | 265 ms | 0/18 | 409 ms | 2,655 |
| simulator-use 0.15.1 |  | 4.14 s | 194 | 10/10 | 303 ms | 397 ms | 72 | 681 ms | 696 ms | 20/20 | 1.26 s | 2,443 |
| Xcode MCP Xcode 27.0, Build version 27A266a |  | 4.18 s | 12,732 | 10/10 | 139 ms | 149 ms | 2,398 | 717 ms | 784 ms | 20/20 | 1.14 s | 19,620 |
| simulator-use 0.15.1 |  | 4.28 s | 194 | 10/10 | 303 ms | 406 ms | 72 | 716 ms | 833 ms | 20/20 | 1.21 s | 2,443 |
| AXe 1.8.0 |  | 5.94 s | 130,766 | 10/10 | 1.02 s | 1.98 s | 55,077 | 975 ms | 1.19 s | 0/19 | 1.10 s | 0 |
| mobile-mcp 1.0.16 |  | 6.32 s | 980 | 10/10 | n/a | n/a | n/a | 547 ms | 557 ms | 0/20 | 2.32 s | 7,169 |
| mobile-mcp 1.0.16 |  | 6.32 s | 980 | 10/10 | 192 ms | 198 ms | 375 | 552 ms | 557 ms | 0/20 | 2.31 s | 7,169 |
| mobile-mcp 1.0.16 |  | 6.37 s | 980 | 10/10 | n/a | n/a | n/a | 549 ms | 559 ms | 0/20 | 2.32 s | 7,169 |
| Argent 0.32.0 |  | 6.98 s | 7,061 | 10/10 | 205 ms | 246 ms | 658 | 941 ms | 1.49 s | 20/20 | 3.83 s | 44,045 |
| agent-device 0.21.36 |  | 7.62 s | 664 | 10/10 | 76 ms | 86 ms | 131 | 1.31 s | 1.32 s | 20/20 | 2.59 s | 47,544 |
| AXe 1.8.0 |  | 9.03 s | 110,336 | 10/10 | 1.47 s | 2.24 s | 44,891 | 1.54 s | 1.57 s | 0/20 | 1.71 s | 0 |
| Maestro MCP 2.12.1 |  | 10.2 s | 2,987 | 10/10 | 158 ms | 184 ms | 1,116 | 1.70 s | 1.73 s | 0/20 | 4.00 s | 3,063 |
| MobileBuildMCP (formerly XcodeBuildMCP) 2.7.1 |  | 12.2 s | 1,561 | 10/10 | 1.06 s | 1.77 s | 390 | 2.14 s | 2.17 s | 0/20 | 2.94 s | 6,193 |
| MobileBuildMCP (formerly XcodeBuildMCP) 2.7.1 |  | 17.6 s | 1,560 | 10/10 | 1.52 s | 2.52 s | 390 | 3.30 s | 3.39 s | 0/20 | 4.06 s | 6,193 |
| AXe 1.8.0 |  | n/a | n/a | 0/10 | 757 ms | 1.18 s | 55,106 | n/a | n/a | 0/0 | n/a | 0 |
| MobileBuildMCP (formerly XcodeBuildMCP) 2.7.1 |  | n/a | n/a | 0/10 | 1.27 s | 1.79 s | 390 | n/a | n/a | 0/0 | n/a | 6,193 |

Batched flow (where the tool has a batch or sequence call):

| Tool | Batched flow (median) | Tokens | ok |
|---|---|---|---|
| simulator-use (Mac null) | 3.47 s | 179 | 10/10 |
| simulator-use (Mac null) | 3.62 s | 179 | 10/10 |
| AXe (Mac null) | 2.90 s | 130,720 | 1/10 |
| mobile-mcp (Mac null) | 6.29 s | 1,029 | 10/10 |
| mobile-mcp (Mac null) | 6.25 s | 1,029 | 10/10 |
| mobile-mcp (Mac null) | 6.34 s | 1,029 | 10/10 |
| Argent (Mac null) | 4.59 s | 2,903 | 10/10 |
| agent-device (Mac null) | 6.72 s | 327 | 10/10 |
| AXe (Mac null) | 4.45 s | 110,290 | 2/10 |
| Maestro MCP (Mac null) | 8.67 s | 2,885 | 10/10 |
| AXe (Mac null) | n/a | n/a | 0/10 |

Failures:

- ios-simulator-mcp tap (2x): could not read before the tap: the read did not show the Sign In screen
- AXe read (3x): axe describe-ui --udid 47F941AC-796F-469E-A2BA-8AAF81A1B7FE exited 1: Error: Timed out creating the simulator remote automation session 
- AXe tap (1x): could not read before the tap: the read did not show the Sign In screen
- AXe flowBatch (9x): final read did not show Welcome; app did not sign in
- mobile-mcp read (20x): the read did not show the Sign In screen
- mobile-mcp read (20x): the read did not show the Sign In screen
- AXe flowBatch (8x): final read did not show Welcome; app did not sign in
- MobileBuildMCP (formerly XcodeBuildMCP) read (2x): snapshot_ui failed: 📷 Snapshot UI Errors (1): ✗ Timed out creating the simulator remote automation session ❌ Failed to get accessibility hierarchy. 
- AXe read (2x): axe describe-ui --udid 47F941AC-796F-469E-A2BA-8AAF81A1B7FE exited 1: Error: Timed out creating the simulator remote automation session 
- AXe tap (20x): the app logged no Sign In within 5 s
- AXe type (10x): the field did not show the typed text afterwards
- AXe flow (10x): final read did not show Welcome; app did not sign in
- AXe flowBatch (10x): final read did not show Welcome; app signed in
- MobileBuildMCP (formerly XcodeBuildMCP) tap (20x): the app logged no Sign In within 5 s
- MobileBuildMCP (formerly XcodeBuildMCP) type (10x): the field did not show the typed text afterwards
- MobileBuildMCP (formerly XcodeBuildMCP) flow (10x): wait_for_ui failed: ⚙️ Wait for UI Recovery Code: WAIT_TIMEOUT Message: Timed out after 5000ms waiting for UI predicate 'textContains'. Timeout: 5000ms Hint: Inspect the latest runtime snapshot, adjust the wait selector, or retry later. ❌ T
