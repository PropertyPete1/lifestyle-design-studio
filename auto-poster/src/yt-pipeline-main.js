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
 * Stages this handles today:
 *   topic_pick approved  ->  write the script, deliver the recording kit
 *   topic_pick rejected  ->  fold Peter's notes into a fresh brief
 *
 * The stages after that — assembly, packaging, publish — land in later PRs and
 * hook in at the same place, keyed off the same requestId.
 */

import { loadLog, getRecentlyPostedIdsAllCities } from "./state.js";
import { getAccessToken, listCityVideos } from "./drive.js";
import { generateScript } from "./yt-script.js";
import { getVoiceSamples } from "./yt-voice.js";
import { buildKit, renderKitText, kitPayload } from "./yt-recording-kit.js";
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
  KIND_TOPIC_PICK,
} from "./yt-approvals.js";

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

    case "already-acted":
      // The kit is out. Recordings, assembly and review are the next PRs; until
      // they land this is where the pipeline correctly stops.
      console.log(
        `[YTPipeline] ${topic.record.requestId} already advanced ` +
        `(${topic.record.actedAction} at ${topic.record.actedAt}) — nothing further to do yet`
      );
      return;

    default:
      console.log(`[YTPipeline] unrecognised state "${topic.state}" — doing nothing`);
  }
}

main().catch((err) => {
  console.error(`[YTPipeline] FAILED: ${err?.stack || err}`);
  process.exit(1);
});
