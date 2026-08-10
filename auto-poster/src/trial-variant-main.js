/**
 * Trial Variant — Entry Point
 * 
 * Generates and delivers ONE trial variant per run.
 * Called by GitHub Actions cron (2x daily: 8:15 AM CT + 6:45 PM CT).
 * 
 * Idempotency: checks trial-variants.json for today's window before generating.
 * Delivery: Drive "Ready to Post" folder + dashboard webhook + email. NO social posting.
 * Receipt: type "trial_variant" — excluded from all slot guards.
 */
import { getAccessToken } from "./drive.js";
import { deliverToOwner } from "./delivery.js";
import { loadLog, saveLog, recordPost } from "./state.js";
import { cleanup } from "./voiceover.js";
import { notifyDailyFailure, notifyDailyOutcome, OUTCOME } from "./daily-notify.js";
import { remedyFor } from "./failure-remedy.js";
import {
  loadTrialHistory,
  saveTrialHistory,
  hasGeneratedToday,
  shouldEscalateSkip,
  pickSourceVideo,
  generateVariant,
  getVariantNumber,
} from "./trial-variant.js";

/**
 * The two deaths `main().catch()` cannot see.
 *
 * An uncaught exception does not pass through a promise catch, and a rejection
 * with no handler is routed here rather than there. Either one exits non-zero
 * with nothing but a stack in a step log — the precise signal that went unread
 * for fourteen days. `main.js` grew this backstop during the audit; the trial
 * entry point did not, and it is the pipeline that actually failed.
 *
 * Registered above the consts and reading `process.env` directly: an exception
 * during module evaluation would otherwise hit the temporal dead zone and
 * replace the real error with a ReferenceError.
 */
async function reportFatal(kind, err) {
  const error = err instanceof Error ? err : new Error(String(err));
  // The Anthropic SDK's keepalive agent throws these when a stale TLS socket is
  // reused. The SDK's own retry uses a fresh connection, so crashing here would
  // fail a run that was about to succeed.
  if (error.code === "EPIPE" || error.code === "ECONNRESET") {
    console.warn(`[Process] Suppressed ${error.code} on socket — the SDK retry will reconnect`);
    return;
  }
  console.error(`[TrialVariant] ${kind}:`, error);
  // Exit is deferred until the alert settles: returning from this handler does
  // not end the process, and the pending request keeps the loop alive.
  await notifyDailyFailure({
    pipeline: "Trial variant",
    label: process.env.TRIAL_WINDOW || "am",
    outcome: OUTCOME.FAILED,
    reason: `${kind}: ${error.message}`,
    remedy: remedyFor(error),
    detail: error.stack,
  }).catch(() => {});
  process.exit(1);
}

process.on("uncaughtException", (err) => reportFatal("Uncaught exception", err));
process.on("unhandledRejection", (err) => reportFatal("Unhandled rejection", err));

const DRY_RUN = process.env.DRY_RUN === "true";
const TEST_DELIVERY_ONLY = process.env.TEST_DELIVERY_ONLY === "true";
const WINDOW = process.env.TRIAL_WINDOW || "am"; // "am" or "pm"
const FORCE_SOURCE_ID = process.env.FORCE_SOURCE_VIDEO_ID || "";

/**
 * The trial day in Chicago time — the same basis `hasGeneratedToday` uses.
 *
 * Deliberately one shared constant: a run that decided to skip on one date and
 * then recorded a variant under another would defeat its own idempotency, and
 * the 23:45Z slot lands on the previous CT day, so the two are genuinely
 * different dates for ~5 hours of every day.
 */
const TODAY = new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" });

async function main() {
  console.log(`[TrialVariant] ═══════════════════════════════════════════════════`);
  console.log(`[TrialVariant] Starting trial variant generation`);
  console.log(`[TrialVariant] Window: ${WINDOW}, DRY_RUN: ${DRY_RUN}, TEST_DELIVERY_ONLY: ${TEST_DELIVERY_ONLY}`);
  console.log(`[TrialVariant] ═══════════════════════════════════════════════════`);

  // Step 1: Idempotency check
  const history = loadTrialHistory();
  if (!TEST_DELIVERY_ONLY && hasGeneratedToday(history, WINDOW)) {
    // A skip used to be the quietest exit in the system: status 0, no annotation,
    // no mail. That is indistinguishable from a run that generated something, so
    // a stuck idempotency check could no-op forever behind a green tick.
    //
    // Which skips deserve the inbox is a narrower question than "did the cron
    // skip". A human running the slot early fills the window legitimately, and
    // the cron finding it filled is then correct. What is NOT correct is the
    // cron finding a window the CRON already filled — that is a replay, or a
    // window/date computation stuck on an already-served slot, which is the
    // shape a silent permanent no-op would take. Only that one is escalated;
    // alerting on the benign case is how an alert channel gets muted.
    const scheduled = process.env.GITHUB_EVENT_NAME === "schedule";
    const existing = history.variants.find((v) => v.date === TODAY && v.window === WINDOW);
    const suspicious = shouldEscalateSkip({ scheduled, existing });

    const reason =
      `A variant already exists for ${TODAY} ${WINDOW} — nothing generated. ` +
      (suspicious
        ? `Both that variant and this run came from the cron, which should meet each window ` +
          `exactly once. Either a run was replayed, or the window/date logic is selecting a ` +
          `window that is already filled.`
        : scheduled
        ? `It was generated by a manual run, so the cron finding this window filled is correct.`
        : `This was a manual re-run, so an existing variant is expected.`);
    console.log(`[TrialVariant] ${reason}`);
    await notifyDailyOutcome({
      pipeline: "Trial variant",
      label: `${WINDOW} · ${TODAY}`,
      outcome: OUTCOME.SKIPPED,
      reason,
      remedy: suspicious
        ? `Check trial-variants.json for duplicate ${TODAY}/${WINDOW} entries and confirm the ` +
          `cron-to-window mapping in post.yml still matches the two schedules.`
        : null,
      forceEmail: suspicious,
    });
    process.exit(0);
  }

  // Step 2: Pick source video
  let source;
  if (FORCE_SOURCE_ID) {
    // Manual override for testing
    const log = loadLog();
    const entry = log.posts.find(p => p.driveFileId === FORCE_SOURCE_ID && p.success && !p.type);
    if (!entry) {
      // A manual override with a bad id — the operator is at the keyboard and
      // the run page tells them. No email for a hand-typed mistake.
      console.error(`[TrialVariant] FORCE_SOURCE_VIDEO_ID=${FORCE_SOURCE_ID} not found in posted-log`);
      console.log(`::error title=Trial variant::FORCE_SOURCE_VIDEO_ID=${FORCE_SOURCE_ID} is not a posted video`);
      process.exit(1);
    }
    const { getNextAngle } = await import("./trial-variant.js");
    const angle = getNextAngle(FORCE_SOURCE_ID, history);
    source = {
      driveFileId: entry.driveFileId,
      fileName: entry.fileName,
      city: entry.city,
      views: 0,
      caption: entry.caption,
      timestamp: entry.timestamp,
      nextAngle: angle || "price_hook", // Fallback if all exhausted
    };
    console.log(`[TrialVariant] Using forced source: ${entry.fileName} (${entry.city})`);
  } else {
    source = await pickSourceVideo(history);
    if (!source) {
      const reason = "No eligible source video found — every posted reel has either been used for a trial variant already or has no angle left.";
      console.error(`[TrialVariant] ${reason}`);
      await notifyDailyFailure({
        pipeline: "Trial variant",
        label: WINDOW,
        outcome: OUTCOME.NOTHING_TO_POST,
        reason,
        remedy: remedyFor("no eligible source"),
      });
      process.exit(1);
    }
  }

  const angle = source.nextAngle;
  console.log(`[TrialVariant] Source: ${source.fileName} | City: ${source.city} | Angle: ${angle}`);

  // Step 3: Generate the variant
  let result;
  try {
    result = await generateVariant(source, angle, DRY_RUN);
  } catch (err) {
    // THE PATH THAT RAN RED TWICE A DAY FOR FOURTEEN DAYS. Whatever broke here
    // — TTS, the model, ffmpeg — is now said out loud to a human.
    console.error(`[TrialVariant] Generation failed: ${err.message}`);
    if (err.stack) console.error(err.stack);
    await notifyDailyFailure({
      pipeline: "Trial variant",
      label: `${WINDOW} · ${source.city} · ${angle}`,
      outcome: OUTCOME.FAILED,
      reason: `Could not generate the variant: ${err.message}`,
      remedy: remedyFor(err),
      detail: err.stack,
    });
    process.exit(1);
  }

  // Step 4: Deliver to owner (Drive + dashboard + email)
  const variantLabel = `TRIAL #${result.variantNumber} of ${result.sourceFileName}`;
  console.log(`[TrialVariant] Delivering: ${variantLabel}`);

  let deliveryResult = null;
  if (!DRY_RUN) {
    const accessToken = await getAccessToken();
    try {
      deliveryResult = await deliverToOwner(
        accessToken,
        result.videoPath,
        result.city,
        result.caption,
        {
          isTrial: true,
          isTest: TEST_DELIVERY_ONLY,
          trialLabel: variantLabel,
          trialAngle: angle,
          trialVariantNumber: result.variantNumber,
          recommendedTime: WINDOW === "am" ? "8:30 AM CT" : "7:00 PM CT",
          window: WINDOW,
          sourceVideoId: source.driveFileId,
          sourceViews: source.views || 0,
        }
      );
      console.log(`[TrialVariant] ✓ Delivered via: ${deliveryResult.channels.join(" + ")}`);

      // VERIFY, don't assume. Delivery succeeding means at least one channel
      // took it; it does not mean the Trial tab has a card. Those came apart in
      // this very pipeline — the webhook could fail all three retries and the
      // run still reported success — and the audit found the dashboard will also
      // accept a payload and render it on no tab at all.
      if (!deliveryResult.dashboardOk) {
        await notifyDailyOutcome({
          pipeline: "Trial variant",
          label: `${WINDOW} · ${source.city} · ${angle}`,
          outcome: OUTCOME.UNVERIFIED,
          reason:
            `${variantLabel} was generated and emailed, but the Trial tab webhook failed: ` +
            `${deliveryResult.dashboardError}. The variant will NOT appear on the dashboard ` +
            `Trial tab — use the Drive link. The angle is marked used and will not regenerate.`,
          remedy: remedyFor(deliveryResult.dashboardError || "dashboard webhook"),
          accessToken,
        });
      }
    } catch (err) {
      // The variant EXISTS and cost real model and TTS spend, but Peter cannot
      // see it. It is still recorded below so the angle is not retried, which
      // means without this alert the work would be silently thrown away.
      console.error(`[TrialVariant] Delivery failed: ${err.message}`);
      await notifyDailyFailure({
        pipeline: "Trial variant",
        label: `${WINDOW} · ${source.city} · ${angle}`,
        outcome: OUTCOME.DELIVERY_FAILED,
        reason:
          `${variantLabel} was generated but could not be delivered: ${err.message}. ` +
          `The angle is marked used, so this variant will NOT be regenerated.`,
        remedy: remedyFor(err),
        detail: err.stack,
        accessToken,
      });
      // Still record the variant in history so we don't retry the same angle
    }
  } else {
    console.log(`[TrialVariant] DRY_RUN — skipping delivery`);
  }

  // Step 5: Record in trial-variants.json (committed log)
  //
  // Skipped for a test run. This used to write unconditionally, so every
  // TEST_DELIVERY_ONLY run burned a real angle for a real source video and left
  // a permanent record the Trial tab renders as a genuine variant.
  if (!TEST_DELIVERY_ONLY) {
    const variantRecord = {
      date: TODAY,
      window: WINDOW,
      sourceVideoId: source.driveFileId,
      sourceFileName: source.fileName,
      city: source.city,
      hookAngle: angle,
      variantNumber: result.variantNumber,
      caption: result.caption.slice(0, 200),
      deliveryDriveLink: deliveryResult?.driveLink || null,
      generatedAt: new Date().toISOString(),
      // What filled this window. Read by the skip path above to tell a benign
      // "a human ran it early" from a cron that served the same window twice.
      // Records written before this field existed are treated as cron-filled,
      // which is the cautious reading.
      trigger: process.env.GITHUB_EVENT_NAME === "schedule" ? "schedule" : "manual",
    };
    history.variants.push(variantRecord);
    saveTrialHistory(history);
    console.log(`[TrialVariant] ✓ Recorded in trial-variants.json`);
  } else {
    console.log(`[TrialVariant] TEST_DELIVERY_ONLY — not recording in trial-variants.json`);
  }

  // Step 6: Record in posted-log.json (type: trial_variant — excluded from guards)
  if (!TEST_DELIVERY_ONLY) {
    const log = loadLog();
    recordPost(log, {
      driveFileId: source.driveFileId,
      fileName: source.fileName,
      city: source.city,
      caption: result.caption,
      voiceover: true,
      platforms: [], // NO social posting
      type: "trial_variant",
      hookAngle: angle,
      variantNumber: result.variantNumber,
      window: WINDOW,
      deliveryDriveLink: deliveryResult?.driveLink || null,
    });
    saveLog(log);
    console.log(`[TrialVariant] ✓ Recorded in posted-log.json (type: trial_variant)`);
  }

  // Cleanup temp files
  cleanup();

  console.log(`[TrialVariant] ═══════════════════════════════════════════════════`);
  console.log(`[TrialVariant] ✓ DONE: ${variantLabel}`);
  console.log(`[TrialVariant]   Angle: ${angle}`);
  console.log(`[TrialVariant]   City: ${source.city}`);
  console.log(`[TrialVariant]   Window: ${WINDOW}`);
  if (deliveryResult?.driveLink) {
    console.log(`[TrialVariant]   Drive: ${deliveryResult.driveLink}`);
  }
  console.log(`[TrialVariant] ═══════════════════════════════════════════════════`);

  // The success annotation. With this, every path out of this function — skipped,
  // nothing-to-post, failed, delivery-failed, unverified, succeeded — states its
  // outcome on the run page, so "no notification" is no longer a thing the trial
  // pipeline can produce. The dashboard card and the delivery email remain the
  // signals Peter actually reads; this is what makes silence detectable.
  await notifyDailyOutcome({
    pipeline: "Trial variant",
    label: `${WINDOW} · ${source.city} · ${angle}`,
    outcome: OUTCOME.SUCCEEDED,
    reason:
      DRY_RUN
        ? `${variantLabel} generated (DRY_RUN — not delivered).`
        : `${variantLabel} delivered via ${deliveryResult?.channels?.join(" + ") || "no channel"}. ` +
          `Drive: ${deliveryResult?.driveLink || "(none)"}`,
  });
}

/**
 * The backstop. Anything the steps above did not catch — a dead Google token
 * before delivery, an unreadable log, a bug — still has to reach Peter, because
 * "the run went red" is exactly the signal that failed for fourteen days.
 */
main().catch(async err => {
  console.error(`[TrialVariant] Fatal error: ${err.message}`);
  console.error(err.stack);
  await notifyDailyFailure({
    pipeline: "Trial variant",
    label: WINDOW,
    outcome: OUTCOME.FAILED,
    reason: `Unhandled failure: ${err.message}`,
    remedy: remedyFor(err),
    detail: err.stack,
  });
  process.exit(1);
});
