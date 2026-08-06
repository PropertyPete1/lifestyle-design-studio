#!/usr/bin/env node
/**
 * send-test-approval.mjs — one live topic_pick round-trip against the real
 * dashboard, with candidates nobody could mistake for a real brief.
 *
 * WHY THIS EXISTS. The poster was pointed at /api/delivery/webhook — the
 * DELIVERY endpoint — while the dashboard serves approvals from
 * /api/delivery/approval-webhook. That is a silent failure: the request goes
 * somewhere, a handler answers, and no approval card is ever raised. Peter gets
 * no push, the pipeline waits forever, and every scheduled run reports a
 * healthy "still waiting on Peter". Nothing short of a live round-trip would
 * have surfaced it.
 *
 * The candidates are prefixed [TEST] and say so in every field, because the
 * next thing that happens after Peter taps a pick is the pipeline writing a
 * real script from whatever he chose. Marking them makes the resulting
 * recording kit obviously a drill.
 *
 * Records the request in yt-approvals.json so the poll job can find it. The
 * workflow commits that file the same way every other managed file is
 * committed.
 */

import { requireLiveAck } from "./live-guard.mjs";
import { sendApprovalRequest, APPROVAL_WEBHOOK_PATH } from "../src/delivery.js";

// TOUCHES LIVE: posts to the real dashboard approval endpoint, which raises a
// real approval card and pushes a notification to Peter's phone, and records the
// request in yt-approvals.json. Candidates are prefixed [TEST] so the resulting
// recording kit is obviously a drill — but the card and the push are real.
requireLiveAck(
  "Raises a real approval card on the live dashboard and pushes a notification to Peter, " +
    "and writes the request into yt-approvals.json. Candidates are marked [TEST]."
);
import { getAccessToken } from "../src/drive.js";
import { briefPayload, renderBriefText } from "../src/yt-brief.js";
import {
  loadApprovals,
  saveApprovals,
  appendRequest,
  newRequestId,
  KIND_TOPIC_PICK,
} from "../src/yt-approvals.js";

/** Clearly a drill, in every field a human or a script might read. */
const TEST_CANDIDATES = [
  {
    title: "[TEST] Moving to San Antonio: what $300k actually gets you",
    intent: "relocation",
    market: "san_antonio",
    query: "moving to san antonio",
    hook: "This is a TEST card. Everyone quotes you the price; nobody quotes the number that decides it.",
    outline: "TEST — what $300k buys\nTEST — where it buys it\nTEST — the tax surprise\nTEST — what I'd do",
    why: "TEST CARD — sent to prove the approval round-trip works end to end. Not a real brief.",
    footage: "TEST — newer subdivisions, wide streets",
    proposedClips: [],
  },
  {
    title: "[TEST] Austin vs San Antonio: the honest cost comparison",
    intent: "comparison",
    market: "austin",
    query: "austin vs san antonio",
    hook: "This is a TEST card. The gap is not where people think it is.",
    outline: "TEST — housing\nTEST — taxes\nTEST — commute\nTEST — the verdict",
    why: "TEST CARD — sent to prove the approval round-trip works end to end. Not a real brief.",
    footage: "TEST — city skylines, suburbs",
    proposedClips: [],
  },
  {
    title: "[TEST] New construction under $300k in San Antonio",
    intent: "new_build",
    market: "san_antonio",
    query: "new construction under 300k san antonio",
    hook: "This is a TEST card. There is a catch, and it is not the finish quality.",
    outline: "TEST — what exists\nTEST — where\nTEST — the catch\nTEST — worth it?",
    why: "TEST CARD — sent to prove the approval round-trip works end to end. Not a real brief.",
    footage: "TEST — spec home walkthrough",
    proposedClips: [],
  },
];

async function main() {
  const dashboardUrl = process.env.DASHBOARD_URL;
  if (!dashboardUrl || !process.env.DASHBOARD_WEBHOOK_SECRET) {
    throw new Error("DASHBOARD_URL / DASHBOARD_WEBHOOK_SECRET not set — cannot round-trip");
  }

  const requestId = newRequestId(KIND_TOPIC_PICK);
  const brief = { candidates: TEST_CANDIDATES };
  const payload = briefPayload(brief, { requestId });

  console.log("LIVE APPROVAL ROUND-TRIP");
  console.log(`  endpoint: ${dashboardUrl}${APPROVAL_WEBHOOK_PATH}`);
  console.log(`  requestId: ${requestId}`);
  console.log(`  candidates: ${TEST_CANDIDATES.length}, all prefixed [TEST]`);
  console.log("");

  const accessToken = await getAccessToken().catch((err) => {
    console.warn(`  no Google token, email channel unavailable: ${err.message}`);
    return null;
  });

  const result = await sendApprovalRequest({
    requestId,
    kind: KIND_TOPIC_PICK,
    payload,
    emailSubject: "[TEST] Approval round-trip — pick any one",
    emailBody:
      "This is a TEST of the approval flow. The three options are not real briefs.\n\n" +
      "Tap any one of them. What is being checked is that your pick comes back with the\n" +
      "selection field attached, and that the pipeline acts on it exactly once.\n\n" +
      renderBriefText(brief, { requestId }),
    accessToken,
  });

  console.log(`  delivered via: ${result.channels.join(" + ")}`);

  // Recorded only after the send succeeded — a record claiming we are waiting
  // on a request that never went out would stall the pipeline for nothing.
  saveApprovals(appendRequest(loadApprovals(), { requestId, kind: KIND_TOPIC_PICK, payload }));
  console.log(`  recorded in yt-approvals.json`);
  console.log("");
  console.log(`REQUEST_ID=${requestId}`);
}

main().catch((err) => {
  console.error(`\nROUND-TRIP SEND FAILED: ${err?.stack || err}`);
  process.exit(1);
});
