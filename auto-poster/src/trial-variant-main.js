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
import { notifyDailyFailure, OUTCOME } from "./daily-notify.js";
import { remedyFor } from "./failure-remedy.js";
import {
  loadTrialHistory,
  saveTrialHistory,
  hasGeneratedToday,
  pickSourceVideo,
  generateVariant,
  getVariantNumber,
} from "./trial-variant.js";

const DRY_RUN = process.env.DRY_RUN === "true";
const TEST_DELIVERY_ONLY = process.env.TEST_DELIVERY_ONLY === "true";
const WINDOW = process.env.TRIAL_WINDOW || "am"; // "am" or "pm"
const FORCE_SOURCE_ID = process.env.FORCE_SOURCE_VIDEO_ID || "";

async function main() {
  console.log(`[TrialVariant] ═══════════════════════════════════════════════════`);
  console.log(`[TrialVariant] Starting trial variant generation`);
  console.log(`[TrialVariant] Window: ${WINDOW}, DRY_RUN: ${DRY_RUN}, TEST_DELIVERY_ONLY: ${TEST_DELIVERY_ONLY}`);
  console.log(`[TrialVariant] ═══════════════════════════════════════════════════`);

  // Step 1: Idempotency check
  const history = loadTrialHistory();
  if (!TEST_DELIVERY_ONLY && hasGeneratedToday(history, WINDOW)) {
    console.log(`[TrialVariant] Already generated for today's ${WINDOW} window. Exiting cleanly.`);
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
          trialLabel: variantLabel,
          trialAngle: angle,
          trialVariantNumber: result.variantNumber,
          recommendedTime: WINDOW === "am" ? "8:30 AM CT" : "7:00 PM CT",
          window: WINDOW,
          sourceVideoId: source.driveFileId,
          sourceViews: source.views || 0,
        }
      );
      console.log(`[TrialVariant] ✓ Delivered to Drive + dashboard`);
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
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
  const variantRecord = {
    date: today,
    window: WINDOW,
    sourceVideoId: source.driveFileId,
    sourceFileName: source.fileName,
    city: source.city,
    hookAngle: angle,
    variantNumber: result.variantNumber,
    caption: result.caption.slice(0, 200),
    deliveryDriveLink: deliveryResult?.driveLink || null,
    generatedAt: new Date().toISOString(),
  };
  history.variants.push(variantRecord);
  saveTrialHistory(history);
  console.log(`[TrialVariant] ✓ Recorded in trial-variants.json`);

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
