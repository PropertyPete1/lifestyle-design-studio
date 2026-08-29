/**
 * Lifestyle Design Technologies — LDT brand lane (brand 2).
 *
 * Posts to the LDT accounts ONLY (IG @lifestyledesigntechnologies, TikTok
 * @lifestyledesigntech), resolved by handle from brands.json against the
 * Metricool profile list. FAIL-CLOSED: no matching profile means no post and
 * a loud notice with the connect steps — never a fallback to "all brands".
 *
 * CONTENT, in priority order:
 *   1. Operator-supplied clips from the intake Drive folder
 *      (LDT_INTAKE_FOLDER_ID) — screen recordings of PRIMARY working —
 *      QC'd, captioned in the LDT voice, posted once each, oldest first.
 *   2. A generated promo carousel ($99/mo positioning) when the intake
 *      queue is empty and the config allows it — at most ONE per day (the
 *      angle is deterministic per date; a second would be byte-identical).
 *
 * GUARDS, in the order they run:
 *   - resolveCadence: refuses (red run) any configured cadence above the
 *     6/day hard cap, warns above the 2/day default. Runs before anything.
 *   - Connect gates: profile missing → loud notice with connect steps;
 *     profile present but no networks connected yet → the same notice, not
 *     a silent green.
 *   - minGap + per-platform daily cadence: a slot that would exceed either
 *     exits green and says so. A FORCE_VIDEO_ID dispatch blocked by cadence
 *     exits RED instead — a pin that did nothing must never look green.
 *   - Claims gate: every caption is checked against ldt-claims.json;
 *     ungateable captions fall back to the pinned caption, which is itself
 *     gate-checked in CI.
 *
 * Everything here is LDT-scoped: posted-log entries carry brand:"ldt" and a
 * type, so no realty guard ever counts them and no LDT guard counts realty.
 */

import { readFileSync, writeFileSync, unlinkSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createHash } from "crypto";
import { listFolderFiles, downloadVideo } from "./drive.js";
import {
  listProfiles, uploadToBrand, createSingleBrandPost,
  compressVideoToFit, MAX_UPLOAD_BYTES,
} from "./metricool.js";
import {
  loadBrandRegistry, findBrandProfiles, resolveCadence, cadenceAllows, minGapOk, chicagoDayOf,
} from "./brands.js";
import { pickIntakeCandidates, hasBrandPromoToday } from "./ldt-intake.js";
import { generateLdtCaption } from "./ldt-caption.js";
import { loadLdtClaims, checkClaimsCompliance, describeViolations } from "./ldt-claims-gate.js";
import { angleForDate, renderPromoDeck, promoDeckText } from "./ldt-promo.js";
import { prePostQualityCheck } from "./quality-check.js";
import { loadLog, saveLog, recordPost, loadBlocklist, blocklistVideo } from "./state.js";
import { verifyReelPublication, applyReelVerification } from "./reel-verify.js";
import { uploadSlides, schedulePost, instagramCarouselBody, tiktokCarouselBody, chicagoDateTime } from "./carousel-distribute.js";
import { notifyDailyFailure, OUTCOME } from "./daily-notify.js";
import { routeWarnChannel } from "./yt-evidence.js";
routeWarnChannel();

const DRY_RUN = process.env.DRY_RUN === "true";
const MODE = process.env.MODE || "auto"; // auto | clip | promo
const FORCE_VIDEO_ID = process.env.FORCE_VIDEO_ID || "";
const BRAND_KEY = "ldt";

/** This slot's label, Chicago clock: before 2 PM CT is "am". */
function chicagoSlot(now = new Date()) {
  const hour = Number(new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago", hour: "2-digit", hour12: false,
  }).format(now));
  return hour < 14 ? "am" : "pm";
}

const CONNECT_STEPS =
  "Connect the LDT accounts in Metricool: app.metricool.com → add a new Brand " +
  "('Lifestyle Design Technologies') → connect Instagram @lifestyledesigntechnologies " +
  "(must be a Professional account linked to a Facebook Page for auto-publish) and " +
  "TikTok @lifestyledesigntech. No new repo secrets are needed — the lane finds the " +
  "brand by handle. Full steps: auto-poster/LDT-SETUP.md";

async function notify(outcome, reason, remedy, detail) {
  try {
    await notifyDailyFailure({ pipeline: "LDT", label: "brand lane", outcome, reason, remedy, detail });
  } catch (err) {
    console.error(`[LDT] Notification failed: ${err.message}`);
  }
}

/** Which of the connected platforms still have cadence + gap budget. */
function resolvePostablePlatforms(log, connected, cadence, brand) {
  const gap = minGapOk(log, BRAND_KEY, brand.minGapHours);
  if (!gap.ok) {
    console.log(`[LDT] Min-gap guard: last post ${gap.lastPostAt}, ${Math.ceil(gap.waitMs / 60000)} min still to wait — skipping this slot`);
    return [];
  }
  const postable = [];
  for (const platform of connected) {
    const check = cadenceAllows(log, BRAND_KEY, platform, cadence);
    if (check.allowed) {
      postable.push(platform);
    } else {
      console.log(`[LDT] Cadence guard: ${platform} already at ${check.used}/${check.limit} today — withholding`);
    }
  }
  return postable;
}

/**
 * Post one intake clip. Throws ONLY while nothing has been published yet —
 * once createSingleBrandPost succeeds, every later failure is contained and
 * reported on the result, so the candidate loop can never react to a
 * post-success hiccup by publishing a second clip in the same slot.
 */
async function postClip(candidate, { log, brand, claims, blogId, label, platforms }) {
  console.log(`\n[LDT] Trying clip: ${candidate.name} (${candidate.id})`);
  const tmpPath = join(tmpdir(), `ldt_${Date.now()}.mp4`);
  const buffer = await downloadVideo(candidate.id, candidate.name);
  writeFileSync(tmpPath, buffer);

  try {
    const qc = await prePostQualityCheck(tmpPath, {
      requireVertical: brand.qc?.requireVertical !== false,
      visionContent: brand.qc?.visionContent,
    });
    if (!qc.ok) {
      throw new Error(`[QC] FAILED: ${qc.reason}`);
    }

    const { caption, hookStyle, source, generation } = await generateLdtCaption({
      kind: "clip", clipName: candidate.name, brand, claims, log,
    });

    if (DRY_RUN) {
      console.log("[LDT DRY_RUN] ═══════ CAPTION ═══════");
      console.log(caption);
      console.log("[LDT DRY_RUN] ═══════ END ═══════");
    }

    let uploadBuf = readFileSync(tmpPath);
    if (uploadBuf.length > MAX_UPLOAD_BYTES) {
      console.log(`[LDT] Clip is ${(uploadBuf.length / 1024 / 1024).toFixed(1)}MB — compressing to fit the upload cap...`);
      const compressed = compressVideoToFit(uploadBuf, MAX_UPLOAD_BYTES);
      if (!compressed) throw new Error("Compression failed — clip exceeds the 95MB upload cap");
      uploadBuf = compressed.buffer;
    }

    let mediaUrl = "https://ldt-dry-run-placeholder.example.com/clip.mp4";
    if (!DRY_RUN) {
      const sha256b64 = createHash("sha256").update(uploadBuf).digest("base64");
      console.log(`[LDT] Uploading ${(uploadBuf.length / 1024 / 1024).toFixed(1)}MB to brand ${label} (${blogId})...`);
      mediaUrl = await uploadToBrand(blogId, { buf: uploadBuf, sha256b64 });
    }

    // ── PUBLISH. From here on, nothing may throw out of this function. ──
    const result = await createSingleBrandPost({
      blogId, label, mediaUrl, caption, networks: platforms, dryRun: DRY_RUN,
    });

    try {
      if (!DRY_RUN) {
        recordPost(log, {
          brand: BRAND_KEY,
          type: "ldt_clip",
          driveFileId: candidate.id,
          fileName: candidate.name,
          // city/slot make LDT clip entries first-class citizens of the
          // learn step (reelEntries requires both); "ldt" is never a city
          // any realty guard queries.
          city: BRAND_KEY,
          slot: chicagoSlot(),
          caption,
          caption_source: source,
          hook_style: hookStyle,
          generation,
          platforms,
          blogId,
          postId: result.brands[0]?.postId || null,
          success: true,
        });
      }
    } catch (err) {
      // The clip is LIVE but unrecorded — a future run would repost it.
      // Contained here (not thrown) so the loop cannot post a second clip.
      console.error(`[LDT] CRITICAL: clip posted but posted-log write failed: ${err.message}`);
      result.recordFailed = err;
    }
    return result;
  } finally {
    try { unlinkSync(tmpPath); } catch {}
  }
}

/** Post today's promo carousel. Same containment rule after scheduling. */
async function postPromo({ log, brand, claims, blogId, label, platforms }) {
  const today = chicagoDayOf(new Date());
  const angle = angleForDate(today, claims);
  console.log(`\n[LDT] Promo lane — angle: ${angle.key}`);

  // The deck copy passes the same claims gate as captions. A drifted edit to
  // the angle table fails here at runtime as well as in CI.
  const deckCheck = checkClaimsCompliance(promoDeckText(angle, brand, claims), claims);
  if (!deckCheck.ok) {
    throw new Error(`[LDT Promo] Deck copy failed the claims gate: ${describeViolations(deckCheck.violations)}`);
  }

  const { caption, generation } = await generateLdtCaption({ kind: "promo", angle: angle.key, brand, claims, log });
  const { pngs, jpegs } = await renderPromoDeck(angle, brand, claims);
  console.log(`[LDT] Rendered ${pngs.length} promo slides (self-QC passed)`);

  if (DRY_RUN) {
    console.log("[LDT DRY_RUN] ═══════ PROMO CAPTION ═══════");
    console.log(caption);
    console.log("[LDT DRY_RUN] ═══════ END ═══════");
    return { ok: true, dryRun: true };
  }

  const publishAt = chicagoDateTime();
  const results = [];
  if (platforms.includes("instagram")) {
    const urls = await uploadSlides(blogId, pngs, "image/png");
    const res = await schedulePost(blogId, instagramCarouselBody(urls, caption, publishAt));
    results.push({ network: "instagram", ...res });
  }
  if (platforms.includes("tiktok")) {
    const urls = await uploadSlides(blogId, jpegs, "image/jpeg");
    const res = await schedulePost(blogId, tiktokCarouselBody(urls, caption, publishAt));
    results.push({ network: "tiktok", ...res });
  }

  const okResults = results.filter(r => r.ok);
  const failed = results.filter(r => !r.ok);
  if (okResults.length === 0 && results.length > 0) {
    throw new Error(`All promo networks failed: ${failed.map(f => `${f.network}: ${f.error}`).join("; ")}`);
  }
  for (const f of failed) {
    console.warn(`::warning::[LDT] Promo ${f.network} failed: ${f.error}`);
  }

  const out = { ok: true, results, verification: null };
  try {
    recordPost(log, {
      brand: BRAND_KEY,
      type: "ldt_promo",
      driveFileId: `promo:${today}:${angle.key}`,
      fileName: `promo-${angle.key}-${today}`,
      city: BRAND_KEY,
      slot: chicagoSlot(),
      caption,
      promo_angle: angle.key,
      generation,
      platforms: okResults.map(r => r.network),
      blogId,
      postIds: okResults.map(r => ({ network: r.network, postId: r.postId })),
      success: true,
    });
  } catch (err) {
    console.error(`[LDT] CRITICAL: promo posted but posted-log write failed: ${err.message}`);
    out.recordFailed = err;
    return out;
  }

  // Verify what actually PUBLISHED — scheduler acceptance is not publication
  // (the 2026-08-03 'image/png not allowed' class failed exactly there).
  try {
    const targets = okResults
      .filter(r => r.postId && r.postId !== "unknown")
      .map(r => ({ label, ok: true, postId: r.postId, blogId, providers: [r.network] }));
    if (targets.length > 0) {
      const verified = await verifyReelPublication(targets);
      if (verified.verification) {
        const idx = log.posts.length - 1;
        log.posts[idx] = applyReelVerification(log.posts[idx], verified);
        saveLog(log);
        out.verification = verified.verification;
      }
    }
  } catch (err) {
    console.warn(`[LDT] Promo verification could not run (non-fatal): ${err.message}`);
  }
  return out;
}

async function main() {
  console.log("=".repeat(60));
  console.log(`[LDT] Brand lane starting — mode: ${MODE}, ${DRY_RUN ? "DRY RUN" : "LIVE"}`);
  console.log(`[LDT] Time: ${new Date().toLocaleString("en-US", { timeZone: "America/Chicago" })} CT`);
  console.log("=".repeat(60));

  const registry = loadBrandRegistry();
  const brand = registry.brands?.[BRAND_KEY];
  if (!brand) throw new Error("brands.json has no 'ldt' brand");
  const claims = loadLdtClaims();

  // Cadence config is validated FIRST — an over-cap config is refused before
  // any discovery or download happens.
  const cadence = resolveCadence(brand, registry);

  const folderId = process.env[brand.contentSources?.intakeFolderEnv || "LDT_INTAKE_FOLDER_ID"];

  // A pin must be honorable before anything else runs — a FORCE dispatch
  // that quietly does something else (or nothing) is worse than a red run.
  if (FORCE_VIDEO_ID) {
    if (MODE === "promo") {
      console.error("[LDT] FORCE_VIDEO_ID with MODE=promo makes no sense — a pin names a clip. Aborting.");
      process.exit(1);
    }
    if (!folderId) {
      console.error("[LDT] FORCE_VIDEO_ID is set but the intake folder env is not configured — nothing to pin against. Aborting.");
      process.exit(1);
    }
  }

  const log = loadLog();

  // Resolve the LDT Metricool profile — fail-closed.
  const profiles = await listProfiles();
  if (!profiles) {
    await notify(OUTCOME.FAILED, "Could not list Metricool profiles (API unreachable). Nothing was posted.",
      "Check Metricool status and the METRICOOL_API_TOKEN secret, then re-run.");
    process.exit(1);
  }
  const ldtProfiles = findBrandProfiles(profiles, brand);
  if (ldtProfiles.length === 0) {
    console.log(`::warning::[LDT] No Metricool profile matches the LDT handles yet — nothing to post to.`);
    await notify(OUTCOME.NOTHING_TO_POST,
      "The LDT accounts are not connected in Metricool yet, so the LDT lane has nowhere to post. This is expected until the one-time connect is done.",
      CONNECT_STEPS);
    process.exit(0);
  }
  const profile = ldtProfiles[0];
  const blogId = Number(profile.id || profile.blogId);
  const label = String(profile.label || blogId);
  console.log(`[LDT] Target brand resolved: "${label}" (blogId ${blogId}) — IG: ${profile.instagram || "not connected"}, TikTok: ${profile.tiktok || "not connected"}`);

  const connected = [];
  if (profile.instagram) connected.push("instagram");
  if (profile.tiktok) connected.push("tiktok");
  if (!blogId || connected.length === 0) {
    // The brand exists (label matched) but is not postable yet. This must be
    // the connect notice, NOT a silent "cadence" green — a half-finished
    // connect would otherwise look identical to a correctly resting lane.
    await notify(OUTCOME.NOTHING_TO_POST,
      `The LDT brand exists in Metricool ("${label}") but ${!blogId ? "has no usable blogId" : "neither Instagram nor TikTok is connected on it yet"} — the lane cannot post.`,
      CONNECT_STEPS);
    process.exit(0);
  }

  // The LDT learning brief (learning/brief-ldt.json) is built by the weekly
  // learning-loop workflow — "ldt" is on its BRANDS roster — and consumed at
  // caption time via the variation engine. Nothing to refresh here.

  const platforms = resolvePostablePlatforms(log, connected, cadence, brand);
  if (platforms.length === 0) {
    if (FORCE_VIDEO_ID) {
      console.error("[LDT] FORCE_VIDEO_ID dispatch refused: the cadence/min-gap budget for today is spent. The pin was NOT posted.");
      process.exit(1);
    }
    console.log("[LDT] Cadence/gap guards leave no platform to post to — correct behavior, exiting green.");
    process.exit(0);
  }
  console.log(`[LDT] Postable platforms this run: ${platforms.join(", ")}`);

  // ─── Intake clips ──────────────────────────────────────────────────────────
  let clipError = null;
  let clipCandidateCount = 0;
  if (MODE !== "promo" && folderId) {
    const blocklist = loadBlocklist();
    const files = await listFolderFiles(folderId);
    const { eligible, skipped } = pickIntakeCandidates(files, log, blocklist);
    console.log(`[LDT] Intake folder: ${files.length} files, ${eligible.length} eligible, ${skipped.length} skipped`);
    for (const s of skipped.slice(0, 5)) console.log(`  - ${s.file?.name}: ${s.reason}`);

    let candidates = eligible;
    if (FORCE_VIDEO_ID) {
      candidates = files.filter(f => f.id === FORCE_VIDEO_ID);
      if (candidates.length === 0) {
        console.error(`[LDT] FORCE_VIDEO_ID ${FORCE_VIDEO_ID} not found in the intake folder. Aborting.`);
        process.exit(1);
      }
      console.log(`[LDT] FORCE_VIDEO_ID pinned: ${candidates[0].name}`);
    }
    clipCandidateCount = candidates.length;

    let postResult = null;
    let postedCandidate = null;
    for (const candidate of candidates) {
      try {
        postResult = await postClip(candidate, { log, brand, claims, blogId, label, platforms });
        postedCandidate = candidate;
        break;
      } catch (err) {
        clipError = err;
        console.error(`[LDT] Clip failed: ${err.message}`);
        const msg = err.message || "";
        const inherent = msg.includes("Too short") || msg.includes("Too long") || msg.includes("corrupted") ||
          msg.includes("No video stream") || msg.includes("File too small") || msg.includes("File too large") ||
          msg.includes("AI vision:");
        if (inherent && !DRY_RUN) {
          const bl = loadBlocklist();
          blocklistVideo(bl, candidate.id, candidate.name, msg.replace(/^\[QC\] FAILED: /, ""));
          console.log(`[LDT] Blocklisted ${candidate.name} (inherent failure)`);
        }
        console.log("[LDT] Trying next candidate...");
      }
    }

    if (postResult) {
      if (postResult.recordFailed) {
        await notify(OUTCOME.FAILED,
          `The LDT clip ${postedCandidate.name} POSTED but the posted-log write failed (${postResult.recordFailed.message}). ` +
          `Until an entry exists, a future run may repost this clip.`,
          "Check the run log; if merge-log-push also failed, add the entry to posted-log.json by hand.");
        process.exit(1);
      }
      // Verify what actually published — read-only, never throws to the loop.
      if (!DRY_RUN) {
        try {
          const entryIdx = log.posts.length - 1;
          const entry = log.posts[entryIdx];
          if (entry?.postId) {
            const verified = await verifyReelPublication([
              { label, ok: true, postId: entry.postId, blogId, providers: platforms },
            ]);
            if (verified.verification) {
              log.posts[entryIdx] = applyReelVerification(entry, verified);
              saveLog(log);
              if (verified.verification.anyFailed) {
                await notify(OUTCOME.UNVERIFIED,
                  "The LDT clip posted but Metricool reported a provider as FAILED. posted-log already records this slot.",
                  "Open Metricool, check the post, and publish the failed network manually if needed.");
                process.exit(1);
              }
            }
          }
        } catch (err) {
          console.warn(`[LDT] Clip verification could not run (non-fatal): ${err.message}`);
        }
      }
      console.log(`\n[LDT] ✓ Done — posted clip ${postedCandidate.name}`);
      process.exit(0);
    }

    if (clipCandidateCount > 0 && clipError) {
      await notify(OUTCOME.FAILED,
        `Every eligible intake clip failed${FORCE_VIDEO_ID ? " (including the pinned one)" : ""}. Last error: ${clipError.message}`,
        "Check the run log; if the clips themselves are bad they are now blocklisted.", clipError.stack);
      process.exit(1);
    }
  } else if (MODE !== "promo" && !folderId) {
    console.log(`::warning::[LDT] ${brand.contentSources?.intakeFolderEnv || "LDT_INTAKE_FOLDER_ID"} is not set — intake lane disabled until it is.`);
  }

  // ─── Promo fallback (never for a FORCE dispatch — a pin names a clip) ──────
  const promoAllowed = !FORCE_VIDEO_ID &&
    (MODE === "promo" || (MODE === "auto" && brand.contentSources?.promoWhenNoClip));
  if (promoAllowed) {
    if (hasBrandPromoToday(log, BRAND_KEY)) {
      console.log("[LDT] Today's promo already posted — one per day, exiting green.");
      process.exit(0);
    }
    try {
      const res = await postPromo({ log, brand, claims, blogId, label, platforms });
      if (res.recordFailed) {
        await notify(OUTCOME.FAILED,
          `The LDT promo POSTED but the posted-log write failed (${res.recordFailed.message}). Until an entry exists, the next slot would post today's promo again.`,
          "Check the run log; add the entry to posted-log.json by hand if needed.");
        process.exit(1);
      }
      if (res.verification?.anyFailed) {
        await notify(OUTCOME.UNVERIFIED,
          "The LDT promo was accepted by Metricool but a provider reported FAILED.",
          "Open Metricool, check the post, and publish the failed network manually if needed.");
        process.exit(1);
      }
      console.log("\n[LDT] ✓ Done — posted promo");
      process.exit(0);
    } catch (err) {
      await notify(OUTCOME.FAILED, `Promo generation/post failed: ${err.message}`,
        "Check the run log — if the claims gate refused the deck, ldt-claims.json and ldt-promo.js have drifted apart.", err.stack);
      process.exit(1);
    }
  }

  // Nothing posted and nothing failed loudly yet: say so.
  await notify(OUTCOME.NOTHING_TO_POST,
    folderId
      ? "The intake folder has no eligible clips and the promo lane is disabled — nothing to post."
      : "No intake folder is configured (LDT_INTAKE_FOLDER_ID) and the promo lane is disabled — the LDT lane has no content source.",
    folderId
      ? "Drop new screen recordings into the LDT intake folder, or enable contentSources.promoWhenNoClip in brands.json."
      : "Create the intake Drive folder, share it with the poster's Google account, and set the LDT_INTAKE_FOLDER_ID secret. See auto-poster/LDT-SETUP.md.");
  process.exit(0);
}

main().catch(async err => {
  console.error("[LDT] Fatal error:", err);
  await notify(OUTCOME.FAILED, `Unhandled failure: ${err.message}`, "Check the run log.", err.stack);
  process.exit(1);
});
