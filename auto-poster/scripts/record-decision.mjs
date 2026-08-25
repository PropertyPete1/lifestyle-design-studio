#!/usr/bin/env node
/**
 * record-decision.mjs — record a decision the dashboard failed to write back.
 *
 * The dashboard is the channel of record for Peter's answers: it commits the
 * decision onto yt-approvals.json. On 2026-08-19 it silently dropped one — he
 * answered the Aug 17 topic card, no commit ever landed, and the pipeline read
 * "waiting on Peter" for a week while every run stayed green. The recovery was
 * a by-hand edit of state on main.
 *
 * This is that recovery as a dispatchable job: the record-decision job in
 * youtube-longform.yml runs it with Peter's inputs, applyManualDecision
 * refuses everything a typo could get wrong, and merge-log-push commits the
 * result exactly like every other state write. The next scheduled pipeline
 * run acts on the decision within hours — or dispatch the pipeline job to act
 * on it now.
 *
 * THIS DECIDES NOTHING ITSELF. It writes the decision Peter states, for a
 * card that verifiably has none, and it will not overwrite one that exists.
 * Inputs via env (the workflow's dispatch form): REQUEST_ID, DECISION,
 * SELECTION, DECISION_NOTES.
 */

import { loadApprovals, saveApprovals, applyManualDecision, findRequest } from "../src/yt-approvals.js";
import { routeWarnChannel } from "../src/yt-evidence.js";
// The Actions log drops the warn channel entirely (proven on two preserved
// runs) — route it to stdout at every entrypoint. See yt-evidence.js.
routeWarnChannel();

const requestId = (process.env.REQUEST_ID || "").trim();
const decision = (process.env.DECISION || "").trim();
const selection = (process.env.SELECTION || "").trim() || null;
const notes = (process.env.DECISION_NOTES || "").trim() || null;

if (!requestId) {
  console.error("[RecordDecision] REQUEST_ID is required — the id from the nudge mail or yt-approvals.json");
  process.exit(1);
}

const approvals = loadApprovals();
const result = applyManualDecision(approvals, { requestId, decision, selection, notes });

if (!result.ok) {
  console.error(`[RecordDecision] REFUSED: ${result.reason}`);
  process.exit(1);
}

saveApprovals(result.log);

const record = findRequest(result.log, requestId);
console.log(`[RecordDecision] ${requestId} → ${record.decision}${record.selection ? ` (selection ${record.selection})` : ""}${record.notes ? ` — notes recorded` : ""}`);
console.log(
  `[RecordDecision] the next scheduled pipeline run acts on this within hours; ` +
  `dispatch the pipeline job to act on it now.`
);
