/**
 * Lifestyle Design Technologies — LDT brand lane (brand 2).
 *
 * Posts to the LDT accounts ONLY (IG @lifestyledesigntechnologies, TikTok
 * @lifestyledesigntech, and the LDT Facebook Page), resolved by handle from
 * brands.json against the Metricool profile list. FAIL-CLOSED: no matching
 * profile means no post and a loud notice with the connect steps — never a
 * fallback to "all brands".
 *
 * PLATFORM SHAPES differ by medium, and Metricool cares:
 *   - images (carousel, card) — one scheduler call PER NETWORK, each with
 *     that network's *Data block: instagram/facebook take the PNGs
 *     (facebookData type POST), tiktok its own JPEG copy (it rejects PNG at
 *     publish). The PNGs upload once and are shared, as the realty carousel
 *     fan-out does.
 *   - video (clip, text reel) — ONE scheduler call carrying every provider,
 *     with instagramData REEL / tiktokData VIDEO / facebookData REEL. That
 *     asymmetry is Metricool's, not ours: the video endpoint fans out across
 *     providers, the image bodies do not.
 *
 * CONTENT — the fillPlan walk (ldt-slot-filler.js), in priority order:
 *   1. Operator-supplied clips from the intake Drive folder
 *      (LDT_INTAKE_FOLDER_ID) — screen recordings of PRIMARY working —
 *      QC'd, captioned in the LDT voice, posted once each, oldest first.
 *   2. The self-made chain when no clip lands and the config allows it:
 *      the 8-slide narrative carousel leads, the promo card and the silent
 *      text-motion reel alternate behind it (no-immediate-repeat rotation).
 *      Each format posts at most ONCE per day (the angle is deterministic
 *      per date; a second would tell the same story) — per-format dedup, on
 *      top of cadence. A generator that fails hands the slot to the next
 *      format, never to silence.
 *
 * GUARDS, in the order they run:
 *   - resolveCadence: refuses (red run) any configured cadence above the
 *     6/day hard cap, warns above the 2/day default. Runs before anything.
 *   - Connect gates: profile missing → loud notice with connect steps;
 *     profile present but no networks connected yet → the same notice, not
 *     a silent green.
 *   - minGap + per-platform daily cadence: a slot that would exceed either
 *     exits green and says so, and gates the WHOLE walk — clips and
 *     self-made alike; nothing posts on a platform without budget. A
 *     FORCE_VIDEO_ID dispatch blocked by cadence exits RED instead — a pin
 *     that did nothing must never look green. A pin also short-circuits ALL
 *     self-made fallback: a pin names a clip, and a blocked pin exits red
 *     rather than quietly posting a generated piece.
 *   - Claims gate: every caption is checked against ldt-claims.json;
 *     ungateable captions fall back to the pinned caption, which is itself
 *     gate-checked in CI. Every self-made format's full visible copy is
 *     gate-checked AGAIN at runtime, before rendering — CI sweeps the same
 *     text, but the runner never renders copy this process hasn't blessed.
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
import { pickIntakeCandidates, hasBrandTypeToday } from "./ldt-intake.js";
import { generateLdtCaption, pickLdtVariation } from "./ldt-caption.js";
import { loadLdtClaims, checkClaimsCompliance, describeViolations } from "./ldt-claims-gate.js";
import { selfMadePlan, selfMadeAllowed, todaysSelfMadeAngles, chicagoSlot } from "./ldt-slot-filler.js";
import { pickAngle, deckText, renderNarrativeDeck } from "./ldt-carousel-gen.js";
import { cardText, renderCard } from "./ldt-card-gen.js";
import { reelText, renderTextReel } from "./ldt-text-reel.js";
import { prePostQualityCheck } from "./quality-check.js";
import { loadLog, saveLog, recordPost, loadBlocklist, blocklistVideo } from "./state.js";
import { verifyReelPublication, applyReelVerification } from "./reel-verify.js";
import { uploadSlides, schedulePost, instagramCarouselBody, tiktokCarouselBody, facebookCarouselBody, chicagoDateTime } from "./carousel-distribute.js";
import { notifyDailyFailure, OUTCOME } from "./daily-notify.js";
import { routeWarnChannel } from "./yt-evidence.js";
routeWarnChannel();

const DRY_RUN = process.env.DRY_RUN === "true";
// auto | clip | selfmade. "promo" is the retired name for the generated-only
// mode — honored as an alias so a stale dispatch or muscle memory still runs.
const MODE_RAW = process.env.MODE || "auto";
const MODE = MODE_RAW === "promo" ? "selfmade" : MODE_RAW;
const FORCE_VIDEO_ID = process.env.FORCE_VIDEO_ID || "";
const BRAND_KEY = "ldt";

const CONNECT_STEPS =
  "Connect the LDT accounts in Metricool: app.metricool.com → add a new Brand " +
  "('Lifestyle Design Technologies') → connect Instagram @lifestyledesigntechnologies " +
  "(must be a Professional account linked to a Facebook Page for auto-publish), " +
  "TikTok @lifestyledesigntech, and the Facebook Page itself. No new repo secrets " +
  "are needed — the lane finds the brand by handle and reads the connected networks " +
  "off the profile. Full steps: auto-poster/LDT-SETUP.md";

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

    const { caption, hookStyle, source, generation, voice } = await generateLdtCaption({
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
          voice,
          // Operator clips never carry the meta closer: a human filmed the
          // screen recording, so "posted by PRIMARY" would be false. Stamped
          // explicitly as null so the learn step can tell "no closer" from
          // "an older entry that predates closers".
          meta_closer: null,
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

/**
 * Post one self-made piece — kind: "carousel" | "card" | "text_reel".
 *
 * The slot's variation plan and angle are picked ONCE by the caller and
 * shared across every format the walk tries, so the rendered hook line and
 * the caption always tell the same story in the same style, whichever
 * generator ends up landing.
 *
 * Throws ONLY while nothing has been published yet (gate refusal, render
 * failure, every network failing) — the walk reacts to a throw by trying the
 * next format. Same containment rule as postClip after publishing: a
 * post-success hiccup is contained and reported on the result, never thrown.
 */
async function postSelfMade(kind, { log, brand, claims, blogId, label, platforms, variation, angle }) {
  const today = chicagoDayOf(new Date());
  const style = variation.hook_style;
  console.log(`\n[LDT] Self-made lane — format: ${kind}, angle: ${angle.key}, hook style: ${style}`);

  // Runtime claims gate BEFORE rendering. CI sweeps every angle × style ×
  // format through the same gate, but the runner must never render copy this
  // process hasn't blessed — a drifted angle-table edit fails here too.
  const textOf = {
    carousel: () => deckText(angle, style, { claims, brand }),
    card: () => cardText(angle, style, { claims, brand }),
    text_reel: () => reelText(angle, style, { claims, brand }),
  };
  const gateCheck = checkClaimsCompliance(textOf[kind](), claims);
  if (!gateCheck.ok) {
    throw new Error(`[LDT ${kind}] Copy failed the claims gate: ${describeViolations(gateCheck.violations)}`);
  }

  const { caption, source, generation, voice, metaCloser } = await generateLdtCaption({
    kind, angle: angle.key, brand, claims, log, variation,
  });

  // ── Render (every renderer self-QCs its own output) ──
  let images = null;   // { pngs, jpegs } for carousel/card
  let videoPath = null; // for text_reel
  if (kind === "carousel") {
    const deck = await renderNarrativeDeck(angle, style, { claims, brand });
    console.log(`[LDT] Rendered ${deck.slideCount} carousel slides (self-QC passed)`);
    images = deck;
  } else if (kind === "card") {
    images = await renderCard(angle, style, { claims, brand });
    console.log("[LDT] Rendered the promo card (self-QC passed)");
  } else {
    const reel = await renderTextReel(angle, style, { claims, brand });
    if (!reel.ok) {
      throw new Error(`[LDT text_reel] Render failed: ${reel.reason}`);
    }
    console.log(`[LDT] Rendered the text reel (${reel.duration_seconds.toFixed(1)}s, structural check passed)`);
    videoPath = reel.videoPath;
  }

  try {
    if (DRY_RUN) {
      console.log(`[LDT DRY_RUN] ═══════ ${kind.toUpperCase()} CAPTION ═══════`);
      console.log(caption);
      console.log("[LDT DRY_RUN] ═══════ END ═══════");
      return { ok: true, dryRun: true };
    }

    // ── Publish ──
    const okResults = [];
    if (videoPath) {
      let uploadBuf = readFileSync(videoPath);
      if (uploadBuf.length > MAX_UPLOAD_BYTES) {
        const compressed = compressVideoToFit(uploadBuf, MAX_UPLOAD_BYTES);
        if (!compressed) throw new Error("Compression failed — text reel exceeds the 95MB upload cap");
        uploadBuf = compressed.buffer;
      }
      const sha256b64 = createHash("sha256").update(uploadBuf).digest("base64");
      const mediaUrl = await uploadToBrand(blogId, { buf: uploadBuf, sha256b64 });
      const result = await createSingleBrandPost({
        blogId, label, mediaUrl, caption, networks: platforms, dryRun: false,
      });
      okResults.push({ networks: platforms, postId: result.brands[0]?.postId || null });
    } else {
      const publishAt = chicagoDateTime();
      const results = [];
      // Slides are uploaded ONCE per encoding and reused by every network that
      // accepts it — the realty carousel's proven shape (distributeCarousel):
      // the lossless PNGs serve Instagram AND Facebook, and only TikTok needs
      // its own JPEG copy because it rejects PNG at publish time. So adding
      // Facebook costs a scheduler call, not another upload of the deck.
      const uploads = {};
      const urlsFor = (encoding) => {
        if (!uploads[encoding]) {
          uploads[encoding] = encoding === "jpeg"
            ? uploadSlides(blogId, images.jpegs, "image/jpeg")
            : uploadSlides(blogId, images.pngs, "image/png");
        }
        return uploads[encoding];
      };
      // Per-network throws are contained as failed results: once ONE network
      // has scheduled, a throw here would send the walk to the next format on
      // top of a live post. All-networks-failed still throws below, where
      // nothing has published yet.
      const targets = [
        { network: "instagram", encoding: "png", body: instagramCarouselBody },
        { network: "facebook", encoding: "png", body: facebookCarouselBody },
        { network: "tiktok", encoding: "jpeg", body: tiktokCarouselBody },
      ];
      for (const net of targets) {
        if (!platforms.includes(net.network)) continue;
        try {
          const urls = await urlsFor(net.encoding);
          const res = await schedulePost(blogId, net.body(urls, caption, publishAt));
          results.push({ network: net.network, ...res });
        } catch (err) {
          results.push({ network: net.network, ok: false, error: err.message });
        }
      }
      const failed = results.filter(r => !r.ok);
      if (results.every(r => !r.ok) && results.length > 0) {
        throw new Error(`All ${kind} networks failed: ${failed.map(f => `${f.network}: ${f.error}`).join("; ")}`);
      }
      for (const f of failed) {
        console.warn(`::warning::[LDT] ${kind} ${f.network} failed: ${f.error}`);
      }
      for (const r of results.filter(x => x.ok)) {
        okResults.push({ networks: [r.network], postId: r.postId });
      }
    }

    // ── From here on, nothing may throw out of this function. ──
    const postedNetworks = okResults.flatMap(r => r.networks);
    const out = { ok: true, verification: null };
    try {
      recordPost(log, {
        brand: BRAND_KEY,
        type: `ldt_${kind}`,
        driveFileId: `selfmade:${today}:${kind}:${angle.key}`,
        fileName: `${kind}-${angle.key}-${today}`,
        // city/slot make self-made entries first-class citizens of the learn
        // step; "ldt" is never a city any realty guard queries.
        city: BRAND_KEY,
        slot: chicagoSlot(),
        caption,
        caption_source: source,
        // The DECK's visible hook line is the planned style even when the
        // caption fell back to pinned copy — the rotation must exclude what
        // the feed actually shows.
        hook_style: style,
        angle: angle.key,
        // Voice and closer are stamped top-level as well as inside
        // `generation`, so the learn step can group on them directly and a
        // human reading posted-log.json can see which voice spoke and
        // whether the meta line rode along.
        voice,
        meta_closer: metaCloser || null,
        generation,
        platforms: postedNetworks,
        blogId,
        postIds: okResults.map(r => ({ networks: r.networks, postId: r.postId })),
        success: true,
      });
    } catch (err) {
      console.error(`[LDT] CRITICAL: ${kind} posted but posted-log write failed: ${err.message}`);
      out.recordFailed = err;
      return out;
    }

    // Verify what actually PUBLISHED — scheduler acceptance is not
    // publication (the 2026-08-03 'image/png not allowed' class failed
    // exactly there).
    try {
      const targets = okResults
        .filter(r => r.postId && r.postId !== "unknown")
        .map(r => ({ label, ok: true, postId: r.postId, blogId, providers: r.networks }));
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
      console.warn(`[LDT] ${kind} verification could not run (non-fatal): ${err.message}`);
    }
    return out;
  } finally {
    if (videoPath) { try { unlinkSync(videoPath); } catch {} }
  }
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
    if (MODE === "selfmade") {
      console.error("[LDT] FORCE_VIDEO_ID with MODE=selfmade makes no sense — a pin names a clip. Aborting.");
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
  console.log(`[LDT] Target brand resolved: "${label}" (blogId ${blogId}) — IG: ${profile.instagram || "not connected"}, TikTok: ${profile.tiktok || "not connected"}, Facebook: ${profile.facebook || "not connected"}`);

  // The postable set is read off the RESOLVED PROFILE's connected networks,
  // not from brands.json handles: handles identify which profile is LDT's,
  // and the profile itself is the source of truth for what is connected on
  // it. So a Page connected in Metricool is picked up with no config change,
  // and one disconnected there stops being targeted the same way.
  const connected = [];
  if (profile.instagram) connected.push("instagram");
  if (profile.tiktok) connected.push("tiktok");
  if (profile.facebook) connected.push("facebook");
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

  // The self-made chain may run only when no pin is set and the mode/config
  // allow generation — decided ONCE, because the clip section's failure
  // handling depends on whether a degrade path exists.
  const selfMadeCan = selfMadeAllowed({ mode: MODE, forceVideoId: FORCE_VIDEO_ID, brand });

  // ─── The fillPlan walk, part 1: intake clips, oldest first ─────────────────
  let clipError = null;
  let clipCandidateCount = 0;
  if (MODE !== "selfmade" && folderId) {
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
      // A FORCE pin never degrades (selfMadeCan is false with a pin set):
      // a pin that did not post is a red run. Without a pin, the fillPlan
      // doctrine applies — every clip failing hands the slot to the
      // self-made chain, never to silence — but Peter still hears that the
      // clips are broken.
      if (!selfMadeCan) {
        await notify(OUTCOME.FAILED,
          `Every eligible intake clip failed${FORCE_VIDEO_ID ? " (including the pinned one)" : ""}. Last error: ${clipError.message}`,
          "Check the run log; if the clips themselves are bad they are now blocklisted.", clipError.stack);
        process.exit(1);
      }
      console.warn(`::warning::[LDT] Every eligible intake clip failed (${clipError.message}) — degrading to the self-made chain, not to silence.`);
      await notify(OUTCOME.FAILED,
        `Every eligible intake clip failed (last error: ${clipError.message}). The slot is degrading to a self-made post; the clips need a look.`,
        "Check the run log; clips with inherent failures are now blocklisted.", clipError.stack);
    }
  } else if (MODE !== "selfmade" && !folderId) {
    console.log(`::warning::[LDT] ${brand.contentSources?.intakeFolderEnv || "LDT_INTAKE_FOLDER_ID"} is not set — intake lane disabled until it is.`);
  }

  // ─── The fillPlan walk, part 2: the self-made chain ────────────────────────
  // (Never for a FORCE dispatch — a pin names a clip; selfMadeAllowed owns
  // that rule.)
  if (selfMadeCan) {
    const today = chicagoDayOf(new Date());
    // ONE variation plan and ONE angle per slot: every format the walk tries
    // renders the same story in the same hook style, and the caption engine
    // is handed the same plan — whichever generator lands, the entry's tags
    // describe what was actually published.
    const variation = pickLdtVariation(log);
    // Exclude every angle already used TODAY, and only today. Excluding
    // yesterday's too starves an angle out of the table; excluding only the
    // NEWEST of today's lets slot 3 land back on slot 1's story. See
    // todaysSelfMadeAngles.
    const angle = pickAngle({ claims, dateStr: today, previousAngle: todaysSelfMadeAngles(log, BRAND_KEY) });

    const plan = selfMadePlan({ log, brandKey: BRAND_KEY });
    console.log(`[LDT] Self-made plan for this slot: ${plan.join(" → ")}`);

    let selfMadeError = null;
    let attempted = 0;
    for (const kind of plan) {
      // Per-format-per-day dedup, on top of cadence: the angle is
      // deterministic per date, so a second same-day post of one format
      // would tell the same story — the walk skips to a format today has
      // not seen.
      if (hasBrandTypeToday(log, BRAND_KEY, `ldt_${kind}`)) {
        console.log(`[LDT] A ${kind} already posted today (one per format per day) — trying the next format`);
        continue;
      }
      attempted++;
      try {
        const res = await postSelfMade(kind, { log, brand, claims, blogId, label, platforms, variation, angle });
        if (res.recordFailed) {
          await notify(OUTCOME.FAILED,
            `The LDT ${kind} POSTED but the posted-log write failed (${res.recordFailed.message}). Until an entry exists, the next slot would post this format again today.`,
            "Check the run log; add the entry to posted-log.json by hand if needed.");
          process.exit(1);
        }
        if (res.verification?.anyFailed) {
          await notify(OUTCOME.UNVERIFIED,
            `The LDT ${kind} was accepted by Metricool but a provider reported FAILED.`,
            "Open Metricool, check the post, and publish the failed network manually if needed.");
          process.exit(1);
        }
        console.log(`\n[LDT] ✓ Done — posted self-made ${kind}`);
        process.exit(0);
      } catch (err) {
        selfMadeError = err;
        console.error(`[LDT] Self-made ${kind} failed: ${err.message}`);
        console.log("[LDT] Trying the next format...");
      }
    }

    if (attempted > 0 && selfMadeError) {
      await notify(OUTCOME.FAILED,
        `Every self-made format failed. Last error: ${selfMadeError.message}`,
        "Check the run log — if the claims gate refused the copy, ldt-claims.json and the angle tables have drifted apart.",
        selfMadeError.stack);
      process.exit(1);
    }
    if (attempted === 0) {
      // Nothing was even tried: every format has already posted today. Green
      // when the lane is simply out of new things to say — but RED when we
      // only got here because every intake clip failed. A degrade that
      // degrades into nothing is a slot where something broke and nothing
      // published; exiting green there would report post_success=true and
      // make it indistinguishable from a healthy run.
      if (clipError) {
        console.error("[LDT] Every intake clip failed AND every self-made format has already posted today — nothing published this slot.");
        await notify(OUTCOME.FAILED,
          `Every eligible intake clip failed (${clipError.message}) and the self-made chain had nothing left to post today (every format is already used), so NOTHING went out this slot.`,
          "Check the run log — the clips need attention; inherent failures are now blocklisted.", clipError.stack);
        process.exit(1);
      }
      console.log("[LDT] Every self-made format has already posted today — per-format dedup, exiting green.");
      process.exit(0);
    }
  }

  // Nothing posted and nothing failed loudly yet: say so.
  await notify(OUTCOME.NOTHING_TO_POST,
    folderId
      ? "The intake folder has no eligible clips and the self-made lane is disabled — nothing to post."
      : "No intake folder is configured (LDT_INTAKE_FOLDER_ID) and the self-made lane is disabled — the LDT lane has no content source.",
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
