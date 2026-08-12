/**
 * edit-queue-gates.js — the two questions that decide whether anything happens.
 *
 * SEPARATE FROM edit-queue-advance.js FOR A MECHANICAL REASON, not a stylistic
 * one: that module is an entry point and calls `main()` at the bottom, so
 * importing it to borrow a predicate would run the whole advance job as a side
 * effect of the import. The pre-check script needs exactly these two functions
 * and must not start an edit to get them, which is the same sentence this
 * feature is built around.
 *
 * Both are pure over (approvals, requestId), which also makes them the natural
 * place to argue with the idempotency rules in a test — double presses, a
 * rejection followed by an approval on the same card, a decision that was
 * already consumed by an earlier run.
 */

import { findRequest, hasActed, hasDecision, isApproved } from "./yt-approvals.js";

/**
 * Approved, and nobody has acted on it. The only thing that starts an edit.
 *
 * LOOKED UP BY REQUEST ID rather than through `decisionState`, and the
 * difference is load-bearing. `decisionState` answers "what is the state of the
 * newest card of this kind" — right for long-form, where one weekly
 * conversation is in flight at a time, and wrong here: Peter can have four
 * videos queued at once, and taking the newest would silently ignore the other
 * three. Every queue record carries its own requestId precisely so this can be
 * a lookup rather than a guess.
 *
 * BOTH CONJUNCTS ARE THE FEATURE.
 *
 *   `isApproved`  — nothing but an explicit approval counts. A missing
 *                   decision, an unrecognised string, `true`, `1` and
 *                   "approve-ish" are all "no". This is what makes a scheduled
 *                   run incapable of starting an edit: with no decision there
 *                   is nothing here that returns true.
 *   `!hasActed`   — the double-press latch. The advance job polls, so it will
 *                   read the same approval on every run until the acted marker
 *                   lands; and Peter tapping Start twice writes one decision
 *                   against one requestId, not two.
 */
export function approvedAndUnacted(approvals, requestId) {
  const record = findRequest(approvals, requestId);
  return Boolean(record) && isApproved(record) && !hasActed(record);
}

/**
 * Decided either way, and unacted.
 *
 * A rejection is as actionable as an approval here — it starts a re-edit — so
 * this is deliberately weaker than the gate above. It is still a gate: no
 * decision means no work, which is what stops a review card from being
 * re-processed on every poll for as long as it sits unanswered.
 */
export function decidedAndUnacted(approvals, requestId) {
  const record = findRequest(approvals, requestId);
  return Boolean(record) && hasDecision(record) && !hasActed(record);
}
