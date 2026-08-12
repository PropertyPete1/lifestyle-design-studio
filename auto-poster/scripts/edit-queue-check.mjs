#!/usr/bin/env node
/**
 * edit-queue-check.mjs — is there anything for the advance job to do?
 *
 * Answered from committed files alone: no Drive call, no Google token, no
 * network. That is what makes it cheap enough to run on every poll, and the
 * point of running it is that the advance job is expensive to prepare — ffmpeg,
 * a pip install of Whisper, and a couple of minutes of runner time before it
 * has done anything at all.
 *
 * The overwhelming majority of polls have no decision waiting. Paying two
 * minutes of setup twelve times a day to discover that is how a feature that
 * costs nothing to use ends up costing more than the pipeline it serves.
 *
 * Writes `has_work=true|false` to $GITHUB_OUTPUT, and prints why either way —
 * a poll that decided to do nothing should say what it looked at.
 */

import { appendFileSync } from "node:fs";

import { loadApprovals } from "../src/yt-approvals.js";
import { awaitingReview, awaitingStart, loadQueue, reclaimStale, summarise } from "../src/edit-queue.js";
import { approvedAndUnacted, decidedAndUnacted } from "../src/edit-queue-gates.js";

const queue = loadQueue();
const approvals = loadApprovals();

const starts = awaitingStart(queue).filter((v) => approvedAndUnacted(approvals, v.queueRequestId));
const reviews = awaitingReview(queue).filter((v) => decidedAndUnacted(approvals, v.reviewRequestId));

// A stale lease is work too: the record has to be turned into a visible failure,
// and that is the one path out of a wedged `editing` record.
const { reclaimed } = reclaimStale(queue);

const hasWork = starts.length > 0 || reviews.length > 0 || reclaimed.length > 0;

console.log(`[EditQueueCheck] queue: ${summarise(queue)}`);
console.log(
  `[EditQueueCheck] ${starts.length} start decision(s), ${reviews.length} review decision(s), ` +
    `${reclaimed.length} stale lease(s) — has_work=${hasWork}`
);
if (!hasWork) {
  console.log(`[EditQueueCheck] Nothing has been pressed since the last run. The schedule alone never starts an edit.`);
}

if (process.env.GITHUB_OUTPUT) {
  appendFileSync(process.env.GITHUB_OUTPUT, `has_work=${hasWork}\n`);
}
