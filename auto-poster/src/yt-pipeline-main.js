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
import { getAccessToken, listCityVideos, downloadVideo } from "./drive.js";
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
import { generateNarration, renderTimeline } from "./yt-assemble.js";
import { buildPackaging } from "./yt-packaging.js";
import { uploadPrivate, requestReview } from "./yt-publish.js";
import {
  loadLog as loadVideoLog,
  saveLog as saveVideoLog,
  recordRender,
  recordUpload,
  recordReview,
  findByRequest,
  videoIdFor,
  isUploaded,
  recentBrollHashes,
} from "./yt-log.js";
import { RESOLUTION } from "./yt-config.js";

const DRY_RUN = process.env.DRY_RUN === "true";

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

  const scriptResult = await generateScript({
    topic: { title: topic.title, hook: topic.hook, outline: topic.outline },
    notes: record.notes || null,
    voiceSamples,
  });

  console.log(
    `[YTPipeline] script "${scriptResult.title}" — ${scriptResult.takeCount} takes ` +
    `(${scriptResult.onCameraCount} on camera), ~${scriptResult.estimatedMinutes} min` +
    (scriptResult.belowBar ? " [BELOW BAR — best-of]" : "")
  );

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

  const byMarket = new Map();
  for (const candidate of brief.candidates) {
    if (!byMarket.has(candidate.market)) {
      try {
        byMarket.set(candidate.market, await listCityVideos(candidate.market));
      } catch {
        byMarket.set(candidate.market, []);
      }
    }
    candidate.proposedClips = proposeFootage(byMarket.get(candidate.market), usedIds);
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

  const brollPool = await brollFor(result.market);
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
  const chapters = buildChapters(plan, script);
  const rendered = await renderTimeline(plan, { workDir, resolveBrollPath, resolution: RESOLUTION });

  const packaging = await buildPackaging({
    topic: { title: result.selectedTitle, query: result.query, market: result.market, intent: result.intent },
    script,
    chapters,
  });

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
async function brollFor(market) {
  try {
    const videos = await listCityVideos(market || "san_antonio");
    return videos.map((v) => ({
      id: v.id,
      name: v.name,
      durationSeconds: Number(v.videoMediaMetadata?.durationMillis || 0) / 1000 || 0,
      contentHash: null,
      localPath: null,
    }));
  } catch (err) {
    console.warn(`[YTPipeline] could not list B-roll: ${err.message}`);
    return [];
  }
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
  saveVideoLog(recordReview(videoLog, videoId, { approved: false, notes }));
  saveApprovals(markActed(approvals, review.record.requestId, { action: "review_recorded", result: { videoId, approved: false, notes } }));
  console.log("[YTPipeline] notes recorded for the rework — nothing was published");
}

async function main() {
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
        console.log(`[YTPipeline] ${review.record.requestId} review already recorded — nothing further`);
        return;
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
