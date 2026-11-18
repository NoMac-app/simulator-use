| Step | A median | A p90 | B median | B p90 | B vs A | A checks | B checks |
|---|---|---|---|---|---|---|---|
| read | 0.17 s | 0.22 s | 0.15 s | 0.20 s | -11% | 40/40 | 40/40 |
| tap | 0.50 s | 0.59 s | 0.50 s | 0.64 s | 0% | 40/40 | 40/40 |
| fill | 2.39 s | 2.47 s | 2.43 s | 2.47 s | 2% | 20/20 | 20/20 |
| sign-in, step by step | 5.39 s | 5.71 s | 5.43 s | 5.71 s | 1% | 20/20 | 20/20 |
| sign-in, batched | 4.58 s | 4.82 s | 4.56 s | 4.86 s | 0% | 20/20 | 20/20 |

Per round (median), in run order:
round | build | started | read | tap | fill | sign-in, step by step | sign-in, batched
1 | A | 23:25:13 | 0.18 s | 0.51 s | 2.29 s | 5.38 s | 4.50 s
1 | B | 23:30:44 | 0.12 s | 0.51 s | 2.42 s | 5.36 s | 4.57 s
2 | B | 23:36:04 | 0.17 s | 0.50 s | 2.45 s | 5.51 s | 4.52 s
2 | A | 23:41:24 | 0.17 s | 0.48 s | 2.45 s | 5.44 s | 4.60 s
