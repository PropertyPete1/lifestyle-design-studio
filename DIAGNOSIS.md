# Low-Views Diagnosis (live Metricool data, pulled Jul 1 2026)

Data: `/v2/analytics/reels/instagram` per brand, last 6 days.

## Main brand (lifestyledesignrealtytexas, blogId 4807109)
| Date/time (CDT-ish UTC) | views | reach | likes | shares | skipRate | note |
|---|---|---|---|---|---|---|
| 06-26 00:45 | 1829 | 1537 | 34 | 4 | 62.5 | manual "text HOME" |
| 06-27 01:13 | 533 | 431 | 11 | 0 | 76.1 | |
| 06-28 00:42 | 523 | 451 | 15 | 0 | 74.7 | |
| 06-28 01:12 | 1225 | 785 | 38 | 2 | 64 | "COMMENT SA + DM" |
| 06-28 23:57 | 4812 | 3975 | 150 | 75 | 60 | best performer |
| 06-29 23:57 | 1157 | 974 | 28 | 12 | 64 | |
| 06-30 23:11 | 466 | 393 | 7 | 2 | 69.7 | auto-post |
| 07-01 02:10 | 332 | 264 | 6 | 2 | 64.9 | auto-post |

## Secondary brands (propertypete01, austintx) — ALL under ~180 views
- propertypete01: 60–182 views across every reel (both manual and auto).
- austintx: 47–173 views across every reel.

## Findings
1. **The low-view problem is NOT primarily duplicate-fingerprinting.** The same reels get low views on the small brands regardless, and the big brand's own posts range from 332 to 4,812 — the spread tracks **audience size + hook strength + skip rate**, not byte-identity.
2. **skipRate is the dominant lever.** Top reel (4,812 views) had skipRate 60; the 332-view auto-post had 64.9; weak ones sit at 74–86. Instagram kills reach when people swipe away in the first seconds. Hook in first 1–2s matters most.
3. **Secondary brands are inherently small-audience** (100–180 views ceiling). Fan-out to all brands is correct for exposure, but their absolute numbers will stay low until followers grow. Judge auto-posts against the MAIN brand.
4. **Timing:** auto-posts are landing ~00:00–02:00 UTC = ~7–9 PM CDT, NOT the intended 2/3/4 PM CDT. Worth verifying the scheduler/Metricool publish time — evening posts may miss the target audience's peak.
5. Byte-uniqueness is still worth adding (cheap insurance against cross-account/cross-platform dedupe when the SAME file goes to 3 IG accounts + TikTok/YT/LinkedIn simultaneously), but it is a secondary factor, not the root cause.

## Action priorities (revised)
- P1: **Hook + skipRate**: caption/first-frame optimization; AI analyst should track skipRate and averageWatchTime, not just views.
- P1: **Verify posting time** actually lands at 2/3/4 PM CDT (evidence says evening). Fix if drifted.
- P2: **Byte-level differentiation** (serverless) so the identical file sent to 6 destinations isn't cross-flagged.
- P2: **Caption variation** per destination.
- Analyst compares each auto-post to the main brand's trailing median and flags high-skip / low-watch reels with concrete hypotheses.
