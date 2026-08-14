/**
 * edit-queue-advance.js — act on what Peter pressed, and nothing else.
 *
 * THE GATE, stated once and enforced everywhere below: this job does work for a
 * video only when the dashboard has recorded an explicit approval against that
 * video's own open card, and only when nobody has acted on that approval
 * before. It runs on a schedule — it has to, because the dashboard makes no
 * inbound calls to us and a decision is a file in git rather than a webhook —
 * but a scheduled run with no new decision does nothing at all, every time.
 *
 * That distinction is the whole safety property. "Scheduled" is how often we
 * LOOK; a decision is what makes anything HAPPEN. The scan job is the half that
 * can only look (it imports no renderer at all); this is the half that can act,
 * and it cannot act unprompted.
 *
 * ─── ONE VIDEO'S FAILURE IS ONE VIDEO'S FAILURE ─────────────────────────────
 *
 * Every video is processed inside its own try. Peter can press Start on three
 * videos in a row, and a corrupt second file must not stop the third from
 * being edited — nor lose the first, which by then is already uploaded. The run
 * exits red if ANY video failed, after all of them have had their turn, so the
 * red run is a report rather than an abort.
 *
 * ─── AND WHY THE ACTED MARKER IS WRITTEN BEFORE THE WORK, NOT AFTER ─────────
 *
 * It is not. It is written after, deliberately, and the reasoning is worth
 * recording because the opposite is tempting. Marking first would make a
 * crashed run un-retryable: the decision would read as consumed and the video
 * would sit in `editing` forever with nothing to move it. Marking after risks
 * the reverse — a crash between finishing and marking would re-do the work —
 * and that is the cheaper mistake, because `startEdit` refuses to restart a
 * record whose lease is live, and a re-done edit produces a second review card
 * rather than a second published post. Nothing here publishes, which is what
 * makes "retry" the safe default.
 */

import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { getAccessToken, downloadFileById, ensureFolder, uploadAndShare } from "./drive.js";
import { deliverToOwner, sendApprovalRequest, MAIL_PREFIX } from "./delivery.js";
import { notifyDailyFailure, notifyDailyOutcome, OUTCOME } from "./daily-notify.js";
import { remedyFor } from "./failure-remedy.js";
import { generateCaption } from "./caption.js";
import { transcribeFile } from "./yt-ingest.js";
import {
  appendRequest,
  findRequest,
  isApproved,
  loadApprovals,
  markActed,
  newRequestId,
  recordDecision,
  regenerationNotes,
  saveApprovals,
  APPROVE,
  KIND_REEL_EDIT,
  KIND_REEL_REVIEW,
  TEST_REQUEST_PREFIX,
} from "./yt-approvals.js";
import { approvedAndUnacted, decidedAndUnacted } from "./edit-queue-gates.js";
import {
  VIDEOS_TO_EDIT_FOLDER,
  awaitingReview,
  awaitingStart,
  findVideo,
  finishAttempt,
  loadQueue,
  markDelivered,
  pendingDeliveries,
  reclaimStale,
  saveQueue,
  setStatus,
  startEdit,
  summarise,
  tooShortReason,
  STATUS,
} from "./edit-queue.js";
import { coldOpenPoints, describeEdit, renderReelEdit } from "./reel-edit.js";
import { mediaDuration } from "./yt-assemble.js";
import { generateHookLines, planVariants, MIN_VARIANTS } from "./reel-hooks.js";
import { renderVariant } from "./reel-variant.js";
import {
  deliveredCardPayload,
  failureCardPayload,
  failureEmail,
  reviewCardEmail,
  reviewCardPayload,
  startedCardPayload,
} from "./edit-queue-cards.js";
// No saveLog: recordPost persists posted-log.json itself, and calling both
// would write the same file twice per item for no reason.
import { loadLog, recordPost } from "./state.js";
import { loadTrialHistory, saveTrialHistory } from "./trial-variant.js";
import { routeWarnChannel } from "./yt-evidence.js";
// The Actions log drops the warn channel entirely (proven on two preserved
// runs) — route it to stdout at every entrypoint. See yt-evidence.js.
routeWarnChannel();

const DRY_RUN = process.env.DRY_RUN === "true";

/**
 * Where edited output lands until it is approved.
 *
 * NOT "Ready to Post". That folder means "Peter, post this now", and putting an
 * unapproved edit in it would make the folder lie — the whole point of the
 * review step is that nothing reaches a posting surface until he says so. A
 * subfolder of the watch folder keeps the source and its edits together, which
 * is also where he would look for them.
 */
export const REVIEW_FOLDER_NAME = "Edited — Pending Review";

/**
 * The market a queue video belongs to.
 *
 * The caption writer is city-scoped, and a video Peter dropped in a folder
 * carries no city. Configurable, defaulting to the market the reels pipeline
 * treats as primary, and STATED on the card so a wrong default is visible
 * rather than silently baked into a caption.
 */
export const QUEUE_CITY = process.env.EDIT_QUEUE_CITY || "san_antonio";

async function reportFatal(kind, err) {
  const error = err instanceof Error ? err : new Error(String(err));
  if (error.code === "EPIPE" || error.code === "ECONNRESET") {
    console.warn(`[Process] Suppressed ${error.code} on socket — the SDK retry will reconnect`);
    return;
  }
  console.error(`[EditQueueAdvance] ${kind}:`, error);
  await notifyDailyFailure({
    pipeline: "Manual edit queue (advance)",
    label: "advance",
    outcome: OUTCOME.FAILED,
    reason: `${kind}: ${error.message}`,
    remedy: remedyFor(error),
    detail: error.stack,
  }).catch(() => {});
  process.exit(1);
}

process.on("uncaughtException", (err) => reportFatal("Uncaught exception", err));
process.on("unhandledRejection", (err) => reportFatal("Unhandled rejection", err));

// ─── the run ────────────────────────────────────────────────────────────────

async function main() {
  console.log(`[EditQueueAdvance] ═══════════════════════════════════════════`);
  console.log(`[EditQueueAdvance] DRY_RUN=${DRY_RUN}`);

  let queue = loadQueue();
  const approvals = loadApprovals();

  const { queue: reclaimedQueue, reclaimed } = reclaimStale(queue);
  queue = reclaimedQueue;
  if (reclaimed.length) console.log(`::warning::[EditQueueAdvance] reclaimed ${reclaimed.length} stale edit(s)`);

  const starts = awaitingStart(queue).filter((v) => approvedAndUnacted(approvals, v.queueRequestId));
  const reviews = awaitingReview(queue).filter((v) => decidedAndUnacted(approvals, v.reviewRequestId));

  console.log(`[EditQueueAdvance] ${starts.length} start decision(s), ${reviews.length} review decision(s) to act on`);
  console.log(`[EditQueueAdvance] queue: ${summarise(queue)}`);

  if (starts.length === 0 && reviews.length === 0) {
    // The overwhelmingly common run. It says so and exits clean — this is what
    // "the schedule cannot start an edit" looks like from the inside.
    console.log(`[EditQueueAdvance] Nothing has been approved since the last run. Exiting without touching anything.`);
    saveQueue(queue);
    await notifyDailyOutcome({
      pipeline: "Manual edit queue (advance)",
      label: "advance",
      outcome: OUTCOME.SKIPPED,
      reason: `No card decisions to act on. Queue: ${summarise(queue)}.`,
    });
    return;
  }

  const accessToken = await getAccessToken();
  const failures = [];
  const done = [];

  for (const record of starts) {
    try {
      queue = await runEdit(queue, record.driveFileId, { accessToken });
      done.push(`edited ${record.fileName}`);
    } catch (err) {
      console.error(`[EditQueueAdvance] ${record.fileName} failed: ${err.message}`);
      failures.push(`${record.fileName}: ${err.message}`);
      queue = await failVideo(queue, record.driveFileId, { stage: err.stage || "edit", reason: err.message, accessToken });
    } finally {
      // The decision is consumed whatever happened, INCLUDING on failure. A
      // failed edit must not be retried on the next scheduled run off the same
      // press: Peter presses Start again once he knows why it died, which is
      // the same "nothing retries on its own" rule the failure card states.
      saveApprovals(markActed(loadApprovals(), record.queueRequestId, { action: "start_edit" }));
      saveQueue(queue);
    }
  }

  for (const record of reviews) {
    try {
      queue = await runReviewDecision(queue, record.driveFileId, { accessToken });
      done.push(`reviewed ${record.fileName}`);
    } catch (err) {
      console.error(`[EditQueueAdvance] review of ${record.fileName} failed: ${err.message}`);
      failures.push(`${record.fileName} (review): ${err.message}`);
      queue = await failVideo(queue, record.driveFileId, { stage: err.stage || "review", reason: err.message, accessToken });
    } finally {
      saveApprovals(markActed(loadApprovals(), record.reviewRequestId, { action: "review_decision" }));
      saveQueue(queue);
    }
  }

  saveQueue(queue);
  console.log(`[EditQueueAdvance] queue: ${summarise(queue)}`);
  console.log(`[EditQueueAdvance] ═══════════════════════════════════════════`);

  await notifyDailyOutcome({
    pipeline: "Manual edit queue (advance)",
    label: "advance",
    outcome: failures.length ? OUTCOME.FAILED : OUTCOME.SUCCEEDED,
    reason:
      `${done.length ? `Done: ${done.join(", ")}. ` : ""}` +
      `${failures.length ? `Failed: ${failures.join(" | ")}. ` : ""}` +
      `Queue: ${summarise(queue)}.`,
    remedy: failures.length ? "Each failed video has a failed card with its reason. Press Start Edit again once the cause is dealt with." : null,
  });

  if (failures.length) process.exit(1);
}

// ─── the edit ───────────────────────────────────────────────────────────────

/**
 * Download, cut, write hooks, render variants, upload, card. In that order.
 *
 * The order matters at exactly one seam: the review card goes out LAST, after
 * every file is in Drive with a link that has been granted public read. A card
 * sent before the uploads finish is a card whose links 404, and Peter finding a
 * dead link is indistinguishable to him from the feature being broken.
 */
async function runEdit(queue, driveFileId, { accessToken, notes = null }) {
  const before = findVideo(queue, driveFileId);
  const started = startEdit(queue, driveFileId, { decidedRequestId: before.queueRequestId, notes });
  if (!started.ok) {
    console.log(`[EditQueueAdvance] refusing to edit ${before.fileName}: ${started.reason}`);
    return queue;
  }
  queue = started.queue;
  const record = findVideo(queue, driveFileId);
  console.log(`[EditQueueAdvance] ── editing ${record.fileName} (rev ${record.revision}) ──`);

  await notice(accessToken, {
    requestId: record.queueRequestId,
    kind: KIND_REEL_EDIT,
    payload: startedCardPayload(record),
    subject: `Editing: ${record.fileName}`,
    body: `Started the retention edit on "${record.fileName}" (revision ${record.revision}). You will get a review card when it is done.`,
  });

  const work = mkdtempSync(join(tmpdir(), "reel-edit-"));
  try {
    return await editInto(queue, record, { accessToken, work, notes });
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

async function editInto(queue, record, { accessToken, work, notes }) {
  const driveFileId = record.driveFileId;

  // ── 1. the source ────────────────────────────────────────────────────────
  const sourcePath = join(work, "source.mp4");
  writeFileSync(sourcePath, await downloadFileById(driveFileId));

  // THE TOO-SHORT FLOOR, ENFORCED WHERE THE DURATION IS ACTUALLY KNOWN.
  //
  // The scan checks this too, from Drive's videoMediaMetadata — and that check
  // is best-effort by nature, which the first live sweep demonstrated rather
  // than argued. Drive populates a file's video metadata ASYNCHRONOUSLY after
  // the upload finishes, so a scan that runs soon after Peter drops something
  // gets `durationMillis: undefined`. `isLongEnough` deliberately reads a
  // missing duration as "long enough" — refusing on absent metadata would drop
  // perfectly good videos for a reason that has nothing to do with them — so a
  // 1.5-second clip sailed through and was carded as editable.
  //
  // Here there is no ambiguity: the bytes are on disk and ffprobe answers
  // exactly. So this is the authoritative floor and the scan's is an early-out.
  const tooShort = tooShortReason(mediaDuration(sourcePath), { fileName: record.fileName });
  if (tooShort) {
    const err = new Error(tooShort);
    err.stage = "precheck";
    throw err;
  }

  // ── 2. the cut ───────────────────────────────────────────────────────────
  const edit = renderReelEdit(sourcePath, work);
  console.log(`[EditQueueAdvance] ${describeEdit(edit)}`);
  for (const w of edit.warnings) console.log(`::warning::[EditQueueAdvance] ${w}`);

  // ── 3. the hooks ─────────────────────────────────────────────────────────
  // Transcribed from the EDITED master rather than the source, so a hook can
  // never quote a sentence the edit removed. It cannot remove speech (see
  // speechSafe), but deriving the hook from the artifact that ships is the
  // version of that guarantee that does not depend on another one holding.
  const transcript = transcribeFile(edit.outputPath);
  const spoken = transcript?.transcript?.trim() || "";
  if (!spoken) {
    console.log(`::warning::[EditQueueAdvance] no speech found in ${record.fileName} — no hook lines can be written from it`);
  }

  // `notes` goes in as GUIDANCE, never as transcript — see generateHookLines.
  // Appending it to the transcript would let a hook quote Peter's own note back
  // as though the video had said it.
  const hooks = spoken
    ? await generateHookLines({ transcript: spoken, guidance: notes })
    : { lines: [], rejected: [], attemptsUsed: 0, reason: "the video has no speech to write a hook from" };

  const warnings = [...edit.warnings];
  if (hooks.lines.length < MIN_VARIANTS) {
    warnings.push(
      `only ${hooks.lines.length} honest hook line(s) survived the gates` +
        (hooks.reason ? ` — ${hooks.reason}` : "") +
        (hooks.rejected.length ? `. Rejected: ${hooks.rejected.map((r) => `"${r.line}" (${r.failures[0]})`).join("; ")}` : "") +
        `. The master is still yours to approve.`
    );
  }

  // ── 4. the variants ──────────────────────────────────────────────────────
  const plan = planVariants(hooks.lines, coldOpenPoints(edit.pieces));
  const rendered = [];
  for (const variant of plan) {
    rendered.push(await renderVariant(edit.outputPath, work, variant));
    console.log(`[EditQueueAdvance] variant ${variant.label}: "${variant.hookLine}" (${variant.treatment})`);
  }

  // ── 5. Drive ─────────────────────────────────────────────────────────────
  const folderId = await ensureFolder(REVIEW_FOLDER_NAME, VIDEOS_TO_EDIT_FOLDER, { accessToken });
  const stem = `${record.test ? "TEST-" : ""}${baseName(record.fileName)}-rev${record.revision}`;

  const master = await uploadAndShare(folderId, `${stem}-master.mp4`, readFileSync(edit.outputPath), "video/mp4", { accessToken });
  const variants = [];
  for (const v of rendered) {
    const up = await uploadAndShare(folderId, `${stem}-${v.label}.mp4`, readFileSync(v.outputPath), "video/mp4", { accessToken });
    variants.push({ label: v.label, hookLine: v.hookLine, treatment: v.treatment, driveFileId: up.id, fileName: up.name, link: up.link });
    if (!up.shared) warnings.push(`variant ${v.label}'s link may need a login (${up.shareError})`);
  }
  if (!master.shared) warnings.push(`the master's link may need a login (${master.shareError})`);

  // ── 6. the review card ───────────────────────────────────────────────────
  const reviewRequestId = `${record.test ? TEST_REQUEST_PREFIX : ""}${newRequestId(KIND_REEL_REVIEW)}`;
  queue = finishAttempt(queue, driveFileId, {
    ok: true,
    patch: {
      reviewRequestId,
      master: { driveFileId: master.id, fileName: master.name, link: master.link },
      variants,
    },
  });
  const ready = findVideo(queue, driveFileId);
  const summary = describeEdit(edit);

  saveApprovals(
    appendRequest(loadApprovals(), {
      requestId: reviewRequestId,
      kind: KIND_REEL_REVIEW,
      payload: reviewCardPayload(ready, { editSummary: summary, warnings }),
      videoId: driveFileId,
    })
  );

  const mail = reviewCardEmail(ready, { editSummary: summary, warnings });
  await sendApprovalRequest({
    requestId: reviewRequestId,
    kind: KIND_REEL_REVIEW,
    payload: reviewCardPayload(ready, { editSummary: summary, warnings }),
    emailSubject: mail.subject,
    emailBody: mail.body,
    accessToken,
    mailPrefix: MAIL_PREFIX.EDIT,
  });

  console.log(`[EditQueueAdvance] ✓ ${record.fileName} is in review as ${reviewRequestId}`);
  return queue;
}

// ─── the review decision ────────────────────────────────────────────────────

async function runReviewDecision(queue, driveFileId, { accessToken }) {
  const record = findVideo(queue, driveFileId);
  const decision = findRequest(loadApprovals(), record.reviewRequestId);

  if (!isApproved(decision)) {
    const notes = regenerationNotes(decision);
    console.log(`[EditQueueAdvance] ${record.fileName} rejected${notes ? ` — "${notes}"` : " with no note"}`);

    // A rejection reopens the Start card, because a re-edit is a new edit and
    // `startEdit` will not run without a live decision. Recording the note on
    // the record is what carries it into the next render's hook prompt.
    const reopened = `${record.test ? TEST_REQUEST_PREFIX : ""}${newRequestId(KIND_REEL_EDIT)}`;
    queue = setStatus(queue, driveFileId, STATUS.QUEUED, { queueRequestId: reopened, reviewRequestId: null, lastNote: notes });
    saveApprovals(
      appendRequest(loadApprovals(), {
        requestId: reopened,
        kind: KIND_REEL_EDIT,
        payload: { ...startedCardPayload(findVideo(queue, driveFileId)), stage: undefined, note: notes, question: "Re-edit with this note?" },
        videoId: driveFileId,
      })
    );
    // Re-edit immediately rather than waiting for a second press. Peter has
    // already made the decision that matters — "not this, do it again with
    // this note" — and asking him to press Start again would be asking the
    // same question twice.
    //
    // The reopened card is answered by the rejection that created it, using
    // the shared `recordDecision`, which refuses to overwrite an existing
    // decision. So this can only ever set the answer to a card THIS run just
    // created, and can never answer a question Peter was actually asked.
    //
    // AND IT IS MARKED ACTED IN THE SAME BREATH, before the re-edit runs. The
    // card is created, decided and consumed inside one run, so no later poll
    // can find an approved-and-unacted card and start a SECOND re-edit off the
    // one rejection. Without this the status guard is the only thing standing
    // in the way, and it only holds while the re-edit gets far enough to change
    // the status — a re-edit that dies before `startEdit` would leave a queued
    // record with a live approval on it and edit again unprompted on the next
    // poll, which is the one thing this feature must never do.
    saveApprovals(markActed(recordDecision(loadApprovals(), reopened, { decision: APPROVE, notes }), reopened, { action: "rework" }));
    return await runEdit(queue, driveFileId, { accessToken, notes });
  }

  // ── approved: everything moves to the Trial tab ──────────────────────────
  console.log(`[EditQueueAdvance] ${record.fileName} approved — delivering to the Trial tab`);
  const work = mkdtempSync(join(tmpdir(), "reel-deliver-"));
  const trialLinks = [];
  try {
    const history = loadTrialHistory();
    const log = loadLog();
    const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" });

    const items = [
      { label: "MASTER", hookLine: "(the edited master, no hook plate)", ...record.master },
      ...(record.variants || []),
    ];

    // WHAT STILL HAS TO GO OUT — see pendingDeliveries for why this is not
    // simply `items`.
    const todo = pendingDeliveries(record, items);
    const sentNow = [...(record.deliveredLabels || [])];
    for (const skipped of items.filter((i) => i?.driveFileId && !todo.includes(i))) {
      console.log(`[EditQueueAdvance] ${skipped.label} already reached the Trial tab — not sending it twice`);
    }

    for (const item of todo) {
      // THE FILENAME CARRIES THE LABEL, because the Trial tab renders a file
      // name and may not render a field it has never been sent. Between the
      // name, the angle and the new hookLine field, "which of these three is
      // B" is answerable from the card however much of the payload the
      // dashboard understands.
      const localPath = join(work, `${record.test ? "TEST-" : ""}${baseName(record.fileName)}-${item.label}.mp4`);
      writeFileSync(localPath, await downloadFileById(item.driveFileId));

      const caption = await generateCaption(QUEUE_CITY, null, { trialAngle: `edit_queue_${item.label}` });

      const delivery = await deliverToOwner(accessToken, localPath, QUEUE_CITY, caption, {
        isTrial: true,
        isTest: Boolean(record.test),
        trialLabel: `${record.fileName} ${item.label}`,
        trialAngle: `edit_queue_${item.label}`,
        trialHookLine: item.hookLine || null,
        trialVariantNumber: record.revision,
        window: "manual",
        sourceVideoId: record.driveFileId,
      });
      trialLinks.push({ label: item.label, hookLine: item.hookLine, link: delivery.driveLink });

      // The Trial tab reads trial-variants.json. A record with no entry here is
      // a card that renders once from the webhook and is gone on the next load
      // — the smoke suite's "trial parity" test is exactly this check.
      if (!record.test) {
        history.variants.push({
          date: today,
          window: "manual",
          sourceVideoId: record.driveFileId,
          sourceFileName: record.fileName,
          city: QUEUE_CITY,
          hookAngle: `edit_queue_${item.label}`,
          hookLine: item.hookLine,
          variantNumber: record.revision,
          caption: caption.slice(0, 200),
          deliveryDriveLink: delivery.driveLink || null,
          generatedAt: new Date().toISOString(),
          trigger: "manual_edit_queue",
        });
        recordPost(log, {
          driveFileId: record.driveFileId,
          fileName: `${record.fileName} ${item.label}`,
          city: QUEUE_CITY,
          caption,
          voiceover: false,
          platforms: [],
          type: "trial_variant",
          hookAngle: `edit_queue_${item.label}`,
          variantNumber: record.revision,
          window: "manual",
          deliveryDriveLink: delivery.driveLink || null,
        });
      }
      console.log(`[EditQueueAdvance] ✓ ${item.label} on the Trial tab — ${delivery.driveLink}`);

      // ── EVERYTHING ABOUT THIS ITEM IS COMMITTED BEFORE THE NEXT ONE STARTS ──
      //
      // The marker and the Trial-tab record have to land TOGETHER, and batching
      // either of them to the end of the loop breaks that. The first version
      // wrote `deliveredLabels` per item and saved trial-variants.json once at
      // the end, which is the worst of both: a crash on the third item would
      // leave the first two marked as delivered — so a retry correctly skips
      // them — with no trial-variants record for either. They would sit on the
      // dashboard from the webhook and vanish on the next page load, and the
      // smoke suite's "trial parity" test is precisely the check that catches
      // that state.
      //
      // recordPost() already persists posted-log.json itself; saveTrialHistory
      // is the half that was missing.
      sentNow.push(item.label);
      queue = setStatus(queue, driveFileId, STATUS.IN_REVIEW, { deliveredLabels: [...sentNow] });
      if (!record.test) saveTrialHistory(history);
      saveQueue(queue);
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }

  queue = markDelivered(queue, driveFileId);
  await notice(accessToken, {
    requestId: record.reviewRequestId,
    kind: KIND_REEL_REVIEW,
    payload: deliveredCardPayload(findVideo(queue, driveFileId), { trialLinks }),
    subject: `On the Trial tab: ${record.fileName}`,
    body:
      `"${record.fileName}" is approved and everything is on the Trial tab with captions.\n\n` +
      trialLinks.map((t) => `  ${t.label}  ${t.hookLine}\n      ${t.link}`).join("\n") +
      `\n\n— Lifestyle Design Studio, manual edit queue`,
  });
  return queue;
}

// ─── failure ────────────────────────────────────────────────────────────────

/** A failed video gets a failed record and a loud card. Never silence. */
async function failVideo(queue, driveFileId, { stage, reason, accessToken }) {
  const next = finishAttempt(queue, driveFileId, { ok: false, stage, reason });
  const record = findVideo(next, driveFileId);
  const remedy = remedyFor(reason);
  console.log(`::error::[EditQueueAdvance] ${record.fileName} FAILED at ${stage}: ${reason}`);
  await notice(accessToken, {
    requestId: record.queueRequestId,
    kind: KIND_REEL_EDIT,
    payload: failureCardPayload(record, { stage, reason, remedy }),
    ...failureEmail(record, { stage, reason, remedy }),
  });
  return next;
}

/**
 * A progress or failure notice over both channels, never fatal.
 *
 * `sendApprovalRequest` throws when BOTH channels fail, which is right for a
 * question — a question nobody receives stalls the pipeline. A notice is
 * different: the state is already written and committed, so a notice that does
 * not arrive costs visibility rather than correctness, and taking the run down
 * over it would turn a delivered edit into a failed one.
 */
async function notice(accessToken, { requestId, kind, payload, subject, body }) {
  try {
    await sendApprovalRequest({
      requestId,
      kind,
      payload,
      emailSubject: subject,
      emailBody: body,
      accessToken,
      mailPrefix: MAIL_PREFIX.EDIT,
    });
  } catch (err) {
    console.log(`::warning::[EditQueueAdvance] notice for ${requestId} reached no channel: ${err.message}`);
  }
}

function baseName(name) {
  return String(name || "video").replace(/\.[^.]+$/, "").replace(/[^\w.-]+/g, "_").slice(0, 60);
}

main().catch(async (err) => {
  console.error(`[EditQueueAdvance] Fatal: ${err.message}`);
  console.error(err.stack);
  await notifyDailyFailure({
    pipeline: "Manual edit queue (advance)",
    label: "advance",
    outcome: OUTCOME.FAILED,
    reason: `Unhandled failure: ${err.message}`,
    remedy: remedyFor(err),
    detail: err.stack,
  }).catch(() => {});
  process.exit(1);
});
