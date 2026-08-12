/**
 * webhook.mjs — put TEST- cards on the dashboard, and take them away again.
 *
 * A card type can only be proven to render by rendering one, and the only way
 * to get one onto the deployed dashboard is the same webhook production uses.
 * So the smoke suite posts real payloads through the real endpoint.
 *
 * WHAT MAKES THAT SAFE IS THE REQUEST ID, not the content.
 *
 * On 2026-08-06 a card whose every *field* was marked [TEST] was approved, and
 * the pipeline wrote a real script and delivered a real recording kit for it.
 * The candidates were marked; the requestId was not, and the requestId is the
 * only part the pipeline reads. So every id here carries the TEST- prefix that
 * latestRequestOfKind now filters out, and no scheduled job can see them
 * whatever decision the dashboard records.
 *
 * The payload shapes mirror the poster's exactly — approvalPayload's envelope,
 * with the flat `stage` field added in #41 — because a smoke test against a
 * shape production does not send is a test of nothing.
 */

import { randomUUID } from "node:crypto";

const APPROVAL_PATH = "/api/delivery/approval-webhook";
const DELIVERY_PATH = "/api/delivery/webhook";

export const TEST_PREFIX = "TEST-";

/** Ids created by this run, so cleanup knows exactly what to remove. */
const created = new Set();

export function testRequestId(kind) {
  const id = `${TEST_PREFIX}${kind}-${new Date().toISOString().slice(0, 10)}-${randomUUID().slice(0, 8)}`;
  created.add(id);
  return id;
}

function requireEnv() {
  const url = process.env.DASHBOARD_URL;
  const secret = process.env.DASHBOARD_WEBHOOK_SECRET;
  if (!url || !secret) {
    throw new Error(
      "DASHBOARD_URL and DASHBOARD_WEBHOOK_SECRET must both be set. " +
        "Without them this suite would silently test nothing."
    );
  }
  return { url: url.replace(/\/$/, ""), secret };
}

async function post(path, body) {
  const { url, secret } = requireEnv();
  const res = await fetch(`${url}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Webhook-Secret": secret },
    body: JSON.stringify(body),
  });
  const text = await res.text().catch(() => "");
  return { ok: res.ok, status: res.status, body: text.slice(0, 500) };
}

/** The envelope the poster sends, including the flat routing field from #41. */
function envelope({ requestId, kind, payload }) {
  const stage = payload && typeof payload.stage === "string" && payload.stage ? payload.stage : null;
  return { type: "approval", requestId, kind, stage, payload, requestedAt: new Date().toISOString() };
}

export async function postApproval({ requestId, kind, payload }) {
  return post(APPROVAL_PATH, envelope({ requestId, kind, payload }));
}

// ─── the four card shapes ────────────────────────────────────────────────────

export function topicPickPayload(requestId) {
  return {
    requestId,
    kind: "topic_pick",
    generatedAt: new Date().toISOString(),
    candidates: [1, 2, 3].map((i) => ({
      index: i,
      title: `[SMOKE TEST ${i}] Do not action — automated dashboard check`,
      intent: ["relocation", "comparison", "neighborhood"][i - 1],
      market: i === 2 ? "austin" : "san_antonio",
      query: `smoke test query ${i}`,
      hook: `SMOKE TEST card ${i}. This is an automated check of the dashboard and is not a real brief.`,
      outline: ["SMOKE — one", "SMOKE — two", "SMOKE — three", "SMOKE — four"],
      why: "SMOKE TEST — posted by the dashboard smoke suite. Safe to ignore; it is cleaned up automatically.",
      footage: "SMOKE TEST",
      proposedClips: [],
    })),
  };
}

export function recordingKitPayload(requestId) {
  return {
    stage: "recording_kit",
    requestId,
    title: "[SMOKE TEST] Recording kit — automated dashboard check",
    folderPath: `YT Recordings/${requestId}`,
    narrationMode: "peter",
    stats: {
      takeCount: 3,
      onCameraCount: 2,
      voiceoverCount: 1,
      estimatedRecordingSeconds: 60,
      estimatedSessionMinutes: 3,
    },
    takes: [
      { number: 1, takeId: "s1t1", mode: "ON_CAMERA", section: "SMOKE one", text: "This is smoke test take one. Do not record this.", direction: "smoke test", estimatedSeconds: 20 },
      { number: 2, takeId: "s1t2", mode: "ON_CAMERA", section: "SMOKE one", text: "This is smoke test take two. Do not record this.", direction: "smoke test", estimatedSeconds: 20 },
      { number: 3, takeId: "s2t1", mode: "VOICEOVER", section: "SMOKE two", text: "This is smoke test take three, a voiceover read.", direction: "smoke test", estimatedSeconds: 20 },
    ],
    instructions: "SMOKE TEST — automated dashboard check. Nothing here needs recording.",
  };
}

export function videoReviewPayload(requestId) {
  return {
    videoId: `${requestId}-video`,
    title: "[SMOKE TEST] Video review — automated dashboard check",
    description: "SMOKE TEST. Posted by the dashboard smoke suite and cleaned up automatically.",
    tags: ["smoke", "test"],
    chapters: [{ at: "0:00", label: "SMOKE start" }],
    pinnedComment: "SMOKE TEST pinned comment.",
    youtubeUrl: null,
    driveLink: null,
    privacy: "private",
    checklist: ["SMOKE TEST — this card is automated and safe to ignore."],
    missingCta: [],
    disclosureRequired: false,
    stats: { runtimeMinutes: 1, resolution: "1080p" },
  };
}

export function heldBelowBarPayload(requestId) {
  return {
    stage: "held_below_bar",
    requestId,
    topicTitle: "[SMOKE TEST] Held below bar — automated dashboard check",
    scriptTitle: "[SMOKE TEST] a script that was held",
    why: "SMOKE TEST — automated dashboard check.",
    bar: 8,
    scores: { clarity: 8, retention: 7, authenticity: 6 },
    failingAxes: ["retention", "authenticity"],
    critic: {
      worstProblem: "SMOKE TEST worst problem.",
      worstBoundary: "SMOKE TEST boundary.",
      fix: "SMOKE TEST fix.",
    },
    criticUnavailable: false,
    attemptsUsed: 3,
    draft: { takeCount: 3, onCameraCount: 2, estimatedMinutes: 1 },
    retrying: true,
  };
}

// ─── the reels manual edit queue's two card shapes ───────────────────────────
//
// NEW KINDS — "reel_edit" and "reel_review" — rather than a reuse of
// topic_pick/video_review, because `decisionState` reads the newest request of
// a kind and the long-form pipeline calls it with no further filter: a queue
// card raised as video_review would become the record long-form believes is its
// own video review, and approving an edited reel would publish a YouTube video.
//
// WHICH MAKES THESE TWO THE MOST IMPORTANT CARDS IN THIS FILE. The dashboard
// routes on `kind`, and these are kinds it has never been sent. Whether it
// renders them is a question with a real answer, and this suite is the only
// thing that can ask it — so these are posted here rather than assumed to work,
// and the reels queue's own email channel carries every Drive link precisely
// because the answer might be no.

export function reelEditPayload(requestId) {
  return {
    requestId,
    driveFileId: "SMOKE-not-a-real-drive-id",
    fileName: "[SMOKE TEST] queued-clip.mp4",
    durationSeconds: 41.2,
    duration: "41s",
    discoveredAt: new Date().toISOString(),
    folder: "Videos To Edit",
    question: "Start the retention edit on this video?",
    actions: [{ id: "approve", label: "Start Edit" }],
    whatHappens: "SMOKE TEST — automated dashboard check. Nothing will be edited.",
    isTest: true,
  };
}

export function reelReviewPayload(requestId) {
  return {
    requestId,
    driveFileId: "SMOKE-not-a-real-drive-id",
    fileName: "[SMOKE TEST] reviewed-clip.mp4",
    revision: 1,
    question: "Approve these for the Trial tab, or send them back with a note?",
    actions: [
      { id: "approve", label: "Approve" },
      { id: "reject", label: "Reject with note" },
    ],
    driveLink: "https://drive.google.com/file/d/SMOKE/view",
    master: { fileName: "[SMOKE TEST] master.mp4", link: "https://drive.google.com/file/d/SMOKE/view", driveFileId: "SMOKE" },
    variants: ["A", "B", "C"].map((label) => ({
      label,
      hookLine: `SMOKE TEST hook line ${label}`,
      treatment: "SMOKE TEST — automated dashboard check",
      link: `https://drive.google.com/file/d/SMOKE-${label}/view`,
      fileName: `[SMOKE TEST] variant-${label}.mp4`,
      driveFileId: `SMOKE-${label}`,
    })),
    editSummary: "SMOKE TEST — 40.0s in, 33.0s out, 7.0s of dead air removed",
    warnings: [],
    isTest: true,
  };
}

/**
 * Best-effort removal of everything this run created.
 *
 * Best-effort on purpose, and loud about it. There is no documented delete
 * endpoint on the dashboard, so this tries the plausible ones and REPORTS what
 * it could not remove rather than reporting success it has not earned — the
 * same standard the Metricool media-delete probe is held to. A TEST- card left
 * on the dashboard is visible clutter, not a hazard: the prefix keeps it out of
 * every scheduled job either way.
 */
export async function cleanup() {
  const { url, secret } = requireEnv();
  const results = [];
  for (const requestId of created) {
    let removed = false;
    let lastStatus = null;
    for (const attempt of [
      { path: `${APPROVAL_PATH}/${encodeURIComponent(requestId)}`, method: "DELETE" },
      { path: `${APPROVAL_PATH}`, method: "DELETE", body: { requestId } },
    ]) {
      try {
        const res = await fetch(`${url}${attempt.path}`, {
          method: attempt.method,
          headers: { "Content-Type": "application/json", "X-Webhook-Secret": secret },
          body: attempt.body ? JSON.stringify(attempt.body) : undefined,
        });
        lastStatus = res.status;
        if (res.ok) {
          removed = true;
          break;
        }
      } catch (err) {
        lastStatus = err.message;
      }
    }
    results.push({ requestId, removed, lastStatus });
  }
  created.clear();
  return results;
}

export { DELIVERY_PATH, APPROVAL_PATH };
