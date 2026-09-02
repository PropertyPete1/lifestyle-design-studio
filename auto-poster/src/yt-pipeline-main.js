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
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "fs";
import { generateScript, scoreScript, scoresPass } from "./yt-script.js";
import { getVoiceSamples } from "./yt-voice.js";
import { buildKit, renderKitText, takesToRecord } from "./yt-recording-kit.js";
import { loadPresenters, presenterForRequest } from "./presenters.js";
import { adaptScriptForPresenter, guestPresenterBlock } from "./presenter-script.js";
import { deliverKit } from "./kit-delivery.js";
import { buildFaceThumbnail, preserveCandidates } from "./yt-thumbnail-face.js";
import { cutTeaser, teaserCaptions } from "./yt-teaser.js";
import { deliverToOwner } from "./delivery.js";
import { loadTrialHistory, saveTrialHistory } from "./trial-variant.js";
import { recordPost } from "./state.js";
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
  pendingAnsweredReview,
  findRequest,
  KIND_TOPIC_PICK,
  KIND_VIDEO_REVIEW,
} from "./yt-approvals.js";
import { maybeNudgeStalledRequest } from "./yt-stall-nudge.js";
import { ingestRecordings } from "./yt-ingest.js";
import { planTimeline, buildChapters } from "./yt-timeline.js";
import { generateNarration, renderTimeline, syntheticNarrationUsed, canvasFor, ffmpeg } from "./yt-assemble.js";
import { applyRetentionStage, renderRetentionSummary, attachEmphasis } from "./yt-retention-stage.js";
import { buildVisuals } from "./yt-visual-build.js";
import { listLongformFootage } from "./yt-footage-source.js";
import { creditsBlock } from "./yt-stock.js";
import { selectPunches, captionTextFor } from "./yt-punch.js";
import { runArtifactQc, preserveFailedRender } from "./yt-artifact-qc.js";
import { preserveQcPassedRender, preserveGateEvidence } from "./yt-evidence.js";
import { pickTrack, fetchMusicBed, musicReport, musicCreditsBlock, cacheKey as musicCacheKey, MUSIC_FOLDER } from "./yt-music.js";
import { findInFolder, downloadFileById, uploadToFolder, ensureFolder } from "./drive.js";
import { getWordTimestamps } from "./burned-captions.js";
import { generateOpeningOverlay, planOpening } from "./yt-opening.js";
import { generateThumbnailHook } from "./yt-thumbnail-hook.js";
import { renderThumbnail, fitUnderLimit } from "./yt-thumbnail.js";
import { buildPackaging, buildPinnedComment } from "./yt-packaging.js";
import { distributeVideo, completedSteps, videoIdFromPost, accessToken as ytApiToken } from "./yt-distribute.js";
import { verifyPostStatus } from "./metricool.js";
import { PIP_ENABLED } from "./yt-config.js";
import { uploadPrivate, requestReview } from "./yt-publish.js";
import { buildWatchReport } from "./yt-watch-report.js";
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
import { inflightKits, reviewGateFor } from "./yt-stage.js";
import { RESOLUTION, renderLayerSummary, layerKnobs, BEAT_BRIDGE_MAX_SECONDS } from "./yt-config.js";
import { routeWarnChannel } from "./yt-evidence.js";
// The Actions log drops the warn channel entirely (proven on two preserved
// runs) — route it to stdout at every entrypoint. See yt-evidence.js.
routeWarnChannel();

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

  // WHO FRONTS THIS VIDEO. Default is the owner; an explicit stamp naming
  // somebody the registry does not know is a refusal, never a fallback — a
  // kit sent to the wrong person is the one failure the presenter system
  // exists to prevent. Unacted, so a registry fix makes the next run proceed.
  const who = presenterForRequest(loadPresenters(), record);
  if (!who.ok) {
    console.log(`[YTPipeline] NOT delivering a kit for ${record.requestId}: ${who.reason}`);
    console.log(`::warning::${who.reason} — fix presenters.json or the assignment, then the next run proceeds.`);
    return { advanced: false, reason: who.reason };
  }
  const presenter = who.presenter;
  console.log(`[YTPipeline] presenter: ${presenter.name} (${presenter.id}, ${presenter.role})`);

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
      // Guest framing rides the writer prompt; empty string for the owner.
      presenterBlock: guestPresenterBlock(presenter),
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

  // THE GUEST IDENTITY SWEEP. The writer was told the presenter is not Peter;
  // this is the check that the telling worked, because a prompt is not a
  // guarantee. Ownership claims are neutralized into team framing; an
  // identity claim nothing mechanical can fix holds the kit exactly like a
  // below-bar script — unacted, loud, retried next run.
  if (presenter.role !== "owner") {
    const swept = adaptScriptForPresenter(scriptResult.script, presenter);
    if (swept.unresolved.length > 0) {
      const list = swept.unresolved.map((u) => `${u.where}: "${u.match}"`).join("; ");
      const why = `the script still claims Peter's identity after neutralization (${list})`;
      console.log(`[YTPipeline] NOT delivering a kit for ${record.requestId}: ${why}`);
      console.log(`::warning::Guest script for "${topic.title}" held back — ${why}. Will retry on the next run.`);
      writeScriptDiagnostics(record, topic, scriptResult, why);
      return { advanced: false, reason: why };
    }
    if (swept.changes.length > 0) {
      console.log(
        `[YTPipeline] guest sweep neutralized ${swept.changes.length} owner claim(s): ` +
          swept.changes.map((c) => `${c.where} "${c.from}" -> "${c.to}"`).join("; ")
      );
      // The edits are word-level, but the bar is a property of whole takes —
      // the FULL critic re-scores the adapted script, same stakes as the
      // first pass: an unjudged kit costs the presenter a recording session.
      const rescored = await scoreScript(swept.script);
      if (rescored.unscored || !scoresPass(rescored)) {
        const why = rescored.unscored
          ? "the critic could not re-score the neutralized script"
          : `the neutralized script scored below the bar (clarity=${rescored.clarity} retention=${rescored.retention} authenticity=${rescored.authenticity})`;
        console.log(`[YTPipeline] NOT delivering a kit for ${record.requestId}: ${why}`);
        console.log(`::warning::Guest script for "${topic.title}" held back after neutralization — ${why}.`);
        writeScriptDiagnostics(record, topic, { ...scriptResult, scores: rescored, script: swept.script }, why);
        return { advanced: false, reason: why };
      }
      scriptResult.scores = rescored;
    }
    scriptResult.script = swept.script;
  }

  if (DRY_RUN) {
    const kit = buildKit(scriptResult, { requestId: record.requestId });
    console.log(`[YTPipeline] DRY RUN — would deliver a kit for ${record.requestId} to ${presenter.id}`);
    console.log(renderKitText(kit, { presenter, accessCode: presenter.accessCode }));
    return { advanced: false, reason: "dry run" };
  }

  const accessToken = await getAccessToken();
  await ensureRecordingsFolder(record.requestId, accessToken);

  const delivered = await deliverKit({
    requestId: record.requestId,
    script: scriptResult.script,
    presenter,
    accessToken,
  });
  const kit = delivered.kit;

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
      // Identity only, never the access code — this file is the dashboard's
      // read surface.
      presenter: { id: presenter.id, name: presenter.name, role: presenter.role },
      // The full script rides along because the build job needs the exact take
      // text to match recordings against, and this record is the only thing
      // that survives between runs. It is a few KB against a 400-entry cap.
      script: scriptResult.script,
    },
  });
  saveApprovals(stamped);
  console.log(`[YTPipeline] kit delivered for ${record.requestId} to ${presenter.id} — waiting on recordings`);
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
  // The replacement inherits the rejected brief's presenter: a re-brief is the
  // same video cycle wearing a new outline, and the standing "next" assignment
  // (which only the Monday brief consumes) must not be spent on it.
  next = appendRequest(next, {
    requestId,
    kind: KIND_TOPIC_PICK,
    payload,
    ...(record.presenter ? { presenter: { ...record.presenter, via: "inherited" } } : {}),
  });
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

  // Attribution rides the whole way down: the record's assignment outranks
  // the delivery-time stamp (a reassignment updates the first and the acted
  // script, deliberately not the latch), and absent both, the owner — the
  // default every pre-presenter video was built under.
  const presenter = record.presenter || result.presenter || { id: "peter", name: "Peter", role: "owner" };

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
  // (The thumbnail take rides inside takesToRecord and is optional — its
  // absence never blocks a build; see THUMBNAIL_TAKE.)
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
  // WHAT THIS BUILD WILL ACTUALLY DRAW, printed before it draws any of it.
  // "Rebuild with music off" is a claim about a render, and the run that
  // produced the video is the only place it can be checked — a workflow that
  // sets a knob the code no longer reads looks identical in the diff to one
  // that sets it correctly.
  console.log(`[YTPipeline] ${renderLayerSummary()}`);

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
  // "Ran short" only means something when there was a library to run short OF.
  //
  // With the long-form folder empty — the designed steady state — the allocator
  // reports exhausted on every take, and the first live run of revision 3 duly
  // raised a CI warning saying clips were being reused when zero clips existed.
  // A warning that fires on the normal case is a warning that gets filtered out,
  // and this one needs to still mean something on the day Peter does put footage
  // in the folder and it genuinely runs thin.
  if (plan.brollExhausted && brollPool.length > 0) {
    console.log(`::warning::the long-form footage library ran short (${brollPool.length} clip(s)) — some are reused`);
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
    `[YTPipeline] visual coverage: ${gen.byPct.graphic}% graphic / ${gen.byPct.beat}% beat / ` +
      `${gen.byPct.stock}% stock / ${gen.byPct.owned}% owned footage ` +
      `(${gen.voiceoverSeconds}s of voiceover)`
  );
  if (gen.uncoveredSeconds > 0) {
    // Should be impossible — the beat is the floor. If it ever fires, the floor
    // has a hole in it and that is worth stopping for.
    throw new Error(`${gen.uncoveredSeconds}s of voiceover has no picture — the beat fallback did not cover it`);
  }

  // ── what each stock window was asked for, and what it got ────────────────
  // The per-window keywords are the revision 8 change most likely to be argued
  // with, so the build prints the evidence rather than a summary: the phrase
  // spoken in the window, the concept derived from it, and every proper noun
  // dropped on the way. A place name reaching a search would be visible here.
  for (const w of gen.stockWindows || []) {
    console.log(
      `[YTPipeline] stock window ${w.takeId}#${w.phase} ${w.startAt}s+${w.seconds}s: ` +
        `"${String(w.phrase).slice(0, 60)}" -> [${w.keywords.join(", ") || "nothing searchable"}]` +
        (w.dropped.length ? ` (dropped: ${w.dropped.join(", ")})` : "") +
        ` -> ${w.matched ? "matched" : "no clip"}`
    );
  }
  const windowsMatched = (gen.stockWindows || []).filter((w) => w.matched).length;
  if ((gen.stockWindows || []).length > 0) {
    console.log(`[YTPipeline] stock windows: ${windowsMatched}/${gen.stockWindows.length} matched a clip`);
  }

  // ── WHY EACH WINDOW CAME UP EMPTY, WHICH NOTHING PRINTED ────────────────
  //
  // `stockAttempts` records every rung of every window — the query, the stage it
  // died at, and the reason — and the build has been collecting it and throwing
  // it away. On 2026-08-13 that cost a whole diagnosis: 0 of 13 windows matched,
  // and the log could say which QUERIES were used but not whether Pexels
  // returned nothing or returned clips the vision check rejected. Those two have
  // completely different fixes and the evidence to tell them apart was already
  // in memory.
  //
  // Same class as the stock credits that logged as "[object Object]" nine times:
  // collected, returned, never surfaced. A build report that cannot answer "why
  // not" is a build report that costs another render to ask.
  const byStage = {};
  for (const w of gen.stockAttempts || []) {
    const last = w.attempts[w.attempts.length - 1];
    for (const a of w.attempts) byStage[a.stage] = (byStage[a.stage] || 0) + 1;
    console.log(
      `[YTPipeline] stock ${w.takeId}#${w.phase}: ${w.attempts.length} attempt(s) — ` +
        w.attempts.map((a) => `${a.stage}${a.keyword ? ` "${a.keyword}"` : ""}: ${a.reason}`).join(" | ") +
        ` -> gave up at ${last?.stage ?? "?"}`
    );
  }
  if ((gen.stockAttempts || []).length > 0) {
    // The distribution is the actionable half. Every window dying at `search`
    // means the queries are unsearchable; every window dying at `vision` means
    // the queries are fine and the check is rejecting what comes back. Those are
    // opposite fixes and this line is what says which.
    console.log(`[YTPipeline] stock attempts by stage: ${JSON.stringify(byStage)}`);
  }

  // ── WHETHER THE BEAT CAP COULD ACT, WHICH ALSO PRINTED NOTHING ──────────
  //
  // `bridgeBeats` caps a beat at BEAT_BRIDGE_MAX_SECONDS and hands the overflow
  // to the neighbouring stock or graphic scene — the beat as a bridge rather
  // than a layer, exactly as designed. It can only do that when there IS a
  // neighbour, and it records `capped: false` with a reason when there is not.
  //
  // That distinction is the whole diagnosis for "why is the beat 64%". A cap
  // that is enforced and cannot bind looks identical, in the coverage split, to
  // a cap nobody wired up — and on 2026-08-13 it was the first: every FOOTAGE
  // take had all its windows come back empty, so the take was beats end to end
  // with nothing to extend into. Tightening the cap would have changed nothing.
  const bridges = gen.beatBridges || [];
  if (bridges.length > 0) {
    const capped = bridges.filter((b) => b.capped);
    const orphaned = bridges.filter((b) => !b.capped);
    console.log(
      `[YTPipeline] beat bridges: ${capped.length} capped to ${BEAT_BRIDGE_MAX_SECONDS}s ` +
        `(${Math.round(capped.reduce((n, b) => n + (b.gaveSeconds || 0), 0) * 10) / 10}s given back to real visuals), ` +
        `${orphaned.length} could NOT be capped`
    );
    for (const b of orphaned) {
      console.log(`::warning::${b.takeId}: a ${b.seconds}s beat could not be bridged — ${b.reason}`);
    }
  }
  // The concept rung's own line, so a run answers "did the model rescue any
  // windows" without diffing the stock table against the ladder by hand.
  if (gen.conceptCalls?.asked > 0) {
    console.log(
      `[YTPipeline] concept fallback: ${gen.conceptCalls.asked} window(s) asked, ` +
        `${gen.conceptCalls.answered} got a filmable concept, ${gen.conceptCalls.matched} matched a clip with it`
    );
  }
  // The property the whole classification exists to guarantee, asserted rather
  // than assumed: no proper noun the script named may appear in a search query.
  const leaked = (gen.stockWindows || []).filter((w) =>
    (w.dropped || []).some((d) => w.keywords.join(" ").toLowerCase().includes(String(d).toLowerCase()))
  );
  for (const w of leaked) {
    console.log(`::error::stock window ${w.takeId}#${w.phase} searched for a proper noun (${w.dropped.join(", ")})`);
  }
  if (leaked.length > 0) {
    throw new Error(`${leaked.length} stock window(s) put a proper noun into a search — a clip could be presented as a specific place`);
  }
  console.log(
    `[YTPipeline] word timing: ${gen.wordTimingCoverage.withTiming}/${gen.wordTimingCoverage.takes} takes transcribed ` +
      `— the rest use even pacing`
  );
  // Availability of timing and USE of timing are different numbers, and only the
  // second one says whether the reveals actually landed on the words. The build
  // collected it from the first animated graphic and never printed it, so every
  // report so far has answered a question nobody asked.
  // THE STOCK CREDITS, NAMED. The description carries them because the Pexels API
  // guidelines require a prominent link and photographer credit (see
  // longform/STOCK-LICENSING.md) — but nothing logged WHICH clips were used, so a
  // licensing question had no answer and the report could not name them. Logged
  // and persisted now: an obligation you cannot audit is one you cannot show you
  // met.
  if (gen.stockCredits.length > 0) {
    // `.line`, not the object. A credit is {photographer, urls, line} and joining
    // the objects printed "[object Object]" nine times — the description was
    // always correct (creditsBlock maps .line), but the build report named
    // nothing, which is the one thing this log exists to do.
    console.log(`[YTPipeline] stock: ${gen.stockCredits.length} Pexels clip(s) used — ${gen.stockCredits.map((c) => c?.line || String(c)).join(" | ")}`);
  } else if (gen.stockConfigured) {
    console.log("[YTPipeline] stock: no clips used this build");
  }

  const sc = gen.scenes;
  console.log(
    `[YTPipeline] scenes: ${sc.count} visual(s), average ${sc.averageSeconds}s, longest ${sc.longestSeconds}s ` +
      `(cap ${sc.cap}s)` + (sc.overCap > 0 ? ` — ${sc.overCap} over cap` : "") +
      (sc.sameKindRuns > 0 ? `; ${sc.sameKindRuns} same-kind adjacency` : "")
  );
  if (sc.overCap > 0) {
    console.log(`::warning::${sc.overCap} scene(s) exceed YT_SCENE_MAX_SECONDS — one visual is holding the screen`);
  }

  const rs = gen.revealSync;
  console.log(
    `[YTPipeline] reveal sync: ${rs.synced}/${rs.reveals} reveals landed on a spoken word (${rs.pct}%) ` +
      `across ${rs.graphics} animated graphic(s)` +
      (rs.evenPaced > 0 ? `; ${rs.evenPaced} fell back to even pacing` : "") +
      (rs.reveals > 0 ? ` — ${Object.entries(rs.byType).map(([k, v]) => `${k} ${v.synced}/${v.reveals}`).join(", ")}` : "")
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
  // The old report had a `failures` array and a "falls back to footage" message.
  // Both are gone: falls are reported above with their layer and reason.
  //
  // THIS COMMENT USED TO SAY TYPOGRAPHY IS WHAT A SEGMENT FALLS BACK TO. That is
  // stale by a whole design decision: Peter killed the typography layer on
  // sight, because word slides duplicate the burned captions — two pieces of
  // text saying the same thing, which is card 7's defect wearing a different
  // hat. Nothing falls back to typography, and nothing should be built that
  // does. The chain for a failed FOOTAGE window is: a map when the window names
  // a place, a widened stock search when it does not, the neighbouring scene
  // extended when stock still comes up empty, and the beat only as a bridge
  // under BEAT_BRIDGE_MAX_SECONDS.
  if (gen.intents.requested === 0) {
    console.log("::warning::the writer requested no graphics for this script — every segment is carried by typography");
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
  // The zoom pulses need word timing on the ON-CAMERA takes, which is I/O, so it
  // happens here rather than inside the (synchronous) retention stage.
  await attachEmphasis(withVisuals, { getWordTimestamps });
  const retention = applyRetentionStage(withVisuals, { workDir, dim: canvasFor(RESOLUTION) });
  console.log(renderRetentionSummary(retention).split("\n").map((l) => `[YTPipeline] ${l}`).join("\n"));

  const chapters = buildChapters(withVisuals, script);

  // ── the micro-punches ────────────────────────────────────────────────────
  // Chosen AFTER the retention edit, because that edit changes on-camera segment
  // lengths and a punch timed against the unedited timeline would drift exactly
  // as the captions would. Both are laid out from the same `seg.seconds`, which
  // is what keeps a punch on screen while its own words are.
  const punchPlan = selectPunches(withVisuals);
  console.log(
    `[YTPipeline] micro-punches: ${punchPlan.punches.length} of ${punchPlan.considered} candidate(s) — ` +
      (punchPlan.punches.map((p) => `"${p.text}" @${p.at}s`).join(", ") || "none")
  );
  // THE CARD 7 CHECK, RUN ON THE BUILD RATHER THAN LEFT TO THE TEST SUITE. The
  // suite proves the construction is sound; this proves it on the actual script
  // being shipped, which is where "middle of the screen disagrees with the
  // captions" would actually have happened.
  const captionText = new Map(
    (withVisuals.segments || []).map((s) => [s.takeId, captionTextFor(s)])
  );
  const mismatched = punchPlan.punches.filter((p) => !(captionText.get(p.takeId) || "").includes(p.text));
  for (const p of mismatched) {
    // PRINT THE CAPTION TEXT, NOT JUST THE PUNCH. This guard fired twice on
    // 2026-08-11 saying only that "highway ten" was not verbatim in s4t5, and
    // the one fact needed to fix it — that the captions read "highway, ten" —
    // was not on screen. The captions are Whisper's output, so they exist
    // nowhere but this run: a failure that does not print them costs another
    // 30-minute build just to look.
    console.log(`::error::micro-punch "${p.text}" does not appear verbatim in take ${p.takeId}'s captions`);
    console.log(`[YTPipeline]   take ${p.takeId} captions: ${JSON.stringify(captionText.get(p.takeId) || "(no caption text for this take)")}`);
  }
  if (mismatched.length > 0) {
    throw new Error(`${mismatched.length} micro-punch(es) would put words on screen the captions do not say`);
  }

  // ── the music bed ────────────────────────────────────────────────────────
  // Fetched here rather than inside the renderer so a licensing or network
  // failure is reported before twelve minutes of encoding, not after.
  // The Drive side of the bed cache. Both halves swallow their errors: a cache
  // that cannot be read costs one download, and a cache that cannot be written
  // costs one download next build. Neither is worth failing a video over, and
  // neither is silent — they warn, so a folder whose permissions changed shows
  // up as a repeated fetch with a reason rather than as mysterious slowness.
  const musicDriveGet = async (name) => {
    try {
      const id = await findInFolder(MUSIC_FOLDER, name);
      return id ? await downloadFileById(id) : null;
    } catch (err) {
      console.log(`::warning::music cache read failed (${err.message}) — fetching from source`);
      return null;
    }
  };
  const musicDrivePut = async (name, buf) => {
    await uploadToFolder(MUSIC_FOLDER, name, buf, "audio/mpeg");
    console.log(`[YTPipeline] cached ${name} to the Longform Music folder`);
  };

  const track = pickTrack(result.selectedTitle || result.query || "");
  const bed = await fetchMusicBed({ track, dir: workDir, driveGet: musicDriveGet, drivePut: musicDrivePut });
  const music = musicReport(bed);
  if (music.used) {
    console.log(`[YTPipeline] music: "${music.track.title}" (${music.source}) — ${music.credit}`);
  } else {
    console.log(`::warning::no music bed (${music.reason}) — the video ships with narration only`);
  }

  const rendered = await renderTimeline(withVisuals, {
    workDir,
    resolveBrollPath,
    resolution: RESOLUTION,
    openingOverlay: overlayResult.overlay,
    musicPath: bed.path,
    punches: punchPlan.punches,
  });

  // ── THE PIPELINE WATCHES ITS OWN RENDER ──────────────────────────────────
  //
  // BEFORE THE UPLOAD AND BEFORE THE CARD, and the order is the requirement
  // rather than an optimisation. Peter's eyes have been the only thing in this
  // loop that ever looked at the finished video, which means every defect cost a
  // review round to find and the pipeline reported success on all of them. A
  // check that runs after the card has been sent is a check that has already
  // failed at its job.
  //
  // Failing here throws away a completed render, which is expensive and correct.
  // A build that cannot prove its own output is watchable has not produced a
  // publish candidate, and sending one anyway is how card 8 happened.
  const qc = runArtifactQc({
    videoPath: rendered.outputPath,
    duration: rendered.seconds,
    qcInputs: rendered.qcInputs,
    workDir,
  });
  if (!qc.ok) {
    // KEEP THE EVIDENCE BEFORE THROWING. A fifty-five minute build that dies and
    // leaves nothing to inspect turns a diagnosable defect into a guess, and it
    // did exactly that on 2026-08-12. The workflow collects this directory on
    // failure, so the render is downloadable from the run.
    //
    // It also means a render the gate refused to card is still watchable.
    // Blocking the card and hiding the video are different things.
    const kept = preserveFailedRender({
      videoPath: rendered.outputPath,
      qc,
      plan: {
        videoId: videoIdFor(record.requestId),
        title: result.selectedTitle || null,
        plannedSeconds: rendered.qcInputs?.plannedSeconds ?? null,
        renderedSeconds: rendered.seconds,
        segmentDurations: rendered.qcInputs?.segmentDurations ?? [],
        layers: layerKnobs(),
      },
    });
    console.log(`::error::the render failed ${qc.failures.length} artifact check(s) — no card will be sent`);
    throw new Error(
      `the render did not pass its own checks and will not be sent for review:\n${qc.summary}\n` +
        (kept.video
          ? `The render is kept at ${kept.video} and is attached to this run as the "failed-render" artifact.`
          : `The render could NOT be preserved: ${kept.errors.join("; ")}`)
    );
  }

  // ── EVERYTHING PAST THIS POINT IS HOLDING A SHIPPABLE RENDER ─────────────
  //
  // Run 31842162416 produced the first file that ever passed every artifact
  // check — "the render may ship" — and then died two seconds later building
  // the review card, because the Anthropic account had run out of credit. The
  // preservation rule only ever covered a render the GATE refused, so a run
  // that failed while holding a PASSING render preserved nothing: eighty-five
  // minutes of work, a publishable video, and the file went with the runner.
  //
  // The rule was always "no gate may fail without leaving the data that
  // explains it". This is the same rule pointed at the other case: no failure
  // after a passing QC may take the render with it. Packaging, thumbnail,
  // logging, upload and the review card all live in here — an API balance, a
  // network blip, a Metricool 500 — and every one of them now costs a retry
  // instead of a rebuild.
  try {
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
      // Empty when no bed was fetched, so a narration-only video carries no music
      // credit for music it does not contain.
      musicCredits: musicCreditsBlock(music.used ? bed.track : null),
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
    let thumbnailDriveId = null;
    try {
      thumb = await generateThumbnailHook({ title: packaging.title, script });
      if (thumb.hook) {
        const kicker = result.market === "austin" ? "AUSTIN" : "SAN ANTONIO";

        // THE FACE CONTEST (Peter's call after video 1: thumbnails feature his
        // face, never text alone). Source: the dedicated thumbnail take when
        // he shot one; otherwise the hook take — the first on-camera segment,
        // where he is at his most energised. Three composites compete on the
        // emotional-trigger axis; every candidate is preserved as evidence.
        let face = null;
        const onCam = plan.segments.find((s) => s.kind === "on_camera");
        const faceSource = recordings.thumbnail?.path
          ? { path: recordings.thumbnail.path, seconds: recordings.thumbnail.durationSeconds || 10, takeId: "thumbnail" }
          : onCam
            ? { path: onCam.source, seconds: onCam.seconds, takeId: onCam.takeId }
            : null;
        if (faceSource) {
          face = await buildFaceThumbnail({ hookText: thumb.hook, kicker, source: faceSource, workDir });
          preserveGateEvidence("thumbnail-face-contest", {
            source: face.source,
            frames: face.frames,
            ranked: face.ranked || null,
            fallbacks: face.fallbacks,
            contestNote: face.contestNote || null,
            winnerIndex: face.winner?.index ?? null,
            reason: face.reason || null,
          }, { files: preserveCandidates(face, workDir) });
        }

        // fitUnderLimit returns { buffer, converted } — NOT bytes. Writing the
        // object threw on video 1's real build ("Received an instance of
        // Object") and the run shipped without its thumbnail attachment. The
        // fallback held, which is why this was a warning and not a dead build.
        const fitted = await fitUnderLimit(
          face?.winner
            ? readFileSync(face.winner.path)
            : await renderThumbnail(thumb.hook, { kicker })
        );
        thumbnailPath = join(workDir, fitted.converted ? "thumbnail.jpg" : "thumbnail.png");
        writeFileSync(thumbnailPath, fitted.buffer);
        if (face?.winner) {
          console.log(
            `[YTPipeline] thumbnail: FACE composite won (frame at ${face.winner.frameAt}s, ` +
              `trigger=${face.winner.emotionalTrigger ?? "?"} legibility=${face.winner.legibility ?? "?"}, ` +
              `${face.candidates.length} candidates, source ${face.source}${face.winner.cutout ? ", matte" : ", raw frame"})`
          );
        } else {
          console.log(`::warning::face thumbnail unavailable (${face?.reason || "no on-camera source"}) — shipping the text-only card`);
        }

        // Persisted for the sweep: thumbnails.set runs on a later cron with
        // this workDir gone, and a text-only re-render there would quietly
        // replace the face composite the contest just chose.
        try {
          // Into the OUTPUTS subfolder, never among the takes: an output in the
          // recordings folder gets transcribed and matched as the newest
          // recording of whatever take it quotes — probe 32300759856 built
          // thumbnails from the teaser that way (see isPipelineOutput).
          const up = await uploadToFolder(await ensureFolder("outputs", ingest.folderId), `thumbnail-${videoIdFor(record.requestId)}.${fitted.converted ? "jpg" : "png"}`, fitted.buffer, fitted.converted ? "image/jpeg" : "image/png");
          thumbnailDriveId = up?.id || null;
        } catch (err) {
          console.log(`::warning::thumbnail did not persist to Drive (${err.message}) — the sweep will re-render the text card instead of the face composite`);
        }

        console.log(
          `[YTPipeline] thumbnail text: "${thumb.hook}" ` +
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

    // ── the teaser: ~20 vertical seconds that send people to this video ──────
    //
    // Cut HERE, while the takes are still local — the delivery happens at the
    // distribution sweep (after the publish flip), but a sweep has no workDir
    // and no clips, so the cut and the delivery are different moments by
    // construction. Non-fatal: a video without its teaser still ships, with
    // the gap named and the evidence preserved.
    let teaserRecord = null;
    try {
      const teaser = await cutTeaser({ script, recordings, workDir });
      const up = await uploadToFolder(await ensureFolder("outputs", ingest.folderId), `teaser-${videoId}.mp4`, readFileSync(teaser.path), "video/mp4");
      if (!up?.id) throw new Error("Drive upload returned no file id");
      teaserRecord = {
        driveFileId: up.id,
        seconds: teaser.seconds,
        // The hook line rides along: the sweep writes the platform captions
        // from it, and the script is out of reach by then.
        hookLine: script.hook || null,
        cutAt: new Date().toISOString(),
      };
      console.log(`[YTPipeline] teaser cut: ${teaser.seconds}s (${teaser.report.takes.map((t) => t.takeId).join(" + ")}) — delivers to the Trial tab when the video publishes`);
    } catch (err) {
      console.log(`::warning::teaser cut failed — the video ships without one (${err.message})`);
      preserveGateEvidence("teaser-cut", { error: err.message, requestId: record.requestId });
    }

    let nextLog = recordRender(videoLog, {
      // Who fronts this video — the ingestion and matching above never cared,
      // but everything downstream that names the video should name them.
      presenter: { id: presenter.id, name: presenter.name, role: presenter.role },
      teaser: teaserRecord,
      thumbnailDriveId,
      // The sweep's publish step needs this AFTER the build's workDir is
      // gone: the synthetic-content declaration must ride the same
      // videos.update that flips the video public.
      syntheticNarration,
      videoId,
      requestId: record.requestId,
      title: packaging.title,
      market: result.market,
      intent: result.intent,
      runtimeSeconds: rendered.seconds,
      bytes: rendered.bytes,
      resolution: RESOLUTION,
      brollHashes: plan.segments.flatMap((s) => (s.broll || []).map((b) => b.contentHash).filter(Boolean)),
      // A durable record of what licensed material this video contains, so the
      // question "where did that clip come from" is answerable years later.
      stockCredits: gen.stockCredits,
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

    // THE PATH, NOT THE BYTES. readFileSync on the finished render threw
    // ERR_FS_FILE_TOO_LARGE on run 31909360969 — Node caps a Buffer at 2 GiB
    // and a grained eleven-minute 1080p render is 2.36. The uploader reads it
    // one ~50 MB part at a time.
    // ── the watch report: the pipeline watches its own video ─────────────
    //
    // Advisory by construction — buildWatchReport cannot throw, and a failed
    // watcher costs the card a paragraph, never the build. It runs before the
    // upload so the frames come from the exact file being shipped.
    const watch = await buildWatchReport({
      plan,
      videoPath: rendered.outputPath,
      ffmpeg,
      client: visionClientOrNull(),
      workDir,
    });
    console.log(`[YTPipeline] watch report: ${watch.judged} scene(s) judged` +
      (watch.matchRate !== null ? `, match rate ${watch.matchRate}%` : "") +
      (watch.flagged?.length ? `, ${watch.flagged.length} flagged` : ""));

    const upload = await uploadPrivate(rendered.outputPath, packaging, {
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
      watchReport: watch.text,
      // The card names who fronts the video. The DECISION is not theirs —
      // review cards go to Peter's surfaces only, and Approve stays his.
      presenter: { id: presenter.id, name: presenter.name, role: presenter.role },
    });

    saveApprovals(
      appendRequest(approvals, {
        requestId: reviewRequestId,
        kind: KIND_VIDEO_REVIEW,
        videoId,
        payload: { videoId, title: packaging.title, requestId: record.requestId },
        presenter: { id: presenter.id, name: presenter.name, role: presenter.role, assignedAt: record.presenter?.assignedAt || null, via: "build" },
      })
    );
    console.log(`[YTPipeline] uploaded PRIVATE and sent ${reviewRequestId} for review`);
  } catch (err) {
    // The render passed its checks; whatever broke afterwards did not touch it.
    // Keep it, say plainly that it is publishable, and rethrow the real error.
    preserveQcPassedRender({
      videoPath: rendered.outputPath,
      error: err,
      qc,
      rendered,
      videoId: videoIdFor(record.requestId),
    });
    throw err;
  }
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
    // APPROVE IS PUBLISH. Recording the approval is what arms the
    // distribution sweep, which runs at the top of this same invocation on
    // the next pass: thumbnail, playlist, the privacy flip to PUBLIC (with
    // the synthetic-content declaration when the render needs one), and the
    // pinned comment — no Studio trip. Peter overruled the record-only
    // design on 2026-08-19 after approving video 1 and being told to go
    // publish it himself.
    console.log(`[YTPipeline] ${review.record.requestId} APPROVED — publishing on this run.`);
    saveVideoLog(recordReview(videoLog, videoId, { approved: true }));
    saveApprovals(markActed(approvals, review.record.requestId, { action: "review_recorded", result: { videoId, approved: true } }));
    // The sweep at the top of main() ran BEFORE this approval was recorded —
    // deliberately, so an overnight publish gets its comment first. Run it
    // again now that the entry is approved, or "Approve is publish" would
    // quietly mean "publish on the NEXT cron", which is the Studio-era lag
    // wearing a new hat. Idempotent by construction, so the double pass costs
    // one no-op walk when there is nothing to do.
    await sweepDistribution();
    console.log("[YTPipeline] Shorts cutdowns are now eligible.");
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
 * THE SWEEP IS WHERE APPROVE BECOMES PUBLISH: thumbnail and playlist land
 * while the video is private, then the publish step flips it public, then the
 * pinned comment posts — one pass, same cron. (This header used to say
 * "NOTHING HERE PUBLISHES"; that design ended 2026-08-19.)
 */
async function sweepDistribution() {
  const videoLog = loadVideoLog();
  const pending = (videoLog.videos || []).filter(
    (v) => v.approved && !String(v.requestId || "").startsWith("TEST-") &&
      (!(v.distribution?.thumbnail?.done && v.distribution?.playlist?.done && v.distribution?.publish?.done && v.distribution?.comment?.done) ||
        // A cut teaser still waiting for its Trial-tab delivery keeps the
        // entry in the sweep even after the four YouTube steps finish.
        (v.teaser?.driveFileId && !v.distribution?.teaser?.done))
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

    // The thumbnail. The FACE COMPOSITE the build's contest chose persists in
    // Drive (thumbnailDriveId); re-rendering from the logged text is the
    // fallback for entries that predate the contest or whose upload failed —
    // the text card is reproducible, the chosen face is not.
    let thumbnailPath = null;
    if (entry.thumbnailDriveId) {
      try {
        const bytes = await downloadFileById(entry.thumbnailDriveId);
        // setThumbnail declares the content type from the EXTENSION, and
        // fitUnderLimit may have converted the composite to JPEG — sniff the
        // magic bytes rather than assuming, or the upload lies about its type.
        const ext = bytes[0] === 0xff && bytes[1] === 0xd8 ? "jpg" : "png";
        thumbnailPath = join(process.env.RUNNER_TEMP || tmpdir(), `thumb-${entry.videoId}.${ext}`);
        writeFileSync(thumbnailPath, bytes);
      } catch (err) {
        console.log(`::warning::${entry.videoId}: face thumbnail download failed (${err.message}) — falling back to the text render`);
        thumbnailPath = null;
      }
    }
    if (!thumbnailPath && entry.thumbnailText) {
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
      declareSynthetic: entry.syntheticNarration === true,
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

    // Visibility failures name the identity that was looking (evidence rule:
    // no failure without the data that explains it). A private video invisible
    // to this token means the token's channel is not the video's channel.
    if (report.identity) {
      const who = report.identity.noChannel
        ? "the token's Google identity has NO YouTube channel"
        : report.identity.id
          ? `the token acts as channel "${report.identity.title}" (${report.identity.id})`
          : "the token identity lookup itself failed";
      console.log(
        `::warning::${entry.videoId}: the video exists but is invisible to the API — ${who}. ` +
          `If that is not the channel Metricool uploads to, re-mint YT_REFRESH_TOKEN as that channel ` +
          `(scripts/get-refresh-token.js --youtube, pick the channel identity on Google's account chooser).`
      );
      preserveGateEvidence("distribution-identity", {
        videoId: entry.videoId,
        youtubeVideoId: entry.youtubeVideoId,
        identity: report.identity,
        steps: report.steps,
      });
    }

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

    // ── the teaser rides the publish ─────────────────────────────────────────
    //
    // Once the video is PUBLIC, its ~20-second vertical trailer goes to the
    // Trial tab — the same lane the trial reels travel, so Peter posts it
    // natively with the captions on the card. Gated on the publish flip
    // because a teaser pointing at a private video is a dead link with his
    // face on it; recorded as a distribution step so a failed delivery
    // retries on the next cron and a completed one never re-sends.
    const publishDone = done.publish?.done || entry.distribution?.publish?.done;
    if (publishDone && entry.teaser?.driveFileId && !entry.distribution?.teaser?.done) {
      try {
        const delivered = await deliverTeaserToTrialTab(entry);
        log = {
          ...log,
          videos: log.videos.map((v) =>
            v.videoId === entry.videoId
              ? { ...v, distribution: { ...(v.distribution || {}), teaser: { done: true, at: new Date().toISOString(), detail: delivered } } }
              : v
          ),
        };
        saveVideoLog(log);
        console.log(`[YTDistribute] ${entry.videoId}: teaser on the Trial tab — ${delivered.driveLink || "delivered"}`);
      } catch (err) {
        console.log(`::warning::${entry.videoId}: teaser delivery FAILED — ${err.message} (retries next run)`);
      }
    }
  }
}

/**
 * One teaser onto the Trial tab, with its platform captions.
 *
 * The card's caption block carries all three post texts, labeled — the Trial
 * tab renders one caption field, and three clearly-marked sections in it
 * beats inventing a card shape the dashboard has never heard of
 * (dashboard-routes-cards-on-kind: unknown payloads render nowhere).
 */
async function deliverTeaserToTrialTab(entry) {
  const accessToken = await getAccessToken();
  const work = mkdtempSync(join(tmpdir(), "yt-teaser-deliver-"));
  try {
    const safeTitle = String(entry.title || entry.videoId).replace(/[^\w-]+/g, "_").slice(0, 60);
    const local = join(work, `TEASER-${safeTitle}.mp4`);
    writeFileSync(local, await downloadFileById(entry.teaser.driveFileId));

    const captions = teaserCaptions({ title: entry.title, hookLine: entry.teaser.hookLine });
    const caption = [
      "INSTAGRAM (paste as-is):", captions.instagram, "",
      "TIKTOK:", captions.tiktok, "",
      "LINKEDIN:", captions.linkedin,
    ].join("\n");
    const city = entry.market === "austin" ? "austin" : "san_antonio";

    const delivery = await deliverToOwner(accessToken, local, city, caption, {
      isTrial: true,
      trialLabel: `TEASER — ${entry.title}`,
      trialAngle: "yt_teaser",
      trialHookLine: entry.teaser.hookLine || null,
      window: "manual",
      sourceVideoId: entry.videoId,
    });

    // The Trial tab reads trial-variants.json; a card with no record here
    // renders once from the webhook and vanishes on the next page load — the
    // trial-parity lesson, inherited from the edit queue.
    const history = loadTrialHistory();
    history.variants.push({
      date: new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" }),
      window: "manual",
      sourceVideoId: entry.videoId,
      sourceFileName: `TEASER-${safeTitle}`,
      city,
      hookAngle: "yt_teaser",
      hookLine: entry.teaser.hookLine || null,
      variantNumber: 1,
      caption: captions.instagram.slice(0, 200),
      deliveryDriveLink: delivery.driveLink || null,
      generatedAt: new Date().toISOString(),
      trigger: "yt_teaser",
    });
    saveTrialHistory(history);
    recordPost(loadLog(), {
      driveFileId: entry.teaser.driveFileId,
      fileName: `TEASER — ${entry.title}`,
      city,
      caption: captions.instagram,
      voiceover: false,
      platforms: [],
      type: "trial_variant",
      hookAngle: "yt_teaser",
      variantNumber: 1,
      window: "manual",
      deliveryDriveLink: delivery.driveLink || null,
    });
    return { driveLink: delivery.driveLink || null, captions };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/**
 * Advance ONE delivered kit: build when the recordings are complete, say what
 * is missing when they are not.
 *
 * The review gate is scoped to THIS video (reviewGateFor), never to whichever
 * review happens to be newest. A rejected review cleared the upload markers
 * (recordRework), which is what put the kit back in flight — so "review
 * already recorded, entry not uploaded" means rebuild with the same takes.
 */
async function advanceDeliveredKit(approvals, record) {
  const review = reviewGateFor(approvals, record);
  if (review.state === "waiting") {
    console.log(
      `[YTPipeline] ${review.record.requestId} is waiting on Peter's review of ${record.requestId} — exiting cleanly`
    );
    // A review card that has sat three days unanswered needs a human told.
    await maybeNudgeStalledRequest(approvals, review.record, { dryRun: DRY_RUN });
    return;
  }
  if (review.state === "already-acted") {
    const entry = findByRequest(loadVideoLog(), record.requestId);
    if (entry && !isUploaded(entry)) {
      console.log(
        `[YTPipeline] ${review.record.requestId} was rejected and queued for rework ` +
        `(revision ${entry.revision || 2}) — rebuilding ${record.requestId} with the same takes`
      );
    } else {
      console.log(`[YTPipeline] ${review.record.requestId} review already recorded — nothing further for ${record.requestId}`);
      return;
    }
  }
  await buildFromRecordings(approvals, record);
}

async function main() {
  // Distribution first: it is independent of the stage machine below, and a
  // video Peter published overnight gets its comment posted on this run rather
  // than after whatever the stage machine decides to do.
  await sweepDistribution();

  const approvals = loadApprovals();

  // AN ANSWERED REVIEW OUTRANKS A WAITING BRIEF. Run 32201677539 proved the
  // gap: video 1 sat APPROVED while video 2's brief sat unanswered, and the
  // topic-keyed switch below exited "waiting on Peter" without publishing the
  // decision he had already made. The review check now runs first,
  // unconditionally — see pendingAnsweredReview for the account.
  const answered = pendingAnsweredReview(approvals);
  if (answered) {
    await handleVideoReview(approvals, answered);
    return;
  }

  // THE TOPIC GATE. Only the newest brief is a question. An approval or a
  // rejection on it is acted here and ends the run; "waiting" and "none" FALL
  // THROUGH to the build stage, which is keyed off delivered kits and not off
  // this switch. That fall-through is the 2026-08-31 fix: the Monday brief for
  // video 3 went out while video 2's 35 takes were uploading, the switch
  // returned on "waiting", and six green runs built nothing. See yt-stage.js.
  const topic = decisionState(approvals, KIND_TOPIC_PICK);
  switch (topic.state) {
    case "none":
      console.log("[YTPipeline] no brief has been sent yet");
      break;

    case "waiting":
      console.log(
        `[YTPipeline] ${topic.record.requestId} is waiting on Peter (sent ${topic.record.requestedAt})`
      );
      // Waiting is normal for a day and evidence of a problem after three: he
      // has not seen the card, or the dashboard dropped his answer (2026-08-19
      // cost video 2 a week). Either way the fix starts with telling him.
      await maybeNudgeStalledRequest(approvals, topic.record, { dryRun: DRY_RUN });
      break;

    case "approved":
      await deliverKitForApprovedTopic(approvals, topic.record);
      return;

    case "rejected":
      await reBriefAfterRejection(approvals, topic.record);
      return;

    case "already-acted":
      // The kit is out; the build stage below owns it from here.
      break;

    default:
      console.log(`[YTPipeline] unrecognised state "${topic.state}" — doing nothing`);
      return;
  }

  // THE BUILD STAGE. Every delivered kit whose video has no upload, oldest
  // first — a kit in flight outranks a question not yet answered.
  const kits = inflightKits(approvals, loadVideoLog());
  if (kits.length === 0) {
    // Nothing is being recorded. The only thing left to wait on is a review.
    const review = decisionState(approvals, KIND_VIDEO_REVIEW);
    if (review.state === "waiting") {
      console.log(`[YTPipeline] ${review.record.requestId} is waiting on Peter's review — exiting cleanly`);
      await maybeNudgeStalledRequest(approvals, review.record, { dryRun: DRY_RUN });
    } else {
      console.log("[YTPipeline] nothing in flight — exiting cleanly, will check again next run");
    }
    return;
  }
  if (topic.state === "waiting") {
    console.log(
      `[YTPipeline] ${kits.map((k) => k.requestId).join(", ")} ${kits.length === 1 ? "has" : "have"} a delivered kit ` +
      `and no upload — the newer brief does not gate a video already being recorded; advancing`
    );
  }
  for (const kit of kits) {
    await advanceDeliveredKit(approvals, kit);
    // One render per run. An upload logged for this kit means the build ran;
    // anything after it waits for the next poll (and the 180-minute clock).
    if (isUploaded(findByRequest(loadVideoLog(), kit.requestId))) return;
  }
}

main().catch((err) => {
  console.error(`[YTPipeline] FAILED: ${err?.stack || err}`);
  process.exit(1);
});
