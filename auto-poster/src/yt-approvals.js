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

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const YT_APPROVALS_PATH = join(ROOT, "yt-approvals.json");

/** The only decision value that may publish anything. */
export const APPROVE = "approve";

/** Request kinds the poster knows how to raise. */
export const KIND_TOPIC_PICK = "topic_pick";
export const KIND_VIDEO_REVIEW = "video_review";
export const KINDS = [KIND_TOPIC_PICK, KIND_VIDEO_REVIEW];

/** Keep the file bounded. Weekly cadence, two requests a week — years of history. */
export const MAX_ENTRIES = 400;

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
  const requests = [...(log?.requests || [])]
    .sort((a, b) => String(a.requestedAt || "").localeCompare(String(b.requestedAt || "")))
    .slice(-MAX_ENTRIES);
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
  if (!hasDecision(record)) return { state: "waiting", record };
  if (hasActed(record)) return { state: "already-acted", record };
  if (isApproved(record)) return { state: "approved", record };
  return { state: "rejected", record, notes: regenerationNotes(record) };
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
export function appendRequest(log, { requestId, kind, payload, videoId = null }) {
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
  return { ...log, requests: [...(log?.requests || []), entry] };
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
export function recordDecision(log, requestId, { decision, notes = null, decidedAt = null }) {
  const requests = (log?.requests || []).map((r) => {
    if (r.requestId !== requestId) return r;
    if (hasDecision(r)) {
      console.warn(`[Approvals] ${requestId} already has decision "${r.decision}" — not overwriting`);
      return r;
    }
    return { ...r, decision, notes, decidedAt: decidedAt || new Date().toISOString() };
  });
  return { ...log, requests };
}
