Tokens: characters / 4 (no ANTHROPIC_API_KEY was set). Images: width * height / 750 after scaling to at most 2576 px on the long edge and about 4784 tokens.

| Tool | Mac | Sign-in flow (median) | Flow tokens | Flow ok | Read median | Read p90 | Read tokens | Tap median | Tap p90 | Tap reports change | Type median | Tool list tokens |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Xcode MCP Xcode 27.0, Build version 27A266a |  | 3.71 s | 12,732 | 10/10 | 102 ms | 110 ms | 2,410 | 672 ms | 775 ms | 20/20 | 1.13 s | 19,620 |
| simulator-use 0.14.0 |  | 4.66 s | 194 | 10/10 | 206 ms | 269 ms | 72 | 1.17 s | 1.24 s | 20/20 | 1.22 s | 2,443 |
| Argent 0.31.0 |  | 6.61 s | 7,129 | 10/10 | 204 ms | 229 ms | 658 | 647 ms | 682 ms | 19/20 | 3.59 s | 42,531 |
| agent-device 0.21.35 |  | 6.90 s | 664 | 10/10 | 56 ms | 60 ms | 131 | 878 ms | 1.24 s | 20/20 | 2.49 s | 47,406 |
| mobile-mcp 1.0.15 |  | 6.95 s | 980 | 10/10 | 417 ms | 458 ms | 375 | 767 ms | 772 ms | 0/20 | 2.52 s | 7,129 |
| simulator-use 0.14.0 |  | 7.13 s | 194 | 10/10 | 217 ms | 233 ms | 72 | 1.10 s | 1.14 s | 20/20 | 2.28 s | 2,443 |
| Maestro MCP 2.12.0 |  | 9.00 s | 2,987 | 10/10 | 113 ms | 121 ms | 1,107 | 1.59 s | 1.60 s | 0/20 | 3.68 s | 3,063 |
| AXe 1.8.0 |  | 9.14 s | 110,319 | 10/10 | 843 ms | 880 ms | 44,891 | 1.68 s | 1.82 s | 0/20 | 1.99 s | 0 |
| AXe 1.8.0 |  | 9.22 s | 110,319 | 10/10 | 836 ms | 900 ms | 44,869 | 1.67 s | 1.83 s | 0/20 | 1.98 s | 0 |
| MobileBuildMCP 2.7.1 |  | 18.1 s | 1,560 | 10/10 | 862 ms | 921 ms | 390 | 3.58 s | 3.73 s | 0/20 | 4.32 s | 6,193 |
| MobileBuildMCP 2.7.1 |  | 18.2 s | 1,560 | 10/10 | 823 ms | 911 ms | 390 | 3.55 s | 3.72 s | 0/20 | 4.51 s | 6,193 |
| AXe 1.8.0 |  | n/a | n/a | 0/10 | 844 ms | 926 ms | 44,891 | 1.86 s | 1.93 s | 0/4 | 3.36 s | 0 |
| MobileBuildMCP 2.7.1 |  | n/a | n/a | 0/10 | 850 ms | 905 ms | 390 | 3.71 s | 3.74 s | 0/3 | 5.97 s | 6,193 |

Batched flow (where the tool has a batch or sequence call):

| Tool | Batched flow (median) | Tokens | ok |
|---|---|---|---|
| simulator-use (Mac null) | 3.69 s | 179 | 10/10 |
| Argent (Mac null) | 4.38 s | 2,971 | 10/10 |
| agent-device (Mac null) | 5.98 s | 327 | 10/10 |
| mobile-mcp (Mac null) | 6.91 s | 1,029 | 10/10 |
| simulator-use (Mac null) | 5.36 s | 179 | 10/10 |
| Maestro MCP (Mac null) | 7.69 s | 2,885 | 10/10 |
| AXe (Mac null) | 4.56 s | 110,273 | 10/10 |
| AXe (Mac null) | 4.41 s | 110,273 | 10/10 |
| AXe (Mac null) | 6.87 s | 110,273 | 1/10 |

Failures:

- AXe tap (16x): the app logged no Sign In within 5 s
- AXe type (9x): the field did not show the typed text afterwards
- AXe flow (10x): final read did not show Welcome; app did not sign in
- AXe flowBatch (9x): final read did not show Welcome; app signed in
- MobileBuildMCP tap (17x): the app logged no Sign In within 5 s
- MobileBuildMCP type (9x): the field did not show the typed text afterwards
- MobileBuildMCP flow (10x): wait_for_ui failed: ⚙️ Wait for UI Recovery Code: WAIT_TIMEOUT Message: Timed out after 5000ms waiting for UI predicate 'textContains'. Timeout: 5000ms Hint: Inspect the latest runtime snapshot, adjust the wait selector, or retry later. ❌ T
