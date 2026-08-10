/**
 * daily-notify.js — the daily pipelines' half of "nothing fails silently".
 *
 * WHY THIS EXISTS
 *
 * On 2026-07-27 the ElevenLabs account lost access to the Professional voice the
 * reels and trial variants narrate with. Every run that needed a voiceover has
 * failed since. The trial pipeline failed twice a day for FOURTEEN DAYS — 28
 * consecutive red runs — and the first anyone knew of it was someone noticing
 * that trial-variants.json had stopped growing.
 *
 * Nothing was broken about the detection. The run went red, the error was
 * accurate, the stack trace was in the log. The failure was that "red run" is
 * not a notification: GitHub's workflow-failure mail lands in the same inbox as
 * twenty other automated messages a day and had long since stopped being read.
 *
 * The long-form pipeline already solved this for approvals (sendApprovalRequest
 * in delivery.js): say it out loud, on a channel with a filterable prefix, and
 * treat the notification itself as something that can fail. This is the same
 * idea for the three daily jobs, which predate that work.
 *
 * WHY EMAIL AND NOT THE DASHBOARD
 *
 * The dashboard implements exactly three webhooks — delivery, trial-delivery and
 * approval — and each one CREATES A RECORD in a tab Peter reads. A failure is
 * not a delivery. Posting one through the delivery webhook would put a phantom
 * card in the Deliveries tab for a video that does not exist, which trades a
 * silent failure for a lying dashboard. So the channel here is Gmail, which this
 * repo already owns end to end, plus a ::error:: annotation so the Actions run
 * page names the cause at the top instead of burying it in step logs.
 *
 * THE PREFIX IS THE POINT. [DAILY ALERT] is greppable and filterable, and it is
 * deliberately not [REELS] or [CAROUSEL] — those are delivery notices Peter
 * expects to see every day, and an alert that looks like the daily noise is the
 * failure mode this module exists to end.
 */

import { getAccessToken } from "./drive.js";
import { sendOwnerEmail, MAIL_PREFIX } from "./delivery.js";

/** Terminal outcomes a daily run can reach. Every one of these is notified. */
export const OUTCOME = {
  /** The run threw. Nothing was posted or delivered. */
  FAILED: "failed",
  /** The run completed but produced nothing, and that needs a human. */
  NOTHING_TO_POST: "nothing_to_post",
  /** Something published, but a downstream check says it did not land. */
  UNVERIFIED: "unverified",
  /** The work is done but could not be handed to Peter. */
  DELIVERY_FAILED: "delivery_failed",
  /** The run did the thing it exists to do, and it landed. */
  SUCCEEDED: "succeeded",
  /** The run deliberately did nothing, and that was correct. */
  SKIPPED: "skipped",
};

/**
 * The outcomes that mean something is wrong. These get the `[DAILY ALERT]`
 * inbox treatment; the rest are reported on the run page only.
 *
 * The split exists because the fourteen-day outage was not a missing message —
 * GitHub sent one every time — it was a message indistinguishable from the
 * twenty routine ones a day. Emailing every success would rebuild exactly that.
 */
export const ALERT_OUTCOMES = new Set([
  OUTCOME.FAILED,
  OUTCOME.NOTHING_TO_POST,
  OUTCOME.UNVERIFIED,
  OUTCOME.DELIVERY_FAILED,
]);

/** Human-readable one-liners, so a subject line reads like a sentence. */
const HEADLINE = {
  [OUTCOME.FAILED]: "run FAILED",
  [OUTCOME.NOTHING_TO_POST]: "posted NOTHING",
  [OUTCOME.UNVERIFIED]: "posted but NOT VERIFIED",
  [OUTCOME.DELIVERY_FAILED]: "made it but COULD NOT DELIVER",
  [OUTCOME.SUCCEEDED]: "OK",
  [OUTCOME.SKIPPED]: "SKIPPED",
};

/** The Actions run page, when we are running in Actions. */
export function runUrl(env = process.env) {
  const { GITHUB_SERVER_URL, GITHUB_REPOSITORY, GITHUB_RUN_ID } = env;
  if (!GITHUB_SERVER_URL || !GITHUB_REPOSITORY || !GITHUB_RUN_ID) return null;
  return `${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}`;
}

/**
 * The alert body. Exported so tests can assert it names the thing that broke
 * without needing a Gmail token.
 *
 * REMEDY IS A FIRST-CLASS FIELD. "ElevenLabs TTS failed (403)" is a diagnosis;
 * "the voice needs a Creator subscription, or set ELEVENLABS_VOICE_ID to a
 * standard voice" is something Peter can act on at 7am without reading source.
 */
export function alertBody({ pipeline, label, outcome, reason, remedy = null, url = null, detail = null }) {
  const lines = [
    `${pipeline}${label ? ` (${label})` : ""} ${HEADLINE[outcome] || outcome}.`,
    ``,
    `WHAT HAPPENED`,
    reason || "(no reason given)",
  ];
  if (remedy) lines.push(``, `WHAT FIXES IT`, remedy);
  if (detail) lines.push(``, `DETAIL`, String(detail).slice(0, 1500));
  lines.push(
    ``,
    `WHERE`,
    url || "(not running in GitHub Actions)",
    ``,
    `— sent by the daily pipeline's own alerting, not by GitHub.`,
    `If this stops arriving, the alerting itself is broken.`
  );
  return lines.join("\n");
}

/** The subject line. Prefix is added by sendOwnerEmail. */
export function alertSubject({ pipeline, label, outcome }) {
  return `${pipeline}${label ? ` ${label}` : ""} — ${HEADLINE[outcome] || outcome}`;
}

/**
 * Tell Peter a daily run ended badly.
 *
 * NEVER THROWS. Every call site is already on a failure path, and an alerting
 * problem must not replace the error that actually explains the run — that is
 * how you turn a legible outage into a mystery. A failure to notify is itself
 * reported, loudly, through the annotation channel that does not need a token.
 *
 * Returns { notified, channels, errors } so a caller that wants to assert
 * delivery can, and so tests can prove the annotation fires even with no creds.
 */
export async function notifyDailyFailure({
  pipeline,
  label = null,
  outcome = OUTCOME.FAILED,
  reason,
  remedy = null,
  detail = null,
  accessToken = undefined,
}) {
  const url = runUrl();
  const subject = alertSubject({ pipeline, label, outcome });
  const body = alertBody({ pipeline, label, outcome, reason, remedy, url, detail });

  // Channel A: the Actions annotation. No credentials, cannot fail, and it puts
  // the cause on the run page's summary instead of 400 lines into a step log.
  console.log(`::error title=${pipeline} ${HEADLINE[outcome] || outcome}::${oneLine(reason)}`);

  // Channel B: email. This is the one that reaches a human who is not already
  // looking at GitHub.
  const errors = [];
  const channels = ["annotation"];
  try {
    const token = accessToken === undefined ? await getAccessToken() : accessToken;
    if (!token) throw new Error("no Google access token available");
    const sent = await sendOwnerEmail(token, { subject, body, prefix: MAIL_PREFIX.ALERT });
    if (sent?.ok) channels.push("email");
    else errors.push(`email: ${sent?.lastError?.message || "unknown failure"}`);
  } catch (err) {
    errors.push(`email: ${err.message}`);
  }

  if (!channels.includes("email")) {
    // The alert did not reach a human inbox. Say so in the one place left.
    console.log(
      `::error title=ALERTING DEGRADED::Could not email the ${pipeline} alert (${errors.join("; ")}). ` +
      `This run page is the only record.`
    );
  }
  console.log(`[Alert] ${pipeline} ${outcome} — sent via: ${channels.join(" + ")}`);
  return { notified: channels.includes("email"), channels, errors };
}

/**
 * Report ANY terminal outcome — good or bad.
 *
 * This is the entry point a pipeline should call, because it is total: there is
 * no outcome value it declines to report. Bad outcomes get the full alert path
 * (annotation + `[DAILY ALERT]` mail); good ones get a `::notice::` on the run
 * page, so "the run said nothing" stops being a state the system can occupy.
 *
 * `forceEmail` promotes a normally-quiet outcome to the inbox. A trial slot that
 * skips on a *scheduled* run is the case that matters: the cron should never
 * meet an already-filled window, so that skip is evidence, not routine.
 *
 * NEVER THROWS, for the same reason notifyDailyFailure never throws.
 */
export async function notifyDailyOutcome({
  pipeline,
  label = null,
  outcome,
  reason,
  remedy = null,
  detail = null,
  accessToken = undefined,
  forceEmail = false,
}) {
  if (ALERT_OUTCOMES.has(outcome)) {
    return notifyDailyFailure({ pipeline, label, outcome, reason, remedy, detail, accessToken });
  }

  // Good news still has to be said out loud, or a pipeline that silently stops
  // doing anything looks exactly like one that is working.
  console.log(`::notice title=${pipeline} ${HEADLINE[outcome] || outcome}::${oneLine(reason)}`);
  const channels = ["annotation"];
  const errors = [];

  if (forceEmail) {
    const subject = alertSubject({ pipeline, label, outcome });
    const body = alertBody({ pipeline, label, outcome, reason, remedy, url: runUrl(), detail });
    try {
      const token = accessToken === undefined ? await getAccessToken() : accessToken;
      if (!token) throw new Error("no Google access token available");
      const sent = await sendOwnerEmail(token, { subject, body, prefix: MAIL_PREFIX.ALERT });
      if (sent?.ok) channels.push("email");
      else errors.push(`email: ${sent?.lastError?.message || "unknown failure"}`);
    } catch (err) {
      errors.push(`email: ${err.message}`);
    }
    if (!channels.includes("email")) {
      console.log(
        `::error title=ALERTING DEGRADED::Could not email the ${pipeline} ${outcome} notice ` +
        `(${errors.join("; ")}). This run page is the only record.`
      );
    }
  }

  console.log(`[Alert] ${pipeline} ${outcome} — sent via: ${channels.join(" + ")}`);
  return { notified: channels.includes("email"), channels, errors };
}

/** Annotations are one line: a newline would truncate the message in the UI. */
function oneLine(s) {
  return String(s ?? "").replace(/\s*\n\s*/g, " ").slice(0, 400);
}
