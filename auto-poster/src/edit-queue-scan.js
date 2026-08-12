/**
 * edit-queue-scan.js — look in the folder, card what is new, touch nothing else.
 *
 * THIS FILE CANNOT START AN EDIT, and that is a structural claim rather than a
 * promise. It imports no renderer: `reel-edit.js`, `reel-variant.js` and
 * `reel-hooks.js` appear nowhere in this module's import graph, so there is no
 * expression anywhere in it that could cut a video even if the control flow
 * were wrong. The test `the scan job has no path to a renderer` asserts exactly
 * that over the real import list, because a comment saying "this does not edit"
 * is worth nothing next to an import that says otherwise.
 *
 * The only transition it makes is "unknown video" -> "queued, carded". Peter's
 * press is what moves anything further, and that happens in
 * edit-queue-advance.js.
 *
 * ─── WHAT IT DOES ON A QUIET RUN ────────────────────────────────────────────
 *
 * Nothing, loudly. It prints what it saw and exits zero. A scheduled job whose
 * healthy state is "no output" is a job that can die without anyone noticing —
 * this repo has already paid for that twice, on the trial pipeline and on the
 * distribution sweep — so every run states the folder's contents and the queue's
 * counts even when neither changed.
 */

import { getAccessToken, listFolderFiles } from "./drive.js";
import { sendApprovalRequest, MAIL_PREFIX } from "./delivery.js";
import { notifyDailyFailure, notifyDailyOutcome, OUTCOME } from "./daily-notify.js";
import { remedyFor } from "./failure-remedy.js";
import { appendRequest, loadApprovals, newRequestId, saveApprovals, KIND_REEL_EDIT, TEST_REQUEST_PREFIX } from "./yt-approvals.js";
import {
  VIDEOS_TO_EDIT_FOLDER,
  STATUS,
  discover,
  loadQueue,
  needsQueueCard,
  reclaimStale,
  saveQueue,
  setStatus,
  summarise,
  tooShortReason,
} from "./edit-queue.js";
import { failureCardPayload, failureEmail, queueCardEmail, queueCardPayload } from "./edit-queue-cards.js";

const DRY_RUN = process.env.DRY_RUN === "true";

async function reportFatal(kind, err) {
  const error = err instanceof Error ? err : new Error(String(err));
  if (error.code === "EPIPE" || error.code === "ECONNRESET") {
    console.warn(`[Process] Suppressed ${error.code} on socket — the SDK retry will reconnect`);
    return;
  }
  console.error(`[EditQueueScan] ${kind}:`, error);
  await notifyDailyFailure({
    pipeline: "Manual edit queue (scan)",
    label: "scan",
    outcome: OUTCOME.FAILED,
    reason: `${kind}: ${error.message}`,
    remedy: remedyFor(error),
    detail: error.stack,
  }).catch(() => {});
  process.exit(1);
}

process.on("uncaughtException", (err) => reportFatal("Uncaught exception", err));
process.on("unhandledRejection", (err) => reportFatal("Unhandled rejection", err));

/**
 * A requestId that is invisible to every scheduled job when the file is a test.
 *
 * The TEST- prefix is the mechanism `isTestRequest` filters on, and it lives in
 * the ID rather than in the payload for the reason yt-approvals.js documents at
 * length: on 2026-08-06 a card whose every field was marked [TEST] was approved
 * and produced a real script, because the requestId is the only part the
 * pipeline reads.
 */
export function requestIdFor(record) {
  const id = newRequestId(KIND_REEL_EDIT);
  return record.test ? `${TEST_REQUEST_PREFIX}${id}` : id;
}

async function main() {
  console.log(`[EditQueueScan] ═══════════════════════════════════════════════`);
  console.log(`[EditQueueScan] Watching folder ${VIDEOS_TO_EDIT_FOLDER}`);
  console.log(`[EditQueueScan] DRY_RUN=${DRY_RUN}`);

  const accessToken = await getAccessToken();
  const files = await listFolderFiles(VIDEOS_TO_EDIT_FOLDER, { accessToken });
  console.log(`[EditQueueScan] Drive returned ${files.length} item(s)`);

  let queue = loadQueue();

  // A render that died without saying so is reclaimed BEFORE anything else, so
  // a wedged record shows up as a failure Peter can see rather than as a video
  // that is permanently "editing" and permanently invisible.
  const { queue: afterReclaim, reclaimed } = reclaimStale(queue);
  queue = afterReclaim;
  for (const id of reclaimed) {
    const record = queue.videos.find((v) => v.driveFileId === id);
    console.log(`::warning::[EditQueueScan] reclaimed a stale edit on ${record.fileName} — its lease expired`);
    if (!DRY_RUN) {
      await notify(record, accessToken, {
        payload: failureCardPayload(record, { stage: "render", reason: record.failure.reason, remedy: "Press Start Edit again once you know why the run died." }),
        mail: failureEmail(record, { stage: "render", reason: record.failure.reason }),
        kind: KIND_REEL_EDIT,
        requestId: record.queueRequestId,
      });
    }
  }

  const { queue: afterDiscovery, added, ignored } = discover(queue, files);
  queue = afterDiscovery;

  for (const item of ignored) {
    // Reported, never silent. An ignored file and an unreadable folder look
    // identical from the outside, and only one of them is fine.
    console.log(`::warning::[EditQueueScan] ignoring "${item.name}" — ${item.why}`);
  }

  console.log(`[EditQueueScan] ${added.length} new video(s), ${ignored.length} non-video item(s) ignored`);

  // ── card every new video ─────────────────────────────────────────────────
  const carded = [];
  const tooShort = [];

  for (const record of needsQueueCard(queue)) {
    // A video too short to edit gets a failed card immediately rather than a
    // Start button that would produce a re-encode and call it an edit.
    //
    // BEST-EFFORT HERE, and authoritative in the advance job. Drive populates
    // videoMediaMetadata asynchronously, so a scan running soon after a drop
    // sees no duration and this does not fire — the advance job then measures
    // the real bytes with ffprobe and fails it there. Both quote the same
    // sentence because Peter reads whichever one fires.
    const reason = tooShortReason(record.durationSeconds, { fileName: record.fileName });
    if (reason) {
      console.log(`::warning::[EditQueueScan] ${reason}`);
      // The failure card still gets a requestId, and it is STORED ON THE RECORD
      // rather than minted inline for the notice. Two reasons, both small and
      // both the kind of thing that reads as a bug from the outside: the
      // envelope's requestId and the one inside failureCardPayload have to be
      // the same string or a dashboard correlating them sees an orphan, and a
      // record with no requestId at all leaves nothing to key a later retry to.
      const requestId = requestIdFor(record);
      queue = setStatus(queue, record.driveFileId, STATUS.FAILED, {
        queueRequestId: requestId,
        failure: { stage: "precheck", reason, at: new Date().toISOString() },
      });
      tooShort.push(record.fileName);
      if (!DRY_RUN) {
        const failed = queue.videos.find((v) => v.driveFileId === record.driveFileId);
        await notify(failed, accessToken, {
          payload: failureCardPayload(failed, { stage: "precheck", reason, remedy: "Record a longer take, or post this one as-is." }),
          mail: failureEmail(failed, { stage: "precheck", reason }),
          kind: KIND_REEL_EDIT,
          requestId,
        });
      }
      continue;
    }

    const requestId = requestIdFor(record);
    queue = setStatus(queue, record.driveFileId, STATUS.QUEUED, { queueRequestId: requestId });
    const carded_record = queue.videos.find((v) => v.driveFileId === record.driveFileId);

    if (DRY_RUN) {
      console.log(`[EditQueueScan] DRY_RUN — would card ${record.fileName} as ${requestId}`);
      carded.push(record.fileName);
      continue;
    }

    // THE APPROVALS RECORD IS WRITTEN FIRST, and the card is sent second.
    //
    // If the send throws, the request still exists locally and gets committed,
    // so the next run sees a video that already has a queueRequestId and does
    // not card it twice. The opposite order loses the request on any send
    // failure and re-cards the same video on every scan — which is the shape of
    // a notification loop, and the reason Peter would mute this channel.
    saveApprovals(appendRequest(loadApprovals(), { requestId, kind: KIND_REEL_EDIT, payload: queueCardPayload(carded_record) }));

    const mail = queueCardEmail(carded_record);
    await sendApprovalRequest({
      requestId,
      kind: KIND_REEL_EDIT,
      payload: queueCardPayload(carded_record),
      emailSubject: mail.subject,
      emailBody: mail.body,
      accessToken,
      mailPrefix: MAIL_PREFIX.EDIT,
    });
    console.log(`[EditQueueScan] ✓ carded ${record.fileName} as ${requestId}`);
    carded.push(record.fileName);
  }

  if (!DRY_RUN) saveQueue(queue);

  const summary = summarise(queue);
  console.log(`[EditQueueScan] queue: ${summary}`);
  console.log(`[EditQueueScan] ═══════════════════════════════════════════════`);

  // Every run says what it saw, including the ones that saw nothing.
  await notifyDailyOutcome({
    pipeline: "Manual edit queue (scan)",
    label: "scan",
    outcome: carded.length > 0 || tooShort.length > 0 ? OUTCOME.SUCCEEDED : OUTCOME.SKIPPED,
    reason:
      `${files.length} item(s) in the folder. ` +
      `${carded.length ? `Carded: ${carded.join(", ")}. ` : "Nothing new to card. "}` +
      `${tooShort.length ? `Too short to edit: ${tooShort.join(", ")}. ` : ""}` +
      `${ignored.length ? `Ignored ${ignored.length} non-video item(s). ` : ""}` +
      `Queue: ${summary}. No edit was started — only a card action can do that.`,
  });
}

/** One notice over both channels, never fatal. A notice is not worth a red run. */
async function notify(record, accessToken, { payload, mail, kind, requestId }) {
  try {
    await sendApprovalRequest({
      requestId,
      kind,
      payload,
      emailSubject: mail.subject,
      emailBody: mail.body,
      accessToken,
      mailPrefix: MAIL_PREFIX.EDIT,
    });
  } catch (err) {
    console.log(`::warning::[EditQueueScan] could not deliver a notice for ${record.fileName}: ${err.message}`);
  }
}

main().catch(async (err) => {
  console.error(`[EditQueueScan] Fatal: ${err.message}`);
  console.error(err.stack);
  await notifyDailyFailure({
    pipeline: "Manual edit queue (scan)",
    label: "scan",
    outcome: OUTCOME.FAILED,
    reason: `Unhandled failure: ${err.message}`,
    remedy: remedyFor(err),
    detail: err.stack,
  }).catch(() => {});
  process.exit(1);
});
