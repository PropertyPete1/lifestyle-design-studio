/**
 * yt-approvals.js — the poster's half of the dashboard approval channel.
 *
 * Two parties write to yt-approvals.json and neither can see the other's
 * process:
 *
 *   the poster    appends a REQUEST when it asks for a decision, and an ACTED
 *                 marker once it has acted on one.
 *   the dashboard appends a DECISION when Peter presses a button, and commits.
 *
 * Every record is keyed by `requestId`, and the three parts live on the same
 * record because they describe one conversation. They are written at different
 * times by different processes, so the merge strategy has to keep all three
 * (see mergeYtApprovals in merge-strategies.mjs) — this module is what produces
 * the shapes that merge relies on.
 *
 * TWO RULES DRIVE THE WHOLE DESIGN:
 *
 * 1. Only an explicit "approve" publishes. Not a missing decision, not an
 *    unrecognised string, not a truthy-looking value. Anything that is not
 *    exactly an approval is treated as "not approved", and any notes attached
 *    to it become regeneration guidance. The failure mode this protects against
 *    is publishing a video Peter never looked at, which is the one failure the
 *    whole manual-review design exists to prevent.
 *
 * 2. A requestId is acted on at most once. The build job runs on a schedule and
 *    retries, so it will read the same approved decision several times. Without
 *    the acted marker, a decision approved on Friday would publish again on
 *    every subsequent scheduled run.
 *
 * Reads are defensive throughout. A corrupt or missing file degrades to "no
 * approvals", which means "nothing is approved" — the safe direction. It must
 * never mean "proceed".
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { randomUUID } from "crypto";

import { capRequests } from "./approvals-retention.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const YT_APPROVALS_PATH = join(ROOT, "yt-approvals.json");

/** The only decision value that may publish anything. */
export const APPROVE = "approve";

/** Request kinds the poster knows how to raise. */
export const KIND_TOPIC_PICK = "topic_pick";
export const KIND_VIDEO_REVIEW = "video_review";

/**
 * The reels manual edit queue's two card types.
 *
 * NEW KINDS RATHER THAN A REUSE OF THE TWO ABOVE, and the reason is a hard
 * requirement rather than tidiness. `decisionState` reads the NEWEST request of
 * a kind, and yt-pipeline-main.js calls it with no further filter — so an edit
 * queue card raised as `video_review` would become the record the long-form
 * pipeline believes is its own video review. Peter approving an edited reel
 * would publish a YouTube video. A distinct kind makes that impossible by
 * construction: `latestRequestOfKind` filters on equality, so these records are
 * invisible to every long-form call site without one line of long-form code
 * changing.
 *
 * They ARE in `KINDS`, because `appendRequest` validates against it and would
 * otherwise throw on every card this feature raises. Being an accepted kind and
 * being visible to a long-form lookup are different things: the first is this
 * list, the second is an equality filter on `kind`.
 */
export const KIND_REEL_EDIT = "reel_edit";
export const KIND_REEL_REVIEW = "reel_review";

/** Every kind `appendRequest` will accept. */
export const KINDS = [KIND_TOPIC_PICK, KIND_VIDEO_REVIEW, KIND_REEL_EDIT, KIND_REEL_REVIEW];

// The retention rule lives in its own dependency-free module so the pure merge
// strategies can import it too — see the header of approvals-retention.js.
// Imported at the top of the file AND re-exported here: `export ... from`
// alone would not create a local binding, and `saveApprovals` below calls
// capRequests directly.
export { KIND_FAMILY, MAX_ENTRIES, MAX_REEL_ENTRIES, FAMILY_LIMITS, capRequests } from "./approvals-retention.js";

// ─── load / save ────────────────────────────────────────────────────────────

/**
 * Normalise whatever is in the file into { requests: [...] }.
 *
 * TWO WRITERS, TWO SHAPES. The poster writes `{ requests: [...] }`. The
 * deployed dashboard writes a BARE ARRAY of decision records:
 *
 *   [ { requestId, decision, decidedAt, selection } ]
 *
 * Discovered the hard way on the first live round-trip: the dashboard's commit
 * replaced the whole file, the request record — kind, requestedAt, and the
 * payload holding the candidates — vanished from HEAD, loadApprovals saw no
 * requests array and degraded to empty, and decisionState reported "none".
 * Peter's pick was invisible to the pipeline, and the next poster commit would
 * have merged the decision away entirely.
 *
 * The defensive read did its job — it stalled rather than proceeding on a file
 * it did not understand — but stalling on a decision Peter actually made is
 * still a broken pipeline.
 *
 * So the poster accepts both shapes. The dashboard is what is deployed, and
 * making the poster tolerant is both the smaller change and the more robust
 * one: a bare array of decisions is a perfectly reasonable thing for it to
 * write, and the field-group merge already knows how to fold decision-only
 * records onto request records without losing either half.
 */
export function normaliseApprovals(parsed) {
  if (Array.isArray(parsed)) {
    return { requests: parsed.filter(isRecord) };
  }
  if (parsed && Array.isArray(parsed.requests)) {
    return { ...parsed, requests: parsed.requests.filter(isRecord) };
  }
  return null;
}

/**
 * Read the approvals file. Anything unrecognisable degrades to empty.
 *
 * Empty means "nothing is approved", so a corrupt file stalls the pipeline
 * rather than releasing it. That asymmetry is deliberate.
 */
export function loadApprovals(path = YT_APPROVALS_PATH) {
  if (!existsSync(path)) return { requests: [] };
  try {
    const normalised = normaliseApprovals(JSON.parse(readFileSync(path, "utf-8")));
    if (!normalised) {
      console.warn("[Approvals] yt-approvals.json is neither {requests:[]} nor an array — treating as empty");
      return { requests: [] };
    }
    return normalised;
  } catch (err) {
    console.warn(`[Approvals] yt-approvals.json unreadable (${err.message}) — treating as empty`);
    return { requests: [] };
  }
}

export function saveApprovals(log, path = YT_APPROVALS_PATH) {
  const requests = capRequests(log?.requests);
  writeFileSync(path, JSON.stringify({ ...log, requests }, null, 2) + "\n");
}

function isRecord(r) {
  return Boolean(r) && typeof r === "object" && typeof r.requestId === "string" && r.requestId.length > 0;
}

// ─── reading the conversation ───────────────────────────────────────────────

export function findRequest(log, requestId) {
  return (log?.requests || []).find((r) => r.requestId === requestId) || null;
}

/**
 * Has the dashboard recorded a decision for this request?
 *
 * A decision counts only when `decision` is a non-empty string. A record with
 * `decidedAt` but no decision is a half-written row, not an answer.
 */
export function hasDecision(record) {
  return Boolean(record) && typeof record.decision === "string" && record.decision.trim().length > 0;
}

/**
 * Is this an explicit approval?
 *
 * Case and surrounding whitespace are forgiven because a human-facing dashboard
 * may well send "Approve". Nothing else is: "approved-ish", "yes", true, 1 and
 * "APPROVE_WITH_NOTES" are all NOT approval. If Peter's dashboard ever sends a
 * different word for approval, this is the one line that should change, and it
 * should change deliberately.
 */
export function isApproved(record) {
  return hasDecision(record) && record.decision.trim().toLowerCase() === APPROVE;
}

/** Guidance to feed back into regeneration when the answer was not "approve". */
export function regenerationNotes(record) {
  const notes = record?.notes;
  return typeof notes === "string" && notes.trim() ? notes.trim() : null;
}

/** Has the poster already acted on this decision? */
export function hasActed(record) {
  return Boolean(record) && typeof record.actedAt === "string" && record.actedAt.length > 0;
}

/**
 * Requests the pipeline must never act on.
 *
 * The dashboard smoke suite posts cards through the real approval webhook —
 * that is the only way to prove a card type renders — and taps the buttons on
 * them, because a card whose buttons are never pressed is not tested. The
 * dashboard then commits a decision for that requestId exactly as it would for
 * a real one, and yt-approvals.json gains a request that looks answered and
 * ready to act on.
 *
 * If the poll picked one up it would write a script, spend the model budget,
 * and deliver a recording kit for a video nobody asked for. That is not
 * hypothetical: a [TEST] card on 2026-08-06 was approved and DID produce a real
 * script and a real kit, and it took a deliberate cleanup to retire it. The
 * candidates were marked; the requestId was not, and the requestId is the only
 * part the pipeline reads.
 *
 * So the marker lives in the id itself. Anything a smoke run creates is invisible
 * to every scheduled job, whatever decision the dashboard records against it.
 */
export const TEST_REQUEST_PREFIX = "TEST-";

export function isTestRequest(record) {
  const id = typeof record === "string" ? record : record?.requestId;
  return typeof id === "string" && id.startsWith(TEST_REQUEST_PREFIX);
}

/**
 * The request this run should be looking at: the newest of its kind.
 *
 * Newest rather than oldest-unanswered, because a stale unanswered request is
 * exactly what a fresh brief supersedes. Peter ignoring last week's brief must
 * not wedge this week's.
 *
 * Smoke-test requests are filtered out here rather than at the call sites,
 * because here is the one place every scheduled job passes through.
 */
export function latestRequestOfKind(log, kind, { videoId = null } = {}) {
  const matches = (log?.requests || [])
    .filter((r) => !isTestRequest(r))
    .filter((r) => r.kind === kind)
    .filter((r) => (videoId ? r.videoId === videoId : true))
    .sort((a, b) => String(a.requestedAt || "").localeCompare(String(b.requestedAt || "")));
  return matches.length ? matches[matches.length - 1] : null;
}

/**
 * What a scheduled job should do about a given kind of request, in one call.
 *
 * Returns one of:
 *   { state: "none" }                  nothing has been requested yet
 *   { state: "waiting", record }       requested, no decision yet — exit clean, retry next run
 *   { state: "already-acted", record } decision consumed on an earlier run — do nothing
 *   { state: "approved", record }      act on it, then call markActed
 *   { state: "rejected", record, notes } regenerate using notes
 *
 * The caller never has to reason about the field combinations, which is where
 * an "approve" could otherwise be inferred by accident.
 */
export function decisionState(log, kind, opts = {}) {
  const record = latestRequestOfKind(log, kind, opts);
  if (!record) return { state: "none" };
  // Acted WITHOUT a decision means the system closed the request itself — a
  // review card superseded by a rebuild is the case that found this. The old
  // order checked hasDecision first, so a superseded card read as "waiting"
  // forever: the queue-rework supersede was recorded, the state machine never
  // looked at it, and the dispatched rebuild exited as a no-op saying it was
  // still waiting on Peter. Acted is acted, decided or not.
  if (hasActed(record) && !hasDecision(record)) return { state: "already-acted", record };
  if (!hasDecision(record)) return { state: "waiting", record };
  if (hasActed(record)) return { state: "already-acted", record };
  if (isApproved(record)) return { state: "approved", record };
  return { state: "rejected", record, notes: regenerationNotes(record) };
}

/**
 * The answered review that outranks everything else, or null.
 *
 * THE COLLISION THIS RESOLVES, from the first approve-is-publish dispatch
 * (run 32201677539): video 1's review sat APPROVED and unacted while video
 * 2's brief sat unanswered — and main() keyed its whole stage machine off the
 * NEWEST topic pick, so the run logged "waiting on Peter" for the new brief
 * and exited without publishing the video he had just approved. The
 * already-acted case even documented the principle — "if the review has been
 * answered, that is the newer news" — but only applied it inside one branch
 * of the topic switch.
 *
 * So the principle becomes a function and moves ABOVE the switch: an answered
 * video review is always acted first, whatever the newest brief is doing. A
 * decision Peter already made outranks a question he has not answered yet.
 */
export function pendingAnsweredReview(log) {
  const review = decisionState(log, KIND_VIDEO_REVIEW);
  return review.state === "approved" || review.state === "rejected" ? review : null;
}

// ─── writing the poster's half ──────────────────────────────────────────────

export function newRequestId(kind) {
  return `${kind}-${new Date().toISOString().slice(0, 10)}-${randomUUID().slice(0, 8)}`;
}

/**
 * Record that the poster has asked for a decision.
 *
 * The payload is stored alongside so the Friday job knows what was actually
 * proposed — the webhook delivery is fire-and-forget and the dashboard is not a
 * queryable source of truth for us.
 */
export function appendRequest(log, { requestId, kind, payload, videoId = null, presenter = null }) {
  if (!KINDS.includes(kind)) throw new Error(`Unknown approval kind: ${kind}`);
  if (!requestId) throw new Error("appendRequest requires a requestId");
  if (findRequest(log, requestId)) {
    console.warn(`[Approvals] request ${requestId} already recorded — not duplicating`);
    return log;
  }
  const entry = {
    requestId,
    kind,
    requestedAt: new Date().toISOString(),
    payload: payload ?? null,
  };
  if (videoId) entry.videoId = videoId;
  // Who fronts this video, stamped at creation (presenterStamp shape from
  // src/presenters.js). Absent means "the owner, by default" — resolved at
  // read time by presenterForRequest so old records need no backfill.
  if (presenter) entry.presenter = presenter;
  return { ...log, requests: [...(log?.requests || []), entry] };
}

/**
 * Assign (or reassign) a request's presenter.
 *
 * The previous stamp moves into presenterHistory with a supersededAt — a
 * reassignment is an event with a trail, not an overwrite, because "who was
 * this kit sent to before" is exactly the question a mixed-up recording
 * session needs answered. mergeYtApprovals carries both fields in their own
 * groups (later assignedAt wins; history unions).
 */
export function setRequestPresenter(log, requestId, stamp, { now = new Date().toISOString() } = {}) {
  const record = findRequest(log, requestId);
  if (!record) return { ok: false, reason: `no request "${requestId}" in yt-approvals.json` };
  if (record.presenter?.id === stamp?.id) {
    return { ok: false, reason: `${requestId} is already assigned to "${stamp.id}" — nothing to change` };
  }
  const requests = (log?.requests || []).map((r) => {
    if (r.requestId !== requestId) return r;
    const history = r.presenter
      ? [...(r.presenterHistory || []), { ...r.presenter, supersededAt: now }]
      : r.presenterHistory || [];
    return { ...r, presenter: stamp, ...(history.length ? { presenterHistory: history } : {}) };
  });
  return { ok: true, log: { ...log, requests }, previous: record.presenter || null };
}

/**
 * Replace the script inside an acted request's actedResult — the reassignment
 * path's one write into settled state.
 *
 * The acted LATCH is untouched (same discipline as resend-kit: re-sending a
 * kit and re-opening a stage are different things), but the script has to
 * move, because buildFromRecordings matches recordings against
 * actedResult.script and a reassigned presenter records the ADAPTED words.
 * scriptAdaptedAt is the merge marker that keeps this write from losing to a
 * stale concurrent copy — see mergeApprovalRecord.
 */
export function updateActedScript(log, requestId, script, { now = new Date().toISOString() } = {}) {
  const record = findRequest(log, requestId);
  if (!record) return { ok: false, reason: `no request "${requestId}" in yt-approvals.json` };
  if (!hasActed(record)) return { ok: false, reason: `${requestId} has not been acted on — there is no delivered script to replace` };
  if (!record.actedResult?.script) return { ok: false, reason: `${requestId} carries no script in actedResult` };
  const requests = (log?.requests || []).map((r) =>
    r.requestId === requestId
      ? { ...r, actedResult: { ...r.actedResult, script, scriptAdaptedAt: now } }
      : r
  );
  return { ok: true, log: { ...log, requests } };
}

/**
 * Stamp a request as acted on. This is the idempotency latch.
 *
 * Refuses to re-stamp an already-stamped record: the first action is the one
 * that happened, and overwriting its timestamp would hide a double-publish
 * rather than prevent one.
 */
export function markActed(log, requestId, { action, result = null } = {}) {
  const requests = (log?.requests || []).map((r) => {
    if (r.requestId !== requestId) return r;
    if (hasActed(r)) {
      console.warn(`[Approvals] ${requestId} was already acted on at ${r.actedAt} — leaving it alone`);
      return r;
    }
    return { ...r, actedAt: new Date().toISOString(), actedAction: action || null, actedResult: result };
  });
  return { ...log, requests };
}

/**
 * Record a decision locally.
 *
 * The dashboard is what normally writes decisions. This exists for tests and
 * for a manual override committed by hand — not for the poster to answer its
 * own questions, which is why it refuses to overwrite an existing decision.
 */
export function recordDecision(log, requestId, { decision, notes = null, decidedAt = null, selection = null }) {
  const requests = (log?.requests || []).map((r) => {
    if (r.requestId !== requestId) return r;
    if (hasDecision(r)) {
      console.warn(`[Approvals] ${requestId} already has decision "${r.decision}" — not overwriting`);
      return r;
    }
    const decided = { ...r, decision, notes, decidedAt: decidedAt || new Date().toISOString() };
    // Written only when present, matching the dashboard: a review decision has
    // no selection, and a null field would still count as "present" to the
    // merge's decision group.
    if (selection !== null && selection !== undefined) decided.selection = selection;
    return decided;
  });
  return { ...log, requests };
}

/**
 * Record a decision the dashboard failed to write back — validated.
 *
 * On 2026-08-19 Peter answered the Aug 17 topic card and the dashboard never
 * committed the decision; the pipeline read "waiting on Peter" for a week. The
 * recovery was a by-hand edit of this file on main. This is that edit as a
 * checked operation, for the record-decision workflow job to run: everything a
 * typo in a dispatch form could get wrong is refused with a reason instead of
 * being committed as state every scheduled job trusts.
 *
 * Refusals, each of which has already happened or nearly happened once:
 *   - unknown requestId (a typo would otherwise no-op silently in recordDecision)
 *   - TEST- requests (smoke fixtures; deciding one made a real kit on 2026-08-06)
 *   - already decided / already acted (the latch that stops a double-publish)
 *   - a decision word that is not exactly approve/reject (rule 1 of this file)
 *   - a topic approval whose selection does not name one of the candidates —
 *     "approved, but nothing says which one" is the stall this exists to fix,
 *     not one it should be able to write.
 *
 * Returns { ok:true, log } with the decision applied, or { ok:false, reason }.
 * Pure and non-throwing so the caller owns all I/O and exit codes.
 */
export function applyManualDecision(log, { requestId, decision, selection = null, notes = null }) {
  const record = findRequest(log, requestId);
  if (!record) return { ok: false, reason: `no request "${requestId}" in yt-approvals.json — check the id for typos` };
  if (isTestRequest(record)) return { ok: false, reason: `${requestId} is a smoke-test fixture — deciding it would build a real kit for a card nobody asked` };
  if (hasDecision(record)) return { ok: false, reason: `${requestId} already has decision "${record.decision}" (decided ${record.decidedAt}) — decisions are never overwritten` };
  if (hasActed(record)) return { ok: false, reason: `${requestId} was already acted on at ${record.actedAt} (${record.actedAction}) — nothing is waiting on a decision` };

  const word = String(decision || "").trim().toLowerCase();
  if (word !== APPROVE && word !== "reject") {
    return { ok: false, reason: `decision must be exactly "approve" or "reject" — got "${decision}"` };
  }

  let pick = null;
  if (record.kind === KIND_TOPIC_PICK && word === APPROVE) {
    const candidates = Array.isArray(record.payload?.candidates) ? record.payload.candidates : [];
    pick = Number(selection);
    if (!Number.isInteger(pick) || pick < 1 || pick > candidates.length) {
      return {
        ok: false,
        reason: `an approved topic needs a selection between 1 and ${candidates.length} — got "${selection}". ` +
          `An approval that does not say what was approved would stall the pipeline exactly like no decision at all.`,
      };
    }
  }

  return {
    ok: true,
    log: recordDecision(log, requestId, {
      decision: word,
      notes: typeof notes === "string" && notes.trim() ? notes.trim() : null,
      selection: pick,
    }),
  };
}

/**
 * Stamp a waiting record as nudged (see yt-stall-nudge.js).
 *
 * Unlike markActed this is NOT a latch — re-nudging after another 72 silent
 * hours is the point — so a later stamp simply replaces the earlier one, and
 * mergeYtApprovals gives the field its own group where the LATEST timestamp
 * wins for the same reason.
 */
export function markStallNudged(log, requestId, at = new Date().toISOString()) {
  const requests = (log?.requests || []).map((r) =>
    r.requestId === requestId ? { ...r, stallNudgedAt: at } : r
  );
  return { ...log, requests };
}
