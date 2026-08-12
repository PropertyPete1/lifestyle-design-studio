/**
 * edit-queue-cards.js — what the dashboard renders and what lands in the inbox.
 *
 * Every payload and every email body this feature sends is built here, pure,
 * out of a queue record. Pure because these are the strings Peter actually acts
 * on: a review card whose links are undefined and an email that says
 * "[object Object]" both render perfectly and are both useless, and neither
 * failure shows up anywhere except in front of him. A function that returns a
 * string can be argued with in a test; a fetch call with a template literal in
 * it cannot.
 *
 * ─── THE STAGE CONVENTION, FOLLOWED RATHER THAN REINVENTED ──────────────────
 *
 * delivery.js lifts `stage` to the top of the approval envelope and gives it a
 * precise meaning, which this feature adopts unchanged:
 *
 *   stage === null   a DECISION is being asked for — render the card, show the
 *                    buttons, write back what Peter presses.
 *   stage !== null   PROGRESS on a request already decided — a notice, not a
 *                    question.
 *
 * So the Start card and the Review card carry no stage, and "started",
 * "failed" and "delivered" are stages on the request that caused them. That is
 * what stops a failure notice reading as a second unanswered card and wedging
 * the queue behind a question nobody was asked.
 *
 * ─── AND WHY EVERY EMAIL REPEATS EVERY LINK ─────────────────────────────────
 *
 * Peter reviews from his phone, away from the dashboard. The email is not a
 * notification that something is waiting — it IS the review surface, and it has
 * to work with the dashboard switched off. So the master link and all three
 * variant links, with their hook lines, go in the body of the mail rather than
 * behind a "open the dashboard" line.
 */

import { STATUS } from "./edit-queue.js";

/** The dashboard's own action ids. `approve` is the only one that starts work. */
export const ACTION_START = "approve";

/**
 * The Start card: a video is in the folder and nothing has happened to it.
 *
 * `actions` is advisory — the dashboard renders its own buttons and writes back
 * its own decision strings, and `isApproved` in yt-approvals.js is the thing
 * that decides what counts. It is included so a card type the dashboard has not
 * been taught yet still carries, in its payload, what it is asking for.
 */
export function queueCardPayload(record) {
  return {
    requestId: record.queueRequestId,
    driveFileId: record.driveFileId,
    fileName: record.fileName,
    durationSeconds: record.durationSeconds,
    duration: durationLabel(record.durationSeconds),
    discoveredAt: record.discoveredAt,
    folder: "Videos To Edit",
    question: "Start the retention edit on this video?",
    actions: [{ id: ACTION_START, label: "Start Edit" }],
    whatHappens:
      "Cuts dead air (pauses over 400ms, 150ms kept, never mid-word), changes framing every ~2.5s, " +
      "15ms fades at every join, then writes 2-3 hook variants. Nothing is posted — it comes back to you for review.",
    isTest: Boolean(record.test),
  };
}

export function queueCardEmail(record) {
  return {
    subject: `New video to edit: ${record.fileName}`,
    body: [
      `A new video is in your "Videos To Edit" folder.`,
      ``,
      `  File:     ${record.fileName}`,
      `  Length:   ${durationLabel(record.durationSeconds)}`,
      `  Found:    ${record.discoveredAt}`,
      ``,
      `NOTHING HAS BEEN DONE TO IT. It will sit there until you press Start Edit on the`,
      `dashboard card. No scheduled job will ever start an edit on its own.`,
      ``,
      `When you do start it: dead air comes out (pauses over 400ms, 150ms kept, cuts only`,
      `inside silence so it can never clip a word), the framing changes every ~2.5 seconds,`,
      `every join gets a 15ms fade, and you get 2-3 hook variants back to review.`,
      ``,
      `— Lifestyle Design Studio, manual edit queue`,
    ].join("\n"),
  };
}

/**
 * The Review card: the edit is done and every file has a link that opens.
 *
 * `driveLink` is repeated at the top level as well as inside `master` because
 * the delivery cards on this dashboard use that field name, and a card type it
 * has not been taught yet is likeliest to fall back on the shape it knows.
 */
export function reviewCardPayload(record, { editSummary, warnings = [] } = {}) {
  return {
    requestId: record.reviewRequestId,
    driveFileId: record.driveFileId,
    fileName: record.fileName,
    revision: record.revision,
    question: "Approve these for the Trial tab, or send them back with a note?",
    actions: [
      { id: "approve", label: "Approve" },
      { id: "reject", label: "Reject with note" },
    ],
    driveLink: record.master?.link || null,
    master: {
      fileName: record.master?.fileName || null,
      link: record.master?.link || null,
      driveFileId: record.master?.driveFileId || null,
    },
    variants: (record.variants || []).map((v) => ({
      label: v.label,
      hookLine: v.hookLine,
      treatment: v.treatment,
      link: v.link,
      fileName: v.fileName,
      driveFileId: v.driveFileId,
    })),
    editSummary,
    warnings,
    isTest: Boolean(record.test),
  };
}

export function reviewCardEmail(record, { editSummary, warnings = [] } = {}) {
  const lines = [
    `Your edit is ready to review. Nothing has been posted and nothing is on the Trial tab yet.`,
    ``,
    `  Source:   ${record.fileName}`,
    `  Revision: ${record.revision}`,
    `  Edit:     ${editSummary}`,
    ``,
    `━━━ THE EDITED MASTER ━━━`,
    ``,
    `  ${record.master?.link || "(no link — the upload failed, see the dashboard card)"}`,
    ``,
    `━━━ HOOK VARIANTS ━━━`,
    ``,
  ];

  for (const v of record.variants || []) {
    lines.push(`  ${v.label}.  "${v.hookLine}"`);
    lines.push(`      ${v.treatment}`);
    lines.push(`      ${v.link || "(no link — the upload failed)"}`);
    lines.push(``);
  }
  if (!(record.variants || []).length) {
    lines.push(`  (none — see the warnings below)`, ``);
  }

  if (warnings.length) {
    lines.push(`━━━ WORTH KNOWING ━━━`, ``, ...warnings.map((w) => `  - ${w}`), ``);
  }

  lines.push(
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
    ``,
    `Approve on the dashboard card and all of them move to the Trial tab with captions.`,
    `Reject with a note and it re-edits using your note and comes back again.`,
    ``,
    `— Lifestyle Design Studio, manual edit queue`
  );

  return { subject: `Ready to review: ${record.fileName} (rev ${record.revision})`, body: lines.join("\n") };
}

/**
 * The failure notice. LOUD, and it always goes out.
 *
 * A failed edit is the case this whole feature is likeliest to get wrong
 * quietly: the render throws, the run goes red, and a red run on a schedule is
 * a thing nobody looks at. So a failure produces a card AND an email with the
 * reason in plain words and the remedy attached, exactly as the daily pipelines
 * do — silence is the one outcome that is not allowed.
 */
export function failureCardPayload(record, { stage, reason, remedy = null }) {
  return {
    stage: "edit_failed",
    requestId: record.queueRequestId,
    driveFileId: record.driveFileId,
    fileName: record.fileName,
    revision: record.revision,
    failedStage: stage,
    reason,
    remedy,
    status: STATUS.FAILED,
    isTest: Boolean(record.test),
  };
}

export function failureEmail(record, { stage, reason, remedy = null }) {
  return {
    subject: `FAILED: ${record.fileName} (rev ${record.revision})`,
    body: [
      `The edit for "${record.fileName}" failed. Nothing was posted and nothing reached the Trial tab.`,
      ``,
      `  Where:    ${stage}`,
      `  Why:      ${reason}`,
      remedy ? `  Fix:      ${remedy}` : null,
      ``,
      `The video is still in "Videos To Edit" and its card now shows failed. Press Start Edit`,
      `again once the cause is dealt with — nothing retries on its own.`,
      ``,
      `— Lifestyle Design Studio, manual edit queue`,
    ]
      .filter((l) => l !== null)
      .join("\n"),
  };
}

/** Progress notice: the edit has actually begun. Not a question. */
export function startedCardPayload(record) {
  return {
    stage: "edit_started",
    requestId: record.queueRequestId,
    driveFileId: record.driveFileId,
    fileName: record.fileName,
    revision: record.revision,
    status: STATUS.EDITING,
    isTest: Boolean(record.test),
  };
}

/** Progress notice: approved, and everything is on the Trial tab. */
export function deliveredCardPayload(record, { trialLinks = [] } = {}) {
  return {
    stage: "edit_delivered",
    requestId: record.reviewRequestId,
    driveFileId: record.driveFileId,
    fileName: record.fileName,
    revision: record.revision,
    status: STATUS.DELIVERED,
    delivered: trialLinks,
    isTest: Boolean(record.test),
  };
}

/** "1m 12s", "41s", or an honest "unknown" — never a bare null in front of Peter. */
export function durationLabel(seconds) {
  const n = Number(seconds);
  if (!Number.isFinite(n) || n <= 0) return "unknown (Drive did not report one)";
  if (n < 60) return `${Math.round(n)}s`;
  return `${Math.floor(n / 60)}m ${String(Math.round(n % 60)).padStart(2, "0")}s`;
}
