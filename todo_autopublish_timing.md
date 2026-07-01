# Auto-Publish Timing + Auto-Confirm Fix — RESOLVED

## Part 1 — Timing (already fixed earlier)
The posting AGENT cron ("Daily IG Reels Auto-Poster", taskUid he5uIWQiFJljmBdqvGrXLD)
was firing at 7/8/9 PM CT. Corrected to `0 0 14,15,16 * * *` in America/Chicago
(2 PM San Antonio / 3 PM Austin / 4 PM Dallas), DST-safe. Verified persisted.

## Part 2 — Auto-Confirm (this fix)
Root cause of "nothing posts": `ensureTodayPicks` created picks with
`status: "pending"`, and the ONLY path that moved them to `status: "confirmed"`
was the user tapping Confirm in the app. The posting agent's
`getDueConfirmedPickForCity` / `dueForPublishHandler` only return picks with
`status = "confirmed"`. So with no manual tap, the 2/3/4 PM agent found
`{ due: false }` and posted nothing.

### Changes
- [x] New `db.autoConfirmPick(pick)` helper: creates the repost history row
      (status=confirmed) and flips the daily pick to status=confirmed with its
      repostId set. Idempotent (no-ops when status !== "pending").
- [x] `ensureTodayPicks` now auto-confirms every pending pick right after
      generation — so picks are confirmed the moment they exist, with zero taps.
- [x] `picks.confirm` tRPC mutation refactored to delegate to the same helper
      (manual tap still works, now a graceful no-op if already confirmed).
- [x] New `/api/scheduled/generatePicks` endpoint: proactively generates +
      auto-confirms today's picks so they always exist BEFORE the posting window,
      even if nobody opens the app that morning.
- [x] UI copy updated: header says posting is fully automatic; status badge for
      confirmed reads "Auto-scheduled"; locked card says it publishes
      automatically with no action needed.
- [x] Tests: added auto-confirm coverage; 87/87 pass; 0 TypeScript errors.

## Remaining ops step (outside code)
- [ ] After deploy: register a morning Heartbeat cron (~8 AM CT,
      `0 0 13 * * *` UTC) hitting `/api/scheduled/generatePicks` so picks are
      guaranteed present before 2 PM.

## Result (once deployed + morning cron registered)
1. ~8 AM CT: morning cron generates and AUTO-CONFIRMS the day's picks.
2. 2 PM CT: agent publishes San Antonio (due, confirmed).
3. 3 PM CT: agent publishes Austin.
4. 4 PM CT (Dallas days): agent publishes Dallas.
All fully automatic — no manual confirmation anywhere in the loop.
