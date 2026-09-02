#!/usr/bin/env node
/**
 * reconcile-waiting.mjs — the cheap half of the Decision Reconcile sweep.
 *
 * The sweep runs hourly so a card the dashboard is not showing gets flagged
 * within about two hours instead of the 23 it took on 2026-08-31. Most hours
 * nothing is waiting, and launching Chromium to confirm that is a two-minute
 * job for a no-op. So the workflow asks THIS first — it needs only the
 * checked-out yt-approvals.json — and installs the browser only when the
 * answer is yes.
 *
 * Same predicate the sweep itself uses (waitingRecords, with its grace), so
 * the two halves cannot disagree about what "waiting" means.
 */
import { appendFileSync } from "node:fs";
import { loadApprovals } from "../src/yt-approvals.js";
import { waitingRecords, RECONCILE_GRACE_HOURS } from "../src/yt-stall-nudge.js";

const waiting = waitingRecords(loadApprovals());
const ids = waiting.map((r) => r.requestId);

if (ids.length > 0) {
  console.log(`[Reconcile] waiting past the ${RECONCILE_GRACE_HOURS}h grace: ${ids.join(", ")} — sweeping the dashboard`);
} else {
  console.log(`[Reconcile] nothing is waiting on Peter past the ${RECONCILE_GRACE_HOURS}h grace — the browser sweep is skipped`);
}

if (process.env.GITHUB_OUTPUT) {
  appendFileSync(process.env.GITHUB_OUTPUT, `waiting=${ids.length > 0 ? "true" : "false"}\nids=${ids.join(",")}\n`);
}
