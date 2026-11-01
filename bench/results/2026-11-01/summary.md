Tokens: characters / 4 (no ANTHROPIC_API_KEY was set). Images: width * height / 750 after scaling to at most 2576 px on the long edge and about 4784 tokens.

| Tool | Mac | Sign-in flow (median) | Flow tokens | Flow ok | Read median | Read p90 | Read tokens | Tap median | Tap p90 | Tap reports change | Type median | Tool list tokens |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| simulator-use 0.15.0 |  | 3.43 s | 194 | 10/10 | 223 ms | 259 ms | 72 | 649 ms | 675 ms | 20/20 | 1.04 s | 2,443 |
| simulator-use 0.15.0 |  | 3.50 s | 194 | 10/10 | 191 ms | 249 ms | 72 | 683 ms | 811 ms | 20/20 | 1.14 s | 2,443 |
| Xcode MCP Xcode 27.0, Build version 27A266a |  | 3.58 s | 12,732 | 10/10 | 92 ms | 94 ms | 2,410 | 706 ms | 773 ms | 20/20 | 1.13 s | 19,620 |
| AXe 1.8.0 |  | 5.91 s | 130,766 | 10/10 | 617 ms | 732 ms | 55,106 | 1.09 s | 1.28 s | 0/20 | 1.32 s | 0 |
| Argent 0.31.0 |  | 6.63 s | 7,129 | 10/10 | 194 ms | 210 ms | 658 | 659 ms | 742 ms | 20/20 | 3.58 s | 42,531 |
| agent-device 0.21.35 |  | 6.85 s | 664 | 10/10 | 49 ms | 54 ms | 131 | 884 ms | 1.26 s | 20/20 | 2.48 s | 47,406 |
| mobile-mcp 1.0.15 |  | 6.97 s | 981 | 10/10 | 417 ms | 421 ms | 375 | 771 ms | 785 ms | 0/20 | 2.52 s | 7,129 |
| Maestro MCP 2.12.0 |  | 9.19 s | 2,987 | 10/10 | 129 ms | 138 ms | 1,116 | 1.58 s | 1.60 s | 0/20 | 3.62 s | 3,063 |
| AXe 1.8.0 |  | 9.21 s | 110,319 | 10/10 | 858 ms | 922 ms | 44,869 | 1.72 s | 1.88 s | 0/20 | 1.98 s | 0 |
| MobileBuildMCP 2.7.1 |  | 12.3 s | 1,561 | 10/10 | 616 ms | 695 ms | 386 | 2.37 s | 2.45 s | 0/20 | 3.15 s | 6,193 |
| MobileBuildMCP 2.7.1 |  | 18.0 s | 1,560 | 10/10 | 838 ms | 900 ms | 390 | 3.44 s | 3.58 s | 0/20 | 4.31 s | 6,193 |
| AXe 1.8.0 |  | n/a | n/a | 0/10 | 854 ms | 892 ms | 44,891 | 1.98 s | 2.01 s | 0/6 | 4.46 s | 0 |
| MobileBuildMCP 2.7.1 |  | n/a | n/a | 0/10 | 621 ms | 722 ms | 390 | 2.63 s | 2.83 s | 0/9 | 6.00 s | 6,193 |

Batched flow (where the tool has a batch or sequence call):

| Tool | Batched flow (median) | Tokens | ok |
|---|---|---|---|
| simulator-use (Mac null) | 2.74 s | 179 | 10/10 |
| simulator-use (Mac null) | 2.87 s | 179 | 10/10 |
| AXe (Mac null) | 2.57 s | 130,720 | 9/10 |
| Argent (Mac null) | 4.37 s | 2,971 | 10/10 |
| agent-device (Mac null) | 5.99 s | 327 | 10/10 |
| mobile-mcp (Mac null) | 6.97 s | 1,030 | 10/10 |
| Maestro MCP (Mac null) | 7.56 s | 2,885 | 10/10 |
| AXe (Mac null) | 4.63 s | 110,273 | 8/10 |
| AXe (Mac null) | 8.23 s | 110,273 | 1/10 |

Failures:

- AXe flowBatch (1x): final read did not show Welcome; app did not sign in
- AXe flowBatch (2x): final read did not show Welcome; app did not sign in
- AXe tap (14x): the app logged no Sign In within 5 s
- AXe type (7x): the field did not show the typed text afterwards
- AXe flow (10x): final read did not show Welcome; app did not sign in
- AXe flowBatch (9x): final read did not show Welcome; app signed in
- MobileBuildMCP tap (11x): the app logged no Sign In within 5 s
- MobileBuildMCP type (3x): the field did not show the typed text afterwards
- MobileBuildMCP flow (10x): wait_for_ui failed: ⚙️ Wait for UI Recovery Code: WAIT_TIMEOUT Message: Timed out after 5000ms waiting for UI predicate 'textContains'. Timeout: 5000ms Hint: Inspect the latest runtime snapshot, adjust the wait selector, or retry later. ❌ T
