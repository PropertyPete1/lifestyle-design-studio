/**
 * yt-pipeline-main.js — the scheduled job that advances whatever is ready.
 *
 * The long-form cycle waits on a human twice, and a human does not answer on a
 * cron. So rather than a Monday job and a Friday job that each assume the
 * previous step happened, this runs on a schedule, looks at where the pipeline
 * actually is, and advances it one step — or exits cleanly having done nothing,
 * which is the NORMAL outcome most of the time it runs.
 *
 * "Exits cleanly having done nothing" is the important behaviour. A run that
 * finds no decision is not a failure and must not look like one, or the alerts
 * become noise and the real failures stop being read.
 *
 * Stages this handles:
 *   topic_pick approved   ->  write the script, deliver the recording kit
 *   topic_pick rejected   ->  fold Peter's notes into a fresh brief
 *   kit delivered         ->  ingest recordings; assemble and upload PRIVATE
 *                             once every on-camera take is present
 *   video_review approved ->  record the approval (this does NOT publish)
 *   video_review rejected ->  keep the notes for the rework
 *
 * NOTHING HERE PUBLISHES. Approving a video records it and unlocks the Shorts
 * cutdowns; Peter flips it to public himself in Studio, where he also sets the
 * two things Metricool's API cannot reach. See yt-publish.js.
 */

import { loadLog, getRecentlyPostedIdsAllCities } from "./state.js";
import Anthropic from "@anthropic-ai/sdk";

import { getAccessToken, downloadVideo } from "./drive.js";
import { join } from "path";
import { tmpdir } from "os";
import { mkdirSync, writeFileSync, readFileSync } from "fs";
import { generateScript } from "./yt-script.js";
import { getVoiceSamples } from "./yt-voice.js";
import { buildKit, renderKitText, kitPayload, takesToRecord } from "./yt-recording-kit.js";
import {
  resolveTopicSelection, generateBrief, proposeFootage,
  renderBriefText, briefPayload, priorTitles,
} from "./yt-brief.js";
import { ensureRecordingsFolder } from "./yt-ingest.js";
import { sendApprovalRequest } from "./delivery.js";
import {
  heldBackPayload, renderHeldBackText, heldBackSubject,
  noDraftPayload, renderNoDraftText, noDraftSubject,
} from "./yt-hold-notice.js";
import {
  loadApprovals,
  saveApprovals,
  appendRequest,
  markActed,
  newRequestId,
  decisionState,
  findRequest,
  KIND_TOPIC_PICK,
  KIND_VIDEO_REVIEW,
} from "./yt-approvals.js";
import { ingestRecordings } from "./yt-ingest.js";
import { planTimeline, buildChapters } from "./yt-timeline.js";
import { generateNarration, renderTimeline, syntheticNarrationUsed, canvasFor } from "./yt-assemble.js";
import { applyRetentionStage, renderRetentionSummary } from "./yt-retention-stage.js";
import { buildVisuals } from "./yt-visual-build.js";
import { listLongformFootage } from "./yt-footage-source.js";
import { creditsBlock } from "./yt-stock.js";
import { getWordTimestamps } from "./burned-captions.js";
import { generateOpeningOverlay, planOpening } from "./yt-opening.js";
import { generateThumbnailHook } from "./yt-thumbnail-hook.js";
import { renderThumbnail, fitUnderLimit } from "./yt-thumbnail.js";
import { buildPackaging, buildPinnedComment } from "./yt-packaging.js";
import { distributeVideo, completedSteps, videoIdFromPost, accessToken as ytApiToken } from "./yt-distribute.js";
import { verifyPostStatus } from "./metricool.js";
import { PIP_ENABLED } from "./yt-config.js";
import { uploadPrivate, requestReview } from "./yt-publish.js";
import {
  loadLog as loadVideoLog,
  saveLog as saveVideoLog,
  recordRender,
  recordUpload,
  recordReview,
  recordRework,
  findByRequest,
  videoIdFor,
  isUploaded,
  recentBrollHashes,
} from "./yt-log.js";
import { RESOLUTION } from "./yt-config.js";

const DRY_RUN = process.env.DRY_RUN === "true";

/**
 * Where a held-back draft is written so it survives the run.
 *
 * RUNNER_TEMP on Actions, the OS temp dir locally. Deliberately NOT inside the
 * repo: a draft that failed the bar is evidence for one investigation, not
 * something to commit, and a path under the working tree is one `git add -A`
 * away from being committed by the job that produced it.
 */
const DIAGNOSTICS_DIR = join(process.env.RUNNER_TEMP || tmpdir(), "yt-diagnostics");

/**
 * Persist a below-bar draft and everything the critic said about it.
 *
 * A held-back script is discarded — correctly, it must never be recorded — but
 * that also threw away the only evidence of WHY it was held back. Diagnosing it
 * afterwards meant re-running the writer and hoping to reproduce a
 * nondeterministic failure, which is not diagnosis.
 *
 * Never throws: this is diagnostics. A disk problem here must not turn a
 * correctly-held-back script into a failed pipeline run.
 */
function writeScriptDiagnostics(record, topic, scriptResult, why) {
  try {
    mkdirSync(DIAGNOSTICS_DIR, { recursive: true });
    const path = join(DIAGNOSTICS_DIR, `${record.requestId}-${Date.now()}.json`);
    writeFileSync(
      path,
      JSON.stringify(
        {
          requestId: record.requestId,
          heldBackAt: new Date().toISOString(),
          why,
          topic: { title: topic.title, intent: topic.intent, market: topic.market, hook: topic.hook },
          scores: scriptResult.scores,
          attemptsUsed: scriptResult.attemptsUsed,
          belowBar: scriptResult.belowBar,
          criticUnavailable: scriptResult.criticUnavailable,
          takeCount: scriptResult.takeCount,
          onCameraCount: scriptResult.onCameraCount,
          estimatedMinutes: scriptResult.estimatedMinutes,
          // Every attempt that never became a scorable draft, with the raw
          // output around the point a parse gave up. A position in a 16,000
          // character string is not a diagnosis; the characters either side are.
          attemptFailures: scriptResult.attemptFailures || [],
          // The best-of draft in full. This is the thing to read. Null when no
          // attempt survived validation.
          script: scriptResult.script || null,
        },
        null,
        2
      ) + "\n"
    );
    console.log(`[YTPipeline] draft + critic feedback written to ${path}`);
  } catch (err) {
    console.warn(`[YTPipeline] could not write diagnostics: ${err.message}`);
  }
}

/**
 * Tell Peter no draft survived validation.
 *
 * Unlike the below-bar notice this is wrapped by its caller: the run is already
 * failing and about to rethrow, so a notification problem must not replace the
 * generation error that actually explains the run.
 */
async function notifyNoUsableDraft(record, topic, attemptFailures, err) {
  const runUrl = process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID
    ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
    : null;
  const args = { topicTitle: topic.title, attemptFailures, runUrl };
  await sendApprovalRequest({
    requestId: record.requestId,
    kind: KIND_TOPIC_PICK,
    payload: noDraftPayload({ requestId: record.requestId, topicTitle: topic.title, attemptFailures }),
    emailSubject: noDraftSubject(args),
    emailBody: renderNoDraftText(args),
    accessToken: await getAccessToken().catch(() => null),
  });
}

/**
 * Turn an approved topic into a script and a recording kit.
 *
 * Everything that can fail happens before markActed: the script is written, the
 * folder is made, and the kit is delivered, and only then is the request
 * stamped. If any of it throws, the request stays unacted and the next
 * scheduled run tries again — which is the behaviour that makes a retrying
 * scheduled job safe.
 */
async function deliverKitForApprovedTopic(approvals, record) {
  const candidates = record?.payload?.candidates || [];
  const selection = resolveTopicSelection(record, candidates);

  if (!selection.ok) {
    // An approval that does not say WHAT was approved is a question, not an
    // instruction. Never guess which video to make.
    console.log(`[YTPipeline] ${record.requestId} approved but ambiguous: ${selection.reason}`);
    console.log(`::warning::Topic approved without a clear pick — ${selection.reason}`);
    return { advanced: false, reason: selection.reason };
  }

  const topic = selection.candidate;
  console.log(`[YTPipeline] ${record.requestId}: option ${selection.index} via ${selection.via} — "${topic.title}"`);

  const voiceSamples = getVoiceSamples(loadLog());
  if (voiceSamples.length === 0) {
    console.log("[YTPipeline] no usable voice samples yet — writing without a voice reference");
  }

  // A TOTAL GENERATION FAILURE MUST REACH PETER TOO.
  //
  // When every attempt fails format validation, generateScript throws and the
  // run exits red — and the below-bar notice below is never reached, so all he
  // gets is a GitHub "workflow failed" mail with no idea a script was even
  // attempted. That is the same silence the hold notice exists to end, arriving
  // through a different door.
  //
  // The failures are persisted and he is told, then the error is rethrown so the
  // run still goes red and the request stays unacted for the next poll.
  let scriptResult;
  try {
    scriptResult = await generateScript({
      topic: { title: topic.title, hook: topic.hook, outline: topic.outline },
      notes: record.notes || null,
      voiceSamples,
    });
  } catch (err) {
    const failures = err?.attemptFailures || [];
    console.log(`[YTPipeline] script generation produced no usable draft after ${failures.length} attempts`);
    writeScriptDiagnostics(record, topic, { title: null, scores: {}, attemptFailures: failures }, err.message);
    await notifyNoUsableDraft(record, topic, failures, err).catch((e) => {
      console.warn(`[YTPipeline] could not send the no-draft notice: ${e.message}`);
    });
    throw err;
  }

  console.log(
    `[YTPipeline] script "${scriptResult.title}" — ${scriptResult.takeCount} takes ` +
    `(${scriptResult.onCameraCount} on camera), ~${scriptResult.estimatedMinutes} min` +
    (scriptResult.belowBar ? " [BELOW BAR — best-of]" : "")
  );

  // DO NOT SEND A KIT FOR A SCRIPT THAT WAS NEVER JUDGED.
  //
  // The carousel degrades a critic outage to "ship the best of what we have",
  // and that is right there: a daily post has to go out, and one weak carousel
  // costs one post. Here the next thing that happens is Peter spending a
  // recording session on it. An unscored script does not cost a post, it costs
  // his Saturday — and he cannot tell from the kit that nothing vetted it.
  //
  // So this refuses and leaves the request UNACTED, which means the next
  // scheduled run tries again. A critic outage is usually transient; waiting a
  // few hours is free, and re-recording is not.
  if (scriptResult.criticUnavailable || scriptResult.belowBar) {
    const why = scriptResult.criticUnavailable
      ? "the critic could not be reached, so nothing scored this script"
      : `it scored below the bar (clarity=${scriptResult.scores.clarity} ` +
        `retention=${scriptResult.scores.retention} authenticity=${scriptResult.scores.authenticity})`;
    console.log(`[YTPipeline] NOT delivering a kit for ${record.requestId}: ${why}`);
    console.log(`::warning::Script for "${topic.title}" held back — ${why}. Will retry on the next run.`);
    writeScriptDiagnostics(record, topic, scriptResult, why);

    // TELL PETER. A hold used to end here, with a warning in an Actions log
    // nobody watches — he picked a topic, waited, and had no way to tell a held
    // script apart from a job that never ran. Silence is not an outcome.
    //
    // Sent on the request's EXISTING id, like the recording kit, so no new
    // approval record is created: one of those would read as an unanswered
    // brief and block the next Monday brief from going out.
    //
    // Not wrapped in a try/catch on purpose. sendApprovalRequest throws only
    // when the notice reached NEITHER channel, and a hold nobody was told about
    // is the exact failure this exists to prevent — so it goes red and GitHub
    // mails him instead. The request stays unacted either way, so the next poll
    // still retries.
    const runUrl = process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID
      ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
      : null;
    const noticeArgs = { topicTitle: topic.title, scriptResult, why, runUrl };
    await sendApprovalRequest({
      requestId: record.requestId,
      kind: KIND_TOPIC_PICK,
      payload: heldBackPayload({ requestId: record.requestId, topicTitle: topic.title, scriptResult, why }),
      emailSubject: heldBackSubject(noticeArgs),
      emailBody: renderHeldBackText(noticeArgs),
      accessToken: await getAccessToken().catch(() => null),
    });

    return { advanced: false, reason: why };
  }

  const kit = buildKit(scriptResult, { requestId: record.requestId });
  const emailBody = renderKitText(kit);

  if (DRY_RUN) {
    console.log(`[YTPipeline] DRY RUN — would deliver a kit for ${record.requestId}`);
    console.log(emailBody);
    return { advanced: false, reason: "dry run" };
  }

  const accessToken = await getAccessToken();
  await ensureRecordingsFolder(record.requestId, accessToken);

  await sendApprovalRequest({
    requestId: record.requestId,
    kind: KIND_TOPIC_PICK,
    payload: { stage: "recording_kit", ...kitPayload(kit) },
    emailSubject: `Recording kit — ${kit.title} (${kit.stats.takeCount} takes)`,
    emailBody,
    accessToken,
  });

  const stamped = markActed(approvals, record.requestId, {
    action: "kit_delivered",
    result: {
      selectedIndex: selection.index,
      selectedTitle: topic.title,
      market: topic.market,
      folderPath: kit.folderPath,
      takeCount: kit.stats.takeCount,
      scores: scriptResult.scores,
      belowBar: scriptResult.belowBar,
      // The full script rides along because the build job needs the exact take
      // text to match recordings against, and this record is the only thing
      // that survives between runs. It is a few KB against a 400-entry cap.
      script: scriptResult.script,
    },
  });
  saveApprovals(stamped);
  console.log(`[YTPipeline] kit delivered for ${record.requestId} — waiting on recordings`);
  return { advanced: true };
}

/** Peter said no. Rewrite the brief with his notes and ask again. */
async function reBriefAfterRejection(approvals, record) {
  const notes = record.notes || "";
  console.log(`[YTPipeline] ${record.requestId} was rejected${notes ? ` — "${notes}"` : ""}`);

  if (DRY_RUN) {
    console.log("[YTPipeline] DRY RUN — would send a reworked brief");
    return { advanced: false, reason: "dry run" };
  }

  const postedLog = loadLog();
  const usedIds = new Set(getRecentlyPostedIdsAllCities(postedLog, 30));
  const brief = await generateBrief({
    recentTitles: priorTitles(approvals),
    // Peter's notes steer the rewrite. They are guidance, not a spec — he is
    // reacting to three titles, not writing a brief.
    ...(notes ? { notes } : {}),
  });

  // THE BRIEF DOES NOT PROPOSE REELS CLIPS EITHER.
  //
  // This read `listCityVideos(candidate.market)` — the reels bot's folder for
  // that city — and showed Peter which of those clips a long-form topic could
  // use. Under revision 3 the answer is none of them, so proposing them would
  // be offering footage the pipeline is forbidden to fetch. It is the SAME
  // violation as the render path, one stage earlier and easier to miss because
  // nothing it produces reaches the screen.
  //
  // The long-form folder is market-independent and starts empty, so this is
  // normally an empty list and the brief simply carries no footage proposals.
  const longformClips = await listLongformFootage();
  for (const candidate of brief.candidates) {
    candidate.proposedClips = proposeFootage(longformClips, usedIds);
  }

  const requestId = newRequestId(KIND_TOPIC_PICK);
  const payload = briefPayload(brief, { requestId });
  const accessToken = await getAccessToken().catch(() => null);

  await sendApprovalRequest({
    requestId,
    kind: KIND_TOPIC_PICK,
    payload,
    emailSubject: `Reworked brief — pick one (${brief.candidates.length} options)`,
    emailBody: renderBriefText(brief, { requestId }),
    accessToken,
  });

  // Stamp the old request first so the rejection cannot be re-processed, then
  // record the replacement.
  let next = markActed(approvals, record.requestId, {
    action: "rebriefed",
    result: { replacedBy: requestId },
  });
  next = appendRequest(next, { requestId, kind: KIND_TOPIC_PICK, payload });
  saveApprovals(next);
  console.log(`[YTPipeline] reworked brief sent as ${requestId}`);
  return { advanced: true };
}

/**
 * The kit is out. Has Peter recorded, and if so can this be built?
 *
 * Every exit that is not "built it" is a clean one. Recordings arriving late is
 * the NORMAL case — the job runs twice a day and he records when he records.
 */
async function buildFromRecordings(approvals, record) {
  const result = record.actedResult || {};
  const script = result.script;
  if (!script) {
    console.log(`[YTPipeline] ${record.requestId} has no script on record — nothing to build from`);
    return;
  }

  const videoLog = loadVideoLog();
  const existing = findByRequest(videoLog, record.requestId);
  if (existing && isUploaded(existing)) {
    console.log(`[YTPipeline] ${record.requestId} was already uploaded at ${existing.uploadedAt} — not building again`);
    return;
  }

  const workDir = join(tmpdir(), `yt-build-${record.requestId}`);
  mkdirSync(workDir, { recursive: true });

  // Only the takes Peter was asked to record. Expecting the voiceover takes
  // here would report them missing forever and the build would never run.
  const takes = takesToRecord(script);
  const ingest = await ingestRecordings({
    requestId: record.requestId,
    takes,
    workDir,
    keepFiles: true,
  });

  if (ingest.state === "no-folder" || ingest.state === "empty") {
    console.log(`[YTPipeline] no recordings for ${record.requestId} yet — exiting cleanly, will check next run`);
    return;
  }

  if (ingest.state === "incomplete") {
    // Report what is missing rather than building a video with a hole in it.
    const { describeMatchResult } = await import("./yt-take-match.js");
    const report = describeMatchResult(ingest.result, { requestId: record.requestId });
    console.log(`[YTPipeline] recordings incomplete for ${record.requestId}:\n${report}`);
    console.log(`::warning::${ingest.result.missingTakes.length} take(s) still needed for "${result.selectedTitle}"`);
    return;
  }

  console.log(`[YTPipeline] all ${ingest.result.matches.length} takes matched — building`);

  // Recordings, keyed by takeId, for the planner.
  const recordings = {};
  for (const m of ingest.result.matches) {
    const clip = ingest.clips.find((c) => c.id === m.clipId);
    if (clip) recordings[m.takeId] = { path: clip.localPath || null, durationSeconds: clip.durationSeconds };
  }

  const brollPool = await brollFor();
  const plan = planTimeline(script, recordings, brollPool, { usedRecently: recentBrollHashes(videoLog) });
  if (plan.missingTakes.length > 0) {
    console.log(`::warning::plan is missing ${plan.missingTakes.length} on-camera take(s) — not rendering`);
    return;
  }
  if (plan.brollExhausted) {
    console.log("::warning::the B-roll library ran short for this video — some clips are reused");
  }

  const resolveBrollPath = await downloadPlannedBroll(plan, brollPool, workDir);
  await generateNarration(plan);
  // Read AFTER narration, so this is what the render contains rather than what
  // the mode predicted. A missed voiceover take falls back to the clone, and
  // the disclosure has to follow the video, not the config.
  const syntheticNarration = syntheticNarrationUsed(plan);
  console.log(
    `[YTPipeline] synthetic narration in this render: ${syntheticNarration}` +
      ` — disclosure ${syntheticNarration ? "REQUIRED" : "not required"}`
  );
  // Visuals go in AFTER narration, because narration is what sets each
  // segment's final length AND because the word timings the reveals are
  // anchored to come from the narration audio. Planning against the pre-TTS
  // estimate would sync the graphics to a guess.
  const { plan: withVisuals, report: gen } = await buildVisuals(plan, {
    workDir,
    market: result.market,
    ffmpeg,
    getWordTimestamps,
    visionClient: visionClientOrNull(),
    ownedPool: brollPool,
    usedHashes: recentBrollHashes(videoLog),
  });

  // THE COVERAGE SPLIT. Every voiceover second is carried by exactly one layer,
  // and this is the number that says which kind of video this turned out to be.
  console.log(
    `[YTPipeline] visual coverage: ${gen.byPct.graphic}% graphic / ${gen.byPct.typography}% typography / ` +
      `${gen.byPct.stock}% stock / ${gen.byPct.owned}% owned footage ` +
      `(${gen.voiceoverSeconds}s of voiceover)`
  );
  if (gen.uncoveredSeconds > 0) {
    // Should be impossible — typography is the floor. If it ever fires, the
    // floor has a hole in it and that is worth stopping for.
    throw new Error(`${gen.uncoveredSeconds}s of voiceover has no picture — the typography fallback did not cover it`);
  }
  console.log(
    `[YTPipeline] word timing: ${gen.wordTimingCoverage.withTiming}/${gen.wordTimingCoverage.takes} takes transcribed ` +
      `— the rest use even pacing`
  );
  for (const f of gen.fallbacks) {
    console.log(`::warning::take ${f.takeId} asked for ${f.asked} and got ${f.got} — ${f.reason}`);
  }
  for (const f of gen.animationFailures) {
    console.log(`::warning::take ${f.takeId} ${f.type} failed verification — ${f.reason}`);
  }
  console.log(
    `[YTPipeline] of ${gen.intents.voiceoverTakes} voiceover takes: ` +
      `${gen.intents.graphicTakes} asked for a graphic, ${gen.intents.footageTakes} chose footage, ` +
      `${gen.intents.typographyTakes} chose typography, ` +
      `${gen.intents.unspecifiedTakes} said nothing — ${JSON.stringify(gen.intents.byType)}`
  );
  if (gen.intents.unspecifiedTakes > 0) {
    // Every voiceover take is supposed to carry an intent now. Silence means
    // the prompt is not landing, and it looks identical to a footage choice in
    // the finished video.
    console.log(`::warning::${gen.intents.unspecifiedTakes} voiceover take(s) carried no visualIntent — the writer prompt is not landing`);
  }
  // A script whose intents were all REJECTED looks identical, in the finished
  // video, to a script that asked for nothing. Only one of those is a bug, so
  // they are logged differently.
  for (const r of gen.intents.rejections) {
    console.log(`::warning::take ${r.takeId} asked for a ${r.type || "?"} visual and it was rejected — ${r.reason}`);
  }
  for (const f of gen.failures) console.log(`::warning::visual for take ${f.takeId} fell back to footage — ${f.reason}`);
  if (gen.intents.requested === 0) {
    console.log("::warning::the writer requested no visuals for this script — every segment is footage");
  }

  // ── the opening ──────────────────────────────────────────────────────────
  // Composed rather than allocated: his face, one claim, and nothing else for
  // fifteen seconds. Generated here so a failure stops the build before twelve
  // minutes of encoding rather than after it.
  const overlayResult = await generateOpeningOverlay({ hook: script?.hook, candidate: script?.openingOverlay });
  if (!overlayResult.overlay) {
    console.log(`::warning::no opening overlay cleared the gates (${overlayResult.reason}) — opening on the face alone`);
  }

  const opening = planOpening(withVisuals.segments, { overlay: overlayResult.overlay });
  console.log(`[YTPipeline] opening: ${JSON.stringify(opening.composition, null, 1)}`);
  if (!opening.ok) {
    // Opening on somebody else's drone footage is a different product, so this
    // stops the build rather than warning and continuing.
    for (const f of opening.failures) console.log(`::error::opening: ${f}`);
    throw new Error(`the opening treatment cannot be satisfied: ${opening.failures.join("; ")}`);
  }

  // ── the retention edit + PIP + cadence, on the finished plan ─────────────
  // AFTER visuals (the splice changes what each voiceover segment shows) and
  // BEFORE chapters and render — the edit changes on-camera segment lengths,
  // and captions timed against the unedited lengths would drift for twelve
  // minutes. planOpening above already guaranteed segment 0 is his face, so
  // the stage's isOpening flag lands on the right take.
  const retention = applyRetentionStage(withVisuals, { workDir, dim: canvasFor(RESOLUTION) });
  console.log(renderRetentionSummary(retention).split("\n").map((l) => `[YTPipeline] ${l}`).join("\n"));

  const chapters = buildChapters(withVisuals, script);
  const rendered = await renderTimeline(withVisuals, {
    workDir,
    resolveBrollPath,
    resolution: RESOLUTION,
    openingOverlay: overlayResult.overlay,
  });

  const packaging = await buildPackaging({
    topic: { title: result.selectedTitle, query: result.query, market: result.market, intent: result.intent },
    script,
    chapters,
    // Only true when a map actually reached the timeline, so the credit line
    // never claims something the video does not contain.
    mapsUsed: gen.mapsUsed,
    // Built from the clips that actually survived the vision check and reached
    // the timeline — empty when none did, so a graphics-and-typography video
    // carries no stock credit block at all.
    stockCredits: creditsBlock(gen.stockCredits),
  });

  // ── the thumbnail ─────────────────────────────────────────────────────────
  // Generated here because the review checklist tells Peter to upload "the
  // thumbnail" in Studio — and until this block, nothing anywhere produced
  // one. The checklist pointed at an artifact that did not exist, which is the
  // silent-gap class: every piece tested, the whole disconnected.
  //
  // Non-fatal on purpose. A finished video without a thumbnail file is still
  // deliverable (Peter sees the gap on the checklist); a finished video thrown
  // away over its thumbnail is not.
  let thumb = { hook: null, scores: null };
  let thumbnailPath = null;
  try {
    thumb = await generateThumbnailHook({ title: packaging.title, script });
    if (thumb.hook) {
      // fitUnderLimit returns { buffer, converted } — NOT bytes. Writing the
      // object threw on video 1's real build ("Received an instance of
      // Object") and the run shipped without its thumbnail attachment. The
      // fallback held, which is why this was a warning and not a dead build.
      const fitted = await fitUnderLimit(
        await renderThumbnail(thumb.hook, { kicker: result.market === "austin" ? "AUSTIN" : "SAN ANTONIO" })
      );
      thumbnailPath = join(workDir, fitted.converted ? "thumbnail.jpg" : "thumbnail.png");
      writeFileSync(thumbnailPath, fitted.buffer);
      console.log(
        `[YTPipeline] thumbnail: "${thumb.hook}" ` +
          `(curiosity=${thumb.scores?.curiosity} legibility=${thumb.scores?.legibility} emotion=${thumb.scores?.emotional_trigger}` +
          `${thumb.belowBar ? ", BELOW BAR — best of what survived" : ""}, ${thumb.candidatesConsidered ?? "?"} candidate(s) considered)`
      );
    } else {
      console.log(`::warning::no thumbnail line cleared the gates — Peter makes one in Studio (${thumb.reason || "no usable line"})`);
    }
  } catch (err) {
    console.log(`::warning::thumbnail generation failed — Peter makes one in Studio (${err.message})`);
  }

  const videoId = videoIdFor(record.requestId);
  let nextLog = recordRender(videoLog, {
    videoId,
    requestId: record.requestId,
    title: packaging.title,
    market: result.market,
    intent: result.intent,
    runtimeSeconds: rendered.seconds,
    bytes: rendered.bytes,
    resolution: RESOLUTION,
    brollHashes: plan.segments.flatMap((s) => (s.broll || []).map((b) => b.contentHash).filter(Boolean)),
    scriptScores: result.scores,
    packagingScores: packaging.scores,
    // C3: the chosen thumbnail text rides with the video record, so hook style
    // can be correlated with CTR once analytics exist.
    thumbnailText: thumb.hook,
    thumbnailScores: thumb.scores,
  });
  saveVideoLog(nextLog);

  if (DRY_RUN) {
    console.log(`[YTPipeline] DRY RUN — built ${rendered.outputPath}, not uploading`);
    return;
  }

  const upload = await uploadPrivate(readFileSync(rendered.outputPath), packaging, {
    blogId: process.env.METRICOOL_BLOG_ID,
    userId: process.env.METRICOOL_USER_ID,
    token: process.env.METRICOOL_API_TOKEN,
    publishAt: chicagoNow(),
  });

  nextLog = recordUpload(nextLog, videoId, {
    youtubeUrl: upload.mediaUrl,
    metricoolPostId: upload.postId,
    blogId: upload.blogId,
  });
  saveVideoLog(nextLog);

  const reviewRequestId = newRequestId(KIND_VIDEO_REVIEW);
  const accessToken = await getAccessToken().catch(() => null);
  await requestReview({
    requestId: reviewRequestId,
    videoId,
    packaging,
    youtubeUrl: upload.mediaUrl,
    driveLink: null,
    stats: { runtimeMinutes: Math.round((rendered.seconds / 60) * 10) / 10, resolution: RESOLUTION },
    accessToken,
    syntheticNarration,
  });

  saveApprovals(
    appendRequest(approvals, {
      requestId: reviewRequestId,
      kind: KIND_VIDEO_REVIEW,
      videoId,
      payload: { videoId, title: packaging.title, requestId: record.requestId },
    })
  );
  console.log(`[YTPipeline] uploaded PRIVATE and sent ${reviewRequestId} for review`);
}

/**
 * The B-roll pool, with durations read from Drive metadata rather than from the
 * files.
 *
 * The planner needs to know how long each clip is before it can allocate it,
 * and downloading 138 clips to find out would cost gigabytes for information
 * Drive already holds. Only the clips the plan actually uses get downloaded,
 * afterwards.
 */
/**
 * Long-form footage. NOT the reels library.
 *
 * This function used to call `listCityVideos(market)`, which is the reels bot's
 * folder for that city. Those clips carry burned-in listing copy — "San Antonio
 * starting at $X / 4.99%" — and revision 3 removes them from long-form
 * entirely: wrong inside an education video, and a rate that ages into a false
 * claim on a video that stays up for years.
 *
 * The replacement reads one folder that starts EMPTY, and empty is the correct
 * steady state rather than a setup step. With nothing in it every segment is
 * carried by a graphic, typography or licensed stock, which is the whole point
 * of the three-layer system.
 */
async function brollFor() {
  return listLongformFootage();
}

/**
 * The vision client for the stock check, or null.
 *
 * Null is a working configuration: `visionCheckClip` fails closed, so no key
 * means no stock passes and every FOOTAGE intent falls to typography. Loud,
 * once, rather than silently shipping unverified clips.
 */
function visionClientOrNull() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.log("[YTPipeline] no ANTHROPIC_API_KEY — stock clips cannot be vision-checked, so stock is disabled this run");
    return null;
  }
  return new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
}

/** Fetch just the clips the plan uses, and hand back a resolver for the renderer. */
async function downloadPlannedBroll(plan, pool, dir) {
  const wanted = new Set(plan.segments.flatMap((s) => (s.broll || []).map((b) => b.driveFileId)));
  const paths = new Map();
  for (const id of wanted) {
    const clip = pool.find((c) => c.id === id);
    if (!clip) continue;
    const dest = join(dir, `broll-${id}.mp4`);
    writeFileSync(dest, await downloadVideo(id, clip.name));
    paths.set(id, dest);
  }
  console.log(`[YTPipeline] downloaded ${paths.size} B-roll clip(s) the plan needs`);
  return (id) => paths.get(id) || null;
}

function chicagoNow() {
  const chicago = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Chicago" }));
  const p = (n) => String(n).padStart(2, "0");
  return `${chicago.getFullYear()}-${p(chicago.getMonth() + 1)}-${p(chicago.getDate())}T${p(chicago.getHours())}:${p(chicago.getMinutes())}:${p(chicago.getSeconds())}`;
}

/** Peter reviewed the finished video. Approving records it; it does NOT publish. */
async function handleVideoReview(approvals, review) {
  const videoLog = loadVideoLog();
  const videoId = review.record.videoId || review.record.payload?.videoId;

  if (review.state === "approved") {
    console.log(`[YTPipeline] ${review.record.requestId} APPROVED — recording it. This does not publish anything.`);
    saveVideoLog(recordReview(videoLog, videoId, { approved: true }));
    saveApprovals(markActed(approvals, review.record.requestId, { action: "review_recorded", result: { videoId, approved: true } }));
    console.log("[YTPipeline] Shorts cutdowns are now eligible; publishing remains Peter's to do in Studio.");
    return;
  }

  const notes = review.notes || null;
  console.log(`[YTPipeline] ${review.record.requestId} was NOT approved${notes ? ` — "${notes}"` : ""}`);
  let next = recordReview(videoLog, videoId, { approved: false, notes });
  // A rejection is not an ending, it is a revision request: clear the upload
  // markers so the next run rebuilds from the SAME takes and sends a fresh
  // review card. The superseded upload moves into the entry's rework history.
  next = recordRework(next, videoId, { notes });
  saveVideoLog(next);
  saveApprovals(markActed(approvals, review.record.requestId, { action: "review_recorded", result: { videoId, approved: false, notes, reworkQueued: true } }));
  console.log(`[YTPipeline] rework queued — the next run rebuilds ${videoId} with the same takes and Peter's notes applied`);
}


/**
 * The distribution sweep — everything that happens to a video after approval.
 *
 * Runs at the top of every scheduled run, over every approved entry whose
 * distribution is incomplete. Idempotent by construction (yt-distribute.js
 * checks-before-acting and completed steps are merged into the log), so a cron
 * hitting it twice costs nothing.
 *
 * WHY THE THUMBNAIL IS RE-RENDERED HERE rather than read from disk: the build
 * wrote it into that run's workDir, which is gone by the time a later cron
 * sweeps. The render is deterministic from the logged thumbnailText, so the
 * sweep rebuilds the identical PNG instead of depending on an artifact that no
 * longer exists — one less piece of state to lose.
 *
 * NOTHING HERE PUBLISHES. The comment step inside distributeVideo waits until
 * it can SEE that Peter made the video public in Studio.
 */
async function sweepDistribution() {
  const videoLog = loadVideoLog();
  const pending = (videoLog.videos || []).filter(
    (v) => v.approved && !String(v.requestId || "").startsWith("TEST-") &&
      !(v.distribution?.thumbnail?.done && v.distribution?.playlist?.done && v.distribution?.comment?.done)
  );
  if (pending.length === 0) return;

  let token;
  try {
    token = await ytApiToken();
  } catch (err) {
    // No YouTube credentials is a configuration gap, not a crash — the build
    // half of the pipeline must keep working without them.
    console.log(`::warning::distribution sweep skipped — ${err.message}`);
    return;
  }

  let log = videoLog;
  for (const entry of pending) {
    // Resolve the real YouTube id from the Metricool post, once, and keep it.
    if (!entry.youtubeVideoId && entry.metricoolPostId) {
      const status = await verifyPostStatus(entry.metricoolPostId, entry.blogId || process.env.METRICOOL_BLOG_ID);
      const resolved = videoIdFromPost(status.raw);
      if (resolved) {
        entry.youtubeVideoId = resolved;
        console.log(`[YTDistribute] ${entry.videoId}: YouTube id resolved to ${resolved}`);
      } else {
        // The known unknown: whether a private long-form post carries the id.
        console.log(`::warning::${entry.videoId}: no YouTube id on the Metricool post yet — distribution waits`);
        continue;
      }
    }
    if (!entry.youtubeVideoId) continue;

    // The thumbnail, rebuilt from the logged text (see the header).
    let thumbnailPath = null;
    if (entry.thumbnailText) {
      try {
        const fitted = await fitUnderLimit(
          await renderThumbnail(entry.thumbnailText, { kicker: entry.market === "austin" ? "AUSTIN" : "SAN ANTONIO" })
        );
        thumbnailPath = join(process.env.RUNNER_TEMP || tmpdir(), `thumb-${entry.videoId}.${fitted.converted ? "jpg" : "png"}`);
        writeFileSync(thumbnailPath, fitted.buffer);
      } catch (err) {
        console.log(`::warning::${entry.videoId}: thumbnail re-render failed (${err.message})`);
      }
    }

    const report = await distributeVideo(entry, {
      token,
      thumbnailPath,
      pinnedComment: buildPinnedComment(),
      market: entry.market,
      intent: entry.intent,
    });

    for (const [name, r] of Object.entries(report.steps || {})) {
      if (r.already) continue;
      if (r.done && r.waiting) console.log(`[YTDistribute] ${entry.videoId}: ${name} — ${r.waiting}`);
      else if (r.done) console.log(`[YTDistribute] ${entry.videoId}: ${name} done ${r.skipped ? `(${r.skipped})` : ""}`);
      else console.log(`::warning::${entry.videoId}: ${name} FAILED — ${r.error} (retries next run)`);
    }
    if (report.blocked) console.log(`::warning::${entry.videoId}: distribution blocked — ${report.blocked}`);

    const done = completedSteps(report);
    if (Object.keys(done).length > 0 || entry.youtubeVideoId) {
      log = {
        ...log,
        videos: log.videos.map((v) =>
          v.videoId === entry.videoId
            ? { ...v, youtubeVideoId: entry.youtubeVideoId, distribution: { ...(v.distribution || {}), ...done } }
            : v
        ),
      };
      saveVideoLog(log);
    }
  }
}

async function main() {
  // Distribution first: it is independent of the stage machine below, and a
  // video Peter published overnight gets its comment posted on this run rather
  // than after whatever the stage machine decides to do.
  await sweepDistribution();

  const approvals = loadApprovals();
  const topic = decisionState(approvals, KIND_TOPIC_PICK);

  switch (topic.state) {
    case "none":
      console.log("[YTPipeline] no brief has been sent yet — nothing to advance");
      return;

    case "waiting":
      console.log(
        `[YTPipeline] ${topic.record.requestId} is waiting on Peter (sent ${topic.record.requestedAt}) — ` +
        `exiting cleanly, will check again next run`
      );
      return;

    case "approved":
      await deliverKitForApprovedTopic(approvals, topic.record);
      return;

    case "rejected":
      await reBriefAfterRejection(approvals, topic.record);
      return;

    case "already-acted": {
      // The kit is out. Everything downstream keys off the same requestId, so
      // the review is checked first — if it has been answered, that is the
      // newer news and building again would be wrong.
      const review = decisionState(approvals, KIND_VIDEO_REVIEW);
      if (review.state === "approved" || review.state === "rejected") {
        await handleVideoReview(approvals, review);
        return;
      }
      if (review.state === "waiting") {
        console.log(
          `[YTPipeline] ${review.record.requestId} is waiting on Peter's review — exiting cleanly`
        );
        return;
      }
      if (review.state === "already-acted") {
        // A recorded APPROVAL is final — nothing further. A recorded REJECTION
        // queued a rework, which cleared the upload markers, so the build gate
        // below is open again: fall through and rebuild with the same takes.
        const entry = findByRequest(loadVideoLog(), topic.record.requestId);
        if (entry && !isUploaded(entry)) {
          console.log(
            `[YTPipeline] ${review.record.requestId} was rejected and queued for rework ` +
            `(revision ${entry.revision || 2}) — rebuilding with the same takes`
          );
        } else {
          console.log(`[YTPipeline] ${review.record.requestId} review already recorded — nothing further`);
          return;
        }
      }
      await buildFromRecordings(approvals, topic.record);
      return;
    }

    default:
      console.log(`[YTPipeline] unrecognised state "${topic.state}" — doing nothing`);
  }
}

main().catch((err) => {
  console.error(`[YTPipeline] FAILED: ${err?.stack || err}`);
  process.exit(1);
});
