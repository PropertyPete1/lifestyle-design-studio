/**
 * yt-stall-nudge.js — the 72-hour alarm on a question nobody answered.
 *
 * WHY THIS EXISTS
 *
 * On 2026-08-19 Peter answered the Aug 17 topic card on the dashboard. The
 * dashboard is the channel of record for decisions — it is what commits the
 * answer back into yt-approvals.json — and this time it never did: the
 * video_review decision from the same sitting landed, the topic_pick decision
 * did not. Every scheduled run for the next WEEK then did exactly what a
 * healthy run does with an unanswered brief: logged "waiting on Peter" and
 * exited green. The Monday brief declined to send a new card over the
 * "unanswered" one — also correctly. Six days of green runs, zero video 2
 * progress, and nothing anywhere that could notice.
 *
 * The failure was not detection — it was that "waiting" has no clock on it.
 * Peter answering within a day is normal; a card still waiting after three is
 * one of exactly two things, and BOTH need a human: he has not seen it, or he
 * answered and the dashboard dropped the write. The nudge does not know which.
 * It does not have to. Its whole job is to make sure the person who does know
 * is asked, with the recovery path for the dropped-write case in hand.
 *
 * The channel is Gmail, per the doctrine established in daily-notify.js: the
 * dashboard's webhooks each create a record in a tab Peter reads, and a
 * reminder is not a delivery — posting it there would trade a silent stall for
 * a lying dashboard. Mail through MAIL_PREFIX.YT is rare (briefs and kits), so
 * it gets read.
 *
 * `stallNudgedAt` on the record is what keeps this to one mail per 72 hours
 * instead of one per scheduled run (four a day). It has its own field group in
 * mergeYtApprovals — a field the merge does not know about is a field the next
 * concurrent commit silently deletes.
 *
 * Never throws: the nudge rides along on a healthy scheduled run, and a
 * notification failure must not turn "waiting on Peter" into a red build.
 */

import { getAccessToken } from "./drive.js";
import { sendOwnerEmail, MAIL_PREFIX } from "./delivery.js";
import {
  decisionState,
  markStallNudged,
  saveApprovals,
  KIND_TOPIC_PICK,
  KIND_VIDEO_REVIEW,
} from "./yt-approvals.js";

/**
 * How long a card may sit unanswered before the first nudge, and between
 * nudges after that. Three days: answering within one is the norm, two covers
 * a weekend he chose to take, three is long enough that SOMETHING is wrong —
 * proven by the one real data point, where the drop cost six.
 */
export const STALL_NUDGE_HOURS = 72;

/**
 * How often the dashboard reconcile sweep re-mails about a card it still
 * cannot find. The sweep itself is hourly (a card that is not visible is a
 * SYSTEM fault, not Peter taking his time, and it costs a day per day it goes
 * unnoticed); this is what keeps hourly detection from being hourly mail.
 */
export const RECONCILE_ALERT_REPEAT_HOURS = 24;

/**
 * How long after a card goes out before the reconcile sweep expects to see it.
 * The approval webhook is synchronous and the dashboard renders on receipt, so
 * an hour is generous — it exists so a sweep landing seconds after a send does
 * not alarm on a card the dashboard is still painting. Was two hours; with the
 * sweep hourly, two meant the third sweep was the first that could alert.
 */
export const RECONCILE_GRACE_HOURS = 1;

const HOUR_MS = 3600 * 1000;

/**
 * Is this waiting record due a nudge?
 *
 * Due when the request is older than the threshold AND the last nudge (if any)
 * is too. Timestamps that do not parse make the record NOT due — an unreadable
 * clock must degrade to silence, not to a mail on every run.
 */
export function nudgeDue(record, now = new Date()) {
  const requested = Date.parse(record?.requestedAt || "");
  if (!Number.isFinite(requested)) return false;
  if (now - requested < STALL_NUDGE_HOURS * HOUR_MS) return false;
  if (record.stallNudgedAt) {
    const nudged = Date.parse(record.stallNudgedAt);
    if (!Number.isFinite(nudged)) return false;
    if (now - nudged < STALL_NUDGE_HOURS * HOUR_MS) return false;
  }
  return true;
}

/** The Actions page where record-decision is dispatched from. */
function workflowUrl(env = process.env) {
  const server = env.GITHUB_SERVER_URL || "https://github.com";
  const repo = env.GITHUB_REPOSITORY || "PropertyPete1/lifestyle-design-studio";
  return `${server}/${repo}/actions/workflows/youtube-longform.yml`;
}

/**
 * The mail. Exported so tests can assert it names the request, says how long
 * it has waited, and carries the dropped-write recovery path — the body is the
 * fix for the incident, so its content is behaviour, not formatting.
 */
export function stallNudgeText(record, now = new Date()) {
  const days = Math.floor((now - Date.parse(record.requestedAt)) / (24 * HOUR_MS));
  const what = record.kind === KIND_TOPIC_PICK ? "topic card" : "review card";
  const subject = `${record.requestId} has been waiting ${days} days`;
  const body = [
    `The ${what} ${record.requestId} went out ${record.requestedAt} and no decision has reached the pipeline. Nothing advances until one does.`,
    ``,
    `If you haven't answered yet — it is on the dashboard, waiting.`,
    ``,
    `If you already answered it — the dashboard lost the write-back. It has done this before (2026-08-19, and it cost video 2 a week). Record the decision directly, it takes a minute:`,
    ``,
    `  1. Open ${workflowUrl()}`,
    `  2. "Run workflow" with job: record-decision`,
    `  3. request_id: ${record.requestId}`,
    `     decision: approve or reject`,
    record.kind === KIND_TOPIC_PICK
      ? `     selection: the option number you picked (1, 2 or 3)`
      : `     (leave selection blank for a review card)`,
    ``,
    `The next scheduled run picks the recorded decision up within hours. This reminder repeats every ${STALL_NUDGE_HOURS} hours until a decision lands.`,
    ``,
    `— Lifestyle Design Studio Auto-Poster`,
  ].join("\n");
  return { subject, body };
}

/**
 * Nudge a stalled waiting record, if one is due.
 *
 * The stamp is written ONLY after the mail actually went: a failed send left
 * unstamped is retried by the next scheduled run (four a day), which is the
 * retry loop this repo already trusts for everything else. Stamping first
 * would convert one Gmail hiccup into 72 more silent hours.
 *
 * Returns the (possibly updated) approvals so the caller keeps a current view.
 */
export async function maybeNudgeStalledRequest(approvals, record, { dryRun = false, now = new Date() } = {}) {
  try {
    if (!record || !nudgeDue(record, now)) return approvals;

    const { subject, body } = stallNudgeText(record, now);
    if (dryRun) {
      console.log(`[StallNudge] DRY RUN — would nudge ${record.requestId}: ${subject}`);
      return approvals;
    }

    const accessToken = await getAccessToken();
    await sendOwnerEmail(accessToken, { subject, body, prefix: MAIL_PREFIX.YT });

    const updated = markStallNudged(approvals, record.requestId, now.toISOString());
    saveApprovals(updated);
    console.log(`[StallNudge] ${record.requestId} nudged — waiting ${record.requestedAt} → ${now.toISOString()}`);
    return updated;
  } catch (err) {
    // Loud on the run page, harmless to the run. The scheduled cadence is the
    // retry; GitHub's ::warning:: is how a repeated failure gets noticed.
    console.log(`::warning::stall nudge for ${record?.requestId} could not be sent (${err.message}) — next scheduled run retries`);
    return approvals;
  }
}

/**
 * The waiting records the reconcile check should look for on the dashboard.
 *
 * Kept here — beside the nudge, in dependency-light poster code — so the
 * Playwright-side reconcile script stays a thin shell and this half is
 * testable with `npm test` alone.
 *
 * Only the newest request of each long-form kind can be "waiting" (that is the
 * record every scheduled job keys off), and a card is only worth checking once
 * the dashboard has had time to receive and render it — hence the grace.
 */
export function waitingRecords(approvals, { now = new Date(), graceHours = RECONCILE_GRACE_HOURS } = {}) {
  const out = [];
  for (const kind of [KIND_TOPIC_PICK, KIND_VIDEO_REVIEW]) {
    const s = decisionState(approvals, kind);
    if (s.state !== "waiting") continue;
    const requested = Date.parse(s.record.requestedAt || "");
    if (!Number.isFinite(requested)) continue;
    if (now - requested < graceHours * HOUR_MS) continue;
    out.push(s.record);
  }
  return out;
}

/**
 * Should the reconcile sweep mail about this missing card on THIS run?
 *
 * Due when it has never alerted, or when the last alert is older than
 * RECONCILE_ALERT_REPEAT_HOURS. A stamp that does not parse makes the record
 * NOT due — the same asymmetry as nudgeDue: an unreadable clock degrades to
 * silence, never to a mail on every hourly run. The stamp is only ever
 * written by markReconcileAlerted with an ISO string, so that branch is a
 * corruption tripwire, not a path anything walks on purpose.
 */
export function reconcileAlertDue(record, now = new Date()) {
  const stamp = record?.reconcileAlertedAt;
  if (!stamp) return true;
  const at = Date.parse(stamp);
  if (!Number.isFinite(at)) return false;
  return now - at >= RECONCILE_ALERT_REPEAT_HOURS * HOUR_MS;
}
