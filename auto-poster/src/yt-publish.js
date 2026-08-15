/**
 * yt-publish.js — upload private, ask Peter, and stop.
 *
 * THE CENTRAL INVARIANT: nothing in this file, and nothing it calls, can make a
 * video public. Not on approval, not on retry, not on any branch.
 *
 * That is stronger than the spec asks for, and deliberately so. The spec says
 * publishing stays manual until Peter says otherwise — but "manual" enforced by
 * a flag is one bad merge away from not being manual. Enforced by there being
 * no code that does it, it cannot regress. `privacy` is a frozen constant, the
 * post body is asserted before it is sent, and the log refuses to record any
 * other value.
 *
 * WHAT APPROVAL ACTUALLY UNLOCKS, since it is not publishing:
 *   - the video is recorded as approved in youtube-log.json
 *   - the Shorts cutdowns become eligible (PR 6)
 *   - the B-roll it used counts as spent for future videos
 * Peter publishes in YouTube Studio, in the same visit where he sets the two
 * things Metricool's API cannot reach — the custom thumbnail and the
 * altered-or-synthetic content disclosure.
 *
 * That disclosure is not optional and not a formality. The B-roll narration is
 * Peter's ElevenLabs voice CLONE: synthetic speech in a real person's voice is
 * exactly what YouTube's policy covers. It is on the checklist for every video.
 */

import { uploadVideo } from "./yt-upload.js";
import { sendApprovalRequest } from "./delivery.js";
import { disclosureRequired, NARRATION_MODE } from "./yt-config.js";
import { PRIVACY } from "./yt-log.js";

const BASE = "https://app.metricool.com/api";

/** Frozen so a caller cannot pass "public" in and have it silently honoured. */
export const UPLOAD_PRIVACY = Object.freeze({ value: PRIVACY });

/** YouTube category for how-to / real-estate explainers. */
export const CATEGORY = "HOWTO_STYLE";

/**
 * Build the Metricool post body for a long-form upload.
 *
 * Pure, so the invariant is testable without a network call. `type: "video"` is
 * the long-form value the Phase 0 probe established; `short` is what the Reels
 * path sends and would silently reframe a 12-minute video.
 */
export function buildPostBody({ mediaUrl, packaging, publishAt, privacy = UPLOAD_PRIVACY.value }) {
  if (privacy !== PRIVACY) {
    throw new Error(`refusing to build a post with privacy "${privacy}" — this system only uploads ${PRIVACY}`);
  }
  return {
    // The post-level text becomes the YouTube description — youtubeData.description
    // is accepted and then silently dropped (Phase 0, #19).
    text: packaging.description,
    publicationDate: { dateTime: publishAt, timezone: "America/Chicago" },
    providers: [{ network: "youtube" }],
    media: [mediaUrl],
    autoPublish: true,
    shortener: false,
    draft: false,
    youtubeData: {
      type: "video",
      title: packaging.title,
      privacy: PRIVACY,
      category: CATEGORY,
      madeForKids: false,
      tags: packaging.tags || [],
    },
  };
}

/**
 * The manual checklist that travels with every review request.
 *
 * Written as instructions rather than as a note, because these are things
 * Peter has to DO before the video is fit to publish, and two of them cannot be
 * automated on the current API surface.
 */
export function reviewChecklist({ packaging, narrationMode = NARRATION_MODE, syntheticNarration = null }) {
  const items = [];
  if (disclosureRequired({ narrationMode, syntheticNarration })) {
    items.push(
      "Set 'Altered or synthetic content' to YES. " +
      "At least one voiceover segment in THIS render was spoken by your voice clone rather than by you, " +
      "and synthetic speech in a real person's voice is what the policy covers."
    );
  }
  items.push(
    "Thumbnail: the sweep sets it via the API within one cron of approval — CONFIRM it took in Studio. " +
    "If it is missing there, the account may need enabling for custom thumbnails, and the run log says why."
  );
  items.push("Check the chapters render — the first one has to be 0:00 or YouTube ignores all of them.");
  items.push(
    "After you publish: the pinned-comment text posts itself within one cron (the API cannot post to a private video). " +
    "PIN it when you see it — pinning is the one comment step the API cannot do."
  );
  items.push(
    "Add the end screen in Studio (last ~20s): your most recent video + a subscribe element. " +
    "The API cannot set end screens — see longform/probe/DISTRIBUTION-API.md."
  );
  for (const missing of packaging.missingCta || []) {
    items.push(`MISSING FROM THE DESCRIPTION: ${missing}. Add it by hand, or set the secret and it fixes itself next time.`);
  }
  items.push("Then flip it to Public yourself. Nothing here can do that.");
  return items;
}

/**
 * Upload the finished video to YouTube as PRIVATE, via Metricool.
 *
 * Returns { mediaUrl, postId, blogId }. Throws with the stage named — a
 * half-finished upload must not look like a success, or the review request goes
 * out pointing at a video that is not there.
 */
export async function uploadPrivate(video, packaging, { blogId, userId, token, publishAt }) {
  console.log(`[YTPublish] uploading "${packaging.title}" as ${PRIVACY}`);

  // `video` is a PATH for anything render-sized (see uploadVideo — a Buffer
  // cannot hold 2 GiB); a Buffer is still accepted for small callers.
  const mediaUrl = await uploadVideo(video, { blogId, userId, token });

  const body = buildPostBody({ mediaUrl, packaging, publishAt });

  // Belt and braces: assert the body one more time on the way out, so a future
  // edit to buildPostBody cannot quietly ship a public upload.
  assertPrivate(body);

  const res = await fetch(`${BASE}/v2/scheduler/posts?blogId=${blogId}&userId=${userId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Mc-Auth": token },
    body: JSON.stringify(body),
  });
  const raw = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(`Metricool refused the long-form post (${res.status}): ${JSON.stringify(raw).slice(0, 300)}`);
  }

  const postId = raw?.id || raw?.postId || raw?.data?.id || null;
  console.log(`[YTPublish] scheduled as ${PRIVACY} — Metricool post ${postId}`);
  return { mediaUrl, postId, blogId };
}

/**
 * The last line of defence, and the reason it exists as its own function:
 * it is called from two places and tested directly.
 */
export function assertPrivate(body) {
  const privacy = body?.youtubeData?.privacy;
  if (privacy !== PRIVACY) {
    throw new Error(`BLOCKED: post body has privacy "${privacy}", expected "${PRIVACY}"`);
  }
  if (body?.youtubeData?.type !== "video") {
    throw new Error(`BLOCKED: post body has type "${body?.youtubeData?.type}", expected "video"`);
  }
  return true;
}

/** The review email — what he watched, what is left to do, and what to reply. */
export function renderReviewText({ packaging, youtubeUrl, driveLink, checklist, stats = {} }) {
  const lines = [];
  lines.push(`READY FOR REVIEW — ${packaging.title}`);
  lines.push("");
  if (youtubeUrl) lines.push(`Watch it (private): ${youtubeUrl}`);
  if (driveLink) lines.push(`Or from Drive: ${driveLink}`);
  lines.push("");
  if (stats.runtimeMinutes) lines.push(`${stats.runtimeMinutes} min, ${stats.resolution || "1080p"}`);
  lines.push("");
  lines.push("BEFORE IT GOES PUBLIC — these are yours to do, the API cannot reach them:");
  checklist.forEach((item, i) => lines.push(`  ${i + 1}. ${item}`));
  lines.push("");
  lines.push("PINNED COMMENT (copy this):");
  lines.push("");
  lines.push(packaging.pinnedComment);
  lines.push("");
  lines.push("---");
  lines.push("Reply APPROVE in the dashboard once it is live, or send notes and I'll rework it.");
  lines.push("Approving does NOT publish it — it records the video and unlocks the Shorts cutdowns.");
  return lines.join("\n");
}

/**
 * Ask Peter to review the finished video.
 *
 * Deliberately says, in the body, that approving does not publish. The whole
 * design depends on him knowing that the last step is his, and a review request
 * that reads like a publish button would break that.
 */
export async function requestReview({
  requestId,
  videoId,
  packaging,
  youtubeUrl,
  driveLink,
  stats,
  accessToken = null,
  narrationMode = NARRATION_MODE,
  // What the render actually contained. Null when the caller did not look —
  // see disclosureRequired for why that falls back to the mode rather than
  // assuming the safe-sounding answer.
  syntheticNarration = null,
}) {
  const checklist = reviewChecklist({ packaging, narrationMode, syntheticNarration });
  return sendApprovalRequest({
    requestId,
    kind: "video_review",
    payload: {
      videoId,
      title: packaging.title,
      description: packaging.description,
      tags: packaging.tags,
      chapters: packaging.chapters,
      pinnedComment: packaging.pinnedComment,
      youtubeUrl,
      driveLink,
      privacy: PRIVACY,
      checklist,
      missingCta: packaging.missingCta || [],
      disclosureRequired: disclosureRequired({ narrationMode, syntheticNarration }),
      stats,
    },
    emailSubject: `Review: ${packaging.title}`,
    emailBody: renderReviewText({ packaging, youtubeUrl, driveLink, checklist, stats }),
    accessToken,
  });
}
